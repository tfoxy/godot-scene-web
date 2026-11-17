// The resource hint table (render-stream-15.md "Resource hints"): what a /15 host announced it
// will serve ahead of any transaction naming it, kept for a prefetcher.
//
// A hint enters on `resource_hint` and leaves on `resource_unhint` or when its connection ends
// (the pin rule's window). Each entry is `pending` until the receiver has the payload (`fetched`:
// in the store, staged, or marked by a prefetcher) or a transaction first draws it (`referenced`:
// named by a command, material or canvas texture; a texture-table entry alone is not a reference).
// The table is bounded: past `HINT_TABLE_MAX` entries the one taken last in prefetch order
// (highest `priority`, latest at equal priority) is dropped and counted. The table records; it
// fetches nothing.

/** A hinted payload's alternative (render-stream-9.md's variant objects). */
export interface ResourceHintVariant {
  readonly encoding: string;
  readonly hash: string;
  readonly payloadBytes: number;
  /** `block` only: the source block format; null otherwise. */
  readonly format: string | null;
}

/** A `resource_hint` record's fields, camel-cased. */
export interface ResourceHintRecord {
  /** The `decoded` payload's hex SHA-256, the identity. */
  readonly hash: string;
  readonly format: string;
  readonly sourceFormat: string | null;
  readonly width: number;
  readonly height: number;
  readonly mipmaps: boolean;
  readonly payloadBytes: number;
  readonly variants: readonly ResourceHintVariant[];
  /** The game's resource path while the texture is pristine, else null. A name for caches and
   * logs only: the hash is the identity. */
  readonly path: string | null;
  readonly cause: "create" | "warm" | "predicted" | "integrator";
  /** Lower is sooner. */
  readonly priority: number;
}

export type HintState = "pending" | "fetched" | "referenced";

/** One hint in effect (`RenderStreamClient.hints()`). */
export interface HintEntry {
  readonly hash: string;
  readonly meta: ResourceHintRecord;
  readonly path: string | null;
  readonly cause: ResourceHintRecord["cause"];
  readonly priority: number;
  /** When the hint arrived, on the loop's clock (`performance.now()` on a page). */
  readonly receivedAt: number;
  readonly state: HintState;
}

/** One hint a transaction first drew after it arrived (`RenderStreamStats.hintLeadLog`). */
export interface HintLead {
  readonly hash: string;
  /** Hint arrival to the first transaction naming it, in ms. */
  readonly leadMs: number;
  /** Frame callbacks begun in between. */
  readonly leadFrames: number;
}

export interface HintTotals {
  /** `resource_hint` records received over every connection. */
  hintsReceived: number;
  /** `resource_unhint` records received. */
  unhintsReceived: number;
  /** Hints a transaction first drew after they arrived. */
  hintsReferenced: number;
  /** Hints that arrived for a hash the accepted state already drew. */
  hintsLate: number;
  /** Hints the table's bound dropped. */
  hintsDropped: number;
  /** The shortest and longest lead of a referenced hint, in ms (null before one). */
  hintLeadMsMin: number | null;
  hintLeadMsMax: number | null;
}

/** Entries held at once; past it the last in prefetch order is dropped. */
export const HINT_TABLE_MAX = 4096;
/** Records kept for `hintLeadLog` (newest last). */
export const HINT_LEAD_LOG_MAX = 64;

interface Entry {
  hash: string;
  meta: ResourceHintRecord;
  path: string | null;
  cause: ResourceHintRecord["cause"];
  priority: number;
  receivedAt: number;
  receivedFrame: number;
  /** Arrival order, the tie-break at equal priority. */
  order: number;
  state: HintState;
}

const byPrefetchOrder = (a: Entry, b: Entry): number =>
  a.priority - b.priority || a.order - b.order;

export class HintTable {
  private readonly map = new Map<string, Entry>();
  private order = 0;
  private pendingCount = 0;
  private sorted: readonly HintEntry[] | null = null;
  private readonly ring: HintLead[] = [];
  private logView: readonly HintLead[] = Object.freeze([]);
  private logDirty = false;
  readonly totals: HintTotals = {
    hintsReceived: 0,
    unhintsReceived: 0,
    hintsReferenced: 0,
    hintsLate: 0,
    hintsDropped: 0,
    hintLeadMsMin: null,
    hintLeadMsMax: null,
  };

  /** `now`: the loop's clock; `frames`: frame callbacks begun so far (the lead in frames). */
  constructor(
    private readonly now: () => number,
    private readonly frames: () => number = () => 0,
    private readonly max = HINT_TABLE_MAX,
  ) {}

  /** A `resource_hint`. `held`: the payload is already here; `named`: the accepted state already
   * draws it. */
  hint(meta: ResourceHintRecord, held = false, named = false): void {
    this.totals.hintsReceived++;
    if (named) this.totals.hintsLate++;
    const old = this.map.get(meta.hash);
    if (old !== undefined) this.remove(old);
    const e: Entry = {
      hash: meta.hash,
      meta,
      path: meta.path,
      cause: meta.cause,
      priority: meta.priority,
      receivedAt: this.now(),
      receivedFrame: this.frames(),
      order: this.order++,
      state: named ? "referenced" : held ? "fetched" : "pending",
    };
    this.map.set(e.hash, e);
    if (e.state === "pending") this.pendingCount++;
    this.sorted = null;
    if (this.map.size > this.max) {
      let last = e;
      for (const x of this.map.values())
        if (byPrefetchOrder(x, last) > 0) last = x;
      this.remove(last);
      this.totals.hintsDropped++;
    }
  }

  /** A `resource_unhint`: the host stops serving `hash`. False when it was not in the table. */
  unhint(hash: string): boolean {
    this.totals.unhintsReceived++;
    const e = this.map.get(hash);
    if (e === undefined) return false;
    this.remove(e);
    return true;
  }

  /** A transaction named these hinted hashes: each one's first naming records its lead. */
  referenced(hashes: readonly string[]): void {
    let at = -1;
    for (const h of hashes) {
      const e = this.map.get(h);
      if (e === undefined || e.state === "referenced") continue;
      if (at < 0) at = this.now();
      if (e.state === "pending") this.pendingCount--;
      e.state = "referenced";
      this.sorted = null;
      const leadMs = at - e.receivedAt;
      const t = this.totals;
      t.hintsReferenced++;
      if (t.hintLeadMsMin === null || leadMs < t.hintLeadMsMin)
        t.hintLeadMsMin = leadMs;
      if (t.hintLeadMsMax === null || leadMs > t.hintLeadMsMax)
        t.hintLeadMsMax = leadMs;
      if (this.ring.length >= HINT_LEAD_LOG_MAX) this.ring.shift();
      this.ring.push({
        hash: h,
        leadMs,
        leadFrames: this.frames() - e.receivedFrame,
      });
      this.logDirty = true;
    }
  }

  /** The receiver has the payload (a prefetcher's GET landed): no longer pending. */
  markFetched(hash: string): void {
    const e = this.map.get(hash);
    if (e === undefined || e.state !== "pending") return;
    e.state = "fetched";
    this.pendingCount--;
    this.sorted = null;
  }

  has(hash: string): boolean {
    return this.map.has(hash);
  }

  get(hash: string): HintEntry | undefined {
    const e = this.map.get(hash);
    return e === undefined ? undefined : view(e);
  }

  get size(): number {
    return this.map.size;
  }

  /** Entries neither fetched nor referenced. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Every entry in prefetch order (ascending `priority`, then arrival): a frozen array, the
   * same one until the table changes. */
  entries(): readonly HintEntry[] {
    if (this.sorted === null) {
      this.sorted = Object.freeze(
        [...this.map.values()].sort(byPrefetchOrder).map(view),
      );
    }
    return this.sorted;
  }

  /** Pending entries in prefetch order. */
  *pendingInOrder(): IterableIterator<HintEntry> {
    for (const e of this.entries()) if (e.state === "pending") yield e;
  }

  /** The connection ended: its hints end with it (the totals stay). */
  clear(): void {
    this.map.clear();
    this.pendingCount = 0;
    this.sorted = null;
  }

  /** The lead records, newest last; the same frozen array until a reference adds one. */
  log(): readonly HintLead[] {
    if (this.logDirty) {
      this.logView = Object.freeze(this.ring.slice());
      this.logDirty = false;
    }
    return this.logView;
  }

  private remove(e: Entry): void {
    this.map.delete(e.hash);
    if (e.state === "pending") this.pendingCount--;
    this.sorted = null;
  }
}

function view(e: Entry): HintEntry {
  return Object.freeze({
    hash: e.hash,
    meta: e.meta,
    path: e.path,
    cause: e.cause,
    priority: e.priority,
    receivedAt: e.receivedAt,
    state: e.state,
  });
}
