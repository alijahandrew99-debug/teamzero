# Dawnpipe Improvement Queue

Working list for the daily Keeper shift. Each item is verified against
current code before being worked — some may already be partially or fully
fixed by the time they're picked up. Status is updated in place; history of
what shipped lives in `ops/KEEPER-LOG.md` and `ops/reports/`.

1. **db.js write safety** — flat JSON store, whole-file rewrites. Add atomic
   temp-file+rename writes and a per-file write queue. Full Postgres
   migration is a design doc first, not a code change.
   **Status (2026-08-25): partially done.** `db.js`'s `write()` already did
   temp-file+rename before this queue existed. Found and fixed one caller
   that bypassed it — `lib/reps.js` `deleteRep()` was rewriting `reps.json`
   (the commission ledger's rep table) with a raw `fs.writeFileSync`. Added
   `db.deleteCollection()` routed through the atomic path; `deleteRep` now
   uses it. See branch `keeper/2026-08-25-atomic-rep-delete`.
   Remaining scope: the "per-file write queue" half. Every write in `db.js`
   is synchronous (`readFileSync`/`writeFileSync`, no `await` between read
   and write), so within one Node process a read-modify-write can't be
   interleaved by another request — there is no live race today. A queue
   only starts to matter if Render ever runs >1 instance against the same
   data dir, or a write path becomes async. Recommend re-scoping this to
   "audit: does any write site bypass the atomic path" (checked 2026-08-25,
   `lib/agents.js:524` also writes directly but it's a per-account/profile/
   day markdown brief file, not shared JSON state — low stakes, left as is)
   rather than building a queue for a race that doesn't exist yet.

2. **Email verification on signup** — stops trial-farming. Not yet verified
   against current code.

3. **Stuck-call / webhook failure audit** — look for siblings of the fixed
   "stuck calls" bug (timeouts, orphaned voice sessions). One instance
   (calls frozen at "in-progress" after a deploy mid-call) was fixed in
   `df0d31f` (2026-08-24). Audit for other timeout/orphan patterns not yet
   done.

4. **Prompt-caching discipline on live-call Claude turns** ($0.006 ->
   ~$0.002/turn). Not yet verified against current code.

5. **ConversationRelay migration design** (arch C in COST.md, ~half the
   per-minute cost) — design doc + branch, not a live-code change.

6. **Media Streams + Deepgram + Polly-direct design** (arch D, the end
   state) — design doc, largest lift.

7. **Activation analytics** — count signup -> profile -> first lead -> first
   send -> upgrade into a flat JSON, no third-party tracker.

8. **Onboarding**: 2 questions -> AI drafts profile -> instant first leads.
   Customer-facing — propose in a report before implementing.
