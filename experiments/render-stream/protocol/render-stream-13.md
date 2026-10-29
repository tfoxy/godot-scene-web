# render-stream/13 wire format (design)

Status: **staged.** W13a (2026-10-29) built the predicted blocks under /12's JSON meta at the wire
level (codecs, goldens, validators); "As built (W13a)" is the normative spec of what is built. The
binary transaction syntax below is **deferred** ("Staging"). The rest of this text is WB-D's design
(2026-10-29). The measurements behind every number are
in [results/p3/wb-d.md](../results/p3/wb-d.md), made with `scripts/lib/wire-budget.py proto13`, a
Python prototype of this encoding that decodes every lossless message back to the recording.
/13 builds on render-stream/12 ([render-stream-12.md](render-stream-12.md)). Like /8 to /12 it is
**opt-in** until its acceptance increment (W13z) passes. It is meant to be the format that freezes
("Versioning").

## Staging

The orchestrator staged /13 after WB-D (2026-10-29): **W13a builds prediction only, under /12's
existing JSON meta.** Prediction is the measured win (combat 13,311 → 6,412 B a frame coded with
the JSON meta, 97 % of the full design's 6,171). The binary schema-driven transaction body
("Binary transaction record", "The syntax", `schema.json`, the `binary-*` error codes) is deferred
to a later, separate increment that is judged on its own merit (about 240 B a combat frame coded,
the host's JSON formatting, three more writers and readers) before /13 freezes. Until then the
sections that describe it are design text, not wire: where they and "As built (W13a)" disagree,
"As built (W13a)" is the wire. If the binary body lands, it is a further change to /13 made before
the freeze (W13z), not a new version, since no /13 stream is offered by default until then.

## Why

WB ([results/p3/wb.md](../results/p3/wb.md)) left one item for "the final binary-structure swap":
mesh bodies coded against the previous pose, and a binary structure in place of canonical JSON. WB-D
measured both on the newest STS2 recording, `pm7-a12-1` (/12, with multimesh and GPU particles),
through W11t's base-prefix zstd-3. Warm combat, per frame:

| | raw | coded (W11t) | Mbps coded |
| - | -: | -: | -: |
| /12 as recorded | 88,154 | 13,311 | 6.39 |
| /12 with JSON meta, /13's predicted blocks | 88,154 | 6,412 | 3.08 |
| **/13 (binary structure + predicted blocks)** | **52,742** | **6,171** | **2.96** |
| 1080p60 video (the user's baseline) | | 31,000–52,000 | 15–25 |

Three facts shape the design:

- **The coded bytes are mesh bodies.** /12 combat codes to 13.3 KB, and 10.0 KB of it is
  `mesh_u8` (spine poses, coded alone against the base's block). The JSON meta is 39.3 KB raw but
  about 0.5 KB coded: base-prefix zstd already removes the key names and the repeated entries.
- **Prediction, not quantization, is the lossless lever.** A spine vertex moves smoothly, but its
  float32 mantissa differs from the base's in every bit below the motion. XOR (WB's proposal)
  leaves that noise; subtracting order-preserving integers and predicting from the two previous
  poses (constant velocity) cuts `mesh_u8` from 10.0 KB to 4,328 coded, with every bit
  of every float preserved.
- **JSON parsing is no longer a receiver cost.** rs-core's schema-directed fast path
  (`meta/fast.rs`) parses a /12 combat meta in 16 µs natively, 5 % of the core's 322 µs per
  transaction (WB measured 35 % at /10, before the lean rules). The binary structure is worth
  its raw bytes (39,267 → 3,884 B of structure in combat), the host's JSON
  formatting and zstd time (129 → 90 µs a combat frame), and about 240 B a frame coded, not
  parse time.

## What /13 is

**render-stream/13 is render-stream/12 plus exactly:**

1. a new magic (`GRSD`), protocol string (`render-stream/13`), subprotocol (`render-stream.13`)
   and file extension (`.rs13`);
2. **binary transaction records**: a transaction's meta is the binary syntax below of /12's
   transaction object, not canonical JSON ("Binary transaction record");
3. **predicted blocks**: `mesh_u8`, `mesh_f32` and `mm_f32` travel as residuals against the
   stream's two previous transactions ("Predicted blocks");
4. a **reconstruction check** in every binary transaction (XXH64 of the three blocks as /12 would
   carry them) and its error code `predict-check`.

Everything else is /12's, and that is the design's main property: **/13 is a second syntax for
/12's model, not a new model.**

- The object model is /12's: every key, key order, value, nullability, optional key and invariant.
  A /13 transaction decodes to the exact /12 meta object and the exact /12 block bytes, and then
  /12's validator, resolver, decoded and resolved forms, applier and planner run unchanged.
- Session, resource and end records, and every control message (hello, credit, resync, error),
  stay canonical JSON. They are one per stream, or cold, and readable JSON keeps the handshake
  debuggable.
- Framing, the record sha256 (over the /13 record's own bytes), the carried-set rules, dynamic
  meshes, multimesh, particles, out-of-band delivery, HTTP routes, the hello (under `protocol`
  `"render-stream/13"`) and W11t's live coding are /12's.
- Like /3 to /12 (memory `g4e1-rs3-version-switch-pattern`) /13 is not a forked module:
  `ProtocolVersion::V13`, TypeScript `version` widens to `2..=13`, the Rust `version: u8`
  likewise. The binary syntax is a parse/write layer under the existing decoders.

Nothing in /13 is lossy. Every float the capture hooked reaches every receiver bit for bit, as at
/12 ("What stays lossless, and the quantized tier it does not include").

## File layout

```
magic        8 bytes   47 52 53 44 0D 0A 1A 0A   ("GRSD\r\n\x1a\n")
```

then as /12. Byte 3 is the version as one uppercase hex digit: `D` is 13. A /13 decoder refuses
`GRSC`, and a /12 decoder refuses `GRSD`, both with `bad-magic`. Recording files use `.rs13`.

## Binary transaction record (deferred)

*Deferred by "Staging": not built at W13a. A /13 transaction keeps /12's JSON meta and framing.*

```
u32le   record_len          as /0: bytes after this field
u32le   meta_len = 0        a binary transaction (a JSON meta is never empty, so 0 is free)
bytes   body                the transaction object in the binary syntax (below)
u64le   check               XXH64 (seed 0) of /12's mesh_f32 ‖ mesh_u8 ‖ mm_f32 bytes
repeat 10 times, in /12's block order (item_f32, canvas_f32, cmd_f32, cmd_i32, mesh_f32,
param_f64, backbuffer_f32, mesh_u8, mm_f32, pt_f32):
  uvarint byte_len
  bytes   payload           /12's bytes, or the predicted residuals for the three blocks
```

- `record_len` is checked exactly (`record-length`, `truncated`), as /0. A byte after the tenth
  block is `binary-trailing`.
- **No block descriptors.** Each block's type is fixed and its count is `byte_len` divided by the
  type's width (`block-length` when it does not divide). A residual block has its plain block's
  length. The decoded form rebuilds /12's `blocks` array: all nine of /11's, and `pt_f32` only
  when its count is non-zero (/12's rule).
- A session, resource or end record keeps /0's framing with a JSON meta. A transaction with a JSON
  meta at /13 is `meta-schema`; a binary body in any other record is `meta-json`.

### The syntax (deferred)

The body is the /12 transaction object, written field by field in /12's key order with no key
names. Each field's type comes from the **schema table** (below), so no value carries a tag.

| model value | binary |
| ----------- | ------ |
| integer, never negative (ids, `seq`, `frame`, versions, counts, offsets, digests) | `uvarint` (LEB128, minimal) |
| integer that may be negative (`z_index`, `draw_index`, `visible` -1, `count` -1) | zigzag `uvarint` |
| boolean | one byte, 0 or 1 |
| enum string (`origin`, `status`, `reason`, `op`, `primitive`, `kind`, `texture_filter`, ...) | `uvarint` index into the field's spelling list, in the order the spec lists them |
| 64-hex hash | 32 bytes |
| free text (`failures[].detail`, `unsupported` names outside the op list) | `uvarint` length, then the bytes (printable ASCII) |
| nullable integer | `uvarint` of value + 1 (zigzag + 1 if signed); 0 is `null` |
| any other nullable value | one presence byte (0 = `null`, 1 = present), then the value |
| array | `uvarint` count, then the elements |
| object | its fields in key order |
| a command | `uvarint` op code (the `op` spelling list), then that op's fields in its key order |
| /12's optional keys (`multimeshes`, `removed_multimeshes`, `particles`, `removed_particles`, `particle_emits`) | an array; count 0 means absent (/12 forbids them empty) |
| an optional object key (`shader_time`) | presence byte |

- **The schema table is normative and single-sourced.** W13a writes it as
  `golden-13/schema.json`: for every object type, its keys in order with their types and spelling
  lists, taken from /12's key-order rules (render-stream-0.md to -12.md, and rs-core's
  `check_transaction` / `meta/fast.rs`, which already encode them). `make_golden.py`, the C++
  writer, the TypeScript decoder and rs-core each test that their table equals the file.
- **Canonical.** Each model value has exactly one encoding: minimal LEB128, booleans and presence
  bytes 0 or 1, enum indices in range, no bytes left over. A decoder rejects anything else with
  `binary-noncanonical` (the binary twin of `meta-noncanonical`), so "decode, then encode, equals
  the input" holds and two encoders cannot disagree silently.
- **Offsets stay explicit.** `f`, `i`, `u8`, `aabb_f` and `buffer_f` are written, not derived, so
  the model, the offset invariants and their invalid vectors stay /12's. They cost about 1 B
  each before zstd and almost nothing after it.
- **Errors.** Syntax: `binary-truncated`, `binary-noncanonical`, `binary-enum` (index out of
  range), `binary-text` (a non-printable byte), `binary-trailing`. Once the body parses, every
  /12 rule runs on the decoded model with its /12 code (`meta-schema` for a value the model
  forbids, `cmd-offset`, `mesh-u8-offset`, ...).
- Measured: the structure is 3,884 B in warm combat against /12's 39,267 B of
  meta, 1,358 against 11,558 in the menu and 610 against 7,090
  on the map.

## Predicted blocks

Three blocks carry per-frame geometry that moves a little each frame: dynamic mesh bodies
(`mesh_u8`), each listed mesh's custom AABB (`mesh_f32`, which STS2's spine sets every frame) and
multimesh instance buffers (`mm_f32`). /13 sends each as a residual against a prediction from the
**two previous transactions of the stream**, T−1 and T−2.

- **T−1 and T−2** are the transactions before T in the stream's record order: on a live
  connection, the last two formed (W11t rule 5: T−1 is T's base); in a file, the previous two
  transaction records. Every receiver accepts every transaction (render-stream-11.md L1), so it
  holds the same two resolved states the host formed against, whatever it then folds, coalesces
  or skips at apply. A full transaction resets the history: it is never predicted, and the next
  patch predicts from it to first order.
- **Which values are predicted.** A predicted unit is:
  - a dynamic surface's body, when T carries it (`u8` non-null) and the resolved mesh at T−1 was
    dynamic with the same surface count and the same `primitive`, `format`, `vertex_count` and
    `index_count` on every surface;
  - a mesh entry's six `mesh_f32` floats, when the entry was in the resolved table at T−1 with a
    non-null `f`;
  - a multimesh entry's buffer (at `buffer_f`), when the resolved entry at T−1 had a buffer of the
    same `instances` and stride.

  Anything else is a raw unit: predicted from zero, so it travels as itself. The rule needs no
  flag: both ends evaluate it on state they share.
- **The predictor**, per 32-bit float word, on order-preserving integers
  (`ord(u) = u ^ 0x80000000` if the sign bit is clear, `~u` otherwise, a bijection on all 2^32
  patterns, NaNs and signed zeros included):

  ```
  P = 2·ord(v[T−1]) − ord(v[T−2])    when the unit is predictable at T−1 and at T−2
  P = ord(v[T−1])                     when only at T−1
  P = 0                               otherwise
  r = zigzag32(ord(v[T]) − P)         all mod 2^32
  ```

  Byte data inside a body (colours, skin, indices) is XORed with the T−1 body instead, or sent
  as is. Every operation is integer arithmetic mod 2^32, so C++, Rust and wasm reproduce it bit
  for bit.
- **Layout.** `mesh_u8`'s residuals are regrouped into six streams over all carried surfaces, in
  entry and surface order: the 40-byte geometry headers' words, positions, colours, UVs, skin,
  indices. Each word stream is byte-plane transposed (byte 0 of every word, then byte 1, …), which
  puts the zero high bytes of small residuals side by side for zstd. `mesh_f32` and `mm_f32` keep
  their layout, residuals in place of predicted words, and are transposed whole.
- **Not predicted:** `item_f32`, `cmd_f32` and the other blocks. Measured: base-prefix zstd already
  finds them in the base message; predicting them cost combat 20 B and saved the map 37 B (noise
  either way).
- **The check.** `check` is the XXH64 of the three blocks as /12 would carry them. A receiver that
  reconstructs a different block (a missed full, a wrong history, a host bug) fails `predict-check`
  before it applies anything, and resyncs with reason `coding` as W11t does. Without it a wrong
  prediction would draw garbage geometry with a valid message checksum. rs-core already has
  XXH64 (W11t); the cost is about 5 µs for combat's 45 KB.

Measured on warm combat, `mesh_u8` coded alone against the base's block:

| coding of `mesh_u8` | bytes / frame |
| ------------------- | ------------: |
| /12, base-prefix zstd | 9,954 |
| XOR with the base body (WB), in place | 7,656 |
| first order on order-preserving integers, streams, transposed | 5,252 |
| **second-order prediction, streams, transposed (/13)** | **4,328** |
| the same with positions quantized to 1/64 local unit (not in /13) | 1,268 |

## Interactions

- **W11t's live coding.** Unchanged: a /13 message is coded with zstd-3 against its base's
  uncoded /13 message as a raw prefix, in W11t's envelope. Prediction and the prefix are
  complementary: the prefix still finds the structure and the unpredicted floats in the base.
  Measured on combat: /13 per message 7,952 B, base-prefix 6,171 B.
- **Shared encodes (P3-SP).** A /12 coded transaction is a function of (B, T). A /13 one is a
  function of (T−2, T−1, T): the formation memo's key gains T−2. Lockstep viewers still share
  everything. A viewer that resynced or folded differently forms its own, as now.
- **Host state.** The host keeps, per connection, the published states of T−1 (it already keeps
  the base for `make_patch`) and T−2. After HC4a's persistent tables a state is shared, so that is
  a reference count, and the predicted units' values are read straight from them.
- **Receiver state.** rs-core's decoder keeps the predicted units' values at T−1 and T−2: two
  bodies per dynamic mesh, two AABBs per mesh entry, two buffers per multimesh. That is about
  2 × 45 KB in STS2 combat, beside W11t's two retained messages (≤ 1.1 MB).
- **Window 2, folding, stale-coalesce, superseded.** Prediction runs at accept, so none of them
  matter. A stale-coalesce repeat (T = T−1) gives all-zero residuals at first order.
- **Resync and reconnect.** The full resets the history on both ends. A `coding` resync after a
  `predict-check` failure works as W11t's.
- **Late join and adoption.** The first transaction is full: raw units only.
- **File recordings.** The patch lane predicts from the previous two records. The full lane
  (every record full) never predicts. A /13 recording transcodes to /12 and back byte for byte.
- **Taps and evidence.** `GRC_LIVE_TAP_DIR` keeps the uncoded /13 messages, which are a valid
  stream. `rs-core-check transcode` (W13a) turns any /13 file into the /12 file with the same
  model, for every JSON-reading tool.

## What stays lossless, and the quantized tier it does not include

**Lossless (all of /13):** every value. The binary syntax is a bijection of /12's canonical JSON
model, and prediction is an invertible integer transform. The proof is mechanical: decode back
and compare. The prototype did it for all 4,854 warm transactions of `pm7-a12-1` with zero
differences, and W13a's checks do it for every golden and every kept recording.

**Quantization is measured but not part of /13.** Dynamic mesh positions as integers of a fixed
local step, predicted the same way, are the only quantization worth measuring (UVs, colours and
indices do not move, so prediction already removes them; item and command floats code to under
0.4 KB anyway):

| position step (local units) | combat coded bytes / frame | Mbps | max screen error (1080p, measured scale ≤ 0.51) |
| --------------------------- | -------------------------: | ---: | -------------------------------------------------------: |
| lossless (/13) | 6,171 | 2.96 | 0 |
| 1/256 | 3,551 | 1.71 | 0.0014 px |
| 1/64 | 3,206 | 1.54 | 0.0056 px |
| 1/16 | 2,984 | 1.43 | 0.0225 px |

Why it stays out:

- **No bound proves pixel identity.** The GPU snaps each vertex to its subpixel grid (8 bits on
  current hardware) and samples coverage at pixel centres. Any change to a position, however
  small, can move a vertex across a snap boundary or an edge across a pixel centre (the tie that
  memory `g7t-godot-y-up-tie-rule` describes). So a quantized stream is not pixel-identical to the
  host. Its error can only be measured, as a band, by replay.
- **The parity stream does not need it.** Lossless /13 is already 2.96 Mbps in warm combat,
  5–8× under the video baseline, and the rest of the gap belongs to the
  host (HC), not the wire.
- **The user's rule** (memory `render-stream-pure-client-first`) puts anything that departs from
  parity into opt-in modules. A quantized tier would be one: a hello key
  (`"positions":"q64"`), its own encode per (T−2, T−1, T, tier), a `q-band` check (native and GSW
  replays of the lossless and quantized streams of one recording, max channel difference and
  differing-pixel count per shot, plus `dyn-wire` within step/2 of the hook log), and gate 5's
  exact mesh legs kept on lossless. This design reserves the key and builds nothing.

## Host cost

All per-(T−2, T−1, T) formation, so it belongs on HC5's encode thread (host-cost-design.md D4). The
main thread gains only a reference count on T−2's state when it enqueues the job.

| work, warm combat | /12 | /13 | basis |
| ----------------- | --: | --: | ----- |
| meta encode (C++) | 0.09 ms (MX) | lower: no number formatting, about 1/10 of the bytes | projected |
| prediction + XXH64 | — | ~0.02–0.05 ms (≈ 15k words, 45 KB hashed) | projected |
| zstd-3 base prefix (zstd 1.5.7 C library, this desktop) | 291 µs | 90 µs | measured (Python binding) |
| per-frame total | ~0.35 ms (MX: encode 0.09 + zstd 0.25) | about 0.2 ms | projected |

/13 makes formation cheaper, not dearer. The host's real cost is still snapshot and diff (HC1 to
HC5), which /13 does not touch.

## Receiver cost

| work, warm combat | /12 | /13 | basis |
| ----------------- | --: | --: | ----- |
| zstd decode (ruzstd) | 0.10 ms native, 0.12 wasm (W11t) | smaller input: ≤ /12 | projected |
| meta parse | 16 µs native (`fast.rs`, measured here) | binary read, ≤ 16 µs | projected |
| un-predict + XXH64 | — | ~15–30 µs native | projected |
| state | — | + ~90 KB (two poses a mesh) | from the recording |

Natively the core's per-transaction work moves by about ±20 µs of 322 µs: a wash. On the g31
(about 11× desktop wasm, memory `g7x-rust-core-phone-facts`) that is about ±0.2 ms a
transaction. /13 is a network change, not a receiver speed-up. W13c measures it.

## Validators and golden vectors (`golden-13/`, W13a)

The agreement the codecs must prove is W11a's: one generator, three implementations, byte for
byte.

- `golden-13/make_golden.py` (stdlib, deterministic, `--check`) loads golden-12's generator,
  writes `schema.json`, and re-encodes golden-12's recordings as /13: `full.rs13`, `patch.rs13`
  and `inline.rs13` hold the same model, and their `*.decoded.json` equal golden-12's but for the
  magic and the protocol string.
- **New states** after golden-12's 26 exercise prediction: a dynamic mesh over five patches
  (raw, first order, second order, a shape change that falls back to raw, then first order
  again), a custom AABB moving at constant velocity (all-zero second-order residual), a multimesh
  buffer whose instance count changes (raw), a NaN and a −0.0 in a predicted word, and a full in
  the middle of the patch lane (the history resets).
- **Invalid vectors**, one rule each: `binary-truncated`, `binary-noncanonical` (a padded varint,
  a boolean 2), `binary-enum`, `binary-text`, `binary-trailing`, `block-length`,
  `predict-check` (a residual with one bit flipped), `meta-schema` (a JSON transaction at /13),
  `bad-magic` (golden-12's `full.rs12` to a /13 decoder). Plus every golden-12 invalid vector
  transcoded: each must fail at /13 with its /12 code, which proves the semantic rules run on the
  decoded model.
- **Checks.** `self-test-rs2.ts` `runSuite(golden-13, 13)`; `capture/test/rs13_codec_test.cpp`
  (the C++ writer and `make_patch` match every `.rs13` byte for byte); `rs-core-check goldens`;
  `cargo test`, with a property test: over random state sequences with fulls, resyncs, folds and
  window 2, the decoder's prediction history equals the encoder's after every transaction, and
  decode(encode(T)) = T.
- **Recordings.** `rs-core-check transcode` turns every kept /11 and /12 recording (GSI's list of
  13) into /13 and back, byte-identical, and reports the /13 sizes. That is the C++-free version
  of the prototype's round trip, on the receivers' own code.
- **Sabotages.** `predict-stale` (encoder flag: predict from T−2 as if it were T−1) and
  `no-predict-reset` (decoder flag: keep the history across a full) each fail `predict-check` on
  the first transaction they touch.

## Opt-in, migration and version policy

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_STREAM_VERSION` | `6` (default), …, `12`, `13` | `13` makes file sinks /13 and puts `.13` first in the listener's offer |
| `RS_RECEIVER_PROTOCOL` | `…`, `13` | the native receiver and GSW offer `render-stream.13` |

- **Defaults do not move** until W13z: file sinks stay /6, the listener offers `.13` only under
  `GRC_STREAM_VERSION=13`, then /12's list. Every /2 to /12 session is byte-identical, and
  `golden-2/` to `golden-12/` pass unchanged.
- **Receivers keep /11 and /12** (and everything below), as they keep /2 to /10: the decoders are
  version-parameterized, so an older stream costs nothing at runtime, and kept recordings stay
  replayable. A /12 and a /13 viewer on one host share snapshots, never encodes.
- **The freeze.** After W13z the product hand-off (gate8-product-handoff.md) moves to /13, and
  /13 is the format that freezes: any later change is a new version, as always, but no further
  syntax swap is planned. /11 and /12 stay decodable and stop being offered by default.
- The GDScript codec (`rs_wire.gd`) is not touched: the native receiver decodes in rs-core.

## Byte projection per scene

Measured with the prototype on `pm7-a12-1` (warm patches, 30 frames into a scene; W11t's coding:
zstd-3, the base's message as raw prefix, +24 B envelope, +4 B checksum, WebSocket header).
Resource records (cold payloads, in the menu only) are coded per message as W11t
does and listed apart:

| scene | /12 raw | /12 coded | /13 raw | **/13 coded** | records coded | **/13 Mbps** | video |
| ----- | ------: | --------: | ------: | ------------: | ------------: | -----------: | ----: |
| menu | 16,978 | 1,120 | 6,745 | **510** | 324 | **0.40** | 15–25 |
| map | 10,489 | 324 | 3,975 | **332** | 0 | **0.16** | 15–25 |
| combat | 88,154 | 13,311 | 52,742 | **6,171** | 1 | **2.96** | 15–25 |

- **Measured** (prototype encoder, every lossless row decoded back): every byte column. The
  Mbps is mean bytes × 8 × 60.
- **Projected:** that the C++ encoder lands within 1 % of the prototype. W11t's real encoder
  landed within 0.3 % of WB's Python model (12,506 against 12,471).
- **Not modelled:** GPU particle bytes beyond what the recording shows. In `pm7-a12-1` warm
  frames carry particle entries in 1 of 2,713 combat transactions (the emitters hold
  still; their simulation is the receiver's), so /12's particles cost about nothing warm. A scene
  whose emitters move sends a 124-byte float group per moving emitter per frame, unpredicted.

## Increments

Each lands as one commit with its result doc. Timing legs stay real time and go to the milestone
sweep.

| Id | Scope | Fixture | Checks | Sabotages |
| -- | ----- | ------- | ------ | --------- |
| **W13a** | codecs, goldens, validators: `golden-13/` (schema.json, the generator, new states, invalid vectors); the C++ writer (`rs2_codec` V13: binary syntax, predictor, check) and reader for its tests; TypeScript (`render-stream-2.ts` version 13: binary reader to the /12 model, predictor history); rs-core (binary reader beside `fast.rs`, history in the `Validator`, `predict-check`); `rs-core-check transcode`; `rs-core-capi` `VERSIONS` gains 13 | `golden-13/`; the 13 kept recordings | "Validators and golden vectors": the three implementations byte-identical on every golden; decoded forms equal golden-12's; transcoded golden-12 invalid vectors keep their codes; the property test; `transcode` round trip on every kept recording, with its size report | `predict-stale` and `no-predict-reset` fail `predict-check` |
| **W13b** | capture: /13 file sinks and listener offer under `GRC_STREAM_VERSION=13`; per-connection T−2 retention; the memo key (T−2, T−1, T, version); formation on HC5's encode thread if HC5 has landed, else where formation runs now | `fixtures/capture-scale`; `gate5-mesh` (g5c, g5e); `gate8-mm`; `gate8-pt` | `w13-equiv`: one host with a /12 and a /13 viewer; the /13 stream transcoded equals the /12 stream message for message. Byte identity below /13 (`cmp-rec.ts`, gates 1, 2, 5, 8 against `main`). `dyn-wire` at /13. `rs_live_test`: lockstep /13 viewers share coded bytes; a viewer after a resync forms its own. g8w11 `coding/` legs at /13 | `predict-stale` (host) fails `predict-check` in the Node viewer, which resyncs; `perturb-vertex` still fails `dyn-wire` |
| **W13c** | GSW: offers `.13` under `RS_RECEIVER_PROTOCOL=13`; the accept path through rs-core's /13 reader | g7-5 and g7-2 groups at /13; gate 5 meshes; g8mm, g8pt | `gsw-band` on gate 5 meshes at /13; g8mm and g8pt GSW checks at /13; a `predict-check` resync leg; core profile (`profile-rs-core-wasm.mjs`) on `pm7-a12-1` transcoded: accept µs at /13 within +10 % of /12 | `no-predict-reset` (receiver) fails the resync leg's pixel check |
| **W13d** | native receiver and web export: capi at /13, the shim unchanged (the planner sees the /12 model) | `gate5-mesh`, `gate8-mm`, `gate8-pt`, g7-5 web | g5c and g5e `reference` exact at /13; `mm-reference`, the g8pt checks; the web half of each | `no-predict-reset` as W13c |
| **W13z** | STS2 acceptance | none (one game launch) | /13, window 2, W11t coding, GSW and native viewers, menu, map and combat: warm coded bytes within 10 % of the projection above; replay dB equal to /12's on the same recording (transcoded); a /12 and a /13 viewer of one host with equal resolved states at every shared frame; zero `predict-check` errors; host callback and formation split no worse than /12 (load-gated) | none in game |

**W13a as built** ("Staging", "As built (W13a)"): the predicted blocks under /12's JSON meta, with
`predict_check` as a transaction key; no binary syntax, no `schema.json`, no `binary-*` vectors,
no capi `VERSIONS` 13 (W13d's); results in [results/p3/w13a.md](../results/p3/w13a.md). W13b to
W13z apply to that wire; the binary body, if it is built, is its own increment before W13z.

Order: W13a → W13b → W13c and W13d in parallel → W13z. W13b wants HC5 first (the encode thread
is where formation goes), but does not need it: /13 formation is cheaper than /12's either way.

## Risks

- **Silent wrong geometry.** A prediction history that differs between the ends decodes to
  plausible but wrong vertices, with a valid zstd checksum. `check` exists for exactly this, and
  the property test and `no-predict-reset` prove it fires.
- **Three schema tables.** The binary syntax only works if every implementation agrees on every
  key's type and spelling list. `schema.json` is the single source, and each implementation tests
  against it; `binary-noncanonical` stops a lenient decoder from hiding a writer bug.
- **Debuggability.** A binary record cannot be read with `jq`. `rs-core-check transcode` and the
  decoded form must ship with W13a, and every checker that greps a recording's JSON reads the
  transcoded file.
- **Smaller gain than hoped for structure.** The binary structure saves raw bytes and host
  formatting, but under base-prefix zstd only about 240 B a combat frame, and the
  receivers' parse is already cheap. The prediction is where the coded bytes go. If the
  structure's cost (three writers and readers) were ever judged too high, `json_w13` (prediction
  under /12's JSON meta) keeps 97 % of the saving; the design keeps both together
  because a freeze is the last chance to drop the JSON meta.
- **Second-order prediction misses** when a mesh changes shape or a pose jumps (a new animation).
  It then costs about what first order costs; the measured mean includes STS2's transitions.
- **One recording.** The numbers come from `pm7-a12-1`. The menu's and the map's churn is STS2's;
  another game with more moving items and fewer meshes gains less from prediction and relatively
  more from the structure.

## As built (W13a): the wire

This section is normative for /13 as built. `golden-13/make_golden.py` (`to13`, `to12`) is the
reference codec; the C++ writer, the TypeScript library and rs-core match its bytes.

**render-stream/13 is render-stream/12 plus exactly:**

1. the magic `GRSD` (`47 52 53 44 0D 0A 1A 0A`), protocol string `render-stream/13`, subprotocol
   `render-stream.13`, file extension `.rs13`. A /13 decoder refuses `GRSC`, a /12 decoder `GRSD`
   (`bad-magic`);
2. the transaction key **`predict_check`**, on every transaction (full and patch), right before
   `"blocks"` (after `shader_time` when present): 16 lowercase hex digits, the XXH64 (seed 0) of
   /12's `mesh_f32` ‖ `mesh_u8` ‖ `mm_f32` bytes (the reconstructed blocks, in that order, empty
   blocks contributing nothing) written big-endian (`format!("{:016x}")`). Missing, not a string,
   not exactly 16 characters of `[0-9a-f]`: `meta-schema`;
3. **predicted blocks**: the payloads of `mesh_u8`, `mesh_f32` and `mm_f32` are the coded form
   below. Their descriptors (`name`, `type`, `count`) and lengths are /12's: a coded block has its
   plain block's length.

Everything else is /12's byte for byte: framing, canonical JSON, every other key and block,
resource and end records, the record sha256 (over the /13 record's own bytes). The session record
differs from /12 only in `protocol`.

### History

R(T) is the prediction state after transaction T: per mesh id, its **bodies** (the surface shape
list and each surface's body bytes) and its **AABB** (the six `mesh_f32` floats); per multimesh
id, its **buffer** (`instances`, stride, bytes). H1 = R(T−1) and H2 = R(T−2), where T−1 and T−2
are the stream's previous transaction records (file order; on a live connection, the previous
transactions sent on it). Both ends compute R from /12's (reconstructed) blocks, never from coded
bytes.

- **Reset.** Before a full transaction H1 = H2 = ∅, so a full predicts nothing. After it,
  H1 = R(full) and H2 = ∅, so the next patch predicts to first order.
- **R(T)** starts from R(T−1) for a patch and from ∅ for a full, then, in this order:
  - each entry of `meshes`: if it is `ok` and dynamic (at least one surface, every `hash` null), a
    non-null `u8` sets its bodies from `mesh_u8` (only when the block's partition, below, holds)
    and a null `u8` keeps them; any other entry drops them. A non-null `f` sets its AABB, a null
    one drops it;
  - `removed_meshes` drops both;
  - each entry of `multimeshes`: status other than `ok` drops its buffer; `ok` with a non-null
    `buffer_f` sets it; `ok` with null keeps it;
  - `removed_multimeshes` drops it.

  So a unit not carried by T keeps its value: a mesh that pauses at T−1 has H1 = H2 and is
  predicted with zero motion. (WB-D's prototype used "the last two sent bodies" instead.)

### Units and the predictor

- A **body unit** is a carried mesh entry (non-null `u8`). It is predicted from H1 when H1 holds
  bodies for that id with the same shape (surface count, and `primitive`, `format`, `vertex_count`,
  `index_count` per surface), and to second order when H2 does too, with the same shape.
- An **AABB unit** is a mesh entry with non-null `f`: predicted from H1's AABB for that id, second
  order when H2 has one.
- A **buffer unit** is a multimesh entry with non-null `buffer_f`: predicted from H1's buffer for
  that id when it has the same `instances` and stride (8 + 4·`colors` + 4·`custom`), second order
  when H2's does too.
- Per 32-bit float word v, with b and p the same word at H1 and H2,
  `ord(u) = u ^ 0x80000000` when u < 2^31, else `~u`, and `zz(d) = (d << 1) ^ (d >> 31)` on d as
  signed 32-bit:

  | unit | residual |
  | ---- | -------- |
  | second order | `zz(ord(v) − 2·ord(b) + ord(p))` mod 2^32 |
  | first order | `zz(ord(v) − ord(b))` mod 2^32 |
  | raw (no H1 match) | `v` itself |

  Byte parts of a body (colours, skin, indices) are XORed with b's same part when the unit has an
  H1 match, else sent as they are.
- Everything else in the three blocks (multimesh `aabb_f` floats, entries without a match) is
  sent as itself, in place.

### Layout

- **`mesh_u8`**: each carried surface body (entries in `meshes` order, surfaces in order) is split
  into geometry (40 bytes), positions (8·n), colours (4·n if `format` bit 3), UVs (8·n if bit 4,
  de-interleaved from the attribute section, which interleaves colour then UV per vertex), skin and
  indices (render-stream-4.md "Mesh payload" sizes). The block is six streams, each the
  concatenation over all carried surfaces: geometry words, position words, colour bytes, UV words,
  skin bytes, index bytes. Each word stream (geometry, positions, UVs) is **byte-plane
  transposed**: for n words, byte j of word k goes to j·n + k.
- **`mesh_f32`** and **`mm_f32`**: residual words in place of predicted words, then the whole block
  byte-plane transposed.
- Fulls use the same layout (every unit raw), so one code path serves every transaction.
- **Pass-through.** A block whose /12 offset rule does not hold is carried exactly as /12 carries
  it (no prediction, no transpose), and /12's rule then reports it:
  - `mesh_u8`: every non-null `u8` equals the running byte count over `meshes`, every surface of
    those entries has `payload_bytes` equal to its shape's body size, and the total equals the
    block length (`mesh-u8-offset`, `payload-size`);
  - `mesh_f32`: every non-null `f` equals the running float count, six floats each, total the
    block's count (`mesh-offset`);
  - `mm_f32`: over `multimeshes` in order, a non-null `aabb_f` then a non-null `buffer_f` each
    equal the running float count (6, then `instances`·stride), total the block's count
    (`mm-offset`).

### Decoding and check order

framing → meta JSON and schema (/12's plus `predict_check`) → un-predict the three blocks against
H1, H2 → **`predict-check`** (XXH64 of the reconstructed blocks against `predict_check`) → every
/12 rule on the /12 meta and blocks, with its /12 code → R(T). A decoder that fails `predict-check`
applies nothing; a live receiver resyncs with reason `coding` (W13c/W13d wire that).

### Forms and transcode

- The **decoded form** `render-stream-13-decoded/1` is /12's decoded form of the /13 file: metas
  verbatim (so `predict_check` included), blocks the reconstructed /12 values, `offset`,
  `byte_length` and `sha256` of the /13 records. The **resolved form** is
  `render-stream-13-resolved/1`, /12's content unchanged.
- **Transcode** /12 ↔ /13: the magic, the session's `protocol`, `predict_check` added or removed,
  the three blocks coded or decoded; resource records unchanged; the end record's
  `stats.bytes_total` moves by the size change and `stats.max_record_bytes` becomes the output's
  own maximum when the input's was its own. /12 → /13 → /12 is byte-identical.

### Sabotages

- `predict-stale` (encoder): every patch predicts from H2 as if it were H1, first order. The
  receiver fails `predict-check` on the first patch it touches (`golden-13/invalid/
  predict-stale.rs13`, seq 2).
- `no-predict-reset` (decoder): a full does not reset the history (it is un-predicted against H1
  and H2 like a patch). The decoder fails `predict-check` at the first full after units exist
  (`predict.rs13` seq 7, `patch.rs13` seq 16).

### Not changed by W13a

The hello, the live listener, file sinks, W11t's coding, the receivers' accept paths and the
GDScript codec. /13 is selected only by version 13 in the codecs; no capture or receiver offers or
emits it (W13b to W13d).

## Versioning

As /12: any change to framing, a key, a key order, a block layout, an enum spelling, a payload
format, the binary syntax, the schema table or the predictor is a new version.
