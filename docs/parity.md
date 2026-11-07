# Parity Validation

Parity compares live Godot layout facts with browser DOM layout facts.

## Flow

1. Map repo fixtures through the committed `godot/project/fixtures` symlink.
2. Prepare browser artifacts for each fixture and compute each viewport.
3. Run Godot with `godot/project/scripts/inspect_scene.gd`, batching fixtures by display mode.
4. Godot writes `godot-live-tree.json`.
5. The harness writes `comparison.json` and fails on mismatches.

Passing `--godot-screenshot` makes the Godot inspector run without
`--headless`, write `godot.png`, and compare it with `browser.png` unless
`--no-screenshot` is also passed. A fixture can require this path with a
sidecar `<fixture>.parity.json`; `--no-godot-screenshot` disables that required
image diff for local/headless debugging.

When multiple fixtures are run, the harness starts one headless Godot process
for fixtures without Godot screenshots, then one non-headless Godot process for
fixtures that write `godot.png`.

Fixtures under repo `fixtures/` are loaded by Godot as `res://fixtures/...`.
Ad hoc fixtures outside repo `fixtures/` use an ignored temporary copy fallback under
the Godot project.

## Artifacts

Artifacts are written under:

```text
artifacts/parity/<fixture-name>/
```

Expected files:

- `godot-live-tree.json`
- `browser.html`
- `browser-dom-tree.json`
- `comparison.json`
- `browser.png` for manual review
- `godot.png` for manual review when `--godot-screenshot` is enabled
- `image-diff.png` when screenshot comparison runs

When a fixture sidecar uses `imageDiff.mode: "node"` or `"text-runs"`,
`image-diff.png` is the cropped diff for the padded comparison region. The
exact compared crop is recorded in `comparison.json` as `imageDiff.region`.

These files are validation evidence and must not be committed.

## Live particle runtime (`particles.enabled`)

By default a `GPUParticles2D` renders in the parity page as a grid of static
`<span>` previews: layout-accurate, and sharing no code with the WebGL particle
renderer. A fixture sidecar can opt into mounting the **real runtime** instead:

```json
{ "particles": { "enabled": true } }
```

Only a literal `true` counts, and the mount is skipped when the browser
screenshot is off (the DOM tree is collected before the mount and is unaffected
by it). With the key set, the harness renders the model with
`enableParticles` + `particleIds: ["*"]`, injects an esbuild bundle of
`packages/test-harness/src/particles-parity/browser-entry.ts`, and calls
`window.__gswParticleParity.mountAll()` after the DOM-tree pass and before the
screenshot. The runtime is mounted frozen (`staticParticles`, no image swap,
`effectsRenderer: "webgl"` — pinned, since `"auto"` could adopt WebGPU and
change which implementation the fixture proves) and is never disposed, because
the canvases have to survive to be photographed.

**Every failure throws.** A missing browser screenshot makes the harness skip
the image diff silently, so a mount that failed softly would leave the fixture
passing on a comparison it never made. A bundle that will not evaluate, a
runtime that declined the software renderer, a node that never drew — each
aborts the fixture.

### What `fixtures/visual-2d/particles-blend.tscn` proves

The only Godot↔browser image fixture that runs the live particle runtime. Two
clusters of two half-overlapping `GPUParticles2D` over a mid-gray backdrop,
four point-emitted particles stacked per node (an N-deep accumulation probe),
with a time-invariant frame: gravity and initial velocity zero, no colour ramp,
`lifetime` far longer than any capture delay. That last part is not a
convenience — Godot preprocesses with `speed_scale` pinned to 1 while the
browser scales its preprocess warm by `speedScale`, so the two sides cannot be
synchronized on a clock and the fixture removes time from the comparison
instead.

- **ADD cluster** (`CanvasItemMaterial blend_mode = 1`): the browser's additive
  path accumulates `ONE/ONE` into an FBO, resolves the total to
  `(light, coverage)` with blending off, and then relies on the node's
  `mix-blend-mode: plus-lighter` (stamped by `material.ts`) to add the canvas
  onto the page. That three-stage algebra was hand-derived and had never been
  checked against anything but another browser renderer. Godot does it in one
  step: `blendFuncSeparate(SRC_ALPHA, ONE, SRC_ALPHA, ONE)`.
- **MIX cluster** (no material): the browser's premultiplied blend
  (`ONE, ONE_MINUS_SRC_ALPHA` on colour and alpha, over a fragment that already
  carries `rgb·a`) against Godot's `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` on colour
  and `ONE, ONE_MINUS_SRC_ALPHA` on alpha — the same function of the same
  inputs, so the destination lands at `a`, never `a²`.

The fixture needs its own texture (`fixtures/assets/softdot32.png`,
reproducible via `scripts/generate-fixture-textures.ts`). An untextured
comparison is impossible in principle: Godot draws a 1×1 white quad, the
browser draws a procedural soft dot, and the two disagree about the picture
before any blend algebra is involved.

The fixture's image-diff budget in its sidecar is deliberately tight: consecutive
runs are bit-identical, so any regression in the additive resolve, the MIX alpha
contract or the particle colour handling trips it rather than hiding inside it.
Godot's screenshot batch runs non-headless; a headless box needs `xvfb-run -a`
around the command.

Godot's RD renderers (Forward+ and Mobile) convert `ParticleProcessMaterial.color`
sRGB→linear once and never undo it in a non-HDR 2D viewport, so the browser
reproduces that one conversion. `GodotHtmlRenderOptions.godotRenderer` selects
the target (`"forward_plus"` by default, `"mobile"`, or `"gl_compatibility"`,
which applies no conversion). A viewport with `rendering/viewport/hdr_2d = true`
is not modeled; `"gl_compatibility"` is the closest available opt-out there.

The `.import` file Godot generates beside the texture is NOT committed:
`*.import` is ignored repo-wide, and the harness runs
`godot --headless --path godot/project --import` before every screenshot batch,
so it is regenerated on demand.

## Command

```bash
mise exec -- pnpm test:parity
mise exec -- pnpm parity:fixture -- fixtures/offsets/basic.tscn
mise exec -- pnpm parity:fixture -- fixtures/offsets/basic.tscn --godot-screenshot
mise exec -- pnpm parity:fixture -- fixtures/text-alignment/rich-theme-roboto.tscn --no-godot-screenshot
```

`test:parity` runs every `.tscn` fixture under `fixtures/`. Use
`parity:fixture` when debugging one fixture.
