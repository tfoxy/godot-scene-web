// @vitest-environment node
//
// NODE, not the repo-default jsdom: esbuild refuses to run under jsdom's globals, and the DOM under
// test is a real Chromium's anyway. Same reason `canvasPixelXvfb.test.ts` states.
//
// PIXELS OUT OF THE INTEGRATED GLYPH PATH: `@godot-scene-web/canvas`'s WebGL2 executor dispatching
// `DRAW_GLYPHS` to the hb-gpu-backed `GlyphPass`, on a real GPU.
//
// WHAT THIS COVERS THAT NOTHING ELSE DOES. `packages/canvas/test/executor-glyphs.test.ts` runs
// against `test/fake-gl.ts`, a RECORDING stand-in for a context: it proves how many draws a frame
// took, in what order state was set around them, and what was bound — and it is blind to everything
// after the call returns. `packages/hb-gpu/test/glyphPixelXvfb.test.ts` draws real glyphs on this
// same GPU, but STANDALONE: its own canvas, no executor, no batcher, no clip stack, no quads. Every
// case below lives in the seam between the two and is silent when wrong:
//
//   interleave        the run composited BETWEEN two quads, not before them and not after
//   clipped           a clip rect really cuts a run in half — the pass sets no scissor of its own
//   blendAfterPass    the quad after a run uses the EXECUTOR's blend, not the one hb-gpu left set
//   premultiplied     `vec4(rgb*a, a)` survives the glyph path, end to end
//   dprUp / dprDown   design size and framebuffer size are two numbers; conflating them is a
//                     dilation error, not a placement error
//   eviction          a slot the ring evicted is re-uploaded and the RIGHT outline comes back
//   missingPass       a `DRAW_GLYPHS` with no pass draws nothing, disturbs nothing, and is counted
//
// WHAT IS SAMPLED. `gl.readPixels` on the stage's own drawing buffer, which holds PREMULTIPLIED
// bytes by the package's contract — so the expectations here are premultiplied numbers, not what a
// compositor would show over a page. `webglCompositeXvfb.test.ts` owns the canvas->page composite.
// Rows are flipped to top-down in the page, so every coordinate here is stated top-down in DEVICE
// pixels.
//
// INK MASKS RATHER THAN HAND-PICKED POINTS, for the cases that ask "what colour is the glyph". A
// coordinate chosen by eye is a coordinate that silently stops being ink when the fixture font is
// re-subset; a mask taken from a CONTROL frame of the same run, restricted to FULLY covered pixels,
// is exact and states its own sample size. Every mask assertion also asserts the mask is big
// enough, because "no ink anywhere" would otherwise pass all of them vacuously.
//
// WINDOWLESS, ON THE REAL ADAPTER — `--headless=new --enable-gpu --use-angle=vulkan`, and
// `glyphPixelXvfb.test.ts`'s header carries the measured ladder behind that choice. The short form:
// OLD headless falls back to SwiftShader on this box and the whole premise of the glyph path is a
// GPU evaluating outlines per fragment, so this suite used to be headed — but Xvfb does NOT contain
// a headed Chromium here (Ozone reaches the session compositor), so headed meant a window on
// whoever's desktop was running it. `--headless=new` with ANGLE pointed at Vulkan keeps the NVIDIA
// adapter and drops the window.
//
// PLAYWRIGHT'S `headless` STAYS `false` while `--headless=new` does the work: `headless: true` makes
// Playwright inject its own old-headless switches, which is the SwiftShader arm.
//
// `GSW_PIXEL_HEADED=1` restores the headed launch for cross-checking the two surfaces. IT OPENS A
// REAL WINDOW ON THE USER'S DESKTOP — use it only with their consent.
//
// AND THE ADAPTER IS ASSERTED, not merely logged (`assertHardwareRenderer`). Nothing below fails on
// a software rasteriser; it would just quietly become a suite about llvmpipe.
//
// FLAGS: `--use-angle=vulkan` IS NOT `--enable-features=Vulkan`, which is still not passed — that
// one moves Chrome's whole GPU stack and blanks `drawImage(glCanvas)` on this driver, which
// `webglCompositeXvfb.test.ts` measures. Every sample here is `gl.readPixels`, which the same table
// records as correct underneath it.
//
// NOT PART OF ANY DEFAULT RUN. Gated on `GSW_CANVAS_GLYPH_PIXEL` **and** `DISPLAY`, exactly like
// `glyphPixelXvfb.test.ts` and `canvasUploadBenchXvfb.test.ts`: on any box with a display, a
// DISPLAY-only gate would make `pnpm test` launch a Chromium and sit on minutes of timeouts.
// `pnpm test:canvas-glyph-pixel` sets both; its `xvfb-run -a` is no longer containment — the default
// launch needs no display — it keeps `DISPLAY` set for that gate and gives the headed escape hatch
// somewhere to go.
//
// SKIPPED, NOT FAILED, when the vendored wasm or the fixture font is absent. `vendor/` is committed
// and should always be there; the FONT is gitignored and downloaded on demand, so a fresh checkout
// legitimately has no glyphs to draw. A red suite that means "your checkout is incomplete" trains
// people to ignore a red suite.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acutanceOf,
  registrationPx,
  rms,
} from "../../../scripts/test-support/text-image-metrics";
// TYPE-ONLY, and it must stay that way: the entry writes to `window` at module scope and imports
// emscripten glue built `-sENVIRONMENT=web,worker`, so a value import would ABORT the node process.
import type { GlyphPixelCaseResult } from "../src/canvas-glyph-pixel/browser-entry";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const glueFile = join(repoRoot, "packages", "hb-gpu", "vendor", "hb-gpu.mjs");
const wasmFile = join(repoRoot, "packages", "hb-gpu", "vendor", "hb-gpu.wasm");
// ONE FACE FOR EVERY CASE. `NotoSansSC-bench.ttf` carries ASCII, U+25A0 and 3000 Han
// (`scripts/ensure-cjk-font.ts`), which is every code point below: a solid block for the cases that
// need unambiguous ink, and unmistakably unlike Han outlines for the one that has to notice a
// glyph swapped for another.
const fontFile = join(
  repoRoot,
  "fixtures",
  "assets",
  "fonts",
  "noto-sans-sc",
  "NotoSansSC-bench.ttf",
);

const ENABLED = Boolean(
  process.env.GSW_CANVAS_GLYPH_PIXEL && process.env.DISPLAY,
);

/**
 * Chromium's launch options, windowless by default — see the header, and
 * `glyphPixelXvfb.test.ts`'s for the measured ladder the two suites share.
 *
 * `GSW_PIXEL_HEADED=1` gives back the old surface (headed, default Ozone, ANGLE over desktop GL).
 * IT PUTS A WINDOW ON THE USER'S DESKTOP: Xvfb does not contain a headed Chromium here, so that arm
 * interrupts whoever is at the machine and is to be run only with their consent.
 */
function launchOptions(): { headless: boolean; args: string[] } {
  // `headless: false` IN BOTH ARMS, deliberately. It is what stops Playwright adding its own
  // old-headless switches; `--headless=new` is what actually removes the window.
  if (process.env.GSW_PIXEL_HEADED) return { headless: false, args: [] };
  return {
    headless: false,
    args: ["--headless=new", "--enable-gpu", "--use-angle=vulkan"],
  };
}

/**
 * THE PROVENANCE GUARD ON THE WHOLE FILE: this ran on a GPU, and here is which one.
 *
 * Nothing below distinguishes a software rasteriser from a discrete one — the DPR budgets' own
 * calibration table reads 0.00 in its `correct` column on BOTH drivers, SwiftShader included. So a
 * surface that quietly fell back would keep this suite green while making every number it logs a
 * statement about llvmpipe, and any recalibration off such a run would fit budgets to software.
 *
 * AN UNREADABLE ADAPTER IS ALSO A FAILURE: `WEBGL_debug_renderer_info` is what this reads, and a
 * guard that silently no-ops is worse than none.
 */
function assertHardwareRenderer(renderer: string): void {
  if (!renderer) {
    throw new Error(
      "canvas-glyph-pixel: WEBGL_debug_renderer_info reported no adapter, so this run cannot show which renderer produced the numbers below — these budgets are calibrated against a discrete GPU",
    );
  }
  if (/swiftshader|llvmpipe/i.test(renderer)) {
    throw new Error(
      `canvas-glyph-pixel: this browser is drawing on "${renderer}", a SOFTWARE rasteriser — the suite would still pass and every measurement it logs would then describe software. Check that --headless=new --enable-gpu --use-angle=vulkan reached Chromium, or run with GSW_PIXEL_HEADED=1 (which opens a window on the user's desktop) if this box has no usable GPU under headless`,
    );
  }
}

type Rgba = [number, number, number, number];

/** Per-channel byte tolerance, and `canvasPixelXvfb.test.ts`'s number for its reason: blending
 *  happens in the framebuffer's 8-bit UNORM and the fragment quantises once on the way in, so an
 *  exact equality would be asserting a rounding mode rather than the arithmetic. */
const TOLERANCE = 3;

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/**
 * How far a DPR arm may sit from its 1x control, in px. The fidelity probe's own
 * `ALIGNMENT_TOLERANCE_PX`, restated as a literal for that constant's own stated reason: an
 * allowance calibrated for arms compared over a whole text band must not silently loosen a
 * single-run geometry check.
 *
 * MEASURED: 0.000 px on both drivers, both arms. A design/framebuffer swap reads 9.631 — the
 * correlation search's own limit, i.e. "nowhere near".
 */
const DPR_REGISTRATION_BUDGET_PX = 0.25;

/**
 * Per-pixel RMS and relative-ink budgets for a DPR arm against its 1x control.
 *
 * BIT-IDENTITY IS THE CORRECT ANSWER HERE, and it is structural rather than lucky. Both arms scale
 * by an exact power of two: `fround(2/320)` is exactly `2 * fround(2/640)`, and every pen position,
 * `pixelsPerEm` and em-box coordinate scales by the same factor exactly, so the clip coordinates
 * the vertex shader produces are the SAME float32 in both arms and `fwidth(renderCoord)` is
 * unchanged. That is why the budgets can be this tight; a non-power-of-two ratio could not use them.
 *
 * CALIBRATED BY BREAKING `u_viewport` ON PURPOSE — `drawRun` handing `setViewport` the design pair
 * where the framebuffer pair belongs — and reading every column off both drivers:
 *
 * | arm                              | correct (both drivers) | design-size u_viewport, NVIDIA | ... SwiftShader     |
 * | -------------------------------- | ---------------------- | ----------------------------- | ------------------- |
 * | dprUp    320x240 -> 640x480      | rms 0.00, ink 0.00%    | rms 0.00, ink 0.00%           | rms 0.05, ink -0.02% |
 * | dprDown  1280x960 -> 320x240     | rms 0.00, ink 0.00%    | rms 1.79, ink -0.60%          | rms 1.73, ink -0.39% |
 *
 * THE `correct` COLUMN WAS FIRST READ HEADED ON ANGLE/GL AND REPRODUCES EXACTLY ON THIS FILE'S
 * CURRENT SURFACE, headless ANGLE/Vulkan: 0.00 RMS and 0.00% ink on both arms, and 0.000 px of
 * registration. It should — the paragraph above says the two arms are the same float32 — and a
 * surface change that had perturbed a bit-identity claim would show here first. The fault columns
 * have not been re-read on the new surface; they are a wrong uniform, not a rounding mode.
 *
 * READ THE `dprUp` ROW: AN OVER-DILATION IS INVISIBLE, AND SAYING SO IS THE POINT. `hb_gpu_dilate`
 * grows the quad outward and moves the texcoord along the SAME affine map (`jac` is exactly the
 * inverse of the em-to-object linear part), so `fwidth(renderCoord)` — which is where
 * `hb_gpu_draw` gets its ppem — does not move, and the fragment computes exact coverage. Dilating
 * too far therefore only adds fragments whose coverage is zero. No metric over the drawing buffer
 * can distinguish it, and one that claimed to would be measuring driver noise. The direction that
 * IS visible is under-dilation, which clips the antialiased rim the dilation exists to protect, and
 * feeding the design size under-dilates exactly when the buffer is SMALLER than design space. That
 * is what `dprDown` is for.
 *
 * 0.5 is 3.5x below the cheapest fault and infinitely above the correct reading; 0.0015 is 2.6x
 * below the smallest ink fault. The ink column is the weaker of the two and is asserted second.
 */
const DPR_RMS_BUDGET = 0.5;
const DPR_INK_BUDGET = 0.0015;

interface Frame {
  data: Uint8Array;
  width: number;
  height: number;
}

let browser: Browser;
let page: Page;
let skipReason: string | null = null;
const results = new Map<string, GlyphPixelCaseResult>();

async function caseResult(name: string): Promise<GlyphPixelCaseResult> {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await page.evaluate(
    (caseName) => window.__gswCanvasGlyphPixel.run(caseName),
    name,
  );
  results.set(name, result);
  return result;
}

function frameOf(result: GlyphPixelCaseResult, name: string): Frame {
  const raw = result.frames[name];
  if (!raw) {
    throw new Error(
      `the page returned no frame called "${name}" (has ${Object.keys(result.frames).join(", ")})`,
    );
  }
  return {
    data: new Uint8Array(Buffer.from(raw.rgbaBase64, "base64")),
    width: raw.width,
    height: raw.height,
  };
}

function pixelAt(frame: Frame, x: number, y: number): Rgba {
  const at = (y * frame.width + x) * 4;
  return [
    frame.data[at],
    frame.data[at + 1],
    frame.data[at + 2],
    frame.data[at + 3],
  ];
}

function expectPixel(actual: Rgba, expected: Rgba, message: string): void {
  for (let channel = 0; channel < 4; channel += 1) {
    expect(
      Math.abs(actual[channel] - expected[channel]),
      `${message}: channel ${channel} was ${actual[channel]}, expected ${expected[channel]} (whole pixel ${actual.join(",")} vs ${expected.join(",")})`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

/** A premultiplied float colour as the bytes the drawing buffer should hold. */
function bytes(r: number, g: number, b: number, a: number): Rgba {
  return [
    Math.round(Math.min(1, Math.max(0, r)) * 255),
    Math.round(Math.min(1, Math.max(0, g)) * 255),
    Math.round(Math.min(1, Math.max(0, b)) * 255),
    Math.round(Math.min(1, Math.max(0, a)) * 255),
  ];
}

/**
 * The pixels a control frame claims as FULLY covered ink, as `[x, y]` pairs.
 *
 * Full coverage only, and that is what makes the assertions over it exact: a partially covered edge
 * pixel composites the glyph's colour with whatever is under it, so "this ink pixel is green" would
 * become an interval. Restricted to `rows`, so a case can ask about one half of the stage.
 */
function inkPixels(
  control: Frame,
  rows: { from: number; to: number },
): [number, number][] {
  const found: [number, number][] = [];
  for (let y = rows.from; y < Math.min(rows.to, control.height); y += 1) {
    for (let x = 0; x < control.width; x += 1) {
      if (pixelAt(control, x, y)[3] === 255) found.push([x, y]);
    }
  }
  return found;
}

/** Every pixel of `frame` at the given coordinates must be `expected`. Reports the first that is not. */
function expectEveryPixel(
  frame: Frame,
  points: readonly [number, number][],
  expected: Rgba,
  message: string,
): void {
  let worst: { at: [number, number]; pixel: Rgba; error: number } | null = null;
  for (const [x, y] of points) {
    const pixel = pixelAt(frame, x, y);
    let error = 0;
    for (let c = 0; c < 4; c += 1) {
      error = Math.max(error, Math.abs(pixel[c] - expected[c]));
    }
    if (!worst || error > worst.error) worst = { at: [x, y], pixel, error };
  }
  expect(
    worst ? worst.error : 0,
    worst
      ? `${message}: the worst of ${points.length} pixels is (${worst.at.join(",")}) = ${worst.pixel.join(",")}, expected ${expected.join(",")}`
      : message,
  ).toBeLessThanOrEqual(TOLERANCE);
}

/** Alpha as a single-channel image. The glyph runs are opaque white or a flat colour, so alpha IS
 *  the coverage the shader computed and nothing else. */
function alphaOf(frame: Frame): Uint8Array {
  const out = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < out.length; i += 1) out[i] = frame.data[i * 4 + 3];
  return out;
}

/** A window of `frame`'s alpha, for the metrics that cost O(pixels x candidate offsets). */
function cropAlpha(
  frame: Frame,
  x0: number,
  y0: number,
  width: number,
  height: number,
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = ((y + y0) * frame.width + x + x0) * 4 + 3;
      data[y * width + x] = frame.data[at];
    }
  }
  return { data, width, height };
}

function differingPixels(a: Frame, b: Frame): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * The DPR pair, measured four ways and logged before anything is asserted.
 *
 * ASSERT-THEN-MEASURE WOULD MAKE THIS UNCALIBRATABLE. The thresholds below were chosen by breaking
 * `u_viewport` on purpose and reading all four columns off a run that was going to fail anyway; a
 * guard that throws on the first bad column prints nothing about the others.
 */
interface ArmComparison {
  registration: { dx: number; dy: number; distance: number };
  error: number;
  armInk: number;
  controlInk: number;
  armAcutance: number;
  controlAcutance: number;
}

function compareArms(
  label: string,
  arm: Frame,
  control: Frame,
  window: { x: number; y: number; width: number; height: number },
): ArmComparison {
  const armCrop = cropAlpha(
    arm,
    window.x,
    window.y,
    window.width,
    window.height,
  );
  const controlCrop = cropAlpha(
    control,
    window.x,
    window.y,
    window.width,
    window.height,
  );
  const armMetrics = acutanceOf(armCrop.data, armCrop.width, armCrop.height);
  const controlMetrics = acutanceOf(
    controlCrop.data,
    controlCrop.width,
    controlCrop.height,
  );
  const registration = registrationPx(armCrop, controlCrop);
  const error = rms(armCrop.data, controlCrop.data);
  console.log(
    `canvas-glyph-pixel ${label}: registration ${registration.distance.toFixed(3)} px (dx ${registration.dx.toFixed(3)}, dy ${registration.dy.toFixed(3)}), rms ${error.toFixed(2)}, ink ${armMetrics.ink} vs ${controlMetrics.ink} (${(100 * (armMetrics.ink / controlMetrics.ink - 1)).toFixed(2)}%), acutance ${armMetrics.acutance.toFixed(4)} vs ${controlMetrics.acutance.toFixed(4)}`,
  );
  return {
    registration,
    error,
    armInk: armMetrics.ink,
    controlInk: controlMetrics.ink,
    armAcutance: armMetrics.acutance,
    controlAcutance: controlMetrics.acutance,
  };
}

/**
 * The three columns a DPR arm has to satisfy, in the order that makes a failure legible.
 *
 * INK FIRST, ALWAYS. A frame with no ink in the window has a MEANINGLESS registration rather than a
 * large one, and its RMS against a mostly-empty control is small — so both columns after it would
 * PASS on an arm that drew nothing, or drew it somewhere else entirely.
 */
function expectMatchingArms(measured: ArmComparison, subject: string): void {
  expect(
    measured.armInk,
    `${subject} has no ink where the glyphs should be — the run was placed somewhere else entirely, and every column below would read as a pass on a blank window`,
  ).toBeGreaterThan(0.5 * measured.controlInk);
  expect(
    measured.registration.distance,
    `${subject} sits ${measured.registration.distance.toFixed(3)} px from where the 1x control puts it (dx ${measured.registration.dx.toFixed(3)}, dy ${measured.registration.dy.toFixed(3)}) — the design->clip projection is not describing the same place`,
  ).toBeLessThan(DPR_REGISTRATION_BUDGET_PX);
  expect(
    measured.error,
    `RMS ${measured.error.toFixed(2)} between ${subject} and its 1x control — same outlines, same device size, same device position, so they are supposed to be the same picture`,
  ).toBeLessThan(DPR_RMS_BUDGET);
  expect(
    Math.abs(measured.armInk / measured.controlInk - 1),
    `${subject} carries ${(100 * (measured.armInk / measured.controlInk - 1)).toFixed(2)}% of the control's ink — a clipped antialiasing rim shows up here`,
  ).toBeLessThan(DPR_INK_BUDGET);
}

describe.skipIf(!ENABLED)("canvas executor glyph pixels", () => {
  beforeAll(async () => {
    if (!existsSync(glueFile) || !existsSync(wasmFile)) {
      skipReason =
        "packages/hb-gpu/vendor/hb-gpu.mjs is missing from this checkout — it is committed (see vendor/VENDOR.md); packages/hb-gpu/build.sh rebuilds it with docker + emscripten";
      return;
    }
    if (!existsSync(fontFile)) {
      skipReason =
        "the CJK fixture font is missing — run `mise exec -- pnpm -w run text:fidelity` once, or any command that calls scripts/ensure-cjk-font.ts, to download and subset it";
      return;
    }

    const bundleText = await bundleBrowserEntry();
    const wasmBinary = await readFile(wasmFile);
    const fontBytes = await readFile(fontFile);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on("pageerror", (error) => {
      console.error(
        `canvas-glyph-pixel page error: ${error.stack ?? error.message}`,
      );
    });
    await page.route("**/*", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/hb-gpu.wasm") {
        return route.fulfill({
          status: 200,
          contentType: "application/wasm",
          body: wasmBinary,
        });
      }
      if (path === "/font.ttf") {
        return route.fulfill({
          status: 200,
          contentType: "font/ttf",
          body: fontBytes,
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      });
    });
    await page.goto("http://localhost/gsw-canvas-glyph-pixel");
    await page.addScriptTag({ content: bundleText, type: "module" });
    await page.waitForFunction(
      () => "__gswCanvasGlyphPixel" in window,
      undefined,
      { timeout: 30000 },
    );

    // THE CANARY: no WebGL2 means every case below fails with an error about a null stage rather
    // than one about the renderer. It reports the adapter in the same round trip, so the guard on
    // WHICH renderer runs before a single case is measured.
    const probe = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return { webgl2: false, renderer: "" };
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        webgl2: true,
        renderer: info
          ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
          : "",
      };
    });
    if (!probe.webgl2) {
      skipReason =
        "this browser has no WebGL2 — the canvas stage cannot be created, so nothing below could measure anything";
      return;
    }
    // NO WEBGL2 IS A SKIP AND SOFTWARE IS A FAILURE, and the asymmetry is the point: the first says
    // this box cannot run the suite, the second says it ran it on the wrong thing.
    assertHardwareRenderer(probe.renderer);
    const first = await caseResult("interleave");
    console.log(
      `canvas-glyph-pixel renderer: ${first.renderer || probe.renderer} — ${first.stats.main.batches} quad batch(es) and ${first.stats.main.glyphDrawCalls} glyph draw(s) for the interleave case`,
    );
  }, 180000);

  afterAll(async () => {
    await browser?.close();
  });

  it("composites a glyph run BETWEEN the quads it sits between", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("interleave");
    const main = frameOf(result, "main");
    const control = frameOf(result, "glyphOnly");

    // Two quads that WOULD have merged into one batch, split by the run — the flush happened before
    // the pass rather than after it. (The three GL draws are two batches plus the pass's own.)
    expect(result.stats.main.batches).toBe(2);
    expect(result.stats.main.quads).toBe(2);
    expect(result.stats.main.glyphRuns).toBe(1);
    expect(result.stats.main.glyphs).toBe(1);
    expect(result.stats.main.glyphDrawCalls).toBe(1);
    expect(result.stats.main.glyphRunsDropped).toBe(0);

    const top = inkPixels(control, { from: 0, to: 64 });
    const bottom = inkPixels(control, { from: 64, to: 128 });
    // Not vacuous: the block really does straddle the midline, with a big sample on each side.
    expect(
      Math.min(top.length, bottom.length),
      `the control run covers ${top.length} pixels above the midline and ${bottom.length} below — it has to straddle it for this case to say anything`,
    ).toBeGreaterThan(1000);

    // ABOVE the second quad: the run is on top of the FIRST quad. Red here means the run was
    // emitted before it.
    expectEveryPixel(
      main,
      top,
      bytes(0, 1, 0, 1),
      "glyph ink over the first quad",
    );
    // UNDER the second quad: the run is beneath it. Green here means the run was emitted after it.
    expectEveryPixel(
      main,
      bottom,
      bytes(0, 0, 1, 1),
      "glyph ink under the second quad",
    );
    // And the first quad is still itself where the run is not.
    expectPixel(pixelAt(main, 2, 2), bytes(1, 0, 0, 1), "the first quad");
  }, 120000);

  it("lets a clip rect cut a glyph run in half", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("clipped");
    const main = frameOf(result, "main");
    const control = frameOf(result, "unclipped");

    const inside = inkPixels(control, { from: 0, to: 64 });
    const outside = inkPixels(control, { from: 64, to: 128 });
    expect(
      Math.min(inside.length, outside.length),
      `the unclipped run covers ${inside.length} pixels inside the clip and ${outside.length} outside it — it has to straddle the clip edge`,
    ).toBeGreaterThan(1000);

    expectEveryPixel(
      main,
      inside,
      bytes(1, 1, 1, 1),
      "glyph ink inside the clip",
    );
    // THE ASSERTION THE CONTRACT IS FOR. The pass is forbidden to touch `SCISSOR_TEST` or the
    // scissor box, and the executor deliberately does not restore them afterwards, so this is the
    // only place the arrangement is observable. A clip on the TOP half also puts the scissor's Y
    // flip under the run: flipped the wrong way, the two expectations above simply swap and each
    // one on its own would still be satisfiable.
    expectEveryPixel(
      main,
      outside,
      TRANSPARENT,
      "glyph ink outside the clip, which must not have been drawn",
    );
  }, 120000);

  it("draws the quad AFTER a run with its own blend, not the one the pass left set", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("blendAfterPass");
    const main = frameOf(result, "main");

    const beforePass = pixelAt(main, 32, 24);
    const afterPass = pixelAt(main, 96, 24);
    // MUL over an opaque white background: `dst * src` with no additive term, and a separate alpha
    // so coverage multiplies too.
    const mul = bytes(0.25, 0.25, 0.25, 0.5);
    // What hb-gpu leaves set — premultiplied MIX — would give `src + dst*(1 - src.a)` instead.
    const mixLeftover = bytes(0.75, 0.75, 0.75, 1);
    // And a quad that never drew at all (the executor's VAO left unbound by the pass) leaves the
    // background's own white.
    const notDrawn = bytes(1, 1, 1, 1);

    expectPixel(beforePass, mul, "the MUL quad BEFORE the run");
    expectPixel(afterPass, mul, "the MUL quad AFTER the run");
    expect(
      Math.abs(afterPass[0] - mixLeftover[0]),
      `red ${afterPass[0]} matches the MIX-LEFTOVER signature ${mixLeftover[0]}: the executor's blend cache was not invalidated, so this quad inherited hb-gpu's non-separate blendFunc`,
    ).toBeGreaterThan(TOLERANCE);
    expect(
      Math.abs(afterPass[0] - notDrawn[0]),
      `red ${afterPass[0]} is the untouched background ${notDrawn[0]}: the quad after the run drew nothing, which is what an un-restored VAO looks like`,
    ).toBeGreaterThan(TOLERANCE);
    // The supporting counter: MIX at the top of the frame, MUL for the first quad, MUL again
    // because the run invalidated the cache. Two would mean the third call never happened.
    expect(result.stats.main.blendChanges).toBe(3);
    expect(result.stats.main.glyphRuns).toBe(1);
  }, 120000);

  it("puts PREMULTIPLIED coverage in the buffer through the glyph path", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("premultiplied");
    const main = frameOf(result, "main");

    let partial = 0;
    let worst = 0;
    let worstAt: Rgba = TRANSPARENT;
    for (let i = 0; i < main.data.length; i += 4) {
      const a = main.data[i + 3];
      if (a === 0 || a === 255) continue;
      partial += 1;
      const error = Math.max(
        Math.abs(main.data[i] - a),
        Math.abs(main.data[i + 1] - a),
        Math.abs(main.data[i + 2] - a),
      );
      if (error > worst) {
        worst = error;
        worstAt = [
          main.data[i],
          main.data[i + 1],
          main.data[i + 2],
          main.data[i + 3],
        ];
      }
    }
    expect(
      partial,
      "no partially covered pixel in the frame — an antialiased glyph must have edge pixels, so this case cannot tell premultiplied from straight",
    ).toBeGreaterThan(200);
    // An OPAQUE WHITE run: premultiplied, every channel must equal alpha. A path that wrote STRAIGHT
    // colour would hold 255 at every covered pixel whatever its coverage — which composites
    // correctly over black and blows out over anything else, and is invisible in a screenshot of a
    // dark page. `2` is the sibling's number: the fragment quantises once on the way in.
    expect(
      worst,
      `a partially covered pixel is ${worstAt.join(",")} — ${worst} levels between colour and alpha, so the glyph path is writing STRAIGHT colour under a premultiplied blend`,
    ).toBeLessThanOrEqual(2);
  }, 120000);

  it("draws a 2x-DPR run at the same device size and place as a 1x one", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    // A 320x240 design space in a 640x480 drawing buffer, against the SAME glyphs drawn at the same
    // device size out of a 640x480 design space at ratio 1. What this arm catches is the
    // PROJECTION half of the two-numbers contract: `toClip` is built from the DESIGN pair, and
    // handed the framebuffer pair instead the run lands at twice the scale, off the window
    // entirely. What it does NOT catch — measured, not assumed — is the DILATION half; see
    // {@link DPR_RMS_BUDGET} for why an over-dilation cannot change a pixel, and `dprDown` for the
    // arm that does catch it.
    const result = await caseResult("dprUp");
    const twoX = frameOf(result, "twoX");
    const oneX = frameOf(result, "oneX");
    expect([twoX.width, twoX.height]).toEqual([640, 480]);
    expect([oneX.width, oneX.height]).toEqual([640, 480]);

    // The window the three glyphs land in, in device pixels.
    const measured = compareArms("dprUp", twoX, oneX, {
      x: 96,
      y: 208,
      width: 256,
      height: 96,
    });
    expectMatchingArms(measured, "the 2x frame");
  }, 180000);

  it("dilates against the FRAMEBUFFER when the buffer is smaller than design space", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    // THE ARM IN WHICH A WRONG `u_viewport` IS VISIBLE, and the reason it sits next to `dprUp`
    // rather than instead of it. `hb_gpu_dilate` grows the quad outward so the outline's
    // antialiased rim is not clipped by the quad's own edge, and the fragment then computes exact
    // coverage inside it — so an over-dilation only adds fragments whose coverage is zero and
    // changes no byte. Under-dilation clips the rim, and feeding the design size to `u_viewport`
    // under-dilates exactly when the drawing buffer is SMALLER than design space. A 1280x960 scene
    // in a 320x240 buffer is a scene drawn at quarter size, and it makes the same mistake bite.
    const result = await caseResult("dprDown");
    const quarterX = frameOf(result, "quarterX");
    const oneX = frameOf(result, "oneX");
    expect([quarterX.width, quarterX.height]).toEqual([320, 240]);
    expect([oneX.width, oneX.height]).toEqual([320, 240]);

    const measured = compareArms("dprDown", quarterX, oneX, {
      x: 48,
      y: 104,
      width: 128,
      height: 48,
    });
    expectMatchingArms(measured, "the 1/4x frame");
  }, 180000);

  it("re-uploads an evicted slot and draws the RIGHT outline", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("eviction");
    const small = frameOf(result, "small");
    const big = frameOf(result, "big");

    // The atlas really did wrap, and the run's own glyphs really were gone by draw time.
    expect(result.stats.small.atlasEvictions).toBeGreaterThan(0);
    expect(result.stats.small.passReuploads).toBe(4);
    expect(result.stats.small.glyphs).toBe(4);
    // The control did NOT evict, so "same picture" is a comparison against a clean render.
    expect(result.stats.big.atlasEvictions).toBe(0);
    expect(result.stats.big.passReuploads).toBe(0);
    expect(result.stats.big.glyphs).toBe(4);
    // Nothing was dropped or skipped: a hole in a word would make the comparison below fail for a
    // reason that has nothing to do with which outline was drawn.
    expect(result.stats.small.passDropped).toBe(0);
    expect(result.stats.small.atlasStaleSkips).toBe(0);
    // And the margin the in-use guard needs: at draw time the ring must hold at least as many
    // allocations as the run has glyphs, or a re-upload would have to overwrite a glyph this frame
    // already drew.
    expect(result.notes.residentBeforeRun).toBeGreaterThanOrEqual(4);

    const ink = acutanceOf(alphaOf(big), big.width, big.height);
    expect(
      ink.ink,
      "the control frame has no ink — a blank pair of frames would match perfectly and prove nothing",
    ).toBeGreaterThan(10000);
    // THE ASSERTION THIS CASE EXISTS FOR. A stale offset, a `texSubImage2D` at the wrong place, or
    // a draw ordered ahead of the re-upload all produce a DIFFERENT glyph's outline at the right
    // size, in the right place, perfectly antialiased. Nothing but the pixels can tell.
    const differing = differingPixels(small, big);
    expect(
      differing,
      `${differing} of ${small.width * small.height} pixels differ between the evicting render and the clean one — the re-uploaded glyphs are not the glyphs that were asked for`,
    ).toBe(0);
  }, 180000);

  it("draws nothing, disturbs nothing and counts the run when no pass is installed", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("missingPass");
    const noPass = frameOf(result, "noPass");
    const withPass = frameOf(result, "withPass");
    const quadsOnly = frameOf(result, "quadsOnly");

    expect(result.stats.noPass.glyphRunsDropped).toBe(1);
    expect(result.stats.noPass.glyphRuns).toBe(0);
    expect(result.stats.noPass.glyphs).toBe(0);
    // And it does NOT break the batch: with nothing drawn and no GL state moved, flushing here
    // would cost a draw call to accomplish nothing.
    expect(result.stats.noPass.batches).toBe(1);
    expect(result.stats.quadsOnly.batches).toBe(1);

    // The quads either side are untouched, to the byte.
    expect(
      differingPixels(noPass, quadsOnly),
      "the frame with an undrawable glyph run differs from the same two quads with no run at all — the missing pass disturbed the drawing around it",
    ).toBe(0);
    // ...and that equality is not vacuous: with a pass installed, the same list paints a lot of
    // pixels that this one does not.
    const wouldHaveDrawn = differingPixels(noPass, withPass);
    expect(
      wouldHaveDrawn,
      "the run draws nothing even WITH a pass installed, so proving it draws nothing without one says nothing",
    ).toBeGreaterThan(1000);
  }, 180000);

  it("carries a run's spread through the draw list and dilates by it", async (ctx) => {
    if (skipReason) return ctx.skip(skipReason);
    const result = await caseResult("outlined");
    const spreadPx = result.notes.spreadPx;
    const plain = frameOf(result, "plain");
    const spread = frameOf(result, "spread");
    const overlay = frameOf(result, "overlay");

    // A solid block, so the ink box is exact and the growth is a whole number.
    const inkBox = (frame: Frame) => {
      const alpha = alphaOf(frame);
      let x0 = frame.width;
      let y0 = frame.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          if (alpha[y * frame.width + x] < 128) continue;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
      return { x0, y0, x1, y1 };
    };
    const plainBox = inkBox(plain);
    const spreadBox = inkBox(spread);
    const growth = {
      left: plainBox.x0 - spreadBox.x0,
      top: plainBox.y0 - spreadBox.y0,
      right: spreadBox.x1 - plainBox.x1,
      bottom: spreadBox.y1 - plainBox.y1,
    };

    // Two `glyphs` commands in the overlay frame, so the outline really is a separate run and the
    // executor dispatched both.
    const plainAlpha = alphaOf(plain);
    let solid = 0;
    let worst = 0;
    let outlineBand = 0;
    for (let i = 0; i < plainAlpha.length; i += 1) {
      if (plainAlpha[i] >= 250) {
        solid += 1;
        for (let c = 0; c < 4; c += 1) {
          worst = Math.max(
            worst,
            Math.abs(overlay.data[i * 4 + c] - plain.data[i * 4 + c]),
          );
        }
      } else if (plainAlpha[i] === 0 && overlay.data[i * 4] > 8) {
        outlineBand += 1;
      }
    }
    console.log(
      `canvas-glyph-pixel outlined: spread ${spreadPx} px, ink box grew L${growth.left} T${growth.top} R${growth.right} B${growth.bottom}; overlay ran ${result.stats.overlay.glyphRuns} runs / ${result.stats.overlay.glyphDrawCalls} glyph draws; ${solid} solid fill pixels, worst channel error ${worst}; ${outlineBand} red pixels outside the fill`,
    );

    expect(result.stats.spread.glyphRuns).toBe(1);
    expect(result.stats.overlay.glyphRuns).toBe(2);
    expect(result.stats.overlay.glyphDrawCalls).toBe(2);

    expect(
      solid,
      "the plain block has no fully covered pixels — every comparison below is over an empty set",
    ).toBeGreaterThan(1000);
    // THE SEAM UNDER TEST. `spreadPx` is a float in a packed arena that `pushGlyphs` writes and
    // `readGlyphs` reads back at an offset both derive from one header stride; a growth of 0 here
    // means it never reached the shader, whatever the shader does when it is told.
    //
    // MEASURED on headless ANGLE/Vulkan at spread 6: L6 T6 R6 B7, i.e. the bottom edge sits exactly
    // ON the allowance and the other three are exact. `boxOf(atLeast(…, 128))` is a threshold in the
    // middle of a one-pixel-wide antialiased boundary, so one edge landing a pixel out is the
    // quantisation and not a spread that arrived wrong — the failure this loop exists for is a
    // growth of 0, which is six pixels away. Recorded rather than tightened: a budget of 0 here
    // would be a budget on which side of 128 one row of pixels falls.
    for (const [side, moved] of Object.entries(growth)) {
      expect(
        Math.abs(moved - spreadPx),
        `the block's ${side} edge moved ${moved} px for a recorded spread of ${spreadPx} — 0 means the draw list dropped it between pushGlyphs and readGlyphs`,
      ).toBeLessThanOrEqual(1);
    }
    // NOT VACUOUS: the outline run really did paint outside the fill.
    expect(
      outlineBand,
      "no red pixel anywhere outside the fill — the dilated run under it drew nothing",
    ).toBeGreaterThan(500);
    // OUTLINE UNDER FILL. An opaque fill covers every pixel a dilation and a centred stroke
    // disagree about, so the fill's own pixels must be exactly what the fill alone puts there.
    expect(
      worst,
      `a fully covered fill pixel is ${worst} levels from what the fill alone puts there — the dilated run under it is showing through`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }, 180000);
});

/** esbuild on the parity suite's recipe: `conditions: ["development"]` is what makes
 *  `@godot-scene-web/canvas` and `@godot-scene-web/hb-gpu` resolve to their TypeScript SOURCE, so
 *  the page runs the code under review rather than a `dist/` that may not be built. */
async function bundleBrowserEntry(): Promise<string> {
  const entry = join(
    here,
    "..",
    "src",
    "canvas-glyph-pixel",
    "browser-entry.ts",
  );
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
    conditions: ["development"],
    write: false,
    sourcemap: "inline",
    absWorkingDir: join(here, ".."),
    logLevel: "silent",
  });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error(
      "canvas-glyph-pixel: esbuild produced no output for the browser entry",
    );
  }
  return file.text;
}
