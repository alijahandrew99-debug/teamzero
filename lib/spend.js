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

module.exports = { usageRecords, summarise };
