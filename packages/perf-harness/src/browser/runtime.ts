// In-page driver. Bundled by esbuild and served over real http:// (never a data: or about:blank
// document — image decode and HTTP caching behave differently there, and those are precisely what is
// being measured).
//
// The node side never inspects the DOM to decide when things happened. It reads:
//   * `performance.mark("scenario:mount")` / `("scenario:ready")` — the two marks the analyzer
//     anchors the initial-render window on, visible in the trace as blink.user_timing events;
//   * `window.__perfHarness` — the JS-visible seam (readyMs, frame count, LoAF blocking, sample
//     points), resolved when the measured window ends.

import {
  fitStage,
  identityFit,
  mapStagePoint,
  pointsOutsideStage,
  type StageFit,
} from "../fit";
import { getScenario } from "../scenarios";
import type {
  AtlasFixtureView,
  ParamValue,
  ScenarioContext,
  StageLayout,
} from "../scenarios/types";

/** The geometry a run was actually measured at. Reported, never assumed — see fit.ts. */
export interface PerfRunFit {
  /** Whether the stage was fitted at all (`?fit=1`), or used the viewport 1:1. */
  enabled: boolean;
  scale: number;
  stage: { width: number; height: number };
  fitted: { width: number; height: number };
  offset: { x: number; y: number };
  orientation: "portrait" | "landscape" | "square";
  /** False when the fitted stage still overflows the viewport — a scenario failure, reported. */
  fits: boolean;
  /**
   * Sample points the scenario placed OUTSIDE its own declared stage box. Non-zero means the
   * scenario under-declared `stageSize`, so the stage's clip is eating content: a defect in the
   * scenario, and the number that says so instead of a mystery presence miss.
   */
  samplePointsOutsideStage: number;
  /**
   * The grid the scenario laid its cells out in. The CELL COUNT is fixed by the parameters; only the
   * SHAPE follows the viewport, so this says how the same work was arranged rather than how much of
   * it there was.
   */
  grid: { columns: number; rows: number } | null;
}

export interface PerfRunResult {
  scenario: string;
  params: Record<string, ParamValue>;
  readyMs: number;
  windowMs: number;
  frames: number;
  blockedMs: number;
  longAnimationFrames: number;
  longTaskCount: number;
  longTaskMs: number;
  /** VIEWPORT-space CSS px, already mapped through the fit — what the screenshot can be checked at. */
  samplePoints: { x: number; y: number }[];
  /**
   * The scenario's own counters (`Scenario.metrics`), or `null` when it declares none.
   *
   * `null`, never `{}`: an absent block means NOT MEASURED, and a scenario that reports no counters
   * must not be made to look like one that counted zero of everything.
   */
  scenarioMetrics: Record<string, number> | null;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  fit: PerfRunFit;
  timeOrigin: number;
  markMountMs: number;
  markReadyMs: number;
}

export interface PerfHarnessSeam {
  version: 1;
  ready: boolean;
  error: string | null;
  params: Record<string, ParamValue>;
  run(durationMs?: number): Promise<PerfRunResult>;
  result: PerfRunResult | null;
}

declare global {
  interface Window {
    __perfHarness?: PerfHarnessSeam;
  }
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
}

const loaf = { count: 0, blockedMs: 0 };
const longTasks = { count: 0, totalMs: 0 };

function installObservers(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LoafEntry[]) {
        loaf.count++;
        loaf.blockedMs += entry.blockingDuration ?? 0;
      }
    });
    // `long-animation-frame` reports blockingDuration — how long the frame was actually PREVENTED
    // from being produced — which is the JS-visible complement to the trace's activation gaps.
    observer.observe({
      type: "long-animation-frame",
      buffered: true,
    } as PerformanceObserverInit);
  } catch {
    // older Chrome without LoAF: blockedMs stays 0 and the report says so
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.count++;
        longTasks.totalMs += entry.duration;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // no longtask support
  }
}

/**
 * The scenario parameters, out of the query string.
 *
 * `"true"` and `"false"` become BOOLEANS. Every value arrives as a string — `scenarioUrl` builds
 * the query with `String(value)` — and the node side coerces against each scenario's declared
 * default in `resolveParams`, but this side has no schema to coerce against. Left as strings, a
 * scenario's obvious test (`params.flag !== false`, or `if (params.flag)`) reads `"false"` as TRUE,
 * so the run silently measures the default configuration while the report faithfully records the
 * parameter that was asked for. Measured: `--param bakeRotation=false` produced a run byte-identical
 * to `bakeRotation=true`, with `bakeRotation: false` written in its own JSON.
 *
 * Safe as a blanket rule because no scenario declares a STRING parameter whose legal values include
 * "true" or "false" — they are mechanism names and enum tags — and a scenario that reads a boolean
 * the defensive way (`value === true || value === "true"`) is unaffected either way.
 */
export function readParams(): Record<string, ParamValue> {
  const search = new URLSearchParams(window.location.search);
  const params: Record<string, ParamValue> = {};
  for (const [key, value] of search) {
    params[key] =
      value === "true"
        ? true
        : value === "false"
          ? false
          : /^-?\d+(\.\d+)?$/.test(value)
            ? Number(value)
            : value;
  }
  return params;
}

async function loadFixture(): Promise<AtlasFixtureView> {
  const response = await fetch("/fixture/atlas.json");
  if (!response.ok) {
    throw new Error(`fixture fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    pageSize: number;
    regions: { x: number; y: number; width: number; height: number }[];
    background: { width: number; height: number } | null;
  };
  // Cache-busted per document so every repeat pays a COLD decode. Chrome's decoded-image cache
  // survives navigation, and reusing the same URL would silently erase the single number this
  // harness exists to measure.
  const bust = encodeURIComponent(
    new URLSearchParams(window.location.search).get("cacheBust") ?? "0",
  );
  return {
    pageUrl: `/fixture/atlas.png?v=${bust}`,
    pageSize: { width: data.pageSize, height: data.pageSize },
    regions: data.regions,
    ...(data.background
      ? {
          background: {
            url: `/fixture/background.png?v=${bust}`,
            width: data.background.width,
            height: data.background.height,
          },
        }
      : {}),
  };
}

function nextFrame(): Promise<number> {
  return new Promise((res) => requestAnimationFrame(res));
}

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Build the letterboxed stage, exactly the way the consuming project's client does: the host element
 * becomes a centring frame that CLIPS, and the stage keeps its px layout under a
 * `transform: scale()`. Same shape as godot-scene-web's own `contentScaleStageStyle` /
 * `observeContentScale` transform technique, so the harness rasters the way the client rasters.
 *
 * `transform-origin` is TOP LEFT, not the client's `center`, and the stage is positioned by explicit
 * offsets rather than flex centring: with a top-left origin a stage point maps to the viewport by
 * `offset + point * scale`, which is the mapping the presence guard uses. Centring is preserved
 * (the offsets ARE the centred position) — only the arithmetic is made checkable.
 */
function mountFitStage(frame: HTMLElement, fit: StageFit): HTMLElement {
  frame.style.overflow = "hidden";
  const stage = document.createElement("div");
  stage.id = "perf-fit-stage";
  stage.style.position = "absolute";
  stage.style.left = `${fit.offset.x}px`;
  stage.style.top = `${fit.offset.y}px`;
  stage.style.width = `${fit.stage.width}px`;
  stage.style.height = `${fit.stage.height}px`;
  stage.style.transformOrigin = "0 0";
  if (fit.scale !== 1) {
    stage.style.transform = `scale(${fit.scale})`;
  }
  // The game's own viewport clip: anything a scenario parks outside its declared stage is hidden
  // here rather than bleeding over the letterbox bars.
  stage.style.overflow = "hidden";
  frame.appendChild(stage);
  return stage;
}

export async function installPerfHarness(): Promise<void> {
  installObservers();
  const params = readParams();
  const scenarioName = String(params.scenario ?? "atlas-sprites");
  const durationDefault = Number(params.durationMs ?? 2500);

  const seam: PerfHarnessSeam = {
    version: 1,
    ready: false,
    error: null,
    params,
    result: null,
    run: () => Promise.reject(new Error("perf harness not initialised")),
  };
  window.__perfHarness = seam;

  let fixture: AtlasFixtureView;
  try {
    fixture = await loadFixture();
  } catch (error) {
    seam.error = error instanceof Error ? error.message : String(error);
    return;
  }

  const scenario = getScenario(scenarioName);
  const frame = document.getElementById("root") ?? document.body;

  // FIT, OR NOT. `?fit=1` scales the scenario's declared stage into the real viewport (see fit.ts);
  // without it the scenario gets the viewport itself and nothing at all is inserted between it and
  // `#root` — an unfitted run is byte-identical to the pre-fit harness, which is what keeps the
  // committed desktop baseline comparable.
  const fitEnabled = params.fit === 1 || params.fit === "1";
  const layout: StageLayout = { viewport: viewportSize(), fit: fitEnabled };
  const fit = fitEnabled
    ? fitStage(scenario.stageSize(params, layout), layout.viewport)
    : identityFit(layout.viewport);
  const root = fitEnabled ? mountFitStage(frame, fit) : frame;
  const grid = scenario.gridShape?.(params, layout) ?? null;

  seam.run = async (durationMs = durationDefault): Promise<PerfRunResult> => {
    loaf.count = 0;
    loaf.blockedMs = 0;
    longTasks.count = 0;
    longTasks.totalMs = 0;

    const ctx: ScenarioContext = {
      root: root as HTMLElement,
      params,
      fixture,
      layout,
      stage: { width: fit.stage.width, height: fit.stage.height },
      mark: (name) => performance.mark(name),
    };

    performance.mark("scenario:mount");
    const mountAt = performance.now();
    scenario.mount(ctx);
    await scenario.ready(ctx);
    performance.mark("scenario:ready");
    const readyAt = performance.now();

    const windowStart = performance.now();
    let frames = 0;
    for (;;) {
      const now = await nextFrame();
      if (performance.now() - windowStart >= durationMs) {
        break;
      }
      scenario.step?.(ctx, frames);
      frames++;
      void now;
    }
    const windowEnd = performance.now();

    // The scenario's own counters, read ONCE, here: the window has closed, so the numbers describe
    // exactly the interval the trace was taken over, and nothing the read-out itself costs lands
    // inside it. Passed through VERBATIM — a scrubbed or defaulted counter would be a number this
    // harness invented, and the report validator is where a non-finite one gets named.
    const scenarioMetrics = scenario.metrics?.(ctx) ?? null;

    // Sample points come back in STAGE space (every scenario's own coordinates, unchanged by the
    // fit) and are mapped to viewport space here — the one place the two coordinate systems meet.
    // The stage's MEASURED rect wins over the computed offset: it is what the screenshot will show,
    // and a stage that ended up somewhere else must fail the guard rather than be checked against
    // where it was supposed to be.
    const stagePoints = scenario.samplePoints(ctx);
    const measured = fitEnabled
      ? (root as HTMLElement).getBoundingClientRect()
      : undefined;
    const placed: StageFit = measured
      ? { ...fit, offset: { x: measured.left, y: measured.top } }
      : fit;
    const outside = pointsOutsideStage(stagePoints, fit.stage);

    const result: PerfRunResult = {
      scenario: scenario.name,
      params,
      readyMs: readyAt - mountAt,
      windowMs: windowEnd - windowStart,
      frames,
      blockedMs: loaf.blockedMs,
      longAnimationFrames: loaf.count,
      longTaskCount: longTasks.count,
      longTaskMs: longTasks.totalMs,
      samplePoints: fitEnabled
        ? stagePoints.map((point) => mapStagePoint(point, placed))
        : stagePoints,
      scenarioMetrics,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fit: {
        enabled: fitEnabled,
        scale: placed.scale,
        stage: placed.stage,
        fitted: placed.fitted,
        offset: placed.offset,
        orientation: placed.orientation,
        fits: placed.fits,
        samplePointsOutsideStage: outside.length,
        grid,
      },
      timeOrigin: performance.timeOrigin,
      markMountMs: mountAt,
      markReadyMs: readyAt,
    };
    seam.result = result;
    return result;
  };

  seam.ready = true;

  if (params.autorun === 1 || params.autorun === "1") {
    // --serve mode: an external browser (chrome-devtools-mcp, a phone) should see the scenario
    // actually running without anyone driving it over CDP.
    void seam.run().then(() => {
      void 0;
    });
  }
}
