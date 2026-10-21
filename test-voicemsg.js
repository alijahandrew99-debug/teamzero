// The over-limit message path, /voice/msg, is the graceful failure: the plan's
// minutes are gone, so instead of hanging up on the customer's customer we take
// a message. It is answered on a LIVE call, which means it answers to Twilio's
// clock — 15 seconds, after which Twilio speaks "an application error has
// occurred" to the caller and the graceful failure fails loudly.
//
// The system mailbox is the thing most likely to be slow here (smtp.js allows
// 20s to connect, 30s idle), so this drives the route with a mail server that
// accepts the socket and never speaks.
const net = require('net');
const blackhole = net.createServer(() => { /* accept, never reply */ });
blackhole.listen(2526, '127.0.0.1');

process.env.PORT = '8108'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-vmsg-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8108';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
process.env.SYSTEM_SMTP_USER = 'sys@dawnpipe.test'; process.env.SYSTEM_SMTP_PASS = 'x';
process.env.SYSTEM_SMTP_HOST = 'localhost'; process.env.SYSTEM_SMTP_PORT = '2526';

require('./server.js');
const crypto = require('crypto');
const db = require('./lib/db'), auth = require('./lib/auth'), plans = require('./lib/plans');
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 200) : '')); };

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
  return crypto.createHmac('sha1', 'testtoken').update(Buffer.from(data, 'utf8')).digest('base64');
}
async function hook(path, params) {
  const url = 'http://127.0.0.1:8108' + path;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'http', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}
const BIZ = '+15550003333', CALLER = '+15557770005';

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const { passHash, salt } = auth.hashPassword('x');
  const acc = db.createAccount({ email: 'shop@vmsg.test', passHash, salt });
  // Front Desk with every included minute already spent.
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voiceMinutesUsed: 99999, voicePeriod: plans.periodKey(),
    voice: { number: BIZ, enabled: true, agentName: 'Sarah', record: false } });
  db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing repair', audience: 'homeowners' });

  console.log('== out of minutes: take a message instead of hanging up ==');
  const SID = 'CAvmsg0000000000000000000000001';
  const inc = await hook('/voice/incoming', { CallSid: SID, To: BIZ, From: CALLER, StirVerstat: 'TN-Validation-Passed-A' });
  ok('the call is answered, not dropped', /<Gather/.test(inc.text));
  ok('and routed to the message path', /\/voice\/msg/.test(inc.text), inc.text.slice(0, 200));

  console.log('== the message path answers to Twilio\'s clock, not the mail server\'s ==');
  const t0 = Date.now();
  const r = await hook('/voice/msg', { CallSid: SID, To: BIZ, From: CALLER, SpeechResult: 'my boiler is out, please call me back' });
  const ms = Date.now() - t0;
  ok(`answered in ${ms}ms, well inside Twilio's 15s deadline`, ms < 3000, ms + 'ms');
  ok('and the caller is told their message landed', /passed that on/.test(r.text), r.text.slice(0, 200));
  ok('the message is in the diary', db.readCollection('appointments').filter((a) => a.accountId === acc.id).length === 1);

  blackhole.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
