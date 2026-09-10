import { describe, expect, it } from "vitest";
import {
  expandPolyline,
  POLYLINE_QUAD_FLOATS,
  polylineQuadCapacity,
} from "../src/polyline";

interface Quad {
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  p3: [number, number];
}

function expand(points: number[], width: number): Quad[] {
  const out = new Float32Array(
    Math.max(1, polylineQuadCapacity(points.length / 2)) * POLYLINE_QUAD_FLOATS,
  );
  const count = expandPolyline(points, points.length / 2, width, out);
  const quads: Quad[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = i * POLYLINE_QUAD_FLOATS;
    quads.push({
      p0: [out[at], out[at + 1]],
      p1: [out[at + 2], out[at + 3]],
      p2: [out[at + 4], out[at + 5]],
      p3: [out[at + 6], out[at + 7]],
    });
  }
  return quads;
}

describe("polylineQuadCapacity", () => {
  it("is one quad per segment plus one per interior vertex", () => {
    expect(polylineQuadCapacity(0)).toBe(0);
    expect(polylineQuadCapacity(1)).toBe(0);
    expect(polylineQuadCapacity(2)).toBe(1);
    expect(polylineQuadCapacity(3)).toBe(3);
    expect(polylineQuadCapacity(10)).toBe(17);
  });
});

describe("expandPolyline", () => {
  it("turns one segment into one parallelogram offset by half the width", () => {
    const quads = expand([0, 0, 10, 0], 4);
    expect(quads).toHaveLength(1);
    // Left normal of (+x) is (0, +1) in the design frame, so the strip spans
    // y = ±2 around the segment and runs a -> b along the quad's x axis.
    expect(quads[0]).toEqual({
      p0: [0, 2],
      p1: [10, 2],
      p2: [10, -2],
      p3: [0, -2],
    });
  });

  it("emits a join wedge on the OUTSIDE of a turn", () => {
    // Right, then up: a left turn, whose notch opens on the right-hand side.
    const quads = expand([0, 0, 10, 0, 10, 10], 4);
    expect(quads).toHaveLength(3);
    const wedge = quads[1];
    expect(wedge.p0).toEqual([10, 0]);
    // Degenerate on purpose: p2 === p3 makes the quad a triangle (see the module
    // note), and the two offsets are on the -normal side of each segment.
    expect(wedge.p2).toEqual(wedge.p3);
    expect(wedge.p1).toEqual([10, -2]);
    expect(wedge.p2).toEqual([12, 0]);
  });

  it("puts the wedge on the other side for the opposite turn", () => {
    // Right, then down: the mirror of the case above, so the notch opens on the
    // +normal side. The two segments cover x<=10 and x in [8, 12] respectively,
    // leaving the square [10,12] x [0,2] uncovered; the wedge bevels it.
    const quads = expand([0, 0, 10, 0, 10, -10], 4);
    const wedge = quads[1];
    expect(wedge.p0).toEqual([10, 0]);
    expect(wedge.p1).toEqual([10, 2]);
    expect(wedge.p2).toEqual([12, 0]);
    expect(wedge.p2).toEqual(wedge.p3);
  });

  it("emits no wedge for a straight continuation", () => {
    // Collinear points: the two segments already meet edge to edge, and a wedge
    // would be a zero-area triangle drawn for nothing.
    const quads = expand([0, 0, 10, 0, 20, 0], 4);
    expect(quads).toHaveLength(2);
  });

  it("skips zero-length segments and the joins that would touch them", () => {
    const quads = expand([0, 0, 0, 0, 10, 0], 4);
    expect(quads).toHaveLength(1);
    expect(quads[0].p0).toEqual([0, 2]);
  });

  it("draws nothing for a degenerate stroke", () => {
    expect(expand([0, 0], 4)).toHaveLength(0);
    expect(expand([], 4)).toHaveLength(0);
    expect(expand([0, 0, 10, 0], 0)).toHaveLength(0);
    expect(expand([0, 0, 10, 0], -2)).toHaveLength(0);
  });

  it("writes from the caller's offset and reports how much it used", () => {
    const out = new Float32Array(4 * POLYLINE_QUAD_FLOATS);
    out.fill(-1);
    const written = expandPolyline(
      [0, 0, 10, 0],
      2,
      4,
      out,
      POLYLINE_QUAD_FLOATS,
    );
    expect(written).toBe(1);
    // The leading quad's slot is untouched.
    expect([...out.subarray(0, POLYLINE_QUAD_FLOATS)]).toEqual(
      new Array(POLYLINE_QUAD_FLOATS).fill(-1),
    );
    expect(out[POLYLINE_QUAD_FLOATS]).toBe(0);
    expect(out[POLYLINE_QUAD_FLOATS + 1]).toBe(2);
  });

  it("never writes past the capacity it advertises", () => {
    const points = [0, 0, 5, 5, 10, 0, 15, 5, 20, 0, 25, 5];
    const pointCount = points.length / 2;
    const capacity = polylineQuadCapacity(pointCount);
    const out = new Float32Array(capacity * POLYLINE_QUAD_FLOATS);
    const written = expandPolyline(points, pointCount, 3, out);
    expect(written).toBeLessThanOrEqual(capacity);
    // Every turn in this zig-zag is real, so the bound is tight here.
    expect(written).toBe(capacity);
  });
});
