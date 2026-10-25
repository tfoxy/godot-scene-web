# Gate 5.5 vertex() fixture (P3-VX)

`canvas_item` `ShaderMaterial`s with a `vertex()` function or a vertex render mode. A receiver has
to run Godot 4.5.1's canvas.glsl vertex stage in its order: `COLOR` is the vertex colour times the
modulate before `vertex()`; the model, canvas and screen transforms come around the code as the
render modes say; and varyings are interpolated unless `flat`.
([`../../protocol/gate5_5-design.md`](../../protocol/gate5_5-design.md) "vertex() (P3-VX)".)

Five steps (0..4, S=1, N=10, settle +7, quit at frame 52). Every shader is synthetic and written for
this fixture; `hsv.gdshader` has the shape of STS2's settings-gear shader. The project does not
know about the capture library.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate55-vertex --import
```

## Files

- `project.godot`, `loader.gd`: gate 5.5's settings (640x360, `gl_compatibility`, clear colour
  (.2,.2,.4)) and loader.
- `gate55_vertex.tscn`, `gate55_vertex.gd`: a root `Node`; `_ready()` makes everything, `_process()`
  applies the timeline. Variables: `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`,
  `RS_FIXTURE_START_FRAME`, `RS_FIXTURE_STEP_FRAMES`, `RS_FIXTURE_QUIT_FRAME`.
- `shaders/`: one per item below.

## Scene

| Item | Canvas | Draw | Shader | What it proves |
| ---- | ------ | ---- | ------ | -------------- |
| VH | 0 | 32x32 texture at 3x, (16,16), modulate (1,.8,.6) | `hsv` | COLOR (modulate folded in) copied into a varying and multiplied back in after the HSV arithmetic |
| VP | 0 | four-colour polygon, (128,16,96,96) | `vary_color` | per-vertex COLOR through a smooth varying |
| VD | 0 | rect on a 2x node at (240,16) | `displace` | VERTEX displaced before the model transform (sloped top and bottom edges) |
| VU | 0 | texture rect, (336,16,96,96) | `uv_flip` | UV transposed and flipped in `vertex()` |
| VF | 0 | rect, (448,16,64,64) | `flat` | `flat` vec4 and int varyings take each triangle's provoking vertex (GLES3's indexed quad `{0,2,1,3,2,0}`) |
| VS1 | 0 | rect (16,128,32,32) on a node at (300,200) | `skip_plain` | `skip_vertex_transform` without `vertex()`: never moved |
| VS2 | 0 | rect (0,128,32,32) on a node at (64,0) | `skip_model` | `skip_vertex_transform`, MODEL_MATRIX applied by the code, +8 down |
| VW | 0 | rect on a 2x node at (112,128) | `world` | `world_vertex_coords`: +8 canvas pixels, not 8 local units |
| VT | 0 | texture rect at (176,128) | `builtins` | TEXTURE_PIXEL_SIZE (both stages), AT_LIGHT_PASS, INSTANCE_CUSTOM |
| VM | 0 | rect (224,128,96,64) | `screen_matrix` | SCREEN_MATRIX · CANVAS_MATRIX · MODEL_MATRIX through a varying |
| VC | 1 (`CanvasLayer`, offset (400,120), scale 2) | rect on a node at (8,8) | `canvas_skip` | CANVAS_MATRIX apart from MODEL_MATRIX |
| VLD | 1 | rect on a node at (40,8) | `layer_shift` | VERTEX displaced before both transforms |

Steps: 1 sets VH's `s`, 2 moves VD by (8,4), 3 moves the layer to (408,124) (a new CANVAS_MATRIX),
4 sets VP's modulate (folded into COLOR before `vertex()`).

`scripts/lib/gate55v-checks.ts` holds the hand model (every item but VH's and VP's arithmetic, VD's
edges and VF's diagonal) and the checks; `scripts/run-gate55.sh --legs g55v` runs the legs.
