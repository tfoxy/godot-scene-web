// MIR-1's live check page (scripts/client-live-check.ts): mounts the render-stream client package
// exactly as a product page would, and exposes mount/dispose/stats to the driver. No harness code:
// the package is all it loads.

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
/** Per mount: the wasm heap when the loop first reports `connecting` (the fresh instance, before
 * any message). */
const heapAtStart: Record<number, number> = {};

const api = {
  ready: true,
  statuses,
  heapAtStart,
  mount(o: {
    endpoint: RenderStreamEndpoint;
    core: RenderStreamCore;
    creditWindow: 1 | 2;
  }) {
    if (mounted) throw new Error("already mounted");
    const mount = ++mounts;
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    let client: RenderStreamClient | null = null;
    client = createRenderStreamClient({
      canvas,
      core: o.core,
      endpoint: o.endpoint,
      creditWindow: o.creditWindow,
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
  },
  dispose() {
    if (!mounted) return;
    mounted.client.dispose();
    mounted.client.dispose(); // idempotent
    mounted.canvas.remove();
    mounted = null;
  },
  /** G7u through the package: lose the canvas's WebGL context, restore it after `ms`. */
  loseAndRestore(ms: number) {
    const gl = mounted?.canvas.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_lose_context");
    if (!ext) return false;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), ms);
    return true;
  },
  stats() {
    return mounted ? { ...mounted.client.stats() } : null;
  },
};

(window as unknown as { __rsc: typeof api }).__rsc = api;
