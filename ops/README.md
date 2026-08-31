# ops/

`seo-check.js` here is a real tool (`node ops/seo-check.js [base-url]`), run
daily by the keeper shift.

Everything else about the daily keeper shift — the improvement queue, the
shift log, design docs, dated reports — lives on the `keeper-ops` branch,
not here on `main`. `main` previously carried a stale duplicate
`IMPROVEMENT-QUEUE.md`/`KEEPER-LOG.md` (added in `ad5e278`, never updated
after `keeper-ops` became the canonical home) — removed 2026-08-31 to stop
the two copies from drifting apart. See `keeper-ops`'s `ops/` for current
state.
