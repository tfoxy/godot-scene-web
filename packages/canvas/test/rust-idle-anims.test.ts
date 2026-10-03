import { describe, expect, it } from "vitest";
import { createDrawList, createQuadView } from "../src/draw-list";
import {
  encodeRustIdleAnims,
  encodeRustRetainedPatch,
  encodeRustScene,
  type RustIdleSet,
  rustRetainedGroupMembers,
  rustRetainedTextPlacement,
} from "../src/rust-prototype-scene";

/** Two quads in a group, one ungrouped quad, and a text record with a padded raster carrier. */
function grouped() {
  const list = createDrawList<string>();
  const q = createQuadView();
  q.w = q.h = 4;
  q.m.set([1, 0, 0, 1, 3, 4]);
  list.pushQuad(q, "a");
  q.m.set([2, 0, 0, 2, 5, 6]);
  list.pushQuad(q, "b");
  q.m.set([1, 0, 0, 1, 40, 0]);
  list.pushQuad(q, "c");
  const record = {
    key: "label",
    insertionIndex: 3,
    transform: [1, 0, 0, 1, 50, 10],
  };
  return encodeRustScene({
    drawList: list,
    revision: 4,
    width: 64,
    height: 64,
    designWidth: 64,
    designHeight: 64,
    resolveTexture: (key) => ({ key, width: 4, height: 4 }),
    texts: [record],
    resolveText: () => ({
      resource: { key: "text:label", width: 8, height: 4 },
      pixels: new Uint8Array(128),
      width: 8,
      height: 4,
      transform: [1, 0, 0, 1, 48.5, 9],
    }),
    plan: {
      primitives: [
        { id: "pa", index: 0, parentId: "anim:root" },
        { id: "pb", index: 1, parentId: "anim:root" },
        { id: "pc", index: 2 },
      ],
      groups: [
        {
          id: "anim:root",
          firstIndex: 0,
          endIndex: 2,
          transform: [1, 0, 0, 1, 0, 0],
        },
      ],
    },
  }).scene;
}

describe("RIA1 idle animations", () => {
  it("encodes the documented little-endian layout and refuses non-finite values and bad indexes", () => {
    const set: RustIdleSet = {
      baseRevision: 2 ** 32 + 7,
      roots: [
        {
          curve: "bob",
          amplitudeRad: 0,
          amplitudePx: 10,
          baselineUpPx: 8,
          scaleFrom: 1,
          scaleTo: 1,
          pivotX: 1,
          pivotY: 2,
          originMs: 3,
          phaseMs: 4,
          periodMs: 2000,
          base: [1, 0, 0, 1, 0, 0],
          wire: null,
          outer: [1, 0, 0, 1, 0, 0],
          spreadDx: 0,
          inverse: [1, 0, 0, 1, 0, 0],
        },
      ],
      targets: [
        {
          commandIndex: 5,
          mode: "text",
          chain: [{ root: 0, offset: 1.5 }],
          reference: [1, 0, 0, 1, 9, 9],
        },
      ],
    };
    const bytes = encodeRustIdleAnims(set)!;
    expect(bytes.byteLength).toBe(24 + 304 + 12 + 16 + 144);
    const view = new DataView(bytes.buffer);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIA1");
    expect([1, 2, 3, 4, 5].map((i) => view.getUint32(i * 4, true))).toEqual([
      1, 7, 1, 1, 1,
    ]);
    expect(view.getUint32(24, true)).toBe(3); // bob
    expect(view.getUint32(28, true)).toBe(0); // no wire
    expect(view.getFloat64(32 + 8, true)).toBe(10); // amplitudePx
    expect(view.getFloat64(32 + 5 * 8, true)).toBe(1); // alphaFrom is always 1
    const target = 24 + 304;
    expect([0, 1, 2].map((i) => view.getUint32(target + i * 4, true))).toEqual([
      5, 2, 1,
    ]);
    expect(view.getFloat64(target + 20, true)).toBe(1.5);
    expect(
      encodeRustIdleAnims({
        ...set,
        roots: [{ ...set.roots[0], phaseMs: Number.NaN }],
      }),
    ).toBeNull();
    expect(
      encodeRustIdleAnims({
        ...set,
        targets: [{ ...set.targets[0], chain: [{ root: 1, offset: 0 }] }],
      }),
    ).toBeNull();
  });

  it("reports a group's members, its parent world and a text's carrier inset as a patch would place them", () => {
    const scene = grouped();
    const group = rustRetainedGroupMembers(scene, "anim:root")!;
    expect(group.parentWorld).toEqual([1, 0, 0, 1, 0, 0]);
    expect(group.members.map(({ id, index }) => [id, index])).toEqual([
      ["pa", 0],
      ["pb", 1],
    ]);
    expect(rustRetainedGroupMembers(scene, "missing")).toBeNull();
    const text = rustRetainedTextPlacement(scene, "tlabel")!;
    expect(text.parentWorld).toEqual([1, 0, 0, 1, 0, 0]);
    expect(text.inset).toEqual([1, 0, 0, 1, -1.5, -1]);
    // The placement composes exactly as a `localTransform` update does.
    const moved = [1, 0, 0, 1, 52.25, 13];
    const patch = encodeRustRetainedPatch(scene, 5, [
      {
        id: "tlabel",
        command: { ...scene.commands[text.index] },
        localTransform: moved,
      },
    ])!;
    const m = patch.scene.commands[text.index].m as number[];
    expect(m).toEqual([1, 0, 0, 1, 52.25 - 1.5, 13 - 1]);
    // A group transform re-places exactly its members: `(parentWorld · delta) · local`.
    const delta = [1, 0, 0, 1, 0.5, -2];
    const grouped2 = encodeRustRetainedPatch(
      scene,
      5,
      [],
      [{ id: "anim:root", transform: delta }],
    )!;
    expect(grouped2.changedIndexes.slice().sort()).toEqual([0, 1]);
    for (const member of group.members)
      expect(grouped2.scene.commands[member.index].m).toEqual([
        member.local[0],
        member.local[1],
        member.local[2],
        member.local[3],
        member.local[4] + 0.5,
        member.local[5] - 2,
      ]);
  });
});
