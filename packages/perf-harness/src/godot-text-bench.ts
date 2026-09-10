// Drive `godot/project/scripts/bench_text.gd` and print what Godot costs to draw the S9 workload.
//
//   xvfb-run -a mise exec -- pnpm -w run godot:text-bench
//   xvfb-run -a mise exec -- pnpm -w run godot:text-bench -- --variant msdf
//   xvfb-run -a mise exec -- pnpm -w run godot:text-bench -- --all-variants
//
// `--conditions=development` is REQUIRED (the npm script supplies it): this module reaches the
// scenario's pure layout helpers, which live beside browser code that imports
// `@godot-scene-web/html`, and without the condition that resolves to a stale `dist/`.
//
// A REFERENCE, NOT A PERF-REPORT. Like the bake probe, this deliberately does NOT emit a
// `perf-report/1` envelope: it takes no Chrome trace, runs no presence guard and measures a
// different process on a different renderer, so dressing its numbers up as one would put them next
// to browser numbers that were produced under a completely different methodology. What it is for:
//
//   * an EXACT VRAM number. `RENDER_VIDEO_MEM_USED` / `RENDER_TEXTURE_MEM_USED` are attributed by
//     the engine itself, where the browser side has only a driver total or a self-reported count.
//   * a draw-call count, which no browser API exposes.
//   * the reference PNGs the `text-fidelity` probe compares crispness against.
//
// THE WORKLOAD IS NOT RE-DERIVED. Cell boxes, run strings and the per-frame translation offsets are
// generated HERE, by the same exported pure functions the browser scenario uses, and handed to
// GDScript in the manifest. A second implementation of the triangle wave and the glyph-pool stride
// would be free to drift, and a Godot arm drawing subtly different text would read as a rendering
// difference rather than the bug it is.
//
// NEEDS A REAL DISPLAY. `--headless` renders nothing, so every monitor would price drawing no text.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCjkFont } from "../../../scripts/ensure-cjk-font";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import {
  resolveParams,
  type StageLayout,
  type TextRunKind,
  textPlacedRuns,
  textRender,
  textStageSize,
  translationAt,
} from "./scenarios";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROJECT_ROOT = join(REPO_ROOT, "godot", "project");

export const GODOT_TEXT_VARIANTS = ["default", "msdf", "oversample"] as const;
export type GodotTextVariant = (typeof GODOT_TEXT_VARIANTS)[number];

export interface GodotTextBenchOptions {
  variant: GodotTextVariant;
  viewport: { width: number; height: number };
  params: Record<string, string | number | boolean>;
  warmupFrames: number;
  frames: number;
  outDir: string;
  godotBin: string;
}

/** `res://` path per face, as `ensureCjkFont` / `ensureLatinBenchFont` put them on disk. */
export type GodotFontPaths = Partial<Record<TextRunKind, string>>;

/**
 * The manifest GDScript consumes. Every field it needs to draw the scenario, and nothing it has to
 * compute — see the header.
 */
export function buildManifest(
  options: GodotTextBenchOptions,
  fonts: GodotFontPaths,
): Record<string, unknown> {
  const layout: StageLayout = { viewport: options.viewport, fit: false };
  const params = resolveParams(textRender, options.params);
  const stage = textStageSize(params, layout);
  const placed = textPlacedRuns(params, layout);
  const fontSize = Number(params.fontSize);
  const radians = (Number(params.rotationDeg) * Math.PI) / 180;

  const runs = placed.map((run) => ({
    // The Label box is the RUN box centred on its placed centre, exactly as `textSceneText` places
    // it, so the Godot and DOM arms put the same glyphs at the same coordinates.
    left: run.centreX - run.width / 2,
    top: run.centreY - run.height / 2,
    width: run.width,
    height: run.height,
    text: run.text,
    // Per run, because `script=both` stacks two faces in one cell. GDScript builds one `FontFile`
    // per distinct path and applies the variant's settings to each.
    fontPath: fonts[run.kind] ?? "",
  }));

  // Keyed on the CELL, so the two runs of a cell travel together — the same rule the browser arms
  // apply. Indexing by run would give the Latin run a different phase from the Han run above it.
  const offsets = Array.from({ length: options.frames }, (_, frame) =>
    placed.map((run) => translationAt(run.cellIndex, frame, fontSize, radians)),
  );

  return {
    viewportWidth: stage.width,
    viewportHeight: stage.height,
    // The DEFAULT face, for a run entry that names none. Kept so an older manifest still loads.
    fontPath: fonts.han ?? fonts.latin ?? "",
    fontSize,
    rotationDeg: Number(params.rotationDeg),
    variant: options.variant,
    warmupFrames: options.warmupFrames,
    frames: options.frames,
    // The LAST measured frame, so the still shows steady state rather than a warm cache mid-fill.
    screenshotFrame: options.frames - 1,
    runs,
    offsets,
  };
}

/**
 * Both fixture fonts, as `res://` paths.
 *
 * Both, unconditionally, even for `script=han`: Godot loads a `FontFile` only for the paths the
 * runs actually name, so an unused entry costs nothing, while a missing one would make the run fall
 * back to the default face and silently render the Latin pangram in Noto Sans SC.
 */
async function godotFontPaths(): Promise<GodotFontPaths> {
  const [han, latin] = await Promise.all([
    ensureCjkFont(REPO_ROOT),
    ensureLatinBenchFont(REPO_ROOT),
  ]);
  for (const font of [han, latin]) {
    if (!font.subset) {
      console.warn(
        `warning: using the FULL upstream font (${(font.bytes / 1e6).toFixed(1)} MB) at ${font.relativePath} — ${font.subsetSkippedReason}`,
      );
    }
  }
  return {
    han: `res://${han.relativePath}`,
    latin: `res://${latin.relativePath}`,
  };
}

export async function runGodotTextBench(
  options: GodotTextBenchOptions,
): Promise<Record<string, unknown>> {
  const fonts = await godotFontPaths();
  await mkdir(options.outDir, { recursive: true });

  const manifestPath = join(options.outDir, `manifest-${options.variant}.json`);
  const outputPath = join(options.outDir, `${options.variant}.json`);
  const screenshotPath = join(options.outDir, `${options.variant}.png`);
  const manifest = {
    ...buildManifest(options, fonts),
    output: outputPath,
    screenshot: screenshotPath,
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  // The import pass the parity flow also runs before any non-headless batch: without it Godot may
  // rebuild `.godot/` mid-run, inside the measured window.
  await run(options.godotBin, [
    "--headless",
    "--path",
    PROJECT_ROOT,
    "--import",
  ]);
  await run(options.godotBin, [
    "--path",
    PROJECT_ROOT,
    "--script",
    "res://scripts/bench_text.gd",
    "--",
    "--manifest",
    manifestPath,
  ]);

  return JSON.parse(await readFile(outputPath, "utf8")) as Record<
    string,
    unknown
  >;
}

export interface GodotStillsRequest {
  variant: GodotTextVariant;
  viewport: { width: number; height: number };
  /**
   * One entry per RUN, in the same stacking order the browser arms draw them.
   *
   * `kind` picks the face. It is not optional in practice: the whole point of the Godot arms is
   * that they draw the identical glyphs at the identical coordinates as the browser arms, and a
   * Latin pangram set in Noto Sans SC would be neither.
   */
  runs: {
    left: number;
    top: number;
    width: number;
    height: number;
    text: string;
    kind?: TextRunKind;
  }[];
  /** offsets[frame][run] — the SAME sub-pixel translations the browser arms are given. */
  offsets: { x: number; y: number }[][];
  fontSize: number;
  rotationDeg: number;
  /**
   * Px from a run box's top edge to the alphabetic baseline, so Godot anchors its glyphs exactly
   * where the browser arms anchor theirs.
   *
   * Without it Godot's `Label` uses VERTICAL_ALIGNMENT_TOP and its own ascent, which is a third
   * convention on top of the canvas and CSS ones — three engines putting the same run in three
   * places, and every per-pixel column then scoring the translation.
   */
  baseline?: number;
  outDir: string;
  stem: string;
  godotBin: string;
  msdfSize?: number;
}

/**
 * Render one run at N sub-pixel offsets and return the still paths, in offset order.
 *
 * The whole point is that Godot draws the IDENTICAL glyphs at the IDENTICAL coordinates as the
 * browser arms. An earlier version of the fidelity probe scored Godot from a hardcoded crop of the
 * full-workload screenshot, which meant a different text run at a guessed position — the numbers
 * looked plausible and compared nothing.
 */
export async function renderGodotStills(
  request: GodotStillsRequest,
): Promise<string[]> {
  const fonts = await godotFontPaths();
  await mkdir(request.outDir, { recursive: true });
  const frames = request.offsets.length;
  const manifestPath = join(request.outDir, `${request.stem}-manifest.json`);
  const manifest = {
    viewportWidth: request.viewport.width,
    viewportHeight: request.viewport.height,
    fontPath: fonts.han ?? "",
    fontSize: request.fontSize,
    rotationDeg: request.rotationDeg,
    // -1 means "keep Label's own placement"; the GDScript side treats any negative as unset.
    baseline: request.baseline ?? -1,
    variant: request.variant,
    msdfSize: request.msdfSize ?? 128,
    // Warm the atlas before the stills, so a still never catches a half-filled cache.
    warmupFrames: 20,
    frames,
    screenshotFrame: -1,
    screenshotStem: join(request.outDir, request.stem),
    screenshotFrames: Array.from({ length: frames }, (_, i) => i),
    output: join(request.outDir, `${request.stem}.json`),
    runs: request.runs.map((run) => ({
      ...run,
      fontPath: fonts[run.kind ?? "han"] ?? "",
    })),
    offsets: request.offsets,
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await run(request.godotBin, [
    "--headless",
    "--path",
    PROJECT_ROOT,
    "--import",
  ]);
  await run(request.godotBin, [
    "--path",
    PROJECT_ROOT,
    "--script",
    "res://scripts/bench_text.gd",
    "--",
    "--manifest",
    manifestPath,
  ]);
  return Array.from({ length: frames }, (_, i) =>
    join(request.outDir, `${request.stem}-${i}.png`),
  );
}

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

/** The shape `formatGodotTable` reads out of a `godot-text-bench/1` report. */
interface GodotTextReport {
  variant: string;
  msdf: boolean;
  msdfSize: number;
  msdfPixelRange: number;
  oversampling: number;
  subpixelPositioning: number;
  adapter: string;
  metrics: {
    frameMs: { p50: number; p95: number; max: number };
    drawCalls: { p50: number };
    textTextureMemBytes: number;
    textBufferMemBytes: number;
    poolVideoMemBytes: { p50: number };
    baselineTextureMemBytes: number;
  };
}

/** One row per variant, with the two facts only Godot can supply spelled out. */
export function formatGodotTable(reports: Record<string, unknown>[]): string {
  const typed = reports as unknown as GodotTextReport[];
  const rows: [string, (r: GodotTextReport) => string][] = [
    [
      "frame ms p50/p95/max",
      (r) =>
        `${num(r.metrics.frameMs.p50)}/${num(r.metrics.frameMs.p95)}/${num(r.metrics.frameMs.max)}`,
    ],
    ["draw calls p50", (r) => num(r.metrics.drawCalls.p50, 0)],
    // The one attributable VRAM number: a per-resource texture sum minus the identical empty scene.
    [
      "TEXT texture MB (exact)",
      (r) => num(r.metrics.textTextureMemBytes / 1e6),
    ],
    ["  text buffer MB", (r) => num(r.metrics.textBufferMemBytes / 1e6)],
    [
      "  (VMA pool total MB)",
      (r) => num(r.metrics.poolVideoMemBytes.p50 / 1e6),
    ],
    [
      "  (empty-scene baseline MB)",
      (r) => num(r.metrics.baselineTextureMemBytes / 1e6),
    ],
    ["msdf", (r) => String(r.msdf)],
    ["  msdf size / range", (r) => `${r.msdfSize} / ${r.msdfPixelRange}`],
    ["oversampling", (r) => num(r.oversampling)],
    ["subpixel positioning", (r) => String(r.subpixelPositioning)],
    ["adapter", (r) => String(r.adapter)],
  ];
  const width = 26;
  const columns = typed.map((r) => String(r.variant).padStart(15));
  const lines = [
    `${"metric".padEnd(width)}${columns.join("")}`,
    "-".repeat(width + columns.length * 15),
  ];
  for (const [label, value] of rows) {
    lines.push(
      `${label.padEnd(width)}${typed.map((r) => value(r).padStart(15)).join("")}`,
    );
  }
  lines.push(
    "",
    "NOT COMPARABLE WITH THE BROWSER TABLE: different process, renderer and environment.",
    "`TEXT texture MB` is the one exact, engine-attributed VRAM number in this round: a",
    "per-resource sum minus an identical empty scene. The VMA pool total moves in ~34 MiB blocks",
    "and is printed only so nobody reads it off `RENDER_VIDEO_MEM_USED` and calls it a cost.",
    "",
    "UNDER Xvfb THE FRAME TIME IS PRESENT-BOUND, not text-bound: there is no GPU compositor, so",
    "the ~28 ms floor is the software blit of a 1280x800 surface and is the same on every arm.",
    "Read draw calls and texture memory here; read frame cost from the browser table or a phone.",
  );
  return lines.join("\n");
}

function num(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const variants: GodotTextVariant[] = argv.includes("--all-variants")
    ? [...GODOT_TEXT_VARIANTS]
    : [(flag("variant") ?? "default") as GodotTextVariant];
  for (const variant of variants) {
    if (!GODOT_TEXT_VARIANTS.includes(variant)) {
      throw new Error(
        `unknown variant "${variant}" (have: ${GODOT_TEXT_VARIANTS.join(", ")})`,
      );
    }
  }
  const [width, height] = (flag("viewport") ?? "1280x800")
    .split("x")
    .map(Number);
  const outDir = resolve(
    flag("out") ?? join(REPO_ROOT, "artifacts/perf/godot-text"),
  );

  const reports: Record<string, unknown>[] = [];
  for (const variant of variants) {
    console.log(`\n=== godot text bench: ${variant} ===`);
    reports.push(
      await runGodotTextBench({
        variant,
        viewport: { width, height },
        params: {},
        warmupFrames: Number(flag("warmup") ?? 30),
        frames: Number(flag("frames") ?? 300),
        outDir,
        godotBin: flag("godot") ?? "godot",
      }),
    );
  }
  console.log(`\n${formatGodotTable(reports)}`);
  console.log(`\nartifacts: ${outDir}`);
}

// Run only when invoked directly; `buildManifest` and `formatGodotTable` are imported by tests.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
