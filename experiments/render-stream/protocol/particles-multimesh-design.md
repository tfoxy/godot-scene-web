# Particles and multimesh over render-stream (P3-PM design)

Status: design record, 2026-10-25, written with P3-PM. PM1 (2026-10-28) built the multimesh capture
and wire at /11 (render-stream-11.md "As built (PM1): decisions", which win where they differ from
this sketch; [results/p3/pm1.md](../results/p3/pm1.md)). PM5 (2026-10-28) built the GPU particles
capture and wire at /12 ([render-stream-12.md](render-stream-12.md), "As built (PM5)"; [results/p3/pm5.md](../results/p3/pm5.md)),
including both headless shims; receivers draw no GPU particles until PM6. The measurements
behind every STS2 number are in [results/p3/p3-pm.md](../results/p3/p3-pm.md). Source citations
are `path:line` in the pinned `../godot-4.5.1-stable` checkout. Gates 5, 5.5 and 8 typed
`canvas_item_add_multimesh` and `canvas_item_add_particles` as `unsupported` and listed them under
"does not prove" (gate5-design.md D16 and "Deferred", gate8-design.md Q1 and "Not in scope").
C3 ranked them gap 3 ([results/p3/fidelity.md](../results/p3/fidelity.md)).

## Decision

1. **Multimesh, which in STS2 means every `CPUParticles2D`, streams its instance buffer.** A
   multimesh table, an `add_multimesh` command and an inline float block carry the buffer the host
   last gave `multimesh_set_buffer`, only when it changed. The receiver draws the host's own floats,
   so this is an **exact tier**. Wire: **`/11`**.
2. **GPU particles ship the emitter, not the particles.** The particles table carries the
   `particles_*` configuration, the seed, the restart, emit and emitting events and the emission
   transform. It names the process material, which is already on the wire as a `particles`-mode
   shader plus parameters, with its curve textures. Each receiver simulates:
   - native and the web export replay the calls into their own engine;
   - GSW runs `packages/effects`' particle simulation from a `particle_process_material` builtin.

   This is a **declared approximate tier**: the emitter state is exact and checkable, the particle
   positions are not. Wire: **`/12`**.
3. **Host readback of simulated particles (option b) is rejected.** No public RenderingServer call
   returns a particle buffer, a headless host simulates nothing, and STS2's worst background would
   cost 82.6 MB/s.
4. **Neither belongs in `/10`** (P3-ST's screen texture and CG1's canvas-group mode). See "Fit with
   the version plan".

## What STS2 uses

These are counts from the recovered project (`.tscn`/`.tres`, 978 scenes and 2,500 resources) and
from the kept `a8-2` recording; [p3-pm.md](../results/p3/p3-pm.md) has the tables.

- **Node types.**
  - `GPUParticles2D`: 1,197 nodes in 258 files (vfx 551, backgrounds 328, creature visuals 132,
    events 120).
  - `CPUParticles2D`: 1,378 nodes in 157 files (backgrounds 914).
  - `GPUParticles3D`: 4 nodes, outside the 2D scope.
  - **No `MultiMeshInstance2D`, no `MultiMesh` resource and no C# `MultiMesh` use.** Every
    multimesh STS2 draws is a `CPUParticles2D`'s private one.
- **Process materials.** All 1,197 GPU emitters use `ParticleProcessMaterial` (1,265 resources).
  There are 0 hand-written `shader_type particles` shaders. At runtime that is 3
  `particles`-mode shaders (the material's generated code, shared per feature key) behind 348
  process materials, with 22,953 parameters already on the wire.
- **Features**, per process material (1,265):
  - emission shapes: point 643, box 302, sphere 130, sphere surface 110, ring 75, points 5;
  - turbulence 251 (20 %);
  - sub-emitters 27 (13 nodes);
  - collision 17;
  - attractors: none (13 explicitly disabled);
  - trails: 14 nodes;
  - per-particle flipbooks through `CanvasItemMaterial.particles_animation`: 224 GPU and 405 CPU
    nodes;
  - a canvas `ShaderMaterial` on 123 particle nodes (118 GPU, 5 CPU), which can read
    `INSTANCE_CUSTOM`.
- **Coordinates.** GPU: 595 local, 602 global. CPU: 1,282 local, 96 global.
- **Step rate.** GPU `fixed_fps`: the default 30 on 574 nodes, 0 (every frame) on 390, 60 on 232.
  CPU: 0 on 1,377 nodes.
- **Sizes.**
  - `amount`: GPU p50 20, p90 100, max 2,500; CPU p50 2, p90 30, max 2,000.
  - `lifetime`: GPU p50 2.5 s, p90 12 s; CPU p50 3 s, p90 15 s; up to 600 s on both.
  - Instances per scene closure: menu 281, combat background 46 plus the energy counter's 11,
    Act 1 boss creature 1,506. The worst are the_insatiable boss background (21,501 GPU) and the
    waterfall giant boss layer (12,289 GPU).
- **Runtime control (C#).**
  - `Restart()`: 189 call sites in 86 files. `Emitting =`: 331 sites in 80 files.
  - `Amount =`: 28. Process-material edits: 13 sites in 8 files.
  - No `EmitParticle`, `AmountRatio` or fixed seeds.
- **What C3's frames show.**
  - Menu (`main_menu_bg.tscn`): the stars (GPU, 200) and the bottom fog (`clouds`/`clouds2`, GPU,
    2 x 40, 400 s lifetime, flipbook, additive) are **GPU particles**. The menu's one **multimesh**
    is the glow `light_large` (1 additive `light.png` instance, drawn at 2x). C3 had the fog as the
    multimesh and the glow as particles; it is the other way round.
  - Combat (Overgrowth): the 32 multimeshes are `CPUParticles2D`. They are the fireflies (12), a fog
    (4, flipbook) and 30 single-instance `little_light` glows.
  - The 6 GPU emitters are the Ironclad energy counter: a glow, three fire flipbooks, embers and a
    ring. All are one-shot, start with `emitting = false`, run at `fixed_fps` 60 and are restarted
    by `NParticlesContainer` on energy changes.
- **The float textures are particle curves.** Of the 847 `unsupported-format` textures in `a8-2`,
  846 are one-row `RGBF`/`RGBAF`/`RGF` textures: the `CurveTexture`s and `GradientTexture1D`s
  that the process materials name (902 references). Only the card glow's `RGBAH` 512x512 is not.

## What the engine does (4.5.1)

### `CPUParticles2D` is a multimesh

- The node allocates one multimesh: `MULTIMESH_TRANSFORM_2D` with colours and custom data
  (`scene/2d/cpu_particles_2d.cpp:80`). Each instance is 16 floats, 64 B: a 2x4 transform, then
  colour, then custom (`:1131-1194`). Inactive slots get a zero transform and keep their colour and
  custom.
- It simulates in `NOTIFICATION_INTERNAL_PROCESS` (`:677`, `:743`) with a node-owned seed. The seed
  is `Math::rand()` on a one-shot emit or a restart, unless `use_fixed_seed` is set (`:48-49`,
  `:314-329`, `:662`).
- While emitting or active, it connects `frame_pre_draw` (`:1196-1221`). On every frame it calls
  `multimesh_set_buffer` with the whole buffer (`:1223-1227`).
- It issues `canvas_item_add_multimesh` once per redraw (`:1250-1263`). The canvas item is never
  touched again. `a8-2` agrees: 33 `add_multimesh` calls over 5,000 frames, and no patch ever names
  those items after their first draw.
- `frame_pre_draw` is emitted by `RenderingServer::draw`
  (`servers/rendering/rendering_server_default.cpp:422`), which `Main::iteration` calls before the
  GDExtension frame callback (`main/main.cpp:4825-4839`). So a buffer set for iteration P is in the
  capture's publish of P.
- On the GLES3 (compatibility) host, `multimesh_set_buffer` stores colour and custom data as half
  floats (`drivers/gles3/storage/mesh_storage.cpp:1808`). A receiver that matches a compatibility
  reference must round them the same way (compare G7c's quantized source colour).

### `GPUParticles2D` is configuration plus a GPU pass

- The node makes `particles_create`, `particles_set_mode(2D)`, a quad mesh as draw pass 0
  (`mesh_add_surface_from_arrays`, hooked today) and about 35 `particles_*` setters
  (`scene/2d/gpu_particles_2d.cpp:982-1009`; the default `fixed_fps` is 30).
- Per frame it calls only `particles_set_emission_transform` while global coordinates move
  (`:136-143`) and `particles_set_emitter_velocity` from physics (`:785-799`).
- `restart()` is `particles_set_seed(Math::rand())` plus `particles_restart` (`:493-497`; also on a
  one-shot emit, `:44-45`).
- The process material is an ordinary material RID whose shader is `shader_type particles` code
  that `ParticleProcessMaterial` generated. Its uniforms reach `material_set_param` and its curves
  reach `texture_2d_create` as float images. The capture already sees all of this.
- **Simulation runs only in the rendering backend:**
  - RD: compute, `servers/rendering/renderer_rd/storage_rd/particles_storage.cpp:1417`;
  - GLES3: transform feedback, `drivers/gles3/storage/particles_storage.cpp:1020`.

  It runs only for emitters a canvas draw requested (`renderer_canvas_cull.cpp:1782`), and goes
  inactive 1.2 lifetimes after emission stops (`:1459-1461`).
- **Stepping:**
  - `fixed_fps > 0` takes `1/fixed_fps` steps out of the renderer's frame delta plus a remainder;
  - `fixed_fps = 0` takes one step of the frame delta times `speed_scale`;
  - `request_process_time` and pre-process step with a `while (todo >= 0)` loop (`:1538-1581`).
- **Randomness is integer and portable.** Each particle's draws come from
  `hash(NUMBER + 1 + RANDOM_SEED)` (`scene/resources/particle_process_material.cpp:855-856`, `hash`
  at `servers/rendering/renderer_rd/shaders/particles.glsl:190`), and `RANDOM_SEED` is the
  `particles_set_seed` value (`particles_storage.cpp:844`).
- **No buffer readback.** The 2D instance buffer has the multimesh layout, 64 B per particle
  (`:1376`), but no RenderingServer call returns it. `particles_get_current_aabb` reads it back
  internally (`:635-648`). The RD buffer RIDs are private.

### Headless (dummy) hosts

- `particles_allocate()` returns `RID()` (`servers/rendering/dummy/storage/particles_storage.h:41`).
  Every emitter therefore shares the null RID and nothing simulates. This is the CanvasTexture
  problem again ([canvas-texture-headless.md](canvas-texture-headless.md)).
- The dummy keeps real multimesh RIDs and stores buffers (`dummy/storage/mesh_storage.cpp:74-90`).
- But `DisplayServerHeadless::can_any_window_draw()` is false
  (`servers/display_server_headless.h:149`), so `Main::iteration` never calls
  `RenderingServer::draw` (`main/main.cpp:4815-4832`). `frame_pre_draw` never fires, and **a
  headless `CPUParticles2D` simulates but never calls `multimesh_set_buffer`**. `AnimatedTexture`
  stalls for the same reason.

### What the RenderingServer boundary shows

| State | GPU-rendered host | Headless host |
| ----- | ----------------- | ------------- |
| `add_multimesh`/`add_particles` commands | hooked today (typed `unsupported`) | same |
| Multimesh allocation and buffers | `multimesh_*` virtuals (`servers/rendering_server.h:468-517`), unhooked | allocation yes; buffers only with a pre-draw pump |
| Emitter configuration and events | `particles_*` virtuals (`:770-842`), unhooked | calls arrive, but all on `RID()` |
| Process material | hooked (shader `particles` mode, params) | hooked |
| Curve textures | hooked, refused `unsupported-format` by default | same |
| Draw-pass quad mesh | hooked (mesh table) | hooked |
| Simulated particles | not observable | do not exist |

## Options

| | (a) ship emitter, receiver simulates | (b) host readback, stream instances | (c) stream CPU multimesh buffers | (d) host-side CPU sim of GPU emitters |
|-|-|-|-|-|
| Applies to | GPU particles | GPU particles | `CPUParticles2D`, any multimesh | GPU particles |
| Observable | yes (new hooks) | **no**: no public readback; nothing headless | yes (new hooks; headless needs a pump) | yes |
| Fidelity | native: the same engine code, the same seed, a phase from the receiver's clock. GSW: plausible port | host-exact if it existed | **exact**: the host's own floats | approximate, but identical on every receiver |
| Wire | about 0.5 KB per emitter config, events of tens of bytes, 48 B per moving-emitter frame | 64 B x instances x fps: menu 1.08 MB/s; worst 82.6 MB/s | 64 B x active-emitter instances x fps: combat 0.18 MB/s; worst creature 8.6 MB/s | as (b) |
| Native and web | re-issue `particles_*`, and the engine simulates | multimesh draw | multimesh draw | multimesh draw |
| GSW | map a builtin to `packages/effects` `ParticleSpecConfig` and simulate (missing: turbulence, sub-emitters, trails, collision) | instanced draw | instanced draw | instanced draw |
| Host cost | hooks only | stalls the GPU | one copy per changed buffer | a full CPU sim in the capture (already 25 ms/frame, gap 6) |
| Determinism | the RNG is integer and portable; the step sequence and float rounding are not | n/a | by construction | its own |
| Testable | config exactly; pixels by band and lifecycle | n/a | byte-exact wire, pixel-exact native | config, and buffers against its own model |

(c) and (a) do not compete: (c) is the only route for CPU particles, and (a) the only workable one
for GPU particles. (d) moves GPU simulation into the capture to buy cross-receiver identity. It
costs the host CPU that gap 6 already lacks, plus (b)'s wire, so it stays a possible later tier and
is not the design.

### What "exact" means here

- **Multimesh tier (exact).**
  - Wire: for every multimesh named by a command in a published transaction, the carried buffer
    equals byte for byte the host's state after that iteration's last `multimesh_set_buffer` or
    per-instance setter (sha256 against the hook log).
  - Native pixels equal the unarmed reference under gate 8's reference rule, because the receiver
    gives its own engine the same floats.
  - GSW: within its band, with the compatibility renderer's half-float colour and custom rounding
    reproduced.
  - For `CPUParticles2D` the reference must itself be deterministic: `use_fixed_seed` and a fixed
    step.
- **GPU particle tier (declared approximate: "emitter-exact").**
  - Exact: the resolved particles table equals the hook log at every transaction (configuration,
    seed, restart and emit counters, `emitting`, emission transform). Material, curve texture and
    mesh references resolve.
  - Approximate: particle pixels.
  - Pixel exactness would need the same backend (RD and GLES3 differ), the same GPU and float
    path, and the same per-frame delta sequence from each restart with one transaction per frame.
    Even the stock template cannot drive that through public calls: `request_process_time`'s
    `while (todo >= 0)` takes one step more than the host. So lockstep exactness is at most an
    informational measurement on a fixture, never a gate.
  - Checks are structural instead:
    - lifecycle: particles appear after a restart or emit and are gone after one-shot plus
      lifetime;
    - coverage: lit-pixel count and mean colour inside each emitter's visibility rect, within a
      band;
    - exact equality everywhere outside the emitters' rects.

## Wire sketch

Both versions follow the established pattern: a resource table with its own id counter, status,
reason and version (the mesh table, render-stream-4.md), plus one command.

### `/11`: multimesh

- **Table.** `multimeshes: [{"id","origin","status","reason","version","mesh":<mesh id>|null,
  "format":"2d","colors":bool,"custom":bool,"instances":<int>,"visible":<int>,"aabb_f":<int>|null,
  "buffer_f":<int>|null}]`, and `removed_multimeshes` on patches.
  - Reasons: `multimesh-3d` (`TRANSFORM_3D` in a canvas), `multimesh-indirect`,
    `multimesh-interpolated` (`multimesh_set_buffer_interpolated`), `payload-too-large`.
- **Block.** A new transaction block `mm_f32` holds, per entry whose buffer changed in this
  transaction (every entry on a full transaction), `instances x stride` floats at `buffer_f`, where
  stride = 8 + 4·colors + 4·custom. An unchanged buffer has `buffer_f: null` and costs nothing.
  The buffer is inline, not a hashed payload: spine's per-frame mesh payloads (351,984 store files,
  1,700 GETs/s, gap 7's 9.8 GB receiver) are the failure mode this avoids.
- **Command.** `{"op":"add_multimesh","multimesh":<id>,"tex":<id>|null}` replaces the typed
  `unsupported`. `features.observed_unsupported_ops` loses `canvas_item_add_multimesh`.
- **Change detection** is in the capture.
  - The mirror keeps a shadow buffer per multimesh: `set_buffer` replaces it, and the
    per-instance setters patch it.
  - At publish it compares the shadow buffer with the last published bytes, a memcmp of at most
    64 B x amount.
  - Particle buffers of active emitters change every frame, so this saves only for idle ones.
    Range diffs would not pay.
- **Encoding.** f32, exact. A negotiated quantized encoding (f16 transform, unorm8 colour, f16
  custom: 28 B, 0.44x) is a later approximate option, not `/11`.

### `/12`: GPU particles

- **Table.** `particles: [{"id","origin","status","reason","version","config":{amount,
  amount_ratio, lifetime, one_shot, pre_process, explosiveness, randomness, speed_scale, fixed_fps,
  interpolate, fractional_delta, local, draw_order, collision_base_size, trails, transform_align,
  seed}, "process_material":<material id>|null, "mesh":<mesh id>|null,
  "subemitter":<particles id>|null, "emitting":bool, "restarts":<int>, "emits":<int>,
  "xform_f":<int>, ...}]`.
  - The emission transform (12 floats), emitter velocity (3) and `interp_to_end` (1) go in a
    `pt_f32` block.
  - `particles_emit` calls are carried as an ordered per-transaction list (transform, velocity,
    colour, custom, flags), because they are events, not state.
- **Command.** `{"op":"add_particles","particles":<id>,"tex":<id>|null}`.
- **Process material.**
  - A `particles`-mode shader whose code is `ParticleProcessMaterial`'s becomes `ok`. The
    `shader-time` refusal exists for canvas shaders, not for simulation code.
  - It gets `builtin: {"kind":"particle_process_material", <feature key>}`: emission shape,
    particle flags, turbulence, collision, sub-emitter and attractor modes. The capture reads these
    with the class getters through the node map that gate 8's material adoption (G8m) keeps. They
    are the parts of the material that live in the code, not in a uniform, and GSW needs them
    without parsing GLSL. That is the same move as D7's `canvas_item_material` builtin.
  - Hand-written particle shaders stay `unsupported`/`shader-mode`. STS2 has none.
  - Today every STS2 process material is `unsupported`/`param-type` (348 of 348 in `a8-2`) from
    at least one refused parameter. PM5 finds it and carries it.
- **Curve textures.** One-row float images named by a process material must be deliverable. The
  formats have been legal since `/8` (gate8-design.md Q6). Only the capture's default
  `GRC_RESOURCE_FORMATS` policy changes, to permit `RF`/`RGF`/`RGBF`/`RGBAF` for textures at most 4
  rows high: 4.8 MB for STS2's 846. No wire change.

## Capture policy

- **Publication.** A multimesh or emitter is published when a command in the item tree names it.
  Hidden-but-emitting `CPUParticles2D` still call `set_buffer` every frame (the pre-draw hook does
  not look at visibility). The first version publishes them anyway, which is simple and exact.
  PM2 measures the cost on the fixture, and STS2 confirmation measures it on the game. If it
  matters, the second version publishes only for effectively visible items and re-sends on a
  visibility flip.
- **Caps.** Per-transaction `mm_f32` bytes count against the existing record cap. A multimesh over
  `GRC_RESOURCE_MAX_PAYLOAD_BYTES` is `payload-too-large`.
- **Adoption (`GRC_ADOPT=arm`).**
  - Multimesh: the arm walk reads `MultiMesh` resources and `CPUParticles2D` nodes (class getters
    give format, count and mesh). The first post-arm `set_buffer` supplies the floats.
  - Emitters: the node getters give the whole `GPUParticles2D` configuration. The dummy stores
    none of it.
- **Headless shims (opt-in, like canvas-texture-headless.md).**
  - Pre-draw pump: on a host whose engine did not call `RenderingServer::draw` this iteration, the
    frame callback emits `frame_pre_draw` before it snapshots. The listeners are
    `CPUParticles2D`/`3D`, `AnimatedTexture` and `SoftBody3D`, and STS2's C# has none.
  - Particles RID shim: when `particles_create` returns `RID()`, the capture returns a private
    placeholder RID, keys the mirror on it and swallows its `free`.
  - Neither is a default. The canvas-texture shim's criterion 5 (a clean exit on the target game)
    is the bar each must clear.

## Receivers

- **Native and the web export.** `rs-core-capi`'s planner re-issues:
  - `multimesh_create`/`allocate_data`/`set_mesh`/`set_buffer`/`set_visible_instances` and
    `canvas_item_add_multimesh`;
  - `particles_create`, the setters, `particles_set_seed`, `particles_restart` and `particles_emit`
    in transaction order, the process material and `canvas_item_add_particles`.

  The engine draws, and the web export inherits all of it. Its GLES3 particles run on WebGL2
  transform feedback, which PM6 confirms on the pinned template.
- **GSW.**
  - Multimesh: an instanced draw of the multimesh's mesh with a 2x4 transform, colour and custom
    per instance. Custom feeds `INSTANCE_CUSTOM`, which the `particles_animation` builtin and
    canvas shaders read. Colour and custom are half-rounded when `engine.rendering_method` is
    `gl_compatibility`. The session already carries it (render-stream-0.md).
  - Particles: map the builtin plus params plus curve-texture samples onto
    `packages/effects/src/particles` `ParticleSpecConfig`, run `simulateParticles`, and pack the
    result into the same instanced draw.
  - The current simulation is "visually plausible": one LCG, ring as an annulus, no turbulence,
    sub-emitters, trails or collision (`simulate.ts:1-12`). PM6 adds a Godot-RNG mode
    (`hash(NUMBER+1+RANDOM_SEED)`, `rand_from_seed`) and types the missing features per emitter
    (`approximate-feature`). STS2's visible menu and energy emitters need none of them except the
    embers' turbulence.

## Increments

Each one lands as a single commit with its result doc. Fixture names follow gate 8's group pattern
(`g8c`, CG2's `gate8-cg`).

| Id | Scope | Fixture | Checks | Sabotages |
| -- | ----- | ------- | ------ | --------- |
| **PM1** | Capture: calibrator 11 (`multimesh_*` slots), the mirror's shadow buffers, `/11` in the C++ encoder, the TS library and `rs-core` (decode, validate, resolve), `golden-11`; STS2 calibration record regenerated | goldens, plus `fixtures/gate8-mm` hook-log-only legs | `mm-hook-census`, `mm-wire` (buffer sha equals the hook log at every transaction), `mm-frame-pairing` (custom data carries the frame number) | `perturb-instance` (flip one float), `stale-buffer` (skip a publish) |
| **PM2** | Native receiver and web export re-issue; group `g8mm` | `fixtures/gate8-mm` cells: a `MultiMeshInstance2D` with transforms only; one with colour and custom read by a canvas shader; a fixed-seed `CPUParticles2D` with a flipbook `CanvasItemMaterial`; a global-coordinate emitter under a moving parent; `visible_instances` below the count; a buffer replaced at a step; a hidden emitting emitter; a freed multimesh | `mm-premise`, `mm-reference-moving` (the reference has teeth), `mm-reference` (both sinks equal the unarmed reference exactly), `mm-hidden-cost` (measured), and the `g7-8` web half | the PM1 pair; the pre-PM2 receiver fails `mm-reference` |
| **PM3** | GSW instanced draw (WebGL2 and WebGPU), `INSTANCE_CUSTOM`, half rounding | `gate8-mm` through `g7-8` | `mm-gsw-band`, `mm-gsw-flipbook` | `perturb-instance` must fail the band |
| **PM4** | STS2 confirmation for multimesh: one `a8` leg at `/11` (the kept recordings hold no buffers); a re-replay; menu, map and combat dB before and after; measured bytes against this document's prediction | none | combat's 32 and the menu's 1 multimeshes drawn; wire within 2x of the 2,944 B/frame combat prediction | none |
| **PM5** | Capture and wire `/12`: calibrator 12 (about 35 `particles_*` slots), particles table, `pt_f32`, emit list, `particle_process_material` builtin, float curve-texture policy, `golden-12`; the opt-in headless RID shim and pre-draw pump | `fixtures/gate8-pt`: box, sphere and ring emitters; local and global coordinates; a one-shot restarted at a step; a flipbook; curve and gradient textures; a turbulence emitter; a sub-emitter; a trail; `use_fixed_seed` everywhere | `pt-hook-census`, `pt-wire` (table equals the hook log), `pt-builtin` (the getter key matches the generated code's key) | `perturb-seed`, `drop-restart` |
| **PM6** | Native and web replay of emitters (group `g8pt`), then GSW: builtin to `ParticleSpecConfig`, Godot-RNG mode, curve sampling, `approximate-feature` reasons | `gate8-pt` | `pt-lifecycle`, `pt-coverage` (band), `pt-outside-exact`, `pt-lockstep` (informational: native pixels against the reference when paced 1:1) | `drop-restart` fails `pt-lifecycle`; `zero-amount` fails `pt-coverage` |
| **PM7** | STS2 confirmation for particles: one `a8` leg at `/12`; menu stars and fog, the energy counter | none | dB before and after; the menu's GPU emitters drawn | none |

Rough cost:

- PM1, PM2 and PM5 are about one increment each at this repo's validation depth.
- PM3 and PM6's GSW half are the largest.
- PM4 and PM7 are small, plus one game launch each.

The multimesh half (PM1-PM4) is independent of the particles half and should go first. It covers
33 of STS2's 42 particle-like items at C3's steps, and it is exact.

## Fit with the version plan

*W11-D (2026-10-25): `/11` is specified in [render-stream-11.md](render-stream-11.md) as `/10` plus
the carried-set prune rule, dynamic mesh surfaces and this multimesh tier. PM1 lands inside `/11`,
and `buffer_f` follows the dynamic meshes' "changed since the connection's base" rule. The list
below predates that.*

- `/10` is fixed: `/9` plus P3-ST's screen-texture and back-buffer state plus CG1's
  `canvas_group` item key ([results/p3/p3-np.md](../results/p3/p3-np.md)). Both are item state over
  one shared GSW back buffer.
- Particles and multimesh add new resource tables, a new block type, a calibrator each, and
  receiver work of a different kind (instancing and simulation). Folding them into `/10` would hold
  P3-ST and CG1 behind the largest item.
- So **`/11` = `/10` plus the multimesh table, `mm_f32` and `add_multimesh`**, and **`/12` = `/11`
  plus the particles table, `pt_f32`, the emit list, `add_particles` and the process-material
  builtin**.
- If PM5 is scheduled right behind PM1, `/11` may carry both tables, with receivers typing
  particles `unsupported` until PM6. That saves one codec cycle but puts the less certain table on
  the wire first. This document recommends two versions; the orchestrator decides.
- The texture-format policy change (curve textures) needs no version, and could ship ahead of PM5
  as configuration: C3 gap 4's `GRC_RESOURCE_FORMATS`.

## Not proven by this design

- 3D-format multimeshes in a canvas, `use_indirect`, and multimesh physics interpolation (typed).
- Particle collision against the 2D SDF (`LightOccluder2D`), attractors, and hand-written
  `shader_type particles` (typed). STS2 has 17 collision materials and none of the other two.
- `GPUParticles3D`, `CPUParticles3D` (out of the 2D scope).
- Pixel-exact GPU particles on any receiver.
- Whether STS2's product seat runs headless. If it does, both shims are on the critical path.
