# HC1: quiet paths (2026-10-28)

Three changes that make the capture's cost follow what is read and what changes, with no wire change.

1. **No unread hook-log lines.** `ResourceLog::start(t0, root, keep_lines)`; `entry.cpp` passes
   `resources_file != nullptr`. With no `resources.jsonl` open, `emit()`, `emit_text()` and the
   multimesh paths return before formatting, and `MultimeshArgs::buffer` skips its SHA-256. The
   registries are kept. `counters.json` gains `hook_log_lines_formatted`.
2. **Same-value `set_material` keeps `material_refs_epoch_`.** `Mirror::set_material` returns before
   touching item state when the material id is unchanged (or the same unknown RID).
3. **No snapshot without a viewer.** `Hub::has_viewer()`; a live listener snapshots only while a
   connection has said hello. A file sink still snapshots every frame. The served set is not released
   when the last viewer leaves (in-flight GETs keep working; the next viewer's retire replaces it).
   Known edge: a freed texture tombstone is erased at the next snapshot, so with skipped snapshots it
   lives longer; visible only if a freed RID is drawn later (an engine error).

## Perf (capture-scale, /11, product hand-off env, hook log off, no tap)

`perf record -g`, main thread, 8 s steady window, ms per frame (`scripts/perf-capture-split.py`;
evidence `artifacts/render-stream/p3/hc1/perf/`, driver `hc-drive2.sh`). "Before" is main at 9bb945f7,
"after" is this branch. Machine load 3.9-5.0 (shared): perf shares, not rates. Capture = main thread
minus engine.

| scene | viewers | capture before | capture after | saved |
| ----- | ------- | -------------: | ------------: | ----: |
| static | 0 | 2.59 | 0.03 | 2.56 |
| churn | 0 | 5.05 | 0.82 | 4.23 |
| static | 1 | 4.38 | 4.56 | none (noise; nothing to skip with a viewer) |
| churn | 1 | 9.54 | 8.55 | 0.99 |
| static | 4 | 4.99 | 4.58 | 0.41 |
| churn | 4 | 10.97 | 8.25 | 2.71 |

Per function, churn with 1 viewer (before -> after): resource-log serve-event lines 0.27 -> 0.02;
`set_material` hook 0.18 -> 0.04; mesh vertex/attribute region hooks 0.77 -> 0.42;
`mesh_set_custom_aabb` 0.08 -> 0.03; snapshot textures/meshes/shaders 0.79 -> 0.39 (the material epoch
no longer forces re-resolution). The 0-viewer static snapshot (item walk 1.34, textures/meshes 0.27,
release 0.25, serving 0.18, material params 0.10) goes to zero. The 0-viewer churn row also drops the
hook-side mesh costs because the hook log no longer hashes buffers; part of that is load noise between
the two profile runs. The 1-viewer static row is unchanged by design (HC2-HC4 address it).

## Byte identity (`cmp-rec.ts --tree`, main 9bb945f7 against this branch; capture sources equal main's)

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 33 | identical |
| gate 2 (g2a, g2b, g2d) | 41 | identical |
| gate 5 (g5c, g5e) | 20 | identical |
| gate 8 (g8w11, g8mm) | 58 | identical |
| capture-scale /8, /10, /11, 300 frames, sync workers, 64x48 textures, redraws 170 | 3 x 302 records | identical; stores `diff -r` equal |
| `resources.jsonl`, hook log on (30 files, gates 1/2/5), minus t_us/rid/copy_ns/hash_ns/ids | 30 | 29 equal; `gate2/live-inline/host` starts at a different frame (live join timing) |
| goldens 2-11, window-1 transcripts | ctest 36/36 | pass |

Outputs: `artifacts/render-stream/p3/hc1/ident/`. The runs were killed by two session restarts; gate 8
on this branch and the scale and perf runs were redone, gates 1/2/5 had completed.

## Checks

- `scripts/run-hc1.sh` (new, 6 legs, ~1 min; `native-rust-hc1` in the tiers) with `lib/hc1-checks.ts`:
  `hook-log-off-formats-nothing`, `no-snapshot-without-viewer`, `late-join-served` (static, churn,
  hook-log-off), `no-pin-without-viewer`, `sabotage-pin-late-caught` (66 x 404).
- Unit tests: `rs_resource_log_test` (counter), `rs_mirror_test::test_same_value_set_material_keeps_epoch`,
  `rs_live_test` (`has_viewer`).

## Deviations from the design

- The `epoch-frozen` sabotage on gate 8 adoption was not built; the mirror unit test (a changed, unknown
  or returning material moves the epoch) is the guard. `resolve_passes` on `gate8-adopt` was not
  separately measured.
- `late-join-served` compares small legs against a file sink in the same run, not the full fixture.
- Wiring: `run-hc1.sh` is the `native-rust-hc1` run (smoke-map universe.native, a rule for `run-hc1.sh`,
  `hc1-checks.ts`, `null-receiver.ts`; remote-capable; no source-cache publish). It honors
  `RS_SABOTAGE_TIER=skip`.
- Test knob `GRC_HC_SABOTAGE=pin-late` is env-only, never on the wire.

## Validation

- Local smoke (`--only native-rust-hc1,native-rust-gate1,native-rust-gate2`): 3/3 pass,
  `artifacts/render-stream/validate/20261028T122046Z`.
- Remote full tier (`remote-validate.sh --tier full`, run 40687061757, key
  `rv-20261028T122052Z-a808a37-1121`, tree rebased on e7182407; PM3 landed after and touches no capture
  file): 21/22 pass, including `native-rust-hc1` (50 s) and native gates -1, 0, 1, 2, 3, 4, 5, 5.5, 8.
  The one failure was `g7-web-rust` g7-8, `web-repeat-identical@web` on
  `g8mm/sabotage-perturb-instance/receiver-patch` (two shots differ between the two web runs): the web
  export's hosted-runner nondeterminism PM3 recorded (results/p3/pm3.md), not this diff, whose
  recordings are byte-identical to main's. Rerun locally (`RS_VALIDATE_GROUPS=g7-8 ... --tier full
  --only g7-web-rust`, run 20261028T133155Z): pass.
- Refused by the remote, run locally: `g7live-gsw` and `g7live-web-rust` g7-1 (full,
  `RS_VALIDATE_GROUPS=g7-1`, run 20261028T133156Z): both pass.
- Not run: `lock-tests` (no lock file in the diff) and the timing runs (native gate 6, `g7live-*-timing`,
  g7x): they go to the sweep.
