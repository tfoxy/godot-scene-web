# BIN-D: the binary transaction syntax and the compact residual for /13 (2026-10-30)

BIN-D decides two possible /13 wire changes before the freeze:

- the deferred **binary transaction syntax** (render-stream-13.md "Binary transaction record",
  "The syntax");
- a **compact residual**, which W13z and W13f named as the wire lever for /13's zstd cost.

It is measured on today's /13 wire: W13a's predicted blocks under /12's JSON meta, coded with
W11t's base-prefix zstd.

## Decision

**Build only the compact residual, as /13 before the freeze (increment W13r). Don't build the
binary syntax.**

| warm combat, `pm7-a12-1`, per frame | /13 today | + compact residual | + binary syntax | both |
| --- | --: | --: | --: | --: |
| coded B (Mbps) | 6,422 (3.08) | 6,242 (3.00) | 6,179 (2.97) | 6,072 (2.91) |
| zstd's input (raw B) | 88,189 | 49,842 | 52,754 | 14,405 |
| host zstd encode, µs (bench) | 98.0 | 69.3 | 70.1 | 44.9 |
| receiver ruzstd decode, µs (native) | 132.8 | **69.5** | 119.1 | 61.8 |
| g31 decode, ms (estimated) | ~1.75 | **~0.92** | ~1.57 | ~0.82 |

- **The compact residual pays at both ends for a small, layout-free codec.** Zero runs in the three
  predicted blocks take zstd's combat input from 88 KB to 50 KB.
  - rs-core's ruzstd decode drops by half, from 133 to 70 µs natively. That is about −0.8 ms a
    combat message on the g31, on the path from a message arriving to the transaction being
    applied.
  - The host's zstd drops by 29 µs a combat frame on the encode thread. The run scan costs 16 µs
    as a naive byte loop and should cost about 4 µs fused into the predictor's plane writes.
  - The wire drops 180 B a combat frame (−2.8 %).
  - It also undoes a /13 regression: ruzstd decodes today's /13 *slower* than /12 (133 against
    109 µs), and the compact residual takes it 36 % below /12.
  - The cost is one token format (about 20 lines in each of four implementations), one length
    rule for three blocks, regenerated golden-13 vectors and two error codes. The meta stays JSON.
- **The binary syntax buys too little to freeze it.** On top of the compact residual it adds:
  - −170 B a combat frame (−2.7 %), against video's 15–25 Mbps;
  - −24 µs of host zstd, plus at most ~60 µs of JSON formatting (projected from MX's 0.09 ms
    `encode`), on HC5's encode thread, not the game's main thread;
  - −8 µs of native ruzstd, plus about −15 µs of wasm meta parse (21.9 µs today), so about
    −0.25 ms a combat message on a g31 that is GPU-bound with its main thread 40 % idle.

  In exchange it would freeze a schema of every key of every object type into four
  implementations (Python reference, C++, rs-core, TypeScript), plus `schema.json`, five
  `binary-*` codes and their goldens. It would also lose `jq` on every recording. The formatting
  half of its host saving can be had capture-only, with no wire change: the warm combat meta is
  39 KB raw but 356 B coded against the previous frame's, so it is almost all repeated text. The
  syntax stays available to a later version, if a game whose coded bytes are structure rather than
  mesh bodies ever shows it paying.

Neither change matters for bandwidth. /13 combat is already 3.1 Mbps against video's 15–25 (the
live seat measured 3.49). The decision is made on CPU and latency at both ends, and on
maintenance.

## Method

- **Wire.** A /13 recording of `pm7-a12-1`, made by `rs-core-check transcode --to 13` from
  `artifacts/render-stream/p3/fidelity-data/pm7-a12-1/capture/recording-patch.rs12`. Its sha256
  is `6870b1d3…`, the same file as W13p's. W13p showed the C++ writer's typed coding equals this
  transcode on all 4,955 transactions, so these are the bytes the capture sends.
  - Scenes and warm patches are WB-D's: menu 17–1498, map 1503–2249, combat 2258–5000, 30 frames
    into a scene. That gives 1,425, 716 and 2,713 patches.
- **Tool.** `wire-budget.py bin13` (new). For every warm patch it builds four variants:
  - `j13`: the /13 record as recorded;
  - `j13_zr`: the same with the compact residual;
  - `b13`: the binary syntax, using WB-D's learned `Schema13` structure, with `predict_check` as
    8 bytes and blocks in the design's fixed order, each `uvarint len` + payload;
  - `b13_zr`: both.

  `j12` is the /12 record, read in step with the /13 file.
  - Each variant is coded as W11t codes it: zstd-3 with the previous message of the same variant
    as a raw prefix, plus 24 B envelope, 4 B checksum and the WebSocket header.
  - Its meta and its blocks are also coded alone, each against the previous one.
  - **Proof.** Every variant of all 4,854 warm patches decoded back: 0 failures.
    - The structure decodes to the record's canonical meta bytes.
    - The zero runs decode to the plain blocks.
    - The canonical JSON is rebuilt byte for byte from the parsed meta.
- **The compact residual measured** (`zr`). Each of `mesh_f32`, `mesh_u8` and `mm_f32` becomes
  tokens `uvarint zeros, uvarint n, n literal bytes`, repeated until the plain length (the
  descriptor's `count` × width) is covered.
  - Zero runs shorter than 4 bytes stay literal.
  - It needs no layout, so the empty high byte planes of the transposed residual go whole.
  - Minimum runs of 8 and 16 coded 18 and 37 B worse in combat, so 4 it is.
- **CPU.** `--dump` writes 300 consecutive warm patches a scene, plus the first one's base, for
  each variant.
  - **zstd**: `bin13-bench.c` (new), built on the capture's vendored zstd 1.5.7 with its flags
    (`-O2`, no asm). It uses `rs_live_coding.cpp`'s settings: level 3, checksum, content size, the
    previous message as `refPrefix`, a reused context.
  - **ruzstd**: rs-core's own `coding::LiveDecoder`, through `examples/coded_decode.rs` (new) on
    the same messages in W11t's envelope, with every output compared with the plain message.
  - Each figure is the per-message minimum over 7–9 repeats, then the p50 over messages.
  - Runs were under `quiet.sh exclusive` on this desktop (Ryzen 5 5500). The 1-minute load was
    4.7–9.3 from other repositories' work, which the lock cannot see. Two runs of the zstd bench
    agree within 1–4 %.
- **Receiver parse.** W13p's wasm profile of this recording (`profile-rs-core-wasm.mjs`,
  `artifacts/render-stream/p3/w13p/receivers/prof-after/`), split by scene. The receiver has not
  changed since, apart from TAG1's records, which these transactions do not carry.
- **The g31 and the weak host are estimated, not run.**
  - g31 = native ruzstd × 1.2 (W11t's wasm/native ratio, 0.12 / 0.10 ms) × 11 (G7x: wasm on the
    g31 against desktop), so about 13× native.
  - Wasm figures × 11.
  - The i5-6200U: about 2× this desktop's time per frame, which is not measured.

## Bytes (coded, per warm patch, mean)

| scene | /12 | **/13 today** | + compact residual | + binary syntax | both |
| --- | --: | --: | --: | --: | --: |
| menu | 1,120 | **610** | 616 (+6) | 522 (−88) | 512 (−99) |
| map | 325 | **324** | 324 (0) | 331 (+7) | 331 (+7) |
| combat | 13,311 | **6,422** | 6,242 (−180) | 6,179 (−244) | 6,072 (−351) |
| combat p95 | 13,600 | 7,798 | 7,698 | 7,603 | 7,544 |
| combat Mbps (60/s) | 6.39 | 3.08 | 3.00 | 2.97 | 2.91 |

- The projection held. Today's /13 combat (6,422) is WB-D's `json_w13` (6,412) within 0.2 %. The
  binary syntax's −244 B is WB-D's −240.
- Menu resource records (one every three frames, 904 B raw) are left out, as in WB-D.

**Meta against predicted blocks.** Each is coded alone, against the previous message's same part:

| per warm patch | menu | map | combat |
| --- | --: | --: | --: |
| JSON meta, raw / coded | 11,593 / 331 | 7,125 / 58 | 39,303 / **356** |
| binary structure, raw / coded | 1,366 / 228 | 618 / 41 | 3,892 / **189** |
| blocks, raw / coded | 5,372 / 271 | 3,351 / 291 | 48,838 / **5,856** |
| predicted blocks (`mesh_u8` + `mesh_f32` + `mm_f32`), raw / coded | 5,105 / 280 | 0 / 0 | 45,218 / **5,645** |
| the same as zero runs, raw / coded | 370 / 260 | 0 / 0 | 6,870 / **5,526** |

- Combat's coded frame is 91 % blocks (88 % the predicted ones; `mesh_u8` alone is 4,328 B) and
  5.5 % JSON meta.
  The binary syntax can only touch the 356 B.
- Zero runs cut the predicted blocks' raw bytes 6.6× (45 KB to 6.9 KB) but their coded bytes
  only 2 %. zstd already codes zero runs in a few bytes, so the gain is CPU, not wire.
- The map carries no mesh bodies, so the compact residual does nothing there. The binary
  structure codes 7 B *worse* than the JSON: base-prefix zstd had already removed the keys.

## CPU

Combat, desktop, p50 per message (µs):

| | /12 | /13 today | + compact residual | + binary syntax | both |
| --- | --: | --: | --: | --: | --: |
| host: zstd-3 encode (capture's zstd) | 180.5 | **98.0** | 69.3 | 70.1 | 44.9 |
| host: zero-run scan, C (naive byte loop) | | | +16.0 | | +16.0 |
| receiver: ruzstd decode (rs-core, native) | 109.0 | **132.8** | 69.5 | 119.1 | 61.8 |
| receiver: zero-run expand, C | | | +2.3 | | +2.3 |
| receiver: C zstd decode (reference) | 27.1 | 20.8 | 13.7 | 16.9 | 10.5 |
| receiver: meta parse (wasm, W13p) | 21.3 | 21.9 | 21.9 | ~5–10 (projected) | ~5–10 |

Menu: host zstd 23.7 → 18.4 / 15.6 / 11.3 / 8.4 µs; ruzstd 33.1 → 41.0 / 34.2 / 38.6 / 31.7 µs. Map:
no change from the compact residual; the binary syntax 11.8 → 7.7 µs host. The zero-run scan
costs 1.7 µs and its expand 0.2 µs in the menu.

**On the host** (HC5's encode thread, never the game's main thread):

- The compact residual nets −13 µs a combat frame with the naive scan. It nets about −25 µs once
  the scan is fused into `code_words`, which already writes every residual byte plane.
- The binary syntax on top saves zstd's 24 µs, and the JSON formatting is a projected ≤ 60 µs
  (MX: `encode` 0.09 ms, JSON and blocks).
- In the game, W13f measured /13's zstd at 0.79–1.41 M cycles a combat frame, against this warm
  bench's ~0.41 M, so 2–3.4×. It also saw /12 → /13 save 10–15 % live where this bench saves
  46 %, so in-game savings are smaller than these ratios suggest.
- On the user's i5-6200U running four instances, the binary syntax's share would be a few tenths
  of a millisecond a frame per instance, on a thread that is not the frame callback.

**On the receiver:**

- ruzstd decodes the transposed residual's long zero runs slower than /12's raw floats. Today's
  /13 costs 24 µs more than /12 natively, about +0.3 ms a combat message on the g31.
- The compact residual removes them before zstd sees them: 133 → 70 µs, about 1.75 → 0.92 ms on
  the g31.
- The g31 is GPU-bound in combat (PHV: 38 applies/s, main thread 40 % idle), so this is latency,
  not rate.
  - PHV's `received` → `applied` was 5.0 ms at p50 in combat at /12, so −0.8 ms is about a sixth
    of it.
  - `onmessage` p50 was 9.7 ms.
- The binary syntax's receiver share is the wasm meta parse: 21.9 µs of a 243 µs combat accept,
  about 0.24 ms on the g31, of which a binary reader would save perhaps two thirds.

## Judged on the user's criteria

- **Wire after zstd.** Both changes together are −5.5 % in combat (3.08 → 2.91 Mbps, or the
  seat's 3.49 → ~3.3), against video's 15–25 Mbps. Not a reason for either.
- **Host on a weak machine.**
  - The compact residual: −0.03 to −0.08 ms a combat frame in the game.
  - The binary syntax: up to ~0.1 ms a frame in the bench more, the larger part of it formatting
    that a capture-only change can also remove.
  - Both are on the encode thread.
- **Receiver on the g31.**
  - The compact residual: about −0.8 ms a combat message.
  - The binary syntax: about −0.25 ms more.
  - Both are latency only, since the phone's rate is bound by drawing.
- **Latency.** The compact residual is the only one of the two with a visible share (a sixth of
  the phone's receive-to-apply time). The host-side changes are tens of µs against a 16.7 ms
  frame.
- **Maintenance.**
  - The compact residual is one token format, layout-free, under the existing predictor.
  - The binary syntax is a second syntax for the whole object model. Frozen, it doubles the cost
    of every later key change, across four implementations.
- **Debuggability.** The compact residual keeps the meta in JSON: a recording stays `jq`-readable,
  and its blocks were already coded at W13a. The binary syntax needs `transcode` to read any
  recording.

## Validation

- `bash scripts/test/self-test-wire-budget.sh`: 52 checks pass under mise's Python 3.14, 3 of them
  new:
  - the zero runs invert on edge buffers at minimum runs 1, 4 and 16;
  - a 3-byte run stays literal and a 4-byte run goes;
  - `predict_check` takes 8 bytes in the structure and decodes back.
- `wire-budget.py bin13` on `pm7-a12-1`: 4,854 warm patches, every variant decoded back,
  0 failures.
- `bin13-bench.c` checks every zstd round trip byte for byte. Its zero-run coder agrees with the
  Python one to within the token overhead of coding the three blocks as one buffer (−1,452 B over
  300 combat patches, about 5 B a patch).
- `examples/coded_decode.rs` compares every ruzstd output with the plain message.
- `validate-increment.sh --tier full`: the plan reaches `pure` and `cargo-rs-core` only.
  - The new `smoke-map.json` rule puts `rs-core/examples/**` on the crate alone (no receiver links
    an example).
  - `bin13-bench.c` joins the `wire-budget.py` rule.
- No game launch, no timing leg, no receiver change.

## Deviations

- **No wasm or phone leg.** The g31 figures scale native ruzstd by W11t's and G7x's ratios. The
  wasm meta parse is W13p's profile, not re-run.
- **The binary syntax's formatting saving is projected** from MX's `encode` phase, as WB-D did.
  The C++ JSON writer was not timed alone.
- **The compact residual's host cost is a C byte loop**, not the capture's writer. The fused
  figure (~4 µs) is an estimate.
- **One recording**, STS2, as WB-D.

## Evidence

In the main checkout's ignored `artifacts/render-stream/p3/bin-d/`:

- `bind-pm7.json`: the `bin13` run (every byte table above, minimum run 4);
- `bind-pm7-zr8.json`, `bind-pm7-zr16.json`: minimum runs 8 and 16;
- `bench1.txt`, `bench2.txt`: zstd and zero-run CPU;
- `bench3.txt`: ruzstd decode;
- `wasm-meta.txt`: W13p's wasm phases by scene.

Re-run (the dumps are 140 MB, not kept):

```
rs-core-check transcode --to 13 <pm7 recording-patch.rs12> pm7.rs13
mise exec -- python3 experiments/render-stream/scripts/lib/wire-budget.py bin13 --recording pm7.rs13 \
  --plain <pm7 recording-patch.rs12> --scene menu:17-1498 --scene map:1503-2249 \
  --scene combat:2258-99999 --dump dump --out bind-pm7.json
bin13-bench zstd dump/<variant>-combat.msgs 9
bin13-bench zr dump/pred-combat.msgs dump/pred_zr-combat.msgs 4 7
bin13-bench frames dump/<variant>-combat.msgs <variant>.frames
cargo run --release --example coded_decode -- <variant>.frames dump/<variant>-combat.msgs 7
```
