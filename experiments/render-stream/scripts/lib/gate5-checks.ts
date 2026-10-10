// Gate 5 checks and leg classification (protocol/gate5-design.md "Q7", "G5b" and "G5d").
//
// Everything here reads an evidence directory written by run-gate5.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate5.ts can drive each check with synthetic
// values. Nothing launches a process. Classification never reads `session.sabotage`.
//
// Group g5b: the immediate-geometry fixture (fixtures/gate5). Its capture classified `unsupported`
// on render-stream/3 (every geometry op but add_rect typed); since G5d it runs on render-stream/4,
// where every op is a command, and the capture leg must classify `success` with every item's
// commands in the expected op order (group g5d checks their values). The pixels are checked against an
// independent model: make_expected.py's hand lowering of every RenderingServer call, rasterized by
// lib/geometry-raster.ts. Exact pixels must match exactly (delta 1 where colours interpolate or
// blend), band pixels (antialiased feathers, thin GL lines) must show presence, and a same-build
// reference repeat measures the budget every leg-to-leg comparison of a band uses (expected 0).
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 5"):
//   legs.json, binary.json
//   import/fixture/                editor --import of fixtures/gate5
//   capture/                       400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                  evidence/ (result, counters, resources.jsonl, ...),
//                                  recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                                  strace.txt, maps.txt
//   reference/, reference-repeat/  rendered fixture, extension absent: shots/step-<k>.png,
//                                  steps.jsonl
//   reference-armed/               rendered, extension armed with a full-sink stream: shots,
//                                  steps.jsonl, evidence/, recording.rs2, store/
// Group g5d (G5d) adds the receiver, sabotage and canvas-variant legs; their evaluators and
// layout are in lib/gate5d-checks.ts.

import { join } from "node:path";

import {
  decodePngRgba,
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
  firstTransactionWithRectColor,
  type Gate0Check,
  loadRecording,
  parseStepLog,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import {
  checkNoDrawIndexTies,
  checkPatchResolvesToFull,
  checkRecordingsDecode,
  evaluateCapture,
  type Gate3CaptureEvaluation,
  type Gate3Check,
  unsupportedOps,
} from "./gate3-checks";
import {
  type Box,
  type Gate5Expected,
  isShape,
  stepFrames5,
} from "./gate5-expected";
import {
  computeGate5Checkpoints,
  evaluateCaptureCanvas,
  evaluateClipRectsDerived,
  evaluateGeometryCommands,
  evaluateLegClass5,
  evaluateLoweringPredictions,
  expectedCommandsByStep,
  G5D_SABOTAGE_CAPTURE_KINDS,
  G5D_SABOTAGE_RECEIVER_KINDS,
  type Gate5LegExpectation,
  itemIdsByName,
  loadReceiverShots5,
  receiverStates,
  settleSeqs,
  shotSeqsPresent5,
  sinkStates,
} from "./gate5d-checks";
import {
  type Gate5Raster,
  meshTopology,
  rasterizeGate5,
} from "./geometry-raster";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture leg's quit frame, as gates 0-4 (the /proc maps/fd sample needs the time). */
export const G5B_CAPTURE_QUIT_FRAME = 400;

export type Gate5Check = Gate3Check;

export const ALL_GROUPS = ["g5b", "g5c", "g5d", "g5e", "g5f", "g5g"] as const;
/** Groups whose increment has landed; run-gate5.sh's LANDED_GROUPS must say the same. */
export const LANDED_GROUPS: readonly string[] = ["g5b", "g5c", "g5d"];

export const G5B_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;

/** The draw ops counters.json counts that gate 5's census accounts for (every other
 * canvas_item_add_* must stay 0 in this fixture). */
const DRAW_OP_PREFIX = "canvas_item_add_";

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);

export function check(
  id: string,
  criterion: string,
  problems: string[],
  okDetail: string,
  evidence: string[],
): Gate5Check {
  return {
    id,
    criterion,
    passed: problems.length === 0,
    status: problems.length === 0 ? "pass" : "fail",
    detail: problems.length === 0 ? okDetail : problems.join("; "),
    evidence,
  };
}

function fromGate0(c: Gate0Check): Gate5Check {
  return { ...c, status: c.passed ? "pass" : "fail" };
}

const _f32 = (v: number): number => Math.fround(v);

// ---------------------------------------------------------------------------------------------
// Shots and rasters
// ---------------------------------------------------------------------------------------------

export interface Frame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type Shots = Map<number, Frame | null>;

/** Every settle shot (step-<k>.png) of one leg, decoded (null when missing or unreadable). */
export async function loadShots5(
  outDir: string,
  leg: string,
  expected: Pick<Gate5Expected, "steps">,
): Promise<Shots> {
  const out: Shots = new Map();
  for (const s of expected.steps) {
    const png = await decodePngRgba(
      join(outDir, leg, "shots", `step-${s.step}.png`),
    );
    out.set(
      s.step,
      png ? { width: png.width, height: png.height, rgba: png.data } : null,
    );
  }
  return out;
}

export function shotPaths5(
  outDir: string,
  leg: string,
  expected: Pick<Gate5Expected, "steps">,
): string[] {
  return expected.steps.map((s) =>
    join(outDir, leg, "shots", `step-${s.step}.png`),
  );
}

/** One raster per step (rasterizeGate5), computed once per checker run. */
export function rastersOf(expected: Gate5Expected): Map<number, Gate5Raster> {
  const out = new Map<number, Gate5Raster>();
  for (const s of expected.steps)
    out.set(s.step, rasterizeGate5(expected, s.step));
  return out;
}

/** The region holding pixel (x, y), or "outside". */
export function regionAt(
  regions: Record<string, Box>,
  x: number,
  y: number,
): string {
  for (const [name, r] of Object.entries(regions))
    if (x >= r[0] && x < r[2] && y >= r[1] && y < r[3]) return name;
  return "outside";
}

function maxDelta(
  a: Uint8Array,
  ai: number,
  b: Uint8Array,
  bi: number,
): number {
  let d = 0;
  for (let c = 0; c < 4; c++)
    d = Math.max(d, Math.abs(a[ai * 4 + c] - b[bi * 4 + c]));
  return d;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

/** Pure: expected.json obeys its own rules (Q6c), recomputed here independently of
 * make_expected.py's asserts: 640x360, steps 0..last with distinct marker colours on the 0.2
 * grid; every colour component on the grid, alpha 1 except the `.6` blend polygon `T`; regions
 * disjoint and inside the viewport; every synthesized pixel outside the regions is the clear
 * colour; tie-freeness of every integer non-axis-aligned boundary edge of an exact mesh;
 * `hook_census` equals the sum of the steps' calls; `fresh` matches the raster (a region is fresh
 * exactly when its synthesized pixels, or the set of pixels it leaves undecided, change). */
export function checkExpectedSelfConsistent(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): Gate5Check {
  const problems: string[] = [];
  const [W, H] = expected.viewport;
  if (W !== 640 || H !== 360) problems.push(`viewport ${W}x${H}`);
  const last = expected.last_step;
  const steps = expected.steps.map((s) => s.step);
  if (JSON.stringify(steps) !== JSON.stringify([...Array(last + 1).keys()]))
    problems.push(`steps ${JSON.stringify(steps)} are not 0..${last}`);
  const markers = new Set(expected.steps.map((s) => s.marker_rgba8.join(",")));
  if (markers.size !== expected.steps.length)
    problems.push("marker colours are not distinct per step");
  for (const s of expected.steps)
    if (!s.marker_rgba8.every((c) => LEVELS.has(c)))
      problems.push(`step ${s.step}: marker ${s.marker_rgba8} off the grid`);
  const onGrid = (v: number) =>
    [0, 0.2, 0.4, 0.6, 0.8, 1].some((g) => Math.abs(v - g) < 5e-4);
  let tieEdges = 0;
  for (const [key, ops] of Object.entries(expected.op_lists))
    for (const op of ops) {
      if (!isShape(op)) continue;
      const colours = op.kind === "nine_patch" ? [op.modulate] : op.colors;
      for (const c of colours) {
        if (!c.slice(0, 3).every(onGrid))
          problems.push(`${key}/${op.name}: colour ${c} off the 0.2 grid`);
        const alphaOk =
          Math.abs(c[3] - 1) < 1e-6 ||
          (op.name === "T" && Math.abs(c[3] - 0.6) < 5e-4);
        if (!alphaOk) problems.push(`${key}/${op.name}: alpha ${c[3]}`);
      }
    }
  for (const [name, t] of Object.entries(expected.textures))
    for (let i = 0; i < t.rgba8_hex.length; i += 2)
      if (!LEVELS.has(Number.parseInt(t.rgba8_hex.slice(i, i + 2), 16))) {
        problems.push(`texture ${name}: texel byte off the grid at ${i / 2}`);
        break;
      }
  const names = Object.keys(expected.regions);
  for (let i = 0; i < names.length; i++) {
    const a = expected.regions[names[i]];
    if (
      !(
        0 <= a[0] &&
        a[0] < a[2] &&
        a[2] <= W &&
        0 <= a[1] &&
        a[1] < a[3] &&
        a[3] <= H
      )
    )
      problems.push(`region ${names[i]} ${a} is not inside the viewport`);
    for (let j = i + 1; j < names.length; j++) {
      const b = expected.regions[names[j]];
      if (!(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]))
        problems.push(`regions ${names[i]} and ${names[j]} overlap`);
    }
  }
  // Tie-freeness (D13) over every step's items in canvas pixels.
  for (const s of expected.steps)
    for (const item of s.items) {
      let draw = [1, 0, 0, 1, 0, 0];
      for (const op of expected.op_lists[item.ops] ?? []) {
        if (!isShape(op)) {
          if (op.op === "set_transform") draw = [...op.transform];
          continue;
        }
        if (op.kind !== "mesh" || op.band_px !== undefined) continue;
        const m = [
          item.xform[0] * draw[0] + item.xform[2] * draw[1],
          item.xform[1] * draw[0] + item.xform[3] * draw[1],
          item.xform[0] * draw[2] + item.xform[2] * draw[3],
          item.xform[1] * draw[2] + item.xform[3] * draw[3],
          item.xform[0] * draw[4] + item.xform[2] * draw[5] + item.xform[4],
          item.xform[1] * draw[4] + item.xform[3] * draw[5] + item.xform[5],
        ];
        const verts = op.vertices.map(
          (v) =>
            [
              m[0] * v[0] + m[2] * v[1] + m[4],
              m[1] * v[0] + m[3] * v[1] + m[5],
            ] as [number, number],
        );
        for (const [a, b] of meshTopology(verts, op.triangles).boundary) {
          const [x0, y0] = verts[a];
          const [x1, y1] = verts[b];
          if (x0 === x1 || y0 === y1) continue;
          if (![x0, y0, x1, y1].every(Number.isInteger)) continue;
          tieEdges++;
          if ((Math.abs(x1 - x0) + Math.abs(y1 - y0)) % 2 !== 1)
            problems.push(
              `step ${s.step} ${item.name}/${op.name}: boundary edge (${x0},${y0})-(${x1},${y1}) has even dx+dy (a pixel centre lies on it)`,
            );
        }
      }
    }
  if (tieEdges !== expected.tie_free_edges_checked)
    problems.push(
      `${tieEdges} integer non-axis boundary edges, make_expected.py checked ${expected.tie_free_edges_checked}`,
    );
  // The census columns.
  const census: Record<string, number> = {};
  for (const s of expected.steps)
    for (const calls of Object.values(s.calls))
      for (const c of calls) census[c.op] = (census[c.op] ?? 0) + 1;
  const sortObj = (o: Record<string, number>) =>
    JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (sortObj(census) !== sortObj(expected.hook_census))
    problems.push(
      `hook_census ${sortObj(expected.hook_census)} != the steps' calls ${sortObj(census)}`,
    );
  // The raster: nothing outside the regions, and `fresh` as the pixels say.
  for (const s of expected.steps) {
    const r = rasters.get(s.step);
    if (!r) continue;
    let outside = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (regionAt(expected.regions, x, y) !== "outside") continue;
        const i = y * W + x;
        if (
          !r.exact[i] ||
          r.rgba[i * 4] !== expected.clear_rgba8[0] ||
          r.rgba[i * 4 + 1] !== expected.clear_rgba8[1] ||
          r.rgba[i * 4 + 2] !== expected.clear_rgba8[2]
        )
          outside++;
      }
    if (outside > 0)
      problems.push(
        `step ${s.step}: ${outside} synthesized pixels outside every region are not the clear colour`,
      );
    if (s.step === 0) continue;
    const prev = rasters.get(s.step - 1);
    if (!prev) continue;
    for (const [name, box] of Object.entries(expected.regions)) {
      let changed = false;
      for (let y = box[1]; y < box[3] && !changed; y++)
        for (let x = box[0]; x < box[2] && !changed; x++) {
          const i = y * W + x;
          if (
            r.exact[i] !== prev.exact[i] ||
            maxDelta(r.rgba, i, prev.rgba, i) > 0
          )
            changed = true;
        }
      if (changed !== s.fresh[name])
        problems.push(
          `step ${s.step}: ${name} fresh=${s.fresh[name]} but its synthesized pixels ${changed ? "change" : "do not change"}`,
        );
    }
  }
  return check(
    "expected-self-consistent",
    `expected.json obeys its rules (gate5-design.md Q6c): 640x360, steps 0..${last} with distinct grid marker colours; every colour on the 0.2 grid with alpha 1 (the blend polygon .6); regions disjoint and nothing synthesized outside them; every integer non-axis boundary edge of an exact mesh tie-free (dx + dy odd); hook_census equals the steps' calls; fresh agrees with the raster`,
    problems,
    `${expected.steps.length} steps, ${Object.keys(expected.op_lists).length} op lists, ${tieEdges} tie-free edges, census ${Object.values(expected.hook_census).reduce((a, b) => a + b, 0)} calls`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// step-alignment
// ---------------------------------------------------------------------------------------------

export async function checkStepAlignment5(
  outDir: string,
  expected: Gate5Expected,
  recording: RecordingSummary,
): Promise<Gate5Check> {
  const want: StepLine[] = expected.steps.map((s) => {
    const f = stepFrames5(expected, s.step);
    return { step: s.step, applied_frame: f.applied, settle_frame: f.settle };
  });
  const problems: string[] = [];
  const paths: string[] = [];
  for (const leg of [
    "capture",
    "reference",
    "reference-repeat",
    "reference-armed",
  ]) {
    const path = join(outDir, leg, "steps.jsonl");
    paths.push(path);
    const got = parseStepLog(await readTextOrUndefined(path));
    if (JSON.stringify(got) !== JSON.stringify(want))
      problems.push(`${leg} steps.jsonl ${JSON.stringify(got)} != expected`);
  }
  const firsts: string[] = [];
  for (const s of expected.steps) {
    const t = firstTransactionWithRectColor(
      recording.transactions,
      s.marker_rgba8.map((c) => c / 255),
    );
    const applied = stepFrames5(expected, s.step).applied;
    firsts.push(`${s.step}@${t?.meta.frame ?? "none"}`);
    if (t?.meta.frame !== applied)
      problems.push(
        `step ${s.step}: marker colour first published at frame ${t?.meta.frame ?? "<none>"}, expected ${applied}`,
      );
  }
  return check(
    "step-alignment",
    `capture and every reference steps.jsonl list steps 0..${expected.last_step} at S+N*k (settle +7), and each step's marker colour first appears in the capture transaction of its applied frame`,
    problems,
    `marker colours first published at ${firsts.join(", ")}`,
    [...paths, recording.path],
  );
}

// ---------------------------------------------------------------------------------------------
// geometry-hook-census
// ---------------------------------------------------------------------------------------------

export interface CountersLike {
  counts?: Record<string, number>;
  hooks_planned?: string[];
}

/** Pure: counters.json counts per draw op equal expected.json hook_census over the run (one call
 * per item redraw). An op whose hook the calibration record does not plan (add_multiline before
 * calibrator 7) must be absent from `counts` and is reported unhooked; every other
 * canvas_item_add_* count must be 0; texture_2d_create counts the engine's own textures plus
 * TEX16 and TEX9. */
export function evaluateGeometryHookCensus(
  expected: Pick<Gate5Expected, "hook_census" | "engine_textures" | "textures">,
  counters: CountersLike | undefined,
): {
  problems: string[];
  measured: Record<string, number | "unhooked">;
  unhooked: string[];
} {
  const problems: string[] = [];
  const measured: Record<string, number | "unhooked"> = {};
  const unhooked: string[] = [];
  if (!counters?.counts || !counters.hooks_planned) {
    problems.push("counters.json missing counts or hooks_planned");
    return { problems, measured, unhooked };
  }
  const counts = counters.counts;
  const planned = new Set(counters.hooks_planned);
  for (const [op, want] of Object.entries(expected.hook_census)) {
    if (!planned.has(op)) {
      measured[op] = "unhooked";
      unhooked.push(op);
      if (op in counts)
        problems.push(
          `${op} is not a planned hook but counters.json counts it (${counts[op]})`,
        );
      continue;
    }
    const got = counts[op];
    measured[op] = got ?? 0;
    if (got !== want)
      problems.push(`${op}: ${got ?? "absent"} calls, expected ${want}`);
  }
  for (const [op, n] of Object.entries(counts))
    if (
      op.startsWith(DRAW_OP_PREFIX) &&
      !(op in expected.hook_census) &&
      n !== 0
    )
      problems.push(`${op}: ${n} calls, expected none in this fixture`);
  const textures =
    expected.engine_textures.length + Object.keys(expected.textures).length;
  measured.texture_2d_create = counts.texture_2d_create ?? 0;
  if (counts.texture_2d_create !== textures)
    problems.push(
      `texture_2d_create: ${counts.texture_2d_create ?? "absent"}, expected ${textures} (the engine's hue strip, TEX16, TEX9)`,
    );
  return { problems, measured, unhooked };
}

export async function checkGeometryHookCensus(
  outDir: string,
  expected: Gate5Expected,
): Promise<{
  check: Gate5Check;
  measured: Record<string, number | "unhooked">;
}> {
  const path = join(outDir, "capture", "evidence", "counters.json");
  const counters = await readJson<CountersLike>(path);
  const r = evaluateGeometryHookCensus(expected, counters);
  return {
    check: check(
      "geometry-hook-census",
      "the capture's counters.json counts per geometry op equal expected.json hook_census over the run (one call per item redraw); ops the calibration record does not hook yet are reported, every other draw op is 0, and texture_2d_create counts the hue strip, TEX16 and TEX9",
      r.problems,
      `${Object.entries(r.measured)
        .map(([op, n]) => `${op.replace(DRAW_OP_PREFIX, "")} ${n}`)
        .join(", ")}`,
      [path],
    ),
    measured: r.measured,
  };
}

// ---------------------------------------------------------------------------------------------
// leg-class-capture: success on render-stream/4 (G5d; `unsupported` with every op typed on /3)
// ---------------------------------------------------------------------------------------------

/** Pure: the capture classifies `success` on render-stream/4: no unsupported entry or command
 * (draw-index ties aside), and at every settle frame each fixture item's commands carry exactly
 * its expected calls' /4 ops, in call order (group g5d's geometry-commands compares the values). */
export function evaluateCaptureLegClass5(
  expected: Gate5Expected,
  capture: Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full">,
): { problems: string[]; ops: string[] } {
  const problems: string[] = [];
  if (capture.result_class !== "success")
    problems.push(
      `class ${capture.result_class}, expected success: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const unsupported = unsupportedOps(capture.full);
  if (unsupported.length > 0)
    problems.push(`the recording carries unsupported ${unsupported.join(",")}`);
  const ids = itemIdsByName(expected, capture.full);
  problems.push(...ids.problems);
  const byStep = expectedCommandsByStep(expected, new Map());
  const ops = new Set<string>();
  for (const s of expected.steps) {
    const t = capture.full.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    if (!t) {
      problems.push(
        `step ${s.step}: no transaction at frame ${s.settle_frame}`,
      );
      continue;
    }
    for (const [name, want] of byStep.get(s.step) ?? []) {
      const item = t.meta.items.find((i) => i.id === ids.ids.get(name));
      const got = (item?.commands ?? []).map((c) => c.op);
      for (const op of got) ops.add(op);
      const wantOps = want.map((w) => w.command?.op ?? `?${w.call.op}`);
      if (JSON.stringify(got) !== JSON.stringify(wantOps))
        problems.push(
          `step ${s.step} ${name}: ops ${got.join(",")} != ${wantOps.join(",")}`,
        );
    }
  }
  return { problems, ops: [...ops].sort() };
}

export function checkCaptureLegClass5(
  expected: Gate5Expected,
  capture: Gate3CaptureEvaluation,
): Gate5Check {
  const r = evaluateCaptureLegClass5(expected, capture);
  return check(
    "leg-class-capture",
    "the capture leg classifies as success on render-stream/4 (unsupported, every geometry op typed, on /3 before G5d): armed, stream closed, both sinks valid and equivalent, no capture failure, no unsupported entry or command, and at every settle frame each item's commands carry exactly its expected calls' /4 ops in call order",
    r.problems,
    `${capture.result_class}: ${r.ops.join(", ")}${capture.harmless_ties.length > 0 ? ` (${capture.harmless_ties.length} harmless tie entries)` : ""}`,
    capture.artifacts,
  );
}

// ---------------------------------------------------------------------------------------------
// expected-image, presence, freshness
// ---------------------------------------------------------------------------------------------

export interface Gate5Checkpoint {
  leg: string;
  step: number;
  shot: string;
  /** decided pixels compared with the raster */
  compared: number | null;
  /** decided pixels beyond their allowed delta */
  mismatched_pixels: number | null;
  max_channel_delta: number | null;
  /** delta-1-class pixels that actually differ by 1 */
  delta1_used: number | null;
  /** mismatching pixels per region */
  regions: Record<string, number>;
}

/** Pure: each shot against its step's raster on every decided pixel. */
export function evaluateExpectedImage5(
  expected: Gate5Expected,
  leg: string,
  shots: Shots,
  rasters: Map<number, Gate5Raster>,
  shotDir = "",
): { problems: string[]; checkpoints: Gate5Checkpoint[] } {
  const problems: string[] = [];
  const checkpoints: Gate5Checkpoint[] = [];
  for (const s of expected.steps) {
    const shot = shots.get(s.step);
    const r = rasters.get(s.step);
    const path = join(shotDir, `step-${s.step}.png`);
    if (!shot || !r) {
      problems.push(`${leg} step-${s.step}.png missing or unreadable`);
      checkpoints.push({
        leg,
        step: s.step,
        shot: path,
        compared: null,
        mismatched_pixels: null,
        max_channel_delta: null,
        delta1_used: null,
        regions: {},
      });
      continue;
    }
    if (shot.width !== r.width || shot.height !== r.height) {
      problems.push(
        `${leg} step-${s.step}.png is ${shot.width}x${shot.height}`,
      );
      continue;
    }
    let compared = 0;
    let mismatched = 0;
    let maxD = 0;
    let used = 0;
    const regions: Record<string, number> = {};
    const examples: string[] = [];
    for (let i = 0; i < r.width * r.height; i++) {
      if (!r.exact[i]) continue;
      compared++;
      const d = maxDelta(shot.rgba, i, r.rgba, i);
      if (d > 0 && d <= r.delta[i]) used++;
      if (d <= r.delta[i]) continue;
      mismatched++;
      maxD = Math.max(maxD, d);
      const x = i % r.width;
      const y = Math.floor(i / r.width);
      const g = regionAt(expected.regions, x, y);
      regions[g] = (regions[g] ?? 0) + 1;
      if (examples.length < 3)
        examples.push(
          `(${x},${y}) ${[...shot.rgba.subarray(i * 4, i * 4 + 4)]} vs ${[...r.rgba.subarray(i * 4, i * 4 + 4)]}`,
        );
    }
    checkpoints.push({
      leg,
      step: s.step,
      shot: path,
      compared,
      mismatched_pixels: mismatched,
      max_channel_delta: maxD,
      delta1_used: used,
      regions,
    });
    if (mismatched > 0)
      problems.push(
        `${leg} step ${s.step}: ${mismatched} decided pixels differ from the raster (max delta ${maxD}; ${Object.entries(
          regions,
        )
          .map(([g, n]) => `${g} ${n}`)
          .join(", ")}; e.g. ${examples.join(", ")})`,
      );
  }
  return { problems, checkpoints };
}

/** Pure: every sub-shape (band included) covers at least half its expected area with pixels that
 * differ from what lies beneath it in the raster, in every shot. */
export function evaluatePresence5(
  expected: Gate5Expected,
  leg: string,
  shots: Shots,
  rasters: Map<number, Gate5Raster>,
): { problems: string[]; shapes: number } {
  const problems: string[] = [];
  let shapes = 0;
  for (const s of expected.steps) {
    const shot = shots.get(s.step);
    const r = rasters.get(s.step);
    if (!shot || !r) {
      problems.push(`${leg} step-${s.step}.png missing or unreadable`);
      continue;
    }
    for (const c of r.shapes) {
      if (c.covered === 0) continue;
      shapes++;
      let present = 0;
      c.area.forEach((i, k) => {
        for (let ch = 0; ch < 4; ch++)
          if (shot.rgba[i * 4 + ch] !== c.underlay[k * 4 + ch]) {
            present++;
            return;
          }
      });
      if (present * 2 < c.covered)
        problems.push(
          `${leg} step ${s.step} ${c.item}/${c.shape}: ${present} pixels present, expected at least ${Math.ceil(c.covered / 2)} of ${c.covered}`,
        );
    }
  }
  return { problems, shapes };
}

/** Pure: a region differs from the previous step's shot exactly when expected.json says fresh. */
export function evaluateFreshness5(
  expected: Gate5Expected,
  leg: string,
  shots: Shots,
): { problems: string[]; table: Record<string, string[]> } {
  const problems: string[] = [];
  const table: Record<string, string[]> = {};
  for (const s of expected.steps) {
    if (s.step === 0) continue;
    const a = shots.get(s.step - 1);
    const b = shots.get(s.step);
    if (!a || !b) {
      problems.push(`${leg} step ${s.step}: shot missing`);
      continue;
    }
    const changed: string[] = [];
    for (const [name, box] of Object.entries(expected.regions)) {
      let differs = false;
      for (let y = box[1]; y < box[3] && !differs; y++)
        for (let x = box[0]; x < box[2] && !differs; x++) {
          const i = y * b.width + x;
          if (maxDelta(a.rgba, i, b.rgba, i) > 0) differs = true;
        }
      if (differs) changed.push(name);
      if (differs !== s.fresh[name])
        problems.push(
          `${leg} step ${s.step}: ${name} ${differs ? "changed" : "did not change"}, expected fresh=${s.fresh[name]}`,
        );
    }
    table[String(s.step)] = changed;
  }
  return { problems, table };
}

// ---------------------------------------------------------------------------------------------
// Leg against leg: reference-repeat-budget, armed-transparent
// ---------------------------------------------------------------------------------------------

export const PIXEL_CLASSES = ["exact", "delta1", "band", "undecided"] as const;
export type PixelClass = (typeof PIXEL_CLASSES)[number];

export interface RegionBudget5 {
  region: string;
  class: PixelClass;
  /** pixels of this class in this region, summed over the shots */
  pixels: number;
  max_channel_delta: number;
  mismatched_pixels: number;
}

export function pixelClass(r: Gate5Raster, i: number): PixelClass {
  if (r.exact[i]) return r.delta[i] > 0 ? "delta1" : "exact";
  return r.band[i] ? "band" : "undecided";
}

/** Pure: `b` against `a`, shot by shot, per region (and `outside`) and pixel class. Any
 * difference is a problem: legs of one build on one GPU must agree everywhere (the budget is
 * whatever this measures; D13 expects 0). */
export function compareLegs5(
  expected: Gate5Expected,
  a: Shots,
  b: Shots,
  rasters: Map<number, Gate5Raster>,
  labels: [string, string],
): { problems: string[]; budgets: RegionBudget5[] } {
  const problems: string[] = [];
  const cells = new Map<string, RegionBudget5>();
  const [W, H] = expected.viewport;
  const regionOf = new Array<string>(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      regionOf[y * W + x] = regionAt(expected.regions, x, y);
  for (const s of expected.steps) {
    const fa = a.get(s.step);
    const fb = b.get(s.step);
    const r = rasters.get(s.step);
    if (!fa || !fb || !r) {
      problems.push(
        `step ${s.step}: ${!fa ? labels[0] : labels[1]} shot missing`,
      );
      continue;
    }
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const key = `${regionOf[i]}/${pixelClass(r, i)}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          region: regionOf[i],
          class: pixelClass(r, i),
          pixels: 0,
          max_channel_delta: 0,
          mismatched_pixels: 0,
        };
        cells.set(key, cell);
      }
      cell.pixels++;
      const d = maxDelta(fa.rgba, i, fb.rgba, i);
      if (d === 0) continue;
      n++;
      cell.mismatched_pixels++;
      cell.max_channel_delta = Math.max(cell.max_channel_delta, d);
    }
    if (n > 0)
      problems.push(
        `step ${s.step}: ${n} pixels differ between ${labels[0]} and ${labels[1]}`,
      );
  }
  const order = [...Object.keys(expected.regions), "outside"];
  const budgets = [...cells.values()].sort(
    (x, y) =>
      order.indexOf(x.region) - order.indexOf(y.region) ||
      PIXEL_CLASSES.indexOf(x.class) - PIXEL_CLASSES.indexOf(y.class),
  );
  return { problems, budgets };
}

// ---------------------------------------------------------------------------------------------
// Report and orchestration
// ---------------------------------------------------------------------------------------------

export interface Gate5Report {
  schema: "render-stream-gate5-report/1";
  generated_at: string;
  binary: { path: string | null; sha256: string | null };
  gate_passed: boolean;
  groups: { run: string[]; landed: string[]; not_run: string[] };
  legs: Record<
    string,
    {
      group: string;
      expected_class: string | null;
      result_class: string | null;
      reasons: string[];
      harmless_ties?: string[];
      exit_code: number | null;
      artifacts: string[];
    }
  >;
  checks: Gate5Check[];
  checkpoints: Gate5Checkpoint[];
  /** per fixture: the hook census as measured and per step the capture's commands per op */
  geometry: Record<
    string,
    {
      hook_census: Record<string, number | "unhooked">;
      steps: Record<string, Record<string, number>>;
      exactness: Record<string, Record<PixelClass, number>>;
    }
  > | null;
  /** per mesh id (G5c/G5e); null until then */
  meshes: Record<string, unknown> | null;
  /** G5d: the /4 commands compared, lowering counts, scissors, receiver budgets and the
   * mismatching regions of each sabotage leg, per step */
  g5d: {
    commands_compared: number;
    commands_within_ulp: number;
    lowering: Record<string, string>;
    clip_rects: Record<string, string>;
    receiver_budgets: Record<string, RegionBudget5[]>;
    sabotage_regions: Record<string, Record<string, string>>;
    canvas_entries: string[];
  } | null;
  /** per fixture: reference vs reference-repeat per region and pixel class, every shot */
  budgets: Record<string, RegionBudget5[]> | null;
  /** per fixture: per step, the regions whose reference pixels changed */
  freshness: Record<string, Record<string, string[]>> | null;
}

export interface Gate5Context {
  expected: Gate5Expected;
  now?: Date;
  /** absolute receiver/ and fixtures/gate5/ (g5d's receiver-never-loaded-fixture) */
  receiverProjectDir?: string;
  fixtureProjectDir?: string;
}

function notRunCheck(group: string, detail: string): Gate5Check {
  return {
    id: `group-${group}`,
    criterion: `leg group ${group} ran`,
    passed: false,
    status: "not-run",
    detail,
    evidence: [],
  };
}

async function supportLeg(
  outDir: string,
  leg: (typeof G5B_SUPPORT_LEGS)[number],
) {
  const dir =
    leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg);
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
  return {
    group: "g5b",
    expected_class: null,
    result_class: null,
    reasons: [] as string[],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

async function checkSupportLegsExit(outDir: string): Promise<Gate5Check> {
  const problems: string[] = [];
  for (const leg of G5B_SUPPORT_LEGS) {
    const code = await readExitCode(
      leg === "import" ? join(outDir, "import", "fixture") : join(outDir, leg),
    );
    if (code !== 0) problems.push(`${leg} exit ${code ?? "<none>"}`);
  }
  return check(
    "support-legs-exit",
    "the import, reference, reference-repeat and reference-armed legs exited 0",
    problems,
    `${G5B_SUPPORT_LEGS.length} support legs exited 0`,
    G5B_SUPPORT_LEGS.map((l) =>
      join(outDir, l === "import" ? "import/fixture" : l, "exit-code.txt"),
    ),
  );
}

export async function readGroups(
  outDir: string,
): Promise<{ run: string[]; landed: string[] }> {
  const legs = await readJson<{ groups_run?: string[] }>(
    join(outDir, "legs.json"),
  );
  return { run: legs?.groups_run ?? [], landed: [...LANDED_GROUPS] };
}

/** Per step, the capture's resolved commands per op (unsupported ones by name), over the items. */
function commandCensus(
  expected: Gate5Expected,
  full: RecordingSummary,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of expected.steps) {
    const t = full.transactions.find((x) => x.meta.frame === s.settle_frame);
    const counts: Record<string, number> = {};
    for (const item of t?.meta.items ?? [])
      for (const c of item.commands) {
        const key = c.op === "unsupported" ? (c.name ?? "?") : c.op;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    out[String(s.step)] = counts;
  }
  return out;
}

function exactnessTable(
  expected: Gate5Expected,
  rasters: Map<number, Gate5Raster>,
): Record<string, Record<PixelClass, number>> {
  const out: Record<string, Record<PixelClass, number>> = {};
  for (const s of expected.steps) {
    const r = rasters.get(s.step);
    if (!r) continue;
    const row: Record<PixelClass, number> = {
      exact: 0,
      delta1: 0,
      band: 0,
      undecided: 0,
    };
    for (let i = 0; i < r.width * r.height; i++) row[pixelClass(r, i)]++;
    out[String(s.step)] = row;
  }
  return out;
}

export async function runGate5(
  outDir: string,
  ctx: Gate5Context,
): Promise<Gate5Report> {
  const groups = await readGroups(outDir);
  const notRun = groups.landed.filter((g) => !groups.run.includes(g));
  const expected = ctx.expected;
  const rasters = rastersOf(expected);
  const checks: Gate5Check[] = [checkExpectedSelfConsistent(expected, rasters)];
  const legs: Gate5Report["legs"] = {};
  let checkpoints: Gate5Checkpoint[] = [];
  let geometry: Gate5Report["geometry"] = null;
  let budgets: Gate5Report["budgets"] = null;
  let freshness: Gate5Report["freshness"] = null;

  if (groups.run.includes("g5b")) {
    const capture = await evaluateCapture(outDir, {
      expectedClass: "success",
    });
    const reference = await loadShots5(outDir, "reference", expected);
    const repeat = await loadShots5(outDir, "reference-repeat", expected);
    const armed = await loadShots5(outDir, "reference-armed", expected);

    const image = evaluateExpectedImage5(
      expected,
      "reference",
      reference,
      rasters,
      join(outDir, "reference", "shots"),
    );
    checkpoints = image.checkpoints;
    const presence = evaluatePresence5(
      expected,
      "reference",
      reference,
      rasters,
    );
    const fresh = evaluateFreshness5(expected, "reference", reference);
    const repeatCmp = compareLegs5(expected, reference, repeat, rasters, [
      "reference",
      "reference-repeat",
    ]);
    const armedCmp = compareLegs5(expected, reference, armed, rasters, [
      "reference",
      "reference-armed",
    ]);
    const armedResult = await readJson<CaptureResultJson>(
      join(outDir, "reference-armed", "evidence", "result.json"),
    );
    if (armedResult?.status !== "armed")
      armedCmp.problems.unshift(
        `reference-armed result.json status=${JSON.stringify(armedResult?.status)}`,
      );
    if (armedResult?.stream?.status !== "closed")
      armedCmp.problems.unshift(
        `reference-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
      );
    const census = await checkGeometryHookCensus(outDir, expected);
    const bandBudgets = repeatCmp.budgets.filter(
      (b) => b.class === "band" || b.class === "undecided",
    );

    checks.push(
      fromGate0(
        await checkCaptureArmed(outDir, {
          captureResult: capture.captureResult,
          recording: capture.full,
        }),
      ),
      fromGate0(await checkHeadlessNoGpuGate0(outDir)),
      checkRecordingsDecode(capture.full, capture.patch),
      checkPatchResolvesToFull(capture.full, capture.patch),
      await checkStepAlignment5(outDir, expected, capture.full),
      checkNoDrawIndexTies(capture.full).check,
      census.check,
      check(
        "expected-image-reference",
        "every reference shot (step-<k>.png at each settle frame) equals rasterizeGate5(k) on every decided pixel: exactly where the geometry is flat and decided at least 1/16 px from every boundary edge, within 1 where colours interpolate or blend (D13); band and undecided pixels are left out",
        image.problems,
        `${image.checkpoints.length} reference shots match on ${image.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels (${image.checkpoints.reduce((n, c) => n + (c.delta1_used ?? 0), 0)} used their delta of 1)`,
        shotPaths5(outDir, "reference", expected),
      ),
      check(
        "presence-reference",
        "in every reference shot, every sub-shape (band included) covers at least half its expected area with pixels differing from what the raster has beneath it",
        presence.problems,
        `${presence.shapes} shape-shots present`,
        shotPaths5(outDir, "reference", expected),
      ),
      check(
        "freshness-reference",
        "between consecutive reference shots a region changes exactly when expected.json says fresh (an argument change re-records and repaints; Line2D.antialiased changes nothing; a move or the canvas transform repaints without a redraw)",
        fresh.problems,
        Object.entries(fresh.table)
          .map(([k, r]) => `${k}:${r.join("+")}`)
          .join(" "),
        shotPaths5(outDir, "reference", expected),
      ),
      check(
        "reference-repeat-budget",
        "reference vs reference-repeat (same build, GPU and driver): identical at every pixel of every shot -- the band budget is what this measures (D13 expects 0); maxima per region and pixel class are reported",
        repeatCmp.problems,
        `budget 0: ${expected.steps.length} shot pairs identical; band/undecided pixels per region: ${bandBudgets
          .filter((b) => b.pixels > 0)
          .map(
            (b) =>
              `${b.region} ${b.class} ${b.max_channel_delta}/${b.pixels}px`,
          )
          .join(", ")}`,
        [
          ...shotPaths5(outDir, "reference", expected),
          ...shotPaths5(outDir, "reference-repeat", expected),
        ],
      ),
      check(
        "armed-transparent",
        "reference-armed (extension armed, stream on) armed with its stream closed, and every shot equals the reference's exactly: the hooks forward untouched",
        armedCmp.problems,
        `${expected.steps.length} armed shots byte-identical to the reference`,
        shotPaths5(outDir, "reference-armed", expected),
      ),
      await checkSupportLegsExit(outDir),
      checkCaptureLegClass5(expected, capture),
    );
    legs.capture = {
      group: "g5b",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    };
    for (const leg of G5B_SUPPORT_LEGS)
      legs[leg] = await supportLeg(outDir, leg);
    geometry = {
      [expected.fixture]: {
        hook_census: census.measured,
        steps: commandCensus(expected, capture.full),
        exactness: exactnessTable(expected, rasters),
      },
    };
    budgets = { [expected.fixture]: repeatCmp.budgets };
    freshness = { [expected.fixture]: fresh.table };
  } else {
    checks.push(
      notRunCheck("g5b", "g5b was not in --legs; its checks are not-run"),
    );
  }

  let g5d: Gate5Report["g5d"] = null;
  if (groups.run.includes("g5d")) {
    const r = await runG5d(outDir, ctx, rasters, legs);
    checks.push(...r.checks);
    g5d = r.report;
  }

  for (const group of notRun)
    if (group !== "g5b")
      checks.push(notRunCheck(group, `${group} was not in --legs`));

  const binary = await readJson<{ path?: string; sha256?: string }>(
    join(outDir, "binary.json"),
  );
  return {
    schema: "render-stream-gate5-report/1",
    generated_at: (ctx.now ?? new Date()).toISOString(),
    binary: { path: binary?.path ?? null, sha256: binary?.sha256 ?? null },
    gate_passed:
      checks.length > 1 &&
      checks.every((c) => c.status === "pass") &&
      notRun.length === 0,
    groups: { run: groups.run, landed: groups.landed, not_run: notRun },
    legs,
    checks,
    checkpoints,
    geometry,
    meshes: null,
    g5d,
    budgets,
    freshness,
  };
}

// ---------------------------------------------------------------------------------------------
// Group g5d (G5d): render-stream/4 end to end
// ---------------------------------------------------------------------------------------------

/** Every g5d receiver-bearing leg directory, relative to the run. */
export function g5dReceiverDirs(): string[] {
  return [
    "receiver",
    "receiver-patch",
    "receiver-headless-trace",
    ...G5D_SABOTAGE_CAPTURE_KINDS.map((k) => `sabotage-${k}/receiver`),
    ...G5D_SABOTAGE_RECEIVER_KINDS.map((k) => `sabotage-receiver-${k}`),
  ];
}

/** gate 1's receiver-typed-clean, as gate 3 adapts it: every g5d receiver leg's stdout.log is
 * free of SCRIPT ERROR, SCRIPT WARNING, Parse Error and Failed to load script lines. */
async function checkReceiverTypedClean5(outDir: string): Promise<Gate5Check> {
  const bad = /SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  const problems: string[] = [];
  const paths = g5dReceiverDirs().map((d) => join(outDir, d, "stdout.log"));
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
    "receiver-typed-clean",
    "no g5d receiver leg's stdout.log has a SCRIPT ERROR, SCRIPT WARNING, Parse Error or Failed to load script line",
    problems,
    `${paths.length} receiver logs clean`,
    paths,
  );
}

async function runG5d(
  outDir: string,
  ctx: Gate5Context,
  rasters: Map<number, Gate5Raster>,
  legs: Gate5Report["legs"],
): Promise<{ checks: Gate5Check[]; report: NonNullable<Gate5Report["g5d"]> }> {
  const expected = ctx.expected;
  const checks: Gate5Check[] = [];
  const capture = await evaluateCapture(outDir, { expectedClass: "success" });
  const referenceDir = join(outDir, "reference");
  const reference = await loadShots5(outDir, "reference", expected);
  const seqs = settleSeqs(expected, capture.full);
  const patchSeqs = settleSeqs(expected, capture.patch);
  const requested = (s: ReadonlyMap<number, number>) => [...s.values()];

  // geometry-commands and lowering-predictions on the capture (D12 (1), (5)).
  const geometry = evaluateGeometryCommands(expected, [
    { label: "full", recording: capture.full },
    { label: "patch", recording: capture.patch },
  ]);
  const lowering = evaluateLoweringPredictions(expected, capture.full);
  checks.push(
    check(
      "geometry-commands",
      "at every settle frame of both sinks, each fixture item's /4 commands equal expected.json's calls argument for argument and in order -- set_transform and clip_ignore included: passthrough arguments float32-exact, computed ones (ulp: 2) within 2 ulp; texture names map to the capture's wire ids",
      geometry.problems,
      `${geometry.compared} commands equal (${geometry.ulpUsed} used their 2-ulp allowance)`,
      [capture.full.path, capture.patch.path],
    ),
    check(
      "lowering-predictions",
      "on the capture, Line2D is one triangle array of the predicted vertex/index/colour/UV counts and count -1, the dashed line one multiline of 16 points, the unfilled rect and circle closed polylines of 5 and 65 points, at every settle frame; L2's command is identical across step 3 although it redraws (Line2D.antialiased is unused)",
      lowering.problems,
      Object.entries(lowering.measured)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
      [capture.full.path],
    ),
  );

  // Receivers on the main capture (full and patch sinks).
  const receiverDir = join(outDir, "receiver");
  const patchDir = join(outDir, "receiver-patch");
  const receiverShots = await loadReceiverShots5(receiverDir, expected, seqs);
  const patchShots = await loadReceiverShots5(patchDir, expected, patchSeqs);
  const receiverApplied = await readJson<AppliedJson>(
    join(receiverDir, "applied.json"),
  );
  const patchApplied = await readJson<AppliedJson>(
    join(patchDir, "applied.json"),
  );
  const receiverCps = computeGate5Checkpoints(
    expected,
    referenceDir,
    reference,
    receiverDir,
    receiverShots,
    seqs,
  );
  const patchCps = computeGate5Checkpoints(
    expected,
    referenceDir,
    reference,
    patchDir,
    patchShots,
    patchSeqs,
  );
  const receiverClass = classifyLeg({
    captureResult: capture.captureResult,
    recording: capture.full,
    receiver: {
      applied: receiverApplied,
      requestedShotSeqs: requested(seqs),
      shotFiles: await shotSeqsPresent5(receiverDir),
    },
    checkpoints: receiverCps,
  });
  const patchClass = classifyLeg({
    captureResult: capture.captureResult,
    recording: capture.patch,
    receiver: {
      applied: patchApplied,
      requestedShotSeqs: requested(patchSeqs),
      shotFiles: await shotSeqsPresent5(patchDir),
    },
    checkpoints: patchCps,
  });
  const vsRef = compareLegs5(expected, reference, receiverShots, rasters, [
    "reference",
    "receiver",
  ]);
  const vsRefPatch = compareLegs5(expected, reference, patchShots, rasters, [
    "reference",
    "receiver-patch",
  ]);
  const imageReceiver = evaluateExpectedImage5(
    expected,
    "receiver",
    receiverShots,
    rasters,
    join(receiverDir, "shots"),
  );
  const presenceReceiver = evaluatePresence5(
    expected,
    "receiver",
    receiverShots,
    rasters,
  );
  const legClass = (
    leg: string,
    classification: ReturnType<typeof classifyLeg>,
    cps: ReturnType<typeof computeGate5Checkpoints>,
    exp: Gate5LegExpectation,
    artifacts: string[],
  ) => {
    const r = evaluateLegClass5(classification, cps, exp);
    return {
      table: r.table,
      check: check(
        `leg-class-${leg}`,
        `the ${leg} leg classifies as ${exp.class}${exp.regions ? ` with mismatching regions exactly ${JSON.stringify(exp.regions)}` : exp.steps ? ` with mismatching steps exactly {${exp.steps.join(",")}}` : " with every region of every shot matching the reference"}`,
        r.problems,
        `${classification.result_class}${
          Object.keys(r.table).length > 0
            ? `; mismatching regions per step ${Object.entries(r.table)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ")}`
            : ""
        }`,
        artifacts,
      ),
    };
  };
  const receiverLeg = legClass(
    "receiver",
    receiverClass,
    receiverCps,
    { class: "success" },
    [join(receiverDir, "applied.json")],
  );
  const patchLeg = legClass(
    "receiver-patch",
    patchClass,
    patchCps,
    { class: "success" },
    [join(patchDir, "applied.json")],
  );
  checks.push(
    receiverLeg.check,
    patchLeg.check,
    check(
      "receiver-vs-reference",
      "receiver and receiver-patch: every pixel of every settle shot equals the reference's, band and undecided pixels included (budget 0, as reference-repeat measured)",
      [...vsRef.problems, ...vsRefPatch.problems],
      `${expected.steps.length * 2} shots identical to the reference`,
      [join(receiverDir, "shots"), join(patchDir, "shots")],
    ),
    check(
      "expected-image-receiver",
      "every receiver settle shot equals rasterizeGate5(k) on every decided pixel, as the reference's does",
      imageReceiver.problems,
      `${imageReceiver.checkpoints.length} receiver shots match on ${imageReceiver.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels`,
      [join(receiverDir, "shots")],
    ),
    check(
      "presence-receiver",
      "in every receiver shot, every sub-shape covers at least half its expected area",
      presenceReceiver.problems,
      `${presenceReceiver.shapes} shape-shots present`,
      [join(receiverDir, "shots")],
    ),
  );
  legs.receiver = {
    group: "g5d",
    expected_class: "success",
    result_class: receiverClass.result_class,
    reasons: receiverClass.reasons,
    harmless_ties: receiverClass.harmless_ties,
    exit_code: await readExitCode(receiverDir),
    artifacts: [join(receiverDir, "applied.json")],
  };
  legs["receiver-patch"] = {
    group: "g5d",
    expected_class: "success",
    result_class: patchClass.result_class,
    reasons: patchClass.reasons,
    harmless_ties: patchClass.harmless_ties,
    exit_code: await readExitCode(patchDir),
    artifacts: [join(patchDir, "applied.json")],
  };

  // clip-rects-derived: both sinks and receiver-patch's own state dumps (D9, D10).
  const ids = itemIdsByName(expected, capture.full).ids;
  const clipFull = evaluateClipRectsDerived(
    expected,
    "full",
    sinkStates(expected, capture.full),
    ids,
  );
  const clipPatch = evaluateClipRectsDerived(
    expected,
    "patch",
    sinkStates(expected, capture.patch),
    ids,
  );
  const dumps = await receiverStates(expected, patchDir, capture.patch);
  const clipDumps = evaluateClipRectsDerived(
    expected,
    "receiver-patch state",
    dumps.states,
    ids,
  );
  checks.push(
    check(
      "clip-rects-derived",
      "deriveClipRects (lib/clip-derive.ts, with D9's draw transform and D10's clip-ignore spans) over each settle state of both sinks and of receiver-patch's own state dumps gives every item expected.json's clip_px (CG's scissor, null elsewhere) and CG's clip-ignored commands exactly those between its add_clip_ignore pair; each dump equals the recording's resolved state",
      [
        ...clipFull.problems,
        ...clipPatch.problems,
        ...dumps.problems.map((p) => `receiver-patch: ${p}`),
        ...clipDumps.problems,
      ],
      Object.entries(clipFull.table)
        .filter(
          ([k]) => k.endsWith("@0") || k.endsWith("@7") || k.endsWith("@9"),
        )
        .map(([k, v]) => `${k} ${v}`)
        .join("; "),
      [capture.full.path, capture.patch.path, join(patchDir, "state")],
    ),
  );

  // capture-canvas (D11).
  const canvas = await evaluateCapture(outDir, {
    legDir: "capture-canvas",
    expectedClass: "unsupported",
  });
  const canvasEval = evaluateCaptureCanvas(expected, canvas);
  checks.push(
    check(
      "leg-class-capture-canvas",
      "the canvas variant's headless capture (one CanvasTexture created in _ready) classifies as unsupported: every /4 op naming RID() -- the untextured polygons, primitives and triangle arrays -- is an unsupported canvas-texture-headless command in place, with its item-level entry, exactly as expected.json predictions[capture-canvas] lists; every other command is the main capture's",
      canvasEval.problems,
      `${canvas.result_class}: ${canvasEval.entries.join(", ")}`,
      canvas.artifacts,
    ),
  );
  legs["capture-canvas"] = {
    group: "g5d",
    expected_class: "unsupported",
    result_class: canvas.result_class,
    reasons: canvas.reasons,
    harmless_ties: canvas.harmless_ties,
    exit_code: canvas.exit_code,
    artifacts: canvas.artifacts,
  };

  // Sabotages: captures with a rendered receiver, then the two receiver sabotages.
  const sabotageRegions: Record<string, Record<string, string>> = {};
  for (const kind of G5D_SABOTAGE_CAPTURE_KINDS) {
    const leg = `sabotage-${kind}`;
    const captureDir = join(outDir, leg, "capture");
    const sabReceiverDir = join(outDir, leg, "receiver");
    const sabResult = await readJson<CaptureResultJson>(
      join(captureDir, "evidence", "result.json"),
    );
    const sabFull = await loadRecording(join(captureDir, RECORDING_NAME));
    const sabSeqs = settleSeqs(expected, sabFull);
    const sabShots = await loadReceiverShots5(
      sabReceiverDir,
      expected,
      sabSeqs,
    );
    const sabCps = computeGate5Checkpoints(
      expected,
      referenceDir,
      reference,
      sabReceiverDir,
      sabShots,
      sabSeqs,
    );
    const sabClass = classifyLeg({
      captureResult: sabResult,
      recording: sabFull,
      receiver: {
        applied: await readJson<AppliedJson>(
          join(sabReceiverDir, "applied.json"),
        ),
        requestedShotSeqs: requested(sabSeqs),
        shotFiles: await shotSeqsPresent5(sabReceiverDir),
      },
      checkpoints: sabCps,
    });
    const pred = expected.predictions[leg];
    const exp: Gate5LegExpectation = pred?.regions
      ? { class: "pixel-mismatch", regions: pred.regions }
      : { class: "pixel-mismatch", steps: pred?.steps ?? [] };
    const r = legClass(leg, sabClass, sabCps, exp, [
      join(captureDir, RECORDING_NAME),
      join(sabReceiverDir, "applied.json"),
    ]);
    checks.push(r.check);
    sabotageRegions[leg] = r.table;
    legs[leg] = {
      group: "g5d",
      expected_class: "pixel-mismatch",
      result_class: sabClass.result_class,
      reasons: sabClass.reasons,
      harmless_ties: sabClass.harmless_ties,
      exit_code: await readExitCode(sabReceiverDir),
      artifacts: [
        join(captureDir, RECORDING_NAME),
        join(sabReceiverDir, "applied.json"),
      ],
    };
  }
  for (const kind of G5D_SABOTAGE_RECEIVER_KINDS) {
    const leg = `sabotage-receiver-${kind}`;
    const dir = join(outDir, leg);
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
      recording: capture.full,
      receiver: {
        applied: await readJson<AppliedJson>(join(dir, "applied.json")),
        requestedShotSeqs: requested(seqs),
        shotFiles: await shotSeqsPresent5(dir),
      },
      checkpoints: cps,
    });
    const pred = expected.predictions[leg];
    const r = legClass(
      leg,
      cls,
      cps,
      { class: "pixel-mismatch", regions: pred?.regions ?? {} },
      [join(dir, "applied.json")],
    );
    checks.push(r.check);
    sabotageRegions[leg] = r.table;
    legs[leg] = {
      group: "g5d",
      expected_class: "pixel-mismatch",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(dir),
      artifacts: [join(dir, "applied.json")],
    };
  }

  checks.push(
    fromGate0(
      await checkReceiverNeverLoadedFixture(outDir, {
        receiverProjectDir: ctx.receiverProjectDir ?? "",
        fixtureProjectDir: ctx.fixtureProjectDir ?? "",
        receiverLogs: g5dReceiverDirs().map((d) =>
          join(outDir, d, "stdout.log"),
        ),
      }),
    ),
    await checkReceiverTypedClean5(outDir),
  );
  return {
    checks,
    report: {
      commands_compared: geometry.compared,
      commands_within_ulp: geometry.ulpUsed,
      lowering: lowering.measured,
      clip_rects: clipFull.table,
      receiver_budgets: {
        receiver: vsRef.budgets.filter((b) => b.mismatched_pixels > 0),
        "receiver-patch": vsRefPatch.budgets.filter(
          (b) => b.mismatched_pixels > 0,
        ),
      },
      sabotage_regions: sabotageRegions,
      canvas_entries: canvasEval.entries,
    },
  };
}
