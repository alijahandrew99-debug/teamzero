// What the AI actually did for this business — the numbers that answer "why am
// I paying for this?" One function feeds both the in-app dashboard and the
// monthly recap email, so they can never disagree with each other.
//
// A $399/mo line item with no visible ROI gets cancelled at the first slow
// month. Every competitor shows this; Dawnpipe showed a raw call list.
const db = require('./db');

function inRange(iso, from, to) {
  const t = Date.parse(iso || '');
  return !isNaN(t) && t >= from && t < to;
}

/** Local hour of a timestamp in a zone (for after-hours share). */
function localHour(iso, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date(iso));
    const h = Number((parts.find((p) => p.type === 'hour') || {}).value);
    const wd = (parts.find((p) => p.type === 'weekday') || {}).value;
    return { hour: h % 24, weekend: wd === 'Sat' || wd === 'Sun' };
  } catch { return { hour: 12, weekend: false }; }
}

/**
 * Compute the story for one account over [from, to).
 * @param {object} account
 * @param {number} from  ms epoch
 * @param {number} to    ms epoch
 * @param {string} tz    business time zone
 */
function forRange(account, from, to, tz = 'America/Chicago') {
  const calls = db.getCalls(account.id, 5000).filter((c) => inRange(c.at, from, to));
  const inbound = calls.filter((c) => c.direction !== 'outbound');
  const answered = inbound.filter((c) => (c.transcript || []).some((t) => t.who !== 'caller'));
  const booked = calls.filter((c) => c.outcome === 'booked' || c.outcome === 'callback');
  const transferred = calls.filter((c) => c.outcome === 'transferred');
  const messages = calls.filter((c) => c.outcome === 'callback');
  const minutes = calls.reduce((n, c) => n + Math.ceil((Number(c.durationSec) || 0) / 60), 0);

  // "After hours" = before 8am, after 6pm, or weekend, in THEIR zone. This is
  // the number that justifies the whole product: calls that would have gone
  // to voicemail because nobody was at a desk.
  const afterHours = inbound.filter((c) => {
    const { hour, weekend } = localHour(c.at, tz);
    return weekend || hour < 8 || hour >= 18;
  });

  const appts = db.getAppointments(account.id).filter((a) => inRange(a.createdAt, from, to) && a.status !== 'cancelled');
  const emergencies = calls.filter((c) => c.urgency === 'emergency');

  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), tz,
    calls: calls.length,
    inbound: inbound.length,
    answered: answered.length,
    afterHours: afterHours.length,
    booked: appts.length,
    transferred: transferred.length,
    messages: messages.length,
    emergencies: emergencies.length,
    minutes,
    // Top reasons, from booking reasons — what people actually call about.
    topReasons: Object.entries(appts.reduce((m, a) => { const k = String(a.reason || '').toLowerCase().trim(); if (k) m[k] = (m[k] || 0) + 1; return m; }, {}))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, n]) => ({ reason, n })),
  };
}

/** This calendar month so far, previous full month, and last 7 days. */
function summary(account, tz) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const weekAgo = now.getTime() - 7 * 86400000;
  return {
    thisMonth: forRange(account, monthStart, now.getTime(), tz),
    lastMonth: forRange(account, prevStart, monthStart, tz),
    last7: forRange(account, weekAgo, now.getTime(), tz),
  };
}

/** Plain-text recap email body for a completed month. */
function recapEmail(account, profileName, s, planPrice) {
  const line = (n, label) => `  ${String(n).padStart(4)}  ${label}`;
  const est = s.booked * 400; // conservative average job; the owner knows their real number
  return [
    `Here's what your AI receptionist did for ${profileName} last month.`,
    ``,
    line(s.calls, 'calls handled'),
    line(s.afterHours, 'of them outside business hours — nights, early mornings, weekends'),
    line(s.booked, 'jobs booked or callbacks captured'),
    line(s.transferred, 'put straight through to you or your team'),
    line(s.emergencies, 'flagged as emergencies and escalated'),
    line(s.minutes, 'minutes on the phone'),
    ``,
    s.booked
      ? `If those ${s.booked} bookings are worth even $400 each, that's roughly $${est.toLocaleString()} of work that would otherwise have gone to voicemail${planPrice ? ` — against $${planPrice} for the month` : ''}.`
      : `No bookings this month. If that doesn't match what you're seeing, reply to this email and we'll look at it together.`,
    ``,
    s.topReasons.length ? `What people called about most:\n${s.topReasons.map((r) => `  - ${r.reason} (${r.n})`).join('\n')}\n` : '',
    `Every call is transcribed and waiting for you in the app.`,
    ``,
    `— Dawnpipe`,
  ].filter((x) => x !== '').join('\n');
}

module.exports = { forRange, summary, recapEmail };
