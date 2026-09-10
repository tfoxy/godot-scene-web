// S5 `static-surfaces` — once a surface has FINISHED rendering, what does it cost to keep on screen?
//
// THE QUESTION. The consuming project renders every static shader and particle system into a
// per-node `<canvas>`: one shared WebGL canvas produces a frame, and each node owns a 2D canvas whose
// entire job is a single full-canvas `drawImage` of it (`packages/html/src/webgl/runtime.ts`, the
// `binding.ctx2d.drawImage(sharedGl.canvas, …)` blit and the `staticFrameCache` blit above it).
// Canvases were suspected of being expensive, and the standing proposal was to replace them with
// `<img>` — bake the finished frame to a blob once and let the browser treat it as an ordinary image.
//
// THE ENCODE IN ISOLATION belongs in `probes/bake-probe.html`, which measured it on the target phone:
// slicing 50 regions costs 5 ms, PNG-encoding them 1,789 ms and WebP 2,244 ms. (An earlier reading of
// 49,305 ms for PNG was a THROTTLED TAB and was retracted — see the probe's watchdog.) That says the
// `<img>` route is affordable at all; it says nothing about STEADY STATE. Setup appears here only as
// `readyMs`, because the price turned out to be payable rather than fixed — see `serialBake` and
// `bakeWorkers` below.
//
// Steady state is the actual question: once both a canvas surface and an `<img>` surface have
// finished rendering, and the DOM has to render other things, which one holds frame rate? So this
// scenario mounts N finished surfaces, churns unrelated content beside them every frame, and reads
// `contentUpdateHz`, `activationGapMs`, `cpu.byProcess` and `layerCount` around them.
//
// THE ARMS
//
//   canvas-2d              per-node <canvas> + 2D context + drawImage — TODAY'S PATH
//   canvas-bitmaprenderer  per-node <canvas> + ImageBitmapRenderingContext + transferFromImageBitmap
//   img-webp               encode once -> blob URL -> <img>
//   img-png                the same, PNG — what the shipped baker (`frontend/src/mirror/atlasBaker.ts`)
//                          actually emits, kept so the production format is on the table
//   img-worker-webp        the same again, with the encode moved to a POOL of workers (`bakeWorkers`,
//                          default 4). The phone has 8 cores and the encode is what makes `<img>`
//                          expensive to SET UP, so this arm asks whether that setup can be paid on
//                          cores nobody is watching.
//
// WHY A POOL AND NOT A WORKER. `bakeWorkers=1` was measured and LOSES — `readyMs` 1,831 ms against
// `img-webp`'s 1,420 on the phone, matching the probe's `worker-webp x1`. `toBlob` is already partly
// off the main thread, so one worker does not add a core, it adds a round trip. The probe's fan-out
// sweep is where the win is (255 ms at four workers against 1,725 inline), and this arm carries that
// into a real scenario rather than leaving it in a microbenchmark.
//
// WHAT THE WORKER ARM HAS TO PROVE, and it is two numbers read TOGETHER. `readyMs` must fall toward
// the canvas arms (the encode stopped blocking mount) while `layers` STAYS at the img arms' value
// (the surfaces are still ordinary images, not canvases). Either alone is meaningless: a worker arm
// that got fast by quietly falling back to canvas would win `readyMs` and lose the entire point.
//
// `canvas-bitmaprenderer` exists because gsw uses `bitmaprenderer` NOWHERE, while the blit above is
// precisely what `ImageBitmapRenderingContext` is for. It is worth being clear about what it can and
// cannot win: it removes the 2D drawing context, NOT the canvas element or its compositor layer. If
// canvases cost frame rate BECAUSE they are layers, this arm measures the same as `canvas-2d`, and
// that null result is worth having explicitly rather than by assumption.
//
// UPDATE CADENCE. `updateEveryMs=0` is the strictly-static case — `step()` touches only the churn
// strip and the surfaces are never redrawn. A non-zero value regenerates each surface on that cadence,
// which is where a frozen-forever winner can turn into a trap: the mirror's "static" shaders are
// static only until game state changes them, and on that frame a canvas arm redraws while an `<img>`
// arm must RE-ENCODE. Both are measured rather than argued about.
//
// NO `perf assert` GATE. There is no hypothesis here worth encoding as a relation. Writing one from
// desktop intuition is exactly what S2's gate did, and a device run then contradicted three of its
// five relations.

import { type GridShape, gridShapeFor } from "../fit";
import type {
  ParamValue,
  Scenario,
  ScenarioContext,
  StageLayout,
} from "./types";

export const STATIC_SURFACE_MECHANISMS = [
  "canvas-2d",
  "canvas-bitmaprenderer",
  "img-webp",
  "img-png",
  "img-worker-webp",
];

/** One surface's box in CSS px, and the padding around the whole grid. */
export const SURFACE_PX = 128;
export const SURFACE_GAP_PX = 10;
export const SURFACE_PAD_PX = 16;
/** The authored column count, used on an unfitted (desktop) run so the reference table stays valid. */
export const SURFACE_COLUMNS = 8;

/** The churn strip: unrelated content repainted every frame, below the surface grid. */
const CHURN_HEIGHT = 56;
const CHURN_WIDTH = 44;
const CHURN_GAP = 8;
const CHURN_MARGIN = 12;
/** Breathing room so a sample point never lands on the stage's clip edge. */
const STAGE_MARGIN = 16;

/**
 * How far a surface is nudged onto its neighbour when `overlap` is on, in CSS px.
 *
 * Overlap is not decoration: a grid of non-touching boxes is the friendliest arrangement a
 * compositor can be given and is not what a real scene looks like. Overlapping them forces the
 * surfaces to be composited against each other.
 */
const OVERLAP_PX = 28;

export const STATIC_SURFACES_PARAMS: Record<
  string,
  { default: ParamValue; values?: ParamValue[]; describe: string }
> = {
  mechanism: {
    default: "canvas-2d",
    values: STATIC_SURFACE_MECHANISMS,
    describe: "how a finished surface is displayed",
  },
  surfaces: { default: 24, describe: "finished surfaces mounted on the stage" },
  churn: {
    default: 24,
    describe: "unrelated elements repainted every frame beside the surfaces",
  },
  alpha: {
    default: true,
    describe:
      "surfaces carry transparency (shaders and particles do); false makes them opaque",
  },
  overlap: {
    default: false,
    describe:
      "overlap neighbouring surfaces so they must be composited against each other",
  },
  updateEveryMs: {
    default: 0,
    describe:
      "0 = strictly static (only the churn strip moves); >0 = each surface regenerates on this cadence, which the img arms pay a RE-ENCODE for",
  },
  sharedFrames: {
    default: false,
    describe:
      "every surface shows ONE frame instead of one each — the destination shape (a map of shader path -> finished image), and the run whose trace answers whether N nodes decode it once or N times",
  },
  bakeWorkers: {
    default: 4,
    describe:
      "encoder workers on the img-worker-webp arm. 1 LOSES to encoding inline (toBlob is already partly off-thread, so one worker adds a round trip, not a core); 4 is where the probe measured the win",
  },
  serialBake: {
    default: false,
    describe:
      "bake one surface at a time during ready() instead of issuing all of them; reproduces the pre-worker rounds' readyMs, and makes the worker arm slower by construction",
  },
  // Declared, at S1's values, so this scenario reuses the SAME cached atlas page rather than
  // generating a second 15 MB fixture — and so what it draws from is stated rather than inherited.
  // A surface's content is a real atlas region, because flat colour compresses to nothing and would
  // understate both the encode and the raster of every arm.
  regions: {
    default: 100,
    describe: "regions on the atlas page frames are cut from",
  },
  atlasPage: { default: 4096, describe: "atlas page size in px (square)" },
};

/**
 * URL params arrive as STRINGS (`serve.ts` stringifies every value into the query, and the in-page
 * `readParams` only coerces numerics), while `resolveParams` on the node side produces real booleans.
 * Both spellings therefore reach scenario code, and a bare `=== true` would silently read every
 * device run's `alpha` as false.
 */
function boolParam(value: ParamValue | undefined): boolean {
  return value === true || value === "true";
}

interface Surface {
  element: HTMLElement;
  /** The <canvas> or <img> that actually shows the frame. */
  display: HTMLCanvasElement | HTMLImageElement;
  /** The per-node 2D context, created once at mount — only on the `canvas-2d` arm. */
  ctx2d: CanvasRenderingContext2D | undefined;
  /** The per-node bitmap renderer, created once at mount — only on the bitmaprenderer arm. */
  bitmapCtx: ImageBitmapRenderingContext | undefined;
  index: number;
  /** Wall-clock ms of the last regeneration, for the `updateEveryMs` cadence. */
  lastUpdateMs: number;
  /** Object URL currently shown by an `<img>` arm, revoked when replaced. */
  url: string | undefined;
  /** True while an async re-encode is in flight, so a slow encode cannot queue behind itself. */
  encoding: boolean;
}

interface State {
  surfaces: Surface[];
  container: HTMLElement;
  churn: HTMLElement[];
  /**
   * The ONE shared source canvas every surface draws from — the stand-in for the shared WebGL canvas
   * in `packages/html/src/webgl/shared-gl.ts`. Shared rather than per-node on purpose: the arms
   * differ in how a finished frame gets from that canvas onto the page, and giving each arm its own
   * producer would measure the producer instead.
   */
  source: HTMLCanvasElement;
  sourceCtx: CanvasRenderingContext2D;
  bitmap: ImageBitmap | undefined;
  prepared: Promise<void> | undefined;
  /** Per-surface generation counter, so a late-resolving encode cannot overwrite a newer frame. */
  epoch: number[];
  /** The off-thread encoder pool, only on the `img-worker-webp` arm. */
  encoder: EncoderPool | undefined;
  /** True when every surface shows ONE frame (`sharedFrames`). */
  shared: boolean;
  /** The generation currently drawn into the shared source, so it is redrawn once per cadence. */
  sharedGeneration: number;
  /**
   * The one in-flight (or finished) bake for a shared generation, so N surfaces arriving at the same
   * generation cost ONE encode rather than N — which is the entire point of the shared arm.
   */
  sharedBake: { generation: number; url: Promise<string> } | undefined;
  /**
   * Every shared URL ever handed out, revoked at teardown.
   *
   * Held rather than revoked on replacement because revoking a URL an `<img>` may still be fetching
   * is a real hazard, and the count is bounded by the update cadence over a ~10 s window.
   */
  sharedUrls: string[];
}

const states = new WeakMap<HTMLElement, State>();

function mechanismOf(ctx: ScenarioContext): string {
  return String(ctx.params.mechanism);
}

export function usesImgElement(mechanism: string): boolean {
  return mechanism.startsWith("img-");
}

/** Whether this arm encodes off the main thread. */
export function usesWorkerBake(mechanism: string): boolean {
  return mechanism === "img-worker-webp";
}

/**
 * The blob type an `<img>` arm encodes to.
 *
 * WebP is the LOSSLESS one here, which is the opposite of what everyone assumes: measured in
 * `probes/bake-probe.html`, `toBlob("image/webp")` with no quality argument round-trips rgb AND
 * alpha at exactly 0 error, in fewer bytes than PNG. `quality: 0.99` is the first value that
 * switches Chrome to its lossy encoder.
 */
export function blobTypeFor(mechanism: string): string {
  return mechanism === "img-png" ? "image/png" : "image/webp";
}

/**
 * The quality argument the webp arms MUST pass, and the reason they must.
 *
 * `HTMLCanvasElement.toBlob(cb, "image/webp")` and `OffscreenCanvas.convertToBlob({type:
 * "image/webp"})` have DIFFERENT defaults in Chrome, measured in `probes/bake-probe.html`: the first
 * is lossy at roughly quality 0.8 (41.9 KB/region, rgb error up to 71), the second is lossless
 * (185.3 KB, error 0). Left implicit, the inline arm and the worker arm — which use one call each —
 * would be encoding different images at different sizes with different codecs, and the difference
 * between them would not be the thread. `quality: 1` makes both lossless and byte-identical.
 *
 * PNG has no quality argument and needs none.
 */
export function blobQualityFor(mechanism: string): number | undefined {
  return blobTypeFor(mechanism) === "image/webp" ? 1 : undefined;
}

/**
 * The encoder worker, as a source string behind a Blob URL.
 *
 * Inline rather than a second bundle entry because the scenario is one module served by
 * `src/serve.ts`, and a Blob URL keeps it that way — the same technique `probes/bake-probe.html`
 * uses, so there is one approach to this rather than two.
 *
 * `ImageBitmap` transfers in (the shared source's finished frame) and `Blob` comes back — and a Blob
 * structured-clones BY REFERENCE, so the return trip is not a copy of the encoded bytes.
 */
const ENCODER_WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { id, bitmap, width, height, mime, quality } = event.data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const options = quality === undefined ? { type: mime } : { type: mime, quality };
    self.postMessage({ id, blob: await canvas.convertToBlob(options) });
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message) });
  }
};
`;

interface EncoderPool {
  encode(
    source: HTMLCanvasElement,
    mime: string,
    quality: number | undefined,
  ): Promise<Blob>;
  terminate(): void;
}

/**
 * A POOL, not a worker, and the size is the whole point.
 *
 * A single worker LOSES: the probe measured `worker-webp` at fan-out 1 as slower than encoding
 * inline (1,827 ms against 1,725 for 50 regions on the phone), and this scenario reproduced that
 * end-to-end (`readyMs` 1,831 against `img-webp`'s 1,420). The reason is that `toBlob` is already
 * partly off the main thread — roughly half of the inline arm's wall is not main-thread time — so one
 * worker does not add a core, it just adds a round trip. At fan-out 4 the same probe measured 255 ms
 * against 1,725, which is the result this arm exists to carry into a real scenario.
 */
function createEncoderPool(size: number): EncoderPool {
  const url = URL.createObjectURL(
    new Blob([ENCODER_WORKER_SOURCE], { type: "text/javascript" }),
  );
  const pending = new Map<
    number,
    { resolve: (blob: Blob) => void; reject: (error: Error) => void }
  >();
  const receive = (event: MessageEvent) => {
    const { id, blob, error } = event.data as {
      id: number;
      blob?: Blob;
      error?: string;
    };
    const entry = pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id);
    if (blob) {
      entry.resolve(blob);
    } else {
      entry.reject(new Error(`static-surfaces worker: ${error}`));
    }
  };
  const workers = Array.from({ length: Math.max(1, size) }, () => {
    const worker = new Worker(url);
    worker.onmessage = receive;
    return worker;
  });
  let nextId = 0;
  let cursor = 0;
  return {
    async encode(
      source: HTMLCanvasElement,
      mime: string,
      quality: number | undefined,
    ): Promise<Blob> {
      // The capture happens here and is asynchronous; what the main thread actually spends is one
      // `createImageBitmap` call and one `postMessage`. Which is exactly why this arm cannot be
      // judged on "time spent before the first await" — see the probe's note on `sync`.
      const bitmap = await createImageBitmap(source);
      const worker = workers[cursor++ % workers.length];
      return new Promise<Blob>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        worker.postMessage(
          {
            id,
            bitmap,
            width: source.width,
            height: source.height,
            mime,
            quality,
          },
          [bitmap],
        );
      });
    },
    terminate(): void {
      for (const worker of workers) {
        worker.terminate();
      }
      // Revoked at teardown, not right after construction: revoking a Blob URL while a worker is
      // still being fetched from it is a race.
      URL.revokeObjectURL(url);
    },
  };
}

export function surfaceGridShape(
  params: { surfaces?: unknown },
  layout: StageLayout,
): GridShape {
  const count = Math.max(1, Number(params.surfaces ?? 0) || 0);
  if (!layout.fit) {
    return {
      columns: Math.min(SURFACE_COLUMNS, count),
      rows: Math.ceil(count / SURFACE_COLUMNS),
    };
  }
  // Square cells, so the cell aspect is 1 — the same rule S1 uses, for the same reason: a landscape
  // grid fitted into a portrait phone renders tiny and under-loads the work being measured.
  return gridShapeFor(
    count,
    1,
    layout.viewport.height > 0
      ? layout.viewport.width / layout.viewport.height
      : 1,
  );
}

/**
 * A surface's box in CSS px. `overlap` shifts every cell after the first back onto its neighbour;
 * the FIRST cell never moves, so the grid's origin is identical in both modes.
 */
export function surfaceBox(
  index: number,
  columns: number,
  overlap: boolean,
): { left: number; top: number } {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const pitch = SURFACE_PX + SURFACE_GAP_PX - (overlap ? OVERLAP_PX : 0);
  return {
    left: SURFACE_PAD_PX + column * pitch,
    top: SURFACE_PAD_PX + row * pitch,
  };
}

/** The surface grid's own box in CSS px. Pure, so the stage box can be proved without a browser. */
export function surfaceGridSize(
  params: { surfaces?: unknown; overlap?: unknown },
  layout: StageLayout,
): { width: number; height: number } {
  const { columns, rows } = surfaceGridShape(params, layout);
  const pitch =
    SURFACE_PX +
    SURFACE_GAP_PX -
    (boolParam(params.overlap as never) ? OVERLAP_PX : 0);
  return {
    width: SURFACE_PAD_PX * 2 + SURFACE_PX + Math.max(0, columns - 1) * pitch,
    height: SURFACE_PAD_PX * 2 + SURFACE_PX + Math.max(0, rows - 1) * pitch,
  };
}

/**
 * Where each churn cell sits, in CSS px. The strip WRAPS at the surface grid's width instead of
 * running off to the right in one line.
 *
 * Not cosmetic. A single 24-cell row is ~1250 px wide; on a portrait phone the grid is ~574 px, so a
 * non-wrapping strip would set the stage width and drag the fit scale from 0.61 down to 0.28 — the
 * scenario would be measured at a raster scale a third of the one the device actually uses, which is
 * the exact failure `src/fit.ts` exists to prevent.
 */
export function churnCells(
  params: { surfaces?: unknown; overlap?: unknown; churn?: unknown },
  layout: StageLayout,
): { left: number; top: number }[] {
  const count = Math.max(0, Number(params.churn ?? 0) || 0);
  const grid = surfaceGridSize(params, layout);
  const usable = Math.max(
    CHURN_WIDTH,
    grid.width - SURFACE_PAD_PX * 2 + CHURN_GAP,
  );
  const perRow = Math.max(1, Math.floor(usable / (CHURN_WIDTH + CHURN_GAP)));
  const top0 = grid.height + CHURN_MARGIN;
  return Array.from({ length: count }, (_, index) => ({
    left: SURFACE_PAD_PX + (index % perRow) * (CHURN_WIDTH + CHURN_GAP),
    top: top0 + Math.floor(index / perRow) * (CHURN_HEIGHT + CHURN_GAP),
  }));
}

/**
 * Draw surface `index`'s frame into the shared source canvas.
 *
 * Content comes from the atlas fixture (real, textured, expensive-to-encode pixels — a flat fill
 * would compress to nothing and understate every arm), plus a per-surface tint and, when `alpha` is
 * on, a transparent notch. The centre is always left fully opaque so the presence guard can sample
 * it: a hollow surface would report a correct render as a blank page, exactly as the atlas
 * generator's opaque cores exist to prevent.
 */
function drawSourceFrame(
  ctx: ScenarioContext,
  state: State,
  index: number,
  generation: number,
): void {
  const context = state.sourceCtx;
  const size = state.source.width;
  const alpha = boolParam(ctx.params.alpha);
  context.globalAlpha = 1;
  context.clearRect(0, 0, size, size);
  if (!alpha) {
    context.fillStyle = "#101018";
    context.fillRect(0, 0, size, size);
  }
  if (state.bitmap) {
    const region =
      ctx.fixture.regions[
        (index * 7 + 3 + generation * 11) % ctx.fixture.regions.length
      ];
    context.drawImage(
      state.bitmap,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      size,
      size,
    );
  }
  const hue = (index * 37 + generation * 53) % 360;
  context.globalAlpha = 0.4;
  context.fillStyle = `hsl(${hue} 70% 50%)`;
  context.fillRect(0, 0, size, size);
  context.globalAlpha = 1;
  if (alpha) {
    // A transparent notch, so the arms are compared on content that really has an alpha channel.
    context.clearRect(0, 0, Math.round(size * 0.22), Math.round(size * 0.22));
  }
  // The opaque core the presence guard samples.
  context.fillStyle = `hsl(${hue} 85% 60%)`;
  context.beginPath();
  context.arc(size / 2, size / 2, size * 0.16, 0, Math.PI * 2);
  context.fill();
}

/**
 * Draw the frame surface `index` should show, into the shared source.
 *
 * Under `sharedFrames` there is only ONE frame, so this collapses to "draw generation `g` once" and
 * every later caller in the same generation is a no-op — the surfaces genuinely share a frame rather
 * than each redrawing an identical one, which is what makes the arm's encode count fall to 1.
 */
function drawFrameFor(
  ctx: ScenarioContext,
  state: State,
  index: number,
  generation: number,
): void {
  if (!state.shared) {
    drawSourceFrame(ctx, state, index, generation);
    return;
  }
  if (state.sharedGeneration === generation) {
    return;
  }
  state.sharedGeneration = generation;
  drawSourceFrame(ctx, state, 0, generation);
}

/** Encode the shared source's current pixels, on this arm's thread. */
function bakeSource(ctx: ScenarioContext, state: State): Promise<Blob> {
  const mechanism = mechanismOf(ctx);
  const mime = blobTypeFor(mechanism);
  const quality = blobQualityFor(mechanism);
  return state.encoder
    ? state.encoder.encode(state.source, mime, quality)
    : canvasToBlob(state.source, mime, quality);
}

/**
 * The ONE blob URL for shared generation `generation`, encoded at most once.
 *
 * Deduplicated by promise, not by result: N surfaces reach this within the same frame, and a check
 * on a finished URL would let all N start their own encode before the first one resolved.
 */
function sharedFrameUrl(
  ctx: ScenarioContext,
  state: State,
  generation: number,
): Promise<string> {
  if (state.sharedBake?.generation === generation) {
    return state.sharedBake.url;
  }
  const url = bakeSource(ctx, state).then((blob) => {
    const created = URL.createObjectURL(blob);
    state.sharedUrls.push(created);
    return created;
  });
  state.sharedBake = { generation, url };
  return url;
}

/** Show the shared source's current frame on one surface, by whichever mechanism this arm is. */
async function present(
  ctx: ScenarioContext,
  state: State,
  surface: Surface,
  generation: number,
): Promise<void> {
  if (surface.ctx2d) {
    surface.ctx2d.clearRect(0, 0, SURFACE_PX, SURFACE_PX);
    surface.ctx2d.drawImage(state.source, 0, 0);
    return;
  }
  if (surface.bitmapCtx) {
    // `transferFromImageBitmap` NEUTERS its argument, so every surface needs its OWN bitmap and the
    // clone is part of this arm's real price. Charging it here rather than hoisting it is the point:
    // one shared `ImageBitmap` cannot be transferred to N nodes.
    surface.bitmapCtx.transferFromImageBitmap(
      await createImageBitmap(state.source),
    );
    return;
  }

  const image = surface.display as HTMLImageElement;
  const epoch = ++state.epoch[surface.index];
  const url = state.shared
    ? await sharedFrameUrl(ctx, state, generation)
    : URL.createObjectURL(await bakeSource(ctx, state));
  if (state.epoch[surface.index] !== epoch) {
    // A newer frame landed while this one was encoding. Dropping it is what a real renderer does,
    // and letting it through would put a stale frame on screen at a cost nobody asked for.
    if (!state.shared) {
      URL.revokeObjectURL(url);
    }
    return;
  }
  await new Promise<void>((res) => {
    image.onload = () => res();
    image.onerror = () => res();
    image.src = url;
  });
  if (state.shared) {
    // Shared URLs are owned by `state.sharedUrls` and revoked at teardown; a per-surface revoke here
    // would pull the resource out from under every OTHER surface showing the same frame.
    return;
  }
  if (surface.url) {
    URL.revokeObjectURL(surface.url);
  }
  surface.url = url;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  return new Promise((res, rej) => {
    const settle = (blob: Blob | null) => {
      if (blob) {
        res(blob);
      } else {
        rej(new Error(`static-surfaces: toBlob("${type}") returned null`));
      }
    };
    if (quality === undefined) {
      canvas.toBlob(settle, type);
    } else {
      canvas.toBlob(settle, type, quality);
    }
  });
}

export const staticSurfaces: Scenario = {
  name: "static-surfaces",
  params: STATIC_SURFACES_PARAMS,

  mount(ctx: ScenarioContext): void {
    const count = Number(ctx.params.surfaces);
    const overlap = boolParam(ctx.params.overlap);
    const alpha = boolParam(ctx.params.alpha);
    const mechanism = mechanismOf(ctx);
    const { columns } = surfaceGridShape(ctx.params, ctx.layout);

    const container = document.createElement("div");
    container.id = "perf-stage";
    container.style.position = "absolute";
    container.style.inset = "0";
    ctx.root.appendChild(container);

    const source = document.createElement("canvas");
    source.width = SURFACE_PX;
    source.height = SURFACE_PX;
    const sourceCtx = source.getContext("2d");
    if (!sourceCtx) {
      throw new Error(
        "static-surfaces: no 2d context on the shared source canvas",
      );
    }

    const surfaces: Surface[] = [];
    for (let index = 0; index < count; index++) {
      const { left, top } = surfaceBox(index, columns, overlap);
      const element = document.createElement("div");
      element.className = "surface";
      element.style.position = "absolute";
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.style.width = `${SURFACE_PX}px`;
      element.style.height = `${SURFACE_PX}px`;

      let display: HTMLCanvasElement | HTMLImageElement;
      let ctx2d: CanvasRenderingContext2D | undefined;
      let bitmapCtx: ImageBitmapRenderingContext | undefined;
      if (usesImgElement(mechanism)) {
        const image = document.createElement("img");
        image.width = SURFACE_PX;
        image.height = SURFACE_PX;
        image.style.display = "block";
        display = image;
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = SURFACE_PX;
        canvas.height = SURFACE_PX;
        canvas.style.width = `${SURFACE_PX}px`;
        canvas.style.height = `${SURFACE_PX}px`;
        canvas.style.display = "block";
        display = canvas;
        // Contexts are created ONCE, here. A canvas's context type is permanent, and `alpha: false`
        // has to be asked for at creation — re-deriving it per frame would both cost a lookup and
        // silently give the opaque arm a transparent backing store.
        if (mechanism === "canvas-bitmaprenderer") {
          bitmapCtx = canvas.getContext("bitmaprenderer") ?? undefined;
          if (!bitmapCtx) {
            throw new Error(
              "static-surfaces: this browser has no ImageBitmapRenderingContext — the whole arm is unmeasurable here, and a silent fallback to 2d would report it as measured",
            );
          }
        } else {
          ctx2d = canvas.getContext("2d", { alpha }) ?? undefined;
          if (!ctx2d) {
            throw new Error(
              "static-surfaces: no 2d context on a surface canvas",
            );
          }
        }
      }
      element.appendChild(display);
      container.appendChild(element);
      surfaces.push({
        element,
        display,
        ctx2d,
        bitmapCtx,
        index,
        lastUpdateMs: 0,
        url: undefined,
        encoding: false,
      });
    }

    // The churn: content with nothing to do with the surfaces, invalidated every single frame. This
    // is the "while the DOM renders other things" half of the question — without it every arm would
    // sit at the compositor's idle rate and the table would read as a tie.
    const churn: HTMLElement[] = [];
    for (const { left, top } of churnCells(ctx.params, ctx.layout)) {
      const cell = document.createElement("div");
      cell.className = "churn";
      cell.style.position = "absolute";
      cell.style.left = `${left}px`;
      cell.style.top = `${top}px`;
      cell.style.width = `${CHURN_WIDTH}px`;
      cell.style.height = `${CHURN_HEIGHT}px`;
      cell.style.backgroundColor = "#404058";
      container.appendChild(cell);
      churn.push(cell);
    }

    const state: State = {
      surfaces,
      container,
      churn,
      source,
      sourceCtx,
      bitmap: undefined,
      prepared: undefined,
      epoch: new Array(count).fill(0),
      encoder: usesWorkerBake(mechanism)
        ? createEncoderPool(Number(ctx.params.bakeWorkers))
        : undefined,
      shared: boolParam(ctx.params.sharedFrames),
      sharedGeneration: -1,
      sharedBake: undefined,
      sharedUrls: [],
    };
    state.prepared = prepareSurfaces(ctx, state);
    states.set(ctx.root, state);
  },

  async ready(ctx: ScenarioContext): Promise<void> {
    const state = states.get(ctx.root);
    if (!state?.prepared) {
      throw new Error("static-surfaces: ready() called before mount()");
    }
    await state.prepared;
  },

  step(ctx: ScenarioContext, frame: number): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    for (let index = 0; index < state.churn.length; index++) {
      const hue = (frame * 7 + index * 23) % 360;
      state.churn[index].style.backgroundColor = `hsl(${hue} 45% 42%)`;
    }

    const cadence = Number(ctx.params.updateEveryMs);
    if (!(cadence > 0)) {
      // The strictly-static case: the surfaces are FINISHED. Nothing here touches them, which is the
      // whole experiment.
      return;
    }
    const now = performance.now();
    const generation = Math.floor(now / cadence);
    for (const surface of state.surfaces) {
      if (surface.lastUpdateMs === 0) {
        // Staggered, so N surfaces never regenerate on the same frame — a synchronised burst would
        // measure one enormous spike instead of the sustained cost of an occasional update.
        surface.lastUpdateMs =
          now - (surface.index / state.surfaces.length) * cadence;
        continue;
      }
      if (now - surface.lastUpdateMs < cadence || surface.encoding) {
        continue;
      }
      surface.lastUpdateMs = now;
      surface.encoding = true;
      drawFrameFor(ctx, state, surface.index, generation);
      void present(ctx, state, surface, generation).finally(() => {
        surface.encoding = false;
      });
    }
  },

  teardown(ctx: ScenarioContext): void {
    const state = states.get(ctx.root);
    if (!state) {
      return;
    }
    for (const surface of state.surfaces) {
      if (surface.url) {
        URL.revokeObjectURL(surface.url);
      }
    }
    for (const url of state.sharedUrls) {
      URL.revokeObjectURL(url);
    }
    state.encoder?.terminate();
    state.bitmap?.close?.();
    state.container.remove();
    states.delete(ctx.root);
  },

  samplePoints(ctx: ScenarioContext): { x: number; y: number }[] {
    const count = Number(ctx.params.surfaces);
    const overlap = boolParam(ctx.params.overlap);
    const { columns } = surfaceGridShape(ctx.params, ctx.layout);
    const points: { x: number; y: number }[] = [];
    for (let index = 0; index < count; index++) {
      const { left, top } = surfaceBox(index, columns, overlap);
      points.push({ x: left + SURFACE_PX / 2, y: top + SURFACE_PX / 2 });
    }
    return points;
  },

  stageSize(params: Record<string, ParamValue>, layout: StageLayout) {
    const grid = surfaceGridSize(params, layout);
    const cells = churnCells(params, layout);
    const churnRight = cells.reduce(
      (max, cell) => Math.max(max, cell.left + CHURN_WIDTH),
      0,
    );
    const churnBottom = cells.reduce(
      (max, cell) => Math.max(max, cell.top + CHURN_HEIGHT),
      grid.height,
    );
    return {
      width: Math.max(grid.width, churnRight + SURFACE_PAD_PX),
      height: churnBottom + STAGE_MARGIN,
    };
  },

  gridShape(params: Record<string, ParamValue>, layout: StageLayout) {
    return surfaceGridShape(params, layout);
  },
};

/**
 * Bring every surface to its FINISHED state before the measured window opens.
 *
 * The img arms' encode is deliberately inside `readyMs` for exactly that reason. A scenario that
 * measured setup cost inside the window would answer a question this one is not asking — the probe
 * already measured encoding, and what is under measurement here is what happens AFTERWARDS.
 */
async function prepareSurfaces(
  ctx: ScenarioContext,
  state: State,
): Promise<void> {
  const response = await fetch(ctx.fixture.pageUrl);
  state.bitmap = await createImageBitmap(await response.blob());
  const serial = boolParam(ctx.params.serialBake);
  // ISSUED CONCURRENTLY, and the worker arm is unmeasurable without it. Awaiting each bake before
  // starting the next leaves the main thread idle for the whole of every worker round trip, so a
  // serial prepare makes the worker arm strictly slower than the inline one BY CONSTRUCTION — a null
  // result the schedule manufactured rather than one the mechanism earned. The same schedule is
  // applied to every arm, so the comparison stays like-for-like, and `serialBake=true` reproduces
  // the previous rounds' one-at-a-time numbers.
  //
  // Overlapping is safe because both capture paths snapshot the shared source at CALL time in Blink
  // — `HTMLCanvasElement.toBlob` hands `CanvasAsyncBlobCreator` a snapshot taken synchronously, and
  // `createImageBitmap(canvas)` copies the canvas on the calling thread before going async. Every
  // `present` branch therefore runs to its first `await` with the pixels already taken, and the next
  // iteration's `drawFrameFor` cannot overwrite a frame still in flight. That is an implementation
  // guarantee of the browser this harness drives, not a promise the spec makes.
  const pending: Promise<void>[] = [];
  for (const surface of state.surfaces) {
    drawFrameFor(ctx, state, surface.index, 0);
    const done = present(ctx, state, surface, 0);
    if (serial) {
      await done;
    } else {
      pending.push(done);
    }
  }
  await Promise.all(pending);
}
