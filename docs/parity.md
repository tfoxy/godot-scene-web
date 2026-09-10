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

#### Calibration record

| date       | box                              | observed `diffRatio`       | budget |
| ---------- | -------------------------------- | -------------------------- | ------ |
| 2026-08-20 | Linux, Godot 4.5.1, `DISPLAY=:0` | 0.000990 (38/38400 px) ×3  | 0.01   |
| 2026-08-21 | Linux, Godot 4.5.1, `DISPLAY=:0` | 0.016589 (637/38400 px) ×2 | 0.025  |
| 2026-08-21 | Linux, Godot 4.5.1, `DISPLAY=:0` | 0 (0/38400 px) ×3          | 0.0005 |

Consecutive runs are bit-identical, on both the observed ratio and every pixel
sampled below: this fixture has no measurable run-to-run noise, so its budget
is set by the reading rather than by spread. Godot's screenshot batch runs
non-headless and was captured on the box's real display; a headless box needs
`xvfb-run -a` around the command.

**The third reading is the colour-space stream landing, and it closes this
fixture out at zero differing pixels.** The budget is re-tightened 50× from
0.025 to 0.0005 — 19 px of 38400. That is deliberately below BOTH historical
readings: a full return of the RD linearization is 637 px and even the
ADD-cluster-only residual that predated the alpha-contract flip was 38 px, so
either regression trips the budget rather than hiding inside it. It is not set
to a literal 0 only because a one-pixel environmental drift should not be a red
build; nothing observed needs the headroom.

**Why the middle row's ratio WENT UP while the fixture GOT BETTER** — history
now, but keep it, because the shape recurs. See the alpha-contract entry below:
the browser's MIX cluster was compositing at `a²`, which happened to darken it
toward a Godot capture that is itself darkened by an unrelated colour-space
conversion. Two errors were partly cancelling. Removing the browser's left
Godot's exposed — on the MIX cluster's red and green, exactly where the ADD
cluster had always shown it, and for exactly the same reason. The third row is
that second error being removed in turn, which is why the two together land on
zero rather than on a smaller residual.

**The MIX/ADD readings, across all three fixes** (this fixture is the only
Godot-side validation any of them has):

| reading                                 | `diffRatio` | MIX core, browser | MIX core, Godot |
| --------------------------------------- | ----------- | ----------------- | --------------- |
| before the `blendFuncSeparate` fix      | 0.0203      | (109, 127, 151)   | (38, 89, 234)   |
| after it (dst alpha `a`)                | 0.000990    | (69, 117, 181)    | (38, 89, 234)   |
| after the alpha-contract flip (below)   | 0.016589    | (86, 148, 234)    | (38, 89, 234)   |
| after the `godotRenderer` curve (below) | 0           | (35, 90, 234)     | (38, 89, 234)   |

Godot's side is unchanged throughout, as it must be. The ADD cluster's browser
core is unchanged by the second fix too — (240, 224, 172) at the single-node
core and (248, 228, 176) at its neighbour, byte for byte before and after —
which is the regression check on the additive resolve, since that pass had to
change in step with the canvas declaration.

**All three cores, across the colour-space fix** (browser before → browser
after, against an unchanged Godot):

| core                          | browser before  | browser after   | Godot           |
| ----------------------------- | --------------- | --------------- | --------------- |
| ADD single-node core (86, 60) | (240, 224, 172) | (240, 204, 144) | (239, 203, 143) |
| ADD neighbour core (70, 60)   | (248, 228, 176) | (248, 208, 144) | (247, 207, 143) |
| MIX cluster core (150, 100)   | (86, 148, 234)  | (35, 90, 234)   | (38, 89, 234)   |

The ADD residual of +21 green / +33 blue collapses to +1/+1, the same +1 the red
channel has always carried (the gray backdrop itself reads 128 against Godot's
127, so +1 is this fixture's floor, not a colour error). On MIX, red and green
converge from +48/+59 to −3/+1.

**Blue did not move.** 234 before, 234 after, against Godot's 234. That is the
regression check, not a coincidence: the MIX emitter's blue is 1.0 and the ADD
emitter's red is 1.0, and `srgbToLinear` is the identity at 1.0. A correction
that touched a channel where the curve is a no-op — or that reached alpha, or a
ramp — would show up here first.

> **RESOLVED 2026-08-21 — the MIX composite alpha (~0.42 against Godot's 0.82).**
> The finding was real and the cause was not a blend factor. The shared WebGL
> canvas declared `premultipliedAlpha: false` while the particle MIX fragment
> wrote PREMULTIPLIED content into it — `blendFuncSeparate(SRC_ALPHA, …)` over a
> cleared buffer is itself a premultiplying operation — so the
> `ctx2d.drawImage(sharedCanvas, …)` blit into each node's own canvas converted
> "straight" to premultiplied and multiplied by alpha a SECOND time. MIX pixels
> landed at `(c·a², a)`, i.e. a composite of `a²` = 0.42 where the four-deep
> algebra `1 − 0.65⁴` says 0.82. The old pre-fix reading (109, 127, 151) is
> predicted by that double-multiply to (108.9, 127.0, 151.1).
>
> `webgl/shared-gl.ts` now declares `premultipliedAlpha: true`, and all three
> consumers of that canvas write `(rgb·a, a)`: `effects/src/shaders/godot-shader.ts` emits
> `fragColor = vec4(COLOR.rgb * COLOR.a, COLOR.a);`,
> `packages/canvas-effects/src/particle-webgl.ts`'s MIX fragment premultiplies under
> `blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`, and
> its additive resolve presents `(light, cov)` with no divide. That is the
> WebGPU contract (`webgpu/device.ts` configures `alphaMode: "premultiplied"`)
> stated in GLSL — one rule for both backends instead of a canvas that meant one
> thing to the shader path, another to the additive path and a third to MIX.
>
> **The MIX core's blue moved 181 → 234 against Godot's 234.** Blue is the
> channel where sRGB→linear is the identity, so it is the one channel the
> colour-space difference below cannot touch — and it now agrees exactly. Red
> and green do not (86/148 against 38/89), and that gap is the SAME RD
> linearization the ADD cluster documents: predicting Godot's MIX core from the
> linearized colour `(0.0732, 0.3185, 1.0)` at alpha `1 − 0.65⁴` over the gray
> backdrop gives (38.1, 89.5, 232.3) against a measured (38, 89, 234), while the
> un-linearized prediction gives (85.6, 148.5, 232.3) against the browser's
> (86, 148, 234). Both engines are within ~2/255 of their own model. The browser
> matches GLES3; the Forward+ capture is the outlier.
>
> **How it is guarded now.** Three ways, none of which existed before.
> `packages/html/test/shared-gl.test.ts` pins the `getContext("webgl2", …)`
> attributes (nothing asserted them at all);
> `packages/html/test/particles-render.test.ts` asserts the fragment text and
> its blend factors TOGETHER, plus their arithmetic equivalence to the pair they
> replaced; and `packages/test-harness/test/webglCompositeXvfb.test.ts` samples
> a known 50%-alpha dot through the REAL page compositor under Xvfb — the only
> place a canvas's declared alpha mode is observable, since no readback of
> either canvas can see it. The WebGL↔WebGPU parity suite also carries a
> per-channel byte metric beside pixelmatch now, because pixelmatch scored this
> at "zero differing pixels" on every fixture while the two backends disagreed
> by up to 64 bytes on a channel (see
> `packages/test-harness/src/webgpu-parity/fixtures.ts`).

- **ADD cluster — the additive algebra is right.** This was established BEFORE
  the colour-space fix and is the reason that fix could be trusted: the browser
  read (240, 224, 172) against a predicted
  `128 + 255·4·0.11·(1, 0.85, 0.4)` = (240, 223, 173), and Godot read
  (239, 203, 143) against the same expression with the colour linearized,
  `128 + 255·4·0.11·(1, srgbToLinear(0.85), srgbToLinear(0.4))` =
  (240, 205, 142). Both engines landed within ~1/255 of their own model, at four
  particles deep, through the browser's three-stage accumulate/resolve/
  `plus-lighter` path — so the blending was already proven correct and the only
  free variable left was the colour. The hand-derived algebra reproduces Godot's
  one-step `SRC_ALPHA, ONE`. Since the fix, the browser reads (240, 204, 144)
  against Godot's (239, 203, 143), i.e. it now matches the second prediction
  rather than the first.

> **RESOLVED 2026-08-21 — the residual ADD/MIX difference was colour space, not
> blending.** Godot converts `ParticleProcessMaterial.color` sRGB→linear once at
> UBO-upload time (RGB only, alpha untouched) and writes it into an sRGB canvas
> with no inverse conversion, so the channels sitting at 1.0 — where the curve
> is the identity — always agreed to 1/255 while the others diverged by 21 and
> 33 (ADD) and 48 and 59 (MIX). Confirmed in Godot 4.5.1:
> `scene/resources/particle_process_material.cpp:309` declares
> `color_value : source_color`, `particles_storage.cpp:1768` passes
> `p_use_linear_color = true` unconditionally, and
> `renderer_rd/storage_rd/material_storage.cpp:456-459` (with the user-set-value
> path at `servers/rendering/storage/variant_converters.h:208-213`) does the
> conversion via `Color::srgb_to_linear()`.
>
> **The fix is one injected constant, not a colour-management layer.** RD 2D is
> NOT linear end to end: `hdr_2d` defaults to false, so the render target is
> `R8G8B8A8_UNORM` (`texture_storage.cpp:4308-4314`) and the present blit's
> `convert_to_srgb` is false (`renderer_compositor_rd.cpp:98`). Godot linearizes
> this one property and then forgets to undo it, so gsw reproduces it by
> applying the same curve to the same property — `srgbToLinear` in
> `packages/effects/src/particles/godot-renderer.ts`, Godot's own piecewise
> IEC 61966-2-1 curve with exponent 2.4 (`core/math/color.h:191-197`), RGB only.
>
> **Scope, proven from Godot's own gating.** Every OTHER colour in the RD canvas
> path converts only under `use_linear_colors = render_target_is_using_hdr(...)`
> (`renderer_canvas_render_rd.cpp:669`), so with `hdr_2d` off the canvas
> `modulate` (`:692`), per-rect modulation (`:2408`) and polygon vertex colours
> (`:2622`) are all left alone. `particles_storage.cpp:1768` is the ONE site
> that passes `true` unconditionally. `CPUParticles2D` is untouched too — it
> computes colours on the CPU (`scene/2d/cpu_particles_2d.cpp:1086-1096`) and
> the string `srgb_to_linear` does not occur in that file. So the correction is
> gated on the base colour actually coming from a `ParticleProcessMaterial`
> (`ParticleSpecConfig.baseColorFromProcessMaterial`), and reaches nothing else.
>
> **Where it is applied.** One seam: `normalizeParticleConfig`
> (`packages/effects/src/particles/state.ts`) derives `baseColorRender` from the raw `baseColor`,
> BEFORE `simulate.ts` multiplies the ramp in. That order is Godot's own, and
> Godot's is internally inconsistent — `color_ramp`/`color_initial_ramp` carry
> no `source_color` hint (`particle_process_material.cpp:313-319`), so they are
> sampled RAW and multiplied against a LINEARIZED base
> (`:595-597`, `:626-627`). The two factors are in different colour spaces in
> the engine, so they are here too. `baseColor` itself stays the raw inspector
> value, and the static `<span>` preview keeps using it deliberately: that
> markup mirrors what the Godot inspector shows, not the rendered pixel.
> Because the colour reaches both backends through the shared per-instance
> attribute (`packages/effects/src/particles/instance-buffer.ts`) rather than a per-backend uniform,
> WebGL and WebGPU inherit the correction identically — confirmed by
> `webgpuParityBrowser.test.ts` staying inside its unchanged per-channel byte
> budgets while two of its fixtures carry non-white base colours.
>
> **Which backend the renderer targets is now an option**, defaulting to the
> cause: `GodotHtmlRenderOptions.godotRenderer`, one of `"forward_plus"`
> (default), `"mobile"` or `"gl_compatibility"`. The first two linearize; the
> third is an exact byte-for-byte no-op and is the opt-out for a capture taken
> under Compatibility.
>
> **Stated limitation — `hdr_2d = true`.** With an HDR 2D viewport Godot's chain
> is a different one: the render target becomes a float format, the canvas
> material path switches to its linear uniform set
> (`renderer_canvas_render_rd.cpp:2272`), and the present blit re-encodes to
> sRGB. The conversion this correction reproduces is then no longer left
> un-undone, so applying it would be WRONG. godot-scene-web models no HDR-2D
> concept at all — it does not parse `rendering/viewport/hdr_2d`, and
> `godotRenderer` cannot express it. A consumer on an HDR 2D viewport should set
> `godotRenderer: "gl_compatibility"` to opt out; that is the closest available
> answer, not an exact one. This is a stated limitation, not a silent one.
>
> **What the fixture could NOT settle.** The exponent. At this fixture's
> additive gain, a `pow(x, 2.2)` approximation differs from the real piecewise
> curve by 0.82 bytes on green and 0.04 on blue — under 1/255 everywhere, inside
> the noise the fixture already carries. The Godot source is the only authority
> for the 2.4, which is why
> `packages/html/test/particles-godot-renderer.test.ts` pins it directly.

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
