// Suppression list — the single source of truth for "never email this address".
//
// Enforced at SEND time, not in the UI, so nothing can route around it: an
// unsubscribe, a hard bounce, or a manual block means that address is done,
// permanently, across every profile in the account.
//
// Why this is the highest-value deliverability feature: mailbox providers score
// you on complaints and bounces. One repeat send to someone who unsubscribed can
// trigger a spam complaint, and complaints are the fastest way to get an entire
// domain filtered. Suppression is also a legal requirement (CAN-SPAM: honour
// opt-outs within 10 business days; GDPR/PECR: immediately).
require('./env');
const crypto = require('crypto');
const db = require('./db');

const REASONS = {
  unsubscribe: 'They asked to stop',
  bounce: 'Hard bounce — the address does not exist',
  complaint: 'Marked as spam',
  manual: 'You blocked this address',
};

function norm(email) { return (email || '').trim().toLowerCase(); }
function domainOf(email) { const e = norm(email); const i = e.lastIndexOf('@'); return i === -1 ? '' : e.slice(i + 1); }

/**
 * Unsubscribe token: HMAC over accountId+email so the link can't be guessed or
 * enumerated, and needs no database lookup to validate. Deterministic, so the
 * same recipient always gets the same link.
 */
function tokenFor(accountId, email) {
  const secret = process.env.SESSION_SECRET || 'dev-insecure-secret';
  const mac = crypto.createHmac('sha256', secret).update(`${accountId}|${norm(email)}`).digest('hex').slice(0, 24);
  return Buffer.from(`${accountId}|${norm(email)}|${mac}`).toString('base64url');
}
function parseToken(token) {
  try {
    const [accountId, email, mac] = Buffer.from(String(token), 'base64url').toString('utf8').split('|');
    if (!accountId || !email || !mac) return null;
    const secret = process.env.SESSION_SECRET || 'dev-insecure-secret';
    const good = crypto.createHmac('sha256', secret).update(`${accountId}|${email}`).digest('hex').slice(0, 24);
    if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
    return { accountId, email };
  } catch { return null; }
}

/** Is this address suppressed for this account? Also blocks the whole domain if the domain was suppressed. */
function isSuppressed(accountId, email) {
  const e = norm(email);
  if (!e) return { blocked: true, reason: 'manual', note: 'no address' };
  const list = db.getSuppression(accountId);
  const hit = list.find((s) => s.email === e);
  if (hit) return { blocked: true, reason: hit.reason, at: hit.at, note: REASONS[hit.reason] || hit.reason };
  const dom = domainOf(e);
  const domHit = list.find((s) => s.domain === dom && s.wholeDomain);
  if (domHit) return { blocked: true, reason: domHit.reason, at: domHit.at, note: `Whole domain suppressed (${dom})` };
  return { blocked: false };
}

/** Add an address (or a whole domain) to the list. Idempotent. */
function suppress(accountId, email, reason = 'manual', { wholeDomain = false, note = '' } = {}) {
  const e = norm(email);
  if (!e) return null;
  return db.addSuppression(accountId, {
    email: e, domain: domainOf(e), wholeDomain: !!wholeDomain,
    reason: REASONS[reason] ? reason : 'manual', note,
  });
}

function unsuppress(accountId, email) { return db.removeSuppression(accountId, norm(email)); }

/**
 * Classify an SMTP failure. Hard bounces (5xx: no such user) mean the address is
 * dead — suppress it forever. Soft failures (4xx: mailbox full, greylisted) are
 * temporary and must NOT be suppressed.
 */
function isHardBounce(errMessage) {
  const m = String(errMessage || '');
  if (/\b4\d\d\b/.test(m) && !/\b5\d\d\b/.test(m)) return false;      // explicit 4xx = soft
  // 5xx codes that mean "this mailbox will never exist". Deliberately NARROW:
  // an earlier version had an empty alternative in the group, so it matched a
  // bare "5" and permanently suppressed every recipient on any error text
  // containing a stray 5 — including auth failures, which fail once per item.
  // Authentication/policy problems are OUR fault, never the recipient's.
  if (/\b(535|534|530|538)\b|authentication|auth failed|username and password|invalid credentials|not authenticated/i.test(m)) return false;
  if (/\b(550|551|553|560)\b/.test(m)) return true;
  return /user unknown|no such user|does not exist|address rejected|recipient rejected|invalid recipient|mailbox unavailable|account (has been )?disabled|unrouteable address|no mailbox/i.test(m);
}

module.exports = { isSuppressed, suppress, unsuppress, tokenFor, parseToken, isHardBounce, REASONS, norm, domainOf };
