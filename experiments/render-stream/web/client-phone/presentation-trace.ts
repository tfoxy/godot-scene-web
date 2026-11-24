import type { PacingObserver } from "../../../../packages/render-stream-client/src/loop";

interface SequenceRow {
  kind: "seq";
  connection: number;
  seq: number;
  frame: number;
  arrivalMs: number;
  presentMs: number | null;
}
interface SlotRow {
  kind: "slot";
  connection: number;
  t: number;
  k: number;
  eligible: true;
  missed: boolean;
  stale: boolean;
  fresh: boolean;
}
export type PresentationTrace = (SequenceRow | SlotRow)[];

/** Record the client's outcomes without scheduling work or returning a pacing decision. */
export function presentationTrace() {
  let connection = 0;
  const seqs = new Map<number, SequenceRow>();
  const rows: PresentationTrace = [];
  const observer: PacingObserver = {
    onTransaction(info) {
      const row: SequenceRow = {
        kind: "seq",
        connection,
        ...info,
        presentMs: null,
      };
      seqs.set(info.seq, row);
      rows.push(row);
    },
    onPresent(info) {
      for (const seq of info.seqs) {
        const row = seqs.get(seq);
        if (row) row.presentMs ??= info.tMs;
      }
    },
    onSlot(info) {
      rows.push({
        kind: "slot",
        connection,
        ...info,
        eligible: true,
        fresh: !info.missed && !info.stale,
      });
    },
  };
  return {
    observer,
    connection() {
      connection++;
      seqs.clear();
    },
    rows: (): PresentationTrace => rows.map((row) => ({ ...row })),
  };
}
