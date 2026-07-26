# TeamZero Cloud — Cost & Overhead

Built for the lowest possible overhead. Here's where every dollar goes and how it's minimized.

## Fixed overhead (near-zero by design)
| Item | Cost | Why it's low |
|---|---|---|
| **Dependencies** | $0 | Zero npm packages — no supply chain, no build step, tiny container |
| **Runtime** | minimal | Raw Node, no framework — runs on the smallest instance (256MB) |
| **Database** | $0 | Flat JSON store — no managed DB bill |
| **Hosting** | ~$7/mo | Render Starter (needed for the 1GB persistent disk so accounts survive restarts) |

> **Free hosting caveat:** Render's *free* tier has **no persistent disk**, so all accounts/leads are wiped on every restart or deploy. Fine for a demo, unacceptable for real users. $7/mo Starter is the honest floor for a product that saves data. (It's cheaper than the domain.)

## Variable cost = AI (this is 95% of your spend)
Every lead triggers AI work. Two tasks, two models, routed for cost:

| Task | Model | Price (in/out per 1M) | Why |
|---|---|---|---|
| **PROSPECTOR / SCOUT** (find leads, web research) | Sonnet 5 | $3 / $15 | Needs web search + reasoning |
| **OUTBOUND** (write the email) | **Haiku 4.5** | **$1 / $5** | Simple, high-volume — 3× cheaper, thinking off |

**The optimization:** drafting is your most frequent call (one per lead). Routing it to Haiku instead of Sonnet cuts the per-draft cost ~3×, with thinking disabled and a tight 700-token cap so you never pay for reasoning or output you don't use.

### Rough cost per lead
- **Prospecting** (Sonnet + web search, shared across a batch): a 50-lead run is a handful of research calls, not 50 — call it a few cents per lead.
- **Drafting** (Haiku, ~1–2K tokens in, ~300 out): well under **$0.005 per email**.

**Ballpark: a lead found + drafted costs you single-digit cents.** At $49/mo with a 500-lead cap, a maxed-out customer costs you a few dollars in AI — a healthy margin. **Measure it in week one:** watch your Anthropic dashboard after 100 real leads and confirm the per-lead number.

## Levers if you need to cut further
1. **Lower the plan's lead cap** (`lib/plans.js` → `PRO_LEADS_PER_MONTH`) — the ceiling directly bounds your worst-case AI spend.
2. **Batch prospecting** already amortizes research across many leads — keep runs at 10–50, not 1-at-a-time.
3. **Trial = 15 leads** (`TRIAL_LEADS`) — enough to convert, capped so free users can't run up a bill.
4. **Use Haiku for SCOUT too** if you find the briefs don't need Sonnet — one line in `agents.js`.
5. Swap `TEAMZERO_MODEL` / `TEAMZERO_DRAFT_MODEL` in env without code changes if pricing shifts.

## Bottom line
- **To run it:** ~$7/mo hosting + your actual AI usage (cents per lead).
- **Break-even:** one paying customer covers hosting many times over.
- **The margin is protected** by the per-plan lead cap — you can't lose money on a customer who stays within their plan.
