// Gate 8 g8re's checks (LS3, live-swap-design.md Q3 "Proving nothing left behind"): the capture's
// re-arm, judged on run-gate8.sh run_g8re's legs (under g8re/):
//
//   rearm-equivalence-adopt  fixtures/gate8-adopt: run B (`adopt/rearm`) arms at K1, serves a live
//   rearm-equivalence-tex    viewer in arm 1, disarms through GRC_SWAP_CYCLE, idles while the
//                            fixture changes, re-arms at K2 on the same port; run A (`adopt/once`)
//                            arms once at K2. B's arm-2 recording equals A's from K2 on, frame by
//                            frame, under gate8-design D15's exceptions only: ids, versions and
//                            content_version (an id bijection per container in draw order),
//                            origin, draw-index values, and the draw-derived state of items not
//                            visible in tree (g8a's canonicalState/compareStates). Both captures
//                            adopt, so the comparison is symmetric: no residue, no resource
//                            exception (a creation copy or a refused texture must be the same in
//                            both), the unsupported and failure lists equal as they are, and the
//                            texture and mesh tables equal by content (ids, versions and origin
//                            aside). Every recording validates; both adoptions are dated K2; arm 1
//                            had one live connection that received transactions; arm 2 listened on
//                            arm 1's port; arm 1 covers at least one of the fixture's steps and at
//                            least one more happened while disarmed. `tex` is fixtures/gate8-tex
//                            with GRC_HEADLESS_TEXTURE_RELEASE unset: its non-VRAM cell (the
//                            lossless `control` column) and the host-decoded VRAM cells.
//   id-rearm-instance-stable `id/`: fixtures/tag-scene's V2 host through two swap cycles, a /14
//                            viewer asking the v2 fields in each arm. One instance_id per node
//                            across the fixture's dumps (both arms), each arm's viewer rows carry
//                            it (rows joined to RIDs through that arm's lines of the capture's id
//                            log), and a node held by both arms' viewers has the same id in both.
//   id-rearm-disarm          `id/`: while each arm is armed every Control it resolved has >= 1
//                            custom callable on property_list_changed (the fixture's own count);
//                            after each disarm no Control keeps one; each arm's item-meta.json has
//                            v2_watched_after_off 0 and each arm's teardown.json item_meta
//                            filter_watches 0 and host_held 0.
//
// The pure halves (rearmCompare, stepSchedule, cyclePhases, instanceRound, disarmRound) are
// exported for test/self-test-gate8-rearm.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalState,
  check,
  compareStates,
  equivalence,
  type G8aCheck,
  stateAt,
} from "./gate8-adopt-checks";
import {
  census1x1,
  type EvictEvidence,
  type HtrStats,
  imageTextureProbe,
  noImageTextureReleaseProblems,
  type ReloadShape,
  type TextureEvent,
} from "./gate8-htr-checks";

export {
  imageTextureProbe,
  type ReloadShape,
  type TextureEvent,
} from "./gate8-htr-checks";

import {
  type Dump,
  dumpOf,
  fromDump,
  ID_REQUEST,
  type IdLine,
  type OracleLine,
} from "./gate8-id14-checks";
import {
  decodeRecording,
  type ResolvedRecording,
  type ResolvedTransaction,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

type State = ResolvedTransaction["state"];

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function jsonlOf<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

const eq = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------------- rearm-equivalence

/** A state's texture and mesh tables by content: every field but id, origin and version (D15's
 * exceptions; a canvas texture's member ids are ids too), sorted. */
export function resourceKeys(s: State): string[] {
  const tex = s.textures.map((t) => {
    const {
      id: _id,
      origin: _o,
      version: _v,
      canvas,
      ...rest
    } = t as unknown as Record<string, unknown>;
    return `texture ${JSON.stringify({ ...rest, canvas: canvas === null || canvas === undefined ? null : "canvas" })}`;
  });
  const meshes = (s.meshes ?? []).map((m) => {
    const {
      id: _id,
      origin: _o,
      version: _v,
      ...rest
    } = m as unknown as Record<string, unknown>;
    return `mesh ${JSON.stringify(rest)}`;
  });
  return [...tex, ...meshes].sort();
}

const unsupportedKeys = (s: State): string[] =>
  s.unsupported.map((u) => `${u.op}|${u.reason}`).sort();
const failureKeys = (s: State): string[] =>
  s.failures.map((f) => f.reason).sort();

/** B's arm 2 (`rearm`) against A (`once`), every frame from `fromFrame` (K2) to the last both
 * cover: g8a's canonical comparison with D15's exceptions and no others (no residue, no resource
 * exception), the unsupported and failure lists, the resource tables by content, and the frames
 * each published a transaction at. */
export function rearmCompare(
  once: ResolvedRecording,
  rearm: ResolvedRecording,
  fromFrame: number,
): { problems: string[]; frames: number; transactions: number } {
  const problems: string[] = [];
  const framesOf = (r: ResolvedRecording) =>
    r.transactions.map((t) => t.frame).filter((f) => f >= fromFrame);
  const fa = framesOf(once);
  const fb = framesOf(rearm);
  if (!eq(fa, fb))
    problems.push(
      `transaction frames differ: once ${fa.length} (${fa[0]}..${fa.at(-1)}), rearm ${fb.length} (${fb[0]}..${fb.at(-1)})`,
    );
  if (once.transactions[0]?.frame !== fromFrame)
    problems.push(
      `once: first transaction at frame ${once.transactions[0]?.frame}, expected K2 ${fromFrame}`,
    );
  if (rearm.transactions[0]?.frame !== fromFrame)
    problems.push(
      `rearm arm 2: first transaction at frame ${rearm.transactions[0]?.frame}, expected K2 ${fromFrame}`,
    );
  const last = Math.min(
    once.transactions.at(-1)?.frame ?? 0,
    rearm.transactions.at(-1)?.frame ?? 0,
  );
  let frames = 0;
  for (let f = fromFrame; f <= last; f++) {
    const a = stateAt(once, f);
    const b = stateAt(rearm, f);
    if (!a || !b) {
      problems.push(
        `frame ${f}: ${!a ? "once" : "rearm"} has no transaction yet`,
      );
      continue;
    }
    frames++;
    const r = compareStates(canonicalState(a.state), canonicalState(b.state));
    for (const p of r.problems) problems.push(`frame ${f}: ${p}`);
    if (r.residue !== 0)
      problems.push(`frame ${f}: ${r.residue} item(s) only in once`);
    if (!eq(unsupportedKeys(a.state), unsupportedKeys(b.state)))
      problems.push(
        `frame ${f}: unsupported ${unsupportedKeys(a.state).join(",")} vs ${unsupportedKeys(b.state).join(",")}`,
      );
    if (!eq(failureKeys(a.state), failureKeys(b.state)))
      problems.push(
        `frame ${f}: failures ${failureKeys(a.state).join(",")} vs ${failureKeys(b.state).join(",")}`,
      );
    const ka = resourceKeys(a.state);
    const kb = resourceKeys(b.state);
    if (!eq(ka, kb)) {
      const onlyA = ka.filter((k) => !kb.includes(k));
      const onlyB = kb.filter((k) => !ka.includes(k));
      problems.push(
        `frame ${f}: resources differ: once-only ${onlyA.join(" ; ").slice(0, 200)} | rearm-only ${onlyB.join(" ; ").slice(0, 200)}`,
      );
    }
  }
  if (frames === 0) problems.push("no frame compared");
  return { problems, frames, transactions: fb.length };
}

export interface StepLine {
  step: number;
  applied_frame: number;
  settle_frame?: number;
}

/** Where the fixture's steps fell: inside arm 1 [arm1First, arm1Last], in the disarmed gap
 * (arm1Last, k2), inside arm 2 [k2, ...]. Arm 1 must cover a step and the gap another. */
export function stepSchedule(
  steps: StepLine[],
  arm1First: number,
  arm1Last: number,
  k2: number,
): { problems: string[]; arm1: number[]; gap: number[]; arm2: number[] } {
  const arm1: number[] = [];
  const gap: number[] = [];
  const arm2: number[] = [];
  for (const s of steps) {
    const f = s.applied_frame;
    if (f >= arm1First && f <= arm1Last) arm1.push(f);
    else if (f > arm1Last && f < k2) gap.push(f);
    else if (f >= k2) arm2.push(f);
  }
  const problems: string[] = [];
  if (arm1.length === 0)
    problems.push(
      `no fixture step inside arm 1 (frames ${arm1First}..${arm1Last})`,
    );
  if (gap.length === 0)
    problems.push(
      `no fixture step while disarmed (frames ${arm1Last + 1}..${k2 - 1})`,
    );
  return { problems, arm1, gap, arm2 };
}

interface LoadedRecording {
  bytes?: Uint8Array;
  rec?: ResolvedRecording;
  adoption?: { mode: string; frame: number } | null;
  error?: string;
}

function loadRec(path: string, version: 8 | 11 = 8): LoadedRecording {
  if (!existsSync(path)) return { error: `${path} missing` };
  const bytes = new Uint8Array(readFileSync(path));
  if (wireVersionOf(bytes) !== version)
    return { bytes, error: `${path} is not GRS${version}` };
  const errors = validateRecording(bytes, version);
  if (errors.length > 0)
    return {
      bytes,
      error: `${path}: invalid /${version} recording: ${errors[0]}`,
    };
  try {
    const decoded = decodeRecording(bytes, version) as unknown as {
      records: { meta: Record<string, unknown> }[];
    };
    return {
      bytes,
      rec: resolveRecording(bytes, version),
      adoption: decoded.records[0]?.meta
        .adoption as LoadedRecording["adoption"],
    };
  } catch (e) {
    return { bytes, error: `${path}: ${(e as Error).message}` };
  }
}

interface LiveConnection {
  stream_id: string | null;
  transactions: number;
  sent: number;
}

/** Draw commands at `s` naming a texture, split by whether the texture is a host-decoded VRAM
 * one (source_format set) or not. */
function drawsByClass(s: State): { vram: number; plain: number } {
  const vramIds = new Set(
    s.textures
      .filter((t) => (t as { source_format?: string | null }).source_format)
      .map((t) => t.id),
  );
  let vram = 0;
  let plain = 0;
  for (const it of s.items)
    for (const c of it.commands) {
      const tex = (c as { tex?: unknown }).tex;
      if (typeof tex !== "number") continue;
      if (vramIds.has(tex)) vram++;
      else plain++;
    }
  return { vram, plain };
}

function rearmEquivalence(
  g: string,
  fx: "adopt" | "tex" | "tex-htr" | "tex-evict",
): { check: G8aCheck; report: Record<string, unknown> } {
  const b = join(g, fx, "rearm");
  const a = join(g, fx, "once");
  const report: Record<string, unknown> = {};
  const id = `rearm-equivalence-${fx}`;
  const criterion =
    fx === "adopt"
      ? "LS3 rearm-equivalence on fixtures/gate8-adopt: run B (armed at K1, a live viewer in arm 1, disarmed by GRC_SWAP_CYCLE, re-armed at K2 on the same port after the fixture changed while disarmed) and run A (armed once at K2) validate; both adoptions are dated K2; B's arm-2 state equals A's at every frame from K2 under D15's exceptions only (ids, versions, origin; draw-index values and hidden items' draw-derived state as g8a), with no residue, no resource exception, equal unsupported and failure lists and equal texture and mesh tables by content; arm 1 had one connection that received transactions; arm 2 listened on arm 1's port; arm 1 covers a fixture step and another happened while disarmed"
      : fx === "tex-evict"
        ? "The /11 HTR pair with GRC_HEADLESS_TEXTURE_RELEASE=always is equivalent under D15, and run B evicts before K2"
        : fx === "tex-htr"
          ? "The /11 HTR pair is equivalent under D15, and run B evicts before K2"
          : "LS3 rearm-equivalence on fixtures/gate8-tex (GRC_HEADLESS_TEXTURE_RELEASE unset: the lossless `control` cells and the host-decoded VRAM cells; every step-1 texture created while disarmed): as rearm-equivalence-adopt";
  if (
    !existsSync(join(b, "exit-code.txt")) ||
    !existsSync(join(a, "exit-code.txt"))
  ) {
    const why = existsSync(join(a, "no-k2.txt"))
      ? readFileSync(join(a, "no-k2.txt"), "utf8").trim()
      : `${fx}/rearm or ${fx}/once did not run`;
    return {
      check: {
        ...check(id, criterion, null),
        detail: `evidence missing: ${why}`,
      },
      report,
    };
  }
  const problems: string[] = [];
  for (const d of [b, a]) {
    const code = readFileSync(join(d, "exit-code.txt"), "utf8").trim();
    if (code !== "0") problems.push(`${d.slice(g.length + 1)} exit ${code}`);
  }
  const version = fx === "tex-htr" || fx === "tex-evict" ? 11 : 8;
  const arm1 = loadRec(join(b, "recording.rs8"), version);
  const arm2 = loadRec(join(b, "recording.rs8.arm-2"), version);
  const once = loadRec(join(a, "recording.rs8"), version);
  for (const [name, r] of [
    ["rearm arm 1", arm1],
    ["rearm arm 2", arm2],
    ["once", once],
  ] as const)
    if (r.error) problems.push(`${name}: ${r.error}`);
  const k2File = join(b, "k2.txt");
  const k2 = existsSync(k2File)
    ? Number(readFileSync(k2File, "utf8").trim())
    : NaN;
  if (!Number.isFinite(k2)) problems.push("no K2 (rearm/k2.txt)");
  report.k2 = k2;
  // both adoptions dated K2
  for (const [name, r] of [
    ["rearm arm 2", arm2],
    ["once", once],
  ] as const)
    if (r.rec && (r.adoption?.mode !== "arm" || r.adoption.frame !== k2))
      problems.push(
        `${name}: session adoption ${JSON.stringify(r.adoption)}, expected {"mode":"arm","frame":${k2}}`,
      );
  // the live viewer in arm 1, and arm 2 on the same port
  const port = existsSync(join(b, "port.txt"))
    ? Number(readFileSync(join(b, "port.txt"), "utf8").trim())
    : NaN;
  const summary = readJson<{ connections: LiveConnection[] }>(
    join(b, "evidence", "live-summary.json"),
  );
  if (summary === null) problems.push("no arm-1 live-summary.json");
  else {
    const c = summary.connections;
    if (c.length !== 1 || !c[0].stream_id || !(c[0].sent > 0))
      problems.push(
        `arm 1: ${c.length} connection(s) (${JSON.stringify(c.map((x) => ({ stream_id: x.stream_id, transactions: x.transactions, sent: x.sent })))}), expected one that received transactions`,
      );
    report.arm1_connection = c.map((x) => ({
      stream_id: x.stream_id,
      transactions: x.transactions,
      sent: x.sent,
    }));
  }
  const client = readJson<{ transactions: number; end: boolean }>(
    join(b, "client", "null-receiver.json"),
  );
  report.arm1_client = client;
  for (const [name, file] of [
    ["arm 1", join(b, "evidence", "live.json")],
    ["arm 2", join(b, "evidence", "arm-2", "live.json")],
  ] as const) {
    const live = readJson<{ status: string; port: number }>(file);
    if (live?.status !== "listening" || live.port !== port)
      problems.push(
        `${name}: live.json ${JSON.stringify(live && { status: live.status, port: live.port })}, expected listening on ${port}`,
      );
  }
  if (arm1.rec && arm2.rec && once.rec && Number.isFinite(k2)) {
    const t1 = arm1.rec.transactions;
    const steps = jsonlOf<StepLine>(join(b, "steps.jsonl"));
    const sched = stepSchedule(
      steps,
      t1[0]?.frame ?? 0,
      t1.at(-1)?.frame ?? 0,
      k2,
    );
    problems.push(...sched.problems);
    const e = rearmCompare(once.rec, arm2.rec, k2);
    problems.push(...e.problems.slice(0, 20));
    if (fx === "tex-htr" || fx === "tex-evict")
      problems.push(
        ...reloadIdleBeforeArm(
          jsonlOf<TextureEvent>(join(b, "events.jsonl")),
          k2,
        ),
      );
    if (e.problems.length > 20)
      problems.push(`... ${e.problems.length - 20} more`);
    const first = arm2.rec.transactions[0]?.state;
    const adopted = {
      items: first?.items.filter((i) => i.origin === "adopted").length ?? 0,
      canvases:
        first?.canvases.filter((c) => c.origin === "adopted").length ?? 0,
      textures:
        first?.textures.filter((t) => t.origin === "adopted").length ?? 0,
      meshes: (first?.meshes ?? []).filter((m) => m.origin === "adopted")
        .length,
    };
    if (adopted.items === 0)
      problems.push("arm 2 adopted no item: the comparison is vacuous");
    const draws = first ? drawsByClass(first) : { vram: 0, plain: 0 };
    if (draws.plain === 0)
      problems.push("arm 2's first state draws no non-VRAM texture");
    Object.assign(report, {
      arm1: {
        first: t1[0]?.frame,
        last: t1.at(-1)?.frame,
        transactions: t1.length,
      },
      arm2: {
        first: arm2.rec.transactions[0]?.frame,
        last: arm2.rec.transactions.at(-1)?.frame,
        transactions: arm2.rec.transactions.length,
        adopted,
        items: first?.items.length,
        textures: first?.textures.length,
        texture_draws: draws,
      },
      once: {
        first: once.rec.transactions[0]?.frame,
        last: once.rec.transactions.at(-1)?.frame,
        transactions: once.rec.transactions.length,
      },
      steps: { arm1: sched.arm1, disarmed: sched.gap, arm2: sched.arm2 },
      frames_compared: e.frames,
      transactions_compared: e.transactions,
      first_problems: e.problems.slice(0, 20),
    });
  }
  const r = report as {
    arm1?: { first: number; last: number; transactions: number };
    arm2?: {
      transactions: number;
      adopted: Record<string, number>;
      texture_draws: { vram: number; plain: number };
    };
    steps?: { arm1: number[]; disarmed: number[]; arm2: number[] };
    frames_compared?: number;
    transactions_compared?: number;
  };
  return {
    check: check(
      id,
      criterion,
      problems,
      `K2 ${k2}; arm 1 frames ${r.arm1?.first}..${r.arm1?.last} (${r.arm1?.transactions} tx, steps at ${r.steps?.arm1.join(",")}), viewer ${client?.transactions} tx end ${client?.end}; steps while disarmed at ${r.steps?.disarmed.join(",")}; arm 2 adopted ${JSON.stringify(r.arm2?.adopted)} (texture draws ${r.arm2?.texture_draws.plain} non-VRAM, ${r.arm2?.texture_draws.vram} host-decoded VRAM), steps at ${r.steps?.arm2.join(",")}; ${r.frames_compared} frames and ${r.transactions_compared} transactions equal to once's`,
    ),
    report,
  };
}

// ------------------------------------------------------------------------- the re-arm round

export interface CycleLine {
  cycle: number;
  phase: "idle" | "armed";
  arm_index: number;
  start_frame: number;
  end_frame: number;
  process_frame: number;
  item_meta?: {
    host_held: number;
    filter_watches: number;
    calls_while_off: number;
  };
}

export interface CyclePhases {
  /** capture frame = process frame - offset (Engine.get_process_frames() against frames_total). */
  offset: number;
  /** per arm k (index k-1): its first and last capture frames (the disarm is asked at `end`). */
  arms: { start: number; end: number }[];
  /** per disarm k (index k-1): the idle phase after it (`start`: the disarm completed). */
  idles: { start: number; end: number }[];
  problems: string[];
}

/** evidence/swap-cycle.jsonl -> the arms and the idle phases after their disarms, and the offset
 * from the fixture's process frames to the capture's frames. */
export function cyclePhases(lines: CycleLine[], arms: number): CyclePhases {
  const problems: string[] = [];
  const out: CyclePhases = { offset: 0, arms: [], idles: [], problems };
  if (lines.length === 0) {
    problems.push("no swap-cycle.jsonl lines");
    return out;
  }
  const offsets = new Set(lines.map((l) => l.process_frame - l.end_frame));
  if (offsets.size !== 1)
    problems.push(
      `process/capture frame offset varies: ${[...offsets].join(",")}`,
    );
  out.offset = lines[0].process_frame - lines[0].end_frame;
  for (let k = 1; k <= arms; k++) {
    const armed = lines.find((l) => l.phase === "armed" && l.arm_index === k);
    const idle = lines.find((l) => l.phase === "idle" && l.cycle === k);
    if (!armed) problems.push(`no armed phase for arm ${k}`);
    if (!idle) problems.push(`no idle phase after disarm ${k}`);
    if (armed)
      out.arms.push({ start: armed.start_frame, end: armed.end_frame });
    if (idle) out.idles.push({ start: idle.start_frame, end: idle.end_frame });
  }
  return out;
}

/** The id log's lines of arm k: stamped from its first frame up to the next arm's. */
function idsOfArm(ids: IdLine[], ph: CyclePhases, k: number): IdLine[] {
  const from = ph.arms[k - 1]?.start ?? Number.POSITIVE_INFINITY;
  const to = ph.arms[k]?.start ?? Number.POSITIVE_INFINITY;
  return ids.filter((l) => l.stamp >= from && l.stamp < to);
}

/** id-rearm-instance-stable on parsed evidence: `dumps[k-1]` is arm k's viewer dump. */
export function instanceRound(
  oracle: OracleLine[],
  ids: IdLine[],
  ph: CyclePhases,
  dumps: (Dump | null)[],
): { problems: string[]; detail: string } {
  const problems: string[] = [...ph.problems];
  const iid = new Map<string, Set<string>>();
  for (const line of oracle)
    for (const n of line.nodes) {
      if (typeof n.instance_id !== "string") continue;
      const s = iid.get(n.rid) ?? new Set<string>();
      s.add(n.instance_id);
      iid.set(n.rid, s);
    }
  if (iid.size === 0) problems.push("the fixture dumped no instance_id");
  for (const [rid, s] of iid)
    if (s.size !== 1)
      problems.push(
        `rid ${rid}: the fixture dumped ${s.size} instance ids (${[...s].join(",")})`,
      );
  const byArm: Map<string, string>[] = [];
  const rows: number[] = [];
  dumps.forEach((dump, i) => {
    const k = i + 1;
    const seen = new Map<string, string>();
    byArm.push(seen);
    rows.push(0);
    if (dump === null) {
      problems.push(`arm ${k}: no viewer dump`);
      return;
    }
    const ridOf = new Map<number, string>();
    for (const l of idsOfArm(ids, ph, k)) ridOf.set(l.id, l.rid);
    for (const [idText, raw] of Object.entries(dump.seen)) {
      const row = fromDump(raw, ID_REQUEST);
      if (row === null) continue;
      const rid = ridOf.get(Number(idText));
      const want = rid === undefined ? undefined : [...(iid.get(rid) ?? [])][0];
      rows[i]++;
      if (want === undefined || row.instance_id !== want)
        problems.push(
          `arm ${k} row ${idText} (rid ${rid}): instance_id ${row.instance_id}, the fixture ${want}`,
        );
      if (rid !== undefined && typeof row.instance_id === "string") {
        const prev = seen.get(rid);
        if (prev !== undefined && prev !== row.instance_id)
          problems.push(
            `arm ${k} rid ${rid}: rows carry ${prev} and ${row.instance_id}`,
          );
        seen.set(rid, row.instance_id);
      }
    }
    if (rows[i] === 0) problems.push(`arm ${k}: the viewer holds no row`);
  });
  let common = 0;
  if (byArm.length >= 2) {
    for (const [rid, v] of byArm[0]) {
      const w = byArm[1].get(rid);
      if (w === undefined) continue;
      common++;
      if (w !== v)
        problems.push(`rid ${rid}: instance_id ${v} in arm 1, ${w} in arm 2`);
    }
    if (common === 0) problems.push("no node held by both arms' viewers");
  }
  return {
    problems: problems.slice(0, 8),
    detail: `${iid.size} nodes with one instance id each over ${oracle.length} dumps; viewer rows ${rows.map((n, i) => `arm ${i + 1} ${n}`).join(", ")}; ${common} nodes in both arms with the same id`,
  };
}

/** A held Control changes its metadata while detached, then re-enters in each arm. */
export function reentryRound(
  oracle: OracleLine[],
  ids: IdLine[],
  ph: CyclePhases,
  dumps: (Dump | null)[],
  stats: (Record<string, number> | null)[],
): { problems: string[]; detail: string } {
  const problems: string[] = [...ph.problems];
  const parts: string[] = [];
  const rids = new Set<string>();
  for (let k = 1; k <= 2; k++) {
    const arm = ph.arms[k - 1];
    const marker = `rearm-entry-${k}`;
    const node = oracle
      .filter(
        (line) =>
          arm &&
          line.process_frames !== undefined &&
          line.process_frames - ph.offset > arm.start &&
          line.process_frames - ph.offset < arm.end,
      )
      .flatMap((line) => line.nodes)
      .find((n) => n.meta.rs_tag === marker);
    if (!node) {
      problems.push(`arm ${k}: no re-entry oracle marker ${marker}`);
      continue;
    }
    rids.add(node.rid);
    const rows = idsOfArm(ids, ph, k).filter((line) => line.rid === node.rid);
    const last = rows.at(-1);
    const raw = last && dumps[k - 1]?.seen[String(last.id)];
    const row = raw === undefined ? null : fromDump(raw, ID_REQUEST);
    if (
      rows.length < 2 ||
      row?.meta.rs_tag !== marker ||
      row.instance_id !== node.instance_id
    )
      problems.push(
        `arm ${k}: re-entered RID ${node.rid} lacks a refreshed identity with stable instance_id`,
      );
    if (node.plc_custom !== 1)
      problems.push(
        `arm ${k}: re-entered Control has ${node.plc_custom} callables, expected 1`,
      );
    if ((stats[k - 1]?.reentry_rows ?? 0) < 1)
      problems.push(`arm ${k}: no reentry_rows counted`);
    parts.push(
      `arm ${k} RID ${node.rid}, ${rows.length} identity rows, marker ${row?.meta.rs_tag}, instance ${row?.instance_id}, callables ${node.plc_custom}, reentry_rows ${stats[k - 1]?.reentry_rows}`,
    );
  }
  if (rids.size !== 1)
    problems.push(
      `re-entry target has ${rids.size} RIDs across arms, expected 1`,
    );
  return { problems, detail: parts.join("; ") };
}

export interface TeardownItemMeta {
  arm_index?: number;
  item_meta?: {
    host_held: number;
    filter_watches: number;
    calls_while_off?: number;
  };
}

/** id-rearm-disarm on parsed evidence: per arm k (index k-1) its item-meta.json stats and its
 * teardown.json. */
export function disarmRound(
  oracle: OracleLine[],
  ids: IdLine[],
  ph: CyclePhases,
  stats: (Record<string, number> | null)[],
  teardowns: (TeardownItemMeta | null)[],
): { problems: string[]; detail: string } {
  const problems: string[] = [...ph.problems];
  const cf = (l: OracleLine) =>
    l.process_frames === undefined ? Number.NaN : l.process_frames - ph.offset;
  const parts: string[] = [];
  for (let k = 1; k <= ph.arms.length; k++) {
    const arm = ph.arms[k - 1];
    const resolved = new Set(idsOfArm(ids, ph, k).map((l) => l.rid));
    // the last dump well inside arm k, and the last one after its disarm completed
    const armed = oracle
      .filter((l) => cf(l) > arm.start + 1 && cf(l) < arm.end - 1)
      .at(-1);
    const idle = ph.idles[k - 1];
    const nextArm = ph.arms[k]?.start ?? Number.POSITIVE_INFINITY;
    const after =
      idle === undefined
        ? undefined
        : oracle.filter((l) => cf(l) >= idle.start && cf(l) < nextArm).at(-1);
    let controls = 0;
    let callables = 0;
    if (armed === undefined)
      problems.push(`arm ${k}: no fixture dump while armed`);
    else
      for (const n of armed.nodes) {
        if (typeof n.plc_custom !== "number" || !resolved.has(n.rid)) continue;
        controls++;
        callables += n.plc_custom;
        if (n.plc_custom < 1)
          problems.push(
            `arm ${k} (frame ${armed.frame}): ${n.class} ${n.path} has no custom callable on property_list_changed`,
          );
      }
    if (armed !== undefined && controls === 0)
      problems.push(`arm ${k}: no resolved Control in the armed dump`);
    let afterControls = 0;
    let left = 0;
    if (after === undefined)
      problems.push(`disarm ${k}: no fixture dump after it`);
    else
      for (const n of after.nodes) {
        if (typeof n.plc_custom !== "number") continue;
        afterControls++;
        left += n.plc_custom;
        if (n.plc_custom !== 0)
          problems.push(
            `after disarm ${k} (frame ${after.frame}): ${n.class} ${n.path} keeps ${n.plc_custom} custom callables`,
          );
      }
    const st = stats[k - 1];
    if (st === null || st === undefined)
      problems.push(`arm ${k}: no item-meta.json`);
    else if ((st.v2_watched_after_off ?? -1) !== 0)
      problems.push(
        `arm ${k}: item-meta.json v2_watched_after_off ${st.v2_watched_after_off}`,
      );
    const td = teardowns[k - 1];
    if (td === null || td === undefined || td.item_meta === undefined)
      problems.push(`arm ${k}: no teardown.json item_meta`);
    else {
      if (td.arm_index !== undefined && td.arm_index !== k)
        problems.push(`arm ${k}: teardown.json arm_index ${td.arm_index}`);
      if (td.item_meta.filter_watches !== 0)
        problems.push(
          `arm ${k}: teardown.json item_meta.filter_watches ${td.item_meta.filter_watches}`,
        );
      if (td.item_meta.host_held !== 0)
        problems.push(
          `arm ${k}: teardown.json item_meta.host_held ${td.item_meta.host_held}`,
        );
    }
    parts.push(
      `arm ${k} (frames ${arm.start}..${arm.end}): ${callables} callables on ${controls} resolved Controls at dump frame ${armed?.frame}; after disarm ${k} (dump frame ${after?.frame}): ${left} on ${afterControls} Controls; v2_watched_after_off ${st?.v2_watched_after_off}; teardown filter_watches ${td?.item_meta?.filter_watches} host_held ${td?.item_meta?.host_held}`,
    );
  }
  if (ph.arms.length < 2) problems.push(`${ph.arms.length} arm(s), expected 2`);
  return { problems: problems.slice(0, 8), detail: parts.join("; ") };
}

function idRound(g: string): {
  checks: G8aCheck[];
  report: Record<string, unknown>;
} {
  const leg = join(g, "id");
  const host = join(leg, "host");
  const instanceCriterion =
    "LS3/ID3 id-rearm-instance-stable: on fixtures/tag-scene's V2 host through two swap cycles (a /14 viewer asking the v2 fields in each arm), the fixture dumps one instance_id per node across both arms; every row of each arm's viewer carries that node's id (rows joined to RIDs through that arm's lines of the capture's id log); a node held by both arms' viewers has the same id in both; a held Control re-enters in each arm with changed metadata, one refreshed identity and one filter connection";
  const disarmCriterion =
    "LS3/ID3 id-rearm-disarm: while each arm is armed every Control it resolved has >= 1 custom callable on property_list_changed (the fixture's own count); after each disarm no Control keeps one; each arm's item-meta.json (evidence/, evidence/arm-2/) has v2_watched_after_off 0 and each arm's teardown.json item_meta filter_watches 0 and host_held 0";
  if (!existsSync(join(host, "exit-code.txt")))
    return {
      checks: [
        check("id-rearm-instance-stable", instanceCriterion, null),
        check("id-rearm-disarm", disarmCriterion, null),
      ],
      report: {},
    };
  const pre: string[] = [];
  const code = readFileSync(join(host, "exit-code.txt"), "utf8").trim();
  if (code !== "0") pre.push(`id/host exit ${code}`);
  const oracle = jsonlOf<OracleLine>(join(host, "oracle.jsonl"));
  const ids = jsonlOf<IdLine>(join(host, "ids.jsonl"));
  const ph = cyclePhases(
    jsonlOf<CycleLine>(join(host, "evidence", "swap-cycle.jsonl")),
    2,
  );
  const dumps: (Dump | null)[] = [];
  const validates: string[] = [];
  for (const v of ["arm1", "arm2"]) {
    if (!existsSync(join(leg, v, "decoded.rs14"))) {
      const why = existsSync(join(leg, v, "skipped.txt"))
        ? readFileSync(join(leg, v, "skipped.txt"), "utf8").trim()
        : "no decoded.rs14";
      pre.push(`${v}: ${why}`);
      dumps.push(null);
      validates.push("missing");
      continue;
    }
    const { dump, validate } = dumpOf(leg, `${v}/decoded.rs14`, 14, ID_REQUEST);
    if (validate !== "ok") pre.push(`${v}: rs-core-check ${validate}`);
    dumps.push(dump);
    validates.push(validate);
  }
  const inst = instanceRound(oracle, ids, ph, dumps);
  const stats = [
    readJson<Record<string, number>>(join(host, "evidence", "item-meta.json")),
    readJson<Record<string, number>>(
      join(host, "evidence", "arm-2", "item-meta.json"),
    ),
  ];
  const teardowns = [
    readJson<TeardownItemMeta>(join(host, "evidence", "teardown.json")),
    readJson<TeardownItemMeta>(
      join(host, "evidence", "arm-2", "teardown.json"),
    ),
  ];
  const dis = disarmRound(oracle, ids, ph, stats, teardowns);
  const reentry = reentryRound(oracle, ids, ph, dumps, stats);
  return {
    checks: [
      check(
        "id-rearm-instance-stable",
        instanceCriterion,
        [...pre, ...inst.problems, ...reentry.problems],
        `${inst.detail}; ${reentry.detail}; viewers validate ${validates.join(",")}`,
      ),
      check(
        "id-rearm-disarm",
        disarmCriterion,
        [...pre, ...dis.problems],
        dis.detail,
      ),
    ],
    report: {
      phases: { offset: ph.offset, arms: ph.arms, idles: ph.idles },
      instance: inst.detail,
      reentry,
      disarm: dis.detail,
      viewers_validate: validates,
    },
  };
}

export interface TextureReloadEvidence extends ReloadSourceEvidence {
  skipped: string | null;
  candidates: {
    released: number;
    evicted: number;
    residual: number;
    total: number;
  };
  refused: Record<string, number>;
  released_no_path: number;
  temp_outlived: number;
  scope_anomalies: number;
  verify_skipped: number;
  entries: {
    path: string | null;
    adopted: boolean;
    code: string | null;
    record: ReloadShape;
    loaded: ReloadShape | null;
  }[];
}
export interface TextureTeardown {
  reload_sources_held: number;
  htr_restore?: Record<string, number | string>;
}
const refusalKeys = [
  "reload_unsafe",
  "released_no_path",
  "reload_mismatch",
  "reload_failed",
  "evicted_unverifiable",
  "evicted_mid_arm",
  "total",
] as const;
const sameShape = (a: ReloadShape | null, b: ReloadShape): boolean =>
  a !== null &&
  ["format", "width", "height", "mipmaps"].every(
    (key) => a[key as keyof ReloadShape] === b[key as keyof ReloadShape],
  );
const placeholder = (s: ReloadShape | null | undefined): boolean =>
  s?.format === 0 && s.width === 1 && s.height === 1 && s.mipmaps === false;

export function reloadIdleBeforeArm(
  events: TextureEvent[],
  k2: number,
): string[] {
  const f = events.find((e) => e.event === "idle-action")?.frame;
  return f !== undefined && Number.isFinite(f) && f < k2
    ? []
    : ["idle action missing or not before K2"];
}
export function publishedOneByOne(rec: ResolvedRecording): boolean {
  return rec.transactions.some((t) =>
    t.state.textures.some(
      (tex) => tex.kind === "image" && tex.width <= 1 && tex.height <= 1,
    ),
  );
}
export function reloadNo1x1(
  rec: ResolvedRecording | null,
  r: TextureReloadEvidence | null,
): string[] {
  const problems: string[] = [];
  if (!rec || rec.transactions.length === 0) problems.push("missing recording");
  else if (publishedOneByOne(rec)) problems.push("published <=1x1 image");
  if (r?.final !== true) problems.push("missing final reload evidence");
  else
    for (const e of r.entries)
      if (e.adopted && !sameShape(e.loaded, e.record))
        problems.push(`adopted shape mismatch: ${e.path}`);
  return problems;
}
export function reloadCensus(recs: (ResolvedRecording | null)[]): string[] {
  return recs.flatMap((r, k) =>
    !r || r.transactions.length === 0
      ? [`recording ${k} missing`]
      : census1x1(r).transactions === 0
        ? []
        : [`recording ${k} draws a <=1x1 image`],
  );
}
export interface ReloadExpected {
  candidates: TextureReloadEvidence["candidates"];
  reloaded: number;
  adopted_from_reload: number;
}
export function textureEvictExpected(rearm: boolean): ReloadExpected {
  return {
    candidates: {
      released: rearm ? 10 : 8,
      evicted: 3,
      residual: 0,
      total: rearm ? 13 : 11,
    },
    reloaded: rearm ? 13 : 11,
    adopted_from_reload: rearm ? 12 : 10,
  };
}
export function reloadTyped(
  r: TextureReloadEvidence | null,
  rearm: boolean,
  teardowns: (TextureTeardown | null)[],
  expected: ReloadExpected = {
    candidates: {
      released: rearm ? 6 : 0,
      evicted: 7,
      residual: 0,
      total: rearm ? 13 : 7,
    },
    reloaded: rearm ? 13 : 7,
    adopted_from_reload: rearm ? 12 : 6,
  },
): string[] {
  if (!r) return ["missing reload evidence"];
  const problems: string[] = [];
  for (const key of Object.keys(
    expected.candidates,
  ) as (keyof typeof expected.candidates)[])
    if (r.candidates[key] !== expected.candidates[key])
      problems.push(`candidates.${key}`);
  for (const [key, value] of Object.entries({
    reloaded: expected.reloaded,
    adopted_from_reload: expected.adopted_from_reload,
    released_no_path: 0,
    temp_outlived: 0,
    scope_anomalies: 0,
  }))
    if (r[key as keyof TextureReloadEvidence] !== value) problems.push(key);
  if (!r.final) problems.push("not final");
  if (refusalKeys.some((key) => r.refused[key] !== 0)) problems.push("refused");
  if (r.dropped_unreferenced + r.dropped_freed !== 1)
    problems.push("dropped sources");
  if (teardowns.some((t) => t?.reload_sources_held !== 0))
    problems.push("reload_sources_held");
  return problems;
}
export function imageTextureRestored(
  probe: TextureEvent | null,
  td: TextureTeardown | null,
  r: TextureReloadEvidence | null,
): string[] {
  const problems = imageTextureProbe(probe);
  for (const [key, value] of Object.entries({
    candidates: 1,
    restored: 1,
    unavailable: 0,
    mismatch: 0,
    not_placeholder: 0,
  }))
    if (td?.htr_restore?.[key] !== value) problems.push(`htr_restore.${key}`);
  if (r?.released_no_path !== 0) problems.push("released_no_path");
  return problems;
}
export function reloadMismatchTyped(r: TextureReloadEvidence | null): string[] {
  if (!r?.final) return ["missing final reload evidence"];
  const problems: string[] = [];
  for (const key of refusalKeys)
    if (
      r.refused[key] !== (key === "reload_mismatch" || key === "total" ? 1 : 0)
    )
      problems.push(`refused.${key}`);
  const entries = r.entries.filter((e) => e.code === "reload-mismatch");
  if (
    entries.length !== 1 ||
    !entries[0].path?.endsWith("swap.ctex") ||
    entries[0].adopted
  )
    problems.push("missing unadopted swap.ctex mismatch");
  return problems;
}
export function faultReloadOffCaught(
  rec: ResolvedRecording | null,
  r: TextureReloadEvidence | null,
): string[] {
  return rec && publishedOneByOne(rec) && r?.skipped === "fault-reload-off"
    ? []
    : ["reload-off negative test not caught"];
}
export function faultSkipVerifyCaught(
  r: TextureReloadEvidence | null,
): string[] {
  return r &&
    r.verify_skipped >= 1 &&
    r.entries.some(
      (e) =>
        e.path?.endsWith("swap.ctex") &&
        e.adopted &&
        !sameShape(e.loaded, e.record),
    )
    ? []
    : ["reload-skip-verify negative test not caught"];
}
export function faultSkipRestoreCaught(
  probe: TextureEvent | null,
  td: TextureTeardown | null,
  r: TextureReloadEvidence | null,
): string[] {
  return imageTextureProbe(probe).length > 0 &&
    placeholder(probe?.got) &&
    td?.htr_restore?.skipped_fault === 1 &&
    r?.released_no_path === 1
    ? []
    : ["skip-htr-restore negative test not caught"];
}

function textureReloadChecks(g: string): G8aCheck[] {
  const root = g;
  const workerSelected = !existsSync(join(g, "tex-warm", "not-selected.txt"));
  const workers = workerSelected ? ["tex-warm/workers"] : [];
  const evidence = (leg: string, second = true) =>
    join(
      root,
      leg.startsWith("tex-warm/") ? leg : `tex-htr/${leg}`,
      "evidence",
      ...(second ? ["arm-2"] : []),
    );
  const reload = (leg: string, second = true) =>
    readJson<TextureReloadEvidence>(join(evidence(leg, second), "reload.json"));
  const teardown = (leg: string, second = true) =>
    readJson<TextureTeardown>(join(evidence(leg, second), "teardown.json"));
  const teardowns = (leg: string): (TextureTeardown | null)[] => {
    const out: (TextureTeardown | null)[] = [];
    const scan = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) scan(path);
        else if (e.name === "teardown.json")
          out.push(readJson<TextureTeardown>(path));
      }
    };
    scan(evidence(leg, false));
    return out;
  };
  const rec = (leg: string, second = true) =>
    loadRec(
      join(
        root,
        leg.startsWith("tex-warm/") ? leg : `tex-htr/${leg}`,
        `recording.rs8${second ? ".arm-2" : ""}`,
      ),
      11,
    );
  const probe = (leg: string) =>
    jsonlOf<TextureEvent>(
      join(
        root,
        leg.startsWith("tex-warm/") ? leg : `tex-htr/${leg}`,
        "events.jsonl",
      ),
    ).find((e) => e.event === "imagetexture-probe") ?? null;
  const b = rec("rearm"),
    a = rec("once", false),
    first = rec("rearm", false),
    swap = rec("swap");
  const rb = reload("rearm"),
    ra = reload("once", false),
    rs = reload("swap");
  const checks: G8aCheck[] = [];
  const add = (
    id: string,
    legs: string[],
    criterion: string,
    judge: () => string[],
  ) => {
    const absent = legs.some(
      (leg) =>
        !existsSync(
          join(
            root,
            leg.startsWith("tex-warm/") ? leg : `tex-htr/${leg}`,
            "exit-code.txt",
          ),
        ),
    );
    if (absent)
      checks.push({
        id,
        criterion,
        passed: false,
        status: "not-run",
        gating: false,
        detail: "texture reload legs absent",
      });
    else {
      const pre = legs.flatMap((leg) =>
        readFileSync(
          join(
            root,
            leg.startsWith("tex-warm/") ? leg : `tex-htr/${leg}`,
            "exit-code.txt",
          ),
          "utf8",
        ).trim() === "0"
          ? []
          : [`${leg} failed`],
      );
      checks.push(
        check(id, criterion, [...pre, ...judge()], "all predicates hold"),
      );
    }
  };
  add(
    "rearm-no-1x1",
    ["rearm", "once", "swap", ...workers],
    "No published image is <=1x1 and every adopted reload matches its record",
    () => [
      ...reloadNo1x1(b.rec ?? null, rb),
      ...reloadNo1x1(a.rec ?? null, ra),
      ...reloadNo1x1(swap.rec ?? null, rs),
      ...workers.flatMap((leg) =>
        reloadNo1x1(rec(leg).rec ?? null, reload(leg)),
      ),
    ],
  );
  add(
    "htr-census-1x1-rearm",
    ["rearm", "once"],
    "No arm draws a <=1x1 image into a large rectangle",
    () => reloadCensus([first.rec ?? null, b.rec ?? null, a.rec ?? null]),
  );
  add(
    "reload-typed",
    ["rearm", "once", ...workers],
    "Honest reload candidates, outcomes and teardown counts match the fixture",
    () => [
      ...reloadTyped(rb, true, teardowns("rearm")),
      ...reloadTyped(ra, false, teardowns("once")),
      ...workers.flatMap((leg) =>
        reloadTyped(reload(leg), true, teardowns(leg)),
      ),
    ],
  );
  add(
    "htr-imagetexture-restored",
    ["rearm"],
    "The path-less ImageTexture is restored exactly at disarm",
    () => imageTextureRestored(probe("rearm"), teardown("rearm", false), rb),
  );
  add(
    "reload-mismatch-typed",
    ["swap"],
    "A swapped .ctex is refused once with reload-mismatch and never publishes a dummy",
    () => [...reloadMismatchTyped(rs), ...reloadNo1x1(swap.rec ?? null, rs)],
  );
  add(
    "fault-reload-off-caught",
    ["reload-off"],
    "reload-off publishes a dummy and records its skip reason",
    () =>
      faultReloadOffCaught(rec("reload-off").rec ?? null, reload("reload-off")),
  );
  add(
    "fault-reload-skip-verify-caught",
    ["swap-skip-verify"],
    "Skipping verification adopts the swapped .ctex with a mismatched shape",
    () => faultSkipVerifyCaught(reload("swap-skip-verify")),
  );
  add(
    "fault-skip-htr-restore-caught",
    ["skip-htr-restore"],
    "Skipping restore leaves a path-less placeholder and a typed refusal",
    () =>
      faultSkipRestoreCaught(
        probe("skip-htr-restore"),
        teardown("skip-htr-restore", false),
        reload("skip-htr-restore"),
      ),
  );
  return checks;
}

export function evictRearmProblems(
  evict: EvictEvidence | null,
  rearm: boolean,
  reloads: (TextureReloadEvidence | null)[],
): string[] {
  if (!evict) return ["missing evict evidence"];
  const problems: string[] = [];
  for (const [key, value] of Object.entries({
    released: rearm ? 4 : 8,
    noted: 16,
    released_armed: 0,
    pending: 0,
    parked: 0,
    evict_balanced: true,
    final: true,
  }))
    if (evict[key as keyof EvictEvidence] !== value)
      problems.push(`evict.${key}`);
  if (rearm && evict.skipped.already_released !== 6)
    problems.push("evict.skipped.already_released");
  if (reloads.length < (rearm ? 2 : 1)) problems.push("missing reload arms");
  for (const r of reloads)
    if (r?.released_no_path !== 0 || r.refused.released_no_path !== 0)
      problems.push("released_no_path");
  return problems;
}

function textureEvictChecks(g: string): G8aCheck[] {
  const root = join(g, "tex-evict");
  const evidence = (leg: string, arm = 1) =>
    join(root, leg, "evidence", ...(arm === 1 ? [] : [`arm-${arm}`]));
  const reload = (leg: string, arm = 1) =>
    readJson<TextureReloadEvidence>(join(evidence(leg, arm), "reload.json"));
  const teardown = (leg: string, arm = 1) =>
    readJson<TextureTeardown>(join(evidence(leg, arm), "teardown.json"));
  const allEvidence = <T>(leg: string, name: string): (T | null)[] => {
    const scan = (dir: string): (T | null)[] =>
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const path = join(dir, e.name);
            return e.isDirectory()
              ? scan(path)
              : e.name === name
                ? [readJson<T>(path)]
                : [];
          })
        : [];
    return scan(evidence(leg));
  };
  const rec = (leg: string, arm = 1) =>
    loadRec(
      join(root, leg, `recording.rs8${arm === 1 ? "" : `.arm-${arm}`}`),
      11,
    ).rec ?? null;
  const rb = reload("rearm", 2),
    ra = reload("once");
  const checks: G8aCheck[] = [];
  const add = (
    id: string,
    legs: string[],
    criterion: string,
    judge: () => string[],
  ) => {
    if (
      existsSync(join(root, "not-selected.txt")) ||
      legs.some((leg) => !existsSync(join(root, leg, "exit-code.txt")))
    ) {
      checks.push({
        id,
        criterion,
        passed: false,
        status: "not-run",
        gating: false,
        detail: "texture eviction legs absent or not selected",
      });
      return;
    }
    const pre = legs.flatMap((leg) =>
      readFileSync(join(root, leg, "exit-code.txt"), "utf8").trim() === "0"
        ? []
        : [`${leg} failed`],
    );
    checks.push(
      check(id, criterion, [...pre, ...judge()], "all predicates hold"),
    );
  };
  add(
    "rearm-no-1x1-evict",
    ["rearm", "once"],
    "Every adopted reload matches its record and no image is published as 1x1",
    () => [
      ...reloadNo1x1(rec("rearm", 2), rb),
      ...reloadNo1x1(rec("once"), ra),
    ],
  );
  add(
    "htr-census-1x1-rearm-evict",
    ["rearm", "once"],
    "No arm draws a 1x1 image into a large rectangle",
    () => reloadCensus([rec("rearm"), rec("rearm", 2), rec("once")]),
  );
  add(
    "reload-typed-evict",
    ["rearm", "once"],
    "Eviction reload candidates, outcomes and teardown counts match the fixture",
    () => [
      ...reloadTyped(rb, true, [teardown("rearm")], textureEvictExpected(true)),
      ...reloadTyped(
        ra,
        false,
        allEvidence<TextureTeardown>("once", "teardown.json"),
        textureEvictExpected(false),
      ),
    ],
  );
  add(
    "htr-imagetexture-restored-evict",
    ["rearm"],
    "The path-less ImageTexture is restored at disarm",
    () =>
      imageTextureRestored(
        jsonlOf<TextureEvent>(join(root, "rearm", "events.jsonl")).find(
          (e) => e.event === "imagetexture-probe",
        ) ?? null,
        teardown("rearm"),
        rb,
      ),
  );
  add(
    "rearm-evict-no-imagetexture-release",
    ["rearm", "once"],
    "The once-arm ImageTexture retains its content and every eviction path ends .ctex",
    () =>
      noImageTextureReleaseProblems(
        jsonlOf<TextureEvent>(join(root, "once", "events.jsonl")).find(
          (e) => e.event === "imagetexture-probe",
        ) ?? null,
        readJson<{ headless_texture_release?: HtrStats }>(
          join(evidence("once"), "result.json"),
        )?.headless_texture_release ?? null,
        readJson<EvictEvidence>(join(evidence("once"), "evict.json")),
        false,
      ),
  );
  add(
    "evict-rearm",
    ["rearm", "once"],
    "Standby eviction is balanced and every released texture has a reload path",
    () => [
      ...evictRearmProblems(
        readJson<EvictEvidence>(join(evidence("rearm"), "evict.json")),
        true,
        allEvidence<TextureReloadEvidence>("rearm", "reload.json"),
      ),
      ...evictRearmProblems(
        readJson<EvictEvidence>(join(evidence("once"), "evict.json")),
        false,
        allEvidence<TextureReloadEvidence>("once", "reload.json"),
      ),
    ],
  );
  return checks;
}

export interface WarmEvidence {
  final: boolean;
  skipped: string | null;
  warm_balanced: boolean;
  held_entries: number;
  decode_at_reference: number;
  discarded_stale: number;
  mispredicts: number;
  reload_sources_left: number;
  from_reload: number;
  served_reload: number;
  warm_complete: boolean;
  jobs: number;
  arm_to_warm_complete_ms: number | null;
  reload_us: number;
  discarded_superseded: number;
  discarded_freed: number;
  queued: number;
}

/** Final warm evidence must account for every entry without reference-time work. */
export function warmCompleteProblems(
  w: WarmEvidence | null,
  reloadCounts?: readonly [number, number],
  workers = false,
): string[] {
  if (!w) return ["missing warm evidence"];
  const problems: string[] = [];
  if (w.skipped !== null) problems.push("warm skipped");
  if (w.final !== true) problems.push("warm not final");
  if (w.warm_balanced !== true) problems.push("warm not balanced");
  for (const key of [
    "held_entries",
    "decode_at_reference",
    "discarded_stale",
    "mispredicts",
    "reload_sources_left",
  ] as const)
    if (w[key] !== 0) problems.push(key);
  if (reloadCounts) {
    if (w.from_reload !== reloadCounts[0]) problems.push("from_reload");
    if (w.served_reload !== reloadCounts[1]) problems.push("served_reload");
  }
  if (workers) {
    if (w.warm_complete !== true) problems.push("warm not complete");
    if (!Number.isSafeInteger(w.jobs) || w.jobs < 1) problems.push("jobs");
    if (
      typeof w.arm_to_warm_complete_ms !== "number" ||
      !Number.isFinite(w.arm_to_warm_complete_ms) ||
      !Number.isFinite(w.reload_us) ||
      w.reload_us < 0 ||
      w.arm_to_warm_complete_ms < w.reload_us / 1000
    )
      problems.push("arm_to_warm_complete_ms");
  }
  return problems;
}

export function warmInvalidationProblems(
  w: WarmEvidence | null,
  events: TextureEvent[],
  k2: number | null,
): string[] {
  if (!w) return ["missing warm evidence"];
  const problems: string[] = [];
  if (w.final !== true) problems.push("warm not final");
  if (w.discarded_superseded !== 1) problems.push("discarded_superseded");
  if (!Number.isSafeInteger(w.discarded_freed) || w.discarded_freed < 1)
    problems.push("discarded_freed");
  if (w.discarded_stale !== 0) problems.push("discarded_stale");
  if (
    k2 === null ||
    !Number.isFinite(k2) ||
    !events.some(
      (e) =>
        e.event === "warm-probe" && Number.isFinite(e.frame) && e.frame >= k2,
    )
  )
    problems.push("warm-probe missing or before K2");
  return problems;
}

export function faultWarmOffProblems(
  w: WarmEvidence | null,
  reload: ReloadSourceEvidence | null,
): string[] {
  if (!w) return ["missing warm evidence"];
  const problems = reloadSourcesBalanced(reload);
  if (w.final !== true) problems.push("warm not final");
  if (w.skipped !== "fault-warm-off") problems.push("wrong warm skip");
  if (w.queued !== 0) problems.push("queued");
  if (
    !Number.isSafeInteger(w.decode_at_reference) ||
    w.decode_at_reference < 12 ||
    !warmCompleteProblems(w).includes("decode_at_reference")
  )
    problems.push("warm-off negative test not caught by decode_at_reference");
  if (reload?.adopted_from_reload !== 12) problems.push("adopted_from_reload");
  return problems;
}

function warmChecks(g: string): G8aCheck[] {
  const checks: G8aCheck[] = [];
  const selected = (leg: string) =>
    !existsSync(
      join(
        g,
        leg === "tex-htr/swap" ? "tex-htr-faults" : leg.split("/")[0],
        "not-selected.txt",
      ),
    );
  const add = (
    id: string,
    criterion: string,
    legs: string[],
    judge: () => string[],
  ) => {
    if (
      legs.length === 0 ||
      legs.some((leg) => !existsSync(join(g, leg, "exit-code.txt")))
    ) {
      checks.push({
        id,
        criterion,
        passed: false,
        status: "not-run",
        gating: false,
        detail: "warm legs absent or not selected",
      });
      return;
    }
    const pre = legs.flatMap((leg) =>
      readFileSync(join(g, leg, "exit-code.txt"), "utf8").trim() === "0"
        ? []
        : [`${leg} failed`],
    );
    checks.push(
      check(id, criterion, [...pre, ...judge()], "all predicates hold"),
    );
  };
  const warm = (leg: string, arm = 2) =>
    readJson<WarmEvidence>(
      join(
        g,
        leg,
        "evidence",
        ...(arm === 1 ? [] : [`arm-${arm}`]),
        "warm.json",
      ),
    );
  const legs = [
    "adopt/rearm",
    "adopt/once",
    "tex/rearm",
    "tex/once",
    "tex-htr/rearm",
    "tex-htr/once",
    "tex-evict/rearm",
    "tex-evict/once",
    "tex-htr/swap",
    "id/host",
    "tex-warm/workers",
  ].filter(selected);
  add(
    "warm-complete",
    "Every selected honest arm warms eligible bodies without reference-time decode",
    legs,
    () =>
      legs.flatMap((leg) => {
        const dir = join(g, leg, "evidence");
        const arms = [
          1,
          ...(existsSync(dir)
            ? readdirSync(dir, { withFileTypes: true })
            : []
          ).flatMap((e) =>
            e.isDirectory() && /^arm-(?:[2-9]|[1-9][0-9]+)$/.test(e.name)
              ? [Number(e.name.slice(4))]
              : [],
          ),
        ];
        // Re-arm legs must provide both arms, even if their evidence directory is missing.
        if (!leg.endsWith("/once") && !arms.includes(2)) arms.push(2);
        return arms.flatMap((arm) => {
          const counts: readonly [number, number] | undefined =
            leg === "tex-evict/once"
              ? [11, 10]
              : leg === "tex-htr/once"
                ? [7, 6]
                : arm === 2 &&
                    (leg === "tex-htr/rearm" ||
                      leg === "tex-evict/rearm" ||
                      leg === "tex-warm/workers")
                  ? [13, 12]
                  : undefined;
          return warmCompleteProblems(
            warm(leg, arm),
            counts,
            leg === "tex-warm/workers" && arm === 2,
          ).map((p) => `${leg} arm ${arm}: ${p}`);
        });
      }),
  );
  const worker = "tex-warm/workers";
  add(
    "warm-invalidation-typed",
    "The arm-2 update supersedes and the free discards warmed entries",
    selected(worker) ? [worker] : [],
    () => {
      const idle = jsonlOf<CycleLine>(
        join(g, worker, "evidence/swap-cycle.jsonl"),
      ).find((e) => e.phase === "idle" && e.cycle === 1);
      return warmInvalidationProblems(
        warm(worker),
        jsonlOf<TextureEvent>(join(g, worker, "events.jsonl")),
        idle ? idle.end_frame + 2 : null,
      );
    },
  );
  const off = "tex-warm/warm-off";
  add(
    "fault-warm-off-caught",
    "The warm-off fault knob forces at least twelve reference-time decodes",
    selected(off) ? [off] : [],
    () =>
      faultWarmOffProblems(
        warm(off),
        readJson<ReloadSourceEvidence>(
          join(g, off, "evidence/arm-2/reload.json"),
        ),
      ),
  );
  return checks;
}

export interface ReloadSourceEvidence {
  final: boolean;
  sources_balanced: boolean;
  reloaded: number;
  adopted_from_reload: number;
  dropped_unreferenced: number;
  dropped_freed: number;
  dropped_stale: number;
}

/** Every loaded source must be adopted or counted once when it is dropped. */
export function reloadSourcesBalanced(
  evidence: ReloadSourceEvidence | null,
): string[] {
  if (evidence === null) return ["missing reload evidence"];
  const problems: string[] = [];
  if (evidence.final !== true) problems.push("reload evidence is not final");
  if (evidence.sources_balanced !== true)
    problems.push("sources_balanced is not true");
  const counts = [
    evidence.reloaded,
    evidence.adopted_from_reload,
    evidence.dropped_unreferenced,
    evidence.dropped_freed,
    evidence.dropped_stale,
  ];
  if (
    counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    evidence.reloaded !==
      evidence.adopted_from_reload +
        evidence.dropped_unreferenced +
        evidence.dropped_freed +
        evidence.dropped_stale
  )
    problems.push("reload sources do not balance");
  return problems;
}

function reloadSourceCheck(g: string): G8aCheck {
  const paths: string[] = [];
  function scan(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && entry.name === "reload.json") paths.push(path);
    }
  }
  scan(g);
  const criterion =
    "Every final reload.json balances reloaded sources across adoption, unreferenced drops and frees, with no source left held";
  if (paths.length === 0)
    return {
      id: "reload-sources-balanced",
      criterion,
      passed: false,
      status: "not-run",
      gating: false,
      detail: "reload legs absent",
    };
  const problems = paths.flatMap((path) =>
    reloadSourcesBalanced(readJson<ReloadSourceEvidence>(path)).map(
      (p) => `${path}: ${p}`,
    ),
  );
  return check(
    "reload-sources-balanced",
    criterion,
    problems,
    `${paths.length} final reload files balanced`,
  );
}

export interface FloatHoldOracle {
  name: string;
  step: number;
  payload_sha256: string;
}
export interface FloatHoldArm {
  first: number;
  last: number;
}
export type FloatHoldCells = Record<string, Record<string, boolean | null>>;
type HoldLeg = "standby" | "fault-hold-off";
type Predicates = Record<string, string | number | boolean | null>;
const floatHoldCells: Record<string, readonly string[]> = {
  "held-update": ["curve_rf", "curve_xyz"],
  "held-update-step1": ["curve_rgb", "img_rh", "img_rgbah"],
  "held-replace": ["grad_hdr"],
  "pending-standby": ["off_curve", "off_grad"],
  "pending-armed": ["off_curve2", "off_grad2"],
  control: [
    "img_rgf",
    "img_rgh",
    "img_rgbh",
    "img_rgbaf_mip",
    "img_rf_odd",
    "hdr_bptc",
    "hdr_astc",
  ],
};
function cellsForArm(arm: number) {
  return Object.entries(floatHoldCells).filter(
    ([cell]) =>
      arm !== 1 || (cell !== "held-update-step1" && cell !== "pending-armed"),
  );
}

/** A published material must actually name the oracle's live, supported texture. */
export function published(state: State | null, hash: string): boolean {
  if (!state || !hash) return false;
  const ids = new Set(
    state.textures
      .filter((t) => t.status === "ok" && t.hash === hash)
      .map((t) => t.id),
  );
  return (state.materials ?? []).some(
    (m) =>
      m.status === "ok" &&
      m.params.some(
        (p) =>
          p.type === "rid" &&
          p.value !== null &&
          typeof p.value === "object" &&
          "tex" in p.value &&
          ids.has(p.value.tex as number),
      ),
  );
}
export function floatHoldCellTable(
  state: State | null,
  oracleLines: FloatHoldOracle[] | null,
  arm: number,
): FloatHoldCells | null {
  if (!state || !oracleLines) return null;
  return Object.fromEntries(
    cellsForArm(arm).map(([cell, names]) => [
      cell,
      Object.fromEntries(
        names.map((name) => {
          const step = name.startsWith("hdr_") || arm === 1 ? 0 : 1;
          const hash = oracleLines.find(
            (o) => o.name === name && o.step === step,
          )?.payload_sha256;
          return [name, hash ? published(state, hash) : null];
        }),
      ),
    ]),
  );
}
export function floatHoldCellProblems(
  table: FloatHoldCells | null,
  arm: number,
  want: "published" | "fault",
): string[] {
  if (!table) return ["missing cell state or oracle"];
  return cellsForArm(arm).flatMap(([cell, names]) =>
    names.flatMap((name) => {
      const got = table[cell]?.[name];
      return got === (want === "published" || cell === "control")
        ? []
        : [`${cell}.${name}: ${got ?? "missing oracle"}`];
    }),
  );
}
export function floatHoldSchedule(
  steps: StepLine[] | null,
  arms: FloatHoldArm[] | null,
): string[] {
  if (!steps || !arms || arms.length !== 3)
    return ["missing steps or three arm windows"];
  const [a, b, c] = arms;
  const zero = steps.filter((s) => s.step === 0),
    one = steps.filter((s) => s.step === 1);
  const problems: string[] = [];
  if (
    zero.length !== 1 ||
    !Number.isFinite(zero[0]?.settle_frame) ||
    !(zero[0].settle_frame! < a.first)
  )
    problems.push("step 0 outside initial standby window");
  if (
    one.length !== 1 ||
    !(one[0].applied_frame > a.last) ||
    !Number.isFinite(one[0]?.settle_frame) ||
    !(one[0].settle_frame! < b.first)
  )
    problems.push("step 1 outside disarmed window");
  if (
    arms.some(
      (x) =>
        !Number.isSafeInteger(x.first) ||
        !Number.isSafeInteger(x.last) ||
        x.first > x.last,
    ) ||
    !(c.first > b.last)
  )
    problems.push("invalid arm windows");
  return problems;
}
function evidenceField(input: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        v !== null && typeof v === "object"
          ? (v as Record<string, unknown>)[key]
          : undefined,
      input,
    );
}
function fieldsMatch(
  input: unknown,
  expected: Predicates,
  label: string,
): string[] {
  if (input == null) return [`missing ${label}`];
  return Object.entries(expected).flatMap(([key, value]) =>
    evidenceField(input, key) === value
      ? []
      : [
          `${label}.${key}: ${String(evidenceField(input, key))}, expected ${value}`,
        ],
  );
}
function warmExpected(arm: number, leg: HoldLeg): Predicates {
  const fault = leg === "fault-hold-off",
    first = arm === 1;
  const tuple = fault
    ? first
      ? [0, 0, 5, 0, 11, 11, 10, 0, 0, 0, 4, 14, 10, 4, 1, 1]
      : [0, 0, arm === 2 ? 8 : 0, 0, 8, 8, 7, 0, 0, 0, 9, 16, 7, 9, 1, 1]
    : first
      ? [5, 10752, 0, 5, 11, 16, 15, 5, 0, 0, 0, 15, 15, 0, 0, 0]
      : [10, 17920, 0, 10, 8, 18, 17, 10, 0, 0, 0, 17, 17, 0, 0, 0];
  const keys = [
    "held_at_arm",
    "held_bytes_at_arm",
    "hold_dropped_fault",
    "from_hold",
    "from_registry",
    "queued",
    "served",
    "served_hold",
    "lazy_from_hold",
    "decode_at_reference",
    "lazy_at_reference.updated",
    "textures.adopted",
    "textures.current",
    "textures.creation",
    "textures.refused",
    "textures.refused_no_image",
  ];
  return {
    ...Object.fromEntries(keys.map((key, i) => [key, tuple[i]])),
    schema: "render-stream-warm/1",
    final: true,
    arm_index: arm,
    "scanned.registered_2d": first ? 16 : 18,
    dropped_unreferenced: 1,
    warm_balanced: true,
  };
}
function teardownExpected(arm: number, leg: HoldLeg): Predicates {
  return {
    hold_entries: leg === "standby" ? (arm === 1 ? 7 : 10) : arm === 1 ? 2 : 0,
    hold_bytes:
      leg === "standby" ? (arm === 1 ? 13312 : 17920) : arm === 1 ? 2560 : 0,
  };
}
export interface FloatHoldArmInput {
  equivalenceProblems: string[] | null;
  warm: unknown;
  teardown: unknown;
  oracleLines: FloatHoldOracle[] | null;
  state: State | null;
}
export function floatHoldArmProblems(
  arm: number,
  input: FloatHoldArmInput | null,
  expected: HoldLeg,
): string[] {
  if (!input) return ["missing arm evidence"];
  return [
    ...(input.equivalenceProblems ?? ["missing equivalence"]),
    ...fieldsMatch(input.warm, warmExpected(arm, expected), "warm"),
    ...fieldsMatch(input.teardown, teardownExpected(arm, expected), "teardown"),
    ...floatHoldCellProblems(
      floatHoldCellTable(input.state, input.oracleLines, arm),
      arm,
      "published",
    ),
  ];
}
const holdSkipNames = [
  "unregistered",
  "not_texture2d",
  "offmain_replace",
  "released_source",
  "vram_format",
  "no_image",
  "size_unknown",
  "shape_mismatch",
  "over_texture_cap",
  "over_total_cap",
];
const pendingSkipNames = [
  "unregistered",
  "not_texture2d",
  "vram_format",
  "no_image",
  "size_unknown",
  "over_texture_cap",
];
function pendingExpected(): Predicates {
  return {
    "caps.entries": 64,
    "caps.bytes": 4194304,
    taken: 15,
    taken_bytes: 21400,
    moved: 4,
    moved_bytes: 5120,
    "dropped.updated": 4,
    "dropped.replaced": 2,
    "dropped.recreated": 0,
    evicted: 0,
    evicted_bytes: 0,
    "peak.entries": 9,
    "peak.bytes": 14744,
    pending_balanced: true,
    ...Object.fromEntries(pendingSkipNames.map((k) => [`skipped.${k}`, 0])),
  };
}
function count(input: unknown, path: string): number {
  const value = evidenceField(input, path);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : Number.NaN;
}
/** Recompute accounting as well as checking the producer's balance flags. */
function holdEvidenceProblems(hold: unknown, expected: HoldLeg): string[] {
  const fault = expected === "fault-hold-off";
  const problems = fieldsMatch(
    hold,
    {
      schema: "render-stream-hold/1",
      final: true,
      state: "active",
      reason: null,
      fault: fault ? "hold-off" : "none",
      "caps.texture_max_bytes": 1572864,
      "caps.total_max_bytes": 16777216,
      "taken.total": 16,
      "taken.update": 10,
      "taken.replace": 6,
      "taken.bytes": 30720,
      "dropped.superseded": fault ? 3 : 6,
      "dropped.fault": fault ? 13 : 0,
      "dropped.unheld": 0,
      "dropped.recreated": 0,
      "dropped.replaced_away": 0,
      "peak.entries": fault ? 8 : 10,
      "peak.bytes": fault ? 15360 : 18944,
      hold_balanced: true,
      ...Object.fromEntries(holdSkipNames.map((k) => [`skipped.${k}`, 0])),
    },
    "hold",
  );
  const p = evidenceField(hold, "pending");
  problems.push(...fieldsMatch(p, pendingExpected(), "pending"));
  const n = (path: string) => count(hold, path),
    pn = (path: string) => count(p, path);
  const dropCount = [
    "superseded",
    "unheld",
    "freed",
    "recreated",
    "replaced_away",
    "fault",
  ].reduce((s, k) => s + n(`dropped.${k}`), 0);
  const pendingDrops = ["freed", "updated", "replaced", "recreated"].reduce(
    (s, k) => s + pn(`dropped.${k}`),
    0,
  );
  if (
    n("live.entries") + n("dropped.freed") !== (fault ? 0 : 10) ||
    n("taken.total") !== n("live.entries") + dropCount ||
    n("taken.bytes") !== n("live.bytes") + n("dropped_bytes") ||
    n("taken.total") !== n("taken.update") + n("taken.replace")
  )
    problems.push("hold accounting does not balance");
  if (
    pn("live.entries") + pn("dropped.freed") !== 5 ||
    pn("taken") !==
      pn("live.entries") + pn("moved") + pendingDrops + pn("evicted") ||
    pn("taken_bytes") !==
      pn("live.bytes") +
        pn("moved_bytes") +
        pn("dropped_bytes") +
        pn("evicted_bytes")
  )
    problems.push("pending accounting does not balance");
  for (const prefix of ["live", "peak"]) {
    if (!(n(`${prefix}.bytes`) <= 16777216))
      problems.push(`hold.${prefix} above cap or missing`);
    if (!(pn(`${prefix}.entries`) <= 64 && pn(`${prefix}.bytes`) <= 4194304))
      problems.push(`pending.${prefix} above cap or missing`);
  }
  return problems;
}
export function holdAccountingProblems(
  hold: unknown,
  teardowns: unknown[] | null,
  expected: HoldLeg,
): string[] {
  const problems = holdEvidenceProblems(hold, expected);
  if (teardowns?.length !== 3) problems.push("missing three teardowns");
  else
    teardowns.forEach((t, i) => {
      problems.push(
        ...fieldsMatch(
          t,
          teardownExpected(i + 1, expected),
          `teardown arm ${i + 1}`,
        ),
      );
    });
  return problems;
}
export function faultHoldOffProblems(
  armEquivalenceProblems: (string[] | null)[] | null,
  warms: unknown[] | null,
  hold: unknown,
  cellTables: (FloatHoldCells | null)[] | null,
  expected: HoldLeg,
): string[] {
  const problems = holdEvidenceProblems(hold, expected);
  if (
    armEquivalenceProblems?.length !== 3 ||
    armEquivalenceProblems.some((p) => !p || p.length === 0)
  )
    problems.push("fault knob did not fail equivalence on every arm");
  if (warms?.length !== 3) problems.push("missing three fault warms");
  else
    warms.forEach((w, i) => {
      problems.push(
        ...fieldsMatch(
          w,
          warmExpected(i + 1, expected),
          `fault warm arm ${i + 1}`,
        ),
      );
    });
  if (cellTables?.length !== 3)
    problems.push("missing three fault cell tables");
  else
    cellTables.forEach((table, i) => {
      problems.push(...floatHoldCellProblems(table, i + 1, "fault"));
    });
  return problems;
}
export interface OffmainLine {
  event: string;
  variant: number;
  frame: number;
  off_main: boolean;
  thread_id: number;
  main_thread_id: number;
}
export function offmainProblems(
  offmainLines: {
    standby: OffmainLine[] | null;
    born: OffmainLine[] | null;
    arms: FloatHoldArm[] | null;
  } | null,
  hold: unknown,
  cellTables: (FloatHoldCells | null)[] | null,
): string[] {
  if (!offmainLines) return ["missing offmain evidence"];
  const problems: string[] = [];
  for (const leg of ["standby", "born"] as const) {
    const lines = offmainLines[leg];
    if (
      lines?.length !== 2 ||
      lines.some(
        (x, i) =>
          x.event !== "offmain-fill" ||
          x.variant !== i + 1 ||
          x.off_main !== true ||
          !Number.isSafeInteger(x.thread_id) ||
          !Number.isSafeInteger(x.main_thread_id) ||
          x.thread_id === x.main_thread_id,
      )
    )
      problems.push(`${leg}: missing two off-main variant fills`);
  }
  const a = offmainLines.arms?.[0],
    lines = offmainLines.standby;
  if (
    !a ||
    !lines ||
    !(lines[0]?.frame < a.first) ||
    !(lines[1]?.frame >= a.first && lines[1]?.frame <= a.last)
  )
    problems.push("offmain fills outside standby and armed windows");
  problems.push(
    ...fieldsMatch(
      evidenceField(hold, "pending"),
      pendingExpected(),
      "pending",
    ),
    ...fieldsMatch(hold, { "skipped.offmain_replace": 0 }, "hold"),
  );
  const pending = evidenceField(hold, "pending");
  const pn = (path: string) => count(pending, path);
  const dropped = ["freed", "updated", "replaced", "recreated"].reduce(
    (n, key) => n + pn(`dropped.${key}`),
    0,
  );
  if (
    pn("live.entries") + pn("dropped.freed") !== 5 ||
    pn("taken") !==
      pn("live.entries") + pn("moved") + dropped + pn("evicted") ||
    pn("taken_bytes") !==
      pn("live.bytes") +
        pn("moved_bytes") +
        pn("dropped_bytes") +
        pn("evicted_bytes") ||
    !(pn("live.entries") <= 64 && pn("live.bytes") <= 4194304)
  )
    problems.push("pending accounting does not balance or exceeds cap");
  if (cellTables?.length !== 3) problems.push("missing offmain cell tables");
  else
    cellTables.forEach((table, i) => {
      const all = floatHoldCellProblems(table, i + 1, "published");
      problems.push(
        ...(table ? all.filter((p) => p.startsWith("pending-")) : all),
      );
    });
  return problems;
}

function floatHoldChecks(g: string): {
  checks: G8aCheck[];
  report: Record<string, unknown>;
} {
  const root = join(g, "float-hold");
  const capture = (leg: string) => join(root, leg, "capture");
  const evidence = (leg: string, arm: number, name: string) =>
    readJson<unknown>(
      join(
        capture(leg),
        "evidence",
        ...(arm === 1 ? [] : [`arm-${arm}`]),
        name,
      ),
    );
  const loaded = new Map<string, LoadedRecording>();
  const rec = (leg: string, arm = 1) => {
    const key = `${leg}/${arm}`;
    if (!loaded.has(key))
      loaded.set(
        key,
        loadRec(
          join(capture(leg), `recording.rs8${arm === 1 ? "" : `.arm-${arm}`}`),
        ),
      );
    return loaded.get(key)!;
  };
  const oracle = (leg: string) =>
    jsonlOf<FloatHoldOracle>(join(capture(leg), "textures.jsonl"));
  const tables = (leg: string) =>
    [1, 2, 3].map((k) =>
      floatHoldCellTable(
        rec(leg, k).rec?.transactions.at(-1)?.state ?? null,
        oracle(leg),
        k,
      ),
    );
  const arms = (leg: string) =>
    [1, 2, 3].map((k) => {
      const tx = rec(leg, k).rec?.transactions;
      return {
        first: tx?.[0]?.frame ?? Number.NaN,
        last: tx?.at(-1)?.frame ?? Number.NaN,
      };
    });
  const born = rec("born");
  const compare = (leg: string) =>
    [1, 2, 3].map((k) => {
      const r = rec(leg, k);
      return born.rec && r.rec
        ? equivalence(born.rec, r.rec, r.rec.transactions[0]?.frame ?? 0, 0, {})
            .problems
        : null;
    });
  const hold = (leg: string) => evidence(leg, 1, "hold.json");
  const teardowns = (leg: string) =>
    [1, 2, 3].map((k) => evidence(leg, k, "teardown.json"));
  const warms = (leg: string) =>
    [1, 2, 3].map((k) => evidence(leg, k, "warm.json"));
  const checks: G8aCheck[] = [];
  const add = (
    id: string,
    legs: string[],
    criterion: string,
    judge: () => string[],
    detail: string,
  ) => {
    const present = legs.some((leg) => existsSync(capture(leg)));
    const pre = legs.flatMap((leg) => {
      const exit = join(capture(leg), "exit-code.txt");
      return existsSync(exit) && readFileSync(exit, "utf8").trim() === "0"
        ? []
        : [`${leg}: missing or nonzero exit`];
    });
    checks.push(
      selectedCheck(
        !present
          ? {
              id,
              criterion,
              passed: false,
              status: "not-run",
              gating: false,
              detail: "float-hold legs absent",
            }
          : check(id, criterion, [...pre, ...judge()], detail),
        g,
        "float-hold",
      ),
    );
  };
  const honestTables = tables("standby"),
    faultTables = tables("fault-hold-off");
  add(
    "float-hold-equivalence",
    ["standby", "born"],
    "Every arm equals born without exceptions, fills occur while disarmed, and every texture cell is published",
    () => {
      const comparisons = compare("standby");
      return [
        ...floatHoldSchedule(
          jsonlOf<StepLine>(join(capture("standby"), "steps.jsonl")),
          arms("standby"),
        ),
        ...[1, 2, 3].flatMap((k) =>
          floatHoldArmProblems(
            k,
            {
              equivalenceProblems: comparisons[k - 1],
              warm: evidence("standby", k, "warm.json"),
              teardown: evidence("standby", k, "teardown.json"),
              oracleLines: oracle("standby"),
              state: rec("standby", k).rec?.transactions.at(-1)?.state ?? null,
            },
            "standby",
          ),
        ),
      ];
    },
    "3 arms equal born; all applicable cells published; warm counts and standby fill windows match",
  );
  add(
    "float-hold-offmain",
    ["standby", "born"],
    "Both variants fill off-main in their required windows, bounded pending references move, and later arms publish them",
    () => [
      ...offmainProblems(
        {
          standby: jsonlOf<OffmainLine>(
            join(capture("standby"), "offmain.jsonl"),
          ),
          born: jsonlOf<OffmainLine>(join(capture("born"), "offmain.jsonl")),
          arms: arms("standby"),
        },
        hold("standby"),
        honestTables,
      ),
      ...[2, 3].flatMap((k) =>
        fieldsMatch(
          evidence("standby", k, "warm.json"),
          { "textures.refused": 0 },
          `warm arm ${k}`,
        ),
      ),
    ],
    "2 off-main variants per leg; variant 2 inside arm 1; pending taken=15 moved=4; pending cells published on later arms",
  );
  add(
    "float-hold-accounting",
    ["standby", "born"],
    "Final hold and pending accounting and each teardown match their bounds; born keeps no hold evidence",
    () => [
      ...holdAccountingProblems(
        hold("standby"),
        teardowns("standby"),
        "standby",
      ),
      ...(existsSync(join(capture("born"), "evidence", "hold.json"))
        ? ["born has hold.json"]
        : []),
    ],
    "hold taken=16/30720 B peak=10/18944 B; pending taken=15/21400 B peak=9/14744 B; all balances and caps hold",
  );
  add(
    "fault-hold-off-caught",
    ["fault-hold-off", "born"],
    "The hold-off fault knob fails every arm's equivalence on held and pending cells while controls remain published",
    () => [
      ...faultHoldOffProblems(
        compare("fault-hold-off"),
        warms("fault-hold-off"),
        hold("fault-hold-off"),
        faultTables,
        "fault-hold-off",
      ),
      ...holdAccountingProblems(
        hold("fault-hold-off"),
        teardowns("fault-hold-off"),
        "fault-hold-off",
      ),
    ],
    "3 arms fail equivalence; all applicable held/pending cells absent and controls published; fault drops=13/26112 B",
  );
  return {
    checks,
    report: { standby: honestTables, "fault-hold-off": faultTables },
  };
}

export interface RecoverLine {
  event: string;
  name?: string;
  rid?: number;
  frame: number;
  off_main?: boolean;
  thread_id?: number;
  main_thread_id?: number;
}
type RecoverRids = Record<string, number>;
const recoverNames = ["grad_hdr", "img_big", "img_late"] as const;
const objectOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const positiveId = (v: unknown): boolean =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function floatRecoverSchedule(
  steps: StepLine[] | null,
  recoverLines: RecoverLine[] | null,
  arm1: FloatHoldArm | null,
): string[] {
  if (!steps || !recoverLines || !arm1) return ["missing recovery schedule"];
  const problems: string[] = [];
  const zero = steps.filter((s) => s.step === 0);
  const one = steps.filter((s) => s.step === 1);
  if (
    !Number.isSafeInteger(arm1.first) ||
    !Number.isSafeInteger(arm1.last) ||
    arm1.first > arm1.last
  )
    problems.push("invalid arm 1 window");
  if (zero.length !== 1 || !(zero[0].settle_frame! < arm1.first))
    problems.push("step 0 does not settle before arm 1");
  if (
    one.length !== 1 ||
    !(
      one[0].applied_frame >= arm1.first &&
      one[0].applied_frame <= arm1.last &&
      one[0].settle_frame! >= one[0].applied_frame &&
      one[0].settle_frame! <= arm1.last
    )
  )
    problems.push("step 1 does not apply and settle within arm 1");
  const fill = recoverLines.filter((l) => l.event === "recover-param");
  if (
    fill.length !== 1 ||
    fill[0].frame !== 45 ||
    !(fill[0].frame >= arm1.first && fill[0].frame <= arm1.last) ||
    fill[0].off_main !== true ||
    !positiveId(fill[0].thread_id) ||
    !positiveId(fill[0].main_thread_id) ||
    fill[0].thread_id === fill[0].main_thread_id
  )
    problems.push("recover-param is not off-main at frame 45 within arm 1");
  const ridLines = recoverLines.filter((l) => l.event === "rid");
  if (
    ridLines.length !== 3 ||
    new Set(ridLines.map((l) => l.rid)).size !== 3 ||
    recoverNames.some(
      (name) =>
        ridLines.filter((l) => l.name === name && positiveId(l.rid)).length !==
        1,
    )
  )
    problems.push("missing, extra or invalid recovery RIDs");
  return problems;
}

function recoverCellTable(
  state: State | null,
  oracle: FloatHoldOracle[] | null,
  phase: "first" | "last",
): Record<string, boolean | null> {
  return Object.fromEntries(
    [...recoverNames, ...floatHoldCells.control].map((name) => {
      const step =
        name === "img_late" || name.startsWith("hdr_") || phase === "first"
          ? 0
          : 1;
      const hash = oracle?.find(
        (o) => o.name === name && o.step === step,
      )?.payload_sha256;
      return [name, state && hash ? published(state, hash) : null];
    }),
  );
}
export function floatRecoverCells(
  state: State | null,
  oracleLines: FloatHoldOracle[] | null,
  phase: "first" | "last",
): string[] {
  if (!state || !oracleLines) return ["missing recovery state or oracle"];
  const table = recoverCellTable(state, oracleLines, phase);
  const names =
    phase === "first" ? ["grad_hdr", "img_big"] : Object.keys(table);
  return names.flatMap((name) =>
    table[name] === (phase === "last")
      ? []
      : [`${phase} ${name}: ${table[name] ?? "missing oracle"}`],
  );
}
export function floatRecoverEquivalenceProblems(
  problems: string[] | null,
): string[] {
  return problems === null ? ["missing recovery equivalence"] : problems;
}

function skipRecordProblems(
  record: unknown,
  rids: RecoverRids | null,
  seq: number,
): string[] {
  const problems = fieldsMatch(
    record,
    {
      seq,
      rid: rids?.img_big ?? -1,
      source: "replace",
      reason: "over_texture_cap",
      thread: "main",
      width: 5,
      height: 19661,
      format: 11,
      bytes: 1572880,
      "by.kind": "texture_2d",
      "by.width": 5,
      "by.height": 19661,
      "by.format": 11,
      "by.pending": "none",
    },
    "skip",
  );
  if (!positiveId(evidenceField(record, "by.rid")))
    problems.push("skip missing by RID");
  return problems;
}
export function recoverSkipProblems(
  hold: unknown,
  rids: RecoverRids | null,
  arm1: FloatHoldArm | null,
  step1: StepLine | null,
): string[] {
  if (!hold || !rids || !arm1 || !step1)
    return ["missing skip evidence or schedule"];
  const problems = fieldsMatch(
    hold,
    {
      schema: "render-stream-hold/1",
      final: true,
      "caps.texture_max_bytes": 1572864,
      "caps.total_max_bytes": 16777216,
      "pending.caps.entries": 64,
      "pending.caps.bytes": 4194304,
      hold_balanced: true,
      "pending.pending_balanced": true,
      skip_records_dropped: 0,
      pending_records_dropped: 0,
      "pending.evicted": 0,
    },
    "hold",
  );
  for (const [path, reasons] of [
    [
      "skipped",
      [
        "unregistered",
        "not_texture2d",
        "offmain_replace",
        "released_source",
        "vram_format",
        "no_image",
        "size_unknown",
        "shape_mismatch",
        "over_texture_cap",
        "over_total_cap",
      ],
    ],
    [
      "pending.skipped",
      [
        "unregistered",
        "not_texture2d",
        "vram_format",
        "no_image",
        "size_unknown",
        "over_texture_cap",
      ],
    ],
  ] as const) {
    for (const reason of reasons)
      problems.push(
        ...fieldsMatch(
          hold,
          {
            [`${path}.${reason}`]:
              path === "skipped" && reason === "over_texture_cap" ? 2 : 0,
          },
          "hold",
        ),
      );
    if (
      Object.keys(objectOf(evidenceField(hold, path))).length !== reasons.length
    )
      problems.push(`${path} has missing or extra reasons`);
  }
  if (!eq(evidenceField(hold, "pending_records"), []))
    problems.push("pending records not empty");
  const skips = arrayOf(evidenceField(hold, "skip_records"));
  if (skips.length !== 2) problems.push("expected exactly two skip records");
  skips.forEach((s, i) => {
    problems.push(...skipRecordProblems(s, rids, i + 1));
  });
  const f0 = evidenceField(skips[0], "frame"),
    f1 = evidenceField(skips[1], "frame");
  if (
    typeof f0 !== "number" ||
    !Number.isSafeInteger(f0) ||
    f0 < 0 ||
    !(f0 < arm1.first)
  )
    problems.push("first skip outside initial standby");
  if (
    typeof f1 !== "number" ||
    !(
      Math.abs(f1 - step1.applied_frame) <= 1 &&
      f1 >= arm1.first &&
      f1 <= arm1.last
    )
  )
    problems.push("second skip outside step 1 window");
  return problems;
}

function dependentProblems(value: unknown, count: number): string[] {
  const materials = arrayOf(evidenceField(value, "materials"));
  const problems = fieldsMatch(value, { more: 0 }, "dependents");
  if (materials.length !== count || !eq(evidenceField(value, "items"), []))
    problems.push("dependent counts differ");
  if (
    new Set(materials.map((m) => evidenceField(m, "id"))).size !==
    materials.length
  )
    problems.push("duplicate material dependents");
  for (const m of materials)
    if (
      !positiveId(evidenceField(m, "id")) ||
      !eq(evidenceField(m, "params"), ["src"])
    )
      problems.push("dependent material id or params differ");
  return problems;
}
export function recoverRefusalProblems(
  refusals: unknown,
  rids: RecoverRids | null,
  arm: number,
  want: "standby" | "fault",
): string[] {
  if (
    !refusals ||
    !rids ||
    recoverNames.some((n) => !positiveId(rids[n])) ||
    new Set(recoverNames.map((n) => rids[n])).size !== 3
  )
    return ["missing refusals or recovery RIDs"];
  const first = arm === 1,
    fault = first && want === "fault";
  const problems = fieldsMatch(
    refusals,
    {
      schema: "render-stream-refusals/1",
      final: true,
      arm,
      "counts.refused": 2,
      "counts.refused_no_image": 2,
      "counts.recovered.total": first ? 2 : 0,
      "counts.recovered.replace": first ? 2 : 0,
      "counts.recovered.update": 0,
      "counts.records": 2,
      "counts.records_dropped": 0,
      "index.entries": fault ? 4 : first ? 0 : 3,
      "index.peak": fault ? 4 : 3,
      "index.dropped": 0,
      "index.resolved.by_replace": first && !fault ? 2 : 0,
      "index.resolved.by_adopt": first && !fault ? 1 : 0,
      "index.materials": first && !fault ? 4 : 0,
      "index.params": first && !fault ? 4 : 0,
      "index.republish_skipped_fault": fault ? 3 : 0,
      "index.unresolved_more": 0,
    },
    "refusals",
  );
  const records = arrayOf(evidenceField(refusals, "records"));
  if (records.length !== 2)
    problems.push("expected exactly two refusal records");
  for (const name of ["grad_hdr", "img_big"] as const) {
    const matches = records.filter(
      (r) => evidenceField(r, "rid") === rids[name],
    );
    if (matches.length !== 1) {
      problems.push(`${name}: missing or duplicate refusal`);
      continue;
    }
    const r = matches[0],
      big = name === "img_big",
      n = big ? 1 : 2;
    problems.push(
      ...fieldsMatch(
        r,
        {
          family: "texture",
          reason: "no-image",
          created_offmain: null,
          "registry.kind": "texture_2d",
          "registry.width": big ? 5 : first ? 256 : 192,
          "registry.height": big ? 19661 : 1,
          "registry.format": 11,
          "registry.updated": true,
          "registry.held": false,
          ...(big ? { "registry.has_path": false } : {}),
        },
        name,
      ),
    );
    if (big)
      problems.push(
        ...skipRecordProblems(
          evidenceField(r, "last_skip"),
          rids,
          first ? 1 : 2,
        ),
      );
    else if (evidenceField(r, "last_skip") !== null)
      problems.push("grad_hdr last_skip not null");
    if (first) {
      problems.push(
        ...fieldsMatch(
          r,
          {
            "recovered.path": "replace",
            "recovered.materials": fault ? 0 : n,
            "recovered.params": fault ? 0 : n,
          },
          name,
        ),
      );
      const frame = evidenceField(r, "recovered.frame");
      if (
        typeof frame !== "number" ||
        frame < 40 ||
        frame > 42 ||
        !positiveId(evidenceField(r, "recovered.published_id"))
      )
        problems.push(`${name}: invalid recovery frame or id`);
    } else if (evidenceField(r, "recovered") !== null)
      problems.push(`${name}: arm 2 recovered`);
    problems.push(
      ...dependentProblems(evidenceField(r, "dependents"), first ? 0 : n),
    );
  }
  const unresolved = arrayOf(evidenceField(refusals, "index.unresolved"));
  const names = fault ? recoverNames : first ? [] : ["grad_hdr", "img_big"];
  if (unresolved.length !== names.length)
    problems.push("unresolved RID count differs");
  for (const name of names) {
    const matches = unresolved.filter(
      (u) => evidenceField(u, "rid") === rids[name],
    );
    if (matches.length !== 1) {
      problems.push(`${name}: missing or duplicate unresolved RID`);
      continue;
    }
    problems.push(
      ...fieldsMatch(matches[0], { refused: !first }, name),
      ...dependentProblems(matches[0], name === "grad_hdr" ? 2 : 1),
    );
  }
  if (!Array.isArray(evidenceField(refusals, "index.unresolved")))
    problems.push("missing unresolved list");
  return problems;
}

export function faultRepublishProblems(
  problems: string[] | null,
  state: State | null,
  oracleLines: FloatHoldOracle[] | null,
  refusals: unknown,
  rids: RecoverRids | null,
): string[] {
  const result = recoverRefusalProblems(refusals, rids, 1, "fault");
  if (!problems || problems.length === 0)
    result.push("fault knob did not fail equivalence");
  if (!state || !oracleLines)
    return [...result, "missing fault state or oracle"];
  const table = recoverCellTable(state, oracleLines, "last");
  for (const name of Object.keys(table)) {
    const recovered = recoverNames.includes(
      name as (typeof recoverNames)[number],
    );
    if (table[name] !== !recovered)
      result.push(`fault ${name}: ${table[name] ?? "missing oracle"}`);
    if (recovered) {
      const hash = oracleLines.find(
        (o) => o.name === name && o.step === (name === "img_late" ? 0 : 1),
      )?.payload_sha256;
      if (
        !hash ||
        !state.textures.some((t) => t.status === "ok" && t.hash === hash)
      )
        result.push(`${name}: recovered texture entry absent`);
    }
  }
  return result;
}

function floatRecoverChecks(g: string): {
  checks: G8aCheck[];
  report: Record<string, unknown>;
} {
  const root = join(g, "float-recover"),
    checks: G8aCheck[] = [];
  const capture = (leg: string) => join(root, leg, "capture");
  const evidence = (leg: string, arm: number, file: string) =>
    readJson<unknown>(
      join(
        capture(leg),
        "evidence",
        ...(arm === 1 ? [] : [`arm-${arm}`]),
        file,
      ),
    );
  const cache = new Map<string, LoadedRecording>();
  const rec = (leg: string, arm = 1) => {
    const key = `${leg}/${arm}`;
    if (!cache.has(key))
      cache.set(
        key,
        loadRec(
          join(capture(leg), `recording.rs8${arm === 1 ? "" : `.arm-${arm}`}`),
        ),
      );
    return cache.get(key)!;
  };
  const lines = (leg: string) =>
    jsonlOf<RecoverLine>(join(capture(leg), "recover.jsonl"));
  const steps = (leg: string) =>
    jsonlOf<StepLine>(join(capture(leg), "steps.jsonl"));
  const oracle = (leg: string) =>
    jsonlOf<FloatHoldOracle>(join(capture(leg), "textures.jsonl"));
  const rids = (leg: string) =>
    Object.fromEntries(
      lines(leg)
        .filter((l) => l.event === "rid")
        .map((l) => [l.name!, l.rid!]),
    );
  const window = (leg: string) => ({
    first: rec(leg).rec?.transactions[0]?.frame ?? NaN,
    last: rec(leg).rec?.transactions.at(-1)?.frame ?? NaN,
  });
  const compare = (leg: string) => {
    const born = rec("born").rec,
      arm = rec(leg).rec;
    const settle = steps(leg).find((s) => s.step === 1)?.settle_frame;
    return born && arm && settle !== undefined
      ? equivalence(born, arm, settle, 0, {}).problems
      : null;
  };
  const schedule = (leg: string) =>
    floatRecoverSchedule(steps(leg), lines(leg), window(leg));
  const skip = (leg: string) =>
    recoverSkipProblems(
      evidence(leg, 1, "hold.json"),
      rids(leg),
      window(leg),
      steps(leg).find((s) => s.step === 1) ?? null,
    );
  const add = (
    id: string,
    legs: string[],
    criterion: string,
    judge: () => string[],
    detail: string,
  ) => {
    const present = legs.some((leg) => existsSync(capture(leg)));
    const pre = legs.flatMap((leg) => {
      const exit = join(capture(leg), "exit-code.txt");
      return existsSync(exit) && readFileSync(exit, "utf8").trim() === "0"
        ? []
        : [`${leg}: missing or nonzero exit`];
    });
    checks.push(
      selectedCheck(
        !present
          ? {
              id,
              criterion,
              passed: false,
              status: "not-run",
              gating: false,
              detail: "float-recover legs absent",
            }
          : check(id, criterion, [...pre, ...judge()], detail),
        g,
        "float-recover",
      ),
    );
  };
  add(
    "float-recover-equivalence",
    ["standby", "born"],
    "Arm 1 equals born after step 1 settles, with recovered textures published and absent at its first frame",
    () => [
      ...schedule("standby"),
      ...floatRecoverSchedule(steps("born"), lines("born"), window("standby")),
      ...[1, 2].flatMap((arm) =>
        rec("standby", arm).error ? [rec("standby", arm).error!] : [],
      ),
      ...(rec("born").error ? [rec("born").error!] : []),
      ...floatRecoverEquivalenceProblems(compare("standby")),
      ...floatRecoverCells(
        rec("standby").rec?.transactions[0]?.state ?? null,
        oracle("standby"),
        "first",
      ),
      ...floatRecoverCells(
        rec("standby").rec?.transactions.at(-1)?.state ?? null,
        oracle("standby"),
        "last",
      ),
      ...[1, 2].flatMap((arm) =>
        fieldsMatch(
          evidence("standby", arm, "warm.json"),
          {
            schema: "render-stream-warm/1",
            final: true,
            arm_index: arm,
            decode_at_reference: 0,
            "textures.refused": 2,
            "textures.refused_no_image": 2,
            "textures.recovered": arm === 1 ? 2 : 0,
          },
          `warm arm ${arm}`,
        ),
      ),
    ],
    "arm 1 equals born from step-1 settle; 3 recovered cells and 7 controls published; initial refused cells absent; warm counts 2/2/2 and 2/2/0",
  );
  add(
    "float-recover-evidence",
    ["standby", "born"],
    "Every refusal and hold skip identifies its texture, recovery, dependents and arm with balanced teardown",
    () => {
      const hold = evidence("standby", 1, "hold.json");
      return [
        ...skip("standby"),
        ...fieldsMatch(hold, { fault: "hold-off" }, "hold"),
        ...[1, 2].flatMap((arm) => {
          const refusal = evidence("standby", arm, "refusals.json");
          const records = arrayOf(evidenceField(refusal, "records"));
          const last = evidenceField(
            records.find(
              (r) => evidenceField(r, "rid") === rids("standby").img_big,
            ),
            "last_skip",
          );
          const source = arrayOf(evidenceField(hold, "skip_records")).find(
            (r) => evidenceField(r, "seq") === evidenceField(last, "seq"),
          );
          return [
            ...recoverRefusalProblems(refusal, rids("standby"), arm, "standby"),
            ...(!source || !eq(source, last)
              ? [`arm ${arm}: last_skip differs from hold record`]
              : []),
            ...fieldsMatch(
              evidence("standby", arm, "teardown.json"),
              { "mirror.recover_index": 0, adopt_held: 0 },
              `teardown arm ${arm}`,
            ),
          ];
        }),
        ...["hold.json", "refusals.json"].flatMap((f) =>
          existsSync(join(capture("born"), "evidence", f))
            ? [`born has ${f}`]
            : [],
        ),
      ];
    },
    "2 exact skip records; 2 refusals per arm; replace recovery 2 then 0; index adoption 1; last_skip matches hold; both teardowns empty; born evidence absent",
  );
  add(
    "fault-republish-caught",
    ["fault-republish", "born"],
    "The fault knob recovers texture entries while leaving their materials unpublished and controls published",
    () => [
      ...schedule("fault-republish"),
      ...skip("fault-republish"),
      ...fieldsMatch(
        evidence("fault-republish", 1, "hold.json"),
        { fault: "hold-off-skip-republish" },
        "hold",
      ),
      ...faultRepublishProblems(
        compare("fault-republish"),
        rec("fault-republish").rec?.transactions.at(-1)?.state ?? null,
        oracle("fault-republish"),
        evidence("fault-republish", 1, "refusals.json"),
        rids("fault-republish"),
      ),
    ],
    "equivalence fails; all 3 recovered texture entries present but unpublished; 7 controls published; skipped_fault 3; unresolved materials 2/1/1",
  );
  return {
    checks,
    report: Object.fromEntries(
      ["standby", "fault-republish"].map((leg) => [
        leg,
        {
          first: recoverCellTable(
            rec(leg).rec?.transactions[0]?.state ?? null,
            oracle(leg),
            "first",
          ),
          last: recoverCellTable(
            rec(leg).rec?.transactions.at(-1)?.state ?? null,
            oracle(leg),
            "last",
          ),
        },
      ]),
    ),
  };
}

function selectedCheck(c: G8aCheck, g: string, fx: string): G8aCheck {
  if (!existsSync(join(g, fx, "not-selected.txt"))) return c;
  return {
    ...c,
    passed: false,
    status: "not-run",
    gating: false,
    detail: "not selected by G8RE_ONLY",
  };
}

export async function runG8re(
  out: string,
): Promise<{ checks: G8aCheck[]; report: Record<string, unknown> }> {
  const g = join(out, "g8re");
  const checks: G8aCheck[] = [];
  const report: Record<string, unknown> = {};
  for (const fx of ["adopt", "tex", "tex-htr", "tex-evict"] as const) {
    const r = rearmEquivalence(g, fx);
    checks.push(selectedCheck(r.check, g, fx));
    report[fx] = r.report;
  }
  const id = idRound(g);
  checks.push(...id.checks.map((c) => selectedCheck(c, g, "id")));
  report.id = id.report;
  checks.push(
    reloadSourceCheck(g),
    ...textureReloadChecks(g),
    ...textureEvictChecks(g),
    ...warmChecks(g),
  );
  const floatHold = floatHoldChecks(g);
  checks.push(...floatHold.checks);
  report["float-hold"] = floatHold.report;
  const floatRecover = floatRecoverChecks(g);
  checks.push(...floatRecover.checks);
  report["float-recover"] = floatRecover.report;
  return { checks, report };
}
