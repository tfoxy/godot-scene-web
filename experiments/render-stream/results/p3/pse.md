# PSE: particle shader follow-ups (2026-10-29)

PM7 (74e58b5d) found that the native receiver and the web export draw none of STS2's GPU emitters:
MegaDot renders with Vulkan Forward+, and its process shader calls `emit_subparticle`, which GLES3
does not declare. PFB (b95e91d7) fixed the colour space and noted a GSW approximation: MegaDot's
process materials share one uber `particles` shader whose `MaterialKey` fields are uniforms, and
GSW keyed every material by the shader's builtin (the first material's). PSE fixes both. The rules
are in [render-stream-12.md](../../protocol/render-stream-12.md), "As built (PSE): decisions" (6
rules). Nothing changes on the wire or in the capture.

**Headline.**

- **Native and web: a RendererRD host's process shader compiles on gl_compatibility.**
  `emit_subparticle` is the only RendererRD-only particles builtin in 4.5.1 (every other one is
  renamed by both backends). On a gl_compatibility receiver the planner rewrites a `particles`
  shader's calls to a stub with the same signature that returns `false`, which is what
  gl_compatibility does with sub-emitters anyway (PM6a rule 10).
- **GSW: each material its own key.** When a process shader declares `MaterialKey`'s fields as
  uniforms, `describe` keys each material by its own uniform values. GSW fetches such a shader's
  code (only when a process material sets a switch uniform stock `ParticleProcessMaterial` never
  sets), so a stream of stock materials fetches and describes exactly what it did before.
- **Proven on the stock template** (`fixtures/gate8-ptc`'s new S_BOX and S_SPHERE cells): one
  uniform-switched process shader on two `ParticleProcessMaterial`s (box, sphere) captured on a
  Forward+ host. The stock gl_compatibility engine fails to compile it (`C1503: undefined variable
  "emit_subparticle"`) and draws neither cell; the fixed native receiver and GSW draw both cells
  exactly as the Forward+ host (0 px more than 16 levels off); the pre-PSE native receiver draws
  neither and the pre-PSE GSW draws the sphere as a 1-unit box.
- **STS2 `pm7-a12-1` menu: native 31.4 → 40.8–41.7 dB, web 31.4 → 40.7–41.4 dB**, the Forward+
  probe's 40.9–41.7. GSW stays at 40.2–41.0 (the key fix moves the fog's spawn shape from a 1-unit
  box to a radius-5 sphere, which changes no pixel by more than 16 levels). Map and combat are
  unchanged on all three receivers.

## Diagnosis

- **Which particles builtins are RendererRD-only.** `servers/rendering/shader_types.cpp` declares
  the particles built-ins and the `emit_subparticle` stage function for every backend (lines
  370-440), so the host's shader language accepts the call on any backend. The backends' particle
  compilers rename the built-ins: RD's `particles_storage.cpp:75-109` and GLES3's
  `material_storage.cpp` (particles section) rename the same set (`COLLIDED`, `COLLISION_*`,
  `ATTRACTOR_FORCE`, `FLAG_EMIT_*`, `RESTART_*`, `EMISSION_TRANSFORM`, `AMOUNT_RATIO`,
  `INTERPOLATE_TO_END`, `USERDATA1..6`, ...). Only `emit_subparticle` is a GLSL function that RD's
  `particles.glsl:197` defines and GLES3's `particles.glsl` does not.
  `ParticleProcessMaterial` writes sub-emitter code only when `!is_low_end()`
  (particle_process_material.cpp:293, 942, 1149), so it is a RendererRD host's code that breaks.
- **The PM7 probe's stub was right; the brightness it showed was PFB's colours.** With PFB's
  linearized colours the same stub now lands the native menu at the Forward+ probe's dB.
- **STS2's switch uniforms.** At the menu's first shot (seq 1050) the three drawn emitters' process
  materials (99, 101, 102) share shader 7, whose builtin is the first material's (box,
  `color_ramp`, `alpha_curve`, attractor). The fog materials 101 and 102 set `emission_shape` 1
  (sphere) with `emission_sphere_radius` 5 and `emission_box_extents` (1, 1, 1), declare no colour
  ramp or alpha curve, and use a damping texture (`use_tex_param[6]`). Their per-material key
  differs from the shared one in the shape (and the curve flags, which GSW's port takes from the
  curve textures present, not from the key).

## What changed

- **rs-core** `apply/programs.rs`: `without_subparticles` (PM7's probe, kept) and two unit tests.
  `apply/particles.rs`: `SWITCH_UNIFORMS`, `declared_switches` (top-level uniform declarations
  with their literal defaults, comments skipped), `material_key`, `switch_candidate`,
  `switch_candidate_shader_hashes`; `describe` keys a candidate material by its own uniforms and
  takes a `shared_key` flag (the sabotage); `Described` keeps each code hash's declarations and
  re-describes a material when its shader's version or its declarations' availability moves.
  `apply/mod.rs` `Applier::needed` fetches a candidate's shader code with the transaction. Unit
  tests `pse_tests` (4).
- **rs-core-capi** `plan.rs`: the stub on a gl_compatibility receiver before `shader_set_code`,
  `particles_resources.shaders_subparticles_stubbed` (only when non-zero), receiver sabotage
  `no-subparticle-stub` (also listed in `receiver.gd` and `rs_rust_applier.gd`).
- **gsw-rs**: `particles_sync` passes the GSW-only sabotage `shared-process-key`.
- **Fixture** `fixtures/gate8-ptc`: `ptc_switched.gdshader` (stock 4.5.1's generated code for the
  fixture's key with `emission_shape` and `sub_emitter_mode` made uniforms and an at-end
  `emit_subparticle` call) and the S_BOX/S_SPHERE cells in `ptc.gd` (the switched shader is set on
  the materials' RIDs at frame 2, after `ParticleProcessMaterial`'s first flush, then the emitters
  are added; the `Shader` is held in a member, since a local frees its RID under the materials).
- **Runner** `run-gate8.sh`: the receiver leg `ptc/sabotage-no-subparticle-stub/receiver`.
- **Checks** `lib/gate8-ptc-checks.ts`: `pts-host-switched`, `ptc-receiver` extended to the
  switched cells, `ptc-receiver-catches-no-subparticle-stub`. GSW (`lib/gate7-gsw-g8.ts`,
  `lib/gate7-gsw-g8-checks.ts`): the GSW-only leg `g8pt/ptc/sabotage-gsw-shared-process-key` and
  `ptc-gsw-switched-key@gsw`; the native stub catch is not applicable to GSW (it never compiles the
  host's process code).

## Checks (g8pt ptc, local)

| Check | What it proves | Result |
| ----- | -------------- | ------ |
| `pts-host-switched` | the stock engine: Forward+ draws S_BOX as a box and S_SPHERE as a disc; gl_compatibility draws neither (its log has the C1503 error) | pass: S_BOX bbox [128,267,270,313], S_SPHERE [393,253,476,323]; GL none |
| `ptc-receiver` (extended) | the native GL receiver draws both switched cells exactly as Forward+ (0 px > 16 levels off), and the PFB cells within 2 levels | pass |
| `ptc-receiver-catches-no-subparticle-stub` | the pre-PSE receiver fails it | pass: S_BOX 699 px differ (drawn 0) |
| `ptc-receiver-catches-gl-particle-colors` | PFB's catch still holds | pass |
| `ptc-receiver@gsw` | GSW's honest leg | 0 px off in both switched cells, PFB cells as before |
| `ptc-gsw-switched-key@gsw` | GSW keys each material by its own uniforms; `shared-process-key` draws S_SPHERE wrong and S_BOX right | honest 0/0 px; sabotage S_SPHERE 638 px (36 drawn vs 660), S_BOX 0 |

## STS2 (`pm7-a12-1`, replays only, no game launch)

`compare.py` against the game's own shots; three shots per scene; `--fixed-fps 60` for native and
web as PM7. "Before" is this tree under the receiver sabotage that restores the pre-PSE behaviour
(`no-subparticle-stub` for native and web, `shared-process-key` for GSW). GSW bundle `build.json`
sha `1bf75043…` on ports 8821/8822 (checked in `env.txt`); web bundle
`web-receiver/4dab7331c38e32e9`, ports 8823/8824. Outputs in C3's `legs/pm7-a12-1/replay/pse-*`.

| scene | native before | **native after** | web before | **web after** | GSW before | **GSW after** | Forward+ probe (PM7) |
| ----- | ------------- | ---------------- | ---------- | ------------- | ---------- | ------------- | -------------------- |
| menu | 31.44/31.40/31.20 | **40.84/41.30/41.65** | 31.42/31.40/31.22 | **40.67/41.11/41.42** | 40.25/40.70/40.97 | **40.23/40.73/41.04** | 40.88/41.35/41.74 |
| map | 64.10/64.18/64.16 | **64.10/64.18/64.16** | 65.56/65.62/65.60 | **65.56/65.62/65.60** | 65.47/65.53/65.52 | **65.47/65.53/65.52** | 72.67/72.66/72.64 |
| combat | 56.21/56.21/56.22 | **56.21/56.21/56.22** | 60.85/60.82/60.90 | **60.85/60.82/60.90** | 60.85/60.83/60.88 | **60.85/60.83/60.88** | 84.08/83.74/82.92 |

Menu pixels more than 16 levels off the game: native 160,403/164,522/170,984 → 7,962/6,279/5,509;
web 161,180/164,476/170,944 → 9,160/7,274/6,233; GSW 15,768/13,338/12,679 → 16,236/13,556/12,570
(Forward+ probe 8,073/6,286/5,278). The GSW "before" equals PFB's run (`pfb-gsw-1`) exactly. Both
GL receivers' applied.json report `shaders_subparticles_stubbed` 1.

**Why GSW does not move.** GSW after and GSW before differ at no pixel by more than 16 levels:
the fog's per-material key changes only its spawn shape (a sphere of radius 5 instead of a box of
extents 1) on 252x700 clouds. GSW's remaining menu gap to the now-correct native receiver is
5,311 px (menu-1), concentrated in two fog patches (around (720-960, 810-945) and
(1680-1920, 810-945)): GSW simulates from its port of stock 4.5.1's generated code, and MegaDot's
uber shader is not that code (its random draws and branches are its own), so the clouds' frames or
positions differ there. Closing it would need the host's own process code, which GSW does not run
(PM6b rule 1).

## Validation

- **Unit tests**: rs-core `pse_tests` (4) and `programs` `without_subparticles_*` (2); `cargo test`
  of rs-core, rs-core-capi and gsw-rs pass.
- **Smoke tier, locally** (`validate-increment.sh --only` every correctness run of the plan):
  **18 of 18 pass**: pure, the three cargo runs, native gates -1, 0, 1, 2, 3, 4, 5, 55 and 8 (gate 8
  **246 of 246**, the six ptc/pts checks included), hc1, g7-gsw and g7-web-rust (g7-0 smoke) and the
  g7-1 live smokes. `bench-instr` (no valgrind locally) and `native-rust-gate6` (timing) were left
  to the remote job and the milestone sweep.
- **g7-8 at full tier, locally** (`RS_VALIDATE_GROUPS=g7-8 --only g7-gsw,g7-web-rust --tier full`):
  g7-web-rust passes (`ptc-receiver@web`, `ptc-receiver-catches-gl-particle-colors@web` and
  `ptc-receiver-catches-no-subparticle-stub@web` included). g7-gsw: `ptc-receiver@gsw`, its colour
  catch and `ptc-gsw-switched-key@gsw` pass (the stub catch is typed not applicable); the run's one
  gating failure is `source-run-valid@gsw`, because the branch was rebased onto main (HYG and
  WB-D: docs and `wire-budget.py` only) while it ran, which moved the source key's files digest.
  The remote run below passed g7-gsw whole on the same code.
- **Full tier, once, remotely**:
  [run 40826140543](https://github.com/tfoxy/godot-scene-web/actions/runs/40826140543), **18 of 19
  runs pass** (bench-instr within 0.47% of its baseline; native gate 8 with the ptc/pts checks on
  the runners' lavapipe Forward+; g7-gsw with `ptc-gsw-switched-key@gsw`). The one failure is
  `g7-web-rust`'s g7-8 shard: `mm-reference@web` and `web-repeat-identical@web` only, the known
  hosted-runner g7-8 web flake (they passed locally above); its ptc rows passed there too.
- **The runs the remote refuses**, locally: `RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --only
  g7live-gsw,g7live-web-rust --tier full`: **2 of 2 pass**.

## Out of scope

- GSW running the host's own process code (the rest of its STS2 menu gap).
- Curve flags from a switched key: GSW's port samples the curve textures a material sets
  (PM6b rule 3), which a stock or uniform-switched `ParticleProcessMaterial` sets together with
  its switch, so the key's curve flags are listed but not used.
- The timing groups (the milestone sweep's).

## Time

About 50 minutes of implementation (01:59 to 02:50, with the diagnosis, the fixture, the checks
and the STS2 replays), and about 1 h 45 min of validation wall time: the local smoke (64 min), the
remote full tier beside it (about 75 min), the local g7-8 and g7-1 live runs (37 min) and a g7-gsw
re-run (a source-cache entry broke when its publishing run was pruned).

## Memory-worthy

- **`emit_subparticle` is the only RendererRD-only particles builtin in 4.5.1**; GLES3 fails with
  C1503 on any RD-generated process shader with a sub-emitter branch. The planner stubs it on a
  gl_compatibility receiver (`shaders_subparticles_stubbed` in applied.json).
- **A GDScript-loaded `Shader` set by RID must be held**: `RenderingServer.material_set_shader(rid,
  load(...).get_rid())` with the Shader in a local frees the shader when the function returns, and
  the material then draws nothing, with no error printed.
- **A `ParticleProcessMaterial` sets its generated shader at the first idle flush** (the end of
  frame 1 for one made in `_ready`), so a shader set on its RID before then is overwritten.
- **GSW fetches only shaders items name**: a process shader's code is never in GSW's store unless
  something asks for it (PSE asks for switch candidates only).
- **Stock `ParticleProcessMaterial` sets a `turbulence_enabled` parameter** on every material, a
  uniform its generated code never declares.
- **Pruning a validate run breaks the source-cache entry it published**: the entry holds absolute
  symlinks back into the run (`g8kp/gsw-run/gsw-bundle`, `*/sources/gate8`), so a later gate 7 run
  that hits the cache fails `ENOENT` in `gate7-tool.ts` walk. Prune the run only after its gate 7
  consumers, or drop the cache entry (`chmod -R u+w` first; it is read-only) with it.
