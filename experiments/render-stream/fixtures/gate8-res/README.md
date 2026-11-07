# Gate 8 late-arm pre-arm resources fixture (`gate8-res`, LATE-RES)

The fixture for late-arm adoption of pre-arm resources ("on a late arm, textures/items/materials
created before the arm are unknown"): a capture that arms **late** must adopt pre-arm resources first **drawn**
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
| 16 | LAR6: a worker `Thread` draws a fifth pre-arm `ImageTexture` into an RS-only item and clears it again, inside one `_process` (the loader-thread reference; nothing else ever draws that texture) |
| 22 | the fixture frees the TEX sprite and texture, the PPM emitter and the ITEM node (`FREE_FRAME`) |
| 30 | quit |

The capture must run on a rendered host (a private 640x360 gamescope): a headless host's dummy
storage keeps no particles or canvas state. The check is capture-only (result.json `adopt_stats`
and `particles.adoption`, plus the recording's resolved tables); there is no `reference` leg.

## Arms (LAR5)

`loader.gd` takes `RS_FIXTURE_ARM`:

- `late` (default): the extension loads at fixture frame 12, after `_ready` built every cell. The
  texture and both items are adopted at their first post-arm draw; the pre-arm `GPUParticles2D` is
  unregistered and **refused** `preload-particles` (never adopted: `emitters` 0), and the pre-arm
  process material is keyed through the LATE-RES re-link when `PPM9` references it
  (`unknown_material_keyed` >= 1). `expected.json` `late`.
- `deferred`: the extension loads in `_enter_tree` and the runner arms at frame 12
  (`GRC_ARM_DEFER_FRAMES=11`), so the emitter and both process materials are adopted from the
  registry; `PPM9`'s reference adopts the registered material directly
  (`unknown_material_keyed` exactly 0). `expected.json` `deferred`.

## Checks (`res-*`)

- `res-late-adopt` (`deferred/capture`): the capture adopts the pre-arm texture (1), the emitter (1),
  both process materials from the registry (2) and both pre-arm items (2), with no refused
  texture/material, `unknown_material_keyed` 0 and **no unknown item RIDs** (`residue` 0).
- `res-late-adopt` also counts the loader-thread texture: `expected.json` `deferred.textures`
  (2) and `deferred.offmain_adopted` (1), adopted from the off-main queue at frame 16's boundary.
- `res-late-adopt-catches-registry-queue-drop` (`sabotage-registry-queue-drop/capture`, LAR6): the
  deferred capture under `GRC_ADOPT_FAULT=registry-queue-drop` (the frame boundary discards the
  off-main queue) never adopts the loader-thread texture, so `res-late-adopt` fails on it.
- `res-late-residual` (`late/capture`): texture and items adopted, `emitters` 0, `refused` and
  `refused_preload_particles` 1, `unknown_material_keyed` >= 1, no unknown RIDs.
- `res-late-fault`: under `GRC_ADOPT_FAULT=no-resources` nothing pre-arm is adopted and the
  pre-arm items stay unknown (the pre-LATE-RES capture).
- `res-free` (`deferred/capture`): after the frame-22 free, the capture records the freed cells (at least
  `expected.json`'s `freed_items`, `freed_textures`, `freed_particles` gone or tombstoned).
