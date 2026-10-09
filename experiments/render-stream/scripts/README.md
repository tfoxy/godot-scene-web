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
  display-connection proof, Godot launch with display and `GRC_*` environment stripped and reset.
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
| 9   | `optional-hook-counts`                                                                   | every calibrator-2 hook is installed (`hooks_omitted` empty) and its count is > 0                                                                                                                                                                             |
| 9   | `triangle-array-bit-exact`                                                               | the scripted triangle array's indices, points, colours, UVs, empty bones/weights, texture and count, bit-exact                                                                                                                                                |
| 9   | `stylebox-panel-native`                                                                  | a native triangle array on another item whose every colour is the StyleBoxFlat `bg_color` (opaque fill, alpha-0 feather), plus the Panel's `canvas_item_set_modulate` on that item                                                                            |
| 9   | `shader-material-path`                                                                   | `canvas_item_set_material` on the Panel's item; `material_set_param` on that material; `shader_set_code` on a shader `shader_create_from_code` returned                                                                                                       |
| 9   | `nine-patch-bit-exact`                                                                   | the scripted nine-patch's every argument (including the stack-passed modes, `draw_center` and modulate) bit-exact on the 4×4 texture's RID; the NinePatchRect's native one on the same RID                                                                    |
| 9   | `scripted-shapes-bit-exact`                                                              | the scripted primitive, line, polyline, `add_set_transform` and circle, bit-exact                                                                                                                                                                             |
| 9   | `mesh-surface-and-draw`                                                                  | `mesh_create` → `mesh_add_surface` (primitive, format, counts, buffer sizes, AABB read from `SurfaceData`) → `canvas_item_add_mesh` (transform, modulate) on one RID; an `add_multimesh`; a `mesh_clear` on the other mesh                                    |
| 9   | `mesh-region-updates`                                                                    | vertex/attribute region writes on that mesh with exact surface, offset, size and bytes, at least 55 times in the 60 armed frames; `mesh_set_custom_aabb` with the exact AABB                                                                                  |
| 10  | `older-record-loads`                                                                     | the `old-record` leg armed and disarmed cleanly, `hooks_omitted` is exactly the calibrator-2 set with `null` counts, gate −1 counts > 0, and `calibration-check.json` `hook_plan` is ok and names each omitted hook                                           |

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
