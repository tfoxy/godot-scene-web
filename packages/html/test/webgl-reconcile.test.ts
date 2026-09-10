// jsdom (gsw default env).
//
// The WebGL shader runtime is PERSISTENT + reconciled (Phase J): on a re-render it KEEPS an
// unchanged shader node's binding — a cheap attribute-only update with NO forced `syncCanvasSize`
// (clientWidth) layout — instead of tearing down + recreating every canvas (the dominant
// per-render reflow). These tests stub a fake WebGL2/2D context + ResizeObserver, and stub rAF to
// a no-op so the render loop (renderNode) never runs — only the create/reconcile bookkeeping is
// exercised, which is where the forced layout lived.
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
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }";
const options = { resolveShaderSource: async () => SHADER } as never;

// A fake WebGL2 context: methods that must return truthy do; everything else (incl. the GL
// enum constants, which are only ever passed to no-op methods on the create path) is a harmless
// no-op. The render loop is disabled (no-op rAF), so renderNode's draw/uniform calls never run.
// Programs really built through the fake context. A compile is asynchronous now (its status query
// waits for the driver instead of blocking on it), so "two nodes, one shader" is a real window in
// which a second create can find the first still in flight — and must join it rather than kick the
// driver a second time.
const glCalls = { createProgram: 0 };

function fakeGl(): unknown {
  const overrides: Record<string, () => unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    getActiveUniform: () => null,
    getExtension: () => null,
    getParameter: () => "",
    createShader: () => ({}),
    createProgram: () => {
      glCalls.createProgram++;
      return {};
    },
    createTexture: () => ({}),
    createBuffer: () => ({}),
    createVertexArray: () => ({}),
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await flush();
};

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
let origRAF: typeof globalThis.requestAnimationFrame;
let origCAF: typeof globalThis.cancelAnimationFrame;
let origRO: typeof globalThis.ResizeObserver;
let observeSpy: ReturnType<typeof vi.fn>;

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
  // No-op rAF: never run the render tick (no renderNode), so the only layout reads come from
  // createBinding's syncCanvasSize — exactly what the KEEP gate asserts is NOT re-run.
  globalThis.requestAnimationFrame = (() =>
    1) as typeof globalThis.requestAnimationFrame;
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
  observeSpy = vi.fn();
  globalThis.ResizeObserver = class {
    observe = observeSpy;
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function shaderNode(path = "res://s.gdshader"): {
  node: HTMLElement;
  self: HTMLElement;
} {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  node.appendChild(self);
  return { node, self };
}

function spyClientSize(el: HTMLElement): {
  w: ReturnType<typeof vi.fn>;
  h: ReturnType<typeof vi.fn>;
} {
  const w = vi.fn(() => 100);
  const h = vi.fn(() => 50);
  Object.defineProperty(el, "clientWidth", { get: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { get: h, configurable: true });
  return { w, h };
}

const canvasIn = (self: HTMLElement): Element | null =>
  self.querySelector("[data-godot-shader-canvas]");

describe("webgl runtime reconcile (persist + reconcile, Phase J)", () => {
  it("keeps an unchanged node's binding on reconcile with NO forced clientWidth read", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    const { w } = spyClientSize(self);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    const canvas = canvasIn(self);
    expect(canvas).toBeTruthy(); // binding created
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const wCalls = w.mock.calls.length;
    expect(wCalls).toBeGreaterThanOrEqual(1); // syncCanvasSize read clientWidth ONCE at create

    // Reconcile again, no DOM change → KEEP path (attribute-only update).
    rt.reconcile();
    await settle();
    expect(canvasIn(self)).toBe(canvas); // SAME canvas element (not recreated)
    expect(observeSpy).toHaveBeenCalledTimes(1); // no second ResizeObserver
    expect(w.mock.calls.length).toBe(wCalls); // ← the gate: NO additional forced layout
    rt.dispose();
  });

  it("measures a create BURST in one contiguous run — every canvas is built before any box is read", async () => {
    // THE FLUSH, not the read, is what a forced layout costs (`../src/webgl/runtime`'s first-sizing
    // note). Building and measuring per binding interleaves N writes with N reads, so the browser
    // must flush style+layout N times inside one task; building them all first collapses that to
    // one. The interleave is observable without a trace: each `clientWidth` getter records how many
    // shader canvases were already in the DOM when it was called, so "every read saw all N" IS the
    // statement that no read landed between two builds.
    const root = document.createElement("div");
    const nodes = ["a", "b", "c", "d"].map((id) => {
      const made = shaderNode(`res://${id}.gdshader`);
      root.appendChild(made.node);
      return made;
    });
    document.body.appendChild(root);

    const canvasesAtRead: number[] = [];
    const readCounts: number[] = [];
    for (const [index, made] of nodes.entries()) {
      readCounts[index] = 0;
      const record = (): void => {
        readCounts[index]++;
        canvasesAtRead.push(
          root.querySelectorAll("[data-godot-shader-canvas]").length,
        );
      };
      Object.defineProperty(made.self, "clientWidth", {
        get: () => {
          record();
          return 120;
        },
        configurable: true,
      });
      Object.defineProperty(made.self, "clientHeight", {
        get: () => {
          record();
          return 80;
        },
        configurable: true,
      });
    }

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    for (const made of nodes) expect(canvasIn(made.self)).toBeTruthy();
    // One box read per binding: clientWidth + clientHeight, once each.
    expect(readCounts).toEqual([2, 2, 2, 2]);
    // …and every one of those reads happened with all four canvases already built.
    expect(canvasesAtRead).toHaveLength(8);
    expect(canvasesAtRead.every((count) => count === nodes.length)).toBe(true);
    rt.dispose();
  });

  it("compiles ONE program for a burst of nodes sharing a shader", async () => {
    // The compile is in flight across a microtask now, so both creates reach `getProgramAsync`
    // before either has a cached program to find. Without the in-flight request map that window is
    // two compiles of the same GLSL — on a phone, two driver stalls.
    const root = document.createElement("div");
    const nodes = [0, 1, 2].map(() => {
      const made = shaderNode("res://shared-burst.gdshader");
      root.appendChild(made.node);
      spyClientSize(made.self);
      return made;
    });
    document.body.appendChild(root);
    const before = glCalls.createProgram;

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    for (const made of nodes) expect(canvasIn(made.self)).toBeTruthy();
    expect(glCalls.createProgram - before).toBe(1);
    rt.dispose();
  });

  it("sizes a new binding's backing store before any frame can paint it", async () => {
    // The measure→write drain is a MICROTASK, so it lands before the rAF that would draw the
    // canvas. Awaiting a macrotask (what a frame is, at the earliest) must therefore always find a
    // sized backing store — never the 300x150 default a canvas has until something sizes it.
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://sized.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);
    spyClientSize(self); // 100 x 50

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    const canvas = canvasIn(self) as HTMLCanvasElement;
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
    rt.dispose();
  });

  it("creates a binding for a newly-added node and disposes one whose node left the DOM", async () => {
    const root = document.createElement("div");
    const a = shaderNode("res://a.gdshader");
    root.appendChild(a.node);
    document.body.appendChild(root);
    const aw = spyClientSize(a.self).w;

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();
    expect(canvasIn(a.self)).toBeTruthy();
    const aCalls = aw.mock.calls.length;

    // Add a second shader node → reconcile creates only IT (the survivor pays no new layout).
    const b = shaderNode("res://b.gdshader");
    root.appendChild(b.node);
    spyClientSize(b.self);
    rt.reconcile();
    await settle();
    expect(canvasIn(b.self)).toBeTruthy();
    expect(aw.mock.calls.length).toBe(aCalls); // node A untouched

    // Remove node B → reconcile disposes its binding (canvas removed).
    const bCanvas = canvasIn(b.self);
    b.node.remove();
    rt.reconcile();
    await settle();
    expect(bCanvas?.isConnected).toBe(false);
    expect(canvasIn(a.self)).toBeTruthy(); // A still bound
    rt.dispose();
  });

  it("recreates the binding when the shader itself swaps on the same element", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://one.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);
    spyClientSize(self);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();
    const first = canvasIn(self);
    expect(first).toBeTruthy();

    // Swap the shader (different path = different shaderKey) → dispose + recreate.
    node.setAttribute("data-godot-shader-path", "res://two.gdshader");
    rt.reconcile();
    await settle();
    const second = canvasIn(self);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first); // a fresh binding/canvas
    rt.dispose();
  });

  it("does not create a binding for a node removed before its source resolves (race)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    spyClientSize(self);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile(); // starts the async create
    node.remove(); // …then the node leaves the DOM before resolveShaderSource settles
    rt.reconcile();
    await settle();
    expect(canvasIn(self)).toBeNull(); // the generation guard bailed — no stale binding
    rt.dispose();
  });

  it("places the canvas over the uv-window sub-rect when the self-layer carries data-godot-shader-uv-window", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    // The mirror stamps the visible sub-rect on the self-layer (left half here).
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,1");
    root.appendChild(node);
    document.body.appendChild(root);
    spyClientSize(self);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    const canvas = canvasIn(self) as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    // Sub-rect placement (not full-bleed): width 50%, left 0% — and crucially NOT inset:0.
    expect(canvas.style.width).toBe("50%");
    expect(canvas.style.left).toBe("0%");
    expect(canvas.style.height).toBe("100%");
    rt.dispose();
  });

  it("leaves the canvas full-bleed when no uv-window is set (default)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    spyClientSize(self);

    const rt = createWebglShaderRuntime(root, options);
    rt.reconcile();
    await settle();

    const canvas = canvasIn(self) as HTMLCanvasElement;
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
    expect(canvas.style.left).not.toContain("%"); // full-bleed, not a sub-rect offset
    rt.dispose();
  });
});
