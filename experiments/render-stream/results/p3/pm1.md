# PM1: multimesh buffers in the capture and on the /11 wire (2026-10-28)

Under `GRC_STREAM_VERSION=11` the capture now hooks the `multimesh_*` calls, keeps a shadow of every
multimesh's instance buffer, and carries it on the wire: a `multimeshes` table, an `add_multimesh`
command and the floats themselves in the `mm_f32` block, only when they changed. In STS2 every
multimesh is a `CPUParticles2D` (the menu fog, the tower glow, combat's fireflies: 33 items, 46
instances in combat), so this is the capture half of C3's gap 3. The receivers do not draw it yet
(PM2 native and web, PM3 GSW); they accept the streams and count the draws as undrawn.

/11 is unreleased, so PM1 extends it without a version bump: the magic stays `GRSB`. Everything
below /11 is byte-identical, and so is every transaction of a /11 stream without multimesh.

The rules are in [render-stream-11.md](../../protocol/render-stream-11.md), "As built (PM1):
decisions" (16 rules). The sketch in
[particles-multimesh-design.md](../../protocol/particles-multimesh-design.md) "/11: multimesh"
holds, with these refinements:

- **Optional keys.** `multimeshes` and `removed_multimeshes` appear only when non-empty (P3-TM's
  `shader_time` is the precedent). That is what keeps a /11 stream without multimesh identical.
- **`aabb_f` lives in `mm_f32` too.** Each entry contributes its six custom-AABB floats, then its
  buffer when `buffer_f` is non-null. `mm-offset` is the running count over both.
- **The version moves on a change, not on a call.** An idle `CPUParticles2D` re-sets an identical
  buffer every frame. With a per-call version it would re-send its entry every frame; compared by
  bit pattern against the shadow, it sends nothing.
- **`buffer_f` follows `u8`'s (B, T) rule** (non-null on a full, a new entry, a shape change, or
  when the buffer serial moved between base and target), as render-stream-11.md "Multimesh (PM1)"
  asked.

## What changed

- **Calibration ("calibrator 11").** `calibrate.py` gains twelve `multimesh_*` slots, the
  mutators: create, allocate_data, set_mesh, the four instance setters (3D and 2D transform,
  colour, custom), set_custom_aabb, set_buffer, set_buffer_interpolated, set_physics_interpolated
  and set_visible_instances. On the stock 4.5.1 template they are slots 102, 103, 105-109, 112, 118,
  122, 123 and 126. Like CG1's 484/495 they are conditional: they are planned only at /11, and
  below /11 they are neither planned nor omitted. So the calibrator version stays 9, and every
  /2-/10 session record is unchanged.
- **Capture** (`capture/src`):
  - the mirror's shadow buffers, modelled on GLES3 (rule 13): allocate zeroes, `set_buffer`
    replaces, setters patch Godot's 2D layout, and rejected calls change nothing;
  - the multimesh table in the snapshot, with a shared immutable buffer and a serial per entry;
  - `add_multimesh` and `unknown-multimesh`;
  - `make_patch`'s `buffer_f` from the (B, T) serials;
  - the `mm_f32` block in the C++ encoder, counted against the record cap;
  - for /10 viewers of a /11 host, a lowering to /10's `unsupported-op`, with their own
    content-version digest;
  - the hook log's multimesh lines and per-frame `state` lines;
  - the sabotages `perturb-instance` and `stale-buffer`.
- **Codecs and validators.**
  - `render-stream-2.ts` and rs-core decode, validate and resolve the table. The new codes are
    `multimesh-entry`, `multimesh-version`, `multimesh-ref` and the generalised `mm-offset`.
  - The resolved form gains `buffer_sha256`; validators keep the digest, not the floats.
  - rs-core-capi's planner and GSW's executor skip `add_multimesh` and count it:
    `multimesh_commands_undrawn` and a `multimesh-undrawn` shortcut.
- **Goldens.** `golden-11/` gains states 17-21 and 13 invalid vectors (below). The session's
  features gain `add_multimesh`/`multimesh`, so every golden-11 file regenerated. Each transaction
  of states 1-16 is byte-identical to before.
- **Fixture and group.** `fixtures/gate8-mm` and gate 8 group `g8mm`
  (`lib/gate8-mm-checks.ts`, `test/self-test-gate8-mm.ts`).
- **Tooling.** `scripts/cmp-rec.ts`, a record-by-record recording comparator (W11b found none in the
  tree).

## Golden-11 states 17-21

The full description is in `make_golden.py`'s docstring.

| State | What changes |
| ----- | ------------ |
| 17 | Three new multimeshes: 1 is `ok` (colours and custom data, 3 instances, a mesh), 2 is `ok` (transforms only, 2 instances, `visible` 1, a custom AABB), 3 is `multimesh-3d`. New item 16 draws all three, so 3 derives `unsupported-multimesh`; item 17 draws an unknown RID (`unknown-multimesh`). |
| 18 | Multimesh 1's buffer changes. Multimesh 2's AABB changes with the same buffer, so its `buffer_f` is null. |
| 19 | Multimesh 1 is re-allocated to 5 instances, a shape change. Multimesh 3 is freed and becomes a tombstone. |
| 20 | Item 16 stops naming 2 and 3, so `removed_multimeshes` is [2, 3]. |
| 21 | Nothing changes; the state is re-sent full. |

`patch.rs11`'s full transactions are at seqs 1, 5, 16 and 21.

Each new invalid vector fails exactly one rule, with the same code in the TypeScript validator and
rs-core:

- `mm-offset`: `mm-offset-wrong`, `mm-offset-short`;
- `multimesh-entry`: `multimesh-entry`, `-full-null`, `-shape-null`, `-unsupported-buffer`;
- `multimesh-ref`: `multimesh-ref`, `multimesh-ref-mesh`;
- `multimesh-version`: `multimesh-version`;
- `meta-schema`: `multimesh-empty-key`, `multimesh-removed-empty-key`, `multimesh-feature`,
  `multimesh-v10.rs10`.

## The fixture: `fixtures/gate8-mm`

The fixture is 640x360, runs at `--fixed-fps 60` for 90 frames, and has steps at frames 20 and 40.
Each cell has its own instance count, which is how the census finds it in the hook log:

| Cell | Instances | What it is |
| ---- | --------- | ---------- |
| A | 5 | `MultiMeshInstance2D`, transforms only |
| B | 6 | colour and custom data, read by a canvas shader; custom.x is the frame number, set in `_process` |
| C | 7 | fixed-seed `CPUParticles2D` with a flipbook `CanvasItemMaterial` |
| D | 9 | global-coordinate emitter under a moving parent |
| E | 10 | `visible_instance_count` 4, then 6, with a custom AABB |
| F | 3 | buffer replaced at step 1, then the same floats re-set at step 2 |
| G | 11 | hidden but emitting emitter |
| H | 2 | raw RenderingServer multimesh: a rejected wrong-size `set_buffer`, then freed while drawn |
| I | 12 | buffer set from `frame_pre_draw` (`CPUParticles2D`'s timing); custom.x is the frame number |

PM2 reuses every cell.

**Headless (decision).** On a headless host `RenderingServer::draw` never runs, so
`frame_pre_draw` never fires and `CPUParticles2D` never calls `multimesh_set_buffer`. PM1 does not
build the pre-draw pump; that stays opt-in and is PM5's. g8mm's captures run on a rendered host in
a private 640x360 headless gamescope, as g8c's do. A separate `headless/capture` leg types the
headless case in the census: script-driven multimeshes publish, and the `CPUParticles2D` cells and
`frame_pre_draw` make no `set_buffer` call (8 calls in all, none of them theirs).

## Checks and sabotages (g8mm)

Legs: `capture` (/11), `capture-v10` (the negative control), `sabotage-perturb-instance/capture`
and `sabotage-stale-buffer/capture` (from frame 30), all rendered; then `headless/capture`.

| Check | Verdict |
| ----- | ------- |
| `g8mm-legs`, `mm-validate` (every recording through the TypeScript validator and `rs-core-check`) | pass |
| `mm-hook-census` (creates, allocations, `set_buffer` per frame, setters, frees and rejected calls per cell, against `expected.json`) | pass |
| `mm-wire` (each entry's `buffer_sha256` and fields equal the newest hook-log `state` line at or before every transaction) | pass |
| `mm-frame-pairing` (cells B and I: the custom-data frame minus the transaction frame is one constant, 0, on the wire and in the hook log, over 90 transactions each) | pass |
| `mm-v10` (no `multimeshes` key; the draws are `unsupported-op`) | pass |
| `mm-sabotage-validate-*` (the validators accept the sabotaged patch sink) | pass |
| `mm-wire-catches-perturb-instance` (seq 30: multimesh 2's digest differs from frame 30's state) | pass (expected fail of `mm-wire`) |
| `mm-wire-catches-stale-buffer` (seq 30, same) | pass (expected fail of `mm-wire`) |

On the full sink the validators reject `perturb-instance` themselves, with `multimesh-version`: a
full transaction re-sends the buffer, so they see floats change under an unchanged version. So g8mm
judges `mm-wire` on the patch sink (rule 11).

**Measured `mm_f32` bytes on the fixture** (rendered `capture`, one transaction a frame):

| Sink | Mean per frame | Max per transaction |
| ---- | -------------- | ------------------- |
| full (`recording.rs11`) | 2,974 B | 3,024 B |
| patch (`recording-patch.rs11`) | 2,095 B | 3,024 B |
| headless patch | 441 B | n/a |

The patch figure is close to the design's STS2 combat prediction of 2,944 B a frame (PM4 measures
the game).

## STS2 calibration record

`calibrate.py --version-name MegaDot` ran offline against a byte-identical farm copy of the
installed `SlayTheSpire2` (sha256 `0c21999e…`, read only, never executed) with the pinned 4.5.1
header. The game was not launched, and nothing in the Steam install was read or written.

- Output: `calibration/sts2-megadot-4.5.1-m12.mm.json` in couch-coop's research folder
  (`.sts2/research/render-stream-p3-20261025/`), with `calibrate.mm.stdout.txt` beside it.
- 588 slots, anchors 17/17, calibrator 9.
- It is identical to `…m12.ck.json` except for the twelve new keys, and each equals the stock
  template's slot.
- STS2 records stay uncommitted, as CG4's did.

## Byte identity

`scripts/cmp-rec.ts` compares two recordings record by record, by each record's sha256. It allows
`session_id` and `stream.stream_id` to differ, plus the end record's wall-clock stats, plus any
session keys named with `--allow-session`; then `bytes_total` may move by exactly the session
record's length change. `--tree` pairs every file sink (`recording*.rsN`) by relative path.

The base was a `create-worktree.sh` checkout of main (`ceec660b`: main `5da09749` plus a
docs-only commit), built the same way. Both trees ran the same legs, locally:

| Recordings | Identical | Notes |
| ---------- | --------- | ----- |
| gate 1 (smoke tier: every leg but the sabotages) | 53 of 54 | The 54th is `live-replay/recording.rs2`, a copy of a live receiver's input. Its transaction count follows live pacing (590 against 902), which is a timing fact, not a wire fact. |
| gate 2 (smoke) | 73 of 74 | the same `live-replay` copy (462 against 840) |
| gate 5 (smoke) | 54 of 54 | |
| g8w11, every leg (`run-gate8.sh --legs g8w11`: /11 captures, their /10 twins, the sabotages and the receivers' file sinks) | 48 of 48 | See below. |

The 48 g8w11 recordings break down as follows:

- **/11 recordings (36).** Every transaction is byte-identical. The session differs only in rule
  8's three feature lists and `capture.hooks_planned`, and the end record's `bytes_total` by
  exactly the session's growth.
- **/10 recordings (12).** These are identical except for the ids.

So a /11 stream without multimesh is transaction-for-transaction what main writes. Below /11,
every file sink is byte-identical apart from the run's own ids.

## Validation

Full tier, run once remotely:
[run 40641960539](https://github.com/tfoxy/godot-scene-web/actions/runs/40641960539),
**21 of 21 runs pass**. The runs:

- setup: `pure`, `capture-build`, the four `cargo-*`, `pnpm-test` and `bench-instr` (every case
  within ±0.23 %);
- native: gates -1, 0, 1, 2, 3, 4, 5, 55 and 8 (g8mm included), with their sabotage legs (the diff
  names a sabotage);
- browser: `g7-gsw` and `g7-web-rust` (g7-0 to g7-8), and `g7live-gsw` and `g7live-web-rust`
  (g7-2, g7-5, g7-55, g7-8).

The runs the remote refused were run locally:

| Run | Result |
| --- | ------ |
| `lock-tests` | pass (262 s) |
| `g7live-gsw` g7-1 (full tier, `RS_VALIDATE_GROUPS=g7-1`) | pass |
| `g7live-web-rust` g7-1 (the same) | pass |
| `pure` after the last tooling edits (`cmp-rec.ts`, `smoke-map.json`), full tier | pass (884 s) |

Also run locally, for byte identity: `native-rust-gate1`, `-gate2` and `-gate5` (smoke tier) pass,
and so do `run-gate8.sh --legs g8w11` and `--legs g8mm` (11 of 11 checks, including the
informational `mm-bytes`).

Unit level:

- ctest 36/36: `rs11_codec_test` matches golden-11 byte for byte for all 21 states and still
  reproduces `resource-missing.rs11` under keep-carried;
- `self-test-rs2.ts` 1251/1251 (it was 1179);
- rs-core `cargo test --release`: 91 tests, including the new `pm1_tests.rs`;
- rs-core-capi: 12 tests (`replay.rs` replays golden-11's multimesh states and counts them undrawn);
- `rs-core-check goldens`: golden-11 139/139, golden-2 to golden-10 unchanged;
- `self-test-gate8-mm` 113/113 and `self-test-gate8z` 43/43;
- `make_golden.py --check` for golden-1 to golden-11;
- `tsc`: only the seven known errors.

**Out of scope, and why:**

- The timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`) and the timing groups the
  remote skips (g1c-rate, g1d, g2c-pins, g5f, g55f, decode-cost) are the milestone sweep's.
- No receiver draws multimesh yet (PM2/PM3), so there is no pixel check.
- No game launch (PM4).

## For PM2 and PM3

- **Calls to make.**
  - rs-core: `ResolvedState.multimeshes` (`state::Multimesh` with `stride()`,
    `drawn_instances()` and `buffer_sha256`), `Command::Multimesh { multimesh, tex }`, and
    `TxDelta.multimeshes_upserted`/`multimeshes_removed`.
  - `Validator::multimesh_buffers() -> &[MmBufferRef]`: the buffers of the transaction just
    accepted, in entry order, sliced from the record with `MmBufferRef::bytes(record)`. Read them
    at accept time, as `dynamic_bodies()` is read: a live message buffer is reused. An `ok` entry
    that is not listed kept its floats.
  - TypeScript: `transactionMultimeshes(meta, blocks)`, `multimeshBufferSha256()`,
    `multimeshStride()`.
- **Native (PM2).**
  - Re-issue `multimesh_create`/`allocate_data`/`set_mesh`/`set_buffer`/`set_visible_instances`/
    `set_custom_aabb` and `canvas_item_add_multimesh` in place of the capi's undrawn count. Retire
    `multimesh_commands_undrawn` and the `multimesh-undrawn` rows as they become draws.
  - `write_state_godot` already dumps `multimeshes`, so `receiver.gd`'s dump must match it.
- **Groups.** g8mm is in `GROUP_COVERAGE_8` with a `none:` reason (no receiver yet), and its
  smoke-map rule is exclusive (`pure` and `native-rust-gate8`). PM2 adds the receiver and
  `reference` legs, adds g8mm to `run-gate7.sh`'s `G8_FILE_LEGS` and `gate7b-adapters.ts`
  `GATE8_FILE_GROUPS` for g7-8's web half, and drops the exclusivity.
- **GSW (PM3).** Half-float rounding of colour and custom data when the session's
  `engine.rendering_method` is `gl_compatibility`, and `INSTANCE_CUSTOM` for the flipbook.
- **Known edges.**
  - A freed multimesh still drawn in its tombstone frame logs 4 `Parameter "multimesh" is null`
    engine errors on the host (cell H, frame 40).
  - An unnamed multimesh that keeps changing makes the frame publish an empty patch (rule 15).
  - Pre-arm multimeshes are not adopted (`unknown-multimesh`).

## Deviations from the PM1 row

- **No pre-draw pump or particles RID shim.** They stay PM5's (rule 14); g8mm runs rendered.
- **Adoption** of multimeshes created before the arm is not built.
- **`cmp-rec.ts` is new.** The brief named it, but it did not exist.
- **Timing legs** are left to the milestone sweep.

## Time

About 1 h 10 min of implementation, from 01:55 to about 03:05: the contract, the calibration, and
four parallel agents (goldens and TypeScript, rs-core, the capture, and the fixture with its
checks). Validation then took about 1 h 35 min of wall time, to 04:40. The remote full tier, the
refused local runs and the byte-identity runs (gates 1, 2 and 5 and g8w11, in two checkouts) ran
side by side on a contended machine.

## Memory-worthy

- Godot's dummy (headless) storage accepts a wrong-size `multimesh_set_buffer` without checking.
  The mirror applies GLES3's rule, so the census predicts `accepted: false` on both hosts.
- A full sink makes `perturb-instance` a validator error (`multimesh-version`), so `mm-wire`'s
  teeth are judged on the patch sink.
- "Version moves on every call" would re-send every idle emitter each frame. Compare against the
  shadow by bit pattern instead.
