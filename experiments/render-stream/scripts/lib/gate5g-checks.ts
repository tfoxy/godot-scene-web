// Gate 5g checks: nine-patch and stylebox coverage (protocol/gate5-design.md "G5g", "Q6f").
//
// Group g5g runs fixtures/gate5-style/ through G5b's and G5d's legs: an import, a 400-frame
// headless capture with both sinks and the store (`success` on render-stream/4), a rendered
// reference, a same-build repeat, an extension-armed reference, rendered receivers on the full
// and patch sinks, a headless receiver under strace, and the receiver sabotage
// `ignore-nine-patch-axis`. Its evidence lives under <out>/style/ in the same shape as G5b's and
// G5d's under <out>/, so every helper that takes an evidence root runs on it unchanged; this
// module adds what styles need: the fixture's own expected.json (the StyleBoxFlat lowering ported
// by make_expected.py, the nine-patch axis modes, the default theme's Panel and focus boxes),
// `stylebox-lowering` (Q1h's counts, on the expected calls and on the wire), `nine-patch-args`,
// the RichTextLabel's clip-ignore pair while focused, and the receiver sabotage's prediction
// recomputed from the raster. Check ids carry a "-style" suffix so that they never collide with
// g5b's and g5d's. Nothing here launches a process.
//
// Evidence layout under <out>/style/ (see scripts/README.md "Gate 5"):
//   import/fixture/                   editor --import of fixtures/gate5-style
//   capture/                          leg capture-style: 400 frames, both sinks, store, strace
//   reference/, reference-repeat/     legs reference-style and reference-style-repeat
//   reference-armed/                  leg reference-style-armed (extension armed, full-sink stream)
//   receiver/, receiver-patch/        legs receiver-style and receiver-style-patch (state dumps)
//   receiver-headless-trace/          headless receiver under strace -e openat
//   sabotage-receiver-ignore-axis/    leg sabotage-style-receiver-ignore-axis

import { join } from "node:path";

import {
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  checkReceiverNeverLoadedFixture,
  classifyLeg,
  type Gate0Check,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import {
  checkNoDrawIndexTies,
  checkPatchResolvesToFull,
  checkRecordingsDecode,
  evaluateCapture,
} from "./gate3-checks";
import {
  check,
  checkCaptureLegClass5,
  checkExpectedSelfConsistent,
  checkGeometryHookCensus,
  checkStepAlignment5,
  commandCensus,
  compareLegs5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluatePresence5,
  exactnessTable,
  type Gate5Check,
  type Gate5Checkpoint,
  type Gate5Report,
  loadShots5,
  type PixelClass,
  type RegionBudget5,
  rastersOf,
  regionAt,
  shotPaths5,
} from "./gate5-checks";
import type { Gate5Expected, Gate5Op } from "./gate5-expected";
import {
  computeGate5Checkpoints,
  evaluateClipRectsDerived,
  evaluateGeometryCommands,
  evaluateLegClass5,
  type Gate5LegExpectation,
  itemIdsByName,
  loadReceiverShots5,
  receiverStates,
  sameValue,
  settleSeqs,
  shotSeqsPresent5,
  sinkStates,
  textureIdsByName,
  wireCommandOf,
} from "./gate5d-checks";
import { type Gate5Raster, rasterizeItems } from "./geometry-raster";

export const STYLE_DIR = "style";
export const G5G_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;
/** report leg names (gate 4c's naming: the fixture's word after the role) */
const LEG_NAMES: Record<(typeof G5G_SUPPORT_LEGS)[number], string> = {
  import: "import-style",
  reference: "reference-style",
  "reference-repeat": "reference-style-repeat",
  "reference-armed": "reference-style-armed",
};

const tag = (c: Gate5Check): Gate5Check => ({ ...c, id: `${c.id}-style` });
const fromGate0 = (c: Gate0Check): Gate5Check =>
  tag({ ...c, status: c.passed ? "pass" : "fail" });

// ---------------------------------------------------------------------------------------------
// stylebox-lowering (on expected.json's calls before G5d; on the wire from G5d)
// ---------------------------------------------------------------------------------------------

export interface TriangleArrayLike {
  item: string;
  indices: unknown[];
  points: unknown[];
  colors: unknown[];
  uvs: unknown[];
}

/** Pure: every StyleBoxFlat triangle array (one per item redraw) has Q1h's vertex and index
 * counts as expected.json `lowering_predictions` lists them (vertices = colours = uvs, indices
 * a multiple of 3 within range), and every item listed is drawn. */
export function evaluateStyleboxLowering(
  expected: Pick<Gate5Expected, "lowering_predictions">,
  arrays: readonly TriangleArrayLike[],
): { problems: string[]; seen: Record<string, number> } {
  const problems: string[] = [];
  const seen: Record<string, number> = {};
  for (const a of arrays) {
    const want = expected.lowering_predictions[a.item];
    if (!want) {
      problems.push(`${a.item}: a triangle array with no lowering prediction`);
      continue;
    }
    seen[a.item] = (seen[a.item] ?? 0) + 1;
    const v = a.points.length;
    if (v !== want.vertices || a.indices.length !== want.indices)
      problems.push(
        `${a.item}: ${v} vertices / ${a.indices.length} indices, Q1h predicts ${want.vertices} / ${want.indices}`,
      );
    if (a.colors.length !== v || a.uvs.length !== v)
      problems.push(
        `${a.item}: ${a.colors.length} colours and ${a.uvs.length} uvs for ${v} vertices`,
      );
    if (
      a.indices.length % 3 !== 0 ||
      a.indices.some((i) => typeof i !== "number" || i < 0 || i >= v)
    )
      problems.push(`${a.item}: indices out of range or not whole triangles`);
  }
  for (const item of Object.keys(expected.lowering_predictions))
    if (!seen[item]) problems.push(`${item}: no triangle array`);
  return { problems, seen };
}

/** The expected calls' StyleBoxFlat triangle arrays, in step order. */
export function expectedTriangleArrays(
  expected: Pick<Gate5Expected, "steps">,
): TriangleArrayLike[] {
  const out: TriangleArrayLike[] = [];
  for (const s of expected.steps)
    for (const calls of Object.values(s.calls))
      for (const c of calls)
        if (c.op === "canvas_item_add_triangle_array")
          out.push(c as unknown as TriangleArrayLike);
  return out;
}

// ---------------------------------------------------------------------------------------------
// ignore-axis-prediction: the receiver sabotage's regions, recomputed from the raster
// ---------------------------------------------------------------------------------------------

/** The model with every nine-patch axis forced to `stretch` (what the receiver's
 * `ignore-nine-patch-axis` sabotage draws). */
export function stretchedOpLists(
  opLists: Record<string, Gate5Op[]>,
): Record<string, Gate5Op[]> {
  const out: Record<string, Gate5Op[]> = {};
  for (const [key, ops] of Object.entries(opLists))
    out[key] = ops.map((op) =>
      "kind" in op && op.kind === "nine_patch"
        ? { ...op, x_axis: "stretch" as const, y_axis: "stretch" as const }
        : op,
    );
  return out;
}

/** Pure: per region, the steps at which the stretched raster differs from the real one (a decided
 * pixel's value or which pixels are decided); it must equal expected.json's prediction for
 * `sabotage-style-receiver-ignore-axis`. */
export function evaluateIgnoreAxisPrediction(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): { problems: string[]; regions: Record<string, number[]> } {
  const problems: string[] = [];
  const regions: Record<string, number[]> = {};
  const stretched = stretchedOpLists(expected.op_lists);
  for (const s of expected.steps) {
    const r = rasters.get(s.step);
    if (!r) continue;
    const alt = rasterizeItems({
      viewport: expected.viewport,
      clear: expected.clear_rgba8,
      textures: expected.textures,
      opLists: stretched,
      items: s.items,
      exactEdgePx: expected.exact_edge_px,
    });
    const hit = new Set<string>();
    for (let i = 0; i < r.width * r.height; i++) {
      let differs = r.exact[i] !== alt.exact[i];
      for (let c = 0; c < 4 && !differs; c++)
        differs = r.rgba[i * 4 + c] !== alt.rgba[i * 4 + c];
      if (differs)
        hit.add(
          regionAt(expected.regions, i % r.width, Math.floor(i / r.width)),
        );
    }
    for (const g of hit) {
      regions[g] = regions[g] ?? [];
      regions[g].push(s.step);
    }
  }
  const want =
    expected.predictions["sabotage-style-receiver-ignore-axis"]?.regions ?? {};
  const norm = (o: Record<string, number[]>) =>
    JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (norm(regions) !== norm(want))
    problems.push(
      `the stretched raster differs in ${norm(regions)}, expected.json predicts ${norm(want)}`,
    );
  return { problems, regions };
}

// ---------------------------------------------------------------------------------------------
// On the wire (render-stream/4): stylebox-lowering, nine-patch-args, the focus clip-ignore pair
// ---------------------------------------------------------------------------------------------

/** The settle transaction of each step. */
function settleTransactions(
  expected: Pick<Gate5Expected, "steps">,
  recording: Pick<RecordingSummary, "transactions">,
) {
  return expected.steps.map((s) => ({
    step: s.step,
    t: recording.transactions.find((x) => x.meta.frame === s.settle_frame),
  }));
}

/** Every add_triangle_array the recording carries at the settle frames, named by fixture item. */
export function wireTriangleArrays(
  expected: Pick<Gate5Expected, "steps" | "creation_order">,
  recording: Pick<RecordingSummary, "transactions">,
): TriangleArrayLike[] {
  const ids = itemIdsByName(expected, recording).ids;
  const nameOf = new Map([...ids].map(([n, id]) => [id, n]));
  const out: TriangleArrayLike[] = [];
  for (const { t } of settleTransactions(expected, recording))
    for (const item of t?.meta.items ?? [])
      for (const c of item.commands as unknown as Record<string, unknown>[])
        if (c.op === "add_triangle_array")
          out.push({
            item: nameOf.get(item.id) ?? String(item.id),
            indices: (c.indices as unknown[]) ?? [],
            points: (c.points as unknown[]) ?? [],
            colors: (c.colors as unknown[]) ?? [],
            uvs: (c.uvs as unknown[]) ?? [],
          });
  return out;
}

/** Pure: at every settle frame of every sink, each item's add_nine_patch commands equal its
 * expected calls float32-exact (rect, source, margins, axis modes, draw_center, modulate, the
 * texture's wire id): NinePatchRect and StyleBoxTexture pass their arguments through. */
export function evaluateNinePatchArgs(
  expected: Gate5Expected,
  sinks: readonly { label: string; recording: RecordingSummary }[],
): { problems: string[]; compared: number; modes: string[] } {
  const problems: string[] = [];
  let compared = 0;
  const modes = new Set<string>();
  for (const { label, recording } of sinks) {
    const ids = itemIdsByName(expected, recording).ids;
    const tex = textureIdsByName(expected, recording);
    problems.push(...tex.problems.map((p) => `${label}: ${p}`));
    const lastCalls = new Map<
      string,
      Gate5Expected["steps"][number]["calls"][string]
    >();
    for (const s of expected.steps) {
      for (const item of s.redraws) lastCalls.set(item, []);
      for (const calls of Object.values(s.calls))
        for (const c of calls)
          lastCalls.set(c.item, [...(lastCalls.get(c.item) ?? []), c]);
      const t = recording.transactions.find(
        (x) => x.meta.frame === s.settle_frame,
      );
      for (const [name, calls] of lastCalls) {
        const want = calls
          .filter((c) => c.op === "canvas_item_add_nine_patch")
          .map((c) => wireCommandOf(c, tex.ids));
        const item = t?.meta.items.find((i) => i.id === ids.get(name));
        const got = (
          (item?.commands ?? []) as unknown as Record<string, unknown>[]
        ).filter((c) => c.op === "add_nine_patch");
        if (got.length !== want.length) {
          problems.push(
            `${label} step ${s.step} ${name}: ${got.length} add_nine_patch, expected ${want.length}`,
          );
          continue;
        }
        want.forEach((w, k) => {
          compared++;
          modes.add(
            `${name} ${String(got[k].x_axis)}/${String(got[k].y_axis)}${got[k].draw_center ? "" : " hollow"}`,
          );
          if (!sameValue(w, got[k], 0))
            problems.push(
              `${label} step ${s.step} ${name}: ${JSON.stringify(got[k]).slice(0, 200)} != ${JSON.stringify(w).slice(0, 200)}`,
            );
        });
      }
    }
  }
  return { problems, compared, modes: [...modes].sort() };
}

/** Pure: the add_clip_ignore pair sits around the focus box, in RT's commands only, exactly at
 * the steps expected.json predicts (predictions["focus-clip-ignore"]: while it has focus), and
 * RT has no command at all at the other steps. */
export function evaluateFocusClipIgnore(
  expected: Gate5Expected,
  recording: Pick<RecordingSummary, "transactions">,
): { problems: string[]; steps: number[] } {
  const problems: string[] = [];
  const want = expected.predictions["focus-clip-ignore"]?.steps ?? [];
  const ids = itemIdsByName(expected, recording).ids;
  const rt = ids.get("RT");
  const steps: number[] = [];
  for (const { step, t } of settleTransactions(expected, recording)) {
    if (!t) {
      problems.push(`step ${step}: no settle transaction`);
      continue;
    }
    for (const item of t.meta.items) {
      const cmds = item.commands as unknown as Record<string, unknown>[];
      const pairs = cmds.filter((c) => c.op === "add_clip_ignore");
      if (item.id !== rt) {
        if (pairs.length > 0)
          problems.push(
            `step ${step}: item ${item.id} carries add_clip_ignore`,
          );
        continue;
      }
      const shape = cmds.map((c) =>
        c.op === "add_clip_ignore" ? `ignore=${String(c.ignore)}` : c.op,
      );
      const focused =
        JSON.stringify(shape) ===
        JSON.stringify(["ignore=true", "add_triangle_array", "ignore=false"]);
      if (focused) steps.push(step);
      else if (shape.length > 0)
        problems.push(`step ${step}: RT commands ${shape.join(",")}`);
    }
  }
  if (JSON.stringify(steps) !== JSON.stringify(want))
    problems.push(
      `the focus box between clip_ignore(true) and (false) at steps {${steps.join(",")}}, expected {${want.join(",")}}`,
    );
  return { problems, steps };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface G5gResult {
  checks: Gate5Check[];
  legs: Gate5Report["legs"];
  checkpoints: Gate5Checkpoint[];
  geometry: {
    hook_census: Record<string, number | "unhooked">;
    steps: Record<string, Record<string, number>>;
    exactness: Record<string, Record<PixelClass, number>>;
  };
  budgets: RegionBudget5[];
  freshness: Record<string, string[]>;
}

const RECEIVER_LEGS = {
  receiver: "receiver-style",
  "receiver-patch": "receiver-style-patch",
} as const;
const AXIS_SABOTAGE = "sabotage-receiver-ignore-axis";
const AXIS_SABOTAGE_LEG = "sabotage-style-receiver-ignore-axis";

/** Every g5g receiver-bearing leg directory, relative to <out>/style. */
export function g5gReceiverDirs(): string[] {
  return [
    "receiver",
    "receiver-patch",
    "receiver-headless-trace",
    AXIS_SABOTAGE,
  ];
}

async function supportLegExits(root: string): Promise<Gate5Check> {
  const problems: string[] = [];
  const dirOf = (l: string) =>
    l === "import" ? join(root, "import", "fixture") : join(root, l);
  for (const leg of G5G_SUPPORT_LEGS) {
    const code = await readExitCode(dirOf(leg));
    if (code !== 0) problems.push(`${LEG_NAMES[leg]} exit ${code ?? "<none>"}`);
  }
  return check(
    "support-legs-exit-style",
    "the style fixture's import, reference, reference-repeat and reference-armed legs exited 0",
    problems,
    `${G5G_SUPPORT_LEGS.length} support legs exited 0`,
    G5G_SUPPORT_LEGS.map((l) => join(dirOf(l), "exit-code.txt")),
  );
}

async function receiverTypedClean(root: string): Promise<Gate5Check> {
  const bad = /SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  const problems: string[] = [];
  const paths = g5gReceiverDirs().map((d) => join(root, d, "stdout.log"));
  for (const log of paths) {
    const text = await readTextOrUndefined(log);
    if (text === undefined) {
      problems.push(`${log} missing`);
      continue;
    }
    const line = text.split("\n").find((l) => bad.test(l));
    if (line) problems.push(`${log}: ${line.trim()}`);
  }
  return check(
    "receiver-typed-clean-style",
    "no g5g receiver leg's stdout.log has a SCRIPT ERROR, SCRIPT WARNING, Parse Error or Failed to load script line",
    problems,
    `${paths.length} receiver logs clean`,
    paths,
  );
}

export async function runG5g(
  outDir: string,
  ctx: {
    expected: Gate5Expected;
    receiverProjectDir?: string;
    fixtureProjectDir?: string;
  },
): Promise<G5gResult> {
  const expected = ctx.expected;
  const root = join(outDir, STYLE_DIR);
  const rasters = rastersOf(expected);
  const capture = await evaluateCapture(root, { expectedClass: "success" });
  const reference = await loadShots5(root, "reference", expected);
  const repeat = await loadShots5(root, "reference-repeat", expected);
  const armed = await loadShots5(root, "reference-armed", expected);
  const referenceDir = join(root, "reference");

  const image = evaluateExpectedImage5(
    expected,
    "reference-style",
    reference,
    rasters,
    join(referenceDir, "shots"),
  );
  const presence = evaluatePresence5(
    expected,
    "reference-style",
    reference,
    rasters,
  );
  const fresh = evaluateFreshness5(expected, "reference-style", reference);
  const repeatCmp = compareLegs5(expected, reference, repeat, rasters, [
    "reference-style",
    "reference-style-repeat",
  ]);
  const armedCmp = compareLegs5(expected, reference, armed, rasters, [
    "reference-style",
    "reference-style-armed",
  ]);
  const armedResult = await readJson<CaptureResultJson>(
    join(root, "reference-armed", "evidence", "result.json"),
  );
  if (armedResult?.status !== "armed")
    armedCmp.problems.unshift(
      `reference-style-armed result.json status=${JSON.stringify(armedResult?.status)}`,
    );
  if (armedResult?.stream?.status !== "closed")
    armedCmp.problems.unshift(
      `reference-style-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
    );
  const census = await checkGeometryHookCensus(root, expected);
  const loweringExpected = evaluateStyleboxLowering(
    expected,
    expectedTriangleArrays(expected),
  );
  const loweringWire = evaluateStyleboxLowering(
    expected,
    wireTriangleArrays(expected, capture.full),
  );
  const axis = evaluateIgnoreAxisPrediction(expected, rasters);
  const bandBudgets = repeatCmp.budgets.filter(
    (b) => (b.class === "band" || b.class === "undecided") && b.pixels > 0,
  );
  const refShots = shotPaths5(root, "reference", expected);
  const sinks = [
    { label: "full", recording: capture.full },
    { label: "patch", recording: capture.patch },
  ];
  const geometry = evaluateGeometryCommands(expected, sinks);
  const ninePatch = evaluateNinePatchArgs(expected, sinks);
  const focus = evaluateFocusClipIgnore(expected, capture.full);

  const checks: Gate5Check[] = [
    tag(checkExpectedSelfConsistent(expected, rasters)),
    check(
      "stylebox-lowering-style",
      "every StyleBoxFlat triangle array -- in expected.json's calls and at every settle frame of the capture -- has Q1h's hand-typed vertex and index counts (lowering_predictions), one colour and one uv per vertex, whole in-range triangles, and every box is drawn",
      [
        ...loweringExpected.problems.map((p) => `expected: ${p}`),
        ...loweringWire.problems.map((p) => `capture: ${p}`),
      ],
      Object.entries(loweringWire.seen)
        .map(
          ([item, n]) =>
            `${item} ${expected.lowering_predictions[item].vertices}/${expected.lowering_predictions[item].indices} x${n}`,
        )
        .join(", "),
      [capture.full.path],
    ),
    check(
      "geometry-commands-style",
      "at every settle frame of both sinks, each item's /4 commands equal expected.json's calls argument for argument and in order (StyleBoxFlat triangle arrays within 2 ulp, the flip's set_transforms, the focus box's clip_ignore pair, the nine-patches float32-exact)",
      geometry.problems,
      `${geometry.compared} commands equal (${geometry.ulpUsed} used their 2-ulp allowance)`,
      [capture.full.path, capture.patch.path],
    ),
    check(
      "nine-patch-args-style",
      "at every settle frame of both sinks, every add_nine_patch equals its expected call float32-exact: rect, source, margins, axis modes, draw_center, modulate and TEXN's wire id",
      ninePatch.problems,
      `${ninePatch.compared} nine-patches equal: ${ninePatch.modes.join(", ")}`,
      [capture.full.path, capture.patch.path],
    ),
    check(
      "focus-clip-ignore-style",
      "the RichTextLabel's commands are clip_ignore(true), its focus box, clip_ignore(false) exactly while it has focus (expected.json predictions[focus-clip-ignore]) and nothing otherwise; no other item carries add_clip_ignore",
      focus.problems,
      `focus box between clip-ignores at steps {${focus.steps.join(",")}}`,
      [capture.full.path],
    ),
    check(
      "ignore-axis-prediction-style",
      "the raster with every nine-patch axis forced to stretch (the receiver's ignore-nine-patch-axis sabotage) differs from the real raster exactly in expected.json's predicted regions and steps (the tile and tile_fit regions, every step)",
      axis.problems,
      Object.entries(axis.regions)
        .map(([g, steps]) => `${g} {${steps.join(",")}}`)
        .join(", "),
      [],
    ),
    fromGate0(
      await checkCaptureArmed(root, {
        captureResult: capture.captureResult,
        recording: capture.full,
      }),
    ),
    fromGate0(await checkHeadlessNoGpuGate0(root)),
    tag(checkRecordingsDecode(capture.full, capture.patch)),
    tag(checkPatchResolvesToFull(capture.full, capture.patch)),
    tag(await checkStepAlignment5(root, expected, capture.full)),
    tag(checkNoDrawIndexTies(capture.full).check),
    tag(census.check),
    check(
      "expected-image-reference-style",
      "every reference-style shot equals the raster of make_expected.py's model on every decided pixel: exactly where flat and decided at least 1/16 px (and 1/16 texel) from every edge, within 1 where colours blend (the shadow fill, the theme Panel) or a modulated texel falls between UNORM8 levels; antialiasing and shadow rings are band, left out",
      image.problems,
      `${image.checkpoints.length} shots match on ${image.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels (${image.checkpoints.reduce((n, c) => n + (c.delta1_used ?? 0), 0)} used their delta of 1)`,
      refShots,
    ),
    check(
      "presence-reference-style",
      "in every reference-style shot, every sub-shape (band included) covers at least half its expected area with pixels differing from what the raster has beneath it",
      presence.problems,
      `${presence.shapes} shape-shots present`,
      refShots,
    ),
    check(
      "freshness-reference-style",
      "between consecutive reference-style shots a region changes exactly when expected.json says fresh (a box property, a resize, a lost focus repaint; a Panel move and the canvas transform repaint without a redraw)",
      fresh.problems,
      Object.entries(fresh.table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" "),
      refShots,
    ),
    check(
      "reference-repeat-budget-style",
      "reference-style vs reference-style-repeat (same build, GPU and driver): identical at every pixel of every shot -- the stylebox band budget is what this measures (D13 expects 0); maxima per region and pixel class are reported",
      repeatCmp.problems,
      `budget 0: ${expected.steps.length} shot pairs identical; band/undecided pixel-shots per region: ${bandBudgets
        .map(
          (b) => `${b.region} ${b.class} ${b.max_channel_delta}/${b.pixels}px`,
        )
        .join(", ")}`,
      [...refShots, ...shotPaths5(root, "reference-repeat", expected)],
    ),
    check(
      "armed-transparent-style",
      "reference-style-armed (extension armed, stream on) armed with its stream closed, and every shot equals reference-style's exactly",
      armedCmp.problems,
      `${expected.steps.length} armed shots byte-identical to the reference`,
      shotPaths5(root, "reference-armed", expected),
    ),
    await supportLegExits(root),
    tag(checkCaptureLegClass5(expected, capture)),
  ];

  const legs: Gate5Report["legs"] = {
    "capture-style": {
      group: "g5g",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    },
  };
  for (const leg of G5G_SUPPORT_LEGS) {
    const dir =
      leg === "import" ? join(root, "import", "fixture") : join(root, leg);
    const artifacts: string[] = [];
    for (const p of [
      "argv.txt",
      "env.txt",
      "stdout.log",
      "exit-code.txt",
      "steps.jsonl",
      "evidence/result.json",
      RECORDING_NAME,
    ])
      if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
    legs[LEG_NAMES[leg]] = {
      group: "g5g",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(dir),
      artifacts,
    };
  }

  // Receivers: full and patch sinks (success, pixel-identical to the reference), then the axis
  // sabotage on the full sink.
  const requested = (s: ReadonlyMap<number, number>) => [...s.values()];
  const receiverLeg = async (
    dirName: string,
    leg: string,
    recording: RecordingSummary,
    exp: Gate5LegExpectation,
  ) => {
    const dir = join(root, dirName);
    const seqs = settleSeqs(expected, recording);
    const shots = await loadReceiverShots5(dir, expected, seqs);
    const cps = computeGate5Checkpoints(
      expected,
      referenceDir,
      reference,
      dir,
      shots,
      seqs,
    );
    const cls = classifyLeg({
      captureResult: capture.captureResult,
      recording,
      receiver: {
        applied: await readJson<AppliedJson>(join(dir, "applied.json")),
        requestedShotSeqs: requested(seqs),
        shotFiles: await shotSeqsPresent5(dir),
      },
      checkpoints: cps,
    });
    const r = evaluateLegClass5(cls, cps, exp);
    legs[leg] = {
      group: "g5g",
      expected_class: exp.class,
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json")],
    };
    return {
      dir,
      shots,
      table: r.table,
      check: check(
        `leg-class-${leg}`,
        `the ${leg} leg classifies as ${exp.class}${exp.regions ? ` with mismatching regions exactly ${JSON.stringify(exp.regions)}` : " with every region of every shot matching the reference"}`,
        r.problems,
        `${cls.result_class}${
          Object.keys(r.table).length > 0
            ? `; mismatching regions per step ${Object.entries(r.table)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ")}`
            : ""
        }`,
        [join(dir, "applied.json")],
      ),
    };
  };
  const full = await receiverLeg(
    "receiver",
    RECEIVER_LEGS.receiver,
    capture.full,
    {
      class: "success",
    },
  );
  const patch = await receiverLeg(
    "receiver-patch",
    RECEIVER_LEGS["receiver-patch"],
    capture.patch,
    { class: "success" },
  );
  const sabotage = await receiverLeg(
    AXIS_SABOTAGE,
    AXIS_SABOTAGE_LEG,
    capture.full,
    {
      class: "pixel-mismatch",
      regions:
        expected.predictions["sabotage-style-receiver-ignore-axis"]?.regions ??
        {},
    },
  );
  const vsRef = compareLegs5(expected, reference, full.shots, rasters, [
    "reference-style",
    "receiver-style",
  ]);
  const vsRefPatch = compareLegs5(expected, reference, patch.shots, rasters, [
    "reference-style",
    "receiver-style-patch",
  ]);
  const imageReceiver = evaluateExpectedImage5(
    expected,
    "receiver-style",
    full.shots,
    rasters,
    join(full.dir, "shots"),
  );
  const presenceReceiver = evaluatePresence5(
    expected,
    "receiver-style",
    full.shots,
    rasters,
  );
  const ids = itemIdsByName(expected, capture.full).ids;
  // An invisible item has no derived scissor (deriveClipRects skips it).
  const hidden = new Set(expected.hidden_items ?? []);
  const visible: Gate5Expected = {
    ...expected,
    steps: expected.steps.map((s) => ({
      ...s,
      items: s.items.filter((i) => !hidden.has(i.name)),
    })),
  };
  const clipFull = evaluateClipRectsDerived(
    visible,
    "full",
    sinkStates(expected, capture.full),
    ids,
  );
  const dumps = await receiverStates(expected, patch.dir, capture.patch);
  const clipDumps = evaluateClipRectsDerived(
    visible,
    "receiver-style-patch state",
    dumps.states,
    ids,
  );
  checks.push(
    full.check,
    patch.check,
    check(
      "receiver-vs-reference-style",
      "receiver-style and receiver-style-patch: every pixel of every settle shot equals reference-style's, band and undecided pixels included (budget 0, as reference-style-repeat measured)",
      [...vsRef.problems, ...vsRefPatch.problems],
      `${expected.steps.length * 2} shots identical to the reference`,
      [join(full.dir, "shots"), join(patch.dir, "shots")],
    ),
    check(
      "expected-image-receiver-style",
      "every receiver-style settle shot equals the raster on every decided pixel, as the reference's does",
      imageReceiver.problems,
      `${imageReceiver.checkpoints.length} receiver shots match on ${imageReceiver.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels`,
      [join(full.dir, "shots")],
    ),
    check(
      "presence-receiver-style",
      "in every receiver-style shot, every sub-shape covers at least half its expected area",
      presenceReceiver.problems,
      `${presenceReceiver.shapes} shape-shots present`,
      [join(full.dir, "shots")],
    ),
    check(
      "clip-rects-derived-style",
      "deriveClipRects (D9, D10) over each settle state of the full sink and of receiver-style-patch's own state dumps gives every item expected.json's clip_px (RT's scissor, null elsewhere) and RT's clip-ignored commands exactly its focus box while focused; each dump equals the recording's resolved state",
      [
        ...clipFull.problems,
        ...dumps.problems.map((p) => `receiver-style-patch: ${p}`),
        ...clipDumps.problems,
      ],
      Object.entries(clipFull.table)
        .filter(([k]) => /@(0|3|4|9)$/.test(k))
        .map(([k, v]) => `${k} ${v}`)
        .join("; "),
      [capture.full.path, join(patch.dir, "state")],
    ),
    sabotage.check,
    fromGate0(
      await checkReceiverNeverLoadedFixture(root, {
        receiverProjectDir: ctx.receiverProjectDir ?? "",
        fixtureProjectDir: ctx.fixtureProjectDir ?? "",
        receiverLogs: g5gReceiverDirs().map((d) => join(root, d, "stdout.log")),
      }),
    ),
    await receiverTypedClean(root),
  );

  return {
    checks,
    legs,
    checkpoints: image.checkpoints,
    geometry: {
      hook_census: census.measured,
      steps: commandCensus(expected, capture.full),
      exactness: exactnessTable(expected, rasters),
    },
    budgets: repeatCmp.budgets,
    freshness: fresh.table,
  };
}
