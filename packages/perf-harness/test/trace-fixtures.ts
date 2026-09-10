// Hand-authored trace events for the analyzer tests.
//
// Deliberately TINY and written by hand rather than captured: a multi-MB real trace would make the
// tests slow, unreviewable, and would couple them to one Chrome build. The event names, categories,
// phases and arg shapes here are copied from a real `perf --dump-trace-names` capture, so the
// fixtures stay faithful without being large.

import type { TraceEvent } from "../src/trace";

export const RENDERER_PID = 100;
export const MAIN_TID = 100;
export const COMPOSITOR_TID = 101;
export const WORKER_TID = 102;
/** A second renderer process — Chrome hosts extensions and other pages here. */
export const OTHER_PID = 200;
/** The browser process, whose work the renderer-pid filter used to discard outright. */
export const BROWSER_PID = 300;
export const GPU_PID = 400;
export const GPU_MAIN_TID = 401;
export const VIZ_TID = 402;

export const ms = (value: number): number => value * 1000;

export function threadMeta(): TraceEvent[] {
  return [
    meta(RENDERER_PID, MAIN_TID, "CrRendererMain"),
    meta(RENDERER_PID, COMPOSITOR_TID, "Compositor"),
    meta(RENDERER_PID, WORKER_TID, "ThreadPoolForegroundWorker"),
    meta(OTHER_PID, MAIN_TID, "CrRendererMain"),
    meta(OTHER_PID, COMPOSITOR_TID, "Compositor"),
    meta(BROWSER_PID, MAIN_TID, "CrBrowserMain"),
    meta(GPU_PID, GPU_MAIN_TID, "CrGpuMain"),
    meta(GPU_PID, VIZ_TID, "VizCompositorThread"),
    // `process_name` is what turns a bare pid into "Renderer" / "Browser" / "GPU Process", which is
    // the whole basis of the cpu block's per-process attribution.
    processMeta(RENDERER_PID, "Renderer"),
    processMeta(OTHER_PID, "Renderer"),
    processMeta(BROWSER_PID, "Browser"),
    processMeta(GPU_PID, "GPU Process"),
  ];
}

function meta(pid: number, tid: number, name: string): TraceEvent {
  return {
    name: "thread_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid,
    tid,
    args: { name },
  };
}

function processMeta(pid: number, name: string): TraceEvent {
  return {
    name: "process_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid,
    tid: 0,
    args: { name },
  };
}

/**
 * Browser- and GPU-process work inside the healthy trace's 50..250 ms window.
 *
 * Every event here is in a process the renderer-pid filter throws away, which is exactly why the
 * `cpu` block exists. The GPU ops are named after real Chrome ops so the bucket regexes are exercised
 * against names that actually occur, plus one deliberately unnameable op that must surface in
 * `topUnbucketedOps` rather than vanish into `other`.
 */
export function crossProcessEvents(): TraceEvent[] {
  return [
    // Browser process: 40 ms wall, 30 ms cpu.
    complete("RunTask", 60, 40, {
      pid: BROWSER_PID,
      tid: MAIN_TID,
      tdurMs: 30,
    }),
    // GPU main: an outer task with nested ops. Only the OUTER contributes to cpu (maximal events),
    // while the ops' SELF time is what the buckets are built from.
    complete("RunTask", 60, 20, {
      pid: GPU_PID,
      tid: GPU_MAIN_TID,
      tdurMs: 16,
    }),
    complete("GpuImageDecodeCache::UploadImage", 61, 8, {
      pid: GPU_PID,
      tid: GPU_MAIN_TID,
    }),
    complete("OpsTask::onExecute", 70, 5, { pid: GPU_PID, tid: GPU_MAIN_TID }),
    complete("SomeUnnamedGpuThing", 76, 3, {
      pid: GPU_PID,
      tid: GPU_MAIN_TID,
    }),
    // Viz: 10 ms wall, 6 ms cpu, all of it a swap.
    complete("SkiaOutputSurfaceImplOnGpu::SwapBuffers", 100, 10, {
      pid: GPU_PID,
      tid: VIZ_TID,
      tdurMs: 6,
    }),
  ];
}

export function instant(
  name: string,
  atMs: number,
  options: {
    pid?: number;
    tid?: number;
    cat?: string;
    args?: Record<string, unknown>;
  } = {},
): TraceEvent {
  return {
    name,
    cat: options.cat ?? "disabled-by-default-devtools.timeline.frame",
    ph: "I",
    ts: ms(atMs),
    pid: options.pid ?? RENDERER_PID,
    tid: options.tid ?? COMPOSITOR_TID,
    args: options.args ?? {},
  };
}

export function complete(
  name: string,
  atMs: number,
  durMs: number,
  options: {
    pid?: number;
    tid?: number;
    cat?: string;
    tdurMs?: number;
    args?: Record<string, unknown>;
  } = {},
): TraceEvent {
  const event: TraceEvent = {
    name,
    cat: options.cat ?? "disabled-by-default-devtools.timeline",
    ph: "X",
    ts: ms(atMs),
    dur: ms(durMs),
    pid: options.pid ?? RENDERER_PID,
    tid: options.tid ?? MAIN_TID,
    args: options.args ?? {},
  };
  if (options.tdurMs !== undefined) {
    event.tdur = ms(options.tdurMs);
  }
  return event;
}

export function mark(
  name: string,
  atMs: number,
  pid = RENDERER_PID,
): TraceEvent {
  return instant(name, atMs, { pid, tid: MAIN_TID, cat: "blink.user_timing" });
}

const ATLAS_URL = "http://127.0.0.1:1234/fixture/atlas.png";

/**
 * A complete, healthy run: mount at 0 ms, ready at 50 ms, four activations, three decodes (one a
 * re-decode of the same image), raster, paints and swaps. `windowMs` for this trace is 200.
 */
export function healthyTrace(): TraceEvent[] {
  return [
    ...threadMeta(),
    mark("scenario:mount", 0),
    mark("scenario:ready", 50),

    // Activations: 60, 76, 92, 200 -> gaps 16, 16, 108 (one over the 100 ms threshold).
    instant("ActivateLayerTree", 60, { args: { frameId: 1, layerTreeId: 2 } }),
    instant("ActivateLayerTree", 76, { args: { frameId: 2, layerTreeId: 2 } }),
    instant("ActivateLayerTree", 92, { args: { frameId: 3, layerTreeId: 2 } }),
    instant("ActivateLayerTree", 200, { args: { frameId: 4, layerTreeId: 2 } }),
    // A DIFFERENT renderer process (extension / other tab). Must never be counted.
    instant("ActivateLayerTree", 70, { pid: OTHER_PID }),
    instant("ActivateLayerTree", 71, { pid: OTHER_PID }),

    // DrawFrame is emitted on both the renderer compositor and the viz thread at the same ts.
    instant("DrawFrame", 60),
    instant("DrawFrame", 60, { tid: COMPOSITOR_TID + 50 }),
    instant("DrawFrame", 76),
    instant("DrawFrame", 92),
    instant("DrawFrame", 200),

    // Main-thread tasks. The 50 ms one is mostly PARKED (tdur 5) — a stall, not work.
    complete("RunTask", 62, 4, { tdurMs: 4 }),
    complete("RunTask", 80, 8, { tdurMs: 8 }),
    complete("RunTask", 100, 50, { tdurMs: 5 }),

    // Decode: two real decodes of the SAME image (a re-decode), plus one cache lookup that ran no
    // codec. The `Decode Image` events are NESTED inside the tasks and must not be double counted.
    complete("ImageDecodeTask", 52, 30, {
      tid: WORKER_TID,
      args: { pixelRefId: 7 },
    }),
    complete("Decode Image", 53, 28, {
      tid: WORKER_TID,
      args: { imageType: "png" },
    }),
    complete("ImageDecodeTask", 90, 25, {
      tid: WORKER_TID,
      args: { pixelRefId: 7 },
    }),
    complete("Decode Image", 91, 24, {
      tid: WORKER_TID,
      args: { imageType: "png" },
    }),
    complete("SoftwareImageDecodeCache::DecodeImageIfNecessary", 120, 0.5, {
      tid: WORKER_TID,
      cat: "disabled-by-default-cc.debug",
      args: {
        key: "frame_key[content_id: 3,frame_index: 0]\ntype[SubrectAndScale]",
      },
    }),

    complete("RasterTask", 130, 6, {
      tid: WORKER_TID,
      cat: "cc,disabled-by-default-devtools.timeline",
      args: { tileData: { layerId: 32 } },
    }),

    complete("PaintImage", 61, 0.01, {
      args: {
        data: {
          url: ATLAS_URL,
          srcWidth: 4096,
          srcHeight: 4096,
          width: 96,
          height: 96,
        },
      },
    }),
    complete("PaintImage", 77, 0.01, {
      args: {
        data: {
          url: ATLAS_URL,
          srcWidth: 4096,
          srcHeight: 4096,
          width: 96,
          height: 96,
        },
      },
    }),

    instant("RenderSurfaceReasonCount", 61, {
      cat: "disabled-by-default-cc.debug",
      args: { kBlendModeMask: 2 },
    }),
    complete("CalculateRenderSurfaceLayerList", 61, 0.01, {
      tid: COMPOSITOR_TID,
      cat: "cc",
    }),
    complete("CalculateRenderSurfaceLayerList", 77, 0.01, {
      tid: COMPOSITOR_TID,
      cat: "cc",
    }),
    complete("CalculateRenderSurfaceLayerList", 93, 0.01, {
      tid: COMPOSITOR_TID,
      cat: "cc",
    }),
  ];
}
