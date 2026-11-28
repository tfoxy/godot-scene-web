// Adapted from sts2-couch-coop laneJitterBuffer.ts; copyright 2026 Tomás Fox, MIT.
export class LaneJitterBuffer {
  private epoch = -1;
  private next = 0;
  reset(): void {
    this.epoch = -1;
    this.next = 0;
  }
  /** The media clock supplies due time. Stale backlog is discarded instead of re-anchored late. */
  accept(
    epoch: number,
    index: number,
    dueContextTime: number,
    now: number,
    gap: boolean,
    target = 0.06,
    count = 1,
  ): { at: number; fade: boolean; newEpoch: boolean } | null {
    if (epoch < this.epoch || (epoch === this.epoch && index < this.next))
      return null;
    const newEpoch = epoch !== this.epoch;
    const fade = gap || newEpoch || index !== this.next;
    this.epoch = epoch;
    this.next = index + count;
    const at = dueContextTime + target;
    if (at < now) return null;
    return { at, fade, newEpoch };
  }
}
