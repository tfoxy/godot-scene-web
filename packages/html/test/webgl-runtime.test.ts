import { describe, expect, it } from "vitest";
import {
  blendToMixBlendMode,
  createWebglShaderRuntime,
  parseAtlasRegion,
  syncCanvasSizeForTest,
} from "../src/webgl/runtime";

// A minimal fake binding for syncCanvasSize: a self-layer whose clientWidth/Height reads are COUNTED (they are
// the forced-reflow hazard the box cache exists to avoid), a canvas that records its backing size, plus the
// window + boxW/boxH the function reads and writes.
//
// `pixelRatioScale` is the per-binding density multiplier (`data-godot-shader-pixel-ratio`); the real create
// path resolves an absent attribute to exactly 1, so 1 is what an un-stamped binding looks like here.
function fakeBinding(clientW: number, clientH: number, pixelRatioScale = 1) {
  const reads = { count: 0 };
  const selfLayer = {
    get clientWidth() {
      reads.count++;
      return clientW;
    },
    get clientHeight() {
      reads.count++;
      return clientH;
    },
  };
  const canvas = { width: 0, height: 0 };
  const binding = {
    selfLayer,
    canvas,
    window: [0, 0, 1, 1] as [number, number, number, number],
    boxW: 0,
    boxH: 0,
    boxMeasured: false,
    pixelRatioScale,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal structural stand-in for NodeBinding in a unit test.
  return { binding: binding as any, reads, canvas };
}

describe("parseAtlasRegion (atlas sub-rect crop gate for shaders)", () => {
  it("parses a positive x,y,w,h sub-rect", () => {
    expect(parseAtlasRegion("128,64,92,92")).toEqual({
      x: 128,
      y: 64,
      width: 92,
      height: 92,
    });
  });

  it("tolerates whitespace and floats", () => {
    expect(parseAtlasRegion(" 10.5, 20 , 30.5 , 40 ")).toEqual({
      x: 10.5,
      y: 20,
      width: 30.5,
      height: 40,
    });
  });

  it("returns null for a non-atlas texture (absent), malformed, or zero-size region", () => {
    // absent → sample the whole image (getTexture), not a crop.
    expect(parseAtlasRegion(null)).toBeNull();
    expect(parseAtlasRegion("128,64,92")).toBeNull(); // too few components
    expect(parseAtlasRegion("128,x,92,92")).toBeNull(); // non-finite
    expect(parseAtlasRegion("128,64,0,92")).toBeNull(); // zero width
  });
});

describe("createWebglShaderRuntime — live retune setters", () => {
  it("exposes callable setRenderScale/setFps on the no-op handle (no WebGL2 in jsdom)", () => {
    const root = document.createElement("div");
    const runtime = createWebglShaderRuntime(root, {
      resolveShaderSource: () => undefined,
    });
    // jsdom has no WebGL2 → no-op handle, but the adaptive consumer must still be able to call the
    // setters unconditionally without a runtime feature-check.
    expect(() => {
      runtime.setRenderScale(0.25);
      runtime.setFps(25);
      runtime.reconcile();
      runtime.dispose();
    }).not.toThrow();
  });
});

describe("syncCanvasSize — box caching avoids the post-create clientWidth reflow storm", () => {
  it("reads clientWidth/Height ONCE on the first (create-time) sync, then reuses the cached box", () => {
    const { binding, reads, canvas } = fakeBinding(200, 280);
    // First sync (no contentRect, boxW=0) → the single unavoidable create-time layout read.
    syncCanvasSizeForTest(binding, 1);
    expect(reads.count).toBe(2); // clientWidth + clientHeight
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(280);
    expect(binding.boxW).toBe(200);

    // A later WINDOW-only resize (no contentRect): the box is unchanged, so it must reuse the cache — NO reflow.
    binding.window = [0, 0, 0.5, 0.25];
    syncCanvasSizeForTest(binding, 1);
    expect(reads.count).toBe(2); // still 2 — no new clientWidth/Height read
    expect(canvas.width).toBe(100); // 200 * 0.5
    expect(canvas.height).toBe(70); // 280 * 0.25

    // A renderScale step (dpr change, still no contentRect): reuses the cache too.
    syncCanvasSizeForTest(binding, 2);
    expect(reads.count).toBe(2);
    expect(canvas.width).toBe(200); // 200 * 0.5 * 2
  });

  it("prefers the ResizeObserver contentRect (never a reflow) and refreshes the cache from it", () => {
    const { binding, reads, canvas } = fakeBinding(200, 280);
    syncCanvasSizeForTest(binding, 1); // seed the cache (2 reads)
    reads.count = 0;

    // The observer delivers a NEW box size via contentRect → used directly, no clientWidth read, cache updated.
    syncCanvasSizeForTest(binding, 1, { width: 400, height: 100 });
    expect(reads.count).toBe(0);
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(100);
    expect(binding.boxW).toBe(400);

    // A subsequent window resize now derives from the observer's box — still no reflow.
    binding.window = [0, 0, 0.5, 1];
    syncCanvasSizeForTest(binding, 1);
    expect(reads.count).toBe(0);
    expect(canvas.width).toBe(200); // 400 * 0.5
  });

  it("latches a 0x0 box instead of re-reading the layout on every later sync", () => {
    // A shader self-layer can legitimately measure 0x0 — a hidden ancestor, a node with no rect —
    // and the reuse gate used to be `boxW > 0`, so such a binding NEVER latched: every later sync
    // (a window change, a renderScale step, a frozen-mode pin) went back through the forced
    // clientWidth/clientHeight layout, for as long as the node lived. Only a resize can make the box
    // non-zero, and a resize is exactly what the shared ResizeObserver delivers as a contentRect.
    const { binding, reads, canvas } = fakeBinding(0, 0);
    syncCanvasSizeForTest(binding, 1);
    expect(reads.count).toBe(2); // the one create-time read
    expect(canvas.width).toBe(1); // a 0-wide box still gets a minimum 1px backing store
    expect(canvas.height).toBe(1);

    binding.window = [0, 0, 0.5, 1];
    syncCanvasSizeForTest(binding, 1);
    syncCanvasSizeForTest(binding, 2);
    expect(reads.count).toBe(2); // ← the gate: no re-read, where it used to be 2 more per sync

    // …and the observer's later delivery is what un-sticks it.
    syncCanvasSizeForTest(binding, 1, { width: 300, height: 200 });
    expect(reads.count).toBe(2);
    expect(canvas.width).toBe(150); // 300 * 0.5
    expect(canvas.height).toBe(200);
  });

  it("latches a 0x0 contentRect delivery too (no fallthrough to a layout read)", () => {
    const { binding, reads, canvas } = fakeBinding(640, 480);
    // The live ResizeObserver branch hands a 0x0 contentRect straight through (a node that just
    // became un-laid-out); the box it writes must still count as measured.
    syncCanvasSizeForTest(binding, 1, { width: 0, height: 0 });
    expect(reads.count).toBe(0);
    expect(canvas.width).toBe(1);

    syncCanvasSizeForTest(binding, 1);
    expect(reads.count).toBe(0); // ← would have been 2 (a fresh clientWidth/Height read)
  });
});

// The fourth input to the sizing (see `SURFACE_PIXEL_RATIO_ATTR`): the PER-BINDING density
// multiplier, which the host stamps because `clientWidth` cannot see the ancestor CSS transform
// that magnified this surface. The attribute plumbing, the swap interaction and the composition
// with the static pin are in `surface-pixel-ratio.test.ts`; this is the arithmetic.
describe("syncCanvasSize — the per-binding pixel-ratio multiplier", () => {
  it("multiplies into the density term: 220 box × dpr 2 × √2 → 622", () => {
    // The live-consumer case in numbers — two particle canvases at a 440 backing, displayed ×√2.
    const { binding, canvas } = fakeBinding(220, 220, Math.SQRT2);
    syncCanvasSizeForTest(binding, 2);
    expect(canvas.width).toBe(622); // round(220 × 1 × 2 × √2)
    expect(canvas.height).toBe(622);
  });

  it("is EXACTLY off at 1: the same box and dpr size byte-for-byte as they always did", () => {
    const { binding, canvas } = fakeBinding(220, 220, 1);
    syncCanvasSizeForTest(binding, 2);
    expect(canvas.width).toBe(440); // round(220 × 1 × 2) — the pre-attribute answer
    expect(canvas.height).toBe(440);
  });

  it("composes with the uv WINDOW instead of replacing it", () => {
    const { binding, canvas } = fakeBinding(220, 220, Math.SQRT2);
    binding.window = [0, 0, 0.5, 0.25];
    syncCanvasSizeForTest(binding, 2);
    expect(canvas.width).toBe(311); // round(220 × 0.5 × 2 × √2)
    expect(canvas.height).toBe(156); // round(220 × 0.25 × 2 × √2)
  });

  it("costs no extra layout read — the box cache still answers", () => {
    const { binding, reads, canvas } = fakeBinding(220, 220, Math.SQRT2);
    syncCanvasSizeForTest(binding, 2);
    expect(reads.count).toBe(2); // the one create-time read
    binding.pixelRatioScale = 1.2247;
    syncCanvasSizeForTest(binding, 2);
    expect(reads.count).toBe(2); // ← a density change moves no BOX, so nothing is re-measured
    expect(canvas.width).toBe(539); // round(220 × 2 × 1.2247)
  });
});

describe("blendToMixBlendMode", () => {
  it("maps blend_add to additive (plus-lighter)", () => {
    expect(blendToMixBlendMode("add")).toBe("plus-lighter");
  });

  it("maps blend_mul to multiply", () => {
    expect(blendToMixBlendMode("mul")).toBe("multiply");
  });

  it("leaves mix (default) and unmapped modes as normal source-over", () => {
    expect(blendToMixBlendMode("mix")).toBe("");
    expect(blendToMixBlendMode("sub")).toBe("");
    expect(blendToMixBlendMode("premul_alpha")).toBe("");
  });
});
