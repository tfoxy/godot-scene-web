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
  encodeRustRetainedPatch,
  encodeRustScene,
  jsonEqual,
  rustSceneCommandIndex,
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
      expect(Object.keys(quad).slice(0, 5)).toEqual(["id", "kind", "resource", "m", "w"]);
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
});
