// jsdom (gsw default env).
//
// PER-BINDING BACKING DENSITY (`data-godot-shader-pixel-ratio`, see `SURFACE_PIXEL_RATIO_ATTR`).
//
// Both fx runtimes size a surface's backing store from `clientWidth × (devicePixelRatio ×
// renderScale)`, and `clientWidth` is blind to ancestor CSS transforms. A node under a
// `transform: scale(1.41)` ancestor therefore gets a store sized for 1/1.41 of the device pixels it
// is magnified onto, and the surface is measurably soft. Nothing either runtime can read off its own
// element says so — the transform belongs to an ancestor it does not own, and finding it would be a
// `getBoundingClientRect()` walk per surface per frame, i.e. exactly the forced layout both runtimes
// are built around avoiding. So the HOST states it here and the runtimes multiply it in.
//
// A NOTE ON WHAT THIS IS NOT FOR, because the first report that reached this package was one. A
// consumer counted its "under-resolved" fx surfaces by comparing each backing store against
// `getBoundingClientRect().width × devicePixelRatio` and found two particle canvases apparently
// magnified ×1.2247 and ×1.4142. They were not magnified at all: `getBoundingClientRect()` returns
// the AXIS-ALIGNED BOUNDING BOX of a transformed element, and those two were squares ROTATED 15° and
// 45°, whose AABB is `|cos θ| + |sin θ|` wider than the square — √1.5 and √2 — with not one extra
// device pixel underneath. A third, identical, unrotated sibling read 1.0000. Rotation is rigid: it
// moves a surface's texels, it does not give the screen more room for them. A host computing this
// attribute must therefore take the AXIS scale of its transform (a column norm), never a rect ratio;
// stamping the AABB would have cost the 45° surface twice its area for no sharpness whatsoever.
//
// What these tests pin:
//   - the PARSE: absent / empty / NaN / zero / negative ⇒ EXACTLY 1, i.e. every un-stamped surface
//     is sized byte-for-byte as it was before the attribute existed (the off-switch);
//   - the ARITHMETIC: store = box × window × dpr × attr, on the shader runtime and on the particle
//     runtime, through the real create path (so it proves the attribute is read off the SELF-LAYER);
//   - the SWAP: an attribute change under a mounted frozen still retires the stand-in through the
//     runtime's own `revertStaticImage` (cause "resize") and NEVER through the watchdog's
//     "unexplained re-allocation" path — and an UNCHANGED attribute costs zero reverts however many
//     sweeps and watchdog cadences go by;
//   - COMPOSITION with the runtime-wide static pin: frozen ⇒ the pin replaces the device ratio and
//     the attribute still multiplies on top; a live binding is never pinned but is still multiplied.
//
// Same fake-WebGL2 + hand-flushed rAF + injected-clock harness as `static-backing-pin` /
// `surface-image-swap`.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createParticleRuntime } from "../src/particles/runtime";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticImageSwapForTest,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticSurfacePolicy,
} from "../src/surface-image-swap";
import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import {
  __resetSharedForTest,
  MAX_SURFACE_PIXEL_RATIO,
  parseSurfacePixelRatio,
  SURFACE_PIXEL_RATIO_ATTR,
} from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

// A magnified surface, in the shape the attribute is written in.
const BOX_W = 220;
const BOX_H = 220;
const SQRT2 = "1.4142";

// ---- fake GL / rAF / blob-URL harness ----------------------------------------------------------

function fakeGl(): unknown {
  const overrides: Record<string, () => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getActiveUniform: () => null,
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

const origSetTimeout = globalThis.setTimeout;
const flush = (): Promise<void> =>
  new Promise((resolve) => origSetTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

let createdUrls: string[] = [];
let urlSeq = 0;

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
    type?: string,
  ): void {
    callback(new Blob(["frame"], { type }));
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string => {
    const url = `blob:stub/${++urlSeq}`;
    createdUrls.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  __resetStaticImageSwapForTest();
  createdUrls = [];
  rafQueue = [];
  globalThis.ResizeObserver = makeResizeObserverStub();
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** The swap's own clock + timer seam, so the WATCHDOG can be advanced deterministically. */
function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => nowMs,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    async advance(ms: number): Promise<void> {
      const target = nowMs + ms;
      for (;;) {
        let dueId = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId < 0) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        nowMs = Math.max(nowMs, dueAt);
        timer?.fn();
        await flush();
      }
      nowMs = target;
      await flush();
    },
  };
}
type Clock = ReturnType<typeof scheduler>;

// ---- fixtures ----------------------------------------------------------------------------------

function sizedSelfLayer(w: number, h: number): HTMLElement {
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => w,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => h,
    configurable: true,
  });
  return self;
}

function shaderNode(ratio?: string): {
  node: HTMLElement;
  self: HTMLElement;
} {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", "res://s.gdshader");
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = sizedSelfLayer(BOX_W, BOX_H);
  if (ratio !== undefined) self.setAttribute(SURFACE_PIXEL_RATIO_ATTR, ratio);
  node.appendChild(self);
  return { node, self };
}

async function mountShader(
  ratio: string | undefined,
  options: Record<string, unknown> = {},
): Promise<{
  rt: ReturnType<typeof createWebglShaderRuntime>;
  root: HTMLElement;
  self: HTMLElement;
  canvas: HTMLCanvasElement;
}> {
  const root = document.createElement("div");
  const { node, self } = shaderNode(ratio);
  root.appendChild(node);
  document.body.appendChild(root);
  const rt = createWebglShaderRuntime(root, {
    resolveShaderSource: async () => SHADER,
    ...options,
  } as never);
  rt.reconcile();
  await settle();
  return {
    rt,
    root,
    self,
    canvas: self.querySelector("canvas") as HTMLCanvasElement,
  };
}

function particleSpec(): string {
  // blendMode 0 (non-additive) so the draw never reaches the accumulator FBO under the fake GL —
  // the constraint every particle-runtime test works under.
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 1,
    emitting: true,
    initialVelocityMin: 0,
    initialVelocityMax: 0,
    blendMode: 0,
  });
}

function particleNode(ratio?: string): {
  node: HTMLElement;
  self: HTMLElement;
} {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", particleSpec());
  const self = sizedSelfLayer(BOX_W, BOX_H);
  if (ratio !== undefined) self.setAttribute(SURFACE_PIXEL_RATIO_ATTR, ratio);
  node.appendChild(self);
  return { node, self };
}

function mountParticles(
  ratio: string | undefined,
  options: Record<string, unknown> = {},
): {
  rt: ReturnType<typeof createParticleRuntime>;
  self: HTMLElement;
  canvas: HTMLCanvasElement;
} {
  const root = document.createElement("div");
  const { node, self } = particleNode(ratio);
  root.appendChild(node);
  document.body.appendChild(root);
  const rt = createParticleRuntime(root, {
    enableParticles: true,
    // A point emitter with no travel: the canvas is the node box plus a pad that does not depend on
    // the density, so the width below is a clean box × ratio.
    particleTravelExtents: false,
    ...options,
  } as never);
  rt.reconcile();
  return {
    rt,
    self,
    canvas: self.querySelector(
      "[data-godot-particle-canvas]",
    ) as HTMLCanvasElement,
  };
}

const standIn = (self: HTMLElement): HTMLImageElement | null =>
  self.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);

/** The content-key gate with a REAL watchdog cadence on an injected clock, so "the watchdog never
 *  fired" is a claim this file can actually make (its default for that gate is 0 = never armed). */
function swapPolicy(clock: Clock): StaticSurfacePolicy {
  return {
    gate: { kind: "content-key" },
    watchdogMs: 500,
    now: clock.now,
    setTimeout: clock.setTimeout as StaticSurfacePolicy["setTimeout"],
    clearTimeout: clock.clearTimeout as StaticSurfacePolicy["clearTimeout"],
  };
}

/** `n` reconciles in which nothing changed — the content-key gate's clock. */
async function quietReconciles(
  rt: { reconcile: () => void },
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    rt.reconcile();
    await flush();
  }
}

// ================================================================================================

describe("parseSurfacePixelRatio — the off-switch is EXACTLY 1", () => {
  it("resolves every absent/malformed/non-positive attribute to 1", () => {
    // Absent is the case that matters: it is every consumer that has never heard of this attribute,
    // and it must leave the density term the bare product it always was.
    expect(parseSurfacePixelRatio(null)).toBe(1);
    expect(parseSurfacePixelRatio(undefined)).toBe(1);
    expect(parseSurfacePixelRatio("")).toBe(1);
    expect(parseSurfacePixelRatio("scale(2)")).toBe(1); // NaN
    expect(parseSurfacePixelRatio("NaN")).toBe(1);
    expect(parseSurfacePixelRatio("0")).toBe(1);
    expect(parseSurfacePixelRatio("-2")).toBe(1);
    expect(parseSurfacePixelRatio("Infinity")).toBe(1);
  });

  it("passes a positive ratio through, above OR below 1", () => {
    expect(parseSurfacePixelRatio("1.4142")).toBeCloseTo(Math.SQRT2, 4);
    expect(parseSurfacePixelRatio("1.5")).toBe(1.5);
    // Below 1 is honoured: a MINIFIED surface really does cover fewer device pixels than its box.
    // Refusing it here would be this runtime second-guessing the only party that can see the
    // transform; clamping to magnification-only is the host's policy, not the parser's.
    expect(parseSurfacePixelRatio("0.5")).toBe(0.5);
  });

  it("CAPS instead of rejecting, so a runaway host loses the allocation and not the fix", () => {
    expect(parseSurfacePixelRatio("64")).toBe(MAX_SURFACE_PIXEL_RATIO);
    expect(parseSurfacePixelRatio(String(MAX_SURFACE_PIXEL_RATIO))).toBe(
      MAX_SURFACE_PIXEL_RATIO,
    );
  });
});

// ---- T6 (the arithmetic itself is pinned in `webgl-runtime.test.ts`, on the same stand-in the
//          rest of the `syncCanvasSize` contract is pinned on) ------------------------------------

describe("T6 — backing store = box × window × dpr × attr, through the real create path", () => {
  it("reads the attribute off the SELF-LAYER at create, through the real runtime", async () => {
    const { rt, canvas } = await mountShader("1.5");
    expect(canvas.width).toBe(BOX_W * 1.5); // dpr 1 under jsdom
    expect(canvas.height).toBe(BOX_H * 1.5);
    rt.dispose();
  });

  it("…and an un-stamped node through the same path is the plain box", async () => {
    const { rt, canvas } = await mountShader(undefined);
    expect(canvas.width).toBe(BOX_W);
    expect(canvas.height).toBe(BOX_H);
    rt.dispose();
  });
});

describe("T6 (particle twin) — the runtime the measured surfaces actually live in", () => {
  it("sizes a particle canvas at box × attr, and un-stamped at the plain box", () => {
    const stamped = mountParticles("1.5");
    const plain = mountParticles(undefined);
    // The pad is density-independent, so the RATIO of the two stores is exactly the attribute.
    expect(stamped.canvas.width).toBe(Math.round(plain.canvas.width * 1.5));
    expect(stamped.canvas.height).toBe(Math.round(plain.canvas.height * 1.5));
    // …and the CSS box is untouched: this changes the store, never the geometry.
    expect(stamped.canvas.style.width).toBe(plain.canvas.style.width);
    expect(stamped.canvas.style.height).toBe(plain.canvas.style.height);
    stamped.rt.dispose();
    plain.rt.dispose();
  });

  it("re-sizes a KEPT binding when the attribute moves — never re-creates it", () => {
    const { rt, self, canvas } = mountParticles(undefined);
    const before = canvas.width;
    self.setAttribute(SURFACE_PIXEL_RATIO_ATTR, "1.5");
    rt.reconcile();
    // Same canvas ELEMENT, bigger store: a magnified node must not have its running simulation
    // restarted every time the host restates how magnified it is.
    expect(self.querySelector("[data-godot-particle-canvas]")).toBe(canvas);
    expect(canvas.width).toBe(Math.round(before * 1.5));

    // …and back down again, on the same terms.
    self.removeAttribute(SURFACE_PIXEL_RATIO_ATTR);
    rt.reconcile();
    expect(canvas.width).toBe(before);
    rt.dispose();
  });

  it("an UNCHANGED attribute across many reconciles re-allocates nothing", () => {
    const { rt, canvas } = mountParticles(SQRT2);
    const width = canvas.width;
    for (let i = 0; i < 8; i++) rt.reconcile();
    expect(canvas.width).toBe(width);
    rt.dispose();
  });
});

// ---- T7 ----------------------------------------------------------------------------------------

describe("T7 — an attribute change retires a mounted still DELIBERATELY, not via the watchdog", () => {
  it("reverts with cause 'resize' and zero watchdog reverts, then stays quiet", async () => {
    const clock = scheduler();
    const { rt, self, canvas } = await mountShader(undefined, {
      staticShaders: true,
      staticShaderImages: swapPolicy(clock),
    });
    flushRaf(); // the one frozen render establishes the content key
    await flush();
    await quietReconciles(rt, 8); // …and earn the swap
    expect(standIn(self)).toBeTruthy();
    expect(rt.stats().staticImageSwaps).toBe(1);
    const sizeAtFreeze = canvas.width;
    expect(sizeAtFreeze).toBe(BOX_W);

    // THE CHANGE. The stand-in is an `<img>` of pixels rendered at the OLD density, so it has to go.
    self.setAttribute(SURFACE_PIXEL_RATIO_ATTR, "1.5");
    rt.reconcile();
    await flush();

    expect(standIn(self)).toBeNull();
    expect(canvas.width).toBe(BOX_W * 1.5); // the re-size really happened
    expect(canvas.style.display).toBe(""); // the canvas is back
    const byCause = rt.stats().staticImageRevertsByCause;
    expect(byCause.resize).toBe(1); // ← the deliberate path
    expect(byCause.watchdog).toBe(0); // ← never the "unexplained re-allocation" one
    // …nor the OTHER autonomous path. The backing size is a term in the frame key, so a re-render at
    // the new density RE-KEYS the surface: drop the `revertStaticImage` and leave the re-size +
    // re-render to speak for themselves, and this same single revert lands as "key-change" instead —
    // i.e. as CHURN, which under the default `onInvalidate: "block"` disqualifies the surface from
    // ever freezing again. One revert either way, completely different afterlife; the last assertion
    // in this test is the one that tells them apart.
    expect(byCause["key-change"]).toBe(0);
    expect(rt.stats().staticImageReverts).toBe(1);

    // The watchdog stays at 0 across many cadences too: the revert happened INSIDE the change, so
    // there is never a window in which a stand-in sits over a re-allocated canvas for it to catch.
    await clock.advance(10_000);
    expect(rt.stats().staticImageRevertsByCause.watchdog).toBe(0);

    // AND THE SURFACE IS NOT BLOCKED: a deliberate revert RESETS the gate, so the binding re-earns
    // its swap at the new density. This is what routing the retirement through `revertStaticImage`
    // buys over letting the re-key look like churn.
    flushRaf();
    await flush();
    await quietReconciles(rt, 8);
    expect(standIn(self)).toBeTruthy();
    expect(rt.stats().staticImageSwaps).toBe(2);
    rt.dispose();
  });

  it("an UNCHANGED attribute across N sweeps causes ZERO reverts of any cause", async () => {
    const clock = scheduler();
    const { rt, self, canvas } = await mountShader(SQRT2, {
      staticShaders: true,
      staticShaderImages: swapPolicy(clock),
    });
    flushRaf();
    await flush();
    expect(canvas.width).toBe(311); // round(220 × 1.4142) at jsdom's dpr 1
    await quietReconciles(rt, 8);
    expect(standIn(self)).toBeTruthy();

    // The sweep re-reads the attribute every time. Re-parsing it into an equal-but-not-identical
    // number, or comparing floats instead of the RAW STRING, would thaw this surface once per
    // reconcile — which is exactly the churn the `windowAttr` idiom exists to avoid.
    await quietReconciles(rt, 20);
    await clock.advance(10_000);
    expect(standIn(self)).toBeTruthy();
    expect(rt.stats().staticImageReverts).toBe(0);
    expect(rt.stats().canvasReallocs).toBe(1); // the create's one allocation, and no more
    rt.dispose();
  });
});

// ---- T9 ----------------------------------------------------------------------------------------

describe("T9 — the runtime-wide static pin and the per-binding attribute COMPOSE", () => {
  it("FROZEN: the pin replaces the device ratio, the attribute still multiplies", async () => {
    const { rt, canvas } = await mountShader("1.5", {
      staticShaders: true,
      renderScale: 0.5, // would have given 110 — the pin overrides it
      staticShaderPixelRatio: 3,
    });
    // 220 × 3 (pin) × 1.5 (attr). The pin answers "how dense should a frozen surface be on this
    // device"; the attribute answers "how much of the screen does THIS surface cover". A frozen
    // magnified surface needs both, and neither is a substitute for the other.
    expect(canvas.width).toBe(BOX_W * 3 * 1.5);
    expect(canvas.height).toBe(BOX_H * 3 * 1.5);
    expect(rt.stats().pinnedCanvasSyncs).toBeGreaterThan(0);
    rt.dispose();
  });

  it("LIVE: never pinned, but still multiplied", async () => {
    const { rt, canvas } = await mountShader("1.5", {
      staticShaders: false,
      renderScale: 0.5,
      staticShaderPixelRatio: 3,
    });
    expect(canvas.width).toBe(BOX_W * 0.5 * 1.5);
    expect(canvas.height).toBe(BOX_H * 0.5 * 1.5);
    expect(rt.stats().pinnedCanvasSyncs).toBe(0); // the pin never applied
    rt.dispose();
  });

  it("an un-stamped binding is byte-identical under the pin (the pin's own tests still hold)", async () => {
    const { rt, canvas } = await mountShader(undefined, {
      staticShaders: true,
      renderScale: 0.5,
      staticShaderPixelRatio: 3,
    });
    expect(canvas.width).toBe(BOX_W * 3);
    expect(canvas.height).toBe(BOX_H * 3);
    rt.dispose();
  });

  it("particles: the pin and the attribute compose there too", () => {
    const pinned = mountParticles(undefined, {
      staticParticles: true,
      staticParticlePixelRatio: 3,
    });
    const both = mountParticles("1.5", {
      staticParticles: true,
      staticParticlePixelRatio: 3,
    });
    expect(both.canvas.width).toBe(Math.round(pinned.canvas.width * 1.5));
    pinned.rt.dispose();
    both.rt.dispose();
  });
});
