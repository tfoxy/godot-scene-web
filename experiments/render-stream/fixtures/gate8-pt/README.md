# Gate 8 GPU particles fixture (`gate8-pt`, PM5)

The fixture for render-stream/12's particles table
([`../../protocol/render-stream-12.md`](../../protocol/render-stream-12.md) "Fixture and checks
(gate 8 group g8pt)"). Every cell is a `GPUParticles2D` with its own `ParticleProcessMaterial`;
the scene does not know about the capture. Gate 8's group `g8pt` runs it
(`scripts/run-gate8.sh`, `scripts/lib/gate8-pt-checks.ts`). PM5 runs captures judged against their
own hook log, plus one native receiver leg that only proves a /12 stream is accepted; PM6 reuses
the cells for the references and the receivers that draw.

## Files

- `project.godot`: 640x360, no stretch, `gl_compatibility`, `msaa_2d=0`, default canvas filter
  nearest, autoload `GrcLoader`, main scene `pt.tscn`.
- `loader.gd`: loads the capture GDExtension in `_enter_tree` when `GRC_EXTENSION` is set (armed at
  birth); unarmed otherwise.
- `pt.tscn` / `pt.gd`: a plain `Node` that builds every cell in `_ready` and drives the steps.
- `expected.json`: the hand-derived hook-log census per cell, each cell's MaterialKey and the
  float-texture shape the checker reads.

## Cells

Each emitter has its own `amount`, which is how the checker finds it in the hook log (the rid whose
last `particles_set_amount` has that amount). `GPUParticles2D`'s constructor sets 8 first, so no
cell uses 8. Every emitter has `use_fixed_seed` and its own seed, a 4x4 white texture (E_FLIP: the
flipbook), lifetime 1, and a process material with `particle_flag_disable_z` and an explicit 2D
gravity (so `set_process_material` does not rewrite it).

| Cell | Position | Amount | What |
| ---- | -------- | ------ | ---- |
| `A_BOX` | (106,60) | 3 | box emitter, local coordinates; two `emit_particle` calls at each of steps 1 and 2 |
| `B_SPHERE` | (260..318,60) | 5 | sphere emitter, `local_coords = false`, under a `Node2D` moved 2 px a frame (back every 30): an emission transform every frame, an emitter velocity at each change |
| `C_RING` | (533,60) | 6 | ring emitter; step 1 `request_particles_process(0.5)`, step 2 seed 2003 |
| `D_ONESHOT` | (106,180) | 7 | `one_shot`, `explosiveness` 1, `emitting = false`; `restart()` at steps 1 and 2 |
| `E_FLIP` | (320,180) | 9 | a 32x8 four-frame flipbook through a `CanvasItemMaterial` with `particles_animation` |
| `F_CURVES` | (533,180) | 10 | `scale_curve` (a 64x1 `CurveTexture`, RGBF) and `color_ramp` (a 64x1 `GradientTexture1D`, `use_hdr`: RGBAF) |
| `G_TURB` | (106,300) | 11 | turbulence |
| `H_SUB` | (320,300) | 12 | `sub_emitter_mode` AT_END naming its child `SubEmitter` (`H_CHILD`, amount 2, `emitting = false`) |
| `I_TRAILS` | (533,300) | 13 | trails: `trail_lifetime` 0.3, 4 sections (5 bind poses), transform align Y-to-velocity |

## Timeline

| frame | |
| ----- | - |
| 1 | checkpoint 0 (the scene `_ready` built); settles at 4 |
| 20 | step 1: A_BOX emits two; C_RING requests 0.5 s of processing; D_ONESHOT restarts; settles at 27 |
| 30 | the capture sabotages start (`GRC_SABOTAGE_FRAME`) |
| 40 | step 2: A_BOX emits two; C_RING's seed changes; D_ONESHOT restarts (after the sabotage frame: `drop-restart` drops it); settles at 47 |
| 90 | quit |

`RS_FIXTURE_STEP_LOG` gets `{"step", "applied_frame", "settle_frame"}` per checkpoint.

## GLES3 and the MaterialKey

`gl_compatibility` is a low-end renderer, so `ParticleProcessMaterial::_update_shader` writes no
sub-emitter code there: H_SUB's `sub_emitter` (`at_end`) is in its key and on the wire but not in
its shader code. `pt-builtin` checks it against expected.json's key instead.

## Teardown

After the quit each emitter leaves the tree (`particles_set_subemitter(RID())`) and its destructor
frees it. The census counts calls after the last transaction's frame separately
(expected.json `base_teardown`).
