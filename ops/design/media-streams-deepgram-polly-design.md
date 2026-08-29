# Media Streams + Deepgram + Polly-direct — design doc

Queue item 6 (`ops/IMPROVEMENT-QUEUE.md`). Architecture D in `COST.md`:
$0.066/min end state vs. $0.209/min today (arch A) and $0.105/min for
ConversationRelay (arch C, item 5, already designed). This is a design doc
only — no code changes. Written 2026-08-29 against `lib/voice.js` (946
lines) and the `/voice/*` handlers in `server.js` as they exist today, and
against `ops/design/conversationrelay-migration.md` (item 5's doc).

## Relationship to item 5 (arch C)

Arch D is a strict superset of arch C's transport change, not an
alternative to it. Both replace the `<Gather>`/`<Say>` HTTP webhook loop
with a persistent connection for the whole call; D additionally moves STT
and TTS off Twilio entirely, onto Deepgram and AWS Polly called directly.
Concretely, D inherits every open question item 5 raised about the
webhook-loop specifics (partial-result speculation, noise-adaptive
barge-in, hints, `AnsweredBy`, recording, auth) **and** adds two new
vendor integrations plus raw audio-frame handling on top. Nothing below
should be started before item 5's half-day spike answers those shared
questions — an unresolved barge-in or speculation redesign under arch C
would just have to be redone again under arch D.

## What D requires that C does not

Arch C keeps Twilio as the STT/TTS provider and only swaps the transport
(WebSocket `<Connect><ConversationRelay>` instead of HTTP `<Gather>`/
`<Say>`). Twilio still does the recognition and speech synthesis; we just
stop paying per-`<Gather>` and per-character for it.

Arch D removes Twilio from the STT/TTS path completely:

1. **A WebSocket server we run**, using Twilio's Media Streams
   (`<Connect><Stream url="wss://.../voice/stream" .../></Connect>` in the
   TwiML from `/voice/answer`, replacing `<Gather>`). Twilio opens this
   connection to us and streams raw call audio as base64-encoded mulaw
   8kHz mono frames inside JSON `media` messages, roughly every 20ms.
2. **A WebSocket client connection to Deepgram** per active call,
   streaming those same audio frames to Deepgram's real-time STT API and
   receiving transcript/interim-result JSON back.
3. **Direct calls to AWS Polly** (`SynthesizeSpeech`) for TTS, replacing
   Twilio's `<Say>`. Twilio's Media Streams is audio-in only by default;
   getting our synthesized audio back to the caller means streaming Polly's
   output into the same Media Streams connection as outbound `media`
   messages (Twilio supports bidirectional Media Streams for exactly this).
4. **Our own turn-taking and barge-in logic.** Today Twilio's `<Gather>`
   owns "when has the caller finished talking" (`speechTimeout`) and
   "should the caller be able to interrupt" (`bargeIn`). With raw audio,
   both become code we write: silence/end-of-utterance detection (Deepgram
   sends `speech_final`/`is_final` events we can key off, but confidence
   in that signal replacing `speechTimeout="2"`'s tuned behavior needs
   verification against a live call) and interrupting our own outbound
   Polly audio stream when Deepgram detects the caller has started talking
   again mid-reply.

## Zero-dependency feasibility (the load-bearing question)

`package.json` describes this codebase as deliberately zero-npm-dependency
raw Node, and that constraint is a hard rule for the keeper. Each piece
above assessed against it:

- **WebSocket server (Twilio -> us).** Node has no built-in WebSocket
  *server* (Node 22's global `WebSocket` is a client only, built on
  undici). A server means handling the HTTP `Upgrade` request ourselves on
  the existing `http.createServer` instance (`server.js:827`)'s `upgrade`
  event, computing `Sec-WebSocket-Accept` (base64 of SHA-1 of the client's
  key + the RFC 6455 magic GUID — `crypto.createHash('sha1')`, already a
  Node built-in, no library needed), then parsing/framing the WebSocket
  wire protocol by hand (frame headers, client-to-server masking,
  fragmentation, ping/pong, close handshake). This is a genuinely
  well-specified protocol (RFC 6455) and is buildable in a few hundred
  lines with no dependency — but it is new protocol-level code running in
  production on every live call, which is a different risk class from the
  JSON-over-HTTP code this file is today. **Feasible, not trivial.**
- **WebSocket client (us -> Deepgram).** Node 22's global `WebSocket` can
  make this connection with zero dependencies — this side is the easy one.
- **AWS Polly (`SynthesizeSpeech`).** Requires AWS SigV4 request signing
  (HMAC-SHA256 canonical-request signing, all built on Node's `crypto`
  module — no AWS SDK needed, same pattern as if we were calling S3 raw).
  Moderate, well-trodden amount of code; **feasible with no dependency.**
  Polly's `SynthesizeSpeech` REST API returns a complete audio buffer per
  call, not a stream — for the low latency this whole migration is chasing,
  replies need to be synthesized in small chunks (per sentence/clause) and
  streamed to Twilio as they complete, not one blocking call per full
  reply. That chunking/pipelining is new logic with no existing analogue
  in `say()` (`lib/voice.js:173`), which today just hands a whole string to
  Twilio and lets Twilio's own TTS handle it.
- **Deepgram real-time STT.** Standard WebSocket-with-bearer-token API,
  same client mechanism as above. **Feasible.**

Net: nothing here requires an npm dependency, but "no dependency" is not
the same as "small." The WebSocket server is the one genuinely hard,
novel piece — everything else is a longer but mechanical version of
patterns already in this codebase (`lib/stripe.js`, `lib/apollo.js` etc.
already do raw signed/authenticated HTTP calls to third parties).

## What ports over cleanly

Same list item 5 already established, unchanged by moving STT/TTS off
Twilio too:

- `think()` and `systemPrompt()` (`lib/voice.js:407,808`) — transport- and
  provider-agnostic, take `(call, heard)`, return `{ say, action, data }`.
- `warmCache()`, the 16-turn history cap, prompt-caching — orthogonal to
  audio transport.
- Call state (`calls` Map, `startCall`/`endCall`/`getCall`,
  `lib/voice.js:314-323`) — same shape; only what feeds `heard` changes
  (Deepgram transcript event instead of Twilio's `SpeechResult` param).
- `db.saveCall`, activity logging, transcript/outcome persistence — same
  semantics, different call site.
- `estimateCost()` (`lib/voice.js:145`) needs new rate constants
  (Deepgram per-minute, Polly per-character at the *direct* rate from
  COST.md's reseller-tax table, not the Twilio `<Say>` rate) but the same
  shape.

## What has to be rebuilt, not ported

Everything item 5 flagged as "needs a spike," now with a concrete
replacement mechanism to design against rather than an open question:

1. **`isNoise()` (`lib/voice.js:641`)** is tuned specifically against
   Twilio's speech-recognition confidence score and hint-word list.
   Deepgram returns its own confidence and interim-result semantics —
   the floor values (`NOISE_FLOOR`, `SHORT_FLOOR`) and the whole
   hint-word-protection logic need to be re-derived against Deepgram's
   actual score distribution on real calls, not assumed to transfer.
2. **`hintsFor()` / `BASE_HINTS` (`lib/voice.js:179,205`)** — Twilio's
   `hints` parameter has no direct Deepgram equivalent; Deepgram's
   keyword-boosting API (`keywords`/`keyterm` params, naming TBD by
   Deepgram's current API version) needs to be confirmed to exist and
   mapped from the same per-profile word list.
3. **Barge-in (`bargeIn`/`noisy` in `sayAndGather`, `lib/voice.js:224`)**
   — today this is a single TwiML attribute Twilio enforces. Under Media
   Streams it becomes: detect caller speech onset from Deepgram's stream
   while our own Polly audio is still playing out to the caller, then stop
   sending outbound `media` frames. This needs its own tuning pass live —
   the exact behavior `noisy: true` calls tune today (finish the sentence,
   then listen, shorter `maxSpeechTime`) has to be re-implemented as our
   own state machine, not configured.
4. **Machine detection (`AnsweredBy`, `MachineDetection: 'Enable'` at call
   creation, `lib/voice.js:896`, consumed at `server.js:1306`)** — this is
   a REST-API-level Twilio feature attached to the *call*, not the
   Gather/Stream TwiML, so it should keep working unchanged under Media
   Streams the same way item 5 expects it to survive ConversationRelay.
   Still needs confirming live, not assumed.
5. **Recording (`startRecording()`, `lib/voice.js:922`)** — also a
   call-level Twilio Recordings API feature, should be unaffected by what
   TwiML verb is driving the live audio. Confirm `<Start><Record>` (or the
   equivalent Recordings API call) coexists with an active
   `<Connect><Stream>`.
6. **Signature verification (`verifySignature()`, `lib/voice.js:156`)** —
   the Media Streams WebSocket connection needs its own auth story (the
   `start` message Twilio sends carries the Call SID and Stream SID,
   which can be cross-checked against Twilio's REST API, or the WS
   endpoint URL itself can carry a short-lived signed token minted at
   `/voice/answer` time). Not just a copy of HMAC-over-POST-params.
7. **Reply chunking for low-latency TTS** (new — not something item 5 had
   to solve, since Twilio's own `<Say>` streams internally). Needs
   sentence/clause-boundary splitting of `think()`'s `say` output so Polly
   synthesis and Twilio playback can start on the first chunk while later
   chunks are still being synthesized, rather than waiting for the whole
   reply.

## Rollout plan

Same shape as item 5's, one layer further out:

1. Land arch C first, including its own spike and canary rollout. It
   answers several of the "needs rebuilding" items above in miniature
   (transport swap, WS message auth, whether `AnsweredBy`/recording
   survive a non-Gather TwiML) at lower engineering cost, and validates
   whether the WebSocket-per-call operational model is sound before
   betting the harder D-specific pieces (a hand-rolled WS *server*, SigV4
   Polly signing, Deepgram integration) on top of it.
2. A second, D-specific spike: stand up the WebSocket server against a
   throwaway `/voice/stream` endpoint, get one real call's audio round-
   tripping through Deepgram STT -> `think()` -> chunked Polly TTS ->
   back to the caller, and resolve items 1-3 and 7 above against real
   audio and real latency numbers, not documentation. This is where most
   of the actual risk lives.
3. Parallel implementation behind a flag (`VOICE_TRANSPORT=streams`,
   alongside item 5's `relay` value), canary on the demo line or a single
   consenting account, then cut over per-account before flipping the
   default.

Do not attempt this as a single PR, and do not start it before arch C is
live — the WebSocket server alone is new protocol-handling code running
on every production call, and landing it at the same time as two new
vendor integrations and a rebuilt barge-in/noise state machine multiplies
the ways a live call can go wrong for callers, on a phone product where a
call going wrong is the whole product failing.

## Open questions for the D-specific spike

- What does Deepgram's real-time confidence/`speech_final` signal
  actually look like on real phone audio, and does it support keyword
  boosting equivalent to `hintsFor()`?
- What real end-to-end latency does chunked Polly synthesis + Media
  Streams playback achieve vs. Twilio's own `<Say>` — is the promised
  cost saving actually latency-neutral, or does un-bundling introduce a
  network hop that makes calls feel slower?
- Can `AnsweredBy` and `<Start><Record>` be confirmed working alongside
  an active `<Connect><Stream>` on a real call?
- What auth model protects the `/voice/stream` WebSocket endpoint from a
  spoofed connection, given it can't reuse `verifySignature()` as-is?

## Recommendation

Worth designing now (this doc) so the dependency on item 5 is explicit
and the hard part (a hand-rolled WebSocket server, zero-dependency) is
named before anyone budgets the work as "just swap the TTS/STT vendor."
Not worth implementing, or even spiking, until item 5's arch-C spike and
canary are done — arch D inherits every open question from that spike
and adds its own on top, and COST.md's own ranking (C first, "after C
proves out") already says the same thing. Re-open as an implementation
candidate once arch C is live in production.
