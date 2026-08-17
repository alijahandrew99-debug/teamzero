// Plans, free trial, and usage quotas.
//
// Pricing is USAGE-TIERED because AI cost scales with lead volume — a flat price
// can't work. Each tier's lead cap bounds worst-case AI spend so margin holds at
// every plan. A new user gets a free trial (real value before paying), then picks
// a tier.
const db = require('./db');

// NO free trial — every lead costs real AI money on the owner's key, so access
// is pay-first. Prospects see the demo video on the landing page instead.
const TRIAL_VOICE_MINUTES = Number(process.env.TRIAL_VOICE_MINUTES || 40);
const TRIAL_LEADS = 0;

// The tiers. `leads` is the monthly cap; `priceEnvKey` maps to the Stripe price
// ID env var. Order matters — used for display and downgrade logic.
// `voiceMinutes` bounds phone spend the same way `leads` bounds AI spend — a
// plan with uncapped minutes has no worst case, and call length is the one
// variable the operator does not control.
// The plan card is the last wall a buyer stands in front of. Every tier
// carries the words that go on that wall -- tagline, who it is for, exactly
// what they get -- so the app modal, the landing page and the public
// /plans.json all say the same thing and nobody can drift out of sync.
// Every feature listed here is one the product does TODAY for that tier;
// nothing aspirational, nothing gated behind an env flag.
const TIERS = {
  tester:   { id: 'tester',   name: 'Tester',   price: 49,   leads: 50,   voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_TESTER',
              group: 'leads',
              blurb: 'See it work on your own market before you commit',
              tagline: 'Proof, not a pitch.',
              who: 'For the owner who wants to watch it find real customers before spending real money.',
              features: [
                '50 real, verified leads a month, matched to the customers you describe',
                'A personal email drafted for every single one, in your voice',
                'Approval queue: you read and approve each email before it sends',
                'Set up in about ten minutes: paste your website and it drafts your profile',
                'Everything you build here carries over when you upgrade',
              ] },
  starter:  { id: 'starter',  name: 'Starter',  price: 99,   leads: 200,  voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_STARTER',
              group: 'leads', badge: 'Most popular for leads',
              blurb: 'One person’s worth of outbound, on autopilot',
              tagline: 'A full-time prospector for the price of lunch a week.',
              who: 'For the business that knows who its customers are and wants a steady stream of them.',
              features: [
                '200 verified leads a month, each with a personal email ready to approve',
                'Overnight auto-runs: wake up to a queue of prospects, not a blank screen',
                'Unlimited businesses under one login',
                'Domain warmup and daily sending limits that protect your reputation',
                'Everything in Tester',
              ] },
  growth:   { id: 'growth',   name: 'Growth',   price: 299,  leads: 750,  voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_GROWTH',
              group: 'leads',
              blurb: 'About 25 new prospects a day, every day',
              tagline: 'The output of a small sales team, without the payroll.',
              who: 'For teams that already do outbound and want to triple the top of the funnel.',
              features: [
                '750 verified leads a month, personal email drafted for each',
                'Roughly 25 fresh prospects every working day',
                'Priority support from a real person',
                'Everything in Starter',
              ] },
  scale:    { id: 'scale',    name: 'Scale',    price: 699,  leads: 2000, voiceMinutes: 0,    priceEnvKey: 'STRIPE_PRICE_SCALE',
              group: 'leads',
              blurb: 'Agency volume without the agency',
              tagline: 'Two thousand doors knocked on, every month.',
              who: 'For agencies and multi-location businesses running outbound at scale.',
              features: [
                '2,000 verified leads a month with a personal email drafted for each',
                'Webhooks and API access: plug it into your CRM or Zapier',
                'Priority support from a real person',
                'Everything in Growth',
              ] },
  // The voice-first tier. A contractor who is losing $8-15k jobs to voicemail
  // will pay a few hundred a month to stop that; they will not pay $1,499. The
  // gap between $99 and $1,499 was the reason the phone product had no buyer.
  // Voice tiers, repriced against the market. Our voice COGS is ~$0.15/min, so
  // the old Front Desk at $399/400min ($1.00/min) was 2-5x what Rosie,
  // Dialzara and My AI Front Desk charge -- "a bare receptionist priced like a
  // premium one", per the investor audit. Two tiers now: an honest entry point
  // that undercuts nobody's floor but is in the same conversation, and Front
  // Desk with a real allowance so it earns its price. Both still ~80% gross.
  phone:    { id: 'phone',    name: 'Phone',    price: 149,  leads: 0,    voiceMinutes: 300,  priceEnvKey: 'STRIPE_PRICE_PHONE',
              group: 'phone', trial: true,
              blurb: 'The AI answers what you miss and books the job',
              tagline: 'Every call answered. Every job booked.',
              who: 'For the owner who is on the job, under a sink or on a roof, watching the phone ring out.',
              features: [
                'Answers 24/7 in a natural, human-sounding voice: nights, weekends, holidays',
                'Books straight into your calendar and texts the customer a confirmation',
                'Only says what you told it: your prices, your services, your hours',
                'Emergencies get transferred to you or your on-call tech, instantly',
                'Missed a call anyway? It texts them back within seconds',
                'Every call recorded and transcribed, so you know exactly what was said',
                '300 talk-minutes a month, roughly 100 to 150 answered calls',
              ] },
  frontdesk:{ id: 'frontdesk',name: 'Front Desk',price: 399, leads: 200,  voiceMinutes: 1000, priceEnvKey: 'STRIPE_PRICE_FRONTDESK',
              group: 'phone', trial: true, badge: 'Most popular',
              blurb: 'Answers every call, books the job, and finds new customers too',
              tagline: 'Your phone answered. Your calendar filled. New customers found.',
              who: 'For the business that wants the whole front desk handled, inbound and outbound, for less than a week of a receptionist’s wages.',
              features: [
                'Everything in Phone, with 1,000 talk-minutes: enough for a busy shop',
                'Between calls it finds 200 new customers a month and writes each one a personal email',
                'You approve every email before it goes; nothing is sent without your say-so',
                'Recognizes repeat callers by number and greets them the way your staff would',
                'Answers in Spanish too, the moment a caller does',
                'Emergency escalation to a chain of on-call numbers, with a heads-up text',
                'A monthly recap of every call, booking and lead, in one email',
              ] },
  complete: { id: 'complete', name: 'Complete', price: 1499, leads: 2000, voiceMinutes: 1000, priceEnvKey: 'STRIPE_PRICE_COMPLETE',
              group: 'phone', trial: true, badge: 'The whole team',
              blurb: 'Everything, at agency volume',
              tagline: 'A front desk and a sales floor, in one subscription.',
              who: 'For multi-location businesses and agencies that want the phone answered and the pipeline full, at scale.',
              features: [
                'Everything in Front Desk',
                '2,000 verified leads a month, each found, written to, and sent only on your approval',
                '1,000 talk-minutes for answering calls and booking jobs',
                'Webhooks and API access: plug it into your CRM or Zapier',
                'Priority support from a real person',
              ] },
};
const TIER_ORDER = ['tester', 'starter', 'phone', 'frontdesk', 'growth', 'scale', 'complete'];

// The promises that sit under every card. Each one is true of the product as
// built: no overage billing exists (allowances pause, they never bill more),
// checkout is hosted by Stripe, cancellation is one click in the portal.
const TRUST = [
  { k: 'Secure checkout by Stripe', v: 'We never see or store your card number.' },
  { k: 'Cancel in one click, any time', v: 'No contract, no setup fee, no minimum term. It runs to the end of the month you paid for.' },
  { k: 'No overage charges, ever', v: 'When an allowance is used up, it pauses. It never bills you more than the price you see.' },
  { k: 'Phone plans: 7 days free', v: 'Card required so we know you are a real business; nothing is charged until day 8.' },
  { k: 'Your data stays yours', v: 'Your leads, calls, recordings and calendar belong to you, and you keep them when you change plans.' },
  { k: 'A real person on support', v: 'support@dawnpipe.com, answered by the people who built it.' },
];

function tierList() { return TIER_ORDER.map((k) => TIERS[k]); }
/** Tiers with an `available` flag: can this one actually be bought right now? */
function catalogue() { return tierList().map((t) => ({ ...t, available: !!priceIdForTier(t.id) })); }
/** Cheapest SELLABLE tier — what "plans from $X" should actually say. */
function cheapestTier() {
  const sellable = tierList().filter((t) => !!priceIdForTier(t.id));
  const pool = sellable.length ? sellable : tierList();
  return pool.reduce((a, b) => (b.price < a.price ? b : a));
}
function fromPrice() { return `$${cheapestTier().price}`; }
// ---- Stripe price discovery ----
// Every Dawnpipe price in Stripe carries metadata.tier. Rather than depend on
// four hand-typed STRIPE_PRICE_* slots in Render (a plan that exists in
// Stripe but whose env var was never pasted is a plan that dead-ends at
// checkout -- and that is exactly how "the plans are only in test mode"
// happened), we ask Stripe on boot for the active prices and match each tier
// by BOTH metadata.tier and the exact amount. An env var, if set, still wins.
// The amount check is the safety: a stale $399/400-minute price and the new
// $399/1,000-minute one share a tier tag, and the newest matching price wins.
const discovered = {};   // tierId -> priceId
let discoveredAt = 0;
async function discoverPrices() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return discovered;
  const found = {};
  let url = 'https://api.stripe.com/v1/prices?active=true&type=recurring&limit=100&expand[]=data.product';
  for (let guard = 0; url && guard < 5; guard++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || `Stripe ${r.status}`);
    for (const p of data.data || []) {
      const tier = p.metadata && p.metadata.tier;
      const t = TIERS[tier];
      if (!t) continue;
      if (p.currency !== 'usd' || !p.recurring || p.recurring.interval !== 'month' || p.recurring.interval_count !== 1) continue;
      if (Number(p.unit_amount) !== t.price * 100) continue;
      const prod = p.product && typeof p.product === 'object' ? p.product : null;
      if (prod && (prod.active === false || !/dawnpipe/i.test(prod.name || ''))) continue;
      if (!found[tier] || p.created > found[tier].created) found[tier] = { id: p.id, created: p.created };
    }
    url = data.has_more && data.data.length ? `https://api.stripe.com/v1/prices?active=true&type=recurring&limit=100&expand[]=data.product&starting_after=${data.data[data.data.length - 1].id}` : null;
  }
  for (const k of Object.keys(discovered)) delete discovered[k];
  for (const [tier, v] of Object.entries(found)) discovered[tier] = v.id;
  discoveredAt = Date.now();
  return discovered;
}
function discoveredPrices() { return { ...discovered, at: discoveredAt }; }

function priceIdForTier(tierId) {
  const t = TIERS[tierId];
  return t ? (process.env[t.priceEnvKey] || discovered[tierId] || '') : '';
}
// Reverse-map a Stripe price ID back to a tier id (for the webhook).
function tierForPriceId(priceId) {
  for (const k of TIER_ORDER) if (process.env[TIERS[k].priceEnvKey] === priceId) return k;
  for (const k of TIER_ORDER) if (discovered[k] === priceId) return k;
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
  // The owner is uncapped, but still needs the phone STATUS indicators —
  // without a voice block the health bar silently skipped every phone chip,
  // so the one person reviewing the product could not see the warnings their
  // customers get ("no number", "answering is off", "out of minutes").
  if (owner) {
    return { plan: 'owner', tier: null, used: 0, limit: Infinity, remaining: Infinity, unlimited: true, isPro: true,
      voice: { used: 0, limit: Infinity, remaining: Infinity, included: true } };
  }

  const pro = isPro(account);
  const tier = pro ? accountTier(account) : null;
  const limit = pro ? TIERS[tier].leads : TRIAL_LEADS;

  // Paid plans reset monthly; the free trial is a one-time allowance that never resets.
  let used = Number(account.leadsUsed || 0);
  if (pro && account.usagePeriod !== periodKey()) used = 0;

  // A trial gets a taste of the phone, not the whole month's allowance: 400
  // free minutes on a card that has never been charged is a Twilio bill with
  // no revenue behind it. TRIAL_VOICE_MINUTES is enough for a few dozen real
  // calls -- plenty to prove it books their jobs, which is what the trial is for.
  const fullLimit = pro ? (TIERS[tier].voiceMinutes || 0) : 0;
  const vLimit = (account.subStatus === 'trialing' && fullLimit > 0) ? Math.min(fullLimit, TRIAL_VOICE_MINUTES) : fullLimit;
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
  // Point at the CHEAPEST plan that includes calling, not the most expensive.
  // Naming Complete at $1,499 to a Starter customer who needs Front Desk at
  // $399 mostly buys an abandoned upgrade.
  if (!u.voice.included) return { ok: false, reason: `The ${u.tierName} plan doesn't include phone calls — the Phone plan ($${TIERS.phone.price}/mo) adds the AI phone agent.` };
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
  usage, consume, consumeVoiceMinutes, voiceAllowed, isPro, TRIAL_LEADS, periodKey,
  TIERS, TRUST, tierList, catalogue, priceIdForTier, tierForPriceId, accountTier, cheapestTier, fromPrice,
  discoverPrices, discoveredPrices,
};
