// Spam-filter suite. Every webhook here is a REAL signed Twilio POST against
// the running server — the same HMAC path production verifies — so a pass
// means the whole route works, not just the helper functions.
process.env.PORT = '8102'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-spam-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8102';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
// voice.js destructures callAI at require time, so the stub must be in place
// BEFORE the server pulls it in. The wrapper delegates to a swappable global.
const aiEarly = require('./lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = null;
aiEarly.callAI = (...a) => (global.__aiStub ? global.__aiStub(...a) : realCallAI(...a));
require('./server.js');
const crypto = require('crypto');
const db = require('./lib/db'), auth = require('./lib/auth'), ai = require('./lib/ai'), spamlib = require('./lib/spam'), suppress = require('./lib/suppression');
let pass = 0, fail = 0, callSeq = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 300) : '')); };

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', 'testtoken').update(Buffer.from(data, 'utf8')).digest('base64');
}
async function hook(path, params) {
  const url = 'http://127.0.0.1:8102' + path;
  const body = new URLSearchParams(params).toString();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'http', 'X-Twilio-Signature': sign(url, params) }, body });
  return { status: r.status, text: await r.text() };
}

const BIZ_NUM = '+15550001111';
const SPAMMER = '+15559990000';
const CUSTOMER = '+15558887777';
// A number that passes screening and TALKS becomes a known caller and is
// never screened again — so each spam scenario gets its own fresh number.
const SPAM_DEAD = '+15556660000';

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const { passHash, salt } = auth.hashPassword('x');
  const acc = db.createAccount({ email: 'shop@x.com', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: BIZ_NUM, enabled: true, agentName: 'Sarah', record: false } });
  db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing repair', audience: 'homeowners' });
  global.__aiStub = async () => JSON.stringify({ say: 'Sure — what do you need?', action: 'continue', urgency: 'routine' });

  console.log('== a normal verified caller is NOT screened ==');
  let r = await hook('/voice/incoming', { CallSid: 'CA' + ++callSeq, To: BIZ_NUM, From: CUSTOMER, StirVerstat: 'TN-Validation-Passed-A' });
  ok('answered with the normal greeting', /reached Ace Plumbing/.test(r.text) && !/what.s the call about/i.test(r.text), r.text);

  console.log('== anonymous caller gets the screen ==');
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++callSeq, To: BIZ_NUM, From: 'anonymous' });
  ok('screen question asked', /Quick one before I put you through/.test(r.text), r.text);
  ok('disclosure still in the screen (legal)', /AI receptionist/.test(r.text), r.text);

  console.log('== failed STIR/SHAKEN gets the screen ==');
  const sid3 = 'CA' + ++callSeq;
  r = await hook('/voice/incoming', { CallSid: sid3, To: BIZ_NUM, From: SPAMMER, StirVerstat: 'TN-Validation-Failed-B' });
  ok('screened', /Quick one before I put you through/.test(r.text), r.text);

  console.log('== a human passes the screen and flows into the normal call ==');
  r = await hook('/voice/turn', { CallSid: sid3, SpeechResult: 'hi my kitchen sink is leaking', Confidence: '0.92' });
  ok('conversation continues', /Sure — what do you need\?/.test(r.text) && /<Gather/.test(r.text), r.text);

  console.log('== dead air on the screen = screened out + strike ==');
  const sid4 = 'CA' + ++callSeq;
  await hook('/voice/incoming', { CallSid: sid4, To: BIZ_NUM, From: SPAM_DEAD, StirVerstat: 'TN-Validation-Failed-B' });
  await hook('/voice/turn', { CallSid: sid4, SpeechResult: '' });          // silence 1: nudge
  r = await hook('/voice/turn', { CallSid: sid4, SpeechResult: '' });      // silence 2: hangup
  ok('hung up', /<Hangup\/>/.test(r.text), r.text);
  ok('one strike recorded', spamlib.strikes(acc.id, SPAM_DEAD) === 1, spamlib.strikes(acc.id, SPAM_DEAD));
  const c4 = db.getCalls(acc.id, 20).find((c) => c.sid === sid4);
  ok('call saved as screened-out', c4 && c4.outcome === 'screened-out', c4 && c4.outcome);

  console.log('== robocall phrases trip the wire mid-call, no AI needed ==');
  global.__aiStub = async () => { throw new Error('AI must NOT be called for a tripwired robocall'); };
  const sid5 = 'CA' + ++callSeq;
  await hook('/voice/incoming', { CallSid: sid5, To: BIZ_NUM, From: SPAM_DEAD, StirVerstat: 'TN-Validation-Failed-B' });
  r = await hook('/voice/turn', { CallSid: sid5, SpeechResult: 'we have been trying to reach you about your car warranty press 1 to speak to an agent', Confidence: '0.95' });
  ok('hung up on the robocall', /take solicitations/.test(r.text) && /<Hangup\/>/.test(r.text), r.text);
  const c5 = db.getCalls(acc.id, 20).find((c) => c.sid === sid5);
  ok('call saved as spam', c5 && c5.outcome === 'spam', c5 && c5.outcome);
  ok('2 more strikes (3 total) auto-blocked the number', suppress.isPhoneSuppressed(acc.id, SPAM_DEAD).blocked);

  console.log('== blocked number is now REJECTED before answering ==');
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++callSeq, To: BIZ_NUM, From: SPAM_DEAD });
  ok('<Reject> — costs nothing', /<Reject/.test(r.text), r.text);

  console.log('== spam call minutes are NOT billed ==');
  const before = (db.getAccount(acc.id).usage || {}).voiceMin || 0;
  await hook('/voice/status', { CallSid: sid5, CallStatus: 'completed', CallDuration: '45', From: SPAM_DEAD });
  const after = (db.getAccount(acc.id).usage || {}).voiceMin || 0;
  ok('voice minutes unchanged after a 45s spam call', after === before, before + ' -> ' + after);

  console.log('== AI "spam" action gets the same treatment ==');
  global.__aiStub = async () => JSON.stringify({ say: 'Take us off your list. Bye now.', action: 'spam', urgency: 'routine' });
  const SPAM2 = '+15551230001';
  const sid7 = 'CA' + ++callSeq;
  await hook('/voice/incoming', { CallSid: sid7, To: BIZ_NUM, From: SPAM2, StirVerstat: 'TN-Validation-Passed-A' });
  r = await hook('/voice/turn', { CallSid: sid7, SpeechResult: 'hello I am calling about a great opportunity for local businesses to grow with our marketing services', Confidence: '0.95' });
  ok('AI judged it spam and hung up', /Take us off your list/.test(r.text) && /<Hangup\/>/.test(r.text), r.text);
  ok('2 strikes from the AI verdict', spamlib.strikes(acc.id, SPAM2) === 2, spamlib.strikes(acc.id, SPAM2));

  console.log('== spam filter OFF disables all of it ==');
  db.updateAccount(acc.id, { voice: { ...db.getAccount(acc.id).voice, spamFilter: false } });
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++callSeq, To: BIZ_NUM, From: 'anonymous' });
  ok('anonymous caller answered normally with filter off', /reached Ace Plumbing/.test(r.text) && !/Quick one before/.test(r.text), r.text);
  db.updateAccount(acc.id, { voice: { ...db.getAccount(acc.id).voice, spamFilter: true } });

  console.log('== a KNOWN caller is never screened, even with bad signals ==');
  // CUSTOMER called earlier (sid 1). Give that call a transcript so history exists.
  db.saveCall(acc.id, { sid: 'CA1', status: 'completed', durationSec: 60,
    transcript: [{ who: 'caller', text: 'my sink leaks' }], booking: { name: 'Pat', phone: CUSTOMER } });
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++callSeq, To: BIZ_NUM, From: CUSTOMER, StirVerstat: 'TN-Validation-Failed-A' });
  ok('known caller answered normally', /reached Ace Plumbing/.test(r.text) && !/Quick one before/.test(r.text), r.text);

  console.log('== dead-air strikes decay: fresh numbers start clean ==');
  ok('unknown number has zero strikes', spamlib.strikes(acc.id, '+15550009999') === 0);

  console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS', e); process.exit(1); });
