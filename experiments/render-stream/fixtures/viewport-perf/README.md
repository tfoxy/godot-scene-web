# Viewport surface phone-cost fixture (`viewport-perf`, VS5)

The fixture behind the render-stream/16 viewport-surface phone measurement: a steady 1920x1080
scene whose surfaces either change every frame or never, so receivers that connect one after
another to one live host measure the same load. `run-gate7.sh --live --legs g7-dev` with
`G7V_LEGS=vp-draw-active,vp-draw-idle,vp-vfx6` runs it (lib/gate6c-legs.sh "VS5b"): one /16 host
per workload, arms A (the client's viewports on) and B (`viewports: false`) back to back on it.
Everything is synthetic: polygons, lines and a procedural falloff texture.

## Files

- `project.godot`: 1920x1080, stretch `disabled`, `gl_compatibility`, `msaa_2d=0`, `hdr_2d=false`,
  the `[debug]` warning-to-error keys, autoload `GrcLoader`, main scene `main.tscn`.
- `loader.gd`: loads `GRC_EXTENSION` in `_enter_tree` (a copy of `fixtures/gate7-pace/loader.gd`).
- `main.tscn` / `main.gd`: a plain `Node` that instantiates the chosen scene in `_ready`, after the
  capture armed, and adds the root heartbeat (a 48x48 square moving 4 px per 1/60 s), so the root
  changes on every host frame. It handles the environment below.
- `draw.tscn` / `draw.gd`: the drawing surface.
- `vfx6.tscn` / `vfx6.gd`: six effect surfaces.

## Scenes

| scene  | surfaces                                                                                                                                                                         | what moves                                                                                                                                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draw` | `MapDrawing` 960x1620, transparent, update `always`, shown 600x1012 by an expand `TextureRect` with a premultiplied-alpha `CanvasItemMaterial` through a scene `ViewportTexture` | three finished 300-point `Line2D` strokes and an eraser `Line2D` (`blend_sub` ShaderMaterial over a 32x32 radial falloff, tile mode). Phase `active`: `LiveStroke` gains a point every 1/60 s and restarts on a new curve every 300 points, so the surface re-renders every frame. Phase `idle`: `LiveStroke` is finished and the surface never changes |
| `vfx6` | `Doom` 687x687, `CardIntent` 256x256, `PlayerIntentA`/`B` 180x225 (`SubViewportContainer`s), `Epoch` 324x200 (opaque), `Enchant` 144x108; all update `always`                    | spinning, orbiting, bobbing, scrolling and Lissajous polygons, several with an additive material, on every frame                                                                                                                                                                                                                                        |

Every motion is a function of game time only.

## Environment

All optional; an invalid value prints an error and quits 2.

- `RS_FIXTURE_VP_SCENE`: `draw` (default) or `vfx6`.
- `RS_FIXTURE_VP_PHASE`: `draw` only, `active` (default) or `idle`.
- `RS_FIXTURE_QUIT_TIME`: seconds of game time to quit at, at least 1 (default 60).
- `RS_FIXTURE_QUIT_FILE`: absolute path; the fixture quits (exit 0) at the first check that finds
  it, every 30 frames. A sweep touches it after its last arm.
- `RS_FIXTURE_STEP_LOG`: absolute path; one JSON line at `ready` (scene, phase, viewport count) and
  one at `final`.
- `RS_FIXTURE_SHOT_DIR`: absolute directory; `step-1.png` of the root at frame 120 (rendered hosts
  only).
