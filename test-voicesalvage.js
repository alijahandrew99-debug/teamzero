// Hangup-salvage suite. When a call just STOPS, /voice/status reads the
// transcript with the model and writes whatever the caller asked for into the
// diary. That is right for a caller who gave up mid-sentence and wrong for
// every call that already reached an ending: a robocall we hung up on, a
// caller who opted out, a caller a human took over. Salvaging those invents an
// appointment nobody made and texts a confirmation for it.
//
// Every webhook here is a REAL signed Twilio POST against the running server,
// and nothing leaves the process: the Twilio REST API is intercepted at the
// fetch layer, so a "sent" text is recorded and never sent.
process.env.PORT = '8107'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-vsalv-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8107';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '+15550009999';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
// voice.js destructures callAI at require time, so the stub must be in place
// BEFORE the server pulls it in.
const aiEarly = require('./lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = null;
let salvageRuns = 0;
aiEarly.callAI = (...a) => {
  if (/STRICT JSON/.test(String(a[0] || ''))) salvageRuns++;
  return global.__aiStub ? global.__aiStub(...a) : realCallAI(...a);
};
// No text message may ever leave a test run. Intercepting fetch (rather than
// notify.sendSMS) also catches notify's own internal calls.
const smsSent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (/api\.twilio\.com/.test(u)) {
    const body = new URLSearchParams(String((opts && opts.body) || ''));
    if (/\/Messages\.json$/.test(u)) smsSent.push({ to: body.get('To'), body: body.get('Body') });
    return new Response(JSON.stringify({ sid: 'SMstub' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, opts);
};
require('./server.js');
const crypto = require('crypto');
const db = require('./lib/db'), auth = require('./lib/auth'), suppress = require('./lib/suppression');
let pass = 0, fail = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 300) : '')); };

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', 'testtoken').update(Buffer.from(data, 'utf8')).digest('base64');
}
async function hook(path, params) {
  const url = 'http://127.0.0.1:8107' + path;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'http', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}
// Salvage runs AFTER the webhook is acked, so every assertion about it has to
// wait for the background promise to land.
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

const BIZ = '+15550003333', ROBO = '+15557770001', OPTOUT = '+15557770002', XFER = '+15557770003', GAVEUP = '+15557770004';

// What the model says when asked to salvage: the most generous possible read,
// so a test that still finds no appointment proves the GATE, not a shy model.
const SALVAGE_YES = JSON.stringify({ wantsCallback: true, name: 'Dana', phone: '', company: '',
  reason: 'boiler not firing', when: 'tomorrow morning', whenISO: '', summary: 'wants someone out tomorrow morning' });

(async () => {
  await settle(800);
  const { passHash, salt } = auth.hashPassword('x');
  const acc = db.createAccount({ email: 'shop@salvage.test', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: BIZ, enabled: true, agentName: 'Sarah', record: false, transferTo: '+15551112222' } });
  db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing repair', audience: 'homeowners' });
  const appts = () => db.readCollection('appointments').filter((a) => a.accountId === acc.id);
  const outcome = (sid) => (db.callBySid(sid) || {}).outcome;
  // A caller who names a need and a time, which is what makes salvage tempting
  // on calls that had already reached an ending.
  const SAID = 'my boiler is not firing, can someone come tomorrow morning';

  const answer = (action) => async (prompt) => (/STRICT JSON/.test(prompt) ? SALVAGE_YES
    : JSON.stringify({ say: 'Right you are.', action, urgency: 'routine' }));

  console.log('== a robocall we hung up on is not turned into an appointment ==');
  global.__aiStub = answer('continue');
  const S1 = 'CAsalv0000000000000000000000001';
  await hook('/voice/incoming', { CallSid: S1, To: BIZ, From: ROBO, StirVerstat: 'TN-Validation-Passed-A' });
  await hook('/voice/turn', { CallSid: S1, From: ROBO, To: BIZ, Confidence: '0.95',
    SpeechResult: 'press 1 to renew your car warranty, this is your final notice' });
  ok('the tripwire ended it as spam', outcome(S1) === 'spam', outcome(S1));
  let n = appts().length, s = salvageRuns;
  await hook('/voice/status', { CallSid: S1, CallStatus: 'completed', CallDuration: '95', From: ROBO, To: BIZ });
  await settle();
  ok('no appointment from the robocall', appts().length === n, appts().length - n);
  ok('and no AI spend salvaging it', salvageRuns === s, salvageRuns - s);
  ok('outcome stays spam', outcome(S1) === 'spam', outcome(S1));

  console.log('== an opt-out is never answered with a confirmation text ==');
  global.__aiStub = answer('dnc');
  const S2 = 'CAsalv0000000000000000000000002';
  await hook('/voice/incoming', { CallSid: S2, To: BIZ, From: OPTOUT, StirVerstat: 'TN-Validation-Passed-A' });
  await hook('/voice/turn', { CallSid: S2, From: OPTOUT, To: BIZ, Confidence: '0.95',
    SpeechResult: SAID + ', and after that take me off your list and never call me again' });
  ok('the number is suppressed', suppress.isPhoneSuppressed(acc.id, OPTOUT).blocked);
  n = appts().length; let m = smsSent.length;
  await hook('/voice/status', { CallSid: S2, CallStatus: 'completed', CallDuration: '50', From: OPTOUT, To: BIZ });
  await settle();
  ok('no appointment built out of what they said before opting out', appts().length === n, appts().length - n);
  ok('no text to the number that just opted out', smsSent.length === m, JSON.stringify(smsSent.slice(m)));
  ok('outcome stays do-not-call', outcome(S2) === 'do-not-call', outcome(S2));

  console.log('== a call a human took over is left to the human ==');
  global.__aiStub = answer('transfer');
  const S3 = 'CAsalv0000000000000000000000003';
  await hook('/voice/incoming', { CallSid: S3, To: BIZ, From: XFER, StirVerstat: 'TN-Validation-Passed-A' });
  const t3 = await hook('/voice/turn', { CallSid: S3, From: XFER, To: BIZ, SpeechResult: SAID, Confidence: '0.95' });
  ok('the turn dialled the transfer number', /<Dial/.test(t3.text));
  await hook('/voice/dialback', { CallSid: S3, From: XFER, To: BIZ, DialCallStatus: 'completed' });
  ok('marked transferred', outcome(S3) === 'transferred', outcome(S3));
  n = appts().length; m = smsSent.length;
  await hook('/voice/status', { CallSid: S3, CallStatus: 'completed', CallDuration: '240', From: XFER, To: BIZ });
  await settle();
  ok('no phantom appointment after a real person took the call', appts().length === n, appts().length - n);
  ok('and the caller is not texted a booking nobody made', smsSent.length === m, JSON.stringify(smsSent.slice(m)));
  ok('outcome stays transferred', outcome(S3) === 'transferred', outcome(S3));

  console.log('== the call salvage EXISTS for still works ==');
  global.__aiStub = answer('continue');
  const S4 = 'CAsalv0000000000000000000000004';
  await hook('/voice/incoming', { CallSid: S4, To: BIZ, From: GAVEUP, StirVerstat: 'TN-Validation-Passed-A' });
  await hook('/voice/turn', { CallSid: S4, From: GAVEUP, To: BIZ, SpeechResult: SAID, Confidence: '0.95' });
  n = appts().length;
  // No ending of any kind — they simply hung up mid-conversation.
  await hook('/voice/status', { CallSid: S4, CallStatus: 'completed', CallDuration: '45', From: GAVEUP, To: BIZ });
  await settle(900);
  ok('a caller who just hung up is still rescued into the diary', appts().length === n + 1, appts().length - n);
  ok('and recorded as a callback', outcome(S4) === 'callback', outcome(S4));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
