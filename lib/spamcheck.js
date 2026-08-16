// Spam-signal linter for generated copy.
//
// Filters score a message before a human ever sees it. The AI writes decent
// copy, but one all-caps subject or a "100% FREE guarantee" phrase can tank an
// otherwise good campaign — and the user has no way to know why. This flags the
// specific signals, in plain language, before they approve.
//
// Deliberately conservative: every flag names the exact offending text so the
// user can judge it. Zero dependencies.

// Phrases with a long history in spam corpora. Weighted: some are near-fatal,
// others only matter in combination.
const TRIGGERS = [
  { re: /\b100%\s*(free|guaranteed?|risk[- ]free)\b/i, w: 3, why: '"100% free/guaranteed" is a classic filter trigger' },
  { re: /\brisk[- ]free\b/i, w: 2, why: '"risk-free" is heavily filtered' },
  { re: /\bact now\b/i, w: 3, why: '"act now" reads as high-pressure spam' },
  { re: /\blimited time (only|offer)\b/i, w: 2, why: '"limited time offer" is a common spam phrase' },
  { re: /\bclick here\b/i, w: 2, why: '"click here" is one of the most-filtered phrases in email' },
  { re: /\bbuy (now|direct)\b/i, w: 2, why: '"buy now" signals bulk advertising' },
  { re: /\bno obligation\b/i, w: 2, why: '"no obligation" is a telemarketing tell' },
  { re: /\bcash bonus\b|\bextra cash\b|\bmake money\b/i, w: 3, why: 'money-making language is a strong spam signal' },
  { re: /\bwinner\b|\byou have been selected\b|\bcongratulations\b/i, w: 3, why: 'prize/selection language is heavily filtered' },
  { re: /\bguarantee(d)?\b/i, w: 1, why: '"guarantee" adds spam weight (fine in moderation)' },
  { re: /\bfree\b/i, w: 1, why: '"free" adds spam weight — fine once, risky repeated' },
  { re: /\burgent\b|\bimmediately\b/i, w: 2, why: 'urgency words raise the spam score' },
  { re: /\bcheap(est)?\b|\blowest price\b|\bdiscount\b/i, w: 2, why: 'price-bait language is filtered' },
  { re: /\bunsecured\b|\bcredit\b.*\bapprov/i, w: 3, why: 'credit/loan phrasing is aggressively filtered' },
  { re: /\bthis (isn't|is not) spam\b|\bnot spam\b/i, w: 4, why: 'saying "this is not spam" is itself a top spam signal' },
  { re: /\$\$+|€€+/, w: 3, why: 'repeated currency symbols ($$$) is a spam hallmark' },
  { re: /\bviagra\b|\bpharmacy\b|\bcasino\b|\bcrypto\b/i, w: 4, why: 'this word is on nearly every blocklist' },
];

const LINK_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

function capsRatio(s) {
  const letters = (s || '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return 0;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  return caps / letters.length;
}

/**
 * Analyse a drafted email.
 * @returns {{score:number, level:'clean'|'caution'|'risky', flags:Array<{sev,msg}>}}
 *   score is a risk number (0 = clean). level drives the UI treatment.
 */
function analyze({ subject = '', body = '', autoFooter = false } = {}) {
  const flags = [];
  let score = 0;
  const add = (sev, msg, w) => { flags.push({ sev, msg }); score += w; };

  const subj = (subject || '').trim();
  const text = (body || '').trim();
  const all = `${subj}\n${text}`;

  // ---- subject ----
  if (!subj) add('high', 'No subject line — empty subjects are filtered almost universally.', 4);
  else {
    if (capsRatio(subj) > 0.6) add('high', `Subject is mostly capital letters ("${subj.slice(0, 40)}") — reads as shouting and is a strong spam signal.`, 4);
    if (subj.length > 70) add('low', `Subject is ${subj.length} characters — long subjects get truncated on mobile and lower open rates. Aim for under 60.`, 1);
    if (/!{2,}|\?{2,}/.test(subj)) add('med', 'Subject has repeated punctuation (!! or ??) — a common filter trigger.', 2);
    if (/^re:|^fwd:/i.test(subj)) add('high', 'Subject fakes a reply ("Re:"/"Fwd:") on a first-contact email. This is deceptive, and recipients report it as spam.', 4);
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(subj)) add('low', 'Emoji in the subject line — fine for consumer mail, but it lowers trust in B2B cold outreach.', 1);
  }

  // ---- body ----
  if (!text) add('high', 'Empty body.', 5);
  else {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 20) add('med', `Body is only ${words} words — very short messages with a link look like bait.`, 2);
    if (words > 220) add('low', `Body is ${words} words — cold emails over ~200 words get skimmed and deleted. Tighten it.`, 1);
    if (capsRatio(text) > 0.35) add('high', 'Body is largely capital letters — strong spam signal.', 4);

    const links = text.match(LINK_RE) || [];
    if (links.length > 2) add('med', `${links.length} links in a first-touch email — more than two sharply raises spam scoring. One is ideal.`, 3);
    // image-only / link-only body: almost no prose around the markup
    const prose = text.replace(LINK_RE, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (prose.length < 40 && (links.length || /<img|\.(png|jpe?g|gif)\b/i.test(text))) {
      add('high', 'This is effectively an image/link-only message with almost no text. Filters treat those as advertising.', 5);
    }
    if (/<img\b/i.test(text)) add('med', 'Contains an embedded image — plain-text-looking cold email consistently outperforms and is filtered less.', 2);
    if (/\btrack(ing)?\s*pixel\b/i.test(text)) add('med', 'Mentions a tracking pixel.', 2);
  }

  // ---- trigger phrases (scan subject + body together) ----
  for (const t of TRIGGERS) {
    const m = all.match(t.re);
    if (m) add(t.w >= 3 ? 'high' : t.w === 2 ? 'med' : 'low', `${t.why} — found "${String(m[0]).slice(0, 30)}".`, t.w);
  }

  // ---- compliance-adjacent ----
  // When the send path stamps the CAN-SPAM footer automatically (address +
  // unsubscribe link), the draft is CORRECT to omit it — flagging it here made
  // every single draft look spam-risky for a footer it was guaranteed to get.
  if (!autoFooter && !/unsubscribe|opt.?out|reply\s+stop/i.test(text)) {
    add('med', 'No opt-out language in the body. An easy, honest way out reduces spam complaints (and CAN-SPAM requires one).', 3);
  }

  const level = score >= 8 ? 'risky' : score >= 3 ? 'caution' : 'clean';
  return { score, level, flags };
}

module.exports = { analyze };
