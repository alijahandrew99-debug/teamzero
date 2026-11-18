// Repro for ops/audit/2026-11-18.md §1 — the do-not-call list is one click
// reversible, and nothing else records that a person opted out.
//
//   node ops/audit/2026-11-18-repro-dnc.js
//
// Uses a throwaway DATA_DIR, touches no real data, places no calls. It drives
// the real lib/suppression.js, lib/callback.js and lib/db.js, and replays
// placeCallback's gates (server.js:334-346) in order on the record that comes
// out, so a pass here is the same decision the dialler would make.
const os = require('os'), path = require('path');
process.env.DATA_DIR = path.join(os.tmpdir(), 'dp-dnc-repro-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, '..', '..');
const db = require(path.join(ROOT, 'lib/db'));
const suppress = require(path.join(ROOT, 'lib/suppression'));
const callback = require(path.join(ROOT, 'lib/callback'));

const ACC = db.createAccount({ email: 'shop@repro.test', passHash: 'x', salt: 'y' }).id;
const PHONE = '+12136822616';
const line = (s) => console.log(s);

line('--- Day 1: Dana fills the shop\'s call-back form and ticks the box ---');
const rec0 = db.addCallback(ACC, {
  source: 'form', name: 'Dana', phone: PHONE, phoneKey: suppress.phoneKey(PHONE),
  consent: true, consentText: callback.consentText('The Shop', PHONE),
  consentAt: db.nowISO(), consentIp: '203.0.113.9',
});
db.updateCallback(ACC, rec0.id, { status: 'called', calledAt: db.nowISO(), basis: 'form' });
line(`  consent recorded, AI called her. row ${rec0.id}`);

line('\n--- Day 2: Dana texts STOP. server.js:1131 is the whole of what runs ---');
suppress.suppressPhone(ACC, PHONE, 'unsubscribe', { note: 'texted STOP' });
const stopped = db.getCallbacks(ACC, 10).find((c) => c.id === rec0.id);
line(`  suppression list blocks her:  ${suppress.isPhoneSuppressed(ACC, PHONE).blocked}`);
line(`  her consent row records it:   optedOut = ${stopped.optedOut}  (nothing in the`);
line('                                codebase ever writes that field — grep it)');
line(`  consent on the row is still:  ${stopped.consent}`);
line(`  callbackAllowed on her row:   ${JSON.stringify(callback.callbackAllowed(stopped))}`);
line('  => the ONLY thing standing between her and another AI call is the');
line('     suppression list.');

line('\n--- Day 3: the owner clicks "Unblock" on her row in the app ---');
const row = db.getSuppression(ACC).find((s) => s.email === suppress.phoneKey(PHONE));
line(`  the row the UI shows:  "${row.email}"  ·  "${suppress.REASONS[row.reason]}"`);
line('  the confirm she sees:  "Unblock ...? They can be emailed again."');
line('                         (views/app.html:1718 — it never mentions calls)');
line(`  /api/suppression/remove -> unsuppress returned ${suppress.unsuppress(ACC, row.email)}`);
line(`  suppression list blocks her now: ${suppress.isPhoneSuppressed(ACC, PHONE).blocked}`);

line('\n--- Day 3: the owner clicks "Call back" on her old enquiry ---');
line('    (/api/callbacks/call with f.id, so placeCallback runs with by:"owner")');
const rec = db.getCallbacks(ACC, 500).find((c) => c.id === rec0.id);
const g1 = callback.callbackAllowed(rec);
const g2 = suppress.isPhoneSuppressed(ACC, rec.phone);
line(`  gate 1  consent          -> ${g1.ok ? 'PASS' : 'BLOCKED: ' + g1.reason}`);
line(`  gate 2  "DNC is absolute"-> ${g2.blocked ? 'BLOCKED' : 'PASS'}`);
line('  gate 3  once per day     -> skipped entirely when by === "owner"');
line('  gate 5  quiet hours      -> skipped entirely when by === "owner"');
line(`\n  RESULT: AI voice call placed to a person who texted STOP: ${g1.ok && !g2.blocked ? 'YES' : 'no'}`);
line('\n  And form consent carries no age limit (see 2026-11-11 §4), so her');
line('  day-1 tick is still treated as live consent however long ago it was.');
process.exit(g1.ok && !g2.blocked ? 0 : 1);
