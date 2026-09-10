// ARM (d) OF THE TEXT-FIDELITY CROSSOVER SWEEP: drive Godot's own rasteriser over the case matrix in
// `packages/perf-harness/probes/text-crossover-cases.ts` and write six frames plus a settings report.
//
//   mise exec -- pnpm -w run godot:text-crossover
//   mise exec -- pnpm -w run godot:text-crossover -- --skip-render   # re-measure the PNGs on disk
//
// DO NOT RUN THIS UNDER `xvfb-run`. It spawns its own, because the capture pass must be
// non-headless — `--headless` renders nothing and every PNG would be black — and nesting two of them
// is what `scripts/claude-guard-bash.sh` blocks. It also has to size the virtual screen itself: the
// grid is 1280x1160 and `xvfb-run`'s default screen is 1280x1024, so a default-sized Xvfb would
// silently hand back a window 136 px short and the bottom row of the sweep would not exist.
//
// THE AXIS IS MSDF, AND THAT IS THE WHOLE DESIGN. Two faces are rendered whose settings are
// byte-identical except `multichannel_signed_distance_field`:
//
//   * `msdf`  — the GAME'S OWN import settings, recovered from `kreon_bold.ttf.import` in
//               spirectl's extracted project: antialiasing GRAY, no mipmaps, embedded bitmaps off,
//               MSDF on with `msdf_size` 48 and `msdf_pixel_range` 24, system fallback on,
//               autohinter off, hinting LIGHT, subpixel positioning AUTO, rounding remainders kept.
//   * `gray`  — the same bundle with MSDF off.
//
// The pair answers one question and it is the question the sweep opened on: the user's claim is that
// the game's glyph interior is byte-uniform at #ffedc8 while ours is mottled. If `msdf` is uniform
// and `gray` is not, the cause is the distance-field path — a hard threshold in a shader rather than
// a coverage ramp out of FreeType — and no amount of tuning our coverage blend reproduces it.
//
// NOTHING HERE RE-DERIVES A CASE. Every cell rectangle, pen, colour, ppem and outline size comes out
// of the contract module and goes into the manifest verbatim; `text_crossover_ref.gd` reads the
// manifest and derives nothing of its own. A second copy of `cellRect` on the Godot side would be
// free to drift half a pixel from the browser side, and half a pixel is the entire subject of the
// byte-diff metric these frames exist to feed.
//
// THREE GUARDS RUN BEFORE ANY NUMBER IS REPORTED, and each of them is a failure this harness has
// actually seen:
//
//   1. CALIBRATION. White at alpha 0.25/0.5/0.75 over black must decode to 64/128/191. If the frame
//      went through a linear->sRGB conversion 0.5 would come back as ~188, every byte in the sweep
//      would be wrong by a transfer curve, and nothing else in the pipeline would notice.
//   2. BACKGROUND. An empty corner of each frame must hold the exact colour the frame asked for.
//      This is the same question one step earlier: it catches a background that took a different
//      path to the framebuffer than the ink drawn over it.
//   3. PRESENCE. Every one of the 28 cells in every frame must contain ink. A blank cell scores a
//      PERFECT interior uniformity and a perfect byte diff against itself, which is this harness's
//      stated number-one failure mode — an empty frame is the most convincing result it can produce
//      and the most wrong.
//
// WHY THE DECODE LIVES HERE. `sharp` is a native module with a 30 MB install and only
// `packages/perf-harness` depends on it; it is resolved through a `createRequire` anchored inside
// that package, the same trick `scripts/godot-outline-ref.ts` uses.
//
// `--godot` DEFAULTS TO `mise exec -- godot`. The `godot` on PATH here is 4.6; this project targets
// 4.5.1 and mise pins it. The run refuses any version whose major.minor is not 4.5, read back out of
// `Engine.get_version_info()` rather than off the binary's name.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALIBRATION_HEIGHT,
  CALIBRATION_SWATCHES,
  CALIBRATION_TOLERANCE,
  CALIBRATION_TOP,
  CANVAS_HEIGHT,
  CROSSOVER_CASES,
  CROSSOVER_TEXT,
  CROSSOVER_VARIANTS,
  type CrossoverCase,
  type CrossoverVariant,
  cellRect,
  colorsFor,
  FRAME_WIDTH,
} from "../packages/perf-harness/probes/text-crossover-cases";
import { ensureLatinBenchFont } from "./ensure-latin-font";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = join(REPO_ROOT, "godot", "project");

/** The schema this script writes. Bump on a shape change. */
const SCHEMA = "godot-text-crossover/1";

/**
 * The real face the product draws with, in spirectl's extracted copy of the game.
 *
 * PREFERRED AND NOT REQUIRED. The sweep has to be reproducible on a checkout that has no sibling
 * repo, so a missing Kreon falls back to the committed Roboto fixture — but the fallback is written
 * into `face.path` and `fontFallback` in the report and printed on stderr, never silent. A crossover
 * measured on Roboto and read as if it were the game's own face would be a wrong answer that looked
 * exactly like a right one.
 */
const KREON_PATH =
  "../spirectl/.sts2/toolchain/recovered-project/fonts/kreon_bold.ttf";

/**
 * TextServer enums, restated because GDScript's names do not cross the manifest.
 *
 * These are the GAME'S values, read out of `kreon_bold.ttf.import`, not this repo's habits:
 * `outline_ref.gd`'s golden pins hinting NONE and subpixel positioning DISABLED so that Godot and
 * hb-gpu rasterise the same outline. This sweep does the opposite on purpose — it is asking what the
 * product's own text looks like, so it takes the product's own switches.
 */
const HINTING_LIGHT = 1;
const SUBPIXEL_POSITIONING_AUTO = 1;
const FONT_ANTIALIASING_GRAY = 1;

/** The MSDF numbers from the game's import. `msdf_pixel_range` 24 at `msdf_size` 48 is wide. */
const MSDF_SIZE = 48;
const MSDF_PIXEL_RANGE = 24;

/** The committed MSDF fixture variant, and the on-demand TTF that has to sit beside its `.import`. */
const MSDF_FIXTURE_DIR = "fixtures/assets/fonts/roboto-msdf";
const MSDF_FIXTURE_FILE = "Roboto-bench-msdf.ttf";

interface Face {
  key: string;
  path: string;
  hinting: number;
  subpixelPositioning: number;
  antialiasing: number;
  forceAutohinter: boolean;
  allowSystemFallback: boolean;
  disableEmbeddedBitmaps: boolean;
  generateMipmaps: boolean;
  modulateColorGlyphs: boolean;
  msdf: boolean;
  msdfSize: number;
  msdfPixelRange: number;
  fixedSize: number;
  oversampling: number;
  keepRoundingRemainders: boolean;
}

/** The game's bundle, with MSDF as the only free bit. See the header. */
function faceFor(key: string, path: string, msdf: boolean): Face {
  return {
    key,
    path,
    hinting: HINTING_LIGHT,
    subpixelPositioning: SUBPIXEL_POSITIONING_AUTO,
    antialiasing: FONT_ANTIALIASING_GRAY,
    forceAutohinter: false,
    allowSystemFallback: true,
    disableEmbeddedBitmaps: true,
    generateMipmaps: false,
    modulateColorGlyphs: false,
    msdf,
    msdfSize: MSDF_SIZE,
    msdfPixelRange: MSDF_PIXEL_RANGE,
    fixedSize: 0,
    // 0.0 is the import's own value and means "follow the viewport", which the GDScript pins to 1.
    oversampling: 0,
    keepRoundingRemainders: true,
  };
}

interface ManifestCell {
  name: string;
  fontKey: string;
  pixelsPerEm: number;
  outlineSize: number;
  spreadPx: number;
  penX: number;
  penY: number;
  text: string;
  outline: [number, number, number];
  fill: [number, number, number];
  drawOutline: boolean;
  drawFill: boolean;
  cellX: number;
  cellY: number;
  cellWidth: number;
  cellHeight: number;
}

function cellsFor(fontKey: string, variant: CrossoverVariant): ManifestCell[] {
  const colors = colorsFor(variant);
  return CROSSOVER_CASES.map((entry: CrossoverCase) => {
    const rect = cellRect(entry);
    return {
      name: entry.name,
      fontKey,
      pixelsPerEm: entry.pixelsPerEm,
      outlineSize: entry.outlineSize,
      spreadPx: entry.spreadPx,
      penX: entry.penX,
      penY: entry.penY,
      text: CROSSOVER_TEXT,
      outline: colors.outline,
      fill: colors.fill,
      drawOutline: colors.drawOutline,
      drawFill: colors.drawFill,
      cellX: rect.x,
      cellY: rect.y,
      cellWidth: rect.width,
      cellHeight: rect.height,
    };
  });
}

/** `sharp`, borrowed from `packages/perf-harness`. See the header on why it is not imported. */
async function loadSharp(): Promise<
  (input: string) => {
    ensureAlpha(): {
      raw(): {
        toBuffer(options: { resolveWithObject: true }): Promise<{
          data: Buffer;
          info: { width: number; height: number; channels: number };
        }>;
      };
    };
  }
> {
  const require = createRequire(
    join(REPO_ROOT, "packages", "perf-harness", "src", "index.ts"),
  );
  return require("sharp");
}

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Spawn, inherit stdio, reject on a non-zero exit. `godot-outline-ref.ts`'s `run`. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", rej);
    child.on("close", (code) =>
      code === 0
        ? res()
        : rej(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Put the MSDF fixture's TTF beside its committed `.import`.
 *
 * The `.import` IS committed and the font bytes are not — the same split every other fixture font in
 * this repo uses. It has to exist before the import pass runs, though: Godot treats an `.import`
 * whose `source_file` is missing as stale and is free to drop it, which would delete a committed
 * file as a side effect of rendering a frame.
 */
async function ensureMsdfFixtureFont(): Promise<string> {
  const latin = await ensureLatinBenchFont(REPO_ROOT);
  const dir = join(REPO_ROOT, MSDF_FIXTURE_DIR);
  await mkdir(dir, { recursive: true });
  const target = join(dir, MSDF_FIXTURE_FILE);
  if (!(await exists(target))) await copyFile(latin.path, target);
  return target;
}

interface Frame {
  face: string;
  variant: CrossoverVariant;
  screenshot: string;
  clearColor: [number, number, number];
  cells: ManifestCell[];
}

interface Plane {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

function pixelAt(plane: Plane, x: number, y: number): [number, number, number] {
  const at = (y * plane.width + x) * plane.channels;
  return [plane.data[at], plane.data[at + 1], plane.data[at + 2]];
}

/**
 * How many pixels of a cell are not the background, and how far right the ink reaches.
 *
 * THE RIGHT EDGE IS REPORTED BECAUSE THE GRID CAN BE TOO NARROW. The cells are 320 px and the pen is
 * 16 px in; "End Turn 1" at ppem 52 with a 6 px dilation is close to that. Ink touching the last
 * column would mean the case is bleeding into its neighbour and both cells' crops are contaminated.
 */
function inkOfCell(
  plane: Plane,
  cell: ManifestCell,
  background: [number, number, number],
): { ink: number; touchesRightEdge: boolean; touchesBottomEdge: boolean } {
  let ink = 0;
  let touchesRightEdge = false;
  let touchesBottomEdge = false;
  for (let y = 0; y < cell.cellHeight; y += 1) {
    for (let x = 0; x < cell.cellWidth; x += 1) {
      const [r, g, b] = pixelAt(plane, cell.cellX + x, cell.cellY + y);
      if (r === background[0] && g === background[1] && b === background[2]) {
        continue;
      }
      ink += 1;
      if (x === cell.cellWidth - 1) touchesRightEdge = true;
      if (y === cell.cellHeight - 1) touchesBottomEdge = true;
    }
  }
  return { ink, touchesRightEdge, touchesBottomEdge };
}

function distance2(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

export interface InteriorHistogram {
  cell: string;
  face: string;
  variant: CrossoverVariant;
  erosionRadius: number;
  interiorPixels: number;
  distinctTriples: number;
  /** Descending by count. `hex` is `#rrggbb`. */
  top: { hex: string; rgb: [number, number, number]; count: number }[];
}

/**
 * The distinct byte triples inside a glyph body, and the measurement the whole round turns on.
 *
 * THE REGION IS FOUND BY CLASSIFICATION AND THEN ERODED; THE BYTES ARE HISTOGRAMMED RAW. A pixel
 * joins the candidate mask if the fill colour is the nearest of {background, outline, fill} to it —
 * that is only a way to locate the glyph body, and it deliberately admits pixels that are merely
 * CLOSE to the fill rather than equal to it, because "close but not equal" is exactly the mottle
 * under test. The mask is then eroded by `radius`, which removes every antialiased boundary pixel:
 * what survives is interior in the strict sense that a whole disk around it is also fill. Only then
 * are the raw RGB triples counted. A uniform interior yields ONE triple; a mottled one yields many.
 */
function interiorHistogram(
  plane: Plane,
  cell: ManifestCell,
  background: [number, number, number],
  face: string,
  variant: CrossoverVariant,
  radius = 2,
): InteriorHistogram {
  const w = cell.cellWidth;
  const h = cell.cellHeight;
  const candidate = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = pixelAt(plane, cell.cellX + x, cell.cellY + y);
      const toFill = distance2(px, cell.fill);
      const toBackground = distance2(px, background);
      const toOutline = distance2(px, cell.outline);
      if (toFill <= toBackground && toFill <= toOutline)
        candidate[y * w + x] = 1;
    }
  }

  const counts = new Map<number, number>();
  let interiorPixels = 0;
  for (let y = radius; y < h - radius; y += 1) {
    for (let x = radius; x < w - radius; x += 1) {
      let solid = true;
      for (let dy = -radius; dy <= radius && solid; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (candidate[(y + dy) * w + x + dx] === 0) {
            solid = false;
            break;
          }
        }
      }
      if (!solid) continue;
      interiorPixels += 1;
      const [r, g, b] = pixelAt(plane, cell.cellX + x, cell.cellY + y);
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      hex: `#${key.toString(16).padStart(6, "0")}`,
      rgb: [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff] as [
        number,
        number,
        number,
      ],
      count,
    }));

  return {
    cell: cell.name,
    face,
    variant,
    erosionRadius: radius,
    interiorPixels,
    distinctTriples: counts.size,
    top,
  };
}

/** The cell the interior histogram is taken on: the size and radius the defect was reported at. */
const HISTOGRAM_CELL = "ppem52-spread6";
const HISTOGRAM_VARIANT: CrossoverVariant = "product";

/**
 * Erosion radii the interior is measured at, and why it is a SWEEP rather than one number.
 *
 * "The interior is uniform" is only a claim once the interior is defined, and every definition is an
 * erosion of some radius: too small and the answer is dominated by antialiased boundary pixels that
 * nobody calls interior, too large and the region shrinks toward the few fattest pixels of the
 * stems, where uniformity is nearly free. Reporting 1, 2 and 3 makes the reader's threshold visible
 * instead of picking one for them — if the triple count is 1 at every radius, no choice of interior
 * would have found mottle.
 */
const HISTOGRAM_RADII = [1, 2, 3] as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const skipRender = argv.includes("--skip-render");
  const godotBin = flag("godot") ?? "godot";
  const outDir = resolve(
    flag("out") ??
      join(REPO_ROOT, "artifacts", "perf", "probes", "text-crossover", "godot"),
  );
  await mkdir(outDir, { recursive: true });

  // THE FACE. Kreon if the sibling repo is here, the committed Roboto fixture if it is not, and the
  // answer written into the report either way — see KREON_PATH.
  const requested = flag("font") ?? KREON_PATH;
  let fontPath = resolve(REPO_ROOT, requested);
  let fontFallback: string | null = null;
  if (!(await exists(fontPath))) {
    const latin = await ensureLatinBenchFont(REPO_ROOT);
    fontFallback = `${requested} is not on this machine; fell back to the committed fixture face`;
    fontPath = latin.path;
    console.warn(`WARNING: ${fontFallback} (${fontPath})`);
  }
  const fontBytes = await readFile(fontPath);

  await ensureMsdfFixtureFont();

  const faces: Face[] = [
    faceFor("msdf", fontPath, true),
    faceFor("gray", fontPath, false),
  ];

  const frames: Frame[] = faces.flatMap((face) =>
    CROSSOVER_VARIANTS.map((variant) => ({
      face: face.key,
      variant,
      screenshot: join(outDir, `${face.key}-${variant}.png`),
      clearColor: colorsFor(variant).background,
      cells: cellsFor(face.key, variant),
    })),
  );

  const manifestPath = join(outDir, "manifest.json");
  const gdReportPath = join(outDir, "godot-report.json");
  const reportPath = join(outDir, "report.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schema: SCHEMA,
        viewportWidth: FRAME_WIDTH,
        viewportHeight: CANVAS_HEIGHT,
        warmupFrames: 12,
        faces,
        frames,
        calibration: {
          top: CALIBRATION_TOP,
          height: CALIBRATION_HEIGHT,
          swatches: CALIBRATION_SWATCHES,
        },
        output: gdReportPath,
      },
      null,
      2,
    ),
    "utf8",
  );

  if (!skipRender) {
    // The import pass first, headless, exactly as the parity flow does: without it Godot may rebuild
    // `.godot/` during the capture run and the frame that gets read back is whatever was up then.
    await run(godotBin, ["--headless", "--path", PROJECT_ROOT, "--import"]);
    // AND THE CAPTURE NON-HEADLESS, under its own Xvfb, on a screen big enough for the whole grid.
    // See the file header — do not wrap this script in another xvfb-run.
    await run("xvfb-run", [
      "-a",
      "-s",
      `-screen 0 ${FRAME_WIDTH + 64}x${CANVAS_HEIGHT + 64}x24`,
      godotBin,
      "--path",
      PROJECT_ROOT,
      "--script",
      "res://scripts/text_crossover_ref.gd",
      "--",
      "--manifest",
      manifestPath,
    ]);
  }

  const gd = JSON.parse(await readFile(gdReportPath, "utf8")) as {
    godot: string;
    godotMajor: number;
    godotMinor: number;
    oversampling: number;
    oversamplingOverride: number;
    adapter: string;
    renderer: string;
    snap2dTransforms: boolean;
    snap2dVertices: boolean;
    faces: Record<string, unknown>[];
    frames: Record<string, unknown>[];
  };

  // THE VERSION GATE. 4.6 is on this box's PATH and rasterises text differently enough that a sweep
  // built with it would describe a different engine wearing this project's name.
  if (gd.godotMajor !== 4 || gd.godotMinor !== 5) {
    throw new Error(
      `this sweep is for Godot 4.5 and the capture ran ${gd.godot} — pass \`--godot "$(mise which godot)"\` or run it through \`mise exec --\``,
    );
  }
  if (gd.oversampling !== 1 || gd.oversamplingOverride !== 1) {
    throw new Error(
      `oversampling came back ${gd.oversampling} (override ${gd.oversamplingOverride}) — font_size is then a design size and every ppem in this sweep is a different number than it says`,
    );
  }
  for (const face of gd.faces) {
    const key = String(face.key);
    const wanted = faces.find((f) => f.key === key);
    if (!wanted) continue;
    if (face.msdf !== wanted.msdf) {
      throw new Error(
        `face "${key}" asked for msdf=${wanted.msdf} and Godot read back ${face.msdf} — the axis this sweep is built on did not take`,
      );
    }
    if (
      wanted.msdf &&
      (face.msdfSize !== wanted.msdfSize ||
        face.msdfPixelRange !== wanted.msdfPixelRange)
    ) {
      throw new Error(
        `face "${key}" asked for msdf_size=${wanted.msdfSize}/msdf_pixel_range=${wanted.msdfPixelRange} and Godot read back ${face.msdfSize}/${face.msdfPixelRange}`,
      );
    }
  }

  const sharp = await loadSharp();
  const failures: string[] = [];
  const frameReports: Record<string, unknown>[] = [];
  const histograms: InteriorHistogram[] = [];

  for (const frame of frames) {
    const png = await readFile(frame.screenshot);
    const decoded = await sharp(frame.screenshot)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const plane: Plane = {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
    const label = `${frame.face}-${frame.variant}`;
    if (plane.width !== FRAME_WIDTH || plane.height !== CANVAS_HEIGHT) {
      throw new Error(
        `${label}: the capture is ${plane.width}x${plane.height} and the manifest asked for ${FRAME_WIDTH}x${CANVAS_HEIGHT}`,
      );
    }

    // GUARD 1 — CALIBRATION, before any other number is looked at. See the header.
    const calibration = CALIBRATION_SWATCHES.map((swatch) => {
      const x = swatch.x + Math.floor(swatch.width / 2);
      const y = CALIBRATION_TOP + Math.floor(CALIBRATION_HEIGHT / 2);
      const [r, g, b] = pixelAt(plane, x, y);
      return {
        alpha: swatch.alpha,
        expected: Math.round(255 * swatch.alpha),
        measured: g,
        rgb: [r, g, b] as [number, number, number],
      };
    });
    for (const entry of calibration) {
      if (Math.abs(entry.measured - entry.expected) > CALIBRATION_TOLERANCE) {
        failures.push(
          `${label}: the calibration patch at alpha ${entry.alpha} decoded to ${entry.measured}, not ${entry.expected} — this frame is not blending in plain sRGB bytes, so no byte in it means what it says`,
        );
      }
    }

    // GUARD 2 — BACKGROUND. The top-right corner is outside every cell's pen reach.
    const cornerRgb = pixelAt(plane, FRAME_WIDTH - 1, 0);
    const background = frame.clearColor;
    const backgroundOk =
      cornerRgb[0] === background[0] &&
      cornerRgb[1] === background[1] &&
      cornerRgb[2] === background[2];
    if (!backgroundOk) {
      failures.push(
        `${label}: the background decoded to rgb(${cornerRgb.join(",")}) and the frame asked for rgb(${background.join(",")}) — the clear colour and the ink did not take the same path to the framebuffer`,
      );
    }

    // GUARD 3 — PRESENCE, cell by cell. See the header on why an empty cell is the worst outcome.
    const cells = frame.cells.map((cell) => {
      const measured = inkOfCell(plane, cell, background);
      return {
        name: cell.name,
        pixelsPerEm: cell.pixelsPerEm,
        spreadPx: cell.spreadPx,
        outlineSize: cell.outlineSize,
        ...measured,
      };
    });
    const empty = cells.filter((cell) => cell.ink === 0);
    if (empty.length > 0) {
      failures.push(
        `${label}: ${empty.length} cell(s) contain no ink at all (${empty.map((c) => c.name).join(", ")}) — a blank cell scores a perfect uniformity`,
      );
    }
    const bleeding = cells.filter((cell) => cell.touchesRightEdge);
    if (bleeding.length > 0) {
      failures.push(
        `${label}: ${bleeding.length} cell(s) have ink on their last column (${bleeding.map((c) => c.name).join(", ")}) — the run is wider than the 320 px cell and is bleeding into its neighbour`,
      );
    }

    if (frame.variant === HISTOGRAM_VARIANT) {
      const cell = frame.cells.find((c) => c.name === HISTOGRAM_CELL);
      if (cell) {
        for (const radius of HISTOGRAM_RADII) {
          histograms.push(
            interiorHistogram(
              plane,
              cell,
              background,
              frame.face,
              frame.variant,
              radius,
            ),
          );
        }
      }
    }

    const inkTotal = cells.reduce((sum, cell) => sum + cell.ink, 0);
    console.log(
      `${label.padEnd(18)} ink ${String(inkTotal).padStart(8)} px over ${cells.length} cells | min ${Math.min(...cells.map((c) => c.ink))} | calibration ${calibration.map((c) => c.measured).join("/")} | bg rgb(${cornerRgb.join(",")})${backgroundOk ? "" : " MISMATCH"}`,
    );

    frameReports.push({
      face: frame.face,
      variant: frame.variant,
      screenshot: frame.screenshot,
      pngSha256: sha256(png),
      clearColor: frame.clearColor,
      background: {
        expected: background,
        measured: cornerRgb,
        ok: backgroundOk,
      },
      calibration,
      inkTotal,
      cells,
    });
  }

  for (const histogram of histograms) {
    const preview = histogram.top
      .slice(0, 8)
      .map((entry) => `${entry.hex} x${entry.count}`)
      .join(", ");
    console.log(
      `\ninterior of ${histogram.cell} (${histogram.face}, ${histogram.variant}, erosion r=${histogram.erosionRadius}): ${histogram.interiorPixels} px, ${histogram.distinctTriples} distinct triple(s)\n  ${preview}${histogram.top.length > 8 ? ", …" : ""}`,
    );
  }

  const report = {
    schema: SCHEMA,
    // PROVENANCE. Everything a reader needs to decide whether these frames describe their checkout.
    godot: gd.godot,
    renderer: gd.renderer,
    adapter: gd.adapter,
    oversampling: gd.oversampling,
    oversamplingOverride: gd.oversamplingOverride,
    snap2dTransforms: gd.snap2dTransforms,
    snap2dVertices: gd.snap2dVertices,
    font: {
      requested,
      path: fontPath,
      sha256: sha256(fontBytes),
      bytes: fontBytes.length,
      fallback: fontFallback,
    },
    text: CROSSOVER_TEXT,
    viewport: { width: FRAME_WIDTH, height: CANVAS_HEIGHT },
    // As Godot READ THEM BACK, not as they were requested — see `text_crossover_ref.gd`.
    faces: gd.faces,
    frames: frameReports,
    interior: histograms,
    guards: {
      calibrationTolerance: CALIBRATION_TOLERANCE,
      failures,
    },
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${reportPath}`);
  console.log(`artifacts (gitignored): ${outDir}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} guard failure(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}

await main();
