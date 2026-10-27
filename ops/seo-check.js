// SEO + trust-signal monitor for dawnpipe.com. Zero dependencies.
//
//   node ops/seo-check.js                    -> checks https://dawnpipe.com
//   node ops/seo-check.js http://localhost:8090   -> checks a local server
//
// This is the automated half of "Monitor and Improve": the keeper agent runs
// it daily, and any FAIL is a regression a deploy introduced — titles going
// duplicate, a canonical vanishing, JSON-LD breaking, the favicon 404ing,
// a sitemap URL dying. Exit code 1 on any failure so cron/agents can alert.
const BASE = (process.argv[2] || 'https://dawnpipe.com').replace(/\/$/, '');
let pass = 0, fail = 0, warn = 0;
const ok = (l, c, extra) => { c ? pass++ : fail++; console.log((c ? '  PASS  ' : '  FAIL  ') + l + (!c && extra ? ' -> ' + String(extra).slice(0, 160) : '')); };
const note = (l) => { warn++; console.log('  NOTE  ' + l); };

const PAGES = {
  '/': { title: /Dawnpipe/, mustHave: ['SoftwareApplication', 'Organization', 'WebSite', 'FAQPage'] },
  '/about': { title: /About Dawnpipe/, mustHave: ['AboutPage'] },
  '/automate-your-business-with-ai': { title: /Automate Your Business with AI/i, mustHave: ['Article', 'FAQPage'] },
  '/signup': { title: /Dawnpipe/ },
  '/terms': { title: /Terms/ },
  '/privacy': { title: /Privacy/ },
};

async function get(path, type) {
  const r = await fetch(BASE + path, { redirect: 'follow', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DawnpipeSEOCheck/1.0)' } });
  const body = type === 'buffer' ? Buffer.from(await r.arrayBuffer()) : await r.text();
  return { status: r.status, ct: r.headers.get('content-type') || '', body };
}

(async () => {
  console.log('SEO check against ' + BASE);

  // DNS first — the whole site rides on the apex record, and it has already
  // vanished once (2026-08-25: a Google Workspace setup in Namecheap knocked
  // out the apex ALIAS; the site died by resolver-cache expiry while /health
  // kept passing through cached DNS). Ask two public resolvers via DoH so a
  // poisoned local cache can neither hide an outage nor fake one.
  if (BASE.includes('dawnpipe.com')) {
    for (const [label, url] of [
      ['Google DNS', 'https://dns.google/resolve?name=dawnpipe.com&type=A'],
      ['Cloudflare DNS', 'https://cloudflare-dns.com/dns-query?name=dawnpipe.com&type=A'],
    ]) {
      try {
        const r = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        ok(`apex dawnpipe.com resolves via ${label}`, Array.isArray(j.Answer) && j.Answer.length > 0,
          'EMPTY ANSWER — the apex DNS record is missing at Namecheap. Fix: Advanced DNS, ALIAS @ -> teamzero-2fpd.onrender.com. Site + Twilio calls die as caches expire.');
      } catch (e) { note(`${label} DoH unreachable (${e.message}) — could not verify apex DNS`); }
    }
    try {
      const r = await fetch('https://dns.google/resolve?name=www.dawnpipe.com&type=A', { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      ok('www.dawnpipe.com resolves', Array.isArray(j.Answer) && j.Answer.length > 0);
    } catch (e) { note('www DNS check unreachable: ' + e.message); }
  }

  const titles = new Map(), descs = new Map();

  for (const [path, spec] of Object.entries(PAGES)) {
    const { status, body } = await get(path);
    ok(`${path} responds 200`, status === 200, status);
    if (status !== 200) continue;
    const title = (body.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    ok(`${path} title present + on-topic`, spec.title.test(title), title);
    ok(`${path} title length sane (10-70 chars ideal, <=95 hard)`, title.length >= 10 && title.length <= 95, title.length);
    if (titles.has(title)) ok(`${path} title UNIQUE`, false, 'duplicate of ' + titles.get(title)); else { titles.set(title, path); pass++; console.log(`  PASS  ${path} title unique`); }
    const desc = (body.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || '';
    if (path === '/terms' || path === '/privacy') { if (!desc) note(`${path} has no meta description (fine for legal pages)`); }
    else {
      ok(`${path} meta description present`, desc.length >= 50, desc.length);
      if (desc && descs.has(desc)) ok(`${path} description UNIQUE`, false, 'duplicate of ' + descs.get(desc)); else if (desc) descs.set(desc, path);
    }
    if (path === '/' || path === '/about' || path === '/automate-your-business-with-ai') {
      ok(`${path} canonical present`, new RegExp('<link rel="canonical" href="https://dawnpipe\\.com' + (path === '/' ? '/' : path) + '"').test(body));
      ok(`${path} favicon.ico linked for crawlers`, /rel="icon" href="\/favicon\.ico(\?[^"]*)?"/.test(body));
      ok(`${path} no leaked placeholders`, !/__[A-Z_]+__/.test(body), (body.match(/__[A-Z_]+__/) || [])[0]);
    }
    // every JSON-LD block must parse, and the expected types must be present
    const lds = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let types = [];
    for (const raw of lds) {
      try { const j = JSON.parse(raw); types.push(j['@type']); }
      catch (e) { ok(`${path} JSON-LD parses`, false, e.message); types = null; break; }
    }
    if (types) {
      if (lds.length) { pass++; console.log(`  PASS  ${path} all ${lds.length} JSON-LD blocks parse`); }
      for (const t of (spec.mustHave || [])) ok(`${path} declares ${t} schema`, types.includes(t), types.join(','));
    }
  }

  const llms = await get('/llms.txt');
  ok('llms.txt serves the AI-crawler brand description', llms.status === 200 && /AI receptionist/.test(llms.body) && /not a car exhaust downpipe/.test(llms.body));

  const robots = await get('/robots.txt');
  ok('robots.txt serves and allows crawling', robots.status === 200 && /Allow: \//.test(robots.body) && /Sitemap:/.test(robots.body));
  ok('robots.txt still protects the app + API', /Disallow: \/app/.test(robots.body) && /Disallow: \/api\//.test(robots.body));

  const sm = await get('/sitemap.xml');
  ok('sitemap.xml serves as XML', sm.status === 200 && /xml/.test(sm.ct));
  const urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok('sitemap lists the guide page', urls.some((u) => u.includes('/automate-your-business-with-ai')), urls.join(' '));
  ok('sitemap lists /about', urls.some((u) => u.endsWith('/about')));
  ok('sitemap carries lastmod', /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sm.body));
  for (const u of urls) {
    const path = u.replace(/^https:\/\/dawnpipe\.com/, '') || '/';
    const r = await get(path);
    ok(`sitemap URL alive: ${path}`, r.status === 200, r.status);
  }

  // The favicon Google shows in search results: /favicon.ico, 48x48 ICO.
  const ico = await get('/favicon.ico', 'buffer');
  ok('favicon.ico serves', ico.status === 200 && ico.body.length > 100, ico.status);
  if (ico.status === 200) {
    const isIco = ico.body[0] === 0 && ico.body[1] === 0 && ico.body[2] === 1;
    ok('favicon.ico is a real ICO', isIco);
    if (isIco) { const w = ico.body[6] || 256; ok('favicon is a multiple of 48px (Google requirement)', w % 48 === 0, w + 'px'); }
  }
  const touch = await get('/apple-touch-icon.png', 'buffer');
  ok('apple-touch-icon (the Organization logo) serves', touch.status === 200 && touch.body.length > 500);
  const og = await get('/og.png', 'buffer');
  ok('og.png (link preview image) serves', og.status === 200 && og.body.length > 1000);

  const home = await get('/');
  if (/google-site-verification/.test(home.body)) { pass++; console.log('  PASS  Search Console verification tag present'); }
  else note('GOOGLE_SITE_VERIFICATION env not set yet — Search Console tag absent (set it in Render after registering the property)');

  console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} notes` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CHECK CRASHED:', e.message); process.exit(1); });
