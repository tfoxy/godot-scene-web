// Cold payloads: how long the screen went without a fetched payload.
//
// A payload a transaction needs and the store does not hold is "missed" from the moment the first
// transaction naming it arrives (its first reference) until the first draw after it went into the
// store (staged, provided or taken, so that draw also uploads it to the GPU, which is lazy). The
// frame callbacks that ran in between, not counting the one that drew it, are its cold frames:
// frames shown without it, whether they drew the newer state without it (deferred, the default
// `resourceHoldMs` 0) or kept the previous state (held). A payload in by the first frame callback
// after its reference, and drawn there, counts 0.
//
// Cost: a frame counter and one branch per draw while nothing is missed; the rest runs per
// fetched payload. The per-payload records are a bounded ring, read through `stats()`.

import type { FetchResult } from "./fetcher";

/** One missed payload, first reference to first draw (`RenderStreamStats.coldPayloadLog`). */
export interface ColdPayload {
  /** Hex SHA-256. */
  hash: string;
  /** wasm's payload kind: 0 texture, 1 mesh, 2 shader, 3 KTX2. */
  kind: number;
  /** The body as fetched (after the HTTP content coding is undone), or 0 if not fetched here. */
  bytes: number;
  /** The first transaction that named it. */
  seq: number;
  /** When that transaction arrived, on the loop's clock (`performance.now()` on a page), so a
   * harness can line the record up with resource timing or a trace. */
  refAt: number;
  /** Frame callbacks after the first reference and before the one that drew it. */
  coldFrames: number;
  /** First reference to the end of the draw that first drew it. */
  ms: number;
  /** The GET itself: request to last byte (streamed staging included), excluding any queue wait. */
  getMs: number;
  /** Whole-body staging (verify and decode) in the GET's completion; 0 when staged as streamed. */
  stageMs: number;
  /** First reference to the loop taking the body (queue wait, GET, stage, the frame it waited for). */
  inMs: number;
  /** That first draw's call, which includes the payload's lazy GPU upload. */
  drawMs: number;
  /** The body was staged as it arrived. */
  streamed: boolean;
}

/** Aggregates over every missed payload drawn since the client started. */
export interface ColdTotals {
  missedPayloads: number;
  coldPayloads: number;
  coldFramesSum: number;
  coldFramesMax: number;
  coldMsMax: number;
}

interface Open {
  hash: string;
  kind: number;
  seq: number;
  refFrame: number;
  refAt: number;
  bytes: number;
  getMs: number;
  stageMs: number;
  inAt: number;
  streamed: boolean;
}

/** Records kept for `coldPayloadLog` (newest last). */
export const COLD_LOG_MAX = 128;
/** Missed payloads tracked at once; past it the oldest is dropped unrecorded. */
const OPEN_MAX = 1024;

export class ColdTracker {
  /** Frame callbacks begun. */
  private frame = 0;
  private inFrame = false;
  private readonly open = new Map<string, Open>();
  /** In the store since the last draw: the next draw closes them. */
  private drawable: Open[] = [];
  /** Whole-body stage times by hash, from the GET's completion until the loop takes the body. */
  private readonly stageMs = new Map<string, number>();
  private readonly ring: ColdPayload[] = [];
  private logView: readonly ColdPayload[] = Object.freeze([]);
  private logDirty = false;
  readonly totals: ColdTotals = {
    missedPayloads: 0,
    coldPayloads: 0,
    coldFramesSum: 0,
    coldFramesMax: 0,
    coldMsMax: 0,
  };

  constructor(private readonly now: () => number) {}

  /** Frame callbacks begun (the hint table's lead in frames reads it). */
  get frames(): number {
    return this.frame;
  }

  beginFrame(): void {
    this.frame++;
    this.inFrame = true;
  }

  endFrame(): void {
    this.inFrame = false;
  }

  /** A transaction named these payloads missing; the first naming starts each one's clock. */
  referenced(
    seq: number,
    needed: readonly { hash: string; kind: number }[],
  ): void {
    if (needed.length === 0) return;
    // Referenced inside a frame callback: drawing in that same callback counts 0.
    const refFrame = this.inFrame ? this.frame - 1 : this.frame;
    let at = -1;
    for (const n of needed) {
      if (this.open.has(n.hash)) continue;
      if (at < 0) at = this.now();
      if (this.open.size >= OPEN_MAX) {
        const oldest = this.open.keys().next().value as string;
        this.open.delete(oldest);
      }
      this.open.set(n.hash, {
        hash: n.hash,
        kind: n.kind,
        seq,
        refFrame,
        refAt: at,
        bytes: 0,
        getMs: 0,
        stageMs: 0,
        inAt: -1,
        streamed: false,
      });
    }
  }

  /** A whole body's staging time (in the GET's completion, before the loop polls it). */
  staged(hash: string, ms: number): void {
    if (this.open.has(hash)) this.stageMs.set(hash, ms);
  }

  /** The loop took a fetched body. */
  fetched(r: FetchResult): void {
    const o = this.open.get(r.hash);
    if (o === undefined || o.inAt >= 0) return;
    o.inAt = this.now();
    o.bytes = r.bytes;
    o.getMs = r.end_us > r.start_us ? (r.end_us - r.start_us) / 1000 : 0;
    o.streamed = r.streamed === true;
    o.stageMs = this.stageMs.get(r.hash) ?? 0;
    this.stageMs.delete(r.hash);
  }

  /** The payload is in the store: the next draw draws (and uploads) it. */
  inStore(hash: string): void {
    const o = this.open.get(hash);
    if (o === undefined) return;
    this.open.delete(hash);
    this.drawable.push(o);
  }

  /** Whether a draw has anything to close (the per-draw branch). */
  get pending(): boolean {
    return this.drawable.length > 0;
  }

  /** The draw that started at `drawStart` and just ended drew every payload in the store. */
  drew(drawStart: number): void {
    const end = this.now();
    const t = this.totals;
    for (const o of this.drawable) {
      const coldFrames = Math.max(0, this.frame - o.refFrame - 1);
      const ms = end - o.refAt;
      const rec: ColdPayload = {
        hash: o.hash,
        kind: o.kind,
        bytes: o.bytes,
        seq: o.seq,
        refAt: o.refAt,
        coldFrames,
        ms,
        getMs: o.getMs,
        stageMs: o.stageMs,
        inMs: o.inAt >= 0 ? o.inAt - o.refAt : 0,
        drawMs: end - drawStart,
        streamed: o.streamed,
      };
      t.missedPayloads++;
      if (coldFrames > 0) {
        t.coldPayloads++;
        t.coldFramesSum += coldFrames;
      }
      if (coldFrames > t.coldFramesMax) t.coldFramesMax = coldFrames;
      if (ms > t.coldMsMax) t.coldMsMax = ms;
      if (this.ring.length >= COLD_LOG_MAX) this.ring.shift();
      this.ring.push(rec);
    }
    this.drawable = [];
    this.logDirty = true;
  }

  /** Keeps only these open payloads (a rebuild or a fold no longer needs the rest): the others are
   * dropped unrecorded, since nothing waits for them any more. */
  retain(keep: ReadonlySet<string>): void {
    if (this.open.size === 0) return;
    for (const h of this.open.keys())
      if (!keep.has(h)) {
        this.open.delete(h);
        this.stageMs.delete(h);
      }
  }

  /** `hash` will not be drawn (it is unavailable, or no longer named): dropped unrecorded, so a
   * failed payload never counts as fetched, in the store or drawn. */
  forget(hash: string): void {
    if (this.open.delete(hash)) this.stageMs.delete(hash);
  }

  /** A connection ended: what was missed in it is dropped unrecorded. */
  reset(): void {
    this.open.clear();
    this.drawable = [];
    this.stageMs.clear();
  }

  /** The records, newest last; the same frozen array until a draw adds one. */
  log(): readonly ColdPayload[] {
    if (this.logDirty) {
      this.logView = Object.freeze(this.ring.slice());
      this.logDirty = false;
    }
    return this.logView;
  }
}
