// What we ACTUALLY pay Twilio, from Twilio's own ledger -- not from constants.
//
// The in-app cost estimate is built from list prices baked in as constants. It
// said a 2-minute call cost ~$0.30; the owner's bill said $1.50. Rather than
// argue about which is right, read the ledger. Twilio's Usage Records API
// returns every billable category (voice minutes, speech recognition, TTS,
// recording, SMS, number rental...) with the exact price charged. This module
// pulls it, groups it, and answers the only question that matters: per minute
// of customer conversation, what does this business cost us?
const API = 'https://api.twilio.com/2010-04-01';

function creds() {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio is not configured.');
  return { sid, auth: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') };
}

/**
 * Usage records for a date range, all categories, with price and count.
 * Twilio pages at 50 by default; we ask for the max and follow next_page_uri.
 */
async function usageRecords({ start, end }) {
  const { sid, auth } = creds();
  const rows = [];
  let path = `/Accounts/${sid}/Usage/Records.json?StartDate=${start}&EndDate=${end}&PageSize=1000`;
  for (let guard = 0; path && guard < 20; guard++) {
    const r = await fetch(`${API}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `Twilio ${r.status}`);
    for (const u of data.usage_records || []) {
      rows.push({ category: u.category, description: u.description, count: Number(u.count) || 0, countUnit: u.count_unit,
        usage: Number(u.usage) || 0, usageUnit: u.usage_unit, price: Number(u.price) || 0, priceUnit: u.price_unit });
    }
    path = data.next_page_uri || null;
  }
  return rows;
}

/** Group into the buckets that matter for a voice agent, sorted by spend. */
function summarise(rows) {
  const buckets = {
    'Voice minutes (inbound)': (c) => /^calls-inbound/.test(c),
    'Voice minutes (outbound / transfers)': (c) => /^calls-outbound/.test(c),
    'Speech recognition (Gather)': (c) => /speech|gather|stt|recognition/i.test(c),
    'Text-to-speech': (c) => /tts|text-to-speech|polly|speech-synthesis/i.test(c),
    'Call recording + storage': (c) => /recording/i.test(c),
    'SMS': (c) => /^sms/.test(c),
    'Phone number rental': (c) => /phonenumbers|number/i.test(c),
    'Answering machine detection': (c) => /amd|answering/i.test(c),
  };
  const out = {};
  let total = 0, other = 0;
  const otherRows = [];
  for (const r of rows) {
    if (!r.price) continue;
    total += r.price;
    let hit = false;
    for (const [name, test] of Object.entries(buckets)) {
      if (test(r.category)) { out[name] = (out[name] || 0) + r.price; hit = true; break; }
    }
    if (!hit) { other += r.price; otherRows.push({ category: r.category, price: r.price }); }
  }
  if (other) out['Other'] = other;
  const sorted = Object.entries(out).sort((a, b) => b[1] - a[1]).map(([name, price]) => ({ name, price: Number(price.toFixed(4)), share: total ? Number((price / total * 100).toFixed(1)) : 0 }));
  const voiceMin = rows.filter((r) => /^calls-(inbound|outbound)/.test(r.category)).reduce((n, r) => n + (r.usageUnit === 'minutes' ? r.usage : 0), 0);
  return { total: Number(total.toFixed(4)), buckets: sorted, otherRows: otherRows.sort((a, b) => b.price - a.price).slice(0, 15), voiceMinutes: Number(voiceMin.toFixed(1)),
    perMinute: voiceMin ? Number((total / voiceMin).toFixed(4)) : null };
}

/**
 * The four numbers the whole margin model hangs on, read off Twilio's bill
 * instead of assumed. Each was a guess in the cost model, each is worth real
 * money per month, and each is sitting in the ledger for free.
 *
 *  1. What we ACTUALLY pay per speech-recognition use. Twilio's default
 *     ("Twilio picks provider") is $0.02; the legacy Google v1 models are
 *     $0.035-$0.040. lib/voice.js pins speechModel to an experimental_* name,
 *     which Twilio documents as legacy — if the ledger says $0.035 we are
 *     paying 75-100% over the default for no benefit, and the fix is one env
 *     var (VOICE_STT).
 *  2. Turns per minute. Because recognition bills PER USE, cost is nearly
 *     linear in turns. The model assumed 4; the code's 2-second end-of-speech
 *     timeout implies closer to 3. That difference is ~$49 per 1,000 minutes.
 *  3. Billed characters per turn. Twilio bills TTS in 100-character blocks
 *     with a 100-char minimum. If the minimum is per <Say> rather than per
 *     call, a 180-character reply bills as 200 — and shortening replies to 120
 *     saves nothing, because 120 bills as 200 too.
 *  4. Minutes actually used per month, which decides whether the plan's
 *     included allowance is generous or irrelevant.
 */
function diagnose(rows, sum) {
  const find = (re) => rows.filter((r) => re.test(r.category) && r.price);
  const speech = find(/speech|recognition|stt|gather/i);
  const tts = find(/tts|text-to-speech|polly|speech-synthesis/i);
  const gathers = speech.reduce((n, r) => n + (r.count || 0), 0);
  const speechSpend = speech.reduce((n, r) => n + r.price, 0);
  const ttsSpend = tts.reduce((n, r) => n + r.price, 0);
  const mins = sum.voiceMinutes || 0;

  const perUse = gathers ? speechSpend / gathers : null;
  const turnsPerMin = mins ? gathers / mins : null;
  // Generative list price is $0.0130 per 100 chars; invert the spend to get
  // the characters Twilio actually billed us for.
  const billedChars = ttsSpend ? (ttsSpend / 0.0130) * 100 : null;
  const charsPerTurn = billedChars && gathers ? billedChars / gathers : null;

  const out = [];
  if (perUse == null) out.push({ q: 'Cost per speech recognition', a: 'No speech-recognition charges in this period yet.', ok: null });
  else if (perUse > 0.028) {
    out.push({ q: 'Cost per speech recognition', a: `$${perUse.toFixed(4)} per turn — that is a LEGACY model rate. Twilio's default is $0.02.`,
      ok: false, action: `Set VOICE_STT to an empty value (or remove the speechModel attribute) to use Twilio's default provider. At ${turnsPerMin ? turnsPerMin.toFixed(1) : '~3'} turns/min this is costing roughly $${(((perUse - 0.02) * (turnsPerMin || 3)) * 1000).toFixed(0)} per 1,000 talk-minutes for no benefit.` });
  } else out.push({ q: 'Cost per speech recognition', a: `$${perUse.toFixed(4)} per turn — this is the standard rate. Nothing to fix.`, ok: true });

  if (turnsPerMin != null) {
    out.push({ q: 'Turns per minute', a: `${turnsPerMin.toFixed(2)} — recognition bills per turn, so this is the number that drives cost.`,
      ok: turnsPerMin <= 3.2, action: turnsPerMin > 3.2 ? 'Above ~3 means the agent is chopping the conversation into more turns than it needs. A longer <Gather> is free (flat fee up to 60s), so raising VOICE_SPEECH_TIMEOUT costs nothing and cuts turns.' : '' });
  }
  if (charsPerTurn != null) {
    out.push({ q: 'Characters billed per turn', a: `${Math.round(charsPerTurn)} — this is what Twilio charged for, not what the agent said.`,
      ok: null, action: 'If this is a round multiple of 100 well above what the agent actually speaks, the 100-character minimum is being applied per reply — which means shortening replies below the next 100 saves nothing.' });
  }
  if (mins) out.push({ q: 'Talk-minutes this period', a: `${mins} minutes, all accounts.`, ok: null });
  return { perUse, turnsPerMin, charsPerTurn, gathers, checks: out };
}

module.exports = { usageRecords, summarise, diagnose };
