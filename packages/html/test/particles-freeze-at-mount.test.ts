// jsdom (gsw default env).
//
// FREEZE AT MOUNT (`staticParticleFreezeAtMount`) — the particle runtime's half of "a surface's
// second-ever appearance mounts as `<img>` for free". Three mechanisms, one option:
//
//   1. A binding the host's `canFreezeSurface` accepts is warmed once, drawn once and NEVER
//      simulated. The live loop skips it before it clears `pristine` and it does not hold the loop
//      open, so a fleet of them costs nothing per frame in a runtime that is otherwise LIVE.
//   2. When this document has ALREADY encoded that binding's frame, it mounts straight to an `<img>`
//      (`claimStaticStill`) over a canvas that never gets a context and never gets a backing store.
//      THAT is the headline claim, and it is pinned mechanically here: `getContext` and the
//      `canvas.width` setter are both spied on, and neither is touched for a claimed surface.
//   3. A binding on its way out whose key nothing has encoded is held back as a BAKE DONOR — canvas
//      out of the DOM, surface alive — just long enough to bank the frame its successors will claim.
//
// The frame KEY is what all three rest on: `notePaint` reports this runtime's static-frame key on
// the pristine path, so twins share one encode, a re-blit re-states rather than reverts, and a host
// can pin `keyedQuietMs: 0` to freeze the instant a surface paints. See
// `particles-surface-swap.test.ts` for the gate itself.
//
// Harness: the `particles-surface-swap` one (fake WebGL2 + modelled-pixel 2D contexts, hand-flushed
// rAF, the shared ResizeObserver stub, the swap's own injected clock/timer seams) plus two spies the
// zero-canvas claim is asserted with, and a stubbed `performance.now` so the one-shot burst clock is
// a deliberate act rather than wall time.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createParticleRuntime } from "../src/particles/runtime";
import { __resetStaticParticleFrameCacheForTest } from "../src/particles/static-frame-cache";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticImageSwapForTest,
  liveStaticImageUrlCount,
  STATIC_SURFACE_IMAGE_ATTR,
  type StaticSurfacePolicy,
} from "../src/surface-image-swap";
import { __resetSharedForTest, getShared } from "../src/webgl/shared-gl";
import { makeResizeObserverStub } from "./support/resize-observer-stub";

/** Instance floats of every `drawParticles` call, in call order (the buffer is reused, so copied). */
let drawnInstances: number[][] = [];

vi.mock("@godot-scene-web/canvas-effects/webgl", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@godot-scene-web/canvas-effects/webgl")
    >();
  return {
    ...actual,
    drawParticles: (
      _shared: unknown,
      _program: unknown,
      buffer: { data: Float32Array; count: number },
    ) => {
      drawnInstances.push(Array.from(buffer.data.slice(0, buffer.count * 10)));
    },
  };
});

// ---- the modelled-pixel 2D context -------------------------------------------------------------

const painted = new WeakMap<object, string>();

function paint(canvas: object, token: string): void {
  painted.set(canvas, token);
}
function pixelsOf(canvas: object): string {
  return painted.get(canvas) ?? "";
}

function fake2d(canvas: object): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    clearRect: () => painted.set(canvas, ""),
    drawImage: (source: unknown) =>
      painted.set(canvas, pixelsOf(source as object)),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

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

// ---- THE TWO SPIES the zero-canvas claim is proved with -----------------------------------------
//
// A claimed surface must never ask for a rendering context and never write `canvas.width`. Both are
// invisible in the DOM afterwards (jsdom's default backing store is 300x150 either way), so they are
// recorded as they happen, per canvas element.

/** Every `getContext` call, with the element it was made on. */
let contextCalls: Array<{ canvas: object; kind: string }> = [];
/** Every `canvas.width` / `canvas.height` assignment, with the element it was made on. */
let sizeWrites: Array<{ canvas: object; prop: "width" | "height" }> = [];

const contextCallsFor = (canvas: object): number =>
  contextCalls.filter((call) => call.canvas === canvas).length;
const sizeWritesFor = (canvas: object): number =>
  sizeWrites.filter((write) => write.canvas === canvas).length;

// ---- rAF queue + timer/clock stubs --------------------------------------------------------------

let rafQueue: FrameRequestCallback[] = [];
/** Run every queued rAF callback; returns how many ran (0 = the loop has parked itself). */
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

/** Let the microtask queue drain. The stand-in `<img>` is inserted only after `img.decode()`
 *  resolves — a claim is SYNCHRONOUS in the counters and ASYNCHRONOUS in the DOM. */
const settle = (): Promise<void> =>
  new Promise((resolve) => origSetTimeout(resolve, 0));

/** The runtime's own clock (`nowSeconds` → `performance.now`), advanced by hand. */
let clockMs = 0;
/** One live frame. 34 ms, not a display frame's 16: the simulation runs at a FIXED 30 Hz whatever
 *  the display does, so a 16 ms tick accumulates a remainder and runs no sub-step at all — an
 *  emitting system would never produce a particle, and every "did it draw?" assertion below would be
 *  measuring the harness's clock rather than the runtime. */
const TICK_MS = 34;
function tick(): number {
  clockMs += TICK_MS;
  return flushRaf();
}
/** Delays passed to the GLOBAL `setTimeout` — the loop pacer's park, and nothing else here. */
let globalDelays: number[] = [];

let encodeCalls = 0;
let urlSeq = 0;
/** Pending `toBlob` callbacks, when the harness is holding encodes open (see `holdEncodes`). */
let heldBlobs: BlobCallback[] = [];
let holdEncodes = false;

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origToBlob: HTMLCanvasElement["toBlob"];
let origDecode: HTMLImageElement["decode"] | undefined;
let origCreateObjectURL: typeof URL.createObjectURL;
let origRevokeObjectURL: typeof URL.revokeObjectURL;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;
let origSetTimeout: typeof globalThis.setTimeout;
let origWidth: PropertyDescriptor | undefined;
let origHeight: PropertyDescriptor | undefined;
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

function spyOnSize(
  prop: "width" | "height",
  original: PropertyDescriptor,
): void {
  Object.defineProperty(HTMLCanvasElement.prototype, prop, {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return original.get?.call(this);
    },
    set(this: HTMLCanvasElement, value: number) {
      sizeWrites.push({ canvas: this, prop });
      original.set?.call(this, value);
    },
  });
}

beforeAll(() => {
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: object,
    kind: string,
  ) {
    contextCalls.push({ canvas: this, kind });
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return fake2d(this);
    return null;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  origWidth = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "width",
  );
  origHeight = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "height",
  );
  if (origWidth) spyOnSize("width", origWidth);
  if (origHeight) spyOnSize("height", origHeight);
  origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ): void {
    encodeCalls++;
    if (holdEncodes) {
      heldBlobs.push(callback);
      return;
    }
    callback(new Blob(["frame"], { type: "image/png" }));
  };
  origDecode = HTMLImageElement.prototype.decode;
  HTMLImageElement.prototype.decode = (): Promise<void> => Promise.resolve();
  origCreateObjectURL = URL.createObjectURL;
  origRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = ((): string =>
    `blob:stub/${++urlSeq}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
  origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    globalDelays.push(ms ?? 0);
    return origSetTimeout(fn, ms);
  }) as typeof globalThis.setTimeout;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  if (origWidth)
    Object.defineProperty(HTMLCanvasElement.prototype, "width", origWidth);
  if (origHeight)
    Object.defineProperty(HTMLCanvasElement.prototype, "height", origHeight);
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  if (origDecode) HTMLImageElement.prototype.decode = origDecode;
  URL.createObjectURL = origCreateObjectURL;
  URL.revokeObjectURL = origRevokeObjectURL;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  globalThis.setTimeout = origSetTimeout;
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticParticleFrameCacheForTest();
  __resetStaticImageSwapForTest();
  rafQueue = [];
  drawnInstances = [];
  globalDelays = [];
  contextCalls = [];
  sizeWrites = [];
  heldBlobs = [];
  holdEncodes = false;
  encodeCalls = 0;
  clockMs = 0;
  globalThis.ResizeObserver = makeResizeObserverStub();
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clockMs);
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  document.body.innerHTML = "";
});

// ---- the injected clock + timer seam (the swap's own, independent of the rAF loop) --------------

function scheduler() {
  let nowMs = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = (): Promise<void> =>
    new Promise((resolve) => origSetTimeout(resolve, 0));
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
    pending: (): number => timers.size,
    /** Run every timer due within `ms`, in time order, letting promises settle between each. */
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

const QUIET_MS = 1000;
const STILL_CACHE_BYTES = 1 << 20;

/** The policy this whole file drives: the quiet-window gate, a KEYED deadline of 0 (a particle
 *  frame's key is a complete description of it, so a keyed surface has nothing to wait for), and
 *  retention on — without `stillCacheBytes` an encoded frame is revoked by its last holder and
 *  there would never be a still to claim. */
function freezePolicy(
  clock: Clock,
  over: Partial<StaticSurfacePolicy> = {},
): StaticSurfacePolicy {
  return {
    gate: { kind: "quiet-window", quietMs: QUIET_MS, keyedQuietMs: 0 },
    encode: { stillCacheBytes: STILL_CACHE_BYTES },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...over,
  };
}

// ---- fixtures ----------------------------------------------------------------------------------

// blendMode 0 (non-additive) so the draw path never reaches the additive accumulator FBO under the
// fake GL — the constraint every particle runtime test works under.
function spec(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "GPUParticles2D",
    amount: 8,
    lifetime: 1,
    emitting: true,
    initialVelocityMin: 50,
    initialVelocityMax: 50,
    blendMode: 0,
    ...over,
  });
}

function particleNode(
  specJson: string,
  box = 100,
): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-particle-runtime", "1");
  node.setAttribute("data-godot-particle-specs", specJson);
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => box,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => box,
    configurable: true,
  });
  node.appendChild(self);
  return { node, self };
}

function canvasIn(self: HTMLElement): HTMLCanvasElement {
  const canvas = self.querySelector<HTMLCanvasElement>(
    "[data-godot-particle-canvas]",
  );
  if (!canvas) throw new Error("no particle canvas mounted");
  return canvas;
}

function standIn(self: HTMLElement): HTMLImageElement | null {
  return self.querySelector<HTMLImageElement>(`[${STATIC_SURFACE_IMAGE_ATTR}]`);
}

/** Paint the SHARED GL canvas — the source `drawBinding` blits from — with a recognisable token. */
function paintSharedCanvas(token: string): void {
  const shared = getShared();
  if (!shared) throw new Error("no shared GL");
  paint(shared.canvas, token);
}

function freezeOptions(
  clock: Clock,
  over: Partial<StaticSurfacePolicy> = {},
): Record<string, unknown> {
  return {
    enableParticles: true,
    staticParticleFreezeAtMount: true,
    staticParticleImages: freezePolicy(clock, over),
  };
}

// ---- 1. the decision -----------------------------------------------------------------------------

describe("freeze at mount — the decision", () => {
  it("asks `canFreezeSurface` ONCE, at the binding's first sizing", async () => {
    const clock = scheduler();
    const asked: HTMLElement[] = [];
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        canFreezeSurface: (node: HTMLElement) => {
          asked.push(node);
          return true;
        },
      }) as never,
    );
    rt.reconcile();
    expect(asked).toEqual([a.node]); // the RUNTIME node, not the self-layer, not the canvas

    // A re-size, a reconcile, a render-scale step and a tick are all sizings or walks over the same
    // binding. None of them re-asks: the answer is a property of the node, and re-asking would let a
    // host change a binding's kind under a swap that is already standing on it.
    flushRaf();
    rt.reconcile();
    rt.setRenderScale(0.5);
    await clock.advance(QUIET_MS * 2);
    expect(asked).toEqual([a.node]);
    rt.dispose();
  });

  it("a VETOED binding is an ordinary live one: it simulates and holds the loop open", () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const frozen = particleNode(spec());
    const live = particleNode(spec({ seed: 9 }));
    root.appendChild(frozen.node);
    root.appendChild(live.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        canFreezeSurface: (node: HTMLElement) => node === frozen.node,
      }) as never,
    );
    rt.reconcile();
    paintSharedCanvas("F0");
    tick();
    // Both drew their first frame…
    expect(drawnInstances.length).toBe(2);

    // …but only the vetoed one is still simulating, so only it keeps the loop armed. Ten more ticks
    // draw ten more frames, not twenty.
    drawnInstances = [];
    for (let i = 0; i < 10; i++) expect(tick()).toBeGreaterThan(0);
    expect(drawnInstances.length).toBe(10);
    rt.dispose();
  });

  it("a frozen-at-mount fleet does not hold the loop open at all", () => {
    const clock = scheduler();
    const root = document.createElement("div");
    for (let i = 0; i < 3; i++) root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    paintSharedCanvas("F0");
    // One tick: every binding warms + draws its own frame (the static-frame cache is the FROZEN
    // loop's mechanism, and this is a live one).
    expect(tick()).toBe(1);
    expect(drawnInstances.length).toBe(3);
    // …and then nothing. No system is alive, so the loop never re-arms.
    expect(tick()).toBe(0);
    expect(drawnInstances.length).toBe(3);
    rt.dispose();
  });
});

// ---- 2. THE zero-canvas claim ---------------------------------------------------------------------

describe("freeze at mount — a second appearance mounts with no canvas at all", () => {
  it("claims the still: no getContext, no canvas.width write, no encode", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const first = particleNode(spec());
    root.appendChild(first.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    tick(); // the first appearance renders itself: warm, draw, report its key

    const firstCanvas = canvasIn(first.self);
    expect(contextCallsFor(firstCanvas)).toBeGreaterThan(0);
    expect(sizeWritesFor(firstCanvas)).toBeGreaterThan(0);
    expect(rt.stats().staticStillCacheMisses).toBe(1); // nothing was there to claim

    // Its key is a complete description of its frame, so `keyedQuietMs: 0` freezes it on the next
    // sweep and the encode publishes the still every later copy will claim.
    await clock.advance(2);
    expect(rt.stats().staticImageEncodes).toBe(1);
    expect(standIn(first.self)).not.toBeNull();

    // THE SECOND APPEARANCE. Same spec, same box ⇒ same key.
    contextCalls = [];
    sizeWrites = [];
    const encodesBefore = encodeCalls;
    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    // The claim itself is synchronous (its counters move on this stack); the stand-in appears once
    // its `decode()` resolves.
    expect(rt.stats().staticStillCacheHits).toBe(1);
    await settle();

    const secondCanvas = canvasIn(second.self);
    const img = standIn(second.self);
    expect(img).not.toBeNull();
    expect(img?.nextElementSibling).toBe(secondCanvas);
    expect(img?.style.display).toBe("block");
    expect(secondCanvas.style.display).toBe("none");
    // …and it carries the box, which is all the stand-in ever needed from it.
    expect(secondCanvas.style.width).toBe(canvasIn(first.self).style.width);

    // THE HEADLINE CLAIM, mechanically. Nothing asked this canvas for a context and nothing sized
    // its backing store: there is no 2D/GL context, no pixel memory and no draw behind that `<img>`.
    expect(contextCallsFor(secondCanvas)).toBe(0);
    expect(sizeWritesFor(secondCanvas)).toBe(0);
    // …and nothing was encoded or simulated for it either.
    expect(encodeCalls).toBe(encodesBefore);
    expect(drawnInstances.length).toBe(1);

    const stats = rt.stats();
    expect(stats.staticStillCacheHits).toBe(1);
    expect(stats.staticStillMounts).toBe(1);
    expect(stats.staticImageEncodes).toBe(1);
    expect(stats.staticImagesLive).toBe(2); // both surfaces, one URL
    expect(stats.staticImageUrlsLive).toBe(1);

    // A claimed binding is not in the loop's way either. The reconcile that mounted it kicked the
    // loop (every reconcile that creates a binding does), and that one tick finds nothing to draw
    // and does not re-arm.
    expect(tick()).toBe(1);
    expect(drawnInstances.length).toBe(1);
    expect(tick()).toBe(0);
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("a claimed surface survives the WATCHDOG: it owes no repaint, so nothing is unexplained", async () => {
    // The swap's standing check reverts a stand-in whose canvas has left the DOM, owes a repaint,
    // was re-allocated, or has painted since the freeze. A claimed surface is none of those BY
    // CONSTRUCTION — it is mounted, `dirty` is cleared at the claim, its paint count is 0 and its
    // (unallocated) backing size never moves — which is exactly why it may stand there indefinitely.
    // Leave `dirty` set at the claim and this test fails on the first sweep.
    const clock = scheduler();
    const root = document.createElement("div");
    root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    tick();
    await clock.advance(2);

    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    await settle();
    expect(standIn(second.self)).not.toBeNull();

    // Several watchdog cadences (`DEFAULT_SURFACE_WATCHDOG_MS` is 3 s) with nothing else happening.
    await clock.advance(10_000);
    expect(standIn(second.self)).not.toBeNull();
    expect(rt.stats().staticImagesLive).toBe(2);
    expect(rt.stats().staticImageRevertsByCause.watchdog).toBe(0);
    expect(contextCallsFor(canvasIn(second.self))).toBeGreaterThanOrEqual(0);
    rt.dispose();
  });

  it("claims a still the FIRST binding already let go of (retention, not refcount)", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const first = particleNode(spec());
    root.appendChild(first.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    tick();
    await clock.advance(2);
    expect(rt.stats().staticImageEncodes).toBe(1);

    // The first surface is GONE — node removed, binding disposed, its ref released. Under
    // `encode.stillCacheBytes` that does not revoke the URL: the pixels belong to the key, not to
    // whoever happened to hold it last.
    first.node.remove();
    rt.reconcile();
    expect(rt.stats().staticImagesLive).toBe(0);
    expect(liveStaticImageUrlCount()).toBe(1);
    expect(rt.stats().staticStillRetainedEntries).toBe(1);
    expect(rt.stats().staticStillRetainedBytes).toBeGreaterThan(0);

    contextCalls = [];
    sizeWrites = [];
    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    await settle();

    const canvas = canvasIn(second.self);
    expect(standIn(second.self)).not.toBeNull();
    expect(contextCallsFor(canvas)).toBe(0);
    expect(sizeWritesFor(canvas)).toBe(0);
    expect(rt.stats().staticImageEncodes).toBe(1); // still ONE, for the whole session
    // Claimed ⇒ held again ⇒ out of the pool.
    expect(rt.stats().staticStillRetainedEntries).toBe(0);
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("TWINS ACROSS TWO RUNTIMES share one encode (the key registry is document-wide)", async () => {
    const clock = scheduler();
    const rootA = document.createElement("div");
    const a = particleNode(spec());
    rootA.appendChild(a.node);
    const rootB = document.createElement("div");
    const b = particleNode(spec());
    rootB.appendChild(b.node);
    document.body.append(rootA, rootB);

    const rtA = createParticleRuntime(rootA, freezeOptions(clock) as never);
    rtA.reconcile();
    tick();
    await clock.advance(2);
    expect(rtA.stats().staticImageEncodes).toBe(1);

    contextCalls = [];
    sizeWrites = [];
    const rtB = createParticleRuntime(rootB, freezeOptions(clock) as never);
    rtB.reconcile();
    await settle();

    expect(standIn(b.self)).not.toBeNull();
    expect(contextCallsFor(canvasIn(b.self))).toBe(0);
    expect(rtB.stats().staticStillCacheHits).toBe(1);
    // Runtime B encoded NOTHING: its counters are its own, and they say so.
    expect(rtB.stats().staticImageEncodes).toBe(0);
    expect(encodeCalls).toBe(1);
    expect(liveStaticImageUrlCount()).toBe(1);

    rtA.dispose();
    rtB.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("a different SPEC is a different key, so it renders itself (an honest miss)", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    tick();
    await clock.advance(2);

    const other = particleNode(spec({ seed: 31 }));
    root.appendChild(other.node);
    rt.reconcile();
    await settle();
    const canvas = canvasIn(other.self);
    expect(standIn(other.self)).toBeNull();
    expect(contextCallsFor(canvas)).toBeGreaterThan(0); // it owns a real surface
    expect(rt.stats().staticStillCacheHits).toBe(0);
    expect(rt.stats().staticStillCacheMisses).toBe(2);
    rt.dispose();
  });
});

// ---- 3. going live again --------------------------------------------------------------------------

describe("freeze at mount — live-ify", () => {
  it("a host invalidate takes the canvas back: warm paid ONCE, then drawn", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const first = particleNode(spec());
    root.appendChild(first.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    tick();
    await clock.advance(2);

    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    await settle();
    const canvas = canvasIn(second.self);
    expect(standIn(second.self)).not.toBeNull();
    expect(contextCallsFor(canvas)).toBe(0);
    expect(drawnInstances.length).toBe(1);

    // The host says it can no longer vouch for the stand-in. `StaticSurfacePolicy.onRevert` hands
    // the surface back to this runtime, which builds it, sizes it, pays the warm it never ran and
    // draws — all before the revert's caller returns, so the blank canvas it uncovered never
    // composites.
    rt.invalidateStaticSurfaces();

    expect(standIn(second.self)).toBeNull();
    expect(canvas.style.display).toBe("");
    expect(contextCallsFor(canvas)).toBeGreaterThan(0);
    expect(sizeWritesFor(canvas)).toBeGreaterThan(0);
    expect(pixelsOf(canvas)).toBe("FROZEN");
    // THE warm proof: the same state warmed the same number of times renders the same instances. A
    // warm skipped would resume from the un-warmed post-create state; a warm paid twice would be a
    // phase nothing else in the document is at.
    expect(drawnInstances.length).toBe(2);
    expect(drawnInstances[1]).toEqual(drawnInstances[0]);

    // …and a second revert has nothing left to pay: no re-warm, no second draw.
    rt.invalidateStaticSurfaces();
    expect(drawnInstances.length).toBe(2);
    rt.dispose();
  });

  it("leaving frozen mode live-ifies a claimed surface too (and pays its warm)", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      ...freezeOptions(clock),
      staticParticles: true,
    } as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    tick();
    await clock.advance(2);

    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    await settle();
    const canvas = canvasIn(second.self);
    expect(standIn(second.self)).not.toBeNull();
    expect(contextCallsFor(canvas)).toBe(0);
    const drawsBefore = drawnInstances.length;

    rt.setStaticParticles(false);

    expect(standIn(second.self)).toBeNull();
    expect(contextCallsFor(canvas)).toBeGreaterThan(0);
    expect(drawnInstances.length).toBe(drawsBefore + 1);
    expect(drawnInstances.at(-1)).toEqual(drawnInstances[0]);
    // …and it is STILL frozen at mount: a mode flip does not make a named surface simulate. (The
    // flip marks every binding dirty and kicks the loop, so one tick's worth of repaint is owed
    // first — that is the mode flip's own contract, not this binding animating.)
    tick();
    drawnInstances = [];
    tick();
    tick();
    expect(drawnInstances.length).toBe(0);
    rt.dispose();
  });

  it("a fleet re-size live-ifies: `setRenderScale` re-allocates every backing store", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    paintSharedCanvas("FROZEN");
    tick();
    await clock.advance(2);

    const second = particleNode(spec());
    root.appendChild(second.node);
    rt.reconcile();
    await settle();
    const canvas = canvasIn(second.self);
    expect(standIn(second.self)).not.toBeNull();

    rt.setRenderScale(0.5);
    expect(standIn(second.self)).toBeNull();
    expect(contextCallsFor(canvas)).toBeGreaterThan(0);
    expect(pixelsOf(canvas)).toBe("FROZEN");
    rt.dispose();
  });
});

// ---- 4. the one-shot expiry ------------------------------------------------------------------------

describe("freeze at mount — one-shot expiry", () => {
  it("retires a frozen-at-mount burst that outlived its own window, and wakes itself to do it", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    // lifetime 0.15 s, explosiveness 1 ⇒ a 150 ms active window (`oneShotBurstSeconds`), and a warm
    // of 0.4 lifetimes — long enough to clear the sim's 30 Hz sub-step, so the frozen frame really
    // has particles in it.
    const burst = particleNode(
      spec({ oneShot: true, explosiveness: 1, lifetime: 0.15 }),
    );
    root.appendChild(burst.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, freezeOptions(clock) as never);
    rt.reconcile();
    paintSharedCanvas("BURST");
    tick();
    const canvas = canvasIn(burst.self);
    expect(pixelsOf(canvas)).toBe("BURST");
    await clock.advance(2);
    expect(rt.stats().staticImagesLive).toBe(1);

    // A frozen-at-mount binding never simulates, so nothing else could ever end its burst — and the
    // loop has already parked on it (nothing is alive). The tick therefore ARMS its own wake at the
    // burst's end rather than leaving a finished burst on screen until something unrelated kicks it.
    expect(globalDelays.some((d) => d > 50 && d <= 150)).toBe(true);

    // The wake, driven by hand: the park timer is real, the runtime's clock is not.
    clockMs += 200;
    await new Promise((resolve) => origSetTimeout(resolve, 200));
    flushRaf();

    // Retired: the canvas is blanked, and the stand-in over it comes down — the blank is NOT the
    // frame that key names, so it is reported keyless and thaws the swap like any other paint.
    expect(pixelsOf(canvas)).toBe("");
    expect(standIn(burst.self)).toBeNull();
    expect(rt.stats().staticImagesLive).toBe(0);
    rt.dispose();
  });
});

// ---- 5. bake donors ---------------------------------------------------------------------------------

describe("freeze at mount — bake donors", () => {
  it("banks the frame of a departing binding whose key nothing has encoded", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    // `deferHead` puts even the first encode on the timer seam, so the donor is observable while its
    // bake is in flight instead of being released on the same stack.
    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        encode: { stillCacheBytes: STILL_CACHE_BYTES, deferHead: true },
      }) as never,
    );
    rt.reconcile();
    paintSharedCanvas("BANKED");
    tick();
    const canvas = canvasIn(a.self);
    // Deliberately NOT waiting out the window: this binding never earns a swap, so if its frame is
    // ever to be encoded it has to be on the way out.
    expect(rt.stats().staticImageEncodes).toBe(0);

    a.node.remove();
    rt.reconcile();

    // Held as a donor: out of the DOM (so it costs no compositor layer and no paint), surface still
    // alive, bake queued.
    expect(canvas.isConnected).toBe(false);
    expect(rt.stats().staticStillDonors).toBe(1);
    expect(rt.stats().staticStillBakes).toBe(1);

    await clock.advance(5);
    expect(rt.stats().staticStillDonors).toBe(0);
    expect(rt.stats().staticStillDonorBakes).toBe(1);
    expect(rt.stats().staticStillDonorsDropped).toBe(0);
    // Published held by nobody, into the retained pool — which is exactly what a claim looks up.
    expect(rt.stats().staticStillRetainedEntries).toBe(1);

    contextCalls = [];
    const revived = particleNode(spec());
    root.appendChild(revived.node);
    rt.reconcile();
    await settle();
    expect(standIn(revived.self)).not.toBeNull();
    expect(contextCallsFor(canvasIn(revived.self))).toBe(0);
    expect(rt.stats().staticStillCacheHits).toBe(1);

    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("refuses to donate while LIVE candidates are still queued", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec());
    const b = particleNode(spec({ seed: 12 }));
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        encode: { stillCacheBytes: STILL_CACHE_BYTES, deferHead: true },
      }) as never,
    );
    rt.reconcile();
    tick();
    // Both surfaces are keyed and eligible immediately (`keyedQuietMs: 0`), so the sweep queues
    // their encodes — and `deferHead` leaves them sitting there.
    await clock.advance(1);
    expect(rt.stats().staticImageEncodes).toBe(0);

    // A third binding leaves while that queue is non-empty. Its bake would compete for the same
    // slice budget as two surfaces that are each still costing a compositor layer, so it is refused
    // and the binding is simply disposed.
    const c = particleNode(spec({ seed: 44 }));
    root.appendChild(c.node);
    rt.reconcile();
    tick();
    const cCanvas = canvasIn(c.self);
    c.node.remove();
    rt.reconcile();

    expect(rt.stats().staticStillDonors).toBe(0);
    expect(rt.stats().staticStillBakes).toBe(0);
    expect(cCanvas.isConnected).toBe(false);
    rt.dispose();
  });

  it("the swap kill switch drops a donor rather than stranding its surface", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    const a = particleNode(spec());
    root.appendChild(a.node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        encode: { stillCacheBytes: STILL_CACHE_BYTES, deferHead: true },
      }) as never,
    );
    rt.reconcile();
    tick();
    a.node.remove();
    rt.reconcile();
    expect(rt.stats().staticStillDonors).toBe(1);

    // `setStaticParticleImages(false)` throws the swapper away, and its queue with it — so the
    // donor's bake can never settle and nothing else would ever hand its surface back.
    rt.setStaticParticleImages(false);
    expect(rt.stats().staticStillDonors).toBe(0);
    expect(rt.stats().staticStillDonorsDropped).toBe(1);
    expect(rt.stats().staticStillDonorBakes).toBe(0);
    rt.dispose();
    expect(liveStaticImageUrlCount()).toBe(0);
  });

  it("bounds the donor set by count, evicting the oldest", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const rt = createParticleRuntime(
      root,
      freezeOptions(clock, {
        // One window has to be able to kick all six, or the pacing slice — not the donor bound —
        // would be what stops the fifth, and a queued job blocks the next donation anyway.
        encode: { stillCacheBytes: STILL_CACHE_BYTES, slice: 32 },
      }) as never,
    );

    // Hold every `toBlob` open: a kicked job leaves the queue before it reads pixels, so the encode
    // queue is empty (donations are allowed) while its donor is still waiting to settle. That is the
    // real shape of a WebGPU readback, and the only way more than one donor is ever in flight.
    holdEncodes = true;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 0; i < 6; i++) {
      const n = particleNode(spec({ seed: 100 + i }));
      root.appendChild(n.node);
      rt.reconcile();
      tick();
      canvases.push(canvasIn(n.self));
      n.node.remove();
      rt.reconcile();
      // The bound is 4, and it is enforced on admission.
      expect(rt.stats().staticStillDonors).toBeLessThanOrEqual(4);
    }
    expect(rt.stats().staticStillDonors).toBe(4);
    // Two evicted, oldest first, without publishing.
    expect(rt.stats().staticStillDonorsDropped).toBe(2);

    rt.dispose();
    // Teardown drops the rest rather than leaving four surfaces alive for jobs the swapper's
    // disposal has just thrown away.
    expect(rt.stats().staticStillDonors).toBe(0);
    expect(rt.stats().staticStillDonorsDropped).toBe(6);
    expect(liveStaticImageUrlCount()).toBe(0);
    holdEncodes = false;
    heldBlobs = [];
  });
});

// ---- 6. the option absent ---------------------------------------------------------------------------

describe("freeze at mount — absent", () => {
  it("with the option unset, a fleet simulates exactly as before (and claims nothing)", async () => {
    const clock = scheduler();
    const root = document.createElement("div");
    for (let i = 0; i < 2; i++) root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleImages: freezePolicy(clock),
    } as never);
    rt.reconcile();
    tick();
    expect(drawnInstances.length).toBe(2);

    // Both are alive, so both keep the loop armed and both keep simulating.
    drawnInstances = [];
    for (let i = 0; i < 5; i++) expect(tick()).toBeGreaterThan(0);
    expect(drawnInstances.length).toBe(10);

    const stats = rt.stats();
    expect(stats.staticStillCacheHits).toBe(0);
    expect(stats.staticStillCacheMisses).toBe(0);
    expect(stats.staticStillMounts).toBe(0);
    expect(stats.staticStillBakes).toBe(0);
    expect(stats.staticStillDonors).toBe(0);
    expect(stats.staticStillDonorBakes).toBe(0);
    expect(stats.staticStillDonorsDropped).toBe(0);
    rt.dispose();
  });

  it("with the swap off, freeze-at-mount still freezes — it just renders every surface", () => {
    const root = document.createElement("div");
    for (let i = 0; i < 3; i++) root.appendChild(particleNode(spec()).node);
    document.body.appendChild(root);

    // No `staticParticleImages` at all: no swap state, so no claim is possible and every binding
    // takes the miss path. What survives is the freeze itself.
    const rt = createParticleRuntime(root, {
      enableParticles: true,
      staticParticleFreezeAtMount: true,
    } as never);
    rt.reconcile();
    expect(tick()).toBe(1);
    expect(drawnInstances.length).toBe(3);
    expect(tick()).toBe(0);
    const stats = rt.stats();
    expect(stats.staticStillCacheHits).toBe(0);
    expect(stats.staticStillCacheMisses).toBe(0); // a claim with no swap state books nothing
    expect(stats.staticImagesLive).toBe(0);
    rt.dispose();
  });
});
