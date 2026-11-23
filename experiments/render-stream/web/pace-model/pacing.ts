/** Counts are relative to the run epoch; the current partial second is excluded. */
export class DrawHistory {
  private second = 0;
  private current = 0;
  private completed: number[] = [];

  constructor(private readonly startMs: number) {}

  advance(ts: number): boolean {
    const second = Math.max(0, Math.floor((ts - this.startMs) / 1000));
    let changed = false;
    while (this.second < second) {
      this.completed.push(this.current);
      if (this.completed.length > 5) this.completed.shift();
      this.current = 0;
      this.second++;
      changed = true;
    }
    return changed;
  }

  draw(ts: number) {
    this.advance(ts);
    this.current++;
  }

  max(): number | null {
    return this.completed.length < 5 ? null : Math.max(...this.completed);
  }
}

const PATTERNS = [
  { name: "1/1", n: 1, d: 1 },
  { name: "3/4", n: 3, d: 4 },
  { name: "2/3", n: 2, d: 3 },
  { name: "1/2", n: 1, d: 2 },
  { name: "1/3", n: 1, d: 3 },
] as const;

export interface PacingSeries {
  displayIntervalMs: number;
  anchorMs: number;
  patternMs: number[];
  pattern: string[];
  reason: string[];
  missedSlotMs: number[];
  takenSlotMs: number[];
  probes: {
    startMs: number;
    from: string;
    to: string;
    probeEveryMs: number;
    confirmMs: number | null;
    endMs: number | null;
    outcome: "pending" | "kept" | "reverted";
    probeMissedShare: number | null;
    confirmMissedShare: number | null;
  }[];
}

/** Presentation slots remain on the initial display grid across pattern changes. */
export class PresentationPacer {
  readonly series: PacingSeries;
  private index = 0;
  private lastGrid = -1;
  private lastTaken = -1;
  private history: DrawHistory;
  private fitted = false;
  private enteredMs: number;
  private probeEveryMs = 5000;
  private probe: {
    index: number;
    record: PacingSeries["probes"][number];
  } | null = null;

  constructor(
    startMs: number,
    private readonly anchorMs: number,
    private readonly displayMs: number,
  ) {
    if (!Number.isFinite(displayMs) || displayMs <= 0)
      throw new Error("pace-model: invalid display interval");
    this.history = new DrawHistory(startMs);
    this.enteredMs = startMs;
    this.series = {
      displayIntervalMs: displayMs,
      anchorMs,
      patternMs: [startMs],
      pattern: ["1/1"],
      reason: ["initial"],
      missedSlotMs: [],
      takenSlotMs: [],
      probes: [],
    };
  }

  private slot(grid: number): boolean {
    const { n, d } = PATTERNS[this.index];
    return ((grid % d) + d) % d < n;
  }

  private change(index: number, ts: number, reason: string) {
    if (index === this.index) return;
    this.index = index;
    this.series.patternMs.push(ts);
    this.series.pattern.push(PATTERNS[index].name);
    this.series.reason.push(reason);
    this.enteredMs = ts;
  }

  private missedShare(fromMs: number, untilMs: number): number | null {
    const count = (times: number[]) => {
      let n = 0;
      for (let i = times.length - 1; i >= 0 && times[i] >= fromMs; i--)
        if (times[i] < untilMs) n++;
      return n;
    };
    const missed = count(this.series.missedSlotMs);
    const slots = missed + count(this.series.takenSlotMs);
    return slots ? missed / slots : null;
  }

  private update(ts: number, completed: boolean) {
    // Only the first five completed seconds estimate the uncapped draw capacity.
    if (!this.fitted && completed) {
      const maximum = this.history.max();
      if (maximum === null) return;
      const sustainable = maximum * 0.97;
      const index = PATTERNS.findIndex(
        (p) => (1000 / this.displayMs) * (p.n / p.d) <= sustainable,
      );
      if (index < 0)
        throw new Error(
          "pace-model: sustainable rate below the minimum presentation pattern",
        );
      this.change(index, ts, "sustainable");
      this.fitted = true;
      return;
    }
    if (!this.fitted) return;

    if (this.probe) {
      const { index, record } = this.probe;
      const from = record.confirmMs ?? record.startMs;
      const duration = record.confirmMs === null ? 1000 : 2000;
      if (ts - from < duration) return;
      const share = this.missedShare(from, ts);
      if (record.confirmMs === null) record.probeMissedShare = share;
      else record.confirmMissedShare = share;
      if (share === null || share >= 0.02) {
        record.outcome = "reverted";
        record.endMs = ts;
        // A failed one-second probe is the exception to the normal two-second hold.
        this.change(index, ts, "probe-reverted");
        this.probeEveryMs = Math.min(40000, this.probeEveryMs * 2);
        this.probe = null;
      } else if (record.confirmMs === null) {
        record.confirmMs = ts;
      } else {
        record.outcome = "kept";
        record.endMs = ts;
        this.probeEveryMs = 5000;
        this.probe = null;
      }
      return;
    }

    const heldMs = ts - this.enteredMs;
    if (heldMs < 2000) return;
    const share = this.missedShare(ts - 2000, ts);
    if (share !== null && share >= 0.05 && this.index < PATTERNS.length - 1) {
      this.change(this.index + 1, ts, "missed-slots");
      this.probeEveryMs = 5000;
    } else if (
      this.index > 0 &&
      heldMs >= this.probeEveryMs &&
      share !== null &&
      share < 0.02
    ) {
      const record: PacingSeries["probes"][number] = {
        startMs: ts,
        from: PATTERNS[this.index].name,
        to: PATTERNS[this.index - 1].name,
        probeEveryMs: this.probeEveryMs,
        confirmMs: null,
        endMs: null,
        outcome: "pending",
        probeMissedShare: null,
        confirmMissedShare: null,
      };
      this.probe = { index: this.index, record };
      this.series.probes.push(record);
      this.change(this.index - 1, ts, "probe");
    }
  }

  callback(ts: number): boolean {
    const completed = this.history.advance(ts);
    // rAF timestamps have sub-millisecond serialization noise around the grid.
    const grid = Math.floor((ts - this.anchorMs) / this.displayMs + 0.001);
    // Account elapsed slots under the pattern that actually governed them.
    // Changes made at this callback apply only to current and future slots.
    if (this.lastGrid >= 0) {
      for (let g = this.lastGrid + 1; g < grid; g++) {
        if (!this.slot(g)) continue;
        const s = this.anchorMs + g * this.displayMs;
        this.series.missedSlotMs.push(s);
      }
    }
    this.update(ts, completed);
    this.lastGrid = Math.max(grid, this.lastGrid);
    const eligible = grid > this.lastTaken && this.slot(grid);
    if (eligible) {
      this.lastTaken = grid;
      this.series.takenSlotMs.push(this.anchorMs + grid * this.displayMs);
    }
    return eligible;
  }

  draw(ts: number) {
    this.history.draw(ts);
  }

  /** Include fully elapsed slots after the final callback, without a fake callback. */
  finish(endMs: number) {
    const expired = Math.floor((endMs - this.anchorMs) / this.displayMs) - 1;
    for (let grid = this.lastGrid + 1; grid <= expired; grid++)
      if (this.slot(grid))
        this.series.missedSlotMs.push(this.anchorMs + grid * this.displayMs);
    this.lastGrid = Math.max(this.lastGrid, expired);
  }

  futureSlots(fromMs: number, untilMs: number): number[] {
    const slots: number[] = [];
    const first = Math.floor((fromMs - this.anchorMs) / this.displayMs) + 1;
    const last = Math.floor((untilMs - this.anchorMs) / this.displayMs);
    for (let grid = first; grid <= last; grid++)
      if (this.slot(grid)) slots.push(this.anchorMs + grid * this.displayMs);
    return slots;
  }
}
