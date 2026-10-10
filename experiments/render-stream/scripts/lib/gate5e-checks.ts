// Gate 5e checks (protocol/gate5-design.md "G5e", D5-D8, D14, D15, Q3b-Q3d, Q5, Q6d): meshes on
// render-stream/4 end to end, over fixtures/gate5-mesh. Pure evaluators over values already read
// from a run-gate5.sh evidence directory (group g5e, under <out>/mesh/ beside g5c's legs), plus
// small loaders and runGate5e, which check-gate5.ts merges into the gate 5 report. Nothing here
// launches a process. scripts/test/self-test-gate5e.ts drives the evaluators with synthetic values.
//
// Independent expectations only (D12): the hook log (evidence/resources.jsonl, G5a) is the ground
// truth for what happened to meshes and when; fixtures/gate5-mesh/expected.json (make_expected.py)
// predicts every surface hash per settle step, each mesh's wire lifetime, the receiver's uploads per
// frame from the byte model, and the sabotage sets; the reference's mesh oracle reads the rendered
// reference's own GPU buffers back. The wire is compared against those, never with itself.
//
// Evidence layout added by group g5e under <out>/mesh/ (see scripts/README.md "Gate 5"):
//   import/receiver/                editor --import of receiver/
//   receiver/, receiver-patch/      rendered receiver on capture/'s full / patch sink: applied.json
//                                   (render-stream-receiver-applied/4), shots/seq-<n>.png at the
//                                   settle seqs (receiver-patch also state/seq-<n>.json)
//   receiver-headless-trace/        headless receiver under strace (openat)
//   capture-inline/, receiver-inline/   a 400-frame capture with every payload inline (no store)
//                                   and its rendered receiver
//   sabotage-mesh-{freeze,omit-vertex-region,perturb-vertex}/{capture,receiver}/
//   sabotage-mesh-receiver-{drop-surface,stale}/   rendered receivers on capture/

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type AppliedJson,
  type CaptureResultJson,
  type Checkpoint,
  type Classification,
  checkReceiverNeverLoadedFixture,
  classifyLeg,
  loadRecording,
  PATCH_RECORDING_NAME,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import { resolvedStateOf } from "./gate1-checks";
import { loadResourceLog, type ResourceLine } from "./gate2-checks";
import { evaluateCapture } from "./gate3-checks";
import {
  check,
  compareLegs5,
  evaluateFreshness5,
  type Gate5Check,
  loadShots5,
  type RegionBudget5,
} from "./gate5-checks";
import {
  asGate5,
  expandCensus,
  G5C_LEG_DIR,
  type Gate5MeshExpected,
  meshNamesById,
  meshRasters,
} from "./gate5c-checks";
import {
  computeGate5Checkpoints,
  evaluateLegClass5,
  type Gate5LegExpectation,
  loadReceiverShots5,
  settleSeqs,
  shotSeqsPresent5,
} from "./gate5d-checks";
import { statesEqual } from "./render-stream-2";

/** The honest receiver legs: leg name, directory, the capture directory and sink they replay. */
export const G5E_RECEIVER_LEGS = [
  {
    leg: "receiver-mesh",
    dir: "receiver",
    capture: "capture",
    sink: RECORDING_NAME,
  },
  {
    leg: "receiver-mesh-patch",
    dir: "receiver-patch",
    capture: "capture",
    sink: PATCH_RECORDING_NAME,
  },
  {
    leg: "receiver-mesh-inline",
    dir: "receiver-inline",
    capture: "capture-inline",
    sink: RECORDING_NAME,
  },
] as const;
/** Host sabotages: <kind> is the leg sabotage-mesh-<kind> and its prediction key. */
export const G5E_SABOTAGE_CAPTURE_KINDS = [
  "freeze",
  "omit-vertex-region",
  "perturb-vertex",
] as const;
/** Receiver sabotages on capture/: sabotage-mesh-receiver-<kind>. */
export const G5E_SABOTAGE_RECEIVER_KINDS = ["drop-surface", "stale"] as const;
export const G5E_CAPTURE_QUIT_FRAME = 400;

/** One applied.json mesh_uploads row (render-stream-receiver-applied/4). */
export interface MeshUploadRow {
  stream?: number;
  seq: number;
  id: number;
  op: string;
  surfaces: number[];
  buffers: string[];
  bytes: number;
}

/** The applied.json fields g5e reads beyond gate 0's. */
export type AppliedJson5e = AppliedJson & {
  mesh_uploads?: MeshUploadRow[];
  fetches?: {
    seq?: number;
    hash?: string;
    source?: string;
    kind?: string;
    bytes?: number;
  }[];
  transactions?: {
    seq?: number;
    frame?: number;
    mesh_commands?: number | null;
    resources?: Record<string, number> | null;
  }[];
  resources_summary?: Record<string, number>;
};

// ---------------------------------------------------------------------------------------------
// The hook log, replayed by wire id (D15 mesh-log-divergence, mesh-versions-current)
// ---------------------------------------------------------------------------------------------

export interface LogMesh {
  version: number;
  status: string;
  /** per surface: the line's hash, "?" where the log names none; [] once cleared */
  hashes: string[];
  /** per surface: the frame of the line that set its hash (when its payload was taken) */
  frames: number[];
}

/** Replays the hook log's mesh lines in order (omitted lines change nothing, as in the mirror) and
 * returns the state at the end of every frame that has a line. */
export function replayMeshLog(
  lines: readonly ResourceLine[],
): Array<{ frame: number; state: Map<number, LogMesh> }> {
  const out: Array<{ frame: number; state: Map<number, LogMesh> }> = [];
  const state = new Map<number, LogMesh>();
  let frame = 0;
  const snapshot = () => {
    const copy = new Map<number, LogMesh>();
    for (const [id, m] of state)
      copy.set(id, { ...m, hashes: [...m.hashes], frames: [...m.frames] });
    out.push({ frame, state: copy });
  };
  for (const l of lines) {
    if (l.kind !== "mesh" || l.omitted === true || l.id === null) continue;
    if (l.frame !== frame) {
      if (frame > 0) snapshot();
      frame = l.frame;
    }
    const cur = state.get(l.id);
    const version = l.version ?? -1;
    const status = l.status ?? "?";
    switch (l.op) {
      case "mesh_create":
        state.set(l.id, { version, status, hashes: [], frames: [] });
        break;
      case "mesh_create_from_surfaces":
        state.set(l.id, {
          version,
          status,
          hashes: [l.hash ?? "?"],
          frames: [l.frame],
        });
        break;
      case "free":
        state.set(l.id, { version, status: "freed", hashes: [], frames: [] });
        break;
      default: {
        if (!cur || l.outcome !== "applied") break;
        const hashes = [...cur.hashes];
        const frames = [...cur.frames];
        if (l.op === "mesh_add_surface") {
          hashes.push(l.hash ?? "?");
          frames.push(l.frame);
        } else if (l.op === "mesh_surface_remove" && l.surface !== null) {
          hashes.splice(l.surface, 1);
          frames.splice(l.surface, 1);
        } else if (l.op === "mesh_clear") {
          hashes.length = 0;
          frames.length = 0;
        } else if (
          l.op.startsWith("mesh_surface_update_") &&
          l.surface !== null &&
          l.hash !== null
        ) {
          hashes[l.surface] = l.hash;
          frames[l.surface] = l.frame;
        }
        state.set(l.id, { version, status, hashes, frames });
      }
    }
  }
  if (frame > 0) snapshot();
  return out;
}

/** Pure: every transaction's mesh table against the hook log's state at the end of its frame
 * (D15). Each entry's id is the log's, its version equal, its status equal (a `freed` tombstone the
 * log's freed mesh); every mesh the log holds live is in the table. With `hashes`, each `ok`
 * entry's surface hashes equal the log's too (where it names them). */
export function meshLogDivergence(
  lines: readonly ResourceLine[],
  recording: Pick<RecordingSummary, "transactions">,
  opts: { hashes: boolean },
): string[] {
  const problems: string[] = [];
  const snaps = replayMeshLog(lines);
  let k = -1;
  for (const t of recording.transactions) {
    while (k + 1 < snaps.length && snaps[k + 1].frame <= t.meta.frame) k++;
    const log = k >= 0 ? snaps[k].state : new Map<number, LogMesh>();
    const table = t.meta.meshes ?? [];
    const where = `seq ${t.meta.seq} (frame ${t.meta.frame})`;
    for (const e of table) {
      const l = log.get(e.id);
      if (!l) {
        problems.push(`${where}: mesh ${e.id} is not in the hook log`);
        continue;
      }
      if (l.version !== e.version || l.status !== e.status) {
        problems.push(
          `${where}: mesh ${e.id} is ${e.status} v${e.version}, the hook log says ${l.status} v${l.version}`,
        );
        continue;
      }
      if (opts.hashes && e.status === "ok") {
        const wire = e.surfaces.map((s) => s.hash);
        const same =
          wire.length === l.hashes.length &&
          wire.every((h, i) => l.hashes[i] === "?" || l.hashes[i] === h);
        if (!same)
          problems.push(
            `${where}: mesh ${e.id} surfaces [${wire.map((h) => h.slice(0, 12)).join(",")}], the hook log [${l.hashes.map((h) => h.slice(0, 12)).join(",")}]`,
          );
      }
    }
    const ids = new Set(table.map((e) => e.id));
    for (const [id, l] of log)
      if (l.status !== "freed" && !ids.has(id))
        problems.push(
          `${where}: live mesh ${id} (log v${l.version}) is not on the wire`,
        );
    if (problems.length > 8) break;
  }
  return problems;
}

/** classifyLeg plus D15's `mesh-log-divergence` (ids, versions and statuses; hashes are
 * mesh-versions-current's) as a capture-failure. */
export function classifyMeshLeg(
  base: Classification,
  divergence: readonly string[],
): Classification {
  if (divergence.length === 0) return base;
  const reasons = [
    `capture-failure: mesh-log-divergence: ${divergence[0]}`,
    ...base.reasons,
  ];
  return { ...base, result_class: "capture-failure", reasons };
}

// ---------------------------------------------------------------------------------------------
// The wire against expected.json
// ---------------------------------------------------------------------------------------------

/** Mesh name -> wire id, from the hook log's creation order (ids 1.. in mesh_order). */
export function meshIdsByName(
  expected: Pick<Gate5MeshExpected, "mesh_order">,
  lines: readonly ResourceLine[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, name] of meshNamesById(
    lines.filter((l) => l.kind === "mesh"),
    expected.mesh_order,
  ))
    out.set(name, id);
  return out;
}

/** Pure: at every settle step, each mesh the oracle reads back live is the wire entry of its hook
 * log id with exactly the oracle's surface hashes, in order (each oracle surface paired with one
 * wire surface; the id, and so the pairing, never changes over the mesh's life); a freed mesh is
 * a tombstone or absent, an absent one absent. `oracle` is make_expected.py's steps[].meshes
 * (which oracle-agrees and mesh-hook-hash-parity already tie to the GPU readback). */
export function evaluateWireHashParity(
  expected: Pick<Gate5MeshExpected, "steps" | "mesh_order">,
  ids: ReadonlyMap<string, number>,
  sinks: readonly {
    label: string;
    recording: Pick<RecordingSummary, "transactions">;
  }[],
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const sink of sinks)
    for (const s of expected.steps) {
      const t = sink.recording.transactions.find(
        (x) => x.meta.frame === s.settle_frame,
      );
      if (!t) {
        problems.push(
          `${sink.label} step ${s.step}: no transaction at frame ${s.settle_frame}`,
        );
        continue;
      }
      const table = new Map((t.meta.meshes ?? []).map((m) => [m.id, m]));
      for (const want of s.meshes) {
        const id = ids.get(want.name);
        const e = id === undefined ? undefined : table.get(id);
        const where = `${sink.label} step ${s.step} ${want.name}`;
        if (want.status === "live") {
          const hashes = (want.surfaces ?? []).map((x) => x.sha256);
          const wire =
            e?.status === "ok" ? e.surfaces.map((x) => x.hash) : null;
          if (JSON.stringify(wire) !== JSON.stringify(hashes))
            problems.push(
              `${where}: wire ${JSON.stringify(wire?.map((h) => h.slice(0, 12)) ?? e?.status ?? "absent")} != oracle ${JSON.stringify(hashes.map((h) => h.slice(0, 12)))}`,
            );
          else compared += hashes.length;
        } else if (e && !(want.status === "freed" && e.status === "freed"))
          problems.push(
            `${where}: ${want.status} but the wire has it ${e.status}`,
          );
      }
    }
  return { problems, compared };
}

/** Pure: per frame, the wire mesh table holds exactly the meshes predictions["mesh-lifetimes"]
 * says ([first frame, last live frame | null, last tombstone frame | null]), by hook-log id, a
 * tombstone `freed`; DF's id leaves and DF2's arrives in one transaction; the patch sink removes
 * each id in the frame it leaves. */
export function evaluateWireMeshCensus(
  expected: Pick<Gate5MeshExpected, "predictions" | "mesh_order">,
  ids: ReadonlyMap<string, number>,
  full: Pick<RecordingSummary, "transactions">,
  patch: Pick<RecordingSummary, "transactions"> | null,
): { problems: string[]; table: Record<string, string> } {
  const problems: string[] = [];
  const life = (expected.predictions["mesh-lifetimes"] ?? {}) as Record<
    string,
    [number, number | null, number | null]
  >;
  const table: Record<string, string> = {};
  const states = new Map<string, string>();
  for (const t of full.transactions) {
    const f = t.meta.frame;
    const want: string[] = [];
    for (const name of expected.mesh_order) {
      const l = life[name];
      if (!l || f < l[0]) continue;
      if (l[1] === null || f <= l[1]) want.push(`${ids.get(name)}:ok`);
      else if (l[2] !== null && f <= l[2]) want.push(`${ids.get(name)}:freed`);
    }
    const got = (t.meta.meshes ?? [])
      .map((m) => `${m.id}:${m.status === "freed" ? "freed" : "ok"}`)
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    want.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    if (JSON.stringify(got) !== JSON.stringify(want) && problems.length < 6)
      problems.push(
        `frame ${f}: wire meshes {${got.join(",")}}, expected {${want.join(",")}}`,
      );
    const text = got.join(",");
    if (states.get("last") !== text) {
      table[String(f)] = text;
      states.set("last", text);
    }
  }
  if (patch) {
    for (const name of expected.mesh_order) {
      const l = life[name];
      if (!l) continue;
      const leaves = l[2] !== null ? l[2] + 1 : l[1] !== null ? l[1] + 1 : null;
      if (leaves === null) continue;
      const t = patch.transactions.find((x) => x.meta.frame === leaves);
      if (!t) continue;
      const removed = t.wire?.removed_meshes ?? [];
      if (!removed.includes(ids.get(name) ?? -1))
        problems.push(
          `patch frame ${leaves}: removed_meshes ${JSON.stringify(removed)} lacks ${name} (${ids.get(name)})`,
        );
    }
  }
  return { problems, table };
}

/** Pure (fresh-without-redraw on the wire): RM's item keeps one content_version over the whole
 * run while RMS's wire version changes exactly on the frames the census has an RMS line (its
 * region updates), each with a new surface hash. */
export function evaluateWireFreshWithoutRedraw(
  expected: Pick<Gate5MeshExpected, "creation_order" | "census" | "mesh_order">,
  ids: ReadonlyMap<string, number>,
  recording: Pick<RecordingSummary, "transactions">,
  quitFrame: number,
): { problems: string[]; frames: number[] } {
  const problems: string[] = [];
  const itemIds = new Set<number>();
  for (const t of recording.transactions)
    for (const i of t.meta.items) itemIds.add(i.id);
  const sorted = [...itemIds].sort((a, b) => a - b);
  const rm = sorted[expected.creation_order.indexOf("RM")];
  const rms = ids.get("RMS");
  const versions = new Set<number>();
  const changes: number[] = [];
  let last: { version: number; hash: string } | null = null;
  for (const t of recording.transactions) {
    const item = t.meta.items.find((i) => i.id === rm);
    if (item) versions.add(item.content_version);
    const m = (t.meta.meshes ?? []).find((x) => x.id === rms);
    if (!m) continue;
    const now = { version: m.version, hash: m.surfaces[0]?.hash ?? "" };
    if (last && now.version !== last.version) {
      changes.push(t.meta.frame);
      if (now.hash === last.hash)
        problems.push(
          `frame ${t.meta.frame}: RMS v${now.version} kept its surface hash`,
        );
    }
    last = now;
  }
  if (versions.size !== 1)
    problems.push(
      `RM's content_version takes ${versions.size} values (${[...versions].join(",")})`,
    );
  const census = expandCensus(expected, quitFrame);
  const want = [...census.entries()]
    .filter(([f, ls]) => f > 1 && ls.some((l) => l[0] === "RMS"))
    .map(([f]) => f)
    .sort((a, b) => a - b);
  if (JSON.stringify(changes) !== JSON.stringify(want))
    problems.push(
      `RMS's wire version changes at frames ${changes.join(",")}, the census at ${want.join(",")}`,
    );
  return { problems, frames: changes };
}

// ---------------------------------------------------------------------------------------------
// The store (GRM1) and the receiver's resources
// ---------------------------------------------------------------------------------------------

/** Pure over the listing: every `ok` mesh surface hash in either sink is `<hash>.grm` in the store
 * hashing to its name, with a `mesh-surface` index line; every `ok` image hash is `<hash>.grt`
 * with a `texture-2d` line; the store holds nothing else. */
export async function evaluateMeshStore(
  storeDir: string,
  sinks: readonly Pick<RecordingSummary, "transactions">[],
): Promise<{
  problems: string[];
  meshes: number;
  textures: number;
  mesh_bytes: number;
}> {
  const problems: string[] = [];
  const meshHashes = new Set<string>();
  const textureHashes = new Set<string>();
  for (const r of sinks)
    for (const t of r.transactions) {
      for (const m of t.meta.meshes ?? [])
        if (m.status === "ok")
          for (const s of m.surfaces) meshHashes.add(s.hash);
      for (const x of t.meta.textures)
        if (x.kind === "image" && x.status === "ok" && x.hash)
          textureHashes.add(x.hash);
    }
  let files: string[] = [];
  try {
    files = await readdir(join(storeDir, "sha256"));
  } catch {
    problems.push(`${storeDir}/sha256 missing`);
  }
  const index = new Map<string, Record<string, unknown>>();
  for (const line of (
    (await readTextOrUndefined(join(storeDir, "index.jsonl"))) ?? ""
  )
    .split("\n")
    .filter((l) => l.trim() !== "")) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      index.set(String(v.hash), v);
    } catch {
      problems.push("index.jsonl line is not JSON");
    }
  }
  let meshBytes = 0;
  const want = new Set([
    ...[...meshHashes].map((h) => `${h}.grm`),
    ...[...textureHashes].map((h) => `${h}.grt`),
  ]);
  for (const name of want) {
    if (!files.includes(name)) {
      problems.push(`store lacks ${name}`);
      continue;
    }
    const bytes = await readFile(join(storeDir, "sha256", name));
    const hash = name.slice(0, 64);
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      problems.push(`${name} does not hash to its name`);
    const line = index.get(hash);
    const type = name.endsWith(".grm") ? "mesh-surface" : "texture-2d";
    if (!line || line.type !== type || line.bytes !== bytes.length)
      problems.push(
        `index.jsonl line for ${hash.slice(0, 12)} is ${JSON.stringify(line ?? null)}, expected type ${type}, ${bytes.length} bytes`,
      );
    if (type === "mesh-surface") meshBytes += bytes.length;
  }
  for (const name of files)
    if (!want.has(name))
      problems.push(`store holds ${name}, which no sink names`);
  if (index.size !== files.length)
    problems.push(
      `index.jsonl names ${index.size} hashes, the store holds ${files.length} files`,
    );
  return {
    problems,
    meshes: meshHashes.size,
    textures: textureHashes.size,
    mesh_bytes: meshBytes,
  };
}

/** Pure: a receiver's mesh uploads (applied.json mesh_uploads, rows mapped from wire id to mesh
 * name through `ids`) per transaction frame equal predictions["receiver-mesh-uploads"], frame by
 * frame and row by row: creates at first naming, in-place updates listing exactly the changed
 * buffers, rebuilds on layout changes, custom AABBs, frees -- with their byte counts. */
export function evaluateReceiverMeshUploads(
  expected: Pick<Gate5MeshExpected, "predictions">,
  ids: ReadonlyMap<string, number>,
  applied: AppliedJson5e | undefined,
  quitFrame: number,
): {
  problems: string[];
  rows: number;
  bytes: number;
  by_op: Record<string, number>;
} {
  const problems: string[] = [];
  const predicted = (expected.predictions["receiver-mesh-uploads"] ??
    {}) as Record<string, [string, string, number[], string[], number][]>;
  const names = new Map([...ids].map(([n, id]) => [id, n]));
  const frameOf = new Map<number, number>();
  for (const t of applied?.transactions ?? [])
    if (t.seq !== undefined && t.frame !== undefined)
      frameOf.set(t.seq, t.frame);
  const got = new Map<number, string[]>();
  let bytes = 0;
  const byOp: Record<string, number> = {};
  for (const r of applied?.mesh_uploads ?? []) {
    const f = frameOf.get(r.seq) ?? -1;
    const list = got.get(f) ?? [];
    list.push(
      JSON.stringify([
        names.get(r.id) ?? `#${r.id}`,
        r.op,
        r.surfaces,
        r.buffers,
        r.bytes,
      ]),
    );
    got.set(f, list);
    bytes += r.bytes;
    byOp[r.op] = (byOp[r.op] ?? 0) + 1;
  }
  if (!applied) problems.push("applied.json missing");
  const frames = new Set([
    ...got.keys(),
    ...Object.keys(predicted).map(Number),
  ]);
  let reported = 0;
  for (const f of [...frames].sort((a, b) => a - b)) {
    if (f > quitFrame) continue;
    const g = got.get(f) ?? [];
    const w = (predicted[String(f)] ?? []).map((r) => JSON.stringify(r));
    if (JSON.stringify(g) !== JSON.stringify(w) && reported++ < 5)
      problems.push(
        `frame ${f}: uploads ${g.join(" ")} != predicted ${w.join(" ")}`,
      );
  }
  if (reported > 5) problems.push(`... ${reported - 5} more frames differ`);
  return {
    problems,
    rows: (applied?.mesh_uploads ?? []).length,
    bytes,
    by_op: byOp,
  };
}

/** Pure (resource-quiet for meshes): every mesh payload a receiver fetched is a surface hash that
 * first appears on the wire at that transaction's frame, of a mesh whose census has a line at that
 * frame or of DF/DF2 (which change every frame); no mesh hash is fetched twice. */
export function evaluateMeshResourceQuiet(
  expected: Pick<Gate5MeshExpected, "census">,
  names: ReadonlyMap<number, string>,
  recording: Pick<RecordingSummary, "transactions">,
  applied: AppliedJson5e | undefined,
  quitFrame: number,
): { problems: string[]; fetched: number; fetched_bytes: number } {
  const problems: string[] = [];
  const census = expandCensus(expected, quitFrame);
  const owner = new Map<string, { frame: number; mesh: string }>();
  for (const t of recording.transactions)
    for (const m of t.meta.meshes ?? [])
      for (const s of m.surfaces)
        if (!owner.has(s.hash))
          owner.set(s.hash, {
            frame: t.meta.frame,
            mesh: names.get(m.id) ?? `#${m.id}`,
          });
  const frameOf = new Map<number, number>();
  for (const t of applied?.transactions ?? [])
    if (t.seq !== undefined && t.frame !== undefined)
      frameOf.set(t.seq, t.frame);
  const seen = new Set<string>();
  let fetched = 0;
  let fetchedBytes = 0;
  for (const x of applied?.fetches ?? []) {
    if (x.kind !== "mesh" || !x.hash) continue;
    fetched++;
    fetchedBytes += x.bytes ?? 0;
    if (seen.has(x.hash)) problems.push(`${x.hash.slice(0, 12)} fetched twice`);
    seen.add(x.hash);
    const o = owner.get(x.hash);
    const f = frameOf.get(x.seq ?? -1);
    if (!o) {
      problems.push(
        `fetched ${x.hash.slice(0, 12)}, which no transaction names`,
      );
      continue;
    }
    if (f !== o.frame)
      problems.push(
        `${o.mesh}'s ${x.hash.slice(0, 12)} fetched at frame ${f}, first named at ${o.frame}`,
      );
    const quiet =
      o.mesh === "DF" ||
      o.mesh === "DF2" ||
      (census.get(o.frame) ?? []).some((l) => l[0] === o.mesh);
    if (!quiet)
      problems.push(
        `${o.mesh} fetched at frame ${o.frame}, where the census has no ${o.mesh} line`,
      );
  }
  return { problems, fetched, fetched_bytes: fetchedBytes };
}

// ---------------------------------------------------------------------------------------------
// Sabotage legs against the hook log (what the log comparison sees, by design)
// ---------------------------------------------------------------------------------------------

/** Pure: the host sabotages' own log signature. omit-op: the wire equals the log (omitted lines
 * excluded) ids, versions and hashes; perturb-vertex: ids and versions equal, and an `ok` surface's
 * wire hash differs from the log's exactly when its payload was taken at or after the sabotage
 * frame (the surface hashes the log replays change at or after it); freeze-frame: from the frame
 * on, the wire republishes the frame-before table (equal to the log's state at frame - 1). */
export function evaluateSabotageLogSignature(
  kind: (typeof G5E_SABOTAGE_CAPTURE_KINDS)[number],
  frame: number,
  lines: readonly ResourceLine[],
  recording: Pick<RecordingSummary, "transactions">,
): { problems: string[]; detail: string } {
  if (kind === "omit-vertex-region") {
    const omitted = lines.filter(
      (l) => l.kind === "mesh" && l.omitted === true,
    ).length;
    const d = meshLogDivergence(lines, recording, { hashes: true });
    const problems = [...d];
    if (omitted === 0) problems.push("no omitted mesh line in the hook log");
    return {
      problems,
      detail: `${omitted} omitted region-update lines; the wire equals the log`,
    };
  }
  if (kind === "freeze") {
    const snaps = replayMeshLog(lines);
    const before = [...snaps]
      .reverse()
      .find((s) => s.frame <= frame - 1)?.state;
    const problems: string[] = [];
    let frozen = 0;
    for (const t of recording.transactions) {
      if (t.meta.frame < frame) continue;
      for (const e of t.meta.meshes ?? []) {
        const l = before?.get(e.id);
        if (!l || l.version !== e.version) {
          if (problems.length < 4)
            problems.push(
              `frame ${t.meta.frame}: mesh ${e.id} v${e.version}, the log at frame ${frame - 1} v${l?.version}`,
            );
        } else frozen++;
      }
    }
    const later = meshLogDivergence(lines, recording, { hashes: false }).length;
    if (later === 0)
      problems.push("the frozen wire never diverges from the log");
    return {
      problems,
      detail: `${frozen} frozen mesh entries equal the log at frame ${frame - 1}; ${later}+ divergences after`,
    };
  }
  // perturb-vertex
  const problems = meshLogDivergence(lines, recording, { hashes: false });
  const snaps = replayMeshLog(lines);
  let k = -1;
  let moved = 0;
  let kept = 0;
  for (const t of recording.transactions) {
    while (k + 1 < snaps.length && snaps[k + 1].frame <= t.meta.frame) k++;
    const log = k >= 0 ? snaps[k].state : new Map<number, LogMesh>();
    for (const e of t.meta.meshes ?? []) {
      const l = log.get(e.id);
      if (!l || e.status !== "ok") continue;
      e.surfaces.forEach((s, i) => {
        const truth = l.hashes[i];
        if (!truth || truth === "?") return;
        const late = (l.frames[i] ?? 0) >= frame;
        if (late !== (s.hash !== truth) && problems.length < 6)
          problems.push(
            `frame ${t.meta.frame} mesh ${e.id} s${i}: payload taken at ${l.frames[i]}, wire ${s.hash === truth ? "equals" : "differs from"} the log`,
          );
        if (late) moved++;
        else kept++;
      });
    }
  }
  return {
    problems,
    detail: `${moved} surface-frames re-hashed from frame ${frame}, ${kept} equal to the log`,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface Gate5eResult {
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
  report: {
    wire_census: Record<string, string>;
    hash_parity_surfaces: number;
    store: {
      mesh_payloads: number;
      texture_payloads: number;
      mesh_bytes: number;
    };
    uploads: Record<
      string,
      { rows: number; bytes: number; by_op: Record<string, number> }
    >;
    fetches: Record<string, { fetched: number; fetched_bytes: number }>;
    receiver_budgets: Record<string, RegionBudget5[]>;
    sabotage_regions: Record<string, Record<string, string>>;
    per_step: Record<string, Record<string, unknown>>;
  };
}

function legEntry(
  cls: Classification,
  expectedClass: string,
  exitCode: number | null,
  artifacts: string[],
): Gate5eResult["legs"][string] {
  return {
    group: "g5e",
    expected_class: expectedClass,
    result_class: cls.result_class,
    reasons: cls.reasons,
    harmless_ties: cls.harmless_ties,
    exit_code: exitCode,
    artifacts,
  };
}

/** Per step: the capture's mesh payload bytes, the hook's copy and hash cost (median ns over the
 * step's frames) and the number of mesh lines, from the hook log (D6's costs; gate 6's input). */
export function meshCostsPerStep(
  expected: Pick<Gate5MeshExpected, "steps">,
  lines: readonly ResourceLine[],
  recording: Pick<RecordingSummary, "transactions">,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const median = (v: number[]) =>
    v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : null;
  expected.steps.forEach((s, k) => {
    const from = k === 0 ? 1 : s.applied_frame;
    const to = expected.steps[k + 1]?.applied_frame ?? s.settle_frame + 1;
    const own = lines.filter(
      (l) =>
        l.kind === "mesh" &&
        l.frame >= from &&
        l.frame < to &&
        l.omitted !== true,
    );
    const copy = own
      .map((l) => l.copy_ns)
      .filter((v): v is number => v !== null && v >= 0);
    const hash = own
      .map((l) => l.hash_ns)
      .filter((v): v is number => v !== null && v >= 0);
    const t = recording.transactions.find(
      (x) => x.meta.frame === s.settle_frame,
    );
    const live = (t?.meta.meshes ?? []).filter((m) => m.status === "ok");
    out[String(s.step)] = {
      frames: `${from}-${to - 1}`,
      mesh_lines: own.length,
      payloads_made: own.filter((l) => l.hash !== null).length,
      copy_ns_median: median(copy),
      hash_ns_median: median(hash),
      live_surface_bytes: live.reduce(
        (n, m) => n + m.surfaces.reduce((a, x) => a + x.payload_bytes, 0),
        0,
      ),
    };
  });
  return out;
}

export async function runGate5e(
  outDir: string,
  expected: Gate5MeshExpected,
  ctx: { receiverProjectDir?: string; fixtureProjectDir?: string } = {},
): Promise<Gate5eResult> {
  const meshDir = join(outDir, G5C_LEG_DIR);
  const e5 = asGate5(expected);
  const rasters = meshRasters(expected);
  const checks: Gate5Check[] = [];
  const legs: Gate5eResult["legs"] = {};
  const capture = await evaluateCapture(meshDir, { expectedClass: "success" });
  const inline = await evaluateCapture(meshDir, {
    legDir: "capture-inline",
    expectedClass: "success",
  });
  const log = await loadResourceLog(join(meshDir, "capture"));
  const inlineLog = await loadResourceLog(join(meshDir, "capture-inline"));
  const ids = meshIdsByName(expected, log.lines);
  const names = new Map([...ids].map(([n, id]) => [id, n]));
  const reference = await loadShots5(meshDir, "reference", e5);
  const referenceDir = join(meshDir, "reference");

  // The wire against the hook log and the model.
  const versions = [
    ...meshLogDivergence(log.lines, capture.full, { hashes: true }).map(
      (p) => `full: ${p}`,
    ),
    ...meshLogDivergence(log.lines, capture.patch, { hashes: true }).map(
      (p) => `patch: ${p}`,
    ),
    ...meshLogDivergence(inlineLog.lines, inline.full, { hashes: true }).map(
      (p) => `inline: ${p}`,
    ),
  ];
  const parity = evaluateWireHashParity(expected, ids, [
    { label: "full", recording: capture.full },
    { label: "patch", recording: capture.patch },
    { label: "inline", recording: inline.full },
  ]);
  const census = evaluateWireMeshCensus(
    expected,
    ids,
    capture.full,
    capture.patch,
  );
  const freshWire = evaluateWireFreshWithoutRedraw(
    expected,
    ids,
    capture.full,
    G5E_CAPTURE_QUIT_FRAME,
  );
  const store = await evaluateMeshStore(join(meshDir, "capture", "store"), [
    capture.full,
    capture.patch,
  ]);
  const inlineStoreAbsent = !(await fileExists(
    join(meshDir, "capture-inline", "store", "index.jsonl"),
  ));
  const inlineSession = inline.full.session?.resources as
    | { delivery?: string }
    | undefined;
  checks.push(
    check(
      "mesh-versions-current",
      "at every transaction of both sinks of capture-mesh and of capture-inline, each mesh entry's id, version, status and surface hashes equal the hook log's state at the end of its frame (D15: one wire version per frame, DF's three calls a frame included), and every mesh the log holds live is on the wire",
      versions.slice(0, 8),
      `${capture.full.transactions.length + capture.patch.transactions.length + inline.full.transactions.length} transactions agree with the hook log`,
      [log.path, capture.full.path, capture.patch.path, inline.full.path],
    ),
    check(
      "mesh-hash-parity",
      "at every settle step, on both sinks and the inline capture, each mesh the reference's oracle reads back live is the wire entry of its hook-log id carrying exactly the oracle's GRM1 surface hashes in order (one wire surface per oracle surface; the id never changes over the mesh's life); freed and absent meshes are tombstones or absent",
      parity.problems,
      `${parity.compared} surface-steps equal the GPU readback`,
      [capture.full.path, capture.patch.path, inline.full.path],
    ),
    check(
      "mesh-census-wire",
      "per frame the wire mesh table holds exactly predictions[mesh-lifetimes] by hook-log id: DF's id leaves and DF2's arrives in the step-5 transaction, FM is a named freed tombstone from frame 71 to 80 and gone at 81, the patch sink removes each id the frame it leaves",
      census.problems,
      Object.entries(census.table)
        .map(([f, v]) => `${f}:{${v}}`)
        .join(" "),
      [capture.full.path, capture.patch.path],
    ),
    check(
      "fresh-without-redraw-wire",
      "on the wire RM's item keeps one content_version over the whole 400-frame run while RMS's version (and surface hash) changes exactly on the census's RMS frames: the pixels change with no redraw",
      freshWire.problems,
      `RMS changes at frames ${freshWire.frames.join(",")}; RM's content_version constant`,
      [capture.full.path],
    ),
    check(
      "store-complete-mesh",
      "capture-mesh's store holds every ok mesh surface hash of either sink as sha256/<hash>.grm (and every ok image as .grt), each hashing to its name with its index.jsonl line typed mesh-surface / texture-2d, and nothing else; capture-inline has no store and declares inline delivery",
      [
        ...store.problems,
        ...(inlineStoreAbsent ? [] : ["capture-inline wrote a store"]),
        ...(inlineSession?.delivery === "inline"
          ? []
          : [`capture-inline delivery ${inlineSession?.delivery}`]),
      ],
      `${store.meshes} mesh payloads (${store.mesh_bytes} bytes) and ${store.textures} textures stored`,
      [join(meshDir, "capture", "store", "index.jsonl")],
    ),
  );
  for (const [leg, c] of [["capture-mesh-inline", inline]] as const) {
    const problems =
      c.result_class === "success"
        ? []
        : [`class ${c.result_class}: ${c.reasons.slice(0, 2).join(" | ")}`];
    checks.push(
      check(
        `leg-class-${leg}`,
        "the inline capture (every payload a resource record before its first transaction, no store) classifies as success: armed, stream closed, both sinks valid and equivalent",
        problems,
        c.result_class,
        c.artifacts,
      ),
    );
    legs[leg] = {
      group: "g5e",
      expected_class: "success",
      result_class: c.result_class,
      reasons: c.reasons,
      harmless_ties: c.harmless_ties,
      exit_code: c.exit_code,
      artifacts: c.artifacts,
    };
  }

  // Honest receivers.
  const vsRefProblems: string[] = [];
  const receiverBudgets: Record<string, RegionBudget5[]> = {};
  const uploads: Gate5eResult["report"]["uploads"] = {};
  const fetches: Gate5eResult["report"]["fetches"] = {};
  const uploadProblems: string[] = [];
  const quietProblems: string[] = [];
  let freshReceiverProblems: string[] = [];
  let freshReceiverTable: Record<string, string[]> = {};
  for (const r of G5E_RECEIVER_LEGS) {
    const dir = join(meshDir, r.dir);
    const cap = r.capture === "capture" ? capture : inline;
    const recording = r.sink === RECORDING_NAME ? cap.full : cap.patch;
    const hookLines = r.capture === "capture" ? log.lines : inlineLog.lines;
    const seqs = settleSeqs(e5, recording);
    const shots = await loadReceiverShots5(dir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
      referenceDir,
      reference,
      dir,
      shots,
      seqs,
    );
    const applied = await readJson<AppliedJson5e>(join(dir, "applied.json"));
    const base = classifyLeg({
      captureResult: cap.captureResult,
      recording,
      receiver: {
        applied,
        requestedShotSeqs: [...seqs.values()],
        shotFiles: await shotSeqsPresent5(dir),
      },
      checkpoints: cps as Checkpoint[],
    });
    const cls = classifyMeshLeg(
      base,
      meshLogDivergence(hookLines, recording, { hashes: false }),
    );
    const lc = evaluateLegClass5(cls, cps, { class: "success" });
    checks.push(
      check(
        `leg-class-${r.leg}`,
        `the ${r.leg} leg (rendered receiver on ${r.capture}/${r.sink}) classifies as success: no mesh-log-divergence, applied every seq, every region of every settle shot equal to the reference`,
        lc.problems,
        cls.result_class,
        [join(dir, "applied.json")],
      ),
    );
    legs[r.leg] = legEntry(cls, "success", await readExitCode(dir), [
      join(dir, "applied.json"),
    ]);
    const cmp = compareLegs5(e5, reference, shots, rasters, [
      "reference-mesh",
      r.leg,
    ]);
    vsRefProblems.push(...cmp.problems.map((p) => `${r.leg}: ${p}`));
    receiverBudgets[r.leg] = cmp.budgets.filter((b) => b.mismatched_pixels > 0);
    const up = evaluateReceiverMeshUploads(
      expected,
      ids,
      applied,
      G5E_CAPTURE_QUIT_FRAME,
    );
    uploadProblems.push(...up.problems.map((p) => `${r.leg}: ${p}`));
    uploads[r.leg] = { rows: up.rows, bytes: up.bytes, by_op: up.by_op };
    const quiet = evaluateMeshResourceQuiet(
      expected,
      names,
      recording,
      applied,
      G5E_CAPTURE_QUIT_FRAME,
    );
    quietProblems.push(...quiet.problems.map((p) => `${r.leg}: ${p}`));
    fetches[r.leg] = {
      fetched: quiet.fetched,
      fetched_bytes: quiet.fetched_bytes,
    };
    if (r.leg === "receiver-mesh") {
      const fr = evaluateFreshness5(e5, r.leg, shots);
      freshReceiverProblems = [...fr.problems];
      freshReceiverTable = fr.table;
      for (const k of [2, 3, 4])
        if (!fr.table[String(k)]?.includes("RM"))
          freshReceiverProblems.push(
            `step ${k}: RM's receiver pixels did not change`,
          );
    }
    if (r.leg === "receiver-mesh-inline" && (fetches[r.leg]?.fetched ?? 0) > 0)
      quietProblems.push(
        `receiver-mesh-inline fetched ${fetches[r.leg].fetched} mesh payloads (all are inline)`,
      );
  }
  // receiver-mesh-patch's state dumps.
  const dumpProblems: string[] = [];
  {
    const dir = join(meshDir, "receiver-patch");
    for (const s of expected.steps) {
      const t = capture.patch.transactions.find(
        (x) => x.meta.frame === s.settle_frame,
      );
      if (!t) continue;
      const dump = await readJson<unknown>(
        join(dir, "state", `seq-${t.meta.seq}.json`),
      );
      if (!dump) dumpProblems.push(`state/seq-${t.meta.seq}.json missing`);
      else if (!statesEqual(dump, resolvedStateOf(t.meta)))
        dumpProblems.push(
          `step ${s.step}: state/seq-${t.meta.seq}.json differs from the recording's resolved state`,
        );
      else if (!Array.isArray((dump as { meshes?: unknown }).meshes))
        dumpProblems.push(`step ${s.step}: state dump has no meshes`);
    }
  }
  checks.push(
    check(
      "receiver-vs-reference-mesh",
      "receiver-mesh, receiver-mesh-patch and receiver-mesh-inline: every pixel of every settle shot equals reference-mesh's, DF's band region included (budget 0, as reference-mesh-repeat measured)",
      vsRefProblems,
      `${expected.steps.length * G5E_RECEIVER_LEGS.length} receiver shots identical to the reference`,
      G5E_RECEIVER_LEGS.map((r) => join(meshDir, r.dir, "shots")),
    ),
    check(
      "receiver-mesh-uploads",
      "each honest receiver's applied.json mesh_uploads equal predictions[receiver-mesh-uploads] frame by frame over the 400-frame run: creates at frame 1 (DF2 at 51), in-place updates of exactly the changed buffers at 1-4's frames (AM1 vertex 11; RMS vertex 21, attribute 31, index 41) and every DF frame, rebuilds where the layout changes (M2 61, P2 71, AM1 81), custom AABBs, frees (DF 51, FM 71), bytes included",
      uploadProblems.slice(0, 10),
      Object.entries(uploads)
        .map(
          ([leg, u]) =>
            `${leg} ${u.rows} rows/${u.bytes} B (${Object.entries(u.by_op)
              .map(([o, n]) => `${o} ${n}`)
              .join(", ")})`,
        )
        .join("; "),
      G5E_RECEIVER_LEGS.map((r) => join(meshDir, r.dir, "applied.json")),
    ),
    check(
      "resource-quiet-mesh",
      "no receiver fetches a mesh payload twice or outside its mesh's census frames (DF and DF2 excepted, they change every frame): each fetched GRM1 hash first appears on the wire at that transaction's frame; the inline receiver fetches none",
      quietProblems.slice(0, 8),
      Object.entries(fetches)
        .map(([leg, x]) => `${leg} ${x.fetched} fetched (${x.fetched_bytes} B)`)
        .join("; "),
      G5E_RECEIVER_LEGS.map((r) => join(meshDir, r.dir, "applied.json")),
    ),
    check(
      "fresh-without-redraw-receiver",
      "between consecutive receiver-mesh shots a region changes exactly when expected.json says fresh: RM at steps 2, 3 and 4 through region updates alone, M2 at 6, FR at 7",
      freshReceiverProblems,
      Object.entries(freshReceiverTable)
        .map(([k, r]) => `${k}:${r.join("+")}`)
        .join(" "),
      [join(meshDir, "receiver", "shots")],
    ),
    check(
      "receiver-state-dumps-mesh",
      "receiver-mesh-patch's state dumps at the settle seqs (render-stream-4.md resolved form, meshes included) equal the patch recording's resolved state",
      dumpProblems,
      `${expected.steps.length} dumps equal, meshes included`,
      [join(meshDir, "receiver-patch", "state")],
    ),
  );

  // Sabotages.
  const sabotageRegions: Record<string, Record<string, string>> = {};
  const legClass = (
    leg: string,
    cls: Classification,
    cps: Checkpoint[],
    exp: Gate5LegExpectation,
    artifacts: string[],
  ) => {
    const r = evaluateLegClass5(cls, cps, exp);
    sabotageRegions[leg] = r.table;
    checks.push(
      check(
        `leg-class-${leg}`,
        `the ${leg} leg classifies as ${exp.class}${exp.regions ? ` with mismatching regions exactly ${JSON.stringify(exp.regions)}` : ` with mismatching steps exactly {${(exp.steps ?? []).join(",")}}`}`,
        r.problems,
        `${cls.result_class}; mismatching regions per step ${Object.entries(
          r.table,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
        artifacts,
      ),
    );
  };
  const signatureProblems: string[] = [];
  const signatureDetails: string[] = [];
  for (const kind of G5E_SABOTAGE_CAPTURE_KINDS) {
    const leg = `sabotage-mesh-${kind}`;
    const captureDir = join(meshDir, leg, "capture");
    const receiverDir = join(meshDir, leg, "receiver");
    const result = await readJson<CaptureResultJson>(
      join(captureDir, "evidence", "result.json"),
    );
    const full = await loadRecording(join(captureDir, RECORDING_NAME));
    const seqs = settleSeqs(e5, full);
    const shots = await loadReceiverShots5(receiverDir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
      referenceDir,
      reference,
      receiverDir,
      shots,
      seqs,
    );
    const cls = classifyLeg({
      captureResult: result,
      recording: full,
      receiver: {
        applied: await readJson<AppliedJson>(join(receiverDir, "applied.json")),
        requestedShotSeqs: [...seqs.values()],
        shotFiles: await shotSeqsPresent5(receiverDir),
      },
      checkpoints: cps as Checkpoint[],
    });
    const pred = expected.predictions[leg] as
      | { frame?: number; steps?: number[]; regions?: Record<string, number[]> }
      | undefined;
    const exp: Gate5LegExpectation = pred?.regions
      ? { class: "pixel-mismatch", regions: pred.regions }
      : { class: "pixel-mismatch", steps: pred?.steps ?? [] };
    legClass(leg, cls, cps as Checkpoint[], exp, [
      join(captureDir, RECORDING_NAME),
      join(receiverDir, "applied.json"),
    ]);
    legs[leg] = legEntry(
      cls,
      "pixel-mismatch",
      await readExitCode(receiverDir),
      [join(captureDir, RECORDING_NAME), join(receiverDir, "applied.json")],
    );
    const sabLog = await loadResourceLog(captureDir);
    const sig = evaluateSabotageLogSignature(
      kind,
      pred?.frame ?? 21,
      sabLog.lines,
      full,
    );
    signatureProblems.push(...sig.problems.map((p) => `${leg}: ${p}`));
    signatureDetails.push(`${leg}: ${sig.detail}`);
  }
  checks.push(
    check(
      "sabotage-mesh-log-signature",
      "each host sabotage leaves its own signature against the hook log: omit-op's wire equals the log (omitted lines excluded); perturb-vertex keeps ids and versions and re-hashes exactly the surface payloads taken from its frame on; freeze-frame republishes the log's frame-10 mesh table from frame 11 on",
      signatureProblems.slice(0, 8),
      signatureDetails.join("; "),
      G5E_SABOTAGE_CAPTURE_KINDS.map((k) =>
        join(
          meshDir,
          `sabotage-mesh-${k}`,
          "capture",
          "evidence",
          "resources.jsonl",
        ),
      ),
    ),
  );
  for (const kind of G5E_SABOTAGE_RECEIVER_KINDS) {
    const leg = `sabotage-mesh-receiver-${kind}`;
    const dir = join(meshDir, leg);
    const seqs = settleSeqs(e5, capture.full);
    const shots = await loadReceiverShots5(dir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
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
        requestedShotSeqs: [...seqs.values()],
        shotFiles: await shotSeqsPresent5(dir),
      },
      checkpoints: cps as Checkpoint[],
    });
    const pred = expected.predictions[leg] as
      | { regions?: Record<string, number[]> }
      | undefined;
    legClass(
      leg,
      cls,
      cps as Checkpoint[],
      { class: "pixel-mismatch", regions: pred?.regions ?? {} },
      [join(dir, "applied.json")],
    );
    legs[leg] = legEntry(cls, "pixel-mismatch", await readExitCode(dir), [
      join(dir, "applied.json"),
    ]);
  }

  // Receiver hygiene.
  const receiverDirs = [
    ...G5E_RECEIVER_LEGS.map((r) => r.dir),
    "receiver-headless-trace",
    ...G5E_SABOTAGE_CAPTURE_KINDS.map((k) => `sabotage-mesh-${k}/receiver`),
    ...G5E_SABOTAGE_RECEIVER_KINDS.map((k) => `sabotage-mesh-receiver-${k}`),
  ];
  const bad = /SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  const typedProblems: string[] = [];
  for (const d of receiverDirs) {
    const text = await readTextOrUndefined(join(meshDir, d, "stdout.log"));
    if (text === undefined) {
      typedProblems.push(`${d}/stdout.log missing`);
      continue;
    }
    const line = text.split("\n").find((l) => bad.test(l));
    if (line) typedProblems.push(`${d}: ${line.trim()}`);
  }
  checks.push(
    check(
      "receiver-typed-clean-mesh",
      "no g5e receiver leg's stdout.log has a SCRIPT ERROR, SCRIPT WARNING, Parse Error or Failed to load script line",
      typedProblems,
      `${receiverDirs.length} receiver logs clean`,
      receiverDirs.map((d) => join(meshDir, d, "stdout.log")),
    ),
  );
  const never = await checkReceiverNeverLoadedFixture(meshDir, {
    receiverProjectDir: ctx.receiverProjectDir ?? "",
    fixtureProjectDir: ctx.fixtureProjectDir ?? "",
    receiverLogs: receiverDirs.map((d) => join(meshDir, d, "stdout.log")),
  });
  checks.push({
    ...never,
    id: "receiver-never-loaded-fixture-mesh",
    status: never.passed ? "pass" : "fail",
  } as Gate5Check);
  const importCode = await readExitCode(join(meshDir, "import", "receiver"));
  checks.push(
    check(
      "mesh-receiver-support-legs-exit",
      "the g5e receiver import and receiver-headless-trace legs exited 0",
      [
        ...(importCode === 0 ? [] : [`import/receiver exit ${importCode}`]),
        ...((await readExitCode(join(meshDir, "receiver-headless-trace"))) === 0
          ? []
          : ["receiver-headless-trace exit nonzero"]),
      ],
      "2 support legs exited 0",
      [],
    ),
  );

  return {
    checks,
    legs,
    report: {
      wire_census: census.table,
      hash_parity_surfaces: parity.compared,
      store: {
        mesh_payloads: store.meshes,
        texture_payloads: store.textures,
        mesh_bytes: store.mesh_bytes,
      },
      uploads,
      fetches,
      receiver_budgets: receiverBudgets,
      sabotage_regions: sabotageRegions,
      per_step: meshCostsPerStep(expected, log.lines, capture.full),
    },
  };
}
