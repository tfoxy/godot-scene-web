# Gate 6 combined scene

The 640×360 combined scene of gate 6 (G6a, [`../../protocol/gate6-design.md`](../../protocol/gate6-design.md)
"Q6a" to "Q6h"): native Controls, a clipped `ScrollContainer` that scrolls, a `Label` and a
scrolling `RichTextLabel` with an inline image, a custom `_draw`, a texture that changes and is then
freed, a mesh deformed every frame, a `CanvasItemMaterial`, a `ShaderMaterial` whose parameter an
`AnimationPlayer` drives, a `Tween`, a `top_level` escape and a HUD `CanvasLayer`, over twelve
frame-indexed steps. Every texture is generated, every shader synthetic, and the only font is the
engine's embedded default theme font. Like the earlier fixtures, the project does not know about the
capture library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate6-scene --import
python3 experiments/render-stream/fixtures/gate6-scene/make_expected.py --check
```

## Files

- `project.godot`, `loader.gd`: gate 5.5's settings and loader, gate 4's font settings (grayscale
  antialiasing, light hinting, no subpixel positioning, no MSDF, no mipmaps) and
  `application/run/low_processor_mode_sleep_usec=0` (Q1g).
- `gate6_scene.tscn`, `gate6_scene.gd`: a plain root `Node`. `_ready()` builds one copy of the scene
  (cell 0, phase 0) and `_process()` drives the timeline, the shots, the step log and the oracle.
  Variables: `RS_FIXTURE_VARIANT` (`animate`, `refused`), `RS_FIXTURE_TIME` (`steps`, `realtime`),
  `RS_FIXTURE_TIMELINE` (`file`, `live`, `rate`, `soak`), `RS_FIXTURE_START_FRAME`,
  `RS_FIXTURE_STEP_FRAMES`, `RS_FIXTURE_QUIT_FRAME`, `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`
  (`step-<k>.png` at each settle frame, `frame-<f>.png` at each extra frame), `RS_FIXTURE_SHOT_FRAMES`
  (extra frames; the file timeline always adds 13, 53 and 93) and `RS_FIXTURE_ORACLE_LOG` (refused,
  exit 2, when a `GRC_*` capture variable is set). G6c adds `RS_FIXTURE_QUIT_TIME` (rate and soak
  only: a later quit, in seconds of game time) and `RS_FIXTURE_FREEZE_STATE` (a JSON array of one
  `freeze_state()` object, applied right after step 11); rate and soak step logs carry step 11's
  `freeze` leftovers (SC's scroll, LB's text, CD's k: what the freeze does not reset, and what a
  realtime host's wall clock decides), so a reference can render a realtime host's exact final
  state. Output lines start with `[fixture]`.
- `scene_builder.gd`: the scene under one top-level `Scene` Control, parameterized by origin, cell
  index c (TEXA content offset 100c, HUD layer 1 + c) and phase φ (frames) for G6h's `gate6-hd`. It
  owns the step table (`apply_step`), the per-frame animation (`on_frame`) and the generators of
  `TEXN`, `TEXA(n)` and `MS`'s vertices.
- `scene_oracle.gd` (`render-stream-gate6-oracle/1`): at each settle frame's `frame_post_draw` of a
  rendered reference, the atlas pages of every font the scene uses (render-stream-texture/1
  SHA-256s), the viewport's oversampling, SC's scroll and content position, the HUD layer, SM's
  shader hash and parameters, CM's blend mode, PB's value, the RichTextLabel's line offsets and
  scroll, and the LineEdit's selection and caret rects re-derived from the TextServer.
- `shaders/phase_tint.gdshader` (SM), `shaders/refused/time.gdshader` (the refused variant's
  `TIME`): `fragment()` last in each, no comments (make_expected.py ports the preprocessor without
  a comment remover).
- `make_expected.py` writes `expected.json` (`render-stream-gate6-expected/1`); `--check` compares.
  It imports gate 5's lowering, gate 5g's `StyleBoxFlat` port and gate 5.5c's preprocessor, and
  models every shot's decided pixels, the undecided boxes (text, RT, RF), freshness, the scroll
  table, the oracle's view, the hook-log census with predicted GRT1 and GRP1 hashes, and every g6a
  sabotage's (shot, region) set. Nothing in it is measured except the three named metrics of the
  default font (`measured`), which the oracle and the reference check.

## Layout (640×360; regions `[x0,y0,x1,y1)`, moved by (8, 4) at steps 10 and 11)

| Region   | Item(s) (position, size)                                                                    | Model |
| -------- | -------------------------------------------------------------------------------------------- | ----- |
| `SC`     | `ScrollContainer` (8,8) 168×112, rows of a 24×20 rect and a 14 px "row r" Label, separation 4 | rects exact inside the scissor; labels undecided; the VScrollBar's two theme boxes |
| `RT`     | `RichTextLabel` (184,8) 200×112, nine lines, line 2 `TEXA` as a 64×64 inline image          | undecided |
| `TR`     | `TextureRect` (392,8) 64×64, `TEXA`, `TEXB` from step 8                                      | exact (nearest texels) |
| `NP`     | `NinePatchRect` (464,8) 96×64, `TEXN`, margins 4                                             | exact |
| `Marker` | 32×32 rect (592,16)                                                                          | exact |
| `HU`     | `ZH` (400,84) 112×32, z 100; `HUD` `CanvasLayer` with a `Panel` (456,88) 168×28 and a Label  | exact, the label undecided; not compared receiver against reference before G6b |
| `PB`     | `ProgressBar` (8,128) 168×24, 12 px percentage, value from the `Tween`                       | theme boxes; text undecided |
| `BT`     | `Button` (8,160) 120×32, "Play", "Pause" from step 6                                         | theme box; text undecided |
| `LE`     | `LineEdit` (8,200) 168×32, "edit me", focused, forced caret, `select(0,4)`, `(2,7)` from 7  | normal and focus boxes; content box undecided; the selection and caret rects are checked on the wire against the oracle |
| `CD`     | `Control` (184,128) 120×104 with `_draw()`                                                    | gate 5 lowering |
| `MS`     | `MeshInstance2D` (312,128), a 2×8-vertex strip, region-updated every frame                   | formula, per-vertex colours |
| `SM`     | `ColorRect` (424,128) 64×48, `ShaderMaterial` `phase_tint`                                    | shader twin |
| `CM`     | `ColorRect`s (496,128) 48×40 and (512,144) 48×32, the second with a `CanvasItemMaterial`     | blend model (add, sub from step 4) |
| `HB`     | `HBoxContainer` (8,248) 400×48 (496 from step 7) of three `Panel`s                           | StyleBoxFlat port, AA ring band |
| `AN`     | `Sprite2D` `TEXN` ×2, moved by an `AnimationPlayer`, period 88                               | exact (edges a quarter pixel off the centres) |
| `LB`     | `Label` (8,304) 320×32                                                                       | undecided |
| `TL`     | `ColorRect` 16×16 (600,344), `top_level`, child of row 3                                     | exact |
| `RF`     | `refused` only: `CPUParticles2D`, `PointLight2D`, a `TIME` shader, an LCD Label             | undecided, excluded |

## Timeline (file: S = 1, N = 10, settle +7, intermediate shots 13, 53, 93)

0 initial; 1 `SC.v_scroll` 40; 2 `LB` text; 3 `TEXA` → `TEXA(1)`; 4 SM tint, CM add → sub; 5 RT
scrolled to line 4, `SC.v_scroll` 76; 6 CD `k` 1, BT text; 7 HB width 496, LE `select(2,7)`; 8 TR →
`TEXB`, HUD hidden; 9 row 2 freed, row 8 appended, RT text without the image (`TEXA` freed), HUD
visible at layer −1; 10 HUD layer 1, root canvas transform (8, 4); 11 freeze. Continuous: MS every
frame, SM's phase (a key every 4 frames, period 24), AN (period 88), PB (0 → 100 over 300 frames).
`live`: S = 300, N = 60, quit 1080. `rate` and `soak` run on game time (Q6c).

## Time (D6, as built)

Every animation is driven a quarter frame off the frame grid: both `AnimationPlayer`s are seeked to
(φ + ¼)/60 s and advanced by 1/60 s per frame, the `Tween` is paused and custom-stepped by the same
amounts, so at fixture frame f each reads its value at (f + φ + ¼)/60 s. Every key time, loop
boundary and rounding threshold is then at least a quarter frame away from any sample, and float
accumulation cannot pick the neighbouring value: SM's phase is ⌊(f mod 24)/4⌋, AN's x is
512 + ((f + ¼) mod 88) (its edges a quarter pixel off the pixel centres, so decided), and PB's
value is (f + ¼)/3 snapped to `ProgressBar`'s step 0.01.
