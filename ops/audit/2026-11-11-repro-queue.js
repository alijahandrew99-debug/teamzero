// AUDIT REPRO 2026-11-11 — lens (d): the call-back queue's parked rows.
//
// Evidence for finding 1 of ops/audit/2026-11-11.md. Drives the REAL server
// over HTTP and waits on the REAL 60-second queue timer; the only thing stubbed
// is Twilio's REST call, which records what it would have dialled instead of
// dialling it. Changes no source file and writes to a throwaway DATA_DIR.
//
// Not a test suite and not wired into anything: it takes ~140 seconds because
// it waits out two queue ticks. Run it with `node ops/audit/2026-11-11-repro-queue.js`.
//
// What it shows, in order:
//   PHASE 0  a form request on an account that cannot call is parked `queued`
//            with NO dueAt -- i.e. due again on every tick, for ever.
//   PHASE 1  20 such rows hold the whole install's 20-dials-per-tick budget, so
//            a PAYING tenant's overnight call-back is never dialled.
//   PHASE 2  with those rows cleared, a 45-day-old request is dialled, and a
//            shop whose local time is before 9am has its month-old backlog
//            re-stamped for 9:05 this morning.
const SP = require('path').resolve(__dirname, '../..');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.PORT = '8131';
process.env.DATA_DIR = path.join(os.tmpdir(), 'dp-queue-' + Date.now());
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8131';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '';
process.env.OWNER_EMAILS = 'nobody@nowhere.test'; process.env.DEV_UNLOCK = '1';

const aiEarly = require(SP + '/lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = async () => JSON.stringify({ say: 'ok', action: 'continue', urgency: 'routine' });
aiEarly.callAI = (...a) => (global.__aiStub ? global.__aiStub(...a) : realCallAI(...a));

// Count every full rewrite of callbacks.json (db.write writes tmp then renames).
let cbWrites = 0;
const realWFS = fs.writeFileSync;
fs.writeFileSync = function (f, ...rest) {
  if (String(f).includes('callbacks.json')) cbWrites++;
  return realWFS.call(fs, f, ...rest);
};

require(SP + '/server.js');
const db = require(SP + '/lib/db'), auth = require(SP + '/lib/auth'),
      voice = require(SP + '/lib/voice'), callback = require(SP + '/lib/callback'),
      suppress = require(SP + '/lib/suppression'), plans = require(SP + '/lib/plans');

// Stub the Twilio REST call: record who we would have dialled.
const dials = [];
voice.placeCall = async ({ to, from }) => {
  dials.push({ to, from, at: new Date().toISOString() });
  return { sid: 'CAstub' + String(dials.length).padStart(26, '0'), status: 'queued' };
};

const say = (s) => console.log(s);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rowsOf = (accId) => db.getCallbacks(accId, 500);

(async () => {
  await sleep(700);
  const { passHash, salt } = auth.hashPassword('x');

  // --- a TRIAL account: signed up, never bought a plan. The most common account there is.
  const trial = db.createAccount({ email: 'trial@shop.test', passHash, salt });
  db.createProfile(trial.id, { name: 'Trial Plumbing', offer: 'plumbing', audience: 'homeowners' });
  const trialSlug = callback.ensureFormSlug(db.getAccount(trial.id));

  // --- a PAYING Front Desk account with a live number and minutes to spare.
  const pay = db.createAccount({ email: 'pay@shop.test', passHash, salt });
  db.updateAccount(pay.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: '+15550001111', enabled: true, agentName: 'Sarah', record: false, timezone: 'Europe/London' } });
  db.createProfile(pay.id, { name: 'Ace Plumbing', offer: 'plumbing repair', audience: 'homeowners' });
  say(`paying account voiceAllowed -> ${JSON.stringify(plans.voiceAllowed(db.getAccount(pay.id), false))}`);
  say(`paying account tz -> ${voice.tzFor(db.getAccount(pay.id))}, within calling hours: ${JSON.stringify(callback.withinCallingHours(voice.tzFor(db.getAccount(pay.id))))}`);

  // A second paying shop, in a timezone where it is currently BEFORE 9am: the
  // overnight case. Its parked rows should be re-stamped for the morning.
  const chi = db.createAccount({ email: 'chi@shop.test', passHash, salt });
  db.updateAccount(chi.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: '+15550002222', enabled: true, agentName: 'Sarah', record: false, timezone: 'America/Chicago' } });
  db.createProfile(chi.id, { name: 'Dawn Plumbing', offer: 'plumbing', audience: 'homeowners' });
  const chiOld = db.addCallback(chi.id, { source: 'form', name: 'Old Request', phone: '+13125557733',
    phoneKey: suppress.phoneKey('+13125557733'), need: 'furnace', status: 'queued',
    consent: true, consentText: 'I agree...', consentAt: iso(30), at: iso(30) });

  // ========== PHASE 0: the public form on a trial account ==========
  say('\n== PHASE 0: a real form submission on an account that cannot call ==');
  const body = new URLSearchParams({ name: 'Dana Reed', phone: '312 555 0144', need: 'water heater leaking', consent: '1' });
  const r = await fetch(`http://127.0.0.1:8131/f/${trialSlug}`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const page = await r.text();
  say(`  form POST -> ${r.status}; page promises: "${(page.match(/ring you[^<]*/) || ['(none)'])[0].trim()}"`);
  await sleep(2500);   // the form dials 1.5s later
  const parked = rowsOf(trial.id)[0];
  say(`  row status: ${parked.status}   note: "${parked.note}"`);
  say(`  dueAt: ${JSON.stringify(parked.dueAt)}   -> due on every tick: ${!parked.dueAt}`);
  say(`  dials so far: ${dials.length}`);

  // ========== PHASE 1: 20 parked rows, one paying tenant's due call-back ==========
  say('\n== PHASE 1: 20 parked rows ahead of a paying tenant in the GLOBAL queue ==');
  for (let i = 0; i < 20; i++) {
    db.addCallback(trial.id, { source: 'form', name: 'Tester ' + i, phone: '+1312555' + String(2000 + i),
      phoneKey: suppress.phoneKey('+1312555' + String(2000 + i)), need: 'test', status: 'queued',
      consent: true, consentText: 'I agree...', consentAt: iso(2), at: iso(2) });
  }
  // The paying shop's own call-back: requested LAST NIGHT at 11pm, parked for
  // the morning by quiet hours, due now. This is the promise the form makes.
  const overnight = db.addCallback(pay.id, { source: 'form', name: 'Maria Lopez', phone: '+13125559911',
    phoneKey: suppress.phoneKey('+13125559911'), need: 'no hot water', status: 'queued',
    consent: true, consentText: 'I agree...', consentAt: iso(0.4), at: iso(0.4),
    dueAt: new Date(Date.now() - 120000).toISOString() });
  // And an ancient one for the same paying shop: requested 45 days ago, parked
  // back when the shop had run out of minutes, never dialled since.
  const ancient = db.addCallback(pay.id, { source: 'form', name: 'Ken Barnes', phone: '+13125559922',
    phoneKey: suppress.phoneKey('+13125559922'), need: 'dripping tap', status: 'queued',
    consent: true, consentText: 'I agree...', consentAt: iso(45), at: iso(45) });

  const dueNow = db.readCollection('callbacks').filter((c) => c.status === 'queued' && (!c.dueAt || Date.parse(c.dueAt) <= Date.now()));
  say(`  rows due this tick: ${dueNow.length} (queue dials at most 20/tick, oldest-first by insertion)`);
  say(`  position of the paying shop's overnight request in that list: ${dueNow.findIndex((c) => c.id === overnight.id) + 1}`);

  const w0 = cbWrites, d0 = dials.length;
  say('  waiting for one 60s queue tick...');
  await sleep(64000);
  say(`  dials placed by the tick: ${dials.length - d0}`);
  say(`  paying shop's overnight row status: ${rowsOf(pay.id).find((c) => c.id === overnight.id).status}`);
  say(`  callbacks.json full rewrites during the tick: ${cbWrites - w0}`);
  say(`  => STARVED: the paying tenant's due call-back was ${dials.length === d0 ? 'NEVER DIALLED' : 'dialled'}`);

  // ========== PHASE 2: clear the parked rows; what happens to the old ones ==========
  say('\n== PHASE 2: an operator clears the 20 parked rows. Next tick: ==');
  for (const c of rowsOf(trial.id)) db.updateCallback(trial.id, c.id, { status: 'blocked', note: 'cleared by hand' });
  const d1 = dials.length;
  say('  waiting for one more 60s queue tick...');
  await sleep(64000);
  say(`  dials placed: ${dials.length - d1} -> ${JSON.stringify(dials.slice(d1).map((x) => x.to))}`);
  const a = rowsOf(pay.id).find((c) => c.id === ancient.id);
  const o = rowsOf(pay.id).find((c) => c.id === overnight.id);
  const c2 = rowsOf(chi.id).find((c) => c.id === chiOld.id);
  say(`  pre-9am shop's 30-day-old row: ${c2.status}  dueAt ${c2.dueAt || '-'}  note "${c2.note || ''}"`);
  say(`  overnight (0.4 days old): ${o.status}`);
  say(`  ancient   (45 days old): ${a.status}  calledAt ${a.calledAt || '-'}`);
  say(`  => a 45-day-old request was dialled: ${a.status === 'called'}`);
  say(`  (callbackAllowed age check for source 'form': ${JSON.stringify(callback.callbackAllowed({ source: 'form', consent: true, phone: '+13125559922', consentText: 'x', consentAt: iso(400) }))})`);

  say(`\ntotal dials: ${dials.length}; total callbacks.json rewrites: ${cbWrites}`);
  process.exit(0);
})();
