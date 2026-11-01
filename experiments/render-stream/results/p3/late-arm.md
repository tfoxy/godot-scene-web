# Late-arm adoption gaps: pre-arm multimeshes (PM9) and pre-arm canvas textures (2026-11-01)

This increment closes two of the three late-arm adoption gaps the P3 fidelity leg found
(`fidelity.md` "Gap list"): a capture that arms LATE (after the scene already exists) must adopt
pre-arm resources the same as an arm-at-init capture.

- **Pre-arm multimeshes (PM1's gap, `unknown-multimesh`).** Closed. A multimesh created before the
  arm is adopted at its first `canvas_item_add_multimesh` after the arm, from the RenderingServer's
  read-backs (`multimesh_get_*`), with origin `adopted`.
- **Pre-arm canvas textures (C3 gap 5, spine draws through a `CanvasTexture`).** The capture side is
  implemented: a cached `CanvasTexture` is adopted from its resource's getters (diffuse/normal/
  specular channels, filter, repeat), with origin `adopted`, its channel textures adopted first.
  Runtime-created `CanvasTexture`s (spine-godot builds them in code, not from `.tres`) are NOT
  covered: the RenderingServer exposes no canvas-texture channel getter, so they need the node map's
  texture getter, which is the remaining follow-up.
- **MegaDot's `ParticleProcessMaterial` at a late arm (PM7's open item).** Not closed. See
  "Deferred".

## What changed

- **Capture** (`capture/src`).
  - `rs_adopt.cpp` "PM9": `adopt_multimesh_ref` / `adopt_multimesh_locked_out` read a pre-arm
    multimesh through `multimesh_get_instance_count` / `_visible_instances` / `_mesh` /
    `_custom_aabb` / `_buffer`, recover the transform format from the buffer's per-instance stride
    (the RenderingServer exposes no format getter; a `canvas_item_add_multimesh` is a 2D draw, so
    ambiguous strides prefer the 2D interpretation), adopt the mesh through G8r, and register the
    entry (`hooks_adopt_multimesh` -> `Mirror::multimesh_adopt`).
    `adopt_canvas_texture_locked_out` adopts a cached `CanvasTexture` the census found (RID -> path,
    re-fetched through `ResourceLoader.get_cached_ref`), its channels first.
  - `rs_mirror`: `Multimesh.adopted`, `MultimeshAdopt`, `multimesh_adopt`, `wire_multimesh` origin;
    `canvas_texture_adopt`.
  - `hooks.cpp/h`: `hooks_adopt_multimesh`, `hooks_adopt_canvas_texture`; the `add_multimesh` hook
    calls `adopt_multimesh_ref` before its mirror tap.
  - `entry.cpp`: `adopt_stats.resources` gains `multimeshes`, `multimeshes_refused`,
    `textures_canvas`.
- **Fixture.** `fixtures/gate8-mm` gains a late arm (`loader.gd` `RS_FIXTURE_ARM=late`, as
  `gate8-pt`'s), and `mm.gd` logs only the steps that settle after the arm. `run-gate8.sh` g8mm
  gains `late/capture`, `fault-no-resources/capture` (`GRC_ADOPT_FAULT=no-resources`, the pre-PM9
  capture) and their native receivers (`G8MM_ONLY_LATE=1` runs only those plus the reference).
  `lib/gate8-mm-checks.ts` gains `mm-late-adopt` and `mm-late-fault`.

## Checks (g8mm late)

| Check | What it proves | Result |
| ----- | -------------- | ------ |
| `mm-late-adopt` | the late capture adopts all 7 drawn pre-arm multimeshes (origin `adopted`, `ok`, their meshes known), nothing refused, no `unknown-multimesh` | pass (7 adopted, 0 refused) |
| `mm-late-fault` | under `GRC_ADOPT_FAULT=no-resources` nothing is adopted and every drawn cell's `add_multimesh` is `unknown-multimesh` (the pre-PM9 capture) | pass |

The adopted multimeshes recover the correct format from the buffer stride: cell A stride 8 (2D,
no colours), cells B/C/D stride 16 (2D + colours + custom, the `CPUParticles2D` shape STS2 uses),
cells E/F/I stride 12 (2D + colours).

## Deferred (with the reason)

- **MegaDot's process material at a late arm.** `adopt_ppm`'s duplicate trick names no shader on the
  game (`ppm_refused_no_shader`, PM7). Diagnosing it needs a `late12` game capture, and the game
  launch is blocked: the C3 harness's farm needs the couch-coop mod built at `e86f9405` (`v0.107.1`),
  whose built copy no longer exists (`C3_MOD_SRC` is gone), and rebuilding it would require a
  separate couch-coop worktree at that commit (the shared checkout must stay put). Next steps: build
  the `e86f9405` mod (`scripts/build-local-mod.sh` in sts2-couch-coop, from a dedicated worktree),
  `stage-ext.sh` + `farm.sh` this tree, run `late12`, and add the counter that answers why
  `ParticleProcessMaterial::get_rid()` names no shader on the game (the likely cause is that the
  modified engine's `_update_shader` does not call `material_set_shader` from `get_rid()`).
- **Runtime `CanvasTexture`s (spine).** The RenderingServer has no `canvas_texture_get_channel`, so a
  runtime-built canvas texture cannot be read from its RID. The remaining path is the node map: read
  the drawing item's node's `texture` (a `CanvasTexture` resource) and adopt its channels. That
  needs threading the item RID through `adopt_texture_ref` at the geometry hooks.

## Validation

- **Smoke tier, locally** (`validate-increment.sh --tier smoke`): every correctness run passed --
  `capture-build` (46 ctests), the four `cargo-*` runs, `pnpm-test`, `pure`, `lock-tests`, native
  gates -1, 0, 1, 2, 3, 4, 5, 55 and 8 (gate 8 with g8mm's `mm-late-adopt` and `mm-late-fault`
  passing: 7 multimeshes adopted, 0 refused), `hc1`, and the `g7-gsw`/`g7-web-rust`/
  `g7live-*-g7-1` smokes. `bench-instr` exits 3 locally (no valgrind; the remote job is its
  producer). The `native-rust-gate6` timing run was stopped: timing legs are the milestone sweep's.
- **Full tier** remotely ([run 41281283773](https://github.com/tfoxy/godot-scene-web/actions/runs/41281283773)):
  **22 of 22 runs pass**. Every non-timing run of the full plan: setup (`bench-instr` within
  ±0.93 %), native gates -1 to 8 with their sabotage legs, `hc1`, and `g7-gsw`/`g7-web-rust` in
  every group. The remote refused `lock-tests` and the `g7live-*` g7-1 groups (local-only: the
  GSW g7-1 live-resync shot-window miss is still understood; the smoke tier's g7-1 legs passed),
  and refused/skipped every timing run and timing group -- those are the milestone sweep's. Summary:
  `artifacts/render-stream/remote/20261101T063309Z`.
- **STS2 replays:** not re-run. This increment changes only the capture (`capture/src`); the native
  receiver and the web export are unchanged, so the kept recordings (`pm7-a12-1`, `pm-a11-1`,
  `late-1`) replay byte-for-byte as before. The multimesh fix is a capture-side adoption change,
  shown by the `gate8-mm` late legs, not by a `/8`/`/11`/`/12` recording replayed by an unchanged
  receiver.

## Time

Implementation (capture + fixture + checks) about 1 h 50 min; the smoke tier about 1 h 10 min
across two runs (the first caught a wrong `CanvasTexture.get_texture_filter` method hash --
the enum return carries `class_name` `"CanvasItem.TextureFilter"`).
