# Gate 8 particle colour fixture (`gate8-ptc`, PFB)

PFB ([render-stream-12.md](../../protocol/render-stream-12.md) "As built (PFB)",
[results/p3/pfb.md](../../results/p3/pfb.md)): a RendererRD host (`forward_plus`, `mobile`) runs a
particles material's `Color` uniforms through `Color::srgb_to_linear()` before its process shader
reads them; gl_compatibility does not. This fixture shows it on the stock 4.5.1 template and is
the g8pt `ptc/*` legs' scene.

## Files

- `project.godot`: 640x360, gl_compatibility (the Forward+ legs override it on the command line),
  clear colour 0.2 grey.
- `loader.gd`: the `GrcLoader` autoload; loads `GRC_EXTENSION` in `_enter_tree` (armed at birth).
- `ptc.gd`, `ptc.tscn`: the scene.

## Cells

Each cell is one `GPUParticles2D` particle (amount 1, explosiveness 1, lifetime 100 s, no
velocity, no gravity, scale 1) drawing a 32x32 opaque white texture at the cell centre, with
`use_fixed_seed`.

| Cell | Centre | Colour | gl_compatibility | Forward+ |
| ---- | ------ | ------ | ---------------- | -------- |
| `C_MIX` | (160,180) | `color` (0.5, 0.25, 0.75, 1), blend mix | (127, 63, 191) | (54, 13, 133) |
| `C_ADD` | (320,180) | `color` (0.6, 0.4, 0.2, 0.5), a `CanvasItemMaterial` with blend add | (127, 102, 76) | (91, 68, 55) |
| `C_RAMP` | (480,180) | `color` white, `color_ramp` (0.5, 0.25, 0.75, 1) at both stops (the control) | (127, 63, 191) | (127, 63, 191) |

## Timeline

Checkpoint 0 is `_ready`'s scene (applied at frame 1, settles at 4); checkpoint 1 at 20 (settles at
27) changes nothing (a second shot of the same state); quit at 40. `RS_FIXTURE_STEP_LOG`,
`RS_FIXTURE_QUIT_FRAME` and `RS_FIXTURE_SHOT_DIR` (`step-<k>.png` at each settle frame) as
gate8-pt. The fixture prints `[fixture] rendering_method=<m>`; a host whose Vulkan falls back to
opengl3 prints `gl_compatibility`, and `lib/gate8-ptc-checks.ts` then does not run its checks.
