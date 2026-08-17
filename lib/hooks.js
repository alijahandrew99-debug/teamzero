// Outbound webhooks. When something happens on the account -- a call ends, a
// job is booked, a lead is captured -- POST a signed JSON event to the URL(s)
// the customer configured. This is how a shop gets bookings into Housecall Pro,
// Jobber, HubSpot or a Google Sheet through Zapier/Make without us building
// each integration, and it is what makes Dawnpipe pluggable rather than a
// walled garden. Every competitor with a Zapier story is doing exactly this.
//
// Signed with HMAC-SHA256 over the raw body using the account's webhook
// secret, in the same shape Stripe uses (t=<unix>,v1=<hex>), so any receiver
// that already verifies Stripe-style signatures can verify ours.
const crypto = require('crypto');
const db = require('./db');

const EVENTS = ['call.completed', 'booking.created', 'lead.captured', 'emergency.escalated'];

function sign(secret, ts, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

/** Ensure the account has a webhook secret and (optionally) an API key. */
function ensureSecrets(account) {
  const patch = {};
  if (!account.webhookSecret) patch.webhookSecret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  if (!account.apiKey) patch.apiKey = 'dp_live_' + crypto.randomBytes(24).toString('hex');
  if (Object.keys(patch).length) { db.updateAccount(account.id, patch); return { ...account, ...patch }; }
  return account;
}

/**
 * Fire an event to every configured URL. Fire-and-forget: never blocks the
 * caller, never throws. Failures are logged so the owner can see them.
 */
function emit(account, type, data) {
  try {
    if (!EVENTS.includes(type)) return;
    const urls = Array.isArray(account.webhookUrls) ? account.webhookUrls.filter((u) => /^https:\/\//.test(u)) : [];
    if (!urls.length) return;
    const acc = ensureSecrets(account);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(8).toString('hex'), type, created: ts, account: acc.id, data });
    const sig = `t=${ts},v1=${sign(acc.webhookSecret, ts, body)}`;
    for (const url of urls) {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Dawnpipe-Signature': sig, 'Dawnpipe-Event': type, 'User-Agent': 'Dawnpipe-Webhooks/1.0' },
        body,
        signal: AbortSignal.timeout(8000),
      }).then((r) => {
        if (!r.ok) db.logActivity(acc.id, { agent: 'SYSTEM', msg: `Webhook ${type} → ${url} returned ${r.status}` });
      }).catch((e) => db.logActivity(acc.id, { agent: 'SYSTEM', msg: `Webhook ${type} → ${url} failed: ${e.message}` }));
    }
  } catch { /* never let a webhook break the thing that triggered it */ }
}

/** Verify a signature the way a receiver would (exported for tests). */
function verify(secret, header, body, toleranceSec = 300) {
  try {
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
    const ts = Number(parts.t);
    if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
    const expected = sign(secret, ts, body);
    const a = Buffer.from(expected), b = Buffer.from(String(parts.v1 || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

module.exports = { emit, ensureSecrets, verify, EVENTS };
