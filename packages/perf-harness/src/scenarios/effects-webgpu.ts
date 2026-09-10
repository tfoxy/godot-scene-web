import { InstanceBuffer } from "@godot-scene-web/effects/particles";
// S7 `effects-webgpu` — a QUARANTINED WebGPU probe, measured against the shipped WebGL pipeline.
//
// THE QUESTION. S6 `effects-runtime` took a live particle frame apart on the moto g86 5G and the
// answer was NOT the CPU sim: the simulation costs 71.9 ms of a 2 507 ms window (under 3% of a
// core), while the GPU PROCESS runs ~0.9 of a core inside that same window — identically for
// `particles-live` and `shaders-live` — and both live pipelines drag whole-page activations from
// the ~89 Hz the frozen arm proves the compositor can do down to ~47 Hz. The main-thread split was
// simMs 71.9 / buildMs 15.6 / glMs 62.6 / blitMs 353.2. That verdict indicts the ARCHITECTURE, not
// the workload: one shared offscreen WebGL canvas → a `ctx2d.drawImage` blit per node → N composited
// canvases. So there are exactly two follow-up questions, and this scenario is built to separate
// them:
//
//   (a) does WebGPU cut the main-thread SUBMIT cost (`glMs`, 62.6 ms), and
//   (b) does rendering DIRECTLY into N canvases — no blit at all — relieve the GPU process?
//
// PROBE, NOT PRODUCT. Every other scenario in this harness mounts shipped code, and re-deriving the
// thing under test is the failure they exist to avoid. This one is allowed to carry its own renderer
// for one reason: the subject is an API and an architecture THAT DO NOT EXIST IN THE CODEBASE, so
// there is no shipped WebGPU path to mount and a probe is the only way to price one before writing
// it. What is NOT re-derived is everything above the renderer — the CPU simulation, the instance
// packing, the canvas-pixel laws and the whole geometry are IMPORTED (from
// `@godot-scene-web/core`, `@godot-scene-web/html`, and S6 itself), because a probe that re-derived
// those would be comparing two workloads and calling the difference an API.
//
// THE FIVE ARMS, in the order they are declared, and each one's job:
//
//   particles-webgl       the REAL `createParticleRuntime`, mounted exactly as S6's `particles-live`
//                         does. The IN-SESSION reference: S6's published numbers came off a
//                         different run, and a cross-run comparison would fold in whatever the phone
//                         was doing that day.
//   particles-webgpu      imported sim + imported packing + WebGPU rendering DIRECTLY into each
//                         node's own canvas. One device, N configured contexts, one pass per canvas,
//                         ONE submit per frame. No blit exists.
//   particles-webgpu-blit the identical WebGPU pipeline into ONE shared canvas with N `setViewport`
//                         sub-rects in ONE pass, then the same N `drawImage` blits the shipped path
//                         does. This is what separates "WebGPU the API" from "skipping the blit":
//                         it is the shipped ARCHITECTURE with only the API swapped.
//   shaders-webgl         the real `createWebglShaderRuntime`, as S6's `shaders-live`.
//   shaders-webgpu        the WGSL port of S6's `EFFECTS_SHADER_SOURCE`, direct per-node canvases,
//                         TIME-driven every frame.
//
// The verdict arithmetic is in `docs/perf-harness.md`. Its shape: `webgpu-blit ≈ webgl` means the
// API is not the lever; `webgpu-direct ≈ webgpu-blit` means the blit is not the lever;
// `webgpu-direct ≫ both` means the win is skipping the blit. A win counts only if it shows in BOTH
// `contentUpdateHz` and GPU-process CPU, on BOTH pairs, in the same session.
//
// WHY `submitMs` AND NOT `glMs`. The webgl arms report the runtime's own `glMs`, which is GL submit
// cost. The webgpu arms report `submitMs`, which is the same class of measurement — main-thread time
// spent telling the GPU what to do — but it is NOT GL, and giving both the same key would let a
// table reader median them together across arms. A missing key is "not measured"; a wrongly SHARED
// key is worse, because it is measured and mislabelled.
//
// WHY A MISSING `blitMs` IS THE POINT. The two direct arms report no `blitMs` and no `blits`, and
// that absence is the architecture rather than an omission: there is no blit to time. The blit arm
// reports both. If a future reader adds a `blitMs: 0` to the direct arms "for symmetry", the
// scenario stops being able to say what it was built to say.
//
// WHAT IT DOES NOT ANSWER. `blend=1` (Godot ADD) is REFUSED on the webgpu arms rather than silently
// mis-rendered — see `webgpuUnsupportedParam`. And desktop is SwiftShader: a smoke test that the
// arms mount and report, never an answer.

import {
  createParticleState,
  type ParticleSystemState,
  preprocessParticles,
  simulateParticles,
} from "@godot-scene-web/effects/particles";
import {
  backingStoreSize,
  effectivePixelRatio,
  SELF_LAYER_CLASS,
} from "@godot-scene-web/html";
import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";
import {
  createParticleRuntime,
  createWebglShaderRuntime,
  type ParticleRuntime,
  parseParticleSpecConfig as parseParticleConfig,
  type WebglShaderRuntime,
} from "@godot-scene-web/html/runtime";
import type { GridShape } from "../fit";
import {
  churnCellsFor,
  counterDelta,
  decodeCanaryUrl,
  EFFECTS_CANARY_PX,
  EFFECTS_SHADER_PATH,
  EFFECTS_SHADER_SOURCE,
  effectsCanvasPad,
  effectsCellBox,
  effectsGridShape,
  effectsSamplePoints,
  effectsSlotPx,
  effectsSpec,
  effectsStageSize,
  particleCounters,
  shaderCounters,
} from "./effects-runtime";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";
import { packSystem } from "./webgpu/pack";
import {
  acquireGpu,
  type CellTarget,
  configureCanvas,
  createParticleRenderer,
  createShaderRenderer,
  type EffectRenderer,
  type GpuHandle,
  type PresentMode,
} from "./webgpu/renderer";

export const EFFECTS_WEBGPU_MECHANISMS = [
  "particles-webgl",
  "particles-webgpu",
  "particles-webgpu-blit",
  "shaders-webgl",
  "shaders-webgpu",
];

/** How long `ready()` waits for every cell to present its first frame. S6's timeout, for its reason. */
const READY_TIMEOUT_MS = 8000;

/** The churn strip's geometry — S6's, so the two scenarios' stage boxes are the same box. */
const CHURN_WIDTH = 44;
const CHURN_HEIGHT = 56;

/**
 * The untextured sprite frame, in CSS px: the particle runtime's module-private `DEFAULT_DOT`.
 *
 * It is private, so it cannot be imported, so it is stated here — and a stated copy of somebody
 * else's constant is exactly the kind of thing that rots silently. The guard is a test rather than a
 * comment: `effectsCanvasPad(defaults)` must equal `ceil(hypot(16, 16) / 2)`, which is what
 * `spriteExtentPad` computes for an untextured system at scale 1. If the runtime ever moves
 * `DEFAULT_DOT`, the pad moves with it and the assertion fails — before the probe starts drawing
 * dots of one size into canvases padded for another.
 */
export const WEBGPU_DOT_PX = 16;

/** The counter keys reported in MILLISECONDS, and therefore rounded before they leave `metrics()`. */
const MS_COUNTERS = new Set(["simMs", "buildMs", "submitMs", "blitMs"]);

/** Largest per-frame `dt` handed to the sim, in seconds: a backgrounded tab must not fast-forward. */
const MAX_FRAME_DT_S = 0.1;

export const EFFECTS_WEBGPU_PARAMS: Record<
  string,
  { default: ParamValue; values?: ParamValue[]; describe: string }
> = {
  mechanism: {
    default: "particles-webgl",
    values: EFFECTS_WEBGPU_MECHANISMS,
    describe:
      "which renderer draws the effects, and whether its output reaches the node through a blit",
  },
  systems: {
    default: 12,
    describe: "particle systems (or shader cells) mounted on the stage",
  },
  amount: { default: 64, describe: "particles per system" },
  cellPx: {
    default: 96,
    describe:
      "one system's node box in CSS px; its canvas is this plus the runtime's own sprite/emission pad on every side, on EVERY arm",
  },
  overLife: {
    default: "ramps",
    values: ["ramps", "none"],
    describe:
      "`ramps` gives every particle a colour ramp + alpha/scale curves, so the sim pays the per-particle sampleGradient/sampleCurve chain; `none` omits them. Identical on every arm — the sim is imported, not re-derived",
  },
  blend: {
    default: 0,
    values: [0, 1],
    describe:
      "CanvasItemMaterial blend mode: 0 mix. 1 (ADD) is REFUSED on the webgpu arms — the accumulate+resolve pass is not ported — see `webgpuUnsupportedParam`",
  },
  fps: {
    default: 0,
    describe:
      "FPS cap. 0 = uncapped. NOTE: on the webgpu arms this is a rAF-SKIP, not the runtime's timer park — a different mechanism at the same rate",
  },
  renderScale: {
    default: 1,
    describe:
      "backing-store multiplier for every effect canvas, on top of devicePixelRatio. Applied through the IMPORTED `effectivePixelRatio`/`backingStoreSize`, so all five arms size the same pixels",
  },
  churn: {
    default: 8,
    describe:
      "unrelated cells repainted every frame beside the effects, so a run always has layer activations the report validator can see (S5's and S6's rule)",
  },
};

function numParam(value: ParamValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mechanismOf(params: { mechanism?: unknown }): string {
  return String(params.mechanism ?? EFFECTS_WEBGPU_MECHANISMS[0]);
}

/** Whether this arm renders through WebGPU (three of the five do). */
export function usesWebgpu(mechanism: string): boolean {
  return mechanism.includes("webgpu");
}

/** Whether this arm simulates particles (three of the five do). */
export function usesParticles(mechanism: string): boolean {
  return mechanism.startsWith("particles-");
}

/** Whether this arm renders into ONE shared canvas and blits N sub-rects out of it. */
export function usesBlit(mechanism: string): boolean {
  return mechanism === "particles-webgpu-blit";
}

/** How this arm's pixels reach the node's box. */
export function presentModeOf(mechanism: string): PresentMode {
  return usesBlit(mechanism) ? "blit" : "direct";
}

/**
 * The parameter combinations this probe REFUSES on a WebGPU arm, and the message it refuses with.
 *
 * `blend: 1` is Godot's ADD, which the shipped GL renderer implements as a SECOND pass — particles
 * sum their raw light into an accumulation FBO with `ONE / ONE`, and a resolve pass normalizes the
 * per-pixel total into straight colour + coverage alpha (`render-webgl.ts`). That two-pass structure
 * is not ported here, and a WGSL fragment that simply blended additively would draw a DIFFERENT
 * PICTURE from the arm it is being compared against — a mis-rendered arm at a plausible frame rate,
 * which is the one result this harness must never publish.
 *
 * So it throws in `ready()`, which aborts the run and says so, instead of rendering something
 * else. Pure and exported, so the refusal is provable without a browser.
 */
export function webgpuUnsupportedParam(
  params: Record<string, ParamValue>,
): string | null {
  const mechanism = mechanismOf(params);
  if (!usesWebgpu(mechanism)) {
    return null;
  }
  if (Math.round(numParam(params.blend, 0)) === 1) {
    return `effects-webgpu: measure additive blending on S6 instead — \`--scenario effects-runtime --param blend=1\` — because \`blend=1\` is not ported to the WebGPU arms. Godot ADD needs the accumulate+resolve pass the shipped GL renderer runs (particles sum raw light into an FBO with ONE/ONE, then a resolve pass normalizes the per-pixel total), and this probe has only the single-pass mix path. Rendering ${mechanism} with a plain additive blend would compare two different pictures.`;
  }
  return null;
}

/**
 * The backing-store box for one effect canvas, from the SHIPPED law.
 *
 * Exported and pure so `test/effects-webgpu.test.ts` can hold it against `backingStoreSize`
 * directly, across ratios and render scales. The point of the test is not that the arithmetic is
 * right — it is that the arithmetic is not HERE: a probe with its own `Math.round(css * dpr)` would
 * drift from the runtime the first time the runtime's changed, and would then be comparing two
 * canvas sizes and calling the difference an API.
 */
export function webgpuCanvasPixels(
  cssW: number,
  cssH: number,
  ratio: number,
): { w: number; h: number; ratio: number } {
  return backingStoreSize(cssW, cssH, ratio);
}

/** The pixel ratio every arm's canvas is sized at — also the shipped law, also imported. */
export function webgpuPixelRatio(renderScale: number): number {
  return effectivePixelRatio(renderScale);
}

/**
 * The key set this arm's `metrics()` block reports, as a pure function of the mechanism.
 *
 * Exported because "which keys exist" IS a claim of this scenario and must be checkable without a
 * browser: `submitMs` must never appear on a WebGL arm (it is not GL), `blits`/`blitMs` must appear
 * on the blit arm and on no other WebGPU arm (there is no blit to time), and the shader arms must
 * carry no `simMs`/`instances` (there is no simulation). A scenario that quietly zero-filled any of
 * those would publish a fabricated number next to measured ones.
 */
export function metricKeysFor(mechanism: string): string[] {
  const particles = usesParticles(mechanism);
  if (!usesWebgpu(mechanism)) {
    // The WebGL arms report exactly what S6 reports — same helpers, same keys.
    return particles
      ? [
          "particleDraws",
          "particleCacheHits",
          "profTicks",
          "profBindings",
          "simSteps",
          "instances",
          "simMs",
          "buildMs",
          "glMs",
          "blitMs",
          "renderedNodes",
          "boxReads",
        ]
      : [
          "shaderDraws",
          "shaderCacheHits",
          "profTicks",
          "profBindings",
          "glMs",
          "blitMs",
          "renderedNodes",
        ];
  }
  return [
    "profTicks",
    "profBindings",
    ...(particles
      ? [
          "simSteps",
          "instances",
          "simMs",
          "buildMs",
          "particleDraws",
          ...(usesBlit(mechanism) ? ["blitMs", "blits"] : []),
        ]
      : ["shaderDraws"]),
    "submitMs",
    "passes",
    "submits",
    "renderedNodes",
    "adapterFallback",
    "gpuErrors",
    "deviceLosses",
  ];
}

/** The counters a WebGPU arm accumulates per frame. Zeroed at the top of the measured window. */
interface WebgpuCounters {
  ticks: number;
  bindings: number;
  simSteps: number;
  instances: number;
  simMs: number;
  buildMs: number;
  submitMs: number;
  passes: number;
  submits: number;
  draws: number;
  blitMs: number;
  blits: number;
}

function zeroCounters(): WebgpuCounters {
  return {
    ticks: 0,
    bindings: 0,
    simSteps: 0,
    instances: 0,
    simMs: 0,
    buildMs: 0,
    submitMs: 0,
    passes: 0,
    submits: 0,
    draws: 0,
    blitMs: 0,
    blits: 0,
  };
}

/** One WebGPU cell: its DOM canvas, its sim state, its packed buffer and where it lands. */
interface Cell {
  /** The node's own canvas. WebGPU-configured on the direct arms, 2D on the blit arm. */
  canvas: HTMLCanvasElement;
  /** The 2D context the blit arm draws into; null on the direct arms (there is no blit). */
  ctx2d: CanvasRenderingContext2D | null;
  state: ParticleSystemState | null;
  originX: number;
  originY: number;
  buffer: InstanceBuffer | null;
  target: CellTarget;
  presented: boolean;
}

interface State {
  container: HTMLElement;
  churn: HTMLElement[];
  nodes: HTMLElement[];
  /** WebGL arms: the shipped runtime handle. Exactly one of these is ever non-null. */
  particles: ParticleRuntime | null;
  shaders: WebglShaderRuntime | null;
  /** WebGL arms: distinct nodes whose binding really drew, from `onBindingRendered`. */
  rendered: Set<HTMLElement>;
  /** WebGL arms: the counters as they stood at the top of the window (see `counterDelta`). */
  windowStart: Record<string, number> | null;
  /** WebGPU arms. */
  gpu: GpuHandle | null;
  renderer: EffectRenderer | null;
  cells: Cell[];
  counters: WebgpuCounters;
  /** True once `step()` has zeroed the counters — i.e. once the measured window has opened. */
  windowOpened: boolean;
  raf: number | null;
  stopped: boolean;
  /**
   * The clock TIME is measured from: `ready()`'s own moment, not the runtime's shared clock origin.
   * Same RATE, different phase, and the docs say so — a wave that starts at a different point in its
   * cycle costs exactly the same to draw.
   */
  originAtReady: number;
  lastFrameMs: number;
  lastTickMs: number;
  /** The FIRST exception the rAF loop threw, kept so `ready()`'s timeout can quote a cause. */
  frameError: string | null;
}

const states = new WeakMap<HTMLElement, State>();

/**
 * The render options the two WEBGL arms are built from — S6's `runtimeOptions`, minus the knobs this
 * scenario does not declare (`simCapHz`, `pacing`, `staticParticles`), so the reference arms are the
 * same code under the same options S6 measured them under.
 */
function runtimeOptions(
  ctx: ScenarioContext,
  state: State,
): GodotHtmlMountOptions {
  const fps = Math.max(0, numParam(ctx.params.fps, 0));
  return {
    enableParticles: true,
    enableWebglShaders: true,
    particleFps: fps,
    shaderFps: fps,
    renderScale: Math.max(0.01, numParam(ctx.params.renderScale, 1)),
    effectsProfiling: true,
    // S6's shader, read through its export rather than copied: the WGSL port in `wgsl.ts` is checked
    // against THIS string's float literals by a test, so the two shader arms really are one shader
    // in two languages.
    resolveShaderSource: () => EFFECTS_SHADER_SOURCE,
    onBindingRendered: (node) => {
      state.rendered.add(node);
    },
  };
}

function buildSelfLayer(): HTMLElement {
  const layer = document.createElement("div");
  layer.className = SELF_LAYER_CLASS;
  Object.assign(layer.style, { position: "absolute", inset: "0" });
  return layer;
}

/** A WEBGL particle node: S6's `buildParticleNode`, unchanged, so the reference arm is the reference. */
function buildParticleNode(
  ctx: ScenarioContext,
  index: number,
  box: { left: number; top: number; size: number },
): HTMLElement {
  const cellPx = numParam(ctx.params.cellPx, 96);
  const pad = effectsCanvasPad(ctx.params);
  const node = document.createElement("div");
  node.className = "effect";
  Object.assign(node.style, {
    position: "absolute",
    left: `${box.left + pad}px`,
    top: `${box.top + pad}px`,
    width: `${cellPx}px`,
    height: `${cellPx}px`,
  });
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute(
    "data-godot-particle-specs",
    JSON.stringify(effectsSpec(ctx.params, index)),
  );
  node.appendChild(buildSelfLayer());
  return node;
}

/** A WEBGL shader node: S6's `buildShaderNode`, unchanged. Fills the WHOLE slot. */
function buildShaderNode(
  index: number,
  box: { left: number; top: number; size: number },
): HTMLElement {
  const node = document.createElement("div");
  node.className = "effect";
  Object.assign(node.style, {
    position: "absolute",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.size}px`,
    height: `${box.size}px`,
  });
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", EFFECTS_SHADER_PATH);
  node.setAttribute("data-godot-shader-uid", `uid://gsw-perf-effects-${index}`);
  node.appendChild(buildSelfLayer());
  return node;
}

/**
 * A WEBGPU node: a plain positioned div carrying ONE canvas this scenario owns outright.
 *
 * No self-layer, no `data-godot-*` attributes — nothing here is reconciled by a runtime, so those
 * would be decoration. What is NOT free to differ is the pixels: the canvas is `effectsSlotPx` on a
 * side in CSS and `webgpuCanvasPixels` in backing store, i.e. the exact box the particle runtime
 * grows its own canvas to (`cellPx + 2*pad`, anchored at `-pad` inside a `cellPx` node) and the
 * exact box the shader arm's node fills. Same cells, same canvas pixel count, on all five arms —
 * which is the only reason their numbers can be subtracted from one another.
 */
function buildWebgpuNode(
  ctx: ScenarioContext,
  box: { left: number; top: number; size: number },
  particles: boolean,
): { node: HTMLElement; canvas: HTMLCanvasElement } {
  const cellPx = numParam(ctx.params.cellPx, 96);
  const pad = effectsCanvasPad(ctx.params);
  const slot = effectsSlotPx(ctx.params);
  const ratio = webgpuPixelRatio(
    Math.max(0.01, numParam(ctx.params.renderScale, 1)),
  );
  const node = document.createElement("div");
  node.className = "effect";
  Object.assign(
    node.style,
    particles
      ? {
          position: "absolute",
          left: `${box.left + pad}px`,
          top: `${box.top + pad}px`,
          width: `${cellPx}px`,
          height: `${cellPx}px`,
        }
      : {
          position: "absolute",
          left: `${box.left}px`,
          top: `${box.top}px`,
          width: `${box.size}px`,
          height: `${box.size}px`,
        },
  );
  const canvas = document.createElement("canvas");
  const { w, h } = webgpuCanvasPixels(slot, slot, ratio);
  canvas.width = w;
  canvas.height = h;
  Object.assign(canvas.style, {
    position: "absolute",
    // The particle canvas is anchored at `-pad` inside its `cellPx` node, exactly as the runtime
    // anchors its own; the shader canvas fills its slot-sized node. Both land on the same rect.
    left: particles ? `${-pad}px` : "0px",
    top: particles ? `${-pad}px` : "0px",
    width: `${slot}px`,
    height: `${slot}px`,
    // Nothing here is interactive, and a hit-test region per canvas is cost the shipped path's
    // runtime-owned canvases also do not pay.
    pointerEvents: "none",
  });
  node.appendChild(canvas);
  return { node, canvas };
}

/**
 * Lay the blit arm's N cells out inside ONE shared canvas, and refuse a layout that would not fit.
 *
 * The shared canvas takes the SAME grid shape the DOM does, so the sub-rects are contiguous and the
 * canvas is no larger than the effects already are. A `maxTextureDimension2D` overflow is thrown
 * rather than silently clamped: a clamped shared canvas would draw a smaller picture than the direct
 * arm and the "blit's share" subtraction would be measuring the clamp.
 */
function sharedLayout(
  device: GPUDevice,
  cellW: number,
  cellH: number,
  count: number,
  columns: number,
): { width: number; height: number; cells: CellTarget[] } {
  const cols = Math.max(1, Math.min(columns, count));
  const rows = Math.ceil(count / cols);
  const width = cols * cellW;
  const height = rows * cellH;
  const limit = device.limits.maxTextureDimension2D;
  if (width > limit || height > limit) {
    throw new Error(
      `effects-webgpu: lower --param systems or --param renderScale — the blit arm's shared canvas would be ${width}x${height} px and this device's maxTextureDimension2D is ${limit}. Clamping it instead would make the blit arm draw a smaller picture than particles-webgpu and the "blit's share" subtraction would be measuring the clamp.`,
    );
  }
  const cells: CellTarget[] = Array.from({ length: count }, (_v, index) => ({
    x: (index % cols) * cellW,
    y: Math.floor(index / cols) * cellH,
    w: cellW,
    h: cellH,
  }));
  return { width, height, cells };
}

/** This arm's runtime counters (WebGL arms only), flattened — S6's `liveCounters`. */
function liveCounters(state: State): Record<string, number> {
  if (state.particles) {
    return particleCounters(state.particles.stats());
  }
  if (state.shaders) {
    return shaderCounters(state.shaders.stats());
  }
  return {};
}

export const effectsWebgpu: Scenario = {
  name: "effects-webgpu",
  params: EFFECTS_WEBGPU_PARAMS,

  /**
   * SYNC, and DOM only. Not one WebGPU call happens here: `mount()` cannot await, and adapter +
   * device + module compilation + pipeline creation are all asynchronous, so doing any of it here
   * would mean either a floating promise (the window opens on a page with no renderer) or a
   * synchronous poll (a busy-wait charged to `readyMs`). All of it is in `ready()`, which is the
   * only hook the runner awaits.
   */
  mount(ctx: ScenarioContext): void {
    // FIRST, before anything can touch the shared GL context — S6's rule, for S6's reason:
    // `shared-gl.ts` DECLINES a software renderer and LATCHES that decision module-scoped on the
    // first `getShared()`. Without this the webgl arms would silently become no-op handles on this
    // headless box and the scenario would measure a blank page at a beautiful frame rate. Harmless
    // on the webgpu arms, which never call into `shared-gl` at all.
    (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

    const mechanism = mechanismOf(ctx.params);
    const particles = usesParticles(mechanism);
    const webgpu = usesWebgpu(mechanism);
    const count = Math.max(1, Math.round(numParam(ctx.params.systems, 12)));
    const { columns } = effectsGridShape(ctx.params, ctx.layout);

    const container = document.createElement("div");
    container.id = "perf-stage";
    Object.assign(container.style, { position: "absolute", inset: "0" });
    // THE DECODE CANARY, shared with S6 rather than reinvented: `validateReport` rejects
    // `decode.count === 0` outright, and this scenario's page paints no images either.
    const canary = decodeCanaryUrl();
    if (canary) {
      Object.assign(container.style, {
        backgroundImage: `url(${canary})`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right bottom",
        backgroundSize: `${EFFECTS_CANARY_PX}px ${EFFECTS_CANARY_PX}px`,
      });
    }
    ctx.root.appendChild(container);

    const nodes: HTMLElement[] = [];
    const cells: Cell[] = [];
    for (let index = 0; index < count; index++) {
      const box = effectsCellBox(index, columns, ctx.params);
      if (!webgpu) {
        const node = particles
          ? buildParticleNode(ctx, index, box)
          : buildShaderNode(index, box);
        container.appendChild(node);
        nodes.push(node);
        continue;
      }
      const { node, canvas } = buildWebgpuNode(ctx, box, particles);
      container.appendChild(node);
      nodes.push(node);
      cells.push({
        canvas,
        ctx2d: null,
        state: null,
        originX: 0,
        originY: 0,
        buffer: null,
        // Overwritten in `ready()` on the blit arm, where a cell is a sub-rect of the shared canvas.
        target: { x: 0, y: 0, w: canvas.width, h: canvas.height },
        presented: false,
      });
    }

    const churn: HTMLElement[] = [];
    for (const { left, top } of churnCellsFor(ctx.params, ctx.layout)) {
      const cell = document.createElement("div");
      cell.className = "churn";
      Object.assign(cell.style, {
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: `${CHURN_WIDTH}px`,
        height: `${CHURN_HEIGHT}px`,
        backgroundColor: "#404058",
      });
      container.appendChild(cell);
      churn.push(cell);
    }

    const state: State = {
      container,
      churn,
      nodes,
      particles: null,
      shaders: null,
      rendered: new Set<HTMLElement>(),
      windowStart: null,
      gpu: null,
      renderer: null,
      cells,
      counters: zeroCounters(),
      windowOpened: false,
      raf: null,
      stopped: false,
      originAtReady: 0,
      lastFrameMs: 0,
      frameError: null,
      lastTickMs: 0,
    };
    if (!webgpu) {
      const options = runtimeOptions(ctx, state);
      if (particles) {
        state.particles = createParticleRuntime(container, options);
        state.particles.reconcile();
      } else {
        state.shaders = createWebglShaderRuntime(container, options);
        state.shaders.reconcile();
      }
    }
    states.set(ctx.root, state);
  },

  /**
   * Everything asynchronous, and every refusal.
   *
   * A throw from here ABORTS THE WHOLE RUN and surfaces as `Runtime.evaluate threw: <first 800
   * chars>`, which is why every message in this scenario front-loads the fix. It is also why the
   * WebGL and WebGPU arms should be smoked in SEPARATE `--mechanism` invocations: one arm that
   * cannot acquire a device takes the other four down with it.
   */
  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state) {
      throw new Error("effects-webgpu: ready() called before mount()");
    }
    const mechanism = mechanismOf(ctx.params);
    if (!usesWebgpu(mechanism)) {
      await readyWebgl(state, mechanism);
      return;
    }
    const refusal = webgpuUnsupportedParam(ctx.params);
    if (refusal) {
      throw new Error(refusal);
    }
    await readyWebgpu(ctx, state, mechanism);
  },

  /**
   * The churn strip, and the window's start.
   *
   * `step()` is the earliest in-window hook a scenario has, so it is where window scoping happens on
   * BOTH kinds of arm — by snapshotting the runtime's monotonic counters on the WebGL arms (S6's
   * `counterDelta`), and by ZEROING this scenario's own counters on the WebGPU arms. The two are the
   * same act: the WebGPU counters belong to this file, so resetting them at the top of the window IS
   * the delta.
   *
   * Nothing else happens here. Every arm's effect work is driven by its own loop — the shipped
   * runtime's, or the rAF loop `ready()` started — because a `step()` that pumped the renderer would
   * be measuring this file's pump instead of the renderer.
   */
  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    if (state.windowStart === null && (state.particles || state.shaders)) {
      state.windowStart = liveCounters(state);
    }
    if (!state.windowOpened && state.gpu) {
      state.counters = zeroCounters();
      state.windowOpened = true;
    }
    for (let index = 0; index < state.churn.length; index++) {
      const hue = (frame * 7 + index * 23) % 360;
      state.churn[index].style.backgroundColor = `hsl(${hue} 45% 42%)`;
    }
  },

  /**
   * What this arm did, in its own counters. Per arm, never zero-filled — an absent key means NOT
   * MEASURED, and the absences here are load-bearing (see the module note on `submitMs` and
   * `blitMs`).
   */
  metrics(ctx: ScenarioContext): Record<string, number> {
    const state = states.get(ctx.root);
    if (!state) {
      return { renderedNodes: 0 };
    }
    if (!usesWebgpu(mechanismOf(ctx.params))) {
      // S6's block, verbatim: the reference arms report exactly what the reference reports.
      const counters = liveCounters(state);
      return {
        ...counterDelta(state.windowStart ?? {}, counters),
        renderedNodes: state.rendered.size,
        ...(state.particles
          ? { boxReads: state.particles.stats().boxReads }
          : {}),
      };
    }
    return webgpuMetrics(ctx, state);
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    // The runner never calls this today. It exists anyway: a leaked rAF loop holding a GPUDevice
    // outlives the run, and a scenario that cannot be torn down cannot be run twice in one page.
    state.stopped = true;
    if (state.raf !== null) {
      cancelAnimationFrame(state.raf);
      state.raf = null;
    }
    state.particles?.dispose();
    state.shaders?.dispose();
    state.renderer?.destroy();
    state.gpu?.destroy();
    state.container.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    return effectsSamplePoints(ctx.params, ctx.layout);
  },

  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    return effectsStageSize(params, layout);
  },

  gridShape(
    params: Record<string, ParamValue>,
    layout: StageLayout,
  ): GridShape {
    return effectsGridShape(params, layout);
  },
};

/** S6's `ready()`, verbatim: wait until every shipped binding has really drawn once. */
async function readyWebgl(state: State, mechanism: string): Promise<void> {
  const expected = state.nodes.length;
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (state.rendered.size < expected) {
    if (performance.now() > deadline) {
      throw new Error(
        `effects-webgpu: only ${state.rendered.size}/${expected} ${mechanism} bindings rendered within ${READY_TIMEOUT_MS} ms — the shipped runtime is not running here (no WebGL2? a software renderer declined?), and measuring it anyway would report a blank page as a result`,
      );
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

/**
 * Acquire the device, configure the canvases, build the sim states, start the loop, and do not
 * return until every cell has PRESENTED a frame.
 *
 * The presence gate is the WebGPU equivalent of S6's `onBindingRendered` poll, and it is here for
 * the same reason: a device that hands back a handle says nothing about whether pixels reached the
 * screen, and opening the measured window on a page that is still filling in charges the arm for
 * the fill-in. A timeout is a FAILURE — there is nothing to measure and a silent resolve would
 * publish a blank page as a result.
 */
async function readyWebgpu(
  ctx: ScenarioContext,
  state: State,
  mechanism: string,
): Promise<void> {
  const particles = usesParticles(mechanism);
  const mode = presentModeOf(mechanism);
  const gpu = await acquireGpu();
  state.gpu = gpu;

  const { columns } = effectsGridShape(ctx.params, ctx.layout);
  const contexts: GPUCanvasContext[] = [];
  let sharedCanvas: HTMLCanvasElement | null = null;
  let targets: CellTarget[];

  if (mode === "direct") {
    for (const cell of state.cells) {
      contexts.push(configureCanvas(cell.canvas, gpu.device, gpu.format));
    }
    targets = state.cells.map((cell) => cell.target);
  } else {
    // The blit arm's per-node canvases become 2D canvases — the SAME kind the shipped architecture
    // composites — and one shared WebGPU canvas feeds all of them. It is deliberately NOT in the
    // DOM: the shipped shared GL canvas is a detached `document.createElement("canvas")` too, so
    // attaching this one would add a composited layer the reference arm does not have.
    const first = state.cells[0];
    const { width, height, cells } = sharedLayout(
      gpu.device,
      first.canvas.width,
      first.canvas.height,
      state.cells.length,
      columns,
    );
    sharedCanvas = document.createElement("canvas");
    sharedCanvas.width = width;
    sharedCanvas.height = height;
    contexts.push(configureCanvas(sharedCanvas, gpu.device, gpu.format));
    for (let index = 0; index < state.cells.length; index++) {
      state.cells[index].target = cells[index];
      const ctx2d = state.cells[index].canvas.getContext("2d");
      if (!ctx2d) {
        throw new Error(
          "effects-webgpu: the blit arm needs a 2D context per node and getContext('2d') returned null. Run the direct arm (--mechanism particles-webgpu) or the WebGL reference instead; without the 2D canvases there is no blit to measure.",
        );
      }
      state.cells[index].ctx2d = ctx2d;
    }
    targets = cells;
  }

  const deps = {
    device: gpu.device,
    format: gpu.format,
    cells: targets,
    mode,
    contexts,
    sharedCanvas,
  };

  if (particles) {
    const amount = Math.max(1, Math.round(numParam(ctx.params.amount, 64)));
    for (let index = 0; index < state.cells.length; index++) {
      // The SHIPPED sim, from the SAME spec the webgl arms hand the runtime through
      // `data-godot-particle-specs` — parsed by the shipped parser, normalized by the shipped
      // normalizer, warmed by the shipped preprocess. Nothing about the simulation differs between
      // the arms, which is the entire premise of subtracting them.
      const config = parseParticleConfig(
        JSON.stringify(effectsSpec(ctx.params, index)),
      );
      if (!config) {
        throw new Error(
          `effects-webgpu: parseParticleConfig rejected the spec for system ${index}. The spec comes from S6's exported effectsSpec — if that changed shape, S6 is broken too and this probe cannot be compared against it.`,
        );
      }
      const simState = createParticleState(config);
      // Godot pre-simulates `preprocess` seconds before the first draw, and the shipped runtime does
      // it at binding create — i.e. inside readyMs, before the window. Same here, so every arm opens
      // its window at a full steady-state instance count instead of ramping through one.
      preprocessParticles(simState);
      state.cells[index].state = simState;
      state.cells[index].originX = config.originX;
      state.cells[index].originY = config.originY;
      state.cells[index].buffer = new InstanceBuffer(amount);
    }
    state.renderer = await createParticleRenderer(deps, amount);
  } else {
    state.renderer = await createShaderRenderer(deps);
  }

  state.originAtReady = performance.now();
  state.lastFrameMs = state.originAtReady;
  state.lastTickMs = 0;
  startWebgpuLoop(ctx, state, mechanism);

  const deadline = performance.now() + READY_TIMEOUT_MS;
  for (;;) {
    const presented = state.cells.filter((cell) => cell.presented).length;
    if (presented >= state.cells.length) {
      return;
    }
    if (performance.now() > deadline) {
      throw new Error(
        `effects-webgpu: only ${presented}/${state.cells.length} ${mechanism} canvases presented within ${READY_TIMEOUT_MS} ms${state.frameError ? ` — the render loop threw: ${state.frameError}` : " — WebGPU handed back a device but no pixels reached the page"}. Measuring it anyway would report a blank page as a result. Check chrome://gpu, then fall back to --mechanism particles-webgl,shaders-webgl.`,
      );
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

/**
 * The WebGPU arms' frame loop: sim → pack → encode → (blit), with every stage timed into its own
 * bucket so the split is the same SHAPE as S6's `simMs / buildMs / glMs / blitMs` and can be read
 * next to it.
 *
 * `fps` is honoured as a rAF SKIP — the loop keeps waking on every display frame and returns early —
 * which is NOT what the shipped runtime does (it parks a timer to the cap boundary). Same rate,
 * different mechanism, and the docs say so: a skip still pays the rAF callback, so an fps-capped
 * WebGPU arm is not directly comparable to an fps-capped runtime arm.
 */
function startWebgpuLoop(
  ctx: ScenarioContext,
  state: State,
  mechanism: string,
): void {
  const particles = usesParticles(mechanism);
  const blit = usesBlit(mechanism);
  const fps = Math.max(0, numParam(ctx.params.fps, 0));
  const minGapMs = fps > 0 ? 1000 / fps : 0;
  const pad = effectsCanvasPad(ctx.params);
  const dpr = webgpuPixelRatio(
    Math.max(0.01, numParam(ctx.params.renderScale, 1)),
  );
  const geometry = {
    originX: 0,
    originY: 0,
    pad,
    dpr,
    frameW: WEBGPU_DOT_PX,
    frameH: WEBGPU_DOT_PX,
  };
  const counts = new Array<number>(state.cells.length).fill(0);

  const frame = (now: number): void => {
    if (state.stopped) {
      return;
    }
    state.raf = requestAnimationFrame(frame);
    if (minGapMs > 0 && now - state.lastTickMs < minGapMs - 0.5) {
      return;
    }
    state.lastTickMs = now;
    // A THROW INSIDE A rAF CALLBACK GOES NOWHERE. `ready()` is awaiting a presence gate on the other
    // side of this loop, so an exception here — a texture that could not be acquired, a validation
    // error the scope did not catch — would show up only as "0/12 presented within 8000 ms" with the
    // actual cause left in a console nobody is reading over CDP. The first one is kept and quoted in
    // that timeout message instead. Subsequent frames are allowed to keep failing silently: one
    // cause is the diagnosis, and 500 copies of it would bury the count.
    try {
      renderFrame(now);
    } catch (error) {
      state.frameError ??=
        error instanceof Error ? error.message : String(error);
    }
  };

  const renderFrame = (now: number): void => {
    const renderer = state.renderer;
    if (!renderer) {
      return;
    }
    const counters = state.counters;
    const dtRaw = (now - state.lastFrameMs) / 1000;
    state.lastFrameMs = now;
    // A backgrounded tab, a long GC, a device wake: the shipped sim clamps its own dt nowhere, so
    // the clamp lives here. Without it one stalled frame hands `simulateParticles` a multi-second dt
    // and it runs hundreds of steps in one go — a spike that would land in `simMs` as if the
    // simulation had got expensive.
    const dt = Math.min(MAX_FRAME_DT_S, Math.max(0, dtRaw));

    if (particles) {
      const simStart = performance.now();
      for (const cell of state.cells) {
        if (cell.state) {
          counters.simSteps += simulateParticles(cell.state, dt);
        }
      }
      counters.simMs += performance.now() - simStart;

      const buildStart = performance.now();
      for (let index = 0; index < state.cells.length; index++) {
        const cell = state.cells[index];
        geometry.originX = cell.originX;
        geometry.originY = cell.originY;
        const count =
          cell.state && cell.buffer
            ? packSystem(cell.buffer, cell.state, geometry)
            : 0;
        counts[index] = count;
        counters.instances += count;
      }
      counters.buildMs += performance.now() - buildStart;
    }

    const submitStart = performance.now();
    if (particles) {
      for (let index = 0; index < state.cells.length; index++) {
        const buffer = state.cells[index].buffer;
        if (buffer) {
          renderer.writeInstances(index, buffer, counts[index]);
        }
      }
    }
    const encoded = renderer.encodeFrame(
      counts,
      (now - state.originAtReady) / 1000,
    );
    counters.submitMs += performance.now() - submitStart;
    counters.passes += encoded.passes;
    counters.submits += encoded.submits;
    counters.draws += encoded.draws;

    if (blit && renderer.sharedCanvas) {
      // The SHIPPED blit, on the shipped kind of destination: the same
      // `drawImage(source, sx, sy, w, h, 0, 0, w, h)` the particle runtime does per binding. WebGPU
      // framebuffer coordinates are Y-DOWN, exactly like a `drawImage` source rect, so the viewport
      // rects the pass just drew map 1:1 onto these sub-rects with no flip arithmetic anywhere.
      const blitStart = performance.now();
      for (const cell of state.cells) {
        if (!cell.ctx2d) continue;
        const { x, y, w, h } = cell.target;
        cell.ctx2d.clearRect(0, 0, w, h);
        cell.ctx2d.drawImage(renderer.sharedCanvas, x, y, w, h, 0, 0, w, h);
        counters.blits += 1;
      }
      counters.blitMs += performance.now() - blitStart;
    }

    counters.ticks += 1;
    counters.bindings += state.cells.length;
    // A cell counts as PRESENTED once a frame carrying it has been submitted (and, on the blit arm,
    // blitted). That is the honest gate for `ready()`: the pixels are in the pipe for a canvas the
    // compositor already owns.
    for (const cell of state.cells) {
      cell.presented = true;
    }
  };
  state.raf = requestAnimationFrame(frame);
}

/** The WebGPU arms' `metrics()` block. Key set is `metricKeysFor(mechanism)`, by construction. */
function webgpuMetrics(
  ctx: ScenarioContext,
  state: State,
): Record<string, number> {
  const mechanism = mechanismOf(ctx.params);
  const particles = usesParticles(mechanism);
  const c = state.counters;
  const round = (key: string, value: number): number =>
    MS_COUNTERS.has(key) ? Math.round(value * 100) / 100 : value;
  const block: Record<string, number> = {
    profTicks: c.ticks,
    profBindings: c.bindings,
    ...(particles
      ? {
          simSteps: c.simSteps,
          instances: c.instances,
          simMs: round("simMs", c.simMs),
          buildMs: round("buildMs", c.buildMs),
          /** Draw CALLS issued — the WebGPU counterpart of the runtime's `particleDraws`. */
          particleDraws: c.draws,
          // `blitMs`/`blits` ONLY on the blit arm. On the direct arms there is no blit, and a
          // fabricated 0 here would erase the very difference this scenario exists to show.
          ...(usesBlit(mechanism)
            ? { blitMs: round("blitMs", c.blitMs), blits: c.blits }
            : {}),
        }
      : { shaderDraws: c.draws }),
    // NOT `glMs`: this is not GL. Same class of measurement (main-thread submit cost), different
    // API — sharing the key would invite a reader to median the two together across arms.
    submitMs: round("submitMs", c.submitMs),
    passes: c.passes,
    submits: c.submits,
    renderedNodes: state.cells.filter((cell) => cell.presented).length,
    // THE VALIDITY ROWS. `adapterFallback: 1` is a software implementation wearing WebGPU's name and
    // VOIDS the arm; any `gpuErrors` means a frame was silently wrong; any `deviceLosses` means the
    // arm stopped producing frames partway through the window.
    adapterFallback: state.gpu?.adapterFallback ? 1 : 0,
    gpuErrors: state.gpu?.counters.gpuErrors ?? 0,
    deviceLosses: state.gpu?.counters.deviceLosses ?? 0,
  };
  return block;
}
