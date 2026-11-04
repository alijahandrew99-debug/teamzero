// /u/<token> suite. The page confirms the address back to the reader, and that
// address is a LEAD's — imported from a CSV, pushed through /v1, or found by a
// prospecting run — so it is attacker-shaped data as far as this page is
// concerned. The token is HMAC-signed, but the signing key falls back to a
// shared literal when SESSION_SECRET is unset, so the page must not depend on
// the signature to be safe to render.
process.env.PORT = '8141';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-unsub-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8141';
process.env.SESSION_SECRET = 'test-secret-for-this-suite';

require('./server.js');
const db = require('./lib/db');
const suppress = require('./lib/suppression');

const BASE = 'http://127.0.0.1:8141';
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 220) : '')); };

(async () => {
  const acct = db.createAccount({ email: 'shop@example.com', passHash: 'h', salt: 's' });

  // --- the ordinary case still reads correctly ---
  let tok = suppress.tokenFor(acct.id, 'Rita@Example.com');
  let r = await fetch(`${BASE}/u/${tok}`);
  let body = await r.text();
  ok('a normal unsubscribe confirms the address', r.status === 200 && body.includes('<b>rita@example.com</b>'),
    body.slice(body.indexOf('We’ve removed'), body.indexOf('We’ve removed') + 70));
  ok('and the address is actually suppressed', suppress.isSuppressed(acct.id, 'rita@example.com').blocked === true);

  // --- an address carrying markup must not reach the page as markup ---
  const evil = `x<img src=x onerror="alert(1)">@evil.test`;
  tok = suppress.tokenFor(acct.id, evil);
  r = await fetch(`${BASE}/u/${tok}`);
  body = await r.text();
  ok('no raw <img from the address lands in the page', !/<img\s/i.test(body),
    body.slice(Math.max(0, body.indexOf('removed') - 20), body.indexOf('removed') + 120));
  // The text "onerror=" survives as text; what must not survive is the quote
  // that would turn it into an attribute.
  ok('the quote that would open an attribute is escaped',
    !/onerror="/i.test(body) && body.includes('onerror=&quot;'));
  ok('the address is still shown, escaped', body.includes('&lt;img'), body.includes('&lt;') ? 'ok' : 'not escaped');
  ok('and it is still suppressed, so the opt-out is honoured',
    suppress.isSuppressed(acct.id, evil).blocked === true);

  // --- a quote must not break out of the surrounding markup either ---
  const quoted = `a"'b@evil.test`;
  tok = suppress.tokenFor(acct.id, quoted);
  body = await (await fetch(`${BASE}/u/${tok}`)).text();
  ok('quotes in the address are escaped', body.includes('&quot;') && body.includes('&apos;'),
    body.slice(body.indexOf('removed'), body.indexOf('removed') + 70));

  // --- a token that does not verify still says nothing useful ---
  r = await fetch(`${BASE}/u/${Buffer.from('acct|a@b.com|deadbeef').toString('base64url')}`);
  body = await r.text();
  ok('a forged token is refused', body.includes('Link not recognised'));

  // --- one-click POST is unchanged ---
  tok = suppress.tokenFor(acct.id, 'sam@example.com');
  r = await fetch(`${BASE}/u/${tok}`, { method: 'POST' });
  ok('one-click POST still returns a bare OK', r.status === 200 && (await r.text()) === 'OK');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
