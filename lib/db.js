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
function createAccount({ email, passHash, salt }) {
  const all = read(F.accounts, []);
  const acc = {
    id: uid(), email: email.toLowerCase(), passHash, salt,
    plan: 'none', subStatus: 'inactive', stripeCustomerId: null,
    createdAt: nowISO(),
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
function logActivity(accountId, entry) {
  const all = read(F.activity, []);
  all.unshift({ id: uid(), accountId, at: nowISO(), ...entry });
  write(F.activity, all.slice(0, 2000));
}
function getActivity(accountId, limit = 40) {
  return read(F.activity, []).filter((a) => a.accountId === accountId).slice(0, limit);
}

module.exports = {
  DATA, uid, nowISO, today,
  getAccountByEmail, getAccount, createAccount, updateAccount, accountByStripeCustomer,
  createSession, getSession, destroySession, pruneSessions,
  createResetToken, useResetToken,
  getProfiles, allProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getLeads, addLeads, updateLead, clearLeads, SENDABLE, isSendableLead,
  getSuppression, addSuppression, removeSuppression, logSend, getSendLog,
  getQueue, addToQueue, updateQueueItem,
  logActivity, getActivity,
};
