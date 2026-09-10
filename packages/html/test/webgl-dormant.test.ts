// jsdom (gsw default env).
//
// Three create-burst costs the WebGL shader runtime used to pay, and the contracts that removed them:
//
//   1. N nodes sharing one shader on a cold cache each fetched + include-expanded that shader
//      concurrently (`programCache` only dedupes AFTER transpile). They now share ONE in-flight
//      promise, dropped on settle so a failed fetch still retries.
//   2. Every binding registered its OWN ResizeObserver. There is now ONE per runtime, dispatching
//      by the entry's `target`.
//   3. A node flipping in and out of a shader-off state was disposed + recreated, and every create
//      paid a `syncCanvasSize` forced layout. `data-godot-shader-dormant` parks the binding instead
//      (see ../src/shader-dormant): same binding object, hidden canvas, skipped by the loop and the
//      rect batch, `syncCanvasSize` deferred to the wake — and disposed for real after ~30s.
//
// These stub a fake WebGL2/2D context, a CONTROLLABLE rAF queue and a CONTROLLABLE ResizeObserver.
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

import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  DORMANT_DISPOSE_SECONDS,
  SHADER_DORMANT_ATTR,
} from "../src/shader-dormant";
import {
  __resetShaderSourceRequestsForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

// A plain animated shader (TIME keeps the loop alive); no `#include`, so one source fetch per bind.
const TIME_SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME, 0.0, 0.0, 1.0); }";
// SCREEN_UV needs the node÷root viewport rects — the batched read a dormant binding must skip.
const SCREEN_UV_SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(SCREEN_UV, TIME, 1.0); }";

function fakeGl(): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
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

// Every node canvas's 2D context funnels its calls through this counter, so "did the loop render
// this frame?" is observable (renderNode ends with a drawImage onto the node canvas).
let ctx2dCalls: Record<string, number> = {};
function fakeCtx2d(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, k: string) => () => {
        ctx2dCalls[k] = (ctx2dCalls[k] ?? 0) + 1;
      },
    },
  );
}

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

// Controllable ResizeObserver: record every construction + observed target so the "ONE per runtime"
// claim is testable, and keep the callbacks so a test can deliver entries by hand.
let resizeCallbacks: ResizeObserverCallback[] = [];
let observedTargets: Element[] = [];

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return fakeCtx2d();
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
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
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetShaderSourceRequestsForTest();
  rafQueue = [];
  ctx2dCalls = {};
  resizeCallbacks = [];
  observedTargets = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe(target: Element): void {
      observedTargets.push(target);
    }
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// NB: unique shader paths per test — the program cache is module-scoped.
function shaderNode(
  path: string,
  opts: { dormant?: boolean } = {},
): { node: HTMLElement; self: HTMLElement; boxReads: { count: number } } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  if (opts.dormant) node.setAttribute(SHADER_DORMANT_ATTR, "1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  // clientWidth/clientHeight are THE forced-layout hazard — count every read.
  const boxReads = { count: 0 };
  Object.defineProperty(self, "clientWidth", {
    get: () => {
      boxReads.count += 1;
      return 100;
    },
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => {
      boxReads.count += 1;
      return 50;
    },
    configurable: true,
  });
  node.appendChild(self);
  return { node, self, boxReads };
}

function mount(...nodes: HTMLElement[]): HTMLElement {
  const root = document.createElement("div");
  for (const node of nodes) root.appendChild(node);
  document.body.appendChild(root);
  return root;
}

function nodeCanvas(self: HTMLElement): HTMLCanvasElement | null {
  return self.querySelector("canvas");
}

describe("webgl runtime — in-flight shader-source dedupe", () => {
  it("resolves ONE source for N concurrently-created nodes sharing a shader", async () => {
    const a = shaderNode("res://dedupe-shared.gdshader");
    const b = shaderNode("res://dedupe-shared.gdshader");
    const c = shaderNode("res://dedupe-shared.gdshader");
    const root = mount(a.node, b.node, c.node);
    const resolveShaderSource = vi.fn(async () => TIME_SHADER);

    const rt = createWebglShaderRuntime(root, { resolveShaderSource } as never);
    rt.reconcile();
    await settle();

    expect(resolveShaderSource).toHaveBeenCalledTimes(1);
    // …and all three still got their binding (a canvas each).
    expect(nodeCanvas(a.self)).not.toBeNull();
    expect(nodeCanvas(b.self)).not.toBeNull();
    expect(nodeCanvas(c.self)).not.toBeNull();
    rt.dispose();
  });

  it("still fetches once per DISTINCT shader", async () => {
    const a = shaderNode("res://dedupe-distinct-a.gdshader");
    const b = shaderNode("res://dedupe-distinct-b.gdshader");
    const root = mount(a.node, b.node);
    const resolveShaderSource = vi.fn(async () => TIME_SHADER);

    const rt = createWebglShaderRuntime(root, { resolveShaderSource } as never);
    rt.reconcile();
    await settle();

    expect(resolveShaderSource).toHaveBeenCalledTimes(2);
    rt.dispose();
  });

  it("drops the entry on rejection so a later bind retries", async () => {
    const a = shaderNode("res://dedupe-retry.gdshader");
    const root = mount(a.node);
    const resolveShaderSource = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(TIME_SHADER);

    const rt = createWebglShaderRuntime(root, { resolveShaderSource } as never);
    rt.reconcile();
    await settle();
    expect(resolveShaderSource).toHaveBeenCalledTimes(1);
    expect(nodeCanvas(a.self)).toBeNull(); // the failed fetch left it on the CSS fallback

    rt.reconcile(); // the host re-renders → retry
    await settle();
    expect(resolveShaderSource).toHaveBeenCalledTimes(2);
    expect(nodeCanvas(a.self)).not.toBeNull();
    rt.dispose();
  });
});

describe("webgl runtime — one shared ResizeObserver", () => {
  it("constructs exactly ONE observer per runtime and observes every binding through it", async () => {
    const a = shaderNode("res://ro-shared-a.gdshader");
    const b = shaderNode("res://ro-shared-b.gdshader");
    const root = mount(a.node, b.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();

    expect(resizeCallbacks.length).toBe(1);
    expect(observedTargets).toContain(a.self);
    expect(observedTargets).toContain(b.self);
    rt.dispose();
  });

  it("dispatches an entry to the binding that owns its target, and only that one", async () => {
    const a = shaderNode("res://ro-dispatch-a.gdshader");
    const b = shaderNode("res://ro-dispatch-b.gdshader");
    const root = mount(a.node, b.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    const canvasA = nodeCanvas(a.self);
    const canvasB = nodeCanvas(b.self);
    expect(canvasA?.width).toBe(100); // create-time sync from clientWidth
    expect(canvasB?.width).toBe(100);

    resizeCallbacks[0](
      [
        { target: a.self, contentRect: { width: 220, height: 60 } },
      ] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );

    expect(canvasA?.width).toBe(220);
    expect(canvasB?.width).toBe(100); // untouched
    rt.dispose();
  });

  it("uses a target's LAST entry when one delivery carries several for it", async () => {
    const a = shaderNode("res://ro-last-entry.gdshader");
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();

    resizeCallbacks[0](
      [
        { target: a.self, contentRect: { width: 300, height: 60 } },
        { target: a.self, contentRect: { width: 180, height: 60 } },
      ] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );

    expect(nodeCanvas(a.self)?.width).toBe(180);
    rt.dispose();
  });
});

describe("webgl runtime — dormant bindings", () => {
  it("keeps the SAME binding across dormant → wake (no re-fetch, no re-created canvas)", async () => {
    const a = shaderNode("res://dormant-keep.gdshader");
    const root = mount(a.node);
    const resolveShaderSource = vi.fn(async () => TIME_SHADER);
    const rt = createWebglShaderRuntime(root, { resolveShaderSource } as never);
    rt.reconcile();
    await settle();
    const canvas = nodeCanvas(a.self);
    expect(canvas).not.toBeNull();

    a.node.setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    expect(nodeCanvas(a.self)).toBe(canvas); // the canvas — and its binding — survived
    expect(canvas?.style.display).toBe("none");

    a.node.removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    await settle();
    expect(nodeCanvas(a.self)).toBe(canvas);
    expect(canvas?.style.display).toBe("");
    expect(resolveShaderSource).toHaveBeenCalledTimes(1); // never re-resolved
    rt.dispose();
  });

  it("skips a dormant binding in the render loop and stops it keeping the loop alive", async () => {
    const a = shaderNode("res://dormant-loop.gdshader");
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    const drawnAwake = ctx2dCalls.drawImage ?? 0;
    expect(drawnAwake).toBeGreaterThan(0);

    a.node.setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    for (let i = 0; i < 5; i += 1) flushRaf();
    expect(ctx2dCalls.drawImage ?? 0).toBe(drawnAwake); // nothing rendered while parked
    // A TIME shader normally re-arms the loop every frame; parked, the queue drains to empty.
    expect(rafQueue.length).toBe(0);

    a.node.removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    flushRaf();
    expect(ctx2dCalls.drawImage ?? 0).toBeGreaterThan(drawnAwake);
    rt.dispose();
  });

  it("measures nothing for a dormant SCREEN_UV binding (skipped by the batched rect read)", async () => {
    const a = shaderNode("res://dormant-rects.gdshader");
    const root = mount(a.node);
    const rootRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
    }));
    root.getBoundingClientRect =
      rootRect as unknown as typeof root.getBoundingClientRect;
    const selfRect = vi.fn(() => ({
      left: 0,
      top: 0,
      width: 100,
      height: 50,
      right: 100,
      bottom: 50,
    }));
    a.self.getBoundingClientRect =
      selfRect as unknown as typeof a.self.getBoundingClientRect;

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_UV_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    const awakeReads = selfRect.mock.calls.length;
    expect(awakeReads).toBeGreaterThan(0);

    a.node.setAttribute(SHADER_DORMANT_ATTR, "1");
    rt.reconcile();
    for (let i = 0; i < 5; i += 1) flushRaf();
    expect(selfRect.mock.calls.length).toBe(awakeReads);
    rt.dispose();
  });

  it("pays NO box read when born dormant, and the wake reuses the observer's parked measurement", async () => {
    const a = shaderNode("res://dormant-born.gdshader", { dormant: true });
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();

    const canvas = nodeCanvas(a.self);
    expect(canvas).not.toBeNull();
    expect(canvas?.style.display).toBe("none");
    expect(a.boxReads.count).toBe(0); // the deferred syncCanvasSize never measured

    // Resizes/renderScale steps while parked pile up into the ONE deferred sync. The observer's
    // delivered box is CACHED (not dropped): the observer will not re-fire after the wake — the box
    // change already happened — so a wake sized from the stale pre-park box would stay wrong forever.
    resizeCallbacks[0](
      [
        { target: a.self, contentRect: { width: 400, height: 200 } },
      ] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
    rt.setRenderScale(0.5);
    expect(a.boxReads.count).toBe(0);

    a.node.removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    expect(a.boxReads.count).toBe(0); // the parked measurement made the wake read-free
    expect(canvas?.style.display).toBe("");
    expect(canvas?.width).toBe(200); // 400 observed box × 0.5 renderScale
    rt.dispose();
  });

  it("a wake with NO parked observer measurement pays exactly ONE box read", async () => {
    const a = shaderNode("res://dormant-born-unmeasured.gdshader", {
      dormant: true,
    });
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    expect(a.boxReads.count).toBe(0);

    a.node.removeAttribute(SHADER_DORMANT_ATTR);
    rt.reconcile();
    expect(a.boxReads.count).toBe(2); // clientWidth + clientHeight, exactly once
    expect(nodeCanvas(a.self)?.width).toBe(100); // the freshly-read 100 box
    rt.dispose();
  });

  it("disposes a binding that stays dormant past the expiry window", async () => {
    const a = shaderNode("res://dormant-expiry.gdshader");
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    const canvas = nodeCanvas(a.self);
    expect(canvas?.isConnected).toBe(true);

    // Fake timers ONLY around the sweep: the async create above needs real ones.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      a.node.setAttribute(SHADER_DORMANT_ATTR, "1");
      rt.reconcile();

      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 1000 - 1);
      expect(canvas?.isConnected).toBe(true); // still parked, still kept

      vi.advanceTimersByTime(1);
      expect(canvas?.isConnected).toBe(false); // swept: canvas removed, binding gone
      expect(nodeCanvas(a.self)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    rt.dispose();
  });

  it("does not dispose a binding that woke before the sweep fired", async () => {
    const a = shaderNode("res://dormant-woke.gdshader");
    const root = mount(a.node);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => TIME_SHADER,
    } as never);
    rt.reconcile();
    await settle();
    const canvas = nodeCanvas(a.self);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      a.node.setAttribute(SHADER_DORMANT_ATTR, "1");
      rt.reconcile();
      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 500);
      a.node.removeAttribute(SHADER_DORMANT_ATTR);
      rt.reconcile();
      vi.advanceTimersByTime(DORMANT_DISPOSE_SECONDS * 1000);
      expect(canvas?.isConnected).toBe(true);
      expect(nodeCanvas(a.self)).toBe(canvas);
    } finally {
      vi.useRealTimers();
    }
    rt.dispose();
  });
});
