/** The stages a transaction is acked at, in the order the loop sends them. */
export type AckStage = "received" | "applied" | "submitted";

// The text between the seq and the t_us value, per stage: the stage names need no JSON escaping.
const STAGE_MID: Record<AckStage, string> = {
  received: ',"stage":"received","t_us":',
  applied: ',"stage":"applied","t_us":',
  submitted: ',"stage":"submitted","t_us":',
};

/**
 * Writes ack messages as text without building an object or running `JSON.stringify` per ack.
 * The output is byte-identical to `JSON.stringify({type: "ack", stream_id, seq, stage, t_us})`:
 * the same key order, the stream id escaped once by `JSON.stringify` into a cached prefix that is
 * rebuilt when the stream id changes, and the numbers written as `JSON.stringify` writes them
 * (a non-finite number, which it writes as `null`, takes the slow path).
 */
export class AckWriter {
  private streamId = "";
  private prefix = '{"type":"ack","stream_id":"","seq":';

  /** `tUs` is the ack's `t_us` value, already rounded by the caller. */
  write(streamId: string, seq: number, stage: AckStage, tUs: number): string {
    if (!Number.isFinite(seq) || !Number.isFinite(tUs))
      return JSON.stringify({
        type: "ack",
        stream_id: streamId,
        seq,
        stage,
        t_us: tUs,
      });
    if (streamId !== this.streamId) {
      this.streamId = streamId;
      this.prefix = `{"type":"ack","stream_id":${JSON.stringify(streamId)},"seq":`;
    }
    // A finite number concatenates as `JSON.stringify` writes it (-0 included, as `0`).
    return `${this.prefix}${seq}${STAGE_MID[stage]}${tUs}}`;
  }
}
