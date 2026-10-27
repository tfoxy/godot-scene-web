// Gate 8 g8w11 checks (W11b, protocol/render-stream-11.md: the capture side of /11), judged on the
// headless /11 captures run-gate8.sh's g8w11 group writes:
//
//   w11-validate          every honest recording (both sinks) passes the TypeScript validator and
//                         rs-core-check at /11: the carried-set rules (resource-unnamed included),
//                         mesh-dynamic, mesh-u8-offset, content-version-stable, patched unsupported
//   cv-churn-caught       the cv-churn patch recording fails content-version-stable in both
//   keep-carried-caught   the keep-carried recordings fail resource-missing in both
//   dyn-wire              every dynamic mesh body a transaction holds, rebuilt into GRM1, hashes to
//                         the hook log's surface hash for that mesh at that frame; perturb-vertex
//                         and stale-dynamic each fail it (`dyn-wire-catches-*`)
//   dyn-classify          under auto a mesh is first dynamic at its second change frame within K
//                         (the hook log's change frames), never earlier, and never demoted while it
//                         has surfaces; under off no mesh is ever dynamic
//   carried-equals-names  the records before each transaction T are exactly inline(T) \ inline(B),
//                         in table order (L2)
//   resend-on-return      GRC_MESH_DYNAMIC=off on gate6-scene: each time an inline hash enters
//                         inline(S) again it is carried again, exactly once
//   cv-stable             identical redraws leave the patch: the honest scale patches carry far
//                         fewer items than cv-churn's
//
// W11c adds GSW's legs on these captures (gsw-w11-replays, gsw-dynamic-applied, gsw-w11-equals-v10,
// store-bounded, inline-fetch-zero and the receiver sabotages): lib/gate8-w11-gsw-checks.ts.
//
// The pure helpers are exported so scripts/test/self-test-gate8-w11.ts drives them synthetically.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResourceLine } from "./gate2-checks";
import { replayMeshLog } from "./gate5e-checks";
import { RS_CORE_CHECK } from "./gate7-gsw-checks";
import { runG8w11Gsw } from "./gate8-w11-gsw-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import {
  decodeRecord,
  type ResolvedRecording,
  type ResolvedTransaction,
  rawRecordBlock,
  resolveRecording,
  splitRecords,
  validateRecording,
  withRecordMemo,
} from "./render-stream-2";
import { expectedMeshBufferBytes } from "./render-stream-mesh";
import { runG8w11Coding } from "./gate8-w11t-checks";

export const HONEST_LEGS = [
  "scale/capture",
  "scene/capture",
  "scene/off/capture",
  "mesh/capture",
];
const SINKS = ["recording.rs11", "recording-patch.rs11"];

const GRM1_MAGIC = Uint8Array.from([
  0x47, 0x52, 0x4d, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A dynamic surface's body rebuilt into its render-stream-mesh/1 payload: the GRM1 magic, the
 * meta length, the canonical meta its shape implies (rs_mesh_payload.cpp payload_meta), the body. */
export function rebuildGrm1(
  surface: {
    primitive: string;
    format: number;
    vertex_count: number;
    index_count: number;
  },
  body: Uint8Array,
): Uint8Array {
  const e = expectedMeshBufferBytes(
    surface.format,
    surface.vertex_count,
    surface.index_count,
  );
  const meta =
    `{"type":"mesh-surface","primitive":"${surface.primitive}","format":${surface.format}` +
    `,"vertex_count":${surface.vertex_count},"index_count":${surface.index_count}` +
    `,"vertex_bytes":${e.vertex_bytes},"attribute_bytes":${e.attribute_bytes}` +
    `,"skin_bytes":${e.skin_bytes},"index_bytes":${e.index_bytes}}`;
  const m = new TextEncoder().encode(meta);
  const out = new Uint8Array(8 + 4 + m.length + body.length);
  out.set(GRM1_MAGIC, 0);
  new DataView(out.buffer).setUint32(8, m.length, true);
  out.set(m, 12);
  out.set(body, 12 + m.length);
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface WireSurface {
  hash: string | null;
  payload_bytes: number;
  primitive: string;
  format: number;
  vertex_count: number;
  index_count: number;
}
interface WireMesh {
  id: number;
  status: string;
  u8?: number | null;
  surfaces: WireSurface[];
}
interface WireTx {
  type: string;
  seq: number;
  frame: number;
  encoding: string;
  meshes?: WireMesh[];
  removed_meshes?: number[];
  items?: unknown[];
  blocks?: { name: string; count: number }[];
}

/** Per transaction: the frame and, for each dynamic mesh the transaction's resolved state holds,
 * the GRM1 hashes of its current bodies (in surface order). Also counts what moved. */
export interface DynamicTrace {
  txs: {
    seq: number;
    frame: number;
    full: boolean;
    dynamic: Map<number, string[]>;
  }[];
  bodies_sent: number;
  body_bytes: number;
  items_patched: number[];
}

export function traceDynamic(data: Uint8Array): DynamicTrace {
  const split = splitRecords(data, 11);
  const held = new Map<number, string[]>();
  const out: DynamicTrace = {
    txs: [],
    bodies_sent: 0,
    body_bytes: 0,
    items_patched: [],
  };
  for (let i = 1; i < split.records.length; i++) {
    const raw = split.records[i];
    const meta = decodeRecord(raw, 11).record?.meta as WireTx | undefined;
    if (!meta || meta.type !== "transaction") continue;
    const full = meta.encoding === "full";
    if (full) held.clear();
    for (const id of meta.removed_meshes ?? []) held.delete(id);
    const block = rawRecordBlock(raw, 7);
    for (const m of meta.meshes ?? []) {
      const dynamic =
        m.status === "ok" &&
        m.surfaces.length > 0 &&
        m.surfaces[0].hash === null;
      if (!dynamic) {
        held.delete(m.id);
        continue;
      }
      if (m.u8 === null || m.u8 === undefined) continue; // "the bytes you hold"
      let at = m.u8;
      const hashes: string[] = [];
      for (const s of m.surfaces) {
        const len = s.payload_bytes;
        hashes.push(sha256(rebuildGrm1(s, block.subarray(at, at + len))));
        at += len;
        out.body_bytes += len;
      }
      out.bodies_sent += 1;
      held.set(m.id, hashes);
    }
    if (!full) out.items_patched.push((meta.items ?? []).length);
    out.txs.push({
      seq: meta.seq,
      frame: meta.frame,
      full,
      dynamic: new Map(held),
    });
  }
  return out;
}

/** dyn-wire: each dynamic mesh's held bodies against the hook log at the transaction's frame. */
export function dynWireProblems(
  trace: DynamicTrace,
  lines: readonly ResourceLine[],
): string[] {
  const problems: string[] = [];
  const snaps = replayMeshLog(lines);
  let k = -1;
  let checked = 0;
  for (const t of trace.txs) {
    while (k + 1 < snaps.length && snaps[k + 1].frame <= t.frame) k++;
    const log = k >= 0 ? snaps[k].state : new Map();
    for (const [id, hashes] of t.dynamic) {
      const l = log.get(id);
      checked += 1;
      if (!l) {
        problems.push(
          `seq ${t.seq}: dynamic mesh ${id} is not in the hook log`,
        );
      } else if (
        l.hashes.length !== hashes.length ||
        hashes.some((h, i) => l.hashes[i] !== "?" && l.hashes[i] !== h)
      ) {
        problems.push(
          `seq ${t.seq} (frame ${t.frame}): mesh ${id}'s bodies hash [${hashes.map((h) => h.slice(0, 10)).join(",")}], the hook log [${l.hashes.map((h: string) => h.slice(0, 10)).join(",")}]`,
        );
      }
      if (problems.length > 12) return problems;
    }
  }
  if (checked === 0) problems.push("no dynamic mesh body to check");
  return problems;
}

/** dyn-classify: the first transaction each mesh is dynamic in against the hook log's change
 * frames (a frame whose end-of-frame surface hashes differ from the previous frame's, the mesh's
 * build frame excluded). `frames` is K; `mode` the session's mesh_dynamic mode. */
export function dynClassifyProblems(
  trace: DynamicTrace,
  lines: readonly ResourceLine[],
  mode: string,
  frames: number,
): string[] {
  const problems: string[] = [];
  const snaps = replayMeshLog(lines);
  // change frames per mesh id
  const changes = new Map<number, number[]>();
  const born = new Map<number, number>();
  let prev = new Map<number, string>();
  for (const s of snaps) {
    const now = new Map<number, string>();
    for (const [id, m] of s.state) {
      if (m.status === "freed") continue;
      now.set(id, m.hashes.join(","));
      if (!born.has(id)) born.set(id, s.frame);
      const before = prev.get(id);
      if (
        before !== undefined &&
        before !== now.get(id) &&
        s.frame !== born.get(id)
      ) {
        const list = changes.get(id) ?? [];
        list.push(s.frame);
        changes.set(id, list);
      }
    }
    prev = now;
  }
  const expected = new Map<number, number>();
  for (const [id, list] of changes) {
    for (let i = 1; i < list.length; i++) {
      if (list[i] - list[i - 1] <= frames) {
        expected.set(id, list[i]);
        break;
      }
    }
  }
  const first = new Map<number, number>();
  for (const t of trace.txs) {
    for (const id of t.dynamic.keys())
      if (!first.has(id)) first.set(id, t.frame);
  }
  if (mode === "off") {
    if (first.size > 0)
      problems.push(`mode off, yet ${first.size} mesh(es) went dynamic`);
    return problems;
  }
  for (const [id, f] of first) {
    const want = expected.get(id);
    if (want === undefined)
      problems.push(`mesh ${id} dynamic at frame ${f}, no second change`);
    else if (want !== f)
      problems.push(
        `mesh ${id} dynamic at frame ${f}, its second change within ${frames} is ${want}`,
      );
    if (problems.length > 12) return problems;
  }
  for (const [id, want] of expected) {
    if (!first.has(id) && want <= (trace.txs.at(-1)?.frame ?? 0))
      problems.push(
        `mesh ${id} changed twice within ${frames} by frame ${want}, never dynamic`,
      );
    if (problems.length > 12) return problems;
  }
  // never demoted (a dynamic mesh that is still ok with surfaces stays in `dynamic`)
  const seen = new Set<number>();
  for (const t of trace.txs) {
    for (const id of seen) {
      if (
        !t.dynamic.has(id) &&
        expected.has(id) &&
        stillHasSurfaces(snaps, id, t.frame)
      )
        problems.push(`seq ${t.seq}: mesh ${id} was demoted`);
    }
    for (const id of t.dynamic.keys()) seen.add(id);
    if (problems.length > 12) break;
  }
  return problems;
}

function stillHasSurfaces(
  snaps: ReturnType<typeof replayMeshLog>,
  id: number,
  frame: number,
): boolean {
  let state: ReturnType<typeof replayMeshLog>[number]["state"] | undefined;
  for (const s of snaps) {
    if (s.frame > frame) break;
    state = s.state;
  }
  const m = state?.get(id);
  return m !== undefined && m.status === "ok" && m.hashes.length > 0;
}

/** inline(S) in table order: ok image textures, then static surfaces of ok meshes, then payload
 * shaders, each at or under `inlineMax`, first occurrence only (no texture variants). */
export function inlineNames(
  state: ResolvedTransaction["state"],
  inlineMax: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (hash: string | null | undefined, bytes: number) => {
    if (!hash || bytes > inlineMax || seen.has(hash)) return;
    seen.add(hash);
    out.push(hash);
  };
  for (const t of state.textures as unknown as {
    kind: string;
    status: string;
    hash: string | null;
    payload_bytes: number;
  }[]) {
    if (t.kind === "image" && t.status === "ok") add(t.hash, t.payload_bytes);
  }
  for (const m of state.meshes ?? []) {
    if (m.status !== "ok") continue;
    for (const s of m.surfaces)
      if (s.hash !== null) add(s.hash, s.payload_bytes);
  }
  for (const sh of (state.shaders ?? []) as unknown as {
    status: string;
    source: string | null;
    hash: string | null;
    payload_bytes: number | null;
  }[]) {
    if (sh.status === "ok" && sh.source === "payload")
      add(sh.hash, sh.payload_bytes ?? 0);
  }
  return out;
}

/** carried-equals-names (L2): the records before each transaction are inline(T) \ inline(B). */
export function carriedEqualsNamesProblems(
  rec: ResolvedRecording,
  inlineMax: number,
): string[] {
  const problems: string[] = [];
  const bySeq = new Map<number, string[]>();
  for (const r of rec.resources) {
    if (r.before_seq === undefined) continue;
    const list = bySeq.get(r.before_seq) ?? [];
    list.push(r.hash);
    bySeq.set(r.before_seq, list);
  }
  let before = new Set<string>();
  for (const t of rec.transactions) {
    const names = inlineNames(t.state, inlineMax);
    const want = names.filter((h) => !before.has(h));
    const got = bySeq.get(t.seq) ?? [];
    if (want.length !== got.length || want.some((h, i) => got[i] !== h))
      problems.push(
        `seq ${t.seq}: records [${got.map((h) => h.slice(0, 8)).join(",")}], inline(T) \\ inline(B) [${want.map((h) => h.slice(0, 8)).join(",")}]`,
      );
    before = new Set(names);
    if (problems.length > 12) break;
  }
  return problems;
}

/** resend-on-return: per hash, the records equal the number of times it enters inline(S). */
export function resendOnReturn(
  rec: ResolvedRecording,
  inlineMax: number,
): { problems: string[]; returns: number } {
  const entries = new Map<string, number>();
  let before = new Set<string>();
  for (const t of rec.transactions) {
    const names = new Set(inlineNames(t.state, inlineMax));
    for (const h of names)
      if (!before.has(h)) entries.set(h, (entries.get(h) ?? 0) + 1);
    before = names;
  }
  const records = new Map<string, number>();
  for (const r of rec.resources)
    records.set(r.hash, (records.get(r.hash) ?? 0) + 1);
  const problems: string[] = [];
  let returns = 0;
  for (const [h, n] of entries) {
    if (n > 1) returns += n - 1;
    if ((records.get(h) ?? 0) !== n)
      problems.push(
        `${h.slice(0, 12)} enters inline(S) ${n} time(s), carried ${records.get(h) ?? 0}`,
      );
    if (problems.length > 12) break;
  }
  if (returns === 0)
    problems.push("no inline hash returned (the leg proves nothing)");
  return { problems, returns };
}

function rsCoreValidate(path: string): string {
  if (!existsSync(RS_CORE_CHECK))
    return `missing ${RS_CORE_CHECK} (build-rs-core.sh)`;
  const r = spawnSync(RS_CORE_CHECK, ["validate", path, "--version", "11"], {
    encoding: "utf8",
  });
  const line = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  const cols = line.split("\t");
  return cols[1] === "ok"
    ? "ok"
    : `${cols[1] ?? "?"}: ${(cols[2] ?? r.stderr ?? "").slice(0, 200)}`;
}

async function bytesOf(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/** Both validators on one recording: ["ok", "ok"] or each one's first error. */
async function validateBoth(path: string): Promise<[string, string] | null> {
  const data = await bytesOf(path);
  if (!data) return null;
  const ts = validateRecording(data, 11);
  return [ts.length === 0 ? "ok" : ts[0].slice(0, 240), rsCoreValidate(path)];
}

export interface G8w11Report {
  legs: Record<string, unknown>;
}

export async function runG8w11(
  out: string,
): Promise<{ checks: G8aCheck[]; report: G8w11Report }> {
  const g = join(out, "g8w11");
  const checks: G8aCheck[] = [];
  const report: G8w11Report = { legs: {} };
  const legDir = (leg: string) => join(g, leg);
  const legSkipped = (leg: string) => skipped(legDir(leg));

  // w11-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of HONEST_LEGS) {
      if (legSkipped(leg)) continue;
      for (const sink of SINKS) {
        const v = await validateBoth(join(legDir(leg), sink));
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
        "w11-validate",
        "W11b: every honest /11 recording passes the TypeScript validator and rs-core-check (carried set, resource-unnamed, mesh-dynamic, content-version-stable, patched unsupported)",
        any ? problems : null,
      ),
    );
  }
  // sabotages caught by the validators
  for (const [id, leg, sinks, code] of [
    [
      "cv-churn-caught",
      "scale/sabotage-cv-churn/capture",
      ["recording-patch.rs11"],
      "content-version-stable",
    ],
    [
      "keep-carried-caught",
      "scene/sabotage-keep-carried/capture",
      SINKS,
      "resource-missing",
    ],
  ] as const) {
    if (legSkipped(leg)) {
      checks.push({
        id,
        criterion: `W11b: ${leg} fails ${code}`,
        passed: true,
        status: "not-run",
        detail: `skipped-by-tier: ${leg}`,
        gating: false,
      });
      continue;
    }
    const problems: string[] = [];
    let any = false;
    for (const sink of sinks) {
      const v = await validateBoth(join(legDir(leg), sink));
      if (!v) continue;
      any = true;
      if (!v[0].startsWith(code)) problems.push(`${sink}: TS says ${v[0]}`);
      if (!v[1].startsWith(code))
        problems.push(`${sink}: rs-core says ${v[1]}`);
    }
    checks.push(
      check(
        id,
        `W11b: the ${leg.split("/")[1]} recording fails ${code} in both validators`,
        any ? problems : null,
      ),
    );
  }

  // dyn-wire, dyn-classify, carried-equals-names, cv-stable
  const traces = new Map<string, DynamicTrace>();
  const dynWire: string[] = [];
  const dynClassify: string[] = [];
  const carried: string[] = [];
  let anyDyn = false;
  for (const leg of HONEST_LEGS) {
    if (legSkipped(leg)) continue;
    const lines = jsonl<ResourceLine>(
      await readText(join(legDir(leg), "evidence", "resources.jsonl")),
    );
    const session = (await readText(join(legDir(leg), "env.txt"))) ?? "";
    const mode = /GRC_MESH_DYNAMIC=off/.test(session) ? "off" : "auto";
    for (const sink of SINKS) {
      const data = await bytesOf(join(legDir(leg), sink));
      if (!data) {
        dynWire.push(`${leg}/${sink}: missing`);
        continue;
      }
      anyDyn = true;
      withRecordMemo(data, () => {
        const trace = traceDynamic(data);
        traces.set(`${leg}/${sink}`, trace);
        if (mode === "auto")
          for (const p of dynWireProblems(trace, lines))
            dynWire.push(`${leg}/${sink}: ${p}`);
        for (const p of dynClassifyProblems(trace, lines, mode, 4))
          dynClassify.push(`${leg}/${sink}: ${p}`);
        const rec = resolveRecording(data, 11);
        for (const p of carriedEqualsNamesProblems(rec, 4096))
          carried.push(`${leg}/${sink}: ${p}`);
        (report.legs as Record<string, unknown>)[`${leg}/${sink}`] = {
          transactions: trace.txs.length,
          bodies_sent: trace.bodies_sent,
          body_bytes: trace.body_bytes,
          dynamic_meshes_last: trace.txs.at(-1)?.dynamic.size ?? 0,
          resource_records: rec.resources.length,
          bytes: data.length,
        };
      });
    }
  }
  checks.push(
    check(
      "dyn-wire",
      "W11b: every dynamic body a transaction holds, rebuilt into GRM1, hashes to the hook log's surface hash for that mesh at that frame",
      anyDyn ? dynWire : null,
    ),
  );
  checks.push(
    check(
      "dyn-classify",
      "W11b: a mesh is first dynamic at its second change frame within K = 4, never demoted; none under off",
      anyDyn ? dynClassify : null,
    ),
  );
  checks.push(
    check(
      "carried-equals-names",
      "W11b: the records before each transaction are inline(T) \\ inline(B), in table order (L2)",
      anyDyn ? carried : null,
    ),
  );

  // the dyn-wire sabotages
  for (const s of ["perturb-vertex", "stale-dynamic"]) {
    const leg = `scale/sabotage-${s}/capture`;
    const id = `dyn-wire-catches-${s}`;
    if (legSkipped(leg)) {
      checks.push({
        id,
        criterion: `W11b: dyn-wire fails on ${leg}`,
        passed: true,
        status: "not-run",
        detail: `skipped-by-tier: ${leg}`,
        gating: false,
      });
      continue;
    }
    const lines = jsonl<ResourceLine>(
      await readText(join(legDir(leg), "evidence", "resources.jsonl")),
    );
    const data = await bytesOf(join(legDir(leg), "recording-patch.rs11"));
    if (!data) {
      checks.push(check(id, `W11b: dyn-wire fails on ${leg}`, null));
      continue;
    }
    const caught = dynWireProblems(traceDynamic(data), lines);
    checks.push(
      check(
        id,
        `W11b: dyn-wire fails on the ${s} patch recording`,
        caught.length > 0 ? [] : ["dyn-wire passed: the sabotage went unseen"],
        caught[0],
      ),
    );
  }

  // resend-on-return
  {
    const leg = "scene/off/capture";
    const data = legSkipped(leg)
      ? null
      : await bytesOf(join(legDir(leg), "recording-patch.rs11"));
    if (!data)
      checks.push(
        check(
          "resend-on-return",
          "W11b: off: each return of an inline hash is re-carried exactly once",
          null,
        ),
      );
    else {
      const r = resendOnReturn(resolveRecording(data, 11), 4096);
      checks.push(
        check(
          "resend-on-return",
          "W11b: GRC_MESH_DYNAMIC=off on gate6-scene: each return of an inline hash (MS's poses recur every 90 frames) is re-carried exactly once",
          r.problems,
          `${r.returns} return(s) re-carried`,
        ),
      );
    }
  }

  // cv-stable
  {
    const honest = traces.get("scale/capture/recording-patch.rs11");
    const leg = "scale/sabotage-cv-churn/capture";
    const churnData = legSkipped(leg)
      ? null
      : await bytesOf(join(legDir(leg), "recording-patch.rs11"));
    if (!honest || !churnData) {
      checks.push(
        check(
          "cv-stable",
          "W11b: identical redraws leave the patch (honest vs cv-churn)",
          honest ? [] : null,
          "cv-churn leg skipped",
        ),
      );
    } else {
      const churn = traceDynamic(churnData);
      const mean = (a: number[]) =>
        a.length > 1
          ? a.slice(1).reduce((x, y) => x + y, 0) / (a.length - 1)
          : 0;
      const h = mean(honest.items_patched);
      const c = mean(churn.items_patched);
      checks.push(
        check(
          "cv-stable",
          "W11b: identical redraws (RS_SCALE_REDRAWS=150) leave the honest patch; cv-churn re-sends them",
          c - h >= 100
            ? []
            : [
                `items per patch: honest ${h.toFixed(1)}, cv-churn ${c.toFixed(1)}`,
              ],
          `items per patch: honest ${h.toFixed(1)}, cv-churn ${c.toFixed(1)}`,
        ),
      );
    }
  }
  // W11t: the live coding (gate8-w11t-checks.ts).
  checks.push(...(await runG8w11Coding(g)));
  // W11c: GSW's legs on these captures (lib/gate8-w11-gsw-checks.ts).
  checks.push(...(await runG8w11Gsw(g)));
  return { checks, report };
}
