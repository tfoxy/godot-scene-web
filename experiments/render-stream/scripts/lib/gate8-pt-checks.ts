// Gate 8 g8pt checks (PM5, protocol/render-stream-12.md "Fixture and checks (gate 8 group g8pt)";
// the fixture is fixtures/gate8-pt, its predictions expected.json). PM5 is the capture side of
// /12's GPU particles: every leg but `receiver` is a capture judged against its own hook log
// (render-stream-12.md "Hook log and counters", evidence/resources.jsonl, kind "particles").
//
//   g8pt-legs                   every leg that ran exited 0
//   pt-validate                 every honest recording (the /12 rendered capture and the headless
//                               shim capture, the /11 control, the headless and pump legs; both
//                               sinks) passes the TypeScript validator and rs-core-check
//   pt-sabotage-validate-<kind> both validators accept the sabotage's patch recording
//   pt-hook-census              per cell: creates, setters, restarts, emits, frees, draw passes
//                               against expected.json, and the cell's last state line's fields
//   pt-wire                     at every transaction, each resolved entry's JSON fields and floats
//                               equal the newest hook-log `state` line at or before its frame;
//                               every field a call set (and the restarts/emits/process_requests
//                               counters) equals the newest call line's value at or before the
//                               frame; the emit list equals the particles_emit call lines in
//                               (B, T]; every cell's emitter is in the table from its first state
//                               line on
//   pt-wire-catches-<kind>      pt-wire FAILS on the sabotage's patch recording (perturb-seed,
//                               drop-restart)
//   pt-builtin                  each particle_process_material builtin equals the MaterialKey
//                               derived from the shader's generated code (the store's GRP1
//                               payload: ParticleProcessMaterial::_update_shader's markers), and
//                               each cell's material's builtin equals expected.json's key
//   pt-v11                      the /11 control: no particles key, every add_particles lowered to
//                               unsupported/unsupported-op, the process-material shaders
//                               unsupported/shader-mode, no particles hook line
//   pt-curve-textures           F_CURVES's curve and gradient textures (64x1) are ok float
//                               textures at /12 and never ok at /11 (unsupported-format)
//   pt-shim                     headless without the shim: no particles entry, every
//                               add_particles unknown-particles; with it: distinct emitter rids and
//                               ids, the census and pt-wire hold
//   pt-pump                     gate8-mm headless with the pump: the drawn CPUParticles2D cells and
//                               I_PREDRAW set a buffer every frame (the rendered census); without
//                               it they never do
//   pt-receiver                 the native receiver (RS_RECEIVER_PROTOCOL=12) accepts the /12
//                               stream and (PM6a) leaves no add_particles undrawn; the pre-PM6
//                               planner (receiver sabotage undrawn-particles) types exactly the
//                               add_particles commands of the items it replayed particles-undrawn
//   (PM6a)                      the receivers' pixel and replay checks: lib/gate8-pt-receiver-checks.ts
//   pt-bytes                    (informational) pt_f32 bytes per transaction and per frame
//
// The hook-log field names are read in ONE place, parsePtLine(), so a refinement of the
// capture's spelling is a one-function change. The pure helpers are exported for
// scripts/test/self-test-gate8-pt.ts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { check, exitCode, type G8aCheck, readText, skipped } from "./gate8-adopt-checks";
import { censusProblems as mmCensusProblems, type G8mmExpected, mapCells as mmMapCells, parseMmLog } from "./gate8-mm-checks";
import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import { LATE_LEGS, type PtLate, type PtLateTx, runG8ptLate } from "./gate8-pt-late-checks";
import { type PtPixels, type PtWireTotals, runG8ptReceivers } from "./gate8-pt-receiver-checks";
import {
  applyTransaction,
  type BuiltinParticleProcessMaterial,
  type DecodedBlock,
  decodeRecord,
  emptyResolvedState,
  type ResolvedCommand,
  type ResolvedItem,
  type ResolvedMaterial,
  type ResolvedParticles,
  type ResolvedShader,
  type ResolvedState,
  type ResolvedTexture,
  rawRecordBlock,
  splitRecords,
  type TransactionMeta,
  type TransactionParticleEmitFloats,
  transactionParticleEmits,
  PT_F32_BLOCK,
  particlesFloatsInWireOrder,
  validateRecording,
  withRecordMemo,
} from "./render-stream-2";
import { decodeShaderPayload } from "./render-stream-shader";

// ------------------------------------------------------------------------------ expected.json

export interface PtKey {
  emission_shape: string;
  textures: string[];
  color_ramp: boolean;
  turbulence: boolean;
  sub_emitter: string;
}
export interface PtCell {
  amount: number;
  seed: number;
  local: boolean;
  one_shot: boolean;
  emitting: boolean;
  calls: Record<string, number>;
  per_frame?: string[];
  ranges?: Record<string, [number, number]>;
  restarts: number;
  emits: number;
  process_requests: number;
  trail_poses: number;
  restart_frames?: number[];
  textures?: string[];
  subemitter?: string;
  child_of?: string;
  key: PtKey;
}
export interface G8ptExpected {
  schema: string;
  quit_frame: number;
  checkpoints: { step: number; applied: number; settle: number }[];
  sabotage_frame: number;
  min_per_frame_frames: number;
  float_texture: { width: number; height: number; formats: string[] };
  base_calls: Record<string, number>;
  base_teardown: Record<string, number>;
  cells: Record<string, PtCell>;
  key_defaults: BuiltinParticleProcessMaterial;
  /** PM6a: the receivers' pixel model (gate8-pt-receiver-checks.ts). */
  pixels: PtPixels;
  /** PM7: the late arm (gate8-pt-late-checks.ts). */
  late: PtLate;
}

/** A cell's full expected MaterialKey (key_defaults overridden by the cell's key). */
export function cellKey(expected: G8ptExpected, cell: PtCell): BuiltinParticleProcessMaterial {
  return { ...expected.key_defaults, ...cell.key } as BuiltinParticleProcessMaterial;
}

// ------------------------------------------------------------------- hook log (render-stream-12)

export interface PtCall {
  kind: "call";
  /** The call without its `particles_` prefix (set_amount, restart, emit, ...); RenderingServer
   * ::free on an emitter is `free`. */
  call: string;
  frame: number;
  rid: string;
  id: number | null;
  accepted: boolean;
  /** the line's own arguments (header names without `p_`) */
  args: Record<string, unknown>;
}
export interface PtState {
  kind: "state";
  frame: number;
  rid: string;
  id: number | null;
  /** every entry JSON field the line carries (status, reason, version, mode, ...), without f */
  fields: Record<string, unknown>;
  /** the entry's floats in wire order, null when freed */
  floats: number[] | null;
}
export type PtLine = PtCall | PtState;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The entry JSON fields of render-stream-12.md "Particles table", in order (without f). */
export const PT_FIELDS = [
  "status",
  "reason",
  "version",
  "mode",
  "emitting",
  "amount",
  "one_shot",
  "fixed_fps",
  "interpolate",
  "fractional_delta",
  "local",
  "draw_order",
  "transform_align",
  "trails",
  "trail_poses",
  "seed",
  "restarts",
  "emits",
  "process_requests",
  "process_material",
  "draw_passes",
  "subemitter",
] as const;

/** A flat list of numbers from a hook-log value: a number list, a list of number lists (a
 * transform list), or an {x,y,z,...} object. */
function floatsOf(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) {
    const out: number[] = [];
    for (const x of v) {
      const f = floatsOf(x);
      if (f === null) return null;
      out.push(...f);
    }
    return out;
  }
  return null;
}

/** One resources.jsonl line as a particles call or state line, or null when it is not a
 * particles line. The ONLY place that knows the line's field names. */
export function parsePtLine(raw: Record<string, unknown>): PtLine | null {
  if (raw.kind !== "particles") return null;
  const name = str(raw.call) ?? str(raw.op) ?? "";
  const frame = num(raw.frame) ?? 0;
  const rid = raw.rid === undefined || raw.rid === null ? "" : String(raw.rid);
  const id = num(raw.id);
  if (name === "state") {
    const fields: Record<string, unknown> = {};
    for (const k of PT_FIELDS) if (k in raw) fields[k] = raw[k];
    return { kind: "state", frame, rid, id, fields, floats: floatsOf(raw.floats) };
  }
  let call = name.replace(/^particles_/, "");
  if (call === "free_rid" || call === "rs_free") call = "free";
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (["kind", "call", "op", "frame", "rid", "id", "accepted"].includes(k)) continue;
    args[k.replace(/^p_/, "")] = v;
  }
  return { kind: "call", call, frame, rid, id, accepted: raw.accepted !== false, args };
}

/** The particles lines of a resources.jsonl text (malformed lines are skipped). A line without a
 * rid but with a wire id gets the rid an earlier line paired with that id (a freed emitter's
 * state line has `rid: null`). */
export function parsePtLog(text: string | undefined): PtLine[] {
  const out: PtLine[] = [];
  for (const l of (text ?? "").split("\n")) {
    if (l.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object") continue;
    const p = parsePtLine(raw as Record<string, unknown>);
    if (p) out.push(p);
  }
  const ridOfId = new Map<number, string>();
  for (const l of out) {
    if (l.id === null) continue;
    if (l.rid !== "" && !ridOfId.has(l.id)) ridOfId.set(l.id, l.rid);
    else if (l.rid === "") l.rid = ridOfId.get(l.id) ?? "";
  }
  return out;
}

// ------------------------------------------------------------------ enum and argument spellings

const MODES = ["2d", "3d"];
const DRAW_ORDERS = ["index", "lifetime", "reverse_lifetime", "view_depth"];
const ALIGNS = ["disabled", "z_billboard", "y_to_velocity", "z_billboard_y_to_velocity"];

/** An enum argument as the wire's word: RS's value, its name or the word itself. */
function enumWord(v: unknown, words: readonly string[]): string | null {
  if (typeof v === "number") return words[v] ?? null;
  if (typeof v !== "string") return null;
  const w = v.toLowerCase().replace(/^particles_(mode|draw_order|transform_align)_/, "");
  return words.includes(w) ? w : v;
}
function argOf(c: PtCall, ...names: string[]): unknown {
  for (const n of names) if (n in c.args) return c.args[n];
  return undefined;
}
/** A RID argument as its wire id (`<arg>` is the id, `<arg>_rid` the RID). */
function refOf(c: PtCall, ...names: string[]): number | null | undefined {
  for (const n of names) if (n in c.args) return num(c.args[n]);
  return undefined;
}

/** The JSON field (and value) a setter call sets, or null when the call sets none. */
export function callField(c: PtCall): [string, unknown] | null {
  const b = (...n: string[]) => {
    const v = argOf(c, ...n);
    return typeof v === "boolean" ? v : undefined;
  };
  const i = (...n: string[]) => num(argOf(c, ...n)) ?? undefined;
  switch (c.call) {
    case "set_mode":
      return ["mode", enumWord(argOf(c, "mode"), MODES)];
    case "set_emitting":
      return ["emitting", b("enable", "emitting")];
    case "set_amount":
      return ["amount", i("amount")];
    case "set_one_shot":
      return ["one_shot", b("one_shot", "enable")];
    case "set_fixed_fps":
      return ["fixed_fps", i("fps", "fixed_fps")];
    case "set_interpolate":
      return ["interpolate", b("enable", "interpolate")];
    case "set_fractional_delta":
      return ["fractional_delta", b("enable", "fractional_delta")];
    case "set_use_local_coordinates":
      return ["local", b("enable", "local")];
    case "set_seed":
      return ["seed", i("seed")];
    case "set_draw_order":
      return ["draw_order", enumWord(argOf(c, "order", "draw_order"), DRAW_ORDERS)];
    case "set_transform_align":
      return ["transform_align", enumWord(argOf(c, "transform_align", "align"), ALIGNS)];
    case "set_trails":
      return ["trails", b("enable", "trails")];
    case "set_trail_bind_poses": {
      const v = argOf(c, "bind_poses", "poses");
      if (Array.isArray(v) && v.every((x) => Array.isArray(x))) return ["trail_poses", v.length];
      const f = floatsOf(v);
      return ["trail_poses", f === null ? (num(argOf(c, "count")) ?? undefined) : f.length / 12];
    }
    case "set_process_material":
      return ["process_material", refOf(c, "material", "process_material")];
    case "set_subemitter":
      return ["subemitter", refOf(c, "subemitter_particles", "subemitter")];
    default:
      return null;
  }
}

/** The float offsets and values a call sets (render-stream-12.md "Particles table" layout). */
export function callFloats(c: PtCall): [number, number[]] | null {
  const one = (...n: string[]): [number, number[]] | null => {
    const v = num(argOf(c, ...n));
    return v === null ? null : [0, [v]];
  };
  const at = (o: number, v: [number, number[]] | null): [number, number[]] | null => (v ? [o, v[1]] : null);
  const many = (o: number, len: number, ...n: string[]): [number, number[]] | null => {
    const f = floatsOf(argOf(c, ...n));
    return f && f.length === len ? [o, f] : null;
  };
  switch (c.call) {
    case "set_amount_ratio":
      return at(0, one("amount_ratio", "ratio"));
    case "set_lifetime":
      return at(1, one("lifetime"));
    case "set_pre_process_time":
      return at(2, one("time", "pre_process_time"));
    case "set_explosiveness_ratio":
      return at(3, one("ratio", "explosiveness_ratio"));
    case "set_randomness_ratio":
      return at(4, one("ratio", "randomness_ratio"));
    case "set_speed_scale":
      return at(5, one("scale", "speed_scale"));
    case "set_collision_base_size":
      return at(6, one("size", "collision_base_size"));
    case "set_trails":
      return at(7, one("length_sec", "length"));
    case "set_interp_to_end":
      return at(8, one("interp", "interp_to_end"));
    case "request_process_time":
      return at(9, one("request_process_time", "time"));
    case "set_custom_aabb":
      return many(10, 6, "aabb", "custom_aabb");
    case "set_emission_transform":
      return many(16, 12, "transform", "emission_transform");
    case "set_emitter_velocity":
      return many(28, 3, "velocity", "emitter_velocity");
    default:
      return null;
  }
}

/** The counter a call moves (render-stream-12.md: restart, emit and request_process_time). */
const COUNTER_OF: Record<string, string> = {
  restart: "restarts",
  emit: "emits",
  request_process_time: "process_requests",
};

function f32eq(a: unknown, b: unknown): boolean {
  if (typeof a !== "number" || typeof b !== "number") return a === b;
  return Object.is(Math.fround(a), Math.fround(b));
}
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ----------------------------------------------------------------------------- cell mapping

export interface PtCellMap {
  cellOfRid: Map<string, string>;
  ridOfCell: Map<string, string>;
  idOfCell: Map<string, number>;
  problems: string[];
}

/** Each rid's cell by its last accepted particles_set_amount (unique per cell). */
export function mapPtCells(lines: readonly PtLine[], expected: G8ptExpected): PtCellMap {
  const lastAmount = new Map<string, number>();
  const ids = new Map<string, number>();
  const rids: string[] = [];
  for (const l of lines) {
    if (!rids.includes(l.rid)) rids.push(l.rid);
    if (l.id !== null && !ids.has(l.rid)) ids.set(l.rid, l.id);
    if (l.kind === "call" && l.call === "set_amount" && l.accepted) {
      const a = num(l.args.amount);
      if (a !== null) lastAmount.set(l.rid, a);
    }
  }
  const byAmount = new Map<number, string>();
  for (const [name, c] of Object.entries(expected.cells)) byAmount.set(c.amount, name);
  const out: PtCellMap = { cellOfRid: new Map(), ridOfCell: new Map(), idOfCell: new Map(), problems: [] };
  for (const rid of rids) {
    const n = lastAmount.get(rid);
    const cell = n === undefined ? undefined : byAmount.get(n);
    if (!cell) {
      out.problems.push(`rid ${rid || "(none)"}: no cell (last amount ${n ?? "none"})`);
      continue;
    }
    if (out.ridOfCell.has(cell)) {
      out.problems.push(`${cell}: two rids (${out.ridOfCell.get(cell)}, ${rid})`);
      continue;
    }
    out.cellOfRid.set(rid, cell);
    out.ridOfCell.set(cell, rid);
    const id = ids.get(rid);
    if (id !== undefined) out.idOfCell.set(cell, id);
  }
  return out;
}

// ---------------------------------------------------------------------------- pt-hook-census

/** pt-hook-census: the hook log's calls per cell against expected.json. `lastTxFrame` is the
 * last transaction's frame: a call after it is teardown (the quit), judged by base_teardown. */
export function ptCensusProblems(
  lines: readonly PtLine[],
  expected: G8ptExpected,
  lastTxFrame: number,
): string[] {
  const problems: string[] = [];
  const map = mapPtCells(lines, expected);
  problems.push(...map.problems);
  const calls = lines.filter((l): l is PtCall => l.kind === "call");
  for (const [name, cell] of Object.entries(expected.cells)) {
    const rid = map.ridOfCell.get(name);
    if (rid === undefined) {
      problems.push(`${name}: no emitter with amount ${cell.amount} in the hook log`);
      continue;
    }
    const all = calls.filter((l) => l.rid === rid);
    const live = all.filter((l) => l.frame <= lastTxFrame);
    const teardown = all.filter((l) => l.frame > lastTxFrame);
    const want = { ...expected.base_calls, ...cell.calls };
    const perFrame = cell.per_frame ?? [];
    const ranges = cell.ranges ?? {};
    const counts = new Map<string, number>();
    for (const l of live) counts.set(l.call, (counts.get(l.call) ?? 0) + 1);
    const names = new Set([...counts.keys(), ...Object.keys(want), ...Object.keys(ranges)]);
    for (const c of names) {
      const got = counts.get(c) ?? 0;
      const fixed = want[c] ?? 0;
      if (perFrame.includes(c)) {
        const frames = [...new Set(live.filter((l) => l.call === c).map((l) => l.frame))].sort((a, b) => a - b);
        if (frames.length === 0) {
          problems.push(`${name}: no ${c} at all (expected one every frame)`);
          continue;
        }
        const span = frames[frames.length - 1] - frames[0] + 1;
        if (frames.length !== span)
          problems.push(`${name}: ${c} missing on ${span - frames.length} of frames ${frames[0]}..${frames[frames.length - 1]}`);
        if (span < expected.min_per_frame_frames)
          problems.push(`${name}: ${c} on ${span} frames, expected at least ${expected.min_per_frame_frames}`);
        if (got < span || got > span + fixed)
          problems.push(`${name}: ${got} ${c} over ${span} frames (one a frame plus at most ${fixed})`);
      } else if (ranges[c]) {
        const [lo, hi] = ranges[c];
        if (got < lo || got > hi) problems.push(`${name}: ${got} ${c}, expected ${lo}..${hi}`);
      } else if (got !== fixed) {
        problems.push(`${name}: ${got} ${c}, expected ${fixed}`);
      }
    }
    const tcounts = new Map<string, number>();
    for (const l of teardown) tcounts.set(l.call, (tcounts.get(l.call) ?? 0) + 1);
    for (const [c, n] of Object.entries(expected.base_teardown))
      if ((tcounts.get(c) ?? 0) !== n) problems.push(`${name}: ${tcounts.get(c) ?? 0} ${c} at teardown, expected ${n}`);
    const rejected = live.filter((l) => !l.accepted);
    if (rejected.length > 0)
      problems.push(`${name}: ${rejected.length} rejected call(s) (first ${rejected[0].call} at frame ${rejected[0].frame})`);
    // restart frames (D_ONESHOT): the fixture's restart() calls, after the constructor's one
    if (cell.restart_frames) {
      const rf = live.filter((l) => l.call === "restart").map((l) => l.frame).slice(1);
      if (!sameValue(rf, cell.restart_frames))
        problems.push(`${name}: restarts after the constructor's at frames ${JSON.stringify(rf)}, expected ${JSON.stringify(cell.restart_frames)}`);
    }
    // the cell's last state line at or before the last transaction
    const last = lines
      .filter((l): l is PtState => l.kind === "state" && l.rid === rid && l.frame <= lastTxFrame)
      .at(-1);
    if (!last) {
      problems.push(`${name}: no state line`);
      continue;
    }
    const f = last.fields;
    const wantFields: [string, unknown][] = [
      ["status", "ok"],
      ["mode", "2d"],
      ["amount", cell.amount],
      ["seed", cell.seed],
      ["local", cell.local],
      ["one_shot", cell.one_shot],
      ["emitting", cell.emitting],
      ["restarts", cell.restarts],
      ["emits", cell.emits],
      ["process_requests", cell.process_requests],
      ["trail_poses", cell.trail_poses],
      ["trails", cell.trail_poses > 0],
    ];
    for (const [k, v] of wantFields)
      if (!sameValue(f[k], v)) problems.push(`${name}: last state ${k} ${JSON.stringify(f[k])}, expected ${JSON.stringify(v)}`);
    const passes = f.draw_passes;
    if (!Array.isArray(passes) || passes.length !== 1 || typeof passes[0] !== "number")
      problems.push(`${name}: last state draw_passes ${JSON.stringify(passes)}, expected one known mesh`);
    if (typeof f.process_material !== "number") problems.push(`${name}: last state process_material ${JSON.stringify(f.process_material)}`);
    if (cell.subemitter) {
      const sub = map.idOfCell.get(cell.subemitter);
      if (f.subemitter !== sub)
        problems.push(`${name}: last state subemitter ${JSON.stringify(f.subemitter)}, expected ${cell.subemitter}'s id ${sub}`);
    } else if (f.subemitter !== null) problems.push(`${name}: last state subemitter ${JSON.stringify(f.subemitter)}, expected null`);
  }
  return problems;
}

// --------------------------------------------------------------------------- recording trace

export interface PtTx {
  seq: number;
  frame: number;
  full: boolean;
  base_seq: number | null;
  /** pt_f32's float count (block 9; 0 when absent) */
  pt_floats: number;
  /** whether the decoded meta carries particles / removed_particles / particle_emits */
  has_keys: boolean;
  /** the resolved particles table after this transaction */
  table: Map<number, ResolvedParticles>;
  /** the transaction's emit list with floats */
  emits: TransactionParticleEmitFloats[];
  shaders: Map<number, ResolvedShader>;
  materials: Map<number, ResolvedMaterial>;
  textures: Map<number, ResolvedTexture>;
  /** per resolved item: content_version and its add_particles / unsupported add_particles */
  items: Map<number, { content_version: number; add_particles: number; unsupported: Record<string, number> }>;
  /** the transaction's item-level unsupported entries for canvas_item_add_particles, by reason */
  item_unsupported: Record<string, number>;
}
export interface PtTrace {
  version: number;
  txs: PtTx[];
  errors: string[];
}

export interface PtTxInput {
  meta: TransactionMeta;
  blocks: DecodedBlock[];
  meshU8?: Uint8Array;
  mmBytes?: Uint8Array;
}

function itemSummary(it: ResolvedItem): { content_version: number; add_particles: number; unsupported: Record<string, number> } {
  let add = 0;
  const uns: Record<string, number> = {};
  for (const c of (it.commands ?? []) as ResolvedCommand[]) {
    const op = (c as { op: string }).op;
    if (op === "add_particles") add += 1;
    else if (op === "unsupported") {
      const u = c as unknown as { name: string; reason: string };
      if (u.name === "canvas_item_add_particles") uns[u.reason] = (uns[u.reason] ?? 0) + 1;
    }
  }
  return { content_version: it.content_version, add_particles: add, unsupported: uns };
}

/** The trace over decoded transactions, resolved through render-stream-2.ts's applyTransaction. */
export function ptTraceFromTransactions(inputs: readonly PtTxInput[], version = 12): PtTrace {
  const out: PtTrace = { version, txs: [], errors: [] };
  let state: ResolvedState = emptyResolvedState();
  for (const { meta, blocks, meshU8, mmBytes } of inputs) {
    state = applyTransaction(state, meta, blocks as number[][], meshU8, mmBytes);
    const items = new Map<number, ReturnType<typeof itemSummary>>();
    for (const it of state.items.values()) items.set(it.id, itemSummary(it));
    const itemUns: Record<string, number> = {};
    for (const u of meta.unsupported ?? [])
      if (u.op === "canvas_item_add_particles") itemUns[u.reason] = (itemUns[u.reason] ?? 0) + 1;
    const pt = blocks[PT_F32_BLOCK];
    out.txs.push({
      seq: meta.seq,
      frame: meta.frame,
      full: meta.encoding === "full",
      base_seq: meta.base_seq,
      pt_floats: version >= 12 && Array.isArray(pt) ? pt.length : 0,
      has_keys: "particles" in meta || "removed_particles" in meta || "particle_emits" in meta,
      table: new Map(state.particles),
      emits: version >= 12 ? transactionParticleEmits(meta, blocks) : [],
      shaders: new Map(state.shaders),
      materials: new Map(state.materials),
      textures: new Map(state.textures),
      items,
      item_unsupported: itemUns,
    });
  }
  return out;
}

/** The trace of a recording's bytes at `version` (11 or 12). */
export function tracePtRecording(data: Uint8Array, version: 11 | 12 = 12): PtTrace {
  return withRecordMemo(data, () => {
    const split = splitRecords(data, version);
    const inputs: PtTxInput[] = [];
    const errors = [...split.errors];
    for (let i = 1; i < split.records.length; i++) {
      const raw = split.records[i];
      const d = decodeRecord(raw, version);
      const rec = d.record;
      if (!rec) {
        errors.push(`record ${i}: ${(d.errors ?? []).join("; ").slice(0, 200)}`);
        continue;
      }
      const meta = rec.meta as unknown as TransactionMeta;
      if ((meta as { type: string }).type !== "transaction") continue;
      inputs.push({ meta, blocks: rec.blocks, meshU8: rawRecordBlock(raw, 7), mmBytes: rawRecordBlock(raw, 8) });
    }
    const t = ptTraceFromTransactions(inputs, version);
    t.errors.push(...errors);
    return t;
  });
}

// ------------------------------------------------------------------------------------ pt-wire

function statesById(lines: readonly PtLine[]): Map<number, PtState[]> {
  const out = new Map<number, PtState[]>();
  for (const l of lines) {
    if (l.kind !== "state" || l.id === null) continue;
    const list = out.get(l.id) ?? [];
    list.push(l);
    out.set(l.id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.frame - b.frame);
  return out;
}
function newestAtOrBefore<T extends { frame: number }>(list: readonly T[] | undefined, frame: number): T | null {
  let best: T | null = null;
  for (const s of list ?? []) if (s.frame <= frame) best = s;
  return best;
}

/** The entry fields and floats the call lines alone say, at `frame`, for one emitter: the newest
 * accepted setter of each field and float range, and the counters (restart, emit and
 * request_process_time lines on the known emitter, whatever their `accepted`: they always move
 * the counter). Fields no call set are absent. */
export function callModelAt(
  calls: readonly PtCall[],
  frame: number,
): { fields: Map<string, unknown>; floats: Map<number, number> } {
  const fields = new Map<string, unknown>();
  const floats = new Map<number, number>();
  const counters: Record<string, number> = { restarts: 0, emits: 0, process_requests: 0 };
  let passes: (number | null)[] | null = null;
  for (const c of calls) {
    if (c.frame > frame) break;
    const counter = COUNTER_OF[c.call];
    if (counter && c.id !== null) counters[counter] += 1;
    if (!c.accepted) continue;
    if (c.call === "set_draw_passes") {
      const n = num(argOf(c, "count")) ?? 0;
      passes = Array.from({ length: n }, (_, i) => passes?.[i] ?? null);
    } else if (c.call === "set_draw_pass_mesh") {
      const p = num(argOf(c, "pass")) ?? -1;
      const m = refOf(c, "mesh");
      if (passes && p >= 0 && p < passes.length && m !== undefined) passes[p] = m;
    }
    const f = callField(c);
    if (f && f[1] !== undefined) fields.set(f[0], f[1]);
    const fl = callFloats(c);
    if (fl) fl[1].forEach((v, i) => floats.set(fl[0] + i, v));
  }
  for (const [k, v] of Object.entries(counters)) fields.set(k, v);
  if (passes) fields.set("draw_passes", passes);
  return { fields, floats };
}

/** pt-wire's table half: every resolved entry against the newest state line at or before the
 * transaction's frame, and against the call lines' model at that frame. */
export function ptWireProblems(trace: PtTrace, lines: readonly PtLine[]): string[] {
  const problems: string[] = [];
  const states = statesById(lines);
  const callsById = new Map<number, PtCall[]>();
  for (const l of lines)
    if (l.kind === "call" && l.id !== null) {
      const list = callsById.get(l.id) ?? [];
      list.push(l);
      callsById.set(l.id, list);
    }
  let checked = 0;
  for (const t of trace.txs) {
    for (const r of t.table.values()) {
      checked += 1;
      const diffs: string[] = [];
      const s = newestAtOrBefore(states.get(r.id), t.frame);
      const wireFloats = r.floats ? particlesFloatsInWireOrder(r.floats) : null;
      if (!s) diffs.push("no state line at or before it");
      else {
        for (const k of PT_FIELDS) {
          if (r.status === "freed" && !["status", "version"].includes(k)) continue;
          const a = (r as unknown as Record<string, unknown>)[k];
          if (!(k in s.fields)) diffs.push(`state line of frame ${s.frame} lacks ${k}`);
          else if (!sameValue(a, s.fields[k])) diffs.push(`${k} ${JSON.stringify(a)} vs state ${JSON.stringify(s.fields[k])} (frame ${s.frame})`);
        }
        if (r.status !== "freed") {
          const sf = s.floats;
          if (!wireFloats || !sf || sf.length !== wireFloats.length)
            diffs.push(`floats: ${wireFloats?.length ?? "null"} on the wire, ${sf?.length ?? "null"} in the state of frame ${s.frame}`);
          else {
            const bad = wireFloats.findIndex((v, i) => !f32eq(v, sf[i]));
            if (bad >= 0) diffs.push(`float ${bad} ${wireFloats[bad]} vs state ${sf[bad]} (frame ${s.frame})`);
          }
        }
      }
      if (r.status !== "freed") {
        const m = callModelAt(callsById.get(r.id) ?? [], t.frame);
        for (const [k, v] of m.fields) {
          const a = (r as unknown as Record<string, unknown>)[k];
          if (!sameValue(a, v)) diffs.push(`${k} ${JSON.stringify(a)} vs the calls' ${JSON.stringify(v)}`);
        }
        if (wireFloats)
          for (const [i, v] of m.floats)
            if (!f32eq(wireFloats[i], v)) {
              diffs.push(`float ${i} ${wireFloats[i]} vs the calls' ${v}`);
              break;
            }
      }
      if (diffs.length > 0) problems.push(`seq ${t.seq} (frame ${t.frame}): particles ${r.id}: ${diffs.slice(0, 4).join(", ")}`);
      if (problems.length > 12) return problems;
    }
  }
  if (checked === 0) problems.push("no particles entry to check");
  return problems;
}

/** pt-wire's emit half: each transaction's emit list against the particles_emit call lines in
 * (B, T] (a patch on base B) or of T's own frame (a full transaction). */
export function ptEmitProblems(trace: PtTrace, lines: readonly PtLine[]): string[] {
  const problems: string[] = [];
  const emitCalls = lines.filter((l): l is PtCall => l.kind === "call" && l.call === "emit" && l.id !== null);
  const frameOfSeq = new Map(trace.txs.map((t) => [t.seq, t.frame]));
  let listed = 0;
  for (const t of trace.txs) {
    const from = t.full ? t.frame - 1 : (frameOfSeq.get(t.base_seq ?? -1) ?? t.frame - 1);
    const want = emitCalls.filter((c) => c.frame > from && c.frame <= t.frame);
    listed += t.emits.length;
    if (want.length !== t.emits.length) {
      problems.push(`seq ${t.seq} (frame ${t.frame}): ${t.emits.length} emit(s) listed, ${want.length} particles_emit call(s) in (${from}, ${t.frame}]`);
      continue;
    }
    for (let i = 0; i < want.length; i++) {
      const c = want[i];
      const e = t.emits[i];
      const diffs: string[] = [];
      if (e.emit.particles !== c.id) diffs.push(`particles ${e.emit.particles} vs ${c.id}`);
      const flags = num(argOf(c, "emit_flags", "flags"));
      if (flags !== null && e.emit.flags !== flags) diffs.push(`flags ${e.emit.flags} vs ${flags}`);
      const restarts = num(argOf(c, "restarts"));
      if (restarts !== null && e.emit.restarts !== restarts) diffs.push(`restarts ${e.emit.restarts} vs ${restarts}`);
      const parts: [string, number[], number][] = [
        ["transform", e.transform, 12],
        ["velocity", e.velocity, 3],
        ["color", e.color, 4],
        ["custom", e.custom, 4],
      ];
      for (const [k, wire, n] of parts) {
        const h = floatsOf(argOf(c, k));
        if (!h || h.length !== n) diffs.push(`${k}: the call line has ${h?.length ?? "no"} floats`);
        else if (h.some((v, j) => !f32eq(v, wire[j]))) diffs.push(`${k} ${JSON.stringify(wire)} vs ${JSON.stringify(h)}`);
      }
      if (diffs.length > 0) problems.push(`seq ${t.seq}: emit ${i}: ${diffs.join(", ")}`);
    }
    if (problems.length > 12) return problems;
  }
  if (emitCalls.length > 0 && listed === 0) problems.push(`${emitCalls.length} particles_emit call(s), none listed`);
  return problems;
}

/** pt-wire's naming half: every cell's emitter is an ok entry of every transaction from its first
 * state line on (each GPUParticles2D draws itself). */
export function ptNamedProblems(trace: PtTrace, lines: readonly PtLine[], expected: G8ptExpected): string[] {
  const problems: string[] = [];
  const map = mapPtCells(lines, expected);
  for (const name of Object.keys(expected.cells)) {
    const rid = map.ridOfCell.get(name);
    const id = map.idOfCell.get(name);
    if (rid === undefined || id === undefined) {
      problems.push(`${name}: no wire id in the hook log`);
      continue;
    }
    const first = lines.find((l) => l.kind === "state" && l.rid === rid)?.frame;
    if (first === undefined) {
      problems.push(`${name}: no state line`);
      continue;
    }
    const missing = trace.txs.filter((t) => t.frame >= first && t.table.get(id)?.status !== "ok");
    if (missing.length > 0)
      problems.push(`${name} (particles ${id}) is not an ok entry at ${missing.length} transaction(s) from frame ${first} (first: seq ${missing[0].seq})`);
  }
  return problems;
}

// --------------------------------------------------------------------------------- pt-builtin

const PARAM_SAMPLERS: [string, string][] = [
  ["initial_linear_velocity", "linear_velocity_texture"],
  ["angular_velocity", "angular_velocity_texture"],
  ["orbit_velocity", "orbit_velocity_curve"],
  ["linear_accel", "linear_accel_texture"],
  ["radial_accel", "radial_accel_texture"],
  ["tangential_accel", "tangent_accel_texture"],
  ["damping", "damping_texture"],
  ["angle", "angle_texture"],
  ["scale", "scale_curve"],
  ["hue_variation", "hue_rot_curve"],
  ["anim_speed", "animation_speed_curve"],
  ["anim_offset", "animation_offset_curve"],
  ["turb_influence_over_life", "turbulence_influence_over_life"],
  ["turb_vel_influence", ""],
  ["turb_init_displacement", ""],
  ["radial_velocity", "radial_velocity_curve"],
  ["directional_velocity", "directional_velocity_curve"],
  ["scale_over_velocity", "scale_over_velocity_curve"],
];

export interface DerivedKey {
  key: BuiltinParticleProcessMaterial;
  /** key fields (or `textures.<param>`, `particle_flags.<flag>`) the code cannot show */
  underivable: string[];
}

/** ParticleProcessMaterial::MaterialKey from the shader code _update_shader generated
 * (scene/resources/particle_process_material.cpp, 4.5.1), by the lines each key bit adds.
 * Whitespace runs are collapsed first (the server may receive preprocessed code). Some bits do
 * not show in the code: turb_vel_influence and turb_init_displacement textures never; the
 * turbulence influence curve without turbulence; rotate_y with disable_z; the orbit curve's
 * XYZ-ness without disable_z; sub_emitter on a low-end renderer (GLES3: _update_shader emits no
 * sub-emitter code there). */
export function deriveMaterialKey(code: string): DerivedKey {
  const c = code.replace(/[ \t]+/g, " ");
  const has = (s: string) => c.includes(s.replace(/[ \t]+/g, " "));
  const uniform = (decl: string) => new RegExp(`uniform ${decl}\\b`).test(c);
  const sampler = (name: string) => name !== "" && new RegExp(`uniform sampler2D ${name}\\b`).test(c);
  const underivable: string[] = [];
  let shape = "point";
  if (uniform("vec3 emission_ring_axis")) shape = "ring";
  else if (sampler("emission_texture_normal")) shape = "directed_points";
  else if (sampler("emission_texture_points")) shape = "points";
  else if (uniform("vec3 emission_box_extents")) shape = "box";
  else if (uniform("float emission_sphere_radius"))
    shape = has("pos = mix(vec3(0.0, 0.0, 0.0), vec3(radius * cos(t), radius * sin(t), emission_sphere_radius * s), p);")
      ? "sphere"
      : "sphere_surface";
  const disableZ = has("force.z = 0.0;");
  const flags: string[] = [];
  if (has("TRANSFORM[1].xyz = normalize(final_velocity);")) flags.push("align_y_to_velocity");
  if (!disableZ && has("vec4 origin = TRANSFORM[3];")) flags.push("rotate_y");
  if (disableZ) underivable.push("particle_flags.rotate_y");
  if (disableZ) flags.push("disable_z");
  if (has("float damp = v * v * physics_params.damping")) flags.push("damping_as_friction");
  const turbulence = uniform("float turbulence_noise_strength");
  const textures: string[] = [];
  for (const [param, s] of PARAM_SAMPLERS) {
    if (s === "") {
      underivable.push(`textures.${param}`);
      continue;
    }
    if (param === "turb_influence_over_life" && !turbulence) underivable.push(`textures.${param}`);
    if (sampler(s)) textures.push(param);
  }
  const orbit = sampler("orbit_velocity_curve");
  let orbitXyz = false;
  if (orbit && disableZ) orbitXyz = has("texture(orbit_velocity_curve, vec2(lifetime)).b;");
  else if (orbit) underivable.push("orbit_velocity_curve_xyz");
  let sub = "disabled";
  if (uniform("float sub_emitter_frequency")) sub = "constant";
  else if (uniform("int sub_emitter_amount_at_end")) sub = "at_end";
  else if (uniform("int sub_emitter_amount_at_collision")) sub = "at_collision";
  else if (uniform("int sub_emitter_amount_at_start")) sub = "at_start";
  else if (!uniform("bool sub_emitter_keep_velocity")) underivable.push("sub_emitter");
  let collision = "disabled";
  if (uniform("float collision_friction")) collision = "rigid";
  else if (has("if (COLLIDED) { ACTIVE = false; }") || /if \(COLLIDED\) \{\s*ACTIVE = false;/.test(c)) collision = "hide_on_contact";
  const key: BuiltinParticleProcessMaterial = {
    kind: "particle_process_material",
    emission_shape: shape as BuiltinParticleProcessMaterial["emission_shape"],
    particle_flags: flags as BuiltinParticleProcessMaterial["particle_flags"],
    textures: textures as BuiltinParticleProcessMaterial["textures"],
    color_ramp: sampler("color_ramp"),
    color_initial_ramp: sampler("color_initial_ramp"),
    alpha_curve: sampler("alpha_curve"),
    emission_curve: sampler("emission_curve"),
    velocity_limit_curve: sampler("velocity_limit_curve"),
    orbit_velocity_curve_xyz: orbitXyz,
    emission_color_texture: sampler("emission_texture_color"),
    sub_emitter: sub as BuiltinParticleProcessMaterial["sub_emitter"],
    attractor: has("force += ATTRACTOR_FORCE;"),
    collision: collision as BuiltinParticleProcessMaterial["collision"],
    collision_scale: has("render_mode collision_use_scale;"),
    turbulence,
  };
  return { key, underivable };
}

const KEY_FIELDS = [
  "emission_shape",
  "particle_flags",
  "textures",
  "color_ramp",
  "color_initial_ramp",
  "alpha_curve",
  "emission_curve",
  "velocity_limit_curve",
  "orbit_velocity_curve_xyz",
  "emission_color_texture",
  "sub_emitter",
  "attractor",
  "collision",
  "collision_scale",
  "turbulence",
] as const;

/** The differences between a wire builtin and the key derived from its code (the underivable
 * parts skipped: list members by `<field>.<member>`, whole fields by name). */
export function builtinDiffs(wire: BuiltinParticleProcessMaterial, derived: DerivedKey): string[] {
  const out: string[] = [];
  const skip = new Set(derived.underivable);
  for (const k of KEY_FIELDS) {
    if (skip.has(k)) continue;
    let a = wire[k] as unknown;
    let b = derived.key[k] as unknown;
    if (Array.isArray(a) && Array.isArray(b)) {
      a = a.filter((x) => !skip.has(`${k}.${String(x)}`));
      b = (b as unknown[]).filter((x) => !skip.has(`${k}.${String(x)}`));
    }
    if (!sameValue(a, b)) out.push(`${k} ${JSON.stringify(a)} vs the code's ${JSON.stringify(b)}`);
  }
  return out;
}

/** pt-builtin over a trace: every ok particles-mode shader carries the builtin, equal to the key
 * its stored code derives; every cell's material's shader's builtin equals expected.json's key. */
export function ptBuiltinProblems(
  trace: PtTrace,
  lines: readonly PtLine[],
  expected: G8ptExpected,
  codeOfHash: (hash: string) => string | null,
): { problems: string[]; shaders: number } {
  const problems: string[] = [];
  const seen = new Map<string, ResolvedShader>();
  for (const t of trace.txs)
    for (const s of t.shaders.values())
      if (s.mode === "particles") seen.set(`${s.id}:${s.version}`, s);
  for (const s of seen.values()) {
    const b = s.builtin;
    if (!b || b.kind !== "particle_process_material") {
      problems.push(`shader ${s.id} v${s.version}: particles mode, ${s.status}/${s.reason ?? "-"}, builtin ${b ? b.kind : "null"}`);
      continue;
    }
    if (s.status !== "ok") problems.push(`shader ${s.id}: builtin but status ${s.status}/${s.reason}`);
    const code = s.hash ? codeOfHash(s.hash) : null;
    if (code === null) {
      problems.push(`shader ${s.id}: no stored code for hash ${s.hash}`);
      continue;
    }
    for (const d of builtinDiffs(b, deriveMaterialKey(code))) problems.push(`shader ${s.id}: ${d}`);
  }
  if (seen.size === 0) problems.push("no particles-mode shader in the recording");
  // each cell's key, through its emitter's process material at the last transaction
  const last = trace.txs.at(-1);
  const map = mapPtCells(lines, expected);
  if (last)
    for (const [name, cell] of Object.entries(expected.cells)) {
      const id = map.idOfCell.get(name);
      const p = id === undefined ? undefined : last.table.get(id);
      const m = p?.process_material === null || p?.process_material === undefined ? undefined : last.materials.get(p.process_material);
      const s = m?.shader === null || m?.shader === undefined ? undefined : last.shaders.get(m.shader);
      const b = s?.builtin;
      if (!b || b.kind !== "particle_process_material") {
        problems.push(`${name}: no builtin through its emitter's process material (particles ${id}, material ${p?.process_material}, shader ${m?.shader})`);
        continue;
      }
      const want = cellKey(expected, cell);
      for (const k of KEY_FIELDS)
        if (!sameValue(b[k], want[k])) problems.push(`${name}: builtin ${k} ${JSON.stringify(b[k])}, expected ${JSON.stringify(want[k])}`);
    }
  return { problems, shaders: seen.size };
}

// --------------------------------------------------------------------- pt-v11, curves, shim

/** pt-v11: the /11 control's trace and hook log. */
export function ptV11Problems(trace: PtTrace, lines: readonly PtLine[]): string[] {
  const problems: string[] = [];
  const keyed = trace.txs.filter((t) => t.has_keys);
  if (keyed.length > 0) problems.push(`${keyed.length} transaction(s) carry a particles key (first seq ${keyed[0].seq})`);
  let add = 0;
  const reasons: Record<string, number> = {};
  for (const t of trace.txs)
    for (const it of t.items.values()) {
      add += it.add_particles;
      for (const [r, n] of Object.entries(it.unsupported)) reasons[r] = (reasons[r] ?? 0) + n;
    }
  if (add > 0) problems.push(`${add} add_particles command(s)`);
  if (Object.keys(reasons).length === 0) problems.push("no unsupported canvas_item_add_particles command (proves nothing)");
  for (const [r, n] of Object.entries(reasons))
    if (r !== "unsupported-op") problems.push(`${n} canvas_item_add_particles command(s) typed ${r}`);
  const shaders = new Map<number, ResolvedShader>();
  for (const t of trace.txs) for (const s of t.shaders.values()) if (s.mode === "particles") shaders.set(s.id, s);
  for (const s of shaders.values())
    if (s.status !== "unsupported" || s.reason !== "shader-mode" || s.builtin !== null)
      problems.push(`shader ${s.id}: particles mode ${s.status}/${s.reason ?? "-"}, builtin ${s.builtin ? s.builtin.kind : "null"} (expected unsupported/shader-mode)`);
  if (lines.length > 0) problems.push(`${lines.length} particles hook line(s): /11 installs no particles hook`);
  return problems;
}

/** pt-curve-textures: the 64x1 textures (F_CURVES's curve and gradient) of a trace. At /12 there
 * are exactly `count` of them, ok float textures, named by a particles-mode shader's material;
 * at /11 none is ok. */
export function ptCurveProblems(trace: PtTrace, expected: G8ptExpected, count: number): { problems: string[]; seen: string[] } {
  const problems: string[] = [];
  const ft = expected.float_texture;
  const found = new Map<number, ResolvedTexture>();
  for (const t of trace.txs)
    for (const x of t.textures.values()) if (x.width === ft.width && x.height === ft.height) found.set(x.id, x);
  const seen = [...found.values()].map((x) => `${x.id}:${x.status}/${x.reason ?? x.format}`);
  if (trace.version >= 12) {
    if (found.size !== count) problems.push(`${found.size} ${ft.width}x${ft.height} texture(s), expected ${count}`);
    for (const x of found.values()) {
      if (x.status !== "ok") problems.push(`texture ${x.id}: ${x.status}/${x.reason}`);
      else if (!ft.formats.includes(x.format ?? "")) problems.push(`texture ${x.id}: format ${x.format}, not a float format`);
    }
    const last = trace.txs.at(-1);
    const named = new Set<number>();
    for (const m of last?.materials.values() ?? []) {
      const s = m.shader === null ? undefined : last?.shaders.get(m.shader);
      if (s?.mode !== "particles") continue;
      for (const p of m.params)
        if (p.value && typeof p.value === "object" && !Array.isArray(p.value) && "tex" in p.value) named.add(p.value.tex);
    }
    for (const x of found.values())
      if (!named.has(x.id)) problems.push(`texture ${x.id} is named by no process material at the last transaction`);
  } else {
    for (const x of found.values())
      if (x.status === "ok") problems.push(`texture ${x.id} is ok at /${trace.version}`);
      else if (x.reason !== "unsupported-format") problems.push(`texture ${x.id}: ${x.status}/${x.reason} (expected unsupported-format)`);
  }
  return { problems, seen };
}

/** pt-shim's no-shim half: no particles entry, every add_particles unknown-particles. */
export function ptNoShimProblems(trace: PtTrace): string[] {
  const problems: string[] = [];
  let add = 0;
  let unknown = 0;
  const other: Record<string, number> = {};
  for (const t of trace.txs) {
    if (t.table.size > 0) {
      problems.push(`seq ${t.seq}: ${t.table.size} particles entr(ies) without the shim`);
      break;
    }
  }
  for (const t of trace.txs)
    for (const it of t.items.values()) {
      add += it.add_particles;
      for (const [r, n] of Object.entries(it.unsupported))
        if (r === "unknown-particles") unknown += n;
        else other[r] = (other[r] ?? 0) + n;
    }
  if (add > 0) problems.push(`${add} add_particles command(s) without the shim`);
  if (unknown === 0) problems.push("no unknown-particles command (proves nothing)");
  for (const [r, n] of Object.entries(other)) problems.push(`${n} canvas_item_add_particles typed ${r}`);
  return problems;
}

/** pt-shim's shim half (beyond the census and pt-wire): every emitter its own rid and wire id. */
export function ptShimDistinctProblems(lines: readonly PtLine[], expected: G8ptExpected): string[] {
  const problems: string[] = [];
  const creates = lines.filter((l): l is PtCall => l.kind === "call" && l.call === "create");
  const rids = new Set(creates.map((c) => c.rid));
  const ids = new Set(creates.map((c) => c.id));
  const n = Object.keys(expected.cells).length;
  if (creates.length !== n) problems.push(`${creates.length} particles_create, expected ${n}`);
  if (rids.size !== creates.length || rids.has("0") || rids.has(""))
    problems.push(`${rids.size} distinct non-null rid(s) over ${creates.length} creates`);
  if (ids.size !== creates.length || ids.has(null)) problems.push(`${ids.size} distinct wire id(s) over ${creates.length} creates`);
  return problems;
}

// ---------------------------------------------------------------------------- pt-receiver

/** The add_particles commands a receiver's planner leaves undrawn over a trace: the commands of
 * every item that is new or whose content_version moved, per transaction (rs-core-capi plan.rs
 * replays exactly those items). */
export function replayedParticleCommands(trace: PtTrace): number {
  let n = 0;
  let prev = new Map<number, number>();
  for (const t of trace.txs) {
    const next = new Map<number, number>();
    for (const [id, it] of t.items) {
      next.set(id, it.content_version);
      if (prev.get(id) !== it.content_version) n += it.add_particles;
    }
    prev = next;
  }
  return n;
}

/** The receiver's particles-undrawn count: its stats total when applied.json carries one, else
 * its stdout's per-command lines. */
export function receiverUndrawn(applied: Record<string, unknown> | null, stdout: string): { count: number; source: string } {
  const find = (o: unknown, depth: number): number | null => {
    if (!o || typeof o !== "object" || depth > 4) return null;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if ((k === "particles_commands_undrawn" || k === "particles_undrawn") && typeof v === "number") return v;
      if (k === "transactions" || k === "fetches" || k === "uploads" || k === "mesh_uploads") continue;
      const r = find(v, depth + 1);
      if (r !== null) return r;
    }
    return null;
  };
  const total = find(applied, 0);
  if (total !== null) return { count: total, source: "applied.json" };
  const lines = stdout.split("\n").filter((l) => l.includes("canvas_item_add_particles (particles-undrawn)"));
  return { count: lines.length, source: "stdout.log" };
}

/** PM6a: what a receiver replaying `trace` from its first transaction re-issues (pt-replay): one
 * emitter per entry ever `ok` in the published table (the items draw it or a drawn one names it as
 * subemitter), their final `restarts` summed, and every listed emit. */
export function ptWireTotals(trace: PtTrace): PtWireTotals {
  const restarts = new Map<number, number>();
  let emits = 0;
  for (const t of trace.txs) {
    for (const [id, e] of t.table) if (e.status === "ok") restarts.set(id, Math.max(restarts.get(id) ?? 0, e.restarts));
    emits += t.emits.length;
  }
  const r = [...restarts.values()].reduce((a, b) => a + b, 0);
  return { emitters: restarts.size, restarts: r, emits, seeds: restarts.size };
}

// --------------------------------------------------------------------------------- pt-bytes

export interface PtBytes {
  transactions: number;
  frames: number;
  total_bytes: number;
  mean_bytes_per_transaction: number;
  max_bytes_per_transaction: number;
  bytes_per_frame: number;
  mean_bytes_per_patch: number | null;
}

/** pt_f32's measured bytes (4 a float) over a trace. */
export function ptBytes(trace: PtTrace): PtBytes {
  const b = trace.txs.map((t) => t.pt_floats * 4);
  const total = b.reduce((x, y) => x + y, 0);
  const frames = trace.txs.length > 0 ? trace.txs[trace.txs.length - 1].frame - trace.txs[0].frame + 1 : 0;
  const patches = trace.txs.filter((t) => !t.full).map((t) => t.pt_floats * 4);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    transactions: b.length,
    frames,
    total_bytes: total,
    mean_bytes_per_transaction: b.length ? round(total / b.length) : 0,
    max_bytes_per_transaction: b.length ? Math.max(...b) : 0,
    bytes_per_frame: frames ? round(total / frames) : 0,
    mean_bytes_per_patch: patches.length ? round(patches.reduce((x, y) => x + y, 0) / patches.length) : null,
  };
}

// --------------------------------------------------------------------------------- pt-pump

/** pt-pump on gate8-mm's hook logs: with the pump, the census is the rendered host's (the drawn
 * CPUParticles2D cells and I_PREDRAW set a buffer every frame); without it, none of the cells
 * whose buffer comes from frame_pre_draw sets one after _ready. */
export function ptPumpProblems(
  pumpText: string | undefined,
  noPumpText: string | undefined,
  mm: G8mmExpected,
  pumpTeardown: number,
): { pump: string[]; nopump: string[] } {
  const pumpLines = parseMmLog(pumpText);
  const pump = pumpText === undefined ? ["no hook log"] : mmCensusProblems(pumpLines, mm, "rendered", pumpTeardown);
  const nopump: string[] = [];
  if (noPumpText === undefined) nopump.push("no hook log");
  else {
    const lines = parseMmLog(noPumpText);
    const map = mmMapCells(lines, mm);
    for (const [name, cell] of Object.entries(mm.cells)) {
      const h = cell.headless;
      if (!cell.per_frame.includes("set_buffer") || !h || (h.per_frame ?? []).includes("set_buffer")) continue;
      const rid = map.ridOfCell.get(name);
      const n = lines.filter((l) => l.kind === "call" && l.rid === rid && l.call === "set_buffer").length;
      const allowed = h.calls?.set_buffer ?? 0;
      if (n > allowed) nopump.push(`${name}: ${n} set_buffer without the pump, expected ${allowed}`);
    }
  }
  return { pump, nopump };
}

// --------------------------------------------------------------------------------- the runner

export const PT_SABOTAGES = ["perturb-seed", "drop-restart"] as const;
const SINKS_12 = ["recording.rs12", "recording-patch.rs12"];
const SINKS_11 = ["recording.rs11", "recording-patch.rs11"];
const LEGS = [
  "import/fixture",
  "capture",
  "capture-v11",
  ...PT_SABOTAGES.map((s) => `sabotage-${s}/capture`),
  "headless/capture",
  "headless-shim/capture",
  "headless-pump/capture",
  "headless-nopump/capture",
  "reference",
  "reference-repeat",
  "receiver",
  "receiver-patch",
  "sabotage-undrawn-particles/receiver",
  "sabotage-ignore-particle-emits/receiver",
  "sabotage-drop-restart/receiver-patch",
  ...LATE_LEGS,
];

function rsCoreValidate(path: string, version: number): string {
  if (!existsSync(RS_CORE_CHECK)) return `missing ${RS_CORE_CHECK} (build-rs-core.sh)`;
  const r = spawnSync(RS_CORE_CHECK, ["validate", path, "--version", String(version)], { encoding: "utf8" });
  const line = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  const cols = line.split("\t");
  return cols[1] === "ok" ? "ok" : `${cols[1] ?? "?"}: ${(cols[2] ?? r.stderr ?? "").slice(0, 200)}`;
}
async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}
async function validateBoth(path: string, version: 11 | 12): Promise<[string, string] | null> {
  const data = await bytesOf(path);
  if (!data) return null;
  const ts = validateRecording(data, version);
  return [ts.length === 0 ? "ok" : ts[0].slice(0, 240), rsCoreValidate(path, version)];
}
function notRun(id: string, criterion: string, leg: string, why: string): G8aCheck {
  return { id, criterion, passed: true, status: "not-run", detail: `${why}: ${leg}`, gating: false };
}

export interface G8ptReport {
  legs: Record<string, unknown>;
}

export async function runG8pt(
  out: string,
  expected: G8ptExpected,
  mmExpected: G8mmExpected,
): Promise<{ checks: G8aCheck[]; report: G8ptReport }> {
  const g = join(out, "g8pt");
  const checks: G8aCheck[] = [];
  const report: G8ptReport = { legs: {} };
  const dir = (leg: string) => join(g, leg);
  const legSkipped = (leg: string) => skipped(dir(leg));
  const hookText = (leg: string) => readText(join(dir(leg), "evidence", "resources.jsonl"));
  const hookLog = async (leg: string) => parsePtLog(await hookText(leg));
  const trace = async (leg: string, sink: string, version: 11 | 12) => {
    const data = await bytesOf(join(dir(leg), sink));
    return data ? tracePtRecording(data, version) : null;
  };

  // g8pt-legs
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of LEGS) {
      if (legSkipped(leg)) continue;
      const rc = await exitCode(dir(leg));
      if (rc === null) problems.push(`${leg}: did not run`);
      else {
        any = true;
        if (rc !== "0") problems.push(`${leg}: exit ${rc}`);
      }
    }
    checks.push(check("g8pt-legs", "PM5: every g8pt leg that ran exited 0", any ? problems : null));
  }

  // pt-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const [leg, version, sinks] of [
      ["capture", 12, SINKS_12],
      ["headless/capture", 12, SINKS_12],
      ["headless-shim/capture", 12, SINKS_12],
      ["headless-pump/capture", 12, SINKS_12],
      ["headless-nopump/capture", 12, SINKS_12],
      ["capture-v11", 11, SINKS_11],
    ] as const) {
      if (legSkipped(leg)) continue;
      for (const sink of sinks) {
        const v = await validateBoth(join(dir(leg), sink), version);
        if (!v) {
          problems.push(`${leg}/${sink}: missing`);
          continue;
        }
        any = true;
        if (v[0] !== "ok") problems.push(`${leg}/${sink}: TS ${v[0]}`);
        if (v[1] !== "ok") problems.push(`${leg}/${sink}: rs-core ${v[1]}`);
      }
    }
    checks.push(
      check(
        "pt-validate",
        "PM5: every honest g8pt recording (/12 rendered, headless, shim and pump legs, the /11 control; both sinks) passes the TypeScript validator and rs-core-check",
        any ? problems : null,
      ),
    );
  }

  // the honest particle legs: census, wire, bytes
  const census: string[] = [];
  const wire: string[] = [];
  const bytesDetail: string[] = [];
  let anyHonest = false;
  const store = (leg: string) => (hash: string): string | null => {
    for (const p of [join(dir(leg), "store", "sha256", `${hash}.grp`), join(dir(leg), "store", "sha256", hash)]) {
      try {
        return decodeShaderPayload(new Uint8Array(readFileSync(p))).code;
      } catch {
        // next candidate
      }
    }
    return null;
  };
  for (const leg of ["capture", "headless-shim/capture"]) {
    if (legSkipped(leg)) continue;
    const lines = await hookLog(leg);
    const traces = new Map<string, PtTrace>();
    for (const sink of SINKS_12) {
      const t = await trace(leg, sink, 12);
      if (!t) {
        wire.push(`${leg}/${sink}: missing`);
        continue;
      }
      anyHonest = true;
      traces.set(sink, t);
    }
    const fullTrace = traces.get(SINKS_12[0]) ?? traces.get(SINKS_12[1]);
    const lastFrame = fullTrace?.txs.at(-1)?.frame ?? Number.POSITIVE_INFINITY;
    for (const p of ptCensusProblems(lines, expected, lastFrame)) census.push(`${leg}: ${p}`);
    const legReport: Record<string, unknown> = {
      hook_lines: lines.length,
      state_lines: lines.filter((l) => l.kind === "state").length,
      emit_lines: lines.filter((l) => l.kind === "call" && l.call === "emit").length,
    };
    for (const [sink, t] of traces) {
      for (const e of t.errors.slice(0, 3)) wire.push(`${leg}/${sink}: decode ${e}`);
      for (const p of ptWireProblems(t, lines)) wire.push(`${leg}/${sink}: ${p}`);
      for (const p of ptEmitProblems(t, lines)) wire.push(`${leg}/${sink}: ${p}`);
      for (const p of ptNamedProblems(t, lines, expected)) wire.push(`${leg}/${sink}: ${p}`);
      const b = ptBytes(t);
      legReport[sink] = { pt_f32: b };
      bytesDetail.push(
        `${leg}/${sink}: ${b.mean_bytes_per_transaction} B/tx mean, ${b.max_bytes_per_transaction} max, ${b.bytes_per_frame} B/frame${b.mean_bytes_per_patch === null ? "" : `, ${b.mean_bytes_per_patch} B/patch`}`,
      );
    }
    report.legs[leg] = legReport;
  }
  checks.push(
    check(
      "pt-hook-census",
      "PM5: per cell, the hook log's particles calls (creates, setters, restarts, emits, frees, draw passes) equal expected.json, and the cell's last state line its fields (rendered capture and headless shim capture)",
      anyHonest ? census : null,
    ),
  );
  checks.push(
    check(
      "pt-wire",
      "PM5: at every transaction each resolved entry's JSON fields and floats equal the newest hook-log state line at or before its frame and the call lines' values (counters included); the emit list equals the particles_emit calls in (B, T]; every cell's emitter is an ok entry from its first state line on",
      anyHonest ? wire : null,
    ),
  );
  checks.push({
    id: "pt-bytes",
    criterion: "PM5 (informational): pt_f32 bytes per transaction (mean, max) and per frame, per honest /12 leg and sink",
    passed: true,
    status: anyHonest ? "pass" : "not-run",
    detail: bytesDetail.join("; ") || "no honest recording",
    gating: false,
  });

  // pt-builtin (the rendered capture: the node map's builtin)
  {
    const leg = "capture";
    if (legSkipped(leg)) checks.push(notRun("pt-builtin", "PM5: the builtin equals the code's key", leg, "skipped"));
    else {
      const t = await trace(leg, SINKS_12[0], 12);
      const r = t ? ptBuiltinProblems(t, await hookLog(leg), expected, store(leg)) : null;
      checks.push(
        check(
          "pt-builtin",
          "PM5: every particles-mode shader carries a particle_process_material builtin equal to the MaterialKey derived from its stored generated code (_update_shader's markers), and each cell's builtin equals expected.json's key",
          r ? r.problems : null,
          r ? `${r.shaders} particles shader(s)` : undefined,
        ),
      );
    }
  }

  // pt-v11
  {
    const leg = "capture-v11";
    if (legSkipped(leg)) checks.push(notRun("pt-v11", "PM5: the /11 control carries no particles", leg, "skipped"));
    else {
      const t = await trace(leg, SINKS_11[0], 11);
      checks.push(
        check(
          "pt-v11",
          "PM5: the /11 control has no particles key, every add_particles lowered to unsupported/unsupported-op, process-material shaders unsupported/shader-mode, no particles hook line",
          t ? ptV11Problems(t, await hookLog(leg)) : null,
        ),
      );
    }
  }

  // pt-curve-textures
  {
    const problems: string[] = [];
    const seen: string[] = [];
    let ok = true;
    for (const [leg, version, sink] of [
      ["capture", 12, SINKS_12[0]],
      ["capture-v11", 11, SINKS_11[0]],
    ] as const) {
      if (legSkipped(leg)) continue;
      const t = await trace(leg, sink, version);
      if (!t) {
        ok = false;
        continue;
      }
      const r = ptCurveProblems(t, expected, expected.cells.F_CURVES.textures?.length ?? 2);
      for (const p of r.problems) problems.push(`${leg}: ${p}`);
      seen.push(`${leg}: ${r.seen.join(", ") || "none"}`);
    }
    checks.push(
      check(
        "pt-curve-textures",
        "PM5: F_CURVES's curve and gradient textures (64x1) are ok float textures named by its process material at /12, and never ok at /11 (unsupported-format)",
        ok ? problems : null,
        seen.join("; "),
      ),
    );
  }

  // pt-shim
  {
    const problems: string[] = [];
    let ran = true;
    const a = "headless/capture";
    const b = "headless-shim/capture";
    if (legSkipped(a) || legSkipped(b)) checks.push(notRun("pt-shim", "PM5: the particles RID shim", `${a}, ${b}`, "skipped"));
    else {
      const t = await trace(a, SINKS_12[0], 12);
      if (!t) ran = false;
      else for (const p of ptNoShimProblems(t)) problems.push(`${a}: ${p}`);
      for (const p of ptShimDistinctProblems(await hookLog(b), expected)) problems.push(`${b}: ${p}`);
      // the census and pt-wire on the shim leg are judged with the honest legs above
      const shimWire = wire.filter((w) => w.startsWith(b)).length + census.filter((w) => w.startsWith(b)).length;
      if (shimWire > 0) problems.push(`${b}: ${shimWire} pt-wire/pt-hook-census problem(s) (see those checks)`);
      checks.push(
        check(
          "pt-shim",
          "PM5: headless without GRC_HEADLESS_PARTICLES no emitter is keyed (no particles entry, every add_particles unknown-particles); with =synthesize every emitter has its own rid and id, and pt-hook-census and pt-wire hold",
          ran ? problems : null,
        ),
      );
    }
  }

  // pt-pump (gate8-mm, headless)
  {
    const a = "headless-pump/capture";
    const b = "headless-nopump/capture";
    if (legSkipped(a) || legSkipped(b)) checks.push(notRun("pt-pump", "PM5: the pre-draw pump", `${a}, ${b}`, "skipped"));
    else {
      const t = await trace(a, SINKS_12[0], 12);
      const r = ptPumpProblems(await hookText(a), await hookText(b), mmExpected, t?.txs.at(-1)?.frame ?? Number.POSITIVE_INFINITY);
      const problems = [...r.pump.map((p) => `${a}: ${p}`), ...r.nopump.map((p) => `${b}: ${p}`)];
      checks.push(
        check(
          "pt-pump",
          "PM5: on gate8-mm headless with GRC_PREDRAW_PUMP=1 the multimesh census is the rendered host's (C_FLIP, D_GLOBAL and I_PREDRAW set a buffer every frame); without the pump they never do",
          problems,
        ),
      );
    }
  }

  // pt-receiver (PM5's acceptance; PM6a: the honest receiver leaves nothing undrawn, and PM5's
  // count now holds on the pre-PM6 planner, receiver sabotage undrawn-particles)
  {
    const appliedOf = async (leg: string) => {
      try {
        return JSON.parse((await readText(join(dir(leg), "applied.json"))) ?? "null") as Record<string, unknown> | null;
      } catch {
        return null;
      }
    };
    const leg = "receiver";
    const pre = "sabotage-undrawn-particles/receiver";
    if (legSkipped(leg)) checks.push(notRun("pt-receiver", "PM5: the native receiver accepts /12", leg, "skipped"));
    else {
      const problems: string[] = [];
      const applied = await appliedOf(leg);
      const t = await trace("capture", SINKS_12[0], 12);
      const want = t ? replayedParticleCommands(t) : null;
      let detail: string | undefined;
      if (!applied) problems.push("no applied.json");
      else {
        if (applied.status !== "ok") problems.push(`applied.json status ${String(applied.status)}`);
        const protocol = (applied.receiver as Record<string, unknown> | undefined)?.protocol;
        if (protocol !== "render-stream/12") problems.push(`receiver protocol ${String(protocol)}`);
        const u = receiverUndrawn(applied, (await readText(join(dir(leg), "stdout.log"))) ?? "");
        if (u.count !== 0) problems.push(`${u.count} particles-undrawn on the honest receiver (${u.source})`);
        detail = "0 particles-undrawn";
      }
      if (!legSkipped(pre)) {
        const a = await appliedOf(pre);
        const u = receiverUndrawn(a, (await readText(join(dir(pre), "stdout.log"))) ?? "");
        if (!a) problems.push(`${pre}: no applied.json`);
        else if (want === null) problems.push("no /12 capture to count against");
        else if (u.count !== want) problems.push(`${pre}: ${u.count} particles-undrawn (${u.source}), ${want} add_particles in the replayed items`);
        else if (want === 0) problems.push("no add_particles replayed (proves nothing)");
        else detail = `${detail ?? ""}; the pre-PM6 planner: ${u.count} particles-undrawn = the replayed add_particles`;
      }
      checks.push(
        check(
          "pt-receiver",
          "PM5/PM6a: the native receiver (RS_RECEIVER_PROTOCOL=12) accepts the /12 capture (status ok) and leaves no add_particles undrawn; the pre-PM6 planner types every replayed one particles-undrawn",
          problems,
          detail,
        ),
      );
    }
  }

  // PM6a: the receivers' pixels and replay counts (gate8-pt-receiver-checks.ts)
  {
    const t = await trace("capture", SINKS_12[0], 12);
    const receivers: Record<string, unknown> = {};
    report.legs.receivers = receivers;
    await runG8ptReceivers(g, expected.checkpoints, expected.pixels, t ? ptWireTotals(t) : null, checks, receivers);
  }

  // PM7: the late arm (gate8-pt-late-checks.ts)
  {
    const late: Record<string, unknown> = {};
    report.legs.late = late;
    await runG8ptLate(
      g,
      expected.checkpoints,
      expected.pixels,
      expected.late,
      {
        validate: (path) => validateBoth(path, 12),
        trace: async (leg, sink) => {
          const t = await trace(leg, sink, 12);
          return t ? (t.txs as unknown as PtLateTx[]) : null;
        },
        amountOf: (cell) => expected.cells[cell]?.amount,
      },
      checks,
      late,
    );
  }

  // the sabotages: the validators accept the patch sink, pt-wire fails on it
  for (const s of PT_SABOTAGES) {
    const leg = `sabotage-${s}/capture`;
    const vid = `pt-sabotage-validate-${s}`;
    const cid = `pt-wire-catches-${s}`;
    const why = legSkipped(leg);
    if (why) {
      checks.push(notRun(vid, `PM5: both validators accept ${leg}`, leg, why));
      checks.push(notRun(cid, `PM5: pt-wire fails on ${leg}`, leg, why));
      continue;
    }
    const v = await validateBoth(join(dir(leg), SINKS_12[1]), 12);
    const vf = await validateBoth(join(dir(leg), SINKS_12[0]), 12);
    const vp: string[] = [];
    if (v && v[0] !== "ok") vp.push(`${SINKS_12[1]}: TS ${v[0]}`);
    if (v && v[1] !== "ok") vp.push(`${SINKS_12[1]}: rs-core ${v[1]}`);
    const fullNote = vf
      ? `full sink: TS ${vf[0] === "ok" ? "ok" : vf[0].split(":")[0]}, rs-core ${vf[1] === "ok" ? "ok" : vf[1].split(":")[0]}`
      : "full sink missing";
    const vc = check(vid, `PM5: both validators accept the ${s} patch recording (the host's seed and restart count are not on the wire twice)`, v ? vp : null, fullNote);
    if (!vc.passed && v) vc.detail = `${vc.detail ?? ""}; ${fullNote}`;
    checks.push(vc);
    const t = await trace(leg, SINKS_12[1], 12);
    if (!t) {
      checks.push(check(cid, `PM5: pt-wire fails on ${leg}`, null));
      continue;
    }
    const lines = await hookLog(leg);
    const caught = [...ptWireProblems(t, lines), ...ptEmitProblems(t, lines)];
    checks.push(
      check(cid, `PM5: pt-wire fails on the ${s} patch recording`, caught.length > 0 ? [] : ["pt-wire passed: the sabotage went unseen"], caught[0]),
    );
  }
  return { checks, report };
}
