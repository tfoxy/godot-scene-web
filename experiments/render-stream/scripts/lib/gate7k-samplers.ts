// G7k (gate7-design.md Q6 "Samplers", D16, Q10 startup/soak): the memory samplers Q6 names and
// G7h deferred ("Q6's 'Samplers' bullet... is D16/G7k's own deliverable", g7h.md "Deviations"),
// at 1 Hz, for one browser leg.
//
// Per D16 ("Memory accounting... per process, from /proc and CDP, never from one number"):
//   - browser/renderer/GPU process RSS from `/proc/<pid>/status` (`readProcStatus`,
//     `proc-sampler.ts`, reused as-is: it is already engine-free, pid-only);
//   - JS heap from CDP `Performance.getMetrics` (`JSHeapUsedSize`);
//   - the wasm heap from the page's own `window.__rsWasmHeap()` (both receivers already expose
//     this: GSW's `memory.buffer.byteLength`, the web export's `HEAP8.byteLength`; D29 amendment
//     to g7k.md: "never shrinks");
//   - per-process GPU memory from `nvidia-smi`, reusing `packages/perf-harness/src/nvidia.ts`'s
//     `sampleChromeVram` (same pid-attributed reader the device/desktop perf harness uses).
//
// This never asks a receiver for anything: every number here comes from OUTSIDE the page (the
// browser's own processes, or a JS heap/wasm heap read the page cannot fake past -- `performance`
// and `WebAssembly.Memory` are host objects). It is deliberately a flat JSONL writer with no
// judgment: `gate7k-checks.ts` applies Q10's thresholds to what this file recorded.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";
// ../../../../packages/perf-harness/src/nvidia.ts (the repo's own relative-import convention for
// scripts/lib reaching a package's TypeScript source, e.g. device-sampler.ts, browser-harness.ts).
import { sampleChromeVram } from "../../../../packages/perf-harness/src/nvidia";
import { type ChromiumProcessInfo, collectChromiumProcesses } from "./browser-harness";
import { readProcStatus } from "./proc-sampler";

/** Races `p` against a timeout, so a single stuck CDP/page round-trip (observed: a leg's
 * `context.close()` left pending past its external kill, G7k's first real soak run) degrades to
 * one missing sample instead of hanging this tick, and every tick after it, forever. Resolves to
 * `fallback` on a timeout; never rejects. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

declare global {
  interface Window {
    __rsWasmHeap?: () => number | null;
  }
}

export interface MemSample {
  schema: "render-stream-gate7k-mem-sample/1";
  t_us: number;
  /** `/proc/<pid>/status` VmRSS, one entry per Chromium process type this run has (browser,
   * renderer, gpu-process; a type absent from `SystemInfo.getProcessInfo` or whose /proc read
   * raced an exit is omitted, never a false 0). */
  rss_bytes: Record<string, number>;
  /** G7kr: true when this sample was taken right after a forced full GC (`HeapProfiler.
   * collectGarbage`, every `GC_EVERY_TICKS` ticks). V8/Oilpan garbage makes the page renderer's
   * RSS a sawtooth (web: 395-562 MB in one honest soak); the settled series is what a bound can
   * judge. Absent on the other samples. */
  post_gc?: true;
  /** CDP `Performance.getMetrics`' `JSHeapUsedSize`. `null`: the CDP call failed (reported, never
   * silently 0). */
  js_heap_bytes: number | null;
  /** `window.__rsWasmHeap()`. `null`: the page has none yet (before the module loads) or the
   * `page.evaluate` failed (e.g. mid-navigation). */
  wasm_heap_bytes: number | null;
  /** `sampleChromeVram`'s summed, pid-attributed bytes. `null`: not measured (no nvidia-smi, no
   * GPU-process pid found, or the driver lists none for it) -- D16/nvidia.ts's own rule, never 0. */
  gpu_mem_bytes: number | null;
  /** `sampleChromeVram`'s own attribution line, kept for the record even when `gpu_mem_bytes` is
   * null (names which of the three reasons above it was). */
  gpu_mem_attribution: string;
}

export interface MemSamplerHandle {
  /** Stops the 1 Hz interval and returns every sample recorded (also on disk at `outPath`). */
  stop(): Promise<MemSample[]>;
}

/** G7kr: per role, the RSS at the start, the settled (post-GC) level around 60 s and at the end,
 * and the min/max, in bytes: "memory by process" for the soak JSON. */
function summarizeByRole(
  samples: readonly MemSample[],
  roles: Record<string, number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema: "render-stream-gate7k-mem-summary/1",
  };
  const t0 = samples[0]?.t_us ?? 0;
  const med = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const a = [...xs].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)];
  };
  for (const role of Object.keys(roles)) {
    const pts = samples
      .map((s) => ({ t: (s.t_us - t0) / 1e6, v: s.rss_bytes[role], gc: s.post_gc === true }))
      .filter((p) => p.v !== undefined);
    if (pts.length === 0) continue;
    const last = pts[pts.length - 1].t;
    const settled = pts.filter((p) => p.gc);
    out[role] = {
      pid: roles[role],
      samples: pts.length,
      start_bytes: pts[0].v,
      min_bytes: Math.min(...pts.map((p) => p.v)),
      max_bytes: Math.max(...pts.map((p) => p.v)),
      median_60_90_s_bytes: med(pts.filter((p) => p.t >= 60 && p.t <= 90).map((p) => p.v)),
      median_330_360_s_bytes: med(pts.filter((p) => p.t >= 330 && p.t <= 360).map((p) => p.v)),
      end_median_last_30_s_bytes: med(pts.filter((p) => p.t >= last - 30).map((p) => p.v)),
      settled_post_gc_bytes: settled.map((p) => [Math.round(p.t), p.v]),
    };
  }
  return out;
}

/** `mem-procs.json` beside the timeline: which pid played which role (G7kr). */
function procsPath(timelinePath: string): string {
  return join(dirname(timelinePath), "mem-procs.json");
}

/** Names every Chromium process by role: `browser`, `GPU`, `page-renderer` (the receiver page's
 * own renderer), `other-renderer-<pid>`, and the utility processes by their CDP type. */
function rolesFor(
  processes: readonly ChromiumProcessInfo[],
  pageRendererPid: number | null,
): Record<string, number> {
  const roles: Record<string, number> = {};
  for (const p of processes) {
    let role: string;
    if (p.type === "renderer")
      role = p.pid === pageRendererPid ? "page-renderer" : `other-renderer-${p.pid}`;
    else if (p.type === "gpu-process") role = "GPU";
    else role = p.type;
    if (!(role in roles)) roles[role] = p.pid;
  }
  return roles;
}

const MARKER_BYTES = 128 * 1024 * 1024;

/** Finds the renderer that hosts `page`. `SystemInfo.getProcessInfo` lists renderers without the
 * target they serve (G7kh: the first listed one was an idle 70 MB renderer, not the page's), and
 * the pinned Chromium exposes no target-to-pid CDP call headless. So the page proves which one it
 * is: it touches a 128 MiB buffer, the renderer whose VmRSS rises by most of it is the page's,
 * and the buffer is dropped and collected again. A single renderer needs no proof. */
async function identifyPageRenderer(
  page: Page,
  perfSession: CDPSession,
  processes: readonly ChromiumProcessInfo[],
): Promise<number | null> {
  const renderers = processes.filter((p) => p.type === "renderer");
  if (renderers.length === 0) return null;
  if (renderers.length === 1) return renderers[0].pid;
  const rss = (pid: number): number => {
    try {
      return readProcStatus(pid).vmRssBytes;
    } catch {
      return 0;
    }
  };
  const before = new Map(renderers.map((p) => [p.pid, rss(p.pid)]));
  await withTimeout(
    page.evaluate((n) => {
      const w = window as unknown as { __rsRssMarker?: Uint8Array | null };
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i += 4096) buf[i] = 1;
      w.__rsRssMarker = buf;
    }, MARKER_BYTES),
    10000,
    undefined,
  );
  await new Promise((r) => setTimeout(r, 300));
  let best: number | null = null;
  let bestDelta = 0;
  for (const p of renderers) {
    const delta = rss(p.pid) - (before.get(p.pid) ?? 0);
    if (delta > bestDelta) {
      bestDelta = delta;
      best = p.pid;
    }
  }
  await withTimeout(
    page.evaluate(() => {
      (window as unknown as { __rsRssMarker?: unknown }).__rsRssMarker = null;
    }),
    5000,
    undefined,
  );
  await withTimeout(
    perfSession.send("HeapProfiler.collectGarbage" as never),
    10000,
    undefined,
  );
  if (best === null || bestDelta < MARKER_BYTES / 2)
    throw new Error(
      `gate7k-samplers: could not identify the page's renderer (largest RSS rise ${bestDelta} B of ${MARKER_BYTES} B across ${renderers.length} renderers)`,
    );
  return best;
}

/** A forced GC every this many ticks (1 Hz: every 30 s), so [60 s, 360 s] holds 11 settled points. */
const GC_EVERY_TICKS = 30;

async function sampleOnce(
  page: Page,
  perfSession: CDPSession,
  pidsByType: Record<string, number>,
  mainPid: number,
  postGc: boolean,
): Promise<MemSample> {
  if (postGc) {
    await withTimeout(
      perfSession.send("HeapProfiler.collectGarbage" as never),
      10000,
      undefined,
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  const rss_bytes: Record<string, number> = {};
  for (const [type, pid] of Object.entries(pidsByType)) {
    try {
      rss_bytes[type] = readProcStatus(pid).vmRssBytes;
    } catch {
      // The process exited between discovery and this sample (normal at leg teardown): omit it.
    }
  }
  let js_heap_bytes: number | null = null;
  try {
    const result = (await withTimeout(
      perfSession.send("Performance.getMetrics" as never),
      2000,
      null,
    )) as { metrics: { name: string; value: number }[] } | null;
    const m = result?.metrics.find((e) => e.name === "JSHeapUsedSize");
    js_heap_bytes = m ? m.value : null;
  } catch {
    js_heap_bytes = null;
  }
  let wasm_heap_bytes: number | null = null;
  try {
    wasm_heap_bytes = await withTimeout(
      page.evaluate(() => window.__rsWasmHeap?.() ?? null),
      2000,
      null,
    );
  } catch {
    wasm_heap_bytes = null;
  }
  const vram = await withTimeout(sampleChromeVram(mainPid), 5000, {
    gpuPids: [],
    usedBytes: null,
    attribution: "NOT MEASURED: sampleChromeVram did not return within 5 s",
  });
  return {
    schema: "render-stream-gate7k-mem-sample/1",
    ...(postGc ? { post_gc: true as const } : {}),
    t_us: Math.round(Date.now() * 1000),
    rss_bytes,
    js_heap_bytes,
    wasm_heap_bytes,
    gpu_mem_bytes: vram.usedBytes,
    gpu_mem_attribution: vram.attribution,
  };
}

/**
 * Starts the 1 Hz sampler for one leg's already-launched browser and page, writing one JSON
 * line per sample to `outPath` as it goes (so a leg that crashes mid-soak still leaves a partial
 * timeline). `Performance.enable` is issued once, on the page's own CDP session, so the metrics
 * domain is live before the first sample.
 */
export async function startMemSampler(
  browser: Browser,
  page: Page,
  outPath: string,
  intervalMs = 1000,
): Promise<MemSamplerHandle> {
  mkdirSync(dirname(outPath), { recursive: true });
  const samples: MemSample[] = [];
  const perfSession = await page.context().newCDPSession(page);
  await perfSession.send("Performance.enable" as never);
  const processes = await collectChromiumProcesses(browser);
  const mainPid =
    processes.find((p) => p.type === "browser")?.pid ?? processes[0]?.pid;
  if (mainPid === undefined) {
    throw new Error(
      "gate7k-samplers: SystemInfo.getProcessInfo returned no Chromium process",
    );
  }
  const pageRendererPid = await identifyPageRenderer(page, perfSession, processes);
  const pidsByRole = rolesFor(processes, pageRendererPid);
  writeFileSync(
    procsPath(outPath),
    `${JSON.stringify({ schema: "render-stream-gate7k-mem-procs/1", page_renderer_pid: pageRendererPid, roles: pidsByRole, processes }, null, 2)}\n`,
  );
  const pidsByType = pidsByRole;
  let stopped = false;
  let ticking = false;
  let tickN = 0;
  const tick = async (): Promise<void> => {
    // Never two ticks in flight at once (a slow one from under system load must not pile up),
    // and a stopped sampler or a page that is actually gone just skips this tick -- one bad or
    // slow tick must never cancel every tick after it (G7k's first real soak run: a stuck CDP
    // round-trip inside `sampleOnce` left the sampler permanently silent for the rest of a 976-s
    // leg before `withTimeout` bounded every call in it).
    if (stopped || ticking || page.isClosed()) return;
    ticking = true;
    try {
      tickN++;
      const sample = await sampleOnce(
        page,
        perfSession,
        pidsByType,
        mainPid,
        tickN % GC_EVERY_TICKS === 0,
      );
      samples.push(sample);
      appendFileSync(outPath, `${JSON.stringify(sample)}\n`);
    } catch {
      // Swallowed: sampleOnce already bounds and catches its own sub-calls, so this is only an
      // unexpected one (e.g. a write failure); one missed sample, never a reason to stop.
    } finally {
      ticking = false;
    }
  };
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
  return {
    async stop(): Promise<MemSample[]> {
      stopped = true;
      clearInterval(interval);
      await withTimeout(perfSession.detach(), 2000, undefined).catch(() => {});
      writeFileSync(
        join(dirname(outPath), "mem-summary.json"),
        `${JSON.stringify(summarizeByRole(samples, pidsByRole), null, 2)}\n`,
      );
      return samples;
    },
  };
}
