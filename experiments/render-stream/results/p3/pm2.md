# PM2: the native receiver and the web export draw /11 multimesh (2026-10-28)

PM1 (0d5b1152) put STS2's `CPUParticles2D` multimeshes on the /11 wire: the `multimeshes` table,
`add_multimesh` and the `mm_f32` floats. PM2 makes the native receiver re-issue them on its own
RenderingServer, and the web export does the same. Both use rs-core-capi's planner and the C++
shim, so the web export runs the same code built for wasm. This closes C3's gap 3 for the two
Godot receivers. GSW is PM3's.

Nothing changes on the wire, in rs-core or in the capture. The rules are in
[render-stream-11.md](../../protocol/render-stream-11.md), "As built (PM2): decisions" (8 rules).
PM4's STS2 confirmation is folded in here (one game launch, below).

## What changed

- **rs-core-capi.**
  - `mm.rs` (`MmStore`) copies each accepted transaction's `Validator::multimesh_buffers()` inside
    `rsc_accept`, as W11d does with dynamic bodies. Each copy gets a serial, and the store forgets
    whatever is no longer `ok`.
  - The planner makes a multimesh resident while an item names it and its entry is `ok`. The
    mesh it draws stays resident with it. The planner re-issues `multimesh_create`,
    `_allocate_data`, `_set_mesh`, `_set_custom_aabb`, `_set_buffer` and
    `_set_visible_instances`, each only when it changed (GLES3's model). It replays
    `canvas_item_add_multimesh`, and frees a multimesh when its entry leaves the table, turns
    `freed`/`unsupported`, or stops being named.
  - Seven new opcodes (68-74). Multimesh handles live in the mesh table, because the RID kind
    space is full.
  - The apply stats gain `multimesh_resources`, present only when non-zero.
  - Receiver sabotage `undrawn-multimesh` restores PM1's planner (the "pre-PM2 receiver").
- **The shim** (`receiver/ext/rs_core_ext.cpp`, `rs_core_capi.h`): seven RenderingServer binds
  (4.5.1 hashes) and their ops. A buffer reaches `multimesh_set_buffer` as a
  `PackedFloat32Array`, filled straight from the wire bytes.
- **receiver.gd** sums `multimesh_resources` into applied.json `w11.multimesh`, and accepts the new
  sabotage name.
- **Fixture.** `fixtures/gate8-mm` keeps PM1's nine cells (every cell the PM2 row names). It now
  also shoots the frame before each settle frame (`step-<k>-prev.png`). expected.json gains
  `pixels`: the 3x3 cell grid, each cell's drawn steps, the moving cells, and one known gap.
- **g8mm** (`run-gate8.sh`, `lib/gate8-mm-checks.ts`). In the same private gamescope, after PM1's
  captures, it adds these legs:
  - `reference` and `reference-repeat`: unarmed, at `--fixed-fps 60`;
  - `receiver` and `receiver-patch`: the /11 sinks, with state dumps and the previous-frame
    shots;
  - `receiver-v10`: the /10 control;
  - `sabotage-undrawn-multimesh/receiver`;
  - `sabotage-{perturb-instance,stale-buffer}/receiver-patch`: PM1's sabotaged patch sinks.
- **g7-8's web half.** g8mm is in `run-gate7.sh` `G8_FILE_LEGS` and `gate7b-adapters.ts`
  `GATE8_FILE_GROUPS`, so every g8mm check that reads a receiver leg is judged on the web export
  too (`@web`). The g8mm smoke-map rule is no longer exclusive, and `GROUP_COVERAGE_8` gives the
  reason it has no /8 manifest row.

## Checks (g8mm)

| Check | What | Verdict |
| ----- | ---- | ------- |
| `mm-premise` | The reference draws every cell at its drawn steps and nothing else: G_HIDDEN, H_FREE after its free, and the space outside every cell are background. The /10 replay differs from it in exactly the drawn cells. | pass |
| `mm-reference-repeat` | Two unarmed runs are identical at all six shots. Fixed-seed particles at `--fixed-fps 60` are deterministic, and the armed capture's own shots equal the reference too. | pass |
| `mm-reference-moving` | The reference has teeth. B_CUSTOM (steps 0-2), C_FLIP (steps 1-2; it is still at frame 4) and D_GLOBAL (steps 0-2) differ from the frame before. | pass |
| `mm-reference` | The native receiver on the full and the patch sink equals the reference exactly at every settle frame and the frame before it (6 shots per sink), in every cell but the known gap's. It made 8 multimeshes, freed 1 (H_FREE) and drew 8, with 1 skipped (H_FREE's `freed` tombstone). Full sink: 669 buffers, 251,616 B. Patch sink: 366 buffers, 179,712 B. | pass |
| `mm-state` | Each receiver's state dump at the settle seqs equals the recording's resolved /11 state, `multimeshes` included. | pass |
| `mm-reference-catches-undrawn-multimesh` | The pre-PM2 planner differs from the reference in exactly the drawn cells at every checkpoint. | pass (the sabotage fails `mm-reference`) |
| `mm-reference-catches-perturb-instance` | On PM1's sabotaged patch sink the receiver equals the reference before frame 30 and differs after it. | pass |
| `mm-reference-catches-stale-buffer` | The same. The previous-frame shots are what catch it: the stale multimesh is B_CUSTOM, whose shader shows frame parity, and frames 29 and 47 have the same parity. | pass |
| `mm-identity-transform-gap` | Informational, measured (below). D_GLOBAL 9/45/72 px and G_HIDDEN 0/15/24 px at steps 0/1/2, on both sinks. | measured |
| `mm-hidden-cost` | Informational, measured. G_HIDDEN, the hidden but emitting emitter, makes 5 hook calls (create, allocate, mesh) and **0** `set_buffer`: 4.5.1's `CPUParticles2D` stops its pre-draw updates while hidden. It is in 0 of 90 patch transactions, so 0 B of `mm_f32`. All cells together cost 2,094.7 B/frame. The receiver made 8 multimeshes for 8 drawn cells. The design's "publish only visible emitters" second version would gain nothing here. | measured |

PM1's 11 checks still pass, so g8mm passes **18 of 18** (local run
`artifacts/render-stream/p3/pm2/g8mm/result.json`).

### Sabotages

- **PM1's pair** now also fail at the pixel level (`mm-reference-catches-perturb-instance` and
  `mm-reference-catches-stale-buffer`), as well as PM1's `mm-wire-catches-*`.
- **The pre-PM2 receiver** (`undrawn-multimesh`) fails `mm-reference` in every drawn cell.

### The known gap: `canvas_item_set_use_identity_transform` (a capture finding)

- The fixture's D_GLOBAL cell (a global-coordinate emitter under a moving parent) found a gap PM1
  did not model. The PM2 row lists that cell, and this is the gap it catches.
- A `CPUParticles2D` with `local_coords = false` (Godot 4's default) calls
  `set_canvas_item_use_identity_transform(true)`. Its buffer holds global transforms
  (`inv_emission_transform` is never assigned in 4.5.1, so it stays the identity), and its item
  draws with the canvas transform alone.
- The capture does not hook that call, so the native receiver draws D's particles through the
  node's transform a second time: down and right, into G_HIDDEN's cell or off screen.
- `mm-reference` ignores those two cells on the receivers, and `mm-identity-transform-gap`
  measures them. Every other cell, including the hidden cell's "never drawn" premise on the
  reference, is judged exactly.
- STS2 is not affected (combat replays at 0 px over 16, below).
- The fix is a conditional /11 capture slot, an optional item key and the receivers' call. That is
  a wire change, and GSW must honour it too, so it is left as a follow-up increment.
- I changed nothing in the capture.

## STS2 (PM4, folded in): one a11 launch

- **The leg.** `pm-a11-1` ran with mode a11, route `menu,map,combat`, 5,000 disarm frames,
  inline 4096, the hook log on, and `C3_CAL=…/sts2-megadot-4.5.1-m12.mm.json`. The exact command is
  `artifacts/render-stream/p3/pm2/leg-cmd.sh`.
- **The rules followed.**
  - The load gate and the game-lease wait ran outside every lock.
  - The couch-coop lease (`shared:install`, `exclusive:game:p3-sts2`, `exclusive:port:13951`) was
    taken before GSW's quiet lock (shared).
  - The farm and XDG were private, and the compositor was gamescope headless.
  - The game was closed by pid: `survivors: none`, with game exit 134 at TERM as in earlier legs.
    Afterwards no `SlayTheSpire2` process existed.
  - The hashes are unchanged: steam remote, operator profile, install binaries, install mods and
    the mod build.
- **The recording.** `artifacts/render-stream/p3/fidelity-data/pm-a11-1/capture/` in the main
  checkout holds `recording-patch.rs11` (277 MB, 4,947 transactions, all `ok`) and its store. It
  is kept for PM3's GSW replay.
- **Multimeshes on the wire** (TypeScript trace of the recording):
  - menu: 1 multimesh (1 instance);
  - map: none;
  - combat: **32** multimeshes (46 instances) at every combat step.
  - The native receiver made 33 multimeshes in all and freed 1. It drew 33 `add_multimesh`
    commands and skipped none, with 88,378 buffer sets (8.09 MB). The web export's counters are
    identical.
- **Bytes.** Combat's `mm_f32` is **3,712 B/frame**. The design predicted 2,944, so that is 1.26x,
  within the 2x criterion. The menu is 88 B/frame and the map 0. The whole leg averages 2,042
  B/frame.

dB is `compare.py` against the game's own reference shots, as PSNR per step, three steps per
scene. "Before" is the same recording replayed with `RS_RECEIVER_SABOTAGE=undrawn-multimesh`
(PM1's receiver), so before and after differ only in multimesh.

| scene | native before | **native after** | web before | **web after** | current table (native; web) |
| ----- | ------------- | ---------------- | ---------- | ------------- | --------------------------- |
| menu | 30.95 / 30.69 / 30.89 | **31.27 / 31.14 / 31.01** | 30.99 / 30.72 / 30.92 | **31.29 / 31.17 / 31.04** | 30.5-30.9 |
| map | 64.18 / 64.13 / 64.16 | **64.18 / 64.13 / 64.16** | 65.61 / 65.58 / 65.60 | **65.61 / 65.58 / 65.60** | 64.1 |
| combat | 41.28 / 40.87 / 40.72 | **55.99 / 55.95 / 55.96** | 41.49 / 41.05 / 40.89 | **60.24 / 60.26 / 60.27** | 44.0-46.7; web 44.3-47.1 |

- **Combat.** It rises by about 15 dB natively and 19 dB on the web. Pixels more than 16 levels
  off go from 7,604 / 10,477 / 8,566 to **0** at every step, on both receivers. This recording's
  "before" sits about 3-5 dB below the table's `w11b-a11-1`: it is a different launch whose
  fireflies cover more of the screen.
- **Menu.** It gains 0.1-0.45 dB from its one multimesh. Pixels more than 16 levels off fall from
  about 178k to about 166k. The rest is the known menu gap, which is not multimesh.
- **Map.** No multimesh, so it is unchanged.
- **Web against native.** The web export is about 4.3 dB above native in combat and 1.4 dB on the
  map. That is the export's known map edge (WX, W11e) and the same kind of difference in combat.
  Both receivers are at 0 px over 16.

## Validation

- **Local, iterating:** `run-gate8.sh --legs g8mm`, 18 of 18 (two runs: the first found the gap,
  the I_PREDRAW/H_FREE border and the stale-buffer parity, all fixed).
- **Unit:**
  - rs-core-capi `cargo test --release`: 12 tests. `replay.rs` now holds that golden-11's
    states 17-21 are drawn (multimeshes made, buffers set, multimesh 2 freed), and `OP_COUNT` 75;
  - `self-test-gate8-mm` 129/129 (section 8: the pixel helpers);
  - `tsc`: no new error;
  - `build-rs-core-ext.sh` and `build-rs-core-web.sh` were rebuilt after the capi edits.
- **Full tier, remotely:**
  [run 40660762313](https://github.com/tfoxy/godot-scene-web/actions/runs/40660762313),
  **16 of 17 runs pass.**
  - Setup (`pure`, `cargo-rs-core`, `cargo-rs-core-capi`, `bench-instr`) and native gates -1, 0,
    1, 2, 3, 4, 5, 55 and 8 (g8mm with its references, receivers and sabotage legs) pass.
  - So do `g7-gsw` and `g7-web-rust` (g7-0 to g7-8). The web half of g7-8 replayed g8mm's
    receiver legs, the /10 control and the three sabotages.
  - `g7live-gsw` passes.
  - The one failure is `g7live-web-rust` g7-5's `stale-coalesce`: step 3 mismatched only DF, where
    DF, Marker and RM were expected. That is the gate 5 live mesh fixture at /7, with no multimesh
    and no code PM2 touches, and it is a hosted-runner load flake. Rerun locally
    (`RS_VALIDATE_GROUPS=g7-5 validate-increment.sh --only g7live-web-rust --tier full`): **pass**.
- **The runs the remote refused, run locally:** `g7live-gsw` and `g7live-web-rust` g7-1, full
  tier: **both pass**. I stopped the local timing runs that `--and-local` started (see
  Memory-worthy).
- **Out of scope:** the timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`)
  belong to the milestone sweep. GSW is PM3's.

## Time

Implementation, from setup at 05:11 to the first g8mm run, took about 40 minutes: the capi and
shim, the checks and the fixture. The STS2 leg, the replays and the fixes to the checks ran
alongside it. Validation took the rest: the local g8mm runs (about 8 minutes each, with lock
waits behind other agents' timing benches), the four STS2 replays (about 25 minutes) and the
remote full tier (about 1 h including the queue, 06:00 to about 07:00, with the local g7-1 runs
alongside), then the local g7-5 rerun (to 07:15). In all, about 40 minutes of implementation and
1 h 25 min of validation and STS2.

## Memory-worthy

- **The identity-transform gap.** A global-coordinate `CPUParticles2D` (Godot 4's default) uses
  `canvas_item_set_use_identity_transform`, which the capture does not hook. Any receiver draws
  it through the node transform twice. STS2's combat emitters are unaffected.
- **Parity hides a stale custom-data buffer.** B_CUSTOM shows frame parity, so a buffer stale
  since frame 29 matches at frame 47. Shoot the frame before as well.
- **4.5.1's hidden `CPUParticles2D` never calls `multimesh_set_buffer`.** Hiding it already costs
  nothing on the wire.
- **The capi's RID kind space (3 bits) is full.** New RID kinds must share a table, as multimesh
  shares the mesh table.
- **The C3 harness.** `replay-*.sh` exits 2 silently when `C3_REC` is unset on an a11 capture (only
  `recording-patch.rs11` exists).
- **`remote-validate.sh --and-local`** also runs the timing runs locally (they are in the refused
  list). Stop that planner, or run the refused correctness runs yourself with `--only`.
