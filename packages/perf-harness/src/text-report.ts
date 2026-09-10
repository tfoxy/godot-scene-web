// `text:report` — the text-rendering round, assembled into something you can look at.
//
//   mise exec -- pnpm -w run text:report
//   xdg-open artifacts/perf/text-report/index.html
//
// A PURE READER. It launches no browser, drives no Godot and measures nothing: it reads whatever
// the fidelity probe, the Godot bench and the perf runner have already left in `artifacts/perf/`,
// copies the stills next to an `index.html`, and renders the numbers that go with them. Running it
// twice cannot change a result. That separation is the point — a viewer that could also measure
// would be a viewer that could disagree with the tables, and then neither could be trusted.
//
// WHAT IT REFUSES TO DO:
//
//   * invent a zero. A missing input is reported as missing, with the command that produces it.
//     `rmsVsReference` is genuinely null for the Godot arms — a different rasterizer scored against
//     a Skia reference ranks hinting policy, not crispness — so it renders as an em dash and never
//     as 0.00, which would read as a perfect match.
//   * put two environments in one table. Fidelity stills, browser frame cost and Godot VRAM come
//     from three different machines-or-processes, so they are three groups, each with its own
//     column set and its own environment line. The harness refuses cross-environment comparison
//     everywhere else and a viewer is not the place to quietly undo it.
//   * crown the reference. It wins every fidelity row by construction — it IS the definition — so
//     it is excluded from the best-in-row highlight rather than shown beating the arms.
//
// The layout is `index.html` + `data.json` + every PNG as a sibling: one directory you can move,
// zip or serve, that keeps working after `artifacts/perf/runs/` is cleaned.

import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderPage } from "./text-report-page";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");

const GODOT_VARIANTS = ["default", "msdf", "oversample"] as const;

/* ---------------------------------------------------------------------------------------------
 * The shapes on disk. Deliberately loose: every field is optional, because this reader must keep
 * working against artifacts produced by an older build of the probe rather than crash and leave
 * the user with nothing.
 * ------------------------------------------------------------------------------------------- */

export interface FidelityRowDocument {
  arm: string;
  /**
   * Which run's rows this describes — `han` or `latin`.
   *
   * Optional because this reader has to keep working against artifacts written before the round
   * grew a second script; those become one unnamed band, which renders as one group exactly as it
   * always did.
   */
  band?: string;
  acutance?: number;
  shimmer?: number;
  edgeShimmer?: number;
  meanInk?: number;
  /** `null` in JSON wherever the probe wrote NaN — see the header. */
  rmsVsReference?: number | null;
  samples?: number;
  stills?: string[];
  inkSamples?: number[];
  centroidSamples?: number[];
  centroidYSamples?: number[];
  /** The per-arm threshold the run itself used; see the probe's `alignmentAllowanceFor`. */
  alignmentAllowancePx?: number;
  /** Mean px this arm must be moved to land on the reference. The licence for the per-pixel rows. */
  alignmentPx?: number;
  subpixelTravel?: number;
  subpixelResidualPx?: number;
}

export interface FidelityDocument {
  dpr?: number;
  headed?: boolean;
  box?: { width: number; height: number };
  offsets?: number[];
  /**
   * The threshold the probe warned against, carried in the data.
   *
   * Read from the document rather than hardcoded here so this reader stays pure: the line it draws
   * is the one the run that produced these numbers drew, not the one this file was built with.
   */
  alignmentTolerancePx?: number;
  /** Row range per band, in box px — what each group's stills should be looked at through. */
  bands?: { kind?: string; y0?: number; y1?: number }[];
  spec?: {
    runs?: { kind?: string; text?: string; fontFamily?: string }[];
    fontSize?: number;
    rotationDeg?: number;
  };
  results?: FidelityRowDocument[];
}

export interface GodotDocument {
  variant?: string;
  adapter?: string;
  godot?: string;
  renderer?: string;
  msdf?: boolean;
  msdfSize?: number;
  msdfPixelRange?: number;
  oversampling?: number;
  subpixelPositioning?: number;
  runs?: number;
  frames?: number;
  metrics?: {
    textTextureMemBytes?: number;
    textBufferMemBytes?: number;
    baselineTextureMemBytes?: number;
    poolVideoMemBytes?: { p50?: number };
    drawCalls?: { p50?: number; max?: number };
    frameMs?: { p50?: number; p95?: number; max?: number };
    objectCount?: number;
  };
}

export interface RunDocument {
  scenario?: string;
  params?: { mechanism?: string } & Record<string, unknown>;
  env?: {
    label?: string;
    kind?: string;
    device?: { model?: string } | null;
    geometry?: {
      viewport?: { width: number; height: number };
      fitScale?: number;
    };
  };
  metrics?: {
    frameCostMs?: { p50?: number; p95?: number; max?: number };
    contentUpdateHz?: number;
    rasterMs?: number;
    mainThreadBusyMs?: number;
    layerCount?: number;
    windowMs?: number;
    cpu?: { totalCpuMs?: number };
    gpu?: { hardware?: string; hardwareDetail?: string };
    presented?: { sampleHits?: number; sampleCount?: number };
    scenario?: Record<string, number>;
  };
}

/* ---------------------------------------------------------------------------------------------
 * What the page consumes.
 * ------------------------------------------------------------------------------------------- */

export interface TextReportArm {
  arm: string;
  label: string;
  kind: "reference" | "browser" | "godot";
  blurb: string;
  /** Report-relative still per offset index; `null` where that still does not exist. */
  stills: (string | null)[];
  /** Report-relative |arm - reference| per offset index. */
  diffs: (string | null)[];
  headline: { label: string; value: string }[];
  /**
   * Why this arm's per-pixel views cannot be read as rasterization, or `null` when they can.
   *
   * Carried on the ARM rather than only in the fidelity table because the diff view shows one arm
   * at a time with no table in sight, and a diff that is mostly a translation looks exactly like a
   * diff that is mostly a rasterizer difference. That is precisely how a 2.35 px offset survived a
   * whole round of measurement.
   */
  alignmentWarning: string | null;
}

export interface TextReportRow {
  label: string;
  hint?: string;
  /** Which direction is better, when the metric has one at all. `acutance` does not. */
  better?: "lower" | "higher";
  cells: Record<string, string>;
  best: string[];
}

export interface TextReportGroup {
  id: string;
  title: string;
  /** Never blank: every number on this page names the environment it was taken on. */
  environment: string;
  /** Column order for this group only — groups do NOT share a column set. */
  arms: string[];
  notes: string[];
  rows: TextReportRow[];
}

export interface TextReportData {
  spec: string;
  box: { width: number; height: number };
  offsets: number[];
  arms: TextReportArm[];
  groups: TextReportGroup[];
  missing: { what: string; command: string }[];
  sources: string[];
}

export interface ReportInputs {
  fidelity: FidelityDocument | null;
  godot: GodotDocument[];
  runs: RunDocument[];
  /** Report-relative still names by arm, indexed by offset. Filled in by the copier. */
  stills: Record<string, (string | null)[]>;
  diffs: Record<string, (string | null)[]>;
  sources: string[];
}

/* ---------------------------------------------------------------------------------------------
 * Formatting. One rule: a value that was not measured renders as an em dash, never as a number.
 * ------------------------------------------------------------------------------------------- */

const DASH = "—";

function fixed(value: unknown, digits: number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : DASH;
}

function megabytes(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value / 1024 / 1024).toFixed(2)} MB`
    : DASH;
}

function integer(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value))
    : DASH;
}

function yesNo(value: unknown): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : DASH;
}

function numeric(cell: string): number | null {
  const parsed = Number.parseFloat(cell);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Distortion is DERIVED, not stored: |1 - acutance/reference|.
 *
 * It is the column to read, and the reason it exists is that acutance is not "higher is better".
 * Below the reference is blur; above it is harder-than-correct edges, i.e. aliasing. Only the
 * distance from the reference says how wrong an arm is, and in which direction you have to look at
 * the pixels to find out.
 */
export function distortionOf(
  row: FidelityRowDocument,
  reference: FidelityRowDocument | undefined,
): number | null {
  if (
    typeof row.acutance !== "number" ||
    typeof reference?.acutance !== "number" ||
    reference.acutance === 0
  ) {
    return null;
  }
  return Math.abs(1 - row.acutance / reference.acutance);
}

/**
 * Fallback tolerance for artifacts written before the probe published its own.
 *
 * Not a second opinion: `alignmentTolerancePx` in the document always wins.
 */
const DEFAULT_ALIGNMENT_TOLERANCE_PX = 0.25;

/**
 * The one-sentence reason an arm's per-pixel views are unreadable, or `null`.
 *
 * Deliberately explains rather than hides. The offending number stays on screen — a blanked-out
 * `rmsVsReference` would just look like another unmeasured cell, and unmeasured is the one thing
 * this reader is careful never to conflate with anything else.
 */
export function alignmentWarningFor(
  row: FidelityRowDocument | undefined,
  tolerance: number,
): string | null {
  const alignment = row?.alignmentPx;
  if (typeof alignment !== "number" || !Number.isFinite(alignment)) {
    return null;
  }
  // The arm's OWN allowance when the run published one: it includes a measured correction for that
  // arm's blur, and applying a flat threshold instead would flag soft-but-aligned arms.
  const allowed =
    typeof row?.alignmentAllowancePx === "number" &&
    Number.isFinite(row.alignmentAllowancePx)
      ? row.alignmentAllowancePx
      : tolerance;
  if (alignment <= allowed) {
    return null;
  }
  return `draws ${alignment.toFixed(2)} px away from the reference (allowed ${allowed.toFixed(2)} px), so its rmsVsReference and its diff images are mostly a picture of that offset, not of its rasterizer. distortion, the shimmers and travel are translation-invariant and stay readable.`;
}

function makeRow(
  label: string,
  arms: readonly string[],
  cell: (arm: string) => string,
  options: {
    hint?: string;
    better?: "lower" | "higher";
    /** Arms that define the metric rather than compete on it. */
    excludeFromBest?: readonly string[];
  } = {},
): TextReportRow {
  const cells: Record<string, string> = {};
  for (const arm of arms) {
    cells[arm] = cell(arm);
  }
  const best: string[] = [];
  if (options.better) {
    const candidates = arms
      .filter((arm) => !options.excludeFromBest?.includes(arm))
      .map((arm) => ({ arm, value: numeric(cells[arm]) }))
      .filter(
        (entry): entry is { arm: string; value: number } =>
          entry.value !== null,
      );
    if (candidates.length > 1) {
      const target =
        options.better === "lower"
          ? Math.min(...candidates.map((c) => c.value))
          : Math.max(...candidates.map((c) => c.value));
      for (const candidate of candidates) {
        if (candidate.value === target) {
          best.push(candidate.arm);
        }
      }
    }
  }
  return {
    label,
    hint: options.hint,
    better: options.better,
    cells,
    best,
  };
}

/* ---------------------------------------------------------------------------------------------
 * The build. Pure: JSON in, page model out.
 * ------------------------------------------------------------------------------------------- */

const BLURBS: Record<string, string> = {
  reference:
    "The same geometry drawn at 8x and box-downsampled here in node: correct area coverage for this exact run. A ceiling to read the arms against, not a mechanism anyone could ship.",
  dom: "A rotated CSS box per run, laid out by the html package — what gsw renders today.",
  canvas2d:
    "One fillText per run on a 2D canvas, rotated by the context transform.",
  "godot-default":
    "Godot 4.5.1 as configured out of the box: FreeType into a shelf-packed grayscale atlas.",
  "godot-msdf":
    "Godot with multichannel signed distance fields at its own default msdf_size, resolution-independent by construction.",
  "godot-oversample":
    "Godot rasterising the atlas above 1:1 via the viewport oversampling override, then minifying.",
};

function armKind(arm: string): TextReportArm["kind"] {
  if (arm === "reference") {
    return "reference";
  }
  return arm.startsWith("godot-") ? "godot" : "browser";
}

export function buildReportData(inputs: ReportInputs): TextReportData {
  const fidelity = inputs.fidelity;
  const rows = fidelity?.results ?? [];
  const offsets = fidelity?.offsets ?? defaultOffsets(rows);
  const box = fidelity?.box ?? { width: 185, height: 81 };
  const tolerance =
    fidelity?.alignmentTolerancePx ?? DEFAULT_ALIGNMENT_TOLERANCE_PX;
  // One band per script, in the order the probe stacked them. An artifact from before the round
  // grew a second script has no `band` at all, which collapses to a single unnamed group.
  const bands = [...new Set(rows.map((row) => row.band ?? ""))];

  const byGodotArm = new Map<string, GodotDocument>();
  for (const document of inputs.godot) {
    if (document.variant) {
      byGodotArm.set(`godot-${document.variant}`, document);
    }
  }
  const byRunArm = new Map<string, RunDocument>();
  for (const document of inputs.runs) {
    const mechanism = document.params?.mechanism;
    if (typeof mechanism === "string") {
      byRunArm.set(mechanism, document);
    }
  }

  // Union, in a stable order: whatever the fidelity sweep measured, then any arm that only has
  // perf numbers, then any Godot variant that only has VRAM numbers. A future arm shows up here
  // the moment ANY of its three inputs exists.
  const armNames = [
    ...rows.map((row) => row.arm),
    ...[...byRunArm.keys()],
    ...[...byGodotArm.keys()],
  ].filter((arm, index, all) => all.indexOf(arm) === index);

  // One entry per ARM, not per row: `results` now has a row per arm PER BAND, and an arm is still
  // one column, one still and one blurb.
  const fidelityArms = rows
    .map((row) => row.arm)
    .filter((arm, index, all) => all.indexOf(arm) === index);
  const runArms = armNames.filter((arm) => byRunArm.has(arm));
  const godotArms = armNames.filter((arm) => byGodotArm.has(arm));

  // The headline band: the first one measured, which is the top run in the picture. Keeping the
  // headline on one band is what stops the card from growing a column per script and turning the
  // grid view into a table.
  const headlineBand = bands[0] ?? "";
  const headlineRows = rows.filter((row) => (row.band ?? "") === headlineBand);
  const headlineReference = headlineRows.find((row) => row.arm === "reference");

  const arms: TextReportArm[] = armNames.map((arm) => {
    const row = headlineRows.find((entry) => entry.arm === arm);
    return {
      arm,
      label: arm,
      kind: armKind(arm),
      blurb: BLURBS[arm] ?? "",
      stills: padOffsets(inputs.stills[arm], offsets.length),
      diffs: padOffsets(inputs.diffs[arm], offsets.length),
      headline: headlineFor(
        arm,
        row,
        headlineReference,
        byRunArm.get(arm),
        byGodotArm.get(arm),
      ),
      // Across ALL bands: an arm can be aligned in one script and displaced in the other, and the
      // diff view shows the whole box, so a warning about either band applies to what is on screen.
      alignmentWarning: armAlignmentWarning(
        rows.filter((entry) => entry.arm === arm),
        bands.length > 1,
        tolerance,
      ),
    };
  });

  const groups: TextReportGroup[] = [];
  for (const band of bands) {
    const bandRows = rows.filter((row) => (row.band ?? "") === band);
    if (bandRows.length === 0) continue;
    groups.push(
      fidelityGroup(
        fidelityArms.filter((arm) => bandRows.some((row) => row.arm === arm)),
        band,
        bandRows,
        bandRows.find((row) => row.arm === "reference"),
        fidelity,
        tolerance,
      ),
    );
  }
  if (runArms.length > 0) {
    groups.push(browserGroup(runArms, byRunArm));
  }
  if (godotArms.length > 0) {
    groups.push(godotGroup(godotArms, byGodotArm));
  }

  return {
    spec: describeSpec(fidelity),
    box,
    offsets,
    arms,
    groups,
    missing: missingInputs(inputs),
    sources: inputs.sources,
  };
}

function defaultOffsets(rows: readonly FidelityRowDocument[]): number[] {
  const samples = Math.max(
    1,
    ...rows.map((row) => row.inkSamples?.length ?? row.samples ?? 1),
  );
  return Array.from({ length: samples }, (_, index) => index);
}

function padOffsets(
  values: (string | null)[] | undefined,
  length: number,
): (string | null)[] {
  return Array.from({ length }, (_, index) => values?.[index] ?? null);
}

function describeSpec(fidelity: FidelityDocument | null): string {
  const spec = fidelity?.spec;
  if (!spec) {
    return "one text run";
  }
  const runs = (spec.runs ?? [])
    .map(
      (run) =>
        `${run.text ? [...run.text].length : 0} ${run.kind ?? "?"} glyphs in ${run.fontFamily ?? "?"}`,
    )
    .join(" + ");
  return `${runs || "one text run"} at ${spec.fontSize ?? "?"} px, rotated ${spec.rotationDeg ?? 0}°`;
}

/** Which face a band's run is set in, for the group title. */
function bandFaceOf(
  fidelity: FidelityDocument | null,
  band: string,
): string | undefined {
  return (fidelity?.spec?.runs ?? []).find((run) => run.kind === band)
    ?.fontFamily;
}

/**
 * The arm-level warning, across every band it was measured in.
 *
 * Named per band when there is more than one, because "this arm is 0.5 px out" is a different fact
 * from "this arm is 0.5 px out IN LATIN" — and the second is the one that points at a cause.
 */
export function armAlignmentWarning(
  rows: readonly FidelityRowDocument[],
  nameBands: boolean,
  tolerance: number,
): string | null {
  const flagged = rows
    .map((row) => ({ row, warning: alignmentWarningFor(row, tolerance) }))
    .filter((entry) => entry.warning !== null);
  if (flagged.length === 0) {
    return null;
  }
  if (!nameBands || flagged.length === rows.length) {
    return flagged[0].warning;
  }
  return `in the ${flagged
    .map((entry) => entry.row.band ?? "?")
    .join(" and ")} band: ${flagged[0].warning}`;
}

function headlineFor(
  arm: string,
  row: FidelityRowDocument | undefined,
  reference: FidelityRowDocument | undefined,
  run: RunDocument | undefined,
  godot: GodotDocument | undefined,
): { label: string; value: string }[] {
  const headline: { label: string; value: string }[] = [];
  if (row) {
    headline.push({
      label: arm === "reference" ? "acutance" : "distortion",
      value:
        arm === "reference"
          ? fixed(row.acutance, 4)
          : fixed(distortionOf(row, reference), 3),
    });
    headline.push({ label: "edgeShimmer", value: fixed(row.edgeShimmer, 5) });
    headline.push({
      label: "resid px",
      value: fixed(row.subpixelResidualPx, 3),
    });
  }
  if (run) {
    headline.push({
      label: "raster",
      value: `${fixed(run.metrics?.rasterMs, 0)} ms`,
    });
    headline.push({
      label: "cpu",
      value: `${fixed(run.metrics?.cpu?.totalCpuMs, 0)} ms`,
    });
  }
  if (godot) {
    headline.push({
      label: "text texture",
      value: megabytes(godot.metrics?.textTextureMemBytes),
    });
    headline.push({
      label: "draw calls",
      value: integer(godot.metrics?.drawCalls?.p50),
    });
  }
  return headline;
}

function fidelityGroup(
  arms: string[],
  band: string,
  rows: readonly FidelityRowDocument[],
  reference: FidelityRowDocument | undefined,
  fidelity: FidelityDocument | null,
  tolerance: number,
): TextReportGroup {
  const at = (arm: string) => rows.find((row) => row.arm === arm);
  // The reference defines every one of these, so it cannot also win them.
  const excludeFromBest = ["reference"];
  const misaligned = arms.filter((arm) =>
    alignmentWarningFor(at(arm), tolerance),
  );
  const face = bandFaceOf(fidelity, band);
  const bandRows = (fidelity?.bands ?? []).find((entry) => entry.kind === band);
  return {
    id: band ? `fidelity-${band}` : "fidelity",
    // NAMED, because two groups with identical row labels and identical arm columns are otherwise
    // indistinguishable — and the numbers in them are not comparable.
    title: band
      ? `fidelity — ${band}${face ? `, ${face}` : ""} at ${fidelity?.spec?.fontSize ?? "?"} px${
          bandRows ? ` (rows ${bandRows.y0}–${bandRows.y1})` : ""
        }`
      : "fidelity — the same run, the same 8 sub-pixel offsets",
    environment: `browser stills at dpr ${fidelity?.dpr ?? 1} (${
      fidelity?.headed ? "headed" : "headless"
    }) + Godot stills, identical geometry`,
    arms,
    rows: [
      makeRow("acutance", arms, (arm) => fixed(at(arm)?.acutance, 4), {
        // GREEN, not a luma over all three channels. `dom` is the only arm Chrome draws with LCD
        // subpixel AA, and averaging its channels is a ~1 px horizontal blur charged to the
        // mechanism; green is bit-identical to luma on the other eight. The probe's `lumaOf` owns
        // the decision — this hint only has to stop the viewer from describing it wrongly, which it
        // did for one round after the probe changed.
        hint: "mean |∇green| per unit ink — NOT higher-is-better",
      }),
      makeRow(
        "distortion",
        arms,
        (arm) => fixed(distortionOf(at(arm) ?? { arm }, reference), 3),
        {
          hint: "|1 − acutance/ref|; below ref is blur, above is aliasing",
          better: "lower",
          excludeFromBest,
        },
      ),
      // Deliberately NOT scored. Low edgeShimmer has at least three causes and only one of them
      // is merit: a rasterizer whose edges genuinely hold still, an arm that SNAPPED translation
      // to whole pixels (it cannot shimmer because it cannot move — `dom` reads exactly 0), and an
      // arm too blurry to have edge structure to disturb (`godot-default`, the blurriest measured,
      // reads lower than `canvas2d`). Crowning any of them would tell the reader the opposite of
      // what the number means, so this row is read next to distortion and the residual, not ranked.
      makeRow("edgeShimmer", arms, (arm) => fixed(at(arm)?.edgeShimmer, 5), {
        hint: "CV of acutance across the offsets — the crawl metric, but see the note",
      }),
      makeRow("inkShimmer", arms, (arm) => fixed(at(arm)?.shimmer, 5), {
        hint: "CV of total ink; conserved by construction, so the weaker signal",
      }),
      makeRow(
        "subpixelTravel",
        arms,
        (arm) => fixed(at(arm)?.subpixelTravel, 3),
        {
          hint: "centroid slope vs requested offset; ~1 is right, ~0 means the offset never arrived",
        },
      ),
      makeRow(
        "subpixelResidualPx",
        arms,
        (arm) => fixed(at(arm)?.subpixelResidualPx, 3),
        {
          hint: "~0.29 px is the signature of snapping to whole pixels",
          better: "lower",
          excludeFromBest,
        },
      ),
      makeRow("meanInk", arms, (arm) => fixed(at(arm)?.meanInk, 3), {
        hint: "how much ink the arm lays down at all",
      }),
      // Read this BEFORE rmsVsReference, which is why it sits directly above it. It is not a
      // quality score — it is whether the row under it is about rasterization at all.
      makeRow("alignment px", arms, (arm) => fixed(at(arm)?.alignmentPx, 3), {
        hint: `px this arm must be moved to land on the reference, by correlation; above ${tolerance} px the per-pixel rows below stop meaning what they say`,
        better: "lower",
        excludeFromBest,
      }),
      makeRow(
        "rmsVsReference",
        arms,
        (arm) => {
          const value = fixed(at(arm)?.rmsVsReference, 2);
          // The number stays. Blanking it would make a misaligned arm indistinguishable from an
          // unmeasured one, and "absent means NOT MEASURED" is the one rule this reader never bends.
          return misaligned.includes(arm) && value !== DASH
            ? `${value} ⚠`
            : value;
        },
        {
          hint: "ranks hinting policy, not crispness — read it last, and only if alignment px is small",
        },
      ),
      makeRow("samples", arms, (arm) => integer(at(arm)?.samples)),
    ],
    notes: [
      "acutance has no direction. The reference is the SAME geometry drawn at 8× and box-downsampled — correct area coverage for this run — so distortion, the distance from it, is the column to read.",
      "rmsVsReference is absent for the Godot arms on purpose: a different rasterizer disagrees about hinting and stem darkening long before it disagrees about blur, so a score there would rank the wrong thing.",
      "edgeShimmer is reported but NOT ranked, because low has three causes and only one is merit: edges that genuinely hold still, an arm that snapped translation to whole pixels (it cannot shimmer because it cannot move — check the residual), and an arm too blurry to have edge structure to disturb (check the distortion). Read all three columns together or none of them.",
      `alignment px is a licence, not a score. Every arm anchors its alphabetic baseline at the same y inside the run box, so a large value means an arm is not drawing where it was asked — and then rmsVsReference and the diff view measure that offset instead of the rasterizer. The dom arm once sat 2.35 px low and no column said so. Only distortion, the shimmers and travel are translation-invariant.${
        misaligned.length > 0 ? ` FLAGGED NOW: ${misaligned.join(", ")}.` : ""
      }`,
      "alignment px is found by correlating the two stills, which measures displacement and not blur — its noise floor is 0.066 px, measured over 56 pairs of independently rendered reference stills. It carries one bias worth knowing: an arm blurrier than the reference reads about 0.65 × its own distortion of spurious offset. So read a flagged arm's distortion next to it — a flag at low distortion is displacement and nothing else.",
      ...(band
        ? [
            `Every number here is measured over the ${band} band ALONE — the rows of the still that run occupies — against a reference cropped the same way. The other band is a different script in a different face with a different correct acutance, so its numbers are on a different scale: read down this table, never across to the other one.`,
          ]
        : []),
    ],
  };
}

function browserGroup(
  arms: string[],
  byArm: Map<string, RunDocument>,
): TextReportGroup {
  const at = (arm: string) => byArm.get(arm);
  const sample = arms.map((arm) => at(arm)).find(Boolean);
  const gpu = sample?.metrics?.gpu;
  // Scenario counters differ per arm — `fillTextCalls` is canvas2d-only, `domNodes` is dom-only —
  // so the row set is their UNION and an arm that does not report one gets a dash.
  const scenarioKeys = [
    ...new Set(
      arms.flatMap((arm) => Object.keys(at(arm)?.metrics?.scenario ?? {})),
    ),
  ].sort();
  return {
    id: "browser",
    title: "browser frame cost",
    environment: `${sample?.env?.label ?? "unknown"} · ${gpu?.hardware ?? "gpu not reported"}${
      sample?.env?.geometry?.viewport
        ? ` · ${sample.env.geometry.viewport.width}×${sample.env.geometry.viewport.height} @ fitScale ${sample.env.geometry.fitScale ?? 1}`
        : ""
    }`,
    arms,
    rows: [
      makeRow(
        "frameCostMs p50/p95/max",
        arms,
        (arm) => {
          const cost = at(arm)?.metrics?.frameCostMs;
          return cost
            ? `${fixed(cost.p50, 2)}/${fixed(cost.p95, 2)}/${fixed(cost.max, 2)}`
            : DASH;
        },
        { hint: "main-thread cost of one animation frame" },
      ),
      makeRow(
        "contentUpdateHz",
        arms,
        (arm) => fixed(at(arm)?.metrics?.contentUpdateHz, 2),
        { hint: "frames whose CONTENT changed — not the swap rate" },
      ),
      makeRow("rasterMs", arms, (arm) => fixed(at(arm)?.metrics?.rasterMs, 0), {
        better: "lower",
      }),
      makeRow(
        "mainThreadBusyMs",
        arms,
        (arm) => fixed(at(arm)?.metrics?.mainThreadBusyMs, 0),
        { better: "lower" },
      ),
      makeRow(
        "cpu.totalCpuMs",
        arms,
        (arm) => fixed(at(arm)?.metrics?.cpu?.totalCpuMs, 0),
        {
          hint: "all processes; a LOWER BOUND, never a budget",
          better: "lower",
        },
      ),
      makeRow("layerCount", arms, (arm) =>
        integer(at(arm)?.metrics?.layerCount),
      ),
      makeRow(
        "presence",
        arms,
        (arm) => {
          const presented = at(arm)?.metrics?.presented;
          return presented
            ? `${integer(presented.sampleHits)}/${integer(presented.sampleCount)}`
            : DASH;
        },
        { hint: "sample points landing on ink; short of full means DISCARD" },
      ),
      ...scenarioKeys.map((key) =>
        makeRow(key, arms, (arm) => {
          const value = at(arm)?.metrics?.scenario?.[key];
          return value === undefined
            ? DASH
            : Number.isInteger(value)
              ? integer(value)
              : fixed(value, 2);
        }),
      ),
    ],
    notes: [
      "These are browser numbers only. They share no column with the Godot group below and must not be compared to it — different process, different machine, different clock.",
      "Zero rasterMs on a canvas arm is not a bug: the canvas is composited, so its cost lands in the GPU process rather than in raster.",
    ],
  };
}

function godotGroup(
  arms: string[],
  byArm: Map<string, GodotDocument>,
): TextReportGroup {
  const at = (arm: string) => byArm.get(arm);
  const sample = arms.map((arm) => at(arm)).find(Boolean);
  return {
    id: "godot",
    title: "Godot — VRAM and draw calls",
    environment: `${sample?.godot ?? "godot"} · ${sample?.renderer ?? "?"} · ${
      sample?.adapter ?? "adapter not reported"
    }`,
    arms,
    rows: [
      makeRow(
        "text texture memory",
        arms,
        (arm) => megabytes(at(arm)?.metrics?.textTextureMemBytes),
        {
          hint: "delta over an identical empty scene — the atlas, attributed",
          better: "lower",
        },
      ),
      makeRow("text buffer memory", arms, (arm) =>
        megabytes(at(arm)?.metrics?.textBufferMemBytes),
      ),
      makeRow(
        "drawCalls p50",
        arms,
        (arm) => integer(at(arm)?.metrics?.drawCalls?.p50),
        { better: "lower" },
      ),
      makeRow(
        "frameMs p50",
        arms,
        (arm) => fixed(at(arm)?.metrics?.frameMs?.p50, 2),
        {
          hint: "PRESENT-BOUND under Xvfb — see the note",
        },
      ),
      makeRow("frameMs p95", arms, (arm) =>
        fixed(at(arm)?.metrics?.frameMs?.p95, 2),
      ),
      makeRow("msdf", arms, (arm) => yesNo(at(arm)?.msdf)),
      makeRow("msdfSize", arms, (arm) => integer(at(arm)?.msdfSize)),
      makeRow("msdfPixelRange", arms, (arm) =>
        integer(at(arm)?.msdfPixelRange),
      ),
      makeRow("oversampling", arms, (arm) => fixed(at(arm)?.oversampling, 2)),
      makeRow("subpixelPositioning", arms, (arm) =>
        integer(at(arm)?.subpixelPositioning),
      ),
      makeRow(
        "pool video memory (NOT a cost)",
        arms,
        (arm) => megabytes(at(arm)?.metrics?.poolVideoMemBytes?.p50),
        { hint: "VMA pool total, quantised to ~34 MiB blocks" },
      ),
    ],
    notes: [
      "Read texture memory and draw calls here; do NOT read frame cost. Under Xvfb the present is a software blit of the whole surface, which puts a ~28 ms floor under every variant identically.",
      "Pool video memory is the allocator's total, block-quantised — it once made msdf and oversample look identically expensive when they differ by 64×. Only the text texture delta is per-resource.",
    ],
  };
}

function missingInputs(
  inputs: ReportInputs,
): { what: string; command: string }[] {
  const missing: { what: string; command: string }[] = [];
  if (!inputs.fidelity || (inputs.fidelity.results ?? []).length === 0) {
    missing.push({
      what: "fidelity stills and crispness metrics (all three views need these)",
      command: "xvfb-run -a mise exec -- pnpm -w run text:fidelity",
    });
  }
  if (inputs.godot.length === 0) {
    missing.push({
      what: "Godot VRAM, draw calls and the msdf/oversample variants",
      command:
        "xvfb-run -a mise exec -- pnpm -w run godot:text-bench -- --all-variants",
    });
  }
  if (inputs.runs.length === 0) {
    missing.push({
      what: "browser frame cost, raster and CPU",
      command: "mise exec -- pnpm -w run perf -- --scenario text-render",
    });
  }
  return missing;
}

/* ---------------------------------------------------------------------------------------------
 * I/O: find the artifacts, copy the stills, make the diffs, write the page.
 * ------------------------------------------------------------------------------------------- */

export interface WriteOptions {
  repoRoot?: string;
  outDir?: string;
  fidelityPath?: string;
  godotDir?: string;
  runDir?: string;
}

export async function writeTextReport(options: WriteOptions = {}): Promise<{
  outDir: string;
  data: TextReportData;
}> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const outDir = options.outDir ?? join(repoRoot, "artifacts/perf/text-report");
  const fidelityPath =
    options.fidelityPath ??
    join(repoRoot, "artifacts/perf/probes/text-fidelity/text-fidelity.json");
  const godotDir =
    options.godotDir ?? join(repoRoot, "artifacts/perf/godot-text");
  await mkdir(outDir, { recursive: true });

  const sources: string[] = [];
  const fidelity = await readJson<FidelityDocument>(fidelityPath);
  if (fidelity) {
    sources.push(fidelityPath);
  }

  const godot: GodotDocument[] = [];
  for (const variant of GODOT_VARIANTS) {
    const path = join(godotDir, `${variant}.json`);
    const document = await readJson<GodotDocument>(path);
    if (document) {
      godot.push({ variant, ...document });
      sources.push(path);
    }
  }

  const runDir = options.runDir ?? (await newestTextRunDir(repoRoot));
  const runs: RunDocument[] = [];
  if (runDir) {
    for (const name of (await readdir(runDir)).sort()) {
      if (!name.startsWith("text-render-") || !name.endsWith(".json")) {
        continue;
      }
      const path = join(runDir, name);
      const document = await readJson<RunDocument>(path);
      if (document) {
        runs.push(document);
        sources.push(path);
      }
    }
  }

  const offsetCount = fidelity?.offsets?.length ?? 8;
  const stills = await copyStills({
    repoRoot,
    outDir,
    godotDir,
    fidelityDir: dirname(fidelityPath),
    rows: fidelity?.results ?? [],
    offsetCount,
  });
  const diffs = await writeDiffs(outDir, stills);

  const data = buildReportData({
    fidelity,
    godot,
    runs,
    stills,
    diffs,
    sources,
  });
  await writeFile(join(outDir, "index.html"), renderPage(data));
  await writeFile(
    join(outDir, "data.json"),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  return { outDir, data };
}

/**
 * Copy every still into the report directory under a predictable name.
 *
 * Copying rather than linking is what makes the output ONE MOVABLE DIRECTORY: the stills otherwise
 * live in three places (the probe's own dir, the Godot bench's stills dir, and a timestamped run
 * dir that gets cleaned), and a report full of `../../..` would rot the first time anyone tidied
 * `artifacts/`.
 */
async function copyStills(args: {
  repoRoot: string;
  outDir: string;
  godotDir: string;
  fidelityDir: string;
  rows: readonly FidelityRowDocument[];
  offsetCount: number;
}): Promise<Record<string, (string | null)[]>> {
  const stills: Record<string, (string | null)[]> = {};
  for (const row of args.rows) {
    // ONE COPY PER ARM. `results` carries a row per arm per band and every band of an arm shares
    // the same whole-box stills, so copying per row would do the work twice and — worse — let a
    // later band's `stills` list silently replace an earlier one's.
    if (stills[row.arm]) continue;
    const files: (string | null)[] = [];
    for (let offset = 0; offset < args.offsetCount; offset += 1) {
      const source = await resolveStill(args, row, offset);
      if (!source) {
        files.push(null);
        continue;
      }
      const name = `${row.arm}-${offset}.png`;
      await copyFile(source, join(args.outDir, name));
      files.push(name);
    }
    stills[row.arm] = files;
  }
  return stills;
}

/**
 * Where one still lives.
 *
 * The probe publishes `stills` per row, which is authoritative. The fallbacks exist so a report
 * built against artifacts from BEFORE the probe started recording them still shows pixels: the
 * browser arms land beside the fidelity JSON, the Godot arms beside the Godot bench's output.
 */
async function resolveStill(
  args: { repoRoot: string; godotDir: string; fidelityDir: string },
  row: FidelityRowDocument,
  offset: number,
): Promise<string | null> {
  const candidates: string[] = [];
  const published = row.stills?.[offset];
  if (published) {
    candidates.push(
      isAbsolute(published) ? published : join(args.repoRoot, published),
    );
  }
  if (row.arm.startsWith("godot-")) {
    const variant = row.arm.slice("godot-".length);
    candidates.push(
      join(args.godotDir, "stills", `fidelity-${variant}-${offset}.png`),
    );
  } else {
    candidates.push(join(args.fidelityDir, `${row.arm}-${offset}.png`));
  }
  if (offset === 0) {
    candidates.push(join(args.fidelityDir, `${row.arm}.png`));
  }
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * |arm − reference| per offset, written at NO gain.
 *
 * Per offset, and against the reference AT THAT OFFSET: a moved arm differenced against a still
 * reference draws the translation, not the rasterizer, which is a picture that looks alarming and
 * means nothing. Amplification is left to the page (`filter: brightness`) so the gain slider stays
 * interactive without regenerating a single file.
 */
async function writeDiffs(
  outDir: string,
  stills: Record<string, (string | null)[]>,
): Promise<Record<string, (string | null)[]>> {
  const references = stills.reference ?? [];
  const diffs: Record<string, (string | null)[]> = {};
  for (const [arm, files] of Object.entries(stills)) {
    const out: (string | null)[] = [];
    for (const [offset, file] of files.entries()) {
      const referenceFile = references[offset];
      if (!file || !referenceFile) {
        out.push(null);
        continue;
      }
      const name = `diff-${arm}-${offset}.png`;
      const written = await writeAbsoluteDifference(
        join(outDir, file),
        join(outDir, referenceFile),
        join(outDir, name),
      );
      out.push(written ? name : null);
    }
    diffs[arm] = out;
  }
  return diffs;
}

async function writeAbsoluteDifference(
  aPath: string,
  bPath: string,
  outPath: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    sharp(aPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(bPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  // A diff of two differently sized images would be a diff of the CROP, silently. Refuse instead.
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    return false;
  }
  const out = Buffer.alloc(a.data.length);
  for (let i = 0; i < a.data.length; i += 4) {
    out[i] = Math.abs(a.data[i] - b.data[i]);
    out[i + 1] = Math.abs(a.data[i + 1] - b.data[i + 1]);
    out[i + 2] = Math.abs(a.data[i + 2] - b.data[i + 2]);
    out[i + 3] = 255;
  }
  await sharp(out, {
    raw: { width: a.info.width, height: a.info.height, channels: 4 },
  })
    .png()
    .toFile(outPath);
  return true;
}

/**
 * The run directory the browser table is built from: the newest one holding a COMPARISON.
 *
 * "Newest with any `text-render-*` in it" is the obvious rule and it is wrong here. S9's arms have
 * isolations (`--param bakeShaper=fillText`, `--param phases=9`), each of which is a single-arm run
 * written after the four-arm comparison — so the obvious rule silently replaces a table of four
 * arms with a table of one, and the page still looks entirely plausible.
 *
 * So: newest run with at least two arms, falling back to the newest with one when that is all there
 * is (a first run, or a deliberate single-arm investigation). `--run-dir` overrides both.
 */
async function newestTextRunDir(repoRoot: string): Promise<string | null> {
  const runsRoot = join(repoRoot, "artifacts/perf/runs");
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }
  let singleArmFallback: string | null = null;
  for (const name of entries.sort().reverse()) {
    const dir = join(runsRoot, name);
    try {
      const arms = (await readdir(dir)).filter((file) =>
        file.startsWith("text-render-"),
      );
      if (arms.length >= 2) {
        return dir;
      }
      if (arms.length === 1) {
        singleArmFallback ??= dir;
      }
    } catch {
      // Not a directory, or gone. Keep looking.
    }
  }
  return singleArmFallback;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const { outDir, data } = await writeTextReport({
    outDir: flag("out") ? resolve(flag("out") as string) : undefined,
    fidelityPath: flag("fidelity")
      ? resolve(flag("fidelity") as string)
      : undefined,
    godotDir: flag("godot-dir")
      ? resolve(flag("godot-dir") as string)
      : undefined,
    runDir: flag("run-dir") ? resolve(flag("run-dir") as string) : undefined,
  });

  for (const source of data.sources) {
    console.log(`read  ${basename(dirname(source))}/${basename(source)}`);
  }
  const withStills = data.arms.filter((arm) => arm.stills.some(Boolean)).length;
  console.log(
    `\n${data.arms.length} arms (${withStills} with stills), ${data.groups.length} metric groups, ${data.offsets.length} offsets`,
  );
  for (const entry of data.missing) {
    console.log(`\nNOT MEASURED: ${entry.what}\n  ${entry.command}`);
  }
  console.log(`\n${join(outDir, "index.html")}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
