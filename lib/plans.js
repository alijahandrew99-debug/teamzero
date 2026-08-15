// Plans, free trial, and usage quotas.
//
// Pricing is USAGE-TIERED because AI cost scales with lead volume — a flat price
// can't work. Each tier's lead cap bounds worst-case AI spend so margin holds at
// every plan. A new user gets a free trial (real value before paying), then picks
// a tier.
const db = require('./db');

// NO free trial — every lead costs real AI money on the owner's key, so access
// is pay-first. Prospects see the demo video on the landing page instead.
const TRIAL_LEADS = 0;

// The tiers. `leads` is the monthly cap; `priceEnvKey` maps to the Stripe price
// ID env var. Order matters — used for display and downgrade logic.
// `voiceMinutes` bounds phone spend the same way `leads` bounds AI spend — a
// plan with uncapped minutes has no worst case, and call length is the one
// variable the operator does not control.
const TIERS = {
  tester:   { id: 'tester',   name: 'Tester',   price: 49,   leads: 50,   voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_TESTER',
              blurb: 'Kick the tyres on a real list' },
  starter:  { id: 'starter',  name: 'Starter',  price: 99,   leads: 200,  voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_STARTER',
              blurb: 'One person doing outbound' },
  growth:   { id: 'growth',   name: 'Growth',   price: 299,  leads: 750,  voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_GROWTH',
              blurb: '~25 leads a day, on autopilot' },
  scale:    { id: 'scale',    name: 'Scale',    price: 699,  leads: 2000, voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_SCALE',
              blurb: 'Agency-level email volume' },
  // The voice-first tier. A contractor who is losing $8-15k jobs to voicemail
  // will pay a few hundred a month to stop that; they will not pay $1,499. The
  // gap between $99 and $1,499 was the reason the phone product had no buyer.
  frontdesk:{ id: 'frontdesk',name: 'Front Desk',price: 399, leads: 200,  voiceMinutes: 400, priceEnvKey: 'STRIPE_PRICE_FRONTDESK',
              blurb: 'The AI answers every call and books the job' },
  complete: { id: 'complete', name: 'Complete', price: 1499, leads: 2000, voiceMinutes: 1000, priceEnvKey: 'STRIPE_PRICE_COMPLETE',
              blurb: 'Everything, at agency volume' },
};
const TIER_ORDER = ['tester', 'starter', 'frontdesk', 'growth', 'scale', 'complete'];

function tierList() { return TIER_ORDER.map((k) => TIERS[k]); }
/** Cheapest SELLABLE tier — what "plans from $X" should actually say. */
function cheapestTier() {
  const sellable = tierList().filter((t) => !!priceIdForTier(t.id));
  const pool = sellable.length ? sellable : tierList();
  return pool.reduce((a, b) => (b.price < a.price ? b : a));
}
function fromPrice() { return `$${cheapestTier().price}`; }
function priceIdForTier(tierId) {
  const t = TIERS[tierId];
  return t ? (process.env[t.priceEnvKey] || '') : '';
}
// Reverse-map a Stripe price ID back to a tier id (for the webhook).
function tierForPriceId(priceId) {
  for (const k of TIER_ORDER) if (process.env[TIERS[k].priceEnvKey] === priceId) return k;
  return null;
}

function isPro(account) {
  return ['active', 'trialing'].includes(account && account.subStatus);
}
function accountTier(account) {
  const t = account && account.tier;
  return TIERS[t] ? t : 'starter'; // default paid tier if somehow unset
}

function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Current usage + allowance for an account. Owners are unlimited. */
function usage(account, owner = false) {
  if (owner) return { plan: 'owner', tier: null, used: 0, limit: Infinity, remaining: Infinity, unlimited: true, isPro: true };

  const pro = isPro(account);
  const tier = pro ? accountTier(account) : null;
  const limit = pro ? TIERS[tier].leads : TRIAL_LEADS;

  // Paid plans reset monthly; the free trial is a one-time allowance that never resets.
  let used = Number(account.leadsUsed || 0);
  if (pro && account.usagePeriod !== periodKey()) used = 0;

  const vLimit = pro ? (TIERS[tier].voiceMinutes || 0) : 0;
  let vUsed = Number(account.voiceMinutesUsed || 0);
  // Voice has its OWN period marker. Sharing one with leads meant whichever
  // counter was written second at a month boundary stamped the new period and
  // permanently froze the other at last month's total.
  if (pro && account.voicePeriod !== periodKey()) vUsed = 0;

  return {
    plan: pro ? 'pro' : 'trial',
    tier,
    tierName: pro ? TIERS[tier].name : 'Free trial',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unlimited: false,
    isPro: pro,
    voice: { used: vUsed, limit: vLimit, remaining: Math.max(0, vLimit - vUsed), included: vLimit > 0 },
  };
}

/** Record phone minutes against the plan's allowance. */
function consumeVoiceMinutes(account, minutes, owner = false) {
  if (owner || !minutes) return;
  const key = periodKey();
  const rolled = account.voicePeriod !== key;
  const used = (rolled ? 0 : Number(account.voiceMinutesUsed || 0)) + minutes;
  db.updateAccount(account.id, { voiceMinutesUsed: used, voicePeriod: key });
}

/** Is this account allowed to place/answer AI calls right now? */
function voiceAllowed(account, owner = false) {
  if (owner) return { ok: true };
  const u = usage(account, owner);
  if (!u.isPro) return { ok: false, reason: 'Phone calling needs a paid plan.' };
  if (!u.voice.included) return { ok: false, reason: `The ${u.tierName} plan doesn't include phone calls — upgrade to Complete for the AI phone agent.` };
  if (u.voice.remaining <= 0) return { ok: false, reason: `You've used all ${u.voice.limit} phone minutes this month. They reset next month.` };
  return { ok: true, remaining: u.voice.remaining };
}

/** Record leads consumed, rolling the period for paid plans. */
function consume(account, n, owner = false) {
  if (owner || !n) return;
  const pro = isPro(account);
  const key = periodKey();
  const rolled = pro && account.usagePeriod !== key;
  const used = (rolled ? 0 : Number(account.leadsUsed || 0)) + n;
  db.updateAccount(account.id, { leadsUsed: used, usagePeriod: key });
}

module.exports = {
  usage, consume, consumeVoiceMinutes, voiceAllowed, isPro, TRIAL_LEADS,
  TIERS, tierList, priceIdForTier, tierForPriceId, accountTier, cheapestTier, fromPrice,
};
