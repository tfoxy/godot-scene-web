import { describe, expect, it } from "vitest";
import {
  HINT_LEAD_LOG_MAX,
  HintTable,
  type ResourceHintRecord,
} from "../src/hints";
import { harness, msg, session, tx } from "./fakes";

const hash = (n: number) => n.toString(16).padStart(64, "0");

function rec(n: number, priority = n): ResourceHintRecord {
  return {
    hash: hash(n),
    format: "RGBA8",
    sourceFormat: null,
    width: 4,
    height: 4,
    mipmaps: false,
    payloadBytes: 1000,
    variants: [],
    path: n % 2 === 0 ? `res://t${n}.png` : null,
    cause: "create",
    priority,
  };
}

function table(max?: number) {
  let t = 0;
  let frames = 0;
  const h = new HintTable(
    () => t,
    () => frames,
    max,
  );
  return {
    h,
    at: (ms: number) => {
      t = ms;
    },
    frame: (n = 1) => {
      frames += n;
    },
  };
}

describe("HintTable", () => {
  it("orders entries by ascending priority, then arrival", () => {
    const { h, at } = table();
    at(5);
    h.hint(rec(1, 7));
    h.hint(rec(2, 3));
    h.hint(rec(3, 7));
    h.hint(rec(4, 0));
    expect(h.entries().map((e) => e.hash)).toEqual([4, 2, 1, 3].map(hash));
    expect(h.entries()[0]).toEqual({
      hash: hash(4),
      meta: rec(4, 0),
      path: "res://t4.png",
      cause: "create",
      priority: 0,
      receivedAt: 5,
      state: "pending",
    });
    // The same frozen array until the table changes.
    expect(h.entries()).toBe(h.entries());
    expect(Object.isFrozen(h.entries())).toBe(true);
    const before = h.entries();
    h.markFetched(hash(2));
    expect(h.entries()).not.toBe(before);
  });

  it("removes on unhint and counts both records", () => {
    const { h } = table();
    h.hint(rec(1));
    h.hint(rec(2));
    expect(h.unhint(hash(1))).toBe(true);
    expect(h.unhint(hash(9))).toBe(false);
    expect(h.has(hash(1))).toBe(false);
    expect(h.has(hash(2))).toBe(true);
    expect(h.size).toBe(1);
    expect(h.pending).toBe(1);
    expect(h.totals).toMatchObject({ hintsReceived: 2, unhintsReceived: 2 });
  });

  it("tracks pending through fetched, referenced, held and late hints", () => {
    const { h } = table();
    h.hint(rec(1));
    h.hint(rec(2));
    h.hint(rec(3), true);
    h.hint(rec(4), false, true);
    expect(h.get(hash(3))?.state).toBe("fetched");
    expect(h.get(hash(4))?.state).toBe("referenced");
    expect(h.pending).toBe(2);
    h.markFetched(hash(1));
    h.markFetched(hash(1));
    expect(h.pending).toBe(1);
    h.referenced([hash(2)]);
    expect(h.pending).toBe(0);
    expect([...h.pendingInOrder()]).toEqual([]);
    expect(h.totals).toMatchObject({ hintsReferenced: 1, hintsLate: 1 });
    h.unhint(hash(1));
    expect(h.pending).toBe(0);
  });

  it("records each hint's first reference lead in ms and frames", () => {
    const { h, at, frame } = table();
    at(100);
    h.hint(rec(1));
    at(130);
    frame(2);
    h.hint(rec(2));
    at(150);
    frame(1);
    h.markFetched(hash(2));
    h.referenced([hash(1), hash(2), hash(9)]);
    at(400);
    h.referenced([hash(1)]);
    expect(h.totals).toMatchObject({
      hintsReferenced: 2,
      hintLeadMsMin: 20,
      hintLeadMsMax: 50,
    });
    expect(h.log()).toEqual([
      { hash: hash(1), leadMs: 50, leadFrames: 3 },
      { hash: hash(2), leadMs: 20, leadFrames: 1 },
    ]);
    expect(h.log()).toBe(h.log());
  });

  it("keeps the lead log to its last HINT_LEAD_LOG_MAX records", () => {
    const { h } = table();
    for (let i = 0; i < HINT_LEAD_LOG_MAX + 5; i++) {
      h.hint(rec(i));
      h.referenced([hash(i)]);
    }
    expect(h.log()).toHaveLength(HINT_LEAD_LOG_MAX);
    expect(h.log()[0].hash).toBe(hash(5));
  });

  it("drops the last entry in prefetch order past its bound, counting it", () => {
    const { h } = table(3);
    h.hint(rec(1, 5));
    h.hint(rec(2, 9));
    h.hint(rec(3, 1));
    h.hint(rec(4, 2));
    expect(h.entries().map((e) => e.hash)).toEqual([3, 4, 1].map(hash));
    // A newcomer that would come last is the one dropped.
    h.hint(rec(5, 9));
    expect(h.has(hash(5))).toBe(false);
    // At equal priority the later arrival goes.
    h.hint(rec(6, 5));
    expect(h.entries().map((e) => e.hash)).toEqual([3, 4, 1].map(hash));
    expect(h.totals.hintsDropped).toBe(3);
    expect(h.pending).toBe(3);
  });

  it("clears entries but keeps totals", () => {
    const { h } = table();
    h.hint(rec(1));
    h.clear();
    expect(h.size).toBe(0);
    expect(h.pending).toBe(0);
    expect(h.entries()).toEqual([]);
    expect(h.totals.hintsReceived).toBe(1);
  });
});

const hintMsg = (n: number, held = false, named = false) =>
  msg({ kind: "hint", hint: rec(n), held, named });

const AT13 = {
  url: "ws://127.0.0.1:1/render-stream",
  resourceBase: "http://127.0.0.1:1",
  token: null,
  protocol: 13,
} as const;

describe("the loop with resourceHints", () => {
  it("offers render-stream.15 and states it in the hello", () => {
    const h = harness(2, { resourceHints: true }, undefined, AT13);
    h.loop.connect();
    expect(h.last().subprotocol).toBe("render-stream.15");
    h.last().on.open();
    expect(h.last().sent[0]).toMatchObject({ protocol: "render-stream/15" });
  });

  it("without it: no hint stats, no table, no hintRefs call", () => {
    const h = harness(2, { applyOn: "frame" });
    h.loop.connect();
    expect(h.last().subprotocol).toBe("render-stream.12");
    h.last().on.open();
    h.last().on.message(session());
    h.last().on.message(tx(1));
    expect(h.loop.hints).toBeNull();
    expect(h.core.hintRefsCalls).toBe(0);
    const st = h.loop.stats();
    expect(Object.keys(st).filter((k) => k.startsWith("hint"))).toEqual([]);
    expect("unhintsReceived" in st).toBe(false);
  });

  it("keeps hints, learns references from transactions and clears on reconnect", () => {
    const h = harness(
      2,
      { applyOn: "frame", resourceHints: true },
      undefined,
      AT13,
    );
    h.loop.connect();
    const t = h.last();
    t.on.open();
    t.on.message(session());
    // No hint yet: a transaction asks no references.
    t.on.message(tx(1));
    expect(h.core.hintRefsCalls).toBe(0);
    t.on.message(hintMsg(1));
    t.on.message(hintMsg(2));
    t.on.message(hintMsg(3, true));
    t.on.message(msg({ kind: "unhint", hash: hash(2) }));
    // Hints are not transactions: no ack.
    expect(t.acks()).toEqual(["received 1"]);
    expect(h.loop.stats()).toMatchObject({
      hintsReceived: 3,
      unhintsReceived: 1,
      hintsPending: 1,
      hintsReferenced: 0,
      hintLeadMsMin: null,
    });
    h.clock.advance(40);
    h.core.refs = [hash(1)];
    t.on.message(tx(2));
    expect(h.core.hintRefsCalls).toBe(1);
    const st = h.loop.stats();
    expect(st).toMatchObject({
      hintsPending: 0,
      hintsReferenced: 1,
      hintLeadMsMin: 40,
      hintLeadMsMax: 40,
    });
    expect(st.hintLeadLog).toEqual([
      { hash: hash(1), leadMs: 40, leadFrames: 0 },
    ]);
    expect(h.loop.hints?.entries().map((e) => [e.hash, e.state])).toEqual([
      [hash(1), "referenced"],
      [hash(3), "fetched"],
    ]);
    // The connection ends: its hints end with it; the totals stay.
    t.on.close(1006, "gone");
    h.clock.frame();
    expect(h.loop.hints?.size).toBe(0);
    expect(h.loop.stats().hintsReceived).toBe(3);
  });
});
