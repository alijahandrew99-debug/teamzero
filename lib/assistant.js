// The in-app assistant — the help bubble in the bottom-right corner.
//
// Its whole advantage over a docs page is that it KNOWS THIS ACCOUNT: whether
// the number exists, whether the mailbox is connected, what plan they're on,
// how many minutes are left. So "why isn't it sending?" gets "your mailbox
// isn't connected — Your Business tab, SENDING section", not a paragraph of
// maybes. It answers questions and points; it does not push buttons. The one
// power it has is a GO:<tab> line at the end of a reply, which the app turns
// into a "Take me there" button — navigation only, never an action.
//
// Cost: Haiku with the system block cached — about a fifth of a cent per
// message. The rate limit in server.js bounds even a hammering user to
// pennies a day.
require('./env');
const db = require('./db');
const plans = require('./plans');

const NL = String.fromCharCode(10);

/** What the app IS, tab by tab — the assistant's map of the territory. */
const APP_MAP = [
  'THE APP, TAB BY TAB:',
  '- YOUR BUSINESS tab: the business profile (name, what you sell, who to, tone). The AI answers callers and writes emails FROM this, so thin profile = thin answers. Also here: the SENDING section (connect their own mailbox via SMTP app password), Deliverability (SPF/DKIM/DMARC check with a Check DNS button), business mailing address (required by law in every email), daily send cap and send window.',
  '- SALES DESK tab: find leads (describe the customer, it finds real companies + verified emails), drafts a personal email per lead, APPROVAL QUEUE (nothing sends unapproved). "Approve all", "Approve & send all", a STOP SENDING button, and "Adjust all drafts" (one instruction rewrites every queued draft, then back to pending).',
  '- CALL-BACKS tab: the hosted request form (share link or embed; person ticks consent, AI calls them back in about a minute during 9am-8pm), missed-call text-a-YES-offer toggle, and "ring someone back yourself" for a caller who left their number within 90 days. Automated COLD calling of strangers does not exist here: it is illegal for AI voices (TCPA), which is why call-backs exist instead.',
  '- AI ANSWERING tab: their phone line. Get a number, switch answering on/off, pick the agent name and voice (10 voices, Spanish included), custom greeting, transfer number, ON-CALL LIST for emergencies (days: transfer number first; nights 8pm-8am: on-call list first), business hours, booking slot length, timezone, FAQ text the AI may quote, call recording toggle, voicemail message for call-backs, recent calls with recordings and transcripts, and the monthly stats.',
  '- CALENDAR tab: appointments the AI booked, with confirm/cancel.',
  '- PLANS: the "Choose a plan" button opens the plan chooser. Front Desk $499 (500 min + 200 leads) is the flagship; Starter $99, Growth $299, Scale $699 leads-only; Complete $1,499 (1,000 min + 2,000 leads). Every plan: 7-day free trial, card required, nothing charged until day 8, cancel in one click (Cancel plan button in the same chooser — never blocked). Plans do not stack; TOP-UP PACKS do (+250 min $79, +500 leads $199, +2,000 leads $699 — one-time, roll over, never automatic). No overage charges ever: allowances pause.',
  'SETUP ORDER THAT WORKS: 1) fill the business profile (or paste the website and let AI draft it), 2) connect the mailbox + pass the DNS check, 3) get the phone number and switch answering on, 4) set transfer + on-call numbers, 5) test-call your own line, 6) find first leads and approve.',
  'HONESTY RULES: text messages (booking confirmation texts, missed-call texts) are BUILT but may be filtered by US carriers until the business completes carrier registration — if asked, say so plainly and do not promise dates. Never invent features. If something looks broken, say what to check and suggest emailing support@dawnpipe.com rather than guessing.',
].join(NL);

/** This customer's live situation, so answers are about THEM. */
function stateBrief(account, owner) {
  const u = plans.usage(account, owner);
  const v = account.voice || {};
  const prof = db.getProfiles(account.id)[0] || {};
  const bits = [
    'THIS CUSTOMER RIGHT NOW:',
    `- Plan: ${owner ? 'owner account (unlimited)' : (u.isPro ? u.tierName + (account.subStatus === 'trialing' ? ' (on free trial, card not yet charged)' : '') : 'NO PLAN YET — they need to pick one before AI work runs')}${account.cancelAt ? ' — CANCELLATION PENDING, ends ' + String(account.cancelAt).slice(0, 10) : ''}`,
    owner ? '' : `- Leads: ${u.used} used of ${u.limit}${u.topupLeads ? ' (includes ' + u.topupLeads + ' top-up)' : ''}. Phone minutes: ${u.voice.used} used of ${u.voice.limit}.`,
    `- Phone line: ${v.number ? v.number + (v.enabled === false ? ' but ANSWERING IS SWITCHED OFF' : ', answering on') : 'NO NUMBER YET — AI Answering tab, "Get my number"'}.`,
    `- Transfer to human: ${v.transferTo ? 'set' : 'NOT SET — emergencies will take a message instead of ringing anyone'}. On-call list: ${Array.isArray(v.onCall) && v.onCall.length ? v.onCall.length + ' number(s)' : 'empty'}.`,
    `- Sending mailbox: ${account.smtp && account.smtp.pass ? 'connected (' + (account.smtp.user || '') + ')' : 'NOT CONNECTED — emails cannot send until this is done (Your Business tab, SENDING)'}.`,
    `- Business mailing address: ${prof.mailingAddress ? 'set' : 'MISSING — sending is blocked without it (legal requirement)'}.`,
    `- Business profile: ${prof.offer && !/edit me/i.test(prof.offer) ? 'filled in' : 'MOSTLY EMPTY — the AI has little to work from'}.`,
    `- Call-back request form: ${account.formSlug ? 'live at /f/' + account.formSlug : 'created on first visit to the Call-backs tab'}. Missed-call offer: ${v.callBackMissed === true ? 'on' : 'off'}.`,
    `- Call recording: ${v.record === false ? 'off' : 'on (greeting discloses it)'}.`,
  ].filter(Boolean);
  return bits.join(NL);
}

const RULES = [
  'HOW TO ANSWER:',
  '- You are the Dawnpipe assistant, talking to the business owner inside the app. Warm, brisk, concrete. Two to five sentences for most answers.',
  '- ALWAYS ground answers in THIS CUSTOMER RIGHT NOW above. If their real blocker is visible there (no mailbox, no number, answering off), lead with it even if they asked something else.',
  '- Give exact click-paths: tab name, then the section or button, in bold-free plain words.',
  '- If pointing them at ONE tab would help, end the reply with a final line exactly like: GO:voice   (valid: business, desk, coldcall, voice, calendar, plans). Only one GO line, only when it helps, nothing after it.',
  '- Never discuss other customers, internal costs, commissions, or anything not in this prompt. Pricing questions: quote only the plan facts above.',
  '- You cannot change settings, send emails, place calls, or spend money. You point; the human clicks. If they ask you to do one of those, say what to click instead.',
  '- Stuck beyond what you can see, or angry, or a billing dispute: give support@dawnpipe.com and say a human reads it.',
].join(NL);

/**
 * One assistant turn. History is [{who:'you'|'assistant', text}], newest last.
 */
async function answer(account, owner, history, message) {
  const ai = require('./ai');
  const profile = db.getProfiles(account.id)[0] || {};
  const system = ['You are the in-app assistant for Dawnpipe (dawnpipe.com), an AI receptionist + outreach product for small service businesses.',
    '', APP_MAP, '', RULES].join(NL);
  const convo = (Array.isArray(history) ? history : []).slice(-10)
    .map((m) => (m.who === 'assistant' ? 'Assistant: ' : 'Owner: ') + String(m.text || '').slice(0, 500)).join(NL);
  const prompt = [
    stateBrief(account, owner), '',
    convo ? 'CONVERSATION SO FAR:' + NL + convo : '',
    'Owner: ' + String(message || '').slice(0, 600),
    'Assistant:',
  ].filter(Boolean).join(NL);
  const raw = await ai.callAI(prompt, { maxTokens: 400, tier: 'draft', timeoutMs: 25000, system });
  let text = String(raw || '').trim();
  let go = '';
  const m = text.match(/GO:(business|desk|coldcall|voice|calendar|plans)\s*$/);
  if (m) { go = m[1]; text = text.slice(0, m.index).trim(); }
  return { text: text || 'Sorry — I lost my train of thought. Ask me that again?', go };
}

module.exports = { answer, stateBrief, APP_MAP };
