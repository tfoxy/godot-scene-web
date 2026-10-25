# Texture delivery design (G8k): HTTP compression, pass-through and KTX2/Basis tiers

Status: design written 2026-10-23 (increment G8k). G8kw (the texture worker pool and the
publication hold-back, D11/Q7) is landed: Q7 "As built (G8kw)", [results/gate8/g8kw.md](../results/gate8/g8kw.md).
G8kz (HTTP content coding) is landed: "As built (G8kz)". G8k9 (the render-stream/9 wire, codecs and
validators only) is landed: "As built (G8k9)", [render-stream-9.md](render-stream-9.md),
[results/gate8/g8k9.md](../results/gate8/g8k9.md). G8kp (`passthrough` end to end: the capture's
`block` variant, D3 in the native and GSW receivers, the /9 hellos) is landed: "As built (G8kp)",
[results/gate8/g8kp.md](../results/gate8/g8kp.md). G8kv vendors basisu and builds its UASTC encoder
("As built (G8kv)"). G8ku (`basis-uastc` on the host, the native receiver and the web export: lazy
uastc variants, D12, D14, D16's checks, UASTC level 1) is landed: "As built (G8ku)",
[results/gate8/g8ku.md](../results/gate8/g8ku.md). Nothing else here is implemented. This doc
follows [gate8-design.md](gate8-design.md) and replaces its deferred "Route C" (gate8-design Q3,
"Deferred") and fork F3. User decisions of 2026-10-23 (memory texture-delivery-direction):

- G8t's host decode to RGBA8 is fine to ship for now.
- Texture delivery needs **settings**: today's bytes are too much for a four-player LAN and
  unacceptable over the internet.
- The target is **KTX2/Basis Universal**: UASTC (plus zstd) for LAN, ETC1S for the internet.
  WebP and AVIF are ruled out. A basisu dependency is approved.
- Pass-through of the game's own BC data to desktop receivers is a mode too.
- An eager host prepare-and-cache step is an option, and the lazy path stays.
- Nothing may depend on how a game ships its assets.

The headline finding changes the order. STS2's art is mostly transparent or flat, so plain
**HTTP zstd on today's RGBA payloads already cuts the census from ~855 MB to ~76 MB per client**
(Q8). That needs no new format and no wire version. Basis then adds:

- the **GPU memory** cut, 4 B/px down to 0.5-1 B/px. The phone needs this most: as RGBA8 it would
  hold ~855 MB of census textures;
- cheaper hash verification on the phone (it verifies the compressed bytes);
- a further 1.6x (UASTC) or 7x (ETC1S) on bytes.

Everything stays content-addressed. Each delivered payload's SHA-256 is its wire hash, and receivers
verify before use, as since /2.

Generic parts land here on stock-template fixtures. Applying them to STS2 is couch-coop's job
(gate8-design "Product sequence"). Nothing here adds a product concept to the capture, the wire or
`packages/`.

## Decisions

| #  | Topic | Decision |
| -- | ----- | -------- |
| D1 | Modes | **`GRC_TEXTURE_DELIVERY=rgba\|passthrough\|basis-uastc\|basis-etc1s`**, a host/session setting, default `rgba` (today's behavior). Each mode names the **variants the host offers** per texture (Q3). `rgba` = `decoded` only. `passthrough` = `decoded` + `block`. `basis-uastc` (LAN) = `decoded` + `block` + `uastc`. `basis-etc1s` (internet) = `decoded` + `etc1s`. `decoded` is the /8 payload (G8t's RGBA8/R8/RG8, or the uncompressed source); it is always offered, so every receiver has a fallback. |
| D2 | HTTP content coding | **`GRC_HTTP_ENCODING=off\|zstd\|gzip`** (default `zstd` since G8kz, see "As built (G8kz)"), orthogonal to D1 and **valid at every live version ≥ /2**. It is plain HTTP negotiation (`Accept-Encoding` → `Content-Encoding`), not a change to framing, keys or payload format, so no wire version. It applies to GRT1 bodies only. KTX2 bodies are already entropy-coded (Q5). It lands first (G8kz). |
| D3 | Who picks a variant | **The receiver**, from the variants listed in the texture entry, by a fixed rule. The rule is the first encoding in its own hello `texture_encodings` that the entry lists. `block` counts only if the variant's format family is in its `gpu_formats`, and `decoded` is always last. The host uses the hellos only to decide which variants are worth preparing lazily (Q4). It never rewrites a transaction per connection, so file recordings, stores and every connection share one stream. |
| D4 | Wire | **`render-stream/9`, on the version-switch pattern** (`V9` in `rs2_codec.*`/`rs2_diff.*`, `version: … \| 9` in `render-stream-2.ts`, rs-core and capi). Changes against /8: texture entries gain `variants`; a `render-stream-texture/ktx2` payload profile; GRT1 may carry the BC/ETC2/ASTC source formats as a `block` variant; the session gains `resources.texture_delivery` (G8k9 renamed it from `resources.delivery`, a key /2 already uses for out-of-band/inline); the hello gains `texture_encodings` and `gpu_formats`; the texture reason `delivery-pending` (Q5). A /8 or older connection sees exactly /8, the `decoded` payload, so no refusal is needed. |
| D5 | Base entry stays /8 | **`hash`, `format`, `payload_bytes` and `source_format` keep their /8 meaning: the `decoded` variant.** `variants` only adds alternatives. Every /8 rule (`decode-entry`, `texture-version`, the oracle) holds unchanged, and a receiver that ignores `variants` is a correct /8 receiver. |
| D6 | Variant lifetime | **`version` counts content; `variants` may grow at equal version.** A lazy encode that completes publishes a patch entry with one more variant at the same `version`. A content change, such as `texture_2d_update`, raises `version` and resets `variants` to what is ready for the new content. A receiver that already holds any variant of the current version keeps it (`keep`, the desktop default). `upgrade` (the phone default) refetches when a variant it prefers appears, which trades bytes for GPU memory. |
| D7 | Cache key | **The source key is the SHA-256 of the hooked image as a GRT1 payload in its own format.** For BC sources that is the `block` variant's hash; for uncompressed sources it is the `decoded` hash. A cache entry is keyed by (source key, encoding, `params_id`). `params_id` names the encoder and every setting that changes bytes, for example `basisu-1.60/uastc-l2/zstd6/linear`. The key is hashed from 1 B/px for BC sources, about 4 ms per 4 Mpx with SHA-NI (results/gate8/g8sha.md). |
| D8 | Host cache | **Memory always, disk opt-in.** Set `GRC_TEXTURE_CACHE_DIR=<dir>` (outside any repository) and `GRC_TEXTURE_CACHE_MAX_BYTES` (LRU by last use). The layout is the store directory's own: `sha256/<hash>.grt\|.ktx2`, plus `index-v1.jsonl` mapping each key to the variant's hash and bytes. Every file is verified against its name before it is served, and a corrupt file is deleted and re-encoded. Encoded bytes are stored, never regenerated: the encoder is not assumed deterministic across thread counts or CPUs. `decoded` bytes may be regenerated on a GET instead, because `Image::decompress` is deterministic and the hash checks the regeneration. The persisted cache also keeps hashes stable across sessions, which is what lets a browser's own HTTP cache reuse them (memory g7l-browser-live-facts: keyed by port, so the product keeps one port). |
| D9 | Prepare step | **Optional, two forms.** (a) Host startup prepares, in the background, every texture the host already holds: adopted pre-arm textures (G8r) and everything created so far. (b) A `prepare-textures` CLI (a headless stock-4.5.1 script plus the capture's encoder) walks a Godot project's `.godot/imported/*.ctex`, or an image directory. It computes each source key exactly as the hook would: an IMAGE ctex's bytes as-is; a PNG/WebP ctex decoded to its header format (Q1b). It then fills D8's cache. Without either, the cache warms during live sessions (the lazy path). |
| D10 | Matched sources | **A source file is a hint; the hooked bytes are the truth.** The capture hooks `texture_set_path` (an RS virtual; the engine calls it after `texture_2d_create` with the `res://` path, `compressed_texture.cpp:91-96`, `:158-161`), keeps a path per texture and logs it. A file-derived variant is accepted only if it re-derives the hooked bytes exactly. Example: a Basis-mode ctex's KTX2 (Q1b) is accepted only if Godot's transcoder turns it into the hooked BC7 bytes bit for bit. Everything else is derived from the hooked image itself, which is always available. |
| D11 | Threading | **Copy, decode, source-key hash, payload hash, encode and HTTP precompression run on a capture-owned worker pool** (`GRC_TEXTURE_WORKERS`, default 2, below normal priority). The hook only takes a copy-on-write `Resource.duplicate(false)` of the Image, as G8t does, and enqueues it. Workers touch only their private duplicate and never call the RenderingServer. G8kw lands this at /6-/8 by holding back publication (Q7). `GRC_TEXTURE_WORKERS=sync` keeps today's synchronous path for frame-exact gates. |
| D12 | Which textures get Basis | **A Basis variant is offered for an `image` texture only if all of these hold:** (a) it was never `texture_2d_update`d; glyph atlases and in-place-updated textures stay `decoded`; (b) its payload format is RGBA8 or RGB8, or a BC/ETC2/ASTC source decoded to RGBA8; (c) it has at least `GRC_TEXTURE_BASIS_MIN_PX` texels (default 16384, 128²); (d) for ETC1S, a host-side transcode back to RGBA scores at least `GRC_TEXTURE_ETC1S_MIN_PSNR` (default 36 dB) against the decoded source, otherwise the texture gets UASTC instead. L8/LA8/R8/RG8 and floats stay `decoded`. |
| D13 | KTX2 profile | **One 2D image, 0 layers, 1 face; the level count equals the entry's mip chain.** The levels are given to basisu explicitly from the decoded source (no `m_mip_gen`). `vkFormat` is `UNDEFINED`; the codec is ETC1S with BasisLZ or UASTC LDR 4×4 with Zstandard (level 6). The DFD transfer is **linear**: Godot's KTX loader transcodes an sRGB-flagged file to RGBA32 instead of a GPU format (`modules/ktx/texture_loader_ktx.cpp:255-319`). Godot 2D textures carry raw values. |
| D14 | Transcode target | **One rule for every receiver: Godot's own KTX2 loader rule** (`texture_loader_ktx.cpp:255-319`). With 4 channels the order is ASTC_4x4 → BC7 → BC3 → ETC2_RGBA → RGBA32. With 3 channels it is BC7 → BC1 → ETC1 → RGBA32. GSW maps WebGL extensions to Godot's feature names and applies the same rule. So every receiver class on a given GPU holds the same blocks, and an oracle can reproduce them. |
| D15 | Encoder and transcoder source | **basisu 1.60, the copy Godot 4.5.1 vendors**: upstream BinomialLLC/basis_universal commit `323239a6`, Apache-2.0, with Godot's five patches, and zstd 1.5.7 (BSD-3-Clause). It is copied from the local `../godot-4.5.1-stable/thirdparty/` into `experiments/render-stream/third_party/` with its LICENSE and a provenance note, so nothing is downloaded. Host encoder, GSW transcoder, native receiver and web export then all run one transcoder revision. Godot's encoder is editor-only (`modules/basis_universal/SCsub:17-45`), so the capture compiles its own. Fork K1 covers a newer upstream. |
| D16 | Exactness | **Lossy tiers are judged against their own oracle, never against the source.** `transcode-oracle`: each receiver's uploaded blocks equal an independent Godot `Image.load_ktx_from_buffer` of the same payload, for the same target. `delivery-reference`: receiver pixels equal a reference drawing that oracle's CPU-decoded image; BC hardware decode is G8t's informative band. `quality-band`: PSNR against the decoded source is recorded per texture and floored by D12(d). The gates' exactness contract stays intact. |

## Q1. Facts the design rests on

### Q1a. Godot's own basis module (local 4.5.1 source)

- **The transcoder ships in release templates; the encoder does not.** `basisu_transcoder.cpp`
  builds on every platform with `BASISD_SUPPORT_KTX2_ZSTD=1`, ATC/FXT1/PVRTC off
  (`modules/basis_universal/SCsub:46`, `:66-80`). The encoder is `editor_build` only (`:17-45`).
  `modules/ktx` (libktx 4.4.0) depends on it and builds everywhere (`modules/ktx/config.py`). The
  pinned `linux_release.x86_64` and both pinned web templates contain the KTX2 loader's
  transcode-failure string, so their transcoder is linked in.
- **Script-reachable transcode, no new dependency:** `Image.load_ktx_from_buffer`
  (`core/io/image.cpp:3610`, `:4137`) → `ktxTexture2_TranscodeBasis` with D14's target rule; it
  handles ETC1S/BasisLZ and UASTC+zstd. The native receiver and the web export can transcode
  through the engine.
- **The packer is UASTC-only, KTX2 + zstd 6.** It is reachable from scripts only in the editor,
  through `PortableCompressedTexture2D.create_from_image(…, COMPRESSION_MODE_BASIS_UNIVERSAL)`,
  with `set_basisu_compressor_params(uastc_level, rdo_quality_loss)` and
  `set_keep_compressed_buffer(true)` (`image_compress_basisu.cpp:103-131`). `Image.compress` has no
  Basis mode. The ctex unpacker (`:281-406`) prefers BC7 → ASTC → BC1/BC3 → ETC2 → RGBA8.
- **Headless:** the dummy renderer's `has_os_feature` answers true for rgtc/bptc/s3tc/etc2
  (`servers/rendering/dummy/storage/utilities.h:83-85`), so on a headless host a KTX2 transcodes
  to BC7, as measured.

### Q1b. `.ctex` storage and matching a live texture to a file

- Header: `GST2`, u32 version, width, height, flags, mipmap limit, 3 reserved; at offset 36 the
  u32 data format (`IMAGE 0`, `PNG 1`, `WEBP 2`, `BASIS_UNIVERSAL 3`), u16 w, u16 h, u32 mips, u32
  `Image.Format`; payload from 52 (`compressed_texture.cpp:43-63`, `:296-301`). Import
  `compress/mode` 0 lossless → WebP lossless (PNG only if `force_png` or > 16383 px), 1 lossy →
  WebP, 2 VRAM compressed → IMAGE with the block format (`.s3tc.ctex`/`.bptc.ctex` variants on
  desktop), 3 VRAM uncompressed → IMAGE, 4 Basis → u32 size + 4-byte Godot header + KTX2.
- **What the hook sees:** for an IMAGE ctex, exactly the file's bytes (`:420-444` → `:144-147`);
  for PNG/WebP, the decoded pixels in the header's format; for Basis, Godot's transcode (BC7 on a
  headless host). So D7's key is computable from a `.ctex` without running the game (D9b).
- **RID → path:** no reverse map in core. `ResourceCache::get_cached_resources` is not bound, and
  the dummy's `texture_get_path` returns `""` (`dummy/storage/texture_storage.h:115-116`). But the
  engine *calls* `RS::texture_set_path(rid, "res://…")` on load
  (`compressed_texture.cpp:91-96`), which the capture can hook (D10). Adopted textures (G8r) get
  their path from the node's `Texture2D.resource_path`.

### Q1c. The STS2 pack, read-only

Listed by a read-only PCK reader (scratch script; the pack opened `rb`; nothing written, copied or
launched) over the Steam library's STS2 install, `SlayTheSpire2.pck`:

- PCK format v3, engine 4.5.1, directory not encrypted; 12,327 files, 1.90 GB.
- **No source PNGs.** One 6.9 KB PNG is the only raw image file. There are 3,485 `.ctex`
  (1,222.7 MB) and 3,895 `.import` remaps, and no `.ktx2`/`.basis`/`.webp`.

| ctex data format | Image format | count | bytes | Mpx | as RGBA8 |
| ---------------- | ------------ | ----- | ----- | --- | -------- |
| IMAGE (VRAM) | BPTC_RGBA | 683 | 701.7 MB | 700.8 | 2.80 GB |
| IMAGE (VRAM) | DXT5 | 516 | 211.0 MB | 210.7 | 0.84 GB |
| IMAGE (VRAM) | DXT1 | 23 | 9.0 MB | 17.9 | 0.07 GB |
| IMAGE | RGBAH | 1 | 2.1 MB | 0.3 | — |
| WEBP lossless | RGB8 | 707 | 177.8 MB | 472.8 | 1.89 GB |
| WEBP lossless | RGBA8 (incl. 5 extended-header) | 1,532 | 121.2 MB | 458.9 | 1.84 GB |
| WEBP lossless / lossy | L8, LA8 | 23 | 0.1 MB | 1.0 | — |

No PNG-in-ctex, no Basis-in-ctex, no mipmaps except 11. zstd -3 over the BC payloads (streamed
from the pack into a pipe): BPTC 701.7 → 135.6 MB (19.3%), DXT5 211.0 → 29.4 MB (14.0%), DXT1
9.0 → 1.5 MB (16.6%).

### Q1d. The recovered project

`../sts2-couch-coop/.sts2/toolchain/recovered-project/` (GDRE Tools 2.4.0 export of the same pack,
2.7 GB, 20,265 files):

- 3,485 texture imports: 3,476 PNG, 8 SVG and 1 EXR. 3,278 sit under `images/`, 194 under
  `animations/`.
- Import modes: 2,254 lossless (431 MB of PNG), 683 VRAM high-quality → BPTC (218 MB of PNG), 539
  VRAM → S3TC (70 MB of PNG), the EXR VRAM uncompressed, and none Basis.
- **The PNGs are not the artist's originals for VRAM textures.** GDRE reports 1,231 lossy
  conversions: those PNGs are its decode of the BC data, the same texels G8t's `decoded` payload
  carries. The lossless family's PNGs are the exact WebP pixels. PNG runs 1.45x the pack's WebP
  lossless (431 vs 299 MB).
- **Mapping to the census:** every BPTC (65/65), DXT5 (87/87) and DXT1 (7/7) texture of the
  2026-10-10 leg has a same-size asset of the same import family. 165 of its 445 RGBA8 textures
  have none, so they are made at runtime. Size is ambiguous (only 15 of 65 BPTC sizes are unique),
  so matching needs D10's path or D7's content key.
- **Consequence for D9:** recovered PNGs can key only lossless textures, and only if the PNG's
  channel layout equals the ctex header format. A BC texture's key exists only in the `.ctex` or
  at the hook. The pack's `.ctex` keys everything exactly, but reading the installed game is the
  product's call (fork K3).

## Q2. Measurements (development host, Ryzen 5 5500, 12 threads, 2026-10-23)

Nine recovered PNGs stratified by family and size, from 144×144 to 3440×1616. Two encoders were
used:

- **UASTC:** the pinned 4.5.1 editor's packer, headless.
- **ETC1S and transcode timings:** a scratch tool over the vendored basisu 1.60 sources (compiled
  locally, nothing downloaded).

Per-file HTTP zstd/gzip was measured over **all 3,476 PNGs** in a headless Godot process. All
outputs are in the scratchpad only.

Caveats:

- Encode times are wall time on a 12-thread job pool at loadavg 4-6, beside another agent's gate
  legs, so read them as upper bounds.
- PSNR is computed over all four channels against the decoded source, transparent texels
  included.

| family (sample px) | RGBA+zstd3 (all files) | BC+zstd3 (pack) | UASTC L2+zstd6 | ETC1S q128 | UASTC PSNR | ETC1S PSNR (rgb) |
| ------------------ | ---------------------- | --------------- | -------------- | ---------- | ---------- | ---------------- |
| BPTC art | 0.335 B/px | 0.193 | 0.139 (0.60x RGBA+zstd) | 0.024 (0.10x) | 56-63 dB | 39-45 dB |
| DXT5 art | 0.277 | 0.140 | 0.095 (0.65x) | 0.029 (0.20x) | 58-99 | 44-99 |
| lossless art (card portraits, UI) | 0.518 | — | 0.479 (0.58x) | 0.096 (0.12x) | 43-54 | 31-35 |

- **Encode, 12 threads:**
  - UASTC L2: 2-9 Mpx/s; L0 is 15-35 Mpx/s at 0.9x the bytes and 1-3 dB less.
  - UASTC RDO 1.0-3.0: 2-3x slower for 5-15% fewer bytes. Not worth it.
  - ETC1S q128: 1.8-2.8 Mpx/s at compression level 2, and **3.3-9 Mpx/s at level 1 with identical
    bytes**, so level 1 is the default.
  - ETC1S q255 is *larger* and barely better.
- **Transcode, desktop native, one thread:**
  - UASTC → ASTC 250-700 Mpx/s, → BC7 108-148, → ETC2 94-325, → RGBA32 200-525;
  - ETC1S → ETC2 560-1190, → ASTC 211-564, → BC7 85-242.
- **Godot's loader picked BPTC_RGBA** on the headless editor for every KTX2, as Q1a predicts.
- **Not measured:** the g31. Estimated at ~20x desktop native (memory g7x-rust-core-phone-facts:
  phone wasm ~11x desktop wasm). That puts UASTC → ASTC at ~12-35 Mpx/s and ETC1S → ETC2 at
  ~28-60 Mpx/s. G8ku and G8ke measure it.

## Q3. Modes, negotiation, fallbacks

| mode | variants offered | desktop receiver takes | g31 takes | lossy | host cost per texture |
| ---- | ---------------- | ---------------------- | --------- | ----- | --------------------- |
| `rgba` | decoded | decoded | decoded | no | G8t decode + hash |
| `passthrough` | decoded, block | block (BC, exact) | decoded | no | + key hash (1 B/px) |
| `basis-uastc` | decoded, block, uastc | block | uastc → ASTC/ETC1 | UASTC only | + UASTC encode (Q7) |
| `basis-etc1s` | decoded, etc1s | etc1s → BC7/BC1 | etc1s → ETC2/ASTC | yes | + ETC1S encode, PSNR check (D12) |

- **Hello (/9):** two flat string keys, so the hello grammar stays flat, with no arrays or
  booleans:
  - `texture_encodings`: the receiver's preference, comma-separated, from
    `block,uastc,etc1s,decoded`;
  - `gpu_formats`: Godot's feature names (`s3tc,bptc,rgtc,etc2,astc`).

  Each matches `^[a-z0-9]+(,[a-z0-9]+)*$` and is at most 96 chars.
  - **Native and web-export receivers** fill `gpu_formats` from `RenderingServer.has_os_feature`.
  - **GSW** fills it from WebGL extensions:
    - `s3tc` from `WEBGL_compressed_texture_s3tc`;
    - `bptc` from `EXT_texture_compression_bptc`;
    - `rgtc` from `EXT_texture_compression_rgtc`;
    - `etc2` from `WEBGL_compressed_texture_etc`;
    - `astc` from `WEBGL_compressed_texture_astc`.

    On the g31 that is `etc2,astc`.
  - A receiver omits `uastc`/`etc1s` if it has no transcoder.
- **Fallbacks, all typed and counted:**
  - **No usable variant:** the receiver takes `decoded`.
  - **Not ready yet:** a variant still encoding is simply not listed (D6), and `upgrade` receivers
    switch to it when it appears.
  - **Encoder failure or a refused texture (D12):** no variant, counted in
    `stream.gate8.delivery_stats`.
  - **Transcode or upload failure on the receiver:** `delivery-transcode-failed`, then the
    receiver fetches `decoded` (always servable).
  - **/8 or older connection:** /8 entries, `decoded` only.
  - **File sink:** the store holds every variant produced, and a replaying receiver picks by D3.

## Q4. Sources and the host cache

1. **The live texture's own bytes** are always available. Every variant can be derived from them:
   the BC bytes as `block`, their decode as `decoded`, and either as the Basis encoder's input.
2. **A matched source file** (D10) is used only when it provably re-derives the hooked bytes. For
   STS2 it adds nothing: no source PNGs ship, and the BC bytes *are* the source (Q1c, Q1d).
3. **The eager cache** (D8, D9), keyed by D7, is persisted and may be filled by a prepare step.
   Estimated whole-game prepare: 1.87 Gpx takes ~4-15 min for UASTC L2 and ~4-10 min for ETC1S
   level 1 on 12 threads, about 460 MB and 90 MB on disk (Q8).
4. **The lazy path** runs when no cache entry exists:
   - The texture publishes with the variants that are immediate: `decoded`, plus `block` for BC
     sources.
   - Workers encode the mode's Basis variant in the background. They give priority to textures a
     connected receiver drew but holds only as `decoded` while preferring a Basis variant (its
     hello says so).
   - The finished variant then publishes per D6.

Content addressing is unchanged:

- Each variant's `hash` is the SHA-256 of exactly the bytes served, GRT1 or KTX2.
- Receivers verify before use, and the store/HTTP path is `/resources/sha256/<hash>` for every
  variant.
- Cache index rows are hints. A hit is used only after its file verifies.

## Q5. Wire

**At every live version ≥ /2 (G8kz, D2).** These rules apply when the request's `Accept-Encoding`
allows it and the host enables it:

- **Coding:** GRT1 bodies go out with `Content-Encoding: zstd` (level 3, precompressed once per
  hash on a worker and kept beside the payload) or `gzip`.
- **Headers:**
  - `Vary: Accept-Encoding` (with `Origin` where /7's CORS adds it);
  - `Content-Length` is the coded length;
  - the ETag is `"<hash>"` for identity and `"<hash>-zstd"`/`"<hash>-gzip"` per coding. RFC 9110
    requires strong validators to differ by content coding. `If-None-Match` accepts either.
- **Verification:** receivers check the hash on the identity bytes after decoding. Browsers decode
  transparently (Chrome has zstd since 123); the native receiver sends `Accept-Encoding: zstd` and
  decodes it itself (G8kz: `decompress_dynamic` has no zstd, so it is `PackedByteArray.decompress` with the frame's content size; gzip uses `decompress_dynamic`).
- **Default:** a host or receiver that never sends or accepts it behaves exactly as today. That
  is why no version is needed.

**render-stream/9 (G8k9), as /8 plus exactly:**

- magic `GRS9`, subprotocol `render-stream.9`, `GRC_STREAM_VERSION=6|8|9`;
- session `resources.texture_delivery` (the design said `resources.delivery`, which would duplicate /2's
  `resources.delivery` key; G8k9 renamed it), right after `resources.decode`: `{"mode":<D1 mode>,
  "encoder":null|<params_id prefix, e.g. "basisu-1.60">}`;
- texture entries, right after `payload_bytes`: `"variants":[{"encoding":"block"|"uastc"|"etc1s",
  "hash":<hex>,"payload_bytes":<int>,"format":<name>|null,"params":<params_id>|null}…]`. The list is
  sorted by encoding in that order, at most one per encoding, and is `[]` for anything but an `ok`
  image. `block` carries `format` (the source block format) and `params` null. Basis variants carry
  `format` null and `params` non-null. Invariant code `delivery-entry`;
- **`block` payloads** are GRT1 with a block format (DXT1, DXT3, DXT5, RGTC_R, RGTC_RG, BPTC_RGBA,
  the ETC2 family, ASTC_4x4/8x8). `data_bytes` follows Godot's size for the format
  (`Image::get_image_data_size`). Legal only as a variant, never as the base entry;
- **`render-stream-texture/ktx2` payloads** are a KTX2 file per D13. The resource record's block,
  the store file (`<hash>.ktx2`) and the HTTP body (`Content-Type: image/ktx2`, never
  content-coded) are exactly those bytes. Validators parse the header, level index and DFD:
  identifier, `vkFormat` 0, supercompression 1 (BasisLZ) or 2 (Zstandard), color model
  ETC1S/UASTC, transfer linear, and pixel size and levels equal to the entry's. Errors:
  `ktx2-header`, `ktx2-shape`;
- the texture reason `delivery-pending`: at /9 the async worker path (D11) may publish it when a
  hook-time hash is not ready. At /6-/8, G8kw holds back publication instead (Q7), with no wire
  change;
- **hello:** /8's keys plus `texture_encodings` and `gpu_formats` (Q3);
- **goldens:** `golden-9/` gets a full/patch/inline triple with a `block` and a `uastc` variant,
  built from tiny committed synthetic KTX2s (generated by the vendored encoder, never game
  content). `golden-2/` through `golden-8/` must pass unchanged.

Inline resource records (`inline_max_bytes`) carry only `decoded` payloads, because D12(c) keeps
small textures off Basis.

## Q6. Receivers: transcoding and GPU memory

- **Native receiver:**
  1. rs-core verifies the hash (capi gains a `ktx2` payload kind; the Rust side checks KTX2 shape
     only);
  2. the GDScript glue calls `Image.load_ktx_from_buffer` (D14's rule);
  3. it uploads with `ImageTexture.create_from_image`.

  `block` goes to `Image.create_from_data` with the block format: GLES3 uploads it if supported and
  CPU-decodes it otherwise, as for any `.ctex`. No new dependency.
- **Web export:** the same engine path in wasm. The pinned web templates link it (Q1a). The template
  has no threads, so a transcode runs on the main thread when the payload arrives. Estimated g31
  hitch for a 4 Mpx texture: ~120-330 ms with UASTC → ASTC, ~70-150 ms with ETC1S → ETC2. That is
  load-time only. The web export prefers `etc1s` when offered. G8ku measures; a JS worker through
  `JavaScriptBridge` is deferred.
- **GSW:**
  - **Transcoder:** a standalone transcoder wasm, built with the approved emsdk 4.0.11 from D15's
    vendored sources (transcoder + zstd decompress only, LDR formats only), running in a Web
    Worker. It runs on arrival, before first use: G7o2's pattern, so step-transaction p95 is
    untouched. It is preferred over basisu's prebuilt `basis_transcoder.wasm` (a download, and a
    different revision than the engine) and over Rust crates (C++ bindings that do not build for
    `wasm32-unknown-unknown`).
  - **Upload:** `compressedTexImage2D` in `packages/canvas/rust-prototype/src/canvas_items/gl.rs`
    (GSW's upload, via `gsw-rs`). If that change reaches a published `packages/canvas` export, its
    commit needs a real `Changelog:` line.
  - **Phone cost estimate (Q2):** for the census's 173 Mpx compressed set, ~5-14 s of worker CPU
    with UASTC → ASTC and ~3-6 s with ETC1S → ETC2. Today the phone spends ~7 s just SHA-256-ing
    855 MB of RGBA (memory g7o2-step-transaction-p95: ~8.6 ms/MB); Basis payloads are ~1-5% of
    those bytes, so verification shrinks with them.
- **GPU memory per texel:** `decoded` RGBA8 4 B; `block` BC7/BC3 1 B, BC1 0.5 B; Basis to
  ASTC_4x4/BC7/ETC2_RGBA 1 B, to ETC1/BC1 (opaque) 0.5 B. For the census's 216 Mpx (173 compressed
  + 43 uncompressed): **~855 MB as `decoded`**, ~336 MB with desktop `block`, **≤ ~216 MB with
  Basis**. The g31 (no S3TC/BPTC) only gets below 855 MB through Basis.

## Q7. Host cost and threading

- **Today, on the main thread (G8t + G8sha), per 2048² create:** 32-48 ms (DXT/BPTC: decode
  11-29 ms, copy 11-15 ms, hash 8.4 ms) and 100 ms for ASTC. The census's 16.4 Mpx BPTC atlas is
  ~140 ms of decode plus ~33 ms of hash.
- **Basis on top:**
  - UASTC L2 runs at 2-9 Mpx/s on 12 threads, so the 16.4 Mpx atlas takes ~2-8 s.
  - ETC1S level 1 runs at 3-9 Mpx/s, plus one transcode back for D12(d)'s PSNR check (~10 ms).
  - With 2 low-priority workers, roughly 1/6 of the 12-thread rate, the census's 173 Mpx would
    take ~2-9 minutes of background encoding (UASTC) in a cold session.

  **That is the argument for the eager cache:** a warm cache costs only the key hash at the hook
  (~4 ms per 4 Mpx BC source) and a lookup. The lazy path stays correct and only delays the Basis
  variant, never the texture: `decoded`, and `block` where offered, publish at once.
- **G8kw moves the existing work off the RenderingServer caller** (the deferral gate8-design
  "Deferred" names):
  - The hook enqueues a copy-on-write duplicate.
  - The publisher holds back any snapshot naming a texture whose hash is not ready, and later
    frames coalesce into the next publish, exactly like a stall (no wire change at /6-/8; the
    stream stays frame-consistent).
  - Latency per texture is the worker time, ~30-100 ms per 2048².
  - At /9 the hook may publish `delivery-pending` instead, so the rest of the frame is not held.
- **Memory:** `decoded` bytes need not stay resident once a non-`rgba` mode is set. The host keeps
  the hash and regenerates the bytes on a GET (D8), which saves up to ~692 MB of host RAM on the
  census. Encoded variants stay in memory under `GRC_TEXTURE_CACHE_MAX_BYTES` and on disk.

### As built (G8kw)

Decisions taken where the design left room, each the long-term option:

- **Default `sync`, not D11's 2.** `GRC_TEXTURE_WORKERS=sync|1..16` defaults to `sync`, which is
  byte for byte the pre-G8kw capture (no worker code runs; recordings, hook logs and goldens are
  unchanged, results/gate8/g8kw.md "Byte identity"). At N the transaction set depends on worker
  timing: a file recording is a frame-for-frame subset of the synchronous one (proven per run by
  `worker-states-equal`) but no longer reproducible, so every frame-exact leg (seq-keyed shots,
  window-1 transcripts, goldens) would need `sync` pinned. The capture's other product policies
  (`GRC_STREAM_VERSION=8`, `GRC_TEXTURE_DECODE=engine`, `GRC_ADOPT=arm`) are opt-in the same way,
  and the product launch sets them: **D11's 2 is the product value**, set by couch-coop's
  streaming seat. Flipping the capture default needs every native gate rerun at N; it joins
  gate8-design's "switch the defaults to /8" cleanup after release.
- **Facts at the hook, content on the worker.** The hook keeps every fact-based decision of the
  synchronous copy (status, reason, format, shape, `payload_bytes`; for a host decode the D8 table's
  output format), so the mirror's and the hook log's registries, ids, versions and
  `update-shape-mismatch` decisions are made at the hook exactly as before. Only the payload bytes
  and the SHA-256 (and the decode) are a worker's. The worker re-derives the facts from its own
  copy; if they disagree with the prediction (only possible when an engine decoder fails on a table
  format) the stream ends with the typed `texture-worker-mispredict`, never a guess. A decoded
  payload the policy would refuse, an image smaller than `GRC_TEXTURE_WORKER_MIN_BYTES` (default
  64 KiB: a hand-off costs more than hashing it) and any call while the pool is not running stay
  synchronous.
- **Engine safety.** The hook takes `Resource.duplicate(false)` on the calling thread
  (`Image::_duplicate` shares the CowData; 1-2 µs, the `dup_ns` column) before the engine sees the
  call, so the engine may free or rewrite its Image at once (it then copies on write). The worker
  reads the duplicate through the const `image_ptr` (no copy-on-write), decodes a second duplicate
  of it (G8t's seam, unchanged), and drops the duplicate on its own thread before the job is
  visible as done. Workers never call the RenderingServer, never touch the mirror's or the log's
  state except through the job, and never write a sink.
- **Hold-back.** The mirror keeps a pending entry's job; a snapshot carries every `ok` image entry
  whose job is unfinished in `Captured::pending` (the entry complete but for its hash). The frame
  callback offers each snapshot to `HoldBack`, which publishes the **newest held snapshot whose jobs
  are all done** (older ones coalesced into it), else nothing; at most 64 are held (the oldest is
  dropped first: newer ones contain it). A file sink stamps the snapshot's own frame, so the async
  recording's transactions are the synchronous recording's at the same frames; the live hub gets it
  at the callback that publishes (stamped by the hub with that callback, as it always stamps),
  with the snapshot's own mutation epoch, and a held callback calls the hub with no snapshot, as a
  stall does. At stream end the pool drains first (before `resources_finish`, `Hub::finish` and
  the sinks' end records), then the newest held snapshot is published to the file sinks, so both
  modes end on the same state. A texture freed, replaced or updated while pending carries its job
  along or supersedes it; nothing the engine does to its own Image afterwards reaches the job.
- **Hook log.** A line that needs a pending hash, and every line logged after it, is held and
  released in order once the hash is there (`take_lines`), so the log's order and facts are the
  synchronous log's; the worker's line gains trailing `"worker":true,"hook_ns":…,"dup_ns":…`
  keys, where `copy_ns`/`hash_ns`/`decode_ns` are then the worker's. Store/inline lines move to
  the callback that published.
- **Pool.** Capture-owned `std::thread`s at nice +10, started before the mirror is enabled and
  stopped (drain, then join) at the start of `stream_finish`, and again at shutdown and
  deinitialize, so no job (each holds an engine Image) outlives the stream. A hook racing the stop
  is refused by the pool and copies synchronously.
- **Sabotage.** `publish-before-ready` is a capture fault knob, `GRC_TEXTURE_WORKER_FAULT`, not a
  `GRC_SABOTAGE` kind: a new kind is a wire change in three validators (render-stream-8.md,
  `render-stream-2.ts`, rs-core `meta.rs`), and the bug it models would not declare itself either.
  It publishes a pending entry at once with 64 zero hex digits and no payload; the publisher then
  refuses the hash it has no payload for and the recording diverges from the synchronous one.
- **Test knob.** `GRC_TEXTURE_WORKER_DELAY_MS` delays each job, so the gate leg holds publication
  back on any machine (the g8t `workers` legs use 8 ms, every copy on a worker).
- **Measured** (results/gate8/g8kw.md): the calling thread's share of a 2048² create falls from
  31-112 ms (decode + copy + hash) to 6-16 µs on every format; the work itself (34-94 ms) moves to
  a worker unchanged.
- **Budget.** `GRC_RESOURCE_BUDGET_BYTES` is checked on the snapshot that publishes; payloads held
  only by a held snapshot (a few frames' worth) are not counted until then.
- **Not covered here:** a live leg at N (the hub path is the stall path it reuses; G8r's and the
  product's live legs run it), G8r's pre-arm adoption through the same path, and per-variant
  encodes (G8ku).

## Q8. Bandwidth for STS2

The **census** is the 2026-10-10 leg's 1,437 creates:

- compressed set: 92.5 Mpx BPTC, 80.1 DXT5 and 0.4 DXT1, ~173 MB as BC and ~692 MB as RGBA8;
- uncompressed set: ~43 Mpx RGBA8/RGB8/L8/LA8, ~163 MB, already flowing as GRT1 today.

The **whole game** is every texture in the pack, an upper bound.

Per-family B/px:

- **Measured:** RGBA+zstd over all files, and BC+zstd over the pack.
- **Estimated:** UASTC and ETC1S scale the RGBA+zstd rate by the sample ratios in Q2.
- **Not applicable:** `block` for uncompressed sources, and on the g31.

Per-file coding runs a few percent above the pack's whole-stream BC figure.

| mode (HTTP coding) | census, compressed set | census, all, per client | census, 3 clients | whole game, per client | whole game, 3 clients |
| ------------------ | ---------------------- | ----------------------- | ----------------- | ---------------------- | --------------------- |
| `rgba` (today, G8t) | 692 MB | 855 MB | 2.57 GB | 6.98 GB | 20.9 GB |
| `rgba` + zstd (G8kz) | 53 MB | 76 MB | 227 MB | 781 MB | 2.34 GB |
| `passthrough` + zstd, desktop only | 29 MB | 51 MB | 154 MB | 649 MB | 1.95 GB |
| `basis-uastc` (zstd inside), est. | 33 MB | 46 MB | 138 MB | ~463 MB | ~1.39 GB |
| `basis-etc1s`, est. | 8 MB | 10 MB | 31 MB | ~93 MB | ~279 MB |

The game ships its textures as 1,223 MB of `.ctex`.

For scale:

- LAN: 227 MB at a 300 Mbit/s Wi-Fi link is ~6 s.
- Internet: ETC1S's 31 MB takes ~25 s at a 10 Mbit/s residential upload, against ~3 min for
  `rgba`+zstd.

The table also shows that UASTC+zstd is about BC+zstd on this content. On LAN the Basis win is GPU
memory and phone hashing (Q6), not bytes. All these rates come from STS2's sparse,
transparency-heavy art; denser art compresses less (the lossless family's 0.52 B/px against BPTC
art's 0.34).

## Increments

Each is one commit on `main`. The convention is `feat(render-stream): …` with `Changelog: none`;
a commit whose change reaches a published `packages/*` export needs a real `Changelog:` line.
Times are writing plus validation.

Every capture increment reaches `*` in `smoke-map.json`, which makes the full tier ~5.5 h. To
narrow later runs, G8kw adds narrow rules in the gate 8 seam pattern (the G8w rule: `capture-build`,
`pure`, `native:gate0@*`, `native:gate8@*`):

- new files `rs_texture_worker.*`, `rs_texture_delivery.*` and `rs_texture_cache.*`;
- the vendored `third_party/basis_universal/**`, plus `capture-build` and `cargo:*`.

Shared call sites still reach `*`.

| Id | Outcome | Files | Re-run scope | Model, time | Depends on |
| -- | ------- | ----- | ------------ | ----------- | ---------- |
| G8kz | HTTP `Content-Encoding` zstd/gzip for payload GETs at /2+ (D2, Q5): precompressed per hash on the HTTP thread, `Vary`, per-coding ETag, the native receiver's `Accept-Encoding` + decompress; checks: identity hash after decode, coded bytes logged per GET, `corrupt-coded-body` sabotage (receiver must refuse) | `capture/src/rs_live.*`, `rs_resource_store.*`, `receiver/` fetcher, `scripts/lib/gate2-*`/`gate8-*` checks, `render-stream-2.md` "HTTP" | `*` (capture) | sonnet, 3 h + full tier | G8w |
| G8kw | **Landed** (Q7 "As built (G8kw)"). Worker pool for copy/decode/hash (D11), publication hold-back at /6-/8, `GRC_TEXTURE_WORKERS=sync\|N`; checks: sync and async recordings resolve to equal states at every checkpoint, main-thread hook time ≤ 2 ms per create at 2048², `decode-cost` re-measured | `capture/src/rs_texture_worker.*` (new), `hooks.cpp` copy path, `rs_mirror.*`, `rs_resource_log.*`, `entry.cpp` (the hold-back lives in `rs_texture_worker.*`, not `rs_publish.*`), `smoke-map.json` narrow rule | `*`, then narrow | opus, 5 h + full tier | G8t; before G8r (which reuses the path) |
| G8k9 | **Landed** ("As built (G8k9)"). render-stream/9 codecs and validators (Q5): `variants`, `ktx2` and `block` payloads, `resources.delivery`, hello keys, `delivery-pending`, `golden-9/`; empty delivery seam; no receiver offers .9 yet | `protocol/render-stream-9.md`, `protocol/golden-9/`, `rs2_codec.*`, `rs2_diff.*`, `rs_live.*`, `render-stream-2.ts`, `rs-core/src/{wire,validate,meta,payload}.rs`, capi pin | `*` | sonnet, 4 h + full tier | G8w (parallel with G8kz/G8kw) |
| G8kp | **Landed** ("As built (G8kp)"). `passthrough` end to end (D1, D3): capture offers `block`, hello `gpu_formats`, the native receiver uploads block formats, GSW `compressedTexImage2D` for s3tc/bptc/rgtc; `gate8-tex` gains delivery legs (desktop GSW, GSW with BC masked → `decoded`, native); checks `block-exact` (payload = `.ctex` bytes), `delivery-select`, pixels = `reference-hw` exactly on the same GPU | `capture/src/rs_texture_delivery.*`, `receiver/`, `web/gsw-receiver/`, `packages/canvas/rust-prototype/…/gl.rs`, `fixtures/gate8-tex/`, `lib/gate8-delivery*.ts` | `*` + `g7:*@gsw` | opus, 5 h + full tier | G8k9 |
| G8ku | **Landed** ("As built (G8ku)"). `basis-uastc` (LAN): vendored basisu 1.60 + zstd 1.5.7 (D15), UASTC encode on workers, lazy variants (D6), D12 rules; native and web-export transcode via `Image.load_ktx_from_buffer`; checks `transcode-oracle`, `delivery-reference`, `quality-band`, `ktx2-wire`; sabotage `perturb-ktx2` (one byte after hashing: receivers must refuse) | `third_party/basis_universal/**`, `capture/` build, `rs_texture_delivery.*`, `receiver/`, `fixtures/gate8-tex/` | `*` | opus, 7 h + full tier | G8kp, G8kw |
| G8kb | **Landed** ("As built (G8kb)"). GSW Basis: transcoder wasm in a Web Worker (emsdk 4.0.11, D15 sources), ASTC/ETC2/BC7 upload, `upgrade` policy; g31 device bench of transcode time per Mpx, GPU memory (gfxinfo) and hd-patch p95 unchanged (real time, standing phone approval) | `web/gsw-receiver/`, `web/basis-transcoder/` (new), `packages/canvas/rust-prototype/…/gl.rs`, `scripts/gate7-bench.ts` arm | `g7:*@gsw`, `g7live:*@gsw`, `bench-instr`, device leg | opus, 6 h + scoped tier | G8ku |
| G8kc | **Landed** ("As built (G8kc)"; UASTC entries wait for G8ku). Persistent cache and the prepare step (D8, D9), and the `texture_set_path` hook with paths in the hook log (D10): `GRC_TEXTURE_CACHE_DIR`, index, verify-on-load, LRU budget; `scripts/prepare-textures.sh` over a project's `.ctex` or an image directory; checks `prepare-key-match` (every hooked texture of the fixture hits after prepare from its `.ctex`), `cache-warm` (second session: zero encodes, identical hashes), `cache-corrupt` sabotage | `capture/src/rs_texture_cache.*`, `scripts/prepare-textures.*`, `fixtures/gate8-tex/` | narrow rule + `native:gate8@*` | sonnet, 4 h + scoped tier | G8ku |
| G8ke | `basis-etc1s` (internet): ETC1S level 1/q128, D12(d)'s PSNR floor with UASTC fallback; a throttled-link leg through G6c's constrained proxy (bytes and time to first complete frame at 10 Mbit/s); g31 ETC1S → ETC2 cost | `rs_texture_delivery.*`, `lib/gate8-delivery*.ts`, proxy config | narrow + `native:gate8@*`, `g7:*@gsw`, device leg | sonnet, 4 h + scoped tier | G8kc, G8kb |

**Order and release.** The correctness blockers stay first: G8h → G8f → G8r → G8m, as
gate8-design orders them, because without them the game does not render at all.

- **G8kz is independent and the cheapest 11x.** It goes in parallel and lands before release.
- **G8kw lands before G8r,** whose lazy texture adoption reuses the worker path.
- **The LAN tier (G8k9 → G8kp → G8ku → G8kb → G8kc) follows G8m and precedes G8g.** G8g's browser
  legs and G8z's hand-off then cover delivery once. The user's direction is LAN first, and this
  tier is what gets the g31 under ~855 MB of textures.
- **G8ke (internet) comes after G8z,** post-release, unless fork K2 says otherwise.

So the release sequence is:

1. G8kz ∥ G8h;
2. G8kw;
3. G8f, G8r, G8m;
4. G8k9, G8kp, G8ku, G8kb, G8kc;
5. G8g, G8z;
6. then G8ke.

## What this does not prove

- Perceptual quality. PSNR floors and oracles are numbers, and a visual contact sheet on the game
  is the product leg's (gate8-design F1). The game legs themselves stay under F1.
- Internet conditions beyond a throttled loopback proxy (no loss, jitter or real NAT); relays,
  CDNs or one upload shared by several clients (each client still fetches its own copy).
- Encoder determinism across CPUs or thread counts. D8 stores bytes so that it never matters.
- Phone numbers other than the g31's, other GPUs (Adreno ATC, PVRTC: disabled in the build), HDR
  (BC6H, UASTC HDR, ASTC HDR: floats stay G8f's exact `decoded`).
- That the eager prepare covers textures generated at runtime (atlases, viewports, 165 of the
  census's RGBA8). They take the lazy path.
- Q8's Basis rows for the whole game. They scale nine samples' ratios; G8ku/G8ke re-measure on a
  larger set.
- WebP/AVIF (ruled out by the user), or a game shipping Basis-mode `.ctex` (D10's re-derivation;
  STS2 ships none).

## Deferred, with owners

- **Basis-mode `.ctex` reuse** (D10's file-derived UASTC): when a fixture or a game needs it; G8kc's
  path hook makes it a small addition.
- **Web-export compressed-format honesty: closed by G8kwh** ("As built (G8kwh)").
- **Web-export transcode in a JS worker** via `JavaScriptBridge`: if G8ku's g31 hitch matters.
- **R8/RG8/LA8 and glyph atlases in Basis** (BC4/BC5, ETC2_R11/RG11): no byte need in the census.
- **Arm-on-subscribe interplay** (gate8-design "Deferred"): a warm cache makes re-arming cheap.
- **Warming the cache from a pack** (user decision K3, 2026-10-23; owner: G8kc or a successor, after
  G8ku). A library feature of the generic prepare step (D9b) that warms the persisted cache (D8)
  from a game's pack in two modes: **all** (every texture in the pack) and **selective** (the
  integrator supplies the textures it expects to need soon). The prediction logic, the choice of
  what is "soon", stays in the product; the library only takes the list. **Each integrator picks one
  of three**: live (the lazy path, the default and what ships now), all-pack, or selective-pack.
  Reading an installed game's pack stays an explicit operator action; the cache never sits inside a
  repository, and nothing here writes to the game's install.

## Open forks for the user

Decided by the user on 2026-10-23, after this design was written: K1 (basisu 1.60), K2 (ETC1S does
not gate the release) and K3 (warm from live sessions now; the pack-warming library feature is
deferred, above). Their text is kept below as the record of the alternatives.

- **K1. DECIDED: vendored basisu 1.60 (the engine's copy).** The dependency is approved. The question is which revision.
  - **Default:** basisu **1.60**, BinomialLLC/basis_universal commit `323239a6`, the copy Godot
    4.5.1 vendors. It is copied from the local `../godot-4.5.1-stable/thirdparty/basis_universal`
    with Godot's five patches, plus zstd 1.5.7 from the same tree. **Nothing is downloaded**, and
    the host, GSW, native and web-export receivers all run the engine's own transcoder revision,
    which is what D16's oracle relies on.
  - **Alternative:** if you would rather track upstream, G8ku fetches the upstream source archive of
    a named later release tag, verified by its sha256. In that case the receivers' transcoder would
    differ from the engine's, and D14/D16 would need per-receiver oracles.
- **K2. DECIDED: ETC1S (the internet tier) does not gate the release.** Does the internet tier gate the public release?
  - **Default:** no. G8kz, G8kw and the LAN tier land before G8g/G8z. ETC1S (G8ke) comes after the
    release.
  - **Alternative:** move G8ke before G8g, about one more 4 h increment plus a scoped tier.
- **K3. DECIDED: warm from live sessions now; the pack is a deferred library feature ("Deferred, with owners").** Preparing from the installed game. The generic prepare step (D9b) can read any Godot
  project's or pack's `.ctex`. Pointing couch-coop's host at the user's own STS2 pack would read the
  Steam install at host startup; it would never write there and never copy into a repo, and the
  cache would sit outside every repository.
  - **Default:** no. The persisted cache warms from live sessions (lazy path), and reading the pack
    stays an explicit operator command that you approve once.

## As built (G8kz)

Landed as one commit; the spec is `render-stream-2.md` "HTTP (live)" > "Content coding (G8kz)".

**Decisions taken where the design was ambiguous or wrong.**

- **Default is `zstd`, not `off`.** The coding is negotiated per request, so a client that sends no
  `Accept-Encoding` (an old receiver, curl, a hand-written test) gets today's identity bytes and
  needs no version. Defaulting it off would leave the 11x unused by every deployment that does not
  know the variable. Every browser sends zstd already, so `off` is the only way to see the old
  bytes there. `GRC_HTTP_ENCODING=off` stays the opt-out (it ignores `Accept-Encoding` and sends no
  `Content-Encoding` or `Vary`); a native receiver opts out with `RS_RECEIVER_ACCEPT_ENCODING=off`.
- **Native zstd decode is `PackedByteArray.decompress(size, COMPRESSION_ZSTD)`, not
  `decompress_dynamic`.** Q5 named `decompress_dynamic`, but `Compression::decompress_dynamic`
  supports only gzip, deflate and brotli (`core/io/compression.cpp:229-295`; other modes hit
  `ERR_FAIL_COND_V`). The fetcher reads the size from the zstd frame header (the host's
  `ZSTD_compress` always writes it) and refuses a frame without one or above 1 GiB. gzip uses
  `decompress_dynamic`. Godot's `HTTPClient` decodes nothing, and `HTTPRequest` only gzip/deflate.
- **zstd and zlib are vendored** from `../godot-4.5.1-stable/thirdparty` (zstd 1.5.7 common,
  compress, decompress, no asm; zlib 1.3.1 minus `compress.c`/`uncompr.c`) into `capture/vendor/`,
  built as a hidden-visibility static library, so nothing is downloaded and the engine's own
  copies are never interposed. The system `libzstd`/`libz` were not used: the capture's contract is
  libc and libstdc++ only. D15's basisu copy will join them in `third_party/` as designed; these two
  are the capture's own and stay under `capture/vendor/`.
- **Compression runs on the HTTP I/O thread, not a worker.** D11's pool does not exist yet
  (G8kw). `ServedResources::lookup_coded` compresses outside its mutex on the I/O thread on the
  first GET of a hash per coding and keeps the body until the hash retires (a `wrong-hash`
  corruption drops it). It never runs on the RenderingServer caller. The cost is one blocking
  compression per hash on that thread: the gate 6 scene spent 4.4 ms (zstd) and 10.6 ms (gzip) in
  total for 35 bodies of 1.48 MB. A 16 MiB payload is about 30 ms at zstd 3, which delays other
  GETs on the same I/O thread while it runs; G8kw's pool is where that moves off it. `coded_ns` in
  `live-summary.json` records it.
- **Only GRT1 bodies over 72 bytes, and only if strictly smaller.** Mesh and shader payloads are
  small and already structured; D2 says GRT1 only. An incompressible texture is sent as identity.
- **Browsers: no `Access-Control-Expose-Headers`.** `Content-Encoding` and `ETag` are not
  CORS-safelisted, so a cross-origin page sees only `Content-Length` (the coded length); g7l's
  check that ETag is absent cross-origin therefore still holds. The coding adds no preflight
  because `Accept-Encoding` is a forbidden request header the browser sets itself. Receivers verify
  the hash on the decoded bytes the browser hands over, as for identity.

**Evidence.** Hook-log `http-get` 200 lines end with `coding` and `coded_bytes` when the host offers
a coding; `live-summary.json` `resources` gains `http_coded_bytes`, `http_encoding`, per-coding GET
counts and `coded_made/in/out/ns`; the native fetcher's fetch records gain `wire_bytes`,
`content_encoding` and `decode_us` (`bytes` stays the identity length).

**Checks** (gate 2 g2e; also run under g7-2 for GSW and the web export): `http-content-coding`
(the default host zstd-codes smaller bodies, gzip and off hosts, a native receiver that asks for
none gets identity, every fetch matches the host's account byte for byte and is verified after
decoding), `corrupt-coded-body` (the host flips a byte of every coded body: refused as
`resource-invalid`, `resource-hash-mismatch`, or for a browser `resource-unavailable`), and
`http-gets-match-fetches` now expects the per-coding ETag and the coded Content-Length.
Receiver-side decode: `receiver/tests/receiver_selftest.gd`.

**Measured bytes** (single client, distinct and repeated GETs as the leg made them):

| scene | identity | zstd 3 | gzip 6 |
| ----- | -------- | ------ | ------ |
| gate 6 `animate`, live, native receiver (128 GETs) | 1,525,360 B | 70,380 B (21.7x) | 73,498 B (20.8x) |
| `gate8-tex`, offline over the host's 14 stored payloads | 224,191 B | 118,273 B (1.9x) | 105,828 B (2.1x) |

The gate 6 scene is flat colour and gradients, so its ratio is the optimistic end of Q8's range;
`gate8-tex` is procedural noise-like content, the pessimistic end. STS2's measured 11x sits
between them.

## As built (G8k9)

Landed as one commit; the wire spec is [render-stream-9.md](render-stream-9.md), the evidence
summary [results/gate8/g8k9.md](../results/gate8/g8k9.md). Codecs and validators only: no receiver
offers `.9` and the delivery seam offers nothing.

**Decisions taken where the design was ambiguous or wrong.**

- **`resources.texture_delivery`, not `resources.delivery`.** D4 and Q5 named the session key
  `resources.delivery`, but `resources.delivery` has existed since /2 (`out-of-band`, `inline`,
  `mixed`), so a second key of that name would be a duplicate in one JSON object. The key is
  `texture_delivery`, `{"mode":…,"encoder":…}`, right after `decode`. D4 and Q5 above are corrected.
- **Hello:** `gpu_formats` of a receiver with no compressed format is `none` (the grammar forbids an
  empty string); both keys are required at /9.
- **`delivery-pending` is an `unsupported` image entry** (hash null, `payload_bytes` 0), the
  existing reason/status coupling; the recovery is an `ok` entry at a raised `version`.
- **Variant payloads in a recording.** The validators accept a variant's payload (a `block` GRT1 or
  a KTX2) as a resource record and check it against its entry (`resource-payload`, `ktx2-shape`),
  though no resource record is ever required for one. The host's inline policy stays "decoded only"
  (D12(c)).
- **`delivery-entry` also checks the session**: a variant's encoding must be one the declared mode
  offers (D1's table), and a Basis variant needs a declared encoder that its `params` start with.
  `GRC_TEXTURE_DELIVERY` is declared by a /9 session and ignored below /9 (so it is not a gate 8
  policy); `GRC_STREAM_VERSION=9` is the only way `render-stream.9` is offered.
- **KTX2 golden sources:** the Godot-editor route, not a hand-written generator. Godot 4.5.1's
  editor binary links basisu's encoder, and `PortableCompressedTexture2D` with
  `COMPRESSION_MODE_BASIS_UNIVERSAL` writes a real UASTC LDR 4x4 + Zstandard KTX2 from a synthetic
  image headlessly (`golden-9/gen_ktx2.gd`; the file is bytes 24.. of the texture's `_data`). The two
  outputs (16x16 with five levels, 4x4 with one) are committed and synthetic. This also gives the
  validators real DFD bytes (colour model 166, primaries 1, linear transfer) rather than ones a
  generator guessed.

**What landed.** `protocol/render-stream-9.md`; `protocol/golden-9/` (full, patch, inline, off,
resolved, 26 invalid and 14 control vectors, `make_golden.py`, `gen_ktx2.gd`); the C++ codec
(`ProtocolVersion::V9`, `TextureVariant`, `TextureReason::DeliveryPending`, the hello parser and
subprotocol offer) and `rs_texture_delivery.*`, the empty seam; the TypeScript decoder, validator
and independent KTX2 parser; the Rust core's decoder, validator and KTX2 parser; the capi version
list; a narrow `smoke-map.json` rule; gate 8's `delivery9/capture` leg.

**Out of scope here (owned by later increments).**

| Receiver or group | Owner | State after G8k9 |
| ----------------- | ----- | ---------------- |
| Native receiver (GDScript glue, `rs_core` GDExtension) | G8kp, G8ku | replays a `.rs9` recording as /8; its hello does not offer `.9` |
| GSW (`web/gsw-receiver`, `web/gsw-rs`) | G8kp, G8kb | unchanged; never offered `.9` |
| Web export | G8ku | unchanged |
| Block upload, `texture_encodings`/`gpu_formats` filled from hardware | G8kp | the hello keys are parsed and logged, not sent |
| The host cache, lazy variants, `delivery-pending` in a capture | G8ku, G8kc | the encoder is built (G8kv) but uncalled; the seam is empty; the capture never publishes the reason |
| `transcode-oracle`, `delivery-reference`, `quality-band`, `perturb-ktx2` | G8ku | not started |
| ETC1S, the PSNR floor, the throttled link | G8ke | after the release |
| Gate 7 browser groups, the g31 | none | unreachable: `GRC_STREAM_VERSION` is unset in every one |

## As built (G8kv)

Landed as one commit; the evidence summary is [results/gate8/g8kv.md](../results/gate8/g8kv.md). The
encoder exists in the build and nothing calls it.

- **Vendored tree.** `third_party/basis_universal/` is Godot 4.5.1's copy of basisu 1.60 (`323239a6`),
  `PROVENANCE.md` beside it with the upstream commit, Godot tag, the five Godot patches, one local patch
  and every file's sha256. zstd is not copied again: the library uses `capture/vendor/zstd` (G8kz).
- **One local patch (`0006-render-stream-no-exr`).** `basisu_enc.cpp` includes tinyexr, which Godot
  vendors as a separate tree. A `BASISU_NO_EXR` guard stubs the three EXR functions instead of
  vendoring tinyexr, because the capture never reads or writes EXR.
- **Dropped:** four unreachable transcoder tables (ATC, PVRTC2) and the OpenCL kernels header, each
  behind a define the build sets to 0, as Godot's own SCsub does. The HDR encoders stay (referenced by
  `basisu_comp.cpp`); the wrapper only requests UASTC LDR 4x4.
- **Build.** Static library `grc_basisu` (hidden visibility, `-w`, the SSE4.1 kernels file alone with
  `-msse4.1`), linked into `render_stream_capture`; the wrapper `src/rs_basis_encode.{h,cpp}` is the
  only TU that sees basisu headers, and the header includes none.
- **Wrapper contract.** `encode_uastc_ktx2(levels, n)`: level i must be `max(1, base >> i)` (the KTX2
  level rule), 1-32 levels, supplied explicitly (`m_mip_gen` off; basisu's `m_source_mipmap_images`),
  UASTC level 2, no RDO, zstd 6, `m_perceptual` off and no sRGB transfer (linear DFD, D13). It prints
  nothing and never throws. `params_id()` is `basisu-1.60/uastc-l2/zstd6/linear`.
- **Alpha is decided by the wrapper.** basisu's own alpha check looks at the first image, and with it
  off, an alpha texture silently loses alpha (the first run decoded every pixel opaque). The wrapper
  scans every level and sets `m_force_alpha` when any alpha is below 255.
- **Thread safety.** `basisu_encoder_init()` runs under `std::call_once`, on the first encode or an
  explicit `init()`. Every encode is single-threaded on its caller with its own compressor and
  `job_pool(1)`, so G8kw's pool is the only parallelism; six concurrent encodes are byte-identical to
  one thread's.
- **Tests.** `rs_basis_encode_test` (ctest `rs_basis_encode`): header, level index and DFD against the
  `ktx2` profile, refusals, thread safety. `scripts/test/g8kv-roundtrip.sh` (ctest `rs_basis_roundtrip`):
  the TS validator, then stock Godot's `Image.load_ktx_from_buffer` under `timeout` with a per-level PSNR.
- **Cost.** About 3.3-5.0 s per Mpx per thread (UASTC L2 + zstd 6), so eager preparation of a large pack
  is minutes on 12 threads; lazy encode of a big texture is seconds on a worker. G8ku decides which
  textures a worker may take at what budget.

## As built (G8kp)

Landed as one commit; evidence summary [results/gate8/g8kp.md](../results/gate8/g8kp.md), wire
notes in [render-stream-9.md](render-stream-9.md) "As built (G8kp)".

**Capture.** `GRC_TEXTURE_DELIVERY=rgba|passthrough` at /9; `basis-uastc` and `basis-etc1s` refuse
the stream with the typed reason `texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=… is not
implemented yet` (G8ku, G8ke) when the sink is /9, and stay ignored below /9 as G8k9 left them.
Under `passthrough` the hooks keep, beside an ok G8t host decode, the hooked image's own bytes as a
GRT1 payload in their block format (`rs_texture_delivery.h` `block_data_bytes` is Godot's size; a
source whose size disagrees gets no variant and is counted), hashed where the decode is: on the
calling thread, or on G8kw's worker beside the decode (`TextureJob::fill` carries it; the worker
path fills the entry's variants in `resolve_captured`). The bytes travel as `PayloadCopy`'s
`block_*` fields through the mirror; a snapshot's payload map holds them under their own hash, so
the file sink's store (`<hash>.grt`, `put_variant`) and the live HTTP routes serve them like any
payload, never as an inline record. `stream.gate8.delivery_stats` counts block payloads built,
their bytes and the block sources declined. `rgba` and every /6-/8 stream build nothing.

**D3 in the receivers.** One rule, written once in rs-core (`delivery.rs`, `DeliveryPrefs`) and
independently in the checker (`lib/gate8-delivery-checks.ts` `predictD3`): the first of the
receiver's `texture_encodings` that the entry lists, `block` only when its format's family
(`block_family`: s3tc, bptc, rgtc, etc2, astc) is in the stated `gpu_formats`, `decoded` always
last. The default preference is `decoded` alone, so an unconfigured core picks the base hash as
before; both receivers configure `block,decoded` (`RS_RECEIVER_TEXTURE_ENCODINGS` overrides).

- **Native receiver:** `gpu_formats` from `RenderingServer.has_os_feature` minus
  `RS_RECEIVER_GPU_FORMAT_MASK`, handed to the core (`rsc_set_delivery`, GDExtension
  `set_delivery`); the planner fetches and uploads the chosen hash and `make_image` gained the
  block formats, so a `block` variant reaches `RenderingServer.texture_2d_create` through
  `Image.create_from_data` exactly as a `.ctex` does. GRS9 files replay at /9; `RS_RECEIVER_PROTOCOL=9`
  (native only) offers `render-stream.9` with /7's transport and the /9 hello
  (`RsLiveClient.hello_v9`). `uploads[]` name the encoding from /9 only.
- **GSW:** `gpu_formats` from its own context's WebGL extensions (`gpu_families`: s3tc from
  `WEBGL_compressed_texture_s3tc`, bptc, rgtc, etc2, astc), minus the mask; the applier uploads a
  block variant's level 0 through a new `TextureOp::UploadCompressed` (`gsw-canvas-draw-list`
  `CompressedFormat`: DXT1/3/5, RGTC_R/RG, BPTC_RGBA, and the ETC2/EAC and ASTC LDR formats) and
  `compressedTexImage2D` in `canvas_items/gl.rs` with the GL internal format Godot's GLES3 driver
  uses. Level 0 only, as the RGBA8 path. Only the BC formats ran here: the desktop GPU exposes no
  ETC2/ASTC to WebGL, so those uploads are first exercised on the g31 (G8kb). The draw path asks D3 too (a texture is drawable when its chosen payload is held).
  The live client offers `render-stream.9` under `RS_RECEIVER_PROTOCOL=9` with the two keys
  (`web/gsw-receiver/hello.ts`, the families probed on a throwaway WebGL2 context before the
  module's own exists).
- **Web export:** stays on `decoded` (it reads neither variable, keeps the core's default and never
  offers /9). A /9 file replays there as /8 would.

**Measured on the development host (RTX 2060, 2026-10-24).** The native receiver on `block`
equals `reference-hw` (the fixture sampling the `.ctex` on the same GPU) at 0 px on both steps,
while `reference-hw` itself differs from the CPU-decoded reference by 23,827 px (max delta 5) on
the desktop step. GSW on `block`: on the 209,605 pixels where GSW's decoded draw equals the native
decoded reference, 203,702 equal `reference-hw` exactly and 5,903 differ by exactly 1, none by
more. Hardware BC decode gives texels between 8-bit steps, and ANGLE-Vulkan's path and Godot's
GLES3 path round them into the RGB10A2 target at different points; the native claim is exact,
GSW's is "exact or one rounding apart" on the pixels GSW already decides.

**Deviations.**

- `delivery-pixels-gsw` is delta 1, not exact (above). `delivery-pixels-native` is exact.
- The GSW live hello is implemented and self-tested (`self-test-gate8kp.ts`), not run live: gate 8's
  live leg is native. The browser live legs for gate 8 belong to G8g.
- The `uastc`/`etc1s` encodings are parsed in a hello and skipped by D3 (no transcoder in any
  receiver yet), so a receiver listing them falls through to `block` or `decoded`.

**Out of scope here.**

| Receiver or group | Owner | State after G8kp |
| ----------------- | ----- | ---------------- |
| Web export | G8ku | `decoded` only, no /9 hello |
| GSW live /9 run, gate 8 browser groups | G8g | hello built and self-tested; file legs only |
| The g31 (ETC2/ASTC block upload in GSW) | G8kb | wired (`etc2,astc` stated, `block` picked), never run on the device |
| Basis encoders, `uastc`/`etc1s` variants | G8ku, G8ke | typed refusal at /9 |
| Gate 7 groups | none | unchanged: `GRC_STREAM_VERSION` is unset in every one, so no variant exists |


## As built (G8kc)

Landed as one commit; the evidence summary is [results/gate8/g8kc.md](../results/gate8/g8kc.md).
The cache is encoding-agnostic and filled by the one derivation that exists today, the host decode;
**UASTC is not wired** (G8ku had not landed), see "UASTC hookup" below; G8ku wired it ("As built
(G8ku)", "Persisted cache").

**The cache** (`capture/src/rs_texture_cache.*`, pure C++17, ctest `rs_texture_cache`).
`GRC_TEXTURE_CACHE_DIR` opens it at stream start (a directory that cannot be used refuses the
stream, typed), `GRC_TEXTURE_CACHE_MAX_BYTES` bounds the files (0 or unset: unbounded). A key is
(source key, encoding, `params_id`), the source key being D7's: the SHA-256 of the hooked image as
a GRT1 payload in its own format, built once per decode-eligible texture on whichever thread
copies it (the caller or a G8kw worker; under `passthrough` the same payload is the `block`
variant, hashed once). Layout as D8: `sha256/<hash>.grt|.ktx2` plus `index-v1.jsonl`, an
append-only log of rows `{v,source,encoding,params,hash,bytes,ext,use}` and `del` rows, last row
wins, rewritten to one row per entry when it has grown past twice the entries. A `get` reads the
file outside the lock and serves it only if its size and SHA-256 match the row, otherwise the
file and every row naming it are deleted and the caller derives again (`corrupt`); a missing file
is a `miss`. Writes go through a temp file and `rename`. The byte budget evicts the file whose
newest row is oldest (a hit counts as use, and recency survives a reopen), counting a file shared
by several keys once, and never the entry just stored (a single entry larger than the budget
stays). Memory is the in-process index; the payload bytes live in the existing store, so no
second in-memory copy of a texture exists. Hashes are what make D6's variants stable across
sessions, which is the point of the persisted form.

**Where the capture uses it.** `derive_decoded` in `hooks.cpp` replaces the bare
`texture_decode` + `copy_decoded` pair at both call sites (the calling thread and the worker,
which the adopt path shares): with the cache open it builds the source payload, looks up
(source key, `decoded`, `engine-decompress/4.5.1`), and on a hit returns the stored GRT1 as the
decoded payload without calling `Image::decompress`; on a miss it decodes as before and stores the
payload. The decoded bytes are stored, not regenerated (D8 allows regeneration; storing was
simpler and keeps hits independent of the engine's decoder). A payload that needs no derivation
(an RGBA8 `.ctex`, a PNG) is its own source: its hash is its key (`outcome: source`) and nothing is
stored, so the cache stays empty of data that the source already is. The cache is bypassed while
`perturb-decode` is configured, so a warm cache cannot hide that sabotage. With the cache closed
the path is exactly the old one.

**`texture_set_path` (D10).** One new hook, slot 42 (`calibrate.sh` derived it by name), installed
**only when `GRC_TEXTURE_CACHE_DIR` is set**: without it the hook is neither planned nor omitted,
so `hooks_planned` (79), `counts` and every session record stay what they were. The calibrator
version stays 9 for the same reason (it is echoed in every session record; the slot is an optional
conditional addition, and a record that predates it still loads, the hook then omitted and
reported). The hook keeps the last path per texture and reports it in two places: every call in
`counters.json` `captured.texture_set_path` and, per texture, in the new
`evidence/texture-cache.json` (id, path, D7 source key, outcome `hit|miss|corrupt|source`, status,
payload hash). `result.json` gains a `texture_cache` block (hits, misses, corrupt, puts, evicted,
bytes, entries, files, `derivations` = engine decodes the session ran, `encodes` = 0 until G8ku).
Both are written only when a cache directory is set.

**The prepare step.** `scripts/prepare-textures.sh --cache DIR (--project DIR | --images DIR |
--list FILE)` runs the pinned release template headless on a scratch project with the capture
armed and `prepare_textures.gd` loading each file as a game would (a `.ctex` through
`ResourceLoader`, an image through `Image.load_from_file`), one per frame, to a throwaway /8
sink. So a source key is computed by the very code the hooks run, not by a second implementation
that could drift, and the cache fills through the live path. This is a deviation from D9b's
wording ("a headless stock-4.5.1 script plus the capture's encoder"): the encoder is the
capture, and the script is the loader. `--list` is the explicit-texture-list form that K3's
all-pack and selective-pack warming will feed (not built). It refuses a cache directory inside a
git repository. A file this build cannot load (an EXR: the release template has no EXR module) is
counted as failed and skipped. D9a (startup prepare of already-held textures) needed no new code:
a pre-arm texture is adopted through the same copy (G8r), so its decode goes through the cache;
`cache-adopt` shows the second session adopting `chip_bc` from the cache.

**Checks** (gate 8 group `g8kc`, `lib/gate8-cache-checks.ts`, `test/self-test-gate8kc.ts`):
`cache-off-identical`, `cache-paths`, `cache-cold`, `cache-warm`, `prepare-key-match`,
`cache-corrupt` (sabotage), `cache-lru`, `cache-adopt`. The oracle's independently built block
payload hash is the expected source key, and its decoded payload hash the expected value, so the
cache is judged against the fixture's GDScript oracle rather than against itself.

**Deviations and notes.**

- **Byte identity.** With no cache directory a /9 recording differs from main's only in its `end`
  record's timing stats (checked against a build of main); `hooks_planned`, `counts`, the session
  and every payload are equal, and `cache-off-identical` pins this across runs.
- **Reach.** `hooks.cpp`, `entry.cpp` and the calibration record are shared capture files, so the
  plan still reaches every gate; the narrow `smoke-map.json` rule covers only the new files
  (`rs_texture_cache.*`, its ctest, the prepare script), as the G8kw and G8k9 rules do.
- **Params id of the decode** is `engine-decompress/4.5.1`; a different engine must change it, or
  the cache would serve another decoder's bytes.
- **Memory-only cache** (D8's "memory always") is not a separate layer: the index is in memory and
  the store and mirror already deduplicate by hash within a session.
- **A cache hit still builds the source payload** to learn the key (a copy and a hash at 1 B/px for
  block sources, D7); only the decode is saved.

**UASTC hookup (for G8ku).** The cache needs no change: G8ku's worker, after producing a KTX2,
calls `texture_cache().put({source_key, "uastc", rs::basis_params_id()}, sha256(ktx2), bytes,
"ktx2")` and, before encoding, `get` with the same key. The source key is already on the
`PayloadCopy` (`source_key`, filled for every ok texture while the cache is open, copied by
`TextureJob::fill`), and `result.json`'s `texture_cache.encodes` is the counter to increment per
encode so that `cache-warm` can assert zero encodes in a second session (it already does). The
prepare script then needs only the mode env (`GRC_TEXTURE_DELIVERY=basis-uastc`) added to its
launch to warm UASTC entries.
## As built (G8ku)

Landed as one commit; evidence summary [results/gate8/g8ku.md](../results/gate8/g8ku.md). `basis-uastc`
works end to end at /9 on the host, the native receiver and the web export; GSW stays G8kb's.

**UASTC level: 1** (`basisu-1.60/uastc-l1/zstd6/linear`, `GRC_TEXTURE_UASTC_LEVEL=0..4` overrides it per
session, and `params_id` names the level). Measured single-threaded on this host (Ryzen 5 5500,
`capture/build/rs_basis_level_bench`, one level, PSNR over RGBA through basisu's own transcoder to
RGBA8), on six recovered STS2 PNGs read in place and the fixture's five textures:

| image | size | L0 ms/Mpx | L1 ms/Mpx | L2 ms/Mpx | L0 dB | L1 dB | L2 dB |
| ----- | ---- | --------- | --------- | --------- | ----- | ----- | ----- |
| card portrait (RGB) | 1000x760 | 181 | 707 | 2502 | 47.2 | 50.2 | 50.5 |
| hand sprite (alpha) | 422x1200 | 209 | 562 | 1575 | 50.3 | 50.8 | 51.6 |
| vfx noise | 500x500 | 226 | 1047 | 3853 | 56.2 | 57.4 | 60.6 |
| event art (mostly flat) | 3440x1616 | 46 | 93 | 292 | 58.4 | 61.8 | 62.2 |
| epoch portrait (RGB) | 810x500 | 235 | 970 | 3648 | 40.8 | 43.4 | 43.5 |
| relic icon (alpha) | 256x256 | 233 | 820 | 2795 | 49.4 | 49.9 | 51.2 |
| card atlas (alpha) | 4032x4032 | 242 | 1008 | not run | 37.2 | 42.8 | — |
| fixture, five textures | 16-20 kpx | 237-332 | 1198-1461 | 4260-5794 | 44.2-53.5 | 44.8-54.0 | 44.9-54.6 |

L1 is within 0.1-0.4 dB of L2 on the art (1.3 dB on the relic icon, 3.2 on the noise) at 2.8-4.1x
L2's speed; L0 is another 3-5x faster but loses 0.4-5.5 dB (5.5 on the atlas, 3.0 on the portrait).
At ~1 s/Mpx per thread the census's 173 Mpx is ~1.5 min of background encoding on two workers
(L2: ~4-5 min). The bytes barely move with the level (L1 +2-6% over L0, L2 +1-3% over L1).

**Decisions taken where the design left room.**

- **Its own encode pool, not G8kw's.** `GRC_TEXTURE_ENCODE_WORKERS=1..16` (default 2, nice +10,
  `rs_texture_basis.*`), started for a /9 basis-uastc stream only. D11 named one pool, but G8kw's
  FIFO holds publication back on its decode/hash jobs: a 16 Mpx atlas at L1 is ~16 s on one thread,
  and every texture created behind it would wait for it. The encode never touches the engine, the
  mirror or a sink: it reads the mirror's immutable decoded GRT1 bytes.
- **Lazy, at the frame boundary.** Each frame callback (before the epoch is read) starts an encode
  for every settled ok image D12 admits that has no outcome for its content yet, and attaches the
  finished ones whose `version` and decoded hash are still the entry's: one more variant at an
  equal version (D6), the epoch advances, the next transaction carries the patch entry. A content
  change (update, replace, free) drops the texture's Basis state; an encode that finishes for old
  content is discarded and counted (`uastc_stale`). Start order is texture-table order; the
  receiver-driven priority of Q4 is not built (one more knob than the fixture can exercise).
- **D12 as built.** (a) `updated`: any texture `texture_2d_update`d since arm (an encode running
  when it happens is dropped). The capture cannot tell a glyph atlas page from an image at the
  RenderingServer; the atlases that grow are updated, and the grayscale ones are LA8 (b), so an
  RGBA8 atlas page never updated would get a variant. (b) the decoded payload is RGBA8 or RGB8 (a
  block source counts by its G8t decode). (c) `GRC_TEXTURE_BASIS_MIN_PX`, default 16384. Declines
  are counted per reason (`uastc_declined_{updated,format,small}`).
- **`delivery-pending` is not published** (G8kf publishes it, opt-in: "As built (G8kf)"). Q5
  reserves it for the async path's *decoded* hash, which G8kw's hold-back already keeps
  frame-consistent at /9; a variant still encoding is listed by omission (Q3 "Not ready yet"),
  which is what the capture does.
- **A deterministic test knob.** `GRC_TEXTURE_ENCODE_WAIT_FRAME=<f>`: finished encodes attach only at
  frame f, whose publish first waits (on the main thread, which never encodes) for every encode
  queued so far, so the recordings of the gate legs are exact. Off by default; the live leg runs
  without it.
- **`perturb-ktx2` is a fault knob** (`GRC_TEXTURE_ENCODE_FAULT=perturb-ktx2`: the last byte of each
  KTX2 flipped after hashing), not a `GRC_SABOTAGE` kind, for G8kw's reason (a new kind is a wire
  change in three validators). The receivers refuse it with `resource-hash-mismatch`.
- **Stream end drops queued encodes** (`discard_queued`) and waits only for the ones in flight; their
  results are never published.
- **Persisted cache (G8kc).** An encode job whose entry has a D7 source key (the cache is open)
  first asks G8kc's cache for (source key, `uastc`, `params_id`): a hit serves the verified KTX2 with
  no encode; a miss or a corrupt file encodes and stores the result (`<hash>.ktx2`, the correct
  bytes even under `perturb-ktx2`, which flips only what is published). `result.json`
  `texture_cache.encodes` is the number of encodes the session ran, attached or not (an encode of
  content that changed before it finished still runs and is stored, never published), and
  `delivery_stats.cache_hits` the attached variants the cache served. Gate 8's g8kc group runs the
  Basis fixture twice on one directory (`uastc-cold`, `uastc-warm`): `cache-cold` checks one row per
  encode and a row for every published variant, `cache-warm` that the second session runs zero
  encodes and publishes the first session's uastc hashes.
- **Store and HTTP.** A uastc variant is `<hash>.ktx2` in the store (index `type: texture-ktx2`,
  `encoding`, `params`, the entry's shape), and the live route serves any KTX2 body as
  `Content-Type: image/ktx2`; content coding stays GRT1-only (G8kz), so a KTX2 is never coded.
- **D6 in the Rust core.** `DeliveryPrefs.upgrade` (`keep` by default): a resident payload of the
  entry's current version (its base hash or any listed variant) is kept; `upgrade` re-uploads when
  D3 now prefers another. `rsc_set_variant_upgrade`, and the receivers' `RS_RECEIVER_VARIANT_POLICY=
  keep|upgrade`. `set_delivery` keeps the policy (it is not part of the hello).
- **Native receiver.** D3 picks `uastc` when the receiver lists it (default `block,uastc,decoded`:
  every 4.5.1 template links the KTX2 loader). The capi plans a KTX2 upload as a texture op whose
  format code is `KTX2_FORMAT` (1000) after `decode_ktx2` and `check_ktx2_shape` against the entry
  (the shape check only, Q6); the needed list names the hashes (`ktx2_hashes`, `.ktx2` in the
  cache). The executor in `receiver/ext/rs_core_ext.cpp` (the glue that runs the core's texture
  ops, C++ rather than GDScript) calls `Image.load_ktx_from_buffer`, then `texture_2d_create`, and
  logs each transcode (format, size, mips, data size, time; with `RS_RECEIVER_TRANSCODE_LOG=1`
  the uploaded blocks' SHA-256) into `applied.json` `transcodes[]`. A transcode failure was the
  typed `delivery-transcode-failed` and ended the replay; G8kf builds the refetch of `decoded` Q3
  names ("As built (G8kf)").
- **Web export.** It now reads the delivery variables, fills `gpu_formats` from its WebGL context
  through the same `has_os_feature`, and may speak /9 (`RS_RECEIVER_PROTOCOL=9`). It transcodes
  through the same engine call in wasm, on the main thread.

**Measured (RTX 2060, 2026-10-24).** On this GPU D14 picks BC7 (`bptc`) for every UASTC file, native
and web alike, and the web export's blocks equal the native oracle's bit for bit. Transcode cost
(UASTC + zstd to BC7 through `Image.load_ktx_from_buffer`, the fixture's 0.52 Mpx texture): native
5.2 ms (~10 ms/Mpx), web export 20.1 ms (~38 ms/Mpx, ~3.8x; the web timer has 0.1 ms resolution and
the first transcode of a page adds ~5 ms of table setup). basisu's own transcoder in native code
measures 6.5-10.5 ms/Mpx to BC7 and 3.2-5.9 ms/Mpx to ASTC 4x4 on the STS2 images. The fixture's
uastc payloads are 6x smaller than its decoded RGBA8 ones (0.52 Mpx: 347 KB against 2.1 MB), and
PSNR through the oracle's BC7 decode is 44-53 dB (floor 30). Pixels: the receiver drawing the
transcoded blocks equals the fixture drawing the oracle's blocks on the same GPU exactly (0 px), and
here also the fixture drawing the oracle's CPU decode (`hw-band` 0 px: this GPU's BC7 decode is
bcdec's). `delivery-reference` gates on the GPU-sampled oracle and records the CPU band, because a
GPU whose hardware decode rounds differently (G8kp's BC1/BC3 band, or another target such as
llvmpipe's ASTC) would differ there without being wrong.

**Out of scope here.**

| Item | Owner | State after G8ku |
| ---- | ----- | ---------------- |
| GSW transcoder (wasm in a Web Worker), its ASTC/ETC2/BC7 upload, `upgrade` on the phone | G8kb | GSW never lists `uastc`; D3 falls through to `block`/`decoded` |
| The g31 (ETC2/ASTC targets, transcode cost, GPU memory) | G8kb | not run |
| The prepare step warming UASTC entries (`prepare-textures.sh` ran a /8 sink and dropped queued encodes at its end) | G8kf | **landed** (G8kf): a /9 basis-uastc sink and an end-of-stream drain |
| ETC1S, D12(d)'s PSNR floor, the throttled link | G8ke | `basis-etc1s` still refused at /9 |
| Receiver-driven encode priority (Q4), freeing `decoded` bytes on the host (Q7 "Memory") | later | FIFO in table order; `decoded` stays resident |
| `delivery-transcode-failed` fallback to `decoded` | G8kf (native receiver, web export), G8kb (GSW) | **landed** on the native receiver and the web export (G8kf); GSW's is G8kb's |
| Publishing `delivery-pending` | G8kf | **landed**, opt-in (`GRC_TEXTURE_PENDING=publish`) |


## As built (G8kb)

Landed as one commit; evidence summary [results/gate8/g8kb.md](../results/gate8/g8kb.md). GSW (the
browser canvas receiver) now takes `uastc` at /9, file and live.

**Transcoder.** `web/basis-transcoder/transcoder.cpp` wraps basisu 1.60's `ktx2_transcoder` from the
vendored `third_party/basis_universal/` (D15) with zstd 1.5.7's decompressor (`capture/vendor/zstd`).
`scripts/build-basis-transcoder.sh` compiles it with the pinned emscripten 4.0.11 (the web export's
emsdk, nothing downloaded) into ONE standalone wasm (568 KB, no JS glue; its few WASI/env imports are
stubbed) under `artifacts/render-stream/basis-transcoder/<input digest>/`, reused while its inputs are
unchanged. Defines: Godot's (KTX2 + Zstandard, no ATC/FXT1/PVRTC), plus `BASISD_SUPPORT_UASTC_HDR=0`
and `BASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=1` (basisu defaults the latter to 0 under emscripten
and 1 natively; neither changes a UASTC LDR transcode, both are pinned). One call transcodes every
level, decode flags 0, as libktx's `ktxTexture2_TranscodeBasis` does for Godot.

**D14 in GSW.** The transcoder applies Godot's KTX2 loader rule itself (4 components: ASTC 4x4, BC7,
BC3, ETC2 RGBA, RGBA8; 3: BC7, BC1, ETC1, RGBA8; 2/1: BC5/BC4 or RGBA8; sRGB: RGBA8), the component
count read as libktx reads it (the DFD's first channel id). One WebGL rule is added in front of it
(`client.ts` `webglFamilies`): **WebGL refuses a BC (S3TC, BPTC, RGTC) level 0 whose width or height
is not a multiple of 4** (`INVALID_OPERATION`, measured in the pinned Chromium; desktop GL accepts
it), so for such a KTX2 the BC families drop out and D14 takes the next target, on the desktop
RGBA8. ETC2 and ASTC have no such rule (a 150x110 ASTC upload succeeds on the g31). Godot names an
ASTC 4x4 UNORM transcode `FORMAT_ASTC_4x4_HDR` (`texture_loader_ktx.cpp:437`, the same GL internal
format); GSW names it `ASTC_4x4`.

**Worker and the arrival path.** `web/basis-transcoder/worker.ts` runs the wasm in a Web Worker
(`client.ts` `BasisTranscoder`, one per page; the KTX2 is transferred in, every transcoded level
out). `web/gsw-receiver/transcode.ts` (`KtxStager`) is the arrival path both modes share, in the
payload's fetch completion (G7o2's pattern: the step transaction never transcodes):

1. rs-core verifies the KTX2 (`stage_ktx2`: SHA-256 against the hash it was fetched for, then
   `decode_ktx2` and `check_ktx2_shape` against the entry listing it), so a perturbed KTX2 is
   refused (`resource-hash-mismatch`) and never transcoded;
2. the worker transcodes it to D14's target for the context's *stated* gpu_formats;
3. `stage_transcoded` stages level 0 (`payloads::texture_transcoded`; a block format or RGBA8) under
   the KTX2's hash, and `provide_staged` moves it to the store when its transaction runs; only a
   hash `stage_ktx2` verified may be staged.

The applier uploads it through G8kp's `TextureOp::UploadCompressed` (`compressedTexImage2D`, level
0, the GL format Godot's GLES3 driver uses), or `Upload` for RGBA8; `gl.rs` needed no change. File
mode fetches `<hash>.ktx2` (needed kind 3); live mode GETs it like any payload, and the fetcher hands
the result back once its transcode settled while the next GET goes out. `applied.json` gains
`transcodes[]` (the native receiver's fields: hash, ok, `format` as Godot's Image.Format value,
size, mipmaps, data and KTX2 bytes, `transcode_us`, and with `RS_RECEIVER_TRANSCODE_LOG=1` the
blocks' SHA-256; plus `format_name`, `levels`, `components` and the main thread's `round_trip_us`)
and `delivery_fallbacks[]`.

**Hello and D6.** With the worker in its bundle GSW's default `texture_encodings` is
`block,uastc,decoded` (the hello and the core alike; `RS_RECEIVER_TEXTURE_ENCODINGS` overrides).
`RS_RECEIVER_VARIANT_POLICY=keep|upgrade` sets D6's policy; unset, GSW **upgrades on a context with
neither `bptc` nor `s3tc`** (the phone class, where `decoded` costs 4 B/px and the transcode 1 B/px or
less) and keeps otherwise. rs-core's applier, which GSW runs, implements `keep` as the native planner
does: a resident payload of the entry's current version stays (not refetched, and drawn from: the
applier's `kept` map), `upgrade` re-uploads. `texture_delivery` in `applied.json` reports
`variant_policy` and whether the default chose it.

**`delivery-transcode-failed` falls back to `decoded`** (Q3). A transcode that fails (basisu
refuses the file, the worker cannot start, or the test fault `RS_RECEIVER_TRANSCODE_FAULT=fail`)
is a `delivery_fallbacks[]` row; `transcode_failed` refuses the variant for the session
(`DeliveryPrefs::refuse`, rs-core: D3 skips refused variant hashes) and recomputes the needed set,
and the shell fetches what it now lists: the entry's `decoded` payload, unless it is already
resident. A hash refusal stays a refusal. **Not built:** the same fallback in the native receiver
and the web export (`rs_core_ext.cpp`'s transcode failure still ends the replay;
`DeliveryPrefs::refuse` is the core half they need), and a fallback on a failed *upload* (GSW does
not read `getError` after `compressedTexImage2D`; D14 plus the WebGL rule above choose only
formats the context takes).

**Gate legs.** g7-8's gate 8 source now runs g8kp and g8ku (`G8_FILE_LEGS`). The web half does not
replay their legs (`lib/gate7b-adapters.ts` excludes them as `gsw-only-group`, reported by
`legs-not-replayed@web`): replayed, the web export fails both, a defect for G8kf (its g8kp block
uploads log `WebGL: INVALID_ENUM: compressedTexImage2D: invalid format` and draw 77,878 px wrong;
its g8ku upgrade leg draws the 150x110 BC7 texture wrong, 16,500 px). The GSW half replays g8kp's three receiver legs (judged by
`delivery-select` and `delivery-pixels-native` through the band) and g8ku's perturbed-KTX2
sabotage (`sabotage-perturb-ktx2`), and runs four GSW-only g8ku legs judged by
`lib/gate7-gsw-g8-checks.ts`: `gsw-transcode-oracle`, `gsw-delivery-policy`, `gsw-delivery-pixels`,
`gsw-transcode-rgba`, `gsw-transcode-fallback`. g8l gains `basis` (gate8-basis at /9 basis-uastc,
no wait knob; receiver and replay at `RS_RECEIVER_PROTOCOL=9` with `upgrade`; tap and sink `.rs9`;
the replay also shoots the sink's last transaction) with `g8l-basis-delivery`, so the native
receiver's and GSW's live /9 hellos run, GSW's for the first time. The web export's basis leg is not
run (`g8l/basis/not-applicable.txt`): live it draws its non-4-aligned BC7 texture wrong while its
replay draws it right (WebGL refuses such a BC level 0, and the web export applies no alignment
rule), a web-export defect for G8kf.

**Bench.** `gate7-bench.ts --arm gsw-basis --basis-store <store>` (`web/bench/basis.html`): GSW's own
worker on every KTX2 of a store per D14 target set (warmup + repeats), then per delivery (`decoded`:
the RGBA8 a decoded payload uploads; `uastc`: the context's own transcode) K copies of each texture
uploaded through GSW's calls, the phone's memory sampled on the same page before and after.

**Measured.** Desktop: GSW's BC7 transcodes equal the native oracle's bit for bit (every level), and
its pixels equal the native receiver's within channel 1 outside the declared regions. The g31 (ETC2
and ASTC only): ASTC 4x4 57-77 ms/Mpx in the worker (ETC1 ~120 on small textures, ETC2 RGBA8 ~82,
RGBA8 57); 64 copies of the fixture's textures cost +157-163 MB of system `Lost RAM` as decoded RGBA8
(149.6 MiB uploaded) and +17-22 MB as their ASTC/ETC1 transcodes (36.4 MiB). Details, the hd-patch
A/B and the runs: [results/gate8/g8kb.md](../results/gate8/g8kb.md).

**Out of scope here.**

| Item | Owner | State after G8kb |
| ---- | ----- | ---------------- |
| `delivery-transcode-failed` fallback in the native receiver and the web export | G8kf | a typed replay failure; `DeliveryPrefs::refuse` in rs-core is the core half |
| The web export's block-variant uploads (`INVALID_ENUM` on g8kp) and non-4-aligned BC uploads (g8ku, its g8l basis leg) | G8kf | its g8kp/g8ku legs are not replayed in g7-8's web half, its g8l basis leg not run |
| ETC1S and its g31 cost | G8ke | refused at /9 |
| GSW mip levels beyond 0; reading GL errors after a compressed upload | later | level 0; no read-back |

### G8kb2 note: ASTC for RGB in GSW

Landed after G8kb; evidence [results/gate8/g8kb2.md](../results/gate8/g8kb2.md). D14's 3-component
order in GSW (`transcoder.cpp` `target`) is now BC7, **ASTC 4x4**, BC1, ETC1, RGBA8: when the context
states `astc` and no `bptc`, an RGB texture takes ASTC 4x4 instead of ETC1. UASTC -> ASTC 4x4 is a
lossless repack (1 B/px; the native decode equals the UASTC decode), where ETC1 (0.5 B/px) measured
18.8 dB on per-pixel noise and 34.8 dB on a gradient on the g31 and ASTC 59.0 and 58.3 dB against the
UASTC decode. The native receiver and the web export keep Godot's rule, so block identity across
receivers holds on a desktop (BC7 everywhere) but not on an ASTC phone, which was already true for
RGBA. The g31 transcode is not slower (ASTC 66 vs ETC1 80 ms/Mpx on the RGB files); the cost is
1 B/px instead of 0.5. Checks: `scripts/test/self-test-gate8kb.ts` (the selection table),
`scripts/test/g8kb2-astc-rgb.ts` (the wasm's ASTC equals native basisu 1.60's, byte for byte), and the
bench's new `quality` mode (the context's own GL decode, PSNR against the UASTC decode and the source).

## As built (G8kf)

Landed as one commit; evidence summary [results/gate8/g8kf.md](../results/gate8/g8kf.md). Four
follow-ups to G8ku, no wire change.

- **The prepare step warms UASTC entries.** `scripts/prepare-textures.sh` now runs a /9
  `basis-uastc` sink by default (`--no-uastc` keeps the /8 one; `--encode-workers N`,
  `--uastc-level N`) with `GRC_TEXTURE_ENCODE_DRAIN=1`: at stream end the capture starts what the
  last callback did not, waits for every queued encode (each stores its result in the persisted
  cache) and only then stops the pool, instead of discarding the queue. The submit blocks while
  more than two jobs per worker are outstanding, so a long pack holds a few decoded payloads beside
  the mirror, not all of them. A session on that directory at the same UASTC level runs zero
  encodes. The list form takes an Image saved as `.res` (any format and mip chain, kept by
  `ResourceSaver`), which is how the gate feeds the basis fixture's procedural images without
  PNG's loss of the DXT1 source and the mip chain (`RS_FIXTURE_DUMP_RES_DIR` in
  `fixtures/gate8-basis`). Check `prepare-uastc-warm` (g8kc): the prepare run's encodes equal the
  cold live session's (7, the `updated` texture's first content included), and the next session
  has 0 encodes, 0 misses, 0 puts and the cold session's six uastc hashes, all from the cache.
- **`delivery-pending` is published, opt-in.** `GRC_TEXTURE_PENDING=publish` with
  `GRC_TEXTURE_WORKERS=<N>` at /9 (default `hold`: G8kw's hold-back, the product value until a
  streaming seat sets it; D11's workers are the product value too). Q5 defines the reason for the
  async path's missing hook-time *decoded* hash, so that is what is published: a first-time
  texture whose worker has not delivered, as an `unsupported` entry that keeps its shape, without
  holding the snapshot; it returns as `ok` at `version + 1`. A texture already published as `ok`
  keeps the hold-back (its old pixels stay). A variant still encoding is still listed by omission
  (Q3), not as a pending entry: it would withdraw the usable `decoded` payload. Details in
  [render-stream-9.md](render-stream-9.md) "As built (G8kf)". The Rust planner needed one fix for
  the recovery: no item entry changes when a texture returns, so an apply that uploads a texture now
  replays the items that skipped a command for it. Why opt-in: it changes a recording from "a
  frame-for-frame subset of the synchronous one" (G8kw) to one with pending frames, which the
  frame-exact legs cannot take. Check `delivery-pending` (g8ku): the first transaction carries the
  pending entries, each returns at `version + 1` with the synchronous capture's hash, shape and
  variants (the final table equals the synchronous one but for versions), both sinks validate, and
  the native receiver (upgrade) and the web export upload nothing while pending; the receiver's
  shots equal the reference (step 0) and the oracle's blocks (step 1) exactly.
- **`delivery-transcode-failed` falls back to `decoded`** on the native receiver and the web export
  (one GDScript/C++ path, `receiver.gd`, `rs_rust_applier.gd`, `rs_core_ext.cpp`, `rs-core`). The
  executor's transcode moved ahead of the apply (`pretranscode`, called by
  `RsRustApplier.screen_variants` for every KTX2 the stream needs that this process holds): a file
  the loader refuses is counted (`applied.json` `variant_fallbacks[]`, the failed row in
  `transcodes[]`), the core refuses that variant (`DeliveryPrefs.refused`, `rsc_refuse_variant`: D3
  and `keeps()` skip it from then on, for the rest of the session), `needed()` now names the entry's
  next preference, `decoded` at last, and the receiver fetches it (`_obtain_needed`, or the live
  HTTP fetcher through `_begin_apply`) before any RenderingServer call. The transcoded `Image` is
  kept and the executor takes it, so the transcode is not done twice. Only a transcode failure
  falls back: a hash mismatch (`perturb-ktx2`) and a shape mismatch still end the replay, since
  those mean the bytes are not what the host published. A failure the executor meets that the
  pre-pass did not (a dimension mismatch) is still the replay failure. Sabotage
  `GRC_TEXTURE_ENCODE_FAULT=corrupt-ktx2` damages level 0's Zstandard frame before hashing, so every
  hash and header check passes and only the transcode fails. Check `delivery-fallback` (g8ku):
  native (upgrade) and web both count 5 fallbacks and 5 failed transcodes, upload only `decoded`
  (`block` for the DXT1 source) and finish ok; the native shots equal the reference exactly.
  G8kb's GSW side is its own.
- **The web export and `block`.** It does advertise: `gpu_formats` from its WebGL context through
  `has_os_feature` (here `s3tc,bptc,rgtc,etc2`; the native receiver `s3tc,bptc,rgtc`), so the BC
  `block` variants are taken at /9. Check `delivery-select-web` (g8kp): the web export replaying
  g8kp's passthrough recording uploads exactly what D3 picks under its own stated hello (11 `block`,
  3 `decoded` here) and takes the BC blocks exactly when it states a BC family. Pixels are not
  compared (a browser's hardware decode is the GSW check's concern, not this one's).

**Traps.** `GRC_TEXTURE_ENCODE_WAIT_FRAME` now also waits for the texture workers first (a finished
hash starts its encode), and an encode started for a pending-returned texture must be of the new
version (`resolve_pending` before the job is made), or the attach discards it as stale. A first
frame takes ~100 ms, longer than the workers legs' 8 ms jobs, so the pending leg uses 250 ms jobs to
have most textures pending in transaction 1.

**Not covered.** A live leg with `GRC_TEXTURE_PENDING=publish` (the hub's path is the stall path
the hold-back reuses; the epoch advance is what a live hub needs), GSW's apply of a pending
recovery, ETC1S, receiver-driven encode priority, pack warming (all/selective), the g31.

| Item | Owner | State after G8kf |
| ---- | ----- | ---------------- |
| GSW transcoder, `delivery-transcode-failed` fallback in GSW, the g31 | G8kb | not run here |
| ETC1S, D12(d)'s PSNR floor, the throttled link | G8ke | `basis-etc1s` still refused at /9 |
| All-pack / selective-pack warming (K3) | deferred library feature | `--list` is the form it feeds |
| Receiver-driven encode priority (Q4), freeing `decoded` bytes on the host (Q7 "Memory") | later | FIFO in table order; `decoded` stays resident |
| Manifests for gate 8's new checks | G8z | not added here |

## As built (G8kwh)

Landed as one commit; evidence summary [results/gate8/g8kwh.md](../results/gate8/g8kwh.md). The web
export now states, and uploads, only the texture formats its WebGL context takes.

**The two defects.** (1) Godot 4.5.1's GLES3 config sets `etc2_supported = true` on every build that
is not desktop GL (`drivers/gles3/storage/config.cpp`, the `!is_gles_over_gl()` branch: WebGL,
Android, iOS), whatever the context's extensions; `s3tc`, `bptc`, `rgtc` and `astc` do read them. So
`has_os_feature("etc2")` is true on every web build, the web export stated `etc2` on desktop
contexts without `WEBGL_compressed_texture_etc`, took the ETC2 `block` variants and
`compressedTexImage2D` refused them (`INVALID_ENUM`, the texture incomplete: black). (2) WebGL refuses
a BC level 0 that is not 4-aligned (`INVALID_OPERATION`); desktop GL takes it. The web export's
150x110 `npot` uastc variant transcoded to BC7 and drew black (16,500 px). G8kb's "wrong live, right
in the replay" was not a live/file difference: the replay in its evidence
(`artifacts/render-stream/gate8/g8kb/web-npot-defect/replay`) ran on the *native* receiver
(`applied.json` `receiver.kind` `native`, X11), whose desktop GL accepts the unaligned BC7; the live
web final shot and that replay's last checkpoint differ on all 16,500 px of the box and elsewhere
only by channel 1 (6,173 px, Q7's band). Under the landed harness `lib/legs.sh` sends a GRS9 replay to
the browser too, where it would have drawn the same black box.

**The hello.** `receiver.gd` `_apply_delivery` on the web reads the page's WebGL 2 context's
extensions through `JavaScriptBridge` (`canvas.getContext('webgl2')` returns the engine's own context;
emscripten enables every supported compressed-texture extension by default, and Godot's config reads
the same `getSupportedExtensions` list) and states a family only when `has_os_feature` reports it AND
its extension is listed (GSW's own table, `web/gsw-receiver/hello.ts`). `applied.json`'s
`texture_delivery` adds, on the web, `gpu_formats_engine` (what `has_os_feature` claims),
`webgl_extensions` (the compressed-texture ones the context lists) and `bc_aligned_only`. A list that
cannot be read states no family. The native receiver's hello and report are unchanged.

**WebGL's alignment rule in D3.** rs-core `DeliveryPrefs` gains `bc_aligned_only` and
`transcoder_aligns`. With `bc_aligned_only`, D3 skips a BC (`s3tc`, `bptc`, `rgtc`) `block` variant of
a texture whose level 0 is not 4-aligned, and, unless the receiver's transcoder applies the rule
itself (`transcoder_aligns`), that texture's `uastc` variant while any BC family is stated: Godot's
KTX2 loader (D14) would pick that family for it. This is conservative for a four-component texture
on a context with ASTC as well as BC (the loader picks ASTC first; D3 takes `decoded`): no desktop GPU
has both. The entry falls through to its next preference, `decoded` at last, so no KTX2 is fetched
for it. The web export sets the rule (`rsc_set_bc_aligned_only`, through `set_webgl_rules`), GSW sets
both (its transcoder's `webglFamilies` already retargets an unaligned texture, G8kb, so its `uastc`
stays; the new part is that it never takes an unaligned BC `block` variant, which no fixture has).

**The loader's target, bounded.** Godot's loader picks its target from `has_os_feature`, so on the
web it still believes in `etc2`, and it ignores the receiver's mask. Under `set_webgl_rules` the
extension's transcode (`transcode_ktx2`, in `pretranscode` ahead of the apply) refuses a target whose
family the receiver did not state, or BC at an unaligned size: the row gets `ok: false` and
`refused_target`, and G8kf's fallback takes the entry's next preference (`decoded`). A context with
neither BC nor ASTC nor ETC (a software WebGL) would otherwise have uploaded ETC2 and failed.

**Native stays byte-identical**: it never sets the rules, and its hello and report are unchanged.

**Checks.** g8kp: `delivery-select-web` now also requires each stated family's extension in the
context's own list and the rule stated; `delivery-pixels-web` (new legs `g8kp-web/web-masked`, the
decoded baseline): on the step whose BC blocks it took, the web draw is within channel 1 of
`reference-hw` on every pixel where its decoded draw equals the CPU-decoded reference; on the
mobile step (no ETC2/ASTC taken on desktop) it equals the masked leg exactly; no `WebGL: ` console
line. Sabotage `advertise-etc2` (`g8kp-web/sabotage-advertise-etc2/web`, the pre-G8kwh hello: etc2
stated, rules off) takes 5 ETC2 blocks and fails that predicate (`sabotage-advertise-etc2`). g8ku:
`delivery-web` and `delivery-fallback` expect `npot` decoded on the web; `delivery-pixels-web` holds
the web export's upgrade leg within channel 1 of the native upgrade leg, `npot`'s region of the
native keep leg; `delivery-web-masked` (new leg `g8ku-web/web-masked`, BC masked) sees every
transcode's BC target refused and only `decoded` uploaded. g7-8's web half replays g8kp's legs
again; g8ku's stay out by design (`web-judged-in-gate8`: `npot` decoded on the web, BC7 natively),
judged by gate 8's own web legs, and so does `g8l/basis/replay` when the source is a full gate 8
run (the source cache can reuse one, which holds g8l's native file replays). A replayed delivery leg whose native and web receivers state
different `gpu_formats` (the CI runner: llvmpipe GL has ASTC, ANGLE on lavapipe states
`s3tc,bptc,rgtc`) makes different D3 choices by design: `delivery-context-differs@web` (report only)
lists it, and its applied and pixel differences are attributed there, as a `web-*` refusal's are.
The web export's live g8l `basis` leg runs.

**Not covered.** A fixture with an unaligned BC `block` variant (the rule is unit-tested in rs-core
and the self-test only); a WebGL context with neither BC nor ASTC (the refused-target backstop is
exercised by masking); Android/iOS native exports, which share Godot's `etc2` claim; ETC1S (G8ke).
