// jsdom (gsw default env).
//
// UV-window staleness vs the static-frame cache (the UNDERDOCKS widened-background black-band bug):
// in frozen-TIME mode a node's rendered frame is cached under `staticFrameKey`. The frame's CONTENT
// depends on the exact `_godot_uv_window` it was drawn under, so the cache must NEVER serve a frame
// across ANY window change — including one too small for the old QUANTIZED window key to notice
// (quantizeForKey rounds to 0.01: "0.004,…" collided with "0,…"), and including one where the canvas
// w/h happen to stay identical (a box growth compensating a window shrink — exactly the couch
// spread-vs-clip geometry, where box×F × du/F == box×du). These tests pin the exact-window key.
//
// Second gap (same defect, "never drawn" half): the shared ResizeObserver's syncCanvasSize reallocs
// (and thereby CLEARS) the node canvas and marks the binding dirty, but never re-kicked the parked
// static loop — so the post-resize frame was never drawn until an unrelated event scheduled a tick.
// Pinned here: an observer resize must be followed by a re-render with no other trigger.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

// A TIME-reading shader so `usesTime` is true (frozen mode's cacheable case).
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

let drawCount = 0;
// Every `_godot_uv_window` uniform upload, in draw order: the window each GL draw ACTUALLY used.
let drawnWindows: number[][] = [];

function fakeGl(): unknown {
  let lastWindow: number[] | null = null;
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_program: unknown, name: unknown) => ({ name }),
    getActiveUniform: () => null,
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
    uniform4f: (loc: unknown, ...value: unknown[]) => {
      if ((loc as { name?: string })?.name === "_godot_uv_window") {
        lastWindow = value as number[];
      }
      return undefined;
    },
    drawArrays: () => {
      drawCount += 1;
      if (lastWindow) drawnWindows.push(lastWindow);
      return undefined;
    },
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

// Controllable rAF queue (flushed by hand), as in webgl-static.test.ts.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): number {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
  return q.length;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
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

// Hand-deliverable ResizeObserver so tests can fire a real contentRect resize.
let roCallbacks: Array<(entries: unknown[]) => void> = [];

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  drawCount = 0;
  drawnWindows = [];
  rafQueue = [];
  roCallbacks = [];
  globalThis.ResizeObserver = class {
    cb: (entries: unknown[]) => void;
    constructor(cb: (entries: unknown[]) => void) {
      this.cb = cb;
      roCallbacks.push(cb);
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function shaderNode(path = "res://bg.gdshader", boxW = 100, boxH = 50) {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  let w = boxW;
  let h = boxH;
  Object.defineProperty(self, "clientWidth", {
    get: () => w,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => h,
    configurable: true,
  });
  node.appendChild(self);
  return {
    node,
    self,
    setBox(nw: number, nh: number) {
      w = nw;
      h = nh;
    },
  };
}

function staticRuntime(root: HTMLElement) {
  return createWebglShaderRuntime(root, {
    resolveShaderSource: async () => SHADER,
    staticShaders: true,
  } as never);
}

describe("webgl runtime — static-frame cache vs uv-window changes", () => {
  it("a sub-quantum window change with UNCHANGED canvas size is a cache MISS (fresh draw, new window drawn)", async () => {
    // Pre-fix, windowFrameKey quantized to 0.01: "0.004,0.004,0.5,0.5" collided with "0,0,0.5,0.5",
    // and since du/dv (hence w/h) were unchanged the second render blitted the OLD-window frame.
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,0.5");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(drawnWindows[0]).toEqual([0, 0, 0.5, 0.5]);

    self.setAttribute("data-godot-shader-uv-window", "0.004,0.004,0.5,0.5");
    rt.reconcile(); // same du/dv → same canvas size → pre-fix served the stale frame from cache
    expect(rt.stats().cacheHits).toBe(0); // the frame under a DIFFERENT window must never be served
    expect(rt.stats().draws).toBe(2);
    expect(drawnWindows[1]).toEqual([0.004, 0.004, 0.5, 0.5]);
    expect(rt.stats().draws).toBe(drawCount);
    rt.dispose();
  });

  it("a size-compensated window change (box grows × F, du shrinks ÷ F ⇒ SAME w/h) is a cache MISS", async () => {
    // The couch spread geometry: the stage box and the clip fraction move inversely, so the canvas
    // backing size can come out IDENTICAL across a real window change. The exact-window key must
    // still miss. (Pre-fix this was only safe when the QUANTIZED windows differed.)
    const root = document.createElement("div");
    const { node, self, setBox } = shaderNode("res://bg.gdshader", 100, 50);
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.998,1");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    // Box 100 → 99.8 while du 0.998 → 1: cssW stays 99.8 → the SAME backing width (realloc-free),
    // and pre-fix the quantized keys ("0,0,1,1" both, 0.998 rounds to 1) collided ⇒ stale blit.
    setBox(99.8, 50);
    for (const cb of roCallbacks)
      cb([{ target: self, contentRect: { width: 99.8, height: 50 } }]);
    self.setAttribute("data-godot-shader-uv-window", "0,0,1,1");
    rt.reconcile();
    flushRaf();
    // The NEW window must have been GL-drawn (pre-fix the quantized key collided — "0.998" rounds
    // to "1" — and with w/h unchanged the old-window frame was blitted instead of ever drawing).
    // A follow-up tick MAY re-blit that same fresh frame (same key, same content) — that's benign.
    expect(rt.stats().draws).toBe(2);
    expect(drawnWindows[1]).toEqual([0, 0, 1, 1]);
    rt.dispose();
  });

  it("a window change WITH a size change draws fresh at the new size (device widen values)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.8013,0.9539");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(drawnWindows[0]).toEqual([0, 0, 0.8013, 0.9539]);

    self.setAttribute("data-godot-shader-uv-window", "0,0,1,0.9539");
    rt.reconcile(); // widen: resize + synchronous anti-flicker render
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    expect(rt.stats().syncRenders).toBe(1);
    expect(drawnWindows[1]).toEqual([0, 0, 1, 0.9539]);
    rt.dispose();
  });

  it("a window change while DORMANT renders fresh at the new window on wake (no stale cache serve)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.8013,0.9539");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    node.setAttribute("data-godot-shader-dormant", "1");
    rt.reconcile(); // park
    self.setAttribute("data-godot-shader-uv-window", "0,0,1,0.9539");
    rt.reconcile(); // window change lands on the parked binding: canvas sync + render deferred
    expect(rt.stats().syncRenders).toBe(0); // parked ⇒ NO synchronous render (the on-device shape)
    flushRaf();
    expect(rt.stats().draws).toBe(1); // still parked, nothing drawn

    node.removeAttribute("data-godot-shader-dormant");
    rt.reconcile(); // wake pays the deferred sync and re-renders
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0);
    expect(drawnWindows[1]).toEqual([0, 0, 1, 0.9539]);
    rt.dispose();
  });

  it("dynamic (non-static) mode is unaffected: window changes re-render live, never via the cache", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,0.5");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    self.setAttribute("data-godot-shader-uv-window", "0.004,0.004,0.5,0.5");
    rt.reconcile(); // sync render at the new window
    flushRaf(); // and the live TIME loop keeps drawing
    expect(rt.stats().draws).toBe(3);
    expect(rt.stats().cacheHits).toBe(0);
    expect(drawnWindows[1]).toEqual([0.004, 0.004, 0.5, 0.5]);
    rt.dispose();
  });

  it("the cache stays effective for the common case: identical nodes with an UNCHANGED window still share one draw", async () => {
    const root = document.createElement("div");
    const a = shaderNode("res://glow.gdshader");
    const b = shaderNode("res://glow.gdshader");
    a.self.setAttribute("data-godot-shader-uv-window", "0,0,0.8013,0.9539");
    b.self.setAttribute("data-godot-shader-uv-window", "0,0,0.8013,0.9539");
    root.appendChild(a.node);
    root.appendChild(b.node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    // One GL draw, the identical sibling blits the cached frame.
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().cacheHits).toBe(1);
    rt.dispose();
  });
});

describe("webgl runtime — observer resize must re-render in static mode", () => {
  it("a ResizeObserver box change reallocs the (cleared) canvas AND re-kicks the parked loop", async () => {
    // Pre-fix: the observer resized + cleared the backing store and set `dirty`, but never called
    // scheduleRender — with the frozen loop self-stopped the node stayed BLANK (or visually stale)
    // until an unrelated event happened to schedule a tick. This is the "widened frame never drawn"
    // half of the UNDERDOCKS defect (syncRenders 0 on-device: nothing re-rendered the resized canvas).
    const root = document.createElement("div");
    const { node, self, setBox } = shaderNode("res://bg.gdshader", 80, 50);
    self.setAttribute("data-godot-shader-uv-window", "0,0,1,0.9539");
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    expect(rt.stats().canvasReallocs).toBe(1);

    setBox(100, 50);
    for (const cb of roCallbacks)
      cb([{ target: self, contentRect: { width: 100, height: 50 } }]);
    expect(rt.stats().canvasReallocs).toBe(2); // backing store re-assigned (and thereby cleared)
    flushRaf(); // the observer must have re-armed the loop itself — no other trigger exists here
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().cacheHits).toBe(0); // new size ⇒ new key ⇒ fresh draw, not a stale blit
    rt.dispose();
  });

  it("a ResizeObserver change for a DORMANT binding defers work and does not spin the loop", async () => {
    const root = document.createElement("div");
    const { node, self, setBox } = shaderNode("res://bg.gdshader", 80, 50);
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    node.setAttribute("data-godot-shader-dormant", "1");
    rt.reconcile();
    setBox(100, 50);
    for (const cb of roCallbacks)
      cb([{ target: self, contentRect: { width: 100, height: 50 } }]);
    expect(rt.stats().canvasReallocs).toBe(1); // deferred: no realloc while parked
    flushRaf();
    expect(rt.stats().draws).toBe(1); // and nothing rendered

    node.removeAttribute("data-godot-shader-dormant");
    rt.reconcile(); // wake pays the one deferred sync + renders
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(rt.stats().canvasReallocs).toBe(2);
    rt.dispose();
  });
});
