// Sending discipline: domain warmup, randomised pacing, and recipient business
// hours. These are the habits that separate mail that lands from mail that gets
// filtered — a brand-new domain that suddenly sends 50 identical emails at
// 25-second intervals at 3am looks exactly like a spam cannon.
//
// Zero dependencies. Timezones use the built-in Intl API (accurate, DST-aware).
require('./env');

// ---------------- warmup ----------------
// A new sending domain has no reputation. Start small, grow ~30%/day, cap out.
const WARMUP_START = 10;      // day 1 allowance
const WARMUP_GROWTH = 1.3;    // +30% per day
const WARMUP_CEILING = 40;    // default ceiling; configurable per account

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function daysBetween(fromStr, toStr) {
  const a = Date.parse(`${fromStr}T00:00:00Z`), b = Date.parse(`${toStr}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** Today's warmup allowance for a domain that started warming on startDate. */
function warmupAllowance(warmup, today = todayStr()) {
  if (!warmup || !warmup.enabled) return Infinity;
  const ceiling = Math.max(1, Number(warmup.ceiling) || WARMUP_CEILING);
  const day = daysBetween(warmup.startDate || today, today); // 0 on day one
  const allowed = Math.round(WARMUP_START * Math.pow(WARMUP_GROWTH, day));
  return Math.min(ceiling, Math.max(1, allowed));
}

/** Warmup state for display: which day, today's cap, and when it maxes out. */
function warmupStatus(warmup, today = todayStr()) {
  if (!warmup || !warmup.enabled) return { enabled: false };
  const ceiling = Math.max(1, Number(warmup.ceiling) || WARMUP_CEILING);
  const day = daysBetween(warmup.startDate || today, today) + 1; // human-friendly day 1
  const allowance = warmupAllowance(warmup, today);
  // days until the ramp reaches the ceiling
  const daysToFull = Math.max(0, Math.ceil(Math.log(ceiling / WARMUP_START) / Math.log(WARMUP_GROWTH)) - (day - 1));
  return { enabled: true, domain: warmup.domain || '', day, allowance, ceiling,
    atCeiling: allowance >= ceiling, daysToFull, startDate: warmup.startDate };
}

/** Fresh warmup state — called when a sending domain is first connected/changed. */
function startWarmup(domain, ceiling = WARMUP_CEILING) {
  return { enabled: true, domain: (domain || '').toLowerCase(), startDate: todayStr(), ceiling: Math.max(1, Number(ceiling) || WARMUP_CEILING) };
}

// ---------------- pacing ----------------
// Fixed intervals are a machine fingerprint. Randomise between 3 and 8 minutes
// so the pattern looks like a person working through their morning.
const PACE_MIN_SEC = 3 * 60;
const PACE_MAX_SEC = 8 * 60;
function nextDelayMs(minSec = PACE_MIN_SEC, maxSec = PACE_MAX_SEC) {
  const lo = Math.max(0, Number(minSec) || 0);
  const hi = Math.max(lo, Number(maxSec) || lo);
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

// ---------------- recipient business hours ----------------
// We only know a recipient's timezone when research captured a US location.
// Where we know it, send 8am-5pm on weekdays in THEIR time. Where we don't,
// fall back to the sender's own working hours.
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise',
  IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago',
  KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles',
  NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago',
  OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver', DC: 'America/New_York',
};
const STATE_NAMES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
  'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
  'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA',
  'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT',
  'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
  'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
};

/** Best-effort IANA timezone for a lead, from its stored location text. */
function timezoneForLead(lead) {
  const text = `${(lead && lead.location) || ''} ${(lead && lead.notes) || ''}`;
  if (!text.trim()) return null;
  // "loc:Elgin, IL" / "Chicago, Illinois"
  const abbr = text.match(/\b([A-Z]{2})\b(?!\w)/g) || [];
  for (const a of abbr) if (STATE_TZ[a]) return STATE_TZ[a];
  const lower = text.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (lower.includes(name)) return STATE_TZ[code];
  }
  return null;
}

/** Local hour + weekday in a timezone, via Intl (DST-correct). */
function localParts(tz, now = new Date()) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short' });
    const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
    const hour = Number(parts.hour);
    const wd = String(parts.weekday || '').toLowerCase();
    return { hour: Number.isFinite(hour) ? hour % 24 : null, weekend: wd === 'sat' || wd === 'sun' };
  } catch { return { hour: null, weekend: false }; }
}

/**
 * Should we send to this lead right now?
 * Returns { ok, reason, tz } — ok:false means hold it for a later run.
 */
function withinBusinessHours(lead, { startHour = 8, endHour = 17, weekdaysOnly = true, senderTz = '' } = {}, now = new Date()) {
  const tz = timezoneForLead(lead) || senderTz || '';
  if (!tz) return { ok: true, reason: 'timezone unknown — not held', tz: '' };
  const { hour, weekend } = localParts(tz, now);
  if (hour === null) return { ok: true, reason: 'timezone unreadable — not held', tz };
  if (weekdaysOnly && weekend) return { ok: false, reason: `it's the weekend for them (${tz})`, tz };
  if (hour < startHour || hour >= endHour) {
    return { ok: false, reason: `it's ${hour}:00 for them (${tz}) — outside ${startHour}:00-${endHour}:00`, tz };
  }
  return { ok: true, reason: `${hour}:00 local (${tz})`, tz };
}

module.exports = {
  warmupAllowance, warmupStatus, startWarmup, todayStr,
  nextDelayMs, PACE_MIN_SEC, PACE_MAX_SEC,
  withinBusinessHours, timezoneForLead,
  WARMUP_START, WARMUP_GROWTH, WARMUP_CEILING,
};
