# LATE-PPM: adopt MegaDot's process material at a late arm via the builtin key (2026-11-01)

This increment closes gap 1 of the P3 fidelity leg: a late-arm capture that names no shader for
MegaDot's `ParticleProcessMaterial` (the PM7 duplicate trick) now adopts the process material through
its `particle_process_material` builtin key, so a builtin-driven receiver draws the emitter.

## The diagnosis (the counter)

PM7's `adopt_ppm` makes a capture-owned `Resource.duplicate(false)` of the pre-arm process material
and calls its `get_rid()`, relying on the engine's `ParticleProcessMaterial::_update_shader` to
re-emit `material_set_shader` with the shared shader (stock 4.5.1 does this; the `gate8-pt` late
fixture proves it). On the game the duplicate named **no shader and created none**:
`stream.gate8.particles.adoption.ppm_refused_no_shader == 3`.

Stock `_update_shader` calls `material_set_shader` (or `shader_create_from_code`) on every path
except the early return `mk == current_key` (particle_process_material.cpp:156). So `no_shader`
(and `ppm_refused_created == 0`) shows the engine assigns the shader **outside `get_rid()`** — the
path the duplicate can observe. This is not fixable by any getter: `Material.get_shader_rid()` is a
C++ virtual that returns exactly what we need (particle_process_material.cpp:1871) but is **not
bound** to ClassDB (material.cpp:155 binds only `_get_shader_rid`, the GDVIRTUAL, which returns the
default for a native material), and `RenderingServer` has no `material_get_shader`.

## The fix

When the duplicate names no shader (`ppm_refused_no_shader`), `adopt_ppm` now falls back to
`adopt_ppm_builtin`:

- read the `particle_process_material` key from the material's own getters (`ppm_key`, the same
  getters PM5's born path already uses, so it works on MegaDot);
- adopt a **synthetic `particles` shader** under a capture-reserved RID (top two bits set, which no
  31-bit-validator RID takes) carrying that builtin key (`Mirror::set_shader_ppm`), with a minimal
  `shader_type particles` code that names `TIME` (mode + the `time` use the process shader carries);
- adopt the material against it, reading every parameter by name (`material_get_param`) from the
  names the duplicate's constructor and property copy sent (`t_internal_param_names`), which is the
  engine's own complete uniform list — independent of the shader.

This is engine-agnostic: the builtin key and the parameter names come from public getters and the
engine's own `material_set_param` calls, not from the unrecoverable shader. A builtin-driven receiver
(GSW) then simulates and draws the emitter. The GL-family receivers (native opengl3, native Forward+,
the web export) still draw nothing for these emitters — a Forward+ host's process shader is RD-only
(`emit_subparticle`) and its exact GLSL is unrecoverable without the shader RID — which is PM7
follow-up 1, unchanged by this increment.

`ppm_refused_no_shader` stays as the diagnostic (the duplicate named no shader); a new
`ppm_builtin` counts the materials recovered through the builtin. `ppm_refused` (nothing could adopt
it) is still the refusal.

## Fixture and check

`GRC_ADOPT_FAULT=ppm-no-shader` (a new `AdoptFault`) forces the duplicate-trick shader to 0, so the
stock `gate8-pt` late fixture exercises the fallback that only MegaDot triggers in the wild. A new
`fault-ppm-no-shader/capture` leg (run-gate8.sh g8pt) and check `pt-late-ppm-builtin`
(lib/gate8-pt-late-checks.ts) assert: all 10 process materials recovered through the builtin, all 10
named no shader, nothing refused, no `unknown-particles`, and every adopted entry `ok` on an `ok`
process material whose shader carries the `particle_process_material` builtin. The self-test
(self-test-gate8-pt.ts) covers the helper.

## late12 outcome

`late-ppm-late12-1` (armed on the menu, frame 1430; route `menu,arm,shots:menul,map,combat`,
5,000 disarm frames) — 4,982 transactions, all `ok`; every hash unchanged; `survivors: none`.

`stream.gate8.particles.adoption`:

| counter | value |
| ------- | ----- |
| emitters | 3 |
| meshes | 3 |
| ppm_materials | 3 |
| ppm_shaders | 2 (two of the three share one key, as the engine's shader_map does) |
| ppm_params | 195 |
| ppm_refused | 0 |
| **ppm_refused_no_shader** | **3** (the diagnosis: the duplicate named no shader) |
| **ppm_builtin** | **3** (the fix: every one recovered through the builtin) |
| ppm_refused_created / _code / _material | 0 / 0 / 0 |

Before this increment the same leg reported `ppm_refused_no_shader 3` **and** `ppm_refused 3`
(every process material `unknown-material`, its emitter `unsupported`). Now nothing is refused: the
three menu emitters are adopted `ok` on process materials whose (synthetic) shader carries the
`particle_process_material` builtin. The arm-time G8m walk adopted 56 materials and 6 shaders; the
three process materials are the lazy PM7 adoption, keyed eagerly in the fallback (so the frame-boundary
`builtin_resolved` stays 0, as expected for an adopted-not-born shader).

## STS2 dB

`compare.py` of the GSW replay of `late-ppm-late12-1` against the game's own shots (three per
scene). "Before" is pm7's late12 GSW menu (the emitters `unsupported`/`unknown-material`, so no fog:
31.47/31.43/31.23 dB); "after" is this fix (the three menu emitters adopted through the builtin, so
GSW simulates the fog).

| scene | GSW before (pm7 late12) | **GSW after (this fix)** |
| ----- | ----------------------- | ------------------------ |
| menu  | 31.47/31.43/31.23       | **12.76/12.84/12.72**    |
| map   | 65.47/65.53/65.52       | 65.47/65.55/65.49        |
| combat| 60.85/60.83/60.88       | 17.65/17.67/17.68        |

The menu fog is drawn (the particle scene: 31 → 12.7 dB). It is brighter than the born GSW result
(23.1, PM6b) because the synthetic builtin path reads the fog's uniforms from `material_get_param`
and misses any uniform the shader declares but a setter never sets — the same fog-brightness gap
PM7 follow-up 1 documents, not a new regression; the map is byte-identical (65.5 dB, 0 px off).

Combat falls because a **post-arm** combat emitter is `unsupported-particles` (`unknown-shader`):
its material is one of the 47 STS2 `unknown-shader` materials this leg already carries (canvas
textures, spine), keyed neither at arm nor at its first draw, and the late arm shifts the game's
frame so the energy counters are visible at the shot frames where a born arm's were not. It is
unrelated to the three adopted menu emitters (all `ok`, `ppm_refused` 0).

## Validation

- **Smoke tier, locally** (`validate-increment.sh --tier smoke`): every correctness run passed —
  `lock-tests`, `pure` (all self-tests; `self-test-gate8-pt` 113/113 with the three new
  `pt-late-ppm-builtin` assertions), `capture-build` (46 ctests, `rs_adopt` includes the new
  `ppm-no-shader` fault parse), the four `cargo-*` runs, `pnpm-test`, native gates −1, 0, 1, 2, 3,
  4, 5, 55 and **8** (gate 8 at **324 of 325**, the one `not-run` being
  `sabotage-frozen-sweeps-caught`, a browser leg whose verdict is an rs-core unit test; g8pt's
  `pt-late-ppm-builtin` passes: 10 builtin-recovered, 10 no-shader, 10 materials), `hc1`,
  `g7-gsw`, `g7-web-rust`, and the `g7live-*-g7-1` smokes. `pnpm-test` reported
  `client.test.ts` "core-load-failed" once (rc=1) — a 20 ms race under the concurrent cargo builds,
  unrelated to this change (no `packages/*` touched); the file passes in isolation (3/3).
  `bench-instr` exits 3 locally (no valgrind; the remote job is its producer). I stopped the
  `native-rust-gate6` timing run; timing is the milestone sweep's.
- **Full tier, remotely** ([run 41324601436](https://github.com/tfoxy/godot-scene-web/actions/runs/41324601436),
  key `rv-20261101T160633Z-dc67c5c-2446`): **21 of 22 runs pass**. The one failing run,
  `g7live-web-rust@g7-5`, is the hosted-runner "no shot" flake (`receiver-vs-reference@web` /
  `leg-class-live-mesh@web`: "live-mesh step 3: no shot"), a mesh live leg unrelated to this
  capture-side change; re-run `--only g7live-web-rust` as [run 41332761841](https://github.com/tfoxy/godot-scene-web/actions/runs/41332761841)
  (key `rv-20261101T174125Z-b704051-13787`) **passes 1/1**, confirming the flake. The remote refused
  `lock-tests` and the `g7live-*` g7-1 groups (local-only) and every timing run (the milestone
  sweep's). Summary: `artifacts/render-stream/remote/20261101T173928Z`.
- **The runs the remote refuses, run locally** (full tier): `lock-tests` (in the smoke) and the
  `g7-1` live groups (`RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --only g7live-gsw,g7live-web-rust
  --tier full`): **2 of 2 pass** (335 s).

## Time

<!-- filled -->

## Memory-worthy

- `ParticleProcessMaterial::get_shader_rid()` returns the shader RID but is **not** ClassDB-bound;
  `Material::get_shader_rid()` dispatches to the GDVIRTUAL `_get_shader_rid` (returns the default),
  so a native material's shader is unrecoverable from GDExtension except by re-triggering
  `material_set_shader`. The duplicate trick is that re-trigger, and it fails on MegaDot.
- The duplicate's constructor + property copy sends every uniform name through
  `material_set_param` even when `_update_shader` names no shader, so `t_internal_param_names` is a
  complete, engine-independent parameter list for the fallback.
