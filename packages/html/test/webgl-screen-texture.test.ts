// jsdom (gsw default env).
//
// SCREEN_TEXTURE support is OPT-IN (`enableScreenTextureCapture`): with the option off, a
// screen-reading shader takes the exact unsupported/CSS-fallback path it took before support
// existed (no binding, no canvas); with it on, the program compiles and renders, feeding the
// shader a throttled offscreen composite of the content drawn before the node (never re-captured
// per rAF). These tests stub a fake WebGL2/2D context and a CONTROLLABLE rAF queue (flushed by
// hand), counting `drawArrays` (renders) and 6-arg `texImage2D` calls (canvas → capture uploads;
// the placeholder/solid uploads use the 9-arg pixel form) to observe the render + throttle.
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

import type { UnsupportedRenderInfo } from "../src/diagnostics";
import { SELF_LAYER_CLASS } from "../src/render-structure";
import { createWebglShaderRuntime } from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

// The motivating shape: distort the already-drawn background by sampling SCREEN_TEXTURE
// at a TIME-animated offset (TIME keeps the loop alive so the throttle is observable).
const SCREEN_SHADER = `
shader_type canvas_item;
uniform sampler2D SCREEN_TEXTURE : hint_screen_texture, filter_nearest;
void fragment() { COLOR = texture(SCREEN_TEXTURE, SCREEN_UV + vec2(TIME * 0.001, 0.0)); }
`;

let drawCount = 0;
let canvasUploadCount = 0;

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
    drawArrays: () => {
      drawCount += 1;
      return undefined;
    },
    texImage2D: (...args: unknown[]) => {
      // 6-arg form = a TexImageSource upload (the screen-capture canvas); the 1x1
      // placeholder/solid uploads use the 9-arg pixel form.
      if (args.length === 6) canvasUploadCount += 1;
      return undefined;
    },
  };
  return new Proxy(overrides, {
    get: (t, k: string) => (k in t ? t[k] : () => undefined),
  });
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

beforeEach(() => {
  __resetSharedForTest();
  drawCount = 0;
  canvasUploadCount = 0;
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

// NB: unique shader paths per test — the program cache (and the unsupported-report dedupe)
// are module-scoped, so a path reused across tests would replay a previous verdict.
function shaderNode(path: string): { node: HTMLElement; self: HTMLElement } {
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", path);
  node.setAttribute("data-godot-shader-params", "{}");
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  // Give the self-layer a non-zero size so syncCanvasSize makes a >0 canvas.
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

const canvasIn = (self: HTMLElement): Element | null =>
  self.querySelector("[data-godot-shader-canvas]");

describe("webgl runtime — SCREEN_TEXTURE opt-in gating", () => {
  it("falls back (no binding, unsupported report) when the option is OFF — today's behavior", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://screen-off.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);
    const onUnsupported = vi.fn((_info: UnsupportedRenderInfo) => {});

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      onUnsupported,
    } as never);
    rt.reconcile();
    await settle();

    expect(canvasIn(self)).toBeNull(); // no canvas — the node keeps its CSS/SVG paint
    expect(onUnsupported).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "shader",
        id: "res://screen-off.gdshader",
        reason: "screen-texture capture not enabled",
      }),
    );
    flushRaf();
    expect(drawCount).toBe(0);
    rt.dispose();
  });

  it("creates the binding and renders without throwing when the option is ON", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode("res://screen-on.gdshader");
    root.appendChild(node);
    document.body.appendChild(root);
    const onUnsupported = vi.fn((_info: UnsupportedRenderInfo) => {});

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      enableScreenTextureCapture: true,
      onUnsupported,
    } as never);
    rt.reconcile();
    await settle();

    expect(canvasIn(self)).toBeTruthy(); // binding created
    expect(onUnsupported).not.toHaveBeenCalled();
    expect(() => flushRaf()).not.toThrow();
    expect(drawCount).toBe(1); // rendered
    expect(canvasUploadCount).toBe(1); // …and the capture composite was uploaded once
    rt.dispose();
  });

  it("throttles the capture: back-to-back frames re-render but do NOT re-capture", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode("res://screen-throttle.gdshader").node);
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      enableScreenTextureCapture: true,
    } as never);
    rt.reconcile();
    await settle();

    flushRaf();
    expect(drawCount).toBe(1);
    expect(canvasUploadCount).toBe(1);
    // A TIME shader re-arms the loop; the next frame (well inside the ~300ms window)
    // re-renders the distortion but reuses the previous screen composite.
    expect(rafQueue.length).toBe(1);
    flushRaf();
    expect(drawCount).toBe(2);
    expect(canvasUploadCount).toBe(1); // ← throttled: no second capture upload
    rt.dispose();
  });

  it("is excluded from the static-frame cache (output depends on the content behind)", async () => {
    const root = document.createElement("div");
    root.appendChild(shaderNode("res://screen-static.gdshader").node);
    root.appendChild(shaderNode("res://screen-static.gdshader").node); // identical twin
    document.body.appendChild(root);

    const rt = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SCREEN_SHADER,
      enableScreenTextureCapture: true,
      staticShaders: true,
    } as never);
    rt.reconcile();
    await settle();

    flushRaf();
    // Unlike a cacheable shader (one draw + a blit), each node draws its own frame.
    expect(drawCount).toBe(2);
    rt.dispose();
  });
});
