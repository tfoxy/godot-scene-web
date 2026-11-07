# Capture-scale fixture (`capture-scale`)

The capture's per-frame cost at a shipped game's scale, from the stock template. A large shipped
game's armed seat can run well below its unarmed frame rate. This scene reproduces that shape with
nothing but RenderingServer calls, so a capture change can be timed without the game.
`scripts/bench-capture-scale.sh` runs it unarmed and armed and judges the difference.

## Files

- `project.godot`: logical 1920x1080, stretch disabled (`GRC_ROOT_SIZE=presentation:1920x1080`
  matches it), `gl_compatibility`, autoload `GrcLoader`, main scene `scale.tscn`.
- `loader.gd`: as `gate8-adopt`'s (`RS_FIXTURE_ARM=born|late|thread`); the bench arms at birth, the
  product's arm-at-init path.
- `scale.tscn` / `scale.gd`: the scene. It does not know about the capture.

## Scene (defaults; every count is an `RS_SCALE_*` knob, see `scale.gd`)

| part                                                                                    | default                               |
| --------------------------------------------------------------------------------------- | ------------------------------------- |
| canvas items, in parent chains of 10                                                    | 4,200                                 |
| resident RGBA8 textures, 640x512, distinct contents                                     | 700 (0.9 GB decoded)                  |
| resident RGBF textures, 64x8 (unsupported format)                                       | 800                                   |
| textures an item draws                                                                  | 170, plus an RGBF one every 50th item |
| meshes, 24 vertices, each drawn by one item over a texture                              | 187                                   |
| meshes updated per frame: vertex region, attribute region, custom AABB, material re-set | 76                                    |
| shaders / ShaderMaterials                                                               | 32 / 560                              |
| float parameters per material (names over 15 characters)                                | 64                                    |
| materials with a String parameter (unsupported param-type)                              | every other one                       |
| `material_set_param` per frame                                                          | 8                                     |
| items moved per frame                                                                   | 100                                   |
| drawing items cleared and re-recorded identically per frame (`RS_SCALE_REDRAWS`)        | 0                                     |
| of those, re-recorded with one float changed (`RS_SCALE_REDRAW_VARY`)                   | 0                                     |

Every mesh update carries new vertex values, so each one is a new content-addressed payload, as
skeletal animation produces. At the quit frame the scene prints, and writes to `RS_SCALE_REPORT`,
its own frame-time summary over the frames after `RS_SCALE_WARMUP` (default 120): fps, frame-time
p50/p95/max, the setup time and `redraws_varied` (the varied re-records it made).
With `RS_SCALE_CPU_REPORT=1` it also reports the main thread's CPU time per frame
(`cpu_us_mean/_p50/_p95`, from `/proc/thread-self/schedstat`) and each per-frame block's wall time
(`section_us`), which time an unarmed capture's hook cost from outside the capture.

## Use

```bash
bash experiments/render-stream/scripts/bench-capture-scale.sh \
  --extension experiments/render-stream/capture/build/render_stream_capture.gdextension [--mode live]
```

The bench holds the quiet lock exclusive per leg (a timing leg), so its numbers are rate numbers.
Report them with the machine's load (`uptime`): the lock does not see other repositories' work.
