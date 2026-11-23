// PHN's phone page (scripts/client-device-check.ts): mounts the render-stream
// client package as a full-screen phone viewer would -- the canvas fills the viewport at the
// presentation's aspect, its backing store at the device pixel ratio -- and exposes
// mount/dispose/stats plus the page-side probes (probe.ts) to the driver. Like web/client-check/,
// it loads the package and nothing of the harness receiver.

import {
  createRenderStreamClient,
  type RenderStreamClient,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamStatus,
} from "../../../../packages/render-stream-client/src/index";
import { carrierTransport } from "../../../../packages/render-stream-client/src/transport";
import { delayTransport } from "../../scripts/lib/delay-transport";
import { createGpuLoad } from "../pace-model/gpu-load";
import type { Calibration, Segment } from "../pace-model/probe";
import { type GpuLoadMode, gpuLoadLoop } from "./gpu-load-loop";
import { probe } from "./probe";

interface Mounted {
  client: RenderStreamClient | null;
  canvas: HTMLCanvasElement;
  loadCanvas: HTMLCanvasElement | null;
  stopLoad: () => void;
  recorder: number;
  drawTimes: number[];
  firstFrameAt: number | null;
  fallbackAt: number | null;
  calibration: Calibration | null;
}

let mounted: Mounted | null = null;
const statuses: (RenderStreamStatus & { t: number; mount: number })[] = [];
let mounts = 0;
const heapAtStart: Record<number, number> = {};
const mountAt: Record<number, number> = {};

/** The canvas's CSS box (the viewport, letterboxed to `aspect`) and its backing store. */
function layout(aspect: number, backingScale: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(vw, vh * aspect);
  const h = w / aspect;
  const dpr = window.devicePixelRatio * backingScale;
  return {
    css: [Math.round(w), Math.round(h)] as [number, number],
    backing: [Math.round(w * dpr), Math.round(h * dpr)] as [number, number],
  };
}

const api = {
  ready: true,
  probe,
  statuses,
  heapAtStart,
  mountAt,
  async mount(o: {
    endpoint: RenderStreamEndpoint;
    core: RenderStreamCore;
    creditWindow?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    pacing?: "fidelity" | "balanced";
    oneWayMs?: number;
    gpuLoadHz?: number;
    gpuLoadMode?: GpuLoadMode;
    /** PH3: the client's pacing options (undefined: the package's defaults). */
    creditStage?: "submitted" | "applied";
    applyOn?: "frame" | "message";
    /** 1 = the device pixel ratio (native resolution); < 1 renders smaller and lets CSS scale. */
    backingScale?: number;
  }) {
    if (mounted) throw new Error("already mounted");
    const mount = ++mounts;
    const p = o.endpoint.presentation ?? [1920, 1080];
    const box = layout(p[0] / p[1], o.backingScale ?? 1);
    const canvas = document.createElement("canvas");
    canvas.style.width = `${box.css[0]}px`;
    canvas.style.height = `${box.css[1]}px`;
    canvas.width = box.backing[0];
    canvas.height = box.backing[1];
    canvas.style.position = "relative";
    canvas.style.zIndex = "1";
    const session: Mounted = {
      client: null,
      canvas,
      loadCanvas: null,
      stopLoad: () => {},
      recorder: 0,
      drawTimes: [],
      firstFrameAt: null,
      fallbackAt: null,
      calibration: null,
    };
    mounted = session;
    try {
      let loadStreaming = () => {};
      if (o.gpuLoadHz !== undefined) {
        const loadCanvas = document.createElement("canvas");
        session.loadCanvas = loadCanvas;
        loadCanvas.style.cssText =
          "position:fixed;inset:0;width:100%;height:100%;z-index:0";
        loadCanvas.width = Math.round(innerWidth * devicePixelRatio);
        loadCanvas.height = Math.round(innerHeight * devicePixelRatio);
        document.body.append(loadCanvas);
        const gl = loadCanvas.getContext("webgl2", { antialias: false });
        if (!gl)
          throw new Error("client-phone: WebGL2 unavailable for GPU load");
        const load = createGpuLoad(gl);
        session.stopLoad = () =>
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        session.calibration = await load.calibrate(o.gpuLoadHz, {
          sample: (iterations) =>
            new Promise<Segment>((resolve, reject) => {
              if (mounted !== session) {
                reject(new Error("client-phone: mount disposed"));
                return;
              }
              const startMs = performance.now();
              const ts: number[] = [];
              const durationMs: number[] = [];
              let raf = 0;
              const frame = (t: number) => {
                const begin = performance.now();
                load.draw(iterations, t);
                ts.push(t);
                durationMs.push(performance.now() - begin);
                raf = requestAnimationFrame(frame);
              };
              const timer = setTimeout(() => {
                cancelAnimationFrame(raf);
                resolve({
                  startMs,
                  endMs: performance.now(),
                  options: { seconds: 2, draw: "every" },
                  iterations,
                  ts,
                  drew: ts.map(() => 1),
                  durationMs,
                  ping: { postMs: [], delayMs: [] },
                });
              }, 2000);
              session.stopLoad = () => {
                cancelAnimationFrame(raf);
                clearTimeout(timer);
                gl.getExtension("WEBGL_lose_context")?.loseContext();
                reject(new Error("client-phone: calibration disposed"));
              };
              raf = requestAnimationFrame(frame);
            }),
        });
        if (mounted !== session)
          throw new Error("client-phone: mount disposed");
        const iterations = session.calibration.iterations;
        const loop = gpuLoadLoop(
          o.gpuLoadMode ?? "coupled",
          (t) => load.draw(iterations, t),
          () => session.client?.stats().draws ?? 0,
        );
        loadStreaming = () => loop.streaming();
        session.stopLoad = () => {
          loop.stop();
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        };
      }
      // Calibration runs with the load alone. The stream canvas is added afterward.
      document.body.append(canvas);
      mountAt[mount] = performance.now();
      let client: RenderStreamClient | null = null;
      client = createRenderStreamClient({
        canvas,
        core: o.core,
        endpoint: o.endpoint,
        ...(o.pacing
          ? { pacing: o.pacing }
          : {
              creditWindow: o.creditWindow,
              creditStage: o.creditStage,
            }),
        ...(o.oneWayMs && o.oneWayMs > 0
          ? {
              transport: delayTransport(
                carrierTransport("websocket"),
                o.oneWayMs,
              ),
            }
          : {}),
        applyOn: o.applyOn,
        onStatus: (s) => {
          statuses.push({ ...s, t: performance.now(), mount });
          if (s.kind === "streaming" && !s.firstFrame) loadStreaming();
          if (s.kind === "connecting" && heapAtStart[mount] === undefined) {
            const heap = client?.stats().heapBytes ?? 0;
            if (heap > 0) heapAtStart[mount] = heap;
          }
        },
      });
      client.connect();
      session.client = client;
      let draws = 0;
      const record = () => {
        const s = client.stats();
        const currentDraws = s.draws ?? 0;
        const t = performance.now();
        if (currentDraws > draws) {
          session.drawTimes.push(t);
          session.firstFrameAt ??= t;
        }
        draws = currentDraws;
        if (s.pacingFallback && session.fallbackAt === null)
          session.fallbackAt = t;
        session.recorder = requestAnimationFrame(record);
      };
      session.recorder = requestAnimationFrame(record);
      return box;
    } catch (error) {
      if (mounted === session) api.dispose();
      throw error;
    }
  },
  dispose() {
    if (!mounted) return;
    mounted.client?.dispose();
    cancelAnimationFrame(mounted.recorder);
    mounted.stopLoad();
    mounted.loadCanvas?.remove();
    mounted.canvas.remove();
    mounted = null;
  },
  recording() {
    return mounted
      ? {
          t: performance.now(),
          mountAt: mountAt[mounts],
          drawTimes: [...mounted.drawTimes],
          firstFrameAt: mounted.firstFrameAt,
          fallbackAt: mounted.fallbackAt,
          calibration: mounted.calibration,
        }
      : null;
  },
  stats() {
    return mounted?.client
      ? { ...mounted.client.stats(), t: performance.now() }
      : null;
  },
};

(window as unknown as { __rsc: typeof api }).__rsc = api;
