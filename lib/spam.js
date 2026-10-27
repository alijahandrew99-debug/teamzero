// Spam-call filtering, in three layers, cheapest first.
//
// 1. REJECT before answering (free): the owner's blocklist plus numbers this
//    module auto-blocked. <Reject> costs nothing and spends no AI tokens.
// 2. SCREEN suspicious callers (one sentence): anonymous caller ID, a failed
//    STIR/SHAKEN attestation (carrier says the number is likely spoofed), or a
//    prior strike gets "what's this call about?" before the real conversation.
//    Robocalls play a recording or dead air and fail; humans answer and flow
//    straight into the normal call without noticing they were screened.
// 3. TRIP mid-call (free): classic robocall phrases hang up immediately, the
//    call is marked spam, and the customer's plan minutes are NOT billed.
//
// Strikes: dead-air calls and failed screens are 1 point, detected robocalls
// are 2. At 3 points within 30 days the number goes on the account's block
// list and layer 1 rejects it forever. Detection is deliberately conservative
// -- hanging up on a real customer is far worse than talking to one robot.
require('./env');
const db = require('./db');
const suppress = require('./suppression');

const BLOCK_AT = 3;
const DECAY_MS = 30 * 24 * 60 * 60 * 1000;

// Carriers deliver blocked/withheld caller ID as these literal strings, or as
// phonewords (+266696687 spells ANONYMOUS). A From that has no usable digits
// can't be a customer you could ever call back.
const ANON = /^(anonymous|restricted|unavailable|unknown|private)$/i;
const ANON_NUMBERS = new Set(['266696687', '7378742833', '86282452253']);

/** Free signals available on the very first webhook, before answering. */
function signalCheck(params) {
  const from = String(params.From || '').trim();
  const digits = from.replace(/[^0-9]/g, '');
  if (!from || ANON.test(from) || ANON_NUMBERS.has(digits) || digits.length < 7) {
    return { suspect: true, reason: 'no caller ID' };
  }
  // STIR/SHAKEN: the carrier cryptographically vouched (or didn't) for the
  // caller ID. Only a FAILED validation is suspicious -- "No-TN-Validation"
  // is normal for plenty of legitimate landlines and small carriers.
  if (/TN-Validation-Failed/i.test(String(params.StirVerstat || ''))) {
    return { suspect: true, reason: 'caller ID failed carrier verification' };
  }
  return { suspect: false, reason: '' };
}

/**
 * Unambiguous robocall/recorded-pitch markers only. Anything a real customer
 * of a trade business might plausibly say must NOT be here -- "warranty"
 * alone would hang up on an appliance shop's actual customers.
 */
const ROBO = new RegExp([
  'press\\s+(one|two|three|four|five|six|seven|eight|nine|zero|[0-9])\\b',
  'this is an important (message|call|notice)',
  'do not hang up',
  '(car|auto|vehicle).{0,12}warranty',
  'internal revenue service|the IRS is',
  'social security (administration|number has been)',
  '(google|your) business listing',
  'you (have been|are) (selected|pre.?approved|eligible for)',
  'this is (your|the|a) final (notice|attempt|call)',
  'lower your (interest|credit card|monthly) (rate|payment)',
  'student loan (forgiveness|relief|debt)',
  'medicare (benefits|advantage|open enrollment)',
  'congratulations.{0,25}(won|winner|prize)',
  'to be removed from (this|our|the) (list|calling)',
].join('|'), 'i');

function looksLikeRobocall(text) { return ROBO.test(String(text || '')); }

function key(accountId, number) {
  const k = suppress.phoneKey(number);
  return k ? `${accountId}|${k}` : '';
}

function rec(accountId, number) {
  const k = key(accountId, number);
  if (!k) return null;
  const r = db.readCollection('spamwatch').find((x) => x.id === k);
  if (!r) return null;
  if (Date.now() - new Date(r.at).getTime() > DECAY_MS) return null;   // stale = clean slate
  return r;
}

function strikes(accountId, number) {
  const r = rec(accountId, number);
  return r ? r.points : 0;
}

/**
 * Record a strike; auto-block at BLOCK_AT points. Returns the new total.
 * The block goes through the same suppression list the owner's manual blocks
 * use, so layer 1 (<Reject> on /voice/incoming) needs no extra check.
 */
function strike(accountId, number, points, why) {
  const k = key(accountId, number);
  if (!k) return 0;
  const existing = rec(accountId, number);
  const total = (existing ? existing.points : 0) + points;
  if (existing) db.patchCollection('spamwatch', k, { points: total, at: new Date().toISOString(), why });
  else db.pushCollection('spamwatch', { id: k, accountId, number: String(number), points: total, at: new Date().toISOString(), why });
  if (total >= BLOCK_AT && !suppress.isPhoneSuppressed(accountId, number).blocked) {
    suppress.suppressPhone(accountId, number, 'manual', { note: `auto-blocked as spam (${why})` });
    db.logActivity(accountId, { agent: 'VOICE', msg: `${number} auto-blocked as spam after repeated junk calls (${why}). Future calls are rejected before they cost anything. Unblock any time by texting or calling them yourself.` });
  }
  return total;
}

/** The screening question, with the mandatory AI/recording disclosure intact. */
function screenLine(profileName, agentName, es, recOn) {
  return es
    ? `Hola, se ha comunicado con ${profileName} — le habla ${agentName}, su recepcionista de inteligencia artificial${recOn ? ', en una línea grabada' : ''}. Antes de continuar — ¿de qué se trata su llamada?`
    : `Hi, you've reached ${profileName} — this is ${agentName}, their AI receptionist${recOn ? ', on a recorded line' : ''}. Quick one before I put you through — what's the call about?`;
}

module.exports = { signalCheck, looksLikeRobocall, strikes, strike, screenLine, BLOCK_AT };
