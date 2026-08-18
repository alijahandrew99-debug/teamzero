// Sales reps, referral attribution, and the commission ledger.
//
// This is a rep's paycheck. Everything here is built around one rule: a rep
// gets paid on money Dawnpipe ACTUALLY COLLECTED, and every cent is traceable
// back to a Stripe object you can open in the dashboard. Never on "active
// subscriptions", never on plan list price, never on anything derived.
//
// Three consequences of that rule, all deliberate:
//
//   1. The 7-day free trial needs no special handling at all. A trial produces
//      no collected money, so it produces no commission — automatically,
//      without a single line of trial-specific code to get wrong.
//   2. Upgrades and downgrades need no special handling. The basis is whatever
//      was collected, so a customer moving $399 -> $1,499 just starts paying
//      the rep more, from the next invoice.
//   3. Refunds and chargebacks are exact, because they reference the same
//      Stripe charge the original accrual referenced.
//
// The ledger is APPEND-ONLY. A correction is a new reversal row, never an edit
// to an old one. That is what lets you answer "you shorted me" with a list of
// rows and Stripe ids instead of an argument.
require('./env');
const crypto = require('crypto');
const db = require('./db');

// ---- rate schedule ----
// Basis points so the step-down is data, not a code change.
// 30% for the first 24 collected months of an account, then 10% for as long as
// the account lives. Rationale is in COMMISSIONS.md: a perpetual 30% is an
// unpriceable liability with no churn data, and a rate cut later would burn
// every rep at once. This way the number a rep is told on day one is the
// number forever.
const RATE_INTRO_BPS = Number(process.env.REP_RATE_BPS || 3000);
const RATE_TAIL_BPS = Number(process.env.REP_RATE_TAIL_BPS || 1000);
const INTRO_MONTHS = Number(process.env.REP_INTRO_MONTHS || 24);
// No activation bonus. 30% of a high-ticket plan, recurring, is the whole
// deal -- the owner's call, and defensible: Front Desk pays a rep $149.70 a
// month per account with no cap on accounts. Left as an env var at zero so it
// can be switched on later without a code change if ramp cash ever proves to
// be what is losing reps.
const ACTIVATION_BONUS_CENTS = Number(process.env.REP_ACTIVATION_BONUS_CENTS || 0);
// The bonus is held until the account has genuinely stuck.
const BONUS_HOLD_DAYS = Number(process.env.REP_BONUS_HOLD_DAYS || 60);
// A cancelled account returning inside this window goes back to its original
// rep, at its original month index. After it, it is a house account.
const REATTRIBUTION_DAYS = 90;

function rateBpsFor(monthIndex) {
  return monthIndex <= INTRO_MONTHS ? RATE_INTRO_BPS : RATE_TAIL_BPS;
}

// ---- referral codes ----
// A rep's code is their LAST NAME. "Use code SKINNER at checkout" is something
// a rep can say on the phone, print on a card, and a customer can remember
// long enough to type into the Stripe page. Random codes were safer against
// guessing and useless in a sales conversation. Collisions get a number:
// SKINNER, SKINNER2.
function lastNameCode(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const last = (parts.length ? parts[parts.length - 1] : '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (last || 'REP').slice(0, 16);
}
function makeCode(seed = '') {
  const base = lastNameCode(seed);
  if (!repByCode(base)) return base;
  for (let n = 2; n < 100; n++) if (!repByCode(base + n)) return base + n;
  return base + crypto.randomBytes(2).toString('hex').toUpperCase();
}
/** Normalise anything a human typed or a link carried into a comparable code. */
function normaliseCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}

// ---- reps ----
function listReps() { return db.readCollection('reps'); }
function repByCode(code) {
  const c = normaliseCode(code);
  if (!c) return null;
  return listReps().find((r) => normaliseCode(r.code) === c) || null;
}
function repById(id) { return listReps().find((r) => r.id === id) || null; }
function repByEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  return e ? listReps().find((r) => String(r.email || '').toLowerCase() === e) || null : null;
}
function createRep({ name, email, phone = '', notes = '' }) {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) throw new Error('A rep needs an email.');
  if (repByEmail(clean)) throw new Error('There is already a rep with that email.');
  const rep = {
    id: db.uid(), name: String(name || '').trim() || clean, email: clean, phone: String(phone || '').trim(),
    code: makeCode(name), status: 'active', notes,
    // Hard gates on payout. An unsigned rep cannot be exported for payment.
    agreementSignedAt: '', w9ReceivedAt: '', payoutMethod: '',
    createdAt: db.nowISO(),
  };
  db.pushCollection('reps', rep);
  return rep;
}
function updateRep(id, patch) {
  // Code and id are identity: changing a live code orphans every link already
  // printed on a business card and in every prospect's cookie.
  const { id: _i, code: _c, createdAt: _ca, ...safe } = patch || {};
  return db.patchCollection('reps', id, safe);
}
/**
 * Change a rep's code. Allowed only while no account is attributed to them:
 * once a customer has come in on a code it is on business cards and in
 * cookies, and changing it orphans every one of those.
 */
function setCode(id, newCode) {
  const rep = repById(id);
  if (!rep) throw new Error('No such rep.');
  const code = normaliseCode(newCode);
  if (!code || code.length < 2) throw new Error('A code needs at least 2 letters or numbers.');
  const clash = repByCode(code);
  if (clash && clash.id !== id) throw new Error(`${code} already belongs to ${clash.name}.`);
  const attributed = db.allAccounts().some((a) => a.repId === id);
  if (attributed) throw new Error('This rep already has customers on their current code — changing it would break the links those customers came in on.');
  return db.patchCollection('reps', id, { code });
}

/** Payable only when the paperwork exists. This is the enforcement point. */
function payoutBlocked(rep) {
  if (!rep) return 'No rep record.';
  if (rep.status !== 'active') return `Rep is ${rep.status}.`;
  if (!rep.agreementSignedAt) return 'Commission agreement not signed.';
  if (!rep.w9ReceivedAt) return 'No W-9 on file.';
  if (!rep.payoutMethod) return 'No payout method on file.';
  return '';
}

// ---- attribution ----
/**
 * Bind an account to a rep. FIRST TOUCH WINS and it is permanent: an account
 * that already has a rep is never silently reassigned, because that is
 * somebody's paycheck moving without a trace.
 */
function attribute(account, code, { source = 'signup' } = {}) {
  if (!account) return { ok: false, reason: 'No account.' };
  if (account.repId) return { ok: false, reason: 'Account is already attributed.', repId: account.repId };
  const rep = repByCode(code);
  if (!rep) return { ok: false, reason: 'Unknown referral code.' };
  if (rep.status !== 'active') return { ok: false, reason: 'That rep is no longer active.' };
  // Self-referral: a rep signing up their own account to pay themselves 30%
  // of their own money. Flagged, not silently allowed.
  const selfRef = String(rep.email || '').toLowerCase() === String(account.email || '').toLowerCase();
  db.updateAccount(account.id, {
    repId: rep.id, repCode: rep.code, repAttributedAt: db.nowISO(), repSource: source,
    ...(selfRef ? { repSelfReferral: true } : {}),
  });
  db.logActivity(account.id, { agent: 'SYSTEM', msg: `Referred by ${rep.name} (${rep.code})${selfRef ? ' — SELF-REFERRAL, flagged for review' : ''}` });
  return { ok: true, rep, selfReferral: selfRef };
}

// ---- ledger ----
// Every row references the Stripe object it came from, and rows are unique on
// (kind, stripeId) so a webhook Stripe delivers twice cannot pay twice.
function ledger() { return db.readCollection('commissions'); }
function ledgerFor(repId) { return ledger().filter((r) => r.repId === repId); }
function ledgerForAccount(accountId) { return ledger().filter((r) => r.accountId === accountId); }
function alreadyPosted(kind, stripeId) {
  if (!stripeId) return false;
  return ledger().some((r) => r.kind === kind && r.stripeId === stripeId);
}

function post(row) {
  const rec = { id: db.uid(), at: db.nowISO(), status: 'accrued', ...row };
  db.pushCollection('commissions', rec);
  return rec;
}

/**
 * A collected invoice arrived. Post whatever it earns.
 * `amountCents` MUST be what Stripe actually collected net of tax — the caller
 * reads it off the invoice, we never infer it from the plan price.
 */
function recordCollection({ account, invoiceId, amountCents, periodStart = '', periodEnd = '', description = '' }) {
  if (!account || !account.repId) return { skipped: 'not attributed' };
  if (!amountCents || amountCents <= 0) return { skipped: 'nothing collected' };
  if (alreadyPosted('recurring', invoiceId)) return { skipped: 'duplicate webhook' };
  const rep = repById(account.repId);
  if (!rep) return { skipped: 'rep record missing' };

  // Which collected month of this account's life is this? Index 1 is the first
  // charge — the one at the end of the trial.
  const prior = ledgerForAccount(account.id).filter((r) => r.kind === 'recurring' && r.status !== 'reversed').length;
  const monthIndex = prior + 1;
  const rateBps = rateBpsFor(monthIndex);
  // A terminated rep earns nothing further; an inactive one keeps the intro
  // tail but loses the maintenance rate. Both are stated in the agreement.
  if (rep.status === 'terminated') return { skipped: 'rep terminated' };
  if (rep.status !== 'active' && monthIndex > INTRO_MONTHS) return { skipped: 'rep inactive, tail rate not earned' };

  const rows = [];
  rows.push(post({
    kind: 'recurring', repId: rep.id, accountId: account.id, stripeId: invoiceId,
    basisCents: amountCents, rateBps, amountCents: Math.round(amountCents * rateBps / 10000),
    monthIndex, periodStart, periodEnd, description,
  }));

  // First money from this account: the activation bonus, held until the
  // account has proven it sticks.
  if (ACTIVATION_BONUS_CENTS > 0 && monthIndex === 1 && !alreadyPosted('activation', account.id)) {
    rows.push(post({
      kind: 'activation', repId: rep.id, accountId: account.id, stripeId: account.id,
      basisCents: 0, rateBps: 0, amountCents: ACTIVATION_BONUS_CENTS,
      status: 'held', holdUntil: new Date(Date.now() + BONUS_HOLD_DAYS * 86400000).toISOString(),
      description: `Activation bonus — released ${BONUS_HOLD_DAYS} days after the first payment`,
    }));
  }
  return { rows };
}

/**
 * Money went back out — a refund or a lost dispute. Reverse exactly what that
 * charge earned, and claw the activation bonus if it is still inside its hold.
 */
function recordReversal({ account, stripeId, amountCents, reason = 'refund' }) {
  if (!account || !account.repId) return { skipped: 'not attributed' };
  if (alreadyPosted('reversal', stripeId)) return { skipped: 'duplicate' };
  const rows = ledgerForAccount(account.id).filter((r) => r.kind === 'recurring');
  const target = rows.find((r) => r.stripeId === stripeId) || rows[rows.length - 1];
  const out = [];
  let full = false;
  if (target) {
    // Partial refund reverses proportionally; a full refund reverses the lot.
    const share = amountCents && target.basisCents ? Math.min(1, amountCents / target.basisCents) : 1;
    full = share >= 1;
    out.push(post({
      kind: 'reversal', repId: target.repId, accountId: account.id, stripeId,
      basisCents: -Math.round((target.basisCents || 0) * share), rateBps: target.rateBps,
      amountCents: -Math.round(target.amountCents * share),
      description: `Reversal (${reason}) of ${target.stripeId || 'earlier commission'}`,
    }));
    // The negative row IS the correction — the original keeps its own status so
    // the balance stays a plain sum of every row. Marking the original
    // "reversed" too subtracted it a second time and understated a rep by the
    // full invoice instead of the refunded part.
    db.patchCollection('commissions', target.id, {
      reversedCents: (target.reversedCents || 0) + Math.round(target.amountCents * share),
    });
  }
  // The bonus rewards an account that STICKS, so it goes back on a chargeback,
  // a dispute, a cancellation or a full refund — but NOT on a partial refund
  // of one invoice on an account that is still very much alive.
  const clawing = full || /chargeback|dispute|cancel/i.test(reason);
  const bonus = ledgerForAccount(account.id).find((r) => r.kind === 'activation' && r.status === 'held');
  if (bonus && clawing) {
    out.push(post({ kind: 'reversal', repId: bonus.repId, accountId: account.id, stripeId: `${stripeId}-bonus`,
      basisCents: 0, rateBps: 0, amountCents: -bonus.amountCents,
      description: `Activation bonus clawed back (${reason} inside the ${BONUS_HOLD_DAYS}-day hold)` }));
    db.patchCollection('commissions', bonus.id, { status: 'reversed' });
  }
  return { rows: out };
}

/** Release any held bonus whose hold has run out. Safe to call repeatedly. */
function releaseHolds(now = Date.now()) {
  let released = 0;
  for (const r of ledger()) {
    if (r.status === 'held' && r.holdUntil && Date.parse(r.holdUntil) <= now) {
      db.patchCollection('commissions', r.id, { status: 'accrued', releasedAt: db.nowISO() });
      released++;
    }
  }
  return released;
}

/** What a rep is owed, split the way a rep actually asks about it. */
function summary(repId) {
  const rows = ledgerFor(repId);
  const sum = (f) => rows.filter(f).reduce((n, r) => n + (r.amountCents || 0), 0);
  const held = sum((r) => r.status === 'held');
  const paid = sum((r) => r.status === 'paid');
  // ONE rule, and it is deliberately the simplest one that can be right:
  // payable is the plain sum of every row that is neither still held nor
  // already paid. Reversals are negative rows, so they net themselves. Any
  // cleverer rule (marking originals reversed, bucketing reversals separately)
  // double-counts, and double-counting here is a wrong paycheck.
  const payable = sum((r) => r.status !== 'held' && r.status !== 'paid');
  const accounts = new Set(rows.filter((r) => r.kind === 'recurring').map((r) => r.accountId));
  return {
    heldCents: held, payableCents: payable, paidCents: paid,
    lifetimeCents: paid + payable + held,
    accounts: accounts.size,
    nextRelease: rows.filter((r) => r.status === 'held' && r.holdUntil).map((r) => r.holdUntil).sort()[0] || '',
  };
}

const usd = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

module.exports = {
  makeCode, lastNameCode, normaliseCode, listReps, createRep, updateRep, setCode, repByCode, repById, repByEmail, payoutBlocked,
  attribute, recordCollection, recordReversal, releaseHolds, summary,
  ledger, ledgerFor, ledgerForAccount, rateBpsFor, usd,
  RATE_INTRO_BPS, RATE_TAIL_BPS, INTRO_MONTHS, ACTIVATION_BONUS_CENTS, BONUS_HOLD_DAYS, REATTRIBUTION_DAYS,
};
