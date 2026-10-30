// PHN's phone page (scripts/client-device-check.ts, results/p3/phn.md): mounts the render-stream
// client package as a full-screen phone viewer would -- the canvas fills the viewport at the
// presentation's aspect, its backing store at the device pixel ratio -- and exposes
// mount/dispose/stats plus the page-side probes (probe.ts) to the driver. Like web/client-check/,
// it loads the package and nothing of the harness receiver.

import { probe } from "./probe";
import {
  createRenderStreamClient,
  type RenderStreamClient,
  type RenderStreamCore,
  type RenderStreamEndpoint,
  type RenderStreamStatus,
} from "../../../../packages/render-stream-client/src/index";

interface Mounted {
  client: RenderStreamClient;
  canvas: HTMLCanvasElement;
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
  mount(o: {
    endpoint: RenderStreamEndpoint;
    core: RenderStreamCore;
    creditWindow: 1 | 2;
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
    document.body.append(canvas);
    mountAt[mount] = performance.now();
    let client: RenderStreamClient | null = null;
    client = createRenderStreamClient({
      canvas,
      core: o.core,
      endpoint: o.endpoint,
      creditWindow: o.creditWindow,
      creditStage: o.creditStage,
      applyOn: o.applyOn,
      onStatus: (s) => {
        statuses.push({ ...s, t: performance.now(), mount });
        if (s.kind === "connecting" && heapAtStart[mount] === undefined) {
          const heap = client?.stats().heapBytes ?? 0;
          if (heap > 0) heapAtStart[mount] = heap;
        }
      },
    });
    client.connect();
    mounted = { client, canvas };
    return box;
  },
  dispose() {
    if (!mounted) return;
    mounted.client.dispose();
    mounted.canvas.remove();
    mounted = null;
  },
  stats() {
    return mounted ? { ...mounted.client.stats(), t: performance.now() } : null;
  },
};

(window as unknown as { __rsc: typeof api }).__rsc = api;
