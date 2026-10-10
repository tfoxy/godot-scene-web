# Gate 5.5 CanvasItemMaterial fixture

The reference rendering for gate 5.5's `CanvasItemMaterial` (G55b,
[`../../protocol/gate5_5-design.md`](../../protocol/gate5_5-design.md) "Q6b" and "Q6d"). Ten steps
(0..9) cover the six blend modes over two backgrounds each (`mix`, `add`, `sub`, `mul`,
`premul_alpha` and the unbound `disabled`), the three light modes (`normal`, `unshaded`,
`light_only`), mode changes that free and recreate engine shaders, a material removed and
recreated on an item, `use_parent_material`, an overlay moved and a canvas transform. Variant
`modulate` adds a `CanvasModulate` on the root canvas, the only state that makes light modes
visible without lights. Like every other fixture, the project does not know about the capture
library and runs the same whether `GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate55-cim --import
```

## Files

- `project.godot`: gate 5's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the `[debug]` warning-to-error
  keys, autoload `GrcLoader`).
- `loader.gd`: gate 5's loader.
- `gate55_cim.tscn`, `gate55_cim.gd`: a root `Node`. `_ready()` makes every item in
  `expected.json` `creation_order` (wire ids in that order), then one `CanvasItemMaterial` per
  material item, and `_process()` applies the timeline. `RS_FIXTURE_VARIANT` is unset or
  `modulate`; anything else exits 2. All output lines start with `[fixture]`.
- `rects.gd`: the one region node class: filled rects from `_draw`. Only the marker redraws after
  step 0.
- `make_expected.py`: writes `expected.json` (`--check` compares values). Its docstring cites the
  source of every rule: `CimSim` (cim.cpp's shader cache, dirty list and destructor, emitting every
  RenderingServer call with ids), the effective material, the light-mode and canvas-modulate
  fragment rule, GL's blend equations and the RGB10_A2 target. It asserts the hand census per
  step, Q6b's freshness rows, the marker rules, the light-mode visibility and Q6b's sabotage sets.
  Nothing in it is measured.
- `expected.json` (`render-stream-gate55-expected/1`). Shared: `regions`, `target_alpha_bits`,
  `op_lists` (each rect as a mesh with its fragment colour and `blend`), `hook_census` per variant,
  `typed_ops`, `hooked_before_calibrator8`, `calibrator8_ops` and `predictions` (G55d's sabotage
  sets). Per variant (`base`, `modulate`) and step: frames, marker colours (as drawn and as shown),
  canvas transform and modulate, `redraws`, `calls` (every `add_rect`), `items`, `fresh`,
  `material_calls` (fixture calls with exact values), `rs_material_calls` (CimSim's calls with
  ids), `census`, `builtin`, `effective`, `typed_entries` and `probes` (one pixel per rect cell of
  each fresh region, `[x, y, r, g, b, a, delta]`).

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Region   | Items (origin)                     | Content (local)                                                                                                        |
| -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `BM`…`BD` | `U_<r>`, `O_<r>` (16 + 88k, 16)   | `U` rect (8,8,56,48) in (.4,.6,.2); `O` (its CIM's blend mode) opaque (24,16,48,24) and `.6` strip (24,44,48,16) in (.4,.2,.6), both overhanging `U` onto the background |
| `LN`…`LO` | `LN`, `LM`, `LU`, `LO` (16 + 88k, 112) | rect (16,16,56,48) in (.6,.4,1): no material, `mix`/`normal`, `unshaded`, `light_only`                         |
| `UP`     | `UB`, `UP` (16,208), `UC` (UP's child) | `UB` (8,8,120,48) in (.4,.4,.4); `UP` (CIM `add`) (8,24,60,48) and `UC` (no material) (68,24,60,48) in (.2,.2,.2), overhanging `UB` |
| `RC`     | `RB`, `RI` (168,208)               | `RB` (8,8,56,48) in (.4,.4,.4); `RI` (CIM `sub`) (24,24,56,40) in (.2,.2,.2), overhanging                                 |
| `Marker` | `Marker` (592,16)                  | 32×32 rect in G55b's marker colour of the step                                                                         |
| —        | `CM` (variant `modulate`)          | the `CanvasModulate`, created last: (1,1,0) at 0, (0,1,1) at 2, hidden at 8                                             |

Timeline: 1 `BD` → `mix`; 2 `LO` → `normal`; 3 `LU` → `light_only`; 4 `RI.material = null`;
5 `RI.material` = a new CIM `add`; 6 `UC.use_parent_material = true`; 7 `O_BA` moves by (4,0);
8 `UP` → `sub`; 9 canvas transform (8,4).
