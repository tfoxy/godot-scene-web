# PM3: GSW draws render-stream/11 multimesh (2026-10-28)

GSW (the browser receiver: `web/gsw-rs`, rs-core's applier and the `canvas_items` WebGL2 executor)
now draws `add_multimesh` as an instanced draw of the multimesh's mesh, from the buffers PM1 put on
the /11 wire. In STS2 every multimesh is a `CPUParticles2D`: the menu fog and tower glow, combat's
fireflies (33 items). The rules are in
[render-stream-11.md](../../protocol/render-stream-11.md) "As built (PM3): decisions" (11 rules).
Nothing on the wire changes.

**STS2 (`pm-a11-1`, PM2's /11 recording with multimesh buffers, replayed; no game launch):**

| Scene | GSW before (dB) | GSW after (dB) | native PM2 (dB) | web PM2 (dB) |
| ----- | --------------- | -------------- | --------------- | ------------ |
| menu 1 / 2 / 3 | 30.99 / 30.73 / 30.93 | **31.30 / 31.17 / 31.04** | 31.27 / 31.14 / 31.01 | 31.29 / 31.17 / 31.04 |
| map 1 / 2 / 3 | 65.52 / 65.50 / 65.51 | 65.52 / 65.50 / 65.51 | 64.18 / 64.13 / 64.16 | 65.61 / 65.58 / 65.60 |
| combat 1 / 2 / 3 | 41.49 / 41.05 / 40.89 | **60.26 / 60.26 / 60.27** | 55.99 / 55.95 / 55.96 | 60.24 / 60.26 / 60.27 |

"Before" is the same bundle under the receiver sabotage `undrawn-multimesh`, which skips every
`add_multimesh` exactly as GSW did before PM3. The map has no multimesh. The kept pre-PM1 recording
`w11b-a11-1` (no buffers on the wire) replays pixel-identical to W11c's GSW replay at all nine steps
(menu 30.57–30.93, map 65.49–65.52, combat 44.30–47.11 dB): no regression.

## What changed

- **rs-core, ingest** (`apply/multimesh.rs`, `PayloadStore::multimeshes`): one buffer per `ok`
  multimesh, ingested at accept from `Validator::multimesh_buffers()` beside W11c's dynamic bodies,
  dropped when the entry leaves the table. Bounded by the state, outside the payload budget.
- **rs-core, lowering** (`apply/lower.rs`): `add_multimesh` lowers each mesh surface mesh-local, one
  `DRAW_INSTANCED` draw per surface, with the drawn-instance count (`visible_instances`). An
  undrawable multimesh is typed `multimesh-unavailable-skipped`. The item's rect is
  `multimesh_get_aabb` (the custom AABB when set), so culling follows Godot's.
- **rs-core, applier** (`apply/mod.rs`): instance ranges are written after the assembly and
  rewritten only when their multimesh's buffer serial moves: a particle buffer changing every frame
  costs its own instances, with no re-lowering and no re-assembly. Colours and custom data go through
  `Math::make_half_float` when the session's `rendering_method` is `gl_compatibility`. A
  `particles_animation` CanvasItemMaterial runs its template as an item-space program (the flipbook
  in `vertex()` over `INSTANCE_CUSTOM.z`).
- **Draw list** (`packages/canvas/rust-draw-list`): `DRAW_INSTANCED`, `Instance` (64 bytes),
  `DrawList::instances`/`instanced`, `Dirty::instances`; an instanced draw never merges.
- **Executor** (`packages/canvas/rust-prototype` `canvas_items`): attributes 4–7 carry the instance;
  every other draw reads the identity instance as constant attributes, so its arithmetic is exact.
  `drawElementsInstanced` with divisor 1. Both vertex stages compose `MODEL_MATRIX = item ×
  instance`; the item-program stage defines `GSW_INSTANCE_CUSTOM`.
- **Transpiler** (`packages/effects` `item-shader.ts`): `INSTANCE_CUSTOM` is the renderer's
  `GSW_INSTANCE_CUSTOM` when defined, else `vec4(0.0)` as before (a source-compatible addition for
  other renderers).
- **GSW** (`web/gsw-rs`): the ingest, `half_instances`, and the receiver sabotages
  `undrawn-multimesh` (PM2's native name) and the GSW-only `no-flipbook`.
- **g7-8** (`lib/gate7-gsw-g8.ts`, new `lib/gate7-gsw-g8-mm-checks.ts`): the g8mm GSW legs and four
  checks against the unarmed reference.

**Backends.** GSW draws items only through the WebGL2 `canvas_items` executor. It has no WebGPU item
backend, so PM3 has no WebGPU half (the design row's "WebGL2 and WebGPU" predates that).

## Checks and sabotages (g7-8, `fixtures/gate8-mm`)

| Check | What it proves | Verdict |
| ----- | -------------- | ------- |
| `mm-gsw-band@gsw` | every shot of `g8mm/receiver` and `g8mm/receiver-patch` is the unarmed reference within channel 1, outside expected.json's known-gap cells | pass: 12 shots, 144–400 px at channel 1 each |
| `mm-gsw-flipbook@gsw` | C_FLIP (four-frame flipbook) within the band on the honest legs; the GSW-only `no-flipbook` sabotage moves C_FLIP beyond it, and every cell below C_FLIP's row stays as the honest leg draws it | pass: caught at 6 of 6 shots |
| `mm-gsw-catches-perturb-instance@gsw` | PM1's capture sabotage on the patch sink fails the band after frame 30 and holds it before | pass: caught at both shots after frame 30 (B_CUSTOM, 128 px each); the 4 before hold |
| `mm-gsw-catches-undrawn-multimesh@gsw` | the pre-PM3 behaviour fails the band | pass: caught at 3 of 3 shots |

The g8mm GSW legs also replace the native ones in g8mm's own checks, `@gsw` through gate 8's band
(lib/gate7-gsw-g8.ts). `scripts/test/probe-receiver-checks.ts gate8` over PM2's passing g8mm run
found the seven that read a receiver leg, now in `GATE8_RECEIVER_CHECKS`: `g8mm-legs`,
`mm-premise`, `mm-reference`, `mm-state`, and `mm-reference-catches-{undrawn-multimesh,
perturb-instance, stale-buffer}`. All seven pass on GSW. `mm-reference` reads the receiver's
applied.json `w11.multimesh`, so GSW now writes it with the native keys where it has them
(`multimeshes_created`, `multimeshes_freed`, `buffer_sets`, `buffer_bytes`, `multimesh_commands`,
`skipped_multimesh_commands`, `undrawn`, and its own `instances_written`). On the honest full sink:
8 multimeshes made, 1 freed, 669 buffers (251,616 B), 9 instanced commands, 1 skipped (H_FREE's
tombstone).

Every GSW shot of the honest legs equals the native receiver's within channel 1 (gate 8's
`gsw-vs-native` note: 144 or 400 px at channel 1, nothing beyond).

**Known gap, not GSW's.** A global-coordinate `CPUParticles2D` calls
`canvas_item_set_use_identity_transform`, which the capture does not hook, so every receiver draws
D_GLOBAL's particles through the node's transform a second time (PM2's `identity-transform` gap in
`fixtures/gate8-mm/expected.json`). The band skips the cells it names (D_GLOBAL, G_HIDDEN).

**Local run.** `gate7-tool.ts gsw-legs --group g7-8` over a copy of PM2's g8mm run, then
`check-gate7.ts --legs g7-8 --receiver gsw`: every g8mm check above passes. B_CUSTOM (a canvas
shader reading `INSTANCE_CUSTOM`), C_FLIP (the flipbook), E_VISIBLE (visible 4 then 6, a custom
AABB), F_REPLACE, H_FREE and I_PREDRAW all match the reference within channel 1.

## Validation

- **Full tier, remotely:**
  [run 40671875366](https://github.com/tfoxy/godot-scene-web/actions/runs/40671875366),
  **18 of 19 runs pass**: `pure`, the four `cargo-*`, `pnpm-test`, `bench-instr`, native gates -1,
  0, 1, 2, 3, 4, 5, 55 and 8 (the diff names a sabotage, so with their sabotage legs), `g7-gsw`
  (g7-0 to g7-8, so every PM3 check and g8mm's own checks `@gsw` on lavapipe), `g7live-gsw` and
  `g7live-web-rust` (g7-2, g7-5, g7-55, g7-8).
  - The failure is `g7-web-rust` g7-8, the **web export's** half: `mm-reference@web` and
    `web-repeat-identical@web` (C_FLIP's ~850 px at step 2 differ between the two web runs of
    `g8mm/receiver`). PM3 cannot reach it: the web export runs `rs-core-capi`, which uses none of the
    rs-core modules PM3 changes (`apply::lower`, `apply::meshes`, `apply::multimesh`, the applier,
    `PayloadStore`), and PM3 changes no capi, template or web-export file. PM2's own remote run
    passed the same group. Rerun locally (`RS_VALIDATE_GROUPS=g7-8 validate-increment.sh --tier full
    --only g7-web-rust`): **pass**, 66 checks, `web-repeat-identical@web` 143 shots identical over
    41 repeated legs. So it is a hosted-runner nondeterminism of the web export's C_FLIP, worth
    watching in the next sweep.
- **Refused by the remote, run locally:** `g7live-gsw` and `g7live-web-rust` g7-1, full tier
  (`RS_VALIDATE_GROUPS=g7-1`): **both pass**.
- **Unit level:** rs-core `cargo test --release` 92 passed (`pm3_tests.rs` new; `w11c_tests.rs`
  now expects golden-11's multimeshes drawn, not undrawn); `rust-draw-list` 8 passed
  (`instanced_draws_never_merge`); `cargo check` of `gsw-rs` for wasm32; effects
  `item-shader.test.ts` 21 passed. `canvas_items`' `stats_are_a_flat_word_block` fails on main
  too (it pins 22 words; the struct has more) and is untouched.
- **Earlier local smoke** (before PM2 landed): `pure` (only the known load-sensitive
  `self-test-report` failed), the crates, `pnpm-test`, native gates -1 to 4 pass; stopped there to
  rebase.
- **Timing** runs (native gate 6, the `g7live-*-timing` runs, `g7x`) are the sweep's. PM3 adds work
  per frame only for multimesh items (an instance rewrite when a buffer serial moves), and every
  non-instanced draw's shader gains four constant attributes and an identity composition.

## Deviations

- **No WebGPU half** (above).
- **`INSTANCE_ID` stays refused.** On GLES3 it is the batch's instance index for every non-multimesh
  draw too, which a program compiled once for both cannot reproduce; no fixture or STS2 shader reads
  it.
- **The custom AABB** affects culling through the item rect, as on Godot; GSW computes a rect without
  one at lowering, which is when Godot caches it too (`rect_dirty`).

## Time

Implementation, from setup at 05:27 to the first green g8mm GSW legs: about 1 h 50 min (the
draw-list, executor and transpiler changes, the rs-core ingest/lowering/applier, the checks), with
the STS2 replays (about 10 min of wall time) run alongside. Validation took the rest, about 3 h
to 10:15, most of it waiting: the local smoke (stopped at PM2's landing), PM2's landing and the
rebase, the remote full tier (about 1 h), two process restarts that killed the local runs in
flight, and the local g7-1 and g7-8 web reruns (the first g7-8 rerun ran on a stale native
extension and had to be repeated).

## Memory-worthy

- A `CPUParticles2D` with `local_coords = false` calls `canvas_item_set_use_identity_transform`,
  which no receiver sees: its particles are drawn through the node transform twice (PM2 types it).
- After rebasing onto an increment that adds capi opcodes, re-run `build-rs-core-ext.sh`: the
  worktree's native receiver extension is built once at setup, and a stale one makes gate 7's
  local source invalid (`source-run-valid` reports the native `mm-reference` failing in every
  cell). A failing source is not published to the source cache, so nothing is poisoned.
- GSW multimesh instances are written outside the lowering, keyed by the buffer serial: re-lowering
  on every buffer change would re-run the lowering of every emitter every frame.
