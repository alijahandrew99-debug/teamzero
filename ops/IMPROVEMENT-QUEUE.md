# Dawnpipe improvement queue

Worked top-down by the dawnpipe-keeper agent, one item per shift. Before starting
an item, VERIFY it is still open in current code — several AUDIT.md items were
fixed after it was written. Move finished items to Done with the branch name.

## Reliability (correctness before cost)

1. **db.js write safety** — flat JSON rewritten whole per change; COST.md calls it
   "a correctness problem before it is a cost one" under concurrent voice
   webhooks. First slice: atomic write (temp file + rename) + a write queue per
   file if not already present. Full Postgres migration is a design doc first.
2. **Email verification on signup** — stops trial-farming and typo accounts
   burning paid lead quota (AUDIT #6 — verify still open).
3. **Stuck-call / webhook failure audit** — recent commit "stuck calls now
   unstick themselves" suggests a class of bug; look for siblings (timeouts,
   orphaned sessions, unfreed voice minutes).

## Cost (quality-neutral only — COST.md is the source of truth)

4. **VOICE_STT billing check** — needs Alijah: `/api/admin/spend` → diagnostics.
   If legacy model: `VOICE_STT=default` in Render dashboard. ~$45–60 per 1,000 min
   for one env var.
5. **Prompt-caching discipline on live-call turns** — $0.006 → ~$0.002/turn.
   Verify cache headers/structure on every voice-turn Claude call.
6. **ConversationRelay migration design (arch C)** — ~$0.105/min vs $0.209 today,
   ~81% of the win for ~15% of the work. Design doc + branch, not a rush job.
7. **Media Streams + Deepgram + Polly-direct design (arch D)** — the end state,
   $0.066/min, identical audio. After C proves out.

## Growth/retention (propose, don't surprise — customer-facing)

8. **Activation analytics** — count the 5 funnel steps (signup → profile → first
   lead → first send → upgrade) into a flat JSON the owner dashboard can read.
   No third-party tracker.
9. **Onboarding: 2 questions → AI drafts profile → instant first leads**
   (AUDIT #11 — verify current state first).
10. **Landing-page social proof** — real product screenshot of the approval
    queue. Needs Alijah's sign-off on the actual image.

## Done

- (keeper adds entries here: date — item — branch)
