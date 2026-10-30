// createRenderStreamClient (mirror-client-design.md "API"): one canvas, one live stream, one wasm
// instance, released by `dispose()`.

import type { GswRs } from "./abi";
import { WasmStreamCore } from "./core";
import {
  type RenderStreamEndpoint,
  sameEndpoint,
  validateEndpoint,
} from "./endpoint";
import {
  CLIENT_INBOUND_BYTES,
  CLIENT_LIVE_CODING,
  coreStartOptions,
  gpuFormatsOf,
} from "./hello";
import { CoreLoadError, loadCore, type RenderStreamCore } from "./loader";
import {
  type ApplyOn,
  type CreditStage,
  type LoopClock,
  type RenderStreamStats,
  type RenderStreamStatus,
  StreamLoop,
} from "./loop";
import {
  type RenderStreamTransportFactory,
  webSocketTransport,
} from "./transport";

/** A product module attached to the stream (MIR-TAG designs it; MIR-1 accepts only `[]`). */
export interface RenderStreamExtension {
  id: string;
}

export interface RenderStreamClientOptions {
  canvas: HTMLCanvasElement;
  core: RenderStreamCore;
  endpoint: RenderStreamEndpoint;
  /** Default: WebSocket + fetch (`webSocketTransport`). */
  transport?: RenderStreamTransportFactory;
  /** Default []; MIR-1 requires []. */
  extensions?: readonly RenderStreamExtension[];
  /** The credit window asked in the hello (the session grants it); default 2. */
  creditWindow?: 1 | 2;
  /** PH3: the hello's credit stage, the ack the host's credit waits on; default `applied`. */
  creditStage?: CreditStage;
  /** PH3: where a ready transaction is applied: the next frame callback (`frame`) or its own
   * `onmessage` while frames run (`message`, the default; the draw stays on the frame callback). */
  applyOn?: ApplyOn;
  onStatus?: (s: RenderStreamStatus) => void;
}

export interface RenderStreamClient {
  /** Loads the core (once) and connects; again after `failed` or `ended`. */
  connect(): void;
  /** A changed descriptor reconnects with it (an idle, failed or ended client keeps it for the
   * next `connect`). Throws `RenderStreamEndpointError` for an invalid one. */
  setEndpoint(e: RenderStreamEndpoint): void;
  stats(): Readonly<RenderStreamStats>;
  /** Stops the frame loop, closes the connection (1000), aborts in-flight GETs, frees every
   * wasm-bindgen object, loses the WebGL context and drops the instance. Idempotent. */
  dispose(): void;
}

const pageClock: LoopClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function createRenderStreamClient(
  options: RenderStreamClientOptions,
): RenderStreamClient {
  if ((options.extensions?.length ?? 0) > 0)
    throw new TypeError(
      "render-stream client: extensions are not supported yet (pass [])",
    );
  const creditWindow = options.creditWindow ?? 2;
  if (creditWindow !== 1 && creditWindow !== 2)
    throw new TypeError("render-stream client: creditWindow must be 1 or 2");
  return new Client(options, validateEndpoint(options.endpoint), creditWindow);
}

const EMPTY_STATS: RenderStreamStats = Object.freeze({
  applied: 0,
  appliesPerSec: 0,
  creditRttMsP50: null,
  heapBytes: 0,
});

class Client implements RenderStreamClient {
  private loop: StreamLoop | null = null;
  private core: WasmStreamCore | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private readonly onLost = (e: Event) => {
    // Q5 "Context loss": keep the context restorable; the loop holds until the restore.
    e.preventDefault();
    this.loop?.contextLost();
  };
  private readonly onRestored = () => this.loop?.contextRestored();

  constructor(
    private readonly o: RenderStreamClientOptions,
    private endpoint: RenderStreamEndpoint,
    private readonly creditWindow: 1 | 2,
  ) {}

  connect(): void {
    if (this.disposed) return;
    if (this.loop !== null) {
      this.loop.connect();
      return;
    }
    if (this.loading !== null) return;
    this.status({ kind: "connecting" });
    this.loading = this.load().catch((e: unknown) => {
      this.loading = null;
      if (this.disposed) return;
      const reason = e instanceof NoWebgl2 ? "no-webgl2" : "core-load-failed";
      this.status({
        kind: "failed",
        reason,
        detail: e instanceof Error ? e.message : String(e),
      });
    });
  }

  setEndpoint(e: RenderStreamEndpoint): void {
    const next = validateEndpoint(e);
    if (sameEndpoint(next, this.endpoint)) return;
    this.endpoint = next;
    this.loop?.setEndpoint(next);
  }

  stats(): Readonly<RenderStreamStats> {
    return this.loop?.stats() ?? EMPTY_STATS;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.o.canvas;
    this.loop?.dispose();
    this.loop = null;
    canvas.removeEventListener("webglcontextlost", this.onLost);
    canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.core?.dispose();
    this.core = null;
    canvas
      .getContext("webgl2")
      ?.getExtension("WEBGL_lose_context")
      ?.loseContext();
  }

  private status(s: RenderStreamStatus): void {
    if (this.disposed) return;
    try {
      this.o.onStatus?.(s);
    } catch {
      // a product callback's error is not the stream's
    }
  }

  private async load(): Promise<void> {
    const { mod, memory } = await loadCore(this.o.core);
    if (this.disposed) return;
    const canvas = this.o.canvas;
    const protocol = this.endpoint.protocol;
    const presentation = this.endpoint.presentation;
    if (presentation) {
      canvas.width = presentation[0];
      canvas.height = presentation[1];
    }
    let g: GswRs;
    try {
      g = new mod.GswRs(canvas, coreStartOptions(protocol));
    } catch (e) {
      const probe = document.createElement("canvas").getContext("webgl2");
      probe?.getExtension("WEBGL_lose_context")?.loseContext();
      if (probe === null)
        throw new NoWebgl2("this browser gives no WebGL2 context");
      throw new CoreLoadError(`the core refused the canvas: ${String(e)}`);
    }
    if (presentation) g.set_window(presentation[0], presentation[1]);
    this.core = new WasmStreamCore(
      mod,
      memory,
      g,
      protocol,
      CLIENT_LIVE_CODING,
      CLIENT_INBOUND_BYTES,
    );
    // The module's own context (getContext returns the one it created).
    const gl = canvas.getContext("webgl2");
    const gpuFormats = gpuFormatsOf(gl?.getSupportedExtensions() ?? [], null);
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.loop = new StreamLoop({
      core: this.core,
      transport: this.o.transport ?? webSocketTransport,
      endpoint: this.endpoint,
      creditWindow: this.creditWindow,
      creditStage: this.o.creditStage,
      applyOn: this.o.applyOn,
      onStatus: (s) => this.status(s),
      clock: pageClock,
      canvas: () => {
        const rect = canvas.getBoundingClientRect();
        return {
          backing: [canvas.width, canvas.height],
          css: [Math.round(rect.width), Math.round(rect.height)],
          dprMilli: Math.round(window.devicePixelRatio * 1000),
          gpuFormats,
        };
      },
    });
    this.loading = null;
    this.loop.connect();
  }
}

class NoWebgl2 extends Error {}
