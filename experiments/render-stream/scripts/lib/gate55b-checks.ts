// Gate 5.5 group g55b's checks and leg classification (protocol/gate5_5-design.md "Q7" and
// "G55b"); check-gate55.ts merges runGate55b's result into the gate 5.5 report.
//
// Everything here reads an evidence directory written by run-gate55.sh, or is pure over values
// already read from one, so scripts/test/self-test-gate55b.ts can drive each check with synthetic
// values. Nothing launches a process. Classification never reads `session.sabotage`. Legs are
// named `capture-cim`, `reference-cim`, `reference-cim-repeat`, `reference-cim-armed` (and
// `-cim-modulate` for the variant), check ids are prefixed `cim-` / `cim-modulate-`.
//
// Group g55b: the CanvasItemMaterial fixture (fixtures/gate55-cim) in two scenes, `base` and
// variant `modulate` (a CanvasModulate on the root canvas). Its captures run on the wire main speaks
// before G55d, where an item naming any material is item-level `canvas_item_set_material` /
// `unsupported-state`; each capture leg must classify exactly that (and G55d turns it into
// `success`). The pixels are checked against an independent model: make_expected.py's CimSim,
// light-mode and canvas-modulate rules and blend twin, rasterized by lib/geometry-raster.ts with its
// blend modes. A same-build reference repeat measures the budget (expected 0).
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 5.5"):
//   legs.json, binary.json
//   cim/import/fixture/              editor --import of fixtures/gate55-cim
//   cim/capture/                     400-frame capture host (base), GRC_ROOT_SIZE=enforce-min-size:
//                                    evidence/ (result, counters, resources.jsonl, ...),
//                                    recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                                    strace.txt, maps.txt
//   cim/reference/, cim/reference-repeat/   rendered, extension absent: shots/step-<k>.png,
//                                    steps.jsonl
//   cim/reference-armed/             rendered, extension armed with a full-sink stream
//   cim-modulate/<the same four>     RS_FIXTURE_VARIANT=modulate

import { join } from "node:path";

import {
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  type Gate0Check,
  RECORDING_NAME,
  readExitCode,
} from "./gate0-checks";
import {
  checkNoDrawIndexTies,
  checkPatchResolvesToFull,
  checkRecordingsDecode,
  evaluateCapture,
  type Gate3CaptureEvaluation,
  unsupportedOps,
} from "./gate3-checks";
import {
  check,
  checkStepAlignment5,
  compareLegs5,
  evaluateExpectedImage5,
  evaluateFreshness5,
  evaluatePresence5,
  type Gate5Check,
  type Gate5Checkpoint,
  loadShots5,
  type PixelClass,
  pixelClass,
  type RegionBudget5,
  regionAt,
  shotPaths5,
} from "./gate5-checks";
import { isShape } from "./gate5-expected";
import {
  asGate5,
  GATE55_VARIANTS,
  type Gate55Expected,
  type Gate55Variant,
  rasters55,
} from "./gate55b-expected";
import type { Gate5Raster } from "./geometry-raster";

// ---------------------------------------------------------------------------------------------
// Constants of the contract
// ---------------------------------------------------------------------------------------------

/** The capture legs' quit frame, as gates 0-5 (the /proc maps/fd sample needs the time). */
export const G55B_CAPTURE_QUIT_FRAME = 400;

/** Each variant's evidence directory under <out>; it also names the variant's legs (`capture-cim`,
 * `reference-cim-modulate-repeat`) and prefixes its check ids (`cim-…`, `cim-modulate-…`), apart
 * from g55c's `shader`/`shader-refused` ones in the same report. */
export const SCENE_DIR: Record<Gate55Variant, string> = {
  base: "cim",
  modulate: "cim-modulate",
};
const SCENE_LEGS = [
  "capture",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;

/** The report leg name of one scene leg (`reference-repeat` + modulate -> `reference-cim-modulate-repeat`). */
export function legName(
  leg: (typeof SCENE_LEGS)[number],
  variant: Gate55Variant,
): string {
  return leg === "capture"
    ? `capture-${SCENE_DIR[variant]}`
    : leg.replace("reference", `reference-${SCENE_DIR[variant]}`);
}

const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
/** The hook-log ops a material census counts (`free` only for kind shader or material). */
const MATERIAL_LOG_OPS = new Set([
  "canvas_item_set_material",
  "canvas_item_set_use_parent_material",
  "canvas_set_modulate",
  "material_create",
  "material_create_from_shader",
  "material_set_param",
  "material_set_shader",
  "shader_create",
  "shader_create_from_code",
  "shader_set_code",
  "free",
]);

function renamed(c: Gate0Check | Gate5Check, id: string): Gate5Check {
  return {
    ...c,
    id,
    status: "status" in c ? c.status : c.passed ? "pass" : "fail",
  };
}

function maxDelta(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  let d = 0;
  for (let c = 0; c < 4; c++)
    d = Math.max(d, Math.abs(a[i * 4 + c] - b[j * 4 + c]));
  return d;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

/** Pure: expected.json obeys its own rules (Q6b, Q6d), recomputed here independently of
 * make_expected.py's asserts, for both variants: 640x360; steps 0..last; marker colours on the
 * grid and distinct both as drawn and as shown under the canvas modulate; regions disjoint and
 * inside the viewport, every shape inside its region at every step; colours on the 0.2 grid with
 * alpha 1, .6 (the strips) or 0 (light_only); the raster reproduces every probe of the Python blend
 * twin exactly (colour and allowed delta) and synthesizes only the clear colour outside the regions;
 * probes cover exactly the fresh regions; `fresh` agrees with the raster; `typed_entries` are the
 * items with a material; `hook_census` is the steps' census plus the rect draws and the hue strip. */
export function checkExpectedSelfConsistent55(
  e: Gate55Expected,
  rasters: Record<Gate55Variant, Map<number, Gate5Raster>>,
): Gate5Check {
  const problems: string[] = [];
  const [W, H] = e.viewport;
  if (W !== 640 || H !== 360) problems.push(`viewport ${W}x${H}`);
  const onGrid = (v: number) =>
    [0, 0.2, 0.4, 0.6, 0.8, 1].some((g) => Math.abs(v - g) < 5e-4);
  const names = Object.keys(e.regions);
  for (let i = 0; i < names.length; i++) {
    const a = e.regions[names[i]];
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
      const b = e.regions[names[j]];
      if (!(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]))
        problems.push(`regions ${names[i]} and ${names[j]} overlap`);
    }
  }
  for (const [key, ops] of Object.entries(e.op_lists))
    for (const op of ops) {
      if (!isShape(op) || op.kind !== "mesh") {
        problems.push(`${key}: only rect meshes are expected`);
        continue;
      }
      for (const c of op.colors) {
        if (!c.slice(0, 3).every(onGrid))
          problems.push(`${key}/${op.name}: colour ${c} off the 0.2 grid`);
        const alphaOk = [1, 0.6, 0].some((a) => Math.abs(c[3] - a) < 5e-4);
        if (!alphaOk) problems.push(`${key}/${op.name}: alpha ${c[3]}`);
      }
    }
  let probes = 0;
  let census = 0;
  for (const variant of GATE55_VARIANTS) {
    const v = e.variants[variant];
    const steps = v.steps.map((s) => s.step);
    if (
      JSON.stringify(steps) !==
      JSON.stringify([...Array(e.last_step + 1).keys()])
    )
      problems.push(
        `${variant}: steps ${JSON.stringify(steps)} are not 0..${e.last_step}`,
      );
    for (const key of ["marker_rgba8", "marker_shown_rgba8"] as const) {
      const seen = new Set(v.steps.map((s) => s[key].join(",")));
      if (seen.size !== v.steps.length)
        problems.push(`${variant}: ${key} not distinct per step`);
      for (const s of v.steps)
        if (!s[key].every((c) => LEVELS.has(c)))
          problems.push(
            `${variant} step ${s.step}: ${key} ${s[key]} off the grid`,
          );
    }
    const totals: Record<string, number> = {};
    for (const s of v.steps) {
      for (const [op, n] of Object.entries(s.census))
        totals[op] = (totals[op] ?? 0) + n;
      for (const calls of Object.values(s.calls))
        for (const c of calls) totals[c.op] = (totals[c.op] ?? 0) + 1;
      if (
        JSON.stringify([...s.typed_entries].sort()) !==
        JSON.stringify(Object.keys(s.builtin).sort())
      )
        problems.push(
          `${variant} step ${s.step}: typed_entries ${s.typed_entries} are not the items with a material`,
        );
      // Every shape inside its region.
      for (const item of s.items) {
        const r = e.regions[item.region];
        for (const op of e.op_lists[item.ops] ?? []) {
          if (!isShape(op) || op.kind !== "mesh") continue;
          for (const [x, y] of op.vertices) {
            const px = x + item.xform[4];
            const py = y + item.xform[5];
            if (!(r && r[0] <= px && px <= r[2] && r[1] <= py && py <= r[3]))
              problems.push(
                `${variant} step ${s.step} ${item.name}/${op.name}: vertex (${px},${py}) outside ${item.region}`,
              );
          }
        }
      }
      // The raster against the Python twin's probes, and probes exactly in the fresh regions.
      const ras = rasters[variant].get(s.step);
      if (!ras) continue;
      const probed = new Set<string>();
      for (const p of s.probes) {
        probes++;
        const [x, y, r, g, b, a, d] = p;
        const i = y * W + x;
        const region = regionAt(e.regions, x, y);
        probed.add(region);
        if (!s.fresh[region])
          problems.push(
            `${variant} step ${s.step}: probe (${x},${y}) in ${region}, which is not fresh`,
          );
        const got = [...ras.rgba.subarray(i * 4, i * 4 + 4)];
        if (
          !ras.exact[i] ||
          got.join(",") !== [r, g, b, a].join(",") ||
          ras.delta[i] !== d
        )
          problems.push(
            `${variant} step ${s.step} ${region} (${x},${y}): raster ${got} delta ${ras.delta[i]}${ras.exact[i] ? "" : " undecided"}, Python ${[r, g, b, a]} delta ${d}`,
          );
      }
      for (const [region, fresh] of Object.entries(s.fresh))
        if (fresh && !probed.has(region))
          problems.push(
            `${variant} step ${s.step}: fresh region ${region} has no probe`,
          );
      // Nothing outside the regions; every pixel decided (integer rects).
      let outside = 0;
      let undecided = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!ras.exact[i]) undecided++;
          if (regionAt(e.regions, x, y) !== "outside") continue;
          if (
            [0, 1, 2, 3].some((c) => ras.rgba[i * 4 + c] !== e.clear_rgba8[c])
          )
            outside++;
        }
      if (outside > 0)
        problems.push(
          `${variant} step ${s.step}: ${outside} synthesized pixels outside every region are not the clear colour`,
        );
      if (undecided > 0)
        problems.push(
          `${variant} step ${s.step}: ${undecided} undecided pixels (every rect is integer and axis-aligned)`,
        );
      if (s.step === 0) continue;
      const prev = rasters[variant].get(s.step - 1);
      if (!prev) continue;
      for (const [name, box] of Object.entries(e.regions)) {
        let changed = false;
        for (let y = box[1]; y < box[3] && !changed; y++)
          for (let x = box[0]; x < box[2] && !changed; x++)
            if (maxDelta(ras.rgba, y * W + x, prev.rgba, y * W + x) > 0)
              changed = true;
        if (changed !== s.fresh[name])
          problems.push(
            `${variant} step ${s.step}: ${name} fresh=${s.fresh[name]} but its synthesized pixels ${changed ? "change" : "do not change"}`,
          );
      }
    }
    const want = { ...totals, texture_2d_create: 1 };
    const sorted = (o: Record<string, number>) =>
      JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (sorted(want) !== sorted(e.hook_census[variant]))
      problems.push(
        `${variant}: hook_census ${sorted(e.hook_census[variant])} != the steps' census ${sorted(want)}`,
      );
    census += Object.values(e.hook_census[variant]).reduce((a, b) => a + b, 0);
  }
  return check(
    "cim-expected-self-consistent",
    "expected.json obeys its rules (gate5_5-design.md Q6b, Q6d) in both variants: 640x360, steps 0..9, grid marker colours distinct as drawn and as shown under the canvas modulate; regions disjoint with every shape inside its own; colours on the 0.2 grid with alpha 1, .6 or 0; the blend-aware raster reproduces every probe of make_expected.py's Python twin exactly, decides every pixel and paints only the clear colour outside the regions; probes cover exactly the fresh regions and fresh agrees with the raster; typed_entries are the items with a material; hook_census sums the steps",
    problems,
    `${probes} probes reproduced over ${GATE55_VARIANTS.length} variants, ${Object.keys(e.op_lists).length} op lists, census ${census} calls`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// material-census
// ---------------------------------------------------------------------------------------------

export interface CountersLike55 {
  counts?: Record<string, number>;
  hooks_planned?: string[];
}

/** A hook-log line as far as the census reads it (G55a's kind:"shader"/"material"/"item-material"
 * lines name their RenderingServer method in `op`, or `call`). */
export interface MaterialLogLine {
  frame: number;
  op?: string;
  call?: string;
  kind?: string | null;
  sabotage?: boolean;
  omitted?: boolean;
}

/** The census key of a hook-log line, or null when the census does not count it. */
export function censusKeyOf(line: MaterialLogLine): string | null {
  if (line.omitted) return null;
  const method = line.op ?? line.call;
  if (!method || !MATERIAL_LOG_OPS.has(method)) return null;
  if (method === "free")
    return line.kind === "shader" || line.kind === "material"
      ? `free:${line.kind}`
      : null;
  return method;
}

/** Pure: counters.json's counts of the material ops the record hooks before calibrator 8
 * (canvas_item_set_material, material_set_param, shader_set_code, shader_create_from_code), of
 * canvas_item_add_rect and of texture_2d_create equal hook_census; calibrator 8's ops are reported
 * `unhooked` while the record plans none of them, and once it plans all of them the hook log's
 * material lines, step window by step window (applied frame to the next one, the last to `quit`),
 * equal each step's census exactly. */
export function evaluateMaterialCensus(
  e: Gate55Expected,
  variant: Gate55Variant,
  counters: CountersLike55 | undefined,
  hookLines: readonly MaterialLogLine[] | undefined,
  quitFrame: number,
): {
  problems: string[];
  measured: Record<string, number | "unhooked">;
  calibrator8: "unhooked" | "hooked" | "partial";
  per_step: Record<string, Record<string, number>> | null;
} {
  const problems: string[] = [];
  const measured: Record<string, number | "unhooked"> = {};
  if (!counters?.counts || !counters.hooks_planned) {
    problems.push("counters.json missing counts or hooks_planned");
    return { problems, measured, calibrator8: "unhooked", per_step: null };
  }
  const planned = new Set(counters.hooks_planned);
  const want = e.hook_census[variant];
  for (const op of [
    ...e.hooked_before_calibrator8,
    "canvas_item_add_rect",
    "texture_2d_create",
  ]) {
    if (!planned.has(op)) {
      problems.push(`${op} is not a planned hook`);
      continue;
    }
    const got = counters.counts[op] ?? 0;
    measured[op] = got;
    if (got !== (want[op] ?? 0))
      problems.push(`${op}: ${got} calls, expected ${want[op] ?? 0}`);
  }
  const planned8 = e.calibrator8_ops.filter((op) => planned.has(op));
  if (planned8.length === 0) {
    for (const op of e.calibrator8_ops) measured[op] = "unhooked";
    return { problems, measured, calibrator8: "unhooked", per_step: null };
  }
  if (planned8.length !== e.calibrator8_ops.length) {
    problems.push(
      `calibrator 8 partially planned: ${planned8.join(",")} of ${e.calibrator8_ops.join(",")}`,
    );
    return { problems, measured, calibrator8: "partial", per_step: null };
  }
  if (!hookLines) {
    problems.push(
      "calibrator 8 is planned but evidence/resources.jsonl is missing",
    );
    return { problems, measured, calibrator8: "hooked", per_step: null };
  }
  const steps = e.variants[variant].steps;
  const perStep: Record<string, Record<string, number>> = {};
  for (let k = 0; k < steps.length; k++) {
    const from = steps[k].applied_frame;
    const to =
      k + 1 < steps.length ? steps[k + 1].applied_frame : quitFrame + 1;
    const got: Record<string, number> = {};
    for (const line of hookLines) {
      if (line.frame < from || line.frame >= to) continue;
      const key = censusKeyOf(line);
      if (key) got[key] = (got[key] ?? 0) + 1;
    }
    perStep[String(k)] = got;
    const sorted = (o: Record<string, number>) =>
      JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (sorted(got) !== sorted(steps[k].census))
      problems.push(
        `step ${k} (frames ${from}..${to - 1}): hook log ${sorted(got)} != census ${sorted(steps[k].census)}`,
      );
  }
  for (const op of e.calibrator8_ops)
    measured[op] = Object.values(perStep).reduce((n, s) => n + (s[op] ?? 0), 0);
  return { problems, measured, calibrator8: "hooked", per_step: perStep };
}

/** The hook log's lines that can be census lines (any other line is ignored, never rejected). */
export function parseMaterialLog(
  text: string | undefined,
): MaterialLogLine[] | undefined {
  if (text === undefined) return undefined;
  const out: MaterialLogLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const v = JSON.parse(raw) as MaterialLogLine;
      if (Number.isInteger(v.frame)) out.push(v);
    } catch {
      // A truncated last line (a killed host) is not a census line.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// leg-class-capture: unsupported, every material item typed
// ---------------------------------------------------------------------------------------------

export interface RectCommand {
  op: "add_rect";
  rect: number[];
  color: number[];
  aa: boolean;
}

/** Per step, each item's resolved add_rect list as of that step (carried from its last redraw):
 * the fixture's calls, float32, colours as drawn. */
export function rectCommandsByStep(
  e: Gate55Expected,
  variant: Gate55Variant,
): Map<number, Map<string, RectCommand[]>> {
  const f32 = (v: number) => Math.fround(v);
  const out = new Map<number, Map<string, RectCommand[]>>();
  const current = new Map<string, RectCommand[]>();
  for (const s of e.variants[variant].steps) {
    const fresh = new Map<string, RectCommand[]>();
    for (const calls of Object.values(s.calls))
      for (const c of calls) {
        const list = fresh.get(c.item) ?? [];
        list.push({
          op: "add_rect",
          rect: (c.rect as number[]).map(f32),
          color: (c.color as number[]).map(f32),
          aa: c.antialiased as boolean,
        });
        fresh.set(c.item, list);
      }
    for (const [item, list] of fresh) current.set(item, list);
    out.set(s.step, new Map(current));
  }
  return out;
}

/** Pure: the capture classifies `unsupported`; the only unsupported op is canvas_item_set_material
 * and every entry is item-level `unsupported-state`; at every settle frame the entries name exactly
 * the step's `typed_entries` items, and each item's commands are its add_rect calls as recorded
 * (float32-exact, the colours as drawn, never modulated: the canvas modulate is not item state);
 * and every item but the marker keeps one content_version over the whole run (nothing the timeline
 * changes redraws a region: fresh without redraw, D9). */
export function evaluateCimCaptureTyped(
  e: Gate55Expected,
  variant: Gate55Variant,
  capture: Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full">,
): { problems: string[]; ops: string[]; versions: Record<string, number[]> } {
  const problems: string[] = [];
  const v = e.variants[variant];
  if (capture.result_class !== "unsupported")
    problems.push(
      `class ${capture.result_class}, expected unsupported: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(capture.full);
  if (JSON.stringify(ops) !== JSON.stringify([...e.typed_ops].sort()))
    problems.push(
      `unsupported ops ${JSON.stringify(ops)} != ${JSON.stringify(e.typed_ops)}`,
    );
  const ids = new Set<number>();
  for (const t of capture.full.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length !== v.creation_order.length)
    problems.push(
      `${sorted.length} item ids in the recording, expected ${v.creation_order.length}`,
    );
  const idOf = new Map(v.creation_order.map((n, k) => [n, sorted[k]]));
  const nameOf = new Map(v.creation_order.map((n, k) => [sorted[k], n]));
  for (const t of capture.full.transactions)
    for (const u of t.meta.unsupported) {
      if (u.reason === "draw-index-tie") continue;
      if (
        u.op !== "canvas_item_set_material" ||
        u.reason !== "unsupported-state" ||
        u.item === null
      ) {
        problems.push(
          `frame ${t.meta.frame}: entry ${JSON.stringify(u)} is not item-level canvas_item_set_material/unsupported-state`,
        );
        break;
      }
    }
  const typed = rectCommandsByStep(e, variant);
  for (const s of v.steps) {
    const t = capture.full.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    if (!t) {
      problems.push(
        `step ${s.step}: no transaction at frame ${s.settle_frame}`,
      );
      continue;
    }
    const entries = t.meta.unsupported
      .filter((u) => u.reason !== "draw-index-tie" && u.item !== null)
      .map((u) => nameOf.get(u.item as number) ?? `#${u.item}`)
      .sort();
    if (JSON.stringify(entries) !== JSON.stringify([...s.typed_entries].sort()))
      problems.push(
        `step ${s.step}: typed items ${entries.join(",")} != ${[...s.typed_entries].sort().join(",")}`,
      );
    for (const [name, want] of typed.get(s.step) ?? []) {
      const item = t.meta.items.find((i) => i.id === idOf.get(name));
      const got = (item?.commands ?? []).map((c) =>
        c.op === "add_rect"
          ? { op: c.op, rect: c.rect, color: c.color, aa: c.aa }
          : { op: c.op, name: c.name },
      );
      if (JSON.stringify(got) !== JSON.stringify(want))
        problems.push(
          `step ${s.step} ${name}: commands ${JSON.stringify(got).slice(0, 160)} != ${JSON.stringify(want).slice(0, 160)}`,
        );
    }
    for (const name of v.creation_order.filter(
      (n) => !(typed.get(s.step) ?? new Map()).has(n),
    )) {
      const item = t.meta.items.find((i) => i.id === idOf.get(name));
      if ((item?.commands.length ?? 0) !== 0)
        problems.push(
          `step ${s.step} ${name}: ${item?.commands.length} commands, expected none`,
        );
    }
  }
  const versions: Record<string, number[]> = {};
  for (const name of v.creation_order) {
    const seen = new Set<number>();
    for (const t of capture.full.transactions)
      for (const i of t.meta.items)
        if (i.id === idOf.get(name)) seen.add(i.content_version);
    versions[name] = [...seen].sort((a, b) => a - b);
    if (name !== "Marker" && seen.size !== 1)
      problems.push(
        `${name}'s content_version takes ${seen.size} values over the run (${versions[name].join(",")}), expected one`,
      );
  }
  return { problems, ops, versions };
}

// ---------------------------------------------------------------------------------------------
// Orchestration (check-gate55.ts merges the result into render-stream-gate55-report/1)
// ---------------------------------------------------------------------------------------------

export interface Gate55bLegEntry {
  group: string;
  expected_class: string | null;
  result_class: string | null;
  reasons: string[];
  harmless_ties?: string[];
  exit_code: number | null;
  artifacts: string[];
}

/** Per fixture variant (gate55-cim, gate55-cim-modulate): the material census as measured, per
 * step as predicted, whether calibrator 8 hooked it, each item's content versions, and the
 * raster's pixel classes per step. */
export interface Gate55bMaterials {
  hook_census: Record<string, number | "unhooked">;
  calibrator8: string;
  per_step_expected: Record<string, Record<string, number>>;
  per_step_measured: Record<string, Record<string, number>> | null;
  content_versions: Record<string, number[]>;
  exactness: Record<string, Record<PixelClass, number>>;
}

export interface Gate55bResult {
  checks: Gate5Check[];
  legs: Record<string, Gate55bLegEntry>;
  checkpoints: Gate5Checkpoint[];
  /** keyed by fixture variant, as the report's `materials`, `budgets` and `freshness` */
  materials: Record<string, Gate55bMaterials>;
  budgets: Record<string, RegionBudget5[]>;
  freshness: Record<string, Record<string, string[]>>;
}

async function supportLegEntry(dir: string): Promise<Gate55bLegEntry> {
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
    group: "g55b",
    expected_class: null,
    result_class: null,
    reasons: [],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

function exactnessTable(
  rasters: Map<number, Gate5Raster>,
): Record<string, Record<PixelClass, number>> {
  const out: Record<string, Record<PixelClass, number>> = {};
  for (const [step, r] of rasters) {
    const row: Record<PixelClass, number> = {
      exact: 0,
      delta1: 0,
      band: 0,
      undecided: 0,
    };
    for (let i = 0; i < r.width * r.height; i++) row[pixelClass(r, i)]++;
    out[String(step)] = row;
  }
  return out;
}

/** g55b's checks for one variant's scene (its evidence under <out>/<SCENE_DIR[variant]>). */
async function runScene(
  outDir: string,
  e: Gate55Expected,
  variant: Gate55Variant,
  rasters: Map<number, Gate5Raster>,
) {
  const dir = join(outDir, SCENE_DIR[variant]);
  const id = (name: string) => `${SCENE_DIR[variant]}-${name}`;
  const e5 = asGate5(e, variant);
  const capture = await evaluateCapture(dir, { expectedClass: "unsupported" });
  const countersPath = join(dir, "capture", "evidence", "counters.json");
  const counters = await readJson<CountersLike55>(countersPath);
  const hookPath = join(dir, "capture", "evidence", "resources.jsonl");
  const hookLines = parseMaterialLog(await readTextOrUndefined(hookPath));
  const reference = await loadShots5(dir, "reference", e5);
  const repeat = await loadShots5(dir, "reference-repeat", e5);
  const armed = await loadShots5(dir, "reference-armed", e5);
  const L = (leg: (typeof SCENE_LEGS)[number]) => legName(leg, variant);

  const image = evaluateExpectedImage5(
    e5,
    L("reference"),
    reference,
    rasters,
    join(dir, "reference", "shots"),
  );
  const presence = evaluatePresence5(e5, L("reference"), reference, rasters);
  const fresh = evaluateFreshness5(e5, L("reference"), reference);
  // Fresh without redraw (Q6b step 6): UC inherits UP's material while nothing redraws.
  const step6 = e.variants[variant].steps.find((s) => s.step === 6);
  if (JSON.stringify(step6?.redraws) !== JSON.stringify(["Marker"]))
    fresh.problems.push(
      `step 6 is modelled with redraws ${JSON.stringify(step6?.redraws)}`,
    );
  if (!fresh.table["6"]?.includes("UP"))
    fresh.problems.push("step 6: UP (UC's use_parent_material) did not change");
  const repeatCmp = compareLegs5(e5, reference, repeat, rasters, [
    L("reference"),
    L("reference-repeat"),
  ]);
  const armedCmp = compareLegs5(e5, reference, armed, rasters, [
    L("reference"),
    L("reference-armed"),
  ]);
  const armedResult = await readJson<CaptureResultJson>(
    join(dir, "reference-armed", "evidence", "result.json"),
  );
  if (armedResult?.status !== "armed")
    armedCmp.problems.unshift(
      `${L("reference-armed")} result.json status=${JSON.stringify(armedResult?.status)}`,
    );
  if (armedResult?.stream?.status !== "closed")
    armedCmp.problems.unshift(
      `${L("reference-armed")} stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
    );
  const census = evaluateMaterialCensus(
    e,
    variant,
    counters,
    hookLines,
    G55B_CAPTURE_QUIT_FRAME,
  );
  const typed = evaluateCimCaptureTyped(e, variant, capture);
  const delta1 = repeatCmp.budgets.filter(
    (b) => b.pixels > 0 && b.class !== "exact",
  );

  const checks: Gate5Check[] = [
    renamed(
      await checkCaptureArmed(dir, {
        captureResult: capture.captureResult,
        recording: capture.full,
      }),
      id("capture-armed"),
    ),
    renamed(await checkHeadlessNoGpuGate0(dir), id("headless-no-gpu")),
    renamed(
      checkRecordingsDecode(capture.full, capture.patch),
      id("recording-decodes"),
    ),
    renamed(
      checkPatchResolvesToFull(capture.full, capture.patch),
      id("patch-resolves-to-full"),
    ),
    renamed(
      await checkStepAlignment5(dir, e5, capture.full),
      id("step-alignment"),
    ),
    renamed(checkNoDrawIndexTies(capture.full).check, id("no-draw-index-ties")),
    check(
      id("material-census"),
      "the capture's counters.json counts of the material ops hooked before calibrator 8 (canvas_item_set_material, material_set_param, shader_set_code, shader_create_from_code), of canvas_item_add_rect and of texture_2d_create equal expected.json hook_census; calibrator 8's ops are reported unhooked until the record plans them, and then the hook log's material lines equal each step's census window by window",
      census.problems,
      `${Object.entries(census.measured)
        .map(([op, n]) => `${op} ${n}`)
        .join(", ")} (calibrator 8 ${census.calibrator8})`,
      [countersPath, hookPath],
    ),
    check(
      id("expected-image-reference"),
      "every reference shot (step-<k>.png at each settle frame) equals the blend-aware raster of step k on every pixel: exactly for flat opaque mix, add, sub, premul_alpha and disabled (alpha included: the disabled strip writes its own alpha into the RGB10_A2 target), within 1 for mul and the .6 strips (D13); light_only items paint nothing; unshaded items ignore the canvas modulate",
      image.problems,
      `${image.checkpoints.length} shots match on ${image.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} pixels (${image.checkpoints.reduce((n, c) => n + (c.delta1_used ?? 0), 0)} used their delta of 1)`,
      shotPaths5(dir, "reference", e5),
    ),
    check(
      id("presence-reference"),
      "in every reference shot, every visible rect covers at least half its area with pixels differing from what the raster has beneath it (a light_only rect covers nothing)",
      presence.problems,
      `${presence.shapes} shape-shots present`,
      shotPaths5(dir, "reference", e5),
    ),
    check(
      id("freshness-reference"),
      "between consecutive reference shots a region changes exactly when expected.json says fresh, although only the marker ever redraws after step 0: material, light-mode, inheritance (UC at step 6), transform and canvas-modulate changes repaint without a redraw",
      fresh.problems,
      Object.entries(fresh.table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" "),
      shotPaths5(dir, "reference", e5),
    ),
    check(
      id("reference-repeat-budget"),
      "reference vs reference-repeat (same build, GPU and driver): identical at every pixel of every shot, alpha included -- the budget is what this measures (D13 expects 0); maxima per region and pixel class are reported",
      repeatCmp.problems,
      `budget 0: ${e5.steps.length} shot pairs identical; delta-1 pixels per region: ${delta1
        .map(
          (b) => `${b.region} ${b.class} ${b.max_channel_delta}/${b.pixels}px`,
        )
        .join(", ")}`,
      [
        ...shotPaths5(dir, "reference", e5),
        ...shotPaths5(dir, "reference-repeat", e5),
      ],
    ),
    check(
      id("armed-transparent"),
      "the armed reference (extension armed, stream on) armed with its stream closed, and every shot equals the reference's exactly: the hooks forward untouched",
      armedCmp.problems,
      `${e5.steps.length} armed shots byte-identical to the reference`,
      shotPaths5(dir, "reference-armed", e5),
    ),
    check(
      `leg-class-${L("capture")}`,
      "the capture leg classifies as unsupported on the pre-/5 wire: armed, stream closed, both sinks valid, no capture failure; the only unsupported op is canvas_item_set_material, item-level unsupported-state, naming at every settle frame exactly the items with a material (RI not at step 4); every item's commands are its add_rect calls (float32-exact, unmodulated); and every item but the marker keeps one content_version over the run",
      typed.problems,
      `${capture.result_class}: ${typed.ops.join(", ")} typed`,
      capture.artifacts,
    ),
  ];
  const legs: Record<string, Gate55bLegEntry> = {
    [L("capture")]: {
      group: "g55b",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    },
  };
  for (const leg of SCENE_LEGS.slice(1))
    legs[L(leg)] = await supportLegEntry(join(dir, leg));
  return {
    checks,
    legs,
    checkpoints: image.checkpoints,
    budgets: repeatCmp.budgets,
    freshness: fresh.table,
    materials: {
      hook_census: census.measured,
      calibrator8: census.calibrator8,
      per_step_expected: Object.fromEntries(
        e.variants[variant].steps.map((s) => [String(s.step), s.census]),
      ),
      per_step_measured: census.per_step,
      content_versions: typed.versions,
      exactness: exactnessTable(rasters),
    },
  };
}

/** Group g55b over <out>/cim and <out>/cim-modulate. */
export async function runGate55b(
  outDir: string,
  e: Gate55Expected,
): Promise<Gate55bResult> {
  const rasters = {
    base: rasters55(e, "base"),
    modulate: rasters55(e, "modulate"),
  } as Record<Gate55Variant, Map<number, Gate5Raster>>;
  const result: Gate55bResult = {
    checks: [checkExpectedSelfConsistent55(e, rasters)],
    legs: {},
    checkpoints: [],
    materials: {},
    budgets: {},
    freshness: {},
  };
  const importDir = join(outDir, SCENE_DIR.base, "import", "fixture");
  const supportProblems: string[] = [];
  const importCode = await readExitCode(importDir);
  if (importCode !== 0)
    supportProblems.push(`import-cim exit ${importCode ?? "<none>"}`);
  result.legs["import-cim"] = await supportLegEntry(importDir);
  for (const variant of GATE55_VARIANTS) {
    const r = await runScene(outDir, e, variant, rasters[variant]);
    result.checks.push(...r.checks);
    Object.assign(result.legs, r.legs);
    result.checkpoints.push(...r.checkpoints);
    const key = `${e.fixture}${variant === "base" ? "" : `-${variant}`}`;
    result.materials[key] = r.materials;
    result.budgets[key] = r.budgets;
    result.freshness[key] = r.freshness;
    for (const leg of SCENE_LEGS.slice(1)) {
      const code = await readExitCode(join(outDir, SCENE_DIR[variant], leg));
      if (code !== 0)
        supportProblems.push(
          `${legName(leg, variant)} exit ${code ?? "<none>"}`,
        );
    }
  }
  result.checks.push(
    check(
      "cim-support-legs-exit",
      "the g55b import and its six rendered legs (reference-cim, -repeat, -armed and the same for cim-modulate) exited 0",
      supportProblems,
      "7 support legs exited 0",
      [],
    ),
  );
  return result;
}
