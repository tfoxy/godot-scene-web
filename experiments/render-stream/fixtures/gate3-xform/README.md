# Gate 3 rotated/scaled fixture

The reference rendering for gate 3's rotated and scaled clipping increment (G3c,
[`../../protocol/gate3-design.md`](../../protocol/gate3-design.md) "Q6d"). Five steps (0..4) put
`clip_contents` Controls under rotated, scaled and flipped `Node2D` parents. The engine clips each
to the rounded axis-aligned bounding box of its rect under the full transform, intersected with
the nearest clipping ancestor's rounded scissor (Q1c). The fixture also carries six semantic
probes where three plausible alternative models disagree with that. Like the other fixtures, the
project does not know about the capture library and runs the same whether `GRC_EXTENSION` is set
or not.

Import it once with the mise editor before the release template can run it:

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate3-xform --import
```

## Files

- `project.godot`: gate 3's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the `[debug]` warning-to-error
  keys, autoload `GrcLoader`) plus `gui/common/snap_controls_to_pixels=false`, so `SR`'s fractional
  position reaches the engine unrounded (`scene/gui/control.cpp:720-723`).
- `loader.gd`: gate 3's loader.
- `gate3x.tscn`: a root `Node` (not a `CanvasItem`) with `gate3x.gd`.
- `gate3x.gd`: builds every item in `_ready()` in `expected.json` `creation_order` (wire ids
  1..18), four groups and the `Marker`:

  | Group     | Items                                                                                                             | Region             |
  | --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
  | `rot`     | `RP` (`Node2D`, 30°) > `RQ` (clip, pivot at its centre) > `RQF` (covers `RQ`'s bounding box), `RQI`               | `[64,64,128,112]`  |
  | `rotnest` | `OA` (clip, axis-aligned) > `RP2` (`Node2D`, 20°) > `RQ2` (clip) > `RQ2F`                                         | `[224,56,112,112]` |
  | `half`    | `SP` (`Node2D`, scale 1.5) > `SQ` (clip, a half-pixel box) > `SQF`, `SR` (clip, a 0.75 px sliver) > `SRF`         | `[352,32,80,72]`   |
  | `flip`    | `FP` (`Node2D`, scale (−1, 1)) > `FQ` (clip) > `FQF`, `FQI`                                                       | `[440,200,160,64]` |

  `RS_FIXTURE_VARIANT` is refused (exit 2). All output lines start with `[fixture]`.

- `make_expected.py`: writes `expected.json` (`--check` compares values). It models the engine's
  transforms, RS calls, cull and scissor from the source over the fixture's own parameters (its
  docstring cites the lines), paints every step by pixel-centre coverage, and marks the band.
  It evaluates the three alternative clip models at the semantic probes, and asserts the
  contract's hand tables for the scissors and the semantic probes. It also asserts a rounding
  margin of at least 0.01 for every value that is not deliberately exact, that `RQF` and `RQ2F`
  cover their owner's bounding box, that no visible axis-aligned edge sits on a pixel centre,
  that no probe lies in the band, and the decisive-coverage rule. Nothing in it is measured.
- `expected.json` (`render-stream-gate3-expected/1`, `fixture: "gate3-xform"`, gate3-design.md
  Q6c/Q6d) holds the following. Per step: the draws in paint order (`rect_px` when axis-aligned,
  else `quad`, the four transformed corners) with each one's integer scissor, every owner's
  scissor (`clip_rects`), the band's size, the probes and the retained-state invariants. Across
  the run: the contract's hand table, the two listed non-decisive edges (`OA.left`/`OA.right`,
  whose pairs `RQ2` names), the six `semantic_probes` with every model's colour and the hand
  table's, and the predictions for `sabotage-xform-perturb` and
  `sabotage-xform-receiver-ignore-clip`.

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1. Step _k_ ≥ 1 is applied at `S + N·k` and
settles at `S + N·k + 7`. The fixture quits at `S + N·4 + 11` (52) unless
`RS_FIXTURE_QUIT_FRAME` asks for later. Every step recolours the `Marker`.

| step | change                                       | redraws (`content_version` bumps) | scissors that change                                 |
| ---- | -------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| 0    | initial                                      | all                               | `RQ` `[83,83,172,158)`, `RQ2` `[232,79,328,145)`, …  |
| 1    | `RP.rotation_degrees = 60`                   | none                              | `RQ` `[91,75,166,164)`                               |
| 2    | `RP.rotation_degrees = 30`; `RQ.scale = 1.25` | `RQ` (clear, custom rect, clip)   | `RQ` `[72,73,184,166)`                               |
| 3    | `SP.scale = (2, 2)`                          | none                              | `SQ` `[374,54,416,84)`, `SR` `[414,58,415,74)`       |
| 4    | `FP.scale = (1, 1)`                          | none                              | `FQ` `[528,208,592,256)`                             |

## Environment

| Variable                 | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `RS_FIXTURE_STEP_LOG`    | absolute path: one JSONL line per step at its applied frame        |
| `RS_FIXTURE_SHOT_DIR`    | absolute dir: `step-<k>.png` at each settle frame (rendered runs) |
| `RS_FIXTURE_START_FRAME` | `S` ≥ 1, default 1                                                 |
| `RS_FIXTURE_STEP_FRAMES` | `N` ≥ 8, default 10                                                |
| `RS_FIXTURE_QUIT_FRAME`  | ≥ the default `S + N·4 + 11`                                       |
| `RS_FIXTURE_VARIANT`     | refused (exit 2)                                                   |
