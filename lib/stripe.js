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
  const disc = plans.discoveredPrices();
  const tiers = plans.tierList().map((t) => ({ tier: t.id, env: t.priceEnvKey, envSet: !!process.env[t.priceEnvKey], discovered: disc[t.id] || '', set: !!plans.priceIdForTier(t.id) }));
  return {
    secretKey: !!process.env.STRIPE_SECRET_KEY,
    liveKey: /^sk_live_/.test(process.env.STRIPE_SECRET_KEY || ''),
    pricesDiscoveredAt: disc.at ? new Date(disc.at).toISOString() : '',
    // What each tier will actually charge, versus what the site displays.
    charging: plans.chargedAmounts(),
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

// Stripe's dunning runs for ~3 weeks and most declines are recovered on a later
// retry, so past_due does NOT mean "former customer" — it means "customer whose
// card bounced this morning". Treating it as cancelled cut off the phone line
// and the whole app instantly, which is both wrong and the surest way to make a
// recoverable decline into a real cancellation.
const DUNNING = ['past_due', 'unpaid'];
// Which tiers get a free trial, and how long. Voice tiers only: they are the
// $399 blind purchase; the email tiers are cheap enough to just buy.
// EVERY plan gets the 7-day trial now, not just the voice ones. The cheap
// "just try it" tier is gone, so the trial IS the way in — and a rep selling
// on commission needs "seven days free, cancel in one click" as the ask, not
// "put $399 down today".
const TRIAL_TIERS = new Set(plans.TIER_ORDER || ['frontdesk', 'starter', 'growth', 'scale', 'complete']);
const TRIAL_DAYS = 7;
const GRACE_DAYS = 14;

/** In dunning, and still inside the window where we keep serving them. */
function inGrace(account) {
  if (!account || !DUNNING.includes(account.subStatus)) return false;
  const since = Date.parse(account.dunningSince || '') || 0;
  if (!since) return true;                     // no stamp yet — be generous
  return Date.now() - since < GRACE_DAYS * 24 * 60 * 60 * 1000;
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
  // A bounced card keeps full use during the retry window: their phone must
  // keep being answered and the emails they already paid to have written must
  // still be sendable while Stripe retries.
  if (inGrace(account)) return true;
  return plans.usage(account, false).remaining > 0;       // unpaid needs trial units
}
function canSpend(account) {
  if (!account) return false;
  if (isOwner(account) || process.env.DEV_UNLOCK === '1') return true;
  // Grace covers using what they have bought, not billing us for NEW AI work
  // on a card that is currently declining.
  if (!isPaid(account)) return plans.usage(account, false).remaining > 0;
  return plans.usage(account, false).remaining > 0;       // paid, but capped
}

/**
 * Confirm a Checkout session straight from Stripe and switch the account on.
 * The webhook stays the primary path; this is the safety net for when it is
 * late, misconfigured, or its signing secret is wrong — cases where the card
 * was charged and the customer was left locked out with no way to recover.
 * Returns true if the account is now active.
 */
/** Already-active check used when a session id is replayed. */
function stripe_isActiveNow(account) {
  const fresh = db.getAccount(account.id) || account;
  return ['active', 'trialing'].includes(fresh.subStatus);
}
async function reconcileCheckout(account, sessionId) {
  if (!account || !sessionId || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;
  let s;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    s = await r.json().catch(() => null);
    if (!r.ok || !s) return false;
  } catch { return false; }
  // A Checkout session stays retrievable by id forever, so none of this may
  // rest on the session alone or the success URL becomes a permanent free
  // -access token: cancel, reopen the old link, get your paid tier back.
  // A 100%-off coupon or a trial produces 'no_payment_required', not 'paid' —
  // and createCheckout enables promotion codes for everyone, so rejecting it
  // locked out exactly the people a launch discount brings in. Safe to widen:
  // entitlement below comes from re-reading the live SUBSCRIPTION, not from
  // this field.
  if (!['paid', 'no_payment_required'].includes(s.payment_status)) return false;
  // Ownership is required, not merely checked when present. A session created
  // outside createCheckout (payment link, dashboard) has no client_reference_id
  // and would otherwise activate whoever presented its id — and stamp its
  // customer onto their account, misrouting that customer's future webhooks.
  if (s.client_reference_id !== account.id) return false;
  // Same session cannot be redeemed twice.
  if (account.reconciledSession === sessionId) return stripe_isActiveNow(account);
  // The session is history; entitlement is the live subscription. Confirm the
  // subscription it created is STILL active before unlocking anything.
  if (!s.subscription) return false;
  let sub;
  try {
    const r2 = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(s.subscription)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    sub = await r2.json().catch(() => null);
    if (!r2.ok || !sub) return false;
  } catch { return false; }
  if (!['active', 'trialing'].includes(sub.status)) return false;

  const fromPrice = sub.items && sub.items.data && sub.items.data[0]
    && plans.tierForPriceId(sub.items.data[0].price && sub.items.data[0].price.id);
  const tier = fromPrice || (s.metadata && s.metadata.tier) || account.tier || 'starter';
  db.updateAccount(account.id, {
    stripeCustomerId: s.customer || account.stripeCustomerId,
    stripeSubscriptionId: s.subscription,
    subStatus: sub.status, plan: 'pro', tier, dunningSince: '',
    reconciledSession: sessionId,
  });
  // The typed referral code rides on the session; the webhook may never come,
  // so the reconcile path attributes too. Idempotent: an attributed account
  // is left alone.
  attributeFromSession(db.getAccount(account.id) || account, s).catch((e) => console.error('reconcile attribution failed:', e.message));
  db.logActivity(account.id, { agent: 'SYSTEM', msg: 'Activated by confirming the checkout session directly (webhook did not arrive in time)' });
  return true;
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

/**
 * Owner action: create a Stripe price for every tier that does not have one
 * yet, tagged exactly the way discovery expects (metadata.tier + amount).
 * Never touches an existing price. Returns what it made.
 */
async function createMissingPrices() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set.');
  await plans.discoverPrices();
  const created = [], skipped = [];
  for (const t of plans.tierList()) {
    if (plans.priceIsCurrent(t.id)) { skipped.push(t.id); continue; }
    const allowance = [t.voiceMinutes ? `${t.voiceMinutes.toLocaleString()} phone minutes` : '', t.leads ? `${t.leads.toLocaleString()} leads` : ''].filter(Boolean).join(' + ');
    const price = await stripePost('prices', {
      currency: 'usd', unit_amount: t.price * 100, recurring: { interval: 'month' },
      nickname: `Dawnpipe ${t.name} — ${allowance}/mo`,
      metadata: { tier: t.id },
      product_data: { name: `Dawnpipe ${t.name}`, metadata: { tier: t.id } },
    });
    created.push({ tier: t.id, priceId: price.id, livemode: !!price.livemode });
  }
  await plans.discoverPrices();
  return { created, skipped, live: /^sk_live_/.test(process.env.STRIPE_SECRET_KEY) };
}

/**
 * A customer typed a referral code into the Stripe page. Attribute the account
 * (first touch wins -- an already-attributed account is left alone) and stamp
 * rep_code onto the Stripe subscription so the owner sees it in Stripe as
 * well as in the app.
 */
async function attributeFromSession(account, session) {
  const reps = require('./reps');
  const field = (session.custom_fields || []).find((f) => f.key === 'referral');
  const typed = field && field.text && field.text.value ? reps.normaliseCode(field.text.value) : '';
  let code = account.repCode || '';
  if (!code && typed) {
    const r = reps.attribute(account, typed, { source: 'checkout' });
    if (r.ok) code = r.rep.code;
    else db.logActivity(account.id, { agent: 'SYSTEM', msg: `Referral code "${typed}" typed at checkout was not recognised — no rep attributed` });
  }
  if (code && session.subscription) {
    try { await stripePost(`subscriptions/${session.subscription}`, { metadata: { rep_code: code, account: account.id } }); }
    catch (e) { console.error('could not stamp rep_code on subscription:', e.message); }
  }
}

/**
 * Back-pay a rep for invoices Stripe already collected before the account was
 * attributed to them — the phone-close case, where the customer paid first and
 * the owner assigned the rep afterwards. Reads the customer's PAID invoices
 * from Stripe and posts each through recordCollection, which is idempotent on
 * invoice id, so running this twice cannot pay twice.
 */
async function backfillCommissions(account) {
  const reps = require('./reps');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !account || !account.repId || !account.stripeCustomerId) return { posted: 0, invoices: 0, skipped: 'no stripe customer or no rep' };
  const r = await fetch(`https://api.stripe.com/v1/invoices?customer=${encodeURIComponent(account.stripeCustomerId)}&status=paid&limit=100`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || `Stripe ${r.status}`);
  let posted = 0;
  const invoices = (data.data || []).sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const inv of invoices) {
    const net = Math.max(0, Number(inv.amount_paid || 0) - Number(inv.tax || 0));
    if (!net) continue;
    const line = (inv.lines && inv.lines.data && inv.lines.data[0]) || {};
    const res = reps.recordCollection({ account, invoiceId: inv.id, amountCents: net,
      periodStart: line.period && line.period.start ? new Date(line.period.start * 1000).toISOString() : '',
      periodEnd: line.period && line.period.end ? new Date(line.period.end * 1000).toISOString() : '',
      description: (inv.number || '') + ' (back-paid)' });
    if (res && res.rows && res.rows.length) posted++;
  }
  return { posted, invoices: invoices.length };
}

async function createCheckout(account, tierId = 'starter') {
  const base = process.env.PUBLIC_URL || 'http://localhost:8090';
  // The site shows the price the owner set. This is where that promise is
  // kept: if Stripe does not yet have a price at that exact amount, create it
  // NOW, before the customer sees a pay button. A price change is then one
  // edit in plans.js -- no dashboard step, no env var, nothing to forget.
  if (!plans.priceIsCurrent(tierId) && process.env.STRIPE_SECRET_KEY) {
    try { await createMissingPrices(); }
    catch (e) { console.error(`could not create the ${tierId} price on demand:`, e.message); }
  }
  const price = plans.priceIdForTier(tierId) || process.env.STRIPE_PRICE_ID;
  if (!price) throw new Error('That plan is not set up for payment yet.');
  if (!plans.priceIsCurrent(tierId)) {
    // Loud, because this is the one state we never want to be in silently:
    // the page said one number and the card is about to be charged another.
    console.error(`PRICE MISMATCH at checkout: ${tierId} displays $${(plans.TIERS[tierId] || {}).price} but price ${price} will be charged`);
  }
  const tier = plans.TIERS[tierId] || {};
  // The Stripe account is shared with another product, and its dashboard
  // branding says "WLTH". A buyer who has just read a Dawnpipe pricing card
  // and lands on a payment page titled WLTH thinks they have been redirected
  // to a scam -- on the very last screen. Brand the session itself, and put
  // the promise ("nothing charged until day 8", "cancel in one click") right
  // under the pay button where the doubt actually lives.
  const trial = TRIAL_TIERS.has(tierId);
  const submitMsg = trial
    ? `7-day free trial on ${tier.name || 'this plan'}: nothing is charged today. Your first payment of $${tier.price} is on day 8, and you can cancel in one click before then and pay nothing. Month to month after that; no contract, no setup fee, no overage charges.`
    : `${tier.name || 'This plan'} is month to month: cancel in one click any time, no contract, no setup fee, no overage charges. Questions? support@dawnpipe.com`;
  const branded = {
    branding_settings: { display_name: 'Dawnpipe', button_color: '#c02a1b', background_color: '#fbfaf6', border_style: 'rounded' },
    custom_text: { submit: { message: submitMsg.slice(0, 1200) } },
  };
  const paramsFor = (extra) => ({
    mode: 'subscription',
    'line_items': [{ price, quantity: 1 }],
    // 7-day trial on the voice tiers, CARD REQUIRED. Every competitor a plumber
    // compares us to offers a trial; asking $399 up front from someone who has
    // never heard of us, with no trial and no refund, was the single biggest
    // conversion wall the investor audit found. Card-on-file (Stripe's default
    // when trial_period_days is set) deters signing up just to rent a Twilio
    // number for free, and the trial minute cap in plans.js bounds the spend.
    ...(TRIAL_TIERS.has(tierId) ? { subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { tier: tierId, account: account.id, ...(account.repCode ? { rep_code: account.repCode } : {}) } } } : {}),
    // Carry the session id back so /app can confirm payment directly with
    // Stripe. The webhook was previously the ONLY path to activation, so a
    // missing or misconfigured signing secret meant a charged customer sat
    // locked out forever with no way to self-heal.
    success_url: `${base}/app?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/app?checkout=cancel`,
    client_reference_id: account.id,
    // Reuse the known customer so a plan change can't spawn a second customer
    // record (and a second card on file) for the same person.
    ...(account.stripeCustomerId ? { customer: account.stripeCustomerId } : { customer_email: account.email }),
    allow_promotion_codes: true,
    metadata: { tier: tierId, ...(account.repCode ? { rep_code: account.repCode } : {}) },
    ...(TRIAL_TIERS.has(tierId) ? {} : { subscription_data: { metadata: { tier: tierId, account: account.id, ...(account.repCode ? { rep_code: account.repCode } : {}) } } }),
    // A "Referral code" box ON THE STRIPE PAGE. A customer who heard "use code
    // SKINNER" from a rep types it here, it lands on the Checkout Session in
    // Stripe, and the webhook attributes the account. Two capture paths (link
    // and typed code) mean a rep gets paid whether the customer clicked their
    // link or just remembered their name. Only shown when the account is not
    // already attributed -- once a rep owns an account, nothing can move it.
    ...(account.repId ? {} : { custom_fields: [{ key: 'referral', label: { type: 'custom', custom: 'Referral code (optional)' }, type: 'text', optional: true }] }),
    ...extra,
  });
  let session;
  try { session = await stripePost('checkout/sessions', paramsFor(branded)); }
  catch (e) {
    // Branding is a nicety; the sale is not. If this Stripe API version
    // rejects the branding parameters, fall back to a plain session rather
    // than turning a cosmetic problem into a lost customer.
    if (!/branding_settings|custom_text|unknown parameter/i.test(e.message)) throw e;
    console.error('checkout branding rejected, retrying plain:', e.message);
    session = await stripePost('checkout/sessions', paramsFor({}));
  }
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

  // ---- rep commission, from money Stripe ACTUALLY MOVED ----
  // Deliberately driven by invoices and refunds rather than subscription
  // status. A subscription can be "active" all through a 7-day trial while
  // nothing has been collected; paying commission on that would pay a rep for
  // a customer who cancels on day 6. amount_paid is the truth, and it is also
  // what makes upgrades, downgrades, discounts and partial refunds all work
  // with no special cases.
  try {
    const reps = require('./reps');
    if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.paid') {
      const acct = db.accountByStripeCustomer(o.customer);
      if (acct && acct.repId) {
        // Net of tax: a rep is paid on revenue, not on money we collect and
        // hand straight to a state.
        const tax = Number(o.tax || 0) || 0;
        const net = Math.max(0, Number(o.amount_paid || 0) - tax);
        const line = (o.lines && o.lines.data && o.lines.data[0]) || {};
        const r = reps.recordCollection({ account: acct, invoiceId: o.id, amountCents: net,
          periodStart: line.period && line.period.start ? new Date(line.period.start * 1000).toISOString() : '',
          periodEnd: line.period && line.period.end ? new Date(line.period.end * 1000).toISOString() : '',
          description: o.number || '' });
        if (r && r.rows) {
          const rec = r.rows.find((x) => x.kind === 'recurring');
          if (rec) db.logActivity(acct.id, { agent: 'SYSTEM', msg: `Commission ${reps.usd(rec.amountCents)} accrued to ${acct.repCode} on invoice ${o.id}` });
        }
      }
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const acct = db.accountByStripeCustomer(o.customer);
      if (acct && acct.repId) {
        const amount = Number(o.amount_refunded || o.amount || 0);
        reps.recordReversal({ account: acct, stripeId: o.invoice || o.id, amountCents: amount,
          reason: event.type === 'charge.refunded' ? 'refund' : 'chargeback' });
        db.logActivity(acct.id, { agent: 'SYSTEM', msg: `Commission reversed on ${acct.repCode} — ${event.type}` });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const acct = db.accountByStripeCustomer(o.customer);
      if (acct && acct.repId) db.logActivity(acct.id, { agent: 'SYSTEM', msg: `Account cancelled — no further commission accrues to ${acct.repCode}` });
    }
  } catch (e) { console.error('commission posting failed:', e.message); }

  if (event.type === 'checkout.session.completed') {
    const acc = db.getAccount(o.client_reference_id);
    const tier = (o.metadata && o.metadata.tier) || 'starter';
    if (acc) db.updateAccount(acc.id, { stripeCustomerId: o.customer, stripeSubscriptionId: o.subscription || null,
      subStatus: 'active', plan: 'pro', tier });
    if (acc) attributeFromSession(acc, o).catch((e) => console.error('checkout attribution failed:', e.message));
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const acc = db.accountByStripeCustomer(o.customer);
    if (acc) {
      // One Stripe customer can own several subscription objects. If an old
      // one finally dies while a NEWER one is live and being charged, its
      // deleted event must not cancel the account — that locked out someone
      // whose card was successfully billing that morning.
      const current = acc.stripeSubscriptionId;
      if (current && o.id && o.id !== current) {
        const downgrade = event.type.endsWith('deleted') || !['active', 'trialing'].includes(o.status);
        if (downgrade) {
          db.logActivity(acc.id, { agent: 'SYSTEM', msg: `Ignored ${event.type} for old subscription ${o.id} (current: ${current})` });
          return;
        }
      }
      const status = event.type.endsWith('deleted') ? 'canceled' : o.status;
      // Keep tier in sync on plan change (subscription metadata or price lookup).
      const patch = { subStatus: status };
      // Distinguishes a customer who converted (keep their number 21 days on
      // cancel) from a trial that lapsed (release it in 2). Set once, on the
      // first genuinely-paid status; never unset.
      if (status === 'active' && !acc.everPaid) patch.everPaid = true;
      // The PRICE is the truth. Subscription metadata is written at creation and
      // goes stale on a plan change, so trusting it first let a downgrade keep
      // the higher tier's allowance forever.
      const fromPrice = o.items && o.items.data && o.items.data[0]
        && plans.tierForPriceId(o.items.data[0].price && o.items.data[0].price.id);
      const t = fromPrice || (o.metadata && o.metadata.tier);
      if (t) patch.tier = t;
      if (o.id) patch.stripeSubscriptionId = o.id;
      // Stamp when dunning started so the grace window is measured from the
      // first failure rather than restarting on every retry webhook.
      if (DUNNING.includes(status)) {
        if (!DUNNING.includes(acc.subStatus) || !acc.dunningSince) patch.dunningSince = new Date().toISOString();
      } else {
        patch.dunningSince = '';
      }
      // Stamp when they actually cancelled so the number-reclaim sweep has a
      // clock to work from, and clear it if they come back.
      if (status === 'canceled' || status === 'incomplete_expired') {
        if (!acc.canceledAt) patch.canceledAt = new Date().toISOString();
      } else if (acc.canceledAt) {
        patch.canceledAt = '';
      }
      db.updateAccount(acc.id, patch);
    }
  }
}

module.exports = { configured, configReport, hasAccess, canSpend, createPortal, isPaid, isOwner, createCheckout, createMissingPrices, backfillCommissions, verifyWebhook, applyEvent, inGrace, reconcileCheckout, DUNNING };
