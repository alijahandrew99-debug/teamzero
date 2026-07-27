// System mailer — the emails Dawnpipe itself sends (password resets, the morning
// "your leads are ready" digest). Separate from the user's own sending mailbox,
// which is only used for their outreach.
//
// Configure with SYSTEM_SMTP_USER / SYSTEM_SMTP_PASS (+ optional HOST/FROM_NAME).
// If unset, system email is disabled and callers degrade gracefully.
require('./env');
const smtp = require('./smtp');

function enabled() {
  return !!(process.env.SYSTEM_SMTP_USER && process.env.SYSTEM_SMTP_PASS);
}

function cfg() {
  return {
    host: process.env.SYSTEM_SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SYSTEM_SMTP_PORT) || 465,
    user: process.env.SYSTEM_SMTP_USER,
    pass: process.env.SYSTEM_SMTP_PASS,
    fromEmail: process.env.SYSTEM_SMTP_FROM || process.env.SYSTEM_SMTP_USER,
    fromName: process.env.SYSTEM_SMTP_FROM_NAME || 'Dawnpipe',
  };
}

async function send(to, subject, body) {
  if (!enabled()) return { ok: false, error: 'system mailbox not configured' };
  try {
    await smtp.sendMail(cfg(), { to, subject, body });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function baseUrl() {
  return (process.env.PUBLIC_URL || 'http://localhost:8090').replace(/\/$/, '');
}

async function sendPasswordReset(to, token) {
  const link = `${baseUrl()}/reset?token=${encodeURIComponent(token)}`;
  return send(to, 'Reset your Dawnpipe password', [
    'Someone asked to reset the password for your Dawnpipe account.',
    '',
    'Use this link to set a new one (valid for 1 hour):',
    link,
    '',
    "If this wasn't you, ignore this email — nothing changes.",
    '',
    '— Dawnpipe',
  ].join('\n'));
}

// The retention loop: tell people their overnight work is waiting.
async function sendMorningDigest(to, { profileName, found, drafted }) {
  return send(to, `${found} new leads found overnight`, [
    `Your sales team worked while you slept.`,
    '',
    `Business: ${profileName}`,
    `Leads found: ${found}`,
    `Emails drafted and waiting for approval: ${drafted}`,
    '',
    `Review and send them here: ${baseUrl()}/app`,
    '',
    '— Dawnpipe',
  ].join('\n'));
}

module.exports = { enabled, send, sendPasswordReset, sendMorningDigest };
