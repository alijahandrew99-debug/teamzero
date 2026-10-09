// Voice minute billing suite. Twilio delivers status callbacks AT LEAST once, so
// the same completed call can arrive twice — a retry after our ack timed out, or
// a redeploy that killed the first response after it had already billed. Every
// webhook here is a REAL signed Twilio POST against the running server, so a pass
// means the whole route is idempotent, not just a helper.
process.env.PORT = '8104'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-vbill-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8104';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
// voice.js destructures callAI at require time, so the stub must be in place
// BEFORE the server pulls it in.
const aiEarly = require('./lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = null;
aiEarly.callAI = (...a) => (global.__aiStub ? global.__aiStub(...a) : realCallAI(...a));
require('./server.js');
const crypto = require('crypto');
const db = require('./lib/db'), auth = require('./lib/auth'), voice = require('./lib/voice');
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 300) : '')); };

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', 'testtoken').update(Buffer.from(data, 'utf8')).digest('base64');
}
async function hook(path, params) {
  const url = 'http://127.0.0.1:8104' + path;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'http', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}
const settle = () => new Promise((r) => setTimeout(r, 250));

const BIZ = '+15550003333', CUST = '+15558884444', CUST2 = '+15558885555';

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const { passHash, salt } = auth.hashPassword('x');
  const acc = db.createAccount({ email: 'shop@billing.test', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: BIZ, enabled: true, agentName: 'Sarah', record: false } });
  db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing repair', audience: 'homeowners' });
  global.__aiStub = async () => JSON.stringify({ say: 'Sure — what do you need?', action: 'continue', urgency: 'routine' });
  const minutes = () => Number(db.getAccount(acc.id).voiceMinutesUsed || 0);

  console.log('== a real call bills its minutes once ==');
  const SID = 'CAbill0000000000000000000000001';
  await hook('/voice/incoming', { CallSid: SID, To: BIZ, From: CUST, StirVerstat: 'TN-Validation-Passed-A' });
  await hook('/voice/turn', { CallSid: SID, SpeechResult: 'my kitchen sink is leaking', Confidence: '0.95' });
  ok('nothing billed before the call ends', minutes() === 0, minutes());
  await hook('/voice/status', { CallSid: SID, CallStatus: 'completed', CallDuration: '120', From: CUST, To: BIZ });
  await settle();
  ok('a 120s call billed 2 minutes', minutes() === 2, minutes());

  console.log('== an identical retry bills nothing ==');
  await hook('/voice/status', { CallSid: SID, CallStatus: 'completed', CallDuration: '120', From: CUST, To: BIZ });
  await settle();
  ok('still 2 minutes after one retry', minutes() === 2, minutes());
  await hook('/voice/status', { CallSid: SID, CallStatus: 'completed', CallDuration: '120', From: CUST, To: BIZ });
  await settle();
  ok('still 2 minutes after a second retry', minutes() === 2, minutes());

  console.log('== a callback reporting a LONGER call tops the minutes up ==');
  await hook('/voice/status', { CallSid: SID, CallStatus: 'completed', CallDuration: '300', From: CUST, To: BIZ });
  await settle();
  ok('5 minutes total, charged as a 3-minute top-up', minutes() === 5, minutes());

  console.log('== a deploy wiped the in-memory call: still billed, still once ==');
  const SID2 = 'CAbill0000000000000000000000002';
  await hook('/voice/incoming', { CallSid: SID2, To: BIZ, From: CUST2, StirVerstat: 'TN-Validation-Passed-A' });
  await hook('/voice/turn', { CallSid: SID2, SpeechResult: 'need a quote for a bathroom', Confidence: '0.95' });
  // What a redeploy leaves behind: a persisted record, no in-memory call.
  db.saveCall(acc.id, { sid: SID2, status: 'in-progress' });
  voice.endCall(SID2);
  const before = minutes();
  await hook('/voice/status', { CallSid: SID2, CallStatus: 'completed', CallDuration: '60', From: CUST2, To: BIZ });
  await settle();
  ok('the orphaned call still billed its minute', minutes() === before + 1, minutes());
  await hook('/voice/status', { CallSid: SID2, CallStatus: 'completed', CallDuration: '60', From: CUST2, To: BIZ });
  await settle();
  ok('and a retry of it bills nothing', minutes() === before + 1, minutes());

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
