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
   **Status (2026-08-29):** re-checked once more against everything main
   gained since 08-26 (password reset, social-share card, forwarding
   divert, SEO/schema work, phone-setup-per-business, website import,
   spam filter, in-app assistant) — still no new raw
   `writeFileSync`/`fs.write` sites (`lib/agents.js:561`'s per-profile
   brief file is the only pre-existing one, still low-stakes). Branch
   still merges clean (`git merge-tree`, no conflicts). Still unmerged,
   four days now.
   **Status (2026-08-30):** branch re-verified against current main
   (`git merge-tree`) — still merges clean, no conflicts, six days
   unmerged now. Meanwhile the bug it fixes is still live in production:
   `lib/reps.js:146` on current `main` still has the raw
   `fs.writeFileSync` rewriting `reps.json` (the commission ledger's rep
   table) directly, bypassing `db`'s atomic temp-file+rename path — the
   exact write-safety gap this queue item was opened for. Flagging again,
   more urgently, since it's sat mergeable and unmerged for a week.
   Separately, found and fixed a *sibling* gap in the same family while
   reading the new password-reset code: `db.pruneSessions()` sweeps
   expired session tokens every 10 min so `sessions.json` can't grow
   without bound, but the equally new `resets.json` (password-reset
   tokens, added with `c577195`) had no equivalent — `useResetToken()`
   only deletes a token on successful use, so an expired-but-never-used
   one (the common case — most reset links are never clicked) sat in the
   file forever. Added `db.pruneResets()` mirroring `pruneSessions()`
   exactly, wired into the same interval. See branch
   `keeper/2026-08-30-prune-reset-tokens`. Smoke-tested against an
   isolated `DATA_DIR` (expired token pruned, live token kept, idempotent
   on a second run); `node test-reps.js` (37 tests) still passes;
   `node --check` clean on both touched files.
   **Status (2026-08-31):** branch `keeper/2026-08-25-atomic-rep-delete`
   re-verified (`git merge-tree`) — still merges clean against current
   main, still unmerged, now a full week old. `lib/reps.js:146`'s raw
   `writeFileSync` on `reps.json` is still live on `main`. This is now
   the oldest thing in this queue waiting purely on a merge, not on more
   Keeper work — re-auditing it daily is turning into pure overhead.
   Recommend Alijah just merge it (see report). No new bypass sites found
   (no new commits landed on `main` since `c577195`, 2026-08-26).
   **Status (2026-09-01):** re-verified with an actual `git merge
   --no-commit` against current `main` (not just `git merge-tree`, which
   today flagged both touched files as "changed in both" — a false alarm
   from that tool's coarse per-file reporting; the real merge auto-resolves
   with no conflicts). Still unmerged, eight days now; `lib/reps.js:142`'s
   raw `writeFileSync` is still live. No new commits on `main` since
   08-26, so still nothing new to audit. Nothing left to do here but wait
   on the merge.
   **Status (2026-09-02):** branch still unmerged, nine days now, no new
   commits on `main` to re-audit. Shipped one more concrete piece of this
   item instead of re-verifying the same stale branch: `write()` in
   `lib/db.js` was pretty-printing every JSON write (`JSON.stringify(d,
   null, 2)`) — no reader ever needs that formatting, it's pure CPU and
   bytes on the hottest write path (`saveCall` runs every conversational
   turn of every live call). Dropped the formatting; `node --check` clean,
   `node test-reps.js` 37/37 still passing, zero behavior change. Branch
   `keeper/2026-09-02-db-write-compact`. Surfaced by the independent
   2026-08-26 audit (item 12) as the cheapest available win here — see
   there for the full context on `calls.json`'s row cap, which this does
   not fix. `keeper/2026-08-25-atomic-rep-delete` is still the higher-value
   ask: it fixes a live bypass of the atomic path, this only makes the
   atomic path itself cheaper.
   **Status (2026-09-04):** shipped a fix for a gap the 2026-09-02 audit
   flagged but couldn't confirm the trigger for ("one thing I could not
   settle" in `ops/audit/2026-09-02.md`): `write()`'s temp file was a fixed
   `f + '.tmp'`, so two writers sharing `DATA_DIR` (an overlapping Render
   deploy, or ever >1 instance on the same disk) would race on the same
   temp path — the loser's `renameSync` can splice its own write over the
   winner's, and `read()`'s swallowed parse failure turns that into a
   silently emptied collection on the next read. Made the temp name unique
   per call (`f + '.' + pid + '.' + random + '.tmp'`) rather than waiting
   to confirm whether Render's deploys actually overlap — no behavior
   change for a single writer, removes the collision either way.
   `node --check` clean, `test-reps.js` 37/37. Branch
   `keeper/2026-09-04-unique-tmp-write`. Whether the trigger is real is
   still worth Alijah checking (see today's report) — that's a Render
   dashboard question this shift can't answer, but the fix doesn't need
   to wait on it.

2. **Email verification on signup** — stops trial-farming.
   **Status (2026-08-27): verified still open.** `lib/auth.js` has no
   verification concept; `POST /signup` (`server.js:1969`) calls
   `db.createAccount()` directly and the account is immediately fully
   active — no unverified state, no confirmation email, no gate.
   Customer-facing (changes what every new signup experiences), so per
   the keeper's standing rule this is proposed, not implemented — see
   today's report (`ops/reports/2026-08-27.md`) for the proposed shape.
   **Status (2026-08-29): re-verified, still open, unchanged.**

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
   **Status (2026-08-29): design doc written**,
   `ops/design/media-streams-deepgram-polly-design.md` (branch
   `keeper/2026-08-29-media-streams-design`). Scopes the three new pieces
   D needs beyond item 5 (a hand-rolled zero-dependency WebSocket *server*
   for Twilio Media Streams, a WebSocket client to Deepgram, and
   SigV4-signed direct Polly calls with reply-chunking for low-latency
   TTS), assesses each against the zero-npm-dependency rule (all feasible,
   the WS server is the hard one), and lists what has to be rebuilt vs.
   what ports from `lib/voice.js` unchanged. Recommends explicitly:
   design only for now — do not spike or implement until item 5's arch-C
   spike/canary lands, since D inherits every open question item 5 raised
   and adds its own on top. Not started as code.

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

9. **Stale duplicate ops/ docs on `main`.** `ad5e278` (2026-08-24, bundled
   into an unrelated per-rep-commission commit) added a second copy of
   `IMPROVEMENT-QUEUE.md`/`KEEPER-LOG.md` straight onto `main`, never
   updated since — flagged as unreconciled every shift from 2026-08-26
   through 2026-08-30. **Status (2026-08-31): fixed.** Removed both stale
   files on `main` and added `ops/README.md` pointing at `keeper-ops` as
   the canonical location, keeping `ops/seo-check.js` (a real tool, run
   daily by this shift — see item 10). Branch
   `keeper/2026-08-31-reconcile-stale-ops-docs`, docs-only, no code
   touched.

10. **`ops/seo-check.js`** — a zero-dependency SEO/trust-signal monitor for
    dawnpipe.com, discovered on `main` 2026-08-31 while investigating item
    9 (added in `1a316ec`+`083e66a`, 2026-08-25, never previously run by
    this shift). Checks title/JSON-LD/canonical/sitemap/favicon/robots
    across the marketing pages, DNS via DoH, exit-code 1 on any FAIL —
    meant to run daily so a deploy regression (duplicate title, broken
    JSON-LD, dead sitemap URL) gets caught same-day. Ran it today: every
    check returned the same `403` as the direct health-check curls
    (session egress policy, not a real site error — see today's report).
    Recommend adding a "run ops/seo-check.js" step to the shift once site
    egress is reachable again.

11. **URGENT — merge `audit/2026-08-26-voice-status-fallback-billing`.**
    Discovered 2026-09-02: a separate, independent code-audit session (not
    this Keeper shift) ran 2026-08-26 and found a real billing-correctness
    bug, tracked entirely outside this queue until today. `/voice/status`'s
    fallback path (runs when the in-memory call record is gone because a
    deploy landed mid-call — routine, since Render auto-deploys `main` and
    this shift pushes daily) billed `ceil(CallDuration/60)` unconditionally,
    with no check for whether the caller ever spoke or the spam filter
    flagged the call. The live path already refuses to bill those calls
    ("robocalls, dead air and pocket dials were eating paid minutes"). Net
    effect: the exact same robocall was free or billed depending only on
    whether a deploy happened to be mid-flight — a few calls a week
    overbilled against the product's own stated rule. Fix is already
    written, tested (`node --check` clean, guard logic table-tested against
    5 transcript shapes), and on branch
    `audit/2026-08-26-voice-status-fallback-billing` — **re-verified
    2026-09-02, still merges clean against current `main` via
    `git merge --no-commit --no-ff`, still unmerged, 7 days now.** Full
    writeup with the trade-off (a call that dies before the first agent
    reply now goes unbilled — under-billing by at most 1 minute, deliberately
    chosen over the alternative of ever overbilling) is in
    `ops/audit/2026-08-26.md` on branch `keeper-audit`, finding 1. This is
    now the top merge ask, ahead of item 1's week-old branch, because it's
    actively costing customers money on every deploy in the meantime.

12. **Other findings from the 2026-08-26 independent audit**
    (`ops/audit/2026-08-26.md`, branch `keeper-audit` — not a `keeper/*` or
    `keeper-ops` branch, so this shift can read but not merge it). Folding
    the audit's own "suggested queue additions" in here so they're tracked:
    - `/voice/status` billing is not idempotent — no `billedMin` stamp on
      the call row, so a second delivery of the same status callback would
      double-bill. **Status (2026-09-03): shipped**, branch
      `keeper/2026-09-03-billing-idempotency`. `server.js`'s live-call
      billing branch (the `if (call) {...}` path, not the restart-recovery
      fallback a few lines above it) now reads the persisted row's
      `billedMin` flag before calling `consumeVoiceMinutes`, and stamps it
      only on the same `saveCall` write that already runs once per callback
      — a duplicate delivery of the same completed callback sees the stamp
      and skips billing instead of charging the call twice. Deliberately
      scoped away from the restart-recovery fallback path (`server.js`
      lines ~1845-1853): that's exactly what pending branch
      `audit/2026-08-26-voice-status-fallback-billing` (item 11) already
      rewrites, and touching the same lines here would hand Alijah a
      guaranteed conflict between two unmerged branches. Verified via an
      actual `git merge --no-commit --no-ff` of that audit branch into
      current `main` in an isolated worktree while investigating this —
      raised a false alarm first (a raw branch-vs-main diff made it look
      like the audit branch would revert `c577195`'s password-reset mailer
      fix, since the audit branch was cut from before that commit), but the
      real 3-way merge auto-resolves cleanly and both fixes survive intact.
      That resolves the standing worry behind item 11's repeated "still
      merges clean" note — it does, verified two ways now.
      Smoke-tested against an isolated `DATA_DIR` (first callback for a sid
      bills and stamps, a simulated duplicate callback for the same sid
      sees the stamp and would skip billing, an unrelated sid is
      unaffected); `node --check` clean; `node test-reps.js` (37/37) and
      `node test-spam.js` (18/18) both still pass.
    - `calls.json` is capped at 3,000 rows **globally**, not per account —
      at ~200 customers this is roughly 3 days of history before a quiet
      customer's calls (and recordings) get evicted by a busy customer's
      volume. Also: pretty-printed writes on every turn measured at up to
      ~135ms of blocked event loop at the cap (item 11's compact-write fix,
      shipped 2026-09-02 as `keeper/2026-09-02-db-write-compact`, halves
      this but doesn't fix the global-cap eviction). Recommend per-account
      retention next time `lib/db.js`'s call storage is touched.
    - The do-not-call branch on `/voice/incoming` (`server.js:1288-1290`) is
      unreachable dead code encoding a *different* policy than the reject
      that actually runs at `server.js:1159` — worth a product decision from
      Alijah on which behavior is intended (see the audit doc for the two
      readings), not a Keeper call to make.
    - `estimateCost` (`lib/voice.js`) omits the transferred `<Dial>` leg's
      cost — understates every transferred call's shown cost by ~$0.04 on a
      typical 5-minute call. Low severity, fold in whenever that function is
      next touched rather than its own branch.
    - Audit recommends measuring actual production `calls.json` size (via
      `/api/admin/spend` or a Render shell) before pricing the Postgres
      migration — this shift has no owner-authenticated access to check.

13. **A parallel, independent code-audit process exists** (branch
    `keeper-audit`, `ops/audit/2026-08-26.md`) that this Keeper shift was
    not previously aware of — it rotates through lenses on `server.js`
    (voice state machine done; next up per its own doc: db.js concurrency,
    then security, then request/webhook handlers generally) and pushes
    fixes to `audit/*`-prefixed branches, separate from this queue and this
    shift's `keeper/*` branches. Worth Alijah confirming whether that's a
    separate standing job he's running, so this shift can fold its output
    into this queue as it lands instead of rediscovering it late (this one
    sat unknown to this shift for 7 days). Also noticed in passing:
    branch `research-competitors` (`research/competitors/2026-08-31.md`,
    pricing/positioning baseline for Rosie/Dialzara/Smith.ai/Ruby/Sameday +
    a note on Zoom's new $29.99/mo AI receptionist entrant) — unrelated to
    ops, not this shift's to act on, flagged only so it isn't lost.
    **Status (2026-09-04):** the process ran again 2026-09-02 (lens (b),
    db.js concurrency — the exact rotation it announced), confirming it's
    a standing job, not a one-off. See item 14 for what it found. Its own
    doc flags one more thing worth Alijah's attention directly, not
    through this queue: **`git fetch origin keeper-audit` doesn't happen
    by default in a fresh clone**, and the audit's own first pass this run
    repeated the prior lens before it noticed the branch existed. Same
    blind spot this Keeper shift had until 2026-09-02. Two independent
    processes have now each lost real time to the same discoverability
    gap — worth Alijah deciding whether `keeper-audit` should be seeded
    into fresh clones some other way, since neither process can fix that
    from inside itself.

14. **URGENT — merge `audit/2026-09-02-consume-stale-snapshot`.** Found by
    the 2026-09-02 audit run (`ops/audit/2026-09-02.md` on `keeper-audit`,
    finding 1): `lib/plans.js`'s `consumeVoiceMinutes()` and `consume()`
    (lead metering) both compute `before` from the **caller's** account
    snapshot, taken before an `await`. `server.js`'s night shift fires
    `agents.keeperRun` and a prospect job concurrently against the same
    account; `keeperRun` reads the account, awaits an AI draft for
    seconds, then writes `snapshot + 1` — silently erasing every lead the
    prospect job metered during that await. Reproduced end to end: 21
    leads metered during the window, 1 recorded. Same shape for voice
    minutes. This under-meters (costs Dawnpipe AI spend that never lands
    against a plan or draws down a top-up balance) — it does not overbill
    anyone, but it's the same margin hole as item 11's billing bug, just
    the opposite direction and on a different pair of functions. Fix
    re-reads the account (`db.getAccount(account.id)`) instead of trusting
    the snapshot, same pattern already used in `lib/agents.js:473` and
    `server.js`'s `sentToday` re-read — safe because `db.js` is fully
    synchronous, so the re-read and write can't be interleaved by anything
    else. Verified: `node --check` clean; repro goes green; the audit's
    four suites (`test-reps`, `test-spam`, `test-voiceprofiles`,
    `test-assistant` — 87 assertions, note only `test-reps.js` exists on
    `main` today, the other three live on branches not yet merged) all
    pass. One thing for Alijah to know before merging, from the audit
    doc itself: accounts that have been under-metered will start
    depleting their allowance at the true rate once this lands — a
    visible behavior change, not a new charge, but worth picking the
    timing for. This and item 11 are now the two top merge asks; both are
    small, both are billing-correctness fixes, neither has anything left
    for this shift to do but keep flagging them.

15. **Extend per-account retention to `smsThreads`, not just `calls`.**
    The 2026-09-02 audit (finding 2) found `lib/db.js`'s `smsThreads` cap
    (2000, global) has the same bug as `calls`' cap (item 12's second
    bullet) — plus it's worse, because a thread is live in-flight state
    (the missed-call text-back flow reads it to recover context), and
    eviction is by **creation order**, not recency: `saveThread` updates a
    row in place but `slice(-2000)` still evicts by original index, so a
    thread created this morning and texted all day can be evicted before
    an untouched thread from last week. Not biting yet at today's customer
    count — flagged as a "before 200 customers" item, same bracket as
    item 12. **The trap if this gets fixed:** `logActivity`'s existing
    `capPerAccount` (the pattern to reuse) walks forward and keeps the
    first N per account because that collection is newest-first
    (`unshift`); `calls` and `smsThreads` are oldest-first (`push`).
    Applying `capPerAccount` as-is would keep the OLDEST N per account and
    silently delete everything recent — the audit deliberately did not
    ship this for that reason, plus wanting to avoid two routines editing
    `lib/db.js` the same day (`keeper/2026-09-02-db-write-compact` was in
    flight). Needs a reversed/`newestFirst`-aware version of
    `capPerAccount` and a test asserting which rows survive, applied to
    both collections together. Good next `lib/db.js` slice for a future
    shift; not picked up today since `keeper/2026-09-04-unique-tmp-write`
    already touched the same file once this shift (same reason the audit
    gave for holding off).
    **Status (2026-09-05): shipped**, branch
    `keeper/2026-09-05-per-account-retention`, cut fresh off `main`
    (`c577195`, unchanged since 08-26 — no other branch has touched
    `lib/db.js` on `main` yet, so the "two routines same file" concern
    doesn't apply here). Added `capPerAccountOldestFirst(rows, perAccount
    = 500)` — walks backward instead of forward, keeping the newest N per
    account instead of the oldest, then restores oldest-first order for
    `saveCall`/`saveThread`. Applied to both `calls` (was a global
    `slice(-3000)`) and `smsThreads` (was `slice(-2000)`) together, exactly
    as the audit asked. `node --check` clean; `test-reps.js` (37/37) and
    `test-spam.js` (18/18) both still pass (neither exercises retention at
    scale). Smoke-tested against three isolated `DATA_DIR`s: a quiet
    tenant's one call/thread survives 600 writes from a busy tenant on the
    same file (global-cap bug); a row created early but updated
    600-writes-later survives the cap (creation-order bug); busy tenant
    lands at exactly 500 rows in both cases, keeping its newest, not its
    oldest — 6/6 assertions pass. This closes the queue-15/12-bullet-2 gap
    the audit flagged; item 16 (whether Render deploys ever overlap) is
    unrelated and still open.

16. **Render deploy-overlap check — owner-only, ten minutes.** The
    2026-09-02 audit couldn't determine from inside the repo whether
    Render's deploy strategy for this disk-backed service ever runs the
    old and new instance concurrently (`render.yaml`'s `healthCheckPath`
    comment claims zero-downtime, which would imply an overlap window;
    Render typically does *not* do zero-downtime for disk-backed services,
    which would mean no window). This is exactly the trigger item 1's
    2026-09-04 fix (unique temp filenames) now defends against regardless
    — so the fix doesn't block on the answer — but the answer still tells
    Alijah whether this was a live risk or a hypothetical one. One look at
    the Render dashboard's deploy settings/logs settles it; see today's
    report for the specific thing to check.
