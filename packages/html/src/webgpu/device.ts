// The WebGPU device gate: ONE page-wide `GPUDevice` for every WebGPU surface both runtimes
// create, acquired at most once. Ported from the S7 probe
// (`packages/perf-harness/src/scenarios/webgpu/renderer.ts`, `acquireGpu`) with its FAIL-LOUD
// contract inverted: a probe that cannot measure must abort the run, but a PRODUCT that cannot
// render on WebGPU must fall back to WebGL and say nothing to the user. So nothing here ever
// throws; every failure resolves `null` and LATCHES a `WebgpuFallbackReason` the runtimes report
// as a stat, which is the only way a silent fallback stays diagnosable.
//
// Why memoized rather than per-runtime: the same reason `shared-gl.ts` holds ONE WebGL2 context.
// Two devices would double every driver-side allocation, and a texture cache can only be shared
// by surfaces that share a device.

/** Why the WebGPU path declined, latched at its FIRST occurrence (later ones cannot un-explain it). */
import { configureWebgpuSurface } from "@godot-scene-web/canvas-effects/webgpu";

export type WebgpuFallbackReason =
  | "no-navigator-gpu"
  | "no-adapter"
  | "fallback-adapter"
  | "acquire-timeout"
  | "device-lost"
  | "context-refused"
  | "pipeline-error";

export interface WebgpuShared {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** `device.limits`, hoisted: sizing law (`maxTextureDimension2D`) and the uniform ring read it. */
  limits: GPUSupportedLimits;
  counters: {
    /** `uncapturederror` events. Non-zero means a frame was silently wrong. */
    gpuErrors: number;
    /** Resolutions of `device.lost`. A lost device stops producing frames; the surfaces are dead. */
    deviceLosses: number;
  };
}

/** How long acquisition waits for an adapter/device before declaring WebGPU unavailable. A hung
 *  `requestAdapter` is a driver/flag problem on the host that no amount of waiting fixes, and the
 *  runtimes have a working WebGL path to adopt instead. */
const ACQUIRE_TIMEOUT_MS = 8000;

/**
 * WebGPU's usage / visibility / map BIT FLAGS, spelled out from the specification.
 *
 * TypeScript 6's `lib.dom.d.ts` ships every WebGPU *interface* but NOT the flag namespace OBJECTS
 * (`GPUBufferUsage`, `GPUShaderStage`, `GPUTextureUsage`, `GPUMapMode`) — only their
 * `…Flags = number` aliases. Reading the real globals instead is not an option: these modules are
 * import-reachable from the node CLIs that import `@godot-scene-web/html`, node has no such
 * globals, and a module-scope `GPUBufferUsage.VERTEX` would throw AT IMPORT and take the whole
 * entry point down — on a machine that was never going to render anything anyway. The values are
 * normative constants in the WebGPU specification, so stating them is safe in a way that copying
 * an implementation detail would not be.
 */
export const BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
} as const;
export const SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
export const TEXTURE_USAGE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
} as const;
export const MAP_MODE = { READ: 0x1 } as const;

// Module-scope acquisition state, persisted across attach/detach cycles like `shared-gl`'s.
// `memo` is the page-wide promise; `settled` is its resolved value for the SYNC peek the runtimes
// use to skip the async gate entirely when the answer is already known.
let memo: Promise<WebgpuShared | null> | undefined;
let settled: WebgpuShared | null | undefined;
let latchedReason: WebgpuFallbackReason | null = null;
const lostListeners = new Set<() => void>();
// Bumped by `__resetWebgpuForTest`, so an in-flight acquisition or a `device.lost` handler from a
// PREVIOUS test cannot poison the memo a later test just built.
let epoch = 0;

/** Latch the first fallback reason. Exported for `pipeline.ts` (a shader/pipeline that fails
 *  validation is a WebGPU failure the runtime reports through the same stat), not for consumers. */
export function latchWebgpuFallbackReason(reason: WebgpuFallbackReason): void {
  if (latchedReason === null) latchedReason = reason;
}

/** The FIRST reason WebGPU was declined, or null while nothing has gone wrong. */
export function webgpuFallbackReason(): WebgpuFallbackReason | null {
  return latchedReason;
}

/**
 * The page-wide device promise. Never rejects: `null` means "render on WebGL", with
 * `webgpuFallbackReason()` saying why.
 *
 * Memoized on the FIRST call, so N bindings created in one reconcile share one `requestAdapter`.
 * Once a device is lost the memo is POISONED (replaced with a resolved `null`) rather than
 * cleared: a device that died once will usually die again, and re-probing per binding would turn
 * a rare failure into a stall on every rebuild.
 */
export function acquireWebgpuDevice(): Promise<WebgpuShared | null> {
  if (memo) return memo;
  memo = acquireOnce();
  return memo;
}

/**
 * The SYNC view of the gate, for factories that must decide without awaiting:
 * `undefined` = never tried or still pending, `null` = tried and unavailable (or poisoned by a
 * device loss), otherwise the shared device.
 */
export function peekWebgpuDevice(): WebgpuShared | null | undefined {
  return settled;
}

/** Subscribe to device loss (the runtimes rebuild every binding onto WebGL). Returns unsubscribe. */
export function onWebgpuDeviceLost(callback: () => void): () => void {
  lostListeners.add(callback);
  return () => {
    lostListeners.delete(callback);
  };
}

async function acquireOnce(): Promise<WebgpuShared | null> {
  const started = epoch;
  const shared = await tryAcquire();
  // A reset (or a loss) landed while we were awaiting: this result belongs to a page that no
  // longer exists, so it must not overwrite the current `settled`.
  if (started !== epoch) return null;
  settled = shared;
  return shared;
}

async function tryAcquire(): Promise<WebgpuShared | null> {
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined)
    ?.gpu;
  if (!gpu) return decline("no-navigator-gpu");

  let adapter: GPUAdapter | null;
  try {
    const raced = await withDeadline(gpu.requestAdapter());
    if (raced === TIMED_OUT) return decline("acquire-timeout");
    adapter = raced;
  } catch {
    return decline("no-adapter");
  }
  if (!adapter) return decline("no-adapter");

  // A fallback adapter is a CPU implementation wearing the API's name — the WebGPU twin of
  // `shared-gl`'s SwiftShader/llvmpipe decline: running our fragment work on it pegs the CPU for
  // no visual gain over the WebGL path, which is also the Godot-parity reference. Escape hatch:
  // set `globalThis.__gswForceWebgpuEffects = true` to render on it anyway (exercising the WebGPU
  // path on a headless/CI box is exactly what SwiftShader is for), mirroring
  // `__gswForceWebglShaders` in `../webgl/shared-gl.ts`.
  if (isFallbackAdapter(adapter) && !forcedOn())
    return decline("fallback-adapter");

  let device: GPUDevice;
  try {
    const raced = await withDeadline(adapter.requestDevice());
    if (raced === TIMED_OUT) return decline("acquire-timeout");
    device = raced;
  } catch {
    // `requestDevice` resolves or rejects — it never yields null — so a rejection is "we asked for
    // a device and hold none", which is the lost-device state at t=0 and reported as such.
    return decline("device-lost");
  }

  const counters = { gpuErrors: 0, deviceLosses: 0 };
  const shared: WebgpuShared = {
    device,
    format: preferredFormat(gpu),
    limits: device.limits,
    counters,
  };
  wireDeviceEvents(device, counters);
  return shared;
}

function decline(reason: WebgpuFallbackReason): null {
  latchWebgpuFallbackReason(reason);
  return null;
}

// A lost device does not throw anywhere — it just stops working, so the loss has to be OBSERVED to
// be survivable. `uncapturederror` is the same shape of silence: the frame is wrong and nothing
// says so. Both are wrapped because a partial implementation missing either member must degrade to
// "no telemetry", never to a throw out of acquisition.
function wireDeviceEvents(
  device: GPUDevice,
  counters: WebgpuShared["counters"],
): void {
  const started = epoch;
  try {
    void device.lost.then(() => {
      counters.deviceLosses += 1;
      if (started !== epoch) return;
      latchWebgpuFallbackReason("device-lost");
      // POISON: later acquires resolve null immediately, without touching the adapter again.
      memo = Promise.resolve(null);
      settled = null;
      for (const listener of [...lostListeners]) listener();
    });
    device.addEventListener("uncapturederror", () => {
      counters.gpuErrors += 1;
    });
  } catch {
    // No device telemetry available; the counters simply stay at 0.
  }
}

function isFallbackAdapter(adapter: GPUAdapter): boolean {
  // `info` is a live accessor on modern Chrome; the optional chain is for a build where it is not.
  const info = (
    adapter as GPUAdapter & { info?: { isFallbackAdapter?: boolean } }
  ).info;
  return Boolean(info?.isFallbackAdapter);
}

function forcedOn(): boolean {
  return (
    (globalThis as Record<string, unknown>).__gswForceWebgpuEffects === true
  );
}

function preferredFormat(gpu: GPU): GPUTextureFormat {
  try {
    return gpu.getPreferredCanvasFormat();
  } catch {
    // Every implementation prefers one of bgra8unorm/rgba8unorm; bgra8unorm is the desktop default
    // and is only ever reached when the accessor itself is missing (a stub, or a partial build).
    return "bgra8unorm";
  }
}

const TIMED_OUT: unique symbol = Symbol("gsw-webgpu-acquire-timeout");

// `Promise.race` with a cleared timer: the probe's `withDeadline`, resolving a sentinel instead of
// rejecting. Clearing in `finally` is load-bearing — a live 8 s timer per acquisition would keep
// the event loop (and, in node, the process) awake long after the answer arrived.
async function withDeadline<T>(
  promise: Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ACQUIRE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `canvas.getContext("webgpu")` — THE ONE CAST.
 *
 * `lib.dom.d.ts` ships every WebGPU interface but gives `getContext` no `"webgpu"` overload, so the
 * call lands on the `(contextId: string) => RenderingContext | null` signature. Narrowing it here,
 * once, is preferable to sprinkling casts at the call sites or adding a `@webgpu/types` dependency
 * the type system does not need.
 *
 * Null (never a throw) when the canvas already holds a context of another TYPE — a canvas gets one
 * context for its whole life, so this is a permanent property of that element, not a retryable error.
 */
export function webgpuContext(
  canvas: HTMLCanvasElement,
): GPUCanvasContext | null {
  try {
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!context) {
      latchWebgpuFallbackReason("context-refused");
      return null;
    }
    return context;
  } catch {
    latchWebgpuFallbackReason("context-refused");
    return null;
  }
}

/** Configure one canvas to present premultiplied frames from the shared device, or null on refusal.
 *
 *  `alphaMode` has only two values and "opaque" would flatten the effect onto black and stop it
 *  compositing over the page at all — so "premultiplied" is the only usable one, and every fragment
 *  this package writes must therefore return `vec4f(rgb * a, a)` under a `one / one-minus-src-alpha`
 *  blend. That pairing is load-bearing in both directions and neither half raises an error on its
 *  own: a premultiplied fragment under src-alpha blend double-multiplies, a straight one under this
 *  blend halos. */
export function configureCanvas(
  canvas: HTMLCanvasElement,
  shared: WebgpuShared,
): GPUCanvasContext | null {
  const context = webgpuContext(canvas);
  if (!context) return null;
  try {
    configureWebgpuSurface(context, shared.device, shared.format);
    return context;
  } catch {
    latchWebgpuFallbackReason("context-refused");
    return null;
  }
}

/** TEST-ONLY: clear the memo, the latched reason and the loss subscribers so a test can install a
 *  stubbed `navigator.gpu` and re-probe deterministically (acquisition latches its result). */
export function __resetWebgpuForTest(): void {
  epoch += 1;
  memo = undefined;
  settled = undefined;
  latchedReason = null;
  lostListeners.clear();
}
