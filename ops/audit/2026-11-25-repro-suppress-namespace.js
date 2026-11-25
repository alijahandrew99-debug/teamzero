// Repro + regression test for the 2026-11-25 audit, finding 1 and finding 4.
//
// 1. Phone numbers live in the email suppression list keyed `<digits>@phone.invalid`
//    (lib/suppression.js phoneKey). `isSuppressed` also honours a wholeDomain row
//    for the address's domain. Those two facts combine badly: ONE wholeDomain row
//    on `phone.invalid` means every phone number in that account is suppressed —
//    every inbound call <Reject>ed, every SMS dropped, every call-back refused.
//    The row renders in the UI as an ordinary address block.
//
// 4. norm() did `(email || '').trim()`, so a non-string `email` from a JSON body
//    threw a TypeError. /api/suppression/remove turned that into a 500 with the
//    internal message in the response body.
//
// Runs in a throwaway DATA_DIR. Places no calls, sends nothing, touches no
// network. Drives the real modules.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-supp-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const db = require(path.join(ROOT, 'lib/db'));
const suppress = require(path.join(ROOT, 'lib/suppression'));

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (!cond && extra !== undefined ? '  -> ' + String(extra).slice(0, 200) : ''));
};

const acc = db.createAccount({ email: 'shop@supp.test', passHash: 'x', salt: 'y' });

console.log('\n--- finding 1: the synthetic phone domain must not be whole-domain blockable ---');

// Baseline: nothing is blocked yet.
ok('unrelated number starts unblocked', !suppress.isPhoneSuppressed(acc.id, '+19998887777').blocked);

// A real do-not-call on ONE number must block that number and nothing else.
suppress.suppressPhone(acc.id, '+13125550202', 'unsubscribe', { note: 'said stop on a call' });
ok('the number that opted out is blocked', suppress.isPhoneSuppressed(acc.id, '+13125550202').blocked);
ok('a different number is still reachable', !suppress.isPhoneSuppressed(acc.id, '+19998887777').blocked);

// The bug: a wholeDomain row whose domain resolves to phone.invalid.
// Reachable from /api/suppression/add, which forwards `wholeDomain` from the
// request body and classes anything containing "@" as an email address.
const row = suppress.suppress(acc.id, '13125550202@phone.invalid', 'manual', { wholeDomain: true });
ok('wholeDomain is refused on phone.invalid at the write boundary', row && row.wholeDomain === false,
   'row.wholeDomain=' + (row && row.wholeDomain));

for (const n of ['+19998887777', '+14155550000', '+442079460958']) {
  ok(`unrelated ${n} is NOT blocked by that row`, !suppress.isPhoneSuppressed(acc.id, n).blocked,
     'note=' + suppress.isPhoneSuppressed(acc.id, n).note);
}

// Same again via the bare-domain spelling, which domainOf() also resolves to
// phone.invalid, and which a hand-written API call is more likely to use.
const acc2 = db.createAccount({ email: 'shop2@supp.test', passHash: 'x', salt: 'y' });
suppress.suppress(acc2.id, '@phone.invalid', 'manual', { wholeDomain: true });
ok('"@phone.invalid" + wholeDomain does not block every number either',
   !suppress.isPhoneSuppressed(acc2.id, '+13125550202').blocked,
   'note=' + suppress.isPhoneSuppressed(acc2.id, '+13125550202').note);

// Read-boundary healing: a row already written by the old code (straight into
// the store, bypassing suppress()) must stop taking the whole account's phones
// down the moment this fix deploys.
const acc3 = db.createAccount({ email: 'shop3@supp.test', passHash: 'x', salt: 'y' });
db.addSuppression(acc3.id, { email: 'legacy@phone.invalid', domain: 'phone.invalid', wholeDomain: true, reason: 'manual', note: 'written by the old code' });
ok('a pre-existing bad row no longer blocks every number',
   !suppress.isPhoneSuppressed(acc3.id, '+13125550202').blocked,
   'note=' + suppress.isPhoneSuppressed(acc3.id, '+13125550202').note);

// A wholeDomain block on a REAL domain must keep working exactly as before.
const acc4 = db.createAccount({ email: 'shop4@supp.test', passHash: 'x', salt: 'y' });
const real = suppress.suppress(acc4.id, 'anyone@competitor.com', 'manual', { wholeDomain: true });
ok('wholeDomain still works on a real domain', real && real.wholeDomain === true);
ok('another address at that domain is blocked', suppress.isSuppressed(acc4.id, 'someone.else@competitor.com').blocked);
ok('an address elsewhere is not blocked', !suppress.isSuppressed(acc4.id, 'someone@example.com').blocked);
ok('phones on that account are untouched', !suppress.isPhoneSuppressed(acc4.id, '+13125550202').blocked);

console.log('\n--- finding 4: a non-string address must miss, not throw ---');
for (const bad of [123, { a: 1 }, ['a'], true]) {
  let threw = null, out;
  try { out = suppress.unsuppress(acc.id, bad); } catch (e) { threw = e.message; }
  ok(`unsuppress(${JSON.stringify(bad)}) does not throw`, threw === null, threw);
  threw = null;
  try { suppress.isSuppressed(acc.id, bad); } catch (e) { threw = e.message; }
  ok(`isSuppressed(${JSON.stringify(bad)}) does not throw`, threw === null, threw);
}
// null/undefined must still read as "no address" and fail CLOSED, as before.
ok('isSuppressed(null) still fails closed', suppress.isSuppressed(acc.id, null).blocked === true);
ok('isSuppressed(undefined) still fails closed', suppress.isSuppressed(acc.id, undefined).blocked === true);
ok('isSuppressed("") still fails closed', suppress.isSuppressed(acc.id, '').blocked === true);
ok('norm() is unchanged for ordinary input', suppress.norm('  Someone@Example.COM ') === 'someone@example.com');

console.log(`\n  ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
