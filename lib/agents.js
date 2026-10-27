// Dawnpipe agents (cloud) — PROSPECTOR, OUTBOUND, SCOUT, KEEPER. Account-scoped.
// Uses callAI (Anthropic API in prod, CLI fallback in dev). VOICE stays OFF.
require('./env');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { callAI, aiMode } = require('./ai');
const apollo = require('./apollo');
const emailFinder = require('./email');
const emailApi = require('./emailapi');
const spamcheck = require('./spamcheck');
const suppression = require('./suppression');
const plans = require('./plans');
const memory = require('./leadmemory');

// CAN-SPAM requires three things in every commercial email: honest headers, a
// working opt-out, and the sender's real physical postal address. The AI is told
// to end on this exact line; the send path then appends the live unsubscribe URL.
const FOOTER = 'This is a business message. Reply STOP or use the unsubscribe link to opt out.';

function profileBlock(p) {
  return [
    `=== CLIENT PROFILE: ${p.name} ===`,
    `What they sell / do: ${p.offer || '(not set)'}`,
    `Ideal customer (ICP): ${p.icp || '(not set)'}`,
    `Core value prop: ${p.valueProp || '(not set)'}`,
    `Proof / credibility: ${p.proof || '(not set)'}`,
    `Tone & voice: ${p.tone || 'Direct, warm, concrete. No fluff.'}`,
    `Call to action: ${p.cta || 'A short reply or a 15-minute call.'}`,
    `Sender name: ${p.senderName || 'the sender'}`,
    p.notes ? `Extra notes: ${p.notes}` : '',
    `=== END PROFILE ===`,
  ].filter(Boolean).join('\n');
}
function footerFor(p) {
  const addr = (p.mailingAddress || '').trim();
  return [p.name || 'Dawnpipe', addr, FOOTER].filter(Boolean).join(' · ');
}

/**
 * Final compliance footer stamped at SEND time (not draft time), so the
 * unsubscribe URL is always live and the postal address is always current.
 * Idempotent: never double-stamps a body that already carries the block.
 */
function stampFooter(body, profile, unsubUrl) {
  let txt = String(body || '').trimEnd();
  if (txt.includes('__DP_FOOTER__') || /Unsubscribe: https?:\/\//i.test(txt)) return txt;
  // Older drafts (and the occasional over-helpful model) end with their own
  // footer line. Strip any trailing footer-ish lines so the recipient gets one.
  const lines0 = txt.split('\n');
  while (lines0.length) {
    const last = lines0[lines0.length - 1].trim();
    if (!last) { lines0.pop(); continue; }
    if (/reply stop|unsubscribe|this is a business message|opt out/i.test(last)) { lines0.pop(); continue; }
    break;
  }
  txt = lines0.join('\n').trimEnd();
  const addr = (profile && profile.mailingAddress || '').trim();
  // The opt-out line is NEVER optional. With a live link we give the link; if
  // the link can't be built (PUBLIC_URL unset) we still give Reply STOP — an
  // email with no way out is exactly what gets reported as spam.
  const lines = ['—', `${(profile && profile.name) || ''}${addr ? ' · ' + addr : ''}`.trim(),
    unsubUrl ? `Unsubscribe: ${unsubUrl}` : 'Reply STOP to opt out and we will never email you again.'].filter(Boolean);
  return txt + '\n\n' + lines.join('\n');
}

function stripFences(s) { return (s || '').replace(/```(?:json)?/gi, '').trim(); }
function safeJSON(s) {
  if (!s) return null;
  const c = stripFences(s);
  try { return JSON.parse(c); } catch {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    try { return JSON.parse(m[0].replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t')); } catch {}
  }
  const subj = c.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const body = c.match(/"body"\s*:\s*"([\s\S]*)"\s*\}?\s*$/);
  if (subj || body) {
    const un = (x) => (x || '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
    return { subject: un(subj && subj[1]), body: un(body && body[1]) };
  }
  return null;
}
function safeJSONArray(s) {
  if (!s) return null;
  const c = stripFences(s);
  try { const v = JSON.parse(c); return Array.isArray(v) ? v : null; } catch {}
  const m = c.match(/\[[\s\S]*\]/);
  if (m) { try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : null; } catch {} }
  return null;
}

// ---------------- ONBOARDING: fill a profile from a website ----------------
// Fetches the business's site and drafts their whole sales profile, so a new
// user pastes a URL instead of filling nine blank fields.
async function fetchPage(url, ms = 10000) {
  // A plain browser UA, not a bot one. Small-business sites routinely sit
  // behind Wordfence/Cloudflare with default rules that 403 anything that
  // says "compatible;" — apenergy.com did exactly that while nike.com let it
  // through. The owner is asking us to read THEIR OWN site; presenting as
  // the browser this effectively is gets the door open.
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) return '';
    const ct = r.headers.get('content-type') || '';
    if (!/text|html/i.test(ct)) return '';
    const html = (await r.text()).slice(0, 200000);
    // crude strip of tags/scripts to plain-ish text
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

async function autofillFromWebsite(url, pastedText) {
  let u = (url || '').trim();
  if (!u && !pastedText) throw new Error('Enter your website URL');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  let base = null;
  if (u) { try { base = new URL(u); } catch { throw new Error('That doesn\'t look like a valid URL'); } }
  const hostname = base ? base.hostname : 'their business';
  let text = '';
  let webRescue = false;
  // The owner can paste their own site's text directly — the fallback that
  // works for EVERY site: JS-only pages, hard firewalls, sites that are down.
  if (pastedText && String(pastedText).trim().length >= 80) {
    text = String(pastedText).trim().slice(0, 14000);
  } else if (base) {
    const origin = base.origin;
    const pages = await Promise.all([u, `${origin}/about`, `${origin}/about-us`, `${origin}/services`]
      .map((p) => fetchPage(p)));
    text = pages.filter(Boolean).join('\n\n').slice(0, 14000);
    // Some sites resolve only with (or only without) the www — try the other
    // spelling before giving up, so "mybusiness.com" works however DNS is set.
    if (!text) {
      const alt = base.hostname.startsWith('www.') ? origin.replace('://www.', '://') : origin.replace('://', '://www.');
      const retry = await Promise.all([alt, `${alt}/about`, `${alt}/services`].map((p2) => fetchPage(p2)));
      text = retry.filter(Boolean).join('\n\n').slice(0, 14000);
    }
    // Still nothing: the site's firewall is refusing our server's address
    // (small-business WAFs block datacenter IPs wholesale — apenergy.com
    // does). Search engines ARE allowlisted by those same firewalls, so let
    // the model research the site through web search instead. Costs about a
    // cent, runs once per business, only on this failure path.
    if (!text && require('./ai').aiMode() === 'api') webRescue = true;
    if (!text && !webRescue) throw new Error('Couldn\'t read that site — it may block automated readers, or the URL may be off. Check the address, or paste some text about your business instead.');
  } else {
    throw new Error('Paste a bit more about the business — a few sentences is plenty.');
  }

  // One pass fills BOTH screens: the sales profile and the phone agent's
  // script. Nobody wants to type thirteen boxes and then eight more; the
  // whole promise is "paste your website, review what it wrote". Every field
  // is a draft the owner can edit -- we never pretend it is authoritative,
  // and we never invent prices (see the pricing rule below).
  const prompt = [
    `You are onboarding a business into Dawnpipe. Dawnpipe answers their phone with an AI receptionist and finds them new customers by email. ${webRescue ? 'Their website blocks our reader, so research it with web search instead' : 'From the content below'}, draft BOTH their sales profile and the script their AI phone agent will follow.`,
    '',
    webRescue
      ? `THE BUSINESS: the website at ${hostname}. Search for this site and read what the search results and indexed pages say about the business — its name, what it does, who for, any published address, hours or credentials. Use ONLY what you find about THIS specific business; if a fact does not surface, leave that field "".`
      : `WEBSITE (${hostname}):\n${text}`,
    '',
    `Return STRICT JSON only, no markdown:`,
    `{"name":"","senderName":"","offer":"","icp":"","valueProp":"","proof":"","tone":"","cta":"","pricing":"","mailingAddress":"","agentName":"","greeting":"","hours":"","objective":"","qualifying":"","objections":"","faq":"","voicemail":""}`,
    `- name: the business name.`,
    `- senderName: a founder/owner name if you can find one, else "".`,
    `- offer: what they sell/do, plainly.`,
    `- icp: their ideal customer (industry, size, the role you'd sell to). Infer if not stated.`,
    `- valueProp: the core outcome they deliver.`,
    `- proof: any results, clients, credentials found (else "").`,
    `- tone: a short voice description fitting the brand (e.g. "Direct, warm, concrete").`,
    `- cta: a natural call to action (e.g. "A 15-minute call").`,
    `- pricing: prices ONLY if stated explicitly on the site, copied exactly. If the site does not state prices, return "" — NEVER invent, estimate or infer a price; the AI reads this aloud to real customers.`,
    `- mailingAddress: their physical postal address if published, else "".`,
    `- agentName: a warm, ordinary first name for the receptionist that suits this business (e.g. "Sarah", "Miguel"). Never the owner's name.`,
    `- greeting: one short line said after the AI introduces itself, e.g. "Thanks for calling — what's going on?".`,
    `- hours: opening hours if published, phrased for speech ("Mon-Fri 8am-5pm"), else "".`,
    `- objective: the ONE outcome a call should reach for THIS business. For a service business that is almost always booking the job or the estimate.`,
    `- qualifying: 2-3 questions a good receptionist here would ask, one per line, no numbering. Make them specific to this trade (e.g. a plumber asks "is it leaking right now?").`,
    `- objections: the pushback this business actually hears and a good answer, one per line, format: "objection" -> answer.`,
    `- faq: the facts the AI may state, from the site only, one per line, format: Q: ... A: ... Cover what they do, areas served, hours, whether estimates are free, payment methods — only where the site says so.`,
    `- voicemail: a short message to leave if an answering machine picks up.`,
    `Every field must be plausible for THIS business specifically. Where the site is silent on a fact, return "" rather than guessing — except agentName, objective, qualifying, objections and voicemail, which are reasonable drafts the owner will review.`,
  ].join('\n');

  const raw = await callAI(prompt, { maxTokens: 3000, tier: 'draft', allowWeb: webRescue, timeoutMs: webRescue ? 90000 : undefined });
  const j = safeJSON(raw) || {};
  // A web rescue that found nothing must fail honestly, not return a husk of
  // empty boxes pretending the import worked.
  if (webRescue && !(j.name || j.offer)) throw new Error('Couldn\'t read that site, and searching for it came up empty too. Paste some text about your business instead — a few sentences is plenty.');
  const s = (v) => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.filter(Boolean).join('\n') : '');
  const fallbackName = base ? base.hostname.replace(/^www\./, '') : 'My Business';
  return {
    name: j.name || fallbackName,
    senderName: s(j.senderName),
    offer: s(j.offer), icp: s(j.icp), valueProp: s(j.valueProp),
    proof: s(j.proof), tone: s(j.tone) || 'Direct, warm, concrete. No fluff.',
    cta: s(j.cta) || 'A short reply, or a 15-minute call.',
    website: base ? base.hostname.replace(/^www\./, '') : '',
    pricing: s(j.pricing), mailingAddress: s(j.mailingAddress),
    // The phone agent's half. Same shape as the voice settings form.
    voice: {
      agentName: s(j.agentName), greeting: s(j.greeting), hours: s(j.hours),
      objective: s(j.objective), qualifying: s(j.qualifying), objections: s(j.objections),
      faq: s(j.faq), voicemail: s(j.voicemail),
    },
  };
}

// ---------------- PROSPECTOR ----------------
const BATCH_SIZE = 5; // leads researched per call — small keeps depth/quality high

// One research call: deep web research for `count` leads, excluding companies
// already found (so no wasted re-research and no duplicates across batches).
async function researchBatch(p, count, hints, excludeCompanies) {
  const prompt = [
    `You are PROSPECTOR, the lead-sourcing agent on Dawnpipe, an AI sales team.`,
    `Using web search, find ${count} REAL, currently-operating companies that fit the ICP below, and one real decision-maker at each.`,
    '', profileBlock(p),
    hints ? `Operator focus: ${hints}` : '',
    excludeCompanies && excludeCompanies.length
      ? `ALREADY FOUND — do NOT return any of these; find different companies:\n${excludeCompanies.slice(-40).join(', ')}`
      : '',
    `Surface strong prospects beyond only the most obvious top-of-mind names — vary by region and company size to reach less-saturated, high-fit targets.`,
    '',
    `Method: search the web (${db.today()}) for real companies + a real decision-maker each. "name" MUST be an actual person's real first and last name that you found (e.g. "Alex Hoffer") — NEVER a job title like "Plant Manager", "Owner/President", or "Operations Director". If you genuinely cannot find a named person for a company, leave "name" empty and set "title" to the role — do NOT put the title in the name field. For EMAIL: use a real published address if found (email_confidence "verified"); else build the company's standard pattern (email_confidence "pattern"). Never invent a fake domain. For PHONE: the company's real published main or direct line if you can find one on their site or a listing, in +1XXXXXXXXXX form; leave "phone" EMPTY if you did not actually find one — a wrong number means cold-calling a stranger, so never guess, pattern-build, or carry a number over from a similar company. "why": one specific current reason they fit NOW.`,
    `No made-up companies. No duplicates. Skip anyone without a real website. A real person's name beats a generic title — prioritize companies where you can name the decision-maker.`,
    '',
    `Return STRICT JSON only — an array:`,
    `[{"name":"","title":"","company":"","website":"","email":"","email_confidence":"verified|pattern","phone":"","location":"","linkedin":"","why":""}]`,
  ].filter(Boolean).join('\n');
  // Deep web research is slow, and gets slower as the exclusion list grows.
  // Overnight runs need headroom, so allow well beyond the default timeout.
  // Big token budget: Sonnet runs thinking-on by default and web search eats
  // budget, so 4K truncated the leads JSON before it could be emitted. 12K
  // leaves ample room for thinking + search + the actual output.
  const raw = await callAI(prompt, { allowWeb: true, maxTokens: 12000, timeoutMs: 20 * 60 * 1000 });
  return safeJSONArray(raw) || [];
}

// A "name" is only usable for email lookup if it's a real person, not a job
// title the AI dropped in ("Plant Manager", "Owner/President", "Facility Manager").
const ROLE_WORDS = /^(owner|president|ceo|coo|cfo|cto|founder|principal|manager|director|vp|head|lead|general manager|gm|plant manager|facility|facilities|maintenance|operations|operations director|plant|hr|purchasing|procurement|contact|info|sales|team|staff|the |a )/i;
function hasRealName(name) {
  const n = (name || '').trim();
  if (!n) return false;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return false;              // need first + last
  if (ROLE_WORDS.test(n)) return false;            // starts with a role word
  if (/manager|director|president|officer|owner|operations|facilit/i.test(n) && !/[a-z]{2,}\s+[A-Z]/.test(n)) return false;
  return true;
}

function toRow(r) {
  return {
    name: r.name || '', title: r.title || '', company: r.company || '', email: r.email || '',
    phone: r.phone || '',
    location: r.location || '',
    emailConfidence: r.email_confidence || 'pattern',
    emailSource: r.email_source || '',
    notes: [r.why ? `WHY: ${r.why}` : '', r.email_confidence ? `email:${r.email_confidence}` : '',
      r.website ? `site:${r.website}` : '', r.linkedin ? `li:${r.linkedin}` : '', r.location ? `loc:${r.location}` : '']
      .filter(Boolean).join(' | '),
  };
}

// Parallel, deduped, progressive prospecting. Splits `count` into small batches
// that run concurrently in waves; each new wave excludes companies already found,
// so total wall-clock time collapses without touching per-lead research depth.
async function prospect(accountId, profileId, { count = 5, hints = '', onProgress } = {}) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');

  // The local `claude` CLI can't take concurrent calls (rate/session limit) — run
  // batches SEQUENTIALLY there so every lead lands. The deployed API handles real
  // parallelism, so fan out wide there for speed at volume.
  const concurrency = aiMode() === 'api' ? 5 : 1;
  const numBatches = Math.ceil(count / BATCH_SIZE);

  // seen = companies already in this profile (avoid re-finding) + found this run
  const seen = new Set(db.getLeads(accountId, profileId).map((l) => (l.company || '').toLowerCase()).filter(Boolean));
  let totalAdded = 0, verified = 0;

  // Waves run until the requested count is actually reached. Research batches
  // routinely come back light (dedupe, thin results), so after the planned
  // batches we keep topping up with extra waves — bounded so a dry niche can't
  // loop forever. Asking for 50 should mean ~50, not "whatever landed".
  const maxWaves = Math.ceil(numBatches / concurrency) * 2 + 2;
  let wavesRun = 0, emptyWaves = 0, droppedGuesses = 0, hunterDown = false;

  // Check the email-data quota up front so a drained Hunter plan is announced
  // BEFORE spending AI money, not silently discovered lead-by-lead.
  {
    const acct = db.getAccount(accountId);
    if (emailApi.enabled(acct)) {
      const st = await emailApi.accountStatus(acct).catch(() => null);
      if (st && st.searches && st.searches.available > 0 && st.searches.used >= st.searches.available) {
        hunterDown = true;
        // The customer must never be sent shopping for a vendor account. This
        // is our supply problem: say what it means for THEIR leads and keep
        // the provider's name out of it.
        db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Verified-email lookups are paused for a moment — this run keeps only emails published on the company's own site. Personal addresses resume automatically.` });
      }
    } else {
      db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `This run keeps only emails published on the company's own website.` });
    }
  }

  while (totalAdded < count && wavesRun < maxWaves && emptyWaves < 2) {
    const remaining = count - totalAdded;
    const batchesThisWave = Math.min(concurrency, Math.ceil(remaining / BATCH_SIZE));
    const wave = [];
    for (let b = 0; b < batchesThisWave; b++) {
      const n = Math.min(BATCH_SIZE, remaining - b * BATCH_SIZE);
      if (n > 0) wave.push(researchBatch(p, n, hints, Array.from(seen)).then((a) => ({ ok: true, a })).catch((e) => ({ ok: false, e: e.message, a: [] })));
    }
    const waveResults = await Promise.all(wave);
    wavesRun++;
    const batchesDone = Math.min(wavesRun * concurrency, numBatches);

    // merge + dedupe this wave against everything seen so far
    let fresh = [];
    for (const wr of waveResults) {
      if (!wr.ok) { db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `A research batch was skipped: ${wr.e}` }); continue; }
      for (const r of wr.a) {
        const comp = (r.company || '').toLowerCase();
        if (!comp || seen.has(comp)) continue;
        seen.add(comp);
        fresh.push(r);
      }
    }
    if (!fresh.length) { emptyWaves++; if (onProgress) onProgress({ done: batchesDone, total: numBatches, added: totalAdded }); continue; }

    // FREE email resolution first: check the domain can receive mail, then pull
    // the REAL published address off the company's site. Only falls back to a
    // labelled guess. This is what stops the bounces.
    const resolved = await emailFinder.resolveMany(fresh.map((r) => ({ name: r.name, website: r.website, email: r.email })));
    fresh = fresh.map((r, i) => {
      const x = resolved[i];
      if (!x) return r;
      return { ...r, email: x.email || r.email, email_confidence: x.confidence, email_source: x.source };
    });

    // REAL email data (Hunter.io): per-account key first, owner fallback key
    // second. Replaces pattern guesses with database-verified addresses — the
    // step that makes emails actually deliverable.
    const account = db.getAccount(accountId);
    if (emailApi.enabled(account) && !hunterDown) {
      let hHit = 0, hMiss = 0, hFell = 0;
      for (let i = 0; i < fresh.length; i++) {
        const r = fresh[i];
        try {
          const named = hasRealName(r.name);
          if (named && (r.email_confidence === 'pattern' || r.email_confidence === 'invalid' || !r.email)) {
            // real person, but guessed/missing email → look up the real one
            const hit = await emailApi.findEmail(account, { name: r.name, website: r.website, email: r.email });
            if (hit && hit.confidence) { fresh[i] = { ...r, email: hit.email, email_confidence: hit.confidence, email_source: hit.source }; hHit++; }
            else hMiss++;
          } else if (!named) {
            // AI returned a job title, not a person → ask Hunter for the real
            // decision-maker at this domain; else fall back to a REAL inbox so it
            // won't bounce like a fake personal guess.
            const ds = await emailApi.domainSearch(account, { website: r.website, email: r.email });
            if (ds) {
              fresh[i] = { ...r, name: ds.name || r.name, title: ds.title || r.title, email: ds.email, email_confidence: ds.confidence, email_source: ds.source };
              hFell++;
            } else hMiss++;
          } else if (r.email) {
            // real person with a site/role email → verify it actually exists
            const v = await emailApi.verifyEmail(account, r.email);
            if (v) { fresh[i] = { ...r, email_confidence: v.confidence, email_source: v.source }; }
          }
        } catch (e) {
          // Our supply problem, not theirs. Log the real reason for the owner,
          // but never hand a paying customer a vendor's error message or an
          // instruction to go and buy an account somewhere.
          hunterDown = true;
          console.error(`email data unavailable (account ${accountId}): ${e.message}`);
          db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Verified-email lookups paused for the rest of this run — keeping emails published on each company's own site.` });
          break;
        }
      }
      if (!hunterDown) db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Verified emails: ${hHit} found, ${hFell} matched by company, ${hMiss} not on file` });
    }

    // Optional paid upgrade: Apollo can still improve a pattern/role guess.
    if (apollo.enabled()) {
      const enriched = await apollo.enrichLeads(fresh.map((r) => ({ name: r.name, company: r.company, email: r.email, website: r.website })));
      fresh = fresh.map((r, i) => {
        if (enriched[i] && enriched[i].emailVerified) { return { ...r, email: enriched[i].email, email_confidence: 'verified' }; }
        return r;
      });
    }

    // THE GUARANTEE: never save a lead without a REAL address. 'verified' =
    // database/site confirmed, 'role'/'site' = actually published by the company.
    // 'pattern' guesses and 'invalid' addresses are dropped here, before they can
    // reach the list, get drafted, or bounce. Real > many.
    const before = fresh.length;
    fresh = fresh.filter((r) => db.isSendableLead({ email: r.email, emailConfidence: r.email_confidence }));
    droppedGuesses += before - fresh.length;
    if (!fresh.length) { emptyWaves++; if (onProgress) onProgress({ done: batchesDone, total: numBatches, added: totalAdded }); continue; }

    fresh = fresh.slice(0, count - totalAdded); // trim AFTER filtering so surplus backfills drops
    const added = db.addLeads(accountId, profileId, fresh.map(toRow));
    if (added.length) emptyWaves = 0; // only real saved progress resets the fruitless-wave cutoff
    verified += added.filter((l) => l.emailConfidence === 'verified').length;
    totalAdded += added.length;
    db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Sourced ${added.length} lead(s) with real emails (${totalAdded}/${count})` });
    if (onProgress) onProgress({ done: batchesDone, total: numBatches, added: totalAdded });
  }

  const vnote = verified ? ` (${verified} verified emails)` : '';
  const dnote = droppedGuesses ? ` — ${droppedGuesses} discarded for having no real email (guesses are never saved)` : '';
  const short = totalAdded < count ? ` — stopped at ${totalAdded} of ${count} with real emails; try a broader focus or different region` : '';
  db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Done — ${totalAdded} lead(s) with real emails${vnote}${dnote}${short}` });
  return { added: totalAdded, verified, dropped: droppedGuesses };
}

// ---------------- OUTBOUND ----------------
async function outboundDraft(p, lead) {
  // Which touch is this? A good rep never sends the same email twice, and never
  // opens touch 3 with "just following up".
  const step = memory.nextStep(lead) || memory.CADENCE[0];
  const brief = memory.briefFor(lead);
  const isFollowUp = Number(lead.touchCount || 0) > 0;

  const prompt = [
    isFollowUp
      ? `You are KEEPER, the follow-up rep on Dawnpipe. Write touch #${step.touch} to a lead who has NOT replied yet.`
      : `You are OUTBOUND, the email SDR on Dawnpipe. Write the FIRST cold email for the client below to this lead.`,
    '', profileBlock(p),
    '', `=== LEAD ===`, `Name: ${lead.name}`, `Title: ${lead.title}`, `Company: ${lead.company}`,
    `Notes: ${lead.notes || '(none)'}`,
    brief ? `\n=== WHAT WE ALREADY KNOW ===\n${brief}` : '',
    `=== END LEAD ===`, '',
    `THIS TOUCH: ${step.angle}`,
    isFollowUp
      ? `CRITICAL: they have already had ${lead.touchCount} email(s) from us and did not reply. Do NOT repeat the previous angle, do NOT recap what you sent before, and NEVER write "just following up", "bumping this up", "circling back", or "in case you missed it". Earn the open on its own merits. Use what we know about them above — referencing a real detail is what separates a rep from a mail merge.`
      : `Open with one specific, current reason you are writing to THIS company.`,
    '',
    `Rules: body <= 90 words, short sentences, one clear ask (the CTA). No hype words, no "hope this finds you well". Subject <= 6 words, specific, and DIFFERENT from anything in the history above.`,
    `Return STRICT JSON only: {"subject":"...","body":"...","facts":["..."]} — body ends with a simple sign-off from ${p.senderName || 'the sender'}. Do NOT add a footer, disclaimer, address or unsubscribe line: those are stamped on automatically at send time, and writing your own produces two of them. "facts" = up to 3 short things worth remembering about this lead for next time (leave [] if nothing new).`,
  ].filter(Boolean).join('\n');
  // Drafting one short email is a cheap-tier task: Haiku, thinking off, tight cap.
  const raw = await callAI(prompt, { maxTokens: 700, tier: 'draft' });
  const j = safeJSON(raw);
  if (!j || !j.subject || !j.body) return { subject: `Quick note for ${lead.company || lead.name}`, body: raw, facts: [], touch: step.touch };
  return { subject: j.subject, body: j.body, facts: Array.isArray(j.facts) ? j.facts.slice(0, 3) : [], touch: step.touch };
}
async function outboundRun(accountId, profileId, onProgress) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');
  const all = db.getLeads(accountId, profileId).filter((l) => l.status === 'new');
  // Safety net for leads created before the no-guess guarantee: never draft to a
  // guessed or invalid address — a drafted email to a fake address is a bounce
  // waiting for an approve click.
  // Don't spend AI money drafting to people who already opted out or bounced.
  const leads = all.filter((l) => db.isSendableLead(l) && !suppression.isSuppressed(accountId, l.email).blocked);
  const skipped = all.length - leads.length;
  if (skipped) db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Skipped ${skipped} lead(s) with unverified/guessed emails — use "Clear guesses" to remove them` });
  let ok = 0, i = 0;
  if (onProgress) onProgress({ done: 0, total: leads.length });
  // Drafting is where the AI spend actually happens, so it is metered per draft.
  // Metering only the prospect run left imported leads (and re-drafts) free.
  const owner = require('./stripe').isOwner(db.getAccount(accountId));
  for (const lead of leads) {
    // Re-read every iteration: plans.consume writes to disk, so a snapshot taken
    // once before the loop meant leadsUsed only ever advanced by 1 per RUN.
    const acct = db.getAccount(accountId);
    if (!owner) {
      const u = plans.usage(acct, false);
      if (!u.unlimited && u.remaining <= 0) {
        db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Stopped — this month's ${u.limit} leads are used up. Drafted ${ok} before the cap.` });
        break;
      }
    }
    try {
      const d = await outboundDraft(p, lead);
      const spam = spamcheck.analyze({ subject: d.subject, body: d.body, autoFooter: true });
      db.addToQueue(accountId, { profileId, leadId: lead.id, agent: d.touch > 1 ? 'KEEPER' : 'OUTBOUND', type: 'email',
        touch: d.touch, to: lead.email, toName: lead.name, company: lead.company,
        subject: d.subject, body: d.body, spam });
      // Anything the draft learned about them is kept for the next touch.
      if (d.facts && d.facts.length) memory.remember(accountId, lead, { kind: 'note', summary: 'learned while drafting', facts: d.facts });
      memory.enrol(accountId, db.getLeads(accountId, profileId).find((x) => x.id === lead.id) || lead);
      db.updateLead(accountId, lead.id, { status: 'drafted' });
      db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Drafted email to ${lead.name || lead.email}` });
      // Charge once per lead, ever. The prospect run already metered the leads
      // it created, so only leads that arrived another way (CSV import, or a
      // re-draft) are charged here.
      if (!owner && !lead.metered) { plans.consume(acct, 1, false); db.updateLead(accountId, lead.id, { metered: true }); }
      ok++;
    } catch (e) {
      db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Draft failed for ${lead.name}: ${e.message}` });
    }
    i++;
    if (onProgress) onProgress({ done: i, total: leads.length });
  }
  return { drafted: ok };
}

// ---------------- KEEPER: the follow-up rep ----------------
/**
 * Drafts the next touch for every lead whose follow-up is due. Deliberately
 * writes into the SAME approval queue — follow-ups get the same human gate as
 * first touches, because an unattended drip is how good products become spam.
 */
async function keeperRun(accountId, profileId, onProgress) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');
  const due = memory.dueNow(accountId, profileId)
    .filter((l) => db.isSendableLead(l) && !suppression.isSuppressed(accountId, l.email).blocked)
    // don't queue a second draft for someone who already has one waiting
    .filter((l) => !db.getQueue(accountId, profileId).some((q) => q.leadId === l.id && ['pending', 'approved'].includes(q.status)));

  const owner = require('./stripe').isOwner(db.getAccount(accountId));
  let ok = 0, i = 0;
  if (onProgress) onProgress({ done: 0, total: due.length });
  for (const lead of due) {
    const acct = db.getAccount(accountId);
    if (!owner) {
      const u = plans.usage(acct, false);
      if (!u.unlimited && u.remaining <= 0) {
        db.logActivity(accountId, { agent: 'KEEPER', profileId, msg: `Stopped — monthly allowance used up after ${ok} follow-up(s).` });
        break;
      }
    }
    try {
      const d = await outboundDraft(p, lead);
      const spam = spamcheck.analyze({ subject: d.subject, body: d.body, autoFooter: true });
      db.addToQueue(accountId, { profileId, leadId: lead.id, agent: 'KEEPER', type: 'email', touch: d.touch,
        to: lead.email, toName: lead.name, company: lead.company, subject: d.subject, body: d.body, spam });
      if (d.facts && d.facts.length) memory.remember(accountId, lead, { kind: 'note', summary: 'learned while drafting', facts: d.facts });
      db.updateLead(accountId, lead.id, { status: 'drafted' });
      db.logActivity(accountId, { agent: 'KEEPER', profileId, msg: `Follow-up #${d.touch} drafted for ${lead.name || lead.email}` });
      if (!owner && !lead.metered) { plans.consume(acct, 1, false); db.updateLead(accountId, lead.id, { metered: true }); }
      ok++;
    } catch (e) {
      db.logActivity(accountId, { agent: 'KEEPER', profileId, msg: `Follow-up failed for ${lead.name}: ${e.message}` });
    }
    i++;
    if (onProgress) onProgress({ done: i, total: due.length });
  }
  return { drafted: ok, due: due.length };
}

// ---------------- SCOUT ----------------
async function scoutBrief(accountId, profileId) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');
  const prompt = [
    `You are SCOUT on Dawnpipe. Produce a tight weekly intel brief the client can act on.`,
    '', profileBlock(p), '',
    `Use web search for current facts (${db.today()}); cite sources inline. Cover: (1) 3 timely outreach angles this week, (2) 2-3 named prospect signals/trigger events, (3) one competitor/market note, (4) one thing to avoid saying now. Specific — names, numbers, links. Under 400 words. Markdown.`,
  ].join('\n');
  const brief = await callAI(prompt, { allowWeb: true, maxTokens: 6000 });
  fs.writeFileSync(path.join(db.DATA, 'briefs', `${accountId}-${profileId}-${db.today()}.md`), brief);
  db.logActivity(accountId, { agent: 'SCOUT', profileId, msg: 'Weekly brief generated' });
  return { brief };
}

/**
 * Look up phone numbers for leads that don't have one.
 *
 * Prospecting only started capturing numbers recently, so every lead found
 * before that is uncallable — a customer with 200 leads would open the cold
 * calling screen and be told there is nothing to dial. This backfills them.
 *
 * Researched in small batches: one web lookup per company is slow and the
 * model is better at "here are 8 companies, find their published numbers".
 */
async function findPhones(accountId, profileId, { limit = 25, onProgress } = {}) {
  const targets = db.getLeads(accountId, profileId).filter((l) => !l.phone && (l.company || l.name)).slice(0, limit);
  if (!targets.length) return { checked: 0, found: 0 };

  const BATCH = 8;
  let found = 0, checked = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const prompt = [
      `Find the publicly listed business phone number for each company below.`,
      `Search the web (${db.today()}). Use the company's own website, its contact page, or a reputable business listing.`,
      ``,
      `RULES — these matter more than coverage:`,
      `- Return a number ONLY if you actually found it published for THAT company. An empty string is the correct answer when you did not.`,
      `- NEVER guess, never pattern-build from another branch or a similar company, never reuse a number across two entries.`,
      `- A wrong number means cold-calling an unrelated stranger, so a miss is far cheaper than a bad guess.`,
      `- Prefer the main business line. Format as +1XXXXXXXXXX for US/Canada, otherwise full international E.164.`,
      ``,
      `Companies:`,
      ...batch.map((l, n) => `${n + 1}. ${l.company || '(no company)'}${l.name ? ` — contact: ${l.name}` : ''}${l.notes && /site:/.test(l.notes) ? ` — ${(l.notes.match(/site:([^\s|]+)/) || [])[0] || ''}` : ''}`),
      ``,
      `Return STRICT JSON only — an array in the SAME ORDER, one entry per company:`,
      `[{"company":"","phone":""}]`,
    ].join('\n');

    let rows = [];
    try {
      const raw = await callAI(prompt, { allowWeb: true, maxTokens: 3000, timeoutMs: 5 * 60 * 1000 });
      rows = safeJSONArray(raw) || [];
    } catch (e) {
      db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Phone lookup batch failed: ${e.message}` });
    }

    batch.forEach((lead, n) => {
      checked++;
      // Match on company name first; fall back to position only when the model
      // returned the same number of rows, so a short reply can't shift numbers
      // onto the wrong companies.
      const byName = rows.find((r) => r && r.company
        && String(r.company).trim().toLowerCase() === String(lead.company || '').trim().toLowerCase());
      const row = byName || (rows.length === batch.length ? rows[n] : null);
      const phone = row && typeof row.phone === 'string' ? row.phone.trim() : '';
      const digits = phone.replace(/[^0-9]/g, '');
      if (digits.length >= 10) {
        db.updateLead(accountId, lead.id, { phone, phoneSource: 'research' });
        found++;
      }
      if (onProgress) onProgress({ done: checked, total: targets.length, found });
    });
  }

  db.logActivity(accountId, { agent: 'PROSPECTOR', profileId,
    msg: `Phone lookup: found ${found} number(s) for ${checked} lead(s)` });
  return { checked, found };
}

/**
 * Rewrite ONE existing draft to the owner's instruction -- "shorter",
 * "mention the fall special", "less formal". Facts are kept, nothing new is
 * invented, and the result goes back to PENDING so a human reads the new
 * wording before anything sends. Haiku, ~half a cent a draft: a 30-email
 * queue costs about fifteen cents to re-voice, which is why the product can
 * offer it freely.
 */
async function adjustDraft(profile, item, instruction) {
  const prompt = [
    `You are editing one outreach email draft for ${profile.name}.`,
    `THE OWNER'S INSTRUCTION: "${instruction}"`,
    `Apply it to the email below. Keep every real fact; NEVER invent new claims, prices, discounts or names the original does not contain (if the instruction references something like a promotion, mention it only as the instruction words it). Body stays under 90 words, plain human tone, one clear ask, same sign-off. Subject 6 words or fewer.`,
    `Current subject: ${item.subject || ''}`,
    `Current body:`,
    String(item.body || ''),
    `Return STRICT JSON only: {"subject":"...","body":"..."} with no footer, address or unsubscribe line -- those are stamped automatically at send time.`,
  ].join(String.fromCharCode(10));
  const raw = await callAI(prompt, { maxTokens: 700, tier: 'draft' });
  const j = safeJSON(raw) || {};
  const subject = String(j.subject || '').trim().slice(0, 120);
  const body = String(j.body || '').trim();
  return subject && body ? { subject, body } : null;
}

module.exports = { stampFooter, footerFor, keeperRun, prospect, outboundRun, scoutBrief, autofillFromWebsite, findPhones, adjustDraft };
