# Gate 8 late-arm spine CanvasTexture fixture (`gate8-ct-spine`, LATE-SPINE)

The fixture for a **runtime-built** `CanvasTexture` adopted at a **late arm** from the **draw's own
texture reference** — the spine-godot shape. `gate8-ct-late` (RT-CTX) proves the node-map path: the
CanvasTexture is read from the drawing item's `texture` property. This fixture proves the
**LATE-SPINE** path: the drawing node has **no `texture` property** (spine-godot's `SpineMesh2D`
draws `canvas_item_add_mesh` straight through the atlas page's CanvasTexture RID), so the capture
must adopt the CanvasTexture from the `canvas_texture_create` / `canvas_texture_set_channel` hooks'
registry — the RID the draw itself named — not from a node property.

## Files

- `project.godot`: 640x360, `gl_compatibility`, autoload `GrcLoader`, main scene `spine.tscn`.
- `loader.gd`: loads the capture GDExtension in `_process` at fixture frame 8
  (`RS_FIXTURE_ARM_FRAME`), **before** the CanvasTexture exists, so the canvas_texture_* hooks are
  installed when its channels are set.
- `spine.tscn` / `spine.gd`: a plain `Node` that creates a custom `SpineLike` Node2D in `_ready`
  and the runtime CanvasTexture in `_process` at frame 10 (after the capture loads, before the arm).
  `SpineLike._draw` calls `draw_mesh(quad, CanvasTexture, Transform2D(), Color.WHITE)` — no
  `texture` property.
- `expected.json`: the hand-derived regions, counts and checkpoints the checker reads.

## Scene

One 64x64 cell at (40,40), a 16x16 opaque RGBA8 pattern (distinct per seed, every channel in
10..239, never white), drawn only through a runtime CanvasTexture's diffuse via `add_mesh`.

| Cell | Position | Draw | Through |
| ---- | -------- | ---- | ------- |
| `MESH` | (40,40) | a custom Node2D's `draw_mesh` (the spine shape, no `texture` property) | CT |

## Timeline

| frame | |
| ----- | - |
| 0 | `_ready` creates the `SpineLike` draw node |
| 8 | the loader arms the capture's hooks (`GDExtensionManager.load_extension`): the vtable is patched, but the arm (adoption/snapshot/publish) is deferred by `GRC_ARM_DEFER_FRAMES=6` |
| 10 | `_process` builds the CanvasTexture (diffuse = the pattern image) and queues the draw node's redraw; the canvas_texture_* hooks record its channels into the registry |
| 14 | the deferred arm runs: the walk adopts the items, `queue_redraw` re-sends `draw_mesh`, and the CanvasTexture is adopted from the registry at its first post-arm draw |
| 17 | checkpoint 0: the reference saves `step-0.png` |
| 30 | quit |

The capture must run on a rendered host (a private 640x360 gamescope): a headless host's dummy
storage allocates no canvas texture (`canvas_texture_allocate` returns `RID()` in
`../godot-4.5.1-stable/servers/rendering/dummy/storage/texture_storage.h`). The `reference`
leg runs the same project unarmed in the same private 640x360 gamescope.

## Checks (`ctsp-*`, `ct-spine-*`)

- `ctsp-legs`: every g8ctsp leg that ran exits 0.
- `ct-spine-adopt`: the late capture adopts the runtime CanvasTexture from the hooks' registry
  (origin adopted, status ok, diffuse an ok image), nothing refused, no unknown-texture draw.
- `ct-spine-fault`: under `GRC_ADOPT_FAULT=no-resources` nothing is adopted and the draw stays
  unknown-texture (the pre-LATE-SPINE capture).

- `ct-spine-diffuse-uploaded`: each receiver (`late/receiver`, `late/receiver-patch`, the full and
  patch sinks of the late capture) uploads the adopted diffuse as an image.
- `ct-spine-reference`: each receiver's shot equals the unarmed `reference` shot at every
  `expected.json` checkpoint, and the declared `regions` / `cells` (MESH) hold ink (more than half
  the pixels differ from `clear_color`), so neither Godot's white default nor an empty cell passes.
