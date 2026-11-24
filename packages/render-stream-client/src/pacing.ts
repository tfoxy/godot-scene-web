import type { CreditStage, LoopOptions } from "./loop";

/** Presets for the hello's credit stage and window, resolved separately for each connection. */
export type RenderStreamPacing = "fidelity" | "balanced" | "saver";

export function checkPacing(
  value: unknown,
): asserts value is RenderStreamPacing {
  if (value !== "fidelity" && value !== "balanced" && value !== "saver")
    throw new TypeError(
      'render-stream client: pacing must be "fidelity", "balanced" or "saver"',
    );
}

/** Resolve a preset using this connection's effective protocol and sticky balanced fallback. */
export function resolvePacing(
  pacing: RenderStreamPacing,
  protocol: number,
  fellBack: boolean,
): {
  creditWindow: NonNullable<LoopOptions["creditWindow"]>;
  creditStage: CreditStage;
} {
  if (pacing !== "balanced" || fellBack)
    return { creditWindow: protocol >= 18 ? 8 : 2, creditStage: "applied" };
  return { creditWindow: protocol >= 18 ? 3 : 2, creditStage: "submitted" };
}

/** Completed credit-return-to-transaction cycles kept by the balanced trial after the first drawn
 * frame. Skip cycles that overlap pending payload waits, deferred payloads or a busy fetcher:
 * start-up and payload fetches are not credit round-trip starvation. At long RTT, steady
 * streaming still fills the ring with starved cycles. */
export const PACING_TRIAL_CYCLES = 32;
/** Fall back only when the full ring's starved share is strictly greater than this. */
export const PACING_TRIP_SHARE = 0.5;

/** A cycle opens when submitted credit returns, and closes on the next transaction. A
 * presenting callback that began in the open cycle marks it starved. Idle content is one long
 * cycle, hence one sample: static stretches barely move the share; sparse content that trips
 * the trial loses nothing by returning to fidelity. The loop gates calls on the first drawn
 * frame and connection stage. */
export class PacingStarvationTracker {
  private readonly samples = new Uint8Array(PACING_TRIAL_CYCLES);
  private count = 0;
  private cursor = 0;
  private starved = 0;
  private open = false;
  private cycleStarved = false;
  private cycleSkipped = false;

  get isOpen(): boolean {
    return this.open;
  }
  get share(): number | null {
    return this.count === 0 ? null : this.starved / this.count;
  }

  reset(): void {
    this.samples.fill(0);
    this.count = this.cursor = this.starved = 0;
    this.open = this.cycleStarved = this.cycleSkipped = false;
  }

  creditReturned(): void {
    if (this.open) return;
    this.open = true;
    this.cycleStarved = this.cycleSkipped = false;
  }

  /** Any payload work while open excludes the entire cycle, even if it finishes before close. */
  payloadOutstanding(): void {
    if (this.open) this.cycleSkipped = true;
  }

  /** True only for a presentation whose callback began while this cycle was open. */
  frame(present: boolean): void {
    if (this.open && present) this.cycleStarved = true;
  }

  transaction(): boolean {
    if (!this.open) return false;
    this.open = false;
    if (this.cycleSkipped) return false;
    this.starved -= this.samples[this.cursor];
    const sample = this.cycleStarved ? 1 : 0;
    this.samples[this.cursor] = sample;
    this.starved += sample;
    this.cursor = (this.cursor + 1) % PACING_TRIAL_CYCLES;
    this.count = Math.min(this.count + 1, PACING_TRIAL_CYCLES);
    return (
      this.count === PACING_TRIAL_CYCLES &&
      this.starved / PACING_TRIAL_CYCLES > PACING_TRIP_SHARE
    );
  }
}
