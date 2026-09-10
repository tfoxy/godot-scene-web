// The A1 text-quality crossover probe, BROWSER HALF: at what size does each of our text arms stop
// being similar-or-better than the engine the consumer is mirroring?
//
//   mise exec -- pnpm -w run text:crossover
//   mise exec -- pnpm -w run text:crossover -- --hb-contrast default --out artifacts/perf/probes/text-crossover-default
//   mise exec -- pnpm -w run text:crossover -- --arm hb-gpu --arm reference --erosion 2
//
// A PROBE, NOT A SCENARIO. No trace, no frame rate, no `perf-report/1` envelope — the same rule the
// bake probe and `text-fidelity` state. It answers a question the perf table structurally cannot.
//
// THE METHODOLOGY IS DELIBERATELY NOT "1 WARMUP, 5 REPEATS, MEDIANS", AND THIS IS THE PARAGRAPH
// THAT SAYS SO. That rule exists because a single TIMING measures scheduling noise; a median of
// five is how you get a number that is about the renderer instead of about the machine. Nothing in
// this file is a timing. Every number here is a function of BYTES in a PNG, and a rasterizer that
// produced a different picture on the second draw of the same frame would not be noisy — it would
// be broken. So the repeat rule is replaced by the check that is actually load-bearing for a
// fidelity sweep: DETERMINISM. Every arm draws its `product` variant twice, from scratch, and the
// two PNGs must be byte-identical; the result is reported explicitly as `determinism:
// identical|differs` rather than left as an assumption. A run that reports `differs` has no
// business publishing a table, and says so. Everything else the methodology asks for is here
// unchanged and non-negotiable: a real `http://` origin, a presence guard on every cell of every
// frame, failures collected into `failures` instead of averaged in, and absences reported as NOT
// MEASURED with the command that produces them — never as a zero.
//
// THE FOUR ARMS:
//
//   a. `hb-gpu`    the shipped `createHbGpuText`, driven through `/hb.js` (text-crossover-hb.ts).
//                  `outlinePx = 2 * spreadPx`, because the arm HALVES it back internally; the
//                  resulting `arm.spreadPx` is asserted against the case's own radius.
//   b. `canvas2d`  `ctx.strokeText` at `lineWidth = 2 * spreadPx`, round joins and caps, THEN
//                  `ctx.fillText` at the same pen. Centred stroke, stroke under fill — the product.
//   c. `dom`       absolutely positioned text with `-webkit-text-stroke-width: 2 * spreadPx`.
//                  Also centred, which is why it is the right analogue; Blink's paint order (fill
//                  then stroke) is not, and that difference is a finding rather than a bug here.
//   d. `reference` the same geometry at 8x through canvas2d, box-downsampled in node. THE CEILING
//                  for metric (iv) and the source of metric (i)'s mask — NOT a shippable arm.
//
// THE METRICS COME FROM `text-crossover-metrics.ts` AND THE GEOMETRY FROM `text-crossover-cases.ts`.
// Neither is restated here: a second `cellRect` on this side would be free to drift half a pixel
// from the Godot half, and half a pixel is the entire subject of metric (ii).
//
// EVERY PIXEL COMES FROM A COMPOSITOR SCREENSHOT of a page served over real `http://`. Never a
// canvas readback: `getImageData` on an accelerated 2D canvas returns alpha 0 on the headed rung
// (docs/perf-harness.md), which would silently score every canvas arm as a blank page.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import { boxDownsample } from "../../../scripts/test-support/text-image-metrics";
import { openLocalBrowser, readGpuHardware } from "../src/browser";
import { HB_GPU_NOT_BUILT, hbGpuIsBuilt } from "../src/hb-gpu-build";
import { HB_GPU_GLUE_URL, HB_GPU_WASM_URL } from "../src/scenarios/text-gpu";
import {
  bundleBrowserModule,
  HARFBUZZ_WASM_PATH,
  readHarfBuzzWasm,
  readHbGpuBuild,
} from "../src/serve";
import {
  CALIBRATION_HEIGHT,
  CALIBRATION_SWATCHES,
  CALIBRATION_TOLERANCE,
  CALIBRATION_TOP,
  CANVAS_HEIGHT,
  CELL_HEIGHT,
  CELL_WIDTH,
  CROSSOVER_CASES,
  CROSSOVER_TEXT,
  CROSSOVER_VARIANTS,
  type CrossoverVariant,
  cellRect,
  colorsFor,
  FRAME_WIDTH,
  PRODUCT_FILL,
} from "./text-crossover-cases";
import {
  buildInteriorMask,
  type ChannelDiff,
  cellPresence,
  channelPlane,
  cropRgba,
  type DistortionScore,
  distortionVsReference,
  type EdgeProfile,
  edgeProfile,
  type InteriorUniformity,
  interiorUniformity,
  perChannelByteDiff,
  type RgbaImage,
} from "./text-crossover-metrics";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");

/** Supersample factor for arm (d). 8x is the harness's existing reference scale — see text-fidelity. */
const SUPER_SAMPLE = 8;

/**
 * The viewport every frame is drawn in.
 *
 * Wide enough for the 8x reference CELL (2560x1280) as well as the 1x frame (1280x1160), so the
 * device metrics are set ONCE. A clip smaller than the viewport is free; changing the viewport
 * between arms is a relayout, and a relayout between two frames that are about to be byte-compared
 * is a variable nobody asked for.
 */
const VIEWPORT = {
  width: Math.max(FRAME_WIDTH, CELL_WIDTH * SUPER_SAMPLE),
  height: Math.max(CANVAS_HEIGHT, CELL_HEIGHT * SUPER_SAMPLE),
};

/** Right edge of the calibration patch — the only part of the band the 8x reference has to draw. */
const CALIBRATION_BAND_WIDTH = Math.max(
  ...CALIBRATION_SWATCHES.map((swatch) => swatch.x + swatch.width),
);

/** The browser arms, in the order they are graded. `reference` is last because it is not an arm. */
const ALL_ARMS = ["hb-gpu", "canvas2d", "dom", "reference"] as const;
type ArmName = (typeof ALL_ARMS)[number];

/** The variant every arm is rendered twice in, for the determinism check. See the file header. */
const DETERMINISM_VARIANT: CrossoverVariant = "product";

/** hb-gpu's contrast lever — the point of `HbGpuTextOptions.contrast`. See the file header. */
type ContrastSetting = "none" | "default";

// ---------------------------------------------------------------------------------------------
// The face
// ---------------------------------------------------------------------------------------------

/**
 * The game's real face, hunted for beside this repo rather than hardcoded to one checkout's path.
 *
 * WHY THE GAME'S FACE AND NOT THE BENCH FIXTURE. The reported defect is on the word "End Turn 1"
 * in Kreon Bold at ppem ~52, and stem width, bowl curvature and the sub-pixel phase of a stem are
 * all properties of the OUTLINE. A different face is a different mottle. The fixture is the
 * fallback so a checkout without the sibling game repo still produces a full sweep — and the
 * report names which one it got, because the two are not interchangeable evidence.
 */
const GAME_FACE_RELATIVE =
  "spirectl/.sts2/toolchain/recovered-project/fonts/kreon_bold.ttf";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeFace {
  path: string;
  /** `game` is Kreon Bold out of the sibling game repo; `fixture` is this repo's Roboto bench. */
  source: "game" | "override" | "fixture";
  /** The `@font-face` family the page installs it under. One face, so one name. */
  family: string;
  byteLength: number;
}

async function resolveFace(override?: string): Promise<ProbeFace> {
  const candidates: { path: string; source: ProbeFace["source"] }[] = [];
  if (override)
    candidates.push({ path: resolve(override), source: "override" });
  if (process.env.GSW_CROSSOVER_FACE) {
    candidates.push({
      path: resolve(process.env.GSW_CROSSOVER_FACE),
      source: "override",
    });
  }
  // Up the tree from the repo root: the primary checkout has `spirectl` as a sibling, and a git
  // worktree under `.claude/worktrees/<name>` has it four levels further up. Walking is one rule
  // that covers both instead of two paths that each work in exactly one place.
  let dir = REPO_ROOT;
  for (let level = 0; level < 6; level += 1) {
    candidates.push({
      path: resolve(join(dir, "..", GAME_FACE_RELATIVE)),
      source: "game",
    });
    dir = resolve(dir, "..");
  }
  for (const candidate of candidates) {
    if (await exists(candidate.path)) {
      const bytes = await readFile(candidate.path);
      return {
        path: candidate.path,
        source: candidate.source,
        family: "CrossoverFace",
        byteLength: bytes.byteLength,
      };
    }
  }
  const fixture = await ensureLatinBenchFont(REPO_ROOT);
  const bytes = await readFile(fixture.path);
  return {
    path: fixture.path,
    source: "fixture",
    family: "CrossoverFace",
    byteLength: bytes.byteLength,
  };
}

// ---------------------------------------------------------------------------------------------
// The spec the page is driven with
// ---------------------------------------------------------------------------------------------

interface CrossoverSpec {
  text: string;
  variant: CrossoverVariant;
  frame: { width: number; height: number };
  cell: { width: number; height: number };
  colors: ReturnType<typeof colorsFor>;
  cells: {
    name: string;
    pixelsPerEm: number;
    spreadPx: number;
    cellX: number;
    cellY: number;
    penX: number;
    penY: number;
  }[];
  calibration: {
    top: number;
    height: number;
    bandWidth: number;
    swatches: typeof CALIBRATION_SWATCHES;
  };
  contrast: ContrastSetting;
  superSample: number;
  /** Which case a `reference-cell` render is for. Unread by every other arm. */
  cellIndex: number;
}

function specFor(
  variant: CrossoverVariant,
  contrast: ContrastSetting,
): CrossoverSpec {
  return {
    text: CROSSOVER_TEXT,
    variant,
    frame: { width: FRAME_WIDTH, height: CANVAS_HEIGHT },
    cell: { width: CELL_WIDTH, height: CELL_HEIGHT },
    colors: colorsFor(variant),
    cells: CROSSOVER_CASES.map((entry) => ({
      name: entry.name,
      pixelsPerEm: entry.pixelsPerEm,
      spreadPx: entry.spreadPx,
      cellX: entry.cellX,
      cellY: entry.cellY,
      penX: entry.penX,
      penY: entry.penY,
    })),
    calibration: {
      top: CALIBRATION_TOP,
      height: CALIBRATION_HEIGHT,
      bandWidth: CALIBRATION_BAND_WIDTH,
      swatches: CALIBRATION_SWATCHES,
    },
    contrast,
    superSample: SUPER_SAMPLE,
    cellIndex: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

export interface CalibrationReading {
  alpha: number;
  expected: number;
  /** The swatch's centre pixel, all three channels. */
  observed: [number, number, number];
  /** Worst deviation from `expected` anywhere in the inset patch, bytes. */
  worst: number;
  ok: boolean;
}

/**
 * THE TRANSFER-CURVE GUARD, on every frame of every arm.
 *
 * White at alpha `a` over black decodes to `round(255a)` if and only if nothing on the way to the
 * PNG applied a linear<->sRGB conversion. If something did, 0.5 comes back as ~188 instead of 128 —
 * and every coverage byte in this sweep is then off by a curve while no other check in the pipeline
 * notices, because every arm would be off by the SAME curve and the table would still rank them.
 * That is the one failure a comparison cannot see from the inside, which is why the patch is
 * absolute rather than relative.
 *
 * Read over an INSET of the patch, so a swatch boundary's own antialiasing cannot be mistaken for a
 * curve, and the WORST deviation is reported rather than the mean: a curve that bent only the
 * highlights would average away.
 */
function readCalibration(frame: RgbaImage): {
  readings: CalibrationReading[];
  ok: boolean;
} {
  const inset = 4;
  const readings = CALIBRATION_SWATCHES.map((swatch) => {
    const expected = Math.round(255 * swatch.alpha);
    let worst = 0;
    for (
      let y = CALIBRATION_TOP + inset;
      y < CALIBRATION_TOP + CALIBRATION_HEIGHT - inset;
      y += 1
    ) {
      for (
        let x = swatch.x + inset;
        x < swatch.x + swatch.width - inset;
        x += 1
      ) {
        const i = (y * frame.width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          worst = Math.max(worst, Math.abs(frame.data[i + c] - expected));
        }
      }
    }
    const centre =
      ((CALIBRATION_TOP + CALIBRATION_HEIGHT / 2) * frame.width +
        swatch.x +
        swatch.width / 2) *
      4;
    return {
      alpha: swatch.alpha,
      expected,
      observed: [
        frame.data[centre],
        frame.data[centre + 1],
        frame.data[centre + 2],
      ] as [number, number, number],
      worst,
      ok: worst <= CALIBRATION_TOLERANCE,
    };
  });
  return { readings, ok: readings.every((reading) => reading.ok) };
}

export interface CellFailure {
  arm: string;
  variant: CrossoverVariant;
  case: string;
  reason: string;
  inkPixels: number;
  nonEmptyRatio: number;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** A metric that was NOT computed, with the reason. NEVER a zero and never a 100 %. */
export interface NotMeasured {
  notMeasured: string;
  command?: string;
}

function isNotMeasured(value: unknown): value is NotMeasured {
  return typeof value === "object" && value !== null && "notMeasured" in value;
}

export interface CrossoverRow {
  arm: string;
  case: string;
  pixelsPerEm: number;
  spreadPx: number;
  /** Metric (i), on the `product` variant only. */
  interior: (InteriorUniformity & { maskPixels: number }) | NotMeasured;
  /** Metric (iii) on the `fillMono` plane. */
  fillEdge: EdgeProfile | NotMeasured;
  /** Metric (iii) on the `outlineMono` plane. Absent at spread 0 — there is no outline edge. */
  outlineEdge: EdgeProfile | NotMeasured;
  /** Metric (iv), `fillMono` against the 8x reference's `fillMono`. */
  distortion: DistortionScore | NotMeasured;
  /** Metric (ii), against Godot. Keyed by the Godot face variant (`msdf` / `gray`). */
  godot: Record<string, ChannelDiff> | NotMeasured;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

async function decode(png: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

async function encode(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Copy `src` into `dest` at `(x, y)`. Refused rather than clamped if it would not fit. */
function blit(
  dest: RgbaImage,
  src: { data: Uint8Array; width: number; height: number },
  x: number,
  y: number,
): void {
  if (
    x < 0 ||
    y < 0 ||
    x + src.width > dest.width ||
    y + src.height > dest.height
  ) {
    throw new Error(
      `text-crossover: a ${src.width}x${src.height} tile at +${x}+${y} does not fit a ${dest.width}x${dest.height} frame`,
    );
  }
  for (let row = 0; row < src.height; row += 1) {
    dest.data.set(
      src.data.subarray(row * src.width * 4, (row + 1) * src.width * 4),
      ((y + row) * dest.width + x) * 4,
    );
  }
}

type Send = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<T>;

async function evaluate<T>(
  send: Send,
  expression: string,
  timeoutMs = 300_000,
): Promise<T> {
  const result = await send<{
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    { timeoutMs },
  );
  if (result.exceptionDetails) {
    throw new Error(
      `page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value as T;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const flags = (name: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
    }
    return out;
  };

  const outDir = resolve(
    flag("out") ?? join(REPO_ROOT, "artifacts/perf/probes/text-crossover"),
  );
  const godotDir = resolve(
    flag("godot-dir") ??
      join(REPO_ROOT, "artifacts/perf/probes/text-crossover/godot"),
  );
  const erosionRadius = Number(flag("erosion") ?? 1);
  const contrastFlag = (flag("hb-contrast") ?? "none") as ContrastSetting;
  if (contrastFlag !== "none" && contrastFlag !== "default") {
    throw new Error(
      `text-crossover: --hb-contrast takes "none" or "default", not ${JSON.stringify(contrastFlag)}. "none" is raw coverage (what the fidelity arm has always been graded on); "default" is HB_GPU_CONTRAST_DEFAULT, i.e. the stem darkening every shipping consumer of packages/canvas actually gets.`,
    );
  }
  const requested = flags("arm");
  for (const arm of requested) {
    if (!(ALL_ARMS as readonly string[]).includes(arm)) {
      throw new Error(
        `text-crossover: unknown --arm ${JSON.stringify(arm)}; known arms are ${ALL_ARMS.join(", ")}`,
      );
    }
  }
  const notMeasured: { what: string; command: string }[] = [];
  let arms: ArmName[] =
    requested.length > 0 ? (requested as ArmName[]) : [...ALL_ARMS];

  // hb-gpu's wasm is decided BEFORE the browser opens, exactly as the fidelity probe does it: an
  // arm that cannot be rendered is left out and named with the command that produces it, never
  // rendered as a row of zeros — which for a fidelity sweep is a blank cell scoring a perfectly
  // uniform interior and a zero edge width.
  if (arms.includes("hb-gpu") && !(await hbGpuIsBuilt())) {
    if (requested.includes("hb-gpu")) {
      throw new Error(
        `text-crossover: --arm hb-gpu was asked for explicitly but ${HB_GPU_NOT_BUILT.what}.\n  Run: ${HB_GPU_NOT_BUILT.command}`,
      );
    }
    arms = arms.filter((arm) => arm !== "hb-gpu");
    notMeasured.push(HB_GPU_NOT_BUILT);
  }

  await mkdir(outDir, { recursive: true });

  const face = await resolveFace(flag("face"));
  const faceBytes = await readFile(face.path);
  const html = await readFile(join(here, "text-crossover.html"), "utf8");
  const hbBundle = await bundleBrowserModule(
    join(here, "text-crossover-hb.ts"),
  );
  const harfbuzzWasm = await readHarfBuzzWasm();
  const hbGpu = await readHbGpuBuild();

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const send = (type: string, body: string | Buffer) => {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    // THE FACE OVER REAL `http://`, never a `data:` URL. A scenario that measures glyph
    // rasterisation has to let the browser fetch, parse and install the face the way a page does —
    // and the hb arm needs an `ArrayBuffer` from the network, not one rebuilt from base64.
    if (path === "/font.ttf") return send("font/ttf", faceBytes);
    if (path === "/hb.js")
      return send("text/javascript; charset=utf-8", hbBundle);
    if (path === HARFBUZZ_WASM_PATH)
      return send("application/wasm", harfbuzzWasm);
    if (path === HB_GPU_WASM_URL && hbGpu)
      return send("application/wasm", hbGpu.wasm);
    if (path === HB_GPU_GLUE_URL && hbGpu) {
      return send("text/javascript; charset=utf-8", hbGpu.glue);
    }
    return send("text/html; charset=utf-8", html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // THE MEASURED LAUNCH RECIPE, from `packages/hb-gpu/test/glyphPixelXvfb.test.ts`'s launch ladder:
  // headless=new plus `--enable-gpu --use-angle=vulkan` keeps the arm on the real GPU instead of
  // dropping to SwiftShader, and needs no display and no xvfb. The profile lives under the repo's
  // own `artifacts/` because snap chromium is confined and refuses `/tmp`.
  const browser = await openLocalBrowser({
    artifactsDir: join(REPO_ROOT, "artifacts/perf"),
    headless: true,
    deviceScaleFactor: 1,
    windowSize: VIEWPORT,
    extraArgs: ["--enable-gpu", "--use-angle=vulkan"],
  });
  console.log(browser.describe);

  const gpu = await readGpuHardware(browser.client);
  console.log(`gpu: ${gpu.hardware} — ${gpu.hardwareDetail || "(no detail)"}`);
  // REFUSED, NOT WARNED. A software rasteriser draws a DIFFERENT picture — SwiftShader's coverage
  // estimator is not ANGLE/NVIDIA's — so a fidelity table taken on it describes a renderer nobody
  // ships. It would still look completely plausible, which is the whole problem.
  if (
    /swiftshader|llvmpipe|softwar/i.test(
      `${gpu.hardware} ${gpu.hardwareDetail}`,
    )
  ) {
    await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    throw new Error(
      `text-crossover: Chrome came up on ${gpu.hardware} (${gpu.hardwareDetail}) — a software rasteriser. Every number this probe reports would describe a renderer no consumer runs, so no numbers are recorded. Check that --enable-gpu --use-angle=vulkan reached the browser and that a real GPU is visible to this process.`,
    );
  }

  const lease = await browser.targets.acquire(VIEWPORT);
  const client = browser.client;
  const send: Send = (method, params = {}, options = {}) =>
    client.send(method, params, options);

  const frames = new Map<string, RgbaImage>();
  const failures: CellFailure[] = [];
  const calibration: {
    arm: string;
    variant: CrossoverVariant;
    ok: boolean;
    readings: CalibrationReading[];
  }[] = [];
  const determinism: {
    arm: string;
    variant: CrossoverVariant;
    result: "identical" | "differs";
    differingBytes: number;
  }[] = [];
  let hbCellReports: unknown = null;

  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await new Promise((r) => setTimeout(r, 400));
    const installed = await evaluate<{ family: string; byteLength: number }>(
      send,
      `window.__textCrossover.installFont("/font.ttf", ${JSON.stringify(face.family)})`,
    );
    if (installed.byteLength !== face.byteLength) {
      throw new Error(
        `text-crossover: the page installed ${installed.byteLength} B of face where node read ${face.byteLength} B — the arms would not be drawing the face this report names`,
      );
    }

    const shoot = async (width: number, height: number): Promise<Buffer> => {
      const shot = await send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      return Buffer.from(shot.data, "base64");
    };

    /** One (arm, variant) frame as a PNG. `reference` is assembled in node — see the page. */
    const renderFrame = async (
      arm: ArmName,
      variant: CrossoverVariant,
    ): Promise<Buffer> => {
      const spec = specFor(variant, contrastFlag);
      if (arm !== "reference") {
        const report = await evaluate<unknown>(
          send,
          `window.__textCrossover.render(${JSON.stringify(arm)}, ${JSON.stringify(spec)})`,
        );
        if (arm === "hb-gpu" && variant === "product") hbCellReports = report;
        return shoot(FRAME_WIDTH, CANVAS_HEIGHT);
      }
      // The 8x reference, cell by cell, box-downsampled here in node. Downsampling on this side
      // keeps it out of reach of the broken accelerated-canvas readback, and per-cell keeps the
      // canvas at 2560x1280 instead of a 95 Mpx whole-frame one Chrome would not hand out.
      const frame: RgbaImage = {
        data: new Uint8Array(FRAME_WIDTH * CANVAS_HEIGHT * 4),
        width: FRAME_WIDTH,
        height: CANVAS_HEIGHT,
      };
      for (let i = 0; i < FRAME_WIDTH * CANVAS_HEIGHT; i += 1) {
        frame.data[i * 4] = spec.colors.background[0];
        frame.data[i * 4 + 1] = spec.colors.background[1];
        frame.data[i * 4 + 2] = spec.colors.background[2];
        frame.data[i * 4 + 3] = 255;
      }
      for (const [index, entry] of CROSSOVER_CASES.entries()) {
        await evaluate(
          send,
          `window.__textCrossover.render("reference-cell", ${JSON.stringify({ ...spec, cellIndex: index })})`,
        );
        const png = await shoot(
          CELL_WIDTH * SUPER_SAMPLE,
          CELL_HEIGHT * SUPER_SAMPLE,
        );
        const raw = await decode(png);
        blit(
          frame,
          boxDownsample(raw.data, raw.width, raw.height, SUPER_SAMPLE),
          entry.cellX,
          entry.cellY,
        );
      }
      await evaluate(
        send,
        `window.__textCrossover.render("reference-calibration", ${JSON.stringify(spec)})`,
      );
      const bandPng = await shoot(
        CALIBRATION_BAND_WIDTH * SUPER_SAMPLE,
        CALIBRATION_HEIGHT * SUPER_SAMPLE,
      );
      const bandRaw = await decode(bandPng);
      blit(
        frame,
        boxDownsample(
          bandRaw.data,
          bandRaw.width,
          bandRaw.height,
          SUPER_SAMPLE,
        ),
        0,
        CALIBRATION_TOP,
      );
      // The rest of the band is black too — the swatch invariant is "white over BLACK", and a
      // reference whose band was half brown would read differently from every other arm's.
      for (let y = CALIBRATION_TOP; y < CANVAS_HEIGHT; y += 1) {
        for (let x = CALIBRATION_BAND_WIDTH; x < FRAME_WIDTH; x += 1) {
          const i = (y * FRAME_WIDTH + x) * 4;
          frame.data[i] = 0;
          frame.data[i + 1] = 0;
          frame.data[i + 2] = 0;
        }
      }
      return encode(frame);
    };

    for (const arm of arms) {
      for (const variant of CROSSOVER_VARIANTS) {
        process.stdout.write(`  ${arm} / ${variant} … `);
        const png = await renderFrame(arm, variant);
        await writeFile(join(outDir, `${arm}-${variant}.png`), png);
        const image = await decode(png);
        if (image.width !== FRAME_WIDTH || image.height !== CANVAS_HEIGHT) {
          throw new Error(
            `text-crossover: ${arm}/${variant} came back ${image.width}x${image.height}, expected ${FRAME_WIDTH}x${CANVAS_HEIGHT}`,
          );
        }
        frames.set(`${arm}/${variant}`, image);

        const readings = readCalibration(image);
        calibration.push({ arm, variant, ...readings });

        const colors = colorsFor(variant);
        let cellFailures = 0;
        for (const entry of CROSSOVER_CASES) {
          const rect = cellRect(entry);
          const cell = cropRgba(image, rect.x, rect.y, rect.width, rect.height);
          const presence = cellPresence(cell, colors.background);
          if (!presence.ok) {
            cellFailures += 1;
            failures.push({
              arm,
              variant,
              case: entry.name,
              reason: `cellPresence: ${presence.inkPixels} ink px (need >= 16) — the cell is indistinguishable from its own background`,
              inkPixels: presence.inkPixels,
              nonEmptyRatio: presence.nonEmptyRatio,
            });
          }
        }
        console.log(
          `${readings.ok ? "calibration ok" : "CALIBRATION FAILED"}, ${CROSSOVER_CASES.length - cellFailures}/${CROSSOVER_CASES.length} cells present`,
        );

        if (variant === DETERMINISM_VARIANT) {
          const second = await renderFrame(arm, variant);
          const identical = second.equals(png);
          let differingBytes = 0;
          if (!identical) {
            const other = await decode(second);
            for (let i = 0; i < image.data.length; i += 1) {
              if (image.data[i] !== other.data[i]) differingBytes += 1;
            }
            await writeFile(
              join(outDir, `${arm}-${variant}-repeat.png`),
              second,
            );
          }
          determinism.push({
            arm,
            variant,
            result: identical ? "identical" : "differs",
            differingBytes,
          });
          console.log(
            `  ${arm} / ${variant} determinism: ${identical ? "identical" : `DIFFERS (${differingBytes} bytes)`}`,
          );
        }
      }
    }
  } finally {
    await lease.release().catch(() => {});
    await browser.close().catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }

  // -------------------------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------------------------

  const reference = frames.get("reference/fillMono");
  const REFERENCE_COMMAND =
    "mise exec -- pnpm -w run text:crossover -- --arm reference";

  /** Metric (i)'s mask, per case, from the SHARED reference — never from the arm being graded. */
  const masks = new Map<
    string,
    { mask: Uint8Array; pixels: number; erosionRadius: number }
  >();
  const emptyMasks: { case: string; pixelsPerEm: number; spreadPx: number }[] =
    [];
  if (reference) {
    for (const entry of CROSSOVER_CASES) {
      const rect = cellRect(entry);
      const plane = channelPlane(
        cropRgba(reference, rect.x, rect.y, rect.width, rect.height),
      );
      const mask = buildInteriorMask(plane, { erosionRadius });
      masks.set(entry.name, mask);
      if (mask.pixels === 0) {
        emptyMasks.push({
          case: entry.name,
          pixelsPerEm: entry.pixelsPerEm,
          spreadPx: entry.spreadPx,
        });
      }
    }
  }

  // Godot's frames, if arm (d) of the other half has produced them yet. ABSENT IS NOT ZERO.
  const godotFrames = new Map<string, RgbaImage>();
  const godotFound: string[] = [];
  const godotAbsent: string[] = [];
  for (const godotFace of ["msdf", "gray"]) {
    const path = join(godotDir, `${godotFace}-product.png`);
    if (await exists(path)) {
      const image = await decode(await readFile(path));
      if (
        image.width < FRAME_WIDTH ||
        image.height < CANVAS_HEIGHT - CALIBRATION_HEIGHT
      ) {
        godotAbsent.push(
          `${godotFace}-product.png is ${image.width}x${image.height}, too small for the case grid (${FRAME_WIDTH}x${CANVAS_HEIGHT - CALIBRATION_HEIGHT})`,
        );
        continue;
      }
      godotFrames.set(godotFace, image);
      godotFound.push(relative(REPO_ROOT, path));
    } else {
      godotAbsent.push(relative(REPO_ROOT, path));
    }
  }
  const GODOT_COMMAND =
    "mise exec -- tsx --conditions=development scripts/godot-text-crossover.ts";

  const measurable = arms.filter((arm) => arm !== "reference");
  const rows: CrossoverRow[] = [];
  const failedCells = new Set(
    failures.map((entry) => `${entry.arm}/${entry.variant}/${entry.case}`),
  );

  for (const arm of [
    ...measurable,
    ...(arms.includes("reference") ? (["reference"] as const) : []),
  ]) {
    const product = frames.get(`${arm}/product`);
    const fillMono = frames.get(`${arm}/fillMono`);
    const outlineMono = frames.get(`${arm}/outlineMono`);
    for (const entry of CROSSOVER_CASES) {
      const rect = cellRect(entry);
      const failed = (variant: CrossoverVariant) =>
        failedCells.has(`${arm}/${variant}/${entry.name}`);
      const crop = (image: RgbaImage | undefined) =>
        image ? cropRgba(image, rect.x, rect.y, rect.width, rect.height) : null;

      // ---- metric (i): interior uniformity, `product` only ----
      const mask = masks.get(entry.name);
      const productCell = crop(product);
      let interior: CrossoverRow["interior"];
      if (!reference) {
        interior = {
          notMeasured:
            "the `reference` arm was not rendered, so there is no shared interior mask — a mask taken from the arm being graded would let an arm whose interior collapsed score perfectly uniform",
          command: REFERENCE_COMMAND,
        };
      } else if (!productCell || failed("product")) {
        interior = {
          notMeasured:
            "the `product` cell failed the presence guard — an empty cell has a perfectly uniform interior",
        };
      } else if (!mask || mask.pixels === 0) {
        interior = {
          notMeasured: `the interior mask is EMPTY at erosion radius ${erosionRadius} px — every stem of this case is thinner than the erosion, so there is no interior to be uniform over. Not 0 %, not 100 %.`,
        };
      } else {
        interior = {
          ...interiorUniformity(
            productCell,
            mask.mask,
            PRODUCT_FILL,
            mask.erosionRadius,
          ),
          maskPixels: mask.pixels,
        };
      }

      // ---- metric (iii): edge profiles, on the two COVERAGE planes ----
      const fillCell = crop(fillMono);
      const fillEdge: CrossoverRow["fillEdge"] =
        fillCell && !failed("fillMono")
          ? edgeProfile(channelPlane(fillCell))
          : {
              notMeasured: fillCell
                ? "the `fillMono` cell failed the presence guard — a blank plane has no edge"
                : "the `fillMono` frame was not rendered",
            };
      const outlineCell = crop(outlineMono);
      const outlineEdge: CrossoverRow["outlineEdge"] =
        entry.spreadPx === 0
          ? {
              notMeasured:
                "spread 0 draws no dilated pass, so there is no outline edge to measure. The fill edge in this row is the whole boundary.",
            }
          : outlineCell && !failed("outlineMono")
            ? edgeProfile(channelPlane(outlineCell))
            : {
                notMeasured: outlineCell
                  ? "the `outlineMono` cell failed the presence guard"
                  : "the `outlineMono` frame was not rendered",
              };

      // ---- metric (iv): distortion against the 8x reference ----
      const referenceCell = crop(reference);
      const distortion: CrossoverRow["distortion"] = !referenceCell
        ? {
            notMeasured:
              "the `reference` arm was not rendered, so there is no ceiling to measure distance from",
            command: REFERENCE_COMMAND,
          }
        : fillCell && !failed("fillMono")
          ? distortionVsReference(
              channelPlane(fillCell),
              channelPlane(referenceCell),
            )
          : { notMeasured: "the `fillMono` cell failed the presence guard" };

      // ---- metric (ii): per-channel byte diff against Godot ----
      let godot: CrossoverRow["godot"];
      if (godotFrames.size === 0 || arm === "reference") {
        godot = {
          notMeasured:
            arm === "reference"
              ? "the reference is a computed ceiling, not a renderer — a byte diff against Godot would compare Godot with node's box filter"
              : `no Godot frame at ${relative(REPO_ROOT, godotDir)}/<face>-product.png yet. NOT MEASURED — never 0.`,
          command: GODOT_COMMAND,
        };
      } else if (!productCell || failed("product")) {
        godot = {
          notMeasured: "the `product` cell failed the presence guard",
        };
      } else {
        const diffs: Record<string, ChannelDiff> = {};
        for (const [godotFace, image] of godotFrames) {
          diffs[godotFace] = perChannelByteDiff(
            productCell,
            cropRgba(image, rect.x, rect.y, rect.width, rect.height),
          );
        }
        godot = diffs;
      }

      rows.push({
        arm,
        case: entry.name,
        pixelsPerEm: entry.pixelsPerEm,
        spreadPx: entry.spreadPx,
        interior,
        fillEdge,
        outlineEdge,
        distortion,
        godot,
      });
    }
  }

  if (godotAbsent.length > 0) {
    notMeasured.push({
      what: `metric (ii), the per-channel byte diff against Godot: ${godotAbsent.join(", ")}`,
      command: GODOT_COMMAND,
    });
  }
  if (!arms.includes("reference")) {
    notMeasured.push({
      what: "metrics (i) and (iv): both need the 8x `reference` arm, which this run did not render",
      command: REFERENCE_COMMAND,
    });
  }

  const report = {
    probe: "text-crossover",
    generatedAt: new Date().toISOString(),
    outDir: relative(REPO_ROOT, outDir),
    chrome: { version: browser.version, describe: browser.describe },
    gpu,
    face,
    hbContrast: contrastFlag,
    erosionRadius,
    superSample: SUPER_SAMPLE,
    frame: { width: FRAME_WIDTH, height: CANVAS_HEIGHT },
    text: CROSSOVER_TEXT,
    arms,
    variants: CROSSOVER_VARIANTS,
    // The repeats-and-medians rule is deliberately replaced here — see the file header.
    methodology:
      "fidelity sweep: no repeats, no medians. Each variant is rendered once and the `product` variant twice, byte-compared; `determinism` below is that result. Presence guard on every cell of every frame; failures are listed rather than averaged in. Calibration patch on every frame.",
    determinism,
    calibration,
    failures,
    interiorMask: [...masks.entries()].map(([name, mask]) => ({
      case: name,
      pixels: mask.pixels,
      erosionRadius: mask.erosionRadius,
      measured: mask.pixels > 0,
    })),
    emptyMasks,
    godot: {
      dir: relative(REPO_ROOT, godotDir),
      found: godotFound,
      absent: godotAbsent,
      command: GODOT_COMMAND,
    },
    hbCellReports,
    notMeasured,
    rows,
  };
  await writeFile(
    join(outDir, "text-crossover.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log(
    `\n${formatCrossoverTable(rows, { erosionRadius, contrast: contrastFlag })}`,
  );
  console.log(`\nGPU: ${gpu.hardware} — ${gpu.hardwareDetail}`);
  console.log(`face: ${face.path} (${face.source})`);
  console.log(
    `determinism: ${determinism.map((d) => `${d.arm}/${d.variant} ${d.result}`).join(", ") || "(not run)"}`,
  );
  const badCalibration = calibration.filter((entry) => !entry.ok);
  console.log(
    `calibration: ${calibration.length - badCalibration.length}/${calibration.length} frames within ${CALIBRATION_TOLERANCE} byte of round(255a)` +
      (badCalibration.length > 0
        ? ` — FAILED on ${badCalibration.map((e) => `${e.arm}/${e.variant}`).join(", ")}`
        : ""),
  );
  console.log(
    `presence guard: ${failures.length} failing cell(s)` +
      (failures.length > 0
        ? `\n${failures.map((f) => `  !! ${f.arm}/${f.variant} ${f.case}: ${f.reason}`).join("\n")}`
        : ""),
  );
  console.log(
    masks.size === 0
      ? `interior mask: NOT BUILT — the 8x \`reference\` arm was not rendered, so metric (i) has no shared mask for any of the ${CROSSOVER_CASES.length} cases. That is not "0 empty".`
      : `interior mask: erosion radius ${erosionRadius} px; ${emptyMasks.length} of ${masks.size} cases EMPTY (NOT MEASURED)` +
          (emptyMasks.length > 0
            ? ` — ${emptyMasks.map((e) => `${e.case} (ppem ${e.pixelsPerEm})`).join(", ")}`
            : ""),
  );
  for (const entry of notMeasured) {
    console.log(`\nNOT MEASURED: ${entry.what}\n  ${entry.command}`);
  }
  console.log(`\nartifacts: ${outDir}`);
}

// ---------------------------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------------------------

const num = (value: number | null | undefined, digits: number): string =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : value.toFixed(digits);

/**
 * ONE TABLE PER SPREAD COLUMN, never one table with a spread column.
 *
 * A distortion at spread 0 and a distortion at spread 6 are two different pictures — the second has
 * a dilated silhouette under it — so interleaving them invites a comparison down a column that is
 * not a size sweep. Reading down a table here IS the size sweep the probe exists to produce.
 */
export function formatCrossoverTable(
  rows: readonly CrossoverRow[],
  options: { erosionRadius: number; contrast: string },
): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  const lines: string[] = [];
  const spreads = [...new Set(rows.map((row) => row.spreadPx))].sort(
    (a, b) => a - b,
  );
  for (const spread of spreads) {
    lines.push(
      `spread ${spread} px   [hb-contrast ${options.contrast}, erosion ${options.erosionRadius} px]`,
      `${pad("ppem", 6)}${pad("arm", 11)}${pad("interior exact", 15)}${pad("mask px", 9)}${pad("fill 10-90", 12)}${pad("outline 10-90", 15)}${pad("distortion", 11)}${pad("godot dxdy", 11)}`,
      "-".repeat(90),
    );
    const column = rows.filter((row) => row.spreadPx === spread);
    for (const ppem of [...new Set(column.map((row) => row.pixelsPerEm))].sort(
      (a, b) => a - b,
    )) {
      for (const row of column.filter((r) => r.pixelsPerEm === ppem)) {
        const interior = isNotMeasured(row.interior)
          ? "NOT MEASURED"
          : row.interior.exactRatio === null
            ? "NOT MEASURED"
            : `${(row.interior.exactRatio * 100).toFixed(1)} %`;
        const maskPixels = isNotMeasured(row.interior)
          ? "—"
          : String(row.interior.maskPixels);
        const godot = isNotMeasured(row.godot)
          ? "—"
          : Object.entries(row.godot)
              .map(
                ([faceName, diff]) =>
                  `${faceName}:${diff.registration.dx},${diff.registration.dy}${diff.registration.clamped ? "!" : ""}`,
              )
              .join(" ");
        lines.push(
          pad(String(ppem), 6) +
            pad(row.arm, 11) +
            pad(interior, 15) +
            pad(maskPixels, 9) +
            pad(
              isNotMeasured(row.fillEdge)
                ? "NOT MEAS."
                : num(row.fillEdge.width1090Px, 3),
              12,
            ) +
            pad(
              isNotMeasured(row.outlineEdge)
                ? "NOT MEAS."
                : num(row.outlineEdge.width1090Px, 3),
              15,
            ) +
            pad(
              isNotMeasured(row.distortion)
                ? "NOT MEAS."
                : num(row.distortion.distortion, 4),
              11,
            ) +
            pad(godot, 11),
        );
      }
    }
    lines.push("");
  }
  lines.push(
    "interior exact: metric (i). Share of the eroded interior mask whose three channels are EXACTLY",
    "  the product fill #ffedc8, on the `product` variant. The mask comes from the 8x REFERENCE, not",
    "  from the arm being graded — an arm whose interior collapsed would otherwise be measured over a",
    "  tiny mask and score perfectly uniform. `NOT MEASURED` means the mask came back empty at this",
    "  erosion radius (every stem thinner than the erosion) or the cell failed its presence guard. It",
    "  is never 0 % and never 100 % by default.",
    "mask px: how many pixels that percentage is over. A ratio without it is not a measurement.",
    "fill / outline 10-90: metric (iii), the 10 %->90 % transition width in px, measured on the",
    "  white-on-black `fillMono` and `outlineMono` planes where the decoded byte IS the coverage.",
    "  Never on `product`, which has two boundaries a few px apart at every glyph edge. At spread 0",
    "  there is no dilated pass and therefore no outline edge — NOT MEASURED, not 0.",
    "distortion: metric (iv), |1 - acutance/reference| on `fillMono` against the same geometry drawn",
    "  at 8x and box-downsampled. NOT higher-is-better on acutance: the reference is correct area",
    "  coverage, so BELOW it is blur and ABOVE it is aliasing; only the distance from it says how",
    "  wrong an arm is.",
    "godot dxdy: metric (ii)'s whole-pixel registration offset per Godot face. `!` means the winner",
    "  sat on the edge of the search window and the offset is not trustworthy. The byte diffs",
    "  themselves are in the JSON; `—` means no Godot frame was on disk, which is NOT MEASURED.",
  );
  return lines.join("\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
