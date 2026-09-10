export type {
  Batch,
  BatcherStats,
  BatchFlushReason,
  BatchTexture,
  QuadBatcher,
  QuadBatcherOptions,
  QuadInstance,
} from "./batcher";
export {
  COLOR_MATRIX_FLOATS,
  createQuadBatcher,
  createQuadInstance,
  DEFAULT_COLOR_MATRIX_SLOTS,
  INSTANCE_COLOR_OFFSET,
  INSTANCE_CORNERS_OFFSET,
  INSTANCE_FLOATS,
  INSTANCE_SLOTS_OFFSET,
  INSTANCE_UV_OFFSET,
  MAX_TEXTURE_SLOTS,
} from "./batcher";
export type {
  ClipBounds,
  ClipStack,
  PixelTransform,
  RoundedClip,
  ScissorBox,
} from "./clip-stack";
export { createClipStack, createScissorBox, isAxisAligned } from "./clip-stack";
export type { Rgba } from "./color";
export {
  applyColorMatrix01,
  clamp01,
  colorMatricesEqual,
  createRgba,
  IDENTITY_COLOR_MATRIX,
  isIdentityColorMatrix,
  modulatePremultiplied,
  premultiply,
  shadeQuadPixel,
  unpremultiply,
} from "./color";
export type {
  CompiledBatchDescriptor,
  CompiledDrawList,
  CompiledDrawListDiagnostics,
  CompiledRefreshResult,
} from "./compiled-draw-list";
export {
  compileDrawList,
  createCompiledReplayMask,
} from "./compiled-draw-list";
export type {
  CommandBounds,
  DamageRect,
  DamageTile,
  DamageTiles,
  DamageTransform,
  DirtyRect,
} from "./damage";
export {
  commandDamageBounds,
  createDamageRect,
  createDamageTiles,
  damageIntersects,
  isDamageEmpty,
  outsetDamageRect,
  RETAINED_DAMAGE_TILE_SIZE,
  RETAINED_MAX_DAMAGE_COVERAGE,
  transformDamageRect,
  unionDamageRect,
} from "./damage";
export type {
  BlendMode,
  ClipRectView,
  DrawCommandKind,
  DrawCommandName,
  DrawList,
  DrawListFragment,
  DrawListFragmentPatch,
  DrawListOptions,
  DrawListPatchView,
  ExternalEffectDrawCommand,
  ExternalEffectDrawContext,
  GlyphsView,
  NinePatchView,
  PolylineView,
  QuadView,
  ScreenEffectDrawCommand,
  ScreenEffectDrawContext,
  TexturedMeshView,
} from "./draw-list";
export {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  createClipRectView,
  createDrawList,
  createDrawListFragment,
  createDrawListPatchView,
  createGlyphsView,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTexturedMeshView,
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_COMMAND_NAMES,
  DRAW_EXTERNAL_EFFECT,
  DRAW_GLYPHS,
  DRAW_NINE_PATCH,
  DRAW_POLYLINE,
  DRAW_QUAD,
  DRAW_SCREEN_EFFECT,
  DRAW_TEXTURED_MESH,
  FLIP_H,
  FLIP_V,
  setViewColorMatrix,
} from "./draw-list";
export type {
  BlendState,
  CanvasExecutor,
  CanvasExecutorOptions,
  ExecuteOptions,
  ExecutorStats,
  ExecutorTexture,
} from "./executor-webgl";
export { blendStateFor, createCanvasExecutor } from "./executor-webgl";
// The INTERFACE only. Its hb-gpu-backed implementation lives on the `./glyphs` subpath, so a scene
// with no text does not pull a glyph renderer in — see `./glyph-pass`'s note.
export type { GlyphPass } from "./glyph-pass";
export {
  createHeadlessGodotParticleDirectEffect,
  createHeadlessScreenEffectCommand,
} from "./headless-effects";
export type { NinePatchBand, NinePatchGeometry } from "./nine-patch";
export {
  createNinePatchBand,
  createNinePatchBands,
  expandNinePatch,
} from "./nine-patch";
export {
  expandPolyline,
  POLYLINE_QUAD_FLOATS,
  polylineQuadCapacity,
} from "./polyline";
export type {
  CanvasStage,
  CanvasStageOptions,
  StageCanvas,
  StageProjection,
} from "./present";
export { createCanvasStage, STAGE_CONTEXT_ATTRIBUTES } from "./present";
export type {
  CommandMask,
  ReplayMaskScratch,
  ReplaySelectionOptions,
} from "./replay";
export {
  createReplayMask,
  createReplayMaskScratch,
  isPartialReplayMask,
  maxPartialReplayCommands,
  RETAINED_MAX_REPLAY_FRACTION,
} from "./replay";
export type {
  RetainedReplayOptions,
  RetainedReplayRegion,
  RetainedReplayRegionsOptions,
  RetainedSurface,
} from "./retained-surface";
export { createRetainedSurface, snapRetainedSize } from "./retained-surface";
export type {
  CanvasTextureCache,
  CanvasTextureHandle,
  CanvasTextureOptions,
  CanvasTextureSource,
  TextureCacheStats,
} from "./textures";
export { createTextureCache } from "./textures";
