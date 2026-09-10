// The ONE shared analyzer. A pure function over parsed trace events (plus the page-reported window
// length and the JS-visible observations), so every metric in the contract is unit-testable against
// hand-authored event arrays without a browser anywhere near the test.
//
// EVENT NAMES ARE NOT GUESSED. They were taken from `perf --dump-trace-names` run against a real
// capture on the Chrome in this environment (Chrome for Testing 148.0.7778.56); see
// docs/perf-harness.md for the observed histogram and the names that differed from expectation.
// Where a name could plausibly drift, the analyzer accepts a small family and picks the MAXIMAL
// events (containment stack), so a renamed inner event can never double-count.
//
// The two rules this file exists to enforce:
//   1. Swap rate is not fps. `DrawFrame` is reported as `swapRateHz` and is explicitly labelled as
//      NOT the frame rate; `ActivateLayerTree` — new content actually activated — is.
//   2. Decode is invisible to JS. It runs on decode worker threads and never shows up in a rAF
//      timer, so it has to come out of the trace or it does not get measured at all.

import type { MemoryDumpCrossCheck } from "./memory-dump";
import type { TraceEvent } from "./trace";

// --- observed on Chrome 148 (see docs/perf-harness.md) ------------------------------------------
/** ph "I", cat disabled-by-default-devtools.timeline.frame, thread Renderer/Compositor. */
const ACTIVATE = "ActivateLayerTree";
/** ph "I", same cat/thread. Swap cadence — deliberately NOT reported as a frame rate. */
const DRAW_FRAME = "DrawFrame";
/** ph "X", cat disabled-by-default-devtools.timeline, thread CrRendererMain (and every other thread). */
const RUN_TASK = "RunTask";
/** ph "X", cat cc,disabled-by-default-devtools.timeline, raster worker threads. */
const RASTER_TASK = "RasterTask";
/**
 * Decode work items, matched across BOTH cc decode-cache families.
 *
 * THIS IS THE MOST PORTABILITY-CRITICAL MATCHER IN THE FILE. Headless/SwiftShader (this box) runs the
 * SOFTWARE path and emits `SoftwareImageDecodeCache::*`; a real phone with a GPU runs the GPU path and
 * emits `GpuImageDecodeCache::*` instead. An analyzer that matched only the software names would
 * report ZERO decode on the phone — and "the phone does no image decode" is precisely the wrong
 * conclusion to hand a device workstream. `decodeCacheFamily` in the output records which family was
 * actually seen so a silent zero is impossible to mistake for a good result.
 *
 * `*ImageDecodeCache::DecodeImageInTask` is cat `cc,benchmark`, i.e. present WITHOUT the
 * `disabled-by-default-cc.debug` category, which is what makes family detection cheap.
 */
const DECODE_TASK_RE =
  /^(?:ImageDecodeTask|ImageDecodeTaskImpl|Decode Image|(?:Software|Gpu)ImageDecodeCache::(?:DecodeImageInTask|DecodeImageIfNecessary))$/;
/** The actual codec invocations, nested inside a decode task. */
const CODEC_RE = /^(?:Decode Image|ImageFrameGenerator::decode)$/;
const CACHE_FAMILY_RE = /^(Software|Gpu)ImageDecodeCache::/;
/** ph "X", cat disabled-by-default-devtools.timeline, CrRendererMain. args.data.url is the source image. */
const PAINT_IMAGE = "PaintImage";
/** cc's render-surface census: one instant PER REASON per draw. Absent when there are no reasons. */
const RENDER_SURFACE_REASONS = "RenderSurfaceReasonCount";
/** Always-on `cc` event proving the render-surface census actually ran (evidence for a 0 reading). */
const RENDER_SURFACE_PASS = "CalculateRenderSurfaceLayerList";

const MOUNT_MARK = "scenario:mount";
const READY_MARK = "scenario:ready";

/**
 * Every name family the analyzer depends on, in one exported list, so `--dump-trace-names` can
 * answer the only question that matters on a Chrome (or a phone) nobody has measured before: DO THE
 * MATCHERS STILL MATCH? See `matcherProbe`.
 */
export const TRACE_MATCHERS: {
  role: string;
  expected: string;
  test: (name: string) => boolean;
  /** Metrics that read ZERO — not "fast" — when nothing matches. */
  breaks: string;
}[] = [
  {
    role: "activation",
    expected: ACTIVATE,
    test: (name) => name === ACTIVATE,
    breaks: "contentUpdateHz, initialRenderMs, frameCostMs, activationGapMs",
  },
  {
    role: "swap",
    expected: DRAW_FRAME,
    test: (name) => name === DRAW_FRAME,
    breaks: "swapRateHz",
  },
  {
    role: "main-thread task",
    expected: RUN_TASK,
    test: (name) => name === RUN_TASK,
    breaks: "mainThreadBusyMs, mainThreadCpuRatio, frameCostMs",
  },
  {
    role: "raster",
    expected: RASTER_TASK,
    test: (name) => name === RASTER_TASK,
    breaks: "rasterMs, decode.inRasterCount",
  },
  {
    role: "decode task",
    expected: String(DECODE_TASK_RE),
    test: (name) => DECODE_TASK_RE.test(name),
    breaks: "decode.count, decode.totalMs, decode.distinctImages",
  },
  {
    role: "codec run",
    expected: String(CODEC_RE),
    test: (name) => CODEC_RE.test(name),
    breaks: "decode.codecRuns, decode.redecodeCount, decode.inRasterCount",
  },
  {
    role: "decode cache family",
    expected: String(CACHE_FAMILY_RE),
    test: (name) => CACHE_FAMILY_RE.test(name),
    breaks: "decode.cacheFamily (software vs gpu)",
  },
  {
    role: "paint",
    expected: PAINT_IMAGE,
    test: (name) => name === PAINT_IMAGE,
    breaks: "paint.*, the source:painted ratio",
  },
  {
    role: "scenario marks",
    expected: `${MOUNT_MARK} / ${READY_MARK}`,
    test: (name) => name === MOUNT_MARK || name === READY_MARK,
    breaks: "EVERYTHING — the analyzer cannot anchor its window",
  },
];

/** Names that look like they belong to a matched family but are not matched by any of them. */
const NEAR_MISS_RE =
  /decode|raster|activate|drawframe|draw frame|paintimage|swap|presenta/i;

export interface Stat {
  p50: number;
  p95: number;
  max: number;
}

export interface DecodeMetrics {
  /** Decode work items that ran (maximal decode-family events on decode threads). */
  count: number;
  /** Wall time those decode tasks occupied on decode worker threads. */
  totalMs: number;
  maxMs: number;
  /** Distinct images decoded, keyed by whatever identity the trace carries (see `imageKey`). */
  distinctImages: number;
  /**
   * CODEC RUNS beyond the first for the same image. A decode task that hits the discardable cache
   * costs ~0 and is not a redecode; a second codec run of the same source image is the hazard.
   */
  redecodeCount: number;
  redecodeMs: number;
  /**
   * CODEC RUNS that ran INSIDE a raster task. Means the image did not fit the discardable decode
   * cache, so the decode is re-paid on every re-raster, forever. A HARD FAILURE, not a slow number.
   *
   * Deliberately counted on codec runs, not on decode-cache lookups: a cache LOOKUP inside raster is
   * normal and costs ~0 (measured: 1484 in-raster `DecodeImageIfNecessary` calls totalling 2.7 ms),
   * so counting lookups would fire this alarm on every healthy run and train everyone to ignore it.
   */
  inRasterCount: number;
  inRasterMs: number;
  /** Actual codec invocations (the subset of decode work that really ran the PNG/JPEG decoder). */
  codecRuns: number;
  codecMs: number;
  /** Which trace field the image identity came from: "pixelRefId" | "contentId" | "url" | "none". */
  imageKey: string;
  /**
   * Which cc decode-cache family the trace showed: "software" (SwiftShader / headless) or "gpu" (a
   * real GPU, e.g. the phone). "unknown" means NO decode-cache event matched, which almost always
   * means the names drifted — treat a zero decode reading in that state as unmeasured, not as fast.
   */
  cacheFamily: "software" | "gpu" | "mixed" | "unknown";
  /**
   * Whether the scenario paints images AT ALL — the one thing that separates a TRUE zero from a
   * broken decode matcher, and the reason it is written into the report rather than known only by
   * the runner.
   *
   * Every scenario up to S8 mounts an atlas page, so `decode.count === 0` could only mean the cc
   * event names had drifted, and the validator rejects it outright. S9 `text-render` paints no
   * images at all: its glyphs are rasterized by the font stack, which emits no decode events, so a
   * zero there is the honest reading. A consumer validating a report on disk cannot know which
   * situation it is looking at unless the report says, so it says.
   *
   * Absent means `true` — every report written before this field existed came from a scenario that
   * really did paint images.
   */
  imagesExpected?: boolean;
}

export interface PaintMetrics {
  /** PaintImage records on the main thread: how often a display list referenced a source image. */
  count: number;
  distinctUrls: number;
  /** Largest source image referenced, in megapixels — the cause class this harness hunts. */
  maxSourceMegapixels: number;
  /** Worst ratio of source-image pixels to painted pixels across all PaintImage records. */
  maxSourceToPaintedRatio: number;
}

/**
 * Paint attribution for ONE image, selected by a URL substring.
 *
 * Run-wide totals cannot answer "was THAT image re-painted?": `decode` is keyed by cc's opaque
 * pixelRef/content ids, which carry no URL, and `paint.count` lumps every image together. `PaintImage`
 * is the only url-bearing event in the trace, so a scenario whose claim is about one specific image
 * (S4: "the 2520x1080 background is not re-painted while unrelated content churns") has to be able to
 * pick that image out by name.
 */
export interface WatchedImageMetrics {
  /** The URL substring that selected it. */
  url: string;
  /** PaintImage records referencing it, anywhere in the capture. */
  paintCount: number;
  /**
   * ...and the subset INSIDE the measured window. This is the number that matters: records after the
   * initial paint mean the display list was re-recorded, i.e. the image was re-painted.
   */
  paintCountInWindow: number;
  /** Distinct painted box sizes. Each one is a separate scaled decode the browser may have to keep. */
  distinctPaintedSizes: number;
  sourceMegapixels: number;
}

/**
 * Per-thread CPU over the measured window.
 *
 * `process` is the trace's own `process_name` ("Renderer", "Browser", "GPU Process"); `thread` is its
 * `thread_name`. Rows are folded by that PAIR, not by `pid:tid`, so a browser hosting several renderer
 * processes (a phone with a hundred background tabs does) yields one `Renderer/CrRendererMain` row with
 * `instances` saying how many OS threads it summed.
 */
export interface ThreadCpu {
  process: string;
  thread: string;
  /** Sum of `tdur` on MAXIMAL events, clamped to the window. A LOWER BOUND — see `CpuMetrics`. */
  cpuMs: number;
  /** Wall time those maximal events occupied, clamped to the window. */
  wallMs: number;
  /** `cpuMs / windowMs`: the fraction of ONE core this row used. */
  coreRatio: number;
  /** Distinct OS threads (`pid:tid`) folded into this row. */
  instances: number;
}

export interface ProcessCpu {
  cpuMs: number;
  wallMs: number;
  coreRatio: number;
  /** Distinct OS threads in this process that had traced work in the window. */
  threads: number;
  /** Distinct pids carrying this process name (a browser can host many renderers). */
  processes: number;
}

/**
 * CPU across EVERY traced process — renderer, browser and GPU — over the measured window.
 *
 * THE CAVEAT THAT MAKES THIS HONEST: `tdur` is thread CPU time recorded INSIDE a traced task. Work a
 * process does outside any traced task — anything in a category this capture did not enable, plus
 * every process Chrome did not instrument — contributes ZERO here. So `totalCpuMs` is a **lower
 * bound on the CPU those processes really burned**, not whole-process CPU, and `totalCoreRatio` is
 * not a `top`-style CPU%. Presenting it as one would be the same class of dishonesty as reporting the
 * compositor swap rate as fps, which this harness explicitly refuses to do.
 *
 * `cpuCoverage` is what tells you how bad the under-count is: it is the fraction of the summed
 * top-level WALL time that carried a `tdur` at all. A row with high wall and low coverage is a thread
 * whose CPU is simply unknown, not a thread that was idle.
 *
 * The one thing it IS good for: attribution. Which process, and which thread inside it, holds the
 * traced work — and that is exactly the question `mainThreadCpuRatio` (renderer main only) cannot
 * answer.
 */
export interface CpuMetrics {
  windowMs: number;
  totalCpuMs: number;
  /** `totalCpuMs / windowMs`. Threads run in PARALLEL, so this legitimately exceeds 1. */
  totalCoreRatio: number;
  /** Fraction of summed top-level wall time that carried a `tdur`. Below ~0.5, read cpu as unknown. */
  cpuCoverage: number;
  /** Keyed `renderer` | `browser` | `gpu` | a slug of any other `process_name`. */
  byProcess: Record<string, ProcessCpu>;
  /** Sorted by `cpuMs` descending. */
  byThread: ThreadCpu[];
}

/**
 * GPU-process op attribution, bucketed by name.
 *
 * Buckets are name-matched (regexes ported from couch-coop's `scripts/analyze-gpu-trace.mjs`), and
 * `topUnbucketedOps` always prints what landed in `other`, so the taxonomy can never hide a cost.
 * The reference script's `texture lifetime` bucket is deliberately NOT part of this taxonomy — those
 * ops fall into `other` and show up by name in `topUnbucketedOps`.
 */
export interface GpuBuckets {
  uploadDecode: number;
  rasterPlayback: number;
  skiaPrepare: number;
  skiaExecute: number;
  presentSwap: number;
  clear: number;
  schedulerIpc: number;
  other: number;
}

export interface GpuOp {
  name: string;
  selfMs: number;
  count: number;
}

/** `dumpsys gfxinfo <chrome package>`, sampled around the measured window. Device runs only. */
export interface GfxInfoMetrics {
  totalFrames: number | null;
  jankPct: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  slowBitmapUploads: number | null;
  slowIssueDrawCommands: number | null;
}

/**
 * The HWUI block on a run that is not Android. EVERY FIELD NULL = NOT MEASURED, and the table renders
 * an em dash for each. Zeroing it would put "Chrome's Android View hierarchy dropped no frames" on
 * the record of a run that had no Android View hierarchy.
 */
export function gfxInfoNotMeasured(): GfxInfoMetrics {
  return {
    totalFrames: null,
    jankPct: null,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    slowBitmapUploads: null,
    slowIssueDrawCommands: null,
  };
}

/**
 * WHICH INSTRUMENT produced `gpuMemoryBytes`. Two different rungs of the same ladder, and a reader
 * must never mistake one's byte for the other's:
 *
 * `dumpsys-gfxinfo` — Android, `Total GPU memory usage` for the whole Chrome package (HWUI's view).
 * `nvidia-smi`      — desktop NVIDIA, the driver's per-process figure for the GPU process of the
 *                     Chrome this run launched. NOT the box-wide `<fb_memory_usage><used>`.
 */
export type GpuMemorySource = "dumpsys-gfxinfo" | "nvidia-smi";

/** The DRIVER's number for this process — the one GPU-memory figure here that nothing self-counted. */
export interface GpuDeviceMetrics {
  /** `null` only when the block carries nothing but the `--memory-dump` cross-check. */
  source: GpuMemorySource | null;
  /** Android-only. Every field is `null` on a desktop run: NOT MEASURED, not zero. */
  gfxinfo: GfxInfoMetrics;
  /** Absolute reading AFTER the window: what the driver says the process holds. */
  gpuMemoryBytes: number | null;
  /**
   * After minus before, across the same bracket.
   *
   * WHICH ONE IS MEANINGFUL depends on the question. The ABSOLUTE is the honest total but carries
   * Chrome's fixed cost — a headed GPU process holds its framebuffers, UI tiles and shader cache
   * before the page mounts anything — so it cannot answer "what did this atlas cost". The DELTA can:
   * the bracket covers mount + the measured window, so it is the memory THIS scenario added. It is
   * also the fragile one — the driver reports in whole MiB and frees lazily, so a delta under ~1 MiB
   * is below the instrument, and a negative delta means the previous repeat's memory was reclaimed
   * inside this one. Both are published; neither is derived from the other.
   */
  gpuMemoryDeltaBytes: number | null;
  /** One line naming exactly what the bytes were attributed to. The audit trail for the number. */
  attribution: string | null;
  /**
   * `--memory-dump` only: Chrome's OWN allocator totals over the same bracket, as a cross-check.
   * Self-counted, and where it disagrees with the driver number above, the driver number is the truth.
   */
  memoryDump: MemoryDumpCrossCheck | null;
}

/**
 * GPU-side cost. `browser-render` only — a producer walk or a wire-payload measurement has no GPU.
 *
 * **Comparable WITHIN an environment only**, exactly like `layerCount` and `renderSurfaces`: this box
 * is SwiftShader and has no hardware GPU at all, so a bucket total here and a bucket total on the
 * phone are not two readings of the same thing.
 */
export interface GpuMetrics {
  /**
   * Whether the GPU trace categories were collected AND a GPU process was found. `false` means NOT
   * MEASURED (e.g. `--no-gpu`), never "the GPU did nothing".
   */
  available: boolean;
  /** Short label from CDP `SystemInfo.getInfo`, e.g. `Mali-G615 MC2 (ANGLE)` or `swiftshader`. */
  hardware: string;
  /** The raw renderer string behind `hardware`, driver version included. */
  hardwareDetail: string;
  /** Sum of `tdur` on maximal events across GPU-process threads. Same LOWER-BOUND caveat as `cpu`. */
  processCpuMs: number;
  processWallMs: number;
  /** GPU-process threads that had traced work in the window. */
  threads: number;
  /**
   * `false` when the GPU threads carry nothing but `RunTask` — i.e. the trace lacks the gpu/viz/skia
   * categories, so op-level cost is UNKNOWN rather than absent.
   */
  opDetail: boolean;
  byBucket: GpuBuckets;
  topUnbucketedOps: GpuOp[];
  /** Device-only supplement; `null` on `ci`. */
  device: GpuDeviceMetrics | null;
}

export interface TraceMetrics {
  initialRenderMs: number;
  frameCostMs: Stat;
  contentUpdateHz: number;
  activationGapMs: Stat & { over100msCount: number; count: number };
  /** Compositor swap cadence. NOT the frame rate — it swaps happily while content is frozen. */
  swapRateHz: number;
  decode: DecodeMetrics;
  paint: PaintMetrics;
  rasterMs: number;
  renderSurfaces: number;
  renderSurfaceReasons: Record<string, number>;
  renderSurfaceListPasses: number;
  /**
   * `tdur/dur` over qualifying long tasks. A SMALL POSITIVE value means the main thread was parked
   * (blocked on commit/raster/decode) rather than computing.
   *
   * `null` when NO task met the long-task threshold — i.e. not measured. It is deliberately not a
   * number: any placeholder here is legal, plausible and WRONG. A `1` reads as "fully compute-bound"
   * and had been doing exactly that for the region-blob arm, which is the opposite of the truth.
   * `null` cannot be misread. Consumers must not coerce it to 0 or 1.
   */
  mainThreadCpuRatio: number | null;
  /** How many tasks met the long-task threshold and carried `tdur`, i.e. the ratio's sample size. */
  mainThreadCpuSamples: number;
  mainThreadBusyMs: number;
  windowMs: number;
  activationCount: number;
  /**
   * CPU across EVERY traced process, not just the page's renderer.
   *
   * This is the ONE block whose scope is deliberately wider than the rest of this file: every other
   * metric is filtered to the renderer process that emitted the scenario marks (see `analyzeTrace`),
   * because counting another renderer's activations would inflate the honest frame rate. Browser- and
   * GPU-process CPU has no such hazard — it is exactly what the renderer-scoped numbers cannot see.
   */
  cpu: CpuMetrics;
  /** GPU-side cost. `available: false` when the GPU categories were not collected. */
  gpu: GpuMetrics;
  /** Present only when `AnalyzeOptions.watchImageUrl` was supplied. */
  watchedImage?: WatchedImageMetrics;
}

export interface AnalyzeOptions {
  /** Measured-window length in ms, as reported by the page (marks anchor it in trace time). */
  windowMs: number;
  /** Tasks at or above this duration count towards `mainThreadCpuRatio` (default 5ms). */
  longTaskThresholdMs?: number;
  /** Activation gaps above this are counted separately (default 100ms). */
  gapThresholdMs?: number;
  /** URL substring to attribute PaintImage records to (see `WatchedImageMetrics`). */
  watchImageUrl?: string;
  /** See {@link DecodeMetrics.imagesExpected}. Defaults to true. */
  imagesExpected?: boolean;
  /**
   * What the RUNNER knows about the GPU that the trace cannot say: whether the GPU categories were
   * collected at all, which device CDP reported, and the phone's `dumpsys gfxinfo` supplement.
   */
  gpu?: {
    /** `false` (the `--no-gpu` case) yields `gpu.available: false` and an all-zero block. */
    collected: boolean;
    hardware?: string;
    hardwareDetail?: string;
    device?: GpuDeviceMetrics | null;
  };
}

export interface ThreadIndex {
  name: Map<string, string>;
  process: Map<number, string>;
}

export function buildThreadIndex(events: TraceEvent[]): ThreadIndex {
  const name = new Map<string, string>();
  const process = new Map<number, string>();
  for (const event of events) {
    if (event.cat !== "__metadata") {
      continue;
    }
    const args = event.args as { name?: string } | undefined;
    if (event.name === "thread_name") {
      name.set(`${event.pid}:${event.tid}`, args?.name ?? "");
    } else if (event.name === "process_name") {
      process.set(event.pid, args?.name ?? "");
    }
  }
  return { name, process };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

function stat(values: number[]): Stat {
  return {
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(values.length ? Math.max(...values) : 0),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Maximal (top-level) events among a set, per thread. Chrome's X events on one thread are strictly
 * nested or sequential, so sorting by (ts asc, dur desc) and skipping anything that starts before the
 * current maximal event ends yields exactly the outermost events — the standard containment trick.
 */
function maximalPerThread(events: TraceEvent[]): TraceEvent[] {
  const byThread = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`;
    const list = byThread.get(key);
    if (list) {
      list.push(event);
    } else {
      byThread.set(key, [event]);
    }
  }
  const out: TraceEvent[] = [];
  for (const list of byThread.values()) {
    list.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
    let end = -Infinity;
    for (const event of list) {
      if (event.ts < end) {
        continue;
      }
      end = event.ts + (event.dur ?? 0);
      out.push(event);
    }
  }
  return out;
}

function contains(outer: TraceEvent, inner: TraceEvent): boolean {
  return (
    outer.pid === inner.pid &&
    outer.tid === inner.tid &&
    outer.ts <= inner.ts &&
    outer.ts + (outer.dur ?? 0) >= inner.ts + (inner.dur ?? 0)
  );
}

function overlapUs(event: TraceEvent, from: number, to: number): number {
  const start = Math.max(event.ts, from);
  const end = Math.min(event.ts + (event.dur ?? 0), to);
  return Math.max(0, end - start);
}

/**
 * Image identity for a decode event, in preference order. `pixelRefId` is what `ImageDecodeTask`
 * carries; the decode-cache events instead carry a multi-line `key` whose `frame_key[content_id: N]`
 * is the stable per-source-image id (the rest of the key is per-scale, so keying on the whole string
 * would count every scale of one image as a different image).
 */
function imageKeyOf(event: TraceEvent): string | undefined {
  const args = event.args as
    | {
        pixelRefId?: number;
        key?: string;
        data?: { url?: string };
        imageUrl?: string;
      }
    | undefined;
  if (args?.pixelRefId != null) {
    return `pixelRef:${args.pixelRefId}`;
  }
  if (typeof args?.key === "string") {
    const contentId = /content_id:\s*(\d+)/.exec(args.key)?.[1];
    if (contentId) {
      return `contentId:${contentId}`;
    }
  }
  if (args?.data?.url) {
    return `url:${args.data.url}`;
  }
  if (args?.imageUrl) {
    return `url:${args.imageUrl}`;
  }
  return undefined;
}

/**
 * `process_name` -> the key `cpu.byProcess` is written under. Only the three that matter are
 * normalised; anything else keeps a slug of its own name rather than being lumped into an "other"
 * bucket, because a utility process burning CPU is a finding, not noise to be hidden.
 */
const PROCESS_KEYS: [RegExp, string][] = [
  [/^Renderer$/i, "renderer"],
  [/^Browser$/i, "browser"],
  [/GPU Process/i, "gpu"],
];

export function processKeyOf(name: string): string {
  for (const [pattern, key] of PROCESS_KEYS) {
    if (pattern.test(name)) {
      return key;
    }
  }
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

const GPU_PROCESS_RE = /GPU Process/i;

/** X events per `pid:tid`, keeping only those that intersect the window. */
function completeEventsPerThread(
  events: TraceEvent[],
  from: number,
  to: number,
): Map<string, TraceEvent[]> {
  const byThread = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.ph !== "X") {
      continue;
    }
    const dur = event.dur ?? 0;
    if (event.ts + dur < from || event.ts > to) {
      continue;
    }
    const key = `${event.pid}:${event.tid}`;
    const list = byThread.get(key);
    if (list) {
      list.push(event);
    } else {
      byThread.set(key, [event]);
    }
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  }
  return byThread;
}

interface ThreadBusy {
  wallUs: number;
  cpuUs: number;
  /** Wall time of the maximal events that actually carried a `tdur`. */
  knownUs: number;
}

/**
 * Wall and CPU for one thread over `[from, to)`, from its MAXIMAL (top-level) events only.
 *
 * Nested children are excluded — their time is already inside the parent — which is what makes this a
 * true "is this thread pinned?" number rather than a nesting-depth-weighted sum. An event straddling
 * a window edge contributes its `tdur` scaled by the clamped fraction; that is an approximation
 * (CPU is not uniformly distributed inside a task) and it only ever touches the two events at the
 * window boundary. Technique borrowed from couch-coop's `scripts/analyze-gpu-trace.mjs`.
 */
function threadBusy(
  sorted: TraceEvent[],
  from: number,
  to: number,
): ThreadBusy {
  let wallUs = 0;
  let cpuUs = 0;
  let knownUs = 0;
  let end = -Infinity;
  for (const event of sorted) {
    if (event.ts < end) {
      continue;
    }
    const dur = event.dur ?? 0;
    end = event.ts + dur;
    const overlap = overlapUs(event, from, to);
    if (overlap <= 0) {
      continue;
    }
    wallUs += overlap;
    if (typeof event.tdur === "number" && dur > 0) {
      cpuUs += event.tdur * (overlap / dur);
      knownUs += overlap;
    }
  }
  return { wallUs, cpuUs, knownUs };
}

/**
 * CPU across every traced process. **The renderer-pid filter is deliberately NOT applied here** —
 * discarding browser- and GPU-process events is exactly what made this cost invisible before.
 */
export function computeCpu(
  events: TraceEvent[],
  threads: ThreadIndex,
  options: { windowStart: number; windowEnd: number; windowMs: number },
): CpuMetrics {
  const { windowStart, windowEnd, windowMs } = options;
  const perThread = completeEventsPerThread(events, windowStart, windowEnd);

  interface Row {
    process: string;
    thread: string;
    wallUs: number;
    cpuUs: number;
    knownUs: number;
    instances: number;
    pids: Set<number>;
  }
  const rows = new Map<string, Row>();
  for (const [key, sorted] of perThread) {
    const busy = threadBusy(sorted, windowStart, windowEnd);
    if (busy.wallUs <= 0) {
      continue;
    }
    const pid = sorted[0].pid;
    const processName = threads.process.get(pid) || `pid ${pid}`;
    const threadName = threads.name.get(key) || `tid ${sorted[0].tid}`;
    const rowKey = `${processName}\u0000${threadName}`;
    const row = rows.get(rowKey) ?? {
      process: processName,
      thread: threadName,
      wallUs: 0,
      cpuUs: 0,
      knownUs: 0,
      instances: 0,
      pids: new Set<number>(),
    };
    row.wallUs += busy.wallUs;
    row.cpuUs += busy.cpuUs;
    row.knownUs += busy.knownUs;
    row.instances++;
    row.pids.add(pid);
    rows.set(rowKey, row);
  }

  const windowUs = Math.max(1, windowMs * 1000);
  const byThread: ThreadCpu[] = [...rows.values()]
    .map((row) => ({
      process: row.process,
      thread: row.thread,
      cpuMs: round(row.cpuUs / 1000),
      wallMs: round(row.wallUs / 1000),
      coreRatio: Number((row.cpuUs / windowUs).toPrecision(4)),
      instances: row.instances,
    }))
    .sort((a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs);

  const processes = new Map<
    string,
    { cpuUs: number; wallUs: number; threads: number; pids: Set<number> }
  >();
  for (const row of rows.values()) {
    const key = processKeyOf(row.process);
    const entry = processes.get(key) ?? {
      cpuUs: 0,
      wallUs: 0,
      threads: 0,
      pids: new Set<number>(),
    };
    entry.cpuUs += row.cpuUs;
    entry.wallUs += row.wallUs;
    entry.threads += row.instances;
    for (const pid of row.pids) {
      entry.pids.add(pid);
    }
    processes.set(key, entry);
  }
  const byProcess: Record<string, ProcessCpu> = {};
  for (const [key, entry] of [...processes.entries()].sort(
    (a, b) => b[1].cpuUs - a[1].cpuUs,
  )) {
    byProcess[key] = {
      cpuMs: round(entry.cpuUs / 1000),
      wallMs: round(entry.wallUs / 1000),
      coreRatio: Number((entry.cpuUs / windowUs).toPrecision(4)),
      threads: entry.threads,
      processes: entry.pids.size,
    };
  }

  let totalCpuUs = 0;
  let totalWallUs = 0;
  let totalKnownUs = 0;
  for (const row of rows.values()) {
    totalCpuUs += row.cpuUs;
    totalWallUs += row.wallUs;
    totalKnownUs += row.knownUs;
  }
  return {
    windowMs: round(windowMs),
    totalCpuMs: round(totalCpuUs / 1000),
    totalCoreRatio: Number((totalCpuUs / windowUs).toPrecision(4)),
    cpuCoverage:
      totalWallUs > 0 ? Number((totalKnownUs / totalWallUs).toPrecision(4)) : 0,
    byProcess,
    byThread,
  };
}

/**
 * GPU-process op buckets. Ported from couch-coop's `scripts/analyze-gpu-trace.mjs` (GPU_BUCKETS).
 * ORDER MATTERS — first match wins.
 */
const GPU_BUCKETS: [keyof GpuBuckets, RegExp][] = [
  [
    "uploadDecode",
    /UploadImage|DecodeImage|Decode LazyPixelRef|Decode Image|ImageUploadTask|ImageDecodeTask|createBackendTexture|TexImage|texSubImage/i,
  ],
  [
    "rasterPlayback",
    /RasterCHROMIUM|GpuRasterBuffer::Playback|RasterizerTaskImpl|RasterTask|PaintOpBuffer/i,
  ],
  [
    "skiaPrepare",
    /onPrepareDraws|onPrePrepareDraws|OpsTask::onPrepare|OpsTask::onPrePrepare|onCombineIfPossible|addDrawOp|drawFilledQuad|drawTextureSet|drawEdgeAAQuad|drawPaint/i,
  ],
  [
    "skiaExecute",
    /OpsTask::onExecute|executeFlushInfo|GrDrawingManager::flush|flushSurfaces|FlushGpuTasks|FlushOutputSurface|DrawRenderPass|FinishPaintRenderPass/i,
  ],
  [
    "presentSwap",
    /SwapBuffers|ScheduleOverlays|SurfaceControlTransaction|presentation_feedback|CheckPendingPresentationCallbacks|OnTransactionAck|Extend_VSync/i,
  ],
  ["clear", /SurfaceFillContext::clear|clearAll|^Clear$/i],
  [
    "schedulerIpc",
    /Scheduler::|ThreadControllerImpl::RunTask|^RunTask$|GpuChannel|CommandBuffer|SyncToken|mojo|SimpleWatcher|EpollEvent|Graphics\.Pipeline/i,
  ],
];

export function gpuBucketOf(name: string): keyof GpuBuckets {
  for (const [bucket, pattern] of GPU_BUCKETS) {
    if (pattern.test(name)) {
      return bucket;
    }
  }
  return "other";
}

const ONLY_SCHEDULING_RE =
  /^(?:RunTask|GPUTask|ThreadControllerImpl::RunTask)$/;

/** Exact self-time per op name on one thread, via a containment stack. */
function selfTimeByName(
  sorted: TraceEvent[],
  from: number,
  to: number,
  into: Map<string, { us: number; count: number }>,
): void {
  const stack: {
    name: string;
    end: number;
    dur: number;
    childDur: number;
    inWindow: boolean;
  }[] = [];
  const finish = (frame: (typeof stack)[number]): void => {
    if (!frame.inWindow) {
      return;
    }
    const entry = into.get(frame.name) ?? { us: 0, count: 0 };
    entry.us += frame.dur - frame.childDur;
    entry.count++;
    into.set(frame.name, entry);
  };
  for (const event of sorted) {
    const dur = event.dur ?? 0;
    while (stack.length > 0 && stack[stack.length - 1].end <= event.ts) {
      const frame = stack.pop();
      if (frame) {
        finish(frame);
      }
    }
    if (stack.length > 0) {
      stack[stack.length - 1].childDur += dur;
    }
    stack.push({
      name: event.name,
      end: event.ts + dur,
      dur,
      childDur: 0,
      inWindow: event.ts >= from && event.ts <= to,
    });
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame) {
      finish(frame);
    }
  }
}

const EMPTY_BUCKETS = (): GpuBuckets => ({
  uploadDecode: 0,
  rasterPlayback: 0,
  skiaPrepare: 0,
  skiaExecute: 0,
  presentSwap: 0,
  clear: 0,
  schedulerIpc: 0,
  other: 0,
});

export function computeGpu(
  events: TraceEvent[],
  threads: ThreadIndex,
  options: {
    windowStart: number;
    windowEnd: number;
    gpu?: AnalyzeOptions["gpu"];
    topUnbucketed?: number;
  },
): GpuMetrics {
  const { windowStart, windowEnd, gpu, topUnbucketed = 10 } = options;
  const hardware = gpu?.hardware ?? "unknown";
  const hardwareDetail = gpu?.hardwareDetail ?? "";
  const device = gpu?.device ?? null;
  const blank: GpuMetrics = {
    available: false,
    hardware,
    hardwareDetail,
    processCpuMs: 0,
    processWallMs: 0,
    threads: 0,
    opDetail: false,
    byBucket: EMPTY_BUCKETS(),
    topUnbucketedOps: [],
    device,
  };
  // `--no-gpu`: the categories were never collected, so the GPU threads carry nothing but scheduling
  // noise. Reporting a bucket breakdown from that would be reporting an artefact of the capture.
  if (!gpu?.collected) {
    return blank;
  }

  const perThread = completeEventsPerThread(events, windowStart, windowEnd);
  const self = new Map<string, { us: number; count: number }>();
  let cpuUs = 0;
  let wallUs = 0;
  let threadCount = 0;
  for (const sorted of perThread.values()) {
    const processName = threads.process.get(sorted[0].pid) ?? "";
    if (!GPU_PROCESS_RE.test(processName)) {
      continue;
    }
    const busy = threadBusy(sorted, windowStart, windowEnd);
    if (busy.wallUs <= 0) {
      continue;
    }
    threadCount++;
    cpuUs += busy.cpuUs;
    wallUs += busy.wallUs;
    selfTimeByName(sorted, windowStart, windowEnd, self);
  }
  if (threadCount === 0) {
    return blank;
  }

  const byBucket = EMPTY_BUCKETS();
  const unbucketed: GpuOp[] = [];
  for (const [name, entry] of self) {
    const bucket = gpuBucketOf(name);
    byBucket[bucket] += entry.us;
    if (bucket === "other") {
      unbucketed.push({
        name,
        selfMs: round(entry.us / 1000),
        count: entry.count,
      });
    }
  }
  for (const bucket of Object.keys(byBucket) as (keyof GpuBuckets)[]) {
    byBucket[bucket] = round(byBucket[bucket] / 1000);
  }
  // Nothing but RunTask/GPUTask on every GPU thread means the trace lacks the gpu/viz/skia
  // categories: op-level cost is UNKNOWN, not zero, and the report must say which.
  const opDetail = [...self.keys()].some(
    (name) => !ONLY_SCHEDULING_RE.test(name),
  );

  return {
    available: true,
    hardware,
    hardwareDetail,
    processCpuMs: round(cpuUs / 1000),
    processWallMs: round(wallUs / 1000),
    threads: threadCount,
    opDetail,
    byBucket,
    topUnbucketedOps: unbucketed
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, topUnbucketed),
    device,
  };
}

function keySourceOf(key: string): string {
  return key.split(":", 1)[0] === "pixelRef"
    ? "pixelRefId"
    : key.startsWith("contentId:")
      ? "contentId"
      : "url";
}

export class TraceAnalysisError extends Error {}

export function analyzeTrace(
  events: TraceEvent[],
  options: AnalyzeOptions,
): TraceMetrics {
  const {
    windowMs,
    longTaskThresholdMs = 5,
    gapThresholdMs = 100,
    watchImageUrl,
  } = options;
  const threads = buildThreadIndex(events);

  const mount = events.find((event) => event.name === MOUNT_MARK);
  const ready = events.find((event) => event.name === READY_MARK);
  if (!mount || !ready) {
    throw new TraceAnalysisError(
      `trace is missing the scenario marks (${MOUNT_MARK}: ${Boolean(mount)}, ${READY_MARK}: ${Boolean(ready)}) — the analyzer cannot anchor its window`,
    );
  }
  // Everything BELOW is scoped to the renderer process that emitted the marks. A Chrome profile can
  // host extension renderers whose compositors also emit ActivateLayerTree; counting those would
  // inflate the honest frame rate with frames the page never produced.
  //
  // THE ONE DELIBERATE EXCEPTION is the `cpu` / `gpu` block: it reads EVERY traced process, because
  // browser- and GPU-process work is precisely what this filter used to throw away. It cannot inflate
  // any of the renderer-scoped metrics, because it does not feed any of them.
  const pid = mount.pid;
  const windowStart = ready.ts;
  const windowEnd = ready.ts + windowMs * 1000;

  const cpu = computeCpu(events, threads, {
    windowStart,
    windowEnd,
    windowMs,
  });
  const gpu = computeGpu(events, threads, {
    windowStart,
    windowEnd,
    gpu: options.gpu,
  });

  const ofPage = events.filter((event) => event.pid === pid);
  const threadNameOf = (event: TraceEvent): string =>
    threads.name.get(`${event.pid}:${event.tid}`) ?? "";

  // --- activations: the honest frame rate ------------------------------------------------------
  const activations = ofPage
    .filter((event) => event.name === ACTIVATE)
    .sort((a, b) => a.ts - b.ts);
  const firstAfterReady = activations.find((event) => event.ts >= ready.ts);
  if (!firstAfterReady) {
    throw new TraceAnalysisError(
      `no ${ACTIVATE} at or after ${READY_MARK}: the page never activated new content, so nothing was presented`,
    );
  }
  const initialRenderMs = (firstAfterReady.ts - mount.ts) / 1000;

  const windowActivations = activations.filter(
    (event) => event.ts >= windowStart && event.ts <= windowEnd,
  );
  const gaps: number[] = [];
  for (let i = 1; i < windowActivations.length; i++) {
    gaps.push((windowActivations[i].ts - windowActivations[i - 1].ts) / 1000);
  }
  const contentUpdateHz =
    windowMs > 0 ? windowActivations.length / (windowMs / 1000) : 0;

  const swaps = ofPage.filter((event) => event.name === DRAW_FRAME);
  const windowSwaps = swaps.filter(
    (event) => event.ts >= windowStart && event.ts <= windowEnd,
  );
  // DrawFrame is emitted on both the renderer compositor and the viz thread; dedupe by ts so the
  // swap rate is not silently doubled.
  const swapRateHz =
    windowMs > 0
      ? new Set(windowSwaps.map((event) => event.ts)).size / (windowMs / 1000)
      : 0;

  // --- main-thread cost per activation interval ------------------------------------------------
  const mainTasks = maximalPerThread(
    ofPage.filter(
      (event) =>
        event.name === RUN_TASK &&
        event.ph === "X" &&
        threadNameOf(event) === "CrRendererMain",
    ),
  ).sort((a, b) => a.ts - b.ts);

  const frameCosts: number[] = [];
  for (let i = 1; i < windowActivations.length; i++) {
    const from = windowActivations[i - 1].ts;
    const to = windowActivations[i].ts;
    let busy = 0;
    for (const task of mainTasks) {
      if (task.ts + (task.dur ?? 0) < from) {
        continue;
      }
      if (task.ts > to) {
        break;
      }
      busy += overlapUs(task, from, to);
    }
    frameCosts.push(busy / 1000);
  }

  const windowTasks = mainTasks.filter(
    (task) => task.ts + (task.dur ?? 0) >= windowStart && task.ts <= windowEnd,
  );
  let mainBusyUs = 0;
  let longWallUs = 0;
  let longCpuUs = 0;
  let longSamples = 0;
  for (const task of windowTasks) {
    const overlap = overlapUs(task, windowStart, windowEnd);
    mainBusyUs += overlap;
    const dur = task.dur ?? 0;
    if (dur >= longTaskThresholdMs * 1000 && typeof task.tdur === "number") {
      longWallUs += dur;
      longCpuUs += task.tdur;
      longSamples++;
    }
  }
  // tdur/dur over long tasks separates COMPUTING from PARKED WAITING: a 500ms task with 20ms of CPU
  // is a stall (blocked on raster/decode/commit), not work, and the two demand opposite fixes.
  // Kept at 4 decimals: a fully parked main thread lands near 0.004, and rounding to 2 would print
  // a real measurement as "0.00" and make it look like a bug.
  // No qualifying task => null, never a placeholder number. `mainThreadCpuSamples` carries the
  // sample size, and the invariant `ratio === null <=> samples === 0` is enforced by the validator.
  const mainThreadCpuRatio = longSamples > 0 ? longCpuUs / longWallUs : null;

  // --- decode ----------------------------------------------------------------------------------
  // Which decode-cache family is this Chrome using? Recorded so a zero decode reading can never be
  // mistaken for "this device does no decoding" (see DECODE_TASK_RE).
  const families = new Set<string>();
  for (const event of ofPage) {
    const match = CACHE_FAMILY_RE.exec(event.name);
    if (match) {
      families.add(match[1].toLowerCase());
    }
  }
  const cacheFamily: DecodeMetrics["cacheFamily"] =
    families.size === 0
      ? "unknown"
      : families.size > 1
        ? "mixed"
        : (families.values().next().value as "software" | "gpu");

  const decodeCandidates = ofPage.filter(
    (event) => event.ph === "X" && DECODE_TASK_RE.test(event.name),
  );
  // Maximal events only: the decode families nest (ImageDecodeTask > DecodeImageInTask >
  // Decode Image), and summing them all would triple-count the same microseconds. This is also why
  // the raw "3380 ms of DecodeImageIfNecessary" reading in a name histogram is misleading — that is
  // a NESTED total; the real decode wall on the decode workers here is ~1754 ms.
  const decodeEvents = maximalPerThread(decodeCandidates);

  // The two identities alias: `ImageDecodeTask` carries `pixelRefId` while the decode-cache events
  // nested inside it carry `content_id`, so ONE image can appear under two key namespaces and be
  // counted twice. Build the alias map from the nesting (a decode-cache event inside an
  // ImageDecodeTask describes the same image) and canonicalise on it.
  const aliasToCanonical = new Map<string, string>();
  for (const inner of decodeCandidates) {
    const innerKey = imageKeyOf(inner);
    if (!innerKey?.startsWith("contentId:")) {
      continue;
    }
    const owner = decodeCandidates.find((outer) => {
      if (outer === inner || !contains(outer, inner)) {
        return false;
      }
      return imageKeyOf(outer)?.startsWith("pixelRef:") ?? false;
    });
    const ownerKey = owner ? imageKeyOf(owner) : undefined;
    if (ownerKey && !aliasToCanonical.has(innerKey)) {
      aliasToCanonical.set(innerKey, ownerKey);
    }
  }
  const canonicalKey = (key: string): string =>
    aliasToCanonical.get(key) ?? key;

  const decodeKeys = new Map<string, number>();
  let decodeTotalUs = 0;
  let decodeMaxUs = 0;
  let imageKeySource = "none";
  for (const event of decodeEvents) {
    const dur = event.dur ?? 0;
    decodeTotalUs += dur;
    decodeMaxUs = Math.max(decodeMaxUs, dur);
    const key = imageKeyOf(event);
    // A decode with no identity at all (e.g. a bare `Decode Image` from `createImageBitmap`, which
    // never goes through a cc decode cache) still decoded SOMETHING — bucket it rather than drop it,
    // so `distinctImages` can never read 0 while decodes are being counted.
    const resolved = key ? canonicalKey(key) : "unattributed";
    if (key) {
      imageKeySource = keySourceOf(resolved);
    }
    decodeKeys.set(resolved, (decodeKeys.get(resolved) ?? 0) + 1);
  }

  // Codec runs: the events that really ran the decoder. They are nested inside a decode task, and
  // the task is what carries the image identity, so attribute each codec run to its enclosing task.
  const codecEvents = maximalPerThread(
    ofPage.filter((event) => event.ph === "X" && CODEC_RE.test(event.name)),
  );
  const perImageCodec = new Map<string, { runs: number; us: number[] }>();
  let codecUs = 0;
  for (const codec of codecEvents) {
    codecUs += codec.dur ?? 0;
    const owner = decodeCandidates.find(
      (task) => task !== codec && contains(task, codec),
    );
    const raw = (owner ? imageKeyOf(owner) : undefined) ?? imageKeyOf(codec);
    const key = raw ? canonicalKey(raw) : "unattributed";
    const entry = perImageCodec.get(key) ?? { runs: 0, us: [] };
    entry.runs++;
    entry.us.push(codec.dur ?? 0);
    perImageCodec.set(key, entry);
  }
  let redecodeCount = 0;
  let redecodeUs = 0;
  for (const entry of perImageCodec.values()) {
    if (entry.runs <= 1) {
      continue;
    }
    redecodeCount += entry.runs - 1;
    const sorted = [...entry.us].sort((a, b) => b - a);
    redecodeUs += sorted.slice(1).reduce((sum, value) => sum + value, 0);
  }

  const rasterCandidates = ofPage.filter(
    (event) => event.name === RASTER_TASK && event.ph === "X",
  );
  const rasterTasks = maximalPerThread(rasterCandidates);
  // In-raster = a CODEC RUN inside a raster task. When a trace carries no codec events at all, fall
  // back to decode events over 1 ms so the alarm still works, but never to bare cache lookups.
  const inRasterPopulation =
    codecEvents.length > 0
      ? codecEvents
      : decodeEvents.filter((event) => (event.dur ?? 0) >= 1000);
  const inRasterEvents = inRasterPopulation.filter((decode) =>
    rasterTasks.some((raster) => raster !== decode && contains(raster, decode)),
  );
  const rasterUs = rasterTasks.reduce(
    (sum, event) => sum + (event.dur ?? 0),
    0,
  );

  // --- paint inventory: small elements referencing large source images -------------------------
  const paints = ofPage.filter((event) => event.name === PAINT_IMAGE);
  const paintUrls = new Set<string>();
  let maxSourcePixels = 0;
  let maxRatio = 0;
  const watched = watchImageUrl
    ? {
        url: watchImageUrl,
        paintCount: 0,
        paintCountInWindow: 0,
        sizes: new Set<string>(),
        sourcePixels: 0,
      }
    : undefined;
  for (const paint of paints) {
    const data = (
      paint.args as
        | {
            data?: {
              url?: string;
              srcWidth?: number;
              srcHeight?: number;
              width?: number;
              height?: number;
            };
          }
        | undefined
    )?.data;
    if (!data) {
      continue;
    }
    if (data.url) {
      paintUrls.add(data.url);
    }
    const sourcePixels = (data.srcWidth ?? 0) * (data.srcHeight ?? 0);
    const paintedPixels = (data.width ?? 0) * (data.height ?? 0);
    if (watched && data.url?.includes(watched.url)) {
      watched.paintCount++;
      if (paint.ts >= windowStart && paint.ts <= windowEnd) {
        watched.paintCountInWindow++;
      }
      watched.sizes.add(`${data.width ?? 0}x${data.height ?? 0}`);
      watched.sourcePixels = Math.max(watched.sourcePixels, sourcePixels);
    }
    maxSourcePixels = Math.max(maxSourcePixels, sourcePixels);
    if (paintedPixels > 0 && sourcePixels > 0) {
      maxRatio = Math.max(maxRatio, sourcePixels / paintedPixels);
    }
  }

  // --- render surfaces --------------------------------------------------------------------------
  const reasons: Record<string, number> = {};
  for (const event of ofPage) {
    if (event.name !== RENDER_SURFACE_REASONS || !event.args) {
      continue;
    }
    for (const [reason, count] of Object.entries(event.args)) {
      if (typeof count === "number") {
        reasons[reason] = Math.max(reasons[reason] ?? 0, count);
      }
    }
  }
  const renderSurfacePasses = ofPage.filter(
    (event) => event.name === RENDER_SURFACE_PASS,
  ).length;

  return {
    initialRenderMs: round(initialRenderMs),
    frameCostMs: stat(frameCosts),
    contentUpdateHz: round(contentUpdateHz),
    activationGapMs: {
      ...stat(gaps),
      over100msCount: gaps.filter((gap) => gap > gapThresholdMs).length,
      count: gaps.length,
    },
    swapRateHz: round(swapRateHz),
    decode: {
      count: decodeEvents.length,
      totalMs: round(decodeTotalUs / 1000),
      maxMs: round(decodeMaxUs / 1000),
      distinctImages: decodeKeys.size,
      redecodeCount,
      redecodeMs: round(redecodeUs / 1000),
      inRasterCount: inRasterEvents.length,
      inRasterMs: round(
        inRasterEvents.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000,
      ),
      codecRuns: codecEvents.length,
      codecMs: round(codecUs / 1000),
      imageKey: imageKeySource,
      cacheFamily,
      imagesExpected: options.imagesExpected ?? true,
    },
    paint: {
      count: paints.length,
      distinctUrls: paintUrls.size,
      maxSourceMegapixels: round(maxSourcePixels / 1e6),
      maxSourceToPaintedRatio: round(maxRatio),
    },
    rasterMs: round(rasterUs / 1000),
    renderSurfaces: Object.values(reasons).reduce((sum, v) => sum + v, 0),
    renderSurfaceReasons: reasons,
    renderSurfaceListPasses: renderSurfacePasses,
    mainThreadCpuRatio:
      mainThreadCpuRatio === null
        ? null
        : Number(mainThreadCpuRatio.toPrecision(4)),
    mainThreadCpuSamples: longSamples,
    mainThreadBusyMs: round(mainBusyUs / 1000),
    windowMs: round(windowMs),
    activationCount: windowActivations.length,
    cpu,
    gpu,
    ...(watched
      ? {
          watchedImage: {
            url: watched.url,
            paintCount: watched.paintCount,
            paintCountInWindow: watched.paintCountInWindow,
            distinctPaintedSizes: watched.sizes.size,
            sourceMegapixels: round(watched.sourcePixels / 1e6),
          },
        }
      : {}),
  };
}

export interface MatcherProbeRow {
  role: string;
  expected: string;
  breaks: string;
  /** Distinct trace names that matched, with how often each occurred. */
  matched: { name: string; cat: string; count: number }[];
  count: number;
  ok: boolean;
}

export interface MatcherProbe {
  rows: MatcherProbeRow[];
  /** Unmatched names that look like they belong to one of the families — rename suspects. */
  nearMisses: { name: string; cat: string; count: number }[];
}

/**
 * Check the analyzer's event-name matchers against a REAL capture.
 *
 * Chrome trace names drift between versions and between rendering backends, and the failure mode is
 * silent: an unmatched family reports zero, and zero reads like "fast". The most portability-critical
 * case is the image-decode cache — headless SwiftShader emits `SoftwareImageDecodeCache::*` while a
 * phone with a GPU emits `GpuImageDecodeCache::*` — so this probe runs FIRST on any environment
 * nobody has measured before, and `nearMisses` is where a renamed event shows itself.
 */
export function matcherProbe(events: TraceEvent[]): MatcherProbe {
  const counts = new Map<
    string,
    { name: string; cat: string; count: number }
  >();
  for (const event of events) {
    if (event.cat === "__metadata") {
      continue;
    }
    const key = `${event.name} ${event.cat ?? ""}`;
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, { name: event.name, cat: event.cat ?? "", count: 1 });
    }
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count);

  const rows: MatcherProbeRow[] = TRACE_MATCHERS.map((matcher) => {
    const matched = all.filter((entry) => matcher.test(entry.name));
    const count = matched.reduce((sum, entry) => sum + entry.count, 0);
    return {
      role: matcher.role,
      expected: matcher.expected,
      breaks: matcher.breaks,
      matched,
      count,
      ok: count > 0,
    };
  });
  const nearMisses = all
    .filter(
      (entry) =>
        NEAR_MISS_RE.test(entry.name) &&
        !TRACE_MATCHERS.some((matcher) => matcher.test(entry.name)),
    )
    // Decode-looking names first: `cc` emits dozens of raster/activation/swap relatives that are
    // simply not the events the analyzer wants, whereas an unmatched DECODE name is the one thing
    // that would make a phone report "no image decoding" and be believed.
    .sort(
      (a, b) =>
        Number(/decode/i.test(b.name)) - Number(/decode/i.test(a.name)) ||
        b.count - a.count,
    );
  return { rows, nearMisses };
}

export function formatMatcherProbe(events: TraceEvent[]): string {
  const probe = matcherProbe(events);
  const lines: string[] = [
    "ANALYZER MATCHER PROBE (does this environment still speak the names?)",
  ];
  for (const row of probe.rows) {
    lines.push(
      `  ${row.ok ? "ok  " : "MISS"}  ${row.role.padEnd(20)} ${String(row.count).padStart(7)}  ${row.expected}`,
    );
    if (!row.ok) {
      lines.push(`        -> reports ZERO (not fast): ${row.breaks}`);
      continue;
    }
    for (const entry of row.matched.slice(0, 6)) {
      lines.push(
        `          ${String(entry.count).padStart(7)}  ${entry.name}  [${entry.cat}]`,
      );
    }
    if (row.matched.length > 6) {
      lines.push(`          … ${row.matched.length - 6} more matching names`);
    }
  }
  lines.push("");
  lines.push(
    probe.nearMisses.length === 0
      ? "  near misses: none (no decode/raster/activation-looking name went unmatched)"
      : "  NEAR MISSES — unmatched names that look like a renamed family member:",
  );
  for (const entry of probe.nearMisses.slice(0, 30)) {
    lines.push(
      `      ${String(entry.count).padStart(7)}  ${entry.name}  [${entry.cat}]`,
    );
  }
  if (probe.nearMisses.length > 30) {
    lines.push(`      … ${probe.nearMisses.length - 30} more`);
  }
  return lines.join("\n");
}
