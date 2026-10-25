# Gate 5.5 screen-texture fixture (P3-ST)

Screen-reading `ShaderMaterial`s (`hint_screen_texture`) over nearest-filtered textures, so a
receiver has to take Godot 4.5.1's GLES3 back-buffer copies at the reference's points
([`../../protocol/gate5_5-design.md`](../../protocol/gate5_5-design.md) "Screen texture (P3-ST)").
Six steps (0..5, S=1, N=10, settle +7, quit at frame 62). Every shader is synthetic and written for
this fixture. The project does not know about the capture library.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate55-screen --import
```

## Files

- `project.godot`, `loader.gd`: gate 5.5's settings (640x360, `gl_compatibility`, clear colour
  (.2,.2,.4)) and loader.
- `gate55_screen.tscn`, `gate55_screen.gd`: a root `Node`; `_ready()` makes everything, `_process()`
  applies the timeline. Variables: `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`,
  `RS_FIXTURE_START_FRAME`, `RS_FIXTURE_STEP_FRAMES`, `RS_FIXTURE_QUIT_FRAME`.
- `shaders/`: `invert`, `swizzle`, `screen_uv` (SCREEN_UV itself), `blur` (`filter_linear_mipmap`,
  `textureLod` at `lod`, mixed toward a tint) and `time_screen` (a screen reader the capture refuses
  for `TIME`).

## Scene (draw order)

| Item | Canvas | Rect | What it proves |
| ---- | ------ | ---- | -------------- |
| T1, T2, T3 | 0 | 128x128 at (16,16), (176,16), (416,16) | 32x32 RGBA8 patterns at 4x, nearest |
| RA | 0 | (48,48,64,64) | invert: the first reader, so the automatic copy is taken before it |
| LC | 0 | (208,48,32,32) | a solid rect drawn after RA, entirely under RB |
| RB | 0 | (192,32,96,96) | swizzle: reuses RA's copy, so LC never shows |
| RF | 0 | (336,160,64,64) | SCREEN_UV in red and green (top-left origin), the copy's blue |
| RE | 0 | (432,32,96,96) | blur: builds the mip chain of the cached copy at its position |
| RT | 0 | (16,120,24,24) | refused (TIME): the reference inverts, every receiver drops the item |
| RC | 1 (`CanvasLayer`) | (64,96,96,64) | invert: a fresh copy holding canvas 0's outputs |
| RD | 1 | clip (176,100,64,64) | swizzle inside a clipping `Control`, larger than the clip |

Steps: 1 shifts T1's texture by 8 px, 2 moves LC (still under RB), 3 offsets the layer by (8,4),
4 sets RE's `mix_amount` .4 and `lod` 1, 5 swaps T2's texture.

`scripts/lib/gate55s-checks.ts` holds the hand model (every pixel but RE's, which is the engine's
mip chain) and the checks; `scripts/run-gate55.sh --legs g55s` runs the legs.
