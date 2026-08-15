// Voice — the AI receptionist / SDR that answers and places phone calls.
//
// Architecture note: this uses Twilio's <Gather input="speech"> over ordinary
// HTTP webhooks rather than realtime media streaming. Twilio does the speech-to-
// text, we think with Claude, and reply with <Say>. That keeps the zero-dependency
// stack intact (no WebSocket server, no SDK) and costs a fraction of realtime
// voice models. Trade-off: ~1.5-2.5s between turns instead of instant. Upgrading
// to Media Streams later changes this file only.
//
// HONESTY RULE: the agent always identifies itself as an AI. It never claims to
// be a person, never invents pricing or promises, and hands off to a human when
// it doesn't know. That is a product requirement, not a nicety.
require('./env');
const crypto = require('crypto');
const db = require('./db');
const { callAI } = require('./ai');

const MAX_TURNS = 24;          // hard stop so a stuck call can't bill forever
const SAY_VOICE = 'Polly.Joanna-Neural';

// ---------------- Twilio webhook signature ----------------
// Anyone can POST to a public URL. Twilio signs each request; we verify it so
// nobody can spoof calls, drain AI spend, or inject transcripts.
function verifySignature(url, params, signature) {
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  if (!token) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function configured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN); }

// ---------------- TwiML ----------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function twiml(inner) { return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`; }
function say(text) { return `<Say voice="${SAY_VOICE}">${esc(text)}</Say>`; }

/** Speak, then listen. The core conversational turn. */
function sayAndGather(text, action) {
  return twiml(
    `<Gather input="speech" action="${esc(action)}" method="POST" speechTimeout="auto" language="en-US" actionOnEmptyResult="true">`
    + say(text)
    + `</Gather>`
  );
}
function sayAndHangup(text) { return twiml(say(text) + '<Hangup/>'); }
function sayAndDial(text, number, action) {
  return twiml(say(text) + `<Dial timeout="25"${action ? ` action="${esc(action)}"` : ''}>${esc(number)}</Dial>`);
}

// ---------------- call state ----------------
// Live conversations live in memory (a call is short); the transcript and
// outcome are persisted as the call progresses so nothing is lost on hangup.
const calls = new Map();
function getCall(sid) { return calls.get(sid) || null; }
function startCall(sid, meta) {
  const c = { sid, ...meta, turns: [], startedAt: Date.now(), outcome: null };
  calls.set(sid, c);
  // drop stale entries (a call can't outlive an hour)
  if (calls.size > 500) for (const [k, v] of calls) if (Date.now() - v.startedAt > 3600000) calls.delete(k);
  return c;
}
function endCall(sid) { const c = calls.get(sid); calls.delete(sid); return c; }

// ---------------- the agent ----------------
function systemPrompt(profile, account, { direction, lead }) {
  const agentName = (account.voice && account.voice.agentName) || 'Sarah';
  const biz = profile.name || 'this business';
  const canTransfer = !!(account.voice && account.voice.transferTo);
  return [
    `You are ${agentName}, an AI voice assistant answering the phone for ${biz}. This is a live phone call — your words are spoken aloud.`,
    '',
    `=== ABSOLUTE RULES ===`,
    `1. You are an AI. If asked whether you are a real person, a robot, or an AI, say plainly that you are an AI assistant. NEVER claim to be human.`,
    `2. Use ONLY the business facts below. If you don't know something — price, availability, a policy, a technical detail — say you don't know and offer to have a human follow up. NEVER invent prices, promises, guarantees, or capabilities.`,
    `3. If the caller asks to be removed, says stop calling, or asks for the do-not-call list, acknowledge warmly and set action to "dnc".`,
    canTransfer ? `4. If they ask for a human, get frustrated, or are ready to buy, set action to "transfer".` : `4. There is no human available to transfer to right now — offer to take a message and have someone call back.`,
    '',
    `=== HOW TO SPEAK ===`,
    `- One or two SHORT sentences per turn. This is a conversation, not a monologue.`,
    `- Plain spoken English. No bullet points, no markdown, no emoji, no URLs.`,
    `- Ask one question at a time, then stop and listen.`,
    `- Warm and direct. Never pushy. If they aren't interested, thank them and end politely.`,
    '',
    `=== THE BUSINESS ===`,
    `Name: ${biz}`,
    `What they do: ${profile.offer || 'not specified'}`,
    `Who they serve: ${profile.icp || 'not specified'}`,
    `Why customers pick them: ${profile.valueProp || 'not specified'}`,
    `Proof / track record: ${profile.proof || 'not specified'}`,
    profile.notes ? `Other notes: ${profile.notes}` : '',
    (account.voice && account.voice.faq) ? `Common questions and approved answers:\n${account.voice.faq}` : '',
    (account.voice && account.voice.hours) ? `Business hours: ${account.voice.hours}` : '',
    '',
    direction === 'outbound'
      ? `=== THIS CALL ===\nYou are calling ${lead && lead.name ? lead.name : 'a prospect'}${lead && lead.company ? ` at ${lead.company}` : ''}. Goal: see if there's a fit and book a short call with the team. Be respectful of their time — ask if it's a good moment first.`
      : `=== THIS CALL ===\nSomeone is calling ${biz}. Find out what they need, answer what you can from the facts above, and book a callback with the team. Capture their name, company, phone and reason for calling.`,
    '',
    `=== RESPONSE FORMAT ===`,
    `Reply with STRICT JSON only, no markdown:`,
    `{"say":"what you say out loud","action":"continue|book|transfer|dnc|end","name":"","company":"","phone":"","reason":"","when":""}`,
    `- action "continue": keep talking (the default).`,
    `- action "book": they agreed to a callback/meeting. Fill name, phone, reason, and "when" (their preferred time, in their words).`,
    `- action "transfer": connect them to a human now.`,
    `- action "dnc": they asked not to be contacted. Confirm politely in "say".`,
    `- action "end": the conversation is finished (not interested, or done).`,
  ].filter(Boolean).join('\n');
}

function safeJSON(s) {
  const c = String(s || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(c); } catch {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/** One conversational turn: caller said X, what do we say back? */
async function think(call, heard) {
  const profile = call.profile || {};
  const account = call.account || {};
  const history = call.turns.map((t) => `${t.who === 'caller' ? 'Caller' : 'You'}: ${t.text}`).join('\n');
  const prompt = [
    systemPrompt(profile, account, { direction: call.direction, lead: call.lead }),
    '',
    history ? `=== CONVERSATION SO FAR ===\n${history}` : '',
    '',
    `Caller just said: "${heard}"`,
    `Your reply (JSON only):`,
  ].filter(Boolean).join('\n');

  // Haiku with a tight cap: spoken turns are short, and every extra token is
  // both latency the caller hears and money.
  const raw = await callAI(prompt, { maxTokens: 220, tier: 'draft', timeoutMs: 12000 });
  const j = safeJSON(raw) || {};
  const text = String(j.say || '').trim();
  return {
    say: text || "Sorry, I didn't quite catch that. Could you say it again?",
    action: ['continue', 'book', 'transfer', 'dnc', 'end'].includes(j.action) ? j.action : 'continue',
    data: { name: j.name || '', company: j.company || '', phone: j.phone || '', reason: j.reason || '', when: j.when || '' },
  };
}

// ---------------- outbound dialling (Twilio REST, no SDK) ----------------
// Twilio's API only accepts E.164 (+15551234567). People paste numbers however
// their console displayed them — "(213) 682-2616" — so normalise rather than
// fail with an unhelpful API error.
function toE164(raw, defaultCountry = '1') {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+${defaultCountry}${digits}`;      // US local
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

async function placeCall({ to, from, answerUrl, statusUrl }) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio is not configured.');
  to = toE164(to); from = toE164(from);
  if (!to || !from) throw new Error('Both numbers must be valid (e.g. +13125550123).');
  const body = new URLSearchParams({
    To: to, From: from, Url: answerUrl, Method: 'POST',
    MachineDetection: 'Enable',          // don't hold a conversation with voicemail
    AsyncAmd: 'false', Timeout: '25',
    ...(statusUrl ? { StatusCallback: statusUrl, StatusCallbackMethod: 'POST' } : {}),
  });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `Twilio ${r.status}`);
  return data;
}

module.exports = {
  configured, verifySignature, twiml, say, sayAndGather, sayAndHangup, sayAndDial, esc,
  startCall, getCall, endCall, think, placeCall, toE164, MAX_TURNS,
};
