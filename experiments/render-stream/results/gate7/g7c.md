## Gate 7c result (2026-10-14)

G7c ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7c") adds to `packages/canvas` the
generic Godot `CanvasItem` drawing capabilities that a GSW receiver needs. All of them are opt-in,
and a frame that uses none of them issues the same GL calls as before.

| Capability | API |
| --- | --- |
| Per-vertex colours on `DRAW_TEXTURED_MESH` | `TexturedMeshView.hasVertexColors`, `vertexColors` (straight RGBA per vertex), `premultipliedVertexColors` |
| Straight-alpha storage, premultiplied after filtering | `CanvasTextureOptions.straightAlpha`, `CanvasTextureHandle.straightAlpha` |
| Per-binding wrap and filter (WebGL 2 sampler objects) | `createTextureBinding(handle, { wrap, filter, straightAlpha })`, `TextureWrap` (`clamp`, `repeat`, `mirror`), `TextureFilter`, `TextureSampling`, `TextureBindingOptions`, `CanvasTextureHandle.sampling` |
| Godot `BLEND_MODE_PREMULT_ALPHA` | MIX (the same GL pair) over data marked premultiplied: a binding with `straightAlpha: false`, plus `premultipliedVertexColors`, with the straight modulate as the tint |
| RGB10_A2 offscreen target | `createStageTarget(gl, { format, width, height })`: `bind`, `blit`, `readPixels` (8-bit, top-down), `readPacked` (raw 2_10_10_10 words) |

The draw-list layout change is internal. A mesh's int header grows by one flags int, and colours
are stored after the UVs, so every float offset that `damage.ts` reads is unchanged.

**Checks.** All suites ran under headless=new with ANGLE (NVIDIA, Vulkan 1.4.329, RTX 2060), with
no window and no Xvfb.

- `GSW_CANVAS_MODES_PIXEL=1 vitest run packages/test-harness/test/canvasModesPixel.test.ts`
  (new, 7/7). Every case compares the whole frame against a CPU model written in the test, using
  `compareRgbaBuffers` with `maxChannelDelta: 0` and `maxDiffRatio: 0`, alpha included. The hand
  values below were predicted, and the GPU matched every one.

| Case | Predicted = measured bytes |
| --- | --- |
| Vertex colours: straight texel (200,100,50,128) × straight vertex colour (.5,1,1,.75) × premultiplied tint | (30, 15, 15, 77) |
| Gradient (1,.5,0,1) to (0,.5,1,0) | Decided pixels exact; undecided ones are within 1. The premultiplied-interpolation model misses by 64 |
| Premultiplied source over (51,102,153) | as-given texel (125, 101, 76, 255); same texel read straight (75, 76, 76, 255); vertex colour or straight modulate α .5 (138, 126, 115, 255) |
| Wrap at the s = −0.25 seam, linear | clamp (40,0,0), repeat (160,120,0), mirror (40,0,0); all 6 bands, 0 diff |
| Straight filter (x=3, weights 5/8 opaque and 3/8 half-transparent) | (127, 81, 0, 207) |
| **Sabotage**, premultiply on upload | (153, 55, 0, 207), which misses the straight model by **26** at x=3 (> 1 at the half-transparent edge, as required) |
| RGB10_A2 ramp, 1024 levels | Packed words exact for every colour level. `readPixels` = round(v·255/1023) on all 1024. A `v>>2` model would miss 170 |
| RGB10_A2 stack: base 98/255, then 5 MIX layers of .4 at α .2 | Packed 404, read back as 101. The 8-bit canvas sticks at 98. α .6 is 170 in the target and 153 in the canvas |

- Default paths are unchanged. `canvasPixelXvfb.test.ts` passes 18/18 on main's `packages/canvas`
  and 18/18 on this branch. Its new `GSW_CANVAS_PIXEL_DUMP` wrote all 42 sampled pixels from both
  runs, and the two dumps are **byte-identical**. `canvasGlyphPixelXvfb.test.ts` passes 9/9.
- `pnpm test` 2500 passed / 66 skipped, run with DISPLAY unset so that no headed suite runs. The
  canvas package has 466 tests, including 18 new ones in `godot-modes.test.ts` and the
  export-surface lists. `pnpm build` passes, the canvas typecheck is clean, and biome is clean on
  the touched files.
- Consumer: `../sts2-couch-coop/frontend` was run with `COUCHCOOP_GSW_ROOT=<worktree>`. vitest
  passed 5702, `vue-tsc` passed against a scratch tsconfig whose paths point at the worktree, and
  `vite build` passed. That checkout stays on clean `main`, and spirectl does not import `canvas`.

Images (ignored): `artifacts/canvas-modes-pixel/<case>-<frame>-{actual,expected}.png`, all from
WebGL 2.

### Findings

1. **Q7's translucent-blend `delta1` exists on this GPU, and its mechanism was measured.** The
   fragment colour is converted to the target's colour levels before blending. Vulkan only requires
   precision "no lower than the destination". A straight texel premultiplied in the shader
   (50.196 → 50) gave 75, where an in-blend multiply (Godot's `SRC_ALPHA`) gives 76. The alpha
   factor is not converted first: a stack of RGB10_A2 layers at α .2 composites as .2, not as the
   2-bit value 1/3. G7a could get exact MIX by having the shader output straight colour and the
   blend use `SRC_ALPHA`. That is a possible later executor option; it was not taken here, because
   the contract pre-registers premultiplied blending plus `delta1`.
2. **The 2-bit alpha of RGB10_A2 does not round at the midpoints.** A blended α of i/1023 switches
   level at i = 192, 512 and 832, against the midpoints 171, 512 and 853. Vulkan's
   `convertFloatToUint` allows either neighbour. Models have to treat α within 1/16 of a level of a
   midpoint as undecided.
3. **A raw `blitFramebuffer` from RGB10_A2 to the 8-bit canvas does not convert the way
   `readPixels` does.** On the ramp, 95 of 2048 pixels came out one level low; all of them were
   values 0.50 to 0.55 of a level above a midpoint. `StageTarget.blit()` is therefore a
   one-triangle `texelFetch` draw that writes `floor(c·255 + 0.5)/255`, so the canvas holds
   exactly the readback (0 diff). Without it, Q7's `compositor-equals-readback` could not pass.
4. **Interpolated vertex colours are good to about 0.02 of a level.** A gradient value of 55.517
   came back 55. Gradient pixels within 0.05 of a midpoint are undecided, which is the contract's
   `delta1` for vertex-colour interpolation.

### Deviations

- **There is no `BLEND_PREMUL_ALPHA`.** Adding a fifth `BlendMode` broke couch-coop's `vue-tsc`:
  `paintDump.ts:203` indexes a four-entry tuple by `view.blend`. That would have been a breaking
  change on the shared path. The capability ships as alpha interpretation on the data, as shown
  in the table above, and is recorded "As built" in the design doc.
- `canvasPixelXvfb.test.ts` gains `GSW_CANVAS_PIXEL_HEADLESS=new`, the real GPU with no window.
  Before this, its only choices were a headed run or SwiftShader. It also gains the dump option.
- The Pixi renderer (`./pixi`) ignores vertex colours and samplers.

### What G7c does not prove

It proves nothing about Godot itself. The models are written from GL, Vulkan and Godot source and
checked on one GPU. Whether GSW's MIX matches Godot's to 0 or to 1 is G7a's comparison. G7c also
does not provide Godot's opaque-target alpha (`ZERO, ONE`, `rasterizer_canvas_gles3.cpp:755-799`),
under which MUL leaves the destination's alpha alone and multiplies straight colour. That is left
to G7s's material mapping.

