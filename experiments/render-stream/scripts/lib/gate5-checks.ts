// Gate 5 checks and leg classification (protocol/gate5-design.md "Q7" and "G5b").
//
// Everything here reads an evidence directory written by run-gate5.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate5.ts can drive each check with synthetic
// values. Nothing launches a process. Classification never reads `session.sabotage`.
//
// Group g5b: the immediate-geometry fixture (fixtures/gate5). Its capture runs on the wire main
// speaks before G5d (render-stream/3 since G4e2), where every geometry op but add_rect is typed
// `unsupported`; the capture leg must classify exactly that. The pixels are checked against an
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

import { join } from "node:path";

import {
  decodePngRgba,
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  firstTransactionWithRectColor,
  type Gate0Check,
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
  type Gate5Call,
  type Gate5Expected,
  isShape,
  stepFrames5,
} from "./gate5-expected";
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
export const LANDED_GROUPS: readonly string[] = ["g5b", "g5c"];

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

const f32 = (v: number): number => Math.fround(v);

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
// leg-class-capture: unsupported, every geometry op typed
// ---------------------------------------------------------------------------------------------

/** The /0-/3 command a fixture call records: add_rect is supported, every other hooked op is an
 * `unsupported` command named by its RS method, and an unhooked op records nothing. */
export function typedCommandOf(
  call: Gate5Call,
  hooked: ReadonlySet<string>,
): {
  op: string;
  name?: string;
  rect?: number[];
  color?: number[];
  aa?: boolean;
} | null {
  if (!hooked.has(call.op)) return null;
  if (call.op === "canvas_item_add_rect")
    return {
      op: "add_rect",
      rect: (call.rect as number[]).map(f32),
      color: (call.color as number[]).map(f32),
      aa: call.antialiased as boolean,
    };
  return { op: "unsupported", name: call.op };
}

/** Per step, each item's typed command list as of that step (carried from its last redraw). */
export function typedCommandsByStep(
  expected: Pick<Gate5Expected, "steps">,
  hooked: ReadonlySet<string>,
): Map<number, Map<string, ReturnType<typeof typedCommandOf>[]>> {
  const out = new Map<
    number,
    Map<string, ReturnType<typeof typedCommandOf>[]>
  >();
  const current = new Map<string, ReturnType<typeof typedCommandOf>[]>();
  for (const s of expected.steps) {
    const fresh = new Map<string, ReturnType<typeof typedCommandOf>[]>();
    for (const calls of Object.values(s.calls))
      for (const c of calls) {
        const list = fresh.get(c.item) ?? [];
        const typed = typedCommandOf(c, hooked);
        if (typed) list.push(typed);
        fresh.set(c.item, list);
      }
    for (const [item, list] of fresh) current.set(item, list);
    out.set(s.step, new Map(current));
  }
  return out;
}

/** Pure: the capture classifies `unsupported`, the unsupported ops it carries are exactly
 * typed_ops (plus calibrator 7's when planned), every unsupported entry is `unsupported-op`, and at
 * every settle frame each fixture item's resolved commands are its expected typed list (add_rect
 * float32-exact, every other op an `unsupported` command named by its RS method, in call order). */
export function evaluateCaptureTyped(
  expected: Gate5Expected,
  capture: Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full">,
  hooksPlanned: readonly string[] | undefined,
): { problems: string[]; ops: string[] } {
  const problems: string[] = [];
  if (capture.result_class !== "unsupported")
    problems.push(
      `class ${capture.result_class}, expected unsupported: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const planned = new Set(hooksPlanned ?? []);
  const want = [
    ...expected.typed_ops,
    ...expected.calibrator7_ops.filter((op) => planned.has(op)),
  ].sort();
  const ops = unsupportedOps(capture.full);
  if (JSON.stringify(ops) !== JSON.stringify(want))
    problems.push(
      `unsupported ops ${JSON.stringify(ops)} != ${JSON.stringify(want)}`,
    );
  const reasons = new Set<string>();
  for (const t of capture.full.transactions)
    for (const u of t.meta.unsupported)
      if (u.reason !== "draw-index-tie") reasons.add(u.reason);
  if ([...reasons].some((r) => r !== "unsupported-op"))
    problems.push(
      `unsupported entry reasons ${[...reasons].sort().join(",")}, expected unsupported-op only`,
    );
  // Item names by creation order.
  const ids = new Set<number>();
  for (const t of capture.full.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length !== expected.creation_order.length)
    problems.push(
      `${sorted.length} item ids in the recording, expected ${expected.creation_order.length}`,
    );
  const idOf = new Map(expected.creation_order.map((n, k) => [n, sorted[k]]));
  const hooked = new Set(hooksPlanned ?? []);
  const typed = typedCommandsByStep(expected, hooked);
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
    for (const [name, want2] of typed.get(s.step) ?? []) {
      const item = t.meta.items.find((i) => i.id === idOf.get(name));
      const got = (item?.commands ?? []).map((c) =>
        c.op === "add_rect"
          ? { op: c.op, rect: c.rect, color: c.color, aa: c.aa }
          : { op: c.op, name: c.name },
      );
      if (JSON.stringify(got) !== JSON.stringify(want2))
        problems.push(
          `step ${s.step} ${name}: commands ${JSON.stringify(got).slice(0, 200)} != ${JSON.stringify(want2).slice(0, 200)}`,
        );
    }
  }
  return { problems, ops };
}

export function checkCaptureLegClass5(
  expected: Gate5Expected,
  capture: Gate3CaptureEvaluation,
  hooksPlanned: readonly string[] | undefined,
): Gate5Check {
  const r = evaluateCaptureTyped(expected, capture, hooksPlanned);
  return check(
    "leg-class-capture",
    "the capture leg classifies as unsupported on the pre-/4 wire: armed, stream closed, both sinks valid and equivalent, no capture failure; the unsupported ops are exactly expected.json typed_ops (plus calibrator 7's once hooked), all unsupported-op; and at every settle frame each item's commands are its expected typed list (add_rect float32-exact)",
    r.problems,
    `${capture.result_class}: ${r.ops.map((op) => op.replace(DRAW_OP_PREFIX, "")).join(", ")} typed${capture.harmless_ties.length > 0 ? ` (${capture.harmless_ties.length} harmless tie entries)` : ""}`,
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
  /** per fixture: reference vs reference-repeat per region and pixel class, every shot */
  budgets: Record<string, RegionBudget5[]> | null;
  /** per fixture: per step, the regions whose reference pixels changed */
  freshness: Record<string, Record<string, string[]>> | null;
}

export interface Gate5Context {
  expected: Gate5Expected;
  now?: Date;
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
      expectedClass: "unsupported",
    });
    const counters = await readJson<CountersLike>(
      join(outDir, "capture", "evidence", "counters.json"),
    );
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
      checkCaptureLegClass5(expected, capture, counters?.hooks_planned),
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
    budgets,
    freshness,
  };
}
