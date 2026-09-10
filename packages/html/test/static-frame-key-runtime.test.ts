// jsdom (gsw default env).
//
// Runtime-level writer audit for the frozen shader-frame key. `static-frame-key.test.ts` proves
// the pure key's vocabulary; this suite proves the DOM -> updateBinding -> epoch path cannot retain
// a stale memo when a kept binding changes underneath it.
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
import type { GodotEffectRenderInfo } from "../src/types";
import {
  __resetStaticShaderFrameCacheForTest,
  createWebglShaderRuntime,
} from "../src/webgl/runtime";
import { __resetSharedForTest } from "../src/webgl/shared-gl";

const SHADER = `shader_type canvas_item;
uniform sampler2D noise : repeat_enable;
uniform float amount;
void fragment() { COLOR = texture(TEXTURE, UV) * texture(noise, UV) * amount * TIME; }`;

let draws = 0;
const canvasCalls = new Map<
  HTMLCanvasElement,
  { clears: number; blits: number }
>();

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
      draws += 1;
    },
  };
  return new Proxy(overrides, {
    get: (target, key: string) =>
      key in target ? target[key] : () => undefined,
  });
}

let rafQueue: FrameRequestCallback[] = [];
function flushRaf(): void {
  const queued = rafQueue;
  rafQueue = [];
  for (const callback of queued) callback(0);
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

class ControlledImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  naturalWidth = 64;
  naturalHeight = 64;
  private value = "";

  set src(value: string) {
    this.value = value;
    pendingImages.push(this);
  }

  get src(): string {
    return this.value;
  }
}

let pendingImages: ControlledImage[] = [];
const deliveredImages = new Set<ControlledImage>();
function settleTextureLoads(): void {
  for (const image of pendingImages) {
    if (deliveredImages.has(image)) continue;
    deliveredImages.add(image);
    image.onload?.();
  }
}

let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCaf: typeof globalThis.cancelAnimationFrame;
let originalImage: typeof globalThis.Image;
let resizeCallbacks: ResizeObserverCallback[] = [];

beforeAll(() => {
  (globalThis as Record<string, unknown>).__gswForceWebglShaders = true;
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === "webgl2") return fakeGl();
    if (kind === "2d") {
      const calls = { clears: 0, blits: 0 };
      canvasCalls.set(this, calls);
      return new Proxy(
        {},
        {
          get: (_target, key: string) => {
            if (key === "clearRect") return () => calls.clears++;
            if (key === "drawImage") return () => calls.blits++;
            return () => undefined;
          },
        },
      );
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;
  originalRaf = globalThis.requestAnimationFrame;
  originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    rafQueue.push(callback)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame =
    (() => {}) as typeof globalThis.cancelAnimationFrame;
  originalImage = globalThis.Image;
  globalThis.Image = ControlledImage as unknown as typeof globalThis.Image;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  globalThis.Image = originalImage;
  delete (globalThis as Record<string, unknown>).__gswForceWebglShaders;
  __resetSharedForTest();
});

beforeEach(() => {
  __resetSharedForTest();
  __resetStaticShaderFrameCacheForTest();
  draws = 0;
  canvasCalls.clear();
  rafQueue = [];
  pendingImages = [];
  deliveredImages.clear();
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof globalThis.ResizeObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function shaderNode(): {
  node: HTMLElement;
  self: HTMLElement;
  setBox(width: number, height: number): void;
} {
  let width = 100;
  let height = 50;
  const node = document.createElement("div");
  node.setAttribute("data-godot-shader-webgl", "1");
  node.setAttribute("data-godot-shader-path", "res://writer-audit.gdshader");
  node.setAttribute("data-godot-shader-params", '{"amount":0.1}');
  node.setAttribute("data-godot-shader-param-kinds", '{"amount":"float"}');
  node.setAttribute("data-godot-shader-modulate", "1,1,1,1");
  node.setAttribute(
    "data-godot-shader-sampler-urls",
    '{"noise":"res://noise-a.png"}',
  );
  node.setAttribute("data-godot-texture-repeat", "1");
  const self = document.createElement("div");
  self.className = SELF_LAYER_CLASS;
  self.setAttribute("data-godot-shader-texture-url", "res://page-a.png");
  self.setAttribute("data-godot-atlas-region", "0,0,16,16");
  Object.defineProperty(self, "clientWidth", {
    get: () => width,
    configurable: true,
  });
  Object.defineProperty(self, "clientHeight", {
    get: () => height,
    configurable: true,
  });
  node.appendChild(self);
  return {
    node,
    self,
    setBox(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
    },
  };
}

describe("frozen shader key runtime writer audit", () => {
  it("recomputes after every DOM writer, load settlement, and actual backing-size path", async () => {
    const root = document.createElement("div");
    const { node, self, setBox } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    const events: GodotEffectRenderInfo[] = [];
    const runtime = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered: (_node, _canvas, info) => events.push(info),
    } as never);

    runtime.reconcile();
    await settle();
    // Node TEXTURE and sampler URL loads are deliberately held until the binding has installed its
    // listeners. This is the real onTextureLoaded settlement writer, not a direct binding mutation.
    settleTextureLoads();
    flushRaf();
    expect(events.at(-1)?.staticKey).not.toBeNull();

    const renderMutation = (mutate: () => void): string => {
      const previous = events.at(-1)?.staticKey;
      const drawsBefore = runtime.stats().draws;
      mutate();
      runtime.reconcile();
      settleTextureLoads();
      flushRaf();
      const next = events.at(-1)?.staticKey;
      expect(next).not.toBeNull();
      expect(next).not.toBe(previous);
      expect(runtime.stats().draws).toBeGreaterThan(drawsBefore);
      return next as string;
    };

    renderMutation(() =>
      node.setAttribute("data-godot-shader-params", '{"amount":0.2}'),
    );
    renderMutation(() =>
      node.setAttribute("data-godot-shader-param-kinds", '{"amount":"int"}'),
    );
    renderMutation(() =>
      node.setAttribute("data-godot-shader-modulate", "0.8,1,1,1"),
    );
    renderMutation(() => {
      self.style.backgroundSize = "contain";
    });
    renderMutation(() =>
      self.setAttribute("data-godot-shader-uv-window", "0,0,0.5,1"),
    );
    renderMutation(() =>
      self.setAttribute("data-godot-shader-texture-url", "res://page-b.png"),
    );
    // Same dimensions, different crop: this must not reuse the old atlas frame.
    renderMutation(() =>
      self.setAttribute("data-godot-atlas-region", "1,0,16,16"),
    );
    renderMutation(() => node.setAttribute("data-godot-texture-repeat", "2"));
    renderMutation(() =>
      node.setAttribute(
        "data-godot-shader-sampler-urls",
        '{"noise":"res://noise-b.png"}',
      ),
    );
    renderMutation(() => {
      node.removeAttribute("data-godot-shader-sampler-urls");
      node.setAttribute(
        "data-godot-shader-samplers",
        '{"noise":{"kind":"gradient","width":16,"stops":[]}}',
      );
    });

    // Runtime scale and static-ratio setters resize via `syncCanvasSize`; a ResizeObserver delivery
    // exercises the other real size writer rather than assigning dimensions in a test binding.
    renderMutation(() => runtime.setRenderScale(0.5));
    renderMutation(() => runtime.setStaticShaderPixelRatio(2));
    renderMutation(() => {
      setBox(140, 50);
      for (const callback of resizeCallbacks) {
        callback(
          [
            {
              target: self,
              contentRect: { width: 140, height: 50 },
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    });
    runtime.dispose();
  });

  it("keeps a quantized-equivalent update as a same-canvas cache hit with its callback", async () => {
    const root = document.createElement("div");
    const { node, self } = shaderNode();
    root.appendChild(node);
    document.body.appendChild(root);
    const events: GodotEffectRenderInfo[] = [];
    const runtime = createWebglShaderRuntime(root, {
      resolveShaderSource: async () => SHADER,
      staticShaders: true,
      onBindingRendered: (_node, _canvas, info) => events.push(info),
    } as never);
    runtime.reconcile();
    await settle();
    settleTextureLoads();
    flushRaf();
    const canvas = self.querySelector<HTMLCanvasElement>("canvas");
    expect(canvas).not.toBeNull();
    const calls = canvasCalls.get(canvas as HTMLCanvasElement);
    expect(calls).toBeDefined();
    const key = events.at(-1)?.staticKey;
    const before = {
      ...runtime.stats(),
      calls: { ...calls! },
      events: events.length,
      draws,
    };

    // `paramsFrameKey` quantizes to 0.01. updateBinding still advances the memo epoch, so this
    // catches an implementation that mistakes invalidation for mandatory pixel writes.
    node.setAttribute("data-godot-shader-params", '{"amount":0.1001}');
    runtime.reconcile();
    flushRaf();

    expect(events.at(-1)?.staticKey).toBe(key);
    expect(events).toHaveLength(before.events + 1); // handled cache hit still notifies the host
    expect(runtime.stats().cacheHits).toBe(before.cacheHits + 1);
    expect(runtime.stats().blitSkips).toBe(before.blitSkips + 1);
    expect(draws).toBe(before.draws);
    expect(canvasCalls.get(canvas as HTMLCanvasElement)).toEqual(before.calls);
    runtime.dispose();
  });
});
