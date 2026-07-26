# TeamZero Cloud — the sellable AI sales team

A **multi-tenant SaaS**: buyers sign up, pay, and use it with **zero setup**. The AI
runs server-side on **one API key you own** — buyers never touch it. Zero npm
dependencies: raw Node, deploys anywhere that runs Node 18+.

- **PROSPECTOR** finds real leads by live web research · **OUTBOUND** drafts the emails
  · **SCOUT** weekly intel · **VOICE** off (TCPA-gated)
- Accounts + login, per-tenant data isolation, Stripe subscription billing, approval
  queue (nothing sends without the user).

---

## Run it locally (no keys needed)
Uses your local `claude` CLI as the brain and unlocks billing for testing.
```bash
cd "C:\claude code\teamzero-cloud"
node server.js
```
or double-click `START-LOCAL.bat`, then open http://localhost:8090.
The included `.env` has `DEV_UNLOCK=1` and `ALLOW_CLI_FALLBACK=1`.

---

## Take it live (what YOU do once — buyers do nothing)

### 1. Get the AI key (powers every buyer)
- https://console.anthropic.com → API Keys → create one. Add billing.
- This single key serves all buyers. Set it as `ANTHROPIC_API_KEY`.

### 2. Set up billing with Stripe
- https://dashboard.stripe.com → create a **Product** with a recurring **Price**
  (e.g. $49/mo). Copy the **Price ID** (`price_...`) → `STRIPE_PRICE_ID`.
- Developers → **API keys** → copy the **Secret key** (`sk_...`) → `STRIPE_SECRET_KEY`.
- Developers → **Webhooks** → add endpoint `https://YOUR_URL/webhook/stripe`,
  events: `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`. Copy the **Signing secret** (`whsec_...`) →
  `STRIPE_WEBHOOK_SECRET`.

### 3. Deploy (easiest: Render.com, free-ish tier)
1. Put this folder in a GitHub repo (private is fine).
2. Render → **New +** → **Blueprint** → pick the repo. It reads `render.yaml`.
3. Paste the secrets when asked: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and `PUBLIC_URL` (your live
   `https://...` URL). `DEV_UNLOCK` and `ALLOW_CLI_FALLBACK` are already `0` for prod.
4. Deploy. Your live sales team is at the URL Render gives you.

> Any Node host works (Railway, Fly.io, a VPS). No build step — it's `node server.js`.
> Point a custom domain at it and update `PUBLIC_URL`.

### Free access for you (the creator)
Set `OWNER_EMAILS` to your email (comma-separated for multiple). Those accounts
use TeamZero **free forever** — they bypass billing while everyone else must
subscribe. Already set to `btk18000@gmail.com` in `.env`. Add demo/comp accounts
here too when you want to give someone a free look.

### 4. (Optional) Load Profile #0 and let it sell itself
Sign up on your own live site, fill the profile in as **TeamZero**, hit
**Find leads + draft emails**, approve, send. Your first customers are prospected
by the product itself.

---

## How it's built (for later you)
- `server.js` — raw http server: routing, auth gate, billing gate, Stripe webhook.
- `lib/db.js` — account-scoped JSON store (swap for Postgres later; interface is small).
- `lib/ai.js` — `callAI()`: Anthropic API in prod, local `claude` CLI fallback in dev.
- `lib/auth.js` — scrypt password hashing + signed session cookies (built-in crypto).
- `lib/stripe.js` — Checkout + webhook verification via Stripe REST (no SDK).
- `lib/agents.js` — PROSPECTOR / OUTBOUND / SCOUT.
- `views/` — landing (sales page), signup, login, app (operator desk).

## Notes
- Data lives in `/data` as JSON. On Render, the mounted disk in `render.yaml`
  persists it across deploys. For serious scale, move `lib/db.js` to Postgres.
- VOICE (cold AI calling) stays disabled until attorney TCPA review.
- Every email is human-approved before sending — that gate is the compliance layer.
