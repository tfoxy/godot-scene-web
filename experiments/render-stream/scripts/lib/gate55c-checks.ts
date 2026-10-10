// Gate 5.5c checks (protocol/gate5_5-design.md "G55c", "Q6c", "Q6e"): the ShaderMaterial fixture
// (fixtures/gate55-shader), its material oracle and the reference legs.
//
// Everything here reads an evidence directory written by run-gate55.sh's g55c group, or is pure
// over values already read from one, so scripts/test/self-test-gate55c.ts can drive each check
// with synthetic values. Nothing launches a process. Classification never reads `session.sabotage`.
//
// Independent records of every shader and material meet here, none a replay of another (D12):
//   - make_expected.py's model: the fixture's own calls with exact Variant values, a port of the
//     shader preprocessor (so a predicted GRP1 hash per shader), Python twins of every synthetic
//     fragment() rasterized by lib/geometry-raster.ts, and a hand census;
//   - the reference's material oracle (material_oracle.gd), which reads the rendered reference's own
//     shader code, material parameters and instance parameters back through the RenderingServer;
//   - the capture: until G55e the wire types `canvas_item_set_material` as `unsupported-state`,
//     so the capture legs classify `unsupported`; counters.json counts the four material calls the
//     record hooks before calibrator 8. G55a's shader/material hook log adds the census and
//     hook-hash parity (phase 2 of G55c).
//
// Evidence layout under <out>/ (see scripts/README.md "Gate 5.5"):
//   shader/import/fixture/       editor --import of fixtures/gate55-shader
//   shader/capture/              400-frame capture host, GRC_ROOT_SIZE=enforce-min-size
//   shader/reference/, shader/reference-repeat/
//                                rendered, extension absent, material oracle on: shots/step-<k>.png,
//                                steps.jsonl, materials.jsonl, shader-library/sha256/<hash>.grp
//   shader/reference-armed/      rendered, extension armed with a full-sink stream, oracle off
//   shader-refused/capture/      as shader/capture with RS_FIXTURE_VARIANT=refused
//   shader-refused/reference/    rendered, variant refused, oracle on

import { join } from "node:path";

import { readJson, readTextOrUndefined } from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  checkCaptureArmed,
  checkHeadlessNoGpuGate0,
  type Gate0Check,
  parseStepLog,
  RECORDING_NAME,
  readExitCode,
  type StepLine,
} from "./gate0-checks";
import { parseJsonl } from "./gate2-checks";
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
  type RegionBudget5,
  rastersOf,
  regionAt,
  shotPaths5,
} from "./gate5-checks";
import type {
  Affine,
  Box,
  Gate5Expected,
  Gate5Item,
  Gate5Op,
  Gate5Texture,
  Rgba8,
} from "./gate5-expected";
import type { Gate5Raster } from "./geometry-raster";

// ---------------------------------------------------------------------------------------------
// expected.json (render-stream-gate55-expected/1, fixtures/gate55-shader/make_expected.py)
// ---------------------------------------------------------------------------------------------

/** A Variant as the oracle writes it: snake-case type and components (floats widened). */
export interface VariantView {
  type: string;
  value: unknown;
}

export interface ParamView extends VariantView {
  name: string;
}

export interface ShaderView {
  name: string;
  status: "live" | "freed" | "absent";
  code_bytes?: number;
  payload_bytes?: number;
  include_markers?: boolean;
  sha256?: string;
}

export interface MaterialView {
  name: string;
  status: "live" | "freed" | "absent";
  params?: ParamView[];
}

export interface ItemParamsView {
  name: string;
  instance_params: ParamView[];
}

export interface OracleView {
  shaders: ShaderView[];
  materials: MaterialView[];
  items: ItemParamsView[];
}

export interface Gate55ShaderStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  change: string;
  marker_rgba8: Rgba8;
  canvas_transform: Affine;
  redraws: string[];
  /** the settle frame: PH's phase value there */
  phase: number;
  /** the fixture's calls on the applied frame with exact Variant values */
  material_calls: Record<string, unknown>[];
  items: Gate5Item[];
  fresh: Record<string, boolean>;
  /** what the material oracle must write at the settle frame */
  oracle: OracleView;
}

export interface Gate55Typed {
  ops: string[];
  reason: string;
  /** items (by name) carrying the item-level entry */
  items: string[];
}

export interface Gate55Counters {
  quit_frame: number;
  counts: Record<string, number>;
}

/** [op, entity, version | null, detail | null] */
export type MaterialCensusLine = [string, string, number | null, string | null];

export interface Gate55Census {
  frames: Record<string, MaterialCensusLine[]>;
  phase_rule: {
    material: string;
    param: string;
    from_frame: number;
    to_frame: number | null;
    value: string;
  };
}

export interface Gate55RefusedVariant {
  creation_order: string[];
  regions: Record<string, Box>;
  shader_order: string[];
  material_order: string[];
  refused_items: Record<string, string>;
  typed: Gate55Typed;
  counters: Gate55Counters;
  census: Gate55Census;
  steps: Gate55ShaderStep[];
}

export interface Gate55ShaderExpected {
  schema: "render-stream-gate55-expected/1";
  fixture: string;
  viewport: [number, number];
  clear_rgba8: Rgba8;
  start_frame_default: number;
  step_frames_default: number;
  settle_offset: number;
  quit_frame_default: number;
  capture_quit_frame: number;
  last_step: number;
  creation_order: string[];
  regions: Record<string, Box>;
  marker_rect: [number, number, number, number];
  exact_edge_px: number;
  textures: Record<string, Gate5Texture>;
  engine_textures: unknown[];
  shader_order: string[];
  material_order: string[];
  declared_params: Record<string, string[]>;
  instance_params: Record<string, string[]>;
  shader_files: Record<string, string>;
  shader_codes: Record<
    string,
    {
      code_bytes: number;
      payload_bytes: number;
      include_markers: boolean;
      sha256: string;
    }
  >;
  shader_scan: Record<
    string,
    { mode: string; uses: string[]; reason: string | null }
  >;
  typed: Gate55Typed;
  counters: Gate55Counters;
  census: Gate55Census;
  op_lists: Record<string, Gate5Op[]>;
  steps: Gate55ShaderStep[];
  variants: { refused: Gate55RefusedVariant };
  predictions: Record<string, unknown>;
}

/** The G5b helpers read only the fields both expected files share (viewport, regions, steps with
 * items/fresh/marker, op_lists, textures, frame constants). */
export function asGate5(expected: Gate55ShaderExpected): Gate5Expected {
  return expected as unknown as Gate5Expected;
}

/** The refused variant as a whole expected file of its own (shared constants, its own regions,
 * items, steps and creation order). */
export function refusedView(
  expected: Gate55ShaderExpected,
): Gate55ShaderExpected {
  const v = expected.variants.refused;
  return {
    ...expected,
    creation_order: v.creation_order,
    regions: v.regions,
    shader_order: v.shader_order,
    material_order: v.material_order,
    typed: v.typed,
    counters: v.counters,
    census: v.census,
    steps: v.steps,
  };
}

export const G55C_LEG_DIR = "shader";
export const G55C_REFUSED_DIR = "shader-refused";
export const G55C_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;
const ORACLE_LEGS = ["reference", "reference-repeat"] as const;
const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
export const SHADER_ERROR_PATTERNS = [
  "SHADER ERROR",
  "Shader compilation failed",
] as const;

function rename(c: Gate5Check | Gate0Check, id: string): Gate5Check {
  return {
    ...c,
    id,
    status: c.passed ? "pass" : "fail",
  } as Gate5Check;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

/** Pure: expected.json (one variant view) obeys its own rules, recomputed here independently of
 * make_expected.py's asserts: 640x360, steps 0..last with distinct marker colours, every colour on
 * the 0.2 grid at alpha 1, texels on the grid, regions disjoint inside the viewport, nothing
 * synthesized outside them, `fresh` as the raster says, no item redrawn after step 0 but the
 * marker, the oracle view naming every shader and material of the orders with statuses that move
 * only absent -> live -> freed, and PH's phase the settle frame. */
export function checkShaderExpectedSelfConsistent(
  expected: Gate55ShaderExpected,
  rasters: Map<number, Gate5Raster>,
  id = "shader-expected-self-consistent",
): Gate5Check {
  const problems: string[] = [];
  const [W, H] = expected.viewport;
  if (W !== 640 || H !== 360) problems.push(`viewport ${W}x${H}`);
  const steps = expected.steps.map((s) => s.step);
  if (
    JSON.stringify(steps) !==
    JSON.stringify([...Array(expected.last_step + 1).keys()])
  )
    problems.push(`steps ${JSON.stringify(steps)}`);
  if (
    new Set(expected.steps.map((s) => s.marker_rgba8.join(","))).size !==
    expected.steps.length
  )
    problems.push("marker colours are not distinct per step");
  const onGrid = (v: number) =>
    [0, 0.2, 0.4, 0.6, 0.8, 1].some((g) => Math.abs(v - g) < 5e-4);
  const used = new Set(
    expected.steps.flatMap((s) => s.items.map((i) => i.ops)),
  );
  for (const key of used)
    for (const op of expected.op_lists[key] ?? [])
      if ("kind" in op && op.kind === "mesh")
        for (const c of op.colors)
          if (!c.every(onGrid) || Math.abs(c[3] - 1) > 1e-6)
            problems.push(`${key}/${op.name}: colour ${c} off the grid`);
  for (const [name, t] of Object.entries(expected.textures))
    for (let i = 0; i < t.rgba8_hex.length; i += 2)
      if (!LEVELS.has(Number.parseInt(t.rgba8_hex.slice(i, i + 2), 16))) {
        problems.push(`texture ${name}: texel byte off the grid`);
        break;
      }
  const names = Object.keys(expected.regions);
  for (let i = 0; i < names.length; i++) {
    const a = expected.regions[names[i]];
    if (!(0 <= a[0] && a[0] < a[2] && a[2] <= W && 0 <= a[1] && a[3] <= H))
      problems.push(`region ${names[i]} is not inside the viewport`);
    for (let j = i + 1; j < names.length; j++) {
      const b = expected.regions[names[j]];
      if (!(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]))
        problems.push(`regions ${names[i]} and ${names[j]} overlap`);
    }
  }
  const order = { absent: 0, live: 1, freed: 2 } as const;
  for (const s of expected.steps) {
    const r = rasters.get(s.step);
    if (s.phase !== s.settle_frame)
      problems.push(`step ${s.step}: phase ${s.phase} != settle frame`);
    if (s.step > 0 && JSON.stringify(s.redraws) !== '["Marker"]')
      problems.push(
        `step ${s.step}: redraws ${s.redraws}, expected Marker only`,
      );
    if (
      s.oracle.shaders.map((x) => x.name).join() !==
      expected.shader_order.join()
    )
      problems.push(`step ${s.step}: oracle shaders not in shader_order`);
    if (
      s.oracle.materials.map((x) => x.name).join() !==
      expected.material_order.join()
    )
      problems.push(`step ${s.step}: oracle materials not in material_order`);
    for (const m of s.oracle.materials)
      if (
        m.status === "live" &&
        (m.params ?? []).map((p) => p.name).join() !==
          (expected.declared_params[m.name] ?? []).join()
      )
        problems.push(`step ${s.step} ${m.name}: params != declared_params`);
    if (s.step > 0) {
      const prev = expected.steps[s.step - 1];
      for (const list of ["shaders", "materials"] as const)
        for (const x of s.oracle[list]) {
          const before = prev?.oracle[list].find((y) => y.name === x.name);
          if (before && order[x.status] < order[before.status])
            problems.push(
              `step ${s.step} ${x.name}: status ${before.status} -> ${x.status}`,
            );
        }
    }
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
      problems.push(`step ${s.step}: ${outside} pixels outside every region`);
    if (s.step === 0) continue;
    const prev = rasters.get(s.step - 1);
    if (!prev) continue;
    for (const [name, box] of Object.entries(expected.regions)) {
      let changed = false;
      for (let y = box[1]; y < box[3] && !changed; y++)
        for (let x = box[0]; x < box[2] && !changed; x++) {
          const i = y * W + x;
          for (let c = 0; c < 4; c++)
            if (r.rgba[i * 4 + c] !== prev.rgba[i * 4 + c]) changed = true;
          if (r.exact[i] !== prev.exact[i]) changed = true;
        }
      if (changed !== s.fresh[name])
        problems.push(
          `step ${s.step}: ${name} fresh=${s.fresh[name]} but its pixels ${changed ? "change" : "do not change"}`,
        );
    }
  }
  return check(
    id,
    "fixtures/gate55-shader/expected.json obeys its rules: 640x360, steps 0..last with distinct grid marker colours, every colour and texel on the 0.2 grid at alpha 1, regions disjoint with nothing synthesized outside them, fresh as the raster says, only the marker redrawn after step 0, oracle views in shader/material order with declared parameters and statuses moving absent -> live -> freed, PH's phase the settle frame",
    problems,
    `${expected.steps.length} steps, ${Object.keys(expected.regions).length} regions, ${expected.shader_order.length} shaders, ${expected.material_order.length} materials`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// The material oracle
// ---------------------------------------------------------------------------------------------

export interface OracleLine extends OracleView {
  schema: string;
  step: number;
  frame: number;
}

export function validateOracleLine(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "not an object";
  const v = value as Partial<OracleLine>;
  if (v.schema !== "render-stream-gate55-materials/1") return "schema";
  if (!Number.isInteger(v.step) || !Number.isInteger(v.frame))
    return "step/frame";
  if (
    !Array.isArray(v.shaders) ||
    !Array.isArray(v.materials) ||
    !Array.isArray(v.items)
  )
    return "shaders/materials/items";
  return null;
}

export interface OracleLog {
  leg: string;
  path: string;
  text: string | undefined;
  lines: OracleLine[];
  problem: string | null;
}

export async function loadOracle(
  dir: string,
  leg: string,
  label = leg,
): Promise<OracleLog> {
  const path = join(dir, leg, "materials.jsonl");
  const text = await readTextOrUndefined(path);
  const parsed = parseJsonl<OracleLine>(text, validateOracleLine);
  return {
    leg: label,
    path,
    text,
    lines: parsed.lines,
    problem: parsed.problem,
  };
}

/** Deep equality of two JSON values, numbers compared exactly (full-precision doubles on both
 * sides: float32 components widened, float64 parameters as written). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      jsonEqual(ka, kb) &&
      ka.every((k) =>
        jsonEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return false;
}

/** Pure: each oracle log has one line per step at its settle frame, and per step every shader's
 * and material's status, every declared material parameter's type and value and every instance
 * parameter's type and value equal expected.json's oracle view (`parameters` part, D12 (3)); the
 * oracle logs of `pairs` are byte-identical. Shader hashes are checkOracleShaderCode's. */
export function evaluateOracleAgrees(
  expected: Pick<Gate55ShaderExpected, "steps">,
  logs: readonly OracleLog[],
  pairs: readonly [number, number][] = [[0, 1]],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const log of logs) {
    if (log.problem) {
      problems.push(`${log.leg} materials.jsonl: ${log.problem}`);
      continue;
    }
    if (log.lines.length !== expected.steps.length)
      problems.push(
        `${log.leg}: ${log.lines.length} oracle lines, expected ${expected.steps.length}`,
      );
    for (const s of expected.steps) {
      const o = log.lines.find((l) => l.step === s.step);
      if (!o) {
        problems.push(`${log.leg} step ${s.step}: no oracle line`);
        continue;
      }
      if (o.frame !== s.settle_frame)
        problems.push(
          `${log.leg} step ${s.step}: frame ${o.frame}, expected ${s.settle_frame}`,
        );
      for (const list of ["shaders", "materials"] as const)
        for (const want of s.oracle[list]) {
          const got = (o[list] as { name: string; status: string }[]).find(
            (x) => x.name === want.name,
          );
          if (!got || got.status !== want.status)
            problems.push(
              `${log.leg} step ${s.step} ${want.name}: status ${got?.status ?? "missing"}, expected ${want.status}`,
            );
        }
      for (const want of s.oracle.materials) {
        if (want.status !== "live") continue;
        const got = o.materials.find((m) => m.name === want.name);
        for (const p of want.params ?? []) {
          const g = got?.params?.find((x) => x.name === p.name);
          compared++;
          if (!g || g.type !== p.type || !jsonEqual(g.value, p.value))
            problems.push(
              `${log.leg} step ${s.step} ${want.name}.${p.name}: ${JSON.stringify(g ? { type: g.type, value: g.value } : null)} != ${JSON.stringify({ type: p.type, value: p.value })}`,
            );
        }
        if ((got?.params?.length ?? 0) !== (want.params ?? []).length)
          problems.push(
            `${log.leg} step ${s.step} ${want.name}: ${got?.params?.length ?? 0} params, expected ${(want.params ?? []).length}`,
          );
      }
      for (const want of s.oracle.items) {
        const got = o.items.find((i) => i.name === want.name);
        for (const p of want.instance_params) {
          const g = got?.instance_params.find((x) => x.name === p.name);
          compared++;
          if (!g || g.type !== p.type || !jsonEqual(g.value, p.value))
            problems.push(
              `${log.leg} step ${s.step} ${want.name} instance ${p.name}: ${JSON.stringify(g ? { type: g.type, value: g.value } : null)} != ${JSON.stringify({ type: p.type, value: p.value })}`,
            );
        }
      }
    }
  }
  for (const [a, b] of pairs) {
    const la = logs[a];
    const lb = logs[b];
    if (la && lb && la.text !== undefined && la.text !== lb.text)
      problems.push(`${la.leg} and ${lb.leg} materials.jsonl differ`);
  }
  return { problems, compared };
}

/** Pure: per step and live shader, the oracle's `shader_get_code` GRP1 hash, size and include
 * markers equal make_expected.py's preprocessor model; a hash changes between steps exactly when
 * the model's does (tint at 3, D14's code change); `include_markers` only on the include user. */
export function evaluateOracleShaderCode(
  expected: Pick<Gate55ShaderExpected, "steps">,
  log: OracleLog,
): {
  problems: string[];
  compared: number;
  table: Record<string, Record<string, string>>;
} {
  const problems: string[] = [];
  const table: Record<string, Record<string, string>> = {};
  let compared = 0;
  if (log.problem)
    return {
      problems: [`${log.leg} materials.jsonl: ${log.problem}`],
      compared,
      table,
    };
  for (const s of expected.steps) {
    const o = log.lines.find((l) => l.step === s.step);
    const row: Record<string, string> = {};
    for (const want of s.oracle.shaders) {
      if (want.status !== "live") {
        row[want.name] = want.status;
        continue;
      }
      const got = o?.shaders.find((x) => x.name === want.name);
      compared++;
      row[want.name] = (got?.sha256 ?? "missing").slice(0, 12);
      for (const key of [
        "sha256",
        "code_bytes",
        "payload_bytes",
        "include_markers",
      ] as const)
        if (got?.[key] !== want[key])
          problems.push(
            `${log.leg} step ${s.step} ${want.name}: ${key} ${JSON.stringify(got?.[key])}, model ${JSON.stringify(want[key])}`,
          );
    }
    table[String(s.step)] = row;
  }
  return { problems, compared, table };
}

// ---------------------------------------------------------------------------------------------
// The capture on the current wire
// ---------------------------------------------------------------------------------------------

/** Pure: counters.json over the capture equals expected.json's `counters` (the four material calls
 * the record hooks before calibrator 8, PH's phase on every frame included; the draws; the
 * textures). */
export function evaluateCounters(
  want: Gate55Counters,
  counts: Record<string, number> | undefined,
): { problems: string[]; measured: Record<string, number> } {
  const problems: string[] = [];
  const measured: Record<string, number> = {};
  if (!counts) return { problems: ["counters.json missing counts"], measured };
  for (const [op, n] of Object.entries(want.counts)) {
    measured[op] = counts[op] ?? 0;
    if ((counts[op] ?? 0) !== n)
      problems.push(`${op}: ${counts[op] ?? "absent"}, expected ${n}`);
  }
  for (const [op, n] of Object.entries(counts))
    if (op.startsWith("canvas_item_add_") && !(op in want.counts) && n !== 0)
      problems.push(`${op}: ${n} calls, expected none`);
  return { problems, measured };
}

/** Pure: no line of a capture host's stdout carries an engine shader-compile error (Q1f: the
 * dummy still compiles every shader, so a broken fixture shader prints here). */
export function evaluateShaderLogClean(
  logs: readonly { leg: string; text: string | undefined }[],
): { problems: string[] } {
  const problems: string[] = [];
  for (const l of logs) {
    if (l.text === undefined) {
      problems.push(`${l.leg} stdout.log missing`);
      continue;
    }
    const bad = l.text
      .split("\n")
      .filter((line) => SHADER_ERROR_PATTERNS.some((p) => line.includes(p)));
    if (bad.length > 0)
      problems.push(
        `${l.leg}: ${bad.length} shader error lines, e.g. ${JSON.stringify(bad[0])}`,
      );
  }
  return { problems };
}

/** Pure: on the pre-/5 wire the capture classifies `unsupported`; its unsupported ops are exactly
 * `typed.ops`, every entry `typed.reason` (draw-index ties aside); at every settle frame the items
 * carrying an entry are exactly `typed.items`; and no item's content_version moves over the run
 * except the marker's (a parameter, instance parameter, code or material change is not content,
 * D9: TI's pixels change at 1, 3 and 4 with its commands recorded once). */
export function evaluateShaderCaptureTyped(
  expected: Pick<
    Gate55ShaderExpected,
    "typed" | "creation_order" | "steps" | "last_step"
  >,
  capture: Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full">,
): { problems: string[]; ops: string[]; versions: Record<string, number[]> } {
  const problems: string[] = [];
  if (capture.result_class !== "unsupported")
    problems.push(
      `class ${capture.result_class}, expected unsupported: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(capture.full);
  if (JSON.stringify(ops) !== JSON.stringify([...expected.typed.ops].sort()))
    problems.push(
      `unsupported ops ${JSON.stringify(ops)} != ${JSON.stringify(expected.typed.ops)}`,
    );
  for (const t of capture.full.transactions)
    for (const u of t.meta.unsupported)
      if (u.reason !== expected.typed.reason && u.reason !== "draw-index-tie")
        problems.push(`frame ${t.meta.frame}: unsupported ${u.op} ${u.reason}`);
  const ids = new Set<number>();
  for (const t of capture.full.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length !== expected.creation_order.length)
    problems.push(
      `${sorted.length} item ids, expected ${expected.creation_order.length}`,
    );
  const nameOf = new Map(
    sorted.map((id, k) => [id, expected.creation_order[k]]),
  );
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
    const typed = t.meta.unsupported
      .filter((u) => expected.typed.ops.includes(u.op) && u.item !== null)
      .map((u) => nameOf.get(u.item as number) ?? `#${u.item}`)
      .sort();
    const want = [...expected.typed.items].sort();
    if (JSON.stringify(typed) !== JSON.stringify(want))
      problems.push(
        `step ${s.step}: typed items ${JSON.stringify(typed)} != ${JSON.stringify(want)}`,
      );
  }
  const versions: Record<string, Set<number>> = {};
  for (const t of capture.full.transactions)
    for (const i of t.meta.items) {
      const name = nameOf.get(i.id) ?? `#${i.id}`;
      const seen = versions[name] ?? new Set<number>();
      seen.add(i.content_version);
      versions[name] = seen;
    }
  for (const [name, v] of Object.entries(versions))
    if (name !== "Marker" && v.size !== 1)
      problems.push(
        `${name}'s content_version takes ${v.size} values over the run (${[...v].join(",")}), expected one`,
      );
  return {
    problems,
    ops,
    versions: Object.fromEntries(
      Object.entries(versions).map(([k, v]) => [k, [...v]]),
    ),
  };
}

/** Pure: a leg's steps.jsonl lists steps 0..last at S + N*k (settle +7). */
export function evaluateStepLog(
  expected: Pick<
    Gate55ShaderExpected,
    "steps" | "start_frame_default" | "step_frames_default" | "settle_offset"
  >,
  leg: string,
  got: StepLine[] | undefined,
): string[] {
  const want = expected.steps.map((s) => ({
    step: s.step,
    applied_frame: s.applied_frame,
    settle_frame: s.settle_frame,
  }));
  return JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`${leg} steps.jsonl ${JSON.stringify(got)} != expected`];
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface Gate55LegEntry {
  group: string;
  expected_class: string | null;
  result_class: string | null;
  reasons: string[];
  harmless_ties?: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate55cResult {
  checks: Gate5Check[];
  legs: Record<string, Gate55LegEntry>;
  checkpoints: Gate5Checkpoint[];
  materials: Record<string, unknown>;
  budgets: RegionBudget5[];
  freshness: Record<string, string[]>;
}

function captureLeg(capture: Gate3CaptureEvaluation): Gate55LegEntry {
  return {
    group: "g55c",
    expected_class: capture.expected_class,
    result_class: capture.result_class,
    reasons: capture.reasons,
    harmless_ties: capture.harmless_ties,
    exit_code: capture.exit_code,
    artifacts: capture.artifacts,
  };
}

async function supportLeg(dir: string): Promise<Gate55LegEntry> {
  const artifacts = [
    "argv.txt",
    "env.txt",
    "stdout.log",
    "exit-code.txt",
    "steps.jsonl",
    "materials.jsonl",
    RECORDING_NAME,
  ].map((p) => join(dir, p));
  return {
    group: "g55c",
    expected_class: null,
    result_class: null,
    reasons: [],
    exit_code: await readExitCode(dir),
    artifacts,
  };
}

export async function runGate55c(
  outDir: string,
  expected: Gate55ShaderExpected,
): Promise<Gate55cResult> {
  const dir = join(outDir, G55C_LEG_DIR);
  const refusedDir = join(outDir, G55C_REFUSED_DIR);
  const refused = refusedView(expected);
  const e5 = asGate5(expected);
  const r5 = asGate5(refused);
  const rasters = rastersOf(e5);
  const refusedRasters = rastersOf(r5);
  const checks: Gate5Check[] = [
    checkShaderExpectedSelfConsistent(expected, rasters),
    checkShaderExpectedSelfConsistent(
      refused,
      refusedRasters,
      "refused-expected-self-consistent",
    ),
  ];

  const capture = await evaluateCapture(dir, { expectedClass: "unsupported" });
  const refusedCapture = await evaluateCapture(refusedDir, {
    expectedClass: "unsupported",
  });
  const counters = await readJson<{ counts?: Record<string, number> }>(
    join(dir, "capture", "evidence", "counters.json"),
  );
  const refusedCounters = await readJson<{ counts?: Record<string, number> }>(
    join(refusedDir, "capture", "evidence", "counters.json"),
  );
  const oracles = [
    await loadOracle(dir, ORACLE_LEGS[0], "reference-shader"),
    await loadOracle(dir, ORACLE_LEGS[1], "reference-shader-repeat"),
  ];
  const refusedOracle = await loadOracle(
    refusedDir,
    "reference",
    "reference-refused",
  );
  const reference = await loadShots5(dir, "reference", e5);
  const repeat = await loadShots5(dir, "reference-repeat", e5);
  const armed = await loadShots5(dir, "reference-armed", e5);
  const refusedShots = await loadShots5(refusedDir, "reference", r5);

  const image = evaluateExpectedImage5(
    e5,
    "reference-shader",
    reference,
    rasters,
    join(dir, "reference", "shots"),
  );
  const presence = evaluatePresence5(
    e5,
    "reference-shader",
    reference,
    rasters,
  );
  const fresh = evaluateFreshness5(e5, "reference-shader", reference);
  const repeatCmp = compareLegs5(e5, reference, repeat, rasters, [
    "reference-shader",
    "reference-shader-repeat",
  ]);
  const armedCmp = compareLegs5(e5, reference, armed, rasters, [
    "reference-shader",
    "reference-shader-armed",
  ]);
  const armedResult = await readJson<CaptureResultJson>(
    join(dir, "reference-armed", "evidence", "result.json"),
  );
  if (armedResult?.status !== "armed")
    armedCmp.problems.unshift(
      `reference-shader-armed result.json status=${JSON.stringify(armedResult?.status)}`,
    );
  if (armedResult?.stream?.status !== "closed")
    armedCmp.problems.unshift(
      `reference-shader-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
    );
  const refusedImage = evaluateExpectedImage5(
    r5,
    "reference-refused",
    refusedShots,
    refusedRasters,
    join(refusedDir, "reference", "shots"),
  );
  const refusedPresence = evaluatePresence5(
    r5,
    "reference-refused",
    refusedShots,
    refusedRasters,
  );

  const typed = evaluateShaderCaptureTyped(expected, capture);
  const refusedTyped = evaluateShaderCaptureTyped(refused, refusedCapture);
  // fresh-without-redraw: TI changes pixels at 1, 3 and 4 while its commands are recorded once.
  const freshProblems = [...fresh.problems];
  for (const k of [1, 3, 4])
    if (!fresh.table[String(k)]?.includes("TI"))
      freshProblems.push(`step ${k}: TI's pixels did not change`);
  if ((typed.versions.TI ?? []).length !== 1)
    freshProblems.push(
      `TI's content_version takes ${(typed.versions.TI ?? []).length} values in the capture`,
    );

  const oracle = evaluateOracleAgrees(expected, oracles);
  const refusedOracleAgrees = evaluateOracleAgrees(
    refused,
    [refusedOracle],
    [],
  );
  const code = evaluateOracleShaderCode(expected, oracles[0]);
  const refusedCode = evaluateOracleShaderCode(refused, refusedOracle);
  const counts = evaluateCounters(expected.counters, counters?.counts);
  const refusedCounts = evaluateCounters(
    refused.counters,
    refusedCounters?.counts,
  );
  const logClean = evaluateShaderLogClean([
    {
      leg: "capture-shader",
      text: await readTextOrUndefined(join(dir, "capture", "stdout.log")),
    },
    {
      leg: "capture-refused",
      text: await readTextOrUndefined(
        join(refusedDir, "capture", "stdout.log"),
      ),
    },
  ]);

  const supportProblems: string[] = [];
  for (const leg of G55C_SUPPORT_LEGS) {
    const code = await readExitCode(
      leg === "import" ? join(dir, "import", "fixture") : join(dir, leg),
    );
    if (code !== 0) supportProblems.push(`${leg} exit ${code ?? "<none>"}`);
  }
  const refusedRefCode = await readExitCode(join(refusedDir, "reference"));
  if (refusedRefCode !== 0)
    supportProblems.push(
      `reference-refused exit ${refusedRefCode ?? "<none>"}`,
    );
  const refusedStepProblems = [
    ...evaluateStepLog(
      refused,
      "capture-refused",
      parseStepLog(
        await readTextOrUndefined(join(refusedDir, "capture", "steps.jsonl")),
      ),
    ),
    ...evaluateStepLog(
      refused,
      "reference-refused",
      parseStepLog(
        await readTextOrUndefined(join(refusedDir, "reference", "steps.jsonl")),
      ),
    ),
  ];

  checks.push(
    rename(
      await checkCaptureArmed(dir, {
        captureResult: capture.captureResult,
        recording: capture.full,
      }),
      "shader-capture-armed",
    ),
    rename(await checkHeadlessNoGpuGate0(dir), "shader-headless-no-gpu"),
    rename(
      checkRecordingsDecode(capture.full, capture.patch),
      "shader-recording-decodes",
    ),
    rename(
      checkPatchResolvesToFull(capture.full, capture.patch),
      "shader-patch-resolves-to-full",
    ),
    rename(
      await checkStepAlignment5(dir, e5, capture.full),
      "shader-step-alignment",
    ),
    rename(
      checkNoDrawIndexTies(capture.full).check,
      "shader-no-draw-index-ties",
    ),
    rename(
      await checkCaptureArmed(refusedDir, {
        captureResult: refusedCapture.captureResult,
        recording: refusedCapture.full,
      }),
      "refused-capture-armed",
    ),
    rename(
      checkRecordingsDecode(refusedCapture.full, refusedCapture.patch),
      "refused-recording-decodes",
    ),
    check(
      "refused-step-alignment",
      "capture-refused and reference-refused steps.jsonl list steps 0..9 at S+N*k (settle +7)",
      refusedStepProblems,
      "both step logs as expected",
      [
        join(refusedDir, "capture", "steps.jsonl"),
        join(refusedDir, "reference", "steps.jsonl"),
      ],
    ),
    check(
      "shader-counters",
      "each capture's counters.json equals expected.json counters: shader_create_from_code, shader_set_code, material_set_param (PH's phase on every frame of 400 included) and canvas_item_set_material as the fixture calls them, its rect and texture-rect draws and the three textures; every other canvas_item_add_* is 0",
      [
        ...counts.problems.map((p) => `capture-shader: ${p}`),
        ...refusedCounts.problems.map((p) => `capture-refused: ${p}`),
      ],
      Object.entries(counts.measured)
        .map(([op, n]) => `${op.replace("canvas_item_", "")} ${n}`)
        .join(", "),
      [
        join(dir, "capture", "evidence", "counters.json"),
        join(refusedDir, "capture", "evidence", "counters.json"),
      ],
    ),
    check(
      "capture-shader-log-clean",
      "neither capture host printed a shader compile error (SHADER ERROR / Shader compilation failed): the dummy compiles every shader it is given (Q1f), the refused ones included",
      logClean.problems,
      "capture-shader and capture-refused stdout carry no shader error",
      [
        join(dir, "capture", "stdout.log"),
        join(refusedDir, "capture", "stdout.log"),
      ],
    ),
    check(
      "oracle-agrees",
      "both reference legs' material oracle (material_get_param and canvas_item_get_instance_shader_parameter on the reference) report, at every settle step, each shader's and material's status and every declared parameter and instance parameter with the Variant type and value expected.json derives from the fixture's own calls (D12 (1), (3)); the reference-refused oracle likewise; the two reference logs are byte-identical",
      [...oracle.problems, ...refusedOracleAgrees.problems],
      `${oracle.compared} parameter values agree on 2 legs, ${refusedOracleAgrees.compared} on reference-refused; reference logs byte-identical`,
      [...oracles.map((o) => o.path), refusedOracle.path],
    ),
    check(
      "shader-code-model",
      "at every settle step each live fixture shader's code as the reference holds it (shader_get_code, GRP1 hashed by the oracle) equals make_expected.py's port of the shader preprocessor: size, include markers (tint only) and SHA-256, with tint's hash changing at step 3 alone",
      [...code.problems, ...refusedCode.problems],
      `${code.compared + refusedCode.compared} shader-steps agree with the model`,
      [oracles[0].path, refusedOracle.path],
    ),
    check(
      "shader-expected-image-reference",
      "every reference-shader shot equals the raster of expected.json on every decided pixel: each region is the Python twin of its synthetic fragment() at that step's parameters, flat and opaque (exact, D13)",
      image.problems,
      `${image.checkpoints.length} shots match on ${image.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels`,
      shotPaths5(dir, "reference", e5),
    ),
    check(
      "shader-presence-reference",
      "in every reference-shader shot every item's shape covers at least half its expected area with pixels differing from what lies beneath it",
      presence.problems,
      `${presence.shapes} shape-shots present`,
      shotPaths5(dir, "reference", e5),
    ),
    check(
      "shader-freshness-reference",
      "between consecutive reference-shader shots a region changes exactly when expected.json says fresh, including fresh-without-redraw: TI changes at 1 (a parameter), 3 (a code change) and 4 (a parameter erased) with its content_version constant in the capture, PH at every step (its phase)",
      freshProblems,
      Object.entries(fresh.table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" "),
      shotPaths5(dir, "reference", e5),
    ),
    check(
      "shader-reference-repeat-budget",
      "reference-shader vs reference-shader-repeat (same build, GPU and driver): identical at every pixel of every shot -- the budget is what this measures (D13 expects 0)",
      repeatCmp.problems,
      `budget 0: ${expected.steps.length} shot pairs identical`,
      [
        ...shotPaths5(dir, "reference", e5),
        ...shotPaths5(dir, "reference-repeat", e5),
      ],
    ),
    check(
      "shader-armed-transparent",
      "reference-shader-armed (extension armed, stream on, oracle off) armed with its stream closed, and every shot equals the reference's exactly",
      armedCmp.problems,
      `${expected.steps.length} armed shots byte-identical to the reference`,
      shotPaths5(dir, "reference-armed", e5),
    ),
    check(
      "refused-expected-image-reference",
      "every reference-refused shot equals the refused variant's raster on every decided pixel: the main regions as reference-shader, TIME (.2,.4,.6), the screen texture's inverse of the clear colour (.8,.8,.6), SDF (.4,.2,.8), the global uniform (.6,.2,.4) and the spatial material drawn as no material (.4,.6,.2)",
      [...refusedImage.problems, ...refusedPresence.problems],
      `${refusedImage.checkpoints.length} shots match on ${refusedImage.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels; ${refusedPresence.shapes} shape-shots present`,
      shotPaths5(refusedDir, "reference", r5),
    ),
    check(
      "shader-support-legs-exit",
      "the g55c import, reference-shader, reference-shader-repeat, reference-shader-armed and reference-refused legs exited 0",
      supportProblems,
      `${G55C_SUPPORT_LEGS.length + 1} support legs exited 0`,
      [],
    ),
    check(
      "leg-class-capture-shader",
      "the capture-shader leg classifies as unsupported on the pre-/5 wire: armed, stream closed, both sinks valid, the only unsupported op canvas_item_set_material (unsupported-state) on exactly the eight material items at every settle frame, and no item's content_version moves but the marker's",
      typed.problems,
      `${capture.result_class}: ${typed.ops.join(", ")} typed; content_version per item ${Object.entries(
        typed.versions,
      )
        .map(([k, v]) => `${k}:${v.length}`)
        .join(" ")}`,
      capture.artifacts,
    ),
    check(
      "leg-class-capture-refused",
      "the capture-refused leg classifies as unsupported on the pre-/5 wire with the same typing over its thirteen material items",
      refusedTyped.problems,
      `${refusedCapture.result_class}: ${refusedTyped.ops.join(", ")} typed`,
      refusedCapture.artifacts,
    ),
  );

  const legs: Gate55cResult["legs"] = {
    "capture-shader": captureLeg(capture),
    "capture-refused": captureLeg(refusedCapture),
    "import-shader": await supportLeg(join(dir, "import", "fixture")),
    "reference-shader": await supportLeg(join(dir, "reference")),
    "reference-shader-repeat": await supportLeg(join(dir, "reference-repeat")),
    "reference-shader-armed": await supportLeg(join(dir, "reference-armed")),
    "reference-refused": await supportLeg(join(refusedDir, "reference")),
  };

  return {
    checks,
    legs,
    checkpoints: [...image.checkpoints, ...refusedImage.checkpoints],
    materials: {
      counters: counts.measured,
      refused_counters: refusedCounts.measured,
      shader_hashes: code.table,
      refused_shader_hashes: refusedCode.table,
      content_versions: typed.versions,
    },
    budgets: repeatCmp.budgets,
    freshness: fresh.table,
  };
}
