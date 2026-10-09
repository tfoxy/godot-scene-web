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
Since G2b2 it runs on render-stream/2 (`recording.rs2`, full encoding; render-stream/1 from G1b2
to G2b2), and every capture leg sets `GRC_ROOT_SIZE=enforce-min-size`: without it the 64×64
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
| `receiver-typecheck`      | `receiver-typecheck/{selftest,minimal}/` | mise editor: `--script res://tests/codec2_selftest.gd` with `RS_SELFTEST_GOLDEN_DIR=protocol/golden-2`, then a headless replay of `golden-2/inline.rs2` (inline, no store; a fresh cache)      | —                                        |
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
| `manifest-present`              | session `protocol` `render-stream/2`, a full file stream, the exact /2 `features` (`resources` key included), the file sinks' `resources` (out-of-band, `directory` fetch, the six permitted formats), `engine.display_server` `headless`, `viewport.root_canvas` 1, `root_size_policy` `enforce-min-size` with `host_size_status` `match` and 640×360 logical and window sizes, and `sabotage` null |
| `step-alignment`                | `capture` and `reference` `steps.jsonl` equal `expected.json`'s frames, and each step's marker colour (as float32) first appears at its applied frame                                                                                                                                                                                                                                                |
| `expected-image-reference`      | every `reference/shots/step-<k>.png` equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                          |
| `expected-image-receiver`       | every receiver settle shot equals `synthesizeExpected(k)` exactly                                                                                                                                                                                                                                                                                                                                    |
| `receiver-vs-reference`         | receiver vs reference at every step, full frame and both regions: 0 mismatched pixels and max channel delta 0 (`compareRgbaBuffers` with exact budgets)                                                                                                                                                                                                                                              |
| `receiver-consumed-stream`      | `receiver` `applied.json` is `render-stream-receiver-applied/3`, seqs 1..N, each `record_sha256` equal to the host's, every shot `applied_through == seq`, `recording.sha256` equal to the capture file's, and `resources_summary` shows nothing fetched and nothing uploaded                                                                                                                        |
| `receiver-never-loaded-fixture` | the traced receiver opens its recording and nothing under `fixtures/`; no file in `receiver/` (outside `.godot/`) is byte-identical to one in `fixtures/gate0/`; no receiver log has a `[fixture]` line; argv has `--path <abs receiver>`                                                                                                                                                            |
| `receiver-typed-clean`          | no `SCRIPT ERROR`, `SCRIPT WARNING`, `Parse Error` or `Failed to load script` in the typecheck logs; the selftest printed `[rs2-selftest] ok` and exited 0; the `golden-2/inline.rs2` replay is ok and reports exactly the golden's unsupported entries, each at its first seq                                                                                                                       |
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
render-stream/2 by `test/rs2-test-encoder.ts` (every texture table holding the engine's hue
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
render-stream/2 (render-stream/1 from G1b2 to G2b2). Run it from the repo root:

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
`sent_without_credit` and `stale_sent`. Since G2b2 every live connection is inline (until G2c2):
the subprotocol is `render-stream.2`, live receivers get no cache, and right before the
transaction that first needs a payload (at least the hue strip, before seq 1) the host sends it as
a resource record, one binary message of its own, logging a `resource` event line (`hash`,
`bytes`); the summary gains `resource_records` and `resource_bytes` per connection. Not every
message after the first is a transaction, so the checks find transactions by seq only.

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
| `live-handshake` (g1c)                                                                                                          | `live`, `live-headless`: subprotocol `render-stream.2` negotiated, the host logged the hello (credit stage `submitted` / `applied`, the receiver's inbound buffer), one connection, no host error, the end record sent, and the receiver closed with 1000 after reading it                                                                                                                                                                                                                                       |
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
the sabotages) have landed; `g2c`-`g2e` arrive with their increments and are refused until then.
g2b needs g2a's captures and reference, so `--legs g2b` alone is refused. Run it from the repo
root:

```bash
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--binary /abs/path/to/linux_release.x86_64] [--out /abs/path/to/fresh/dir] [--legs g2a,g2b]
```

The arguments and refusals are gate 1's; `--out` defaults to `artifacts/render-stream/gate2/<UTC>/`.
The runner takes about five minutes. It uses `lib/legs.sh` (`run_headless`, `run_capture`,
`run_rendered`, `settle_seqs`, `start_headless_bg`) and one private gamescope per group.
`GS_STRIP_VARS` lists every `GRC_*` and `RS_*` variable gate2-design.md introduces, landed or not.

## Gate 2 files

- `run-gate2.sh`: the orchestrator (`run_g2a`, `run_g2b`, `run_reference`, `g2_capture`,
  `g2_receiver`, `start_live_host`).
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
  included) and `runG2b`.
- `check-gate2.ts`: writes `<out>/result.json` (`render-stream-gate2-report/1`) and exits non-zero
  unless `gate_passed`.
- `test/self-test-gate2.ts`: see below.

## Gate 2 legs and evidence under `--out`

| Leg                       | Group | Directory                             | Runs                                                                                                                                                                                                              |
| ------------------------- | ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import`                  | g2a   | `import/{fixture,receiver}/`          | the mise editor's `--import` of `fixtures/gate2` and `receiver/`                                                                                                                                                  |
| `capture`                 | g2a   | `capture/`                            | the release template, `--headless`, armed, both sinks, the store, `GRC_ROOT_SIZE=enforce-min-size`, quit 400, strace + maps                                                                                       |
| `capture-unsupported`     | g2a   | `capture-unsupported/`                | the same with `RS_FIXTURE_VARIANT=unsupported`, the fixture's own quit frame, no strace                                                                                                                           |
| `reference`               | g2a   | `reference/`                          | rendered in gamescope, extension absent: `shots/step-0..10.png`                                                                                                                                                   |
| `reference-repeat`        | g2a   | `reference-repeat/`                   | the same again                                                                                                                                                                                                    |
| `reference-armed`         | g2a   | `reference-armed/`                    | rendered, extension armed with `GRC_STREAM_OUT` and a store (so the hooks copy and hash), shots                                                                                                                   |
| `capture-inline`          | g2b   | `capture-inline/`                     | capture with `GRC_RESOURCE_INLINE_MAX_BYTES` = `GRC_RESOURCE_MAX_PAYLOAD_BYTES` = 16 MiB (delivery `inline`), no store, quit 400                                                                                  |
| `receiver-cold`           | g2b   | `receiver-cold/`                      | rendered receiver on `capture/recording.rs2`, fresh `cache/`, store = `capture/store`, shots and state dumps at the 11 settle seqs                                                                                |
| `receiver-warm`           | g2b   | `receiver-warm/`                      | a new rendered receiver on `receiver-cold/cache` with `RS_RECEIVER_CACHE_MODE=warm`                                                                                                                               |
| `receiver-patch`          | g2b   | `receiver-patch/`                     | rendered receiver on `capture/recording-patch.rs2`, its own fresh cache                                                                                                                                           |
| `receiver-inline`         | g2b   | `receiver-inline/`                    | rendered receiver on `capture-inline/recording.rs2`, fresh cache, no store                                                                                                                                        |
| `receiver-headless-trace` | g2b   | `receiver-headless-trace/`            | headless receiver on `capture/` under `strace -e openat`                                                                                                                                                          |
| `live-inline`             | g2b   | `live-inline/{host,receiver}/`        | host (`GRC_LIVE_LISTEN`, S = 300, N = 60, both sinks and a store) + headless live receiver (`applied` credit)                                                                                                     |
| `reference-unsupported`   | g2b   | `reference-unsupported/`              | rendered fixture, `RS_FIXTURE_VARIANT=unsupported`, extension absent                                                                                                                                              |
| `unsupported-textures`    | g2b   | `unsupported-textures/receiver/`      | rendered receiver on `capture-unsupported/`                                                                                                                                                                       |
| `sabotage-<name>`         | g2b   | `sabotage-<name>/{capture,receiver}/` | omit-update (`omit-op texture_2d_update` @61), omit-replace (`omit-op texture_replace` @71): captures + rendered receivers; stale-texture @61, wrong-hash @61, spurious-update @21: captures + headless receivers |
| `sabotage-receiver-*`     | g2b   | `sabotage-receiver-*/receiver/`       | headless receivers on `capture/`: `RS_RECEIVER_SABOTAGE=reupload` (fresh cache), `ignore-cache` (warm, on a copy of `receiver-cold/cache`)                                                                        |

Every fixture run writes `steps.jsonl` and `textures.jsonl` (`RS_FIXTURE_TEXTURE_LOG`). Every armed
run writes `evidence/resources.jsonl` (the hook log) and `evidence/root.json`, whose additive
`texture_defaults` holds the arm-time root filter and repeat. Payloads are written only under the
run directory: each capture's `store/`, each receiver's `cache/`.

## Gate 2 criteria (g2a)

`capture-armed` (55 hooks), `headless-no-gpu` and `recording-decodes` (400 transactions) are gate
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

| Check                                | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordings-decode-2`                | both sinks of `capture`, `capture-inline` and `capture-unsupported` pass render-stream-2.ts `validateRecording`                                                                                                                                                                                                                                                                                                                                               |
| `patch-resolves-to-full`             | each patch sink resolves to its full sink at every seq and frame, textures and defaults included                                                                                                                                                                                                                                                                                                                                                              |
| `store-complete`                     | every ok hash of either sink is a `sha256/<hash>.grt` in the capture's store that hashes to its name, nothing else is there, `index.jsonl` names each once                                                                                                                                                                                                                                                                                                    |
| `inline-equals-store`                | `capture-inline` declares delivery inline / fetch none, equals `capture` at every frame, and every inline payload equals the store's file                                                                                                                                                                                                                                                                                                                     |
| `texture-versions-current`           | every transaction's table (both sinks of three captures and the live host) agrees with the hook log replayed to its frame: version, kind, status, hash; nothing missing, nothing extra                                                                                                                                                                                                                                                                        |
| `texture-invariants`                 | every `expected.json` texture invariant on the capture's settle transactions; no replaced-away (temporary) id ever appears                                                                                                                                                                                                                                                                                                                                    |
| `receiver-vs-reference`              | the cold, warm, patch and inline receivers' settle shots equal the reference's exactly, full frame                                                                                                                                                                                                                                                                                                                                                            |
| `expected-image-receiver`            | `receiver-cold`'s shots equal `synthesizeGate2` outside `synth_exclude`                                                                                                                                                                                                                                                                                                                                                                                       |
| `transform-only-no-resource-traffic` | steps 2 and 10: no texture call in the hook log, empty `textures`/`removed_textures` in the patch sink, every receiver resource counter 0                                                                                                                                                                                                                                                                                                                     |
| `upload-accounting`                  | per step the cold and patch receivers' fetched/created/updated/replaced/freed equal `receiver_resources`; the inline receiver the same uploads with 0 fetches and its payloads inline                                                                                                                                                                                                                                                                         |
| `warm-cache`                         | `receiver-warm` fetches nothing, its hits equal `receiver-cold`'s fetches, and its uploads, `rs_calls`, shots and state dumps are identical                                                                                                                                                                                                                                                                                                                   |
| `fresh-cache`                        | `receiver-cold`'s cache started empty and ends holding exactly its verified fetches                                                                                                                                                                                                                                                                                                                                                                           |
| `freed-draws-default`                | at step 8 RAW1's rect is white in the reference and the receiver (D11)                                                                                                                                                                                                                                                                                                                                                                                        |
| `copy-at-hook`                       | at step 8 region `s3` equals the synthesis of C's pre-fill content in the reference and the receiver                                                                                                                                                                                                                                                                                                                                                          |
| `unsupported-regions`                | `unsupported-textures` differs from `reference-unsupported` in `u1` and `u2` at every step and nowhere else                                                                                                                                                                                                                                                                                                                                                   |
| `live-inline`                        | the live session is inline / fetch none, every ok hash arrives as a resource record, `received.rs2` equals the tap, the receiver fetches nothing, and every live transaction equals the host recording at its frame                                                                                                                                                                                                                                           |
| `receiver-consumed-stream`           | every file-mode receiver read its own copy of the capture recording                                                                                                                                                                                                                                                                                                                                                                                           |
| `receiver-never-loaded-fixture`      | the traced receiver opens nothing under `fixtures/`, opens its recording and reads the store                                                                                                                                                                                                                                                                                                                                                                  |
| `receiver-typed-clean`               | no receiver log has a SCRIPT ERROR / WARNING / Parse Error                                                                                                                                                                                                                                                                                                                                                                                                    |
| `leg-class-<leg>`                    | each leg at gate2-design.md G2b2's expected class: receivers and `live-inline` success; `unsupported-textures` unsupported; omit-update pixel-mismatch {6}; omit-replace pixel-mismatch {7..10}; stale-texture capture-failure (texture-log-divergence); wrong-hash replay-failure (resource-hash-mismatch at step 6's seq); spurious-update, reupload, ignore-cache resource-violation (transform-only-resource-traffic, redundant-upload, warm-cache-fetch) |

Classification (`classifyG2bLeg`) takes gate 0's `classifyLeg` for capture-failure, unsupported and
replay-failure, adds capture-failure for a stream reason (store failure, budget) and for
texture-log-divergence, resource-violation for transform-only traffic, redundant fetches and
uploads and warm-cache fetches, and pixel-mismatch from the receiver's settle shots against the
reference; the first class in Q7's precedence wins.

## Gate 2 self-test

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/test/self-test-gate2.ts
```

Unit cases cover `sampleAt` (flips, transpose, S3's rotation, the region across four quadrants,
tile, mirror, clamp, LA8 alpha), `synthesizeGate2` (binary alpha over BG, the freed RAW1, C's
pre-fill content, partial alpha, the animate variant), the step windows, the census helpers, the
hook-log line validation and `checkExpectedSelfConsistent` on the committed file and five broken
copies. A passing g2a+g2b tree is then fabricated (render-stream/2 capture recordings from
`test/rs2-test-encoder.ts`, hook and fixture logs from a model of the fixture's texture calls,
receivers' applied.json, PNGs from `synthesizeGate2`), and each check gets at least one failing
perturbation; the real `runGate2` runs on every tree.
