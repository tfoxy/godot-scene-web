// PRES-C: the spread module's generic math (results/p3/pres-c.md). The rules are tested as pure
// functions of `computeSpreadItem` -- no wasm, no extension host -- so the algebra is pinned before
// it is wired into the override table. Scene-identity re-centres stay out of these tests by design.

import { describe, expect, it } from "vitest";
import {
  type Affine2D,
  type ExtensionCore,
  type ExtensionFrame,
  ExtensionHost,
  type ItemQuery,
  type Rect,
} from "../src/extensions";
import {
  computeSpreadItem,
  containerHAlignFactor,
  createSpreadExtension,
  fieldDx,
  rootSpreadContext,
  type SpreadBudget,
  type SpreadDeps,
  type SpreadShape,
  spreadDelta,
} from "../src/spread";

const W = 1920;
const T = 2520;
const DELTA = spreadDelta(W, T); // 457.142857…
const ID: Affine2D = [1, 0, 0, 1, 0, 0];
const at = (x: number): Affine2D => [1, 0, 0, 1, x, 0];
const budget: SpreadBudget = {
  presentationWidth: W,
  targetWidth: T,
  delta: DELTA,
};
const noDeps: SpreadDeps = {};

describe("spreadDelta / fieldDx (the squeeze field)", () => {
  it("is zero at 16:9 and grows toward the target width", () => {
    expect(spreadDelta(W, W)).toBe(0);
    expect(spreadDelta(W, W - 1)).toBe(0); // below the presentation: no spread
    expect(spreadDelta(W, T)).toBeCloseTo(457.142857, 4);
  });

  it("shifts gameX by clamp(gameX, 0, W)·(1 − W/T)", () => {
    expect(fieldDx(W, T, 0)).toBe(0);
    expect(fieldDx(W, T, 960)).toBeCloseTo(228.571429, 4);
    expect(fieldDx(W, T, 1920)).toBeCloseTo(457.142857, 4);
    expect(fieldDx(W, T, 3000)).toBeCloseTo(457.142857, 4); // clamped
    expect(fieldDx(W, T, -10)).toBe(0); // clamped
    expect(fieldDx(W, W, 960)).toBe(0); // 16:9 is inert
  });

  it("reads BoxContainer alignment, null for non-boxes", () => {
    expect(containerHAlignFactor(null)).toBeNull();
    expect(containerHAlignFactor("hbox-begin")).toBe(0);
    expect(containerHAlignFactor("hbox-center")).toBe(0.5);
    expect(containerHAlignFactor("hbox-end")).toBe(1);
    expect(containerHAlignFactor("vbox-center")).toBe(0);
    expect(containerHAlignFactor("grid")).toBeNull();
  });
});

describe("computeSpreadItem: the generic rules", () => {
  const root = rootSpreadContext(W, T);

  it("anchored move: shift anchorLeft·Δ, widen by (aR−aL)·Δ", () => {
    const shape: SpreadShape = { anchorLeft: 0, anchorRight: 1 };
    const rect: Rect = { x: 0, y: 0, w: 400, h: 100 };
    const out = computeSpreadItem(1, root, shape, ID, rect, budget, noDeps);
    expect(out.dx).toBeCloseTo(0, 6); // 0/1 pins left
    expect(out.width).toBeCloseTo(400 + DELTA, 4); // widened
    expect(out.child.delta).toBeCloseTo(DELTA, 4); // handed down to children
    expect(out.child.parentDx).toBeCloseTo(0, 6);
  });

  it("anchored move: a 1/1 control hugs right by the whole budget", () => {
    const shape: SpreadShape = { anchorLeft: 1, anchorRight: 1 };
    const rect: Rect = { x: 0, y: 0, w: 400, h: 100 };
    const out = computeSpreadItem(2, root, shape, ID, rect, budget, noDeps);
    expect(out.dx).toBeCloseTo(DELTA, 4);
    expect(out.width).toBeUndefined(); // span 0: nothing to widen
  });

  it("anchored move: a 0.5/0.5 control re-centres on ½Δ", () => {
    const shape: SpreadShape = { anchorLeft: 0.5, anchorRight: 0.5 };
    const rect: Rect = { x: 0, y: 0, w: 400, h: 100 };
    const out = computeSpreadItem(3, root, shape, ID, rect, budget, noDeps);
    expect(out.dx).toBeCloseTo(0.5 * DELTA, 4);
  });

  it("full-canvas 0/0 art re-centres (the geometric exception)", () => {
    const shape: SpreadShape = { anchorLeft: 0, anchorRight: 0 };
    const rect: Rect = { x: 0, y: 0, w: W, h: 100 }; // spans the whole frame
    const out = computeSpreadItem(4, root, shape, ID, rect, budget, noDeps);
    expect(out.dx).toBeCloseTo(0.5 * DELTA, 4);
  });

  it("pass-through group: own origin claim, budget passed to each child", () => {
    const shape: SpreadShape = {}; // boxless positioner: no paint, no anchors
    const g = at(500);
    const out = computeSpreadItem(5, root, shape, g, null, budget, noDeps);
    expect(out.dx).toBeCloseTo(fieldDx(W, T, 500), 4);
    expect(out.child.delta).toBeCloseTo(DELTA, 4); // budget passes through
    expect(out.child.anchorDelta).toBe(0); // zero-size box: no anchor frame
    expect(out.child.parentDx).toBeCloseTo(root.parentDx, 6); // children claim for themselves
    expect(out.child.rideDx).toBeCloseTo(out.dx, 4);
  });

  it("positional claimer: own centre rides the field, budget consumed", () => {
    const shape: SpreadShape = {};
    const rect: Rect = { x: 960, y: 0, w: 100, h: 50 }; // centre at 1010
    const out = computeSpreadItem(
      6,
      root,
      shape,
      at(960),
      rect,
      budget,
      noDeps,
    );
    expect(out.dx).toBeCloseTo(fieldDx(W, T, 1010), 4);
    expect(out.child.delta).toBe(0); // consumed
    expect(out.child.parentDx).toBeCloseTo(out.dx, 4);
  });

  it("box child re-flows by alignment and does not run the anchor algebra", () => {
    const boxCtx = {
      ...root,
      containerAlign: 0.5,
    } as const;
    // A 0/0 child of a widened hbox-center: if it ran the anchor algebra it would strand at 0.
    const shape: SpreadShape = { anchorLeft: 0, anchorRight: 0 };
    const out = computeSpreadItem(7, boxCtx, shape, ID, null, budget, noDeps);
    expect(out.dx).toBeCloseTo(root.parentDx + 0.5 * DELTA, 4);
    expect(out.child.delta).toBe(0);
  });

  it("owner-anchored floater rides its owner's shift", () => {
    const shape: SpreadShape = { anchorOwnerId: 42 };
    const deps: SpreadDeps = {
      ownerShift: (ownerId, fallback) => (ownerId === 42 ? 123 : fallback),
    };
    const out = computeSpreadItem(8, root, shape, at(10), null, budget, deps);
    expect(out.dx).toBe(123);
    expect(out.width).toBeUndefined();
  });

  it("remote follower stays exact", () => {
    const deps: SpreadDeps = { followerShift: () => 77 };
    const out = computeSpreadItem(9, root, {}, at(10), null, budget, deps);
    expect(out.dx).toBe(77);
  });

  it("is inert at 16:9 for every branch", () => {
    const inert = { presentationWidth: W, targetWidth: W, delta: 0 };
    const cases: { shape: SpreadShape; rect: Rect | null; g: Affine2D }[] = [
      {
        shape: { anchorLeft: 0, anchorRight: 1 },
        rect: { x: 0, y: 0, w: 10, h: 10 },
        g: ID,
      },
      { shape: {}, rect: null, g: at(500) },
      { shape: {}, rect: { x: 960, y: 0, w: 100, h: 50 }, g: at(960) },
      { shape: { anchorOwnerId: 1 }, rect: null, g: ID },
    ];
    for (const [i, c] of cases.entries()) {
      const out = computeSpreadItem(i, root, c.shape, c.g, c.rect, inert, {
        ownerShift: () => 999,
        followerShift: () => 999,
      });
      expect(out.dx).toBe(0);
      expect(out.width).toBeUndefined();
    }
  });
});

// B4: the module through the real extension host. The override table composes an item's entry
// with every ancestor's, so the module must write each item's shift relative to its ancestors:
// `effective(id)` is the absolute shift the algebra answered.

interface Node {
  parent: number;
  x: number; // global origin x
  rect?: [number, number]; // own AABB x, w (y 0, h 10)
  shape: SpreadShape;
}

/** A scripted core over a small tree (ids are the keys; parent -1: a root). */
class TreeCore implements ExtensionCore {
  queries = 0;
  childQueries = 0;
  tables = 0;
  record = "";
  constructor(readonly nodes: Map<number, Node>) {}
  itemMetaJson(): string {
    return this.record;
  }
  setLogRemoved(): void {}
  takeRemoved(): Uint32Array {
    return new Uint32Array(0);
  }
  setOverrides(): void {
    this.tables++;
  }
  refreshOverrides(): number {
    return 2;
  }
  queryItem(id: number): ArrayLike<number> {
    this.queries++;
    const n = this.nodes.get(id);
    if (!n) return [];
    const r = n.rect;
    return Float64Array.from([
      n.parent,
      1,
      1,
      1,
      0,
      0,
      1,
      n.x,
      0,
      r ? 1 : 0,
      r ? r[0] : 0,
      0,
      r ? r[1] : 0,
      r ? 10 : 0,
    ]);
  }
  querySubtreeRect(): ArrayLike<number> {
    return [];
  }
  queryChildren(id: number): Uint32Array {
    this.childQueries++;
    const out: number[] = [];
    for (const [k, n] of this.nodes) if (n.parent === id) out.push(k);
    return Uint32Array.from(out);
  }
  hitTest(): number | null {
    return null;
  }
  setHitFilters(): void {}
  setPickOrder(): void {}
}

/** The tree: nested shifted panels (1 > 2 > 3, 10 > 11 > 12) and pass-through groups
 * (20 > {21, 22, 23 > 24}). */
function tree(): Map<number, Node> {
  return new Map<number, Node>([
    // A right-hugging panel and its anchored child: the child rides the panel's Δ (consumed).
    [
      1,
      {
        parent: -1,
        x: 0,
        rect: [0, 400],
        shape: { anchorLeft: 1, anchorRight: 1 },
      },
    ],
    [
      2,
      {
        parent: 1,
        x: 0,
        rect: [0, 100],
        shape: { anchorLeft: 1, anchorRight: 1 },
      },
    ],
    [3, { parent: 2, x: 0, rect: [0, 50], shape: {} }],
    // A half-stretched panel (½Δ, widens by ½Δ) whose right-hugging child adds its own ½Δ.
    [
      10,
      {
        parent: -1,
        x: 0,
        rect: [0, 400],
        shape: { anchorLeft: 0.5, anchorRight: 1 },
      },
    ],
    [
      11,
      {
        parent: 10,
        x: 0,
        rect: [0, 100],
        shape: { anchorLeft: 1, anchorRight: 1 },
      },
    ],
    [12, { parent: 11, x: 0, rect: [0, 50], shape: {} }],
    // A pass-through group at 500: a claimer child, a riding Control, and a nested group at 1500
    // whose claimer child sits at 200 (the field there is below the group's own claim).
    [20, { parent: -1, x: 500, shape: {} }],
    [21, { parent: 20, x: 960, rect: [960, 100], shape: {} }],
    [22, { parent: 20, x: 500, rect: [500, 40], shape: { isControl: true } }],
    [23, { parent: 20, x: 1500, shape: {} }],
    [24, { parent: 23, x: 150, rect: [150, 100], shape: {} }],
  ]);
}

function hostWith(nodes: Map<number, Node>, deps: SpreadDeps = {}) {
  const core = new TreeCore(nodes);
  const shapes = { calls: 0 };
  const spread = createSpreadExtension({
    presentationWidth: W,
    targetWidth: T,
    shape: (id) => {
      shapes.calls++;
      return nodes.get(id)?.shape ?? {};
    },
    deps,
  });
  const host = new ExtensionHost([spread]);
  host.bind(core);
  host.beginSession("s", "st");
  core.record = JSON.stringify({
    type: "item_meta",
    form: "full",
    grant: { fields: ["class"], groups: [], meta_keys: [] },
    strings_from: 0,
    strings: ["Control"],
    items: [...nodes.keys()].map((id) => [id, 0]),
  });
  host.itemMeta();
  return { core, host, shapes };
}

/** The absolute shifts the pure algebra answers, walked the module's way. */
function absolute(nodes: Map<number, Node>): Map<number, number> {
  const out = new Map<number, number>();
  const visit = (id: number, ctx: ReturnType<typeof rootSpreadContext>) => {
    const n = nodes.get(id) as Node;
    const rect: Rect | null = n.rect
      ? { x: n.rect[0], y: 0, w: n.rect[1], h: 10 }
      : null;
    const r = computeSpreadItem(id, ctx, n.shape, at(n.x), rect, budget, {});
    out.set(id, r.dx);
    for (const [k, c] of nodes) if (c.parent === id) visit(k, r.child);
  };
  for (const [k, n] of nodes)
    if (n.parent === -1) visit(k, rootSpreadContext(W, T));
  return out;
}

describe("createSpreadExtension through the extension host", () => {
  it("effective(id) is the absolute shift: nested panels and pass-through groups do not compound", () => {
    const nodes = tree();
    const { host } = hostWith(nodes);
    host.beforeDraw(1, 0);
    const want = absolute(nodes);
    // The hand values the algebra answers for this tree.
    expect(want.get(1)).toBeCloseTo(DELTA, 6);
    expect(want.get(2)).toBeCloseTo(DELTA, 6); // rides its panel, not 2Δ
    expect(want.get(3)).toBeCloseTo(DELTA, 6);
    expect(want.get(10)).toBeCloseTo(0.5 * DELTA, 6);
    expect(want.get(11)).toBeCloseTo(DELTA, 6); // ½Δ + 1·½Δ
    expect(want.get(12)).toBeCloseTo(DELTA, 6);
    expect(want.get(20)).toBeCloseTo(fieldDx(W, T, 500), 6);
    expect(want.get(21)).toBeCloseTo(fieldDx(W, T, 1010), 6);
    expect(want.get(22)).toBeCloseTo(fieldDx(W, T, 500), 6); // rides the group
    expect(want.get(23)).toBeCloseTo(fieldDx(W, T, 1500), 6);
    expect(want.get(24)).toBeCloseTo(fieldDx(W, T, 200), 6);
    for (const [id, dx] of want) {
      const e = host.overrides.effective(id);
      expect([id, e[4]]).toEqual([id, expect.closeTo(dx, 6)]);
      expect(e[5]).toBe(0);
    }
    // Only own shifts are entries: an item that rides its ancestors' shift writes nothing.
    expect(host.overrides.get(2)).toBeNull();
    expect(host.overrides.get(3)).toBeNull();
    expect(host.overrides.get(12)).toBeNull();
    expect(host.overrides.get(22)).toBeNull();
    expect(host.overrides.get(11)?.transform[4]).toBeCloseTo(0.5 * DELTA, 6);
    expect(host.overrides.get(24)?.transform[4]).toBeCloseTo(
      fieldDx(W, T, 200) - fieldDx(W, T, 1500),
      6,
    );
  });

  it("reads each item once per walk and skips a static frame entirely", () => {
    const nodes = tree();
    const { core, host, shapes } = hostWith(nodes);
    host.beforeDraw(1, 0); // the first walk also finds the roots (one parent read per id)
    expect(core.tables).toBe(1);
    core.queries = 0;
    core.childQueries = 0;
    shapes.calls = 0;
    host.beforeDraw(1, 16); // the same seq: no walk
    host.beforeDraw(null, 32); // a redraw: no walk
    expect([core.queries, core.childQueries, shapes.calls]).toEqual([0, 0, 0]);
    host.beforeDraw(2, 48); // a new transaction: one walk, one item read per item
    expect(core.queries).toBe(nodes.size);
    expect(core.childQueries).toBe(nodes.size);
    expect(shapes.calls).toBe(nodes.size);
    // Nothing moved: the unchanged values were not written, so nothing was copied.
    expect(core.tables).toBe(1);
  });

  it("an item moving back to its ancestors' shift clears its entry", () => {
    const nodes = tree();
    const { host } = hostWith(nodes);
    host.beforeDraw(1, 0);
    expect(host.overrides.get(21)).not.toBeNull();
    // The claimer moves under its group's origin: its own part is 0.
    (nodes.get(21) as Node).rect = [450, 100];
    host.beforeDraw(2, 16);
    expect(host.overrides.get(21)).toBeNull();
    expect(host.overrides.effective(21)[4]).toBeCloseTo(fieldDx(W, T, 500), 6);
  });

  it("a query without the raw read walks through the public calls with the same answer", () => {
    const nodes = tree();
    const { host } = hostWith(nodes);
    const spread = createSpreadExtension({
      presentationWidth: W,
      targetWidth: T,
      shape: (id) => nodes.get(id)?.shape ?? {},
    });
    const q = host.query;
    const plain: ItemQuery = {
      parent: (id) => q.parent(id),
      children: (id) => q.children(id),
      transform: (id) => q.transform(id),
      rect: (id) => q.rect(id),
      subtreeRect: (id) => q.subtreeRect(id),
      visible: (id) => q.visible(id),
      meta: (id) => q.meta(id),
      hitTest: (x, y) => q.hitTest(x, y),
    };
    spread.onItemMeta?.({
      form: "full",
      items: [...nodes.keys()].map((id) => ({
        id,
        node: true,
        groups: [],
        meta: {},
      })),
    });
    const frame: ExtensionFrame = {
      seq: 1,
      now: 0,
      overrides: host.overrides,
      query: plain,
      requestRedraw: () => {},
    };
    spread.beforeDraw?.(frame);
    for (const [id, dx] of absolute(nodes))
      expect(host.overrides.effective(id)[4]).toBeCloseTo(dx, 6);
  });
});
