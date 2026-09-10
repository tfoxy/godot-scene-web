import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as canvas from "../src/index";
// The barrel's own SOURCE, so the type-only re-exports (which leave no runtime
// trace) can be checked too.
import indexSource from "../src/index.ts?raw";

// The package's public surface is checked in as a literal list on purpose.
// Consumers (couch-coop's mirror, most notably) hand-maintain an ambient `.d.ts`
// for `@godot-scene-web/*`, which silently rots when an export here is renamed,
// added or dropped. A failure below is not a bug in the test: update the list,
// then update every hand-written declaration that mirrors it.

const VALUE_EXPORTS = [
  "applyColorMatrix01",
  "BLEND_ADD",
  "BLEND_MIX",
  "BLEND_MUL",
  "BLEND_SUB",
  "blendStateFor",
  "clamp01",
  "COLOR_MATRIX_FLOATS",
  "colorMatricesEqual",
  "commandDamageBounds",
  "compileDrawList",
  "createCanvasExecutor",
  "createCanvasStage",
  "createClipRectView",
  "createClipStack",
  "createCompiledReplayMask",
  "createDamageRect",
  "createDamageTiles",
  "createDrawList",
  "createDrawListFragment",
  "createDrawListPatchView",
  "createHeadlessGodotParticleDirectEffect",
  "createHeadlessScreenEffectCommand",
  "createGlyphsView",
  "createNinePatchBand",
  "createNinePatchBands",
  "createNinePatchView",
  "createPolylineView",
  "createQuadBatcher",
  "createQuadInstance",
  "createQuadView",
  "createTexturedMeshView",
  "createRgba",
  "createReplayMask",
  "createReplayMaskScratch",
  "createRetainedSurface",
  "createScissorBox",
  "createTextureCache",
  "DEFAULT_COLOR_MATRIX_SLOTS",
  "damageIntersects",
  "DRAW_CLIP_POP",
  "DRAW_CLIP_PUSH",
  "DRAW_COMMAND_NAMES",
  "DRAW_EXTERNAL_EFFECT",
  "DRAW_GLYPHS",
  "DRAW_NINE_PATCH",
  "DRAW_POLYLINE",
  "DRAW_QUAD",
  "DRAW_SCREEN_EFFECT",
  "DRAW_TEXTURED_MESH",
  "expandNinePatch",
  "expandPolyline",
  "FLIP_H",
  "FLIP_V",
  "IDENTITY_COLOR_MATRIX",
  "INSTANCE_COLOR_OFFSET",
  "INSTANCE_CORNERS_OFFSET",
  "INSTANCE_FLOATS",
  "INSTANCE_SLOTS_OFFSET",
  "INSTANCE_UV_OFFSET",
  "isAxisAligned",
  "isDamageEmpty",
  "isIdentityColorMatrix",
  "MAX_TEXTURE_SLOTS",
  "modulatePremultiplied",
  "POLYLINE_QUAD_FLOATS",
  "polylineQuadCapacity",
  "premultiply",
  "outsetDamageRect",
  "RETAINED_DAMAGE_TILE_SIZE",
  "RETAINED_MAX_DAMAGE_COVERAGE",
  "RETAINED_MAX_REPLAY_FRACTION",
  "setViewColorMatrix",
  "shadeQuadPixel",
  "snapRetainedSize",
  "STAGE_CONTEXT_ATTRIBUTES",
  "unpremultiply",
  "isPartialReplayMask",
  "maxPartialReplayCommands",
  "transformDamageRect",
  "unionDamageRect",
];

const TYPE_EXPORTS = [
  "Batch",
  "BatcherStats",
  "BatchFlushReason",
  "BatchTexture",
  "BlendMode",
  "BlendState",
  "CanvasExecutor",
  "CanvasExecutorOptions",
  "CanvasStage",
  "CanvasStageOptions",
  "CanvasTextureCache",
  "CanvasTextureHandle",
  "CanvasTextureOptions",
  "CanvasTextureSource",
  "CommandBounds",
  "CommandMask",
  "CompiledBatchDescriptor",
  "CompiledDrawList",
  "CompiledDrawListDiagnostics",
  "CompiledRefreshResult",
  "ClipBounds",
  "ClipRectView",
  "ClipStack",
  "DamageRect",
  "DamageTile",
  "DamageTiles",
  "DamageTransform",
  "DirtyRect",
  "DrawCommandKind",
  "DrawCommandName",
  "DrawList",
  "DrawListFragment",
  "DrawListFragmentPatch",
  "DrawListOptions",
  "DrawListPatchView",
  "ExternalEffectDrawCommand",
  "ExternalEffectDrawContext",
  "ExecuteOptions",
  "ExecutorStats",
  "ExecutorTexture",
  // The glyph SEAM is on the main barrel; the hb-gpu-backed implementation of it is not — it is
  // reached through the `./glyphs` subpath, so a draw list with no text drags in no glyph
  // renderer. Nothing from `./glyph-pass-hbgpu` belongs in either list below.
  "GlyphPass",
  "GlyphsView",
  "NinePatchBand",
  "NinePatchGeometry",
  "NinePatchView",
  "PixelTransform",
  "PolylineView",
  "QuadBatcher",
  "QuadBatcherOptions",
  "QuadInstance",
  "QuadView",
  "ReplayMaskScratch",
  "TexturedMeshView",
  "Rgba",
  "RoundedClip",
  "ScreenEffectDrawCommand",
  "ScreenEffectDrawContext",
  "ReplaySelectionOptions",
  "RetainedReplayOptions",
  "RetainedReplayRegion",
  "RetainedReplayRegionsOptions",
  "RetainedSurface",
  "ScissorBox",
  "StageCanvas",
  "StageProjection",
  "TextureCacheStats",
];

describe("@godot-scene-web/canvas export surface", () => {
  it("exports exactly the checked-in value list", () => {
    expect(Object.keys(canvas).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it("re-exports exactly the checked-in type list", () => {
    const parsed = parseBarrelExports(indexSource);
    expect(parsed.types.sort()).toEqual([...TYPE_EXPORTS].sort());
    expect(parsed.values.sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it("pins the numeric command-kind and blend-mode constants", () => {
    // These numbers are stored in typed arrays and read back by an executor, so
    // they are part of the contract, not an implementation detail.
    expect(canvas.DRAW_QUAD).toBe(0);
    expect(canvas.DRAW_NINE_PATCH).toBe(1);
    expect(canvas.DRAW_POLYLINE).toBe(2);
    expect(canvas.DRAW_CLIP_PUSH).toBe(3);
    expect(canvas.DRAW_CLIP_POP).toBe(4);
    expect(canvas.DRAW_GLYPHS).toBe(5);
    expect(canvas.DRAW_TEXTURED_MESH).toBe(6);
    expect(canvas.DRAW_SCREEN_EFFECT).toBe(7);
    expect(canvas.DRAW_EXTERNAL_EFFECT).toBe(8);
    expect(canvas.DRAW_COMMAND_NAMES).toEqual([
      "quad",
      "ninePatch",
      "polyline",
      "clipPush",
      "clipPop",
      "glyphs",
      "texturedMesh",
      "screenEffect",
      "externalEffect",
    ]);

    // Godot CanvasItemMaterial.BlendMode ordering.
    expect(canvas.BLEND_MIX).toBe(0);
    expect(canvas.BLEND_ADD).toBe(1);
    expect(canvas.BLEND_SUB).toBe(2);
    expect(canvas.BLEND_MUL).toBe(3);

    expect(canvas.FLIP_H).toBe(1);
    expect(canvas.FLIP_V).toBe(2);
  });

  it("exposes the factories as callable functions", () => {
    expect(typeof canvas.createDrawList).toBe("function");
    expect(typeof canvas.createDrawListFragment).toBe("function");
    expect(typeof canvas.createQuadView).toBe("function");
    expect(typeof canvas.createNinePatchView).toBe("function");
    expect(typeof canvas.createPolylineView).toBe("function");
    expect(typeof canvas.createClipRectView).toBe("function");
    expect(typeof canvas.createGlyphsView).toBe("function");
    expect(typeof canvas.createTexturedMeshView).toBe("function");
    expect(typeof canvas.setViewColorMatrix).toBe("function");
  });
});
