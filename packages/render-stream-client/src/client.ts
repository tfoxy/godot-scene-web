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
  IDENTITY,
  type ItemQuery,
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
import {
  CORE_LOAD_TIMEOUT_MS,
  CoreLoadError,
  loadCore,
  type RenderStreamCore,
} from "./loader";
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
  coreItemQuery,
  POINTER_TARGET_SOURCE,
  type PointerTargetSource,
} from "./pointer-targets";
import {
  createRecorder,
  type RecorderOptions,
  type Recording,
  type RenderStreamRecorder,
} from "./recorder";
import {
  carrierTransport,
  type RenderStreamCarrier,
  type RenderStreamTransportFactory,
} from "./transport";

export interface RenderStreamClientOptions {
  canvas: HTMLCanvasElement;
  core: RenderStreamCore;
  endpoint: RenderStreamEndpoint;
  /** Default: the `carrier` below. An explicit factory overrides it. */
  transport?: RenderStreamTransportFactory;
  /** CAR5: which live carrier to use. `auto` (default): WebTransport when the descriptor has
   * `webTransport`, `globalThis.WebTransport` exists and the page is a secure context, else
   * WebSocket + fetch. CAR11: `auto` also uses WebSocket on Android (`userAgentData.platform`
   * or the UA string), without loading the WebTransport chunk: on a CPU-throttled moto g31
   * WebTransport delivered 47.8 frames/s against 57.4 for WebSocket (back to back, CAR10
   * per-batch uplink), and gives the mirror no benefit yet. Revisit when WebTransport matches
   * WebSocket on a throttled g31, or a feature (audio) needs it; an explicit `webtransport`
   * still uses it on Android; a WebTransport attempt that fails before `open` is retried over WebSocket
   * and the client then stays on WebSocket. `websocket`: always WebSocket. `webtransport`: never
   * falls back (a failure is `live-connect-failed`). */
  carrier?: RenderStreamCarrier;
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
  /** REC1: when set, the client records the decoded messages since the last full and the fetched
   * payloads, exported by `RenderStreamClient.recording()`. Absent: the pure client (no ring, no
   * copies). */
  recorder?: RecorderOptions;
  /** The deadline of the whole core load (build.json to the glue's init), in ms; default 30000.
   * A load that has not finished is `failed` `core-load-failed`, detail `timeout after <ms> ms in
   * <steps>` (the steps still pending: `build fetch`, `wasm fetch`, `wasm hash`, `wasm compile`,
   * `glue import`, `core init`), and nothing of it runs on. A moto g31 on Wi-Fi took at most 1.1 s
   * at 4x CPU throttle (loader.ts). The connect deadline starts only once the core is up. */
  coreLoadTimeoutMs?: number;
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
  /** Loads the core (once, under `coreLoadTimeoutMs`) and connects; again after `failed` or
   * `ended` (a failed load is retried). */
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
  /** Stops the frame loop, closes the connection (1000), aborts a core load and in-flight GETs,
   * frees every wasm-bindgen object, loses the WebGL context and drops the instance. Idempotent. */
  dispose(): void;
  /** REC1: the recording so far (null when the client was built without `recorder`). */
  recording(): Recording | null;
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
  const carrier = options.carrier ?? "auto";
  if (
    carrier !== "auto" &&
    carrier !== "websocket" &&
    carrier !== "webtransport"
  )
    throw new TypeError(
      'render-stream client: carrier must be "auto", "websocket" or "webtransport"',
    );
  const creditWindow = options.creditWindow ?? 2;
  if (creditWindow !== 1 && creditWindow !== 2)
    throw new TypeError("render-stream client: creditWindow must be 1 or 2");
  const coreLoadTimeoutMs = options.coreLoadTimeoutMs ?? CORE_LOAD_TIMEOUT_MS;
  // setTimeout fires at once past 2^31 - 1 ms.
  if (
    !(Number.isFinite(coreLoadTimeoutMs) && coreLoadTimeoutMs > 0) ||
    coreLoadTimeoutMs > 0x7fffffff
  )
    throw new TypeError(
      "render-stream client: coreLoadTimeoutMs must be a positive number of ms (at most 2^31 - 1)",
    );
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
  // REC1: absent the option there is no recorder (and no per-message copy); present, one ring.
  const recorder = options.recorder ? createRecorder(options.recorder) : null;
  return new Client(
    options,
    endpoint,
    creditWindow,
    coreLoadTimeoutMs,
    ext,
    recorder,
  );
}

const EMPTY_STATS: RenderStreamStats = Object.freeze({
  applied: 0,
  appliesPerSec: 0,
  creditRttMsP50: null,
  heapBytes: 0,
  carrier: null,
});

class Client implements RenderStreamClient {
  private loop: StreamLoop | null = null;
  private core: WasmStreamCore | null = null;
  private loading: Promise<void> | null = null;
  /** Aborts the core load in flight (dispose). */
  private loadAbort: AbortController | null = null;
  /** One factory per client: the sticky fallback and the WebTransport cache live in it. */
  private readonly carrierFactory: RenderStreamTransportFactory;
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
    private readonly coreLoadTimeoutMs: number,
    private readonly ext: ExtensionHost | null,
    private readonly recorder: RenderStreamRecorder | null,
  ) {
    this.carrierFactory = o.transport ?? carrierTransport(o.carrier ?? "auto");
  }

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
      this.loadAbort = null;
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
    this.ext?.flushHitFilters();
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

  recording(): Recording | null {
    return this.recorder?.export() ?? null;
  }

  /** IN12: what `pointerTargetResolver` reads, on demand (pointer-targets.ts). */
  [POINTER_TARGET_SOURCE](): PointerTargetSource {
    let bare: ItemQuery | null = null;
    return {
      cssToPresentation: (x, y) => this.cssToPresentation(x, y),
      query: () => {
        if (this.disposed || this.core === null) return null;
        if (this.ext) return this.ext.query;
        bare ??= coreItemQuery(() => this.core);
        return bare;
      },
      effective: (id) => this.ext?.overrides.effective(id) ?? IDENTITY,
      drawnSeq: () => this.loop?.drawnSeq ?? null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadAbort?.abort();
    this.loadAbort = null;
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
    const abort = new AbortController();
    this.loadAbort = abort;
    const { mod, memory } = await loadCore(this.o.core, {
      timeoutMs: this.coreLoadTimeoutMs,
      signal: abort.signal,
    });
    this.loadAbort = null;
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
      transport: this.carrierFactory,
      endpoint: this.endpoint,
      creditWindow: this.creditWindow,
      creditStage: this.o.creditStage,
      applyOn: this.o.applyOn,
      ext: this.ext,
      recorder: this.recorder,
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
