// jsdom (gsw default env).
//
// The SHARED GL canvas vs a binding whose backing GROWS after creation (the last gap of the
// UNDERDOCKS widened-background black-band defect): every shader/particle node renders into the
// bottom-left w×h of ONE shared WebGL canvas and blits that region to its own 2D canvas. Setting
// `canvas.width/height` on the shared canvas REQUESTS a drawing-buffer realloc — but the GL
// implementation may come back SMALLER than asked (the GPU's max texture/renderbuffer size, or an
// allocation failure that keeps the previous buffer: Chrome restores the last-known-good size).
// Pre-fix the runtime trusted the attribute: the viewport/scissor used the binding's full w×h and
// the blit's SOURCE rect was measured against the attribute-sized canvas, so every pixel beyond
// the real buffer read out-of-bounds → transparent → the black band at EXACTLY oldWidth/newWidth
// (on-device: painted content ended at 3863 of a 4821-wide backing).
//
// Pinned here: the draw + blit must be confined to the pixels the context ACTUALLY has
// (`gl.drawingBufferWidth/Height`), and the blit must still cover the binding's FULL backing
// (content scaled — lower resolution, never a clipped band), with the discovered ceiling latched
// so a doomed grow isn't re-attempted (and the buffer re-cleared) on every draw.
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

// A TIME-reading shader (frozen mode's cacheable case, like the UNDERDOCKS background).
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

// ---- fake GL with a MODELED drawing-buffer ceiling -------------------------------------------
//
// `drawingBufferWidth/Height` report min(canvas attribute, cap) — the observable contract of a
// clamped/failed realloc (the attribute holds what was ASKED, the buffer holds what EXISTS).
let bufferCapW = Number.POSITIVE_INFINITY;
let bufferCapH = Number.POSITIVE_INFINITY;
let sharedCanvas: HTMLCanvasElement | null = null;
let viewports: number[][] = [];
// Every 2D drawImage, with its source + dest canvas, so tests can isolate the shared-canvas blits.
let blits: Array<{ source: unknown; dest: HTMLCanvasElement; args: number[] }> =
  [];

function sharedBlits() {
  return blits.filter((b) => b.source === sharedCanvas);
}

function fakeGl(canvas: HTMLCanvasElement): unknown {
  const overrides: Record<string, unknown> = {
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
    viewport: (...args: unknown[]) => {
      viewports.push(args as number[]);
    },
  };
  Object.defineProperty(overrides, "drawingBufferWidth", {
    get: () => Math.min(canvas.width, bufferCapW),
  });
  Object.defineProperty(overrides, "drawingBufferHeight", {
    get: () => Math.min(canvas.height, bufferCapH),
  });
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

function fake2d(canvas: HTMLCanvasElement): unknown {
  const overrides: Record<string, unknown> = {
    drawImage: (...args: unknown[]) => {
      blits.push({
        source: args[0],
        dest: canvas,
        args: args.slice(1) as number[],
      });
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
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === "webgl2") {
      sharedCanvas = this;
      return fakeGl(this);
    }
    if (kind === "2d") return fake2d(this);
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
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
  bufferCapW = Number.POSITIVE_INFINITY;
  bufferCapH = Number.POSITIVE_INFINITY;
  sharedCanvas = null;
  viewports = [];
  blits = [];
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

function resize(self: HTMLElement, width: number, height: number): void {
  for (const cb of roCallbacks)
    cb([{ target: self, contentRect: { width, height } }]);
}

describe("webgl runtime — shared canvas vs a binding that grows after creation", () => {
  it("an unconstrained buffer: a later realloc grows the shared canvas and the blit covers the new width", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://bg.gdshader", 100, 50);
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    // Grow past the shared canvas's current size (jsdom canvases start at 300×150).
    resize(self, 400, 50);
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    expect(sharedCanvas?.width).toBeGreaterThanOrEqual(400);
    const blit = sharedBlits().at(-1);
    expect(blit).toBeDefined();
    const [, , sw, , , , dw] = blit?.args ?? [];
    expect(sw).toBe(400); // blit source covers the grown width…
    expect(dw).toBe(400); // …and the dest covers the binding's full backing
    rt.dispose();
  });

  it("a WIDTH-capped drawing buffer: the draw+blit stay within the real buffer and the blit still covers the FULL backing (scaled, no band)", async () => {
    // The device shape: the binding grows to a width the GL buffer cannot reach; the attribute
    // takes the value, the buffer doesn't. Pre-fix: viewport/scissor at the attribute size and a
    // source rect past the real buffer → out-of-bounds read → the black right band.
    bufferCapW = 350;
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://bg.gdshader", 100, 50);
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);

    resize(self, 400, 50); // realloc to 400 — beyond what the buffer can hold (350)
    flushRaf();
    expect(rt.stats().draws).toBe(2);
    const blit = sharedBlits().at(-1);
    expect(blit).toBeDefined();
    const [, , sw, , , , dw, dh] = blit?.args ?? [];
    expect(sw).toBeLessThanOrEqual(350); // source rect confined to pixels that EXIST
    expect(dw).toBe(400); // dest still covers the full 400px backing (scaled content)
    expect(dh).toBe(50);
    const vp = viewports.at(-1);
    expect(vp?.[2]).toBeLessThanOrEqual(350); // the draw itself fits the real buffer
    // Attribute snapped to the buffer: the canvas-as-image dims match the pixels that exist.
    expect(sharedCanvas?.width).toBe(350);
    rt.dispose();
  });

  it("a HEIGHT-capped drawing buffer: the bottom-left blit origin is measured against the REAL buffer height", async () => {
    // The blit copies the bottom h rows (GL origin) as [bufferHeight - h …); measured against the
    // ATTRIBUTE height (jsdom default 150) with a 60px buffer, the whole source rect was
    // out-of-bounds — the vertical flavor of the same defect.
    bufferCapH = 60;
    const root = document.createElement("div");
    const { node } = shaderNode("res://bg.gdshader", 100, 50);
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    expect(rt.stats().draws).toBe(1);
    const blit = sharedBlits().at(-1);
    expect(blit).toBeDefined();
    const [, sy, , sh, , , , dh] = blit?.args ?? [];
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(sy + sh).toBeLessThanOrEqual(60); // source rows exist in the real buffer
    expect(dh).toBe(50); // dest still covers the binding's full backing height
    rt.dispose();
  });

  it("the discovered ceiling is LATCHED: a further grow does not re-attempt (and re-clear) a doomed realloc", async () => {
    bufferCapW = 350;
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://bg.gdshader", 100, 50);
    root.appendChild(node);
    document.body.appendChild(root);
    const rt = staticRuntime(root);
    rt.reconcile();
    await settle();
    flushRaf();
    resize(self, 400, 50); // discovers the 350 ceiling
    flushRaf();
    expect(sharedCanvas?.width).toBe(350);

    // Count attribute writes from here on: a doomed grow would re-assign width every render.
    const desc = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "width",
    );
    if (!desc?.get || !desc.set)
      throw new Error("canvas width not an accessor");
    let widthSets = 0;
    Object.defineProperty(sharedCanvas, "width", {
      get() {
        return desc.get?.call(this);
      },
      set(value: number) {
        widthSets += 1;
        desc.set?.call(this, value);
      },
      configurable: true,
    });

    resize(self, 500, 50); // even bigger — still capped at 350
    flushRaf();
    expect(rt.stats().draws).toBe(3);
    expect(widthSets).toBe(0); // no realloc attempt past the latched ceiling
    const blit = sharedBlits().at(-1);
    const [, , sw, , , , dw] = blit?.args ?? [];
    expect(sw).toBeLessThanOrEqual(350);
    expect(dw).toBe(500); // full coverage of the (even wider) backing
    rt.dispose();
  });
});
