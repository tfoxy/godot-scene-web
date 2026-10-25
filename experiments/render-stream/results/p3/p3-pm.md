# P3-PM: what STS2's particles and multimeshes are, and what carrying them costs (2026-10-25)

**A design increment, and nothing is built.**

- **Decision**, in
  [protocol/particles-multimesh-design.md](../../protocol/particles-multimesh-design.md):
  - stream multimesh instance buffers, exactly, at `/11`;
  - ship GPU emitters plus their process material and let receivers simulate, a declared
    approximate tier, at `/12`;
  - reject host readback.
- **Why the multimesh half comes first:**
  - every multimesh STS2 draws is a `CPUParticles2D` (the project has no `MultiMeshInstance2D`);
  - in combat those buffers would cost about 2.9 KB per frame (1.7 % of today's combat traffic);
  - multimeshes are 33 of the 42 particle-like items visible at C3's steps.
- **Why the GPU half cannot use readback:**
  - no RenderingServer call returns a particle buffer, and a headless host simulates nothing;
  - streaming the menu's GPU particles would add 50 % to its traffic;
  - one boss background would need 82.6 MB/s.

No game was launched. Sources:

- the kept `a8-2` and `late-1` recordings and their evidence (`counters.json`);
- spirectl's recovered project;
- the pinned 4.5.1 source.

## Method

- **Recovered project.**
  - `p3-pm-survey.py` parses every `.tscn`/`.tres` (3,478 files) into its particle nodes and
    `ParticleProcessMaterial` resources, resolving sub- and external materials.
  - `p3-pm-agg.py` makes the distributions.
  - `p3-pm-closure.py` sums `amount` over each scene's static `instance=` closure. Instance
    overrides of `amount` are ignored, so closures are approximate.
  - Defaults are the engine's: GPU `amount` 8, `lifetime` 1, `fixed_fps` 30, global coordinates;
    CPU `fixed_fps` 0, global coordinates.
- **Recording.**
  - `p3-pm-measure.mts` decodes `a8-2` with GSW's TS decoder and resolves it to C3's step seqs
    (menu-1 852, map-1 1384, combat-1 1789, combat-3 1885). At each step it lists:
    - items holding the typed `add_particles`/`add_multimesh` commands, their materials and
      visibility;
    - shaders by mode;
    - process materials (materials whose shader is `particles`-mode) and the textures their
      params name.

    Over the session it counts process-material churn and patches naming those items.
  - `counters.json` from both legs gives the raw hook counts.
- **Engine.** Read only; citations are in the design document.

## STS2 usage (recovered project)

| | `GPUParticles2D` | `CPUParticles2D` |
| - | - | - |
| nodes / files | 1,197 / 258 | 1,378 / 157 |
| top directories | vfx 551, backgrounds 328, creature_visuals 132, events 120 | backgrounds 914, events 133, vfx 108, rest_site 97 |
| `amount` p50 / p90 / max (sum) | 20 / 100 / 2,500 (65,772) | 2 / 30 / 2,000 (35,963) |
| `lifetime` p50 / p90 / max | 2.5 / 12 / 600 s | 3 / 15 / 600 s |
| local / global coordinates | 595 / 602 | 1,282 / 96 |
| step | `fixed_fps` 30 (default) 574, 0 390, 60 232, 25 1 | 0: 1,377; 60: 1 |
| one-shot / `emitting = false` | 209 / 224 | 74 / 78 |
| trails / sub-emitter | 14 / 13 | n/a |
| emission shape | in the process material | point 877, sphere 403, rectangle 97, points 1 |
| flipbook (`particles_animation`) | 224 | 405 |
| canvas `ShaderMaterial` / `CanvasItemMaterial` / none | 118 / 613 / 466 | 5 / 1,296 / 77 |

- `GPUParticles3D`: 4 nodes in 2 files.
- `MultiMeshInstance2D`, `MultiMesh` resources and `shader_type particles`: **0**.
- In the decompiled C# (`sts2/`): no `MultiMesh` and no `EmitParticle`.
  - `Restart(` 189 sites in 86 files; `.Emitting =` 331 in 80;
  - `.Amount =` 28 in 16; `.ProcessMaterial` 13 in 8; `.Lifetime =` 12 in 4.
  - Helpers: `NParticlesContainer` (`SetEmitting`/`Restart` over a `GpuParticles2D` array),
    `NVfxParticleSystem` (emit all children on ready, free after a timer), and
    `NParticleSystemUpscaler` (scales a `CPUParticles2D`'s `scale_amount` to its texture).

`ParticleProcessMaterial` (1,265 resources):

| feature | count |
| ------- | ----- |
| emission shape | point 643, box 302, sphere 130, sphere surface 110, ring 75, points (texture) 5 |
| turbulence | 251 |
| sub-emitter mode | constant 24, at end 3 (27) |
| collision | 17 (rigid) |
| attractor interaction | 13, all set `false` |
| `anim_speed`/`anim_offset` set | 68 / 203 |
| `color_ramp` / `color_initial_ramp` / `alpha_curve` / `scale_curve` | 652 / 152 / 741 / 1,074 |
| `particle_flag_align_y` / `rotate_y` / `disable_z` | 218 / 168 / 1,259 |

### Per-scene instance closures (sum of `amount`)

| scene | GPU | CPU | emitters |
| ----- | --- | --- | -------- |
| `screens/main_menu.tscn` (through `backgrounds/main_menu_bg.tscn`) | 280 | 1 | 3 + 1 |
| `backgrounds/overgrowth/overgrowth_background.tscn` + `bg_03_a` + `bg_04_c` (C3's combat) | 0 | 46 | 32 |
| `combat/energy_counters/ironclad_energy_counter.tscn` | 11 | 0 | 6 |
| `creature_visuals/ceremonial_beast.tscn` (Act 1 boss) | 1,500 | 6 | 1 + 2 |
| `creature_visuals/torch_head_amalgam.tscn` (worst CPU creature) | 370 | 2,228 | 8 + 13 |
| `rest_site/hive_rest_site.tscn` | 564 | 157 | 8 + 8 |
| `backgrounds/vantom_boss/layers/vantom_boss_bg_00_a.tscn` | 4,600 | 0 | 7 |
| `backgrounds/waterfall_giant_boss/layers/waterfall_giant_boss_bg_00_a.tscn` | 12,289 | 4 | 180 + 2 |
| `backgrounds/the_insatiable_boss/the_insatiable_boss_background.tscn` (worst) | 21,501 | 0 | 68 |

### What C3's steps contain

- **Menu.** `main_menu_bg.tscn`:
  - GPU `stars`: 200 instances, 5 s lifetime, `fixed_fps` 0, local coordinates, no material;
  - GPU `clouds`/`clouds2`: 40 each, 400 s lifetime with 400 s pre-process, an additive flipbook
    on `fog_sheet_2.png` (the bottom fog);
  - CPU `light_large`: 1 instance, additive `light.png`, drawn at 2x (the one multimesh).
- **Combat** (Overgrowth: `overgrowth_background` with layers `bg_00_a`, `01_b`, `02_b`, `03_a`,
  `04_c`, `fg_c`, from `state.combat.json`):
  - CPU `fireflies`: 12 instances, a 2000x1 rectangle, 10 s lifetime;
  - CPU `fog2`: 4 instances, 120 s lifetime, a flipbook;
  - 30 CPU `little_light`s: 1 instance each, 3 s lifetime, additive.

  That is 32 multimeshes and 46 instances. The 6 GPU emitters are the Ironclad energy counter,
  through `ironclad_energy_vfx_{back,front}.tscn`:
  - `vfx_common_glow`, `vfx_fire_flipbook_{1,2,3}`, `vfx_fire_embers_straight` (6) and
    `vfx_common_ring_polar_a`;
  - 11 instances in all, every one one-shot, `emitting = false`, `fixed_fps` 60.

  Only the embers use turbulence. Every other emitter here is inside `packages/effects`' simulated
  feature set.

## The recording (`a8-2`, and `late-1` as a cross-check)

- **Hook counts over 5,000 frames:** `canvas_item_add_multimesh` 33 and `canvas_item_add_particles`
  9. That is one call per item, at frame 16 for the menu and frame 1685 for combat.
  - `late-1` (armed at the map) shows 32 and 6: the same combat.
  - The `captured` samples name a distinct multimesh RID per item.
- **The items are static on the wire.**
  - At every step their `content_version` is 2 (created, then drawn once).
  - No patch names one of those items again: 0 item entries over 4,960 transactions.
  - The 107,264 and 23,352 "transaction-entries" in C3's census are the same 38 typed commands
    restated in each transaction's `unsupported` list. All motion is in calls the capture does not
    hook.
- **Item state at the steps:**

  | step | particles items | multimesh items | materials |
  | ---- | --------------- | --------------- | --------- |
  | menu-1 | 3, all visible | 1 | stars: none; clouds: `canvas_item_material` add with `particles_animation`; glow: add |
  | combat-1/3 | 6, all visible | 32 | energy: a canvas `ShaderMaterial` (`ok`); 31 lights add, the fog add with `particles_animation` |

  Every item has an identity transform scale, except the menu glow (2x). None uses the parent's
  material.
- **Process materials are already on the wire.**
  - 3 shaders have mode `particles`; all are `unsupported`/`shader-time` (turbulence code
    mentions `TIME`).
  - 348 materials name them, carrying 22,953 resolved parameters (about 66 each). Their status:
    see "Material status" below.
  - Churn: 373 process-material entries were re-sent, in 84 of 4,960 transactions. Runtime edits
    are rare.
  - The process-material parameter types seen were float 16,636, vector3 2,620, int 2,239, bool
    1,605, rid 1,110 and color 373.
- **The float textures are their curves.**
  - The process materials' texture parameters name `RGBF 256x1` 833 times, `RGBAF 256x1` 31,
    `RGBF 128x1` 26, `RGBF 64x1` 10, `RGBF 32x1` 1 and `RGF 2048x1` 1, all `unsupported-format`.
    They also name 147 `ok` `RGBA8` one-row gradients.
  - The final unsupported set is `RGBF 256x1` 758, `RGBAF 256x1` 49, `RGBF 128x1` 26, `RGBF 64x1`
    11, `RGBF 32x1` 1, `RGF 2048x1` 1 and `RGBAH 512x512` 1.
  - So 846 of the 847 are particle curve and gradient textures, 4.8 MB in all. The card glow is
    the one that is not.
- **Other shaders.** `spatial` mode: 2 `shader-mode` and 2 `shader-time`. These are the
  `shader-mode` pair in C3's census; they are not particle shaders.

### Material status

- **Every process material is `unsupported`/`param-type`:** 330 at menu-1 and 348 at combat-1.
  **Every other material is `ok`:** 205 and 213. So C3's 348 `param-type` materials are exactly the
  particle process materials. None of them is a canvas material, and the refusal hides no canvas
  draw.
- Their remaining parameters are still carried (the 22,953 above). Which `ParticleProcessMaterial`
  parameter the capture's variant decoder refuses (`rs_variant.cpp`: any type outside its list) is
  not diagnosed here. PM5 must find it, because `/12` needs these materials `ok`.
- **The 3 `particles`-mode shaders are on the wire as source payloads**, 35,680, 36,486 and 36,519
  bytes (`uses: ["time"]`). The full simulation code is already delivered and only refused.

## Wire cost

Option (b)'s formula, and (c)'s for CPU emitters, uses the 2D instance stride: transform 8, colour 4
and custom 4 floats, 64 B per instance. That is `CPUParticles2D`'s buffer
(`cpu_particles_2d.cpp:79-80`) and the RD particle instance buffer
(`particles_storage.cpp:1369-1376`, `xform_size` 2). Rates assume 60 frames per second and a full
buffer every frame, which is what `CPUParticles2D` sends while emitting. A GPU emitter's instance
count is its `amount`, an upper bound on live particles.

| scene | GPU inst | CPU inst | (b)+(c) B/frame | MB/s | (c) only, B/frame | today's wire per frame (C3) |
| ----- | -------- | -------- | --------------- | ---- | ----------------- | --------------------------- |
| menu (C3 step) | 280 | 1 | 17,984 | 1.08 | 64 | about 36 KB (+50 % for (b)) |
| combat (C3 step) | 11 | 46 | 3,648 | 0.22 | 2,944 | about 175 KB (+2.1 %; (c) +1.7 %) |
| Act 1 boss creature | 1,500 | 6 | 96,384 | 5.78 | 384 | |
| worst CPU creature (torch head amalgam) | 370 | 2,228 | 166,272 | 9.98 | 142,592 (8.6 MB/s) | |
| waterfall giant boss layer | 12,289 | 4 | 786,752 | 47.2 | 256 | |
| the_insatiable boss background | 21,501 | 0 | 1,376,064 | 82.6 | 0 | |

- **Option (a)'s steady-state cost:**
  - near zero, about 0.5 KB per emitter's configuration once;
  - restart, emit and emitting events of tens of bytes (STS2's energy counter fires them per
    energy change);
  - 48 B per frame for a moving global-coordinate emitter's transform.

  The process materials (348) and their curves (4.8 MB of float payloads, one-time) are the same
  under every option, because the GPU path needs them anyway.
- **Quantization.** An f16 transform, unorm8 colour and f16 custom would take 28 B per instance
  (0.44x): the worst CPU creature at 3.7 MB/s. It is approximate, so it is a later negotiated
  encoding, not the exact tier.
- **Rejected for GPU particles:** (b) costs 82.6 MB/s on the worst background and 1.08 MB/s even
  on the menu, against near zero for (a). It also has no public readback to stand on (design doc
  "What the engine does").
- **Not measurable from the kept recordings:**
  - buffer bytes per frame, because `multimesh_set_buffer` is unhooked; the figures above are from
    the scene closures and the engine's buffer layout;
  - the fraction of GPU slots alive at a shot.

  PM4 and PM7's game legs measure both once the hooks exist.

## Engine facts worth keeping

These are cited in the design doc.

- **Headless `CPUParticles2D` sends nothing.**
  - `DisplayServerHeadless::can_any_window_draw()` is false, so `Main::iteration` never calls
    `RenderingServer::draw`.
  - So `frame_pre_draw` never fires and `CPUParticles2D` never calls `multimesh_set_buffer`.
  - The node still simulates. A headless capture needs a pre-draw pump.
- **Headless GPU particles share `RID()`.** The dummy's `particles_allocate()` returns `RID()`, so
  every emitter's calls name the same null RID. This is the canvas-texture problem again.
- **Compatibility colour is half precision.** The GLES3 host stores multimesh colour and custom as
  half floats, and a GSW receiver must round them to match.
- **The GPU particle RNG is portable.** It is an integer hash of `NUMBER + 1 + RANDOM_SEED`, and
  the seed is the observable `particles_set_seed` value. Stepping is not portable:
  `request_process_time` takes one step more than the host's frame loop. So GPU pixels can be
  "emitter-exact" at best.

## Validation

- **Scope.** The commit is documentation only, so `validate-increment.sh --plan` reaches the pure
  self-tests alone (57 targets out of reach).
- **Full tier (`--tier full`, run `pure`):** 80 of 81 passed.
  - `self-test-rs-ws` failed because this worktree had no `capture/build/rs_ws_echo` yet.
  - After `build-capture.sh`, `run-pure-self-tests.sh --only self-test-rs-ws` passed.
- **STS2.** No receiver or capture code changed, so STS2's dB figures are P3-CT's
  ([p3-np.md](p3-np.md)).
- **Lock waits.** The two `a8-2` decodes ran under `quiet.sh shared`. Most of their wall time was
  waiting behind another agent's exclusive game leg.

## Evidence

Small evidence, kept out of git, is in `artifacts/render-stream/p3/p3-pm/` in the main checkout:

- the survey, aggregate and closure scripts and their JSON;
- `p3-pm-measure.mts` and its `a8-2` output (`p3-pm-a82.json`).

The game-derived parts are the recovered project's scene names and counts, and nothing here is
game content.
