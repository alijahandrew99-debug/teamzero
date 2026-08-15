// Sending-domain authentication: SPF, DKIM, DMARC.
//
// Mailbox providers silently spam-folder (or reject) cold mail from domains that
// aren't authenticated. This is the single biggest deliverability lever, and it
// is invisible to the user until their reply rate is zero — so we check it for
// them, show the exact records to paste, and refuse to send until it passes.
//
// Zero dependencies: node's built-in DNS resolver.
require('./env');
const dns = require('dns').promises;

// Shared mailbox providers: the user does NOT control these domains' DNS, but
// the provider already authenticates their mail. Treated as provider-managed
// (a pass), with a warning that a custom domain is far stronger for cold email.
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'yahoo.com', 'aol.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'gmx.com', 'zoho.com']);

// Selectors used by the common senders, tried in order. A domain publishes DKIM
// at <selector>._domainkey.<domain>, and there is no way to enumerate selectors
// via DNS — so we probe the ones real providers use.
const DKIM_SELECTORS = [
  'google',                      // Google Workspace
  'selector1', 'selector2',      // Microsoft 365
  'k1', 'k2',                    // Mailchimp / Mandrill
  's1', 's2',                    // SendGrid / Zoho
  'zoho', 'zmail',               // Zoho
  'mail', 'default', 'dkim', 'smtp', 'key1', 'sig1', 'mx', 'email',
];

const TTL_MS = 10 * 60 * 1000; // cache: DNS rarely changes and users click re-check
const cache = new Map();

function domainOfEmail(email) {
  const s = (email || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  return i === -1 ? '' : s.slice(i + 1);
}
function isFreemail(domain) { return FREEMAIL.has((domain || '').toLowerCase()); }

// TXT records arrive as arrays of string chunks — join each record.
async function txt(name) {
  try {
    const recs = await dns.resolveTxt(name);
    return recs.map((chunks) => chunks.join(''));
  } catch { return []; }
}

async function checkSPF(domain) {
  const recs = (await txt(domain)).filter((r) => /^v=spf1\b/i.test(r));
  if (!recs.length) {
    return { ok: false, status: 'missing', detail: 'No SPF record found. Receiving servers can\'t confirm you\'re allowed to send from this domain.' };
  }
  if (recs.length > 1) {
    // More than one SPF record is invalid per RFC 7208 and fails outright.
    return { ok: false, status: 'duplicate', value: recs.join(' || '),
      detail: 'You have more than one SPF record. That is invalid and fails on every check — merge them into a single record.' };
  }
  const rec = recs[0];
  if (!/[~\-+?]all\s*$/i.test(rec.trim())) {
    return { ok: false, status: 'no-policy', value: rec,
      detail: 'Your SPF record has no ending policy (it should finish with ~all or -all).' };
  }
  if (/\+all\s*$/i.test(rec)) {
    return { ok: false, status: 'permissive', value: rec,
      detail: '"+all" lets anyone send as your domain — that is worse than having no SPF at all. Change it to ~all.' };
  }
  return { ok: true, status: 'pass', value: rec, detail: 'SPF is published and ends with a policy.' };
}

async function checkDMARC(domain) {
  const recs = (await txt(`_dmarc.${domain}`)).filter((r) => /^v=DMARC1\b/i.test(r));
  if (!recs.length) {
    return { ok: false, status: 'missing', detail: 'No DMARC record. Google and Microsoft now require DMARC for bulk senders.' };
  }
  const rec = recs[0];
  const m = rec.match(/\bp\s*=\s*(none|quarantine|reject)\b/i);
  if (!m) {
    return { ok: false, status: 'no-policy', value: rec, detail: 'Your DMARC record is missing its policy tag (p=none, p=quarantine or p=reject).' };
  }
  return { ok: true, status: 'pass', value: rec, policy: m[1].toLowerCase(),
    detail: `DMARC is published with p=${m[1].toLowerCase()}.` };
}

async function checkDKIM(domain, extraSelector) {
  const sels = extraSelector ? [extraSelector, ...DKIM_SELECTORS] : DKIM_SELECTORS;
  for (const sel of sels) {
    const recs = await txt(`${sel}._domainkey.${domain}`);
    const hit = recs.find((r) => /v=DKIM1/i.test(r) && /\bp\s*=\s*[A-Za-z0-9+/]{20,}/.test(r));
    if (hit) {
      return { ok: true, status: 'pass', selector: sel, value: `${sel}._domainkey.${domain}`,
        detail: `DKIM key found on selector "${sel}" — your mail is cryptographically signed.` };
    }
  }
  return { ok: false, status: 'missing',
    detail: 'No DKIM key found on any common selector. Turn on DKIM signing with your email provider, then re-check.' };
}

/**
 * Full authentication report for a sending address.
 * Returns { domain, freemail, ok, records: {spf,dkim,dmarc}, howTo: [...] }
 */
async function checkDomain(email, { selector = '', force = false } = {}) {
  const domain = domainOfEmail(email);
  if (!domain) return { domain: '', ok: false, error: 'No sending address connected yet.' };

  const key = `${domain}|${selector}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return { ...hit.val, cached: true };

  if (isFreemail(domain)) {
    const val = {
      domain, freemail: true, ok: true,
      records: {
        spf: { ok: true, status: 'managed', detail: `${domain} publishes SPF for you.` },
        dkim: { ok: true, status: 'managed', detail: `${domain} signs your mail with DKIM automatically.` },
        dmarc: { ok: true, status: 'managed', detail: `${domain} publishes DMARC for you.` },
      },
      warning: `You're sending from a shared ${domain} address. It is authenticated, but cold outreach from a free mailbox lands in spam far more often, and any complaints follow your personal account. A custom domain you own (e.g. you@yourcompany.com) is strongly recommended before you send volume.`,
      checkedAt: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), val });
    return val;
  }

  const [spf, dkim, dmarc] = await Promise.all([
    checkSPF(domain), checkDKIM(domain, selector), checkDMARC(domain),
  ]);
  const val = {
    domain, freemail: false,
    ok: spf.ok && dkim.ok && dmarc.ok,
    records: { spf, dkim, dmarc },
    howTo: howTo(domain, { spf, dkim, dmarc }),
    checkedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), val });
  return val;
}

// Exact copy-paste instructions for whatever is failing.
function howTo(domain, r) {
  const out = [];
  if (!r.spf.ok) {
    out.push({
      record: 'SPF', type: 'TXT', host: '@ (or ' + domain + ')',
      value: 'v=spf1 include:_spf.google.com ~all',
      note: r.spf.status === 'duplicate'
        ? 'Delete the extra SPF records so only ONE remains. If you send through more than one service, combine their includes into that single record.'
        : 'This example authorises Google Workspace/Gmail. Using another provider? Replace include:_spf.google.com with theirs (Microsoft: include:spf.protection.outlook.com).',
    });
  }
  if (!r.dkim.ok) {
    out.push({
      record: 'DKIM', type: 'TXT', host: 'google._domainkey (selector varies by provider)',
      value: '(generated by your email provider — copy the key they give you)',
      note: 'DKIM keys are generated, not invented. Google Workspace: Admin console → Apps → Google Workspace → Gmail → Authenticate email → Generate new record, then paste it into DNS and click Start authentication. Microsoft 365: Defender portal → Email authentication → DKIM → enable for your domain.',
    });
  }
  if (!r.dmarc.ok) {
    out.push({
      record: 'DMARC', type: 'TXT', host: '_dmarc',
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      note: 'Start with p=none (monitor only) so nothing of yours gets blocked while you confirm SPF and DKIM pass. Tighten to p=quarantine later.',
    });
  }
  return out;
}

module.exports = { checkDomain, domainOfEmail, isFreemail };
