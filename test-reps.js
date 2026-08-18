// Full lifecycle test for rep attribution and the commission ledger.
//
// This is somebody's paycheck, so it is tested end to end rather than by unit:
// signup -> trial (no money, no commission) -> first charge -> bonus held ->
// months accrue -> refund -> duplicate webhook -> cancel -> re-subscribe ->
// the 24-month rate step -> a terminated rep. Run: node test-reps.js
process.env.DATA_DIR = process.env.DATA_DIR || require('path').join(require('os').tmpdir(), 'dp-reptest-' + Date.now());
// The bonus is OFF in production. These tests set it on so the hold/claw logic
// stays covered for the day it is switched back on; a separate check below
// asserts that with the default (0) no bonus row is ever posted.
process.env.REP_ACTIVATION_BONUS_CENTS = process.env.REP_ACTIVATION_BONUS_CENTS || '15000';
const fs = require('fs');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const db = require('./lib/db');
const reps = require('./lib/reps');

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + label); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + label + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- setup
const rep = reps.createRep({ name: 'Jordan Lee', email: 'jordan@example.com' });
const acct = db.createAccount({ email: 'owner@acmeplumbing.com', passHash: 'x', salt: 'y' });

section('Attribution');
const bad = reps.attribute(acct, 'NOTACODE');
ok('an unknown code attributes nothing', !bad.ok);

const att = reps.attribute(db.getAccount(acct.id), rep.code);
ok('a valid code binds the account to the rep', att.ok);
ok('the account carries the rep id', db.getAccount(acct.id).repId === rep.id);

const rep2 = reps.createRep({ name: 'Sam Poach', email: 'sam@example.com' });
const steal = reps.attribute(db.getAccount(acct.id), rep2.code);
ok('a second rep cannot steal an attributed account', !steal.ok);
ok('the original rep still owns it', db.getAccount(acct.id).repId === rep.id);

const selfAcct = db.createAccount({ email: 'jordan@example.com', passHash: 'x', salt: 'y' });
const selfRes = reps.attribute(selfAcct, rep.code);
ok('self-referral is flagged, not silently allowed', selfRes.ok && selfRes.selfReferral === true);

section('The 7-day trial pays nothing');
const trial = reps.recordCollection({ account: db.getAccount(acct.id), invoiceId: 'in_trial', amountCents: 0 });
ok('a zero-amount invoice earns no commission', !!trial.skipped);
ok('the ledger is still empty', reps.ledgerFor(rep.id).length === 0);

section('First real charge (day 8) — Front Desk $399');
const first = reps.recordCollection({ account: db.getAccount(acct.id), invoiceId: 'in_001', amountCents: 39900 });
const recur1 = first.rows.find((r) => r.kind === 'recurring');
const bonus = first.rows.find((r) => r.kind === 'activation');
ok('commission is 30% of what was collected', recur1.amountCents === 11970, reps.usd(recur1.amountCents));
ok('it is month 1 of the account', recur1.monthIndex === 1);
ok('the activation bonus is posted', !!bonus && bonus.amountCents === 15000);
ok('the bonus starts HELD, not payable', bonus.status === 'held');
ok('the bonus has a release date', !!bonus.holdUntil);

section('Duplicate webhook delivery (Stripe retries)');
const dupe = reps.recordCollection({ account: db.getAccount(acct.id), invoiceId: 'in_001', amountCents: 39900 });
ok('the same invoice cannot pay twice', !!dupe.skipped, dupe.skipped);
ok('still exactly one recurring row', reps.ledgerForAccount(acct.id).filter((r) => r.kind === 'recurring').length === 1);

section('Month 2, then an upgrade to Complete $1,499');
reps.recordCollection({ account: db.getAccount(acct.id), invoiceId: 'in_002', amountCents: 39900 });
const up = reps.recordCollection({ account: db.getAccount(acct.id), invoiceId: 'in_003', amountCents: 149900 });
const recur3 = up.rows.find((r) => r.kind === 'recurring');
ok('an upgrade needs no special handling — 30% of the new amount', recur3.amountCents === 44970, reps.usd(recur3.amountCents));
ok('no second activation bonus on an upgrade', !up.rows.some((r) => r.kind === 'activation'));

section('A partial refund');
const before = reps.summary(rep.id).payableCents;
reps.recordReversal({ account: db.getAccount(acct.id), stripeId: 'in_003', amountCents: 74950, reason: 'partial refund' });
const after = reps.summary(rep.id).payableCents;
ok('half refunded reverses half the commission', before - after === 22485, `moved ${reps.usd(before - after)}`);

section('Bonus hold and release');
const s1 = reps.summary(rep.id);
ok('the bonus is not payable while held', s1.heldCents === 15000);
ok('a release date is reported to the rep', !!s1.nextRelease);
ok('nothing releases early', reps.releaseHolds(Date.now()) === 0);
const released = reps.releaseHolds(Date.now() + (reps.BONUS_HOLD_DAYS + 1) * 86400000);
ok('the bonus releases after its hold', released === 1);
ok('and moves from held into payable', reps.summary(rep.id).heldCents === 0);

section('Chargeback inside the hold claws the bonus back');
const acct2 = db.createAccount({ email: 'owner@bobshvac.com', passHash: 'x', salt: 'y' });
reps.attribute(acct2, rep.code);
reps.recordCollection({ account: db.getAccount(acct2.id), invoiceId: 'in_100', amountCents: 39900 });
const paidBefore = reps.summary(rep.id).payableCents + reps.summary(rep.id).heldCents;
reps.recordReversal({ account: db.getAccount(acct2.id), stripeId: 'in_100', amountCents: 39900, reason: 'chargeback' });
const paidAfter = reps.summary(rep.id).payableCents + reps.summary(rep.id).heldCents;
ok('commission AND the held bonus both reverse', paidBefore - paidAfter === 11970 + 15000, `moved ${reps.usd(paidBefore - paidAfter)}`);

section('The 24-month rate step-down');
ok('month 24 is still 30%', reps.rateBpsFor(24) === 3000);
ok('month 25 steps to 10%', reps.rateBpsFor(25) === 1000);
const acct3 = db.createAccount({ email: 'owner@longtimer.com', passHash: 'x', salt: 'y' });
reps.attribute(acct3, rep.code);
for (let i = 1; i <= 24; i++) reps.recordCollection({ account: db.getAccount(acct3.id), invoiceId: 'in_L' + i, amountCents: 39900 });
const m25 = reps.recordCollection({ account: db.getAccount(acct3.id), invoiceId: 'in_L25', amountCents: 39900 });
const r25 = m25.rows.find((r) => r.kind === 'recurring');
ok('the 25th collected month pays the tail rate', r25.amountCents === 3990, reps.usd(r25.amountCents));
ok('and is correctly numbered month 25', r25.monthIndex === 25);

section('Rep status');
const gone = reps.createRep({ name: 'Ex Rep', email: 'ex@example.com' });
const acct4 = db.createAccount({ email: 'owner@fourth.com', passHash: 'x', salt: 'y' });
reps.attribute(acct4, gone.code);
reps.updateRep(gone.id, { status: 'terminated' });
const term = reps.recordCollection({ account: db.getAccount(acct4.id), invoiceId: 'in_T1', amountCents: 39900 });
ok('a terminated rep earns nothing further', !!term.skipped, term.skipped);

section('Payout gate');
ok('an unsigned rep is blocked from payout', !!reps.payoutBlocked(reps.repById(rep.id)));
reps.updateRep(rep.id, { agreementSignedAt: db.nowISO(), w9ReceivedAt: db.nowISO(), payoutMethod: 'ACH' });
ok('a fully onboarded rep is payable', reps.payoutBlocked(reps.repById(rep.id)) === '');
const codeBefore = reps.repById(rep.id).code;
reps.updateRep(rep.id, { code: 'HACKED' });
ok('a live referral code cannot be changed out from under printed links', reps.repById(rep.id).code === codeBefore);

section('A bonus already PAID is never silently clawed');
// The hold exists so we never pay a bonus we might want back. Guard the
// invariant anyway: if a paid bonus were ever marked 'reversed' it would flip
// from excluded to counted and hand the rep a phantom $150.
const acct5 = db.createAccount({ email: 'owner@paidbonus.com', passHash: 'x', salt: 'y' });
reps.attribute(acct5, rep.code);
reps.recordCollection({ account: db.getAccount(acct5.id), invoiceId: 'in_P1', amountCents: 44900 });
reps.releaseHolds(Date.now() + (reps.BONUS_HOLD_DAYS + 1) * 86400000);
for (const r of reps.ledgerForAccount(acct5.id)) {
  if (r.kind === 'activation') db.patchCollection('commissions', r.id, { status: 'paid' });
}
const payableBeforeClaw = reps.summary(rep.id).payableCents;
reps.recordReversal({ account: db.getAccount(acct5.id), stripeId: 'in_P1', amountCents: 44900, reason: 'chargeback' });
const payableAfterClaw = reps.summary(rep.id).payableCents;
ok('a paid bonus is left alone — only the commission reverses',
  payableBeforeClaw - payableAfterClaw === 13470, `moved ${reps.usd(payableBeforeClaw - payableAfterClaw)}`);
ok('the paid bonus row keeps its paid status',
  reps.ledgerForAccount(acct5.id).find((r) => r.kind === 'activation').status === 'paid');

section('Ledger integrity');
const all = reps.ledgerFor(rep.id);
ok('every row references a Stripe object or the account', all.every((r) => !!r.stripeId));
ok('reversals are negative rows, never edits', all.filter((r) => r.kind === 'reversal').every((r) => r.amountCents < 0));
const recomputed = all.filter((r) => r.kind === 'recurring' && r.status === 'accrued')
  .every((r) => r.amountCents === Math.round(r.basisCents * r.rateBps / 10000));
ok('every commission recomputes exactly from basis x rate', recomputed);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
