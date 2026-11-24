/** Down-step window and minimum true misses in it, after the first 5 s of a selection. */
const DOWN_STEP_WINDOW_MS = 4000;
const DOWN_STEP_MIN_MISSED = 6;

/** @internal Eligible display slot; `t` is its grid time in monotonic milliseconds. */
export interface SaverSlot {
  k: number;
  t: number;
  missed: boolean;
  stale: boolean;
}

/** Client-only display-divisor pacing. The caller supplies callback timestamps and reports
 * successful draws; this state machine owns neither timers nor credit. */
export class SaverPacer {
  private calibration: number[] = [];
  private observations: { grid: number; ts: number }[] = [];
  private displayMs: number | null = null;
  private anchorMs = 0;
  private lastCallback: number | undefined;
  private lastGrid = -1;
  private lastTaken = -1;
  private slots: SaverSlot[] = [];
  private current: SaverSlot | undefined;
  private capacityStart: number | undefined;
  private callbacks = 0;
  private capacityHz: number | null = null;
  private k = 1;
  private enteredMs = 0;
  private cleanSince = 0;
  private probeEveryMs = 30000;
  private probe: { from: number; start: number } | null = null;

  constructor(
    private readonly clock: { now(): number },
    private readonly onSlot?: (slot: Readonly<SaverSlot>) => void,
  ) {}

  private observe(slot: SaverSlot): void {
    try {
      this.onSlot?.({ ...slot });
    } catch {
      /* Observation cannot fail playback. */
    }
  }

  /** @internal Report the callback slot after its draw outcome is known. */
  finishSlot(): void {
    const slot = this.current;
    this.current = undefined;
    if (slot && this.onSlot) this.observe(slot);
  }

  reset(): void {
    this.calibration = [];
    this.observations = [];
    this.displayMs = null;
    this.anchorMs = 0;
    this.lastCallback = undefined;
    this.lastGrid = this.lastTaken = -1;
    this.slots = [];
    this.current = undefined;
    this.capacityStart = undefined;
    this.callbacks = 0;
    this.capacityHz = null;
    this.k = 1;
    this.enteredMs = this.cleanSince = 0;
    this.probeEveryMs = 30000;
    this.probe = null;
  }

  private gridAt(ts: number): number {
    return Math.round((ts - this.anchorMs) / this.displayMs!);
  }

  private timeAt(grid: number): number {
    return this.anchorMs + grid * this.displayMs!;
  }

  private eligible(grid: number): boolean {
    return ((grid % this.k) + this.k) % this.k === 0;
  }

  private prune(ts: number): void {
    // Keep the entire active probe, including a confirmation callback after its boundary.
    const from = Math.min(
      ts - DOWN_STEP_WINDOW_MS,
      this.probe?.start ?? ts - DOWN_STEP_WINDOW_MS,
    );
    while (this.slots.length && this.slots[0].t < from) this.slots.shift();
  }

  private shares(from: number, until: number) {
    let total = 0;
    let missed = 0;
    let stale = 0;
    for (const s of this.slots) {
      if (s.t < from || s.t >= until) continue;
      total++;
      if (s.missed) missed++;
      if (s.stale) stale++;
    }
    return {
      missed,
      missedSlotShare: total ? missed / total : null,
      staleSlotShare: total ? stale / total : null,
    };
  }

  stats() {
    const ts = this.clock.now();
    this.prune(ts);
    const shares = this.shares(ts - 2000, ts + 0.00001);
    return {
      divisor: this.k,
      displayHz: this.displayMs === null ? null : 1000 / this.displayMs,
      capacityHz: this.capacityHz,
      missedSlotShare: shares.missedSlotShare,
      staleSlotShare: shares.staleSlotShare,
    };
  }

  /** Refit the lower envelope in grid coordinates so small display drift cannot accumulate. */
  private refit(ts: number): void {
    const grid = this.gridAt(ts);
    if (this.observations.at(-1)?.grid === grid) return;
    this.observations.push({ grid, ts });
    if (this.observations.length > 128) this.observations.shift();
    if (this.observations.length < 8) return;
    const first = this.observations[0];
    const intervals = this.observations
      .slice(1)
      .map(
        (o, i) =>
          (o.ts - this.observations[i].ts) /
          (o.grid - this.observations[i].grid),
      );
    const short = [...intervals].sort((a, b) => a - b)[
      Math.floor(intervals.length * 0.1)
    ];
    const near = intervals.filter(
      (dt) => Math.abs(dt - short) <= Math.min(2, short / 4),
    );
    const period = near.reduce((sum, dt) => sum + dt, 0) / near.length;
    // A discontinuity is not a new panel rate.
    if (
      !Number.isFinite(period) ||
      Math.abs(period / this.displayMs! - 1) > 0.1
    )
      return;
    const phase = Math.min(
      ...this.observations.map(
        (o) => o.ts - first.ts - (o.grid - first.grid) * period,
      ),
    );
    this.displayMs = period;
    this.anchorMs = first.ts + phase - first.grid * period;
  }

  private select(k: number, ts: number): void {
    this.k = k;
    this.enteredMs = this.cleanSince = ts;
  }

  private update(ts: number): void {
    if (this.capacityHz === null) {
      if (this.capacityStart === undefined || ts - this.capacityStart < 3000)
        return;
      const capacity = (this.callbacks * 1000) / (ts - this.capacityStart);
      if (capacity <= 0) return;
      this.capacityHz = capacity;
      this.select(
        Math.max(2, Math.ceil(1000 / this.displayMs! / (0.85 * capacity))),
        ts,
      );
      return;
    }
    if (this.probe) {
      const { from, start } = this.probe;
      if (ts - start < 4000) return;
      const share = this.shares(start, ts).missedSlotShare;
      if (share === null || share >= 0.02) {
        this.select(from, ts);
        this.probeEveryMs = Math.min(240000, this.probeEveryMs * 2);
      } else {
        this.enteredMs = this.cleanSince = ts;
        this.probeEveryMs = 30000;
      }
      this.probe = null;
      return;
    }
    const held = ts - this.enteredMs;
    if (held < 2000) return;
    // Inside 5 s of a selection only a broken choice steps down. After that, isolated misses
    // (a collection or compositor hiccup) are not capacity: require a sustained share AND count.
    const early = held < 5000;
    const window = this.shares(
      Math.max(this.enteredMs, ts - (early ? 2000 : DOWN_STEP_WINDOW_MS)),
      ts,
    );
    const share = window.missedSlotShare;
    if (
      share !== null &&
      (early
        ? share >= 0.2
        : share >= 0.05 && window.missed >= DOWN_STEP_MIN_MISSED)
    ) {
      this.select(this.k + 1, ts);
    } else if (
      this.k > 2 &&
      ts - this.cleanSince >= this.probeEveryMs &&
      this.eligible(this.gridAt(ts))
    ) {
      this.probe = { from: this.k, start: ts };
      this.select(this.k - 1, ts);
    }
  }

  /** One callback, whether or not content is available. Initial idle callbacks measure the
   * display; then every callback is eligible until capacity has been measured under draws. */
  presents(ts = this.clock.now()): boolean {
    const stalled =
      this.lastCallback !== undefined && ts - this.lastCallback > 100;
    this.lastCallback = ts;
    this.current = undefined;
    this.prune(ts);
    if (this.displayMs === null) {
      this.calibration.push(ts);
      if (ts - this.calibration[0] < 500) return false;
      const intervals = this.calibration
        .slice(1)
        .map((t, i) => t - this.calibration[i])
        .filter((dt) => dt > 0 && dt <= 100);
      if (!intervals.length) return false;
      const short = [...intervals].sort((a, b) => a - b)[
        Math.max(0, Math.ceil(intervals.length * 0.1) - 1)
      ];
      const near = intervals.filter(
        (dt) => Math.abs(dt - short) <= Math.min(2, short / 4),
      );
      this.displayMs = near.reduce((sum, dt) => sum + dt, 0) / near.length;
      this.anchorMs = ts;
      this.calibration = [];
    }
    if (stalled) {
      this.observations = [];
      if (
        this.capacityHz === null &&
        this.capacityStart !== undefined &&
        ts >= this.capacityStart
      ) {
        this.capacityStart = ts;
        this.callbacks = 0;
      }
    }
    if (
      this.capacityHz === null &&
      this.capacityStart !== undefined &&
      ts > this.capacityStart
    )
      this.callbacks++;
    this.refit(ts);
    const grid = this.gridAt(ts);
    const previousGrid = this.lastGrid;
    if (previousGrid >= 0 && !stalled) {
      for (let g = previousGrid + 1; g < grid; g++) {
        if (this.eligible(g)) {
          const slot = {
            t: this.timeAt(g),
            k: this.k,
            missed: true,
            stale: false,
          };
          this.slots.push(slot);
          if (this.onSlot) this.observe(slot);
          this.cleanSince = ts;
        }
      }
    }
    // Account elapsed slots under the divisor that governed them; changes govern this callback.
    this.update(ts);
    this.lastGrid = Math.max(grid, previousGrid);
    const eligible = grid > this.lastTaken && this.eligible(grid);
    if (grid > previousGrid && eligible) {
      this.current = {
        t: this.timeAt(grid),
        k: this.k,
        missed: false,
        stale: true,
      };
      this.slots.push(this.current);
    }
    if (eligible) this.lastTaken = grid;
    return eligible;
  }

  /** A successful draw starts settling/capacity measurement. Only a new transaction makes a
   * callback slot fresh; an animation or payload revisit does not hide a stale slot. */
  draw(ts = this.clock.now(), fresh = true): void {
    if (this.displayMs === null) return;
    this.capacityStart ??= ts + 2000;
    if (fresh && this.current) this.current.stale = false;
  }
}
