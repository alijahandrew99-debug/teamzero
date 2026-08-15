// Stripe billing via REST (no SDK dependency). Creates Checkout sessions and
// verifies webhooks with crypto. All optional: if STRIPE_SECRET_KEY is unset,
// billing is considered "not configured" and access is governed by DEV_UNLOCK.
require('./env');
const crypto = require('crypto');
const db = require('./db');
const plans = require('./plans');

// Billing is configured when we have the secret key AND at least one price to
// sell. STRIPE_PRICE_ID is the legacy single-price variable from before tiers —
// still honoured, but any tier price is enough. (Requiring the legacy var was a
// bug: it reported "billing not configured" on a correctly-configured server.)
function configured() {
  if (!process.env.STRIPE_SECRET_KEY) return false;
  if (process.env.STRIPE_PRICE_ID) return true;
  return plans.tierList().some((t) => !!plans.priceIdForTier(t.id));
}

/** Which billing env vars are present? Names only — never values. */
function configReport() {
  const tiers = plans.tierList().map((t) => ({ tier: t.id, env: t.priceEnvKey, set: !!plans.priceIdForTier(t.id) }));
  return {
    secretKey: !!process.env.STRIPE_SECRET_KEY,
    webhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    publicUrl: process.env.PUBLIC_URL || '',
    legacyPriceId: !!process.env.STRIPE_PRICE_ID,
    tiers,
    sellable: tiers.filter((t) => t.set).map((t) => t.tier),
    ready: configured(),
  };
}

// Owner / comped accounts that use the product free (the creator, demo accounts,
// friends). Set OWNER_EMAILS in .env as a comma-separated list. These bypass
// billing while everyone else must subscribe.
function isOwner(account) {
  if (!account) return false;
  const list = (process.env.OWNER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes((account.email || '').toLowerCase());
}

// Is this a paying (or comped) account?
function isPaid(account) {
  if (!account) return false;
  if (isOwner(account)) return true;
  if (process.env.DEV_UNLOCK === '1') return true;
  return ['active', 'trialing'].includes(account.subStatus);
}

// Can this account USE the product right now?
// Deliberately NOT "are they paying" — a new user must be able to experience real
// value on the free trial before we ask for money. The paywall lands when their
// free leads run out, not at the door.
// Two DIFFERENT questions, deliberately separated:
//   isPaid   — are they entitled to use the product at all?
//   hasAccess— may they spend AI money right now (entitled AND units left)?
// Collapsing them meant a paid account's lead cap was only ever enforced in the
// one route that checked usage by hand; everywhere else was unlimited.
// hasAccess = may they USE the product (log in, approve, send, settings).
// canSpend  = may they trigger NEW AI work (prospecting, drafting).
// Conflating them locked a paying customer out of sending and settings the
// moment they hit their lead cap — they had already paid for those leads.
function hasAccess(account) {
  if (!account) return false;
  if (isOwner(account)) return true;
  if (process.env.DEV_UNLOCK === '1') return true;
  if (isPaid(account)) return true;                       // paid = full use of the app
  return plans.usage(account, false).remaining > 0;       // unpaid needs trial units
}
function canSpend(account) {
  if (!account) return false;
  if (isOwner(account) || process.env.DEV_UNLOCK === '1') return true;
  if (!isPaid(account)) return plans.usage(account, false).remaining > 0;
  return plans.usage(account, false).remaining > 0;       // paid, but capped
}

async function stripePost(pathname, params) {
  const body = new URLSearchParams();
  const add = (k, v) => body.append(k, v);
  (function flatten(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key);
      else if (Array.isArray(v)) v.forEach((item, i) => flatten({ [i]: item }, key));
      else add(key, v);
    }
  })(params, '');
  const r = await fetch(`https://api.stripe.com/v1/${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${data.error && data.error.message}`);
  return data;
}

async function createCheckout(account, tierId = 'starter') {
  const base = process.env.PUBLIC_URL || 'http://localhost:8090';
  const price = plans.priceIdForTier(tierId) || process.env.STRIPE_PRICE_ID;
  if (!price) throw new Error('That plan is not set up for payment yet.');
  const session = await stripePost('checkout/sessions', {
    mode: 'subscription',
    'line_items': [{ price, quantity: 1 }],
    success_url: `${base}/app?checkout=success`,
    cancel_url: `${base}/app?checkout=cancel`,
    client_reference_id: account.id,
    // Reuse the known customer so a plan change can't spawn a second customer
    // record (and a second card on file) for the same person.
    ...(account.stripeCustomerId ? { customer: account.stripeCustomerId } : { customer_email: account.email }),
    allow_promotion_codes: true,
    metadata: { tier: tierId },
    subscription_data: { metadata: { tier: tierId, account: account.id } },
  });
  return session.url;
}

/**
 * Existing subscribers must NEVER be sent back through Checkout — that starts a
 * SECOND subscription and bills them twice while the first keeps running. The
 * billing portal changes the plan they already have, and handles cancellation.
 */
async function createPortal(account) {
  if (!account.stripeCustomerId) throw new Error('No subscription to manage yet.');
  const base = process.env.PUBLIC_URL || 'http://localhost:8090';
  const session = await stripePost('billing_portal/sessions', {
    customer: account.stripeCustomerId,
    return_url: `${base}/app`,
  });
  return session.url;
}

// Verify the Stripe-Signature header against the raw body.
function verifyWebhook(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return null;
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const signed = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (!parts.v1 || parts.v1.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

// Apply a webhook event to account state.
function applyEvent(event) {
  if (!event || !event.type) return;
  const o = event.data && event.data.object;
  if (event.type === 'checkout.session.completed') {
    const acc = db.getAccount(o.client_reference_id);
    const tier = (o.metadata && o.metadata.tier) || 'starter';
    if (acc) db.updateAccount(acc.id, { stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription || null,
      subStatus: 'active', plan: 'pro', tier });
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const acc = db.accountByStripeCustomer(o.customer);
    if (acc) {
      const status = event.type.endsWith('deleted') ? 'canceled' : o.status;
      // Keep tier in sync on plan change (subscription metadata or price lookup).
      const patch = { subStatus: status };
      // The PRICE is the truth. Subscription metadata is written at creation and
      // goes stale on a plan change, so trusting it first let a downgrade keep
      // the higher tier's allowance forever.
      const fromPrice = o.items && o.items.data && o.items.data[0]
        && plans.tierForPriceId(o.items.data[0].price && o.items.data[0].price.id);
      const t = fromPrice || (o.metadata && o.metadata.tier);
      if (t) patch.tier = t;
      if (o.id) patch.stripeSubscriptionId = o.id;
      db.updateAccount(acc.id, patch);
    }
  }
}

module.exports = { configured, configReport, hasAccess, canSpend, createPortal, isPaid, isOwner, createCheckout, verifyWebhook, applyEvent };
