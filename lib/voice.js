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
// MAX_EXCHANGES counts the CALLER's turns — one exchange is "they speak, we
// reply". Counting every utterance (which is what the old MAX_TURNS did) halved
// the real limit, and recording the opener as a turn halved the remainder again:
// a call was being cut off after about six exchanges, mid-conversation.
// Measured cost is ~$0.03/call, so these can be generous.
const MAX_EXCHANGES = 25;
const MAX_CALL_SECONDS = 600;       // 10 min — a stuck call still can't run forever
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
  // speechTimeout="auto" returns at the caller's first pause — lowest latency.
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
/**
 * Ending a call the moment the last syllable lands feels like being hung up on.
 * Real people leave a beat, say goodbye, and then the line goes quiet.
 */
function sayAndSignOff(text, voiceName, farewell = 'Thanks again. Bye now.') {
  return twiml(
    say(text, voiceName)
    + '<Pause length="1"/>'
    + say(farewell, voiceName)
    + '<Pause length="1"/>'
    + '<Hangup/>'
  );
}
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
function systemPrompt(profile, account, { direction, lead, leadBrief }) {
  const call_leadBrief = leadBrief
    ? `=== YOU HAVE DEALT WITH THIS PERSON BEFORE ===\n${leadBrief}\nUse it naturally — referencing what was already said is what makes this feel like a real company, not a switchboard. Never read the history back at them like a file.`
    : '';
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
    `5. NEVER turn a caller away over who they are. Their trade, industry, company size or "fit" is NEVER a reason to refuse, dismiss, or end a call. Never say "we don't work with", "we don't market to", "we don't serve", or "you're not really our customer" — a person on the phone wanting to buy is the most valuable thing that happens all day, and that judgement is not yours to make. If you genuinely can't tell whether the business can help them, take their name, number and what they need, and have someone follow up.`,
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
    `Who they typically serve: ${profile.icp || 'not specified'}`,
    direction === 'outbound' ? '' : `  ^ Background on their usual customers — NOT a screening test for this call. Whoever is on the phone counts as a potential customer, whatever industry they're in.`,
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
    `=== MAKE IT THEIRS — DO NOT PITCH GENERICALLY ===`,
    `Find out what the caller actually does before you pitch — one short question, early: "What kind of work do you do?" Then build the rest of the call around that answer.`,
    `Whatever they say — salon, dental office, towing, gym, law practice, landscaping, tattoo studio, anything — work out ON THE SPOT what this would concretely do for THAT business, and say it in their words. Name the real moment it earns its money for them:`,
    `  · stylist: "you're mid-color with someone in the chair — that's exactly when the phone goes, and that booking goes to whoever picks up instead"`,
    `  · plumber: "you're under a sink with the water off, you can't answer, and that emergency call is worth a few hundred bucks to whoever does"`,
    `  · clinic: "front desk goes to lunch and the phone doesn't — those are all rebookings"`,
    `Then give them the actual shape of it for their business: who it answers as, what it books, where it puts it. A plan they could picture using tomorrow, not a feature list.`,
    `NEVER say or imply a business type isn't a fit, isn't the usual customer, or isn't who this is for. If their trade is one you've not been briefed on, reason it out from what they told you — every business that answers a phone or books an appointment can use this.`,
    '',
    `=== PACE — THIS MATTERS ===`,
    `Move with purpose — get to the point, and to the ask, without dawdling.`,
    `- Turn 1: say who you are and WHY you are calling, in one breath. Never open with "how can I help you today" on an outbound call — you called them, so you say the reason.`,
    `- CRITICAL: read the conversation history before you speak. Never ask something you already asked. If you already asked whether it's a good time, do NOT ask again — they answered by still being on the phone. Move forward.`,
    `- Turns 2-3: one or two qualifying questions, combined where natural. Listen for whether there is a real fit.`,
    `- Turn 4 onward: if there is a fit, ASK FOR THE MEETING. Directly. "Are you around Tuesday or Thursday afternoon?" beats "would you be interested in possibly learning more".`,
    `- Offer a concrete next step every time you can. Never end a turn without either a question or an ask.`,
    direction === 'outbound'
      ? `- If they are clearly not interested, thank them and set action "end". Do not keep selling. A fast no is worth more than a slow maybe.`
      : `- They rang YOU, so the fit question is already settled. NEVER end a call because their trade, industry or size looks like a mismatch — that is a paying customer you just threw away. Help them, then book the callback. Only set action "end" if THEY say they aren't interested, it's a wrong number, or it's spam.`,
    `- If they ask "can I just sign up online" or "where do I sign up" — YES. Immediately. Give them the website and walk them through it on the phone. Someone signing up right now is the BEST outcome there is. NEVER answer that question with "a call is better" — that is you blocking a sale.`,
    `- CLOSE ON THIS CALL where you can. Booking a meeting is the fallback, not the goal. Ranked best to worst: (1) they sign up while you're on the phone, (2) they sign up right after and you confirm the site, (3) they book a call, (4) you get their email to send the link.`,
    `- If they're interested but hesitating, don't retreat to "let's book a call" — ask what's holding them back and answer it.`,
    '',
    (call_leadBrief || ''),
    direction === 'outbound'
      ? `=== WHO YOU ARE CALLING ===\n${lead && lead.name ? lead.name : 'A prospect'}${lead && lead.company ? ` at ${lead.company}` : ''}. Respect their time — check it's an okay moment, then get to the point.`
      : `=== THIS CALL ===\nSomeone is calling ${biz}. Find out what they need, answer from the facts above, and book the callback. Capture their name, company, phone and reason before the call ends.`,
    '',
    `=== RESPONSE FORMAT ===`,
    `Reply with STRICT JSON only, no markdown:`,
    `{"say":"what you say out loud","action":"continue|book|transfer|dnc|end","name":"","company":"","phone":"","email":"","reason":"","when":"","whenISO":""}`,
    `- action "continue": keep talking (the default).`,
    `- action "book": they agreed to a callback/meeting. Fill name, phone, reason, "when" (their words, e.g. "Tuesday afternoon"), and "whenISO".`,
    `  "whenISO" MUST be a real calendar date-time you resolve from what they said, in the format YYYY-MM-DDTHH:MM (24-hour, their local time). Today is ${new Date().toISOString().slice(0, 10)}. "Tomorrow at 2" becomes tomorrow's date at 14:00. "Next Tuesday morning" becomes that Tuesday at 09:00. If they were vague ("sometime next week"), PIN IT DOWN before booking — offer two specific slots and let them pick. Never book without a time you could put in a diary.`,
    `- action "transfer": connect them to a human now.`,
    `- action "dnc": they asked not to be contacted. Confirm politely in "say".`,
    `- action "end": the conversation is finished (not interested, or done).`,
  ].filter(Boolean).join('\n');
}

/**
 * The model's whenISO is a claim, not a fact. Accept it only if it parses and
 * is actually in the future — a booking stamped in the past is worse than one
 * with no time at all, because it silently drops off the calendar.
 */
function normaliseWhen(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + ':00');
  if (isNaN(d.getTime())) return '';
  if (d.getTime() < Date.now() - 3600000) return '';   // already gone
  if (d.getTime() > Date.now() + 400 * 86400000) return ''; // absurdly far out
  return d.toISOString();
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
  // The instructions are identical every turn, so they go in a CACHED system
  // block; only the moving parts go in the message. Cuts both latency and cost.
  const system = systemPrompt(profile, account, { direction: call.direction, lead: call.lead, leadBrief: call.leadBrief });
  const prompt = [
    history ? `=== WHAT'S BEEN SAID SO FAR (do NOT repeat yourself) ===\n${history}` : '',
    '',
    `They just said: "${heard}"`,
    `Your reply (JSON only):`,
  ].filter(Boolean).join('\n');

  // 150 tokens is plenty for two spoken sentences, and fewer tokens means the
  // caller waits less. Every token is latency they can hear.
  const raw = await callAI(prompt, { maxTokens: 150, tier: 'draft', timeoutMs: 10000, system });
  const j = safeJSON(raw) || {};
  const text = String(j.say || '').trim();
  return {
    say: text || "Sorry, I didn't quite catch that. Could you say it again?",
    action: ['continue', 'book', 'transfer', 'dnc', 'end'].includes(j.action) ? j.action : 'continue',
    data: {
      name: j.name || '', company: j.company || '', phone: j.phone || '',
      email: j.email || '', reason: j.reason || '',
      when: j.when || '', whenISO: normaliseWhen(j.whenISO),
    },
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
  configured, verifySignature, twiml, say, sayAndGather, sayAndHangup, sayAndSignOff, sayAndDial, esc,
  startCall, getCall, endCall, think, placeCall, toE164, estimateCost, MAX_EXCHANGES, MAX_CALL_SECONDS,
  VOICES, voiceFor, DEFAULT_VOICE,
};
