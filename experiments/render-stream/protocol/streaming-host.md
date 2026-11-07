# Running the capture on a streaming host

A reference for a product that embeds the capture in a running game (a "streaming host": a Godot
process that keeps running its scene while the capture mirrors it) and for whoever operates the
receivers in front of it. The wire is specified in `render-stream-N.md`; what each receiver
supports is in [features/render-stream-8/](features/render-stream-8/) (`native.json`,
`web-export.json`, `gsw-canvas.json`).

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

## Capture environment

Set before the capture's GDExtension loads.

### Arming and the stream

| Variable | Effect |
| -------- | ------ |
| `GRC_CALIBRATION` | The calibration record for the exact engine binary. The hooks install only when it matches. |
| `GRC_MODE` | `validate` (default: check the seam, publish nothing), `arm` (hook and stream now), or `standby` (load and wait for an arm). |
| `GRC_EVIDENCE_DIR` | Where the capture writes `result.json` and its `evidence/` files. |
| `GRC_STREAM_VERSION` | Wire version of the sinks (default `6`). Later versions are opt-in; the live listener offers the chosen version first and older ones after it. |
| `GRC_STREAM_OUT`, `GRC_STREAM_PATCH_OUT` | File sinks: a recording with full transactions, and one with patches. |
| `GRC_RESOURCE_STORE_DIR` | The out-of-band payload store a file sink's resources are written to. |
| `GRC_ADOPT` | `arm`: at arm, walk the scene tree and adopt existing canvases, layers, items, textures, meshes, glyph atlases, materials and shaders, so a running game can be captured mid-session. Must arm on the main thread. |
| `GRC_UNKNOWN_ITEM` | `strict` (default) or `skip`. An opt-in diagnostic: under `skip`, canvas items the mirror never saw created are withheld and counted instead of ending the stream. |
| `GRC_ROOT_SIZE` | Root window policy: `observe`, `enforce-min-size`, or `presentation:<W>x<H>` (the headless root takes the game's logical size at arm, so the scene relays out under the hooks). |
| `GRC_MIRROR_MAX_ITEMS`, `GRC_MIRROR_MAX_COMMANDS` | Mirror caps (items; commands per item). A scene over a cap ends the stream with a typed reason, so raise them for a large game. |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES`, `GRC_RESOURCE_BUDGET_BYTES` | Per-payload ceiling and the host resource store's budget. |
| `GRC_RESOURCE_INLINE_MAX_BYTES` | Live: payloads up to this size ride the connection as resource records ahead of their transaction instead of being fetched by GET (default 0, off). Worth setting for content that creates many small payloads per frame, such as skeletal meshes. |
| `GRC_RESOURCE_FORMATS` | Float texture formats a stream may carry (off by default; needs `/8` or later). |
| `GRC_SHADER_POLICY` | `source` (default) serves game shader code to receivers; `params` and `exclude` do not. |
| `GRC_ITEM_META` | Opt-in per-item metadata, as comma-separated grants (`groups`, `meta`, or column names; `/14` adds identity columns). |
| `GRC_PERF_TIMELINE_MAX_BYTES` | Bounds the perf timeline evidence file by rotating it (unbounded when unset). Set it on a long-running host. |

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
| `GRC_HTTP_ENCODING` | `zstd` (default), `gzip` or `off`: content coding of payload GETs, negotiated per request; also how texture bodies are held at rest. Browsers send `zstd` only to loopback and https origins, so a plain-http LAN page needs `gzip` to get coded bodies. |
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
| `GRC_LIVE_CREDIT_WINDOW_MAX` | The largest credit window granted to a receiver. |
| `GRC_LIVE_CODING` | Live message coding offered from `/11` on: `zstd-base` (default), `zstd` or `off`. |
| `GRC_PUBLISH_FPS` | `uncapped` or a target rate 1..240 for publication. |
| `GRC_LIVE_TLS_CERT`, `GRC_LIVE_TLS_KEY` | The product's certificate pair: the WebSocket listener also serves `wss`. Needs the net module (`scripts/build-rs-net.sh`). |
| `GRC_LIVE_LAN_PLAINTEXT` | Whether the WebSocket listener also serves plaintext to LAN peers beside `wss`. |
| `GRC_LIVE_CARRIERS` | Which carriers start: `ws`, `wt` (WebTransport, in the net module), and consumer carriers registered through `grc_carrier_register` (`capture/src/grc_carrier.h`) or the `RenderStreamCarrier` engine class. |
| `GRC_LIVE_WT_LISTEN`, `GRC_LIVE_WT_CERT` | WebTransport's listen address (same syntax and loopback rule as `GRC_LIVE_LISTEN`) and certificate (`self`, a hash-pinned self-signed one, or `tls`, the pair above). |
| `GRC_LIVE_NET_MODULE` | Path of the net module when it is not beside the capture library. |
| `GRC_LIVE_TRACKS` | Opt-in tracks beside the view connection (for example the input track carrying `gsw-input/1`, `docs/input.md`). Ignored without `GRC_LIVE_LISTEN`. |
| `GRC_LIVE_TAP_DIR` | Keep a copy of the uncoded live messages here, as a valid recording. |

## Receivers

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
