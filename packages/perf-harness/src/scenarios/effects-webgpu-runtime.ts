// S8 `effects-webgpu-runtime` — the SHIPPED WebGPU path, held against the shipped WebGL one.
//
// THE QUESTION. S7 `effects-webgpu` priced a WebGPU renderer with a PROBE — its own WGSL, its own
// loop, its own canvases — and the phone answered 47 → 87 Hz on both pairs, the whole win coming
// from presenting directly into each node's canvas instead of blitting. That licensed writing the
// thing. This scenario asks the only question left: **did the win survive productization?** The
// shipped renderer is not the probe. It carries textures, flipbooks, LUTs, masks, erode, the
// additive accumulate+resolve pass, a per-binding fallback path, a device-lost rebuild and the whole
// 2000-line lifecycle machinery the probe never had — every one of which is a place for the 87 Hz to
// leak away.
//
// SO THIS SCENARIO MOUNTS SHIPPED CODE ONLY, and it is an S6-licence scenario for S6's reason:
// measuring a re-derivation measures the wrong code. `createParticleRuntime` and
// `createWebglShaderRuntime` from `@godot-scene-web/html`, the same nodes S6 mounts (its exported
// builders, called — not copied), and ONE option different between an arm and its reference:
//
//   particles-webgl    createParticleRuntime      + effectsRenderer: "webgl"     the reference
//   particles-webgpu   createParticleRuntime      + effectsRenderer: "webgpu"    the confirmation
//   shaders-webgl      createWebglShaderRuntime   + effectsRenderer: "webgl"     the reference
//   shaders-webgpu     createWebglShaderRuntime   + effectsRenderer: "webgpu"    the confirmation
//
// THE PROBE STAYS WHERE IT IS. S7 is the historical record of what an unencumbered WebGPU pipeline
// costs, and this scenario deliberately imports nothing from it — not its WGSL, not its packer, not
// its renderer. If the two disagree, the difference is what productization cost, and that is a
// reading rather than a bug in one of them.
//
// WHY `submitMs` IS `glMs` UNDER ANOTHER NAME HERE, and why the rename happens at THIS boundary.
// The shipped WebGPU backends book their encode+upload cost into the profile's `glMs` bucket
// (`particles/render-webgpu.ts`, `webgpu/render-shader.ts` both say so at the brackets) and never
// touch `blitMs` — there is no blit on that path. Inside `packages/html` that is the right choice:
// the profile has a fixed shape and a fifth bucket would be a renderer concept leaking into a
// renderer-agnostic type. But a TABLE is read across arms, and a `glMs` column containing GL submit
// on two arms and WebGPU encode on the other two invites a reader to median them together. So the
// bucket is renamed once, here, where the arm's identity is known: `glMs` → `submitMs` on the
// webgpu arms, and `blitMs` is dropped rather than reported as 0 — S7's rule, and its reason: a
// missing `blitMs` row IS the architecture, and a fabricated zero would erase it.
//
// WHY `ready()` REFUSES A SILENT FALLBACK. The shipped runtime's whole design is that WebGPU failure
// is invisible: it adopts WebGL, counts `webgpuFallbacks`, latches a reason and keeps rendering. That
// is correct for a product and fatal for a confirmation arm — `particles-webgpu` would quietly
// publish WebGL numbers under a WebGPU name, and the table would read as "productization lost the
// win" when the truth is "WebGPU never ran". So `ready()` polls `stats().renderer` until it is
// `"webgpu"` and throws if anything fell back, naming `webgpuFallbackReason` and the remedy.
//
// WHY `blend` IS MEASURABLE HERE. S7 REFUSED `blend=1`: Godot ADD needs the accumulate+resolve pass
// and the probe had only the single-pass mix path. The shipped renderer has both, so the refused
// case is now a parameter — and it is the one part of the feature set most likely to have eaten the
// win, since it doubles the passes per frame.
//
// DESKTOP IS SMOKE ONLY, and more so than usual. This box's WebGPU adapter is SwiftShader, which the
// shipped device gate DECLINES as a fallback adapter (`webgpu/device.ts`) exactly as `shared-gl`
// declines a software GL renderer. `--param forceWebgpu=1` disables that decline so the path can be
// exercised at all — and the arm is then VOID for performance by construction, which is what the
// reported `forcedAdapter: 1` says. Headless Chrome also never composites a WebGPU canvas, so the
// presence guard needs `xvfb-run -a … --headed`.

import type { GodotHtmlMountOptions } from "@godot-scene-web/html/runtime";
import {
  createParticleRuntime,
  createWebglShaderRuntime,
  type ParticleRuntime,
  type WebglShaderRuntime,
} from "@godot-scene-web/html/runtime";
import type { GridShape } from "../fit";
import {
  buildChurnCell,
  buildParticleNode,
  buildShaderNode,
  churnCellsFor,
  counterDelta,
  EFFECTS_SHADER_SOURCE,
  effectsCellBox,
  effectsGridShape,
  effectsSamplePoints,
  effectsStageSize,
  paintDecodeCanary,
  particleCounters,
  shaderCounters,
} from "./effects-runtime";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

export const EFFECTS_WEBGPU_RUNTIME_MECHANISMS = [
  "particles-webgl",
  "particles-webgpu",
  "shaders-webgl",
  "shaders-webgpu",
];

/** How long `ready()` waits for every binding to render (and, on a webgpu arm, for the device to be
 *  adopted). S6's timeout, for S6's reason: an arm that never ran has nothing to measure. */
const READY_TIMEOUT_MS = 8000;

/**
 * How long `ready()` then waits for every frozen surface to SWAP (`--param swap=1` only).
 *
 * Its own, longer budget because the swap is several gated stages on top of a rendered frame: the
 * gate itself (three content-key observations, or a one-second quiet window), then encode pacing (a
 * slice of 4 per 120 ms window), then — on a WebGPU binding — a GPU readback, a PNG encode and an
 * image decode per distinct frame. At 30 systems the pacing alone is most of a second.
 */
const SWAP_TIMEOUT_MS = 20000;

export const EFFECTS_WEBGPU_RUNTIME_PARAMS: Record<
  string,
  { default: ParamValue; values?: ParamValue[]; describe: string }
> = {
  mechanism: {
    default: "particles-webgl",
    values: EFFECTS_WEBGPU_RUNTIME_MECHANISMS,
    describe:
      "which shipped runtime is mounted, and which `effectsRenderer` it is pinned to — the ONLY difference between an arm and its reference",
  },
  systems: {
    default: 12,
    describe:
      "particle systems (or shader nodes) mounted on the stage. 12 is S6/S7 continuity (the 47 -> 87 Hz row); the consuming project renders 30+, which is the `--param systems=30` confirmation",
  },
  amount: { default: 64, describe: "particles per system" },
  cellPx: {
    default: 96,
    describe:
      "one system's node box in CSS px; its canvas is this plus the runtime's own sprite/emission pad on every side, on EVERY arm",
  },
  blend: {
    default: 0,
    values: [0, 1],
    describe:
      "CanvasItemMaterial blend mode: 0 mix, 1 ADD. Measurable on all four arms — the shipped WebGPU renderer ports the accumulate+resolve pass S7's probe refused, and doubling the passes per frame is where the win is most likely to leak",
  },
  fps: {
    default: 0,
    describe:
      "FPS cap for BOTH effect loops (particleFps / shaderFps). 0 = uncapped. Unlike S7, this is the runtime's own timer park on every arm — the loop is the shipped loop whatever the renderer is",
  },
  renderScale: {
    default: 1,
    describe:
      "backing-store multiplier for every effect canvas, on top of devicePixelRatio. One option to one runtime, so all four arms size the same pixels",
  },
  churn: {
    default: 8,
    describe:
      "unrelated cells repainted every frame beside the effects, so a run always has layer activations the report validator can see (S5's, S6's and S7's rule)",
  },
  forceWebgpu: {
    default: 0,
    values: [0, 1],
    describe:
      "1 sets `__gswForceWebgpuEffects` before the runtime is created, disabling the shipped gate's fallback-adapter decline. DESKTOP SMOKE ONLY: the arm then runs on a CPU implementation wearing WebGPU's name, reports `forcedAdapter: 1` and is VOID for performance by construction",
  },
  freeze: {
    default: 0,
    values: [0, 1],
    describe:
      "1 freezes the population: `staticParticles` (warm once from the seed, park the loop) on the particle arms, `staticShaders` + `staticShaderTime: 1` on the shader ones. A PARAM, not an arm — it applies to the arm AND its reference, so the pair stays subtractable",
  },
  swap: {
    default: 0,
    values: [0, 1],
    describe:
      "1 arms the frozen-surface image swap (`staticParticleImages`/`staticShaderImages`), so a settled canvas is replaced by an `<img>` and leaves the composite. REQUIRES freeze=1 — a live population never earns a swap. The reading is same-arm swap=0 against swap=1; swap=0 pins `staticShaderImages: false` EXPLICITLY, because the shipped default is ON and freeze=1 would otherwise engage it on the reference",
  },
};

/**
 * URL params arrive as STRINGS (the in-page `readParams` only coerces numerics) while `resolveParams`
 * on the node side produces real numbers — both spellings reach this file. S6's helper, restated
 * because it is three lines and importing it would export a name that means nothing outside a
 * scenario.
 */
function numParam(value: ParamValue | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mechanismOf(params: { mechanism?: unknown }): string {
  return String(params.mechanism ?? EFFECTS_WEBGPU_RUNTIME_MECHANISMS[0]);
}

/** Whether this arm pins the runtime to the WebGPU renderer (two of the four do). */
export function runtimeUsesWebgpu(mechanism: string): boolean {
  return mechanism.endsWith("-webgpu");
}

/** Whether this arm mounts the PARTICLE runtime (two of the four do). */
export function runtimeUsesParticles(mechanism: string): boolean {
  return mechanism.startsWith("particles-");
}

/**
 * The `effectsRenderer` option this arm passes — and the WHOLE difference between an arm and its
 * reference.
 *
 * Both sides are PINNED, neither is `"auto"`. The default is `"auto"`, so a reference arm left at it
 * would silently become a WebGPU arm on any phone with an adapter and the table would compare
 * WebGPU with WebGPU. Pure and exported, so "the arm differs by one option" is checkable without a
 * browser.
 */
export function effectsRendererFor(mechanism: string): "webgl" | "webgpu" {
  return runtimeUsesWebgpu(mechanism) ? "webgpu" : "webgl";
}

/** Whether this run disabled the shipped gate's fallback-adapter decline (see the `forceWebgpu`
 *  param). Pure, because it decides both a global write in `mount` and a reported key. */
export function forcesWebgpuAdapter(
  params: Record<string, ParamValue>,
): boolean {
  return Math.round(numParam(params.forceWebgpu, 0)) === 1;
}

/**
 * Whether this run FREEZES the effect population (see the `freeze` param). Pure and exported: it
 * decides runtime options on every arm, and "the arm and its reference got the same freeze" is a
 * claim a node test should be able to check without a browser.
 */
export function freezesPopulation(params: Record<string, ParamValue>): boolean {
  return Math.round(numParam(params.freeze, 0)) === 1;
}

/**
 * Whether this run arms the frozen-surface image SWAP (see the `swap` param).
 *
 * Only meaningful with `freeze=1` — `mount()` refuses the other combination rather than quietly
 * measuring a swap that can never engage — and it decides three separate things (the runtime
 * options, the `ready()` engagement phase, and the reported key set), which is exactly why it is one
 * pure function rather than three inline reads of the param.
 */
export function swapsFrozenSurfaces(
  params: Record<string, ParamValue>,
): boolean {
  return Math.round(numParam(params.swap, 0)) === 1;
}

/**
 * The freeze/swap half of an arm's runtime options — the whole of what `--param freeze`/`--param
 * swap` do to the mounted runtime, as a pure function of the params and the arm.
 *
 * Pure and exported for the same reason `effectsRendererFor` is: "the arm and its reference got the
 * SAME options" is this scenario's premise, and a premise checked only by a browser run is a premise
 * checked when it is too late. The two image-swap options are always present, in BOTH directions —
 * `staticShaderImages` ships ON, so an omitted `false` would engage the mechanism on a `swap=0`
 * reference and quietly destroy the pair.
 */
export function frozenSurfaceOptions(
  params: Record<string, ParamValue>,
  mechanism: string,
): Record<string, unknown> {
  const particles = runtimeUsesParticles(mechanism);
  const freeze = freezesPopulation(params);
  const swap = swapsFrozenSurfaces(params);
  return {
    // Per runtime, because the two freezes mean different things: a frozen particle system is warmed
    // once from its seed and its loop parked; a frozen shader renders one frame at a PINNED time.
    ...(freeze && particles ? { staticParticles: true } : {}),
    ...(freeze && !particles
      ? { staticShaders: true, staticShaderTime: 1 }
      : {}),
    staticParticleImages: swap,
    staticShaderImages: swap,
  };
}

/** The swap's WINDOW-DELTA counters — the thrash diagnostic. All ≈0 in a healthy swapped window:
 *  the surfaces froze during `ready()`, so anything happening DURING the window is a surface that
 *  could not hold still (and each revert is a re-encode). */
const SWAP_DELTA_KEYS = [
  "staticImageSwaps",
  "staticImageReverts",
  "staticImageEncodes",
  "staticImageFailures",
  "staticImageEncodeMs",
  "staticImageCaptureMs",
  // NOT a thrash counter like its neighbours — the one number that separates "the swap engaged" from
  // "the swap engaged over a picture of nothing". A readback that comes back entirely transparent
  // for a surface the renderer knows it drew is refused (the surface keeps its live canvas) and
  // booked here; on the launch mode this scenario's traps document, that used to be `12/12` swapped
  // surfaces and `sampleHits 0/12`. Non-zero on a webgpu arm ⇒ read the trap, then change rung.
  "staticImageBlankCaptures",
] as const;

/**
 * The key set this arm's `metrics()` block reports, as a pure function of the mechanism.
 *
 * MUST MIRROR `metrics()` — it is the same claim stated where a node test can read it, and the
 * absences are as load-bearing as the presences:
 *   - `glMs` and `blitMs` exist ONLY on the webgl arms. On the webgpu arms the first is renamed
 *     (`submitMs`) and the second does not exist at all, because there is no blit to time.
 *   - `submitMs` exists ONLY on the webgpu arms. It is not GL.
 *   - the validity rows (`rendererWebgpu`, `webgpuFallbacks`, `gpuErrors`, `deviceLosses`) exist
 *     only where they are meaningful; `webgpuBindingFallbacks` only on the shader runtime, which is
 *     the only one that can fall back per binding.
 *   - `forcedAdapter` appears only when it was forced, because "1" is the only value it can honestly
 *     take and a 0 would be a claim about an adapter nobody inspected.
 *   - the swap rows appear only on a `swap=1` run — the forcedAdapter convention again. On a run
 *     that did not arm the mechanism, `staticImageSwaps: 0` would not mean "nothing swapped", it
 *     would mean "nothing was asked to", and those are different facts.
 */
export function runtimeMetricKeysFor(
  mechanism: string,
  forced = false,
  swap = false,
): string[] {
  const particles = runtimeUsesParticles(mechanism);
  // The window deltas, plus the whole-life GAUGE. `staticImagesLive` is not a delta and must never
  // be run through `counterDelta`: the surfaces froze during `ready()`, so its window delta is 0 on
  // a perfectly healthy run and the number a reader wants ("how many of the `systems` canvases left
  // the composite?") is the standing count.
  const swapKeys = swap ? [...SWAP_DELTA_KEYS, "staticImagesLive"] : [];
  const workload = particles
    ? [
        "particleDraws",
        "particleCacheHits",
        "profTicks",
        "profBindings",
        "simSteps",
        "instances",
        "simMs",
        "buildMs",
      ]
    : ["shaderDraws", "shaderCacheHits", "profTicks", "profBindings"];
  const life = particles ? ["renderedNodes", "boxReads"] : ["renderedNodes"];
  if (!runtimeUsesWebgpu(mechanism)) {
    // The reference arms report exactly what S6 reports — same helpers, same keys, so the two
    // scenarios' tables can be read against each other.
    return [...workload, "glMs", "blitMs", ...life, ...swapKeys];
  }
  return [
    ...workload,
    "submitMs",
    "webgpuSubmits",
    ...life,
    ...swapKeys,
    "rendererWebgpu",
    "webgpuFallbacks",
    ...(particles ? [] : ["webgpuBindingFallbacks"]),
    "gpuErrors",
    "deviceLosses",
    ...(forced ? ["forcedAdapter"] : []),
  ];
}

/**
 * THE RENAME, at the scenario boundary and nowhere else.
 *
 * `glMs` -> `submitMs`: on the WebGPU backends that bucket holds encode + `writeBuffer` upload cost
 * (the submit itself happens once per tick in `endFrame`), which is the same CLASS of measurement as
 * GL submit and emphatically not the same API. Reporting it under `glMs` would let a reader median
 * the GL and WebGPU columns together — S7's rule, restated here because this scenario is the first
 * one where the two names come out of the SAME profile object.
 *
 * `blitMs` -> dropped, not zeroed. The shipped WebGPU path never writes it (there is no blit), and
 * a `blitMs: 0` next to WebGL's `blitMs: 342` would read as "the blit got free" rather than "the
 * blit stopped existing".
 *
 * Rounding is already done: `counterDelta` rounds under the ORIGINAL key (`glMs` is in
 * `EFFECTS_MS_COUNTERS`), so the rename inherits it and `submitMs` needs no entry of its own.
 *
 * The one case this cannot see: a device lost MID-WINDOW rebuilds the runtime on WebGL, and the
 * remainder of the window's GL submit + blit then lands in these buckets. That is what
 * `deviceLosses`, `webgpuFallbacks` and `rendererWebgpu` are reported for — the numbers stay honest
 * only next to the rows that say the renderer changed under them.
 */
export function renameWebgpuBuckets(
  delta: Record<string, number>,
): Record<string, number> {
  const renamed: Record<string, number> = {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === "blitMs") {
      continue;
    }
    renamed[key === "glMs" ? "submitMs" : key] = value;
  }
  return renamed;
}

/** The WebGPU-adoption facts both runtimes publish, read through one shape so `ready()` and
 *  `metrics()` cannot disagree about where they came from. `bindingFallbacks` is NULL on the particle
 *  runtime — it has no such counter, and null is "this runtime cannot answer", never 0. */
interface GpuAdoption {
  renderer: "pending" | "webgpu" | "webgl" | "none";
  fallbacks: number;
  reason: string | null;
  bindingFallbacks: number | null;
  submits: number;
  gpuErrors: number;
  deviceLosses: number;
}

interface State {
  container: HTMLElement;
  churn: HTMLElement[];
  /** The effect nodes, in mount order — the reconcile keys the runtime binds against. */
  nodes: HTMLElement[];
  /** Exactly one of these is non-null per arm (see `mount`), which is what keeps the reported key
   *  set per-arm rather than zero-filled. */
  particles: ParticleRuntime | null;
  shaders: WebglShaderRuntime | null;
  /** Distinct nodes whose binding has REALLY drawn, from `onBindingRendered` — the runtimes fire it
   *  only on a draw that reached the renderer, never on a cache-hit blit or a skip. */
  rendered: Set<HTMLElement>;
  /** The runtime's counters as they stood on the FIRST `step()`, i.e. at the top of the measured
   *  window. Null until then, which is also what "the window never opened" looks like. */
  windowStart: Record<string, number> | null;
}

const states = new WeakMap<HTMLElement, State>();

/** The swap's monotonic counters, off either runtime's stats (both spread the same counters object).
 *  Window-deltaed by the caller: what a reader wants from a swapped window is how much the mechanism
 *  CHURNED while it was supposed to be sitting still. */
function swapCounters(stats: {
  staticImageSwaps: number;
  staticImageReverts: number;
  staticImageEncodes: number;
  staticImageFailures: number;
  staticImageEncodeMs: number;
  staticImageCaptureMs: number;
  staticImageBlankCaptures: number;
}): Record<string, number> {
  return {
    staticImageSwaps: stats.staticImageSwaps,
    staticImageReverts: stats.staticImageReverts,
    staticImageEncodes: stats.staticImageEncodes,
    staticImageFailures: stats.staticImageFailures,
    staticImageEncodeMs: stats.staticImageEncodeMs,
    // The GPU readback's wall time, which the html package deliberately keeps OUT of encode-ms
    // (that one means synchronous main-thread park, and a `mapAsync` readback does not park). On a
    // WebGL arm it stays 0, which is the honest reading: there is no capture on that path.
    staticImageCaptureMs: stats.staticImageCaptureMs,
    // Captures REFUSED as entirely transparent (see `SWAP_DELTA_KEYS`). 0 on a healthy rung and on
    // every WebGL arm, which have no capture path at all.
    staticImageBlankCaptures: stats.staticImageBlankCaptures,
  };
}

/** This arm's runtime counters, flattened — S6's `liveCounters`, plus the one WebGPU counter that is
 *  monotonic and therefore belongs in the window delta rather than beside it, plus the swap's own
 *  when the run armed it. */
function liveCounters(
  state: State,
  webgpu: boolean,
  swap = false,
): Record<string, number> {
  if (state.particles) {
    const stats = state.particles.stats();
    return {
      ...particleCounters(stats),
      // `queue.submit` calls: ONE per tick that drew anything, whatever the binding count. That
      // batching IS the measured win, so an arm where this climbs with N systems has found the win
      // being given back. Meaningless on WebGL, where it is not reported at all.
      ...(webgpu ? { webgpuSubmits: stats.webgpuSubmits } : {}),
      ...(swap ? swapCounters(stats) : {}),
    };
  }
  if (state.shaders) {
    const stats = state.shaders.stats();
    return {
      ...shaderCounters(stats),
      ...(webgpu ? { webgpuSubmits: stats.webgpuSubmits } : {}),
      ...(swap ? swapCounters(stats) : {}),
    };
  }
  return {};
}

/** How many of this arm's surfaces are swapped RIGHT NOW — the gauge that answers "did the mechanism
 *  actually engage?" (`staticImagesLive === systems`). Re-derived from the runtime on every read, so
 *  a revert during the window shows up here rather than in a stale number. */
function liveSwapGauge(state: State): number {
  if (state.particles) return state.particles.stats().staticImagesLive;
  if (state.shaders) return state.shaders.stats().staticImagesLive;
  return 0;
}

/** The adoption facts, or null when no runtime was ever created against this root. */
function gpuAdoptionOf(state: State): GpuAdoption | null {
  if (state.particles) {
    const stats = state.particles.stats();
    return {
      renderer: stats.renderer,
      fallbacks: stats.webgpuFallbacks,
      reason: stats.webgpuFallbackReason,
      bindingFallbacks: null,
      submits: stats.webgpuSubmits,
      gpuErrors: stats.webgpuErrors,
      deviceLosses: stats.webgpuDeviceLosses,
    };
  }
  if (state.shaders) {
    const stats = state.shaders.stats();
    return {
      renderer: stats.renderer,
      fallbacks: stats.webgpuFallbacks,
      reason: stats.webgpuFallbackReason,
      bindingFallbacks: stats.webgpuBindingFallbacks,
      submits: stats.webgpuSubmits,
      gpuErrors: stats.webgpuErrors,
      deviceLosses: stats.webgpuDeviceLosses,
    };
  }
  return null;
}

/**
 * The render options this arm's runtime is built from. One place, so an arm and its reference differ
 * by `effectsRenderer` and nothing else — which is this scenario's entire premise.
 */
function runtimeOptions(
  ctx: ScenarioContext,
  state: State,
  mechanism: string,
): GodotHtmlMountOptions {
  const fps = Math.max(0, numParam(ctx.params.fps, 0));
  return {
    enableParticles: true,
    enableWebglShaders: true,
    particleFps: fps,
    shaderFps: fps,
    // FREEZE and SWAP, on the arm AND its reference (see `frozenSurfaceOptions`, which is where the
    // whole of that decision lives so a node test can check it without a browser).
    ...frozenSurfaceOptions(ctx.params, mechanism),
    renderScale: Math.max(0.01, numParam(ctx.params.renderScale, 1)),
    // THE one field that differs between an arm and its reference. Pinned on both sides — never
    // left at the `"auto"` default, which would make a reference arm adopt WebGPU wherever one
    // exists and compare WebGPU with WebGPU.
    effectsRenderer: effectsRendererFor(mechanism),
    // The per-frame cost attribution both runtimes expose through `stats().profile`. On for every
    // arm: an arm whose profile was null would report no bucket keys at all and the arms would stop
    // being comparable.
    effectsProfiling: true,
    // S6's shader, read through its export rather than copied. The WebGPU arm runs it through the
    // shipped Godot->WGSL transpiler and the WebGL arm through the shipped Godot->GLSL one, which is
    // the point: same source, two shipped back ends.
    resolveShaderSource: () => EFFECTS_SHADER_SOURCE,
    onBindingRendered: (node) => {
      state.rendered.add(node);
    },
  };
}

/**
 * THE ENGAGEMENT PHASE (`--param swap=1` only), run at the END of `ready()` so the measured window
 * sees the SWAPPED STEADY STATE rather than the swap happening.
 *
 * That placement is the whole design. The mechanism's cost is front-loaded — a readback and an
 * encode per distinct frame — and a window that contained it would price the transition, once,
 * instead of the thing the run is asking about: what does a page cost when N canvases have LEFT the
 * composite? With the swap complete before the window opens, the in-window swap counters should all
 * be ≈0, and any that are not are the thrash diagnostic.
 *
 * SHADERS ARE RECONCILED PER FRAME here, and nothing else drives them: a frozen shader node renders
 * once and the loop never visits it again, so each clean `reconcile()` IS one observation of the
 * content key and without them the gate would never reach its third. Particles are NOT reconciled —
 * their gate is a quiet window measured from the surface's own paints, and a reconcile that provoked
 * a repaint would reset the window it is waiting on.
 */
async function awaitSwapEngaged(
  ctx: ScenarioContext,
  state: State,
  mechanism: string,
  expected: number,
): Promise<void> {
  if (!swapsFrozenSurfaces(ctx.params)) {
    return;
  }
  const deadline = performance.now() + SWAP_TIMEOUT_MS;
  for (;;) {
    if (liveSwapGauge(state) >= expected) {
      return;
    }
    if (performance.now() > deadline) {
      const counters = liveCounters(state, runtimeUsesWebgpu(mechanism), true);
      const gpu = gpuAdoptionOf(state);
      // `staticImageBlankCaptures` is the one of these that names its own fix: every capture came
      // back entirely transparent, which on this box means the launch mode (headed + default ANGLE)
      // rather than the code — see this scenario's traps. It is quoted here because the alternative
      // is the failure this guard replaced, where the run swapped 12/12 and screenshot nothing.
      throw new Error(
        `effects-webgpu-runtime: drop --param swap=1 (or raise the window) — only ${liveSwapGauge(state)}/${expected} ${mechanism} surfaces swapped to an <img> within ${SWAP_TIMEOUT_MS} ms. staticImageFailures=${counters.staticImageFailures ?? 0}, staticImageCaptureFailures=${state.particles?.stats().staticImageCaptureFailures ?? state.shaders?.stats().staticImageCaptureFailures ?? 0}, staticImageBlankCaptures=${counters.staticImageBlankCaptures ?? 0}, staticImageEncodes=${counters.staticImageEncodes ?? 0}, webgpuFallbackReason=${gpu?.reason ?? "null"}. Measuring a window in which the mechanism never engaged would publish a swap=1 row that is really a swap=0 one.`,
      );
    }
    state.shaders?.reconcile();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

export const effectsWebgpuRuntime: Scenario = {
  name: "effects-webgpu-runtime",
  params: EFFECTS_WEBGPU_RUNTIME_PARAMS,

  mount(ctx: ScenarioContext): void {
    // FIRST, before anything can touch the shared GL context — S6's rule, and it applies to the
    // WEBGPU arms too: `createEngine` requires a working WebGL backend even for a WebGPU runtime
    // (it is what every failure path adopts), and `shared-gl.ts` DECLINES a software renderer and
    // latches that decision module-scoped on the first `getShared()`. Without this, every arm on
    // this headless box would be a no-op handle measuring a blank page at a beautiful frame rate.
    (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;

    const mechanism = mechanismOf(ctx.params);
    const particles = runtimeUsesParticles(mechanism);
    // A LIVE POPULATION NEVER EARNS A SWAP, so this combination cannot produce the reading its name
    // promises: the shader gate needs a content key that has held still (a live shader's key moves
    // every frame) and the particle gate needs a quiet window (a live system paints every frame).
    // Refused rather than measured — a run that silently swapped nothing would publish a swap=1 row
    // identical to its swap=0 one and read as "the mechanism does nothing".
    if (swapsFrozenSurfaces(ctx.params) && !freezesPopulation(ctx.params)) {
      throw new Error(
        "effects-webgpu-runtime: add --param freeze=1 — swap=1 needs a frozen population. The swap only ever replaces a surface that has STOPPED changing (a held content key for shaders, a quiet window for particles), so a live arm would report an armed mechanism that never engaged, with staticImagesLive 0 and a table identical to swap=0.",
      );
    }
    // BEFORE `createParticleRuntime`/`createWebglShaderRuntime`, because the gate reads this flag at
    // adapter-acquisition time and the acquisition starts inside the factory. Setting it afterwards
    // would leave the decline in force and the arm would fall back — with a `ready()` throw naming
    // `fallback-adapter`, which is at least honest, but is not what `--param forceWebgpu=1` asked
    // for. Set here rather than at module scope: this module is bundled into the SHARED page bundle
    // with every other scenario, and a module-scope write would change their runtimes too.
    if (forcesWebgpuAdapter(ctx.params)) {
      (globalThis as Record<string, unknown>).__gswForceWebgpuEffects = true;
    }

    const count = Math.max(1, Math.round(numParam(ctx.params.systems, 12)));
    const { columns } = effectsGridShape(ctx.params, ctx.layout);

    const container = document.createElement("div");
    container.id = "perf-stage";
    Object.assign(container.style, { position: "absolute", inset: "0" });
    // S6's canary, shared rather than reinvented: `validateReport` rejects `decode.count === 0`, and
    // this page paints no images either.
    paintDecodeCanary(container);
    ctx.root.appendChild(container);

    // S6's node builders, CALLED. The arms are only comparable with each other — and with S6's and
    // S7's published tables — while they mount the same DOM, and an imported builder cannot drift
    // from the scenario it was written for.
    const nodes: HTMLElement[] = [];
    for (let index = 0; index < count; index++) {
      const box = effectsCellBox(index, columns, ctx.params);
      const node = particles
        ? buildParticleNode(ctx, index, box)
        : buildShaderNode(ctx, index, box);
      container.appendChild(node);
      nodes.push(node);
    }

    const churn: HTMLElement[] = [];
    for (const { left, top } of churnCellsFor(ctx.params, ctx.layout)) {
      const cell = buildChurnCell(left, top);
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
    };
    const options = runtimeOptions(ctx, state, mechanism);
    // Exactly ONE runtime per arm: the other's loop and ResizeObserver in the same frame budget
    // would be cost the arm's name does not account for.
    if (particles) {
      state.particles = createParticleRuntime(container, options);
      state.particles.reconcile();
    } else {
      state.shaders = createWebglShaderRuntime(container, options);
      state.shaders.reconcile();
    }
    states.set(ctx.root, state);
  },

  /**
   * Resolve only once every binding has drawn AND — on a webgpu arm — the runtime really adopted
   * WebGPU.
   *
   * A throw from here ABORTS THE WHOLE RUN (it is the only awaited scenario hook, and it surfaces as
   * `Runtime.evaluate threw: <first 800 chars>`), which is why every message front-loads the fix and
   * why the webgl and webgpu arms are smoked in SEPARATE `--mechanism` invocations.
   */
  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state) {
      throw new Error("effects-webgpu-runtime: ready() called before mount()");
    }
    const mechanism = mechanismOf(ctx.params);
    const expected = state.nodes.length;
    const webgpu = runtimeUsesWebgpu(mechanism);
    const deadline = performance.now() + READY_TIMEOUT_MS;
    for (;;) {
      const gpu = webgpu ? gpuAdoptionOf(state) : null;
      if (gpu) {
        // THE CONFIRMATION ARM'S ONE REFUSAL. The shipped runtime falls back to WebGL SILENTLY by
        // design — that is what makes it shippable — so an arm named `*-webgpu` would otherwise
        // publish WebGL numbers under a WebGPU name and the table would read as "productization
        // lost the win" when the truth is "WebGPU never ran here".
        if (gpu.fallbacks > 0) {
          throw new Error(
            `effects-webgpu-runtime: run --param forceWebgpu=1 (desktop smoke on a fallback adapter) or --mechanism particles-webgl,shaders-webgl instead — ${mechanism} asked for effectsRenderer "webgpu" and the shipped runtime fell back to WebGL. webgpuFallbackReason=${gpu.reason ?? "null"}, webgpuFallbacks=${gpu.fallbacks}, renderer=${gpu.renderer}. Measuring it anyway would report WebGL under a WebGPU name, which is the one thing a confirmation arm must never do.`,
          );
        }
        if (gpu.bindingFallbacks !== null && gpu.bindingFallbacks > 0) {
          throw new Error(
            `effects-webgpu-runtime: check the shader source — ${mechanism} put ${gpu.bindingFallbacks} of ${expected} bindings on WebGL under a WebGPU runtime (webgpuBindingFallbacks; SCREEN_TEXTURE or a WGSL-transpile refusal does this). webgpuFallbackReason=${gpu.reason ?? "null"}. The arm would be a mixture of two renderers reported as one.`,
          );
        }
      }
      if (
        state.rendered.size >= expected &&
        (!webgpu || gpu?.renderer === "webgpu")
      ) {
        await awaitSwapEngaged(ctx, state, mechanism, expected);
        return;
      }
      if (performance.now() > deadline) {
        throw new Error(
          `effects-webgpu-runtime: ${
            webgpu
              ? `add --chrome-arg=--enable-unsafe-webgpu --chrome-arg=--enable-features=Vulkan (and --param forceWebgpu=1 on a fallback adapter), or run the webgl arms instead — `
              : ""
          }only ${state.rendered.size}/${expected} ${mechanism} bindings rendered within ${READY_TIMEOUT_MS} ms${
            webgpu
              ? ` and the runtime is still renderer=${gpu?.renderer ?? "unknown"} (webgpuFallbackReason=${gpu?.reason ?? "null"})`
              : " — the runtime is not running here (no WebGL2? a software renderer declined?)"
          }. Measuring it anyway would report a blank page as a result.`,
        );
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  },

  /**
   * The churn strip, and the window's start — nothing else. Every arm's effect work is driven by the
   * shipped runtime's own loop, which is the code under measurement; a `step()` that poked it would
   * be measuring this file.
   */
  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    if (state.windowStart === null) {
      state.windowStart = liveCounters(
        state,
        runtimeUsesWebgpu(mechanismOf(ctx.params)),
        swapsFrozenSurfaces(ctx.params),
      );
    }
    for (let index = 0; index < state.churn.length; index++) {
      const hue = (frame * 7 + index * 23) % 360;
      state.churn[index].style.backgroundColor = `hsl(${hue} 45% 42%)`;
    }
  },

  /**
   * What this arm did, in the runtime's own counters. Key set is `runtimeMetricKeysFor(mechanism)`
   * by construction; keys are per arm and NEVER zero-filled.
   *
   * Everything from `counterDelta` is a WINDOW delta. The rows after it are whole-life on purpose:
   * `renderedNodes` and `boxReads` for S6's reasons (the create path happens before the window), and
   * the WebGPU validity rows because "did this runtime EVER fall back / lose a device / raise a GPU
   * error" is the question — a windowed delta would read 0 for an arm that fell back during mount.
   */
  metrics(ctx: ScenarioContext): Record<string, number> {
    const state = states.get(ctx.root);
    if (!state) {
      // `mount()` never ran against this root. Report the one thing that is both true and countable
      // rather than `{}`, which the validator cannot tell apart from a read-out that failed.
      return { renderedNodes: 0 };
    }
    const mechanism = mechanismOf(ctx.params);
    const webgpu = runtimeUsesWebgpu(mechanism);
    const swap = swapsFrozenSurfaces(ctx.params);
    const delta = counterDelta(
      state.windowStart ?? {},
      liveCounters(state, webgpu, swap),
    );
    const life: Record<string, number> = {
      renderedNodes: state.rendered.size,
      ...(state.particles
        ? { boxReads: state.particles.stats().boxReads }
        : {}),
      // A GAUGE, deliberately outside `counterDelta`: the surfaces froze during `ready()`, so the
      // window delta of this is 0 on a perfectly healthy run. What a reader wants is the standing
      // count — `staticImagesLive === systems` is "every canvas left the composite".
      ...(swap ? { staticImagesLive: liveSwapGauge(state) } : {}),
    };
    if (!webgpu) {
      // S6's block exactly: the reference arms report what the reference reports.
      return { ...delta, ...life };
    }
    const gpu = gpuAdoptionOf(state);
    return {
      ...renameWebgpuBuckets(delta),
      ...life,
      ...(gpu
        ? {
            // RE-CHECKED HERE, after the window, not trusted from `ready()`: a device lost mid-run
            // rebuilds the whole runtime on WebGL, and this is the row that says the arm stopped
            // being what its name claims partway through.
            rendererWebgpu: gpu.renderer === "webgpu" ? 1 : 0,
            webgpuFallbacks: gpu.fallbacks,
            ...(gpu.bindingFallbacks !== null
              ? { webgpuBindingFallbacks: gpu.bindingFallbacks }
              : {}),
            // Any non-zero `gpuErrors` means a frame was silently WRONG (WebGPU reports most
            // command-level mistakes as uncaptured errors and nothing else says so); any
            // `deviceLosses` means the arm stopped producing frames partway through the window.
            gpuErrors: gpu.gpuErrors,
            deviceLosses: gpu.deviceLosses,
          }
        : {}),
      // ONLY when forced, and only ever 1: the shipped gate does not expose whether the adapter it
      // took was a fallback one, so the honest claim is the one this scenario made — "the decline
      // was disabled for this run" — and the arm is VOID for performance by construction. A `0`
      // here would be a claim about an adapter nobody inspected.
      ...(forcesWebgpuAdapter(ctx.params) ? { forcedAdapter: 1 } : {}),
    };
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    state.particles?.dispose();
    state.shaders?.dispose();
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
