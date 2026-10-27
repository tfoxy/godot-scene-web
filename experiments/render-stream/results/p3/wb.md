# WB: the warm wire budget of STS2, and what /11 should do about it (2026-10-27)

**Warm STS2 combat costs 176 KB a frame at /10 and 210 KB at /11 as designed: 85 and 101 Mbps at
60 fps, against 15–25 Mbps for 1080p60 video.** The bytes are draw-state churn, not pixels:

- 163 of the 174 items in a combat patch are there only because `content_version` moved over an
  identical, re-recorded command list. They are 120.9 KB of the 176.
- The rest is mostly 106 spine poses: 39 KB of mesh bodies and 30 KB of mesh entries.

Three measured changes take combat to **5.6 KB a frame (2.7 Mbps)**:

1. The capture keeps `content_version` when a re-recorded list is identical, and `unsupported` is
   sent only when it changes: 210 → 80 KB raw.
2. zstd-3 with the base transaction's message as a raw prefix: → 12.5 KB.
3. XOR-delta mesh bodies against the base's body, with positions and UVs in fixed point: → 5.6 KB.

Rows 1 and 2 belong in /11. Row 3 belongs in the final binary-structure swap.

The design fold-in is [protocol/render-stream-11.md](../../protocol/render-stream-11.md), "Warm wire
budget (WB)". The tool is `scripts/lib/wire-budget.py`.

## Method

- **Recordings.** C3's `a8-2` (/8, 4,960 transactions) and P3-TM's `p3tm-a10-2` (/10, 4,916),
  both kept in `artifacts/render-stream/p3/fidelity-data/`, with their stores.
  - Scenes by frame for `a8-2`, as W11-D: menu 16–1193, map 1194–1684, combat 1686–5000.
  - For `p3tm-a10-2`, from its full-size transition transactions: menu 22–1689, map 1690–2447,
    combat 2449–end.
  - Both recordings agree within 1 % on every combat row. The tables give `a8-2`; the evidence
    has both.
- **Warm.** A patch transaction inside a scene, from 30 frames after the scene starts. Every byte
  row is the mean and p95 over a scene's warm transactions. Mbps is mean bytes × 8 × 60.
- **Tool.** `wire-budget.py analyze` (run with `mise exec -- python3`: zstd needs Python 3.14's
  `compression.zstd`, zstd 1.5.7). It reads records without validating them and tracks the resolved
  items, canvases and meshes. It reads mesh bodies from the store.
  - It reads the version from the magic's hex digit, so `GRSA` is 10 (the C3 `analyze.mts` bug
    that CG4 owns).
  - Its synthetic self-test (`test/self-test-wire-budget.sh`, in the pure suite) builds a /10
    recording with a store and checks every category, counter and coding against hand values.
- **The /11 message** is approximated as W11-D specified it:
  - a mesh is dynamic from its second content change within 4 frames;
  - its changed bodies (GRM1 without header and meta) go into `mesh_u8`;
  - its surfaces get `hash: null`;
  - each mesh entry gets `u8`;
  - the two new block descriptors are added.

  This reproduces W11-D's 210,134 B combat transaction within 0.1 % (210,343).
- **Compression.** Every compressor runs on the whole /11 message, its meta alone and its blocks
  alone.
  - zstd per message is applied at levels 3 and 9.
  - The dictionary variant uses one dictionary per scene and part (112 KB, `train_dict`), trained
    on up to 400 messages from the first 30 % of the scene. The last 70 % is the test window for
    every compression row.
  - permessage-deflate is zlib level 6, a raw 32 KB window, context takeover (one compressor for
    the connection, `Z_SYNC_FLUSH`, minus RFC 7692's 4 trailing bytes).
  - Streaming zstd keeps one compressor for the whole recording and flushes a block per message.
  - **Base-prefix zstd** compresses T's message with the previous transaction's message as a raw
    prefix (`ZstdDict(prev, is_raw=True).as_prefix`).
- **Delta.** Each item's `item_f32` floats, and its command floats when it re-sends commands, are
  XORed (or subtracted as u32) with the previous resolved values of the same item, when the
  length matches. Each dynamic mesh body is XORed with the previous body of the same mesh. A
  sparse coding with no compressor uses one bit a word plus the non-zero words.
- **Quantization** is computed on every 20th test transaction. Bytes saved count every quantizable
  float in the transaction's items, commands and dynamic mesh bodies. Error is measured end to
  end: each rect corner and each mesh vertex goes through the item's whole parent chain and
  canvas transform, in float64, once with the original floats and once with every float of the
  chain quantized. The result is the largest screen distance at 1920x1080 (logical size equals
  presentation size, scale 1). Colour error is |q − v| × 255 for colours in [0, 1].
- **Parse share.** `profile-rs-core-wasm.mjs` runs rs-gsw-wasm (GSW's core, in Node's V8),
  through `rs-core-check profile` natively. It was run on `p3tm-cut.rs10`, under the quiet lock
  held exclusive, with 5 repeats; the transaction minimum was taken. The rows are combat patches,
  seq 2450–2920. `meta` is `meta::decode_record`: the JSON parse and the schema decode.
- **Host.** `bench-capture-scale.sh --mode file --perf` on `fixtures/capture-scale` (STS2 combat's
  shape, perf-wrapped, so not a rate number). The shares are of the main thread's samples. They are
  turned into ms with the capture's own `frame_callback_us` mean.

## Bytes by category (warm, per transaction)

| category | menu | map | combat mean | combat p95 | combat Mbps |
| -------- | ---: | --: | ----------: | ---------: | ----------: |
| **/10 transaction record** | 38,452 | 17,556 | **176,480** | 178,018 | **84.7** |
| /10 mesh payload records (inline 4096) or GETs, besides | 11,035 | 0 | 79,804 | 81,008 | 38.3 |
| **/11 message (W11-D shape)** | 41,844 | 17,646 | **210,343** | 212,067 | **101.0** |
| item state JSON (every item key but `commands`) | 13,916 | 3,921 | 63,736 | 64,631 | 30.6 |
| command JSON: `add_set_transform` | 0 | 2,092 | 14,972 | 15,032 | 7.2 |
| command JSON: text (`add_msdf_…`) | 0 | 1,853 | 12,340 | 12,361 | 5.9 |
| command JSON: `add_mesh` | 1,507 | 0 | 5,174 | 5,250 | 2.5 |
| command JSON: other draws | 0 | 87 | 335 | 417 | 0.2 |
| `item_f32` (transform, modulates, custom rect) | 2,736 | 767 | 12,499 | 12,672 | 6.0 |
| `cmd_f32`: transforms | 0 | 1,440 | 10,040 | 10,080 | 4.8 |
| `cmd_f32`: text | 0 | 1,545 | 10,063 | 10,080 | 4.8 |
| `cmd_f32`: `add_mesh` | 1,320 | 0 | 4,140 | 4,200 | 2.0 |
| mesh entries JSON, without hashes | 7,108 | 2 | 22,536 | 22,874 | 10.8 |
| mesh surface hashes (`"hash":"<64 hex>"`) | 2,442 | 0 | 7,658 | 7,770 | 3.7 |
| `mesh_f32` (custom AABBs) | 792 | 0 | 2,484 | 2,520 | 1.2 |
| /11 `mesh_u8` bodies (replace the hashes and records) | 4,265 | 0 | 39,012 | 39,484 | 18.7 |
| `unsupported` (complete every transaction) | 4,991 | 4,940 | 9,512 | 9,514 | 4.6 |
| materials JSON + `param_f64` | 2,508 | 25 | 17 | 2 | 0.0 |
| transaction header JSON, block descriptors | 756 | 787 | 760 | 760 | 0.4 |
| record framing and WebSocket header | 40 | 40 | 46 | 46 | 0.0 |

**Everything here scales with draw-state churn**: items, commands and mesh poses re-sent. None of
it scales with pixels. Textures are out of band and cold; warm transactions carry none. The churn
behind combat's 174 patched items, per transaction:

| | combat | menu |
| - | -: | -: |
| items in the patch | 173.6 | 38.0 |
| ... commands re-sent identical (JSON and floats equal to the base's) | 164.6 | 38.0 |
| ... **only** a moved `content_version`: header, floats and commands all equal | **162.7 (120,878 B)** | 38.0 (19,478 B) |
| ... floats only (an `item_f32` change: 16.2 transform floats) | 4.1 | 0 |
| ... commands with changed floats or structure | 4.8 | 0 |
| JSON key names inside the items (`"key":`) | 42,185 B | 9,234 B |
| `unsupported` identical to the previous transaction | 9,498 B | 4,991 B |
| mesh entries with a new pose | 102.5 | 17.0 |

In a sampled combat patch (seq 1800), the redundant items are:

- 106 spine items: each is an `add_mesh` whose mesh id and transform do not move, and whose pose
  travels in the mesh entry;
- 61 items holding transforms and texture rects;
- 4 text items.

STS2 redraws them every frame. The capture bumps `content_version` on `canvas_item_clear` and on
every add, so an identical re-recording looks like new content.

**The lean message** is the /11 message without those items (and their floats), with `unsupported`
empty when it is unchanged. It is **79,968 B in combat (38.4 Mbps)**, 17,374 on the menu and 12,720
on the map.

## Encoding: JSON structure against binary blocks, and compression

Combat's /11 message is 131,887 B of meta (63 %) and 78,434 B of blocks (37 %). The test windows
(combat 2,300, menu 803, map 147 transactions):

| coding (whole /11 message unless named) | menu | map | combat mean | combat p95 | combat Mbps |
| --------------------------------------- | ---: | --: | ----------: | ---------: | ----------: |
| none | 41,844 | 17,646 | 210,343 | 212,067 | 101.0 |
| zstd-3, per message: meta / blocks / whole | 2,265 / 2,925 / 5,714 | 1,402 / 666 / 2,130 | 7,333 / 29,683 / 36,859 | 37,276 | 17.7 |
| zstd-9, per message: meta / blocks / whole | 2,112 / 2,869 / 5,387 | 1,287 / 635 / 1,998 | 5,792 / 28,961 / 34,787 | 35,187 | 16.7 |
| zstd-3, scene dictionary: meta / blocks / whole | 689 / 733 / 1,493 | 855 / 305 / 1,402 | 3,115 / 12,209 / 16,598 | 17,074 | 8.0 |
| zstd-9, scene dictionary: meta / blocks / whole | 523 / 709 / 1,318 | 674 / 288 / 1,122 | 2,311 / 12,036 / 15,381 | 15,799 | 7.4 |
| permessage-deflate, no context | 5,822 | 2,155 | 39,899 | 40,322 | 19.2 |
| permessage-deflate, context takeover | 5,547 | 662 | 40,340 | 40,771 | 19.4 |
| zstd-3 streaming (one context a connection) | 964 | 435 | 12,751 | 13,709 | 6.1 |
| zstd-9 streaming | 947 | 388 | 12,361 | 12,608 | 5.9 |
| **zstd-3, base message as prefix** | 992 | 433 | **12,682** | 13,024 | **6.1** |
| lean, zstd-3 per message | 4,496 | 1,875 | 31,928 | 32,412 | 15.3 |
| **lean, zstd-3 base prefix** | 891 | 436 | **12,471** | 12,817 | **6.0** |
| lean + XOR delta (floats, mesh bodies), base prefix | 686 | 438 | 10,322 | 10,680 | 5.0 |
| lean + XOR delta, streaming | 714 | 417 | 10,338 | 10,667 | 5.0 |
| **lean + XOR delta + tiered mesh bodies, base prefix** | 431 | 438 | **5,586** | 5,989 | **2.7** |
| lean + XOR delta + tiered mesh bodies, streaming | 395 | 417 | 5,312 | 5,733 | 2.6 |

- **The JSON structure is not where the compressed bytes are.** zstd per message takes the meta
  from 132 KB to 7.3 KB, and the blocks only from 78 to 30 KB. With any context, the meta drops
  to 2–3 KB. The 42 KB of key names and the 121 KB of redundant items are exactly what a
  compressor removes. A binary structure would save raw bytes and parse time, but almost no
  compressed bytes.
- **Context is the win**, not the level: 37 → 12.7 KB (zstd-9 per message gets only to 34.8 KB).
  Base-prefix and streaming are equal within 1 %. That is video's inter-frame state: the previous
  frame predicts this one.
- **permessage-deflate cannot see the previous frame.** Its 32 KB window is smaller than one
  combat message, so context takeover gains nothing there (it does help the 17 KB map: 2,155 →
  662).
- **A trained dictionary** reaches only 8.0 Mbps. It also has to be trained and distributed.
- **Lean's raw saving mostly vanishes under compression** (12,682 → 12,471). It still matters
  uncompressed (210 → 80 KB) and for parse time (below).
- **Host cost** on this desktop (Python's binding of C zstd 1.5.7, one core, combat /11 message):
  - zstd-3 0.44 ms (p95 0.62);
  - base prefix 0.49 ms;
  - zstd-9 2.24 ms;
  - deflate 2.77 ms.

  Decompression takes 0.16 ms natively.

## Delta coding (combat, per transaction)

| numeric stream | plain | XOR, sparse (no zstd) | plain zstd-3 | XOR zstd-3 | u32-sub + shuffle zstd-3 |
| -------------- | ----: | --------------------: | -----------: | ---------: | -----------------------: |
| `item_f32` (patched items) | 12,478 | 454 | 361 | **99** | 145 |
| `cmd_f32` (re-sent commands) | 24,460 | 925 | 1,508 | **160** | 229 |
| `mesh_u8` (dynamic bodies) | 39,012 | 11,984 | 26,142 | **8,007** | 7,792 |
| `mesh_u8`, tiered (below) | 28,225 | — | 17,683 | **3,051** | — |

- Item and command floats barely move between frames: 99.2 % and 99.3 % of the bytes vanish under
  XOR+zstd. But base-prefix zstd already finds them, so delta coding them separately adds
  nothing: 12,471 → 10,322 for the whole lean message comes almost entirely from the mesh bodies.
- **Mesh bodies are the residue.** Spine poses move their vertices by sub-pixel amounts, and the
  f32 mantissa noise defeats LZ matching. XOR against the base's body of the same mesh gives
  26 → 8 KB under zstd. Fixed-point positions remove the noise (8 → 3 KB).

## Quantized-float tier

Bytes saved are raw, from every quantizable float of the transaction's items, re-sent commands and
dynamic mesh bodies. Error is end to end on screen:

| tier | combat saved | max position error (px, 1080p) | max colour error (8-bit steps) | values that cannot use it |
| ---- | -----------: | -----------------------------: | -----------------------------: | ------------------------- |
| f16 for everything | 28,525 B (13.7 Mbps) | **0.60** (menu **2.07**) | 0.06 | none, but the error is visible |
| tiered: positions i16 at 1/16 px, source rects u16 at 1/8 texel, colours u8, mesh UVs u16 | 25,482 B (12.2 Mbps) | **0.052** (menu 0.067, map 0.117) | **0.38** | 230 of 1.32 M (overbright colours > 1, positions beyond ±2048) |

- **Not quantizable without visible error:**
  - transform linear parts (a 2^-11 relative error at a 1000 px extent is 0.5 px);
  - f16 positions (step 1 px above 1024);
  - colours above 1 (overbright modulates: 2 a combat transaction);
  - `msdf` `px_range`/`scale`.

  The menu's spine positions reach beyond ±2048 in local units (3,520 of 53,520 values). They
  want AABB-relative u16 (the body already carries its AABB) rather than a fixed range.
- After compression, the tier is worth ~5 KB a combat frame, the mesh bodies' 8 → 3 KB. The item
  and command floats are already under 0.3 KB compressed.

## Receivers' JSON-parse share

rs-core in combat (seq 2450–2920, 471 patches of 176.9 KB, /10 with directory delivery, so each
transaction also fetches its ~102 new mesh payloads). Median µs per transaction:

| | core total (no draw) | `meta` (JSON parse + schema) | share | share excluding /10's payload provide |
| - | -: | -: | -: | -: |
| GSW core (rs-gsw-wasm, V8) | 1,450 | 450 | **31.1 %** | **43.1 %** |
| native core (`rs-core-check`) | 871 | 306 | 35.0 % | 44.7 % |

`meta` costs 2.6 µs a KB of record in wasm. /11 removes the payload provide, which here hashes and
decodes the 102 fetched mesh payloads. Without it, **parsing is 40–45 % of the core's
per-transaction work**. That share is of the core only: GSW's draw (GL submit) comes on top. The
lean message removes about 95 KB of the 132 KB combat meta (derived from the counters, not measured
separately), so it would cut the parse by about 70 % (≈ 0.3 ms in wasm). A compressor saves no
parse time at all.

The run waited for a 1-minute load average under 4 and then took the quiet lock exclusive. The load
was 3.96 at the start and 4.39 at the end (`/proc/loadavg`; other repos' work, outside the lock).
An earlier run at a load of about 7 gave 26.5 % and 32.6 %, with the same meta µs (457 and 313).

**The moto g31 leg was skipped.** STS2 combat's state needs about 0.9 GB of texture payloads
before its first combat transaction. No phone-sized combat input exists: building one means a
synthesized full transaction and a subset store. A meta-only microbench would need a new export in
rs-gsw-wasm, which is a receiver change. That is well over the hour. Projection, not measurement:
G7x measured the core's wasm at ~11x desktop on the g31, so meta ≈ 5 ms of a ~15–20 ms combat
transaction there (450 µs and 1,450 µs × 11). The lean message matters more on the phone than anywhere else.

## Host capture cost by category (fixture, perf-wrapped)

`capture-scale`, file mode, 600 frames: callback p50 6.66 ms, mean 7.88, p95 8.70, snapshot p50
2.69 ms. The armed and unarmed legs ran at 60.0 fps (perf-wrapped: not a rate number). Main thread
shares converted to ms per frame:

| cost | share of samples | ms / frame |
| ---- | ---------------: | ---------: |
| frame callback (`on_frame`) | 35.5 % | 7.9 |
| - `mirror_snapshot` | 14.1 % | 3.1 |
| - `Publisher::publish` | 15.9 % | 3.5 |
| -- `make_patch` (the diff) | 5.4 % | 1.2 |
| -- `encode_transaction` (JSON and blocks) | 2.8 % | 0.6 |
| -- `store_payloads` (store bookkeeping) | 3.5 % | 0.8 |
| -- previous snapshot release | 2.9 % | 0.6 |
| - evidence drain (`resources.jsonl`, harness only) | 1.9 % | 0.4 |
| hooks: mesh region copies (incl. SHA-256) | 3.7 % | 0.8 |
| hooks: `set_material` (mostly evidence logging) | 3.5 % | 0.8 |
| SHA-256 of payloads, all callers | 5.2 % | 1.2 |
| file writer thread (store files, recording) | 33.6 % of all | off the main thread |

P3-CAP's after-profile of STS2 itself (results/p3/p3-cap.md) agrees: an 8.2 ms callback, with a
3.9 ms snapshot and 3.0 ms of publish.

**Against NVENC's 1–3 ms.** The wire format accounts for about 0.6 ms (encode), plus 0.44 ms if
zstd-3 is added once per (base, target). Snapshot and diff dominate, and they are O(table), not
O(churn). P3-CAP's "dirty-set publication" design is the lever there. /11 removes the per-pose
SHA-256 and store writes (about 2 ms of this profile). Keeping `content_version` stable also
shrinks the diff's output, but not its walk.

## Projection

| combat, one viewer, every transaction | bytes / frame | Mbps at 60 |
| ------------------------------------- | ------------: | ---------: |
| /10 live today (record + inline mesh records, framing approximated) | 256,284 | 123.0 |
| /11 as designed (W11-D) | 210,343 | 101.0 |
| + stable `content_version` and patched `unsupported` (lean, /11) | 79,968 | 38.4 |
| + zstd-3 base-prefix transport (recommended default) | 12,471 | **6.0** |
| + XOR-delta mesh bodies | 10,322 | 5.0 |
| + tiered mesh positions and UVs (final binary swap) | 5,586 | 2.7 |
| 1080p60 video (the user's baseline) | 31,000–52,000 | 15–25 |

**Bottom line: /11 with the two lean rules and base-prefix zstd puts warm combat at about 6 Mbps,
2.5–4x below video.** The menu is at 0.43 Mbps and the map at 0.21. Without transport compression,
lean /11 is still 38 Mbps, above video. Compression is not optional for that comparison.

Still missing for a like-for-like claim:

- the receivers' zstd decoder (rs-core has none, and the local Cargo registry has no zstd crate);
- the cold start (the textures' first GETs, G8kz/KTX2's territory);
- the g31's decode cost;
- the host's snapshot and diff (7–8 ms, not video's 1–3).

## Validation

- `validate-increment.sh --plan` maps the diff to the `pure` target only: the tool and its
  self-test via a new `smoke-map.json` rule, and the docs.
- `bash scripts/test/self-test-wire-budget.sh`: 35 checks pass under mise's Python 3.14. Under the
  system Python 3.12 the four zstd checks are skipped and the other 31 pass.
- The pure suite runs it (`run-pure-self-tests.sh --only self-test-wire-budget`).

## Deviations

- **Load during the parse-share profile:** 3.96 at the start, 4.39 at the end (gated on under 4,
  but others' load outside the lock rose during the 40 s run).
- **No GSW page replay.** The parse share comes from the same wasm module under Node. Its draw is
  excluded. A page bench would copy and prefetch the 2.2 GB store (`gate7-bench.ts --arm gsw-rs`).
- **g31 leg skipped** (above).
- **The /11 message is approximated**, as W11-D did. Lean and tiered are measured on rebuilt
  messages, not on a codec. Tiered mesh positions are clamped rather than given an f32 fallback, so
  the menu's tiered row is slightly optimistic.
- **Host split from the fixture, perf-wrapped.** STS2 itself was not launched. P3-CAP's game
  profile is cited for the game.

## Evidence

In the main checkout's ignored `artifacts/render-stream/p3/wb/`:

- `wb-a8-2.json`, `wb-a10-2.json`: every table above (`render-stream-wire-budget/1`);
- `prof-wasm.jsonl`, `prof-native.jsonl`: the core profiles; `prof-share.txt` and the
  `wb-prof-share.py` that computed it (seq 2450–2920);
- `capture-scale-perf.txt` and `bench-capture-scale.json`: the host split.

Re-run on a new recording with:

```
mise exec -- python3 experiments/render-stream/scripts/lib/wire-budget.py analyze \
  --recording <rec> --store <store> --scene combat:<f0>-<f1> [--scene ...] --out wb.json
```
