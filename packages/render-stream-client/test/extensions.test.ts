// TAG2 (client-extensions-design.md §3): the extension API over the loop, against a scripted core.

import { describe, expect, it } from "vitest";
import type { CoreMessage } from "../src/core";
import {
  type Affine2D,
  type ExtensionCore,
  type ExtensionFrame,
  ExtensionHost,
  type ExtensionSession,
  type ItemMetaBatch,
  invertAffine,
  mergeWants,
  mulAffine,
  type RenderStreamExtension,
} from "../src/extensions";
import { clientHello } from "../src/hello";
import { ENDPOINT, FakeCore, harness, msg, session, tx } from "./fakes";

const E13 = { ...ENDPOINT, protocol: 13 as const };

/** A scripted core with the extension calls: records carry their JSON, queries a small tree
 * (1 > 2 > 3, item 2 at (10, 20)). */
class ExtCore extends FakeCore implements ExtensionCore {
  record = "";
  removed: number[] = [];
  logRemoved = false;
  tables: { ids: number[]; vals: number[] }[] = [];
  refreshes = 0;
  override receive(data: ArrayBuffer, sessionSeen: boolean): CoreMessage {
    const m = JSON.parse(new TextDecoder().decode(data)) as CoreMessage & {
      record?: unknown;
    };
    if (m.kind === "item_meta") this.record = JSON.stringify(m.record);
    return super.receive(data, sessionSeen);
  }
  override apply(seq: number): void {
    super.apply(seq);
  }
  itemMetaJson(): string {
    return this.record;
  }
  setLogRemoved(on: boolean): void {
    this.logRemoved = on;
  }
  takeRemoved(): Uint32Array {
    const r = Uint32Array.from(this.removed);
    this.removed = [];
    return r;
  }
  setOverrides(ids: Uint32Array, vals: Float32Array): void {
    this.calls.push(`overrides ${ids.length}`);
    this.tables.push({ ids: [...ids], vals: [...vals] });
  }
  refreshOverrides(): number {
    this.refreshes++;
    return 2;
  }
  queryItem(id: number): ArrayLike<number> {
    const parent = { 1: -1, 2: 1, 3: 2 }[id];
    if (parent === undefined) return [];
    const x = id >= 2 ? 10 : 0;
    const y = id >= 2 ? 20 : 0;
    return [parent, 1, 1, 1, 0, 0, 1, x, y, 1, x, y, 4, 4];
  }
  querySubtreeRect(): ArrayLike<number> {
    return [0, 0, 14, 24];
  }
  queryChildren(id: number): Uint32Array {
    return Uint32Array.from(id < 3 ? [id + 1] : []);
  }
}

const full = {
  type: "item_meta",
  form: "full",
  grant: { fields: ["scene", "path"], groups: ["a", "b"], meta_keys: ["k"] },
  strings_from: 0,
  strings: ["res://s.tscn", ".", "Label"],
  items: [[1, 0, 1, 3, null], [2, 0, 2, 1, 2], [3]],
};
const delta = {
  type: "item_meta",
  form: "delta",
  grant: null,
  strings_from: 3,
  strings: ["Art"],
  items: [[4, 0, 3, 2, null]],
};
const meta = (record: unknown) =>
  msg({ kind: "item_meta", record } as unknown as CoreMessage);

function setup(exts: RenderStreamExtension[]) {
  const core = new ExtCore();
  const ext = new ExtensionHost(exts);
  ext.bind(core);
  const h = harness(
    2,
    { creditStage: "applied", applyOn: "frame", ext },
    core,
    E13,
  );
  h.loop.connect();
  h.last().on.open();
  h.last().on.message(session(2));
  return { ...h, core, ext };
}

describe("render-stream client extensions (TAG2)", () => {
  it("the hello is the pure hello without a request, and carries the merged one last", () => {
    const facts = {
      protocol: 13 as const,
      creditWindow: 2 as const,
      token: null,
      backing: [640, 360] as [number, number],
      css: [640, 360] as [number, number],
      dprMilli: 1000,
      gpuFormats: "none",
    };
    const pure = JSON.stringify(clientHello(facts));
    expect(JSON.stringify(clientHello({ ...facts, itemMeta: null }))).toBe(
      pure,
    );
    // An extension list with no wants asks nothing: the loop's hello is the pure one.
    const h = setup([{ id: "draw-only", beforeDraw: () => {} }]);
    expect(JSON.stringify(h.last().sent[0])).toBe(
      JSON.stringify(clientHello({ ...facts, creditStage: "applied" })),
    );
    const merged = mergeWants([
      { id: "a", wants: { fields: ["path", "scene"], groups: ["x"] } },
      {
        id: "b",
        wants: { fields: ["class"], groups: ["y", "x"], metaKeys: ["k"] },
      },
      { id: "c" },
    ]);
    expect(merged).toEqual({
      fields: ["class", "scene", "path"],
      groups: ["x", "y"],
      meta_keys: ["k"],
    });
    const asked = setup([
      { id: "a", wants: { fields: ["scene"], groups: ["g"] } },
    ]);
    const hello = asked.last().sent[0];
    expect(Object.keys(hello).at(-1)).toBe("item_meta");
    expect(hello.item_meta).toEqual({
      fields: ["scene"],
      groups: ["g"],
      meta_keys: [],
    });
    expect(() =>
      clientHello({ ...facts, protocol: 12, itemMeta: merged }),
    ).toThrow(/13/);
  });

  it("receipt: onSession with the grant, rows resolved, deltas appended, groups shared", () => {
    const sessions: ExtensionSession[] = [];
    const batches: ItemMetaBatch[] = [];
    const h = setup([
      {
        id: "m",
        wants: {
          fields: ["scene", "path"],
          groups: ["a", "b"],
          metaKeys: ["k"],
        },
        onSession: (s) => sessions.push(s),
        onItemMeta: (b) => batches.push(b),
      },
    ]);
    const t = h.last();
    t.on.message(meta(full));
    expect(sessions).toMatchObject([
      {
        sessionId: "s",
        streamId: "st",
        itemMeta: {
          fields: ["scene", "path"],
          groups: ["a", "b"],
          metaKeys: ["k"],
        },
      },
    ]);
    expect(batches[0].form).toBe("full");
    expect(batches[0].items[0]).toEqual({
      id: 1,
      node: true,
      scene: "res://s.tscn",
      path: ".",
      groups: ["a", "b"],
      meta: { k: null },
    });
    expect(batches[0].items[1].meta).toEqual({ k: "Label" });
    expect(batches[0].items[1].groups).toEqual(["a"]);
    expect(batches[0].items[2]).toEqual({
      id: 3,
      node: false,
      groups: [],
      meta: {},
    });
    t.on.message(tx(1));
    t.on.message(meta(delta));
    expect(batches[1].items[0].path).toBe("Art");
    expect(h.ext.query.meta(4)?.groups).toEqual(["b"]);
    // One frozen array per group mask, shared by every row with that mask.
    t.on.message(tx(2));
    t.on.message(
      meta({
        ...delta,
        strings_from: 4,
        strings: [],
        items: [[5, 0, 3, 2, null]],
      }),
    );
    expect(h.ext.query.meta(5)?.groups).toBe(h.ext.query.meta(4)?.groups);
    expect(Object.isFrozen(batches[0].items[0].groups)).toBe(true);
    // No extra acks: a record is not a transaction.
    expect(t.acks()).toEqual(["received 1", "received 2"]);
  });

  it("a refused session announces itemMeta null at its first transaction", () => {
    const sessions: ExtensionSession[] = [];
    const h = setup([
      { id: "m", wants: { groups: ["g"] }, onSession: (s) => sessions.push(s) },
    ]);
    h.last().on.message(tx(1));
    h.last().on.message(tx(2));
    expect(sessions).toMatchObject([
      { sessionId: "s", streamId: "st", itemMeta: null },
    ]);
  });

  it("removals reach onItemsRemoved at apply and leave the tables", () => {
    const removed: number[][] = [];
    const h = setup([
      {
        id: "m",
        wants: {
          fields: ["scene", "path"],
          groups: ["a", "b"],
          metaKeys: ["k"],
        },
        onItemsRemoved: (ids) => removed.push([...ids]),
        beforeDraw: (f) => f.overrides.translate(2, 0, -5),
      },
    ]);
    expect(h.core.logRemoved).toBe(true);
    const t = h.last();
    t.on.message(meta(full));
    t.on.message(tx(1));
    h.clock.frame();
    expect(h.ext.overrides.size).toBe(1);
    h.core.removed = [2, 3];
    t.on.message(tx(2));
    h.clock.frame();
    expect(removed).toEqual([[2, 3]]);
    expect(h.ext.query.meta(2)).toBeNull();
    expect(h.ext.query.meta(1)).not.toBeNull();
  });

  it("beforeDraw runs before each draw; a dirty table is copied once, a clean one never", () => {
    const frames: (number | null)[] = [];
    let lift = -119;
    const h = setup([
      {
        id: "lift",
        beforeDraw: (f) => {
          frames.push(f.seq);
          f.overrides.translate(2, 0, lift);
        },
      },
    ]);
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    expect(frames).toEqual([1]);
    expect(h.core.calls.slice(-3)).toEqual([
      "apply 1",
      "overrides 1",
      "draw 1",
    ]);
    expect(h.core.tables[0]).toEqual({
      ids: [2],
      vals: [1, 0, 0, 1, 0, -119, 1, 1, 1, 1, 1],
    });
    t.on.message(tx(2));
    h.clock.frame();
    // The same values again: nothing copied.
    expect(h.core.tables).toHaveLength(1);
    lift = -100;
    t.on.message(tx(3));
    h.clock.frame();
    expect(h.core.tables).toHaveLength(2);
    expect(h.core.refreshes).toBe(2);
  });

  it("override-redraw: 20 animated frames redraw 20 times with no transaction and no ack", () => {
    let step = 0;
    const seqs: (number | null)[] = [];
    const h = setup([
      {
        id: "anim",
        beforeDraw: (f: ExtensionFrame) => {
          seqs.push(f.seq);
          if (step < 20) {
            step++;
            f.overrides.translate(2, 0, (-119 * step) / 20);
            f.requestRedraw();
          }
        },
      },
    ]);
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    const acks = t.acks().length;
    for (let k = 0; k < 25; k++) h.clock.frame();
    expect(h.ext.redraws).toBe(20);
    expect(seqs.filter((s) => s === null)).toHaveLength(20);
    expect(t.acks()).toHaveLength(acks);
    expect(h.core.calls.filter((c) => c === "draw 1")).toHaveLength(21);
    expect(h.core.tables.at(-1)?.vals[5]).toBe(-119);
  });

  it("a session's requestRedraw wakes the loop with no transaction", () => {
    let session: ExtensionSession | null = null;
    const seqs: (number | null)[] = [];
    const h = setup([
      {
        id: "w",
        onSession: (s) => (session = s),
        beforeDraw: (f) => seqs.push(f.seq),
      },
    ]);
    const t = h.last();
    t.on.message(tx(1));
    h.clock.frame();
    h.clock.frame();
    expect(seqs).toEqual([1]);
    (session as ExtensionSession | null)?.requestRedraw();
    h.clock.frame();
    h.clock.frame();
    expect(seqs).toEqual([1, null]);
    expect(h.ext.redraws).toBe(1);
  });

  it("a module's error is not the stream's", () => {
    const h = setup([
      {
        id: "bad",
        beforeDraw: () => {
          throw new Error("boom");
        },
      },
    ]);
    const err = console.error;
    console.error = () => {};
    try {
      h.last().on.message(tx(1));
      h.clock.frame();
    } finally {
      console.error = err;
    }
    expect(h.ext.errors).toBe(1);
    expect(h.last().acks()).toEqual(["received 1", "applied 1", "submitted 1"]);
  });

  it("the table: translate, scaleAbout, setGlobal and the effective composition", () => {
    const core = new ExtCore();
    const ext = new ExtensionHost([{ id: "x" }]);
    ext.bind(core);
    const o = ext.overrides;
    o.translate(1, 0, -10);
    o.scaleAbout(2, 2, 2, 10, 20);
    // E(3) = O(2) · O(1): nearest first.
    expect(o.effective(3)).toEqual(
      mulAffine([2, 0, 0, 2, -10, -20], [1, 0, 0, 1, 0, -10]),
    );
    // setGlobal draws item 3 at the given global transform through its ancestors' overrides.
    const want: Affine2D = [1, 0, 0, 1, 100, 50];
    o.setGlobal(3, want);
    const drawn = mulAffine(o.effective(3), ext.query.transform(3) as Affine2D);
    for (const [i, v] of drawn.entries()) expect(v).toBeCloseTo(want[i], 9);
    expect(mulAffine(invertAffine(want), want)).toEqual([1, 0, 0, 1, 0, 0]);
    o.set(1, { visible: false });
    expect(o.get(1)).toEqual({
      transform: [1, 0, 0, 1, 0, 0],
      modulate: [1, 1, 1, 1],
      visible: false,
    });
    expect(() => o.translate(1, Number.NaN, 0)).toThrow(/non-finite/);
    o.clearAll();
    expect(o.size).toBe(0);
  });
});
