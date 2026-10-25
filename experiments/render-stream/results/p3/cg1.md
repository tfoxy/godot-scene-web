# CG1: canvas groups and back-buffer copies on render-stream/10 (2026-10-25)

CG1 carries the two pieces of back-buffer item state that STS2's HP bars and `BackBufferCopy` nodes
depend on: `canvas_item_set_canvas_group_mode` (behind `clip_children` and `CanvasGroup`) and
`canvas_item_set_copy_to_backbuffer`. P3-NP (`p3-np.md`) diagnosed C3 gap 9 as this state, and P3-ST
sketched the `BackBufferCopy` key. The state goes through the capture and a new opt-in
render-stream/10 ([protocol/render-stream-10.md](../../protocol/render-stream-10.md)) to the native
receiver and the web export, which re-issue it to Godot. They reproduce Godot's picture exactly on
the new fixture. GSW accepts /10 and types the state until CG3 composites it. Defaults do not change:
every /2-/9 session and recording is byte-identical.

## What /10 is

/10 is /9 plus the following:

- **Header strings.** Magic `GRSA`: byte 3 is now a hex digit, so the next versions will be `GRSB`,
  `GRSC`, and so on. Protocol `render-stream/10`, subprotocol `render-stream.10`.
- **Two item keys,** placed after `instance_params`:
  - `canvas_group: null | {mode, fit_empty, blur_mipmaps, f}`, where `mode` is `clip_only`,
    `clip_and_draw` or `transparent`;
  - `copy_to_backbuffer: null | {f}`.
- **A seventh block, `backbuffer_f32`.** It holds the floats: clear and fit margins, and the copy
  rect. The wire keeps floats out of JSON, so P3-ST's inline `[x,y,w,h]` became an offset.
  Invariant `backbuffer-offset`.
- **Item state, not content.** Neither key bumps `content_version`, both survive
  `canvas_item_clear`, and both are freed with the item. A patch carries a state-only change with
  `commands: null`.
- **`features.unobserved`** loses each setter once its hook is planned.

Owner-ness, the subtree-first order, the group rect and GLES3's one-open-group rule are left to the
receiver's engine. They follow from this state plus the item tree, which the wire already carries.
Particles and multimesh stay out of /10 (particles-multimesh-design.md); render-stream-11.md
(W11-D) builds on /10.

## Calibration decision

Recorded in [gate8-design.md](../../protocol/gate8-design.md) "As built (CG1)".

**No calibrator bump.** P3-NP's "calibrator 10" is not used. The two slots join `calibrate.py`'s
`WANTED_SLOTS`, measured on the pinned template:

| slot | method |
| ---- | ------ |
| 484 | `canvas_item_set_copy_to_backbuffer` |
| 495 | `canvas_item_set_canvas_group_mode` |

The committed record gains these two keys. `calibrator.version` stays `"9"`.

**Why no bump.** The version is echoed into every session record, so a bump would change every
/2-/9 recording and golden for two hooks that only /10 uses. A new `WANTED_SLOTS` key is already
backward compatible.

**The hooks are conditional,** following G8kc's `texture_set_path`. They are installed only under
`GRC_STREAM_VERSION=10`, and otherwise neither planned nor omitted. Existing recordings and
`golden-2/` to `golden-9/` stay valid: every `make_golden.py --check` passes, and the rs2 to rs9
codec ctests are unchanged.

**STS2, offline check.** `sts2-megadot-4.5.1-m12.p3.json` (calibrator 9) matches the pinned
template slot for slot: prefix 23, 588 slots, and every shared key equal. It lacks only the two new
keys. A /10 STS2 capture with that record therefore arms; it omits both hooks
(`capture.hooks_omitted`) and keeps both methods in `unobserved`. CG4 re-derives the record, and
should find 484 and 495 there too.

## What changed

- **Capture** (`capture/src`):
  - The two hooks (`hooks.cpp`). Each passes the call through, then updates the mirror's item
    state. An out-of-range mode is counted in `captured.canvas_group_mode_invalid`, and the state is
    left unchanged.
  - `V10` through the snapshot, diff, codec, publisher and live hub. The listener offers `.10`
    first only under `GRC_STREAM_VERSION=10`, and a /9-or-older connection on such a host keeps its
    own session.
  - Adoption (`GRC_ADOPT=arm`, `rs_adopt.cpp`) reads the same values from the nodes:
    - `get_clip_children_mode`;
    - a `CanvasGroup`'s margins and mipmaps;
    - a `BackBufferCopy`'s mode and rect.

    The late-arm case is therefore in CG1, not CG4.
  - Tests:
    - `rs10_codec_test`, which matches golden-10 byte for byte, `make_patch` included;
    - `rs_live_test` and `rs_gate8_policy_test`, covering the /10 hello, the offers and refusals;
    - `rs_mirror_test` and `rs_adopt_test`.
- **Oracles:**
  - `protocol/golden-10/` (`make_golden.py`; full, patch and inline, plus 6 invalid vectors and the
    hello vectors).
  - The TypeScript decoder, validator and resolver (`scripts/lib/render-stream-2.ts`;
    `self-test-rs2.ts` passes 1033 checks).
  - `rs-core` decode, validate, canon and state (`rs-core-check goldens`: golden-10 118/118,
    cross-version 14/14, golden-2 to golden-9 unchanged).
- **Native receiver and web export.** `rs-core-capi`'s planner re-issues both calls whenever an
  item's state differs from the last one set:
  - op 67, `ItemSetCanvasGroupMode`, which is new;
  - op 66, `ItemSetCopyToBackbuffer`, which existed.

  P3-ST's `screen-copy-per-reader` sabotage now touches only items whose wire copy is null.
  Receiver opt-in: `RS_RECEIVER_PROTOCOL=10` for live, and `GRSA` is detected in file mode.

  New receiver sabotages:
  - `drop-canvas-group` never issues the mode.
  - `full-backbuffer-copy` issues every copy with `Rect2()`.
- **GSW** (`web/gsw-rs`, `web/gsw-receiver`). GSW accepts /10 and draws as /9. Every item holding
  either state is reported once in `applied.json` `unsupported[]`, as `gsw-canvas-group` or
  `gsw-backbuffer-copy`. CG3 replaces this typing with compositing.

## Fixture `gate8-cg` and group `g8cg`

`fixtures/gate8-cg` is 640x360 and procedural.

| cell | what it shows |
| ---- | ------------- |
| `HPBAR` | STS2's bar, node for node. It has a command-less clip-only container and a clip-only 12x10 pointed-cap mask nine-patch stretched to 232x10. The mask clips 18 px orange (229 wide) and red (232 wide) fill nine-patches; the red one is clip-and-draw. |
| `HPLOW` | The same bar with partial fills. |
| `CLIPDRAW` | A partial-alpha clip-and-draw mask. |
| `GROUP` | A `CanvasGroup` with fit margin 6, clear margin 12, mipmaps on, and overlapping translucent children. |
| `NESTED` | A clip-only owner inside an open `CanvasGroup`. GLES3 ignores it and draws it plainly. |
| `BBV` / `BBR` | A viewport-mode and a rect-mode `BackBufferCopy`, each read by an invert screen shader. Outside its rect, `BBR`'s reader sees `BBV`'s earlier whole-target copy. |
| `TGL` | A clip mode switched on at step 2: a state-only patch. |
| `PLAIN` | A control cell with no /10 state. |

A late-arm variant adopts everything.

Captures run headless, because the dummy server takes both calls. The reference and the receivers
are rendered in the private gamescope. The reference matches the hand model, and two reference runs
are identical.

`run-gate8.sh --legs g8cg` passes 12/12 checks in 29 s. A gate 8 run over every file group plus g8cg
passes 101/101.

| check | proves |
| ----- | ------ |
| `cg-hooks` | Both hooks are planned and counted, and neither setter is in `unobserved`. |
| `cg-below-10` | A /9 capture of the same fixture plans neither hook, keeps both setters unobserved, and has no new keys or block. |
| `cg-wire` | Every transaction's state is `expected.json`'s, and the recording validates at /10. |
| `cg-toggle-patch` | `TGL`'s step is a `commands: null` patch entry. |
| `cg-reference-repeat`, `cg-reference-model` | The reference is stable and matches the hand model. |
| `cg-native-exact` | The full and patch sinks equal the reference exactly. |
| `cg-negative-control` | The /9 replay is the pre-CG1 picture. It differs in `HPBAR` (1908 px), `HPLOW`, `CLIPDRAW`, `GROUP`, `NESTED`, `BBV`, `BBR`, and `TGL` at step 2, and it is 0 px off elsewhere. |
| `cg-sabotage-drop-group` | Differs in the five group cells and `TGL` only. |
| `cg-sabotage-full-copy` | Differs in `BBR`'s right half (2048 px) only. |
| `cg-adopt` | The late capture's wire equals the born capture's, and the late receiver is exact. |

The `/9` replay crop shows C3's symptom: square, full-height fills and the white mask. The reference
and /10 receivers draw the pointed bar. See `artifacts/render-stream/p3/cg1/hp-bar-reference-vs-v9.png`.

**`g7-8`.**
- GSW runs as GSW-only legs, judged by `cg-gsw-typed@gsw`. Across the full, patch and late legs,
  11 items are typed `gsw-canvas-group` and 2 `gsw-backbuffer-copy`. Every shot is within 1 per
  channel of the native /9 replay: GSW draws /9's picture and says so.
- The web export passes g8cg's band-view checks: native-exact, negative control, both sabotages and
  adopt. Its raw shots differ from the reference only by the readback rounding the band covers.

## STS2

No game leg, per the brief: CG4 regenerates the STS2 calibration and runs it. The kept recordings
(`a8-2`, `late-1`) are /8 and hold no group state, so a /10 receiver replays exactly the same input,
and P3-CT's per-scene dB stand unchanged. The calibration check is under "Calibration decision"
above.

## Validation

**Remote full tier: 21/21 runs pass.** Run
[40206860888](https://github.com/tfoxy/godot-scene-web/actions/runs/40206860888), snapshot of this diff
on 8b818b7b; summary in `artifacts/render-stream/p3/cg1/remote/validate-summary.json`. The plan reached
everything, because a capture change maps to `*` in `smoke-map.json`. Native sabotage legs were on,
because capture files are in the diff.

| runs | result |
| ---- | ------ |
| setup | `pure`, `capture-build` (31 ctests), `cargo-rs-core`, `cargo-rs-core-capi`, `cargo-gsw-rs`, `cargo-decode-proto-rs`, `pnpm-test`, `bench-instr` |
| native gates | -1, 0, 1, 2, 3, 4, 5, 55 and 8 (g8cg included) |
| browsers | `g7-gsw` and `g7-web-rust`, every file group with `g7-8`, plus the remote halves of `g7live-gsw` and `g7live-web-rust` (`g7-2`, `g7-5`, `g7-55`, `g7-8`) |

None of the known failures appeared.

**Local, the runs the hosted runners refuse.** Both are `g7-1`:

| run | result | wall |
| --- | ------ | ---- |
| `g7live-gsw` | 38 checks pass | 273 s |
| `g7live-web-rust` | 39 checks pass | 705 s |

The 1-minute load average ranged from 1.5 to 14.7 because of other agents' builds. Summary:
`artifacts/render-stream/p3/cg1/local/validate-summary.json`.

**Not run, deferred to the milestone sweep:**
- the timing runs: `native-rust-gate6`, `g7live-*-timing`, `g7x`;
- the timing groups the hosted runners skip: g1c-rate, g1d, g2c-pins, g5f, g55f, gate 8 decode-cost;
- `lock-tests`.

/10 changes no timing path below /10. These runs measure the default /6 and /7 paths, whose bytes
are unchanged.

**After rebasing onto `d22c3a53`** (P3-GX, P3-LV and the STS2-scale evidence fix). These commits
touched `receiver.gd`, `receiver_selftest.gd`, `gate7-web-legs.ts` and GSW's
`evidence.ts`/`live.ts`/`main.ts`; the rebase was clean. Results:

- Every `make_golden.py --check` (golden-2 to golden-10) and all 31 capture ctests pass.
- Smoke: `pure`, `cargo-rs-core`, `cargo-rs-core-capi`, native gates 0 and 8, and `g7-gsw` and
  `g7-web-rust` all pass. So do `g7live-gsw-g7-1` and `g7live-web-rust-g7-1`.
- Both receivers' `g7-8` (full) pass: 7 + 2 + 2 runs, all rc 0.

Summary: `artifacts/render-stream/p3/cg1/post-rebase/validate-summary.json`.

**After rebasing onto `f843a22d`** (P3-VX). The union conflicts were sabotage lists in `receiver.gd`,
`rs_rust_applier.gd`, `plan.rs` and `replay.rs`, plus GSW's options struct.

- Goldens and the 31 ctests pass.
- Smoke: `pure`, `cargo-rs-core`, `cargo-rs-core-capi`, `cargo-gsw-rs`, native gates 0 and 55, and
  `g7live-gsw-g7-1` and `g7live-web-rust-g7-1` all pass.
- Native gate 8 failed only the known `worker-hook-time`: 2.64 ms against the 2 ms budget, under
  other agents' timing legs. Its other 145 checks passed, every `cg-*` check included.
- `g7-8` and `g7-55` (full) pass in both `g7-gsw` and `g7-web-rust`.

**After rebasing onto `bb705ad1`** (P3-SP, shared live publication). `rs2_diff.cpp` conflicted:
P3-SP takes the version from the transaction meta, not the snapshot, so CG1's `/10` test in
`make_patch` reads `t.version` too. After that:

- goldens and the 31 ctests (with `rs_live_test`'s /10 cases) pass;
- smoke `pure`, `cargo-rs-core`, native gates 1 and 8 and `g7live-gsw-g7-1` passes, 5/5.

**Open: a `cg-reference-repeat` failure seen on another branch.** P3-TM's remote full tier (run
40224586459) ran on this commit plus P3-TM. There, the second unarmed reference run differed from
the first:

- in every group and back-buffer cell (whole cells), and in 344 px outside the cells;
- at all three checkpoints.

`cg-reference-model` and `cg-native-exact` passed on the same run, so the first reference was the
correct one. Both runs log GLES3 shader-cache `make_dir` errors (`shader_gles3.cpp:790/800`), and
the repeat loads the program binaries the first run cached. That makes the repeat's own shader
cache a suspect, but this is not proven. This check passed on CG1's remote run and on every local
run. Evidence:
`artifacts/render-stream/p3/cg1/p3-tm-run-40224586459/result.json`. Next step: a `--determinism`
remote run of gate 8 g8cg.

## Deviations from the brief and the sketches

- **The calibrator version is not bumped.** See "Calibration decision" above.
- **`copy_to_backbuffer` is `{f}`, not `{rect: null | [x,y,w,h]}`.** This follows the no-floats-in-JSON
  rule. The full-target case is Godot's own `rect == Rect2()` test.
- **The hooks are installed whenever `GRC_STREAM_VERSION=10` is set,** not only when a file sink
  exists. That is the variable's documented effect.
- **Adoption is in CG1.** P3-NP put it in CG4. G8a's state pass already reads item state from
  nodes, so the three getters fitted there.
- **GSW legs in `g7-8` are GSW-only and typed** (`cg-gsw-typed@gsw`). They do not replace the native
  legs, and stay that way until CG3.

## Evidence

All under `artifacts/render-stream/p3/cg1/`:

- `hp-bar-reference-vs-v9.png`;
- `g8cg/` (result and legs);
- `g8-all/` (gate 8 file groups plus g8cg);
- `g7-8-gsw/`, `g7-8-web/`;
- `remote/`, `local/` (the validation summaries).
