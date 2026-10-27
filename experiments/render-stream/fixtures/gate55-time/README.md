# Gate 5.5 TIME and sampler-default fixture (P3-TM)

`canvas_item` `ShaderMaterial`s that read `TIME`, and samplers left unset under each default hint.
A receiver has to draw `TIME` as the host's shader time, which a render-stream/10 capture carries
per transaction, and bind Godot 4.5.1's GLES3 default texture for an unset sampler's hint.
([`../../protocol/gate5_5-design.md`](../../protocol/gate5_5-design.md) "TIME and sampler defaults
(P3-TM)", [`../../protocol/render-stream-10.md`](../../protocol/render-stream-10.md) "Shader
time".)

Five steps (0..4, S=1, N=10, settle +7, quit at frame 52). Run the capture host and the rendered
reference with `--fixed-fps 60`: every frame's step is then 1/60, so `TIME` at frame F is the same
F steps summed on both. Every shader is synthetic and written for this fixture. The project does
not know about the capture library.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate55-time --import
```

## Files

- `project.godot`, `loader.gd`: gate 5.5's settings (640x360, `gl_compatibility`, clear colour
  (.2,.2,.4)) and loader.
- `gate55_time.tscn`, `gate55_time.gd`: a root `Node`; `_ready()` makes everything, `_process()`
  applies the timeline. Variables: `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`,
  `RS_FIXTURE_START_FRAME`, `RS_FIXTURE_STEP_FRAMES`, `RS_FIXTURE_QUIT_FRAME`, `RS_FIXTURE_VARIANT`.
- `shaders/`: one per item below (`default_*.gdshader` for the sampler row).

## Scene

| Item | Draw | Shader | What it proves |
| ---- | ---- | ------ | -------------- |
| TP | rect (16,16,96,96) | `pulse` | a sine pulse in `TIME`, read through a helper function |
| TS | rect (128,16,96,96) | `scroll` | UV scrolling with `TIME` over a repeating, linearly filtered texture |
| TV | rect (240,16,32,32) | `shift` | `TIME` in `vertex()`: `floor(TIME*30+0.25)` whole pixels down |
| D0 | rect (16,160,48,48) | `default_plain` | an unset sampler without a hint: white |
| DW | rect (80,160,48,48) | `default_white` | `hint_default_white`: white |
| DB | rect (144,160,48,48) | `default_black` | `hint_default_black`: (0,0,0,1) |
| DT | rect (208,160,48,48) | `default_transparent` | `hint_default_transparent`: (0,0,0,0) |
| DN | rect (272,160,48,48) | `default_normal` | `hint_normal`: (0.5,0.5,1,1) as RGBA8 (127,127,255,255) |
| DR | rect (336,160,48,48) | `default_roughness_normal` | `hint_roughness_normal`: the normal texture too |
| DA | rect (400,160,48,48) | `default_anisotropy` | `hint_anisotropy`: (1,0.5,1,1) as (255,127,255,255) |
| DS | rect (464,160,48,48) | `default_black` | the same hint with a texture set (step 2), then cleared (step 3) |
| TH | texture rect (16,240,256,16) | `half_band` | P3-CK: `fract(COLOR.a*32 + TIME/2)` over a 256x1 RGBAH alpha ramp (0.25 + i/512), nearest, 1:1: half-float sampling that RGBA8 cannot reproduce |
| TC | rect (288,240,32,16) | `clock` | P3-CK, `stall` variant only: `floor(TIME*1024)` as RGB bytes (r = v>>16, g = v>>8, b = v, each & 255) |

The sampler shaders draw `(t.r, t.g/2 + t.a/2, t.b)` of their texel `t`, so every default,
transparent included, is a distinct opaque colour.

Steps: 1 sets TP's `tint`, 2 sets DS's texture (a 4x4 (200,100,50)), 3 clears it, 4 changes nothing
(`TIME` alone moves).

**Variant `stall`** (`RS_FIXTURE_VARIANT=stall`, P3-CK): adds TC and stalls the main loop for 300 ms
(`OS.delay_msec`) in `_process` at frames 12, 22, 32 and 42, printing `[fixture] stall frame=..
ms=300 next_frame=.. next_delta=..` with the next iteration's tree delta. Run it in real time (no
`--fixed-fps`: a fixed rate disables the physics clamp the stall exercises), rendered, with the
capture armed in the same process, so its own settle shots are the reference for the host's TIME.
The capture needs `RGBAH` in `GRC_RESOURCE_FORMATS` for TH.

`scripts/lib/gate55t-checks.ts` holds the hand model and the checks; `scripts/run-gate55.sh --legs
g55t` runs the legs.
