// Closing the booking loop.
//
// The pitch to a contractor is "it books the job". Until now a booking wrote a
// row to disk and stopped there: the caller got nothing, and the owner only
// found out if he happened to open the Voice tab. Nobody judges the product on
// a JSON file — they judge it on the text message that arrives while they're
// still holding the phone.
//
// Zero dependencies: Twilio REST over fetch (same Basic-auth pattern as
// placeCall), the existing system mailbox, and a hand-built .ics string.
require('./env');
const mailer = require('./mailer');

// ---------------- SMS ----------------
function smsConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
}

async function sendSMS(to, body, from) {
  if (!smsConfigured()) return { ok: false, error: 'SMS not configured' };
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from || process.env.TWILIO_PHONE_NUMBER, Body: body }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.message || `Twilio ${r.status}` };
    return { ok: true, sid: data.sid };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------- calendar invite ----------------
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsStamp(d) { return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

/** A minimal but valid VEVENT — opens straight into iPhone/Google/Outlook calendars. */
function buildICS({ title, description, startsAt, minutes = 30, location = '', organiserEmail = '', uid }) {
  const start = new Date(startsAt);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + minutes * 60000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dawnpipe//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid || Date.now()}@dawnpipe`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
    description ? `DESCRIPTION:${icsEscape(description)}` : '',
    location ? `LOCATION:${icsEscape(location)}` : '',
    organiserEmail ? `ORGANIZER:mailto:${organiserEmail}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function prettyWhen(startsAt, fallback) {
  const d = new Date(startsAt);
  if (isNaN(d.getTime())) return fallback || 'a time to be confirmed';
  return d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Fire the whole loop for one booking. Every leg fails soft and is reported —
 * a booking must never be lost because a text failed.
 */
async function announceBooking({ appointment, profile, account }) {
  const out = { sms: null, email: null };
  const biz = (profile && profile.name) || 'the team';
  const when = prettyWhen(appointment.startsAt, appointment.whenText);

  // 1. the caller gets a confirmation while they're still holding the phone.
  // It must come FROM this business's own line and point back at it. Falling
  // back to the shared TWILIO_PHONE_NUMBER meant a customer's caller got a
  // text from Dawnpipe's demo number telling them to ring Dawnpipe to change
  // an appointment with a plumber — wrong sender, wrong callback, and a
  // stranger's booking landing on our own demo line.
  if (appointment.phone) {
    // A customer must text from THEIR line, never ours. The one exception is
    // the owner's demo line, which legitimately runs on the shared server
    // number — and the demo's whole payoff is the confirmation text landing on
    // the prospect's phone. Without this the demo booked, said "you'll get a
    // text", and nothing arrived.
    const owners = String(process.env.OWNER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    const isOwner = owners.includes(String(account.email || '').toLowerCase());
    const mine = (account.voice && account.voice.number) || (isOwner ? (process.env.TWILIO_PHONE_NUMBER || '') : '');
    const backline = (account.voice && account.voice.transferTo) || mine;
    if (mine) {
      out.sms = await sendSMS(appointment.phone,
        `${biz}: you're booked for ${when}. ${appointment.reason ? `Re: ${appointment.reason}. ` : ''}`
        + (backline ? `Need to change it? Call ${backline}. ` : '')
        + `Reply STOP to opt out.`, mine);
    } else {
      // No line of their own = no honest sender. Skip rather than sign a text
      // from another company.
      out.sms = { ok: false, error: 'no sending number for this account' };
    }
  }

  // 2. the owner gets it in their inbox with a one-tap calendar invite
  if (mailer.enabled() && account.email) {
    const ics = buildICS({
      title: `${appointment.name || 'Caller'}${appointment.company ? ` (${appointment.company})` : ''} — ${appointment.reason || 'callback'}`,
      description: [`Booked by your Dawnpipe AI on a ${appointment.source || 'call'}.`,
        `Name: ${appointment.name || '-'}`, `Phone: ${appointment.phone || '-'}`,
        appointment.email ? `Email: ${appointment.email}` : '',
        `Wants: ${appointment.reason || '-'}`, `Their words: ${appointment.whenText || '-'}`].filter(Boolean).join('\n'),
      startsAt: appointment.startsAt, minutes: 30, organiserEmail: account.email, uid: appointment.id,
    });
    const body = [
      `Your AI just booked an appointment.`, '',
      `  Who:   ${appointment.name || 'Caller'}${appointment.company ? ` · ${appointment.company}` : ''}`,
      `  When:  ${when}`,
      `  Phone: ${appointment.phone || '-'}`,
      appointment.email ? `  Email: ${appointment.email}` : '',
      `  Wants: ${appointment.reason || 'callback'}`,
      '', `They asked for it as: "${appointment.whenText || '-'}"`,
      '', ics ? 'A calendar invite is attached.' : 'No firm time was captured — call them back to pin it down.',
      '', `See it in Dawnpipe: ${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/app`,
    ].filter(Boolean).join('\n');
    out.email = await mailer.send(account.email, `📅 ${appointment.name || 'A caller'} booked ${when}`, body,
      ics ? { filename: 'appointment.ics', contentType: 'text/calendar; method=PUBLISH', content: ics } : null);
  }
  return out;
}

/** After-hours / missed-call style summary so the owner knows what happened. */
async function callSummary({ account, profile, call, outcome }) {
  if (!mailer.enabled() || !account.email) return null;
  const lines = (call.transcript || call.turns || []).map((t) => `${t.who === 'caller' ? 'Caller' : 'AI'}: ${t.text}`).join('\n');
  return mailer.send(account.email,
    `Call ${outcome} — ${call.from || call.to || 'unknown number'}`,
    [`Your AI handled a call for ${(profile && profile.name) || 'your business'}.`, '',
      `From: ${call.from || '-'}`, `Outcome: ${outcome}`, `Length: ${call.durationSec || 0}s`,
      '', '--- what was said ---', lines || '(no transcript)'].join('\n'));
}

module.exports = { sendSMS, smsConfigured, buildICS, announceBooking, callSummary, prettyWhen };
