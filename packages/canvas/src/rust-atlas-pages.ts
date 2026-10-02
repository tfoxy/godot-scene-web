/** Bounded page residency for runtime-generated glyph atlases. Packing and glyph ownership stay with the caller. */
export interface RustAtlasReservation {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  /** RSR2 releases to include with the upload before committing this plan. */
  readonly evicted: readonly string[];
}

interface PendingReservation extends RustAtlasReservation { readonly bytes: number }

export class RustAtlasPages {
  private readonly pages = new Map<string, { width: number; height: number; bytes: number; touched: number }>();
  private readonly pinned = new Set<string>();
  private readonly pending: PendingReservation[] = [];
  private clock = 0;
  private residentBytes = 0;
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid atlas byte cap");
  }
  /** The caller supplies active and in-flight scene references before planning an upload. */
  pin(keys: Iterable<string>): void {
    if (this.pending.length) throw new Error("finish atlas reservations before changing pins");
    this.pinned.clear();
    for (const key of keys) if (this.pages.has(key)) this.pinned.add(key);
  }
  touch(key: string): boolean {
    if (this.pending.length) throw new Error("finish atlas reservations before touching pages");
    const page = this.pages.get(key);
    if (!page) return false;
    page.touched = ++this.clock;
    return true;
  }
  /** Plan eviction without changing residency or LRU. Pending pages are protected from later plans. */
  reserve(key: string, width: number, height: number): RustAtlasReservation {
    if (!key || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error("invalid atlas page");
    const bytes = width * height * 4;
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) throw new Error("atlas page exceeds byte cap");
    const protectedKeys = new Set<string>();
    const virtual = new Map(this.pages);
    let virtualBytes = this.residentBytes;
    for (const plan of this.pending) {
      protectedKeys.add(plan.key);
      for (const victim of plan.evicted) {
        protectedKeys.add(victim);
        virtualBytes -= virtual.get(victim)?.bytes ?? 0;
        virtual.delete(victim);
      }
      virtualBytes += plan.bytes - (virtual.get(plan.key)?.bytes ?? 0);
      virtual.set(plan.key, { width: plan.width, height: plan.height,
        bytes: plan.bytes, touched: this.clock });
    }
    if (protectedKeys.has(key)) throw new Error("atlas page has a pending reservation");
    const prior = virtual.get(key);
    if (prior && (prior.width !== width || prior.height !== height) && this.pinned.has(key))
      throw new Error("cannot resize pinned atlas page");
    const candidates = [...virtual].filter(([id]) => id !== key && !this.pinned.has(id) && !protectedKeys.has(id))
      .sort((a, b) => a[1].touched - b[1].touched);
    let available = this.maxBytes - virtualBytes + (prior?.bytes ?? 0);
    const evicted: string[] = [];
    for (const [id, page] of candidates) {
      if (available >= bytes) break;
      available += page.bytes;
      evicted.push(id);
    }
    if (available < bytes) throw new Error("atlas pages pinned or reserved beyond byte cap");
    const plan: PendingReservation = Object.freeze({ key, width, height, bytes, evicted: Object.freeze(evicted) });
    this.pending.push(plan);
    return plan;
  }
  /** Call only after the corresponding resource upload has succeeded; plans commit in upload order. */
  commit(plan: RustAtlasReservation): void {
    if (this.pending[0] !== plan) throw new Error("atlas reservation commit order mismatch");
    const pending = this.pending.shift()!;
    const keepPinned = this.pinned.has(pending.key);
    for (const key of pending.evicted) this.releasePage(key);
    this.releasePage(pending.key);
    this.pages.set(pending.key, { width: pending.width, height: pending.height,
      bytes: pending.bytes, touched: ++this.clock });
    this.residentBytes += pending.bytes;
    if (keepPinned) this.pinned.add(pending.key);
  }
  /** Cancelling a plan also invalidates plans made after it; committed residency is unchanged. */
  cancel(plan: RustAtlasReservation): void {
    const index = this.pending.indexOf(plan as PendingReservation);
    if (index < 0) throw new Error("unknown atlas reservation");
    this.pending.splice(index);
  }
  release(key: string): boolean {
    if (this.pending.length) throw new Error("finish atlas reservations before releasing pages");
    return this.releasePage(key);
  }
  private releasePage(key: string): boolean {
    const page = this.pages.get(key);
    if (!page) return false;
    this.pages.delete(key);
    this.pinned.delete(key);
    this.residentBytes -= page.bytes;
    return true;
  }
  stats(): { pages: number; bytes: number; pinned: number; pending: number } {
    return { pages: this.pages.size, bytes: this.residentBytes, pinned: this.pinned.size,
      pending: this.pending.length };
  }
}
