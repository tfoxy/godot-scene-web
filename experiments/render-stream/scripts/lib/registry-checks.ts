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
 *   registry-cost        (LAR7) the registry's own in-situ cost: `on` (GRC_ADOPT=arm, the registry
 *                        records) against `regoff` (GRC_ADOPT=arm, GRC_ADOPT_FAULT=registry-off),
 *                        which differ by the registry alone, paired by round (the two legs run
 *                        back to back, so they share the machine's state). Per metric (the churned
 *                        create/free block's churn_us_mean, the hook path; perf.json's
 *                        frame_callback_us mean), the median paired delta must stay within the
 *                        registry's budget: REGISTRY_CALL_BUDGET_NS per tracked call times the
 *                        tracked calls a churned frame makes. `on` against GRC_ADOPT=off is
 *                        reported, not judged: it folds in G8r adoption's own lookups (LAR0:
 *                        +18-58 µs of run-to-run noise), which is not the registry's cost and made
 *                        the old "within noise of off" judgement red on clean main (LAR6: +58.1
 *                        against 49.5). frame_us_p50 is kept in the samples but not judged: the
 *                        capture's low-processor sleep paces a headless host at ~6.9 ms a frame
 *                        whatever the CPU did (2026-11-04: 6898-6901 µs on all nine legs).
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
  /** median of the `on` legs (µs) */
  on: number;
  /** median of the reference legs (µs) */
  ref: number;
  /** judged (against regoff): the median of the per-round paired deltas; else median(on) - median(ref) */
  delta: number;
  /** judged: the budget (µs); reported comparisons carry null */
  allowed: number | null;
  /** the per-round paired deltas (µs), in round order */
  paired: number[];
  judged: boolean;
  ok: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.floor(s.length / 2)];
};

/** The metrics registry-cost reads (frame_us_p50 is sleep-paced, see the header). */
export const COST_METRICS: (keyof CostSample)[] = ["churn_us_mean", "callback_us_mean"];

/**
 * The registry's budget per tracked call (create, free, setter), in situ, wherever its cost lands
 * (the hook path or the frame callback). Provenance (LAR7, results/p3/late-arm-registry.md
 * "registry-cost"): STS2's d12 seat makes about 27 tracked calls a frame (lar7-d12-1's counters
 * over 5,299 frames: 18.8 multimesh setters, 6.5 material_set_param, 0.9 frees, 0.6 creates, 0.5
 * particle setters; pm7-a12-1's are the same), so 1 µs a call bounds the registry near 27 µs a
 * frame, 0.16% of a 60 fps frame. The registry measured 46 ns a call at LAR0;
 * LAR7's three runs paired +35.9, +21.2 and +5.0 µs over 96 calls (50-375 ns a call, the spread
 * being run-to-run noise). The payload families LAR1-LAR5 added are legitimate work that a
 * "within noise" judgement does not allow for, and its spread-based allowance widened as the
 * machine got noisier (it failed only the quietest run). A runaway registry (a per-call
 * allocation storm, a scan per call) still fails the budget.
 */
export const REGISTRY_CALL_BUDGET_NS = 1000;
/** registry-cost's churn: each triple (mesh, shader, material) is created and freed every frame. */
export const COST_CALLS_PER_TRIPLE = 6;

/**
 * registry-cost: per metric, the median over rounds of (on_r - regoff_r) <= callsPerFrame x
 * REGISTRY_CALL_BUDGET_NS. `on` vs `off` is reported (judged false). Samples are in round order;
 * the paired configs need equally many.
 */
export function registryCost(
  samples: Record<string, CostSample[]>,
  callsPerFrame: number,
): {
  problems: string[];
  comparisons: CostComparison[];
} {
  const problems: string[] = [];
  const comparisons: CostComparison[] = [];
  for (const c of ["off", "on", "regoff"])
    if (!samples[c] || samples[c].length === 0) problems.push(`no ${c} samples`);
  if (problems.length > 0) return { problems, comparisons };
  if (samples.on.length !== samples.regoff.length)
    return { problems: [`${samples.on.length} on legs against ${samples.regoff.length} regoff legs: unpaired`], comparisons };
  if (!(callsPerFrame > 0)) return { problems: [`tracked calls a frame ${callsPerFrame}: no budget`], comparisons };
  const allowed = (callsPerFrame * REGISTRY_CALL_BUDGET_NS) / 1000;
  for (const metric of COST_METRICS) {
    const on = samples.on.map((s) => s[metric]);
    {
      const ref = samples.regoff.map((s) => s[metric]);
      const paired = on.map((v, i) => v - ref[i]);
      const delta = median(paired);
      const ok = Number.isFinite(delta) && delta <= allowed;
      comparisons.push({ metric, against: "regoff", on: median(on), ref: median(ref), delta, allowed, paired, judged: true, ok });
      if (!ok)
        problems.push(
          `${metric}: on - regoff +${delta.toFixed(1)} µs (paired median of ${paired.map((d) => d.toFixed(1)).join(", ")}), budget ${allowed.toFixed(1)} µs (${callsPerFrame} tracked calls a frame x ${REGISTRY_CALL_BUDGET_NS} ns)`,
        );
    }
    {
      const ref = samples.off.map((s) => s[metric]);
      const paired = ref.length === on.length ? on.map((v, i) => v - ref[i]) : [];
      comparisons.push({ metric, against: "off", on: median(on), ref: median(ref), delta: median(on) - median(ref), allowed: null, paired, judged: false, ok: true });
    }
  }
  return { problems, comparisons };
}

/** LAR6 resolve-queue-only: the late groups whose deferred legs it reads, and the leg names that
 * count as deferred (the extension loaded at birth, the arm deferred: every resource registered). */
export const RESOLVE_QUEUE_GROUPS = ["g8a", "g8m", "g8mm", "g8ctl", "g8ctsp", "g8res", "g8pt"] as const;
export const isDeferredLeg = (leg: string): boolean => /^(headless-)?deferred(-[a-z0-9]+)?$/.test(leg);

/** resolve-queue-only's verdict: every deferred leg's adopt_stats.resolve_scans (the mirror scans
 * the frame drains made) is 0. Pure. A leg without the counter fails; no deferred leg at all is
 * not-run (null). */
export function judgeResolveQueueOnly(
  legs: readonly { leg: string; resolve_scans: number | undefined }[],
): { problems: string[] | null; detail: string } {
  if (legs.length === 0) return { problems: null, detail: "no deferred leg ran" };
  const problems: string[] = [];
  for (const l of legs) {
    if (typeof l.resolve_scans !== "number") problems.push(`${l.leg}: no adopt_stats.resolve_scans`);
    else if (l.resolve_scans !== 0) problems.push(`${l.leg}: resolve_scans ${l.resolve_scans}`);
  }
  return { problems, detail: legs.map((l) => `${l.leg} ${l.resolve_scans}`).join(", ") };
}

/** LAR7: result.json `stream.gate8.shader_clock` (capture/src/rs_shader_clock.h), evidence only. */
export interface ShaderClockEvidence {
  source?: string;
  origin?: string;
  first_tick_process_frames?: number;
  first_tick_frames_drawn?: number;
  draws_missed?: number;
  ticks?: number;
  draws?: number;
}

/**
 * clock-origin (LAR7): where a /10+ capture's shader clock began. `startup` (the extension loaded
 * at birth: its first frame callback was the host's first iteration, so the clock missed nothing)
 * wants origin "startup", first_tick_process_frames 0 and, with the draw hook as the source,
 * draws_missed 0. `late-load` (the extension loaded after the host started) wants origin
 * "late-load" and first_tick_process_frames > 0: the evidence shows the late start that the
 * wire's shader_time cannot. Pure.
 */
export function shaderClockOrigin(
  clock: ShaderClockEvidence | null | undefined,
  want: "startup" | "late-load",
): { problems: string[]; detail: string } {
  if (!clock) return { problems: ["no result.json stream.gate8.shader_clock"], detail: "absent" };
  const problems: string[] = [];
  const detail = `origin ${clock.origin} first_tick_process_frames ${clock.first_tick_process_frames} draws_missed ${clock.draws_missed} source ${clock.source}`;
  if (clock.origin !== want) problems.push(`origin ${clock.origin}, want ${want}`);
  const frames = clock.first_tick_process_frames;
  if (typeof frames !== "number") problems.push("no first_tick_process_frames");
  else if (want === "startup" && frames !== 0) problems.push(`first_tick_process_frames ${frames}, want 0`);
  else if (want === "late-load" && frames <= 0) problems.push(`first_tick_process_frames ${frames}, want > 0`);
  if (want === "startup" && clock.source === "draw-hook" && clock.draws_missed !== 0)
    problems.push(`draws_missed ${clock.draws_missed}, want 0`);
  return { problems, detail };
}
