// Gate 8 g8pt late-arm checks (PM7, protocol/render-stream-12.md "As built (PM7)"): the capture
// arms at fixture frame 12 (fixtures/gate8-pt/loader.gd RS_FIXTURE_ARM=late), after every emitter,
// process material, draw-pass mesh and texture exists, and adopts each GPUParticles2D emitter at
// its first draw after the arm. Before PM7 every such draw was unknown-particles and a receiver
// drew nothing; GRC_ADOPT_FAULT=no-particles is that capture.
//
//   pt-late-validate           both sinks of late/capture and fault-no-particles/capture pass the
//                              TypeScript validator and rs-core-check
//   pt-late-adopt              late/capture adopted every emitter (result.json
//                              stream.gate8.particles.adoption: expected.json late.emitters and
//                              process_materials, nothing refused); no transaction carries an
//                              unknown-particles add_particles; the last state's table holds that
//                              many entries, all origin "adopted" and ok, each process material ok
//                              on a shader with the particle_process_material builtin, and the
//                              subemitter cell's entry names another adopted emitter
//   pt-late-fault              the fault capture adopted no emitter and every add_particles is
//                              unknown-particles (the pre-PM7 capture, the sabotage's premise)
//   pt-late-lifecycle          late/receiver and late/receiver-patch light exactly the cells the
//                              unarmed reference lights, at every shot after the arm
//   pt-late-coverage           (banded) from late.coverage_from_frame on, each lit cell's ink is
//                              within the coverage band of the reference's
//   pt-late-outside-exact      outside every emitter region each late receiver equals the
//                              reference exactly
//   pt-late-lifecycle-catches-no-particles  the receiver on the fault capture fails
//                              pt-late-lifecycle (the emitters stay dark)
//
// The late legs' shots are the reference's shots after the arm, in frame order: the fixture logs
// only the steps that settle after it, and run-gate8.sh adds each settle frame's previous frame
// and the tails (g8pt_extra_seqs).

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck, readText, skipped } from "./gate8-adopt-checks";
import { mmCellDiff, type Rgba } from "./gate8-mm-checks";
import { type PtPixels, ptCoverageProblems, ptInk, ptLifecycleProblems, ptShots } from "./gate8-pt-receiver-checks";

export interface PtLate {
  arm_frame: number;
  emitters: number;
  process_materials: number;
  subemitter: string;
  coverage_from_frame: number;
}

/** The parts of a resolved state pt-late-adopt reads (gate8-pt-checks.ts PtTx). */
export interface PtLateTx {
  table: Map<number, { id: number; origin: string; status: string; amount: number; process_material: number | null; subemitter: number | null }>;
  materials: Map<number, { status: string; shader: number | null }>;
  shaders: Map<number, unknown>;
  items: Map<number, { add_particles: number; unsupported: Record<string, number> }>;
  item_unsupported: Record<string, number>;
}

/** stream.gate8.particles.adoption of a capture's result.json, or null. */
export function adoptionStats(result: Record<string, unknown> | null): Record<string, number> | null {
  const a = (((result?.stream as Record<string, unknown> | undefined)?.gate8 as Record<string, unknown> | undefined)?.particles as
    | Record<string, unknown>
    | undefined)?.adoption;
  return a && typeof a === "object" ? (a as Record<string, number>) : null;
}

function unknownParticles(txs: readonly PtLateTx[]): number {
  let n = 0;
  for (const tx of txs) {
    n += tx.item_unsupported["unknown-particles"] ?? 0;
    for (const it of tx.items.values()) n += it.unsupported["unknown-particles"] ?? 0;
  }
  return n;
}

/** pt-late-adopt's verdict on the adoption stats and the trace of one sink. */
export function ptLateAdoptProblems(
  stats: Record<string, number> | null,
  txs: readonly PtLateTx[],
  late: PtLate,
  subAmount: number | undefined,
): string[] {
  const problems: string[] = [];
  if (!stats) problems.push("no stream.gate8.particles.adoption in result.json");
  else {
    if (stats.emitters !== late.emitters) problems.push(`${stats.emitters} emitters adopted, ${late.emitters} expected`);
    if (stats.ppm_materials !== late.process_materials)
      problems.push(`${stats.ppm_materials} process materials adopted, ${late.process_materials} expected`);
    for (const k of ["refused", "ppm_refused"]) if ((stats[k] ?? 0) !== 0) problems.push(`${k} ${stats[k]}`);
  }
  if (txs.length === 0) return [...problems, "no transaction"];
  const unknown = unknownParticles(txs);
  if (unknown > 0) problems.push(`${unknown} unknown-particles add_particles over the recording`);
  const last = txs[txs.length - 1];
  const entries = [...last.table.values()];
  if (entries.length !== late.emitters) problems.push(`last state: ${entries.length} particles entries, ${late.emitters} expected`);
  let drawn = 0;
  for (const it of last.items.values()) drawn += it.add_particles;
  if (drawn !== late.emitters) problems.push(`last state: ${drawn} add_particles commands, ${late.emitters} expected`);
  for (const e of entries) {
    if (e.origin !== "adopted") problems.push(`entry ${e.id}: origin ${e.origin}`);
    if (e.status !== "ok") problems.push(`entry ${e.id}: status ${e.status}`);
    const m = e.process_material === null ? undefined : last.materials.get(e.process_material);
    if (!m) problems.push(`entry ${e.id}: no process material`);
    else {
      if (m.status !== "ok") problems.push(`entry ${e.id}: process material ${e.process_material} is ${m.status}`);
      const s = m.shader === null ? undefined : (last.shaders.get(m.shader) as { status?: string; builtin?: { kind?: string } | null } | undefined);
      if (!s || s.status !== "ok" || s.builtin?.kind !== "particle_process_material")
        problems.push(`entry ${e.id}: process shader ${m.shader} is not an ok particle_process_material builtin`);
    }
  }
  const sub = entries.find((e) => e.amount === subAmount);
  if (subAmount === undefined) problems.push(`expected.json names no amount for ${late.subemitter}`);
  else if (!sub) problems.push(`${late.subemitter} (amount ${subAmount}): no entry`);
  else if (sub.subemitter === null || !last.table.has(sub.subemitter) || sub.subemitter === sub.id)
    problems.push(`${late.subemitter}: subemitter ${String(sub.subemitter)} names no other entry`);
  return problems;
}

/** pt-late-fault: nothing adopted, every add_particles unknown. */
export function ptLateFaultProblems(stats: Record<string, number> | null, txs: readonly PtLateTx[], late: PtLate): string[] {
  const problems: string[] = [];
  if (!stats) problems.push("no stream.gate8.particles.adoption in result.json");
  else if (stats.emitters !== 0) problems.push(`${stats.emitters} emitters adopted under the fault`);
  const last = txs.at(-1);
  if (!last) return [...problems, "no transaction"];
  if (last.table.size !== 0) problems.push(`last state: ${last.table.size} particles entries`);
  let unknown = 0;
  for (const it of last.items.values()) unknown += it.unsupported["unknown-particles"] ?? 0;
  if (unknown !== late.emitters) problems.push(`last state: ${unknown} unknown-particles add_particles, ${late.emitters} expected`);
  return problems;
}

/** pt-late-ppm-builtin: under GRC_ADOPT_FAULT=ppm-no-shader (an engine that assigns the process
 *  material's shader outside get_rid()) every process material is recovered through the
 *  particle_process_material builtin, and the wire is otherwise the same as pt-late-adopt. */
export function ptLatePpmBuiltinProblems(
  stats: Record<string, number> | null,
  txs: readonly PtLateTx[],
  late: PtLate,
  subAmount: number | undefined,
): string[] {
  const problems: string[] = [];
  if (!stats) return ["no stream.gate8.particles.adoption in result.json"];
  if (stats.ppm_refused_no_shader !== late.process_materials)
    problems.push(`${stats.ppm_refused_no_shader} process materials named no shader, ${late.process_materials} expected`);
  if (stats.ppm_builtin !== late.process_materials)
    problems.push(`${stats.ppm_builtin} process materials recovered through the builtin, ${late.process_materials} expected`);
  return [...problems, ...ptLateAdoptProblems(stats, txs, late, subAmount)];
}

export interface PtLateDeps {
  validate: (path: string) => Promise<[string, string] | null>;
  trace: (leg: string, sink: string) => Promise<PtLateTx[] | null>;
  /** the cell's amount (the checker finds a cell by it) */
  amountOf: (cell: string) => number | undefined;
}

const SINKS = ["recording.rs12", "recording-patch.rs12"];
const CAPTURES = ["late/capture", "fault-no-particles/capture"];
const PPM_CAPTURE = "fault-ppm-no-shader/capture";
const RECEIVERS = ["late/receiver", "late/receiver-patch"];
const FAULT_RECEIVER = "fault-no-particles/receiver";
export const LATE_LEGS = [...CAPTURES, PPM_CAPTURE, ...RECEIVERS, FAULT_RECEIVER];

export async function runG8ptLate(
  g: string,
  checkpoints: readonly { step: number; settle: number }[],
  px: PtPixels,
  late: PtLate,
  deps: PtLateDeps,
  checks: G8aCheck[],
  report: Record<string, unknown>,
): Promise<void> {
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) => !skipped(dir(leg)) && readdirSafe(dir(leg)).includes("exit-code.txt");
  const json = async (path: string) => {
    try {
      return JSON.parse((await readText(path)) ?? "null") as Record<string, unknown> | null;
    } catch {
      return null;
    }
  };
  const anySkipped = [...CAPTURES, PPM_CAPTURE, ...RECEIVERS, FAULT_RECEIVER].find((l) => skipped(dir(l)));
  if (anySkipped) {
    for (const id of [
      "pt-late-validate",
      "pt-late-adopt",
      "pt-late-fault",
      "pt-late-ppm-builtin",
      "pt-late-lifecycle",
      "pt-late-coverage",
      "pt-late-outside-exact",
      "pt-late-lifecycle-catches-no-particles",
    ])
      checks.push({ id, criterion: "PM7: the late arm", passed: true, status: "not-run", detail: `skipped: ${anySkipped}`, gating: false });
    return;
  }

  // pt-late-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of [...CAPTURES, PPM_CAPTURE])
      for (const sink of SINKS) {
        if (!ran(leg)) continue;
        const v = await deps.validate(join(dir(leg), sink));
        if (!v) {
          problems.push(`${leg}/${sink}: missing`);
          continue;
        }
        any = true;
        if (v[0] !== "ok") problems.push(`${leg}/${sink}: TS ${v[0]}`);
        if (v[1] !== "ok") problems.push(`${leg}/${sink}: rs-core ${v[1]}`);
      }
    checks.push(check("pt-late-validate", "PM7: both sinks of the late and fault captures pass the TypeScript validator and rs-core-check", any ? problems : null));
  }

  // pt-late-adopt, pt-late-fault
  {
    const leg = "late/capture";
    const stats = adoptionStats(await json(join(dir(leg), "evidence", "result.json")));
    report.adoption = stats;
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = [];
      for (const sink of SINKS) {
        const t = await deps.trace(leg, sink);
        if (!t) problems.push(`${sink}: missing`);
        else for (const p of ptLateAdoptProblems(stats, t, late, deps.amountOf(late.subemitter))) problems.push(`${sink}: ${p}`);
      }
      problems = [...new Set(problems)];
    }
    checks.push(
      check(
        "pt-late-adopt",
        "PM7: the late capture adopts every pre-arm emitter (and its process material) at its first draw: no unknown-particles anywhere, every entry origin adopted and ok on an ok process material whose shader carries the particle_process_material builtin, the subemitter linked",
        problems,
        stats ? `adopted ${stats.emitters} emitters, ${stats.ppm_materials} process materials (${stats.ppm_params} params), ${stats.ppm_shaders} shaders, ${stats.meshes} meshes; ${stats.adopt_ns} ns` : undefined,
      ),
    );
    const f = "fault-no-particles/capture";
    let fp: string[] | null = null;
    if (ran(f)) {
      const t = await deps.trace(f, SINKS[0]);
      fp = t ? ptLateFaultProblems(adoptionStats(await json(join(dir(f), "evidence", "result.json"))), t, late) : ["no recording"];
    }
    checks.push(check("pt-late-fault", "PM7: under GRC_ADOPT_FAULT=no-particles no emitter is adopted and every add_particles is unknown-particles (the pre-PM7 capture)", fp));
  }

  // pt-late-ppm-builtin (LATE-PPM): the engine names no shader, so adoption falls back to the
  // particle_process_material builtin; the wire is otherwise the same as pt-late-adopt.
  {
    const leg = PPM_CAPTURE;
    const stats = adoptionStats(await json(join(dir(leg), "evidence", "result.json")));
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = [];
      for (const sink of SINKS) {
        const t = await deps.trace(leg, sink);
        if (!t) problems.push(`${sink}: missing`);
        else for (const p of ptLatePpmBuiltinProblems(stats, t, late, deps.amountOf(late.subemitter))) problems.push(`${sink}: ${p}`);
      }
      problems = [...new Set(problems)];
    }
    checks.push(
      check(
        "pt-late-ppm-builtin",
        "LATE-PPM: under GRC_ADOPT_FAULT=ppm-no-shader (the engine names no shader) every process material is adopted through its particle_process_material builtin, nothing refused, no unknown-particles",
        problems,
        stats ? `${stats.ppm_builtin} builtin-recovered, ${stats.ppm_refused_no_shader} no-shader, ${stats.ppm_materials} materials` : undefined,
      ),
    );
  }

  // The pixels: the reference's shots after the arm.
  const shots = ptShots(
    checkpoints.filter((c) => c.settle - 1 > late.arm_frame),
    px.tail_frames,
  );
  const refImg = new Map<string, Rgba>();
  if (ran("reference"))
    for (const s of shots) {
      const img = await decodePngRgba(join(dir("reference"), "shots", `${s.label}.png`));
      if (img) refImg.set(s.label, img);
    }
  const judge = async (leg: string) => {
    const seqs = readdirSafe(join(dir(leg), "shots"))
      .map((n) => /^seq-(\d+)\.png$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    if (seqs.length !== shots.length) return `${seqs.length} shots, ${shots.length} wanted`;
    const rows: { label: string; frame: number; ink: ReturnType<typeof ptInk>; ref: ReturnType<typeof ptInk>; diff: ReturnType<typeof mmCellDiff> }[] = [];
    for (let i = 0; i < shots.length; i++) {
      const img = await decodePngRgba(join(dir(leg), "shots", `seq-${seqs[i]}.png`));
      const ref = refImg.get(shots[i].label);
      if (!img || !ref) return `${shots[i].label}: shot missing`;
      rows.push({ label: shots[i].label, frame: shots[i].frame, ink: ptInk(img, px), ref: ptInk(ref, px), diff: mmCellDiff(img, ref, px.regions) });
    }
    return rows;
  };
  const lifecycle = async (leg: string) => {
    const rows = await judge(leg);
    if (typeof rows === "string") return { problems: [`${leg}: ${rows}`], rows: null };
    const problems: string[] = [];
    for (const r of rows) for (const p of ptLifecycleProblems(r.ink, r.ref)) problems.push(`${leg} ${r.label}: ${p}`);
    return { problems, rows };
  };
  const pixels: Record<string, unknown> = {};
  report.pixels = pixels;
  {
    const lc: string[] = [];
    const cov: string[] = [];
    const out: string[] = [];
    const ratios: number[] = [];
    let any = false;
    for (const leg of RECEIVERS) {
      if (!ran(leg) || !ran("reference")) continue;
      any = true;
      const { problems, rows } = await lifecycle(leg);
      lc.push(...problems);
      if (!rows) continue;
      pixels[leg] = rows.map((r) => ({ shot: r.label, ink: r.ink.cells, reference: r.ref.cells, diff: r.diff }));
      for (const r of rows) {
        if (r.frame >= late.coverage_from_frame) {
          for (const p of ptCoverageProblems(r.ink, r.ref, px.coverage_band)) cov.push(`${leg} ${r.label}: ${p}`);
          for (const [cell, n] of Object.entries(r.ref.cells)) if (n > 0 && (r.ink.cells[cell] ?? 0) > 0) ratios.push((r.ink.cells[cell] ?? 0) / n);
        }
        if (!r.diff) out.push(`${leg} ${r.label}: size differs`);
        else if (r.diff.outside > 0) out.push(`${leg} ${r.label}: ${r.diff.outside} px differ outside every region`);
      }
    }
    ratios.sort((a, b) => a - b);
    const note = ratios.length > 0 ? `ink ratio to the reference: min ${ratios[0].toFixed(2)}, median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}, max ${ratios.at(-1)?.toFixed(2)}` : undefined;
    checks.push(
      check(
        "pt-late-lifecycle",
        "PM7: each late receiver lights exactly the cells the unarmed reference lights, at every shot after the arm",
        any ? lc : null,
        `${shots.length} shots: ${shots.map((s) => s.label).join(", ")}`,
      ),
    );
    checks.push(
      check(
        "pt-late-coverage",
        `PM7 (banded): from frame ${late.coverage_from_frame} on, each cell lit in both has ink within x${px.coverage_band} of the reference's`,
        any ? cov : null,
        note,
      ),
    );
    checks.push(check("pt-late-outside-exact", "PM7: outside every emitter region each late receiver equals the reference exactly", any ? out : null));
  }
  {
    const id = "pt-late-lifecycle-catches-no-particles";
    const criterion = "PM7: the receiver on the fault capture (no emitter adopted: the pre-PM7 capture) fails pt-late-lifecycle";
    if (!ran(FAULT_RECEIVER) || !ran("reference")) checks.push(check(id, criterion, null));
    else {
      const { problems } = await lifecycle(FAULT_RECEIVER);
      checks.push(check(id, criterion, problems.length > 0 ? [] : [`${FAULT_RECEIVER} passed: the missing adoption went unseen`], problems[0]));
    }
  }
}

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
