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
  /**
   * LS1: the fixture's own tracked creates per family (its `[fixture] registry-churn` line). The
   * registry must record at least these. The hook counters cannot catch a create slot missing from
   * the standby table: the hook then neither counts nor records, and the identity above still holds.
   */
  ownCreates?: Record<string, number>;
}

/** LS1: the fixture's own counts, from the `[fixture] registry-churn {...}` stdout line. */
export function parseRegistryChurn(
  stdout: string | null | undefined,
): { own_creates: Record<string, number>; own_frees: number } | null {
  const m = /\[fixture\] registry-churn (\{.*\})/.exec(stdout ?? "");
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as { own_creates: Record<string, number>; own_frees: number };
  } catch {
    return null;
  }
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
    // A create the engine answered with RID() (the dummy's canvas_texture_create) is recorded as a
    // null create: it still shows the hook saw the call.
    const own = opts.ownCreates?.[f];
    const seen = v.creates + v.null_creates + v.overflow;
    if (own !== undefined && seen < own)
      problems.push(`${name}: ${f} recorded ${seen} creates (null and overflow included), below the fixture's own ${own}`);
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
  /** LS0: the scale report's params block (section_us.params, RS_SCALE_CPU_REPORT=1): wall µs a frame
   * of `paramCalls` material_set_param calls, judged alone. Absent in older samples. */
  params_us?: number;
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
export const COST_METRICS: ("churn_us_mean" | "callback_us_mean")[] = ["churn_us_mean", "callback_us_mean"];
/** LS0: the metric `material_set_param` is judged alone on (its calls a frame, not the churn's). */
export const PARAM_METRIC: keyof CostSample = "params_us";

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
  paramCalls = 0,
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
  // LS0: material_set_param judged alone, on-regoff paired by round, at the same per-call budget.
  // `paramCalls` is the report's param_updates; absent (0), the metric is not judged.
  if (paramCalls > 0) {
    const have = (c: string) => samples[c].every((s) => typeof s[PARAM_METRIC] === "number");
    if (!have("on") || !have("regoff")) {
      problems.push(`params_us missing from the on/regoff samples (RS_SCALE_CPU_REPORT=1 and RS_SCALE_PARAM_UPDATES=${paramCalls})`);
    } else {
      const on = samples.on.map((s) => s[PARAM_METRIC] as number);
      const ref = samples.regoff.map((s) => s[PARAM_METRIC] as number);
      const paired = on.map((v, i) => v - ref[i]);
      const delta = median(paired);
      const allowedParams = (paramCalls * REGISTRY_CALL_BUDGET_NS) / 1000;
      const ok = Number.isFinite(delta) && delta <= allowedParams;
      comparisons.push({ metric: PARAM_METRIC, against: "regoff", on: median(on), ref: median(ref), delta, allowed: allowedParams, paired, judged: true, ok });
      if (!ok)
        problems.push(
          `material_set_param alone: on - regoff +${delta.toFixed(1)} µs over ${paramCalls} calls a frame (paired median of ${paired.map((d) => d.toFixed(1)).join(", ")}), budget ${allowedParams.toFixed(1)} µs (${REGISTRY_CALL_BUDGET_NS} ns a call)`,
        );
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

/**
 * LS0 validation-log-cost (a timing group): capture-scale at STS2's redraw rate (1,532 hooked calls
 * a frame), loaded and unarmed, the main thread's CPU a frame (the scale report's cpu_us_mean) in
 * four configs interleaved over rounds: `a0` (GRC_MODE=validate: loaded, nothing patched), `b`
 * (hooks patched, never armed, GRC_ADOPT=off), `c` (b plus GRC_ADOPT=arm, the registry recording)
 * and `cs` (c with the validation-log-ignored sabotage: the knob is read, the logs still run).
 * Provenance: results/p3/idle-capture-cost.md measured the same legs with the logs on: (b) +72 µs,
 * (c) +110 µs over no capture, K2 (the validation logs) 80 µs of it (paired c - d, 71-90 µs over 5
 * rounds). The bound is on the paired median of (config - a0), per round. LS0 measured (5 rounds,
 * machine at load 6-15, so noisy): b - a0 median -4 and c - a0 median +3 µs (means +26 and +19; the
 * main thread's CPU a frame ran 790-920 µs round to round), and the sabotage +183 µs. Through the
 * runner at load 3-5: b - a0 -22 and +17, c - a0 -2 and +35, the sabotage +98 and +114 µs over a0
 * (+73 over c). The bounds are 6% (b) and 7% (c) of a frame's 840 µs: above the remaining registry
 * work (creates and frees about 24 µs a frame at 96 calls, material_set_param about 4 µs at 8 calls)
 * plus a median's noise, and under what K2 puts back (80 µs quiet, more under load). Under a load
 * of 8 or more the numbers are not usable (one run read b - a0 +88, c - a0 +140): rerun on a quiet
 * machine.
 */
export interface IdleSample {
  cpu_us_mean: number;
  /** LS1: the fixture's VmRSS at quit (the scale report's rss_kb), when it reported one. */
  rss_kb?: number;
}

/**
 * LS1 idle-parity (live-swap-design.md D4, fork F1): GRC_MODE=standby (`s`) against no capture at
 * all (`n`, the extension not loaded) on the same fixture, paired by round, with no exemption for
 * the registry. F1's bound: the paired median main-thread CPU delta at most 1% of no capture's
 * median CPU a frame, and the paired median RSS delta at most 10 MB.
 */
export const IDLE_PARITY_CPU_FRACTION = 0.01;
export const IDLE_PARITY_RSS_KB = 10 * 1024;

export function idleParity(samples: Record<string, IdleSample[]>): {
  problems: string[];
  cpu: { median: number; paired: number[]; bound: number; base: number } | null;
  rss: { median: number; paired: number[]; bound: number } | null;
} {
  const problems: string[] = [];
  const n = samples.n ?? [];
  const st = samples.s ?? [];
  if (n.length === 0 || st.length === 0) return { problems: [`no ${n.length === 0 ? "n" : "s"} samples`], cpu: null, rss: null };
  if (n.length !== st.length) return { problems: [`${st.length} s legs against ${n.length} n legs: unpaired`], cpu: null, rss: null };
  const base = median(n.map((x) => x.cpu_us_mean));
  const paired = st.map((x, i) => x.cpu_us_mean - n[i].cpu_us_mean);
  const m = median(paired);
  const bound = base * IDLE_PARITY_CPU_FRACTION;
  if (!(Number.isFinite(m) && m <= bound))
    problems.push(
      `s - n +${m.toFixed(1)} µs a frame (paired median of ${paired.map((d) => d.toFixed(1)).join(", ")}), bound ${bound.toFixed(1)} µs (1% of n's ${base.toFixed(1)})`,
    );
  let rss: { median: number; paired: number[]; bound: number } | null = null;
  if (st.every((x) => typeof x.rss_kb === "number") && n.every((x) => typeof x.rss_kb === "number")) {
    const rp = st.map((x, i) => (x.rss_kb as number) - (n[i].rss_kb as number));
    const rm = median(rp);
    rss = { median: rm, paired: rp, bound: IDLE_PARITY_RSS_KB };
    if (!(rm <= IDLE_PARITY_RSS_KB))
      problems.push(`s - n RSS +${(rm / 1024).toFixed(1)} MB (paired median), bound 10 MB`);
  } else problems.push("a leg reported no rss_kb");
  return { problems, cpu: { median: m, paired, bound, base }, rss };
}

export interface IdleComparison {
  config: string;
  against: "a0";
  median: number;
  paired: number[];
  bound: number;
  ok: boolean;
}

export const VALIDATION_LOG_COST_BOUND_US = {
  b: 50,
  c: 60,
} as const;
/** The sabotage must show at least this much of K2 (µs a frame) over the honest (c). */
export const VALIDATION_LOG_SABOTAGE_MIN_US = 30;

export function validationLogCost(
  samples: Record<string, IdleSample[]>,
  judge: readonly ("b" | "c" | "cs")[] = ["b", "c"],
): { problems: string[]; comparisons: IdleComparison[] } {
  const problems: string[] = [];
  const comparisons: IdleComparison[] = [];
  const a0 = samples.a0 ?? [];
  if (a0.length === 0) return { problems: ["no a0 samples"], comparisons };
  for (const config of judge) {
    const rows = samples[config] ?? [];
    if (rows.length === 0) {
      problems.push(`no ${config} samples`);
      continue;
    }
    if (rows.length !== a0.length) {
      problems.push(`${rows.length} ${config} legs against ${a0.length} a0 legs: unpaired`);
      continue;
    }
    const paired = rows.map((s, i) => s.cpu_us_mean - a0[i].cpu_us_mean);
    const m = median(paired);
    const bound = VALIDATION_LOG_COST_BOUND_US[config === "cs" ? "c" : config];
    const ok = Number.isFinite(m) && m <= bound;
    comparisons.push({ config, against: "a0", median: m, paired, bound, ok });
    if (!ok)
      problems.push(
        `${config} - a0 +${m.toFixed(1)} µs a frame (paired median of ${paired.map((d) => d.toFixed(1)).join(", ")}), bound ${bound} µs`,
      );
  }
  return { problems, comparisons };
}

/**
 * LS1 standby-hot-zero (live-swap-design.md D4): on a capture that published the standby table and
 * never armed (GRC_MODE=standby), every planned hook outside the standby set ran 0 times, and the
 * set the capture installed is exactly the expected one. `standbyHooks` is rs_standby.cpp's list
 * (STANDBY_HOOKS), not the capture's own report, so a capture that installs more fails. The caller
 * shows the fixture makes hot calls at all (an armed leg of the same fixture counts them).
 */
export function standbyHotZero(
  name: string,
  result: { status?: string; vtable?: { published?: string; standby_hooks?: string[] } } | null | undefined,
  counters: { hooks_planned?: string[]; counts?: Record<string, number | null> } | null | undefined,
  standbyHooks: readonly string[],
): { problems: string[]; hot_planned: number; hot_calls: number; standby_calls: number } {
  const problems: string[] = [];
  let hot = 0;
  let hotCalls = 0;
  let standbyCalls = 0;
  if (!result) problems.push(`${name}: no evidence/result.json`);
  if (!counters?.counts || !counters.hooks_planned) {
    problems.push(`${name}: no counters.json counts/hooks_planned`);
    return { problems, hot_planned: 0, hot_calls: 0, standby_calls: 0 };
  }
  if (result && result.status !== "standby") problems.push(`${name}: status ${result.status}, want standby`);
  const want = new Set(standbyHooks);
  const installed = [...(result?.vtable?.standby_hooks ?? [])].sort();
  const expected = counters.hooks_planned.filter((h) => want.has(h)).sort();
  if (installed.join(",") !== expected.join(","))
    problems.push(
      `${name}: the standby table installs [${installed.filter((h) => !want.has(h)).join(",")}] beyond and lacks [${expected.filter((h) => !installed.includes(h)).join(",")}] of the standby set`,
    );
  for (const h of counters.hooks_planned) {
    const n = counters.counts[h] ?? 0;
    if (want.has(h)) {
      standbyCalls += n;
      continue;
    }
    ++hot;
    hotCalls += n;
    if (n !== 0 && problems.length < 8) problems.push(`${name}: hot hook ${h} ran ${n} times in standby`);
  }
  if (hot === 0) problems.push(`${name}: no hot hook planned`);
  return { problems, hot_planned: hot, hot_calls: hotCalls, standby_calls: standbyCalls };
}

/** LS1: rs_standby.cpp's set (the ctest rs_standby pins the C++ side to the same list). */
export const STANDBY_HOOKS: readonly string[] = [
  "canvas_texture_create",
  "canvas_texture_set_channel",
  "canvas_texture_set_texture_filter",
  "canvas_texture_set_texture_repeat",
  "draw",
  "free",
  "material_create",
  "material_create_from_shader",
  "material_set_param",
  "material_set_shader",
  "mesh_create",
  "mesh_create_from_surfaces",
  "multimesh_allocate_data",
  "multimesh_create",
  "multimesh_instance_set_color",
  "multimesh_instance_set_custom_data",
  "multimesh_instance_set_transform",
  "multimesh_instance_set_transform_2d",
  "multimesh_set_buffer",
  "multimesh_set_buffer_interpolated",
  "multimesh_set_custom_aabb",
  "multimesh_set_mesh",
  "multimesh_set_visible_instances",
  "particles_create",
  "particles_request_process",
  "particles_request_process_time",
  "particles_restart",
  "particles_set_amount",
  "particles_set_amount_ratio",
  "particles_set_collision_base_size",
  "particles_set_custom_aabb",
  "particles_set_draw_order",
  "particles_set_draw_pass_mesh",
  "particles_set_draw_passes",
  "particles_set_emission_transform",
  "particles_set_emitter_velocity",
  "particles_set_emitting",
  "particles_set_explosiveness_ratio",
  "particles_set_fixed_fps",
  "particles_set_fractional_delta",
  "particles_set_interp_to_end",
  "particles_set_interpolate",
  "particles_set_lifetime",
  "particles_set_mode",
  "particles_set_one_shot",
  "particles_set_pre_process_time",
  "particles_set_process_material",
  "particles_set_randomness_ratio",
  "particles_set_seed",
  "particles_set_speed_scale",
  "particles_set_subemitter",
  "particles_set_trail_bind_poses",
  "particles_set_trails",
  "particles_set_transform_align",
  "particles_set_use_local_coordinates",
  "shader_create",
  "shader_create_from_code",
  "shader_set_code",
  "shader_set_default_texture_parameter",
  "texture_2d_create",
  "texture_2d_placeholder_create",
  "texture_2d_update",
  "texture_replace",
  "texture_set_path",
];
