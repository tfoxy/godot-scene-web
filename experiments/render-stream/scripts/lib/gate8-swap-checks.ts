// Gate 8 g8sw checks (LS3, live-swap-design.md Q3 "Proving nothing left behind"): the capture's
// teardown across disarms. run-gate8.sh run_g8sw writes, under g8sw/:
//
//   short/swap, short/control, short/sabotage-{keep-served,keep-listener,keep-hub,skip-mirror-reset}
//       fixtures/capture-scale with an in-process viewer, GRC_SWAP_CYCLE=240:240:3 (the control is
//       the same phases under GRC_MODE=standby and never arms; a sabotage is short/swap with
//       GRC_REARM_FAULT). Remote-capable correctness legs.
//   cycle/control, cycle/swap
//       the swap-cycle timing group (local only): 1800:1800:10, real time at 60 fps.
//
// Each leg's evidence: evidence/swap-cycle.jsonl (one row at the end of every phase), the per-arm
// teardown.json (evidence/teardown.json for arm 1, evidence/arm-<k>/teardown.json for k >= 2) and
// frames.csv (RS_SCALE_FRAME_LOG: process_frame,cpu_ns,<movers,redraws,mesh_updates,params,churn us>).
//
// Checks: swap-accounting, swap-cycle-threads, swap-cycle-fds, swap-cycle-rss, swap-cycle-standby-cpu
// and the four sabotage-*-caught checks, which judge a sabotage leg with the same functions.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  check,
  exitCode,
  type G8aCheck,
  jsonl,
  readJson,
  readText,
  skipped,
} from "./gate8-adopt-checks";

// ------------------------------------------------------------------------------- the bounds

/** Allocator in-use heap swap minus control at every idle sample, MiB. */
export const HEAP_IN_USE_BOUND_MIB = { short: 1, cycle: 1 };
/** Least-squares growth of the RssAnon difference after the first cycle, MiB per cycle. */
export const RSS_SLOPE_MB = { short: 0.5, cycle: 0.5 };
/** swap-cycle-standby-cpu: the F1 bound idle-parity uses, a fraction of the control idle phase's
 * median per-frame CPU. */
export const CPU_BOUND_FRACTION = 0.01;

/** How the bounds were chosen, copied into the report. */
export const RSS_NOTES =
  "Allocator in-use heap swap minus control is bounded at 1 MiB per idle sample; RssAnon growth after cycle 1 is bounded at 0.5 MiB/cycle. The absolute RssAnon offset is reported without a bound because one-time allocator residency is accepted debt; RssFile, RssShmem, allocator free heap and mmap bytes are also reported without bounds";

// ------------------------------------------------------------------------------- the evidence

export interface SwapAccounting {
  mirror?: {
    items?: number;
    canvases?: number;
    textures?: number;
    meshes?: number;
    texture_payload_bytes?: number;
    mesh_payload_bytes?: number;
    held_bytes?: number;
  };
  served_sets?: number;
  served_bytes?: number;
  warm_cache_bytes?: number;
  texture_workers_running?: boolean;
  encode_workers_running?: boolean;
  hubs?: number;
  carrier_sets?: number;
  track_hub?: boolean;
  writer_joined?: boolean;
  publisher?: boolean;
  resource_log_held?: number;
  mesh_buffers?: number;
  adopt_held?: number;
  reload_sources_held?: number;
  item_meta?: { host_held?: number; filter_watches?: number };
  malloc?: { uordblks?: number; fordblks?: number; hblkhd?: number };
  rss_bytes?: number;
  rss_anon_bytes?: number;
  rss_file_bytes?: number;
  rss_shmem_bytes?: number;
  capture_threads?: Record<string, number>;
  capture_thread_count?: number;
  threads_total?: number;
  fds_total?: number;
  sockets?: number;
  inet_sockets?: number;
}

/** One line of evidence/swap-cycle.jsonl. */
export interface SwapRow extends SwapAccounting {
  cycle: number;
  phase: "idle" | "armed";
  control: boolean;
  arm_index: number;
  start_frame: number;
  end_frame: number;
  process_frame: number;
  frames: number;
  main_cpu_ns_per_frame?: number;
  callback_ns_per_frame?: number;
}

export interface SwapLeg {
  dir: string;
  /** Evidence problems: the leg is missing, incomplete or malformed (never a rule violation). */
  evidence: string[];
  exit_code: string | null;
  skipped: string | null;
  rows: SwapRow[];
  /** Teardown records by arm index (1-based); undefined when the file is missing. */
  teardowns: (SwapAccounting | undefined)[];
  /** frames.csv, parsed (undefined when absent). */
  frames?: FrameLine[];
}

export interface FrameLine {
  process_frame: number;
  cpu_ns: number;
  sections: number[];
}

/** SECTIONS order of fixtures/capture-scale/scale.gd. */
export const SECTIONS = [
  "movers",
  "redraws",
  "mesh_updates",
  "params",
  "churn",
] as const;
/** The blocks LS1's idle-parity calls `tracked`: hooked by the capture's standby table. */
const TRACKED = [SECTIONS.indexOf("params"), SECTIONS.indexOf("churn")];

/** The phases a leg of the given kind and cycle count must report. */
export function expectedRows(kind: "swap" | "control", n: number): number {
  return kind === "swap" ? 2 * n : 2 * n + 1;
}

export async function loadLeg(
  dir: string,
  kind: "swap" | "control",
  n: number,
): Promise<SwapLeg> {
  const leg: SwapLeg = {
    dir,
    evidence: [],
    exit_code: await exitCode(dir),
    skipped: skipped(dir),
    rows: [],
    teardowns: [],
  };
  if (leg.skipped !== null) {
    leg.evidence.push(`${leg.skipped}`);
    return leg;
  }
  if (leg.exit_code === null) {
    leg.evidence.push("no exit-code.txt (the leg did not run)");
    return leg;
  }
  const ev = join(dir, "evidence");
  const text = await readText(join(ev, "swap-cycle.jsonl"));
  if (text === undefined) {
    leg.evidence.push("no evidence/swap-cycle.jsonl");
  } else {
    try {
      leg.rows = jsonl<SwapRow>(text);
    } catch (e) {
      leg.evidence.push(`swap-cycle.jsonl: ${(e as Error).message}`);
    }
    const want = expectedRows(kind, n);
    if (leg.rows.length !== want)
      leg.evidence.push(`${leg.rows.length} swap-cycle rows, want ${want}`);
    const idle = leg.rows.filter((r) => r.phase === "idle").length;
    const armed = leg.rows.filter((r) => r.phase === "armed").length;
    const wantArmed = kind === "swap" ? n : n;
    const wantIdle = kind === "swap" ? n : n + 1;
    if (idle !== wantIdle || armed !== wantArmed)
      leg.evidence.push(
        `${idle} idle and ${armed} armed rows, want ${wantIdle} and ${wantArmed}`,
      );
  }
  if (kind === "swap") {
    for (let k = 1; k <= n; k++) {
      const path =
        k === 1
          ? join(ev, "teardown.json")
          : join(ev, `arm-${k}`, "teardown.json");
      leg.teardowns[k - 1] = await readJson<SwapAccounting>(path);
      if (leg.teardowns[k - 1] === undefined)
        leg.evidence.push(`arm ${k}: no teardown.json`);
    }
  }
  const csv = await readText(join(dir, "frames.csv"));
  if (csv !== undefined) leg.frames = parseFrames(csv);
  return leg;
}

export function parseFrames(csv: string): FrameLine[] {
  const out: FrameLine[] = [];
  for (const line of csv.split("\n")) {
    if (line.trim() === "") continue;
    const f = line.split(",").map(Number);
    if (f.length < 2 + SECTIONS.length || f.some((x) => !Number.isFinite(x)))
      continue;
    out.push({ process_frame: f[0], cpu_ns: f[1], sections: f.slice(2) });
  }
  return out;
}

// ------------------------------------------------------------------------------- statistics

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The least-squares slope of ys against xs. */
export function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? Number.NaN : num / den;
}

const MB = 1024 * 1024;

// ------------------------------------------------------------------------------- the rules

/** swap-accounting's rule for one accounting record (a teardown.json or an idle row). */
export function accountingProblems(label: string, a: SwapAccounting): string[] {
  const out: string[] = [];
  const zero = (name: string, v: unknown) => {
    if (v !== 0)
      out.push(`${label}: ${name} ${v === undefined ? "missing" : v}`);
  };
  const is = (name: string, v: unknown, want: boolean) => {
    if (v !== want)
      out.push(`${label}: ${name} ${v === undefined ? "missing" : v}`);
  };
  const m = a.mirror;
  zero("mirror.items", m?.items);
  zero("mirror.textures", m?.textures);
  zero("mirror.meshes", m?.meshes);
  zero("mirror.texture_payload_bytes", m?.texture_payload_bytes);
  zero("mirror.mesh_payload_bytes", m?.mesh_payload_bytes);
  zero("mirror.held_bytes", m?.held_bytes);
  if (typeof m?.canvases !== "number" || m.canvases > 1)
    out.push(
      `${label}: mirror.canvases ${m?.canvases ?? "missing"}, want <= 1`,
    );
  zero("served_sets", a.served_sets);
  zero("served_bytes", a.served_bytes);
  zero("warm_cache_bytes", a.warm_cache_bytes);
  is("texture_workers_running", a.texture_workers_running, false);
  is("encode_workers_running", a.encode_workers_running, false);
  zero("hubs", a.hubs);
  zero("carrier_sets", a.carrier_sets);
  is("track_hub", a.track_hub, false);
  is("writer_joined", a.writer_joined, true);
  is("publisher", a.publisher, false);
  zero("resource_log_held", a.resource_log_held);
  zero("mesh_buffers", a.mesh_buffers);
  zero("adopt_held", a.adopt_held);
  zero("reload_sources_held", a.reload_sources_held);
  zero("item_meta.host_held", a.item_meta?.host_held);
  zero("item_meta.filter_watches", a.item_meta?.filter_watches);
  return out;
}

export interface Judged {
  /** Rule violations: what a sabotage must produce. */
  rule: string[];
  /** The evidence was missing or incomplete: never a catch. */
  evidence: string[];
  detail: string;
}

const idleRows = (leg: SwapLeg) => leg.rows.filter((r) => r.phase === "idle");
const armedRows = (leg: SwapLeg) => leg.rows.filter((r) => r.phase === "armed");
const tag = (leg: SwapLeg, r: SwapRow) =>
  `${leg.dir.split("/").slice(-2).join("/")} ${r.phase} cycle ${r.cycle}`;

/** swap-accounting on a swap leg: every arm's teardown record and every idle row obeys the
 * accounting rule; the armed rows are not vacuous (the viewer pinned bodies in the born first arm). */
export function judgeAccounting(leg: SwapLeg, n: number): Judged {
  const rule: string[] = [];
  const evidence = [...leg.evidence];
  const name = leg.dir.split("/").slice(-2).join("/");
  for (let k = 1; k <= n; k++) {
    const t = leg.teardowns[k - 1];
    if (t) rule.push(...accountingProblems(`${name} arm ${k} teardown`, t));
  }
  for (const r of idleRows(leg))
    rule.push(...accountingProblems(tag(leg, r), r));
  const armed = armedRows(leg);
  for (const r of armed)
    if (r.hubs !== 1)
      evidence.push(
        `${tag(leg, r)}: hubs ${r.hubs}, want 1 (the capture was not serving)`,
      );
  for (const r of armed)
    if (!((r.served_bytes ?? 0) > 0))
      evidence.push(
        `${tag(leg, r)}: served_bytes ${r.served_bytes}, the viewer pinned nothing`,
      );
  const first = armed.find((r) => r.arm_index === 1);
  if (!first) evidence.push("no armed row of arm 1");
  else if (!((first.mirror?.textures ?? 0) > 0))
    evidence.push(
      `arm 1 armed row: mirror.textures ${first.mirror?.textures}, the born arm held no scene`,
    );
  const f = armed.find((r) => r.arm_index === 1);
  return {
    rule,
    evidence,
    detail: `${n} teardowns and ${idleRows(leg).length} idle rows clean; armed arm 1 held ${f?.mirror?.textures} textures, ${f?.mirror?.held_bytes} mirror bytes; served bytes ${armed.map((r) => r.served_bytes).join("/")}; hubs ${armed.map((r) => r.hubs).join("/")}`,
  };
}

/** swap-cycle-threads on a leg: no capture thread in any idle row (or control row); the armed rows
 * show at least rs-ws-io and grc-former. */
export function judgeThreads(leg: SwapLeg, kind: "swap" | "control"): Judged {
  const rule: string[] = [];
  const evidence = [...leg.evidence];
  const rows = kind === "control" ? leg.rows : idleRows(leg);
  for (const r of rows)
    if (r.capture_thread_count !== 0)
      rule.push(
        `${tag(leg, r)}: capture_thread_count ${r.capture_thread_count} (${JSON.stringify(r.capture_threads ?? {})})`,
      );
  if (kind === "swap")
    for (const r of armedRows(leg))
      for (const t of ["rs-ws-io", "grc-former"])
        if (!((r.capture_threads?.[t] ?? 0) >= 1))
          evidence.push(`${tag(leg, r)}: no ${t} thread while armed`);
  return {
    rule,
    evidence,
    detail: `${rows.length} rows with no capture thread; process threads ${leg.rows.map((r) => r.threads_total).join("/")} (unjudged)`,
  };
}

/** swap-cycle-fds on a leg: no inet socket in any idle row (or control row); the armed rows hold
 * at least one. */
export function judgeFds(leg: SwapLeg, kind: "swap" | "control"): Judged {
  const rule: string[] = [];
  const evidence = [...leg.evidence];
  const rows = kind === "control" ? leg.rows : idleRows(leg);
  for (const r of rows)
    if (r.inet_sockets !== 0)
      rule.push(`${tag(leg, r)}: inet_sockets ${r.inet_sockets}`);
  if (kind === "swap")
    for (const r of armedRows(leg))
      if (!((r.inet_sockets ?? 0) >= 1))
        evidence.push(
          `${tag(leg, r)}: inet_sockets ${r.inet_sockets} while armed`,
        );
  return {
    rule,
    evidence,
    detail: `${rows.length} rows with no inet socket; fds ${leg.rows.map((r) => r.fds_total).join("/")}, sockets ${leg.rows.map((r) => r.sockets).join("/")} (unjudged)`,
  };
}

interface RssComponent {
  swap_mb: number;
  control_mb: number;
  diff_mb: number;
}

export interface RssPair {
  cycle: number;
  rss_anon: RssComponent;
  rss_file: RssComponent;
  rss_shmem: RssComponent;
  malloc_uordblks: RssComponent;
  malloc_fordblks: RssComponent;
  malloc_hblkhd: RssComponent;
}

/** Pair idle samples by cycle: bound in-use heap and anon growth after the first cycle. */
export function judgeRss(
  swap: SwapLeg,
  control: SwapLeg,
  n: number,
  bound: number,
  slopeBound: number,
): Judged & { pairs: RssPair[]; slope: number | null } {
  const rule: string[] = [];
  const evidence = [
    ...swap.evidence.map((e) => `swap: ${e}`),
    ...control.evidence.map((e) => `control: ${e}`),
  ];
  const pairs: RssPair[] = [];
  for (let k = 1; k <= n; k++) {
    const s = idleRows(swap).find((r) => r.cycle === k);
    const c = idleRows(control).find((r) => r.cycle === k);
    const component = (
      key:
        | "rss_anon_bytes"
        | "rss_file_bytes"
        | "rss_shmem_bytes"
        | "uordblks"
        | "fordblks"
        | "hblkhd",
    ): RssComponent | undefined => {
      const sv =
        key === "uordblks" || key === "fordblks" || key === "hblkhd"
          ? s?.malloc?.[key]
          : s?.[key];
      const cv =
        key === "uordblks" || key === "fordblks" || key === "hblkhd"
          ? c?.malloc?.[key]
          : c?.[key];
      if (
        typeof sv !== "number" ||
        !Number.isFinite(sv) ||
        sv < 0 ||
        typeof cv !== "number" ||
        !Number.isFinite(cv) ||
        cv < 0
      ) {
        evidence.push(
          `cycle ${k}: no valid idle ${key} (swap ${sv}, control ${cv})`,
        );
        return undefined;
      }
      return { swap_mb: sv / MB, control_mb: cv / MB, diff_mb: (sv - cv) / MB };
    };
    const anon = component("rss_anon_bytes");
    const file = component("rss_file_bytes");
    const shmem = component("rss_shmem_bytes");
    const inUse = component("uordblks");
    const free = component("fordblks");
    const mmap = component("hblkhd");
    if (anon && file && shmem && inUse && free && mmap)
      pairs.push({
        cycle: k,
        rss_anon: anon,
        rss_file: file,
        rss_shmem: shmem,
        malloc_uordblks: inUse,
        malloc_fordblks: free,
        malloc_hblkhd: mmap,
      });
  }
  for (const p of pairs)
    if (p.malloc_uordblks.diff_mb > bound)
      rule.push(
        `cycle ${p.cycle}: allocator in-use heap ${p.malloc_uordblks.swap_mb.toFixed(2)} MiB against the control's ${p.malloc_uordblks.control_mb.toFixed(2)} MiB (${p.malloc_uordblks.diff_mb.toFixed(2)} MiB, bound ${bound})`,
      );
  let sl: number | null = null;
  const later = pairs.filter((p) => p.cycle >= 2);
  if (later.length >= 2) {
    sl = slope(
      later.map((p) => p.cycle),
      later.map((p) => p.rss_anon.diff_mb),
    );
    if (sl > slopeBound)
      rule.push(
        `slope over cycles 2-${n}: ${sl >= 0 ? "+" : ""}${sl.toFixed(2)} MiB/cycle (bound ${slopeBound})`,
      );
  } else
    evidence.push("fewer than two RssAnon pairs after cycle 1 for the slope");
  return {
    rule,
    evidence,
    detail: `Allocator in-use heap deltas ${pairs.map((p) => p.malloc_uordblks.diff_mb.toFixed(3)).join(", ")} MiB (bound ${bound}); RssAnon deltas ${pairs.map((p) => p.rss_anon.diff_mb.toFixed(2)).join(", ")} MiB (absolute offset unbounded: one-time allocator residency accepted as debt; slope over cycles 2-${n}: ${sl === null ? "n/a" : sl.toFixed(2)} of ${slopeBound} MiB/cycle); RssFile deltas ${pairs.map((p) => p.rss_file.diff_mb.toFixed(2)).join(", ")} MiB; RssShmem deltas ${pairs.map((p) => p.rss_shmem.diff_mb.toFixed(2)).join(", ")} MiB; allocator fordblks deltas ${pairs.map((p) => p.malloc_fordblks.diff_mb.toFixed(2)).join(", ")} MiB; hblkhd deltas ${pairs.map((p) => p.malloc_hblkhd.diff_mb.toFixed(2)).join(", ")} MiB (reported without bounds)`,
    pairs,
    slope: sl,
  };
}

export interface CpuPhase {
  cycle: number;
  phase: "idle" | "armed";
  frames: number;
  cpu_us_median: number;
  tracked_us_median: number;
  callback_us: number;
}

/** A row's process frames: the `frames` ending at process_frame. */
function phaseFrames(leg: SwapLeg, r: SwapRow): FrameLine[] {
  const lo = r.process_frame - r.frames + 1;
  return (leg.frames ?? []).filter(
    (f) => f.process_frame >= lo && f.process_frame <= r.process_frame,
  );
}

export function cpuPhases(leg: SwapLeg): CpuPhase[] {
  return leg.rows.map((r) => {
    const f = phaseFrames(leg, r);
    return {
      cycle: r.cycle,
      phase: r.phase,
      frames: f.length,
      cpu_us_median: median(f.map((x) => x.cpu_ns / 1000)),
      tracked_us_median: median(
        f.map((x) => TRACKED.reduce((a, i) => a + x.sections[i], 0)),
      ),
      callback_us: (r.callback_ns_per_frame ?? Number.NaN) / 1000,
    };
  });
}

export interface CpuDelta {
  cycle: number;
  tracked_us: number;
  callback_us: number;
  delta_us: number;
  bound_us: number;
  control_cpu_us: number;
  swap_cpu_us: number;
}

/** swap-cycle-standby-cpu's deltas, per cycle, between the swap and control idle phases. */
export function judgeCpu(
  swap: SwapLeg,
  control: SwapLeg,
  n: number,
): Judged & { deltas: CpuDelta[] } {
  const rule: string[] = [];
  const evidence = [
    ...swap.evidence.map((e) => `swap: ${e}`),
    ...control.evidence.map((e) => `control: ${e}`),
  ];
  if (!swap.frames) evidence.push("swap: no frames.csv");
  if (!control.frames) evidence.push("control: no frames.csv");
  const deltas: CpuDelta[] = [];
  if (swap.frames && control.frames) {
    const sp = cpuPhases(swap).filter((p) => p.phase === "idle");
    const cp = cpuPhases(control).filter((p) => p.phase === "idle");
    for (let k = 1; k <= n; k++) {
      const s = sp.find((p) => p.cycle === k);
      const c = cp.find((p) => p.cycle === k);
      if (!s || !c || s.frames < 100 || c.frames < 100) {
        evidence.push(
          `cycle ${k}: idle frames in frames.csv (swap ${s?.frames}, control ${c?.frames})`,
        );
        continue;
      }
      const d: CpuDelta = {
        cycle: k,
        tracked_us: s.tracked_us_median - c.tracked_us_median,
        callback_us: s.callback_us - c.callback_us,
        delta_us:
          s.tracked_us_median -
          c.tracked_us_median +
          (s.callback_us - c.callback_us),
        bound_us: c.cpu_us_median * CPU_BOUND_FRACTION,
        control_cpu_us: c.cpu_us_median,
        swap_cpu_us: s.cpu_us_median,
      };
      deltas.push(d);
      if (!(d.delta_us <= d.bound_us))
        rule.push(
          `cycle ${k}: +${d.delta_us.toFixed(2)} us a frame (tracked ${d.tracked_us.toFixed(2)}, callback ${d.callback_us.toFixed(2)}) over the bound ${d.bound_us.toFixed(2)} (1% of the control's ${d.control_cpu_us.toFixed(1)})`,
        );
    }
  }
  return {
    rule,
    evidence,
    detail: `delta per cycle ${deltas.map((d) => d.delta_us.toFixed(2)).join(", ")} us (bounds ${deltas.map((d) => d.bound_us.toFixed(1)).join(", ")}); whole-frame median idle swap ${deltas.map((d) => d.swap_cpu_us.toFixed(0)).join("/")} vs control ${deltas.map((d) => d.control_cpu_us.toFixed(0)).join("/")} us (unjudged)`,
    deltas,
  };
}

// ------------------------------------------------------------------------------- the group

const SHORT_N = 3;
const CYCLE_N = 10;
const SABOTAGES = [
  "keep-served",
  "keep-listener",
  "keep-hub",
  "skip-mirror-reset",
] as const;

export interface G8swReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  bounds: {
    heap_in_use_mib: typeof HEAP_IN_USE_BOUND_MIB;
    rss_anon_slope_mb: typeof RSS_SLOPE_MB;
    cpu_fraction: number;
    notes: string;
  };
  rss: Record<string, Record<string, unknown>>;
  cpu: Record<string, unknown>;
  threads: Record<string, unknown>;
  fds: Record<string, unknown>;
}

const fail = (id: string, criterion: string, detail: string): G8aCheck => ({
  id,
  criterion,
  passed: false,
  status: "fail",
  detail,
});

/** A check from the judged legs: pass when none has a rule or evidence problem. */
function fromJudged(
  id: string,
  criterion: string,
  judged: [string, Judged][],
): G8aCheck {
  const problems: string[] = [];
  for (const [name, j] of judged) {
    for (const e of j.evidence)
      problems.push(`${name}: evidence missing or incomplete: ${e}`);
    for (const r of j.rule)
      problems.push(r.startsWith(name) ? r : `${name}: ${r}`);
  }
  return check(
    id,
    criterion,
    problems,
    judged.map(([name, j]) => `${name}: ${j.detail}`).join(" | "),
  );
}

export async function runG8sw(
  out: string,
): Promise<{ checks: G8aCheck[]; report: G8swReport }> {
  const g = join(out, "g8sw");
  const checks: G8aCheck[] = [];
  const report: G8swReport = {
    legs: {},
    bounds: {
      heap_in_use_mib: HEAP_IN_USE_BOUND_MIB,
      rss_anon_slope_mb: RSS_SLOPE_MB,
      cpu_fraction: CPU_BOUND_FRACTION,
      notes: RSS_NOTES,
    },
    rss: {},
    cpu: {},
    threads: {},
    fds: {},
  };
  const legDirs = [
    "short/swap",
    "short/control",
    ...SABOTAGES.map((s) => `short/sabotage-${s}`),
    "cycle/control",
    "cycle/swap",
  ];
  for (const l of legDirs)
    report.legs[l] = {
      exit_code: await exitCode(join(g, l)),
      skipped: skipped(join(g, l)),
    };
  const load = (l: string, kind: "swap" | "control", n: number) =>
    loadLeg(join(g, l), kind, n);

  const shortSwap = await load("short/swap", "swap", SHORT_N);
  const shortControl = await load("short/control", "control", SHORT_N);
  // The cycle legs: a timing group, skipped on a remote runner. Absent entirely (never launched) is
  // the same as skipped for the checks that also have short legs; it fails the cycle-only check.
  const cycleExists = existsSync(join(g, "cycle"));
  const cycleSwap = await load("cycle/swap", "swap", CYCLE_N);
  const cycleControl = await load("cycle/control", "control", CYCLE_N);
  const cyclePresent =
    cycleExists && cycleSwap.skipped === null && cycleControl.skipped === null;
  const cycleWhy = !cycleExists
    ? "g8sw/cycle did not run"
    : `g8sw/cycle/swap and cycle/control ${cycleSwap.skipped ?? cycleControl.skipped ?? "ran"} (timing group swap-cycle)`;

  // --- swap-accounting ---------------------------------------------------------------------
  {
    const judged: [string, Judged][] = [];
    const swaps: [string, SwapLeg, number][] = [
      ["short/swap", shortSwap, SHORT_N],
    ];
    if (cyclePresent) swaps.push(["cycle/swap", cycleSwap, CYCLE_N]);
    for (const [name, leg, n] of swaps) {
      const j = judgeAccounting(leg, n);
      if (leg.exit_code !== "0" && leg.skipped === null)
        j.rule.push(`${name} exit ${leg.exit_code}`);
      judged.push([name, j]);
    }
    if (!cyclePresent)
      judged.push([
        "cycle/swap",
        { rule: [], evidence: [], detail: `not judged (${cycleWhy})` },
      ]);
    checks.push(
      fromJudged(
        "swap-accounting",
        "LS3 (live-swap-design.md Q3): after every disarm of a swap run (each arm's teardown.json, and every idle row of swap-cycle.jsonl) the capture's own accounting is empty: mirror tables, payload and held bytes 0 (canvases at most the fresh mirror's root), served sets, served bytes and warm cache 0, both worker pools stopped, no hub, no carrier set, no track hub, writer joined, no publisher, resource-log, mesh-buffer and adopt-registry maps empty, item_meta host and filter-watch tables empty; and the armed rows are not vacuous (a hub each, every armed row serving bytes the viewer pinned, the born first arm holding textures)",
        judged,
      ),
    );
  }

  // --- swap-cycle-threads ------------------------------------------------------------------
  const threadsFor = (l: string, leg: SwapLeg, kind: "swap" | "control") => {
    const j = judgeThreads(leg, kind);
    report.threads[l] = {
      rows: leg.rows.map((r) => ({
        cycle: r.cycle,
        phase: r.phase,
        capture_threads: r.capture_threads,
        threads_total: r.threads_total,
      })),
    };
    return j;
  };
  {
    const judged: [string, Judged][] = [
      ["short/swap", threadsFor("short/swap", shortSwap, "swap")],
      ["short/control", threadsFor("short/control", shortControl, "control")],
    ];
    if (cyclePresent) {
      judged.push(["cycle/swap", threadsFor("cycle/swap", cycleSwap, "swap")]);
      judged.push([
        "cycle/control",
        threadsFor("cycle/control", cycleControl, "control"),
      ]);
    }
    checks.push(
      fromJudged(
        "swap-cycle-threads",
        "LS3: the capture's own threads (rs-ws-io, the wt runtime, the grc-* workers, writer, Former and teardown thread) are 0 in every idle phase of a swap run and in every control row, exactly; the armed phases show at least rs-ws-io and grc-former; the process thread totals are reported, not judged",
        judged,
      ),
    );
  }

  // --- swap-cycle-fds ----------------------------------------------------------------------
  const fdsFor = (l: string, leg: SwapLeg, kind: "swap" | "control") => {
    const j = judgeFds(leg, kind);
    report.fds[l] = {
      rows: leg.rows.map((r) => ({
        cycle: r.cycle,
        phase: r.phase,
        inet_sockets: r.inet_sockets,
        sockets: r.sockets,
        fds_total: r.fds_total,
      })),
    };
    return j;
  };
  {
    const judged: [string, Judged][] = [
      ["short/swap", fdsFor("short/swap", shortSwap, "swap")],
      ["short/control", fdsFor("short/control", shortControl, "control")],
    ];
    if (cyclePresent) {
      judged.push(["cycle/swap", fdsFor("cycle/swap", cycleSwap, "swap")]);
      judged.push([
        "cycle/control",
        fdsFor("cycle/control", cycleControl, "control"),
      ]);
    }
    checks.push(
      fromJudged(
        "swap-cycle-fds",
        "LS3: the process holds no TCP or UDP socket (the capture's listeners and connections; a headless fixture opens none) in any idle phase of a swap run or any control row, exactly; the armed phases hold at least one; the process fd and Unix-socket totals are reported, not judged",
        judged,
      ),
    );
  }

  // --- swap-cycle-rss ----------------------------------------------------------------------
  const rssFor = (
    l: string,
    swap: SwapLeg,
    control: SwapLeg,
    n: number,
    set: "short" | "cycle",
  ) => {
    const j = judgeRss(
      swap,
      control,
      n,
      HEAP_IN_USE_BOUND_MIB[set],
      RSS_SLOPE_MB[set],
    );
    report.rss[l] = { pairs: j.pairs, slope_mb_per_cycle: j.slope };
    return j;
  };
  {
    const judged: [string, Judged][] = [
      [
        "short/swap",
        rssFor("short/swap", shortSwap, shortControl, SHORT_N, "short"),
      ],
    ];
    if (cyclePresent)
      judged.push([
        "cycle/swap",
        rssFor("cycle/swap", cycleSwap, cycleControl, CYCLE_N, "cycle"),
      ]);
    checks.push(fromJudged("swap-cycle-rss", RSS_NOTES, judged));
  }

  // --- swap-cycle-standby-cpu --------------------------------------------------------------
  {
    const cpuFor = (l: string, swap: SwapLeg, control: SwapLeg, n: number) => {
      const j = judgeCpu(swap, control, n);
      report.cpu[l] = {
        deltas: j.deltas,
        swap_phases: cpuPhases(swap),
        control_phases: cpuPhases(control),
      };
      return j;
    };
    const criterion =
      "LS3 (fork F1): on the cycle legs, per cycle, the swap run's idle-phase median hooked-block cost (params + churn, per frame, from frames.csv over the phase's process frames) plus its callback ns a frame, minus the control's, is within 1% of the control idle phase's median per-frame main-thread CPU; the short legs report the same numbers unjudged, as does the whole-frame CPU of every phase";
    const short = cpuFor("short/swap", shortSwap, shortControl, SHORT_N);
    if (!cyclePresent) {
      checks.push(
        fail(
          "swap-cycle-standby-cpu",
          criterion,
          `evidence missing (${cycleWhy}); short legs unjudged: ${short.detail}`,
        ),
      );
    } else {
      const j = cpuFor("cycle/swap", cycleSwap, cycleControl, CYCLE_N);
      checks.push(
        fromJudged("swap-cycle-standby-cpu", criterion, [
          ["cycle/swap", j],
          [
            "short/swap (unjudged)",
            { rule: [], evidence: [], detail: short.detail },
          ],
        ]),
      );
    }
  }

  // --- the sabotages -------------------------------------------------------------------------
  const sabLegs: Record<string, SwapLeg> = {};
  for (const s of SABOTAGES)
    sabLegs[s] = await load(`short/sabotage-${s}`, "swap", SHORT_N);
  const caught = (
    id: string,
    criterion: string,
    sab: string,
    rules: [string, (leg: SwapLeg) => Judged][],
  ) => {
    const leg = sabLegs[sab];
    if (leg.skipped !== null) {
      checks.push(
        fail(
          id,
          criterion,
          `evidence missing: short/sabotage-${sab} ${leg.skipped}`,
        ),
      );
      return;
    }
    const problems: string[] = [];
    const details: string[] = [];
    for (const [rule, judge] of rules) {
      const j = judge(leg);
      for (const e of j.evidence)
        problems.push(`${rule}: evidence missing or incomplete: ${e}`);
      if (j.evidence.length === 0) {
        if (j.rule.length === 0)
          problems.push(`${rule} did not fail on the sabotage leg`);
        else
          details.push(
            `${rule} fails: ${j.rule.slice(0, 2).join("; ")}${j.rule.length > 2 ? ` (+${j.rule.length - 2} more)` : ""}`,
          );
      }
    }
    checks.push(
      check(
        id,
        criterion,
        leg.evidence.length === 0 || problems.length ? problems : [],
        details.join(" | "),
      ),
    );
  };
  // Accounting is judged without the armed-row non-vacuity (a sabotage keeps things on purpose, but
  // the armed phases still serve); the RSS control for every short sabotage is short/control.
  const acct = (leg: SwapLeg) => judgeAccounting(leg, SHORT_N);
  const rss = (leg: SwapLeg) =>
    judgeRss(
      leg,
      shortControl,
      SHORT_N,
      HEAP_IN_USE_BOUND_MIB.short,
      RSS_SLOPE_MB.short,
    );
  caught(
    "sabotage-keep-served-caught",
    "GRC_REARM_FAULT=keep-served (the served set and the bodies a viewer pinned survive the disarm) fails swap-accounting and swap-cycle-rss on the same fixture",
    "keep-served",
    [
      ["swap-accounting", acct],
      ["swap-cycle-rss", rss],
    ],
  );
  caught(
    "sabotage-keep-listener-caught",
    "GRC_REARM_FAULT=keep-listener (the carrier set and its listen socket survive the disarm) fails swap-cycle-fds",
    "keep-listener",
    [["swap-cycle-fds", (leg) => judgeFds(leg, "swap")]],
  );
  caught(
    "sabotage-keep-hub-caught",
    "GRC_REARM_FAULT=keep-hub (the hub and its grc-former thread survive the disarm) fails swap-cycle-threads",
    "keep-hub",
    [["swap-cycle-threads", (leg) => judgeThreads(leg, "swap")]],
  );
  caught(
    "sabotage-skip-mirror-reset-caught",
    "GRC_REARM_FAULT=skip-mirror-reset (the mirror is not released at the disarm) fails swap-accounting",
    "skip-mirror-reset",
    [["swap-accounting", acct]],
  );

  return { checks, report };
}
