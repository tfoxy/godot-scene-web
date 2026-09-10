// jsdom (gsw default env).
//
// `src/webgpu/still-capture.ts` — the seam between a WebGPU READBACK (tightly packed, top-down,
// PREMULTIPLIED RGBA) and an ENCODER (`putImageData` wants straight alpha). Small, pure, and
// load-bearing: the frozen-surface image swap on a WebGPU binding publishes whatever comes out of
// here, so an error in it is a wrong picture on screen with nothing to catch it.
//
// What is pinned, and why:
//   - alpha 0 → (0,0,0), by CONVENTION rather than by division. The parity harness's `pixels.ts`
//     argues that an alpha-0 colour "does not exist"; that argument bites a COMPARISON, and this is
//     an encode, so the canonical invisible pixel is the right answer and has to be a stated one.
//   - the CLAMP. A readback can carry c > a (the GPU blends in float and stores 8-bit), and
//     `c * 255 / a` then exceeds 255 — which a `Uint8Array` would WRAP rather than saturate.
//   - the ROUND TRIP. Unpremultiply → re-premultiply must land within ~1 byte per channel across the
//     whole (c, a) grid, because that composed error is exactly what the desktop swap-parity test
//     budgets for.
//   - the guards on the canvas conversion, each of which is a real environment: SSR (no `document`),
//     a byte count that does not match the stated size, and jsdom (no 2D context).
//   - THE BLANK GUARD. A readback can come back entirely transparent while the surface was painting
//     (headed Chromium on the default ANGLE backend does exactly that — docs/perf-harness.md, S8),
//     and publishing it stands a PNG of nothing over a hidden canvas with every counter reporting
//     success. The scan rides the unpremultiply loop; the VERDICT is only reached when the caller
//     asserts coverage, because an invisible frame is also what a system with nothing to draw
//     legitimately produces and refusing that one would leave a live canvas up forever.
import { afterEach, describe, expect, it } from "vitest";

import { STATIC_CAPTURE_BLANK } from "../src/surface-image-swap";
import {
  canvasFromPremultipliedRgba,
  type RgbaAlphaScan,
  unpremultiplyRgba,
} from "../src/webgpu/still-capture";

/** The inverse this file's output is expected to survive — deliberately a LOCAL copy of the parity
 *  harness's `premultiplyRgba` (packages/test-harness/src/webgpu-parity/pixels.ts), so the round-trip
 *  budget is proven against the same arithmetic the desktop test compares with and not against an
 *  import that could drift with it. */
function premultiplyRgba(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    out[index] = Math.round((rgba[index] * alpha) / 255);
    out[index + 1] = Math.round((rgba[index + 1] * alpha) / 255);
    out[index + 2] = Math.round((rgba[index + 2] * alpha) / 255);
    out[index + 3] = alpha;
  }
  return out;
}

describe("unpremultiplyRgba", () => {
  it("maps a fully transparent pixel to the canonical (0,0,0,0), whatever bytes it carried", () => {
    // A readback legitimately leaves garbage in the colour channels of an alpha-0 pixel.
    const out = unpremultiplyRgba(new Uint8Array([200, 30, 90, 0]));
    expect([...out]).toEqual([0, 0, 0, 0]);
  });

  it("is the identity at full alpha", () => {
    const source = new Uint8Array([0, 17, 128, 255, 255, 254, 1, 255]);
    expect([...unpremultiplyRgba(source)]).toEqual([...source]);
  });

  it("divides by alpha for partially transparent pixels", () => {
    // 64 = round(128 * 0.5): a mid-grey at half alpha, premultiplied.
    expect([...unpremultiplyRgba(new Uint8Array([64, 32, 16, 128]))]).toEqual([
      128, 64, 32, 128,
    ]);
  });

  it("CLAMPS a channel that came back brighter than its own alpha", () => {
    // c > a is reachable from GPU float rounding; unclamped this is 638, and a Uint8Array would
    // store 126.
    const out = unpremultiplyRgba(new Uint8Array([50, 20, 20, 20]));
    expect(out[0]).toBe(255);
    expect(out[3]).toBe(20);
  });

  it("returns a NEW buffer and leaves the input untouched", () => {
    const source = new Uint8Array([64, 64, 64, 128]);
    const out = unpremultiplyRgba(source);
    expect(out).not.toBe(source);
    expect(out.buffer).not.toBe(source.buffer);
    expect([...source]).toEqual([64, 64, 64, 128]);
  });

  it("round-trips to within 1 byte per channel in PREMULTIPLIED space over the whole (c, a) grid", () => {
    // The composed error the desktop swap-parity budget is built on: one rounding on the way out
    // (unpremultiply) and one on the way back (the compositor re-premultiplying the decoded PNG).
    const pixels: number[] = [];
    for (let alpha = 0; alpha <= 255; alpha++) {
      for (let channel = 0; channel <= alpha; channel++) {
        pixels.push(channel, Math.floor(channel / 2), 0, alpha);
      }
    }
    const premultiplied = new Uint8Array(pixels);
    const back = premultiplyRgba(unpremultiplyRgba(premultiplied));
    let worst = 0;
    for (let index = 0; index < premultiplied.length; index++) {
      worst = Math.max(worst, Math.abs(back[index] - premultiplied[index]));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});

// ---- the blank scan ----------------------------------------------------------------------------

/** A fresh scan object, as every caller builds one. */
function scan(): RgbaAlphaScan {
  return { anyAlpha: false };
}

describe("unpremultiplyRgba — the blank scan", () => {
  it("reports no alpha for an all-zero readback (the empty frame a broken readback hands back)", () => {
    const found = scan();
    unpremultiplyRgba(new Uint8Array(4 * 64), found);
    expect(found.anyAlpha).toBe(false);
  });

  it("reports no alpha when the COLOUR channels are loud and every alpha is 0", () => {
    // The case a colour-only test would miss: premultiplied bytes with a=0 composite to nothing
    // whatever they carry, and this function itself flattens them to (0,0,0,0). "Blank" is an ALPHA
    // question, never a colour one.
    const pixels = new Uint8Array(4 * 3);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 255;
      pixels[index + 1] = 128;
      pixels[index + 2] = 7;
      pixels[index + 3] = 0;
    }
    const found = scan();
    unpremultiplyRgba(pixels, found);
    expect(found.anyAlpha).toBe(false);
  });

  it("ONE pixel of alpha 1 in a whole frame is enough", () => {
    const pixels = new Uint8Array(4 * 256);
    pixels[4 * 200 + 3] = 1;
    const found = scan();
    unpremultiplyRgba(pixels, found);
    expect(found.anyAlpha).toBe(true);
  });

  it("costs the caller nothing when no scan is asked for", () => {
    // The scan is an optional out-param precisely so the conversion path can stay one loop; this
    // pins that the bytes are unaffected by asking (or not asking) for it.
    const source = new Uint8Array([64, 32, 16, 128, 0, 0, 0, 0]);
    const withScan = unpremultiplyRgba(source, scan());
    expect([...unpremultiplyRgba(source)]).toEqual([...withScan]);
  });
});

// ---- the canvas conversion ---------------------------------------------------------------------

interface Recorded {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  dx: number;
  dy: number;
}

let restoreGetContext: (() => void) | null = null;
let restoreImageData: (() => void) | null = null;

/** jsdom ships no `ImageData` either (it is part of the optional canvas implementation), so the
 *  browser's own class is stood up here. Its absence is itself a tested path below — the conversion
 *  must answer null rather than throw where it cannot run. */
function stubImageData(): void {
  const original = (globalThis as Record<string, unknown>).ImageData;
  (globalThis as Record<string, unknown>).ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  restoreImageData = () => {
    (globalThis as Record<string, unknown>).ImageData = original;
  };
}

/** How the stub context answers the write-back check's 1×1 `getImageData`:
 *   - `"absent"` (default): no such method, which is jsdom and every other stub in this file;
 *   - `"written"`: a working canvas, answering with the alpha the conversion just wrote there;
 *   - `"zero"`: the ACCELERATED-canvas failure measured headed on the default ANGLE backend — the
 *     write is accepted and the canvas holds nothing;
 *   - `"throw"`: a context that refuses the read at all. */
type ReadBack = "absent" | "written" | "zero" | "throw";

/** jsdom has no 2D context at all, so the one the conversion needs is stubbed down to the calls it
 *  makes. `null` models the environment as it really is (and is a path the code must survive). */
function stub2dContext(available: boolean, readBack: ReadBack = "absent") {
  const recorded: Recorded[] = [];
  const reads: Array<{ x: number; y: number }> = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(
    kind: string,
  ): unknown {
    if (kind !== "2d" || !available) return null;
    const context: Record<string, unknown> = {
      putImageData: (image: ImageData, dx: number, dy: number): void => {
        recorded.push({
          data: image.data,
          width: image.width,
          height: image.height,
          dx,
          dy,
        });
      },
    };
    if (readBack !== "absent") {
      context.getImageData = (x: number, y: number): unknown => {
        reads.push({ x, y });
        if (readBack === "throw") throw new Error("the read was refused");
        if (readBack === "zero") {
          return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        }
        // A working canvas: answer with the pixel the conversion wrote there.
        const last = recorded[recorded.length - 1];
        const index = (y * (last?.width ?? 1) + x) * 4;
        return {
          data: last?.data.slice(index, index + 4) ?? new Uint8ClampedArray(4),
          width: 1,
          height: 1,
        };
      };
    }
    return context;
  } as typeof HTMLCanvasElement.prototype.getContext;
  restoreGetContext = () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
  return Object.assign(recorded, { reads });
}

afterEach(() => {
  restoreGetContext?.();
  restoreGetContext = null;
  restoreImageData?.();
  restoreImageData = null;
});

describe("canvasFromPremultipliedRgba", () => {
  it("sizes the canvas and hands the 2D context the STRAIGHT bytes", () => {
    stubImageData();
    const recorded = stub2dContext(true);
    // 2x1: an opaque red, and a half-alpha white.
    const canvas = canvasFromPremultipliedRgba(
      new Uint8Array([255, 0, 0, 255, 128, 128, 128, 128]),
      2,
      1,
    );
    expect(canvas).not.toBeNull();
    expect(canvas?.width).toBe(2);
    expect(canvas?.height).toBe(1);
    expect(recorded.length).toBe(1);
    expect(recorded[0].width).toBe(2);
    expect(recorded[0].height).toBe(1);
    expect(recorded[0].dx).toBe(0);
    expect(recorded[0].dy).toBe(0);
    expect([...recorded[0].data]).toEqual([255, 0, 0, 255, 255, 255, 255, 128]);
  });

  it("answers null when the byte count does not match the stated size", () => {
    stubImageData();
    stub2dContext(true);
    expect(canvasFromPremultipliedRgba(new Uint8Array(4 * 3), 2, 2)).toBeNull();
    expect(canvasFromPremultipliedRgba(new Uint8Array(0), 1, 1)).toBeNull();
  });

  it("answers null on a degenerate size", () => {
    stubImageData();
    stub2dContext(true);
    expect(canvasFromPremultipliedRgba(new Uint8Array(0), 0, 4)).toBeNull();
    expect(canvasFromPremultipliedRgba(new Uint8Array(0), 4, 0)).toBeNull();
  });

  it("answers null where there is no 2D context (jsdom, a lost context)", () => {
    stubImageData();
    stub2dContext(false);
    expect(canvasFromPremultipliedRgba(new Uint8Array(4), 1, 1)).toBeNull();
  });

  it("answers null where there is no `ImageData` at all (bare jsdom) rather than throwing", () => {
    stub2dContext(true);
    expect(typeof ImageData).toBe("undefined");
    expect(canvasFromPremultipliedRgba(new Uint8Array(4), 1, 1)).toBeNull();
  });

  // ---- the blank verdict -----------------------------------------------------------------------

  it("REFUSES an all-transparent readback when the caller asserts coverage", () => {
    stubImageData();
    const recorded = stub2dContext(true);
    expect(canvasFromPremultipliedRgba(new Uint8Array(4 * 4), 2, 2, true)).toBe(
      STATIC_CAPTURE_BLANK,
    );
    // …and nothing was converted: the refusal happens before the pixels are handed to a context, so
    // a broken readback costs no `putImageData` and no `toBlob` downstream.
    expect(recorded.length).toBe(0);
  });

  it("refuses an all-transparent readback whose COLOUR bytes are non-zero", () => {
    stubImageData();
    stub2dContext(true);
    const pixels = new Uint8Array([9, 9, 9, 0, 200, 30, 90, 0]);
    expect(canvasFromPremultipliedRgba(pixels, 2, 1, true)).toBe(
      STATIC_CAPTURE_BLANK,
    );
  });

  it("ENCODES a legitimately empty frame — the surface with nothing to draw — when coverage is not asserted", () => {
    // The load-bearing half. A particle system that has emitted nothing, or whose particles have all
    // faded, reads back exactly like a broken readback; its producer says so by NOT asserting
    // coverage, and it must still be allowed to freeze or the swap would hold a live canvas forever.
    stubImageData();
    const recorded = stub2dContext(true);
    const canvas = canvasFromPremultipliedRgba(new Uint8Array(4 * 4), 2, 2);
    expect(canvas).not.toBeNull();
    expect(canvas).not.toBe(STATIC_CAPTURE_BLANK);
    expect(recorded.length).toBe(1);
    expect([...recorded[0].data]).toEqual([...new Uint8Array(16)]);
  });

  it("encodes a frame with ONE non-transparent pixel even under the assertion", () => {
    stubImageData();
    const recorded = stub2dContext(true);
    const pixels = new Uint8Array(4 * 4);
    pixels[4 * 2 + 3] = 1;
    const canvas = canvasFromPremultipliedRgba(pixels, 2, 2, true);
    expect(canvas).not.toBeNull();
    expect(canvas).not.toBe(STATIC_CAPTURE_BLANK);
    expect(recorded.length).toBe(1);
  });

  // ---- the write-back check --------------------------------------------------------------------
  //
  // The OTHER way this function can produce a picture of nothing, and the one measured on this box:
  // the readback is fine and the 2D canvas keeps none of it (headed, default ANGLE — `putImageData`
  // then `getImageData` read back 0 of 4,096 px, and the PNG was 272 bytes of nothing).

  /** A 2×2 frame with one solid pixel at (1, 0) — the witness the check reads back. */
  function withSolidPixel(): Uint8Array {
    const pixels = new Uint8Array(4 * 4);
    pixels[4] = 200;
    pixels[5] = 40;
    pixels[6] = 40;
    pixels[7] = 255;
    return pixels;
  }

  it("REFUSES when the canvas reads back nothing where the frame's most opaque pixel was written", () => {
    stubImageData();
    const recorded = stub2dContext(true, "zero");
    expect(canvasFromPremultipliedRgba(withSolidPixel(), 2, 2, true)).toBe(
      STATIC_CAPTURE_BLANK,
    );
    // Read at the WITNESS — pixel index 1 of a 2-wide frame, i.e. (1, 0) — not at a guessed corner.
    expect(recorded.reads).toEqual([{ x: 1, y: 0 }]);
  });

  it("accepts when the canvas answers with the pixel it was given", () => {
    stubImageData();
    const recorded = stub2dContext(true, "written");
    const canvas = canvasFromPremultipliedRgba(withSolidPixel(), 2, 2, true);
    expect(canvas).not.toBe(STATIC_CAPTURE_BLANK);
    expect(canvas).not.toBeNull();
    expect(recorded.reads.length).toBe(1);
  });

  it("FAILS OPEN where the environment cannot answer — no getImageData, or one that throws", () => {
    // Never a new way for a healthy surface to fail to freeze: only a positive alpha-0 reading is a
    // refusal. (jsdom is the "absent" case, and it is what every other test in this file runs on.)
    stubImageData();
    stub2dContext(true, "absent");
    expect(
      canvasFromPremultipliedRgba(withSolidPixel(), 2, 2, true),
    ).not.toBeNull();
    restoreGetContext?.();
    restoreGetContext = null;
    stub2dContext(true, "throw");
    const canvas = canvasFromPremultipliedRgba(withSolidPixel(), 2, 2, true);
    expect(canvas).not.toBe(STATIC_CAPTURE_BLANK);
    expect(canvas).not.toBeNull();
  });

  it("does not read anything back when coverage is not asserted", () => {
    // The check costs a 1×1 readback, and a caller that has made no claim about its frame is not
    // asking a question this could answer.
    stubImageData();
    const recorded = stub2dContext(true, "zero");
    expect(canvasFromPremultipliedRgba(withSolidPixel(), 2, 2)).not.toBeNull();
    expect(recorded.reads).toEqual([]);
  });
});
