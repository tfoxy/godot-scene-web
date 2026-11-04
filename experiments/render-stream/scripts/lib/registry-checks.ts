/**
 * LAR0 (protocol/late-arm-registry-design.md): the late-arm registry's evidence checks, judged in
 * g8a (lib/gate8-adopt-checks.ts runG8a).
 *
 *   registry-live-bound  evidence/registry.json (capture/src/rs_registry.h) against the hook
 *                        counters (evidence/counters.json): per family, on every timeline row and
 *                        at the end, entries == creates - frees (frees counting free calls that
 *                        named a registered RID, texture_replace sources and recreates), so a free
 *                        always erases and the registry is bounded by live engine resources; at
 *                        the end, creates + overflow + null_creates == the family's create-hook
 *                        calls (every tracked create recorded); no overflow, no dropped row.
 *   registry-cost        capture-scale's churned create/free block (scale report churn_us_mean:
 *                        the hook path, engine work included) and the frame callback (perf.json
 *                        frame_callback_us mean) with the registry recording, against GRC_ADOPT=off
 *                        and against registry-off, within noise. frame_us_p50 is kept in the
 *                        samples but not judged: the capture's low-processor sleep paces a headless
 *                        host at ~6.9 ms a frame whatever the CPU did (2026-11-04: 6898-6901 µs on
 *                        all nine legs).
 *
 * Pure functions over parsed JSON, so a unit test can drive them.
 */

/** registry.json's per-family block (render-stream-registry/1). */
export interface RegistryFamily {
  entries: number;
  peak: number;
  creates: number;
  frees: number;
  replaced: number;
  recreated: number;
  null_creates: number;
  overflow: number;
  bytes_estimate: number;
}

export interface RegistryEvidence {
  schema: string;
  configured: boolean;
  enabled: boolean;
  fault: string;
  cap: number;
  entries: number;
  peak: number;
  bytes_estimate: number;
  families: Record<string, RegistryFamily>;
  timeline: {
    family_order: string[];
    cap: number;
    dropped: number;
    rows: {
      frame: number;
      entries: number[];
      creates: number[];
      frees: number[];
    }[];
  };
}

/** The hooked creates per registry family (hooks.cpp registry_create call sites). */
export const REGISTRY_CREATE_HOOKS: Record<string, string[]> = {
  texture: ["texture_2d_create", "texture_2d_placeholder_create"],
  canvas_texture: ["canvas_texture_create"],
  mesh: ["mesh_create", "mesh_create_from_surfaces"],
  multimesh: ["multimesh_create"],
  shader: ["shader_create", "shader_create_from_code"],
  material: ["material_create", "material_create_from_shader"],
  particles: ["particles_create"],
};

export interface LiveBoundOptions {
  /** A deferred leg's arm frame: at least one tracked free must be recorded before it (R5). */
  preArmFreesBefore?: number;
}

export interface LiveBoundSummary {
  rows: number;
  creates: number;
  frees: number;
  peak: number;
  bytes_estimate: number;
  pre_arm_frees: number;
}

/**
 * registry-live-bound on one leg. `counts` is counters.json's `counts` (a hook absent or null:
 * not installed, 0 calls). Returns the problems (empty: the bound holds) and a summary.
 */
export function registryLiveBound(
  name: string,
  reg: RegistryEvidence | null | undefined,
  counts: Record<string, number | null> | null | undefined,
  opts: LiveBoundOptions = {},
): { problems: string[]; summary: LiveBoundSummary | null } {
  const problems: string[] = [];
  if (!reg) return { problems: [`${name}: no evidence/registry.json`], summary: null };
  if (!counts) return { problems: [`${name}: no evidence/counters.json`], summary: null };
  if (reg.schema !== "render-stream-registry/1")
    problems.push(`${name}: schema ${reg.schema}`);
  if (!reg.configured || !reg.enabled)
    problems.push(`${name}: registry not recording (configured ${reg.configured}, enabled ${reg.enabled})`);
  const order = reg.timeline?.family_order ?? [];
  const families = Object.keys(REGISTRY_CREATE_HOOKS);
  if (order.join(",") !== families.join(","))
    problems.push(`${name}: timeline family_order ${order.join(",")}`);
  if ((reg.timeline?.dropped ?? 1) !== 0)
    problems.push(`${name}: ${reg.timeline?.dropped} timeline rows dropped`);
  let creates = 0;
  let frees = 0;
  let total = 0;
  for (const f of families) {
    const v = reg.families?.[f];
    if (!v) {
      problems.push(`${name}: no family ${f}`);
      continue;
    }
    total += v.entries;
    creates += v.creates;
    frees += v.frees + v.replaced;
    const live = v.creates - v.frees - v.replaced - v.recreated;
    if (v.entries !== live)
      problems.push(
        `${name}: ${f} ends with ${v.entries} entries for ${v.creates} creates - ${v.frees} frees - ${v.replaced} replaced - ${v.recreated} recreated = ${live} live`,
      );
    if (v.overflow !== 0) problems.push(`${name}: ${f} overflowed ${v.overflow} times`);
    const hooks = REGISTRY_CREATE_HOOKS[f].reduce(
      (sum, h) => sum + (counts[h] ?? 0),
      0,
    );
    if (v.creates + v.overflow + v.null_creates !== hooks)
      problems.push(
        `${name}: ${f} recorded ${v.creates} creates (+${v.overflow} overflow, +${v.null_creates} null) for ${hooks} create-hook calls (${REGISTRY_CREATE_HOOKS[f].join(", ")})`,
      );
    if (v.peak < v.entries) problems.push(`${name}: ${f} peak ${v.peak} below its entries ${v.entries}`);
  }
  if (total !== reg.entries) problems.push(`${name}: entries ${reg.entries}, families sum to ${total}`);
  const freeCalls = (counts.free ?? 0) + (counts.texture_replace ?? 0);
  if (frees > freeCalls)
    problems.push(`${name}: ${frees} registry frees for ${freeCalls} free/texture_replace calls`);
  let rowProblems = 0;
  let preArmFrees = 0;
  let lastFrame = -1;
  for (const row of reg.timeline?.rows ?? []) {
    if (row.frame <= lastFrame)
      problems.push(`${name}: timeline frame ${row.frame} after ${lastFrame}`);
    lastFrame = row.frame;
    for (let i = 0; i < families.length; ++i) {
      if (row.entries[i] !== row.creates[i] - row.frees[i]) {
        if (rowProblems++ < 5)
          problems.push(
            `${name}: frame ${row.frame} ${families[i]}: ${row.entries[i]} entries for ${row.creates[i]} creates - ${row.frees[i]} frees`,
          );
      }
    }
    if (opts.preArmFreesBefore !== undefined && row.frame < opts.preArmFreesBefore)
      preArmFrees = row.frees.reduce((a, b) => a + b, 0);
  }
  if (rowProblems > 5) problems.push(`${name}: ... ${rowProblems - 5} more row mismatches`);
  if (opts.preArmFreesBefore !== undefined && preArmFrees === 0)
    problems.push(`${name}: no tracked free recorded before the arm (frame ${opts.preArmFreesBefore})`);
  return {
    problems,
    summary: {
      rows: reg.timeline?.rows?.length ?? 0,
      creates,
      frees,
      peak: reg.peak,
      bytes_estimate: reg.bytes_estimate,
      pre_arm_frees: preArmFrees,
    },
  };
}

/** One registry-cost leg's numbers. */
export interface CostSample {
  frame_us_p50: number;
  churn_us_mean: number;
  callback_us_mean: number;
}

export interface CostComparison {
  metric: keyof CostSample;
  against: string;
  on: number;
  ref: number;
  delta: number;
  allowed: number;
  ok: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.floor(s.length / 2)];
};
const spread = (xs: number[]) => (xs.length === 0 ? 0 : Math.max(...xs) - Math.min(...xs));

/**
 * The judged metrics and their absolute floors (µs) under which a difference is never judged:
 * timer and scheduler grain. frame_us_p50 is not judged (sleep-paced, see the header).
 */
export const COST_FLOOR_US: Partial<Record<keyof CostSample, number>> = {
  churn_us_mean: 5,
  callback_us_mean: 10,
};
/** Relative tolerance: within noise means within this share of the reference, or its spread. */
export const COST_RELATIVE = 0.05;

/**
 * registry-cost: per metric, median(on) - median(ref) <= max(spread(on), spread(ref),
 * COST_RELATIVE x median(ref), floor) for ref in {off, regoff}.
 */
export function registryCost(samples: Record<string, CostSample[]>): {
  problems: string[];
  comparisons: CostComparison[];
} {
  const problems: string[] = [];
  const comparisons: CostComparison[] = [];
  for (const c of ["off", "on", "regoff"])
    if (!samples[c] || samples[c].length === 0) problems.push(`no ${c} samples`);
  if (problems.length > 0) return { problems, comparisons };
  for (const metric of Object.keys(COST_FLOOR_US) as (keyof CostSample)[]) {
    const on = samples.on.map((s) => s[metric]);
    for (const against of ["off", "regoff"]) {
      const ref = samples[against].map((s) => s[metric]);
      const mOn = median(on);
      const mRef = median(ref);
      const allowed = Math.max(spread(on), spread(ref), COST_RELATIVE * mRef, COST_FLOOR_US[metric] ?? 0);
      const delta = mOn - mRef;
      const ok = Number.isFinite(delta) && delta <= allowed;
      comparisons.push({ metric, against, on: mOn, ref: mRef, delta, allowed, ok });
      if (!ok)
        problems.push(
          `${metric}: on ${mOn.toFixed(1)} vs ${against} ${mRef.toFixed(1)} µs (+${delta.toFixed(1)}, allowed ${allowed.toFixed(1)})`,
        );
    }
  }
  return { problems, comparisons };
}
