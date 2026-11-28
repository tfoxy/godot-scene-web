#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** Chrome trace timestamps and durations are microseconds. */
export interface TraceEvent {
  ph: string;
  name?: string;
  cat?: string;
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  id?: string | number;
  id2?: { local?: string; global?: string };
  args?: Record<string, unknown>;
}

type Span = TraceEvent & { name: string; ts: number; dur: number };
const thread = (e: TraceEvent): string => `${e.pid}:${e.tid}`;
export const BENCH_PHASES = [
  "decode",
  "provide",
  "program",
  "apply",
  "draw",
] as const;

/** Normalize complete, stack (B/E), and async (b/e) slices; unfinished slices are excluded. */
function spans(events: TraceEvent[]): Span[] {
  const out: Span[] = [];
  const stacks = new Map<string, TraceEvent[]>();
  const asyncStarts = new Map<string, TraceEvent>();
  const add = (a: TraceEvent, end: number) => {
    if (a.ts !== undefined && a.name && end >= a.ts)
      out.push({ ...a, name: a.name, ts: a.ts, dur: end - a.ts });
  };
  for (const e of [...events].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if (e.ts === undefined) continue;
    const key = thread(e);
    const asyncKey = `${e.pid}:${e.cat ?? ""}:${e.name}:${JSON.stringify(e.id2 ?? e.id)}`;
    if (e.ph === "X" && e.dur !== undefined) add(e, e.ts + e.dur);
    else if (e.ph === "B") {
      const stack = stacks.get(key) ?? [];
      stack.push(e);
      stacks.set(key, stack);
    } else if (e.ph === "E") {
      const start = stacks.get(key)?.pop();
      if (start) add(start, e.ts);
    } else if (e.ph === "b") asyncStarts.set(asyncKey, e);
    else if (e.ph === "e") {
      const start = asyncStarts.get(asyncKey);
      if (start) add(start, e.ts);
      asyncStarts.delete(asyncKey);
    }
  }
  return out;
}

/** Union and clip spans: parent tasks and nested WebGL slices never count twice. */
function busyMs(slices: Span[], start: number, end: number): number {
  let busy = 0;
  let last = start;
  for (const s of slices) {
    const a = Math.max(start, s.ts, last);
    const b = Math.min(end, s.ts + s.dur);
    if (b > a) {
      busy += b - a;
      last = b;
    }
  }
  return busy / 1000;
}

export interface Distribution {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
}
function describe(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? null;
  return {
    n: s.length,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    p50: q(0.5),
    p95: q(0.95),
  };
}

export function frameBudget(trace: { traceEvents: TraceEvent[] }) {
  const events = trace.traceEvents;
  const names = new Map<string, string>();
  for (const e of events)
    if (e.ph === "M" && e.name === "thread_name")
      names.set(thread(e), String(e.args?.name));
  const all = spans(events).sort((a, b) => a.ts - b.ts);
  const rafs = all.filter(
    (e) =>
      e.name === "FireAnimationFrame" &&
      names.get(thread(e)) === "CrRendererMain",
  );
  const candidates = [...new Set(rafs.map(thread))];
  const profiled = candidates.filter((t) =>
    all.some((e) => thread(e) === t && e.name.startsWith("rs-bench:")),
  );
  const renderer =
    profiled.length === 1
      ? profiled[0]
      : candidates.length === 1
        ? candidates[0]
        : null;
  if (!renderer)
    throw new Error(
      "trace needs one identifiable bench renderer with rAF callbacks (enable prof=1)",
    );
  const raf = rafs.filter((e) => thread(e) === renderer);
  const starts = [...new Set(raf.map((e) => e.ts))];
  if (starts.length < 2)
    throw new Error(
      "trace needs at least two rAF callbacks for a complete frame interval",
    );
  const main = all.filter((e) => thread(e) === renderer);
  const phaseSpans = Object.fromEntries(
    BENCH_PHASES.map((p) => [
      p,
      main.filter((e) => e.name === `rs-bench:${p}`),
    ]),
  );
  // CrGpuMain task time is command processing plus driver/GPU stalls, NOT GPU execution time.
  const gpu = all.filter(
    (e) =>
      names.get(thread(e)) === "CrGpuMain" &&
      (e.cat?.split(",").includes("toplevel") || e.name === "WebGL"),
  );
  // Display::DrawAndSwap and SwapBuffers describe the same swap at different levels. Prefer
  // the compositor event when present, rather than counting both as independent swaps.
  const drawAndSwap = all.filter((e) => e.name === "Display::DrawAndSwap");
  const swaps = drawAndSwap.length
    ? drawAndSwap
    : all.filter((e) => e.name === "SkiaOutputSurfaceImplOnGpu::SwapBuffers");
  const dropped = events.filter((e) => {
    const reporter = e.args?.frame_reporter as { state?: string } | undefined;
    return (
      e.name === "PipelineReporter" &&
      e.ph === "b" &&
      reporter?.state === "STATE_DROPPED"
    );
  });
  const count = (es: TraceEvent[], a: number, b: number) =>
    es.filter((e) => e.ts !== undefined && e.ts >= a && e.ts < b).length;
  const frames = starts.slice(0, -1).map((start, i) => {
    const end = starts[i + 1];
    const interval = (end - start) / 1000;
    const task = busyMs(gpu, start, end);
    return {
      frame: i,
      start_us: start,
      interval_ms: interval,
      raf_ms: busyMs(raf, start, end),
      decode_ms: busyMs(phaseSpans.decode, start, end),
      provide_ms: busyMs(phaseSpans.provide, start, end),
      program_ms: busyMs(phaseSpans.program, start, end),
      apply_ms: busyMs(phaseSpans.apply, start, end),
      draw_ms: busyMs(phaseSpans.draw, start, end),
      gpu_task_ms: task,
      gpu_idle_ms: Math.max(0, interval - task),
      swaps: count(swaps, start, end),
      dropped: count(dropped, start, end),
    };
  });
  const columns = [
    "interval_ms",
    "raf_ms",
    "decode_ms",
    "provide_ms",
    "program_ms",
    "apply_ms",
    "draw_ms",
    "gpu_task_ms",
    "gpu_idle_ms",
    "swaps",
    "dropped",
  ] as const;
  return {
    schema: "render-stream-frame-budget/1",
    renderer,
    gpu_threads: [...new Set(gpu.map(thread))],
    // Zero phase time is valid; coverage distinguishes it from timings missing from the trace.
    phase_measures: Object.fromEntries(
      BENCH_PHASES.map((p) => [p, phaseSpans[p].length]),
    ),
    notes: [
      "Intervals run from one rAF start to the next; the final incomplete interval is excluded.",
      "GPU task time is CrGpuMain CPU/driver work and stalls, not GPU execution time.",
      "Dropped frames are explicit PipelineReporter STATE_DROPPED events, not inferred rAF gaps.",
    ],
    frames,
    summary: Object.fromEntries(
      columns.map((c) => [c, describe(frames.map((f) => f[c]))]),
    ),
  };
}

export function readTrace(path: string): { traceEvents: TraceEvent[] } {
  const bytes = readFileSync(path);
  return JSON.parse(
    (bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes)
      : bytes
    ).toString("utf8"),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const path = process.argv[2];
    if (!path)
      throw new Error("usage: frame-budget.ts <trace.json[.gz]> [--json]");
    const report = frameBudget(readTrace(path));
    if (process.argv.includes("--json"))
      console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `${report.frames.length} complete frames; renderer ${report.renderer}; GPU threads ${report.gpu_threads.join(",")}`,
      );
      console.table(report.summary);
      console.log(report.notes.join("\n"));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
