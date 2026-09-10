// Turning captured WebGPU pixels into something an ENCODER can read.
//
// WHY THIS FILE EXISTS. The frozen-surface image swap (`../surface-image-swap`) stands an `<img>` in
// for a canvas that has stopped changing, and it makes that image with `canvas.toBlob()`. On a
// WebGPU binding there is no canvas to call that on: reading a WebGPU canvas back — `drawImage`,
// `toDataURL`, `toBlob` — goes through the PRESENTATION path, which is blank under SwiftShader,
// returns nothing at all in headless Chrome (it never composites a WebGPU canvas), and is
// pathologically slow on Android (S7 measured the blit-shaped arm at 23 Hz against 87). The
// sanctioned path is `../webgpu/readback`: re-render the frame into an offscreen `rgba8unorm`
// texture and `copyTextureToBuffer` it back. What comes out of that is a tightly packed, top-down,
// PREMULTIPLIED RGBA byte array — and `putImageData` wants STRAIGHT alpha. These two functions are
// that seam, and nothing else.
//
// PREMULTIPLIED → STRAIGHT, AND WHY IT IS SOUND HERE. `packages/test-harness/src/webgpu-parity/
// pixels.ts` argues the opposite direction — that a parity comparison must move to PREMULTIPLIED
// space, because un-premultiplying divides by alpha and "the colour of an alpha-0 pixel does not
// exist", so whatever bytes two renderers happen to leave there would read as a difference. That
// argument is about COMPARISON, where an arbitrary value is a false failure. It does not block this
// ENCODE path, for two reasons:
//
//   - the ambiguity is resolved by CONVENTION, not by guessing: alpha 0 → (0,0,0), the canonical
//     invisible pixel, which is exactly what the PNG encoder would have to store anyway and exactly
//     what a browser's own `putImageData`/`getImageData` round trip produces;
//   - the trip is a ROUND TRIP, and it ends where it started. These bytes are unpremultiplied,
//     drawn into a 2D canvas, encoded to PNG, decoded by the `<img>`, and RE-premultiplied by the
//     compositor before anything is shown. Composed, the error is ≤ ~1 byte per channel in
//     premultiplied space (one rounding at each end), which is why the desktop swap-parity test
//     compares in premultiplied space at a per-channel tolerance of ~2 rather than asserting
//     equality on the straight bytes.
//
// The clamp below is not defensive decoration. A readback can legitimately carry c > a: the GPU
// blends and rounds in float and stores 8-bit, so a fully saturated channel at low alpha can land
// one ULP above its own alpha. `c * 255 / a` then exceeds 255, and an unclamped write into a
// `Uint8ClampedArray` would be saved by the array's own clamp while a `Uint8Array` would WRAP — so
// the clamp is stated here, once, rather than left to whichever buffer type a caller passes.
//
// THE BLANK GUARD, and the two ways this conversion can produce a picture of nothing.
//
// A frozen WebGPU surface publishes whatever comes out of here, and the canvas underneath it is
// HIDDEN by then — so an invisible result is not a degraded image, it is a surface that has
// disappeared with every counter in `../surface-image-swap` reporting success. That happened for
// real on one launch mode of this box (headed Chromium under Xvfb on the default ANGLE backend,
// NVIDIA RTX 2060; docs/perf-harness.md, S8), where all 12 WebGPU surfaces of both effect arms
// swapped and the screenshot showed none of them. Two things can do it, and only one of them was:
//
//   1. THE READBACK CAME BACK EMPTY. The premise of everything below is that `pixels` are the frame.
//      A device whose `copyTextureToBuffer` hands back zeros breaks it silently. Caught by a scan
//      FOLDED INTO the unpremultiply loop, which is already walking every byte: a comparison per
//      pixel, once per frozen surface. NOT what that rung does — measured 2026-08-21, the readback
//      there is fine (827 painted px of 15,376 on the `textured` fixture).
//   2. THE 2D CANVAS DID NOT TAKE THE PIXELS — what actually happens there, and the reason this
//      second check exists at all. `putImageData` into an ACCELERATED 2D canvas does not land:
//      reading any pixel of it back answers alpha 0, and the `toBlob` that follows encodes the
//      nothing that is really in the canvas (in the more broken of the two launchers measured, a
//      PNG decoded OUTSIDE the browser — the in-page read cannot be trusted to measure itself —
//      holds 0 of 16,384 painted px). The same page's `willReadFrequently: true` canvas, which
//      Chrome keeps on the CPU, takes the identical write and answers 255. Caught by reading ONE
//      pixel back — the most opaque one, whose alpha this function knows — because a canvas that
//      answers 0 where we just wrote 255 is answering about a write it lost.
//      WHY THIS IS A FAIR TEST OF THE ENCODE, and why it does not generalise to a canvas painted by
//      someone else: it exercises the same CPU→canvas→CPU trip the encode depends on, on the same
//      canvas, with bytes this function chose. On the SAME rung, a canvas the host painted with
//      `drawImage` still encodes correctly through `toBlob` — so the shipped WebGL swap, which reads
//      such a canvas directly, is unaffected there and must not be judged by this check (see
//      `../surface-image-swap`'s WHY THE DIRECT PATH IS NOT GUARDED).
//
// NEITHER IS DECIDED FROM THE PIXELS ALONE. An invisible frame is also what a surface with nothing
// to draw legitimately produces, and refusing that one would hold a live canvas in the composite
// forever. Both verdicts are therefore reached only when the CALLER passes `expectCoverage` — its
// assertion that the draw it just encoded must have put pixels somewhere — and both answer
// `STATIC_CAPTURE_BLANK`, which the swap treats as a capture failure (`../surface-image-swap`'s
// BLANK CAPTURES).
//
// FAIL OPEN, ALWAYS. The write-back check refuses ONLY on a positive reading of alpha 0 at a pixel
// it knows it wrote. An environment that cannot answer at all — no `getImageData` (jsdom), a context
// that throws — is never a refusal: this guard exists to stop a blank publish, not to become a new
// way for a surface to fail to freeze.

import {
  STATIC_CAPTURE_BLANK,
  type StaticSurfaceCapture,
} from "../surface-image-swap";

/** What `unpremultiplyRgba` reports about the bytes it walked, for a caller that must tell an empty
 *  frame from an empty CAPTURE. Mutated in place — an out-param rather than a returned pair — so the
 *  scan rides along the existing loop instead of allocating or walking a second time. Build one
 *  zeroed (`{ anyAlpha: false, witness: -1 }`); this function only ever writes it. */
export interface RgbaAlphaScan {
  /** At least one pixel carried a non-zero alpha byte. `false` after a whole buffer ⇒ the frame is
   *  entirely invisible: every pixel composites to nothing, whatever its colour channels say. */
  anyAlpha: boolean;
  /** Index — in PIXELS, not bytes — of the MOST OPAQUE pixel seen, or -1 for none. The witness the
   *  write-back check reads: the one pixel whose alpha this loop can state from the source bytes, so
   *  a canvas answering 0 there is answering about a write that was definitely made. Most opaque
   *  rather than first, because alpha survives a canvas round trip exactly at 255 and only that
   *  reading needs no argument about precision. */
  witness: number;
}

/**
 * Premultiplied RGBA → straight ("unassociated") RGBA, in a NEW buffer (the input is untouched — a
 * capture buffer may be handed to more than one consumer).
 *
 * Alpha 0 → `(0, 0, 0, 0)`: the canonical invisible pixel (see the module doc on why this convention
 * is sound for an encode path and not for a comparison one). Otherwise each channel is
 * `round(c * 255 / a)`, CLAMPED to 255 — a readback can carry `c > a` from GPU rounding.
 *
 * `scan`, when given, collects the blank guard's two facts on the walk this loop was making anyway:
 * `anyAlpha` the moment a pixel with a non-zero alpha is seen, and `witness` at the most opaque
 * pixel of the buffer (see the module doc).
 */
export function unpremultiplyRgba(
  premultiplied: Uint8Array,
  scan?: RgbaAlphaScan,
): Uint8Array<ArrayBuffer> {
  // The buffer type is stated (rather than left as the default `ArrayBufferLike`) so the caller
  // below can build a `Uint8ClampedArray` VIEW over these same bytes instead of copying them: a
  // capture is a whole backing store, and `ImageData` only accepts the clamped view.
  const out = new Uint8Array(new ArrayBuffer(premultiplied.length));
  let witnessAlpha = 0;
  for (let index = 0; index + 3 < premultiplied.length; index += 4) {
    const alpha = premultiplied[index + 3];
    out[index + 3] = alpha;
    if (alpha === 0) {
      // Already zero from the allocation; stated so the invariant is readable rather than implied.
      out[index] = 0;
      out[index + 1] = 0;
      out[index + 2] = 0;
      continue;
    }
    // Past the alpha-0 branch ⇒ this pixel composites to something. Two stores on a branch the
    // frame's own opacity bounds: `anyAlpha` settles once, and `witness` only climbs.
    if (scan) {
      scan.anyAlpha = true;
      if (alpha > witnessAlpha) {
        witnessAlpha = alpha;
        scan.witness = index >> 2;
      }
    }
    out[index] = Math.min(
      255,
      Math.round((premultiplied[index] * 255) / alpha),
    );
    out[index + 1] = Math.min(
      255,
      Math.round((premultiplied[index + 1] * 255) / alpha),
    );
    out[index + 2] = Math.min(
      255,
      Math.round((premultiplied[index + 2] * 255) / alpha),
    );
  }
  return out;
}

/**
 * Captured premultiplied RGBA → a 2D canvas holding those pixels, ready for `toBlob`. Null when the
 * conversion cannot be done at all: no `document` (SSR), a byte count that does not match
 * `width * height * 4`, a degenerate size, or an environment with no 2D context and no `ImageData`
 * (jsdom is both). A null here is an ordinary capture FAILURE upstream — the surface stays on its
 * canvas — never a throw.
 *
 * `expectCoverage` is the CALLER's assertion that the draw behind these bytes must have painted
 * something — the particle runtime's packed instance count, the shader runtime's full-viewport quad.
 * Under it this function refuses, as `STATIC_CAPTURE_BLANK` rather than encoding, BOTH ways a blank
 * still is produced (see the module doc's BLANK GUARD, and `../surface-image-swap`'s BLANK CAPTURES
 * for what the swap does with the verdict): a readback in which every pixel's alpha is 0, and a
 * canvas that reads back alpha 0 at the pixel this call just wrote its most opaque one to.
 * WITHOUT it — the default — an all-transparent readback is an ordinary frame and is encoded as one,
 * because a surface with nothing to draw is legitimately invisible and must still be allowed to
 * freeze.
 *
 * A FRESH canvas per call, deliberately — unlike the swap module's `maxDim` scratch, which is reused
 * because `toBlob` snapshots its source synchronously. Captures are ASYNCHRONOUS and can be in
 * flight concurrently (one per frozen surface), so a shared canvas would let the second capture
 * overwrite the first's pixels before its `toBlob` ever ran. The caller releases the canvas
 * (`width = 0; height = 0`) once its encode has been kicked.
 */
export function canvasFromPremultipliedRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  expectCoverage = false,
): StaticSurfaceCapture {
  if (typeof document === "undefined" || typeof ImageData === "undefined") {
    return null;
  }
  const w = Math.floor(width);
  const h = Math.floor(height);
  if (w < 1 || h < 1) return null;
  if (pixels.length !== w * h * 4) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const scan: RgbaAlphaScan = { anyAlpha: false, witness: -1 };
  const straight = unpremultiplyRgba(pixels, scan);
  /** Give the canvas back its pixels now rather than at the next GC, and report the verdict. */
  const refuse = (): StaticSurfaceCapture => {
    canvas.width = 0;
    canvas.height = 0;
    return STATIC_CAPTURE_BLANK;
  };
  // (1) Drawn, and read back invisible.
  if (expectCoverage && !scan.anyAlpha) return refuse();
  // `ImageData` needs a `Uint8ClampedArray` over the SAME bytes; `straight` is freshly allocated and
  // never referenced again, so the view is safe to hand over without another copy.
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(
        straight.buffer,
        straight.byteOffset,
        straight.length,
      ),
      w,
      h,
    ),
    0,
    0,
  );
  // (2) Written, and the canvas kept nothing. One pixel, read back where the most opaque one was
  // just written — and only under the caller's assertion, so a legitimately invisible frame (which
  // has no witness to read) is never asked the question.
  if (expectCoverage && !writeLanded(ctx, scan.witness, w)) return refuse();
  return canvas;
}

/**
 * Did the 2D canvas actually take the pixels? Reads back the ONE pixel `scan.witness` names, whose
 * alpha the conversion above knows it just wrote as the frame's most opaque.
 *
 * FAILS OPEN on everything that is not a positive "alpha 0 where a solid pixel was written": no
 * witness, no `getImageData` (jsdom), a context that throws, an answer that is not a pixel. This
 * check exists to stop a blank publish, and must never become a new reason a healthy surface cannot
 * freeze.
 *
 * COSTS one 1×1 readback per frozen surface. On an accelerated canvas that forces the pixels to be
 * flushed — which the `toBlob` a moment later forces anyway, so what moves is WHEN, not whether; and
 * it moves into the capture's own wall time (`staticImageCaptureMs`), never into the encode park
 * that `staticImageEncodeMs` means.
 */
function writeLanded(
  ctx: CanvasRenderingContext2D,
  witness: number,
  width: number,
): boolean {
  if (witness < 0) return true;
  try {
    const probe = ctx.getImageData(
      witness % width,
      Math.floor(witness / width),
      1,
      1,
    );
    const alpha = probe?.data?.[3];
    return typeof alpha === "number" ? alpha !== 0 : true;
  } catch {
    return true;
  }
}
