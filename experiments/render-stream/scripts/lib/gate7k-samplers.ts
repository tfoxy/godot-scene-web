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

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";
// ../../../../packages/perf-harness/src/nvidia.ts (the repo's own relative-import convention for
// scripts/lib reaching a package's TypeScript source, e.g. device-sampler.ts, browser-harness.ts).
import { sampleChromeVram } from "../../../../packages/perf-harness/src/nvidia";
import { collectChromiumProcesses } from "./browser-harness";
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

async function sampleOnce(
  page: Page,
  perfSession: CDPSession,
  pidsByType: Record<string, number>,
  mainPid: number,
): Promise<MemSample> {
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
  const processes = await collectChromiumProcesses(browser);
  const pidsByType: Record<string, number> = {};
  for (const p of processes) {
    // One pid per type kept (the first seen): a relaunched GPU process is rare mid-leg and the
    // nvidia-smi reading already sums every matching pid regardless of this map.
    if (!(p.type in pidsByType)) pidsByType[p.type] = p.pid;
  }
  const mainPid = pidsByType.browser ?? processes[0]?.pid;
  if (mainPid === undefined) {
    throw new Error(
      "gate7k-samplers: SystemInfo.getProcessInfo returned no Chromium process",
    );
  }
  const perfSession = await page.context().newCDPSession(page);
  await perfSession.send("Performance.enable" as never);
  let stopped = false;
  let ticking = false;
  const tick = async (): Promise<void> => {
    // Never two ticks in flight at once (a slow one from under system load must not pile up),
    // and a stopped sampler or a page that is actually gone just skips this tick -- one bad or
    // slow tick must never cancel every tick after it (G7k's first real soak run: a stuck CDP
    // round-trip inside `sampleOnce` left the sampler permanently silent for the rest of a 976-s
    // leg before `withTimeout` bounded every call in it).
    if (stopped || ticking || page.isClosed()) return;
    ticking = true;
    try {
      const sample = await sampleOnce(page, perfSession, pidsByType, mainPid);
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
      return samples;
    },
  };
}
