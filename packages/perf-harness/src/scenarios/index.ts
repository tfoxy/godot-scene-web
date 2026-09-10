import { ancestorRescale } from "./ancestor-rescale";
import { atlasSprites } from "./atlas-sprites";
import { effectsRuntime } from "./effects-runtime";
import { effectsWebgpu } from "./effects-webgpu";
import { effectsWebgpuRuntime } from "./effects-webgpu-runtime";
import { largeImageCoexistence } from "./large-image-coexistence";
import { ninePatchAtlas } from "./nine-patch-atlas";
import { staticSurfaces } from "./static-surfaces";
import { textRender } from "./text-render";
import type { Scenario } from "./types";

export const SCENARIOS: Record<string, Scenario> = {
  [atlasSprites.name]: atlasSprites,
  [ancestorRescale.name]: ancestorRescale,
  [largeImageCoexistence.name]: largeImageCoexistence,
  [ninePatchAtlas.name]: ninePatchAtlas,
  [staticSurfaces.name]: staticSurfaces,
  [effectsRuntime.name]: effectsRuntime,
  [effectsWebgpu.name]: effectsWebgpu,
  [effectsWebgpuRuntime.name]: effectsWebgpuRuntime,
  [textRender.name]: textRender,
};

export function getScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(
      `unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`,
    );
  }
  return scenario;
}

export function mechanismsOf(scenario: Scenario): string[] {
  const spec = scenario.params.mechanism;
  if (!spec?.values) {
    return [String(spec?.default ?? "default")];
  }
  return spec.values.map(String);
}

export {
  RESCALE_DRIVERS,
  type RescaleSchedule,
  rescaleKeyframesCss,
  rescaleScaleAt,
} from "./ancestor-rescale";
export {
  buildChurnCell,
  buildParticleNode,
  buildSelfLayer,
  buildShaderNode,
  churnCellsFor,
  counterDelta,
  EFFECTS_COLUMNS,
  EFFECTS_LIFETIME_S,
  EFFECTS_MECHANISMS,
  EFFECTS_MS_COUNTERS,
  EFFECTS_PREPROCESS_S,
  EFFECTS_SEED_BASE,
  EFFECTS_SHADER_PATH,
  EFFECTS_SHADER_SOURCE,
  effectsCanvasPad,
  effectsCellBox,
  effectsGridShape,
  effectsGridSize,
  effectsRuntime,
  effectsSamplePoints,
  effectsSlotPx,
  effectsSpec,
  effectsStageSize,
  paintDecodeCanary,
  particleCounters,
  shaderCounters,
  simCapFixedFps,
  usesFrozenParticles,
  usesParticleRuntime,
} from "./effects-runtime";
export {
  EFFECTS_WEBGPU_MECHANISMS,
  EFFECTS_WEBGPU_PARAMS,
  effectsWebgpu,
  metricKeysFor,
  presentModeOf,
  usesBlit,
  usesParticles,
  usesWebgpu,
  WEBGPU_DOT_PX,
  webgpuCanvasPixels,
  webgpuPixelRatio,
  webgpuUnsupportedParam,
} from "./effects-webgpu";
export {
  EFFECTS_WEBGPU_RUNTIME_MECHANISMS,
  EFFECTS_WEBGPU_RUNTIME_PARAMS,
  effectsRendererFor,
  effectsWebgpuRuntime,
  forcesWebgpuAdapter,
  freezesPopulation,
  frozenSurfaceOptions,
  renameWebgpuBuckets,
  runtimeMetricKeysFor,
  runtimeUsesParticles,
  runtimeUsesWebgpu,
  swapsFrozenSurfaces,
} from "./effects-webgpu-runtime";
export { BACKGROUND_URL_MARKER } from "./large-image-coexistence";
export {
  NINE_PATCH_MECHANISMS,
  NODE_SIZING_VALUES,
  ninePatchSceneText,
  nineSlices,
  patchBoxes,
  patchGridShape,
} from "./nine-patch-atlas";
export {
  SCALE_DIVERSITY_VALUES,
  SPRITE_MECHANISMS,
  spriteGridShape,
  usesUniformRegions,
} from "./sprite-scene";
export {
  blobQualityFor,
  blobTypeFor,
  churnCells,
  STATIC_SURFACE_MECHANISMS,
  SURFACE_COLUMNS,
  SURFACE_PX,
  surfaceBox,
  surfaceGridShape,
  surfaceGridSize,
  usesImgElement,
  usesWorkerBake,
} from "./static-surfaces";
export {
  createHbGpuFonts,
  createHbGpuText,
  HB_GPU_GLUE_URL,
  HB_GPU_WASM_URL,
  type HbGpuTextArm,
  type HbGpuTextPass,
  type HbGpuTextStats,
  hbGpuObjectOrigin,
  loadHbGpuModule,
  shapeRunWithHbGpu,
  textGpuUnsupportedParam,
  textOutlineParamRefusal,
} from "./text-gpu";
export {
  BENCH_FONT_FAMILY,
  distinctGlyphCount,
  hanAt,
  LATIN_BENCH_FONT_FAMILY,
  LATIN_PANGRAM,
  LATIN_PANGRAM_EM_WIDTH,
  LATIN_RUN_EM_WIDTH,
  latinRunBox,
  latinRunString,
  RUN_GAP,
  runBox,
  scriptKinds,
  TEXT_MECHANISMS,
  TEXT_SCRIPTS,
  type TextPlacedRun,
  type TextRunGeometry,
  type TextRunKind,
  type TextScript,
  textCellBoxes,
  textCellSize,
  textGridShape,
  textLayoutFits,
  textPlacedRuns,
  textRender,
  textRunGeometry,
  textRunString,
  textSamplePoints,
  textSceneText,
  textStageSize,
  translationAmplitude,
  translationAt,
} from "./text-render";
export * from "./types";
export { type PackGeometry, packedBytes, packSystem } from "./webgpu/pack";
export {
  INSTANCE_STRIDE_BYTES,
  PARTICLE_FS_ENTRY,
  PARTICLE_VERTEX_BUFFERS,
  PARTICLE_VS_ENTRY,
  PARTICLE_WGSL,
  PREMULTIPLIED_BLEND,
  SHADER_FS_ENTRY,
  SHADER_VS_ENTRY,
  SHADER_WGSL,
} from "./webgpu/wgsl";
export {
  ancestorRescale,
  atlasSprites,
  largeImageCoexistence,
  ninePatchAtlas,
  staticSurfaces,
};
