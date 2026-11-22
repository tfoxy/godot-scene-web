# Running the capture on a streaming host

A reference for a product that embeds the capture in a running game (a "streaming host": a Godot
process that keeps running its scene while the capture mirrors it) and for whoever operates the
receivers in front of it. The wire is specified in `render-stream-N.md`; what each receiver
supports is in [features/render-stream-8/](features/render-stream-8/) (`native.json`,
`web-export.json`, `gsw-canvas.json`); render-stream/16, which only the GSW receiver speaks, has
[features/render-stream-16/gsw-canvas.json](features/render-stream-16/gsw-canvas.json).

Every `GRC_*` name below is read by the capture source (`capture/src/`); the pure self-test
`scripts/test/self-test-gate8z.ts` fails if this page names a variable the source does not.

## What a streaming host must not disable

A headless game process is often made cheap by throwing away exactly what the capture reads. A
host that streams must not:

- **hide, suspend or stop drawing its visuals.** The capture streams the canvas calls the scene
  makes; a scene that draws nothing streams nothing.
- **replace or evict the headless renderer's texture data.** Late-join adoption reads pre-arm
  textures back through `RenderingServer.texture_2d_get`, so a texture whose image was swapped for a
  placeholder adopts as that placeholder. The capture cannot detect such an evictor. To get the same
  memory saving safely, set `GRC_HEADLESS_TEXTURE_RELEASE=on` (below): the capture copies each
  VRAM-compressed texture first and only then hands the dummy renderer a 1x1 placeholder.

`Texture2D.get_image()` and `is_pixel_opaque()` on a released texture see the placeholder, as they
would under any evictor.

## Resident attachment lifecycle

`Engine.get_singleton("RenderStreamCapture")` exposes `attach(options: Dictionary = {}) -> int`,
`detach(options: Dictionary = {}) -> int` and `state() -> Dictionary`. Call them on the main thread.
Both options dictionaries must be empty. The singleton and library remain resident after detach;
use these methods for repeated streaming sessions in one process.

Attachment and streaming are separate states. Loading in `GRC_MODE=standby` starts attached.
For a rendered host, load the extension before scene resources are created with
`GRC_MODE=detached` to start in lean detached mode, then attach only when a receiver needs a stream.
Both modes default to `GRC_ADOPT=arm`; set it explicitly when configuring the host.
`arm()` starts a stream; `disarm()` ends it and returns to attached standby. To stop capture work,
wait for `disarmed`, then call `detach()`. On the next request,
call `attach()`, then `arm()`. An attach does not arm automatically. Each new arm is a new stream;
receivers connect using its new `armed` information.

`detach()` is synchronous: success means the lean table is installed, attachment hook admission is
closed, capture workers have joined, the live hub and listeners are closed, and the capture frame
callback is unregistered. The dormant singleton still accepts explicit control calls. The net module,
if loaded, stays mapped; detach does not unload it.

Lean detached mode retains descriptors that the renderer cannot return later: CanvasTexture
channels and settings, texture logical size (size override), texture-proxy base and viewport bindings,
multimesh allocation format and mesh binding, material-to-shader bindings,
shader default-texture bindings (including their indices), and particle configuration and links.
Registry-only hooks update these descriptors and retire freed RIDs. It releases attachment state
and payload copies: image pixels, mesh and multimesh buffers, shader code and material parameter
values. It runs no capture frame callback, mirror, encoder, payload worker or listener. Detach
therefore leaves a small amount of descriptor tracking active; it does not unload the extension.

`attach()` synchronously rebuilds capture state and restores standby interception and the frame
callback. With `GRC_ADOPT=arm`, the next arm recovers the current scene and rendered resource data
using the retained descriptors, as described below. Consumer carriers destroyed by detach must
be registered again before arming.

`state()["attachment_state"]` is `attached`, `detaching`, `detached`, `attaching` or `refused`.
It is independent of `state()["state"]`, the stream phase; after a successful detach the stream
phase can still read `standby`, while `can_arm` is false. A failed teardown or rebuild sets the
attachment state to `refused`; rejected calls leave it unchanged.
The attach/detach transitions are synchronous and have no completion signal: inspect their return
code and, on failure, `state()["last_refusal"]`.

| Code | Meaning for `attach()` / `detach()` |
| ---- | ---------------------------------- |
| `0` | Completed successfully. Attaching while already attached or detaching while already detached is idempotent. |
| `2` | `not-main-thread`, `capture-shutdown`, `attach-failed` or `detach-failed`. Engine shutdown is terminal; it cannot be followed by re-attach. |
| `31` | Nonempty options dictionary: `attach-config-invalid` or `detach-config-invalid`. |
| `44` | `busy` when the current attachment or stream state cannot accept the transition; detach also reports `detach-while-armed` for an armed or ended stream. Disarm and wait for standby before detaching. |

`arm()` while `attachment_state != attached` returns `3` with `last_refusal: capture-detached`.
After engine shutdown, `arm()` and `disarm()` return `2` with `last_refusal: capture-shutdown`.

## Late attach on a rendered host

Load the extension early, before the resources it must track are created. A typical windowed host
uses `GRC_MODE=detached`, `GRC_ADOPT=arm` and `GRC_ROOT_SIZE=observe`, alongside its calibration
and sink configuration. For each session, on the main thread:

1. Call `attach({})` and check for return code `0`.
2. Register any consumer carriers, then call `arm()` with the normal stream options.
3. Wait for `armed` and connect the receiver using that stream's information.
4. When idle, call `disarm()`, wait for `disarmed`, then call `detach({})`.

During arm and subsequent adoption of referenced RIDs, capture recovers these resources:

| Resource | Recovery on a rendered host |
| -------- | --------------------------- |
| Scene nodes and canvas items | Walk the live tree and request redraw under the attached hooks. |
| Textures and meshes | Read current payloads from the renderer. Supported compressed texture images are decoded for delivery. Texture proxies retain their identity and latest base/viewport binding, adopt their dependencies, and keep following frame updates after attach. |
| CanvasTexture | Use retained channel and shading settings, then adopt its texture dependencies. |
| Shaders and materials | Read shader code and current parameter values through renderer getters; use retained shader bindings and indexed default-texture bindings. |
| Multimeshes, including CPU particle multimeshes | Use the retained allocation descriptor and mesh link; read the instance buffer, visible count and custom AABB from the renderer. The buffer stride is never used to infer format. |
| GPU particles | Use retained configuration and dependency links; recover materials and draw-pass meshes, then restart active emitters before their first published snapshot. Completed one-shots remain stopped. |

Readback runs on the main thread during adoption, once per adopted resource in that stream. It can
stall the first publication while the GPU returns data; it does not add a recurring readback to
each frame. Detach releases those payload copies, so a later stream reads the current data again.

The consumer does not need to re-issue resource setters when lean tracking observed their creation.
GPU particle adoption can restart the host's active effect, including its authored preprocess;
it does not preserve the effect's previous simulation phase. Dependency and sub-emitter links are
installed before the restart. Only emitters whose `particles_get_emitting` is true at adoption are
restarted. A stopped emitter with live particles remaining (a one-shot tail or a just-stopped
continuous emitter) is adopted stopped: the receiver shows none of those remaining particles,
while the host can show them for at most one lifetime.

Loading the extension for the first time after resource creation has narrower support. Renderer
readback cannot recover descriptors that have no getter: untracked multimeshes and GPU emitters
remain typed `preload-multimesh` / `preload-particles` refusals, and runtime CanvasTextures or raw
material bindings without a recoverable owner can also be refused. Attaching late to an already
loaded lean capture is the supported path for these resources. Calling only `particles_restart()`
or re-sending a few setters cannot supply the missing creation descriptor.

Headless hosts retain the existing dummy-renderer adoption limits: the readbacks above require a
real renderer holding the current resource data. Use attached standby when a headless host must
retain resource updates that the dummy renderer cannot return.

## Capture environment

Set before the capture's GDExtension loads.

### Arming and the stream

| Variable | Effect |
| -------- | ------ |
| `GRC_CALIBRATION` | The calibration record for the exact engine binary. The hooks install only when it matches. |
| `GRC_MODE` | `validate` (default: check the seam, publish nothing), `arm` (hook and stream now), `standby` (load attached and wait for an arm), or `detached` (load with lean descriptor tracking; call `attach()` before `arm()`). |
| `GRC_EVIDENCE_DIR` | Where the capture writes `result.json` and its `evidence/` files. |
| `GRC_STREAM_VERSION` | Wire version of the sinks (default `6`; `6`, `8` to `18`). Later versions are opt-in. Up to `15` the live listener offers the chosen version first and older ones after it; `18` lists `.18`, `.17`, then `.16`; `17` lists `.17` then `.16`; `16` lists only `.16`. Each connection uses its selected subprotocol's version. `15` adds resource hints and the texture size override ([render-stream-15.md](render-stream-15.md)); `16` adds viewport surfaces ([render-stream-16.md](render-stream-16.md)); `17` adds client tweens ([render-stream-17.md](render-stream-17.md)); `18` widens the credit window to 1..8 ([render-stream-18.md](render-stream-18.md)). |
| `GRC_VIEWPORTS` | `on` (default) or `off`, read at load. On, the capture mirrors non-root viewports (a `SubViewport`, a `SubViewportContainer`, an embedded window) and a `GRC_STREAM_VERSION=16`, `17` or `18` stream carries them; the session says `"viewports":"on"`, or `"unavailable"` when the calibration record lacks a hook of the viewport family (the behaviour is then the off one). `off` keeps the typed `non-root-viewport` behaviour of earlier versions and sends an empty viewport table. A client's `viewports: false` option is the receiver-side switch; the stream is the same either way, so the host needs no restart to try either. |
| `GRC_RESOURCE_HINTS` | `on` (default) or `off`: whether a stream that speaks `/15` or later sends resource hints (when its payloads are not all inline). Moving a seat to `/16` does not force the hints' host cost; `off` sends none at `/15` or `/16`. A client keeps them in a table only with its `resourceHints` option, and ignores them otherwise. |
| `GRC_STREAM_OUT`, `GRC_STREAM_PATCH_OUT` | File sinks: a recording with full transactions, and one with patches. |
| `GRC_RESOURCE_STORE_DIR` | The out-of-band payload store a file sink's resources are written to. |
| `GRC_ADOPT` | `arm`: at arm, walk the scene tree and adopt existing canvases, layers, items, textures, meshes, glyph atlases, materials and shaders, so a running game can be captured mid-session. Must arm on the main thread. |
| `GRC_UNKNOWN_ITEM` | `strict` (default) or `skip`. An opt-in diagnostic: under `skip`, canvas items the mirror never saw created are withheld and counted instead of ending the stream. |
| `GRC_ROOT_SIZE` | Root window policy: `observe` (the windowed-host recipe below), `enforce-min-size`, or `presentation:<W>x<H>` (the headless root takes the game's logical size at arm, so the scene relays out under the hooks). |
| `GRC_MIRROR_MAX_ITEMS`, `GRC_MIRROR_MAX_COMMANDS` | Mirror caps (items; commands per item). A scene over a cap ends the stream with a typed reason, so raise them for a large game. |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES`, `GRC_RESOURCE_BUDGET_BYTES` | Per-payload ceiling and the host resource store's budget. |
| `GRC_RESOURCE_INLINE_MAX_BYTES` | Live: payloads up to this size ride the connection as resource records ahead of their transaction instead of being fetched by GET (default 0, off). Worth setting for content that creates many small payloads per frame, such as skeletal meshes. |
| `GRC_RESOURCE_HINT_BUDGET_BYTES` | `GRC_STREAM_VERSION=15` only: the at-rest bytes (coded body, its gzip sibling once made, variant bodies) of hinted payloads the current state does not name yet (default 268435456, 256 MiB). Hints past it, in priority order, are not sent (or are unhinted). Hinted bodies do not count toward `GRC_RESOURCE_BUDGET_BYTES`. |
| `GRC_RESOURCE_FORMATS` | Float texture formats a stream may carry (off by default; needs `/8` or later). |
| `GRC_SHADER_POLICY` | `source` (default) serves game shader code to receivers; `params` and `exclude` do not. |
| `GRC_ITEM_META` | Opt-in per-item metadata, as comma-separated grants (`groups`, `meta`, or column names; `/14` adds identity columns). |
| `GRC_PERF_TIMELINE_MAX_BYTES` | Bounds the perf timeline evidence file by rotating it (unbounded when unset). Set it on a long-running host. |

For a windowed host, use `GRC_ROOT_SIZE=observe`. Before arming, the consumer sets the root
Window's `content_scale_mode` to `canvas_items`, `content_scale_size` to W×H and
`content_scale_aspect` to `keep`. Godot letterboxes that logical presentation inside the host's
current window. The capture writes neither the window size nor its minimum size; the session's
`presentation_size` and the browser's backing store are W×H.

When window and presentation sizes differ, the session reports `host_size_status: degenerate-window`
and the browser reports `presentation_check: mismatch` / `oversampling-mismatch`. These diagnostics
are expected and harmless for this recipe: the receiver still draws. Glyph rasterisation and
StyleBoxFlat AA follow the host's stretch (window/logical), so fidelity follows the host window's
resolution. Resizing the window while armed keeps capture and drawing going at W×H without
re-arming, provided the logical size and aspect stay fixed. Godot updates its stretch and font
oversampling; session geometry remains the arm-time evidence. The resize can also report
`global-canvas-transform` without refusing or ending the stream.

### Textures

| Variable | Effect |
| -------- | ------ |
| `GRC_TEXTURE_DECODE` | `engine`: block-compressed textures (BC, RGTC, ETC2, ASTC) are decoded on the host with the engine's own `Image::decompress`, so every receiver can draw them. The default on `/8` and later. |
| `GRC_TEXTURE_WORKERS` | `sync` (default) or a pool size: copy, decode and hash textures on capture-owned workers instead of the calling thread. Worker recordings are not reproducible run to run. |
| `GRC_TEXTURE_PENDING` | With workers: `hold` (default) keeps a transaction back until its decodes finish; `publish` sends unfinished entries as `delivery-pending` and supplies them later. |
| `GRC_HEADLESS_TEXTURE_RELEASE` | `off` (default) or `on`: on a `headless` display server, a VRAM-compressed texture the capture has copied reaches the dummy renderer as a 1x1 placeholder. Pre-arm textures (which adoption reads back), refused textures and non-VRAM textures keep their data. Ignored on a rendered host (reported `not-headless`). The stream is unchanged. |
| `GRC_HEADLESS_CANVAS_TEXTURE`, `GRC_HEADLESS_PARTICLES`, `GRC_PREDRAW_PUMP` | Leave unset (`auto`). Godot's headless dummy renderer allocates no `CanvasTexture` or GPU-particles identity and never emits `frame_pre_draw`; from `/12` on, a headless host synthesizes them by default (render-stream-12.md "Headless defaults (HSD)"). `off` restores the refusal. |

Delivery variants and the host cache (`/9`):

| Variable | Effect |
| -------- | ------ |
| `GRC_HTTP_ENCODING` | `zstd,gzip` (default), a single `zstd` or `gzip`, either order of the two, or `off`: the content codings of payload GETs, most preferred first, negotiated per request (a request that takes neither gets identity bytes). The first is how texture bodies are held at rest. With a second one, each coded texture a live listener serves is also coded in it once, on background threads after publication (for the default pair, a parallel level-3 deflate on up to four threads), and kept beside the first (two small coded bodies, never an identity copy); a request that takes only the second coding while that copy is being made is answered at once with a chunked response that follows the encode, and gets identity bytes only when the copy cannot be made. Browsers send `zstd` only to loopback and https origins, and a plain-http LAN page sends `gzip, deflate`, so the default serves such a page gzip. Before the default listed both codings, that page got identity bytes. |
| `GRC_TEXTURE_DELIVERY` | `passthrough` (default: `decoded` plus the game's own `block` bytes where the host decodes), `rgba` (`decoded` only) or `basis-uastc` (adds a KTX2 UASTC variant). `decoded` is always offered. Needs `GRC_STREAM_VERSION=9` or later. |
| `GRC_TEXTURE_ENCODE_WORKERS`, `GRC_TEXTURE_UASTC_LEVEL`, `GRC_TEXTURE_BASIS_MIN_PX` | The UASTC encode pool size (separate from the decode pool), encoder level (part of the cache key), and the smallest texture that gets a Basis variant. |
| `GRC_TEXTURE_CACHE_DIR`, `GRC_TEXTURE_CACHE_MAX_BYTES` | A persisted host cache of decoded payloads and KTX2 files, keyed by source, encoding and encoder parameters and verified before serving; and its LRU budget. Must be outside any git repository. A later session on the same directory runs no decodes or encodes and publishes the same hashes. |

`scripts/prepare-textures.sh --cache <dir> (--project <dir> | --images <dir> | --list <file>)`
warms that cache before any session, headless on the pinned template, computing the same source
keys the hooks compute (`GRC_TEXTURE_ENCODE_DRAIN=1` is set by the script so the encodes finish).

### Live listener and carriers

| Variable | Effect |
| -------- | ------ |
| `GRC_LIVE_LISTEN` | `<host>:<port>` for the WebSocket listener and its payload GETs. Loopback unless exposed. |
| `GRC_LIVE_EXPOSE` | `loopback` (default) or `lan` (then `GRC_LIVE_LISTEN` may name `0.0.0.0`, `::` or a host IP, and `GRC_LIVE_AUTH=token` is required). |
| `GRC_LIVE_AUTH` | `none` or `token`: a bearer token the receivers present in their hello and on every GET. |
| `GRC_LIVE_ALLOWED_ORIGINS` | The browser origins allowed to connect (origin check and CORS). |
| `GRC_LIVE_MAX_CONNECTIONS`, `GRC_LIVE_MAX_MESSAGE_BYTES` | Admitted viewers (1..4, default 1; viewers share each published snapshot) and the message ceiling. |
| `GRC_LIVE_CREDIT_WINDOW_MAX` | The largest credit window granted to a receiver: 1..8, default 8. Below `/18`, hellos remain limited to 1..2. |
| `GRC_LIVE_CODING` | Live message coding offered from `/11` on: `zstd-base` (default), `zstd` or `off`. |
| `GRC_PUBLISH_FPS` | `uncapped` or a target rate 1..240 for publication. Every version uses this global period with a separate schedule per connection; credit back-pressure may publish more slowly. |
| `GRC_LIVE_TLS_CERT`, `GRC_LIVE_TLS_KEY` | The product's certificate pair: the WebSocket listener also serves `wss`. Needs the net module (`scripts/build-rs-net.sh`). |
| `GRC_LIVE_LAN_PLAINTEXT` | Whether the WebSocket listener also serves plaintext to LAN peers beside `wss`. |
| `GRC_LIVE_CARRIERS` | Which carriers start: `ws`, `wt` (WebTransport, in the net module), and consumer carriers registered through `grc_carrier_register` (`capture/src/grc_carrier.h`) or the `RenderStreamCarrier` engine class. |
| `GRC_LIVE_WT_LISTEN`, `GRC_LIVE_WT_CERT` | WebTransport's listen address (same syntax and loopback rule as `GRC_LIVE_LISTEN`) and certificate (`self`, a hash-pinned self-signed one, or `tls`, the pair above). |
| `GRC_LIVE_NET_MODULE` | Path of the net module when it is not beside the capture library. |
| `GRC_LIVE_TRACKS` | Opt-in tracks beside the view connection (for example the input track carrying `gsw-input/1`, `docs/input.md`). Ignored without `GRC_LIVE_LISTEN`. |
| `GRC_LIVE_TAP_DIR` | Keep a copy of the uncoded live messages here, as a valid recording. |

## Receivers

`/18` does not pace publication to the viewer's draw rate. Its adaptive effective window
`w_eff` bounds transactions in flight at the negotiated credit stage; credit at `applied`
bounds only transactions not yet applied. A viewer that draws more slowly than the host
publishes folds the surplus, as `/16` already does at short RTT. The client's two-undrawn
gate can defer application, but a draw can release several transactions together, so credits
can outrun draws. Pacing to viewer-reported draw capacity is future work, outside `/18`.
`GRC_PUBLISH_FPS` remains an explicit host publication limit.

A receiver states the version it speaks in its hello; it must speak one the host offers.

- `RS_RECEIVER_PROTOCOL=<n>` selects the version on the native receiver, the web export and GSW.
  From `/9` the hello carries `texture_encodings` and `gpu_formats`.
- Variant choice is the same rule everywhere (rs-core `delivery.rs`): the first encoding in the
  receiver's `texture_encodings` that the entry lists, `block` only when the format's family is in
  its `gpu_formats`, `decoded` last. `RS_RECEIVER_TEXTURE_ENCODINGS`, `RS_RECEIVER_GPU_FORMAT_MASK`
  and `RS_RECEIVER_VARIANT_POLICY=keep|upgrade` override it.
- GSW transcodes `uastc` in a Web Worker to whatever its WebGL context can upload (ASTC, ETC, BC or
  RGBA8), verifying the KTX2 first. A failed transcode (`delivery-transcode-failed`) falls back to
  `decoded` on every receiver.
- `RS_RECEIVER_CREDIT_WINDOW=2` (the default from `/7`) lets a receiver keep two transactions in
  flight. Every viewer costs the host its own copy of every message.
- A receiver's memory grows with payload churn; `RS_RECEIVER_MEMORY_BUDGET_BYTES` bounds the store,
  and a reconnect starts the receiver's sets afresh.

Read the feature manifest of the receiver you ship: its `entries` say `supported`,
`typed-unsupported`, `unobserved` or `declared-unverified` for every feature, and its `limits` list
the formats and encodings it accepts. Receiver configuration is documented in
[../receiver/README.md](../receiver/README.md).

## Transport

Keep the listener on loopback and front it with the product's own server: an HTTP/1.1 reverse proxy
that forwards the WebSocket upgrade and every payload GET, rewrites `Host` and adds
`X-Forwarded-*`. The wire does not change behind such a proxy. TLS, LAN exposure and the origin
allowlist are then the product's. The browser's HTTP cache is keyed by port, so keep one port
across sessions.

Alternatively the capture serves the LAN itself, opt-in: `GRC_LIVE_EXPOSE=lan` with `wss` on the
product's certificate, or WebTransport with a self-signed, hash-pinned certificate (`wt`). A
consumer that owns its own wire registers a carrier instead.
