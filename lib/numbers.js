// Buying and wiring up a phone number per customer.
//
// Until now every account shared the one TWILIO_PHONE_NUMBER from the server
// environment, which meant a second voice customer was impossible: inbound
// calls resolved to whichever account was created first, so tenant B's callers
// reached tenant A's agent and booked into tenant A's calendar. This module is
// what makes voice sellable to more than one customer.
//
// Numbers cost real money (~$1.15/mo each) and are billed to OUR Twilio
// account, so provisioning is gated on the plan by the caller.
const API = 'https://api.twilio.com/2010-04-01';

function creds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio is not configured on the server.');
  return { sid, token, auth: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') };
}

async function twilio(path, { method = 'GET', form, timeoutMs = 15000 } = {}) {
  const { sid, auth } = creds();
  const url = `${API}/Accounts/${sid}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Twilio's own message is far more useful than the status code
    // ("Not enough funds", "area code has no numbers"), so surface it.
    throw new Error(data.message || `Twilio ${r.status}`);
  }
  return data;
}

/** Numbers available to buy. areaCode is optional; without it Twilio picks. */
async function search({ areaCode = '', country = 'US', limit = 8 } = {}) {
  const q = new URLSearchParams({ VoiceEnabled: 'true', SmsEnabled: 'true', PageSize: String(limit) });
  const ac = String(areaCode || '').replace(/[^0-9]/g, '');
  if (ac) q.set('AreaCode', ac);
  const data = await twilio(`/AvailablePhoneNumbers/${country}/Local.json?${q}`);
  return (data.available_phone_numbers || []).map((n) => ({
    phoneNumber: n.phone_number,
    friendly: n.friendly_name,
    locality: n.locality || '',
    region: n.region || '',
  }));
}

/**
 * Buy a number and point it at this server in the same call. Twilio accepts the
 * webhook URLs on the purchase request, so the number can never exist in a
 * configured-but-not-wired state where a caller reaches a dead line.
 */
async function buy({ phoneNumber, base, friendlyName = 'Dawnpipe' }) {
  if (!phoneNumber) throw new Error('No number chosen.');
  if (!/^https:\/\//.test(base || '')) throw new Error('PUBLIC_URL must be a live https URL before buying a number.');
  const data = await twilio('/IncomingPhoneNumbers.json', {
    method: 'POST',
    form: {
      PhoneNumber: phoneNumber,
      FriendlyName: friendlyName,
      VoiceUrl: `${base}/voice/incoming`,
      VoiceMethod: 'POST',
      StatusCallback: `${base}/voice/status`,
      StatusCallbackMethod: 'POST',
      // Texts to the number reach the same agent. Without this, a reply to a
      // missed-call text-back or a booking confirmation went nowhere.
      SmsUrl: `${base}/sms/incoming`,
      SmsMethod: 'POST',
    },
    timeoutMs: 25000,
  });
  return { phoneNumber: data.phone_number, sid: data.sid };
}

/** Re-point an already-owned number, e.g. after a domain move. */
async function rewire({ numberSid, base }) {
  if (!numberSid) throw new Error('No number to update.');
  if (!/^https:\/\//.test(base || '')) throw new Error('PUBLIC_URL must be a live https URL.');
  const data = await twilio(`/IncomingPhoneNumbers/${numberSid}.json`, {
    method: 'POST',
    form: {
      VoiceUrl: `${base}/voice/incoming`,
      VoiceMethod: 'POST',
      StatusCallback: `${base}/voice/status`,
      StatusCallbackMethod: 'POST',
      SmsUrl: `${base}/sms/incoming`,
      SmsMethod: 'POST',
    },
  });
  return { phoneNumber: data.phone_number, sid: data.sid };
}

/** Give the number back so we stop paying the monthly rental for it. */
async function release(numberSid) {
  if (!numberSid) return { ok: true };
  const { sid, auth } = creds();
  const r = await fetch(`${API}/Accounts/${sid}/IncomingPhoneNumbers/${numberSid}.json`, {
    method: 'DELETE',
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(15000),
  });
  // 404 means it is already gone, which is the state we wanted anyway.
  if (!r.ok && r.status !== 404) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.message || `Twilio ${r.status}`);
  }
  return { ok: true };
}

module.exports = { search, buy, rewire, release };
