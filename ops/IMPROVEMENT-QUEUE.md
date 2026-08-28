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
   **Status (2026-08-26):** branch `keeper/2026-08-25-atomic-rep-delete`
   is still open, not yet merged. Re-checked it merges cleanly against
   current main (`git merge-tree`, no conflicts) despite 19 commits of
   drift on main since it was cut. Re-ran the bypass audit against
   everything main gained since (`lib/spam.js`, `lib/assistant.js`,
   `lib/stripe.js`, `lib/plans.js`, the new per-profile voice config,
   per-rep commission rates) — no new raw `writeFileSync`/`fs.write` sites
   found. Nothing further to do here until the branch merges.

2. **Email verification on signup** — stops trial-farming.
   **Status (2026-08-27): verified still open.** `lib/auth.js` has no
   verification concept; `POST /signup` (`server.js:1969`) calls
   `db.createAccount()` directly and the account is immediately fully
   active — no unverified state, no confirmation email, no gate.
   Customer-facing (changes what every new signup experiences), so per
   the keeper's standing rule this is proposed, not implemented — see
   today's report (`ops/reports/2026-08-27.md`) for the proposed shape.

3. **Stuck-call / webhook failure audit** — look for siblings of the fixed
   "stuck calls" bug (timeouts, orphaned voice sessions). One instance
   (calls frozen at "in-progress" after a deploy mid-call) was fixed in
   `df0d31f` (2026-08-24).
   **Status (2026-08-26): audited, no siblings found.** The fixed bug's
   shape is specific: a status persisted to a JSON file, transitioned only
   by a callback/event that can be lost (process restart, deploy). Checked
   every other stateful in-flight tracker:
   - `df0d31f`'s sweep (`LIVE = [queued, ringing, initiated, in-progress]`,
     2h threshold, in the `/api/voice/calls` handler) already covers both
     inbound and outbound calls — both go through `db.saveCall`, so no
     separate fix was needed for outbound.
   - `jobs`, `sendJobs`, `callJobs`, `phoneJobs`, `activeSends` (server.js)
     are all in-memory `Map`s with no persisted "running" row — a restart
     empties them and the frontend sees "idle"/not-found, not a stuck
     record. `sendJobs` also self-clears a job idle >30 min.
   - Queue items (`db.updateQueueItem`) only get a persisted status of
     `held`/`rejected`/`sent`, never a transient "sending" state written
     before the send completes — a crash mid-loop leaves the item
     `approved` (safe, retried next run).
   - Appointments are written `status: 'booked'` atomically at creation.
   Recommend closing this item unless a new failure mode shows up live.

4. **Prompt-caching discipline on live-call Claude turns** ($0.006 ->
   ~$0.002/turn).
   **Status (2026-08-26): already done, since `fa07426` (2026-08-17).**
   `lib/ai.js` `callAPI()` sends the system block with
   `cache_control: { type: 'ephemeral' }`; `lib/voice.js` `warmCache()`
   primes it before the caller's first real turn; `think()` caps
   conversation history at the last 16 turns so the uncached part of the
   prompt stays bounded instead of growing with call length. `COST.md`
   still listed this as an open lever — corrected there today, with a note
   that the $0.006/turn baseline itself is stale (voice turns moved from
   Haiku to Sonnet in `695a9aa`, 2026-08-24, a deliberate quality
   tradeoff — new per-turn cost not re-measured). Recommend closing this
   item; re-open only if a fresh `/api/admin/spend` read shows caching
   isn't actually landing.

5. **ConversationRelay migration design** (arch C in COST.md, ~half the
   per-minute cost) — design doc + branch, not a live-code change.
   **Status (2026-08-27): design doc written**, `ops/design/conversationrelay-migration.md`
   (branch `keeper/2026-08-27-conversationrelay-design`). Covers what
   ports cleanly (`think()`, prompt caching, call state) vs. what needs a
   spike first (partial-result speculation, noise-driven barge-in
   control, hints, machine detection, recording, auth — all currently
   implemented against the `<Gather>`/webhook transport specifically).
   Recommends a half-day spike before any implementation branch, since
   several tuned-live call-quality features may not have a direct
   ConversationRelay equivalent. Not started as code.

6. **Media Streams + Deepgram + Polly-direct design** (arch D, the end
   state) — design doc, largest lift.

7. **Activation analytics** — count signup -> profile -> first lead -> first
   send -> upgrade into a flat JSON, no third-party tracker.
   **Status (2026-08-28): shipped**, branch `keeper/2026-08-28-activation-funnel`.
   Added `db.trackFunnel(accountId, step)` / `db.getFunnelSummary()` writing
   to a new `funnel.json` (one row per account per milestone, first-crossing
   only — repeat calls are safe no-ops, so callers don't need to check
   "is this the first time" themselves). Hooked at the five natural points:
   `db.createAccount` (signup), the `POST /api/profile/save` route (profile —
   deliberately NOT hooked in `db.createProfile` itself, since signup silently
   creates a placeholder starter profile via `seedStarterProfile` and hooking
   there would make "profile" fire in lockstep with "signup" for every
   account, destroying the signal), `db.addLeads` (first_lead, only when a
   row is actually added — not on a no-op dedup call), `db.logSend`
   (first_send), and the Stripe `checkout.session.completed` handler
   (upgrade). Added an owner-only `GET /api/admin/funnel` returning
   `{ steps, counts }`. No customer-facing change. Smoke-tested against an
   isolated `DATA_DIR` (signup/profile/lead/send/upgrade each count once,
   a duplicate lead batch and an unknown step name are both safe no-ops);
   full `node test-reps.js` suite (37 tests) still passes.

8. **Onboarding**: 2 questions -> AI drafts profile -> instant first leads.
   Customer-facing — propose in a report before implementing.
