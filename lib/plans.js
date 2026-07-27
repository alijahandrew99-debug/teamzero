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
const TIERS = {
  starter: { id: 'starter', name: 'Starter', price: 99,  leads: 200,  priceEnvKey: 'STRIPE_PRICE_STARTER' },
  growth:  { id: 'growth',  name: 'Growth',  price: 299, leads: 750,  priceEnvKey: 'STRIPE_PRICE_GROWTH'  },
  scale:   { id: 'scale',   name: 'Scale',   price: 699, leads: 2000, priceEnvKey: 'STRIPE_PRICE_SCALE'   },
};
const TIER_ORDER = ['starter', 'growth', 'scale'];

function tierList() { return TIER_ORDER.map((k) => TIERS[k]); }
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

  return {
    plan: pro ? 'pro' : 'trial',
    tier,
    tierName: pro ? TIERS[tier].name : 'Free trial',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    unlimited: false,
    isPro: pro,
  };
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
  usage, consume, isPro, TRIAL_LEADS,
  TIERS, tierList, priceIdForTier, tierForPriceId, accountTier,
};
