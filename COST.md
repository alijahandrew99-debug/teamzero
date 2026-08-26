# Dawnpipe — where the money goes

Rewritten 2026-08-17. The previous version described a $49/500-lead plan that no
longer exists and claimed AI was "95% of your spend". Both were wrong for the
product as it is sold today: **Front Desk is a voice product, and voice is ~95%
of cost of goods.** Lead-gen AI is under 5%.

Read this with `GET /api/admin/spend` (owner only) open in another tab. That
endpoint reads Twilio's actual usage ledger, not these constants, and its
`diagnostics` block answers the questions this document can only estimate.

---

## The plan we sell

**Front Desk — $399/mo — 1,000 phone minutes + 200 email leads.**
Sales reps are paid **30% commission**, so Dawnpipe keeps **$279.30** of it.

Break-even on voice alone, at full allowance use: **$0.279/min**.

## Cost of one talk-minute, today

At ~3-4 turns/min and ~180 characters spoken per turn:

| Line | Rate | Per minute | Share |
|---|---|---|---|
| Speech recognition (`<Gather>`) | **$0.02 per USE** (flat, any length up to 60s) | $0.060–0.080 | ~38% |
| Text-to-speech (Twilio `<Say>`, Polly Generative) | $0.0130 / 100 chars | $0.070–0.094 | ~45% |
| AI (**Sonnet** as of Aug 24, prompt-cached) | figure below is stale — was Haiku ~$0.006/turn; voice tier moved to Sonnet in `695a9aa` for answer quality, per-turn cost not yet re-measured | $0.018–0.024 (stale) | ~12% (stale) |
| Phone line (inbound local) | $0.0085 / min | $0.0085 | ~4% |
| Recording + storage | $0.0025/min + $0.0005/min/mo | $0.0025 | ~1% |

**≈ $0.16/min at 3 turns, ≈ $0.21/min at 4 turns.**

Two things follow, and they are the whole cost story:

1. **The per-minute rate Twilio advertises is ~4% of what a minute costs us.**
   Speech-to-text and text-to-speech are ~83%. Anyone reasoning from "Twilio is
   $0.0085/min" is off by 25x.
2. **Recognition bills per USE, not per second.** A longer `<Gather>` is
   strictly free. Only the NUMBER of turns matters — so waiting patiently for a
   caller to finish costs nothing, and cutting them off costs money twice
   (extra turn, worse call).

## The 4.33x reseller tax

Twilio resells Amazon Polly. Same engine, same Ruth voice, same audio:

| Voice tier | AWS Polly direct | Via Twilio `<Say>` | Markup |
|---|---|---|---|
| Generative (what we use) | $30 / 1M chars | $130 / 1M chars | **4.33x** |
| Neural | $16 / 1M chars | $32 / 1M chars | 2.0x |
| Standard | $4 / 1M chars | $8 / 1M chars | 2.0x |

Buying Polly direct is the largest cost reduction available **with zero quality
change** — it is literally the same synthesis.

## Architectures, priced

| Path | $/min | Front Desk profit at 1,000 min |
|---|---|---|
| A. Today — Gather + Twilio `<Say>` Generative | $0.209 | $71 |
| B. Gather + Twilio `<Say>` Neural | $0.138 | $141 |
| C. Twilio ConversationRelay ($0.07/min bundled) | $0.105 | $174 |
| D. Media Streams + Deepgram Nova-3 + **Polly Generative direct** | **$0.066** | **$214** |

D is 3.2x cheaper than today at identical voice quality. C gets ~81% of the
benefit for ~15% of the engineering.

## Lead-gen AI (the other 5%)

`lib/agents.js` runs more than the cheap drafting call — PROSPECTOR (Sonnet,
12k tokens, web search), the market brief (6k, web), and phone lookup (3k, web)
all cost real money per run. Realistic all-in is **$0.015–0.030/lead**, i.e.
**$3–6/mo** for Front Desk's 200 leads, not the $0.80 a naive count of the
drafting call suggests. Verify in the Anthropic console after 100 real leads.

Email **sending** costs $0 — every customer connects their own mailbox
(`account.smtp`), so Dawnpipe pays for no sending infrastructure and carries no
sender-reputation risk on its own domains. That is a real structural advantage
over any competitor running a pooled ESP.

## Fixed overhead

| Item | Cost | Note |
|---|---|---|
| Dependencies | $0 | Zero npm packages |
| Database | $0 | Flat JSON store — **will not carry 200 customers of concurrent voice webhooks; that is a correctness problem before it is a cost one** |
| Hosting | $7/mo | Render Starter (needs the persistent disk) |
| Phone number | $1.15/mo per customer | Twilio local |
| Hunter.io | $34–209/mo | 1.5 credits/lead (1 find + 0.5 verify). **No published tier covers 200 customers (~60,000 credits/mo) — get a quote before 80 customers, not after.** |
| Claude Code Max | $100–200/mo | **R&D, not COGS.** A build tool tells you nothing about unit economics. |

Fixed cost per customer collapses from ~$31 at 10 customers to ~$4 at 200 —
and is fully exhausted by ~50. **Scale does not fix the voice P&L. Only the
architecture does.**

## What actually moves margin (ranked)

1. **Own the audio path** (D above) — +$128/customer at full use. The prize
   isn't the level, it's that the gap between a heavy customer and a light one
   collapses from $153 to $28, which makes "no overage charges, ever" cheap to
   honour instead of a liability.
2. **Check which speech model we're billed for.** `VOICE_STT` defaults to
   `experimental_conversations`; Twilio's legacy models bill $0.035–0.040/use
   against a $0.02 default. `/api/admin/spend` → `diagnostics` says which we
   pay. If legacy: set `VOICE_STT=default`. One env var, ~$45–60 per 1,000 min.
3. **Price**: $399 → $449 on new signups. The only lever worth the same on a
   light customer as a heavy one. Sameday charges $449 for 500 minutes and no
   email.
4. **Charge for extra locations/numbers** ($29/mo). Every competitor does;
   underlying cost is $1.15.
5. ~~**Prompt-caching discipline** on live-call turns: $0.006 → ~$0.002.~~ **Done** —
   `lib/ai.js` sends the system block with `cache_control: { type: 'ephemeral' }`,
   `voice.warmCache()` primes it before the caller's first turn, and `think()`
   caps message history at 16 turns so the uncached part stays bounded (all
   since `fa07426`, 2026-08-17). The $0.006 → $0.002 target itself is stale
   now that voice turns run Sonnet, not Haiku (see the AI row above) — worth a
   fresh per-turn measurement via `/api/admin/spend` rather than reusing this
   number. (Verified 2026-08-26.)

### Do NOT do these

- **Annual prepay at "two months free"** — commission is 30% of *revenue*, so
  every $1 discounted costs $0.70 of contribution. Sell annual at full price
  with bonus minutes instead: after the migration, 500 bonus minutes costs $20
  to defend $4,788.
- **Round call time up to 30-second blocks** — we don't bill overage, so
  rounding only makes the allowance expire sooner. $0 on most customers, and it
  quietly contradicts the "no overage charges, ever" promise. Bill exact
  per-second and *say so* — no AI competitor in the surveyed set discloses
  rounding at all.
- **A $199 setup fee** — Rosie, Dialzara, Smith.ai and Ruby all advertise no
  setup fee, and we promise the same. Take the price rise instead.
- **Drop to Neural voice to save money** — it's the one lever that degrades the
  product, and buying Polly direct gets the same ~$70 with no quality change.

## Open questions, and how to answer each for free

All four are in `GET /api/admin/spend` → `diagnostics`:

1. **What we pay per speech recognition** — bucket price ÷ count. $0.02 = fine;
   $0.035–0.040 = legacy model, fix with `VOICE_STT=default`.
2. **Turns per minute** — gather count ÷ talk-minutes. The model assumes 3-4;
   the difference is ~$49 per 1,000 minutes.
3. **Billed characters per turn** — TTS spend ÷ $0.0130 × 100 ÷ gathers. If it
   returns ~200 while the agent speaks ~180, Twilio's 100-char minimum applies
   per reply, and shortening replies below 200 saves nothing.
4. **Minutes a real customer actually uses** — decides whether 1,000 included
   minutes is generous or irrelevant. Pull the distribution, not the mean.
