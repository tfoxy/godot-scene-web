## Gate 3a result (2026-10-09)

G3a ([protocol/gate3-design.md](../protocol/gate3-design.md) "G3a") passes:
`pnpm render-stream:gate3 -- --legs g3a` is 16/16 in
`artifacts/render-stream/gate3/20261009T220745Z/`. An earlier run on the same code,
`20261009T213400Z`, was also 16/16. The same build passed gate −1 28/28 with 55 hooks planned and
none omitted (`artifacts/render-stream/gate-minus1/20261009T214037Z/`), gate 0 19/19
(`gate0/20261009T214155Z/`), gate 1 65/65 with all four groups (`gate1/20261009T214425Z/`) and
gate 2 85/85 with all five groups (`gate2/20261009T215439Z/`). The wire is unchanged
(render-stream/2), and the capture leg classifies `success`.

What landed:

- **The mirror clear fix (D3).** `Mirror::clear` now sets `clip = false`, as the engine's
  `Item::clear()` does, and keeps `custom_rect`. Three new `rs_mirror_test` cases cover it: clear
  resets, re-asserting in the same frame carries no clip change on the patch wire, and an omitted
  `set_clip` followed by a clear leaves the clip false. Gates 0–2 never set a clip true, so their
  captured state is unchanged.
- **The axis-aligned fixture** (`fixtures/gate3/`) and `make_expected.py`, which models Q1c from
  the source over the fixture's parameters and asserts Q6b's hand table.
- **`scripts/lib/clip-derive.ts`**, the wire-side scissor derivation (gate 7's reference), and the
  runner, checker and self-test (`run-gate3.sh`, `check-gate3.ts`, `lib/gate3-*.ts`,
  `test/self-test-gate3.ts`, 110 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`,
`reference-repeat/shots/step-{0..9}.png` and `reference-armed/shots/step-{0..9}.png`. Every
reference shot equals `synthesizeGate3` exactly, full frame and every region. The repeat and the
armed reference are byte-identical to the reference, so the budget is 0. All **1 314 probes**
across the ten steps (591 decisive pairs) have exactly their expected colour. `clip-derive.ts`
over both sinks' settle transactions reproduces every owner's scissor, Q6b's table:

| step | `A`                | `B`                 | `C`                 | `D`                | `RC`               | `AN`               |
| ---- | ------------------ | ------------------- | ------------------- | ------------------ | ------------------ | ------------------ |
| 0, 1 | `[96,88,256,208)`  | `[196,148,256,208)` | `[236,188,256,208)` | `[344,88,408,136)` | `[464,88,528,136)` | `[88,320,616,344)` |
| 2    | same               | `[176,138,256,208)` | `[216,178,256,208)` | same               | same               | same               |
| 3    | same               | `[176,138,236,188)` | `[216,178,236,188)` | same               | same               | same               |
| 4    | —                  | same as 3           | same as 3           | same               | same               | same               |
| 5    | `[96,88,256,208)`  | same as 3           | same as 3           | same               | same               | same               |
| 6    | same               | same                | same                | same               | —                  | same               |
| 7    | same               | same                | same                | same               | `[472,96,488,112)` | same               |
| 8    | same               | same                | same                | same               | skipped            | same               |
| 9    | `[104,92,264,212)` | `[184,142,244,192)` | `[224,182,244,192)` | `[352,92,416,140)` | skipped            | `[96,324,624,348)` |

The census at the hook (`counters.json`, whole run) equals `expected.json`:
`canvas_item_set_clip` 11 true and 11 false (17 distinct entries), `canvas_item_set_custom_rect`
20 enabled and 1 disabled (18 distinct), and `canvas_item_clear` 32, with nothing dropped. Every
Control redraw re-sent clear, custom rect and clip, and no engine redraw was unaccounted for.

### Findings

- **Every hand prediction held on the first run.** These include the nested and slid scissors, the
  clip that a redraw re-asserts after its clear, the toggle, the step-6 clear that resets `RC`'s
  clip (`RCF` drawn whole), the clip without a custom rect that falls back to the command bounds,
  the zero-area skip, the custom rect that culls `CU` at steps 0–1 and draws it once its rect only
  touches the viewport edge, and the canvas shift.
- **No draw-index ties** occur in any of the capture's 400 frames, so `no-draw-index-ties` has
  nothing to list.
- **The ignore-clip prediction is wider than the contract said.** Unclipped, `BF`, `BZ` and `CF`
  also cover 34 _inside_ probes near `A`'s and `B`'s right and bottom edges. The model's
  `predictions` carry the exact set, and the contract's G3b row now points at them (As built,
  G3a). The other predicted step sets match Q7: freeze {2..9}, perturb {1..9}, omit-clip {3..9},
  omit-custom-rect {7,8,9}, clip-before-clear {3..9}, and root-size-observe mismatching only
  region `anchored`.

### What G3a does not prove

- That a receiver reproduces any of this. The receiver still applies `clip` before its clear
  (G3b). That gap is also why G3a has no receiver legs.
- Rotated or scaled clip owners (G3c), `clip_ignore` (G3d), text clipping (gate 4), or clipping
  under stretch (gates 6 and 7).

## Gate 3b result (2026-10-09)

G3b ([protocol/gate3-design.md](../protocol/gate3-design.md) "G3b") passes:
`pnpm render-stream:gate3 -- --legs g3a,g3b` is 31/31 in
`artifacts/render-stream/gate3/20261010T003234Z/`. The same build passed gate −1 28/28 with 55
hooks and none omitted, gate 0 19/19, gate 1 65/65 (all four groups) and gate 2 85/85 (all five
groups) -- proving the reordered applier is still correct for every receiver leg gates 0–2
already exercise. `pnpm exec tsx --conditions=development
experiments/render-stream/scripts/test/self-test-gate3.ts` is 171/171 and
`fixtures/gate3/make_expected.py --check` is clean.

What landed:

- **The receiver apply order (D3).** `rs_applier.gd`'s `clip` setter now runs after the content
  block. A content rebuild's `canvas_item_clear` resets the shadow clip to false first (the
  engine's own reset), so the setter only re-sends `canvas_item_set_clip` when the wire value then
  differs from that shadow -- exactly the three cases of Q5: a redraw with `clip` unchanged
  re-sends it (`clear`, the adds, `set_clip(true)`); a transform-only change sends neither; a
  redraw that also flips `clip` to `false` sends no `set_clip` call, because the post-clear shadow
  already agrees. `receiver/tests/applier2_selftest.gd` gained `_test_applier_clip_order` (the
  three cases plus the new-item path) and two sabotage tests, all against the recorded
  `item_calls` sequence (new test instrumentation on `apply_state()`'s return value, not a wire
  field). Gates 0–2's own receiver legs stayed green because none of their fixtures ever clip.
- **Two receiver sabotages** (`RS_RECEIVER_SABOTAGE=ignore-clip` / `clip-before-clear`): the first
  corrupts every `canvas_item_set_clip` argument to `false` while the shadow still tracks the true
  wire value (same call cadence as an honest receiver); the second restores the pre-gate-3 bug
  outright (clip before content, no shadow reset).
- **`receiver`, `receiver-patch` and `receiver-headless-trace`** replay g3a's own capture
  (full and patch); **`sabotage-freeze`, `sabotage-perturb`, `sabotage-omit-clip` and
  `sabotage-omit-custom-rect`** each capture their own fresh recording with /1's host sabotages;
  **`root-size-observe`** captures with `GRC_ROOT_SIZE` unset. `scripts/lib/gate3-checks.ts` gained
  `evaluateG3bLeg`, `computeGate3ReceiverCheckpoints`, `probeTallyReceiver` and `checkLegClass3`,
  which reads every leg's expected mismatching steps, mismatching regions and failing probes
  straight out of `expected.json` `predictions[leg]` rather than a hand-typed table, so a
  disagreement with gate3-design.md Q7 would be a finding, not a silently-passing copy.
  `checkClipRectsDerived` gained a fourth, optional argument: once g3b runs, the same check also
  runs `deriveClipRects` over `receiver-patch`'s own resolved `state/seq-<n>.json` dumps, not just
  the capture's two sinks.

Every leg classified exactly as gate3-design.md Q7 and G3a's "As built" predictions say, with no
hand-derivation needed on this side either:

| Leg                                    | Class            | Mismatching steps     |
| --------------------------------------- | ---------------- | ---------------------- |
| `receiver`, `receiver-patch`           | `success`        | none                    |
| `sabotage-freeze`                       | `pixel-mismatch` | `{2,3,4,5,6,7,8,9}`     |
| `sabotage-perturb`                      | `pixel-mismatch` | `{1,2,3,4,5,6,7,8,9}`   |
| `sabotage-omit-clip`                    | `pixel-mismatch` | `{3,4,5,6,7,8,9}`       |
| `sabotage-omit-custom-rect`             | `pixel-mismatch` | `{7,8,9}`               |
| `sabotage-receiver-ignore-clip`         | `pixel-mismatch` | `{0,1,2,3,4,5,6,7,8,9}` (625 failing probes, exactly `predictions`) |
| `sabotage-receiver-clip-before-clear`   | `pixel-mismatch` | `{3,4,5,6,7,8,9}`       |
| `root-size-observe`                      | `unsupported` (`degenerate-host-size`) | `{0..9}`, mismatching only in region `anchored` |

`receiver`'s and `receiver-patch`'s shots (`receiver/shots/seq-{8,18,28,...,98}.png`,
`receiver-patch/shots/seq-{8,18,...,98}.png`) equal `synthesizeGate3` exactly, full frame and
every region: all 1314 probes across the ten steps (591 decisive pairs) have exactly their
expected colour, same as the reference. `sabotage-receiver-ignore-clip`'s shots
(`sabotage-receiver-ignore-clip/shots/seq-*.png`) fail exactly the predicted 625 probes (every
decisive outside probe plus the 34 inside probes `BF`/`BZ`/`CF` cover once unclipped, G3a's "As
built" amendment). `clip-rects-derived` reproduces Q6b's table over both sinks' settle
transactions and, now, over `receiver-patch`'s own resolved state dumps -- the same table as
G3a's, unchanged.

### Findings

- **No surprises.** Every mismatching-step, mismatching-region and failing-probe set matched
  gate3-design.md Q7's tables and `expected.json` `predictions` exactly on the first run; no
  amendment was needed to either.
- **The gamescope teardown segfault recurred twice** (benign, memory:
  gamescope-teardown-segfault-benign): the run still reported 31/31 with every leg at its
  expected class.

### What G3b does not prove

- Rotated or scaled clip owners, `clip_ignore`, text clipping, or clipping under stretch (G3c,
  G3d, gates 4, 6 and 7, same as G3a).
- Late-join adoption of clip state, or a live leg exercising clip (both deferred, D10, gate 8).

## Gate 3c result (2026-10-09)

G3c ([protocol/gate3-design.md](../protocol/gate3-design.md) "G3c") adds the rotated/scaled fixture
`fixtures/gate3-xform/` and group g3c, and passes on top of G3b:
`pnpm render-stream:gate3 -- --legs g3a,g3b,g3c` is 49/49 in
`artifacts/render-stream/gate3/20261010T010856Z/`. Before G3b landed, the same g3c receiver checks failed on the
old receiver (28/34 with g3a, `20261009T232851Z/`), at exactly the six checks that need G3b's
clear-before-clip order and `ignore-clip` sabotage. The same build passed gate −1 28/28
(`gate-minus1/20261010T010355Z/`), gate 0 19/19 (`gate0/20261010T010357Z/`), gate 1 65/65
(`gate1/20261010T010853Z/`), gate 2 85/85 (`gate2/20261010T012338Z/`) and gate 4 g4a 21/21
(`gate4/20261010T012340Z/`). The capture and the wire are unchanged.

What landed:

- **The fixture** (`fixtures/gate3-xform/`): four clip owners under transformed `Node2D` parents
  (`rot`, `rotnest`, `half`, `flip`) over five steps, with `snap_controls_to_pixels` off.
- **`make_expected.py`**, which models the transforms, the RS calls, the cull and the scissor
  from the source, paints by pixel-centre coverage, marks the band, and evaluates the three
  alternative clip models at the six semantic probes. It asserts Q6d's hand tables.
- **`lib/gate3x-expected.ts`**, **`lib/gate3x-checks.ts`**, group g3c in `run-gate3.sh` and
  `runGate3`, and `test/gate3x-cases.ts` (34 more self-test assertions; 205 in all with G3b's).

Images (under `20261010T010856Z/`): `reference-xform/shots/step-{0..4}.png`, the same under
`reference-xform-repeat/` and `reference-xform-armed/`, and the receivers' `seq-{8,18,28,38,48}.png`
under `receiver-xform/shots/`, `receiver-xform-patch/shots/`,
`sabotage-xform-perturb/receiver/shots/` and `sabotage-xform-receiver-ignore-clip/shots/`.

The semantic probes as measured (reference pixel; the colour each model predicts):

| Probe                          | reference | engine | `rotated-exact` | `edge-round` | `pixel-centre` |
| ------------------------------ | --------- | ------ | --------------- | ------------ | -------------- |
| `rot.corner@0` (84,84)         | `RQF`     | `RQF`  | clear           | `RQF`        | `RQF`          |
| `rot.bottom@0` (100,157)       | `RQF`     | `RQF`  | clear           | clear        | clear          |
| `rot.bottom@2` (100,166)       | clear     | clear  | clear           | `RQF`        | `RQF`          |
| `half.right@0` (402,60)        | `SQF`     | `SQF`  | clear           | clear        | clear          |
| `half.bottom@0` (380,73)       | `SQF`     | `SQF`  | clear           | clear        | clear          |
| `half.sliver@0` (401,60)       | `SRF`     | `SRF`  | `SQF`           | `SQF`        | `SQF`          |

So the reference refutes each alternative at five of the six probes. The band is 191, 191, 240,
240 and 240 px at steps 0–4, all of it on `RQI`'s rotated edges. The reference equals pixel-centre
synthesis there too, and the repeat differs nowhere, so **the budget is 0 px**. All 660 probes
(330 decisive pairs) are exact in the reference and in both receivers. `clip-derive.ts` over both
sinks reproduces every scissor, including the rotation (`RQ` `[83,83,172,158)` → `[91,75,166,164)`
→ `[72,73,184,166)`), the nesting (`RQ2` `[232,79,328,145)`), the half rounding (`SQ`
`[371,51,403,74)`), the sliver (`SR` `[401,54,402,66)` → `[414,58,415,74)`) and the flip (`FQ`
`[448,208,512,256)` → `[528,208,592,256)`). The capture's retained state holds all 460 invariants:
there are no content changes at steps 1, 3 and 4, and `RQ` bumps at step 2 with `clip` true. Perturb
mismatches at exactly {1..4}. Ignore-clip mismatches at exactly {0..4}, with the 386 predicted
failing probes.

### Findings

- **Every hand value of Q6d held on the first run**, both the scissors and all 24 semantic-probe
  cells. GLES3 rasterizes non-antialiased rotated rects exactly by pixel centre on this GPU (RTX
  2060), band included.
- **The receiver dependency is the D3 trap, measured.** On the pre-G3b receiver, `receiver-xform`
  and `-patch` mismatch at exactly steps {2,3,4}, in `rot`, with `RQF` spilling into `rotnest`. `RQ`'s scale redraw at step 2 clears it, and the receiver set `clip` before that
  clear.
- Contract amendments (gate3-design.md "As built (G3c)"): `OA.left` and `OA.right` are listed as
  non-decisive, because `RQ2`'s scissor shares them; two ignore-clip probes lie in the unclipped
  band; the receiver import; check ids get `-xform`; the snap rounds rather than floors.

### What G3c does not prove

- Rotated text clipping, skew, clipping under stretch, or a browser receiver's clip (gates 4, 6
  and 7).

## Gate 3d result (2026-10-10)

G3d ([protocol/gate3-design.md](../protocol/gate3-design.md) "G3d") passes:
`pnpm render-stream:gate3 -- --legs g3a,g3b,g3c,g3d` is **56/56** in
`artifacts/render-stream/gate3/20261010T025646Z/`, with `groups.not_run` empty. This run lands
after G3b's and G3c's own increments, and lifts G3d's original step-0-only limitation on
`receiver-clip-ignore` (see "Findings"). The same build passed gate −1 29/29 with **56 hooks**
planned and none omitted (`artifacts/render-stream/gate-minus1/20261010T023902Z/`), gate 0 19/19
(`gate0/20261010T013636Z/`), gate 1 65/65 (`gate1/20261010T013931Z/`) and gate 2 85/85
(`gate2/20261010T024044Z/`, a rerun: a same-code run earlier that session scored 83/85 on
`pins-bounded`/`obsolete-retired` under heavy concurrent load from other agents' gate runs on this
machine -- a timing-sensitive `live-animate` leg, not a regression; see gate 3c's own "Findings").

What landed:

- **Calibrator 6.** `canvas_item_add_clip_ignore` (header line 1595, slot 479, the existing
  `FnRidBool` signature) joins `hooks.cpp` as an optional hook. The mirror tap is the *existing*
  generic `add_unsupported` path every other calibrator-2 draw op already uses (msdf, polygon,
  triangle array, …): no new mirror code, one new `rs_mirror_test` case. The hook itself logs
  `(item, ignore)` into `counters.json`'s `captured.canvas_item_add_clip_ignore`, deduplicated like
  every other optional setter; the bool never reaches the wire.
- **Calibration record and spike.** The committed record now names 57 slots (56 hooks plus the
  `get_default_clear_color` probe); `scripts/calibrate.sh --check` is clean. `fixtures/spike/`
  gets a second orphan raw item (`add_clip_ignore(true)`, a rect, `add_clip_ignore(false)`, no
  parent canvas), so gate −1 plans 56 hooks with every optional counter positive and
  `armed.png == unarmed.png` still holds.
- **Feature-list amendment.** `observed_unsupported_ops` gains `canvas_item_add_clip_ignore`;
  `unobserved` gains `canvas_item_set_visibility_notifier` (D6: it is never hooked, and the scene
  API never combines a notifier with a clip). Both arrays stay sorted by byte value, in
  `capture/src/rs_publish.cpp` (`gate2_features`) and its test mirror
  `scripts/lib/gate0-checks.ts` (`RS2_FEATURES`, `GATE0_HOOKS`), which every gate's
  `manifest-present`/`capture-armed` reuses. `protocol/golden-2/` and `capture/test/rs2_golden_states.h`
  were regenerated to match (G1e's precedent).
- **The `clip-ignore` variant.** `fixtures/gate3/gate3.gd` adds a static raw item `RI` (draw index
  1002, origin (472,184)) only under `RS_FIXTURE_VARIANT=clip-ignore`: `add_rect`,
  `add_clip_ignore(true)`, `add_rect`, `add_clip_ignore(false)`, inside its own custom rect/clip.
  `make_expected.py`'s `variant_clip_ignore` block carries RI's draws per step for both the
  reference (the real engine's clip-ignore semantics, Q1d) and the receiver (which only sees the
  two `add_clip_ignore` calls as unsupported commands, so both rects stay clipped to RI's own
  scissor); both move with the step-9 canvas shift like every other top-level item. New legs
  `capture-clip-ignore`, `reference-clip-ignore` and `receiver-clip-ignore`
  (group `g3d`) and new checks `capture-armed-clip-ignore` (a second capture leg under its own
  directory, since gate 0's `checkCaptureArmed` hardcodes `capture/`), `clip-ignore-typed`,
  `expected-image-reference-clip-ignore` and `leg-class-capture-clip-ignore`/
  `-receiver-clip-ignore`.

Evidence: `capture-clip-ignore/recording.rs2`'s last transaction carries RI's item with exactly
`add_rect`, `unsupported canvas_item_add_clip_ignore`, `add_rect`, `unsupported
canvas_item_add_clip_ignore`, and one de-duplicated item-level entry
`{"op":"canvas_item_add_clip_ignore","reason":"unsupported-op"}` — `clip-ignore-typed` reads this
directly. `reference-clip-ignore/shots/step-{0..9}.png` equal `synthesizeGate3` with RI's
reference draws appended, exactly, at every step. `receiver-clip-ignore` replays every one of the
ten settle seqs against `reference-clip-ignore`'s matching `step-<k>.png`: `leg-class-receiver-
clip-ignore` reports mismatching regions `{ri}` and nothing else, at every step combined -- RI's
escaped second rect is the only disagreement, and the base scene's own clipping Controls (`B`,
`A`, `D`, `RC`), now on G3b's fixed receiver, replay clean alongside it.

### Findings

- **The step-0-only limitation lifted cleanly once G3b landed.** The first G3d run (branch history,
  `--legs g3a,g3d` only) found that comparing `receiver-clip-ignore` past step 0 also exercised the
  base scene's own clipping Controls (`B`, `A`, `D`, `RC`), which redraw at steps 3, 5 and 7 and lost
  their clip on the then-current receiver's `clip`-before-clear order (D3) -- spurious mismatches in
  regions `nested`, `redraw` and `raw`, not `ri`. The fix at the time was to request and check only
  the step-0 shot. With G3b's receiver apply-order fix now on `main`, this run restores full
  ten-step comparison (`make_expected.py`'s `variant_clip_ignore.receiver_draws` is per step, same
  as `reference_draws`; `run-gate3.sh`'s `run_g3d` uses the generic `run_rendered_receiver` helper
  again instead of a single-seq lookup) and the result is exactly the predicted `{ri}`-only
  mismatch at every step, with zero contamination from the base scene.
- **RI moves with the canvas shift.** The first attempt kept `variant_clip_ignore`'s draws static
  across all ten steps; `expected-image-reference-clip-ignore` caught the miss at step 9 (RI, like
  every other top-level item, is parented to the root canvas, so `get_viewport().canvas_transform`
  moves it too). Both `reference_draws` and `receiver_draws` are computed per step.

### What G3d does not prove

- That a receiver reproduces `canvas_item_add_clip_ignore` as anything other than a typed refusal
  — it is never asked to draw RI's second rect unclipped; that is the engine-only behaviour Q1d
  describes and D4 deliberately keeps off the wire.
- `clip_ignore` as a *supported* command: it stays a typed, in-place refusal (D4); the first wire
  bump after gate 3 (gate 5) is where that lands.

## Gate 3 summary

Gate 3 passes: `pnpm render-stream:gate3` with all groups g3a-g3d is **56/56** in
`artifacts/render-stream/gate3/20261010T074659Z/`, on the same build as gate −1
(`artifacts/render-stream/gate-minus1/20261010T072444Z/`), gate 0 19/19
(`gate0/20261010T072550Z/`), gate 1 65/65 (`gate1/20261010T072751Z/`) and gate 2 85/85
(`gate2/20261010T073607Z/`). Every leg is at its expected class. Images are under each leg's
`shots/` in the run directory: `reference/shots/step-{0..9}.png`, `reference-repeat/shots/` and
`reference-armed/shots/` (g3a); `receiver/shots/` and `receiver-patch/shots/` (g3b);
`reference-xform/shots/step-{0..4}.png`, `receiver-xform/shots/` and `receiver-xform-patch/shots/`
(g3c); `reference-clip-ignore/shots/step-{0..9}.png` and `receiver-clip-ignore/shots/` (g3d).

What it proves, by increment:

- **3a.** The engine's clip is a scissor: the rounded axis-aligned bounding box of the item's
  transformed rect, intersected with the nearest clipping ancestor's own already-rounded clip, as
  an integer scissor. The mirror's `canvas_item_clear` fix (D3) resets `clip` to `false` the way
  the engine's `Item::clear()` does. The axis-aligned fixture's 1 314 probes (591 decisive pairs)
  match exactly, `clip-derive.ts` reproduces every owner's scissor table by hand, and the budget
  (reference against a same-build repeat) is 0.
- **3b.** The receiver's apply order (D3): `clip` now applies after the content block, so a
  redraw's post-clear shadow state only re-sends `canvas_item_set_clip` when the wire value
  actually differs from it. Every sabotage — host-side (`freeze-frame`, `perturb-transform`,
  `omit-op` on `clip`/`custom_rect`) and receiver-side (`ignore-clip`,
  `clip-before-clear`) — mismatches at exactly its predicted steps, regions and probes, read
  straight from `expected.json` rather than a hand-typed table.
- **3c.** Rotated and scaled clip owners follow the same bounding-box model, not a rotated-rectangle
  clip, edge-independent rounding, or a pixel-centre scissor: the reference refutes each of those
  three alternatives at five of six semantic probes. The budget outside the non-axis-aligned band
  is 0, and the band itself (191–240 px across the five steps) matches pixel-centre synthesis.
- **3d.** Calibrator 6 hooks `canvas_item_add_clip_ignore` and types it `unsupported-op`, through
  the same generic unsupported-command path every other optional draw op already uses — no new
  mirror code. The receiver's only disagreement with the reference is the region `clip_ignore`
  escapes; the base scene's own clipping Controls replay clean alongside it.

Unsupported, each typed and never substituted: `canvas_item_add_clip_ignore`
(`unsupported-op`, calibrator 6, G3d) — supporting it as a command waits for gate 5's own wire
bump (`render-stream/4`, D4), since gate 5 must already bump for lines, polygons, meshes and
nine-patch. `unobserved`, not even typed: `clip_children` / `canvas_group_mode` (the handoff's
CanvasGroup/masks capability, D5, which needs item state /2 cannot validate) and
`canvas_item_set_visibility_notifier` (D6, added at G3d: the scene API never combines a notifier
with a clip, and notifier callbacks never fire on a headless host at all).

Costs and budgets measured in this run:

- **Budgets.** Axis-aligned: 0 px, reference byte-identical to its repeat across all 1 314 probes.
  Rotated/scaled: 0 px outside the band; the band covering non-axis-aligned edges is 191–240 px
  across the five steps, all on the rotated owner's edges, and the reference equals pixel-centre
  synthesis there too.
- **Probe coverage.** Every named boundary probe is exact in the reference and in both receivers
  (g3b, g3c); `sabotage-receiver-ignore-clip` fails exactly its predicted 625 probes (every
  decisive outside probe plus the 34 inside probes the unclipped scene exposes near `A`'s and
  `B`'s edges).
- **Census.** The hook log's `canvas_item_set_clip`, `canvas_item_set_custom_rect` and
  `canvas_item_clear` counts equal an independent derivation with nothing dropped, at every step.

What gate 3 does not prove: text clipping, including `Label.clip_text` (gate 4); clipping under
`canvas_items` stretch or a receiver-side stretch (gates 6 and 7); scroll containers with themed
scrollbars (gate 5's styleboxes, then gate 6); a browser receiver's clip, for which
`clip-derive.ts` is the reference implementation and both gate 3 fixtures the conformance set
(gate 7); a live leg exercising clip, and late-join adoption of clip state for Controls that exist
before arming (both gate 8, D10); `top_level` escape, uncovered unless gate 6's combined scene
uses it; and `VisibleOnScreenNotifier2D` never firing on a headless host, a host-behaviour finding
left to gate 8 (D6).

