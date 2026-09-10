// jsdom (gsw default env).
//
// The RENDER-BACKEND seam (`../src/webgl/shader-backend`). Two contracts, both of which exist for a
// renderer that is not WebGL:
//
//   1. FRAME BRACKETING — every render the runtime drives sits inside `beginFrame()`/`endFrame()`,
//      the loop tick and the out-of-loop anti-flicker render alike. On GL both are no-ops (each
//      draw is submitted as it is issued); a batching backend records into ONE command submission
//      per tick, so a render outside the bracket would simply never reach the screen. The wrapper
//      below is the real GL backend with the three calls recorded around it — nothing is faked.
//   2. `drawableSource` SKIPS A WEBGPU CANVAS — the SCREEN_TEXTURE capture composites earlier
//      self-layers with `drawImage`, which comes back blank/pathological from a WebGPU canvas (S7,
//      docs/perf-harness.md). A canvas stamped `data-godot-effects-backend="webgpu"` must be passed
//      over in favour of the layer's texture image. Observed through the capture composite, the way
//      `webgl-screen-texture.test.ts` observes the rest of that path.
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

// Recorded backend calls, in order. `vi.hoisted` because the mock factory below is hoisted above
// this file's imports and would otherwise close over an uninitialised binding.
const { events, backendKinds } = vi.hoisted(() => ({
  events: [] as string[],
  backendKinds: [] as string[],
}));

// The REAL GL backend, wrapped so its frame bracket and its render verdict are observable. The
// runtime under test therefore renders exactly as it ships.
vi.mock("../src/webgl/shader-backend", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/webgl/shader-backend")>();
  return {
    ...actual,
    createWebglShaderBackend: (
      ...args: Parameters<typeof actual.createWebglShaderBackend>
    ) => {
      const backend = actual.createWebglShaderBackend(...args);
      backendKinds.push(backend.kind);
      return {
        ...backend,
        beginFrame() {
          events.push("begin");
          backend.beginFrame();
        },
        endFrame() {
          events.push("end");
          backend.endFrame();
        },
        renderNode(...call: Parameters<typeof backend.renderNode>) {
          const drew = backend.renderNode(...call);
          events.push(drew ? "render" : "skip");
          return drew;
        },
      };
    },
  };
});

// A TIME-reading shader, so the loop stays armed and each hand-flushed frame is one full tick.
const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";
// The motivating SCREEN_TEXTURE shape: sample what was drawn behind the node.
const SCREEN_SHADER = `
shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_nearest;
void fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV); }
`;

// Every source `drawImage` was handed, across every 2D context: the node blit (the shared GL
// canvas) and the capture composite (an earlier layer's canvas or texture image) alike.
let drawImageSources: unknown[] = [];

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

function fake2d(): unknown {
  const overrides: Record<string, (...args: unknown[]) => unknown> = {
    drawImage: (...args: unknown[]) => {
      drawImageSources.push(args[0]);
      return undefined;
    },
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
}

// A decoded capture image: jsdom never loads one (naturalWidth stays 0), and the capture path
// deliberately skips images that have not decoded — so the fallback source needs a stand-in.
class FakeImage {
  crossOrigin = "";
  src = "";
  complete = true;
  naturalWidth = 8;
  naturalHeight = 8;
}

// Controllable rAF: queue callbacks, flush them by hand.
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
let origImage: typeof globalThis.Image;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return fake2d();
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  origRAF = globalThis.requestAnimationFrame;
  origCAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    rafQueue.push(cb)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  origRO = globalThis.ResizeObserver;
  origImage = globalThis.Image;
  globalThis.Image = FakeImage as unknown as typeof Image;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = origGetContext;
  globalThis.requestAnimationFrame = origRAF;
  globalThis.cancelAnimationFrame = origCAF;
  globalThis.ResizeObserver = origRO;
  globalThis.Image = origImage;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  events.length = 0;
  backendKinds.length = 0;
  drawImageSources = [];
  rafQueue = [];
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

// NB: unique shader paths per test — the program cache is module-scoped, so a reused path replays a
// previous verdict.
function shaderNode(path: string): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  // A non-zero box, so syncCanvasSize makes a >0 canvas and a render is a real draw.
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

function stubRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("webgl runtime — backend frame bracketing", () => {
  it("wraps the tick's binding loop in beginFrame/endFrame", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode("res://backend-tick.gdshader").node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    expect(events).toEqual([]); // the create alone renders nothing

    flushRaf();
    expect(events).toEqual(["begin", "render", "end"]);
    // A TIME shader re-arms the loop: the next tick is bracketed on its own, never left open
    // across frames.
    flushRaf();
    expect(events).toEqual([
      "begin",
      "render",
      "end",
      "begin",
      "render",
      "end",
    ]);
    // One backend for the runtime, and it is the WebGL one (the only one that exists today).
    expect(backendKinds).toEqual(["webgl"]);
    rt.dispose();
  });

  it("brackets the out-of-loop anti-flicker render too (renderBindingNow)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://backend-sync.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();
    events.length = 0;

    // A uv-window change re-sizes (and so CLEARS) the canvas, which the runtime repaints
    // synchronously rather than waiting for the next tick.
    self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,0.5");
    rt.reconcile();

    expect(events).toEqual(["begin", "render", "end"]);
    expect(rt.stats().syncRenders).toBe(1);
    rt.dispose();
  });

  it("does not stamp a backend attribute on the node canvas (GL is drawImage-able)", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://backend-attr.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
    } as never);
    rt.reconcile();
    await settle();

    const canvas = self.querySelector("[data-godot-shader-canvas]");
    expect(canvas).toBeTruthy();
    // Only a WebGPU backend stamps this; a GL canvas stays a legal capture source.
    expect(canvas?.getAttribute("data-godot-effects-backend")).toBeNull();
    rt.dispose();
  });
});

describe("webgl runtime — SCREEN_TEXTURE capture skips WebGPU canvases", () => {
  // Build: an earlier self-layer carrying BOTH a canvas child and a texture url (the two sources
  // `drawableSource` chooses between), then an overlapping SCREEN_TEXTURE shader node.
  function mountCapture(
    shaderPath: string,
    textureUrl: string,
    stampWebgpu: boolean,
  ): { root: HTMLElement; canvas: HTMLCanvasElement } {
    const root = document.createElement("div");
    stubRect(root, { left: 0, top: 0, width: 200, height: 100 });

    const earlier = document.createElement("div");
    earlier.className = SELF_LAYER_CLASS;
    earlier.setAttribute("data-godot-shader-texture-url", textureUrl);
    stubRect(earlier, { left: 0, top: 0, width: 200, height: 100 });
    const canvas = document.createElement("canvas");
    if (stampWebgpu)
      canvas.setAttribute("data-godot-effects-backend", "webgpu");
    earlier.appendChild(canvas);
    root.appendChild(earlier);

    const { node, self } = shaderNode(shaderPath);
    stubRect(self, { left: 0, top: 0, width: 100, height: 50 });
    root.appendChild(node);
    document.body.appendChild(root);
    return { root, canvas };
  }

  const capturedImageSources = (url: string): unknown[] =>
    drawImageSources.filter(
      (source) => (source as { src?: string })?.src === url,
    );

  it("uses an ordinary canvas child as the capture source", async () => {
    const url = "https://example.test/backend-capture-gl.png";
    const { root, canvas } = mountCapture(
      "res://backend-capture-gl.gdshader",
      url,
      false,
    );

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      enableScreenTextureCapture: true,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    expect(drawImageSources).toContain(canvas); // the layer's own pixels win
    expect(capturedImageSources(url)).toHaveLength(0); // …so the texture image is not consulted
    rt.dispose();
  });

  it('skips a canvas stamped data-godot-effects-backend="webgpu" and falls back to the texture image', async () => {
    const url = "https://example.test/backend-capture-webgpu.png";
    const { root, canvas } = mountCapture(
      "res://backend-capture-webgpu.gdshader",
      url,
      true,
    );

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      enableScreenTextureCapture: true,
    } as never);
    rt.reconcile();
    await settle();
    flushRaf();

    // NEVER drawImage a WebGPU canvas: blank on SwiftShader, pathological on Android Chrome.
    expect(drawImageSources).not.toContain(canvas);
    // …and the composite is not left empty: the next-best source, the layer's texture image, is
    // what lands on the capture canvas.
    expect(capturedImageSources(url)).toHaveLength(1);
    rt.dispose();
  });
});
