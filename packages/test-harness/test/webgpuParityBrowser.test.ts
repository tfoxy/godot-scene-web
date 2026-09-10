// @vitest-environment node
//
// NODE, not the repo-default jsdom, and not optional: esbuild refuses to run under jsdom's globals
// (`new TextEncoder().encode("") instanceof Uint8Array` is false across jsdom's realm boundary, and
// esbuild asserts it at import). Nothing here wants a fake DOM anyway — the DOM under test is a
// real Chromium's, driven through playwright.
//
// The WebGL↔WebGPU image-parity suite — the primary, headless verification that a second effects
// backend draws the same picture as the shipped one.
//
// WHAT IT DOES. Side A mounts the shipped WebGL runtimes; side B mounts the same public surface with
// `effectsRenderer: "webgpu"` and reads its frames back through the runtimes' `captureNodePixels`
// (`copyTextureToBuffer` + `mapAsync` — a WebGPU canvas can never be read through `drawImage`).
// Every fixture is a frozen, deterministic frame, so the only thing that can differ between the two
// images is the renderer. It was built and proven first as WebGL-vs-WebGL SELF-PARITY (13 fixtures,
// 0 differing pixels) so that the harness itself — fixtures, determinism, capture, the non-blank
// guard, the budgets — was known good BEFORE the backend it exists to test landed.
//
// HOW THIS SUITE REFUSES TO PASS VACUOUSLY. The runtimes' WebGPU gate is silent by design: no
// adapter, a software adapter, an acquire timeout, a pipeline error — each quietly becomes WebGL and
// keeps drawing the right picture. A parity suite that accepted that would compare WebGL against
// WebGL, agree perfectly, and prove nothing. So side B asserts `renderer === "webgpu"` AND that the
// pixels came from the WebGPU readback hook rather than a 2D canvas, per fixture. The one fixture
// that is legitimately WebGL on both sides (`shader-screen-texture-fallback`) says so in the fixture
// and is held to EXACT equality instead.
//
// WHY A FRESH PAGE PER FIXTURE, PER SIDE. The effects packages keep module-scoped caches that
// deliberately survive a runtime `dispose()`: compiled programs, uploaded textures, and the
// frozen-frame caches (`particles/static-frame-cache.ts`, the shader runtime's sibling). Sharing one
// page between the SIDES would let side B be served side A's cached BITMAP — a blit, not a render —
// so parity would be perfect by construction while proving nothing.
//
// Sharing one page across FIXTURES was, until this suite measured it, just as dangerous: a WebGL
// shader fixture rendered on a page where the particle fixtures had already run came out with
// colour x0.67 and alpha x0.65 versus the same fixture on a fresh page, while the WebGPU side was
// bit-identical either way. That was a state leak in the shipped WebGL path — the REFERENCE side of
// this comparison — and it charged ~15% differing pixels to WebGPU for something WebGPU did not do.
// It is FIXED: the shader backend now owns its blend state (`webgl/shader-backend.ts` disables
// BLEND in its preamble, beside the DEPTH_TEST disable) instead of trusting a fresh context's
// defaults on a context it shares with the particle path. "the shipped WebGL path owns its blend
// state" below is the regression test — one page, particles then a shader, budget zero, evidence in
// `artifacts/webgpu-parity/_webgl-state-leak/`.
//
// The fresh-page-per-fixture policy STAYS regardless, for the cache-isolation reason above: it is
// what keeps one fixture's module-scoped compiled programs, textures and frozen frames from being
// served to the next, and it costs about four seconds over the suite.
//
// Playwright is used as a LIBRARY inside vitest, per this repo's convention for browser assertions
// (`anchorPositioningBrowser.test.ts`, `parity.ts`) — no separate `@playwright/test` runner config.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// DEEP RELATIVE IMPORTS into the html package's source, not through `@godot-scene-web/html`: the
// WGSL transpiler is not in that package's barrel (it is internal to the renderer), and this test
// needs to run it in NODE — the emitter is pure strings, so the corpus is transpiled here and only
// the resulting WGSL is shipped into the page to be compiled. `expandGodotShaderIncludes` is the
// same front-end the runtime uses to resolve `#include`s before transpiling.
import {
  expandGodotShaderIncludes,
  transpileGodotShaderWgsl,
} from "@godot-scene-web/effects/shaders";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareRgbaBuffers, describeChannelDelta } from "../src/image-diff";
import {
  PARITY_FIXTURES,
  PARITY_PIXELMATCH_THRESHOLD,
  type ParityFixture,
} from "../src/webgpu-parity/fixtures";
import { base64ToBytes } from "../src/webgpu-parity/pixels";
import {
  CORPUS_INCLUDES,
  WGSL_CORPUS,
} from "../src/webgpu-parity/shader-corpus";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
/** `artifacts/` is gitignored (repo root `.gitignore`) — every image this writes stays local. */
const artifactRoot = join(repoRoot, "artifacts", "webgpu-parity");

interface Side {
  /** Artifact prefix and failure-message label. */
  label: string;
  /** Passed straight through to the runtimes as `effectsRenderer`. */
  effectsRenderer: "auto" | "webgl" | "webgpu";
}

/** The reference side: today's shipped WebGL path, pinned EXPLICITLY rather than left to the
 *  `"auto"` default, so the reference cannot silently become the thing under test. */
const SIDE_A: Side = { label: "a-webgl", effectsRenderer: "webgl" };

/** Side B: the backend under test. Also pinned explicitly — under `"auto"` a box without a WebGPU
 *  adapter would quietly make this a second WebGL side, which the adoption assertions now reject. */
const SIDE_B: Side = { label: "b-webgpu", effectsRenderer: "webgpu" };

/**
 * True when both sides are pinned to the SAME backend — false now that side B is WebGPU, and kept
 * because re-pinning the sides is a real debugging move: when a fixture starts differing, running
 * both sides on one backend separates "the renderers disagree" from "the fixture is not
 * deterministic". Self-parity is not held to the cross-backend budget — one renderer replaying one
 * frozen frame must be EXACT — so the check tightens itself automatically.
 */
const SELF_PARITY = SIDE_A.effectsRenderer === SIDE_B.effectsRenderer;
const SELF_PARITY_MAX_DIFF_RATIO = 0;

/**
 * The non-blank floor, in pixels with any alpha at all.
 *
 * A blank canvas equals a blank canvas, so without this a runtime that silently declined (no WebGL2,
 * a software-renderer decline, an unresolved shader) would PASS every fixture. 64 px is about 0.4%
 * of a fixture cell — far below any real fixture (the smallest here paints thousands) and far above
 * the zero a broken one paints.
 */
const MIN_NONBLANK_PIXELS = 64;

/** Needed for WebGPU on a SwiftShader/Vulkan box; harmless where a real adapter exists. */
const CHROME_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan"];

/**
 * The launch configurations this suite will try, in order, until one can run BOTH sides.
 *
 * MEASURED ON THIS BOX, and the reason this is a ladder rather than a constant — neither default
 * mode can run both backends:
 *
 *  - headless (default ANGLE): WebGL renders fine, but WebGPU lands on SwiftShader and the device is
 *    LOST a few hundred ms in — `device.lost` resolves `"destroyed"` though nothing in JS ever calls
 *    `destroy()` (verified by instrumenting `GPUDevice.prototype.destroy`). The runtime then does
 *    what it promises and silently falls back to WebGL.
 *  - headed: WebGPU renders and composites correctly on the real adapter, but the WebGL side comes
 *    back EMPTY — and empty on screen too, not merely unreadable, so it is the frozen frame that is
 *    missing rather than the readback. Same code, same fixture, painting 786 px headless.
 *  - headless + `--use-angle=vulkan`: ANGLE and Dawn both land on the REAL adapter (nvidia/turing
 *    here), and both backends render. One browser, one GPU, no display — which also makes the two
 *    sides differ only by the thing under test.
 *
 * So `--use-angle=vulkan` goes FIRST: it is the only rung observed to run both sides, and it keeps
 * the suite display-free (the plan's primary path). The others stay as fallbacks for boxes where
 * ANGLE's Vulkan backend is unavailable, each gated by the same both-sides canary.
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

/**
 * A REAL ORIGIN, not `about:blank` and not `page.setContent`.
 *
 * Measured on this box, and the single most expensive thing to rediscover: a `setContent` page sits
 * on an opaque origin, `isSecureContext` is false, and Chrome then does not expose `navigator.gpu`
 * AT ALL. The runtime's gate reads that as `no-navigator-gpu`, falls back to WebGL synchronously,
 * and side B silently becomes a second WebGL side. `http://localhost` is a trustworthy origin, and
 * route-fulfilling it needs no server.
 */
const PAGE_ORIGIN = "http://localhost/gsw-webgpu-parity";
const PAGE_HTML =
  "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#000}</style></head><body></body></html>";

let browser: Browser;
/** The bundled browser entry, kept so every fixture can open its own page (see the header). */
let bundleText: string;
/** Set when the suite cannot run the configured sides on this box (see `beforeAll`). */
let skipReason: string | null = null;
/** How the browser that ran this suite was launched — reported with the results, because the two
 *  modes reach DIFFERENT adapters on this box (headless: SwiftShader; headed: the real GPU) and a
 *  diff ratio means little without knowing which rasterizers produced it. */
let launchMode = "unknown";

const summary: string[] = [];

beforeAll(async () => {
  const bundle = await bundleBrowserEntry();
  bundleText = bundle;
  const needsWebgpu =
    SIDE_A.effectsRenderer === "webgpu" || SIDE_B.effectsRenderer === "webgpu";

  // THE LAUNCH LADDER. Each rung is tried until one passes the CANARY — a real render of a real
  // fixture on BOTH sides (see `probeBrowser`). See `LAUNCH_ATTEMPTS` for what each rung is and why
  // the order is what it is.
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
    const verdict = await probeBrowser(candidate, bundle, needsWebgpu);
    if (verdict === null) {
      browser = candidate;
      launchMode = attempt.label;
      return;
    }
    lastVerdict = `${attempt.label}: ${verdict}`;
    await candidate.close();
  }

  skipReason = `no Chromium configuration on this box can render both sides (last: ${lastVerdict}) — WebGPU needs --enable-unsafe-webgpu --enable-features=Vulkan and an adapter that survives a frame; the headed rung needs DISPLAY`;
}, 240000);

/**
 * Can this browser actually run BOTH sides of the comparison? `null` for yes, else why not.
 *
 * Renders one real fixture through the shipped runtimes exactly as the suite will, on each side, and
 * demands of each that it used the backend it was asked for AND painted something. Both halves are
 * load-bearing, and each caught a real failure on this box:
 *
 *  - side B can report a device, render, and be back on WebGL by the end of the frame (headless
 *    SwiftShader loses the device mid-render). Checking `renderer` and `capture` AFTER the frame is
 *    what catches that; an adapter check or even a `requestDevice` says yes and is simply wrong.
 *  - side A can be on the right backend and paint NOTHING (headed, where the frozen WebGL frame
 *    never appears — on screen either). A suite that only probed WebGPU would pick that browser and
 *    then fail every fixture on a blank reference, blaming the fixtures.
 *
 * Each side gets a THROWAWAY page, which matters for more than hygiene: a device loss POISONS the
 * page-wide memo in `webgpu/device.ts` (by design — a device that died once will usually die again),
 * so a page that has watched WebGPU fail is permanently WebGL and could never serve as side B.
 */
async function probeBrowser(
  target: Browser,
  bundle: string,
  needsWebgpu: boolean,
): Promise<string | null> {
  const canary = PARITY_FIXTURES.find((f) => f.kind === "particles");
  if (!canary) {
    return "no particle fixture to probe with";
  }
  const sides = needsWebgpu ? [SIDE_A, SIDE_B] : [SIDE_A];
  for (const side of sides) {
    const page = await openSidePage(target, bundle);
    try {
      if (side.effectsRenderer === "webgpu") {
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
      }
      const frame = await renderSide(page, canary, side);
      const wantedCapture =
        side.effectsRenderer === "webgpu" ? "capture-hook" : "2d";
      if (
        frame.renderer !== side.effectsRenderer ||
        frame.capture !== wantedCapture
      ) {
        return `side ${side.label} rendered "${canary.name}" but ended on renderer="${frame.renderer}" capture="${frame.capture}" (webgpuFallbacks=${frame.webgpuFallbacks}, reason=${frame.webgpuFallbackReason})`;
      }
      const painted = nonBlankPixels(frame.pixels);
      if (painted < MIN_NONBLANK_PIXELS) {
        return `side ${side.label} rendered "${canary.name}" on ${frame.renderer} but painted only ${painted} px of ${frame.width * frame.height}`;
      }
    } catch (error) {
      return `side ${side.label} threw while rendering the probe fixture: ${String(error).split("\n")[0]}`;
    } finally {
      await page.close();
    }
  }
  return null;
}

afterAll(async () => {
  if (summary.length > 0) {
    console.log(
      `\nwebgpu-parity ${SIDE_A.label} vs ${SIDE_B.label} (chromium ${launchMode})\n${summary.join("\n")}`,
    );
  }
  await browser?.close();
});

/** esbuild, on the perf-harness recipe: `conditions: ["development"]` is what makes
 *  `@godot-scene-web/html` resolve to its TypeScript SOURCE — the harness must mount the shipped
 *  code, not a `dist/` that may not even be built. */
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

/** Run something on a page of its very own, then throw the page (and its module scope) away. */
async function withSidePage<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const page = await openSidePage(browser, bundleText);
  try {
    return await run(page);
  } finally {
    await page.close();
  }
}

async function openSidePage(target: Browser, bundle: string): Promise<Page> {
  const page = await target.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (error) => {
    console.error(`webgpu-parity page error: ${error.message}`);
  });

  // `webgpu/device.ts` DECLINES a fallback (software) adapter, exactly as `shared-gl.ts` declines
  // SwiftShader, and would then hand every binding to WebGL — which this suite would compare against
  // WebGL and call parity. This is the escape hatch that module documents for precisely this case.
  // It makes the run CORRECTNESS-ONLY (a software adapter is never a performance reading, per S7);
  // the phone is where the perf claim is settled. Set before navigation so it is in place when the
  // bundle's first `acquireWebgpuDevice()` runs.
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

interface Capture {
  width: number;
  height: number;
  pixels: Uint8Array;
  capture: string;
  draws: number;
  cacheHits: number;
  renders: number;
  renderer: string | null;
  webgpuFallbacks: number | null;
  webgpuFallbackReason: string | null;
  webgpuBindingFallbacks: number | null;
  bindingBackend: string | null;
}

async function renderSide(
  page: Page,
  fixture: ParityFixture,
  side: Side,
): Promise<Capture> {
  const frame = await page.evaluate(
    async ([fixtureArg, sideArg]) =>
      (
        window as unknown as {
          __gswWebgpuParity: {
            renderFixture(
              fixture: unknown,
              side: unknown,
            ): Promise<Omit<Capture, "pixels"> & { pixelsB64: string }>;
          };
        }
      ).__gswWebgpuParity.renderFixture(fixtureArg, sideArg),
    [fixture, { effectsRenderer: side.effectsRenderer }] as const,
  );
  return { ...frame, pixels: base64ToBytes(frame.pixelsB64) };
}

/** Side-A frame digests by fixture name, for the distinctness check that closes the suite. */
const frameDigests = new Map<string, string>();

/** FNV-1a over the frame's size and bytes. Only ever compared with another digest. */
function frameDigest(frame: Capture): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < frame.pixels.length; index++) {
    hash ^= frame.pixels[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${frame.width}x${frame.height}:${(hash >>> 0).toString(16)}`;
}

/** Pixels with any alpha at all — the non-blank guard's measure. */
function nonBlankPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) {
      count++;
    }
  }
  return count;
}

/** Write a captured frame as a reviewable PNG. The bytes are PREMULTIPLIED (that is the space the
 *  comparison happens in), so sharp is told as much and un-premultiplies for the file — otherwise
 *  every artifact would look darker than what the renderer actually put on screen. */
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

describe("WebGL↔WebGPU effects image parity", () => {
  it("mounts the shipped runtimes in the page", () => {
    expect(PARITY_FIXTURES.length).toBeGreaterThan(0);
    expect(
      PARITY_FIXTURES.filter((f) => f.kind === "particles").length,
    ).toBeGreaterThan(0);
    expect(
      PARITY_FIXTURES.filter((f) => f.kind === "shader").length,
    ).toBeGreaterThan(0);
  });

  for (const fixture of PARITY_FIXTURES) {
    it(`renders ${fixture.name} identically on ${SIDE_A.label} and ${SIDE_B.label}`, async (ctx) => {
      if (skipReason) {
        ctx.skip(skipReason);
        return;
      }
      const a = await withSidePage((page) => renderSide(page, fixture, SIDE_A));
      const b = await withSidePage((page) => renderSide(page, fixture, SIDE_B));

      // Both sides drew a REAL frame of THIS node. `renders` counts `onBindingRendered`, which
      // both runtimes fire only on a draw that reached `drawParticles`/`gl.drawArrays` — never on
      // a frozen-frame cache blit, a dirty-skip or a park. So a side that was served a bitmap
      // instead of rendering one could not get past the page's own settle gate, and a side whose
      // runtime silently declined times out there rather than arriving here with a blank canvas.
      //
      // `cacheHits` is RECORDED, not asserted: the shader runtime legitimately re-blits a
      // binding's OWN just-cached frozen frame when the loop revisits it, which says nothing
      // about parity. The cache that WOULD matter — one side being handed the other's bitmap —
      // is prevented structurally by the two sides living in separate pages (see the header),
      // since these caches are module-scoped and survive `dispose()`.
      expect(a.renders).toBeGreaterThan(0);
      expect(a.draws).toBeGreaterThan(0);
      expect(b.renders).toBeGreaterThan(0);
      expect(b.draws).toBeGreaterThan(0);

      // ---- the two sides really are two DIFFERENT BACKENDS ----------------------------------
      //
      // Without this block the suite's failure mode is silence: every way WebGPU can decline ends
      // in a WebGL runtime drawing the correct picture, so a fallback produces a PASSING run that
      // compared WebGL against WebGL. `renderer` is the runtime's own gauge and `capture` says
      // which readback path produced these very bytes — the second matters because the shader
      // runtime chooses per BINDING, so a WebGPU runtime can still hand one node to WebGL.
      expect(
        a.renderer,
        `${fixture.name}: the reference side reported renderer="${a.renderer}" — it is pinned to "webgl" and must stay the Godot-parity reference`,
      ).toBe("webgl");
      expect(
        a.capture,
        `${fixture.name}: the reference side captured via "${a.capture}"`,
      ).toBe("2d");
      expect(
        b.renderer,
        `${fixture.name}: side ${SIDE_B.label} reported renderer="${b.renderer}" (webgpuFallbacks=${b.webgpuFallbacks}, webgpuFallbackReason=${b.webgpuFallbackReason}) — it fell back, so this comparison would be WebGL against WebGL`,
      ).toBe("webgpu");

      const expectsBindingFallback =
        fixture.kind === "shader" && fixture.expectBindingFallback === true;
      if (expectsBindingFallback) {
        // The per-binding fallback contract, proven three ways: the runtime counted it, the node
        // has no WebGPU readback because it has no WebGPU surface, and its canvas is unstamped.
        expect(
          b.webgpuBindingFallbacks,
          `${fixture.name}: expected exactly one binding to fall back to WebGL by itself, got ${b.webgpuBindingFallbacks}`,
        ).toBe(1);
        expect(
          b.capture,
          `${fixture.name}: this binding is on WebGL, so captureNodePixels must decline and the capture must come from the 2D canvas`,
        ).toBe("2d");
        expect(
          b.bindingBackend,
          `${fixture.name}: the canvas is stamped data-godot-effects-backend="${b.bindingBackend}", but a fallen-back binding is a WebGL canvas and must carry no stamp`,
        ).toBeNull();
      } else {
        expect(
          b.capture,
          `${fixture.name}: side ${SIDE_B.label} captured via "${b.capture}" — a WebGPU binding must be read through captureNodePixels (a WebGPU canvas cannot be read any other way), so "2d" here means these pixels came off a WebGL fallback canvas`,
        ).toBe("capture-hook");
        expect(
          b.webgpuBindingFallbacks ?? 0,
          `${fixture.name}: ${b.webgpuBindingFallbacks} binding(s) fell back to WebGL under a WebGPU runtime`,
        ).toBe(0);
      }

      expect(
        { width: b.width, height: b.height },
        `${fixture.name}: the two sides sized their canvas differently — ${SIDE_A.label} is ${a.width}x${a.height}, ${SIDE_B.label} is ${b.width}x${b.height}. Both are the canvas BACKING STORE, so this is a sizing-law difference between the backends (WebGPU clamps to device.limits.maxTextureDimension2D), not a capture bug.`,
      ).toEqual({ width: a.width, height: a.height });

      // Blank == blank must never pass.
      const painted = nonBlankPixels(a.pixels);
      expect(
        painted,
        `${fixture.name}: side ${SIDE_A.label} painted ${painted} non-transparent px of ${a.width * a.height} — the fixture spec renders nothing, so any comparison against it is meaningless`,
      ).toBeGreaterThanOrEqual(MIN_NONBLANK_PIXELS);

      frameDigests.set(fixture.name, frameDigest(a));

      const dir = join(artifactRoot, fixture.name);
      await mkdir(dir, { recursive: true });
      await writeFramePng(join(dir, "a.png"), a);
      await writeFramePng(join(dir, "b.png"), b);

      const result = await compareRgbaBuffers(a.pixels, b.pixels, {
        width: a.width,
        height: a.height,
        threshold: PARITY_PIXELMATCH_THRESHOLD,
        maxDiffRatio: SELF_PARITY
          ? SELF_PARITY_MAX_DIFF_RATIO
          : fixture.maxDiffRatio,
        // THE THRESHOLD-INDEPENDENT VERDICT, and the one that actually holds this suite honest.
        // Pixelmatch reported 0.0000 on every fixture while the shipped WebGL MIX path was
        // compositing at `a²` — it blends semi-transparent pixels onto white by their own alpha
        // before comparing, so a whole factor of alpha at partial coverage scores under the cutoff.
        // Self-parity is one renderer replaying one frozen frame, so it is held at a hard 0.
        maxChannelDelta: SELF_PARITY ? 0 : fixture.maxChannelDelta,
        diffPath: join(dir, "diff.png"),
      });
      await writeFile(
        join(dir, "result.json"),
        `${JSON.stringify(
          {
            fixture: fixture.name,
            kind: fixture.kind,
            launchMode,
            sideA: {
              ...SIDE_A,
              capture: a.capture,
              draws: a.draws,
              cacheHits: a.cacheHits,
              renders: a.renders,
              renderer: a.renderer,
            },
            sideB: {
              ...SIDE_B,
              capture: b.capture,
              draws: b.draws,
              cacheHits: b.cacheHits,
              renders: b.renders,
              renderer: b.renderer,
              webgpuFallbacks: b.webgpuFallbacks,
              webgpuFallbackReason: b.webgpuFallbackReason,
              webgpuBindingFallbacks: b.webgpuBindingFallbacks,
              bindingBackend: b.bindingBackend,
            },
            width: a.width,
            height: a.height,
            paintedPixels: painted,
            diffPixels: result.diffPixels,
            diffRatio: result.diffRatio,
            budget: result.maxDiffRatio,
            channelDelta: result.channelDelta,
            selfParity: SELF_PARITY,
          },
          null,
          2,
        )}\n`,
      );
      const delta = result.channelDelta;
      summary.push(
        `  ${fixture.name.padEnd(30)} ${`${a.width}x${a.height}`.padEnd(9)} painted=${String(painted).padEnd(6)} diff=${String(result.diffPixels).padStart(6)}/${result.totalPixels} ratio=${result.diffRatio?.toFixed(6)} budget=${result.maxDiffRatio} chDelta=${String(delta?.max).padStart(3)}/${delta?.budget} chPx=${String(delta?.differingPixels).padStart(5)} b=${b.capture}`,
      );

      // TWO ASSERTIONS, NOT ONE, and the per-channel one is stated separately so a failure names
      // WHICH claim broke: "the picture moved" and "a byte moved" are different diagnoses.
      expect(
        result.channelDelta?.max,
        `${fixture.name}: ${delta ? describeChannelDelta(delta) : "no channel delta"} — the two backends disagree by more than a rasterizer is entitled to. Both frames are PREMULTIPLIED, so a delta concentrated on partial-alpha pixels is an alpha-contract difference (a missing or extra multiply by coverage), not edge sampling; see ${dir}`,
      ).toBeLessThanOrEqual(result.channelDelta?.budget ?? 0);
      expect(
        result.ok,
        `${fixture.name}: ${result.diffPixels}/${result.totalPixels} px differ (ratio ${result.diffRatio}), budget ${result.maxDiffRatio} — see ${dir}`,
      ).toBe(true);
    }, 120000);
  }

  // Runs last: vitest executes `it`s in declaration order, so every fixture above has recorded its
  // digest by the time this one reads them.
  it("paints a distinct picture for every fixture", (ctx) => {
    if (skipReason || frameDigests.size === 0) {
      ctx.skip(skipReason ?? "no fixture frames were captured");
      return;
    }
    // WHY THIS MATTERS MORE THAN IT LOOKS. Every check above compares a fixture against ITSELF, so
    // a fixture whose feature never took effect — a misspelled spec field, a flag the runtime
    // ignores, a texture that decoded to nothing — passes with a perfect score while silently
    // testing the same picture as its neighbour. Two fixtures rendering identical bytes means at
    // least one of them is not testing what its name says.
    const byDigest = new Map<string, string[]>();
    for (const [name, digest] of frameDigests) {
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), name]);
    }
    const duplicates = [...byDigest.values()].filter(
      (names) => names.length > 1,
    );
    expect(
      duplicates,
      `fixtures rendered byte-identical frames: ${duplicates.map((names) => names.join(" == ")).join("; ")} — at least one of them is not exercising the feature it is named for`,
    ).toEqual([]);
  });
});

/**
 * The GL-state regression test: a shader node must render the same picture whether or not a
 * particle system drew on the shared context first.
 *
 * WHAT IT IS GUARDING. `webgl/shared-gl.ts` hands every effect on a page ONE WebGL2 context, so
 * blend state set by one consumer is visible to the next. It used to be that only `drawParticles`
 * set any: it enabled BLEND with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` and left it enabled, and the
 * shader backend relied on the fresh-context default of BLEND-disabled. On a page that had run a
 * mix particle fixture, a shader then blended its fragment against the transparent black of its own
 * just-cleared sub-rect — rgb·a and a², measured here as colour x0.67 / alpha x0.65 against the
 * same fixture on a fresh page. Both backends now set blend state before drawing, and the shader
 * backend's is "off".
 *
 * WHY IT IS WORTH A DEDICATED PAGE. The suite above renders every fixture on a page of its own, so
 * it can never see this: the bug needs two fixtures of DIFFERENT kinds sharing one context, which
 * is precisely the arrangement production uses (one page, one context, particles and shaders both).
 * The budget is ZERO — same backend, same frozen frame, so the two renders are bit-identical or the
 * ordering changed the picture.
 */
describe("the shipped WebGL path owns its blend state", () => {
  it("renders a shader identically after a mix particle draw on the same context", async (ctx) => {
    if (skipReason) {
      ctx.skip(skipReason);
      return;
    }
    const particles = PARITY_FIXTURES.find((f) => f.name === "untextured-mix");
    const shader = PARITY_FIXTURES.find((f) => f.name === "shader-wave");
    if (!particles || !shader) {
      throw new Error(
        "the state-leak test needs the untextured-mix and shader-wave fixtures",
      );
    }

    // ONE page, both fixtures, in that order — `openSidePage` directly rather than
    // `withSidePage`, which exists to give each render a page of its own.
    const page = await openSidePage(browser, bundleText);
    let after: Capture;
    try {
      await renderSide(page, particles, SIDE_A);
      after = await renderSide(page, shader, SIDE_A);
    } finally {
      await page.close();
    }
    const fresh = await withSidePage((p) => renderSide(p, shader, SIDE_A));

    expect(
      after.renderer,
      "the ordering test is about the shipped WebGL path; both renders must be on it",
    ).toBe("webgl");
    expect(fresh.renderer).toBe("webgl");
    expect(after.renders).toBeGreaterThan(0);
    expect(fresh.renders).toBeGreaterThan(0);
    const painted = nonBlankPixels(fresh.pixels);
    expect(
      painted,
      `shader-wave painted ${painted} px on a fresh page — a blank reference would make this comparison vacuous`,
    ).toBeGreaterThanOrEqual(MIN_NONBLANK_PIXELS);
    expect(
      { width: after.width, height: after.height },
      "the two renders sized their canvas differently, so the diff below would be meaningless",
    ).toEqual({ width: fresh.width, height: fresh.height });

    // The evidence directory the module header points at.
    const dir = join(artifactRoot, "_webgl-state-leak");
    await mkdir(dir, { recursive: true });
    await writeFramePng(join(dir, "after-particles.png"), after);
    await writeFramePng(join(dir, "fresh-page.png"), fresh);

    const result = await compareRgbaBuffers(after.pixels, fresh.pixels, {
      width: fresh.width,
      height: fresh.height,
      threshold: PARITY_PIXELMATCH_THRESHOLD,
      maxDiffRatio: 0,
      // One renderer, one frozen frame, twice: bit-identical or the ordering changed the picture.
      // The state leak this guards was a colour x0.67 / alpha x0.65 shift — a channel-space
      // failure, so the channel metric is the one that would have named it first.
      maxChannelDelta: 0,
      diffPath: join(dir, "diff.png"),
    });
    await writeFile(
      join(dir, "result.json"),
      `${JSON.stringify(
        {
          test: "webgl-state-leak",
          launchMode,
          order: [particles.name, shader.name],
          side: SIDE_A,
          width: fresh.width,
          height: fresh.height,
          diffPixels: result.diffPixels,
          diffRatio: result.diffRatio,
          budget: result.maxDiffRatio,
          channelDelta: result.channelDelta,
        },
        null,
        2,
      )}\n`,
    );
    summary.push(
      `  ${"_webgl-state-leak".padEnd(30)} ${`${fresh.width}x${fresh.height}`.padEnd(9)} painted=${String(painted).padEnd(6)} diff=${String(result.diffPixels).padStart(6)}/${result.totalPixels} ratio=${result.diffRatio?.toFixed(6)} budget=${result.maxDiffRatio} chDelta=${result.channelDelta?.max}/${result.channelDelta?.budget}`,
    );

    expect(
      result.ok,
      `shader-wave rendered ${result.diffPixels}/${result.totalPixels} px differently (ratio ${result.diffRatio}) when a mix particle fixture had drawn on the same GL context first — a consumer of the shared context is leaking blend state; see ${dir}`,
    ).toBe(true);
  }, 120000);
});

/**
 * Every corpus shader, transpiled in node and COMPILED in a real WGSL front-end.
 *
 * WHY THIS RIDES THE PARITY HARNESS. It needs exactly one thing the parity suite already has: a page
 * with a WebGPU device. And it answers the question the emitter's own unit tests structurally
 * cannot. `packages/html/test/webgpu-transpile-wgsl.test.ts` proves each rule fired and each byte
 * offset is where it should be, but "is this string a legal WGSL program" is a whole-program
 * property of a compiler, and the corpus contains at least one case no regex could ever settle:
 * scry_reveal calls `fwidth` inside a loop whose bound is a uniform, which has to satisfy WGSL's
 * UNIFORMITY ANALYSIS — a dataflow rule with no textual signature. This block is where WP-5's open
 * risk is closed.
 *
 * It also covers the tier ahead of the picture: a shader can compile here long before a parity
 * fixture exists for it, so the corpus is validated whole rather than only where fixtures reach.
 */
describe("WGSL corpus compiles in a real WGSL front-end", () => {
  it("transpiles and compiles every corpus shader with zero errors", async (ctx) => {
    if (skipReason) {
      ctx.skip(skipReason);
      return;
    }

    // Transpile in NODE. A failure here is the EMITTER refusing a shader it is supposed to
    // support, which is a different bug from invalid output and is reported as such.
    const modules: Array<{ name: string; wgsl: string }> = [];
    for (const shader of WGSL_CORPUS) {
      const source = shader.needsIncludes
        ? await expandGodotShaderIncludes(
            shader.source,
            (path) => CORPUS_INCLUDES[path],
          )
        : shader.source;
      try {
        modules.push({
          name: shader.name,
          wgsl: transpileGodotShaderWgsl(source).wgsl,
        });
      } catch (error) {
        throw new Error(
          `WGSL corpus: transpileGodotShaderWgsl refused "${shader.name}", which the WGSL tier is supposed to support: ${String(error)}`,
        );
      }
    }
    expect(modules.length).toBe(WGSL_CORPUS.length);

    const results = await withSidePage((page) =>
      page.evaluate(
        async (mods) =>
          (
            window as unknown as {
              __gswWebgpuParity: {
                validateWgslModules(mods: unknown): Promise<
                  Array<{
                    name: string;
                    errors: Array<{
                      severity: string;
                      message: string;
                      lineNum: number;
                      linePos: number;
                    }>;
                    warnings: Array<{ message: string; lineNum: number }>;
                  }>
                >;
              };
            }
          ).__gswWebgpuParity.validateWgslModules(mods),
        modules,
      ),
    );

    const wgslByName = new Map(modules.map((m) => [m.name, m.wgsl]));
    const lines: string[] = [];
    const failures: string[] = [];
    for (const result of results) {
      const wgsl = wgslByName.get(result.name) ?? "";
      lines.push(
        `  ${result.name.padEnd(24)} ${String(wgsl.split("\n").length).padStart(4)} ln  errors=${result.errors.length} warnings=${result.warnings.length}`,
      );
      for (const message of result.errors) {
        // The offending SOURCE LINE, not just its number: a WGSL error reported against a
        // generated module is unreadable without the text the compiler was looking at.
        const source = wgsl.split("\n")[message.lineNum - 1] ?? "";
        failures.push(
          `${result.name}:${message.lineNum}:${message.linePos} ${message.message}\n      | ${source.trim()}`,
        );
      }
    }
    summary.push(
      `\nWGSL corpus validation (chromium ${launchMode}):`,
      ...lines,
    );

    expect(
      failures,
      `the WGSL emitter produced modules a real WGSL compiler rejects:\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
    expect(
      results.length,
      "the page validated a different number of modules than were sent",
    ).toBe(modules.length);
  }, 120000);
});
