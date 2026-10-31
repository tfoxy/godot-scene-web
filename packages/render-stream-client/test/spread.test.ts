// PRES-C: the spread module's generic math (results/p3/pres-c.md). The rules are tested as pure
// functions of `computeSpreadItem` -- no wasm, no extension host -- so the algebra is pinned before
// it is wired into the override table. Scene-identity re-centres stay out of these tests by design.

import { describe, expect, it } from "vitest";
import type { Affine2D, Rect } from "../src/extensions";
import {
  computeSpreadItem,
  containerHAlignFactor,
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
