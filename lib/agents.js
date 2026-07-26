// TeamZero agents (cloud) — PROSPECTOR, OUTBOUND, SCOUT, KEEPER. Account-scoped.
// Uses callAI (Anthropic API in prod, CLI fallback in dev). VOICE stays OFF.
require('./env');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { callAI, aiMode } = require('./ai');
const apollo = require('./apollo');
const emailFinder = require('./email');

const FOOTER = 'Reply STOP to opt out. This is a business message; you can unsubscribe anytime.';

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
function footerFor(p) { return `${p.name || 'TeamZero'} · ${FOOTER}`; }

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

// ---------------- PROSPECTOR ----------------
const BATCH_SIZE = 5; // leads researched per call — small keeps depth/quality high

// One research call: deep web research for `count` leads, excluding companies
// already found (so no wasted re-research and no duplicates across batches).
async function researchBatch(p, count, hints, excludeCompanies) {
  const prompt = [
    `You are PROSPECTOR, the lead-sourcing agent on TeamZero, an AI sales team.`,
    `Using web search, find ${count} REAL, currently-operating companies that fit the ICP below, and one real decision-maker at each.`,
    '', profileBlock(p),
    hints ? `Operator focus: ${hints}` : '',
    excludeCompanies && excludeCompanies.length
      ? `ALREADY FOUND — do NOT return any of these; find different companies:\n${excludeCompanies.slice(-40).join(', ')}`
      : '',
    `Surface strong prospects beyond only the most obvious top-of-mind names — vary by region and company size to reach less-saturated, high-fit targets.`,
    '',
    `Method: search the web (${db.today()}) for real companies + a real decision-maker each (founder/owner/relevant title). For EMAIL: use a real published address if found (email_confidence "verified"); else build the company's standard pattern (email_confidence "pattern"). Never invent a fake domain. "why": one specific current reason they fit NOW.`,
    `No made-up companies. No duplicates. Skip anyone without a real website.`,
    '',
    `Return STRICT JSON only — an array:`,
    `[{"name":"","title":"","company":"","website":"","email":"","email_confidence":"verified|pattern","location":"","linkedin":"","why":""}]`,
  ].filter(Boolean).join('\n');
  // Deep web research is slow, and gets slower as the exclusion list grows.
  // Overnight runs need headroom, so allow well beyond the default timeout.
  const raw = await callAI(prompt, { allowWeb: true, maxTokens: 4000, timeoutMs: 20 * 60 * 1000 });
  return safeJSONArray(raw) || [];
}

function toRow(r) {
  return {
    name: r.name || '', title: r.title || '', company: r.company || '', email: r.email || '',
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

  for (let start = 0; start < numBatches; start += concurrency) {
    const wave = [];
    for (let b = start; b < Math.min(start + concurrency, numBatches); b++) {
      const n = Math.min(BATCH_SIZE, count - b * BATCH_SIZE);
      if (n > 0) wave.push(researchBatch(p, n, hints, Array.from(seen)).then((a) => ({ ok: true, a })).catch((e) => ({ ok: false, e: e.message, a: [] })));
    }
    const waveResults = await Promise.all(wave);
    const batchesDone = Math.min(start + wave.length, numBatches);

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
    if (!fresh.length) { if (onProgress) onProgress({ done: batchesDone, total: numBatches, added: totalAdded }); continue; }

    // FREE email resolution first: check the domain can receive mail, then pull
    // the REAL published address off the company's site. Only falls back to a
    // labelled guess. This is what stops the bounces.
    const resolved = await emailFinder.resolveMany(fresh.map((r) => ({ name: r.name, website: r.website, email: r.email })));
    fresh = fresh.map((r, i) => {
      const x = resolved[i];
      if (!x) return r;
      return { ...r, email: x.email || r.email, email_confidence: x.confidence, email_source: x.source };
    });

    // Optional paid upgrade: Apollo can still improve a pattern/role guess.
    if (apollo.enabled()) {
      const enriched = await apollo.enrichLeads(fresh.map((r) => ({ name: r.name, company: r.company, email: r.email, website: r.website })));
      fresh = fresh.map((r, i) => {
        if (enriched[i] && enriched[i].emailVerified) { verified++; return { ...r, email: enriched[i].email, email_confidence: 'verified' }; }
        return r;
      });
    }
    const added = db.addLeads(accountId, profileId, fresh.map(toRow));
    totalAdded += added.length;
    db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Sourced ${added.length} lead(s) (${totalAdded}/${count})` });
    if (onProgress) onProgress({ done: batchesDone, total: numBatches, added: totalAdded });
  }

  const vnote = verified ? ` (${verified} Apollo-verified)` : '';
  db.logActivity(accountId, { agent: 'PROSPECTOR', profileId, msg: `Done — ${totalAdded} real lead(s) found${vnote}` });
  return { added: totalAdded, verified };
}

// ---------------- OUTBOUND ----------------
async function outboundDraft(p, lead) {
  const prompt = [
    `You are OUTBOUND, the email SDR on TeamZero. Write ONE cold email for the client below to this lead.`,
    '', profileBlock(p),
    '', `=== LEAD ===`, `Name: ${lead.name}`, `Title: ${lead.title}`, `Company: ${lead.company}`,
    `Notes: ${lead.notes || '(none)'}`, `=== END LEAD ===`, '',
    `Rules: personalize to THIS lead. Body <= 90 words, short sentences, one clear ask (the CTA). No hype words, no "hope this finds you well". Subject <= 6 words, specific.`,
    `Return STRICT JSON only: {"subject":"...","body":"..."} — body ends with a signature for ${p.senderName || 'the sender'} then this exact footer line: "${footerFor(p)}"`,
  ].join('\n');
  // Drafting one short email is a cheap-tier task: Haiku, thinking off, tight cap.
  const raw = await callAI(prompt, { maxTokens: 700, tier: 'draft' });
  const j = safeJSON(raw);
  if (!j || !j.subject || !j.body) return { subject: `Quick note for ${lead.company || lead.name}`, body: raw };
  return { subject: j.subject, body: j.body };
}
async function outboundRun(accountId, profileId, onProgress) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');
  const leads = db.getLeads(accountId, profileId).filter((l) => l.status === 'new');
  let ok = 0, i = 0;
  if (onProgress) onProgress({ done: 0, total: leads.length });
  for (const lead of leads) {
    try {
      const d = await outboundDraft(p, lead);
      db.addToQueue(accountId, { profileId, leadId: lead.id, agent: 'OUTBOUND', type: 'email',
        to: lead.email, toName: lead.name, company: lead.company, subject: d.subject, body: d.body });
      db.updateLead(accountId, lead.id, { status: 'drafted' });
      db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Drafted email to ${lead.name || lead.email}` });
      ok++;
    } catch (e) {
      db.logActivity(accountId, { agent: 'OUTBOUND', profileId, msg: `Draft failed for ${lead.name}: ${e.message}` });
    }
    i++;
    if (onProgress) onProgress({ done: i, total: leads.length });
  }
  return { drafted: ok };
}

// ---------------- SCOUT ----------------
async function scoutBrief(accountId, profileId) {
  const p = db.getProfile(accountId, profileId);
  if (!p) throw new Error('Profile not found');
  const prompt = [
    `You are SCOUT on TeamZero. Produce a tight weekly intel brief the client can act on.`,
    '', profileBlock(p), '',
    `Use web search for current facts (${db.today()}); cite sources inline. Cover: (1) 3 timely outreach angles this week, (2) 2-3 named prospect signals/trigger events, (3) one competitor/market note, (4) one thing to avoid saying now. Specific — names, numbers, links. Under 400 words. Markdown.`,
  ].join('\n');
  const brief = await callAI(prompt, { allowWeb: true, maxTokens: 2500 });
  fs.writeFileSync(path.join(db.DATA, 'briefs', `${accountId}-${profileId}-${db.today()}.md`), brief);
  db.logActivity(accountId, { agent: 'SCOUT', profileId, msg: 'Weekly brief generated' });
  return { brief };
}

module.exports = { prospect, outboundRun, scoutBrief };
