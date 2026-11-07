// Gate 8 g8res checks (LATE-RES; LAR5): a capture armed late must adopt
// pre-arm resources first drawn after the arm -- a pre-arm texture (G8r) and a pre-arm item that
// enters the tree after the arm (the pooled node, LATE-RES's node_added adoption) -- leaving no
// unknown item RIDs. LAR5 adopts a pre-arm GPUParticles2D emitter and its ParticleProcessMaterial
// purely from the registry, so those two are judged on the `deferred` arm (extension loaded at
// birth, armed at frame 12 by GRC_ARM_DEFER_FRAMES=11); on the `late` arm the emitter is refused
// `preload-particles`. The fixture is fixtures/gate8-res; the check is capture-only (result.json
// and the recording's resolved tables).
//
//   res-legs          every leg that ran exited 0
//   res-late-adopt    deferred/capture adopts the texture, the emitter, both process materials
//                     (ppm_registry) and both pre-arm items, nothing refused, unknown_material_keyed
//                     exactly 0 (the registered material is adopted at the post-arm emitter's
//                     reference), no unknown-texture / unknown-material, residue 0
//   res-late-adopt-catches-registry-queue-drop  LAR6: deferred under GRC_ADOPT_FAULT=registry-queue-drop
//                     (the off-main queue discarded) fails res-late-adopt (the loader-thread texture)
//   res-late-residual late/capture adopts the texture and items, refuses the emitter
//                     preload-particles (emitters 0), keys the unregistered material through the
//                     LATE-RES re-link (unknown_material_keyed >= 1), residue 0
//   res-free          after the adoption the fixture frees the adopted cells; the deferred capture
//                     records them freed
//   res-late-fault    under GRC_ADOPT_FAULT=no-resources nothing pre-arm is adopted and the pre-arm
//                     items stay unknown (the pre-LATE-RES capture)

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  check,
  exitCode,
  type G8aCheck,
  readJson,
  skipped,
} from "./gate8-adopt-checks";
import {
  type ResolvedRecording,
  resolveRecording,
  validateRecording,
} from "./render-stream-2";

export interface G8resExpected {
  schema: string;
  arm_frame: number;
  quit_frame: number;
  textures: number;
  items_adopted: number;
  emitters: number;
  process_materials: number;
  unknown_material_keyed: number;
  /** LAR5: the deferred arm (registry-adopted emitter and process materials) */
  deferred: {
    emitters: number;
    process_materials: number;
    ppm_registry: number;
    unknown_material_keyed: number;
    /** LAR6: the pre-arm texture and the loader-thread one (res.gd frame 16) */
    textures?: number;
    /** LAR6: references adopted from the off-main queue (the loader-thread one) */
    offmain_adopted?: number;
  };
  /** LAR5: the late arm (the pre-arm emitter refused preload-particles) */
  late: {
    emitters: number;
    refused_preload_particles: number;
    unknown_material_keyed: number;
  };
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

const LEGS = [
  "import/fixture",
  "late/capture",
  "deferred/capture",
  "fault-no-resources/capture",
  "sabotage-registry-queue-drop/capture",
];
const SINKS = ["recording.rs12", "recording-patch.rs12"] as const;

export interface CaptureResult {
  stream?: {
    gate8?: {
      adopt_stats?: {
        resources?: Record<string, number>;
        material_adoption?: Record<string, number>;
        residue?: number | null;
      };
      particles?: {
        adoption?: Record<string, number>;
        unknown_material_keyed?: number;
      };
    };
  };
}

function adoptionResources(
  r: CaptureResult | undefined,
): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.resources;
}
function materialAdoption(
  r: CaptureResult | undefined,
): Record<string, number> | undefined {
  return r?.stream?.gate8?.adopt_stats?.material_adoption;
}
function particlesAdoption(
  r: CaptureResult | undefined,
): Record<string, number> | undefined {
  return r?.stream?.gate8?.particles?.adoption;
}

/** The unsupported commands with reason `unknown-texture`, over every transaction. */
function unknownTextureCount(
  rec: Pick<ResolvedRecording, "transactions">,
): number {
  let n = 0;
  for (const t of rec.transactions)
    for (const it of t.state.items)
      for (const c of it.commands)
        if (c.op === "unsupported" && c.reason === "unknown-texture") n++;
  return n;
}

/** The particles entries `unsupported`/`unknown-material`, over every transaction. */
function unknownMaterialParticles(
  rec: Pick<ResolvedRecording, "transactions">,
): number {
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
export function freedCounts(
  txs: readonly ResFreeTx[],
  freeFrame: number,
): ResFreedCounts | null {
  let before: ResFreeTx | undefined;
  for (const t of txs) if (t.frame < freeFrame) before = t;
  const last = txs.at(-1);
  if (!before || !last || last === before || last.frame < freeFrame)
    return null;
  const gone = (
    was: readonly { id: number; status?: string }[],
    now: readonly { id: number; status?: string }[],
  ) => {
    const live = new Set(
      now.filter((e) => e.status !== "freed").map((e) => e.id),
    );
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
  expected: Pick<
    G8resExpected,
    "free_frame" | "freed_items" | "freed_textures" | "freed_particles"
  >,
): string[] {
  const f = freedCounts(txs, expected.free_frame);
  if (!f)
    return [
      `no transaction before and after the free at frame ${expected.free_frame} (${txs.length} transactions)`,
    ];
  const problems: string[] = [];
  for (const k of ["items", "textures", "particles"] as const) {
    const want = expected[`freed_${k}` as "freed_items"];
    if (!(want > 0))
      problems.push(`expected.freed_${k} must be positive (got ${want})`);
    else if (f[k] < want)
      problems.push(
        `${f[k]} ${k} freed after frame ${expected.free_frame}, ${want} expected`,
      );
  }
  return problems;
}

async function loadResRecording(
  legDir: string,
): Promise<{ rec?: ResolvedRecording; error?: string }> {
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
  expected: Pick<G8resExpected, "textures" | "items_adopted" | "deferred">,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const res = adoptionResources(r);
  const mat = materialAdoption(r);
  const parts: string[] = [];
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    const wantTextures = expected.deferred.textures ?? expected.textures;
    if ((res.textures ?? 0) < wantTextures)
      problems.push(
        `adopted ${res.textures} textures, ${wantTextures} expected`,
      );
    // LAR6: the loader-thread reference is adopted from the off-main queue at a frame boundary.
    const wantOffmain = expected.deferred.offmain_adopted ?? 0;
    if ((res.offmain_adopted ?? 0) < wantOffmain)
      problems.push(
        `${res.offmain_adopted ?? 0} off-main references adopted, ${wantOffmain} expected (queued ${res.offmain_queued ?? 0}, dropped ${res.offmain_dropped ?? 0})`,
      );
    if ((res.textures_refused ?? 0) !== 0)
      problems.push(`refused ${res.textures_refused} textures`);
    parts.push(`textures ${res.textures} (refused ${res.textures_refused})`);
  }
  if (!mat) problems.push("no stream.gate8.adopt_stats.material_adoption");
  else {
    if ((mat.items_adopted ?? 0) < expected.items_adopted)
      problems.push(
        `adopted ${mat.items_adopted} post-arm items, ${expected.items_adopted} expected`,
      );
    parts.push(`items_adopted ${mat.items_adopted}`);
  }
  const pa = particlesAdoption(r);
  if (!pa) problems.push("no stream.gate8.particles.adoption");
  else {
    const want = expected.deferred;
    if ((pa.emitters ?? 0) < want.emitters)
      problems.push(
        `adopted ${pa.emitters} emitters, ${want.emitters} expected`,
      );
    if ((pa.ppm_materials ?? 0) < want.process_materials)
      problems.push(
        `adopted ${pa.ppm_materials} process materials, ${want.process_materials} expected`,
      );
    if ((pa.ppm_registry ?? 0) < want.ppm_registry)
      problems.push(
        `${pa.ppm_registry} process materials adopted from the registry, ${want.ppm_registry} expected`,
      );
    for (const k of ["refused", "ppm_refused", "refused_preload_particles"])
      if ((pa[k] ?? 0) !== 0) problems.push(`${k} ${pa[k]}`);
    parts.push(
      `emitters ${pa.emitters}, ppm_materials ${pa.ppm_materials} (registry ${pa.ppm_registry})`,
    );
  }
  const ppm = r?.stream?.gate8?.particles;
  if (!ppm) problems.push("no stream.gate8.particles");
  else {
    if (
      (ppm.unknown_material_keyed ?? 0) !==
      expected.deferred.unknown_material_keyed
    )
      problems.push(
        `${ppm.unknown_material_keyed} unknown-material process materials keyed, exactly ${expected.deferred.unknown_material_keyed} expected`,
      );
    parts.push(`unknown_material_keyed ${ppm.unknown_material_keyed}`);
  }
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const unknown = unknownTextureCount(rec.rec);
    if (unknown > 0)
      problems.push(`${unknown} unknown-texture commands over the recording`);
    const unknownMat = unknownMaterialParticles(rec.rec);
    if (unknownMat > 0)
      problems.push(
        `${unknownMat} unknown-material particles over the recording`,
      );
    const last = rec.rec.transactions.at(-1);
    if (!last) problems.push("no transaction");
    else {
      if ((last.state.unknown_items?.unknown_rids ?? 0) !== 0)
        problems.push(
          `last state: ${last.state.unknown_items?.unknown_rids} unknown item RIDs`,
        );
      if ((last.state.unknown_items?.withheld_items ?? 0) !== 0)
        problems.push(
          `last state: ${last.state.unknown_items?.withheld_items} items withheld`,
        );
    }
  }
  problems.push(...sinkProblems);
  return { problems, detail: parts.join(", ") };
}

/** res-late-residual's verdict (LAR5): the late capture still adopts the texture and the pre-arm
 * items at their first post-arm draw, but the pre-arm emitter is unregistered and refused
 * `preload-particles` (never adopted, so emitters 0), and its unregistered process material is
 * keyed through the LATE-RES re-link when a post-arm emitter references it. Pure. */
export function judgeResLateResidual(
  r: CaptureResult | undefined,
  rec: { rec?: Pick<ResolvedRecording, "transactions">; error?: string },
  sinkProblems: readonly string[],
  expected: Pick<G8resExpected, "textures" | "items_adopted" | "late">,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  const parts: string[] = [];
  const res = adoptionResources(r);
  if (!res) problems.push("no stream.gate8.adopt_stats.resources");
  else {
    if ((res.textures ?? 0) < expected.textures)
      problems.push(
        `adopted ${res.textures} textures, ${expected.textures} expected`,
      );
    if ((res.textures_refused ?? 0) !== 0)
      problems.push(`refused ${res.textures_refused} textures`);
    parts.push(`textures ${res.textures}`);
  }
  const mat = materialAdoption(r);
  if (!mat) problems.push("no stream.gate8.adopt_stats.material_adoption");
  else {
    if ((mat.items_adopted ?? 0) < expected.items_adopted)
      problems.push(
        `adopted ${mat.items_adopted} post-arm items, ${expected.items_adopted} expected`,
      );
    parts.push(`items_adopted ${mat.items_adopted}`);
  }
  const pa = particlesAdoption(r);
  if (!pa) problems.push("no stream.gate8.particles.adoption");
  else {
    const want = expected.late;
    if ((pa.emitters ?? 0) !== want.emitters)
      problems.push(
        `adopted ${pa.emitters} emitters, ${want.emitters} expected`,
      );
    if ((pa.refused_preload_particles ?? 0) !== want.refused_preload_particles)
      problems.push(
        `refused_preload_particles ${pa.refused_preload_particles}, ${want.refused_preload_particles} expected`,
      );
    if ((pa.refused ?? 0) !== want.refused_preload_particles)
      problems.push(
        `refused ${pa.refused}, ${want.refused_preload_particles} expected`,
      );
    parts.push(
      `emitters ${pa.emitters}, refused_preload_particles ${pa.refused_preload_particles}`,
    );
  }
  const ppm = r?.stream?.gate8?.particles;
  if (!ppm) problems.push("no stream.gate8.particles");
  else {
    if (
      (ppm.unknown_material_keyed ?? 0) < expected.late.unknown_material_keyed
    )
      problems.push(
        `${ppm.unknown_material_keyed} unknown-material process materials keyed, at least ${expected.late.unknown_material_keyed} expected`,
      );
    parts.push(`unknown_material_keyed ${ppm.unknown_material_keyed}`);
  }
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    const last = rec.rec.transactions.at(-1);
    if (!last) problems.push("no transaction");
    else {
      if ((last.state.unknown_items?.unknown_rids ?? 0) !== 0)
        problems.push(
          `last state: ${last.state.unknown_items?.unknown_rids} unknown item RIDs`,
        );
      if ((last.state.unknown_items?.withheld_items ?? 0) !== 0)
        problems.push(
          `last state: ${last.state.unknown_items?.withheld_items} items withheld`,
        );
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
  else if ((res.textures ?? 0) !== 0)
    problems.push(`adopted ${res.textures} textures under the fault`);
  if (!mat) problems.push("no stream.gate8.adopt_stats.material_adoption");
  else if ((mat.items_adopted ?? 0) !== 0)
    problems.push(`adopted ${mat.items_adopted} items under the fault`);
  if (!rec.rec) problems.push(rec.error ?? "no recording");
  else {
    if (rec.rec.transactions.length === 0) problems.push("no transaction");
    if (unknownTextureCount(rec.rec) === 0)
      problems.push("no unknown-texture command under the fault");
    const unknownRids = Math.max(
      0,
      ...rec.rec.transactions.map(
        (t) => t.state.unknown_items?.unknown_rids ?? 0,
      ),
    );
    if (unknownRids < 2)
      problems.push(
        `at most ${unknownRids} unknown RIDs, expected >= 2 (the pre-arm items)`,
      );
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
    checks.push(
      check(
        "res-legs",
        "LATE-RES: every g8res leg that ran exited 0",
        any ? problems : null,
      ),
    );
  }

  // res-late-adopt
  {
    const leg = "deferred/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["deferred/capture did not run"];
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
        "LATE-RES, LAR5: the deferred capture (loaded at birth, armed at frame 12) adopts the pre-arm texture and both pre-arm items at their first post-arm draw and the emitter with both process materials from the registry (unknown_material_keyed exactly 0), nothing refused, no unknown-texture / unknown-material, nothing withheld",
        problems,
        detail,
      ),
    );
  }

  // res-late-adopt-catches-registry-queue-drop (LAR6's sabotage)
  {
    const leg = "sabotage-registry-queue-drop/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      const r = await result(leg);
      const j = judgeResLateAdopt(
        r,
        await loadResRecording(dir(leg)),
        await validateSinkProblems(dir(leg)),
        expected,
      );
      const res = adoptionResources(r);
      problems = [];
      if (j.problems.length === 0)
        problems.push("res-late-adopt passed on the sabotaged capture");
      if (!((res?.offmain_dropped ?? 0) >= 1))
        problems.push(
          `offmain_dropped ${res?.offmain_dropped ?? 0}, expected >= 1`,
        );
      detail = `res-late-adopt: ${j.problems.slice(0, 2).join("; ") || "passed"}`;
    }
    checks.push(
      check(
        "res-late-adopt-catches-registry-queue-drop",
        "LAR6: under GRC_ADOPT_FAULT=registry-queue-drop (the frame boundary discards the off-main queue) the deferred capture never adopts the loader-thread texture and res-late-adopt fails",
        problems,
        detail,
      ),
    );
  }

  // res-late-residual
  {
    const leg = "late/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["late/capture did not run"];
    } else {
      const j = judgeResLateResidual(
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
        "res-late-residual",
        "LAR5: the late capture (extension loaded at the arm) still adopts the pre-arm texture and items, refuses the pre-arm emitter preload-particles (no emitter adopted), keys the unregistered process material through the LATE-RES re-link, and leaves no unknown item RIDs",
        problems,
        detail,
      ),
    );
  }

  // res-free
  {
    const leg = "deferred/capture";
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (!ran(leg)) {
      problems = ["deferred/capture did not run"];
    } else {
      const rec = await loadResRecording(dir(leg));
      if (!rec.rec) problems = [rec.error ?? "no recording"];
      else {
        problems = resFreeProblems(rec.rec.transactions, expected);
        const f = freedCounts(rec.rec.transactions, expected.free_frame);
        if (f)
          detail = `freed ${f.items} items, ${f.textures} textures, ${f.particles} emitters (frames ${f.before_seq_frame} -> ${f.last_frame})`;
      }
    }
    checks.push(
      check(
        "res-free",
        "LATE-RES, LAR5: after the adoption the fixture frees the adopted texture, emitter and items (res.gd FREE_FRAME), and the deferred capture (the arm that adopts the emitter) records them freed (removed or a freed tombstone)",
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
