# Gate 5.5 ShaderMaterial fixture

The reference rendering for gate 5.5's `ShaderMaterial`s (G55c,
[`../../protocol/gate5_5-design.md`](../../protocol/gate5_5-design.md) "Q6c" and "Q6e"). Ten steps
(0..9) cover live parameters (`content_version` unchanged), an instance parameter on a shared
material, a code change through an include, a parameter erased, a material recreated, a texture
parameter over a shader's default texture, bool, int and float-array parameters, a parameter
written on every frame, and a shader replaced and freed. Variant `refused` adds a `TIME`, a screen
texture, an SDF, a global-uniform and a `shader_type spatial` material. Every shader is synthetic
and written for this fixture. Like the gate 0 to 5 fixtures, the project does not know about the
capture library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate55-shader --import
```

## Files

- `project.godot`, `loader.gd`: gate 5's settings and loader, plus `shader_globals/g_tint`
  (`vec4 (.6,.2,.4,1)`) for the refused variant's global uniform.
- `gate55_shader.tscn`, `gate55_shader.gd`: a root `Node`. `_ready()` makes `TEX16`, `TEX16B`,
  then every shader, material and item in `expected.json`'s `shader_order`, `material_order` and
  `creation_order`; `_process()` writes `PH`'s `phase` on every frame and applies the timeline.
  Variables: `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`, `RS_FIXTURE_MATERIAL_LOG` (the oracle,
  refused with exit 2 when a `GRC_*` capture variable is set), `RS_FIXTURE_START_FRAME`,
  `RS_FIXTURE_STEP_FRAMES`, `RS_FIXTURE_QUIT_FRAME`, `RS_FIXTURE_VARIANT` (`refused` only; the
  `policy-params` and `policy-exclude` variants are capture settings, `GRC_SHADER_POLICY`, not scene
  changes). Output lines start with `[fixture]`.
- `shaders/*.gdshader`, `shaders/refused/*.gdshader`, `inc/common.gdshaderinc`: the synthetic
  shaders, `fragment()` last in each (for Q3c's `perturb-shader`). `tint_b.gdshader` is never
  loaded as a resource: step 3 assigns its text to the `tint` `Shader`'s `code`.
- `material_oracle.gd` (`render-stream-gate55-materials/1`): at each settle frame, per fixture
  shader its status and the GRP1 SHA-256 and size of `RenderingServer.shader_get_code`, per
  material the type and value of `material_get_param` for its declared names, per instanced item
  `canvas_item_get_instance_shader_parameter`. It also writes each code it reads as a GRP1 file under
  `shader-library/sha256/` next to its log, the library G55e's `params` leg uses.
- `make_expected.py` writes `expected.json` (`render-stream-gate55-expected/1`); `--check`
  compares. It models the fixture's calls with exact Variant values, a port of the shader
  preprocessor (so every GRP1 hash), a Python twin of every `fragment()`, the coverage model
  `geometry-raster.ts` rasterizes, freshness, the oracle's view per step, a per-frame census of
  every shader and material call, `counters.json`'s counts, the refused variant and G55e's sabotage
  sets. Nothing in it is measured.

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Region   | Item(s) (position), material                    | Pixels                                                                                   |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `TI`     | 56×48 rect (32,32), `MT` on `tint`               | `grid(tint * gain)`: (.2,.4,.2); (.4,.2,0) at 1; `tint_b` (0,.2,.4) at 3; gain erased (0,.4,.8) at 4 |
| `PA`     | `draw_texture_rect(TEX16, (8,8,32,32))` (120,24), `MP` on `pal` | `texture(pal, UV) * mul`: `pal` unset, so the shader's default `TEX16`; `TEX16B` from 6 |
| `IN`     | 48×48 rects `I1` (208,32), `I2` (264,32), both `MI` on `inst` | `I1` (.2,.8,.4); `I2` the default white, (.8,.2,.6) from 2                           |
| `TY`     | 56×48 rect (344,32), `MY` on `types`             | `on` false: (f, iv.y·.2, 0) = (.6,.6,0); from 7 `on`, `k` 3: (v2.x, v3.y, lv[3]) = (.4,.8,.8) |
| `PH`     | 56×48 rect (432,32), `MPh` on `phase`            | `phase` = the frame: (p·.2, (5−p)·.2, .4) with p = phase mod 6                            |
| `RM`     | 56×48 rect (32,128), `MR` on `tint`              | (.8,.8,.2); `tint_b` (.2,.8,.8) at 3; `MR2` (`tint` (.2,.8,.8)) (.8,.8,.2) at 5          |
| `SH`     | 56×48 rect (120,128), `MS` on `sh_a`             | (.2,.8,.4); `sh_b` (.8,.2,.6) at 8                                                        |
| `Marker` | 32×32 rect (592,16)                              | gate 3's marker colour of the step                                                        |

Variant `refused` adds `TM` (`TIME`, (.2,.4,.6)), `SC` (screen texture: 1 − clear = (.8,.8,.6)),
`SD` (`texture_sdf`, (.4,.2,.8)), `GU` (`global uniform`, (.6,.2,.4)) at y 128 and x 208, 296,
384, 472, and `SP` (`shader_type spatial`, drawn as no material: its rect colour (.4,.6,.2)) at
(32,224). `TIME` and the SDF enter their colour as `0.0 * step(0.0, x)`, so the shader uses them
and the pixels stay exact. Step 9 sets the canvas transform to a translation by (8,4). Every region
is exact.
