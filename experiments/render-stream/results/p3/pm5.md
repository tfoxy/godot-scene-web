# PM5: GPU particles in the capture and on render-stream/12 (2026-10-28)

Under `GRC_STREAM_VERSION=12` the capture now hooks the 33 `particles_*` mutators and carries every
`GPUParticles2D` emitter on a new wire version, **render-stream/12**: a particles table (the
configuration, seed, restart, emit and request counters, process material, draw-pass meshes and
subemitter), the host's floats (amount ratio, lifetime, emission transform, emitter velocity, trail
poses, …) in an optional `pt_f32` block, the `particles_emit` calls as an ordered event list, the
`add_particles` command, and a `particle_process_material` shader builtin that makes the process
material's generated shader `ok`. Process materials themselves are `ok` at /12 for the first
time, and their curve and gradient textures are delivered. This is the capture half of C3's GPU
particle gap (the menu stars and fog, the energy counter). The receivers accept /12 and count every
particle draw as undrawn until PM6.

The wire is [render-stream-12.md](../../protocol/render-stream-12.md), with 13 "As built (PM5)"
decisions. The governing design is
[particles-multimesh-design.md](../../protocol/particles-multimesh-design.md) ("/12: GPU
particles"); it holds, with the refinements below.

## What changed

- **render-stream/12** = /11 plus a magic (`GRSC`), the particles table (`particles`,
  `removed_particles`), `particle_emits`, `add_particles`, the tenth block `pt_f32` and the
  `particle_process_material` builtin. All four new transaction parts are **optional, present only
  when non-empty**, so a /12 stream without particles is transaction-for-transaction /11's. That is
  a refinement of /11's "every transaction carries every block", made so the byte-identity
  requirement below can hold.
- **Calibrator 12.** `calibrate.py` gains the 33 `particles_*` mutators
  (`servers/rendering_server.h:770-842`; the three getters are not hooked). Like PM1's twelve they
  are conditional: installed only at /12, neither planned nor omitted below it, so the calibrator
  version stays 9 and every /2–/11 session record is unchanged.
- **Capture** (`capture/src`): the mirror's emitter model (GLES3's defaults; the version moves only
  on a change, by bit pattern; restart, emit and request-process always), the snapshot's particles
  table and tombstones, the append-only emit log (a 4,096-emit tail; a patch carries the emits of
  host frames (B, T], a full only its own frame's), `make_patch`, the encoder's `pt_f32`, the /11
  lowering for older viewers, the hook log's `particles` call and `state` lines, the builtin read
  with `ParticleProcessMaterial`'s getters through G8m's node map, the /12 float-texture default,
  the `Array` parameter fix, both headless shims, and the sabotages `perturb-seed` and
  `drop-restart`.
- **Codecs and validators.** `render-stream-2.ts` and rs-core decode, validate and resolve /12. New
  codes: `particles-entry`, `particles-version`, `particles-ref`, `particle-emits`, `pt-offset`,
  `builtin-entry`. The resolved form (`render-stream-12-resolved/1`) carries each emitter's floats
  by name.
- **Receivers.** rs-core-capi accepts /12 and counts `particles_commands_undrawn` and a
  `particles-undrawn` row; GSW's executor counts a `particles-undrawn` shortcut; the native receiver
  (`rs_wire.gd`, `rs_live_client.gd`, `receiver.gd`) and GSW (`config.ts`, `live.ts`, `hello.ts`,
  `main.ts`, gsw-rs) offer `render-stream.12` under `RS_RECEIVER_PROTOCOL=12`.
- **Goldens.** `golden-12/`: states 22–26 (two emitters with a builtin process material, a moving
  global emitter, a restart with two emits, trails with two poses, a 3D emitter, a tombstone, a
  removal, a resend) and 27 invalid vectors.
- **Fixture and group.** `fixtures/gate8-pt` and gate 8 group `g8pt` (`lib/gate8-pt-checks.ts`,
  `test/self-test-gate8-pt.ts`).

## Why every process material was `unsupported`/`param-type`

STS2's engine (MegaDot 4.5.1.m.12) passes two `ParticleProcessMaterial` parameters,
`particle_flags` and `use_tex_param`, as a plain `Array`. Stock 4.5.1 never does. The capture's
Variant decoder had no `Array` case, so one refused parameter made each of the 330 menu materials
`unsupported` (a kept STS2 hook log shows all 330 receiving both). At /12 the decoder carries the
packed array Godot itself converts a uniform array to (`int32` for bool/int elements, `float64`,
`vector2/3/4`, `color`); below /12 the bytes are unchanged. The element type is inferred from the
engine's conversion rules, not yet observed on the game: PM7 confirms it ("As built" rule 5).

## Global coordinates and the identity transform

`GPUParticles2D` never calls `canvas_item_set_use_identity_transform`. A global emitter sends its
node's global transform as the emission transform, and the storage maps the simulated particles
back into the emitter's local space with its inverse (`particles_storage.cpp:407-421`), so the item
draws through its ordinary transform. Global GPU particles therefore depend on the emission
transform, which /12 carries, and **not** on the unhooked identity-transform call. The UIT
increment is needed for `CPUParticles2D` only.

## The fixture: `fixtures/gate8-pt`

640x360, `--fixed-fps 60`, 90 frames, steps at 20 and 40, `gl_compatibility`, `use_fixed_seed` on
every emitter, each cell its own `amount`:

| Cell | What it is |
| ---- | ---------- |
| A | box emitter, local; emits twice at each step (the emit list) |
| B | sphere emitter, global coordinates, under a moving parent |
| C | ring emitter; `request_particles_process(0.5)` at step 1, a new seed at step 2 |
| D | one-shot, `emitting = false`, restarted at both steps |
| E | flipbook (`CanvasItemMaterial.particles_animation`) |
| F | `scale_curve` (`CurveTexture`) and `color_ramp` (`GradientTexture1D`) |
| G | turbulence |
| H | sub-emitter (`SUB_EMITTER_AT_END`) naming a tenth emitter, `H_CHILD` |
| I | trails |

Facts the fixture showed: every `GPUParticles2D` constructor calls `particles_restart` once, so
`restarts` starts at 1; and every emitter, local ones included, gets one
`particles_set_emission_transform` at its first transform flush. On `gl_compatibility`,
`_update_shader` writes no sub-emitter code, and the `turb_vel_influence` and
`turb_init_displacement` texture bits never reach the code, so `pt-builtin` checks those parts of
the key against `expected.json`'s hand-derived key instead.

## Checks and sabotages (g8pt)

Legs: `capture` (/12, `GRC_ADOPT=arm`), `capture-v11` (the control),
`sabotage-perturb-seed/capture` and `sabotage-drop-restart/capture` (from frame 30), all rendered
in a private headless gamescope; `receiver` (the native receiver, `RS_RECEIVER_PROTOCOL=12`); then
`headless/capture`, `headless-shim/capture`, and on `fixtures/gate8-mm` `headless-pump/capture` and
its control `headless-nopump/capture`.

| Check | Verdict |
| ----- | ------- |
| `g8pt-legs`, `pt-validate` (every recording through the TypeScript validator and `rs-core-check`) | pass |
| `pt-hook-census` (per cell: creates, setters, restarts, emits, draw passes; the teardown separately) | pass |
| `pt-wire` (every transaction's entries and emits against the hook log's `state` and call lines) | pass |
| `pt-builtin` (7 process shaders: the getter key equals the key derived from the generated code) | pass |
| `pt-v11` (no particles keys, `add_particles` lowered to `unsupported-op`, shaders `shader-mode`) | pass |
| `pt-curve-textures` (cell F: `ok` `RGBF`/`RGBAF` at /12, `unsupported-format` at /11) | pass |
| `pt-shim` (without the shim every emitter is `RID()` and `unknown-particles`; with it distinct ids and `pt-wire` holds) | pass |
| `pt-pump` (gate8-mm headless: `multimesh_set_buffer` 8 calls without the pump, 278 with it, `pump_fired` 90) | pass |
| `pt-receiver` (10 `particles-undrawn` equal the replayed `add_particles`; the receiver does not fail) | pass |
| `pt-sabotage-validate-*` (the validators accept both sabotaged patch sinks) | pass |
| `pt-wire-catches-perturb-seed` (seq 30: seed 1003 against 1002) | pass (expected fail of `pt-wire`) |
| `pt-wire-catches-drop-restart` (seq 40: `restarts` 2 against 3) | pass (expected fail of `pt-wire`) |

As with PM1, the full sink makes `perturb-seed` a validator error (`particles-version`: the seed
changes under an equal version), so the sabotages are judged on the patch sink.

**Measured `pt_f32` bytes** (rendered `capture`, one transaction a frame):

| Sink | Mean per frame | Max per transaction |
| ---- | -------------- | ------------------- |
| full (`recording.rs12`) | 1,484 B | 1,664 B |
| patch (`recording-patch.rs12`) | 151 B | 1,480 B |

The design predicted about 0.5 KB of configuration per emitter (here 124 B of floats plus the
JSON) and 48 B per moving-emitter frame; a moving emitter re-sends its entry, 124 B of floats.

## STS2 calibration record

`calibrate.py --version-name MegaDot` ran offline against a byte-identical farm copy of the game
binary (sha256 `0c21999e…`, read only, never executed) with the pinned 4.5.1 header. The game was
not launched, and nothing in the Steam install was read or written.

- Output: `calibration/sts2-megadot-4.5.1-m12.pt.json` in couch-coop's research folder
  (`.sts2/research/render-stream-p3-20261025/`), with `calibrate.pt.stdout.txt` beside it. The
  `.mm.json` record is untouched.
- 588 slots, anchors 17/17, calibrator 9.
- It is identical to `…m12.mm.json` except for the 33 new keys, and each equals the stock
  template's slot.

## Byte identity

`scripts/cmp-rec.ts --tree` (PM1's comparator) against a clean `create-worktree.sh` checkout of
main (`e7182407`), built the same way. Both trees ran the same legs locally:

| Recordings | Identical | Notes |
| ---------- | --------- | ----- |
| gates 1, 2 and 5 (smoke tier: every leg but the sabotages) | 180 of 182 | The two others are gate 1's and gate 2's `live-replay/recording.rs2`, copies of a live receiver's input whose transaction count follows live pacing (701 against 703, 747 against 699): a timing fact, as at PM1. |
| g8w11, every leg (/11 captures, their /10 twins, sabotages, receiver file sinks) | 48 of 48 | |
| g8mm, every leg | 16 of 16 | |
| `golden/`, `golden-1/` to `golden-11/` | unchanged | no file under them changed; every `make_golden.py --check` passes, and the C++, TypeScript and rs-core golden suites pass them unchanged |

Below /12, then, every file sink is byte-identical apart from the run's own ids, the end record's
timing stats, and nothing else.

**/12 without particles against /11.** g8pt's `headless-nopump/capture` is g8mm's
`headless/capture` (`fixtures/gate8-mm`, headless, no adoption: multimeshes and `CPUParticles2D`,
no GPU emitter) at `GRC_STREAM_VERSION=12`. Compared with **main's** /11 recording of that leg, both
sinks (`recording` and `recording-patch`) are identical record for record (92 of 92 each) under
`cmp-rec.ts --allow-session protocol,features.ops,features.resources,features.observed_unsupported_ops,capture.hooks_planned,resources.permitted_formats`. So
the fields that differ are exactly:

- the file's 8-byte magic (`GRSB` → `GRSC`);
- the session's `protocol` (`render-stream/11` → `render-stream/12`);
- `features.ops` (+ `add_particles`), `features.resources` (+ `particles`),
  `features.observed_unsupported_ops` (− `canvas_item_add_particles`);
- `capture.hooks_planned` (+ the 33 `particles_*` hooks);
- `resources.permitted_formats` (+ `RF`, `RGF`, `RGBF`, `RGBAF`: the /12 curve-texture default);
- the end record's `bytes_total`, by exactly the session record's growth.

Every transaction record is byte-identical.

## Validation

**Full tier, run once remotely** ([run 40692187022](https://github.com/tfoxy/godot-scene-web/actions/runs/40692187022),
on the pre-rebase tree): **20 of 21 runs pass**: setup (`pure`, `capture-build`, the four `cargo-*`,
`pnpm-test`, `bench-instr`), native gates −1, 0, 1, 2, 3, 4, 5, 55 and 8 (g8pt included) with their
sabotage legs (the diff names sabotages), `g7-gsw` (g7-0 to g7-8), and `g7live-gsw` and
`g7live-web-rust` (g7-2, g7-5, g7-55, g7-8).

The one failure is `g7-web-rust` g7-8, the web export's half of g8mm: `mm-reference@web`,
`mm-reference-catches-stale-buffer@web` and `web-repeat-identical@web`, all on C_FLIP's ~850 px,
which differ between two web runs of the same build. That is PM3's documented hosted-runner
nondeterminism of the web export's `CPUParticles2D` flipbook (results/p3/pm3.md); no particles
code is on that path (g8mm has no GPU emitter, and below /12 nothing changed). Rerun locally:
`RS_VALIDATE_GROUPS=g7-8 validate-increment.sh --tier full --only g7-web-rust,g7-gsw` on the
tree rebased onto PM3: **pass** (both), as PM3's own rerun did.

**The runs the remote refused, run locally:** `lock-tests` (252 s), `g7live-gsw` g7-1 and
`g7live-web-rust` g7-1 (full tier, `RS_VALIDATE_GROUPS=g7-1`): **pass**.

**After the remote run** two capture changes landed (rules 3 and 4: GLES3's create-time defaults,
and no trail poses without trails), which only a /12 emitter reaches, so g8pt was re-run whole
locally on the final build: **15 of 15 checks pass**. Capture ctest 41/41 (`rs_mirror_test` 617
checks, with a new trail-pose case). After rebasing onto PM3 (one conflict, `rs-core/src/apply/
lower.rs`'s shortcut enum: both sides kept, PM1's undrawn arm dropped as PM3 had), rs-core
`cargo test --release` 103 pass, and `cargo-rs-core-capi`, `cargo-gsw-rs`, `g7-gsw` and
`g7-web-rust` (g7-8, full tier) pass locally.

**After rebasing onto HC1** (two add/add conflicts in `entry.cpp` and `rs_mirror_test.cpp`, both
sides kept; the particles hook-log lines now follow HC1's `keep_lines` gate, so no line is formatted
when no `resources.jsonl` is open): capture ctest 41/41; remote full tier over the runs the capture reaches
([run 40712391303](https://github.com/tfoxy/godot-scene-web/actions/runs/40712391303):
`capture-build`, `pure`, native gates 1, 5 and 8 and HC1's `native-rust-hc1`): **6 of 6 pass**;
g8pt locally on the final build: **15 of 15**.

Unit level (the four implementing agents, on the final sources):

- ctest 41/41: `rs12_codec` matches golden-12 byte for byte (full, patch, inline), states 1–21
  equal golden-11's, the /11 and /10 lowerings, the emit windows; `rs_live_coding_golden12_*`;
  `rs_particles_shim`; particles cases in the mirror, live, publish, resource-log and policy tests;
- `self-test-rs2.ts` 1465/1465 (golden-2 to golden-12);
- rs-core `cargo test --release` (`pm5_tests.rs`, 11 tests); `rs-core-check goldens`: golden-12
  153/153, cross-version 18/18, golden-2 to golden-11 unchanged;
- rs-core-capi: replay 12/12 (golden-12: 7 `particles-undrawn` on each sink), coding 1/1;
- `receiver_selftest.gd` 85/85 (framing now covers golden-11 and golden-12), and a headless native
  replay of `golden-12/inline.rs12`: ok, 26 transactions, `particles_undrawn` 7;
- `self-test-gate8-pt.ts` 83/83, `self-test-gate8z.ts` 43/43, the smoke-map self-tests;
- `make_golden.py --check` for every golden directory;
- `tsc`: only the known errors.

**Out of scope, and why:**

- The timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`) and the timing groups
  the remote skips are the milestone sweep's.
- No receiver draws GPU particles yet (PM6), so there is no pixel check.
- No game launch (PM7).

## For PM6 and PM7

- **PM6 (receivers).** Replace the undrawn counts with the replay: the native receiver and the web
  export re-issue `particles_create`, the setters (from the entry's JSON and floats), `set_seed`,
  `restart` when `restarts` moved, the emits in order, the process material and
  `canvas_item_add_particles`. The process shader and material must be made resident although no
  item names them (only a particles entry does). GSW maps the builtin plus params plus curve
  samples onto `ParticleSpecConfig`. rs-core's API is "As built" rule 13.
- **PM7 (STS2).** Two things to confirm or build first:
  - the `Array` parameters' element type (rule 5);
  - **emitter adoption**: an `a8` leg arms after the menu exists, and PM5 adopts no emitter, so the
    menu's stars and fog would be `unknown-particles` (rule 9). The `GPUParticles2D` getters give
    the whole configuration; the process material's shader is already adopted by G8m.

## Deviations from the PM5 row and the contract

- An extra leg, `headless-nopump/capture`, is the pump check's control inside g8pt.
- The builtin is resolved only under `GRC_ADOPT=arm` (rule 6).
- A /11 viewer of a /12 host sees the host's float-format policy (rule 7).
- No emitter adoption (rule 9).
- Timing legs are left to the milestone sweep.

## Time

About 2 h 30 min of implementation, from 07:25 to 09:57: the contract (render-stream-12.md, 25
min), then four parallel agents (TypeScript, rs-core with the receivers, the capture, and the
fixture with its checks). Two process restarts killed the first round of agents; their partial work
(golden-12, the calibration, most of rs-core and the TypeScript types) survived in two `wip:`
commits, and a second round finished it in about an hour. Validation then took about 3 h of wall
time, to about 13:00: the remote full tier (about 1 h 40 min including the queue), the byte-identity
runs in two checkouts, the refused and post-rebase local runs, and two rebases (PM3, HC1) with
their re-runs, on a loaded machine (load 12–18).

## Memory-worthy

- STS2's MegaDot passes `ParticleProcessMaterial`'s `particle_flags` and `use_tex_param` as a
  plain `Array`; the capture refused every process material for it.
- Every `GPUParticles2D` constructor calls `particles_restart` once (`restarts` starts at 1).
- On `gl_compatibility`, `ParticleProcessMaterial` generates no sub-emitter code, and two
  turbulence texture bits never reach the code: a code-derived key cannot see them.
- A full sink turns a seed perturbation into a validator error; judge `pt-wire`'s teeth on the patch
  sink, as PM1 did for `mm-wire`.
