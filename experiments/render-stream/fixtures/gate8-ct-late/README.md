# Gate 8 late-arm CanvasTexture fixture (`gate8-ct-late`, RT-CTX, GAP2-RX, LAR1)

The fixture for CanvasTextures adopted at a **late arm**: three **runtime-built** ones
(`ImageTexture.create_from_image` + `CanvasTexture` assigned to the item's `texture`, which has no
resource path and no `canvas_texture_get_channel` RenderingServer getter; spine-godot builds its
atlases this way, the generic shape of C3 gap 5) and one **cached** `.tres` (`cached_ct.tres`,
PM9's resource-cache path).

Since LAR1 ([`../../protocol/late-arm-registry-design.md`](../../protocol/late-arm-registry-design.md))
it has two arm modes:

- `deferred` (`RS_FIXTURE_ARM=deferred`): the loader loads the capture in `_enter_tree`, before the
  scene exists, and the runner defers the arm to frame 12 (`GRC_ARM_DEFER_FRAMES=11`). Every
  CanvasTexture is created under the hooks, so the registry records its channels, and the arm
  adopts all four from it. Its receivers (full and patch sinks) are judged against the unarmed
  `reference`.
- `late` (the default): the loader loads the capture at frame 12, after everything exists
  (load-late, retired as a fidelity target by the design's F1). It judges the residual path: the
  cached `.tres` is adopted through the resource cache (PM9), and the three runtime-built
  CanvasTextures are refused, typed `refused_no_image`, their draws `unknown-texture`. RT-CTX's
  node read, which used to adopt them here, was removed by LAR1.

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `ctl.tscn`.
- `loader.gd`: loads the capture GDExtension in `_process` at fixture frame 12
  (`RS_FIXTURE_ARM=late`, `RS_FIXTURE_ARM_FRAME`), after the main scene built everything, or in
  `_enter_tree` (`RS_FIXTURE_ARM=deferred`).
- `cached_ct.tres`: the CACHED cell's CanvasTexture, its diffuse an embedded ImageTexture of
  `ctl.gd`'s `_pattern(4)` (written once by a `ResourceSaver.save` script).
- `ctl.tscn` / `ctl.gd`: a plain `Node` that builds every CanvasTexture and item in `_ready`, and
  (GAP2-RX) logs the checkpoint and saves a shot at the settle frame.
- `expected.json`: the hand-derived regions, counts and checkpoints the checker reads.

## Scene

Four 64x64 cells. Every image is a 16x16 opaque RGBA8 pattern of 4x4-texel blocks (distinct per
seed, every channel in 10..239, never white), drawn only through a CanvasTexture's diffuse.

| Cell | Position | Draw | Through |
| ---- | -------- | ---- | ------- |
| `SPRITE` | (40,40) | `Sprite2D` at scale 4 (`add_texture_rect`) | CT_A |
| `TRECT` | (136,40) | `TextureRect` (a Control's `add_texture_rect`) | CT_B |
| `MESH` | (232,40) | `MeshInstance2D`, an `ArrayMesh` quad (`add_mesh`, the spine shape) | CT_C |
| `CACHED` | (328,40) | `Sprite2D` at scale 4 (`add_texture_rect`) | `cached_ct.tres` |

## Timeline

| frame | |
| ----- | - |
| 0 | `_ready` builds all four CanvasTextures and items (`deferred`: under the hooks, recorded by the registry) |
| 1..11 | the items draw, unarmed (nothing captured) |
| 12 | the capture arms (`GRC_ADOPT=arm`; `late` loads it here): the walk adopts the items, `queue_redraw` re-sends the draws, and each CanvasTexture is adopted at its first post-arm draw (`deferred`: from the registry; `late`: CACHED from the resource cache, the rest refused) |
| 17 | checkpoint 0: the reference saves `step-0.png`; the receivers shoot the sequence the step log maps to this settle frame |
| 22 | SPRITE's `texture` is set to null: the CanvasTexture and its diffuse are freed (`FREE_FRAME`) |
| 26 | checkpoint 1: the SPRITE cell is empty (the reference and both receivers agree) |
| 30 | quit |

The capture must run on a rendered host (a private 640x360 gamescope): a headless host's dummy
storage allocates no canvas texture (`../../protocol/canvas-texture-headless.md`), so a runtime
CanvasTexture has no RID to adopt. The `reference` leg runs the same project unarmed in the same
private 640x360 gamescope.

## Checks (`ctl-*`, `ct-*`)

- `ctl-legs`: every g8ctl leg that ran exits 0.
- `ct-late-adopt` (`deferred`): every CanvasTexture adopted (origin adopted, status ok, diffuse an
  ok image), nothing refused, no unknown-texture draw.
- `ctl-registry-source` (`deferred`, LAR1): every adopted CanvasTexture came from the registry
  (`canvas_registry` = 4, `canvas_residual` 0), and `registry.json` recorded the creates.
- `ct-adopt-named` (`deferred` and `late`, LAR1, for F2): every adopted canvas texture is named by
  a command in the transaction that first carries it.
- `ct-late-residual` (`late`, LAR1 under F1): CACHED adopted through the resource cache
  (`canvas_residual` 1), the three runtime ones refused, all typed `refused_no_image`, their draws
  unknown-texture.
- `ct-late-fault` (`late`): under `GRC_ADOPT_FAULT=no-resources` nothing is adopted and the draws
  through a CanvasTexture stay unknown-texture.
- `sabotage-registry-off` (`deferred`, LAR1): under `GRC_ADOPT_FAULT=registry-off` the registry
  records nothing, and both `ctl-registry-source` and `ct-late-adopt` fail.
- `ct-late-diffuse-uploaded` (GAP2-RX, `deferred`'s receivers): each receiver uploads every
  adopted canvas texture's diffuse as an image, although no command names the diffuse itself. Since
  LAR8 the receivers have no adopted shortcut: the diffuse is resident because a command names the
  canvas texture (`ct-adopt-named`).
- `ct-late-free` (`deferred`): after the free at frame 22 the capture's table drops SPRITE's
  canvas texture and its diffuse and each receiver's transactions at or after the free release a
  texture.
- `ct-late-reference` (GAP2-RX, `deferred`'s receivers): each receiver (full and patch sinks)
  equals the unarmed reference exactly at the checkpoint.
