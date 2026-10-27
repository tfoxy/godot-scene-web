# Capture-scale fixture (`capture-scale`, P3-CAP)

The capture's per-frame cost at a shipped game's scale, from the stock template
([`../../results/p3/p3-cap.md`](../../results/p3/p3-cap.md)). C3 measured the armed Slay the
Spire 2 seat at 21–50 fps against 60 unarmed, with a 25 ms frame callback. This scene reproduces
that shape with nothing but RenderingServer calls, so a capture change can be timed without the
game.
`scripts/bench-capture-scale.sh` runs it unarmed and armed and judges the difference.

## Files

- `project.godot`: logical 1920x1080, stretch disabled (`GRC_ROOT_SIZE=presentation:1920x1080`
  matches it), `gl_compatibility`, autoload `GrcLoader`, main scene `scale.tscn`.
- `loader.gd`: as `gate8-adopt`'s (`RS_FIXTURE_ARM=born|late|thread`); the bench arms at birth, the
  product's arm-at-init path.
- `scale.tscn` / `scale.gd`: the scene. It does not know about the capture.

## Scene (defaults; every count is an `RS_SCALE_*` knob, see `scale.gd`)

| part | default | C3's combat scene |
| ---- | ------- | ----------------- |
| canvas items, in parent chains of 10 | 4,200 | 4,196 items, depth p50 9 |
| resident RGBA8 textures, 640x512, distinct contents | 700 (0.9 GB decoded) | 701 `ok` images, 0.96 GB |
| resident RGBF textures, 64x8 (unsupported format) | 800 | 847 unsupported |
| textures an item draws | 170, plus an RGBF one every 50th item | |
| meshes, 24 vertices, each drawn by one item over a texture | 187 | 187 |
| meshes updated per frame: vertex region, attribute region, custom AABB, material re-set | 76 | ~76 per frame (381,783 updates in 5,000 frames) |
| shaders / ShaderMaterials | 32 / 560 | 72 / 561 |
| float parameters per material (names over 15 characters) | 64 | 42 per material, up to 77 |
| materials with a String parameter (unsupported param-type) | every other one | 348 |
| `material_set_param` per frame | 8 | ~7 |
| items moved per frame | 100 | |
| drawing items cleared and re-recorded identically per frame (`RS_SCALE_REDRAWS`, W11b) | 0 | ~170 (WB: 163 of 174 patched items carry nothing new) |

Every mesh update carries new vertex values, so each one is a new content-addressed payload, as
skeletal animation produces. At the quit frame the scene prints, and writes to `RS_SCALE_REPORT`,
its own frame-time summary over the frames after `RS_SCALE_WARMUP` (default 120): fps, frame-time
p50/p95/max and the setup time.

## Use

```bash
bash experiments/render-stream/scripts/bench-capture-scale.sh \
  --extension experiments/render-stream/capture/build/render_stream_capture.gdextension [--mode live]
```

The bench holds the quiet lock exclusive per leg (a timing leg), so its numbers are rate numbers.
Report them with the machine's load (`uptime`): the lock does not see other repositories' work.
