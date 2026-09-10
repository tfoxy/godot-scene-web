// @vitest-environment node
//
// NODE, not the repo-default jsdom: esbuild refuses to run under jsdom's globals (see
// `webgpuParityBrowser.test.ts`'s header), and the DOM under test is a real Chromium's anyway.
//
// THE ONE THING PIXEL READBACK CANNOT SEE.
//
// The parity suite (`webgpuParityBrowser.test.ts`) compares the two backends by READING TEXTURES —
// `copyTextureToBuffer` on the WebGPU side, `getImageData` on the WebGL side. That sees everything
// the fragment shader computed and NOTHING about how the canvas then reaches the page. The step it
// skips is the canvas→page COMPOSITE, and that step is configured by exactly two coupled decisions:
// `GPUCanvasContext.configure({ alphaMode })` and whether the WGSL returns premultiplied colour
// under a `one / one-minus-src-alpha` blend. Get the pairing wrong and the fragment output is still
// bit-perfect — readback still passes — while the screen shows a double-multiplied (too dark, too
// transparent) dot or a haloed one. No error is raised anywhere: `alphaMode` has no "wrong" value,
// only a differently-interpreted one.
//
// So this test renders through the REAL compositor and screenshots it: one WebGPU-rendered particle
// of known 50%-alpha white over a saturated page background, sampled at its centre. That is a
// two-line arithmetic check that no amount of texture readback can perform.
//
// WHY IT IS HEADED, AND WHY THAT NEEDS Xvfb. Measured on this box and recorded in
// docs/perf-harness.md (S7 reference section): headless Chrome acquires an adapter and accepts
// submits but NEVER composites a WebGPU canvas — the screenshot stays blank. Headed under
// `xvfb-run -a` it composites correctly. Hence the root script `pnpm test:webgpu-composite`, and
// hence `describe.skipIf(!process.env.DISPLAY)`: a plain `pnpm test` on a display-less box skips
// this file rather than failing it (the repo precedent for an environment-gated suite is
// `packages/perf-harness/test/device-adb-flow.test.ts`).
//
// SCOPE. Two pixels, three assertions, and the guard that the runtime really adopted WebGPU.
// Everything content-shaped — which fragment feature draws what — belongs to the parity suite,
// which can measure it far more precisely and without a display.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// TYPE-ONLY, and it must stay that way: `browser-entry.ts` writes to `window` at module scope, so a
// value import would run the page half inside vitest's node environment. Importing the shape rather
// than restating it is what keeps this file and the hook from drifting apart silently.
import type { MountedFixtureInfo } from "../src/webgpu-parity/browser-entry";
import type { ParityFixture } from "../src/webgpu-parity/fixtures";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The page background, and the whole reason the sample means anything.
 *
 * SATURATED and asymmetric on purpose: every channel sits far from both 0 and 255 and far from the
 * other two, so the correct composite, the double-multiply signature and "the canvas painted
 * nothing here" are three visibly different triples rather than three roundings of grey.
 */
const BG: [number, number, number] = [0xc0, 0x20, 0x40];

/** Per-channel byte tolerance. The chain quantises twice — the fragment's 0.5 becomes a byte in the
 *  swap-chain, and the compositor's blend of that byte over the background rounds again — so an
 *  exact equality would be asserting the rounding mode, not the alpha algebra. */
const TOLERANCE = 4;

/** The particle's alpha. 0.5 is the one value where "premultiplied once" and "premultiplied twice"
 *  are both representable and far apart (0.5 vs 0.25 of the source's contribution). */
const PARTICLE_ALPHA = 0.5;

/** Where the fixture host sits in the page. Off the viewport's corner so the canvas has page
 *  background on EVERY side — a canvas that washed the page would have nowhere to hide. */
const HOST_AT = { left: 160, top: 120 };

const VIEWPORT = { width: 800, height: 600 };

/**
 * ONE frozen, untextured, white, 50%-alpha dot, centred in its cell.
 *
 * Every field here exists to make the centre pixel a CONSTANT rather than a sample of a simulation:
 *
 * - `amount: 1` + no ramps and no curves ⇒ `updateDisplay` leaves the particle at exactly
 *   `baseColor`, so its colour is (1, 1, 1, 0.5) at every age. Nothing to time.
 * - zero velocity, zero gravity, point emission ⇒ it never leaves `originX/originY`, so its centre
 *   is the node's centre in PAGE coordinates, which is what the screenshot is sampled at.
 * - `scaleMin === scaleMax === DOT_SCALE` ⇒ the procedural dot's 16 px quad becomes 64 px. The
 *   fragment's coverage is `1 - smoothstep(0.7, 1.0, r)`, so coverage is exactly 1.0 everywhere
 *   within r < 0.7 — a 22 px radius here. Sampling is then immune to half-pixel questions about
 *   where the centre landed, which at the default 16 px it would not be.
 * - `staticParticles` (set by the browser entry's render options) warms once and parks: the frame
 *   under the screenshot is not being redrawn while the shot is taken.
 * - `preprocess` at half a lifetime puts the particle mid-flight, well clear of the birth/death
 *   boundary where `active` flips.
 */
const CELL_PX = 96;
const DOT_SCALE = 4;
const LIFETIME_S = 4;

const COMPOSITE_FIXTURE: ParityFixture = {
  kind: "particles",
  name: "composite-dot",
  cellPx: CELL_PX,
  spec: {
    kind: "CPUParticles2D",
    amount: 1,
    lifetime: LIFETIME_S,
    lifetimeRandomness: 0,
    oneShot: false,
    emitting: true,
    explosiveness: 0,
    randomness: 0,
    preprocess: LIFETIME_S / 2,
    speedScale: 1,
    fixedFps: 30,
    localCoords: false,
    seed: 20260820,
    emissionShape: 0,
    emissionOffset: [0, 0],
    direction: [0, -1],
    spread: 0,
    initialVelocityMin: 0,
    initialVelocityMax: 0,
    gravity: [0, 0],
    angleMin: 0,
    angleMax: 0,
    angularVelocityMin: 0,
    angularVelocityMax: 0,
    scaleMin: DOT_SCALE,
    scaleMax: DOT_SCALE,
    // White at 50% alpha: white keeps all three channels on the same arithmetic, so a channel that
    // disagrees is a channel-order bug rather than a colour that happened to round differently.
    baseColor: [1, 1, 1, PARTICLE_ALPHA],
    originX: CELL_PX / 2,
    originY: CELL_PX / 2,
    textureUrl: null,
    textureWidth: 0,
    textureHeight: 0,
    hframes: 1,
    vframes: 1,
    blendMode: 0,
  },
  images: [],
  // Unused: this file never diffs images. Stated because `ParityFixture` requires them.
  maxDiffRatio: 0,
  maxChannelDelta: 0,
};

let browser: Browser;
let page: Page;
/** Set when this box cannot run the test at all (no WebGPU in this Chromium) — see `beforeAll`. */
let skipReason: string | null = null;

describe.skipIf(!process.env.DISPLAY)("WebGPU canvas→page composite", () => {
  beforeAll(async () => {
    const bundle = await bundleBrowserEntry();
    browser = await chromium.launch({
      // HEADED (the whole point — see the header) and with the two switches that turn WebGPU on for
      // a SwiftShader/Vulkan box. On a machine with a real adapter they are harmless.
      headless: false,
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    });
    page = await browser.newPage({ viewport: VIEWPORT });
    page.on("pageerror", (error) => {
      console.error(`webgpu-composite page error: ${error.message}`);
    });

    // `webgpu/device.ts` DECLINES a fallback (CPU) adapter, exactly as `shared-gl.ts` declines
    // SwiftShader, and would then silently hand every binding to WebGL — which this test would then
    // measure under the name "webgpu". The escape hatch the module documents for precisely this case
    // (a headless/CI box whose only adapter is a software one) is set here, BEFORE the bundle runs.
    await page.addInitScript(() => {
      (globalThis as Record<string, unknown>).__gswForceWebgpuEffects = true;
    });

    // A REAL ORIGIN, not `about:blank`. Measured on this box: `page.setContent` leaves the page on
    // an opaque origin, `isSecureContext` is false, and Chrome then does not expose `navigator.gpu`
    // AT ALL — the WebGPU runtime would fall back to WebGL for reason `no-navigator-gpu` and the
    // composite this file exists to check would never be exercised. `http://localhost` is a
    // trustworthy origin, and route-fulfilling it needs no server.
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:rgb(${BG.join(",")})}</style></head><body></body></html>`,
      }),
    );
    await page.goto("http://localhost/gsw-webgpu-composite");
    await page.addScriptTag({ content: bundle, type: "module" });
    await page.waitForFunction(() => "__gswWebgpuParity" in window, undefined, {
      timeout: 15000,
    });

    const available = await page.evaluate(() =>
      (
        window as unknown as {
          __gswWebgpuParity: { hasWebgpu(): Promise<boolean> };
        }
      ).__gswWebgpuParity.hasWebgpu(),
    );
    if (!available) {
      skipReason =
        "no WebGPU adapter in this headed Chromium (needs --enable-unsafe-webgpu --enable-features=Vulkan and, on a display-less box, a working SwiftShader Vulkan)";
    }
  }, 180000);

  afterAll(async () => {
    await browser?.close();
  });

  it("composites a 50%-alpha WebGPU dot over the page background", async (ctx) => {
    if (skipReason) {
      ctx.skip(skipReason);
      return;
    }

    const mounted = await page.evaluate(
      async ([fixture, at]) =>
        (
          window as unknown as {
            __gswWebgpuParity: {
              mountFixture(
                fixture: unknown,
                side: unknown,
                at: unknown,
              ): Promise<MountedFixtureInfo>;
            };
          }
        ).__gswWebgpuParity.mountFixture(
          fixture,
          { effectsRenderer: "webgpu" },
          at,
        ),
      [COMPOSITE_FIXTURE, HOST_AT] as const,
    );

    // FAIL LOUDLY, do not skip. The runtime's WebGPU gate is silent by design: no adapter, a
    // fallback adapter, a pipeline error — each quietly becomes WebGL and keeps drawing. A composite
    // test that accepted that would be asserting `<canvas>`-2D compositing, which nobody doubts, and
    // reporting it as WebGPU alphaMode coverage.
    expect(
      mounted.renderer,
      `the runtime did not adopt WebGPU (renderer=${mounted.renderer}, webgpuFallbacks=${mounted.webgpuFallbacks}, reason=${mounted.webgpuFallbackReason}) — this box reports a WebGPU adapter, so a fallback here is a real regression, not an environment gap`,
    ).toBe("webgpu");
    expect(mounted.renders).toBeGreaterThan(0);
    expect(mounted.draws).toBeGreaterThan(0);

    const shot = await page.screenshot();
    const { data, info } = await sharp(shot)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(
      { width: info.width, height: info.height },
      "the screenshot is not 1:1 with CSS pixels — every sample coordinate below assumes deviceScaleFactor 1",
    ).toEqual(VIEWPORT);

    const pixel = (x: number, y: number): [number, number, number] => {
      const at = (y * info.width + x) * info.channels;
      return [data[at], data[at + 1], data[at + 2]];
    };

    // The dot's centre, in PAGE pixels: the node's own rect (read from the live DOM, not computed
    // from the runtime's internals) plus the emitter origin the fixture pinned. The particle never
    // moves, so this is where it is.
    const centreX = Math.floor(mounted.node.left + CELL_PX / 2);
    const centreY = Math.floor(mounted.node.top + CELL_PX / 2);

    // The background sample sits INSIDE the canvas rect but far outside the dot. Inside, because a
    // point sampled off the canvas entirely would only prove the page's own background renders;
    // what is under test is that the canvas is TRANSPARENT where nothing was drawn — an
    // `alphaMode: "opaque"` canvas, or a clear to opaque black, would wash exactly here.
    const offX = Math.floor(mounted.canvas.left + 3);
    const offY = Math.floor(mounted.canvas.top + 3);
    const offDistance = Math.hypot(offX - centreX, offY - centreY);
    expect(
      offDistance,
      `the off-dot sample (${offX}, ${offY}) is only ${offDistance.toFixed(1)} px from the dot centre — it must be clear of the ${DOT_SCALE * 16} px quad for "no wash" to mean anything`,
    ).toBeGreaterThan((DOT_SCALE * 16) / 2 + 8);
    expect(
      offX >= 0 && offY >= 0 && offX < info.width && offY < info.height,
      "the off-dot sample fell outside the viewport",
    ).toBe(true);

    const centre = pixel(centreX, centreY);
    const off = pixel(offX, offY);

    // src-over with a source that is 50% white: `0.5*255 + 0.5*bg` per channel. This is what the
    // shipped pairing (premultiplied WGSL output + one/one-minus-src-alpha + alphaMode
    // "premultiplied") must produce on screen.
    const expected = BG.map(
      (c) => PARTICLE_ALPHA * 255 + (1 - PARTICLE_ALPHA) * c,
    );
    // The DOUBLE-MULTIPLY signature: a premultiplied fragment blended AGAIN by src-alpha leaves
    // (0.25, 0.25, 0.25, 0.25) in the swap chain, which src-overs to `0.25*255 + 0.75*bg`.
    const doubleMultiplied = BG.map(
      (c) => PARTICLE_ALPHA ** 2 * 255 + (1 - PARTICLE_ALPHA ** 2) * c,
    );

    console.log(
      `webgpu-composite: bg=${BG.join(",")} centre=(${centreX},${centreY}) sampled=${centre.join(",")} expected≈${expected.map((v) => v.toFixed(1)).join(",")} double-multiply-signature≈${doubleMultiplied.map((v) => v.toFixed(1)).join(",")} off-dot=(${offX},${offY}) sampled=${off.join(",")} renderer=${mounted.renderer}`,
    );

    // The two expectations must be TELLABLE APART at this tolerance, or the test would pass whatever
    // the renderer did. Asserted, not assumed: it depends on BG, on the alpha and on the tolerance,
    // any of which a later edit could move.
    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(expected[channel] - doubleMultiplied[channel]),
        `channel ${channel}: the correct composite and the double-multiply signature are within ${2 * TOLERANCE} of each other — this test cannot distinguish them; pick a more saturated background or a tighter tolerance`,
      ).toBeGreaterThan(2 * TOLERANCE);
    }

    for (let channel = 0; channel < 3; channel++) {
      // (a) The composite is right.
      expect(
        Math.abs(centre[channel] - expected[channel]),
        `channel ${channel} at the dot centre: got ${centre[channel]}, expected ${expected[channel].toFixed(1)} (0.5*255 + 0.5*bg). Landing near the double-multiply signature (${doubleMultiplied[channel].toFixed(1)}) instead means the WGSL premultiply and the pipeline blend are paired wrong, or the canvas alphaMode is not "premultiplied" — readback cannot see either.`,
      ).toBeLessThanOrEqual(TOLERANCE);

      // (b) …and it is not the failure that looks like it.
      expect(
        Math.abs(centre[channel] - doubleMultiplied[channel]),
        `channel ${channel} at the dot centre: ${centre[channel]} matches the DOUBLE-MULTIPLY signature ${doubleMultiplied[channel].toFixed(1)}`,
      ).toBeGreaterThan(TOLERANCE);

      // (c) The canvas is transparent where nothing was drawn — no wash, no halo.
      expect(
        Math.abs(off[channel] - BG[channel]),
        `channel ${channel} off the dot: got ${off[channel]}, expected the untouched page background ${BG[channel]} — the WebGPU canvas is tinting the page where it drew nothing`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 120000);
});

/** esbuild on the perf-harness recipe, same as the parity suite's: `conditions: ["development"]` is
 *  what makes `@godot-scene-web/html` resolve to its TypeScript SOURCE, so the page mounts the
 *  shipped code rather than a `dist/` that may not even be built. */
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
      "webgpu-composite: esbuild produced no output for the browser entry",
    );
  }
  return file.text;
}
