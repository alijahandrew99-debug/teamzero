// Call-backs: the legal half of outbound calling.
//
// Automated AI cold calling is OFF for customers, and it stays off. The FCC's
// February 2024 declaratory ruling put AI-generated voices inside the TCPA's
// "artificial or prerecorded voice" category, so dialling a stranger with one
// is $500-$1,500 per call under strict liability. There is no wording that
// gets round it, and texting someone to ask permission is the same violation
// as calling them.
//
// But the restriction is on calling people who never asked. It says nothing
// about calling back someone who just raised their hand -- and that call is
// worth more anyway. A form filled in at 11pm, answered in thirty seconds,
// beats a cold list every time, and it is defensible.
//
// Three sources, in descending order of how well they hold up:
//   1. FORM        they typed their number into the business's own form and
//                  ticked a consent box: prior express written consent, and
//                  we hold the evidence.
//   2. MISSED CALL they rang the business first and hung up before the AI
//                  could help. Owner-enabled, informational only.
//   3. OWNER       the business clicks "call back" on a caller who left a
//                  number, about that caller's own enquiry.
//
// Everything that makes (1) hold up -- the wording, the timestamp, the IP --
// is stored with the record exactly as shown, and never edited afterwards.
require('./env');
const crypto = require('crypto');
const db = require('./db');

/**
 * The consent language a person must AFFIRMATIVELY tick. One function so the
 * form, the stored evidence and the audit view can never drift apart.
 *
 * Written to the elements of prior express written consent (47 CFR
 * 64.1200(f)(9)): names WHO may call, names the NUMBER they gave, says the
 * call may be an automated/AI voice, says agreeing is NOT a condition of
 * buying anything, and gives the way out. The checkbox is unticked by
 * default -- pre-ticked boxes are not consent.
 */
function consentText(businessName, phone) {
  const biz = String(businessName || 'this business').trim();
  const num = String(phone || '').trim();
  return `I agree that ${biz} may call and text me at ${num || 'the number I provided'} about my request, `
    + `including with an automated dialing system and an artificial or AI voice, and with automated texts. `
    + `I understand this consent is not a condition of any purchase, that message and data rates may apply, `
    + `and that I can withdraw it at any time by saying "stop calling" on a call, replying STOP to a text, or asking the business to stop.`;
}

/** Only a real, affirmative, evidenced tick counts. */
function consentValid(rec) {
  return !!(rec && rec.consent === true && String(rec.phone || '').trim() && String(rec.consentText || '').trim() && rec.consentAt);
}

/**
 * May we place an AI call to this record? Deliberately strict: this gate is
 * what keeps the product on the right side of the TCPA, so it fails closed on
 * anything it does not recognise.
 */
function callbackAllowed(rec, { missedCallEnabled = false } = {}) {
  if (!rec) return { ok: false, reason: 'No request.' };
  if (rec.optedOut) return { ok: false, reason: 'They asked us not to call.' };
  if (rec.source === 'form') {
    if (!consentValid(rec)) return { ok: false, reason: 'No consent recorded on this request — the AI will not call without it.' };
    return { ok: true, basis: 'prior express written consent (web form)' };
  }
  if (rec.source === 'missed-call') {
    if (!missedCallEnabled) return { ok: false, reason: 'Missed-call call-backs are switched off for this account.' };
    return { ok: true, basis: 'they called the business first' };
  }
  if (rec.source === 'owner') return { ok: true, basis: 'business-initiated, about their own enquiry' };
  return { ok: false, reason: `Unknown request source "${rec.source}" — refusing to call.` };
}

// Quiet hours. Federal law is 8am-9pm in the CALLED party's local time. We
// usually know the business's zone, not the caller's, so we use the business's
// as the closest honest proxy AND stop an hour early at 8pm -- narrower than
// the federal window and inside the stricter state rules (Florida's 8am-8pm).
const EARLIEST_HOUR = Number(process.env.CALLBACK_EARLIEST || 8);
const LATEST_HOUR = Number(process.env.CALLBACK_LATEST || 20);
function localHour(tz, now = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', hour: 'numeric', hour12: false }).format(now));
  } catch { return now.getHours(); }
}
function withinCallingHours(tz, now = new Date()) {
  const hour = localHour(tz, now);
  if (hour >= EARLIEST_HOUR && hour < LATEST_HOUR) return { ok: true, hour };
  return { ok: false, hour, reason: `It's ${hour}:00 where the business is. Call-backs go out between ${EARLIEST_HOUR}am and ${LATEST_HOUR - 12}pm; this one is queued for the morning.` };
}
/** The next moment inside calling hours, as an ISO string. */
function nextCallingWindow(tz, now = new Date()) {
  const hour = localHour(tz, now);
  const d = new Date(now);
  // Find the next local 8am by stepping the clock forward hour by hour — DST-
  // safe because localHour is re-read from Intl each time.
  if (hour >= EARLIEST_HOUR && hour < LATEST_HOUR) return d.toISOString();
  for (let i = 0; i < 30; i++) {
    d.setTime(d.getTime() + 3600000);
    if (localHour(tz, d) === EARLIEST_HOUR) { d.setMinutes(5, 0, 0); return d.toISOString(); }
  }
  return d.toISOString();
}

// One call-back per number per day, whatever the source. A person who
// submits the form three times gets one call, not three.
function calledToday(accountId, phoneKey) {
  const day = new Date().toISOString().slice(0, 10);
  return db.getCallbacks(accountId, 500).some((c) => c.phoneKey === phoneKey && String(c.calledAt || '').slice(0, 10) === day);
}

/** A per-account public slug for the hosted form. Minted once, never rotated automatically. */
function ensureFormSlug(account) {
  if (account.formSlug) return account.formSlug;
  const slug = crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toLowerCase() || db.uid();
  db.updateAccount(account.id, { formSlug: slug });
  return slug;
}
function accountByFormSlug(slug) {
  const s = String(slug || '').toLowerCase();
  if (!s) return null;
  return db.allAccounts().find((a) => a.formSlug === s) || null;
}

module.exports = {
  consentText, consentValid, callbackAllowed, withinCallingHours, nextCallingWindow, calledToday,
  ensureFormSlug, accountByFormSlug, EARLIEST_HOUR, LATEST_HOUR,
};
