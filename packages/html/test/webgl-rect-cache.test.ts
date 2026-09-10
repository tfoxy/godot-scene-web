// jsdom (gsw default env).
//
// The screen-space shader paths (SCREEN_UV / SCREEN_TEXTURE / SCREEN_PIXEL_SIZE) need viewport
// rects: the scene root's, and each such node's self-layer. Measuring those inside the rAF loop
// is a FORCED LAYOUT every frame (and per SCREEN_UV node per frame) — a fixed main-thread cost
// on a screen where nothing moves, which is what phone traces showed. The runtime now caches
// them and re-reads in ONE batch at tick start, only when something could have moved them:
// `reconcile()`, a binding's ResizeObserver, a window resize, a new binding, or a conservative
// TTL fallback (a CSS-transition-driven move fires none of the other four).
//
// These stub a fake WebGL2/2D context, a CONTROLLABLE rAF queue, and a CONTROLLABLE clock, and
// count `getBoundingClientRect` calls on the root + self-layer.
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

import { EFFECTS_SUSPENDED_ATTR } from "../src/effects-suspend";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

// SCREEN_UV (needs the node÷root rects) + TIME (keeps the loop running every frame).
const SCREEN_UV_SHADER = `
shader_type canvas_item;
void fragment() { COLOR = vec4(SCREEN_UV, TIME, 1.0); }
`;
// A plain animated shader with no screen-space inputs — must never measure anything.
const PLAIN_TIME_SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME, 0.0, 0.0, 1.0); }";

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

// Controllable clock (read via shared-gl's `performanceNow`), so the rect-cache TTL is testable.
let clockMs = 0;
const advance = (ms: number): void => {
  clockMs += ms;
};

// Controllable ResizeObserver: keep the callbacks so a test can fire one by hand.
let resizeCallbacks: ResizeObserverCallback[] = [];

let origNow: () => number;
let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origNow = performance.now;
  performance.now = (() => clockMs) as typeof performance.now;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
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
  performance.now = origNow;
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest(); // also resets the shared clock origin
  clockMs = 0;
  rafQueue = [];
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// Replace an element's getBoundingClientRect with a counting stub.
function spyRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  }));
  el.getBoundingClientRect = fn as unknown as typeof el.getBoundingClientRect;
  return fn;
}

// NB: unique shader paths per test — the program cache is module-scoped.
function shaderNode(path: string): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    get: () => 100,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => 50,
    configurable: true,
  });
  node.appendChild(self);
  return { node, self };
}

interface Mounted {
  root: HTMLElement;
  self: HTMLElement;
  rootRect: ReturnType<typeof vi.fn>;
  selfRect: ReturnType<typeof vi.fn>;
}

function mountRoot(path: string): Mounted {
  const root = document.createElement("div");
  const { node, self } = shaderNode(path);
  root.appendChild(node);
  document.body.appendChild(root);
  return {
    root,
    self,
    rootRect: spyRect(root, { left: 0, top: 0, width: 800, height: 600 }),
    selfRect: spyRect(self, { left: 100, top: 50, width: 100, height: 50 }),
  };
}

const source = (src: string) =>
  ({ resolveShaderSource: async () => src }) as never;

describe("webgl runtime — screen-space rect cache", () => {
  it("measures once, then renders SCREEN_UV frames with ZERO forced layout", async () => {
    const m = mountRoot("res://rect-steady.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();

    advance(16);
    flushRaf(); // first rendered frame: the batched read measures root + self ONCE each
    expect(m.rootRect).toHaveBeenCalledTimes(1);
    expect(m.selfRect).toHaveBeenCalledTimes(1);

    // Steady state: further animated frames reuse the cache — no getBoundingClientRect at all.
    for (let i = 0; i < 5; i += 1) {
      advance(16);
      flushRaf();
    }
    expect(m.rootRect).toHaveBeenCalledTimes(1);
    expect(m.selfRect).toHaveBeenCalledTimes(1);
    rt.dispose();
  });

  it("never measures anything for a shader with no screen-space inputs", async () => {
    const m = mountRoot("res://rect-none.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(PLAIN_TIME_SHADER));
    rt.reconcile();
    await settle();

    for (let i = 0; i < 5; i += 1) {
      advance(16);
      flushRaf();
    }
    expect(m.rootRect).not.toHaveBeenCalled();
    expect(m.selfRect).not.toHaveBeenCalled();
    rt.dispose();
  });

  it("re-measures once after reconcile() (the host rendered → the DOM may have moved)", async () => {
    const m = mountRoot("res://rect-reconcile.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(1);

    rt.reconcile(); // host frame
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    expect(m.selfRect).toHaveBeenCalledTimes(2);

    // …and back to zero-cost frames until the next invalidation.
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    rt.dispose();
  });

  it("re-measures after a window resize", async () => {
    const m = mountRoot("res://rect-window.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("resize"));
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    expect(m.selfRect).toHaveBeenCalledTimes(2);
    rt.dispose();
  });

  it("re-measures after the binding's ResizeObserver fires", async () => {
    const m = mountRoot("res://rect-resize-observer.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();
    advance(16);
    flushRaf();
    expect(m.selfRect).toHaveBeenCalledTimes(1);
    // ONE observer for the whole runtime, dispatching by the entry's `target` (see the shared
    // ResizeObserver in webgl/runtime) — not one observer per binding.
    expect(resizeCallbacks.length).toBe(1);

    resizeCallbacks[0](
      [
        { target: m.self, contentRect: { width: 120, height: 60 } },
      ] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    expect(m.selfRect).toHaveBeenCalledTimes(2);
    rt.dispose();
  });

  it("re-measures on the TTL fallback (a CSS-transition move signals nothing else)", async () => {
    const m = mountRoot("res://rect-ttl.gdshader");
    const rt = createWebglShaderRuntime(m.root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(1);

    // Well inside the TTL: still cached.
    advance(50);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(1);

    // Past it: one refresh, then cached again.
    advance(150);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    expect(m.selfRect).toHaveBeenCalledTimes(2);
    advance(16);
    flushRaf();
    expect(m.rootRect).toHaveBeenCalledTimes(2);
    rt.dispose();
  });

  it("does not measure a SUSPENDED binding (no layout for occluded nodes)", async () => {
    const root = document.createElement("div");
    const cover = document.createElement("div");
    cover.setAttribute(EFFECTS_SUSPENDED_ATTR, "1");
    const { node, self } = shaderNode("res://rect-suspended.gdshader");
    cover.appendChild(node);
    root.appendChild(cover);
    document.body.appendChild(root);
    const rootRect = spyRect(root, {
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    });
    const selfRect = spyRect(self, { left: 0, top: 0, width: 100, height: 50 });

    const rt = createWebglShaderRuntime(root, source(SCREEN_UV_SHADER));
    rt.reconcile();
    await settle();
    for (let i = 0; i < 3; i += 1) {
      advance(200); // past the TTL every time — still nothing to measure
      flushRaf();
    }
    expect(rootRect).not.toHaveBeenCalled();
    expect(selfRect).not.toHaveBeenCalled();

    // Resumed: measured again on the next frame.
    cover.removeAttribute(EFFECTS_SUSPENDED_ATTR);
    rt.reconcile();
    advance(16);
    flushRaf();
    expect(rootRect).toHaveBeenCalledTimes(1);
    expect(selfRect).toHaveBeenCalledTimes(1);
    rt.dispose();
  });
});
