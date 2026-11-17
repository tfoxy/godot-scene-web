# Gate 8 hint fixture (`hint-scene`, g8hint)

The fixture for gate 8's group `g8hint`: render-stream/15's resource hints and the texture size
override ([render-stream-15.md](../../protocol/render-stream-15.md)). One scene, `hint.tscn`, run by
the capture armed late (`GRC_ARM_DEFER_FRAMES=K-1`, `GRC_ADOPT=arm`), so its pre-arm textures reach
the late-arm warm pass and its armed ones the create path. The scene does not know about the capture.

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, nearest default filter,
  S3TC imports only (CPU encoders), autoload `GrcLoader`, main scene `hint.tscn`.
- `loader.gd`: loads the capture GDExtension from `GRC_EXTENSION` before the main scene (a copy of
  `gate8-tex`'s).
- `make_sources.gd`: writes `res://tex/edge_a.png` (30x18) and `res://tex/edge_b.png` (26x14) and
  their VRAM-compressed import settings (generated, gitignored; the editor's `--import` encodes them).
- `hint.tscn` / `hint.gd`: the scene and its timeline (below).
- `expected.json`: the hand-derived names, paths, counts and pixel budgets the checker reads.

## Timeline

K is `RS_FIXTURE_ARM_FRAME` (default 10). A step settles 7 frames after it is applied.

| frame |                                                                                                     |
| ----- | --------------------------------------------------------------------------------------------------- |
| 1     | pre-arm, undrawn: `p1`..`p4` (96x96 RGBA8 ImageTextures with `res://hint/<n>.tres` paths), `edge_a` |
| 3     | `p2.update()`: its content is no longer the one created with its path                               |
| K     | the capture arms; step 0 settles at K+2                                                             |
| K+5   | armed, undrawn: `a1`, `a3`, `a4` (with paths), `a2` (no path), `edge_b`                             |
| K+15  | step 1: `p1`, `p2`, `a1`, `a2` drawn 48x48, the edges magnified 10x                                 |
| K+30  | step 2: `p3` and `a3` freed, `p4` and `a4` updated, all still undrawn                               |
| K+45  | step 3: `p4` and `a4` drawn (their new content)                                                     |
| K+65  | quit                                                                                                |

## The edges

The importer stores an S3TC texture padded to a multiple of 4 (the last column and row repeated) and
`CompressedTexture2D` draws it at the source size through `texture_set_size_override`: `edge_a` is
stored 32x20 and drawn 30x18, `edge_b` stored 28x16 and drawn 26x14. Each is drawn with
`draw_texture_rect_region` over its whole logical size, magnified 10x, so Godot normalizes the source
rectangle by the logical size and samples the padded texels too. A receiver that normalizes by the
stored size instead shifts every 2x2-texel square of the checker by up to two texels at the far edge.
Each 4x4 block holds two colours with every channel 0 or 255, one at or below the other in every
channel, so the DXT1 encoder keeps them as exact endpoints and the host's CPU decode and a GPU's
sampling agree texel for texel.

## Environment

All optional: `RS_FIXTURE_ARM_FRAME`, `RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_TEXTURE_LOG`,
`RS_FIXTURE_SHOT_DIR` (rendered runs: `step-<k>.png` at each settle frame), `RS_FIXTURE_QUIT_FRAME`.
