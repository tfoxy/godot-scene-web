# @godot-scene-web/render-stream-client

A browser client for a render-stream host: it connects, applies the stream's transactions in a
wasm core, draws them on a WebGL2 canvas and returns credit. `createRenderStreamClient` is the entry
point; `client.stats()` reports what it is doing.

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

## Payloads that arrive late or not at all

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

  The other GETs keep going. The payload is then treated as never arriving: it is not fetched again
  while the stream keeps naming it, and there is no timed retry. It is fetched afresh when a later
  transaction names it again after one that did not, or after a reconnect.

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
