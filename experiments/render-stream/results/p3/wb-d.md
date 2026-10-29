# WB-D: the warm wire of /12 STS2, and the /13 binary design (2026-10-29)

**Lossless /13 puts warm STS2 combat at 6,171 B a frame coded, 2.96 Mbps, against /12's
13,311 B (6.39 Mbps) and video's 15–25 Mbps.** The menu is 0.40 Mbps and the map
0.16. Measured with a Python prototype of the encoding on `pm7-a12-1`, the first STS2
recording with multimesh and GPU particles on the wire. Every lossless message was decoded back
to the recording: 4,854 warm transactions, zero differences.

Where the saving comes from:

- **Spine poses are 75 % of /12's coded combat frame** (`mesh_u8`: 39 KB raw, 10.0 KB coded).
  Predicting each vertex from its two previous poses, on order-preserving integers, takes them to
  4,328 B without changing a bit of any float. WB's XOR got 7.7 KB.
- **The JSON meta is 39 KB raw but about 0.5 KB coded.** A binary structure takes it to
  3,884 B raw and saves about 240 B coded. JSON parsing costs the native
  core 16 µs a combat transaction (5 %), not WB's 35 %: the lean /11 meta and rs-core's
  schema-directed fast path removed it.
- **Quantization is not needed.** 1/64-unit positions would reach 3,206 B (1.54 Mbps)
  at 0.006 px of error, but no bound can prove pixel identity. /13 stays lossless and reserves the
  quantized tier as an opt-in it does not build.

The design is [protocol/render-stream-13.md](../../protocol/render-stream-13.md). The tool is
`scripts/lib/wire-budget.py proto13`.

## Method

- **Recording.** `artifacts/render-stream/p3/fidelity-data/pm7-a12-1/capture/recording-patch.rs12`
  (PM7: /12, 4,955 transactions, 281 MB; mod init, menu, map, combat; directory delivery, inline
  4096).
  - Scenes by frame, from the full-size transition transactions: menu 17–1498, map 1503–2249,
    combat 2258–5000.
  - Warm: a patch at least 30 frames into its scene, as WB. That gives 1,425 / 716 / 2,713
    transactions.
- **Tool: `wire-budget.py proto13`** (new, run with `mise exec -- python3` for
  `compression.zstd`):
  - **Categories.** Each /12 record is split into categories whose sizes sum exactly to the record
    (checked on every transaction). Each category is also coded on its own with zstd-3 against the
    previous transaction's same category as a raw prefix: an attribution of the coded bytes. Each
    part pays a zstd frame of its own (about 10 B), so small categories read high and the parts sum
    to a little more than the whole message's coding.
  - **The /13 prototype.** A schema is learned from the recording (per JSON path: the key tuples,
    value types and string tables), standing in for /13's fixed schema table. Each transaction is
    written in the binary syntax of render-stream-13.md, with its blocks under several codings
    (below). A value pays a type tag, and an object a shape id, only where its path has more than
    one, so the counts are those of a fixed-schema encoding within a byte or two per object.
  - **Codings** (the block numbers, all on 32-bit words against the same unit in the previous
    resolved state): `raw`; `xor` (WB); `sub` (u32 difference of the bit patterns); `zz`
    (order-preserving integers, difference, zigzag); `p2` (as `zz` against 2·last − previous).
    `aos` keeps each body in place, `soa` regroups bodies into geometry, position, colour, UV, skin
    and index streams and byte-plane transposes the word streams. `w13` is the design: `p2`, `soa`,
    only `mesh_u8`, `mesh_f32` and `mm_f32` predicted. `json_w13` is `w13`'s blocks behind /12's
    JSON meta. `*_q16/64/256` quantize dynamic positions to that local step (lossy).
  - **Proof.** Every lossless coding of every warm transaction is decoded back: the structure to
    the record's canonical JSON bytes, the blocks to the record's bytes.
  - **Coding of messages:** zstd-3 per message, and with the previous message of the same coding
    as a raw prefix (W11t), plus W11t's 24 B envelope and 4 B checksum and the WebSocket header.
    Resource records are coded per message, as W11t codes them.
  - **Quantization error:** every 10th warm transaction, each dynamic vertex's quantization error
    through the largest spectral norm of the transforms it is drawn through (canvas, item chain,
    the item's current `add_set_transform`, the `add_mesh` transform), at logical 1920x1080 =
    presentation size.
- **Parse share.** `rs-core-check profile` (native, release) over the whole recording, 5 repeats,
  per-transaction minimum, under `quiet.sh exclusive` at a load of 3.0–3.1. `meta` is
  `meta::decode_record`, which for a transaction is `meta/fast.rs`.
- **zstd timings** are Python's binding of the C library (zstd 1.5.7) on this desktop, under
  `quiet.sh shared`: comparable between codings, not timing-leg results.

## /12 warm bytes by category

Per warm transaction, raw / coded alone against the base's same category:

| category | menu raw | menu coded | map raw | map coded | combat raw | combat coded |
| -------- | -------: | ---------: | ------: | --------: | ---------: | -----------: |
| framing | 48 | 16 | 48 | 16 | 48 | 16 |
| transaction header JSON | 420 | 27 | 422 | 26 | 422 | 26 |
| item state JSON | 11 | 20 | 2,256 | 43 | 3,616 | 74 |
| command JSON: transforms | 0 | 0 | 2,090 | 23 | 2,097 | 24 |
| command JSON: text | 0 | 0 | 1,830 | 29 | 1,825 | 28 |
| command JSON: mesh draws | 0 | 0 | 0 | 0 | 1 | 1 |
| command JSON: other draws | 0 | 0 | 0 | 0 | 68 | 25 |
| mesh entries JSON (hashes nulled) | 7,843 | 130 | 12 | 21 | 24,898 | 180 |
| mesh surface hashes | 751 | 18 | 0 | 0 | 62 | 16 |
| multimesh entries JSON | 189 | 19 | 0 | 0 | 5,747 | 119 |
| particles JSON + `pt_f32` | 0 | 0 | 0 | 0 | 1 | 0 |
| textures, shaders, materials, canvases JSON | 1,917 | 177 | 57 | 16 | 99 | 17 |
| `unsupported` | 19 | 15 | 19 | 15 | 19 | 15 |
| block descriptors JSON | 407 | 22 | 404 | 18 | 413 | 23 |
| `item_f32` | 0 | 0 | 376 | 151 | 602 | 125 |
| `cmd_f32` | 0 | 0 | 2,966 | 144 | 3,006 | 153 |
| `mesh_u8` (dynamic bodies) | 4,224 | 676 | 0 | 0 | 39,021 | 9,954 |
| `mm_f32` | 88 | 42 | 0 | 0 | 3,712 | 696 |
| other blocks (`mesh_f32` AABBs, `param_f64`, ...) | 1,059 | 96 | 8 | 17 | 2,497 | 1,336 |
| **record (raw) / whole message (W11t)** | **16,978** | **1,120** | **10,489** | **324** | **88,154** | **13,311** |
| resource records before it, raw / per message zstd-3 | 904 | 324 | 0 | 0 | 2 | 1 |

- **JSON against blocks.** In combat the JSON meta is 39,268 B raw (45 %) and the
  blocks 48,886 B. Coded, the meta is about 548 B and the blocks
  12,280 B: the binary-able part was never the JSON.
- **Spine meshes:** `mesh_u8` 39 KB raw and 10.0 KB coded, plus their entries (24.8 KB raw,
  0.2 KB coded) and their custom AABBs (`mesh_f32`, inside "other blocks": 2.5 KB raw, 1.3 KB
  coded; spine sets a new AABB every frame).
- **Multimesh** (PM1/PM2's `CPUParticles2D`): 3.7 KB of `mm_f32` and 5.7 KB of entries raw,
  0.8 KB coded. PM2's 3.7 KB "multimesh" figure was the raw floats.
- **GPU particles (/12): nothing warm.** Particle entries appear in 1 of 2,713 warm combat
  transactions and none of the menu's or the map's, and `particle_emits` in none: the emitters
  hold still and the receivers simulate. A moving emitter would cost a 124-byte float group a frame.
- **The menu** is spine poses (`mesh_u8` 4.2 KB raw) and their entries (7.8 KB raw), plus cold
  records: one resource record every three frames (904 B raw, 324 coded).

## /13 codings (whole message, warm, per frame)

| coding | menu raw | menu coded | map raw | map coded | combat raw | combat per message | **combat coded** | combat p95 | Mbps (combat) |
| ------ | -------: | ---------: | ------: | --------: | ---------: | -----------------: | ---------------: | ---------: | ------------: |
| /12 JSON as recorded | 16,978 | 1,120 | 10,489 | 324 | 88,154 | 33,356 | **13,311** | 13,606 | 6.39 |
| `bin`: binary structure, blocks raw | 6,745 | 1,045 | 3,975 | 332 | 52,742 | 31,131 | **12,946** | 13,198 | 6.21 |
| `bin_xor`: + XOR (WB), in place | 6,745 | 823 | 3,975 | 283 | 52,742 | 11,670 | **10,216** | 10,477 | 4.90 |
| `bin_xor_soa`: + streams, transposed | 6,745 | 747 | 3,975 | 318 | 52,742 | 10,492 | **9,007** | 9,361 | 4.32 |
| `bin_sub_soa`: u32 subtraction | 6,745 | 583 | 3,975 | 300 | 52,742 | 10,446 | **7,356** | 8,699 | 3.53 |
| `bin_zz_soa`: order-preserving, zigzag | 6,745 | 577 | 3,975 | 295 | 52,742 | 9,903 | **7,294** | 8,447 | 3.50 |
| `bin_p2_soa`: second order, all float blocks | 6,745 | 510 | 3,975 | 295 | 52,742 | 7,717 | **6,190** | 7,620 | 2.97 |
| `json_w13`: /12 JSON meta, /13 blocks | 16,978 | 591 | 10,489 | 324 | 88,154 | 9,929 | **6,412** | 7,808 | 3.08 |
| **`w13`: /13 as designed** | 6,745 | 510 | 3,975 | 332 | 52,742 | 7,952 | **6,171** | 7,599 | 2.96 |

Coded columns are per transaction without resource records (menu: + 324 B of records coded). The `bin_*` rows come from the exploration run (`wbd-pm7-explore.json`); `json`, `json_w13` and `w13` from the design run. Both runs agree on `json` and `bin_p2_soa` to the byte.

- **Structure.** `bin` against `json`: the binary structure alone saves 40–62 % raw but only
  240 B coded in combat, and loses 8 B on the map. Base-prefix zstd had already
  removed what a schema removes. Where it matters is uncoded bytes (`GRC_LIVE_CODING=off`, file
  recordings) and the host's formatting.
- **Prediction** is the whole coded win: `bin` → `bin_p2_soa` is 12.9 → 6.2 KB in combat. Each
  step counts: XOR 10.2, regrouping and transposing 9.0, integer subtraction 7.4, zigzag on
  order-preserving integers 7.3, second order 6.2 KB.
- **Item and command floats** are better left alone: predicting them (`bin_p2_soa` against `w13`)
  costs combat 20 B and saves the map 37 B, noise either way. Base-prefix zstd finds them in the
  base.
- **The prefix still pays** on top of prediction: /13 combat per message 7,952 B against
  6,171 B with the base as prefix. It finds the structure and the unpredicted floats.

/13 coded by part (`w13`, combat, each part against the base's same part):

| part | raw | coded |
| ---- | --: | ----: |
| structure | 3,884 | 178 |
| mesh_u8 | 39,021 | 4,328 |
| mesh_f32 | 2,484 | 859 |
| mm_f32 | 3,712 | 458 |
| cmd_f32 | 3,006 | 153 |
| item_f32 | 602 | 125 |
| param_f64 | 12 | 18 |
| pt_f32 | 0 | 0 |

## Quantized positions (lossy, not in /13)

| position step | combat coded | Mbps | menu coded | max screen error |
| ------------- | -----------: | ---: | ---------: | ---------------: |
| lossless (`w13`) | 6,171 | 2.96 | 510 | 0 |
| 1/256 local unit | 3,551 | 1.71 | 464 | 0.0014 px |
| 1/64 local unit | 3,206 | 1.54 | 458 | 0.0056 px |
| 1/16 local unit | 2,984 | 1.43 | 454 | 0.0225 px |

The largest drawn scale of any spine mesh in the recording is 0.51, so a local step of 1/64
is at most 0.0056 px on screen, about one step of a GPU's 1/256 px (0.0039 px) subpixel grid. But
no step makes the stream pixel-identical (render-stream-13.md, "What stays lossless"): any shift
can flip a subpixel snap or a pixel-centre tie. The 2× (lossless 2.96 against
1.54 Mbps) is not needed against video, so the tier is designed as an opt-in and not
built.

## Receivers' JSON-parse share (native, /12)

rs-core, `pm7-a12-1`, warm patches, median µs per transaction:

| scene | record bytes | core total | `meta` (parse + schema) | share |
| ----- | -----------: | ---------: | ----------------------: | ----: |
| menu | 14,896 | 86.2 | 5.6 | 6.5 % |
| map | 10,342 | 123.2 | 4.1 | 3.3 % |
| combat | 87,453 | 321.8 | 16.4 | **5.1 %** |

WB measured 35 % (306 µs of 871) on /10 combat. Two things changed: /11's lean rules removed
about 70 % of the meta (stable `content_version`, patched `unsupported`), and a transaction now
takes `meta/fast.rs`, a schema-directed reader that matches canonical JSON literally into
`TxMeta`. The core's combat time is now apply (212 µs: dependency 57, walk 42, resolve 38,
payload decode of the bodies 32, lower 30). So the binary structure is not a receiver speed-up;
W13c measures the /13 reader. The wasm leg (GSW's core) was not re-run: WB's wasm/native ratio
was 1.5 for `meta`, which puts it near 25 µs.

## Host

| per warm combat frame | /12 | /13 (`w13`) |
| --------------------- | --: | ----------: |
| zstd-3 base prefix, measured (Python binding of C zstd 1.5.7) | 291 µs | 90 µs |
| message zstd compresses | 88,154 B | 52,742 B |
| meta encode (C++), MX | 0.09 ms | projected lower (binary writes, no number formatting) |
| prediction + XXH64 | — | projected 0.02–0.05 ms |

Formation (diff, encode, prediction, zstd) is a function of (T−2, T−1, T) and belongs on HC5's
encode thread. /13 adds no main-thread work beyond keeping a reference to T−2's published state.

## Validation

- **Docs and one tool.** The diff is `protocol/render-stream-13.md`, this file,
  `scripts/lib/wire-budget.py` (the `proto13` subcommand) and its self-test.
- `bash scripts/test/self-test-wire-budget.sh`: 49 checks pass under mise's Python 3.14,
  10 of them new: the numeric modes invert exactly on edge patterns (NaN, ±0, sign
  boundaries); a dynamic mesh round-trips raw, first and second order; second-order residuals of a
  constant-velocity pose are zero; `proto13` round-trips all 75 warm patches of the synthetic
  recording; the categories sum to the record.
- `run-pure-self-tests.sh --only self-test-wire-budget`: pass.
- On `pm7-a12-1`: 4,854 warm transactions decoded back under every lossless coding, zero
  differences; the categories sum to each record exactly.
- No game launch, no validation tier (docs and an offline tool; the smoke-map rule for
  `wire-budget.py` maps it to its pure self-test).

## Deviations

- **Prototype, not codec.** The bytes are the Python prototype's. The schema is learned, not
  written, and enum widths are the recording's (at most one byte here). A real schema table
  could only be equal or smaller (no shape ids where /12 has one shape).
- **The predictor's history** in the prototype is "the mesh's last two sent bodies". The design
  says "the resolved values at T−1 and T−2". In this patch recording every dynamic combat mesh
  changes every frame, so the two coincide; on a mesh that pauses, the design predicts zero motion
  where the prototype extrapolates the last motion.
- **Multimesh AABB floats** are not predicted in the prototype, only the buffers.
- **No wasm parse leg** (above), no g31 leg: the g31 is out of scope (memory
  `g31-good-enough-release-first`).
- **One recording.** STS2 only, as WB and TW.

## Evidence

In the main checkout's ignored `artifacts/render-stream/p3/wb-d/`:

- `wbd-pm7.json`: the `w13` run (every table above, `render-stream-wire-budget/1#proto13`);
- `wbd-pm7-explore.json`: the coding exploration (`bin` … `bin_q64p2`);
- `wbd-attr.json`: `mesh_u8` coded by part under `bin_xor` and `bin_zz_soa` (the design's table);
- `prof-native.jsonl`, `prof-share.txt`, `prof-load.txt`: the parse share;
- `records-coded.txt`: the resource records coded per message.

Re-run:

```
mise exec -- python3 experiments/render-stream/scripts/lib/wire-budget.py proto13 \
  --recording artifacts/render-stream/p3/fidelity-data/pm7-a12-1/capture/recording-patch.rs12 \
  --scene menu:17-1498 --scene map:1503-2249 --scene combat:2258-99999 \
  --codings bin,bin_p2_soa,w13,json_w13,w13_q16,w13_q64,w13_q256 --out wbd-pm7.json
```
