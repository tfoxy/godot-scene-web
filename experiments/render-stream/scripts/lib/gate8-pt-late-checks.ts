// Gate 8 g8pt late-arm checks (PM7, protocol/render-stream-12.md "As built (PM7)"): the capture
// arms at fixture frame 12 (fixtures/gate8-pt/loader.gd RS_FIXTURE_ARM=late), after every emitter,
// process material, draw-pass mesh and texture exists, and adopts each GPUParticles2D emitter at
// its first draw after the arm. Before PM7 every such draw was unknown-particles and a receiver
// drew nothing; GRC_ADOPT_FAULT=no-particles is that capture.
//
// LAR4 moves the adoption judgments onto the
// `deferred` arm (loaded at birth, armed at frame 12 by GRC_ARM_DEFER_FRAMES=11): every process
// material is adopted from the registry with its real shader.
//
// LAR5 (the particles row) adopts a pre-arm emitter purely from the registry: every particles_set_*
// since the extension loaded, not the node's getters. On the `late` arm (extension loaded at frame
// 12) every pre-arm emitter is unregistered and REFUSED with the typed reason `preload-particles`,
// so the late capture equals the fault capture on the wire (nothing adopted, every draw
// unknown-particles); the old PM7 / LATE-PPM adoption judgments (pt-late-ppm-builtin) retire with
// that premise. The deferred capture's adopted emitters are compared with the born capture's at the
// arm frame (pt-registry-source), and two sabotages prove the checks can fail: registry-off (no
// recording: every emitter refused) and registry-skip-particles (setters not recorded: emitters
// adopted with a fresh emitter's configuration, drawing nothing).
//
//   pt-late-validate           both sinks of every capture below pass the TypeScript validator and
//                              rs-core-check
//   pt-late-adopt              deferred/capture adopted every emitter (result.json
//                              stream.gate8.particles.adoption: expected.json late.emitters and
//                              process_materials, nothing refused); no transaction carries an
//                              unknown-particles add_particles; the last state's table holds that
//                              many entries, all origin "adopted" and ok, each process material ok
//                              on a shader with the particle_process_material builtin, and the
//                              subemitter cell's entry names another adopted emitter
//   pt-late-fault              the fault capture adopted no emitter and every add_particles is
//                              unknown-particles (the pre-PM7 capture, the sabotage's premise)
//   pt-late-preload            late/capture (both sinks): every pre-arm emitter refused
//                              preload-particles, none adopted, every add_particles unknown-particles
//   pt-late-synthetic-skip     sabotage-registry-drop-binding/receiver skips every placeholder-shader
//                              emitter
//   pt-registry-source         deferred/capture: every emitter adopted from the registry
//                              (registry.json particles family and payload recorded) and its
//                              configuration and floats equal the born capture's at the arm frame
//   pt-registry-source-catches-registry-off  the registry-off capture fails the above
//   pt-registry-real-shader    deferred/capture and deferred-cmbt/capture (both sinks): every process
//                              material adopted from the registry on its real shader; the deferred
//                              receivers skip nothing
//   pt-registry-real-shader-catches-registry-drop-binding  the sabotage capture fails the above
//   pt-registry-params         headless-deferred/capture's process parameters equal born's
//   pt-late-lifecycle          deferred/receiver and deferred/receiver-patch light exactly the cells the
//                              unarmed reference lights, at every shot after the arm
//   pt-late-coverage           (banded) from late.coverage_from_frame on, each lit cell's ink is
//                              within the coverage band of the reference's
//   pt-late-outside-exact      outside every emitter region each late receiver equals the
//                              reference exactly
//   pt-late-lifecycle-catches-no-particles  the receiver on the fault capture fails
//                              pt-late-lifecycle (the emitters stay dark)
//   pt-late-lifecycle-catches-registry-skip-particles  the receiver on the skip-particles capture
//                              (fresh-emitter configurations, nothing drawn) fails it too
//   pt-clock-origin            (LAR7) result.json stream.gate8.shader_clock: deferred/capture (loaded
//                              at birth) reports origin "startup" with nothing missed, late/capture
//                              (loaded at frame 12) reports "late-load" (registry-checks.ts
//                              shaderClockOrigin)
//   standby-clock              the shader clock advances through standby
//                              on a rendered host: deferred/capture (the standby table for its first
//                              11 frames, then armed) saw every engine draw through the draw hook
//                              (draws_missed 0, which since LS1 counts the draws after the first tick
//                              too) and its draws cover the standby frames
//   sabotage-standby-no-draw   sabotage-standby-no-draw/capture (GRC_STANDBY_FAULT=no-draw: draw left
//                              out of the standby table) fails standby-clock
//
// The late legs' shots are the reference's shots after the arm, in frame order: the fixture logs
// only the steps that settle after it, and run-gate8.sh adds each settle frame's previous frame
// and the tails (g8pt_extra_seqs).

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  type G8aCheck,
  jsonl,
  readText,
  skipped,
} from "./gate8-adopt-checks";
import { mmCellDiff, type Rgba } from "./gate8-mm-checks";
import {
  type PtPixels,
  ptCoverageProblems,
  ptInk,
  ptLifecycleProblems,
  ptShots,
} from "./gate8-pt-receiver-checks";
import { type ShaderClockEvidence, shaderClockOrigin } from "./registry-checks";

export interface PtLate {
  arm_frame: number;
  emitters: number;
  process_materials: number;
  subemitter: string;
  coverage_from_frame: number;
}

/** LATE-CMBT: expected.json `late_shader`. */
export interface PtLateShader {
  amount: number;
  seed: number;
  frame: number;
  key: Record<string, unknown>;
}

/** The parts of a resolved state pt-late-adopt reads (gate8-pt-checks.ts PtTx). */
export interface PtLateTx {
  /** the host frame (the checker's trace carries it; pt-registry-source pairs transactions by it) */
  frame?: number;
  table: Map<
    number,
    {
      id: number;
      origin: string;
      status: string;
      amount: number;
      process_material: number | null;
      subemitter: number | null;
      /** LAR5 (pt-registry-source): the resolved entry's configuration and floats (ResolvedParticles;
       *  `mode` is the wire's mode_2d). Optional so a bare fixture stays valid; a missing field on
       *  either side of the comparison is a problem. */
      mode?: string;
      emitting?: boolean;
      one_shot?: boolean;
      fixed_fps?: number;
      interpolate?: boolean;
      fractional_delta?: boolean;
      local?: boolean;
      draw_order?: string;
      transform_align?: string;
      trails?: boolean;
      trail_poses?: number;
      seed?: number;
      draw_passes?: ReadonlyArray<number | null>;
      floats?: unknown;
    }
  >;
  materials: Map<
    number,
    {
      status: string;
      shader: number | null;
      params?: {
        name: string;
        type: string;
        value: number | number[] | { tex: number } | null;
      }[];
    }
  >;
  /** resolved shaders; the checker's trace wrapper adds `synthetic` (the stored code contains the
   *  `// Synthetic` marker of LATE-PPM's placeholder; undefined when the code is unreadable) */
  shaders: Map<number, unknown>;
  items: Map<
    number,
    { add_particles: number; unsupported: Record<string, number> }
  >;
  item_unsupported: Record<string, number>;
}

/** stream.gate8.particles.adoption of a capture's result.json, or null. */
export function adoptionStats(
  result: Record<string, unknown> | null,
): Record<string, number> | null {
  const a = (
    (
      (result?.stream as Record<string, unknown> | undefined)?.gate8 as
        | Record<string, unknown>
        | undefined
    )?.particles as Record<string, unknown> | undefined
  )?.adoption;
  return a && typeof a === "object" ? (a as Record<string, number>) : null;
}

/** stream.gate8.particles of a capture's result.json (the PM5/PM7 counters), or null. */
export function ppmStats(
  result: Record<string, unknown> | null,
): Record<string, number> | null {
  const p = (
    (result?.stream as Record<string, unknown> | undefined)?.gate8 as
      | Record<string, unknown>
      | undefined
  )?.particles as Record<string, unknown> | undefined;
  return p && typeof p === "object" ? (p as Record<string, number>) : null;
}

function unknownParticles(txs: readonly PtLateTx[]): number {
  let n = 0;
  for (const tx of txs) {
    n += tx.item_unsupported["unknown-particles"] ?? 0;
    for (const it of tx.items.values())
      n += it.unsupported["unknown-particles"] ?? 0;
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
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else {
    if (stats.emitters !== late.emitters)
      problems.push(
        `${stats.emitters} emitters adopted, ${late.emitters} expected`,
      );
    if (stats.ppm_materials !== late.process_materials)
      problems.push(
        `${stats.ppm_materials} process materials adopted, ${late.process_materials} expected`,
      );
    for (const k of ["refused", "ppm_refused"])
      if ((stats[k] ?? 0) !== 0) problems.push(`${k} ${stats[k]}`);
  }
  if (txs.length === 0) return [...problems, "no transaction"];
  const unknown = unknownParticles(txs);
  if (unknown > 0)
    problems.push(
      `${unknown} unknown-particles add_particles over the recording`,
    );
  const last = txs[txs.length - 1];
  const entries = [...last.table.values()];
  if (entries.length !== late.emitters)
    problems.push(
      `last state: ${entries.length} particles entries, ${late.emitters} expected`,
    );
  let drawn = 0;
  for (const it of last.items.values()) drawn += it.add_particles;
  if (drawn !== late.emitters)
    problems.push(
      `last state: ${drawn} add_particles commands, ${late.emitters} expected`,
    );
  for (const e of entries) {
    if (e.origin !== "adopted")
      problems.push(`entry ${e.id}: origin ${e.origin}`);
    if (e.status !== "ok") problems.push(`entry ${e.id}: status ${e.status}`);
    const m =
      e.process_material === null
        ? undefined
        : last.materials.get(e.process_material);
    if (!m) problems.push(`entry ${e.id}: no process material`);
    else {
      if (m.status !== "ok")
        problems.push(
          `entry ${e.id}: process material ${e.process_material} is ${m.status}`,
        );
      const s =
        m.shader === null
          ? undefined
          : (last.shaders.get(m.shader) as
              | { status?: string; builtin?: { kind?: string } | null }
              | undefined);
      if (s?.status !== "ok" || s.builtin?.kind !== "particle_process_material")
        problems.push(
          `entry ${e.id}: process shader ${m.shader} is not an ok particle_process_material builtin`,
        );
    }
  }
  const sub = entries.find((e) => e.amount === subAmount);
  if (subAmount === undefined)
    problems.push(`expected.json names no amount for ${late.subemitter}`);
  else if (!sub)
    problems.push(`${late.subemitter} (amount ${subAmount}): no entry`);
  else if (
    sub.subemitter === null ||
    !last.table.has(sub.subemitter) ||
    sub.subemitter === sub.id
  )
    problems.push(
      `${late.subemitter}: subemitter ${String(sub.subemitter)} names no other entry`,
    );
  return problems;
}

/** pt-late-fault: nothing adopted, every add_particles unknown. */
export function ptLateFaultProblems(
  stats: Record<string, number> | null,
  txs: readonly PtLateTx[],
  late: PtLate,
): string[] {
  const problems: string[] = [];
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else if (stats.emitters !== 0)
    problems.push(`${stats.emitters} emitters adopted under the fault`);
  const last = txs.at(-1);
  if (!last) return [...problems, "no transaction"];
  if (last.table.size !== 0)
    problems.push(`last state: ${last.table.size} particles entries`);
  let unknown = 0;
  for (const it of last.items.values())
    unknown += it.unsupported["unknown-particles"] ?? 0;
  if (unknown !== late.emitters)
    problems.push(
      `last state: ${unknown} unknown-particles add_particles, ${late.emitters} expected`,
    );
  return problems;
}

/** pt-late-preload (LAR5): on the late arm every pre-arm emitter predates the hooks, so the registry
 *  never saw it and the capture refuses it with the typed reason `preload-particles`: none adopted
 *  (so no process material adopted through an emitter either), the last state holds no particles
 *  entry and every emitter's add_particles is unknown-particles. */
export function ptLatePreloadProblems(
  stats: Record<string, number> | null,
  txs: readonly PtLateTx[],
  late: PtLate,
): string[] {
  const problems: string[] = [];
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else {
    if ((stats.emitters ?? 0) !== 0)
      problems.push(`${stats.emitters} emitters adopted, 0 expected`);
    if (stats.refused_preload_particles !== late.emitters)
      problems.push(
        `refused_preload_particles ${stats.refused_preload_particles}, ${late.emitters} expected`,
      );
    if (stats.refused !== late.emitters)
      problems.push(`refused ${stats.refused}, ${late.emitters} expected`);
    if ((stats.ppm_materials ?? 0) !== 0)
      problems.push(
        `${stats.ppm_materials} process materials adopted, 0 expected`,
      );
  }
  const last = txs.at(-1);
  if (!last) return [...problems, "no transaction"];
  if (last.table.size !== 0)
    problems.push(`last state: ${last.table.size} particles entries`);
  let unknown = 0;
  for (const it of last.items.values())
    unknown += it.unsupported["unknown-particles"] ?? 0;
  if (unknown !== late.emitters)
    problems.push(
      `last state: ${unknown} unknown-particles add_particles, ${late.emitters} expected`,
    );
  return problems;
}

const SOURCE_FIELDS = [
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
] as const;

/** pt-registry-source (LAR5): an emitter adopted from the registry is the emitter the born capture
 *  saw. (a) the adoption stats: every emitter adopted, none refused; (b) evidence/registry.json:
 *  the registry was on and recorded the particles family and payload; (c) at the arm frame F (the
 *  first deferred transaction whose table holds `late.emitters` adopted entries) every adopted
 *  entry equals the born entry with the same (seed, amount), at the born transaction of the same
 *  frame, on mode, emitting, amount, one_shot, fixed_fps, interpolate, fractional_delta, local,
 *  draw_order, transform_align, trails, trail_poses, seed, the draw pass count and every float.
 *  Ids, origin, version, restarts, emits, process_requests, status and the resource ids are not
 *  compared. */
export function ptRegistrySourceProblems(
  stats: Record<string, number> | null,
  registry: Record<string, unknown> | null,
  deferredTxs: readonly PtLateTx[],
  bornTxs: readonly PtLateTx[],
  late: PtLate,
): { problems: string[]; detail: string } {
  const problems: string[] = [];
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else {
    if (stats.emitters !== late.emitters)
      problems.push(
        `${stats.emitters} emitters adopted, ${late.emitters} expected`,
      );
    for (const k of ["refused", "refused_preload_particles"])
      if ((stats[k] ?? 0) !== 0) problems.push(`${k} ${stats[k]}, expected 0`);
  }
  const obj = (v: unknown) =>
    typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : undefined;
  if (!registry) problems.push("no evidence/registry.json");
  else {
    if (registry.enabled !== true)
      problems.push(`registry.json enabled ${String(registry.enabled)}`);
    const creates = obj(obj(registry.families)?.particles)?.creates;
    if (typeof creates !== "number" || creates < late.emitters)
      problems.push(
        `registry.json families.particles.creates ${String(creates)}, at least ${late.emitters} expected`,
      );
    // The evidence is written at exit, after the fixture freed its emitters: count the setters
    // recorded, not the live payloads.
    const sets = obj(obj(registry.payloads)?.particles)?.sets;
    if (typeof sets !== "number" || sets < late.emitters)
      problems.push(
        `registry.json payloads.particles.sets ${String(sets)}, at least ${late.emitters} expected`,
      );
  }
  const adopted = (tx: PtLateTx) =>
    [...tx.table.values()].filter((e) => e.origin === "adopted");
  const first = deferredTxs.find((t) => adopted(t).length >= late.emitters);
  if (!first) {
    problems.push(
      `no deferred transaction holds ${late.emitters} adopted particles entries`,
    );
    return { problems, detail: `${stats?.emitters ?? 0} emitters` };
  }
  const frame = first.frame;
  const born = bornTxs.find((t) => t.frame === frame);
  if (!born) {
    problems.push(`no born transaction at frame ${frame}`);
    return { problems, detail: `${stats?.emitters ?? 0} emitters` };
  }
  let equal = 0;
  for (const a of adopted(first)) {
    const name = `amount ${a.amount} seed ${String(a.seed)}`;
    const candidates = [...born.table.values()].filter(
      (b) => b.seed === a.seed && b.amount === a.amount,
    );
    if (candidates.length === 0) {
      problems.push(`${name}: no born entry at frame ${frame}`);
      continue;
    }
    // the first candidate that is fully equal; otherwise the first one's differences
    let best: string[] | null = null;
    for (const b of candidates) {
      const diffs: string[] = [];
      for (const f of SOURCE_FIELDS)
        if (a[f] === undefined || a[f] !== b[f])
          diffs.push(
            `${f} ${JSON.stringify(a[f])}, born ${JSON.stringify(b[f])}`,
          );
      if (
        a.draw_passes === undefined ||
        a.draw_passes.length !== b.draw_passes?.length
      )
        diffs.push(
          `draw_passes ${a.draw_passes?.length}, born ${b.draw_passes?.length}`,
        );
      if (a.floats === undefined || a.floats === null)
        diffs.push("floats absent");
      else if (JSON.stringify(a.floats) !== JSON.stringify(b.floats))
        diffs.push(
          `floats ${JSON.stringify(a.floats)}, born ${JSON.stringify(b.floats)}`,
        );
      if (diffs.length === 0) {
        best = null;
        equal++;
        break;
      }
      best ??= diffs;
    }
    if (best) problems.push(`${name} (frame ${frame}): ${best.join("; ")}`);
  }
  return {
    problems,
    detail: `${stats?.emitters ?? 0} emitters from the registry, ${equal} configs equal born at frame ${frame}`,
  };
}

/** LATE-CMBT: the post-arm cell's process material was `unknown-shader` (its material_set_shader
 *  named a pre-arm shader RID); the capture re-keys it through the particle_process_material
 *  builtin, so the entry is ok on an ok process material whose shader carries the builtin. */
export function ptLateCmbtProblems(
  stats: Record<string, number> | null,
  txs: readonly PtLateTx[],
  lateShader: PtLateShader,
): string[] {
  const problems: string[] = [];
  if (!stats) problems.push("no stream.gate8.particles in result.json");
  else if ((stats.unknown_shader_keyed ?? 0) < 1)
    problems.push("unknown_shader_keyed is 0");
  const last = txs.at(-1);
  if (!last) return [...problems, "no transaction"];
  const entry = [...last.table.values()].find(
    (e) => e.amount === lateShader.amount,
  );
  if (!entry) return [...problems, `no entry with amount ${lateShader.amount}`];
  if (entry.origin !== "created")
    problems.push(
      `entry ${entry.id}: origin ${entry.origin}, expected created`,
    );
  if (entry.status !== "ok")
    problems.push(`entry ${entry.id}: status ${entry.status}`);
  const m =
    entry.process_material === null
      ? undefined
      : last.materials.get(entry.process_material);
  if (!m) problems.push(`entry ${entry.id}: no process material`);
  else {
    if (m.status !== "ok")
      problems.push(
        `entry ${entry.id}: process material ${entry.process_material} is ${m.status}`,
      );
    const s =
      m.shader === null
        ? undefined
        : (last.shaders.get(m.shader) as
            | { status?: string; builtin?: { kind?: string } | null }
            | undefined);
    if (s?.status !== "ok" || s.builtin?.kind !== "particle_process_material")
      problems.push(
        `entry ${entry.id}: process shader ${m.shader} is not an ok particle_process_material builtin`,
      );
  }
  return problems;
}

interface PtShaderFacts {
  status?: string;
  builtin?: { kind?: string } | null;
  synthetic?: boolean;
}

/** The process shader of a particles entry at `last`, or why it is not an ok real builtin. */
function realShaderProblem(
  last: PtLateTx,
  entry: { id: number; process_material: number | null },
): string | null {
  const m =
    entry.process_material === null
      ? undefined
      : last.materials.get(entry.process_material);
  if (!m) return `entry ${entry.id}: no process material`;
  if (m.status !== "ok")
    return `entry ${entry.id}: process material ${entry.process_material} is ${m.status}`;
  const s =
    m.shader === null
      ? undefined
      : (last.shaders.get(m.shader) as PtShaderFacts | undefined);
  if (s?.status !== "ok" || s.builtin?.kind !== "particle_process_material")
    return `entry ${entry.id}: process shader ${m.shader} is not an ok particle_process_material builtin`;
  if (s.synthetic === true)
    return `entry ${entry.id}: process shader ${m.shader} is the synthetic placeholder`;
  if (s.synthetic !== false)
    return `entry ${entry.id}: process shader ${m.shader}: stored code unreadable`;
  return null;
}

/**
 * pt-registry-real-shader (LAR4): on the deferred arm every process material is adopted from the
 * registry with the shader material_set_shader named: no placeholder shader, nothing recovered
 * through the builtin, nothing refused. With `opts.cmbt` (deferred-cmbt) the post-arm cell's
 * shader is registered too, so nothing is re-keyed (`unknown_shader_keyed` 0) and its entry is a
 * created one on an ok real builtin process material. `ppm` is stream.gate8.particles, `stats` its
 * `adoption`.
 */
export function ptRegistryRealShaderProblems(
  stats: Record<string, number> | null,
  ppm: Record<string, number> | null,
  txs: readonly PtLateTx[],
  late: PtLate,
  opts: { cmbt?: PtLateShader } = {},
): string[] {
  const problems: string[] = [];
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else {
    if (stats.ppm_registry !== late.process_materials)
      problems.push(
        `${stats.ppm_registry} process materials adopted from the registry, ${late.process_materials} expected`,
      );
    for (const k of [
      "ppm_builtin",
      "ppm_shaders",
      "ppm_refused_no_shader",
      "ppm_refused",
    ])
      if (stats[k] !== 0) problems.push(`${k} ${stats[k]}, expected 0`);
  }
  const last = txs.at(-1);
  if (!last) return [...problems, "no transaction"];
  const entries = [...last.table.values()];
  for (const e of entries) {
    const p = realShaderProblem(last, e);
    if (p === null) continue;
    // the cmbt cell is judged below with its own wording
    if (opts.cmbt && e.amount === opts.cmbt.amount) continue;
    problems.push(p);
  }
  let placeholders = 0;
  for (const sh of last.shaders.values())
    if ((sh as PtShaderFacts).synthetic === true) placeholders++;
  if (placeholders > 0)
    problems.push(`last state: ${placeholders} placeholder shader(s)`);
  if (opts.cmbt) {
    if (!ppm) problems.push("no stream.gate8.particles in result.json");
    else if ((ppm.unknown_shader_keyed ?? 0) !== 0)
      problems.push(
        `unknown_shader_keyed ${ppm.unknown_shader_keyed}, expected 0`,
      );
    const entry = entries.find((e) => e.amount === opts.cmbt?.amount);
    if (!entry) problems.push(`no entry with amount ${opts.cmbt.amount}`);
    else {
      if (entry.origin !== "created")
        problems.push(
          `entry ${entry.id}: origin ${entry.origin}, expected created`,
        );
      if (entry.status !== "ok")
        problems.push(`entry ${entry.id}: status ${entry.status}`);
      const p = realShaderProblem(last, entry);
      if (p !== null) problems.push(p);
    }
  }
  return problems;
}

type PtParam = { name: string; type: string; value: unknown };

function paramValuesDiffer(a: unknown, b: unknown): boolean {
  const isTex = (v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v) && "tex" in v;
  if (isTex(a) || isTex(b)) return !(isTex(a) && isTex(b));
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * pt-registry-params (LAR4): the headless (dummy renderer) deferred capture's process materials
 * carry the born capture's parameters. Each born particles entry is paired with the headless entry
 * of the same `amount`; their process materials' params are compared as name -> {type, value}
 * (texture values: both textures, ids differ between sessions). `compared` counts params judged.
 *
 * One exception, the texture family's and not the registry's: the dummy's texture_replace frees
 * the new texture and keeps the old one's (dummy/storage/texture_storage.h:112), so a texture made
 * as a placeholder and filled by texture_replace (GradientTexture1D's first _update) has no image
 * on a headless host, adoption refuses it (`refused_no_image`), and the parameter naming it is not
 * published. A texture parameter absent from the headless material is excused (`excused`) while
 * the headless capture counts that many textures refused for no image (`refusedNoImage`)
 * and holds are inactive. Active holds require current content for texture parameters.
 */
export function ptRegistryParamsProblems(
  stats: Record<string, number> | null,
  born: readonly PtLateTx[],
  headless: readonly PtLateTx[],
  late: PtLate,
  refusedNoImage = 0,
  hold: { state?: string } | null = null,
  adoptLines: readonly Record<string, unknown>[] = [],
): { problems: string[]; compared: number; excused: string[] } {
  const problems: string[] = [];
  const excused: string[] = [];
  const holdsActive = hold?.state === "active";
  const creation = new Set(
    adoptLines
      .filter(
        (line) =>
          line.op === "adopt" &&
          line.kind === "image" &&
          line.adopted_content === "creation",
      )
      .map((line) => line.id),
  );
  let compared = 0;
  if (!stats)
    problems.push("no stream.gate8.particles.adoption in result.json");
  else if (stats.ppm_registry !== late.process_materials)
    problems.push(
      `${stats.ppm_registry} process materials adopted from the registry, ${late.process_materials} expected`,
    );
  const b = born.at(-1);
  const h = headless.at(-1);
  if (!b || !h)
    return { problems: [...problems, "no transaction"], compared, excused };
  const paramsOf = (tx: PtLateTx, pm: number | null) => {
    const m = pm === null ? undefined : tx.materials.get(pm);
    return m
      ? new Map(((m.params ?? []) as PtParam[]).map((p) => [p.name, p]))
      : null;
  };
  for (const be of b.table.values()) {
    const he = [...h.table.values()].find((e) => e.amount === be.amount);
    if (!he) {
      problems.push(`amount ${be.amount}: no headless entry`);
      continue;
    }
    const bp = paramsOf(b, be.process_material);
    const hp = paramsOf(h, he.process_material);
    if (!bp || !hp) {
      if (bp !== hp)
        problems.push(
          `amount ${be.amount}: process material present in only one capture`,
        );
      continue;
    }
    for (const [name, p] of bp) {
      const q = hp.get(name);
      if (
        !q &&
        !holdsActive &&
        typeof p.value === "object" &&
        p.value !== null &&
        !Array.isArray(p.value) &&
        "tex" in p.value &&
        excused.length < refusedNoImage
      ) {
        excused.push(`amount ${be.amount}: ${name}`);
        continue;
      }
      if (!q) {
        problems.push(
          `amount ${be.amount}: ${name} absent from the headless material`,
        );
        continue;
      }
      if (
        holdsActive &&
        typeof q.value === "object" &&
        q.value !== null &&
        "tex" in q.value &&
        creation.has(q.value.tex)
      )
        problems.push(
          `amount ${be.amount}: ${name} adopted with creation-time content while holds active`,
        );
      compared++;
      if (q.type !== p.type)
        problems.push(
          `amount ${be.amount}: ${name} type ${q.type}, born ${p.type}`,
        );
      else if (paramValuesDiffer(p.value, q.value))
        problems.push(
          `amount ${be.amount}: ${name} ${JSON.stringify(q.value)}, born ${JSON.stringify(p.value)}`,
        );
    }
    for (const name of hp.keys())
      if (!bp.has(name))
        problems.push(
          `amount ${be.amount}: ${name} only in the headless material`,
        );
  }
  return { problems, compared, excused };
}

export interface PtLateDeps {
  validate: (path: string) => Promise<[string, string] | null>;
  trace: (leg: string, sink: string) => Promise<PtLateTx[] | null>;
  /** the cell's amount (the checker finds a cell by it) */
  amountOf: (cell: string) => number | undefined;
}

const SINKS = ["recording.rs12", "recording-patch.rs12"];
const LATE_CAPTURE = "late/capture";
const FAULT_CAPTURE = "fault-no-particles/capture";
const LATE_CMBT_CAPTURE = "late-cmbt/capture";
// LAR4: the deferred arm's captures, the registry-drop-binding sabotage and the headless leg.
const DEFERRED_CAPTURE = "deferred/capture";
const DEFERRED_CMBT_CAPTURE = "deferred-cmbt/capture";
const DROP_BINDING_CAPTURE = "sabotage-registry-drop-binding/capture";
const HEADLESS_DEFERRED_CAPTURE = "headless-deferred/capture";
// LAR5: the particles row's sabotages (registry-off, registry-skip-particles).
const SABOTAGE_REGISTRY_OFF_CAPTURE = "sabotage-registry-off/capture";
const SKIP_PARTICLES_CAPTURE = "sabotage-registry-skip-particles/capture";
// LS1: the deferred arm without draw in its standby table.
const STANDBY_NO_DRAW_CAPTURE = "sabotage-standby-no-draw/capture";
const BORN_CAPTURE = "capture";
const CAPTURES = [
  LATE_CAPTURE,
  FAULT_CAPTURE,
  LATE_CMBT_CAPTURE,
  DEFERRED_CAPTURE,
  DEFERRED_CMBT_CAPTURE,
  DROP_BINDING_CAPTURE,
  HEADLESS_DEFERRED_CAPTURE,
  SABOTAGE_REGISTRY_OFF_CAPTURE,
  SKIP_PARTICLES_CAPTURE,
];

/**
 * LS1 standby-clock on one rendered capture's result.json shader clock: the draw hook is the source,
 * no engine draw went unseen (draws_missed 0) and the hooked draws cover at least `standbyFrames`
 * (the frames the capture spent on the standby table). Pure.
 */
export function standbyClockProblems(
  clock: ShaderClockEvidence | null | undefined,
  standbyFrames: number,
): { problems: string[]; detail: string } {
  if (!clock)
    return {
      problems: ["no result.json stream.gate8.shader_clock"],
      detail: "absent",
    };
  const problems: string[] = [];
  const detail = `source ${clock.source} draws ${clock.draws} draws_missed ${clock.draws_missed} ticks ${clock.ticks}`;
  if (clock.source !== "draw-hook")
    problems.push(`source ${clock.source}, want draw-hook (a rendered host)`);
  if (clock.draws_missed !== 0)
    problems.push(`draws_missed ${clock.draws_missed}, want 0`);
  if (!(typeof clock.draws === "number" && clock.draws >= standbyFrames))
    problems.push(
      `draws ${clock.draws}, want at least the ${standbyFrames} standby frames`,
    );
  return { problems, detail };
}
/** the deferred pixel receivers (pt-late-lifecycle, -coverage, -outside-exact) */
const RECEIVERS = ["deferred/receiver", "deferred/receiver-patch"];
// LAR5: `late` adopts nothing, so the placeholder residual is judged on the drop-binding sabotage
// (every process material of that capture fell to the placeholder) and the skip-particles
// sabotage's pixels are judged too.
const DROP_BINDING_RECEIVER = "sabotage-registry-drop-binding/receiver";
const SKIP_PARTICLES_RECEIVER = "sabotage-registry-skip-particles/receiver";
const DEFERRED_CMBT_RECEIVER = "deferred-cmbt/receiver";
const FAULT_RECEIVER = "fault-no-particles/receiver";
export const LATE_LEGS = [
  ...CAPTURES,
  STANDBY_NO_DRAW_CAPTURE,
  ...RECEIVERS,
  DROP_BINDING_RECEIVER,
  SKIP_PARTICLES_RECEIVER,
  DEFERRED_CMBT_RECEIVER,
  FAULT_RECEIVER,
];

/**
 * pt-late-synthetic-skip's verdict on a receiver's applied.json. The receiver counts one skip per
 * synthetic-process-shader emitter per applied transaction (plan.rs apply_particles walks every
 * resident emitter on every apply), and on the registry-drop-binding sabotage's receiver (LAR5:
 * `late` adopts no emitter any more) every one of the fixture's `late.emitters` is recovered
 * through the synthetic shader, so the exact count is
 * `late.emitters * applied`: 10 emitters x 109 applies = 1090 on the committed run. A bare `> 0`
 * would pass when only some emitters were skipped.
 */
export function ptSyntheticSkipProblems(
  leg: string,
  applied: Record<string, unknown> | null,
  late: Pick<PtLate, "emitters">,
): { problems: string[]; detail: string } {
  const w11 = applied?.w11 as
    | { applied?: number; particles?: { synthetic_skipped?: number } }
    | undefined;
  const skipped = w11?.particles?.synthetic_skipped;
  const n = w11?.applied;
  if (typeof skipped !== "number" || typeof n !== "number" || !(n > 0))
    return {
      problems: [
        `${leg}: applied.json has no w11.applied / particles.synthetic_skipped (${n}, ${skipped})`,
      ],
      detail: "no counters",
    };
  const want = late.emitters * n;
  const detail = `synthetic_skipped ${skipped} (want ${late.emitters} emitters x ${n} applies = ${want})`;
  return { problems: skipped === want ? [] : [`${leg}: ${detail}`], detail };
}

export async function runG8ptLate(
  g: string,
  checkpoints: readonly { step: number; settle: number }[],
  px: PtPixels,
  late: PtLate,
  lateShader: PtLateShader,
  deps: PtLateDeps,
  checks: G8aCheck[],
  report: Record<string, unknown>,
): Promise<void> {
  const dir = (leg: string) => join(g, leg);
  const ran = (leg: string) =>
    !skipped(dir(leg)) && readdirSafe(dir(leg)).includes("exit-code.txt");
  const json = async (path: string) => {
    try {
      return JSON.parse((await readText(path)) ?? "null") as Record<
        string,
        unknown
      > | null;
    } catch {
      return null;
    }
  };
  const anySkipped = [
    ...CAPTURES,
    ...RECEIVERS,
    DROP_BINDING_RECEIVER,
    SKIP_PARTICLES_RECEIVER,
    DEFERRED_CMBT_RECEIVER,
    FAULT_RECEIVER,
  ].find((l) => skipped(dir(l)));
  if (anySkipped) {
    for (const id of [
      "pt-late-validate",
      "pt-late-adopt",
      "pt-late-fault",
      "pt-late-preload",
      "pt-late-cmbt",
      "pt-late-synthetic-skip",
      "pt-registry-real-shader",
      "pt-registry-real-shader-catches-registry-drop-binding",
      "pt-registry-params",
      "pt-registry-source",
      "pt-registry-source-catches-registry-off",
      "pt-clock-origin",
      "pt-late-lifecycle",
      "pt-late-coverage",
      "pt-late-outside-exact",
      "pt-late-lifecycle-catches-no-particles",
      "pt-late-lifecycle-catches-registry-skip-particles",
    ])
      checks.push({
        id,
        criterion: "PM7: the late arm",
        passed: true,
        status: "not-run",
        detail: `skipped: ${anySkipped}`,
        gating: false,
      });
    return;
  }

  // pt-late-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of CAPTURES)
      for (const sink of SINKS) {
        if (!ran(leg)) {
          problems.push(`${leg}/${sink}: the leg did not run`);
          continue;
        }
        const v = await deps.validate(join(dir(leg), sink));
        if (!v) {
          problems.push(`${leg}/${sink}: missing`);
          continue;
        }
        any = true;
        if (v[0] !== "ok") problems.push(`${leg}/${sink}: TS ${v[0]}`);
        if (v[1] !== "ok") problems.push(`${leg}/${sink}: rs-core ${v[1]}`);
      }
    checks.push(
      check(
        "pt-late-validate",
        "PM7, LAR4, LAR5: both sinks of every late-group capture (late, fault, late-cmbt, deferred, deferred-cmbt, the registry-drop-binding, registry-off and registry-skip-particles sabotages, headless-deferred) pass the TypeScript validator and rs-core-check",
        any ? problems : null,
      ),
    );
  }

  // pt-late-adopt, pt-late-fault
  {
    const leg = DEFERRED_CAPTURE;
    const stats = adoptionStats(
      await json(join(dir(leg), "evidence", "result.json")),
    );
    report.adoption = stats;
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = [];
      for (const sink of SINKS) {
        const t = await deps.trace(leg, sink);
        if (!t) problems.push(`${sink}: missing`);
        else
          for (const p of ptLateAdoptProblems(
            stats,
            t,
            late,
            deps.amountOf(late.subemitter),
          ))
            problems.push(`${sink}: ${p}`);
      }
      problems = [...new Set(problems)];
    }
    checks.push(
      check(
        "pt-late-adopt",
        "LAR4 deferred arm (PM7's adoption): the capture adopts every pre-arm emitter (and its process material) at its first draw: no unknown-particles anywhere, every entry origin adopted and ok on an ok process material whose shader carries the particle_process_material builtin, the subemitter linked",
        problems,
        stats
          ? `adopted ${stats.emitters} emitters, ${stats.ppm_materials} process materials (${stats.ppm_params} params), ${stats.ppm_shaders} shaders, ${stats.meshes} meshes; ${stats.adopt_ns} ns`
          : undefined,
      ),
    );
    const f = "fault-no-particles/capture";
    let fp: string[] | null = null;
    if (ran(f)) {
      const t = await deps.trace(f, SINKS[0]);
      fp = t
        ? ptLateFaultProblems(
            adoptionStats(await json(join(dir(f), "evidence", "result.json"))),
            t,
            late,
          )
        : ["no recording"];
    }
    checks.push(
      check(
        "pt-late-fault",
        "PM7: under GRC_ADOPT_FAULT=no-particles no emitter is adopted and every add_particles is unknown-particles (the pre-PM7 capture)",
        fp,
      ),
    );
  }

  // pt-late-preload (LAR5): the late leg's emitters predate the hooks, so the registry never saw
  // them and every one is refused preload-particles; nothing is adopted.
  {
    const leg = LATE_CAPTURE;
    const stats = adoptionStats(
      await json(join(dir(leg), "evidence", "result.json")),
    );
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = [];
      for (const sink of SINKS) {
        const t = await deps.trace(leg, sink);
        if (!t) problems.push(`${sink}: missing`);
        else
          for (const p of ptLatePreloadProblems(stats, t, late))
            problems.push(`${sink}: ${p}`);
      }
      problems = [...new Set(problems)];
    }
    checks.push(
      check(
        "pt-late-preload",
        "LAR5: on the late leg (extension loaded at the arm) every pre-arm emitter is unregistered and refused preload-particles: none adopted, no process material adopted through an emitter, the last state holds no particles entry and every add_particles is unknown-particles",
        problems,
        stats
          ? `${stats.emitters} adopted, ${stats.refused_preload_particles} refused preload-particles, ${stats.ppm_materials} process materials`
          : undefined,
      ),
    );
  }

  // pt-late-synthetic-skip (native-fog-tint): the native receiver cannot reconstruct the RD-only
  // process shader from the synthetic placeholder, so it skips every emitter recovered through it.
  {
    const leg = DROP_BINDING_RECEIVER;
    let problems: string[] | null = null;
    let detail: string | undefined;
    if (ran(leg)) {
      problems = [];
      const applied = await json(join(dir(leg), "applied.json"));
      const r = ptSyntheticSkipProblems(leg, applied, late);
      problems = r.problems;
      detail = r.detail;
    }
    checks.push(
      check(
        "pt-late-synthetic-skip",
        "native-fog-tint (LAR4, LAR5): on the registry-drop-binding sabotage (every process material falls to the synthetic placeholder shader) the native receiver skips every emitter recovered through it (counted in particles_resources.synthetic_skipped), instead of drawing white defaults",
        problems,
        detail,
      ),
    );
  }

  // pt-late-cmbt (LATE-CMBT): a post-arm process material whose material_set_shader named a
  // pre-arm shader RID is re-keyed through the particle_process_material builtin.
  {
    const leg = LATE_CMBT_CAPTURE;
    const stats = ppmStats(
      await json(join(dir(leg), "evidence", "result.json")),
    );
    let problems: string[] | null = null;
    if (ran(leg)) {
      problems = [];
      for (const sink of SINKS) {
        const t = await deps.trace(leg, sink);
        if (!t) problems.push(`${sink}: missing`);
        else
          for (const p of ptLateCmbtProblems(stats, t, lateShader))
            problems.push(`${sink}: ${p}`);
      }
      problems = [...new Set(problems)];
    }
    checks.push(
      check(
        "pt-late-cmbt",
        "LATE-CMBT: the post-arm cell's process material (material_set_shader names a pre-arm shader RID) is keyed through its particle_process_material builtin, so its emitter is ok on an ok builtin process material",
        problems,
        stats
          ? `${stats.unknown_shader_keyed ?? 0} unknown-shader process materials re-keyed`
          : undefined,
      ),
    );
  }

  // pt-registry-real-shader (LAR4): on the deferred arm every process material is adopted from the
  // registry with its real shader: no placeholder, and the deferred receivers skip nothing.
  const realShader = async (leg: string, cmbt: PtLateShader | undefined) => {
    const result = await json(join(dir(leg), "evidence", "result.json"));
    const stats = adoptionStats(result);
    const ppm = ppmStats(result);
    const problems: string[] = [];
    for (const sink of SINKS) {
      const t = await deps.trace(leg, sink);
      if (!t) problems.push(`${leg}/${sink}: missing`);
      else
        for (const p of ptRegistryRealShaderProblems(stats, ppm, t, late, {
          cmbt,
        }))
          problems.push(`${leg}/${sink}: ${p}`);
    }
    return problems;
  };
  {
    const problems: string[] = [];
    let any = false;
    const details: string[] = [];
    for (const [leg, cmbt, recv] of [
      [DEFERRED_CAPTURE, undefined, "deferred/receiver"],
      [DEFERRED_CMBT_CAPTURE, lateShader, DEFERRED_CMBT_RECEIVER],
    ] as const) {
      if (!ran(leg)) {
        problems.push(`${leg}: the leg did not run`);
        continue;
      }
      any = true;
      problems.push(...(await realShader(leg, cmbt)));
      if (!ran(recv)) {
        problems.push(`${recv}: the leg did not run`);
        continue;
      }
      const w11 = (await json(join(dir(recv), "applied.json")))?.w11 as
        | {
            applied?: number;
            particles?: {
              synthetic_skipped?: number;
              particles_created?: number;
              skipped_particles_commands?: number;
            };
          }
        | undefined;
      const pr = w11?.particles;
      // The receiver writes synthetic_skipped only when it skipped one: absent is 0.
      const sk = pr?.synthetic_skipped ?? 0;
      const created = pr?.particles_created;
      if (!pr || typeof created !== "number" || !((w11?.applied ?? 0) > 0))
        problems.push(
          `${recv}: applied.json has no w11.applied / particles counters (${w11?.applied}, ${created})`,
        );
      else {
        if (sk !== 0)
          problems.push(`${recv}: synthetic_skipped ${sk}, expected 0`);
        if ((pr.skipped_particles_commands ?? 0) !== 0)
          problems.push(
            `${recv}: skipped_particles_commands ${pr.skipped_particles_commands}, expected 0`,
          );
        if (created < late.emitters)
          problems.push(
            `${recv}: ${created} emitters created, at least ${late.emitters} expected`,
          );
        details.push(
          `${recv}: ${w11?.applied} applies, ${created} emitters created, 0 skipped`,
        );
      }
    }
    checks.push(
      check(
        "pt-registry-real-shader",
        "LAR4: on the deferred arm every process material is adopted from the registry with the shader material_set_shader named: no placeholder shader, nothing re-keyed, and the native receiver skips no emitter",
        any ? [...new Set(problems)] : null,
        details.join("; ") || undefined,
      ),
    );
    const id = "pt-registry-real-shader-catches-registry-drop-binding";
    const criterion =
      "LAR4: registry-drop-binding (the registry records no material shader bindings, so every process material falls to the placeholder) fails pt-registry-real-shader";
    if (!ran(DROP_BINDING_CAPTURE)) checks.push(check(id, criterion, null));
    else {
      const stats = adoptionStats(
        await json(join(dir(DROP_BINDING_CAPTURE), "evidence", "result.json")),
      );
      const t = await deps.trace(DROP_BINDING_CAPTURE, SINKS[0]);
      const found = ptRegistryRealShaderProblems(stats, null, t ?? [], late);
      checks.push(
        check(
          id,
          criterion,
          found.length > 0
            ? []
            : [
                `${DROP_BINDING_CAPTURE} passed: the placeholder fallback went unseen`,
              ],
          found[0],
        ),
      );
    }
  }

  // pt-registry-params (LAR4): the dummy host's registry-adopted process materials carry born's
  // parameters.
  {
    const id = "pt-registry-params";
    const criterion =
      "LAR4: on the headless (dummy renderer) deferred capture every process material's parameters equal the born capture's";
    if (!ran(HEADLESS_DEFERRED_CAPTURE) || !ran(BORN_CAPTURE))
      checks.push(check(id, criterion, null));
    else {
      const problems: string[] = [];
      let compared = 0;
      let excused: string[] = [];
      const result = await json(
        join(dir(HEADLESS_DEFERRED_CAPTURE), "evidence", "result.json"),
      );
      const stats = adoptionStats(result);
      // The dummy's texture refusals (G8r's counters), for the texture_replace exception.
      const resources = (
        (
          (result?.stream as Record<string, unknown> | undefined)?.gate8 as
            | Record<string, unknown>
            | undefined
        )?.adopt_stats as Record<string, unknown> | undefined
      )?.resources as Record<string, number> | undefined;
      const evidence = join(dir(HEADLESS_DEFERRED_CAPTURE), "evidence");
      const hold = await json(join(evidence, "hold.json"));
      const adoptLines = jsonl<Record<string, unknown>>(
        await readText(join(evidence, "resources.jsonl")),
      );
      const born = await deps.trace(BORN_CAPTURE, SINKS[0]);
      const head = await deps.trace(HEADLESS_DEFERRED_CAPTURE, SINKS[0]);
      if (!born || !head) problems.push("recording missing");
      else {
        const r = ptRegistryParamsProblems(
          stats,
          born,
          head,
          late,
          resources?.refused_no_image ?? 0,
          hold as { state?: string } | null,
          adoptLines,
        );
        problems.push(...r.problems);
        compared = r.compared;
        excused = r.excused;
      }
      checks.push(
        check(
          id,
          criterion,
          problems,
          `${compared} params compared` +
            (excused.length > 0
              ? `; excused (the dummy's texture_replace: texture refused no-image): ${excused.join(", ")}`
              : ""),
        ),
      );
    }
  }

  // pt-registry-source (LAR5): the deferred capture's emitters come from the registry and equal
  // the born capture's at the arm frame; registry-off must fail the same judgement.
  {
    const id = "pt-registry-source";
    const criterion =
      "LAR5: on the deferred arm every pre-arm emitter is adopted purely from the registry (registry.json records the particles family and payload; nothing refused preload-particles) and its configuration and floats equal the born capture's emitter at the arm frame";
    const source = async (leg: string) => {
      const result = await json(join(dir(leg), "evidence", "result.json"));
      const registry = await json(join(dir(leg), "evidence", "registry.json"));
      const adopted = await deps.trace(leg, SINKS[0]);
      const born = await deps.trace(BORN_CAPTURE, SINKS[0]);
      if (!adopted || !born)
        return {
          problems: [`${!adopted ? leg : BORN_CAPTURE}/${SINKS[0]}: missing`],
          detail: "recording missing",
        };
      return ptRegistrySourceProblems(
        adoptionStats(result),
        registry,
        adopted,
        born,
        late,
      );
    };
    if (!ran(DEFERRED_CAPTURE) || !ran(BORN_CAPTURE))
      checks.push(check(id, criterion, null));
    else {
      const r = await source(DEFERRED_CAPTURE);
      checks.push(check(id, criterion, r.problems, r.detail));
    }
    const idOff = "pt-registry-source-catches-registry-off";
    const criterionOff =
      "LAR5: registry-off (the registry records nothing, so every pre-arm emitter is refused preload-particles) fails pt-registry-source";
    if (!ran(SABOTAGE_REGISTRY_OFF_CAPTURE) || !ran(BORN_CAPTURE))
      checks.push(check(idOff, criterionOff, null));
    else {
      const r = await source(SABOTAGE_REGISTRY_OFF_CAPTURE);
      checks.push(
        check(
          idOff,
          criterionOff,
          r.problems.length > 0
            ? []
            : [
                `${SABOTAGE_REGISTRY_OFF_CAPTURE} passed: the missing registry source went unseen`,
              ],
          r.problems[0],
        ),
      );
    }
  }

  // pt-clock-origin (LAR7): the shader clock's start, from evidence (the wire carries none of it).
  {
    const id = "pt-clock-origin";
    const criterion =
      "LAR7: result.json stream.gate8.shader_clock shows where the carried shader clock began: deferred/capture (extension loaded at birth) origin startup, first tick at process frame 0, no draw missed; late/capture (extension loaded at frame 12) origin late-load, first tick after process frame 0";
    if (!ran(DEFERRED_CAPTURE) || !ran(LATE_CAPTURE))
      checks.push(check(id, criterion, null));
    else {
      const clockOf = async (leg: string) =>
        (
          (await json(join(dir(leg), "evidence", "result.json")))?.stream as
            | { gate8?: { shader_clock?: ShaderClockEvidence } }
            | undefined
        )?.gate8?.shader_clock;
      const d = shaderClockOrigin(await clockOf(DEFERRED_CAPTURE), "startup");
      const l = shaderClockOrigin(await clockOf(LATE_CAPTURE), "late-load");
      checks.push(
        check(
          id,
          criterion,
          [
            ...d.problems.map((p) => `${DEFERRED_CAPTURE}: ${p}`),
            ...l.problems.map((p) => `${LATE_CAPTURE}: ${p}`),
          ],
          `deferred: ${d.detail}; late: ${l.detail}`,
        ),
      );
    }
  }

  // standby-clock (LS1) and its sabotage: the rendered deferred arm's standby frames, through the
  // draw hook in the standby table.
  {
    const clockOf = async (leg: string) =>
      (
        (await json(join(dir(leg), "evidence", "result.json")))?.stream as
          | { gate8?: { shader_clock?: ShaderClockEvidence } }
          | undefined
      )?.gate8?.shader_clock;
    const standbyFrames = late.arm_frame - 1;
    const id = "standby-clock";
    const crit = `LS1: on the rendered host the shader clock advances through standby: ${DEFERRED_CAPTURE} (the standby table for its first ${standbyFrames} frames, then armed) sums every engine draw through the hooked draw (source draw-hook, draws_missed 0 over the whole run, draws at least the standby frames)`;
    if (!ran(DEFERRED_CAPTURE)) checks.push(check(id, crit, null));
    else {
      const r = standbyClockProblems(
        await clockOf(DEFERRED_CAPTURE),
        standbyFrames,
      );
      checks.push(
        check(
          id,
          crit,
          r.problems.map((p) => `${DEFERRED_CAPTURE}: ${p}`),
          r.detail,
        ),
      );
    }
    const sid = "sabotage-standby-no-draw";
    const scrit = `${STANDBY_NO_DRAW_CAPTURE} (GRC_STANDBY_FAULT=no-draw: draw left out of the standby table) fails standby-clock`;
    if (!ran(STANDBY_NO_DRAW_CAPTURE)) checks.push(check(sid, scrit, null));
    else {
      const r = standbyClockProblems(
        await clockOf(STANDBY_NO_DRAW_CAPTURE),
        standbyFrames,
      );
      checks.push(
        check(
          sid,
          scrit,
          r.problems.length > 0 ? [] : ["standby-clock did not fail"],
          `${r.problems[0] ?? "no problem"}; ${r.detail}`,
        ),
      );
    }
  }

  // The pixels: the reference's shots after the arm.
  const shots = ptShots(
    checkpoints.filter((c) => c.settle - 1 > late.arm_frame),
    px.tail_frames,
  );
  const refImg = new Map<string, Rgba>();
  if (ran("reference"))
    for (const s of shots) {
      const img = await decodePngRgba(
        join(dir("reference"), "shots", `${s.label}.png`),
      );
      if (img) refImg.set(s.label, img);
    }
  const judge = async (leg: string) => {
    const seqs = readdirSafe(join(dir(leg), "shots"))
      .map((n) => /^seq-(\d+)\.png$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    if (seqs.length !== shots.length)
      return `${seqs.length} shots, ${shots.length} wanted`;
    const rows: {
      label: string;
      frame: number;
      ink: ReturnType<typeof ptInk>;
      ref: ReturnType<typeof ptInk>;
      diff: ReturnType<typeof mmCellDiff>;
    }[] = [];
    for (let i = 0; i < shots.length; i++) {
      const img = await decodePngRgba(
        join(dir(leg), "shots", `seq-${seqs[i]}.png`),
      );
      const ref = refImg.get(shots[i].label);
      if (!img || !ref) return `${shots[i].label}: shot missing`;
      rows.push({
        label: shots[i].label,
        frame: shots[i].frame,
        ink: ptInk(img, px),
        ref: ptInk(ref, px),
        diff: mmCellDiff(img, ref, px.regions),
      });
    }
    return rows;
  };
  const lifecycle = async (leg: string) => {
    const rows = await judge(leg);
    if (typeof rows === "string")
      return { problems: [`${leg}: ${rows}`], rows: null };
    const problems: string[] = [];
    for (const r of rows)
      for (const p of ptLifecycleProblems(r.ink, r.ref))
        problems.push(`${leg} ${r.label}: ${p}`);
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
      if (!ran(leg) || !ran("reference")) {
        lc.push(`${leg}: the leg (or the reference) did not run`);
        continue;
      }
      any = true;
      const { problems, rows } = await lifecycle(leg);
      lc.push(...problems);
      if (!rows) continue;
      pixels[leg] = rows.map((r) => ({
        shot: r.label,
        ink: r.ink.cells,
        reference: r.ref.cells,
        diff: r.diff,
      }));
      for (const r of rows) {
        if (r.frame >= late.coverage_from_frame) {
          for (const p of ptCoverageProblems(r.ink, r.ref, px.coverage_band))
            cov.push(`${leg} ${r.label}: ${p}`);
          for (const [cell, n] of Object.entries(r.ref.cells))
            if (n > 0 && (r.ink.cells[cell] ?? 0) > 0)
              ratios.push((r.ink.cells[cell] ?? 0) / n);
        }
        if (!r.diff) out.push(`${leg} ${r.label}: size differs`);
        else if (r.diff.outside > 0)
          out.push(
            `${leg} ${r.label}: ${r.diff.outside} px differ outside every region`,
          );
      }
    }
    ratios.sort((a, b) => a - b);
    const note =
      ratios.length > 0
        ? `ink ratio to the reference: min ${ratios[0].toFixed(2)}, median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}, max ${ratios.at(-1)?.toFixed(2)}`
        : undefined;
    checks.push(
      check(
        "pt-late-lifecycle",
        "LAR4 (PM7's pixels): each deferred receiver lights exactly the cells the unarmed reference lights, at every shot after the arm",
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
    checks.push(
      check(
        "pt-late-outside-exact",
        "LAR4 (PM7's pixels): outside every emitter region each deferred receiver equals the reference exactly",
        any ? out : null,
      ),
    );
  }
  {
    const id = "pt-late-lifecycle-catches-no-particles";
    const criterion =
      "PM7: the receiver on the fault capture (no emitter adopted: the pre-PM7 capture) fails pt-late-lifecycle";
    if (!ran(FAULT_RECEIVER) || !ran("reference"))
      checks.push(check(id, criterion, null));
    else {
      const { problems } = await lifecycle(FAULT_RECEIVER);
      checks.push(
        check(
          id,
          criterion,
          problems.length > 0
            ? []
            : [`${FAULT_RECEIVER} passed: the missing adoption went unseen`],
          problems[0],
        ),
      );
    }
  }
  {
    const id = "pt-late-lifecycle-catches-registry-skip-particles";
    const criterion =
      "LAR5: the receiver on the registry-skip-particles capture (emitters adopted with a fresh emitter's configuration: amount 0, no material, no draw pass; nothing drawn) fails pt-late-lifecycle";
    if (!ran(SKIP_PARTICLES_RECEIVER) || !ran("reference"))
      checks.push(check(id, criterion, null));
    else {
      const { problems } = await lifecycle(SKIP_PARTICLES_RECEIVER);
      checks.push(
        check(
          id,
          criterion,
          problems.length > 0
            ? []
            : [
                `${SKIP_PARTICLES_RECEIVER} passed: the unrecorded particles setters went unseen`,
              ],
          problems[0],
        ),
      );
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
