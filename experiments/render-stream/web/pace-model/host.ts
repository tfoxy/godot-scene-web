import { DrawHistory } from "./pacing";

export interface HostOptions {
  policy: "off" | "d1" | "d2" | "d3" | "cap" | "pacedOff" | "paced";
  capOffset?: number;
  oneWayMs: number;
  jitterMs: number;
  applyMs: number;
}

export interface HostClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export interface WantSeries {
  slotMs: number[];
  decisionMs: number[];
  frame: number[];
  fitNoiseMs: number[];
  arrivalDueMs: number[];
  arrivalMs: number[];
  arrivalWant: number[];
  unplannableSlotMs: number[];
  planningHorizonMs: number;
}

export interface HostSeries {
  seed: number;
  periodMs: number;
  tickMs: number[];
  decisionUndrawn: number[];
  sent: number[];
  sendMs: number[];
  /** Desired arrival times, indexed by send; actual arrivals can reorder. */
  arrivalDueMs: number[];
  arrivalMs: number[];
  /** Zero-based send index for each actual arrival. */
  arrivalSend: number[];
  rateMs: number[];
  rateHz: number[];
  decisionRateHz: number[];
  bucketAfter: number[];
  wants?: WantSeries;
}

/** Live host with delayed viewer state, including sent items still in flight. */
export class EmulatedHost {
  readonly series: HostSeries = {
    seed: 0x70616365,
    periodMs: (1000 / 60) * 1.0007,
    tickMs: [],
    decisionUndrawn: [],
    sent: [],
    sendMs: [],
    arrivalDueMs: [],
    arrivalMs: [],
    arrivalSend: [],
    rateMs: [],
    rateHz: [60],
    decisionRateHz: [],
    bucketAfter: [],
  };
  private random = this.series.seed;
  private fitRandom = this.series.seed ^ 0x77616e74;
  private plannedSlots = new Set<number>();
  private wants: number[] = [];
  private undrawn = 0;
  private arrived = 0;
  private newestArrivedMs = -Infinity;
  lastConsumedCaptureMs: number | null = null;
  private draws: DrawHistory;
  private rateCursor = 0;
  private bucket = 0;
  private historyMs: number[];
  private historyUndrawn = [0];
  private cursor = 0;
  private nextTick = 1;
  private timers = new Set<number>();

  constructor(
    private readonly options: HostOptions,
    private readonly startMs: number,
    private readonly clock: HostClock,
  ) {
    if (
      !["off", "d1", "d2", "d3", "cap", "pacedOff", "paced"].includes(
        options.policy,
      ) ||
      (options.policy === "cap" &&
        (!Number.isFinite(options.capOffset) || options.capOffset! < 0)) ||
      [options.oneWayMs, options.jitterMs, options.applyMs].some(
        (ms) => !Number.isFinite(ms) || ms < 0,
      )
    )
      throw new Error("pace-model: invalid host options");
    if (options.policy === "paced")
      this.series.wants = {
        slotMs: [],
        decisionMs: [],
        frame: [],
        fitNoiseMs: [],
        arrivalDueMs: [],
        arrivalMs: [],
        arrivalWant: [],
        unplannableSlotMs: [],
        planningHorizonMs: 0,
      };
    this.draws = new DrawHistory(startMs);
    this.series.rateMs.push(startMs);
    this.historyMs = [startMs];
    this.scheduleTick();
  }

  private at(dueMs: number, cb: () => void) {
    const id = this.clock.setTimeout(
      () => {
        this.timers.delete(id);
        // Timers may round down: never deliver an item before its due time.
        if (this.clock.now() < dueMs) this.at(dueMs, cb);
        else cb();
      },
      // Browser timers truncate fractional delays. Round up so an early fire
      // does not need a second short timeout subject to the nesting clamp.
      Math.max(0, Math.ceil(dueMs - this.clock.now())),
    );
    this.timers.add(id);
  }

  private scheduleTick() {
    this.at(this.startMs + this.nextTick * this.series.periodMs, () => {
      const x = this.clock.now();
      const cutoff = x - this.options.oneWayMs;
      while (
        this.cursor + 1 < this.historyMs.length &&
        this.historyMs[this.cursor + 1] <= cutoff
      )
        this.cursor++;
      const undrawn = this.historyUndrawn[this.cursor];
      while (
        this.rateCursor + 1 < this.series.rateMs.length &&
        this.series.rateMs[this.rateCursor + 1] <= cutoff
      )
        this.rateCursor++;
      const rate = this.series.rateHz[this.rateCursor];
      const limit = ["off", "pacedOff"].includes(this.options.policy)
        ? Infinity
        : Number(this.options.policy[1]);
      let send = undrawn < limit;
      if (this.options.policy === "cap") {
        this.bucket += (rate * this.series.periodMs) / 1000;
        send = this.bucket >= 1;
        if (send) this.bucket = Math.min(1, this.bucket - 1);
      }
      if (this.options.policy === "paced") {
        send = this.wants.some((frame) => frame <= this.nextTick);
        if (send)
          this.wants = this.wants.filter((frame) => frame > this.nextTick);
      }
      this.series.decisionRateHz.push(rate);
      this.series.bucketAfter.push(this.bucket);
      this.series.tickMs.push(x);
      this.series.decisionUndrawn.push(undrawn);
      this.series.sent.push(Number(send));
      if (send) {
        const index = this.series.sendMs.length;
        this.series.sendMs.push(x);
        this.undrawn++;
        this.record(x);
        // Mulberry32: identical seeds give identical per-send jitter samples.
        this.random = (this.random + 0x6d2b79f5) | 0;
        let r = Math.imul(this.random ^ (this.random >>> 15), 1 | this.random);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        const u = ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
        const due =
          x +
          this.options.oneWayMs +
          u * this.options.jitterMs +
          this.options.applyMs;
        this.series.arrivalDueMs.push(due);
        this.at(due, () => {
          this.arrived++;
          this.newestArrivedMs = Math.max(this.newestArrivedMs, x);
          this.series.arrivalMs.push(this.clock.now());
          this.series.arrivalSend.push(index);
        });
      }
      // Anchor to t0, including when a callback was dispatched late.
      this.nextTick++;
      this.scheduleTick();
    });
  }

  private record(nowMs: number) {
    this.historyMs.push(nowMs);
    this.historyUndrawn.push(this.undrawn);
  }

  private gaussian(): number {
    const uniform = () => {
      this.fitRandom = (this.fitRandom + 0x6d2b79f5) | 0;
      let r = Math.imul(
        this.fitRandom ^ (this.fitRandom >>> 15),
        1 | this.fitRandom,
      );
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return (((r ^ (r >>> 14)) >>> 0) + 0.5) / 0x100000000;
    };
    return (
      Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
    );
  }

  /** One noisy tick-clock fit per want; arrival at the host takes oneWayMs. */
  planWants(nowMs: number, slots: number[], planningHorizonMs: number) {
    const series = this.series.wants;
    if (!series) return;
    series.planningHorizonMs = planningHorizonMs;
    const margin =
      this.options.oneWayMs + this.options.jitterMs + this.options.applyMs + 1;
    for (const slot of slots) {
      if (this.plannedSlots.has(slot)) continue;
      this.plannedSlots.add(slot);
      const noise = this.gaussian();
      const frame = Math.floor(
        (slot - margin - this.startMs - noise) / this.series.periodMs,
      );
      const estimatedTick = this.startMs + frame * this.series.periodMs + noise;
      const decisionMs = Math.max(nowMs, this.clock.now());
      // Feasibility is the intersection of the send and arrival deadlines.
      // An earlier tick cannot fix an already missed want deadline.
      if (frame < 1 || decisionMs + this.options.oneWayMs > estimatedTick) {
        series.unplannableSlotMs.push(slot);
        continue;
      }
      const index = series.frame.length;
      series.slotMs.push(slot);
      series.decisionMs.push(decisionMs);
      series.frame.push(frame);
      series.fitNoiseMs.push(noise);
      const due = decisionMs + this.options.oneWayMs;
      series.arrivalDueMs.push(due);
      this.at(due, () => {
        this.wants.push(frame);
        series.arrivalMs.push(this.clock.now());
        series.arrivalWant.push(index);
      });
    }
  }

  observeCallback(ts: number, nowMs: number) {
    if (this.draws.advance(ts) && this.options.policy === "cap") {
      const maximum = this.draws.max();
      const rate =
        maximum === null
          ? 60
          : Math.min(60, maximum * (1 + this.options.capOffset!));
      if (rate !== this.series.rateHz[this.series.rateHz.length - 1]) {
        this.series.rateMs.push(nowMs);
        this.series.rateHz.push(rate);
      }
    }
  }

  recordDraw(ts: number) {
    this.draws.draw(ts);
  }

  consume(nowMs: number): number {
    const count = this.arrived;
    if (count) {
      this.arrived = 0;
      this.lastConsumedCaptureMs = this.newestArrivedMs;
      this.newestArrivedMs = -Infinity;
      this.undrawn -= count;
      this.record(nowMs);
    }
    return count;
  }

  stop() {
    for (const id of this.timers) this.clock.clearTimeout(id);
    this.timers.clear();
  }
}
