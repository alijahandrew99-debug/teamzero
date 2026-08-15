// Minimal SMTP client — zero dependencies. Implicit TLS (port 465), which is what
// Gmail/Outlook/most providers accept and avoids STARTTLS negotiation.
//
// Credentials belong to the ACCOUNT OWNER and are stored server-side only; they
// are never sent to the browser (the API returns a masked view).
const tls = require('tls');

/**
 * One SMTP command/response round-trip.
 *
 * CRITICAL: this promise must settle on EVERY terminal socket event, not just a
 * well-formed reply. It previously listened only for 'data', so a timeout, a
 * connection reset, or a dropped TLS session left it pending forever — which
 * stalled the send loop, meaning the job never finished, meaning the per-account
 * send lock was never released and every later send returned "already running"
 * until the process restarted.
 */
function talk(socket, cmd, expect) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
    };
    const onErr = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed unexpectedly')); };
    const onTimeout = () => { cleanup(); try { socket.destroy(); } catch {} reject(new Error('SMTP timed out')); };
    const onData = (d) => {
      buf += d.toString();
      // SMTP replies can be multiline ("250-..."); the final line is "250 ..."
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last || '')) return;
      cleanup();
      const code = parseInt(last.slice(0, 3), 10);
      if (expect && !expect.includes(code)) return reject(new Error(`SMTP ${code}: ${last.slice(4)}`));
      resolve({ code, text: buf });
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
    socket.on('timeout', onTimeout);
    if (cmd !== null) {
      try { socket.write(cmd + '\r\n'); } catch (e) { cleanup(); reject(e); }
    }
  });
}

/**
 * Connect with a hard deadline that cannot clobber the session idle timeout.
 * (The previous version called socket.setTimeout twice, so the connect-phase
 * value silently replaced the idle value for the rest of the session.)
 */
function connectWithDeadline(tlsMod, { host, port }, connectMs, idleMs) {
  const socket = tlsMod.connect({ host, port, servername: host });
  socket.setEncoding('utf8');
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => {
      try { socket.destroy(new Error('SMTP connect timed out')); } catch {}
      rej(new Error('SMTP connect timed out'));
    }, connectMs);
    const onErr = (e) => { clearTimeout(t); rej(e); };
    socket.once('error', onErr);
    socket.once('secureConnect', () => {
      clearTimeout(t);
      socket.removeListener('error', onErr);   // don't leave a stale handler to swallow later errors
      socket.setTimeout(idleMs);               // no callback — talk() owns the 'timeout' event
      res();
    });
  });
  return { socket, ready };
}

function encodeHeader(s) {
  // RFC 2047 for non-ASCII subjects/names
  return /^[\x20-\x7E]*$/.test(s || '') ? (s || '') : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function dotStuff(body) {
  // a line that is just "." would terminate DATA early
  return String(body || '').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

/**
 * Send one email.
 * @param {object} cfg {host, port, user, pass, fromEmail, fromName}
 * @param {object} msg {to, subject, body}
 */
async function sendMail(cfg, msg) {
  const host = cfg.host || 'smtp.gmail.com';
  const port = Number(cfg.port) || 465;
  const from = cfg.fromEmail || cfg.user;

  const { socket, ready } = connectWithDeadline(tls, { host, port }, 20000, 30000);
  try {
    await ready;
    await talk(socket, null, [220]);                              // greeting
    await talk(socket, `EHLO teamzero`, [250]);
    await talk(socket, 'AUTH LOGIN', [334]);
    await talk(socket, Buffer.from(cfg.user).toString('base64'), [334]);
    await talk(socket, Buffer.from(cfg.pass).toString('base64'), [235]);
    await talk(socket, `MAIL FROM:<${from}>`, [250]);
    await talk(socket, `RCPT TO:<${msg.to}>`, [250, 251]);
    await talk(socket, 'DATA', [354]);

    const headers = [
      `From: ${encodeHeader(cfg.fromName || '')} <${from}>`.trim(),
      `To: <${msg.to}>`,
      `Subject: ${encodeHeader(msg.subject || '')}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split('@')[1] || 'dawnpipe'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      // One-click unsubscribe. Gmail and Yahoo REQUIRE these headers from bulk
      // senders — without them mail gets throttled or spam-foldered regardless
      // of content, because the recipient's only exit is the "report spam"
      // button, and complaints are what actually burn a sending domain.
      ...(msg.unsubscribeUrl ? [
        `List-Unsubscribe: <${msg.unsubscribeUrl}>`,
        'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      ] : []),
    ].filter(Boolean).join('\r\n');

    await talk(socket, `${headers}\r\n\r\n${dotStuff(msg.body)}\r\n.`, [250]);
    try { await talk(socket, 'QUIT', [221]); } catch {}
    return { ok: true };
  } finally {
    try { socket.end(); socket.destroy(); } catch {}
  }
}

// Verify credentials without sending anything.
async function verify(cfg) {
  const host = cfg.host || 'smtp.gmail.com';
  const port = Number(cfg.port) || 465;
  const { socket, ready } = connectWithDeadline(tls, { host, port }, 20000, 30000);
  try {
    await ready;
    await talk(socket, null, [220]);
    await talk(socket, 'EHLO teamzero', [250]);
    await talk(socket, 'AUTH LOGIN', [334]);
    await talk(socket, Buffer.from(cfg.user).toString('base64'), [334]);
    await talk(socket, Buffer.from(cfg.pass).toString('base64'), [235]);
    try { await talk(socket, 'QUIT', [221]); } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { socket.end(); socket.destroy(); } catch {}
  }
}

module.exports = { sendMail, verify };
