// Call-back store write suite.
//
// runCallbackQueue() re-attempts every parked call-back once a minute. A row
// held back by a STANDING reason -- the account has no paid plan, no phone line
// or no profile -- comes back from placeCallback() with exactly the status and
// note it already has, and that used to rewrite callbacks.json in full anyway:
// 20 whole-file rewrites a minute, for ever, to change nothing. callbacks.json
// is the one collection db.js never prunes and it holds every consent record,
// so it is the worst file in the store to rewrite on a loop -- and it blocks
// the same event loop the live voice webhooks run on.
//
// These assertions are about the WRITE, not the value: the row must end up
// identical either way, so a pass means the write was skipped, not that the
// behaviour changed.
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-cbw-' + Date.now());
const fs = require('fs');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const db = require('./lib/db');

let writes = 0;
const realWrite = fs.writeFileSync;
fs.writeFileSync = function (f, ...rest) {
  if (String(f).includes('callbacks.json')) writes++;
  return realWrite.call(fs, f, ...rest);
};
const counted = (fn) => { const b = writes; const r = fn(); return { r, wrote: writes - b }; };

let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 300) : '')); };

const ACC = 'acc-write-test';
const row = db.addCallback(ACC, { source: 'form', name: 'Dana Reed', phone: '+13125550144',
  phoneKey: '13125550144', need: 'water heater', consent: true,
  consentText: 'I agree that Ace may call me.', consentAt: db.nowISO() });

console.log('== a parked row written back unchanged costs no write ==');
const PARK = { status: 'queued', note: 'Phone calling needs a paid plan.' };
const first = counted(() => db.updateCallback(ACC, row.id, PARK));
ok('parking it the first time writes once', first.wrote === 1, first.wrote);
ok('status is queued', db.getCallbacks(ACC, 10)[0].status === 'queued', db.getCallbacks(ACC, 10)[0].status);

const again = counted(() => db.updateCallback(ACC, row.id, PARK));
ok('the next identical attempt writes nothing', again.wrote === 0, again.wrote);
ok('and still returns the row', again.r && again.r.id === row.id, JSON.stringify(again.r));

const ten = counted(() => { for (let i = 0; i < 10; i++) db.updateCallback(ACC, row.id, PARK); });
ok('ten more identical attempts write nothing', ten.wrote === 0, ten.wrote);

const after = db.getCallbacks(ACC, 10)[0];
ok('the row is unchanged by the skipped writes', after.status === 'queued' && after.note === PARK.note, JSON.stringify({ s: after.status, n: after.note }));

console.log('== a real change still writes, exactly once ==');
const moved = counted(() => db.updateCallback(ACC, row.id, { status: 'queued', note: 'No phone line yet — get a number on the AI Answering tab.' }));
ok('a changed note writes once', moved.wrote === 1, moved.wrote);
ok('the new note is stored', db.getCallbacks(ACC, 10)[0].note.startsWith('No phone line'), db.getCallbacks(ACC, 10)[0].note);

const called = counted(() => db.updateCallback(ACC, row.id, { status: 'called', calledAt: db.nowISO(), callSid: 'CAtest1', note: '' }));
ok('being dialled writes once', called.wrote === 1, called.wrote);
ok('status is called', db.getCallbacks(ACC, 10)[0].status === 'called', db.getCallbacks(ACC, 10)[0].status);

console.log('== a partially-changed patch still writes the whole patch ==');
const partial = counted(() => db.updateCallback(ACC, row.id, { status: 'called', note: 'ring again tomorrow' }));
ok('one changed field in an otherwise identical patch writes', partial.wrote === 1, partial.wrote);
ok('the changed field landed', db.getCallbacks(ACC, 10)[0].note === 'ring again tomorrow', db.getCallbacks(ACC, 10)[0].note);

console.log('== consent evidence is still write-once, and still costs no write ==');
const consentBefore = db.getCallbacks(ACC, 10)[0].consentText;
const tamper = counted(() => db.updateCallback(ACC, row.id, { consentText: 'rewritten after the fact', consentAt: '2020-01-01T00:00:00.000Z' }));
ok('the consent wording is NOT changed', db.getCallbacks(ACC, 10)[0].consentText === consentBefore, db.getCallbacks(ACC, 10)[0].consentText);
ok('a patch that only tried to change locked fields writes nothing', tamper.wrote === 0, tamper.wrote);

console.log('== a row with no consent yet can still be given one (missed-call YES) ==');
const offered = db.addCallback(ACC, { source: 'missed-call', phone: '+13125550199', phoneKey: '13125550199', status: 'offered', offerText: 'Reply YES' });
const yes = counted(() => db.updateCallback(ACC, offered.id, { status: 'queued', consent: true, consentAt: db.nowISO(), consentText: 'Replied "YES" by SMS', consentVia: 'sms-reply' }));
ok('the YES is recorded and written', yes.wrote === 1, yes.wrote);
const yrow = db.getCallbacks(ACC, 10).find((c) => c.id === offered.id);
ok('consent is now on the row', yrow.consent === true && yrow.consentVia === 'sms-reply', JSON.stringify(yrow));
ok('and it is queued for the dialler', yrow.status === 'queued', yrow.status);

console.log('== unknown ids and empty patches are harmless ==');
const nope = counted(() => db.updateCallback(ACC, 'no-such-id', PARK));
ok('an unknown id writes nothing and returns null', nope.wrote === 0 && nope.r === null, JSON.stringify(nope));
const empty = counted(() => db.updateCallback(ACC, row.id, {}));
ok('an empty patch writes nothing', empty.wrote === 0, empty.wrote);
const wrongAcc = counted(() => db.updateCallback('someone-else', row.id, PARK));
ok('another tenant cannot patch the row', wrongAcc.wrote === 0 && wrongAcc.r === null, JSON.stringify(wrongAcc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
