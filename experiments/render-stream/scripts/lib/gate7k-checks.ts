// G7k checks (gate7-design.md Q10 "Suspension, lifecycle, startup and memory" -- the startup and
// soak halves; protocol/gate7/g7k.md). Two run-gate6.sh groups per receiver kind
// (run-gate7.sh "Group landed (G7k)"):
//
//   soak     <out>/gate6/g6s-<kind>/: --legs g6s reused unforked. GSW's perf.json now carries the
//            native shape for the fields G6s's own evaluators read (`cache_entries_memory`,
//            `cache_bytes_memory`, `cache_entries_disk`/`cache_bytes_disk` always 0, `live_rids`),
//            so gate6s-checks.ts's residencyMetrics/checkResidencyBounded/
//            checkCacheBudgetRespected/checkSoakPixels run on a GSW leg completely unchanged.
//            New here: the browser-only memory checks (rss-bounded-renderer/_gpu, js-heap-bounded,
//            wasm-heap-bounded, gpu-mem-bounded) from gate7k-samplers.ts's mem-timeline.jsonl, and
//            the GSW-only GL-texture residency/leak check (live_rids.textures +
//            leaked_gl_textures, gl-leak.ts).
//   startup  <out>/gate6/startup-<kind>/live/startup-<cold|warm>-r<N>/: each leg's own
//            timings.json (D15's navigation-relative marks, performance.getEntriesByType("mark")/
//            ("resource")) -- startup-complete (every mark present and ordered) and
//            startup-warm-fetches (warm: zero GETs for payload hashes, the bundle/wasm/.pck
//            served from the HTTP cache), with every mark's five-repeat distribution (r1..r5; r0
//            is the discarded warmup) reported alongside, no pass threshold beyond those two
//            checks (Q10).
//
// Pure over an evidence directory run-gate7.sh wrote, like gate6s-checks.ts and gate7u-checks.ts:
// nothing here launches a process.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Gate6Expected } from "./gate6-expected";
import {
  checkCacheBudgetRespected,
  checkResidencyBounded,
  checkSoakPixels,
  G6S_DIR,
  G6S_LEGS,
  G6S_MEMORY_BUDGET_BYTES,
  G6S_RESIDENCY_GROWTH_SLACK,
  type G6sLeg,
  type G6sLegEvidence,
  loadG6sLeg,
  maxInWindowThird,
  medianInWindowEnd,
  receiverSeries,
  relativeSeries,
  residencyMetrics,
  slopePerMinute,
  type TimePoint,
} from "./gate6s-checks";
import { decodePngRgba } from "./gate-minus1-checks";
import { classifyShot } from "./gate7b-adapters";
import { type Gate7Check, mk } from "./gate7-adapters";
import { classMask, judgeQ7Classes } from "./gsw-tolerance";
import type { MemSample } from "./gate7k-samplers";

export type G7kKind = "web" | "gsw";

export interface G7kKindResult {
  group: "g7-k";
  kind: G7kKind;
  live: true;
  passed: boolean;
  run_dir: string;
  checks: Gate7Check[];
  /** Each D15 mark's navigation-relative time (ms), r1..r5 only (r0 discarded), per temperature. */
  startup_marks: Record<"cold" | "warm", Record<string, number[]>>;
  /** Receiver-side intervals per repeat (r1..r5, ms), so a host that is slower to publish than a
   * cached page is to connect (the navigation-relative `rs-session-decoded` then waits on the
   * host) does not hide the receiver's own cost: session-decoded to first-applied, first-applied
   * to first-submitted. Reported, never judged (Q10 sets no threshold). */
  startup_intervals: Record<"cold" | "warm", Record<string, number[]>>;
}

const MIB = 1 << 20;

/** The soak legs this kind actually ran (run-gate7.sh's G6S_SOAK_LEGS_<kind>): every kind gets
 * `soak-scene` and `sabotage-soak-no-evict` (G6S_LEGS's own two entries, reused verbatim); GSW
 * also gets the GSW-only `sabotage-leak-gl-textures`, which has no G6S_LEGS entry (it fails a
 * check G6s never had, not `residency-bounded`'s existing metrics) and so is judged separately. */
function soakLegsOf(kind: G7kKind): G6sLeg[] {
  const byName = new Map(G6S_LEGS.map((l) => [l.leg, l]));
  const named = (name: string): G6sLeg => {
    const l = byName.get(name);
    if (!l) throw new Error(`gate7k-checks: unknown G6S_LEGS entry ${name}`);
    return l;
  };
  const legs = [named("soak-scene"), named("sabotage-soak-no-evict")];
  if (kind === "gsw")
    legs.push({
      leg: "sabotage-leak-gl-textures",
      failsMetric: null,
      inline: false,
    });
  return legs;
}

function toG7(c: {
  id: string;
  criterion: string;
  passed: boolean;
  detail: string;
}): Gate7Check {
  return {
    id: c.id,
    criterion: c.criterion,
    passed: c.passed,
    gating: true,
    detail: c.detail,
  };
}

async function loadMemTimeline(dir: string): Promise<MemSample[]> {
  const path = join(dir, "mem-timeline.jsonl");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8").catch(() => "");
  const out: MemSample[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as MemSample);
    } catch {
      // A torn last line (the sampler was mid-write when the leg ended): skip it, keep the rest.
    }
  }
  return out;
}

function memSeries(
  samples: readonly MemSample[],
  pick: (s: MemSample) => number | null | undefined,
): TimePoint[] {
  const raw = samples
    .map((s) => ({ t: s.t_us / 1e6, v: pick(s) }))
    .filter(
      (p): p is { t: number; v: number } => p.v !== null && p.v !== undefined,
    );
  return relativeSeries(raw);
}

/** Q10's `rss-bounded-renderer`/`rss-bounded-gpu`/`js-heap-bounded`: median(last 30 s) -
 * median(first 30 s) <= growthBudgetBytes, and the least-squares slope <= slopeBudgetPerMinBytes,
 * both over [60 s, 360 s] (medianInWindowEnd/slopePerMinute's own hardcoded window, the same one
 * Q10 names for g7-k). `unavailable` (never a silent pass) when there are too few samples. */
export function checkGrowthBounded(
  id: string,
  label: string,
  points: readonly TimePoint[],
  growthBudgetBytes: number,
  slopeBudgetPerMinBytes: number,
): Gate7Check {
  const criterion = `${label}: median(last 30 s) - median(first 30 s) <= ${growthBudgetBytes} B and slope <= ${slopeBudgetPerMinBytes} B/min, over [60 s, 360 s]`;
  if (points.length < 2)
    return mk(
      id,
      criterion,
      [
        `unavailable: ${points.length} sample(s) for ${label} (mem-timeline.jsonl missing, empty, or this field was never reported)`,
      ],
      "",
    );
  const startMedian = medianInWindowEnd(points, 30, "start");
  const endMedian = medianInWindowEnd(points, 30, "finish");
  const slope = slopePerMinute(points);
  if (startMedian === null || endMedian === null || slope === null)
    return mk(
      id,
      criterion,
      [
        `unavailable: ${label} has no samples inside the measured window [60 s, 360 s]`,
      ],
      "",
    );
  const growth = endMedian - startMedian;
  const problems: string[] = [];
  if (growth > growthBudgetBytes)
    problems.push(
      `${label} growth ${growth.toFixed(0)} B > budget ${growthBudgetBytes} B (median[330,360] - median[60,90])`,
    );
  if (slope > slopeBudgetPerMinBytes)
    problems.push(
      `${label} slope ${slope.toFixed(0)} B/min > budget ${slopeBudgetPerMinBytes} B/min`,
    );
  return mk(
    id,
    criterion,
    problems,
    `${label}: growth ${growth.toFixed(0)} B, slope ${slope.toFixed(0)} B/min, within budget`,
  );
}

/** Q10's `wasm-heap-bounded`/`gpu-mem-bounded`: end <= value at 60 s + budgetBytes (no slope
 * term; `window.__rsWasmHeap()`/wasm's own HEAP8 and the driver's VRAM accounting never shrink,
 * so only growth past the warmup matters). */
export function checkEndVsSixtySecondValue(
  id: string,
  label: string,
  points: readonly TimePoint[],
  budgetBytes: number,
): Gate7Check {
  const criterion = `${label}: end <= value at 60 s + ${budgetBytes} B`;
  if (points.length < 2)
    return mk(
      id,
      criterion,
      [`unavailable: ${points.length} sample(s) for ${label}`],
      "",
    );
  const at60 = points.filter((p) => p.t <= 60).at(-1) ?? points[0];
  const end = points.at(-1) as TimePoint;
  const growth = end.v - at60.v;
  const problems =
    growth > budgetBytes
      ? [
          `${label}: value at 60 s ${at60.v}, end ${end.v} (growth ${growth} B > budget ${budgetBytes} B)`,
        ]
      : [];
  return mk(
    id,
    criterion,
    problems,
    `${label}: value at 60 s ${at60.v}, end ${end.v} (growth ${growth} B, within budget ${budgetBytes} B)`,
  );
}

/** The GSW-only GL-texture half of `residency-bounded`: `live_rids.textures` (real, bounded by
 * normal supersede-and-free, gl.rs) plus `leaked_gl_textures` (0 unless the `leak-gl-textures`
 * sabotage is running, gl-leak.ts's throwaway context). Growth-checked the same way
 * residencyMetrics checks every metric with no budget-derived bound: max(last third) <=
 * max(first third) + the slack G6s measured transient ticks need. */
function checkGlTexturesBounded(ev: G6sLegEvidence): Gate7Check {
  const points = receiverSeries(ev, (l) => {
    const raw = l as unknown as {
      live_rids?: { textures?: number } | null;
      leaked_gl_textures?: number;
    };
    return (raw.live_rids?.textures ?? 0) + (raw.leaked_gl_textures ?? 0);
  });
  const firstThirdMax = maxInWindowThird(points, "first");
  const lastThirdMax = maxInWindowThird(points, "last");
  const grew =
    firstThirdMax === null || lastThirdMax === null
      ? false
      : lastThirdMax > firstThirdMax + G6S_RESIDENCY_GROWTH_SLACK;
  return mk(
    "g7k-residency-bounded-gl-textures",
    "GL textures (resident + leaked): max(last third) <= max(first third) + slack",
    grew
      ? [
          `GL textures grew: first-third max ${firstThirdMax}, last-third max ${lastThirdMax}`,
        ]
      : [],
    `GL textures (resident + leaked): first-third max ${firstThirdMax}, last-third max ${lastThirdMax}`,
  );
}

/** A key per soak check, so a sabotage leg can be judged by its exact failure set. */
interface KeyedCheck {
  key: string;
  check: Gate7Check;
}

/** The expected failure set of each sabotage leg (Q10 "Sabotages", measured consequences
 * included). `required` must all fail and nothing outside `required` + `allowed` may. `allowed`
 * names checks that fail or pass on the sabotage's own physical consequence without being the
 * sabotage's signature (a store that never evicts also grows the wasm heap; a throwaway context
 * that leaks 150 MiB of textures can also grow the GPU process's RSS). */
export const G7K_SABOTAGE_SETS: Record<
  string,
  { required: Record<G7kKind, string[]>; allowed: Record<G7kKind, string[]> }
> = {
  "sabotage-soak-no-evict": {
    required: {
      web: ["residency-bounded:receiver memory-cache entries"],
      gsw: [
        "residency-bounded:receiver memory-cache entries",
        "wasm-heap-bounded",
      ],
    },
    allowed: { web: [], gsw: ["js-heap-bounded"] },
  },
  "sabotage-leak-gl-textures": {
    required: {
      web: [],
      gsw: ["residency-bounded:gl-textures"],
    },
    allowed: { web: [], gsw: ["rss-bounded-gpu"] },
  },
};

/** GSW's budget counts the store's payload bytes plus the resident textures' GL bytes; the part
 * of that no eviction can reach (the referenced entries, `memory_floor_bytes`) may exceed the
 * budget by itself (G6s's native rule: never evict the needed set). The judged series is the
 * bytes beyond that unavoidable overshoot, so an honest leg sits at or under the budget and a
 * store that never evicts does not. */
export function gswBudgetAdjusted(ev: G6sLegEvidence, budgetBytes: number): G6sLegEvidence {
  const perf = ev.receiverPerf;
  if (!perf) return ev;
  const timeline = perf.timeline.map((l) => {
    const raw = l as unknown as { memory_floor_bytes?: number | null };
    if (l.cache_bytes_memory === null || raw.memory_floor_bytes == null) return l;
    const overshoot = Math.max(0, raw.memory_floor_bytes - budgetBytes);
    return { ...l, cache_bytes_memory: Math.max(0, l.cache_bytes_memory - overshoot) };
  });
  return { ...ev, receiverPerf: { ...perf, timeline } };
}

/** Q7 for GSW (P-G1..P-G4): the final soak shot against the soak-timeline reference's step-11
 * shot under gate 6's `animate` masks, decided pixels exact and `delta1` within channel 1. */
export async function gswSoakPixels(
  ev: G6sLegEvidence,
  g6sDir: string,
  leg: string,
): Promise<Gate7Check> {
  const id = "g7k-soak-pixels";
  const criterion = `${leg}: the final shot equals the soak-timeline reference's step-11 shot under Q7 (decided exact, delta1 <= 1, gate6-animate masks)`;
  const shots = ev.applied?.shots ?? [];
  let last: (typeof shots)[number] | undefined;
  for (const s of shots)
    if (s.frame !== undefined && (last === undefined || (last.frame ?? -1) < s.frame))
      last = s;
  const refPng = await decodePngRgba(join(g6sDir, "reference-step11", "shots", "step-11.png"));
  const gotPng =
    last?.seq === undefined
      ? null
      : await decodePngRgba(
          join(g6sDir, leg, "receiver", "shots", `${last.stream && last.stream !== 1 ? `stream-${last.stream}-` : ""}seq-${last.seq}.png`),
        );
  if (!refPng || !gotPng)
    return mk(id, criterion, [`cannot read the reference or the final shot (seq ${last?.seq})`], "");
  const cls = classMask("gate6-animate", 11, refPng.width, refPng.height);
  if (!cls || refPng.width !== gotPng.width || refPng.height !== gotPng.height)
    return mk(id, criterion, ["no gate6-animate step-11 mask for this frame size"], "");
  const v = judgeQ7Classes(refPng, gotPng, cls);
  return mk(
    id,
    criterion,
    v.ok
      ? []
      : [`decided ${v.decided_px} px (max ${v.decided_max}), delta1 max ${v.delta1_max}`],
    `decided ${v.decided_px} px, delta1 ${v.delta1_px} px (max ${v.delta1_max}), undecided ${v.undecided_px} px, excluded ${v.excluded_px ?? 0} px`,
  );
}

/** Web export soak pixels: the final shot against the soak-timeline reference's step-11 shot in
 * Q7's band, the rule `bandSubstitutions` applies to every live web leg: every pixel identical,
 * `readback` or `delta1`, none `other`. Gate 6's native budget-0 count is reported, not gating
 * (the web shot splits 9691 readback + 159 delta1 px, G7b's oracle 9686/159/0). */
export async function webSoakPixels(
  ev: G6sLegEvidence,
  g6sDir: string,
  leg: string,
  rawBudget0Detail: string,
): Promise<Gate7Check> {
  const id = "g7k-soak-pixels";
  const criterion = `${leg}: the final shot is within Q7's band of the soak-timeline reference's step-11 shot (identical, readback or delta1; other = 0)`;
  const shots = ev.applied?.shots ?? [];
  let last: (typeof shots)[number] | undefined;
  for (const s of shots)
    if (s.frame !== undefined && (last === undefined || (last.frame ?? -1) < s.frame))
      last = s;
  const refPng = await decodePngRgba(join(g6sDir, "reference-step11", "shots", "step-11.png"));
  const gotPng =
    last?.seq === undefined
      ? null
      : await decodePngRgba(
          join(g6sDir, leg, "receiver", "shots", `${last.stream && last.stream !== 1 ? `stream-${last.stream}-` : ""}seq-${last.seq}.png`),
        );
  if (!refPng || !gotPng)
    return mk(id, criterion, [`cannot read the reference or the final shot (seq ${last?.seq})`], "");
  if (refPng.width !== gotPng.width || refPng.height !== gotPng.height)
    return mk(id, criterion, ["reference and final shot differ in size"], "");
  const c = classifyShot(refPng.data, gotPng.data);
  return mk(
    id,
    criterion,
    c.other === 0 ? [] : [`${c.other} px outside the band (max delta ${c.other_max_delta})`],
    `identical ${c.identical}, readback ${c.readback}, delta1 ${c.delta1}, other ${c.other}; gate 6 budget-0 (not gating): ${rawBudget0Detail}`,
  );
}

/** A sabotage leg's verdict: every `required` key failed and nothing outside required + allowed. */
export function failureSetProblems(
  failed: readonly string[],
  required: readonly string[],
  allowed: readonly string[],
): string[] {
  const missing = required.filter((r) => !failed.includes(r));
  const extra = failed.filter((f) => !required.includes(f) && !allowed.includes(f));
  const problems: string[] = [];
  if (missing.length > 0) problems.push(`expected to fail but did not: ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`unexpectedly also failed: ${extra.join(", ")}`);
  return problems;
}

async function checkSoakLeg(
  kind: G7kKind,
  g6sDir: string,
  leg: G6sLeg,
  expected: Gate6Expected,
): Promise<Gate7Check[]> {
  const raw = await loadG6sLeg(g6sDir, leg.leg);
  const ev = kind === "gsw" ? gswBudgetAdjusted(raw, G6S_MEMORY_BUDGET_BYTES) : raw;
  const mem = await loadMemTimeline(join(g6sDir, leg.leg, "receiver"));
  const sabotage = G7K_SABOTAGE_SETS[leg.leg];
  const prefix = `g7k-${leg.leg}`;
  const keyed: KeyedCheck[] = [];
  const push = (key: string, check: Gate7Check) => keyed.push({ key, check });

  // residency-bounded: honest legs through G6s's own check; a sabotage leg reports one raw key
  // per flagged metric (the native `failsMetric` expectation is judged below, as a set).
  const metrics = residencyMetrics(ev, leg.inline);
  const unbounded = metrics.filter((m) => !m.bounded).map((m) => m.name);
  if (sabotage) {
    const none = unbounded.length === 0;
    push(
      "residency-bounded",
      mk(
        `${prefix}-residency-bounded`,
        "every residency count's last-third max <= its first-third max, and every budgeted count within its budget-derived bound",
        none ? [] : [`flagged: ${unbounded.join(", ")}`],
        "nothing flagged",
        false,
      ),
    );
    for (const name of unbounded)
      push(`residency-bounded:${name}`, mk(`${prefix}-residency-bounded:${name}`, `${name} bounded`, [`${name} grew or exceeded its bound`], "", false));
  } else {
    push("residency-bounded", toG7(checkResidencyBounded(leg, ev)));
  }
  if (!sabotage || leg.leg === "sabotage-soak-no-evict")
    push("cache-budget-respected", toG7(checkCacheBudgetRespected(leg, ev)));
  if (leg.leg !== "sabotage-leak-gl-textures") {
    push(
      "soak-pixels",
      kind === "gsw"
        ? await gswSoakPixels(ev, g6sDir, leg.leg)
        : await (async () => {
            const raw = await checkSoakPixels(leg, ev, g6sDir, expected);
            return webSoakPixels(ev, g6sDir, leg.leg, raw.detail);
          })(),
    );
  }
  if (kind === "gsw") {
    const gl = checkGlTexturesBounded(ev);
    // A sabotage's key is `residency-bounded:gl-textures` only when GL textures actually grew.
    if (sabotage) {
      if (!gl.passed) push("residency-bounded:gl-textures", { ...gl, gating: false });
      else push("residency-bounded:gl-textures-flat", { ...gl, gating: false });
    } else push("residency-bounded-gl-textures", gl);
  }
  push(
    "rss-bounded-renderer",
    checkGrowthBounded(`${prefix}-rss-bounded-renderer`, "renderer RSS", memSeries(mem, (s) => s.rss_bytes.renderer), 16 * MIB, 2 * MIB),
  );
  push(
    "rss-bounded-gpu",
    checkGrowthBounded(`${prefix}-rss-bounded-gpu`, "GPU-process RSS", memSeries(mem, (s) => s.rss_bytes.GPU ?? s.rss_bytes["gpu-process"]), 16 * MIB, 2 * MIB),
  );
  if (kind === "gsw")
    push(
      "js-heap-bounded",
      checkGrowthBounded(`${prefix}-js-heap-bounded`, "JS heap", memSeries(mem, (s) => s.js_heap_bytes), 4 * MIB, 0.5 * MIB),
    );
  push(
    "wasm-heap-bounded",
    checkEndVsSixtySecondValue(`${prefix}-wasm-heap-bounded`, "wasm heap", memSeries(mem, (s) => s.wasm_heap_bytes), 16 * MIB),
  );
  // Deviation (G7k finisher 2, orchestrator-delegated): the leak sabotage's textures, even drawn
  // into and read back, never move nvidia-smi's per-process figure (flat at 25165824 B across a
  // 100+ MiB leak; the attribution is the right GPU process), so that allocation path is not
  // attributable and `gpu-mem-bounded` is typed `unavailable` there, never a silent pass.
  if (leg.leg === "sabotage-leak-gl-textures")
    push(
      "gpu-mem-bounded",
      mk(
        `${prefix}-gpu-mem-bounded`,
        "GPU memory (nvidia-smi) end <= value at 60 s + 8 MiB",
        [],
        "unavailable: per-process GPU memory is not attributable for this allocation path (leaked textures on a throwaway WebGL2 context do not move nvidia-smi's figure even when drawn to)",
        false,
      ),
    );
  else
    push(
      "gpu-mem-bounded",
      checkEndVsSixtySecondValue(`${prefix}-gpu-mem-bounded`, "GPU memory (nvidia-smi)", memSeries(mem, (s) => s.gpu_mem_bytes), 8 * MIB),
    );

  if (!sabotage) return keyed.map((k) => k.check);

  // A sabotage leg: every child check is reported (non-gating); one gating check compares the
  // exact set of failed keys with the expected one. `unavailable` never counts as a failure.
  const failed = keyed
    .filter((k) => !k.check.passed && !k.check.detail.startsWith("unavailable"))
    .filter((k) => k.key !== "residency-bounded")
    .map((k) => k.key)
    .sort();
  const required = [...G7K_SABOTAGE_SETS[leg.leg].required[kind]].sort();
  const allowed = G7K_SABOTAGE_SETS[leg.leg].allowed[kind];
  const problems = failureSetProblems(failed, required, allowed);
  const children = keyed.map((k) => ({ ...k.check, gating: false }));
  return [
    ...children,
    mk(
      `${prefix}-failure-set`,
      `${leg.leg}: fails exactly {${required.join(", ")}}${allowed.length ? ` (may also fail: ${allowed.join(", ")})` : ""}`,
      problems,
      `failed exactly {${failed.join(", ")}}`,
    ),
  ];
}

// -------------------------------------------------------------------------------------------
// Startup (D15 marks)
// -------------------------------------------------------------------------------------------

/** D15's marks, in the order they must occur. `rs-first-raf-after-submit` is GSW only (Q10's
 * deviation list): the web export's main loop has no JS-bridge hook onto its own rAF-equivalent
 * tick, so that mark is `unavailable` there, never a silent pass. */
export const STARTUP_MARKS: Record<G7kKind, readonly string[]> = {
  gsw: [
    "rs-gsw-wasm-ready",
    "rs-socket-open",
    "rs-session-decoded",
    "rs-first-applied",
    "rs-first-submitted",
    "rs-first-raf-after-submit",
  ],
  web: [
    "rs-engine-init-end",
    "rs-socket-open",
    "rs-session-decoded",
    "rs-first-applied",
    "rs-first-submitted",
  ],
};

export interface TimingsJson {
  schema: string;
  wall_ms: number;
  exit: number | null;
  error: string | null;
  marks: { name: string; t: number }[];
  resources: {
    name: string;
    start: number;
    end: number;
    transfer: number;
    decoded: number;
  }[];
}

async function loadTimings(dir: string): Promise<TimingsJson | null> {
  const path = join(dir, "receiver", "timings.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as TimingsJson;
  } catch {
    return null;
  }
}

/** `startup-complete`: every D15 mark this kind names is present, in non-decreasing time order. */
export function checkStartupComplete(
  id: string,
  kind: G7kKind,
  legName: string,
  timings: TimingsJson | null,
): Gate7Check {
  const criterion = `${legName}: every D15 mark present, in non-decreasing time order`;
  if (timings === null)
    return mk(id, criterion, [`${legName}: no timings.json`], "");
  const byName = new Map(timings.marks.map((m) => [m.name, m.t]));
  const problems: string[] = [];
  let last = -Infinity;
  for (const name of STARTUP_MARKS[kind]) {
    const t = byName.get(name);
    if (t === undefined) {
      problems.push(`missing mark ${name}`);
      continue;
    }
    if (t < last)
      problems.push(
        `${name} at ${t} ms is before the previous mark (${last} ms)`,
      );
    last = t;
  }
  return mk(
    id,
    criterion,
    problems,
    `${legName}: every mark present and ordered (${STARTUP_MARKS[kind].map((n) => `${n}=${byName.get(n)}`).join(", ")})`,
  );
}

/** `startup-warm-fetches` (warm legs only): zero GETs for payload hashes (the `/resources/`
 * path), and the bundle/wasm/.pck resources also report 0 bytes transferred (the HTTP cache, not
 * a fresh fetch). `transferSize` 0 is the Resource Timing API's own signal for "served from the
 * HTTP cache, no bytes crossed the network" (W3C Resource Timing); a torn/aborted request can
 * also read 0, which this check cannot distinguish from a cache hit -- the same limitation every
 * caller of `resources[].transfer` already has. */
export function checkStartupWarmFetches(
  id: string,
  legName: string,
  timings: TimingsJson | null,
): Gate7Check {
  const criterion = `${legName}: zero GETs for payload hashes; the bundle, wasm and .pck served from the HTTP cache`;
  if (timings === null)
    return mk(id, criterion, [`${legName}: no timings.json`], "");
  const payloadGets = timings.resources.filter((r) =>
    r.name.includes("/resources/"),
  );
  const refetchedPayloads = payloadGets.filter((r) => r.transfer > 0);
  // The page's own evidence PUTs (shots, applied.json) are resource entries too, but they are
  // uploads, not bundle loads.
  const staticAssets = timings.resources.filter(
    (r) => !r.name.includes("/resources/") && !r.name.includes("/evidence/"),
  );
  const refetchedStatic = staticAssets.filter((r) => r.transfer > 0);
  const problems: string[] = [];
  if (refetchedPayloads.length > 0)
    problems.push(
      `${refetchedPayloads.length}/${payloadGets.length} payload GET(s) were not served from the HTTP cache: ${refetchedPayloads.map((r) => r.name).join(", ")}`,
    );
  if (refetchedStatic.length > 0)
    problems.push(
      `${refetchedStatic.length}/${staticAssets.length} bundle/wasm/.pck resource(s) were not served from the HTTP cache: ${refetchedStatic.map((r) => r.name).join(", ")}`,
    );
  return mk(
    id,
    criterion,
    problems,
    `${legName}: every resource served from the HTTP cache`,
  );
}

function statName(name: string, repeat: number): string {
  return `startup-${name}-r${repeat}`;
}

async function checkStartup(
  kind: G7kKind,
  startupDir: string,
): Promise<{
  checks: Gate7Check[];
  marks: Record<"cold" | "warm", Record<string, number[]>>;
  intervals: Record<"cold" | "warm", Record<string, number[]>>;
}> {
  const checks: Gate7Check[] = [];
  const marks: Record<"cold" | "warm", Record<string, number[]>> = {
    cold: {},
    warm: {},
  };
  const intervals: Record<"cold" | "warm", Record<string, number[]>> = {
    cold: {},
    warm: {},
  };
  const PAIRS: [string, string][] = [
    ["rs-session-decoded", "rs-first-applied"],
    ["rs-first-applied", "rs-first-submitted"],
    ["rs-session-decoded", "rs-first-submitted"],
  ];
  for (const temp of ["cold", "warm"] as const) {
    for (let r = 0; r <= 5; r++) {
      const legName = statName(temp, r);
      const legDir = join(startupDir, "live", legName);
      const timings = existsSync(legDir) ? await loadTimings(legDir) : null;
      checks.push(
        checkStartupComplete(
          `g7k-startup-complete-${legName}`,
          kind,
          legName,
          timings,
        ),
      );
      // r0 of the warm set is the cold load its repeats copy the profile from: not a warm load.
      if (temp === "warm" && r > 0)
        checks.push(
          checkStartupWarmFetches(
            `g7k-startup-warm-fetches-${legName}`,
            legName,
            timings,
          ),
        );
      if (r === 0 || timings === null) continue; // r0 is the discarded warmup.
      for (const m of timings.marks) {
        if (marks[temp][m.name] === undefined) marks[temp][m.name] = [];
        marks[temp][m.name].push(m.t);
      }
      const at = new Map(timings.marks.map((m) => [m.name, m.t]));
      for (const [from, to] of PAIRS) {
        const a = at.get(from);
        const b = at.get(to);
        if (a === undefined || b === undefined) continue;
        const key = `${from} -> ${to}`;
        if (intervals[temp][key] === undefined) intervals[temp][key] = [];
        intervals[temp][key].push(b - a);
      }
    }
  }
  return { checks, marks, intervals };
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

export async function checkG7kKind(
  out: string,
  kind: G7kKind,
  expected: Gate6Expected,
): Promise<G7kKindResult> {
  const g6sDir = join(out, "gate6", `g6s-${kind}`, G6S_DIR);
  const startupDir = join(out, "gate6", `startup-${kind}`);
  const checks: Gate7Check[] = [];
  for (const leg of soakLegsOf(kind))
    checks.push(...(await checkSoakLeg(kind, g6sDir, leg, expected)));
  const { checks: startupChecks, marks, intervals } = await checkStartup(kind, startupDir);
  checks.push(...startupChecks);
  return {
    group: "g7-k",
    kind,
    live: true,
    passed: checks.every((c) => c.passed || !c.gating),
    run_dir: out,
    checks,
    startup_marks: marks,
    startup_intervals: intervals,
  };
}
