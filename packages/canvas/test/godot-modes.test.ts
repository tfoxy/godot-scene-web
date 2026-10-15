// The opt-in Godot CanvasItem drawing modes: per-vertex colours, premultiplied
// sources (Godot's PREMULT_ALPHA), per-binding sampler state, straight-alpha
// storage and the RGB10_A2 stage target.
//
// These tests prove the IR round-trips and that the executor issues the GL state
// each mode needs, and none of it otherwise. What the pixels then ARE is
// `packages/test-harness/test/canvasModesPixel.test.ts`'s job, on a real GPU.

import { describe, expect, it } from "vitest";
import { commandDamageBounds, createDamageRect } from "../src/damage";
import {
  BLEND_MIX,
  createDrawList,
  createDrawListFragment,
  createQuadView,
  createTexturedMeshView,
  type TexturedMeshView,
} from "../src/draw-list";
import {
  blendStateFor,
  createCanvasExecutor,
  type ExecutorTexture,
} from "../src/executor-webgl";
import { createStageTarget } from "../src/present";
import { createTextureBinding, createTextureCache } from "../src/textures";
import { createFakeGl, type FakeGl, fakeProjection } from "./fake-gl";

function page(
  id: number,
  extra: Partial<ExecutorTexture> = {},
): ExecutorTexture {
  return {
    texture: { id } as unknown as WebGLTexture,
    width: 4,
    height: 4,
    revision: 1,
    ...extra,
  };
}

function coloredMesh(): TexturedMeshView {
  const view = createTexturedMeshView(3, 3);
  view.positions.set([0, 0, 10, 0, 0, 10]);
  view.uvs.set([0, 0, 1, 0, 0, 1]);
  view.indices.set([0, 1, 2]);
  view.vertexCount = 3;
  view.indexCount = 3;
  view.hasVertexColors = true;
  // STRAIGHT, and deliberately not premultiplied-looking: a value that would be
  // impossible as `rgb*a` (rgb > a) proves nothing premultiplies on the way in.
  view.vertexColors?.set([1, 0.5, 0.25, 0.2, 0, 1, 0, 1, 0.75, 0.75, 0.75, 0]);
  return view;
}

function setup() {
  const fake: FakeGl = createFakeGl();
  const executor = createCanvasExecutor({ gl: fake.gl });
  const list = createDrawList<ExecutorTexture | null>();
  return { fake, executor, list, projection: fakeProjection(64, 64) };
}

const GL = createFakeGl().gl as unknown as Record<string, number>;

/** Every recorded call name, in order. */
function namesOf(fake: FakeGl): string[] {
  return fake.calls.map((call) => call.name);
}

function uniformCalls(fake: FakeGl, name: string): unknown[][] {
  // `getUniformLocation` returns `{ __gl: "uniform:<name>" }` in the fake.
  return fake.calls
    .filter(
      (call) =>
        (call.name === "uniform1i" || call.name === "uniform1iv") &&
        (call.args[0] as { __gl?: string }).__gl === `uniform:${name}`,
    )
    .map((call) => call.args.slice(1));
}

describe("vertex colours in the draw list", () => {
  it("round-trips straight colours exactly and leaves positions where readers expect them", () => {
    const list = createDrawList<string>();
    const index = list.pushTexturedMesh(coloredMesh(), "page");
    const out = list.readTexturedMesh(index, createTexturedMeshView(1, 1));
    expect(out.hasVertexColors).toBe(true);
    expect([
      ...(out.vertexColors ?? new Float32Array(0)).subarray(0, 12),
    ]).toEqual([
      ...Float32Array.from([
        1, 0.5, 0.25, 0.2, 0, 1, 0, 1, 0.75, 0.75, 0.75, 0,
      ]),
    ]);
    expect([...out.positions.subarray(0, 6)]).toEqual([0, 0, 10, 0, 0, 10]);
    expect([...out.uvs.subarray(0, 6)]).toEqual([0, 0, 1, 0, 0, 1]);
    expect([...out.indices.subarray(0, 3)]).toEqual([0, 1, 2]);
    // damage.ts reads mesh positions straight from the arena at +10: the colour
    // stream must sit after the UVs, never between header and positions.
    const bounds = commandDamageBounds(list, index, createDamageRect());
    expect(bounds).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("records a plain mesh from a view built without the optional fields", () => {
    const list = createDrawList();
    const view = coloredMesh();
    // A producer that predates the field: the shape older ambient declarations
    // describe. It must keep recording exactly the mesh it always recorded.
    const legacy: TexturedMeshView = {
      m: view.m,
      positions: view.positions,
      uvs: view.uvs,
      vertexCount: 3,
      indices: view.indices,
      indexCount: 3,
      r: 1,
      g: 1,
      b: 1,
      a: 1,
      blend: BLEND_MIX,
    };
    const index = list.pushTexturedMesh(legacy);
    const reader = coloredMesh();
    list.readTexturedMesh(index, reader);
    expect(reader.hasVertexColors).toBe(false);
    expect(list.floats.length).toBeGreaterThan(0);
    // 10 header floats + 4 per vertex, nothing for colours.
    expect(list.floatOffsetAt(index)).toBe(0);
    const next = list.pushQuad(createQuadView());
    expect(list.floatOffsetAt(next)).toBe(10 + 3 * 4);
  });

  it("rejects a colour buffer too short for its vertices before reserving anything", () => {
    const list = createDrawList();
    const view = coloredMesh();
    view.vertexColors = new Float32Array(8);
    expect(() => list.pushTexturedMesh(view)).toThrow(/vertex colours/);
    view.vertexColors = undefined;
    expect(() => list.pushTexturedMesh(view)).toThrow(/vertex colours/);
    expect(list.count).toBe(0);
  });

  it("captures, appends and patches a coloured mesh, and refuses a shape change", () => {
    const source = createDrawList<string>();
    source.pushTexturedMesh(coloredMesh(), "a");
    const fragment = createDrawListFragment<string>();
    fragment.capture(source, 0);
    const destination = createDrawList<string>();
    destination.pushQuad(createQuadView());
    const at = destination.appendFragment(fragment);
    const out = destination.readTexturedMesh(at, createTexturedMeshView());
    expect(out.hasVertexColors).toBe(true);
    expect(out.vertexColors?.[3]).toBeCloseTo(0.2, 6);

    // Same shape, new colours: an in-place patch.
    const recoloured = coloredMesh();
    recoloured.vertexColors?.fill(0.5);
    const replacement = createDrawList<string>();
    replacement.pushTexturedMesh(recoloured, "a");
    fragment.capture(replacement, 0);
    expect(destination.patchFragment(at, fragment)).toBe(true);
    expect(
      destination.readTexturedMesh(at, createTexturedMeshView())
        .vertexColors?.[0],
    ).toBe(0.5);

    // A plain mesh has a different payload length and must not overwrite it.
    const plain = coloredMesh();
    plain.hasVertexColors = false;
    const plainList = createDrawList<string>();
    plainList.pushTexturedMesh(plain, "a");
    fragment.capture(plainList, 0);
    expect(destination.patchFragment(at, fragment)).toBe(false);
  });
});

describe("premultiplied sources (Godot's BLEND_MODE_PREMULT_ALPHA)", () => {
  it("is MIX's GL state, so it is stated on the data and BlendMode stays four modes", () => {
    // Godot's PMALPHA pair is (ONE, ONE_MINUS_SRC_ALPHA): this executor's MIX.
    expect(blendStateFor(BLEND_MIX)).toMatchObject({
      srcRgb: "ONE",
      dstRgb: "ONE_MINUS_SRC_ALPHA",
    });
    const straight = page(1, { straightAlpha: true });
    const asGiven = createTextureBinding(straight, { straightAlpha: false });
    expect(asGiven.straightAlpha).toBe(false);
    expect(asGiven.sampling).toBeUndefined();
    expect(asGiven.texture).toBe(straight.texture);
    const list = createDrawList();
    const mesh = coloredMesh();
    mesh.premultipliedVertexColors = true;
    const index = list.pushTexturedMesh(mesh);
    const out = list.readTexturedMesh(index, createTexturedMeshView());
    expect(out.premultipliedVertexColors).toBe(true);
    expect(
      list.readTexturedMesh(list.pushTexturedMesh(coloredMesh()), out)
        .premultipliedVertexColors,
    ).toBe(false);
  });
});

describe("executor: no new GL state for existing callers", () => {
  it("draws plain quads and meshes without samplers, masks or a colour stream", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    const mesh = coloredMesh();
    mesh.hasVertexColors = false;
    list.pushTexturedMesh(mesh, page(2));
    executor.execute(list, projection);
    executor.execute(list, projection);
    const names = namesOf(fake);
    expect(names).not.toContain("bindSampler");
    expect(names).not.toContain("createSampler");
    expect(uniformCalls(fake, "u_straightMask")).toEqual([]);
    expect(uniformCalls(fake, "u_alphaFlags")).toEqual([]);
    expect(uniformCalls(fake, "u_vertexColors")).toEqual([]);
    // Location 2 is enabled exactly once, by the QUAD program's own VAO set-up
    // (its `a_uv`); the mesh program never touches its colour location.
    expect(
      fake
        .named("enableVertexAttribArray")
        .filter((call) => call.args[0] === 2),
    ).toHaveLength(1);
    expect(fake.named("disableVertexAttribArray")).toEqual([]);
  });
});

describe("executor: straight-alpha textures", () => {
  it("sets the straight bit for exactly the slots that read straight", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    const straight = page(2, { straightAlpha: true });
    list.pushQuad(quad, straight);
    // The same straight-stored texels read as premultiplied content: slot 2.
    list.pushQuad(
      quad,
      createTextureBinding(straight, { straightAlpha: false }),
    );
    executor.execute(list, projection);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].textures.slice(1, 3)).toEqual([
      straight.texture,
      straight.texture,
    ]);
    expect(uniformCalls(fake, "u_straightMask")).toEqual([[0b10]]);
    // Unchanged next frame: no redundant upload.
    executor.execute(list, projection);
    expect(uniformCalls(fake, "u_straightMask")).toEqual([[0b10]]);
  });

  it("premultiplies a straight mesh texel and straight vertex colours, and neither when told not to", () => {
    const { fake, executor, list, projection } = setup();
    const straight = page(1, { straightAlpha: true });
    list.pushTexturedMesh(coloredMesh(), straight);
    const premul = coloredMesh();
    premul.premultipliedVertexColors = true;
    list.pushTexturedMesh(
      premul,
      createTextureBinding(straight, { straightAlpha: false }),
    );
    const plain = coloredMesh();
    plain.hasVertexColors = false;
    list.pushTexturedMesh(plain, page(3));
    executor.execute(list, projection);
    expect(fake.elements).toHaveLength(3);
    expect(uniformCalls(fake, "u_alphaFlags")).toEqual([[3], [0]]);
    expect(uniformCalls(fake, "u_vertexColors")).toEqual([[1], [0]]);
    // Skip the quad program's own VAO set-up, which enables its location 2 once.
    const meshSetup = fake.calls.findIndex(
      (call) => call.name === "useProgram",
    );
    const attribute = fake.calls.filter(
      (call, at) =>
        at > meshSetup &&
        (call.name === "enableVertexAttribArray" ||
          call.name === "disableVertexAttribArray") &&
        call.args[0] === 2,
    );
    expect(attribute.map((call) => call.name)).toEqual([
      "enableVertexAttribArray",
      "disableVertexAttribArray",
    ]);
    // The colour upload carries the STRAIGHT values as recorded.
    const colourUpload = fake
      .named("bufferSubData")
      .find(
        (call) =>
          call.args[4] === 12 && (call.args[2] as Float32Array)[3] !== 0,
      );
    expect(
      [...(colourUpload?.args[2] as Float32Array).subarray(0, 4)].map((v) =>
        Number(v.toFixed(6)),
      ),
    ).toEqual([1, 0.5, 0.25, 0.2]);
  });
});

describe("executor: per-binding sampler state", () => {
  it("binds a cached sampler for exactly the draw that needs it, then unbinds it", () => {
    const { fake, executor, list, projection } = setup();
    const base = page(1);
    const tiled = createTextureBinding(base, {
      wrap: "repeat",
      filter: "nearest",
    });
    const mirrored = createTextureBinding(base, { wrap: "mirror" });
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, base);
    list.pushQuad(quad, tiled);
    list.pushQuad(quad, mirrored);
    list.pushQuad(quad, tiled);
    executor.execute(list, projection);
    // One batch: three identities, three slots, one GL texture.
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].textures.slice(0, 3)).toEqual([
      base.texture,
      base.texture,
      base.texture,
    ]);
    expect(fake.named("createSampler")).toHaveLength(2);
    const parameters = fake
      .named("samplerParameteri")
      .map((call) => call.args.slice(1));
    expect(parameters).toEqual([
      [GL.TEXTURE_WRAP_S, GL.REPEAT],
      [GL.TEXTURE_WRAP_T, GL.REPEAT],
      [GL.TEXTURE_MIN_FILTER, GL.NEAREST],
      [GL.TEXTURE_MAG_FILTER, GL.NEAREST],
      [GL.TEXTURE_WRAP_S, GL.MIRRORED_REPEAT],
      [GL.TEXTURE_WRAP_T, GL.MIRRORED_REPEAT],
      [GL.TEXTURE_MIN_FILTER, GL.LINEAR],
      [GL.TEXTURE_MAG_FILTER, GL.LINEAR],
    ]);
    const names = namesOf(fake);
    const draw = names.indexOf("drawArraysInstanced");
    const binds = fake.calls
      .map((call, at) => ({ call, at }))
      .filter(({ call }) => call.name === "bindSampler");
    // Slots 1 and 2 bound before the draw, both released after it; slot 0 (the
    // plain handle) never touched.
    expect(
      binds.map(({ call }) => [call.args[0], call.args[1] !== null]),
    ).toEqual([
      [1, true],
      [2, true],
      [1, false],
      [2, false],
    ]);
    expect(binds[1].at).toBeLessThan(draw);
    expect(binds[2].at).toBeGreaterThan(draw);

    // A second frame reuses the cached samplers; invalidate() forgets them.
    executor.execute(list, projection);
    expect(fake.named("createSampler")).toHaveLength(2);
    executor.invalidate();
    executor.execute(list, projection);
    expect(fake.named("createSampler")).toHaveLength(4);
  });

  it("binds a mesh's sampler on unit 0 around its one draw", () => {
    const { fake, executor, list, projection } = setup();
    const mesh = coloredMesh();
    mesh.hasVertexColors = false;
    list.pushTexturedMesh(
      mesh,
      createTextureBinding(page(1), { wrap: "repeat" }),
    );
    executor.execute(list, projection);
    const sequence = fake.calls
      .filter(
        (call) => call.name === "bindSampler" || call.name === "drawElements",
      )
      .map((call) =>
        call.name === "bindSampler"
          ? `bindSampler(${call.args[0]},${call.args[1] === null ? "null" : "s"})`
          : call.name,
      );
    expect(sequence).toEqual([
      "bindSampler(0,s)",
      "drawElements",
      "bindSampler(0,null)",
    ]);
  });
});

describe("texture bindings and straight storage", () => {
  it("derives a binding that reads size, revision and alpha storage through", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    const handle = cache.acquireBytes("k", new Uint8Array(4 * 4), 2, 2, {
      straightAlpha: true,
    });
    // No sampler override keeps the texture's own parameters...
    expect(createTextureBinding(handle).sampling).toBeUndefined();
    // ...and either half of one fills the other with the cache's defaults.
    const binding = createTextureBinding(handle, { wrap: "clamp" });
    expect(binding.sampling).toEqual({ wrap: "clamp", filter: "linear" });
    expect(
      createTextureBinding(handle, { filter: "nearest" }).sampling,
    ).toEqual({
      wrap: "clamp",
      filter: "nearest",
    });
    expect(binding.texture).toBe(handle.texture);
    expect(binding.straightAlpha).toBe(true);
    const before = binding.revision;
    cache.update("k", { width: 3, height: 5 } as unknown as TexImageSource);
    expect(binding.revision).toBeGreaterThan(before);
    expect([binding.width, binding.height]).toEqual([3, 5]);
    expect(binding).not.toBe(handle);
  });

  it("stores straight bytes verbatim and flags the handle", () => {
    const fake = createFakeGl();
    const cache = createTextureCache(fake.gl);
    const pixels = new Uint8Array([200, 100, 50, 128]);
    const handle = cache.acquireBytes("straight", pixels, 1, 1, {
      straightAlpha: true,
    });
    expect(handle.straightAlpha).toBe(true);
    const upload = fake.named("texImage2D")[0];
    expect([...(upload.args[8] as Uint8Array).subarray(0, 4)]).toEqual([
      200, 100, 50, 128,
    ]);
    // The default path still premultiplies, exactly: round(200 * 128 / 255) = 100.
    const plain = cache.acquireBytes("plain", pixels, 1, 1);
    expect(plain.straightAlpha).toBe(false);
    const plainUpload = fake.named("texImage2D")[1];
    expect([...(plainUpload.args[8] as Uint8Array).subarray(0, 4)]).toEqual([
      100, 50, 25, 128,
    ]);
  });

  it("does not premultiply a straight DOM source and refuses a contradictory request", () => {
    const fake = createFakeGl();
    const gl = fake.gl as unknown as Record<string, number>;
    const cache = createTextureCache(fake.gl);
    cache.acquire("img", { width: 2, height: 2 } as unknown as TexImageSource, {
      straightAlpha: true,
    });
    const flags = fake
      .named("pixelStorei")
      .filter((call) => call.args[0] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    expect(flags.at(-1)?.args[1]).toBe(false);
    expect(() =>
      cache.acquireBytes("both", new Uint8Array(4), 1, 1, {
        straightAlpha: true,
        premultiplied: true,
      }),
    ).toThrow(/straightAlpha/);
  });
});

describe("RGB10_A2 stage target", () => {
  it("allocates immutable RGB10_A2 storage and presents it with one rounding draw", () => {
    const fake = createFakeGl();
    const target = createStageTarget(fake.gl, { width: 8, height: 4 });
    expect(target.format).toBe("rgb10_a2");
    expect(target.allocated).toBe(true);
    expect(fake.named("texStorage2D")[0].args).toEqual([
      GL.TEXTURE_2D,
      1,
      GL.RGB10_A2,
      8,
      4,
    ]);
    expect(target.bind()).toBe(true);
    expect(target.blit()).toBe(true);
    // Not blitFramebuffer: its 10 -> 8-bit conversion is the implementation's.
    expect(fake.named("blitFramebuffer")).toEqual([]);
    expect(fake.named("drawArrays").map((call) => call.args)).toEqual([
      [GL.TRIANGLES, 0, 3],
    ]);
    const source = fake
      .named("shaderSource")
      .map((call) => call.args[1] as string)
      .find((text) => text.includes("u_frame"));
    expect(source).toContain("texelFetch");
    expect(source).toContain("floor(c * 255.0 + 0.5) / 255.0");
    expect(fake.named("disable").map((call) => call.args[0])).toEqual(
      expect.arrayContaining([GL.BLEND, GL.SCISSOR_TEST]),
    );
    // The program is built once.
    target.blit();
    expect(fake.named("linkProgram")).toHaveLength(1);
  });

  it("copies an rgba8 target with blitFramebuffer, 1:1 NEAREST", () => {
    const fake = createFakeGl();
    const target = createStageTarget(fake.gl, {
      format: "rgba8",
      width: 8,
      height: 4,
    });
    expect(fake.named("texStorage2D")[0].args[2]).toBe(GL.RGBA8);
    expect(target.blit()).toBe(true);
    expect(fake.named("blitFramebuffer")[0].args).toEqual([
      0,
      0,
      8,
      4,
      0,
      0,
      8,
      4,
      GL.COLOR_BUFFER_BIT,
      GL.NEAREST,
    ]);
    expect(
      fake.named("disable").some((call) => call.args[0] === GL.SCISSOR_TEST),
    ).toBe(true);
  });

  it("reads 8-bit and packed words with rows flipped to top-down", () => {
    const fake = createFakeGl();
    const target = createStageTarget(fake.gl, { width: 2, height: 3 });
    const bytes = target.readPixels();
    // The fake writes each pixel's GL row (0 = bottom); top-down puts row 2 first.
    expect([bytes?.[0], bytes?.[8], bytes?.[16]]).toEqual([2, 1, 0]);
    expect(fake.named("readPixels")[0].args.slice(4)).toEqual([
      GL.RGBA,
      GL.UNSIGNED_BYTE,
    ]);
    const words = target.readPacked();
    expect([words?.[0], words?.[2], words?.[4]]).toEqual([2, 1, 0]);
    expect(fake.named("readPixels")[1].args.slice(4)).toEqual([
      GL.RGBA,
      GL.UNSIGNED_INT_2_10_10_10_REV,
    ]);
  });

  it("returns null for packed reads the context does not offer, and for rgba8", () => {
    const fake = createFakeGl({ implementationReadType: 0x1401 });
    expect(
      createStageTarget(fake.gl, { width: 1, height: 1 }).readPacked(),
    ).toBeNull();
    const rgba8 = createStageTarget(createFakeGl().gl, {
      format: "rgba8",
      width: 1,
      height: 1,
    });
    expect(rgba8.readPacked()).toBeNull();
  });

  it("forgets handles on invalidate without calling GL, and reallocates on resize", () => {
    const fake = createFakeGl();
    const target = createStageTarget(fake.gl, { width: 2, height: 2 });
    fake.reset();
    target.invalidate();
    expect(fake.calls).toEqual([]);
    expect(target.allocated).toBe(false);
    expect(target.bind()).toBe(false);
    expect(target.resize(4, 4)).toBe(true);
    expect([target.width, target.height]).toEqual([4, 4]);
  });
});
