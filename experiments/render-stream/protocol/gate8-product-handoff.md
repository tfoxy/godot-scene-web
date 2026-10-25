# Gate 8 hand-off: running the capture on a streaming seat

For the product that embeds the capture (couch-coop's streaming seat) and for whoever operates a
receiver in front of it. Gate 8 proves the generic mechanisms on stock-template fixtures; this note
says what to set, what to switch off and what is left to the product. Contract:
[gate8-design.md](gate8-design.md); texture delivery: [texture-delivery-design.md](texture-delivery-design.md);
what each receiver supports: [features/render-stream-8/](features/render-stream-8/); summary:
[../results/gate8.md](../results/gate8.md).

This repository does not edit `../sts2-couch-coop`. Everything below is the contract the product
implements under its own rules.

## What the seat has to opt out of

A streaming seat is a headless Godot process that keeps running its scene while the capture mirrors
it. Two couch-coop mechanisms make a headless seat cheap by discarding exactly what the capture
reads, so a seat that streams must not install them:

- **`CouchCoopHeadlessVisualSuspender`** hides or suspends the seat's visuals. A suspended scene
  draws nothing, so there is nothing to stream.
- **`HeadlessTextureImageEvictor`** replaces the dummy renderer's copy of every VRAM-compressed
  texture with 1x1 data to reclaim memory (measured there on a live seat: 1491 images, 456 MB).
  Late-join adoption reads that copy through `texture_2d_get`, so an evicted texture would adopt as
  1x1. The capture cannot detect the evictor; the product leg's census (a 1x1 image behind a
  texture drawn at 4096 px) will.

Both are product classes, named here only so the seat role can skip them (gate8-design.md Q1c).

## Capture environment

Set before the capture's GDExtension is loaded. Every name below is read by the capture source
(`capture/src/`); the pure self-test `self-test-gate8z.ts` fails if this note names a variable the
source does not.

| variable | value for a streaming seat | what it does |
| -------- | -------------------------- | ------------ |
| `GRC_MODE` | `arm` | arms the hooks (the calibration must pass first) |
| `GRC_LIVE_LISTEN` | `127.0.0.1:<port>` | the live listener; keep it loopback and front it (see "Transport") |
| `GRC_STREAM_VERSION` | `8`; `9` for Basis/pass-through delivery | wire version of the sinks. Under a gate 8 policy the live listener offers `render-stream.8` only (`.9` then `.8` at 9), so no older decoder sees a field it would reject |
| `GRC_ADOPT` | `arm` | late-join adoption: at arm, walk the scene tree and adopt canvases, layers and items; pre-arm textures, meshes, glyph atlases (lazily), materials and shaders |
| `GRC_UNKNOWN_ITEM` | `skip` | items the mirror never saw (RS-only objects with no node) are withheld and counted instead of ending the stream (`strict` is the default) |
| `GRC_TEXTURE_DECODE` | `engine` | block-compressed textures (BC1-BC7, RGTC, ETC2, ASTC) are decoded on the host with the engine's own `Image::decompress`, so every receiver gets RGBA8/R8/RG8 |
| `GRC_TEXTURE_WORKERS` | `2` | copy, decode and hash on a capture-owned pool; the calling thread keeps a copy-on-write duplicate (6-16 us instead of 31-112 ms per 2048x2048 create). The capture default is `sync`; recordings made with workers are not reproducible run to run |
| `GRC_ROOT_SIZE` | `presentation:1920x1080` (the game's logical size) | the headless root window takes the presentation size at arm, after adoption, so the running scene relayouts under the hooks. One size per session |
| `GRC_MIRROR_MAX_ITEMS`, `GRC_MIRROR_MAX_COMMANDS` | raise for the game | the mirror's caps (defaults 4096 items, 1024 commands per item); a scene over a cap ends the stream with a typed reason. STS2 has about 2,400 live items |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES` | raise for large atlases | per-payload ceiling (default 64 MiB) |
| `GRC_RESOURCE_BUDGET_BYTES` | raise for the game's texture working set | host resource store budget (default 512 MiB) |
| `GRC_LIVE_MAX_MESSAGE_BYTES`, `GRC_LIVE_MAX_CONNECTIONS` | per deployment | message ceiling (default 16 MiB); admitted connections (1..4, default 1) |
| `GRC_RESOURCE_INLINE_MAX_BYTES` | `4096` (P3-LV) | live: a payload of at most this many bytes rides the WebSocket as a resource record ahead of the transaction instead of a GET. Every STS2 mesh surface (max 2,284 B) does, which a game with skeletal animation needs: at the default 0 every pose is a GET, and no receiver kept up in combat (see "Live at game scale") |
| `GRC_LIVE_AUTH`, `GRC_LIVE_ALLOWED_ORIGINS` | `token`; the page origins | the hello token and the CORS/origin allowlist (gate 7) |
| `GRC_SHADER_POLICY` | the product's choice | `source` (default) serves game shader code to the operator's own receivers only; `params` or `exclude` do not |

`GRC_ADOPT=arm` refuses to arm off the main thread (`adopt-thread`), and any gate 8 policy with a
file sink that is not /8 refuses to publish (`policy-needs-v8`). `GRC_RESOURCE_FORMATS` lists the
float formats a stream may carry (off by default; it needs /8).

### Delivery and cache (render-stream/9)

Wire bytes and receiver GPU memory are settings, not one fixed behaviour (texture-delivery-design.md
D1-D9). All of them default to today's behaviour.

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_HTTP_ENCODING` | `zstd` (default), `gzip`, `off` | content coding of payload GETs, negotiated per request through `Accept-Encoding`; no wire change. The gate 6 scene's 1.5 MB of GETs becomes 70 KB. The native receiver opts out with `RS_RECEIVER_ACCEPT_ENCODING=off` |
| `GRC_TEXTURE_DELIVERY` | `rgba` (default), `passthrough`, `basis-uastc` (`basis-etc1s` is refused until G8ke) | which variants the host offers per texture, declared by a /9 session. `rgba` is `decoded` only; `passthrough` adds `block` (the game's own BC/ETC2/ASTC bytes); `basis-uastc` adds `uastc` (KTX2 UASTC LDR 4x4 + zstd) for each eligible texture. `decoded` is always offered, so every receiver has a fallback. Needs `GRC_STREAM_VERSION=9` |
| `GRC_TEXTURE_ENCODE_WORKERS` | `1..16` (default `2`) | the UASTC encode pool (below normal priority), separate from the decode pool so a seconds-long encode never holds publication back |
| `GRC_TEXTURE_UASTC_LEVEL` | `0..4` (default `1`) | encoder level; the level is part of the cache key |
| `GRC_TEXTURE_BASIS_MIN_PX` | default `16384` | smallest texture that gets a Basis variant; updated textures, glyph atlases and non-RGBA/RGB formats never do |
| `GRC_TEXTURE_CACHE_DIR` | a directory outside any repository | persisted host cache: decoded payloads and KTX2 files keyed by (source key, encoding, encoder parameters), each verified against its name before it is served. A second session on the same directory runs zero decodes and zero encodes and publishes the same hashes, which also keeps a browser's HTTP cache valid across sessions |
| `GRC_TEXTURE_CACHE_MAX_BYTES` | bytes | LRU budget (by last use) for that directory |

`scripts/prepare-textures.sh --cache <dir> (--project <dir> | --images <dir> | --list <file>)`
warms the cache before any session runs, on the pinned template, headless: it computes the same
source keys the hooks compute and stores the host decodes and, unless `--no-uastc`, the UASTC
encodes too (a /9 `basis-uastc` sink with an end-of-stream drain, `GRC_TEXTURE_ENCODE_DRAIN=1`, set
by the script; `--encode-workers` and `--uastc-level` pass through). A session on the prepared
directory runs zero encodes and serves every uastc variant from the cache (`prepare-uastc-warm`). The
cache directory is refused inside a git repository.

`GRC_TEXTURE_PENDING` (`hold` default, `publish`; needs `GRC_TEXTURE_WORKERS=<N>`) chooses what an
asynchronous decode that is not finished does: `hold` keeps the transaction back, `publish` sends the
entry as `delivery-pending` (a /9 reason: no decoded hash yet) and a later transaction supplies it.
The native receiver and the web export recover (`delivery-pending`, native gate 8); GSW shares the
applier but no gate 8 leg drives it with pending entries. It is opt-in because it makes
a worker recording differ from the synchronous one by pending frames.

### Receivers

A receiver behind a gate 8 host must say so in its hello:

- `RS_RECEIVER_PROTOCOL=8` (every kind) offers `render-stream.8` only; `9` selects the /9 hello with
  `texture_encodings` and `gpu_formats` (native, web export, GSW);
- the native receiver and the web export pick a variant by the same rule (rs-core `delivery.rs`):
  the first encoding in its `texture_encodings` that the entry lists, `block` only if the format's
  family is in its `gpu_formats`, `decoded` last; `RS_RECEIVER_TEXTURE_ENCODINGS` and
  `RS_RECEIVER_GPU_FORMAT_MASK` override, `RS_RECEIVER_VARIANT_POLICY=keep|upgrade` chooses whether a
  better variant that appears later is refetched (GSW reads the same variable; its default is
  upgrade on a phone-class context, keep on a desktop);
- GSW lists `block`, `uastc` and `decoded` since G8kb: a Web Worker runs a basisu transcoder wasm
  and uploads ASTC 4x4 (RGBA, and RGB since G8kb2), ETC1/ETC2, BC7/BC3/BC1 or RGBA8 by what the
  WebGL context lists, hash-verifying the KTX2 first;
- a `uastc` variant whose transcode fails (`delivery-transcode-failed`) falls back to `decoded` on
  every receiver (native, web export: G8kf; GSW: G8kb), and the web export states only the texture
  families its WebGL context can upload and sends a BC `block`/`uastc` of a non-4-aligned level 0
  decoded (G8kwh, `bc_aligned_only`).

Per-receiver status, with the evidence each row cites, is in
[features/render-stream-8/](features/render-stream-8/): `native.json`, `web-export.json`,
`gsw-canvas.json`. Read the manifest of the receiver you ship; its `entries` say `supported`,
`typed-unsupported`, `unobserved` or `declared-unverified` for every feature, and its `limits`
carry the formats and encodings the receiver lists.

### Live at game scale (P3-LV)

Measured on STS2 (menu, map, combat) with the settings above, `/8` decoded, loopback
([../results/p3/p3-lv.md](../results/p3/p3-lv.md)):

- **Set `GRC_RESOURCE_INLINE_MAX_BYTES=4096`.** Without it, combat updates reach a receiver 0.1–0.9
  times a second and 2–5.6 s late, because every spine pose is a new payload fetched by GET at
  about one per frame. With it, GSW follows the game at its frame rate on the menu and the map
  (52–56 updates a second, 5–17 ms behind). In combat it follows the host's publication rate.
- **Receiver: GSW, credit window 2** (`RS_RECEIVER_CREDIT_WINDOW=2`, the `/7`+ default). It is the
  only receiver whose main thread keeps up with combat's ~2,000 inline records a second.
  - The web export and the native receiver handle every record in GDScript. They manage 6–15
    combat updates a second, though they are fine on the menu and the map.
  - Window 2 roughly doubles the web export and the native receiver on the menu and the map
    against window 1.
- **Each viewer costs the seat about two fifths of what it did** (P3-SP,
  [../results/p3/p3-sp.md](../results/p3/p3-sp.md)). Viewers share the published snapshot, and
  viewers in step share each transaction's diff and encode and every inline record. In STS2 combat
  the seat held 53 fps with one GSW viewer and 37 fps with four (35 and 22 fps before). A viewer still
  costs its own copy of every message, and the diff and encode whenever its base differs from the
  others'. Up to 4 connections (`GRC_LIVE_MAX_CONNECTIONS`).
- **Memory still grows with mesh churn, more slowly**, until the `/11` changes (P3-LV's dynamic
  mesh surfaces and P3-SP's carried set bounded by the resolved state, render-stream-2.md).
  - The seat holds one carried-hash entry (about 40 bytes) per distinct inline hash for all
    viewers together, about 0.6 GB an hour of 60-fps combat (2.3 GB an hour per viewer before
    P3-SP). It is freed when the last viewer leaves.
  - GSW keeps every payload it receives (its validator no longer keeps a second copy since
    P3-SP). In STS2 combat its wasm heap grew 5–7 MB a second (more when it keeps up, since every
    pose it is sent stays), so a GSW viewer reaches wasm32's 4 GB after roughly ten minutes of
    combat. Until the `/11` changes, reconnect a viewer before that. `RS_RECEIVER_MEMORY_BUDGET_BYTES` bounds the
    store, but at this churn the evictions turned into re-fetches on the fixture (P3-SP's result
    doc): treat it as untested at game scale. The GDScript cache of the native receiver and the
    web export is O(1) a payload under a budget since P3-SP.
  - Plan session length or reconnects accordingly: a reconnect starts the receiver's sets afresh.
- **A fresh subscriber's first frame takes the decoded textures' bytes**: 3.3 s for a GSW joining
  STS2 combat at `/8`, and 1.7 s at `/9` `basis-uastc` with a cold cache. A prepared
  `GRC_TEXTURE_CACHE_DIR` takes the encodes off the session.

## Transport (P2)

The listener stays loopback. The product's own server fronts it: an HTTP/1.1 reverse proxy that
forwards the WebSocket upgrade and every GET, rewrites `Host` and adds `X-Forwarded-*`. Gate 8
proves the capture works behind such a proxy with no wire change (`g8l-proxy-fronted`: one upgrade
and 13 GETs through `scripts/lib/reverse-proxy.ts`, a test double, not a production proxy). TLS,
LAN exposure and the origin allowlist are the product's. The browser's HTTP cache is keyed by port,
so keep one port across sessions.

## Product sequence

- **P1, the streaming seat role.** One seat, flagged as the streaming seat, skips the two classes
  above and loads the capture with the environment above. It lands with or after F2.
- **P2, transport fronting** as above.
- **P3, game legs (F1).** Re-run gates -0.5 and -0.25 on the current game binary (MegaDot changed
  between 2026-10-08 and 2026-10-10 and may again), then one visual leg with a replay contact
  sheet, evidence in couch-coop's ignored research tree. Each launch of the installed game needs the
  operator's explicit go-ahead; nothing in this repository launches it or touches the Steam
  directory.

Open forks, as gate8-design.md lists them, with their defaults:

- **F1, launching the installed game.** Default: no launch until the generic increments are on
  `main` and P1 is ready; then ask once for a single isolated headless launch under couch-coop's
  instance rules.
- **F2, couch-coop's `worktree/render-capture-m05`.** One commit (14f4434b, the env-gated
  `GDExtensionManager.LoadExtension` loader at mod init) on an October 8 base, never merged.
  Default: rebase it and land it on couch-coop `main` together with P1, under that repository's
  rules; until then game legs use a local rebuild.
- **F3, compressed passthrough and a decoder dependency.** Superseded: texture delivery
  (`block`, `uastc`) replaced "Route C", and a Basis dependency is approved (texture-delivery-design.md).

## What gate 8 does not tell the product

Wire bytes, GPU memory and host memory at STS2 scale (measured by P3, not by fixtures); that the
installed game is captured correctly; several or negotiated presentation sizes; arm on first
subscriber and disarm on last; non-loopback serving or TLS in the capture; particles, multimesh,
skeletons, `Light2D` and the shader reasons gate 5.5 types. The full list is
[gate8-design.md](gate8-design.md) "What gate 8 does not prove" and
[../results/gate8.md](../results/gate8.md).
