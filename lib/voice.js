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

// COST CONTROL. Twilio bills speech recognition PER <Gather> USE — a flat fee
// per gather, whatever it costs, regardless of how long that gather stays open
// (up to its 60-second ceiling). An earlier version of this comment said it was
// billed per 15 seconds, which is wrong and drove real tuning decisions in the
// wrong direction: a LONGER gather is strictly free, so waiting for the caller
// to finish costs nothing and only the NUMBER of gathers matters. Fewer, longer
// turns is the whole game.
// MAX_EXCHANGES counts the CALLER's turns — one exchange is "they speak, we
// reply". Counting every utterance (which is what the old MAX_TURNS did) halved
// the real limit, and recording the opener as a turn halved the remainder again:
// a call was being cut off after about six exchanges, mid-conversation.
// Measured cost is ~$0.03/call, so these can be generous.
const MAX_EXCHANGES = 25;
const MAX_CALL_SECONDS = 600;       // 10 min — a stuck call still can't run forever

// The demo line bills nobody, so its cost is pure customer acquisition. A
// maxed-out 10-minute demo costs about $1.30 and nobody needs ten minutes to
// decide: the pitch lands in the first two or three exchanges and everything
// after is us paying to keep talking. A paying customer's call is left alone —
// there the same spend is ~87% margin against their plan and cutting it short
// would be cutting off their customer.
// 12 was too tight: a few clipped turns and a repeated question ate the budget
// and it hung up on a caller saying "I want the tester". 18 gives room for the
// line to be imperfect; the buying-intent yield in server.js is the real guard.
const DEMO_MAX_EXCHANGES = 18;
const DEMO_MAX_SECONDS = 300;       // 5 min
function limitsFor(account) {
  return demoModeFor(account)
    ? { exchanges: DEMO_MAX_EXCHANGES, seconds: DEMO_MAX_SECONDS }
    : { exchanges: MAX_EXCHANGES, seconds: MAX_CALL_SECONDS };
}
// speechTimeout is how long of a PAUSE ends the caller's turn. "auto" ends it
// at the very first pause — which is fast and cheap and exactly why the agent
// cut people off mid-sentence: take a breath to think of a word and it decided
// you were done, replied, and moved on without the rest. That is the single
// most maddening thing an AI phone agent can do.
//
// Two seconds still clipped people who pause to think ("it's the... uh... the
// water heater"). Three is the gap a patient person leaves before assuming you
// have finished, and it is FREE in both senses: recognition bills a flat fee
// per <Gather> regardless of length, and a longer wait means FEWER gathers per
// call, so waiting costs less than interrupting. The only price is ~1s more
// latency before the agent replies, which reads as "listening", not "slow".
const SPEECH_TIMEOUT = process.env.VOICE_SPEECH_TIMEOUT || '3';
// How long a single caller turn may run before Twilio cuts it off. Free to
// raise (flat fee per gather, 60s ceiling), expensive to lower: every second
// under a caller's natural sentence is a sentence we never hear.
const MAX_SPEECH_TIME = Number(process.env.VOICE_MAX_SPEECH || 45);
// Which speech model Twilio uses. This is a PRICING decision as much as an
// accuracy one, and the default here is now Twilio's own provider selection
// (the attribute is omitted entirely).
// experimental_conversations is a legacy Google-v1 model on two counts that
// both hurt: Twilio bills legacy models $0.035-$0.040 per use against $0.020
// for the default, and being a long-form conversational model it scores badly
// on exactly the utterances this line lives on — "yes", "no", "tomorrow",
// a phone number. Twilio's default routes to a current provider and can fail
// over between them, which is the property experimental_conversations was
// originally picked for. Cheaper AND better on short answers.
// Set VOICE_STT=experimental_conversations to go back.
const SPEECH_MODEL = process.env.VOICE_STT || '';
const USE_SPEECH_MODEL = !/^(default|none|off|)$/i.test(String(process.env.VOICE_STT ?? '').trim());

// Verified TwiML voice strings. An invalid one does NOT hard-fail — Twilio
// silently degrades to a default voice (warning 13511), so every value here was
// checked against Twilio's own docs. Notably "Google.en-US-Journey-*" does NOT
// exist on Twilio despite being widely suggested; it is deliberately absent.
// Labels are what the CUSTOMER reads when picking the voice of their own
// business. They describe a person's voice -- name and how it sounds -- and
// nothing else. What a voice costs US is our problem, never a word on their
// screen: "4x cheaper" told a paying customer they were choosing the budget
// option for their own front desk, which is both off-putting and none of
// their business. `tier` stays for internal cost accounting only.
const VOICES = [
  { value: 'Polly.Ruth-Generative',       label: 'Ruth — warm and casual',            tier: 'generative' },
  { value: 'Polly.Joanna-Generative',     label: 'Joanna — polished and professional', tier: 'generative' },
  { value: 'Polly.Matthew-Generative',    label: 'Matthew — natural, easy-going',     tier: 'generative' },
  { value: 'Polly.Stephen-Generative',    label: 'Stephen — business-casual',         tier: 'generative' },
  { value: 'Google.en-US-Chirp3-HD-Leda', label: 'Leda — soft-spoken and very human', tier: 'generative' },
  { value: 'Google.en-US-Chirp3-HD-Puck', label: 'Puck — light and animated',         tier: 'generative' },
  { value: 'Polly.Joanna-Neural',         label: 'Joanna (classic) — clear and steady', tier: 'neural' },
  { value: 'Polly.Lupe-Neural',           label: 'Lupe — Spanish, warm',              tier: 'neural', lang: 'es-US' },
  { value: 'Polly.Pedro-Neural',          label: 'Pedro — Spanish, friendly',         tier: 'neural', lang: 'es-US' },
  { value: 'Polly.Matthew-Neural',        label: 'Matthew (classic) — calm and even', tier: 'neural' },
];
const DEFAULT_VOICE = process.env.VOICE_TTS || 'Polly.Ruth-Generative';
/** Language the agent listens and speaks in. Per account; 'en-US' or 'es-US'. */
const LANGS = { 'en-US': { name: 'English', voice: DEFAULT_VOICE }, 'es-US': { name: 'Spanish', voice: 'Polly.Lupe-Neural' } };
function langFor(account) {
  const l = account && account.voice && account.voice.language;
  return LANGS[l] ? l : 'en-US';
}
function voiceFor(account) {
  const v = account && account.voice && account.voice.ttsVoice;
  const lang = langFor(account);
  const chosen = VOICES.find((x) => x.value === v);
  // A Spanish-language line must speak with a Spanish voice, or Polly reads
  // Spanish text with an English accent and mangles it. Fall back to the
  // language's default voice whenever the picked voice does not match.
  if (chosen && (chosen.lang || 'en-US') === lang) return v;
  return LANGS[lang].voice;
}
// Generative voices bill ~4x Neural per character, so the cost of a call scales
// with how MUCH it says. Short turns are cheaper and sound more human anyway.
const RATE_TTS_100CHARS = { generative: 0.013, neural: 0.0032 };

// Rough per-call cost so the operator sees real economics instead of guessing.
// Twilio US list prices; override via env if your rates differ.
//
// Where the money actually goes, per minute of conversation (~4 turns/min):
//   phone line        $0.0085 in / $0.014 out   -- the number Twilio advertises
//   speech-to-text    $0.02 per <Gather>         -- ~$0.08/min, the biggest line
//   text-to-speech    $0.013/100 chars generative (~$0.09/min) vs $0.0032 neural (~$0.02/min)
//   AI                ~$0.006/turn with the cached prompt (~$0.025/min)
//   recording         $0.0025/min
// So the advertised per-minute rate is ~5% of the bill; STT + TTS are ~80%.
// The levers are turns-per-minute (do not fragment the caller's sentences)
// and characters spoken (short replies), which is why both are tuned above.
// Inbound and outbound are DIFFERENT rates and the receptionist — the whole
// product — is inbound. Charging every call at the outbound rate overstated
// the cost of the thing we mostly do by 65%.
const RATE_VOICE_MIN_IN = Number(process.env.VOICE_RATE_MIN_IN || 0.0085);
const RATE_VOICE_MIN_OUT = Number(process.env.VOICE_RATE_MIN || 0.014);
const RATE_RECOGNITION = Number(process.env.VOICE_RATE_GATHER || 0.02);  // per gather USE, flat
const RATE_AI_TURN = Number(process.env.VOICE_RATE_AI || 0.006);         // Haiku, prompt cached, per turn
const RATE_RECORDING_MIN = 0.0025;
function estimateCost({ durationSec = 0, turns = 0, chars = 0, tier = 'generative', recorded = true, direction = 'inbound' }) {
  const mins = Math.max(1, Math.ceil(durationSec / 60));
  const gathers = Math.max(1, turns);
  const line = direction === 'outbound' ? RATE_VOICE_MIN_OUT : RATE_VOICE_MIN_IN;
  const tts = Math.ceil((chars || turns * 180) / 100) * (RATE_TTS_100CHARS[tier] || RATE_TTS_100CHARS.generative);
  return Number((mins * line + gathers * RATE_RECOGNITION + gathers * RATE_AI_TURN + tts + (recorded ? mins * RATE_RECORDING_MIN : 0)).toFixed(3));
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

// Twilio biases recognition toward phrases you tell it to expect. Without any
// hints it is guessing at open vocabulary over 8kHz phone audio, which is why
// it kept missing exactly the words that matter on this kind of call. Max 500
// phrases; these are the ones a service-business caller actually says.
const BASE_HINTS = [
  'appointment', 'booking', 'book', 'reschedule', 'cancel', 'quote', 'estimate',
  'emergency', 'urgent', 'leaking', 'leak', 'broken', 'not working', 'repair',
  'replace', 'service', 'install', 'water heater', 'furnace', 'air conditioning',
  'AC', 'boiler', 'drain', 'toilet', 'roof', 'gutter', 'electrical', 'outlet',
  'today', 'tomorrow', 'this week', 'next week', 'this morning', 'this afternoon',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'morning', 'afternoon', 'evening', 'AM', 'PM', "o'clock",
  'my name is', 'my number is', 'my address is', 'my email is',
  'how much', 'how soon', 'price', 'cost', 'speak to someone',
  'take me off your list', 'not interested', 'stop calling',
  // Short confirmations are what a booking call is MADE of, and they are the
  // hardest thing for a recogniser to score confidently: one syllable, no
  // context. Listing every natural form of yes and no biases the model toward
  // hearing them instead of discarding them as noise.
  'yes', 'yeah', 'yep', 'yup', 'sure', 'correct', "that's right", 'sounds good',
  'no', 'nope', 'not really', "don't", 'never mind',
  'okay', 'ok', 'alright', 'perfect', 'exactly', 'go ahead', 'please do',
  'hold on', 'one second', 'let me check', 'can you repeat that',
].join(',');

/**
 * The words most likely to be misheard are the ones unique to THIS business —
 * its name, its services, its agent's name. Feed those to the recogniser so
 * "Acme Roofing" is not transcribed as "acne roofing".
 */
function hintsFor(profile, account) {
  const v = (account && account.voice) || {};
  const words = [
    profile && profile.name, v.agentName,
    ...String((profile && profile.offer) || '').split(/[,;.\/]+/).map((s) => s.trim()).filter((s) => s && s.length < 40),
  ].filter(Boolean);
  // Twilio caps hints at 500 phrases and 100 chars each; keep this well under.
  return words.slice(0, 40).map((w) => String(w).replace(/[",]/g, ' ').trim()).filter(Boolean).join(',');
}

/**
 * Speak, then listen. The core conversational turn.
 *
 * timeout="8" is the fix for most "sorry, I didn't catch that": that attribute
 * is how long to wait for the caller to START talking, and Twilio's default of
 * 5s expires while a real person is still thinking about the question — the
 * gather then returns empty and we apologise at someone who had not spoken yet.
 * speechTimeout stays "auto" so we cut in promptly once they DO stop.
 */
function sayAndGather(text, action, voiceName, extraHints, opts = {}) {
  // Language follows the voice: every call site already passes voiceFor(account),
  // and voiceFor guarantees a Spanish account gets a Spanish voice, so the
  // recognizer language can be derived here without touching eight call sites.
  const vmeta = VOICES.find((x) => x.value === voiceName);
  const lang = opts.lang || (vmeta && vmeta.lang) || 'en-US';
  const hints = extraHints ? `${extraHints},${BASE_HINTS}` : BASE_HINTS;
  // bargeIn lets the caller cut the agent off, which is what makes it feel
  // like a person and not a menu. But it also lets a television cut the agent
  // off. Once a call has proven noisy (we have already thrown away audio on
  // it), interrupting stops being a feature: the agent finishes its sentence
  // and THEN listens, so background noise can no longer clip it mid-word.
  const barge = opts.noisy ? 'false' : 'true';
  return twiml(
    `<Gather input="speech dtmf" action="${esc(action)}" method="POST"`
    + ` timeout="8" speechTimeout="${SPEECH_TIMEOUT}"` + (USE_SPEECH_MODEL ? ` speechModel="${SPEECH_MODEL}"` : '')
    // maxSpeechTime is a HARD stop — Twilio ends the caller's turn mid-word
    // when it fires, no pause required. At 15 seconds it was guillotining
    // anyone describing a problem ("my water heater's leaking, started this
    // morning, there's water across the basement and we've got people over
    // Saturday...") — which is the single most valuable thing a caller says.
    // It was set to 15 to stop a noisy room running the gather to its limit
    // collecting television; the right fix for that is the noisy flag below,
    // not a ceiling on everybody. 45s costs NOTHING extra: recognition bills a
    // flat fee per gather up to 60 seconds. A proven-noisy call keeps a short
    // ceiling, where the trade actually makes sense.
    + ` bargeIn="${barge}" maxSpeechTime="${opts.noisy ? 15 : MAX_SPEECH_TIME}" hints="${esc(hints)}"`
    + ` language="${lang}" actionOnEmptyResult="true" profanityFilter="false">`
    + say(text, voiceName)
    + `</Gather>`
  );
}
function sayAndHangup(text, voiceName) { return twiml(say(text, voiceName) + '<Hangup/>'); }

// ---- voicemail left on an OUTBOUND call ----
// This message is spoken to a machine that picked up a call WE placed. It is
// not a greeting for someone who rang us. The two got confused, and the line
// left on prospects' answering machines was "thanks for calling, we couldn't
// pick up" — addressed to a person who never called, from a company they have
// not heard of, with no reason to ring back. A voicemail that leaves no name,
// no reason and no number is a wasted call.
const INBOUND_GREETING_RE = /thanks?\s+for\s+call|you'?ve\s+reached|we\s+(?:can'?t|couldn'?t)\s+(?:pick\s*up|take\s+your\s+call)|leave\s+(?:your|a)\s+(?:name|message)\s+(?:and|after)/i;
/** Does this saved text read like an inbound greeting rather than an outbound pitch? */
function looksInbound(text) { return INBOUND_GREETING_RE.test(String(text || '')); }
/**
 * A short outbound voicemail built from the business profile: who is calling,
 * why it matters to them, and the number to ring back. Kept to ~3 sentences —
 * long voicemails get deleted before the number arrives, so the number comes
 * early and is repeated slowly at the end.
 */
function voicemailPitch(profile = {}, account = {}, callbackNumber = '') {
  const biz = String(profile.name || 'our team').trim();
  const who = String((account.voice && account.voice.agentName) || 'Sarah').trim();
  // The one-line reason to call back, in the business's own words.
  const hook = String(profile.valueProp || profile.offer || '').replace(/\s+/g, ' ').trim();
  const short = hook ? hook.replace(/^(we|i)\s+/i, '').slice(0, 140).replace(/[.,;:\s]+$/, '') : '';
  const num = String(callbackNumber || (account.voice && account.voice.number) || '').trim();
  const spoken = num.replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '').split('').join(' ');
  return [
    `Hi, it's ${who} calling from ${biz}.`,
    short ? `I'm reaching out because we ${short}.` : `I wanted to introduce what we do and see if it's a fit.`,
    num ? `If that's worth two minutes, call us back on ${spoken}. That's ${spoken}.` : `I'll try you again another time.`,
    `Thanks, and have a good one.`,
  ].join(' ');
}
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
/**
 * Is this line being test-driven rather than taking real customer calls?
 *
 * Resolved when the prompt is built, not when settings are saved, because the
 * owner's voice config predates this flag — waiting for a save would leave the
 * public demo number pitching software at someone describing a burst pipe.
 */
/**
 * What the demo line is allowed to quote, built from the LIVE plan list.
 *
 * Two bugs this fixes at once. The agent was pitching from whatever prose sat
 * in the saved business profile, so it was still naming tiers that have since
 * been deleted — quoting a caller a price they cannot buy. And it was leading
 * with the CHEAPEST plan, which is the one nobody should hear first: someone
 * ringing about a missed call wants their phone answered, and the plan that
 * does that is Front Desk. Lead with the thing they called about, and let
 * Complete be the upgrade rather than the opener.
 */
function pitchBlock() {
  const plans = require('./plans');
  const fd = plans.TIERS.frontdesk, comp = plans.TIERS.complete;
  const lines = [
    `=== WHAT TO QUOTE — THESE PRICES ONLY ===`,
    `NEVER name a plan or a price that is not in this list, even if something in the business description above says otherwise. If you are unsure, say "let me have someone confirm that" rather than guessing at a number.`,
    ``,
    `LEAD WITH THIS, EVERY TIME:`,
    `  FRONT DESK — $${fd.price} a month. Your phone answered around the clock, jobs booked straight into your calendar, and between calls it goes and finds you ${fd.leads} new customers a month and writes each one a personal email. ${fd.voiceMinutes.toLocaleString()} talk-minutes included. Seven days free, card required, nothing charged until day eight, cancel in one click.`,
    `  This is the plan for anyone who called about missed calls, their phone, a receptionist, or getting more customers. That is almost everyone. Do NOT open with a cheaper plan to seem affordable — they called because their phone is costing them jobs, and the cheap plans do not answer the phone.`,
    ``,
    `UPSELL TO THIS when they have several locations, a big team, or say they already do outreach:`,
    `  COMPLETE — $${comp.price.toLocaleString()} a month. Everything in Front Desk, plus ${comp.leads.toLocaleString()} new customers found a month instead of ${fd.leads}. For multi-location businesses and agencies.`,
    ``,
    `EMAIL-ONLY PLANS — mention these ONLY if the caller says outright they do not want the phone answered and only want new customers found:`,
    plans.tierList().filter((t) => t.group !== 'phone').map((t) => `  ${t.name.toUpperCase()} — $${t.price} a month, ${t.leads.toLocaleString()} customers found and written to.`).join('\n'),
    ``,
    `Never quote a per-minute price, a setup fee, or a discount — none exist. There are no overage charges on any plan: when an allowance runs out it pauses, it never bills more.`,
  ];
  return lines.join('\n');
}

function demoModeFor(account) {
  const v = (account && account.voice) || {};
  if (v.demoMode !== undefined) return !!v.demoMode;
  const owners = String(process.env.OWNER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return owners.includes(String((account || {}).email || '').toLowerCase());
}

/**
 * The owner's diary, as the agent needs to see it: what is already booked over
 * the next two weeks, in the business's own time zone. Without this the agent
 * booked blind -- it had no idea the plumber was already on a job Tuesday at
 * 2pm, double-booked it, and the owner had to ring the customer back to move
 * it. That is the failure that gets an AI receptionist switched off in week one.
 */
function diaryFor(account) {
  try {
    const tz = tzFor(account);
    const now = Date.now();
    const horizon = now + 14 * 86400000;
    const rows = db.getAppointments(account.id)
      .filter((a) => a.startsAt && a.status !== 'cancelled' && a.status !== 'done')
      .map((a) => ({ a, t: Date.parse(a.startsAt) }))
      .filter(({ t }) => !isNaN(t) && t >= now - 3600000 && t <= horizon)
      .sort((x, y) => x.t - y.t)
      .slice(0, 40);
    if (!rows.length) return '';
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    const lines = rows.map(({ a, t }) => `  - ${fmt.format(new Date(t))}${a.reason ? ' — ' + a.reason : ''}`);
    return `=== ALREADY BOOKED (do NOT book anyone into these times) ===\nEach job takes about an hour unless the business says otherwise, so treat the hour after each of these as taken too.\n${lines.join('\n')}`;
  } catch { return ''; }
}

function systemPrompt(profile, account, { direction, lead, leadBrief }) {
  const lang = langFor(account);
  const call_leadBrief = leadBrief
    ? `=== YOU HAVE DEALT WITH THIS PERSON BEFORE ===\n${leadBrief}\nUse it naturally — referencing what was already said is what makes this feel like a real company, not a switchboard. Never read the history back at them like a file.`
    : '';
  const agentName = (account.voice && account.voice.agentName) || 'Sarah';
  const biz = profile.name || 'this business';
  const canTransfer = !!(account.voice && account.voice.transferTo);
  return [
    `You are ${agentName}, an AI voice assistant answering the phone for ${biz}. This is a live phone call — your words are spoken aloud.`,
    lang === 'es-US'
      ? `=== IDIOMA: ESPAÑOL ===
Este negocio atiende en español. Habla SIEMPRE en español natural de Estados Unidos — cálido, directo, como una recepcionista de verdad, no como un manual. Todo lo demás en estas instrucciones sigue aplicando (identifícate como IA, no inventes precios, agenda solo en horarios libres). Si la persona te habla en inglés, cambia a inglés y sigue en inglés. El campo "say" del JSON debe ir en el idioma que estés hablando.`
      : `If a caller opens in Spanish, switch to Spanish and stay in it — plenty of the people who ring a trades business do. Keep everything else the same. The JSON "say" field must be in whatever language you are speaking.`,
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
    `Short. One or two sentences. Sometimes three words. Then stop talking. Every extra word you generate is a fraction of a second of silence the caller sits through before hearing you — brevity IS responsiveness on this line.`,
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
    `If they trail off, give a short prompt: "...yeah?" or "Pricing, or scheduling?"`,
    `WHEN WHAT YOU HEARD IS INCOMPLETE OR GARBLED — a fragment, a half-sentence, words that don't quite make sense together — the person almost certainly WAS NOT DONE TALKING and the line clipped them. Do NOT answer the fragment as if it were their whole point; that is what makes people feel unheard and furious. Instead, hand the turn straight back with the least you can say: "Go on —" or "Sorry, say that last bit again?" or repeat the one piece you did catch as a question: "...the water heater?" One short line, then listen. Never make someone repeat an entire sentence when you caught most of it — confirm the part you have and ask only for the rest.`,
    `Never say "I didn't catch that" twice in a row. If it happens again, work with whatever you have and ask a narrow yes/no question instead.`,
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
    (account.voice && account.voice.slotMinutes) ? `A typical job or appointment takes about ${account.voice.slotMinutes} minutes.` : '',
    '',
    diaryFor(account),
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
    `  · auto shop: "you're under a lift with your hands full — that's when the phone rings, and that's a repair someone else books"`,
    `Then give them the actual shape of it for their business: who it answers as, what it books, where it puts it. A plan they could picture using tomorrow, not a feature list.`,
    `One exception, and only one: medical or dental practices handle patient health information under HIPAA, which this service is not set up for. If the caller runs a clinic, dental office, therapy or medical practice, be warm and honest — "we're not set up for medical practices yet, that needs extra safeguards" — take their details for a future follow-up, and do not sell them a plan.`,
    `NEVER say or imply any OTHER business type isn't a fit, isn't the usual customer, or isn't who this is for. If their trade is one you've not been briefed on, reason it out from what they told you — every business that answers a phone or books an appointment can use this.`,
    '',
    // The demo line's whole job is to be test-driven. A prospect is told to
    // ring it and describe a plumbing emergency, so the agent must play that
    // straight rather than answering a leaking water heater with a software
    // pitch — the point is for them to HEAR what their own customer would get.
    demoModeFor(account)
      ? [`=== THIS IS A DEMO LINE — CALLERS ARE TESTING YOU ===`,
         `THIS NUMBER BELONGS TO ${biz.toUpperCase()}. It is not a plumber, a salon, a roofer or any other business. Callers here are business owners trying the product out, and most were told to phone up and pretend to be a customer.`,
         ``,
         `SO: if ANYONE asks you to book a service, describes a problem at their home, or asks about work ${biz} does not actually do — plumbing, heating, a leak, a haircut, a quote, a repair, ANY trade at all — that is the test, every time. There is no exception. Never turn them away and never say you cannot help.`,
         ``,
         `PLAY THE RECEPTIONIST FOR THAT TRADE, END TO END. This is a demonstration and the demonstration IS the sale: they need to FEEL what their own customer would get, and a one-line taste followed by a pitch shows them nothing. So actually do the job:`,
         `  · Take the problem seriously and ask the one or two things a good front desk would ("is it leaking right now?", "is anyone home?").`,
         `  · Get their name, the best number to call back, and a window that works ("tomorrow morning or afternoon?").`,
         `  · Then BOOK IT for real: return action "book" with name, phone, reason, when and whenISO exactly as a paying customer's line would. This creates a real diary entry and, if a number is on file, a real confirmation text — that text landing on their phone is the most convincing thing that can happen on this call.`,
         `THE REVEAL goes in the "say" of that booking turn, not before. Roughly: "Done — that's booked and you'll get a text in a second confirming it. Now, I should come clean: this is ${biz}'s number, I'm the AI, and everything you just heard is exactly what YOUR customers would get, on YOUR number — booked straight into your calendar while you're on a job."`,
         `  Then ASK FOR THE SIGN-UP, out loud, every time: "Want me to get your AI set up for your business? It's dawnpipe dot com — takes about five minutes."`,
         `Keep it moving: aim to book by the third or fourth exchange. Do not stall in character for its own sake, but do not break character before the booking either.`,
         ``,
         ``,
         pitchBlock(),
         ``,
         `Say the website as "dawnpipe dot com". Offer to text them the link if they want it.`,
         `After the turn, keep selling: ask what line of work they are in and make it concrete for THAT trade.`,
         `If they open by asking about pricing, the product, or how it works, skip the play-along entirely — they are not testing, they are buying. Answer them directly.`,
         `Never pretend to be a human, even for a second, even in character: if they ask, say plainly you are an AI. That rule outranks everything above.`].join('\n')
      : '',
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
    `{"say":"what you say out loud","action":"continue|book|transfer|dnc|end","urgency":"routine|urgent|emergency","name":"","company":"","phone":"","email":"","reason":"","when":"","whenISO":""}`,
    `- "urgency" on EVERY turn, judged from what they have said so far. "emergency" = active damage or safety risk right now: water actively leaking or flooding, no heat in freezing weather, no AC in dangerous heat with a vulnerable person, gas smell, sparking or burning smell, sewage backup, lockout with a child inside, roof open to rain. "urgent" = same-day need but not dangerous: no hot water, AC out in mild weather, a clog. "routine" = quotes, estimates, scheduling, questions. When in doubt between urgent and emergency, choose emergency — a false alarm costs a phone call, a miss costs a flooded house.`,
    `- If urgency is "emergency" and the business has an on-call number, your FIRST job is to get them to a human: say one short safety line if there is an obvious one (turn the water off at the mains, leave the house if you smell gas, do not touch the panel), take their name and address in ONE question, then set action "transfer". Do not qualify, do not sell, do not offer a callback tomorrow.`,
    `- action "continue": keep talking (the default).`,
    `- action "book": they agreed to a callback/meeting. Fill name, phone, reason, "when" (their words, e.g. "Tuesday afternoon"), and "whenISO".`,
    `- BOOK ONLY INTO OPEN TIME. Before offering a slot, check it against ALREADY BOOKED above and the business hours. Never offer a time that overlaps an existing booking (plus its hour). If the caller asks for a time that is taken, say so plainly and offer the two nearest open times: "Two's taken — I can do one, or three-thirty." Offer specific times, not "sometime that day". Outside business hours, offer the first open slot inside them.`,
    `  "whenISO" MUST be a real calendar date-time you resolve from what they said, in the format YYYY-MM-DDTHH:MM (24-hour, in the business's local time zone). RIGHT NOW it is ${localNow(tzFor(account)).text} — use THAT as today, not any other date. "Tomorrow at 2" becomes tomorrow's date at 14:00. "Next Tuesday morning" becomes that Tuesday at 09:00. If they were vague ("sometime next week"), PIN IT DOWN before booking — offer two specific slots and let them pick. Never book without a time you could put in a diary.`,
    `- action "transfer": connect them to a human now.`,
    `- action "dnc": they asked not to be contacted. Confirm politely in "say".`,
    `- action "end": the conversation is finished (not interested, or done). STILL fill name, phone and reason if you learned them. If you told them "someone will be in touch" you MUST fill these — that promise is the only record the owner will have, and without it a real customer waiting for a call back is simply lost.`,
    `NEVER end a call having taken someone's details without either booking a time or filling these fields. Getting a name and number and returning nothing is the single most damaging thing you can do on this line.`,
  ].filter(Boolean).join('\n');
}

// ---------------- time, in the business's own zone ----------------
// The server runs in UTC. "Tomorrow morning" said on a Sunday evening in
// Chicago is Monday 9am Chicago — but resolved in UTC it became Tuesday 4am:
// UTC was already Monday when the call happened, so "tomorrow" slipped a day,
// and 09:00 read as UTC is 4am Central. Every date the agent reasons about, and
// every one it returns, has to be anchored to where the business actually is.
const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE || 'America/Chicago';
function tzFor(account) {
  const v = (account && account.voice) || {};
  const tz = v.timezone || (account && account.timezone) || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
/** Now, as the business's local wall clock: "Sunday, August 16, 2026, 7:42 PM (America/Chicago)". */
function localNow(tz) {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  // Hour only, deliberately. This string lands in the CACHED system prompt;
  // a minute-level time changed the prompt every 60 seconds and silently
  // busted the cache on every turn after a minute boundary -- the whole
  // "prompt caching" line was mostly cache misses. The model resolves
  // "tomorrow morning" from the date and rough time of day; it never needs
  // the minute.
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: true }).format(d);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
  return { text: `${date}, ${time} (${tz})`, isoDate: iso, tz };
}
/**
 * Turn "YYYY-MM-DDTHH:MM" meant as LOCAL wall-clock time in `tz` into a real
 * instant. JS has no zone-aware parse, so: pretend it's UTC, measure that
 * zone's offset at that moment, and shift by it. DST-correct via Intl.
 */
function localToInstant(ymdhm, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(ymdhm || '').trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = {}; for (const p of parts) g[p.type] = p.value;
  const asIf = Date.UTC(+g.year, +g.month - 1, +g.day, +(g.hour % 24), +g.minute);
  return new Date(guess - (asIf - guess));
}

/**
 * Is this transcription background noise rather than the caller?
 *
 * Two signals, because neither is enough alone. Confidence catches most noise
 * (a TV comes back at 0.2-0.4), but a real one-word answer — "yes", "Tuesday",
 * "no" — can also score low, and cutting those off makes the agent feel deaf
 * all over again. So short answers get a lower bar, and anything that LOOKS
 * like noise on its face — pure filler, one repeated word, no letters — is
 * dropped even at decent confidence.
 */
const NOISE_FLOOR = Number(process.env.VOICE_MIN_CONFIDENCE || 0.45);
const SHORT_FLOOR = 0.30;
function isNoise(text, confidence) {
  const t = String(text || '').trim();
  if (!t) return true;
  const words = t.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return true;                                  // no actual words
  // Filler-only ("um uh mm hmm") is what a room sounds like transcribed.
  const FILLER = new Set(['um', 'uh', 'mm', 'hmm', 'mhm', 'ah', 'eh', 'oh', 'er', 'huh', 'the', 'a', 'and']);
  if (words.every((w) => FILLER.has(w))) return true;
  // One word repeated ("the the the") is a stutter of the recogniser, not speech.
  if (words.length >= 3 && new Set(words).size === 1) return true;
  if (isNaN(confidence)) return false;                             // no score = trust it
  // A transcript that contains a word we were LISTENING FOR — a day, a trade,
  // "my number", "call" — is almost certainly the caller, however the score
  // came out. Noise transcribes as filler; it does not transcribe as
  // "tomorrow morning". Only drop hint-bearing speech if the score is dire.
  const bearsHint = words.some((w) => HINT_WORDS.has(w));
  if (bearsHint) return confidence < 0.20;
  // Short real answers are legitimately low-confidence; give them room.
  const floor = words.length <= 2 ? SHORT_FLOOR : NOISE_FLOOR;
  return confidence < floor;
}
// A word we were LISTENING FOR gets hint protection in isNoise(). The old
// length>2 filter silently excluded the two most common answers on a booking
// call -- "no" and "ok" -- so a caller declining or agreeing scored as noise.
const HINT_WORDS = new Set(BASE_HINTS.toLowerCase().split(',').flatMap((h) => h.split(/\s+/)).filter((w) => w.length >= 2));

/**
 * Read a finished transcript and pull out anything the caller asked for.
 *
 * The live agent only saves at the end of a turn it controls. When the caller
 * hangs up first — "I want a call tomorrow morning, I'm Dana, 312-555-0123,
 * bye" — there is no closing turn, so everything it heard was simply dropped.
 * This runs once on hangup and rescues it. It is deliberately conservative:
 * it must never invent a name, a number or a time that was not actually said.
 */
async function salvageFromTranscript(call) {
  const turns = (call && call.turns) || [];
  const callerSaid = turns.filter((t) => t.who === 'caller').map((t) => t.text).join('\n');
  if (!callerSaid.trim()) return null;
  const transcript = turns.map((t) => `${t.who === 'caller' ? 'Caller' : 'AI'}: ${t.text}`).join('\n');
  const prompt = [
    `A phone call just ended — the caller hung up. Read the transcript and pull out ONLY what the caller actually said. Do not infer, guess or fill gaps.`,
    ``,
    `RIGHT NOW it is ${localNow(tzFor(call.account)).text} — resolve every relative day ("tomorrow", "Monday", "next week") from THAT, in that time zone. Their number as dialled is ${call.direction === 'inbound' ? (call.from || 'unknown') : (call.to || 'unknown')}.`,
    ``,
    transcript,
    ``,
    `Return STRICT JSON only:`,
    `{"wantsCallback":true|false,"name":"","phone":"","company":"","reason":"","when":"","whenISO":"","summary":""}`,
    `- wantsCallback: true ONLY if the caller asked to be called back, to book something, or gave a time. A caller who said "not interested" or just hung up is false.`,
    `- name/phone/company: exactly as the caller stated them; empty if they did not. If they gave no phone but the dialled number is known, leave phone empty — the caller's own line will be used.`,
    `- when: their words ("tomorrow morning"). whenISO: resolve it to YYYY-MM-DDTHH:MM in their local time ONLY if they gave a real time reference; "tomorrow morning" = tomorrow 09:00. Empty if none.`,
    `- summary: one or two plain sentences of what they wanted, for the owner to read before calling back.`,
  ].join('\n');
  try {
    const raw = await callAI(prompt, { maxTokens: 400, tier: 'draft', timeoutMs: 20000 });
    const j = safeJSON(raw);
    if (!j || typeof j !== 'object') return null;
    return {
      wantsCallback: !!j.wantsCallback,
      name: String(j.name || '').trim(),
      phone: String(j.phone || '').trim(),
      company: String(j.company || '').trim(),
      reason: String(j.reason || '').trim(),
      when: String(j.when || '').trim(),
      whenISO: normaliseWhen(j.whenISO, tzFor(call.account)),
      summary: String(j.summary || '').trim(),
    };
  } catch (e) {
    return null;
  }
}

/**
 * The model's whenISO is a claim, not a fact. Accept it only if it parses and
 * is actually in the future — a booking stamped in the past is worse than one
 * with no time at all, because it silently drops off the calendar.
 */
function normaliseWhen(v, tz) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  // A bare "YYYY-MM-DDTHH:MM" from the model is the business's LOCAL wall
  // clock, never UTC. `new Date(raw + ':00')` read it as UTC on the server,
  // which turned "9am" into 4am Central. Anything carrying an explicit zone
  // is honoured as written.
  const d = /Z|[+-]\d\d:?\d\d$/.test(raw) ? new Date(raw) : localToInstant(raw, tz || DEFAULT_TZ);
  if (!d || isNaN(d.getTime())) return '';
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
/**
 * Prime the prompt cache for a call. Sends the exact system prompt think() will
 * use with a trivial 1-token request, so the caller's first real turn hits a
 * warm cache instead of paying the cold-prompt latency. Only when the API is
 * in use (the CLI path has no cache to warm).
 */
async function warmCache(call) {
  try {
    if (require('./ai').aiMode() !== 'api') return;
    const system = systemPrompt(call.profile || {}, call.account || {}, { direction: call.direction, lead: call.lead, leadBrief: call.leadBrief });
    await callAI('Reply with the single word: ready', { maxTokens: 3, tier: 'draft', timeoutMs: 6000, system });
  } catch { /* warming is best-effort */ }
}

async function think(call, heard) {
  const profile = call.profile || {};
  const account = call.account || {};
  const history = call.turns.map((t) => `${t.who === 'caller' ? 'Caller' : 'You'}: ${t.text}`).join('\n');
  // The instructions are identical every turn, so they go in a CACHED system
  // block; only the moving parts go in the message. Cuts both latency and cost.
  const system = systemPrompt(profile, account, { direction: call.direction, lead: call.lead, leadBrief: call.leadBrief });
  // Has the agent already asked this? Repeating a question the caller already
  // answered (because the line clipped their answer) is what burns exchanges
  // and tempers — so the model sees its own last two questions and is told
  // not to ask them again.
  const asked = call.turns.filter((t) => t.who !== 'caller' && /\?/.test(t.text)).slice(-2).map((t) => t.text);
  const buyingNow = /\b(sign\s*me\s*up|sign\s*up|i(?:'| wi)?ll take|i want (?:the |to )|let'?s do (?:it|that)|book (?:it|me|that)|how do i (?:pay|start|get started)|the (?:tester|starter|front desk|growth|scale|complete))\b/i.test(heard);
  const prompt = [
    call.channel === 'sms'
      ? `=== YOU ARE TEXTING, NOT TALKING ===\nThis is an SMS thread, not a phone call. Write like a person texting from a business: 1-2 short sentences, no filler, no "How may I assist you", no spelling things out phonetically. Numbers and addresses as digits. Ask one thing at a time. If they give a time and what they need, book it (action "book") and confirm in the text. Everything else about who you are and what you may say still applies.`
      : '',
    history ? `=== WHAT'S BEEN SAID SO FAR (do NOT repeat yourself) ===\n${history}` : '',
    asked.length ? `You have ALREADY asked: ${asked.map((q) => JSON.stringify(q)).join(' and ')} — do not ask either again. If their answer was unclear, confirm the part you have and ask only for the missing piece.` : '',
    (buyingNow || call.closing)
      ? `=== THEY ARE BUYING. CLOSE NOW. ===\nThe caller just signalled they want to sign up or pick a plan. This is the whole point of the call. Do NOT ask another qualifying question, do NOT go back to the pitch, do NOT ask if they have questions. Give them the exact next step in one breath: the website ("dawnpipe dot com"), which plan they named and its price if you have it, and offer to text the link right now. Then stop talking and let them go do it. Set action "end" only after you have given the link.`
      : '',
    '',
    `They just said: "${heard}"`,
    `Your reply (JSON only):`,
  ].filter(Boolean).join('\n');

  // 150 tokens is plenty for two spoken sentences, and fewer tokens means the
  // caller waits less. Every token is latency they can hear.
  // 110, not 150. Two short spoken sentences plus the JSON wrapper is ~70
  // tokens; the headroom let the model ramble, and every extra token is
  // latency the caller hears as dead air. Shorter is also more human.
  const t0 = Date.now();
  const raw = await callAI(prompt, { maxTokens: 110, tier: 'draft', timeoutMs: 10000, system });
  call.lastThinkMs = Date.now() - t0;
  const j = safeJSON(raw) || {};
  const text = String(j.say || '').trim();
  return {
    // If the model returned nothing usable, do NOT default to "didn't catch
    // that" — the caller DID say something, and this line was the source of
    // the maddening repeat-the-question loop. Hand the turn back gently.
    say: text || "Go on — I'm with you.",
    action: ['continue', 'book', 'transfer', 'dnc', 'end'].includes(j.action) ? j.action : 'continue',
    urgency: ['routine', 'urgent', 'emergency'].includes(j.urgency) ? j.urgency : 'routine',
    data: {
      name: j.name || '', company: j.company || '', phone: j.phone || '',
      email: j.email || '', reason: j.reason || '',
      when: j.when || '', whenISO: normaliseWhen(j.whenISO, tzFor(call.account)),
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

/**
 * Start recording a live call via the Recordings API. Both legs, from now to
 * hangup. Twilio POSTs the recording URL to `callbackUrl` when it is ready.
 * Fire-and-forget: a recording failure must never affect the call. Owners need
 * this to hear tone, verify a mumbled address or gate code the STT may have
 * mangled, and settle "I never said that" -- and every AI competitor at or
 * below our price already offers it.
 */
async function startRecording(callSid, callbackUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !callSid) return null;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callSid)}/Recordings.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ RecordingChannels: 'dual', RecordingStatusCallback: callbackUrl, RecordingStatusCallbackEvent: 'completed', RecordingStatusCallbackMethod: 'POST' }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? data.sid : null;
  } catch { return null; }
}

module.exports = {
  startRecording,
  configured, verifySignature, twiml, say, sayAndGather, sayAndHangup, sayAndSignOff, sayAndDial, esc,
  startCall, getCall, endCall, think, placeCall, toE164, estimateCost, MAX_EXCHANGES, MAX_CALL_SECONDS,
  VOICES, voiceFor, DEFAULT_VOICE, langFor, LANGS,
  systemPrompt, demoModeFor, limitsFor, hintsFor, warmCache,   // exported so prompts and limits can be asserted in tests
  voicemailPitch, looksInbound,
  salvageFromTranscript, isNoise,
  normaliseWhen, localToInstant, localNow, tzFor,   // time helpers, exported for tests
};
