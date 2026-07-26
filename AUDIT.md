# TeamZero — Subscription Product Audit

Reviewed as a paid SaaS, not a demo. Findings ordered by **revenue impact**, not effort.

---

## ✅ FIXED IN THIS PASS

### 1. "Start free" was a lie → near-zero conversion  🔴 CRITICAL
**Was:** with billing on, a new signup was locked out immediately. They saw a paywall
before a single lead. Nobody buys software they haven't used — this alone would have
capped you near 0% conversion.
**Now:** every new account gets **15 real leads free, no card**. The paywall moves to
*after* the aha-moment. A trial meter shows what's left; the upgrade ask appears when
they're already getting value.

> **Why this is the single highest-leverage change:** in self-serve SaaS, the conversion
> event isn't the pricing page — it's the moment the product does the job. Charging
> before that moment is the #1 reason small SaaS products fail to convert.

### 2. Unmetered usage = negative unit economics  🔴 CRITICAL
**Was:** any user could run unlimited 50-lead jobs. Each 50-lead run ≈ 60 AI calls with
web search. A heavy user could cost **more than $49/mo** — meaning growth *loses* money.
**Now:** hard quotas. Trial = 15 leads (one-time). Pro = 500 leads/month, resetting
monthly. Over-requests are **clamped, not rejected** (ask for 50 on trial → get 15),
which protects margin without a jarring error.

> **Know your margin:** track your Anthropic spend per 100 leads in week 1. If 500
> leads/mo costs more than ~$15, either raise the price or lower the cap. Never sell a
> plan whose ceiling you haven't costed.

### 3. No Terms / Privacy → Stripe would reject you  🔴 BLOCKER
**Was:** neither page existed. Stripe requires both to approve a subscription business,
and you're processing personal data (leads) + sending email, so it's a legal requirement too.
**Now:** `/terms` and `/privacy` live, linked in the footer, written plainly and honestly —
covering AI inaccuracy, who the sender is (the user, not you), anti-spam duties,
billing/cancellation, data deletion rights, and mailbox-credential handling.
**Action:** replace the contact email with a real support address before taking payments.

---

## ✅ ALSO FIXED IN THIS PASS

### 4. Password reset  — DONE
`/forgot` → emailed reset link (1-hour, single-use token) → `/reset`. Uses a **system
mailbox** (`SYSTEM_SMTP_*`). "Forgot password?" link added to login. Reveals nothing about
whether an email is registered. Verified end-to-end.

### 7. Rate limiting — DONE
Per-IP throttles on `/login` (10 / 15 min), `/signup` (5 / hr), `/forgot` (5 / 15 min).
Stops brute-force and trial-farming.

### 8. Session pruning — DONE
Expired sessions + reset tokens are reaped every 10 min, so the files can't grow forever.

### 9. Morning "your leads are ready" email — DONE
When the night shift finishes, the user gets a digest: *"23 new leads found overnight →"*.
This is the retention loop. Needs the system mailbox configured to actually fire.

## 🟠 DO BEFORE YOU HAVE 100 USERS

### 5. JSON files won't survive real traffic
`data/*.json` is rewritten whole on every change. With concurrent users you *will* get
lost writes and eventually a corrupted file. Fine for 10 users, fatal at 1,000.
**Fix:** move `lib/db.js` to Postgres (its interface is small and deliberately swappable).
Do it before you market hard — migrating with live paying users is far more painful.

### 6. No email verification on signup
Typos and throwaway addresses will burn trial quota and pollute your numbers. Verify email
before granting the trial.

### 7. No rate limiting
Nothing stops scripted signups farming free trials, or brute-forcing logins. Add per-IP
throttling on `/login` and `/signup`.

### 8. Sessions are unbounded
`sessions.json` grows forever and is never pruned. Expire old entries on write.

---

## 🟡 GROWTH & RETENTION (what gets you to thousands of users)

### 9. Nothing tells the user their night shift ran
The best feature you have is invisible. If leads appear at 2am and nobody's told, the
magic is lost. **Send a morning email: "23 leads found overnight — review them →."**
That single email is your strongest retention loop; it's the reason they keep the sub.

### 10. Zero analytics
You can't improve a funnel you can't see. Track at minimum: signups → first profile saved
→ first lead found → first email sent → upgrade. **Your activation metric is "first lead
found"** — anyone who doesn't reach it will churn, so measure and attack that drop-off.

### 11. No onboarding — the empty state is a cliff
New users land on a form with nine blank fields. Many will bounce.
**Fix:** ask 2 questions ("what do you sell?", "who buys it?"), have the AI draft the rest
of the profile, then immediately run 3 free leads so they see it work in their first 2 minutes.
Time-to-value is everything.

### 12. No social proof on the landing page
No testimonials, no logos, no screenshot of the product working. Add a real screenshot of
the approval queue with actual drafts — your product demoes itself; show it.

### 13. Pricing has no ladder
One $49 plan means you capture neither the hobbyist nor the agency running 10 clients.
Consider $19 starter (100 leads) / $49 pro (500) / $149 agency (2,000 + multiple seats).
Most revenue growth in early SaaS comes from the *upper* tier existing.

### 14. No cancellation/billing self-service
Users can't see their plan, change it, or cancel in-app. That drives chargebacks and
support load. Add a Stripe billing-portal link.

---

## 🔵 PRODUCT RISKS SPECIFIC TO THIS BUSINESS

### 15. Deliverability is your existential risk
You're selling cold outreach. If users blast from cold domains and get blacklisted, they
churn and blame you. You already have send throttling + a daily cap + guess-labelling —
**keep those on by default** and add onboarding guidance about warming a dedicated sending
domain. Consider refusing to send to `pattern`-confidence addresses at all.

### 16. AI cost scales with usage, not with revenue
Every lead costs you money forever. Watch cost-per-lead weekly. If a customer's usage
outruns their plan, that's not a "power user" — that's a loss.

### 17. VOICE is still legally gated
Keep it off until TCPA review. Don't let it appear in marketing as available.

---

## The order I'd actually do this in

1. **Password reset** (support blocker)
2. **Morning "your leads are ready" email** (retention + shows off the night shift)
3. **Postgres migration** (before real traffic)
4. **Onboarding: 2 questions → AI fills the profile → 3 instant leads** (activation)
5. **Analytics on the 5 funnel steps**
6. **Pricing ladder + Stripe billing portal**

Ship 1–2 this week. 3–4 before you market hard. 5–6 once you have 50 users telling you
where they get stuck.
