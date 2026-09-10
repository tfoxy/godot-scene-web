// Build the GODOT REFERENCE GOLDEN: render `GODOT_OUTLINE_CASES` through Godot's own rasteriser,
// measure the result with `outline-metrics.ts`, and commit the numbers.
//
//   mise exec -- pnpm -w run godot:outline-ref            # render and WRITE the golden
//   mise exec -- pnpm -w run godot:outline-ref -- --check  # render and DIFF, write nothing
//
// DO NOT RUN THIS UNDER `xvfb-run`. It spawns its own (`xvfb-run -a godot …`), because the capture
// pass must be non-headless — `--headless` renders nothing and the PNG would be black — and nesting
// two of them is what `scripts/claude-guard-bash.sh` blocks.
//
// WHY A GOLDEN OF NUMBERS AND NOT OF PIXELS. A committed PNG would be a golden IMAGE, and the first
// driver or Godot patch to move one byte would fail it for a reason nobody could act on. What this
// round needs from Godot is four scalars per case — how soft the rim is, how far it reaches, how
// round it is, how much ink it carries — and those are stable across the things that make a PNG
// unstable. The PNGs are kept under `artifacts/` for a human to look at and are gitignored.
//
// WHY THE DECODE LIVES HERE AND NOWHERE ELSE. `@godot-scene-web/hb-gpu` has no workspace
// dependencies at all — `canvas` depends on IT — and PNG decoding means `sharp`, a native module
// with a 30 MB install. So this script owns the decode, hands `outline-metrics.ts` a plain byte
// plane, and hb-gpu's dependency list does not move. `sharp` is resolved through a `createRequire`
// anchored INSIDE `packages/perf-harness`, which already depends on it — the same trick
// `scripts/ensure-cjk-font.ts` uses to reach `harfbuzzjs`'s sibling wasm from the repo root.
//
// `--godot` DEFAULTS TO `godot` AND YOU ALMOST CERTAINLY WANT `mise exec -- godot`. The `godot` on
// PATH here is 4.6.2; this project targets 4.5.1 and mise pins it. The script refuses any major
// other than 4.5 outright rather than producing a golden nobody can reproduce — the version is read
// back out of `Engine.get_version_info()`, not off the binary's name.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GODOT_OUTLINE_CASES,
  type GodotOutlineCase,
} from "../packages/hb-gpu/test/geometry";
import {
  type CoverageImage,
  measureOutline,
  type OutlineMetrics,
} from "../packages/hb-gpu/test/outline-metrics";
import { ensureCjkFont } from "./ensure-cjk-font";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = join(REPO_ROOT, "godot", "project");
const GOLDEN_PATH = join(
  REPO_ROOT,
  "packages",
  "hb-gpu",
  "test",
  "goldens",
  "godot-outline-metrics.json",
);

/** The schema this script writes and `glyphPixelXvfb.test.ts` reads. Bump on a shape change. */
const SCHEMA = "godot-outline-metrics/1";

/** Cell side and the viewport the row of them needs. */
const CELL = 128;
const CALIBRATION_TOP = 160;
const CALIBRATION_HEIGHT = 40;
const CALIBRATION_WIDTH = 64;

/**
 * The alphas the calibration patch draws, and what their bytes must be.
 *
 * PLAIN sRGB-BYTE BLENDING IS THE ASSUMPTION EVERY COVERAGE NUMBER HERE RESTS ON. White at alpha
 * `a` over black decodes to `round(255a)` if and only if the frame never went through a
 * linear->sRGB conversion. If it did, 0.5 would come back as ~188 rather than 128, every rim byte
 * would be off by a transfer curve, and the golden would compare Godot's tone mapping against
 * hb-gpu's coverage while looking perfectly reasonable.
 */
const CALIBRATION_ALPHAS = [0.25, 0.5, 0.75] as const;

/** Byte slack on the patch. 1 covers `round(127.5)` alone; nothing else here is near a boundary. */
const CALIBRATION_TOLERANCE = 1;

/**
 * The one UNGRADED cell: `han-desktop` again, with hinting NORMAL instead of NONE.
 *
 * A REALISM COLUMN, NOT A REFERENCE. Every graded case runs hinting NONE so that Godot and hb-gpu
 * are rasterising the same outline — a hinted glyph has had its stems moved onto the pixel grid and
 * is a different SHAPE, so grading against it would report a hinting difference as a rim
 * difference. But hinting NORMAL is what a Godot project gets by default, so the golden carries one
 * cell of it: if the two columns turn out far apart, "our outline is softer than Godot's" and "our
 * outline is softer than the Godot the user is actually looking at" stop being the same sentence.
 */
const REALISM_CASE = "han-desktop";

interface Face {
  key: string;
  path: string;
  hinting: number;
  subpixelPositioning: number;
  antialiasing: number;
  forceAutohinter: boolean;
  allowSystemFallback: boolean;
  disableEmbeddedBitmaps: boolean;
}

/** TextServer enums, restated because GDScript's names do not cross the manifest. */
const HINTING_NONE = 0;
const HINTING_NORMAL = 2;
const SUBPIXEL_POSITIONING_DISABLED = 0;
const FONT_ANTIALIASING_GRAY = 1;

function faceFor(key: string, path: string, hinting: number): Face {
  return {
    key,
    path,
    hinting,
    // EVERY SWITCH THAT DECIDES WHAT THE RASTERISER DOES, stated rather than defaulted.
    // `subpixel_positioning` off because it makes the bitmap depend on the pen's FRACTION and every
    // pen here is whole; `ANTIALIASING_GRAY` because LCD would put three different coverages in the
    // three channels and the decode reads one; no system fallback so a missing glyph is an error
    // rather than a different font; no embedded bitmaps so the outline is always what is drawn.
    subpixelPositioning: SUBPIXEL_POSITIONING_DISABLED,
    antialiasing: FONT_ANTIALIASING_GRAY,
    forceAutohinter: false,
    allowSystemFallback: false,
    disableEmbeddedBitmaps: true,
  };
}

interface Cell {
  name: string;
  case: string;
  fontKey: string;
  codepoint: number;
  text: string;
  cellX: number;
  cellY: number;
  cellSize: number;
  originX: number;
  originY: number;
  pixelsPerEm: number;
  outlineSize: number;
  spreadPx: number;
  radial: boolean;
  graded: boolean;
}

/** The row of cells, graded ones first and the realism column last. */
function buildCells(cases: readonly GodotOutlineCase[]): Cell[] {
  const cells: Cell[] = [];
  const push = (
    item: GodotOutlineCase,
    fontKey: string,
    name: string,
    graded: boolean,
  ): void => {
    cells.push({
      name,
      case: item.name,
      fontKey,
      codepoint: item.text.codePointAt(0) ?? 0,
      text: item.text,
      cellX: cells.length * CELL,
      cellY: 0,
      cellSize: item.size,
      originX: item.originX,
      originY: item.originY,
      pixelsPerEm: item.pixelsPerEm,
      outlineSize: item.outlineSize,
      spreadPx: item.spreadPx,
      radial: item.radial,
      graded,
    });
  };
  for (const item of cases) push(item, "graded", item.name, true);
  const realism = cases.find((item) => item.name === REALISM_CASE);
  if (!realism) {
    throw new Error(
      `the realism column names "${REALISM_CASE}", which is not in GODOT_OUTLINE_CASES`,
    );
  }
  push(realism, "hintedNormal", `${REALISM_CASE}-hinted`, false);
  return cells;
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

/** Spawn, inherit stdio, reject on a non-zero exit. `godot-text-bench.ts`'s `run`. */
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

/** One cell's coverage plane, lifted out of the full-frame RGBA. */
function cropCoverage(
  rgba: Buffer,
  frameWidth: number,
  channels: number,
  cell: Cell,
): CoverageImage {
  const size = cell.cellSize;
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = ((cell.cellY + y) * frameWidth + cell.cellX + x) * channels;
      // THE GREEN CHANNEL IS THE COVERAGE. The ink is opaque white on black, so all three colour
      // channels carry the same number; green is taken because it is the one the fidelity probe
      // reads and because a red-only read would be blind to a channel swap.
      data[y * size + x] = rgba[at + 1];
    }
  }
  return { data, width: size, height: size };
}

interface CaseGolden {
  name: string;
  case: string;
  graded: boolean;
  hinting: number;
  text: string;
  pixelsPerEm: number;
  outlineSize: number;
  spreadPx: number;
  originX: number;
  originY: number;
  cellX: number;
  cellY: number;
  cellSize: number;
  metrics: OutlineMetrics;
  /**
   * `ink / (pi * r50Mean²)` for the radial cases — how much of the disk its own reach implies is
   * actually inked. `null` where no radial profile was taken.
   *
   * THE NUMBER THAT SAYS GODOT'S OUTLINE IS NOT ALWAYS A DILATION. `draw_char_outline` is a
   * STROKE, and when the stroker's radius exceeds a feature's own half-width the inner border
   * inverts instead of collapsing: at `dot-radial-wide` the dot's radius is 3.89 px and the
   * stroker's is 12, and the frame is a white annulus from 8.1 to 15.9 px with a BLACK GAP from
   * 3.9 to 8.1 and the fill alone in the middle — measured off the capture, ring by ring. 8.1 is
   * `|3.89 - 12|` to two decimals.
   *
   * So for that case Godot's INTERIOR is not comparable with an hb-gpu dilation, which is a true
   * union of disks and therefore solid. Its OUTER boundary is, which is exactly why the radial
   * metric takes the outermost crossing and why reach and rim softness are the columns this golden
   * is graded on. At `dot-radial` the same inversion happens and closes: the dot's radius is 1.98
   * against a stroker's 4, so the gap is 0.04 px wide and antialiases shut (measured 0.996).
   */
  inkVsDiskOfR50: number | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const check = argv.includes("--check");
  const godotBin = flag("godot") ?? "godot";
  const outDir = resolve(
    flag("out") ?? join(REPO_ROOT, "artifacts", "godot-outline-ref"),
  );
  await mkdir(outDir, { recursive: true });

  const font = await ensureCjkFont(REPO_ROOT);
  if (!font.subset) {
    throw new Error(
      `the fixture font is the FULL upstream file (${font.subsetSkippedReason}) — the golden's fontSha256 would not match what every other arm loads`,
    );
  }
  const fontBytes = await readFile(join(REPO_ROOT, font.relativePath));
  const fontSha256 = sha256(fontBytes);

  const cells = buildCells(GODOT_OUTLINE_CASES);
  const viewportWidth = cells.length * CELL;
  const viewportHeight = CALIBRATION_TOP + CALIBRATION_HEIGHT + CELL / 4;
  const resPath = `res://${font.relativePath}`;
  const faces: Face[] = [
    faceFor("graded", resPath, HINTING_NONE),
    faceFor("hintedNormal", resPath, HINTING_NORMAL),
  ];
  const screenshot = join(outDir, "outline-ref.png");
  const manifestPath = join(outDir, "manifest.json");
  const reportPath = join(outDir, "outline-ref.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        viewportWidth,
        viewportHeight,
        fontPath: resPath,
        faces,
        cells,
        calibrationTop: CALIBRATION_TOP,
        calibrationHeight: CALIBRATION_HEIGHT,
        calibrationPatch: CALIBRATION_ALPHAS.map((alpha, i) => ({
          alpha,
          x: i * (CALIBRATION_WIDTH + 16),
          width: CALIBRATION_WIDTH,
        })),
        warmupFrames: 8,
        screenshot,
        output: reportPath,
      },
      null,
      2,
    ),
    "utf8",
  );

  // The import pass first, headless, exactly as the parity flow does: without it Godot may rebuild
  // `.godot/` during the capture run and the frame that gets read back is whatever was up then.
  await run(godotBin, ["--headless", "--path", PROJECT_ROOT, "--import"]);
  // AND THE CAPTURE NON-HEADLESS, under its own Xvfb. See the file header — do not wrap this script.
  await run("xvfb-run", [
    "-a",
    godotBin,
    "--path",
    PROJECT_ROOT,
    "--script",
    "res://scripts/outline_ref.gd",
    "--",
    "--manifest",
    manifestPath,
  ]);

  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
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
  };

  // THE VERSION GATE. 4.6 is on this box's PATH and renders text differently enough that a golden
  // built with it would be a golden of a different engine wearing this project's name.
  if (report.godotMajor !== 4 || report.godotMinor !== 5) {
    throw new Error(
      `this golden is for Godot 4.5 and the capture ran ${report.godot} — pass \`--godot "$(mise which godot)"\` or run it through \`mise exec --\``,
    );
  }
  if (report.oversampling !== 1 || report.oversamplingOverride !== 1) {
    throw new Error(
      `oversampling came back ${report.oversampling} (override ${report.oversamplingOverride}) — font_size is then a design size and every ppem in the golden is wrong`,
    );
  }

  const sharp = await loadSharp();
  const png = await readFile(screenshot);
  const decoded = await sharp(screenshot)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (width !== viewportWidth || height !== viewportHeight) {
    throw new Error(
      `the capture is ${width}x${height} and the manifest asked for ${viewportWidth}x${viewportHeight}`,
    );
  }

  // THE CALIBRATION PATCH, BEFORE ANY METRIC IS COMPUTED. See CALIBRATION_ALPHAS.
  const calibration = CALIBRATION_ALPHAS.map((alpha, i) => {
    const x = i * (CALIBRATION_WIDTH + 16) + CALIBRATION_WIDTH / 2;
    const y = CALIBRATION_TOP + CALIBRATION_HEIGHT / 2;
    const at = (y * width + x) * channels;
    return {
      alpha,
      expected: Math.round(255 * alpha),
      measured: decoded.data[at + 1],
    };
  });
  for (const entry of calibration) {
    if (Math.abs(entry.measured - entry.expected) > CALIBRATION_TOLERANCE) {
      throw new Error(
        `the calibration patch at alpha ${entry.alpha} decoded to ${entry.measured}, not ${entry.expected} — this frame is not blending in plain sRGB bytes, so no coverage number from it means what it says`,
      );
    }
  }
  console.log(
    `calibration: ${calibration.map((c) => `${c.alpha} -> ${c.measured} (want ${c.expected})`).join(", ")}`,
  );

  const cases: CaseGolden[] = [];
  const planes = new Map<string, CoverageImage>();
  for (const cell of cells) {
    const image = cropCoverage(decoded.data, width, channels, cell);
    planes.set(cell.name, image);
    const face = faces.find((f) => f.key === cell.fontKey);
    const metrics = measureOutline(image, { radial: cell.radial });
    const r50 = metrics.radial?.r50Mean ?? null;
    cases.push({
      inkVsDiskOfR50: r50 === null ? null : metrics.ink / (Math.PI * r50 * r50),
      name: cell.name,
      case: cell.case,
      graded: cell.graded,
      hinting: face?.hinting ?? HINTING_NONE,
      text: cell.text,
      pixelsPerEm: cell.pixelsPerEm,
      outlineSize: cell.outlineSize,
      spreadPx: cell.spreadPx,
      originX: cell.originX,
      originY: cell.originY,
      cellX: cell.cellX,
      cellY: cell.cellY,
      cellSize: cell.cellSize,
      metrics,
    });
    const radial = metrics.radial;
    const solid = cases[cases.length - 1].inkVsDiskOfR50;
    console.log(
      `${cell.name.padEnd(20)} ppem ${String(cell.pixelsPerEm).padStart(3)} r ${String(cell.spreadPx).padStart(5)} | ramp ${(radial?.rampWidthPx ?? metrics.gradientRampWidthPx)?.toFixed(3)} (gradient ${metrics.gradientRampWidthPx?.toFixed(3)})${radial ? `, r50 ${radial.r50Mean?.toFixed(3)} +- ${radial.r50Stdev?.toFixed(4)}, h${radial.harmonic} ${radial.harmonicAmplitudePx?.toFixed(4)}, ink/disk ${solid?.toFixed(3)}` : ""}, ink ${metrics.ink.toFixed(1)}, peak ${metrics.peak.toFixed(3)}`,
    );
  }

  // THE REALISM COLUMN'S VERDICT, MEASURED. See REALISM_CASE: the point of capturing hinting NORMAL
  // beside hinting NONE is to find out whether the graded numbers need a hinting caveat, and the
  // only honest way to answer that is to diff the two cells rather than to reason about them.
  const gradedPlane = planes.get(REALISM_CASE);
  const hintedPlane = planes.get(`${REALISM_CASE}-hinted`);
  let realismDiffering = 0;
  let realismWorst = 0;
  if (gradedPlane && hintedPlane) {
    for (let i = 0; i < gradedPlane.data.length; i += 1) {
      const error = Math.abs(gradedPlane.data[i] - hintedPlane.data[i]);
      if (error > 0) realismDiffering += 1;
      realismWorst = Math.max(realismWorst, error);
    }
  }
  console.log(
    `realism column: hinting NORMAL differs from NONE on ${realismDiffering} px (worst ${realismWorst})`,
  );

  const golden = {
    schema: SCHEMA,
    // PROVENANCE, and it is the reason a golden of numbers is safe to commit at all: everything a
    // reader needs to decide whether these numbers describe their checkout.
    godot: report.godot,
    renderer: report.renderer,
    adapter: report.adapter,
    oversampling: report.oversampling,
    snap2dTransforms: report.snap2dTransforms,
    snap2dVertices: report.snap2dVertices,
    fontRelativePath: font.relativePath,
    fontSha256,
    fontBytes: fontBytes.length,
    pngSha256: { "outline-ref.png": sha256(png) },
    viewport: { width: viewportWidth, height: viewportHeight },
    calibration,
    // As Godot READ THEM BACK, not as they were requested — see `outline_ref.gd`.
    faces: report.faces,
    /**
     * Does hinting change anything on this face? Measured, and the answer is NO.
     *
     * `differingPixels` 0 is not a bug in the fixture — the readback in `faces` shows Godot holding
     * `hinting` 0 and 2 on two separate `FontFile`s. It is a property of the shared fixture font:
     * `NotoSansSC-bench.ttf` is an `hb-subset` output and carries `prep` but neither `fpgm` nor
     * `cvt `, so there is no font program for FreeType's bytecode interpreter to run and
     * `force_autohinter` is false. TrueType hinting cannot act, so hinting NONE and hinting NORMAL
     * rasterise identically.
     *
     * WHICH SETTLES THE QUESTION THE COLUMN WAS ADDED TO ASK. "Our outline is softer than Godot's"
     * and "our outline is softer than the Godot the user is looking at" are the same sentence for
     * this face, and the graded cases need no hinting caveat.
     */
    realism: {
      case: REALISM_CASE,
      hintedAgainst: HINTING_NORMAL,
      gradedAt: HINTING_NONE,
      differingPixels: realismDiffering,
      worstDelta: realismWorst,
    },
    cases,
  };

  if (check) {
    const previous = JSON.parse(await readFile(GOLDEN_PATH, "utf8"));
    const drift: string[] = [];
    for (const item of cases) {
      const before = (previous.cases as CaseGolden[]).find(
        (c) => c.name === item.name,
      );
      if (!before) {
        drift.push(`${item.name}: absent from the committed golden`);
        continue;
      }
      const compare = (
        label: string,
        a: number | null | undefined,
        b: number | null | undefined,
      ): void => {
        if (a == null || b == null) {
          if (a !== b) drift.push(`${item.name} ${label}: ${b} -> ${a}`);
          return;
        }
        if (Math.abs(a - b) > 1e-6) {
          drift.push(
            `${item.name} ${label}: ${b.toFixed(4)} -> ${a.toFixed(4)} (${(a - b).toFixed(4)})`,
          );
        }
      };
      compare(
        "gradientRampWidthPx",
        item.metrics.gradientRampWidthPx,
        before.metrics.gradientRampWidthPx,
      );
      compare("ink", item.metrics.ink, before.metrics.ink);
      compare(
        "rampWidthPx",
        item.metrics.radial?.rampWidthPx,
        before.metrics.radial?.rampWidthPx,
      );
      compare(
        "r50Mean",
        item.metrics.radial?.r50Mean,
        before.metrics.radial?.r50Mean,
      );
      compare(
        "r50Stdev",
        item.metrics.radial?.r50Stdev,
        before.metrics.radial?.r50Stdev,
      );
    }
    if (previous.fontSha256 !== fontSha256) {
      drift.push(`fontSha256: ${previous.fontSha256} -> ${fontSha256}`);
    }
    if (previous.godot !== report.godot) {
      drift.push(`godot: ${previous.godot} -> ${report.godot}`);
    }
    console.log(
      drift.length === 0
        ? "\n--check: the re-render reproduces the committed golden exactly."
        : `\n--check: ${drift.length} differences from the committed golden:\n  ${drift.join("\n  ")}`,
    );
    process.exitCode = drift.length === 0 ? 0 : 1;
    return;
  }

  await mkdir(dirname(GOLDEN_PATH), { recursive: true });
  await writeFile(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${GOLDEN_PATH}`);
  console.log(`artifacts (gitignored): ${outDir}`);
}

await main();
