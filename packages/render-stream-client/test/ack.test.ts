import { describe, expect, it } from "vitest";
import { type AckStage, AckWriter } from "../src/ack";

/** The ack object the loop used to build and `JSON.stringify` per ack: the bytes to keep. */
function reference(
  streamId: string,
  seq: number,
  stage: AckStage,
  at: number,
): string {
  return JSON.stringify({
    type: "ack",
    stream_id: streamId,
    seq,
    stage,
    t_us: Math.round(at * 1000),
  });
}

const STREAM_IDS = [
  "",
  "s-1",
  "0f3c9a2e-7b1d-4c8e-9a6f-2d5b8e1c4a70",
  'quote"back\\slash/',
  "ctl\n\t\r\b\f\u0000\u001f\u007f",
  "unié中\u{1f600}  ",
  "lone\ud800surrogate\udfff",
];
const SEQS = [0, 1, 2, 59, 1000, 2 ** 31 - 1, 2 ** 32 + 5, 2 ** 53 - 1, 1e21];
const STAGES: AckStage[] = ["received", "applied", "submitted"];
const TIMES = [
  0,
  -0,
  0.0004,
  0.0005,
  16.6667,
  1234.5678,
  1e9 + 0.25,
  1e18,
  -3.2,
];

describe("ack writer", () => {
  it("writes the bytes JSON.stringify writes for the old ack object", () => {
    const w = new AckWriter();
    for (const id of STREAM_IDS)
      for (const seq of SEQS)
        for (const stage of STAGES)
          for (const at of TIMES)
            expect(w.write(id, seq, stage, Math.round(at * 1000))).toBe(
              reference(id, seq, stage, at),
            );
  });

  it("rebuilds its prefix when the stream id changes back and forth", () => {
    const w = new AckWriter();
    const ids = ["a", "b", "a", "", 'x"y', "", "a"];
    for (const [i, id] of ids.entries())
      expect(w.write(id, i, "applied", i * 1000)).toBe(
        reference(id, i, "applied", i),
      );
  });

  it("writes non-finite numbers as JSON.stringify does (null)", () => {
    const w = new AckWriter();
    for (const n of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(w.write("s", n, "received", 5)).toBe(
        JSON.stringify({
          type: "ack",
          stream_id: "s",
          seq: n,
          stage: "received",
          t_us: 5,
        }),
      );
      expect(w.write("s", 3, "received", n)).toBe(
        JSON.stringify({
          type: "ack",
          stream_id: "s",
          seq: 3,
          stage: "received",
          t_us: n,
        }),
      );
    }
  });
});
