# Gate 8 CanvasTexture fixture (`gate8-ct`, P3-CT)

The fixture for images drawn **only** through a `CanvasTexture`'s diffuse channel
([`../../protocol/gate8-design.md`](../../protocol/gate8-design.md) "As built (P3-CT)"). spine-godot
draws its atlas pages that way: an `add_mesh` whose texture is a `CanvasTexture`, the page itself
named by no command. Before P3-CT both receivers kept such a diffuse non-resident (their lazy
residency only counted textures a command, an instance parameter or a material names), so every
spine drew as a white silhouette (C3, `results/p3/fidelity.md` gap 2). The scene does not know about
the capture.

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `ct.tscn`.
- `loader.gd`: loads the capture GDExtension in `_enter_tree` when `GRC_EXTENSION` is set (an arm at
  birth); unarmed otherwise (the `reference` leg).
- `ct.tscn` / `ct.gd`: a plain `Node` that builds every texture and item in `_ready`, after the arm.
- `expected.json`: the hand-derived regions, counts and checkpoints the checker reads.

## Scene

Eight 64x64 cells. Every image is a 16x16 opaque RGBA8 pattern of 4x4-texel blocks, distinct per
image, with every channel in 10..239 (never white). Nearest sampling at integer scales: no pixel
centre falls on a texel boundary.

| Cell | Position | Draw | Through |
| ---- | -------- | ---- | ------- |
| `MESH` | (40,40) | `MeshInstance2D`, an `ArrayMesh` quad (`add_mesh`) | CT_A; the diffuse created first |
| `POLY` | (136,40) | `Polygon2D` (its own mesh, `add_mesh`) | CT_B; the diffuse created after CT_B (higher wire id) |
| `RECT` | (232,40) | `Sprite2D`, region 32x32 at scale 2 | CT_C, nearest and repeat-enabled, over the item's linear and repeat-disabled |
| `TRECT` | (328,40) | `TextureRect` (`add_texture_rect`) | CT_D |
| `SWAP` | (40,136) | `Sprite2D` at scale 4 | CT_E; step 1 sets a new diffuse |
| `UPD` | (136,136) | `Sprite2D` at scale 4 | CT_F; step 1 updates its diffuse in place |
| `NORM` | (232,136) | `Sprite2D` at scale 4 | CT_G with a normal map: `canvas-texture-channel` |
| `SPEC` | (328,136) | `Sprite2D` at scale 4 | CT_H with a specular map: `canvas-texture-channel` |

## Timeline

| frame | |
| ----- | - |
| 1 | checkpoint 0 (the scene `_ready` built); settles at 4 |
| 10 | step 1: SWAP's new diffuse, UPD's update; checkpoint 1 settles at 17 |
| 25 | quit |

The capture must run on a rendered host: a headless host's dummy storage allocates no canvas
texture (`../../protocol/canvas-texture-headless.md`). The reference is this project run unarmed in
the same private 640x360 gamescope.
