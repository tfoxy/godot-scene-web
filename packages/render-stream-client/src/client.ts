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
  ExtensionHost,
  type Point,
  type Rect,
  type RenderStreamExtension,
} from "./extensions";
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
  clientToPresentation,
  presentationToClient,
  readLayout,
} from "./pointer";
import {
  type RenderStreamTransportFactory,
  webSocketTransport,
} from "./transport";

export interface RenderStreamClientOptions {
  canvas: HTMLCanvasElement;
  core: RenderStreamCore;
  endpoint: RenderStreamEndpoint;
  /** Default: WebSocket + fetch (`webSocketTransport`). */
  transport?: RenderStreamTransportFactory;
  /** TAG2: product modules, composed in this order (client-extensions-design.md §3). Default
   * `[]`: the pure client (no `item_meta` hello key, nothing loaded, one branch per frame). An
   * extension that `wants` identities needs protocol 13. */
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

/** INP1: a point in the game's input space (the host window's px) and the item drawn there. */
export interface GamePoint {
  readonly point: Point;
  /** The topmost drawn item at the point (a card's child, say: `query.parent` climbs); null on
   * bare clear colour. */
  readonly item: number | null;
  /** The point as it is drawn (presentation space), before the inverse of the override. */
  readonly drawn: Point;
}

export interface RenderStreamClient {
  /** Loads the core (once) and connects; again after `failed` or `ended`. */
  connect(): void;
  /** A changed descriptor reconnects with it (an idle, failed or ended client keeps it for the
   * next `connect`). Throws `RenderStreamEndpointError` for an invalid one. */
  setEndpoint(e: RenderStreamEndpoint): void;
  stats(): Readonly<RenderStreamStats>;
  /** INP1: the page point `(clientX, clientY)` (an event's, CSS px) as a presentation-space
   * point (the host window's px), or null where the picture is not: a letterbox bar, outside the
   * canvas's box, or no session yet. Reads the canvas's layout on demand. */
  cssToPresentation(clientX: number, clientY: number): Point | null;
  /** INP1: a presentation-space rect (an item's `query.rect`, say) in page px, for a DOM overlay
   * anchored to it. Canvas-local: subtract `canvas.getBoundingClientRect()`. */
  presentationToCss(r: Rect): Rect;
  /** INP1: a presentation-space point as the game sees it: the topmost drawn item under it, and
   * the point through the inverse of that item's effective override (so a tap on a raised card
   * is where the game has the card). With no item under it the point is unchanged and `item` is
   * null. Null before the core is up. */
  toGame(x: number, y: number): GamePoint | null;
  /** INP1: `cssToPresentation` then `toGame`: null on a letterbox bar. */
  clientToGame(clientX: number, clientY: number): GamePoint | null;
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
  const creditWindow = options.creditWindow ?? 2;
  if (creditWindow !== 1 && creditWindow !== 2)
    throw new TypeError("render-stream client: creditWindow must be 1 or 2");
  const endpoint = validateEndpoint(options.endpoint);
  const exts = options.extensions ?? [];
  const ids = new Set<string>();
  for (const e of exts) {
    if (typeof e?.id !== "string" || e.id === "" || ids.has(e.id))
      throw new TypeError(
        "render-stream client: every extension needs a unique, non-empty id",
      );
    ids.add(e.id);
  }
  const ext = exts.length > 0 ? new ExtensionHost(exts) : null;
  if (ext?.request && endpoint.protocol < 13)
    throw new TypeError(
      "render-stream client: an extension that wants item identities needs protocol 13",
    );
  return new Client(options, endpoint, creditWindow, ext);
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
  /** INP1: the session's presentation size (null before its record). */
  private presentation: [number, number] | null = null;
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
    private readonly ext: ExtensionHost | null,
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
    if (this.ext?.request && next.protocol < 13)
      throw new TypeError(
        "render-stream client: an extension that wants item identities needs protocol 13",
      );
    if (sameEndpoint(next, this.endpoint)) return;
    this.endpoint = next;
    this.loop?.setEndpoint(next);
  }

  stats(): Readonly<RenderStreamStats> {
    return this.loop?.stats() ?? EMPTY_STATS;
  }

  cssToPresentation(clientX: number, clientY: number): Point | null {
    if (this.disposed || this.presentation === null) return null;
    return clientToPresentation(
      readLayout(this.o.canvas, this.presentation),
      clientX,
      clientY,
    );
  }

  presentationToCss(r: Rect): Rect {
    const l = readLayout(this.o.canvas, this.presentation);
    return presentationToClient(l, r);
  }

  toGame(x: number, y: number): GamePoint | null {
    if (this.disposed || this.core === null) return null;
    const m = this.core.toGame(x, y);
    if (m.length !== 3) return null;
    return {
      point: { x: m[1], y: m[2] },
      item: m[0] < 0 ? null : m[0],
      drawn: { x, y },
    };
  }

  clientToGame(clientX: number, clientY: number): GamePoint | null {
    const p = this.cssToPresentation(clientX, clientY);
    return p === null ? null : this.toGame(p.x, p.y);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.o.canvas;
    this.loop?.dispose();
    this.loop = null;
    this.ext?.dispose();
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
    this.ext?.bind(this.core);
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
      ext: this.ext,
      onSession: (m) => {
        const v = m.viewport;
        this.presentation = v?.presentation_size ?? v?.logical_size ?? null;
      },
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
