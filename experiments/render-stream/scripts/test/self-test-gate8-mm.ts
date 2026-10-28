#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8mm checks (lib/gate8-mm-checks.ts, PM1) on synthetic hook logs, fixture
// logs and recordings resolved through render-stream-2.ts (applyTransaction), against the real
// fixtures/gate8-mm/expected.json.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-mm.ts
//
// A small simulator plays mm.gd's nine cells through a capture that follows render-stream-11.md
// "As built (PM1)" rules 2-4, 9 and 12: per-call hook lines, one state line per multimesh per frame
// its version moved, and both sinks (every transaction full; seq 1 full then patches).
//
// 1. parseMmLine: the rule-12 spellings and the RS enum spellings normalize alike; other kinds
//    are not multimesh lines.
// 2. honest rendered and headless legs: mm-hook-census, mm-wire (both halves) and
//    mm-frame-pairing pass on both sinks; mm_f32 bytes are measured.
// 3. census failures: a missing CPUParticles2D frame, a CPUParticles2D set_buffer headless, an
//    unknown rid, a missing rejected call each fail.
// 4. mm-wire: one float perturbed (perturb-instance) fails; buffer_f null over changed floats
//    (stale-buffer) fails on the patch sink; a hidden emitter in the table fails; a missing
//    tombstone fails.
// 5. mm-frame-pairing: a one-frame lag (the pre-draw buffer published a frame late, the hook log's
//    state lines lagging with it, so mm-wire still passes) fails.
// 6. v10Problems: an honest /10 trace passes; a multimeshes key, a non-op reason or a multimesh
//    hook line fails.
// 7. traceMultimeshRecording on golden-11's full and patch recordings: every transaction's resolved
//    multimesh table (id, version, buffer_sha256) equals resolved.json's, and the held floats hash
//    to the resolved digest.
// 8. PM2's pixel helpers on synthetic 640x360 shots painted per expected.json's cell grid: the
//    reference's ink passes mm-premise and a hidden cell drawn or a drawn cell blank fails it; a shot
//    without multimesh fails mm-reference in exactly the drawn cells (mmMissingProblems passes); one
//    pixel off fails mmExactProblems and is attributed to its cell; a shot of another size is null.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  censusProblems,
  type FixtureMmLine,
  framePairingProblems,
  type G8mmExpected,
  type MmLine,
  type MmTrace,
  mmBytes,
  mmNamedProblems,
  mmWireProblems,
  parseMmLine,
  parseMmLog,
  traceFromTransactions,
  traceMultimeshRecording,
  v10Problems,
  mmCellDiff,
  mmExactProblems,
  mmInk,
  mmMissingProblems,
  mmPremiseInkProblems,
  type Rgba,
} from "../lib/gate8-mm-checks";
import {
  multimeshBufferSha256,
  multimeshStride,
  type TransactionMeta,
  type TransactionMultimesh,
} from "../lib/render-stream-2";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, "..", "..", "fixtures", "gate8-mm", "expected.json");
const GOLDEN_11 = resolve(HERE, "..", "..", "protocol", "golden-11");

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string, detail?: unknown): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail === undefined ? "" : ` -- ${JSON.stringify(detail).slice(0, 600)}`}`);
  }
}

// ------------------------------------------------------------------------------ the simulator

type Sabotage = "none" | "perturb" | "stale" | "lag";
interface SimOptions {
  leg: "rendered" | "headless";
  sabotage?: Sabotage;
  /** drop C_FLIP's set_buffer at this frame */
  dropFrame?: number;
  /** H_FREE's rejected call not marked */
  acceptAll?: boolean;
  /** an extra multimesh nobody expects */
  strayRid?: boolean;
  /** put G_HIDDEN in the table */
  drawHidden?: boolean;
  /** forget H_FREE's tombstone */
  noTombstone?: boolean;
}
interface Sim {
  lines: MmLine[];
  fixture: FixtureMmLine[];
  full: MmTrace;
  patch: MmTrace;
}

interface CellState {
  name: string;
  rid: string;
  id: number;
  instances: number;
  colors: boolean;
  custom: boolean;
  stride: number;
  version: number;
  visible: number;
  buffer: number[];
  aabb: number[];
  freed: boolean;
  moved: boolean;
  serial: number;
}

const F = Math.fround;
const QUIT = 90;
const SAB_FRAME = 30;

function simulate(expected: G8mmExpected, o: SimOptions): Sim {
  const sab = o.sabotage ?? "none";
  const raw: Record<string, unknown>[] = [];
  const fixture: FixtureMmLine[] = [];
  const cells = new Map<string, CellState>();
  let nextId = 1;
  let frame = 1;
  const call = (c: CellState, name: string, extra: Record<string, unknown> = {}, accepted = true) =>
    raw.push({ kind: "multimesh", call: name, frame, rid: c.rid, id: c.id, accepted, ...extra });
  const bump = (c: CellState) => {
    c.version += 1;
    c.moved = true;
  };
  const setBuffer = (c: CellState, floats: number[], callFrame = frame) => {
    const f = floats.map(F);
    raw.push({
      kind: "multimesh",
      call: "multimesh_set_buffer",
      frame: callFrame,
      rid: c.rid,
      id: c.id,
      accepted: true,
      floats: f.length,
      sha256: multimeshBufferSha256(f),
    });
    if (f.some((v, i) => v !== c.buffer[i])) {
      c.buffer = f;
      c.serial += 1;
      bump(c);
    }
  };
  const make = (name: string): CellState => {
    const e = expected.cells[name];
    const c: CellState = {
      name,
      rid: `rid-${name}`,
      id: nextId++,
      instances: 0,
      colors: e.colors,
      custom: e.custom,
      stride: multimeshStride(e),
      version: 1,
      visible: -1,
      buffer: [],
      aabb: [0, 0, 0, 0, 0, 0],
      freed: false,
      moved: true,
      serial: 0,
    };
    cells.set(name, c);
    call(c, "multimesh_create");
    for (const [n, fmt, colors, custom] of e.allocations) {
      call(c, "multimesh_allocate_data", { instances: n, format: fmt === "2d" ? 0 : 1, use_colors: colors, use_custom_data: custom });
      c.instances = n;
      c.buffer = new Array(n * c.stride).fill(0);
      bump(c);
    }
    call(c, "multimesh_set_mesh", { mesh: 1 });
    bump(c);
    return c;
  };
  const xbuf = (c: CellState, seed: number, customX?: number) => {
    const out: number[] = [];
    for (let k = 0; k < c.instances; k++) {
      out.push(1, 0, 0, 10 * k + seed, 0, 1, 0, 5 + seed / 7);
      if (c.colors) out.push(0.5, 0.25, 0.125, 1);
      if (c.custom) out.push(k === 0 && customX !== undefined ? customX : k, 0.25, 0, 0);
    }
    return out;
  };
  // _ready (frame 1, before the first publish)
  const A = make("A_XFORM");
  for (let k = 0; k < 5; k++) {
    call(A, "multimesh_instance_set_transform_2d", { index: k });
    A.buffer[k * 8 + 3] = F(32 * k);
  }
  bump(A);
  const B = make("B_CUSTOM");
  setBuffer(B, xbuf(B, 1, -1));
  const C = make("C_FLIP");
  const D = make("D_GLOBAL");
  // CPUParticles2D's _set_do_redraw(true): visible -1, already the value (no version move)
  for (const c of [C, D]) call(c, "multimesh_set_visible_instances", { visible: -1 });
  const E = make("E_VISIBLE");
  setBuffer(E, xbuf(E, 2));
  call(E, "multimesh_set_visible_instances", { visible: 4 });
  E.visible = 4;
  bump(E);
  call(E, "multimesh_set_custom_aabb", { aabb: [-8, -8, 0, 196, 48, 0] });
  E.aabb = [-8, -8, 0, 196, 48, 0];
  bump(E);
  const Fc = make("F_REPLACE");
  setBuffer(Fc, xbuf(Fc, 3));
  const G = make("G_HIDDEN");
  const H = make("H_FREE");
  setBuffer(H, xbuf(H, 4));
  const I = make("I_PREDRAW");
  setBuffer(I, xbuf(I, 5, -1));
  if (o.strayRid) {
    raw.push({ kind: "multimesh", call: "multimesh_create", frame, rid: "rid-stray", id: 99, accepted: true });
  }
  // the lagged pre-draw buffer (sabotage "lag"): applied one frame late
  let pendingI: number[] | null = null;

  const tables: { frame: number; entries: CellState[]; snapshot: Map<string, CellState> }[] = [];
  for (frame = 1; frame <= QUIT; frame++) {
    if (pendingI) {
      setBuffer(I, pendingI, frame - 1);
      raw.pop(); // its call line was written last frame, at the call
      pendingI = null;
    }
    // _process: B's frame number
    call(B, "multimesh_instance_set_custom_data", { index: 0, custom: [frame, 0, 0, 0] });
    if (B.buffer[12] !== frame) {
      B.buffer[12] = frame;
      B.serial += 1;
      bump(B);
    }
    const bb = B.buffer.slice();
    fixture.push({ cell: "B_CUSTOM", frame, value: frame, sha256: multimeshBufferSha256(bb) });
    if (frame === 20) {
      call(A, "multimesh_instance_set_transform_2d", { index: 2 });
      A.buffer[2 * 8 + 7] = F(44);
      A.serial += 1;
      bump(A);
      setBuffer(Fc, xbuf(Fc, 30));
      call(H, "multimesh_set_buffer", { floats: 3, sha256: multimeshBufferSha256([1, 2, 3]) }, o.acceptAll === true);
    }
    if (frame === 40) {
      call(E, "multimesh_set_visible_instances", { visible: 6 });
      E.visible = 6;
      bump(E);
      setBuffer(Fc, xbuf(Fc, 30));
      call(H, "free");
      H.freed = true;
      bump(H);
    }
    // RenderingServer::draw: frame_pre_draw (rendered only)
    if (o.leg === "rendered") {
      if (frame !== o.dropFrame) setBuffer(C, xbuf(C, frame * 3));
      setBuffer(D, xbuf(D, 100 + frame));
      const ib = xbuf(I, 5, frame).map(F);
      fixture.push({ cell: "I_PREDRAW", frame, value: frame, sha256: multimeshBufferSha256(ib) });
      if (sab === "lag") {
        raw.push({ kind: "multimesh", call: "multimesh_set_buffer", frame, rid: I.rid, id: I.id, accepted: true, floats: ib.length, sha256: multimeshBufferSha256(ib) });
        pendingI = ib;
      } else setBuffer(I, ib);
    }
    // the publish: state lines, then the transaction's table
    for (const c of cells.values()) {
      if (!c.moved) continue;
      c.moved = false;
      raw.push({
        kind: "multimesh",
        call: "state",
        frame,
        rid: c.rid,
        id: c.id,
        version: c.version,
        instances: c.freed ? 0 : c.instances,
        format: "2d",
        colors: c.freed ? false : c.colors,
        custom: c.freed ? false : c.custom,
        visible: c.freed ? -1 : c.visible,
        status: c.freed ? "freed" : "ok",
        reason: null,
        buffer_sha256: c.freed ? null : multimeshBufferSha256(c.buffer),
      });
    }
    const named = [A, B, C, D, E, Fc, I];
    if (o.drawHidden) named.push(G);
    if (frame <= 40 && !(o.noTombstone && H.freed)) named.push(H);
    named.sort((a, b) => a.id - b.id);
    const snapshot = new Map<string, CellState>();
    for (const c of named) snapshot.set(c.name, { ...c, buffer: c.buffer.slice(), aabb: c.aabb.slice() });
    tables.push({ frame, entries: named, snapshot });
  }
  // teardown (frame 91: destructors after the quit)
  frame = QUIT + 1;
  for (const c of [C, D]) call(c, "multimesh_set_visible_instances", { visible: 0 });
  for (const c of cells.values()) if (!c.freed) call(c, "free");

  const lines = raw.map((r) => parseMmLine(r)).filter((l): l is MmLine => l !== null);
  return {
    lines,
    fixture,
    full: traceFromTransactions(encode(tables, "full", sab)),
    patch: traceFromTransactions(encode(tables, "patch", sab)),
  };
}

/** Both sinks' decoded transactions over the simulated tables (rules 2-4, 9). */
function encode(
  tables: { frame: number; snapshot: Map<string, CellState> }[],
  sink: "full" | "patch",
  sab: Sabotage,
): { meta: TransactionMeta; blocks: number[][] }[] {
  const out: { meta: TransactionMeta; blocks: number[][] }[] = [];
  let base = new Map<number, CellState>();
  let staleId: number | null = null;
  tables.forEach((t, i) => {
    const full = sink === "full" || i === 0;
    const entries: TransactionMultimesh[] = [];
    const mm: number[] = [];
    let perturbed = false;
    const ids = new Set<number>();
    for (const c of t.snapshot.values()) {
      ids.add(c.id);
      const b = base.get(c.id);
      if (!full && b && b.version === c.version) continue;
      const aabb_f = c.freed ? null : mm.length;
      if (!c.freed) mm.push(...c.aabb);
      let carry = !c.freed && (full || !b || b.freed || b.serial !== c.serial);
      if (sab === "stale" && !full && carry && t.frame >= SAB_FRAME && b && !b.freed) {
        staleId ??= c.id;
        if (staleId === c.id) carry = false;
      }
      const buffer_f = carry ? mm.length : null;
      if (carry) {
        const floats = c.buffer.slice();
        if (sab === "perturb" && t.frame >= SAB_FRAME && !perturbed) {
          floats[0] += 1;
          perturbed = true;
        }
        mm.push(...floats);
      }
      entries.push({
        id: c.id,
        origin: "created",
        status: c.freed ? "freed" : "ok",
        reason: null,
        version: c.version,
        mesh: c.freed ? null : 1,
        format: "2d",
        colors: c.freed ? false : c.colors,
        custom: c.freed ? false : c.custom,
        instances: c.freed ? 0 : c.instances,
        visible: c.freed ? -1 : c.visible,
        aabb_f,
        buffer_f,
      });
    }
    const removed = full ? [] : [...base.keys()].filter((id) => !ids.has(id)).sort((a, b) => a - b);
    const meta = {
      type: "transaction",
      seq: i + 1,
      frame: t.frame,
      encoding: full ? "full" : "patch",
      base_seq: full ? null : i,
      status: "ok",
      failures: [],
      unsupported: [],
      default_texture_filter: "nearest",
      default_texture_repeat: "disabled",
      removed_canvases: [],
      removed_items: [],
      removed_textures: [],
      canvases: [],
      items: [],
      textures: [],
      ...(entries.length > 0 ? { multimeshes: entries } : {}),
      ...(removed.length > 0 ? { removed_multimeshes: removed } : {}),
    } as unknown as TransactionMeta;
    out.push({ meta, blocks: [[], [], [], [], [], [], [], [], mm] });
    base = new Map([...t.snapshot.values()].map((c) => [c.id, c]));
  });
  return out;
}

// ------------------------------------------------------------------------------------- tests

async function main(): Promise<void> {
  const expected = JSON.parse(await readFile(EXPECTED_PATH, "utf8")) as G8mmExpected;
  const TEARDOWN = QUIT;

  // 1. parseMmLine
  {
    const a = parseMmLine({ kind: "multimesh", call: "multimesh_allocate_data", frame: 3, rid: 7, id: 2, accepted: true, instances: 5, format: 0, use_colors: true, use_custom_data: false });
    const b = parseMmLine({ kind: "multimesh", op: "allocate_data", frame: 3, rid: "7", id: 2, count: 5, format: "2d", colors: true, custom: false });
    expect(JSON.stringify(a) === JSON.stringify(b), "parseMmLine: rule-12 and RS spellings normalize alike", [a, b]);
    expect(a?.kind === "call" && a.call === "allocate_data" && a.rid === "7", "parseMmLine: call name and rid", a);
    expect(parseMmLine({ kind: "mesh", op: "mesh_create", frame: 1 }) === null, "parseMmLine: a mesh line is not a multimesh line");
    const f = parseMmLine({ kind: "multimesh", call: "free_rid", frame: 1, rid: "1" });
    expect(f?.kind === "call" && f.call === "free" && f.accepted, "parseMmLine: free_rid is free, accepted by default");
    const s = parseMmLine({ kind: "multimesh", call: "state", frame: 4, rid: "1", id: 1, version: 3, instances: 2, format: "2d", colors: false, custom: false, visible: -1, status: "ok", reason: null, buffer_sha256: "ab" });
    expect(s?.kind === "state" && s.version === 3 && s.buffer_sha256 === "ab", "parseMmLine: a state line", s);
    const log = parseMmLog(
      [
        '{"frame":1,"kind":"multimesh","call":"multimesh_create","rid":"55","id":8,"accepted":true,"version":1}',
        '{"frame":40,"kind":"multimesh","call":"state","rid":null,"id":8,"version":5,"instances":0,"format":"2d","colors":false,"custom":false,"visible":-1,"mesh":null,"status":"freed","reason":null,"buffer_sha256":null}',
        '{"frame":2,"kind":"mesh","op":"mesh_create"}',
        "not json",
      ].join("\n"),
    );
    expect(log.length === 2 && log[1].rid === "55", "parseMmLog: a freed state line's null rid resolves through its wire id", log);
  }

  // 2. honest legs
  for (const leg of ["rendered", "headless"] as const) {
    const sim = simulate(expected, { leg });
    const census = censusProblems(sim.lines, expected, leg, TEARDOWN);
    expect(census.length === 0, `honest ${leg}: mm-hook-census passes`, census);
    for (const [sink, trace] of [["full", sim.full], ["patch", sim.patch]] as const) {
      const w = mmWireProblems(trace, sim.lines);
      expect(w.length === 0, `honest ${leg}/${sink}: mm-wire passes`, w);
      const n = mmNamedProblems(trace, sim.lines, expected);
      expect(n.length === 0, `honest ${leg}/${sink}: mm-wire naming passes`, n);
      const p = framePairingProblems(trace, sim.lines, expected, sim.fixture);
      expect(p.problems.length === 0, `honest ${leg}/${sink}: mm-frame-pairing passes`, p);
      expect(p.cells.B_CUSTOM?.wire === 0 && p.cells.B_CUSTOM?.hook === 0, `honest ${leg}/${sink}: B pairs at offset 0`, p.cells);
      expect((leg === "rendered") === (p.cells.I_PREDRAW !== undefined), `honest ${leg}/${sink}: I_PREDRAW paired only when rendered`, p.cells);
      const b = mmBytes(trace);
      expect(b.transactions === QUIT && b.frames === QUIT && b.max_bytes_per_transaction > 0, `honest ${leg}/${sink}: mm_f32 bytes measured`, b);
    }
    // patches carry fewer floats than full transactions
    expect(mmBytes(sim.patch).total_bytes < mmBytes(sim.full).total_bytes, `honest ${leg}: patches carry fewer mm_f32 bytes`);
  }
  {
    // headless: C/D/I set no buffer; the headless census must refuse a rendered log
    const rendered = simulate(expected, { leg: "rendered" });
    const p = censusProblems(rendered.lines, expected, "headless", TEARDOWN);
    expect(p.some((x) => x.startsWith("C_FLIP:") && x.includes("set_buffer")), "census: a CPUParticles2D set_buffer on the headless leg fails", p);
    const headless = simulate(expected, { leg: "headless" });
    const q = censusProblems(headless.lines, expected, "rendered", TEARDOWN);
    expect(q.some((x) => x.startsWith("C_FLIP:") && x.includes("no set_buffer")), "census: a rendered leg without CPUParticles2D buffers fails", q);
  }

  // 3. census failures
  {
    const drop = simulate(expected, { leg: "rendered", dropFrame: 50 });
    const p = censusProblems(drop.lines, expected, "rendered", TEARDOWN);
    expect(p.some((x) => x.startsWith("C_FLIP:") && x.includes("missing on 1")), "census: a missing C_FLIP frame fails", p);
    const stray = simulate(expected, { leg: "rendered", strayRid: true });
    const q = censusProblems(stray.lines, expected, "rendered", TEARDOWN);
    expect(q.some((x) => x.includes("rid-stray")), "census: an unknown rid fails", q);
    const acc = simulate(expected, { leg: "rendered", acceptAll: true });
    const r = censusProblems(acc.lines, expected, "rendered", TEARDOWN);
    expect(r.some((x) => x.startsWith("H_FREE:") && x.includes("rejected")), "census: H_FREE's rejected call missing fails", r);
  }

  // 4. mm-wire failures
  {
    const perturb = simulate(expected, { leg: "rendered", sabotage: "perturb" });
    for (const [sink, trace] of [["full", perturb.full], ["patch", perturb.patch]] as const) {
      const w = mmWireProblems(trace, perturb.lines);
      expect(w.some((x) => x.includes("buffer_sha256")), `perturb-instance/${sink}: one float perturbed fails mm-wire`, w);
    }
    const stale = simulate(expected, { leg: "rendered", sabotage: "stale" });
    const ws = mmWireProblems(stale.patch, stale.lines);
    expect(ws.some((x) => x.includes("buffer_sha256")), "stale-buffer/patch: buffer_f null over changed floats fails mm-wire", ws);
    expect(mmWireProblems(stale.full, stale.lines).length === 0, "stale-buffer/full: a full sink carries every buffer (passes)");
    const hidden = simulate(expected, { leg: "rendered", drawHidden: true });
    const nh = mmNamedProblems(hidden.full, hidden.lines, expected);
    expect(nh.some((x) => x.startsWith("G_HIDDEN")), "mm-wire: the hidden emitter in the table fails", nh);
    const tomb = simulate(expected, { leg: "rendered", noTombstone: true });
    const nt = mmNamedProblems(tomb.full, tomb.lines, expected);
    expect(nt.some((x) => x.includes("tombstone")), "mm-wire: no freed tombstone after H_FREE's free fails", nt);
  }

  // 5. a one-frame lag
  {
    const lag = simulate(expected, { leg: "rendered", sabotage: "lag" });
    expect(mmWireProblems(lag.full, lag.lines).length === 0, "lag: mm-wire alone passes (the state lines lag with the wire)");
    const p = framePairingProblems(lag.full, lag.lines, expected, lag.fixture);
    expect(p.problems.some((x) => x.startsWith("I_PREDRAW") && x.includes("lag of 1")), "lag: mm-frame-pairing fails on I_PREDRAW", p);
    expect(!p.problems.some((x) => x.startsWith("B_CUSTOM")), "lag: B_CUSTOM (set in _process) still pairs", p);
  }

  // 6. v10Problems
  {
    const tx = (extra: Record<string, unknown>, reason = "unsupported-op") =>
      ({
        type: "transaction",
        seq: 1,
        frame: 1,
        encoding: "full",
        base_seq: null,
        canvases: [],
        textures: [],
        removed_canvases: [],
        removed_items: [],
        removed_textures: [],
        items: [{ id: 1, commands: [{ op: "unsupported", name: "canvas_item_add_multimesh", reason }] }],
        ...extra,
      }) as unknown as TransactionMeta;
    const blocks = [[], [], [], [], [], [], [], [], []];
    const honest = traceFromTransactions([{ meta: tx({}), blocks }]);
    expect(v10Problems(honest, []).length === 0, "v10: an honest /10 trace passes", v10Problems(honest, []));
    const keyed = traceFromTransactions([{ meta: tx({ removed_multimeshes: [1] }), blocks }]);
    expect(v10Problems(keyed, []).some((x) => x.includes("carry")), "v10: a multimesh key fails");
    const typed = traceFromTransactions([{ meta: tx({}, "unknown-multimesh"), blocks }]);
    expect(v10Problems(typed, []).some((x) => x.includes("unknown-multimesh")), "v10: a non-op reason fails");
    const line = parseMmLine({ kind: "multimesh", call: "multimesh_create", frame: 1, rid: "1" }) as MmLine;
    expect(v10Problems(honest, [line]).some((x) => x.includes("hook line")), "v10: a multimesh hook line fails");
  }

  // 7. golden-11's bytes
  {
    const resolved = JSON.parse(await readFile(resolve(GOLDEN_11, "resolved.json"), "utf8")) as {
      transactions: { seq: number; state: { multimeshes?: { id: number; version: number; buffer_sha256: string | null }[] } }[];
    };
    const want = new Map(
      resolved.transactions.map((t) => [
        t.seq,
        JSON.stringify((t.state.multimeshes ?? []).map((m) => [m.id, m.version, m.buffer_sha256])),
      ]),
    );
    let withMm = 0;
    for (const name of ["full.rs11", "patch.rs11"]) {
      const trace = traceMultimeshRecording(new Uint8Array(await readFile(resolve(GOLDEN_11, name))), 11);
      expect(trace.errors.length === 0, `golden-11 ${name}: decodes`, trace.errors);
      for (const t of trace.txs) {
        const got = JSON.stringify(
          [...t.table.values()].sort((a, b) => a.id - b.id).map((m) => [m.id, m.version, m.buffer_sha256]),
        );
        if (got !== "[]") withMm++;
        expect(got === want.get(t.seq), `golden-11 ${name} seq ${t.seq}: the resolved table equals resolved.json`, [got, want.get(t.seq)]);
        for (const m of t.table.values()) {
          const f = t.floats.get(m.id);
          if (m.status === "ok" && f)
            expect(multimeshBufferSha256(f) === m.buffer_sha256, `golden-11 ${name} seq ${t.seq}: multimesh ${m.id}'s held floats hash to its digest`);
        }
      }
    }
    expect(withMm > 0, "golden-11: some transaction holds a multimesh (the case proves something)");
  }

  // 8. PM2's pixel helpers.
  {
    const px = expected.pixels;
    const W = 640;
    const H = 360;
    const blank = (): Rgba => {
      const img: Rgba = { width: W, height: H, data: new Uint8Array(W * H * 4) };
      for (let i = 0; i < img.data.length; i += 4) img.data.set([77, 77, 77, 255], i);
      return img;
    };
    /** A shot drawing one 4x4 blot at the centre of each cell in `cells`. */
    const shot = (cells: string[]): Rgba => {
      const img = blank();
      for (const c of cells) {
        const r = px.regions[c];
        const cx = Math.floor((r[0] + r[2]) / 2);
        const cy = Math.floor((r[1] + r[3]) / 2);
        for (let y = cy; y < cy + 4; y++)
          for (let x = cx; x < cx + 4; x++) img.data.set([200, 30, 30, 255], (y * W + x) * 4);
      }
      return img;
    };
    const drawnAt = (step: number) =>
      Object.entries(px.drawn_steps)
        .filter(([, s]) => s.includes(step))
        .map(([c]) => c);
    for (const step of [0, 2]) {
      const ref = shot(drawnAt(step));
      expect(mmPremiseInkProblems(mmInk(ref, px), px, step).length === 0, `8: step ${step}: the reference's ink passes`, mmPremiseInkProblems(mmInk(ref, px), px, step));
      const d = mmCellDiff(blank(), ref, px.regions);
      expect(d !== null && mmMissingProblems(d, px, step).length === 0, `8: step ${step}: a shot without multimesh differs in exactly the drawn cells`, d && mmMissingProblems(d, px, step));
      expect(d !== null && mmExactProblems(d).length === 1, `8: step ${step}: a shot without multimesh fails the exact verdict`);
      expect(mmExactProblems(mmCellDiff(ref, ref, px.regions)!).length === 0, `8: step ${step}: a shot equals itself`);
    }
    const hiddenDrawn = shot([...drawnAt(0), "G_HIDDEN"]);
    expect(mmPremiseInkProblems(mmInk(hiddenDrawn, px), px, 0).some((p) => p.startsWith("G_HIDDEN")), "8: the hidden cell drawn fails the premise");
    const freedDrawn = shot(drawnAt(1));
    expect(mmPremiseInkProblems(mmInk(freedDrawn, px), px, 2).some((p) => p.startsWith("H_FREE")), "8: H_FREE drawn at step 2 (after its free) fails the premise");
    const missingA = shot(drawnAt(0).filter((c) => c !== "A_XFORM"));
    expect(mmPremiseInkProblems(mmInk(missingA, px), px, 0).some((p) => p.startsWith("A_XFORM")), "8: a drawn cell left blank fails the premise");
    const ref = shot(drawnAt(0));
    const off = shot(drawnAt(0));
    off.data.set([201, 30, 30, 255], (65 * W + 110) * 4);
    const d1 = mmCellDiff(off, ref, px.regions);
    expect(d1 !== null && d1.cells.A_XFORM === 1 && mmExactProblems(d1)[0]?.includes("A_XFORM 1") === true, "8: one pixel off fails exactly, in its cell", d1);
    const partial = mmCellDiff(shot(["C_FLIP"]), ref, px.regions);
    expect(partial !== null && mmMissingProblems(partial, px, 0).length === 1, "8: a leg that still draws one cell fails mmMissingProblems in that cell only", partial && mmMissingProblems(partial, px, 0));
    expect(mmCellDiff({ width: 2, height: 2, data: new Uint8Array(16) }, ref, px.regions) === null, "8: shots of different sizes do not compare");
    expect(Object.entries(px.moving).every(([c, at]) => at.every((k) => px.drawn_steps[c].includes(k))), "8: every moving cell draws where it moves");
    const gap = mmCellDiff(shot(drawnAt(0).filter((c) => c !== "D_GLOBAL").concat(["G_HIDDEN"])), ref, px.regions);
    expect(gap !== null && mmExactProblems(gap, ["D_GLOBAL", "G_HIDDEN"]).length === 0 && mmExactProblems(gap).length === 1, "8: the identity-transform gap's cells are ignored only when asked", gap);
  }

  console.log(`\nself-test-gate8-mm: ${assertions - failures}/${assertions} assertions passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
