# Gate 5 mesh fixture

The reference rendering for gate 5's persistent mutable meshes (G5c,
[`../../protocol/gate5-design.md`](../../protocol/gate5-design.md) "Q6d" and "Q6e"). Ten steps
(0..9) cover an `ArrayMesh` in a `MeshInstance2D` (redrawn on `changed`), a raw mesh drawn once
whose pixels then change through vertex, attribute and index region updates alone, a two-surface
mesh losing its first surface, a geoclip-like grid deformed every frame in spine-godot's order and
then recreated with another vertex count, a `Polygon2D` (its own mesh, cleared and re-added per
redraw), a loaded `ArrayMesh` resource (`mesh_create_from_surfaces`) and a freed mesh still named
by its item. Like the gate 0 to 5 fixtures, the project does not know about the capture library
and runs the same whether `GRC_EXTENSION` is set or not.

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate5-mesh --import
```

## Files

- `project.godot`, `loader.gd`: gate 5's settings and loader.
- `gate5_mesh.tscn`, `gate5_mesh.gd`: a root `Node`. `_ready()` makes `TEXG`, then every mesh and
  item in `expected.json` `mesh_order` and `creation_order`; `_process()` applies the timeline and
  runs `DF`'s per-frame draw path (frame 2 on). Variables: `RS_FIXTURE_STEP_LOG`,
  `RS_FIXTURE_SHOT_DIR`, `RS_FIXTURE_MESH_LOG` (the oracle, refused with exit 2 when a `GRC_*`
  capture variable is set), `RS_FIXTURE_START_FRAME`, `RS_FIXTURE_STEP_FRAMES`,
  `RS_FIXTURE_QUIT_FRAME`; `RS_FIXTURE_VARIANT` is refused. Output lines start with `[fixture]`.
- `mesh_oracle.gd` (`render-stream-gate5-meshes/1`): at each settle frame, per fixture mesh, its
  status, surface count, custom AABB and per surface the GRM1 SHA-256 of
  `RenderingServer.mesh_get_surface` (the GPU buffers read back). `Polygon2D`'s private mesh RID
  is derived from the RID allocator's scheme and verified against the polygon on every line.
- `make_expected.py` writes `expected.json` (`render-stream-gate5-mesh-expected/1`) and
  `ld_mesh.tres`; `--check` compares both. It models every surface's bytes (float32 positions,
  truncated RGBA8 colours, float32 UVs, u16 indices, the float32 AABB of
  `mesh_create_surface_data_from_arrays`, Godot's ear clipper for `Polygon2D`) and so predicts
  every GRM1 hash, the hook census of every mesh call per frame, each item's commands, the
  coverage model `geometry-raster.ts` rasterizes, freshness, the `counters.json` totals and G5e's
  sabotage sets. Nothing in it is measured.
- `ld_mesh.tres`: generated; the `ArrayMesh` resource `LD` loads.

## Layout (640×360; regions `[x0,y0,x1,y1)`)

| Region   | Item (position)                 | Mesh (local)                                                                                                       |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MI`     | `MeshInstance2D` (40,40)        | `AM1`: 64×48 quad, (1,.6,0), indexed; +8 px in x at 1; at 8 cleared and re-added as two unindexed triangles (.2,.6,1) |
| `RM`     | raw item (176,40), drawn once   | `RMS`: quad with a tie-free diagonal, (.2,.8,.4), dynamic; vertices at 2, colours (1,.2,.2) at 3, triangle 2 degenerate at 4 |
| `M2`     | raw item (288,40), drawn once   | white indexed square and an unindexed (.4,.4,1) triangle; surface 0 removed at 6                                   |
| `DF`     | raw item (400,40), every frame  | 9×5 grid over 128×64, UVs into `TEXG`, white ((.8,.8,1) from 3); column c moves by `W[(frame + c) mod 8]`; rebuilt 5×3 at 5 |
| `P2`     | `Polygon2D` (40,160)            | concave tie-free arrow (.6,.2,1); a longer one at 7                                                                |
| `LD`     | raw item (176,160), drawn once  | `ld_mesh.tres`: 48×40 quad (.8,.8,.2)                                                                               |
| `FR`     | raw item (288,160), drawn once  | `FM`: 56×48 quad (1,.4,.6); freed at 7 (draws nothing), the item cleared at 8                                     |
| `Marker` | `Node2D` (592,16)               | 32×32 rect in gate 3's marker colour of the step                                                                   |

Step 9 sets the canvas transform to a translation by (8,4). `DF` is band (D13); every other region
is exact.
