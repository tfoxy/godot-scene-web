# Gate 8 material fixture

Pre-arm materials and shaders (G8m,
[`../../protocol/gate8-design.md`](../../protocol/gate8-design.md) "Q5. Pre-arm materials and
shaders", D11, D12). One scene, `mat.tscn`, run two ways by gate8-adopt's loader autoload (copied
unchanged): `late` (the default main scene, built before the capture arms at fixture frame K) and
`born` (`res://born.tscn` instantiates the same scene in `_ready`, after the loader armed the
capture in `_enter_tree`). Every shader is synthetic and written for this fixture. Like the other
gate fixtures, the project does not know about the capture library and runs the same whether
`GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate8-mat --import
```

## Files

- `project.godot`, `loader.gd`, `born.gd`, `born.tscn`, `box.gd`: gate8-adopt's settings, loader,
  born wrapper and custom-drawn rect (640×360, stretch `disabled`, Compatibility).
- `mat.tscn`, `mat.gd`: a root `Node2D`; `_ready()` makes every material and item (the timeline is
  in `mat.gd`'s header). Variables: `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`,
  `RS_FIXTURE_MATERIAL_LOG` (gate 5.5's oracle, reference legs only: refused with exit 2 when
  `GRC_EXTENSION` is set), `RS_FIXTURE_QUIT_FRAME`, and the loader's `RS_FIXTURE_ARM` /
  `RS_FIXTURE_ARM_FRAME`. Output lines start with `[fixture]`.
- `shaders/main.gdshader` (`#include "res://inc/tint.gdshaderinc"`, a texture uniform, an instance
  uniform), `shaders/rel.gdshader` (`#include "rel_tint.gdshaderinc"`, relative to its own path),
  `shaders/spare.gdshader` (a default texture set before arm), `inc/tint.gdshaderinc`,
  `shaders/rel_tint.gdshaderinc`.
- `material_oracle.gd`: a symlink to `../gate55-shader/material_oracle.gd`, gate 5.5's oracle,
  reused unchanged (`render-stream-gate55-materials/1`: the GRP1 hash of `shader_get_code` per
  fixture Shader, `material_get_param` per material, `canvas_item_get_instance_shader_parameter` per
  item).
- `expected.json` (`render-stream-gate8-mat-expected/1`): hand-derived, not measured.

## Layout (640×360; boxes 48×40 at their position)

| item | at | material | before arm | after arm |
| ---- | -- | -------- | ---------- | --------- |
| `A`  | (32,32)   | `MA`: ShaderMaterial on main, `pal` = PAL, `tint` | `tint` changes at frame 5 | `tint` changes at K+14 |
| `I`  | (96,32)   | `MA` | instance `inst` set | `inst` changes at K+14 |
| `R`  | (160,32)  | `MR`: ShaderMaterial on rel, `tint` | | |
| `C`  | (224,32)  | `MC`: CanvasItemMaterial, blend add | the add mode is first used | |
| `N1` | (32,128)  | `MP`: ShaderMaterial on main, `pal` = PAL2 (made before arm, on no item) | | added at K+4 |
| `N2` | (96,128)  | `MN`: a new ShaderMaterial on spare (its default texture PAL2) | spare's RID made | added at K+4; `tint` changes at K+14 |
| `N3` | (160,128) | `M3`: a new CanvasItemMaterial, blend mul | the mul mode is built (a material in a field) | added at K+4 |
| `N4` | (224,128) | `M4`: a new CanvasItemMaterial, blend add | | added at K+4 |

Checkpoints settle at K+2, K+11 and K+21 (K = 12); the fixture quits at K+24.

## Expected

`items` and `materials` name each material's item, shader (or CanvasItemMaterial mode) and the
origin its shader has in a late capture. `account` is what the late capture's
`stream.gate8.adopt_stats.material_adoption` holds: MA, MR and MC adopted at arm (through A/I, R and
C), MP lazily (through N1); five shaders (main, rel, MC's add template at arm; spare and the mul
template at the K+4 frame boundary) of which two are templates; three lazily resolved material
shaders (MN on spare, M3 on mul, M4 on add, which re-keys MC's template, so C and N4 share one
entry: `shared_shader`); spare's one default texture; I's one instance parameter (A's `inst` is
never set: it reads back its default and stays off the wire, `instance`); 8 parameters (MA 2, MR 1,
MC 3, MP 2). `textures` are the two ImageTextures as RGBA8, `include_refused` the item the
`no-include-path` fault types `shader-adopt-include` and its screen rect.
