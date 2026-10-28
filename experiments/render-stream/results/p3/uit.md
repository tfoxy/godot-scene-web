# UIT: `canvas_item_set_use_identity_transform` on render-stream/11, every receiver (2026-10-28)

PM2 found that a global-coordinate `CPUParticles2D` (`local_coords = false`, Godot 4's default)
draws in the wrong place on every receiver. Its item calls
`RenderingServer::canvas_item_set_use_identity_transform(item, true)`. The capture did not hook that
call, so every receiver composed the item's ancestors on top of particle transforms that are
already global. UIT hooks the call at /11, carries it as an optional item key, and makes the native
receiver, the web export and GSW honour it. The rules are in
[render-stream-11.md](../../protocol/render-stream-11.md) "As built (UIT): decisions" (10 rules).

## The engine (4.5.1)

- **What the flag replaces.** In `renderer_canvas_cull.cpp`, `_cull_canvas_item` composes
  `final_xform = parent · xform` as usual and hands it to the children (:330-345). The flag
  replaces only what the item itself draws with. Its `final_transform` is
  `_current_camera_transform`, the canvas transform `render_canvas` was given (the viewport's
  global canvas transform times the canvas's, :76, :257). Its global rect, which the viewport cull
  and its own `clip` use, is that transform over its local rect (:373-377).
- **What it does not replace.** A canvas group owner's synthesized rect still uses the composed
  transform (:228). Y-sorted items take the same branch (`final_transform` again).
  `canvas_item_clear` keeps the flag.
- **Who calls it.** Only `CPUParticles2D::set_use_local_coordinates`, through
  `CanvasItem::set_canvas_item_use_identity_transform`. RenderingServer binds no script method for
  it. The constructor calls the setter with `false`, so every emitter's item sends `true` once, and
  a local emitter then sends `false`. `Node2D::set_transform` skips the item transform while the
  flag is on, but `set_position` and the other `_update_transform` setters still send it, so an
  emitter's children follow its position.

## What changed

- **Calibration.** `calibrate.py` gains `canvas_item_set_use_identity_transform`. It is slot 461
  on the stock 4.5.1 template (committed record) and on STS2's MegaDot build. It is conditional
  like PM1's slots: planned only at /11, and below /11 neither planned nor omitted. The calibrator
  version stays 9.
- **Capture** (`capture/src`):
  - `hooks.cpp`: `hook_set_use_identity_transform`, which passes the call through first.
  - `rs_mirror`: `set_use_identity_transform` on the item. A call that changes nothing moves no
    epoch, because the constructor's call on every emitter must not publish a frame.
  - `rs2_snapshot.h`, `rs2_codec.cpp`: `ItemState::use_identity_transform`, encoded at /11 only
    and only when true.
  - `rs2_diff.cpp`: the flag takes part in a /11 patch's item comparison.
  - `rs_adopt`: under `GRC_ADOPT=arm`, adoption reads `!CPUParticles2D.get_use_local_coordinates()`
    when the hook is planned. `result.json` `adoption.identity_transforms` counts those items.
- **Wire** (rule 4). `"use_identity_transform": true` follows `copy_to_backbuffer`, and the key is
  absent when false. `false`, or the key below /11, is `meta-schema`. The flag is item state, never
  `content_version`.
- **Validators.** `render-stream-2.ts` and rs-core (`meta.rs`, the `meta/fast.rs` fast path,
  `validate.rs`, `state.rs`, `canon.rs`) decode, validate and resolve the key, keeping it
  verbatim. The native and GSW state dumps carry it too.
- **Native and web receivers.**
  - `rs-core-capi`: opcode 75 `ItemSetUseIdentityTransform`, so `OP_COUNT` is 76. The planner
    re-issues the flag whenever the wire's differs from what it last set.
  - The shim (`receiver/ext/rs_core_ext.cpp`) calls the RenderingServer singleton's vtable
    slot 461, because there is no method bind to call. It does so only on Godot 4.5.1; any other
    engine logs once and leaves the item composed.
  - The same shim built for wasm (`build-rs-core-web.sh`) serves the web export, since the Itanium
    vtable layout is the same there.
  - `receiver.gd` and `rs_rust_applier.gd` accept the sabotage name.
- **GSW** (rs-core `apply/mod.rs`). Each item record keeps two transforms:
  - `final_xform`, which goes to its children and to a canvas group owner's synthesized rect;
  - `draw_xform`, which is the item's row, clip and cull transform: the canvas transform under the
    flag, else `final_xform`.

  The rows-only move path does the same, so a moving parent leaves an identity item's row alone.
  The flag is part of the structure key. `web/gsw-rs` maps the sabotage name.
- **Receiver sabotage** `ignore-identity-transform` (native, web, GSW): the pre-UIT receiver.
- **Fixture** `fixtures/gate8-mm`.
  - D_GLOBAL now also draws a 12x12 rect on the emitter's own item, at global (170, 203). It also
    draws a 10x10 rect on a child `Node2D` of the emitter, at local (100, 45), which moves with the
    parent.
  - `expected.json` has no known gap any more. Its `pixels.identity_transform` names the cell
    (D_GLOBAL) and where the sabotage's displaced particles spill (G_HIDDEN).
- **Checks.**
  - `mm-reference` (native, `@web`) and `mm-gsw-band@gsw` now judge every cell, D_GLOBAL and
    G_HIDDEN included.
  - New: `mm-reference-catches-ignore-identity-transform` (`sabotage-ignore-identity-transform/receiver`,
    native and `@web`) and `mm-gsw-catches-ignore-identity-transform@gsw` (the same leg on GSW).
  - PM2's informational `mm-identity-transform-gap` is gone: it iterated the known gaps, and there
    are none.
- **Goldens** (`golden-11/`).
  - State 22: item 18, a child of item 16, with the flag.
  - State 23: the flag cleared, so the patch carries item 18 alone with `commands` null.
  - Two invalid vectors: `identity-transform-false.rs11` and `identity-transform-v10.rs10`, both
    `meta-schema`.
  - The C++ codec test builds both states. `coding/*.coded` were regenerated with
    `rs_live_coding_tool`.
  - rs-core gains `apply/uit_tests.rs` (GSW: item 18's row is the canvas transform at 22 and the
    composed one at 23, or composed at both under the sabotage). rs-core-capi gains
    `golden_11_reissues_the_identity_flag`.
- **Tooling.** `cmp-rec.ts --allow-item-key <key>` tolerates a transaction that differs only by
  that key on some items. Deleting the key from every item must make the metas and blocks equal.
  The end record's `bytes_total` must then move by exactly the tolerated length.

## Checks (g8mm, local run `artifacts/render-stream/p3/uit/g8mm-1/result.json`): PASS 19/19

| Check | Verdict |
| ----- | ------- |
| `mm-reference` | pass, every cell exact on the full and patch sinks: 6 shots each (3 settle frames and the frame before each). Made 8, freed 1, 8 draws, 1 skipped. Full sink: 669 buffers. Patch sink: 366. |
| `mm-reference-catches-ignore-identity-transform` | pass: D_GLOBAL differs at every checkpoint (153, 189, 216 px at steps 0, 1, 2), and no cell outside D_GLOBAL and G_HIDDEN differs |
| `mm-premise`, `mm-reference-repeat`, `mm-reference-moving`, `mm-state` | pass |
| PM1's checks and sabotages, `mm-reference-catches-{undrawn-multimesh,perturb-instance,stale-buffer}`, `mm-hidden-cost` | pass, unchanged |

In the shots, the reference draws D_GLOBAL's particles at the parent's position (40+2k, 180), the
yellow rect at (170, 203) and the cyan child rect at (140+2k, 225). Under the sabotage, the particles
move down and right by the parent's offset (some into G_HIDDEN's cell), the yellow rect leaves the
screen, and the cyan child rect stays where it was. The capture logs 6 hook calls:

- C_FLIP and G_HIDDEN: `true` from the constructor, then `false` from `local_coords = true`;
- D_GLOBAL: `true` twice.

The full sink carries the key on D_GLOBAL's item in all 90 transactions. The patch sink carries it
once, at seq 1.

## Byte identity

Both trees ran the same legs locally: this worktree, and a `create-worktree.sh` checkout of main
`c714a819` (`uit-base`, since removed). The legs were gates 1, 2 and 5 with sabotage legs and
timing groups skipped (`RS_SABOTAGE_TIER=skip RS_SKIP_TIMING_GROUPS=1`), and gate 8
`--legs g8w11,g8mm` with every leg. The comparator was
`cmp-rec.ts --tree --allow-session capture.hooks_planned --allow-item-key use_identity_transform`.
Its outputs are in `artifacts/render-stream/p3/uit/byte-identity/`.

| Recordings | Identical | Notes |
| ---------- | --------- | ----- |
| gate 1 | 16 of 17 | the 17th is `live-replay/recording.rs2`, the live receiver's input copy. Its length follows live pacing (1023 vs 1026 records), as in PM1. |
| gate 2 | 42 of 43 | the same `live-replay` copy (912 vs 864) |
| gate 5 | 28 of 28 | |
| g8w11, every leg | 51 of 51 | no `CPUParticles2D` there. The /11 sessions differ only in `capture.hooks_planned`; the /10 and GSW recordings differ only in their ids. |
| g8mm /10 (`capture-v10`, `receiver-v10`) | 3 of 3 | byte-identical apart from the ids |
| g8mm /11 (captures, headless, the sabotaged captures, the receivers' copies) | 10 of 10 under `--allow-item-key` | Every transaction differs from main only by `"use_identity_transform": true` on D_GLOBAL's item. The full sinks carry it in all 90 transactions, the patch sinks once (seq 1, a full). The end record's `bytes_total` moves by exactly those bytes. |

The goldens:

- `make_golden.py --check` passes for `golden-1/` to `golden-10/`, unchanged.
- In `golden-11/`, every record of states 1-21 in `full.rs11`, `patch.rs11` and `inline.rs11` is
  byte-identical to main. The new records are states 22 and 23 and the end.
- `rs-core-check goldens` passes 1,095/1,095 checks: golden-11 147/147, cross-version 16/16.
- The C++ codec ctests (36/36) rebuild golden-11 byte for byte.

So below /11, and at /11 for a host that never makes the call, every transaction is what main
writes.

## STS2

- **Calibration, offline.** `calibrate.py --version-name MegaDot` ran against a byte-identical farm
  copy of `SlayTheSpire2` (sha256 `0c21999e…`, read only, never executed). It wrote
  `calibration/sts2-megadot-4.5.1-m12.uit.json` in couch-coop's research folder, with
  `calibrate.uit.stdout.txt` beside it. The result is 588 slots, anchors 17/17 and calibrator 9. It
  is identical to PM5's `…m12.pt.json` (`…m12.mm.json` plus PM5's 33 `particles_*` slots) except
  for the new key (461, the stock template's slot): it was re-derived with the merged calibrator
  after the rebase onto PM5, so it is the merged record, the `C3_CAL` for any later STS2 /11 or
  /12 leg.
- **Does STS2 use global coordinates?** Yes. The recovered project has 1,378 `CPUParticles2D`
  nodes, and 96 of them do not set `local_coords = true`, so they are global. They are:
  - every character's card trail (`vfx/card_trail_*`);
  - the combat power icon's `PowerFlash` and the orb's `Flash` (one-shot, not emitting until
    triggered);
  - monster death, card upgrade and transform, and potion flash VFX;
  - the decimillipede and insatiable creature visuals;
  - some rest-site and event backgrounds.

  None is set at run time: no script assigns `local_coords`.
- **The recorded route.** `pm-a11-1` (menu, map, then Ironclad against SLIMES_NORMAL, with no card
  played) shows no visible global emitter. PM2's combat replay is at 0 px over 16 against the
  game's own shots. The global emitters present there (power and orb flashes) were not emitting,
  and no card trail is in flight. The recording cannot show which items set the flag, because the
  call was not hooked then. It would matter in a combat where cards are played.
- **No game leg.** It is optional, and the load gate (< 4) was not met: the load average stayed at
  7-9 from other agents' runs. The capture-side risk (hooking slot 461 in MegaDot) is covered
  offline by the calibration.

## Validation

- **Unit tests.**
  - Capture ctests 36/36. `rs11_codec` builds states 22 and 23, and the coding goldens pass.
  - rs-core `cargo test --release`: 93 passed (`uit_tests` new; `w11c_tests` now counts 23
    transactions).
  - rs-core-capi: 12 passed (`golden_11_reissues_the_identity_flag` new; `OP_COUNT` 76; the coding
    test's `prefixed` count is 19).
  - `rs-core-check goldens`: all pass.
  - decode-proto-rs passes.
  - `web/gsw-rs`: `cargo check --target wasm32-unknown-unknown` is clean.
  - `build-rs-core-ext.sh` and `build-rs-core-web.sh` build.
  - `self-test-rs2` passes, including both invalid vectors with `meta-schema` and item 18's key at
    22 and 23 in all three recordings.
  - `self-test-gate8-mm` 137/137, `self-test-gate8-w11-native` 26/26 (23 transactions),
    `self-test-gate8-w11-gsw` 12/12.
  - `tsc`: no new errors. The remaining ones are the known `gate2b-checks.ts`,
    `gate8-cache-checks.ts` and `g8kv-validate-ktx2.ts`, plus `gsw-receiver/live.ts`
    `transport_skip`, which is pre-existing.
- **g8mm locally:** PASS 19/19 (above).
- **Full tier, remotely** (before the rebase onto HC1 and PM5):
  [run 40700170794](https://github.com/tfoxy/godot-scene-web/actions/runs/40700170794),
  `remote-validate.sh --tier full`. **19 of 21 runs pass.**
  - Every setup run, every native gate (-1 to 8, with sabotage legs, g8mm included), `g7-gsw` (g7-0
    to g7-8) and `g7live-gsw` pass.
  - `g7live-web-rust` g7-2 failed: `live-animate step 9: no shot`, a hosted-runner "no shot" flake.
  - `g7-web-rust` g7-8 failed: `mm-reference-catches-perturb-instance@web` and
    `web-repeat-identical@web`, on one leg (`g8mm/sabotage-perturb-instance/receiver-patch`). The two
    web runs on the runner shot different pixels before the sabotage frame (C_FLIP 822 px), so the
    runner was not deterministic there.
  - **Local reruns** (`RS_VALIDATE_GROUPS=<g> validate-increment.sh --tier full --only <run>`):
    - `g7-web-rust` g7-8 passes, `web-repeat-identical@web` included (42 legs, 146 shots
      identical). The identity checks:
      - `mm-reference@web` passes;
      - `mm-reference-catches-ignore-identity-transform@web` passes: D_GLOBAL 153/189/216 px;
      - PM2 already noted that the web shots pass under the recorded readback/delta1 band.
    - `g7-gsw` g7-8 passes, with `mm-gsw-band@gsw` judging all 12 shots within channel 1 in every
      cell (no known gap skipped). `mm-gsw-catches-ignore-identity-transform@gsw` is caught at 3 of 3
      shots (D_GLOBAL 153, 189, 216 px; G_HIDDEN 15 and 24). Every `mm-reference*@gsw` passes.
    - `g7live-web-rust` g7-2 failed locally too, but differently: `live-stall`/`live-warm` missed
      shots and showed the known 252/61/512 px fold views. The lock wait was 6,058 s, with the
      machine at load 10-12 under other agents' benches. Gate 2 live runs at /6, where the capture
      and the wire are byte-identical (above), and nothing UIT changed runs there. This is the known
      g7-2 contention pattern, not a UIT regression. It goes to the sweep.
- **The runs the remote refused, run locally:** `g7live-gsw` and `g7live-web-rust` g7-1, full tier:
  **both pass**. `lock-tests` was not run: it is in the known load-sensitive list.
  `self-test-report` failed once in the local `pure` under load and passes alone (46/46).
- **After the rebase onto HC1 (37c41892) and PM5 (02bcd8aa).**
  - The conflicts were the hook table, `calibrate.py` and the stock record (both sides kept). The
    identity hook stays last and is planned at /11 and /12, so /12 carries the key too.
  - `golden-12/make_golden.py` now takes golden-11's states 1-21 explicitly (`g11.STATES[:21]`), so
    golden-12 is unchanged except `invalid/bad-magic.rs12`, which is a copy of golden-11's
    `full.rs11`.
  - Re-run: capture ctests 41/41; rs-core 104 passed; capi 13 passed; `rs-core-check goldens` all
    pass (golden-12 153/153).
  - `build-rs-core-ext.sh` and `build-rs-core-web.sh` were rebuilt.
  - Self-tests: `self-test-rs2`, `gate8-mm` 137/137, `gate8-pt` 83/83 and `gate8-w11-*` pass.
  - `tsc`: no new error.
  - `run-gate8.sh --legs g8mm,g8pt`: **PASS 33/33** (g8mm 19 and PM5's g8pt 14).
- **Out of scope:** the timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`). They
  belong to the milestone sweep.

## Time

From setup at 10:10 to 13:45, about 3 h 35 min in all.

- **Implementation, about 1 h 15 min.** The capture, the wire, the validators, the receivers and
  the goldens took about 45 minutes (to 10:55), with no rework on the first g8mm run. The fixture
  cell, the checks and the docs took about 20 more, and the rebase onto HC1 and PM5 about 15
  (conflicts and golden-12).
- **Validation, about 2 h 20 min**, much of it overlapping the implementation.
  - The byte-identity runs in both trees took 35 minutes (10:12-10:47).
  - The remote full tier took 70 minutes (10:50-12:00).
  - The local reruns of g7-1, g7-8 and g7-2 took 70 minutes, at load 8-12 with long lock waits.
  - The post-rebase checks took 20 minutes.

## Memory-worthy

- **Do not edit a runner script while it runs.** Bash reads the script as it goes. A
  `run-gate8.sh` edited during a run died at its end with `unexpected EOF while looking for
  matching '"'`. The captures had finished, so the byte-identity recordings were intact. Edit a
  runner only between runs.
- **RenderingServer has no bind for `canvas_item_set_use_identity_transform`.** A GDExtension
  receiver can only reach it through the singleton's vtable: slot 461 on 4.5.1, with the same
  layout on wasm.
- **Every `CPUParticles2D` sends `true` from its constructor.** A local emitter then sends
  `false`. A mirror that moves its epoch on a no-op call would publish a frame for nothing.
- **`Node2D::set_transform` skips the RS transform under the flag, but `set_position` does not.**
  An identity item's own transform still reaches its children.
- **`cmp-rec.ts --allow-item-key`** is how to prove "differs only by this key" for an additive item
  key.
