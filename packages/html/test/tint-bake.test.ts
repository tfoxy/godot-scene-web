// `bakeExternalTextureTints`: the post-mount pass that converts external
// `filter: url(#godot-tint-N)` texture tints into baked bitmaps so rotated
// ancestors stop resampling a filter raster (the blurry fanned combat cards).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyColorMatrixToPixels,
  bakeExternalTextureTints,
  clampExternalNinePatchSlices,
  type TintBakeImageLoader,
} from "../src/tint-bake";

describe("applyColorMatrixToPixels", () => {
  it("applies the row-major 3x3 transform per pixel, alpha untouched", () => {
    const pixels = new Uint8ClampedArray([100, 50, 200, 128]);
    // Swap R<->G and dim B to 50%.
    applyColorMatrixToPixels(pixels, [0, 1, 0, 1, 0, 0, 0, 0, 0.5]);
    expect([...pixels]).toEqual([50, 100, 100, 128]);
  });

  it("clamps to the byte range", () => {
    const pixels = new Uint8ClampedArray([200, 200, 10, 255]);
    applyColorMatrixToPixels(pixels, [2, 0, 0, 0, 1, 0, 0, 0, -1]);
    expect([...pixels]).toEqual([255, 200, 0, 255]);
  });

  it("ignores malformed matrices", () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 40]);
    applyColorMatrixToPixels(pixels, [1, 2, 3]);
    expect([...pixels]).toEqual([10, 20, 30, 40]);
  });
});

// jsdom has no 2D canvas backend; back the canvas pipeline with a tiny fake
// (drawImage copies the fake image's pixels; toDataURL fingerprints them) so the
// test exercises the real orchestration: load -> matrix -> swap -> strip filter.
interface FakeImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

function fakeLoader(images: Record<string, FakeImage>): {
  loader: TintBakeImageLoader;
  calls: string[];
} {
  const calls: string[] = [];
  const loader: TintBakeImageLoader = (url) => {
    calls.push(url);
    const image = images[url];
    return image
      ? Promise.resolve(image as unknown as CanvasImageSource & FakeImage)
      : Promise.reject(new Error(`no fixture image: ${url}`));
  };
  return { loader, calls };
}

let restoreCanvas: (() => void) | undefined;

beforeEach(() => {
  const proto = HTMLCanvasElement.prototype;
  const originalGetContext = proto.getContext;
  const originalToDataURL = proto.toDataURL;
  type CanvasWithBuffer = HTMLCanvasElement & { __pixels?: Uint8ClampedArray };
  proto.getContext = function (this: CanvasWithBuffer) {
    const canvas = this;
    return {
      drawImage(image: FakeImage) {
        canvas.__pixels = new Uint8ClampedArray(image.pixels);
      },
      getImageData() {
        return { data: canvas.__pixels ?? new Uint8ClampedArray(0) };
      },
      putImageData(imageData: { data: Uint8ClampedArray }) {
        canvas.__pixels = imageData.data;
      },
    } as unknown as RenderingContext;
  } as typeof proto.getContext;
  proto.toDataURL = function (this: CanvasWithBuffer) {
    return `data:image/png;base64,${[...(this.__pixels ?? [])].join("-")}`;
  };
  restoreCanvas = () => {
    proto.getContext = originalGetContext;
    proto.toDataURL = originalToDataURL;
  };
});

afterEach(() => {
  restoreCanvas?.();
  vi.restoreAllMocks();
});

function tintedElement(overrides?: {
  filter?: string;
  matrix?: string;
  url?: string;
}): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute("data-godot-texture-tint", "css-filter");
  element.setAttribute(
    "data-godot-tint-matrix",
    overrides?.matrix ?? "0.5 0 0 0 0.5 0 0 0 0.5",
  );
  element.setAttribute("data-godot-tint-filter-id", "godot-tint-3");
  element.style.setProperty(
    "background-image",
    `url("${overrides?.url ?? "/assets/frame.png"}")`,
  );
  element.style.setProperty(
    "filter",
    overrides?.filter ?? "url(#godot-tint-3)",
  );
  document.body.appendChild(element);
  return element;
}

describe("bakeExternalTextureTints", () => {
  it("swaps the background for the tinted bitmap and drops the filter", async () => {
    const element = tintedElement({ url: "/assets/a.png" });
    const { loader } = fakeLoader({
      "/assets/a.png": {
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray([100, 200, 50, 255]),
      },
    });
    const upgraded = await bakeExternalTextureTints(document.body, loader);
    expect(upgraded).toBe(1);
    // 0.5 * (100, 200, 50), alpha kept.
    expect(element.style.getPropertyValue("background-image")).toBe(
      'url("data:image/png;base64,50-100-25-255")',
    );
    expect(element.style.getPropertyValue("filter")).toBe("");
    expect(element.getAttribute("data-godot-texture-tint")).toBe(
      "baked-bitmap",
    );
    element.remove();
  });

  it("keeps unrelated composed filter refs", async () => {
    const element = tintedElement({
      url: "/assets/b.png",
      filter: 'url("#godot-tint-30") url("#godot-tint-3")',
    });
    const { loader } = fakeLoader({
      "/assets/b.png": {
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray([10, 10, 10, 10]),
      },
    });
    await bakeExternalTextureTints(document.body, loader);
    // Only the matching id is stripped — NOT the longer-prefixed godot-tint-30.
    expect(element.style.getPropertyValue("filter")).toBe(
      'url("#godot-tint-30")',
    );
    element.remove();
  });

  it("keeps the CSS filter when the image cannot be loaded", async () => {
    const element = tintedElement({ url: "/assets/missing.png" });
    const { loader } = fakeLoader({});
    const upgraded = await bakeExternalTextureTints(document.body, loader);
    expect(upgraded).toBe(0);
    expect(element.getAttribute("data-godot-texture-tint")).toBe("css-filter");
    // (jsdom serializes the fragment quoted.)
    expect(element.style.getPropertyValue("filter")).toBe(
      'url("#godot-tint-3")',
    );
    element.remove();
  });

  it("caches by url+matrix across passes (re-renders stay cheap)", async () => {
    const first = tintedElement({ url: "/assets/c.png" });
    const { loader, calls } = fakeLoader({
      "/assets/c.png": {
        width: 1,
        height: 1,
        pixels: new Uint8ClampedArray([8, 8, 8, 255]),
      },
    });
    await bakeExternalTextureTints(document.body, loader);
    first.remove();
    const second = tintedElement({ url: "/assets/c.png" });
    await bakeExternalTextureTints(document.body, loader);
    expect(calls).toEqual(["/assets/c.png"]);
    expect(second.getAttribute("data-godot-texture-tint")).toBe("baked-bitmap");
    second.remove();
  });

  it("skips data-URI backgrounds (already baked at render time)", async () => {
    const element = tintedElement({ url: "/assets/d.png" });
    element.style.setProperty(
      "background-image",
      'url("data:image/png;base64,x")',
    );
    const { loader, calls } = fakeLoader({});
    const upgraded = await bakeExternalTextureTints(document.body, loader);
    expect(upgraded).toBe(0);
    expect(calls).toEqual([]);
    element.remove();
  });
});

// `clampExternalNinePatchSlices`: the post-mount pass that re-clamps an external nine-patch's
// `border-image-slice` once the texture's natural size is known, so a small fill (opposing
// patch margins meeting in the source — the HP-bar fill) keeps its `fill` center instead of
// collapsing to just the end-caps.
describe("clampExternalNinePatchSlices", () => {
  function ninePatchElement(opts: {
    margins: string;
    slice: string;
    url?: string;
  }): HTMLElement {
    const element = document.createElement("div");
    element.setAttribute("data-godot-nine-patch-unclamped", opts.margins);
    element.style.setProperty(
      "border-image-source",
      `url("${opts.url ?? "/assets/fill.png"}")`,
    );
    element.style.setProperty("border-image-slice", opts.slice);
    document.body.appendChild(element);
    return element;
  }

  const sized = (url: string, width: number, height: number) =>
    fakeLoader({ [url]: { width, height, pixels: new Uint8ClampedArray(0) } })
      .loader;

  it("clamps the source slices to keep a >=1px fill center when opposing margins overlap", async () => {
    // The HP-bar fill: 6px patch margins on an 8x8 source — 6+6=12 overlaps the 8px axis, so
    // `border-image-slice 6 6 6 6 fill` drops the center (caps but no middle).
    const element = ninePatchElement({
      margins: "6,6,6,6",
      slice: "6 6 6 6 fill",
      url: "/assets/hp.png",
    });
    const changed = await clampExternalNinePatchSlices(
      document.body,
      sized("/assets/hp.png", 8, 8),
    );
    expect(changed).toBe(1);
    // clampSlicePair(6,6,8): maxTotal=7, scale=7/12 -> floor(6*0.583)=3.
    expect(element.style.getPropertyValue("border-image-slice")).toBe(
      "3 3 3 3 fill",
    );
    expect(element.hasAttribute("data-godot-nine-patch-unclamped")).toBe(false);
    element.remove();
  });

  it("leaves non-overlapping nine-patches unchanged (e.g. the bar background)", async () => {
    const element = ninePatchElement({
      margins: "2,2,2,2",
      slice: "2 2 2 2 fill",
      url: "/assets/bg.png",
    });
    const changed = await clampExternalNinePatchSlices(
      document.body,
      sized("/assets/bg.png", 100, 24),
    );
    expect(changed).toBe(0);
    expect(element.style.getPropertyValue("border-image-slice")).toBe(
      "2 2 2 2 fill",
    );
    // Still cleared so re-runs skip it.
    expect(element.hasAttribute("data-godot-nine-patch-unclamped")).toBe(false);
    element.remove();
  });

  it("keeps the marker when the image cannot be loaded (a later pass retries)", async () => {
    const element = ninePatchElement({
      margins: "6,6,6,6",
      slice: "6 6 6 6 fill",
      url: "/assets/missing-np.png",
    });
    const { loader } = fakeLoader({});
    const changed = await clampExternalNinePatchSlices(document.body, loader);
    expect(changed).toBe(0);
    expect(element.getAttribute("data-godot-nine-patch-unclamped")).toBe(
      "6,6,6,6",
    );
    expect(element.style.getPropertyValue("border-image-slice")).toBe(
      "6 6 6 6 fill",
    );
    element.remove();
  });
});
