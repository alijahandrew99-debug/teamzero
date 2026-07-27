// FREE email finding + validation. No paid API, no keys.
//
// Why this exists: pattern-guessed emails (first@domain) bounce most of the time,
// which burns your sending domain's reputation. This module instead:
//   1. checks the domain can actually receive mail (MX records),
//   2. fetches the company's public contact/about/team pages and extracts REAL
//      published addresses,
//   3. prefers an address matching the person's name, then a role inbox,
//   4. only falls back to a pattern guess as a clearly-labelled last resort.
// Every result carries a confidence so the UI can stop you sending to guesses.
const dns = require('dns').promises;

const PAGES = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us', '/team', '/our-team', '/leadership', '/staff', '/company/contact'];
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ROLE_PREFIXES = ['info', 'sales', 'contact', 'hello', 'inquiries', 'admin', 'office', 'general', 'mail'];
// junk that shows up in page source but is never a real contact address
const JUNK = /(\.(png|jpe?g|gif|svg|webp|css|js)$)|(^(noreply|no-reply|donotreply|postmaster|abuse|webmaster)@)|(@(example|sentry|wixpress|godaddy|squarespace|shopify|sentry\.io|w3\.org|schema\.org|googlemail\.com\.|domain)\.)/i;

function normDomain(website, email) {
  let d = '';
  if (website) {
    try { d = new URL(website.startsWith('http') ? website : 'https://' + website).hostname; } catch {}
  }
  if (!d && email && email.includes('@')) d = email.split('@')[1];
  return (d || '').replace(/^www\./, '').toLowerCase();
}

// Tri-state on purpose: 'yes' | 'no' | 'unknown'. A DNS outage (ECONNREFUSED,
// timeout, SERVFAIL) is NOT proof the domain is dead — only NXDOMAIN/ENODATA is.
// Treating "unknown" as "no" would wrongly junk every lead on a restricted network.
async function hasMX(domain) {
  if (!domain) return 'no';
  try {
    const r = await dns.resolveMx(domain);
    return Array.isArray(r) && r.length > 0 ? 'yes' : 'no';
  } catch (e) {
    const definitive = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'];
    return definitive.includes(e.code) ? 'no' : 'unknown';
  }
}

async function fetchText(url, timeoutMs = 7000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Dawnpipe/1.0; +contact-lookup)' },
    });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!/text|html/i.test(ct)) return '';
    const buf = await r.arrayBuffer();
    return Buffer.from(buf.slice(0, 400_000)).toString('utf8'); // cap size
  } catch { return ''; }
}

function extractEmails(text, domain) {
  const out = new Set();
  for (const raw of (text.match(EMAIL_RE) || [])) {
    const e = raw.toLowerCase().replace(/\.$/, '');
    if (JUNK.test(e)) continue;
    if (e.length > 80) continue;
    // keep only addresses on the company's own domain (or subdomain)
    const d = e.split('@')[1];
    if (domain && !(d === domain || d.endsWith('.' + domain))) continue;
    out.add(e);
  }
  return [...out];
}

// Scrape the company's public pages for real addresses.
async function harvest(domain) {
  if (!domain) return [];
  const found = new Set();
  const urls = PAGES.map((p) => `https://${domain}${p}`);
  // fetch a few pages concurrently; plain HTTP so parallel is safe
  const chunks = await Promise.all(urls.slice(0, 7).map((u) => fetchText(u)));
  for (const html of chunks) for (const e of extractEmails(html, domain)) found.add(e);
  return [...found];
}

function nameParts(full) {
  const p = (full || '').toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/);
  return { first: p[0] || '', last: p.length > 1 ? p[p.length - 1] : '' };
}

function patternGuess(full, domain) {
  const { first, last } = nameParts(full);
  if (!domain || !first) return '';
  if (last) return `${first}.${last}@${domain}`;
  return `${first}@${domain}`;
}

// Pick the best address for this person from what we harvested.
function pick(emails, personName) {
  const { first, last } = nameParts(personName);
  const local = (e) => e.split('@')[0].toLowerCase();
  // 1. personal match — local part contains their first or last name
  const personal = emails.find((e) => {
    const l = local(e);
    return (first && first.length > 2 && l.includes(first)) || (last && last.length > 2 && l.includes(last));
  });
  if (personal) return { email: personal, confidence: 'verified', source: 'published on their site' };
  // 2. role inbox on the right domain — real and monitored, just less targeted
  const role = emails.find((e) => ROLE_PREFIXES.includes(local(e).split(/[._-]/)[0]));
  if (role) return { email: role, confidence: 'role', source: 'company contact inbox' };
  // 3. any real published address beats a guess — but it may belong to someone
  // else at the company, so say so plainly; the human approves before sending.
  if (emails.length) return { email: emails[0], confidence: 'site', source: 'published on their site — may be a different contact, verify recipient' };
  return null;
}

/**
 * Resolve the best deliverable email for one lead.
 * @returns {email, confidence: 'verified'|'role'|'site'|'pattern'|'invalid', source}
 */
async function resolveEmail({ name, website, email }) {
  const domain = normDomain(website, email);
  if (!domain) return { email: email || '', confidence: 'invalid', source: 'no website/domain' };

  // Only bail when DNS definitively says the domain can't receive mail.
  if ((await hasMX(domain)) === 'no') {
    return { email: email || '', confidence: 'invalid', source: 'domain cannot receive mail' };
  }

  const harvested = await harvest(domain);
  const best = pick(harvested, name);
  if (best) return best;

  // last resort: a labelled guess (UI warns before you send)
  const guess = patternGuess(name, domain) || email || '';
  return { email: guess, confidence: 'pattern', source: 'guessed pattern — unverified' };
}

// Resolve many leads in parallel (plain HTTP, safe to fan out).
async function resolveMany(leads, concurrency = 6) {
  const out = [];
  for (let i = 0; i < leads.length; i += concurrency) {
    const slice = leads.slice(i, i + concurrency);
    out.push(...await Promise.all(slice.map((l) => resolveEmail(l).catch(() => ({ email: l.email || '', confidence: 'pattern', source: 'lookup failed' })))));
  }
  return out;
}

module.exports = { resolveEmail, resolveMany, hasMX, harvest, normDomain };
