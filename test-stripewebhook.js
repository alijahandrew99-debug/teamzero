// Stripe webhook signature verification. A valid signature with a stale
// timestamp used to verify forever (no replay window) -- a captured header
// (logs, a compromised proxy, browser history on a shared machine) could
// replay the same event indefinitely. Run: node test-stripewebhook.js
process.env.DATA_DIR = process.env.DATA_DIR || require('path').join(require('os').tmpdir(), 'dp-stripewh-' + Date.now());
require('fs').mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_testsecret';

const crypto = require('crypto');
const stripe = require('./lib/stripe');

let pass = 0, fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : '')); }
}

const secret = process.env.STRIPE_WEBHOOK_SECRET;
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {} } });
function header(ts) {
  const signed = `${ts}.${body}`;
  const v1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${ts},v1=${v1}`;
}

const now = Math.floor(Date.now() / 1000);

ok('a fresh, correctly signed event verifies', !!stripe.verifyWebhook(body, header(now)));
ok('a correctly signed event from 10 minutes ago is rejected (outside 300s tolerance)', !stripe.verifyWebhook(body, header(now - 600)));
ok('a correctly signed event from 10 minutes in the future is rejected', !stripe.verifyWebhook(body, header(now + 600)));
ok('a correctly signed event just inside the 300s window still verifies', !!stripe.verifyWebhook(body, header(now - 200)));
ok('a bad signature is rejected regardless of a fresh timestamp', !stripe.verifyWebhook(body, `t=${now},v1=deadbeef`));
ok('a missing timestamp is rejected', !stripe.verifyWebhook(body, `v1=${crypto.createHmac('sha256', secret).update(`undefined.${body}`).digest('hex')}`));
ok('a custom (shorter) tolerance is honoured', !stripe.verifyWebhook(body, header(now - 100), 60));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
