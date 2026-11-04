// Gate 8 g8res checks (LATE-RES, results/p3/late-res.md): a capture armed LATE (fixture frame 12)
// must adopt pre-arm resources first drawn after the arm -- a pre-arm texture (G8r), a pre-arm
// ParticleProcessMaterial (PM7) and a pre-arm item that enters the tree after the arm (the pooled
// node, LATE-RES's node_added adoption) -- leaving no unknown item RIDs. The fixture is
// fixtures/gate8-res; the check is capture-only (result.json and the recording's resolved tables).
//
//   res-legs        every leg that ran exited 0
//   res-late-adopt  the late capture adopts the texture, process material and both pre-arm items,
//                   nothing refused, no unknown-texture / unknown-material, residue 0
//   res-free        after the adoption the fixture frees the adopted cells; the capture records them freed
//   res-late-fault  under GRC_ADOPT_FAULT=no-resources nothing pre-arm is adopted and the pre-arm
//                   items stay unknown (the pre-LATE-RES capture)

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { check, exitCode, readJson, skipped, type G8aCheck } from "./gate8-adopt-checks";
import { resolveRecording, validateRecording, type ResolvedRecording } from "./render-stream-2";

export interface G8resExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  textures: number;
  items_adopted: number;
  emitters: number;
  process_materials: number;
  unknown_material_keyed: number;
  /** the fixture frame that frees the adopted TEX / PPM / ITEM cells (res.gd FREE_FRAME) */
  free_frame: number;
  /** the least items / textures / particle emitters the free removes (or tombstones) */
  freed_items: number;
  freed_textures: number;
  freed_particles: number;
}

export interface G8resReport {
  legs: Record<string, unknown>;
}

const LEGS = ["import/fixture", "late/capture", "fault-no-resources/capture"];
const SINKS = ["recording.rs12", "recording-patch.rs12"] as const;

export interface CaptureResult {
  stream?: {
    gate8?: {
      adopt_stats?: {
        resources?: Record<string, number>;
        material_adoption?: Record<string, number>;
        residue?: number | null;
      };
      particles?: { adoption?: Record<string, number>; unknown_material_keyed?: number };
    };
  };
}

function adoptionResources(r: CaptureResult | undefined): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.resources;
}
function materialAdoption(r: CaptureResult | undefined): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.material_adoption;
}
function particlesAdoption(r: CaptureResult | undefined): Record<string, number> | undefined {
  return r?.stream?.gate8?.particles?.adoption;
}

/** The unsupported commands with reason `unknown-texture`, over every transaction. */
function unknownTextureCount(rec: Pick<ResolvedRecording, "transactions">): number {
  let n = 0;
  for (const t of rec.transactions)
    for (const it of t.state.items)
      for (const c of it.commands)
        if (c.op === "unsupported" && c.reason === "unknown-texture") n++;
  return n;
}

/** The particles entries `unsupported`/`unknown-material`, over every transaction. */
function unknownMaterialParticles(rec: Pick<ResolvedRecording, "transactions">): number {
  let n = 0;
  for (const t of rec.transactions)
    for (const p of t.state.particles ?? [])
      if (p.status === "unsupported" && p.reason === "unknown-material") n++;
  return n;
}

/** The slice of a resolved transaction the free check reads (a ResolvedTransaction satisfies it). */
export interface ResFreeTx {
  frame: number;
  state: {
    items: readonly { id: number }[];
    textures: readonly { id: number; status: string }[];
    particles?: readonly { id: number; status: string }[];
  };
}

export interface ResFreedCounts {
  items: number;
  textures: number;
  particles: number;
  /** the transaction judged "before" the free (the last with frame < freeFrame) and the last one */
  before_seq_frame: number;
  last_frame: number;
}

/** The ids of the last transaction before `freeFrame` (items, ok textures, ok particles) that the
 * last transaction no longer holds or holds as a `freed` tombstone: what the capture records of the
 * fixture's free. Null when there is no transaction before the free or none at or after it. */
export function freedCounts(txs: readonly ResFreeTx[], freeFrame: number): ResFreedCounts | null {
  let before: ResFreeTx | undefined;
  for (const t of txs) if (t.frame < freeFrame) before = t;
  const last = txs.at(-1);
  if (!before || !last || last === before || last.frame < freeFrame) return null;
  const gone = (
    was: readonly { id: number; status?: string }[],
    now: readonly { id: number; status?: string }[],
  ) => {
    const live = new Set(now.filter((e) => e.status !== "freed").map((e) => e.id));
    return was.filter((e) => e.status !== "freed" && !live.has(e.id)).length;
  };
  return {
    items: gone(before.state.items, last.state.items),
    textures: gone(before.state.textures, last.state.textures),
    particles: gone(before.state.particles ?? [], last.state.particles ?? []),
    before_seq_frame: before.frame,
    last_frame: last.frame,
  };
}

/** res-free problems: the capture records the freed items, texture and emitter (empty -> fails). */
export function resFreeProblems(
  txs: readonly ResFreeTx[],
  expected: Pick<G8resExpected, "free_frame" | "freed_items" | "freed_textures" | "freed_particles">,
): string[] {
  const f = freedCounts(txs, expected.free_frame);
  if (!f)
    return [`no transaction before and after the free at frame ${expected.free_frame} (${txs.length} transactions)`];
  const problems: string[] = [];
  for (const k of ["items", "textures", "particles"] as const) {
    const want = expected[`freed_${k}` as "freed_items"];
    if (!(want > 0)) problems.push(`expected.freed_${k} must be positive (got ${want})`);
    else if (f[k] < want) problems.push(`${f[k]} ${k} freed after frame ${expected.free_frame}, ${want} expected`);
  }
  return problems;
}

async function loadResRecording(legDir: string): Promise<{ rec?: ResolvedRecording; error?: string }> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(join(legDir, SINKS[0])));
  } catch {
    return { error: `${SINKS[0]} missing` };
  }
  try {
    return { rec: resolveRecording(data, 12) };
  } catch (e) {
    return { error: `${SINKS[0]}: ${(e as Error).message}` };
  }
}

/** Both /12 sinks validated through the TypeScript validator. */
async function validateSinkProblems(legDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const sink of SINKS) {
    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(join(legDir, sink)));
    } catch {
      problems.push(`${sink}: missing`);
      continue;
    }
    const errors = validateRecording(data, 12);
    if (errors.length > 0) problems.push(`${sink}: ${errors[0].slice(0, 240)}`);
  }
  return problems;
}

/** res-late-adopt's verdict from the capture's result.json, its loaded recording and the sinks'
 * validation problems. Pure: a missing result, a missing/empty recording or an absent table fails. */
export function judgeResLateAdopt(
  r: CaptureResult | undefined,
  rec: { rec?: Pick<ResolvedRecording, "transactions">; error?: string },
  sinkProblems: readonly string[],
  expected: Pick<
    G8resExpected,
    "textures" | "items_adopted" | "emitters" | "process_materials" | "unknown_material_keyed"
  >,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const res = adoptionResources(r);
  const mat = materialAdoption(r);
  const parts: string[] = [];
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if ((res.textures ?? 0) < expected.textures)
      problems.push(`adopted ${res.textures} textures, ${expected.textures} expected`);
    if ((res.textures_refused ?? 0) !== 0) problems.push(`refused ${res.textures_refused} textures`);
    parts.push(`textures ${res.textures} (refused ${res.textures_refused})`);
  }
  if (!mat) problems.push("no stream.gate8.adopt_stats.material_adoption");
  else {
    if ((mat.items_adopted ?? 0) < expected.items_adopted)
      problems.push(`adopted ${mat.items_adopted} post-arm items, ${expected.items_adopted} expected`);
    parts.push(`items_adopted ${mat.items_adopted}`);
  }
  const pa = particlesAdoption(r);
  if (!pa) problems.push("no stream.gate8.particles.adoption");
  else {
    if ((pa.emitters ?? 0) < expected.emitters)
      problems.push(`adopted ${pa.emitters} emitters, ${expected.emitters} expected`);
    if ((pa.ppm_materials ?? 0) < expected.process_materials)
      problems.push(`adopted ${pa.ppm_materials} process materials, ${expected.process_materials} expected`);
    for (const k of ["refused", "ppm_refused"]) if ((pa[k] ?? 0) !== 0) problems.push(`${k} ${pa[k]}`);
    parts.push(`emitters ${pa.emitters}, ppm_materials ${pa.ppm_materials}`);
  }
  const ppm = r?.stream?.gate8?.particles;
  if (!ppm) problems.push("no stream.gate8.particles");
  else if ((ppm.unknown_material_keyed ?? 0) < expected.unknown_material_keyed)
    problems.push(`${ppm.unknown_material_keyed} unknown-material process materials keyed, ${expected.unknown_material_keyed} expected`);
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const unknown = unknownTextureCount(rec.rec);
    if (unknown > 0) problems.push(`${unknown} unknown-texture commands over the recording`);
    const unknownMat = unknownMaterialParticles(rec.rec);
    if (unknownMat > 0) problems.push(`${unknownMat} unknown-material particles over the recording`);
    const last = rec.rec.transactions.at(-1);
    if (!last) problems.push("no transaction");
    else {
      if ((last.state.unknown_items?.unknown_rids ?? 0) !== 0)
        problems.push(`last state: ${last.state.unknown_items?.unknown_rids} unknown item RIDs`);
      if ((last.state.unknown_items?.withheld_items ?? 0) !== 0)
        problems.push(`last state: ${last.state.unknown_items?.withheld_items} items withheld`);
    }
  }
  problems.push(...sinkProblems);
  return { problems, detail: parts.join(", ") };
}

/** res-late-fault's verdict (same inputs; no expected counts: the fault adopts nothing). */
export function judgeResLateFault(
  r: CaptureResult | undefined,
  rec: { rec?: Pick<ResolvedRecording, "transactions">; error?: string },
  sinkProblems: readonly string[],
): string[] {
  const problems: string[] = [];
  const res = adoptionResources(r);
  const mat = materialAdoption(r);
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else if ((res.textures ?? 0) !== 0) problems.push(`adopted ${res.textures} textures under the fault`);
  if (!mat) problems.push("no stream.gate8.adopt_stats.material_adoption");
  else if ((mat.items_adopted ?? 0) !== 0) problems.push(`adopted ${mat.items_adopted} items under the fault`);
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    if (rec.rec.transactions.length === 0) problems.push("no transaction");
    if (unknownTextureCount(rec.rec) === 0)
      problems.push("no unknown-texture command under the fault");
    const unknownRids = Math.max(
      0,
      ...rec.rec.transactions.map((t) => t.state.unknown_items?.unknown_rids ?? 0),
    );
    if (unknownRids < 2) problems.push(`at most ${unknownRids} unknown RIDs, expected >= 2 (the pre-arm items)`);
  }
  problems.push(...sinkProblems);
  return problems;
}

export async function runG8res(
  out: string,
  expected: G8resExpected,
): Promise<{ checks: G8aCheck[]; report: G8resReport }> {
  const g = join(out, "g8res");
  const checks: G8aCheck[] = [];
  const report: G8resReport = { legs: {} };
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => existsSync(join(dir(leg), "exit-code.txt"));
  const result = async (leg: string) =>
    readJson<CaptureResult>(join(dir(leg), "evidence", "result.json"));

  // res-legs
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of LEGS) {
      if (skipped(dir(leg))) continue;
      const rc = await exitCode(dir(leg));
      if (rc === null) problems.push(`${leg}: did not run`);
      else {
        any = true;
        if (rc !== "0") problems.push(`${leg}: exit ${rc}`);
      }
    }
    checks.push(check("res-legs", "LATE-RES: every g8res leg that ran exited 0", any ? problems : null));
  }

  // res-late-adopt
  {
    const leg = "late/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      const j = judgeResLateAdopt(
        await result(leg),
        await loadResRecording(dir(leg)),
        await validateSinkProblems(dir(leg)),
        expected,
      );
      problems = j.problems;
      detail = j.detail;
    }
    checks.push(
      check(
        "res-late-adopt",
        "LATE-RES: the late capture adopts the pre-arm texture, process material and both pre-arm items at their first post-arm draw, nothing refused, no unknown-texture / unknown-material, nothing withheld",
        problems,
        detail,
      ),
    );
  }

  // res-free
  {
    const leg = "late/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      const rec = await loadResRecording(dir(leg));
      if (!rec.rec) problems = [rec.error ?? "no recording"];
      else {
        problems = resFreeProblems(rec.rec.transactions, expected);
        const f = freedCounts(rec.rec.transactions, expected.free_frame);
        if (f) detail = `freed ${f.items} items, ${f.textures} textures, ${f.particles} emitters (frames ${f.before_seq_frame} -> ${f.last_frame})`;
      }
    }
    checks.push(
      check(
        "res-free",
        "LATE-RES: after the adoption the fixture frees the adopted texture, emitter and items (res.gd FREE_FRAME), and the capture records them freed (removed or a freed tombstone)",
        problems,
        detail,
      ),
    );
  }

  // res-late-fault
  {
    const leg = "fault-no-resources/capture";
    let problems: string[] | null = null;
    if (!ran(leg)) {
      problems = ["fault-no-resources/capture did not run"];
    } else {
      problems = judgeResLateFault(
        await result(leg),
        await loadResRecording(dir(leg)),
        await validateSinkProblems(dir(leg)),
      );
    }
    checks.push(
      check(
        "res-late-fault",
        "LATE-RES: under GRC_ADOPT_FAULT=no-resources nothing pre-arm is adopted and the pre-arm items stay unknown (the pre-LATE-RES capture)",
        problems,
      ),
    );
  }

  return { checks, report };
}
