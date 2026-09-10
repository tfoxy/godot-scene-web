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
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

const SHADER =
  "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(TIME); }";

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
    get: (target, key: string) =>
      key in target ? target[key] : () => undefined,
  });
}

let frames: FrameRequestCallback[] = [];
let originalContext: typeof HTMLCanvasElement.prototype.getContext;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCaf: typeof globalThis.cancelAnimationFrame;
let originalResizeObserver: typeof globalThis.ResizeObserver;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  originalContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") return new Proxy({}, { get: () => () => undefined });
    return null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    frames.push(callback)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  originalResizeObserver = globalThis.ResizeObserver;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalContext;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  globalThis.ResizeObserver = originalResizeObserver;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  frames = [];
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  globalThis.ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function flushFrames(): void {
  const queued = frames;
  frames = [];
  for (const callback of queued) callback(0);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function selfLayer(): HTMLElement {
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  Object.defineProperty(self, "clientWidth", {
    configurable: true,
    get: () => 100,
  });
  Object.defineProperty(self, "clientHeight", {
    configurable: true,
    get: () => 50,
  });
  return self;
}

describe("effect runtime construction options", () => {
  it("matches shader setters for the frame they configure", async () => {
    const run = async (setters: boolean): Promise<number> => {
      const root = document.createElement("div");
      const node = document.createElement("div");
      node.setAttribute("data-godot-shader-webgl", "1");
      node.setAttribute("data-godot-shader-path", "res://test.gdshader");
      node.setAttribute("data-godot-shader-params", "{}");
      node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
      node.appendChild(selfLayer());
      root.appendChild(node);
      document.body.appendChild(root);
      const runtime = createWebglShaderRuntime(root, {
        resolveShaderSource: async () => SHADER,
        ...(setters
          ? {}
          : { renderScale: 0.5, shaderFps: 30, staticShaders: true }),
      } as never);
      runtime.reconcile();
      await settle();
      flushFrames();
      const beforeSetters = runtime.stats().draws;
      if (setters) {
        runtime.setRenderScale(0.5);
        runtime.setFps(30);
        runtime.setStaticShaders(true);
      }
      flushFrames();
      const draws = runtime.stats().draws - beforeSetters;
      runtime.dispose();
      return draws;
    };

    expect(await run(false)).toBe(await run(true));
  });

  it("matches particle setters applied before the first reconcile", () => {
    const run = (setters: boolean): number => {
      const root = document.createElement("div");
      const node = document.createElement("div");
      node.setAttribute("data-godot-particle-runtime", "1");
      node.setAttribute(
        "data-godot-particle-specs",
        JSON.stringify({
          kind: "GPUParticles2D",
          amount: 1,
          lifetime: 1,
          emitting: true,
        }),
      );
      node.appendChild(selfLayer());
      root.appendChild(node);
      document.body.appendChild(root);
      const runtime = createParticleRuntime(root, {
        enableParticles: true,
        ...(setters
          ? {}
          : { particleFps: 30, renderScale: 0.5, staticParticles: true }),
      } as never);
      if (setters) {
        runtime.setRenderScale(0.5);
        runtime.setFps(30);
        runtime.setStaticParticles(true);
      }
      runtime.reconcile();
      flushFrames();
      const draws = runtime.stats().draws;
      runtime.dispose();
      return draws;
    };

    expect(run(false)).toBe(run(true));
  });
});
