# TeamZero — 7-Day Launch Plan (target: Friday)

## ✅ Done (email accuracy — the bounce fix)
PROSPECTOR no longer ships guessed emails. For every lead it now:
1. Checks the domain can actually receive mail (MX lookup) — dead domains are marked `invalid`.
2. Fetches the company's real contact/about/team pages and extracts **published** addresses.
3. Picks the best one: the person's own address → the company inbox (`info@`) → any published address.
4. Only guesses as a **last resort**, and labels it `GUESS` with a warning in the approval queue.

**Free. No API key, no credits, no limits.** Verified live: 2 of 3 test plants returned real
deliverable addresses instead of guesses.

**Rule to protect your domain:** send to `real email` / `company inbox` freely. Do NOT send to
anything labelled **GUESS** without checking it first — that's what was bouncing.

---

## Day-by-day to Friday

### Day 1 (today) — email accuracy ✅ + get the API key
- [x] Free email finder live
- [ ] **You:** create an Anthropic API key at https://console.anthropic.com → add billing.
      This is the single blocker for everything else. Put it in `.env` as `ANTHROPIC_API_KEY`.
      *(Also makes prospecting far faster and unlocks 50-lead parallel runs.)*

### Day 2 — go live (get a public URL)
- [ ] Put this folder in a GitHub repo (private is fine).
- [ ] Render.com → New + → Blueprint → pick the repo (it reads `render.yaml`).
- [ ] Paste `ANTHROPIC_API_KEY`, set `PUBLIC_URL` to the URL Render gives you,
      `DEV_UNLOCK=0`, `OWNER_EMAILS=btk18000@gmail.com`.
- [ ] Open the live URL, sign up as yourself → you should get in free (OWNER badge).

### Day 3 — turn on payments
- [ ] Stripe → Product + recurring Price ($49/mo) → copy the **Price ID**.
- [ ] Stripe → API keys → copy **Secret key**.
- [ ] Stripe → Webhooks → endpoint `https://YOUR_URL/webhook/stripe`, events:
      `checkout.session.completed`, `customer.subscription.updated`,
      `customer.subscription.deleted` → copy **Signing secret**.
- [ ] Add all three to Render env vars → redeploy.
- [ ] **Test with a real card in Stripe test mode**: sign up as a second email, confirm
      it's locked, pay, confirm it unlocks.

### Day 4 — make it look like a product
- [ ] Add the TeamZero logo/hero to the landing page.
- [ ] Tighten the landing copy + pricing.
- [ ] Load your own profiles (APenergy stays **private** — never in demos).

### Day 5 — dogfood: let it sell itself
- [ ] Run PROSPECTOR on the TeamZero profile for 20–30 agency/SDR founders.
- [ ] Verify emails (real/company-inbox only), personalize the top 10 by hand.
- [ ] Send them. This is your launch campaign *and* your proof.

### Day 6 — soft launch
- [ ] Give 3–5 people free access via `OWNER_EMAILS` and watch them use it.
- [ ] Fix whatever confuses them. Check Render logs for errors.

### Day 7 (Friday) — market it
- [ ] Post where your buyers are: indie-hacker / agency / sales communities.
- [ ] Lead with the demo that closes it: *"an AI found you and wrote this email."*

---

## Deliverability — read this before you send at volume
Fixing the addresses solves bounces. It does **not** solve sender reputation:
- Don't blast from your main Gmail. For real volume use a **separate sending domain**
  and warm it up (2–3 weeks of low volume ramping) before pushing hard.
- Start small: 10–20/day from a new address, grow slowly.
- Every send is human-approved here — keep it that way; it's your compliance layer.
- Bounces above ~3% get you filtered. The `GUESS` label exists to keep you under that.

## Known limits (be honest with buyers)
- Emails are drafted, not auto-sent — you send from your own inbox (Gmail button).
- VOICE is off until TCPA review.
- Lead sourcing is web-research based; `GUESS`-labelled emails need manual checking.
