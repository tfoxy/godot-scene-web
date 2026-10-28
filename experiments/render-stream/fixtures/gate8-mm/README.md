# Gate 8 multimesh fixture (`gate8-mm`, PM1)

The fixture for render-stream/11's multimesh table
([`../../protocol/render-stream-11.md`](../../protocol/render-stream-11.md) "As built (PM1):
decisions"; [`../../protocol/particles-multimesh-design.md`](../../protocol/particles-multimesh-design.md)
"Increments"). Every `CPUParticles2D` is a multimesh whose buffer it re-sets each frame from
`RenderingServer.frame_pre_draw`; a `MultiMeshInstance2D` is one the game fills itself. The scene
does not know about the capture. Gate 8's group `g8mm` runs it (`scripts/run-gate8.sh`,
`scripts/lib/gate8-mm-checks.ts`). PM1 runs captures only, judged against their own hook log; PM2
reuses every cell for the references and receivers.

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `mm.tscn`.
- `loader.gd`: loads the capture GDExtension in `_enter_tree` when `GRC_EXTENSION` is set (armed at
  birth); unarmed otherwise.
- `mm.tscn` / `mm.gd`: a plain `Node` that builds every cell in `_ready` and drives the steps.
- `expected.json`: the hand-derived hook-log census per cell and the frame-pairing floats the
  checker reads.

## Cells

Each cell's multimesh has its own instance count, which is how the checker finds it in the hook log
(the rid whose last allocation has that count). `CPUParticles2D`'s constructor allocates 8 before
the fixture sets `amount`, so no cell uses 8.

| Cell | Position | Construction | Instances (stride) | What it proves |
| ---- | -------- | ------------ | ------------------ | -------------- |
| `A_XFORM` | (40,40) | `MultiMeshInstance2D`, transforms only, five `set_instance_transform_2d`; step 1 moves instance 2 | 5 (8) | the per-instance transform setter in the shadow buffer |
| `B_CUSTOM` | (240,40) | colour and custom data, one `set_buffer` in `_ready`, then instance 0's custom data = (fixture frame, 0, 0, 0) in `_process` every frame; a canvas `ShaderMaterial` reads `INSTANCE_CUSTOM` (frame parity) | 6 (16) | the custom setter, frame pairing for a `_process` change |
| `C_FLIP` | (460,70) | `CPUParticles2D`, `use_fixed_seed` (4242), local coordinates, a 32x8 four-frame flipbook through a `CanvasItemMaterial` with `particles_animation` | 7 (16) | a particle buffer every frame; the flipbook frame in custom.z |
| `D_GLOBAL` | (40..98,180) | `CPUParticles2D`, `use_fixed_seed` (777), `local_coords = false`, under a `Node2D` moved 2 px a frame (back every 30) | 9 (16) | global coordinates: the buffer holds `inv(emission) * particle`, so it changes as the parent moves |
| `E_VISIBLE` | (240,150) | colours, one `set_buffer`, `visible_instance_count` 4 and a custom AABB; step 2 shows 6 | 10 (12) | `visible` and `custom_aabb` on the wire |
| `F_REPLACE` | (460,150) | colours, one `set_buffer`; step 1 `multimesh.buffer = ...` (new floats); step 2 the same floats again | 3 (12) | a replaced buffer; an identical re-set moves nothing (rule 2) |
| `G_HIDDEN` | (40,280) | `CPUParticles2D`, emitting, `visible = false` | 11 (16) | a hidden emitter never draws and never sets a buffer (PM2's `mm-hidden-cost`) |
| `H_FREE` | (240,270) | a raw `RenderingServer` multimesh on a raw canvas item (`canvas_item_add_multimesh`); step 1 a wrong-size `multimesh_set_buffer` (3 floats for 2 x 8: GLES3 refuses it); step 2 `free_rid` while the item still names it; frame 41 `canvas_item_clear` | 2 (8) | a rejected call moves nothing; a `freed` tombstone, then `removed_multimeshes` |
| `I_PREDRAW` | (440,270) | custom data only; its buffer set from `RenderingServer.frame_pre_draw` with instance 0's custom.x = the fixture frame (an initial buffer with -1 in `_ready`) | 12 (12) | frame pairing at `CPUParticles2D`'s own timing: the pre-draw buffer belongs to the frame it was set in |

Particles run at the fixed step: every leg is `--fixed-fps 60`, `fixed_fps` stays 0 (one
`_particles_process(1/60)` a frame) and every emitter has `use_fixed_seed`.

## Timeline

| frame | |
| ----- | - |
| 1 | checkpoint 0 (the scene `_ready` built); settles at 4 |
| 20 | step 1: A_XFORM instance 2 moved; F_REPLACE's buffer replaced; H_FREE's rejected `set_buffer`; settles at 27 |
| 30 | the capture sabotages start (`GRC_SABOTAGE_FRAME`) |
| 40 | step 2: E_VISIBLE shows 6; F_REPLACE re-set with the same floats; H_FREE freed (a tombstone); settles at 47 |
| 41 | H_FREE's item cleared: the entry leaves the table |
| 90 | quit |

`RS_FIXTURE_MM_LOG` gets one line per frame-carrying buffer of B_CUSTOM (every frame, from
`_process`) and I_PREDRAW (every rendered frame, from `frame_pre_draw`):
`{"cell", "frame", "value", "sha256"}`, the SHA-256 of the cell's whole buffer as little-endian
f32 after the change, the floats the fixture itself holds. The checker reads values through it:
I_PREDRAW's `set_buffer` lines by their `sha256`, B_CUSTOM's custom setter lines by order.

## Headless

On a headless host `RenderingServer::draw` never runs, so `frame_pre_draw` never fires: C_FLIP,
D_GLOBAL and I_PREDRAW never set a buffer (their multimeshes stay allocated, zero-filled, and still
drawn), while A_XFORM, B_CUSTOM, E_VISIBLE, F_REPLACE and H_FREE behave as rendered. The
`headless/capture` leg's census pins that (expected.json `headless`). Godot's dummy storage stores
H_FREE's wrong-size buffer without a check; the hook log must still mark it rejected, by Godot's
own size rule (`instances x stride`, MultiMesh and GLES3).

## Teardown

After the quit, node and resource destructors free every multimesh and each drawing
`CPUParticles2D` sets its visible count to 0 (`_set_do_redraw(false)` on exit). The census ignores a
`free` or a `set_visible_instances` of 0 at or after the last transaction's frame.
