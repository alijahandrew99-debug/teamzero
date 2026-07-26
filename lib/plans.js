// Plans, free trial, and usage quotas.
//
// Two business rules live here, and both are survival-critical for a subscription:
//   1. A new user gets REAL value free before being asked to pay. "Start free"
//      must be true or conversion dies — nobody buys what they haven't used.
//   2. Every plan has a hard ceiling. Each lead costs real AI spend, so unmetered
//      usage means a heavy customer costs more than they pay.
const db = require('./db');

const TRIAL_LEADS = 15;          // enough to prove it works, too few to abuse
const PRO_LEADS_PER_MONTH = 500; // ~16/day — generous, but bounds your API cost

function isPro(account) {
  return ['active', 'trialing'].includes(account && account.subStatus);
}

function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Current usage + allowance for an account.
 * Owners/comped accounts are unlimited.
 */
function usage(account, owner = false) {
  if (owner) return { plan: 'owner', used: 0, limit: Infinity, remaining: Infinity, unlimited: true, isPro: true };

  const pro = isPro(account);
  const limit = pro ? PRO_LEADS_PER_MONTH : TRIAL_LEADS;

  // Paid plans reset monthly; the free trial is a one-time allowance that never resets.
  let used = Number(account.leadsUsed || 0);
  if (pro && account.usagePeriod !== periodKey()) used = 0;

  return {
    plan: pro ? 'pro' : 'trial',
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

module.exports = { usage, consume, isPro, TRIAL_LEADS, PRO_LEADS_PER_MONTH };
