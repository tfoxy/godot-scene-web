# @godot-scene-web/render-stream-client

A browser client for a render-stream host: it connects, applies the stream's transactions in a
wasm core, draws them on a WebGL2 canvas and returns credit. `createRenderStreamClient` is the entry
point; `client.stats()` reports what it is doing.

## Transparent clear

`transparentClear: true` clears the stream canvas to alpha 0, allowing the page to composite an
underlay beneath it. Set it when creating the client. The default is `false`, which keeps the
host's clear colour and blending unchanged. The executor uses an alpha-enabled, premultiplied
WebGL2 context and an RGBA8 root target for 8-bit alpha coverage. Only the root canvas changes; non-root viewport surfaces keep their host clears.
The option does not change the wire or require a host restart.

## Static GPU particles

`staticParticles: true` warms each GPU emitter to a representative frame, uploads it once, and
holds it until a restart or reconfiguration. Per-frame emission transforms and velocities update
future spawn inputs without warming or uploading the held frame. The default is `false`. CPU
particles remain live.
The warm uses the authored preprocess, capped at twice the lifetime; without preprocess it uses
0.4 lifetimes for a one-shot and one lifetime for a repeating emitter. Long warms use the normal
paced settling slices and draw nothing until ready.

`client.setStaticParticles(on)` switches at runtime: enabling warms current emitters, and disabling
starts fresh live simulations. A created client always has this method; it is optional on the
`RenderStreamClient` interface for consumer test doubles. Frozen emitters do not schedule further
simulation or redraws. A one-shot retires after `lifetime * (2 - explosiveness)` seconds from first
sight emitting, checked on the next apply or presentation. If nothing else redraws, retirement can
appear late; there is no expiry timer. The host and wire are unchanged.

## Idle frame cap

`frameCap` trades ambient smoothness for battery and heat over long sessions on a GPU-bound device:
presenting half the frames halves the fill. Change it at runtime with
`client.setFrameCap(mode, bounds?)` (`setFrameCap` and `wake` are optional on the `RenderStreamClient` type, so test doubles need not
implement them; a created client always has both).

| Value           | Behaviour                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Every frame callback presents. Nothing is measured.                                                                                                                                                                                                            |
| `automatic`     | After `FRAME_CAP_QUIET_MS` (1.5 s) with no input and only ambient motion, the client presents every other frame callback (30 fps on a 60 Hz panel). The first frame callback after an input or a real change presents again, and the quiet period starts over. |

- **Ambient motion** is judged per transaction from how far changed visible content moved on screen
  and how much its colours stepped, not from damage area. Scene content (items, canvases, an
  emitter's transform) and animation content (the host's per-frame animation systems: skeletal
  bodies, CPU particle instances, a looping flipbook) have separate bounds, set with the
  `frameCapBounds` option or `setFrameCap(mode, bounds)`; a field left out takes its default:

  | Bound                | Default                                    | Counts as ambient                                                   |
  | -------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
  | `motionPx`           | `IDLE_MOTION_MAX_PX`, 1 px                 | a background drifting by a fraction of a pixel                      |
  | `colorStep`          | `IDLE_COLOR_STEP_MAX`, 8/255               | a glow pulse whose swing takes half a second or more                |
  | `animationPx`        | `IDLE_ANIMATION_MAX_PX`, 128 px            | an idle skeleton and background layers sweeping, motes drifting     |
  | `animationColorStep` | `IDLE_ANIMATION_COLOR_STEP_MAX`, unbounded | slot colours cycling and flashing (set a step to make flashes wake) |

  All are per transaction (presentation px; colour channels 0..1). Only what is shown counts: a
  part or particle off screen, or faint (at most 4/255 of it reaches a pixel), on both sides of a
  transaction moves invisibly. Shaders driven by time and a GPU emitter's own simulation are
  ambient too.

- **A real change** wakes the cap: an item added, removed, reordered, shown or hidden, a change of
  content (new text, a sprite frame, another shape), material, clip or resource, an emitter
  restarted, toggled or reconfigured (amount, lifetime, process material, ...), a multimesh
  reallocated, a flipbook frame not shown before, motion or a colour step past the thresholds, a
  payload that arrives late, a resync or a new session.
- **Input** wakes the cap: a pointer, touch, key or wheel event anywhere in the canvas's document.
  A consumer with its own input layer, or a gamepad, calls `client.wake()` for each input.
- **The stream is unaffected.** Every transaction is still received, applied and acked as it
  arrives, and fetches, holds and revisits run as before, so the host keeps its rate. A transaction
  first shown by a later frame is acked `submitted` with that frame. With
  `creditStage: "submitted"` and credit window 1 the host is paced by the presented frames, as it
  always is at that stage.
- A core built without the motion measure never engages the cap.

`stats()` reports `frameCap`, `frameCapEngaged` (capped right now), `cappedFrames` (frame callbacks
while engaged), `skippedFrames` (those that presented nothing) and `frameCapWake`, what last woke
the cap or kept it awake (`input`, `session`, `payload`, `motion`, `colour`, `resource`, ...): when
the cap never engages on a scene that looks idle, it names what the scene keeps changing.

## Viewport surfaces (render-stream/16)

An endpoint with `protocol: 16` makes the client offer exactly `render-stream.16`: a /16 host lists
nothing else, so there is no fallback and no upgrade rule, and the endpoint must name the version the
host runs (`GRC_STREAM_VERSION=16`). A /16 stream carries the host's non-root viewports (a
`SubViewport` shown through a `ViewportTexture`, a `SubViewportContainer`, an embedded window), and
the client draws each into its own surface.

| Option          | Default | Effect                                                                                                                                                                                                                                                                          |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewports`     | `true`  | `false` builds no surface pass: the viewport table is still applied, every viewport texture draws transparent, and `stats().surfacesSkipped` counts what the frame reached and did not build. The wire is the same, so the host needs no restart. Below /16 it changes nothing. |
| `resourceHints` | `false` | Enables the hint table, idle prefetch and hint stats (see below). At /16 it does not change the offer; the host's `GRC_RESOURCE_HINTS` decides whether it sends any. Below /16 it offers `render-stream.15`, as before.                                                         |

The host's own switch is `GRC_VIEWPORTS=on|off` (default on), documented with the other `GRC_*`
variables in `experiments/render-stream/protocol/streaming-host.md`. `stats()` reports
`surfacesRendered`, `surfacesSkipped`, `surfacesUnchanged`, `surfacesAllocated` and `surfacePixels`
(the last apply's; all 0 on a stream with no viewport surface). Items inside a surface are not
pickable on the client (`pick_tree` stays root-only).

## Resource hint prefetch

With `resourceHints: true`, the client keeps the host's hints in `hints()` and fetches their payloads
while idle: no demand GET is queued or in flight, and no accepted transaction is waiting on
payloads. Hints start in ascending `priority`, then arrival order. Demand GETs take priority; demand
for a hash already being prefetched joins that GET.

| Option                | Default             | Effect                                                                                                                                             |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefetchMaxInFlight` | `2`                 | Maximum concurrent hint GETs, capped at 3 to leave one of the four GET slots for demand. `0` disables prefetch.                                    |
| `prefetchBudgetBytes` | `67108864` (64 MiB) | Per-connection payload byte budget for completed and in-flight hint GETs. A hint starts only if its selected payload fits in the remaining budget. |

Prefetch uses the same encoding and variant selection as demand. Payloads are verified and staged
in wasm memory, so a later transaction can use them without another GET; GPU upload waits until
first draw. An older core without hint selection keeps the table but does not prefetch. An unhint
prevents a new hint GET; one already in flight may finish and keep its bytes. Connection end clears
the scheduler and its byte budget. With `resourceHints: false` (the default), no hint GETs run and
hint stats are absent.

### Hint stats

On a `resourceHints` client, `stats()` includes these fields. Counters accumulate across connections;
`hintsPending` counts current entries.

| Field                                           | Meaning                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `hintsReceived`, `unhintsReceived`              | Hint and unhint records received.                                                                                  |
| `hintsPending`                                  | Hints whose payload is neither held nor already referenced by an accepted transaction.                             |
| `hintsReferenced`, `hintsLate`, `hintsDropped`  | Hints first referenced after arrival, hints arriving after a reference, and hints dropped by the table's bound.    |
| `hintLeadMsMin`, `hintLeadMsMax`, `hintLeadLog` | Shortest and longest hint-to-first-reference lead in ms (`null` before a reference), and the recent reference log. |
| `hintsPrefetched`                               | Hint GETs successfully verified and staged.                                                                        |
| `hintPrefetchBytes`                             | Payload bytes successfully prefetched, in bytes.                                                                   |
| `hintPrefetchFailed`                            | Hint payloads whose fetching (after retries) or verification failed.                                               |
| `getRetries`                                    | Additional GET attempts after temporary failures, for demand and hints.                                            |

## Payloads that arrive late or not at all

`fetchInWorker` defaults to `true`: WebSocket resource GETs run in a small pool of dedicated
workers per transport, one per wire slot, created on first demand. Each worker hashes the body
it fetched (a native SHA-256 when the page has `crypto.subtle`, otherwise an incremental one as
chunks arrive) and transfers it with its digest; staging accepts that digest only for the hash it
requested and skips the wasm hash, so the main thread only copies the bytes. Download slots refill
on completion without waiting for a frame. Set `fetchInWorker: false` to use main-thread fetching;
unavailable worker APIs or a worker that fails before it starts also select that fallback for the
transport's lifetime, with one warning. A worker that fails later is retired alone, and only its
request falls back. WebTransport keeps its own resource path. Demand and
prefetch share four wire slots. A new GET starts only with a free wire slot and less than
64 MiB buffered for staging, with no body count limit; requests already in flight may finish
above that byte threshold, and a single oversized body can drain without blocking the queue.
Bodies that stop being wanted while waiting are released without staging. Ready demand bodies
stage in request issue order before advisory bodies, without waiting for outstanding GETs.

Textures, meshes and shader code are content-addressed payloads, fetched over HTTP when a
transaction needs one the client does not hold. Up to four GETs run at once, and every body is
verified (SHA-256) and decoded before use.

- **Loading.** By default (`resourceHoldMs: 0`) a transaction never waits for a payload. What draws
  a missing payload is left out and everything else is drawn, the way a web page shows text before
  its images. Each payload pops in on the first frame after it arrives, with no transaction needed.
  The client never draws an older payload in a newer one's place.
- **Shader code** follows the same rule. A material whose code has not arrived draws nothing of its
  own, and neither does anything that inherits that material. Items with their own material, child
  transforms, clipping and input are unaffected. When the code arrives it is compiled before the
  draw that uses it. A shader the client cannot compile is a different case: it draws without its
  material, as Godot draws a shaderless one.
- **Particles.** An emitter whose process material depends on code that has not arrived is
  suspended, so its old output is not drawn. It restarts from a fresh simulation once the code
  arrives. Other emitters keep running.
- **Unavailable payloads.** The client never gives up the stream over a payload the host cannot
  serve. A GET that ends in one of these outcomes settles on its own:
  - `missing`: 404 or 410.
  - `temporary`: 408, 429, a 5xx status, a network error, or no progress for `fetchTimeoutMs`.

  The other GETs keep going. Only `temporary` failures are retried: at most three additional
  attempts, after delays of 250, 500 and 1000 ms on the loop clock. Demand retries continue only
  while the payload is still needed; prefetch retries continue only while it is still hinted and
  obey the idle and priority rules above. `missing` and fatal failures are never retried.

  A `missing` result or an exhausted temporary retry settles as unavailable: the payload is not
  fetched again while the stream keeps naming it. It is fetched afresh when a later transaction
  names it again after one that did not, or after a reconnect.

- **Obsolete payloads.** Once the stream no longer names a payload, its queued GET is dropped. A GET
  already in flight finishes, and its body is kept only if the stream names the payload again.
- **Fatal errors.** These still fail the stream with a `failed` status: a 401 or 403, any other
  status, a request that cannot be made, a body that fails verification or decoding, and protocol
  errors.
- **Context restore.** After a WebGL context restore, the client refetches any resident payload it
  no longer holds. One that cannot be fetched is dropped from the GPU, what drew it is left out, and
  the rest is redrawn.

### Diagnostics

`stats().resources` (`ResourceDiagnostics`) reports unavailable payloads. It never changes the
status.

| Field                           | Meaning                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`                   | Payloads unavailable now.                                                                                                                                                                                                             |
| `found`, `missing`, `temporary` | Findings since the client started.                                                                                                                                                                                                    |
| `recent`                        | The last `RESOURCE_LOG_MAX` findings, one per hash, each with its `hash`, `kind` (0 texture, 1 mesh, 2 shader, 3 KTX2), `seq` (the transaction that first needed it), `reason`, HTTP `status`, `detail`, `restore`, `count` and `at`. |

The object stays the same until something changes, so polling it is cheap.

`stats().deferredPayloads` counts payloads still loading that the drawn frame went without.

## Shader readiness

`stats().programs` reports `defined`, `refused`, `library_reads`, and `identical_glsl`: distinct code hashes defined with byte-identical fragment and vertex GLSL to an earlier program, without deduplicating programs or comparing uniform defaults; counters reset when the wasm instance is replaced.

Live mode defines pending custom shaders in slices of 4 ms or three programs per call,
always attempting at least one. Shaders beyond the slice stay held: their materials' draws
are omitted until a later frame defines and links them. Held shaders progress even when
no transaction arrives. A reset clears the held list.

Program links settle only after their completion signal (or a signalled WebGL fence when
parallel shader compilation is unavailable). Each poll starts another settle only while
its 8 ms budget remains, always settling at least one ready program. A status read already
in progress can overrun the budget. Pending materials stay omitted; a failed link uses
the existing shaderless refusal behavior. File replay
defines every shader before its first apply. Older wasm builds without `hold_program` keep
unbudgeted definition.
