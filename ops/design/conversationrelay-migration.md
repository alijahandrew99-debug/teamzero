# ConversationRelay migration — design doc

Queue item 5 (`ops/IMPROVEMENT-QUEUE.md`). Architecture C in `COST.md`:
$0.209/min today -> $0.105/min, ~81% of the win to architecture D for ~15%
of the engineering. This is a design doc only — no code changes. Written
2026-08-27 against `lib/voice.js` (921 lines) and the `/voice/*` handlers
in `server.js` as they exist today.

## What we have today (architecture A)

A synchronous HTTP webhook loop, one TwiML response per turn:

1. `POST /voice/answer` — Twilio hits this once the call connects. We
   speak the opener (`say()`) and return a `<Gather>` (`sayAndGather()`,
   `lib/voice.js:224`) that both plays audio and opens a speech recognizer.
2. Twilio POSTs partial results to `/voice/partial` while the caller is
   still talking (`server.js:1257`). We debounce 600ms and speculatively
   call the model on the not-yet-final transcript (`launchSpeculation()`,
   `server.js:398`) so `think()` is already running when the final
   transcript lands — this is what hides most of the model's latency
   inside the caller's own pause.
3. Twilio POSTs the final transcript to `/voice/turn` (`server.js:1271`).
   We resolve the speculative call if it matches, otherwise run `think()`
   cold, and return the next `<Gather>`.
4. Noise handling: `isNoise()` scores each transcript by Twilio's
   confidence; below the floor we treat it as silence. Two low-confidence
   hits in a row flip the call to `noisy: true`, which turns off
   `bargeIn` and shortens `maxSpeechTime` for the rest of the call
   (`sayAndGather()` opts).
5. Every `<Say>` goes through Twilio's Generative Polly voice
   (`say()`/`voiceFor()`), billed at the 4.33x reseller markup COST.md
   documents. Every `<Gather>` bills a flat $0.02 recognition fee
   regardless of length.

Cost breakdown per COST.md: recognition ~38%, TTS ~45%, AI ~12%
(stale figure), telephony ~4%, recording ~1%.

## What ConversationRelay changes

ConversationRelay replaces the `<Gather>`/`<Say>` HTTP round-trip with a
single bidirectional WebSocket per call. Twilio still owns STT and TTS
(so no Deepgram/Polly-direct integration — that's architecture D), but
bundles both into one $0.07/min rate instead of billing per-recognition
and per-character. The webhook shape changes fundamentally:

- `<Connect><ConversationRelay url="wss://.../voice/relay" .../></Connect>`
  replaces `<Gather>` in the TwiML returned from `/voice/answer`. The call
  is handed to the WebSocket for its entire duration — there is no more
  "one TwiML response per turn."
- Twilio sends JSON messages over the socket: `setup` (call metadata,
  replaces the initial webhook params), `prompt` (final transcript,
  replaces `/voice/turn`'s `SpeechResult`), and interruption events
  (replaces `bargeIn` handling).
- We send back `text` messages to speak (replaces `<Say>`) and can send
  `end` to hang up.

## What maps over cleanly

- `think()` and `systemPrompt()` are transport-agnostic — they take
  `(call, heard)` and return `{ say, action, data }`. No change needed.
- `warmCache()`, the 16-turn history cap, and prompt-caching all stay
  exactly as they are — the cost lever they represent is orthogonal to
  transport.
- `isNoise()`'s confidence-floor logic is reusable if ConversationRelay's
  `prompt` messages carry a confidence score (needs verification against
  current Twilio docs — this doc does not assume it).
- Call state (`calls` Map, `startCall`/`endCall`/`getCall`) stays the
  same shape; only what feeds it changes.
- `db.saveCall`, activity logging, and the transcript/outcome persistence
  in `/voice/turn` today move to the socket's message handler but keep
  the same semantics.

## What has to be redesigned, not ported

1. **Partial-result speculation** (`launchSpeculation`, `/voice/partial`,
   the 600ms debounce). ConversationRelay's `prompt` message model may
   not expose interim/partial transcripts the way `<Gather>`'s
   `partialResultCallback` does — needs a spike against Twilio's current
   ConversationRelay docs before assuming this port 1:1. If partials
   aren't exposed, this whole latency-hiding trick is lost and needs a
   different mechanism (e.g. start `think()` the instant `prompt` arrives
   and stream the reply back token-by-token instead of waiting for the
   full JSON, which ConversationRelay explicitly supports via streaming
   `text` messages).
2. **Noise-driven barge-in control** (`noisy` flag flipping `bargeIn` and
   `maxSpeechTime` per-call). ConversationRelay's interruption model is
   socket-event-based, not a per-`<Gather>` XML attribute — the noisy-call
   downgrade needs an equivalent "stop treating interruption events as
   real speech" toggle in the socket handler.
3. **Per-account/per-language voice selection** (`voiceFor()`,
   `hintsFor()`, `lang`). ConversationRelay configures TTS voice and STT
   language on the initial `<Connect><ConversationRelay>` TwiML, which is
   set once at answer time — fine for voice (already fixed per-call), but
   `hints` (speech-recognition biasing words) may not have a
   ConversationRelay equivalent; needs a docs check.
4. **Outbound answering-machine detection** (`AnsweredBy` param handling
   in `/voice/answer`, `voicemailPitch()`). This is a `<Dial>`/call-status
   feature independent of Gather-vs-Relay, so it should be unaffected —
   confirm `AnsweredBy` still arrives on the call-status callback when the
   TwiML body uses `<Connect>` instead of `<Gather>`.
5. **Recording** (`startRecording()`, posted to `/voice/recording`).
   Should be unaffected (recording attaches to the call, not to Gather),
   but confirm `<Connect><ConversationRelay>` still permits `<Start><Record>`
   or an equivalent on the same call.
6. **Signature verification** (`verifySignature()`). WebSocket messages
   aren't signed the way webhook POSTs are — Twilio's ConversationRelay
   auth model (likely a signed `setup` message or connection-time
   validation) needs to replace this, not just get copied.

## Rollout plan

Given the amount of custom logic riding on the current transport (noise
detection, speculative thinking, barge-in tuning — all tuned live against
real calls per the comments throughout `lib/voice.js`), a big-bang switch
is the wrong shape. Recommended:

1. **Spike** (half a day): stand up a throwaway `/voice/relay` WebSocket
   endpoint, confirm what `setup`/`prompt`/interruption messages actually
   look like against a live test call, and resolve the "needs
   verification" points above (partials, hints, `AnsweredBy`, recording,
   auth). This spike answers whether items 1–3 above are solvable or are
   real feature regressions to accept.
2. **Parallel implementation behind a flag**: a new `lib/relay.js`
   implementing the same `think()`-calling contract, gated by an env var
   (e.g. `VOICE_TRANSPORT=relay`) so `/voice/answer` branches between the
   old TwiML path and the new `<Connect>` path per-call. Zero risk to the
   live line while it's being built.
3. **Canary on a small slice of calls** (e.g. the demo line, or a single
   consenting test account) before flipping the default.
4. **Cut over**, keep the old path importable for one release in case of
   rollback, then delete it.

Do not attempt this as a single PR — the noise/barge-in/speculation logic
alone represents weeks of live-call tuning encoded in comments throughout
`lib/voice.js`, and losing any of it silently would degrade call quality
in a way COST.md explicitly rules out trading for savings.

## Open questions for the spike (not answerable from docs alone)

- Does ConversationRelay expose interim transcripts, or only finals?
- Does it support `hints` (recognition biasing) at all?
- What does its interruption/barge-in event actually look like, and can
  it be suppressed per-call the way `bargeIn="false"` does today?
- Does `AnsweredBy` (machine detection) still fire under `<Connect>`?
- Can `<Start><Record>` coexist with `<Connect><ConversationRelay>`?
- What's the auth story for the WebSocket connection?

## Recommendation

Worth doing — 81% of the savings of the end-state architecture for a
fraction of the work, and it's a prerequisite-free step (architecture D
still requires this same TwiML restructuring plus a Deepgram/Polly
integration on top). But it is not a "one shift" change: budget the
spike as its own keeper shift before committing to an implementation
branch, since several of today's highest-value features (speculative
thinking, noise-adaptive barge-in) depend on webhook-loop specifics that
may not have a direct ConversationRelay equivalent.
