// Verified email finding via Hunter.io — the real fix for guessed addresses.
//
// Scale model: BRING-YOUR-OWN-KEY. Each account can store its own Hunter API key
// (their usage bills their Hunter account), with the owner's HUNTER_API_KEY env
// var as an optional shared fallback. This is what lets thousands of users run
// without draining one shared data account.
//
// Fails soft everywhere: no key / no result / API error => the lead keeps its
// existing (labelled) email, prospecting never breaks.
require('./env');

function keyFor(account) {
  return (account && account.emailApiKey) || process.env.HUNTER_API_KEY || '';
}
function enabled(account) { return !!keyFor(account); }

function domainOf(website, email) {
  if (website) { try { return new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website).hostname.replace(/^www\./, ''); } catch {} }
  if (email && email.includes('@')) return email.split('@')[1];
  return '';
}

async function hunterGet(path, params, key) {
  const qs = new URLSearchParams({ ...params, api_key: key });
  const r = await fetch(`https://api.hunter.io/v2/${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err0 = (data.errors && data.errors[0]) || {};
    const msg = err0.details || `Hunter ${r.status}`;
    const e = new Error(msg); e.status = r.status;
    // Out of monthly searches/verifications — MUST be surfaced, never swallowed:
    // a silently-exhausted quota is exactly how "it's still guessing" happens.
    // Match on Hunter's structured error id, and NEVER treat a 400 (bad
    // parameter, e.g. free-plan pagination) as an exhausted quota — that would
    // kill the whole run over a request we can simply fix.
    e.quota = r.status === 429 || err0.id === 'usage_limit_reached'
      || (r.status !== 400 && /exceed|quota|usage|upgrade/i.test(msg));
    throw e;
  }
  return data.data || {};
}

// Re-throw errors the caller must see (bad key, quota); soften the rest to null.
function softFail(e) {
  if (e.status === 401) { const err = new Error('Your Hunter.io API key is invalid.'); err.fatal = true; throw err; }
  if (e.quota) { const err = new Error('Hunter monthly quota is used up — no more lookups until it resets (or upgrade your Hunter plan).'); err.quota = true; throw err; }
  return null; // genuine no-result: fail soft
}

// Current plan usage for the settings UI ("why am I getting guesses?" answer).
async function accountStatus(account) {
  const key = keyFor(account);
  if (!key) return null;
  try {
    const d = await hunterGet('account', {}, key);
    const req = d.requests || {};
    return {
      plan: d.plan_name || 'unknown',
      resetDate: d.reset_date || '',
      searches: { used: (req.searches || {}).used ?? 0, available: (req.searches || {}).available ?? 0 },
      verifications: { used: (req.verifications || {}).used ?? 0, available: (req.verifications || {}).available ?? 0 },
    };
  } catch { return null; }
}

// Find a person's verified email by name + company domain.
async function findEmail(account, { name, website, email }) {
  const key = keyFor(account);
  const domain = domainOf(website, email);
  if (!key || !domain) return null;
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length < 2) return null; // Hunter needs first+last
  try {
    const d = await hunterGet('email-finder', {
      domain, first_name: parts[0], last_name: parts[parts.length - 1],
    }, key);
    if (!d.email) return null;
    // score: 0-100 confidence from Hunter's verification data
    const score = Number(d.score || 0);
    return {
      email: d.email,
      confidence: score >= 80 ? 'verified' : score >= 50 ? 'site' : null, // <50: not worth trusting
      source: `Hunter (score ${score})`,
    };
  } catch (e) { return softFail(e); }
}

// When we only know the COMPANY (no real person name — the AI returned a title
// like "Plant Manager"), ask Hunter for the real people at that domain and pick
// the best decision-maker. This is what rescues the generic-title leads.
async function domainSearch(account, { website, email }) {
  const key = keyFor(account);
  const domain = domainOf(website, email);
  if (!key || !domain) return null;
  try {
    const d = await hunterGet('domain-search', { domain, limit: 10 }, key);
    const emails = (d.emails || []).filter((e) => e.value);
    if (!emails.length) return null;
    // Prefer a real named person in a senior/ops seniority, highest confidence.
    const OPS = /owner|president|founder|principal|ceo|coo|operations|plant|facilit|maintenance|engineer|general manager|gm|vp|director/i;
    const named = emails.filter((e) => e.first_name && e.last_name && e.type === 'personal');
    const pick = named.sort((a, b) => {
      const sa = (OPS.test(`${a.position || ''}`) ? 100 : 0) + Number(a.confidence || 0);
      const sb = (OPS.test(`${b.position || ''}`) ? 100 : 0) + Number(b.confidence || 0);
      return sb - sa;
    })[0];
    if (pick) {
      const score = Number(pick.confidence || 0);
      return {
        name: `${pick.first_name} ${pick.last_name}`,
        title: pick.position || '',
        email: pick.value,
        confidence: score >= 80 ? 'verified' : 'site',
        source: `Hunter domain-search (score ${score})`,
      };
    }
    // No named person, but a real generic inbox exists (info@/contact@) — real,
    // monitored, and it WON'T bounce like a fake personal guess.
    const generic = emails.find((e) => e.type === 'generic');
    if (generic) return { email: generic.value, confidence: 'role', source: 'Hunter: company inbox (real)' };
    return null;
  } catch (e) { return softFail(e); }
}

// Verify an existing address (used for role inboxes and site-found emails).
async function verifyEmail(account, email) {
  const key = keyFor(account);
  if (!key || !email) return null;
  try {
    const d = await hunterGet('email-verifier', { email }, key);
    // status: valid | accept_all | webmail | disposable | invalid | unknown
    if (d.status === 'valid') return { confidence: 'verified', source: 'Hunter-verified' };
    if (d.status === 'invalid' || d.status === 'disposable') return { confidence: 'invalid', source: `Hunter: ${d.status}` };
    return null; // accept_all / unknown: keep existing label
  } catch (e) { return softFail(e); }
}

// Quick key check for the settings UI.
async function testKey(key) {
  try {
    await hunterGet('account', {}, key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { enabled, findEmail, domainSearch, verifyEmail, testKey, accountStatus };
