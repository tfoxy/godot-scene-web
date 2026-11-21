// The client's protocol loop: the harness receiver's live
// order (web/gsw-receiver/live.ts `LiveReceiver`) minus everything evidence-only.
//
// 1. A message decodes and validates in its own event (one copy into wasm, W11t live coding
//    first), is acked `received`, and queues.
// 2. With `applyOn: "message"` (the default): while frame callbacks run, nothing waits ahead of
//    it and fewer than MESSAGE_APPLY_MAX_UNDRAWN applied transactions wait for a draw, the same
//    event applies it (ack `applied`) when it needs no payload, or starts its fetches.
// 3. Otherwise one frame callback (rAF) runs the connection phases, then the pending
//    transaction's fetches (each payload verified by wasm on arrival), then apply, ack
//    `applied`. Every frame callback with an apply since its last draw draws the newest applied
//    state once and acks `submitted` for each of them.
// Applied, for a transaction that needs no payload, means accepted into the applier's prepared
// state (the core merges every transaction accepted since its last run): the applier itself
// (lowering, the cover walk, the draw list) and the per-apply glue (programs, particles) run once,
// in the frame callback that draws, for every transaction applied since the last one. A host
// frame rate above the draw rate costs one accept per transaction, not one apply. A transaction
// that needs payloads runs the applier when its payloads are in (the earlier ones with it), so
// its payloads go in right before the run that takes them; until then the transactions applied
// before it wait with it and are not drawn (at most `resourceHoldMs`).
// Credit (`applied` by default, or `submitted`) never comes on receipt alone: a hidden
// page runs no frame callback, so after MESSAGE_APPLY_MAX_FRAME_GAP_MS arrivals wait for one, no
// credit returns and the hub stops publishing to this connection.
//
// Credit window 2: a transaction that arrives while another waits for its payloads folds
// into it in place, and several queued transactions apply in one callback, drawing the newest;
// each folded one is acked with it. Window 1 (the host's grant may be 1) keeps the superseded path:
// the newest is applied by a fresh applier.
//
// Bounded hold: a transaction waits for its payloads at most `resourceHoldMs` (from the first
// callback that found one missing). Then it applies without the texture and mesh payloads still in
// flight ("deferred"): what draws them is not drawn (never an older payload in its place), the rest
// is, and acks flow, so the host keeps publishing. A later transaction needing a deferred payload
// does not wait for it again. The fetches go on; each deferred payload that arrives goes into the
// store, and the next apply, or with none waiting a revisit (an apply over the same state, no ack),
// draws what needs it. Shader code defers too: a material whose code is not in has no program,
// and what it draws (and whatever inherits it) is omitted, never drawn shaderless, until the code
// arrives and compiles before the revisit or apply that draws it.
//
// Unavailable payloads: a GET settles on its own (`missing`: 404, 410; `temporary`: 408, 429,
// 5xx, a rejected request, a stall), the other GETs and the queue go on, and the payload is
// retried up to three times on temporary failure while still needed (250/500/1000 ms backoff).
// Missing payloads and exhausted retries settle unavailable: deferred as above (never an older
// payload in its place), never fetched again while the accepted state keeps naming it. Once a
// transaction names it again after one that did not, or on a reconnect, it is fetched afresh.
// After each accepted transaction the loop asks the core which tracked payloads (queued, waiting
// to retry, in flight, deferred, unavailable) the state still names (one batched call, none while
// it tracks nothing): a queued GET or retry of one no longer
// named is dropped, one in flight goes on (its body is verified and kept if it is named again,
// dropped if not; its failure is that older naming's and says nothing about a newer one), and a
// deferred or unavailable one stops being tracked. A `fatal` GET (401, 403, another status, a
// request that cannot be made), a body that fails verification or decoding, and a protocol error
// still fail the stream. `stats().resources` reports the unavailable payloads (counts and the last
// RESOURCE_LOG_MAX, deduplicated by hash); none is ever a failed status.
//
// Loss: a close without an end record, other than 1002/1008/1009, reconnects as a fresh session
// (the applier is reset, the payload store, the compiled module and the browser's
// HTTP cache are kept), after 1, 2, 4, 8 s and then every 10 s; the count resets once a connection
// draws. A coding failure asks a `coding` resync in place (W11t, GTS `transport_skip`), and the
// full it forces is applied by a rebuilt applier that inherits the GPU residency (GRH). A WebGL
// context loss holds the loop; after the restore, one callback redraws the last applied state
// in place, refetching any resident payload the store no longer holds. One that cannot be fetched
// is unavailable: what drew it leaves residency and is re-lowered (a revisit, or the apply of the
// transaction waiting), and the rest draws.

import { type AckStage, AckWriter } from "./ack";
import { type ColdPayload, ColdTracker } from "./cold";
import type { Needed, SessionMeta, StreamCore } from "./core";
import { failWith, StreamFailure } from "./core";
import type { RenderStreamEndpoint } from "./endpoint";
import type { ExtensionHost } from "./extensions";
import { type FetchResult, LiveFetcher } from "./fetcher";
import {
  FrameCap,
  frameCapLimits,
  motionWake,
  type RenderStreamFrameCap,
  type RenderStreamFrameCapBounds,
} from "./frame-cap";
import { clientHello, clientProtocol } from "./hello";
import { type HintLead, HintTable } from "./hints";
import type { ProgramCounts } from "./programs";
import type { RenderStreamRecorder } from "./recorder";
import { FETCH_PARALLEL } from "./resource-limits";
import type { StagingStats } from "./staging";
import type {
  RenderStreamTransport,
  RenderStreamTransportFactory,
} from "./transport";

/** The failure reasons the client reports (the receiver's typed names, plus the client's own).
 * `core-load-failed`'s detail says why: `stale core: ...`, `timeout after <ms> ms in <steps>`. */
export type RenderStreamFailureReason =
  | "live-connect-failed"
  | "host-error"
  | "live-disconnected"
  | "resource-unavailable"
  | "receiver-error"
  | "core-load-failed"
  | "no-webgl2"
  | (string & {});

export type RenderStreamStatus =
  | { kind: "connecting" }
  /** The connection's session arrived (`firstFrame` false), then its first transaction drew
   * (`firstFrame` true): once each per connection. */
  | { kind: "streaming"; firstFrame: boolean }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "failed"; reason: RenderStreamFailureReason; detail: string }
  | { kind: "ended" };

export interface RenderStreamStats {
  /** Draws in the last second (up to 256), by damage mode: off, full, partial, skip. */
  damageModeCounts?: readonly [number, number, number, number];
  /** Medians over those draws, or null before one: planning microseconds, damaged target
   * permille, and redraw region count. Sampling uses preallocated rings. */
  damageUsP50?: number | null;
  damagePermilleP50?: number | null;
  damageRegionsP50?: number | null;
  /** Main-thread payload staging totals and per-payload maxima, by decoded kind. */
  staging?: StagingStats;
  /** Transactions applied (folded ones included) by this client, over all its connections. */
  applied: number;
  /** Applies (drawn frames) over the last second. */
  appliesPerSec: number;
  /** Median ms from a credit-stage ack (`applied` by default) to the next transaction's
   * arrival (the last 64), or null. */
  creditRttMsP50: number | null;
  /** The wasm instance's memory (0 after dispose). */
  heapBytes: number;
  /** Custom shader counters for the current wasm instance (kept across reconnects). Defined
   * includes links still pending; refused includes transpile and compile failures. */
  programs?: Readonly<ProgramCounts>;
  /** The open connection's carrier, or null while not connected (or on a custom transport
   * that does not name one). `stats()` always sets it; it is optional so that code building a
   * `RenderStreamStats` of its own (a consumer's test double) need not. */
  carrier?: "websocket" | "webtransport" | null;
  /** Payloads the drawn state went without (the resource hold ran out) and still being fetched:
   * what draws them is not on screen yet. `stats()` always sets it (optional as `carrier`). */
  deferredPayloads?: number;
  /** Applies that walked the item tree and re-assembled the draw list (the core's slow path),
   * over all connections: compare with `applied`. `stats()` always sets it (optional as
   * `carrier`). */
  structuralApplies?: number;
  /** Why the last apply walked or re-assembled, as the core's bits: 1 first, 2 defaults,
   * 4 material, 8 texture-size, 16 item-removed, 32 item-added, 64 content-shape, 128 order-key,
   * 256 dependency, 512 canvas, 1024 compact, 2048 move-fallback, 4096 move-attach,
   * 8192 override, 16384 back-buffer (a move or content change reached a canvas group). 0 when
   * it did neither. `stats()` always sets it (optional as `carrier`). */
  lastApplyWhy?: number;
  /** Items in the last applied state holding a canvas group or a back-buffer copy. `stats()`
   * always sets it (optional as `carrier`). */
  backBufferItems?: number;
  /** render-stream/16 viewport surfaces, as of the last apply (`stats()` always sets them;
   * optional as `carrier`): surface passes the frame draws (`surfacesRendered`), surfaces the
   * frame reaches that the client did not build because the client was created with
   * `viewports: false` (`surfacesSkipped`; their viewport textures draw transparent), due surfaces
   * kept because nothing they draw changed (`surfacesUnchanged`), render targets held
   * (`surfacesAllocated`) and their pixels (`surfacePixels`, saturating). All 0 on a stream with
   * no viewport surface (every protocol below /16, or a host with `GRC_VIEWPORTS=off`). */
  surfacesRendered?: number;
  surfacesSkipped?: number;
  surfacesUnchanged?: number;
  surfacesAllocated?: number;
  surfacePixels?: number;
  /** Payloads a transaction needed that the store did not hold, drawn since the client started.
   * The cold-payload fields below are always set by `stats()` (optional as `carrier`). */
  missedPayloads?: number;
  /** Missed payloads that went at least one frame unshown: frame callbacks ran between the first
   * transaction naming one and the draw that first drew it (staged and uploaded). */
  coldPayloads?: number;
  /** Those frames, summed over every missed payload, and the most for one. */
  coldFramesSum?: number;
  coldFramesMax?: number;
  /** The longest first reference to first draw, in ms. */
  coldMsMax?: number;
  /** The last `COLD_LOG_MAX` missed payloads (newest last), one record each: a frozen array,
   * the same one until a draw adds a record. */
  coldPayloadLog?: readonly ColdPayload[];
  /** Payloads the host could not serve (`ResourceDiagnostics`): a frozen object, the same one
   * until one more is found or one stops being tracked. `stats()` always sets it (optional as
   * `carrier`). */
  resources?: ResourceDiagnostics;
  /** /15 resource hints (`resourceHints`). The hint fields are set by `stats()` only on a
   * `resourceHints` client. `resource_hint` records received, over every connection. */
  hintsReceived?: number;
  /** Hint GETs verified and staged successfully (over every connection). */
  hintsPrefetched?: number;
  /** Payload bytes successfully prefetched, in bytes. */
  hintPrefetchBytes?: number;
  /** Hint payloads whose fetching (after retries) or verification failed. */
  hintPrefetchFailed?: number;
  /** Additional GET attempts after temporary failures (demand and hints, over every connection). */
  getRetries?: number;
  /** `resource_unhint` records received. */
  unhintsReceived?: number;
  /** Hints in effect whose payload the client neither holds nor has seen a transaction name. */
  hintsPending?: number;
  /** Hints a transaction first drew after they arrived (each counted once). */
  hintsReferenced?: number;
  /** Hints that arrived for a hash the accepted state already drew. */
  hintsLate?: number;
  /** Hints the table's bound (`HINT_TABLE_MAX`) dropped. */
  hintsDropped?: number;
  /** The shortest and longest hint-to-first-reference lead in ms, or null before one. */
  hintLeadMsMin?: number | null;
  hintLeadMsMax?: number | null;
  /** The last `HINT_LEAD_LOG_MAX` referenced hints (newest last): a frozen array, the same one
   * until a reference adds a record. */
  hintLeadLog?: readonly HintLead[];
  /** The frame cap in effect (`frameCap`). The frame-cap fields are always set by `stats()`
   * (optional as `carrier`). */
  frameCap?: RenderStreamFrameCap;
  /** The cap is engaged now: idle under `automatic`, presenting every other frame callback. */
  frameCapEngaged?: boolean;
  /** Frame callbacks run while the cap was engaged, over every connection. */
  cappedFrames?: number;
  /** Of those, the ones that presented nothing because of the cap (about half). */
  skippedFrames?: number;
  /** What last woke the cap or kept it awake, for diagnosis: `mode` (a switch), `input`, `session`,
   * `restore` (a context restore), `rebuild`, `payload` (a late payload drawn in), `end` (the
   * stream's end, drawn before draining), `extension` (an extension animating), `unmeasured` (no
   * motion facts), a transaction's change (`full`, `structure`, `visibility`, `content`,
   * `appearance`, `resource`, `reshape`, `viewport`), or `motion` / `colour` past the ambient
   * bounds. */
  frameCapWake?: string;
}

/** Why a payload was unavailable: `missing` (404, 410) or `temporary` (408, 429, 5xx, a rejected
 * request, a stall: it could not be had now). */
export type ResourceUnavailableReason = "missing" | "temporary";

/** One payload found unavailable (deduplicated by hash). */
export interface ResourceDiagnostic {
  hash: string;
  /** wasm's payload kind: 0 texture, 1 mesh, 2 shader, 3 KTX2; -1 unknown. */
  kind: number;
  /** The transaction that first needed it, at the first finding (0: none applied yet). */
  seq: number;
  reason: ResourceUnavailableReason;
  /** The GET's HTTP status, or null (no response). */
  status: number | null;
  detail: string;
  /** Found by a context restore's refetch. */
  restore: boolean;
  /** How many times it was found unavailable (once per naming: a payload stays unavailable
   * while the accepted state keeps naming it). */
  count: number;
  /** When it was last found (ms, the loop clock). */
  at: number;
}

export interface ResourceDiagnostics {
  /** Payloads unavailable now: named by the accepted state and not fetched again. */
  unavailable: number;
  /** Findings since the client started, over all its connections, and by reason. */
  found: number;
  missing: number;
  temporary: number;
  /** The last RESOURCE_LOG_MAX payloads found (newest last), one record per hash. */
  recent: readonly ResourceDiagnostic[];
}

/** Records kept in `ResourceDiagnostics.recent`. */
export const RESOURCE_LOG_MAX = 32;

/** The frame and timer functions the loop runs on (the page's, or a test's). */
export interface LoopClock {
  now(): number;
  requestFrame(cb: (ts: number) => void): number;
  cancelFrame(id: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** What the hello states about the canvas, read when the socket opens. */
export interface HelloCanvas {
  backing: [number, number];
  css: [number, number];
  dprMilli: number;
  gpuFormats: string;
}

export interface LoopOptions {
  core: StreamCore;
  transport: RenderStreamTransportFactory;
  endpoint: RenderStreamEndpoint;
  creditWindow: 1 | 2;
  /** The hello's credit stage: the ack the host waits on. Default `applied`. */
  creditStage?: CreditStage;
  /** Where a transaction with every payload in is applied (acked `applied`): `frame` (the next
   * frame callback) or `message` (its own `onmessage`, while frames run). Either way the applier
   * runs once per drawn frame, in the frame callback, before the draw. Default `message`. */
  applyOn?: ApplyOn;
  onStatus: (s: RenderStreamStatus) => void;
  canvas: () => HelloCanvas;
  clock: LoopClock;
  connectTimeoutMs?: number;
  /** A resource GET with no progress (no response, no body bytes) for this long fails
   * `resource-unavailable`; default 10000. */
  fetchTimeoutMs?: number;
  /** The longest a transaction waits for its payloads before it applies without the texture and
   * mesh payloads still in flight (their items drawn once they arrive); default
   * `DEFAULT_RESOURCE_HOLD_MS`. 0 never waits; `Infinity` always waits for every payload. */
  resourceHoldMs?: number;
  /** The extension list's runtime; null (the pure client) costs one branch per frame. */
  ext?: ExtensionHost | null;
  /** The session record, once per session (the client keeps its presentation size). */
  onSession?: (session: SessionMeta) => void;
  /** The recorder (null: the pure client copies nothing). */
  recorder?: RenderStreamRecorder | null;
  /** Keep resource hints in a table (`hints`) and prefetch while idle. Default false. */
  resourceHints?: boolean;
  /** Hint GETs at once, default 2; clamped below the fetch cap to reserve a demand slot. */
  prefetchMaxInFlight?: number;
  /** Completed plus in-flight hint payload bytes per connection, default 64 MiB. */
  prefetchBudgetBytes?: number;
  /** The idle frame cap (frame-cap.ts); default `off`. */
  frameCap?: RenderStreamFrameCap;
  /** What still counts as ambient under the cap (frame-cap.ts defaults). */
  frameCapBounds?: RenderStreamFrameCapBounds;
}

/** The ack the host's credit waits on (render-stream-1.md hello `credit_stage`). */
export type CreditStage = "submitted" | "applied";
/** Where a ready transaction is applied. */
export type ApplyOn = "frame" | "message";
/** The defaults: crediting at `applied` and applying in `onmessage` take
 * the wait for the next vsync out of the credit round trip. */
export const DEFAULT_CREDIT_STAGE: CreditStage = "applied";
export const DEFAULT_APPLY_ON: ApplyOn = "message";

/** `applyOn: "message"` applies in `onmessage` only while the frame callbacks run: no frame
 * callback for this long (a hidden page) and arrivals queue for the next one, so no credit
 * returns from a page that draws nothing. */
export const MESSAGE_APPLY_MAX_FRAME_GAP_MS = 100;
/** `applyOn: "message"` applies in `onmessage` while fewer than this many applied transactions
 * wait for a draw; past it, arrivals wait for the frame callback, so a client whose draws fall behind (a slow
 * GPU, a busy thread) is paced by its draws again and never applies far more than it shows. Two
 * absorbs a host frame rate a little above the panel's (60 Hz against a panel just under it). */
export const MESSAGE_APPLY_MAX_UNDRAWN = 2;

/** The default `resourceHoldMs`: never wait. Like images on a web page, a texture or mesh still
 * loading is not drawn and everything else is; it pops in once it arrives. */
export const DEFAULT_RESOURCE_HOLD_MS = 0;

/** Backoff before reconnect attempt n (1-based): 1, 2, 4, 8 s, then 10 s. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 10000] as const;
const CLOSE_WAIT_MS = 2000;
const RTT_SAMPLES = 64;
const APPLY_RING = 256;

/** A payload the loop tracks: the seq that first needed it (a failure's seq) and its kind. */
interface Tracked {
  seq: number;
  kind: number;
}

interface Queued {
  seq: number;
  frame: number;
  full: boolean;
  needed: Needed[];
}

interface Pending {
  item: Queued;
  stage: "fetch" | "ready";
  /** Fetched bodies by hash, with the refusal staging gave them (null: staged). */
  bodies: Map<string, string | null>;
  /** The seq each payload was requested for (a folded one's failure is reported at it), and its
   * kind. */
  requester: Map<string, Tracked>;
  /** When a callback first found a payload missing (the hold's start), or -1. */
  since: number;
}

type Phase =
  | "idle"
  | "connecting"
  | "streaming"
  | "backoff"
  | "draining"
  | "failed"
  | "ended"
  | "disposed";

/** One connection's identity: events of an older one are ignored. */
interface Connection {
  transport: RenderStreamTransport | null;
  opened: boolean;
  closeInfo: { code: number; reason: string } | null;
  sessionSeen: boolean;
  streamId: string;
}

export class StreamLoop {
  private endpoint: RenderStreamEndpoint;
  private phase: Phase = "idle";
  private conn: Connection | null = null;
  private frameId: number | null = null;
  private timerId: number | null = null;
  private deadline = 0;
  /** Reconnect attempts since the last connection that drew (0: this is not a reconnect). */
  private attempt = 0;
  private grantedWindow = 1;
  private queue: Queued[] = [];
  private coalesced: Queued[] = [];
  private pending: Pending | null = null;
  private fetcher: LiveFetcher | null = null;
  private makeFetcher: ((restore?: boolean) => LiveFetcher) | null = null;
  private endSeen = false;
  private rebuildDue = false;
  private connApplied = 0;
  private firstFrameSent = false;
  private ctx: "ok" | "lost" | "restoring" = "ok";
  private restoreFetcher: LiveFetcher | null = null;
  private restoreWant: string[] | null = null;
  private readonly restoreBodies = new Map<string, string | null>();
  /** The restore refetches that settled unavailable. */
  private readonly restoreFailed = new Map<string, FetchResult>();
  private lastAppliedSeq = 0;
  /** IN12: the transaction on screen (the last draw's), null before one in this session; a
   * pointer target's `frame`. */
  drawnSeq: number | null = null;
  /** Seqs applied (folded ones included) and not drawn yet; their `submitted` acks wait for
   * the draw. */
  private undrawn: number[] = [];
  /** The newest seq applied since the applier last ran (null: none). Its run (`flushApply`)
   * comes before the next draw, revisit or context-restore redraw. */
  private applyDue: number | null = null;
  /** Ack text from a prefix cached per stream id (the acks are the steady-state sends). */
  private readonly acks = new AckWriter();
  /** The start of the last frame callback (null: none on this loop yet). */
  private lastFrameAt: number | null = null;
  // Stats: counters and two fixed rings, no per-frame allocation.
  private applied = 0;
  private structuralApplies = 0;
  private lastApplyWhy = 0;
  private backBufferItems = 0;
  private surfaces = {
    rendered: 0,
    skipped: 0,
    unchanged: 0,
    allocated: 0,
    pixels: 0,
  };
  private readonly damageTimes = new Float64Array(APPLY_RING);
  private readonly damageModes = new Uint32Array(APPLY_RING);
  private readonly damageUs = new Uint32Array(APPLY_RING);
  private readonly damagePermille = new Uint32Array(APPLY_RING);
  private readonly damageRegions = new Uint32Array(APPLY_RING);
  private damageCount = 0;
  private readonly applyTimes = new Float64Array(APPLY_RING);
  private applyCount = 0;
  private readonly rtts = new Float64Array(RTT_SAMPLES);
  private rttCount = 0;
  private lastCreditAt: number | null = null;
  /** Payloads an applied transaction went without (the hold ran out), still being fetched, with
   * the seq that needed each (a failure's seq). */
  private readonly deferred = new Map<string, Tracked>();
  /** Payloads whose GET settled unavailable, deferred while the accepted state keeps naming them
   * (never fetched again meanwhile). */
  private readonly unavailable = new Map<string, Tracked>();
  /** GETs (in flight, or completed and not polled) of payloads the accepted state stopped naming
   * after they were asked: an older naming's, whose failure says nothing about a newer one. */
  private readonly stale = new Set<string>();
  /** `stats().resources`. */
  private readonly diag = {
    found: 0,
    missing: 0,
    temporary: 0,
    ring: [] as ResourceDiagnostic[],
    view: null as ResourceDiagnostics | null,
  };
  /** A revisit drew deferred payloads in: the callback draws once with no transaction. */
  private revisitDraw = false;
  /** Applier runs so far (J1: a callback with none may settle particle bursts). */
  private applierRuns = 0;
  /** Missed payloads, first reference to first draw. */
  private readonly cold: ColdTracker;
  /** /15 resource hints; null unless `resourceHints` (nothing hint-related runs then). */
  readonly hints: HintTable | null;
  private readonly prefetch: {
    active: Map<string, { hint: string; reserved: number }>;
    attempted: Set<string>;
    spent: number;
    hintsPrefetched: number;
    hintPrefetchBytes: number;
    hintPrefetchFailed: number;
    getRetries: number;
  } | null;
  /** The idle frame cap; under `off` one branch per frame callback and nothing measured. */
  private readonly cap: FrameCap;

  private readonly creditStage: CreditStage;
  private readonly resourceHoldMs: number;
  private readonly ext: ExtensionHost | null;
  private readonly recorder: RenderStreamRecorder | null;

  constructor(private readonly o: LoopOptions) {
    this.endpoint = o.endpoint;
    this.creditStage = o.creditStage ?? DEFAULT_CREDIT_STAGE;
    this.ext = o.ext ?? null;
    this.recorder = o.recorder ?? null;
    this.cold = new ColdTracker(() => o.clock.now());
    const cold = this.cold;
    this.hints = o.resourceHints
      ? new HintTable(
          () => o.clock.now(),
          () => cold.frames,
        )
      : null;
    this.prefetch =
      this.hints === null
        ? null
        : {
            active: new Map(),
            attempted: new Set(),
            spent: 0,
            hintsPrefetched: 0,
            hintPrefetchBytes: 0,
            hintPrefetchFailed: 0,
            getRetries: 0,
          };
    const hold = o.resourceHoldMs ?? DEFAULT_RESOURCE_HOLD_MS;
    this.resourceHoldMs = hold >= 0 ? hold : DEFAULT_RESOURCE_HOLD_MS;
    this.cap = new FrameCap(
      o.frameCap ?? "off",
      o.clock.now(),
      frameCapLimits(o.frameCapBounds),
    );
    if (this.cap.mode === "automatic") o.core.setMotion?.(true);
  }

  // ----------------------------------------------------------------------- public

  connect(): void {
    if (
      this.phase !== "idle" &&
      this.phase !== "failed" &&
      this.phase !== "ended"
    )
      return;
    if (this.phase !== "idle") this.o.core.reset(true);
    this.applyDue = null;
    this.attempt = 0;
    this.status({ kind: "connecting" });
    this.open();
  }

  /** A changed descriptor: an active client reconnects with it at once; an idle, failed or
   * ended one keeps it for the next `connect`. */
  setEndpoint(e: RenderStreamEndpoint): void {
    this.endpoint = e;
    if (
      this.phase === "connecting" ||
      this.phase === "streaming" ||
      this.phase === "backoff" ||
      this.phase === "draining"
    ) {
      this.teardown(1000, "endpoint changed");
      this.attempt = 0;
      this.status({ kind: "connecting" });
      this.open();
    }
  }

  /** The idle frame cap from now on, and its bounds when given (over the defaults; omitted, the
   * current ones stay). Switching is itself activity: the cap engages only after a quiet period.
   * `off` stops the core's motion measure too. */
  setFrameCap(
    mode: RenderStreamFrameCap,
    bounds?: RenderStreamFrameCapBounds,
  ): void {
    if (this.phase === "disposed") return;
    const limits = bounds === undefined ? undefined : frameCapLimits(bounds);
    this.cap.setMode(mode, this.o.clock.now(), limits);
    this.o.core.setMotion?.(mode === "automatic");
  }

  /** An input: an engaged cap presents from the next frame callback, and idle starts over. */
  wake(): void {
    this.cap.activity(this.o.clock.now(), "input");
  }

  contextLost(): void {
    if (this.phase === "disposed") return;
    this.ctx = "lost";
    this.o.core.pauseParticles?.(true);
    this.restoreFetcher?.abort();
    this.restoreFetcher = null;
    this.restoreWant = null;
    this.restoreBodies.clear();
    this.restoreFailed.clear();
  }

  contextRestored(): void {
    if (this.phase === "disposed" || this.ctx === "ok") return;
    this.ctx = "restoring";
    this.o.core.pauseParticles?.(false);
    this.cap.activity(this.o.clock.now(), "restore");
  }

  stats(): RenderStreamStats {
    const now = this.o.clock.now();
    let perSec = 0;
    const n = Math.min(this.applyCount, APPLY_RING);
    for (let i = 0; i < n; i++) if (now - this.applyTimes[i] <= 1000) perSec++;
    let p50: number | null = null;
    const m = Math.min(this.rttCount, RTT_SAMPLES);
    if (m > 0) {
      const sorted = Array.from(this.rtts.subarray(0, m)).sort((a, b) => a - b);
      p50 = sorted[(m - 1) >> 1];
    }
    return {
      ...this.damageStats(now),
      applied: this.applied,
      appliesPerSec: perSec,
      creditRttMsP50: p50,
      heapBytes: this.o.core.heapBytes(),
      staging: this.o.core.stagingStats?.(),
      programs: this.o.core.programCounts?.(),
      carrier:
        this.conn?.opened && this.conn.closeInfo === null
          ? (this.conn.transport?.carrier ?? null)
          : null,
      deferredPayloads: this.deferred.size,
      resources: this.resourceDiagnostics(),
      structuralApplies: this.structuralApplies,
      lastApplyWhy: this.lastApplyWhy,
      backBufferItems: this.backBufferItems,
      surfacesRendered: this.surfaces.rendered,
      surfacesSkipped: this.surfaces.skipped,
      surfacesUnchanged: this.surfaces.unchanged,
      surfacesAllocated: this.surfaces.allocated,
      surfacePixels: this.surfaces.pixels,
      ...this.cold.totals,
      coldPayloadLog: this.cold.log(),
      ...(this.hints !== null ? this.hintStats(this.hints) : {}),
      frameCap: this.cap.mode,
      frameCapEngaged: this.cap.engaged,
      cappedFrames: this.cap.cappedFrames,
      skippedFrames: this.cap.skippedFrames,
      frameCapWake: this.cap.wake,
    };
  }

  private sampleDamage(now: number): void {
    const d = this.o.core.damageStats?.();
    if (d === undefined) return;
    const i = this.damageCount++ % APPLY_RING;
    this.damageTimes[i] = now;
    this.damageModes[i] = d.mode;
    this.damageUs[i] = d.us;
    this.damagePermille[i] = d.permille;
    this.damageRegions[i] = d.regions;
  }

  private damageStats(now: number): Partial<RenderStreamStats> {
    const counts: [number, number, number, number] = [0, 0, 0, 0];
    const us: number[] = [],
      permille: number[] = [],
      regions: number[] = [];
    for (let i = 0; i < Math.min(this.damageCount, APPLY_RING); i++) {
      if (now - this.damageTimes[i] > 1000) continue;
      const mode = this.damageModes[i];
      if (mode <= 3) counts[mode]++;
      us.push(this.damageUs[i]);
      permille.push(this.damagePermille[i]);
      regions.push(this.damageRegions[i]);
    }
    const median = (v: number[]): number | null => {
      if (v.length === 0) return null;
      v.sort((a, b) => a - b);
      return v[(v.length - 1) >> 1];
    };
    return {
      damageModeCounts: counts,
      damageUsP50: median(us),
      damagePermilleP50: median(permille),
      damageRegionsP50: median(regions),
    };
  }

  private hintStats(h: HintTable): Partial<RenderStreamStats> {
    const p = this.prefetch;
    return {
      ...h.totals,
      hintsPending: h.pending,
      hintLeadLog: h.log(),
      hintsPrefetched: p?.hintsPrefetched ?? 0,
      hintPrefetchBytes: p?.hintPrefetchBytes ?? 0,
      hintPrefetchFailed: p?.hintPrefetchFailed ?? 0,
      getRetries: p?.getRetries ?? 0,
    };
  }

  /** Stops the loop and closes the connection (1000); the caller frees the core. Idempotent. */
  dispose(): void {
    if (this.phase === "disposed") return;
    this.teardown(1000, "dispose");
    this.restoreFetcher?.abort();
    this.restoreFetcher = null;
    this.phase = "disposed";
    this.o.core.pauseParticles?.(true);
    this.stopFrames();
  }

  get state(): string {
    return this.phase;
  }

  // ----------------------------------------------------------------------- connection

  private executorPreparing = false;
  private executorNeedsBegin = false;

  private open(): void {
    const core = this.o.core;
    this.phase = "connecting";
    this.deadline = this.o.clock.now() + (this.o.connectTimeoutMs ?? 10000);
    const conn: Connection = {
      transport: null,
      opened: false,
      closeInfo: null,
      sessionSeen: false,
      streamId: "",
    };
    this.conn = conn;
    this.firstFrameSent = false;
    const protocol = this.protocol();
    try {
      core.beginConnection(protocol);
    } catch (e) {
      this.fail(
        e instanceof StreamFailure
          ? e
          : new StreamFailure(
              null,
              "core-load-failed",
              e instanceof Error ? e.message : String(e),
            ),
      );
      return;
    }
    try {
      conn.transport = this.o.transport(
        this.endpoint,
        `render-stream.${protocol}`,
        {
          open: () => this.onOpen(conn),
          message: (d) => this.onMessage(conn, d),
          close: (code, reason) => {
            if (conn === this.conn) conn.closeInfo = { code, reason };
          },
        },
      );
    } catch (e) {
      conn.closeInfo = { code: 1006, reason: `cannot connect: ${String(e)}` };
    }
    this.startFrames();
  }

  private onOpen(conn: Connection): void {
    if (conn !== this.conn || this.phase !== "connecting") return;
    conn.opened = true;
    this.phase = "streaming";
    const c = this.o.canvas();
    this.send(
      clientHello({
        protocol: this.protocol(),
        creditWindow: this.o.creditWindow,
        creditStage: this.creditStage,
        token: this.endpoint.token,
        backing: c.backing,
        css: c.css,
        dprMilli: c.dprMilli,
        gpuFormats: c.gpuFormats,
        itemMeta: this.ext?.request ?? null,
      }),
    );
    this.executorPreparing = true;
    this.executorNeedsBegin = true;
    if (this.ctx === "ok") {
      try {
        this.beginExecutor();
      } catch (e) {
        this.fail(e);
      }
    }
  }

  private beginExecutor(): void {
    try {
      this.o.core.prepareExecutor?.();
      this.executorNeedsBegin = false;
    } catch (e) {
      if (
        e instanceof StreamFailure &&
        /lost/i.test(`${e.reason} ${e.message}`)
      )
        this.contextLost();
      else throw e;
    }
  }

  private protocol() {
    return clientProtocol(
      this.endpoint.protocol,
      this.ext?.request,
      this.hints !== null,
    );
  }

  private send(message: Record<string, unknown>): void {
    this.conn?.transport?.send(JSON.stringify(message));
  }

  /** `at` (ms, the loop clock): acks of one apply or one draw share it, so a fold reads as one
   * instant (the host tap's rule: `applied` acks sharing the receiver's `t_us` applied together). */
  private ack(seq: number, stage: AckStage, at = this.o.clock.now()): void {
    const conn = this.conn;
    const transport = conn?.transport;
    if (!transport) return;
    transport.send(
      this.acks.write(conn.streamId, seq, stage, Math.round(at * 1000)),
    );
  }

  /** Acks `submitted` every applied seq waiting for a draw, with one `t_us`, and clears them. */
  private ackUndrawnSubmitted(now: number): void {
    const undrawn = this.undrawn;
    for (let i = 0; i < undrawn.length; i++)
      this.ack(undrawn[i] as number, "submitted", now);
    undrawn.length = 0;
  }

  private onMessage(conn: Connection, data: ArrayBuffer | string): void {
    if (conn !== this.conn || this.phase !== "streaming") return;
    try {
      if (typeof data === "string") this.onHostText(conn, data);
      else this.onBinary(conn, data);
    } catch (e) {
      this.fail(e);
    }
  }

  private onHostText(conn: Connection, text: string): never {
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
    if (reason === "unauthorized" && !conn.sessionSeen)
      throw new StreamFailure(null, "live-connect-failed", "unauthorized");
    throw new StreamFailure(
      this.lastAppliedSeq || null,
      "host-error",
      reason === null
        ? `unexpected text message ${JSON.stringify(text)}`
        : `${reason}: ${detail}`,
    );
  }

  private onBinary(conn: Connection, buf: ArrayBuffer): void {
    const rec = this.recorder;
    const m = this.o.core.receive(buf, conn.sessionSeen, rec !== null);
    if (rec) {
      // The decoded record, in receipt order (the session carries the magic). `held` and
      // `coding-resync` are not records: nothing to record.
      const bytes = this.o.core.takeDecoded() as Uint8Array;
      if (m.kind === "session") rec.session(bytes);
      else if (m.kind === "transaction")
        rec.record(bytes, "transaction", m.full, m.seq);
      else if (m.kind === "resource") rec.record(bytes, "resource", false, 0);
      else if (m.kind === "item_meta") rec.record(bytes, "item_meta", false, 0);
      else if (m.kind === "end") rec.record(bytes, "end", false, 0);
      // Hints are not recorded: advisory, a recording replays as the same frames without them.
    }
    switch (m.kind) {
      case "item_meta":
        // Identities for the extensions, at receipt (no ext: skipped).
        if (this.ext) this.ext.itemMeta();
        return;
      case "held":
      case "resource":
        return;
      case "coding-resync":
        // W11t: the decoder skips based transactions until the full one, which a rebuilt
        // applier applies (the applier is delta-driven); the full may jump the seq.
        this.rebuildDue = true;
        this.o.core.transportSkip();
        this.send({
          type: "resync",
          stream_id: conn.streamId,
          seq: m.seq,
          reason: "coding",
        });
        return;
      case "session":
        conn.sessionSeen = true;
        this.beginSession(conn, m.meta);
        return;
      case "end":
        this.endSeen = true;
        return;
      case "transaction":
        break;
      // After `transaction`: a transaction never reaches these compares.
      case "hint":
        this.hints?.hint(m.hint, m.held, m.named);
        return;
      case "unhint":
        this.hints?.unhint(m.hash);
        return;
    }
    if (this.ext) this.ext.transaction();
    if (this.hints !== null && this.hints.size > 0)
      this.hints.referenced(this.o.core.hintRefs?.() ?? []);
    const now = this.o.clock.now();
    if (this.lastCreditAt !== null) {
      this.rtts[this.rttCount % RTT_SAMPLES] = now - this.lastCreditAt;
      this.rttCount++;
      this.lastCreditAt = null;
    }
    this.ack(m.seq, "received");
    // The cap's measure, at receipt: a real change wakes it before the next frame callback (a
    // folded or superseded transaction counts as much as one applied alone).
    if (this.cap.mode === "automatic") {
      const why = motionWake(
        this.o.core.motion?.() ?? null,
        m.seq,
        this.cap.limits,
      );
      if (why !== null) this.cap.activity(now, why);
    }
    // Every accepted transaction moves the names: what the loop tracks and the newest state no
    // longer names stops being tracked (a payload may leave and come back in one batch).
    this.sweepNames();
    if (m.needed.length > 0)
      this.cold.referenced(
        m.seq,
        this.unavailable.size === 0
          ? m.needed
          : m.needed.filter((n) => !this.unavailable.has(n.hash)),
      );
    const item: Queued = {
      seq: m.seq,
      frame: m.frame,
      full: m.full,
      needed: m.needed,
    };
    if (this.pending !== null && this.windowTwo()) {
      this.foldIntoPending(this.pending, item);
      return;
    }
    if (this.pending !== null) {
      // Window 1: the wasm core holds ONE accepted state, so the newest supersedes the pending
      // one and is applied by a fresh applier (takeQueued's rebuild).
      this.pending = null;
      // Hinted GETs can be joined by the rebuilt transaction; keep them and demand GETs
      // sharing the same fetcher. Without hints, cancel other work but preserve retry bounds
      // and deadlines; an obsolete retry must still settle as stale after the rebuild.
      if (this.prefetch === null) {
        this.fetcher?.cancel({ keepRetries: true });
        for (const hash of this.stale)
          if (!this.fetcher?.has(hash)) this.stale.delete(hash);
      }
      this.deferred.clear(); // The rebuilt applier needs these again (joining kept GETs).
      this.rebuildDue = true;
    }
    this.queue.push(item);
    if ((this.o.applyOn ?? DEFAULT_APPLY_ON) === "message")
      this.applyOnMessage(now);
  }

  /** `applyOn: "message"`: the queued transactions go now, not at the next frame callback,
   * when nothing waits ahead of them and the frame callbacks run. A transaction that needs
   * payloads starts its fetches here and applies at the frame callback that finds them in. */
  private applyOnMessage(now: number): void {
    if (
      this.ctx !== "ok" ||
      this.pending !== null ||
      this.rebuildDue ||
      // An engaged cap draws every other callback on purpose: twice as many applies may wait.
      this.undrawn.length >=
        MESSAGE_APPLY_MAX_UNDRAWN * (this.cap.engaged ? 2 : 1) ||
      this.lastFrameAt === null ||
      now - this.lastFrameAt > MESSAGE_APPLY_MAX_FRAME_GAP_MS
    )
      return;
    this.takeQueued(false);
  }

  private beginSession(conn: Connection, session: SessionMeta): void {
    conn.streamId = session.stream?.stream_id ?? "";
    // The pin rule ends with the connection; a new one re-sends the hints still in effect.
    this.hints?.clear();
    this.clearPrefetch();
    this.o.onSession?.(session);
    this.drawnSeq = null;
    this.cap.activity(this.o.clock.now(), "session");
    if (this.ext)
      this.ext.beginSession(session.session_id ?? "", conn.streamId);
    this.grantedWindow = session.publication?.credit_window ?? 1;
    const res = session.resources ?? {};
    const fetchKind = res.fetch ?? "none";
    this.fetcher?.abort();
    this.fetcher = null;
    this.makeFetcher = null;
    if (fetchKind === "directory")
      throw new StreamFailure(
        null,
        "resource-unavailable",
        "a live session advertises fetch directory",
      );
    if (fetchKind === "http") {
      const httpPath = res.http_path ?? null;
      if (httpPath === null)
        throw new StreamFailure(
          null,
          "resource-unavailable",
          "fetch http with http_path null",
        );
      const transport = conn.transport as RenderStreamTransport;
      const token = this.endpoint.token;
      // Bodies are staged as they arrive, unless the recorder needs each whole body.
      const stager =
        this.recorder === null
          ? (this.o.core.stageStream?.bind(this.o.core) ?? null)
          : null;
      this.makeFetcher = (restore = false) =>
        new LiveFetcher(
          (path, signal, opts) =>
            transport.fetchResource(path, {
              token,
              signal,
              stream: opts?.stream === true,
              progress: opts?.progress,
            }),
          httpPath,
          this.o.fetchTimeoutMs ?? 10000,
          0,
          (r) => this.stageFetched(r),
          // An unavailable payload's GET settles on its own: the others keep going.
          {
            maxInFlight: FETCH_PARALLEL,
            stager,
            wanted: (hash, background) => {
              if (restore) return this.restoreWant?.includes(hash) === true;
              if (this.wanted(hash) || this.isNamed(hash)) return true;
              const hint = background
                ? this.prefetch?.active.get(hash)?.hint
                : undefined;
              return hint !== undefined && this.hints?.has(hint) === true;
            },
            failures: "settle",
            abortOnCancel: true,
            retry: {
              now: () => this.o.clock.now(),
              mode: (hash, background) => {
                if (restore)
                  return this.restoreWant?.includes(hash) ? "demand" : null;
                // An older naming's failure must settle before a new naming asks afresh.
                if (this.wanted(hash))
                  return this.stale.has(hash) ? null : "demand";
                // A fold may still await an earlier joined hint while the state names it.
                if (
                  (!background || this.pending?.requester.has(hash)) &&
                  !this.stale.has(hash) &&
                  this.isNamed(hash)
                )
                  return "demand";
                const hint = background
                  ? this.prefetch?.active.get(hash)?.hint
                  : undefined;
                return hint !== undefined && this.hints?.has(hint)
                  ? "prefetch"
                  : null;
              },
              onRetry: () => {
                if (this.prefetch !== null) this.prefetch.getRetries++;
              },
            },
          },
        );
      this.fetcher = this.makeFetcher();
    }
    this.status({ kind: "streaming", firstFrame: false });
  }

  // ----------------------------------------------------------------------- frames

  private startFrames(): void {
    if (this.frameId === null)
      this.frameId = this.o.clock.requestFrame(this.onFrame);
  }

  private stopFrames(): void {
    if (this.frameId !== null) this.o.clock.cancelFrame(this.frameId);
    this.frameId = null;
    if (this.timerId !== null) this.o.clock.clearTimeout(this.timerId);
    this.timerId = null;
  }

  private readonly onFrame = (): void => {
    this.frameId = null;
    this.lastFrameAt = this.o.clock.now();
    this.cold.beginFrame();
    try {
      if (this.ext) this.ext.beginFrame();
      if (
        this.executorPreparing &&
        this.ctx === "ok" &&
        this.phase === "streaming" &&
        this.conn?.closeInfo === null
      ) {
        try {
          // An absent executor reports no pending stages, so retry Stage A before stepping.
          if (this.executorNeedsBegin) this.beginExecutor();
          if (!this.executorNeedsBegin)
            this.executorPreparing = this.o.core.prepareStep?.() === false;
        } catch (e) {
          if (
            e instanceof StreamFailure &&
            /lost/i.test(`${e.reason} ${e.message}`)
          )
            this.contextLost();
          else throw e;
        }
      }
      this.step();
    } catch (e) {
      this.fail(e);
      return;
    } finally {
      this.cold.endFrame();
    }
    if (
      this.phase === "connecting" ||
      this.phase === "streaming" ||
      this.phase === "draining"
    )
      this.startFrames();
  };

  /** receiver.gd `_process_live`, one callback. */
  private step(): void {
    const now = this.o.clock.now();
    const conn = this.conn as Connection;
    switch (this.phase) {
      case "connecting":
        if (conn.closeInfo !== null || now > this.deadline)
          this.connectFailed(conn);
        return;
      case "draining":
        if (conn.closeInfo !== null || now > this.deadline) {
          this.teardown(1000, "end seen");
          this.phase = "ended";
          this.status({ kind: "ended" });
        }
        return;
      case "streaming":
        break;
      default:
        return;
    }
    // The idle cap: whether this callback presents. A skipped one still applies and acks.
    let present = true;
    if (this.ctx !== "ok") {
      this.stepContext();
    } else {
      present = this.presents(now);
      // J1: links that settled since the last callback register before this callback's
      // applier run, which draws their materials.
      const linked = this.o.core.pollPrograms?.() === true;
      const runs = this.applierRuns;
      if (this.pending !== null) {
        this.advancePending();
        if (this.pending?.stage === "ready") this.applyReady(present);
      } else if (this.queue.length > 0) {
        this.takeQueued(present);
      }
      if (
        this.pending === null &&
        this.queue.length === 0 &&
        (this.deferred.size > 0 || this.fetcher?.busy() === true)
      )
        this.pollDeferred();
      if (this.prefetch !== null) this.prefetchIdle();
      if (linked) this.programsSettled();
      // J1: with no applier run in this callback and none waiting, particle bursts still in
      // progress continue (a host that went idle right after the join still converges), and one
      // that ends is applied over the same state and drawn.
      if (
        this.applierRuns === runs &&
        this.undrawn.length === 0 &&
        !this.revisitDraw &&
        this.applyDue === null &&
        !this.acceptedUntaken() &&
        this.connApplied > 0 &&
        this.o.core.settleParticles?.(this.lastAppliedSeq) === true
      )
        this.revisitDraw = true;
      // A payload that just arrived is a real change: drawn in this callback. So is the end: a
      // skipped callback that sees it would drain without ever drawing (or acking `submitted`)
      // the last applied state.
      if (!present && (this.revisitDraw || this.endSeen)) {
        this.cap.activity(now, this.revisitDraw ? "payload" : "end");
        present = true;
      }
    }
    if (this.ctx === "ok" && present) {
      if (this.undrawn.length > 0) {
        // The transactions applied before one accepted and not yet taken (waiting for its
        // payloads, or queued through a context loss) run with it: the core's prepared state
        // holds them all.
        if (this.applyDue === null || !this.acceptedUntaken())
          this.drawApplied();
      } else if (this.revisitDraw) this.drawRevisit(now);
      else if (this.ext) this.extensionRedraw(now);
    }
    if (this.phase !== "streaming") return;
    if (
      this.ctx === "ok" &&
      this.endSeen &&
      this.queue.length === 0 &&
      this.pending === null &&
      (this.deferred.size === 0 || conn.closeInfo !== null)
    ) {
      // The receiver closes first (the host lingers for it after the end record), once the
      // deferred payloads are drawn (unless the host closed already).
      this.phase = "draining";
      conn.transport?.close(1000, "end seen");
      this.deadline = now + CLOSE_WAIT_MS;
      return;
    }
    if (conn.closeInfo !== null && !this.endSeen) {
      const { code, reason } = conn.closeInfo;
      if (!conn.sessionSeen && code === 1008 && reason === "unauthorized")
        throw new StreamFailure(null, "live-connect-failed", "unauthorized");
      if (code === 1002 || code === 1008 || code === 1009)
        throw new StreamFailure(
          this.lastAppliedSeq || null,
          "host-error",
          `${reason}: the host closed with ${code}`,
        );
      if (!conn.sessionSeen && this.attempt === 0 && this.applied === 0)
        throw new StreamFailure(
          null,
          "live-connect-failed",
          `the connection closed (code ${code}) before its session`,
        );
      this.scheduleReconnect();
    }
  }

  /** The cap's answer for this callback; an extension animating (asking redraws) is activity. */
  private presents(now: number): boolean {
    if (this.cap.mode === "off") return true;
    if (this.ext?.wantsRedraw) this.cap.activity(now, "extension");
    return this.cap.present(now);
  }

  private connectFailed(conn: Connection): void {
    const c = conn.closeInfo;
    // A reconnect attempt that does not open just waits for the next one.
    if (this.attempt > 0) {
      this.scheduleReconnect();
      return;
    }
    const why =
      c === null
        ? "not open in time"
        : `close code ${c.code}${c.reason ? ` ${JSON.stringify(c.reason)}` : ""}${conn.opened ? "" : ", never opened"}`;
    throw new StreamFailure(
      null,
      "live-connect-failed",
      c?.code === 1008 && c.reason === "unauthorized"
        ? "unauthorized"
        : `no open connection (${why})`,
    );
  }

  private scheduleReconnect(): void {
    this.teardown(1000, "reconnect");
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)
      ];
    this.attempt++;
    this.phase = "backoff";
    this.status({ kind: "reconnecting", attempt: this.attempt, inMs: delay });
    this.timerId = this.o.clock.setTimeout(() => {
      this.timerId = null;
      if (this.phase === "backoff") this.open();
    }, delay);
  }

  /** Closes the current connection and drops its unapplied state; the core starts a fresh
   * session on the next one (payloads kept). */
  private teardown(code: number, reason: string): void {
    this.executorPreparing = false;
    this.executorNeedsBegin = false;
    const conn = this.conn;
    this.conn = null;
    if (conn?.transport) conn.transport.close(code, reason);
    if (this.timerId !== null) this.o.clock.clearTimeout(this.timerId);
    this.timerId = null;
    this.fetcher?.abort();
    this.fetcher = null;
    this.makeFetcher = null;
    this.pending = null;
    this.queue = [];
    this.coalesced = [];
    this.deferred.clear();
    // A reconnect fetches what was unavailable afresh.
    this.unavailable.clear();
    this.stale.clear();
    this.diag.view = null;
    this.cold.reset();
    this.hints?.clear();
    this.clearPrefetch();
    this.revisitDraw = false;
    this.undrawn.length = 0;
    this.applyDue = null;
    this.endSeen = false;
    this.rebuildDue = false;
    this.lastCreditAt = null;
    if (conn?.sessionSeen) {
      this.o.core.reset(true);
      this.connApplied = 0;
    }
  }

  private fail(e: unknown): void {
    if (this.phase === "disposed" || this.phase === "failed") return;
    const f =
      e instanceof StreamFailure
        ? e
        : new StreamFailure(
            this.lastAppliedSeq || null,
            "receiver-error",
            e instanceof Error ? e.message : String(e),
          );
    this.teardown(1000, "receiver failure");
    this.phase = "failed";
    this.stopFrames();
    this.status({ kind: "failed", reason: f.reason, detail: f.message });
  }

  private status(s: RenderStreamStatus): void {
    try {
      this.o.onStatus(s);
    } catch {
      // a product callback's error is not the stream's
    }
  }

  // ----------------------------------------------------------------------- transactions

  /** The session granted credit window 2. */
  private windowTwo(): boolean {
    return this.grantedWindow >= 2;
  }

  /** `next` folds into the pending transaction in place: the fetches it made are kept, and
   * only the payloads neither fetched nor requested yet (nor unavailable) are queued. */
  private foldIntoPending(p: Pending, next: Queued): void {
    this.coalesced.push(p.item);
    p.item = next;
    p.stage = "fetch";
    const fetcher = this.fetcher;
    const misses = next.needed.filter(
      (n) =>
        !p.bodies.has(n.hash) &&
        !this.unavailable.has(n.hash) &&
        !(fetcher?.has(n.hash) ?? false) &&
        (this.prefetch === null || !this.o.core.isStaged(n.hash)),
    );
    for (const n of misses)
      p.requester.set(n.hash, { seq: next.seq, kind: n.kind });
    const keep = new Set(next.needed.map((n) => n.hash));
    for (const h of this.deferred.keys()) keep.add(h);
    fetcher?.retain(keep);
    for (const h of p.bodies.keys()) keep.add(h);
    this.cold.retain(keep);
    if (misses.length > 0) {
      const hashes = misses.map((n) => n.hash);
      const f = this.needFetcher(next.seq, hashes[0]);
      this.checkFetches(next.seq, hashes);
      f.extend(hashes);
    }
  }

  /** The newest queued transaction becomes the one to apply (receiver.gd `_apply_newest`). */
  private takeQueued(draw: boolean): void {
    let rebuild = this.rebuildDue;
    const queued = this.queue;
    this.queue = [];
    const item = queued[queued.length - 1];
    const firstNeeder = new Map<string, number>();
    if (this.windowTwo()) {
      for (const q of queued)
        for (const n of q.needed)
          if (!firstNeeder.has(n.hash)) firstNeeder.set(n.hash, q.seq);
      // Several queued transactions apply in this one callback, drawing only the newest.
      for (const older of queued.slice(0, -1)) this.coalesced.push(older);
    } else if (queued.length > 1) rebuild = true; // superseded
    if (rebuild) {
      this.rebuildDue = false;
      // A rebuilt applier (a resync, a superseded window-1 transaction) is a real change.
      this.cap.activity(this.o.clock.now(), "rebuild");
      // The rebuilt applier runs from the accepted state: nothing of the old one's is due.
      this.applyDue = null;
      item.needed = this.o.core.rebuild(item.seq);
      // The rebuilt applier needs these (whatever an older transaction named and this one
      // does not is no longer waited for).
      this.cold.retain(new Set(item.needed.map((n) => n.hash)));
      this.cold.referenced(
        item.seq,
        item.needed.filter((n) => !this.unavailable.has(n.hash)),
      );
    }
    this.pending = {
      item,
      stage: "fetch",
      bodies: new Map(),
      requester: new Map(
        item.needed.map((n) => [
          n.hash,
          { seq: firstNeeder.get(n.hash) ?? item.seq, kind: n.kind },
        ]),
      ),
      since: -1,
    };
    // An unavailable payload is not fetched again while it stays named; a GET already queued or
    // in flight (a deferred payload's, a folded one's) is not asked twice.
    const misses = item.needed
      .map((n) => n.hash)
      .filter(
        (h) =>
          !this.unavailable.has(h) &&
          (this.prefetch === null || !this.o.core.isStaged(h)),
      );
    if (misses.length > 0) {
      const fetcher = this.needFetcher(item.seq, misses[0]);
      this.checkFetches(item.seq, misses);
      fetcher.extend(misses);
    }
    this.advancePending();
    if (this.pending?.stage === "ready") this.applyReady(draw);
  }

  private needFetcher(seq: number, hash: string): LiveFetcher {
    if (this.fetcher === null)
      throw new StreamFailure(
        seq,
        "resource-unavailable",
        `payload ${hash} is needed, and the session has no HTTP fetch`,
      );
    return this.fetcher;
  }

  /** W11c `inline-fetch-zero`: a hash that always arrives inline is never fetched. */
  private checkFetches(seq: number, misses: readonly string[]): void {
    for (const h of misses) {
      const err = this.o.core.checkFetch(h);
      if (err !== "") throw new StreamFailure(seq, "inline-fetch-zero", err);
    }
  }

  /** A 200 body in its fetch completion (between frames): verified and decoded by wasm. */
  private stageFetched(r: FetchResult): void {
    if (this.phase === "disposed" || r.data === null) return;
    // The recorder keeps the fetched body (before wasm takes ownership and it is dropped).
    this.recorder?.resource(r.hash, r.data);
    const t0 = this.o.clock.now();
    r.stage_error = this.o.core.stage(r.hash, r.data, r.staging);
    this.cold.staged(r.hash, this.o.clock.now() - t0);
    r.data = null; // in wasm now
  }

  /** The pending transaction's fetches (polled); all in (or unavailable), or the hold over, every
   * payload in provided in wasm's order and every other one deferred. */
  private advancePending(): void {
    const p = this.pending as Pending;
    const core = this.o.core;
    const seq = p.item.seq;
    // A hint may have staged these before the transaction existed (or between callbacks).
    if (this.prefetch !== null)
      for (const n of p.item.needed)
        if (!p.bodies.has(n.hash) && core.isStaged(n.hash))
          p.bodies.set(n.hash, null);
    const deferred = this.deferred;
    const unavailable = this.unavailable;
    /** Missing, not deferred already (a deferred one is not waited for again) and not
     * unavailable. */
    const waiting = (h: string): boolean =>
      !p.bodies.has(h) && !deferred.has(h) && !unavailable.has(h);
    const outstanding = (): boolean =>
      p.item.needed.some((n) => waiting(n.hash)) || this.folding();
    if (outstanding() && this.fetcher !== null) {
      for (const r of this.fetcher.poll().results) {
        if (this.prefetchResult(r)) continue;
        const t = p.requester.get(r.hash) ?? deferred.get(r.hash);
        if (!this.settle(r, t?.seq ?? seq, t?.kind ?? -1)) continue;
        p.bodies.set(r.hash, r.stage_error ?? null);
        this.cold.fetched(r);
      }
      if (outstanding()) {
        const now = this.o.clock.now();
        if (p.since < 0) p.since = now;
        if (now - p.since < this.resourceHoldMs) return;
        // The hold is over: what is still missing is deferred (shader code too: its materials'
        // draws are omitted until it arrives and compiles).
        for (const n of p.item.needed)
          if (waiting(n.hash))
            deferred.set(n.hash, {
              seq: p.requester.get(n.hash)?.seq ?? seq,
              kind: n.kind,
            });
      }
    }
    for (const n of p.item.needed) {
      if (
        !p.bodies.has(n.hash) &&
        (deferred.has(n.hash) || unavailable.has(n.hash))
      ) {
        const err = core.deferPayload(n.hash);
        if (err !== null)
          throw new StreamFailure(
            p.requester.get(n.hash)?.seq ?? seq,
            "receiver-error",
            err,
          );
        continue;
      }
      const err = p.bodies.get(n.hash) ?? core.provideStaged();
      if (err !== null && err !== undefined)
        throw refusal(p.requester.get(n.hash)?.seq ?? seq, err);
    }
    // A body fetched for a folded transaction the newest no longer needs goes to the store
    // too, so it is never refetched (a deferred one is then drawn by this apply), while the
    // state still names it; one it names no longer is dropped. Empty at window 1.
    let leftover: string[] | null = null;
    for (const [hash, stageError] of p.bodies) {
      if (p.item.needed.some((n) => n.hash === hash)) continue;
      if (stageError === null && !core.isStaged(hash)) continue;
      const forSeq =
        p.requester.get(hash)?.seq ?? deferred.get(hash)?.seq ?? seq;
      if (stageError !== null) throw refusal(forSeq, stageError);
      if (leftover === null) leftover = [];
      leftover.push(hash);
    }
    if (leftover !== null) {
      const named = core.named(leftover);
      for (let i = 0; i < leftover.length; i++) {
        const hash = leftover[i] as string;
        if (named[i] === 0) {
          core.dropStaged(hash);
          p.bodies.delete(hash);
          this.cold.forget(hash);
          continue;
        }
        const err = core.takeStaged(hash);
        if (err !== null) throw refusal(p.requester.get(hash)?.seq ?? seq, err);
      }
    }
    if (deferred.size > 0) for (const h of p.bodies.keys()) deferred.delete(h);
    // Every fetched body is in the store now: the draw after this apply draws it.
    for (const h of p.bodies.keys()) this.cold.inStore(h);
    p.stage = "ready";
  }

  /** Window 2: GETs of a folded transaction's payloads still going (not a deferred one's, nor
   * one the state no longer names). */
  private folding(): boolean {
    const f = this.fetcher;
    if (f === null || !this.windowTwo()) return false;
    if (
      this.deferred.size === 0 &&
      this.stale.size === 0 &&
      (this.prefetch?.active.size ?? 0) === 0
    )
      return f.busy();
    for (const h of f.requested())
      if (
        !this.deferred.has(h) &&
        !this.stale.has(h) &&
        (!this.prefetch?.active.has(h) || this.pending?.requester.has(h))
      )
        return true;
    return false;
  }

  /** Nothing waiting to apply: the deferred payloads fetched since go into the store, and a
   * revisit (an apply over the same state, no ack) makes what draws them drawable; the callback
   * then draws. Another fetched body (a folded one's) goes into the store too while it is named;
   * one no longer named is dropped. A failure settles its payload unavailable. */
  private pollDeferred(): void {
    const f = this.fetcher;
    if (f === null) return;
    const core = this.o.core;
    let arrived = false;
    for (const r of f.poll().results) {
      if (this.prefetchResult(r)) continue;
      const t = this.deferred.get(r.hash);
      const forSeq = t?.seq ?? this.lastAppliedSeq;
      if (!this.settle(r, forSeq, t?.kind ?? -1)) continue;
      if (r.stage_error) throw refusal(forSeq, r.stage_error);
      if (t === undefined && !this.isNamed(r.hash)) {
        core.dropStaged(r.hash);
        this.cold.forget(r.hash);
        continue;
      }
      if (core.isStaged(r.hash)) {
        const err = core.takeStaged(r.hash);
        if (err !== null) throw refusal(forSeq, err);
      }
      this.cold.fetched(r);
      this.cold.inStore(r.hash);
      if (this.deferred.delete(r.hash)) arrived = true;
    }
    // With a run due, that run takes them in (the core's revisit declines while prepared).
    if (
      arrived &&
      (this.applyDue !== null || core.revisit(this.lastAppliedSeq))
    )
      this.revisitDraw = true;
  }

  /** Initial hint GETs and retries share the idle gate and hint priority order. */
  private prefetchIdle(): void {
    const p = this.prefetch;
    const f = this.fetcher;
    const hints = this.hints;
    if (
      p === null ||
      f === null ||
      hints === null ||
      this.o.core.hintSelect === undefined ||
      this.pending !== null ||
      this.queue.length > 0 ||
      this.deferred.size > 0 ||
      this.endSeen ||
      this.conn?.closeInfo !== null ||
      this.ctx !== "ok"
    )
      return;
    for (const h of f.requested()) if (!p.active.has(h)) return;
    const max = Math.min(FETCH_PARALLEL - 1, this.o.prefetchMaxInFlight ?? 2);
    const budget = this.o.prefetchBudgetBytes ?? 64 << 20;
    if (p.active.size === 0 && (max <= 0 || p.spent >= budget)) return;
    const activeHints = new Set(
      [...p.active.values()].map((entry) => entry.hint),
    );
    for (const h of hints.entries()) {
      if (
        !activeHints.has(h.hash) &&
        (h.state !== "pending" || p.active.size >= max || p.spent >= budget)
      )
        continue;
      const selected = this.o.core.hintSelect?.(h.hash);
      if (!selected) continue; // An older wasm has no selector: hints stay advisory only.
      if (p.active.has(selected.hash)) {
        f.prefetch(selected.hash); // A due retry uses its existing slot and byte reservation.
        continue;
      }
      if (h.state !== "pending" || p.active.size >= max || p.spent >= budget)
        continue;
      if (this.o.core.isStaged(selected.hash)) {
        hints.markFetched(h.hash);
        continue;
      }
      if (p.attempted.has(selected.hash) || f.has(selected.hash)) continue;
      if (selected.bytes > budget - p.spent) continue;
      this.checkFetches(this.lastAppliedSeq, [selected.hash]);
      if (!f.prefetch(selected.hash)) break;
      p.active.set(selected.hash, { hint: h.hash, reserved: selected.bytes });
      p.attempted.add(selected.hash);
      p.spent += selected.bytes;
    }
  }

  /** Count a hint result, keeping unused verified bytes staged until demand names them. A
   * joined demand follows the ordinary provide/defer/failure path below the caller. */
  private prefetchResult(r: FetchResult): boolean {
    const p = this.prefetch;
    const entry = p?.active.get(r.hash);
    if (p === null || entry === undefined) return false;
    p.active.delete(r.hash);
    p.spent += (r.error === "" && !r.discarded ? r.bytes : 0) - entry.reserved;
    if (r.discarded) {
      if (this.wanted(r.hash)) return false;
      this.stale.delete(r.hash);
      return true;
    }
    if (r.error === "" && !r.stage_error) {
      p.hintsPrefetched++;
      p.hintPrefetchBytes += r.bytes;
      this.hints?.markFetched(entry.hint);
    } else p.hintPrefetchFailed++;
    if (this.wanted(r.hash)) return false;
    this.stale.delete(r.hash);
    return true;
  }

  private clearPrefetch(): void {
    const p = this.prefetch;
    if (p === null) return;
    p.active.clear();
    p.attempted.clear();
    p.spent = 0;
  }

  /** J1: a program link settled this callback. A run due takes it in (the core's revisit
   * declines while a transaction is prepared, and finds nothing left after an apply took it);
   * otherwise a revisit draws the materials it omitted. Either way this callback draws. */
  private programsSettled(): void {
    if (this.applyDue !== null || this.o.core.revisit(this.lastAppliedSeq))
      this.revisitDraw = true;
  }

  // ----------------------------------------------------------------------- unavailable payloads

  /** After each accepted transaction: of the payloads tracked (queued, in flight, deferred,
   * unavailable), each the newest state no longer names stops being tracked. One batched core
   * call, and none while nothing is tracked (the warm stream's case). */
  private sweepNames(): void {
    const f = this.fetcher;
    const busy = f?.busy() === true;
    if (!busy && this.deferred.size === 0 && this.unavailable.size === 0)
      return;
    const tracked: string[] = [];
    for (const h of this.deferred.keys()) tracked.push(h);
    for (const h of this.unavailable.keys()) tracked.push(h);
    // Advisory GETs survive leaving the names, but a joined demand still needs its naming
    // generation tracked: its old failure must not suppress a later naming.
    if (busy)
      for (const h of (f as LiveFetcher).requested())
        if (
          !this.deferred.has(h) &&
          !this.unavailable.has(h) &&
          (!this.prefetch?.active.has(h) || this.wanted(h))
        )
          tracked.push(h);
    if (tracked.length === 0) return;
    const named = this.o.core.named(tracked);
    for (let i = 0; i < tracked.length; i++)
      if (named[i] === 0) this.leave(tracked[i] as string);
  }

  /** `hash` left the accepted names: its queued GET goes, one in flight goes on as an older
   * naming's, and it is neither deferred nor unavailable any more (a later naming fetches it
   * afresh). */
  private leave(hash: string): void {
    const f = this.fetcher;
    if (f !== null) {
      f.unqueue(hash);
      if (f.has(hash)) this.stale.add(hash);
    }
    this.deferred.delete(hash);
    if (this.unavailable.delete(hash)) this.diag.view = null;
    this.cold.forget(hash);
  }

  private isNamed(hash: string): boolean {
    return this.o.core.named([hash])[0] !== 0;
  }

  /** Whether a payload of the newest state is waited for or deferred (a stale GET's failure
   * then asks it again, for this naming). */
  private wanted(hash: string): boolean {
    if (this.deferred.has(hash)) return true;
    const has = (q: Queued) => q.needed.some((n) => n.hash === hash);
    if (this.pending !== null && has(this.pending.item)) return true;
    return this.queue.some(has);
  }

  /** One completed GET: true for a body (verified on arrival; content-addressed, so it serves
   * whichever naming wants it), false for a failure settled here (the payload unavailable, or
   * an older naming's failure dropped). A fatal one throws. */
  private settle(r: FetchResult, seq: number, kind: number): boolean {
    const stale = this.stale.delete(r.hash);
    if (r.discarded) {
      // A hash can become wanted again between releasing its body and polling its result.
      if (this.wanted(r.hash)) this.fetcher?.extend([r.hash]);
      return false;
    }
    if (r.error === "") return true;
    if (r.outcome !== "missing" && r.outcome !== "temporary")
      throw failWith(seq, r.error);
    if (stale) {
      // That naming's answer: the payload is fetched again if the newest state wants it.
      if (this.wanted(r.hash)) this.fetcher?.extend([r.hash]);
      return false;
    }
    this.markUnavailable(
      r.hash,
      seq,
      kind,
      r.outcome,
      r.status,
      r.error,
      false,
    );
    return false;
  }

  /** `hash` is unavailable while the accepted state names it: deferred (what draws it omitted),
   * never fetched again meanwhile, never counted as fetched or drawn; one diagnostic record. */
  private markUnavailable(
    hash: string,
    seq: number,
    kind: number,
    reason: ResourceUnavailableReason,
    status: number | null,
    detail: string,
    restore: boolean,
  ): void {
    this.deferred.delete(hash);
    this.cold.forget(hash);
    this.unavailable.set(hash, { seq, kind });
    const d = this.diag;
    d.found++;
    if (reason === "missing") d.missing++;
    else d.temporary++;
    const at = this.o.clock.now();
    const i = d.ring.findIndex((e) => e.hash === hash);
    const prev = i >= 0 ? (d.ring.splice(i, 1)[0] as ResourceDiagnostic) : null;
    if (d.ring.length >= RESOURCE_LOG_MAX) d.ring.shift();
    d.ring.push(
      Object.freeze({
        hash,
        kind: kind >= 0 ? kind : (prev?.kind ?? kind),
        seq: prev?.seq ?? seq,
        reason,
        status,
        detail,
        restore,
        count: (prev?.count ?? 0) + 1,
        at,
      }),
    );
    d.view = null;
  }

  /** `stats().resources`: the same frozen object until it changes. */
  private resourceDiagnostics(): ResourceDiagnostics {
    const d = this.diag;
    if (d.view === null)
      d.view = Object.freeze({
        unavailable: this.unavailable.size,
        found: d.found,
        missing: d.missing,
        temporary: d.temporary,
        recent: Object.freeze(d.ring.slice()),
      });
    return d.view;
  }

  /** The revisited state drawn, with no transaction: acks nothing, asks no credit. */
  private drawRevisit(now: number): void {
    this.revisitDraw = false;
    if (this.ext) this.ext.beforeDraw(null, now);
    this.drawCore(this.lastAppliedSeq);
  }

  /** The pending transaction, every payload in: apply and ack applied; then, in a frame callback
   * (`draw`), draw and ack submitted. From `onmessage` the draw waits for the next frame
   * callback, which draws the newest applied state once for every apply since the last draw.
   * One that needed no payload leaves the applier's run to that draw (`applyDue`); one whose
   * payloads just went in runs it now. */
  private applyReady(draw: boolean): void {
    const p = this.pending as Pending;
    this.pending = null;
    const seq = p.item.seq;
    if (!draw && p.item.needed.length === 0 && p.bodies.size === 0)
      this.applyDue = seq;
    else {
      this.applyDue = null;
      this.runApplier(seq);
    }
    const folded = this.coalesced;
    this.coalesced = [];
    const now = this.o.clock.now();
    for (const f of folded) {
      this.ack(f.seq, "applied", now);
      this.undrawn.push(f.seq);
    }
    this.ack(seq, "applied", now);
    this.undrawn.push(seq);
    if (this.creditStage === "applied") this.lastCreditAt = now;
    this.lastAppliedSeq = seq;
    this.applied += folded.length + 1;
    this.connApplied += folded.length + 1;
    this.applyTimes[this.applyCount % APPLY_RING] = now;
    this.applyCount++;
    if (draw) this.drawApplied();
  }

  /** Whether a transaction accepted into the core waits to be taken: pending (its payloads) or
   * queued. The core's prepared state holds it, so the applier runs only with it. */
  private acceptedUntaken(): boolean {
    return this.pending !== null || this.queue.length > 0;
  }

  /** The due run of the applier, if any. */
  private flushApply(): void {
    const seq = this.applyDue;
    if (seq === null) return;
    this.applyDue = null;
    this.runApplier(seq);
  }

  /** One run of the applier over every transaction accepted since the last (`seq` the newest):
   * programs and particles, the core's apply, its facts, then the extensions' `applied`. */
  private runApplier(seq: number): void {
    this.applierRuns++;
    const core = this.o.core;
    core.prepareApply(seq);
    core.apply(seq);
    const facts = core.applyStats?.();
    if (facts) {
      if (facts.structural) this.structuralApplies++;
      this.lastApplyWhy = facts.why;
      this.backBufferItems = facts.backBufferItems;
      this.surfaces.rendered = facts.surfacesRendered ?? 0;
      this.surfaces.skipped = facts.surfacesSkipped ?? 0;
      this.surfaces.unchanged = facts.surfacesUnchanged ?? 0;
      this.surfaces.allocated = facts.surfacesAllocated ?? 0;
      this.surfaces.pixels = facts.surfacePixels ?? 0;
    }
    if (this.ext) this.ext.applied();
  }

  /** Draws the newest applied state and acks submitted every seq applied since the last draw. */
  private drawApplied(): void {
    this.flushApply();
    const seq = this.lastAppliedSeq;
    if (this.ext) this.ext.beforeDraw(seq, this.o.clock.now());
    this.drawCore(seq);
    this.drawnSeq = seq;
    const now = this.o.clock.now();
    this.ackUndrawnSubmitted(now);
    this.revisitDraw = false;
    if (this.creditStage !== "applied") this.lastCreditAt = now;
    this.attempt = 0;
    if (!this.firstFrameSent) {
      this.firstFrameSent = true;
      this.status({ kind: "streaming", firstFrame: true });
    }
  }

  /** An extension asked to draw again with no
   * transaction: `beforeDraw` (seq null), the table composed, one draw. Acks nothing, asks no
   * credit. */
  private extensionRedraw(now: number): void {
    const ext = this.ext as ExtensionHost;
    if (!ext.wantsRedraw || this.connApplied === 0 || this.pending !== null)
      return;
    ext.beforeDraw(null, now);
    this.drawCore(this.lastAppliedSeq);
    ext.redraws++;
  }

  /** One draw of the applied state; it closes every missed payload in the store since the last
   * one (one branch when there is none). */
  private drawCore(seq: number): void {
    if (!this.cold.pending) {
      this.o.core.draw(seq);
      this.sampleDamage(this.o.clock.now());
      return;
    }
    const start = this.o.clock.now();
    this.o.core.draw(seq);
    this.sampleDamage(this.o.clock.now());
    this.cold.drew(start);
  }

  // ----------------------------------------------------------------------- context loss

  /** Nothing while lost; once restored, refetch any evicted resident payload, then redraw
   * the last applied state with no transaction. Credit resumes with the next transaction. A
   * payload the refetch cannot get is unavailable: what was resident from it leaves residency (the
   * redraw skips its draws, never stale contents) and is re-lowered by a revisit before the redraw,
   * or, with a transaction accepted and not applied (never applied over by an empty one), by that
   * transaction's apply. */
  private stepContext(): void {
    if (this.ctx !== "restoring") return;
    const core = this.o.core;
    if (this.connApplied === 0) {
      this.ctx = "ok";
      return;
    }
    if (this.restoreWant === null) {
      this.restoreWant = core.restoreMissing();
      if (this.restoreWant.length > 0) {
        if (this.makeFetcher === null)
          throw new StreamFailure(
            this.lastAppliedSeq,
            "resource-unavailable",
            `context restore: payload ${this.restoreWant[0]} left the store, and the session has no HTTP fetch`,
          );
        this.restoreFetcher = this.makeFetcher(true);
        this.restoreFetcher.start(this.restoreWant);
      }
    }
    let relower = false;
    if (this.restoreFetcher !== null) {
      const seq = this.lastAppliedSeq;
      for (const r of this.restoreFetcher.poll().results) {
        if (r.error !== "") {
          if (r.outcome !== "missing" && r.outcome !== "temporary")
            throw failWith(seq, r.error);
          this.restoreBodies.set(r.hash, r.error);
          this.restoreFailed.set(r.hash, r);
          continue;
        }
        if (r.stage_error) throw refusal(seq, r.stage_error);
        this.restoreBodies.set(r.hash, null);
      }
      if (this.restoreWant.some((h) => !this.restoreBodies.has(h))) return;
      for (const h of this.restoreWant) {
        const failed = this.restoreFailed.get(h);
        if (failed !== undefined) {
          const err = core.restoreUnavailable(h);
          if (err !== null) throw new StreamFailure(seq, "receiver-error", err);
          this.markUnavailable(
            h,
            seq,
            0,
            failed.outcome === "missing" ? "missing" : "temporary",
            failed.status,
            failed.error,
            true,
          );
          relower = true;
          continue;
        }
        const err = core.takeStaged(h);
        if (err !== null) throw new StreamFailure(seq, "resource-invalid", err);
      }
      this.restoreFetcher = null;
      this.restoreBodies.clear();
      this.restoreFailed.clear();
    }
    // Nothing accepted and unapplied: a revisit re-lowers what the unavailable payloads drew.
    // With a run due, that run re-lowers them.
    if (
      relower &&
      this.pending === null &&
      this.queue.length === 0 &&
      this.applyDue === null
    )
      core.revisit(this.lastAppliedSeq);
    // Not while a transaction accepted since waits (for its payloads, or queued through the
    // loss): the due run is its run (the redraw then shows the last run's state, and the
    // transactions due wait for it).
    if (!this.acceptedUntaken()) this.flushApply();
    const redrawAt = this.o.clock.now();
    if (core.redraw(this.lastAppliedSeq) === "lost") {
      this.ctx = "lost";
      this.restoreWant = null;
      return;
    }
    this.sampleDamage(this.o.clock.now());
    if (this.cold.pending) this.cold.drew(redrawAt);
    this.restoreWant = null;
    this.ctx = "ok";
    // The redraw drew the newest applied state, so every apply waiting for a draw is in it
    // (unless its run is still due: those wait for the draw after it).
    if (this.applyDue === null) {
      this.drawnSeq = this.lastAppliedSeq;
      this.ackUndrawnSubmitted(this.o.clock.now());
    }
  }
}

function refusal(seq: number, err: string): StreamFailure {
  return new StreamFailure(
    seq,
    err.startsWith("resource-hash")
      ? "resource-hash-mismatch"
      : "resource-invalid",
    err,
  );
}
