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
const { aiMode } = require('./lib/ai');

const PORT = process.env.PORT || 8090;

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
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(b));
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
const LEGAL_UPDATED = 'Last updated: 23 July 2026';
const LEGAL_TERMS = `
<h1>Terms of Service</h1><div class="updated">${LEGAL_UPDATED}</div>
<p>These terms govern your use of Dawnpipe ("the Service"). By creating an account you agree to them.</p>
<h2>What the Service does</h2>
<p>Dawnpipe researches publicly available information to identify potential business contacts, and drafts outreach emails for your review. Drafts are not sent without your approval.</p>
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
<li>Plans include a monthly usage allowance. We may apply fair-use limits to protect the Service.</li>
<li>You can cancel at any time; access continues to the end of the paid period. We do not provide pro-rata refunds for partial months except where required by law.</li>
</ul>
<h2>Acceptable use</h2>
<p>We may suspend accounts that generate excessive bounces or spam complaints, attempt to circumvent usage limits, or abuse the Service.</p>
<h2>Liability</h2>
<p>To the maximum extent permitted by law, our total liability is limited to the amount you paid in the previous three months. We are not liable for indirect or consequential losses, including lost business or damage to sender reputation.</p>
<h2>Changes</h2>
<p>We may update these terms; material changes will be notified by email. Continued use constitutes acceptance.</p>
<h2>Contact</h2>
<p>Questions: <a href="mailto:btk18000@gmail.com">btk18000@gmail.com</a></p>
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
</ul>
<h2>How we use it</h2>
<p>Solely to operate the Service: researching leads, drafting emails, sending messages you approve, and billing. We do not sell your data or share it for advertising.</p>
<h2>Processors</h2>
<p>We use Anthropic (AI drafting and research), Stripe (payments), and our hosting provider. Your business profile and lead context are sent to the AI provider to generate drafts.</p>
<h2>Information about third parties</h2>
<p>Leads consist of business contact details from public sources. If you are a contact in someone's list and want your details removed, email us and we will remove them.</p>
<h2>Retention and your rights</h2>
<p>We keep your data while your account is active. You can request export or deletion of your account and data at any time by emailing us, and we will action it within 30 days.</p>
<h2>Security</h2>
<p>Passwords are hashed (scrypt). Traffic is served over HTTPS. No system is perfectly secure; use a unique password and an app-specific password for any connected mailbox.</p>
<h2>Contact</h2>
<p>Privacy questions or deletion requests: <a href="mailto:btk18000@gmail.com">btk18000@gmail.com</a></p>
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
          if (delta > 0) plans.consume(acct, delta, stripe.isOwner(acct));
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
const sendJobs = new Map();

function startSendJob(account, profileId) {
  const id = db.uid();
  const items = db.getQueue(account.id, profileId).filter((q) => q.status === 'approved');
  const cfg = account.smtp || {};
  const todayStr = db.today();
  const sentToday = (account.sentToday && account.sentToday.date === todayStr) ? account.sentToday.count : 0;
  // Daily ceiling is the LOWER of the user's cap and today's warmup allowance —
  // a new domain that blasts its full cap on day one gets filtered for months.
  const warmAllow = sending.warmupAllowance(account.warmup, todayStr);
  const cap = Math.min(Number(account.dailyCap ?? 50), warmAllow);
  const allowed = Math.max(0, cap - sentToday);

  const job = { id, accountId: account.id, status: 'running', done: 0, total: Math.min(items.length, allowed),
    sent: 0, failed: 0, deferred: 0, skipped: Math.max(0, items.length - allowed),
    warmupCap: Number.isFinite(warmAllow) ? warmAllow : null,
    startedAt: Date.now(), error: null, lastError: null };
  sendJobs.set(id, job);

  (async () => {
    try {
      if (!cfg.user || !cfg.pass) throw new Error('No sending mailbox connected — add it in Settings first.');
      // HARD GATE: an unauthenticated domain gets spam-foldered, and the damage
      // is slow and permanent. Refuse to send until SPF+DKIM+DMARC pass.
      const auth = await dnsauth.checkDomain(cfg.fromEmail || cfg.user).catch(() => null);
      if (auth && auth.ok === false) {
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
            db.updateQueueItem(account.id, it.id, { status: 'rejected' });
            if (it.leadId) db.updateLead(account.id, it.leadId, { status: 'new' });
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Blocked send to ${it.to} — ${lead ? 'unverified address' : 'no lead record'} (bounce risk)` });
            job.failed++; job.lastError = 'blocked: unverified address';
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
          const bh = sending.withinBusinessHours(lead, {});
          if (!bh.ok) {
            db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Holding ${it.to} — ${bh.reason}` });
            job.deferred++; job.done++;
            continue; // stays approved; the next run picks it up in-hours
          }
          // Live unsubscribe link + CAN-SPAM footer, stamped at send time.
          const unsubUrl = base ? `${base}/u/${suppress.tokenFor(account.id, it.to)}` : '';
          const body = agents.stampFooter(it.body, prof, unsubUrl);
          await smtp.sendMail({ ...cfg, fromName: cfg.fromName || '' },
            { to: it.to, subject: it.subject, body, unsubscribeUrl: unsubUrl });
          db.updateQueueItem(account.id, it.id, { status: 'sent', sentAt: db.nowISO() });
          if (it.leadId) db.updateLead(account.id, it.leadId, { status: 'sent' });
          // Immutable audit trail: who was emailed, when, with what, approved by whom.
          db.logSend(account.id, { profileId, leadId: it.leadId || null, to: it.to, toName: it.toName || '',
            company: it.company || '', subject: it.subject || '', body, approvedBy: account.email,
            approvedAt: it.approvedAt || null, queueId: it.id });
          db.logActivity(account.id, { agent: 'SEND', profileId, msg: `Sent to ${it.toName || it.to}` });
          job.sent++; count++;
          db.updateAccount(account.id, { sentToday: { date: todayStr, count } });
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
        // Randomised 3-8 min gap: a fixed interval is a machine fingerprint.
        if (job.done < job.total) await new Promise((r) => setTimeout(r, sending.nextDelayMs()));
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'error'; job.error = e.message;
    }
    job.finishedAt = Date.now();
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
    skipped: j.skipped, deferred: j.deferred || 0, suppressed: j.suppressed || 0, warmupCap: j.warmupCap ?? null,
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

    db.updateProfile(p.accountId, p.id, { schedule: { ...s, lastRunDate: dateKey } });
    db.logActivity(p.accountId, { agent: 'NIGHT SHIFT', profileId: p.id, msg: `Scheduled run started — sourcing ${s.count || 50} leads` });
    startProspectJob(p.accountId, p.id, { count: Math.min(Number(s.count) || 50, 50), hints: s.hints || '', thenDraft: true, notify: true });
  }
}
setInterval(checkSchedules, 60 * 1000);

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const account = auth.currentAccount(req);

  try {
    // ---------- health ----------
    // animated tab icon (drawn client-side on canvas)
    if (req.method === 'GET' && p === '/favicon.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return res.end(view('favicon.js'));
    }
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    // ================= VOICE (Twilio webhooks) =================
    // Public endpoints Twilio POSTs to. Every request is signature-verified so
    // nobody can spoof a call, inject a transcript, or burn AI spend.
    if (p.startsWith('/voice/')) {
      const raw = await readBody(req);
      const params = parseForm(raw);
      const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      const sig = req.headers['x-twilio-signature'];
      if (!voice.configured()) return xml(res, voice.sayAndHangup('Voice is not configured yet. Goodbye.'));
      if (!voice.verifySignature(base + p, params, sig)) {
        db.logActivity('system', { agent: 'VOICE', msg: 'Rejected unsigned webhook on ' + p });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('bad signature');
      }
      const sid = params.CallSid || '';

      // ---- inbound: someone rang the number ----
      if (p === '/voice/incoming') {
        const account = db.accountByVoiceNumber(params.To || '');
        if (!account) return xml(res, voice.sayAndHangup('Thanks for calling. This line is not set up yet. Goodbye.'));
        const vcfg = account.voice || {};
        const profile = db.getProfile(account.id, vcfg.profileId) || db.getProfiles(account.id)[0];
        if (!profile) return xml(res, voice.sayAndHangup('Thanks for calling. Goodbye.'));
        const agentName = vcfg.agentName || 'Sarah';
        // Transparency is mandatory: the caller is told it is an AI up front.
        const greeting = vcfg.greeting
          || ('Hi, this is ' + agentName + ', an AI assistant for ' + profile.name + '. How can I help you today?');
        voice.startCall(sid, { accountId: account.id, account, profile, direction: 'inbound',
          from: params.From || '', to: params.To || '' });
        db.saveCall(account.id, { sid, direction: 'inbound', from: params.From || '', to: params.To || '',
          profileId: profile.id, status: 'in-progress', transcript: [] });
        db.logActivity(account.id, { agent: 'VOICE', msg: 'Incoming call from ' + (params.From || 'unknown') });
        return xml(res, voice.sayAndGather(greeting, base + '/voice/turn'));
      }

      // ---- outbound call answered ----
      if (p === '/voice/answer') {
        const call = voice.getCall(sid);
        if (/machine|fax/i.test(params.AnsweredBy || '')) {
          const vm = (call && call.account.voice && call.account.voice.voicemail)
            || ('Hi, this is an AI assistant calling from ' + (call ? call.profile.name : 'our team')
                + '. Sorry to miss you, we will try again another time.');
          if (call) db.saveCall(call.accountId, { sid, status: 'voicemail', outcome: 'voicemail' });
          return xml(res, voice.sayAndHangup(vm));
        }
        if (!call) return xml(res, voice.sayAndHangup('Sorry, there was a problem. Goodbye.'));
        const agentName = (call.account.voice && call.account.voice.agentName) || 'Sarah';
        const who = call.lead && call.lead.name ? ' Am I speaking with ' + call.lead.name + '?' : '';
        const opener = 'Hi, this is ' + agentName + ', an AI assistant calling on behalf of '
          + call.profile.name + '.' + who + ' Did I catch you at an okay time?';
        return xml(res, voice.sayAndGather(opener, base + '/voice/turn'));
      }

      // ---- one conversational turn ----
      if (p === '/voice/turn') {
        const call = voice.getCall(sid);
        if (!call) return xml(res, voice.sayAndHangup('Sorry, this call timed out. Goodbye.'));
        const heard = (params.SpeechResult || '').trim();

        if (!heard) {
          call.silence = (call.silence || 0) + 1;
          if (call.silence >= 2) {
            db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'no-response', transcript: call.turns });
            return xml(res, voice.sayAndHangup('I could not hear anything, so I will let you go. Call back anytime. Goodbye.'));
          }
          return xml(res, voice.sayAndGather('Sorry, I did not catch that. Could you say it again?', base + '/voice/turn'));
        }
        call.silence = 0;
        call.turns.push({ who: 'caller', text: heard });

        if (call.turns.length > voice.MAX_TURNS) {
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'max-length', transcript: call.turns });
          return xml(res, voice.sayAndHangup('I have taken enough of your time. Someone from the team will follow up. Goodbye.'));
        }

        let out;
        try { out = await voice.think(call, heard); }
        catch (e) {
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'AI error mid-call: ' + e.message });
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'ai-error', transcript: call.turns });
          return xml(res, voice.sayAndHangup('I am having a technical problem on my end. I will have someone call you back. Sorry about that, goodbye.'));
        }
        call.turns.push({ who: 'agent', text: out.say });
        db.saveCall(call.accountId, { sid, transcript: call.turns });

        if (out.action === 'dnc') {
          const num = call.direction === 'inbound' ? params.From : call.to;
          suppress.suppress(call.accountId, String(num || '').replace(/[^0-9+]/g, '') + '@phone.invalid',
            'unsubscribe', { note: 'do-not-call, by phone' });
          if (call.lead && call.lead.email) suppress.suppress(call.accountId, call.lead.email, 'unsubscribe', { note: 'do-not-call, by phone' });
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'do-not-call', transcript: call.turns });
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'DO NOT CALL requested by ' + num + ' - suppressed' });
          return xml(res, voice.sayAndHangup(out.say || 'Understood, I have removed you from our list. Goodbye.'));
        }
        if (out.action === 'transfer') {
          const to = (call.account.voice && call.account.voice.transferTo) || '';
          if (!to) return xml(res, voice.sayAndGather('I do not have anyone free to transfer you to right now, but I can take a message. What is the best number?', base + '/voice/turn'));
          db.saveCall(call.accountId, { sid, outcome: 'transferred', transcript: call.turns });
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Transferring call to ' + to });
          return xml(res, voice.sayAndDial(out.say || 'Connecting you now, one moment.', to));
        }
        if (out.action === 'book') {
          const d = out.data || {};
          const phone = d.phone || params.From || '';
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'booked', transcript: call.turns,
            booking: { name: d.name, company: d.company, phone, reason: d.reason, when: d.when } });
          db.addLeads(call.accountId, call.profile.id, [{
            name: d.name || 'Caller', company: d.company || '', email: '',
            emailConfidence: 'imported', emailSource: 'phone call',
            notes: 'PHONE ' + call.direction + ' | ' + phone + ' | wants: ' + (d.reason || 'callback') + ' | when: ' + (d.when || 'unspecified'),
          }]);
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Callback booked: ' + (d.name || 'caller') + ' (' + phone + ') - ' + (d.when || 'time TBC') });
          return xml(res, voice.sayAndHangup(out.say || 'Perfect, I have that booked. Someone will be in touch. Goodbye.'));
        }
        if (out.action === 'end') {
          db.saveCall(call.accountId, { sid, status: 'completed', outcome: 'ended', transcript: call.turns });
          return xml(res, voice.sayAndHangup(out.say));
        }
        return xml(res, voice.sayAndGather(out.say, base + '/voice/turn'));
      }

      // ---- call finished ----
      if (p === '/voice/status') {
        const call = voice.getCall(sid);
        if (call) {
          db.saveCall(call.accountId, { sid, status: params.CallStatus || 'completed',
            durationSec: Number(params.CallDuration || 0), transcript: call.turns });
          db.logActivity(call.accountId, { agent: 'VOICE', msg: 'Call ' + params.CallStatus + ' (' + (params.CallDuration || 0) + 's)' });
          voice.endCall(sid);
        }
        res.writeHead(204); return res.end();
      }
      return xml(res, voice.sayAndHangup('Goodbye.'));
    }

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
        db.logActivity(parsed.accountId, { agent: 'SEND', msg: `Unsubscribed: ${parsed.email}` });
        if (req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK'); }
        return done('You’re unsubscribed', `We’ve removed <b>${parsed.email}</b>. You won’t receive any more messages from this sender.`);
      }
    }

    if (req.method === 'GET' && p === '/health') {
      return json(res, { ok: true, ai: aiMode(), uptime: Math.round(process.uptime()) });
    }


    // ---------- public ----------
    if (req.method === 'GET' && p === '/') {
      if (account) return redirect(res, '/app');
      // Demo video: set DEMO_VIDEO_URL (YouTube/Loom EMBED url) to show it;
      // until then a styled placeholder keeps the section presentable.
      const demo = process.env.DEMO_VIDEO_URL
        ? `<div style="position:relative;padding-top:56.25%;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#000"><iframe src="${process.env.DEMO_VIDEO_URL}" style="position:absolute;inset:0;width:100%;height:100%;border:0" allowfullscreen loading="lazy"></iframe></div>`
        : `<div style="border:2px dashed var(--line);border-radius:12px;padding:60px 20px;text-align:center;color:var(--ink2);background:var(--paper2)">▶ Demo video coming shortly — <a href="/signup">get started</a> and see it live in your own account.</div>`;
      return html(res, view('landing.html').replace('__DEMO_VIDEO__', demo));
    }
    // Legal pages — public, and required before Stripe will approve billing.
    if (req.method === 'GET' && (p === '/terms' || p === '/privacy')) {
      const isTerms = p === '/terms';
      const body = isTerms ? LEGAL_TERMS : LEGAL_PRIVACY;
      return html(res, view('legal.html').replace('__TITLE__', isTerms ? 'Terms of Service' : 'Privacy Policy').replace('__BODY__', body));
    }

    if (req.method === 'GET' && p === '/signup') return html(res, view('signup.html'));
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
        return html(res, view('signup.html').replace('<!--ERR-->', 'Too many accounts created from here. Try again later.'), 429);
      }
      const f = parseForm(await readBody(req));
      const email = (f.email || '').trim().toLowerCase();
      const pw = f.password || '';
      if (!email || pw.length < 6) return html(res, view('signup.html').replace('<!--ERR-->', 'Enter a valid email and a password of 6+ characters.'), 400);
      if (db.getAccountByEmail(email)) return html(res, view('signup.html').replace('<!--ERR-->', 'That email already has an account. Try logging in.'), 400);
      const { salt, passHash } = auth.hashPassword(pw);
      const acc = db.createAccount({ email, passHash, salt });
      seedStarterProfile(acc.id, email);
      db.logActivity(acc.id, { agent: 'SYSTEM', msg: 'Account created' });
      const token = db.createSession(acc.id);
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

    // ---------- auth-required below ----------
    if (!account) {
      if (p.startsWith('/api/')) return json(res, { error: 'not authenticated' }, 401);
      return redirect(res, '/login');
    }

    // start checkout
    if (req.method === 'GET' && p === '/checkout') {
      if (!stripe.configured()) return html(res, `<p style="font-family:system-ui;padding:40px">Billing isn't configured yet. Set STRIPE_* in .env, or use DEV_UNLOCK=1 for testing. <a href="/app">Back</a></p>`);
      const tier = url.searchParams.get('tier') || 'starter';
      const link = await stripe.createCheckout(account, tier);
      return redirect(res, link);
    }

    if (req.method === 'GET' && p === '/app') {
      let page = view('app.html');
      const locked = !stripe.hasAccess(account);
      page = page.replace('__EMAIL__', account.email).replace('__LOCKED__', locked ? 'true' : 'false').replace('__AIMODE__', aiMode());
      return html(res, page);
    }

    // ---------- API (needs access) ----------
    if (p.startsWith('/api/')) {
      // Read-only endpoints stay open so a locked user can still see their work
      // (and be sold to). Only actions that cost money are gated.
      const READ_ONLY = ['/api/state', '/api/prospect/status', '/api/send/status'];
      if (!stripe.hasAccess(account) && !READ_ONLY.includes(p)) {
        const u = plans.usage(account, stripe.isOwner(account));
        return json(res, {
          error: u.isPro
            ? `You've used all ${u.limit} leads this month — your allowance resets next month.`
            : `Pick a plan to turn your sales team on — from $99/mo.`,
          locked: true, needUpgrade: !u.isPro,
        }, 402);
      }
      const acc = account.id;

      if (p === '/api/state' && req.method === 'GET') {
        return json(res, {
          email: account.email,
          locked: !stripe.hasAccess(account),
          isOwner: stripe.isOwner(account),
          usage: plans.usage(account, stripe.isOwner(account)),
          isPaid: stripe.isPaid(account),
          tiers: plans.tierList(),
          billingConfigured: stripe.configured(),
          aiMode: aiMode(),
          // masked: the app never ships the app-password back to the browser
          smtp: account.smtp ? { host: account.smtp.host, port: account.smtp.port, user: account.smtp.user,
            fromName: account.smtp.fromName, fromEmail: account.smtp.fromEmail, connected: !!account.smtp.pass } : { connected: false },
          sendDelaySec: account.sendDelaySec ?? 25,
          dailyCap: account.dailyCap ?? 50,
          sentToday: (account.sentToday && account.sentToday.date === db.today()) ? account.sentToday.count : 0,
          // key itself is never echoed back — connected flag only
          emailData: { connected: !!account.emailApiKey, fallback: !!process.env.HUNTER_API_KEY },
          warmup: sending.warmupStatus(account.warmup),
          voice: { ...(account.voice || {}), configured: voice.configured(),
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
        const fields = ['name', 'senderName', 'offer', 'icp', 'valueProp', 'proof', 'tone', 'cta', 'notes'];
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
                : `Pick a plan to turn your sales team on — from $99/mo.`,
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

      // ---- voice settings + calls ----
      if (p === '/api/voice/save' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const cur = account.voice || {};
        const v = {
          ...cur,
          enabled: f.enabled !== false,
          number: (f.number || cur.number || process.env.TWILIO_PHONE_NUMBER || '').trim(),
          profileId: f.profileId || cur.profileId || '',
          agentName: (f.agentName ?? cur.agentName ?? 'Sarah').trim(),
          greeting: (f.greeting ?? cur.greeting ?? '').trim(),
          transferTo: voice.toE164((f.transferTo ?? cur.transferTo ?? '')),
          voicemail: (f.voicemail ?? cur.voicemail ?? '').trim(),
          faq: (f.faq ?? cur.faq ?? '').trim(),
          hours: (f.hours ?? cur.hours ?? '').trim(),
        };
        db.updateAccount(acc, { voice: v });
        return json(res, { ok: true, voice: v });
      }
      if (p === '/api/voice/calls' && req.method === 'GET') {
        return json(res, { calls: db.getCalls(acc, 50) });
      }
      // Place a real outbound call. Costs money, so it is metered and explicit.
      if (p === '/api/voice/testcall' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!voice.configured()) return json(res, { error: 'Twilio keys are not set in the server environment yet.' }, 400);
        const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        if (!base.startsWith('https')) return json(res, { error: 'Set PUBLIC_URL to your https URL in Render first — Twilio must be able to reach this server.' }, 400);
        const vcfg = account.voice || {};
        const from = vcfg.number || process.env.TWILIO_PHONE_NUMBER || '';
        const to = (f.to || '').trim();
        if (!to) return json(res, { error: 'Enter the number to call (E.164 format, e.g. +13125550123).' }, 400);
        if (!from) return json(res, { error: 'No Twilio number configured.' }, 400);
        const profile = db.getProfile(acc, vcfg.profileId) || db.getProfiles(acc)[0];
        if (!profile) return json(res, { error: 'Create a business profile first.' }, 400);
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

      // ---- suppression list ----
      if (p === '/api/suppression' && req.method === 'GET') {
        return json(res, { list: db.getSuppression(acc).slice(-500).reverse(), reasons: suppress.REASONS });
      }
      if (p === '/api/suppression/add' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const emails = String(f.emails || f.email || '').split(/[\s,;]+/).filter((e) => e.includes('@'));
        if (!emails.length) return json(res, { error: 'Enter at least one email address.' }, 400);
        for (const e of emails) suppress.suppress(acc, e, 'manual', { wholeDomain: !!f.wholeDomain });
        db.logActivity(acc, { agent: 'SYSTEM', msg: `Blocked ${emails.length} address(es)` });
        return json(res, { ok: true, added: emails.length });
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

      // ---- email data quota (answers "why am I getting guesses?") ----
      if (p === '/api/settings/emailkey/status' && req.method === 'GET') {
        const st = await emailApi.accountStatus(db.getAccount(acc));
        if (!st) return json(res, { error: 'No email data key connected (or Hunter unreachable).' }, 400);
        return json(res, st);
      }

      // ---- sending mailbox settings ----
      if (p === '/api/settings/smtp' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        const cfg = { host: f.host || 'smtp.gmail.com', port: Number(f.port) || 465,
          user: f.user || '', pass: f.pass || '', fromEmail: f.fromEmail || f.user || '', fromName: f.fromName || '' };
        if (f.verify) {
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
        const job = startSendJob(account, f.profileId);
        return json(res, { jobId: job.id, ...sendJobView(job) });
      }
      if (p === '/api/send/status' && req.method === 'GET') {
        const j = sendJobs.get(url.searchParams.get('jobId'));
        if (!j || j.accountId !== acc) return json(res, { error: 'job not found', gone: true }, 404);
        return json(res, sendJobView(j));
      }

      if (p === '/api/leads/import' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        // Tag the user's own list as trusted so it is draftable and survives
        // "Clear guesses" — they vouched for these addresses by importing them.
        const rows = (f.rows || parseCSV(f.csv || '')).map((r) => ({
          ...r, emailConfidence: r.emailConfidence || 'imported', emailSource: r.emailSource || 'your import',
        }));
        const added = db.addLeads(acc, f.profileId, rows);
        db.logActivity(acc, { agent: 'SYSTEM', profileId: f.profileId, msg: `Imported ${added.length} lead(s)` });
        return json(res, { added: added.length });
      }
      if (p === '/api/leads/clear' && req.method === 'POST') {
        const f = parseJSON(await readBody(req));
        if (!f.profileId) return json(res, { error: 'No business selected.' }, 400);
        const mode = f.mode === 'guesses' ? 'guesses' : 'all';
        const n = db.clearLeads(acc, f.profileId, mode);
        db.logActivity(acc, { agent: 'SYSTEM', profileId: f.profileId, msg: `Cleared ${n} ${mode === 'guesses' ? 'unverified' : ''} lead(s)` });
        return json(res, { removed: n });
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
    return html(res, `<pre style="padding:40px;font-family:monospace">${e.message}</pre>`, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Dawnpipe Cloud → http://localhost:${PORT}`);
  console.log(`  AI mode: ${aiMode()}  |  Billing: ${stripe.configured() ? 'Stripe configured' : 'not configured (DEV_UNLOCK=' + (process.env.DEV_UNLOCK || '0') + ')'}\n`);
});
