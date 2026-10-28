// Gate 8 g8mm checks (PM1, protocol/render-stream-11.md "As built (PM1): decisions"; the fixture is
// fixtures/gate8-mm, its predictions expected.json). PM1 is the capture side only: every leg is a
// capture, judged against its own hook log (rule 12, evidence/resources.jsonl, kind "multimesh")
// and the fixture's own frame log (mm-frames.jsonl). Receivers are PM2's.
//
//   g8mm-legs                   every leg that ran exited 0
//   mm-validate                 every honest recording (the /11 rendered and headless captures, the
//                               /10 control; both sinks) passes the TypeScript validator and
//                               rs-core-check at its version
//   mm-sabotage-validate-<kind> the sabotage recordings still pass both validators (a validator
//                               cannot see the buffer serial or the host's floats)
//   mm-hook-census              the hook log's multimesh calls per cell equal expected.json:
//                               creates, allocations (instances, format, colors, custom), set_buffer
//                               (every frame for the active cells on the rendered host, never from
//                               CPUParticles2D or frame_pre_draw headless), setters, visible
//                               counts, frees, rejected calls; every multimesh rid is a cell's
//   mm-wire                     at every transaction, every resolved multimesh's buffer_sha256 and
//                               fields equal the newest hook-log `state` line at or before its
//                               frame; every drawn cell is in the table from its first state line
//                               (H_FREE: a freed tombstone after its free, then gone), the hidden
//                               emitter never
//   mm-wire-catches-<kind>      mm-wire FAILS on the sabotage's patch recording (perturb-instance,
//                               stale-buffer)
//   mm-frame-pairing            for B_CUSTOM and I_PREDRAW, (instance 0's custom.x - the transaction
//                               frame) is one constant across the leg and equals the hook log's
//                               (value - call frame): a one-frame lag fails
//   mm-v10                      the /10 control: no multimeshes key, every multimesh draw is
//                               unsupported/unsupported-op, no multimesh hook line
//   mm-bytes                    (informational) mm_f32 bytes per transaction (mean, max) and per
//                               frame, per honest /11 leg and sink (also in the report)
//
// The hook-log field names of rule 12 are read in ONE place, parseMmLine(), so a refinement of the
// capture's spelling is a one-function change. The pure helpers are exported for
// scripts/test/self-test-gate8-mm.ts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { check, exitCode, type G8aCheck, readText, skipped } from "./gate8-adopt-checks";
import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import {
  applyTransaction,
  type DecodedBlock,
  decodeRecord,
  emptyResolvedState,
  multimeshStride,
  type ResolvedMultimesh,
  type ResolvedState,
  rawRecordBlock,
  splitRecords,
  type TransactionMeta,
  transactionMultimeshes,
  validateRecording,
  withRecordMemo,
} from "./render-stream-2";

// ------------------------------------------------------------------------------ expected.json

export interface MmPairing {
  instance: number;
  float: number;
  sentinel: number;
  source: "set_buffer" | "instance_set_custom_data";
}
export interface MmCellCalls {
  calls: Record<string, number>;
  per_frame: string[];
}
export interface MmCell extends MmCellCalls {
  node: string;
  instances: number;
  colors: boolean;
  custom: boolean;
  allocations: [number, string, boolean, boolean][];
  visible: number[];
  rejected: number;
  drawn: boolean;
  pairing?: MmPairing;
  freed_at_step?: number;
  headless?: Partial<MmCellCalls>;
}
export interface G8mmExpected {
  schema: string;
  quit_frame: number;
  checkpoints: { step: number; applied: number; settle: number }[];
  h_clear_frame: number;
  sabotage_frame: number;
  min_per_frame_frames: number;
  min_paired_transactions: number;
  cells: Record<string, MmCell>;
}
export type LegKind = "rendered" | "headless";

// ------------------------------------------------------------------------- hook log (rule 12)

export interface MmCall {
  kind: "call";
  /** The call without its `multimesh_` prefix (allocate_data, set_buffer, instance_set_custom_data,
   * ...); RenderingServer::free on a multimesh is `free`. */
  call: string;
  frame: number;
  rid: string;
  id: number | null;
  accepted: boolean;
  instances: number | null;
  format: string | null;
  colors: boolean | null;
  custom: boolean | null;
  visible: number | null;
  sha256: string | null;
  floats: number | null;
}
export interface MmState {
  kind: "state";
  frame: number;
  rid: string;
  id: number | null;
  version: number;
  instances: number;
  format: string;
  colors: boolean;
  custom: boolean;
  visible: number;
  status: string;
  reason: string | null;
  buffer_sha256: string | null;
}
export type MmLine = MmCall | MmState;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function first<T>(...vs: (T | null)[]): T | null {
  for (const v of vs) if (v !== null) return v;
  return null;
}
/** "2d"/"3d" from the spellings a hook line may use: the wire's word, RS's enum value
 * (MULTIMESH_TRANSFORM_2D = 0, _3D = 1) or its name. */
function formatOf(v: unknown): string | null {
  if (v === 0 || v === "2d" || v === "TRANSFORM_2D" || v === "MULTIMESH_TRANSFORM_2D") return "2d";
  if (v === 1 || v === "3d" || v === "TRANSFORM_3D" || v === "MULTIMESH_TRANSFORM_3D") return "3d";
  return typeof v === "string" ? v : null;
}

/** One resources.jsonl line as a multimesh call or state line (rule 12), or null when it is not
 * a multimesh line. The ONLY place that knows the line's field names. */
export function parseMmLine(raw: Record<string, unknown>): MmLine | null {
  if (raw.kind !== "multimesh") return null;
  const name = str(raw.call) ?? str(raw.op) ?? "";
  const frame = num(raw.frame) ?? 0;
  const rid = raw.rid === undefined || raw.rid === null ? "" : String(raw.rid);
  const id = num(raw.id);
  if (name === "state") {
    return {
      kind: "state",
      frame,
      rid,
      id,
      version: num(raw.version) ?? -1,
      instances: num(raw.instances) ?? -1,
      format: formatOf(raw.format) ?? "?",
      colors: bool(raw.colors) ?? false,
      custom: bool(raw.custom) ?? false,
      visible: num(raw.visible) ?? -1,
      status: str(raw.status) ?? "?",
      reason: str(raw.reason),
      buffer_sha256: str(raw.buffer_sha256),
    };
  }
  let call = name.replace(/^canvas_item_/, "").replace(/^multimesh_/, "");
  if (call === "free_rid" || call === "free") call = "free";
  if (call === "allocate") call = "allocate_data";
  const floats = raw.floats;
  return {
    kind: "call",
    call,
    frame,
    rid,
    id,
    accepted: raw.accepted !== false,
    instances: first(num(raw.instances), num(raw.count)),
    format: formatOf(raw.format ?? raw.transform_format),
    colors: first(bool(raw.colors), bool(raw.use_colors)),
    custom: first(bool(raw.custom), bool(raw.use_custom_data)),
    visible: first(num(raw.visible), num(raw.visible_instances), num(raw.value)),
    sha256: str(raw.sha256),
    floats: Array.isArray(floats) ? floats.length : num(floats),
  };
}

/** The multimesh lines of a resources.jsonl text (malformed lines are skipped). A line without a
 * rid but with a wire id gets the rid an earlier line paired with that id: the mirror writes a
 * freed multimesh's `state` line with `rid: null` (the RID is dead), its id kept. */
export function parseMmLog(text: string | undefined): MmLine[] {
  const out = parseMmLines(text);
  const ridOfId = new Map<number, string>();
  for (const l of out) {
    if (l.id === null) continue;
    if (l.rid !== "" && !ridOfId.has(l.id)) ridOfId.set(l.id, l.rid);
    else if (l.rid === "") l.rid = ridOfId.get(l.id) ?? "";
  }
  return out;
}

function parseMmLines(text: string | undefined): MmLine[] {
  const out: MmLine[] = [];
  for (const l of (text ?? "").split("\n")) {
    if (l.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object") continue;
    const m = parseMmLine(raw as Record<string, unknown>);
    if (m) out.push(m);
  }
  return out;
}

/** mm-frames.jsonl (mm.gd _log_buffer): one line per frame-carrying buffer of B and I. */
export interface FixtureMmLine {
  cell: string;
  frame: number;
  value: number;
  sha256: string;
}

// ----------------------------------------------------------------------------- cell mapping

export interface CellMap {
  cellOfRid: Map<string, string>;
  ridOfCell: Map<string, string>;
  idOfCell: Map<string, number>;
  problems: string[];
}

/** Each rid's cell by its last allocation's instance count (unique per cell). */
export function mapCells(lines: readonly MmLine[], expected: G8mmExpected): CellMap {
  const lastAlloc = new Map<string, number>();
  const ids = new Map<string, number>();
  const rids = new Set<string>();
  for (const l of lines) {
    rids.add(l.rid);
    if (l.id !== null && !ids.has(l.rid)) ids.set(l.rid, l.id);
    if (l.kind === "call" && l.call === "allocate_data" && l.accepted && l.instances !== null)
      lastAlloc.set(l.rid, l.instances);
  }
  const byCount = new Map<number, string>();
  for (const [name, c] of Object.entries(expected.cells)) byCount.set(c.instances, name);
  const out: CellMap = {
    cellOfRid: new Map(),
    ridOfCell: new Map(),
    idOfCell: new Map(),
    problems: [],
  };
  for (const rid of rids) {
    const n = lastAlloc.get(rid);
    const cell = n === undefined ? undefined : byCount.get(n);
    if (!cell) {
      out.problems.push(
        `rid ${rid}: no cell (last allocation ${n ?? "none"})`,
      );
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

// ---------------------------------------------------------------------------- mm-hook-census

function cellCalls(cell: MmCell, leg: LegKind): MmCellCalls {
  const o = leg === "headless" ? cell.headless : undefined;
  return {
    calls: { ...cell.calls, ...(o?.calls ?? {}) },
    per_frame: o?.per_frame ?? cell.per_frame,
  };
}

/** A teardown line: a node or resource destructor after the quit (at or after `teardownFrame`,
 * the last transaction's frame). */
function isTeardown(l: MmCall, teardownFrame: number): boolean {
  return (
    l.frame >= teardownFrame &&
    (l.call === "free" || (l.call === "set_visible_instances" && l.visible === 0))
  );
}

/** mm-hook-census: the hook log's calls per cell against expected.json on a `leg` host. */
export function censusProblems(
  lines: readonly MmLine[],
  expected: G8mmExpected,
  leg: LegKind,
  teardownFrame: number,
): string[] {
  const problems: string[] = [];
  const map = mapCells(lines, expected);
  problems.push(...map.problems);
  const calls = lines.filter((l): l is MmCall => l.kind === "call");
  for (const [name, cell] of Object.entries(expected.cells)) {
    const rid = map.ridOfCell.get(name);
    if (rid === undefined) {
      problems.push(`${name}: no multimesh with ${cell.instances} instances in the hook log`);
      continue;
    }
    const mine = calls.filter((l) => l.rid === rid && !isTeardown(l, teardownFrame));
    const want = cellCalls(cell, leg);
    // allocations, in order
    const allocs = mine
      .filter((l) => l.call === "allocate_data" && l.accepted)
      .map((l) => [l.instances, l.format, l.colors, l.custom]);
    if (JSON.stringify(allocs) !== JSON.stringify(cell.allocations))
      problems.push(
        `${name}: allocations ${JSON.stringify(allocs)}, expected ${JSON.stringify(cell.allocations)}`,
      );
    // exact counts (accepted and rejected alike: a call is a call)
    const counts = new Map<string, number>();
    for (const l of mine) counts.set(l.call, (counts.get(l.call) ?? 0) + 1);
    const names = new Set([...counts.keys(), ...Object.keys(want.calls)]);
    for (const c of names) {
      const got = counts.get(c) ?? 0;
      const fixed = want.calls[c] ?? 0;
      if (want.per_frame.includes(c)) {
        const frames = [...new Set(mine.filter((l) => l.call === c).map((l) => l.frame))].sort(
          (a, b) => a - b,
        );
        if (frames.length === 0) {
          problems.push(`${name}: no ${c} at all (expected one every frame)`);
          continue;
        }
        const span = frames[frames.length - 1] - frames[0] + 1;
        if (frames.length !== span)
          problems.push(
            `${name}: ${c} missing on ${span - frames.length} of frames ${frames[0]}..${frames[frames.length - 1]}`,
          );
        if (span < expected.min_per_frame_frames)
          problems.push(
            `${name}: ${c} on ${span} frames, expected at least ${expected.min_per_frame_frames}`,
          );
        if (got < span || got > span + fixed)
          problems.push(
            `${name}: ${got} ${c} over ${span} frames (one a frame plus at most ${fixed})`,
          );
      } else if (got !== fixed) {
        problems.push(`${name}: ${got} ${c}, expected ${fixed}`);
      }
    }
    const visible = mine
      .filter((l) => l.call === "set_visible_instances")
      .map((l) => l.visible);
    if (JSON.stringify(visible) !== JSON.stringify(cell.visible))
      problems.push(
        `${name}: set_visible_instances ${JSON.stringify(visible)}, expected ${JSON.stringify(cell.visible)}`,
      );
    const rejected = mine.filter((l) => !l.accepted).length;
    if (rejected !== cell.rejected)
      problems.push(`${name}: ${rejected} rejected call(s), expected ${cell.rejected}`);
  }
  return problems;
}

// --------------------------------------------------------------------------- recording trace

/** One transaction as mm-wire, mm-frame-pairing and mm-bytes see it. */
export interface MmTx {
  seq: number;
  frame: number;
  full: boolean;
  /** mm_f32's float count (block 8; 0 when absent). */
  mm_floats: number;
  /** whether the decoded meta carries `multimeshes` / `removed_multimeshes` */
  has_keys: boolean;
  /** the resolved multimesh table after this transaction */
  table: Map<number, ResolvedMultimesh>;
  /** the buffer floats the receiver holds per ok multimesh (null when unknown) */
  floats: Map<number, number[] | null>;
}
export interface MmTrace {
  txs: MmTx[];
  /** add_multimesh commands, and unsupported canvas_item_add_multimesh commands by reason,
   * over every transaction that carries the item's commands */
  add_multimesh: number;
  unsupported_add_multimesh: Record<string, number>;
  errors: string[];
}

export interface MmTxInput {
  meta: TransactionMeta;
  blocks: DecodedBlock[];
  /** the raw mesh_u8 and mm_f32 blocks, when decoded from bytes */
  meshU8?: Uint8Array;
  mmBytes?: Uint8Array;
}

/** The trace over decoded transactions, resolved through render-stream-2.ts's applyTransaction. */
export function traceFromTransactions(inputs: readonly MmTxInput[]): MmTrace {
  const out: MmTrace = { txs: [], add_multimesh: 0, unsupported_add_multimesh: {}, errors: [] };
  let state: ResolvedState = emptyResolvedState();
  let floats = new Map<number, number[] | null>();
  for (const { meta, blocks, meshU8, mmBytes } of inputs) {
    const full = meta.encoding === "full";
    state = applyTransaction(state, meta, blocks as number[][], meshU8, mmBytes);
    floats = full ? new Map() : new Map(floats);
    for (const id of meta.removed_multimeshes ?? []) floats.delete(id);
    for (const t of transactionMultimeshes(meta, blocks)) {
      if (t.entry.status !== "ok") floats.set(t.entry.id, null);
      else if (t.buffer !== null) floats.set(t.entry.id, t.buffer);
      else if (!floats.has(t.entry.id)) floats.set(t.entry.id, null);
    }
    for (const item of meta.items ?? []) {
      for (const c of item.commands ?? []) {
        const op = (c as { op: string }).op;
        if (op === "add_multimesh") out.add_multimesh += 1;
        else if (op === "unsupported") {
          const u = c as { name: string; reason: string };
          if (u.name === "canvas_item_add_multimesh")
            out.unsupported_add_multimesh[u.reason] =
              (out.unsupported_add_multimesh[u.reason] ?? 0) + 1;
        }
      }
    }
    const mm = blocks[8];
    out.txs.push({
      seq: meta.seq,
      frame: meta.frame,
      full,
      mm_floats: Array.isArray(mm) ? mm.length : 0,
      has_keys: "multimeshes" in meta || "removed_multimeshes" in meta,
      table: new Map(state.multimeshes),
      floats,
    });
  }
  return out;
}

/** The trace of a recording's bytes at `version` (10 or 11). */
export function traceMultimeshRecording(data: Uint8Array, version: 10 | 11 = 11): MmTrace {
  return withRecordMemo(data, () => {
    const split = splitRecords(data, version);
    const inputs: MmTxInput[] = [];
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
      inputs.push({
        meta,
        blocks: rec.blocks,
        meshU8: version === 11 ? rawRecordBlock(raw, 7) : undefined,
        mmBytes: version === 11 ? rawRecordBlock(raw, 8) : undefined,
      });
    }
    const t = traceFromTransactions(inputs);
    t.errors.push(...errors);
    return t;
  });
}

// ------------------------------------------------------------------------------------ mm-wire

function statesById(lines: readonly MmLine[]): Map<number, MmState[]> {
  const out = new Map<number, MmState[]>();
  for (const l of lines) {
    if (l.kind !== "state" || l.id === null) continue;
    const list = out.get(l.id) ?? [];
    list.push(l);
    out.set(l.id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.frame - b.frame);
  return out;
}

function newestAtOrBefore(list: readonly MmState[] | undefined, frame: number): MmState | null {
  let best: MmState | null = null;
  for (const s of list ?? []) if (s.frame <= frame) best = s;
  return best;
}

/** mm-wire's table half: every resolved entry against the newest hook-log state line at or
 * before the transaction's frame. */
export function mmWireProblems(trace: MmTrace, lines: readonly MmLine[]): string[] {
  const problems: string[] = [];
  const states = statesById(lines);
  let checked = 0;
  for (const t of trace.txs) {
    for (const r of t.table.values()) {
      const s = newestAtOrBefore(states.get(r.id), t.frame);
      checked += 1;
      if (!s) {
        problems.push(`seq ${t.seq} (frame ${t.frame}): multimesh ${r.id} has no state line at or before it`);
      } else {
        const diffs: string[] = [];
        const fields: [string, unknown, unknown][] =
          r.status === "freed"
            ? [
                ["status", r.status, s.status],
                ["version", r.version, s.version],
              ]
            : [
                ["status", r.status, s.status],
                ["reason", r.reason, s.reason],
                ["version", r.version, s.version],
                ["instances", r.instances, s.instances],
                ["format", r.format, s.format],
                ["colors", r.colors, s.colors],
                ["custom", r.custom, s.custom],
                ["visible", r.visible, s.visible],
              ];
        for (const [k, a, b] of fields) if (a !== b) diffs.push(`${k} ${String(a)} vs ${String(b)}`);
        if (r.status === "ok" && r.buffer_sha256 !== s.buffer_sha256)
          diffs.push(
            `buffer_sha256 ${String(r.buffer_sha256).slice(0, 12)} vs ${String(s.buffer_sha256).slice(0, 12)} (state of frame ${s.frame})`,
          );
        if (diffs.length > 0)
          problems.push(`seq ${t.seq} (frame ${t.frame}): multimesh ${r.id}: ${diffs.join(", ")}`);
      }
      if (problems.length > 12) return problems;
    }
  }
  if (checked === 0) problems.push("no multimesh entry to check");
  return problems;
}

/** mm-wire's naming half: drawn cells are in the table from their first state line, H_FREE
 * becomes a freed tombstone after its free and then leaves, the hidden emitter never appears. */
export function mmNamedProblems(
  trace: MmTrace,
  lines: readonly MmLine[],
  expected: G8mmExpected,
): string[] {
  const problems: string[] = [];
  const map = mapCells(lines, expected);
  const last = trace.txs[trace.txs.length - 1];
  if (!last) return ["no transaction"];
  for (const [name, cell] of Object.entries(expected.cells)) {
    const rid = map.ridOfCell.get(name);
    const id = map.idOfCell.get(name);
    if (!cell.drawn) {
      if (id !== undefined && trace.txs.some((t) => t.table.has(id)))
        problems.push(`${name} (multimesh ${id}) is in a table, but it never draws`);
      continue;
    }
    if (rid === undefined || id === undefined) {
      problems.push(`${name}: no wire id in the hook log`);
      continue;
    }
    const firstState = lines.find((l) => l.kind === "state" && l.rid === rid)?.frame;
    if (firstState === undefined) {
      problems.push(`${name}: no state line`);
      continue;
    }
    const freeLine =
      cell.freed_at_step !== undefined
        ? lines.find((l) => l.kind === "call" && l.rid === rid && l.call === "free")
        : undefined;
    if (cell.freed_at_step !== undefined && !freeLine) {
      problems.push(`${name}: no free call in the hook log`);
      continue;
    }
    const freeFrame = freeLine?.frame ?? Number.POSITIVE_INFINITY;
    const missing = trace.txs.filter(
      (t) => t.frame >= firstState && t.frame < freeFrame && t.table.get(id)?.status !== "ok",
    );
    if (missing.length > 0)
      problems.push(
        `${name} (multimesh ${id}) is not an ok entry at ${missing.length} transaction(s) from frame ${firstState} (first: seq ${missing[0].seq})`,
      );
    if (freeLine) {
      if (!trace.txs.some((t) => t.frame >= freeFrame && t.table.get(id)?.status === "freed"))
        problems.push(`${name}: no freed tombstone after its free at frame ${freeFrame}`);
      if (last.table.has(id)) problems.push(`${name}: still in the last transaction's table`);
    }
  }
  return problems;
}

// --------------------------------------------------------------------------- mm-frame-pairing

export interface PairingResult {
  problems: string[];
  /** per cell: the wire constant, the hook constant, and how many transactions were paired */
  cells: Record<string, { wire: number | null; hook: number | null; paired: number }>;
}

function constantOf(values: readonly number[], what: string, problems: string[]): number | null {
  if (values.length === 0) return null;
  const distinct = [...new Set(values)];
  if (distinct.length > 1)
    problems.push(`${what}: ${distinct.length} different offsets (${distinct.slice(0, 4).join(", ")}...)`);
  return values[0];
}

/** mm-frame-pairing for every cell with `pairing` that the fixture log has lines for. */
export function framePairingProblems(
  trace: MmTrace,
  lines: readonly MmLine[],
  expected: G8mmExpected,
  fixtureLog: readonly FixtureMmLine[],
): PairingResult {
  const out: PairingResult = { problems: [], cells: {} };
  const map = mapCells(lines, expected);
  let any = false;
  for (const [name, cell] of Object.entries(expected.cells)) {
    const p = cell.pairing;
    if (!p) continue;
    const logged = fixtureLog.filter((l) => l.cell === name);
    if (logged.length === 0) continue; // never frame-carrying on this host (I_PREDRAW headless)
    any = true;
    const rid = map.ridOfCell.get(name);
    const id = map.idOfCell.get(name);
    if (rid === undefined || id === undefined) {
      out.problems.push(`${name}: no multimesh in the hook log`);
      continue;
    }
    // the wire: custom.x minus the transaction frame
    const stride = multimeshStride(cell);
    const wire: number[] = [];
    for (const t of trace.txs) {
      const f = t.floats.get(id);
      if (!f) continue;
      const v = f[p.instance * stride + p.float];
      if (v === undefined || v === p.sentinel) continue;
      wire.push(v - t.frame);
    }
    // the hook log: the value the call gave minus the call's frame
    const calls = lines.filter(
      (l): l is MmCall => l.kind === "call" && l.rid === rid && l.call === p.source && l.accepted,
    );
    const hook: number[] = [];
    if (p.source === "set_buffer") {
      const bySha = new Map(logged.map((l) => [l.sha256, l.value]));
      for (const c of calls) {
        const v = c.sha256 === null ? undefined : bySha.get(c.sha256);
        if (v !== undefined) hook.push(v - c.frame);
      }
    } else {
      if (calls.length !== logged.length)
        out.problems.push(
          `${name}: ${calls.length} ${p.source} calls in the hook log, ${logged.length} in the fixture log`,
        );
      for (let i = 0; i < Math.min(calls.length, logged.length); i++)
        hook.push(logged[i].value - calls[i].frame);
    }
    const w = constantOf(wire, `${name} wire`, out.problems);
    const h = constantOf(hook, `${name} hook log`, out.problems);
    out.cells[name] = { wire: w, hook: h, paired: wire.length };
    if (wire.length < expected.min_paired_transactions)
      out.problems.push(
        `${name}: ${wire.length} paired transaction(s), expected at least ${expected.min_paired_transactions}`,
      );
    if (h === null) out.problems.push(`${name}: no frame-carrying call in the hook log`);
    if (w !== null && h !== null && w !== h)
      out.problems.push(
        `${name}: the wire pairs value - frame = ${w}, the hook log ${h} (a ${h - w > 0 ? "lag" : "lead"} of ${Math.abs(h - w)} frame(s))`,
      );
  }
  if (!any) out.problems.push("no frame-carrying cell in the fixture log");
  return out;
}

// --------------------------------------------------------------------------------- mm-v10, bytes

/** mm-v10: the /10 control's trace and hook log. */
export function v10Problems(trace: MmTrace, lines: readonly MmLine[]): string[] {
  const problems: string[] = [];
  const keyed = trace.txs.filter((t) => t.has_keys);
  if (keyed.length > 0)
    problems.push(`${keyed.length} transaction(s) carry multimeshes/removed_multimeshes (first seq ${keyed[0].seq})`);
  if (trace.add_multimesh > 0) problems.push(`${trace.add_multimesh} add_multimesh command(s)`);
  const reasons = Object.entries(trace.unsupported_add_multimesh);
  if (reasons.length === 0) problems.push("no unsupported canvas_item_add_multimesh command (proves nothing)");
  for (const [reason, n] of reasons)
    if (reason !== "unsupported-op") problems.push(`${n} canvas_item_add_multimesh command(s) typed ${reason}`);
  if (lines.length > 0) problems.push(`${lines.length} multimesh hook line(s): /10 plans no multimesh hook`);
  return problems;
}

export interface MmBytes {
  transactions: number;
  frames: number;
  total_bytes: number;
  mean_bytes_per_transaction: number;
  max_bytes_per_transaction: number;
  bytes_per_frame: number;
  /** patches only (the full sink's are all full) */
  mean_bytes_per_patch: number | null;
}

/** mm_f32's measured bytes (4 a float) over a trace. */
export function mmBytes(trace: MmTrace): MmBytes {
  const b = trace.txs.map((t) => t.mm_floats * 4);
  const total = b.reduce((x, y) => x + y, 0);
  const frames =
    trace.txs.length > 0 ? trace.txs[trace.txs.length - 1].frame - trace.txs[0].frame + 1 : 0;
  const patches = trace.txs.filter((t) => !t.full).map((t) => t.mm_floats * 4);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    transactions: b.length,
    frames,
    total_bytes: total,
    mean_bytes_per_transaction: b.length ? round(total / b.length) : 0,
    max_bytes_per_transaction: b.length ? Math.max(...b) : 0,
    bytes_per_frame: frames ? round(total / frames) : 0,
    mean_bytes_per_patch: patches.length
      ? round(patches.reduce((x, y) => x + y, 0) / patches.length)
      : null,
  };
}

// --------------------------------------------------------------------------------- the runner

export const MM_SABOTAGES = ["perturb-instance", "stale-buffer"] as const;
const SINKS_11 = ["recording.rs11", "recording-patch.rs11"];
const SINKS_10 = ["recording.rs10", "recording-patch.rs10"];
const HONEST: [string, LegKind][] = [
  ["capture", "rendered"],
  ["headless/capture", "headless"],
];
const LEGS = [
  "import/fixture",
  "capture",
  "capture-v10",
  ...MM_SABOTAGES.map((s) => `sabotage-${s}/capture`),
  "headless/capture",
];

function rsCoreValidate(path: string, version: 10 | 11): string {
  if (!existsSync(RS_CORE_CHECK)) return `missing ${RS_CORE_CHECK} (build-rs-core.sh)`;
  const r = spawnSync(RS_CORE_CHECK, ["validate", path, "--version", String(version)], {
    encoding: "utf8",
  });
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

async function validateBoth(path: string, version: 10 | 11): Promise<[string, string] | null> {
  const data = await bytesOf(path);
  if (!data) return null;
  const ts = validateRecording(data, version);
  return [ts.length === 0 ? "ok" : ts[0].slice(0, 240), rsCoreValidate(path, version)];
}

function notRun(id: string, criterion: string, leg: string, why: string): G8aCheck {
  return { id, criterion, passed: true, status: "not-run", detail: `${why}: ${leg}`, gating: false };
}

export interface G8mmReport {
  legs: Record<string, unknown>;
}

export async function runG8mm(
  out: string,
  expected: G8mmExpected,
): Promise<{ checks: G8aCheck[]; report: G8mmReport }> {
  const g = join(out, "g8mm");
  const checks: G8aCheck[] = [];
  const report: G8mmReport = { legs: {} };
  const dir = (leg: string) => join(g, leg);
  const legSkipped = (leg: string) => skipped(dir(leg));
  const hookLog = async (leg: string) =>
    parseMmLog(await readText(join(dir(leg), "evidence", "resources.jsonl")));

  // g8mm-legs
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
    checks.push(check("g8mm-legs", "PM1: every g8mm leg that ran exited 0", any ? problems : null));
  }

  // mm-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const [leg, version, sinks] of [
      ["capture", 11, SINKS_11],
      ["headless/capture", 11, SINKS_11],
      ["capture-v10", 10, SINKS_10],
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
        "mm-validate",
        "PM1: every honest g8mm recording (/11 rendered and headless, the /10 control; both sinks) passes the TypeScript validator and rs-core-check",
        any ? problems : null,
      ),
    );
  }

  // the honest legs: census, wire, pairing, bytes
  const census: string[] = [];
  const wire: string[] = [];
  const pairing: string[] = [];
  const bytesDetail: string[] = [];
  let anyHonest = false;
  for (const [leg, kind] of HONEST) {
    if (legSkipped(leg)) continue;
    const lines = await hookLog(leg);
    const fixtureLog = jsonlOf<FixtureMmLine>(await readText(join(dir(leg), "mm-frames.jsonl")));
    const traces = new Map<string, MmTrace>();
    for (const sink of SINKS_11) {
      const data = await bytesOf(join(dir(leg), sink));
      if (!data) {
        wire.push(`${leg}/${sink}: missing`);
        continue;
      }
      anyHonest = true;
      traces.set(sink, traceMultimeshRecording(data, 11));
    }
    const fullTrace = traces.get(SINKS_11[0]) ?? traces.get(SINKS_11[1]);
    const teardown = fullTrace?.txs.at(-1)?.frame ?? Number.POSITIVE_INFINITY;
    for (const p of censusProblems(lines, expected, kind, teardown)) census.push(`${leg}: ${p}`);
    const legReport: Record<string, unknown> = {
      hook_lines: lines.length,
      state_lines: lines.filter((l) => l.kind === "state").length,
      set_buffer_lines: lines.filter((l) => l.kind === "call" && l.call === "set_buffer").length,
    };
    for (const [sink, trace] of traces) {
      for (const e of trace.errors.slice(0, 3)) wire.push(`${leg}/${sink}: decode ${e}`);
      for (const p of mmWireProblems(trace, lines)) wire.push(`${leg}/${sink}: ${p}`);
      for (const p of mmNamedProblems(trace, lines, expected)) wire.push(`${leg}/${sink}: ${p}`);
      const pr = framePairingProblems(trace, lines, expected, fixtureLog);
      for (const p of pr.problems) pairing.push(`${leg}/${sink}: ${p}`);
      const b = mmBytes(trace);
      legReport[sink] = { mm_f32: b, pairing: pr.cells };
      bytesDetail.push(
        `${leg}/${sink}: ${b.mean_bytes_per_transaction} B/tx mean, ${b.max_bytes_per_transaction} max, ${b.bytes_per_frame} B/frame`,
      );
    }
    report.legs[leg] = legReport;
  }
  checks.push(
    check(
      "mm-hook-census",
      "PM1: the hook log's multimesh calls per cell equal expected.json (creates, allocations, set_buffer every frame for the active cells on the rendered host and none from CPUParticles2D or frame_pre_draw headless, setters, visible counts, frees, rejected calls)",
      anyHonest ? census : null,
    ),
  );
  checks.push(
    check(
      "mm-wire",
      "PM1: at every transaction every resolved multimesh's buffer_sha256 and fields equal the newest hook-log state line at or before its frame; every drawn cell is in the table, the hidden emitter never",
      anyHonest ? wire : null,
    ),
  );
  checks.push(
    check(
      "mm-frame-pairing",
      "PM1: B_CUSTOM's and I_PREDRAW's custom.x minus the transaction frame is one constant per leg, equal to the hook log's value minus call frame",
      anyHonest ? pairing : null,
    ),
  );
  checks.push({
    id: "mm-bytes",
    criterion: "PM1 (informational): mm_f32 bytes per transaction (mean, max) and per frame, per honest /11 leg and sink",
    passed: true,
    status: anyHonest ? "pass" : "not-run",
    detail: bytesDetail.join("; ") || "no honest recording",
    gating: false,
  });

  // mm-v10
  {
    const leg = "capture-v10";
    if (legSkipped(leg)) {
      checks.push(notRun("mm-v10", "PM1: the /10 control carries no multimesh", leg, "skipped"));
    } else {
      const data = await bytesOf(join(dir(leg), SINKS_10[0]));
      const problems = data ? v10Problems(traceMultimeshRecording(data, 10), await hookLog(leg)) : null;
      checks.push(
        check(
          "mm-v10",
          "PM1: the /10 control has no multimeshes key, every multimesh draw is unsupported/unsupported-op, and no multimesh hook line",
          problems,
        ),
      );
    }
  }

  // the sabotages: the validators accept them, mm-wire fails on them
  for (const s of MM_SABOTAGES) {
    const leg = `sabotage-${s}/capture`;
    const vid = `mm-sabotage-validate-${s}`;
    const cid = `mm-wire-catches-${s}`;
    const why = legSkipped(leg);
    if (why) {
      checks.push(notRun(vid, `PM1: both validators accept ${leg}`, leg, why));
      checks.push(notRun(cid, `PM1: mm-wire fails on ${leg}`, leg, why));
      continue;
    }
    // Judged on the patch sink, mm-wire's. On the full sink perturb-instance re-perturbs an
    // entry whose version does not move, which multimesh-version can see (every full transaction
    // carries the buffer): that verdict is recorded, not judged.
    const v = await validateBoth(join(dir(leg), SINKS_11[1]), 11);
    const vf = await validateBoth(join(dir(leg), SINKS_11[0]), 11);
    const vp: string[] = [];
    if (v && v[0] !== "ok") vp.push(`${SINKS_11[1]}: TS ${v[0]}`);
    if (v && v[1] !== "ok") vp.push(`${SINKS_11[1]}: rs-core ${v[1]}`);
    const fullNote = vf
      ? `full sink: TS ${vf[0] === "ok" ? "ok" : vf[0].split(":")[0]}, rs-core ${vf[1] === "ok" ? "ok" : vf[1].split(":")[0]}`
      : "full sink missing";
    const vc = check(
      vid,
      `PM1: both validators accept the ${s} patch recording (the buffer serial and the host's floats are not on the wire)`,
      v ? vp : null,
      fullNote,
    );
    if (!vc.passed && v) vc.detail = `${vc.detail ?? ""}; ${fullNote}`;
    checks.push(vc);
    const data = await bytesOf(join(dir(leg), SINKS_11[1]));
    if (!data) {
      checks.push(check(cid, `PM1: mm-wire fails on ${leg}`, null));
      continue;
    }
    const caught = mmWireProblems(traceMultimeshRecording(data, 11), await hookLog(leg));
    checks.push(
      check(
        cid,
        `PM1: mm-wire fails on the ${s} patch recording`,
        caught.length > 0 ? [] : ["mm-wire passed: the sabotage went unseen"],
        caught[0],
      ),
    );
  }
  return { checks, report };
}

function jsonlOf<T>(text: string | undefined): T[] {
  const out: T[] = [];
  for (const l of (text ?? "").split("\n")) {
    if (l.trim() === "") continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      // a torn last line of a killed fixture
    }
  }
  return out;
}
