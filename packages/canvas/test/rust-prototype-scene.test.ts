import { describe, expect, it, vi } from "vitest";
import {
  createClipRectView,
  createDrawList,
  createQuadView,
} from "../src/draw-list";
import {
  encodeRustResources,
  encodeRustRetainedPatch,
  encodeRustScene,
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

  it("preserves draw order and explicitly counts unsupported commands", () => {
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
      "polyline",
      "clipPop",
    ]);
    expect(encoded.unsupportedCommands).toBe(1);
    expect(scene.resources).toEqual([{ key: "atlas", width: 64, height: 64 }]);
  });
  it("flattens retained group transforms and refuses fractional group alpha", () => {
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
    const alpha = JSON.parse(
      new TextDecoder().decode(
        encodeRustScene({
          ...options,
          plan: { ...plan, groups: [{ ...plan.groups[0], alpha: 0.5 }] },
        }).bytes,
      ),
    );
    expect(alpha.commands[0].kind).toBe("unsupportedGroupAlpha");
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
  it("falls back when a retained group movement would move a clip", () => {
    const list = createDrawList<string>();
    const clip = createClipRectView();
    clip.w = 10;
    clip.h = 10;
    list.pushClipRect(clip);
    const q = createQuadView();
    q.w = 4;
    q.h = 4;
    list.pushQuad(q);
    list.popClip();
    const base = encodeRustScene({
      drawList: list,
      revision: 1,
      width: 20,
      height: 20,
      designWidth: 20,
      designHeight: 20,
      resolveTexture: () => null,
      plan: {
        groups: [
          {
            id: "g",
            firstIndex: 0,
            endIndex: 3,
            transform: [1, 0, 0, 1, 0, 0],
          },
        ],
        primitives: [
          { id: "clip", index: 0, parentId: "g" },
          { id: "q", index: 1, parentId: "g" },
          { id: "pop", index: 2, parentId: "g" },
        ],
      },
    });
    expect(
      encodeRustRetainedPatch(
        base.scene,
        2,
        [],
        [{ id: "g", transform: [1, 0, 0, 1, 1, 1] }],
      ),
    ).toBeNull();
  });
  it("batches same-kind updates and falls back on shape change", async () => {
    const { encodeRustPatch } = await import("../src/rust-prototype-scene");
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
