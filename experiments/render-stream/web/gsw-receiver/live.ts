// The GSW receiver's live mode (gate7-design.md Q2, Q5 "Credit and pacing", "Fetch", Q9
// `credit-from-paced-loop`, Q14c, G7l): a render-stream/7 WebSocket client in front of the same
// wasm core as file mode, with the native receiver's live options and evidence (receiver.gd
// `_ready_live` and everything it calls), so each gate's own checker judges this leg directory
// exactly as a native one.
//
// The client. Subprotocol `render-stream.7`, `binaryType` arraybuffer. On open it sends the /7
// hello (Q2, key order as there; `receiver_kind` "gsw-canvas", the token from the page's fragment
// or null, the canvas's backing and CSS size and the DPR). Every binary message is appended to the
// received tap (`received.rs7`, `received-2.rs7` after a reconnect), copied ONCE into wasm's
// receive buffer and decoded there on its own (`live_session` for the first, `live_accept` for each
// later one, exactly one record), so memory is bounded by the largest message. A text message is
// the host's `error`: `replay-failure` `host-error` (`<reason>: <detail>`), except `unauthorized`
// before any session, which is `live-connect-failed` (/7's analogue of /6's 401 upgrade), as is a
// close 1008 `unauthorized` and a socket that never opens (a 403 origin) or does not open within
// RS_RECEIVER_CONNECT_TIMEOUT. A close without the end record is `live-disconnected` (`host-error`
// for 1002/1008/1009), unless RS_RECEIVER_RECONNECT_ON_LOSS=1 (G7u, D14 as amended): then a lost
// connection reconnects as G1d's RECONNECT does (dispose, a fresh session on the next
// connection), at most LOSS_RECONNECTS_MAX times, recorded in `live.loss_reconnects`. After the end
// record the receiver closes first (1000), as natively.
//
// Credit and pacing (Q5). `onmessage` decodes and validates, acks `received` and queues. One rAF
// loop does everything else, in the native `_process_live` order: connection phases, the
// pending transaction's fetches (one `fetch` at a time, polled, each payload verified by wasm
// before use), then the queued transaction: apply, ack `applied`, a due state dump, draw and blit,
// a due shot (read back at once), a due stall, ack `submitted` (credit stage `submitted`, or a
// shot), all in that callback. Nothing is drawn in a callback that applied nothing. `--max-fps N`
// (engine_args) or RS_RECEIVER_MAX_FPS skips callbacks with `platform/web/web_main.cpp`'s
// `target_ticks` rule (83-97), so a capped GSW receiver paces like the web export.
//
// Native options with native semantics: RS_RECEIVER_SHOT_WINDOWS, SHOT_FINAL, STALL (a busy-wait
// on the page's main thread after the shot, before the submitted ack: an injected stall, not GPU
// work), RECONNECT (+ RECONNECT_MEMORY: close 1000, dispose the applier, a fresh session on
// connection 2), RESYNC (refuse the window's first transaction, `resync` it, ignore patches until a
// full; the full is applied by a fresh applier, because the wasm applier is delta-driven and never
// saw the refused ones), CREDIT_STAGE, CONNECT_TIMEOUT, INBOUND_BYTES (announced), FETCH_DELAY_MS,
// FETCH_TIMEOUT_MS, SABOTAGE (`wrong-http-token`; GSW-only `ack-on-receipt`, which acks
// `submitted` from `onmessage` so `credit-from-paced-loop` can be shown to fail, and G7u's
// `ack-while-hidden`, which does so only while the page is suspended: hidden, or the lifecycle
// shim's simulated suspension), CACHE_MODE.
//
// WebGL context loss (G7u, gate7-design.md D14 as amended by D29) is recovered in place. From
// `webglcontextlost` the loop holds: it applies and draws nothing, so no credit returns, and what
// arrives queues. After `webglcontextrestored` one callback redraws the last applied state with
// no transaction: the executor recreates its GL objects, and `draw` re-uploads every resident
// texture from the wasm payload store and the whole vertex and index buffers (every mesh's
// geometry), after refetching any resident texture's payload the store no longer holds. Credit
// resumes with the next applied transaction. applied.json `live.context_loss` records it, and the
// restored target is read back to `context-loss/restored.png`.
//
// The cache directory. As for the web export (Q4), the browser's HTTP cache stands in for
// RS_RECEIVER_CACHE_DIR: every miss is a `fetch` with the default cache mode, which the browser may
// answer from its cache without a GET reaching the host (a reconnect's `drop`, a warm leg on a copy
// of the cold leg's profile). applied.json says so (`cache.mode: "http-cache"`, no cache hits),
// and the checkers judge such a receiver's fetches by the host's GET log.
//
// Evidence: applied.json `render-stream-receiver-applied/7` live (receiver `protocol`
// `render-stream/7`, `credit_window` the session's grant, every transaction in receipt order with
// received/applied/submitted µs and `skipped`, `live` with the acks, stall, reconnect and resync),
// shots and state dumps at window seqs (`stream-2-seq-N` after a reconnect), the received taps, and
// per transaction `paced`: the rAF callback that applied and drew it and when its submitted ack was
// sent, also in perf-timeline.jsonl when RS_RECEIVER_PERF_OUT is set.
//
// render-stream/8 (G8g, render-stream-8.md "Live transport"): RS_RECEIVER_PROTOCOL=8 offers
// `render-stream.8` instead and sends the same hello with protocol `render-stream/8` (a gate 8
// host offers only .8); the session and every record go through wasm at /8 (`live_session(len, 8)`),
// and the received tap is `received.rs8`. Everything else is the /7 client above (G8kp's /9 adds
// the delivery hello keys).

import {
  ACCEPT_END,
  ACCEPT_NEEDS_PAYLOADS,
  ACCEPT_RESOURCE,
  failWith,
  finish,
  type GswRs,
  type GswRsModule,
  type LiveCoding,
  hex,
  loadModule,
  log,
  ReplayFailure,
  type SessionMeta,
  shell,
  statsReader,
  viewportReport,
} from "./common";
import {
  type LiveConfig,
  type LiveProtocol,
  type ReceiverConfig,
  relativeToOut,
  underOut,
} from "./config";
import {
  appliedJson,
  prettyJsonParts,
  encodePng,
  type LiveEntry,
  put,
  type Report,
  type RustParts,
  type ShellTx,
} from "./evidence";
import { type FetchResult, LiveFetcher } from "./fetcher";
import { foldedFullIndex } from "./fold";
import { leakedGlTextureCount, leakOneIfDue } from "./gl-leak";
import { gpuFormatsOf, helloV9 } from "./hello";
import { GswParticles } from "./particles";
import { KtxStager } from "./transcode";
import { type PayloadVerify, Perf } from "./perf";
import {
  definePrograms,
  needsLibrary,
  ProgramError,
  provideLibrary,
} from "./programs";

/** The subprotocol and hello `protocol` of a live wire version (G8g: 8 is /8's live transport;
 * G8kp: 9, render-stream-9.md "Live transport", RS_RECEIVER_PROTOCOL=9 offers only this). */
const SUBPROTOCOL = (v: LiveProtocol) => `render-stream.${v}`;
const PROTOCOL = (v: LiveProtocol) => `render-stream/${v}` as const;
/** G8kp (texture-delivery-design.md Q3): the compressed families a WebGL2 context on this page
 * exposes, probed on a throwaway canvas before the module's own context exists (the hello goes
 * out first), minus RS_RECEIVER_GPU_FORMAT_MASK; `none` when empty. The module re-derives the same
 * list from its own context at `start` (`delivery_json`), which the evidence records beside it. */
function probeGpuFormats(mask: string | null): string {
  const probe = document.createElement("canvas").getContext("webgl2");
  if (probe === null) return "none";
  const extensions = probe.getSupportedExtensions() ?? [];
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  return gpuFormatsOf(extensions, mask);
}
const CLOSE_WAIT_MS = 2000;
/** RS_RECEIVER_RECONNECT_ON_LOSS: the most lost connections one run reconnects after. */
const LOSS_RECONNECTS_MAX = 3;
const KIND_NAME = ["texture", "mesh", "shader", "texture-ktx2"] as const;

/** The page's fragment token (`#token=<hex>`), read once; the fragment is then removed from the
 * address (before anything logs), so the token is never in a URL, a log line or evidence. */
export function takeToken(): string | null {
  const h = location.hash;
  let token: string | null = null;
  if (h.startsWith("#")) token = new URLSearchParams(h.slice(1)).get("token");
  if (h !== "")
    history.replaceState(null, "", location.pathname + location.search);
  return token === null || token === "" ? null : token;
}

const us = (): number => Math.round(performance.now() * 1000);

/** G7u: whether the page is suspended, really (hidden) or as the lifecycle shim simulates it
 * (`window.__rsLifecycle.suspended()`, scripts/lib/browser-probes/lifecycle-shim.js). */
function pageSuspended(): boolean {
  if (document.visibilityState === "hidden") return true;
  const lc = (
    window as unknown as { __rsLifecycle?: { suspended?: () => boolean } }
  ).__rsLifecycle;
  try {
    return lc?.suspended?.() === true;
  } catch {
    return false;
  }
}

/** G7u applied.json `live.context_loss` (receiver clock: `us()`). */
interface ContextLoss {
  lost_us: number;
  restored_us: number | null;
  resident: { textures: number; meshes: number } | null;
  uploads_after_restore: { textures: number; meshes: number } | null;
  refetched: string[];
  redraw_us: number | null;
  first_tx_after_restore: number | null;
  /** Beyond the contract: what the hold and the redraw saw. */
  losses: number;
  last_applied_before_loss: {
    stream: number;
    seq: number;
    frame: number;
  } | null;
  received_during_loss: number;
  redraw_duration_us: number | null;
  redraw: Record<string, unknown> | null;
  /** Why no redraw ran (nothing applied on the connection yet), or null. */
  redraw_skipped: string | null;
  restore_shot: string | null;
  mechanism: string;
}

interface Queued {
  entry: LiveEntry;
  needed: { hash: string; kind: number }[];
}

interface Pending {
  item: Queued;
  tx: ShellTx;
  stage: "fetch" | "library" | "ready";
  /** Fetched bodies by hash (verified when provided, in wasm's needed order). */
  bodies: Map<
    string,
    { bytes: Uint8Array; fetchIndex: number | null; stageError: string | null }
  >;
  /** The transaction's own fetch-log entries, by hash (`verified` set at provide). */
  logged: Map<string, Record<string, unknown>>;
  /** Operator-library shader code (async reads, before the applying callback). */
  library: "none" | "reading" | "done";
  /** G7q (credit window 2): the seq each payload was requested for. A fold keeps this pending
   * transaction's fetches, so a payload fetched (or refused) for a transaction folded into a
   * later one is logged and failed at its own seq, as receiver.gd does. */
  requester: Map<string, number>;
  /** G7q: each requested payload's kind (a folded transaction's may no longer be needed). */
  kinds: Map<string, number>;
}

export async function runLive(
  cfg: ReceiverConfig,
  canvas: HTMLCanvasElement,
): Promise<void> {
  await new LiveReceiver(cfg, cfg.live as LiveConfig, canvas).run();
}

class LiveReceiver {
  private g: GswRs | null = null;
  /** PM6b: the /12 emitters this receiver simulates (reset with every session). */
  private particles = new GswParticles();
  /** W11t's LiveCoding constructor (the module's), and this connection's decoder (W11c: one per
   * connection, its bases reset with it; null below /11, where nothing is coded). */
  private codingCtor: GswRsModule["LiveCoding"] | null = null;
  private coding: LiveCoding | null = null;
  /** W11c: every connection's coding stats, and the resyncs a coding error asked for. */
  private readonly codingReports: Record<string, unknown>[] = [];
  private codingResyncs = 0;
  /** GRH: the wasm heap (bytes) when the first coding resync was asked, before the applier is
   * rebuilt (evidence only: the leg's end heap also holds the stream's own creep). */
  private heapAtResync: number | null = null;
  /** GRH: set at a rebuild; the next drawn transaction (the resync's full) records its heap and
   * texture uploads in `rebuildApplies`. */
  private rebuildApplyDue = false;
  private lastHeapBeforeRebuild: number | null = null;
  private rebuildApplies: {
    seq: number;
    heap: number | null;
    heap_before_rebuild: number | null;
    texture_upload_bytes: number;
    texture_upload_bytes_before: number;
  }[] = [];
  /** GRH: the texture bytes the GPU took over the transactions drawn so far. */
  private uploadedBytes = 0;
  /** GLJ: the viewer's first applied transaction (a join's whole state at once): the wasm heap
   * before its apply (every payload it names provided and resident), after the apply and after
   * its draw; the texture bytes the draw uploaded, and how many of them the apply had copied
   * into the draw list's byte arena (`arena`) or shared from the payload store (`shared`). */
  private firstApply: {
    seq: number;
    heap_before_apply: number | null;
    heap_after_apply: number | null;
    heap_after_draw: number | null;
    texture_upload_bytes: number;
    arena_bytes: number;
    shared_bytes: number;
    apply_ms: number;
    draw_ms: number;
  } | null = null;
  /** G8kb: KTX2 payloads' verify, transcode and stage (transcode.ts). */
  private ktx: KtxStager | null = null;
  private mem: WebAssembly.Memory | null = null;
  private stats: (() => Record<string, number>) | null = null;
  private readonly perf = new Perf();
  private readonly report: Report;
  private readonly liveBlock: Record<string, unknown>;
  private readonly acks = { received: 0, applied: 0, submitted: 0 };
  private readonly entries: LiveEntry[] = [];
  /** RS_RECEIVER_LOG=full. A summary log keeps no per-transaction state (G7kh): no entries, no
   * fetch log, no shell facts and no per-fold lines, so a long live run's JS heap stays bounded
   * whatever the credit window's fold rate. */
  private readonly keepLog: boolean;
  /** G7kh: transactions folded into a later apply (credit window 2), reported once at the end. */
  private foldedCount = 0;
  private readonly fetchLog: Record<string, unknown>[] = [];
  private readonly fetchedHashes = new Set<string>();
  private readonly puts: Promise<void>[] = [];
  private readonly statePaths = new Map<string, string>();
  /** Per connection: its received tap's URL path and chunks. */
  private readonly taps: {
    path: string;
    chunks: ArrayBuffer[];
    bytes: number;
    /** bytes in `chunks` (less than `bytes` once RS_RECEIVER_RECEIVED_MAX_BYTES is reached) */
    stored: number;
  }[] = [];
  private readonly sabotage: Set<string>;

  private ws: WebSocket | null = null;
  private opened = false;
  private closeInfo: { code: number; reason: string } | null = null;
  private phase:
    | "connecting"
    | "streaming"
    | "reconnect-closing"
    | "draining"
    | "done" = "connecting";
  private deadline = 0;
  private connIndex = 1;
  // D15 (G7k startup): each fires once, on the first connection only.
  private firstAppliedMarked = false;
  private firstSubmittedMarked = false;
  private firstRafAfterSubmitMarked = false;
  private sessionSeen = false;
  private everSession = false;
  private streamId = "";
  private streamReport: Record<string, unknown>;
  private lastAcceptedSeq = 0;
  private lastAppliedSeq = 0;
  private lastAppliedFrame = -1;
  private inlineSinceApplied = 0;
  private queue: Queued[] = [];
  /** G7q (credit window 2): the transactions folded into the next apply (in seq order), each
   * acked `applied` and `submitted` with it (gate7-design.md Q2 "Credit with window w"). */
  private coalesced: Queued["entry"][] = [];
  private pending: Pending | null = null;
  private fetcher: LiveFetcher | null = null;
  private endSeen = false;
  private finished = false;
  private reconnecting = false;
  private reconnectDue = false;
  /** The record the next connection's dispose and connect attempts fill: `live.reconnect` (a
   * scheduled RS_RECEIVER_RECONNECT) or the newest `live.loss_reconnects` entry. */
  private reconnectRecord: Record<string, unknown> | null = null;
  private readonly lossReconnects: Record<string, unknown>[] = [];
  private resyncDone = false;
  private awaitingFull = false;
  private rebuildDue = false;
  private finalDone = false;
  private sessionViewportDone = false;
  private rafIndex = 0;
  private processFrames = 0;
  private rafSkipped = 0;
  private drawnRafs = 0;
  private targetTicks = 0;
  private fenceDrawEnd = -1;
  private resolveDone: () => void = () => {};
  /** G7u: the context's state as the canvas's events report it, and the loss's evidence. */
  private ctxState: "ok" | "lost" | "restoring" = "ok";
  private ctxLoss: ContextLoss | null = null;
  private restoreFetcher: LiveFetcher | null = null;
  private restoreWant: string[] | null = null;
  private readonly restoreBodies = new Map<string, FetchResult>();
  private makeFetcher:
    | ((onBody: (r: FetchResult) => void) => LiveFetcher)
    | null = null;
  private acksWhileHidden = 0;
  /** Transactions applied on the current connection (a reconnect's fresh session has none). */
  private connApplied = 0;

  constructor(
    private readonly cfg: ReceiverConfig,
    private readonly L: LiveConfig,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.keepLog = cfg.log === "full";
    this.sabotage = new Set(cfg.sabotage);
    this.streamReport = this.newStreamReport(L.receivedOut);
    this.taps.push({ path: L.receivedOut, chunks: [], bytes: 0, stored: 0 });
    this.liveBlock = {
      url: L.url,
      credit_stage: L.creditStage,
      inbound_buffer_bytes: L.inboundBytes,
      presented: "unavailable",
      acks_sent: this.acks,
      stall: null,
      reconnect: null,
      resync: null,
      // GSW only: the pacing facts behind `credit-from-paced-loop`.
      gsw: {
        credit_window_requested: L.creditWindow,
        max_fps: L.maxFps,
        // G7v: RS_RECEIVER_DRAW_REPEAT (1 unless the headroom leg asks for more).
        draw_repeat: L.drawRepeat,
        raf_callbacks: 0,
        raf_skipped: 0,
        drawn_rafs: 0,
        ack_on_receipt: this.sabotage.has("ack-on-receipt"),
        // G7u sabotage: submitted acked from onmessage while the page is suspended.
        ack_while_hidden: this.sabotage.has("ack-while-hidden"),
        acks_while_hidden: 0,
      },
      context_loss: null,
    };
    // Only when asked, so every other live leg's applied.json keeps its keys.
    if (L.reconnectOnLoss) this.liveBlock.loss_reconnects = this.lossReconnects;
    canvas.addEventListener("webglcontextlost", () => this.onContextLost());
    canvas.addEventListener("webglcontextrestored", () =>
      this.onContextRestored(),
    );
    this.report = {
      cfg,
      mode: "live",
      recording: { path: L.receivedOut, sha256: null, bytes: null },
      sessionId: null,
      streams: [this.streamReport],
      status: "replay-failure",
      failure: null,
      endSeen: false,
      viewport: {
        display_server: "web",
        size: [canvas.width, canvas.height],
        size_check: null,
        logical_size: null,
        canvas_transform: [],
        presentation_size: null,
        window_size: null,
        oversampling: null,
        presentation_check: null,
        stretch_applied: false,
      },
      shots: [],
      shotsMissed: [],
      sessionUnsupported: [],
      rust: null,
      shell: new Map<string, ShellTx>(),
      fetches: this.fetchLog,
      distinctFetched: 0,
      live: this.liveBlock,
      entries: this.entries,
      protocol: PROTOCOL(this.cfg.liveProtocol),
      creditWindow: null,
      cache: null,
    };
  }

  private newStreamReport(path: string): Record<string, unknown> {
    return {
      stream_id: null,
      connection: null,
      received_path: path,
      received_sha256: null,
      received_bytes: 0,
      end_seen: false,
      closed_by: null,
      close_code: null,
    };
  }

  async run(): Promise<void> {
    const L = this.L;
    const done = new Promise<void>((res) => {
      this.resolveDone = res;
    });
    log(
      `mode live, url ${L.url}, out ${this.cfg.out}, received ${L.receivedOut}, credit ${L.creditStage}, window ${L.creditWindow}, inbound ${L.inboundBytes}, windows ${JSON.stringify(L.windows.map(({ step, from, to }) => ({ step, from, to })))}, stall ${L.stall ? `${L.stall.step}:${L.stall.ms}` : "off"}, reconnect ${L.reconnect ?? "off"}, resync ${L.resync ?? "off"}, max-fps ${L.maxFps}, token ${L.token === null ? "none" : "from the fragment"}, display web, sabotage ${this.cfg.sabotage.join(",") || "none"}`,
    );
    try {
      const loaded = await loadModule();
      this.mem = loaded.memory;
      this.codingCtor = loaded.mod.LiveCoding;
      try {
        this.g = new loaded.mod.GswRs(
          this.canvas,
          JSON.stringify({
            digest: "inline",
            sabotage: this.cfg.sabotage,
            format: "rgb10a2",
            // G7k (Q10 soak): live mode only; `null` (no RS_RECEIVER_MEMORY_BUDGET_BYTES) means
            // the module never evicts, same as native's unbudgeted default.
            memory_budget_bytes: this.cfg.memoryBudgetBytes,
            texture_encodings: this.cfg.textureEncodings ?? "",
            gpu_format_mask: this.cfg.gpuFormatMask ?? "",
            // CG1: /10 is /9's live transport with /10's items (render-stream-10.md); W11c: /11
            // is /10's with /11's records and dynamic meshes (render-stream-11.md).
            ...(this.cfg.liveProtocol >= 9
              ? { live_protocol: this.cfg.liveProtocol }
              : {}),
            // W11c: a summary log keeps no per-transaction evidence in wasm either.
            log: this.cfg.log,
            // G8kb: the bundle carries the KTX2 transcoder worker (transcode.ts).
            transcoder: true,
            variant_policy: this.cfg.variantPolicy ?? "",
          }),
        );
        this.ktx = new KtxStager(this.g, this.mem, {
          log: this.cfg.transcodeLog,
          fault: this.cfg.transcodeFault,
          stream: () => this.connIndex,
        });
      } catch (e) {
        // An unknown RS_RECEIVER_SABOTAGE is a usage error natively (exit 2, nothing written).
        log(`error: ${String(e)}`);
        finish(2);
        return;
      }
      this.stats = statsReader(this.g, this.mem);
      // Before the hello: the leg's presentation size (the session confirms it).
      if (this.cfg.canvas) {
        this.canvas.width = this.cfg.canvas[0];
        this.canvas.height = this.cfg.canvas[1];
        // G7g: the window every session of this process presents into.
        this.g.set_window(this.cfg.canvas[0], this.cfg.canvas[1]);
      }
      this.canvas.style.width = `${this.canvas.width}px`;
      this.canvas.style.height = `${this.canvas.height}px`;
      this.open();
      this.deadline = performance.now() + L.connectTimeoutMs;
    } catch (e) {
      await this.fail(
        e instanceof ReplayFailure
          ? e
          : new ReplayFailure(null, "receiver-error", String(e)),
      );
      return;
    }
    requestAnimationFrame(this.onFrame);
    await done;
  }

  // ------------------------------------------------------------------------- connection

  private open(): void {
    this.opened = false;
    this.closeInfo = null;
    // W11c: a fresh decoder per connection (W11t: the bases are the connection's own).
    if (this.coding !== null)
      this.codingReports.push(
        JSON.parse(this.coding.stats_json()) as Record<string, unknown>,
      );
    this.coding =
      this.cfg.liveProtocol >= 11 && this.codingCtor !== null
        ? new this.codingCtor(this.L.liveCoding, this.L.inboundBytes)
        : null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.L.url, [SUBPROTOCOL(this.cfg.liveProtocol)]);
    } catch (e) {
      throw new ReplayFailure(
        null,
        "live-connect-failed",
        `new WebSocket(${this.L.url}): ${String(e)}`,
      );
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.onOpen(ws);
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ws, ev);
    ws.onclose = (ev: CloseEvent) => {
      if (ws === this.ws) this.closeInfo = { code: ev.code, reason: ev.reason };
    };
    ws.onerror = () => {};
    this.ws = ws;
  }

  private send(message: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      log(
        `warning: could not send ${message.type} (the connection is not open)`,
      );
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private onOpen(ws: WebSocket): void {
    if (ws !== this.ws || this.finished) return;
    this.opened = true;
    this.phase = "streaming";
    // D15 (G7k startup): once only, not on a G7u reconnect's later connections.
    if (this.connIndex === 1) performance.mark("rs-socket-open");
    const lr = this.reconnectRecord;
    if (lr !== null && "opened_us" in lr && lr.opened_us === null)
      lr.opened_us = us();
    const rect = this.canvas.getBoundingClientRect();
    // The /7 hello (Q2), key order as there. The token goes only here, never to a log.
    // G8g: at /8 the same keys under render-stream/8. G8kp: at /9 the same keys under
    // render-stream/9, then the two delivery keys.
    const hello: Record<string, unknown> = {
      type: "hello",
      protocol: PROTOCOL(this.cfg.liveProtocol),
      receiver: "gsw-canvas-receiver",
      receiver_kind: "gsw-canvas",
      credit_stage: this.L.creditStage,
      credit_window: this.L.creditWindow,
      inbound_buffer_bytes: this.L.inboundBytes,
      token: this.L.token,
      manifest_sha256: this.cfg.manifestSha256,
      presentation_backing_w: this.canvas.width,
      presentation_backing_h: this.canvas.height,
      presentation_css_w: Math.round(rect.width),
      presentation_css_h: Math.round(rect.height),
      dpr_milli: Math.round(window.devicePixelRatio * 1000),
    };
    // G8kp: at /9 the same keys under render-stream/9, then the two delivery keys.
    // CG1: /10's hello is /9's under protocol render-stream/10.
    this.send(
      this.cfg.liveProtocol >= 9
        ? helloV9(
            hello,
            // G8kb: GSW transcodes uastc (the module's default with the worker, Q3).
            this.cfg.textureEncodings ?? "block,uastc,decoded",
            probeGpuFormats(this.cfg.gpuFormatMask),
            this.cfg.liveProtocol === 12
              ? "render-stream/12"
              : this.cfg.liveProtocol === 11
                ? "render-stream/11"
                : this.cfg.liveProtocol === 10
                  ? "render-stream/10"
                  : "render-stream/9",
            // W11c: W11t's `live_coding` offer, last (golden-11's control hello); none when off.
            this.L.liveCoding,
          )
        : hello,
    );
    log(
      `connected to ${this.L.url} as connection ${this.connIndex} (subprotocol ${ws.protocol}); hello sent`,
    );
  }

  private ack(
    seq: number,
    stage: "received" | "applied" | "submitted",
    t: number,
  ): void {
    this.send({
      type: "ack",
      stream_id: this.streamId,
      seq,
      stage,
      t_us: t,
    });
    this.acks[stage]++;
  }

  private onMessage(ws: WebSocket, ev: MessageEvent): void {
    if (ws !== this.ws || this.finished || this.phase !== "streaming") return;
    // RS_RECEIVER_RECONNECT: after the reconnect step's submitted ack, nothing more of this
    // connection is read (receiver.gd `_begin_reconnect` runs before `_drain_packets`), so a
    // transaction the host sent on that credit is neither tapped nor acked.
    if (this.reconnectDue) return;
    try {
      if (typeof ev.data === "string") {
        this.onHostText(ev.data);
        return;
      }
      this.onBinary(ev.data as ArrayBuffer);
    } catch (e) {
      void this.fail(
        e instanceof ReplayFailure
          ? e
          : new ReplayFailure(
              this.lastSeqOrNull(),
              "receiver-error",
              e instanceof Error ? e.message : String(e),
            ),
      );
    }
  }

  private onHostText(text: string): void {
    let reason: string | null = null;
    let detail = text;
    try {
      const m = JSON.parse(text) as Record<string, unknown>;
      if (
        Object.keys(m).length === 3 &&
        m.type === "error" &&
        typeof m.reason === "string" &&
        typeof m.detail === "string"
      ) {
        reason = m.reason;
        detail = m.detail;
      }
    } catch {
      // not JSON: unexpected text
    }
    if (reason === "unauthorized" && !this.everSession)
      throw new ReplayFailure(
        null,
        "live-connect-failed",
        `the host refused the hello: unauthorized: ${detail}`,
      );
    throw new ReplayFailure(
      this.lastSeqOrNull(),
      "host-error",
      reason === null
        ? `unexpected text message ${JSON.stringify(text)}`
        : `${reason}: ${detail}`,
    );
  }

  private onBinary(buf: ArrayBuffer): void {
    const g = this.g as GswRs;
    const mem = this.mem as WebAssembly.Memory;
    const now = us();
    const tap = this.taps[this.taps.length - 1];
    // receiver.gd's RS_RECEIVER_RECEIVED_MAX_BYTES: past the cap a message is counted, not stored.
    const cap = this.L.receivedMaxBytes;
    if (cap === null || tap.stored + buf.byteLength <= cap) {
      tap.chunks.push(buf);
      tap.stored += buf.byteLength;
    } else this.streamReport.received_truncated = true;
    tap.bytes += buf.byteLength;
    this.streamReport.received_bytes = tap.bytes;
    let len = buf.byteLength;
    // Q14c step 1: one copy into wasm's receive buffer (the pointer after rx(), which may grow).
    const p = g.rx(len);
    new Uint8Array(mem.buffer, p, len).set(new Uint8Array(buf));
    // W11c: W11t's live coding, decoded in place before anything parses the message.
    if (this.coding !== null) {
      const n = this.coding.decode_rx(g, len);
      if (n === 0) return; // a based transaction while a coding resync is pending: no apply, no ack
      if (n < 0) {
        const seq = this.coding.seq();
        const err = this.coding.error();
        if (seq === 0) throw failWith(this.lastSeqOrNull(), err);
        this.codingResync(seq, err);
        return;
      }
      len = n;
    }
    if (!this.sessionSeen) {
      this.particles = new GswParticles();
      if (g.live_session(len, this.cfg.liveProtocol) < 0)
        throw failWith(null, g.error());
      if (this.cfg.liveProtocol >= 9) {
        this.report.textureDelivery = JSON.parse(g.delivery_json()) as Record<
          string,
          unknown
        >;
        this.report.transcodes = this.ktx?.transcodes ?? [];
        this.report.deliveryFallbacks = this.ktx?.fallbacks ?? [];
      }
      this.sessionSeen = true;
      this.everSession = true;
      this.beginSession();
      return;
    }
    const expected = this.lastAcceptedSeq + 1;
    const t0 = performance.now();
    const code = g.live_accept(len);
    const decodeUs = (performance.now() - t0) * 1000;
    if (code < 0) {
      const err = g.error();
      if (err.startsWith("live-framing")) throw failWith(null, err);
      throw failWith(failureSeq(buf, expected), err);
    }
    if (code === ACCEPT_RESOURCE) {
      this.inlineSinceApplied++;
      return;
    }
    if (code === ACCEPT_END) {
      this.endSeen = true;
      this.streamReport.end_seen = true;
      this.report.endSeen = true;
      log(`end record after ${this.lastAcceptedSeq} transactions`);
      return;
    }
    const st = (this.stats as () => Record<string, number>)();
    const seq = st.seq;
    this.lastAcceptedSeq = seq;
    const digest = hex(new Uint8Array(mem.buffer, g.last_digest_ptr(), 32));
    const entry: LiveEntry = {
      stream: this.connIndex,
      seq,
      frame: st.frame,
      encoding: st.encoding === 0 ? "full" : "patch",
      record_sha256: digest,
      received_us: now,
      // G7mm: the rAF callback that would first handle it (the Godot receivers' poll frame)
      received_process_frame: this.processFrames + 1,
      applied_us: null,
      submitted_us: null,
      submitted_process_frame: null,
      skipped: null,
      paced: {
        received_ms: now / 1000,
        applied_raf: null,
        applied_raf_ts_ms: null,
        applied_ms: null,
        drawn_raf: null,
        drawn_ms: null,
        submitted_ack_ms: null,
        submitted_from: null,
      },
    };
    if (this.keepLog) this.entries.push(entry);
    this.perfDecode.push(decodeUs);
    this.ack(seq, "received", now);
    const whileHidden =
      this.sabotage.has("ack-while-hidden") && pageSuspended();
    if (this.sabotage.has("ack-on-receipt") || whileHidden) {
      // GSW-only sabotages: credit returned from onmessage, before any rAF applied or drew it
      // (`ack-while-hidden`: only while the page is suspended, so it draws nothing).
      if (whileHidden) this.acksWhileHidden++;
      const t = us();
      entry.submitted_us = t;
      entry.submitted_process_frame = this.processFrames + 1;
      entry.paced.submitted_ack_ms = t / 1000;
      entry.paced.submitted_from = "onmessage";
      this.ack(seq, "submitted", t);
    }
    const needed: Queued["needed"] = [];
    if (code === ACCEPT_NEEDS_PAYLOADS) {
      const n = g.needed_count();
      const hashes = new Uint8Array(mem.buffer, g.needed_ptr(), 32 * n).slice();
      const kinds = new Uint8Array(mem.buffer, g.needed_kinds_ptr(), n).slice();
      for (let k = 0; k < n; k++)
        needed.push({
          hash: hex(hashes.subarray(32 * k, 32 * k + 32)),
          kind: kinds[k],
        });
    }
    if (this.ctxState !== "ok" && this.ctxLoss)
      this.ctxLoss.received_during_loss++;
    if (this.pending !== null && this.windowTwo()) {
      // G7q (credit window 2): the next transaction arrived while this one waits for its
      // payloads. The wasm applier has prepared both (rs-core merges their deltas), so the
      // newest is applied for both, with no rebuild; its needed set (computed at its accept,
      // over the merged delta) covers the older one's payloads too. The fold happens in place:
      // the pending transaction becomes the newest and keeps every body fetched and every GET
      // in flight (wasm's stage is keyed by hash, so a staged body serves the newest's needed
      // set as well); only the payloads neither fetched nor requested yet are queued.
      this.foldIntoPending(this.pending, { entry, needed });
      return;
    } else if (this.pending !== null) {
      // The wasm core holds ONE accepted state, so a transaction accepted while another waits
      // for its payloads supersedes it: the newest is applied by a fresh applier (takeQueued's
      // rebuild). Never under credit window 1 with paced credit; the sabotages that return
      // credit early (`ack-while-hidden`, `ack-on-receipt`) let it happen.
      const old = this.pending;
      this.pending = null;
      old.item.entry.skipped = "superseded";
      this.fetcher?.cancel();
      this.rebuildDue = true;
      log(
        `seq ${old.item.entry.seq} superseded by seq ${seq} while its payloads were pending`,
      );
    }
    this.queue.push({ entry, needed });
  }

  private readonly perfDecode: number[] = [];

  private beginSession(): void {
    const g = this.g as GswRs;
    const session = JSON.parse(g.session_meta()) as SessionMeta & {
      stream?: { encoding?: string };
    };
    this.report.sessionId = session.session_id ?? null;
    this.streamId = session.stream?.stream_id ?? "";
    this.streamReport.stream_id = session.stream?.stream_id ?? null;
    this.streamReport.connection = session.stream?.connection ?? null;
    this.report.creditWindow = session.publication?.credit_window ?? 1;
    if (!this.sessionViewportDone) {
      // receiver.gd `_adopt_presentation`: once per process.
      this.sessionViewportDone = true;
      const vr = viewportReport(
        this.cfg,
        this.canvas,
        session,
        g.presentation_json(),
      );
      this.report.viewport = vr.viewport;
      this.report.sessionUnsupported.push(...vr.unsupported);
    }
    this.canvas.style.width = `${this.canvas.width}px`;
    this.canvas.style.height = `${this.canvas.height}px`;
    const res = session.resources ?? {};
    const fetchKind = res.fetch ?? "none";
    if (fetchKind === "directory")
      throw new ReplayFailure(
        null,
        "resource-unavailable",
        "a live session advertises fetch directory",
      );
    if (fetchKind === "http") {
      const httpPath = res.http_path ?? null;
      if (httpPath === null)
        throw new ReplayFailure(
          null,
          "resource-unavailable",
          `fetch http with http_path null on ${this.L.url}`,
        );
      this.fetcher?.cancel();
      // G2e sabotage wrong-http-token: the hello carried the right token; only GETs carry this.
      let token = this.L.token;
      if (this.sabotage.has("wrong-http-token") && token !== null)
        token = `${token}-wrong`;
      this.makeFetcher = (onBody) =>
        new LiveFetcher(
          this.L.httpOrigin,
          httpPath,
          this.L.fetchTimeoutMs,
          this.cfg.fetchDelayMs,
          token,
          this.sabotage.has("ignore-cache"),
          onBody,
        );
      this.fetcher = this.makeFetcher((r) => this.stageFetched(r));
    }
    log(
      `session ${session.session_id} stream ${session.stream?.stream_id} (${session.stream?.transport}, ${session.stream?.encoding}) applied, credit window ${this.report.creditWindow}`,
    );
    // D15 (G7k startup): the session record decoded and its viewport adopted, once (connIndex 1
    // only: a G7u reconnect starts a fresh session on a later connection too).
    if (this.connIndex === 1) performance.mark("rs-session-decoded");
  }

  private lastSeqOrNull(): number | null {
    return this.lastAcceptedSeq > 0 ? this.lastAcceptedSeq : null;
  }

  // ------------------------------------------------------------------------- the rAF loop

  private readonly onFrame = (ts: number): void => {
    if (this.finished) return;
    this.rafIndex++;
    // D13/Q9: the timestamp of the first rAF callback after a submitted ack (raf_after_submit,
    // never `presented`), whether or not the max-fps rule then skips this callback.
    this.perf.rafAfterSubmit(ts);
    // D15 (G7k startup): the rAF this receiver's own raf_after_submit series first recorded.
    if (
      this.connIndex === 1 &&
      !this.firstRafAfterSubmitMarked &&
      this.perf.rafAfterSubmitUs.length > 0
    ) {
      this.firstRafAfterSubmitMarked = true;
      performance.mark("rs-first-raf-after-submit");
    }
    // wm.cpp:83-97: skip a callback before target_ticks; reset after a gap over one second.
    if (this.L.maxFps > 0) {
      const current = Math.floor(performance.now() * 1000);
      if (current < this.targetTicks) {
        this.rafSkipped++;
        requestAnimationFrame(this.onFrame);
        return;
      }
      if (current - this.targetTicks > 1000000) this.targetTicks = current;
      this.targetTicks += Math.floor(1000000 / this.L.maxFps);
    }
    this.processFrames++;
    this.perf.raf(ts);
    // G7r: the paced loop's cumulative counters once a second (perf.json `timeline`), the
    // native receiver's per-second `frames` line, so the g6c checks measure this receiver's
    // frame rate (paced callbacks; `drawn` counts those that drew) on its own clock. G7k adds a
    // residency snapshot on the same once-a-second tick (`sampleTimeline` self-throttles, so
    // this callback only actually runs the wasm call and the leak sabotage's own pacing once a
    // second, not every rAF).
    const leaking = this.sabotage.has("leak-gl-textures");
    this.perf.sampleTimeline(this.processFrames, this.drawnRafs, () => {
      if (leaking) leakOneIfDue(ts);
      const r = JSON.parse((this.g as GswRs).residency_json()) as {
        entries: number;
        bytes: number;
        gl_texture_bytes: number;
        pinned_bytes: number;
        evictions: number;
        budget_bytes: number | null;
        resident_items: number;
        resident_textures: number;
        resident_meshes: number;
        resident_shaders: number;
        resident_materials: number;
        // W11c: present at /11 only.
        dynamic_meshes?: number;
        dynamic_surfaces?: number;
        dynamic_bytes?: number;
        dynamic_bodies_total?: number;
        released_total?: number;
        release_pending?: number;
        names?: number;
        carried?: number;
      };
      this.perf.residencyEvictions = r.evictions;
      this.perf.residencyBudgetBytes = r.budget_bytes;
      return {
        cache_entries_memory: r.entries,
        cache_bytes_memory: r.bytes + r.gl_texture_bytes,
        gl_texture_bytes: r.gl_texture_bytes,
        memory_floor_bytes: r.pinned_bytes + r.gl_texture_bytes,
        wasm_heap_bytes: window.__rsWasmHeap?.() ?? null,
        resident_items: r.resident_items,
        resident_textures: r.resident_textures,
        resident_meshes: r.resident_meshes,
        resident_shaders: r.resident_shaders,
        resident_materials: r.resident_materials,
        leaked_gl_textures: leakedGlTextureCount(),
        ...(r.names !== undefined
          ? {
              w11: {
                dynamic_meshes: r.dynamic_meshes ?? 0,
                dynamic_surfaces: r.dynamic_surfaces ?? 0,
                dynamic_bytes: r.dynamic_bytes ?? 0,
                dynamic_bodies_total: r.dynamic_bodies_total ?? 0,
                released_total: r.released_total ?? 0,
                release_pending: r.release_pending ?? 0,
                names: r.names,
                carried: r.carried ?? 0,
              },
            }
          : {}),
      };
    });
    const g = this.g as GswRs;
    if (this.fenceDrawEnd >= 0 && g.poll_fence() === 1) {
      this.perf.gpuComplete.push(performance.now() - this.fenceDrawEnd);
      this.fenceDrawEnd = -1;
    }
    try {
      this.step(ts);
    } catch (e) {
      void this.fail(
        e instanceof ReplayFailure
          ? e
          : e instanceof ProgramError
            ? new ReplayFailure(
                this.lastAppliedSeq || null,
                e.reason,
                e.message,
              )
            : new ReplayFailure(
                this.lastSeqOrNull(),
                "receiver-error",
                e instanceof Error ? e.message : String(e),
              ),
      );
      return;
    }
    if (!this.finished) requestAnimationFrame(this.onFrame);
  };

  /** receiver.gd `_process_live`, one callback. */
  private step(ts: number): void {
    const now = performance.now();
    if (this.reconnectDue && this.phase === "streaming") {
      this.beginReconnect();
      return;
    }
    switch (this.phase) {
      case "connecting":
        if (now > this.deadline) {
          throw new ReplayFailure(
            null,
            "live-connect-failed",
            `no open connection to ${this.L.url} (state ${this.ws?.readyState ?? -1}, close code ${this.closeInfo?.code ?? -1})`,
          );
        }
        if (this.closeInfo !== null) {
          if (!this.reconnecting) throw this.connectFailure();
          // A reconnect can race the host's teardown of connection 1 (one receiver at a time):
          // retry until the connect timeout.
          const r = this.reconnectRecord as Record<string, number>;
          r.connect_attempts = (r.connect_attempts ?? 1) + 1;
          this.open();
        }
        return;
      case "reconnect-closing":
        if (this.closeInfo !== null || now > this.deadline)
          this.startNextConnection();
        return;
      case "draining":
        if (this.closeInfo !== null || now > this.deadline) {
          this.streamReport.closed_by = "receiver";
          this.streamReport.close_code = 1000;
          this.phase = "done";
          void this.finishLive();
        }
        return;
      case "done":
        return;
      default:
        break;
    }
    // G7u: a lost context holds the loop (nothing applied or drawn, so no credit returns); the
    // callback after the restore redraws with no transaction.
    if (this.ctxState !== "ok") {
      this.stepContext();
      if (this.finished) return;
    } else if (this.pending !== null) {
      // The pending transaction's fetches; it is applied in the callback they complete in.
      this.advancePending();
      if (this.finished || this.pending.stage !== "ready") return;
      this.applyReady(ts);
      if (this.finished) return;
    } else if (this.queue.length > 0) {
      this.takeQueued(ts);
      if (this.finished) return;
    }
    if (
      this.ctxState === "ok" &&
      this.endSeen &&
      this.queue.length === 0 &&
      this.pending === null
    ) {
      if (this.L.shotFinal && !this.finalDone) {
        this.finalDone = true;
        this.finalShot();
        return;
      }
      // The receiver closes first (the host lingers for it after the end record).
      this.phase = "draining";
      this.ws?.close(1000, "end seen");
      this.deadline = now + CLOSE_WAIT_MS;
      return;
    }
    if (this.closeInfo !== null && !this.endSeen) {
      const { code, reason } = this.closeInfo;
      this.streamReport.closed_by = "host";
      this.streamReport.close_code = code;
      if (!this.everSession && code === 1008 && reason === "unauthorized")
        throw this.connectFailure();
      if (code === 1002 || code === 1008 || code === 1009)
        throw new ReplayFailure(
          this.lastSeqOrNull(),
          "host-error",
          `${reason}: the host closed with ${code}`,
        );
      if (
        this.L.reconnectOnLoss &&
        this.sessionSeen &&
        this.lossReconnects.length < LOSS_RECONNECTS_MAX
      ) {
        this.beginLossReconnect(code, reason);
        return;
      }
      throw new ReplayFailure(
        this.lastSeqOrNull(),
        "live-disconnected",
        `the connection closed (code ${code} ${JSON.stringify(reason)}) without an end record`,
      );
    }
  }

  private connectFailure(): ReplayFailure {
    const c = this.closeInfo;
    const why =
      c === null
        ? "no close"
        : c.code === 1008 && c.reason === "unauthorized"
          ? "the host refused the hello: unauthorized (close 1008)"
          : `close code ${c.code}${c.reason ? ` ${JSON.stringify(c.reason)}` : ""}${this.opened ? "" : ", never opened"}`;
    return new ReplayFailure(
      null,
      "live-connect-failed",
      `no open connection to ${this.L.url} (${why})`,
    );
  }

  /** G7q: the session granted credit window 2 (publication.credit_window). Window 1 keeps its
   * superseded-and-rebuild path exactly as it was. */
  private windowTwo(): boolean {
    return (this.report.creditWindow ?? 1) >= 2;
  }

  /** G7q: `next` (just accepted) folds into the pending transaction `p` in place: `p` becomes
   * `next`, the older entry is applied and acked with it, and the fetches `p` made are kept. */
  private foldIntoPending(p: Pending, next: Queued): void {
    const old = p.item.entry;
    this.coalesced.push(old);
    old.coalesced_into = next.entry.seq;
    p.item = next;
    // The newest's needed set is fetched and provided from the start (accept reset wasm's provide
    // cursor; payloads the older one already provided are in the store, so not needed again).
    p.stage = "fetch";
    if (p.library === "done") p.library = "none";
    const asked = this.fetcher?.requested() ?? new Set<string>();
    const misses = next.needed
      .map((n) => n.hash)
      .filter((h) => !p.bodies.has(h) && !asked.has(h));
    for (const h of misses) p.requester.set(h, next.entry.seq);
    for (const n of next.needed) p.kinds.set(n.hash, n.kind);
    // Queued (never issued) requests the newest no longer needs are dropped; one in flight
    // completes (advancePending waits for it).
    this.fetcher?.retain(new Set(next.needed.map((n) => n.hash)));
    if (misses.length > 0) {
      if (this.fetcher === null)
        throw new ReplayFailure(
          next.entry.seq,
          "resource-unavailable",
          `payload ${misses[0]} is needed, and the session has no HTTP fetch`,
        );
      this.checkFetches(next.entry.seq, misses);
      this.fetcher.extend(misses);
    }
    // G7kh: one line per fold only in a full log; the page keeps every log line (shell.lines),
    // and at window 2 a fold happens on about every other transaction.
    if (this.keepLog)
      log(
        `seq ${old.seq} folds into seq ${next.entry.seq} while its payloads were pending (${misses.length} more to fetch)`,
      );
  }

  /** The newest queued transaction becomes the one to apply (receiver.gd `_apply_newest`). */
  private takeQueued(ts: number): void {
    const g = this.g as GswRs;
    let rebuild = this.rebuildDue;
    const queued = this.queue;
    this.queue = [];
    const item = queued[queued.length - 1];
    const folded = queued.slice();
    // G7q (credit window 2): a payload is requested for the oldest queued transaction that needed
    // it (its own accept's needed set), so a fetch, or its failure, is logged at the seq that first
    // named it even when that seq is folded into the newest here.
    const firstNeeder = new Map<string, number>();
    if (this.windowTwo())
      for (const q of queued)
        for (const n of q.needed)
          if (!firstNeeder.has(n.hash)) firstNeeder.set(n.hash, q.entry.seq);
    if (this.windowTwo()) {
      // G7q (credit window 2): several queued transactions apply in this one callback (the
      // applier merged their deltas as each was accepted), drawing only the newest.
      for (const older of queued.slice(0, -1)) {
        this.coalesced.push(older.entry);
        older.entry.coalesced_into = item.entry.seq;
      }
      queued.length = 1;
    }
    for (const older of queued.slice(0, -1)) {
      // Never under credit window 1: the wasm state is the newest, so older ones are superseded
      // and the newest is applied by a fresh applier walking the whole resolved state.
      older.entry.skipped = "superseded";
      log(
        `seq ${older.entry.seq} superseded by seq ${item.entry.seq} before it was applied`,
      );
      rebuild = true;
    }
    if (this.windowTwo()) this.endWaitOnFoldedFull(folded, item.entry);
    if (this.refuseForResync(item.entry)) return;
    if (rebuild) {
      this.rebuildDue = false;
      this.lastHeapBeforeRebuild = this.mem?.buffer.byteLength ?? null;
      const code = g.live_rebuild();
      this.rebuildApplyDue = true;
      if (code < 0) throw failWith(item.entry.seq, g.error());
      item.needed = this.readNeeded(code);
    }
    this.pending = {
      item,
      tx: {
        fetched: 0,
        fetched_bytes: 0,
        fetch_us: 0,
        inline_received: 0,
        shader_payload_fetches: 0,
        process_frame: this.processFrames,
        cache_hits: 0,
      },
      stage: "fetch",
      bodies: new Map(),
      logged: new Map(),
      library: "none",
      requester: new Map(
        item.needed.map((n) => [
          n.hash,
          firstNeeder.get(n.hash) ?? item.entry.seq,
        ]),
      ),
      kinds: new Map(item.needed.map((n) => [n.hash, n.kind])),
    };
    const misses = item.needed.map((n) => n.hash);
    if (misses.length > 0) {
      if (this.fetcher === null)
        throw new ReplayFailure(
          item.entry.seq,
          "resource-unavailable",
          `payload ${misses[0]} is needed, and the session has no HTTP fetch`,
        );
      this.checkFetches(item.entry.seq, misses);
      this.fetcher.start(misses);
    }
    this.advancePending();
    if (this.finished || this.pending?.stage !== "ready") return;
    this.applyReady(ts);
  }

  private readNeeded(code: number): Queued["needed"] {
    const g = this.g as GswRs;
    const mem = this.mem as WebAssembly.Memory;
    const out: Queued["needed"] = [];
    if (code !== ACCEPT_NEEDS_PAYLOADS) return out;
    const n = g.needed_count();
    const hashes = new Uint8Array(mem.buffer, g.needed_ptr(), 32 * n).slice();
    const kinds = new Uint8Array(mem.buffer, g.needed_kinds_ptr(), n).slice();
    for (let k = 0; k < n; k++)
      out.push({
        hash: hex(hashes.subarray(32 * k, 32 * k + 32)),
        kind: kinds[k],
      });
    return out;
  }

  /** One step of the pending transaction: its fetches (polled), then (all in) every payload
   * provided to wasm in its needed order and verified there, then any library shader code. */
  private advancePending(): void {
    const p = this.pending as Pending;
    const g = this.g as GswRs;
    const mem = this.mem as WebAssembly.Memory;
    const seq = p.item.entry.seq;
    if (p.stage === "fetch") {
      // G7q (credit window 2): after a fold in place, a GET made for the older transaction may
      // still be in flight (or done and not yet polled) although the newest no longer needs its
      // payload; it completes into this transaction first, so every GET is logged and held in
      // memory like any other fetch (receiver.gd likewise finishes a transaction's fetches before
      // it folds). Never at window 1, where every request is for a needed payload.
      const fetcherBusy = (): boolean =>
        this.windowTwo() && (this.fetcher?.busy() ?? false);
      const fetchOutstanding =
        p.item.needed.some((n) => !p.bodies.has(n.hash)) || fetcherBusy();
      if (fetchOutstanding && this.fetcher !== null) {
        const { results } = this.fetcher.poll();
        for (const r of results) this.noteFetch(p, r);
        if (this.finished) return;
        const stillOut =
          p.item.needed.some((n) => !p.bodies.has(n.hash)) || fetcherBusy();
        if (stillOut) return;
      }
      // Every payload is in, each verified and decoded in its fetch completion (G7o2,
      // `stageFetched`): move them to wasm's store in its order. A refused one fails here, where
      // `provide` failed it before.
      const t0 = performance.now();
      for (const n of p.item.needed) {
        const body = p.bodies.get(n.hash) as { stageError: string | null };
        if (body.stageError !== null || g.provide_staged() < 0) {
          const err = body.stageError ?? g.error();
          throw new ReplayFailure(
            p.requester.get(n.hash) ?? seq,
            err.startsWith("resource-hash")
              ? "resource-hash-mismatch"
              : "resource-invalid",
            err,
          );
        }
        const logged = p.logged.get(n.hash);
        if (logged) logged.verified = true;
        if (n.kind === 2) p.tx.shader_payload_fetches++;
      }
      // G7q: a body fetched for a transaction folded into this one that this one no longer needs
      // (its payload was replaced in between) goes to the store too, verified on arrival like any
      // other: it is in memory, as receiver.gd's fetched payloads are, so it is never refetched.
      // Empty at window 1.
      for (const [hash, body] of p.bodies) {
        if (p.item.needed.some((n) => n.hash === hash)) continue;
        if (body.stageError === null && !g.is_staged(hash)) continue; // provided earlier
        if (body.stageError !== null || g.restore_take(hash) < 0) {
          const err = body.stageError ?? g.error();
          throw new ReplayFailure(
            p.requester.get(hash) ?? seq,
            err.startsWith("resource-hash")
              ? "resource-hash-mismatch"
              : "resource-invalid",
            err,
          );
        }
        const logged = p.logged.get(hash);
        if (logged) logged.verified = true;
      }
      this.provideUs = (performance.now() - t0) * 1000;
      p.stage = "library";
    }
    if (p.stage === "library") {
      if (p.library === "reading") return;
      if (p.library === "none" && needsLibrary(g, this.cfg.shaderLibrary)) {
        // An operator library read is async: the transaction is applied in a later callback.
        p.library = "reading";
        provideLibrary(g, mem, this.cfg.shaderLibrary, this.perf.programs)
          .then(() => {
            p.library = "done";
          })
          .catch((e: unknown) => {
            void this.fail(new ReplayFailure(seq, "receiver-error", String(e)));
          });
        return;
      }
      p.stage = "ready";
    }
  }

  private provideUs = 0;
  /** G7o2: the pending transaction's payloads' verify and decode, in their fetch completions. */
  private verifyUs = 0;

  /** G7o2: a 200 body in its fetch completion (between frames): into wasm, verified against the
   * hash it was fetched for and decoded (`stage_payload`). A refusal is kept on the result and
   * raised when the transaction is provided. */
  private stageFetched(r: FetchResult): void | Promise<void> {
    const g = this.g;
    const mem = this.mem;
    if (!g || !mem || !r.data) return;
    const t0 = performance.now();
    // G8kb: a KTX2 (uastc) body is verified, transcoded in the worker and staged; the fetcher
    // hands the result back once that settled. A failed transcode is a fallback, not a refusal.
    if (this.ktx && g.is_ktx2(r.hash)) {
      const seq = this.pending?.requester.get(r.hash) ?? this.pending?.item.entry.seq ?? null;
      return this.ktx.stage(r.hash, r.data, seq).then((o) => {
        r.stage_error = o.error;
        r.transcode_fallback = o.fallback;
        r.verify_us = (performance.now() - t0) * 1000;
      });
    }
    const ptr = g.alloc_payload(r.data.length);
    new Uint8Array(mem.buffer, ptr, r.data.length).set(r.data);
    r.stage_error =
      g.stage_payload(r.data.length, r.hash) < 0 ? g.error() : null;
    r.verify_us = (performance.now() - t0) * 1000;
  }

  /** G8kb (Q3 `delivery-transcode-failed`): wasm refused the variant and recomputed the pending
   * transaction's needed set; adopt it and fetch what is neither held nor requested (the entry's
   * `decoded` payload). */
  private fetchFallback(p: Pending): void {
    const g = this.g as GswRs;
    const fresh = this.readNeeded(
      g.needed_count() > 0 ? ACCEPT_NEEDS_PAYLOADS : 0,
    );
    p.item.needed = fresh;
    for (const n of fresh) {
      p.kinds.set(n.hash, n.kind);
      if (!p.requester.has(n.hash)) p.requester.set(n.hash, p.item.entry.seq);
    }
    const requested = this.fetcher?.requested() ?? new Set<string>();
    const misses = fresh
      .map((n) => n.hash)
      .filter((h) => !p.bodies.has(h) && !requested.has(h));
    if (misses.length > 0) {
      this.checkFetches(p.item.entry.seq, misses);
      this.fetcher?.extend(misses);
    }
  }

  /** W11c (render-stream-11.md decision 9, `inline-fetch-zero`): a /11 receiver never GETs a
   * hash that always arrives inline (named by the newest state, or carried, and inline-sized).
   * The validator answers (`check_fetch`); a refusal is this receiver's failure, before any GET. */
  private checkFetches(seq: number, misses: readonly string[]): void {
    if (this.cfg.liveProtocol < 11) return;
    const g = this.g as GswRs;
    for (const h of misses) {
      const err = g.check_fetch(h);
      if (err !== "") throw new ReplayFailure(seq, "inline-fetch-zero", err);
    }
  }

  /** One completed GET, logged as receiver.gd `_poll_fetches` logs it. */
  private noteFetch(p: Pending, r: FetchResult): void {
    const entry = p.item.entry;
    // G7q: the seq the GET was made for (an older one folded into `entry` at window 2).
    const forSeq = p.requester.get(r.hash) ?? entry.seq;
    const logged: Record<string, unknown> = {
      stream: this.connIndex,
      seq: forSeq,
      hash: r.hash,
      source: "http",
      status: r.status,
      bytes: r.bytes,
      start_us: r.start_us,
      end_us: r.end_us,
      verified: false,
      delay_us: r.delay_us,
      headers: r.headers,
    };
    if (this.keepLog) this.fetchLog.push(logged);
    p.tx.fetch_us += r.end_us - r.start_us;
    this.perf.fetchUs.push(r.end_us - r.start_us);
    if (r.error !== "") {
      void this.fail(failWith(forSeq, r.error));
      return;
    }
    // receiver.gd `_poll_fetches`: a 200 body's kind is recorded before it is verified.
    const kind =
      p.item.needed.find((n) => n.hash === r.hash)?.kind ??
      p.kinds.get(r.hash) ??
      0;
    logged.kind = KIND_NAME[kind] ?? "texture";
    p.logged.set(r.hash, logged);
    p.bodies.set(r.hash, {
      bytes: r.data as Uint8Array,
      fetchIndex: null,
      stageError: r.stage_error ?? null,
    });
    if (r.transcode_fallback) this.fetchFallback(p);
    this.verifyUs += r.verify_us ?? 0;
    p.tx.fetched++;
    p.tx.fetched_bytes += r.bytes;
    this.fetchedHashes.add(r.hash);
  }

  /** The pending transaction, every payload in: apply, ack applied, dump, draw, shot, stall,
   * ack submitted, all in this rAF callback (Q5 "Credit and pacing"). */
  private applyReady(ts: number): void {
    const p = this.pending as Pending;
    this.pending = null;
    const g = this.g as GswRs;
    const entry = p.item.entry;
    const seq = entry.seq;
    const q0 = performance.now();
    try {
      definePrograms(g, this.perf.programs, (line) =>
        log(`seq ${seq}: ${line}`),
      );
    } catch (e) {
      if (e instanceof ProgramError)
        throw new ReplayFailure(seq, e.reason, e.message);
      throw e;
    }
    const programUs = (performance.now() - q0) * 1000;
    const firstHeap =
      this.firstApply === null ? (this.mem?.buffer.byteLength ?? null) : null;
    const b = performance.now();
    this.particles.step(g);
    if (g.apply() < 0) throw failWith(seq, g.error());
    const c = performance.now();
    const firstHeapApplied =
      this.firstApply === null ? (this.mem?.buffer.byteLength ?? null) : null;
    const appliedUs = us();
    entry.applied_us = appliedUs;
    entry.paced.applied_raf = this.rafIndex;
    entry.paced.applied_raf_ts_ms = ts;
    entry.paced.applied_ms = appliedUs / 1000;
    this.lastAppliedSeq = seq;
    this.lastAppliedFrame = entry.frame;
    this.connApplied++;
    if (
      this.ctxLoss !== null &&
      this.ctxLoss.redraw_us !== null &&
      this.ctxLoss.first_tx_after_restore === null
    )
      this.ctxLoss.first_tx_after_restore = seq;
    p.tx.process_frame = this.processFrames;
    p.tx.inline_received = this.inlineSinceApplied;
    this.inlineSinceApplied = 0;
    // Only a full log writes per-transaction facts (appliedJson's `transactions` is null otherwise).
    if (this.keepLog) this.report.shell.set(`${entry.stream}:${seq}`, p.tx);
    // G7q: the transactions folded into this apply are applied with it, acked first, in order.
    const folded = this.coalesced;
    this.coalesced = [];
    for (const f of folded) {
      f.applied_us = appliedUs;
      f.paced.applied_raf = this.rafIndex;
      f.paced.applied_raf_ts_ms = ts;
      f.paced.applied_ms = appliedUs / 1000;
      f.coalesced_into = seq;
      this.connApplied++;
      this.ack(f.seq, "applied", appliedUs);
    }
    this.foldedCount += folded.length;
    if (folded.length > 0 && this.keepLog)
      log(
        `seq ${seq} applied with ${folded.map((f) => f.seq).join(",")} (credit window 2)`,
      );
    this.ack(seq, "applied", appliedUs);
    // D15 (G7k startup): the first transaction (never the session record) applied, once.
    if (this.connIndex === 1 && !this.firstAppliedMarked) {
      this.firstAppliedMarked = true;
      performance.mark("rs-first-applied");
    }
    // The first unshot window holding this frame (receiver.gd `_finish_apply`).
    let step = -1;
    for (const w of this.L.windows)
      if (!w.shot && entry.frame >= w.from && entry.frame <= w.to) {
        step = w.step;
        w.shot = true;
        break;
      }
    const name = this.seqName(seq);
    if (step >= 0) {
      const rel = `state/${name}.json`;
      this.puts.push(put(this.cfg, rel, g.state_dump()));
      this.statePaths.set(name, underOut(this.cfg, rel));
      log(`state seq ${seq} -> ${underOut(this.cfg, rel)}`);
    }
    // Draw and blit (Q14c step 4); GSW draws only in a callback that applied a transaction.
    const d0 = performance.now();
    // G7v `dev-gpu-headroom`: RS_RECEIVER_DRAW_REPEAT draws the same frame N times; each draw
    // clears and fills the stage target and blits it, so only the last one is seen.
    for (let r = 1; r < this.L.drawRepeat; r++)
      if (g.draw() < 0) throw failWith(seq, g.error());
    if (g.draw() < 0) throw failWith(seq, g.error());
    const d1 = performance.now();
    this.fenceDrawEnd = d1;
    this.drawnRafs++;
    entry.paced.drawn_raf = this.rafIndex;
    entry.paced.drawn_ms = d1;
    for (const f of folded) {
      f.paced.drawn_raf = this.rafIndex;
      f.paced.drawn_ms = d1;
    }
    const st = (this.stats as () => Record<string, number>)();
    const decodeUs = this.perfDecode.length
      ? (this.perfDecode.pop() as number)
      : 0;
    this.perfDecode.length = 0;
    const provideUs = this.provideUs;
    this.provideUs = 0;
    const verifyUs = this.verifyUs;
    this.verifyUs = 0;
    if (step >= 0) {
      const sp = g.shot();
      if (sp === 0) throw new ReplayFailure(seq, "shot-failed", g.error());
      const w = g.target_width();
      const h = g.target_height();
      const mem = this.mem as WebAssembly.Memory;
      const rgba = new Uint8Array(mem.buffer, sp, w * h * 4).slice();
      const rel = `shots/${name}.png`;
      this.puts.push(
        encodePng(rgba, w, h).then((png) => put(this.cfg, rel, png)),
      );
      this.report.shots.push({
        stream: this.connIndex,
        seq,
        step,
        path: underOut(this.cfg, rel),
        state_path: this.statePaths.get(name) ?? null,
        process_frame: this.processFrames,
        applied_through: this.lastAppliedSeq,
        frame: entry.frame,
      });
      log(
        `shot step ${step} seq ${seq} frame ${entry.frame} -> ${underOut(this.cfg, rel)}`,
      );
    }
    if (
      step >= 0 &&
      this.L.stall &&
      step === this.L.stall.step &&
      this.liveBlock.stall === null
    ) {
      // RS_RECEIVER_STALL: an injected receiver delay (the page's main thread blocked), not GPU
      // work; the host sees only a credit that does not come back.
      const start = us();
      const until = performance.now() + this.L.stall.ms;
      while (performance.now() < until) {
        // busy-wait: the rAF callback holds the main thread
      }
      const end = us();
      this.liveBlock.stall = {
        step,
        ms: this.L.stall.ms,
        after_seq: seq,
        after_frame: entry.frame,
        start_us: start,
        end_us: end,
        injected: true,
        mechanism:
          "a busy-wait on the page's main thread inside the rAF callback, after the shot readback, before the submitted ack",
      };
      log(
        `stall: blocked ${end - start} us after the step ${step} shot (seq ${seq}), injected`,
      );
    }
    let submittedMs: number | null = null;
    if (
      (this.L.creditStage === "submitted" || step >= 0) &&
      entry.paced.submitted_from === null
    ) {
      const t = us();
      entry.submitted_us = t;
      entry.submitted_process_frame = this.processFrames;
      entry.paced.submitted_ack_ms = t / 1000;
      entry.paced.submitted_from = "raf";
      submittedMs = t / 1000;
      for (const f of folded) {
        // G7q: each folded transaction was drawn in this frame; its own submitted ack first,
        // unless it already sent one (the GSW-only sabotages ack in onmessage, ack-on-receipt
        // and ack-while-hidden: never twice, and its evidence keeps `onmessage`).
        if (f.paced.submitted_from !== null) continue;
        f.submitted_us = t;
        f.submitted_process_frame = this.processFrames;
        f.paced.submitted_ack_ms = t / 1000;
        f.paced.submitted_from = "raf";
        this.ack(f.seq, "submitted", t);
      }
      this.ack(seq, "submitted", t);
      this.perf.submitted(t / 1000);
      // D15 (G7k startup): the first submitted ack of the honest credit path, once.
      if (this.connIndex === 1 && !this.firstSubmittedMarked) {
        this.firstSubmittedMarked = true;
        performance.mark("rs-first-submitted");
      }
    }
    if (this.firstApply === null) {
      const up = JSON.parse(g.last_upload_bytes_json()) as {
        arena: number;
        shared: number;
      };
      this.firstApply = {
        seq,
        heap_before_apply: firstHeap,
        heap_after_apply: firstHeapApplied,
        heap_after_draw: this.mem?.buffer.byteLength ?? null,
        texture_upload_bytes: st.texture_upload_bytes,
        arena_bytes: up.arena,
        shared_bytes: up.shared,
        apply_ms: c - b,
        draw_ms: d1 - d0,
      };
    }
    if (this.rebuildApplyDue) {
      // GRH: the resync's full, applied and drawn: what the fresh applier made the GPU take, and
      // the wasm heap right after it (not the leg's end, which creeps with the stream).
      this.rebuildApplyDue = false;
      this.rebuildApplies.push({
        seq,
        heap: this.mem?.buffer.byteLength ?? null,
        heap_before_rebuild: this.lastHeapBeforeRebuild,
        texture_upload_bytes: st.texture_upload_bytes,
        texture_upload_bytes_before: this.uploadedBytes,
      });
    }
    this.uploadedBytes += st.texture_upload_bytes;
    this.perf.samples.push({
      seq,
      frame: st.frame,
      t_ms: performance.now(),
      decode_us: decodeUs,
      provide_us: provideUs,
      program_us: programUs,
      apply_us: (c - b) * 1000,
      draw_us: (d1 - d0) * 1000,
      total_us:
        decodeUs + provideUs + programUs + (c - b) * 1000 + (d1 - d0) * 1000,
      evidence_hash_us: 0,
      payload_verify_us: verifyUs,
      structural: st.structural,
      relowered: st.relowered,
      rows_written: st.rows_written,
      executed_calls: st.executed_calls,
      texture_upload_bytes: st.texture_upload_bytes,
      item_bytes: st.item_bytes,
      vertex_bytes: st.vertex_bytes,
      stream: entry.stream,
      raf: this.rafIndex,
      raf_ts_ms: ts,
      applied_ack_ms: appliedUs / 1000,
      submitted_ack_ms: submittedMs,
      submitted_from: entry.paced.submitted_from,
    });
    if (
      step >= 0 &&
      this.L.reconnect !== null &&
      step === this.L.reconnect &&
      this.liveBlock.reconnect === null
    ) {
      this.liveBlock.reconnect = {
        step,
        after_seq: seq,
        after_frame: entry.frame,
        connect_attempts: 1,
        created_rids: null,
        freed_by_apply: null,
        owned_before_dispose: null,
        freed_rids: null,
        leftover_rids: null,
        closed_us: null,
      };
      this.reconnectRecord = this.liveBlock.reconnect as Record<
        string,
        unknown
      >;
      this.reconnectDue = true;
    }
  }

  private seqName(seq: number): string {
    return this.connIndex > 1
      ? `stream-${this.connIndex}-seq-${seq}`
      : `seq-${seq}`;
  }

  /**
   * G7rf: a fold applied for a resync wait can hold the forced full and a later patch. The full
   * ends the wait (receiver.gd `_end_wait_on_folded_full`): the transactions before it are
   * refused without a second resync (the host already has one outstanding), the full and the
   * ones after it apply with the newest, so the newest is never refused.
   */
  private endWaitOnFoldedFull(folded: Queued[], newest: LiveEntry): void {
    if (this.L.resync === null || !this.awaitingFull) return;
    const at = foldedFullIndex(
      folded.map((q) => q.entry),
      newest.encoding,
    );
    if (at < 0) return;
    const full = folded[at].entry;
    this.awaitingFull = false;
    this.rebuildDue = true;
    log(
      `resync: full transaction seq ${full.seq} arrived (folded with seq ${newest.seq})`,
    );
    const before = new Set(folded.slice(0, at).map((q) => q.entry));
    for (const e of before) {
      e.skipped = "resync";
      delete e.coalesced_into;
    }
    this.coalesced = this.coalesced.filter((e) => !before.has(e));
  }

  /** W11c (W11t, render-stream-11.md "Transport"): a based message whose base is missing or that
   * does not decode: ask for a resync (`reason: coding`); the decoder skips based transactions
   * until the full one, which a fresh applier applies (the applier is delta-driven). */
  private codingResync(seq: number, err: string): void {
    this.codingResyncs++;
    this.heapAtResync ??= this.mem?.buffer.byteLength ?? null;
    this.rebuildDue = true;
    // GTS: the skipped transactions leave a seq gap the next full must be allowed to jump.
    (this.g as GswRs).transport_skip();
    this.send({
      type: "resync",
      stream_id: this.streamId,
      seq,
      reason: "coding",
    });
    log(`coding: seq ${seq} did not decode (${err}); resync asked`);
  }

  /** RS_RECEIVER_RESYNC (receiver.gd `_refuse_for_resync`). */
  private refuseForResync(entry: LiveEntry): boolean {
    const step = this.L.resync;
    if (step === null) return false;
    if (this.awaitingFull) {
      if (entry.encoding === "full") {
        this.awaitingFull = false;
        this.rebuildDue = true;
        log(`resync: full transaction seq ${entry.seq} arrived`);
        return false;
      }
    } else if (!this.resyncDone) {
      const w = this.L.windows.find((x) => x.step === step);
      if (!w || w.shot || entry.frame < w.from || entry.frame > w.to)
        return false;
      this.resyncDone = true;
      this.awaitingFull = true;
      this.liveBlock.resync = {
        step,
        seq: entry.seq,
        frame: entry.frame,
        reason: "injected",
      };
    } else return false;
    entry.skipped = "resync";
    this.send({
      type: "resync",
      stream_id: this.streamId,
      seq: entry.seq,
      reason: "injected",
    });
    log(
      `resync: refused seq ${entry.seq} (frame ${entry.frame}) unapplied; ignoring patches until a full transaction`,
    );
    return true;
  }

  // ------------------------------------------------------------------------- context loss

  private onContextLost(): void {
    if (this.finished) return;
    const t = us();
    this.ctxState = "lost";
    if (this.ctxLoss !== null && this.ctxLoss.redraw_us === null) {
      // Lost again before the restore redraw: the same loss.
      this.ctxLoss.losses++;
      log(`webgl context lost again at ${t} us, before the restore redraw`);
      return;
    }
    const losses = (this.ctxLoss?.losses ?? 0) + 1;
    this.ctxLoss = {
      lost_us: t,
      restored_us: null,
      resident: null,
      uploads_after_restore: null,
      refetched: [],
      redraw_us: null,
      first_tx_after_restore: null,
      losses,
      last_applied_before_loss:
        this.lastAppliedSeq > 0
          ? {
              stream: this.connIndex,
              seq: this.lastAppliedSeq,
              frame: this.lastAppliedFrame,
            }
          : null,
      received_during_loss: 0,
      redraw_duration_us: null,
      redraw: null,
      redraw_skipped: null,
      restore_shot: null,
      mechanism:
        "in place: hold (nothing applied, drawn or credited), then one redraw with no transaction re-uploading every resident texture and the mesh-carrying vertex/index buffers",
    };
    this.liveBlock.context_loss = this.ctxLoss;
    this.restoreFetcher?.cancel();
    this.restoreFetcher = null;
    this.restoreWant = null;
    this.restoreBodies.clear();
    log(
      `webgl context lost at ${t} us after seq ${this.lastAppliedSeq}: holding credit, applying nothing`,
    );
  }

  private onContextRestored(): void {
    if (this.finished || this.ctxLoss === null) return;
    const t = us();
    this.ctxLoss.restored_us = t;
    this.ctxState = "restoring";
    log(`webgl context restored at ${t} us: redrawing in place`);
  }

  /** One held callback: nothing while lost; once restored, refetch any evicted resident payload
   * (polled), then the redraw with no transaction, read back once. */
  private stepContext(): void {
    if (this.ctxState !== "restoring") return;
    const loss = this.ctxLoss as ContextLoss;
    const g = this.g as GswRs;
    const mem = this.mem as WebAssembly.Memory;
    if (this.connApplied === 0) {
      // Nothing applied on this connection (none yet, or a reconnect's fresh session): there is
      // no state to redraw, and the first transaction draws everything on the new objects.
      this.ctxState = "ok";
      loss.redraw_us = us();
      loss.redraw_skipped = "nothing applied on this connection";
      log(`context restore: ${loss.redraw_skipped}; no redraw`);
      return;
    }
    if (this.restoreWant === null) {
      const missing = g.restore_missing();
      this.restoreWant = missing === "" ? [] : missing.split(",");
      if (this.restoreWant.length > 0) {
        if (this.makeFetcher === null)
          throw new ReplayFailure(
            this.lastAppliedSeq,
            "resource-unavailable",
            `context restore: payload ${this.restoreWant[0]} left the store, and the session has no HTTP fetch`,
          );
        log(
          `context restore: refetching ${this.restoreWant.length} resident payload(s) the store no longer holds`,
        );
        this.restoreFetcher = this.makeFetcher((r) => this.stageFetched(r));
        this.restoreFetcher.start(this.restoreWant);
      }
    }
    if (this.restoreFetcher !== null) {
      const { results } = this.restoreFetcher.poll();
      for (const r of results) {
        const logged: Record<string, unknown> = {
          stream: this.connIndex,
          seq: null,
          hash: r.hash,
          source: "http",
          status: r.status,
          bytes: r.bytes,
          start_us: r.start_us,
          end_us: r.end_us,
          verified: false,
          delay_us: r.delay_us,
          headers: r.headers,
          kind: "texture",
          context_restore: true,
        };
        if (this.keepLog) this.fetchLog.push(logged);
        if (r.error !== "") throw failWith(this.lastAppliedSeq, r.error);
        if (r.stage_error)
          throw new ReplayFailure(
            this.lastAppliedSeq,
            r.stage_error.startsWith("resource-hash")
              ? "resource-hash-mismatch"
              : "resource-invalid",
            r.stage_error,
          );
        logged.verified = true;
        this.restoreBodies.set(r.hash, r);
        this.fetchedHashes.add(r.hash);
      }
      if (this.restoreWant.some((h) => !this.restoreBodies.has(h))) return;
      for (const h of this.restoreWant)
        if (g.restore_take(h) < 0)
          throw new ReplayFailure(
            this.lastAppliedSeq,
            "resource-invalid",
            g.error(),
          );
      loss.refetched = [...this.restoreWant];
      this.restoreFetcher = null;
    }
    // The redraw: the last applied list, no transaction (lib.rs `draw` sees the restored context).
    const d0 = performance.now();
    if (g.draw() < 0) {
      const err = g.error();
      if (/lost/i.test(err)) {
        // Lost again between the restore event and this callback: keep holding.
        this.ctxState = "lost";
        loss.losses++;
        loss.restored_us = null;
        this.restoreWant = null;
        log(`context restore: ${err}; holding again`);
        return;
      }
      throw failWith(this.lastAppliedSeq, err);
    }
    const d1 = performance.now();
    const facts = JSON.parse(g.restore_json()) as {
      restore_draw: boolean;
      resident_textures: number;
      resident_meshes: number;
      texture_uploads: number;
      vertex_bytes: number;
      index_bytes: number;
    };
    loss.redraw_us = us();
    loss.redraw_duration_us = Math.round((d1 - d0) * 1000);
    loss.redraw = facts;
    loss.resident = {
      textures: facts.resident_textures,
      meshes: facts.resident_meshes,
    };
    // Meshes are lowered into the list's shared vertex/index buffers: the redraw re-sent every
    // resident mesh's geometry when it re-sent both buffers whole on the restored context.
    const buffersResent =
      facts.restore_draw && facts.vertex_bytes > 0 && facts.index_bytes > 0;
    loss.uploads_after_restore = {
      textures: facts.restore_draw ? facts.texture_uploads : 0,
      meshes: buffersResent ? facts.resident_meshes : 0,
    };
    // The restored target, read back once (the checker compares it with the reference at
    // `last_applied_before_loss.frame`).
    const sp = g.shot();
    if (sp !== 0) {
      const w = g.target_width();
      const h = g.target_height();
      const rgba = new Uint8Array(mem.buffer, sp, w * h * 4).slice();
      const rel = "context-loss/restored.png";
      this.puts.push(
        encodePng(rgba, w, h).then((png) => put(this.cfg, rel, png)),
      );
      loss.restore_shot = underOut(this.cfg, rel);
    } else log(`context restore: readback failed: ${g.error()}`);
    this.ctxState = "ok";
    log(
      `context restore: redrew seq ${this.lastAppliedSeq} with no transaction (${loss.uploads_after_restore.textures}/${loss.resident.textures} textures, ${loss.uploads_after_restore.meshes}/${loss.resident.meshes} meshes re-uploaded, ${loss.refetched.length} refetched); credit resumes`,
    );
  }

  /** RS_RECEIVER_SHOT_FINAL: the last applied state once more, after the end record. */
  private finalShot(): void {
    const g = this.g as GswRs;
    const sp = g.shot();
    if (sp === 0)
      throw new ReplayFailure(this.lastSeqOrNull(), "shot-failed", g.error());
    const w = g.target_width();
    const h = g.target_height();
    const mem = this.mem as WebAssembly.Memory;
    const rgba = new Uint8Array(mem.buffer, sp, w * h * 4).slice();
    this.puts.push(
      encodePng(rgba, w, h).then((png) =>
        put(this.cfg, "shots/final.png", png),
      ),
    );
    this.report.shots.push({
      stream: this.connIndex,
      seq: this.lastAppliedSeq,
      step: null,
      final: true,
      frame: this.lastAppliedFrame,
      path: underOut(this.cfg, "shots/final.png"),
      state_path: null,
      process_frame: this.processFrames,
      applied_through: this.lastAppliedSeq,
    });
    log(
      `final shot seq ${this.lastAppliedSeq} frame ${this.lastAppliedFrame} -> ${underOut(this.cfg, "shots/final.png")}`,
    );
  }

  // ------------------------------------------------------------------------- reconnect

  private beginReconnect(): void {
    this.reconnectDue = false;
    this.phase = "reconnect-closing";
    this.streamReport.closed_by = "receiver";
    this.streamReport.close_code = 1000;
    this.ws?.close(1000, "reconnect");
    this.deadline = performance.now() + CLOSE_WAIT_MS;
    log(
      `reconnect: closing connection ${this.connIndex} after seq ${this.lastAppliedSeq}`,
    );
  }

  /**
   * RS_RECEIVER_RECONNECT_ON_LOSS (G7u, gate7-design.md D14 as amended): the connection closed
   * without an end record and not by a host error (a frozen page's socket, 1006 on resume). The
   * recovery is gate 1d's reconnect, unscheduled: the closed connection's state is disposed, and
   * the next connection starts a fresh session whose first transaction is the host's newest
   * state. The host treats the lost connection as gate 1d's killed receiver.
   */
  private beginLossReconnect(code: number, reason: string): void {
    const r: Record<string, unknown> = {
      connection: this.connIndex,
      code,
      reason,
      after_seq: this.lastAppliedSeq,
      after_frame: this.lastAppliedFrame,
      lost_us: us(),
      visibility: document.visibilityState,
      connect_attempts: 1,
      created_rids: null,
      freed_by_apply: null,
      owned_before_dispose: null,
      freed_rids: null,
      leftover_rids: null,
      closed_us: null,
      opened_us: null,
    };
    this.lossReconnects.push(r);
    this.reconnectRecord = r;
    log(
      `reconnect-on-loss: connection ${this.connIndex} lost (code ${code} ${JSON.stringify(reason)}) after seq ${this.lastAppliedSeq}; reconnecting`,
    );
    this.startNextConnection();
  }

  /** Connection 1's tap is finished; the applier is disposed (its retained objects are the
   * RIDs), and connection 2 opens with a fresh session and a new tap. */
  private startNextConnection(): void {
    const g = this.g as GswRs;
    const d = JSON.parse(g.dispose_json()) as {
      created: number;
      freed_by_apply: number;
      owned: number;
    };
    const r = this.reconnectRecord as Record<string, unknown>;
    r.created_rids = d.created;
    r.freed_by_apply = d.freed_by_apply;
    r.owned_before_dispose = d.owned;
    r.memory = this.L.reconnectMemory;
    r.memory_hashes = g.memory_hashes().split(",").filter(Boolean);
    // No cache directory: the browser's HTTP cache stands in for it (Q4), unseen by the page.
    r.cache_hashes = [];
    g.live_reset(this.L.reconnectMemory === "keep");
    this.connApplied = 0;
    r.freed_rids = d.owned;
    r.leftover_rids = 0;
    r.closed_us = us();
    log(
      `reconnect: disposed ${d.owned} RIDs (created ${d.created}, freed while applying ${d.freed_by_apply}, left 0)`,
    );
    this.connIndex++;
    const base = this.L.receivedOut;
    const dot = base.lastIndexOf(".");
    const path =
      dot > base.lastIndexOf("/")
        ? `${base.slice(0, dot)}-${this.connIndex}${base.slice(dot)}`
        : `${base}-${this.connIndex}`;
    this.taps.push({ path, chunks: [], bytes: 0, stored: 0 });
    this.fetcher?.cancel();
    this.pending = null;
    this.queue = [];
    this.coalesced = [];
    this.sessionSeen = false;
    this.streamId = "";
    this.lastAcceptedSeq = 0;
    this.inlineSinceApplied = 0;
    this.streamReport = this.newStreamReport(path);
    this.report.streams.push(this.streamReport);
    this.reconnecting = true;
    this.open();
    this.phase = "connecting";
    this.deadline = performance.now() + this.L.connectTimeoutMs;
  }

  // ------------------------------------------------------------------------- exit paths

  private async finishLive(): Promise<void> {
    this.report.shotsMissed = this.L.windows
      .filter((w) => !w.shot)
      .map((w) => w.step);
    // G7o2 payload-verified-before-use: every payload a transaction used was verified in its
    // fetch completion (staged), none inside the frame and none unverified.
    if (this.g) {
      const pv = JSON.parse(this.g.payload_verify_json()) as PayloadVerify;
      log(`payload-verify: ${JSON.stringify(pv)}`);
      this.perf.payloadVerify = pv;
      if (pv.unverified_used > 0 || pv.provided_in_frame > 0) {
        await this.fail(
          new ReplayFailure(
            null,
            "payload-unverified",
            `payload-verified-before-use: ${pv.unverified_used} used unverified, ${pv.provided_in_frame} verified inside the frame`,
          ),
        );
        return;
      }
    }
    this.report.status = "ok";
    const code = await this.writeReport(0);
    log(
      `ok: ${this.entries.length} transactions received, ${this.foldedCount} folded, ${this.report.shots.length} shots, ${this.report.shotsMissed.length} missed windows, acks ${JSON.stringify(this.acks)}, closed by ${this.streamReport.closed_by} (${this.streamReport.close_code})`,
    );
    this.exit(code);
  }

  private async fail(f: ReplayFailure): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.report.status = "replay-failure";
    this.report.failure = { seq: f.seq, reason: f.reason, detail: f.message };
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "replay-failure");
      this.streamReport.closed_by = "receiver";
      this.streamReport.close_code = 1000;
    }
    this.report.shotsMissed = this.L.windows
      .filter((w) => !w.shot)
      .map((w) => w.step);
    log(`replay-failure: seq ${f.seq ?? "<null>"} ${f.reason}: ${f.message}`);
    const code = await this.writeReport(3);
    this.exit(code);
  }

  private exit(code: number): void {
    this.finished = true;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN)
      this.ws.close(1000, "receiver exit");
    finish(code);
    this.resolveDone();
  }

  /** Every evidence file (taps, perf, params), applied.json last. Returns the exit code. */
  private async writeReport(code: number): Promise<number> {
    this.finished = true;
    const g = this.g;
    try {
      await Promise.all(this.puts);
      for (let i = 0; i < this.taps.length; i++) {
        const tap = this.taps[i];
        const blob = new Blob(tap.chunks);
        const sha = hex(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          ),
        );
        await put(this.cfg, relativeToOut(this.cfg, tap.path), blob);
        const sr = this.report.streams[i];
        if (sr) {
          sr.received_sha256 = sha;
          sr.received_bytes = tap.bytes;
        }
        if (i === this.taps.length - 1)
          this.report.recording = {
            path: tap.path,
            sha256: sha,
            bytes: tap.stored,
          };
      }
      if (g) {
        try {
          this.report.rust = JSON.parse(g.applied_json_parts()) as RustParts;
          this.report.particles = this.particles.evidence;
        } catch {
          this.report.rust = null;
        }
      }
      this.report.distinctFetched = this.fetchedHashes.size;
      // G7k (Q10 soak): the PayloadStore's own cumulative eviction count (0 when a budget was
      // set and never exceeded; still null when no residency sample was ever taken, e.g. a leg
      // with no applied transaction).
      this.report.residencyEvictions = this.perf.residencyEvictions;
      const gsw = this.liveBlock.gsw as Record<string, unknown>;
      gsw.raf_callbacks = this.rafIndex;
      gsw.first_apply = this.firstApply;
      // W11c: W11t's coding, per connection (the live block's own key, /11 only).
      if (this.coding !== null || this.codingReports.length > 0) {
        const all = [...this.codingReports];
        if (this.coding !== null)
          all.push(JSON.parse(this.coding.stats_json()) as Record<string, unknown>);
        this.liveBlock.coding = {
          offer: this.L.liveCoding,
          resyncs: this.codingResyncs,
          heap_at_resync: this.heapAtResync,
          heap_end: this.mem?.buffer.byteLength ?? null,
          rebuild_applies: this.rebuildApplies,
          connections: all,
        };
      }
      gsw.raf_skipped = this.rafSkipped;
      gsw.drawn_rafs = this.drawnRafs;
      gsw.acks_while_hidden = this.acksWhileHidden;
      if (this.cfg.perfOut) {
        const perfRel = relativeToOut(this.cfg, this.cfg.perfOut);
        await put(
          this.cfg,
          perfRel,
          `${JSON.stringify(
            this.perf.report({
              wasm_heap_bytes: this.mem?.buffer.byteLength ?? null,
              gsw: g ? JSON.parse(g.evidence_json()) : null,
              acks: this.acks,
            }),
            null,
            2,
          )}\n`,
        );
        await put(
          this.cfg,
          perfRel.replace(/[^/]*$/, "perf-timeline.jsonl"),
          this.perf.timeline(),
        );
      }
      if (g) {
        const params = g.shader_params_jsonl();
        if (params !== "")
          await put(this.cfg, "gsw/shader-params.jsonl", params);
      }
      await put(this.cfg, relativeToOut(this.cfg, this.cfg.out), [
        ...prettyJsonParts(appliedJson(this.report)),
        "\n",
      ]);
      for (const u of this.report.rust?.unsupported ?? [])
        log(`seq ${u.seq}: unsupported ${u.name} item ${u.item} (${u.reason})`);
      return code;
    } catch (e) {
      shell.error = `evidence: ${e instanceof Error ? e.message : String(e)}`;
      log(`error: ${shell.error}`);
      return 3;
    }
  }
}

/** A failing record's seq (receiver.gd `_receive_binary`): its meta's integer `seq` for a
 * transaction (or a record that did not decode), else the next expected seq; null for a resource
 * or end record. Read from the message's own meta JSON, off the frame path. */
function failureSeq(buf: ArrayBuffer, expected: number): number | null {
  try {
    const v = new DataView(buf);
    const metaLen = v.getUint32(4, true);
    const meta = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 8, metaLen)),
    ) as { type?: string; seq?: unknown };
    if (meta.type === "resource" || meta.type === "end") return null;
    return Number.isInteger(meta.seq) ? (meta.seq as number) : expected;
  } catch {
    return expected;
  }
}
