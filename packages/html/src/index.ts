export {
  anchorInsetExpression,
  appendAnchorName,
  positionTryFallback,
} from "./anchor-css";
export { godotSceneBaseCss } from "./base-css";
export type { BrowserNativeParentContext } from "./browser-layout";
export { ROOT_PARENT_CONTEXT } from "./browser-layout";
export type { BrowserZoomWindow } from "./browser-zoom";
export {
  BROWSER_ZOOM_EPSILON,
  BROWSER_ZOOM_REBASE_TOLERANCE,
  observeBrowserZoom,
} from "./browser-zoom";
export type {
  GodotContentScale,
  GodotContentScaleAspect,
  GodotContentScaleSize,
  GodotContentScaleTechnique,
  ResolvedContentScale,
} from "./content-scale";
export {
  contentScaleScript,
  contentScaleStageStyle,
  observeContentScale,
  resolveContentScale,
  rewritePxLengths,
  scaleStyleRecord,
} from "./content-scale";
export { colorMatrixFeValues } from "./css-values";
export {
  reportUnsupportedRender,
  type UnsupportedRenderInfo,
  type UnsupportedRenderKind,
  type UnsupportedRenderReporter,
} from "./diagnostics";
export { mountHtmlScene, unmountHtmlScene } from "./dom";
export { ELASTIC_OUT_LINEAR, godotEasingToCss } from "./easing";
export {
  createEffectsLoopPacer,
  type EffectsLoopPacer,
  type EffectsLoopPacing,
  PARK_SLOP_S,
} from "./effects-loop-pacing";
export { EFFECTS_SUSPENDED_ATTR, isEffectsSuspended } from "./effects-suspend";
export {
  renderGodotNodeHtml,
  renderGodotSceneHtml,
} from "./html-string";
export { assignMaterialAttributes, materialColorMatrix } from "./material";
export type { GraphNodeBuildResult, GraphSceneStructure } from "./model";
export {
  buildGraphNodeHtml,
  buildHiddenGraphNode,
  buildSceneStructure,
  DEFAULT_BROWSER_VIEWPORT,
  renderSceneGraphToHtmlModel,
  renderSceneToHtmlModel,
} from "./model";
export { emissionExtentPad, spriteExtentPad } from "./particles/extents";
export { stabilizeRenderElements } from "./render-stabilize";
export {
  FRAME_CLASS,
  isShowBehindParent,
  partitionChildren,
  SELF_LAYER_CLASS,
  STAGE_CLASS,
  tintFilterDefsMarkup,
} from "./render-structure";
export type { RenderElement, SceneFragmentOptions } from "./render-tree";
export {
  buildFrameElement,
  buildNodeElement,
  buildNodePresentation,
  buildSceneFragment,
  buildStageElement,
  buildStyleElement,
  buildTintDefsElement,
  renderElementToDom,
  renderElementToHtml,
  renderFontFaceCss,
} from "./render-tree";
export { fontResource, normalizeResource, uniqueFontFaces } from "./resources";
export {
  DORMANT_DISPOSE_SECONDS,
  isShaderDormant,
  SHADER_DORMANT_ATTR,
} from "./shader-dormant";
export {
  createStaticImageSwapCounters,
  DEFAULT_ENCODE_BUSY_MAX_DEFER_MS,
  DEFAULT_ENCODE_INTERVAL_MS,
  DEFAULT_ENCODE_MAX_DIM,
  DEFAULT_ENCODE_PER_TASK,
  DEFAULT_ENCODE_SLICE,
  DEFAULT_ENCODE_SLOW_BACKOFF_MS,
  DEFAULT_ENCODE_SLOW_MS,
  DEFAULT_ENCODE_TASK_GAP_MS,
  DEFAULT_PARKED_STILL_BYTES,
  DEFAULT_QUIET_WINDOW_MS,
  DEFAULT_STILL_CACHE_BYTES,
  DEFAULT_SURFACE_WATCHDOG_MS,
  STABLE_OBSERVATIONS_BEFORE_SWAP,
  STATIC_CAPTURE_BLANK,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticImageRevertCause,
  type StaticImageSwapCounters,
  type StaticSurfaceCapture,
  type StaticSurfaceContentKeyGate,
  type StaticSurfaceEncodePacing,
  type StaticSurfaceGate,
  type StaticSurfaceOption,
  type StaticSurfacePolicy,
  type StaticSurfaceQuietWindowGate,
  type StaticSurfaceTimerHandle,
} from "./surface-image-swap";
export {
  GODOT_BBCODE_BUILT_IN_EFFECTS,
  type GodotBbcodeTagKind,
  godotBbcodeTagKind,
  type RichTextRenderContext,
  richTextLayeredHtml,
} from "./text";
export {
  applyTextAutoFit,
  metricFitPredicate,
  resolveTextAutoFitFontSize,
} from "./text-auto-fit";
export type {
  GodotTextScale,
  GodotTextScaleOption,
  ResolvedTextScale,
} from "./text-scale";
export {
  resolveTextScale,
  setGodotTextScale,
  TEXT_SCALE_VAR,
  textScaleLength,
} from "./text-scale";
export { regionBackgroundStyle } from "./textures";
export type { TintBakeImageLoader } from "./tint-bake";
export {
  applyColorMatrixToPixels,
  bakeExternalTextureTints,
  clampExternalNinePatchSlices,
} from "./tint-bake";
export type {
  GodotBbcodeTagDescriptor,
  GodotHtmlContainerLayout,
  GodotHtmlFontFace,
  GodotHtmlModel,
  GodotHtmlNode,
  GodotHtmlPositioning,
  GodotHtmlRenderOptions,
  GodotResolvedResource,
  GodotShaderLoadingFallback,
  GodotTextAutoFitDirective,
  GodotTextAutoFitNominalMetrics,
} from "./types";
export {
  backingStoreSize,
  describeGpu,
  effectivePixelRatio,
  type GpuInfo,
  MAX_PINNED_BACKING_DIM,
  MAX_SURFACE_PIXEL_RATIO,
  parseSurfacePixelRatio,
  SURFACE_PIXEL_RATIO_ATTR,
} from "./webgl/shared-gl";
// The only WebGPU name a consumer needs: what `stats().webgpuFallbackReason` can say. Everything
// else about the WebGPU path — devices, pipelines, texture caches, the backend itself — is chosen by
// `effectsRenderer` and reported through the stats, never constructed by a caller.
export type { WebgpuFallbackReason } from "./webgpu/device";
