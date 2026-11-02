# Gate 8 late-arm pre-arm resources fixture (`gate8-res`, LATE-RES)

The fixture for fidelity gap #5 ("on a late arm, textures/items/materials created before the arm
are unknown"), the confirmed late-arm fidelity blocker from `results/p3/fidelity.md` and
`results/p3/late-cmbt.md`: a capture that arms **late** must adopt pre-arm resources first **drawn**
after the arm, the same as an arm-at-init capture.

Three cells, each drawn only after the arm:

| Cell | Position | Drawn by | The pre-arm resource |
| ---- | -------- | -------- | -------------------- |
| `TEX` | (40,40) | a post-arm `Sprite2D` (created at frame 15) | a pre-arm `ImageTexture` (G8r `adopt_texture_ref`) |
| `PPM` | (136,40) | a pre-arm `GPUParticles2D`, detached until frame 15 | a pre-arm `ParticleProcessMaterial` (PM7 `adopt_particles_ref` → `adopt_ppm`) |
| `ITEM` | (232,40) | a pre-arm `Node2D` whose `_draw` draws a plain rect, detached until frame 15 | the item itself (LATE-RES `adopt_item_node`, the pooled-node case) |
| `PPM9` | (328,40) | a post-arm `GPUParticles2D` created at frame 15 | a pre-arm `ParticleProcessMaterial` (LATE-RES `ppm_unknown_material_candidates` → `adopt_ppm`, the emitter-9 shape) |

## Timeline

| frame | |
| ----- | - |
| 0 | `_ready` builds every pre-arm resource (texture, process material, emitter, draw node), all detached from the tree |
| 1..11 | nothing draws (the resources are not in the tree) |
| 12 | the loader arms the capture (`GRC_ADOPT=arm`): the walk adopts only what is in the tree (the root) |
| 15 | the three cells enter the tree and draw |
| 30 | quit |

The capture must run on a rendered host (a private 640x360 gamescope): a headless host's dummy
storage keeps no particles or canvas state. The check is capture-only (result.json `adopt_stats`
and `particles.adoption`, plus the recording's resolved tables); there is no `reference` leg.

## Checks (`res-*`)

- `res-late-adopt`: the late capture adopts the pre-arm texture (1), process material (1) and both
  pre-arm items (2), with no refused texture/material and **no unknown item RIDs** (`residue` 0).
- `res-late-fault`: under `GRC_ADOPT_FAULT=no-resources` nothing pre-arm is adopted and the
  pre-arm items stay unknown (the pre-LATE-RES capture).
