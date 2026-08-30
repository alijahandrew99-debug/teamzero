// Dawnpipe Cloud data layer — account-scoped JSON store, zero dependencies.
// Every record carries an accountId; all reads filter by it, so tenants are
// fully isolated. The interface is deliberately small and swappable — moving to
// Postgres later means reimplementing these functions, nothing else.
require('./env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Where data lives. On Render, code runs at /opt/render/project/src (not /app),
// so the persistent disk must be pointed at explicitly via DATA_DIR — otherwise
// writes land on the ephemeral filesystem and reset on every deploy.
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA, 'briefs'), { recursive: true });

const F = {
  accounts: path.join(DATA, 'accounts.json'),
  sessions: path.join(DATA, 'sessions.json'),
  profiles: path.join(DATA, 'profiles.json'),
  leads: path.join(DATA, 'leads.json'),
  queue: path.join(DATA, 'queue.json'),
  activity: path.join(DATA, 'activity.json'),
  resets: path.join(DATA, 'resets.json'),
  suppression: path.join(DATA, 'suppression.json'),
  sendlog: path.join(DATA, 'sendlog.json'),
  calls: path.join(DATA, 'calls.json'),
  appointments: path.join(DATA, 'appointments.json'),
  smsThreads: path.join(DATA, 'sms_threads.json'),
  spamwatch: path.join(DATA, 'spamwatch.json'),
  // Every callback request, with the consent the person gave. This file is the
  // evidence: an AI voice is an "artificial voice" under the TCPA, so calling
  // someone requires their prior express consent and the burden of PROVING it
  // is on the caller. We store the exact wording they saw, the timestamp, and
  // their IP -- unaltered, append-only, never pruned.
  callbacks: path.join(DATA, 'callbacks.json'),
  // Sales reps and the commission ledger. The ledger is APPEND-ONLY: a
  // correction is a new reversal row, never an edit, so a rep's paycheck can
  // always be reconstructed from the rows and their Stripe ids.
  reps: path.join(DATA, 'reps.json'),
  commissions: path.join(DATA, 'commissions.json'),
};

function read(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function write(f, d) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, f); // atomic-ish replace
}
function uid() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowISO() { return new Date().toISOString(); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// ---------------- accounts ----------------
function getAccountByEmail(email) {
  return read(F.accounts, []).find((a) => a.email === (email || '').toLowerCase()) || null;
}
function getAccount(id) { return read(F.accounts, []).find((a) => a.id === id) || null; }
/** Every account. Admin/maintenance only — never used to serve a tenant request. */
function allAccounts() { return read(F.accounts, []); }
function createAccount({ email, passHash, salt, acceptedTermsAt = '', termsVersion = '' }) {
  const all = read(F.accounts, []);
  const acc = {
    id: uid(), email: email.toLowerCase(), passHash, salt,
    plan: 'none', subStatus: 'inactive', stripeCustomerId: null,
    createdAt: nowISO(),
    // Proof the terms were shown and agreed to, and which version. Without this
    // the responsibility-shift language in the Terms is unenforceable.
    acceptedTermsAt, termsVersion,
  };
  all.push(acc);
  write(F.accounts, all);
  return acc;
}
function updateAccount(id, patch) {
  const all = read(F.accounts, []);
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  write(F.accounts, all);
  return all[i];
}
function accountByStripeCustomer(cid) {
  return read(F.accounts, []).find((a) => a.stripeCustomerId === cid) || null;
}

// ---------------- sessions ----------------
function createSession(accountId) {
  const all = read(F.sessions, {});
  const token = crypto.randomBytes(24).toString('hex');
  all[token] = { accountId, exp: Date.now() + 30 * 24 * 3600 * 1000 };
  write(F.sessions, all);
  return token;
}
function getSession(token) {
  if (!token) return null;
  const all = read(F.sessions, {});
  const s = all[token];
  if (!s || s.exp < Date.now()) return null;
  return s;
}

// Drop expired sessions so the file can't grow without bound.
function pruneSessions() {
  const all = read(F.sessions, {});
  const now = Date.now();
  let changed = false;
  for (const [t, s] of Object.entries(all)) {
    if (!s || s.exp < now) { delete all[t]; changed = true; }
  }
  if (changed) write(F.sessions, all);
}

// ---------------- password reset tokens ----------------
function createResetToken(accountId) {
  const all = read(F.resets, {});
  const token = crypto.randomBytes(24).toString('hex');
  all[token] = { accountId, exp: Date.now() + 60 * 60 * 1000 }; // 1 hour
  write(F.resets, all);
  return token;
}
function useResetToken(token) {
  if (!token) return null;
  const all = read(F.resets, {});
  const r = all[token];
  if (!r || r.exp < Date.now()) return null;
  delete all[token];           // single use
  write(F.resets, all);
  return r.accountId;
}
// Drop expired reset tokens so the file can't grow without bound.
// (Requested-but-never-used tokens are the common case: useResetToken only
// deletes on a successful use, so an expired one otherwise sits forever.)
function pruneResets() {
  const all = read(F.resets, {});
  const now = Date.now();
  let changed = false;
  for (const [t, r] of Object.entries(all)) {
    if (!r || r.exp < now) { delete all[t]; changed = true; }
  }
  if (changed) write(F.resets, all);
}
// Sign out every device for an account (used after a password reset).
function destroyAllSessions(accountId) {
  const all = read(F.sessions, {});
  let changed = false;
  for (const [t, s] of Object.entries(all)) if (s && s.accountId === accountId) { delete all[t]; changed = true; }
  if (changed) write(F.sessions, all);
}
function destroySession(token) {
  const all = read(F.sessions, {});
  delete all[token];
  write(F.sessions, all);
}

// ---------------- suppression ----------------
// Addresses that must never be emailed again (unsubscribes, hard bounces,
// complaints, manual blocks). Account-scoped like everything else.
function getSuppression(accountId) {
  return read(F.suppression, []).filter((s) => s.accountId === accountId);
}
function addSuppression(accountId, rec) {
  const all = read(F.suppression, []);
  const existing = all.find((s) => s.accountId === accountId && s.email === rec.email);
  if (existing) {                       // keep the earliest record, upgrade the reason
    if (rec.wholeDomain && !existing.wholeDomain) { existing.wholeDomain = true; write(F.suppression, all); }
    return existing;
  }
  const row = { id: uid(), accountId, at: nowISO(), ...rec };
  all.push(row);
  write(F.suppression, all);
  return row;
}
function removeSuppression(accountId, email) {
  const all = read(F.suppression, []);
  const kept = all.filter((s) => !(s.accountId === accountId && s.email === email));
  if (kept.length === all.length) return false;
  write(F.suppression, kept);
  return true;
}

// ---------------- send audit log ----------------
// Append-only record of every message actually sent: who, when, what content,
// and who approved it. Never edited, never cascaded away by lead deletion —
// this is the evidence trail if a recipient ever disputes a message.
function logSend(accountId, rec) {
  const all = read(F.sendlog, []);
  all.push({ id: uid(), accountId, at: nowISO(), ...rec });
  write(F.sendlog, all);
}
function getSendLog(accountId, limit = 200) {
  return read(F.sendlog, []).filter((s) => s.accountId === accountId).slice(-limit).reverse();
}

// ---------------- voice calls ----------------
function saveCall(accountId, rec) {
  const all = read(F.calls, []);
  const i = all.findIndex((c) => c.accountId === accountId && c.sid === rec.sid);
  if (i === -1) all.push({ id: uid(), accountId, at: nowISO(), ...rec });
  else all[i] = { ...all[i], ...rec, updatedAt: nowISO() };
  write(F.calls, all.slice(-3000));
  return rec;
}
// Which account owns this call? Lets us bill minutes from the persisted record
// when the in-memory call is gone (e.g. a deploy landed mid-call).
function accountByCallSid(sid) {
  const c = read(F.calls, []).find((x) => x.sid === sid);
  return c ? getAccount(c.accountId) : null;
}
function getCalls(accountId, limit = 100) {
  return read(F.calls, []).filter((c) => c.accountId === accountId).slice(-limit).reverse();
}
// Which account owns an inbound number? Falls back to the single configured
// account so a one-tenant install works before any number mapping is set.
// Same canonical form the do-not-call list uses: bare 10-digit US numbers get
// their country code so "(312) 555-0202" and "+13125550202" cannot resolve to
// two different tenants — or, worse, to nobody, leaving a real caller told the
// line isn't set up.
function digitsOfNumber(v) {
  let d = String(v || '').replace(/[^0-9]/g, '');
  if (d.length === 10) d = '1' + d;
  return d;
}
// ---- per-business voice config ----
// The phone setup (number, script, toggles) lives ON THE PROFILE, so each
// business an account runs has its own line and its own receptionist. Accounts
// configured before this change still carry the old account-level `voice`;
// the resolver serves that legacy config for the business it was bound to
// (voice.profileId, else the first profile) until the first per-profile save
// writes profile.voice — after which profile.voice always wins.
function profileVoice(account, profile) {
  if (profile && profile.voice) return profile.voice;
  const legacy = (account && account.voice) || {};
  if (!profile) return legacy;
  const first = getProfiles(account.id)[0];
  const bound = legacy.profileId ? legacy.profileId === profile.id : (first && first.id === profile.id);
  return bound ? legacy : {};
}
/**
 * The ONLY writer of profile.voice. Seeds from the resolver so the first
 * per-profile save carries the legacy account-level config forward — writing
 * a partial patch cold would shadow the legacy number and silently kill the
 * line.
 */
function saveProfileVoice(accountId, profileId, patch) {
  const account = getAccount(accountId);
  const profile = getProfile(accountId, profileId);
  if (!account || !profile) return null;
  const cur = profileVoice(account, profile);
  const next = { ...cur, ...patch };
  delete next.profileId;   // the binding IS the profile now
  return updateProfile(accountId, profileId, { voice: next });
}
/**
 * Inbound routing: number -> which account AND which business. Per-profile
 * numbers first; falls back to the legacy account-level number for accounts
 * that have never saved since the per-business change.
 */
function routeByVoiceNumber(number) {
  const n = digitsOfNumber(number);
  if (!n) return null;
  const profs = read(F.profiles, []).filter((p) => p.voice && p.voice.number && digitsOfNumber(p.voice.number) === n);
  if (profs.length) {
    // Same double-buy caution as the account scan: with rival claims, the one
    // holding the purchase record (numberSid) owns the line; ambiguity routes
    // nowhere rather than to the wrong business.
    const pick = profs.length === 1 ? profs[0]
      : (profs.filter((p) => p.voice.numberSid).length === 1 ? profs.find((p) => p.voice.numberSid) : null);
    if (pick) {
      const a = getAccount(pick.accountId);
      if (a) return { account: a, profile: pick };
    }
    if (profs.length > 1) return null;
  }
  const a = accountByVoiceNumber(number);
  if (!a) return null;
  const profile = getProfile(a.id, (a.voice || {}).profileId) || getProfiles(a.id)[0] || null;
  return { account: a, profile };
}
function accountByVoiceNumber(number) {
  const all = read(F.accounts, []);
  const n = digitsOfNumber(number);
  if (!n) return null;
  // Every account now owns its own number, so the match is exact and there is
  // no fallback. The old "if only one account has voice, assume it's theirs"
  // rule silently handed tenant B's callers to tenant A the moment a second
  // customer switched voice on — a wrong-company greeting and a booking in
  // someone else's calendar. Answering the wrong business is worse than not
  // answering, so an unrecognised number resolves to nothing.
  const hits = all.filter((a) => a.voice && a.voice.number && digitsOfNumber(a.voice.number) === n);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Legacy data: before provisioning existed, saving the Voice tab stamped
    // the shared TWILIO_PHONE_NUMBER onto whoever opened it, so several old
    // accounts can hold the same number with no numberSid. An account that
    // actually BOUGHT this line (numberSid set) is the unambiguous owner.
    const bought = hits.filter((a) => a.voice.numberSid);
    if (bought.length === 1) return bought[0];
    if (!bought.length) {
      // Nobody bought it, so this is the server's own shared number. Route it
      // to the owner account rather than dropping a real caller: refusing here
      // would take the founder's live line down the moment this shipped.
      const owners = String(process.env.OWNER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      const ownerHit = hits.find((a) => owners.includes(String(a.email || '').toLowerCase()));
      if (ownerHit) {
        logActivity('system', { agent: 'VOICE', msg: `${hits.length} accounts hold the shared number ${number} — routed to owner. Provision per-customer numbers to clear this.` });
        return ownerHit;
      }
      // Still nobody identifiable, and this is the server's own number: fall
      // back to the earliest account, which is exactly what happened before
      // per-customer numbers existed. Not ideal, but reaching the wrong
      // in-house account beats a real caller hearing "this line isn't set up"
      // because an env var was missing.
      if (digitsOfNumber(process.env.TWILIO_PHONE_NUMBER || '') === n) {
        const oldest = hits.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
        if (oldest) {
          logActivity('system', { agent: 'VOICE', msg: `Shared number ${number} held by ${hits.length} accounts and no owner match — routed to the oldest. Set OWNER_EMAILS or provision real numbers.` });
          return oldest;
        }
      }
    }
    // Genuinely ambiguous between real customers: answering as the wrong
    // business is worse than not answering.
    logActivity('system', { agent: 'VOICE', msg: `CONFIG ERROR: ${hits.length} accounts claim ${number}` });
    return null;
  }
  return null;
}

// ---------------- appointments ----------------
// Every meeting the AI books, in one place, sorted by when it actually happens.
function addAppointment(accountId, rec) {
  const all = read(F.appointments, []);
  const row = { id: uid(), accountId, createdAt: nowISO(), status: 'booked', ...rec };
  all.push(row);
  write(F.appointments, all);
  return row;
}
function getAppointments(accountId) {
  return read(F.appointments, [])
    .filter((a) => a.accountId === accountId)
    .sort((a, b) => String(a.startsAt || a.createdAt).localeCompare(String(b.startsAt || b.createdAt)));
}
/**
 * Does a proposed booking overlap something already in the diary? Each booking
 * occupies [startsAt, startsAt + slotMinutes). Returns the clashing appointment
 * or null. Cancelled/done bookings do not block.
 */
function findConflict(accountId, startsAtISO, slotMinutes = 60) {
  const t0 = Date.parse(startsAtISO);
  if (isNaN(t0)) return null;
  const len = Math.max(15, Number(slotMinutes) || 60) * 60000;
  const t1 = t0 + len;
  return read(F.appointments, []).find((a) => {
    if (a.accountId !== accountId || !a.startsAt) return false;
    if (a.status === 'cancelled' || a.status === 'done') return false;
    const s = Date.parse(a.startsAt);
    if (isNaN(s)) return false;
    const e = s + len;
    return s < t1 && t0 < e;             // intervals overlap
  }) || null;
}
// ---------------- SMS threads ----------------
// One thread per (account, phone). A text conversation spans hours, so unlike a
// call it has to survive a restart. Capped per thread and overall.
function getThread(accountId, phone) {
  return read(F.smsThreads, []).find((t) => t.accountId === accountId && t.phone === phone) || null;
}
function saveThread(accountId, phone, turns, patch = {}) {
  const all = read(F.smsThreads, []);
  const i = all.findIndex((t) => t.accountId === accountId && t.phone === phone);
  const row = { ...(i === -1 ? { id: uid(), accountId, phone, createdAt: nowISO() } : all[i]), ...patch, turns: turns.slice(-40), updatedAt: nowISO() };
  if (i === -1) all.push(row); else all[i] = row;
  write(F.smsThreads, all.slice(-2000));
  return row;
}
function updateAppointment(accountId, id, patch) {
  const all = read(F.appointments, []);
  const i = all.findIndex((a) => a.id === id && a.accountId === accountId);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  write(F.appointments, all);
  return all[i];
}

// ---------------- profiles ----------------
function getProfiles(accountId) { return read(F.profiles, []).filter((p) => p.accountId === accountId); }
function allProfiles() { return read(F.profiles, []); } // scheduler needs a global view
function getProfile(accountId, id) { return getProfiles(accountId).find((p) => p.id === id) || null; }
function createProfile(accountId, data) {
  const all = read(F.profiles, []);
  const p = { id: uid(), accountId, createdAt: nowISO(), ...data };
  all.push(p);
  write(F.profiles, all);
  return p;
}
function updateProfile(accountId, id, patch) {
  const all = read(F.profiles, []);
  const i = all.findIndex((p) => p.id === id && p.accountId === accountId);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  write(F.profiles, all);
  return all[i];
}
function deleteProfile(accountId, id) {
  const all = read(F.profiles, []);
  const kept = all.filter((p) => !(p.id === id && p.accountId === accountId));
  if (kept.length === all.length) return false;
  write(F.profiles, kept);
  // cascade: drop this profile's leads + queue items
  write(F.leads, read(F.leads, []).filter((l) => !(l.accountId === accountId && l.profileId === id)));
  write(F.queue, read(F.queue, []).filter((q) => !(q.accountId === accountId && q.profileId === id)));
  return true;
}

// ---------------- leads ----------------
function getLeads(accountId, profileId) {
  return read(F.leads, []).filter((l) => l.accountId === accountId && (!profileId || l.profileId === profileId));
}
function addLeads(accountId, profileId, rows) {
  const all = read(F.leads, []);
  const existing = new Set(all.filter((l) => l.accountId === accountId && l.profileId === profileId).map((l) => (l.email || '').toLowerCase()));
  const added = [];
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (email && existing.has(email)) continue;
    if (email) existing.add(email);
    const lead = {
      id: uid(), accountId, profileId,
      name: (r.name || '').trim(), title: (r.title || '').trim(),
      company: (r.company || '').trim(), email: (r.email || '').trim(),
      phone: (r.phone || '').trim(),
      location: (r.location || '').trim(),
      emailConfidence: r.emailConfidence || '', emailSource: r.emailSource || '',
      notes: (r.notes || '').trim(), status: 'new', createdAt: nowISO(),
    };
    all.push(lead); added.push(lead);
  }
  write(F.leads, all);
  return added;
}
// One shared definition of "real email" for the whole pipeline: prospect's
// save filter, OUTBOUND's draft gate, the SMTP send block, and Clear-guesses
// all use THIS set so they can never drift apart again.
// verified = database/site confirmed · role/site = actually published by the
// company · imported = the user's own list (trusted).
const SENDABLE = new Set(['verified', 'role', 'site', 'imported']);
function isSendableLead(l) {
  return !!(l && l.email && SENDABLE.has((l.emailConfidence || '').toLowerCase()));
}

// Bulk-clear leads for a profile. mode 'all' wipes them; 'guesses' drops only
// leads WITHOUT a real email (the exact complement of what OUTBOUND drafts).
// Cascades to queued drafts for the removed leads — but never deletes 'sent'
// history, which is the record of who was actually emailed.
function clearLeads(accountId, profileId, mode = 'all') {
  const all = read(F.leads, []);
  const isGuess = (l) => !isSendableLead(l);
  const removed = [];
  const kept = all.filter((l) => {
    const mine = l.accountId === accountId && l.profileId === profileId;
    if (!mine) return true;
    const drop = mode === 'all' ? true : isGuess(l);
    if (drop) { removed.push(l); return false; }
    return true;
  });
  write(F.leads, kept);
  // cascade: drop queued drafts tied to removed leads (by leadId or email)
  const remIds = new Set(removed.map((l) => l.id));
  const remEmails = new Set(removed.map((l) => (l.email || '').toLowerCase()).filter(Boolean));
  write(F.queue, read(F.queue, []).filter((q) => {
    if (q.accountId !== accountId || q.profileId !== profileId) return true;
    if (q.status === 'sent') return true; // never destroy the record of who was emailed
    if (remIds.has(q.leadId)) return false;
    if (q.to && remEmails.has((q.to || '').toLowerCase())) return false;
    return true;
  }));
  return removed.length;
}
function updateLead(accountId, id, patch) {
  const all = read(F.leads, []);
  const i = all.findIndex((l) => l.id === id && l.accountId === accountId);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  write(F.leads, all);
  return all[i];
}

// ---------------- queue ----------------
// ---- generic collections ----
// Small named stores that do not need bespoke accessors. Reads are cheap
// (JSON file, small files) and every write goes through the same path.
function readCollection(name) { return read(F[name], []); }
function pushCollection(name, rec) {
  const all = read(F[name], []);
  all.push(rec);
  write(F[name], all);
  return rec;
}
function patchCollection(name, id, patch) {
  const all = read(F[name], []);
  const i = all.findIndex((r) => r.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  write(F[name], all);
  return all[i];
}

// ---- callback requests (consented inbound leads) ----
function addCallback(accountId, rec) {
  const all = read(F.callbacks, []);
  const row = { id: uid(), accountId, at: nowISO(), status: 'new', ...rec };
  all.push(row);
  write(F.callbacks, all);
  return row;
}
function getCallbacks(accountId, limit = 200) {
  return read(F.callbacks, []).filter((c) => c.accountId === accountId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
function updateCallback(accountId, id, patch) {
  const all = read(F.callbacks, []);
  const i = all.findIndex((c) => c.id === id && c.accountId === accountId);
  if (i < 0) return null;
  // Consent evidence is WRITE-ONCE: it can be set on a record that has none
  // (a missed-call offer that gets a YES), and never changed after that. The
  // wording, timestamp and IP a person consented under are the evidence; an
  // editable field is not evidence.
  const cur = all[i];
  const { at, accountId: _a, id: _i, ...rest } = patch || {};
  const safe = { ...rest };
  for (const k of ['consent', 'consentText', 'consentAt', 'consentIp', 'consentUa', 'consentVia']) {
    if (k in safe && cur.consentAt) delete safe[k];   // already consented: locked
  }
  all[i] = { ...cur, ...safe };
  write(F.callbacks, all);
  return all[i];
}

function getQueue(accountId, profileId) {
  return read(F.queue, []).filter((q) => q.accountId === accountId && (!profileId || q.profileId === profileId));
}
function addToQueue(accountId, item) {
  const all = read(F.queue, []);
  const rec = { id: uid(), accountId, status: 'pending', createdAt: nowISO(), ...item };
  all.push(rec);
  write(F.queue, all);
  return rec;
}
function updateQueueItem(accountId, id, patch) {
  const all = read(F.queue, []);
  const i = all.findIndex((q) => q.id === id && q.accountId === accountId);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  write(F.queue, all);
  return all[i];
}

// ---------------- activity ----------------
// Cap per ACCOUNT, not globally — a global cap meant one busy tenant silently
// deleted every other tenant's history.
function capPerAccount(rows, perAccount = 500) {
  // The log is newest-first (logActivity unshifts), so walk FORWARD and keep the
  // first N per account — i.e. the most recent N. Walking backwards would have
  // kept the oldest and silently dropped everything new.
  const seen = new Map();
  const kept = [];
  for (const r of rows) {
    const n = (seen.get(r.accountId) || 0) + 1;
    if (n > perAccount) continue;
    seen.set(r.accountId, n);
    kept.push(r);
  }
  return kept;
}
function logActivity(accountId, entry) {
  const all = read(F.activity, []);
  all.unshift({ id: uid(), accountId, at: nowISO(), ...entry });
  write(F.activity, capPerAccount(all));
}
function getActivity(accountId, limit = 40) {
  return read(F.activity, []).filter((a) => a.accountId === accountId).slice(0, limit);
}

module.exports = {
  readCollection, pushCollection, patchCollection,
  addCallback, getCallbacks, updateCallback,
  DATA, uid, nowISO, today,
  getAccountByEmail, getAccount, allAccounts, createAccount, updateAccount, accountByStripeCustomer,
  createSession, getSession, destroySession, pruneSessions,
  createResetToken, useResetToken, pruneResets,
  getProfiles, allProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getLeads, addLeads, updateLead, clearLeads, SENDABLE, isSendableLead,
  getSuppression, addSuppression, removeSuppression, logSend, getSendLog,
  saveCall, getCalls, accountByVoiceNumber, accountByCallSid, destroyAllSessions,
  profileVoice, saveProfileVoice, routeByVoiceNumber,
  addAppointment, getAppointments, updateAppointment, findConflict, getThread, saveThread,
  getQueue, addToQueue, updateQueueItem,
  logActivity, getActivity,
};
