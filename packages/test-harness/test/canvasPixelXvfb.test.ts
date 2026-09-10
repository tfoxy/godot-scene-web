// @vitest-environment node
//
// NODE, not the repo-default jsdom: esbuild refuses to run under jsdom's globals
// (see `webgpuParityBrowser.test.ts`'s header), and the DOM under test is a real
// Chromium's anyway.
//
// PIXELS OUT OF `@godot-scene-web/canvas`'s WebGL2 EXECUTOR, on a real GPU.
//
// The executor's own suite runs against a recording stand-in for the context. It
// proves how many draws a frame took, in what order the state around them was
// set, and which textures each one bound — and it is blind to everything that
// happens after the call returns. This file covers exactly that blind spot, and
// every case below corresponds to one thing that is a single number in a shader
// or a single boolean in a GL call, and that is SILENT when wrong:
//
//   opaque        geometry, projection, viewport, clear
//   blendMix/Add/Sub/Mul   the four blend states, as arithmetic rather than as enum names
//   tint          the premultiplied tint really is `rgb*a` in the buffer
//   colorMatrix   the matrix reaches the fragment un-transposed AND sees straight colour
//   nestedClips   scissor intersection
//   topClip       the FLIPPED scissor origin, isolated
//   roundedClip   the rounded-rect discard
//   ninePatch     the band algebra, on screen
//   flipped       a negative source span mirrors the sprite
//   patchedColor  a colour PATCHED into an already-executed list repaints, and
//                 lands premultiplied
//   polyline      a stroke reaches the framebuffer through the shared quad path
//   fxCanvasSource[Add]   a straight-alpha 2D canvas becomes a premultiplied texel,
//                 through the `texSubImage2D` re-upload path, under MIX and ADD
//
// WHAT IS SAMPLED. `gl.readPixels` on the stage's own drawing buffer, which holds
// PREMULTIPLIED bytes by the package's contract — so the expectations below are
// premultiplied numbers, not what a compositor would show over a page. The
// canvas->page composite is a separate question and `webglCompositeXvfb.test.ts`
// already owns it for the WebGL path.
//
// FLAGS: none, for `webglCompositeXvfb.test.ts`'s measured reason —
// `--enable-features=Vulkan` breaks WebGL canvases on this box.
//
// HEADED by default, and not for the sibling's reason. Nothing about the page
// COMPOSITOR is under test here (the assertions read the drawing buffer directly),
// so `GSW_CANVAS_PIXEL_HEADLESS=1` opts into a headless run when a display is not
// available. The default remains headed because it runs on the same renderer as
// the application. Measured on this box, under the same Xvfb:
//
//   headless   ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)
//   headed     ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 2060/PCIe/SSE2, OpenGL ES 3.2)
//
// Every case below passes on BOTH, which is a useful thing to know — but blend
// equations, scissor rounding and `discard` are exactly where a real driver and a
// software rasterizer are entitled to differ, so the run that means more is the
// one on the driver users have. A box with no GPU still gets SwiftShader and the
// suite still measures the arithmetic; the `renderer` in the log says which was
// used.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// TYPE-ONLY, and it must stay that way: the entry writes to `window` at module
// scope, so a value import would run the page half inside vitest's node process.
import type { PixelCaseResult } from "../src/canvas-pixel/browser-entry";
// A VALUE import, and allowed to be: `./fx-source` is the shared colour statement
// with nothing else in it, precisely so the constants both halves need can be read
// here without dragging the page module in.
import {
  FX_SOURCE_STRAIGHT,
  premultipliedFxSource,
} from "../src/canvas-pixel/fx-source";

const here = dirname(fileURLToPath(import.meta.url));

type Rgba = [number, number, number, number];

/** Per-channel byte tolerance. Blending happens in the framebuffer's 8-bit
 *  UNORM, and the fragment quantises once on the way in, so an exact equality
 *  would be asserting a rounding mode rather than the arithmetic. */
const TOLERANCE = 3;

const headless = process.env.GSW_CANVAS_PIXEL_HEADLESS === "1";

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** A premultiplied float colour as the bytes the drawing buffer should hold. */
function bytes(r: number, g: number, b: number, a: number): Rgba {
  return [
    Math.round(Math.min(1, Math.max(0, r)) * 255),
    Math.round(Math.min(1, Math.max(0, g)) * 255),
    Math.round(Math.min(1, Math.max(0, b)) * 255),
    Math.round(Math.min(1, Math.max(0, a)) * 255),
  ];
}

let browser: Browser;
let bundleText: string;
let page: Page;
let skipReason: string | null = null;
const results = new Map<string, PixelCaseResult>();

async function caseResult(name: string): Promise<PixelCaseResult> {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await page.evaluate(
    (caseName) => window.__gswCanvasPixel.run(caseName),
    name,
  );
  results.set(name, result);
  return result;
}

function expectPixel(actual: Rgba, expected: Rgba, message: string): void {
  for (let channel = 0; channel < 4; channel += 1) {
    expect(
      Math.abs(actual[channel] - expected[channel]),
      `${message}: channel ${channel} was ${actual[channel]}, expected ${expected[channel]} (whole pixel ${actual.join(",")} vs ${expected.join(",")})`,
    ).toBeLessThanOrEqual(TOLERANCE);
  }
}

describe.skipIf(!headless && !process.env.DISPLAY)(
  "canvas executor pixels",
  () => {
    beforeAll(async () => {
      bundleText = await bundleBrowserEntry();
      browser = await chromium.launch({ headless, args: [] });
      page = await browser.newPage({ viewport: { width: 400, height: 300 } });
      page.on("pageerror", (error) => {
        console.error(
          `canvas-pixel page error: ${error.stack ?? error.message}`,
        );
      });
      await page.route("**/*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body></body></html>",
        }),
      );
      await page.goto("http://localhost/gsw-canvas-pixel");
      await page.addScriptTag({ content: bundleText, type: "module" });
      await page.waitForFunction(
        () => "__gswCanvasPixel" in window,
        undefined,
        {
          timeout: 15000,
        },
      );

      // THE CANARY: can this browser give the stage a WebGL2 context at all? A
      // context-less run would fail every case below with an error that says
      // nothing about the renderer.
      const probe = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        return canvas.getContext("webgl2") ? "ok" : "no webgl2";
      });
      if (probe !== "ok") {
        skipReason = `this browser has no WebGL2 (${probe}) — the canvas stage cannot be created, so nothing below could measure anything`;
        return;
      }
      const first = await caseResult("opaque");
      console.log(
        `canvas-pixel renderer: ${first.renderer || "(masked)"} — ${first.draws} draw(s) for the opaque case`,
      );
    }, 180000);

    afterAll(async () => {
      await browser?.close();
    });

    it("draws an opaque tinted quad where the transform puts it", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws } = await caseResult("opaque");
      expect(draws).toBe(1);
      expectPixel(samples.inside, bytes(0.2, 0.4, 0.6, 1), "inside the quad");
      expectPixel(samples.outside, TRANSPARENT, "outside the quad");
      expectPixel(samples.belowQuad, TRANSPARENT, "below the quad");
    }, 60000);

    it("composites MIX as src + dst*(1 - src.a) on premultiplied colour", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("blendMix");
      // Landing on `0.5*0.5 + …` instead would mean the fragment writes STRAIGHT
      // colour under a premultiplied blend, i.e. a colour multiplied by alpha twice.
      expectPixel(
        samples.centre,
        bytes(0.5 + 0.2 * 0.5, 0.5 + 0.4 * 0.5, 0.5 + 0.6 * 0.5, 1),
        "MIX over an opaque background",
      );
    }, 60000);

    it("composites ADD as src + dst, on colour AND coverage", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("blendAdd");
      expectPixel(
        samples.centre,
        bytes(0.5 + 0.2, 0.25 + 0.4, 0.1 + 0.6, 1),
        "ADD over an opaque background",
      );
    }, 60000);

    it("composites SUB as dst - src, leaving coverage ADDITIVE", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("blendSub");
      // Alpha is 1 + 0.5 clamped back to 1. A reverse-subtract on alpha as well
      // would give 0.5 here — the sprite would punch a hole in the scene rather
      // than darken it, which is why the alpha equation is pinned separately.
      expectPixel(
        samples.centre,
        bytes(0.8 - 0.25, 0.6 - 0.25, 0.4 - 0.25, 1),
        "SUB over an opaque background",
      );
    }, 60000);

    it("composites MUL as dst * src with no additive term", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("blendMul");
      expectPixel(
        samples.centre,
        bytes(0.8 * 0.5, 0.6 * 0.5, 0.4 * 0.5, 1 * 0.5),
        "MUL over an opaque background",
      );
    }, 60000);

    it("puts a PREMULTIPLIED tint in the buffer, not a straight one", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("tint");
      // The draw-list's tint is already `rgb*a`, so the buffer holds it verbatim.
      // A shader that multiplied by alpha again would read (0.2, 0.1, 0.05, 0.5).
      expectPixel(
        samples.centre,
        bytes(0.4, 0.2, 0.1, 0.5),
        "a half-alpha tint",
      );
    }, 60000);

    it("applies the colour matrix to STRAIGHT colour, un-transposed", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("colorMatrix");
      // The source texel is HALF-ALPHA red, i.e. (128, 0, 0, 128) premultiplied on
      // the GPU. Straight, that is pure red; the matrix's first ROW is (0, 0, 1)
      // and its second is (1, 0, 0), so red -> green. Re-premultiplied it is
      // (0, 0.5, 0, 0.5), and the quad's own half-alpha tint halves it again.
      const texelAlpha = 128 / 255;
      const correct = bytes(0, texelAlpha * 0.5, 0, texelAlpha * 0.5);
      // The two failures this case exists to name, both of which produce a
      // perfectly plausible picture:
      //   - the matrix applied to the PREMULTIPLIED channels, which transforms a
      //     half-transparent pixel as if it were half as bright (green halves,
      //     alpha does not);
      //   - a TRANSPOSED upload, which reads the same nine floats by columns and
      //     sends red to BLUE.
      const premultipliedMatrix = bytes(
        0,
        texelAlpha * texelAlpha * 0.5,
        0,
        texelAlpha * 0.5,
      );
      const transposed = bytes(0, 0, texelAlpha * 0.5, texelAlpha * 0.5);
      expect(
        Math.abs(correct[1] - premultipliedMatrix[1]),
        "the correct result and the premultiplied-matrix signature are within tolerance of each other — this case cannot tell them apart",
      ).toBeGreaterThan(2 * TOLERANCE);

      expectPixel(samples.centre, correct, "an HSV-style colour matrix");
      expect(
        Math.abs(samples.centre[1] - premultipliedMatrix[1]),
        `green channel ${samples.centre[1]} matches the PREMULTIPLIED-MATRIX signature ${premultipliedMatrix[1]}: the fragment is transforming rgb*a instead of un-premultiplying first`,
      ).toBeGreaterThan(TOLERANCE);
      expect(
        Math.abs(samples.centre[2] - transposed[2]),
        `blue channel ${samples.centre[2]} matches the TRANSPOSED signature ${transposed[2]}: the row-major matrix reached GLSL as its own transpose`,
      ).toBeGreaterThan(TOLERANCE);
    }, 60000);

    it("clips to the INTERSECTION of nested scopes", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("nestedClips");
      expectPixel(samples.intersection, bytes(1, 1, 1, 1), "inside both clips");
      expectPixel(samples.outerOnly, TRANSPARENT, "inside the outer clip only");
      expectPixel(samples.innerOnly, TRANSPARENT, "inside the inner clip only");
      expectPixel(samples.neither, TRANSPARENT, "outside both clips");
    }, 60000);

    it("puts a TOP-of-screen clip at the top of the screen", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      // The Y flip, isolated. A missing one produces a clip of exactly the right
      // size in the mirrored half — which reads as a layout bug, not a scissor bug.
      const { samples } = await caseResult("topClip");
      expectPixel(samples.top, bytes(1, 1, 1, 1), "inside a top-quarter clip");
      expectPixel(samples.bottom, TRANSPARENT, "below a top-quarter clip");
    }, 60000);

    it("discards the corners of a rounded clip and keeps the edges", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("roundedClip");
      expectPixel(
        samples.centre,
        bytes(1, 1, 1, 1),
        "the middle of a rounded clip",
      );
      expectPixel(samples.edge, bytes(1, 1, 1, 1), "an edge midpoint");
      expectPixel(samples.corner, TRANSPARENT, "a discarded corner");
      expectPixel(samples.farCorner, TRANSPARENT, "the opposite corner");
    }, 60000);

    it("lands every nine-patch band on the block it samples", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws, quads } = await caseResult("ninePatch");
      // Nine bands, ONE draw call.
      expect(draws).toBe(1);
      expect(quads).toBe(9);
      const [red, green, blue, yellow, magenta, cyan, maroon, forest, navy] = [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 255],
        [255, 0, 255, 255],
        [0, 255, 255, 255],
        [128, 0, 0, 255],
        [0, 128, 0, 255],
        [0, 0, 128, 255],
      ] as Rgba[];
      expectPixel(samples.topLeft, red, "the top-left corner band");
      expectPixel(samples.topEdge, green, "the stretched top edge");
      expectPixel(samples.topRight, blue, "the top-right corner band");
      expectPixel(samples.leftEdge, yellow, "the stretched left edge");
      expectPixel(samples.centre, magenta, "the doubly stretched centre");
      expectPixel(samples.rightEdge, cyan, "the stretched right edge");
      expectPixel(samples.bottomLeft, maroon, "the bottom-left corner band");
      expectPixel(samples.bottomEdge, forest, "the stretched bottom edge");
      expectPixel(samples.bottomRight, navy, "the bottom-right corner band");
    }, 60000);

    it("mirrors a flipped sprite", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("flipped");
      // The page's top row is red, green, blue left to right; flipped it must read
      // blue, green, red.
      expectPixel(
        samples.left,
        [0, 0, 255, 255],
        "the flipped sprite's left third",
      );
      expectPixel(samples.middle, [0, 255, 0, 255], "its middle third");
      expectPixel(samples.right, [255, 0, 0, 255], "its right third");
    }, 60000);

    it("premultiplies a straight-alpha 2D canvas on the way into a texture", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, textureUploads, textureRespecs } =
        await caseResult("fxCanvasSource");
      // Exactly one upload went in over storage that was already there — the case
      // paints a decoy frame first and the real one second, at the same size.
      expect(textureUploads - textureRespecs).toBe(1);
      // The source is STRAIGHT (255, 0, 102, 128); the buffer must hold `rgb*a`.
      expectPixel(
        samples.centre,
        premultipliedFxSource(),
        "a straight-alpha canvas uploaded as a stage texture",
      );
      // The two ways this goes wrong, both of which draw a perfectly plausible
      // picture. Named separately because the tolerance alone would not say which.
      const [r, g, , a] = FX_SOURCE_STRAIGHT;
      expect(
        Math.abs(samples.centre[0] - r),
        `red ${samples.centre[0]} matches the STRAIGHT source byte ${r}: the upload did not premultiply, so a translucent effect composites at full brightness`,
      ).toBeGreaterThan(TOLERANCE);
      const doubled = Math.round((((r * a) / 255) * a) / 255);
      expect(
        Math.abs(samples.centre[0] - doubled),
        `red ${samples.centre[0]} matches the DOUBLE-premultiplied value ${doubled}: alpha was applied both by the upload and by the fragment`,
      ).toBeGreaterThan(TOLERANCE);
      expect([samples.centre[1], samples.centre[3]]).toEqual([g, a]);
    }, 60000);

    it("adds a canvas-sourced quad by its own coverage", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples } = await caseResult("fxCanvasSourceAdd");
      // ADD over an opaque quarter-grey background. Premultiplied, the source
      // contributes `rgb*a`; a straight texel would add its FULL colour whatever
      // its coverage — which is exactly how an additive shader composited out of
      // its own canvas blows out.
      const [pr, pg, pb] = premultipliedFxSource();
      const background = Math.round(0.25 * 255);
      expectPixel(
        samples.centre,
        [
          Math.min(255, pr + background),
          Math.min(255, pg + background),
          Math.min(255, pb + background),
          255,
        ],
        "an additive canvas-sourced quad",
      );
    }, 60000);

    it("paints a transformed direct particle into the canvas framebuffer", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws, quads } = await caseResult("directParticle");
      // It is an external pass, not a follow-up texture composite: the canvas
      // executor has no quads or batches to account for in this case.
      expect(draws).toBe(0);
      expect(quads).toBe(0);
      expectPixel(
        samples.centre,
        bytes(1, 1, 1, 1),
        "the translated particle centre",
      );
      expectPixel(samples.outside, TRANSPARENT, "outside the direct particle");
    }, 60000);

    it("adds a clipped direct particle into the already-painted framebuffer", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws, quads } = await caseResult(
        "directAdditiveParticle",
      );
      // The background is one executor quad; the particle itself is a direct
      // pass and needs no texture-composite quad or per-system surface.
      expect(draws).toBe(1);
      expect(quads).toBe(1);
      expectPixel(
        samples.centre,
        bytes(0.3, 0.3, 0.35, 1),
        "additive light over the existing background",
      );
      expectPixel(
        samples.clippedOutside,
        bytes(0.1, 0.2, 0.3, 1),
        "the active executor clip outside the direct pass",
      );
      expectPixel(
        samples.background,
        bytes(0.1, 0.2, 0.3, 1),
        "background untouched away from the particle",
      );
    }, 60000);

    it("repaints a patched colour, premultiplied, over a frame already drawn", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws } = await caseResult("patchedColor");
      expect(draws).toBe(1);
      // The buffer was cleared by the second execute, so what is left is the
      // patched premultiplied colour verbatim.
      expectPixel(
        samples.centre,
        bytes(0.2, 0.3, 0.4, 0.5),
        "a quad whose colour was patched in place",
      );
      // The two ways this goes wrong, named separately because the tolerance alone
      // would not say which: the executor served a cached instance from the first
      // execute, or the patched floats were treated as straight colour.
      expect(
        Math.abs(samples.centre[0] - bytes(0.8, 0, 0, 1)[0]),
        `red ${samples.centre[0]} is still the PRE-PATCH value: the executor repainted a cached instance instead of re-reading the list`,
      ).toBeGreaterThan(TOLERANCE);
      expect(
        Math.abs(samples.centre[0] - bytes(0.2 * 0.5, 0, 0, 1)[0]),
        `red ${samples.centre[0]} matches a SECOND premultiply of the patched tint: the patch path multiplies by alpha that the caller already applied`,
      ).toBeGreaterThan(TOLERANCE);
    }, 60000);

    it("draws a polyline through the shared quad path", async (ctx) => {
      if (skipReason) return ctx.skip(skipReason);
      const { samples, draws } = await caseResult("polyline");
      expect(draws).toBe(1);
      expectPixel(samples.onLine, [0, 255, 0, 255], "the middle of the stroke");
      expectPixel(samples.aboveLine, TRANSPARENT, "well above the stroke");
      expectPixel(samples.pastEnd, TRANSPARENT, "past the stroke's butt cap");
    }, 60000);
  },
);

/** esbuild on the parity suite's recipe: `conditions: ["development"]` is what
 *  makes `@godot-scene-web/canvas` resolve to its TypeScript SOURCE, so the page
 *  runs the code under review rather than a `dist/` that may not be built. */
async function bundleBrowserEntry(): Promise<string> {
  const entry = join(here, "..", "src", "canvas-pixel", "browser-entry.ts");
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
    throw new Error("canvas-pixel: esbuild produced no output for the entry");
  }
  return file.text;
}
