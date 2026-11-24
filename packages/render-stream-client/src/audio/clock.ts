/** Minimum-RTT media clock. Capture µs -> performance ms -> output context seconds. */
export class AudioClockEstimator {
  private offsetMs = 0;
  private bestRttMs = Number.POSITIVE_INFINITY;
  private pending = new Set<number>();
  reset(captureUs: number, receivedMs: number): void {
    this.offsetMs = captureUs / 1000 - receivedMs;
    this.bestRttMs = Number.POSITIVE_INFINITY;
    this.pending.clear();
  }
  request(c: number): void {
    this.pending.add(c);
  }
  reply(c: number, h: number, receivedMs: number): boolean {
    if (!this.pending.delete(c) || receivedMs < c) return false;
    const rtt = receivedMs - c;
    if (rtt < this.bestRttMs) {
      this.bestRttMs = rtt;
      this.offsetMs = h / 1000 - (c + receivedMs) / 2;
    }
    return true;
  }
  contextTime(
    captureUs: number,
    context: Pick<AudioContext, "currentTime" | "getOutputTimestamp">,
    nowMs: number,
  ): number {
    const stamp = context.getOutputTimestamp?.();
    const performanceMs = captureUs / 1000 - this.offsetMs;
    return stamp &&
      typeof stamp.contextTime === "number" &&
      typeof stamp.performanceTime === "number" &&
      (stamp.contextTime !== 0 || stamp.performanceTime !== 0)
      ? stamp.contextTime + (performanceMs - stamp.performanceTime) / 1000
      : context.currentTime + (performanceMs - nowMs) / 1000;
  }
  snapshot(): { offsetMs: number; rttMs: number | null } {
    return {
      offsetMs: this.offsetMs,
      rttMs: Number.isFinite(this.bestRttMs) ? this.bestRttMs : null,
    };
  }
}
