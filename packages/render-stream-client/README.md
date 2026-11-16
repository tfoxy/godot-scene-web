# @godot-scene-web/render-stream-client

A browser client for a render-stream host: it connects, applies the stream's transactions in a
wasm core, draws them on a WebGL2 canvas and returns credit. `createRenderStreamClient` is the entry
point; `client.stats()` reports what it is doing.

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
