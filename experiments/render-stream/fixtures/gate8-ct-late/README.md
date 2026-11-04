# Gate 8 late-arm runtime CanvasTexture fixture (`gate8-ct-late`, RT-CTX + GAP2-RX)

The fixture for a **runtime-built** `CanvasTexture` adopted at a **late arm** — the deferred
follow-up in [`../../results/p3/late-arm.md`](../../results/p3/late-arm.md). `gate8-ct` proves the
cached `.tres` CanvasTexture path (armed at birth); this fixture proves the node-map path for a
CanvasTexture built in code (`ImageTexture.create_from_image` + `CanvasTexture` assigned to the
item's `texture`), which has no resource path for the census and no `canvas_texture_get_channel`
RenderingServer getter. spine-godot builds its atlases in code this way, so this is the generic
shape of C3 gap 5's spine draws.

RT-CTX judged the **capture** only (`ct-late-adopt` / `ct-late-fault`). GAP2-RX adds the
**receiver** side: the unarmed `reference`, and the native receiver on the full and patch sinks, so
the adopted CanvasTexture's diffuse must be made resident and drawn (fidelity gap #2, receiver-side).

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `ctl.tscn`.
- `loader.gd`: loads the capture GDExtension in `_process` at fixture frame 12
  (`RS_FIXTURE_ARM=late`, `RS_FIXTURE_ARM_FRAME`), after the main scene built everything.
- `ctl.tscn` / `ctl.gd`: a plain `Node` that builds every CanvasTexture and item in `_ready`, and
  (GAP2-RX) logs the checkpoint and saves a shot at the settle frame.
- `expected.json`: the hand-derived regions, counts and checkpoints the checker reads.

## Scene

Three 64x64 cells. Every image is a 16x16 opaque RGBA8 pattern of 4x4-texel blocks (distinct per
seed, every channel in 10..239, never white), drawn only through a CanvasTexture's diffuse.

| Cell | Position | Draw | Through |
| ---- | -------- | ---- | ------- |
| `SPRITE` | (40,40) | `Sprite2D` at scale 4 (`add_texture_rect`) | CT_A |
| `TRECT` | (136,40) | `TextureRect` (a Control's `add_texture_rect`) | CT_B |
| `MESH` | (232,40) | `MeshInstance2D`, an `ArrayMesh` quad (`add_mesh`, the spine shape) | CT_C |

## Timeline

| frame | |
| ----- | - |
| 0 | `_ready` builds all three CanvasTextures and items |
| 1..11 | the items draw, unarmed (nothing captured) |
| 12 | the loader arms the capture (`GRC_ADOPT=arm`): the walk adopts the items, `queue_redraw` re-sends the draws, and each CanvasTexture is adopted at its first post-arm draw from the item's node |
| 17 | checkpoint 0: the reference saves `step-0.png`; the receivers shoot the sequence the step log maps to this settle frame |
| 22 | SPRITE's `texture` is set to null: the CanvasTexture and its diffuse are freed (`FREE_FRAME`) |
| 26 | checkpoint 1: the SPRITE cell is empty (the reference and both receivers agree) |
| 30 | quit |

The capture must run on a rendered host (a private 640x360 gamescope): a headless host's dummy
storage allocates no canvas texture (`../../protocol/canvas-texture-headless.md`), so a runtime
CanvasTexture has no RID to adopt. The `reference` leg runs the same project unarmed in the same
private 640x360 gamescope.

## Checks (`ctl-*`, `ct-late-*`)

- `ctl-legs`: every g8ctl leg that ran exits 0.
- `ct-late-adopt`: the late capture adopts every runtime CanvasTexture from the node map (origin
  adopted, status ok, diffuse an ok image), nothing refused, no unknown-texture draw.
- `ct-late-fault`: under `GRC_ADOPT_FAULT=no-resources` nothing is adopted and the draws through a
  CanvasTexture stay unknown-texture.
- `ct-late-diffuse-uploaded` (GAP2-RX): each receiver uploads every adopted canvas texture's
  diffuse as an image, although no command names the diffuse itself.
- `ct-late-free`: after the free at frame 22 the capture's table drops SPRITE's canvas texture and
  its diffuse and each receiver's transactions at or after the free release a texture.
- `ct-late-reference` (GAP2-RX): each receiver (full and patch sinks) equals the unarmed reference
  exactly at the checkpoint.
