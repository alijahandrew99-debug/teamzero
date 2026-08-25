// Dawnpipe Cloud — multi-tenant SaaS server. Zero dependencies (raw http).
require('./lib/env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const auth = require('./lib/auth');
const stripe = require('./lib/stripe');
const agents = require('./lib/agents');
const smtp = require('./lib/smtp');
const plans = require('./lib/plans');
const mailer = require('./lib/mailer');
const emailApi = require('./lib/emailapi');
const dnsauth = require('./lib/dnsauth');
const sending = require('./lib/sending');
const suppress = require('./lib/suppression');
const voice = require('./lib/voice');
const numbers = require('./lib/numbers');
const stats = require('./lib/stats');
const hooks = require('./lib/hooks');
const spend = require('./lib/spend');
const reps = require('./lib/reps');
const notify = require('./lib/notify');
const memory = require('./lib/leadmemory');
const { aiMode } = require('./lib/ai');

const PORT = process.env.PORT || 8090;
// Stamped from the git commit at deploy time (Render sets RENDER_GIT_COMMIT).
// Lets anyone confirm WHICH code is live from /health, instead of inferring it
// from an uptime counter that a stale instance also reports.
const BUILD_ID = (process.env.RENDER_GIT_COMMIT || process.env.BUILD_ID || 'local').slice(0, 7);

// Launch-day survival: a single unhandled error must never take the server down
// for everyone. Log it and keep serving.
process.on('uncaughtException', (e) => { try { db.logActivity('system', { agent: 'SYSTEM', msg: `uncaught: ${e.message}` }); } catch {} console.error('uncaughtException:', e); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e); });
const VIEWS = path.join(__dirname, 'views');
const view = (name) => fs.readFileSync(path.join(VIEWS, name), 'utf8');

// ---- helpers ----
function html(res, body, code = 200, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(body);
}
function json(res, data, code = 200, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}
function xml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
  res.end(body);
}
function redirect(res, location, cookie) {
  const h = { Location: location };
  if (cookie) h['Set-Cookie'] = cookie;
  res.writeHead(302, h);
  res.end();
}
const MAX_BODY = 2 * 1024 * 1024;   // 2MB — generous for a CSV paste, fatal to a flood
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let over = false;
    req.on('data', (d) => {
      if (over) return;
      b += d;
      // Unbounded buffering meant any unauthenticated POST could grow the heap
      // until the process died, taking every tenant down with it.
      if (b.length > MAX_BODY) { over = true; b = ''; try { req.destroy(); } catch {} resolve(''); }
    });
    req.on('end', () => { if (!over) resolve(b); });
    req.on('error', () => { if (!over) { over = true; resolve(''); } });
  });
}
function parseForm(body) { return Object.fromEntries(new URLSearchParams(body)); }
function parseJSON(body) { try { return body ? JSON.parse(body) : {}; } catch { return {}; } }

function seedStarterProfile(accountId, email) {
  db.createProfile(accountId, {
    name: 'My Business (edit me)',
    senderName: email.split('@')[0],
    offer: 'Describe what you sell here — the product/service and who it helps.',
    icp: 'Describe your ideal customer: industry, company size, role of the person you sell to.',
    valueProp: 'The core reason someone buys from you — the outcome you deliver.',
    proof: 'Any proof: results, case studies, notable clients, credentials.',
    tone: 'Direct, warm, concrete. No fluff, no hype.',
    cta: 'A 15-minute call, or a short reply.',
    notes: 'Edit these fields to match your business, then hit Find leads.',
  });
}

// simple CSV parse (quoted-field aware)
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (c !== '\r') field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim().toLowerCase());
  const map = { name: 'name', 'full name': 'name', title: 'title', 'job title': 'title', company: 'company', email: 'email', notes: 'notes' };
  return rows.filter((r) => r.some((c) => c.trim())).map((r) => { const o = {}; header.forEach((h, i) => { const k = map[h]; if (k) o[k] = (r[i] || '').trim(); }); return o; });
}

// ---- rate limiting ----
// Stops password brute-forcing and scripted signups farming free trials.
const hits = new Map();
function rateLimited(req, bucket, max, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  rec.n++;
  return rec.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  try { db.pruneSessions(); } catch {}
}, 10 * 60 * 1000);

// ---- legal copy ----
// Plain-English and honest about what the product does. Edit the contact email
// and company details before you take real payments.
// Bump this whenever the terms or privacy text changes. Leaving it stale after
// removing a binding refund commitment left customers who signed up under the
// old terms with no way to see that anything had changed.
const LEGAL_UPDATED = 'Last updated: 16 August 2026';
const LEGAL_TERMS = `
<h1>Terms of Service</h1><div class="updated">${LEGAL_UPDATED}</div>
<p>These terms govern your use of Dawnpipe ("the Service"). By creating an account you agree to them.</p>
<h2>What the Service does</h2>
<p>Dawnpipe researches publicly available information to identify potential business contacts, and drafts outreach emails for your review. Drafts are not sent without your approval.</p>
<h2>Phone agent (Front Desk and Complete plans)</h2>
<ul>
<li>Some plans include an AI phone agent that answers calls to your Dawnpipe number and, if you enable it, places outbound calls to your leads.</li>
<li>The agent identifies itself as an AI and states only business facts you provide. It is instructed never to invent prices or commitments, but AI output can contain errors; confirm anything that matters before relying on it.</li>
<li>Calls handled by the agent are transcribed to text and stored in your account so you can review what was said.</li>
<li>Outbound calling runs at your instruction and you are responsible for it: you must comply with the TCPA, national and state Do-Not-Call rules, and state call-consent laws, and only call numbers you may lawfully call. Numbers that ask not to be contacted are suppressed and will not be dialled again.</li>
<li>Plan minutes are talk time on calls the agent answers or places, rounded up to the next whole minute per call.</li>
</ul>
<h2>Text messages</h2>
<p>When the agent books an appointment it sends the caller one SMS confirmation, which includes "Reply STOP to opt out." We do not send marketing texts. Message and data rates may apply.</p>
<h2>Your responsibilities</h2>
<ul>
<li>You are the sender of any message you approve. You are responsible for its content and for complying with anti-spam law (including CAN-SPAM and, where applicable, GDPR/PECR).</li>
<li>You must only contact people you have a lawful basis to contact, and must honour opt-out requests promptly.</li>
<li>You must not use the Service for unlawful, deceptive, or harassing messaging.</li>
<li>You are responsible for verifying contact details before sending. Addresses labelled as unverified guesses may be inaccurate.</li>
</ul>
<h2>Accuracy</h2>
<p>Lead information and drafted copy are generated by automated research and AI, and may contain errors. Review everything before you send it. The Service is provided "as is" without warranty of accuracy or fitness for a particular purpose.</p>
<h2>Subscription and billing</h2>
<ul>
<li>Paid plans are billed monthly in advance via Stripe.</li>
<li><b>No long-term commitment:</b> the Service is month to month with no contract, no setup fee and no minimum term. You are never locked in.</li>
<li>Plan allowances (leads and phone minutes) are hard caps: when used up, the Service pauses until the monthly reset. There are no overage charges and allowances do not roll over.</li>
<li>Plans include a monthly usage allowance. We may apply fair-use limits to protect the Service.</li>
<li>You can cancel at any time; access continues to the end of the paid period. We do not provide pro-rata refunds for partial months except where required by law.</li>
</ul>
<h2>Acceptable use</h2>
<p>We may suspend accounts that generate excessive bounces or spam complaints, attempt to circumvent usage limits, or abuse the Service.</p>
<h2>Liability</h2>
<p>To the maximum extent permitted by law, our total liability is limited to the amount you paid in the previous three months. We are not liable for indirect or consequential losses, including lost business or damage to sender reputation.</p>
<h2>Indemnification</h2>
<p>The messages your account sends and the calls it places or answers are made on your behalf, to contacts you chose or who chose to call you, using content you approved. You agree to defend, indemnify and hold harmless Dawnpipe and its operators from any claim, demand, fine or expense (including reasonable legal fees) arising from those communications — including claims under the TCPA, CAN-SPAM, state do-not-call, call-recording or consumer-protection laws — except to the extent caused by our own breach of these terms.</p>
<h2>Governing law and disputes</h2>
<p>These terms are governed by the laws of the State of Illinois, without regard to conflict-of-law rules. Any dispute will be resolved by binding individual arbitration, or in the state or federal courts located in Illinois where arbitration is unavailable; you waive any right to bring or participate in a class action. Either party may seek injunctive relief in court to protect intellectual property or confidential information.</p>
<h2>Changes</h2>
<p>We may update these terms; material changes will be notified by email. Continued use constitutes acceptance.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:support@dawnpipe.com">support@dawnpipe.com</a></p>
`;
const LEGAL_PRIVACY = `
<h1>Privacy Policy</h1><div class="updated">${LEGAL_UPDATED}</div>
<p>This policy explains what we collect and why.</p>
<h2>What we collect</h2>
<ul>
<li><b>Account data:</b> your email address and a hashed password. We never store your password in readable form.</li>
<li><b>Business profile data:</b> what you enter about your business so the Service can write relevant outreach.</li>
<li><b>Lead data:</b> business contact information gathered from publicly available web sources.</li>
<li><b>Mailbox credentials:</b> if you connect a mailbox to send email, those credentials are stored on the server to send on your behalf. They are never displayed back to you or shared.</li>
<li><b>Payment data:</b> handled entirely by Stripe. We never see or store your card details.</li>
<li><b>Call and appointment data:</b> when the AI phone agent handles a call, we store a text transcript, the caller's number, and details they give the agent (name, company, reason, appointment time) so you can review and act on them.</li>
<li><b>SMS records:</b> the appointment confirmations we send and any STOP opt-outs.</li>
</ul>
<h2>How we use it</h2>
<p>Solely to operate the Service: researching leads, drafting emails, sending messages you approve, and billing. We do not sell your data or share it for advertising.</p>
<h2>Processors</h2>
<p>We use Anthropic (AI drafting, research and the wording of phone calls), Twilio (phone numbers, calls, call recordings/transcription and SMS), Stripe (payments), Hunter.io and Apollo (business email lookup, where enabled), and our hosting provider. Your business profile and lead context are sent to the AI provider to generate drafts and to conduct calls. Phone numbers, call audio and call transcripts are processed by Twilio and by the AI provider. Where you connect your own mailbox, messages are sent through your email provider using credentials you supply.</p>
<h2>Information about third parties</h2>
<p>Leads consist of business contact details from public sources. If you are a contact in someone's list and want your details removed, email us and we will remove them.</p>
<h2>Retention and your rights</h2>
<p>We keep your data while your account is active. You can request export or deletion of your account and data at any time by emailing us, and we will action it within 30 days.</p>
<h2>Security</h2>
<p>Passwords are hashed (scrypt). Traffic is served over HTTPS. No system is perfectly secure; use a unique password and an app-specific password for any connected mailbox.</p>
<h2>Contact</h2>
<p>Privacy questions or deletion requests: <a href="mailto:support@dawnpipe.com">support@dawnpipe.com</a></p>
`;

// ---- background jobs ----
// Long prospecting runs (up to 50 leads) can take many minutes. Running them
// inside the HTTP request means the browser hangs with no feedback. Instead we
// start a job, return immediately, and let the client poll for progress + ETA.
const jobs = new Map();

function startProspectJob(accountId, profileId, { count, hints, thenDraft, notify }) {
  const id = db.uid();
  const job = {
    id, accountId, profileId, phase: 'finding', status: 'running',
    done: 0, total: Math.ceil(count / 5), added: 0, drafted: 0,
    startedAt: Date.now(), phaseStartedAt: Date.now(), error: null, targetCount: count,
  };
  jobs.set(id, job);

  (async () => {
    try {
      const r = await agents.prospect(accountId, profileId, {
        count, hints,
        onProgress: ({ done, total, added }) => {
          // meter as leads actually land, so an abandoned run still bills fairly
          const acct = db.getAccount(accountId);
          const delta = added - job.added;
          if (delta > 0) {
            plans.consume(acct, delta, stripe.isOwner(acct));
            // Mark them charged so drafting doesn't bill the same lead twice.
            // `acc` was a typo for `accountId` here. It threw ReferenceError on
            // every run, the bare catch ate it, and so no lead was ever stamped
            // metered — meaning OUTBOUND charged all of them a SECOND time and
            // every customer silently got half the leads they paid for.
            try {
              for (const l of db.getLeads(accountId, profileId)) {
                if (!l.metered) db.updateLead(accountId, l.id, { metered: true });
              }
            } catch (e) {
              db.logActivity(accountId, { agent: 'PROSPECTOR', msg: `Metering mark failed: ${e.message}` });
            }
          }
          job.done = done; job.total = total; job.added = added;
        },
      });
      job.added = r.added;
      if (thenDraft && r.added > 0) {
        job.phase = 'drafting'; job.phaseStartedAt = Date.now(); job.done = 0; job.total = r.added;
        const d = await agents.outboundRun(accountId, profileId, ({ done, total }) => { job.done = done; job.total = total; });
        job.drafted = d.drafted;
      }
      job.phase = 'done'; job.status = 'done';
      // Retention loop: after a scheduled overnight run, email "your leads are ready".
      if (notify && job.added > 0) {
        const acc = db.getAccount(accountId);
        const prof = db.getProfile(accountId, profileId);
        if (acc && prof) {
          const r = await mailer.sendMorningDigest(acc.email, { profileName: prof.name, found: job.added, drafted: job.drafted });
          db.logActivity(accountId, { agent: 'NIGHT SHIFT', profileId,
            msg: r.ok ? `Morning digest emailed to ${acc.email}` : `Digest not sent (${r.error})` });
        }
      }
    } catch (e) {
      job.status = 'error'; job.phase = 'done'; job.error = e.message;
      db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Run failed: ${e.message}` });
    }
    job.finishedAt = Date.now();
    setTimeout(() => jobs.delete(id), 10 * 60 * 1000); // reap after 10 min
  })();

  return job;
}

// Estimate remaining time from how long the completed units actually took.
function jobView(job) {
  const elapsedPhase = Date.now() - job.phaseStartedAt;
  let etaMs = null;
  if (job.status === 'running' && job.done > 0 && job.total > job.done) {
    etaMs = Math.round((elapsedPhase / job.done) * (job.total - job.done));
  } else if (job.status === 'running' && job.done === 0) {
    // nothing finished yet — fall back to a rough per-unit estimate
    const perUnit = job.phase === 'finding' ? (aiMode() === 'api' ? 45000 : 200000) : (aiMode() === 'api' ? 12000 : 40000);
    etaMs = perUnit * job.total;
  }
  return {
    id: job.id, phase: job.phase, status: job.status,
    done: job.done, total: job.total, added: job.added, drafted: job.drafted,
    etaMs, elapsedMs: Date.now() - job.startedAt, error: job.error,
  };
}

// ---- SEND jobs (approve & send all) ----
// Sending is deliberately throttled: blasting 50 cold emails back-to-back from a
// fresh mailbox is the fastest way to get spam-filtered. Spacing + a daily cap
// protect the user's sending reputation.
// ================= CALL-BACKS =================
// The AI rings back people who ASKED -- see lib/callback.js for the why. This
// is the one place a call-back is actually dialled, so every legal check
// lives here and nothing else can place one.
const callback = require('./lib/callback');
async function placeCallback(rec, { by = 'system' } = {}) {
  const account = db.getAccount(rec.accountId);
  if (!account) return { ok: false, reason: 'No account.' };
  const vc = account.voice || {};
  const owner = stripe.isOwner(account);
  // 1. Consent / basis.
  const allowed = callback.callbackAllowed(rec);
  if (!allowed.ok) { db.updateCallback(rec.accountId, rec.id, { status: 'blocked', note: allowed.reason }); return allowed; }
  // 2. Do-not-call is absolute.
  const to = voice.toE164(rec.phone || '');
  if (!to) { db.updateCallback(rec.accountId, rec.id, { status: 'blocked', note: 'Not a valid phone number.' }); return { ok: false, reason: 'Not a valid phone number.' }; }
  const dnc = suppress.isPhoneSuppressed(rec.accountId, to);
  if (dnc.blocked) { db.updateCallback(rec.accountId, rec.id, { status: 'blocked', note: 'On the do-not-call list.' }); return { ok: false, reason: 'That number asked not to be contacted.' }; }
  // 3. Once a day per number, whatever the source.
  if (callback.calledToday(rec.accountId, suppress.phoneKey(to)) && by !== 'owner') {
    db.updateCallback(rec.accountId, rec.id, { status: 'skipped', note: 'Already called today.' }); return { ok: false, reason: 'Already called this number today.' };
  }
  // 4. Plan, line, and configuration.
  const plan = plans.voiceAllowed(account, owner);
  if (!plan.ok) { db.updateCallback(rec.accountId, rec.id, { status: 'queued', note: plan.reason }); return { ok: false, reason: plan.reason }; }
  const from = vc.number || (owner ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
  if (!voice.configured() || !from) { db.updateCallback(rec.accountId, rec.id, { status: 'queued', note: 'No phone line yet — get a number on the AI Answering tab.' }); return { ok: false, reason: 'No phone line yet.' }; }
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  // 5. Quiet hours: queue for the morning rather than ring at 11pm.
  const hours = callback.withinCallingHours(voice.tzFor(account));
  if (!hours.ok && by !== 'owner') {
    const dueAt = callback.nextCallingWindow(voice.tzFor(account));
    db.updateCallback(rec.accountId, rec.id, { status: 'queued', dueAt, note: hours.reason });
    return { ok: false, queued: true, dueAt, reason: hours.reason };
  }
  const profile = db.getProfile(rec.accountId, vc.profileId) || db.getProfiles(rec.accountId)[0];
  if (!profile) { db.updateCallback(rec.accountId, rec.id, { status: 'queued', note: 'No business profile yet.' }); return { ok: false, reason: 'No business profile yet.' }; }
  try {
    const call = await voice.placeCall({ to, from, answerUrl: base + '/voice/answer', statusUrl: base + '/voice/status' });
    const agoMin = Math.max(0, Math.round((Date.now() - Date.parse(rec.at)) / 60000));
    voice.startCall(call.sid, { accountId: rec.accountId, account, profile, direction: 'outbound', to, from,
      lead: { callback: true, callbackId: rec.id, name: rec.name || '', need: rec.need || '', callbackSource: rec.source,
              when: agoMin < 2 ? 'just now' : agoMin < 60 ? `${agoMin} minutes ago` : agoMin < 1440 ? `${Math.round(agoMin / 60)} hours ago` : 'recently' } });
    db.saveCall(rec.accountId, { sid: call.sid, direction: 'outbound', to, from, profileId: profile.id, status: call.status || 'queued', transcript: [], callbackId: rec.id });
    db.updateCallback(rec.accountId, rec.id, { status: 'called', calledAt: db.nowISO(), callSid: call.sid, basis: allowed.basis, note: '' });
    db.logActivity(rec.accountId, { agent: 'VOICE', msg: `Call-back placed to ${to}${rec.name ? ' (' + rec.name + ')' : ''} — ${allowed.basis}` });
    return { ok: true, sid: call.sid };
  } catch (e) {
    db.updateCallback(rec.accountId, rec.id, { status: 'failed', note: e.message });
    return { ok: false, reason: e.message };
  }
}
// Every minute: anything queued whose time has come.
async function runCallbackQueue() {
  let due = [];
  try { due = db.readCollection('callbacks').filter((c) => c.status === 'queued' && (!c.dueAt || Date.parse(c.dueAt) <= Date.now())); } catch { return; }
  for (const rec of due.slice(0, 20)) {
    // Re-read: it may have been cancelled or called by hand since.
    const fresh = db.getCallbacks(rec.accountId, 500).find((c) => c.id === rec.id);
    if (!fresh || fresh.status !== 'queued') continue;
    await placeCallback(fresh).catch(() => {});
  }
}
setInterval(() => { runCallbackQueue().catch(() => {}); }, 60 * 1000);

// ---- who may run automated outbound calling ----
// Two separate questions, and conflating them produced a dead tab with no way
// forward: (1) is the feature switched on at all on this server — a compliance
// decision, since an AI voice is an "artificial voice" under the TCPA and
// calling a cell without prior express consent is $500-$1,500 per call; and
// (2) does THIS customer's plan include it. The owner runs the Twilio account,
// wrote the script and owns the consent process, so the owner is not gated by
// the server switch — everyone else needs both.
function outboundGate(account) {
  // Cold-list dialling is OFF for everyone, owner included, unless the server
  // switch is thrown. The call-back feature is the supported way to have the
  // AI dial out: it only calls people who asked, with the consent on file.
  if (process.env.OUTBOUND_CALLING !== 'on') {
    return { ok: false, paused: true, reason: 'Automated cold calling is off. Use Call-backs — the AI rings back anyone who asks, legally, in about a minute.' };
  }
  if (stripe.isOwner(account)) return { ok: true };
  const u = plans.usage(account, false);
  if (!u.isPro || !u.voice || !u.voice.included) return { ok: false, needUpgrade: true, reason: 'Outbound calling needs a plan with phone minutes.' };
  return { ok: true };
}

// The referral cookie. 90 days: a small-business owner who calls the demo
// line on a Friday and signs up after talking to their partner the following
// month is still that rep's customer.
const REF_COOKIE = 'dp_ref';
const REF_COOKIE_DAYS = 90;

// ---- speculative thinking on partial speech ----
// Twilio streams partial transcripts while the caller is still talking. After
// 600ms with no newer partial (the caller has likely stopped; Twilio is now
// sitting out its 2-second end-of-speech window), the model starts thinking
// on the text so far. If the FINAL transcript matches (ignoring casing and
// punctuation), the answer is already cooked and the reply is near-instant;
// if it differs, the speculation is discarded and the turn thinks fresh --
// exactly today's path, so quality cannot regress. ONE speculation per turn,
// so the worst case is one wasted model call (~half a cent) on a mismatch.
// VOICE_SPECULATE=off disables the whole thing.
function launchSpeculation(sid) {
  const call = voice.getCall(sid);
  if (!call) return;
  const text = String(call.partialLatest || '').trim();
  if (!text || text.length < 3) return;
  const norm = voice.normSpeech(text);
  if (!norm || (call.spec && call.spec.norm === norm)) return;
  if ((call.specCount || 0) >= 1) return;
  call.specCount = (call.specCount || 0) + 1;
  // A shallow view with the caller's line appended, so the speculative prompt
  // is byte-identical to what the real turn would build -- without mutating
  // the real transcript before the final result confirms the words.
  const view = { ...call, turns: [...call.turns, { who: 'caller', text }] };
  call.spec = { norm, promise: voice.think(view, text).then((v) => ({ v }), (err) => ({ err })) };
}

const sendJobs = new Map();

// One send job per account at a time. Without this, a second click or a page
// reload starts a concurrent run over the same approved queue items and every
// recipient gets the email twice.
// One cold-calling run per account at a time — the AI can only hold one
// conversation, and two overlapping runs would dial the same lead twice.
const callJobs = new Map();
const phoneJobs = new Map();
const activeSends = new Map();
function startSendJob(account, profileId) {
  const running = activeSends.get(account.id);
  const runningJob = running && sendJobs.get(running);
  // A lock pointing at a job that is gone or finished is stale — clear it.
  if (running && (!runningJob || runningJob.status !== 'running')) activeSends.delete(account.id);
  // Also treat a job with no progress for 10 minutes as dead rather than live.
  if (runningJob && runningJob.status === 'running' && Date.now() - (runningJob.startedAt || 0) > 30 * 60 * 1000) {
    runningJob.status = 'error'; runningJob.error = 'Timed out'; activeSends.delete(account.id);
  }
  if (running && sendJobs.get(running) && sendJobs.get(running).status === 'running') {
    const e = new Error('A send is already running for this account.');
    e.alreadyRunning = running;
    throw e;
  }
  const id = db.uid();
  activeSends.set(account.id, id);
  const items = db.getQueue(account.id, profileId).filter((q) => q.status === 'approved');
  const cfg = account.smtp || {};
  const todayStr = db.today();
  const sentToday = (account.sentToday && account.sentToday.date === todayStr) ? account.sentToday.count : 0;
  // Daily ceiling is the LOWER of the user's cap and today's warmup allowance —
  // a new domain that blasts its full cap on day one gets filtered for months.
  const warmAllow = sending.warmupAllowance(account.warmup, todayStr);
  const cap = Math.min(Number(account.dailyCap ?? 50), warmAllow);
  const allowed = Math.max(0, cap - sentToday);

  // "I approved 50 and it says it's sending 8" — say WHY, in the job itself.
  // A silent cap looks like the product losing your work.
  let capReason = '';
  if (items.length > allowed) {
    const warmLimited = Number.isFinite(warmAllow) && warmAllow <= Number(account.dailyCap ?? 50);
    capReason = warmLimited
      ? `Your domain is still warming up, so today's safe limit is ${warmAllow} email${warmAllow === 1 ? '' : 's'}${sentToday ? ` (${sentToday} already gone today)` : ''}. The other ${items.length - allowed} stay approved and go out over the next few days as the limit rises — that ramp is what keeps you out of spam folders.`
      : `Your daily limit is ${cap}${sentToday ? ` and ${sentToday} already went out today` : ''}, so ${allowed} go now. The other ${items.length - allowed} stay approved and go tomorrow. Raise the limit in SENDING settings if you want more.`;
  }
  const job = { id, accountId: account.id, status: 'running', done: 0, total: Math.min(items.length, allowed),
    sent: 0, failed: 0, deferred: 0, skipped: Math.max(0, items.length - allowed),
    approved: items.length, capReason,
    warmupCap: Number.isFinite(warmAllow) ? warmAllow : null,
    stopRequested: false,
    startedAt: Date.now(), error: null, lastError: null };
  sendJobs.set(id, job);

  (async () => {
    try {
      if (!cfg.user || !cfg.pass) throw new Error('No sending mailbox connected — add it in Settings first.');
      // HARD GATE: an unauthenticated domain gets spam-foldered, and the damage
      // is slow and permanent. Refuse to send until SPF+DKIM+DMARC pass.
      const auth = await dnsauth.checkDomain(cfg.fromEmail || cfg.user).catch(() => null);
      // If DNS itself was unreachable we cannot conclude the domain is
      // misconfigured — warn and let the send proceed rather than blocking a
      // paying customer's campaign on our resolver having a bad minute.
      if (auth && auth.lookupFailed) {
        db.logActivity(account.id, { agent: 'SEND', profileId, msg: 'DNS check unavailable — sending anyway. Re-check Deliverability when you can.' });
      } else if (auth && auth.ok === false) {
        const bad = Object.entries(auth.records || {}).filter(([, v]) => !v.ok).map(([k]) => k.toUpperCase()).join(', ');
        throw new Error(`Sending is blocked: ${bad} not set up for ${auth.domain}. Fix it on the Your Business tab (Deliverability), then re-check.`);
      }
      // CAN-SPAM: every commercial email must carry the sender's real physical
      // postal address. No address = we don't send, rather than send unlawfully.
      const prof = db.getProfile(account.id, profileId);
      if (!prof || !String(prof.mailingAddress || '').trim()) {
        throw new Error('Add your business mailing address (Your Business tab) before sending — the law requires it in every commercial email.');
      }
      const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      let count = sentToday;
      for (const it of items.slice(0, allowed)) {
        try {
          // Hard block: never SMTP-send to a guessed/invalid address, even if it
          // slipped into the queue before the no-guess guarantee. Each bounce
          // damages the user's sender reputation.
          const lead = it.leadId ? db.getLeads(account.id, profileId).find((l) => l.id === it.leadId) : null;
          if (!db.isSendableLead(lead)) {
            // 'held', not 'rejected' — the draft survives, so if the address is
            // verified later it can still go. Counted separately from failures
            // so "23 failed" doesn't mean "23 emails broke".
            db.updateQueueItem(account.id, it.id, { status: 'held', heldReason: 'unverified address' });
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Held ${it.to} — ${lead ? 'address not verified' : 'no lead record'} (would bounce)` });
            job.blocked = (job.blocked || 0) + 1;
            job.done++;
            continue;
          }
          // SUPPRESSION: unsubscribes, hard bounces and blocks are absolute.
          // Checked here at the send boundary so no UI path can bypass it.
          const sup = suppress.isSuppressed(account.id, it.to);
          if (sup.blocked) {
            db.updateQueueItem(account.id, it.id, { status: 'rejected', blockedBy: sup.reason });
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Suppressed ${it.to} — ${sup.note}` });
            job.suppressed = (job.suppressed || 0) + 1; job.done++;
            continue;
          }
          // Land in their inbox while they're at their desk, in THEIR timezone.
          // The user can turn the hold off — their call, spelled out in the UI.
          const bh = account.sendWindow === 'anytime' ? { ok: true } : sending.withinBusinessHours(lead, {});
          if (!bh.ok) {
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Holding ${it.to} — ${bh.reason}` });
            job.deferred++; job.done++;
            continue; // stays approved; the next run picks it up in-hours
          }
          // Live unsubscribe link + CAN-SPAM footer, stamped at send time.
          const unsubUrl = base ? `${base}/u/${suppress.tokenFor(account.id, it.to)}` : '';
          const body = agents.stampFooter(it.body, prof, unsubUrl);
          // Hard deadline as a backstop: even if the SMTP client ever fails to
          // settle again, the loop keeps moving instead of wedging the account.
          await Promise.race([
            smtp.sendMail({ ...cfg, fromName: cfg.fromName || '' },
              { to: it.to, subject: it.subject, body, unsubscribeUrl: unsubUrl }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Send timed out after 90s')), 90000)),
          ]);
          db.updateQueueItem(account.id, it.id, { status: 'sent', sentAt: db.nowISO() });
          if (it.leadId) {
            db.updateLead(account.id, it.leadId, { status: 'sent' });
            // Remember it, advance the stage, and schedule the next touch.
            const sentLead = db.getLeads(account.id, profileId).find((l) => l.id === it.leadId);
            if (sentLead) memory.remember(account.id, sentLead, {
              kind: 'email-sent', channel: 'email',
              summary: `touch #${it.touch || 1}: ${String(it.subject || '').slice(0, 60)}`,
            });
          }
          // Immutable audit trail: who was emailed, when, with what, approved by whom.
          db.logSend(account.id, { profileId, leadId: it.leadId || null, to: it.to, toName: it.toName || '',
            company: it.company || '', subject: it.subject || '', body, approvedBy: account.email,
            approvedAt: it.approvedAt || null, queueId: it.id });
          db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Sent to ${it.toName || it.to}` });
          job.sent++; count++;
          db.updateAccount(account.id, { sentToday: { date: todayStr, count } });
          // Re-read rather than trusting the start-of-job snapshot: a second
          // device, the scheduler, or a plan change can move the cap mid-run.
          const fresh = db.getAccount(account.id);
          if (fresh && fresh.sentToday && fresh.sentToday.date === todayStr) count = Math.max(count, fresh.sentToday.count);
        } catch (e) {
          job.failed++; job.lastError = e.message;
          // A hard bounce means the address is dead. Suppress it permanently —
          // repeat bounces to the same address are what wreck a sending domain.
          if (suppress.isHardBounce(e.message)) {
            suppress.suppress(account.id, it.to, 'bounce', { note: String(e.message).slice(0, 140) });
            if (it.leadId) db.updateLead(account.id, it.leadId, { emailConfidence: 'invalid', emailSource: 'hard bounce' });
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Hard bounce — ${it.to} suppressed permanently` });
          } else {
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Send FAILED to ${it.toName || it.to}: ${e.message}` });
          }
        }
        job.done++;
        // Randomised gap around the user's own setting — a fixed interval is a
        // machine fingerprint, but their configured value must still mean
        // something. Floor of 60s keeps it out of obvious-bot territory.
        const baseSec = Math.max(60, Number(account.sendDelaySec ?? 180));
        // STOP: checked here AND slept in short slices, so "stop" means stopped
        // within a couple of seconds instead of after the next 2-minute gap.
        // A campaign you cannot halt is a campaign you cannot trust — the
        // moment you spot a wrong phone number in the copy, every further send
        // is damage you chose not to prevent.
        if (job.stopRequested) break;
        if (job.done < job.total) {
          const until = Date.now() + sending.nextDelayMs(baseSec, baseSec * 2.5);
          while (Date.now() < until && !job.stopRequested) {
            await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
          }
        }
        if (job.stopRequested) break;
      }
      if (job.stopRequested) {
        job.status = 'stopped';
        const left = Math.max(0, job.total - job.done);
        job.note = `Stopped. ${job.sent} sent, ${left} still approved and waiting — nothing else went out. Fix what you need to and hit send again when you're ready.`;
        db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Send STOPPED by you after ${job.sent} sent — ${left} left untouched` });
      } else job.status = 'done';
      // Never finish silently at "sent 0". If everything was held for business
      // hours or blocked, say so — otherwise it looks like the product failed.
      if (!job.sent && !job.stopRequested) {
        if (job.deferred) job.note = `Nothing sent yet — ${job.deferred} held for their local business hours (weekdays 8am-5pm their time; replies are ~3x higher then). Want them out now anyway? Flip "When to send" to "Any time" in the SENDING settings and hit send again.`;
        else if (job.blocked) job.note = `Nothing sent — ${job.blocked} draft(s) held because the address isn't verified. Use "Clear guesses" or re-run Find leads.`;
        else if (job.total === 0) job.note = 'Nothing to send — approve some drafts first.';
      }
    } catch (e) {
      job.status = 'error'; job.error = e.message;
    }
    job.finishedAt = Date.now();
    // Released here unconditionally — a stuck job must never lock the account
    // out of sending forever.
    if (activeSends.get(account.id) === id) activeSends.delete(account.id);
    setTimeout(() => sendJobs.delete(id), 10 * 60 * 1000);
  })();

  return job;
}

function sendJobView(j) {
  const elapsed = Date.now() - j.startedAt;
  let etaMs = null;
  if (j.status === 'running' && j.total > j.done) {
    // pacing is now randomised 3-8 min, so estimate from the ~5.5 min midpoint
    etaMs = j.done > 0 ? Math.round((elapsed / j.done) * (j.total - j.done)) : j.total * 330000;
  }
  return { id: j.id, status: j.status, done: j.done, total: j.total, sent: j.sent, failed: j.failed,
    skipped: j.skipped, deferred: j.deferred || 0, suppressed: j.suppressed || 0,
    blocked: j.blocked || 0, note: j.note || '', warmupCap: j.warmupCap ?? null,
    // Why is it sending 8 when I approved 50? The answer travels with the job.
    approved: j.approved || 0, capReason: j.capReason || '', stopping: !!j.stopRequested && j.status === 'running',
    etaMs, elapsedMs: elapsed, error: j.error, lastError: j.lastError };
}

// ---- NIGHT SHIFT scheduler ----
// Every minute, look for profiles whose scheduled hour has arrived in the USER'S
// timezone and kick off a full find+draft run, so a long approval list is waiting
// by morning.
function userLocalNow(tzOffsetMin) {
  // tzOffsetMin is JS getTimezoneOffset() (minutes BEHIND UTC, positive for west)
  const off = Number(tzOffsetMin);
  if (!Number.isFinite(off)) return new Date();
  return new Date(Date.now() - off * 60000);
}
function checkSchedules() {
  let profiles = [];
  try { profiles = db.allProfiles(); } catch { return; }
  for (const p of profiles) {
    const s = p.schedule;
    if (!s || !s.enabled || !s.time) continue;
    const now = userLocalNow(s.tzOffset);
    const dateKey = now.toISOString().slice(0, 10);
    if (s.lastRunDate === dateKey) continue; // already ran today
    const [h, m] = String(s.time).split(':').map(Number);
    if (!Number.isFinite(h)) continue;
    const dueMin = h * 60 + (m || 0);
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    // fire if we're at/just past the time (15-min catch-up window for restarts)
    if (nowMin < dueMin || nowMin > dueMin + 15) continue;

    // The overnight run spends real AI money, so it must respect the plan and
    // the remaining allowance exactly like a manual run does. Without this a
    // cancelled or exhausted account keeps prospecting every night for free.
    const acct = db.getAccount(p.accountId);
    if (!acct) continue;
    db.updateProfile(p.accountId, p.id, { schedule: { ...s, lastRunDate: dateKey } });
    const owner = stripe.isOwner(acct);
    if (!stripe.hasAccess(acct)) {
      db.logActivity(p.accountId, { agent: 'NIGHT SHIFT', profileId: p.id, msg: 'Skipped — no active plan. Subscribe to resume overnight runs.' });
      continue;
    }
    const u = plans.usage(acct, owner);
    let count = Math.min(Number(s.count) || 50, 50);
    if (!u.unlimited) {
      if (u.remaining <= 0) {
        db.logActivity(p.accountId, { agent: 'NIGHT SHIFT', profileId: p.id, msg: `Skipped — this month's ${u.limit} leads are used up. Resets next month.` });
        continue;
      }
      count = Math.min(count, u.remaining);   // never overspend the allowance
    }
    db.logActivity(p.accountId, { agent: 'NIGHT SHIFT', profileId: p.id, msg: `Scheduled run started — sourcing ${count} leads` });
    // Follow-ups first: a lead already in the pipeline is worth more than a new
    // one, and this is the half a normal tool never does.
    agents.keeperRun(p.accountId, p.id)
      .then((r) => { if (r.drafted) db.logActivity(p.accountId, { agent: 'KEEPER', profileId: p.id, msg: `${r.drafted} follow-up(s) drafted overnight` }); })
      .catch((e) => db.logActivity(p.accountId, { agent: 'KEEPER', profileId: p.id, msg: `Follow-ups failed: ${e.message}` }));
    startProspectJob(p.accountId, p.id, { count, hints: s.hints || '', thenDraft: true, notify: true });
  }
}
setInterval(checkSchedules, 60 * 1000);

/**
 * Hand back phone numbers rented for accounts that have cancelled.
 *
 * Nothing did this, so every churned voice customer left a DID renting on our
 * Twilio bill forever — a cost that only grows, never appears in Stripe, and
 * could only be stopped by finding it by hand in the Twilio console.
 *
 * Runs as a sweep rather than inside the webhook because releasing is an async
 * network call and webhook handling is fire-and-forget. A grace period means a
 * customer who resubscribes the same week keeps their number.
 */
const RECLAIM_AFTER_DAYS = 21;
async function reclaimCancelledNumbers() {
  for (const a of db.allAccounts()) {
    const v = a.voice || {};
    if (!v.numberSid) continue;
    if (a.subStatus !== 'canceled' && a.subStatus !== 'incomplete_expired') continue;
    const since = Date.parse(a.canceledAt || '') || 0;
    if (!since) { db.updateAccount(a.id, { canceledAt: new Date().toISOString() }); continue; }
    // A trial that never converted gets its number back fast: they never paid,
    // so there is no relationship to preserve and 21 days of rent is a gift.
    // A real customer who cancels keeps the grace period in case they return.
    const graceDays = a.everPaid ? RECLAIM_AFTER_DAYS : 2;
    if (Date.now() - since < graceDays * 24 * 60 * 60 * 1000) continue;
    try {
      await numbers.release(v.numberSid);
      db.updateAccount(a.id, { voice: { ...v, number: '', numberSid: '', enabled: false } });
      db.logActivity(a.id, { agent: 'SYSTEM', msg: `Phone number ${v.number} released after ${RECLAIM_AFTER_DAYS} days cancelled` });
    } catch (e) {
      db.logActivity(a.id, { agent: 'SYSTEM', msg: `Could not release ${v.number}: ${e.message}` });
    }
  }
}
setInterval(() => { reclaimCancelledNumbers().catch(() => {}); }, 6 * 60 * 60 * 1000);

/**
 * "Here is what your AI did last month" -- the cheapest churn reducer in this
 * category. Runs on the 1st, once per account per month (stamped so a restart
 * cannot double-send), only to accounts whose plan includes the phone.
 */
async function sendMonthlyRecaps() {
  const now = new Date();
  if (now.getDate() !== 1) return;
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (const a of db.allAccounts()) {
    if (a.lastRecapKey === key) continue;
    const u = plans.usage(a, stripe.isOwner(a));
    if (!u.voice || !u.voice.included) continue;
    if (!['active', 'trialing', 'past_due'].includes(a.subStatus) && !stripe.isOwner(a)) continue;
    try {
      const prof = db.getProfile(a.id, (a.voice || {}).profileId) || db.getProfiles(a.id)[0];
      const s = stats.summary(a, voice.tzFor(a)).lastMonth;
      const tier = plans.TIERS[a.tier];
      const body = stats.recapEmail(a, (prof && prof.name) || 'your business', s, tier ? tier.price : 0);
      const monthName = new Date(now.getFullYear(), now.getMonth() - 1, 1).toLocaleString('en-US', { month: 'long' });
      const r = await mailer.send(a.email, `${monthName}: ${s.calls} calls answered, ${s.booked} booked — your Dawnpipe recap`, body);
      db.updateAccount(a.id, { lastRecapKey: key });
      db.logActivity(a.id, { agent: 'SYSTEM', msg: r && r.ok ? `Monthly recap emailed (${s.calls} calls, ${s.booked} booked)` : `Monthly recap not sent: ${(r && r.error) || 'mailer off'}` });
    } catch (e) {
      db.logActivity(a.id, { agent: 'SYSTEM', msg: `Monthly recap failed: ${e.message}` });
    }
  }
}
setInterval(() => { sendMonthlyRecaps().catch(() => {}); }, 60 * 60 * 1000);

// The public demo number, injected into every page that offers it. One source
// of truth on purpose: the number used to be hardcoded into the meta tags and
// the signup page, so changing the Twilio line left the site advertising a
// dead number in exactly the places nobody thinks to check.
function demoTel() {
  const raw = process.env.TWILIO_PHONE_NUMBER || '';
  const tel = voice.toE164(raw);
  const pretty = tel.length === 12 && tel.startsWith('+1')
    ? `(${tel.slice(2, 5)}) ${tel.slice(5, 8)}-${tel.slice(8)}` : (raw || tel);
  return { tel, pretty };
}
/**
 * Does this account have a subscription the Stripe portal can actually manage?
 *
 * Deliberately does NOT consult account.stripeSubscriptionId. That field only
 * started being written yesterday and nothing backfills it, so every customer
 * who subscribed before then has it undefined — and requiring it sent exactly
 * the people we were protecting (a live subscriber whose card had bounced)
 * back through Checkout to start a SECOND subscription alongside the one
 * Stripe was still retrying. Status is the thing that is always populated.
 *
 * Terminal states fall through to Checkout on purpose: the portal cannot
 * create a subscription, so routing a churned customer there leaves them on an
 * invoice-history page with no way to buy.
 */
function canManageBilling(account) {
  if (!account || !account.stripeCustomerId) return false;
  return stripe.isPaid(account) || stripe.DUNNING.includes(account.subStatus);
}

function withDemoTel(page) {
  const { tel, pretty } = demoTel();
  // No line provisioned (or mid-swap): point the phone CTAs at signup instead
  // of leaving `href="tel:"` dead links behind.
  if (!tel) return page.split('tel:__DEMO_TEL__').join('/signup').split('__DEMO_NUM__').join('');
  return page.split('__DEMO_TEL__').join(tel).split('__DEMO_NUM__').join(pretty);
}

// ---- server ----
// A deliberate "we're doing maintenance" page, for the times we choose to take
// the site down rather than a deploy blip. Flip MAINTENANCE=1 in the Render
// dashboard and every human-facing page shows this instead of a dead app.
// Machines are exempt on purpose: Twilio still gets its webhooks (a caller mid-
// conversation must not hear the line die), Stripe still gets its webhooks
// (a payment must never be lost to a maintenance window), and /health keeps
// answering so Render does not think the instance is broken.
const MAINTENANCE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dawnpipe — back shortly</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Iowan Old Style",Georgia,serif;background:#f4f1ea;color:#1a1815;text-align:center;padding:24px}
.m{font-weight:800;font-size:26px;letter-spacing:-.5px}.m b{color:#c02a1b}h1{font-size:28px;margin:22px 0 10px}p{color:#4a463f;font-size:16px;line-height:1.55;max-width:460px;margin:0 auto}
.n{margin-top:26px;font-size:15px;color:#4a463f}</style></head><body><div>
<div class="m">Dawn<b>pipe</b></div>
<h1>Currently unavailable for maintenance</h1>
<p>We're making some improvements and will be back in a few minutes. Your account, your leads and your calendar are safe — nothing is being reset.</p>
<p class="n">Your phone line keeps answering during maintenance.<br>Need us? <a href="mailto:support@dawnpipe.com" style="color:#c02a1b">support@dawnpipe.com</a></p>
</div></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // /health is Render's deploy gate: with healthCheckPath set, Render only
  // switches traffic to a new instance once this answers 200. It therefore has
  // to be the FIRST thing in the handler and depend on nothing — no session
  // lookup, no disk read, no auth, nothing that could throw before it returns.
  // It used to sit ~500 lines in, after auth and routing; a probe that failed
  // anywhere on that path made Render silently keep the OLD instance while
  // the old instance's own /health kept answering 200 — which is how a dozen
  // commits looked deployed and were not.
  if (req.method === 'GET' && p === '/health') {
    let ai = 'unknown';
    try { ai = aiMode(); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, ai, uptime: Math.round(process.uptime()), build: BUILD_ID }));
  }

  if (process.env.MAINTENANCE === '1'
      && !p.startsWith('/voice/') && !p.startsWith('/webhook/') && p !== '/health') {
    // 503 + Retry-After is the honest status: search engines keep the page
    // indexed and come back later instead of dropping it as a 5xx error.
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '300', 'Cache-Control': 'no-store' });
    return res.end(MAINTENANCE_HTML);
  }

  // `let`, not `const`: the checkout-return path re-reads the account after
  // activating it so the rest of the request sees the unlocked state.
  let account = auth.currentAccount(req);

  try {
    // ---------- health ----------
    // Static favicon (search results and link previews can't run the animated
    // JS one). Same night scene, one frame.
    // One canonical host: GETs on the old onrender hostname 301 to dawnpipe.com.
    // POST paths (Stripe webhook, Twilio voice) deliberately untouched so nothing
    // breaks while their consoles still point at the old URL.
    {
      const hostHdr = String(req.headers.host || '').toLowerCase();
      if (req.method === 'GET' && hostHdr.includes('onrender.com')
          && !p.startsWith('/webhook') && !p.startsWith('/voice') && !p.startsWith('/api')) {
        return redirect(res, 'https://dawnpipe.com' + (req.url || p));
      }
    }
    if (req.method === 'GET' && p === '/favicon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      // Static fallback of the moon/sleeper/ringing-phone scene (favicon.js is
      // the animated version) for contexts that can't run JS.
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#151228"/><circle cx="46" cy="17" r="10" fill="#f0c860"/><circle cx="41.5" cy="14" r="9.5" fill="#151228"/><rect x="6" y="42" width="52" height="17" rx="5" fill="#2a2547"/><rect x="9" y="40" width="15" height="10" rx="4" fill="#f4f1ea"/><circle cx="21" cy="44" r="6.2" fill="#e8b48f"/><rect x="26" y="43" width="31" height="13" rx="5" fill="#6b5ea8"/><g transform="rotate(12 45 34)"><rect x="37.5" y="28.5" width="15" height="11" rx="3.5" fill="#c02a1b"/><rect x="39.5" y="30.5" width="11" height="7" rx="2" fill="#ffe9a8"/></g></svg>`);
    }
    if (req.method === 'GET' && (p === '/og.png' || p === '/apple-touch-icon.png')) {
      try {
        const img = fs.readFileSync(path.join(VIEWS, p === '/og.png' ? 'og.png' : 'apple-touch-icon.png'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
        return res.end(img);
      } catch { res.writeHead(404); return res.end(); }
    }
    // ---- CALL-BACK REQUEST FORM: /f/SLUG ----
    // Public, per business, embeddable. This is how a stranger becomes someone
    // who ASKED: name, number, what they need, and an unticked consent box.
    // The exact wording they ticked is stored with the record, immutably.
    if (/^\/f\/[a-z0-9]{4,24}$/i.test(p) && (req.method === 'GET' || req.method === 'POST')) {
      const slug = p.slice(3).toLowerCase();
      const acct = callback.accountByFormSlug(slug);
      if (!acct) return html(res, '<p style="font-family:system-ui;padding:40px">This request form is not active.</p>', 404);
      const vcfg = acct.voice || {};
      const prof = db.getProfile(acct.id, vcfg.profileId) || db.getProfiles(acct.id)[0] || {};
      const biz = prof.name || 'us';
      const agentName = vcfg.agentName || 'Our assistant';
      const tz = voice.tzFor(acct);
      const tzLabel = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName').value; } catch { return ''; } })();
      const render = ({ err = '', done = '', name = '', phone = '', need = '' } = {}) => {
        const consent = callback.consentText(biz, phone);
        let page = view('callback-form.html');
        page = page.split('__BIZ__').join(voice.esc(biz)).split('__WHO__').join(voice.esc(agentName) + ' (our AI assistant)')
          .split('__ACTION__').join(`/f/${slug}`)
          .split('__NAME__').join(voice.esc(name)).split('__PHONE__').join(voice.esc(phone)).split('__NEED__').join(voice.esc(need))
          .split('__CONSENT__').join(voice.esc(consent)).split('__CONSENT_ATTR__').join(voice.esc(consent))
          .split('__EARLIEST__').join(String(callback.EARLIEST_HOUR)).split('__LATEST__').join(String(callback.LATEST_HOUR - 12))
          .split('__TZ_LABEL__').join(tzLabel ? `(${voice.esc(tzLabel)})` : '')
          .replace('<!--ERR-->', err ? `<div class="err">${voice.esc(err)}</div>` : '')
          .replace('<!--DONE-->', done ? `<div class="done"><div class="big">✓ Got it${name ? ', ' + voice.esc(name.split(' ')[0]) : ''}.</div><div>${done}</div></div>` : '')
          .split('__HIDE_FORM__').join(done ? 'style="display:none"' : '');
        return page;
      };
      if (req.method === 'GET') return html(res, render());
      // POST
      if (rateLimited(req, 'cbform:' + slug, 20, 60 * 60 * 1000)) return html(res, render({ err: 'Too many requests from here just now. Please call us instead.' }), 429);
      const f = parseForm(await readBody(req));
      if (String(f.website || '').trim()) return html(res, render({ done: 'Thanks.' })); // honeypot: bots fill it, people never see it
      const name = String(f.name || '').trim().slice(0, 80);
      const phone = String(f.phone || '').trim().slice(0, 24);
      const need = String(f.need || '').trim().slice(0, 400);
      const digits = phone.replace(/\D/g, '');
      const e164 = (digits.length === 10 || (digits.length === 11 && digits[0] === '1')) ? voice.toE164(phone) : '';
      if (!name) return html(res, render({ err: 'Please tell us your name.', phone, need }), 400);
      if (!e164) return html(res, render({ err: 'That phone number does not look right — please include the area code.', name, need }), 400);
      if (f.consent !== '1') return html(res, render({ err: 'Please tick the box so we are allowed to call you.', name, phone, need }), 400);
      const consentShown = String(f.consentText || '').trim() || callback.consentText(biz, phone);
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const rec = db.addCallback(acct.id, {
        source: 'form', name, phone: e164, phoneKey: suppress.phoneKey(e164), need,
        consent: true, consentText: consentShown, consentAt: db.nowISO(), consentIp: ip, consentUa: String(req.headers['user-agent'] || '').slice(0, 200),
        formSlug: slug, profileId: prof.id || '',
      });
      db.logActivity(acct.id, { agent: 'VOICE', msg: `Call-back requested by ${name} (${e164})${need ? ': ' + need.slice(0, 80) : ''}` });
      try { const h = hooks.emit(acct, 'lead.captured', { source: 'callback-form', name, phone: e164, need, at: rec.at }); if (h && typeof h.catch === 'function') h.catch(() => {}); } catch {}
      // Ring them now (or queue for the morning). Reply to the person first —
      // the dial happens in the background so the page never hangs on Twilio.
      let done = `${voice.esc(agentName)} will ring you in the next minute or so.`;
      const hours = callback.withinCallingHours(tz);
      if (!hours.ok) done = `It's after hours, so ${voice.esc(agentName)} will ring you first thing — from ${callback.EARLIEST_HOUR}am ${tzLabel ? '(' + voice.esc(tzLabel) + ')' : ''}.`;
      setTimeout(() => { placeCallback(rec).catch(() => {}); }, 1500);
      return html(res, render({ done, name }));
    }

    // ---- referral link: /r/CODE ----
    // A rep's link. Sets a first-party cookie so the credit survives the
    // prospect wandering the site, sleeping on it, and signing up two days
    // later. FIRST TOUCH WINS: an existing cookie is never overwritten, so a
    // second rep cannot walk over the first rep's work by getting the last
    // click. An unknown or inactive code sets nothing and redirects silently —
    // a departed rep's old links must stop attributing.
    if (req.method === 'GET' && /^\/r\/[A-Za-z0-9]{2,16}$/.test(p)) {
      const code = reps.normaliseCode(p.slice(3));
      const rep = reps.repByCode(code);
      const existing = reps.normaliseCode(auth.parseCookies(req)[REF_COOKIE] || '');
      const dest = '/signup' + (url.searchParams.get('tier') ? `?tier=${encodeURIComponent(url.searchParams.get('tier'))}` : '');
      if (!rep || rep.status !== 'active' || existing) return redirect(res, dest);
      const secure = (process.env.PUBLIC_URL || '').startsWith('https') ? ' Secure;' : '';
      return redirect(res, dest, `${REF_COOKIE}=${encodeURIComponent(rep.code)};${secure} SameSite=Lax; Path=/; Max-Age=${REF_COOKIE_DAYS * 24 * 3600}`);
    }

    if (req.method === 'GET' && p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /u/\nDisallow: /voice/\nSitemap: https://dawnpipe.com/sitemap.xml\n');
    }
    // Public plan catalogue: names, prices, what you get, and whether each
    // one can be bought right now. Nothing here is secret (it is the pricing
    // page as JSON) and it is how we verify from outside that the live plans
    // are actually wired to live prices, without guessing at env vars.
    if (req.method === 'GET' && p === '/plans.json') {
      const tiers = plans.catalogue().map(({ priceEnvKey, ...t }) => t);
      return json(res, { tiers, trust: plans.TRUST, billingConfigured: stripe.configured(),
        sellable: tiers.filter((t) => t.available).map((t) => t.id),
        // Any tier whose Stripe price does not match the displayed price. Should
        // always be empty; if it is not, the site is quoting one number and the
        // card is charged another.
        priceMismatch: tiers.filter((t) => t.available && t.priceCurrent === false).map((t) => t.id) });
    }
    if (req.method === 'GET' && p === '/sitemap.xml') {
      const site = 'https://dawnpipe.com';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + ['/', '/signup', '/terms', '/privacy'].map((u) => `<url><loc>${site}${u}</loc></url>`).join('')
        + '</urlset>');
    }

    // animated tab icon (drawn client-side on canvas)
    if (req.method === 'GET' && p === '/favicon.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return res.end(view('favicon.js'));
    }
    if (req.method === 'GET' && p === '/favicon.ico') {
      try {
        const ico = fs.readFileSync(path.join(VIEWS, 'favicon.ico'));
        res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' });
        return res.end(ico);
      } catch { res.writeHead(204); return res.end(); }
    }

    // ================= VOICE (Twilio webhooks) =================
    // Public endpoints Twilio POSTs to. Every request is signature-verified so
    // nobody can spoof a call, inject a transcript, or burn AI spend.
    // ---------- inbound SMS: the same agent, texting ----------
    // Twilio POSTs here when someone texts a customer's number -- typically a
    // reply to a missed-call text-back or a booking confirmation. Same brain as
    // the phone, same booking path, same do-not-call list. Signature-verified
    // exactly like the voice webhooks; STOP handled before the model ever runs.
    if (p === '/sms/incoming') {
      const raw = await readBody(req);
      const params = parseForm(raw);
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const base = host ? `${proto}://${host}` : (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      if (!voice.configured()) { res.writeHead(204); return res.end(); }
      if (!voice.verifySignature(base + p, params, req.headers['x-twilio-signature'])) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('bad signature');
      }
      const twimlReply = (text) => { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${voice.esc(text)}</Message>` : ''}</Response>`); };
      const from = params.From || '', to = params.To || '', body = String(params.Body || '').trim();
      const account = db.accountByVoiceNumber(to);
      if (!account || !from) return twimlReply('');
      // Opt-out words are law, not a preference. Handle before anything else.
      if (/^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body)) {
        suppress.suppressPhone(account.id, from, 'unsubscribe', { note: 'texted STOP' });
        db.logActivity(account.id, { agent: 'VOICE', msg: `SMS STOP from ${from} — number suppressed` });
        return twimlReply("You're unsubscribed and won't hear from us again. Reply START if that was a mistake.");
      }
      if (/^\s*(start|unstop|yes)\s*$/i.test(body) && suppress.isPhoneSuppressed(account.id, from).blocked) {
        suppress.unsuppress(account.id, suppress.phoneKey(from));
        return twimlReply("You're back on. What can I do for you?");
      }
      if (suppress.isPhoneSuppressed(account.id, from).blocked) return twimlReply('');
      const vAllow = plans.voiceAllowed(account, stripe.isOwner(account));
      if (!vAllow.ok || account.subStatus === 'canceled') return twimlReply('');
      const profile = db.getProfile(account.id, (account.voice || {}).profileId) || db.getProfiles(account.id)[0];
      if (!profile) return twimlReply('');
      // "YES" to a call-back offer. The missed-call text says "reply YES and I
      // will call you right back"; this reply IS the consent -- their own words,
      // from their own number, in response to a plain offer -- and it is stored
      // verbatim as the basis for the AI call. This is what makes a missed-call
      // call-back defensible: a number captured off caller ID with no notice is
      // not consent to an artificial-voice call, but "YES, call me" is.
      if (/^\s*(yes|yeah|yep|y|call me|please call|ok call me|sure)\s*[.!]*\s*$/i.test(body) && (account.voice || {}).callBackMissed === true) {
        const offered = db.getCallbacks(account.id, 200).find((c) => c.phoneKey === suppress.phoneKey(from) && c.source === 'missed-call' && c.status === 'offered');
        if (offered) {
          db.updateCallback(account.id, offered.id, { status: 'queued', consent: true, consentAt: db.nowISO(),
            consentText: `Replied "${body}" by SMS to: "${offered.offerText || 'reply YES and I will call you right back'}"`, consentVia: 'sms-reply' });
          const rec = db.getCallbacks(account.id, 200).find((c) => c.id === offered.id);
          const agentName = (account.voice || {}).agentName || 'our assistant';
          const hours = callback.withinCallingHours(voice.tzFor(account));
          setTimeout(() => { placeCallback(rec).catch(() => {}); }, 1500);
          return twimlReply(hours.ok ? `Great — ${agentName} is ringing you now.` : `Great — it's after hours here, so ${agentName} will ring you first thing from ${callback.EARLIEST_HOUR}am. Reply STOP any time to cancel.`);
        }
      }
      // Build the thread as a pseudo-call so think() and the booking path just work.
      const thread = db.getThread(account.id, from);
      const turns = (thread && thread.turns) || [];
      turns.push({ who: 'caller', text: body });
      const hist = stats.callerHistory(account.id, from, suppress.phoneKey);
      const pseudo = { sid: 'sms:' + from, accountId: account.id, account, profile, direction: 'inbound', channel: 'sms',
        from, to, turns, lead: null, leadBrief: hist ? `=== THIS PERSON HAS BEEN IN TOUCH BEFORE ===\n${hist.brief}` : '', startedAt: Date.now() };
      let out;
      try { out = await voice.think(pseudo, body); }
      catch (e) { db.logActivity(account.id, { agent: 'VOICE', msg: `SMS agent error: ${e.message}` }); return twimlReply("Sorry — give me a moment and text again."); }
      turns.push({ who: 'agent', text: out.say });
      db.saveThread(account.id, from, turns, { lastAt: new Date().toISOString() });
      if (out.action === 'dnc') {
        suppress.suppressPhone(account.id, from, 'unsubscribe', { note: 'asked by text' });
      }
      if (out.action === 'book') {
        const d = out.data || {};
        const clash = d.whenISO ? db.findConflict(account.id, d.whenISO, Number((account.voice || {}).slotMinutes) || 60) : null;
        if (clash) {
          turns.push({ who: 'agent', text: '[system: that time is taken — offer the nearest open times]' });
          db.saveThread(account.id, from, turns);
          return twimlReply("Ah — that slot just went. What else works? I can do either side of it.");
        }
        const appt = db.addAppointment(account.id, { profileId: profile.id, callSid: 'sms:' + from,
          name: d.name || (hist && hist.name) || 'Texter', company: d.company || '', phone: d.phone || from,
          email: d.email || '', reason: d.reason || 'booked by text', whenText: d.when || '', startsAt: d.whenISO || '',
          source: 'sms' });
        db.logActivity(account.id, { agent: 'VOICE', msg: `Booked by text: ${appt.name} — ${appt.reason}${d.when ? ' · ' + d.when : ''}` });
        hooks.emit(account, 'booking.created', { appointment: appt, source: 'sms' });
        notify.announceBooking({ account, profile, appointment: appt }).catch(() => {});
      }
      return twimlReply(out.say);
    }

    if (p.startsWith('/voice/')) {
      const raw = await readBody(req);
      const params = parseForm(raw);
      req.__params = params;   // so the outer error handler can name the call
      // Twilio signs the URL it actually POSTed to. Reconstructing it from the
      // request (proxy headers) instead of PUBLIC_URL means webhooks keep
      // verifying through a domain migration — with PUBLIC_URL, flipping the
      // domain before updating the Twilio console would reject every call.
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const base = host ? `${proto}://${host}` : (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      const sig = req.headers['x-twilio-signature'];
      if (!voice.configured()) return xml(res, voice.sayAndHangup("Sorry, this line isn't set up yet. Bye for now."));
      if (!voice.verifySignature(base + p, params, sig)) {
        db.logActivity('system', { agent: 'VOICE', msg: 'Rejected unsigned webhook on ' + p });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('bad signature');
      }
      const sid = params.CallSid || '';

      // ---- inbound: someone rang the number ----
      if (p === '/voice/incoming') {
        const account = db.accountByVoiceNumber(params.To || '');
        if (!account) return xml(res, voice.sayAndHangup("Thanks for calling - this line isn't set up yet. Sorry about that."));
        const vcfg = account.voice || {};
        // Blocked callers (the owner's own list, plus anyone who told us to
        // stop) are rejected before a single AI token or plan minute is spent.
        // <Reject> costs nothing and hangs up without answering.
        if (suppress.isPhoneSuppressed(account.id, params.From || '').blocked) {
          db.logActivity(account.id, { agent: 'VOICE', msg: `Rejected blocked caller ${params.From || 'unknown'} — not billed` });
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>');
        }
        // Switched off means switched off. Nothing was reading this flag, so
        // the owner could turn answering "off" and the AI would keep picking
        // up regardless. Rejecting the call here lets it fall through to the
        // caller's normal path — their carrier voicemail — which is exactly
        // what someone who flips this switch is asking for.
        if (vcfg.enabled === false) {
          db.logActivity(account.id, { agent: 'VOICE', msg: `Call from ${params.From || 'unknown'} not answered - answering is switched off` });
          // A non-TwiML status makes Twilio play its own "application error"
          // recording, which is exactly what the owner does NOT want a real
          // customer to hear. <Reject reason="busy"> hands the call back
          // unanswered so it follows the caller's normal path — their carrier
          // voicemail when the line was conditionally forwarded, which is what
          // "turn answering off" is asking for.
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>');
        }
        const profile = db.getProfile(account.id, vcfg.profileId) || db.getProfiles(account.id)[0];
        if (!profile) return xml(res, voice.sayAndHangup('Thanks for calling. Goodbye.'));
        // A cancelled account is not the same as one over its limit. Taking a
        // message for a company that is no longer a customer promises a
        // callback nobody will ever make, which is worse for the caller than a
        // straight answer.
        if (account.subStatus === 'canceled' || account.subStatus === 'incomplete_expired') {
          db.logActivity(account.id, { agent: 'VOICE', msg: `Call from ${params.From || 'unknown'} - account cancelled, not answering` });
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>');
        }
        const vAllow = plans.voiceAllowed(account, stripe.isOwner(account));
        if (!vAllow.ok) {
          // NEVER hang up on the customer's customer over OUR billing state.
          // This used to drop every inbound call once minutes ran out or a card
          // retry flipped the subscription to past_due — the owner lost every
          // job for the rest of the month and found out from the silence.
          // Take the message instead; the lead survives and the owner gets told.
          db.logActivity(account.id, { agent: 'VOICE', msg: `Over plan limit (${vAllow.reason}) - taking a message instead of hanging up` });
          return xml(res, voice.sayAndGather(
            `Thanks for calling ${profile.name} — I'm their AI receptionist, on a recorded line. I can't put you through this second, but tell me your name, your number and what you need, and I'll make sure someone calls you straight back.`,
            base + '/voice/msg',
            voice.voiceFor(account),
          ));
        }
        const agentName = vcfg.agentName || 'Sarah';
        // Transparency is mandatory: the caller is told it is an AI up front.
        // The AI + transcription disclosure is a fixed prefix the customer
        // CANNOT remove. A custom greeting used to replace the whole line and
        // silently drop it — in Illinois, California and a dozen other
        // all-party-consent states that is $5,000-per-call exposure, and the
        // homepage promises the disclosure happens on every call. Their own
        // greeting still plays; it just comes after the part the law needs.
        const es = voice.langFor(account) === 'es-US';
        // "On a recorded line" is how a PERSON discloses recording -- four
        // words, standard phone English, and it covers the transcript too.
        // "Just so you know, this call may be transcribed" was a legal notice
        // wearing a headset, and it was the second sentence every caller ever
        // heard. Business name FIRST (a caller's real first question is "did I
        // reach the right place"), then the AI identity, which never comes out.
        const recOn = vcfg.record !== false;
        const disclosure = es
          ? 'Hola, se ha comunicado con ' + profile.name + ' — le habla ' + agentName + ', su recepcionista de inteligencia artificial' + (recOn ? ', en una línea grabada' : '') + '.'
          : "Hi, you've reached " + profile.name + ' — this is ' + agentName + ', their AI receptionist' + (recOn ? ', on a recorded line' : '') + '.';
        // Greet returning callers by name. The legal disclosure is unchanged and
        // still comes first; only the friendly part personalises.
        const histEarly = stats.callerHistory(account.id, params.From || '', suppress.phoneKey);
        const dflt = es ? '¿En qué le puedo ayudar?' : 'What can I do for you?';
        const hello = histEarly && histEarly.name
          ? (es ? `Hola ${histEarly.name.split(' ')[0]}, qué gusto escucharle de nuevo — ${(vcfg.greeting || '¿en qué le puedo ayudar hoy?')}`
                : `Hi ${histEarly.name.split(' ')[0]}, good to hear from you again — ${(vcfg.greeting || 'what can I do for you today?').replace(/^\s*[A-Z]/, (c) => c.toLowerCase())}`)
          : (vcfg.greeting || dflt);
        const greeting = disclosure + ' ' + hello;
        // Does this caller already exist as a lead? If so the AI opens the call
        // knowing what we emailed them and where they stand — the thing no
        // email tool and no answering service can do.
        const knownLead = db.getLeads(account.id, profile.id)
          .find((l) => suppress.phoneKey(l.phone || '') && suppress.phoneKey(l.phone) === suppress.phoneKey(params.From || ''));
        // Beyond email leads: anyone who has CALLED or BOOKED before is a known
        // person, and the agent should treat them like one. Built from the
        // call and appointment history for this number.
        const hist = stats.callerHistory(account.id, params.From || '', suppress.phoneKey);
        const leadBrief = [knownLead ? memory.briefFor(knownLead) : '', hist ? `=== THIS CALLER HAS BEEN IN TOUCH BEFORE ===
${hist.brief}
Use it the way a good receptionist would: greet them by name if you have one, don't re-ask what you already know (address, what they usually need), and if they're calling about the same thing as last time, say so. Never read the history back like a file.` : '']
          .filter(Boolean).join('\n\n');
        const inCall = voice.startCall(sid, { accountId: account.id, account, profile, direction: 'inbound',
          from: params.From || '', to: params.To || '', lead: knownLead || null,
          leadBrief, callerName: hist ? hist.name : '' });
        // Record what we just said. Without this the model can't see its own
        // opener and asks the same question again on the next turn.
        inCall.turns.push({ who: 'agent', text: greeting });
        // Warm the prompt cache while the greeting is being spoken. The first
        // real think() otherwise sends the ~3k-token system prompt cold, and
        // that first reply is the slowest turn of the call -- exactly when the
        // caller is deciding whether this thing works. A throwaway 1-token
        // request during the 4-5s greeting means the caller's first answer
        // hits a warm cache. Fire-and-forget; failure changes nothing.
        voice.warmCache(inCall).catch(() => {});
        db.saveCall(account.id, { sid, direction: 'inbound', from: params.From || '', to: params.To || '',
          profileId: profile.id, status: 'in-progress', transcript: [] });
        const inDnc = suppress.isPhoneSuppressed(account.id, params.From || '');
        db.logActivity(account.id, { agent: 'VOICE', msg: 'Incoming call from ' + (params.From || 'unknown')
          + (inDnc.blocked ? ' (this number is on your do-not-call list — they called you, so we answered)' : '') });
        // Record from the first word. Both legs; URL arrives at /voice/recording
        // when the call ends. Never awaited -- a recording failure must not
        // delay or break the greeting.
        if ((account.voice || {}).record !== false) voice.startRecording(sid, base + '/voice/recording').catch(() => {});
        return xml(res, voice.sayAndGather(greeting, base + '/voice/turn', voice.voiceFor(account), voice.hintsFor(profile, account)));
      }

      // ---- outbound call answered ----
      if (p === '/voice/answer') {
        const call = voice.getCall(sid);
        if (/machine|fax/i.test(params.AnsweredBy || '')) {
          // WE dialled THEM and got a machine. The saved message is used only if
          // it actually reads like an outbound pitch: an inbound greeting
          // ("thanks for calling, we couldn't pick up") left on a prospect's
          // machine is nonsense to someone who never rang us, so it is replaced
          // with a real pitch built from the business profile.
          const saved = (call && call.account.voice && call.account.voice.voicemail) || '';
          const usable = saved && !voice.looksInbound(saved);
          const cbLead = call && call.lead && call.lead.callback ? call.lead : null;
          const vm = cbLead
            // A call-back that hits voicemail says exactly what it is: you asked,
            // we rang, here is the number. Never the sales pitch.
            ? `Hi${cbLead.name ? ' ' + cbLead.name : ''}, it's ${(call.account.voice && call.account.voice.agentName) || 'the assistant'} from ${call.profile.name}, returning your ${cbLead.callbackSource === 'missed-call' ? 'call' : 'request'}${cbLead.need ? ' about ' + cbLead.need : ''}. Sorry I missed you — call us back any time on ${String((call.account.voice || {}).number || call.from || '').replace(/[^\d]/g, '').replace(/^1(?=\d{10}$)/, '').split('').join(' ')} and I'll pick up. Thanks!`
            : usable ? saved
            : (call ? voice.voicemailPitch(call.profile, call.account, (call.account.voice || {}).number)
                    : 'Sorry I missed you. I will try again another time.');
          if (call && saved && !usable) {
            db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Your saved voicemail message reads like a greeting for incoming calls, so a proper outbound pitch was left instead. Fix it on the AI answering tab.' });
          }
          if (call) db.saveCall(call.accountId, { sid, status: 'voicemail', outcome: 'voicemail' });
          return xml(res, voice.sayAndHangup(vm, call ? voice.voiceFor(call.account) : undefined));
        }
        if (!call) return xml(res, voice.sayAndHangup("Sorry, something went wrong on my end. Bye for now.", call && call.account ? voice.voiceFor(call.account) : undefined));
        const agentName = (call.account.voice && call.account.voice.agentName) || 'Sarah';
        const who = call.lead && call.lead.name ? ' Am I speaking with ' + call.lead.name + '?' : '';
        // A call-back opens with WHY in the first breath: you asked us. The
        // generic opener below is a cold-call opener and reads as one.
        const cb = call.lead && call.lead.callback ? call.lead : null;
        const opener = cb
          ? 'Hi' + (cb.name ? ' ' + cb.name : '') + ', this is ' + agentName + ', the AI assistant for ' + call.profile.name
            + '. ' + (cb.callbackSource === 'missed-call' ? 'You called us ' + (cb.when || 'a few minutes ago') + ' and we missed each other, so I am ringing you straight back.'
                      : 'You asked us to call you back' + (cb.need ? ' about ' + cb.need : '') + ', so here I am.')
            + ' This call may be recorded, and you can say stop calling at any time. Is now an okay time?'
          : 'Hi, this is ' + agentName + ', the AI receptionist calling on behalf of '
          + call.profile.name + ', on a recorded line.' + who + ' Did I catch you at an okay time?';
        call.turns.push({ who: 'agent', text: opener });   // so it never re-asks the opener
        // Same trick as inbound: warm the prompt cache while the opener plays,
        // so the first real reply — the one that decides whether this call-back
        // feels alive or broken — is not the cold, slowest turn of the call.
        voice.warmCache(call).catch(() => {});
        if ((call.account.voice || {}).record !== false) voice.startRecording(sid, base + '/voice/recording').catch(() => {});
        return xml(res, voice.sayAndGather(opener, base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account)));
      }

      // ---- partial speech results (speculation feed) ----
      // Answer instantly; Twilio fires these rapidly mid-utterance and they
      // must never slow the call. The debounce timer restarts on every
      // partial, so speculation launches only once the stream goes quiet.
      if (p === '/voice/partial') {
        const call = voice.getCall(sid);
        if (call && process.env.VOICE_SPECULATE !== 'off') {
          const t = String(params.UnstableSpeechResult || params.SpeechResult || '').trim();
          if (t) {
            call.partialLatest = t;
            clearTimeout(call.specTimer);
            call.specTimer = setTimeout(() => { try { launchSpeculation(sid); } catch {} }, 600);
          }
        }
        res.writeHead(204); return res.end();
      }

      // ---- one conversational turn ----
      if (p === '/voice/turn') {
        const call = voice.getCall(sid);
        if (!call) return xml(res, voice.sayAndHangup("Sorry, we got cut off there. Give us a call back?", call && call.account ? voice.voiceFor(call.account) : undefined));
        // The ack's redirect leg: pendingThink set and no new speech means
        // Twilio has just finished playing the acknowledgment and come back
        // for the real answer. Skip the input guards — this request carries
        // no input, and limits were checked when the caller's turn arrived.
        let out = null;
        if (call.pendingThink && !(params.SpeechResult || '').trim()) {
          const pending = call.pendingThink; call.pendingThink = null;
          const r = await pending;
          if (r.err) {
            db.logActivity(call.accountId, { agent: 'VOICE', msg: 'AI error mid-call: ' + r.err.message });
            db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'ai-error', transcript: call.turns });
            return xml(res, voice.sayAndHangup("Something's glitching on my end - sorry. I'll get someone to call you back.", voice.voiceFor(call.account)));
          }
          out = r.v;
        }
        if (out === null) {
        // Twilio scores every transcription 0-1. Background noise — a TV, a
        // radio, traffic, someone else in the room — comes back as low-
        // confidence word salad ("um the the yeah"), and treating it the same
        // as a clear sentence made the agent answer things nobody said. Below
        // the floor it is treated as silence, so the caller gets the patient
        // "take your time" instead of a reply to the television.
        call.pendingThink = null;
        const rawHeard = (params.SpeechResult || '').trim();
        const conf = params.Confidence !== undefined ? Number(params.Confidence) : NaN;
        const heard = voice.isNoise(rawHeard, conf) ? '' : rawHeard;
        if (rawHeard && !heard) {
          call.noiseHits = (call.noiseHits || 0) + 1;
          db.logActivity(call.accountId, { agent: 'VOICE', msg: `Ignored low-confidence audio (${isNaN(conf) ? '?' : conf.toFixed(2)}): "${rawHeard.slice(0, 60)}"` });
        }

        if (!heard) {
          // Background noise doesn't just garble input — with barge-in on, it
          // CUTS THE AGENT OFF mid-sentence, and the old response ("take your
          // time...") abandoned the clipped sentence entirely. That is the
          // "it stops talking when there's noise" experience. Now the first
          // noise event on a turn finishes the thought: repeat the last thing
          // the agent said, with barge-in OFF so it cannot be clipped again —
          // and every later reply on this call also plays uninterruptible,
          // via the noisy flag the call now carries.
          // Second noise event or later ONLY. The first low-confidence hit is
          // as likely to be the caller's own voice on a speakerphone as a TV,
          // and replaying a sentence at someone who just spoke reads as the
          // agent glitching. One miss gets the gentle nudge below; a PATTERN
          // of noise gets the resume -- worded like a person picking their
          // thread back up, never like a machine announcing a retry.
          if (rawHeard && (call.noiseHits || 0) >= 2) {
            const lastAgent = [...call.turns].reverse().find((t) => t.who === 'agent' && !/^\[system/.test(t.text || ''));
            if (lastAgent && call.replayAt !== call.turns.length) {
              call.replayAt = call.turns.length;
              return xml(res, voice.sayAndGather("Sorry, it's a little loud — as I was saying: " + lastAgent.text,
                base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account), { noisy: true }));
            }
          }
          call.silence = (call.silence || 0) + 1;
          // Three strikes, not two: an empty gather usually means they were
          // still thinking, not that the line is dead, and hanging up on
          // someone mid-thought is worse than waiting one more beat.
          if (call.silence >= 3) {
            db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'no-response', transcript: call.turns });
            return xml(res, voice.sayAndHangup("I can't hear anything, so I'll let you go. Call back anytime.", call && call.account ? voice.voiceFor(call.account) : undefined));
          }
          // Don't apologise on the first miss. "Sorry, you cut out" when the
          // caller simply had not started talking is what makes it feel deaf;
          // a person would just wait, then gently re-ask.
          const nudge = call.silence === 1
            ? 'Take your time — what can I do for you?'
            : "Sorry, I'm not hearing you — are you still there?";
          return xml(res, voice.sayAndGather(nudge, base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account), { noisy: (call.noiseHits || 0) >= 1 }));
        }
        call.silence = 0;
        call.turns.push({ who: 'caller', text: heard });
        // They engaged. That outranks anything a drip campaign can tell us.
        if (!call.markedWarm && call.lead) {
          call.markedWarm = true;
          try { memory.remember(call.accountId, call.lead, { kind: 'call-answered', channel: 'phone', summary: 'spoke with them on the phone' }); } catch {}
        }

        // Demo calls get tighter limits than a paying customer's — see
        // limitsFor(): the demo line bills nobody, so a ten-minute one is pure
        // spend, while a customer's call is 87% margin and must not be cut off.
        const LIM = voice.limitsFor(call.account);
        const elapsedSec = Math.round((Date.now() - call.startedAt) / 1000);
        if (elapsedSec > LIM.seconds) {
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'time-limit', transcript: call.turns,
            durationSec: elapsedSec, estCost: voice.estimateCost({ durationSec: elapsedSec, turns: call.turns.filter((t) => t.who === 'caller').length }) });
          return xml(res, voice.sayAndHangup("I've got to run, but someone will follow up with you. Thanks for your time.", call && call.account ? voice.voiceFor(call.account) : undefined));
        }
        // Count the caller's turns, not every utterance — an exchange is a
        // pair, and our own opener is in here too.
        const exchanges = call.turns.filter((t) => t.who === 'caller').length;
        // The cap exists to stop a runaway call, NOT to hang up on a buyer.
        // Someone who just said "I want the tester" or "sign me up" is the
        // best thing that can happen on this line, and the cap fired on
        // exactly that turn — cutting off the sale. If the latest thing they
        // said sounds like intent to buy or book, or the agent has details it
        // owes them, the cap yields: we let the model take ONE more turn to
        // close, then a hard stop a few turns beyond that.
        const buying = /(sign\s*me\s*up|sign\s*up|i(?:'| wi)?ll take|i want (?:the |to )|let'?s do (?:it|that)|book (?:it|me|that)|yes,? (?:let'?s|do it|please)|how do i (?:pay|start|get started)|the (?:tester|starter|front desk|growth|scale|complete))/i.test(heard);
        const hardStop = LIM.exchanges + 4;
        if (exchanges > hardStop || (exchanges > LIM.exchanges && !buying)) {
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'max-length', transcript: call.turns });
          // Even the hard stop leaves them a way to buy. On the demo line the
          // person may well be sold; sending them off with "someone will follow
          // up" throws that away, so give the site out loud before hanging up.
          const bye = voice.demoModeFor(call.account)
            ? "I don't want to keep you all day. Everything you just heard is at dawnpipe dot com — takes about five minutes to set up. Thanks for calling."
            : "Listen, I don't want to keep you all day - let me get someone to follow up properly. Thanks for your time.";
          return xml(res, voice.sayAndHangup(bye, call && call.account ? voice.voiceFor(call.account) : undefined));
        }
        if (exchanges > LIM.exchanges && buying) {
          call.closing = true;   // tell the model: they're buying — close, don't chat
        }

        // LATENCY: the model races a 700ms timer. A fast reply goes straight
        // out, exactly as before. A slow one no longer means dead air — the
        // caller hears a short human acknowledgment ("Mm-hmm." / "Let me check
        // the diary.") IMMEDIATELY, and Twilio redirects back here while the
        // model keeps thinking, so the thinking overlaps the acknowledgment
        // and the round-trip instead of stacking after them. The redirect leg
        // is recognised by pendingThink + an empty SpeechResult, and skips the
        // guards above (its limits were checked when the real turn arrived).
        // A speculation launched off the partials may already hold this very
        // answer. Reuse it ONLY when the final transcript matches what was
        // speculated on; otherwise think fresh, exactly as if speculation had
        // never existed. Either way the per-turn spec state resets here.
        clearTimeout(call.specTimer);
        const spec = call.spec; call.spec = null; call.specCount = 0; call.partialLatest = '';
        const specHit = spec && spec.norm === voice.normSpeech(heard);
        let thinkWrapped = specHit ? spec.promise : voice.think(call, heard).then((v) => ({ v }), (err) => ({ err }));
        // 1200ms, raised from 700: at 700 the ack fired on nearly every turn,
        // so every answer opened with a canned "Okay." -- and the model often
        // opened with its own "okay", doubling up into something that sounded
        // broken. Now only a genuinely slow turn gets bridged, the bridge
        // SAYS something (a salesperson fills a pause with substance, not a
        // murmur), and it lands in the transcript so the model continues the
        // thread instead of acknowledging twice.
        const winner = await Promise.race([thinkWrapped, new Promise((r2) => setTimeout(() => r2(null), 1200))]);
        let raced;
        if (!winner) {
          call.pendingThink = thinkWrapped;
          const ack = /book|appoint|schedul|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|available|opening|o'?clock/i.test(heard)
            ? "Let me look at the diary for you."
            : /price|cost|how much|charge|expensive|month/i.test(heard)
              ? "Good question."
              : "One sec.";
          call.turns.push({ who: 'agent', text: ack });
          return xml(res, voice.twiml(voice.say(ack, voice.voiceFor(call.account)) + `<Redirect method="POST">${voice.esc(base + '/voice/turn')}</Redirect>`));
        }
        raced = winner;
        // A speculative call that errored must not end the call: it was a
        // bonus attempt, so fall back to a fresh think with its own race.
        if (raced && raced.err && specHit) {
          thinkWrapped = voice.think(call, heard).then((v) => ({ v }), (err) => ({ err }));
          raced = await Promise.race([thinkWrapped, new Promise((r2) => setTimeout(() => r2(null), 1200))]);
          if (!raced) {
            call.pendingThink = thinkWrapped;
            call.turns.push({ who: 'agent', text: 'One sec.' });
            return xml(res, voice.twiml(voice.say('One sec.', voice.voiceFor(call.account)) + `<Redirect method="POST">${voice.esc(base + '/voice/turn')}</Redirect>`));
          }
        }
        if (raced.err) {
          const e = raced.err;
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'AI error mid-call: ' + e.message });
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'ai-error', transcript: call.turns });
          return xml(res, voice.sayAndHangup("Something's glitching on my end - sorry. I'll get someone to call you back.", call && call.account ? voice.voiceFor(call.account) : undefined));
        }
        out = raced.v;
        }
        call.turns.push({ who: 'agent', text: out.say });
        db.saveCall(call.accountId, { sid, transcript: call.turns });

        if (out.action === 'dnc') {
          const num = call.direction === 'inbound' ? params.From : call.to;
          suppress.suppressPhone(call.accountId, num, 'unsubscribe', { note: 'do-not-call, asked on a call' });
          if (call.lead) { try { memory.remember(call.accountId, call.lead, { kind: 'note', channel: 'phone', stage: 'dnc', summary: 'asked not to be contacted' }); } catch {} }
          if (call.lead && call.lead.email) suppress.suppress(call.accountId, call.lead.email, 'unsubscribe', { note: 'do-not-call, by phone' });
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'do-not-call', transcript: call.turns });
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'DO NOT CALL requested by ' + num + ' - suppressed' });
          return xml(res, voice.sayAndHangup(out.say || "Understood - you're off the list. Sorry to have bothered you.", call && call.account ? voice.voiceFor(call.account) : undefined));
        }
        // Remember the highest urgency seen on this call — it decides who gets
        // dialled and whether the tech gets a text before their phone rings.
        const RANK = { routine: 0, urgent: 1, emergency: 2 };
        if ((RANK[out.urgency] || 0) > (RANK[call.urgency] || 0)) call.urgency = out.urgency;

        if (out.action === 'transfer') {
          const vc = call.account.voice || {};
          // Waterfall: an ordered on-call list, tried in sequence until someone
          // answers. One number was the old model — if the tech was on a roof
          // with the phone in the truck, a $1,500 emergency became a message
          // read at 7am. The on-call list falls back to transferTo so existing
          // customers keep working unchanged.
          const chain = (Array.isArray(vc.onCall) && vc.onCall.length ? vc.onCall : [vc.transferTo]).map((n) => voice.toE164(n)).filter(Boolean);
          if (!chain.length) {
            // No transfer number configured. On a CUSTOMER's line that is a
            // take-a-message moment. On the DEMO line it was the single worst
            // moment of the whole pitch: a prospect asks for a person and the
            // showcase says "nobody's free" — sounding exactly like the
            // voicemail hell they're trying to escape. On the demo, the honest
            // answer IS the sales pitch: on your line, this rings YOUR phone.
            const line = voice.demoModeFor(call.account)
              ? "Good question — on your business's line, this is the moment I'd patch you straight through to the owner's cell, or walk down an on-call list until a real person picks up. I'm on the demo number, so there's nobody behind me to ring — but that transfer is exactly what your customers would get. Want me to show you the booking side instead?"
              : "There's nobody free right this second, but I can take a message and make sure it gets to them. What's the best number for you?";
            return xml(res, voice.sayAndGather(line, base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account), { noisy: (call.noiseHits || 0) >= 1 }));
          }
          call.dialChain = chain; call.dialIdx = 0;
          const to = chain[0];
          const isEmergency = call.urgency === 'emergency';
          db.logActivity(call.accountId, { agent: 'VOICE', msg: (isEmergency ? 'EMERGENCY — ' : '') + 'Transferring call to ' + to + (chain.length > 1 ? ` (1 of ${chain.length} on-call)` : '') });
          // Emergency: text the on-call tech the details BEFORE their phone
          // rings, so they answer already knowing it's a burst pipe at 14 Elm,
          // not a stranger. Fire-and-forget; the dial must not wait on SMS.
          if (isEmergency) {
            const d = out.data || {};
            const from = params.From || call.from || '';
            hooks.emit(call.account, 'emergency.escalated', { callSid: sid, from, name: d.name || '', reason: d.reason || '', onCall: chain });
            const body = `🚨 EMERGENCY call coming through now from ${from}${d.name ? ' — ' + d.name : ''}${d.reason ? ': ' + d.reason : ''}. Dawnpipe is connecting them to you.`;
            const mine = vc.number || (stripe.isOwner(call.account) ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
            for (const n of chain) notify.sendSMS(n, body, mine).catch(() => {});
          }
          return xml(res, voice.sayAndDial(out.say || (isEmergency ? "Okay — I'm getting someone on the line for you right now, stay with me." : 'One sec, putting you through.'), to, base + '/voice/dialback', voice.voiceFor(call.account)));
        }
        if (out.action === 'book') {
          const d = out.data || {};
          const phone = d.phone || params.From || '';
          // Hard conflict check, independent of the prompt. The model is TOLD
          // not to book into taken time, but a promise in a prompt is not a
          // guarantee -- so if the slot it chose overlaps an existing booking,
          // refuse to write it and send the agent back to offer another time.
          // A double-booked plumber is the failure that gets us switched off.
          if (d.whenISO) {
            const clash = db.findConflict(call.accountId, d.whenISO, Number((call.account.voice || {}).slotMinutes) || 60);
            if (clash) {
              const tz = voice.tzFor(call.account);
              const when = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(clash.startsAt));
              db.logActivity(call.accountId, { agent: 'VOICE', msg: `Refused a double-booking at ${when} — asked the caller for another time` });
              call.turns.push({ who: 'agent', text: `[system: ${when} is already taken — offer the nearest open times instead]` });
              return xml(res, voice.sayAndGather(
                `Ah — that slot's actually just been taken. What else works for you? I can look at either side of it.`,
                base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account),
                { noisy: (call.noiseHits || 0) >= 1 },
              ));
            }
          }
          // Put it in the diary. startsAt is the resolved date-time the agent
          // committed to; whenText keeps their own words for context.
          call.saved = true;   // hangup salvage must not create a duplicate
          const appt = db.addAppointment(call.accountId, {
            profileId: call.profile.id, callSid: sid,
            name: d.name || 'Caller', company: d.company || '', phone,
            email: d.email || '', reason: d.reason || 'callback',
            whenText: d.when || '', startsAt: d.whenISO || '',
            source: call.direction === 'inbound' ? 'inbound call' : 'outbound call',
          });
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'booked', transcript: call.turns,
            booking: { name: d.name, company: d.company, phone, reason: d.reason, when: d.when } });
          hooks.emit(call.account, 'booking.created', { appointment: appt, callSid: sid, source: 'phone' });
          db.addLeads(call.accountId, call.profile.id, [{
            name: d.name || 'Caller', company: d.company || '', email: '',
            emailConfidence: 'imported', emailSource: 'phone call',
            notes: 'PHONE ' + call.direction + ' | ' + phone + ' | wants: ' + (d.reason || 'callback') + ' | when: ' + (d.when || 'unspecified'),
          }]);
          if (call.lead) {
            try {
              memory.remember(call.accountId, call.lead, {
                kind: 'call-booked', channel: 'phone', stage: 'hot',
                summary: `booked ${d.whenISO || d.when || 'a callback'}`,
                facts: [d.reason ? `Wants: ${d.reason}` : '', d.company ? `Company: ${d.company}` : ''].filter(Boolean),
              });
            } catch {}
          }
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Appointment booked: ' + (d.name || 'caller') + ' (' + phone + ') - ' + (d.whenISO || d.when || 'time TBC') });
          // Close the loop OUT of the server: text the caller, and put a calendar
          // invite in the owner's inbox. Fire-and-forget so a failed text can
          // never cost us the booking or delay the goodbye.
          notify.announceBooking({ appointment: appt, profile: call.profile, account: call.account })
            .then((r) => {
              const bits = [];
              if (r.sms) bits.push(r.sms.ok ? 'confirmation texted' : `text failed: ${r.sms.error}`);
              if (r.email) bits.push(r.email.ok ? 'invite emailed to you' : `email failed: ${r.email.error}`);
              if (bits.length) db.logActivity(call.accountId, { agent: 'VOICE', msg: bits.join(' · ') });
            })
            .catch((e) => db.logActivity(call.accountId, { agent: 'VOICE', msg: `Booking notifications failed: ${e.message}` }));
          // Don't cut them off the instant the confirmation lands.
          return xml(res, voice.sayAndSignOff(
            out.say || "Perfect, that's booked in.",
            voice.voiceFor(call.account),
            'Someone will be in touch. Thanks for your time, and have a good one. Bye now.'));
        }
        if (out.action === 'end') {
          // A call that ended without a slot being agreed is NOT nothing. The
          // agent routinely takes a name and a number and says "someone will
          // be in touch" — and that used to save a transcript and no more, so
          // the owner had a real customer waiting for a callback and an empty
          // calendar. Anything with contact details lands in the diary as an
          // unscheduled callback and the owner is told.
          const d = out.data || {};
          const phone = d.phone || (call.direction === 'inbound' ? params.From : call.to) || '';
          const gotSomething = !!(d.name || d.reason || phone);
          let appt = null;
          if (gotSomething) {
            try {
              call.saved = true;
              appt = db.addAppointment(call.accountId, {
                profileId: call.profile.id, callSid: sid,
                name: d.name || 'Caller', company: d.company || '', phone,
                email: d.email || '', reason: d.reason || 'wants a callback',
                whenText: d.when || 'call back - no time agreed', startsAt: d.whenISO || '',
                source: call.direction === 'inbound' ? 'inbound call' : 'outbound call',
              });
            } catch (e) {
              db.logActivity(call.accountId, { agent: 'VOICE', msg: `Could not save callback: ${e.message}` });
            }
          }
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: appt ? 'callback' : 'ended', transcript: call.turns });
          if (appt) {
            db.logActivity(call.accountId, { agent: 'VOICE', profileId: call.profile.id,
              msg: `Callback needed: ${d.name || 'Caller'}${d.company ? ' (' + d.company + ')' : ''} on ${phone}${d.reason ? ' - ' + d.reason : ''}` });
            notify.announceBooking({ account: call.account, profile: call.profile, appointment: appt })
              .catch((e) => db.logActivity(call.accountId, { agent: 'VOICE', msg: `Callback notify failed: ${e.message}` }));
          }
          return xml(res, voice.sayAndSignOff(out.say, voice.voiceFor(call.account), 'Thanks for your time. Bye now.'));
        }
        return xml(res, voice.sayAndGather(out.say, base + '/voice/turn', voice.voiceFor(call.account), voice.hintsFor(call.profile, call.account), { noisy: (call.noiseHits || 0) >= 1 }));
      }

      // ---- a recording finished ----
      if (p === '/voice/recording') {
        const rsid = params.RecordingSid || '', rurl = params.RecordingUrl || '';
        const dur = Number(params.RecordingDuration || 0);
        const owner = db.accountByCallSid(sid);
        if (owner && rsid) {
          db.saveCall(owner.id, { sid, recordingSid: rsid, recordingUrl: rurl, recordingSec: dur });
        }
        res.writeHead(204); return res.end();
      }

      // ---- message taken because the plan was out of minutes ----
      // The call still happened and the caller still wants the work, so the
      // details land in the diary as an unscheduled booking and the owner is
      // emailed — including WHY, so they can top up instead of quietly
      // bleeding jobs.
      if (p === '/voice/msg') {
        const acct = db.accountByVoiceNumber(params.To || '');
        const heard = String(params.SpeechResult || params.Digits || '').trim();
        if (acct) {
          const prof = db.getProfile(acct.id, (acct.voice || {}).profileId) || db.getProfiles(acct.id)[0];
          const from = params.From || '';
          try {
            db.addAppointment(acct.id, {
              name: 'Caller', phone: from, whenText: 'call back - message taken',
              reason: heard || '(no message captured)', source: 'voice-overlimit', startsAt: '',
            });
          } catch (e) {
            db.logActivity(acct.id, { agent: 'VOICE', msg: `Could not save message: ${e.message}` });
          }
          db.logActivity(acct.id, { agent: 'VOICE', msg: `Message taken from ${from} (over plan limit): ${heard.slice(0, 140)}` });
          try {
            await notify.callSummary({
              account: acct, profile: prof, outcome: 'message taken - OVER PLAN LIMIT, top up to keep answering live',
              call: { from, durationSec: 0, transcript: [{ who: 'caller', text: heard || '(nothing captured)' }] },
            });
          } catch {}
        }
        return xml(res, voice.sayAndHangup(
          "Got it — I've passed that on and someone will call you right back. Thanks for calling.",
          acct ? voice.voiceFor(acct) : undefined,
        ));
      }

      // ---- TEST ONLY: seed an in-memory call with an on-call chain ----
      // Exists solely so the waterfall can be driven end to end by a signed
      // webhook test. Compiled out of production: requires TEST_HOOKS=1, which
      // render.yaml never sets.
      if (p === '/voice/__test_seed_chain' && process.env.TEST_HOOKS === '1') {
        const acct = db.allAccounts()[0];
        voice.startCall(sid, { accountId: acct.id, account: acct, profile: { id: 'p', name: 'Test' },
          direction: 'inbound', from: '+15551230000', to: '+12136822616', lead: null });
        const c = voice.getCall(sid);
        c.dialChain = ['+13125550101', '+13125550102', '+13125550103']; c.dialIdx = 0; c.urgency = 'emergency';
        res.writeHead(200); return res.end('seeded');
      }

      // ---- a transfer came back unanswered ----
      // Twilio POSTs here when <Dial> ends. If the human actually picked up we
      // let the call finish; anything else (no answer, busy, declined, bad
      // number) used to silently end the call, so instead we pick the
      // conversation back up and take a message.
      if (p === '/voice/dialback') {
        const call = voice.getCall(sid);
        const st = String(params.DialCallStatus || '');
        if (st === 'completed' || st === 'answered') {
          if (call) db.saveCall(call.accountId, { sid, outcome: 'transferred', transcript: call.turns });
          res.writeHead(204); return res.end();
        }
        // Waterfall: this number didn't pick up — try the next one on the
        // on-call list before giving up. Only when the whole chain is exhausted
        // do we fall back to taking a message.
        if (call && Array.isArray(call.dialChain) && (call.dialIdx + 1) < call.dialChain.length) {
          call.dialIdx += 1;
          const next = call.dialChain[call.dialIdx];
          db.logActivity(call.accountId, { agent: 'VOICE', msg: `On-call ${call.dialIdx} of ${call.dialChain.length} didn't answer (${st || 'unknown'}) — trying ${next}` });
          return xml(res, voice.sayAndDial('One moment — trying the next person.', next, base + '/voice/dialback', voice.voiceFor(call.account)));
        }
        if (call) {
          const tried = Array.isArray(call.dialChain) ? call.dialChain.length : 1;
          db.logActivity(call.accountId, { agent: 'VOICE', msg: `Transfer not answered by ${tried} on-call number(s) (${st || 'unknown'}) - taking a message instead` });
        }
        return xml(res, voice.sayAndGather(
          call && call.urgency === 'emergency'
            ? "I couldn't reach the on-call tech just then — I've already sent them your details and they'll be calling you back as soon as they see it. Give me the best number and the address, and if it's safe to, shut the water off at the mains while you wait."
            : "Sorry — couldn't get hold of anyone just then. Let me take your number and what it's about, and I'll have someone call you straight back.",
          base + '/voice/turn',
          call && call.account ? voice.voiceFor(call.account) : undefined,
          call ? voice.hintsFor(call.profile, call.account) : '',
          { noisy: !!(call && (call.noiseHits || 0) >= 1) },
        ));
      }

      // ---- call finished ----
      if (p === '/voice/status') {
        const call = voice.getCall(sid);
        // A deploy mid-call wipes the in-memory record; bill from the persisted
        // one so those minutes still count against the plan.
        if (!call && sid) {
          const owner2 = db.accountByCallSid(sid);
          if (owner2) {
            const dur0 = Number(params.CallDuration || 0);
            db.saveCall(owner2.id, { sid, status: params.CallStatus || 'completed', durationSec: dur0 });
            plans.consumeVoiceMinutes(owner2, Math.ceil(dur0 / 60), stripe.isOwner(owner2));
          }
          res.writeHead(204); return res.end();
        }
        if (call) {
          const dur = Number(params.CallDuration || 0);
          // Bill the plan's minute allowance (rounded up, like a carrier) --
          // but NOT for calls where the caller never said a word. Robocalls,
          // dead air and pocket dials were eating paid minutes and could push
          // a shop into message-only mode mid-month; every competitor excludes
          // spam from billing, and it is the right thing to do regardless.
          const callerSpoke = (call.turns || []).some((t) => t.who === 'caller' && String(t.text || '').trim());
          const acctForBill = db.getAccount(call.accountId);
          if (acctForBill && callerSpoke) plans.consumeVoiceMinutes(acctForBill, Math.ceil(dur / 60), stripe.isOwner(acctForBill));
          if (!callerSpoke && dur > 0) db.logActivity(call.accountId, { agent: 'VOICE', msg: `Not billed: nobody spoke (${dur}s, likely spam or a dropped call)` });
          // MISSED-CALL TEXT-BACK. A real person who hung up before the agent
          // got a word in -- gave up on the greeting, bad signal, changed their
          // mind -- is still a lead, and the highest-ROI capture in trades is
          // texting them within seconds. Only inbound, only real callers (not
          // blocked, not the shop's own transfer numbers), only if we have a
          // line to text from, only once per number per day, and never to
          // someone who opted out. Robocalls hang up too; the 5-second floor
          // and the not-a-known-spam check keep most of those out.
          try {
            const vc = call.account.voice || {};
            const from = params.From || call.from || '';
            const mine = vc.number || (stripe.isOwner(call.account) ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
            const isOwnLine = [vc.transferTo, ...(Array.isArray(vc.onCall) ? vc.onCall : [])].some((n) => n && suppress.phoneKey(n) === suppress.phoneKey(from));
            const bookedOrCallback = ['booked', 'callback', 'transferred'].includes(((db.getCalls(call.accountId, 50).find((c) => c.sid === sid) || {}).outcome) || '');
            if (call.direction === 'inbound' && !callerSpoke && dur >= 5 && mine && from && !isOwnLine && !bookedOrCallback
                && vc.textBack !== false && !suppress.isPhoneSuppressed(call.accountId, from).blocked
                && !stats.textedToday(call.accountId, from)) {
              const biz = (call.profile && call.profile.name) || 'us';
              const offerCall = vc.callBackMissed === true;
              const body = offerCall
                ? `Hi — this is ${biz}. Looks like we just missed each other. Reply YES and our AI assistant will call you right back, or reply here with what you need. You can also call any time and I'll pick up: ${mine}. Reply STOP to opt out.`
                : `Hi — this is ${biz}. Looks like we just missed each other. Reply here with what you need and a good time, or call back any time and I'll pick up: ${mine}. Reply STOP to opt out.`;
              if (offerCall) {
                // The offer is recorded so a "YES" has something to attach to and
                // the consent evidence names exactly what was offered.
                db.addCallback(call.accountId, { source: 'missed-call', name: '', phone: from, phoneKey: suppress.phoneKey(from), need: '',
                  status: 'offered', offerText: body, callSid: sid, profileId: call.profile && call.profile.id || '' });
              }
              notify.sendSMS(from, body, mine).then((r) => {
                if (r && r.ok) { stats.markTexted(call.accountId, from); db.logActivity(call.accountId, { agent: 'VOICE', msg: `Missed-call text sent to ${from}${offerCall ? ' (offered a call-back)' : ''}` }); }
                else db.logActivity(call.accountId, { agent: 'VOICE', msg: `Missed-call text to ${from} failed: ${(r && r.error) || 'unknown'}` });
              }).catch(() => {});
            }
          } catch (e) { db.logActivity(call.accountId, { agent: 'VOICE', msg: `Text-back error: ${e.message}` }); }
          // Twilio bills ONE speech recognition per CALLER turn. Passing
          // call.turns.length -- caller + agent + bridge lines together --
          // inflated the recognition and AI lines ~2x, and the owner read the
          // inflated number as the real bill. Chars stay agent-side (that is
          // what TTS billed) minus the [system: notes nobody ever spoke.
          const billableTurns = call.turns.filter((t) => t.who === 'caller').length;
          db.saveCall(call.accountId, { sid, status: params.CallStatus || 'completed',
            durationSec: dur, transcript: call.turns,
            turns: billableTurns,
            estCost: voice.estimateCost({ durationSec: dur, turns: billableTurns,
              chars: call.turns.filter((t) => t.who !== 'caller' && !/^\[system/.test(t.text || '')).reduce((n, t) => n + (t.text || '').length, 0),
              direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
              tier: /Generative|Chirp3/.test(voice.voiceFor(call.account)) ? 'generative' : 'neural' }) });
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Call ' + params.CallStatus + ' (' + (params.CallDuration || 0) + 's)' });
          hooks.emit(call.account, 'call.completed', { callSid: sid, direction: call.direction, from: call.from || params.From || '', to: call.to || params.To || '',
            durationSec: dur, outcome: (db.getCalls(call.accountId, 50).find((c) => c.sid === sid) || {}).outcome || params.CallStatus,
            urgency: call.urgency || 'routine', transcript: call.turns });
          // Reply to Twilio NOW — it only needs the ack — then salvage in the
          // background so a slow model reply can't stall the webhook.
          res.writeHead(204); res.end();
          // The caller hung up before the agent got a closing turn. Whatever
          // they said in the meantime — a name, a number, "tomorrow morning" —
          // is only in call.turns, and used to be thrown away with them.
          // Read it once and put it in the diary before letting the call go.
          const snapshot = { ...call, turns: call.turns.slice() };
          voice.endCall(sid);
          if (!snapshot.saved && snapshot.turns.some((t) => t.who === 'caller')) {
            voice.salvageFromTranscript(snapshot).then((got) => {
              if (!got || !got.wantsCallback) return;
              const from = snapshot.direction === 'inbound' ? (params.From || snapshot.from || '') : (snapshot.to || '');
              const phone = got.phone || from;
              const transcriptNote = snapshot.turns.map((t) => `${t.who === 'caller' ? 'Caller' : 'AI'}: ${t.text}`).join('\n');
              const appt = db.addAppointment(snapshot.accountId, {
                profileId: snapshot.profile.id, callSid: sid,
                name: got.name || 'Caller', company: got.company || '', phone,
                email: '', reason: got.reason || got.summary || 'wants a callback',
                whenText: got.when || 'call back - no time agreed', startsAt: got.whenISO || '',
                notes: (got.summary ? got.summary + '\n\n' : '') + '--- what was said ---\n' + transcriptNote,
                source: (snapshot.direction === 'inbound' ? 'inbound call' : 'outbound call') + ' (caller hung up)',
              });
              db.saveCall(snapshot.accountId, { sid, outcome: got.whenISO ? 'booked' : 'callback' });
              db.logActivity(snapshot.accountId, { agent: 'VOICE', profileId: snapshot.profile.id,
                msg: `Saved from a call that ended early: ${got.name || 'Caller'} on ${phone}${got.when ? ' - ' + got.when : ''}` });
              return notify.announceBooking({ account: snapshot.account, profile: snapshot.profile, appointment: appt });
            }).catch((e) => db.logActivity(snapshot.accountId, { agent: 'VOICE', msg: `Could not salvage call details: ${e.message}` }));
          }
          return;
        }
        res.writeHead(204); return res.end();
      }
      return xml(res, voice.sayAndHangup("Thanks, bye."));
    }

    // Mail scanners and uptime monitors probe with HEAD; Node suppresses the
    // body automatically, so treating it as GET is safe and stops the homepage
    // "redirecting to /login" in link-checker eyes.
    if (req.method === 'HEAD') req.method = 'GET';

    // ---- PUBLIC one-click unsubscribe (no login; must never 404) ----
    // Gmail/Yahoo send an automated POST here (List-Unsubscribe-Post). Humans
    // arrive by GET from the footer link. Both suppress immediately.
    if (p.startsWith('/u/')) {
      const parsed = suppress.parseToken(p.slice(3));
      const done = (msg, sub) => html(res, `<!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Unsubscribed</title>
        <style>body{font-family:"Iowan Old Style",Georgia,serif;background:#f4f1ea;color:#1a1815;
        display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
        .b{background:#fbfaf6;border:1px solid #d9d3c6;border-radius:12px;padding:34px;max-width:460px;text-align:center}
        h1{font-size:22px;margin:0 0 8px}p{color:#4a463f;margin:0;font-size:15px;line-height:1.55}</style>
        <div class="b"><h1>${msg}</h1><p>${sub}</p></div>`);
      if (!parsed) return done('Link not recognised', 'This unsubscribe link is invalid or expired. If you keep receiving mail, reply to the message and ask to be removed.');
      if (req.method === 'POST' || req.method === 'GET') {
        suppress.suppress(parsed.accountId, parsed.email, 'unsubscribe', { note: req.method === 'POST' ? 'one-click' : 'footer link' });
        // "Never contacted again" has to mean every channel. Unsubscribing by
        // email while the dialler keeps their number is the single worst way
        // to break that promise, because the person already told us to stop.
        try {
          const match = db.getLeads(parsed.accountId).find((l) => (l.email || '').toLowerCase() === parsed.email.toLowerCase());
          if (match && match.phone) {
            suppress.suppressPhone(parsed.accountId, match.phone, 'unsubscribe', { note: 'unsubscribed by email' });
          }
        } catch (e) {
          db.logActivity(parsed.accountId, { agent: 'SEND', msg: `Could not extend unsubscribe to phone: ${e.message}` });
        }
        db.logActivity(parsed.accountId, { agent: 'SEND', msg: `Unsubscribed: ${parsed.email}` });
        if (req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK'); }
        return done('You’re unsubscribed', `We’ve removed <b>${parsed.email}</b>. You won’t receive any more messages from this sender.`);
      }
    }



    // ---------- public ----------
    if (req.method === 'GET' && p === '/') {
      if (account) return redirect(res, '/app');
      // Demo video: set DEMO_VIDEO_URL (YouTube/Loom EMBED url) to show it;
      // until then a styled placeholder keeps the section presentable.
      // A recorded walkthrough when one exists; otherwise the self-running
      // demo, which needs no camera and can never go stale.
      const demo = process.env.DEMO_VIDEO_URL
        ? `<div style="position:relative;padding-top:56.25%;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#000"><iframe src="${process.env.DEMO_VIDEO_URL}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen loading="lazy"></iframe></div>`
        : view('demo.html');
      // The live phone demo IS the product demo — nobody has to trust a video.
      const { tel } = demoTel();
      let page = view('landing.html').replace('__DEMO_VIDEO__', demo);
      if (!tel) {
        // No number configured — drop the call panel rather than show a dead link.
        page = page.replace(/<div class="calldemo">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');
      }
      // Substitute either way: the meta tags and the remaining CTAs carry
      // placeholders too, and a raw __DEMO_NUM__ leaking into a share preview
      // is worse than an empty one.
      page = withDemoTel(page);
      // ONE voice plan. There is no phone-only tier any more: the thing worth
      // buying is the whole front desk, and a cheaper half-product next to it
      // only made the real plan look expensive.
      // Quote what will actually be charged, not the intended number.
      const FD = plans.catalogue().find((t) => t.id === 'frontdesk') || plans.TIERS.frontdesk;
      const block = `<div class="tname" style="color:#9fe0b8">Front Desk</div><div class="camt">$${FD.price}<span>/mo</span></div><div class="cnote">Every call answered. Every job booked. ${FD.voiceMinutes.toLocaleString()} minutes a month — and between calls it goes and finds you new customers.</div>`;
      const cta = `<a class="btn red" href="/signup?tier=frontdesk" style="margin-top:16px;background:#2f7d4f;border-color:#2f7d4f">Try it free for 7 days →</a>`;
      const voiceFrom = '$' + FD.price;
      const allowance = `${FD.voiceMinutes.toLocaleString()} phone minutes + ${FD.leads} new customers found, every month`;
      // Tier cards are RENDERED from the plan list, never hand-written into the
      // page. Every previous price change left a stale card behind advertising
      // a plan that no longer existed; a template cannot drift.
      const CAT = plans.catalogue();
      const COMP = CAT.find((t) => t.id === 'complete') || plans.TIERS.complete;
      const cards = CAT.filter((t) => t.id !== 'complete' && t.id !== 'frontdesk').map((t) => {
        const allow = [t.voiceMinutes ? `${t.voiceMinutes.toLocaleString()} phone minutes` : '', t.leads ? `${t.leads.toLocaleString()} leads` : ''].filter(Boolean).join(' + ');
        const feats = (t.features || []).slice(0, 4).map((f) => `<li>${voice.esc(f)}</li>`).join('');
        return `<div class="tier${t.badge ? ' featured' : ''}">${t.badge ? `<div class="tbadge">${voice.esc(t.badge)}</div>` : ''}
          <div class="tname">${voice.esc(t.name)}</div>
          <div class="tamt">$${t.price.toLocaleString()}<span>/mo</span></div>
          <div class="tlead">${voice.esc(allow)} / month</div>
          <ul>${feats}</ul>
          <a class="btn" href="/signup?tier=${t.id}" style="display:block">Try it free for 7 days →</a>
        </div>`;
      }).join('');
      const cols = Math.max(1, Math.min(3, CAT.filter((t) => t.id !== 'complete' && t.id !== 'frontdesk').length));
      page = page
        .split('__TIER_CARDS__').join(cards ? `<div class="tiers4" style="grid-template-columns:repeat(${cols},1fr);max-width:${cols === 1 ? '420px' : '100%'};margin:0 auto">${cards}</div>` : '')
        .split('__COMPLETE_MINUTES__').join(COMP.voiceMinutes.toLocaleString())
        .split('__COMPLETE_LEADS__').join(COMP.leads.toLocaleString());
      page = page.split('__PHONE_TIER_BLOCK__').join(block).split('__PHONE_TIER_CTA__').join(cta).split('__VOICE_FROM__').join(voiceFrom).split('__ALLOWANCE_LINE__').join(allowance);
      return html(res, page.split('__FROM_PRICE__').join(plans.fromPrice()));
    }
    // Legal pages — public, and required before Stripe will approve billing.
    if (req.method === 'GET' && (p === '/terms' || p === '/privacy')) {
      const isTerms = p === '/terms';
      const body = isTerms ? LEGAL_TERMS : LEGAL_PRIVACY;
      return html(res, view('legal.html').replace('__TITLE__', isTerms ? 'Terms of Service' : 'Privacy Policy').replace('__BODY__', body));
    }

    if (req.method === 'GET' && p === '/signup') {
      const t = (url.searchParams.get('tier') || '').toLowerCase();
      // The ref may arrive on the URL or in the cookie set by /r/CODE. Render
      // it into a hidden field AND re-read the cookie on POST, so a stripped
      // field or a blocked cookie each still leave one working path.
      const qref = reps.normaliseCode(url.searchParams.get('ref') || '');
      const cref = reps.normaliseCode(auth.parseCookies(req)[REF_COOKIE] || '');
      const ref = (reps.repByCode(qref) ? qref : '') || (reps.repByCode(cref) ? cref : '');
      let page = view('signup.html').split('__TIER__').join(/^[a-z]+$/.test(t) ? t : '').split('__REF__').join(voice.esc(ref));
      const r = ref && reps.repByCode(ref);
      page = page.split('__REF_NOTE__').join(r ? `<div class="refnote">Referred by <b>${voice.esc(r.name)}</b></div>` : '');
      let cookie;
      if (qref && reps.repByCode(qref) && !cref) {
        const secure = (process.env.PUBLIC_URL || '').startsWith('https') ? ' Secure;' : '';
        cookie = `${REF_COOKIE}=${encodeURIComponent(qref)};${secure} SameSite=Lax; Path=/; Max-Age=${REF_COOKIE_DAYS * 24 * 3600}`;
      }
      return html(res, withDemoTel(page), 200, cookie ? { 'Set-Cookie': cookie } : {});
    }
    if (req.method === 'GET' && p === '/login') return html(res, view('login.html'));

    // ---- password reset ----
    if (req.method === 'GET' && p === '/forgot') {
      return html(res, view('forgot.html').replace('__MSGCLASS__', '').replace('<!--MSG-->', '').replace('<!--LINK-->', ''));
    }
    if (req.method === 'POST' && p === '/forgot') {
      if (rateLimited(req, 'forgot', 5, 15 * 60 * 1000)) {
        return html(res, view('forgot.html').replace('__MSGCLASS__', 'err').replace('<!--MSG-->', 'Too many attempts. Try again in 15 minutes.').replace('<!--LINK-->', ''), 429);
      }
      const f = parseForm(await readBody(req));
      const acc = db.getAccountByEmail((f.email || '').trim().toLowerCase());
      let note = '';
      if (acc) {
        const token = db.createResetToken(acc.id);
        const r = await mailer.sendPasswordReset(acc.email, token);
        // If no system mailbox is configured yet, surface the link so the owner
        // isn't locked out of their own product. Never do this in production.
        if (!r.ok && process.env.DEV_UNLOCK === '1') note = `${process.env.PUBLIC_URL || ''}/reset?token=${token}`;
      }
      // Always the same answer — never reveal whether an email is registered.
      return html(res, view('forgot.html')
        .replace('__MSGCLASS__', 'ok')
        .replace('<!--MSG-->', 'If that email has an account, a reset link is on its way.')
        .replace('<!--LINK-->', note ? `Mailbox not configured — use this link: ${note}` : ''));
    }
    if (req.method === 'GET' && p === '/reset') {
      const token = url.searchParams.get('token') || '';
      return html(res, view('reset.html').replace('__TOKEN__', token.replace(/"/g, '')).replace('<!--MSG-->', ''));
    }
    if (req.method === 'POST' && p === '/reset') {
      const f = parseForm(await readBody(req));
      const fail = (m) => html(res, view('reset.html').replace('__TOKEN__', (f.token || '').replace(/"/g, '')).replace('<!--MSG-->', m), 400);
      if ((f.password || '').length < 6) return fail('Password must be at least 6 characters.');
      if (f.password !== f.confirm) return fail('Those passwords do not match.');
      const accountId = db.useResetToken(f.token);
      if (!accountId) return fail('That reset link has expired or already been used. Request a new one.');
      const { salt, passHash } = auth.hashPassword(f.password);
      db.updateAccount(accountId, { salt, passHash });
      db.logActivity(accountId, { agent: 'SYSTEM', msg: 'Password reset' });
      const token = db.createSession(accountId);
      return redirect(res, '/app', auth.sessionCookie(token));
    }

    if (req.method === 'POST' && p === '/signup') {
      if (rateLimited(req, 'signup', 20, 60 * 60 * 1000)) {
        return html(res, withDemoTel(view('signup.html').replace('<!--ERR-->', 'Too many accounts created from here. Try again later.')), 429);
      }
      const f = parseForm(await readBody(req));
      const email = (f.email || '').trim().toLowerCase();
      const pw = f.password || '';
      if (!email || pw.length < 6) return html(res, withDemoTel(view('signup.html').replace('<!--ERR-->', 'Enter a valid email and a password of 6+ characters.')), 400);
      if (db.getAccountByEmail(email)) return html(res, withDemoTel(view('signup.html').replace('<!--ERR-->', 'That email already has an account. Try logging in.')), 400);
      const { salt, passHash } = auth.hashPassword(pw);
      // Terms nobody was shown are terms a court will not enforce (browsewrap
      // fails routinely). Require the click and record when and which version,
      // so the responsibility-shift language actually binds.
      if (!f.agree) return html(res, withDemoTel(view('signup.html').replace('<!--ERR-->', 'Please tick the box to agree to the Terms and Privacy Policy.')), 400);
      const acc = db.createAccount({ email, passHash, salt, acceptedTermsAt: db.nowISO(), termsVersion: LEGAL_UPDATED });
      seedStarterProfile(acc.id, email);
      db.logActivity(acc.id, { agent: 'SYSTEM', msg: 'Account created' });
      // Attribution happens HERE, once, permanently. Read the hidden field
      // first and fall back to the cookie, so losing either one still pays the
      // rep. Nothing about it is retried later: a paycheck that can change
      // after the fact is a paycheck nobody trusts.
      try {
        const ref = reps.normaliseCode(f.ref || '') || reps.normaliseCode(auth.parseCookies(req)[REF_COOKIE] || '');
        if (ref) reps.attribute(acc, ref, { source: 'signup' });
      } catch (e) { console.error('attribution failed:', e.message); }
      const token = db.createSession(acc.id);
      // Came from a pricing card? Skip the re-decision and go straight to the
      // plan they already chose. Every extra decision point loses buyers.
      const wantTier = String(f.tier || '').toLowerCase();
      if (/^[a-z]+$/.test(wantTier) && plans.TIERS[wantTier]) {
        return redirect(res, '/checkout?tier=' + wantTier, auth.sessionCookie(token));
      }
      return redirect(res, '/app', auth.sessionCookie(token));
    }
    if (req.method === 'POST' && p === '/login') {
      if (rateLimited(req, 'login', 10, 15 * 60 * 1000)) {
        return html(res, view('login.html').replace('<!--ERR-->', 'Too many login attempts. Wait 15 minutes and try again.'), 429);
      }
      const f = parseForm(await readBody(req));
      const acc = db.getAccountByEmail((f.email || '').trim().toLowerCase());
      if (!acc || !auth.verifyPassword(f.password || '', acc.salt, acc.passHash)) {
        return html(res, view('login.html').replace('<!--ERR-->', 'Wrong email or password.'), 401);
      }
      const token = db.createSession(acc.id);
      return redirect(res, '/app', auth.sessionCookie(token));
    }
    if (p === '/logout') {
      const signed = auth.parseCookies(req)['tz_session'];
      const token = signed && signed.split('.')[0];
      if (token) db.destroySession(token);
      return redirect(res, '/', auth.clearCookie());
    }

    // ---------- Stripe webhook (public, raw body) ----------
    if (req.method === 'POST' && p === '/webhook/stripe') {
      const raw = await readBody(req);
      const event = stripe.verifyWebhook(raw, req.headers['stripe-signature']);
      if (!event) return json(res, { error: 'bad signature' }, 400);
      stripe.applyEvent(event);
      return json(res, { received: true });
    }

    // ---------- Public API (API key, no session) ----------
    // For Zapier, Make, a spreadsheet script, or the customer's own developer.
    // Authenticated by `Authorization: Bearer dp_live_...`. Read-only for now:
    // bookings, calls, and a "who is this caller" lookup. Rate-limited per key.
    if (p.startsWith('/v1/')) {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const keyAcc = bearer && bearer.startsWith('dp_live_') ? db.allAccounts().find((a) => a.apiKey === bearer) : null;
      if (!keyAcc) return json(res, { error: 'Invalid or missing API key. Send it as: Authorization: Bearer dp_live_...' }, 401);
      if (rateLimited(req, 'apikey:' + keyAcc.id, 600, 60 * 60 * 1000)) return json(res, { error: 'Rate limit: 600 requests per hour per key.' }, 429);
      if (!stripe.hasAccess(keyAcc)) return json(res, { error: 'This account is not active.' }, 402);
      const since = url.searchParams.get('since') ? Date.parse(url.searchParams.get('since')) : 0;
      const lim = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      if (req.method === 'GET' && p === '/v1/bookings') {
        const rows = db.getAppointments(keyAcc.id).filter((a) => !since || Date.parse(a.createdAt) >= since).slice(-lim);
        return json(res, { data: rows, count: rows.length });
      }
      if (req.method === 'GET' && p === '/v1/calls') {
        const rows = db.getCalls(keyAcc.id, lim).filter((c) => !since || Date.parse(c.at) >= since).map(({ estCost, ...c }) => c);
        return json(res, { data: rows, count: rows.length });
      }
      if (req.method === 'GET' && p === '/v1/callers/lookup') {
        const num = url.searchParams.get('phone') || '';
        return json(res, { data: stats.callerHistory(keyAcc.id, num, suppress.phoneKey) });
      }
      if (req.method === 'GET' && p === '/v1/me') {
        return json(res, { data: { account: keyAcc.id, email: keyAcc.email, tier: keyAcc.tier || null, events: hooks.EVENTS } });
      }
      return json(res, { error: 'Unknown endpoint. Available: GET /v1/me, /v1/bookings, /v1/calls, /v1/callers/lookup?phone=' }, 404);
    }

    // ---------- auth-required below ----------
    if (!account) {
      if (p.startsWith('/api/')) return json(res, { error: 'not authenticated' }, 401);
      return redirect(res, '/login');
    }

    // start checkout
    // Existing subscribers manage/switch here instead of buying a second plan.
    if (req.method === 'GET' && p === '/billing') {
      if (!account) return redirect(res, '/login');
      if (!account.stripeCustomerId) return redirect(res, '/checkout?tier=starter');
      // Same rule as /checkout. Kept in one helper because these two routes
      // drifted apart once already: the portal fix landed on /checkout only,
      // leaving /billing dead-ending churned customers it could not sell to.
      if (!canManageBilling(account)) return redirect(res, '/checkout?tier=' + (account.tier || 'starter'));
      try { return redirect(res, await stripe.createPortal(account)); }
      catch (e) { return html(res, `<p style="font-family:system-ui;padding:40px">Couldn't open billing: ${e.message} <a href="/app">Back</a></p>`); }
    }

    if (req.method === 'GET' && p === '/checkout') {
      if (!stripe.configured()) return html(res, `<p style="font-family:system-ui;padding:40px">Billing isn't configured yet. Set STRIPE_* in .env, or use DEV_UNLOCK=1 for testing. <a href="/app">Back</a></p>`);
      const tier = url.searchParams.get('tier') || 'starter';
      // Anyone with a subscription worth managing goes to the portal; anyone
      // genuinely finished falls through to Checkout so they can buy again.
      if (account.stripeCustomerId && canManageBilling(account)) {
        try { return redirect(res, await stripe.createPortal(account)); }
        catch (e) {
          // Do NOT fall through to Checkout. A transient portal failure would
          // otherwise hand an existing customer a brand-new subscription
          // billing alongside the one they already have — the precise
          // double-charge this branch exists to prevent.
          db.logActivity(account.id, { agent: 'SYSTEM', msg: `Billing portal failed: ${e.message}` });
          return html(res, `<p style="font-family:system-ui;padding:40px;max-width:520px;line-height:1.5">We couldn't open your billing page just now, and we won't start a second subscription by mistake. Please try again in a minute — or email <a href="mailto:support@dawnpipe.com">support@dawnpipe.com</a> and we'll sort your card out by hand.<br><br><a href="/app">Back to the app</a></p>`, 503);
        }
      }
      const link = await stripe.createCheckout(account, tier);
      return redirect(res, link);
    }

    if (req.method === 'GET' && p === '/app') {
      let page = view('app.html');
      // Coming back from Checkout: confirm the payment with Stripe directly
      // rather than waiting on a webhook that may never arrive. Without this a
      // charged customer could sit locked out permanently with nothing in the
      // product able to fix it.
      const topupSession = url.searchParams.get('topup_session') || '';
      if (topupSession) { try { await stripe.reconcileTopup(account, topupSession); account = db.getAccount(account.id) || account; } catch (e) { console.error('topup reconcile failed:', e.message); } }
      const sessionId = url.searchParams.get('session_id') || '';
      // 'none' | 'ok' | 'pending' — the page must not congratulate someone on a
      // payment that did not actually switch their account on.
      let checkoutResult = 'none';
      if (sessionId) {
        if (stripe.isPaid(account)) checkoutResult = 'ok';
        else {
          try {
            if (await stripe.reconcileCheckout(account, sessionId)) {
              account = db.getAccount(account.id);
              checkoutResult = 'ok';
            } else checkoutResult = 'pending';
          } catch (e) {
            console.error('checkout reconcile failed:', e.message);
            checkoutResult = 'pending';
          }
        }
      }
      page = page.replace('__CHECKOUT__', checkoutResult);
      const locked = !stripe.hasAccess(account);
      page = page.replace('__EMAIL__', account.email).replace('__LOCKED__', locked ? 'true' : 'false').replace('__AIMODE__', aiMode());
      return html(res, page);
    }

    // ---------- API (needs access) ----------
    if (p.startsWith('/api/')) {
      // Read-only endpoints stay open so a locked user can still see their work
      // (and be sold to). Only actions that cost money are gated.
      // Setup is free — the paywall guards AI SPEND, not the door. A locked user
      // can build their whole profile (sunk effort converts); only finding
      // leads, drafting and sending cost money.
      const READ_ONLY = ['/api/state', '/api/prospect/status', '/api/send/status',
        // STOPPING a send is never paywalled. If a plan lapses mid-run the one
        // thing the user must still be able to do is halt their own mail.
        '/api/send/stop',
        // CANCELLING is never paywalled either. A customer in dunning or past
        // their cap who cannot reach the cancel button is a chargeback and a
        // scam claim; the door out must always open.
        '/api/billing/cancel', '/api/billing/resume',
        '/api/profile/save', '/api/profile/delete', '/api/pipeline',
        // Handing a rented number BACK must never be paywalled. It was, so a
        // cancelled customer had no way to release it and we kept paying the
        // monthly rental on a line nobody could switch off.
        '/api/voice/numbers/release'];
      // A locked account gets 2 free website-autofills so the in-person demo
      // ("watch it read YOUR site") works before any card.
      const freeAutofill = p === '/api/profile/autofill' && !stripe.hasAccess(account)
        && Number(account.autofillsUsed || 0) < 2;
      if (freeAutofill) db.updateAccount(account.id, { autofillsUsed: Number(account.autofillsUsed || 0) + 1 });
      if (!stripe.hasAccess(account) && !READ_ONLY.includes(p) && !freeAutofill) {
        const u = plans.usage(account, stripe.isOwner(account));
        return json(res, {
          error: u.isPro
            ? `You've used all ${u.limit} leads this month — your allowance resets next month.`
            : `Pick a plan to turn your sales team on — from ${plans.fromPrice()}/mo.`,
          locked: true, needUpgrade: !u.isPro,
        }, 402);
      }
      const acc = account.id;

      if (p === '/api/state' && req.method === 'GET') {
        return json(res, {
          email: account.email,
          locked: !stripe.hasAccess(account),
          isOwner: stripe.isOwner(account),
          outboundCalling: outboundGate(account).ok,
          outboundGate: outboundGate(account),
          usage: plans.usage(account, stripe.isOwner(account)),
          isPaid: stripe.isPaid(account),
          // So the UI can say "your card was declined" instead of "choose a
          // plan" — the second is both wrong and the thing that pushed them
          // into buying a duplicate subscription.
          dunning: stripe.DUNNING.includes(account.subStatus) ? { since: account.dunningSince || '', inGrace: stripe.inGrace(account) } : null,
          tiers: plans.catalogue().map(({ priceEnvKey, ...t }) => t),
          topups: plans.TOPUPS,
          cancelAt: account.cancelAt || '',
          trust: plans.TRUST,
          billingConfigured: stripe.configured(),
          aiMode: aiMode(),
          // masked: the app never ships the app-password back to the browser
          smtp: account.smtp ? { host: account.smtp.host, port: account.smtp.port, user: account.smtp.user,
            fromName: account.smtp.fromName, fromEmail: account.smtp.fromEmail, connected: !!account.smtp.pass } : { connected: false },
          // So a page refresh can re-attach to a run in progress — otherwise
          // reloading loses the only Stop button on screen while mail keeps going.
          activeSend: (() => { const j = sendJobs.get(activeSends.get(acc)); return j && j.status === 'running' ? sendJobView(j) : null; })(),
          sendDelaySec: account.sendDelaySec ?? 25,
          sendWindow: account.sendWindow || 'business',
          dailyCap: account.dailyCap ?? 50,
          sentToday: (account.sentToday && account.sentToday.date === db.today()) ? account.sentToday.count : 0,
          // key itself is never echoed back — connected flag only
          emailData: { connected: !!account.emailApiKey, fallback: !!process.env.HUNTER_API_KEY },
          warmup: sending.warmupStatus(account.warmup),
          voice: { ...(account.voice || {}), configured: voice.configured(), catalogue: voice.VOICES, defaultVoice: voice.DEFAULT_VOICE,
            envNumber: process.env.TWILIO_PHONE_NUMBER || '',
            webhookBase: (process.env.PUBLIC_URL || '').replace(/\/$/, '') },
          sendDomain: dnsauth.domainOfEmail((account.smtp || {}).fromEmail || (account.smtp || {}).user || ''),
          profiles: db.getProfiles(acc),
          leads: db.getLeads(acc),
          queue: db.getQueue(acc),
          activity: db.getActivity(acc, 40),
        });
      }
      // Onboarding: paste a website URL → AI drafts the whole profile.
      if (p === '/api/profile/autofill' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const fields = await agents.autofillFromWebsite(f.url);
        return json(res, { fields });
      }

      if (p === '/api/profile/delete' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (db.getProfiles(acc).length <= 1) return json(res, { error: 'You need at least one business.' }, 400);
        const ok = db.deleteProfile(acc, f.id);
        return json(res, { deleted: ok });
      }

      if (p === '/api/profile/save' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const fields = ['name', 'senderName', 'offer', 'icp', 'valueProp', 'proof', 'tone', 'cta', 'notes',
          'mailingAddress', 'website', 'pricing'];
        const data = {}; fields.forEach((k) => { if (f[k] !== undefined) data[k] = f[k]; });
        const saved = f.id ? db.updateProfile(acc, f.id, data) : db.createProfile(acc, data);
        return json(res, { profile: saved });
      }
      // Start a background prospecting job and return immediately — long runs
      // must never hold the HTTP request open.
      if (p === '/api/prospect/run' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        let count = Math.min(Math.max(Number(f.count) || 5, 1), 50);

        // Quota gate: this is where real AI spend happens, so it's metered.
        const u = plans.usage(account, stripe.isOwner(account));
        if (!u.unlimited) {
          if (u.remaining <= 0) {
            return json(res, {
              error: u.isPro
                ? `You've used all ${u.limit} leads this month. It resets next month.`
                : `Pick a plan to turn your sales team on — from ${plans.fromPrice()}/mo.`,
              needUpgrade: !u.isPro, quotaExhausted: true,
            }, 402);
          }
          count = Math.min(count, u.remaining); // never overspend the allowance
        }

        const job = startProspectJob(acc, f.profileId, { count, hints: f.hints || '', thenDraft: !!f.thenDraft });
        return json(res, { jobId: job.id, clampedTo: count, ...jobView(job) });
      }

      // Poll a running job for progress + ETA.
      if (p === '/api/prospect/status' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('jobId'));
        if (!job || job.accountId !== acc) return json(res, { error: 'job not found', gone: true }, 404);
        return json(res, jobView(job));
      }
      // ---- night shift schedule ----
      if (p === '/api/profile/schedule' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const prof = db.getProfile(acc, f.profileId);
        if (!prof) return json(res, { error: 'profile not found' }, 404);
        const schedule = {
          enabled: !!f.enabled,
          time: f.time || '02:00',
          count: Math.min(Math.max(Number(f.count) || 50, 1), 50),
          hints: f.hints || '',
          tzOffset: Number(f.tzOffset) || 0,
          lastRunDate: (prof.schedule && prof.schedule.lastRunDate) || null,
        };
        db.updateProfile(acc, f.profileId, { schedule });
        db.logActivity(acc, { agent: 'NIGHT SHIFT', profileId: f.profileId,
          msg: schedule.enabled ? `Scheduled: ${schedule.count} leads nightly at ${schedule.time}` : 'Nightly run turned off' });
        return json(res, { schedule });
      }

      // ---- email data key (Hunter.io) — bring-your-own-key per account ----
      if (p === '/api/settings/emailkey' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const key = (f.key || '').trim();
        if (!key) { db.updateAccount(acc, { emailApiKey: '' }); return json(res, { ok: true, connected: false }); }
        const t = await emailApi.testKey(key);
        if (!t.ok) return json(res, { error: `That key didn't work: ${t.error}` }, 400);
        db.updateAccount(acc, { emailApiKey: key });
        return json(res, { ok: true, connected: true });
      }

      // ---- appointments (the diary the AI books into) ----
      if (p === '/api/appointments' && req.method === 'GET') {
        return json(res, { appointments: db.getAppointments(acc) });
      }
      if (p === '/api/appointments/update' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const patch = {};
        if (f.status) patch.status = f.status;
        if (f.startsAt !== undefined) patch.startsAt = f.startsAt;
        if (f.notes !== undefined) patch.notes = f.notes;
        const a = db.updateAppointment(acc, f.id, patch);
        return json(res, { ok: !!a, appointment: a });
      }

      // Download one appointment as a calendar file — opens straight into
      // Outlook, Google Calendar, or Apple Calendar. Integration without OAuth.
      if (p === '/api/appointments/ics' && req.method === 'GET') {
        const appt = db.getAppointments(acc).find((x) => x.id === url.searchParams.get('id'));
        if (!appt || !appt.startsAt) return json(res, { error: 'No appointment (or no time set).' }, 404);
        const ics = notify.buildICS({
          title: `${appt.name || 'Caller'}${appt.company ? ` (${appt.company})` : ''} — ${appt.reason || 'callback'}`,
          description: `Booked by your Dawnpipe AI.\nPhone: ${appt.phone || '-'}\n${appt.email ? 'Email: ' + appt.email + '\n' : ''}Their words: ${appt.whenText || '-'}`,
          startsAt: appt.startsAt, minutes: 30, organiserEmail: account.email, uid: appt.id,
        });
        if (!ics) return json(res, { error: 'Could not build the invite.' }, 400);
        res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': `attachment; filename="dawnpipe-${appt.id}.ics"` });
        return res.end(ics);
      }

      // ---- voice settings + calls ----
      if (p === '/api/voice/save' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const cur = account.voice || {};
        const v = {
          ...cur,
          enabled: f.enabled !== false,
          record: f.record !== undefined ? !!f.record : (cur.record !== undefined ? cur.record : true),
          language: ['en-US', 'es-US'].includes(f.language ?? cur.language) ? (f.language ?? cur.language) : 'en-US',
          // Play-along mode for a line whose callers are prospects testing it.
          // Defaults ON for the owner's line — that IS the demo number on the
          // website and in the sales script — and off for real customers,
          // whose callers are genuinely customers.
          demoMode: (f.demoMode !== undefined) ? !!f.demoMode
            : (cur.demoMode !== undefined ? cur.demoMode : stripe.isOwner(account)),
          // The number is NOT client-settable. It used to default to the shared
          // TWILIO_PHONE_NUMBER, so every account that opened this tab stamped
          // the same number on itself and inbound calls became a race over who
          // signed up first. It is now only ever written by provisioning.
          number: (cur.number || '').trim(),
          numberSid: cur.numberSid || '',
          profileId: f.profileId || cur.profileId || '',
          agentName: (f.agentName ?? cur.agentName ?? 'Sarah').trim(),
          greeting: (f.greeting ?? cur.greeting ?? '').trim(),
          transferTo: voice.toE164((f.transferTo ?? cur.transferTo ?? '')),
          // Ordered on-call list for waterfall transfer. Accepts a newline/comma
          // separated string from the form; kept as E.164, junk dropped, max 5.
          onCall: (() => {
            const raw = f.onCall !== undefined ? f.onCall : cur.onCall;
            const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,;]+/);
            return list.map((n) => voice.toE164(String(n || '').trim())).filter(Boolean).slice(0, 5);
          })(),
          voicemail: (f.voicemail ?? cur.voicemail ?? '').trim(),
          faq: (f.faq ?? cur.faq ?? '').trim(),
          ttsVoice: (f.ttsVoice ?? cur.ttsVoice ?? voice.DEFAULT_VOICE),
          objective: (f.objective ?? cur.objective ?? '').trim(),
          qualifying: (f.qualifying ?? cur.qualifying ?? '').trim(),
          objections: (f.objections ?? cur.objections ?? '').trim(),
          hours: (f.hours ?? cur.hours ?? '').trim(),
          // How long a booking blocks the diary. Drives both the "already
          // booked" context the agent sees and the hard conflict check.
          slotMinutes: (() => { const n = Number(f.slotMinutes ?? cur.slotMinutes); return n >= 15 && n <= 480 ? Math.round(n) : 60; })(),
          // Only accept a zone Intl actually knows, or the date math silently
          // falls back and every booking lands on the wrong day.
          timezone: (() => { const z = String(f.timezone ?? cur.timezone ?? '').trim();
            try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return cur.timezone || ''; } })(),
        };
        db.updateAccount(acc, { voice: v });
        return json(res, { ok: true, voice: v });
      }
      // What the AI actually did: this month, last month, last 7 days. Feeds the
      // dashboard; the same numbers go out in the monthly recap email.
      if (p === '/api/voice/stats' && req.method === 'GET') {
        return json(res, stats.summary(account, voice.tzFor(account)));
      }
      // Stream a recording to the owner's browser. Proxied with our Twilio
      // credentials so recordings are never public URLs, and scoped to the
      // account so nobody can play back another business's calls.
      if (p === '/api/voice/recording' && req.method === 'GET') {
        const wantSid = url.searchParams.get('sid') || '';
        const call = db.getCalls(acc, 3000).find((c) => c.sid === wantSid);
        if (!call || !call.recordingSid) return json(res, { error: 'No recording for that call.' }, 404);
        const asid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
        try {
          const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${asid}/Recordings/${encodeURIComponent(call.recordingSid)}.mp3`, {
            headers: { Authorization: 'Basic ' + Buffer.from(`${asid}:${tok}`).toString('base64') }, signal: AbortSignal.timeout(20000) });
          if (!r.ok) return json(res, { error: `Recording not available (${r.status}).` }, 502);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
          const buf = Buffer.from(await r.arrayBuffer());
          return res.end(buf);
        } catch (e) { return json(res, { error: e.message }, 502); }
      }
      if (p === '/api/voice/calls' && req.method === 'GET') {
        // A call can be orphaned mid-flight -- a deploy restarts the process,
        // the in-memory call map empties, and the status callback finds
        // nothing to complete -- leaving a row frozen at "in-progress"
        // forever. Twilio ended the real call long ago; only our label is
        // stuck. Sweep anything still "live" after 2 hours.
        const LIVE = ['queued', 'ringing', 'initiated', 'in-progress'];
        for (const c of db.getCalls(acc, 50)) {
          if (LIVE.includes(String(c.status || '')) && c.at && Date.now() - Date.parse(c.at) > 2 * 3600000) {
            db.saveCall(acc, { sid: c.sid, status: 'completed', outcome: c.outcome || 'ended (state lost in a restart)' });
          }
        }
        const rows = db.getCalls(acc, 50);
        // estCost is OUR cost of goods, not the customer's. Someone paying
        // $399 who can see a call cost us 62 cents will price the product for
        // themselves, and badly. Stripped server-side rather than hidden in
        // the UI, because "hidden" is one devtools tab away from visible.
        if (!stripe.isOwner(account)) {
          return json(res, { calls: rows.map(({ estCost, ...rest }) => rest) });
        }
        return json(res, { calls: rows });
      }
      // Place a real outbound call. Costs money, so it is metered and explicit.
      if (p === '/api/voice/testcall' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!voice.configured()) return json(res, { error: 'Twilio keys are not set in the server environment yet.' }, 400);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        if (!base.startsWith('https')) return json(res, { error: 'Set PUBLIC_URL to your https URL in Render first — Twilio must be able to reach this server.' }, 400);
        const vcfg = account.voice || {};
        // Only the owner account may fall back to the shared server number.
        // For a customer, dialling out from a line they do not own means any
        // callback rings a different company — so they use their own or none.
        const from = vcfg.number || (stripe.isOwner(account) ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
        const to = (f.to || '').trim();
        if (!to) return json(res, { error: 'Enter the number to call (E.164 format, e.g. +13125550123).' }, 400);
        // Plan BEFORE number. A tier without phone calls can never have a
        // number, so checking the number first told them to "get your phone
        // number" — sending them to buy a line their plan cannot use, instead
        // of saying their plan doesn't include calling.
        const allowed = plans.voiceAllowed(account, stripe.isOwner(account));
        if (!allowed.ok) return json(res, { error: allowed.reason, needUpgrade: true }, 402);
        if (!from) return json(res, { error: 'Get your phone number first — Voice SDR tab, "Get my number".', needNumber: true }, 400);
        const profile = db.getProfile(acc, vcfg.profileId) || db.getProfiles(acc)[0];
        if (!profile) return json(res, { error: 'Create a business profile first.' }, 400);
        // DO NOT CALL is absolute and legally binding. Checked at the dial
        // boundary so no route can place a call to someone who opted out.
        const dnc = suppress.isPhoneSuppressed(acc, to);
        if (dnc.blocked) return json(res, { error: `That number asked not to be contacted (${dnc.note || dnc.reason}). Calling it anyway is a legal risk.` }, 403);
        try {
          const call = await voice.placeCall({ to, from,
            answerUrl: base + '/voice/answer', statusUrl: base + '/voice/status' });
          voice.startCall(call.sid, { accountId: acc, account, profile, direction: 'outbound', to, from,
            lead: f.leadName ? { name: f.leadName, company: f.leadCompany || '' } : null });
          db.saveCall(acc, { sid: call.sid, direction: 'outbound', to, from, profileId: profile.id,
            status: call.status || 'queued', transcript: [] });
          db.logActivity(acc, { agent: 'VOICE', msg: 'Outbound call placed to ' + to });
          return json(res, { ok: true, sid: call.sid, status: call.status });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      // ---- PHONE NUMBER PROVISIONING: one line per customer ----
      // Numbers are rented on OUR Twilio account, so buying is gated on a plan
      // that actually includes voice — otherwise a $49 account could rent a
      // number every month at our expense.
      if (p === '/api/voice/numbers/search' && req.method === 'GET') {
        if (!voice.configured()) return json(res, { error: 'Twilio is not configured on the server yet.' }, 400);
        const vAllow = plans.voiceAllowed(account, stripe.isOwner(account));
        if (!vAllow.ok) return json(res, { error: vAllow.reason, needUpgrade: true }, 402);
        try {
          return json(res, { numbers: await numbers.search({ areaCode: url.searchParams.get('areaCode') || '' }) });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/voice/numbers/buy' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!voice.configured()) return json(res, { error: 'Twilio is not configured on the server yet.' }, 400);
        const vAllow = plans.voiceAllowed(account, stripe.isOwner(account));
        if (!vAllow.ok) return json(res, { error: vAllow.reason, needUpgrade: true }, 402);
        const vcfg = account.voice || {};
        // Renting a second number for an account that already has one is money
        // burnt every month for a line nobody answers.
        if (vcfg.numberSid) return json(res, { error: 'This business already has a number. Release it first if you want a different one.' }, 400);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        try {
          const got = await numbers.buy({ phoneNumber: f.phoneNumber, base,
            friendlyName: `Dawnpipe — ${account.email}` });
          // Claimed by another account = a double-buy race. Hand it straight
          // back rather than leave two accounts fighting over one line.
          const clash = db.accountByVoiceNumber(got.phoneNumber);
          if (clash && clash.id !== acc) {
            await numbers.release(got.sid).catch(() => {});
            return json(res, { error: 'That number was just taken. Try another.' }, 409);
          }
          db.updateAccount(acc, { voice: { ...vcfg, number: got.phoneNumber, numberSid: got.sid, enabled: true } });
          db.logActivity(acc, { agent: 'VOICE', msg: `Phone number ${got.phoneNumber} provisioned and pointed at Dawnpipe` });
          return json(res, { ok: true, number: got.phoneNumber });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/voice/numbers/release' && req.method === 'POST') {
        const vcfg = account.voice || {};
        if (!vcfg.numberSid) return json(res, { error: 'No number to release.' }, 400);
        try {
          await numbers.release(vcfg.numberSid);
          db.updateAccount(acc, { voice: { ...vcfg, number: '', numberSid: '', enabled: false } });
          db.logActivity(acc, { agent: 'VOICE', msg: `Phone number ${vcfg.number} released` });
          return json(res, { ok: true });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }

      // ---- backfill phone numbers for leads that predate phone capture ----
      if (p === '/api/voice/findphones' && req.method === 'POST') {
        // === COMPLIANCE GATE: outbound AI calling is OFF unless explicitly enabled ===
        // Under the FCC's Feb 2024 ruling an AI voice is an "artificial voice"
        // under the TCPA. Calling a cell phone with one requires prior express
        // consent — written consent if it is marketing — and owner-operators
        // answer on cells. Statutory damages are $500 per call, $1,500 if
        // wilful, strict liability, and Dawnpipe owns the Twilio account, writes
        // the words and runs the dial loop, so it is named as the initiator.
        // One suit could also get the Twilio account suspended, taking every
        // customer's inbound receptionist line down with it. The receptionist
        // is the product; this feature is not worth that. Flip OUTBOUND_CALLING=on
        // in the Render dashboard only once a consent model is in place.
        {
          const gate = outboundGate(account);
          if (!gate.ok) return json(res, { error: gate.reason, paused: gate.paused, needUpgrade: gate.needUpgrade }, gate.needUpgrade ? 402 : 403);
        }
        const f = parseJSON(await readBody(req));
        if (!stripe.canSpend(account)) return json(res, { error: 'Your plan is out of room this month.', needUpgrade: true }, 402);
        const profileId = f.profileId || '';
        if (phoneJobs.get(acc) && phoneJobs.get(acc).status === 'running') {
          return json(res, { error: 'Already looking up numbers — give it a minute.' }, 409);
        }
        const job = { status: 'running', done: 0, total: 0, found: 0 };
        phoneJobs.set(acc, job);
        (async () => {
          const r = await agents.findPhones(acc, profileId, { limit: Number(f.limit) || 25,
            onProgress: ({ done, total, found }) => { job.done = done; job.total = total; job.found = found; } });
          job.status = 'done';
          job.note = r.found
            ? `Found ${r.found} number(s) out of ${r.checked} checked.`
            : `Checked ${r.checked} — no published numbers found. Some businesses simply don't list one.`;
        })().catch((e) => { job.status = 'error'; job.note = e.message; });
        return json(res, { ok: true });
      }
      if (p === '/api/voice/findphones/status' && req.method === 'GET') {
        return json(res, phoneJobs.get(acc) || { status: 'idle' });
      }

      // ---- COLD CALL RUN: work the list, one call at a time ----
      // The email side has had a "find and send" button since day one; the phone
      // side only ever had a single manual test call, so the outbound voice agent
      // was effectively unusable on a real list.
      if (p === '/api/voice/callrun' && req.method === 'POST') {
        // === COMPLIANCE GATE: outbound AI calling is OFF unless explicitly enabled ===
        // Under the FCC's Feb 2024 ruling an AI voice is an "artificial voice"
        // under the TCPA. Calling a cell phone with one requires prior express
        // consent — written consent if it is marketing — and owner-operators
        // answer on cells. Statutory damages are $500 per call, $1,500 if
        // wilful, strict liability, and Dawnpipe owns the Twilio account, writes
        // the words and runs the dial loop, so it is named as the initiator.
        // One suit could also get the Twilio account suspended, taking every
        // customer's inbound receptionist line down with it. The receptionist
        // is the product; this feature is not worth that. Flip OUTBOUND_CALLING=on
        // in the Render dashboard only once a consent model is in place.
        {
          const gate = outboundGate(account);
          if (!gate.ok) return json(res, { error: gate.reason, paused: gate.paused, needUpgrade: gate.needUpgrade }, gate.needUpgrade ? 402 : 403);
        }
        const f = parseJSON(await readBody(req));
        if (!voice.configured()) return json(res, { error: 'Twilio keys are not set in the server environment yet.' }, 400);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        if (!base.startsWith('https')) return json(res, { error: 'Set PUBLIC_URL to your https URL in Render first — Twilio must be able to reach this server.' }, 400);
        const vcfg = account.voice || {};
        // Only the owner account may fall back to the shared server number.
        // For a customer, dialling out from a line they do not own means any
        // callback rings a different company — so they use their own or none.
        const from = vcfg.number || (stripe.isOwner(account) ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
        if (!from) return json(res, { error: 'Get your phone number first — Voice SDR tab, "Get my number".', needNumber: true }, 400);
        const profileId = f.profileId || vcfg.profileId || '';
        const profile = db.getProfile(acc, profileId) || db.getProfiles(acc)[0];
        if (!profile) return json(res, { error: 'Create a business profile first.' }, 400);
        const allowed = plans.voiceAllowed(account, stripe.isOwner(account));
        if (!allowed.ok) return json(res, { error: allowed.reason, needUpgrade: true }, 402);
        if (callJobs.get(acc) && callJobs.get(acc).status === 'running') {
          return json(res, { error: 'A calling run is already going. Let it finish first.' }, 409);
        }

        // Who is actually callable: a real number, never called before, and not
        // on the do-not-call list. Silent skips would look like the feature is
        // broken, so every exclusion is counted and reported back.
        const all = db.getLeads(acc, profile.id);
        let noPhone = 0, alreadyCalled = 0, onDnc = 0;
        const queue = [];
        // One opt-out covers both channels. The site promises "anyone who opts
        // out is never contacted again — by email or phone", so an unsubscribe
        // or a "do not contact" stage has to block the dialler too, not just
        // the mailer. Also dedupe by number: two contacts at one company share
        // a switchboard, and calling it twice in a run is the complaint.
        const seenNums = new Set();
        for (const l of all) {
          const to = voice.toE164(l.phone || '');
          if (!to) { noPhone++; continue; }
          if (l.calledAt) { alreadyCalled++; continue; }
          if (l.stage === 'dnc'
              || suppress.isPhoneSuppressed(acc, to).blocked
              || (l.email && suppress.isSuppressed(acc, l.email).blocked)) { onDnc++; continue; }
          const key = suppress.phoneKey(to);
          if (seenNums.has(key)) { alreadyCalled++; continue; }
          seenNums.add(key);
          queue.push({ lead: l, to });
        }
        const want = Math.max(1, Math.min(Number(f.count) || 10, 25));
        const batch = queue.slice(0, want);
        if (!batch.length) {
          return json(res, { ok: true, started: 0,
            note: all.length
              ? `Nothing to call: ${noPhone} without a phone number, ${alreadyCalled} already called, ${onDnc} on the do-not-call list.`
              : 'No leads yet — find some on the Sales Desk first.' });
        }

        const job = { accountId: acc, status: 'running', total: batch.length, done: 0,
          connected: 0, failed: 0, startedAt: Date.now(), note: '', skipped: { noPhone, alreadyCalled, onDnc } };
        callJobs.set(acc, job);

        (async () => {
          for (const item of batch) {
            // Re-check the plan every iteration: a long run can exhaust the
            // month's minutes partway, and quietly dialling past that would
            // bill the owner for minutes they have not bought.
            const fresh = db.getAccount(acc);
            const ok = plans.voiceAllowed(fresh, stripe.isOwner(fresh));
            if (!ok.ok) { job.note = `Stopped early — ${ok.reason}`; break; }
            // Opt-outs land DURING a run: someone earlier in the batch says
            // "take us off your list", the AI records it, and the queue built
            // 20 seconds ago still has that number in it. Re-check at the dial
            // boundary, which is the only place that can be authoritative.
            if (suppress.isPhoneSuppressed(acc, item.to).blocked) {
              job.skipped.onDnc++;
              db.logActivity(acc, { agent: 'VOICE', msg: `Skipped ${item.lead.company || item.to} - asked not to be contacted` });
              job.done++;
              continue;
            }
            try {
              const call = await voice.placeCall({ to: item.to, from,
                answerUrl: base + '/voice/answer', statusUrl: base + '/voice/status' });
              voice.startCall(call.sid, { accountId: acc, account: fresh, profile, direction: 'outbound',
                to: item.to, from, lead: { name: item.lead.name, company: item.lead.company, email: item.lead.email } });
              db.saveCall(acc, { sid: call.sid, direction: 'outbound', to: item.to, from, profileId: profile.id,
                status: call.status || 'queued', transcript: [] });
              db.updateLead(acc, item.lead.id, { calledAt: new Date().toISOString(), callSid: call.sid });
              job.connected++;
              db.logActivity(acc, { agent: 'VOICE', profileId: profile.id,
                msg: `Cold call placed to ${item.lead.company || item.to}` });
            } catch (e) {
              job.failed++;
              // Mark it tried so a permanently bad number cannot jam every
              // future run at the front of the queue.
              db.updateLead(acc, item.lead.id, { calledAt: new Date().toISOString(), callError: e.message });
              db.logActivity(acc, { agent: 'VOICE', profileId: profile.id,
                msg: `Cold call to ${item.lead.company || item.to} failed: ${e.message}` });
            }
            job.done++;
            // Space the calls out. Firing a whole list at once is both a carrier
            // spam signal and unanswerable — the AI can only hold one at a time.
            if (job.done < batch.length) await new Promise((r) => setTimeout(r, 20000));
          }
          job.status = 'done';
          if (!job.note) job.note = `Called ${job.connected}${job.failed ? `, ${job.failed} failed` : ''}.`;
        })().catch((e) => { job.status = 'error'; job.note = e.message; });

        return json(res, { ok: true, started: batch.length, waiting: queue.length - batch.length,
          skipped: { noPhone, alreadyCalled, onDnc } });
      }
      if (p === '/api/voice/callrun/status' && req.method === 'GET') {
        return json(res, callJobs.get(acc) || { status: 'idle' });
      }

      // ---- quota reconciliation after the double-billing bug (owner only) ----
      // Until server.js:215 was fixed, prospected leads were charged twice: once
      // as they landed and again when OUTBOUND drafted them, because a typo meant
      // no lead was ever stamped `metered`. Everyone silently got half the leads
      // they paid for, and their counters are still inflated.
      //
      // The truth is recountable: one charge per lead created in the current
      // billing period. DRY RUN BY DEFAULT — it reports what it would change and
      // touches nothing unless explicitly told to apply.
      if (p === '/api/admin/reconcile-usage' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        const apply = f.apply === true;
        const period = plans.periodKey();
        const rows = [];
        for (const a of db.allAccounts()) {
          if (stripe.isOwner(a)) continue;
          const counted = Number(a.leadsUsed || 0);
          if (!counted) continue;
          // Only this period's counter is meaningful; a stale one resets anyway.
          if (a.usagePeriod !== period) continue;
          const leads = db.getLeads(a.id) || [];
          const truth = leads.filter((l) => String(l.createdAt || '').slice(0, 7) === period).length;
          if (truth >= counted) continue;                 // nothing to give back
          rows.push({ accountId: a.id, email: a.email, was: counted, shouldBe: truth, refund: counted - truth });
          if (apply) {
            db.updateAccount(a.id, { leadsUsed: truth, usagePeriod: period });
            db.logActivity(a.id, { agent: 'SYSTEM', msg: `Lead quota corrected after double-billing bug: ${counted} -> ${truth}` });
          }
        }
        return json(res, {
          ok: true, applied: apply, period,
          accounts: rows.length,
          leadsReturned: rows.reduce((n, r) => n + r.refund, 0),
          detail: rows,
          note: apply ? 'Counters corrected.' : 'DRY RUN — nothing changed. POST {"apply":true} to write these.',
        });
      }

      // ---- integrations: webhooks + API key ----
      // Read: the URLs, the events, and (once) the secret + API key.
      if (p === '/api/integrations' && req.method === 'GET') {
        const acc2 = hooks.ensureSecrets(account);
        return json(res, { webhookUrls: acc2.webhookUrls || [], webhookSecret: acc2.webhookSecret, apiKey: acc2.apiKey, events: hooks.EVENTS });
      }
      // Write: up to 5 https URLs.
      if (p === '/api/integrations' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const urls = String(f.webhookUrls || '').split(/[\s,]+/).map((u) => u.trim()).filter((u) => /^https:\/\/[^\s]+$/.test(u)).slice(0, 5);
        db.updateAccount(acc, { webhookUrls: urls });
        db.logActivity(acc, { agent: 'SYSTEM', msg: `Webhook URLs updated (${urls.length})` });
        return json(res, { ok: true, webhookUrls: urls });
      }
      // Rotate the secret / key if one leaks.
      if (p === '/api/integrations/rotate' && req.method === 'POST') {
        db.updateAccount(acc, { webhookSecret: '', apiKey: '' });
        const acc2 = hooks.ensureSecrets(db.getAccount(acc));
        return json(res, { ok: true, webhookSecret: acc2.webhookSecret, apiKey: acc2.apiKey });
      }
      // Send a test event so the owner can confirm their receiver works.
      if (p === '/api/integrations/test' && req.method === 'POST') {
        hooks.emit(account, 'booking.created', { test: true, appointment: { name: 'Test Caller', phone: '+15555550123', reason: 'webhook test', startsAt: new Date(Date.now() + 86400000).toISOString() } });
        return json(res, { ok: true, note: 'Sent a test booking.created to your URLs. Check your receiver — and the activity log here for any delivery errors.' });
      }

      // ---- REAL Twilio spend, from Twilio's ledger (owner only) ----
      // ?days=30 (default) or ?start=YYYY-MM-DD&end=YYYY-MM-DD. Answers "what
      // is this actually costing us per minute" from billed usage, not from
      // the estimate's constants.
      if (p === '/api/admin/spend' && req.method === 'GET') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const days = Math.min(Number(url.searchParams.get('days')) || 30, 92);
        const end = url.searchParams.get('end') || new Date().toISOString().slice(0, 10);
        const start = url.searchParams.get('start') || new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        try {
          const rows = await spend.usageRecords({ start, end });
          const sum = spend.summarise(rows);
          const diag = spend.diagnose(rows, sum);
          // Compare against what we THINK it costs, so the gap is visible.
          const est = { note: 'estimateCost() assumes: phone $0.014/min, speech recognition $0.02 per turn, TTS $0.013/100 chars generative or $0.0032 neural, AI $0.006/turn, recording $0.0025/min. Twilio\'s advertised per-minute rate is the phone line only; speech-to-text and text-to-speech are ~80% of a real call.' };
          return json(res, { start, end, ...sum, diagnostics: diag, estimateAssumptions: est, rawCategories: rows.filter((r) => r.price).map((r) => ({ category: r.category, usage: r.usage, unit: r.usageUnit, price: r.price })).sort((a, b) => b.price - a.price) });
        } catch (e) { return json(res, { error: e.message }, 502); }
      }

      // ---- CALL-BACKS (the customer's view) ----
      if (p === '/api/callbacks' && req.method === 'GET') {
        const slug = callback.ensureFormSlug(account);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        const rows = db.getCallbacks(acc, 100).map((c) => ({ id: c.id, at: c.at, source: c.source, name: c.name, phone: c.phone, need: c.need,
          status: c.status, note: c.note || '', dueAt: c.dueAt || '', calledAt: c.calledAt || '', basis: c.basis || '', consentAt: c.consentAt || '' }));
        const vc = account.voice || {};
        return json(res, { formUrl: `${base}/f/${slug}`, embed: `<iframe src="${base}/f/${slug}" style="width:100%;max-width:480px;height:640px;border:0" title="Request a call"></iframe>`,
          callBackMissed: vc.callBackMissed === true, hours: { from: callback.EARLIEST_HOUR, to: callback.LATEST_HOUR }, tz: voice.tzFor(account),
          voiceOk: plans.voiceAllowed(account, stripe.isOwner(account)), hasNumber: !!(vc.number || (stripe.isOwner(account) && process.env.TWILIO_PHONE_NUMBER)),
          rows });
      }
      if (p === '/api/callbacks/settings' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const vc = account.voice || {};
        db.updateAccount(acc, { voice: { ...vc, callBackMissed: !!f.callBackMissed } });
        db.logActivity(acc, { agent: 'VOICE', msg: `Missed-call call-back offer ${f.callBackMissed ? 'ON' : 'off'}` });
        return json(res, { ok: true });
      }
      // The owner rings back a caller who LEFT their number, about their own
      // enquiry. Creates the record with what we rely on and dials now.
      if (p === '/api/callbacks/call' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        let rec = null;
        if (f.id) rec = db.getCallbacks(acc, 500).find((c) => c.id === f.id) || null;
        if (!rec && f.phone) {
          const e164 = voice.toE164(f.phone);
          if (!e164) return json(res, { error: 'That is not a valid phone number.' }, 400);
          rec = db.addCallback(acc, { source: 'owner', name: String(f.name || '').slice(0, 80), phone: e164, phoneKey: suppress.phoneKey(e164), need: String(f.need || '').slice(0, 400),
            consent: true, consentAt: f.leftAt || db.nowISO(), consentText: String(f.basis || 'Left their number with the business and asked to be contacted').slice(0, 300), consentVia: 'owner' });
        }
        if (!rec) return json(res, { error: 'Nothing to call.' }, 400);
        const r = await placeCallback(rec, { by: 'owner' });
        if (!r.ok) return json(res, { error: r.reason, queued: !!r.queued, dueAt: r.dueAt || '' }, r.queued ? 202 : 400);
        return json(res, { ok: true, sid: r.sid });
      }

      // ---- SALES REPS (owner only) ----
      // The paycheck tracker. Every figure here is a sum of ledger rows, and
      // every ledger row carries the Stripe id it came from, so any number on
      // this screen can be traced to an object in the Stripe dashboard.
      if (p === '/api/admin/reps' && req.method === 'GET') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        const all = db.allAccounts();
        const rows = reps.listReps().map((r) => {
          const sum = reps.summary(r.id);
          const mine = all.filter((a) => a.repId === r.id);
          return { ...r, link: `${base}/r/${r.code}`, ...sum,
            blocked: reps.payoutBlocked(r),
            accountsList: mine.map((a) => ({ id: a.id, email: a.email, tier: a.tier, subStatus: a.subStatus,
              selfReferral: !!a.repSelfReferral,
              earned: reps.ledgerForAccount(a.id).filter((x) => x.kind !== 'reversal').reduce((n, x) => n + x.amountCents, 0) })),
          };
        });
        return json(res, { reps: rows, rateIntroPct: reps.RATE_INTRO_BPS / 100, rateTailPct: reps.RATE_TAIL_BPS / 100,
          introMonths: reps.INTRO_MONTHS, bonusCents: reps.ACTIVATION_BONUS_CENTS, holdDays: reps.BONUS_HOLD_DAYS });
      }
      if (p === '/api/admin/reps/create' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        try { const r = reps.createRep({ name: f.name, email: f.email, phone: f.phone, notes: f.notes });
          db.logActivity(acc, { agent: 'SYSTEM', msg: `Sales rep added: ${r.name} (${r.code})` });
          return json(res, { ok: true, rep: r });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/admin/reps/update' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        const patch = {};
        // Onboarding gates are dates, not booleans: "when did they sign" is the
        // question that matters if a commission is ever disputed.
        if (f.status) patch.status = f.status;
        if (f.agreementSigned !== undefined) patch.agreementSignedAt = f.agreementSigned ? db.nowISO() : '';
        if (f.w9Received !== undefined) patch.w9ReceivedAt = f.w9Received ? db.nowISO() : '';
        if (f.payoutMethod !== undefined) patch.payoutMethod = String(f.payoutMethod || '');
        // Per-rep commission rate, as a percentage. Bounded hard: below 5% is
        // a typo, above 70% is a mistake you would not survive.
        if (f.ratePct !== undefined) {
          const v = Number(f.ratePct);
          if (!(v >= 5 && v <= 70)) return json(res, { error: 'Rate must be between 5 and 70 percent.' }, 400);
          patch.rateBps = Math.round(v * 100);
        }
        if (f.notes !== undefined) patch.notes = String(f.notes || '');
        const r = reps.updateRep(f.id, patch);
        if (!r) return json(res, { error: 'No such rep.' }, 404);
        return json(res, { ok: true, rep: r });
      }
      // Assign a customer to a rep by hand (the phone-close case), then
      // back-pay any invoices Stripe already collected for that customer.
      if (p === '/api/admin/reps/assign' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        const target = f.accountId ? db.getAccount(f.accountId) : db.getAccountByEmail(String(f.email || '').trim().toLowerCase());
        if (!target) return json(res, { error: 'No customer with that email.' }, 404);
        const r = reps.assign(target, f.repId, { by: account.email, reason: f.reason, force: !!f.force });
        if (!r.ok) return json(res, { error: r.reason }, 400);
        let backfill = { posted: 0, invoices: 0 };
        try { backfill = await stripe.backfillCommissions(db.getAccount(target.id)); }
        catch (e) { backfill = { posted: 0, invoices: 0, error: e.message }; }
        if (backfill.posted) db.logActivity(target.id, { agent: 'SYSTEM', msg: `Back-paid ${r.rep.code} for ${backfill.posted} invoice(s) already collected` });
        return json(res, { ok: true, rep: { id: r.rep.id, name: r.rep.name, code: r.rep.code }, unchanged: !!r.unchanged, movedFrom: r.movedFrom ? r.movedFrom.name : '', backfill });
      }
      // Paying customers with no rep — the ones a phone-close may have left
      // unattributed. Surfaced so the owner can spot and assign them.
      if (p === '/api/admin/reps/unattributed' && req.method === 'GET') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const rows = db.allAccounts().filter((a) => !a.repId && ['active', 'trialing'].includes(a.subStatus) && !stripe.isOwner(a))
          .map((a) => ({ id: a.id, email: a.email, tier: a.tier, subStatus: a.subStatus, since: a.createdAt }));
        return json(res, { rows });
      }
      if (p === '/api/admin/reps/delete' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        try { const r = reps.deleteRep(f.id); db.logActivity(acc, { agent: 'SYSTEM', msg: `Sales rep deleted: ${r.name} (${r.code})` }); return json(res, { ok: true }); }
        catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/admin/reps/code' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        try { const r = reps.setCode(f.id, f.code); db.logActivity(acc, { agent: 'SYSTEM', msg: `Rep code changed: ${r.name} is now ${r.code}` }); return json(res, { ok: true, rep: r }); }
        catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/admin/reps/ledger' && req.method === 'GET') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const id = url.searchParams.get('repId') || '';
        const rows = reps.ledgerFor(id).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return json(res, { rows, summary: reps.summary(id) });
      }
      // Mark a period paid. Hard-gated on the paperwork: an unsigned rep or one
      // with no W-9 cannot be paid, because that is the moment the gate matters.
      if (p === '/api/admin/reps/pay' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        const f = parseJSON(await readBody(req));
        const rep = reps.repById(f.repId);
        const blocked = reps.payoutBlocked(rep);
        if (blocked) return json(res, { error: `Cannot pay ${rep ? rep.name : 'this rep'}: ${blocked}` }, 400);
        reps.releaseHolds();
        const batch = db.uid();
        let n = 0, cents = 0;
        for (const row of reps.ledgerFor(rep.id)) {
          if (row.status === 'held' || row.status === 'paid') continue;
          db.patchCollection('commissions', row.id, { status: 'paid', paidAt: db.nowISO(), batch });
          n++; cents += row.amountCents;
        }
        db.logActivity(acc, { agent: 'SYSTEM', msg: `Paid ${rep.name} ${reps.usd(cents)} across ${n} ledger rows (batch ${batch})` });
        return json(res, { ok: true, batch, rows: n, amount: reps.usd(cents), cents });
      }

      // ---- billing setup diagnostic (owner only; reports names, never values) ----
      // ---- cancel / resume, portal-independent ----
      if (p === '/api/billing/cancel' && req.method === 'POST') {
        try {
          const r = await stripe.cancelAtPeriodEnd(account);
          const when = r.endsAt ? new Date(r.endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : 'the end of your period';
          return json(res, { ok: true, endsAt: r.endsAt,
            note: r.trialing ? `Done — your trial is cancelled and your card will not be charged. Everything stays available until ${when}.`
                             : `Done — nothing further will be charged. Your plan keeps working until ${when}, and you can resume any time before then.` });
        } catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/billing/resume' && req.method === 'POST') {
        try { await stripe.resumeSubscription(account); return json(res, { ok: true, note: 'Welcome back — your plan continues as before.' }); }
        catch (e) { return json(res, { error: e.message }, 400); }
      }
      // ---- one-time top-up packs ----
      if (p === '/api/topup' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!plans.isPro(account) && !stripe.isOwner(account)) return json(res, { error: 'Top-ups need an active plan — they add to your plan allowance.' }, 400);
        try { const u2 = await stripe.createTopupCheckout(account, String(f.kind || '')); return json(res, { ok: true, url: u2 }); }
        catch (e) { return json(res, { error: e.message }, 400); }
      }
      if (p === '/api/billing/diag' && req.method === 'GET') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        return json(res, stripe.configReport());
      }
      // Owner action: make every tier sellable by creating the Stripe prices
      // that do not exist yet (existing ones are never touched). The plan
      // modal offers this to the owner when some tiers have no price.
      if (p === '/api/admin/stripe/sync-prices' && req.method === 'POST') {
        if (!stripe.isOwner(account)) return json(res, { error: 'Not available.' }, 403);
        try {
          const r = await stripe.createMissingPrices();
          db.logActivity(account.id, { agent: 'SYSTEM', msg: r.created.length ? `Created Stripe prices for: ${r.created.map((c) => c.tier).join(', ')}` : 'Stripe prices: nothing missing' });
          return json(res, { ok: true, ...r, report: stripe.configReport() });
        } catch (e) { return json(res, { error: e.message }, 502); }
      }

      // ---- suppression list ----
      if (p === '/api/suppression' && req.method === 'GET') {
        return json(res, { list: db.getSuppression(acc).slice(-500).reverse(), reasons: suppress.REASONS });
      }
      if (p === '/api/suppression/add' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        // Phone numbers were unaddable: anything without an "@" was rejected,
        // so the ONLY way a number ever reached the do-not-call list was a
        // caller saying "stop" mid-call. An owner told "take us off your list"
        // by email or in person had nowhere to put it.
        const parts = String(f.emails || f.email || '').split(/[\s,;\n]+/).map((s) => s.trim()).filter(Boolean);
        const emails = parts.filter((e) => e.includes('@'));
        const phones = parts.filter((e) => !e.includes('@') && (e.replace(/[^0-9]/g, '').length >= 10));
        if (!emails.length && !phones.length) return json(res, { error: 'Enter an email address or a phone number.' }, 400);
        for (const e of emails) suppress.suppress(acc, e, 'manual', { wholeDomain: !!f.wholeDomain });
        for (const ph of phones) suppress.suppressPhone(acc, ph, 'manual', { note: 'added by hand' });
        db.logActivity(acc, { agent: 'SYSTEM', msg: `Blocked ${emails.length} address(es) and ${phones.length} number(s)` });
        return json(res, { ok: true, added: emails.length + phones.length });
      }
      if (p === '/api/suppression/remove' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        return json(res, { ok: suppress.unsuppress(acc, f.email) });
      }
      if (p === '/api/sendlog' && req.method === 'GET') {
        return json(res, { sends: db.getSendLog(acc, 200) });
      }

      // ---- deliverability: SPF / DKIM / DMARC on the sending domain ----
      if (p === '/api/deliverability/check' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const cfg = account.smtp || {};
        const from = f.email || cfg.fromEmail || cfg.user || '';
        if (!from) return json(res, { error: 'Connect a sending mailbox first — then we can check its domain.' }, 400);
        const report = await dnsauth.checkDomain(from, { selector: f.selector || '', force: true });
        return json(res, report);
      }

      // ---- warmup settings ----
      if (p === '/api/settings/warmup' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const cur = account.warmup || {};
        const domain = dnsauth.domainOfEmail((account.smtp || {}).fromEmail || (account.smtp || {}).user || '');
        const patch = f.enabled === false
          ? { ...cur, enabled: false }
          : { ...sending.startWarmup(domain, f.ceiling ?? cur.ceiling), ...(cur.domain === domain && cur.startDate ? { startDate: cur.startDate } : {}),
              ceiling: Math.max(1, Number(f.ceiling ?? cur.ceiling ?? sending.WARMUP_CEILING)) };
        db.updateAccount(acc, { warmup: patch });
        return json(res, { ok: true, warmup: sending.warmupStatus(patch) });
      }

      // ---- live credential check: verifies the STORED mailbox login right
      // now, changing nothing. The one-click answer to "is my password saved
      // and does Gmail still accept it?"
      if (p === '/api/settings/smtp/test' && req.method === 'POST') {
        const tcfg = account.smtp || {};
        if (!tcfg.user || !tcfg.pass) return json(res, { ok: false, error: 'No mailbox saved yet - enter your email and app password above.' });
        const v = await smtp.verify(tcfg);
        db.logActivity(acc, { agent: 'SEND', msg: v.ok ? 'Mailbox live-check passed' : `Mailbox live-check FAILED: ${v.error}` });
        return json(res, v.ok ? { ok: true, user: tcfg.user } : { ok: false, error: v.error });
      }

      // ---- email data quota (answers "why am I getting guesses?") ----
      if (p === '/api/settings/emailkey/status' && req.method === 'GET') {
        const st = await emailApi.accountStatus(db.getAccount(acc));
        if (!st) return json(res, { error: 'No email data key connected (or Hunter unreachable).' }, 400);
        return json(res, st);
      }

      // ---- sending mailbox settings ----
      if (p === '/api/settings/smtp' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        // BLANK PASSWORD MEANS "UNCHANGED". The UI clears the password field
        // after a successful connect (so it's never displayed), which meant any
        // later save — tweaking the delay, or just clicking Connect again —
        // posted pass:'' and silently WIPED the working password. The UI kept
        // saying "connected" while the server could no longer send.
        const existing = (account.smtp || {});
        const pass = f.pass ? String(f.pass) : (existing.pass || '');
        const cfg = { host: f.host || 'smtp.gmail.com', port: Number(f.port) || 465,
          user: f.user || existing.user || '', pass,
          fromEmail: f.fromEmail || f.user || existing.fromEmail || '', fromName: f.fromName ?? existing.fromName ?? '' };
        // Verify whenever we have credentials that haven't been proven in this
        // exact combination — i.e. a new password, or a changed user/host.
        const needsVerify = !!f.pass || (pass && (cfg.user !== existing.user || cfg.host !== existing.host));
        if (needsVerify) {
          const v = await smtp.verify(cfg);
          if (!v.ok) return json(res, { error: `Could not sign in to that mailbox: ${v.error}` }, 400);
        }
        // A different sending domain means a fresh reputation — restart warmup.
        const newDomain = dnsauth.domainOfEmail(cfg.fromEmail || cfg.user);
        const prev = account.warmup || {};
        const warmup = (prev.domain === newDomain && prev.startDate)
          ? prev
          : sending.startWarmup(newDomain, prev.ceiling);
        db.updateAccount(acc, { smtp: cfg, warmup,
          sendWindow: f.sendWindow === 'anytime' ? 'anytime' : 'business',
          sendDelaySec: Math.max(0, Number(f.sendDelaySec ?? account.sendDelaySec ?? 25)),
          dailyCap: Math.max(1, Number(f.dailyCap ?? account.dailyCap ?? 50)) });
        return json(res, { ok: true, warmup: sending.warmupStatus(warmup) });
      }

      // ---- bulk approve ----
      if (p === '/api/queue/approve-all' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const pending = db.getQueue(acc, f.profileId).filter((q) => q.status === 'pending');
        for (const it of pending) {
          db.updateQueueItem(acc, it.id, { status: 'approved', approvedAt: db.nowISO() });
          if (it.leadId) db.updateLead(acc, it.leadId, { status: 'approved' });
        }
        db.logActivity(acc, { agent: 'OPERATOR', profileId: f.profileId, msg: `Approved all (${pending.length})` });
        return json(res, { approved: pending.length });
      }

      // ---- send all approved (background, throttled) ----
      if (p === '/api/send/run' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        // Fail FAST and VISIBLY. These same checks exist inside the job, but an
        // async job's error is easy to miss — a 400 here becomes an immediate
        // toast telling the user exactly what to fix.
        const cfg0 = account.smtp || {};
        if (!cfg0.user || !cfg0.pass) return json(res, { error: 'Connect your sending mailbox first (Your Business tab → SENDING).' }, 400);
        const prof0 = db.getProfile(acc, f.profileId);
        if (!prof0) return json(res, { error: 'Pick a business first.' }, 400);
        if (!String(prof0.mailingAddress || '').trim()) {
          return json(res, { error: 'One thing missing: your business mailing address (Your Business tab → "Business mailing address"). The law requires it in every commercial email — takes 30 seconds, then hit send again.' }, 400);
        }
        let job;
        try { job = startSendJob(account, f.profileId); }
        catch (e) {
          if (e.alreadyRunning) return json(res, { error: e.message, jobId: e.alreadyRunning }, 409);
          throw e;
        }
        return json(res, { jobId: job.id, ...sendJobView(job) });
      }
      if (p === '/api/send/status' && req.method === 'GET') {
        const j = sendJobs.get(url.searchParams.get('jobId'));
        if (!j || j.accountId !== acc) return json(res, { error: 'job not found', gone: true }, 404);
        return json(res, sendJobView(j));
      }
      // ---- STOP a running send ----
      // Takes no job id: "stop" must work from any device and any tab, even the
      // one that did not start the run. Whatever is sending for this account is
      // what stops.
      if (p === '/api/send/stop' && req.method === 'POST') {
        const running = activeSends.get(acc);
        const j = running && sendJobs.get(running);
        if (!j || j.status !== 'running') return json(res, { ok: true, wasRunning: false, note: 'Nothing is sending right now.' });
        j.stopRequested = true;
        db.logActivity(acc, { agent: 'SEND', msg: 'Stop requested — finishing the email in flight, then halting' });
        return json(res, { ok: true, wasRunning: true, jobId: j.id, ...sendJobView(j) });
      }

      if (p === '/api/leads/import' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        // Tag the user's own list as trusted so it is draftable and survives
        // "Clear guesses" — they vouched for these addresses by importing them.
        let rows = (f.rows || parseCSV(f.csv || '')).map((r) => ({
          ...r, emailConfidence: r.emailConfidence || 'imported', emailSource: r.emailSource || 'your import',
        }));
        // Imported leads still cost AI money the moment they're drafted, so the
        // plan bounds them too. Hard ceiling as a backstop against a huge paste.
        const impUsage = plans.usage(account, stripe.isOwner(account));
        const impCap = impUsage.unlimited ? 5000 : Math.min(5000, impUsage.remaining);
        let impTrimmed = 0;
        if (rows.length > impCap) { impTrimmed = rows.length - impCap; rows = rows.slice(0, impCap); }
        const added = db.addLeads(acc, f.profileId, rows);
        db.logActivity(acc, { agent: 'SYSTEM', profileId: f.profileId, msg: `Imported ${added.length} lead(s)` });
        return json(res, { added: added.length, trimmed: impTrimmed,
          note: impTrimmed ? `${impTrimmed} row(s) skipped — that's over what's left on your plan this month.` : '' });
      }
      if (p === '/api/leads/clear' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!f.profileId) return json(res, { error: 'No business selected.' }, 400);
        const mode = f.mode === 'guesses' ? 'guesses' : 'all';
        const n = db.clearLeads(acc, f.profileId, mode);
        db.logActivity(acc, { agent: 'SYSTEM', profileId: f.profileId, msg: `Cleared ${n} ${mode === 'guesses' ? 'unverified' : ''} lead(s)` });
        return json(res, { removed: n });
      }
      // Draft every follow-up that's due today.
      if (p === '/api/keeper/run' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        return json(res, await agents.keeperRun(acc, f.profileId));
      }
      // Where every lead stands, and how many are due a touch.
      if (p === '/api/pipeline' && req.method === 'GET') {
        const pid = url.searchParams.get('profileId') || '';
        return json(res, { pipeline: memory.pipeline(acc, pid), stages: memory.STAGES, cadence: memory.CADENCE });
      }
      // Manual stage change — the human always outranks the machine.
      if (p === '/api/lead/stage' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const lead = db.getLeads(acc).find((l) => l.id === f.id);
        if (!lead) return json(res, { error: 'Lead not found' }, 404);
        const stage = memory.STAGES[f.stage] ? f.stage : null;
        if (!stage) return json(res, { error: 'Unknown stage' }, 400);
        const kind = f.stage === 'customer' ? 'note' : (f.replied ? 'email-replied' : 'note');
        memory.remember(acc, lead, { kind, summary: f.note || `marked ${memory.STAGES[stage].label}`, stage,
          facts: f.note ? [f.note] : [] });
        if (stage === 'dnc') {
          // "Do not contact" is an instruction about a person, not about an
          // inbox. Suppressing only the email left the owner's own explicit
          // instruction silently overridden by the dialler.
          if (lead.email) suppress.suppress(acc, lead.email, 'manual', { note: 'marked do-not-contact' });
          if (lead.phone) suppress.suppressPhone(acc, lead.phone, 'manual', { note: 'marked do-not-contact' });
        }
        db.logActivity(acc, { agent: 'OPERATOR', msg: `${lead.name || lead.email} → ${memory.STAGES[stage].label}` });
        return json(res, { ok: true });
      }

      if (p === '/api/outbound/run' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        return json(res, await agents.outboundRun(acc, f.profileId));
      }
      if (p === '/api/scout/brief' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        return json(res, await agents.scoutBrief(acc, f.profileId));
      }
      if (p === '/api/queue/approve' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const it = db.updateQueueItem(acc, f.id, { status: 'approved', approvedAt: db.nowISO() });
        if (it && it.leadId) db.updateLead(acc, it.leadId, { status: 'approved' });
        db.logActivity(acc, { agent: 'OPERATOR', msg: `Approved email to ${it && (it.toName || it.to)}` });
        return json(res, { item: it });
      }
      if (p === '/api/queue/reject' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const it = db.updateQueueItem(acc, f.id, { status: 'rejected' });
        if (it && it.leadId) db.updateLead(acc, it.leadId, { status: 'new' });
        return json(res, { item: it });
      }
      if (p === '/api/queue/sent' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const it = db.updateQueueItem(acc, f.id, { status: 'sent', sentAt: db.nowISO() });
        if (it && it.leadId) db.updateLead(acc, it.leadId, { status: 'sent' });
        db.logActivity(acc, { agent: 'OPERATOR', msg: `Marked sent: ${it && (it.toName || it.to)}` });
        return json(res, { item: it });
      }
      return json(res, { error: 'not found' }, 404);
    }

    return html(res, '<p>Not found. <a href="/app">Go to app</a></p>', 404);
  } catch (e) {
    if (p.startsWith('/api/')) return json(res, { error: e.message }, 500);
    // A voice webhook must NEVER answer with a 500. Twilio turns that into
    // "we're sorry, an application error has occurred" spoken to a customer,
    // mid-call. Whatever went wrong, the caller hears the agent bow out
    // gracefully, and the owner gets the real error in their activity log
    // instead of a mystery.
    if (p.startsWith('/voice/') || p.startsWith('/sms/')) {
      console.error(`voice webhook error at ${p}:`, e && e.stack || e);
      try {
        const sid = String((req.__params && req.__params.CallSid) || '');
        const call = sid ? voice.getCall(sid) : null;
        if (call && call.accountId) db.logActivity(call.accountId, { agent: 'VOICE', msg: `Call glitched at ${p}: ${String(e && e.message || e).slice(0, 200)}` });
      } catch {}
      if (p.startsWith('/sms/')) { res.writeHead(200, { 'Content-Type': 'text/xml' }); return res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>'); }
      return xml(res, voice.sayAndHangup("Sorry — something glitched on my end. Give me a minute and try again, or I'll have someone call you back."));
    }
    return html(res, `<pre style="padding:40px;font-family:monospace">${e.message}</pre>`, 500);
  }
});

// Learn the live prices from Stripe itself, at boot and hourly, so a tier is
// sellable the moment its price exists -- no Render env var to forget.
async function refreshPrices(tag) {
  try {
    const found = await plans.discoverPrices();
    const list = Object.keys(found);
    console.log(`  Stripe prices (${tag}): ${list.length ? list.join(', ') : 'none discovered'}${process.env.STRIPE_SECRET_KEY ? '' : ' (no STRIPE_SECRET_KEY)'}`);
    // Self-heal: any tier whose Stripe price does not match the price in
    // plans.js gets one created, right now, at boot. This is what makes a
    // price change a one-line edit that is live on the next deploy, instead
    // of a one-line edit plus a button somebody has to remember to click.
    // AUTO_CREATE_PRICES=off disables it.
    if (process.env.STRIPE_SECRET_KEY && process.env.AUTO_CREATE_PRICES !== 'off') {
      const stale = plans.tierList().filter((t) => !plans.priceIsCurrent(t.id)).map((t) => t.id);
      if (stale.length) {
        console.log(`  Stripe prices out of date for: ${stale.join(', ')} — creating`);
        const r = await stripe.createMissingPrices();
        if (r.created.length) console.log(`  Created Stripe prices: ${r.created.map((c) => `${c.tier}=${c.priceId}`).join(', ')}${r.live ? ' (LIVE)' : ' (test)'}`);
      }
    }
  } catch (e) { console.error(`  Stripe price sync failed (${tag}): ${e.message}`); }
}
setInterval(() => { refreshPrices('hourly'); }, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`\n  Dawnpipe Cloud → http://localhost:${PORT}`);
  console.log(`  AI mode: ${aiMode()}  |  Billing: ${stripe.configured() ? 'Stripe configured' : 'not configured (DEV_UNLOCK=' + (process.env.DEV_UNLOCK || '0') + ')'}\n`);
  refreshPrices('boot');
});
