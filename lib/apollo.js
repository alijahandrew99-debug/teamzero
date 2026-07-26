// Optional Apollo enrichment — turns PROSPECTOR's pattern-guessed emails into
// verified ones. Activates only when APOLLO_API_KEY is set; otherwise it's a
// no-op and the pattern email is kept. Fails soft: any Apollo error leaves the
// original lead untouched, so prospecting never breaks because of enrichment.
require('./env');

function enabled() { return !!process.env.APOLLO_API_KEY; }

function domainFrom(website, email) {
  if (website) { try { return new URL(website.startsWith('http') ? website : 'https://' + website).hostname.replace(/^www\./, ''); } catch {} }
  if (email && email.includes('@')) return email.split('@')[1];
  return '';
}
function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

// leads: [{name, company, email, website?}] -> same array with verified emails
// where Apollo found them. Chunks into the endpoint's 10-per-call limit.
async function enrichLeads(leads) {
  if (!enabled() || !leads.length) return leads;
  if (leads.length > 10) {
    const out = [];
    for (let i = 0; i < leads.length; i += 10) out.push(...(await enrichChunk(leads.slice(i, i + 10))));
    return out;
  }
  return enrichChunk(leads);
}

async function enrichChunk(leads) {
  const details = leads.map((l) => {
    const { first, last } = splitName(l.name);
    return { first_name: first, last_name: last, organization_name: l.company || undefined, domain: domainFrom(l.website, l.email) || undefined };
  });
  try {
    const r = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': process.env.APOLLO_API_KEY },
      body: JSON.stringify({ reveal_personal_emails: false, details }),
    });
    if (!r.ok) return leads; // fail soft (free plan blocks API, rate limit, etc.)
    const data = await r.json();
    const matches = data.matches || [];
    return leads.map((l, i) => {
      const m = matches[i];
      const email = m && m.email;
      if (email && !/email_not_unlocked|domain\.com/.test(email)) {
        return { ...l, email, emailVerified: true };
      }
      return l;
    });
  } catch {
    return leads; // never let enrichment break prospecting
  }
}

module.exports = { enrichLeads, enabled };
