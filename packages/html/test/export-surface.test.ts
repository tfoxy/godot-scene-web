import { describe, expect, it } from "vitest";
import { parseBarrelExports } from "../../../scripts/parse-barrel-exports";
import * as html from "../src/index";
import indexSource from "../src/index.ts?raw";
import * as runtime from "../src/runtime";

// The consumer imports this package through TypeScript source and mirrors this
// list in an ambient declaration. Keep both runtime and erased type exports
// explicit, so a source-barrel edit cannot silently make that declaration stale.
const VALUE_EXPORTS = `
anchorInsetExpression appendAnchorName positionTryFallback godotSceneBaseCss
ROOT_PARENT_CONTEXT BROWSER_ZOOM_EPSILON BROWSER_ZOOM_REBASE_TOLERANCE
observeBrowserZoom contentScaleScript contentScaleStageStyle observeContentScale
resolveContentScale rewritePxLengths scaleStyleRecord mountHtmlScene unmountHtmlScene ELASTIC_OUT_LINEAR
godotEasingToCss   createEffectsLoopPacer PARK_SLOP_S
EFFECTS_SUSPENDED_ATTR isEffectsSuspended renderFontFaceCss renderGodotNodeHtml
renderGodotSceneHtml colorMatrixFeValues assignMaterialAttributes materialColorMatrix
buildGraphNodeHtml buildHiddenGraphNode buildSceneStructure DEFAULT_BROWSER_VIEWPORT
renderSceneGraphToHtmlModel renderSceneToHtmlModel
 emissionExtentPad spriteExtentPad stabilizeRenderElements
FRAME_CLASS isShowBehindParent partitionChildren SELF_LAYER_CLASS STAGE_CLASS tintFilterDefsMarkup
buildFrameElement buildNodeElement buildNodePresentation buildSceneFragment buildStageElement buildStyleElement
buildTintDefsElement renderElementToDom renderElementToHtml fontResource normalizeResource
uniqueFontFaces DORMANT_DISPOSE_SECONDS isShaderDormant SHADER_DORMANT_ATTR
GODOT_BBCODE_BUILT_IN_EFFECTS godotBbcodeTagKind richTextLayeredHtml applyTextAutoFit
metricFitPredicate resolveTextAutoFitFontSize resolveTextScale setGodotTextScale TEXT_SCALE_VAR
textScaleLength regionBackgroundStyle applyColorMatrixToPixels bakeExternalTextureTints
clampExternalNinePatchSlices  createStaticImageSwapCounters
DEFAULT_ENCODE_BUSY_MAX_DEFER_MS DEFAULT_ENCODE_INTERVAL_MS DEFAULT_ENCODE_MAX_DIM
DEFAULT_ENCODE_PER_TASK DEFAULT_ENCODE_SLICE DEFAULT_ENCODE_SLOW_BACKOFF_MS DEFAULT_ENCODE_SLOW_MS
DEFAULT_ENCODE_TASK_GAP_MS DEFAULT_PARKED_STILL_BYTES DEFAULT_QUIET_WINDOW_MS
DEFAULT_STILL_CACHE_BYTES DEFAULT_SURFACE_WATCHDOG_MS
STABLE_OBSERVATIONS_BEFORE_SWAP STATIC_CAPTURE_BLANK STATIC_SURFACE_IMAGE_ATTR describeGpu
MAX_PINNED_BACKING_DIM MAX_SURFACE_PIXEL_RATIO parseSurfacePixelRatio SURFACE_PIXEL_RATIO_ATTR
reportUnsupportedRender   backingStoreSize effectivePixelRatio
`
  .trim()
  .split(/\s+/);

const TYPE_EXPORTS = `
BrowserNativeParentContext BrowserZoomWindow GodotContentScale GodotContentScaleAspect
GodotContentScaleSize GodotContentScaleTechnique ResolvedContentScale EffectsLoopPacer
EffectsLoopPacing  GraphNodeBuildResult GraphSceneStructure
 RenderElement SceneFragmentOptions
GodotBbcodeTagKind RichTextRenderContext GodotTextScale GodotTextScaleOption ResolvedTextScale
TintBakeImageLoader GodotBbcodeTagDescriptor  GodotHtmlContainerLayout
GodotHtmlFontFace GodotHtmlModel GodotHtmlNode GodotHtmlPositioning GodotHtmlRenderOptions
GodotResolvedResource GodotShaderLoadingFallback GodotTextAutoFitDirective
GodotTextAutoFitNominalMetrics
StaticImageRevertCause StaticImageSwapCounters StaticSurfaceCapture StaticSurfaceContentKeyGate
StaticSurfaceEncodePacing StaticSurfaceGate StaticSurfaceOption StaticSurfacePolicy
StaticSurfaceQuietWindowGate StaticSurfaceTimerHandle GpuInfo UnsupportedRenderInfo
UnsupportedRenderKind UnsupportedRenderReporter
WebgpuFallbackReason
`
  .trim()
  .split(/\s+/);

describe("@godot-scene-web/html export surface", () => {
  it("exports exactly the checked-in value and type lists", () => {
    expect(Object.keys(html).sort()).toEqual([...VALUE_EXPORTS].sort());
    const parsed = parseBarrelExports(indexSource);
    expect(parsed.values.sort()).toEqual([...VALUE_EXPORTS].sort());
    expect(parsed.types.sort()).toEqual([...TYPE_EXPORTS].sort());
  });

  it("keeps consumer-used constants and runtime methods available", () => {
    expect(html.MAX_SURFACE_PIXEL_RATIO).toBe(4);
    expect(html.SURFACE_PIXEL_RATIO_ATTR).toBe("data-godot-shader-pixel-ratio");
    expect(html.parseSurfacePixelRatio("64")).toBe(4);
    expect(html.godotBbcodeTagKind("rainbow")).toBe("effect");
    expect(html.godotBbcodeTagKind("img")).toBe("image");
    expect(html.godotBbcodeTagKind("br")).toBe("void");
    expect(html.godotBbcodeTagKind("unknown")).toBeUndefined();
    expect(
      html.godotBbcodeTagKind("accent", {
        accent: { kind: "color", value: "red" },
      }),
    ).toBe("color");
    expect(Object.isFrozen(html.GODOT_BBCODE_BUILT_IN_EFFECTS)).toBe(true);
    expect(Object.isFrozen(html.GODOT_BBCODE_BUILT_IN_EFFECTS.rainbow)).toBe(
      true,
    );

    const root = document.createElement("div");
    const shader = runtime.createWebglShaderRuntime(root, {});
    const particles = runtime.createParticleRuntime(root, {});
    for (const method of [
      "setRenderScale",
      "setStaticShaderPixelRatio",
      "setFps",
      "setStaticShaders",
      "invalidateStaticSurfaces",
      "stats",
      "warmPrograms",
    ] as const) {
      expect(typeof shader[method]).toBe("function");
    }
    for (const method of [
      "setRenderScale",
      "setStaticParticlePixelRatio",
      "setFps",
      "setStaticParticles",
      "invalidateStaticSurfaces",
      "stats",
    ] as const) {
      expect(typeof particles[method]).toBe("function");
    }
    shader.dispose();
    particles.dispose();
  });
});
