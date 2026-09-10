// @vitest-environment node
//
// NODE, not the repo-default jsdom, for the same reason as `webgpuParityBrowser.test.ts`: esbuild
// refuses to run under jsdom's globals, and the DOM under test is a real Chromium's anyway.
//
// THE FROZEN-SURFACE IMAGE SWAP, MEASURED AS PIXELS — the one test of what that mechanism actually
// PUTS ON THE PAGE on a WebGPU binding.
//
// WHAT IS UNDER TEST, and why nothing else covers it. On a WebGPU surface the swap cannot read the
// canvas (blank headless, pathological on Android — the S7 law), so it publishes its `<img>` through
// a chain that exists nowhere else in the product: an offscreen rgba8unorm re-render →
// `copyTextureToBuffer` readback → UNPREMULTIPLY → `putImageData` → PNG `toBlob` → `<img>` decode →
// the compositor's own re-premultiply. Every link of that is exercised by node tests as a contract
// ("was the hook called?", "did the counters move?"), and NONE of them can answer the only question
// that matters to a user: does the image the swap leaves behind look like the frame it replaced?
//
// HOW IT ANSWERS IT. One page, one binding, mounted frozen with the swap ARMED. Once
// `staticImagesLive` says the `<img>` is up, the page decodes that image into a 2D canvas and reads
// it back, and — from the SAME live binding, so the two are the same frame by construction — reads
// the renderer's own frozen frame through `captureNodePixels`. The two are compared in PREMULTIPLIED
// space, because the renderer side has no straight-alpha form and dividing it back out would divide
// by zero over the transparent majority of a particle canvas.
//
// WHY THE COMPARISON IS NOT EXACT, and what the budget is made of. Two roundings compose: the
// unpremultiply on the way out and the re-premultiply on the way back, each of which can move a
// channel by one. `webgpu-still-capture.test.ts` proves that bound arithmetically over the whole
// (c, a) grid; here it is measured end to end through a real PNG codec and a real decoder, which is
// the only place the assumption "PNG is lossless and the decode is exact" is actually checked.
//
// IT REFUSES TO PASS VACUOUSLY, like its sibling: a WebGL-fallback run would be comparing a canvas
// against a PNG of that same canvas and would pass while testing none of the chain above, so the
// renderer, the capture path and the binding stamp are all asserted before any pixel is compared.
//
// A SEPARATE FILE rather than a describe inside `webgpuParityBrowser.test.ts`: that suite is a
// cross-BACKEND comparison and this one is a cross-REPRESENTATION comparison on one backend, and
// they fail for entirely different reasons.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareRgbaBuffers } from "../src/image-diff";
import {
  PARITY_FIXTURES,
  type ParityFixture,
} from "../src/webgpu-parity/fixtures";
import { base64ToBytes } from "../src/webgpu-parity/pixels";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
/** `artifacts/` is gitignored — every image this writes stays local. */
const artifactRoot = join(repoRoot, "artifacts", "webgpu-swap-parity");

/**
 * The fixtures this runs, one per mechanism — the swap is a property of the SURFACE, not of the
 * fixture, so a wide sweep would re-measure one code path a dozen times at ~4 s each.
 *
 * `textured` is the particle case with real soft alpha (the interesting half of the round trip: the
 * premultiplied↔straight conversion is the identity at alpha 0 and 255, and everything the budget is
 * about happens in between). `shader-wave` is the shader case, and it takes the OTHER gate — the
 * content key over the reconcile clock rather than a quiet window.
 */
const SWAP_FIXTURE_NAMES = ["textured", "shader-wave"] as const;

/**
 * PER-CHANNEL tolerance, in premultiplied space.
 *
 * OBSERVED: **0** on both fixtures, stable over three runs (chromium headless
 * `--use-angle=vulkan`, real nvidia adapter, 2026-08-20) — the round trip is EXACT here, which is
 * the strongest thing this file could have found: PNG is lossless, the decoder is exact, and the
 * unpremultiply/re-premultiply pair happens to be its own inverse over the values these fixtures
 * produce.
 *
 * BUDGET 2, deliberately above the observation. `webgpu-still-capture.test.ts` proves the two
 * roundings can each move a channel by one over the full (c, a) grid, so a fixture (or a GPU) that
 * lands on one of those values would legitimately read 1 or 2 and must not fail the suite. Anything
 * structural — a double premultiply darkening soft edges, a straight-alpha image compared against
 * premultiplied bytes, a row-stride error — is far larger than 2 and blows straight through it.
 */
const MAX_CHANNEL_DELTA = 2;

/**
 * Share of pixels `pixelmatch` may call different at the tight threshold below.
 *
 * OBSERVED: 0 differing pixels on both fixtures, three runs. BUDGET 0.005 (0.5%) so a handful of
 * unlucky pixels on a different GPU cannot fail the suite, while a real regression (which moves
 * whole regions, not a scattering of pixels) cannot hide under it.
 */
const MAX_DIFF_RATIO = 0.005;
/** Tight on purpose: this comparison is two representations of ONE frame, so the only differences it
 *  should see are rounding. (The cross-backend suite uses 0.12 because two rasterizers legitimately
 *  disagree by more than that.) */
const PIXELMATCH_THRESHOLD = 0.02;

/** A blank image equals a blank image, so a fixture that paints nothing must not pass. */
const MIN_NONBLANK_PIXELS = 64;

/** Needed for WebGPU on a SwiftShader/Vulkan box; harmless where a real adapter exists. */
const CHROME_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];

/**
 * The launch ladder, and the order, are `webgpuParityBrowser.test.ts`'s — measured there, and the
 * same constraints apply here: `--use-angle=vulkan` is the only rung on this box that reaches the
 * REAL adapter without a display, headless-default lands on SwiftShader (whose device is lost a few
 * hundred ms in), and the headed rung needs DISPLAY. This suite needs strictly less than that one
 * (no WebGL side at all), but a rung that cannot render WebGPU cannot run it either.
 *
 * READBACK NEEDS NO COMPOSITOR — that is why the swap can be measured headless at all, and why a
 * skip here means "no WebGPU device", never "no screen".
 */
const LAUNCH_ATTEMPTS: Array<{
  label: string;
  headless: boolean;
  args: string[];
}> = [
  {
    label: "headless --use-angle=vulkan",
    headless: true,
    args: [...CHROME_ARGS, "--use-angle=vulkan"],
  },
  { label: "headless", headless: true, args: CHROME_ARGS },
  { label: "headed", headless: false, args: CHROME_ARGS },
];

/** A REAL ORIGIN: a `page.setContent` page is not a secure context and Chrome then hides
 *  `navigator.gpu` entirely, which would make every run a silent WebGL one. Route-fulfilling
 *  `http://localhost` needs no server. */
const PAGE_ORIGIN = "http://localhost/gsw-webgpu-swap-parity";
const PAGE_HTML =
  "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#000}</style></head><body></body></html>";

let browser: Browser;
let bundleText: string;
let skipReason: string | null = null;
let launchMode = "unknown";

const summary: string[] = [];

function fixtureNamed(name: string): ParityFixture {
  const fixture = PARITY_FIXTURES.find((candidate) => candidate.name === name);
  if (!fixture) {
    throw new Error(`webgpu-swap-parity: no parity fixture named "${name}"`);
  }
  return fixture;
}

interface SwappedStill {
  width: number;
  height: number;
  still: Uint8Array;
  reference: Uint8Array;
  referenceWidth: number;
  referenceHeight: number;
  capture: string;
  renderer: string | null;
  webgpuFallbacks: number | null;
  webgpuFallbackReason: string | null;
  bindingBackend: string | null;
  staticImagesLive: number;
  staticImageCaptures: number;
  staticImageCaptureFailures: number;
  staticImageBlankCaptures: number;
  staticImageFailures: number;
}

beforeAll(async () => {
  bundleText = await bundleBrowserEntry();

  let lastVerdict = "not attempted";
  for (const attempt of LAUNCH_ATTEMPTS) {
    let candidate: Browser;
    try {
      candidate = await chromium.launch({
        headless: attempt.headless,
        args: attempt.args,
      });
    } catch (error) {
      // A headed launch on a display-less box lands here: a skip, not a suite error.
      lastVerdict = `${attempt.label} would not launch: ${String(error).split("\n")[0]}`;
      continue;
    }
    const verdict = await probeBrowser(candidate, bundleText);
    if (verdict === null) {
      browser = candidate;
      launchMode = attempt.label;
      return;
    }
    lastVerdict = `${attempt.label}: ${verdict}`;
    await candidate.close();
  }

  skipReason = `no Chromium configuration on this box can produce a WebGPU swap (last: ${lastVerdict}) — WebGPU needs --enable-unsafe-webgpu --enable-features=Vulkan and an adapter that survives a frame; the headed rung needs DISPLAY`;
}, 240000);

/**
 * Can this browser produce a real WebGPU swap? `null` for yes, else why not.
 *
 * Goes all the way to a device (`requestAdapter` alone is not enough — an adapter can be handed out
 * where the device request then fails) and then all the way to a SWAPPED STILL of a real fixture,
 * because everything between those two points is what this suite exists to measure: a box can hold a
 * device and still lose it mid-render, and a fallback would leave the comparison testing a PNG of a
 * WebGL canvas against that same canvas — which passes, and means nothing.
 *
 * A THROWAWAY page: a device loss poisons the page-wide memo in `webgpu/device.ts` by design, so a
 * page that has watched WebGPU fail could never serve as the run afterwards.
 */
async function probeBrowser(
  target: Browser,
  bundle: string,
): Promise<string | null> {
  const page = await openPage(target, bundle);
  try {
    const available = await page.evaluate(() =>
      (
        window as unknown as {
          __gswWebgpuParity: { hasWebgpu(): Promise<boolean> };
        }
      ).__gswWebgpuParity.hasWebgpu(),
    );
    if (!available) {
      return "navigator.gpu yielded no device";
    }
    const still = await renderSwappedStill(page, fixtureNamed("textured"));
    if (still.renderer !== "webgpu" || still.capture !== "capture-hook") {
      return `the probe fixture ended on renderer="${still.renderer}" capture="${still.capture}" (webgpuFallbacks=${still.webgpuFallbacks}, reason=${still.webgpuFallbackReason})`;
    }
    if (still.staticImagesLive < 1) {
      // `blankCaptures` is the rung's own verdict on itself: the readback ran and produced an
      // entirely transparent frame, so this configuration would have measured a PNG of nothing. The
      // ladder moves on, which is exactly what it should do (see docs/perf-harness.md, S8).
      return `the probe fixture never swapped (captures=${still.staticImageCaptures}, captureFailures=${still.staticImageCaptureFailures}, blankCaptures=${still.staticImageBlankCaptures})`;
    }
  } catch (error) {
    return `the probe fixture threw: ${String(error).split("\n")[0]}`;
  } finally {
    await page.close();
  }
  return null;
}

afterAll(async () => {
  if (summary.length > 0) {
    console.log(
      `\nwebgpu-swap-parity (chromium ${launchMode})\n${summary.join("\n")}`,
    );
  }
  await browser?.close();
});

/** esbuild, on the parity suite's recipe: `conditions: ["development"]` is what makes
 *  `@godot-scene-web/html` resolve to its TypeScript SOURCE rather than a possibly-stale `dist/`. */
async function bundleBrowserEntry(): Promise<string> {
  const entry = join(here, "..", "src", "webgpu-parity", "browser-entry.ts");
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
      "esbuild produced no output for the webgpu-parity browser entry",
    );
  }
  return file.text;
}

async function openPage(target: Browser, bundle: string): Promise<Page> {
  const page = await target.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (error) => {
    console.error(`webgpu-swap-parity page error: ${error.message}`);
  });
  // `webgpu/device.ts` declines a fallback (software) adapter by policy and would hand every binding
  // to WebGL — which this suite would then measure as a swap of a WebGL canvas. This is the escape
  // hatch that module documents, and it makes the run CORRECTNESS-ONLY (a software adapter is never
  // a performance reading).
  await page.addInitScript(() => {
    (globalThis as Record<string, unknown>).__gswForceWebgpuEffects = true;
  });
  await page.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE_HTML }),
  );
  await page.goto(PAGE_ORIGIN);
  await page.addScriptTag({ content: bundle, type: "module" });
  await page.waitForFunction(() => "__gswWebgpuParity" in window, undefined, {
    timeout: 15000,
  });
  return page;
}

/** Run something on a page of its very own, then throw the page (and its module scope) away. The
 *  effects packages keep module-scoped caches that deliberately survive `dispose()`. */
async function withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const page = await openPage(browser, bundleText);
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

async function renderSwappedStill(
  page: Page,
  fixture: ParityFixture,
): Promise<SwappedStill> {
  const frame = await page.evaluate(
    async ([fixtureArg]) =>
      (
        window as unknown as {
          __gswWebgpuParity: {
            renderSwappedStill(
              fixture: unknown,
              side: unknown,
            ): Promise<
              Omit<SwappedStill, "still" | "reference"> & {
                stillB64: string;
                referenceB64: string;
              }
            >;
          };
        }
      ).__gswWebgpuParity.renderSwappedStill(fixtureArg, {
        effectsRenderer: "webgpu",
      }),
    [fixture] as const,
  );
  return {
    ...frame,
    still: base64ToBytes(frame.stillB64),
    reference: base64ToBytes(frame.referenceB64),
  };
}

/** The worst per-channel disagreement between two premultiplied buffers — the number the ±1
 *  round-trip argument is actually about, which a perceptual pixel ratio cannot express. */
function maxChannelDelta(a: Uint8Array, b: Uint8Array): number {
  let worst = 0;
  for (let index = 0; index < a.length; index++) {
    const delta = Math.abs(a[index] - b[index]);
    if (delta > worst) worst = delta;
  }
  return worst;
}

/** Pixels with any alpha at all — the non-blank guard's measure. */
function nonBlankPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) count++;
  }
  return count;
}

/** Write a frame as a reviewable PNG. The bytes are PREMULTIPLIED (the space the comparison happens
 *  in), so sharp is told as much and un-premultiplies for the file. */
async function writeFramePng(
  path: string,
  frame: { width: number; height: number; pixels: Uint8Array },
): Promise<void> {
  await sharp(Buffer.from(frame.pixels), {
    raw: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      premultiplied: true,
    },
  })
    .png()
    .toFile(path);
}

describe("frozen WebGPU surfaces publish an <img> that matches the frame it replaced", () => {
  for (const name of SWAP_FIXTURE_NAMES) {
    it(`swaps ${name} to an <img> that matches its rendered frame`, async (ctx) => {
      if (skipReason) {
        ctx.skip(skipReason);
        return;
      }
      const fixture = fixtureNamed(name);
      const frame = await withPage((page) => renderSwappedStill(page, fixture));

      // ---- this really is the WebGPU capture path ------------------------------------------
      //
      // Without this block the failure mode is silence: a WebGPU decline ends in a WebGL runtime
      // drawing the right picture, and the comparison would then be a PNG of a 2D canvas against
      // that same canvas — which agrees perfectly and exercises none of the readback chain.
      expect(
        frame.renderer,
        `${name}: renderer="${frame.renderer}" (webgpuFallbacks=${frame.webgpuFallbacks}, reason=${frame.webgpuFallbackReason}) — this run fell back, so it would be measuring a canvas against a PNG of itself`,
      ).toBe("webgpu");
      expect(
        frame.capture,
        `${name}: the reference was captured via "${frame.capture}" — a WebGPU binding's frame can only come back through captureNodePixels, so "2d" means these bytes came off a WebGL fallback canvas`,
      ).toBe("capture-hook");
      if (fixture.kind === "shader") {
        // Only the WebGPU shader backend stamps this, and it is the per-BINDING oracle: a runtime
        // can be on WebGPU while this one node fell back by itself.
        expect(
          frame.bindingBackend,
          `${name}: the canvas is stamped data-godot-effects-backend="${frame.bindingBackend}"`,
        ).toBe("webgpu");
      }

      // ---- the swap engaged, and cleanly ---------------------------------------------------
      expect(frame.staticImagesLive).toBe(1);
      expect(
        frame.staticImageCaptures,
        `${name}: the still must come from a capture readback, not from a canvas read`,
      ).toBeGreaterThanOrEqual(1);
      expect(frame.staticImageCaptureFailures).toBe(0);
      // THE BLANK GUARD MUST STAY QUIET ON THIS RUNG. It refuses a readback that comes back
      // entirely transparent for a surface the renderer knows it drew — the launch-mode hazard this
      // suite's ladder exists to avoid (headed + default ANGLE reads back nothing; see
      // docs/perf-harness.md, S8). Here the readback works, so a non-zero would mean the guard is
      // firing on frames that are real — and every pixel assertion below would then be untested,
      // because a refused capture publishes no `<img>` at all.
      expect(
        frame.staticImageBlankCaptures,
        `${name}: the swap refused ${frame.staticImageBlankCaptures} capture(s) as entirely transparent on a rung whose readback works`,
      ).toBe(0);
      expect(frame.staticImageFailures).toBe(0);

      // The `<img>` carries the BACKING STORE, not the CSS box: the swap encodes the backing store
      // and presents it at the box with `object-fit: fill`, so an intrinsic size that matched the
      // CSS box would mean the frame had been resampled on the way through.
      expect(
        { width: frame.width, height: frame.height },
        `${name}: the stand-in decoded to ${frame.width}x${frame.height} but the frame is ${frame.referenceWidth}x${frame.referenceHeight} — the published image is not the frame's backing store`,
      ).toEqual({
        width: frame.referenceWidth,
        height: frame.referenceHeight,
      });

      // Blank == blank must never pass.
      const painted = nonBlankPixels(frame.reference);
      expect(
        painted,
        `${name}: the rendered frame has ${painted} non-transparent px of ${frame.width * frame.height} — comparing an image against a blank frame proves nothing`,
      ).toBeGreaterThanOrEqual(MIN_NONBLANK_PIXELS);

      const dir = join(artifactRoot, name);
      await mkdir(dir, { recursive: true });
      await writeFramePng(join(dir, "rendered.png"), {
        width: frame.referenceWidth,
        height: frame.referenceHeight,
        pixels: frame.reference,
      });
      await writeFramePng(join(dir, "swapped.png"), {
        width: frame.width,
        height: frame.height,
        pixels: frame.still,
      });

      // ---- the pixels ----------------------------------------------------------------------
      const worst = maxChannelDelta(frame.reference, frame.still);
      const result = await compareRgbaBuffers(frame.reference, frame.still, {
        width: frame.width,
        height: frame.height,
        threshold: PIXELMATCH_THRESHOLD,
        maxDiffRatio: MAX_DIFF_RATIO,
        diffPath: join(dir, "diff.png"),
      });
      await writeFile(
        join(dir, "result.json"),
        `${JSON.stringify(
          {
            fixture: name,
            kind: fixture.kind,
            launchMode,
            renderer: frame.renderer,
            capture: frame.capture,
            staticImagesLive: frame.staticImagesLive,
            staticImageCaptures: frame.staticImageCaptures,
            staticImageBlankCaptures: frame.staticImageBlankCaptures,
            maxChannelDelta: worst,
            maxChannelDeltaBudget: MAX_CHANNEL_DELTA,
            diff: result,
          },
          null,
          2,
        )}\n`,
      );
      summary.push(
        `  ${name.padEnd(14)} maxChannelDelta ${worst}/${MAX_CHANNEL_DELTA}  diffRatio ${(result.diffRatio ?? 0).toFixed(5)}/${MAX_DIFF_RATIO}  (${frame.width}x${frame.height})`,
      );

      expect(
        worst,
        `${name}: worst per-channel difference ${worst} in premultiplied space. Two roundings (unpremultiply out, re-premultiply back) can each move a channel by 1; anything beyond that is structural — a double premultiply, a straight-vs-premultiplied mixup, or a stride error. See ${dir}`,
      ).toBeLessThanOrEqual(MAX_CHANNEL_DELTA);
      expect(
        result.ok,
        `${name}: ${result.diffPixels}/${result.totalPixels} pixels (${((result.diffRatio ?? 0) * 100).toFixed(3)}%) differ beyond the ${MAX_DIFF_RATIO} budget — see ${join(dir, "diff.png")}`,
      ).toBe(true);
    }, 180000);
  }
});
