# Gate −1 runner

Drives `../fixtures/spike/` through every leg of the capture library's runtime contract
(`../README.md` "Runtime contract") and checks the gate's pass criteria. Run it from the repo root:

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate-minus1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/evidence/dir]
```

`--extension` and `--calibration` are required; the script refuses immediately rather than running
a partial gate. `--binary` defaults to the pinned official 4.5.1 release template
(`~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64`, sha256
`54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c`; a mismatch only warns). `--out`
defaults to `artifacts/render-stream/gate-minus1/<UTC timestamp>/` (ignored). Needs `strace`,
`gamescope` and `readelf` on `PATH`; without `strace` two criteria are `unavailable` and the gate
fails.

The rendered legs run only inside a private `gamescope --backend headless` started by
`lib/gamescope.sh`, with `DISPLAY`/`WAYLAND_DISPLAY` stripped and reset, never Xvfb and never a
desktop window. On any exit the runner stops the Godot process it owns and tears down its own
compositor (by recorded pid plus start ticks, never a pattern). gamescope 3.16.19 segfaults in its
own exit path after SIGTERM; bash prints that, it is harmless, and core files are suppressed.

## Files

- `run-gate-minus1.sh`: the orchestrator.
- `lib/gamescope.sh`: sourced private-gamescope lifecycle: start, ownership and liveness checks,
  display-connection proof, Godot launch with display, `GRC_*` and `RS_*` environment stripped and
  reset (`GS_STRIP_VARS`, `gs_strip_env_args`, shared with gate 0's headless launches).
- `lib/tamper-calibration.mjs`: writes the `refuse-sha` / `refuse-prefix` tampered record copies,
  and the `old-record` leg's version-1 record.
- `lib/gate-minus1-checks.ts`: every criterion as a pure function over an evidence directory.
- `check-gate-minus1.ts`: runs them, writes `<out>/result.json` (`render-stream-gate-report/1`,
  each entry numbered with its handoff criterion), exits non-zero unless every check passed.
- `test/self-test-checker.ts`: proves each check can fail (see below).

## Legs and evidence under `--out`

| Leg                  | What it runs                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `headless-armed`     | `--headless`, `GRC_MODE=arm`, disarm after 60 armed frames, under `strace -f -e trace=mprotect,openat`; `/proc` maps and fds sampled once `result.json` exists |
| `headless-validate`  | `--headless`, `GRC_MODE=validate`                                                                                                                              |
| `refuse-sha`         | record with one sha256 digit changed                                                                                                                           |
| `refuse-prefix`      | record with `object_prefix` and every slot and anchor index +1                                                                                                 |
| `refuse-nocal`       | no `GRC_CALIBRATION`                                                                                                                                           |
| `refuse-binary-byte` | a copy of the template with one byte flipped in the unmapped `.comment` section                                                                                |
| `old-record`         | `GRC_MODE=arm` with the record a version-1 calibrator would have written (gate −1 slots only, `tamper-calibration.mjs v1`); must arm with the rest omitted     |
| `rendered-unarmed`   | OpenGL under private gamescope, capture extension **absent**, screenshot at frame 60                                                                           |
| `rendered-armed`     | OpenGL under private gamescope, `GRC_MODE=arm`, disarmed only at shutdown, screenshot at frame 60                                                              |

Each headless leg writes `invocation.txt`, `stdout.txt`, `stderr.txt`, `exit-code.txt` and the
library's `evidence/` (`result.json`, `fingerprint.json`, `calibration-check.json`, and when armed
`counters.json`, `disarm.json`, `armed.marker`). `headless-armed` adds `strace.txt`, `maps.txt` and
`fd.txt`. The rendered legs write `godot.log`, the PNG, `display-ownership.json` and (armed only)
`evidence/`; `gamescope/` holds the compositor's own log and identity. The checker writes
`diff.png` and `result.json` at the top.

## Criteria

| #   | Check ids                                                                                | Passes when                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `frame-callback-ticked`, `headless-no-gpu`                                               | `frames_total >= 300`; the host reports display server `headless`, and neither a whole-run strace (successful `openat`) nor the maps/fd sample shows `/dev/dri`, `/dev/nvidia*`, `libvulkan`, `libGL*`, `libEGL`, `libnvidia*`, `libdrm`, `libgbm`            |
| 2   | `validate-no-write`, `refuse-sha`, `refuse-prefix`, `refuse-nocal`, `refuse-binary-byte` | the expected status and reason, `vptr_written: false`                                                                                                                                                                                                         |
| 3   | `colorrect-add-rect`, `label-glyph-path`                                                 | the native ColorRect's local-space rect and colour captured bit-exact; glyph `texture_rect_region` calls, an atlas `texture_2d_create`, and a `texture_2d_update` stamped at or after the relabel frame                                                       |
| 4   | `script-add-rect`                                                                        | the scripted rect and colour captured bit-exact                                                                                                                                                                                                               |
| 5   | `polygon-bit-exact`                                                                      | the scripted polygon's 3 points and 3 colours bit-exact, `uvs_count` 0                                                                                                                                                                                        |
| 6   | `disarm-restored`, `fixture-completed`, `frames-after-disarm`                            | `disarmed` and `vptr_restored`; `frames=400` and exit 0; at least 300 frames ran after disarm                                                                                                                                                                 |
| 7   | `armed-vs-unarmed-pixels`, `unarmed-not-blank`, `rendered-legs-armed-and-absent`         | the PNGs are byte-identical RGBA (`maxChannelDelta: 0`); the unarmed one shows the ColorRect and clear colour; the armed leg really armed under X11 with hooks hit and stayed armed through the screenshot, and the unarmed leg ran with the extension absent |
| 7   | `new-drawings-visible`                                                                   | every calibrator-2 drawing in `expected.json` `draw_paths.visible_samples` covers its sample pixel in `unarmed.png` (so also in the byte-identical `armed.png`), including a pixel only the per-frame mesh vertex update reaches                              |
| 8   | `no-mprotect-after-arm`                                                                  | no `mprotect` after the `armed.marker` `openat` intersects any range in `fingerprint.json`'s `exe_maps`                                                                                                                                                       |
| 9   | `optional-hook-counts`                                                                   | every optional hook (calibrators 2 and 3) is installed (`hooks_omitted` empty) and its count is > 0                                                                                                                                                           |
| 9   | `triangle-array-bit-exact`                                                               | the scripted triangle array's indices, points, colours, UVs, empty bones/weights, texture and count, bit-exact                                                                                                                                                |
| 9   | `stylebox-panel-native`                                                                  | a native triangle array on another item whose every colour is the StyleBoxFlat `bg_color` (opaque fill, alpha-0 feather), plus the Panel's `canvas_item_set_modulate` on that item                                                                            |
| 9   | `shader-material-path`                                                                   | `canvas_item_set_material` on the Panel's item; `material_set_param` on that material; `shader_set_code` on a shader `shader_create_from_code` returned                                                                                                       |
| 9   | `nine-patch-bit-exact`                                                                   | the scripted nine-patch's every argument (including the stack-passed modes, `draw_center` and modulate) bit-exact on the 4×4 texture's RID; the NinePatchRect's native one on the same RID                                                                    |
| 9   | `scripted-shapes-bit-exact`                                                              | the scripted primitive, line, polyline, `add_set_transform` and circle, bit-exact                                                                                                                                                                             |
| 9   | `mesh-surface-and-draw`                                                                  | `mesh_create` → `mesh_add_surface` (primitive, format, counts, buffer sizes, AABB read from `SurfaceData`) → `canvas_item_add_mesh` (transform, modulate) on one RID; an `add_multimesh`; a `mesh_clear` on the other mesh                                    |
| 9   | `mesh-region-updates`                                                                    | vertex/attribute region writes on that mesh with exact surface, offset, size and bytes, at least 55 times in the 60 armed frames; `mesh_set_custom_aabb` with the exact AABB                                                                                  |
| 10  | `older-record-loads`                                                                     | the `old-record` leg armed and disarmed cleanly, `hooks_omitted` is exactly the optional (calibrator 2 and 3) set with `null` counts, gate −1 counts > 0, and `calibration-check.json` `hook_plan` is ok and names each omitted hook                          |

Criteria 9 and 10 go beyond the handoff's gate −1 list. They cover the draw paths
gate −0.25 counts on the real game, and the rule that a record from an older
calibrator still loads (`../README.md` "Calibration records and hook versions").
`rendered-legs-armed-and-absent` also requires the triangle-array, nine-patch,
mesh, multimesh and vertex-region counts to be > 0 on the GPU renderer.

## Checker self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-checker.ts
```

Builds a fabricated passing evidence tree in the real library's shapes, then one perturbation per
failure mode, and asserts each check's verdict: 30 scenarios, 73 assertions.

# Gate 0

Drives `../fixtures/gate0/` (capture host and rendered reference) and `../receiver/` through every
leg of [`../protocol/gate0-design.md`](../protocol/gate0-design.md) "Q6", then checks the gate.
Since G4e2 it runs on render-stream/3 (`recording.rs2`, full encoding; the file keeps its `.rs2`
name; render-stream/2 from G2b2 to G4e2, render-stream/1 from G1b2 to G2b2), and every capture leg sets `GRC_ROOT_SIZE=enforce-min-size`: without it the 64×64
headless host would declare `degenerate-host-size` and every leg would classify `unsupported`.
Every capture also writes its out-of-band resource store to `<capture>/store`
(`GRC_RESOURCE_STORE_DIR`; without it the capture refuses to publish with
`resource-store-missing`), and every file-mode receiver gets a fresh content-addressed cache at
`<receiver>/cache` (`RS_RECEIVER_CACHE_DIR`) and that store (`RS_RECEIVER_STORE_DIR`). Nothing in
the fixture draws a texture, so the only table entry is the one the engine creates itself in
frame 1 (the default theme's 800×6 RGBA8 ColorPicker hue strip, unreferenced), and a correct
receiver never fetches it. Run it from the repo root:

```bash
mise exec -- pnpm render-stream:gate0 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir]
```

As at gate −1, `--extension` and `--calibration` are required and the runner refuses at once
without them. `--binary` defaults to the pinned template (a sha256 mismatch only warns). `--out`
defaults to `artifacts/render-stream/gate0/<UTC>/` (ignored) and must not already hold files.
The runner needs `strace`, `gamescope` and the mise editor (`mise exec -- godot`).

Every rendered leg (`reference`, `receiver` and the three sabotage receivers) runs in **one**
private `gamescope --backend headless`, never Xvfb and never a desktop window. Headless legs strip
`DISPLAY` and `WAYLAND_DISPLAY`. Every launch, headless or rendered, first unsets every variable in
`lib/gamescope.sh` `GS_STRIP_VARS` (the gate −1 `GRC_*` set, `GRC_STREAM_OUT`, `GRC_SABOTAGE`,
`GRC_SABOTAGE_FRAME` and the documented `RS_*`) plus any other inherited `RS_*`. It then passes
only what its leg wants, and `env.txt` records that. The exit trap stops the owned Godot process
and tears down the compositor.

## Gate 0 files

- `run-gate0.sh`: the orchestrator.
- `gate0-tool.ts`: helpers the runners call between legs, on the checker's own decoder.
  `settle-seqs` is the step join that becomes `RS_RECEIVER_SHOT_SEQS`. `corrupt` writes the
  `corrupt` leg's copy, with the first meta byte of transaction seq 3 set to `0x00`.
  `seq-at-frame` names the transaction published at a frame (gate 1's tie-frame shots).
- `lib/gate0-checks.ts`: `summarizeRecording` (validates and resolves a /2 recording, patches
  included, to full per-transaction states with the texture table; resource records are skipped,
  so transactions are always by seq), `drawIndexTies` / `harmlessTieKeys` (invariant 9
  groups and their paint footprints), `classifyLeg` (pure), every check, and `runGate0`, which
  builds the report. It reuses gate −1's `checkHeadlessNoGpu(outDir, "capture")`,
  `successfulOpenats` and PNG decoding.
- `check-gate0.ts`: writes `<out>/result.json` (`render-stream-gate0-report/1`) and exits non-zero
  unless `gate_passed`.
- `test/self-test-gate0.ts`: see "Gate 0 self-test" below.

## Gate 0 legs and evidence under `--out`

Every process directory holds `argv.txt` (one argument per line), `env.txt`, `stdout.log` (stdout
and stderr together) and `exit-code.txt`. `binary.json` at the top holds the template path and
sha256, and `gamescope/` holds the compositor's log and identity.

| Leg                       | Directory                                | Runs                                                                                                                                                                                           | Expected class                           |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `import`                  | `import/{fixture,receiver}/`             | `mise exec -- godot --headless --path <project> --import`. The runner stops if either fails                                                                                                    | — (exit 0)                               |
| `receiver-typecheck`      | `receiver-typecheck/{selftest,minimal}/` | mise editor: `--script res://tests/codec2_selftest.gd` with `RS_SELFTEST_GOLDEN_DIR=protocol/golden-2`, then a headless replay of `golden-3/inline.rs3` (inline, no store; a fresh cache; `golden-2/inline.rs2` before G4e2)      | —                                        |
| `capture`                 | `capture/`                               | template `--headless`, `GRC_MODE=arm`, `GRC_STREAM_OUT`, `GRC_ROOT_SIZE=enforce-min-size`, `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_QUIT_FRAME=400`, under strace; maps/fd sampled at `armed.marker` | `success`                                |
| `preexisting`             | `preexisting/`                           | the capture host on `res://preexisting.tscn`, quit 52                                                                                                                                          | `capture-failure`                        |
| `unsupported`             | `unsupported/{capture,receiver}/`        | capture with `RS_FIXTURE_VARIANT=unsupported`, quit 52, then a headless receiver                                                                                                               | `unsupported`                            |
| `sabotage-<kind>`         | `sabotage-<kind>/{capture,receiver}/`    | capture, quit 52, `GRC_SABOTAGE` `freeze-frame` / `omit-update` / `perturb-transform`, `GRC_SABOTAGE_FRAME=21`, then a gamescope receiver with the settle shots                                | `pixel-mismatch` {2,3,4} / {2} / {2,3,4} |
| `corrupt`                 | `corrupt/`                               | headless receiver on a copy of `capture/recording.rs2` whose transaction seq 3 has its first meta byte set to `0x00`                                                                           | `replay-failure` (seq 3, `meta-json`)    |
| `receiver-headless-trace` | `receiver-headless-trace/`               | headless receiver on a copy of the capture recording, under `strace -f -e trace=openat`                                                                                                        | — (applied ok)                           |
| `reference`               | `reference/`                             | template in gamescope, extension absent, `RS_FIXTURE_SHOT_DIR` → `shots/step-<k>.png`, `RS_FIXTURE_STEP_LOG`                                                                                   | — (5 shots)                              |
| `receiver`                | `receiver/`                              | template in gamescope on a copy of the capture recording, `RS_RECEIVER_SHOT_SEQS` set to the settle seqs (`shot-seqs.txt`)                                                                     | `success`                                |

Capture directories add `evidence/` (`GRC_EVIDENCE_DIR`, with `resources.jsonl` since G2b2),
`recording.rs2`, `store/` and `steps.jsonl`, and the `capture` leg adds `strace.txt`, `maps.txt`
and `fd.txt`. Receiver directories add their own `recording.rs2` copy, `cache/` and `applied.json`
(`render-stream-receiver-applied/3`). Rendered ones also add `shots/seq-<n>.png`,
`display-ownership.json` and the checker's `diff/step-<k>.png`. A rendered receiver whose step join
fails is not launched: `step-join.log` says why, and the leg classifies as `capture-failure`.

## Gate 0 classification

`classifyLeg` takes the capture `result.json`, the host recording (its `validateRecording()` errors
and decoded transactions; for `corrupt`, the uncorrupted capture recording), the step join, the
receiver's `applied.json` and shots, and the checkpoints. It never reads `session.sabotage`. The
first class that fires wins, and `reasons` lists every rule that fired:

1. `capture-failure`: status not `armed`; `stream.status` not `closed`; recording missing; any
   `validateRecording` error; any `capture-failure` transaction; `step-join-failed`.
2. `unsupported`: any transaction `unsupported` entry or `unsupported` command, or a non-empty
   `applied.json` `unsupported`, except a `draw-index-tie` entry whose tie is harmless: its
   drawing members' paint footprints (every visible `add_rect` of the subtree, mapped through the
   transforms, grown by 1 px; unbounded with an unsupported command) are pairwise disjoint, so no
   order of the group changes a pixel (gate1-design.md D7 as amended by G1b2). The leg lists
   those in `harmless_ties`.
3. `replay-failure`: `applied.json` missing or unparseable, status not `ok`, `end_seen` false,
   applied seqs not exactly 1..N with the host's `record_sha256`s, or a requested shot missing.
4. `pixel-mismatch`: any checkpoint (full frame, subject or marker region) with mismatched pixels
   or a non-zero channel delta against the reference.
5. `success`.

Legs without a receiver (`capture`, `preexisting`) stop after rule 2.

## Gate 0 criteria

| Check                           | Passes when                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture-armed`                 | `capture` `result.json` is `armed` with `stream.status` `closed`; `counters.json` and session `hooks_omitted` are empty; `hooks_planned` is exactly the 44 hooks named by the committed calibration record (calibrators 3 and 4)                                                                                                                                                                     |
| `headless-no-gpu`               | gate −1's check over `capture/`: display server `headless`, and no GPU device or library in the successful `openat`s, `maps.txt` or `fd.txt`                                                                                                                                                                                                                                                         |
| `recording-decodes`             | `validateRecording` is `[]`, the first transaction has frame 1, and there are 400 transactions                                                                                                                                                                                                                                                                                                       |
| `manifest-present`              | session `protocol` `render-stream/3` (since G4e2), a full file stream, the exact /3 `features` (`resources` key included; `ops` with `add_msdf_texture_rect_region`, which `observed_unsupported_ops` no longer lists), the file sinks' `resources` (out-of-band, `directory` fetch, the six permitted formats), `engine.display_server` `headless`, `viewport.root_canvas` 1, `root_size_policy` `enforce-min-size` with `host_size_status` `match` and 640×360 logical and window sizes, and `sabotage` null |
| `step-alignment`                | `capture` and `reference` `steps.jsonl` equal `expected.json`'s frames, and each step's marker colour (as float32) first appears at its applied frame                                                                                                                                                                                                                                                |
| `expected-image-reference`      | every `reference/shots/step-<k>.png` equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                          |
| `expected-image-receiver`       | every receiver settle shot equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                                    |
| `receiver-vs-reference`         | receiver vs reference at every step, full frame and both regions: 0 mismatched pixels and max channel delta 0 (`compareRgbaBuffers` with exact budgets)                                                                                                                                                                                                                                              |
| `receiver-consumed-stream`      | `receiver` `applied.json` is `render-stream-receiver-applied/3`, seqs 1..N, each `record_sha256` equal to the host's, every shot `applied_through == seq`, `recording.sha256` equal to the capture file's, and `resources_summary` shows nothing fetched and nothing uploaded                                                                                                                        |
| `receiver-never-loaded-fixture` | the traced receiver opens its recording and nothing under `fixtures/`; no file in `receiver/` (outside `.godot/`) is byte-identical to one in `fixtures/gate0/`; no receiver log has a `[fixture]` line; argv has `--path <abs receiver>`                                                                                                                                                            |
| `receiver-typed-clean`          | no `SCRIPT ERROR`, `SCRIPT WARNING`, `Parse Error` or `Failed to load script` in the typecheck logs; the selftest printed `[rs2-selftest] ok` and exited 0; the `golden-3/inline.rs3` replay is ok and reports exactly the golden's unsupported entries, each at its first seq                                                                                                                       |
| `leg-class-<leg>`               | each classified leg has its expected class; sabotage legs mismatch at exactly the expected steps with steps 0–1 matching; `preexisting` names `pre-existing-object`; `corrupt` fails at `{seq:3, reason:"meta-json"}`                                                                                                                                                                                |

`gate_passed` is true only when every check passed.

## Gate 0 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate0.ts
```

It runs `classifyLeg` over:

- every class alone;
- every pair of classes, checking precedence and that both reasons are listed;
- each sub-rule;
- a leg without a receiver;
- a session whose `sabotage` is set, or whose getter throws;
- draw-index ties: disjoint (harmless, `success`) against overlapping (`unsupported`), hidden or
  culled members, an unbounded footprint, adjacent rects, a child's rect through its parent.

It then builds a passing evidence tree for the whole layout, with recordings encoded in
render-stream/3 (since G4e2) by `test/rs2-test-encoder.ts` (every texture table holding the engine's hue
strip), `applied.json` on `/3`, and PNGs synthesized from the timeline, plus one perturbation per
failure mode (since G2b2 also: an applied `/2` schema, a receiver that fetched the hue strip, an
inline capture session). It runs the real `runGate0` on each: 40 scenarios, 205 assertions. It
also checks that `corruptTransactionMeta(golden-2/patch.rs2, 3)` reproduces
`golden-2/corrupt-meta.rs2` byte for byte, and that on an inline stream (a resource record before
seq 1) it still breaks transaction seq 3, not record 3. `test/rs1-test-encoder.ts` (render-stream/1)
stays only while `self-test-gate2.ts` uses it.

# Gate 1

Drives `../fixtures/gate1/` and `../receiver/` through the leg groups of
[`../protocol/gate1-design.md`](../protocol/gate1-design.md) "Q7", then checks them. Groups `g1a`
(increment G1a: retained-state fixture, root geometry), `g1b` (G1b2: the patch sink and its
equivalence with the full sink, the omit-op and patch-drop sabotages, the one-frame
draw-index tie), `g1c` (G1c2: live delivery over the capture library's WebSocket server, credit,
recording/live equivalence, the drop-message sabotage) and `g1d` (G1d: a two-second receiver stall
with coalescing and newest-state recovery, resync, reconnect, a killed receiver, and the
ignore-credit and stale-coalesce sabotages) have landed. Since G2b2 every group runs on
render-stream/3 since G4e2 (render-stream/2 from G2b2, render-stream/1 from G1b2 to G2b2). Run it from the repo root:

```bash
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir] [--legs g1a,g1b,g1c,g1d]
```

The arguments and the refusals are gate 0's. `--out` defaults to
`artifacts/render-stream/gate1/<UTC>/`. `--legs` takes a comma-separated list of groups and
defaults to every landed group. `g1b`, `g1c` and `g1d` without `g1a` refuse with exit 2: g1b
compares against g1a's capture, reference and receiver, g1c and g1d against g1a's reference.
`legs.json` records the groups that ran. The checker evaluates only the checks of groups that ran.
A landed group that did not run is reported as `not-run` and fails the gate. The runner takes about
8 minutes.

The process plumbing is shared with `run-gate0.sh` through `lib/legs.sh`: `write_invocation`,
`wait_owned`, `run_headless`, `run_capture`, `prepare_recording`, `run_receiver_headless`,
`settle_seqs`, `seq_at_frame`, `run_rendered` and `run_rendered_receiver`. `run_capture` takes an
empty quit frame to mean the fixture's own default, and with `CAPTURE_WITH_PATCH=1` (every gate 1
capture) also sets `GRC_STREAM_PATCH_OUT`, so each capture writes `recording.rs2` (full) and
`recording-patch.rs2` (patch). Since G2b2 `run_capture` also sets `GRC_RESOURCE_STORE_DIR`:
`CAPTURE_STORE_DIR` unset or empty means `<capture>/store`, the literal `none` omits the variable,
anything else is used as the store (reset after the call, like `CAPTURE_EXTRA_ENV`).
`run_receiver_headless <dir>` always sets `RS_RECEIVER_CACHE_DIR=<dir>/cache`, and
`RS_RECEIVER_STORE_DIR` when `RECEIVER_STORE_DIR` is non-empty (reset after the call).
`run_rendered_receiver` takes `RECEIVER_SOURCE` (replay the patch recording),
`RECEIVER_EXTRA_SHOTS` (the tie seq), `RECEIVER_STATE=1` (`RS_RECEIVER_STATE_SEQS` at the settle
seqs) and `RECEIVER_EXTRA_ENV` (an array of extra `NAME=value` words), all reset after the call; it
always sets `RS_RECEIVER_CACHE_DIR=<receiver>/cache`, and `RS_RECEIVER_STORE_DIR=<capture>/store`
when that directory exists. Every launch strips `GS_STRIP_VARS`, which lists every variable
gate1-design.md introduces plus `RS_FIXTURE_SHOT_FRAMES` and `RS_FIXTURE_TIE`, and every other
inherited `GRC_*` and `RS_*`. Each group's rendered legs share one private gamescope. G1c2 added
`start_headless_bg`/`finish_bg` (a live host runs in the background while its receiver runs) and
`RENDERED_EXTRA_ARGS` (a rendered live receiver gets `--max-fps 60`). G1d added
`LIVE_RECEIVER_ENV` (the receiver's G1d option for one leg) and `killed_receiver` (a background
headless live receiver, SIGKILLed once the host's `tap/live-1.jsonl` reaches a frame).

## Gate 1 files

- `run-gate1.sh`: the orchestrator (`--legs` groups; `run_g1a`, `run_g1b`, `run_g1c` with
  `start_live_host`, `live_receiver` and `live_windows`; `run_g1d` with `killed_receiver`).
- `lib/legs.sh`: the shared leg plumbing (above).
- `lib/gate1-expected.ts`: the `render-stream-gate1-expected/1` types (with `draw_index_ties`),
  `stepFrames`, and `synthesizeGate1(expected, step)` (clear colour, then every draw in paint
  order, clipped).
- `lib/gate1-checks.ts`: `statesOf` (resolved per-transaction states from gate 0's
  `summarizeRecording`), `mapNames`, `evaluateInvariants`, `patchDivergence`, `classifyGate1`,
  `recordingTies`, every check and `runGate1`. It reuses gate 0's `classifyLeg`, the capture,
  manifest, consumption, fixture-access and typed-receiver checks, the step join and the tie
  analysis.
- `lib/gate1-live-checks.ts` (G1c2): the live legs' evaluation and classification
  (`evaluateLiveLeg`, `deliveryReport`, which recomputes in-flight transactions from the host's
  live log), the g1c checks and the report's `live` object.
- `lib/gate1-g1d-checks.ts` (G1d): the g1d legs' evaluation and classification
  (`evaluateG1dLeg`, per host connection; `stallReport`, which reads the stall, the pending target
  and the recovery off the host's live log), the g1d checks and the report's `g1d` object.
- `gate0-tool.ts live-shot-seqs <applied.json>`: the seqs a live receiver shot (for `live-replay`).
- `check-gate1.ts`: writes `<out>/result.json` (`render-stream-gate1-report/1`) and exits
  non-zero unless `gate_passed`.
- `test/self-test-gate1.ts` and `test/rs2-test-encoder.ts`: see "Gate 1 self-test" below.

## Gate 1 legs and evidence under `--out`

Process directories are laid out as at gate 0. Capture directories hold both recordings, the
resource store `store/` and `evidence/root.json` (`render-stream-root-geometry/1`, quoted in the
report; the root geometry the checks use is the session's). The `capture` and `root-size-observe` captures and the
`reference` also hold `root.jsonl` (`RS_FIXTURE_ROOT_LOG`). The tie frames are `S + N` (11, step
1's `T`) and, since G1e, `S + 11N` (111, step 11's `ZP`) and `S + 12N` (121, step 12's `ZB`/`BP`).

| Group | Leg                       | Directory                                   | Runs                                                                                                                                                                  | Expected class                                                                                                                                    |
| ----- | ------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| g1a   | `import`                  | `import/{fixture,receiver}/`                | mise editor `--import` of `fixtures/gate1` and `receiver`                                                                                                             | — (exit 0)                                                                                                                                        |
| g1a   | `receiver-typecheck`      | `receiver-typecheck/{selftest,minimal}/`    | as gate 0, for `receiver-typed-clean`                                                                                                                                 | —                                                                                                                                                 |
| g1a   | `capture`                 | `capture/`                                  | template `--headless`, `GRC_MODE=arm`, `GRC_ROOT_SIZE=enforce-min-size`, both sinks, quit 400, root log, under strace; maps/fd at `armed.marker`                      | `success` (its three ties, at frames 11, 111 and 121, are harmless)                                                                               |
| g1a   | `sabotage-omit-<name>`    | `sabotage-omit-<name>/{capture,receiver}/`  | capture (enforce, default quit 132) with `GRC_SABOTAGE=omit-update` at step k's frame `1+10k`, then a rendered receiver                                               | `pixel-mismatch`: modulate (k=1) {1..12}, transform (2) {2..12}, order (3) {3}, visibility (7) {7..12}                                            |
| g1a   | `root-size-observe`       | `root-size-observe/{capture,receiver}/`     | capture with `GRC_ROOT_SIZE` unset (root log), then a rendered receiver                                                                                               | `unsupported` (`degenerate-host-size`), mismatching only in `corner` and `corner-degenerate`                                                      |
| g1a   | `receiver-headless-trace` | `receiver-headless-trace/`                  | headless receiver on the capture recording under `strace -e openat`                                                                                                   | — (applied ok)                                                                                                                                    |
| g1a   | `reference`               | `reference/`                                | template in gamescope, extension absent, shots `step-0..12` and `frame-{11,111,121}` (`RS_FIXTURE_SHOT_FRAMES`), step log, root log                                   | — (16 shots)                                                                                                                                      |
| g1a   | `receiver`                | `receiver/`                                 | template in gamescope on `capture/recording.rs2`, shots at the 13 settle seqs and the 3 tie seqs, state dumps at the settle seqs                                      | `success`                                                                                                                                         |
| g1b   | `receiver-patch`          | `receiver-patch/`                           | as `receiver`, on `capture/recording-patch.rs2`                                                                                                                       | `success`                                                                                                                                         |
| g1b   | `sabotage-omit-free`      | `sabotage-omit-free/{capture,receiver}/`    | capture with `GRC_SABOTAGE=omit-op`, `GRC_SABOTAGE_OP=free` from step 8's frame (81), then a rendered receiver                                                        | `pixel-mismatch` {8,9,10,11,12}                                                                                                                   |
| g1b   | `sabotage-omit-visible`   | `sabotage-omit-visible/{capture,receiver}/` | `omit-op` `canvas_item_set_visible` from step 6's frame (61)                                                                                                          | `pixel-mismatch` {6}                                                                                                                              |
| g1b   | `sabotage-patch-drop`     | `sabotage-patch-drop/{capture,receiver}/`   | capture with `GRC_SABOTAGE=patch-drop-item` at step 5's frame (51), then a rendered receiver on its patch recording                                                   | `capture-failure` (`patch-divergence`)                                                                                                            |
| g1c   | `live-headless`           | `live-headless/{host,receiver}/`            | live host (below) + headless live receiver under `strace -e openat`, credit stage `applied`, no shots                                                                 | `success`                                                                                                                                         |
| g1c   | `live`                    | `live/{host,receiver}/`                     | live host + rendered live receiver (`--max-fps 60`), shot windows `k:[S+Nk+7, S+N(k+1)-1]` for steps 0..12, the last ending at the quit frame                         | `success`                                                                                                                                         |
| g1c   | `live-replay`             | `live-replay/`                              | rendered file-mode receiver on `live/receiver/received.rs2` (inline: no store, a fresh cache), shooting (and dumping) the live shots' seqs                            | `success`                                                                                                                                         |
| g1c   | `sabotage-drop-message`   | `sabotage-drop-message/{host,receiver}/`    | live host with `GRC_SABOTAGE=drop-message`, `GRC_SABOTAGE_FRAME=S+4N+20` (560), + rendered live receiver                                                              | `replay-failure` (`seq-gap`), failing at the seq after the dropped one                                                                            |
| g1b   | `tie-overlap`             | `tie-overlap/{capture,reference,receiver}/` | capture with `RS_FIXTURE_TIE=overlap` (T over P), the variant's rendered reference with `frame-11`, a rendered receiver shooting the tie seq                          | `unsupported` (`draw-index-tie`); only the step-1 tie is not harmless, the two G1e ties still are; the tie frame's pixels are measured, not gated |
| g1d   | `live-stall`              | `live-stall/{host,receiver}/`               | live host + rendered live receiver with `RS_RECEIVER_STALL=1:2000` (blocks 2 s after its step 1 shot, before that seq's `submitted` ack)                              | `success`; the step windows wholly inside the stall (step 2) may be missed                                                                        |
| g1d   | `live-reconnect`          | `live-reconnect/{host,receiver}/`           | live host + rendered live receiver with `RS_RECEIVER_RECONNECT=4` (close 1000, dispose, connection 2)                                                                 | `success`                                                                                                                                         |
| g1d   | `live-resync`             | `live-resync/{host,receiver}/`              | live host + rendered live receiver with `RS_RECEIVER_RESYNC=6` (refuses step 6's first transaction, sends `resync`)                                                   | `success`                                                                                                                                         |
| g1d   | `live-receiver-killed`    | `live-receiver-killed/{host,receiver}/`     | live host + headless live receiver, SIGKILLed once the host log shows frame `S+5N` (600); `receiver/killed.json`                                                      | — (`host-survives-receiver-loss`)                                                                                                                 |
| g1d   | `sabotage-ignore-credit`  | `sabotage-ignore-credit/{host,receiver}/`   | live host with `GRC_SABOTAGE=ignore-credit` from `S+3N` (480) + rendered live receiver with `RS_RECEIVER_STALL=3:500` (holds its credit 500 ms after the step 3 shot) | `delivery-violation` (in flight, sent without credit), every violation at or after 480                                                            |
| g1d   | `sabotage-stale-coalesce` | `sabotage-stale-coalesce/{host,receiver}/`  | live host with `GRC_SABOTAGE=stale-coalesce` from `S+N` (360) + rendered live receiver with `RS_RECEIVER_STALL=1:2000`                                                | `delivery-violation` (`stale-state`), naming the first post-stall transaction                                                                     |

A live host is the template, `--headless --max-fps 60`, armed, `GRC_ROOT_SIZE=enforce-min-size`,
both file sinks with their store (`GRC_RESOURCE_STORE_DIR=<host>/store`), `GRC_LIVE_LISTEN=127.0.0.1:0`, `GRC_LIVE_TAP_DIR=<host>/tap`, and the live timeline
`RS_FIXTURE_START_FRAME=300`, `RS_FIXTURE_STEP_FRAMES=60`, `RS_FIXTURE_QUIT_FRAME=1080` (`S + 13N`; 960 before G1e). The runner
waits for `evidence/live.json` and passes its port to the receiver. Host directories hold
`evidence/{result,live,live-summary,root}.json`, both recordings, `steps.jsonl`,
`tap/stream-1.rs2` (every binary message formed for connection 1) and `tap/live-1.jsonl` (the live
log); live receiver directories hold `applied.json` (`mode: live`), `received.rs2`,
`shots/seq-<n>.png` and `state/seq-<n>.json`. After a reconnect (G1d) the host also holds
`tap/stream-2.rs2` and `tap/live-2.jsonl`, and the receiver `received-2.rs2`,
`shots/stream-2-seq-<n>.png` and `state/stream-2-seq-<n>.json`. Frame lines of the live log carry
`pending_since` (the frame the pending target became pending, or null) and the summary
`max_pending`, `pending_episodes`, `max_pending_frames`, `max_pending_age_us`,
`sent_without_credit` and `stale_sent`. Since G4e2 the subprotocol is `render-stream.3` (`render-stream.2` from G2b2). A live
connection carries payloads of at most `inline_max_bytes` as resource records, one binary message
each, right before the transaction that first needs them (a `resource` event line; the summary's
`resource_records`/`resource_bytes`), and since G2c2 serves larger ones over HTTP: gate 1's hosts
run the default out-of-band policy, so every live receiver gets a fresh `cache/`, although no
gate 1 command names a texture and nothing is fetched. Not every message after the first is
necessarily a transaction, so the checks find transactions by seq only.

## Gate 1 classification

`classifyGate1` takes gate 0's `classifyLeg` result (draw-index ties included: a harmless tie is
listed, not a reason), the leg's session and the frame-by-frame comparison of its capture's two
sinks (canvases, items, the default texture filter/repeat and the texture table). It adds three rules. A recording without a session is `capture-failure`. A patch sink that
does not resolve, bit for bit, to the full sink's state at every frame is `capture-failure`
(`patch-divergence`). A session `host_size_status` other than `match` is `unsupported`
(`degenerate-host-size`); under `enforce-min-size` the recording also carries the
`root-size-enforce-failed` failure, which gate 0's rules already make `capture-failure`. The
precedence is gate1-design.md Q7's: `capture-failure`, `unsupported`, `replay-failure`,
`delivery-violation`, `pixel-mismatch`, `success`. Checkpoints
compare the full frame, all eleven `expected.json` regions (nine plus G1e's `z-relative` and
`behind`), and count the mismatching pixels outside every region; a checkpoint names its leg and stream (`full` or `patch`).

Live legs (`gate1-live-checks.ts`) add: `capture-failure` for a host that did not listen or a tap
that is not a valid stream (a tap the receiver closed before the end record may lack it);
`replay-failure` for the receiver's status, end record, transactions that are not exactly the
received stream, received bytes that differ from the host's tap, a receiver that joined late (its
first applied frame at or after step 0's settle frame), and a step window without a shot
(rendered legs); `delivery-violation` for two transactions in flight (recomputed from the log's
own ack lines), a send logged without credit, queued bytes above the largest credit window (a
transaction plus the messages sent ahead of it since the previous one: resource records, and for
seq 1 the magic and session) + 4096, and
`stale-state`: a tapped transaction whose resolved state differs from the full recording's at its
frame; `pixel-mismatch` for a step shot that differs from the reference. `live-replay` is
classified as a file-mode receiver on the received stream, shooting the live shots' seqs.

G1d legs (`gate1-g1d-checks.ts`) apply the same rules to every host connection, with two
exceptions. A connection the receiver closed itself (the first one of a reconnect) may stop short
of the host's tap: what it received must be a byte prefix of the tap, and may lack the end record.
A stall leg may miss exactly the step windows that lie wholly between the stalled seq's send and
the recovery send, as the host log places them; any other missing shot is `replay-failure`.

## Gate 1 criteria

| Check                                                                                                                           | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expected-self-consistent`                                                                                                      | `expected.json` obeys its rules: 640×360, steps 0..12, every colour on the 51-step grid with alpha 255, every draw inside a region and none in `[0,0,72,72]`, one marker colour per step used by nothing else, known names, step 10 = step 9 shifted                                                                                                                                                                                                                                                             |
| `capture-armed`, `headless-no-gpu`, `recording-decodes`, `manifest-present`, `receiver-consumed-stream`, `receiver-typed-clean` | gate 0's checks, on the gate 1 layout (400 transactions, the /2 feature arrays and file `resources`, an enforced `match` host, applied `/3` with no texture traffic)                                                                                                                                                                                                                                                                                                                                             |
| `step-alignment`                                                                                                                | capture and reference `steps.jsonl` list 0..12 at `S+N·k` (settle `+7`); each step's marker colour first appears at its applied frame                                                                                                                                                                                                                                                                                                                                                                            |
| `expected-image-reference`, `expected-image-receiver`                                                                           | every reference shot, and every receiver settle shot, equals `synthesizeGate1(k)` exactly                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `receiver-vs-reference`                                                                                                         | 13 steps, full frame and every region, 0 mismatched pixels and max channel delta 0                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `retained-invariants`                                                                                                           | every `expected.json` invariant holds on its step's settle transaction. Names map to wire ids in creation order, cross-checked against the step-0 rect colours                                                                                                                                                                                                                                                                                                                                                   |
| `root-geometry`                                                                                                                 | gate1-design.md Q1 1–3 from the session: logical size = the reference's content scale size, visible size and window size; the enforced host declares `match`, `host_visible_rect` `0,0,640,360`, identity `host_final_xform` and a 640×360 window, and its `root.jsonl` equals the reference's except `display_server`; canvas 1's transform at every settle equals the reference's (float32)                                                                                                                    |
| `receiver-never-loaded-fixture`                                                                                                 | gate 0's check, against `fixtures/gate1/`, scanning every g1a and g1b receiver log                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `patch-resolves-to-full` (g1b)                                                                                                  | the capture's patch sink is valid and resolves to the full sink's state at every frame (texture table and default filter/repeat included), floats bit for bit                                                                                                                                                                                                                                                                                                                                                    |
| `patch-first-full` (g1b)                                                                                                        | patch sink: seq 1 full, every later seq a patch on `seq-1`; full sink all full; one `session_id`, two `stream_id`s; end stats agree                                                                                                                                                                                                                                                                                                                                                                              |
| `patch-transform-only` (g1b)                                                                                                    | at step 2's frame `P` and `C` carry `commands:null` (`G` unchanged, absent) and `cmd_f32` holds only `R1`'s and the `Marker`'s floats; at step 10's frame canvas 1 is present and every item entry but the `Marker`'s carries `commands:null`; neither patch has a `textures` entry or a `removed_textures` id                                                                                                                                                                                                   |
| `patch-vs-full-pixels` (g1b)                                                                                                    | `receiver-patch`'s 13 settle shots equal `receiver`'s and the reference's exactly                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `patch-vs-full-receiver-state` (g1b)                                                                                            | at every settle seq both receivers' state dumps equal each other and the full recording's resolved state, and both made the same RenderingServer calls at every seq                                                                                                                                                                                                                                                                                                                                              |
| `patch-bytes` (g1b)                                                                                                             | recorded, not gated: both sinks' end stats and per-transaction bytes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `draw-index-ties` (g1b)                                                                                                         | the capture recording's invariant-9 ties are exactly `expected.json`'s `draw_index_ties` (frame 11 `{P, T}`, frame 111 `{P, ZP}`, frame 121 `{P, ZB, BP}`, all harmless), each declared on the wire                                                                                                                                                                                                                                                                                                              |
| `tie-frame-pixels` (g1b)                                                                                                        | `reference/shots/frame-<f>.png` equals both receivers' shot of that transaction exactly, for each of frames 11, 111 and 121                                                                                                                                                                                                                                                                                                                                                                                      |
| `live-listening` (g1c)                                                                                                          | every live host's `evidence/live.json` says `listening` on 127.0.0.1 or ::1 with an ephemeral port, `result.json` `live.port` agrees, and the receiver's URL used that port                                                                                                                                                                                                                                                                                                                                      |
| `live-handshake` (g1c)                                                                                                          | `live`, `live-headless`: subprotocol `render-stream.3` (since G4e2) negotiated, the host logged the hello (credit stage `submitted` / `applied`, the receiver's inbound buffer), one connection, no host error, the end record sent, and the receiver closed with 1000 after reading it                                                                                                                                                                                                                                       |
| `live-tap-equals-received` (g1c)                                                                                                | `live`, `live-headless`: `received.rs2` is byte-identical to the host's `tap/stream-1.rs2`, as `applied.json` `streams[0]` reports                                                                                                                                                                                                                                                                                                                                                                               |
| `live-decodes` (g1c)                                                                                                            | `validateRecording(received.rs2)` is `[]` for `live` and `live-headless`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `live-first-full-then-patch` (g1c)                                                                                              | the live session is `websocket`, connection 1, `patch`, the capture's `session_id`, a fresh `stream_id`; seq 1 full, every later seq a patch on `seq-1`                                                                                                                                                                                                                                                                                                                                                          |
| `live-resolves-to-recording` (g1c)                                                                                              | every live transaction, resolved, equals the full recording's state at its frame (texture table included), bit for bit                                                                                                                                                                                                                                                                                                                                                                                           |
| `live-replay-equals-live` (g1c)                                                                                                 | `live-replay` applied the same seqs with the same record hashes, and its shots and state dumps at the live shots' seqs equal the live receiver's                                                                                                                                                                                                                                                                                                                                                                 |
| `live-vs-reference` (g1c)                                                                                                       | `live` shot every step window, each shot equal to the reference's `step-<k>.png` and `synthesizeGate1(k)` exactly                                                                                                                                                                                                                                                                                                                                                                                                |
| `live-credit-bounded` (g1c)                                                                                                     | every live host log: at most one transaction in flight (recomputed), no send without credit, `queued_bytes` within the largest credit window + 4096                                                                                                                                                                                                                                                                                                                                                              |
| `live-acks-staged` (g1c)                                                                                                        | per seq `received_us <= applied_us <= submitted_us` (`submitted_us` null headless); the host saw every stage of every sent seq, matching the receiver's ack counts; `presented` is `"unavailable"`                                                                                                                                                                                                                                                                                                               |
| `live-receiver-late` (g1c)                                                                                                      | every live receiver's first applied transaction has a frame before step 0's settle frame (`S+7`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `receiver-never-loaded-fixture-live` (g1c)                                                                                      | the headless live receiver's trace opens nothing under `fixtures/` and opens its `received.rs2`; its argv passes `--path <receiver>`; no live receiver log has a `[fixture]` line                                                                                                                                                                                                                                                                                                                                |
| `stall-observed` (g1d)                                                                                                          | `live-stall`: the receiver's `live.stall` is the requested step, declared `injected`, blocked at least the requested 2000 ms, right after that step's shot                                                                                                                                                                                                                                                                                                                                                       |
| `sim-kept-running` (g1d)                                                                                                        | `live-stall`: from the stalled seq's send to its credit the host logged a frame line for every frame, at least 0.8 × 60 × 2 = 96 of them, at an average interval of at most 1.25 × 1/60 s, and the fixture applied at least one step in between                                                                                                                                                                                                                                                                  |
| `pending-bounded` (g1d)                                                                                                         | `live-stall`: through the whole leg at most one transaction in flight (recomputed) and one pending target, queued bytes within the largest credit window + 4096, nothing sent between the stalled seq and its credit                                                                                                                                                                                                                                                                                             |
| `coalesced` (g1d)                                                                                                               | `live-stall`: the coalesced counter grew by one per pending frame line, at least (frames from the first in-stall pending target to the credit) − 2, and the target became pending at the first in-stall step's frame (or the next)                                                                                                                                                                                                                                                                               |
| `newest-after-stall` (g1d)                                                                                                      | `live-stall`: the first transaction after the credit is a patch on the stalled seq, sent at most 2 frames after the credit, not stale, and equal to the full recording's state at its frame                                                                                                                                                                                                                                                                                                                      |
| `stall-pixels` (g1d)                                                                                                            | `live-stall`: the missed steps are exactly the windows inside the stall, every shot equals the reference, and the first post-stall shot shows every pixel the in-stall step changed that still shows then                                                                                                                                                                                                                                                                                                        |
| `reconnect-fresh-session` (g1d)                                                                                                 | `live-reconnect`: connection 1 closed by the receiver with 1000; connection 2 has a fresh `stream_id`, the same `session_id`, seq 1 full and equal to the full recording, then patches on its own seqs only, and validates                                                                                                                                                                                                                                                                                       |
| `reconnect-clean-slate` (g1d)                                                                                                   | `live-reconnect`: `dispose` freed exactly the RIDs the applier owned (created − freed while applying), none left; every connection-2 shot equals the reference                                                                                                                                                                                                                                                                                                                                                   |
| `resync-full` (g1d)                                                                                                             | `live-resync`: the refused seq is `skipped: "resync"`, never acked past `received`; the host logged the credited `resync`, the next transaction is full with `base_seq` null (2 full in all, 1 resync); the shots from step 6 on equal the reference                                                                                                                                                                                                                                                             |
| `host-survives-receiver-loss` (g1d)                                                                                             | `live-receiver-killed`: the receiver was SIGKILLed at or after frame 600, the host's connection closed 1006, the fixture logged its quit frame, the host exited 0, and both file sinks validate with an end record and reach the quit frame                                                                                                                                                                                                                                                                      |
| `leg-class-<leg>`                                                                                                               | each classified leg has its expected class; ignore-credit's violations start at or after its sabotage frame and the host counted sends without credit; stale-coalesce's first post-stall transaction is the stale one; sabotage legs mismatch at exactly their step sets; `root-size-observe` names `degenerate-host-size`, declares `degenerate-visible` with a 64×64 `host_visible_rect`, and mismatches in exactly `corner` and `corner-degenerate`; `tie-overlap`'s only tie is the step-1 tie, not harmless |

## Gate 1 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate1.ts
```

It first runs unit cases: `classifyGate1` (no session or a divergent patch sink is
`capture-failure`, a degenerate host is `unsupported`, and the precedence against gate 0's
classes) and `synthesizeGate1`, `mapNames`, `evaluateInvariants` and `recordingTies` on a model of
the fixture's retained state (the three harmless ties: T+P at step 1, and, since G1e, ZP+P at
step 11 and ZB+BP+P at step 12; the overlapping variant; a step-3 tie under
`Q`). It then builds a passing g1a+g1b evidence tree from that model, encoded in render-stream/2
in both encodings by `test/rs2-test-encoder.ts` (the hue strip in every texture table; live streams
inline, its resource record and `resource` event line ahead of seq 1, which seq 1's queued bytes
cover), with `applied.json` on `/3` and PNGs synthesized from `expected.json`.
Each check gets at least one failing perturbation, and the real `runGate1` runs on each tree. The
g1c legs are fabricated from the same model on a short live timeline (S = 30, N = 10): a host tap
and live log with one send every second frame, a receiver that shoots each step window, the
replay, the headless leg and the drop leg; the g1c perturbations cover a send without credit or
with a transaction in flight, oversized queues, a stale target, a tap that differs from the
received bytes, a late receiver, a missed window, wrong live and replay pixels, a missing
`submitted` ack, a host-side close, a non-loopback listener, a drop leg that never failed, a
fixture open, a full transaction after seq 1, a cut stream and missing groups. The g1d legs come
from a small simulation of the host's hub and the receiver on the same timeline (one send every
second frame, a 15-frame stall after the step 1 shot, a reconnect after step 4, a resync in step
6's window, the two sabotages and a killed receiver); the g1d perturbations cover a short stall, a
stall the host barely saw, a send during the stall, a coalesced counter that stops, a stale
recovery, a post-stall shot without the in-stall update, a missed window outside the stall, a
reused `stream_id`, leftover RIDs, a first connection that is not a prefix of its tap, a resync
answered by a patch, a host that did not survive or closed cleanly, sabotages that did not
sabotage (or did so too early), and missing groups. Since G2b2 also: a hue-strip change in a
transform-only patch, receiver state dumps without the texture table or with another default
filter, an applied `/2` schema, a live texture table that differs from the file recording's, queued
bytes past seq 1's credit window, and a `render-stream.1` handshake. 89 scenarios, 402 assertions.

# Gate 1, G1c1: `rs_ws` interop

`rs_ws` (`../capture/src/rs_ws.{h,cpp}`, `../protocol/gate1-design.md` G1c1) is a dependency-free
RFC 6455 WebSocket server on its own I/O thread. Its C++ unit test (`rs_ws` in `ctest`, run by
`build-capture.sh`) covers the handshake, framing, masking and limits against an in-process raw
socket. These two interop tests additionally prove it against two real WebSocket clients, driving
`../capture/test/rs_ws_echo.cpp` (a test-only echo server built alongside the unit test, not linked
into `render_stream_capture`): a text message that is all ASCII digits requests a binary push of
that many bytes (deterministic, `byte[i] = i % 256`); anything else is echoed back as text.

Run both from the repo root, after `build-capture.sh`:

```bash
experiments/render-stream/scripts/build-capture.sh
experiments/render-stream/scripts/test/run-rs-ws-interop.sh
```

Or by hand:

```bash
# Node (built-in WebSocket, Node >= 22; this repo pins Node 24 and has no `ws` package):
# spawns and kills its own rs_ws_echo.
mise exec -- pnpm exec tsx --conditions=development \
  experiments/render-stream/scripts/test/self-test-rs-ws.ts

# Godot (WebSocketPeer), against a separately started rs_ws_echo:
experiments/render-stream/capture/build/rs_ws_echo --port=0   # note the printed port
mise exec -- godot --headless --path experiments/render-stream/receiver --import   # once
RS_WS_ECHO_PORT=<port> mise exec -- godot --headless \
  --path experiments/render-stream/receiver --script res://tests/ws_selftest.gd
```

`self-test-rs-ws.ts` checks: the subprotocol negotiates, a text message is echoed verbatim, a
1 MiB and an 8 MiB binary push arrive byte-exact, and the close is clean. `ws_selftest.gd` checks
the same shapes from the engine's own client: with `inbound_buffer_size` raised to 16 MiB before
`connect_to_url`, an 8 MiB push arrives byte-exact; with the engine's 65535-byte default left in
place, a 1 MiB push closes the connection with 1009 (`modules/websocket/wsl_peer.cpp:405-410`).

# Gate 2

Drives `../fixtures/gate2/` through the leg groups of
[`../protocol/gate2-design.md`](../protocol/gate2-design.md) "Q7", then checks them. Groups `g2a`
(increment G2a: the fixture, its rendered reference and a same-build repeat, the extension-armed
reference, the RenderingServer texture-call census and the copy and hash at the hook) and `g2b`
(G2b2: render-stream/2 with textures -- the texture table against the hook log, the store and
inline records, cold/warm/patch/inline receivers, a live inline host, the unsupported variant and
the sabotages), `g2c` (G2c2: live resources over HTTP -- hosts serving payloads by hash with
pins and retirement, live receivers fetching before they apply, warm, replay, stall, reconnect and
animate legs, and the unpin, drop-resource and live wrong-hash sabotages), `g2d` (G2d:
`CanvasTexture` -- the typed refusal on a headless host, and per-command filter and repeat, the
`canvas-normal` variant and the omit-canvas-filter sabotage on a rendered host) and `g2e` (G2e:
bearer-token authorization) have landed. g2b, g2c and g2d need g2a's captures and reference, and g2d also
g2b's (`runG2b` judges g2d's legs with g2b's receiver checks), so `--legs g2b`, `--legs g2c` or
`--legs g2a,g2d` is refused. Run it from the repo root:

```bash
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir] [--legs g2a,g2b,g2c,g2d,g2e]
```

The arguments and refusals are gate 1's; `--out` defaults to `artifacts/render-stream/gate2/<UTC>/`.
The runner takes about fifteen minutes for all five groups (g2c's nine and g2e's three live hosts
run 971 frames at 60 frames per second each). It uses `lib/legs.sh` (`run_headless`, `run_capture`,
`run_rendered`, `settle_seqs`, `start_headless_bg`) and one private gamescope per group.
`GS_STRIP_VARS` lists every `GRC_*` and `RS_*` variable gate2-design.md introduces, landed or not.

## Gate 2 files

- `run-gate2.sh`: the orchestrator (`run_g2a`, `run_g2b`, `run_g2c`, `run_g2d`, `run_g2e`,
  `run_reference`, `g2_capture`, `g2_capture_rendered`, `g2_receiver`, `start_live_host`,
  `live_windows`, `g2c_receiver`, `g2c_leg`).
- `lib/gate2-expected.ts`: the `render-stream-gate2-expected/1` types, `stepFrames2`,
  `stepOfFrame` (the census windows), `texel`, `sampleAt` and `synthesizeGate2(expected, step,
{variant, frame})`: the clear colour, then every draw in paint order, flat or sampled the way the
  GLES3 canvas shader samples (flip, transpose, then nearest at pixel centres with clamp, modulo or
  mirror wrap), alpha 255 replacing and 0 skipping. Since G2b2 every step also carries
  `receiver_resources`, the fresh-cache receiver's texture traffic derived from D5.
- `lib/gate2-checks.ts`: the hook-log and fixture-log parsers (`render-stream-resource-log/1`
  lines are validated key by key, in order; G2b2's `store`/`inline` lines and trailing
  `sabotage`/`omitted` keys allowed and kept out of the census), `censusOf`/`expectedCensus`,
  every G2a check, `copyCosts` and `runGate2`. It reuses gate 0's capture, no-GPU and recording
  checks and its `classifyLeg`.
- `lib/gate2b-checks.ts`: group g2b: recording loading and resolution (render-stream-2.ts), the
  hook log replayed as ground truth (`textureLogDivergence`), fixture names to wire ids, every
  g2b check, `classifyG2bLeg`/`classifyLive` (gate2-design.md Q7's precedence, resource-violation
  included) and `runG2b`, which also judges g2d's four legs and checks when g2d ran (they reuse
  g2b's reference and receiver checks).
- `lib/gate2c-checks.ts`: group g2c: each live leg's host (per connection: tap, live log, gate 1's
  `deliveryReport`) and receiver, `pinsReport` (the pin and retire lines replayed against the full
  recording's state united with every open connection's base, frame by frame),
  `unadvertisedGets`, `getsVsFetches`, `fetchesAfterApplied`, the live checkpoints (the animate
  variant's anim region against `synthesizeGate2` at the shot's frame), every g2c check,
  `classifyG2cLeg` and `runG2c`.
- `lib/gate2e-checks.ts`: group g2e: `classifyG2eLeg` (host health plus the receiver's own
  `applied.json` status -- no pixel or resource-traffic comparison, unlike g2b/g2c, since
  gate2-design.md G2e's own checks ask for neither), `checkAuthRequired` (the host log shows
  401s exactly for the sabotage requests), `checkTokenNotLogged` (a raw byte search of every file
  under each g2e leg for its own host-generated token, `evidence/live-token` itself excepted) and
  `runG2e`.
- `check-gate2.ts`: writes `<out>/result.json` (`render-stream-gate2-report/1`) and exits non-zero
  unless `gate_passed`.
- `test/self-test-gate2.ts`, `test/gate2b-fixture.ts`, `test/gate2c-fixture.ts`: see below.

## Gate 2 legs and evidence under `--out`

| Leg                           | Group | Directory                             | Runs                                                                                                                                                                                                              |
| ----------------------------- | ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`                      | g2a   | `import/{fixture,receiver}/`          | the mise editor's `--import` of `fixtures/gate2` and `receiver/`                                                                                                                                                  |
| `capture`                     | g2a   | `capture/`                            | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps                                                                                       |
| `capture-unsupported`         | g2a   | `capture-unsupported/`                | the same with `RS_FIXTURE_VARIANT=unsupported`, the fixture's own quit frame, no strace                                                                                                                           |
| `reference`                   | g2a   | `reference/`                          | rendered in gamescope, extension absent: `shots/step-0..11.png`                                                                                                                                                   |
| `reference-repeat`            | g2a   | `reference-repeat/`                   | the same again                                                                                                                                                                                                    |
| `reference-armed`             | g2a   | `reference-armed/`                    | rendered, extension armed with `GRC_STREAM_OUT` and a store (so the hooks copy and hash), shots                                                                                                                   |
| `capture-inline`              | g2b   | `capture-inline/`                     | capture with `GRC_RESOURCE_INLINE_MAX_BYTES` = `GRC_RESOURCE_MAX_PAYLOAD_BYTES` = 16 MiB (delivery `inline`), no store, quit 400                                                                                  |
| `receiver-cold`               | g2b   | `receiver-cold/`                      | rendered receiver on `capture/recording.rs2`, fresh `cache/`, store = `capture/store`, shots and state dumps at the 12 settle seqs                                                                                |
| `receiver-warm`               | g2b   | `receiver-warm/`                      | a new rendered receiver on `receiver-cold/cache` with `RS_RECEIVER_CACHE_MODE=warm`                                                                                                                               |
| `receiver-patch`              | g2b   | `receiver-patch/`                     | rendered receiver on `capture/recording-patch.rs2`, its own fresh cache                                                                                                                                           |
| `receiver-inline`             | g2b   | `receiver-inline/`                    | rendered receiver on `capture-inline/recording.rs2`, fresh cache, no store                                                                                                                                        |
| `receiver-headless-trace`     | g2b   | `receiver-headless-trace/`            | headless receiver on `capture/` under `strace -e openat`                                                                                                                                                          |
| `live-inline`                 | g2b   | `live-inline/{host,receiver}/`        | host (`GRC_LIVE_LISTEN`, S = 300, N = 60, both sinks and a store) + headless live receiver (`applied` credit)                                                                                                     |
| `reference-unsupported`       | g2b   | `reference-unsupported/`              | rendered fixture, `RS_FIXTURE_VARIANT=unsupported`, extension absent                                                                                                                                              |
| `unsupported-textures`        | g2b   | `unsupported-textures/receiver/`      | rendered receiver on `capture-unsupported/`                                                                                                                                                                       |
| `sabotage-<name>`             | g2b   | `sabotage-<name>/{capture,receiver}/` | omit-update (`omit-op texture_2d_update` @61), omit-replace (`omit-op texture_replace` @71): captures + rendered receivers; stale-texture @61, wrong-hash @61, spurious-update @21: captures + headless receivers |
| `sabotage-receiver-*`         | g2b   | `sabotage-receiver-*/receiver/`       | headless receivers on `capture/`: `RS_RECEIVER_SABOTAGE=reupload` (fresh cache), `ignore-cache` (warm, on a copy of `receiver-cold/cache`)                                                                        |
| `live`                        | g2c   | `live/{host,receiver}/`               | live host (S = 300, N = 60, quit 971, both sinks, store, tap; fetch http) + rendered live receiver, fresh `cache/`, shot windows for the 12 steps                                                                 |
| `live-replay`                 | g2c   | `live-replay/`                        | rendered file-mode receiver on `live/receiver/received.rs2`, store = `live/receiver/cache`, shots and state dumps at live's shot seqs                                                                             |
| `live-warm`                   | g2c   | `live-warm/{host,receiver}/`          | a new host + a new rendered receiver on `live/receiver/cache`, mode warm                                                                                                                                          |
| `live-headless`               | g2c   | `live-headless/{host,receiver}/`      | host + headless receiver (`applied` credit) under `strace -e openat`                                                                                                                                              |
| `live-stall`                  | g2c   | `live-stall/{host,receiver}/`         | `RS_RECEIVER_STALL=5:1300`: the stall ends inside step 6's window, after step 6's texture update                                                                                                                  |
| `live-reconnect`              | g2c   | `live-reconnect/{host,receiver}/`     | `RS_RECEIVER_RECONNECT=7`                                                                                                                                                                                         |
| `live-animate`                | g2c   | `live-animate/{host,receiver}/`       | host `RS_FIXTURE_VARIANT=animate`, receiver `RS_RECEIVER_FETCH_DELAY_MS=100`                                                                                                                                      |
| `sabotage-unpin`              | g2c   | `sabotage-unpin/{host,receiver}/`     | as `live-animate`, host `GRC_SABOTAGE=unpin` from frame 1                                                                                                                                                         |
| `sabotage-drop-resource`      | g2c   | `sabotage-drop-resource/{host,…}/`    | host `drop-resource` @660 (step 6), headless receiver                                                                                                                                                             |
| `sabotage-wrong-hash-live`    | g2c   | `sabotage-wrong-hash-live/{host,…}/`  | host `wrong-hash` @660 (the store's corrupted copy served over HTTP), headless receiver                                                                                                                           |
| `canvas-headless`             | g2d   | `canvas-headless/{capture,receiver}/` | headless capture with `RS_FIXTURE_VARIANT=canvas` (step 11's SC draws through a `CanvasTexture`) + headless receiver: the typed refusal                                                                           |
| `canvas-host`                 | g2d   | `canvas-host/{capture,receiver}/`     | RENDERED capture host (gamescope, armed, store, its own `shots/`; `canvas` variant) + rendered receiver -- host-renderer evidence, not headless support                                                           |
| `canvas-normal`               | g2d   | `canvas-normal/{capture,receiver}/`   | rendered capture host, `RS_FIXTURE_VARIANT=canvas-normal` (CT also gets `normal_texture = B`) + rendered receiver -- host-renderer evidence                                                                       |
| `sabotage-omit-canvas-filter` | g2d   | `sabotage-omit-canvas-filter/{…}/`    | rendered capture host, `canvas` variant with `omit-op canvas_texture_set_texture_filter` @111 (step 11) + rendered receiver -- host-renderer evidence                                                             |
| `live-auth`                   | g2e   | `live-auth/{host,receiver}/`          | host `GRC_LIVE_AUTH=token` (writes `evidence/live-token`) + rendered live receiver, `RS_RECEIVER_TOKEN_FILE` the host's token, shot windows for the 12 steps                                                      |
| `sabotage-no-token`           | g2e   | `sabotage-no-token/{host,receiver}/`  | same host; headless receiver, no `RS_RECEIVER_TOKEN_FILE` -- the upgrade itself is refused (401)                                                                                                                  |
| `sabotage-bad-http-token`     | g2e   | `sabotage-bad-http-token/{host,…}/`   | same host; headless receiver, `RS_RECEIVER_TOKEN_FILE` the host's token (correct on the upgrade) and `RS_RECEIVER_SABOTAGE=wrong-http-token` (wrong on every resource GET)                                        |

Every fixture run writes `steps.jsonl` and `textures.jsonl` (`RS_FIXTURE_TEXTURE_LOG`). Every armed
run writes `evidence/resources.jsonl` (the hook log) and `evidence/root.json`, whose additive
`texture_defaults` holds the arm-time root filter and repeat. Payloads are written only under the
run directory: each capture's `store/`, each receiver's `cache/`.

## Gate 2 criteria (g2a)

`capture-armed` (56 hooks), `headless-no-gpu` and `recording-decodes` (400 transactions) are gate
0's. `step-alignment` reads the four step logs and the capture's marker colours.
`expected-image-reference` compares every reference shot with `synthesizeGate2` exactly outside the
step's `synth_exclude` regions. `reference-repeat-budget` diffs `reference` against
`reference-repeat` per region per step, fails on any difference outside `synth_exclude`, and
records the per-region maxima as the budget for later increments (`result.json` `repeat_budget`).
`armed-transparent` requires `reference-armed`'s shots to equal `reference`'s byte for byte.
`census` counts the hook log per step window in the capture and in `reference-armed` and requires
`expected.json` `census` exactly; only frees may follow the quit frame (scene teardown).
`hook-bytes-exact` pairs every fixture create and update in a permitted format with a hook line at
the same frame and thread and the same SHA-256, and every other content line with an
`engine_textures` entry. `worker-thread-create` requires D's create to be the only `other`-thread
line. `replace-retires-temp` follows each `texture_replace` back to its by-texture's create in the
same frame and forward to make sure that RID never appears again. `viewport-defaults` checks
`root.json` and the two root viewport filter calls. `unsupported-variant` checks U1's uncopied
`unsupported-format` line, the census with the variant's extras, and the drawn texture RIDs
(`counters.json` texture-rect captures) the log never saw created: none in `capture`, exactly
`PRE` in `capture-unsupported`. `leg-class-capture` requires class `success` (since G2b2 the
texture draws are commands, not unsupported entries) with `add_texture_rect` and
`add_texture_rect_region` in the recording.

## Gate 2 criteria (g2b)

| Check                                   | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings-decode-2`                   | both sinks of `capture`, `capture-inline` and `capture-unsupported` pass render-stream-2.ts `validateRecording`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `patch-resolves-to-full`                | each patch sink resolves to its full sink at every seq and frame, textures and defaults included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `store-complete`                        | every ok hash of either sink is a `sha256/<hash>.grt` in the capture's store that hashes to its name, nothing else is there, `index.jsonl` names each once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `inline-equals-store`                   | `capture-inline` declares delivery inline / fetch none, equals `capture` at every frame, and every inline payload equals the store's file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `texture-versions-current`              | every transaction's table (both sinks of three captures and the live host) agrees with the hook log replayed to its frame: version, kind, status, hash; nothing missing, nothing extra                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `texture-invariants`                    | every `expected.json` texture invariant on the capture's settle transactions; no replaced-away (temporary) id ever appears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `receiver-vs-reference`                 | the cold, warm, patch and inline receivers' settle shots equal the reference's exactly, full frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `canvas-texture-headless-refused` (g2d) | `canvas-headless`'s session lists `canvas_texture` under `unsupported_resources` (`canvas-texture-headless`) and not under `resources`; every `canvas_texture_*` hook line is `unsupported`/`canvas-texture-headless` with no id; no transaction has a canvas entry; from step 11 on exactly one item draws an `unsupported` `canvas-texture-headless` command (with its entry), none before; its receiver skips and reports it; `canvas-host` declares `canvas_texture` supported                                                                                                                                                                       |
| `canvas-texture-override` (g2d)         | at step 11 region `sc` of `canvas-host`'s own rendered frame equals `synthesizeGate2` (nearest, repeat enabled), although SC's own item filter is linear and its repeat disabled (the `CanvasTexture`'s own filter and repeat win)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `canvas-texture-wire` (g2d)             | `canvas-host` carries `CT` as a `kind: "canvas"` entry, diffuse naming `A`'s id, nearest/enabled, its version bumped per setter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `canvas-normal-region` (g2d)            | `canvas-normal`'s receiver differs from the reference only in region `sc`, and only from step 11 on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expected-image-receiver`               | `receiver-cold`'s shots equal `synthesizeGate2` outside `synth_exclude`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `transform-only-no-resource-traffic`    | steps 2 and 10: no texture call in the hook log, empty `textures`/`removed_textures` in the patch sink, every receiver resource counter 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `upload-accounting`                     | per step the cold and patch receivers' fetched/created/updated/replaced/freed equal `receiver_resources`; the inline receiver the same uploads with 0 fetches and its payloads inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `warm-cache`                            | `receiver-warm` fetches nothing, its hits equal `receiver-cold`'s fetches, and its uploads, `rs_calls`, shots and state dumps are identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fresh-cache`                           | `receiver-cold`'s cache started empty and ends holding exactly its verified fetches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `freed-draws-default`                   | at step 8 RAW1's rect is white in the reference and the receiver (D11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `copy-at-hook`                          | at step 8 region `s3` equals the synthesis of C's pre-fill content in the reference and the receiver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unsupported-regions`                   | `unsupported-textures` differs from `reference-unsupported` in `u1` and `u2` at every step and nowhere else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `live-inline`                           | the live session is inline / fetch none, every ok hash arrives as a resource record, `received.rs2` equals the tap, the receiver fetches nothing, and every live transaction equals the host recording at its frame                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `receiver-consumed-stream`              | every file-mode receiver read its own copy of the capture recording                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `receiver-never-loaded-fixture`         | the traced receiver opens nothing under `fixtures/`, opens its recording and reads the store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `receiver-typed-clean`                  | no receiver log has a SCRIPT ERROR / WARNING / Parse Error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `leg-class-<leg>`                       | each leg at gate2-design.md G2b2's expected class: receivers and `live-inline` success; `unsupported-textures` unsupported; omit-update pixel-mismatch {6}; omit-replace pixel-mismatch {7..11}; stale-texture capture-failure (texture-log-divergence); wrong-hash replay-failure (resource-hash-mismatch at step 6's seq); spurious-update, reupload, ignore-cache resource-violation (transform-only-resource-traffic, redundant-upload, warm-cache-fetch); g2d: `canvas-headless` unsupported (canvas-texture-headless), `canvas-host` success, `canvas-normal` unsupported (unsupported-texture), `sabotage-omit-canvas-filter` pixel-mismatch {11} |

Classification (`classifyG2bLeg`) takes gate 0's `classifyLeg` for capture-failure, unsupported and
replay-failure, adds capture-failure for a stream reason (store failure, budget) and for
texture-log-divergence, resource-violation for transform-only traffic, redundant fetches and
uploads and warm-cache fetches, and pixel-mismatch from the receiver's settle shots against the
reference; the first class in Q7's precedence wins.

## Gate 2 criteria (g2c)

| Check                                     | Passes when                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-tap-equals-received`                | each connection's received stream is its tap byte for byte (a prefix only for the connection the reconnecting receiver closed itself)                                                                                               |
| `live-resolves-to-recording`              | every tapped transaction of every g2c host equals the full recording's state at its frame, texture table included                                                                                                                   |
| `live-credit-bounded`                     | per connection, recomputed from its log: one transaction in flight at most, no send without credit, queued bytes within the largest credit window + 4096                                                                            |
| `live-acks-staged`                        | received <= applied <= submitted per seq; per connection the host saw exactly the acks of what the receiver read; presented `unavailable`                                                                                           |
| `live-vs-reference`                       | every rendered live shot per step equals the reference exactly (live-animate: its anim region equals `synthesizeGate2` at the shot's frame instead)                                                                                 |
| `live-replay-equals-live`                 | the file replay of `received.rs2` with live's cache as its store: same seqs and record hashes, same payloads, identical shots and state dumps                                                                                       |
| `http-gets-match-fetches`                 | the host's `http-get` lines equal the receiver's http fetches, hash for hash, byte for byte, in order; each hash at most once per process; every fetch a verified 200 with the immutable headers                                    |
| `gets-advertised`                         | every GET names a hash a transaction already sent on its connection (at an earlier frame callback) names                                                                                                                            |
| `fetch-before-applied`                    | every fetch for seq n ends before n's applied ack (receiver clock), and its GET reached the host no later than that ack (host frames)                                                                                               |
| `pins-bounded`                            | after every frame callback the servable set (replayed from `pin`/`retire`) equals the full recording's ok hashes united with every open connection's base, within `GRC_RESOURCE_BUDGET_BYTES`                                       |
| `obsolete-retired`                        | nothing stays servable once nothing names it, nothing is retired while something does; live-animate's fetched hashes were all sent, fewer ANIM versions were sent than updated, superseded versions retired (counts reported)       |
| `stall-newest-texture`                    | live-stall: step 6's update lands in the stall, the first post-stall transaction carries A1, A1 is fetched once (for it), and its shot equals the reference                                                                         |
| `reconnect-no-refetch`                    | live-reconnect: connection 2 starts full with 0 fetches (cache hits only) and one upload per resident texture; C and D are then fetched once each on connection 2                                                                   |
| `transform-only-no-resource-traffic-live` | steps 2 and 10 on every main-variant live leg: no GET, every receiver resource counter 0                                                                                                                                            |
| `warm-host-no-gets`                       | live-warm's host answers no GET, its receiver hits its cache once per payload live fetched, and its shots equal live's                                                                                                              |
| `leg-class-<leg>`                         | the live legs success; `sabotage-unpin` and `sabotage-drop-resource` replay-failure (`resource-unavailable`), `sabotage-wrong-hash-live` replay-failure (`resource-hash-mismatch`), the last two at the first transaction naming A1 |

Classification (`classifyG2cLeg`) follows Q7: capture-failure (host status and stream reason, the
listener, invalid recordings or taps, texture-log-divergence), unsupported, replay-failure (the
receiver's status and failure, received bytes against the tap, the applied list against the
received stream, a late join, missed shot windows), delivery-violation (gate 1's per-connection
delivery report), resource-violation (redundant fetches or uploads, warm-cache fetches,
unadvertised GETs, transform-only traffic), pixel-mismatch.

## Gate 2 criteria (g2e)

| Check              | Passes when                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-required`    | the host log shows a 401 upgrade rejection for `sabotage-no-token`, a 401 resource-GET for `sabotage-bad-http-token`, and neither for `live-auth`                                                            |
| `token-not-logged` | each leg's own `evidence/live-token` string appears in no other file under that leg's directory (recordings, hook log, `stdout.log`, `applied.json`, shots -- a raw byte search, so a binary hit counts too) |
| `leg-class-<leg>`  | `live-auth` success; `sabotage-no-token` replay-failure (`live-connect-failed`); `sabotage-bad-http-token` replay-failure (`resource-unavailable`)                                                           |

Classification (`classifyG2eLeg`) is narrower than g2b/g2c's: host health (armed, stream closed
cleanly, no texture-log-divergence) for capture-failure, and the receiver's own `applied.json`
`status`/`end_seen`/`failure.reason` for replay-failure -- no pixel or resource-traffic comparison,
since gate2-design.md G2e's "Checks" list asks for neither. The WebSocket-upgrade 401 is logged by
entry.cpp's `live_drain()` to the host's `stdout.log` (`rs_ws`'s `AuthRejected` event carries no
hash to put in the structured hook log); the resource-GET 401 is an ordinary `http-get` line in
`evidence/resources.jsonl` with `http_status` 401, already covered by G2c2's logging path.

## Gate 2 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate2.ts
```

Unit cases cover `sampleAt` (flips, transpose, S3's rotation, the region across four quadrants,
tile, mirror, clamp, LA8 alpha), `synthesizeGate2` (binary alpha over BG, the freed RAW1, C's
pre-fill content, partial alpha, the animate variant), the step windows, the census helpers, the
hook-log line validation and `checkExpectedSelfConsistent` on the committed file and five broken
copies. A passing g2a-g2e tree is then fabricated (render-stream/2 capture recordings from
`test/rs2-test-encoder.ts`, hook and fixture logs from a model of the fixture's texture calls,
`CanvasTexture` lines included, receivers' applied.json, PNGs from `synthesizeGate2`;
`test/gate2c-fixture.ts` adds every g2c live host with its D7 pin and retire lines, taps and live
logs, and its receiver with http fetches, and the three g2e legs with their tokens, the upgrade
401 and the GET 401), and each check gets at least one failing perturbation; the real `runGate2`
runs on every tree. Group selection is covered too: g2a alone (g2b-g2e not-run), nothing run, and
g2b without g2d (G2d's checks absent, only `group-g2d` not-run).

## Gate 3 files

```bash
mise exec -- pnpm render-stream:gate3 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g3a,g3b,g3c,g3d]
```

- `run-gate3.sh`: the orchestrator (`run_g3a`, `run_g3b`, `run_g3c`, `run_g3d`, `run_reference`).
  All four groups have landed.
- `lib/gate3-expected.ts`: the `render-stream-gate3-expected/1` types, `stepFrames3`,
  `synthesizeGate3(expected, step, {clips})` (the clear colour, then every draw in paint order,
  each intersected with its integer scissor; `clips: false` gives the unclipped scene),
  `probesOf`, `pixelAt` and `visibleRect`.
- `lib/clip-derive.ts`: `deriveClipRects(state, viewport, {cullMask, canvas})`. It derives each
  visited item's final scissor from a resolved render-stream/2 state by gate3-design.md Q1c:
  transforms composed from the canvas down in float32, the custom rect or command bounds (texture
  rect flips normalized, transpose swapped), the bounding box, intersection with the rounded
  ancestor scissor, the 0.5 px skip, and position and size rounded half away from zero. An
  uncustomized clip whose bounds hang on an unsupported command derives as `unknown`. It is the
  reference implementation for gate 7's browser receiver.
- `lib/gate3-checks.ts`: every G3a check, `evaluateCapture` (gate 0's `classifyLeg` plus gate 1's
  `classifyGate1`, which adds patch divergence and the root-size declaration), `clipCensusOf` and
  `runGate3`. It reuses gate 0's capture, no-GPU and recording checks and gate 1's name mapping,
  tie detection and patch resolution. G3b adds `gate3LegLayout`, `evaluateG3bLeg` (one
  `Gate3LegEvaluation` per leg of `G3B_CLASSIFIED_LEGS`, built the way gate 1's `evaluateGate1Leg`
  is: `classifyLeg` then `classifyGate1` over that leg's own capture and receiver),
  `computeGate3ReceiverCheckpoints` (the receiver analogue of `compareShotsWithSynth`, joining
  `seq-<n>.png` shots through the capture's `steps.jsonl`), `probeTallyReceiver` and
  `checkLegClass3`, which reads every mismatching-steps / mismatching-regions / failing-probes
  expectation straight from `expected.json` `predictions[leg]` rather than a hand-typed table.
  `checkClipRectsDerived` gained an optional fourth argument so the same check also runs
  `deriveClipRects` over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps.
  `checkReceiverTypedCleanG3b` is g3b's own lighter version of gate 1's receiver-typed-clean
  (gate2b-checks.ts's pattern): g3b has no `receiver-typecheck` leg of its own, so it scans every
  g3b receiver leg's `stdout.log` directly instead. G3d adds `checkCaptureClipIgnoreArmed` (a
  second capture leg under a different directory name, so it cannot reuse gate 0's
  `checkCaptureArmed`, which hardcodes `capture/`), `checkClipIgnoreTyped`,
  `checkExpectedImageReferenceClipIgnore`, `checkCaptureClipIgnoreLegClass` and
  `checkClipIgnoreRegionSet` (the receiver leg's class plus its region-mismatch set over every
  step, reusing G3b's `computeGate3ReceiverCheckpoints`, folded into one `leg-class-*` check).
- `lib/gate3x-expected.ts` (G3c): the `gate3-xform` expected types, `synthesizeGate3x(expected,
  step, {clips})` and `paintDraws`: pixel-centre coverage of each draw (an axis-aligned
  `rect_px`, or a `quad` under rotation) inside its integer scissor, plus the `band` mask, the
  pixels whose centre lies within `band_px` (1.0) of a non-axis-aligned edge inside that draw's
  scissor. The arithmetic (squared segment distances) is make_expected.py's.
- `lib/gate3x-checks.ts` (G3c): every g3c check, `bandDiff`/`overBudget` (exact outside the band,
  a budget inside it), `evaluateLegX` (gate 0's `classifyLeg` and gate 1's `classifyGate1` with
  band-aware checkpoints against `reference-xform`) and `runG3c`, which `runGate3` calls when g3c
  ran.
- `check-gate3.ts`: writes `<out>/result.json` (`render-stream-gate3-report/1`: gate 1's shape
  plus `probes`, per leg and step `{total, decisive, failed}`, `clip_rects`, the clip-derive
  table per fixture and step, `census`, `ties`, and for g3c `band` (budget, band sizes, the
  repeat's band differences) and `semantic_probes`, the reference's pixel at each D7 probe) and
  exits non-zero unless `gate_passed`.
- `test/self-test-gate3.ts`, `test/gate3-fixture.ts`, `test/gate3x-cases.ts`: see below.

## Gate 3 legs and evidence under `--out`

| Leg                | Group | Directory           | Runs                                                                                                                             |
| ------------------ | ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `import`           | g3a   | `import/fixture/`   | the mise editor's `--import` of `fixtures/gate3`                                                                                 |
| `capture`          | g3a   | `capture/`          | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `reference`        | g3a   | `reference/`        | rendered in gamescope, extension absent: `shots/step-0..9.png`                                                                  |
| `reference-repeat` | g3a   | `reference-repeat/` | the same again                                                                                                                   |
| `reference-armed`  | g3a   | `reference-armed/`  | rendered, extension armed with `GRC_STREAM_OUT` and a store, shots                                                               |
| `import` (receiver) | g3b  | `import/receiver/`  | the mise editor's `--import` of `receiver/`                                                                                      |
| `receiver`          | g3b  | `receiver/`         | rendered receiver on `capture/recording.rs2`: `shots/seq-<n>.png` at the 10 settle seqs, `applied.json`                         |
| `receiver-patch`    | g3b  | `receiver-patch/`   | the same on `capture/recording-patch.rs2`, plus `state/seq-<n>.json` resolved-state dumps                                       |
| `receiver-headless-trace` | g3b | `receiver-headless-trace/` | headless receiver on a copy of `capture/recording.rs2` under `strace -e openat`                                          |
| `sabotage-freeze`, `sabotage-perturb` | g3b | `sabotage-{freeze,perturb}/{capture,receiver}/` | its own fresh capture, `GRC_SABOTAGE=freeze-frame`/`perturb-transform` at step 2's/1's frame, then a rendered receiver |
| `sabotage-omit-clip`, `sabotage-omit-custom-rect` | g3b | `sabotage-omit-{clip,custom-rect}/{capture,receiver}/` | its own fresh capture, `GRC_SABOTAGE=omit-op` dropping `canvas_item_set_clip`/`canvas_item_set_custom_rect` at step 3's/7's frame |
| `sabotage-receiver-ignore-clip` | g3b | `sabotage-receiver-ignore-clip/` | rendered receiver on `capture/recording.rs2`, `RS_RECEIVER_SABOTAGE=ignore-clip`                                         |
| `sabotage-receiver-clip-before-clear` | g3b | `sabotage-receiver-clip-before-clear/` | the same, `RS_RECEIVER_SABOTAGE=clip-before-clear`                                                                 |
| `root-size-observe` | g3b  | `root-size-observe/{capture,receiver}/` | its own fresh capture with `GRC_ROOT_SIZE` unset, then a rendered receiver                                               |
| `capture-clip-ignore`   | g3d | `capture-clip-ignore/`   | the release template, `--headless`, armed, `RS_FIXTURE_VARIANT=clip-ignore`, both sinks, `GRC_ROOT_SIZE=enforce-min-size`, quit 400 |
| `reference-clip-ignore` | g3d | `reference-clip-ignore/` | rendered in the same gamescope, extension absent, `RS_FIXTURE_VARIANT=clip-ignore`: `shots/step-0..9.png`                           |
| `receiver-clip-ignore`  | g3d | `receiver-clip-ignore/`  | rendered receiver on `capture-clip-ignore`'s recording: `shots/seq-<n>.png` at the 10 settle seqs, `applied.json` |

Group g3c runs `fixtures/gate3-xform` (one private gamescope, `gamescope-xform/`):

| Leg                                   | Directory                                          | Runs                                                                                                     |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `import-xform`                        | `import-xform/{fixture,receiver}/`                 | the mise editor's `--import` of `fixtures/gate3-xform` and of the receiver                               |
| `capture-xform`                       | `capture-xform/`                                   | the release template, `--headless`, armed, both sinks, the store, `enforce-min-size`, quit 52           |
| `reference-xform`                     | `reference-xform/`                                 | rendered, extension absent: `shots/step-0..4.png`                                                        |
| `reference-xform-repeat`              | `reference-xform-repeat/`                          | the same again (the band budget)                                                                         |
| `reference-xform-armed`               | `reference-xform-armed/`                           | rendered, extension armed with `GRC_STREAM_OUT` and a store                                              |
| `receiver-xform`                      | `receiver-xform/`                                  | rendered receiver on `capture-xform`'s full sink, shots at the five settle seqs                          |
| `receiver-xform-patch`                | `receiver-xform-patch/`                            | the same on the patch sink                                                                               |
| `sabotage-xform-perturb`              | `sabotage-xform-perturb/{capture,receiver}/`       | capture with `perturb-transform` at frame 11 (step 1), rendered receiver                                 |
| `sabotage-xform-receiver-ignore-clip` | `sabotage-xform-receiver-ignore-clip/`             | rendered receiver on `capture-xform`'s full sink with `RS_RECEIVER_SABOTAGE=ignore-clip` (G3b's value)  |

## Gate 3 criteria (g3a)

`capture-armed` (56 hooks) and `headless-no-gpu` are gate 0's. `recording-decodes` runs gate 0's
check on both sinks. `patch-resolves-to-full` requires the patch sink to resolve bit-identically to
the full sink at every frame. `step-alignment` reads the four step logs and the capture's marker
colours. `no-draw-index-ties` fails on any tie whose members' footprints overlap (G1b2's harmless
rule) and lists harmless ones. `expected-image-reference` compares every reference shot with
`synthesizeGate3` exactly, full frame and per region. `probes-reference` reads every named probe
in the reference shots and fails by name. `reference-repeat-budget` requires `reference` and
`reference-repeat` to be identical (budget 0, D8). `armed-transparent` requires
`reference-armed`'s shots to equal `reference`'s byte for byte. `clip-state-invariants` evaluates
every `expected.json` invariant on both sinks' settle transactions. `clip-rects-derived` runs
`deriveClipRects` over both sinks' settle transactions against `clip_rects` (and, once g3b has
run, over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps too).
`clip-call-census` sums `counters.json` `captured.canvas_item_set_clip` by value and
`canvas_item_set_custom_rect` by enabled, reads `counts.canvas_item_clear`, and requires
`census_totals` with nothing dropped. `support-legs-exit` requires the import and rendered legs
to exit 0. `leg-class-capture` requires class `success` and no unsupported entry or command.

## Gate 3 criteria (g3b)

`expected-image-receiver` and `receiver-vs-reference` compare `receiver`'s `seq-<n>.png` shots
with `synthesizeGate3`, full frame and every region, exactly (g3b has no sabotage on this leg:
every step must match). `probes-receiver` reads every named probe in `receiver`'s shots and fails
by name. `receiver-consumed-stream` is gate 1's: `receiver`'s `applied.json` schema, status,
`end_seen`, the transaction list's seq/sha256 sequence, every shot's `applied_through` and
`recording.sha256` against the capture file's. `receiver-never-loaded-fixture` is gate 1's own
strace-based proof, now over `fixtures/gate3/`. `receiver-typed-clean` is g3b's own lighter
version (gate2b-checks.ts's pattern, since g3b has no `receiver-typecheck` leg): it scans every
g3b receiver leg's own `stdout.log` for `SCRIPT ERROR` / `SCRIPT WARNING` / `Parse Error` /
`Failed to load script`. `leg-class-<leg>` runs for every leg of `G3B_CLASSIFIED_LEGS`: the
class, then, read straight from `expected.json` `predictions[leg]`, the exact mismatching-step
set, the exact mismatching-region set per predicted step (root-size-observe: `anchored` only,
with zero mismatching pixels outside every region), and for
`sabotage-receiver-ignore-clip`, the exact failing-probe set (G3a's "As built" amendment: every
decisive outside probe plus 34 inside probes `BF`/`BZ`/`CF` cover once unclipped).

## Gate 3 criteria (g3c)

`expected-self-consistent-xform` holds `fixtures/gate3-xform/expected.json` to its rules: the colour
rule, regions, the Q6d hand table, the probe pairs (outside the band, colours equal to the
synthesized and unclipped frames), decisive coverage, the band size equal to `synthesizeGate3x`'s,
the six semantic probes equal to Q6d's table with each alternative differing from the engine
somewhere, and the sabotage step sets equal to the contract's. `step-alignment-xform` reads the
capture's and the three references' step logs and the capture's marker colours.
`expected-image-reference-xform` compares every reference shot with `synthesizeGate3x` exactly
outside the band, full frame and per region. `band-budget` requires `reference-xform` and
`reference-xform-repeat` to be identical outside the band and turns their band differences into
the budget. `semantic-probes` requires the reference to equal the engine model at all six D7 probes
and each of `rotated-exact`, `edge-round` and `pixel-centre` to miss at least one.
`probes-reference-xform` and `probes-receiver-xform` read every named probe. `armed-transparent-xform`
requires `reference-xform-armed` to equal the reference byte for byte, band included.
`clip-state-invariants-xform` and `clip-rects-derived-xform` are g3a's checks over both
`capture-xform` sinks. `receiver-vs-reference-xform` and `expected-image-receiver-xform` hold both
receivers exact outside the band, the former within the budget inside it.
`support-legs-exit-xform` requires the two imports and the three references to exit 0. Five
`leg-class-*` checks: `capture-xform`, `receiver-xform` and `receiver-xform-patch` classify
`success`; `sabotage-xform-perturb` is `pixel-mismatch` at exactly {1..4}; and
`sabotage-xform-receiver-ignore-clip` is `pixel-mismatch` at exactly {0..4}, with exactly the
predicted failing probes (two that the unclipped scene puts in its own band are left out). The
receiver legs need G3b's apply order (clear before clip) and its `ignore-clip` sabotage.

## Gate 3 criteria (g3d)

`capture-armed-clip-ignore` is `capture-armed`'s own check against `capture-clip-ignore/`'s
`evidence/`, since `checkCaptureArmed` always reads `capture/`. `manifest-present` is gate 0's,
confirming `observed_unsupported_ops` carries `canvas_item_add_clip_ignore` and `unobserved`
carries `canvas_item_set_visibility_notifier`. `recording-decodes-clip-ignore` runs gate 0's check
on both of `capture-clip-ignore`'s sinks. `expected-image-reference-clip-ignore` compares every
`reference-clip-ignore` shot with `synthesizeGate3` plus `expected.json`'s
`variant_clip_ignore.reference_draws` appended (the second rect drawn unclipped, Q1d).
`clip-ignore-typed` reads the capture's last transaction for the one item with RI's exact four
commands (`add_rect`, `unsupported canvas_item_add_clip_ignore`, `add_rect`, `unsupported
canvas_item_add_clip_ignore`) and the one item-level `unsupported-op` entry.
`leg-class-capture-clip-ignore` requires class `unsupported` and the recording to carry
`canvas_item_add_clip_ignore` as unsupported. `leg-class-receiver-clip-ignore` requires the
receiver to classify `unsupported`, its step join to be clean, and every one of its `seq-<n>.png`
shots (all ten settle steps, now that G3b's apply-order fix is in) to mismatch
`reference-clip-ignore`'s matching `step-<k>.png` in region `ri` alone, at every step (the
receiver drops both `add_clip_ignore` calls and clips RI's second rect like any other command;
`RI` never redraws, so the base scene's own clipping Controls, now fixed, never contaminate the
comparison).

## Gate 3 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate3.ts
python3 experiments/render-stream/fixtures/gate3/make_expected.py --check
python3 experiments/render-stream/fixtures/gate3-xform/make_expected.py --check
```

The unit cases are of three kinds. `deriveClipRects` runs on hand cases: nesting, a non-clipping
intermediate, both zero-area skips, half rounding including negatives, the sub-0.5 px skip, a
negative scale, 90° and 30° rotations (gate3-xform's `RQ`), command bounds with a flipped,
transposed texture rect, unknown bounds, an invisible subtree and the canvas transform.
`synthesizeGate3` and the probes run against `expected.json`, with the predictions' sanity and the
TS call model's census against `census_totals`. `checkExpectedSelfConsistent` runs on the
committed file and on six broken copies (plus, since G3d, `variant_clip_ignore`'s own shape). A
passing g3a+g3b+g3d tree is then fabricated: `test/gate3-fixture.ts`'s `buildFullTree` calls
`buildTree` (g3a: models the fixture's RS calls independently of `make_expected.py`, writes both
sinks through `test/rs2-test-encoder.ts`, and synthesizes the PNGs), `writeG3bTree` (every g3b
leg's `applied.json` from the capture bytes it actually replays, `summarizeRecording`, and its
shots as `synthesizeGate3`, a sabotage's predicted-mismatch steps getting one recoloured pixel
instead; `sabotage-receiver-ignore-clip` writes the actual unclipped render,
`synthesizeGate3(..., {clips: false})`, not a stand-in) and `writeG3dTree` (`buildStatesWithRI`
adds the variant's static item `RI`, wire id 19, the same the real fixture gives it, to every
frame alongside the base g3a model, for `writeClipIgnoreCaptureDir`/`-Reference`/`-Receiver`).
Tiny stand-in `receiver/` and `fixtures/gate3/` project directories back
`receiver-never-loaded-fixture`'s file-hash scan. Every check gets at least one failing
perturbation, the pre-gate-3 mirror (clear keeps clip), the pre-gate-3 receiver order (clip before
clear) and G3d's five levers (an omitted hook, a wrong transaction count, RI never calling
`add_clip_ignore`, a perturbed reference pixel, and a receiver that matches the reference exactly,
so the predicted `ri` mismatch never fires) among them, and the real `runGate3` runs on every
tree. Scenarios that rewrite the shared `capture/` directory (`recapture`) run g3b and g3d out of
scope (`g3aOnly`): their receiver legs replay that capture by reference, so keeping them "honest"
against a capture nobody is testing them against would mean regenerating several legs' worth of
evidence for every g3a-only perturbation. `manifest-present` has no failing lever here, since
every fabricated session is encoded straight from the live `RS2_FEATURES` constant; its failure
path is `self-test-gate0.ts`'s.

`test/gate3x-cases.ts` covers g3c, and `make_expected.py --check` for `fixtures/gate3-xform` joins
the list. It checks `synthesizeGate3x`'s coverage and band on a hand-computed 8×8 diamond (24
covered pixels, a 36-pixel band, both confined by a scissor) and `bandDiff`/`overBudget`. It holds
the six semantic probes to Q6d's table, typed in independently, and runs
`checkExpectedSelfConsistentX` on the committed file and seven broken copies. The reference-side
checks run on small trees of synthesized PNGs: a passing tree, a band pixel off (passes, budget
1 px), `half.sliver` painted as the alternatives predict, a probe off, and an alternative that
agrees everywhere. The fabricated g3a + g3b trees run `runGate3` with the landed groups narrowed
to g3a and g3b.

## Gate 4 files

```bash
mise exec -- pnpm render-stream:gate4 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g4a,g4b,g4c,g4d,g4e,g4f]
```

- `run-gate4.sh`: the orchestrator (`run_g4a`, `run_g4b`, `run_reference` with `REFERENCE_ORACLE`
  and `REFERENCE_ARMED`, `g4_capture` for a sabotage capture at the fixture's own default quit
  frame, `early_shots_csv` for Q6b's "Intermediate shots" on a receiver). It provisions fonts
  before the import and stops on any mismatch. `g4b` needs `g4a` in the same `--legs` (one
  capture and reference, shared). `run_g4c` runs `fixtures/gate4-layout` under `<out>/layout/`
  (it also imports `receiver/`, which a fresh worktree has never imported); `run_reference` takes
  `REFERENCE_FIXTURE_DIR` and `REFERENCE_VARIANT` for it, and `layout_early_csv` its early
  steps. `run_g4f` runs `fixtures/gate4-i18n` under `<out>/i18n/` the same way (four fonts
  provisioned, the fixture and `receiver/` imported, `i18n_early_csv` for its early steps).
  `run_g4e` (G4e2) runs `fixtures/gate4-msdf` under `<out>/msdf/` (it imports the fixture and
  `receiver/`; `msdf_early_csv` gives its early steps 1 and 7) plus `sabotage-gray-perturb-glyph`
  on `fixtures/gate4`, so `g4e` needs `g4a` in the same `--legs`. Every capture speaks
  render-stream/3 since G4e2; the recordings keep their `.rs2` names.
- `lib/provision-fonts.sh <fixture>`: copies each `fonts.lock.json` entry into `<fixture>/fonts/`
  after checking the source's and the copy's size and SHA-256 and that its licence file exists.
  A source starting with `../` (the engine checkout) also resolves against the main checkout's
  root, so worktrees find it. Exit 2 on any mismatch or missing source.
- `lib/gate4-expected.ts`: the `render-stream-gate4-expected/1` and
  `render-stream-gate4-glyphs/1` types, `stepFrames4`, `stepOfFrame4`, `synthesizeGate4` (the
  clear colour, the panel and the marker, with a mask of the text regions), `inkPixels`,
  `boxEqual`, `deriveCensus` (gate4-design.md Q1c over expected.json's own strings and draws),
  `appendOnlyViolations`, and G4b's `synthesizeText`/`compareSynthesizedText` (D8: one oracle
  node's glyphs, straight-alpha blended over its region's background from its page's LA8 alpha,
  against a real frame).
- `lib/gate4-checks.ts`: every G4a and G4b check, each a pure `evaluate*` function plus a thin
  loader, and `runGate4`. It reuses gate 0's capture, no-GPU and
  `classifyLeg`/`joinSettleSeqs`/`checkReceiverNeverLoadedFixture` machinery, gate 2's
  `store-complete` and `texture-versions-current`, and gate 3's recording, patch, tie and
  capture-class checks. G4b adds `receiverStepSeqs`/`loadReceiverShots` (a receiver's wire-seq
  shots re-keyed to the reference's filenames, so every G4a shot evaluator runs over a receiver
  unchanged), `computeGate4Checkpoints` plus `checkLegClass` (classifyLeg against a leg's class
  and, for a sabotage, its exact predicted mismatching steps), `loadAtlasPageImages`/
  `loadPagesByStep`, `evaluateExpectedText`/`checkExpectedText`, `evaluateResourceQuiet`,
  `checkReceiverNeverShapes`, `checkReceiverConsumedStream`, `checkReceiverTypedClean` and
  `checkAtlasHashParitySabotage`.
- `lib/gate4c-checks.ts`: group g4c (`runG4c`, loaded on demand by `runGate4`). It points G4a's
  and G4b's evidence-root helpers at `<out>/layout/` and adds what layout needs:
  `deriveLayoutCensus` (a TypeScript re-derivation of `make_expected.py`'s upload model),
  `evaluateLayoutOracle`, `evaluateLayoutGlyphCommands` (shadow, outline and text passes, each
  with its own colour and page), `layoutCensusFromLog`/`evaluateLayoutCensus` (per page key,
  frees included), `newSubpixelPairs`/`evaluateSubpixelCensus`, `evaluatePageLifetime`,
  `evaluateLayoutClips` (gate 3's `deriveClipRects`), `synthesizeLayoutText`/`evaluateLayoutText`
  (D8 with per-glyph colours, outline pages and the Labels' clips), `evaluateLcdCommands` and
  `evaluateLcdRegions`. Its check ids end in `-layout` or name the leg.
- `lib/gate4f-checks.ts`: group g4f (`runG4f`, loaded on demand by `runGate4`). It points the
  same helpers at `<out>/i18n/` (G4c's `layoutCensusFromLog`, `evaluateLayoutCensus` and
  `loadLayoutPages` included) and adds `unitsOf`/`deriveI18nCensus` (a TypeScript re-derivation
  of `make_expected.py`'s glyph-unit model from `expected.json` `units_model`),
  `evaluateI18nEnv` (OS with three fallbacks), `evaluateI18nOracle` (each shaped glyph from the
  font the fallback order gives its codepoint), `evaluateI18nCommands` (texture glyphs and
  hex-box `add_rect`s in draw order), `evaluateFallbackPages`, `evaluateScriptPredictions` and
  `synthesizeI18nText`/`evaluateI18nText` (D8 with each glyph's own font page and the hex box's
  half-open pixel-centre rects). Its check ids end in `-i18n` or name the check.
- `check-gate4.ts`: writes `<out>/result.json` (`render-stream-gate4-report/1`: gate 3's shape
  with `text` per fixture and step (glyph commands, pages with wire id, hook and wire versions and
  payload bytes, bytes published, copy and hash ns), `parity` (each oracle page against the
  capture's table per step), `budgets` (reference against repeat per region), `census` and `ink`)
  and exits non-zero unless `gate_passed`; g4c adds `layout`, g4f `i18n` (census, script
  predictions, fallback pages) and g4e `msdf` (its census, the measured budget and the receiver's
  maxima). It passes `receiverDir`/`fixtureDir` (G4b) in `Gate4Context`. When group `g4d` ran, it separately loads `fixtures/gate4-rich/expected.json`,
  calls `runGate4d` (lib/gate4d-checks.ts) and merges its checks/legs/text/parity/budgets/census/
  ink into the same report under the fixture key `"gate4-rich"`, ANDing `gate_passed` -- `runGate4`
  itself stays unaware of G4d (no circular import: gate4d-checks.ts already imports gate4-checks.ts
  for the pieces it reuses).
- `fixtures/gate4-rich/`: G4d's own fixture (a `RichTextLabel`), see its own `README.md`.
- `lib/gate4d-checks.ts`: G4d's checks (fixtures/gate4-rich/, `RichTextLabel` spans). Every check
  id is prefixed `rich-` so it never collides with g4a/g4b's identically-shaped checks in the same
  flat `report.checks` array. It reuses G4a/G4b's `shotsOf`/`loadShots`/`gate4Regions`/
  `compareLegs`/`evaluateExpectedImage`/`evaluateInkPresence`/`markerAlignment`/
  `receiverStepSeqs`/`loadReceiverShots`/`computeGate4Checkpoints`/`checkLegClass`/
  `evaluateResourceQuiet`/`checkAtlasHashParity`/`checkAtlasAppendOnly`/`checkAtlasCensus`/
  `textReport` unchanged (none of them depend on `OracleLine.nodes`'s per-glyph quads, which this
  fixture's oracle never produces: Q6c, "the oracle reports glyph sets and counts per span, not
  quads"). New: `evaluateRichOracleAgrees` (groups an outlined span's two expanded oracle entries
  -- fill and outline pass, sharing its `key` -- rather than assuming one entry per span),
  `evaluateRichGlyphCommands` (per-wire-id glyph counts against the oracle, bold/italic "own page",
  `[bgcolor]` `add_rect`s), `checkRichClipRects` (gate 3's `deriveClipRects` over `RTL`'s fixed
  clip rect), `evaluateRichCapture`/`checkRichCaptureArmed`/`checkRichHeadlessNoGpu`/
  `checkRichStepAlignment`/`checkRichFixtureEnv` (directory-parameterized equivalents of gate0/
  gate2b/gate3/gate4's own helpers, which hardcode the leg name `"capture"`; this fixture's legs
  live under `rich-*/`), and `checkRichUnsupportedCaptureClass`/`checkMismatchConfinedToRegion`
  for the underline variant.
- `fixtures/gate4-msdf/`: G4e2's fixture (five Labels on one MSDF `FontFile`, msdf_size 48, range
  24), see its own `README.md`.
- `lib/gate4e-checks.ts`: group g4e (`runG4e`, loaded on demand by `runGate4`). It points G4a's and
  G4b's evidence-root helpers at `<out>/msdf/` and adds what MSDF needs: `deriveMsdfCensus` (a
  TypeScript re-derivation of `make_expected.py`'s one-cache upload model),
  `evaluateMsdfOracle`, `evaluateMsdfGlyphCommands` (msdf commands against the oracle's float32
  quads, outline, px_range and scale), `evaluateMsdfArgs`, `evaluateWithinBudget` (D8: a receiver
  within the reference repeat's measured per-region maxima), `evaluatePredictedRegions` and
  `evaluatePerturbRecorded` (a perturb-glyph capture against the clean one, +0.25 on exactly the
  predicted Labels' rects). It reuses G4c's `layoutCensusFromLog`/`evaluateLayoutCensus` over
  the MSDF expected. Its check ids end in `-msdf` or name the leg.
- `test/self-test-gate4.ts`, `test/self-test-gate4d.ts`: see below.

## Gate 4 legs and evidence under `--out`

| Leg                                      | Group | Directory                | Runs                                                                                                                                         |
| ----------------------------------------- | ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`                                 | g4a   | `import/`                 | `provision-fonts.sh` (`fonts.log`), then the mise editor's `--import` of `fixtures/gate4` (`fixture/`)                                       |
| `capture`                                | g4a   | `capture/`                | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, `env.json`, quit 400, strace + maps/fd |
| `reference`                              | g4a   | `reference/`              | rendered in gamescope, extension absent, oracle on: `shots/step-0..9.png`, `shots/early-{1,4,7}.png`, `oracle/glyphs.jsonl`, `oracle/pages/` |
| `reference-repeat`                       | g4a   | `reference-repeat/`       | the same again                                                                                                                               |
| `reference-armed`                        | g4a   | `reference-armed/`        | rendered, extension armed with `GRC_STREAM_OUT` and a store, oracle off, shots                                                              |
| `receiver`                               | g4b   | `receiver/`               | the unchanged receiver, rendered, on a copy of `capture`'s full sink, settle and early (12, 42, 72) shots |
| `receiver-patch`                         | g4b   | `receiver-patch/`         | the same, on a copy of `capture`'s patch sink (same seq space as the full sink) |
| `receiver-headless-trace`                | g4b   | `receiver-headless-trace/` | the receiver, headless, `strace -f -e openat` (`receiver-never-shapes`, `receiver-never-loaded-fixture`) |
| `sabotage-freeze/{capture,receiver}`     | g4b   | `sabotage-freeze/`        | a fresh headless capture (`GRC_SABOTAGE=freeze-frame` at frame 11, step 1) at the fixture's own default quit (102), then its rendered receiver |
| `sabotage-perturb/{capture,receiver}`    | g4b   | `sabotage-perturb/`       | `GRC_SABOTAGE=perturb-transform` at frame 21 (step 2), then its receiver |
| `sabotage-omit-atlas/{capture,receiver}` | g4b   | `sabotage-omit-atlas/`    | `GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update` at frame 41 (step 4), then its receiver |
| `import` (layout)                        | g4c   | `layout/import/`          | `provision-fonts.sh fixtures/gate4-layout` (`fonts.log`), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-layout`                         | g4c   | `layout/capture/`         | as `capture`, on `fixtures/gate4-layout` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-layout`, `-repeat`            | g4c   | `layout/reference/`, `layout/reference-repeat/` | rendered, extension absent, the layout oracle on: `shots/step-0..9.png`, `shots/early-{1,2,3,4,6,7,8}.png`, `oracle/` |
| `reference-layout-armed`                 | g4c   | `layout/reference-armed/` | rendered, extension armed with a stream and a store, oracle off |
| `receiver-layout`, `-patch`              | g4c   | `layout/receiver/`, `layout/receiver-patch/` | the receiver on `capture-layout`'s full and patch sinks, settle and early shots |
| `receiver-layout-headless-trace`         | g4c   | `layout/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-layout`'s full sink |
| `sabotage-layout-omit-atlas`             | g4c   | `layout/sabotage-omit-atlas/{capture,receiver}` | `omit-op texture_2d_update` at frame 71 (step 7, the multi-page step), default quit 102, then its receiver |
| `capture-lcd`, `reference-lcd`, `receiver-lcd` | g4c | `layout/lcd/{capture,reference,receiver}` | `RS_FIXTURE_VARIANT=lcd` (one LCD Label `LC`): headless capture (quit 102), rendered reference (oracle off), receiver |
| `rich-import`                            | g4d   | `rich-import/`            | `provision-fonts.sh` and `--import` of `fixtures/gate4-rich` |
| `rich-capture`                           | g4d   | `rich-capture/`           | headless, armed, both sinks, the store, `env.json`, quit 400, strace + maps/fd |
| `rich-reference`, `rich-reference-repeat`, `rich-reference-armed` | g4d | `rich-reference*/` | as g4a's `reference`/`reference-repeat`/`reference-armed`, for `fixtures/gate4-rich` (no "early" shots) |
| `rich-receiver`, `rich-receiver-patch`   | g4d   | `rich-receiver*/`         | the unchanged receiver on `rich-capture`'s full and patch sinks |
| `rich-underline/capture`                 | g4d   | `rich-underline/capture/` | headless, `RS_FIXTURE_VARIANT=underline`, the fixture's own default quit (62) |
| `rich-underline/reference`               | g4d   | `rich-underline/reference/` | rendered, `RS_FIXTURE_VARIANT=underline`, no oracle (ground truth for the real underline stroke; not named in gate4-design.md's leg list, added here as built, mirroring G4c's three-leg LCD variant) |
| `rich-underline/receiver`                | g4d   | `rich-underline/receiver/` | the receiver on `rich-underline/capture`'s recording |
| `import` (i18n)                          | g4f   | `i18n/import/`            | `provision-fonts.sh fixtures/gate4-i18n` (`fonts.log`, four fonts), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-i18n`                           | g4f   | `i18n/capture/`           | as `capture`, on `fixtures/gate4-i18n` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-i18n`, `-repeat`              | g4f   | `i18n/reference/`, `i18n/reference-repeat/` | rendered, extension absent, the i18n oracle on: `shots/step-0..9.png`, `shots/early-{1,2,3,4,5}.png`, `oracle/` |
| `reference-i18n-armed`                   | g4f   | `i18n/reference-armed/`   | rendered, extension armed with a stream and a store, oracle off |
| `receiver-i18n`, `-patch`                | g4f   | `i18n/receiver/`, `i18n/receiver-patch/` | the receiver on `capture-i18n`'s full and patch sinks, settle and early shots |
| `receiver-i18n-headless-trace`           | g4f   | `i18n/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-i18n`'s full sink |
| `sabotage-i18n-omit-atlas`               | g4f   | `i18n/sabotage-omit-atlas/{capture,receiver}` | `omit-op texture_2d_update` at frame 51 (step 5, the first Devanagari), default quit 102, then its receiver |
| `import` (msdf)                          | g4e   | `msdf/import/`            | `provision-fonts.sh fixtures/gate4-msdf` (`fonts.log`), then `--import` of the fixture (`fixture/`) and of `receiver/` (`receiver/`) |
| `capture-msdf`                           | g4e   | `msdf/capture/`           | as `capture`, on `fixtures/gate4-msdf` (quit 400, both sinks, store, strace + maps/fd, `env.json`) |
| `reference-msdf`, `-repeat`              | g4e   | `msdf/reference/`, `msdf/reference-repeat/` | rendered, extension absent, the MSDF oracle on: `shots/step-0..9.png`, `shots/early-{1,7}.png`, `oracle/` |
| `reference-msdf-armed`                   | g4e   | `msdf/reference-armed/`   | rendered, extension armed with a stream and a store, oracle off |
| `receiver-msdf`, `-patch`                | g4e   | `msdf/receiver/`, `msdf/receiver-patch/` | the receiver on `capture-msdf`'s full and patch sinks, settle and early shots |
| `receiver-msdf-headless-trace`           | g4e   | `msdf/receiver-headless-trace/` | the receiver, headless, `strace -f -e openat`, on `capture-msdf`'s full sink |
| `sabotage-msdf-perturb-glyph`            | g4e   | `msdf/sabotage-perturb-glyph/{capture,receiver}` | `GRC_SABOTAGE=perturb-glyph` at frame 11 (step 1, the new-glyph step), default quit 102, then its receiver |
| `sabotage-msdf-receiver-drop`            | g4e   | `msdf/sabotage-receiver-drop/receiver/` | the receiver on `capture-msdf`'s full sink with `RS_RECEIVER_SABOTAGE=drop-msdf` |
| `sabotage-gray-perturb-glyph`            | g4e   | `msdf/sabotage-gray-perturb-glyph/{capture,receiver}` | `perturb-glyph` at frame 11 on `fixtures/gate4` (default quit 102), then its receiver, judged against g4a's `reference/` |

## Gate 4 criteria (g4a)

`capture-armed` (55 hooks), `headless-no-gpu`, `recording-decodes` (both sinks),
`patch-resolves-to-full`, `no-draw-index-ties` and `leg-class-capture` are gate 3's;
`store-complete` and `texture-versions-current` are gate 2's. `step-alignment` reads the four step
logs and the capture's marker colours. `fixture-env` requires `env.json` to be identical across
capture, reference and repeat and to equal the lock's font hash, D3's `FontFile` properties, Q1e's
settings, oversampling 1.0 and the Advanced TextServer. `oracle-agrees` requires the oracle's
visible nodes, texts, fonts, colours, ink-glyph counts, pages and distinct glyphs per cache to
equal `expected.json`, and both oracle logs to be byte-identical. `glyph-commands` compares every
text item's commands on both sinks' settle transactions with the oracle's quads, source rects,
colours and pages, float32 exact. `atlas-hash-parity` requires each oracle page's GRT1 hash to be
the hash of exactly one wire texture at every settle step, with a fixed wire id per page.
`atlas-append-only` decodes consecutive published versions of each page from the store and
requires every changed texel to have been empty (LA8 `(255,0)`). `atlas-census` reads the hook log
per step window: creates and updates per page, all in the applied frame, hook and wire versions,
nothing in the quiet steps, and the engine's hue strip as the only other upload.
`expected-image-reference` compares every shot with `synthesizeGate4` exactly outside the text
regions. `ink-presence-reference` counts ink pixels per region (≥ 6 per glyph, 0 when blank),
checks freshness against the previous step and requires each early shot's text to equal its
settle shot. `reference-repeat-budget` requires identical shots (budget 0) and reports per-region
maxima. `armed-transparent` requires `reference-armed`'s shots to equal the reference's.
`support-legs-exit` requires a provisioned font and the import and rendered legs to exit 0.

## Gate 4 criteria (g4b)

`leg-class-receiver`/`leg-class-receiver-patch` require class `success` (classifyLeg over
checkpoints built from the receiver's re-keyed shots against the reference's). `leg-class-
sabotage-{freeze,perturb,omit-atlas}` require class `pixel-mismatch` with exactly the predicted
mismatching steps (`expected.json` `predictions`, from `make_expected.py`; never hand-edited) and
every other step matching. `receiver-vs-reference` requires the receiver and receiver-patch legs'
shots to equal the reference's exactly, full frame and every region. `expected-image-receiver`
and `ink-presence-receiver` are g4a's `expected-image-reference`/`ink-presence-reference` run
over the receiver's shots. `expected-text-reference` and `expected-text-receiver` compare
`synthesizeText` (D8: an oracle node's glyph quads sampled against its page's LA8 alpha, in the
node's font colour, straight-alpha blended over the region's background) with the real shot
inside every visible text node's region, budget `maxChannelDelta` 1 (UNORM8 blend rounding).
`resource-quiet` requires the quiet steps (2, 3, 5, 6, 8) to fetch and upload nothing on either
sink's receiver (`applied.json`'s per-transaction `resources`). `receiver-never-shapes` requires
`receiver-headless-trace`'s openat trace to open no `*.ttf`/`*.otf`/`*.woff`/`*.woff2`/`*.fnt`/
`*.fontdata`, and no file under `receiver/**/*.gd` to reference `TextServer`,
`TextServerManager`, `Font`, `FontFile`, `Label`, `RichTextLabel`, `draw_string` or `draw_char`.
`receiver-consumed-stream` requires every file-mode receiver's `applied.json` to report status
`ok`, `end_seen` true and `recording.sha256` equal to its own local copy. `receiver-never-loaded-
fixture` (gate 0's check, with `fixtureProjectDir` = `fixtures/gate4/`) and `receiver-typed-clean`
cover the same six receiver legs. `atlas-hash-parity-sabotage-omit-atlas` re-runs
`evaluateAtlasParity` against `sabotage-omit-atlas`'s own recording and requires its failing
cells to equal `predictions["sabotage-omit-atlas"].atlas_hash_parity_fails` exactly.

## Gate 4 criteria (g4c)

G4a's and G4b's checks run on the layout fixture with a `-layout` suffix (`capture-armed-layout`
… `receiver-typed-clean-layout`), with these differences: `oracle-agrees-layout` also compares
the word-wrapped line texts, the arbitrary-wrapped line counts, every pass's command count, the
clip flags and the pages per cache (outline caches included) against `expected.json`;
`glyph-commands-layout` compares every pass's commands with the pass colour and the glyph's own
page; `atlas-census-layout` counts creates, updates and frees per cache (plain caches once per
dirty page, outline caches once per new outline glyph, the subpixel cache only "some exactly when
it gains glyphs"); `ink-presence-*-layout` uses `ink_min_glyphs` (a clipped Label must show at
least `clip width // size` glyphs); `expected-text-*-layout` synthesizes every pass with its own
colour and page and the Label's clip. New: `atlas-pages` (each cache's oracle pages equal the
mapped wire textures in count, format and side; F@320 has ≥ 2 1024² LA8 pages), `subpixel-census`
(FX@14's uploads per step ≤ the oracle's new (glyph, x shift) pairs and ≥ 1 when any),
`page-lifetime` (step 8: FL's page freed and out of the table, FL2's page created with a new id,
in one frame, both sinks), `clip-rects-derived-layout` (gate 3's `deriveClipRects` gives LK and LP
exactly `clip_rects` and no other Label a clip), `leg-class-sabotage-layout-omit-atlas` (steps
{7,8,9}), `sabotage-layout-omit-atlas-regions` (every differing pixel inside LP),
`atlas-hash-parity-sabotage-layout-omit-atlas` (F@320 {7,8,9}), `leg-class-capture-lcd`
(`unsupported` for `canvas_item_add_lcd_texture_rect_region` only, LC's 7 commands typed
`unsupported-op`, its RGBA8 page `ok`) and `leg-class-receiver-lcd` (`unsupported`, differing
from `reference-lcd` only inside LC's region).

## Gate 4 criteria (g4d)

`rich-capture-armed`, `rich-headless-no-gpu`, `rich-step-alignment`, `rich-fixture-env`,
`rich-leg-class-capture`, `rich-receiver-vs-reference`, `rich-expected-image-{reference,receiver}`,
`rich-ink-presence-{reference,receiver}`, `rich-reference-repeat-budget`, `rich-armed-transparent`,
`rich-resource-quiet` and `rich-leg-class-receiver{,-patch}` are g4a/g4b's own checks run over
`fixtures/gate4-rich/` (its own `RTL` region in place of the seven Label regions, no panel).
`rich-atlas-hash-parity`, `rich-atlas-append-only` and `rich-atlas-census` are g4a's
`checkAtlasHashParity`/`checkAtlasAppendOnly`/`checkAtlasCensus` reused unchanged, over the five
caches `F@16`, `F@24`, `FB@16`, `FI@16` and `FO@16` (the outlined span's outline-pass cache,
relabelled so it never collides with `F@16` under `cacheKeyOf`'s `font_key@size` grouping).
`rich-oracle-agrees` requires the oracle's per-span glyph_count and cache (an outlined span's two
expanded entries, grouped by `key`) to equal `expected.json`'s independent derivation, and both
reference legs to write byte-identical oracle logs. `rich-glyph-commands` groups `RTL`'s
`add_texture_rect_region` commands by wire id and requires the sum to equal the oracle's per-span
glyph_count grouped by the same id (through `rich-atlas-hash-parity`'s mapping), requires bold and
italic to map to a wire id distinct from the plain fill cache ("own page"), and requires each
`[bgcolor]` span to have exactly one colour-matching `add_rect`. `rich-clip-rects-derived` requires
`deriveClipRects` (lib/clip-derive.ts) over `RTL` on each settle transaction of both sinks to equal
`expected.json`'s fixed clip rect for every step. `rich-underline-capture-class` requires
`rich-underline/capture`'s own recording to classify `unsupported` purely from an observed
`canvas_item_add_line` command (no receiver or pixel comparison). `leg-class-rich-underline-
receiver` requires `unsupported` with every step a predicted mismatch, and `rich-underline-
confined` requires that mismatch to sit entirely inside `RTL`'s region at every step, with every
other region (the marker) exact.

## Gate 4 criteria (g4f)

G4a's and G4b's checks run on the multilingual fixture with an `-i18n` suffix
(`capture-armed-i18n` … `receiver-typed-clean-i18n`), with these differences: `fixture-env-i18n`
pins OS (three fallbacks, in the order VZ, DV, HE) and each fallback with D3's properties and all
four font hashes; `oracle-agrees-i18n` compares glyph counts only where `make_expected.py`
predicts them (OS strings and the bidi string; the oracle is the only source for complex
scripts), the hex-box `add_rect` counts, the font of every shaped glyph (the first of the
fallback chain that maps its codepoint) and the pages per cache; `glyph-commands-i18n` compares
every command in draw order, texture glyphs against their own font's page and hex-box bars as
`add_rect`; `ink-presence-*-i18n` uses `ink_min_glyphs` (spacing clusters); `expected-text-*-i18n`
synthesizes texture glyphs and hex-box rects (pixel centres in the half-open rect). New:
`script-predictions` (Q6e's eight hand predictions, on the oracle and on both sinks: NFD
composition to OS's U+1EBF glyph, lam-alef one glyph, ZWNJ an invisible index-0 glyph, niqqud
marks in their base's cluster over its quad, Devanagari fewer glyphs than codepoints, the i-matra
left of KA, the Hebrew run's x decreasing in logical order, the hex box with 26 `add_rect`s and
no texture command), `fallback-pages` (each font's page absent from the oracle before its first
script, created once at that step's applied frame and first in either sink's table there),
`leg-class-sabotage-i18n-omit-atlas` (steps {5..9}), `sabotage-i18n-omit-atlas-regions` (every
differing pixel inside LD2) and `atlas-hash-parity-sabotage-i18n-omit-atlas` (DV@16 {5..9}).

## Gate 4 criteria (g4e)

G4a's and G4b's checks run on the MSDF fixture with a `-msdf` suffix (`capture-armed-msdf` …
`receiver-typed-clean-msdf`), with these differences: `fixture-env-msdf` pins `FM` as `F` with
MSDF on at msdf_size 48 and msdf_pixel_range 24; `oracle-agrees-msdf` requires every glyph to be an
MSDF glyph of the one `FM@48` cache with `outline` its pass's, px_range 24 and scale size/48, and
one 512×512 RGBA8 page; `glyph-commands-msdf` compares every command as
`add_msdf_texture_rect_region` bit for bit with the oracle's float32 quad and source rect, the pass
colour, outline, px_range, scale and page; `atlas-append-only-msdf` decodes RGBA8 pages with the
empty texel `(0,0,0,0)`; `atlas-census-msdf` (G4c's evaluator) requires one create at step 0, one
update per Label draw that adds glyphs (two at step 7), and nothing at the size change, the outline
toggle or any other quiet step; there is no synthesized MSDF ink (`expected-text-*`), because MSDF
coverage comes from the GPU's `fwidth`; `reference-repeat-budget-msdf` measures the budget per
region (expected 0) and `receiver-vs-reference-msdf` holds both receivers within it. New:
`msdf-args` (every msdf command on every transaction of both sinks: px_range 24, a known scale,
outline 0 or 4, no typed msdf refusal, no plain region glyph; per settle step each Label's own
scale and outline commands), `atlas-pages-msdf`, `receiver-msdf-commands` (`applied.json`
`msdf_commands` on every transaction; seq 1 replays all 25 step-0 commands),
`leg-class-sabotage-msdf-perturb-glyph` ({1..9}), `sabotage-msdf-perturb-glyph-regions`
(per-step regions from `predictions`: a Label mismatches from its first redraw after frame 11; MR
never redraws), `sabotage-msdf-perturb-glyph-recorded` (+0.25 on exactly those Labels' rects, as
recorded), `leg-class-sabotage-msdf-receiver-drop` ({0..9}), `-regions` (every Label at every
step), `-silent` (zero msdf calls, no msdf unsupported record), `leg-class-sabotage-gray-perturb-
glyph` ({1..9}, `fixtures/gate4/expected.json` `predictions`), `-regions` and `-recorded`.

## Gate 4 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate4.ts
python3 experiments/render-stream/fixtures/gate4/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-layout/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate4d.ts
python3 experiments/render-stream/fixtures/gate4-rich/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-i18n/make_expected.py --check
python3 experiments/render-stream/fixtures/gate4-msdf/make_expected.py --check
```

Group g4e's cases are in `test/gate4e-cases.ts`: `expected.json`'s rules (an upload at the size
change and msdf_size 128 both fail); a synthetic MSDF oracle and recording (oracle, glyph commands
and arguments: a wrong outline, an old scale, a dropped glyph, a quarter-pixel quad, a plain region
command, px_range 14 and a typed msdf refusal each fail); the census (an upload at the size change
fails); `evaluateWithinBudget`, `evaluatePredictedRegions` and `evaluatePerturbRecorded` on
hand-built frames, checkpoints and recordings — each passing and failing.

Group g4c's cases are in `test/gate4c-cases.ts`: `expected.json`'s rules and hand-typed census
facts of `deriveLayoutCensus`; a synthetic layout oracle and recording (oracle, glyph commands,
census, lifetime); the subpixel bound on hand-built pairs; `synthesizeLayoutText` on a 4×4 page
(per-glyph colour, outline page keys, clip); and the LCD region rule — each passing and failing.
Group g4f's are in `test/gate4f-cases.ts`: `expected.json`'s rules, `unitsOf` and
`deriveI18nCensus`; a synthetic shaped world (oracle, commands, script predictions, fallback
pages) that passes and then fails on a glyph from the wrong fallback, a moved quad or hex bar, an
i-matra right of KA, a left-to-right Hebrew run, a texture command in the hex box, an early
fallback page and a late create; and a half-pixel hex bar in `synthesizeI18nText`.

GRT1 hashing is checked against SHA-256 values computed independently with Python (an empty
256×256 LA8 page, the size of every gate 4 page, and an 8×8 one), and append-only on a hand-built
8×8 LA8 pair. A synthetic world is then built from `expected.json` alone: an oracle log, a
recording whose settle transactions carry matching glyph commands and page versions, a hook log, a
store and shots. Every check passes on it and fails on at least one perturbation, among them a
quarter-pixel glyph shift, the omit-atlas sabotage (failing exactly at `predictions`' parity
cells), a single upload at step 7, an upload in a quiet step, an atlas published a frame late, and
a rewritten inked texel. `synthesizeText`/`compareSynthesizedText` (G4b, D8) are covered directly:
a hand-built 8×8 LA8 page and a one-glyph oracle node blend red ink at exactly 2/3 coverage over a
background whose channels are hand-computed (no rounding ambiguity), a pixel outside the glyph
stays the background, an identical copy compares with zero mismatch, a perturbed pixel is reported
with its exact delta, and a glyph naming a page the caller never loaded is recorded as missing
rather than synthesized wrong.

`self-test-gate4d.ts` covers only what G4d adds (every reused check already has its own case
above, against the same functions): `evaluateRichOracleAgrees` over an oracle synthesized from
`fixtures/gate4-rich/expected.json`'s own `spans` (independent of `glyph_oracle.gd`, as
`buildWorld` is independent of `fixtures/gate4/glyph_oracle.gd`) passes, then fails on a
byte-differing second leg, a wrong `glyph_count`, a missing outline-pass entry for the outlined
span (an outlined span needs exactly two oracle entries sharing its key, not one), and a wrong
`page_glyphs` prediction; `checkMismatchConfinedToRegion` passes when only `RTL` differs and fails
when the marker also differs or when `RTL` itself has no mismatch.

## Gate 5 files

```bash
mise exec -- pnpm render-stream:gate5 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g5b,g5c]
```

- `run-gate5.sh`: the orchestrator (`run_g5b`, `run_g5c`, `run_reference` with `REFERENCE_ARMED`,
  `REFERENCE_VARIANT`, `REFERENCE_FIXTURE_DIR` and `REFERENCE_MESH_ORACLE`). Groups g5d, g5e, g5f
  and g5g are known but have not landed, so asking for them exits 2. The capture writes both sinks under gate 2's `.rs2` names whatever wire version
  `main` speaks.
- `check-gate5.ts`: the checker CLI; writes `<out>/result.json` (`render-stream-gate5-report/1`:
  gate 4's shape with `geometry` (the hook census as measured, the capture's commands per op per
  step, the raster's pixel classes per step), `meshes` (G5c: per fixture mesh its hook-log lines,
  last version and median copy/hash cost, and `_parity`, the agreed hash per mesh and step),
  `budgets` (reference against repeat per region and pixel class) and `freshness`). With g5c it
  merges `runGate5c`'s checks and legs into the same report.
- `lib/gate5-expected.ts`: `expected.json`'s types, `stepFrames5`, transforms and texel decoding.
- `lib/geometry-raster.ts`: the reference rasterizer (`rasterizeGate5`, `rasterizeItems`). Pixel
  centre coverage, undecided within 1/16 px of a boundary edge (welded vertices; shared edges are
  not boundaries), flat colours exact, gradients and `.6` blends delta 1, nearest sampling decided
  only where the texels within 1/16 texel agree, `map_ninepatch_axis` per axis, draw transforms
  replaced (D9), clip-ignore spans (D10), band pixels for antialiased shapes and thin lines.
- `lib/gate5-checks.ts`: the g5b checks, pure over evidence already read.
- `lib/gate5c-checks.ts`: the g5c checks (fixtures/gate5-mesh): `expected.json`'s types, the census
  expansion, the hook-log hash replay, the oracle and parity checks, `runGate5c`.
- `test/self-test-gate5.ts`, `test/self-test-gate5c.ts`: below.

## Gate 5 legs and evidence under `--out`

| Leg                | Group | Directory           | Runs                                                                                                                  |
| ------------------ | ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `import`           | g5b   | `import/fixture/`   | the mise editor's `--import` of `fixtures/gate5`                                                                      |
| `capture`          | g5b   | `capture/`          | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `reference`        | g5b   | `reference/`        | rendered in gamescope, extension absent: `shots/step-0..9.png`, `steps.jsonl`                                         |
| `reference-repeat` | g5b   | `reference-repeat/` | the same again                                                                                                        |
| `reference-armed`  | g5b   | `reference-armed/`  | rendered, extension armed with `GRC_STREAM_OUT` and a store, shots                                                    |
| `import-mesh`      | g5c   | `mesh/import/fixture/` | the mise editor's `--import` of `fixtures/gate5-mesh`                                                              |
| `capture-mesh`     | g5c   | `mesh/capture/`     | as `capture`, on `fixtures/gate5-mesh`; `evidence/resources.jsonl`'s mesh lines are the census                        |
| `reference-mesh`   | g5c   | `mesh/reference/`   | rendered, extension absent, mesh oracle on (`RS_FIXTURE_MESH_LOG`): shots, `steps.jsonl`, `meshes.jsonl`             |
| `reference-mesh-repeat` | g5c | `mesh/reference-repeat/` | the same again                                                                                               |
| `reference-mesh-armed` | g5c | `mesh/reference-armed/` | rendered, extension armed with a stream and a store, oracle off: shots and its own hook log                    |

## Gate 5 criteria (g5b)

`capture-armed`, `headless-no-gpu`, `recording-decodes` (both sinks), `patch-resolves-to-full` and
`no-draw-index-ties` are gate 3's; `step-alignment` reads the four step logs and the capture's
marker colours. `expected-self-consistent` re-derives in TypeScript what `make_expected.py`
asserts: grid colours (alpha 1, the blend polygon .6), disjoint regions with nothing synthesized
outside them, tie-freeness of every integer non-axis boundary edge of an exact mesh, the census
columns, and `fresh` against the raster. `geometry-hook-census` requires `counters.json`'s counts
per draw op to equal `hook_census` (an op the record does not hook yet, `add_multiline` before
calibrator 7, must be absent and is reported), every other draw op 0, and three texture creates.
`expected-image-reference` compares every shot with `rasterizeGate5` on every decided pixel (exact,
or within 1 where colours interpolate or blend). `presence-reference` requires every sub-shape,
band included, to change at least half its covered pixel count from what the raster has beneath
it. `freshness-reference` requires a region to change between consecutive shots exactly when
`fresh` says. `reference-repeat-budget` requires identical shots and reports the maxima per region
and pixel class (exact, delta1, band, undecided). `armed-transparent` requires the armed
reference's shots to equal the reference's. `leg-class-capture` requires class `unsupported`, the
unsupported ops to be exactly `typed_ops` (plus `calibrator7_ops` once planned), every entry
`unsupported-op`, and at every settle frame each item's commands to be its expected typed list in
call order (`add_rect` float32-exact). `support-legs-exit` requires the import and rendered legs to
exit 0.

## Gate 5 criteria (g5c)

The capture checks run on `mesh/` under `mesh-` names (`mesh-capture-armed`, `mesh-headless-no-gpu`,
`mesh-recording-decodes`, `mesh-patch-resolves-to-full`, `mesh-step-alignment`,
`mesh-no-draw-index-ties`). `mesh-expected-self-consistent` re-derives the colour, texel, region,
raster and `fresh` rules, each live mesh's surface count and the census versions (+1 per accepted
call, a free carrying the last). `mesh-draw-census` requires `counters.json` to equal `draw_census`
(one `add_mesh` per item draw, `DF` on every frame, every mesh call, `attach_skeleton` per
`Polygon2D` draw plus its destructor's at teardown) and every other draw op 0. `mesh-census` requires
the hook log's mesh lines, frame by frame up to the quit frame, to equal the census expanded with
`DF`'s per-frame rule, on the capture (quit 400) and on the armed reference (quit 102): ids 1.. in
`mesh_order`, all on the main thread and `applied`. `oracle-agrees` requires both oracle logs to
report every mesh's status, surface count, custom AABB, primitives, formats and counts as
`expected.json`, the derived `Polygon2D` RID verified, and the two logs byte-identical.
`mesh-hook-hash-parity` requires, at every settle step and for every live surface, the hook log's
last hash (capture and armed reference), the oracle's readback hash and `make_expected.py`'s GRM1
model to be one hash. `mesh-expected-image-reference` compares every shot with the raster on the
exact regions (`DF` is band), `mesh-presence-reference` every surface's presence,
`mesh-freshness-reference` `fresh` with `RM` changing at 2, 3 and 4 without a redraw,
`mesh-reference-repeat-budget` and `mesh-armed-transparent` the legs pixel for pixel.
`leg-class-capture-mesh` requires class `unsupported` with `canvas_item_add_mesh` the only
unsupported op, each item's commands per settle frame (`FR`'s empty from 8) and `RM`'s
`content_version` constant over the run. `mesh-support-legs-exit` requires the import and rendered
legs to exit 0.

## Gate 5 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate5.ts
python3 experiments/render-stream/fixtures/gate5/make_expected.py --check
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate5c.ts
python3 experiments/render-stream/fixtures/gate5-mesh/make_expected.py --check
```

The rasterizer is checked on hand cases whose answers are typed in, not computed by it: a tie-free
triangle against its edge equation (coverage, the 1/16 px decision inside and outside, a near-edge
pixel), a set-transform that replaces rather than composes, a clip-ignore span, a gradient and a
`.6` blend with hand-computed bytes, `map_ninepatch_axis` in `stretch`, `tile`, `tile_fit` and the
end margin, a hollow nine-patch, a thin line and an antialiased rect's band, and a welded closed
strip. `checkExpectedSelfConsistent` passes on the committed file and fails on an off-grid colour,
overlapping regions, an even-parity edge, a census cell and a wrong `fresh`. The image checks run
on frames built from the raster (band areas painted) and fail on an exact pixel off by 1, a
delta-1 pixel off by 2, a missing polygon or thin line, a stale or a spuriously changed region and
a differing band pixel. `geometry-hook-census` and `leg-class-capture` run on synthetic counters
and recordings, before and after calibrator 7 hooks `add_multiline`, and fail on a count, an
unexpected op, a class, an `add_rect` argument and a command order.

`self-test-gate5c.ts` runs `checkMeshExpectedSelfConsistent` on the committed mesh expected.json
and fails it on a wrong `fresh`, a surface count and a census version; checks `expandCensus`'s
shape (three `DF` lines a frame, `DF2` at 2 + 3 × 349 by frame 400, bounded at the quit frame);
runs `evaluateMeshCensus` on the census written out as a log (with a teardown free after quit) and
fails it on a missing line, a version, an extra mesh, a line off the main thread and a rejected
update; replays a hand hook log (adds, an update, a remove, a clear, a free, a single-surface
`create_from_surfaces`); and runs the oracle, parity, draw-census and capture checks on synthetic
values, failing each on one field, hash, flag or command.

## Gate 5.5 files

```bash
mise exec -- pnpm render-stream:gate55 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g55c]
```

- `run-gate55.sh`: the orchestrator (`run_g55c`, `run_reference` with `REFERENCE_ARMED`,
  `REFERENCE_VARIANT`, `REFERENCE_FIXTURE_DIR` and `REFERENCE_MATERIAL_ORACLE`). Groups g55b, g55d,
  g55e and g55f are known but have not landed, so asking for them exits 2. The captures write both
  sinks under gate 2's `.rs2` names whatever wire version `main` speaks.
- `check-gate55.ts`: the checker CLI; writes `<out>/result.json` (`render-stream-gate55-report/1`:
  gate 5's shape with `materials` (per fixture: the material `counters.json` counts, the oracle's
  shader hash per step and the capture's `content_version`s per item), `budgets` and `freshness`).
- `lib/gate55c-checks.ts`: the g55c checks (fixtures/gate55-shader): `expected.json`'s types, the
  refused variant's view, the oracle checks, the capture typing, `runGate55c`. Image, presence,
  freshness and leg comparisons are gate 5's (`lib/gate5-checks.ts`, `lib/geometry-raster.ts`).
- `test/self-test-gate55c.ts`: below.

## Gate 5.5 legs and evidence under `--out`

| Leg                       | Group | Directory                    | Runs                                                                                              |
| ------------------------- | ----- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `import-shader`           | g55c  | `shader/import/fixture/`     | the mise editor's `--import` of `fixtures/gate55-shader`                                          |
| `capture-shader`          | g55c  | `shader/capture/`            | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps/fd |
| `capture-refused`         | g55c  | `shader-refused/capture/`    | the same with `RS_FIXTURE_VARIANT=refused`                                                        |
| `reference-shader`        | g55c  | `shader/reference/`          | rendered in gamescope, extension absent, material oracle on (`RS_FIXTURE_MATERIAL_LOG`): `shots/step-0..9.png`, `steps.jsonl`, `materials.jsonl`, `shader-library/sha256/*.grp` |
| `reference-shader-repeat` | g55c  | `shader/reference-repeat/`   | the same again                                                                                    |
| `reference-shader-armed`  | g55c  | `shader/reference-armed/`    | rendered, extension armed with `GRC_STREAM_OUT` and a store, oracle off                           |
| `reference-refused`       | g55c  | `shader-refused/reference/`  | rendered, variant `refused`, oracle on                                                            |

## Gate 5.5 criteria (g55c)

`shader-expected-self-consistent` and `refused-expected-self-consistent` re-derive in TypeScript
what `make_expected.py` asserts: grid colours at alpha 1, disjoint regions with nothing synthesized
outside them, `fresh` against the raster, only the marker redrawn after step 0, the oracle views in
shader and material order with their declared parameters and statuses moving absent → live →
freed, and `PH`'s phase the settle frame. The capture checks are gate 3's under `shader-` and
`refused-` names (`shader-capture-armed`, `shader-headless-no-gpu`, `shader-recording-decodes`,
`shader-patch-resolves-to-full`, `shader-step-alignment`, `shader-no-draw-index-ties`,
`refused-capture-armed`, `refused-recording-decodes`, `refused-step-alignment`). `shader-counters`
requires both captures' `counters.json` to equal `expected.json` `counters`: the four material calls
the record hooks before calibrator 8, with `PH`'s `phase` on every frame, the draws and three
textures. `capture-shader-log-clean` requires neither capture host to print `SHADER ERROR` or
`Shader compilation failed`. `oracle-agrees` requires every oracle log (both references and
`reference-refused`) to report each shader's and material's status and every declared parameter
and instance parameter with `expected.json`'s Variant type and value (float32 components widened,
compared exactly), and the two reference logs to be byte-identical. `shader-code-model` requires
each live shader's GRP1 hash, size and include markers, as the oracle reads them through
`shader_get_code`, to equal `make_expected.py`'s preprocessor port. The image checks are gate 5's
on the shader fixture (`shader-expected-image-reference`, `shader-presence-reference`,
`shader-freshness-reference` with `TI` fresh at 1, 3 and 4 and its `content_version` constant,
`shader-reference-repeat-budget`, `shader-armed-transparent`) and on the refused reference
(`refused-expected-image-reference`, every region exact). `leg-class-capture-shader` and
`leg-class-capture-refused` require class `unsupported`, `canvas_item_set_material`
(`unsupported-state`) as the only unsupported op, on exactly the material items at every settle
frame, and every item's `content_version` constant but the marker's. `shader-support-legs-exit`
requires the import and rendered legs to exit 0.

## Gate 5.5 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate55c.ts
python3 experiments/render-stream/fixtures/gate55-shader/make_expected.py --check
```

`self-test-gate55c.ts` runs both self-consistency checks on the committed `expected.json` and
fails them on an off-grid colour, a wrong `fresh`, overlapping regions, a freed shader coming back
and a phase off its settle frame. It runs `oracle-agrees` and `shader-code-model` on oracle lines
made from `expected.json`, then fails them on a parameter typed `int`, a colour written as a
double instead of float32, `I2`'s default typed `color`, `MR` not freed, a frame off, the repeat's
bytes differing, `tint`'s hash unchanged at step 3 and include markers on `pal`. The counter,
stdout, step-log and capture-typing checks run on synthetic values, failing on a short count, an
unexpected draw, a compile error, a missing step, class `success`, a redrawn item, an untyped item
and another reason.
