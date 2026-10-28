# PM6a: the native receiver and the web export replay /12 GPU particles (2026-10-28)

PM5 (02bcd8aa) put every `GPUParticles2D` emitter on render-stream/12: the particles table, the
`pt_f32` floats, the ordered `particle_emits`, `add_particles` and the `particle_process_material`
builtin. PM6a makes the native receiver re-issue them on its own RenderingServer, and the web
export does the same through the same capi and C++ shim. Each receiver's own GPU simulates the
emitters. This is the native and web half of PM6 (group `g8pt`); GSW is PM6b.

Nothing changes on the wire, in rs-core or in the capture. The rules are in
[render-stream-12.md](../../protocol/render-stream-12.md), "As built (PM6a): decisions" (11 rules).

**Headline:** with both sides at `--fixed-fps 60` and one transaction a frame, the native
receiver's pixels equal the unarmed reference **exactly** at every shot, in every cell, on both
sinks (72 of 72 cell-shots each). The design expected particle pixels to be approximate at best
(particles-multimesh-design.md "What exact means here"). On a GL host with a GL receiver (same
backend, same GPU, same float path, the same per-frame delta from each restart) they are exact. The
web export is exact in 58 of 72 cell-shots and inside the band everywhere.

## What changed

- **rs-core-capi.**
  - `core.rs` copies each accepted transaction's `Validator::particle_emits()` at accept into
    `Core.particle_emits`. A window-2 fold keeps them all, and the apply consumes them.
  - Residency (`plan.rs` `pt_now`). An emitter is resident while an item's `add_particles` names
    it and it is `ok`, and so are its `ok` subemitters. Its process material joins the named
    materials, with the material's `particles` shader, curve textures and host time. Its draw-pass
    meshes join the multimeshes' meshes.
  - `free_particles`, before shaders and materials, and `apply_particles`, after them. The setters
    are sent once after the create and then only on change. Then come the seed, the process
    material, the draw passes and the subemitter, then one restart when `restarts` moved, then
    `request_process_time` when `process_requests` moved, then the emits in order.
  - `add_particles` in item replay, with typed skips: `unknown-particles`, `particles-freed`,
    `unsupported-particles`, `particles-not-resident` and the texture reasons. An item naming an
    emitter made or freed in the apply replays.
  - `dispose()` frees the emitters first.
  - 16 opcodes (76-91, after UIT's 75); `OP_COUNT` is 92. Emitter handles live in the mesh table
    (`RidRef::Particles`).
  - The stats key `particles_resources` appears only when non-zero.
  - Receiver sabotages: `undrawn-particles` (the pre-PM6 planner), `ignore-particle-emits` and
    `drop-particles-restart`.
- **The shim** (`receiver/ext/rs_core_ext.cpp`, `rs_core_capi.h`): 32 RenderingServer binds
  (4.5.1 hashes), the generic setters' bind tables, and the trail bind poses as an `Array` of
  `Transform3D`.
  - **`particles_set_seed` is not bound in 4.5.1.** The shim finds its vtable slot at run time.
    It ptrcalls two bound `(RID, float)` setters on a stand-in object whose vtable is 640
    index-recording trampolines. They must land exactly 14 slots apart, and the seed slot is the
    one after `particles_set_collision_base_size`'s. It then calls the virtual directly (rule 5).
    The probe holds on the release template natively and in the wasm side module.
- **receiver.gd** sums `particles_resources` into applied.json `w11.particles`, and accepts the
  three sabotage names.
- **Fixture** (`fixtures/gate8-pt`). `pt.gd` shoots under `RS_FIXTURE_SHOT_DIR`: `step-<k>.png`,
  `step-<k>-prev.png`, and `tail-95.png` and `tail-110.png`. At 95, D_ONESHOT's second burst
  (restart at 40) is alive while a burst from the restart at 20 would be gone. At 110 it is gone.
  expected.json gains `pixels`: the nine emitter regions (the reference's ink bounds plus 16 px),
  the background pixel, the tail frames, the dark shots and the coverage band.
- **g8pt** (`run-gate8.sh`, new `lib/gate8-pt-receiver-checks.ts`, `lib/gate8-pt-checks.ts`).
  - Every rendered leg now runs to frame 120.
  - New legs: `reference` and `reference-repeat` (unarmed); `receiver` and `receiver-patch` (both
    /12 sinks); `sabotage-undrawn-particles/receiver` and
    `sabotage-ignore-particle-emits/receiver`; and `sabotage-drop-restart/receiver-patch` (PM5's
    sabotaged patch sink).
  - Every receiver runs `--fixed-fps 60`. `run_rendered` consumes `RENDERED_EXTRA_ARGS`, so each
    launch sets it.
- **g7-8's web half.** g8pt is in `run-gate7.sh` `G8_FILE_LEGS` and `gate7b-adapters.ts`
  `GATE8_FILE_GROUPS`. `gate7-web-legs.ts` knows `recording.rs12`, and `resolvedStates` resolves
  /12.
  - P-W1's classes (`pw1-classes@web`) mask g8pt's emitter regions (`approximateRegions`,
    `maskApproximate`). They count those pixels as `approximate`, because particle pixels are
    declared approximate between two receivers. Outside the regions P-W1 still holds, and
    `pt-outside-exact@web` judges the rest exactly against the reference.
- **smoke-map**: g8pt reaches native gate 8 and `g7:g7-8@web/rust` (PM5's exclusivity dropped).

## Checks (g8pt), and which are exact

| Check | Tier | Native (run3, final tree) | Web (g7-8, web4) |
| ----- | ---- | ------------- | ---------- |
| PM5's 13 capture checks | exact (wire = hook log) | pass | pass (re-judged on the view) |
| `pt-receiver` (honest: 0 undrawn; pre-PM6: 10 undrawn = replayed `add_particles`) | exact count | pass | pass |
| `pt-premise` (the reference: every emitting cell inked, D dark before 20 and at 110, nothing outside the regions; reference-repeat identical) | exact | pass (8 of 8 shots identical across runs) | — |
| `pt-lifecycle` (each receiver lights exactly the cells the reference lights, every shot) | structural | pass | pass |
| `pt-coverage` (ink within x2 of the reference) | banded | pass (ratio 1.00 everywhere) | pass (0.94 to 1.09) |
| `pt-outside-exact` (outside every region, equal to the reference) | exact | pass | pass |
| `pt-replay` (10 emitters made, 12 restarts = the wire's, 4 emits replayed, 0 dropped, seeds set, nothing skipped) | exact counts | pass | pass |
| `pt-lockstep` (informational: exact pixels per cell and shot) | measured | **72/72 exact** on each sink | 58/72 on each sink |

`pt-lockstep` stays informational, as the design requires. A different GPU or backend (RD against
GLES3, or a hosted runner's llvmpipe against the host's) need not be exact; the result above is one
host and one GL driver.

### Sabotages

| Sabotage | Caught by | Native | Web |
| -------- | --------- | ------ | --- |
| `drop-restart` (PM5's capture sabotage, the patch sink replayed) | `pt-lifecycle`: D_ONESHOT dark at 95 (reference 808 px) | pass | pass |
| receiver `ignore-particle-emits` | `pt-replay`: 0 `particles_emit`, 4 wire emits | pass | pass |
| receiver `undrawn-particles` (the pre-PM6 planner) | `pt-lifecycle`: every emitting cell dark | pass | pass |
| receiver `drop-particles-restart` | rs-core-capi `replay.rs` (`restarts` 0 on golden-12) | unit | unit |

Pixels cannot catch the emit sabotage on this fixture. `gl_compatibility` ignores `particles_emit`
and `particles_set_subemitter` and draws no trails (rule 10), on the host and the receivers alike.
So A_BOX's emits, H_SUB's subemitter and I_TRAILS are judged on the replay counts.
I_TRAILS is dark at every shot on every leg; expected.json types it so.

`zero-amount` (the PM6 row's `pt-coverage` sabotage) was not built: it is a capture sabotage, and
PM6a changes no capture code. The pre-PM6 planner fails `pt-coverage` as well as `pt-lifecycle`.

## Validation

**Full tier, once, remotely** on the final tree (rebased onto UIT,
[run 40730489574](https://github.com/tfoxy/godot-scene-web/actions/runs/40730489574)):
**16 of 18 runs pass**. Those are setup (`pure`, both `cargo-*`, `bench-instr`), native gates −1,
0, 1, 2, 3, 4, 5, 55 and 8 (g8pt and g8mm whole, sabotage legs included, on the runners'
llvmpipe), `hc1`, `g7-gsw` (g7-0 to g7-8) and `g7live-gsw`. The two failures are hosted-runner load
flakes on legs no particles code reaches:

- `g7live-web-rust` g7-5: the gate 5 live mesh leg shot no steps 4 and 5 (`leg-class-live-mesh`,
  `receiver-vs-reference`), PM2's known hosted flake. Rerun locally
  (`RS_VALIDATE_GROUPS=g7-5 validate-increment.sh --only g7live-web-rust --tier full`):
  **pass**.
- `g7-web-rust` g7-8 has two parts:
  - the brief's known C_FLIP flake (`mm-reference@web` and `web-repeat-identical@web` on g8mm's
    C_FLIP, which differs between two web runs);
  - g8w11's `scale/off` web legs, which stopped after their seq-50 shot (a timeout on the heaviest
    web leg, so every check reading them failed for want of applied.json).

  Every g8pt check passed there @web. Rerun locally
  (`RS_VALIDATE_GROUPS=g7-8 validate-increment.sh --only g7-web-rust --tier full`, a gate 8
  source made locally with every file group): **pass**, g8w11's `scale/off` and g8mm's C_FLIP
  included.

An earlier full-tier dispatch on the pre-rebase tree (run 40727207439) was cancelled once UIT
landed. Its finished jobs had passed, apart from `pure` shard 2: PM6a's own self-test, fixed
since.

**The runs the remote refuses, run locally** (pre-rebase tree, before UIT's merge):
`g7live-gsw` and `g7live-web-rust` g7-1, full tier: **pass** (2 of 2).

**Local, on the final tree (real GPU):**

- `run-gate8.sh --legs g8pt,g8mm`: **41 of 41** (g8pt 22, g8mm 19, UIT's identity-transform legs
  included). The native receiver is exact at 72 of 72 cell-shots on each sink.
- g7-8's web half over that source (`run-gate7.sh --legs g7-8 --receiver web --web-core rust`):
  - every g8pt check passes @web; `pw1-classes@web` passes, with 8,708 approximate pixels inside
    g8pt's regions and none `other` outside them;
  - the web export is exact at 58 of 72 cell-shots, and its ink is within 0.94 to 1.09 of the
    reference's;
  - the one failure there, `compositor-equals-readback@web` "no leg was applicable", comes from
    the scoping: neither g8pt nor g8mm has a `--resolution` leg. The full g7-8 run judges it on the
    other groups.
- rs-core-capi `cargo test --release`: 14 replay tests. `golden_12_draws_particles` covers both
  sinks and inline (2 emitters made, 1 freed, 2 emits, the 3D emitter `unsupported-particles`, the
  sabotages, delta = full scan). `golden_12_counts_particles_undrawn` holds PM5's count under
  `undrawn-particles`. `OP_COUNT` is 92.
- `build-rs-core-ext.sh` and `build-rs-core-web.sh` were rebuilt after every capi edit.
- `self-test-gate8-pt.ts` 100/100 (section 7: the receiver helpers); `self-test-gate7b.ts`
  (approximate regions); `tsc`: no new error.

**After rebasing onto HC2 and the g8ku pin fix** (HC2 changes the capture's snapshots, so the
capture was rebuilt): `run-gate8.sh --legs g8pt`: **22 of 22**, with the native receiver still exact.

**Iteration runs** (pre-rebase): run1 found that `run_rendered` drops `RENDERED_EXTRA_ARGS` after
one launch. `receiver-patch` ran without `--fixed-fps` and was exact at only 13 of 72 cell-shots,
with D_ONESHOT still lit at 110. run2 (fixed): 22 of 22. web1 found `recording.rs12` missing from
`gate7-web-legs.ts` and P-W1 counting particle pixels as `other`. web2 showed the banded view
substituting native shots; web3 confirmed the fix (58 of 72 exact on the web's own pixels).

**Out of scope:** the timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`) are
the milestone sweep's. GSW is PM6b's: its g7-8 does not replay g8pt's legs (`gate7-gsw-g8.ts`
lists none), and g7-gsw passed.

## STS2

Not done, for two reasons. No kept STS2 recording is /12: `fidelity-data` holds /8 and /11
captures, and PM5 made no game capture. Even an `a8` capture at /12 would carry the menu's
emitters as `unknown-particles`, because they exist before the arm (PM5 rule 9). A replay-only
confirmation therefore has nothing to draw. The game was not launched.

**What PM7's adoption needs** (for its brief):

1. At the arm, for each `GPUParticles2D` in G8m's node map, synthesize an `origin: "adopted"`
   entry from the node's getters: amount, lifetime, one_shot, preprocess, speed_scale,
   explosiveness, randomness, fixed_fps, interpolate, fract_delta, local_coords, draw_order,
   trails, seed, `emitting`, the global transform (the emission transform when not local),
   `process_material` (already adopted by G8m with its builtin) and the subemitter's node.
2. The particles RID is private: take it from the item's next `canvas_item_add_particles`. The
   draw-pass quad mesh is private too, but `NOTIFICATION_DRAW` rebuilds it (`mesh_clear`,
   `mesh_add_surface_from_arrays`, `particles_set_trail_bind_poses`) and re-adds the particles. So
   a `queue_redraw()` per emitter at the arm puts the mesh, the poses and the command on the wire
   through the existing hooks.
3. The simulation's phase cannot be adopted: a joiner's emitter starts fresh (rule 4 already
   restarts it once). So PM7's menu dB should be judged with a band, as here.
4. Confirm PM5 rule 5's `Array` element type on the game first, or every process material stays
   `param-type`.

## Time

About 1 h 40 min of implementation, from 12:34 to 13:15 for the capi, the shim, the fixture and
the checks, then the web adapters (20 min) and the rebase onto UIT (15 min). Validation took the
rest, about 2 h 45 min of wall time to about 16:15: three local g8pt runs, four local web g7-8
runs, the local g7-1 and g7-5 reruns, two remote dispatches (the first cancelled for the rebase),
and the local g7-8 rerun. The machine ran at load 30 to 35, behind other agents' timing legs.

## Memory-worthy

- **4.5.1 binds no `particles_set_seed`.** A GDExtension cannot set a GPU emitter's seed through
  ClassDB. The shim's vtable-slot probe works: ptcall bound methods on a stand-in object whose
  vtable is index-recording trampolines. The slot differs between the editor and the templates.
- **GL host and GL receiver at `--fixed-fps 60` are lockstep-exact for GPU particles.** Without
  `--fixed-fps` a receiver that draws faster than real time runs its particles slow (the first run:
  D_ONESHOT still lit one lifetime after its restart).
- **`run_rendered` consumes `RENDERED_EXTRA_ARGS`.** Set it before every launch, not once before a
  loop of legs.
- **`gl_compatibility` ignores `particles_emit`, sub-emitters and trails.** A pixel check can't see
  them there; judge their replay by counts.
- **Never edit a runner script while it runs.** Bash reads it by offset, and the first PM6a run
  ended in a syntax error after a header edit.
