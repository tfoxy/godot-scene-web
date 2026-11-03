import { describe, expect, it } from "vitest";
import { createRecorder } from "../src/recorder";
import { FakeCore, harness, session, tx } from "./fakes";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Connects, opens and delivers the session (as loop.test.ts's `streaming`). */
function streaming(
  window: 1 | 2 = 2,
  core: FakeCore = new FakeCore(),
  pacing: Parameters<typeof harness>[1] = {},
) {
  const h = harness(window, pacing, core);
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(window));
  return h;
}

describe("render-stream client recorder (REC1)", () => {
  it("exports the session and records in receipt order", () => {
    const r = createRecorder();
    expect(r.export().bytes).toBeNull();
    r.session(bytes("MAGIC+sess"));
    r.record(bytes("tx1"), "transaction", false, 1);
    r.record(bytes("res"), "resource", false, 0);
    r.record(bytes("tx2"), "transaction", false, 2);
    const out = r.export();
    expect(out.records).toBe(3);
    expect(out.fullSeq).toBe(0);
    expect(out.overflow).toBe(false);
    expect(new TextDecoder().decode(out.bytes as Uint8Array)).toBe(
      "MAGIC+sess" + "tx1" + "res" + "tx2",
    );
  });

  it("restarts the ring at a full transaction (drop-oldest at the full)", () => {
    const r = createRecorder();
    r.session(bytes("S"));
    r.record(bytes("d1"), "transaction", false, 1);
    r.record(bytes("d2"), "transaction", false, 2);
    r.record(bytes("FULL3"), "transaction", true, 3);
    r.record(bytes("d4"), "transaction", false, 4);
    const out = r.export();
    expect(new TextDecoder().decode(out.bytes as Uint8Array)).toBe(
      "S" + "FULL3" + "d4",
    );
    expect(out.fullSeq).toBe(3);
    // `records` is the cumulative capture count (d1, d2, FULL3, d4).
    expect(out.records).toBe(4);
  });

  it("stops recording once the bound is reached (recording stays valid)", () => {
    const r = createRecorder({ maxBytes: 8 });
    r.session(bytes("S"));
    r.record(bytes("d1"), "transaction", false, 1);
    r.record(bytes("d2"), "transaction", false, 2); // 2 + 2 + 2 = 6
    expect(r.active).toBe(true);
    r.record(bytes("d3"), "transaction", false, 3); // 8, fits
    r.record(bytes("d4"), "transaction", false, 4); // 10 > 8: stop
    expect(r.active).toBe(false);
    const out = r.export();
    expect(out.overflow).toBe(true);
    expect(new TextDecoder().decode(out.bytes as Uint8Array)).toBe(
      "S" + "d1" + "d2" + "d3",
    );
  });

  it("a full after an overflow restarts the ring and recording resumes", () => {
    const r = createRecorder({ maxBytes: 8 });
    r.session(bytes("S"));
    r.record(bytes("d1"), "transaction", false, 1);
    r.record(bytes("d2xxxxxx"), "transaction", false, 2); // 11 > 8: stop
    expect(r.active).toBe(false);
    r.record(bytes("d3"), "transaction", false, 3); // still stopped
    r.record(bytes("FULL4XXXXX"), "transaction", true, 4); // 11 > 8 even alone: still stopped
    expect(r.active).toBe(false);
    expect(new TextDecoder().decode(r.export().bytes as Uint8Array)).toBe(
      "S" + "d1",
    );
    r.record(bytes("F5"), "transaction", true, 5); // fits: the ring restarts here
    r.record(bytes("d6"), "transaction", false, 6);
    expect(r.active).toBe(true);
    const out = r.export();
    expect(out.overflow).toBe(false);
    expect(out.fullSeq).toBe(5);
    expect(new TextDecoder().decode(out.bytes as Uint8Array)).toBe(
      "S" + "F5" + "d6",
    );
  });

  it("a full keeps the records since the transaction before it (its item_meta), also after an overflow", () => {
    const r = createRecorder({ maxBytes: 12 });
    r.session(bytes("S"));
    r.record(bytes("d1"), "transaction", false, 1);
    r.record(bytes("M"), "item_meta", false, 0);
    r.record(bytes("R"), "resource", false, 0);
    r.record(bytes("F2"), "transaction", true, 2);
    expect(new TextDecoder().decode(r.export().bytes as Uint8Array)).toBe(
      "S" + "M" + "R" + "F2",
    );
    r.record(bytes("d3xxxxxxx"), "transaction", false, 3); // 14 > 12: stop
    expect(r.active).toBe(false);
    r.record(bytes("m"), "item_meta", false, 0); // the next full's item_meta, held aside
    r.record(bytes("F4"), "transaction", true, 4);
    const out = r.export();
    expect(out.overflow).toBe(false);
    expect(new TextDecoder().decode(out.bytes as Uint8Array)).toBe(
      "S" + "m" + "F4",
    );
  });

  it("the export's resources are a snapshot, not the live table", () => {
    const r = createRecorder();
    expect(r.export().resources.size).toBe(0);
    r.session(bytes("S"));
    r.resource("a", bytes("1"));
    const first = r.export().resources;
    r.resource("b", bytes("2"));
    expect([...first.keys()]).toEqual(["a"]);
    (first as Map<string, Uint8Array>).delete("a");
    expect([...r.export().resources.keys()]).toEqual(["a", "b"]);
  });

  it("keeps fetched payloads and drops the oldest past the resource bound", () => {
    const r = createRecorder({ maxResourceBytes: 10 });
    r.session(bytes("S"));
    r.resource("a", bytes("1111"));
    r.resource("b", bytes("2222"));
    r.resource("c", bytes("3333")); // 12 > 10: drop "a"
    const out = r.export();
    expect([...out.resources.keys()].sort()).toEqual(["b", "c"]);
    expect(out.resources.get("c")).toEqual(bytes("3333"));
    r.resource("b", bytes("22")); // replace without double-counting
    expect(r.export().resources.get("b")).toEqual(bytes("22"));
  });
});

describe("render-stream loop recorder hook (off is zero copies)", () => {
  it("the pure client never asks the core to copy a decoded record", () => {
    const core = new FakeCore();
    const h = streaming(2, core);
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    expect(core.calls).toContain("apply 1");
    // REC1: no recorder means `receive` is never asked for a copy.
    expect(core.copyDecoded).toBe(0);
  });

  it("a recorder gets the decoded session and records in receipt order", () => {
    const core = new FakeCore();
    const seen: {
      session: Uint8Array[];
      records: [Uint8Array, string, boolean, number][];
    } = {
      session: [],
      records: [],
    };
    const rec = {
      session: (b: Uint8Array) => seen.session.push(b),
      record: (b: Uint8Array, k: string, f: boolean, s: number) =>
        seen.records.push([b, k, f, s]),
      resource: () => {},
      export: () => ({
        bytes: null,
        resources: new Map(),
        records: 0,
        fullSeq: 0,
        overflow: false,
      }),
      bytes: 0,
      active: true,
    } as never;
    const h = streaming(2, core, { recorder: rec as never });
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    // The session and the transaction were both copied (asked of the core) and recorded.
    expect(core.copyDecoded).toBe(2);
    expect(seen.session).toHaveLength(1);
    expect(seen.records).toHaveLength(1);
    expect(seen.records[0][1]).toBe("transaction");
    expect(seen.records[0][2]).toBe(true); // tx(1) is a full (seq 1)
    expect(seen.records[0][3]).toBe(1);
  });
});
