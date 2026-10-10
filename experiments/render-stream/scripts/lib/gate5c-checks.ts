// Gate 5c checks (protocol/gate5-design.md "G5c", "Q6d", "Q6e"): the mesh fixture
// (fixtures/gate5-mesh), its mesh oracle and the mesh census.
//
// Everything here reads an evidence directory written by run-gate5.sh's g5c group, or is pure over
// values already read from one, so scripts/test/self-test-gate5c.ts can drive each check with
// synthetic values. Nothing launches a process. Classification never reads `session.sabotage`.
//
// Three independent records of every mesh meet here, none a replay of another (D12):
//   - make_expected.py's model: every surface's bytes from the fixture's own numbers and the
//     engine's packing rules, so a predicted GRM1 hash per surface and step, a hand census of every
//     mesh call per frame, and a coverage model rasterized by lib/geometry-raster.ts;
//   - the capture's hook log (evidence/resources.jsonl `kind:"mesh"` lines, G5a), the ground
//     truth for what happened to meshes and when, with a whole-surface GRM1 hash per change;
//   - the reference's mesh oracle (mesh_oracle.gd), which reads the rendered reference's own GPU
//     buffers back through RenderingServer.mesh_get_surface and hashes them as GRM1.
// On render-stream/3 no mesh reaches the wire: canvas_item_add_mesh is a typed `unsupported`
// command, so the capture leg classifies `unsupported` (G5e moves meshes onto /4).
//
// Evidence layout under <out>/mesh/ (see scripts/README.md "Gate 5"):
//   import/fixture/                editor --import of fixtures/gate5-mesh
//   capture/                       400-frame capture host, GRC_ROOT_SIZE=enforce-min-size:
//                                  evidence/ (result, counters, resources.jsonl, ...),
//                                  recording.rs2, recording-patch.rs2, store/, steps.jsonl,
//                                  strace.txt, maps.txt
//   reference/, reference-repeat/  rendered fixture, extension absent, mesh oracle on:
//                                  shots/step-<k>.png, steps.jsonl, meshes.jsonl
//   reference-armed/               rendered, extension armed with a full-sink stream, oracle off:
//                                  shots, steps.jsonl, evidence/ (its own hook log), recording.rs2

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
import { loadResourceLog, parseJsonl, type ResourceLine } from "./gate2-checks";
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
  Gate5Call,
  Gate5Expected,
  Gate5Item,
  Gate5Op,
  Gate5Texture,
  Rgba8,
} from "./gate5-expected";
import type { Gate5Raster } from "./geometry-raster";

// ---------------------------------------------------------------------------------------------
// expected.json (render-stream-gate5-mesh-expected/1, fixtures/gate5-mesh/make_expected.py)
// ---------------------------------------------------------------------------------------------

export interface MeshSurfaceView {
  primitive: string;
  format: number;
  vertex_count: number;
  index_count: number;
  sha256: string;
}

/** One fixture mesh as the oracle reports it (and make_expected.py predicts it). */
export interface MeshView {
  name: string;
  status: "live" | "freed" | "absent";
  surface_count?: number;
  /** position x, y, z, size x, y, z; all zero = none */
  custom_aabb?: number[];
  surfaces?: MeshSurfaceView[];
}

/** [mesh name, op, version, surface | null, buffer | null] */
export type CensusLine = [string, string, number, number | null, string | null];

export interface DfRule {
  mesh: string;
  from_frame: number;
  /** null: until the leg's quit frame */
  to_frame: number | null;
  base_version: number;
}

export interface Gate5MeshStep {
  step: number;
  applied_frame: number;
  settle_frame: number;
  change: string;
  marker_rgba8: Rgba8;
  canvas_transform: Affine;
  redraws: string[];
  /** each item's recorded RS commands at the settle frame */
  commands: Record<string, Gate5Call[]>;
  items: Gate5Item[];
  /** per fixture mesh, in creation order, what the oracle must report */
  meshes: MeshView[];
  fresh: Record<string, boolean>;
}

export interface Gate5MeshExpected {
  schema: "render-stream-gate5-mesh-expected/1";
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
  band_regions: string[];
  marker_rect: [number, number, number, number];
  exact_edge_px: number;
  textures: Record<string, Gate5Texture>;
  engine_textures: unknown[];
  mesh_order: string[];
  mesh_items: Record<string, string>;
  typed_ops: string[];
  draw_census: { quit_frame: number; counts: Record<string, number> };
  tie_free_edges_checked: number;
  census: {
    frames: Record<string, CensusLine[]>;
    df_rule: DfRule[];
    df_frame_ops: [string, string | null][];
  };
  op_lists: Record<string, Gate5Op[]>;
  steps: Gate5MeshStep[];
  predictions: Record<string, unknown>;
}

/** The G5b helpers read only the fields both expected files share (viewport, regions, steps with
 * items/fresh/marker, op_lists, textures, frame constants). */
export function asGate5(expected: Gate5MeshExpected): Gate5Expected {
  return expected as unknown as Gate5Expected;
}

export const G5C_LEG_DIR = "mesh";
export const G5C_CAPTURE_QUIT_FRAME = 400;
export const G5C_SUPPORT_LEGS = [
  "import",
  "reference",
  "reference-repeat",
  "reference-armed",
] as const;
const ORACLE_LEGS = ["reference", "reference-repeat"] as const;
const LEVELS = new Set([0, 51, 102, 153, 204, 255]);
const f32 = (v: number): number => Math.fround(v);

function rename(c: Gate5Check | Gate0Check, id: string): Gate5Check {
  return {
    ...c,
    id,
    status: c.passed ? "pass" : "fail",
  } as Gate5Check;
}

// ---------------------------------------------------------------------------------------------
// Rasters: DF is band (D13)
// ---------------------------------------------------------------------------------------------

/** rasterizeGate5 per step, with every pixel of a band region (DF: a texture under a non-affine
 * mapping) turned band: never synthesized, compared leg to leg only. */
export function meshRasters(
  expected: Gate5MeshExpected,
): Map<number, Gate5Raster> {
  const rasters = rastersOf(asGate5(expected));
  const [W] = expected.viewport;
  for (const r of rasters.values())
    for (const name of expected.band_regions) {
      const b = expected.regions[name];
      for (let y = b[1]; y < b[3]; y++)
        for (let x = b[0]; x < b[2]; x++) {
          const i = y * W + x;
          r.exact[i] = 0;
          r.delta[i] = 0;
          r.band[i] = 1;
        }
    }
  return rasters;
}

// ---------------------------------------------------------------------------------------------
// expected-self-consistent
// ---------------------------------------------------------------------------------------------

/** Pure: expected.json obeys its own rules, recomputed here independently of make_expected.py's
 * asserts: 640x360, steps 0..last with distinct grid marker colours, every colour on the 0.2 grid
 * at alpha 1, texels on the grid, regions disjoint inside the viewport, nothing synthesized outside
 * them, `fresh` as the raster says, every live mesh's surface_count its surface list's length and
 * every census line naming a mesh of mesh_order with versions rising per mesh. */
export function checkMeshExpectedSelfConsistent(
  expected: Gate5MeshExpected,
  rasters: Map<number, Gate5Raster>,
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
  for (const [key, ops] of Object.entries(expected.op_lists))
    for (const op of ops)
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
      problems.push(`step ${s.step}: ${outside} pixels outside every region`);
    if (s.meshes.map((m) => m.name).join() !== expected.mesh_order.join())
      problems.push(`step ${s.step}: meshes are not in mesh_order`);
    for (const m of s.meshes)
      if (m.status === "live" && m.surface_count !== m.surfaces?.length)
        problems.push(`step ${s.step} ${m.name}: surface_count != surfaces`);
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
  const last = new Map<string, number>();
  const expanded = expandCensus(expected, expected.capture_quit_frame);
  for (const f of [...expanded.keys()].sort((x, y) => x - y))
    for (const [mesh, op, version] of expanded.get(f) ?? []) {
      if (!expected.mesh_order.includes(mesh))
        problems.push(`census frame ${f}: unknown mesh ${mesh}`);
      const before = last.get(mesh) ?? 0;
      if (op === "free" ? version !== before : version !== before + 1)
        problems.push(
          `census frame ${f}: ${mesh} ${op} v${version} after v${before}`,
        );
      last.set(mesh, version);
    }
  return check(
    "mesh-expected-self-consistent",
    "fixtures/gate5-mesh/expected.json obeys its rules: 640x360, steps 0..last with distinct grid marker colours, every colour and texel on the 0.2 grid at alpha 1, regions disjoint with nothing synthesized outside them, fresh as the raster says, every live mesh's surface_count its surface list, census versions rising by one per accepted mesh call",
    problems,
    `${expected.steps.length} steps, ${Object.keys(expected.op_lists).length} op lists, ${expected.mesh_order.length} meshes, ${expected.tie_free_edges_checked} tie-free edges`,
    [],
  );
}

// ---------------------------------------------------------------------------------------------
// The census: the hook log's mesh lines per frame
// ---------------------------------------------------------------------------------------------

/** Every mesh line expected up to `quitFrame`: census.frames plus DF's per-frame rule (three lines
 * a frame, each version + 1), as make_expected.py's expand_census. */
export function expandCensus(
  expected: Pick<Gate5MeshExpected, "census">,
  quitFrame: number,
): Map<number, CensusLine[]> {
  const out = new Map<number, CensusLine[]>();
  for (const [f, lines] of Object.entries(expected.census.frames))
    out.set(
      Number(f),
      lines.map((l) => [...l] as CensusLine),
    );
  for (const r of expected.census.df_rule) {
    const last = Math.min(r.to_frame ?? quitFrame, quitFrame);
    for (let f = r.from_frame; f <= last; f++) {
      const base = r.base_version + 3 * (f - r.from_frame);
      const list = out.get(f) ?? [];
      expected.census.df_frame_ops.forEach(([op, buffer], k) => {
        list.push([r.mesh, op, base + k + 1, buffer ? 0 : null, buffer]);
      });
      out.set(f, list);
    }
  }
  for (const f of [...out.keys()]) if (f > quitFrame) out.delete(f);
  return out;
}

/** The hook log's mesh ids by fixture name: the k-th mesh the log creates is mesh_order[k]. */
export function meshNamesById(
  lines: readonly ResourceLine[],
  order: readonly string[],
): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of lines)
    if (
      l.kind === "mesh" &&
      (l.op === "mesh_create" || l.op === "mesh_create_from_surfaces") &&
      l.id !== null &&
      !out.has(l.id)
    )
      out.set(l.id, order[out.size] ?? `#${l.id}`);
  return out;
}

const censusText = (l: CensusLine): string =>
  `${l[0]} ${l[1]} v${l[2]}${l[3] !== null ? ` s${l[3]}` : ""}${l[4] ? ` ${l[4]}` : ""}`;

/** Pure: the hook log's mesh lines up to `quitFrame`, frame by frame, equal the expanded census
 * (as multisets per frame: the order across meshes within a frame is not a contract, versions
 * order each mesh's own lines). Every line is on the main thread, `applied` (a free: no outcome),
 * no sabotage; ids are 1.. in mesh_order. Lines after the quit frame (teardown) are reported. */
export function evaluateMeshCensus(
  expected: Gate5MeshExpected,
  lines: readonly ResourceLine[],
  quitFrame: number,
): {
  problems: string[];
  per_frame: Record<string, number>;
  after_quit: number;
} {
  const problems: string[] = [];
  const mesh = lines.filter((l) => l.kind === "mesh");
  const names = meshNamesById(mesh, expected.mesh_order);
  [...names.keys()].forEach((id, k) => {
    if (id !== k + 1)
      problems.push(
        `mesh id ${id} is the ${k + 1}th created (ids must be 1..)`,
      );
  });
  if (names.size !== expected.mesh_order.length)
    problems.push(
      `${names.size} meshes created, expected ${expected.mesh_order.length} (${expected.mesh_order.join(", ")})`,
    );
  const got = new Map<number, string[]>();
  let afterQuit = 0;
  for (const l of mesh) {
    if (l.frame > quitFrame) {
      afterQuit++;
      continue;
    }
    if (l.thread !== "main")
      problems.push(`frame ${l.frame}: ${l.op} off the main thread`);
    const extra = l as unknown as { sabotage?: boolean };
    if (extra.sabotage) problems.push(`frame ${l.frame}: sabotage line`);
    const outcomeOk =
      l.op === "free" ? l.status === "freed" : l.outcome === "applied";
    if (!outcomeOk)
      problems.push(
        `frame ${l.frame}: ${l.op} outcome ${l.outcome} status ${l.status}`,
      );
    const name = l.id !== null ? (names.get(l.id) ?? `#${l.id}`) : "?";
    const text = censusText([
      name,
      l.op,
      l.version ?? -1,
      l.op === "mesh_create" ||
      l.op === "free" ||
      l.op === "mesh_clear" ||
      l.op === "mesh_set_custom_aabb"
        ? null
        : l.surface,
      l.buffer,
    ]);
    const list = got.get(l.frame) ?? [];
    list.push(text);
    got.set(l.frame, list);
  }
  const want = expandCensus(expected, quitFrame);
  const frames = new Set([...got.keys(), ...want.keys()]);
  const perFrame: Record<string, number> = {};
  let reported = 0;
  for (const f of [...frames].sort((a, b) => a - b)) {
    const g = (got.get(f) ?? []).slice().sort();
    const w = (want.get(f) ?? []).map(censusText).sort();
    perFrame[String(f)] = g.length;
    if (JSON.stringify(g) !== JSON.stringify(w) && reported++ < 6)
      problems.push(
        `frame ${f}: hook log [${g.join("; ")}] != census [${w.join("; ")}]`,
      );
  }
  if (reported > 6) problems.push(`... ${reported - 6} more frames differ`);
  return { problems, per_frame: perFrame, after_quit: afterQuit };
}

// ---------------------------------------------------------------------------------------------
// Hook hashes, the oracle and the model
// ---------------------------------------------------------------------------------------------

/** Pure: the hook log's surface hashes per mesh name at the end of each frame in `frames`
 * (ascending), replaying its lines (an add appends, a region update replaces its surface, a remove
 * renumbers, a clear empties, a single-surface create_from_surfaces sets it, a free leaves `null`).
 * A create_from_surfaces of several surfaces names none of them (`?`). */
export function replayHookHashes(
  lines: readonly ResourceLine[],
  order: readonly string[],
  frames: readonly number[],
): Map<number, Map<string, string[] | null>> {
  const mesh = lines.filter((l) => l.kind === "mesh");
  const names = meshNamesById(mesh, order);
  const state = new Map<string, string[] | null>();
  const out = new Map<number, Map<string, string[] | null>>();
  let k = 0;
  for (const f of frames) {
    while (k < mesh.length && mesh[k].frame <= f) {
      const l = mesh[k++];
      const name = l.id !== null ? names.get(l.id) : undefined;
      if (!name) continue;
      const list = state.get(name) ?? [];
      switch (l.op) {
        case "mesh_create":
          state.set(name, []);
          break;
        case "mesh_create_from_surfaces":
          state.set(name, [l.hash ?? "?"]);
          break;
        case "mesh_add_surface":
          state.set(name, [...list, l.hash ?? "?"]);
          break;
        case "mesh_surface_remove":
          if (l.surface !== null)
            state.set(
              name,
              list.filter((_, i) => i !== l.surface),
            );
          break;
        case "mesh_clear":
          state.set(name, []);
          break;
        case "free":
          state.set(name, null);
          break;
        default:
          if (l.op.startsWith("mesh_surface_update_") && l.surface !== null) {
            const next = [...list];
            next[l.surface] = l.hash ?? "?";
            state.set(name, next);
          }
      }
    }
    out.set(f, new Map(state));
  }
  return out;
}

export interface OracleLine {
  schema: string;
  step: number;
  frame: number;
  p2_rid_verified: boolean;
  meshes: MeshView[];
}

export function validateOracleLine(value: unknown): string | null {
  if (value === null || typeof value !== "object") return "not an object";
  const v = value as Partial<OracleLine>;
  if (v.schema !== "render-stream-gate5-meshes/1") return "schema";
  if (!Number.isInteger(v.step) || !Number.isInteger(v.frame))
    return "step/frame";
  if (typeof v.p2_rid_verified !== "boolean") return "p2_rid_verified";
  if (!Array.isArray(v.meshes)) return "meshes";
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
  meshDir: string,
  leg: string,
): Promise<OracleLog> {
  const path = join(meshDir, leg, "meshes.jsonl");
  const text = await readTextOrUndefined(path);
  const parsed = parseJsonl<OracleLine>(text, validateOracleLine);
  return { leg, path, text, lines: parsed.lines, problem: parsed.problem };
}

const aabbEq = (a: number[] | undefined, b: number[] | undefined): boolean =>
  !!a &&
  !!b &&
  a.length === 6 &&
  b.length === 6 &&
  a.every((v, i) => f32(v) === f32(b[i]));

/** Pure: each oracle log has one line per step at its settle frame, the derived Polygon2D RID read
 * back as its polygon, and per mesh the status, surface count, custom AABB and per surface the
 * primitive, format, vertex and index counts of expected.json; the two reference legs' logs are
 * byte-identical. Hashes are mesh-hook-hash-parity's. */
export function evaluateOracleAgrees(
  expected: Gate5MeshExpected,
  logs: readonly OracleLog[],
): { problems: string[] } {
  const problems: string[] = [];
  for (const log of logs) {
    if (log.problem) {
      problems.push(`${log.leg} meshes.jsonl: ${log.problem}`);
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
      if (!o.p2_rid_verified)
        problems.push(
          `${log.leg} step ${s.step}: the derived Polygon2D mesh RID did not read back as its polygon`,
        );
      for (const want of s.meshes) {
        const got = o.meshes.find((m) => m.name === want.name);
        const where = `${log.leg} step ${s.step} ${want.name}`;
        if (!got) {
          problems.push(`${where}: missing`);
          continue;
        }
        if (got.status !== want.status) {
          problems.push(
            `${where}: status ${got.status}, expected ${want.status}`,
          );
          continue;
        }
        if (want.status !== "live") continue;
        if (got.surface_count !== want.surface_count)
          problems.push(
            `${where}: ${got.surface_count} surfaces, expected ${want.surface_count}`,
          );
        if (!aabbEq(got.custom_aabb, want.custom_aabb))
          problems.push(
            `${where}: custom AABB ${got.custom_aabb}, expected ${want.custom_aabb}`,
          );
        (want.surfaces ?? []).forEach((ws, k) => {
          const gs = got.surfaces?.[k];
          const fields = [
            "primitive",
            "format",
            "vertex_count",
            "index_count",
          ] as const;
          for (const key of fields)
            if (gs?.[key] !== ws[key])
              problems.push(
                `${where} s${k}: ${key} ${gs?.[key]}, expected ${ws[key]}`,
              );
        });
      }
    }
  }
  if (
    logs.length === 2 &&
    logs[0].text !== undefined &&
    logs[0].text !== logs[1].text
  )
    problems.push(`${logs[0].leg} and ${logs[1].leg} meshes.jsonl differ`);
  return { problems };
}

/** Pure: at every settle step, for every live fixture mesh, the hook log's last surface hashes of
 * that frame (each host given) equal the oracle's GPU readback hashes, and both equal
 * make_expected.py's GRM1 model; a freed or absent mesh is freed or absent in the log too. */
export function evaluateHashParity(
  expected: Gate5MeshExpected,
  oracle: OracleLog,
  hosts: readonly { leg: string; lines: readonly ResourceLine[] }[],
): { problems: string[]; table: Record<string, Record<string, string>> } {
  const problems: string[] = [];
  const table: Record<string, Record<string, string>> = {};
  const frames = expected.steps.map((s) => s.settle_frame);
  const replays = hosts.map((h) => ({
    leg: h.leg,
    at: replayHookHashes(h.lines, expected.mesh_order, frames),
  }));
  let compared = 0;
  for (const s of expected.steps) {
    const o = oracle.lines.find((l) => l.step === s.step);
    const row: Record<string, string> = {};
    for (const want of s.meshes) {
      const where = `step ${s.step} ${want.name}`;
      const model =
        want.status === "live"
          ? (want.surfaces ?? []).map((x) => x.sha256)
          : null;
      const om = o?.meshes.find((m) => m.name === want.name);
      const fromOracle =
        om?.status === "live" ? (om.surfaces ?? []).map((x) => x.sha256) : null;
      if (want.status === "live") {
        row[want.name] = (model ?? []).map((h) => h.slice(0, 12)).join("+");
        if (JSON.stringify(fromOracle) !== JSON.stringify(model))
          problems.push(
            `${where}: oracle ${JSON.stringify(fromOracle)} != model ${JSON.stringify(model)}`,
          );
        else compared += model?.length ?? 0;
      } else row[want.name] = want.status;
      for (const r of replays) {
        const hook = r.at.get(s.settle_frame)?.get(want.name);
        const hookWant =
          want.status === "live"
            ? model
            : want.status === "freed"
              ? null
              : undefined;
        if (JSON.stringify(hook) !== JSON.stringify(hookWant))
          problems.push(
            `${where}: ${r.leg} hook ${JSON.stringify(hook)} != ${JSON.stringify(hookWant)}`,
          );
      }
    }
    table[String(s.step)] = row;
  }
  return {
    problems,
    table: { ...table, _compared: { surfaces: String(compared) } },
  };
}

// ---------------------------------------------------------------------------------------------
// The capture: counters and typed commands
// ---------------------------------------------------------------------------------------------

/** Pure: counters.json over the capture run equals expected.json draw_census (one add_mesh per
 * item draw, DF every frame; the mesh calls; attach_skeleton per Polygon2D draw and once more in its
 * destructor at teardown), and every other canvas_item_add_* is 0. */
export function evaluateDrawCensus(
  expected: Pick<Gate5MeshExpected, "draw_census">,
  counts: Record<string, number> | undefined,
): { problems: string[]; measured: Record<string, number> } {
  const problems: string[] = [];
  const measured: Record<string, number> = {};
  if (!counts) return { problems: ["counters.json missing counts"], measured };
  for (const [op, want] of Object.entries(expected.draw_census.counts)) {
    measured[op] = counts[op] ?? 0;
    if ((counts[op] ?? 0) !== want)
      problems.push(`${op}: ${counts[op] ?? "absent"}, expected ${want}`);
  }
  for (const [op, n] of Object.entries(counts))
    if (
      op.startsWith("canvas_item_add_") &&
      !(op in expected.draw_census.counts) &&
      n !== 0
    )
      problems.push(`${op}: ${n} calls, expected none`);
  return { problems, measured };
}

/** Pure: the capture classifies `unsupported`; its unsupported ops are exactly typed_ops, all
 * `unsupported-op`; at every settle frame each item's commands are its expected list (add_rect
 * float32-exact, add_mesh an `unsupported` command, FR empty once cleared); RM's content_version
 * never changes over the run (its pixels change through region updates alone). */
export function evaluateMeshCaptureTyped(
  expected: Gate5MeshExpected,
  capture: Pick<Gate3CaptureEvaluation, "result_class" | "reasons" | "full">,
): { problems: string[]; ops: string[]; rm_versions: number[] } {
  const problems: string[] = [];
  if (capture.result_class !== "unsupported")
    problems.push(
      `class ${capture.result_class}, expected unsupported: ${capture.reasons.slice(0, 2).join(" | ")}`,
    );
  const ops = unsupportedOps(capture.full);
  if (JSON.stringify(ops) !== JSON.stringify([...expected.typed_ops].sort()))
    problems.push(
      `unsupported ops ${JSON.stringify(ops)} != ${JSON.stringify(expected.typed_ops)}`,
    );
  for (const t of capture.full.transactions)
    for (const u of t.meta.unsupported)
      if (u.reason !== "unsupported-op" && u.reason !== "draw-index-tie")
        problems.push(`frame ${t.meta.frame}: unsupported ${u.op} ${u.reason}`);
  const ids = new Set<number>();
  for (const t of capture.full.transactions)
    for (const i of t.meta.items) ids.add(i.id);
  const sorted = [...ids].sort((a, b) => a - b);
  if (sorted.length !== expected.creation_order.length)
    problems.push(
      `${sorted.length} item ids, expected ${expected.creation_order.length}`,
    );
  const idOf = new Map(expected.creation_order.map((n, k) => [n, sorted[k]]));
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
    for (const [name, calls] of Object.entries(s.commands)) {
      const item = t.meta.items.find((i) => i.id === idOf.get(name));
      const got = (item?.commands ?? []).map((c) =>
        c.op === "add_rect"
          ? { op: c.op, rect: c.rect, color: c.color, aa: c.aa }
          : { op: c.op, name: c.name },
      );
      const want = calls.map((c) =>
        c.op === "canvas_item_add_rect"
          ? {
              op: "add_rect",
              rect: (c.rect as number[]).map(f32),
              color: (c.color as number[]).map(f32),
              aa: c.antialiased as boolean,
            }
          : { op: "unsupported", name: c.op },
      );
      if (JSON.stringify(got) !== JSON.stringify(want))
        problems.push(
          `step ${s.step} ${name}: commands ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
    }
  }
  const rmVersions = new Set<number>();
  for (const t of capture.full.transactions)
    for (const i of t.meta.items)
      if (i.id === idOf.get("RM")) rmVersions.add(i.content_version);
  if (rmVersions.size !== 1)
    problems.push(
      `RM's content_version takes ${rmVersions.size} values over the run (${[...rmVersions].join(",")}), expected one`,
    );
  return { problems, ops, rm_versions: [...rmVersions] };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface Gate5cResult {
  checks: Gate5Check[];
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
  checkpoints: Gate5Checkpoint[];
  meshes: Record<string, unknown>;
  budgets: RegionBudget5[];
  freshness: Record<string, string[]>;
}

export async function runGate5c(
  outDir: string,
  expected: Gate5MeshExpected,
): Promise<Gate5cResult> {
  const meshDir = join(outDir, G5C_LEG_DIR);
  const e5 = asGate5(expected);
  const rasters = meshRasters(expected);
  const checks: Gate5Check[] = [
    checkMeshExpectedSelfConsistent(expected, rasters),
  ];

  const capture = await evaluateCapture(meshDir, {
    expectedClass: "unsupported",
  });
  const counters = await readJson<{ counts?: Record<string, number> }>(
    join(meshDir, "capture", "evidence", "counters.json"),
  );
  const captureLog = await loadResourceLog(join(meshDir, "capture"));
  const armedLog = await loadResourceLog(join(meshDir, "reference-armed"));
  const oracles = [
    await loadOracle(meshDir, ORACLE_LEGS[0]),
    await loadOracle(meshDir, ORACLE_LEGS[1]),
  ];
  const reference = await loadShots5(meshDir, "reference", e5);
  const repeat = await loadShots5(meshDir, "reference-repeat", e5);
  const armed = await loadShots5(meshDir, "reference-armed", e5);

  const image = evaluateExpectedImage5(
    e5,
    "reference-mesh",
    reference,
    rasters,
    join(meshDir, "reference", "shots"),
  );
  const presence = evaluatePresence5(e5, "reference-mesh", reference, rasters);
  const fresh = evaluateFreshness5(e5, "reference-mesh", reference);
  const repeatCmp = compareLegs5(e5, reference, repeat, rasters, [
    "reference-mesh",
    "reference-mesh-repeat",
  ]);
  const armedCmp = compareLegs5(e5, reference, armed, rasters, [
    "reference-mesh",
    "reference-mesh-armed",
  ]);
  const armedResult = await readJson<CaptureResultJson>(
    join(meshDir, "reference-armed", "evidence", "result.json"),
  );
  if (armedResult?.status !== "armed")
    armedCmp.problems.unshift(
      `reference-mesh-armed result.json status=${JSON.stringify(armedResult?.status)}`,
    );
  if (armedResult?.stream?.status !== "closed")
    armedCmp.problems.unshift(
      `reference-mesh-armed stream.status=${JSON.stringify(armedResult?.stream?.status)}`,
    );

  // fresh-without-redraw: RM changes pixels at 2, 3, 4 while its commands are recorded once.
  const freshProblems = [...fresh.problems];
  for (const k of [2, 3, 4]) {
    const s = expected.steps.find((x) => x.step === k);
    if (s?.redraws.includes("RM"))
      freshProblems.push(`step ${k}: RM is modelled as redrawn`);
    if (!fresh.table[String(k)]?.includes("RM"))
      freshProblems.push(`step ${k}: RM's pixels did not change`);
  }

  const census = evaluateMeshCensus(
    expected,
    captureLog.lines,
    G5C_CAPTURE_QUIT_FRAME,
  );
  const armedCensus = evaluateMeshCensus(
    expected,
    armedLog.lines,
    expected.quit_frame_default,
  );
  const censusProblems = [
    ...(captureLog.problem
      ? [`capture resources.jsonl: ${captureLog.problem}`]
      : []),
    ...(armedLog.problem
      ? [`reference-mesh-armed resources.jsonl: ${armedLog.problem}`]
      : []),
    ...census.problems.map((p) => `capture: ${p}`),
    ...armedCensus.problems.map((p) => `reference-mesh-armed: ${p}`),
  ];
  const oracle = evaluateOracleAgrees(expected, oracles);
  const parity = evaluateHashParity(expected, oracles[0], [
    { leg: "capture-mesh", lines: captureLog.lines },
    { leg: "reference-mesh-armed", lines: armedLog.lines },
  ]);
  const draw = evaluateDrawCensus(expected, counters?.counts);
  const typed = evaluateMeshCaptureTyped(expected, capture);

  const supportProblems: string[] = [];
  for (const leg of G5C_SUPPORT_LEGS) {
    const code = await readExitCode(
      leg === "import"
        ? join(meshDir, "import", "fixture")
        : join(meshDir, leg),
    );
    if (code !== 0) supportProblems.push(`${leg} exit ${code ?? "<none>"}`);
  }
  const bandBudgets = repeatCmp.budgets.filter(
    (b) => b.class === "band" || b.class === "undecided",
  );
  const capturePath = join(meshDir, "capture", "evidence", "resources.jsonl");
  const armedPath = join(
    meshDir,
    "reference-armed",
    "evidence",
    "resources.jsonl",
  );

  checks.push(
    rename(
      await checkCaptureArmed(meshDir, {
        captureResult: capture.captureResult,
        recording: capture.full,
      }),
      "mesh-capture-armed",
    ),
    rename(await checkHeadlessNoGpuGate0(meshDir), "mesh-headless-no-gpu"),
    rename(
      checkRecordingsDecode(capture.full, capture.patch),
      "mesh-recording-decodes",
    ),
    rename(
      checkPatchResolvesToFull(capture.full, capture.patch),
      "mesh-patch-resolves-to-full",
    ),
    rename(
      await checkStepAlignment5(meshDir, e5, capture.full),
      "mesh-step-alignment",
    ),
    rename(checkNoDrawIndexTies(capture.full).check, "mesh-no-draw-index-ties"),
    check(
      "mesh-draw-census",
      "the capture's counters.json equals expected.json draw_census over the run: one canvas_item_add_mesh per item draw (DF on every frame), every mesh call of the census, one canvas_item_attach_skeleton(RID()) per Polygon2D draw plus its destructor's at teardown, TEXG and the hue strip; every other canvas_item_add_* is 0",
      draw.problems,
      Object.entries(draw.measured)
        .map(([op, n]) => `${op.replace("canvas_item_", "")} ${n}`)
        .join(", "),
      [join(meshDir, "capture", "evidence", "counters.json")],
    ),
    check(
      "mesh-census",
      "the mesh hook log (G5a's evidence/resources.jsonl kind:\"mesh\" lines) equals Q6d's census frame by frame on the headless capture (to quit 400) and on the armed rendered reference (to quit 102): creates, from_surfaces, adds, region updates per buffer, removes, clears, custom AABBs and frees with their versions; DF three lines a frame (its rebuild frame: free, create, add); nothing else; ids 1.. in creation order",
      censusProblems,
      `capture ${Object.values(census.per_frame).reduce((a, b) => a + b, 0)} mesh lines over ${Object.keys(census.per_frame).length} frames (+${census.after_quit} teardown frees after quit), armed reference ${Object.values(armedCensus.per_frame).reduce((a, b) => a + b, 0)} over ${Object.keys(armedCensus.per_frame).length}`,
      [capturePath, armedPath],
    ),
    check(
      "oracle-agrees",
      "both reference legs' mesh oracle (RenderingServer.mesh_get_surface on the reference's GPU buffers) report, at every settle step, each fixture mesh's status, surface count, custom AABB, primitives, formats and vertex/index counts as expected.json; the derived Polygon2D mesh RID reads back as its polygon; and the two logs are byte-identical",
      [...oracle.problems],
      `${oracles.map((o) => `${o.leg} ${o.lines.length} lines`).join(", ")}, byte-identical`,
      oracles.map((o) => o.path),
    ),
    check(
      "mesh-hook-hash-parity",
      "at every settle step each live fixture surface's GRM1 hash agrees three ways: the hook log's last hash of that frame (headless capture and armed rendered reference), the reference's GPU readback (oracle) and make_expected.py's byte model; freed meshes are freed in the log",
      parity.problems,
      `${parity.table._compared?.surfaces ?? 0} surface-steps agree three ways on 2 hosts`,
      [oracles[0].path, capturePath, armedPath],
    ),
    check(
      "mesh-expected-image-reference",
      "every reference-mesh shot equals the raster of expected.json on every decided pixel of the exact regions (every mesh but DF: integer, tie-free, flat RGBA8 colours); DF is band (a texture under a deforming mapping) and is compared leg to leg only",
      image.problems,
      `${image.checkpoints.length} shots match on ${image.checkpoints.reduce((n, c) => n + (c.compared ?? 0), 0)} decided pixels`,
      shotPaths5(meshDir, "reference", e5),
    ),
    check(
      "mesh-presence-reference",
      "in every reference-mesh shot every mesh surface (DF included) covers at least half its expected area with pixels differing from what lies beneath it",
      presence.problems,
      `${presence.shapes} shape-shots present`,
      shotPaths5(meshDir, "reference", e5),
    ),
    check(
      "mesh-freshness-reference",
      "between consecutive reference-mesh shots a region changes exactly when expected.json says fresh, including fresh-without-redraw: RM changes at steps 2, 3 and 4 through region updates alone (its commands are recorded once), M2 at 6 through a surface removal, FR at 7 through a free",
      freshProblems,
      Object.entries(fresh.table)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" "),
      shotPaths5(meshDir, "reference", e5),
    ),
    check(
      "mesh-reference-repeat-budget",
      "reference-mesh vs reference-mesh-repeat (same build, GPU and driver): identical at every pixel of every shot, DF's band included -- the budget is what this measures (D13 expects 0)",
      repeatCmp.problems,
      `budget 0: ${expected.steps.length} shot pairs identical; band/undecided: ${bandBudgets
        .filter((b) => b.pixels > 0)
        .map(
          (b) => `${b.region} ${b.class} ${b.max_channel_delta}/${b.pixels}px`,
        )
        .join(", ")}`,
      [
        ...shotPaths5(meshDir, "reference", e5),
        ...shotPaths5(meshDir, "reference-repeat", e5),
      ],
    ),
    check(
      "mesh-armed-transparent",
      "reference-mesh-armed (extension armed, stream on, oracle off) armed with its stream closed, and every shot equals the reference's exactly",
      armedCmp.problems,
      `${expected.steps.length} armed shots byte-identical to the reference`,
      shotPaths5(meshDir, "reference-armed", e5),
    ),
    check(
      "mesh-support-legs-exit",
      "the g5c import, reference-mesh, reference-mesh-repeat and reference-mesh-armed legs exited 0",
      supportProblems,
      `${G5C_SUPPORT_LEGS.length} support legs exited 0`,
      [],
    ),
    check(
      "leg-class-capture-mesh",
      "the capture-mesh leg classifies as unsupported on the pre-/4 wire: armed, stream closed, both sinks valid, the only unsupported op canvas_item_add_mesh (unsupported-op), each item's commands at every settle frame as expected (FR's cleared at 8), and RM's content_version constant over the whole run",
      typed.problems,
      `${capture.result_class}: ${typed.ops.join(", ")} typed; RM content_version ${typed.rm_versions.join(",")}`,
      capture.artifacts,
    ),
  );

  const legs: Gate5cResult["legs"] = {
    "capture-mesh": {
      group: "g5c",
      expected_class: capture.expected_class,
      result_class: capture.result_class,
      reasons: capture.reasons,
      harmless_ties: capture.harmless_ties,
      exit_code: capture.exit_code,
      artifacts: capture.artifacts,
    },
  };
  for (const leg of G5C_SUPPORT_LEGS) {
    const dir =
      leg === "import"
        ? join(meshDir, "import", "fixture")
        : join(meshDir, leg);
    const artifacts: string[] = [];
    for (const p of [
      "argv.txt",
      "env.txt",
      "stdout.log",
      "exit-code.txt",
      "steps.jsonl",
      "meshes.jsonl",
      RECORDING_NAME,
    ])
      if (await fileExists(join(dir, p))) artifacts.push(join(dir, p));
    legs[
      leg === "import"
        ? "import-mesh"
        : `${leg.replace("reference", "reference-mesh")}`
    ] = {
      group: "g5c",
      expected_class: null,
      result_class: null,
      reasons: [],
      exit_code: await readExitCode(dir),
      artifacts,
    };
  }

  // Per mesh: hook versions and surface payload bytes are G5e's wire report; here the census and
  // the copy/hash cost the hook measured, per mesh name.
  const names = meshNamesById(
    captureLog.lines.filter((l) => l.kind === "mesh"),
    expected.mesh_order,
  );
  const meshes: Record<string, unknown> = {};
  for (const [id, name] of names) {
    const own = captureLog.lines.filter(
      (l) =>
        l.kind === "mesh" && l.id === id && l.frame <= G5C_CAPTURE_QUIT_FRAME,
    );
    const copy = own
      .map((l) => l.copy_ns)
      .filter((v): v is number => v !== null);
    const hash = own
      .map((l) => l.hash_ns)
      .filter((v): v is number => v !== null);
    const median = (v: number[]) =>
      v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null;
    meshes[name] = {
      id,
      lines: own.length,
      last_version: own.length ? own[own.length - 1].version : null,
      copy_ns_median: median(copy),
      hash_ns_median: median(hash),
    };
  }
  meshes._parity = parity.table;

  return {
    checks,
    legs,
    checkpoints: image.checkpoints,
    meshes,
    budgets: repeatCmp.budgets,
    freshness: fresh.table,
  };
}
