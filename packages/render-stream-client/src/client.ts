// createRenderStreamClient: one canvas, one live stream, one wasm
// instance, released by `dispose()`.

import type { GswRs } from "./abi";
import { StreamFailure, WasmStreamCore } from "./core";
import {
  type RenderStreamEndpoint,
  type RenderStreamProtocol,
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
  frameCapLimits,
  type RenderStreamFrameCap,
  type RenderStreamFrameCapBounds,
} from "./frame-cap";
import {
  CLIENT_INBOUND_BYTES,
  CLIENT_LIVE_CODING,
  clientProtocol,
  coreStartOptions,
  gpuFormatsOf,
} from "./hello";
import type { HintEntry } from "./hints";
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
  type PacingObserver,
  type RenderStreamStats,
  type RenderStreamStatus,
  StreamLoop,
} from "./loop";
import { checkPacing, type RenderStreamPacing, resolvePacing } from "./pacing";
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
import { scheduleTranspilerWarmup } from "./programs";
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

// Match canvas_items/gl.rs CONTEXT_ATTRIBUTES: the first getContext fixes these,
// even when the session has not created the executor yet. RGBA8 blits require a
// single-sampled default framebuffer.
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  desynchronized: false,
};

export interface RenderStreamClientOptions {
  canvas: HTMLCanvasElement;
  core: RenderStreamCore;
  endpoint: RenderStreamEndpoint;
  /** Default: the `carrier` below. An explicit factory overrides it. */
  transport?: RenderStreamTransportFactory;
  /** Which live carrier to use. `auto` (default): WebTransport when the descriptor has
   * `webTransport`, `globalThis.WebTransport` exists and the page is a secure context, else
   * WebSocket + fetch. `auto` also uses WebSocket on Android (`userAgentData.platform` or the UA
   * string), without loading the WebTransport chunk, because WebTransport delivers fewer frames
   * than WebSocket on throttled Android devices and gives the mirror no benefit yet; an explicit
   * `webtransport` still uses it on Android; a WebTransport attempt that fails before `open` is retried over WebSocket
   * and the client then stays on WebSocket. `websocket`: always WebSocket. `webtransport`: never
   * falls back (a failure is `live-connect-failed`). */
  carrier?: RenderStreamCarrier;
  /** Fetch WebSocket resources in a dedicated worker (default true). False keeps HTTP reads
   * on the main thread. Ignored by WebTransport and custom transport factories. */
  fetchInWorker?: boolean;
  /** Product modules, composed in this order. Default
   * `[]`: the pure client (no `item_meta` hello key, nothing loaded, one branch per frame). An
   * extension that `wants` identities needs protocol 13 or 14; v2 wants upgrade /13 to /14. */
  extensions?: readonly RenderStreamExtension[];
  /** The credit window asked in the hello (the session grants it): 1..8 at /18 and later, else 1..2.
   * Default 8 at /18 and later, else 2. Mutually exclusive with `pacing`; an explicit value
   * also prevents `setPacing`. Fixed for the connection's lifetime. */
  creditWindow?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Resolve both credit knobs at each connection's effective protocol. `fidelity`: applied,
   * window 8 at /18 and later, else 2 (today's defaults). `balanced`: submitted, window 3 at
   * /18 and later, else 2, with a quiet reconnect to fidelity if more than half of the last
   * 32 eligible credit cycles were starved (at any session grant).
   * Samples begin after the first drawn frame and exclude cycles overlapping payload work.
   * `saver` presents at a display divisor with headroom, using fidelity credit.
   * Fallback survives reconnects until `setPacing` or a different endpoint resets it. Omitted:
   * preserve the existing credit-knob behaviour. Mutually exclusive with either explicit knob;
   * invalid values or combinations throw `TypeError`. Change at runtime with `setPacing`. */
  pacing?: RenderStreamPacing;
  /** @internal Observe pacing without controlling presentation or credit. */
  pacingObserver?: PacingObserver;
  /** The hello's credit stage, the ack the host's credit waits on; default `applied`.
   * `submitted` returns credit at a draw for every transaction folded into it. Mutually
   * exclusive with `pacing`; an explicit value also prevents `setPacing`. Fixed per connection. */
  creditStage?: CreditStage;
  /** Where a ready transaction is applied (acked `applied`): the next frame callback (`frame`) or
   * its own `onmessage` while frames run (`message`, the default). Either way the renderer's
   * apply work runs once per drawn frame, in the frame callback, for every transaction since. */
  applyOn?: ApplyOn;
  /** The longest, in ms, a transaction waits for the resources it needs; default 0. Past it,
   * the transaction applies without textures, meshes and shader code still loading: dependent
   * drawing is omitted (no older picture in its place), and everything else draws. Late arrivals
   * redraw with or without a new transaction. 0 (the default) never waits, as a web page loads its
   * images; a small value draws a payload that arrives within it with its transaction; `Infinity`
   * waits for every resource (frames hold meanwhile). */
  resourceHoldMs?: number;
  /** When set, the client records the decoded messages since the last full and the fetched
   * payloads, exported by `RenderStreamClient.recording()`. Absent: the pure client (no ring, no
   * copies). */
  recorder?: RecorderOptions;
  /** The deadline of the whole core load (build.json to the glue's init), in ms; default 30000.
   * A load that has not finished is `failed` `core-load-failed`, detail `timeout after <ms> ms in
   * <steps>` (the steps still pending: `build fetch`, `wasm fetch`, `wasm hash`, `wasm compile`,
   * `glue import`, `core init`), and nothing of it runs on. The connect deadline starts only once
   * the core is up. */
  coreLoadTimeoutMs?: number;
  /** Ask the host for resource hints (render-stream-15.md): the client offers
   * `render-stream.15` (the one subprotocol offered, so the host must run
   * `GRC_STREAM_VERSION=15`) and keeps every hint in effect in a table, read by `hints()`, with
   * the hint fields of `stats()`. The endpoint's protocol must be 13 or later. At protocol 16 the
   * offer is `render-stream.16` either way (a /16 stream contains /15's hints; the host's
   * `GRC_RESOURCE_HINTS` decides whether it sends any), and the option enables the table and idle prefetch.
   * Default false: no /15 offer, no table, and the offer, the hello and the core's calls are the
   * client's without the option. Older cores without hint selection keep only the table. */
  resourceHints?: boolean;
  /** Play announced Godot tweens locally. Opt-in, approximate parity; requires /17 or later. /19 also grants material parameters; select a /19 endpoint explicitly. Default false. */
  clientTweens?: boolean;
  /** Hint GETs at once (default 2). At most 3, reserving a slot for demand; 0 disables prefetch. */
  prefetchMaxInFlight?: number;
  /** Per-connection hint payload byte budget, completed plus in flight (default 64 MiB). */
  prefetchBudgetBytes?: number;
  /** Draw the host's non-root viewports (render-stream/16 surfaces: a `SubViewport`'s own picture
   * shown through a `ViewportTexture`, a `SubViewportContainer`, an embedded window). Default
   * true. `false` builds no surface pass: the viewport table is still applied, every viewport
   * texture draws transparent, and `stats().surfacesSkipped` counts the surfaces the frame reached
   * and did not build. The wire is the same, so the host needs no restart to try either value. Only
   * a /16 stream carries surfaces: below /16 the option changes nothing. */
  viewports?: boolean;
  /** Clear the stream canvas to transparent so the page can show an underlay. Default false:
   * use the host's clear colour. Applies to the root canvas only; viewport surfaces keep their
   * host clears. Uses the executor's alpha-enabled, premultiplied WebGL context. */
  transparentClear?: boolean;
  /** The idle frame cap, for battery and heat over long sessions on a GPU-bound device; change it
   * at runtime with `setFrameCap`. `off` (the default): every frame callback presents, and nothing
   * is measured. `automatic`: once nobody has interacted for `FRAME_CAP_QUIET_MS` and the stream
   * shows only ambient motion (sub-pixel drift, an idle skeleton, continuous particles, a
   * time-driven shader, a slow fade), the client presents every other frame callback (30 fps on a
   * 60 Hz panel), and the first frame callback after an input or a real change presents again. A
   * real change is anything added, removed, reordered, shown or hidden, any content, material or
   * resource change (an emitter restarted or reconfigured included), or motion or a colour step
   * past `frameCapBounds`. Input is a pointer, touch, key or wheel event anywhere in the canvas's
   * document, or `wake()`. Transactions are still applied and acked as they arrive,
   * so the host's rate is unchanged (with `creditStage: "submitted"` and credit window 1, the host
   * is paced by the presented frames, as it always is at that stage). A core built without the
   * motion measure never engages the cap. Under saver, an engaged cap skips every other saver
   * slot; `off` leaves saver pacing unchanged. */
  frameCap?: RenderStreamFrameCap;
  /** Warm GPU particles once to a representative frame and hold them. Default false.
   * CPU particles stay live. Frozen one-shots retire on the next apply/present after their
   * burst window; no timer forces a redraw. Change at runtime with `setStaticParticles`. */
  staticParticles?: boolean;
  /** Pin material TIME to the first carried shader time after enabling. Default false.
   * Particle simulation keeps its carried clock. Change with `setStaticShaders`. */
  staticShaders?: boolean;
  /** Texture-slot batching: true = bit 1; false = 0; or a u32 mask.
   * Omitted: retain the executor default (currently off). */
  drawBatching?: boolean | number;
  /** Retain unchanged canvas frames. Defaults to false. */
  damageRedraw?: boolean;
  /** How much motion per transaction still counts as ambient under `frameCap` (each field
   * optional, defaults: scene content `IDLE_MOTION_MAX_PX` 1 px and `IDLE_COLOR_STEP_MAX` 8/255,
   * animation content `IDLE_ANIMATION_MAX_PX` 128 px and `IDLE_ANIMATION_COLOR_STEP_MAX`
   * unbounded). Change them at runtime with `setFrameCap(mode, bounds)`. */
  frameCapBounds?: RenderStreamFrameCapBounds;
  onStatus?: (s: RenderStreamStatus) => void;
}

/** A point in the game's input space (the host window's px) and the item drawn there. */
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
   * next `connect`). Throws `RenderStreamEndpointError` for an invalid one.
   * A change in effective protocol rebuilds the core at the next connection. */
  setEndpoint(e: RenderStreamEndpoint): void;
  /** Select a preset and reset balanced's fallback. If the resolved hello changes while connecting
   * or streaming, quietly reconnect (no `connecting` status), retaining the core and payload
   * store. The new connection emits `streaming` at its session and first draw as usual.
   * Otherwise keep it for the next connection; the same preset and hello are a no-op unless
   * resetting a fallback. Throws `TypeError` for an invalid preset or if either credit knob
   * was explicit at creation. No-op after dispose. Always present on a created client;
   * optional so consumer test doubles need not implement it. */
  setPacing?(pacing: RenderStreamPacing): void;
  stats(): Readonly<RenderStreamStats>;
  /** The page point `(clientX, clientY)` (an event's, CSS px) as a presentation-space
   * point (the host window's px), or null where the picture is not: a letterbox bar, outside the
   * canvas's box, or no session yet. Reads the canvas's layout on demand. */
  cssToPresentation(clientX: number, clientY: number): Point | null;
  /** A presentation-space rect (an item's `query.rect`, say) in page px, for a DOM overlay
   * anchored to it. Canvas-local: subtract `canvas.getBoundingClientRect()`. */
  presentationToCss(r: Rect): Rect;
  /** A presentation-space point as the game sees it: the topmost drawn item under it, and
   * the point through the inverse of that item's effective override (so a tap on a raised card
   * is where the game has the card). With no item under it the point is unchanged and `item` is
   * null. Null before the core is up. */
  toGame(x: number, y: number): GamePoint | null;
  /** `cssToPresentation` then `toGame`: null on a letterbox bar. */
  clientToGame(clientX: number, clientY: number): GamePoint | null;
  /** Stops the frame loop, closes the connection (1000), aborts a core load and in-flight GETs,
   * frees every wasm-bindgen object, loses the WebGL context and drops the instance. Idempotent. */
  dispose(): void;
  /** The recording so far (null when the client was built without `recorder`). */
  recording(): Recording | null;
  /** The resource hints in effect on the current connection, in prefetch order (ascending
   * `priority`, then arrival): a frozen array, the same one until the table changes. Empty
   * without `resourceHints`. */
  hints(): readonly HintEntry[];
  /** The idle frame cap from now on (`frameCap`), and with `bounds` its bounds
   * (`frameCapBounds`: over the defaults, not over the previous bounds; omitted, they stay).
   * Switching counts as an interaction: an `automatic` cap engages only after a quiet period. A
   * client `createRenderStreamClient` returns always has it; it is optional so that a consumer's
   * test double need not. */
  setFrameCap?(
    mode: RenderStreamFrameCap,
    bounds?: RenderStreamFrameCapBounds,
  ): void;
  /** An input the canvas's document does not see (a consumer's own input layer, a gamepad, a
   * second device): an engaged frame cap presents from the next frame callback, and the quiet
   * period starts over. Cheap enough to call on every input event; nothing under `off`. Always
   * there on a created client (optional as `setFrameCap`). */
  wake?(): void;
  /** Warm and hold GPU emitters, or restart them in live mode. Always present on created clients;
   * optional so existing consumer test doubles remain compatible. */
  setStaticParticles?(on: boolean): void;
  /** Switch the material TIME pin at runtime. */
  setStaticShaders?(on: boolean): void;
  setDrawBatching?(value: boolean | number): void;
  setDamageRedraw?(on: boolean): void;
}

/** The events that count as input for the frame cap, listened to on the canvas's document. */
const WAKE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "touchstart",
  "touchmove",
  "keydown",
  "keyup",
  "wheel",
] as const;
const WAKE_LISTEN: AddEventListenerOptions = { capture: true, passive: true };

const pageClock: LoopClock = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

function drawBatchingMask(value: boolean | number): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  )
    throw new TypeError(
      "render-stream client: drawBatching must be a boolean or u32 mask",
    );
  return value;
}

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
  if (options.pacing !== undefined) {
    checkPacing(options.pacing);
    if (options.creditWindow !== undefined || options.creditStage !== undefined)
      throw new TypeError(
        "render-stream client: pacing owns creditWindow and creditStage",
      );
  }
  const endpoint = validateEndpoint(options.endpoint);
  const creditWindow =
    options.creditWindow ?? (endpoint.protocol >= 18 ? 8 : 2);
  const maxWindow = endpoint.protocol >= 18 ? 8 : 2;
  if (
    !Number.isInteger(creditWindow) ||
    creditWindow < 1 ||
    creditWindow > maxWindow
  )
    throw new TypeError(
      `render-stream client: creditWindow must be in 1..${maxWindow}`,
    );
  const coreLoadTimeoutMs = options.coreLoadTimeoutMs ?? CORE_LOAD_TIMEOUT_MS;
  // setTimeout fires at once past 2^31 - 1 ms.
  if (
    !(Number.isFinite(coreLoadTimeoutMs) && coreLoadTimeoutMs > 0) ||
    coreLoadTimeoutMs > 0x7fffffff
  )
    throw new TypeError(
      "render-stream client: coreLoadTimeoutMs must be a positive number of ms (at most 2^31 - 1)",
    );
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
  const resourceHints = options.resourceHints ?? false;
  if (typeof resourceHints !== "boolean")
    throw new TypeError(
      "render-stream client: resourceHints must be a boolean",
    );
  for (const key of ["prefetchMaxInFlight", "prefetchBudgetBytes"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new TypeError(
        `render-stream client: ${key} must be a non-negative safe integer`,
      );
  }
  if (typeof (options.clientTweens ?? false) !== "boolean")
    throw new TypeError("render-stream client: clientTweens must be a boolean");
  clientProtocol(
    endpoint.protocol,
    ext?.request,
    resourceHints,
    options.clientTweens,
  );
  if (typeof (options.viewports ?? true) !== "boolean")
    throw new TypeError("render-stream client: viewports must be a boolean");
  if (typeof (options.transparentClear ?? false) !== "boolean")
    throw new TypeError(
      "render-stream client: transparentClear must be a boolean",
    );
  if (options.drawBatching !== undefined)
    drawBatchingMask(options.drawBatching);
  if (typeof (options.staticShaders ?? false) !== "boolean")
    throw new TypeError(
      "render-stream client: staticShaders must be a boolean",
    );
  if (typeof (options.damageRedraw ?? false) !== "boolean")
    throw new TypeError("render-stream client: damageRedraw must be a boolean");
  if (typeof (options.staticParticles ?? false) !== "boolean")
    throw new TypeError(
      "render-stream client: staticParticles must be a boolean",
    );
  checkFrameCap(options.frameCap ?? "off");
  frameCapLimits(options.frameCapBounds);
  // Absent the option there is no recorder (and no per-message copy); present, one ring.
  const recorder = options.recorder ? createRecorder(options.recorder) : null;
  return new Client(options, endpoint, coreLoadTimeoutMs, ext, recorder);
}

function checkFrameCap(mode: unknown): asserts mode is RenderStreamFrameCap {
  if (mode !== "off" && mode !== "automatic")
    throw new TypeError(
      'render-stream client: frameCap must be "off" or "automatic"',
    );
}

const NO_HINTS: readonly HintEntry[] = Object.freeze([]);

const EMPTY_STATS: RenderStreamStats = Object.freeze({
  damageModeCounts: Object.freeze([0, 0, 0, 0] as const),
  damageUsP50: null,
  damagePermilleP50: null,
  damageRegionsP50: null,
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
  /** The session's presentation size (null before its record). */
  private presentation: [number, number] | null = null;
  private readonly onLost = (e: Event) => {
    // Keep the context restorable; the loop holds until the restore.
    e.preventDefault();
    this.loop?.contextLost();
  };
  private readonly onRestored = () => this.loop?.contextRestored();
  /** The frame cap in effect (the loop's, once there is one). */
  private pacing: RenderStreamPacing | null;
  private frameCap: RenderStreamFrameCap;
  private staticParticles: boolean;
  private drawBatching: number | undefined;
  private staticShaders: boolean;
  private damageRedraw: boolean;
  /** Its bounds (the loop's, once there is one). */
  private frameCapBounds: RenderStreamFrameCapBounds | undefined;
  /** The document the wake listeners are on (null: none, the cap is off). */
  private wakeDoc: Document | null = null;
  private readonly onInput = () => this.loop?.wake();
  private visibilityDoc: Document | null = null;
  private readonly onVisibility = () => {
    if (this.visibilityDoc?.visibilityState === "visible")
      this.loop?.resetSaver();
  };

  private listenVisibility(): void {
    const want =
      this.pacing === "saver" && !this.disposed
        ? this.o.canvas.ownerDocument
        : null;
    if (want === this.visibilityDoc) return;
    this.visibilityDoc?.removeEventListener(
      "visibilitychange",
      this.onVisibility,
    );
    want?.addEventListener("visibilitychange", this.onVisibility);
    this.visibilityDoc = want;
  }

  constructor(
    private readonly o: RenderStreamClientOptions,
    private endpoint: RenderStreamEndpoint,
    private readonly coreLoadTimeoutMs: number,
    private readonly ext: ExtensionHost | null,
    private readonly recorder: RenderStreamRecorder | null,
  ) {
    this.carrierFactory =
      o.transport ??
      carrierTransport(o.carrier ?? "auto", { fetchInWorker: o.fetchInWorker });
    this.pacing = o.pacing ?? null;
    this.frameCap = o.frameCap ?? "off";
    this.staticParticles = o.staticParticles ?? false;
    this.drawBatching =
      o.drawBatching === undefined
        ? undefined
        : drawBatchingMask(o.drawBatching);
    this.staticShaders = o.staticShaders ?? false;
    this.damageRedraw = o.damageRedraw ?? false;
    this.frameCapBounds = o.frameCapBounds;
    this.listenInput();
    this.listenVisibility();
  }

  setPacing(pacing: RenderStreamPacing): void {
    if (this.disposed) return;
    checkPacing(pacing);
    if (this.o.creditWindow !== undefined || this.o.creditStage !== undefined)
      throw new TypeError(
        "render-stream client: setPacing conflicts with explicit credit knobs",
      );
    this.pacing = pacing;
    this.listenVisibility();
    this.loop?.setPacing(pacing);
  }

  setFrameCap(
    mode: RenderStreamFrameCap,
    bounds?: RenderStreamFrameCapBounds,
  ): void {
    checkFrameCap(mode);
    if (bounds !== undefined) frameCapLimits(bounds);
    if (this.disposed) return;
    this.frameCap = mode;
    if (bounds !== undefined) this.frameCapBounds = { ...bounds };
    this.listenInput();
    this.loop?.setFrameCap(mode, bounds);
  }

  setDrawBatching(value: boolean | number): void {
    const mask = drawBatchingMask(value);
    if (this.disposed || this.drawBatching === mask) return;
    this.drawBatching = mask;
    this.core?.setDrawBatching(mask);
    this.loop?.wake();
  }

  setStaticShaders(on: boolean): void {
    if (typeof on !== "boolean")
      throw new TypeError(
        "render-stream client: staticShaders must be a boolean",
      );
    if (this.disposed || this.staticShaders === on) return;
    this.staticShaders = on;
    this.core?.setStaticShaders(on);
    this.loop?.wake();
  }

  setDamageRedraw(on: boolean): void {
    if (typeof on !== "boolean")
      throw new TypeError(
        "render-stream client: damageRedraw must be a boolean",
      );
    if (this.disposed || this.damageRedraw === on) return;
    this.damageRedraw = on;
    this.core?.setDamageRedraw(on);
  }

  setStaticParticles(on: boolean): void {
    if (typeof on !== "boolean")
      throw new TypeError(
        "render-stream client: staticParticles must be a boolean",
      );
    if (this.disposed || this.staticParticles === on) return;
    this.staticParticles = on;
    this.core?.setStaticParticles(on);
    this.loop?.wake();
  }

  wake(): void {
    if (this.frameCap !== "off") this.loop?.wake();
  }

  /** Input listeners on the canvas's document exactly while the cap is `automatic`. */
  private listenInput(): void {
    const want =
      this.frameCap === "automatic" && !this.disposed
        ? (this.o.canvas.ownerDocument ?? null)
        : null;
    if (want === this.wakeDoc) return;
    for (const t of WAKE_EVENTS) {
      this.wakeDoc?.removeEventListener(t, this.onInput, WAKE_LISTEN);
      want?.addEventListener(t, this.onInput, WAKE_LISTEN);
    }
    this.wakeDoc = want;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.loop !== null) {
      this.loop.connect();
      return;
    }
    if (this.loading !== null) return;
    this.status({ kind: "connecting" });
    scheduleTranspilerWarmup();
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
    clientProtocol(
      next.protocol,
      this.ext?.request,
      this.o.resourceHints,
      this.o.clientTweens,
    );
    if (
      this.o.creditWindow !== undefined &&
      this.o.creditWindow > (next.protocol >= 18 ? 8 : 2)
    )
      throw new TypeError(
        "render-stream client: creditWindow exceeds endpoint protocol range",
      );
    if (sameEndpoint(next, this.endpoint)) return;
    this.endpoint = next;
    this.loop?.setEndpoint(next);
  }

  stats(): Readonly<RenderStreamStats> {
    if (this.disposed) return EMPTY_STATS;
    return (
      this.loop?.stats() ?? {
        ...EMPTY_STATS,
        saverDivisor: null,
        saverDisplayHz: null,
        saverMissedSlotShare: null,
        saverStaleSlotShare: null,
        saverCapacityHz: null,
        pacing: this.pacing,
        pacingFallback: false,
        creditStage:
          this.pacing === null
            ? (this.o.creditStage ?? "applied")
            : resolvePacing(this.pacing, this.endpoint.protocol, false)
                .creditStage,
        creditWindowGranted: null,
        starvedCycleShare: null,
        draws: 0,
      }
    );
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

  hints(): readonly HintEntry[] {
    return this.loop?.hints?.entries() ?? NO_HINTS;
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
    this.listenInput();
    this.listenVisibility();
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
      .getContext("webgl2", CONTEXT_ATTRIBUTES)
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
    const protocol = clientProtocol(
      this.endpoint.protocol,
      this.ext?.request,
      this.o.resourceHints,
      this.o.clientTweens,
    );
    const build = (protocol: RenderStreamProtocol): GswRs => {
      const presentation = this.endpoint.presentation;
      if (presentation) {
        canvas.width = presentation[0];
        canvas.height = presentation[1];
      }
      let g: GswRs;
      try {
        g = new mod.GswRs(
          canvas,
          coreStartOptions(
            protocol,
            this.o.viewports ?? true,
            this.o.transparentClear ?? false,
            this.damageRedraw,
            this.o.clientTweens,
          ),
        );
      } catch (e) {
        const probe = document
          .createElement("canvas")
          .getContext("webgl2", CONTEXT_ATTRIBUTES);
        probe?.getExtension("WEBGL_lose_context")?.loseContext();
        if (probe === null)
          throw new NoWebgl2("this browser gives no WebGL2 context");
        throw new CoreLoadError(`the core refused the canvas: ${String(e)}`);
      }
      try {
        if (presentation) g.set_window(presentation[0], presentation[1]);
      } catch (e) {
        g.free();
        throw e;
      }
      return g;
    };
    this.core = new WasmStreamCore(
      mod,
      memory,
      build,
      protocol,
      CLIENT_LIVE_CODING,
      CLIENT_INBOUND_BYTES,
    );
    this.core.setStaticParticles(this.staticParticles);
    this.core.setStaticShaders(this.staticShaders);
    if (this.drawBatching !== undefined)
      this.core.setDrawBatching(this.drawBatching);
    this.core.setDamageRedraw(this.damageRedraw);
    this.ext?.bind(this.core);
    // This can precede the session's executor: create its context with the same attributes.
    const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
    const gpuFormats = gpuFormatsOf(gl?.getSupportedExtensions() ?? [], null);
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.loop = new StreamLoop({
      core: this.core,
      transport: this.carrierFactory,
      endpoint: this.endpoint,
      creditWindow: this.o.creditWindow,
      creditStage: this.o.creditStage,
      pacing: this.pacing ?? undefined,
      pacingObserver: this.o.pacingObserver,
      applyOn: this.o.applyOn,
      resourceHoldMs: this.o.resourceHoldMs,
      ext: this.ext,
      recorder: this.recorder,
      resourceHints: this.o.resourceHints === true,
      clientTweens: this.o.clientTweens === true,
      prefetchMaxInFlight: this.o.prefetchMaxInFlight,
      prefetchBudgetBytes: this.o.prefetchBudgetBytes,
      frameCap: this.frameCap,
      frameCapBounds: this.frameCapBounds,
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

class NoWebgl2 extends StreamFailure {
  constructor(detail: string) {
    super(null, "no-webgl2", detail);
  }
}
