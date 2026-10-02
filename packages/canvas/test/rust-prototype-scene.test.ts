import { describe, expect, it, vi } from "vitest";
import {
  BLEND_SUB,
  createClipRectView,
  createDrawList,
  createNinePatchView,
  createQuadView,
} from "../src/draw-list";
import {
  encodeRustPatch,
  encodeRustResources,
  encodeRustResourceUpdates,
  encodeRustRetainedPatch,
  encodeRustScene,
  jsonEqual,
  rustSceneCommandIndex,
  type RustSceneSnapshot,
} from "../src/rust-prototype-scene";

describe("Rust prototype scene serializer", () => {
  it("defers full scene JSON encoding until the scene bytes are requested", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const encoded = encodeRustScene({
      drawList: createDrawList<string>(),
      revision: 1,
      width: 10,
      height: 10,
      designWidth: 10,
      designHeight: 10,
      resolveTexture: () => null,
    });
    expect(stringify).not.toHaveBeenCalled();
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual(
      encoded.scene,
    );
    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
  });

  it("keeps supported commands in order and reports omitted kinds", () => {
    const list = createDrawList<string>();
    const clip = createClipRectView();
    clip.w = 50;
    clip.h = 50;
    list.pushClipRect(clip);
    const q = createQuadView();
    q.w = 20;
    q.h = 30;
    list.pushQuad(q, "atlas");
    list.pushPolyline({
      points: new Float32Array([0, 0, 1, 1]),
      pointCount: 2,
      width: 1,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    });
    list.popClip();
    const encoded = encodeRustScene({
      drawList: list,
      revision: 3,
      width: 100,
      height: 100,
      designWidth: 100,
      designHeight: 100,
      resolveTexture: () => ({ key: "atlas", width: 64, height: 64 }),
    });
    const scene = JSON.parse(new TextDecoder().decode(encoded.bytes));
    expect(scene.commands.map((c: { kind: string }) => c.kind)).toEqual([
      "clipPush",
      "quad",
      "clipPop",
    ]);
    expect(encoded.unsupportedCommands).toBe(1);
    expect(encoded.omittedKinds).toEqual({ polyline: 1 });
    expect(scene.resources).toEqual([{ key: "atlas", width: 64, height: 64 }]);
  });
  it("flattens retained group transforms and omits fractional group alpha content", () => {
    const list = createDrawList<string>();
    const q = createQuadView();
    q.w = 4;
    q.h = 4;
    list.pushQuad(q);
    const plan = {
      primitives: [
        {
          id: "stable-q",
          index: 0,
          parentId: "g",
          localTransform: [1, 0, 0, 1, 5, 6],
        },
      ],
      groups: [
        {
          id: "g",
          firstIndex: 0,
          endIndex: 1,
          transform: [1, 0, 0, 1, 10, 20],
          alpha: 1,
        },
      ],
    };
    const options = {
      drawList: list,
      revision: 1,
      width: 50,
      height: 50,
      designWidth: 50,
      designHeight: 50,
      resolveTexture: () => null,
      plan,
    };
    const scene = JSON.parse(
      new TextDecoder().decode(encodeRustScene(options).bytes),
    );
    expect(scene.commands[0].id).toBe("stable-q");
    expect(scene.commands[0].m).toEqual([1, 0, 0, 1, 15, 26]);
    const alpha = encodeRustScene({
      ...options,
      plan: { ...plan, groups: [{ ...plan.groups[0], alpha: 0.5 }] },
    });
    expect(alpha.scene.commands).toEqual([]);
    expect(alpha.omittedKinds).toEqual({ unsupportedGroupAlpha: 1 });
    expect(
      encodeRustRetainedPatch(alpha.scene, 2, [
        { id: "stable-q", command: scene.commands[0] },
      ]),
    ).toBeNull();
  });
  it("omits an unsupported nested clip with its contents and keeps surrounding clips balanced", () => {
    const list = createDrawList<string>();
    const clip = createClipRectView();
    clip.w = clip.h = 20;
    const quad = createQuadView();
    quad.w = quad.h = 4;
    list.pushClipRect(clip);
    list.pushQuad(quad);
    list.pushClipRect(clip);
    list.pushQuad(quad);
    list.popClip();
    list.pushQuad(quad);
    list.popClip();
    const encoded = encodeRustScene({
      drawList: list,
      revision: 1,
      width: 50,
      height: 50,
      designWidth: 50,
      designHeight: 50,
      resolveTexture: () => null,
      plan: {
        primitives: [
          { id: "outer", index: 0 },
          { id: "before", index: 1 },
          { id: "inner", index: 2, parentId: "rotated" },
          { id: "hidden", index: 3 },
          { id: "inner-pop", index: 4 },
          { id: "after", index: 5 },
          { id: "outer-pop", index: 6 },
        ],
        groups: [
          {
            id: "rotated",
            firstIndex: 2,
            endIndex: 5,
            transform: [0, 1, -1, 0, 0, 0],
          },
        ],
      },
    });
    expect(encoded.scene.commands.map((command) => command.id)).toEqual([
      "outer",
      "before",
      "after",
      "outer-pop",
    ]);
    expect(encoded.omittedKinds).toEqual({ unsupportedTransformedClip: 3 });
    expect(
      encodeRustRetainedPatch(encoded.scene, 2, [
        { id: "hidden", command: encoded.scene.commands[1] },
      ]),
    ).toBeNull();
  });
  it("omits an unsupported blend while retaining adjacent supported quads", () => {
    const list = createDrawList<string>();
    const quad = createQuadView();
    quad.w = quad.h = 4;
    list.pushQuad(quad);
    quad.blend = BLEND_SUB;
    list.pushQuad(quad);
    quad.blend = 0;
    list.pushQuad(quad);
    const encoded = encodeRustScene({
      drawList: list,
      revision: 1,
      width: 50,
      height: 50,
      designWidth: 50,
      designHeight: 50,
      resolveTexture: () => null,
    });
    expect(encoded.scene.commands.map((command) => command.id)).toEqual([
      "c0",
      "c2",
    ]);
    expect(encoded.omittedKinds).toEqual({ unsupportedBlend: 1 });
  });
  it("serializes design and backing dimensions separately and premultiplies raster text alpha", () => {
    const list = createDrawList<string>();
    const encoded = encodeRustScene({
      drawList: list,
      revision: 7,
      width: 200,
      height: 100,
      designWidth: 100,
      designHeight: 100,
      resolveTexture: () => null,
      texts: [
        {
          key: "title",
          insertionIndex: 0,
          text: "Hi",
          transform: [1, 0, 0, 1, 10, 20],
          style: {},
          alpha: 0.5,
        },
      ],
      resolveText: () => ({
        resource: { key: "text-title", width: 2, height: 1 },
        pixels: new Uint8Array(8),
        width: 2,
        height: 1,
        transform: [1, 0, 0, 1, 10, 20],
      }),
    });
    const scene = JSON.parse(new TextDecoder().decode(encoded.bytes));
    expect([
      scene.version,
      scene.width,
      scene.height,
      scene.designWidth,
      scene.designHeight,
    ]).toEqual([2, 200, 100, 100, 100]);
    expect(scene.commands[0].kind).toBe("rasterText");
    expect(scene.commands[0].color).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
  it("keeps raster padding in a retained text parent transform", () => {
    const list = createDrawList<string>();
    const encoded = encodeRustScene({
      drawList: list,
      revision: 8,
      width: 200,
      height: 100,
      designWidth: 100,
      designHeight: 100,
      resolveTexture: () => null,
      texts: [
        {
          key: "padded",
          insertionIndex: 0,
          text: "Hi",
          transform: [1, 0, 0, 1, 15, 26],
          parentId: "g",
          localTransform: [1, 0, 0, 1, 5, 6],
          style: {},
        },
      ],
      plan: {
        primitives: [],
        groups: [
          {
            id: "g",
            firstIndex: 0,
            endIndex: 0,
            transform: [1, 0, 0, 1, 10, 20],
          },
        ],
      },
      resolveText: () => ({
        resource: { key: "padded", width: 2, height: 1 },
        pixels: new Uint8Array(8),
        width: 2,
        height: 1,
        transform: [1, 0, 0, 1, 3, 4],
      }),
    });
    const scene = JSON.parse(new TextDecoder().decode(encoded.bytes));
    expect(scene.commands[0].m).toEqual([1, 0, 0, 1, 13, 24]);
  });
  it("emits a generic atlas glyph run without Bitmap uploads", () => {
    const encoded = encodeRustScene({
      drawList: createDrawList<string>(),
      revision: 1,
      width: 64,
      height: 64,
      designWidth: 64,
      designHeight: 64,
      resolveTexture: () => null,
      texts: [
        {
          key: "run",
          insertionIndex: 0,
          text: "A",
          transform: [1, 0, 0, 1, 4, 5],
          style: {},
        },
      ],
      resolveText: () => ({
        kind: "glyphs",
        method: "msdf",
        atlas: { key: "page", width: 48, height: 48 },
        glyphs: [{ src: [0, 0, 24, 24], dst: [2, 3, 24, 24] }],
        transform: [1, 0, 0, 1, 4, 5],
        fill: [1, 0, 0, 1],
        outline: { color: [0, 0, 0, 1], width: 2 },
        shadow: { color: [0, 0, 0, 0.5], offset: [1, 2] },
        pxRange: 4,
      }),
    });
    expect(encoded.textUploads).toEqual([]);
    expect(encoded.resources).toEqual([{ key: "page", width: 48, height: 48 }]);
    expect(encoded.scene.commands[0]).toMatchObject({
      kind: "glyphRun",
      atlas: "page",
      method: "msdf",
      glyphs: [{ src: [0, 0, 24, 24], dst: [2, 3, 24, 24] }],
      m: [1, 0, 0, 1, 4, 5],
      pxRange: 4,
      alpha: 1,
    });
    const command = { ...encoded.scene.commands[0], alpha: 0.5 };
    const patch = encodeRustRetainedPatch(encoded.scene, 2, [
      { id: String(command.id), command },
    ]);
    expect(patch?.scene.commands[0]).toMatchObject({
      kind: "glyphRun",
      atlas: "page",
      alpha: 0.5,
    });
  });
  it("encodes RSR2 linear replacement, subrect and release without changing RSR1", () => {
    const old = encodeRustResources([
      { key: "x", width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect([...old.slice(0, 4)]).toEqual([82, 83, 82, 49]);
    const next = encodeRustResourceUpdates([
      {
        operation: "replace",
        key: "x",
        width: 2,
        height: 2,
        format: "linear",
        pixels: new Uint8Array(16),
      },
      {
        operation: "subrect",
        key: "x",
        width: 2,
        height: 2,
        format: "linear",
        x: 1,
        y: 0,
        regionWidth: 1,
        regionHeight: 1,
        pixels: new Uint8Array([1, 2, 3, 4]),
      },
      { operation: "release", key: "x" },
    ]);
    expect([...next.slice(0, 8)]).toEqual([82, 83, 82, 50, 3, 0, 0, 0]);
    const first = new DataView(next.buffer);
    expect([...next.slice(8, 12)]).toEqual([0, 1, 0, 0]);
    expect([
      first.getUint32(12, true),
      first.getUint32(16, true),
      first.getUint32(20, true),
      first.getUint32(36, true),
      first.getUint32(40, true),
    ]).toEqual([1, 2, 2, 2, 16]);
  });
  it("encodes an allocation with dimensions and format but no pixel payload", () => {
    const bytes = encodeRustResourceUpdates([
      {
        operation: "allocate",
        key: "atlas:g1",
        width: 1024,
        height: 1024,
        format: "linear",
      },
    ]);
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(8 + 36 + "atlas:g1".length);
    expect([...bytes.slice(8, 12)]).toEqual([3, 1, 0, 0]);
    expect(view.getUint32(16, true)).toBe(1024);
    expect(view.getUint32(20, true)).toBe(1024);
    expect(view.getUint32(40, true)).toBe(0);
    expect(() =>
      encodeRustResourceUpdates([
        {
          operation: "allocate",
          key: "bad",
          width: 0,
          height: 1,
          format: "linear",
        },
      ]),
    ).toThrow("invalid resource allocation");
  });
  it("packs resource bytes with stable little endian lengths", () => {
    const bytes = encodeRustResources([
      { key: "x", width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(Array.from(bytes)).toEqual([
      82, 83, 82, 49, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0,
      0, 120, 1, 2, 3, 4,
    ]);
  });
});

describe("Rust prototype patches", () => {
  it("expands a retained parent transform without serializing or comparing the full scene", () => {
    const list = createDrawList<string>();
    const q = createQuadView();
    q.w = 4;
    q.h = 4;
    list.pushQuad(q);
    const encoded = encodeRustScene({
      drawList: list,
      revision: 1,
      width: 10,
      height: 10,
      designWidth: 10,
      designHeight: 10,
      resolveTexture: () => null,
      plan: {
        groups: [
          {
            id: "g",
            firstIndex: 0,
            endIndex: 1,
            transform: [1, 0, 0, 1, 2, 3],
          },
        ],
        primitives: [
          {
            id: "q",
            index: 0,
            parentId: "g",
            localTransform: [1, 0, 0, 1, 4, 5],
          },
        ],
      },
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const result = encodeRustRetainedPatch(
      encoded.scene,
      2,
      [],
      [{ id: "g", transform: [1, 0, 0, 1, 8, 9] }],
    );
    expect(result?.scene.commands[0].m).toEqual([1, 0, 0, 1, 12, 14]);
    expect(JSON.parse(new TextDecoder().decode(result!.bytes)).updates).toEqual(
      [{ id: "q", command: result!.scene.commands[0] }],
    );
    expect(encoded.scene.commands[0].m).toEqual([1, 0, 0, 1, 6, 8]);
    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
    expect(
      encodeRustRetainedPatch(
        encoded.scene,
        2,
        [],
        [{ id: "unknown", transform: [1, 0, 0, 1, 0, 0] }],
      ),
    ).toBeNull();
  });
  it("composes simultaneous group, primitive, source, and text changes", () => {
    const list = createDrawList<string>();
    const q = createQuadView();
    q.w = 4;
    q.h = 4;
    list.pushQuad(q, "atlas");
    const base = encodeRustScene({
      drawList: list,
      revision: 1,
      width: 20,
      height: 20,
      designWidth: 20,
      designHeight: 20,
      resolveTexture: () => ({ key: "atlas", width: 4, height: 4 }),
      plan: {
        groups: [
          {
            id: "g",
            firstIndex: 0,
            endIndex: 1,
            transform: [1, 0, 0, 1, 2, 3],
          },
        ],
        primitives: [
          {
            id: "q",
            index: 0,
            parentId: "g",
            localTransform: [1, 0, 0, 1, 4, 5],
          },
        ],
      },
      texts: [
        {
          key: "t",
          insertionIndex: 1,
          text: "T",
          transform: [1, 0, 0, 1, 1, 2],
          style: {},
          parentId: "g",
        },
      ],
      resolveText: () => ({
        resource: { key: "text", width: 1, height: 1 },
        pixels: new Uint8Array(4),
        width: 1,
        height: 1,
        transform: [1, 0, 0, 1, -8, -7],
      }),
    });
    const command = {
      ...base.scene.commands[0],
      m: base.scene.commands[0].m,
      src: [1, 1, 2, 2],
    };
    const textCommand = base.scene.commands[1];
    const result = encodeRustRetainedPatch(
      base.scene,
      2,
      [
        { id: "q", command, localTransform: [1, 0, 0, 1, 7, 8] },
        { id: "tt", command: textCommand, localTransform: [1, 0, 0, 1, 4, 5] },
      ],
      [{ id: "g", transform: [1, 0, 0, 1, 8, 9] }],
    )!;
    expect(result.scene.commands[0].m).toEqual([1, 0, 0, 1, 15, 17]);
    expect(result.changedIndexes).toEqual([0, 1]);
    expect(result.scene.commands[0].src).toEqual([1, 1, 2, 2]);
    expect(result.scene.commands[1].m).toEqual([1, 0, 0, 1, 3, 5]);
    expect(
      JSON.parse(new TextDecoder().decode(result.bytes)).updates[1],
    ).toEqual({
      id: "tt",
      command: result.scene.commands[1],
    });
    expect(
      JSON.parse(new TextDecoder().decode(result.bytes)).updates.map(
        (u: { id: string }) => u.id,
      ),
    ).toEqual(["q", "tt"]);
    const next = encodeRustRetainedPatch(
      result.scene,
      3,
      [],
      [{ id: "g", transform: [1, 0, 0, 1, 10, 11] }],
    )!;
    expect(next.scene.commands[0].m).toEqual([1, 0, 0, 1, 17, 19]);
    expect(next.scene.commands[1].m).toEqual([1, 0, 0, 1, 5, 7]);
    expect(next.changedIndexes).toEqual([0, 1]);
    expect(
      encodeRustRetainedPatch(base.scene, 2, [
        {
          id: "q",
          command: { ...base.scene.commands[0], resource: "unadmitted" },
        },
      ]),
    ).toBeNull();
  });
  /** A clip under group `g` (clip, quad, pop), with an ungrouped quad after it, admitted at `transform`. */
  function clippedGroupScene(transform: readonly number[], revision = 1, clipX = 2) {
    const list = createDrawList<string>();
    const clip = createClipRectView();
    clip.x = clipX;
    clip.y = 3;
    clip.w = 10;
    clip.h = 12;
    clip.cornerRadius = 1.5;
    clip.outsetX = 0.5;
    list.pushClipRect(clip);
    const q = createQuadView();
    q.w = 4;
    q.h = 4;
    list.pushQuad(q);
    list.popClip();
    list.pushQuad(q);
    return encodeRustScene({
      drawList: list,
      revision,
      width: 40,
      height: 40,
      designWidth: 40,
      designHeight: 40,
      resolveTexture: () => null,
      plan: {
        groups: [{ id: "g", firstIndex: 0, endIndex: 3, transform }],
        primitives: [
          { id: "q", index: 1, parentId: "g" },
          { id: "after", index: 3 },
        ],
      },
    });
  }
  it("translates a clip with its group when the group moves by a pure translation", () => {
    const base = clippedGroupScene([2, 0, 0, 2, 1, 1]);
    const moved = [2, 0, 0, 2, 6, -3];
    const patch = encodeRustRetainedPatch(
      base.scene,
      2,
      [],
      [{ id: "g", transform: moved }],
    )!;
    expect(patch).not.toBeNull();
    // The same scene a full admission at the moved transform encodes, clip and quad alike.
    const full = clippedGroupScene(moved, 2).scene;
    expect(patch.scene.commands.map((command) => command.id)).toEqual(
      full.commands.map((command) => command.id),
    );
    patch.scene.commands.forEach((command, index) => {
      const expected = full.commands[index];
      for (const key of Object.keys(expected)) {
        const value = expected[key];
        if (Array.isArray(value))
          (value as number[]).forEach((n, i) =>
            expect((command[key] as number[])[i]).toBeCloseTo(n, 9),
          );
        else expect(command[key]).toEqual(value);
      }
    });
    const clip = patch.scene.commands[0];
    expect(clip.kind).toBe("clipPush");
    expect(clip.rect).toEqual([2 * 2 + 6, 2 * 3 - 3, 20, 24]);
    expect(clip.radius).toBe(3);
    expect(clip.outset).toBe(1);
    // The patch carries the clip and the grouped quad; the pop and the quad outside the group are untouched.
    const wire = JSON.parse(new TextDecoder().decode(patch.bytes));
    expect(
      wire.updates.map((update: { id: string }) => update.id).sort(),
    ).toEqual(["c0", "q"]);
    expect(patch.changedIndexes.slice().sort()).toEqual([0, 1]);
    // The candidate keeps the clip's parent, so a second move translates from the first.
    const again = encodeRustRetainedPatch(
      patch.scene,
      3,
      [],
      [{ id: "g", transform: [2, 0, 0, 2, 7, -3] }],
    )!;
    expect(again.scene.commands[0].rect).toEqual([11, 3, 20, 24]);
  });
  it("places a group-moved clip exactly as a full admission does, after every chained patch", () => {
    // clip.x 2.3 (float32 in the list): a placement from world differences, (x0 + 0.1) + (x - 0.1), is one ulp
    // off admission's 2.3 + x after the second step here.
    const base = clippedGroupScene([1, 0, 0, 1, 0.1, 0.2], 1, 2.3);
    let scene = base.scene;
    let x = 0.1;
    for (let step = 0; step < 50; step++) {
      x += 0.1;
      scene = encodeRustRetainedPatch(scene, scene.revision + 1, [], [
        { id: "g", transform: [1, 0, 0, 1, x, 0.2] },
      ])!.scene;
      // Bit for bit after every patch: the same multiply admission uses, never a running sum or a difference.
      const full = clippedGroupScene([1, 0, 0, 1, x, 0.2], scene.revision, 2.3).scene;
      expect([step, scene.commands[0]]).toEqual([step, full.commands[0]]);
    }
  });
  it("lets an explicit clip update win over its group's move in the same patch, and keeps it as the reference", () => {
    const base = clippedGroupScene([1, 0, 0, 1, 0, 0]);
    const clip = base.scene.commands[0];
    const patch = encodeRustRetainedPatch(
      base.scene,
      2,
      [{ id: "c0", command: { ...clip, rect: [40, 50, 10, 12] } }],
      [{ id: "g", transform: [1, 0, 0, 1, 5, 5] }],
    )!;
    expect(patch.scene.commands[0].rect).toEqual([40, 50, 10, 12]);
    // A later group move translates from the explicit placement, by the change since that patch only.
    const later = encodeRustRetainedPatch(patch.scene, 3, [], [
      { id: "g", transform: [1, 0, 0, 1, 7, 4] },
    ])!;
    expect(later.scene.commands[0].rect).toEqual([42, 49, 10, 12]);
  });
  it("falls back when an explicit clip update rides a group whose scale or rotation changes", () => {
    const base = clippedGroupScene([1, 0, 0, 1, 0, 0]);
    const clip = base.scene.commands[0];
    expect(
      encodeRustRetainedPatch(
        base.scene,
        2,
        [{ id: "c0", command: { ...clip, rect: [3, 4, 10, 12] } }],
        [{ id: "g", transform: [2, 0, 0, 2, 0, 0] }],
      ),
    ).toBeNull();
  });
  it("falls back when a retained group movement would scale or rotate a clip", () => {
    const base = clippedGroupScene([1, 0, 0, 1, 0, 0]);
    for (const transform of [
      [1, 0, 0, 1.5, 1, 1],
      [0, 1, -1, 0, 0, 0],
    ])
      expect(
        encodeRustRetainedPatch(base.scene, 2, [], [{ id: "g", transform }]),
      ).toBeNull();
  });
  it("translates a clip replaced by an update, and refuses any other clip change", () => {
    const base = clippedGroupScene([1, 0, 0, 1, 0, 0]);
    const clip = base.scene.commands[0];
    const moved = encodeRustRetainedPatch(base.scene, 2, [
      { id: "c0", command: { ...clip, rect: [5, -7, 10, 12] } },
    ])!;
    expect(moved.scene.commands[0]).toEqual({ ...clip, rect: [5, -7, 10, 12] });
    expect(JSON.parse(new TextDecoder().decode(moved.bytes)).updates).toEqual([
      { id: "c0", command: { ...clip, rect: [5, -7, 10, 12] } },
    ]);
    expect(moved.changedIndexes).toEqual([0]);
    for (const command of [
      { ...clip, rect: [5, -7, 11, 12] },
      { ...clip, rect: [5, -7, 10, 13] },
      { ...clip, radius: 2 },
      { ...clip, outset: 1 },
      { ...clip, rect: [Number.NaN, 0, 10, 12] },
      { ...clip, rect: [0, 0, 10] },
      { ...clip, id: "other" },
    ])
      expect(
        encodeRustRetainedPatch(base.scene, 2, [{ id: "c0", command }]),
      ).toBeNull();
    // A pop has nothing to translate; a quad replaced as a clip is a shape change.
    const pop = base.scene.commands[2];
    expect(
      encodeRustRetainedPatch(base.scene, 2, [{ id: String(pop.id), command: { ...pop } }]),
    ).toBeNull();
    expect(
      encodeRustRetainedPatch(base.scene, 2, [
        { id: "after", command: { ...clip, id: "after" } },
      ]),
    ).toBeNull();
  });
  it("batches same-kind updates and falls back on shape change", () => {
    const a = {
      version: 2,
      revision: 4,
      width: 10,
      height: 10,
      designWidth: 10,
      designHeight: 10,
      resources: [],
      commands: [
        { id: "x", kind: "quad", w: 2 },
        { id: "y", kind: "clipPop" },
      ],
    };
    const b = {
      ...a,
      revision: 5,
      commands: [{ id: "x", kind: "quad", w: 3 }, a.commands[1]],
    };
    expect(
      JSON.parse(new TextDecoder().decode(encodeRustPatch(a, b)!)),
    ).toEqual({
      version: 1,
      baseRevision: 4,
      revision: 5,
      updates: [{ id: "x", command: b.commands[0] }],
    });
    expect(
      encodeRustPatch(a, {
        ...b,
        commands: [{ id: "x", kind: "ninePatch", w: 3 }, a.commands[1]],
      }),
    ).toBeNull();
    expect(encodeRustPatch(a, { ...b, designWidth: 11 })).toBeNull();
  });
});

/** Deterministic PRNG so fuzz-style tests are reproducible across runs/CI. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JSON_PRIMITIVE_POOL: readonly unknown[] = [
  0,
  -0,
  1,
  -1,
  3.5,
  -3.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "",
  "x",
  "key with spaces",
  true,
  false,
  null,
  undefined,
  () => 1,
  Symbol("s"),
];
/** A random JSON-ish value: primitives (incl. NaN/-0/+-Inf/undefined/function/symbol) and nested arrays/objects. */
function randomJsonValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.45)
    return JSON_PRIMITIVE_POOL[Math.floor(rng() * JSON_PRIMITIVE_POOL.length)];
  if (r < 0.7) {
    const len = Math.floor(rng() * 4);
    return Array.from({ length: len }, () => randomJsonValue(rng, depth - 1));
  }
  const keyPool = ["a", "b", "c", "d"];
  const keyCount = Math.floor(rng() * keyPool.length) + 1;
  const obj: Record<string, unknown> = {};
  for (const key of keyPool.slice(0, keyCount))
    obj[key] = randomJsonValue(rng, depth - 1);
  return obj;
}
/** Same values as `value`, but with object keys shuffled and every container reallocated. */
function shuffledClone(rng: () => number, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffledClone(rng, v));
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out: Record<string, unknown> = {};
    for (const key of keys)
      out[key] = shuffledClone(rng, (value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

describe("jsonEqual", () => {
  it("matches JSON.stringify equality on randomized values: identical, shuffled-clone, and independent pairs", () => {
    const rng = mulberry32(1337);
    for (let i = 0; i < 500; i++) {
      const a = randomJsonValue(rng, 3);
      const mode = rng();
      const b =
        mode < 0.34
          ? a
          : mode < 0.67
            ? shuffledClone(rng, a)
            : randomJsonValue(rng, 3);
      expect(jsonEqual(a, b)).toBe(JSON.stringify(a) === JSON.stringify(b));
    }
  });

  it("matches JSON.stringify equality on explicit edge cases", () => {
    const cases: readonly [unknown, unknown][] = [
      [Number.NaN, Number.NaN],
      [Number.NaN, null],
      [-0, 0],
      [-0, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      [Number.POSITIVE_INFINITY, 1],
      [undefined, undefined],
      [undefined, null],
      [[undefined], [null]],
      [
        [1, undefined, 3],
        [1, null, 3],
      ],
      [{ a: undefined, b: 1 }, { b: 1 }],
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [
        { a: 1, b: 2 },
        { a: 1, b: 2 },
      ],
      [
        [1, 2, 3],
        [1, 2],
      ],
      [{ fn: () => 1 }, {}],
      [[() => 1], [null]],
      [Symbol("x"), Symbol("y")],
    ];
    for (const [a, b] of cases)
      expect(jsonEqual(a, b)).toBe(JSON.stringify(a) === JSON.stringify(b));
  });

  it("does not special-case toJSON — documented divergence, since no encoded command ever carries one", () => {
    const withToJSON = {
      toJSON: () => ({ a: 1 }),
    } as unknown as Record<string, unknown>;
    expect(jsonEqual(withToJSON, {})).toBe(true);
    expect(JSON.stringify(withToJSON) === JSON.stringify({})).toBe(false);
  });
});

/**
 * One fixed, valid structure exercising every `fast` path at once: nested
 * groups (`g-outer` > `g-inner`), two equal-size tie groups (`tie-a`/`tie-b`)
 * so `groupAt`'s tie-break is live, primitives with and without
 * `parentId`/`localTransform`, draw indices with NO plan entry at all (so
 * `groupAt` resolves the parent), a balanced clip, an ungrouped trailing
 * quad (exercises `world(undefined)`), and texts with and without a parent.
 * Field VALUES are randomized per call; the STRUCTURE stays valid so every
 * call is a legal scene regardless of seed.
 */
function buildScenario(rng: () => number) {
  const list = createDrawList<string>();
  const randQuad = () => {
    const v = createQuadView();
    v.w = 1 + rng() * 40;
    v.h = 1 + rng() * 40;
    v.srcX = rng() * 10;
    v.srcY = rng() * 10;
    v.srcW = 1 + rng() * 10;
    v.srcH = 1 + rng() * 10;
    v.r = rng();
    v.g = rng();
    v.b = rng();
    v.a = rng();
    v.blend = Math.floor(rng() * 4); // includes unsupported blend modes
    v.flipH = rng() < 0.5;
    v.flipV = rng() < 0.5;
    v.hasColorMatrix = rng() < 0.3;
    v.colorMatrix = Float32Array.from({ length: 9 }, () => rng() * 2 - 1);
    v.m = Float32Array.from({ length: 6 }, () => rng() * 20 - 10);
    return v;
  };
  list.pushQuad(randQuad(), rng() < 0.5 ? "atlas" : undefined); // 0
  list.pushQuad(randQuad()); // 1
  const clip = createClipRectView();
  clip.x = rng() * 5;
  clip.y = rng() * 5;
  clip.w = 5 + rng() * 20;
  clip.h = 5 + rng() * 20;
  clip.cornerRadius = rng() * 3;
  clip.outsetX = rng() * 2;
  list.pushClipRect(clip); // 2
  list.pushQuad(randQuad()); // 3
  list.pushQuad(randQuad(), rng() < 0.5 ? "atlas" : undefined); // 4
  const ninePatch = { ...createNinePatchView(), ...randQuad() };
  ninePatch.marginLeft = rng() * 4;
  ninePatch.marginTop = rng() * 4;
  ninePatch.marginRight = rng() * 4;
  ninePatch.marginBottom = rng() * 4;
  list.pushNinePatch(ninePatch); // 5
  list.popClip(); // 6
  list.pushQuad(randQuad()); // 7

  const randMatrix = () =>
    Array.from({ length: 6 }, () => rng() * 20 - 10) as number[];
  const plan = {
    primitives: [
      { id: "p0", index: 0, parentId: "g-inner", localTransform: randMatrix() },
      { id: "p1", index: 1, parentId: "g-inner" },
      { id: "p2", index: 2, parentId: "g-inner" },
    ],
    groups: [
      { id: "g-outer", firstIndex: 0, endIndex: 7, transform: randMatrix() },
      {
        id: "g-inner",
        firstIndex: 1,
        endIndex: 4,
        parentId: "g-outer",
        transform: randMatrix(),
      },
      { id: "tie-a", firstIndex: 4, endIndex: 6, transform: randMatrix() },
      { id: "tie-b", firstIndex: 4, endIndex: 6, transform: randMatrix() },
    ],
  };
  const texts = [
    { key: "top", insertionIndex: 0, transform: randMatrix() },
    {
      key: "nested",
      insertionIndex: 8,
      transform: randMatrix(),
      parentId: "g-outer",
      localTransform: randMatrix(),
    },
  ];
  // Computed once per key, not inside the resolver: `buildScenario` returns
  // one `built` object that this suite's tests feed into `encodeRustScene`
  // MULTIPLE times (once per `fast` value) to compare outputs byte-for-byte.
  // A resolver that drew fresh randomness per call would make every call
  // after the first diverge for reasons unrelated to `fast` at all.
  const textCarriers = new Map(
    texts.map((t) => [
      t.key,
      {
        resource: { key: t.key, width: 2, height: 2 },
        pixels: new Uint8Array(16).fill(1),
        width: 2,
        height: 2,
        transform: randMatrix(),
        alpha: rng() < 0.5 ? rng() : undefined,
      },
    ]),
  );
  const resolveText = (record: { key: string }) =>
    textCarriers.get(record.key) ?? null;
  const resolveTexture = (texture: string) =>
    texture === "atlas" ? { key: "atlas", width: 16, height: 16 } : null;
  return {
    drawList: list,
    revision: 1,
    width: 100,
    height: 100,
    designWidth: 50,
    designHeight: 50,
    resolveTexture,
    plan,
    texts,
    resolveText,
  };
}

describe("encodeRustScene fast path", () => {
  it("is byte-identical to the default path across randomized scenarios", () => {
    const rng = mulberry32(42);
    for (let iter = 0; iter < 12; iter++) {
      const built = buildScenario(rng);
      const slow = encodeRustScene({ ...built, fast: false });
      const fast = encodeRustScene({ ...built, fast: true });
      expect(JSON.stringify(fast.scene)).toBe(JSON.stringify(slow.scene));
      expect(Array.from(fast.bytes)).toEqual(Array.from(slow.bytes));
      expect(fast.resources).toEqual(slow.resources);
      expect(fast.unsupportedCommands).toBe(slow.unsupportedCommands);
      expect(fast.textUploads.length).toBe(slow.textUploads.length);
    }
  });

  it("omits the same clips, groups and blends as the default path", () => {
    const list = createDrawList<string>();
    const clip = createClipRectView();
    clip.w = clip.h = 20;
    const quad = createQuadView();
    quad.w = quad.h = 4;
    list.pushQuad(quad); // 0
    list.pushClipRect(clip); // 1: parent resolved by groupAt -> rotated "rot", not its tie
    list.pushQuad(quad); // 2
    list.popClip(); // 3
    quad.blend = BLEND_SUB;
    list.pushQuad(quad); // 4: unsupported blend
    quad.blend = 0;
    list.pushClipRect(clip); // 5
    list.pushClipRect(clip); // 6
    list.pushClipRect(clip); // 7
    list.pushClipRect(clip); // 8: fourth nested clip
    list.pushQuad(quad); // 9
    list.popClip(); // 10
    list.pushQuad(quad); // 11: inside the fractional-alpha group
    list.popClip(); // 12
    list.popClip(); // 13
    list.popClip(); // 14
    list.pushClipRect(clip); // 15: never popped
    list.pushQuad(quad); // 16
    const input = {
      drawList: list,
      revision: 1,
      width: 100,
      height: 100,
      designWidth: 100,
      designHeight: 100,
      resolveTexture: () => null,
      plan: {
        primitives: [
          { id: "last", index: 16, localTransform: [1, 0, 0, 1, 3, 4] },
        ],
        groups: [
          {
            id: "outer",
            firstIndex: 0,
            endIndex: 15,
            transform: [2, 0, 0, 2, 1, 1],
          },
          {
            id: "rot",
            firstIndex: 1,
            endIndex: 4,
            parentId: "outer",
            transform: [0, 1, -1, 0, 0, 0],
          },
          {
            id: "rot-tie",
            firstIndex: 1,
            endIndex: 4,
            transform: [1, 0, 0, 1, 0, 0],
          },
          {
            id: "faded",
            firstIndex: 11,
            endIndex: 12,
            parentId: "outer",
            transform: [1, 0, 0, 1, 0, 0],
            alpha: 0.5,
          },
        ],
      },
      texts: [
        { key: "kept", insertionIndex: 0, transform: [1, 0, 0, 1, 1, 1] },
        { key: "clipped", insertionIndex: 2, transform: [1, 0, 0, 1, 1, 1] },
        { key: "faded", insertionIndex: 11, transform: [1, 0, 0, 1, 1, 1] },
      ],
      resolveText: (record: { key: string }) => ({
        resource: { key: `text-${record.key}`, width: 1, height: 1 },
        pixels: new Uint8Array(4),
        width: 1,
        height: 1,
        transform: [1, 0, 0, 1, 0, 0],
      }),
    };
    const slow = encodeRustScene({ ...input, fast: false });
    const fast = encodeRustScene({ ...input, fast: true });
    expect(slow.scene.commands.map((command) => command.id)).toEqual([
      "tkept",
      "c0",
      "c5",
      "c6",
      "c7",
      "c12",
      "c13",
      "c14",
      "last",
    ]);
    expect(slow.omittedKinds).toEqual({
      unsupportedTransformedClip: 4,
      unsupportedBlend: 1,
      clipDepth: 3,
      unsupportedGroupAlpha: 2,
      unbalancedClip: 1,
    });
    expect(JSON.stringify(fast.scene)).toBe(JSON.stringify(slow.scene));
    expect(Array.from(fast.bytes)).toEqual(Array.from(slow.bytes));
    expect(fast.unsupportedCommands).toBe(slow.unsupportedCommands);
    expect(JSON.stringify(fast.omittedKinds)).toBe(
      JSON.stringify(slow.omittedKinds),
    );
    const update = [
      {
        id: "last",
        command: { ...slow.scene.commands[8], src: [1, 1, 2, 2] },
        localTransform: [1, 0, 0, 1, 5, 6],
      },
    ];
    expect(
      Array.from(encodeRustRetainedPatch(fast.scene, 2, update)!.bytes),
    ).toEqual(
      Array.from(encodeRustRetainedPatch(slow.scene, 2, update)!.bytes),
    );
    // The surviving clips hang off "outer", so moving it must still fall back on the fast path.
    expect(
      encodeRustRetainedPatch(
        fast.scene,
        2,
        [],
        [{ id: "outer", transform: [1, 0, 0, 1, 0, 0] }],
      ),
    ).toBeNull();
  });

  it("keeps the quad key order of the pre-fast encoder on both paths", () => {
    const built = buildScenario(mulberry32(11));
    for (const fast of [false, true]) {
      const { scene } = encodeRustScene({ ...built, fast });
      const quad = scene.commands.find((command) => command.kind === "quad")!;
      expect(Object.keys(quad).slice(0, 5)).toEqual([
        "id",
        "kind",
        "resource",
        "m",
        "w",
      ]);
    }
  });

  it("rustSceneCommandIndex matches a freshly computed id -> index map", () => {
    const rng = mulberry32(3);
    const built = buildScenario(rng);
    const { scene } = encodeRustScene({ ...built, revision: 1 });
    const index = rustSceneCommandIndex(scene);
    const expected = new Map(scene.commands.map((c, i) => [String(c.id), i]));
    expect(index.size).toBe(expected.size);
    for (const [id, i] of expected) expect(index.get(id)).toBe(i);
  });
});

describe("encodeRustPatch fast path", () => {
  it("is byte-identical to the default path, including NaN/-0 no-op diffs", () => {
    const rng = mulberry32(7);
    const built = buildScenario(rng);
    const base = encodeRustScene({ ...built, fast: false, revision: 1 });
    const commands = base.scene.commands.map((c, i) => {
      const bucket = i % 4;
      if (bucket === 0) return c; // identical reference: unchanged
      if (bucket === 1) {
        // New reference, same values (incl. -0/NaN round-tripping through
        // Array.from unchanged): must still read as unchanged.
        const m = (c as Record<string, unknown>).m;
        return Array.isArray(m) ? { ...c, m: [...m] } : { ...c };
      }
      if (bucket === 2) return { ...c, color: [Number.NaN, -0, Number.NaN, 0] };
      const color = (c as Record<string, unknown>).color;
      return Array.isArray(color)
        ? { ...c, color: (color as number[]).map((x) => x + 1) }
        : c;
    });
    const next = { ...base.scene, revision: 2, commands };
    const slow = encodeRustPatch(base.scene, next);
    const fast = encodeRustPatch(base.scene, next, undefined, { fast: true });
    expect(slow === null).toBe(fast === null);
    if (slow && fast) expect(Array.from(fast)).toEqual(Array.from(slow));
  });
});

// --- Pre-copy-on-write oracle ---------------------------------------------------------------------
// Verbatim from commit 53bbfff7 (`git show 53bbfff7:packages/canvas/src/rust-prototype-scene.ts`),
// before `encodeRustRetainedPatchImpl` was rewritten onto `OverlayMap`. Kept ONLY here, with its own
// private bookkeeping (`legacy*`), so the randomized parity test below compares against a genuinely
// independent reference rather than one that would inherit whatever the real implementation does —
// an earlier version of this test kept the oracle in the package source, built from the *new*
// `OverlayMap`s, and so silently inherited a real ordering bug instead of catching it. Do not import
// or export this from the package, and do not fix bugs in it: it exists to stay exactly what shipped
// before, so that a divergence from `encodeRustRetainedPatch` means something.
const legacyEncoder = new TextEncoder();
const legacyIdentity = [1, 0, 0, 1, 0, 0] as const;
function legacyMul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
function legacyInverse(m: ArrayLike<number>): number[] | null {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  const a = m[3] / determinant,
    b = -m[1] / determinant;
  const c = -m[2] / determinant,
    d = m[0] / determinant;
  return [a, b, c, d, -a * m[4] - c * m[5], -b * m[4] - d * m[5]];
}
function legacyTranslatedClipRect(
  previous: Record<string, unknown>,
  command: Record<string, unknown>,
): number[] | null {
  const before = previous.rect,
    after = command.rect;
  if (
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    before.length !== 4 ||
    after.length !== 4 ||
    after[2] !== before[2] ||
    after[3] !== before[3] ||
    command.radius !== previous.radius ||
    command.outset !== previous.outset ||
    !Number.isFinite(after[0]) ||
    !Number.isFinite(after[1])
  )
    return null;
  return [after[0], after[1], before[2], before[3]];
}
interface LegacyRetainedClip {
  id: string;
  parentId?: string;
  rect: readonly number[];
  world: readonly number[];
  local?: readonly number[];
}
interface LegacyRetainedMeta {
  groups: Map<string, { parentId?: string; transform: readonly number[] }>;
  owners: Map<
    string,
    { parentId?: string; local: readonly number[]; sourceLocal: readonly number[] }
  >;
  clips: readonly LegacyRetainedClip[];
}
const legacyRetainedMeta = new WeakMap<RustSceneSnapshot, LegacyRetainedMeta>();
const legacyCommandIndexes = new WeakMap<RustSceneSnapshot, Map<string, number>>();
function legacyIndexCommands(scene: RustSceneSnapshot): Map<string, number> {
  let indexes = legacyCommandIndexes.get(scene);
  if (!indexes) {
    indexes = new Map(scene.commands.map((command, index) => [String(command.id), index]));
    legacyCommandIndexes.set(scene, indexes);
  }
  return indexes;
}
/**
 * Seeds `legacyRetainedMeta`/`legacyCommandIndexes` for a scene this test built directly. The real
 * `encodeRustScene` never saw this object, so its own (separate, private) bookkeeping has nothing for
 * it either — the test hands the oracle the same group/owner/clip facts it constructed the scene
 * from, in the oracle's own pre-change shape (plain `Map`s, not `OverlayMap`s).
 */
function seedLegacyRetainedMeta(
  scene: RustSceneSnapshot,
  groups: LegacyRetainedMeta["groups"],
  owners: LegacyRetainedMeta["owners"],
  clips: readonly LegacyRetainedClip[],
): void {
  legacyIndexCommands(scene);
  legacyRetainedMeta.set(scene, { groups, owners, clips });
}
function legacyEncodeRustRetainedPatch(
  base: RustSceneSnapshot,
  revision: number,
  updates: readonly {
    id: string;
    command: Record<string, unknown>;
    localTransform?: readonly number[];
  }[],
  groupTransforms: readonly { id: string; transform: readonly number[] }[] = [],
): { bytes: Uint8Array; scene: RustSceneSnapshot; changedIndexes: readonly number[] } | null {
  if (
    base.version !== 2 ||
    !Number.isSafeInteger(base.revision) ||
    !Number.isSafeInteger(revision) ||
    revision <= base.revision
  )
    return null;
  const indexes = legacyIndexCommands(base);
  const resources = new Set(base.resources.map((resource) => resource.key));
  const seen = new Set<string>();
  const nextCommands = base.commands.slice();
  const meta = legacyRetainedMeta.get(base);
  if (groupTransforms.length && !meta) return null;
  const groups = meta
    ? new Map(meta.groups)
    : new Map<string, { parentId?: string; transform: readonly number[] }>();
  const owners = meta
    ? new Map(meta.owners)
    : new Map<
        string,
        { parentId?: string; local: readonly number[]; sourceLocal: readonly number[] }
      >();
  for (const change of groupTransforms) {
    const group = groups.get(change.id);
    if (!group || change.transform.length !== 6 || !change.transform.every(Number.isFinite))
      return null;
    groups.set(change.id, { ...group, transform: change.transform });
  }
  const staged = new Map<string, Record<string, unknown>>();
  function groupWorld(
    id: string | undefined,
    source: Map<string, { parentId?: string; transform: readonly number[] }>,
  ): number[] {
    if (!id) return [...legacyIdentity];
    const group = source.get(id);
    if (!group) throw new Error(`missing group ${id}`);
    return legacyMul(groupWorld(group.parentId, source), group.transform);
  }
  function affected(id: string | undefined, changed: Set<string>): boolean {
    while (id) {
      if (changed.has(id)) return true;
      id = groups.get(id)?.parentId;
    }
    return false;
  }
  const changed = new Set(groupTransforms.map((change) => change.id));
  const clipReferences = meta ? new Map(meta.clips.map((clip) => [clip.id, clip])) : null;
  const explicitClips = new Set<string>();
  for (const { id, command, localTransform } of updates) {
    if (seen.has(id)) return null;
    seen.add(id);
    const index = indexes.get(id);
    if (index === undefined) return null;
    const previous = base.commands[index];
    if (command.kind === "clipPush" && previous.kind === "clipPush") {
      const rect = legacyTranslatedClipRect(previous, command);
      if (command.id !== id || localTransform !== undefined || !rect) return null;
      staged.set(id, { ...previous, rect });
      explicitClips.add(id);
      const reference = clipReferences?.get(id);
      if (reference)
        clipReferences!.set(id, {
          id,
          parentId: reference.parentId,
          rect,
          world: groupWorld(reference.parentId, groups),
        });
      continue;
    }
    const resource = command.kind === "glyphRun" ? command.atlas : command.resource;
    const previousResource = previous.kind === "glyphRun" ? previous.atlas : previous.resource;
    if (
      command.id !== id ||
      command.kind !== previous.kind ||
      resource !== previousResource ||
      command.blend !== previous.blend ||
      command.kind === "clipPush" ||
      command.kind === "clipPop" ||
      !["quad", "ninePatch", "rasterText", "glyphRun", "stillImage"].includes(String(command.kind)) ||
      (resource !== null && (typeof resource !== "string" || !resources.has(resource)))
    )
      return null;
    const owner = owners.get(id);
    if (localTransform !== undefined) {
      if (!owner || localTransform.length !== 6 || !localTransform.every(Number.isFinite))
        return null;
      const undoSource = legacyInverse(owner.sourceLocal);
      if (!undoSource) return null;
      const carrierInset = legacyMul(undoSource, owner.local);
      const nextLocal = legacyMul(localTransform, carrierInset);
      owners.set(id, { ...owner, local: nextLocal, sourceLocal: localTransform });
      staged.set(id, { ...command, m: legacyMul(groupWorld(owner.parentId, groups), nextLocal) });
    } else {
      staged.set(id, command);
    }
    if (localTransform === undefined && owner && Array.isArray(command.m) && command.m.length === 6) {
      const oldWorld = groupWorld(owner.parentId, meta!.groups);
      const undo = legacyInverse(oldWorld);
      if (!undo) return null;
      owners.set(id, { ...owner, local: legacyMul(undo, command.m as number[]) });
    }
  }
  if (groupTransforms.length && meta) {
    for (const clip of meta.clips) {
      if (!affected(clip.parentId, changed)) continue;
      const after = groupWorld(clip.parentId, groups);
      if (
        clip.world[0] !== after[0] ||
        clip.world[1] !== after[1] ||
        clip.world[2] !== after[2] ||
        clip.world[3] !== after[3]
      )
        return null;
      if (explicitClips.has(clip.id)) continue;
      let next: number[];
      if (clip.local) {
        const p = legacyMul(after, [1, 0, 0, 1, clip.local[0], clip.local[1]]);
        next = [p[4], p[5], clip.local[2] * after[0], clip.local[3] * after[3]];
      } else {
        next = [
          clip.rect[0] + (after[4] - clip.world[4]),
          clip.rect[1] + (after[5] - clip.world[5]),
          clip.rect[2],
          clip.rect[3],
        ];
      }
      if (!next.every(Number.isFinite)) return null;
      const index = indexes.get(clip.id);
      if (index === undefined) return null;
      const command = base.commands[index];
      const rect = command.rect;
      if (command.kind !== "clipPush" || !Array.isArray(rect) || rect.length !== 4) return null;
      if (rect.every((value, i) => value === next[i])) continue;
      staged.set(clip.id, { ...command, rect: next });
    }
    for (const [id, owner] of owners) {
      if (!affected(owner.parentId, changed)) continue;
      const index = indexes.get(id);
      if (index === undefined) return null;
      const command = staged.get(id) ?? base.commands[index];
      staged.set(id, { ...command, m: legacyMul(groupWorld(owner.parentId, groups), owner.local) });
    }
  }
  const changedIndexes: number[] = [];
  for (const [id, command] of staged) {
    const index = indexes.get(id)!;
    nextCommands[index] = command;
    changedIndexes.push(index);
  }
  const scene: RustSceneSnapshot = { ...base, revision, commands: nextCommands };
  legacyCommandIndexes.set(scene, indexes);
  if (meta)
    legacyRetainedMeta.set(scene, {
      groups,
      owners,
      clips: explicitClips.size ? [...clipReferences!.values()] : meta.clips,
    });
  return {
    bytes: legacyEncoder.encode(
      JSON.stringify({
        version: 1,
        baseRevision: base.revision,
        revision,
        updates: [...staged].map(([id, command]) => ({ id, command })),
      }),
    ),
    scene,
    changedIndexes,
  };
}

const BIG_RESOURCE_KEYS = ["atlasA", "atlasB", "atlasC", "atlasD", "atlasE", "atlasF"];
/**
 * A few hundred commands across a real two-level group hierarchy (`gA` -> `gB`, with a clip under
 * `gB` so moving `gA` moves a large subtree including the clip) plus two ungrouped-by-any-ancestor
 * groups (`gC`/`gD`), real resource keys, and quad/ninePatch/rasterText/glyphRun commands — every
 * primitive and text record carries an explicit `localTransform`, so the test can hand-derive the
 * exact `groups`/`owners`/`clips` the legacy oracle needs without reimplementing `encodeRustScene`'s
 * own extraction of them. (`stillImage` is not producible through `encodeRustScene` at all — no
 * drawList or text path ever emits it — so it is covered separately, directly against a hand-built
 * scene where `meta` is undefined on both sides.)
 */
function buildBigScenario(rng: () => number) {
  const list = createDrawList<string>();
  const groupsSeed = new Map<string, { parentId?: string; transform: readonly number[] }>([
    ["gA", { transform: [1, 0, 0, 1, 5, 7] }],
    ["gB", { parentId: "gA", transform: [1, 0, 0, 1, -3, 4] }],
    ["gC", { transform: [1.2, 0.1, -0.1, 1.1, 3, -2] }],
    ["gD", { transform: [0.9, -0.2, 0.2, 0.95, -4, 6] }],
  ]);
  const groupPlan = [...groupsSeed].map(([id, g]) => ({
    id,
    parentId: g.parentId,
    firstIndex: 0,
    endIndex: 0, // never consulted: every primitive below gives an explicit parentId.
    transform: g.transform as number[],
  }));
  const ownersSeed = new Map<
    string,
    { parentId?: string; local: readonly number[]; sourceLocal: readonly number[] }
  >();
  const primitives: { id: string; index: number; parentId?: string; localTransform: number[] }[] =
    [];
  const groupCycle = ["gA", "gB", "gC", "gD", undefined] as const;
  const quadIds: string[] = [];
  const ninePatchIds: string[] = [];

  const clip = createClipRectView();
  clip.x = -4;
  clip.y = 2;
  clip.w = 50;
  clip.h = 40;
  clip.cornerRadius = 1;
  clip.outsetX = 0.5;
  const clipIndex = list.pushClipRect(clip);
  primitives.push({ id: "clip0", index: clipIndex, parentId: "gB", localTransform: [1, 0, 0, 1, 0, 0] });

  const QUADS = 200;
  const NINE_PATCHES = 40;
  for (let i = 0; i < QUADS; i++) {
    const q = createQuadView();
    q.w = 4 + rng() * 10;
    q.h = 4 + rng() * 10;
    q.r = rng();
    q.g = rng();
    q.b = rng();
    q.a = 1;
    q.blend = 0;
    const idx = list.pushQuad(q, BIG_RESOURCE_KEYS[i % BIG_RESOURCE_KEYS.length]);
    const id = `q${i}`;
    const parentId = groupCycle[i % groupCycle.length];
    const localTransform = [1, 0, 0, 1, rng() * 10 - 5, rng() * 10 - 5];
    primitives.push({ id, index: idx, parentId, localTransform });
    ownersSeed.set(id, { parentId, local: localTransform, sourceLocal: localTransform });
    quadIds.push(id);
  }
  for (let i = 0; i < NINE_PATCHES; i++) {
    const n = createNinePatchView();
    n.w = 10 + rng() * 10;
    n.h = 10 + rng() * 10;
    n.r = rng();
    n.g = rng();
    n.b = rng();
    n.a = 1;
    n.blend = 0;
    n.marginLeft = n.marginTop = n.marginRight = n.marginBottom = 1;
    const idx = list.pushNinePatch(n, BIG_RESOURCE_KEYS[i % BIG_RESOURCE_KEYS.length]);
    const id = `n${i}`;
    const parentId = groupCycle[(i + 2) % groupCycle.length];
    const localTransform = [1, 0, 0, 1, rng() * 10 - 5, rng() * 10 - 5];
    primitives.push({ id, index: idx, parentId, localTransform });
    ownersSeed.set(id, { parentId, local: localTransform, sourceLocal: localTransform });
    ninePatchIds.push(id);
  }
  list.popClip();
  const textInsertionIndex = list.count;

  const RASTER = 10;
  const GLYPHS = 10;
  const texts: {
    key: string;
    insertionIndex: number;
    transform: readonly number[];
    parentId?: string;
    localTransform?: readonly number[];
  }[] = [];
  const rasterTextIds: string[] = [];
  const glyphRunIds: string[] = [];
  const textCarriers = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < RASTER; i++) {
    const key = `raster${i}`;
    const parentId = groupCycle[i % groupCycle.length];
    const localTransform = [1, 0, 0, 1, rng() * 6 - 3, rng() * 6 - 3];
    const carrierTransform = [1, 0, 0, 1, rng() * 6 - 3, rng() * 6 - 3];
    texts.push({ key, insertionIndex: textInsertionIndex, transform: carrierTransform, parentId, localTransform });
    rasterTextIds.push(`t${key}`);
    ownersSeed.set(`t${key}`, { parentId, local: carrierTransform, sourceLocal: localTransform });
    textCarriers.set(key, {
      resource: { key: `texRaster${i}`, width: 2, height: 2 },
      pixels: new Uint8Array(16).fill(1),
      width: 2,
      height: 2,
      transform: carrierTransform,
      alpha: 1,
    });
  }
  for (let i = 0; i < GLYPHS; i++) {
    const key = `glyph${i}`;
    const parentId = groupCycle[(i + 3) % groupCycle.length];
    const localTransform = [1, 0, 0, 1, rng() * 6 - 3, rng() * 6 - 3];
    const carrierTransform = [1, 0, 0, 1, rng() * 6 - 3, rng() * 6 - 3];
    texts.push({ key, insertionIndex: textInsertionIndex, transform: carrierTransform, parentId, localTransform });
    glyphRunIds.push(`t${key}`);
    ownersSeed.set(`t${key}`, { parentId, local: carrierTransform, sourceLocal: localTransform });
    textCarriers.set(key, {
      kind: "glyphs",
      method: "msdf",
      atlas: { key: "glyphAtlas", width: 64, height: 64 },
      glyphs: [{ src: [0, 0, 8, 8], dst: [0, 0, 8, 8] }],
      transform: carrierTransform,
      fill: [1, 0, 0, 1],
      pxRange: 4,
      alpha: 1,
    });
  }
  const resolveTexture = (texture: string) =>
    BIG_RESOURCE_KEYS.includes(texture) ? { key: texture, width: 32, height: 32 } : null;
  const resolveText = (record: { key: string }) => textCarriers.get(record.key) ?? null;

  function worldOf(id: string | undefined): number[] {
    if (!id) return [...legacyIdentity];
    const group = groupsSeed.get(id)!;
    return legacyMul(worldOf(group.parentId), group.transform);
  }
  const clipWorld = worldOf("gB");
  const clipP = legacyMul(clipWorld, [1, 0, 0, 1, clip.x, clip.y]);
  const clipsSeed: LegacyRetainedClip[] = [
    {
      id: "clip0",
      parentId: "gB",
      rect: [clipP[4], clipP[5], clip.w * clipWorld[0], clip.h * clipWorld[3]],
      world: clipWorld,
      local: [clip.x, clip.y, clip.w, clip.h],
    },
  ];

  const built = {
    drawList: list,
    revision: 1,
    width: 2000,
    height: 2000,
    designWidth: 2000,
    designHeight: 2000,
    resolveTexture,
    resolveText,
    texts,
    plan: { groups: groupPlan, primitives },
  };
  return {
    built,
    groupsSeed,
    ownersSeed,
    clipsSeed,
    quadIds,
    ninePatchIds,
    rasterTextIds,
    glyphRunIds,
    clipId: "clip0",
  };
}

describe("encodeRustRetainedPatch", () => {
  it("produces identical output whether its base scene was built fast or default", () => {
    const rng = mulberry32(99);
    const built = buildScenario(rng);
    const baseSlow = encodeRustScene({ ...built, fast: false, revision: 1 });
    const baseFast = encodeRustScene({ ...built, fast: true, revision: 1 });
    expect(JSON.stringify(baseFast.scene)).toBe(JSON.stringify(baseSlow.scene));
    // Move "tie-a" (not an ancestor of the clip's parent chain g-inner -> g-outer)
    // so the retained patch actually recomputes owners instead of bailing out.
    const groupTransforms = [{ id: "tie-a", transform: [1, 0, 0, 1, 42, 43] }];
    const resultSlow = encodeRustRetainedPatch(
      baseSlow.scene,
      2,
      [],
      groupTransforms,
    );
    const resultFast = encodeRustRetainedPatch(
      baseFast.scene,
      2,
      [],
      groupTransforms,
    );
    expect(resultSlow === null).toBe(resultFast === null);
    if (resultSlow && resultFast) {
      expect(Array.from(resultFast.bytes)).toEqual(
        Array.from(resultSlow.bytes),
      );
      expect(JSON.stringify(resultFast.scene)).toBe(
        JSON.stringify(resultSlow.scene),
      );
      expect(resultFast.changedIndexes).toEqual(resultSlow.changedIndexes);
    }
  });

  it("stays byte-identical to the pre-copy-on-write oracle over a long, randomized patch chain", () => {
    // Exercises what the real implementation's `OverlayMap` does that the oracle's plain `Map`s never
    // need to: compaction (>=500 steps over ~260 owners/groups, so `own` crosses the 1/8-of-root
    // threshold many times over) and exact `Map`-order iteration (the group-move loop below iterates
    // `owners` directly). `commands` itself is a plain array again — a per-patch `Proxy` overlay was
    // tried and reverted for regressing every consumer that iterates the whole array — so nothing
    // special is needed to exercise that part; it is simply `base.commands.slice()` either way. A
    // deliberately invalid update is mixed in to prove a rejected patch lands identically on both
    // sides, and a full `encodeRustPatch` diff against the heavily patched result closes the loop.
    const rng = mulberry32(7);
    const {
      built,
      groupsSeed,
      ownersSeed,
      clipsSeed,
      quadIds,
      ninePatchIds,
      rasterTextIds,
      glyphRunIds,
      clipId,
    } = buildBigScenario(rng);
    const admitted = encodeRustScene(built);
    seedLegacyRetainedMeta(admitted.scene, new Map(groupsSeed), new Map(ownersSeed), clipsSeed);
    expect(admitted.scene.commands.length).toBeGreaterThan(250);

    const movableIds = [...quadIds, ...ninePatchIds, ...rasterTextIds, ...glyphRunIds];
    const linearFixedGroupIds = ["gA", "gB"]; // ancestors of "clip0": translate only, never rescale/rotate
    const freeGroupIds = ["gC", "gD"]; // no clip descendant: any transform is safe
    const groupTransformState = new Map(
      [...groupsSeed].map(([id, g]) => [id, g.transform.slice()]),
    );

    let real: RustSceneSnapshot = admitted.scene;
    let oracle: RustSceneSnapshot = admitted.scene;
    let revision = admitted.scene.revision;
    let acceptedSteps = 0;
    let rejectedSteps = 0;
    const STEPS = 520;
    for (let step = 0; step < STEPS; step++) {
      revision += 1;
      const pick = rng();
      let updates: {
        id: string;
        command: Record<string, unknown>;
        localTransform?: number[];
      }[] = [];
      let groupTransforms: { id: string; transform: readonly number[] }[] = [];
      if (pick < 0.03) {
        // No such command id: both implementations must refuse this the same way.
        updates = [{ id: "does-not-exist", command: { id: "does-not-exist", kind: "quad" } }];
      } else if (pick < 0.35) {
        const id = movableIds[Math.floor(rng() * movableIds.length)];
        const previous = real.commands[rustSceneCommandIndex(real).get(id)!];
        updates = [
          { id, command: { ...previous, m: [1, 0, 0, 1, rng() * 40 - 20, rng() * 40 - 20] } },
        ];
      } else if (pick < 0.6) {
        const id = movableIds[Math.floor(rng() * movableIds.length)];
        const previous = real.commands[rustSceneCommandIndex(real).get(id)!];
        updates = [
          {
            id,
            command: { ...previous },
            localTransform: [1, 0, 0, 1, rng() * 10 - 5, rng() * 10 - 5],
          },
        ];
      } else if (pick < 0.75) {
        const previous = real.commands[rustSceneCommandIndex(real).get(clipId)!];
        const rect = previous.rect as number[];
        updates = [
          {
            id: clipId,
            command: {
              ...previous,
              rect: [rect[0] + rng() * 6 - 3, rect[1] + rng() * 6 - 3, rect[2], rect[3]],
            },
          },
        ];
      } else {
        // "gA"/"gB" are the clip's ancestors: moving "gA" moves a large subtree (everything under
        // "gA" and "gB" together, the clip included), so only its translation may change.
        const fromLinearFixed = rng() < 0.5;
        const pool = fromLinearFixed ? linearFixedGroupIds : freeGroupIds;
        const id = pool[Math.floor(rng() * pool.length)];
        const current = groupTransformState.get(id)!;
        const transform = fromLinearFixed
          ? [current[0], current[1], current[2], current[3], rng() * 20 - 10, rng() * 20 - 10]
          : Array.from({ length: 6 }, () => rng() * 2 - 1);
        groupTransformState.set(id, transform);
        groupTransforms = [{ id, transform }];
      }
      const realResult = encodeRustRetainedPatch(real, revision, updates, groupTransforms);
      const oracleResult = legacyEncodeRustRetainedPatch(oracle, revision, updates, groupTransforms);
      expect([step, realResult === null]).toEqual([step, oracleResult === null]);
      if (!realResult || !oracleResult) {
        rejectedSteps++;
        continue;
      }
      expect([step, new TextDecoder().decode(realResult.bytes)]).toEqual([
        step,
        new TextDecoder().decode(oracleResult.bytes),
      ]);
      expect([step, realResult.changedIndexes]).toEqual([step, oracleResult.changedIndexes]);
      real = realResult.scene;
      oracle = oracleResult.scene;
      acceptedSteps++;
    }
    // The randomized actions are all individually valid (bar the deliberate rejection above), so this
    // proves the chain actually exercised the accepted path throughout and triggered compaction many
    // times over, not a run of early, silent `null`s.
    expect(acceptedSteps).toBeGreaterThan(400);
    expect(rejectedSteps).toBeGreaterThan(0);

    // The full diff between the original admission and the heavily patched result agrees with the
    // chain of retained patches, read back off a `commands` array that came out of the retained-patch
    // path — a plain array again, not the reverted `Proxy`.
    const fullDiff = encodeRustPatch(admitted.scene, real);
    expect(fullDiff).not.toBeNull();
    const wire = JSON.parse(new TextDecoder().decode(fullDiff!));
    expect(wire.updates.length).toBeGreaterThan(0);
    const diffedIds = new Set(wire.updates.map((update: { id: string }) => update.id));
    expect(diffedIds.size).toBe(wire.updates.length);
    for (const update of wire.updates) {
      const index = rustSceneCommandIndex(real).get(update.id)!;
      expect(update.command).toEqual(real.commands[index]);
    }
  });

  it("patches a stillImage command the same way the oracle does, with no owner bookkeeping", () => {
    // `encodeRustScene` never emits `stillImage` — no drawList or text path produces it — so it only
    // ever reaches `encodeRustRetainedPatch` on a scene the function built some other way, meaning
    // `meta` is undefined on both sides here. That is the one case the big randomized chain above does
    // not cover (it only ever patches a scene `encodeRustScene` itself admitted).
    const base: RustSceneSnapshot = {
      version: 2,
      revision: 1,
      width: 10,
      height: 10,
      designWidth: 10,
      designHeight: 10,
      resources: [{ key: "still", width: 4, height: 4 }],
      commands: [
        {
          id: "s0",
          kind: "stillImage",
          resource: "still",
          m: [1, 0, 0, 1, 0, 0],
          w: 4,
          h: 4,
          src: [0, 0, 4, 4],
          color: [1, 1, 1, 1],
          blend: "mix",
          flipH: false,
          flipV: false,
          colorMatrix: null,
        },
      ],
    };
    const update = { id: "s0", command: { ...base.commands[0], m: [1, 0, 0, 1, 5, 6] } };
    const real = encodeRustRetainedPatch(base, 2, [update]);
    const oracle = legacyEncodeRustRetainedPatch(base, 2, [update]);
    expect(real).not.toBeNull();
    expect(oracle).not.toBeNull();
    expect(new TextDecoder().decode(real!.bytes)).toBe(new TextDecoder().decode(oracle!.bytes));
    expect(real!.changedIndexes).toEqual(oracle!.changedIndexes);
  });
});
