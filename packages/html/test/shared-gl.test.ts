import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetGpuInfoForTest,
  __resetSharedForTest,
  describeGpu,
  devicePixelRatio,
  downscaleForUpload,
  effectivePixelRatio,
  getImageTexture,
  getShared,
} from "../src/webgl/shared-gl";

afterEach(() => {
  __resetGpuInfoForTest();
  __resetSharedForTest();
  vi.restoreAllMocks();
});

describe("downscaleForUpload", () => {
  const img = (w: number, h: number) =>
    ({ naturalWidth: w, naturalHeight: h }) as unknown as HTMLImageElement;

  it("returns the image unchanged when no cap is set", () => {
    const r = downscaleForUpload(img(8192, 4096), undefined);
    expect(r.width).toBe(8192);
    expect(r.height).toBe(4096);
  });

  it("returns the image unchanged when it already fits the cap", () => {
    const r = downscaleForUpload(img(1024, 512), 2048);
    expect(r.width).toBe(1024);
    expect(r.height).toBe(512);
  });

  it("downscales an oversized image to the cap on its longest edge, preserving aspect", () => {
    // Stub the 2D context jsdom lacks so the canvas-resize path runs.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    const r = downscaleForUpload(img(8192, 4096), 2048);
    expect(r.width).toBe(2048); // 8192 → 2048 (longest edge)
    expect(r.height).toBe(1024); // aspect preserved (4096 → 1024)
    expect(r.source).toBeInstanceOf(HTMLCanvasElement);
  });
});

describe("effectivePixelRatio", () => {
  it("returns devicePixelRatio when no scale is given", () => {
    expect(effectivePixelRatio()).toBe(devicePixelRatio());
  });

  it("scales devicePixelRatio by a fractional renderScale", () => {
    expect(effectivePixelRatio(0.5)).toBeCloseTo(devicePixelRatio() * 0.5);
  });

  it("clamps renderScale to (0, 1] (never upscales, never <= 0)", () => {
    expect(effectivePixelRatio(2)).toBe(devicePixelRatio());
    expect(effectivePixelRatio(0)).toBe(devicePixelRatio());
    expect(effectivePixelRatio(-1)).toBe(devicePixelRatio());
    expect(effectivePixelRatio(Number.NaN)).toBe(devicePixelRatio());
  });
});

// A minimal WebGL-context stub exposing only what describeGpu reads (the debug-renderer extension).
function stubGl(renderer: string | null): void {
  const ext = renderer === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
  const gl = {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" ? ext : null,
    getParameter: () => renderer,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    kind: string,
  ) => (kind === "webgl2" || kind === "webgl" ? gl : null)) as never);
}

describe("loadUploadedTexture orientation (via getImageTexture)", () => {
  // Image uploads must be TOP-LEFT origin (no UNPACK_FLIP_Y_WEBGL): the transpiled shader
  // prelude samples with Godot-convention UVs (UV.y=0 = top), and `getBakedTexture` already
  // uploads un-flipped. A FLIP_Y upload double-flips against `1.0 - v_uv.y` in transpile.ts
  // — the "map/relic icons render upside-down" regression.
  it("uploads the loaded image with FLIP_Y=false and premultiply=false", async () => {
    const state = new Map<number, unknown>();
    const uploads: Array<Map<number, unknown>> = [];
    const FLIP = 0x9240; // gl.UNPACK_FLIP_Y_WEBGL
    const PREMULT = 0x9241; // gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL
    const gl = {
      UNPACK_FLIP_Y_WEBGL: FLIP,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: PREMULT,
      createTexture: () => ({}),
      bindTexture: () => {},
      texParameteri: () => {},
      pixelStorei: (name: number, value: unknown) => {
        state.set(name, value);
      },
      texImage2D: () => {
        uploads.push(new Map(state));
      },
    } as unknown as WebGL2RenderingContext;

    // jsdom images never load; a stub that "loads" synchronously when `src` is set
    // (loadUploadedTexture assigns `onload` before `src`).
    const OrigImage = globalThis.Image;
    class InstantImage {
      onload: (() => void) | null = null;
      crossOrigin = "";
      naturalWidth = 4;
      naturalHeight = 2;
      set src(_value: string) {
        this.onload?.();
      }
    }
    globalThis.Image = InstantImage as unknown as typeof Image;
    try {
      const entry = getImageTexture(gl, "/test-orientation.png", {
        repeat: false,
      });
      expect(entry.loaded).toBe(true);
      // uploads[0] is the 1x1 placeholder; uploads[1] is the loaded image.
      expect(uploads.length).toBe(2);
      expect(uploads[1].get(FLIP) ?? false).toBe(false);
      expect(uploads[1].get(PREMULT) ?? false).toBe(false);
    } finally {
      globalThis.Image = OrigImage;
    }
  });
});

/**
 * THE SHARED CANVAS'S ALPHA CONTRACT, pinned.
 *
 * `getContext("webgl2", …)` takes an attribute dictionary that no browser and no type-checker will
 * ever complain about, and exactly one entry in it decides how everything drawn on this canvas
 * reaches a consumer: `premultipliedAlpha`. It says whether the bytes in the drawing buffer are
 * `(c·a, a)` or `(c, a)` — and the browser BELIEVES it, converting on every `drawImage` out of the
 * canvas and on every page composite. Declare straight and write premultiplied and the content is
 * multiplied by alpha a second time; declare premultiplied and write straight and it halos. Neither
 * raises an error, and no readback of the drawing buffer can tell the two apart, because the
 * declaration is not IN the buffer.
 *
 * That makes this the WebGL twin of `webgpu/device.ts`'s `alphaMode: "premultiplied"` (asserted in
 * `webgpu-device.test.ts`), and it is asserted the same way: as the ONE line that must agree with
 * every fragment shader that writes here — `webgl/transpile.ts`'s emitted `fragColor`,
 * core's `particles/render-webgl.ts` `FRAGMENT_SRC` and its additive resolve. Change this and all of
 * them change with it, or the page silently shows the wrong picture.
 */
describe("the shared WebGL2 context's declared attributes", () => {
  /** Everything `getShared` touches on a healthy context, and nothing more. */
  function stubSharedContext(): {
    attributes: () => WebGLContextAttributes | undefined;
  } {
    let seen: WebGLContextAttributes | undefined;
    const gl = {
      getExtension: () => null,
      getParameter: () => "NVIDIA GeForce RTX 4080",
      createBuffer: () => ({}),
      bindBuffer: () => {},
      bufferData: () => {},
      ARRAY_BUFFER: 0x8892,
      STATIC_DRAW: 0x88e4,
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
      kind: string,
      attrs?: WebGLContextAttributes,
    ) => {
      if (kind !== "webgl2") return null;
      seen = attrs;
      return gl;
    }) as never);
    return { attributes: () => seen };
  }

  it("asks for a PREMULTIPLIED-alpha drawing buffer", () => {
    const stub = stubSharedContext();
    expect(getShared()).not.toBeNull();
    // The pairing this pins, stated in full so a future reader does not have to reconstruct it:
    // `premultipliedAlpha: true` + fragments that emit `(rgb·a, a)` + `blendFuncSeparate(ONE,
    // ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`. Flipping this alone re-introduces the
    // MIX double-multiply (`webglCompositeXvfb.test.ts` is where that shows up on a real page).
    expect(stub.attributes()?.premultipliedAlpha).toBe(true);
  });

  it("asks for an alpha channel, no MSAA and no preserved buffer", () => {
    const stub = stubSharedContext();
    expect(getShared()).not.toBeNull();
    const attrs = stub.attributes();
    // `alpha: false` would make the canvas opaque black and every effect a rectangle.
    expect(attrs?.alpha).toBe(true);
    // The buffer is redrawn from scratch before every blit, so neither of these buys anything —
    // and `preserveDrawingBuffer` in particular costs a full-buffer copy per frame.
    expect(attrs?.antialias).toBe(false);
    expect(attrs?.preserveDrawingBuffer).toBe(false);
  });
});

describe("describeGpu", () => {
  it("flags a software renderer (SwiftShader) and exposes its string", () => {
    stubGl("Google SwiftShader");
    const info = describeGpu();
    expect(info.software).toBe(true);
    expect(info.unavailable).toBe(false);
    expect(info.renderer).toContain("SwiftShader");
  });

  it("treats a hardware GPU as non-software", () => {
    stubGl("NVIDIA GeForce RTX 4080");
    const info = describeGpu();
    expect(info.software).toBe(false);
    expect(info.unavailable).toBe(false);
  });

  it("never classifies an unknown/masked renderer ('') as software", () => {
    stubGl(""); // extension present but parameter masked → empty string
    const info = describeGpu();
    expect(info.renderer).toBe("");
    expect(info.software).toBe(false);
    expect(info.unavailable).toBe(false);
  });

  it("reports unavailable when no WebGL context exists", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      null as never,
    );
    const info = describeGpu();
    expect(info.unavailable).toBe(true);
    expect(info.software).toBe(false);
  });

  it("latches the first probe result", () => {
    stubGl("Intel(R) UHD Graphics 620");
    const first = describeGpu();
    stubGl("NVIDIA GeForce RTX 4080"); // ignored — already latched
    expect(describeGpu()).toBe(first);
  });
});
