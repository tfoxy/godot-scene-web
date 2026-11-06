// IN12 pointerTargetResolver: hit test, climb to a node identity (or a product's climb), local
// through the inverse of the drawn transform (override included), the drawn transaction as
// `frame`, and the pure-client fallbacks (no identity grant, no extension host).

import { describe, expect, it } from "vitest";
import {
  type Affine2D,
  ExtensionHost,
  IDENTITY,
  type ItemMeta,
  type ItemQuery,
} from "../src/extensions";
import {
  createRenderStreamClient,
  pointerTargetIdentity,
  pointerTargetResolver,
} from "../src/index";
import { coreItemQuery, resolverFor } from "../src/pointer-targets";
import { ENDPOINT, harness, session, tx } from "./fakes";

/** 1 (root) > 2 (card, at (100, 50), scale 2) > 3 (its label, hit in [100, 140) x [50, 70)). */
function query(metas: Record<number, ItemMeta> = {}): ItemQuery {
  const xf: Record<number, Affine2D> = {
    1: IDENTITY,
    2: [2, 0, 0, 2, 100, 50],
    3: [2, 0, 0, 2, 110, 54],
  };
  const parent: Record<number, number | null> = { 1: null, 2: 1, 3: 2 };
  return {
    parent: (id) => parent[id] ?? null,
    children: () => new Uint32Array(0),
    transform: (id) => xf[id] ?? null,
    rect: () => null,
    subtreeRect: () => null,
    visible: () => true,
    meta: (id) => metas[id] ?? null,
    hitTest: (x, y) => (x >= 100 && x < 140 && y >= 50 && y < 70 ? 3 : null),
  };
}

const card: ItemMeta = {
  id: 2,
  node: true,
  class: "Control",
  scene: "res://card.tscn",
  path: ".",
  groups: [],
  meta: {},
};
const quadrant: ItemMeta = { id: 3, node: false, groups: [], meta: {} };

function source(q: ItemQuery | null, effective: Affine2D = IDENTITY) {
  return {
    // CSS px = presentation px / 2 (a half-size canvas box)
    cssToPresentation: (x: number, y: number) =>
      x < 0 ? null : { x: x * 2, y: y * 2 },
    query: () => q,
    effective: (id: number) => (id === 2 ? effective : IDENTITY),
    drawnSeq: () => 1907,
  };
}

describe("pointerTargetResolver", () => {
  it("climbs to the first item with a node and inverts its drawn transform", () => {
    const resolve = resolverFor(source(query({ 2: card, 3: quadrant })));
    expect(resolve(60, 30)).toEqual({
      key: 2,
      identity: {
        item: 2,
        class: "Control",
        scene: "res://card.tscn",
        path: ".",
      },
      local: { x: 10, y: 5 },
      frame: 1907,
    });
  });

  it("measures local against the override the user saw", () => {
    // The card is drawn shifted 20 px right: the same drawn point is 10 local px further left.
    const resolve = resolverFor(
      source(query({ 2: card, 3: quadrant }), [1, 0, 0, 1, 20, 0]),
    );
    expect(resolve(60, 30)?.local).toEqual({ x: 0, y: 5 });
  });

  it("names only the item without an identity grant", () => {
    const resolve = resolverFor(source(query()));
    expect(resolve(60, 30)).toEqual({
      key: 3,
      identity: { item: 3 },
      local: { x: 5, y: 3 },
      frame: 1907,
    });
  });

  it("lets a product climb choose the ancestor, or no target", () => {
    const seen: number[] = [];
    const resolve = resolverFor(source(query({ 2: card, 3: quadrant })), {
      climb: (hit, q) => {
        seen.push(hit);
        return hit === 3 ? q.parent(q.parent(hit) ?? 0) : null;
      },
    });
    expect(resolve(60, 30)).toMatchObject({ key: 1, identity: { item: 1 } });
    expect(seen).toEqual([3]);
    const none = resolverFor(source(query()), { climb: () => null });
    expect(none(60, 30)).toBeNull();
  });

  it("is null on a bar, over clear colour, and before the core is up", () => {
    const resolve = resolverFor(source(query()));
    expect(resolve(-1, 30)).toBeNull();
    expect(resolve(0, 0)).toBeNull();
    expect(resolverFor(source(null))(60, 30)).toBeNull();
  });

  it("reads a bare core without an extension host", () => {
    const q = coreItemQuery(() => ({
      queryItem: (id: number) =>
        id === 3 ? [-1, 1, 1, 1, 0, 0, 1, 100, 50, 0, 0, 0, 0, 0] : [],
      queryChildren: () => new Uint32Array(0),
      querySubtreeRect: () => [],
      hitTest: () => 3,
    }));
    expect(q.parent(3)).toBeNull();
    expect(q.transform(3)).toEqual([1, 0, 0, 1, 100, 50]);
    expect(q.meta(3)).toBeNull();
    expect(resolverFor(source(q))(60, 30)).toEqual({
      key: 3,
      identity: { item: 3 },
      local: { x: 20, y: 10 },
      frame: 1907,
    });
  });

  it("refuses a non-client, and a fresh client resolves nothing before its core", () => {
    expect(() => pointerTargetResolver({} as never)).toThrow(TypeError);
    const canvas = document.createElement("canvas");
    const client = createRenderStreamClient({
      canvas,
      core: { glueUrl: "/g.js", wasmUrl: "/w.wasm" },
      endpoint: ENDPOINT,
    });
    expect(pointerTargetResolver(client)(10, 10)).toBeNull();
    client.dispose();
  });

  it("asks only the identity fields a declaration carries", () => {
    expect(pointerTargetIdentity()).toEqual({
      id: "pointer-target-identity",
      wants: { fields: ["class", "scene", "path"] },
    });
    expect(new ExtensionHost([pointerTargetIdentity()]).request).toEqual({
      fields: ["class", "scene", "path"],
      groups: [],
      meta_keys: [],
    });
  });
});

describe("the loop's drawn transaction", () => {
  it("follows the draws, and resets with a session", () => {
    const h = harness(2, { creditStage: "applied", applyOn: "frame" });
    h.loop.connect();
    const t = h.last();
    t.on.open();
    t.on.message(session(2));
    expect(h.loop.drawnSeq).toBeNull();
    t.on.message(tx(1));
    h.clock.frame();
    expect(h.loop.drawnSeq).toBe(1);
    t.on.message(tx(2));
    h.clock.frame();
    expect(h.loop.drawnSeq).toBe(2);
    t.on.message(session(2));
    expect(h.loop.drawnSeq).toBeNull();
  });
});
