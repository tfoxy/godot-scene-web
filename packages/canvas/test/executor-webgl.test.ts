import { describe, expect, it } from "vitest";
import {
  INSTANCE_COLOR_OFFSET,
  INSTANCE_FLOATS,
  INSTANCE_UV_OFFSET,
} from "../src/batcher";
import {
  BLEND_ADD,
  BLEND_MIX,
  BLEND_MUL,
  BLEND_SUB,
  createClipRectView,
  createDrawList,
  createNinePatchView,
  createPolylineView,
  createQuadView,
  createTexturedMeshView,
  type DrawList,
} from "../src/draw-list";
import {
  blendStateFor,
  createCanvasExecutor,
  type ExecutorTexture,
} from "../src/executor-webgl";
import { createFakeGl, type FakeGl, fakeProjection } from "./fake-gl";

function page(id: number, width = 256, height = 256): ExecutorTexture {
  return {
    texture: { id } as unknown as WebGLTexture,
    width,
    height,
  };
}

function setup(options: { maxTextureUnits?: number } = {}) {
  const fake: FakeGl = createFakeGl(options);
  const executor = createCanvasExecutor({ gl: fake.gl });
  const list = createDrawList<ExecutorTexture | null>();
  return { fake, executor, list, projection: fakeProjection(1920, 1080) };
}

function mesh() {
  const view = createTexturedMeshView(3, 3);
  view.positions.set([0, 0, 10, 0, 0, 10]);
  view.uvs.set([0, 0, 1, 0, 0, 1]);
  view.indices.set([0, 1, 2]);
  view.vertexCount = 3;
  view.indexCount = 3;
  return view;
}

/** The instance floats of every draw, in order, recovered from the fake's log. */
function uploadedInstances(fake: FakeGl): Float32Array[] {
  return fake
    .named("bufferSubData")
    .map((call) =>
      (call.args[2] as Float32Array).slice(0, call.args[4] as number),
    );
}

describe("blendStateFor", () => {
  it("maps Godot's four modes to the premultiplied GL state", () => {
    expect(blendStateFor(BLEND_MIX)).toEqual({
      equationRgb: "FUNC_ADD",
      equationAlpha: "FUNC_ADD",
      srcRgb: "ONE",
      dstRgb: "ONE_MINUS_SRC_ALPHA",
      srcAlpha: "ONE",
      dstAlpha: "ONE_MINUS_SRC_ALPHA",
    });
    expect(blendStateFor(BLEND_ADD)).toMatchObject({
      srcRgb: "ONE",
      dstRgb: "ONE",
      equationRgb: "FUNC_ADD",
    });
    // SUB subtracts COLOUR only: the alpha equation must stay additive, or a dark
    // sprite would eat the destination's coverage and punch a hole in the scene.
    expect(blendStateFor(BLEND_SUB)).toMatchObject({
      equationRgb: "FUNC_REVERSE_SUBTRACT",
      equationAlpha: "FUNC_ADD",
      srcRgb: "ONE",
      dstRgb: "ONE",
    });
    expect(blendStateFor(BLEND_MUL)).toEqual({
      equationRgb: "FUNC_ADD",
      equationAlpha: "FUNC_ADD",
      srcRgb: "DST_COLOR",
      dstRgb: "ZERO",
      srcAlpha: "DST_ALPHA",
      dstAlpha: "ZERO",
    });
  });
});

describe("executor geometry", () => {
  it("replaces the transparent clear without adding a fullscreen draw", () => {
    const { fake, executor, list, projection } = setup();

    expect(
      executor.execute(list, projection, {
        clearColor: [24 / 255, 24 / 255, 24 / 255, 1],
      }),
    ).toBe(true);

    expect(fake.named("clearColor")).toHaveLength(1);
    expect(fake.named("clearColor")[0].args).toEqual([
      24 / 255,
      24 / 255,
      24 / 255,
      1,
    ]);
    expect(fake.draws).toHaveLength(0);
  });

  it("uploads a transformed indexed triangle mesh with its own UVs", () => {
    const { fake, executor, list, projection } = setup();
    const view = mesh();
    view.m.set([2, 0, 0, 3, 100, 50]);
    view.r = 0.25;
    view.g = 0.5;
    view.b = 0.75;
    view.a = 0.5;
    const texture = page(9);
    list.pushTexturedMesh(view, texture);

    executor.execute(list, projection);
    expect(fake.elements).toHaveLength(1);
    expect(fake.elements[0].count).toBe(3);
    expect(fake.elements[0].textures[0]).toBe(texture.texture);
    const uploads = fake
      .named("bufferSubData")
      .filter((call) => call.args[4] === 12);
    expect([...(uploads[0].args[2] as Float32Array).subarray(0, 12)]).toEqual([
      100, 50, 0, 0, 120, 50, 1, 0, 100, 80, 0, 1,
    ]);
    expect(executor.stats.texturedMeshes).toBe(1);
    expect(executor.stats.texturedMeshTriangles).toBe(1);
  });

  it("maps a quad's local rect through its transform into design space", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    // A half-scale, rotated-by-nothing transform with an origin: corners must
    // come out as the transform's image of (0,0)-(w,h).
    quad.m.set([2, 0, 0, 3, 100, 50]);
    quad.w = 10;
    quad.h = 20;
    quad.srcX = 64;
    quad.srcY = 32;
    quad.srcW = 128;
    quad.srcH = 64;
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);

    const instances = uploadedInstances(fake);
    expect(instances).toHaveLength(1);
    expect([...instances[0].subarray(0, 8)]).toEqual([
      100, 50, 120, 50, 120, 110, 100, 110,
    ]);
    // Page pixels normalized against the texture's own size.
    expect([
      ...instances[0].subarray(INSTANCE_UV_OFFSET, INSTANCE_UV_OFFSET + 4),
    ]).toEqual([0.25, 0.125, 0.5, 0.25]);
  });

  it("carries FLIP_H / FLIP_V as a negative source span from the far edge", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 10;
    quad.h = 10;
    quad.srcX = 64;
    quad.srcY = 32;
    quad.srcW = 128;
    quad.srcH = 64;
    quad.flipH = true;
    quad.flipV = true;
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);
    const uv = uploadedInstances(fake)[0].subarray(
      INSTANCE_UV_OFFSET,
      INSTANCE_UV_OFFSET + 4,
    );
    expect([...uv]).toEqual([0.75, 0.375, -0.5, -0.25]);
  });

  it("draws an untextured quad against a 1x1 white texel", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    quad.r = 0.5;
    quad.g = 0;
    quad.b = 0;
    quad.a = 0.5;
    list.pushQuad(quad, null);
    executor.execute(list, projection);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].instanceCount).toBe(1);
    // The white texel is uploaded once, from bytes, un-flipped.
    const uploads = fake.named("texImage2D");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].args[3]).toBe(1);
    expect(uploads[0].args[4]).toBe(1);
  });

  it("expands a nine-patch into bands inside ONE draw", () => {
    const { fake, executor, list, projection } = setup();
    const patch = createNinePatchView();
    patch.w = 100;
    patch.h = 60;
    patch.srcW = 40;
    patch.srcH = 30;
    patch.marginLeft = 8;
    patch.marginTop = 6;
    patch.marginRight = 8;
    patch.marginBottom = 6;
    list.pushNinePatch(patch, page(1));
    executor.execute(list, projection);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].instanceCount).toBe(9);
    expect(executor.stats.ninePatches).toBe(1);
    expect(executor.stats.ninePatchQuads).toBe(9);
  });

  it("mirrors a flipped nine-patch's BANDS, not just their source rects", () => {
    const { fake, executor, list, projection } = setup();
    const patch = createNinePatchView();
    patch.w = 100;
    patch.h = 60;
    patch.srcW = 40;
    patch.srcH = 30;
    patch.marginLeft = 8;
    patch.marginRight = 20;
    patch.marginTop = 0;
    patch.marginBottom = 0;
    patch.flipH = true;
    list.pushNinePatch(patch, page(1));
    executor.execute(list, projection);
    const instances = uploadedInstances(fake)[0];
    const lefts: number[] = [];
    for (let i = 0; i < 3; i += 1) lefts.push(instances[i * INSTANCE_FLOATS]);
    // Un-flipped the bands start at 0, 8 and 80 (an 8 px left cap and a 20 px
    // right cap). Flipped, the 8 px cap has to move to the RIGHT end: the bands
    // start at 92, 20 and 0.
    expect(lefts.sort((a, b) => a - b)).toEqual([0, 20, 92]);
  });

  it("draws a polyline as stroke quads in the same batch as a sprite", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    const line = createPolylineView(4);
    line.points.set([0, 0, 10, 0, 10, 10]);
    line.pointCount = 3;
    line.width = 2;
    list.pushPolyline(line);
    executor.execute(list, projection);
    // One sprite + two segments + one join wedge, all in one draw call.
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].instanceCount).toBe(4);
    expect(executor.stats.polylines).toBe(1);
    expect(executor.stats.polylineQuads).toBe(3);
  });
});

describe("executor state changes", () => {
  it("flushes quads around a mesh in painter order and keeps the active clip", () => {
    const { fake, executor, list, projection } = setup();
    const before = createQuadView();
    before.w = 4;
    before.h = 4;
    const clip = createClipRectView();
    clip.x = 20;
    clip.y = 30;
    clip.w = 100;
    clip.h = 200;
    list.pushClipRect(clip);
    list.pushQuad(before, page(1));
    const view = mesh();
    view.blend = BLEND_ADD;
    list.pushTexturedMesh(view, page(2));
    list.popClip();
    list.pushQuad(before, page(3));

    executor.execute(list, projection);
    const sequence = fake.calls
      .filter(
        (call) =>
          call.name === "drawArraysInstanced" || call.name === "drawElements",
      )
      .map((call) => call.name);
    expect(sequence).toEqual([
      "drawArraysInstanced",
      "drawElements",
      "drawArraysInstanced",
    ]);
    expect(fake.elements[0].scissor).toEqual([20, 850, 100, 200]);
    expect(fake.elements[0].blendFunc).toEqual([
      (fake.gl as unknown as Record<string, number>).ONE,
      (fake.gl as unknown as Record<string, number>).ONE,
      (fake.gl as unknown as Record<string, number>).ONE,
      (fake.gl as unknown as Record<string, number>).ONE,
    ]);
    // The next quad proves the mesh restored the executor's program/VAO; the
    // pop also proves its scissor cache survived the intervening mesh.
    expect(fake.draws[1].scissor).toEqual([0, 0, 1920, 1080]);
    expect(executor.stats.flushes.meshes).toBe(1);
  });

  it("applies every existing blend mode to an indexed mesh", () => {
    const { fake, executor, list, projection } = setup();
    for (const blend of [BLEND_MIX, BLEND_ADD, BLEND_SUB, BLEND_MUL] as const) {
      const view = mesh();
      view.blend = blend;
      list.pushTexturedMesh(view, page(blend));
    }
    executor.execute(list, projection);
    expect(fake.elements).toHaveLength(4);
    for (const [index, blend] of (
      [BLEND_MIX, BLEND_ADD, BLEND_SUB, BLEND_MUL] as const
    ).entries()) {
      const expected = blendStateFor(blend);
      const gl = fake.gl as unknown as Record<string, number>;
      expect(fake.elements[index].blendFunc).toEqual([
        gl[expected.srcRgb],
        gl[expected.dstRgb],
        gl[expected.srcAlpha],
        gl[expected.dstAlpha],
      ]);
    }
  });

  it("flushes the pending batch BEFORE it changes the blend state", () => {
    // The order-of-operations invariant: a batch drawn after the new blend was
    // applied would composite the PREVIOUS quads wrongly, and nothing about the
    // resulting frame would say so.
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    quad.blend = BLEND_ADD;
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);

    expect(fake.draws).toHaveLength(2);
    const mix = blendStateFor(BLEND_MIX);
    const add = blendStateFor(BLEND_ADD);
    const gl = fake.gl as unknown as Record<string, number>;
    expect(fake.draws[0].blendFunc[1]).toBe(gl[mix.dstRgb]);
    expect(fake.draws[1].blendFunc[1]).toBe(gl[add.dstRgb]);
  });

  it("flushes BEFORE it narrows the scissor, and restores it on the pop", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    const clip = createClipRectView();
    clip.x = 0;
    clip.y = 0;
    clip.w = 960;
    clip.h = 540;

    list.pushQuad(quad, page(1));
    list.pushClipRect(clip);
    list.pushQuad(quad, page(1));
    list.popClip();
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);

    expect(fake.draws).toHaveLength(3);
    expect(fake.draws[0].scissor).toEqual([0, 0, 1920, 1080]);
    // Design y 0..540 is the TOP half, so the scissor's origin is at 1080 - 540.
    expect(fake.draws[1].scissor).toEqual([0, 540, 960, 540]);
    expect(fake.draws[2].scissor).toEqual([0, 0, 1920, 1080]);
    expect(executor.stats.scissorChanges).toBe(3);
  });

  it("uploads the rounded-clip uniforms only while a rounded scope is open", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    const clip = createClipRectView();
    clip.x = 100;
    clip.y = 200;
    clip.w = 400;
    clip.h = 300;
    clip.cornerRadius = 16;
    list.pushClipRect(clip);
    list.pushQuad(quad, page(1));
    list.popClip();
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);

    const radii = fake.named("uniform1f").map((call) => call.args[1] as number);
    // Zero at the start of the frame, 16 inside the scope, back to zero after.
    expect(radii).toEqual([0, 16, 0]);
    const rects = fake.named("uniform4f").map((call) => call.args.slice(1));
    // The first uniform4f of the frame is the projection; the rounded rect is
    // centre + half-extent in DESIGN units.
    expect(rects).toContainEqual([300, 350, 200, 150]);
  });

  it("survives a clipPop with nothing open instead of throwing mid-frame", () => {
    const { fake, executor, projection } = setup();
    const list = {
      count: 1,
      kindAt: () => 4,
      readClipRect: (_i: number, out: unknown) => out,
    } as unknown as DrawList<ExecutorTexture | null>;
    expect(executor.execute(list, projection)).toBe(true);
    expect(executor.stats.unbalancedClipPops).toBe(1);
    expect(fake.draws).toHaveLength(0);
  });
});

describe("executor re-execution", () => {
  it("re-reads a patched list instead of a cached instance from last frame", () => {
    // The property a consumer patching a list in place depends on: the executor
    // holds NO per-command state between executes — it walks the list again and
    // reads each command's payload again. A cached instance buffer would repaint
    // last frame's colour and geometry with no error anywhere.
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.m.set([1, 0, 0, 1, 100, 50]);
    quad.w = 10;
    quad.h = 20;
    quad.srcW = 1;
    quad.srcH = 1;
    quad.r = 0.25;
    quad.g = 0.5;
    quad.b = 0.75;
    quad.a = 1;
    const index = list.pushQuad(quad, page(1));
    executor.execute(list, projection);
    const before = uploadedInstances(fake)[0];
    expect([
      ...before.subarray(INSTANCE_COLOR_OFFSET, INSTANCE_COLOR_OFFSET + 4),
    ]).toEqual([0.25, 0.5, 0.75, 1]);

    fake.reset();
    list.patchQuadColor(index, 0.125, 0.25, 0.375, 0.5);
    list.patchQuadTransform(index, [2, 0, 0, 1, 0, 0]);
    executor.execute(list, projection);

    const after = uploadedInstances(fake)[0];
    expect([
      ...after.subarray(INSTANCE_COLOR_OFFSET, INSTANCE_COLOR_OFFSET + 4),
    ]).toEqual([0.125, 0.25, 0.375, 0.5]);
    // The corners come out of the patched transform: (0,0)-(10,20) under a
    // double-width scale with no origin.
    expect([...after.subarray(0, 8)]).toEqual([0, 0, 20, 0, 20, 20, 0, 20]);
    // Untouched by either patch: the source rect, and the batch shape.
    expect([
      ...after.subarray(INSTANCE_UV_OFFSET, INSTANCE_UV_OFFSET + 4),
    ]).toEqual([0, 0, 1 / 256, 1 / 256]);
    expect(executor.stats.quads).toBe(1);
    expect(executor.stats.batches).toBe(1);
  });

  it("keeps a patched command's blend state, so a batch does not silently split", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    quad.blend = BLEND_ADD;
    const first = list.pushQuad(quad, page(1));
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);
    expect(fake.draws).toHaveLength(1);

    fake.reset();
    list.patchQuadColor(first, 0, 0, 0, 0);
    executor.execute(list, projection);
    // Still one draw: blend lives in the ints, which no patch writes. Two blend
    // changes per frame either way — the MIX every execute starts from, then the
    // ADD both quads share.
    expect(fake.draws).toHaveLength(1);
    expect(executor.stats.blendChanges).toBe(2);
    expect(uploadedInstances(fake)[0].length).toBe(INSTANCE_FLOATS * 2);
  });
});

describe("executor external effects", () => {
  it("keeps painter order and restores executor state after a direct pass", () => {
    const { fake, executor, list, projection } = setup();
    list.pushExternalEffect({
      execute(context) {
        expect(context.width).toBe(1920);
        expect(context.height).toBe(1080);
        context.gl.disable(context.gl.SCISSOR_TEST);
        context.gl.disable(context.gl.BLEND);
        context.gl.useProgram(null);
        context.gl.bindVertexArray(null);
        return true;
      },
    });
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));

    expect(executor.execute(list, projection)).toBe(true);
    expect(executor.stats.externalEffects).toBe(1);
    expect(executor.stats.externalEffectFailures).toBe(0);
    expect(fake.draws).toHaveLength(1);
    expect(fake.draws[0].blendFunc).toEqual([
      fake.gl.ONE,
      fake.gl.ONE_MINUS_SRC_ALPHA,
      fake.gl.ONE,
      fake.gl.ONE_MINUS_SRC_ALPHA,
    ]);
    expect(fake.draws[0].scissor).toEqual([0, 0, 1920, 1080]);
  });
});

describe("executor lifecycle", () => {
  it("builds its program once and reuses it across frames", () => {
    const { fake, executor, list, projection } = setup();
    expect(executor.warmUp()).toBe(true);
    const programs = fake.named("createProgram").length;
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);
    executor.execute(list, projection);
    expect(fake.named("createProgram")).toHaveLength(programs);
    expect(fake.draws).toHaveLength(2);
  });

  it("rebuilds after invalidate WITHOUT asking the dead context to free anything", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, page(1));
    executor.execute(list, projection);
    fake.reset();
    executor.invalidate();
    expect(fake.named("deleteProgram")).toHaveLength(0);
    expect(fake.named("deleteTexture")).toHaveLength(0);
    executor.execute(list, projection);
    expect(fake.named("createProgram")).toHaveLength(1);
    expect(fake.draws).toHaveLength(1);
  });

  it("clamps its slot count to what the context actually offers", () => {
    const fake = createFakeGl({ maxTextureUnits: 8 });
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(executor.maxTextureSlots).toBe(8);
    // …and the generated fragment shader declares exactly that many samplers.
    executor.warmUp();
    const sources = fake
      .named("shaderSource")
      .map((call) => call.args[1] as string);
    expect(
      sources.some((s) => s.includes("uniform sampler2D u_textures[8]")),
    ).toBe(true);
    expect(sources.some((s) => s.includes("slot == 7"))).toBe(true);
    expect(sources.some((s) => s.includes("slot == 8"))).toBe(false);
  });

  it("emits the premultiplied fragment the canvas is declared for", () => {
    const fake = createFakeGl();
    const executor = createCanvasExecutor({ gl: fake.gl });
    executor.warmUp();
    const fragment = fake
      .named("shaderSource")
      .map((call) => call.args[1] as string)
      .find((source) => source.includes("fragColor"));
    // Two premultiplied colours compose with a plain multiply, and the matrix
    // branch must un-premultiply first. Both are asserted here because both are
    // silent when wrong.
    expect(fragment).toContain("fragColor = texel * v_color;");
    expect(fragment).toContain("texel.rgb / alpha");
    expect(fragment).toContain("straight * alpha");
    // Cross-stage integer precision, without which the program does not link.
    expect(fragment).toContain("precision highp int;");
  });

  it("deletes what it owns on dispose", () => {
    const { fake, executor, list, projection } = setup();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad, null);
    executor.execute(list, projection);
    executor.dispose();
    expect(fake.named("deleteProgram")).toHaveLength(1);
    expect(fake.named("deleteVertexArray")).toHaveLength(1);
    expect(fake.named("deleteBuffer")).toHaveLength(2);
    expect(fake.named("deleteTexture")).toHaveLength(1);
  });
});
