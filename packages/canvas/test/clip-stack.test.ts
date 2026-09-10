import { describe, expect, it } from "vitest";
import {
  createClipStack,
  createScissorBox,
  isAxisAligned,
} from "../src/clip-stack";
import { createClipRectView } from "../src/draw-list";

function clip(
  x: number,
  y: number,
  w: number,
  h: number,
  extras: { cornerRadius?: number; outsetX?: number } = {},
) {
  const view = createClipRectView();
  view.x = x;
  view.y = y;
  view.w = w;
  view.h = h;
  view.cornerRadius = extras.cornerRadius ?? 0;
  view.outsetX = extras.outsetX ?? 0;
  return view;
}

/** Design -> framebuffer at `scale`, no translation: what `./present` builds. */
function scaled(scale: number): Float32Array {
  return new Float32Array([scale, 0, 0, scale, 0, 0]);
}

const IDENTITY = scaled(1);

describe("clip stack bounds", () => {
  it("is empty until something is pushed", () => {
    const stack = createClipStack();
    expect(stack.depth).toBe(0);
    expect(stack.bounds()).toBeNull();
    expect(stack.rounded()).toBeNull();
  });

  it("intersects with the parent scope", () => {
    const stack = createClipStack();
    stack.push(clip(10, 10, 100, 100));
    stack.push(clip(50, 0, 100, 40));
    expect(stack.bounds()).toEqual({
      minX: 50,
      minY: 10,
      maxX: 110,
      maxY: 40,
    });
    stack.pop();
    expect(stack.bounds()).toEqual({
      minX: 10,
      minY: 10,
      maxX: 110,
      maxY: 110,
    });
  });

  it("keeps a disjoint intersection EMPTY rather than inverted", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 10, 10));
    stack.push(clip(100, 100, 10, 10));
    const bounds = stack.bounds();
    expect(bounds?.maxX).toBeGreaterThanOrEqual(bounds?.minX ?? 0);
    expect(bounds?.maxY).toBeGreaterThanOrEqual(bounds?.minY ?? 0);
    const box = stack.scissor(IDENTITY, 200, 200, createScissorBox());
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });

  it("widens ONLY x by outsetX, and does it before intersecting", () => {
    const stack = createClipStack();
    stack.push(clip(20, 20, 60, 60, { outsetX: 5 }));
    expect(stack.bounds()).toEqual({
      minX: 15,
      minY: 20,
      maxX: 85,
      maxY: 80,
    });
    // The parent's outset is already in its bounds, so a child clips against the
    // widened rect — which is the point: the slack exists so a re-laid-out child
    // that paints a little wide is not sheared.
    stack.push(clip(0, 0, 1000, 1000));
    expect(stack.bounds()?.minX).toBe(15);
  });

  it("bumps its epoch on every scope change", () => {
    const stack = createClipStack();
    const start = stack.epoch;
    stack.push(clip(0, 0, 10, 10));
    const afterPush = stack.epoch;
    expect(afterPush).not.toBe(start);
    stack.pop();
    expect(stack.epoch).not.toBe(afterPush);
  });

  it("refuses to pop an empty stack", () => {
    expect(() => createClipStack().pop()).toThrow(RangeError);
  });
});

describe("clip stack scissor", () => {
  it("is the whole framebuffer with nothing pushed", () => {
    const stack = createClipStack();
    expect(stack.scissor(IDENTITY, 800, 600, createScissorBox())).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("FLIPS Y: the box is measured from the bottom of the drawing buffer", () => {
    // A clip on the TOP 100 rows of a 600-tall buffer must produce y = 500, not
    // y = 0. Getting this wrong yields a correctly sized clip in the mirrored
    // place, which reads as a layout bug rather than a scissor bug.
    const stack = createClipStack();
    stack.push(clip(0, 0, 800, 100));
    expect(stack.scissor(IDENTITY, 800, 600, createScissorBox())).toEqual({
      x: 0,
      y: 500,
      width: 800,
      height: 100,
    });

    stack.pop();
    stack.push(clip(0, 500, 800, 100));
    expect(stack.scissor(IDENTITY, 800, 600, createScissorBox())).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 100,
    });
  });

  it("scales design units into framebuffer pixels", () => {
    const stack = createClipStack();
    stack.push(clip(100, 50, 200, 100));
    // Design 400x300 presented on an 800x600 buffer.
    expect(stack.scissor(scaled(2), 800, 600, createScissorBox())).toEqual({
      x: 200,
      y: 600 - 300,
      width: 400,
      height: 200,
    });
  });

  it("rounds OUTWARDS so a partially covered pixel survives", () => {
    const stack = createClipStack();
    stack.push(clip(10.4, 20.2, 5.3, 6.9));
    const box = stack.scissor(IDENTITY, 100, 100, createScissorBox());
    // x: floor(10.4) = 10 .. ceil(15.7) = 16
    expect(box.x).toBe(10);
    expect(box.width).toBe(6);
    // y: floor(20.2) = 20 .. ceil(27.1) = 28, flipped -> 100 - 28 = 72
    expect(box.y).toBe(72);
    expect(box.height).toBe(8);
  });

  it("integerizes ONCE, after intersecting, so nesting does not compound", () => {
    const stack = createClipStack();
    stack.push(clip(10.4, 0, 50, 10));
    stack.push(clip(10.6, 0, 50, 10));
    const box = stack.scissor(IDENTITY, 100, 100, createScissorBox());
    // The tighter left edge is 10.6; floor of the INTERSECTION is 10. Rounding at
    // each level and then intersecting would give max(floor(10.4), floor(10.6))
    // = 10 here too, but the two diverge as soon as a level rounds up — this
    // pins which order is in force.
    expect(box.x).toBe(10);
    expect(stack.bounds()?.minX).toBeCloseTo(10.6, 10);
  });

  it("clamps to the framebuffer", () => {
    const stack = createClipStack();
    stack.push(clip(-500, -500, 5000, 5000));
    expect(stack.scissor(IDENTITY, 800, 600, createScissorBox())).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });
});

describe("rounded clips", () => {
  it("exposes the INNERMOST rounded rect and inherits it through square scopes", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 200, 100, { cornerRadius: 12 }));
    expect(stack.rounded()).toEqual({
      centerX: 100,
      centerY: 50,
      halfWidth: 100,
      halfHeight: 50,
      radius: 12,
    });
    // A plain rect inside it does not cancel the rounding — the scissor handles
    // the plain rect and the fragment test stays on the rounded one.
    stack.push(clip(10, 10, 50, 50));
    expect(stack.rounded()?.radius).toBe(12);
    // A second rounded scope replaces it (only the innermost is honoured).
    stack.push(clip(20, 20, 40, 40, { cornerRadius: 4 }));
    expect(stack.rounded()).toEqual({
      centerX: 40,
      centerY: 40,
      halfWidth: 20,
      halfHeight: 20,
      radius: 4,
    });
    stack.pop();
    expect(stack.rounded()?.radius).toBe(12);
    stack.pop();
    stack.pop();
    expect(stack.rounded()).toBeNull();
  });

  it("clamps a radius past half the shorter side", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 40, 10, { cornerRadius: 999 }));
    expect(stack.rounded()?.radius).toBe(5);
  });

  it("follows the rect's OWN corners, outset included, not the intersection", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 20, 20));
    stack.push(clip(0, 0, 100, 100, { cornerRadius: 8, outsetX: 10 }));
    expect(stack.rounded()).toMatchObject({
      centerX: 50,
      halfWidth: 60,
      radius: 8,
    });
    // …while the SCISSOR is still the intersection.
    expect(stack.scissor(IDENTITY, 200, 200, createScissorBox())).toMatchObject(
      {
        width: 20,
        height: 20,
      },
    );
  });
});

describe("non-axis-aligned transforms", () => {
  it("recognises a pure scale + translate", () => {
    expect(isAxisAligned(new Float32Array([2, 0, 0, 3, 10, 20]))).toBe(true);
    expect(isAxisAligned(new Float32Array([2, 0.1, 0, 3, 0, 0]))).toBe(false);
  });

  it("clips to the AABB and counts the fallback", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 100, 50));
    // A quarter turn: the design rect maps to a framebuffer rect rotated 90
    // degrees, which a scissor box cannot be.
    const rotated = new Float32Array([0, 1, -1, 0, 200, 0]);
    const box = stack.scissor(rotated, 400, 400, createScissorBox());
    expect(stack.rotatedFallbacks).toBe(1);
    // Corners map to (200,0), (200,100), (150,100), (150,0): the AABB is
    // x 150..200, y 0..100 -> flipped y = 400 - 100 = 300.
    expect(box).toEqual({ x: 150, y: 300, width: 50, height: 100 });
  });

  it("counts nothing for the axis-aligned case, and resets per frame", () => {
    const stack = createClipStack();
    stack.push(clip(0, 0, 10, 10));
    stack.scissor(IDENTITY, 100, 100, createScissorBox());
    expect(stack.rotatedFallbacks).toBe(0);
    stack.scissor(
      new Float32Array([1, 0.5, 0, 1, 0, 0]),
      100,
      100,
      createScissorBox(),
    );
    expect(stack.rotatedFallbacks).toBe(1);
    stack.reset();
    expect(stack.rotatedFallbacks).toBe(0);
    expect(stack.depth).toBe(0);
  });
});
