// The consent timestamp on an owner-initiated call-back.
//
// /api/callbacks/call lets the owner supply `leftAt` — when the caller left
// their number — and that value becomes `consentAt`. consentAt is the TCPA
// evidence timestamp AND the value lib/callback.js measures its 90-day age
// limit against, so it has to be a real date, no later than now, and bounded
// in size. Every request below is a real HTTP POST against the running server,
// so a pass means the route handles it, not just a helper.
process.env.PORT = '8109'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-cbc-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8109';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
const aiEarly = require('./lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = async () => JSON.stringify({ say: 'ok', action: 'continue' });
aiEarly.callAI = (...a) => (global.__aiStub ? global.__aiStub(...a) : realCallAI(...a));
require('./server.js');
const db = require('./lib/db'), auth = require('./lib/auth'), callback = require('./lib/callback');
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 250) : '')); };

const DAY = 86400000;

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const { passHash, salt } = auth.hashPassword('testpass123');
  const acc = db.createAccount({ email: 'shop@cbc.test', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'complete', plan: 'pro' });
  db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing' });

  const login = await fetch('http://127.0.0.1:8109/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=shop%40cbc.test&password=testpass123' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const api = async (path, body) => {
    const r = await fetch('http://127.0.0.1:8109' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  // There is no phone line on this account, so placeCallback cannot dial and
  // the response is a failure either way. The record it created first is what
  // these assertions are about.
  let n = 0;
  async function callWith(leftAt) {
    n += 1;
    const phone = `+1555000${String(1000 + n).slice(-4)}`;
    const body = { phone, name: 'Dana' };
    if (leftAt !== undefined) body.leftAt = leftAt;
    await api('/api/callbacks/call', body);
    return db.getCallbacks(acc.id, 500).find((c) => c.phone === phone) || null;
  }

  console.log('== consentAt is always a usable timestamp ==');

  const plain = await callWith(undefined);
  ok('no leftAt at all (what the app itself sends) stamps now',
    plain && Math.abs(Date.parse(plain.consentAt) - Date.now()) < 60000, plain && plain.consentAt);
  ok('and that record passes the age gate', plain && callback.callbackAllowed(plain).ok,
    plain && callback.callbackAllowed(plain).reason);

  const words = await callWith('last Tuesday');
  ok('a value Date.parse cannot read does not become consentAt',
    words && !Number.isNaN(Date.parse(words.consentAt)), words && words.consentAt);
  ok('it falls back to now rather than poisoning the record',
    words && Math.abs(Date.parse(words.consentAt) - Date.now()) < 60000, words && words.consentAt);
  ok('so the gate does not refuse a brand-new record as "more than 90 days old"',
    words && callback.callbackAllowed(words).ok, words && callback.callbackAllowed(words).reason);

  const obj = await callWith({ when: 'yesterday' });
  ok('a non-string leftAt cannot land in the store either',
    obj && typeof obj.consentAt === 'string' && !Number.isNaN(Date.parse(obj.consentAt)),
    obj && JSON.stringify(obj.consentAt));

  console.log('\n== a consentAt in the future cannot defeat the 90-day limit ==');

  const future = await callWith(new Date(Date.now() + 400 * DAY).toISOString());
  ok('a future leftAt is clamped to now', future && Date.parse(future.consentAt) <= Date.now() + 60000,
    future && future.consentAt);
  // Before the fix ageDays was -400, so `ageDays <= 90` held for ever and the
  // record never expired. Age it past the limit and the gate must now bite.
  if (future) {
    db.updateCallback(acc.id, future.id, { at: new Date(Date.now() - 200 * DAY).toISOString() });
    const aged = { ...future, consentAt: new Date(Date.parse(future.consentAt) - 200 * DAY).toISOString() };
    ok('and a genuinely old enquiry is still refused', !callback.callbackAllowed(aged).ok,
      JSON.stringify(callback.callbackAllowed(aged)));
  }

  console.log('\n== the field cannot be used to bloat the never-pruned store ==');

  const huge = await callWith('A'.repeat(600000));
  ok('600KB of junk is not stored as the consent timestamp',
    huge && String(huge.consentAt).length < 64, huge && String(huge.consentAt).length);
  const bytes = require('fs').statSync(require('path').join(process.env.DATA_DIR, 'callbacks.json')).size;
  ok('callbacks.json stayed small across every request above', bytes < 65536, bytes + ' bytes');

  console.log('\n== the neighbouring fields are still capped as before ==');
  const capped = await callWith(undefined);
  ok('basis defaults when absent', capped && /Left their number/.test(capped.consentText), capped && capped.consentText);
  const long = await (async () => {
    const phone = '+15550009999';
    await api('/api/callbacks/call', { phone, name: 'N'.repeat(500), need: 'D'.repeat(900), basis: 'B'.repeat(900) });
    return db.getCallbacks(acc.id, 500).find((c) => c.phone === phone);
  })();
  ok('name still capped at 80', long && long.name.length === 80, long && long.name.length);
  ok('need still capped at 400', long && long.need.length === 400, long && long.need.length);
  ok('basis still capped at 300', long && long.consentText.length === 300, long && long.consentText.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
