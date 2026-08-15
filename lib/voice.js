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

// COST CONTROL. Twilio bills speech recognition by the 15 seconds each <Gather>
// stays open, so the expensive thing is not call length — it is the NUMBER of
// gathers and how long each one waits. Fewer, longer turns is the whole game.
const MAX_TURNS = 14;               // was 24; each turn is a billed recognition
const MAX_CALL_SECONDS = 300;       // hard ceiling — a stuck call can't run up a bill
// CORRECTION: speechTimeout="auto" ends recognition at the FIRST pause and
// returns immediately. A numeric value waits out the whole timeout, adding that
// many seconds of dead air to EVERY turn — slower for the caller and longer
// (dearer) recognition. auto is both faster and cheaper.
const SPEECH_TIMEOUT = 'auto';
// experimental_conversations is Twilio's generic model for spontaneous,
// unscripted speech (and generic = Twilio can fail over between STT providers).
const SPEECH_MODEL = process.env.VOICE_STT || 'experimental_conversations';

// Verified TwiML voice strings. An invalid one does NOT hard-fail — Twilio
// silently degrades to a default voice (warning 13511), so every value here was
// checked against Twilio's own docs. Notably "Google.en-US-Journey-*" does NOT
// exist on Twilio despite being widely suggested; it is deliberately absent.
const VOICES = [
  { value: 'Polly.Ruth-Generative',       label: 'Ruth — warm, casual (best for sales)', tier: 'generative' },
  { value: 'Polly.Joanna-Generative',     label: 'Joanna — polished, professional',      tier: 'generative' },
  { value: 'Polly.Matthew-Generative',    label: 'Matthew — natural male',               tier: 'generative' },
  { value: 'Polly.Stephen-Generative',    label: 'Stephen — business-casual male',       tier: 'generative' },
  { value: 'Google.en-US-Chirp3-HD-Leda', label: 'Leda — breathy, very human (Google)',  tier: 'generative' },
  { value: 'Google.en-US-Chirp3-HD-Puck', label: 'Puck — light, animated male (Google)', tier: 'generative' },
  { value: 'Polly.Joanna-Neural',         label: 'Joanna Neural — 4x cheaper, stable',   tier: 'neural' },
  { value: 'Polly.Matthew-Neural',        label: 'Matthew Neural — 4x cheaper, stable',  tier: 'neural' },
];
const DEFAULT_VOICE = process.env.VOICE_TTS || 'Polly.Ruth-Generative';
function voiceFor(account) {
  const v = account && account.voice && account.voice.ttsVoice;
  return VOICES.some((x) => x.value === v) ? v : DEFAULT_VOICE;
}
// Generative voices bill ~4x Neural per character, so the cost of a call scales
// with how MUCH it says. Short turns are cheaper and sound more human anyway.
const RATE_TTS_100CHARS = { generative: 0.013, neural: 0.0032 };

// Rough per-call cost so the operator sees real economics instead of guessing.
// Twilio US list prices; override via env if your rates differ.
const RATE_VOICE_MIN = Number(process.env.VOICE_RATE_MIN || 0.014);      // per minute
const RATE_RECOGNITION = Number(process.env.VOICE_RATE_GATHER || 0.02);  // per gather (~15s block)
const RATE_AI_TURN = Number(process.env.VOICE_RATE_AI || 0.003);         // Haiku per turn
function estimateCost({ durationSec = 0, turns = 0, chars = 0, tier = 'generative' }) {
  const mins = Math.max(1, Math.ceil(durationSec / 60));
  const gathers = Math.max(1, turns);
  const tts = Math.ceil((chars || turns * 180) / 100) * (RATE_TTS_100CHARS[tier] || RATE_TTS_100CHARS.generative);
  return Number((mins * RATE_VOICE_MIN + gathers * RATE_RECOGNITION + gathers * RATE_AI_TURN + tts).toFixed(3));
}

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
function say(text, voiceName) { return `<Say voice="${voiceName || DEFAULT_VOICE}">${esc(text)}</Say>`; }

/** Speak, then listen. The core conversational turn. */
function sayAndGather(text, action, voiceName) {
  // speechTimeout is bounded (not "auto") so the recogniser closes promptly once
  // the caller stops talking — this is the single biggest cost lever.
  // speechModel="phone_call" is tuned for telephony audio, so fewer misheard
  // turns, which also means fewer expensive retries.
  // bargeIn="true" lets the caller talk over the AI and cut it off — the single
  // biggest thing that stops a phone agent feeling like a recorded menu.
  return twiml(
    `<Gather input="speech dtmf" action="${esc(action)}" method="POST"`
    + ` speechTimeout="${SPEECH_TIMEOUT}" speechModel="${SPEECH_MODEL}"`
    + ` bargeIn="true" maxSpeechTime="30"`
    + ` language="en-US" actionOnEmptyResult="true" profanityFilter="false">`
    + say(text, voiceName)
    + `</Gather>`
  );
}
function sayAndHangup(text, voiceName) { return twiml(say(text, voiceName) + '<Hangup/>'); }
function sayAndDial(text, number, action, voiceName) {
  return twiml(say(text, voiceName) + `<Dial timeout="25"${action ? ` action="${esc(action)}"` : ''}>${esc(number)}</Dial>`);
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
    `2. Use ONLY the business facts below. If you don't know something, say so plainly and offer to have someone follow up. NEVER invent or estimate prices, discounts, timelines, guarantees, capabilities, or availability.`,
    `2a. MONEY: the ONLY numbers you may ever say out loud are the ones under APPROVED PRICING. If a figure is not written there, you do not have it — say "I don't have pricing in front of me, but I can have someone send it over" and move on. Never say "around", "roughly", "starting at", or "I think it's" about a price.`,
    `2b. If someone asks where to sign up or for the website, give the website below if there is one. If there isn't one listed, offer to text or email them the link instead of guessing a URL.`,
    `3. If the caller asks to be removed, says stop calling, or asks for the do-not-call list, acknowledge warmly and set action to "dnc".`,
    canTransfer ? `4. If they ask for a human, get frustrated, or are ready to buy, set action to "transfer".` : `4. There is no human available to transfer to right now — offer to take a message and have someone call back.`,
    '',
    `=== HOW TO TALK — YOU ARE A PERSON ON THE PHONE, NOT A PORTAL ===`,
    `CONTRACTIONS, ALWAYS. "I'm", "you're", "that's", "can't", "I'll". Never "I am"/"cannot" unless stressing a word.`,
    `Fragments are good. "Sure thing." "Tomorrow works." "Got it, one sec." Not every turn needs a subject and a verb.`,
    `Short. One or two sentences. Sometimes three words. Then stop talking.`,
    '',
    `BANNED — these are the tell. If your sentence contains one, rewrite it:`,
    `  "How may I assist you today" · "I'd be happy to help" · "Thank you for reaching out" · "I apologize for any inconvenience" · "Is there anything else I can assist you with" · "Certainly!" · "Absolutely!" · "Great question!" · "Please be advised" · "Kindly" · "At this time" · "Rest assured" · "I understand your concern" · "Let me go ahead and" · "Feel free to"`,
    `Say instead: "What can I do for you?" · "Yeah, I can do that." · "Thanks for calling." · "Sorry about that." · "Anything else?"`,
    '',
    `ACKNOWLEDGE LIKE A HUMAN: "Got it." "Yeah." "Sure." "Right." "Gotcha." "Makes sense." — but ONE per turn max, and only about every second or third turn. Acknowledging everything is the fastest way to sound like a bot. Never acknowledge a question ("Great question!") — just answer it. Match the weight: never "Got it!" after bad news.`,
    '',
    `VARY YOUR RHYTHM. Check the last two things you said and break the pattern: vary length, vary the opener (don't start three turns with "Sure,"), vary the ending (not every turn is a question). Don't repeat their name every turn — once early, maybe once at the close. Words like "though", "actually", "honestly", "either way" make speech sound thought-through instead of retrieved.`,
    '',
    `IF THEY INTERRUPT: stop. Don't finish the sentence, don't restart it from the top, never say "as I was saying". Take the new information and move: "Oh — okay, so it's the pricing you're after. Got it."`,
    `If they trail off, give a short prompt: "...yeah?" or "Pricing, or scheduling?" If you didn't catch it: "Sorry, you cut out — say that again?" Ask once, then work with what you got.`,
    '',
    `SAYING THINGS OUT LOUD: never "H-T-T-P-S colon slash slash" or "W-W-W dot". Say a domain like a person: "dawnpipe dot com". Prices as words: "ninety nine dollars", not "$99". Phone numbers in groups with pauses. Email: "alijah at dawnpipe dot com", never "at symbol". If something is long or fiddly, offer to text it instead of spelling it out.`,
    '',
    `BEING AN AI: you never claim to be human and never let someone keep believing you are once they've asked — that is absolute. But mention it the way a person mentions something about themselves, not like a legal disclaimer. "Yep, I'm an AI — Alijah's assistant." Then carry on with the conversation.`,
    '',
    `=== THE BUSINESS ===`,
    `Name: ${biz}`,
    `What they do: ${profile.offer || 'not specified'}`,
    `Who they serve: ${profile.icp || 'not specified'}`,
    `Why customers pick them: ${profile.valueProp || 'not specified'}`,
    `Proof / track record: ${profile.proof || 'not specified'}`,
    profile.website ? `Website (say it naturally, e.g. "dawnpipe dot com"): ${profile.website}` : '',
    profile.pricing
      ? `APPROVED PRICING — you may state these figures exactly as written, and NOTHING else: ${profile.pricing}`
      : `PRICING: you have NOT been given pricing. If asked what it costs, say you don't have pricing in front of you and offer to have someone send it over. Do NOT guess, estimate, or repeat a number from anywhere else.`,
    profile.notes ? `Other notes: ${profile.notes}` : '',
    (account.voice && account.voice.faq) ? `Common questions and approved answers:\n${account.voice.faq}` : '',
    (account.voice && account.voice.hours) ? `Business hours: ${account.voice.hours}` : '',
    '',
    (account.voice && account.voice.objections)
      ? `KNOWN OBJECTIONS AND YOUR APPROVED ANSWERS (use these, don't improvise):\n${account.voice.objections}` : '',
    '',
    `=== THE GOAL OF THIS CALL ===`,
    (account.voice && account.voice.objective)
      ? account.voice.objective
      : (direction === 'outbound'
          ? 'Find out if there is a fit, then book a short call with the team.'
          : 'Understand what they need, then book a callback with the team.'),
    (account.voice && account.voice.qualifying)
      ? `Qualify with these (weave them in naturally, do NOT read them as a list):\n${account.voice.qualifying}` : '',
    '',
    `=== PACE — THIS MATTERS ===`,
    `You have about ${Math.max(4, Math.round((MAX_TURNS - 2) / 2))} exchanges before this call has cost more than it is worth. Move with purpose.`,
    `- Turn 1: say who you are and WHY you are calling, in one breath. Never open with "how can I help you today" on an outbound call — you called them, so you say the reason.`,
    `- Turns 2-3: one or two qualifying questions, combined where natural. Listen for whether there is a real fit.`,
    `- Turn 4 onward: if there is a fit, ASK FOR THE MEETING. Directly. "Are you around Tuesday or Thursday afternoon?" beats "would you be interested in possibly learning more".`,
    `- Offer a concrete next step every time you can. Never end a turn without either a question or an ask.`,
    `- If they are clearly not a fit or not interested, thank them and set action "end". Do not keep selling. A fast no is worth more than a slow maybe.`,
    `- If they sound interested but want to look first, give the website and STILL ask for the meeting.`,
    '',
    direction === 'outbound'
      ? `=== WHO YOU ARE CALLING ===\n${lead && lead.name ? lead.name : 'A prospect'}${lead && lead.company ? ` at ${lead.company}` : ''}. Respect their time — check it's an okay moment, then get to the point.`
      : `=== THIS CALL ===\nSomeone is calling ${biz}. Find out what they need, answer from the facts above, and book the callback. Capture their name, company, phone and reason before the call ends.`,
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
  startCall, getCall, endCall, think, placeCall, toE164, estimateCost, MAX_TURNS, MAX_CALL_SECONDS,
  VOICES, voiceFor, DEFAULT_VOICE,
};
