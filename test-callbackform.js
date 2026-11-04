// Public call-back form suite. /f/<slug> is unauthenticated: anyone with a
// customer's published form link can POST to it. Every field it stores must
// therefore be length-capped, because callbacks.json is never pruned and
// lib/db.js rewrites the whole file on every insert — an uncapped field is a
// remote write amplifier, not a cosmetic problem.
//
// No Twilio config is set, so placeCallback() parks rows as 'queued' and
// nothing is ever dialled.
process.env.PORT = '8137';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-cbform-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8137';
process.env.OWNER_EMAILS = 'owner@x.com';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

require('./server.js');
const db = require('./lib/db');
const callback = require('./lib/callback');

const BASE = 'http://127.0.0.1:8137';
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 200) : '')); };

(async () => {
  const acct = db.createAccount({ email: 'shop@example.com', passHash: 'h', salt: 's' });
  db.createProfile(acct.id, { name: 'Acme Plumbing' });
  const slug = callback.ensureFormSlug(db.getAccount(acct.id));

  const post = (body, hdrs = {}) => fetch(`${BASE}/f/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...hdrs },
    body: new URLSearchParams(body).toString(),
  });
  const rowFor = (phone) => db.getCallbacks(acct.id, 500).find((c) => c.phone === phone);

  // --- the caps that were already right, so a later change cannot drop them ---
  await post({ name: 'A'.repeat(5000), phone: '2136822616', need: 'B'.repeat(5000), consent: '1' });
  let r = rowFor('+12136822616');
  ok('name is capped at 80', r && r.name.length === 80, r && r.name.length);
  ok('need is capped at 400', r && r.need.length === 400, r && r.need.length);

  // --- the cap this suite exists for ---
  await post({ name: 'Bob', phone: '2136822617', need: 'leak', consent: '1', consentText: 'Z'.repeat(1000000) });
  r = rowFor('+12136822617');
  ok('consentText is capped (1,000,000 client bytes are not stored)',
    r && r.consentText.length <= 2000, r && r.consentText.length);

  // --- and the cap must not break a real submission ---
  const genuine = callback.consentText('Acme Plumbing', '(213) 682-2618');
  await post({ name: 'Rita', phone: '2136822618', need: 'boiler', consent: '1', consentText: genuine });
  r = rowFor('+12136822618');
  ok('a genuine consent wording is stored whole', r && r.consentText === genuine,
    r && `${r.consentText.length} of ${genuine.length}`);
  ok('the stored wording still satisfies the TCPA gate', r && callback.consentValid(r) === true);
  ok('and the record is still callable on that basis', r && callback.callbackAllowed(r).ok === true,
    r && JSON.stringify(callback.callbackAllowed(r)));

  // --- the server wording is still the fallback when the field is absent ---
  await post({ name: 'Sam', phone: '2136822619', need: 'tap', consent: '1' });
  r = rowFor('+12136822619');
  ok('an absent consentText falls back to the server wording',
    r && r.consentText === callback.consentText('Acme Plumbing', '2136822619'), r && r.consentText.slice(0, 60));

  // --- one unauthenticated POST can no longer move megabytes onto the disk ---
  const file = require('path').join(process.env.DATA_DIR, 'callbacks.json');
  const before = require('fs').statSync(file).size;
  await post({ name: 'Mia', phone: '2136822620', need: 'x', consent: '1', consentText: 'Z'.repeat(1000000) });
  const after = require('fs').statSync(file).size;
  ok('callbacks.json grows by kilobytes, not megabytes', after - before < 10000, `+${after - before}`);

  // --- nothing was dialled ---
  ok('no call was placed', db.getCallbacks(acct.id, 500).every((c) => c.status !== 'called'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
