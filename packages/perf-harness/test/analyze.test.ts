import { describe, expect, it } from "vitest";
import { analyzeTrace, TraceAnalysisError } from "../src/analyze";
import {
  COMPOSITOR_TID,
  complete,
  healthyTrace,
  instant,
  MAIN_TID,
  mark,
  threadMeta,
  WORKER_TID,
} from "./trace-fixtures";

const WINDOW_MS = 200;

describe("analyzeTrace", () => {
  const metrics = analyzeTrace(healthyTrace(), { windowMs: WINDOW_MS });

  it("derives initialRenderMs from activation, never from rAF", () => {
    // mount at 0 ms -> first ActivateLayerTree at/after the ready mark (60 ms).
    expect(metrics.initialRenderMs).toBe(60);
  });

  it("reports contentUpdateHz from ActivateLayerTree, and swap rate separately", () => {
    expect(metrics.activationCount).toBe(4);
    expect(metrics.contentUpdateHz).toBe(20); // 4 activations / 0.2 s
    // Four DISTINCT swap timestamps even though DrawFrame is emitted on two threads at 60 ms.
    expect(metrics.swapRateHz).toBe(20);
  });

  it("ignores activations from other renderer processes", () => {
    // The fixture puts two activations in a second pid at 70/71 ms. Counting them would report
    // 30 Hz for a page that only produced 4 frames.
    expect(metrics.activationCount).toBe(4);
  });

  it("measures main-thread busy time per activation interval", () => {
    // Intervals: [60,76) -> 4 ms, [76,92) -> 8 ms, [92,200) -> 50 ms.
    expect(metrics.frameCostMs).toEqual({ p50: 8, p95: 50, max: 50 });
  });

  it("measures activation gaps and counts the long ones", () => {
    expect(metrics.activationGapMs.count).toBe(3);
    expect(metrics.activationGapMs.p50).toBe(16);
    expect(metrics.activationGapMs.max).toBe(108);
    expect(metrics.activationGapMs.over100msCount).toBe(1);
  });

  it("separates computing from parked waiting via tdur/dur", () => {
    // Long tasks (>= 5 ms): 8 ms with tdur 8, 50 ms with tdur 5 => 13/58.
    expect(metrics.mainThreadCpuRatio).toBeCloseTo(13 / 58, 2);
    // Reported with its sample size, so the ratio can be interpreted rather than guessed at.
    expect(metrics.mainThreadCpuSamples).toBe(2);
  });

  it("keeps a severely parked ratio as a small positive number", () => {
    // 400 ms of wall against 1 ms of CPU: the "blocked on commit" shape. The value must survive as
    // 0.0025, not collapse to 0 — 0 would be indistinguishable from "never computed".
    const events = [
      ...threadMeta(),
      mark("scenario:mount", 0),
      mark("scenario:ready", 10),
      instant("ActivateLayerTree", 20),
      instant("ActivateLayerTree", 500),
      complete("RunTask", 30, 400, { tdurMs: 1 }),
    ];
    const parked = analyzeTrace(events, { windowMs: 600 });
    expect(parked.mainThreadCpuRatio).toBe(0.0025);
    expect(parked.mainThreadCpuSamples).toBe(1);
  });

  it("reports NULL, never a placeholder, when nothing meets the threshold", () => {
    // Any number here would be legal, plausible and wrong: a `1` reads as "fully compute-bound",
    // which is the opposite of what an idle main thread means. null cannot be misread.
    const events = [
      ...threadMeta(),
      mark("scenario:mount", 0),
      mark("scenario:ready", 10),
      instant("ActivateLayerTree", 20),
      instant("ActivateLayerTree", 40),
      complete("RunTask", 22, 0.4, { tdurMs: 0.4 }),
    ];
    const idle = analyzeTrace(events, { windowMs: 100 });
    expect(idle.mainThreadCpuRatio).toBeNull();
    expect(idle.mainThreadCpuSamples).toBe(0);
  });

  it("counts decode work without double-counting nested codec events", () => {
    // Two ImageDecodeTasks (each containing a Decode Image) + one cache lookup = 3 maximal events.
    // Summing all five would report 107.5 ms instead of the real 55.5 ms of decode wall.
    expect(metrics.decode.count).toBe(3);
    expect(metrics.decode.totalMs).toBe(55.5);
    expect(metrics.decode.maxMs).toBe(30);
    expect(metrics.decode.codecRuns).toBe(2);
    expect(metrics.decode.codecMs).toBe(52);
  });

  it("attributes decodes to images and reports re-decodes", () => {
    // pixelRef 7 (twice) and content_id 3 (once) => two distinct images, one re-decode.
    expect(metrics.decode.distinctImages).toBe(2);
    expect(metrics.decode.imageKey).toBe("contentId");
    expect(metrics.decode.redecodeCount).toBe(1);
    expect(metrics.decode.redecodeMs).toBe(24);
  });

  it("identifies the decode cache family", () => {
    expect(metrics.decode.cacheFamily).toBe("software");
  });

  it("reports no in-raster decode on a healthy trace", () => {
    expect(metrics.decode.inRasterCount).toBe(0);
    expect(metrics.decode.inRasterMs).toBe(0);
  });

  it("inventories painted source images", () => {
    expect(metrics.paint.count).toBe(2);
    expect(metrics.paint.distinctUrls).toBe(1);
    expect(metrics.paint.maxSourceMegapixels).toBeCloseTo(16.78, 1);
    // A 4096x4096 source painted into a 96x96 box: the cause class this harness hunts.
    expect(metrics.paint.maxSourceToPaintedRatio).toBeCloseTo(1820.44, 1);
  });

  it("sums raster and reports the render-surface census", () => {
    expect(metrics.rasterMs).toBe(6);
    expect(metrics.renderSurfaces).toBe(2);
    expect(metrics.renderSurfaceReasons).toEqual({ kBlendModeMask: 2 });
    expect(metrics.renderSurfaceListPasses).toBe(3);
  });
});

describe("analyzeTrace failure modes", () => {
  it("refuses to analyze a trace with no scenario marks", () => {
    const events = healthyTrace().filter(
      (event) =>
        event.name !== "scenario:mount" && event.name !== "scenario:ready",
    );
    expect(() => analyzeTrace(events, { windowMs: WINDOW_MS })).toThrow(
      TraceAnalysisError,
    );
  });

  it("refuses to analyze a trace where nothing activated after ready", () => {
    // A page that never presents would otherwise report a fabulous 0 ms initial render.
    const events = healthyTrace().filter(
      (event) => !(event.name === "ActivateLayerTree" && event.ts >= 50_000),
    );
    expect(() => analyzeTrace(events, { windowMs: WINDOW_MS })).toThrow(
      /never activated new content/,
    );
  });
});

describe("analyzeTrace on the GPU decode path", () => {
  // A phone with a real GPU emits GpuImageDecodeCache::* where SwiftShader emits
  // SoftwareImageDecodeCache::*. Matching only the software names would report zero decode.
  const events = [
    ...threadMeta(),
    mark("scenario:mount", 0),
    mark("scenario:ready", 10),
    instant("ActivateLayerTree", 20),
    instant("ActivateLayerTree", 40),
    complete("GpuImageDecodeCache::DecodeImageInTask", 12, 40, {
      tid: WORKER_TID,
      cat: "cc,benchmark",
      args: { key: "frame_key[content_id: 9,frame_index: 0]\ntype[Original]" },
    }),
    complete("Decode Image", 13, 38, {
      tid: WORKER_TID,
      args: { imageType: "png" },
    }),
  ];
  const metrics = analyzeTrace(events, { windowMs: 100 });

  it("sees GPU-path decodes and names the family", () => {
    expect(metrics.decode.cacheFamily).toBe("gpu");
    expect(metrics.decode.count).toBe(1);
    expect(metrics.decode.totalMs).toBe(40);
    expect(metrics.decode.distinctImages).toBe(1);
  });
});

describe("analyzeTrace in-raster decode detection", () => {
  const base = [
    ...threadMeta(),
    mark("scenario:mount", 0),
    mark("scenario:ready", 10),
    instant("ActivateLayerTree", 20),
    instant("ActivateLayerTree", 400),
  ];

  it("flags a codec run that happened INSIDE a raster task", () => {
    const events = [
      ...base,
      // Raster 100 -> 395 fully contains the 275 ms codec run at 112 -> 387.
      complete("RasterTask", 100, 295, {
        tid: WORKER_TID,
        cat: "cc,disabled-by-default-devtools.timeline",
      }),
      complete("SoftwareImageDecodeCache::DecodeImageIfNecessary", 110, 280, {
        tid: WORKER_TID,
        cat: "disabled-by-default-cc.debug",
        args: { key: "frame_key[content_id: 1,frame_index: 0]" },
      }),
      complete("Decode Image", 112, 275, {
        tid: WORKER_TID,
        args: { imageType: "png" },
      }),
    ];
    const metrics = analyzeTrace(events, { windowMs: 400 });
    expect(metrics.decode.inRasterCount).toBe(1);
    expect(metrics.decode.inRasterMs).toBe(275);
  });

  it("does NOT flag cheap in-raster cache lookups", () => {
    // Measured on a real capture: 1,484 in-raster DecodeImageIfNecessary calls totalling 2.7 ms,
    // all cache hits. Counting lookups would fire the hard-failure alarm on every healthy run.
    const events = [
      ...base,
      complete("RasterTask", 100, 5, {
        tid: WORKER_TID,
        cat: "cc,disabled-by-default-devtools.timeline",
      }),
      ...Array.from({ length: 20 }, (_, index) =>
        complete(
          "SoftwareImageDecodeCache::DecodeImageIfNecessary",
          100.1 + index * 0.2,
          0.002,
          {
            tid: WORKER_TID,
            cat: "disabled-by-default-cc.debug",
            args: { key: "frame_key[content_id: 1,frame_index: 0]" },
          },
        ),
      ),
    ];
    const metrics = analyzeTrace(events, { windowMs: 400 });
    expect(metrics.decode.count).toBe(20);
    expect(metrics.decode.inRasterCount).toBe(0);
  });
});

describe("analyzeTrace thread scoping", () => {
  it("only counts main-thread RunTask from CrRendererMain", () => {
    const events = [
      ...healthyTrace(),
      // A busy compositor thread must not be charged to the main thread's frame cost.
      complete("RunTask", 62, 12, { tid: COMPOSITOR_TID, tdurMs: 12 }),
      complete("RunTask", 63, 12, { tid: WORKER_TID, tdurMs: 12 }),
    ];
    const metrics = analyzeTrace(events, { windowMs: WINDOW_MS });
    expect(metrics.frameCostMs.p50).toBe(8);
    expect(metrics.frameCostMs.max).toBe(50);
    expect(MAIN_TID).not.toBe(COMPOSITOR_TID);
  });
});

describe("analyzeTrace watched-image attribution", () => {
  // `decode` is keyed by cc's opaque pixelRef/content ids, which carry no URL, and `paint.count`
  // lumps every image together. PaintImage is the ONLY url-bearing event in a Chrome trace, so a
  // scenario whose claim is about one specific image has no other way to pick it out.
  const events = [
    ...threadMeta(),
    mark("scenario:mount", 0),
    mark("scenario:ready", 10),
    instant("ActivateLayerTree", 20),
    instant("ActivateLayerTree", 40),
    // The initial paint, BEFORE the ready mark that opens the measured window — where a real run
    // puts it, and what makes an in-window record mean "re-painted".
    complete("PaintImage", 5, 0.01, {
      args: {
        data: {
          url: "http://x/fixture/background.png?v=1",
          srcWidth: 2520,
          srcHeight: 1080,
          width: 1280,
          height: 800,
        },
      },
    }),
    // Inside the window: a re-record of the display list with the big image still in it.
    complete("PaintImage", 30, 0.01, {
      args: {
        data: {
          url: "http://x/fixture/background.png?v=1",
          srcWidth: 2520,
          srcHeight: 1080,
          width: 1400,
          height: 900,
        },
      },
    }),
    complete("PaintImage", 31, 0.01, {
      args: {
        data: {
          url: "http://x/fixture/atlas.png?v=1",
          srcWidth: 4096,
          srcHeight: 4096,
          width: 96,
          height: 96,
        },
      },
    }),
  ];

  it("counts only the watched image, and only the in-window records separately", () => {
    const metrics = analyzeTrace(events, {
      windowMs: 100,
      watchImageUrl: "/fixture/background.png",
    });
    expect(metrics.watchedImage).toEqual({
      url: "/fixture/background.png",
      paintCount: 2,
      paintCountInWindow: 1,
      distinctPaintedSizes: 2,
      sourceMegapixels: 2.72,
    });
    // The atlas record is still in the run-wide inventory; only the watched block excludes it.
    expect(metrics.paint.count).toBe(3);
    expect(metrics.paint.distinctUrls).toBe(2);
  });

  it("is absent entirely when no scenario asked for it", () => {
    expect(
      analyzeTrace(events, { windowMs: 100 }).watchedImage,
    ).toBeUndefined();
  });
});
