// Stripe billing via REST (no SDK dependency). Creates Checkout sessions and
// verifies webhooks with crypto. All optional: if STRIPE_SECRET_KEY is unset,
// billing is considered "not configured" and access is governed by DEV_UNLOCK.
require('./env');
const crypto = require('crypto');
const db = require('./db');
const plans = require('./plans');

function configured() { return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID; }

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
function hasAccess(account) {
  if (!account) return false;
  if (isPaid(account)) return true;
  return plans.usage(account, isOwner(account)).remaining > 0;
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

async function createCheckout(account) {
  const base = process.env.PUBLIC_URL || 'http://localhost:8090';
  const session = await stripePost('checkout/sessions', {
    mode: 'subscription',
    'line_items': [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${base}/app?checkout=success`,
    cancel_url: `${base}/app?checkout=cancel`,
    client_reference_id: account.id,
    customer_email: account.email,
    allow_promotion_codes: true,
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
    if (acc) db.updateAccount(acc.id, { stripeCustomerId: o.customer, subStatus: 'active', plan: 'pro' });
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const acc = db.accountByStripeCustomer(o.customer);
    if (acc) {
      const status = event.type.endsWith('deleted') ? 'canceled' : o.status;
      db.updateAccount(acc.id, { subStatus: status });
    }
  }
}

module.exports = { configured, hasAccess, isPaid, isOwner, createCheckout, verifyWebhook, applyEvent };
