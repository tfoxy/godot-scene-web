import { describe, expect, it } from "vitest";
import { createDrawList, createQuadView } from "../src/draw-list";
import {
  encodeRustRetainedPatch,
  encodeRustScene,
  RUST_RETAINED_TEXT_PATCH,
  type PixiTextRecord,
  type RustTextCarrier,
} from "../src/rust-prototype-scene";

/** A tiny scene: a background quad, a clock label inside group `g` and a static label beside it. */
function inputs(clock: { text: string; width: number }, group: readonly number[] = [1, 0, 0, 1, 10, 20],
  glyphs = false, name: { key: string; width: number } = { key: "text:name", width: 20 }) {
  const list = createDrawList<string>();
  const q = createQuadView();
  q.w = 64;
  q.h = 32;
  list.pushQuad(q, "bg");
  list.pushQuad(q, "bg");
  const texts: PixiTextRecord[] = [
    { key: "clock:0:0", insertionIndex: 1, transform: [1, 0, 0, 1, 15, 26], parentId: "g",
      localTransform: [1, 0, 0, 1, 5, 6] } as PixiTextRecord,
    { key: "name:0:0", insertionIndex: 2, transform: [1, 0, 0, 1, 1, 2] } as PixiTextRecord,
  ];
  const carriers = new Map<string, RustTextCarrier>([
    ["clock:0:0", glyphs ? {
      kind: "glyphs", method: "msdf", atlas: { key: "page", width: 64, height: 64 },
      glyphs: [...clock.text].map((_, i) => ({ src: [i * 8, 0, 8, 8], dst: [i * 6, 0, 6, 6] }) as const),
      transform: [1, 0, 0, 1, 2 + clock.width / 10, 3], fill: [1, 1, 1, 1], pxRange: 8,
    } : {
      resource: { key: `text:clock:${clock.text}`, width: clock.width, height: 8 },
      pixels: new Uint8Array(clock.width * 8 * 4), width: clock.width, height: 8,
      transform: [1, 0, 0, 1, 2 - clock.width / 2, 3],
    }],
    ["name:0:0", {
      resource: { key: name.key, width: name.width, height: 8 }, pixels: new Uint8Array(name.width * 8 * 4),
      width: name.width, height: 8, transform: [1, 0, 0, 1, 1, 2],
    }],
  ]);
  return {
    drawList: list, width: 128, height: 64, designWidth: 64, designHeight: 32,
    resolveTexture: (texture: string) => (texture === "bg" ? { key: "bg", width: 4, height: 4 } : null),
    texts, resolveText: (record: PixiTextRecord) => carriers.get(record.key) ?? null,
    plan: { primitives: [], groups: [{ id: "g", firstIndex: 1, endIndex: 2, transform: group }] },
    carriers,
  };
}
function full(revision: number, clock: { text: string; width: number }, group?: readonly number[], glyphs = false,
  name?: { key: string; width: number }) {
  return encodeRustScene({ ...inputs(clock, group, glyphs, name), revision });
}
function change(clock: { text: string; width: number }, glyphs = false) {
  const next = inputs(clock, undefined, glyphs);
  const record = { ...next.texts[0] };
  return { record, carrier: next.carriers.get("clock:0:0")! };
}
const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

describe("encodeRustRetainedPatch text changes", () => {
  it("advertises the capability", () => {
    expect(RUST_RETAINED_TEXT_PATCH).toBe(true);
  });

  it("replaces a raster label's key and quad with exactly what a full build emits", () => {
    const base = full(1, { text: "04:00", width: 30 });
    const patch = encodeRustRetainedPatch(base.scene, 2, [], [], undefined,
      { texts: [change({ text: "04:01", width: 28 })] });
    expect(patch).not.toBeNull();
    const expected = full(2, { text: "04:01", width: 28 }).scene;
    expect(patch!.scene).toEqual(expected);
    expect(patch!.resourcesChanged).toBe(true);
    expect(patch!.textUploads.map((upload) => upload.key)).toEqual(["text:clock:04:01"]);
    const wire = json(patch!.bytes);
    expect(wire.resources).toEqual(expected.resources);
    expect(wire.updates).toEqual([{ id: "tclock:0:0", command: expected.commands[1] }]);
    expect(patch!.changedIndexes).toEqual([1]);
  });

  it("composes with a group move in the same patch and stays exact over a chain", () => {
    const base = full(1, { text: "04:00", width: 30 });
    const moved = [1, 0, 0, 1, 12, 21] as const;
    const first = encodeRustRetainedPatch(base.scene, 2, [], [{ id: "g", transform: moved }], undefined,
      { texts: [change({ text: "04:01", width: 28 })] })!;
    expect(first.scene).toEqual(full(2, { text: "04:01", width: 28 }, moved).scene);
    const second = encodeRustRetainedPatch(first.scene, 3, [], [], undefined,
      { texts: [change({ text: "04:11", width: 26 })] })!;
    expect(second.scene).toEqual(full(3, { text: "04:11", width: 26 }, moved).scene);
    // A later plain group move re-poses the patched label from its new carrier.
    const third = encodeRustRetainedPatch(second.scene, 4, [], [{ id: "g", transform: [1, 0, 0, 1, 0, 0] }])!;
    expect(third.scene).toEqual(full(4, { text: "04:11", width: 26 }, [1, 0, 0, 1, 0, 0]).scene);
  });

  it("keeps an old key another label still draws, and orders the list as a full build does", () => {
    // The name label draws the clock's current raster too, so the swap must keep that key listed.
    const shared = { key: "text:clock:04:00", width: 30 };
    const base = full(1, { text: "04:00", width: 30 }, undefined, false, shared);
    expect(base.scene.resources.map((resource) => resource.key)).toEqual(["bg", "text:clock:04:00"]);
    const patch = encodeRustRetainedPatch(base.scene, 2, [], [], undefined,
      { texts: [change({ text: "04:01", width: 28 })] })!;
    const expected = full(2, { text: "04:01", width: 28 }, undefined, false, shared).scene;
    expect(patch.scene).toEqual(expected);
    expect(patch.scene.resources.map((resource) => resource.key)).toEqual(["bg", "text:clock:04:01", "text:clock:04:00"]);
    expect(patch.resourcesChanged).toBe(true);
    // Swapping back onto the key the name still draws drops the clock's own key and keeps the shared one.
    const back = encodeRustRetainedPatch(patch.scene, 3, [], [], undefined,
      { texts: [change({ text: "04:00", width: 30 })] })!;
    expect(back.scene).toEqual({ ...base.scene, revision: 3 });
    // An unchanged label keeps the very list object (no resource field on the wire).
    const kept = encodeRustRetainedPatch(base.scene, 2, [], [], undefined, { texts: [change({ text: "04:00", width: 30 })] })!;
    expect(kept.resourcesChanged).toBe(false);
    expect(kept.scene.resources).toBe(base.scene.resources);
    expect(json(kept.bytes).resources).toBeUndefined();
  });

  it("refuses a text change on a scene with no retained metadata", () => {
    const base = full(1, { text: "04:00", width: 30 });
    const copy = { ...base.scene, commands: base.scene.commands.slice() };
    expect(encodeRustRetainedPatch(copy, 2, [], [], undefined, { texts: [change({ text: "04:01", width: 28 })] }))
      .toBeNull();
  });

  it("matches a full build over a long tick chain through the in-place resource swap", () => {
    let scene = full(1, { text: "04:00", width: 30 }).scene;
    for (let tick = 1; tick < 40; tick++) {
      const text = `04:${String(tick).padStart(2, "0")}`, width = 26 + (tick % 5);
      const patch = encodeRustRetainedPatch(scene, tick + 1, [], [], undefined, { texts: [change({ text, width })] })!;
      expect(patch.scene).toEqual(full(tick + 1, { text, width }).scene);
      scene = patch.scene;
    }
  });

  it("swaps an MSDF glyph run on the same atlas without touching the resource list", () => {
    const base = full(1, { text: "04:00", width: 30 }, undefined, true);
    const patch = encodeRustRetainedPatch(base.scene, 2, [], [], undefined,
      { texts: [change({ text: "04:01", width: 28 }, true)] })!;
    expect(patch.scene).toEqual(full(2, { text: "04:01", width: 28 }, undefined, true).scene);
    expect(patch.resourcesChanged).toBe(false);
    expect(patch.textUploads).toEqual([]);
    expect(json(patch.bytes).resources).toBeUndefined();
  });

  it("refuses a method switch, a moved parent, an unknown label, or a label also updated by id", () => {
    const base = full(1, { text: "04:00", width: 30 });
    const tick = change({ text: "04:01", width: 28 });
    const encode = (texts: Parameters<typeof encodeRustRetainedPatch>[5], updates: Parameters<typeof encodeRustRetainedPatch>[2] = []) =>
      encodeRustRetainedPatch(base.scene, 2, updates, [], undefined, texts);
    expect(encode({ texts: [change({ text: "04:01", width: 28 }, true)] })).toBeNull();
    expect(encode({ texts: [{ ...tick, record: { ...tick.record, parentId: undefined } }] })).toBeNull();
    expect(encode({ texts: [{ ...tick, record: { ...tick.record, key: "nope:0:0" } }] })).toBeNull();
    expect(encode({ texts: [tick] }, [{ id: "tclock:0:0", command: base.scene.commands[1] }])).toBeNull();
    expect(encode({ texts: [{ ...tick, carrier: { ...tick.carrier, resource: { key: "bg", width: 28, height: 8 } } as RustTextCarrier }] }))
      .toBeNull();
  });
});
