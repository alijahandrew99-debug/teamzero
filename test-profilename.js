// Profile name length cap. The business name is interpolated unescaped
// into both the call-back consent wording and the spoken TTS greeting
// scripts, so it shouldn't be allowed to grow without bound just because
// only the account owner can set it today.
process.env.PORT = '8142';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-profname-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8142';
process.env.OWNER_EMAILS = 'owner@x.com';

require('./server.js');
const db = require('./lib/db');
const auth = require('./lib/auth');

const BASE = 'http://127.0.0.1:8142';
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 200) : '')); };

(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const { passHash, salt } = auth.hashPassword('testpass123');
  const acc = db.createAccount({ email: 'namecap@x.com', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'complete', plan: 'pro' });

  const login = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=namecap%40x.com&password=testpass123',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const saveProfile = (body) => fetch(`${BASE}/api/profile/save`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  }).then((r) => r.json());

  // --- an ordinary name round-trips untouched ---
  let r = await saveProfile({ name: 'Ace Plumbing', offer: 'plumbing' });
  ok('an ordinary name is saved as-is', r.profile && r.profile.name === 'Ace Plumbing', r.profile);

  // --- a name past the cap is truncated, not rejected ---
  const huge = 'X'.repeat(50000);
  r = await saveProfile({ id: r.profile.id, name: huge, offer: 'plumbing' });
  ok('an oversized name is capped to 200 chars', r.profile && r.profile.name.length === 200, r.profile && r.profile.name.length);
  ok('the capped name is a true prefix of what was sent', r.profile && huge.startsWith(r.profile.name));

  // --- surrounding whitespace is trimmed ---
  r = await saveProfile({ id: r.profile.id, name: '   Bright Roofing   ', offer: 'roofing' });
  ok('surrounding whitespace is trimmed', r.profile && r.profile.name === 'Bright Roofing', r.profile);

  // --- a brand-new profile (create path, not update) is capped too ---
  r = await saveProfile({ name: 'Y'.repeat(300) });
  ok('the create path (no id) is capped too', r.profile && r.profile.name.length === 200, r.profile && r.profile.name.length);

  // --- other fields are unaffected ---
  r = await saveProfile({ id: r.profile.id, name: 'Short Name', offer: 'Z'.repeat(5000) });
  ok('other long fields are left alone (not this fix\'s scope)', r.profile && r.profile.offer.length === 5000, r.profile && r.profile.offer.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
