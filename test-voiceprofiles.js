// Per-business phone lines. Two businesses on one account, each with its own
// number and script: calls to each number must get THAT business's
// receptionist; saves must touch only the business named; the autofilled
// phone script must persist with the profile; legacy account-level setups
// must keep answering untouched.
process.env.PORT = '8103'; process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'dp-vp-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.PUBLIC_URL = 'http://127.0.0.1:8103';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.OWNER_EMAILS = 'owner@x.com'; process.env.DEV_UNLOCK = '1';
const aiEarly = require('./lib/ai');
const realCallAI = aiEarly.callAI;
global.__aiStub = async () => JSON.stringify({ say: 'How can I help?', action: 'continue', urgency: 'routine' });
aiEarly.callAI = (...a) => (global.__aiStub ? global.__aiStub(...a) : realCallAI(...a));
require('./server.js');
const crypto = require('crypto');
const db = require('./lib/db'), auth = require('./lib/auth');
let pass = 0, fail = 0, seq = 0;
const ok = (l, c, x) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && x !== undefined ? ' -> ' + String(x).slice(0, 250) : '')); };

function sign(url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', 'testtoken').update(Buffer.from(data, 'utf8')).digest('base64');
}
async function hook(path, params) {
  const url = 'http://127.0.0.1:8103' + path;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'http', 'X-Twilio-Signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
}

const NUM_A = '+15550002222', NUM_B = '+15550003333', CALLER = '+15558880001';

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  const { passHash, salt } = auth.hashPassword('testpass123');
  const acc = db.createAccount({ email: 'multi@x.com', passHash, salt });
  db.updateAccount(acc.id, { subStatus: 'active', tier: 'complete', plan: 'pro' });
  const pA = db.createProfile(acc.id, { name: 'Ace Plumbing', offer: 'plumbing' });
  const pB = db.createProfile(acc.id, { name: 'Bright Roofing', offer: 'roofing' });
  db.saveProfileVoice(acc.id, pA.id, { number: NUM_A, numberSid: 'PNa', enabled: true, agentName: 'Sarah', record: false, spamFilter: false });
  db.saveProfileVoice(acc.id, pB.id, { number: NUM_B, numberSid: 'PNb', enabled: true, agentName: 'Miguel', record: false, spamFilter: false });

  const login = await fetch('http://127.0.0.1:8103/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=multi%40x.com&password=testpass123' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  async function api(path, body, method) {
    const r = await fetch('http://127.0.0.1:8103' + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  console.log('== each number answers as ITS business ==');
  let r = await hook('/voice/incoming', { CallSid: 'CA' + ++seq, To: NUM_A, From: CALLER });
  ok('number A: Ace Plumbing, agent Sarah', /Ace Plumbing/.test(r.text) && /Sarah/.test(r.text), r.text);
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++seq, To: NUM_B, From: CALLER });
  ok('number B: Bright Roofing, agent Miguel', /Bright Roofing/.test(r.text) && /Miguel/.test(r.text), r.text);
  ok('A never leaks into B', !/Ace Plumbing|Sarah/.test(r.text));

  console.log('== saving one business leaves the other alone ==');
  await api('/api/voice/save', { profileId: pA.id, greeting: 'How can Ace help today?', agentName: 'Sarah', enabled: true });
  const freshA = db.getProfile(acc.id, pA.id), freshB = db.getProfile(acc.id, pB.id);
  ok('A got the new greeting', freshA.voice.greeting === 'How can Ace help today?', freshA.voice.greeting);
  ok('A kept its number through the save', freshA.voice.number === NUM_A, freshA.voice.number);
  ok('B untouched', freshB.voice.agentName === 'Miguel' && !freshB.voice.greeting, JSON.stringify(freshB.voice).slice(0, 120));

  console.log('== the autofilled phone script saves WITH the business ==');
  const rr = await api('/api/profile/save', { name: 'Crisp Cleaning', offer: 'cleaning',
    voiceDraft: { agentName: 'Dana', greeting: 'what needs cleaning?', qualifying: 'How big is the space?' } });
  const pC = db.getProfile(acc.id, rr.json.profile.id);
  ok('new business created with drafted script', pC && pC.voice && pC.voice.agentName === 'Dana' && /cleaning/.test(pC.voice.greeting), pC && JSON.stringify(pC.voice || {}).slice(0, 150));
  ok('drafted business has NO number yet (gets its own)', !(pC.voice || {}).number);

  console.log('== moving the number between businesses ==');
  r = await api('/api/voice/numbers/reassign', { toProfileId: pC.id });
  ok('ambiguous move (two lines held) is refused', r.status === 400 && /which one/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await api('/api/voice/numbers/reassign', { toProfileId: pC.id, fromProfileId: pA.id });
  ok('explicit move succeeds', r.json.ok === true && r.json.number === NUM_A, JSON.stringify(r.json));
  const afterMove = db.getProfile(acc.id, pC.id);
  ok('Crisp Cleaning now holds the number', afterMove.voice.number === NUM_A);
  const donor = db.getProfile(acc.id, pA.id);
  ok('the donor business lost it (one line, one owner)', !donor.voice.number);
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++seq, To: afterMove.voice.number, From: CALLER });
  ok('the moved number now answers as Crisp Cleaning / Dana', /Crisp Cleaning/.test(r.text) && /Dana/.test(r.text), r.text);
  // put it back so the remaining tests see the original layout
  await api('/api/voice/numbers/reassign', { toProfileId: donor.id, fromProfileId: pC.id });

  console.log('== LEGACY account-level voice keeps answering (old customers) ==');
  const { passHash: ph2, salt: s2 } = auth.hashPassword('x');
  const legacy = db.createAccount({ email: 'legacy@x.com', passHash: ph2, salt: s2 });
  db.updateAccount(legacy.id, { subStatus: 'active', tier: 'frontdesk', plan: 'pro',
    voice: { number: '+15550004444', numberSid: 'PNleg', enabled: true, agentName: 'Rosa', record: false, spamFilter: false } });
  db.createProfile(legacy.id, { name: 'Legacy Lawncare', offer: 'lawn care' });
  r = await hook('/voice/incoming', { CallSid: 'CA' + ++seq, To: '+15550004444', From: CALLER });
  ok('legacy number still answers with its business + agent', /Legacy Lawncare/.test(r.text) && /Rosa/.test(r.text), r.text);

  console.log('== per-business state reaches the app ==');
  const st = await api('/api/state');
  const profs = st.json.profiles || [];
  const stA = profs.find((x) => x.id === pA.id), stB = profs.find((x) => x.id === pB.id);
  ok('profile A carries its own voice config', stA && stA.voice && stA.voice.number === NUM_A, stA && JSON.stringify(stA.voice || {}).slice(0, 100));
  ok('profile B carries its own voice config', stB && stB.voice && stB.voice.agentName === 'Miguel');

  console.log('== line cap: a paying account cannot rent endless numbers ==');
  // A and B (or their swap) hold 2 lines already; a third buy must be refused
  // before any Twilio call is attempted.
  const pD = (await api('/api/profile/save', { name: 'Fourth Venture', offer: 'stuff' })).json.profile;
  r = await api('/api/voice/numbers/buy', { phoneNumber: '+15550009999', profileId: pD.id });
  ok('third line refused with a human answer', r.status === 400 && /2 phone lines/.test(r.json.error || ''), JSON.stringify(r.json));

  console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS', e); process.exit(1); });
