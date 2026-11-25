// Repro + regression test for the 2026-11-25 audit, finding 3.
//
// /v1/calls and /v1/bookings share one limit, capped at 500:
//   const lim = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
// Both reads then end in `.slice(-lim)`. A negative lim turns that into
// `.slice(+n)` -- "skip the first n rows" -- so the cap disappears entirely.
// `?limit=-1` returned every row the account owns bar one.
//
// Runs the real server on a throwaway DATA_DIR. No network, nothing sent.
process.env.PORT = '8723';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-v1lim-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8723';
process.env.DEV_UNLOCK = '1';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'server.js'));
const db = require(path.join(ROOT, 'lib/db'));
const auth = require(path.join(ROOT, 'lib/auth'));
const hooks = require(path.join(ROOT, 'lib/hooks'));

const B = 'http://127.0.0.1:8723';
let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '  -> ' + String(extra).slice(0, 160) : ''));
};

const ROWS = 1200;

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const { passHash, salt } = auth.hashPassword('pw123456');
  const acc = db.createAccount({ email: 'api@v1lim.test', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro' });
  const KEY = hooks.ensureSecrets(db.getAccount(acc.id)).apiKey;

  for (let i = 0; i < ROWS; i++) {
    db.saveCall(acc.id, { sid: 'CA' + i, direction: 'inbound', to: '+15550000000', from: '+15551111111', status: 'completed', transcript: [] });
    db.addAppointment(acc.id, { profileId: 'p1', name: 'Appt' + i, reason: 'r', startsAt: new Date(Date.now() + i * 3600e3).toISOString() });
  }

  const get = (p) => fetch(B + p, { headers: { Authorization: 'Bearer ' + KEY } }).then((r) => r.json());

  console.log(`\n--- ${ROWS} calls and ${ROWS} bookings seeded; the documented cap is 500 ---`);
  for (const ep of ['/v1/calls', '/v1/bookings']) {
    ok(`${ep}?limit=500 returns 500`, (await get(ep + '?limit=500')).count === 500, (await get(ep + '?limit=500')).count);
    ok(`${ep}?limit=99999 is capped at 500`, (await get(ep + '?limit=99999')).count === 500, (await get(ep + '?limit=99999')).count);
    for (const bad of ['-1', '-5', '-500', '-99999']) {
      const c = (await get(`${ep}?limit=${bad}`)).count;
      ok(`${ep}?limit=${bad} never exceeds the 500 cap`, c <= 500, 'count=' + c);
    }
    ok(`${ep}?limit=abc falls back to the default 100`, (await get(ep + '?limit=abc')).count === 100, (await get(ep + '?limit=abc')).count);
    ok(`${ep}?limit=0 falls back to the default 100`, (await get(ep + '?limit=0')).count === 100, (await get(ep + '?limit=0')).count);
    ok(`${ep}?limit=2.7 is a whole number of rows`, Number.isInteger((await get(ep + '?limit=2.7')).count), (await get(ep + '?limit=2.7')).count);
    ok(`${ep} with no limit returns the default 100`, (await get(ep)).count === 100, (await get(ep)).count);
    ok(`${ep}?limit=1 returns 1`, (await get(ep + '?limit=1')).count === 1, (await get(ep + '?limit=1')).count);
  }

  console.log(`\n  ${pass} pass, ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})();
