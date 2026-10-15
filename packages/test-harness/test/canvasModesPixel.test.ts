// @vitest-environment node
//
// PIXELS OF `@godot-scene-web/canvas`'S OPT-IN GODOT MODES, ON A REAL GPU, HELD
// TO A CHANNEL BUDGET OF 0 AGAINST CPU MODELS.
//
//   vertexGradient     per-vertex colours are interpolated STRAIGHT and
//                      premultiplied per fragment (Godot's color_interp)
//   vertexTextured     straight texel x straight vertex colour x premul tint
//   premultipliedSource  Godot PREMULT_ALPHA as MIX over premultiplied data:
//                      no alpha applied by the executor; MIX-straight does
//   wrap               clamp / repeat / mirror x linear / nearest, across both
//                      texture edges, through WebGL2 sampler objects
//   straightFilter     a straight-stored page is filtered THEN premultiplied
//   ...PremultipliedUpload  the sabotage: premultiply on upload, which must miss
//                      the straight prediction by more than one level
//   rgb10a2Ramp        every 10-bit level stored exactly, and its 8-bit readback
//   rgb10a2Stack       blending at 10-bit precision, 2-bit alpha
//
// EVERY PREDICTION IS A MODEL WRITTEN HERE, from `../src/canvas-pixel/modes-cases`
// (inputs only) and the GL ES 3.0 rules it names: never from a GPU run. A pixel
// whose model value sits within a hair of a rounding boundary is "undecided": it
// may differ by 1, and it is counted and printed rather than hidden. By
// construction no case has one except where a case says so.
//
// Every comparison is `compareRgbaBuffers` with `maxChannelDelta: 0` AND
// `maxDiffRatio: 0`, alpha included (memory pixelmatch-hides-alpha-errors:
// pixelmatch alone cannot see an alpha-convention error).
//
// LAUNCH: `--headless=new --enable-gpu --use-angle=vulkan` (the real GPU, no
// window), never headed and never under Xvfb on this box. Opt in with
// GSW_CANVAS_MODES_PIXEL=1, as the glyph pixel suite does.
//
// Artifacts (never committed): `artifacts/canvas-modes-pixel/<case>-<frame>-{actual,expected}.png`.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FILTER_QUAD_HEIGHT,
  FILTER_QUAD_WIDTH,
  FILTER_TEXELS,
  GRADIENT_LEFT,
  GRADIENT_RIGHT,
  MODES_STAGE,
  PREMUL_BACKGROUND,
  PREMUL_MODULATE,
  PREMUL_TEXEL,
  PREMUL_VERTEX,
  RAMP_HEIGHT,
  RAMP_WIDTH,
  type Rgba,
  rampLevels,
  STACK_BASE,
  STACK_LAYER_ALPHA,
  STACK_LAYER_COLOUR,
  STACK_LAYERS,
  STACK_TRANSLUCENT,
  TEXTURED_MODULATE,
  TEXTURED_TEXEL,
  TEXTURED_VERTEX,
  WRAP_BAND_ROWS,
  WRAP_BANDS,
  WRAP_QUAD_WIDTH,
  WRAP_SRC_W,
  WRAP_SRC_X,
  WRAP_TEXELS,
} from "../src/canvas-pixel/modes-cases";
// TYPE-ONLY: the entry writes to `window` at module scope.
import type {
  ModesCaseResult,
  ModesFrame,
} from "../src/canvas-pixel/modes-entry";
import { compareRgbaBuffers } from "../src/image-diff";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(
  here,
  "..",
  "..",
  "..",
  "artifacts",
  "canvas-modes-pixel",
);
const ENABLED = process.env.GSW_CANVAS_MODES_PIXEL === "1";

// ---- the arithmetic every model shares ------------------------------------

const f32 = Math.fround;
/** GL ES 3.0 §2.1.6.2: float -> normalized fixed point rounds to nearest. */
const toLevel = (value: number, levels: number): number =>
  Math.floor(Math.min(1, Math.max(0, value)) * levels + 0.5);
/**
 * How close to a `.5` (in target levels) a model value may come and still be
 * called decided. Constant-colour shading is float32-exact to ~1e-6 of a level.
 * INTERPOLATED vertex colours are not: measured on the RTX 2060 through
 * ANGLE/Vulkan, a gradient value of 55.5167 levels came back 55, so the
 * rasterizer's attribute interpolation is only good to a few hundredths of a
 * level. That is the contract's `delta1` class for vertex-colour interpolation
 * (gate7-design.md Q7, P-G3), and the gradient case uses the wider margin.
 */
const MARGIN = 0.01;
const INTERPOLATED_MARGIN = 0.05;
/**
 * The 2-bit alpha of an RGB10_A2 target, written through the blend: Vulkan lets
 * a float -> fixed-point conversion return EITHER of the two nearest levels
 * (`convertFloatToUint`, "should" round to nearest), and on this GPU the 2-bit
 * thresholds measure at 3/16, 1/2 and 13/16 of full scale rather than the
 * midpoints 1/6, 1/2 and 5/6. A value within 1/16 of a level of a midpoint is
 * therefore undecided, and the measured level is reported, not predicted.
 */
const TWO_BIT_MARGIN = 1 / 16;
const isDecided = (value: number, levels: number, margin = MARGIN): boolean => {
  const scaled = Math.min(1, Math.max(0, value)) * levels;
  return Math.abs(scaled - Math.floor(scaled) - 0.5) > margin;
};
const unit = (texel: Rgba): Rgba =>
  texel.map((v) => v / 255) as unknown as Rgba;
const premul = (c: Rgba): Rgba => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
const mul = (a: Rgba, b: Rgba): Rgba => [
  a[0] * b[0],
  a[1] * b[1],
  a[2] * b[2],
  a[3] * b[3],
];
const f32Rgba = (c: Rgba): Rgba => c.map(f32) as unknown as Rgba;
/**
 * Premultiplied MIX, `src + dst * (1 - src.a)`, with the source COLOUR first
 * converted to the target's colour levels. Vulkan only requires blending at "a
 * precision and dynamic range no lower than that used to represent destination
 * components", and this GPU MEASURES at exactly that: a MIX whose shader output
 * was 50.196 levels of red over a 25.4-level destination term came back 75, not
 * the float sum's 75.596, and an 8-bit stack of 0.08 layers climbs as if each
 * layer were 20/255. Alpha is NOT quantized first (an RGB10_A2 stack of alpha
 * 0.2 layers composites as 0.2, not as its 2-bit 1/3). A source already on a
 * level, like every premultiplied-source band here, is unaffected.
 *
 * This is the one-level difference gate7-design.md Q7 pre-registers as `delta1`
 * for translucent blends: Godot multiplies by alpha in the blend unit, after
 * that conversion; this executor multiplies in the shader, before it.
 */
const mix = (src: Rgba, dst: Rgba, colourLevels = 255): Rgba => {
  const q = (v: number): number => toLevel(v, colourLevels) / colourLevels;
  const source: Rgba = [q(src[0]), q(src[1]), q(src[2]), src[3]];
  return source.map((v, i) => v + dst[i] * (1 - src[3])) as unknown as Rgba;
};

/** `textures.ts`'s exact integer premultiply, `round(c * a / 255)`. */
function premultiplyByte(channel: number, alpha: number): number {
  const t = channel * alpha + 0x80;
  return (t + (t >> 8)) >> 8;
}

/** GL ES 3.0 §3.8.10 wrap of an integer texel coordinate. */
function wrapIndex(
  i: number,
  size: number,
  wrap: "clamp" | "repeat" | "mirror",
): number {
  if (wrap === "clamp") return Math.min(size - 1, Math.max(0, i));
  if (wrap === "repeat") return ((i % size) + size) % size;
  const mirror = (a: number): number => (a >= 0 ? a : -(1 + a));
  const m = ((i % (2 * size)) + 2 * size) % (2 * size);
  return size - 1 - mirror(m - size);
}

interface Prediction {
  width: number;
  height: number;
  /** Target levels per channel: 0..255, or 0..1023 / 0..3 for 10/10/10/2. */
  data: Uint16Array;
  /** 1 where a pixel is undecided (allowed to differ by 1). */
  undecided: Uint8Array;
}

function prediction(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba | null,
  levels: readonly [number, number, number, number] = [255, 255, 255, 255],
  margin = MARGIN,
): Prediction {
  const data = new Uint16Array(width * height * 4);
  const undecided = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y);
      if (!value) continue;
      const at = y * width + x;
      for (let c = 0; c < 4; c += 1) {
        data[at * 4 + c] = toLevel(value[c], levels[c]);
        if (!isDecided(value[c], levels[c], margin)) undecided[at] = 1;
      }
    }
  }
  return { width, height, data, undecided };
}

/** Requantize a 10/10/10/2 prediction to its 8-bit readback, `round(v*255/max)`. */
function readback8(levels: Prediction): Prediction {
  const data = new Uint16Array(levels.data.length);
  for (let i = 0; i < data.length; i += 1) {
    const max = i % 4 === 3 ? 3 : 1023;
    data[i] = Math.floor((levels.data[i] * 255) / max + 0.5);
  }
  return { ...levels, data };
}

interface Verdict {
  maxDelta: number;
  differing: number;
  undecided: number;
  worst?: string;
}

async function judge(
  name: string,
  expected: Prediction,
  frame: ModesFrame,
  budget = 0,
): Promise<Verdict> {
  const actual = Uint8Array.from(frame.data);
  // Undecided pixels may differ by one level: copy the measured byte into the
  // comparison's expected side ONLY when it is within that one level.
  const compared = Uint8Array.from(expected.data);
  if (expected.data.some((v) => v > 255)) {
    throw new Error(`${name}: judge() compares 8-bit frames; requantize first`);
  }
  let undecided = 0;
  for (let p = 0; p < expected.undecided.length; p += 1) {
    if (!expected.undecided[p]) continue;
    undecided += 1;
    for (let c = 0; c < 4; c += 1) {
      const i = p * 4 + c;
      if (Math.abs(actual[i] - compared[i]) <= 1) compared[i] = actual[i];
    }
  }
  await mkdir(ARTIFACTS, { recursive: true });
  const raw = {
    width: frame.width,
    height: frame.height,
    channels: 4,
  } as const;
  await sharp(Buffer.from(actual), { raw })
    .png()
    .toFile(join(ARTIFACTS, `${name}-actual.png`));
  await sharp(Buffer.from(Uint8Array.from(expected.data)), { raw })
    .png()
    .toFile(join(ARTIFACTS, `${name}-expected.png`));
  const result = await compareRgbaBuffers(compared, actual, {
    width: frame.width,
    height: frame.height,
    maxChannelDelta: budget,
    maxDiffRatio: 0,
  });
  const delta = result.channelDelta;
  const worst = delta?.worst
    ? `(${delta.worst.x},${delta.worst.y}) ch${delta.worst.channel} expected ${delta.worst.expected} got ${delta.worst.actual}`
    : undefined;
  const verdict: Verdict = {
    maxDelta: delta?.max ?? 255,
    differing: delta?.differingPixels ?? -1,
    undecided,
    worst,
  };
  console.log(`canvas-modes ${name}: ${JSON.stringify(verdict)}`);
  expect(result.ok, `${name}: ${result.reason} ${worst ?? ""}`).toBe(true);
  return verdict;
}

/** The raw channel distance between a frame and a model, with no assertion. */
function distance(
  expected: Prediction,
  frame: ModesFrame,
): { max: number; at: number } {
  let max = 0;
  let at = -1;
  for (let i = 0; i < expected.data.length; i += 1) {
    const d = Math.abs(expected.data[i] - frame.data[i]);
    if (d > max) {
      max = d;
      at = i;
    }
  }
  return { max, at };
}

const pixelOf = (frame: ModesFrame, x: number, y: number): number[] =>
  frame.data.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4);

// ---- the models ------------------------------------------------------------

function gradientModel(straightInterpolation: boolean): Prediction {
  const left = f32Rgba(GRADIENT_LEFT);
  const right = f32Rgba(GRADIENT_RIGHT);
  return prediction(
    MODES_STAGE,
    MODES_STAGE,
    (x) => {
      const t = (x + 0.5) / MODES_STAGE;
      const lerp = (a: Rgba, b: Rgba): Rgba =>
        a.map((v, i) => v + (b[i] - v) * t) as unknown as Rgba;
      // Godot: color_interp is the straight colour; alpha applies afterwards.
      return straightInterpolation
        ? premul(lerp(left, right))
        : lerp(premul(left), premul(right));
    },
    undefined,
    INTERPOLATED_MARGIN,
  );
}

function texturedModel(): Prediction {
  const out = mul(
    mul(premul(unit(TEXTURED_TEXEL)), premul(f32Rgba(TEXTURED_VERTEX))),
    f32Rgba(premul(TEXTURED_MODULATE)),
  );
  return prediction(MODES_STAGE, MODES_STAGE, () => out);
}

function premultipliedSourceModel(): Prediction {
  const background = f32Rgba(PREMUL_BACKGROUND).map(
    (v) => toLevel(v, 255) / 255,
  ) as unknown as Rgba;
  const texel = unit(PREMUL_TEXEL);
  const sources: Rgba[] = [
    texel, // as-given binding: the texel as stored
    premul(texel), // MIX quad: straight storage, premultiplied after sampling
    mul(texel, f32Rgba(PREMUL_VERTEX)), // premultipliedVertexColors: as given
    mul(texel, f32Rgba(PREMUL_MODULATE)), // straight modulate as the tint
  ];
  const band = MODES_STAGE / 4;
  return prediction(MODES_STAGE, MODES_STAGE, (_x, y) =>
    mix(sources[Math.floor(y / band)], background),
  );
}

function wrapModel(): Prediction {
  const texels = WRAP_TEXELS.map(unit);
  const size = texels.length;
  const scale = WRAP_SRC_W / WRAP_QUAD_WIDTH;
  return prediction(MODES_STAGE, MODES_STAGE, (x, y) => {
    const band = Math.floor(y / WRAP_BAND_ROWS);
    if (x >= WRAP_QUAD_WIDTH || band >= WRAP_BANDS.length) return null;
    const { wrap, filter } = WRAP_BANDS[band];
    const s = WRAP_SRC_X + (x + 0.5) * scale;
    if (filter === "nearest")
      return texels[wrapIndex(Math.floor(s), size, wrap)];
    const p = s - 0.5;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = texels[wrapIndex(i0, size, wrap)];
    const b = texels[wrapIndex(i0 + 1, size, wrap)];
    return a.map((v, i) => v * (1 - f) + b[i] * f) as unknown as Rgba;
  });
}

function filterModel(premultiplyOnUpload: boolean): Prediction {
  const stored = FILTER_TEXELS.map((t) =>
    premultiplyOnUpload
      ? unit([
          premultiplyByte(t[0], t[3]),
          premultiplyByte(t[1], t[3]),
          premultiplyByte(t[2], t[3]),
          t[3],
        ])
      : unit(t),
  );
  const scale = FILTER_TEXELS.length / FILTER_QUAD_WIDTH;
  return prediction(MODES_STAGE, MODES_STAGE, (x, y) => {
    if (x >= FILTER_QUAD_WIDTH || y >= FILTER_QUAD_HEIGHT) return null;
    const p = (x + 0.5) * scale - 0.5;
    const i0 = Math.floor(p);
    const f = p - i0;
    const a = stored[wrapIndex(i0, stored.length, "clamp")];
    const b = stored[wrapIndex(i0 + 1, stored.length, "clamp")];
    const filtered = a.map((v, i) => v * (1 - f) + b[i] * f) as unknown as Rgba;
    // Straight storage: premultiply AFTER the filter (Godot's order).
    return premultiplyOnUpload ? filtered : premul(filtered);
  });
}

const LEVELS_10_10_10_2 = [1023, 1023, 1023, 3] as const;

function rampLevelsModel(): Prediction {
  return prediction(
    RAMP_WIDTH,
    RAMP_HEIGHT,
    (x, y) => {
      if (y === 0) {
        const [r, g, b] = rampLevels(x);
        return [f32(r / 1023), f32(g / 1023), f32(b / 1023), 1];
      }
      return [0, 0, 0, f32(x / 1023)];
    },
    LEVELS_10_10_10_2,
    TWO_BIT_MARGIN,
  );
}

/** The 10/10/10/2 levels of the stack case, blending in float with one
 *  rounding to the target's levels per draw. */
function stackLevelsModel(
  levels: readonly [number, number, number, number],
): Prediction {
  const half = MODES_STAGE / 2;
  const left = (() => {
    let dst: Rgba = [STACK_BASE, STACK_BASE, STACK_BASE, 1].map(
      (v, c) => toLevel(f32(v), levels[c]) / levels[c],
    ) as unknown as Rgba;
    const layer = f32Rgba(
      premul([
        STACK_LAYER_COLOUR,
        STACK_LAYER_COLOUR,
        STACK_LAYER_COLOUR,
        STACK_LAYER_ALPHA,
      ]),
    );
    for (let i = 0; i < STACK_LAYERS; i += 1) {
      dst = mix(layer, dst, levels[0]).map(
        (v, c) => toLevel(v, levels[c]) / levels[c],
      ) as unknown as Rgba;
    }
    return dst;
  })();
  const right = f32Rgba(premul(STACK_TRANSLUCENT));
  return prediction(
    MODES_STAGE,
    MODES_STAGE,
    (x) => (x < half ? left : right),
    levels,
  );
}

function unpack(word: number): [number, number, number, number] {
  return [word & 1023, (word >>> 10) & 1023, (word >>> 20) & 1023, word >>> 30];
}

// ---- the browser -----------------------------------------------------------

let browser: Browser;
let page: Page;
let renderer = "";
const results = new Map<string, ModesCaseResult>();

async function run(name: string): Promise<ModesCaseResult> {
  const cached = results.get(name);
  if (cached) return cached;
  const result = await page.evaluate(
    (caseName) => window.__gswCanvasModes.run(caseName),
    name,
  );
  expect(result.glError, `${name}: gl.getError() after the case`).toBe(0);
  results.set(name, result);
  return result;
}

async function bundle(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [join(here, "..", "src", "canvas-pixel", "modes-entry.ts")],
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
  if (!file) throw new Error("canvas-modes: esbuild produced no output");
  return file.text;
}

describe.skipIf(!ENABLED)("canvas executor Godot modes, pixel-exact", () => {
  beforeAll(async () => {
    const code = await bundle();
    const env = { ...process.env };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    browser = await chromium.launch({
      // `headless: false` so Playwright adds no old-headless switches;
      // `--headless=new` is what removes the window.
      headless: false,
      args: [
        "--headless=new",
        "--enable-gpu",
        "--use-angle=vulkan",
        "--force-device-scale-factor=1",
        "--force-color-profile=srgb",
      ],
      env,
    });
    page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    page.on("pageerror", (error) =>
      console.error(`canvas-modes page error: ${error.stack ?? error.message}`),
    );
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    await page.goto("http://localhost/gsw-canvas-modes");
    await page.addScriptTag({ content: code, type: "module" });
    await page.waitForFunction(() => "__gswCanvasModes" in window, undefined, {
      timeout: 15000,
    });
    renderer = (await run("vertexGradient")).renderer;
    console.log(`canvas-modes renderer: ${renderer}`);
    // A software rasterizer would keep every case green and make every number a
    // statement about SwiftShader. These budgets are about the real GPU.
    expect(renderer, "WEBGL_debug_renderer_info").toMatch(/ANGLE/);
    expect(renderer).not.toMatch(/swiftshader|llvmpipe/i);
  }, 180000);

  afterAll(async () => {
    await browser?.close();
  });

  it("interpolates vertex colours STRAIGHT and premultiplies per fragment", async () => {
    const { frames } = await run("vertexGradient");
    const model = gradientModel(true);
    await judge("vertexGradient-canvas", model, frames.canvas);
    // Undecided (interpolated, near a midpoint) pixels: the delta1 class.
    const all = distance(model, frames.canvas);
    // Interpolating premultiplied colour is a different picture, not a rounding
    // difference: the model this executor must NOT match misses by tens.
    const wrong = distance(gradientModel(false), frames.canvas);
    console.log(
      `canvas-modes vertexGradient: worst pixel incl. undecided off by ${all.max}; premultiplied-interpolation model misses by ${wrong.max}`,
    );
    expect(all.max).toBeLessThanOrEqual(1);
    expect(wrong.max).toBeGreaterThan(30);
  }, 60000);

  it("multiplies a straight texel, a straight vertex colour and a premultiplied tint", async () => {
    const { frames } = await run("vertexTextured");
    const verdict = await judge(
      "vertexTextured-canvas",
      texturedModel(),
      frames.canvas,
    );
    expect(verdict.undecided).toBe(0);
    expect(pixelOf(frames.canvas, 10, 10)).toEqual([30, 15, 15, 77]);
  }, 60000);

  it("composites premultiplied sources (Godot PREMULT_ALPHA) with no alpha of their own, and straight ones premultiplied after sampling", async () => {
    const { frames } = await run("premultipliedSource");
    const verdict = await judge(
      "premultipliedSource-canvas",
      premultipliedSourceModel(),
      frames.canvas,
    );
    expect(verdict.undecided).toBe(0);
    // Hand values (bytes): background 51,102,153; texel 100,50,0,128.
    // As-given quad: 100 + 51*127/255 = 125.4 -> 125, 50 + 102*127/255 = 100.8 -> 101, 153*127/255 = 76.2 -> 76.
    expect(pixelOf(frames.canvas, 5, 5)).toEqual([125, 101, 76, 255]);
    // Straight quad: the shader's 100*128/255 = 50.2 is converted to 50 before the
    // blend (measured), so 50 + 25.4 = 75.4 -> 75 where float would give 76;
    // green 25.1 -> 25, + 50.8 -> 76; blue 76.2 -> 76.
    expect(pixelOf(frames.canvas, 5, 20)).toEqual([75, 76, 76, 255]);
    // As given with alpha 0.5 (vertex colour, then straight modulate as tint):
    // colour NOT halved, coverage halved: 100 + 51*191/255 = 138.2 -> 138, 50 + 76.4 -> 126, 114.6 -> 115.
    expect(pixelOf(frames.canvas, 5, 40)).toEqual([138, 126, 115, 255]);
    expect(pixelOf(frames.canvas, 5, 56)).toEqual([138, 126, 115, 255]);
  }, 60000);

  it("wraps clamp, repeat and mirror across both texture edges, linear and nearest", async () => {
    const { frames } = await run("wrap");
    const verdict = await judge("wrap-canvas", wrapModel(), frames.canvas);
    expect(verdict.undecided).toBe(0);
    // The seam pixel x=3 samples page pixel s = -0.25, so LINEAR blends texel -1
    // (weight 3/4) with texel 0 (1/4): clamp gives A, repeat 3/4 D + 1/4 A =
    // (160, 120, 0), mirror A again (texel -1 mirrors onto texel 0).
    expect(pixelOf(frames.canvas, 3, 0)).toEqual([40, 0, 0, 255]);
    expect(pixelOf(frames.canvas, 3, 4)).toEqual([160, 120, 0, 255]);
    expect(pixelOf(frames.canvas, 3, 8)).toEqual([40, 0, 0, 255]);
  }, 60000);

  it("filters a straight page THEN premultiplies, and the premultiplied upload misses it", async () => {
    const straight = await run("straightFilter");
    const model = filterModel(false);
    const verdict = await judge(
      "straightFilter-canvas",
      model,
      straight.frames.canvas,
    );
    expect(verdict.undecided).toBe(0);
    // x=3: weights 5/8 opaque, 3/8 half-transparent. a = 207.375 -> 207;
    // r = 156 * 207.375/255 = 126.9 -> 127; g = 100 * 207.375/255 = 81.3 -> 81.
    expect(pixelOf(straight.frames.canvas, 3, 0)).toEqual([127, 81, 0, 207]);

    // SABOTAGE: premultiplying on upload filters premultiplied texels. Its own
    // model holds exactly, and it misses the straight prediction by far more
    // than one level at the half-transparent edge.
    const sabotage = await run("straightFilterPremultipliedUpload");
    await judge(
      "straightFilterPremultipliedUpload-canvas",
      filterModel(true),
      sabotage.frames.canvas,
    );
    const miss = distance(model, sabotage.frames.canvas);
    const missX = Math.floor(miss.at / 4) % MODES_STAGE;
    console.log(
      `canvas-modes straightFilter: premultiplied upload misses the straight model by ${miss.max} at x=${missX}`,
    );
    expect(miss.max).toBeGreaterThan(1);
    expect(missX).toBeGreaterThanOrEqual(2);
    expect(pixelOf(sabotage.frames.canvas, 3, 0)).toEqual([153, 55, 0, 207]);
  }, 60000);

  it("stores every 10-bit level exactly in the RGB10_A2 target and reads it back as round(v*255/1023)", async () => {
    const { frames, packed } = await run("rgb10a2Ramp");
    const levels = rampLevelsModel();
    expect(
      packed,
      "the context offers UNSIGNED_INT_2_10_10_10_REV reads",
    ).not.toBeNull();
    // STORAGE: every decided level exactly; an undecided (2-bit alpha) one
    // within one level, and the measured level is what the readback is then
    // judged against.
    const stored = { ...levels, data: Uint16Array.from(levels.data) };
    let packedMismatches = 0;
    let undecidedMoved = 0;
    for (let p = 0; p < RAMP_WIDTH * RAMP_HEIGHT; p += 1) {
      const got = unpack(packed?.[p] ?? 0);
      for (let c = 0; c < 4; c += 1) {
        const want = levels.data[p * 4 + c];
        if (got[c] === want) continue;
        if (levels.undecided[p] && Math.abs(got[c] - want) === 1) {
          undecidedMoved += 1;
          stored.data[p * 4 + c] = got[c];
        } else packedMismatches += 1;
      }
    }
    // Where the 2-bit alpha switches level, as an alpha fraction of 1023.
    const thresholds: number[] = [];
    for (let i = 1; i < RAMP_WIDTH; i += 1) {
      const a = unpack(packed?.[RAMP_WIDTH + i] ?? 0)[3];
      if (a !== unpack(packed?.[RAMP_WIDTH + i - 1] ?? 0)[3])
        thresholds.push(i);
    }
    console.log(
      `canvas-modes rgb10a2Ramp: packed mismatches ${packedMismatches} decided; ${undecidedMoved} undecided alpha levels took the other neighbour (of ${levels.undecided.reduce((a, b) => a + b, 0)} undecided pixels); 2-bit alpha switches at i = ${thresholds.join(", ")} of 1023`,
    );
    expect(packedMismatches).toBe(0);
    // 8-BIT READBACK = round(v * 255 / max) of exactly what is stored.
    await judge("rgb10a2Ramp-target", readback8(stored), frames.target);
    // The present into the 8-bit canvas converts exactly as the readback does.
    await judge(
      "rgb10a2Ramp-canvasAfterBlit",
      readback8(stored),
      frames.canvasAfterBlit,
    );
    // Why `blit` is a rounding draw rather than `blitFramebuffer`: measured, not
    // asserted (it is the implementation's conversion, and may differ elsewhere).
    const raw = distance(readback8(stored), frames.canvasRawBlit);
    let rawDiffering = 0;
    for (let p = 0; p < RAMP_WIDTH * RAMP_HEIGHT; p += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (
          frames.canvasRawBlit.data[p * 4 + c] !==
          readback8(stored).data[p * 4 + c]
        ) {
          rawDiffering += 1;
          break;
        }
      }
    }
    console.log(
      `canvas-modes rgb10a2Ramp: a raw blitFramebuffer differs from readPixels on ${rawDiffering}/${RAMP_WIDTH * RAMP_HEIGHT} pixels, by up to ${raw.max}`,
    );
    // A truncating 10->8 conversion (v >> 2) would differ on many levels; the
    // measured readback is the rounding one.
    let truncateMisses = 0;
    for (let i = 0; i < RAMP_WIDTH; i += 1) {
      if (frames.target.data[i * 4] !== i >> 2) truncateMisses += 1;
    }
    console.log(
      `canvas-modes rgb10a2Ramp: a v>>2 readback model would miss ${truncateMisses}/1024 red levels`,
    );
    expect(truncateMisses).toBeGreaterThan(0);
  }, 60000);

  it("blends at 10-bit precision with a 2-bit alpha, where the 8-bit canvas cannot", async () => {
    const { frames, packed } = await run("rgb10a2Stack");
    const levels = stackLevelsModel(LEVELS_10_10_10_2);
    const left = unpack(packed?.[0] ?? 0);
    const right = unpack(packed?.[MODES_STAGE - 1] ?? 0);
    console.log(
      `canvas-modes rgb10a2Stack: packed left ${left} right ${right}`,
    );
    expect(left).toEqual([...levels.data.subarray(0, 4)]);
    expect(right).toEqual([
      ...levels.data.subarray((MODES_STAGE - 1) * 4, MODES_STAGE * 4),
    ]);
    await judge("rgb10a2Stack-target", readback8(levels), frames.target);
    await judge(
      "rgb10a2Stack-canvasAfterBlit",
      readback8(levels),
      frames.canvasAfterBlit,
    );
    await judge(
      "rgb10a2Stack-rgba8",
      stackLevelsModel([255, 255, 255, 255]),
      frames.rgba8,
    );
    // Hand values: base 98/255 is 10-bit 393 (393.15); each 0.08 layer is
    // 82/1023 after the source conversion, so 82 + 0.8 d climbs 396, 399, 401,
    // 403, 404, read back as round(404 * 255 / 1023) = 101. The 8-bit canvas
    // converts the layer to 20/255 and 20 + 0.8 * 98 = 98.4 sticks at 98. The
    // 0.6 alpha is 2 of 3 levels (170) in the target and 153 in the canvas.
    expect(left).toEqual([404, 404, 404, 3]);
    expect(pixelOf(frames.target, 0, 0)).toEqual([101, 101, 101, 255]);
    expect(pixelOf(frames.rgba8, 0, 0)).toEqual([98, 98, 98, 255]);
    expect(pixelOf(frames.target, 40, 0)).toEqual([46, 46, 46, 170]);
    expect(pixelOf(frames.rgba8, 40, 0)).toEqual([46, 46, 46, 153]);
  }, 60000);
});
