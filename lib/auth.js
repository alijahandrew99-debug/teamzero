// Auth — password hashing (scrypt, built-in crypto) + signed session cookies.
// No dependencies.
require('./env');
const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, passHash: hash };
}
function verifyPassword(password, salt, passHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(passHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signed cookie: token.hmac — hmac ties the token to SESSION_SECRET so it can't
// be forged. The token itself also indexes a server-side session record.
function secret() { return process.env.SESSION_SECRET || 'dev-insecure-secret'; }
function sign(token) {
  const mac = crypto.createHmac('sha256', secret()).update(token).digest('hex').slice(0, 32);
  return `${token}.${mac}`;
}
function unsign(signed) {
  if (!signed || !signed.includes('.')) return null;
  const [token, mac] = signed.split('.');
  const good = crypto.createHmac('sha256', secret()).update(token).digest('hex').slice(0, 32);
  if (mac && mac.length === good.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return token;
  return null;
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Returns the logged-in account for a request, or null.
function currentAccount(req) {
  const signed = parseCookies(req)['tz_session'];
  const token = unsign(signed);
  if (!token) return null;
  const sess = db.getSession(token);
  if (!sess) return null;
  return db.getAccount(sess.accountId);
}

function sessionCookie(token) {
  const secure = (process.env.PUBLIC_URL || '').startsWith('https') ? ' Secure;' : '';
  return `tz_session=${encodeURIComponent(sign(token))}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`;
}
function clearCookie() {
  return `tz_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = { hashPassword, verifyPassword, currentAccount, sessionCookie, clearCookie, parseCookies };
