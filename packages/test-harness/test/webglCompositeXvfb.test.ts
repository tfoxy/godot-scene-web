// @vitest-environment node
//
// NODE, not the repo-default jsdom: esbuild refuses to run under jsdom's globals (see
// `webgpuParityBrowser.test.ts`'s header), and the DOM under test is a real Chromium's anyway.
//
// THE WEBGL TWIN OF `webgpuCompositeXvfb.test.ts`, AND THE SAME BLIND SPOT.
//
// Read that file first: it explains why the canvas→page COMPOSITE cannot be reached by reading
// textures, and why reaching it needs a HEADED browser under Xvfb. Everything structural here is
// borrowed from it — the saturated background, the frozen one-particle fixture, the route-fulfilled
// `http://localhost` origin, the `DISPLAY` gate.
//
// WHAT IS DIFFERENT, AND WHY THIS FILE HAD TO EXIST. The WebGPU sibling checks a contract that is
// stated in two places at once (`GPUCanvasContext.configure({ alphaMode })` and the WGSL's return),
// and it checks it only for `effectsRenderer: "webgpu"`. The WebGL path has the SAME contract stated
// in the same two-places-at-once way — `getContext("webgl2", { premultipliedAlpha })` in
// `webgl/shared-gl.ts` and what each fragment shader writes — and nothing anywhere asserted their
// agreement. It did not agree: the canvas was declared STRAIGHT while the particle MIX path put
// PREMULTIPLIED content in it, because `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, …)` over
// a cleared buffer IS a premultiplying operation. Nothing errors; the browser simply believes the
// declaration and multiplies by alpha once more on the way out.
//
// WHERE THE EXTRA MULTIPLY LANDS, which is why the arithmetic below is NOT the sibling's. On the
// WebGPU side a double-multiply hits colour AND alpha (both go through the same `src-alpha` blend),
// so the signature is `a²·255 + (1−a²)·bg`. Here it hits COLOUR ONLY: the alpha channel's src factor
// is already Godot's `ONE`, so the node canvas ends at `(c·a², a)` and composites to
// `a²·255 + (1−a)·bg`. Both are asserted against below; only the second is the failure this file was
// written for.
//
// SCOPE. Two dots — MIX and ADD — sampled at their centres. MIX is the bug; ADD is its regression
// guard, because the additive resolve pass compensates for the blit's multiply by pre-dividing
// (`light / cov`), so a fix to the MIX path that forgot the resolve would blow every glow out to
// white. Everything content-shaped belongs to `webgpuParityBrowser.test.ts`.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// TYPE-ONLY, and it must stay that way: `browser-entry.ts` writes to `window` at module scope, so a
// value import would run the page half inside vitest's node environment.
import type { MountedFixtureInfo } from "../src/webgpu-parity/browser-entry";
import type { ParityFixture } from "../src/webgpu-parity/fixtures";

const here = dirname(fileURLToPath(import.meta.url));

/** The page background — saturated and asymmetric, for the sibling's reasons. */
const BG: [number, number, number] = [0xc0, 0x20, 0x40];

/** Per-channel byte tolerance. The chain quantises twice (the fragment's 0.5 becomes a byte in the
 *  drawing buffer, and the compositor's blend of that byte over the background rounds again), so an
 *  exact equality would be asserting the rounding mode rather than the alpha algebra. */
const TOLERANCE = 4;

/** The particle's alpha. 0.5 is the one value where "multiplied once" and "multiplied twice" are
 *  both representable and far apart. */
const PARTICLE_ALPHA = 0.5;

/** Where the fixture host sits. Off the viewport's corner so the canvas has page background on
 *  EVERY side — a canvas that washed the page would have nowhere to hide. */
const HOST_AT = { left: 160, top: 120 };

const VIEWPORT = { width: 800, height: 600 };

const CELL_PX = 96;
const DOT_SCALE = 4;
const LIFETIME_S = 4;

/**
 * ONE frozen, untextured, white, 50%-alpha dot, centred in its cell — the sibling's fixture, with
 * `blendMode` left open so the same constant serves both clusters.
 *
 * Every field exists to make the centre pixel a CONSTANT rather than a sample of a simulation:
 * `amount: 1` with no ramps or curves pins the colour at `baseColor` for every age; zero velocity,
 * gravity and spread keep it at `originX/originY`; `scaleMin === scaleMax === DOT_SCALE` blows the
 * procedural dot's 16 px quad up to 64 px so the `1 - smoothstep(0.7, 1.0, r)` coverage is exactly
 * 1.0 across a 22 px radius and the sample is immune to half-pixel questions; `preprocess` at half a
 * lifetime puts it mid-flight, clear of the birth/death boundary.
 */
function compositeFixture(name: string, blendMode: number): ParityFixture {
  return {
    kind: "particles",
    name,
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
      // White at 50% alpha: white keeps all three channels on the same arithmetic, so a channel
      // that disagrees is a channel-order bug rather than a colour that rounded differently.
      baseColor: [1, 1, 1, PARTICLE_ALPHA],
      originX: CELL_PX / 2,
      originY: CELL_PX / 2,
      textureUrl: null,
      textureWidth: 0,
      textureHeight: 0,
      hframes: 1,
      vframes: 1,
      blendMode,
    },
    images: [],
    // Unused: this file never diffs images. Stated because `ParityFixture` requires it.
    maxDiffRatio: 0,
    maxChannelDelta: 0,
  };
}

const MIX_FIXTURE = compositeFixture("composite-dot-mix", 0);
const ADD_FIXTURE = compositeFixture("composite-dot-add", 1);

/**
 * NO CHROME FLAGS AT ALL — and that is a measurement, not an omission.
 *
 * The sibling launches with `--enable-unsafe-webgpu --enable-features=Vulkan`, which it needs to get
 * a WebGPU adapter. Passing the same pair here BREAKS THE THING UNDER TEST. Measured on this box
 * (headed Chromium under Xvfb, real NVIDIA adapter), with everything else held constant:
 *
 *   flags                                blit `drawImage(glCanvas)`   a WebGL canvas on the page
 *   ---------------------------------    --------------------------   --------------------------
 *   (none)                               [64,127,191,255]  correct    composites correctly
 *   --enable-unsafe-webgpu               [64,127,191,255]  correct    composites correctly
 *   --enable-features=Vulkan             [0,0,0,0]         BLANK      invisible
 *   both                                 [0,0,0,0]         BLANK      invisible
 *
 * `--enable-features=Vulkan` moves Chrome's whole GPU stack onto Vulkan, and on this driver a WebGL
 * canvas then yields NOTHING to `drawImage` — not a wrong colour, a fully transparent destination,
 * while `gl.readPixels` on the same pixel in the same task returns the right bytes. Since the entire
 * shipped WebGL pipeline is "render into one shared GL canvas, blit onto per-node 2D canvases", that
 * flag makes every effect on the page blank. (This is almost certainly what
 * `webgpuParityBrowser.test.ts`'s launch ladder recorded as "headed: the WebGL side comes back
 * EMPTY" — its every rung carries the flag, so headed was blamed for what the flag did.)
 *
 * `beforeAll` VERIFIES the blit round-trips before any assertion runs rather than trusting this
 * comment: a silently blank canvas is exactly the shape of failure this file would otherwise
 * misreport as an alpha bug.
 */
const CHROME_ARGS: string[] = [];

let browser: Browser;
/** The bundled browser entry, kept so every fixture can open its own page (see `openPage`). */
let bundleText: string;
/** Set when this box cannot run the test at all — see `beforeAll`. */
let skipReason: string | null = null;

describe.skipIf(!process.env.DISPLAY)("WebGL canvas→page composite", () => {
  beforeAll(async () => {
    bundleText = await bundleBrowserEntry();
    browser = await chromium.launch({
      // HEADED, like the sibling. WebGL renders headless too, but the COMPOSITOR is the thing under
      // test and only a headed browser has one that a screenshot can see.
      headless: false,
      args: CHROME_ARGS,
    });

    // THE CANARY: can a WebGL canvas be blitted onto a 2D canvas in this browser at all? See
    // `CHROME_ARGS`. Raw, in the page, with no runtime involved — a clear to a known colour, one
    // `drawImage`, one `getImageData` — so a failure here is unambiguously the environment.
    const page = await openPage();
    try {
      const blit = await page.evaluate(() => {
        const source = document.createElement("canvas");
        source.width = 8;
        source.height = 8;
        const gl = source.getContext("webgl2", { alpha: true });
        if (!gl) return "no webgl2 in this browser";
        gl.viewport(0, 0, 8, 8);
        gl.clearColor(0.25, 0.5, 0.75, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const target = document.createElement("canvas");
        target.width = 8;
        target.height = 8;
        const ctx = target.getContext("2d");
        if (!ctx) return "no 2d context in this browser";
        ctx.drawImage(source, 0, 0);
        return [...ctx.getImageData(4, 4, 1, 1).data];
      });
      console.log(`webgl-composite blit canary: ${JSON.stringify(blit)}`);
      if (typeof blit === "string" || blit[3] === 0) {
        skipReason =
          `this browser cannot blit a WebGL canvas onto a 2D canvas (probe read ${JSON.stringify(blit)}, expected roughly [64, 128, 191, 255]) — ` +
          "the shipped WebGL path is exactly that blit, so every canvas would be blank and every assertion below would misreport it as an alpha bug";
      }
    } finally {
      await page.close();
    }
  }, 180000);

  afterAll(async () => {
    await browser?.close();
  });

  it("composites a 50%-alpha WebGL MIX dot over the page background", async (ctx) => {
    if (skipReason) {
      ctx.skip(skipReason);
      return;
    }
    const { centre, off, mounted } = await sampleDot(MIX_FIXTURE);

    // src-over with a source that is 50% white: `0.5*255 + 0.5*bg` per channel. This is what a
    // canvas whose declared alpha mode MATCHES what its fragments write must produce on screen.
    const expected = BG.map(
      (c) => PARTICLE_ALPHA * 255 + (1 - PARTICLE_ALPHA) * c,
    );
    // THE FAILURE SIGNATURE THIS FILE EXISTS FOR. A premultiplied `(c·a, a)` drawing buffer declared
    // STRAIGHT is multiplied by alpha once more when `drawImage` converts it into the node's 2D
    // canvas, landing `(c·a², a)`. The ALPHA is untouched (its blend src factor is Godot's `ONE`),
    // so the composite is `a²*255 + (1−a)*bg` — darker than correct at the same coverage.
    const colourDoubleMultiplied = BG.map(
      (c) => PARTICLE_ALPHA ** 2 * 255 + (1 - PARTICLE_ALPHA) * c,
    );
    // The sibling's signature, where alpha is multiplied twice as well. Not reachable on this path
    // — the alpha src factor is ONE — but asserted against so a future change to `blendFactorsFor`
    // that reverted the separate-alpha fix would be named rather than merely "not expected".
    const fullyDoubleMultiplied = BG.map(
      (c) => PARTICLE_ALPHA ** 2 * 255 + (1 - PARTICLE_ALPHA ** 2) * c,
    );

    console.log(
      `webgl-composite MIX: bg=${BG.join(",")} sampled=${centre.join(",")} expected≈${fmt(expected)} colour-double-multiply≈${fmt(colourDoubleMultiplied)} full-double-multiply≈${fmt(fullyDoubleMultiplied)} off-dot=${off.join(",")} renderer=${mounted.renderer}`,
    );

    assertDistinguishable(expected, colourDoubleMultiplied, "colour-double");
    assertDistinguishable(expected, fullyDoubleMultiplied, "full-double");

    for (let channel = 0; channel < 3; channel++) {
      // (a) The composite is right.
      expect(
        Math.abs(centre[channel] - expected[channel]),
        `channel ${channel} at the MIX dot centre: got ${centre[channel]}, expected ${expected[channel].toFixed(1)} (0.5*255 + 0.5*bg). Landing near ${colourDoubleMultiplied[channel].toFixed(1)} instead means the shared canvas's declared \`premultipliedAlpha\` disagrees with what the particle fragment writes into it, so the blit into the node canvas multiplies by alpha a second time — readback of either canvas cannot see this.`,
      ).toBeLessThanOrEqual(TOLERANCE);

      // (b) …and it is neither of the failures that look like it.
      expect(
        Math.abs(centre[channel] - colourDoubleMultiplied[channel]),
        `channel ${channel} at the MIX dot centre: ${centre[channel]} matches the COLOUR-DOUBLE-MULTIPLY signature ${colourDoubleMultiplied[channel].toFixed(1)}`,
      ).toBeGreaterThan(TOLERANCE);
      expect(
        Math.abs(centre[channel] - fullyDoubleMultiplied[channel]),
        `channel ${channel} at the MIX dot centre: ${centre[channel]} matches the FULL-DOUBLE-MULTIPLY signature ${fullyDoubleMultiplied[channel].toFixed(1)} — colour AND alpha were multiplied twice, i.e. the alpha channel's blend src factor is no longer ONE`,
      ).toBeGreaterThan(TOLERANCE);

      // (c) The canvas is transparent where nothing was drawn — no wash, no halo.
      expect(
        Math.abs(off[channel] - BG[channel]),
        `channel ${channel} off the MIX dot: got ${off[channel]}, expected the untouched page background ${BG[channel]} — the WebGL canvas is tinting the page where it drew nothing`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 120000);

  it("composites a 50%-alpha WebGL ADDITIVE dot at the same brightness", async (ctx) => {
    if (skipReason) {
      ctx.skip(skipReason);
      return;
    }
    const { centre, off, mounted } = await sampleDot(ADD_FIXTURE);

    // ONE white particle at 50% alpha contributes light = `rgb * a` = 0.5, and the resolve pass's
    // coverage is the peak channel = 0.5 — so a correct additive canvas composites to EXACTLY the
    // MIX expectation. That coincidence is what makes this a usable regression guard: the additive
    // path reaches the same number by a completely different route (accumulate ONE/ONE into an FBO,
    // then resolve), and the route is where a half-done alpha-contract change breaks.
    const expected = BG.map(
      (c) => PARTICLE_ALPHA * 255 + (1 - PARTICLE_ALPHA) * c,
    );
    // THE UN-COMPENSATED RESOLVE. The resolve either divides the accumulated light by coverage (for
    // a straight-alpha canvas, where the blit multiplies it back) or does not (for a premultiplied
    // one, where nothing does). Pick the wrong one for the declared canvas and the light is
    // presented UNDIVIDED at full intensity: `1.0*255 + (1−cov)*bg`, i.e. a blown-out glow.
    const blownOut = BG.map((c) => 255 + (1 - PARTICLE_ALPHA) * c);

    console.log(
      `webgl-composite ADD: bg=${BG.join(",")} sampled=${centre.join(",")} expected≈${fmt(expected)} undivided-light≈${fmt(blownOut)} off-dot=${off.join(",")} renderer=${mounted.renderer}`,
    );

    for (let channel = 0; channel < 3; channel++) {
      expect(
        Math.abs(centre[channel] - expected[channel]),
        `channel ${channel} at the ADD dot centre: got ${centre[channel]}, expected ${expected[channel].toFixed(1)}. One 50%-alpha white particle carries light 0.5 at coverage 0.5, so the additive resolve must present the same composite the MIX path does; ${Math.min(255, blownOut[channel]).toFixed(1)} would mean the resolve's divide-by-coverage no longer matches what the canvas's declared alpha mode does to the blit.`,
      ).toBeLessThanOrEqual(TOLERANCE);

      expect(
        Math.abs(off[channel] - BG[channel]),
        `channel ${channel} off the ADD dot: got ${off[channel]}, expected the untouched page background ${BG[channel]}`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  }, 120000);
});

/**
 * A page of its very own, on a REAL ORIGIN.
 *
 * `http://localhost` rather than `about:blank`/`page.setContent` for the sibling's reason (a
 * setContent page is not a secure context), route-fulfilled so it needs no server.
 *
 * ONE FIXTURE PER PAGE, and this is load-bearing rather than hygiene. `mountFixture` KEEPS its
 * runtime alive so the frame is still there when the screenshot is taken, and every mount lands its
 * host at the coordinates it was given — so a second fixture on the same page STACKS its canvas on
 * whatever is already there. Measured: an additive dot mounted after a mix dot sampled
 * (199, 179, 183) instead of (223.5, 143.5, 159.5), which is exactly two mix canvases composited
 * under the additive one. Every number this file asserts assumes the page background is directly
 * behind the canvas under test.
 */
async function openPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.on("pageerror", (error) => {
    console.error(`webgl-composite page error: ${error.message}`);
  });
  await page.route("**/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:rgb(${BG.join(",")})}</style></head><body></body></html>`,
    }),
  );
  await page.goto("http://localhost/gsw-webgl-composite");
  await page.addScriptTag({ content: bundleText, type: "module" });
  await page.waitForFunction(() => "__gswWebgpuParity" in window, undefined, {
    timeout: 15000,
  });
  return page;
}

/** Mount `fixture` on a page of its own, screenshot it, and return the dot's centre pixel plus a
 *  pixel inside the canvas but well clear of the dot. */
async function sampleDot(fixture: ParityFixture): Promise<{
  centre: [number, number, number];
  off: [number, number, number];
  mounted: MountedFixtureInfo;
}> {
  const page = await openPage();
  try {
    return await sampleDotOn(page, fixture);
  } finally {
    await page.close();
  }
}

async function sampleDotOn(
  page: Page,
  fixture: ParityFixture,
): Promise<{
  centre: [number, number, number];
  off: [number, number, number];
  mounted: MountedFixtureInfo;
}> {
  const mounted = await page.evaluate(
    async ([fixtureArg, atArg]) =>
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
        fixtureArg,
        { effectsRenderer: "webgl" },
        atArg,
      ),
    [fixture, HOST_AT] as const,
  );

  // FAIL LOUDLY, do not skip. `effectsRenderer: "webgl"` is a pin, not a preference; a run that
  // ended up on some other backend would be measuring something this file makes no claim about.
  expect(
    mounted.renderer,
    `the runtime did not adopt WebGL (renderer=${mounted.renderer}) — the side is pinned explicitly, so anything else is a regression in the option, not an environment gap`,
  ).toBe("webgl");
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
    const index = (y * info.width + x) * info.channels;
    return [data[index], data[index + 1], data[index + 2]];
  };

  // The dot's centre, in PAGE pixels: the node's own rect (read from the live DOM, not computed
  // from the runtime's internals) plus the emitter origin the fixture pinned.
  const centreX = Math.floor(mounted.node.left + CELL_PX / 2);
  const centreY = Math.floor(mounted.node.top + CELL_PX / 2);

  // The background sample sits INSIDE the canvas rect but far outside the dot: what is under test
  // is that the canvas is TRANSPARENT where nothing was drawn, which a point off the canvas
  // entirely could not show.
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

  return { centre: pixel(centreX, centreY), off: pixel(offX, offY), mounted };
}

/** The correct composite and a failure signature must be TELLABLE APART at this tolerance, or the
 *  assertion pair below would pass whatever the renderer did. Asserted, not assumed: it depends on
 *  BG, on the alpha and on the tolerance, any of which a later edit could move. */
function assertDistinguishable(
  expected: number[],
  signature: number[],
  label: string,
): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(
      Math.abs(expected[channel] - signature[channel]),
      `channel ${channel}: the correct composite and the ${label} signature are within ${2 * TOLERANCE} of each other — this test cannot distinguish them; pick a more saturated background or a tighter tolerance`,
    ).toBeGreaterThan(2 * TOLERANCE);
  }
}

function fmt(values: number[]): string {
  return values.map((v) => v.toFixed(1)).join(",");
}

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
      "webgl-composite: esbuild produced no output for the browser entry",
    );
  }
  return file.text;
}
