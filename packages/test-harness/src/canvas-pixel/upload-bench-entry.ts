/**
 * The page half of `test/canvasUploadBenchXvfb.test.ts`: how long it costs to get
 * a 2D canvas of effect pixels INTO a stage texture, on a real GPU.
 *
 * WHY THIS EXISTS. `@godot-scene-web/html`'s shader and particle runtimes each
 * paint a per-node 2D canvas. A consumer that composites those into one stage
 * canvas has to upload them, and how many it can afford per frame is a budget it
 * must pick a number for — one that is wrong on every device if it is guessed.
 * The cases in `./browser-entry` say the upload is CORRECT; this says what it
 * COSTS, per size and per path, so the number can be arithmetic instead of a
 * guess.
 *
 * THE TRAP THIS FILE IS BUILT AROUND, twice over. Timing the upload call by
 * itself measures almost nothing: `texImage2D`/`texSubImage2D` from a canvas
 * RECORDS a pending copy and returns. Nor does `gl.finish()` help — in Chrome it
 * returns in under one clock tick whatever is outstanding, measured on this box,
 * so a bracket built around it reads the same single tick at 0.26 MB and at
 * 14 MB. That is not a fast upload; it is an upload that has not happened yet.
 * Even the 2D `fillRect` that PRODUCED the source is deferred the same way.
 *
 * What really synchronises is a READ. So each timed iteration uploads, draws a
 * quad out of that texture through the package's own executor, and reads one
 * pixel back — which cannot answer until everything queued ahead of it has run.
 * The bracket therefore contains the upload plus a fixed cost (the deferred
 * repaint, the draw, and the read's own round trip), so exactly the same bracket
 * is measured again with the upload left out, and subtracted:
 *
 * - `callMs` — the upload call alone. Real, and worth having: it is what the main
 *   thread pays at the call site, and on a discrete GPU it is nearly nothing.
 * - `syncMs` — repaint + upload + sampling draw + one-pixel read.
 * - `baselineMs` — the same, minus the upload.
 * - `uploadMs` — `syncMs - baselineMs`: what the pixels actually cost.
 *
 * WHAT IS COMPARED. Three ways to put the same pixels on the same texture:
 * `respec` (a full `texImage2D`, which frees the mip level and allocates a new
 * one), `sub` (a `texSubImage2D` over storage that already fits), and `update`
 * (`CanvasTextureCache.update`, the production entry point, which picks `sub`
 * when the size has not changed). `respec` and `sub` are hand-written here rather
 * than driven through the cache, because the cache deliberately makes the choice
 * for you and this is the file that has to see both.
 *
 * THE SOURCE. A 2D canvas of the given size, ATTACHED to the document — a
 * detached canvas is not the shape a runtime's node canvas ever has, and browsers
 * are entitled to treat the two differently. Two things about it are varied,
 * because both change the answer and neither is guessable:
 *
 * - PLACEMENT, visible against `visibility: hidden`. A consumer that draws these
 *   pixels itself has every reason to hide the original, and "hiding it
 *   de-accelerated the canvas" is the kind of thing only measurement finds.
 * - FRESHNESS. `dirty` repaints the whole surface before every iteration, which
 *   is what an animating effect does; `clean` paints once and re-uploads the same
 *   pixels. The gap between them is not the copy — it is what it costs to
 *   re-snapshot a canvas that has just been drawn into, and on this box it is the
 *   LARGER half of a small surface's upload. A budget derived from `clean` would
 *   be a budget for effects that are not moving.
 */

import {
  type CanvasExecutor,
  type CanvasStage,
  type CanvasTextureCache,
  createCanvasExecutor,
  createCanvasStage,
  createDrawList,
  createQuadView,
  createTextureCache,
  type DrawList,
  type ExecutorTexture,
} from "@godot-scene-web/canvas";

/** Sizes worth knowing, smallest to largest. The top of the range is a real
 *  full-bleed effect surface; the bottom is a small per-card one. */
export const UPLOAD_BENCH_SIZES: ReadonlyArray<readonly [number, number]> = [
  [256, 256],
  [1024, 512],
  [2048, 768],
  [2765, 1296],
];

export type UploadMethod = "respec" | "sub" | "update";
export type SourcePlacement = "visible" | "hidden";
/** Whether the source is repainted before each upload (`dirty`) or uploaded
 *  unchanged (`clean`). See the header. */
export type SourceFreshness = "dirty" | "clean";

export interface UploadBenchRow {
  width: number;
  height: number;
  placement: SourcePlacement;
  freshness: SourceFreshness;
  method: UploadMethod;
  /** Timed samples kept per measurement, warmup excluded. */
  samples: number;
  /** Median wall clock across the upload CALL — main-thread submit cost, which
   *  is not the same thing as the upload (see the header). */
  callMs: number;
  /** 95th percentile of the same. */
  callP95Ms: number;
  /** Median of upload + one sampling draw + a one-pixel read. */
  syncMs: number;
  /** Median of the same bracket with the upload left out. */
  baselineMs: number;
  /** `syncMs - baselineMs`: the resolved cost of the pixels. */
  uploadMs: number;
  /** 95th percentile of `syncMs`'s samples, less the baseline median — the tail,
   *  which is what a frame budget has to survive rather than the median. */
  uploadP95Ms: number;
}

export interface UploadBenchResult {
  rows: UploadBenchRow[];
  renderer: string;
  /** `MAX_TEXTURE_SIZE`, so a row that could not have run says why. */
  maxTextureSize: number;
  devicePixelRatio: number;
  /** Whether the page got the fine clock (see {@link clockResolutionMs}). */
  crossOriginIsolated: boolean;
  /** The smallest non-zero step this page's `performance.now()` can report,
   *  measured. Every number below is a multiple of it, and a table whose cells
   *  are all 0 or one step is a table that measured the clock. */
  clockResolutionMs: number;
}

export interface UploadBenchOptions {
  /** Timed iterations per cell. */
  iterations?: number;
  /** Iterations run and discarded first, so no cell measures a cold path. */
  warmup?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[at];
}

/** A source canvas in the document, in the placement under test. */
function makeSource(
  width: number,
  height: number,
  placement: SourcePlacement,
): { canvas: HTMLCanvasElement; repaint: (n: number) => void } {
  const host = document.createElement("div");
  // Off to the side rather than off-screen-by-display: `display: none` would give
  // the canvas no layout at all, which is a third thing to measure and not one a
  // consumer would do (the runtime sizes its canvas from the layer's box).
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  if (placement === "hidden") host.style.visibility = "hidden";
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  host.appendChild(canvas);
  document.body.appendChild(host);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D context for the upload-bench source");
  const repaint = (n: number): void => {
    // A whole-surface write, which is what a runtime's GL->2D blit is. The colour
    // moves every iteration so nothing downstream can decide the pixels are the
    // ones it already has.
    ctx.fillStyle = `rgba(${n % 255}, ${(n * 7) % 255}, ${(n * 13) % 255}, 0.5)`;
    ctx.fillRect(0, 0, width, height);
  };
  repaint(0);
  return { canvas, repaint };
}

/** `createTextureCache`'s full re-spec, restated. Kept in step with `textures.ts`
 *  by hand on purpose: the cache will not re-spec a same-size source any more,
 *  and this file is the one that has to price what it used to do. */
function respec(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  source: HTMLCanvasElement,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

/** The same for the re-upload path. */
function sub(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  source: HTMLCanvasElement,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/** The clock's own granularity, from the smallest step it will report. */
function clockResolutionMs(): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 200000; i += 1) {
    const a = performance.now();
    const b = performance.now();
    if (b > a && b - a < smallest) smallest = b - a;
  }
  return Number.isFinite(smallest) ? smallest : 0;
}

function rendererString(gl: WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (!info) return "";
    return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  } catch {
    return "";
  }
}

export function runUploadBench(
  options: UploadBenchOptions = {},
): UploadBenchResult {
  const iterations = options.iterations ?? 100;
  const warmup = options.warmup ?? 20;

  const stageCanvas = document.createElement("canvas");
  const stage: CanvasStage | null = createCanvasStage({
    canvas: stageCanvas,
    designWidth: 1920,
    designHeight: 1080,
  });
  if (!stage) throw new Error("no WebGL2 context for the upload bench");
  stage.setStageSize(64, 64);
  const gl = stage.gl;
  const textures: CanvasTextureCache = createTextureCache(gl);
  const executor: CanvasExecutor = createCanvasExecutor({
    gl,
    white: textures.white(),
  });
  const list: DrawList<ExecutorTexture | null> = createDrawList();

  // THE FORCING FUNCTION. A quad out of the texture under test, drawn through the
  // package's own executor, then ONE pixel read back. Small draw on purpose — 4x4
  // of a 64x64 stage — so the fragment work is negligible and the bracket holds
  // the upload's resolution rather than a fill. The texture has to be complete
  // and resident before a single texel of it can be sampled, and `readPixels`
  // cannot answer until the sample has happened: that pair is what makes the
  // deferred copy real. (`gl.finish` will not: see the header.)
  const readback = new Uint8Array(4);
  const drawFrom = (handle: ExecutorTexture): void => {
    list.reset();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    quad.srcW = handle.width;
    quad.srcH = handle.height;
    list.pushQuad(quad, handle);
    executor.execute(list, stage.projection());
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readback);
  };

  const rows: UploadBenchRow[] = [];
  for (const placement of ["visible", "hidden"] as SourcePlacement[]) {
    for (const [width, height] of UPLOAD_BENCH_SIZES) {
      const { canvas, repaint } = makeSource(width, height, placement);
      // One texture per cell, specified once up front so `sub` has storage and
      // `respec` is measuring a re-spec rather than a first allocation.
      const texture = gl.createTexture();
      respec(gl, texture, canvas);
      const raw: ExecutorTexture = { texture, width, height };
      const key = `bench://${placement}/${width}x${height}`;
      const cached = textures.update(key, canvas);

      const upload = (method: UploadMethod): ExecutorTexture => {
        if (method === "respec") {
          respec(gl, texture, canvas);
          return raw;
        }
        if (method === "sub") {
          sub(gl, texture, canvas);
          return raw;
        }
        return textures.update(key, canvas);
      };

      /** `mode: "call"` times the upload alone; `"sync"` times upload + sampling
       *  draw + one-pixel read; `"baseline"` is the same bracket with no upload,
       *  which is what makes the subtraction legal — both arms repaint (or do
       *  not) identically, so everything except the upload cancels. */
      const run = (
        method: UploadMethod,
        mode: "call" | "sync" | "baseline",
        freshness: SourceFreshness,
        count: number,
      ): number[] => {
        const samples: number[] = [];
        for (let i = 0; i < count; i += 1) {
          if (freshness === "dirty") repaint(i);
          const start = performance.now();
          const handle = mode === "baseline" ? cached : upload(method);
          if (mode !== "call") drawFrom(handle);
          samples.push(performance.now() - start);
        }
        return samples;
      };

      for (const freshness of ["dirty", "clean"] as SourceFreshness[]) {
        for (const method of ["respec", "sub", "update"] as UploadMethod[]) {
          run(method, "call", freshness, warmup);
          const call = run(method, "call", freshness, iterations);
          run(method, "sync", freshness, warmup);
          const sync = run(method, "sync", freshness, iterations);
          run(method, "baseline", freshness, warmup);
          const baseline = run(method, "baseline", freshness, iterations);
          const baselineMs = median(baseline);
          rows.push({
            width,
            height,
            placement,
            freshness,
            method,
            samples: call.length,
            callMs: median(call),
            callP95Ms: percentile(call, 0.95),
            syncMs: median(sync),
            baselineMs,
            uploadMs: median(sync) - baselineMs,
            uploadP95Ms: percentile(sync, 0.95) - baselineMs,
          });
        }
      }

      gl.deleteTexture(texture);
      textures.release(key);
      canvas.parentElement?.remove();
    }
  }

  const result: UploadBenchResult = {
    rows,
    renderer: rendererString(gl),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    devicePixelRatio: window.devicePixelRatio,
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    clockResolutionMs: clockResolutionMs(),
  };
  executor.dispose();
  textures.dispose();
  stage.dispose();
  return result;
}

declare global {
  interface Window {
    __gswCanvasUploadBench: {
      run(options?: UploadBenchOptions): UploadBenchResult;
    };
  }
}

window.__gswCanvasUploadBench = { run: runUploadBench };
