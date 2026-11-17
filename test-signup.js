// Signup suite. /signup is public and unauthenticated, and the address it
// accepts becomes the account record: it is interpolated into HTML (/app's
// __EMAIL__, and the owner's Sales Reps tab), and it is the envelope address
// every system mail to the account is sent to. The error message has always
// promised "a valid email", so the check has to mean it.
process.env.PORT = '8139';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-signup-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8139';
process.env.OWNER_EMAILS = 'owner@x.com';

require('./server.js');
const db = require('./lib/db');
const auth = require('./lib/auth');

const BASE = 'http://127.0.0.1:8139';
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 200) : '')); };

const signup = (email, extra = {}) => fetch(`${BASE}/signup`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ email, password: 'hunter22', agree: '1', ...extra }).toString(),
});

(async () => {
  // --- a real signup still works, and still gets its starter profile ---
  let r = await signup('rita@example.com');
  ok('a valid address signs up (302 to the app)', r.status === 302, r.status);
  const acc = db.getAccountByEmail('rita@example.com');
  ok('the account exists', !!acc);
  ok('and is seeded with a starter profile', acc && db.getProfiles(acc.id).length === 1);

  // --- addresses that are not addresses are refused ---
  const bad = [
    ["x';window.__pwned=1;//", 'a JS-string break-out'],
    ['<img src=x onerror=alert(1)>', 'an HTML tag'],
    ['notanemail', 'no @ at all'],
    ['no@domain', 'no dot in the domain'],
    ['two@@at.com', 'two @ signs'],
    ['sp ace@example.com', 'whitespace'],
    ['@example.com', 'empty local part'],
    ['a@.com', 'empty domain label'],
  ];
  for (const [email, why] of bad) {
    const rr = await signup(email);
    const made = !!db.getAccountByEmail(email.trim().toLowerCase().slice(0, 120));
    ok(`refused: ${why}`, rr.status === 400 && !made, `status ${rr.status}, account created: ${made}`);
  }

  // --- ordinary addresses that must NOT be collateral damage ---
  const good = ['first.last@example.co.uk', 'name+tag@example.com', "o'brien@example.com", 'user_name@sub.example.com'];
  for (const email of good) {
    const rr = await signup(email);
    ok(`accepted: ${email}`, rr.status === 302 && !!db.getAccountByEmail(email), rr.status);
  }

  // --- an account that predates the check must still be able to log in ---
  const legacy = db.createAccount({ email: 'legacy-no-at-sign', passHash: '', salt: '' });
  const h = auth.hashPassword('hunter22');
  db.updateAccount(legacy.id, h);
  const li = await fetch(`${BASE}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'legacy-no-at-sign', password: 'hunter22' }).toString(),
  });
  ok('an existing account with a malformed address can still log in', li.status === 302, li.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
