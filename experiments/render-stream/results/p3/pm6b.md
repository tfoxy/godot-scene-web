# PM6b: GSW simulates /12 GPU particles (2026-10-28)

PM5 (02bcd8aa) put every `GPUParticles2D` emitter on render-stream/12, and PM6a (6bb21e59) made the
native receiver and the web export re-issue them on their own RenderingServer. GSW counted every
`add_particles` as `particles-undrawn`. PM6b gives GSW the approximate tier
(particles-multimesh-design.md "What exact means here"): GSW simulates each emitter itself and
draws it as an instanced draw of its draw pass mesh, on PM3's path. The rules are in
[render-stream-12.md](../../protocol/render-stream-12.md), "As built (PM6b): decisions" (10 rules).
Nothing changes on the wire, in the capture, or in the native and web receivers.

**Headline:** on `fixtures/gate8-pt`, every g8pt check passes on GSW, judged by PM6a's own
checks against the unarmed reference with expected.json's band unchanged (x2). The particles land
where the host's do: 19 of 72 cell-shots are pixel-exact against the reference
(`pt-lockstep`, informational), and the ink ratio to the reference is 0.67 to 1.13 (median 1.00).
D_ONESHOT and I_TRAILS are exact at every shot, and E_FLIP's flipbook frames match.

## What changed

- **`packages/effects`** (published; new exports): `GodotGpuEmitter`, `godotParticleHash`,
  `godotRandFromSeed`, `godotGpuApproximateFeatures`, `GODOT_GPU_INSTANCE_FLOATS` and their types
  (`particles/godot-gpu.ts`). This is a CPU port of what gl_compatibility does with one emitter:
  - GLES3's `update_particles` and `_particles_process`;
  - particles.glsl's restart test;
  - the `start()` and `process()` that `ParticleProcessMaterial` generates, with Godot's own RNG
    (`hash(NUMBER + 1 + RANDOM_SEED)`, then `rand_from_seed` in the generated draw order), and
    turbulence's curl noise in float32;
  - particles_copy.glsl's instance copy.

  It packs 16 floats per instance in the 2D multimesh layout. `simulateParticles` (the
  CPUParticles2D-shaped sim) is unchanged.
- **rs-core.**
  - `apply/particles.rs`: `describe` (the shell's sync message, incremental) and
    `ParticleBuffers` (the simulated instances, by particles id, in `PayloadStore`).
  - `lower.rs`: `add_particles` lowers like `add_multimesh`, as draw pass 0's mesh with `amount`
    instances. It is culled by the custom AABB and typed `particles-unavailable-skipped` when it
    cannot be drawn.
  - `mod.rs`: instanced draws read either source. Items re-lower when an emitter's draw pass mesh
    moves or its first buffer arrives.
  - `residency.rs`: every `ok` emitter's process material names its textures, so the curve
    textures are fetched.
  - `payloads.rs`: f32 payloads up to 4 rows keep their values (`TexturePixels::floats`).
  - `meshes.rs`: an `add_particles` names its draw pass mesh.
- **gsw-rs**: `particles_sync`, `shader_time`, `particles_set`. The emits are counted at accept. The
  sabotages `undrawn-particles` and `ignore-particle-emits` use PM6a's names. applied.json gains
  `w11.particles`.
- **GSW shell** (`web/gsw-receiver/particles.ts`): one `GodotGpuEmitter` per emitter. The wire's
  setters, seed, restarts and process requests are applied in PM6a's order. Each emitter is stepped
  once per apply by the host's shader time delta, and its instances are handed back before
  `apply`. This is wired in both file and live mode.
- **g7-8** (`lib/gate7-gsw-g8.ts`): five g8pt GSW legs replace the native ones, and nine g8pt checks
  join `GATE8_RECEIVER_CHECKS`.

## Checks (g8pt on GSW, fixtures/gate8-pt)

The legs: `g8pt/receiver`, `g8pt/receiver-patch`, `g8pt/sabotage-undrawn-particles/receiver`,
`g8pt/sabotage-ignore-particle-emits/receiver` and `g8pt/sabotage-drop-restart/receiver-patch`.
They replay PM6a's native legs' recordings and shot seqs.

| Check | Tier | GSW |
| ----- | ---- | --- |
| `pt-receiver` | exact count | pass: 0 undrawn; the pre-PM6 executor types 10 = the replayed add_particles |
| `pt-lifecycle` | structural | pass (D_ONESHOT dark before 20 and at 110, lit after each restart and at 95) |
| `pt-coverage` | banded (x2, expected.json) | pass: ratio 0.67 to 1.13, median 1.00 |
| `pt-outside-exact` | exact | pass |
| `pt-replay` | exact counts | pass: 10 emitters, 12 restarts, 4 emits consumed, 0 dropped, 0 skipped |
| `pt-lockstep` | informational | 19 of 72 cell-shots exact on each sink |
| `pt-lifecycle-catches-drop-restart` | sabotage | pass (D_ONESHOT dark at 95, reference 808 px) |
| `pt-lifecycle-catches-undrawn-particles` | sabotage | pass (A_BOX dark from step-0-prev) |
| `pt-replay-catches-ignore-particle-emits` | sabotage | pass (0 emits consumed, 4 on the wire) |

**Deviations from the design row.**

- **Not a `ParticleConfig` mapping.** The row says to map the builtin onto `ParticleSpecConfig`
  and run `simulateParticles`. That simulation is CPUParticles2D-shaped, with its own LCG and
  timing. A Godot-RNG mode inside it would have needed most of a second simulation. The GPU
  semantics differ in the restart phase hash, `NUMBER`-seeded draws, process re-deriving every
  parameter, the transform layout and inactivity. So the Godot-RNG mode is its own module in the
  same package (rule 1).
- **No `zero-amount` sabotage.** As in PM6a, it is a capture sabotage, and PM6b changes no capture.
- **Bands kept as they were.** The bands are expected.json's own. Turbulence was first left out,
  which failed `pt-outside-exact`: G_TURB's particles left their region. It is now ported, so no
  band was relaxed and no GSW-only band was added.

## STS2

No /12 STS2 recording exists. The replay inputs are `/11` (`pm-a11-1` is PM2's /11 capture), where
`add_particles` is `unsupported-op`. So GSW has no emitter to draw, and its pixels must not move.
Replaying `pm-a11-1` through the PM6b bundle (C3 `replay-gsw.sh`, port 8761, bundle
`rs_core_build sha=6bb21e59925e-dirty`, wasm `ed6940bc...`) gives these results:

| Scene | GSW before (PM3, `gsw-pm3-final`) | GSW after (PM6b) | native PM2 | web PM2 |
| ----- | ------------------- | ---------------- | ---------- | ------- |
| menu 1 / 2 / 3 | 31.30 / 31.17 / 31.04 | 31.30 / 31.17 / 31.04 | 31.27 / 31.14 / 31.01 | 31.29 / 31.17 / 31.04 |
| map 1 / 2 / 3 | 65.52 / 65.50 / 65.51 | 65.52 / 65.50 / 65.51 | 64.18 / 64.13 / 64.16 | 65.61 / 65.58 / 65.60 |
| combat 1 / 2 / 3 | 60.26 / 60.26 / 60.27 | 60.26 / 60.26 / 60.27 | 55.99 / 55.95 / 55.96 | 60.24 / 60.26 / 60.27 |

The PM6b shots are pixel-identical to PM3's at all nine steps. That is the no-regression result:
the menu's remaining error is still the particles, which a /11 stream does not carry. The menu
gain needs PM7's `/12` game leg with emitter adoption: today a pre-arm menu emitter is
`unknown-particles` (PM5 rule 9). GSW then draws whatever PM7's capture adopts, through the path
above.

## Scope

- **In scope:** the GSW receiver (rs-core's applier and lowering, gsw-rs, the shell),
  `packages/effects`' Godot GPU particle port, g7-8's g8pt GSW legs and checks.
- **Out of scope:**
  - the native and web receivers (PM6a);
  - the capture, and emitter adoption (PM7);
  - the GDScript cores (removed);
  - WebGPU (GSW has no WebGPU item backend, as PM3 noted);
  - forward_plus-only behaviour (`particles_emit`, sub-emitters, trails), which gl_compatibility
    ignores and so does GSW;
  - attractors, collision, emission-point textures and view-depth sorting, which are typed in
    `approximate_features`;
  - timing, which is the milestone sweep's.

## Validation

**Full tier, once, remotely**
([run 40770129280](https://github.com/tfoxy/godot-scene-web/actions/runs/40770129280), snapshot
b4c7e771) passed 19 of 20 runs:

- the setup runs: `pure`, `cargo-rs-core-capi`, `cargo-gsw-rs`, `pnpm-test` and `bench-instr`;
- native gates -1, 0, 1, 2, 3, 4, 5, 55 and 8, and `hc1`;
- `g7-gsw` (g7-0 to g7-8: the g8pt GSW legs and checks above, on the runners' llvmpipe), and
  `g7-web-rust`;
- `g7live-gsw` and `g7live-web-rust` (g7-2, g7-5, g7-55 and g7-8).

The one failure was `cargo-rs-core`: PM5's `gsw_counts_every_add_particles_undrawn` still
expected the pre-PM6b executor. It now runs under the `undrawn-particles` sabotage (the honest
executor is `pm6b_tests`), and `validate-increment.sh --only cargo-rs-core --tier full` locally
passes.

**The runs the remote refuses, run locally:** `g7live-gsw` and `g7live-web-rust` g7-1
(`RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust`).
Both pass.

**Out of scope:** the timing runs (`native-rust-gate6`, the `g7live-*-timing` runs and `g7x`) are
the milestone sweep's. A local smoke run was stopped after the native gates -1 to 3, which the
remote run covers. Before it was stopped, `bench-instr` returned rc 3 because this machine has no
valgrind (the remote job is the producer), and `cargo-rs-core` failed on the PM5 test above.

`tsc` and `tsc6` pass on `packages/effects`, and `tsc` reports no new error in the receiver.

## What ran

- Local iteration: `run-gate8.sh --legs g8pt` (the native source, 22/22), then
  `gate7-tool.ts gsw-legs --group g7-8 --only g8pt/` over it, judged by `check-gate8.ts` on a copy
  of the source with the GSW legs in place. Iterations:
  - gsw2: the curve textures were not fetched, so F_CURVES drew white full-size particles, and
    `pt-coverage` failed at the tail;
  - gsw3: with the residency fix, G_TURB left its region without turbulence, and
    `pt-outside-exact` failed;
  - gsw4: with turbulence ported, every check passed.
- `cargo test --release` in rs-core (105 pass) includes `pm6b_tests::golden_12_particles_draw_from_the_shells_buffers`.
  `vitest packages/effects` passes 9 files and 183 tests, including
  `particles-godot-gpu.test.ts`: the RNG against an independent integer implementation,
  lifecycle, global coordinates, curves and turbulence.

## Time

The work ran from 17:30 to about 19:25. Implementation took about 45 minutes: the port, the rs-core
draw path, the glue, the legs and the turbulence fix. Validation and replays took the rest, about
1 h 10 min: three local g8pt GSW iterations, the STS2 replay, the remote full tier, which took
about 65 minutes and ran in parallel, and the local g7-1 runs.
