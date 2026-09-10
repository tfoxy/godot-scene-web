import { describe, expect, it, vi } from "vitest";
import {
  createCanvasStage,
  STAGE_CONTEXT_ATTRIBUTES,
  type StageCanvas,
} from "../src/present";
import { createFakeGl } from "./fake-gl";

interface StubCanvas extends StageCanvas {
  listeners: Map<string, ((event: Event) => void)[]>;
  requested: WebGLContextAttributes | undefined;
  /** Assignments to `width`/`height`, in order — including no-op ones, which are
   *  what the grow-only-vs-exact question is about. */
  sizeWrites: [string, number][];
  /** What the drawing buffer comes back as; may be smaller than requested. */
  bufferCap: number;
  fire(type: string): Event;
}

function stubCanvas(options: { gl?: WebGL2RenderingContext | null } = {}) {
  const gl = options.gl === undefined ? createFakeGl().gl : options.gl;
  const state = {
    width: 300,
    height: 150,
    bufferCap: Number.POSITIVE_INFINITY,
  };
  const sizeWrites: [string, number][] = [];
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const canvas: StubCanvas = {
    get width() {
      return state.width;
    },
    set width(value: number) {
      sizeWrites.push(["width", value]);
      state.width = value;
    },
    get height() {
      return state.height;
    },
    set height(value: number) {
      sizeWrites.push(["height", value]);
      state.height = value;
    },
    getContext(_id, attributes) {
      canvas.requested = attributes;
      return gl;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
    listeners,
    requested: undefined,
    sizeWrites,
    get bufferCap() {
      return state.bufferCap;
    },
    set bufferCap(value: number) {
      state.bufferCap = value;
    },
    fire(type: string) {
      const event = { type, preventDefault: vi.fn() } as unknown as Event;
      for (const listener of listeners.get(type) ?? []) listener(event);
      return event;
    },
  };
  if (gl) {
    Object.defineProperty(gl, "drawingBufferWidth", {
      get: () => Math.min(state.width, state.bufferCap),
      configurable: true,
    });
    Object.defineProperty(gl, "drawingBufferHeight", {
      get: () => Math.min(state.height, state.bufferCap),
      configurable: true,
    });
  }
  return canvas;
}

describe("createCanvasStage", () => {
  it("returns null when the browser gives no WebGL2 context", () => {
    expect(
      createCanvasStage({
        canvas: stubCanvas({ gl: null }),
        designWidth: 1920,
        designHeight: 1080,
      }),
    ).toBeNull();
  });

  it("asks for the alpha contract the whole package is built on", () => {
    const canvas = stubCanvas();
    createCanvasStage({ canvas, designWidth: 1920, designHeight: 1080 });
    expect(canvas.requested).toEqual(STAGE_CONTEXT_ATTRIBUTES);
    expect(canvas.requested).toMatchObject({
      alpha: true,
      premultipliedAlpha: true,
      stencil: false,
      antialias: false,
    });
    // `desynchronized` is deliberately absent, not false-by-omission-by-accident.
    expect("desynchronized" in (canvas.requested ?? {})).toBe(false);
  });

  it("can opt into an opaque context without mutating the transparent default", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
      alpha: false,
    });

    expect(canvas.requested).toEqual({
      ...STAGE_CONTEXT_ATTRIBUTES,
      alpha: false,
    });
    expect(canvas.requested).not.toBe(STAGE_CONTEXT_ATTRIBUTES);
    expect(STAGE_CONTEXT_ATTRIBUTES.alpha).toBe(true);
    // The fake context has no browser query API, so the stage accurately falls
    // back to the successful request rather than inventing a transparent mode.
    expect(stage?.alpha).toBe(false);
  });

  it("reports the browser's achieved alpha mode rather than assuming the request", () => {
    const gl = createFakeGl().gl;
    Object.defineProperty(gl, "getContextAttributes", {
      configurable: true,
      value: () => ({ alpha: true }),
    });
    const stage = createCanvasStage({
      canvas: stubCanvas({ gl }),
      designWidth: 1920,
      designHeight: 1080,
      alpha: false,
    });

    expect(stage?.alpha).toBe(true);
  });
});

describe("stage sizing", () => {
  it("sets the backing store EXACTLY, shrinking as well as growing", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
    });
    stage?.setStageSize(800, 600);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect([stage?.stageWidth, stage?.stageHeight]).toEqual([800, 600]);
    // The grow-only policy the shared offscreen canvas uses would leave 800x600
    // here; a stage that did that would present a buffer bigger than the surface.
    stage?.setStageSize(400, 300);
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
    expect([stage?.stageWidth, stage?.stageHeight]).toEqual([400, 300]);
  });

  it("does not touch the attribute when the size is unchanged", () => {
    // Assigning `canvas.width` reallocates AND CLEARS the drawing buffer even for
    // the same value, so a resize handler firing on every scroll would blank the
    // stage between frames.
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
    });
    stage?.setStageSize(800, 600);
    canvas.sizeWrites.length = 0;
    stage?.setStageSize(800, 600);
    expect(canvas.sizeWrites).toEqual([]);
  });

  it("believes the DRAWING BUFFER, not the attribute, when they disagree", () => {
    const canvas = stubCanvas();
    canvas.bufferCap = 512;
    const stage = createCanvasStage({
      canvas,
      designWidth: 1024,
      designHeight: 1024,
    });
    stage?.setStageSize(2048, 2048);
    // The attribute took the request; the buffer came back capped, and every rect
    // the stage produces has to be measured against what exists.
    expect(canvas.width).toBe(2048);
    expect(stage?.stageWidth).toBe(512);
    expect(stage?.projection().framebufferWidth).toBe(512);
  });
});

describe("stage projection", () => {
  it("maps design space onto clip space with Y flipped", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
    });
    stage?.setStageSize(1920, 1080);
    const projection = stage?.projection();
    const [sx, sy, tx, ty] = [...(projection?.toClip ?? [])];
    const clip = (x: number, y: number) => [x * sx + tx, y * sy + ty];
    // Design top-left -> clip top-left; design bottom-right -> clip bottom-right.
    // `toClip` is f32 storage, so the corners land within a float's worth of the
    // exact values rather than on them.
    const closeTo = ([x, y]: number[], [ex, ey]: number[]) => {
      expect(x).toBeCloseTo(ex, 5);
      expect(y).toBeCloseTo(ey, 5);
    };
    closeTo(clip(0, 0), [-1, 1]);
    closeTo(clip(1920, 1080), [1, -1]);
    closeTo(clip(960, 540), [0, 0]);
  });

  it("maps design space onto framebuffer pixels at the presented scale", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
    });
    stage?.setStageSize(960, 540);
    const toFramebuffer = stage?.projection().toFramebuffer;
    expect([...(toFramebuffer ?? [])]).toEqual([0.5, 0, 0, 0.5, 0, 0]);
  });

  it("re-derives the projection when the design extent changes", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
    });
    stage?.setStageSize(1920, 1080);
    stage?.setDesignSize(960, 540);
    expect(stage?.projection().toFramebuffer[0]).toBe(2);
    expect(stage?.projection().toClip[0]).toBeCloseTo(2 / 960, 8);
  });
});

describe("context loss", () => {
  it("preventDefaults the loss, or the browser never offers a restore", () => {
    const canvas = stubCanvas();
    const onContextLost = vi.fn();
    const onContextRestored = vi.fn();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
      onContextLost,
      onContextRestored,
    });
    const event = canvas.fire("webglcontextlost");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(stage?.contextLost).toBe(true);

    canvas.fire("webglcontextrestored");
    expect(onContextRestored).toHaveBeenCalledTimes(1);
    expect(stage?.contextLost).toBe(false);
  });

  it("re-measures the drawing buffer on restore", () => {
    const canvas = stubCanvas();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1024,
      designHeight: 1024,
    });
    stage?.setStageSize(1024, 1024);
    expect(stage?.stageWidth).toBe(1024);
    // The buffer is reallocated by the restore and may come back different.
    canvas.fire("webglcontextlost");
    canvas.bufferCap = 256;
    canvas.fire("webglcontextrestored");
    expect(stage?.stageWidth).toBe(256);
    expect(stage?.projection().toFramebuffer[0]).toBe(0.25);
  });

  it("stops listening after dispose", () => {
    const canvas = stubCanvas();
    const onContextLost = vi.fn();
    const stage = createCanvasStage({
      canvas,
      designWidth: 1920,
      designHeight: 1080,
      onContextLost,
    });
    stage?.dispose();
    canvas.fire("webglcontextlost");
    expect(onContextLost).not.toHaveBeenCalled();
  });
});
