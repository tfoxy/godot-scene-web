### G7c — canvas package: vertex colours, premul_alpha, wrap, straight alpha, RGB10_A2 (opus)

- **Files**: `packages/canvas/src/` (`draw-list.ts`, `executor-webgl.ts`, `textures.ts`,
  `present.ts`, and their tests). All additions are generic Godot `CanvasItem` drawing capabilities:
  - per-vertex colours on `DRAW_TEXTURED_MESH` (optional colour stream; existing callers
    unchanged);
  - a `BLEND_PREMUL_ALPHA` mode;
  - texture wrap per binding (`clamp`, `repeat`, `mirror` through WebGL 2 sampler objects);
  - a straight-alpha texture flag that premultiplies after sampling;
  - an optional RGB10_A2 stage target with blit and a readback helper.

  The export-surface tests are updated for the new public names.
- **Checks**: canvas pixel-suite cases for each addition against hand-computed pixels (raw channel
  budget 0); straight-alpha linear filtering equals a CPU model of filter-then-premultiply; the
  RGB10_A2 readback matches 10→8-bit conversion on a ramp; existing suites unchanged; the
  downstream consumer check.
- **Sabotage**: a test variant that premultiplies on upload instead must fail the straight-alpha
  filtering case by a channel delta > 1 at a half-transparent edge.
- **As built (G7c, 2026-10-14)**, details in the README's "Gate 7c result":
  - **No `BLEND_PREMUL_ALPHA` constant.** Widening `BlendMode` broke the consumer typecheck
    (`../sts2-couch-coop` indexes a 4-tuple by it). Godot's PMALPHA pair is this executor's MIX
    state, so the capability is on the data instead: `createTextureBinding(handle,
    { straightAlpha: false })`, `TexturedMeshView.premultipliedVertexColors`, and the straight
    modulate passed as the tint. G7s maps `premul_alpha` to that recipe.
  - **`StageTarget.blit()` for `rgb10_a2` is a rounding draw, not `blitFramebuffer`.** The raw blit
    put 95 of 2048 ramp pixels one level below `readPixels`, so `compositor-equals-readback` could
    never pass. The draw writes `floor(c·255 + 0.5)/255`, which makes the canvas equal the readback.
  - **Q7's `delta1` for translucent MIX is real on this GPU.** A shader-premultiplied source is
    converted to the target's colour levels before the blend: 50.196 became 50, so the result was
    75 where Godot's in-blend multiply would give 76. Alpha is not converted first. RGB10_A2's
    2-bit alpha switches at 192, 512 and 832 of 1023, not at the midpoints 171, 512 and 853.
    Interpolated vertex colours are good to about 0.02 of a level.

