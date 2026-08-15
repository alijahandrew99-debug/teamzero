// Lead memory — what turns one-shot outreach into an actual sales rep.
//
// A good rep remembers: who they spoke to, what was said, what the objection
// was, how warm they are, and when to come back. Without that you get one email
// per lead and no second chance — and most closed deals come from touch 2, 3
// or 4, not touch 1.
//
// Every interaction on ANY channel (email sent, call made, reply logged, call
// answered) writes into the same lead record, so the voice agent knows what the
// email said and the follow-up knows what happened on the phone.
require('./env');
const db = require('./db');

// ---------------- temperature ----------------
// Deliberately few stages. More stages = a CRM nobody updates.
const STAGES = {
  new:       { id: 'new',       label: 'Not contacted', rank: 0, active: true,  color: 'new' },
  contacted: { id: 'contacted', label: 'Contacted',     rank: 1, active: true,  color: 'drafted' },
  warm:      { id: 'warm',      label: 'Warm',          rank: 2, active: true,  color: 'drafted' },
  hot:       { id: 'hot',       label: 'Hot',           rank: 3, active: true,  color: 'approved' },
  customer:  { id: 'customer',  label: 'Customer',      rank: 4, active: false, color: 'approved' },
  lost:      { id: 'lost',      label: 'Not interested',rank: -1, active: false, color: 'sent' },
  dnc:       { id: 'dnc',       label: 'Do not contact',rank: -2, active: false, color: 'invalid' },
};
const STAGE_ORDER = ['new', 'contacted', 'warm', 'hot', 'customer', 'lost', 'dnc'];
function stageOf(lead) { return STAGES[(lead && lead.stage) || 'new'] ? (lead.stage || 'new') : 'new'; }
function isWorkable(lead) {
  const s = STAGES[stageOf(lead)];
  return !!(s && s.active);
}

// ---------------- the cadence ----------------
// What a good rep actually does: come back a few times, with a NEW angle each
// time, then close the file politely. Never "just bumping this to the top of
// your inbox" — that's the line that gets people marked as spam.
const CADENCE = [
  { touch: 1, afterDays: 0,  angle: 'the opening email — one specific reason you are contacting THIS company' },
  { touch: 2, afterDays: 3,  angle: 'a different angle entirely. Do NOT reference the first email or say "following up". Lead with a concrete, useful observation about their business or industry — something they would find worth reading even if they never buy.' },
  { touch: 3, afterDays: 7,  angle: 'proof. One short, specific result from a comparable business — numbers if you have them. Make the outcome concrete and easy to picture.' },
  { touch: 4, afterDays: 14, angle: 'the polite close-out. Acknowledge they are busy, say you will stop reaching out, and leave one clear way back. No guilt, no "final notice", no pressure. This one gets more replies than any other, because it is genuinely the last.' },
];
const MAX_TOUCHES = CADENCE.length;

function nextStep(lead) {
  const n = Number(lead.touchCount || 0);
  return CADENCE[n] || null;      // null = sequence finished
}

/** When is this lead next due, given how many touches it has had? */
function dueDate(lead, from = Date.now()) {
  const step = nextStep(lead);
  if (!step) return null;
  return new Date(from + step.afterDays * 86400000).toISOString();
}

/** Leads that are due for their next touch right now. */
function dueNow(accountId, profileId, now = Date.now()) {
  return db.getLeads(accountId, profileId).filter((l) => {
    if (!isWorkable(l)) return false;                       // sold, lost, dnc: leave alone
    if (Number(l.touchCount || 0) >= MAX_TOUCHES) return false;
    if (!l.nextTouchAt) return false;                       // never started
    return new Date(l.nextTouchAt).getTime() <= now;
  });
}

// ---------------- memory ----------------
/**
 * Record something that happened with this lead, on any channel.
 * kind: email-sent | email-replied | call-made | call-answered | call-booked | note | stage
 */
function remember(accountId, lead, { kind, channel = 'email', summary = '', detail = '', stage, facts = [] } = {}) {
  const touches = Array.isArray(lead.touches) ? lead.touches.slice(-30) : [];
  touches.push({ at: new Date().toISOString(), kind, channel, summary, detail: String(detail || '').slice(0, 600) });

  const memory = Array.isArray(lead.memory) ? lead.memory.slice(-20) : [];
  for (const f of facts) if (f && !memory.includes(f)) memory.push(String(f).slice(0, 200));

  const patch = { touches, memory };
  if (stage && STAGES[stage]) patch.stage = stage;
  // an outbound touch advances the counter and schedules the next one
  if (kind === 'email-sent' || kind === 'call-made') {
    patch.touchCount = Number(lead.touchCount || 0) + 1;
    patch.lastTouchAt = new Date().toISOString();
    if (!stage && stageOf(lead) === 'new') patch.stage = 'contacted';
    const nd = dueDate({ ...lead, touchCount: patch.touchCount });
    patch.nextTouchAt = nd || '';
  }
  // anything that came FROM them is a signal — warm at minimum
  if (kind === 'email-replied' || kind === 'call-answered') {
    if (STAGES[stageOf(lead)].rank < STAGES.warm.rank) patch.stage = stage || 'warm';
    patch.nextTouchAt = '';        // a human is in the conversation now; stop the drip
  }
  if (kind === 'call-booked') { patch.stage = stage || 'hot'; patch.nextTouchAt = ''; }
  return db.updateLead(accountId, lead.id, patch);
}

/** Everything the AI should know about this person before it writes or speaks. */
function briefFor(lead) {
  if (!lead) return '';
  const bits = [];
  const s = STAGES[stageOf(lead)];
  bits.push(`Where they stand: ${s.label}${lead.touchCount ? ` · ${lead.touchCount} previous touch(es)` : ' · never contacted'}`);
  if (Array.isArray(lead.memory) && lead.memory.length) {
    bits.push(`What we know about them:\n${lead.memory.map((m) => `  - ${m}`).join('\n')}`);
  }
  const t = Array.isArray(lead.touches) ? lead.touches.slice(-6) : [];
  if (t.length) {
    bits.push(`History (most recent last):\n${t.map((x) => `  - ${String(x.at).slice(0, 10)} ${x.kind}: ${x.summary || ''}`).join('\n')}`);
  }
  return bits.join('\n');
}

/** Start the clock on a brand-new lead so it enters the cadence. */
function enrol(accountId, lead) {
  if (lead.nextTouchAt || Number(lead.touchCount || 0) > 0) return lead;
  return db.updateLead(accountId, lead.id, { stage: lead.stage || 'new', touchCount: 0, nextTouchAt: new Date().toISOString() });
}

/** Pipeline counts for the dashboard. */
function pipeline(accountId, profileId) {
  const leads = db.getLeads(accountId, profileId);
  const out = {};
  for (const k of STAGE_ORDER) out[k] = 0;
  for (const l of leads) out[stageOf(l)] = (out[stageOf(l)] || 0) + 1;
  out.total = leads.length;
  out.dueNow = dueNow(accountId, profileId).length;
  return out;
}

module.exports = {
  STAGES, STAGE_ORDER, CADENCE, MAX_TOUCHES,
  stageOf, isWorkable, nextStep, dueDate, dueNow,
  remember, briefFor, enrol, pipeline,
};
