import {
  createGodotParticleScratch,
  createHeadlessEffectsStage,
  disposeParticleInstanceBuffer,
  drawParticles,
  getParticleProgram,
  type HeadlessEffectResult,
  type HeadlessParticleParameters,
  invalidateParticleInstanceBuffer,
} from "@godot-scene-web/canvas-effects/webgl";
import { InstanceBuffer } from "@godot-scene-web/effects/particles";
import { describe, expect, it } from "vitest";
import source from "../../canvas-effects/src/webgl.ts?raw";
import {
  createCanvasExecutor,
  createDrawList,
  createHeadlessGodotParticleDirectEffect,
  createHeadlessScreenEffectCommand,
  createQuadView,
} from "../src/index";
import { createFakeGl, fakeProjection } from "./fake-gl";

const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
void main() { fragColor = vec4(v_uv, 0.0, 1.0); }`;

const vec3Fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform vec3 u_tint;
out vec4 fragColor;
void main() { fragColor = vec4(u_tint, 1.0); }`;

const screenFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_screenTexture;
out vec4 fragColor;
void main() { fragColor = texture(u_screenTexture, v_uv); }`;

const godotStatic = `shader_type canvas_item;
void fragment() { COLOR = vec4(0.25, 0.5, 0.75, 1.0); }`;

const godotAnimated = `shader_type canvas_item;
void fragment() { COLOR = vec4(fract(TIME), 0.0, 0.0, 1.0); }`;

const godotScreen = `shader_type canvas_item;
uniform sampler2D screen_copy : hint_screen_texture;
void fragment() { COLOR = texture(screen_copy, SCREEN_UV); }`;

const particles: HeadlessParticleParameters = {
  maxParticles: 24,
  emissionRate: 8,
  lifetimeSeconds: 2,
  position: [20, 30],
  directionRadians: 0.2,
  spreadRadians: 0.5,
  speedMin: 10,
  speedMax: 30,
  gravity: [0, 9.8],
  startColor: [1, 0, 0, 1],
  endColor: [0, 0, 1, 0],
  startSizePx: 4,
  endSizePx: 12,
};

function value<T>(result: HeadlessEffectResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.diagnostic.code}: ${result.diagnostic.message}`);
  return result.value;
}

describe("headless effect targets", () => {
  it("keeps one portable instance buffer resident independently per WebGL context", () => {
    const a = createFakeGl();
    const b = createFakeGl();
    const instances = new InstanceBuffer(1);
    instances.push(10, 10, 4, 4, 0, 1, 1, 1, 1, 0);
    const draw = (gl: WebGL2RenderingContext) => {
      const program = getParticleProgram(gl);
      const quad = gl.createBuffer();
      if (!program || !quad) throw new Error("particle program");
      return drawParticles({ gl, quad }, program, instances, {
        viewportW: 32,
        viewportH: 32,
        textured: false,
        texture: null,
        hframes: 1,
        vframes: 1,
        blendMode: 0,
      });
    };
    expect(draw(a.gl)).toBe(true);
    expect(draw(b.gl)).toBe(true);
    a.reset();
    b.reset();
    disposeParticleInstanceBuffer(a.gl, instances);
    expect(draw(b.gl)).toBe(true);
    expect(b.named("bufferData")).toHaveLength(0);
    expect(b.named("bufferSubData")).toHaveLength(1);
    invalidateParticleInstanceBuffer(a.gl, instances);
    a.reset();
    expect(draw(a.gl)).toBe(true);
    // A's forgotten allocation is recreated; B's allocation was never touched.
    expect(a.named("bufferData")).toHaveLength(1);
  });

  it("runs the shared Godot static and TIME shader semantics without a DOM runtime", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const staticProducer = value(
      stage.createGodotShaderProducer({ source: godotStatic }, 8, 4),
    );
    const animatedProducer = value(
      stage.createGodotShaderProducer({ source: godotAnimated }, 8, 4),
    );
    expect(staticProducer.render({ time: 0, delta: 0 }).ok).toBe(true);
    expect(staticProducer.blend).toBe("mix");
    fake.reset();
    expect(animatedProducer.render({ time: 2.5, delta: 1 / 60 }).ok).toBe(true);
    expect(
      fake.named("uniform1f").some((call) => call.args.slice(1).includes(2.5)),
    ).toBe(true);
    expect(source).not.toContain("document.createElement");
    expect(source).not.toContain("requestAnimationFrame");
  });

  it("uses the painter-position snapshot for shared Godot SCREEN_TEXTURE semantics", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const accumulated = value(
      stage.createShaderProducer({ fragmentSource: fragment }, 8, 4),
    ).target;
    const producer = value(
      stage.createGodotShaderProducer({ source: godotScreen }, 8, 4),
    );
    fake.reset();
    expect(
      producer.render({ time: 0, delta: 0, screenTexture: accumulated }).ok,
    ).toBe(true);
    expect(
      fake
        .named("bindTexture")
        .some((call) => call.args[1] === accumulated.texture),
    ).toBe(true);
  });

  it("reconstructs a clipped node-local Godot screen shader with its source blend", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const producer = value(
      stage.createGodotShaderProducer(
        {
          source: godotScreen.replace(
            "shader_type canvas_item;",
            "shader_type canvas_item;\nrender_mode blend_add;",
          ),
        },
        8,
        8,
      ),
    );
    fake.reset();
    expect(
      producer.renderScreen(
        { time: 0, delta: 0, screenRect: [0.25, 0.25, 0.5, 0.5] },
        {
          gl: fake.gl,
          framebuffer: null,
          width: 8,
          height: 8,
          scissor: { x: 3, y: 1, width: 4, height: 5 },
        },
      ).ok,
    ).toBe(true);
    expect(
      fake.named("viewport").some((call) => call.args.join(",") === "2,2,4,4"),
    ).toBe(true);
    expect(
      fake.named("scissor").some((call) => call.args.join(",") === "3,2,3,4"),
    ).toBe(true);
    expect(
      fake
        .named("blendFuncSeparate")
        .some((call) => call.args.slice(0, 2).every((v) => v === fake.gl.ONE)),
    ).toBe(true);
    expect(fake.named("blitFramebuffer").length).toBeGreaterThanOrEqual(2);
  });

  it("snaps screen-shader viewport endpoints, not separately rounded extents", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createGodotShaderProducer(
        { source: godotScreen },
        10,
        10,
      ),
    );
    value(
      producer.renderScreen(
        { time: 0, delta: 0, screenRect: [0.15, 0.15, 0.2, 0.2] },
        {
          gl: fake.gl,
          framebuffer: null,
          width: 10,
          height: 10,
          scissor: { x: 0, y: 0, width: 10, height: 10 },
        },
      ),
    );
    expect(
      fake.named("viewport").some((call) => call.args.join(",") === "2,6,2,2"),
    ).toBe(true);
  });

  it("refuses unsupported Godot source and unowned sampler targets instead of approximating", () => {
    const stage = createHeadlessEffectsStage(createFakeGl().gl);
    expect(
      stage.createGodotShaderProducer(
        { source: "shader_type spatial; void fragment() {}" },
        1,
        1,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_SHADER_FEATURE",
        feature: "godot-source",
      },
    });
    expect(
      stage.createGodotShaderProducer(
        {
          source: `shader_type canvas_item; uniform sampler2D noise; void fragment() { COLOR = texture(noise, UV); }`,
        },
        1,
        1,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_SHADER_FEATURE",
        feature: "sampler:noise",
      },
    });
  });

  it("uses an owned opaque base texture and rejects invalid uniforms/repeat samplers", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const producer = value(
      stage.createGodotShaderProducer({ source: godotStatic }, 1, 1),
    );
    fake.reset();
    value(producer.render({ time: 0, delta: 0 }));
    expect(
      fake
        .named("bindTexture")
        .some(
          (call) =>
            call.args[0] === fake.gl.TEXTURE_2D && call.args[1] !== null,
        ),
    ).toBe(true);
    expect(
      stage.createGodotShaderProducer(
        {
          source: `shader_type canvas_item;
uniform vec3 tint;
void fragment() { COLOR = vec4(tint, 1.0); }`,
          uniforms: { tint: [1, 0] },
        },
        1,
        1,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { feature: "uniform:tint" },
    });
    expect(
      stage.createGodotShaderProducer(
        {
          source: `shader_type canvas_item;
uniform sampler2D noise : repeat_enable;
void fragment() { COLOR = texture(noise, UV); }`,
          samplers: { noise: producer.target },
        },
        1,
        1,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { feature: "sampler:noise:repeat" },
    });
  });

  it("fills the owned white target once and snapshots validated uniform values", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const tint: [number, number, number] = [0.1, 0.2, 0.3];
    const producer = value(
      stage.createGodotShaderProducer(
        {
          source: `shader_type canvas_item;
uniform vec3 tint;
void fragment() { COLOR = vec4(tint, 1.0); }`,
          uniforms: { tint },
        },
        2,
        2,
      ),
    );
    tint[0] = Number.NaN;
    value(producer.render({ time: 0, delta: 0 }));
    const clears = fake.named("clear").length;
    const uploads = fake.named("texImage2D").length;
    fake.reset();
    value(producer.render({ time: 0, delta: 0 }));
    expect(fake.named("clear")).toHaveLength(1); // only the producer target
    expect(fake.named("texImage2D")).toHaveLength(0);
    expect(clears).toBeGreaterThan(1); // producer + one-time white initialization
    expect(uploads).toBeGreaterThan(1);
  });

  it("owns exact RGBA8 targets, reallocates on resize, and releases them", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createShaderProducer(
        { fragmentSource: fragment },
        10.2,
        20.7,
      ),
    );
    expect([producer.target.width, producer.target.height]).toEqual([10, 21]);
    expect(fake.named("texImage2D").at(-1)?.args.slice(0, 6)).toEqual([
      fake.gl.TEXTURE_2D,
      0,
      fake.gl.RGBA8,
      10,
      21,
      0,
    ]);
    fake.reset();
    expect(producer.resize(30, 40).ok).toBe(true);
    expect(fake.named("deleteTexture")).toHaveLength(1);
    expect(fake.named("deleteFramebuffer")).toHaveLength(1);
    expect([producer.target.width, producer.target.height]).toEqual([30, 40]);
    fake.reset();
    producer.dispose();
    expect(fake.named("deleteTexture")).toHaveLength(1);
    expect(fake.named("deleteFramebuffer")).toHaveLength(1);
  });

  it("executes an explicit screen sample in call order and snapshots a same-target copy", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const sourceTarget = value(
      stage.createShaderProducer({ fragmentSource: fragment }, 32, 16),
    ).target;
    const destinationTarget = value(
      stage.createShaderProducer({ fragmentSource: fragment }, 20, 10),
    ).target;
    fake.reset();
    expect(
      stage.executeScreenSample({
        source: sourceTarget,
        destination: destinationTarget,
        filter: "linear",
      }).ok,
    ).toBe(true);
    const readAt = fake.calls.findIndex(
      (call) =>
        call.name === "bindFramebuffer" &&
        call.args[0] === fake.gl.READ_FRAMEBUFFER,
    );
    const drawAt = fake.calls.findIndex(
      (call) =>
        call.name === "bindFramebuffer" &&
        call.args[0] === fake.gl.DRAW_FRAMEBUFFER,
    );
    const blitAt = fake.calls.findIndex(
      (call) => call.name === "blitFramebuffer",
    );
    expect(readAt).toBeLessThan(drawAt);
    expect(drawAt).toBeLessThan(blitAt);
    expect(fake.named("blitFramebuffer")[0]?.args.at(-1)).toBe(fake.gl.LINEAR);
    fake.reset();
    expect(
      stage.executeScreenSample({
        source: sourceTarget,
        destination: sourceTarget,
      }).ok,
    ).toBe(true);
    expect(fake.named("blitFramebuffer")).toHaveLength(2);
  });

  it("snapshots the accumulated target before rendering a screen-texture shader into itself", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createShaderProducer(
        { fragmentSource: screenFragment, features: ["screen-texture"] },
        2,
        2,
      ),
    );
    fake.reset();
    expect(
      producer.render({
        time: 1,
        delta: 1 / 60,
        screenTexture: producer.target,
      }).ok,
    ).toBe(true);
    const copyAt = fake.calls.findIndex(
      (call) => call.name === "blitFramebuffer",
    );
    const drawAt = fake.calls.findIndex((call) => call.name === "drawArrays");
    expect(copyAt).toBeGreaterThan(-1);
    expect(copyAt).toBeLessThan(drawAt);
  });

  it("runs a recorded screen pass between executor batches against its current FBO", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const producer = value(
      stage.createShaderProducer(
        { fragmentSource: screenFragment, features: ["screen-texture"] },
        2,
        2,
      ),
    );
    const target = fake.gl.createFramebuffer();
    fake.gl.bindFramebuffer(fake.gl.FRAMEBUFFER, target);
    const list = createDrawList();
    const quad = createQuadView();
    quad.w = 4;
    quad.h = 4;
    list.pushQuad(quad);
    list.pushClipRect({
      x: 1,
      y: 2,
      w: 8,
      h: 7,
      cornerRadius: 0,
      outsetX: 0,
    });
    list.pushScreenEffect(
      createHeadlessScreenEffectCommand(producer, { time: 1, delta: 0.1 }),
    );
    list.pushQuad(quad);
    const executor = createCanvasExecutor({ gl: fake.gl });
    fake.reset();
    expect(executor.execute(list, fakeProjection(16, 16))).toBe(true);
    const firstDraw = fake.calls.findIndex(
      (call) => call.name === "drawArraysInstanced",
    );
    const snapshot = fake.calls.findIndex(
      (call) => call.name === "blitFramebuffer",
    );
    const laterDraw = fake.calls.findLastIndex(
      (call) => call.name === "drawArraysInstanced",
    );
    expect(firstDraw).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(laterDraw);
    expect(
      fake
        .named("bindFramebuffer")
        .some(
          (call) =>
            call.args[0] === fake.gl.READ_FRAMEBUFFER &&
            call.args[1] === target,
        ),
    ).toBe(true);
    expect([producer.target.width, producer.target.height]).toEqual([16, 16]);
    const finalBlit = fake.calls.findLastIndex(
      (call) => call.name === "blitFramebuffer",
    );
    expect(
      fake.calls.slice(0, finalBlit).findLast((call) => call.name === "scissor")
        ?.args,
    ).toEqual([1, 7, 8, 7]);
  });

  it("restores a caller FBO after direct producer rendering", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createShaderProducer(
        { fragmentSource: fragment },
        8,
        8,
      ),
    );
    const caller = fake.gl.createFramebuffer();
    fake.gl.bindFramebuffer(fake.gl.FRAMEBUFFER, caller);
    value(producer.render({ time: 0, delta: 0 }));
    expect(fake.gl.getParameter(fake.gl.FRAMEBUFFER_BINDING)).toBe(caller);
  });

  it("refuses a screen-dependent pass for partial damage", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createShaderProducer(
        { fragmentSource: screenFragment, features: ["screen-texture"] },
        8,
        8,
      ),
    );
    expect(
      producer.renderScreen(
        { time: 0, delta: 0 },
        {
          gl: fake.gl,
          framebuffer: null,
          width: 8,
          height: 8,
          damage: { x: 0, y: 0, width: 1, height: 1 },
          scissor: { x: 0, y: 0, width: 1, height: 1 },
        },
      ),
    ).toMatchObject({ ok: false, diagnostic: { feature: "partial-damage" } });
  });

  it("fails closed when a required recorded screen pass fails", () => {
    const fake = createFakeGl();
    const list = createDrawList();
    list.pushScreenEffect({ screenDependent: true, execute: () => false });
    const executor = createCanvasExecutor({ gl: fake.gl });
    expect(executor.execute(list, fakeProjection(8, 8))).toBe(false);
    expect(executor.stats.screenEffectFailures).toBe(1);
  });

  it("uses explicit particle inputs deterministically without a timer or per-frame allocation", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createParticleProducer(
        particles,
        100,
        80,
      ),
    );
    const input = { time: 3.5, delta: 1 / 60, seed: 42 };
    expect(producer.render(input).ok).toBe(true);
    fake.reset();
    expect(producer.render(input).ok).toBe(true);
    const first = JSON.stringify(
      fake.calls.filter(
        (call) => call.name.startsWith("uniform") || call.name === "drawArrays",
      ),
    );
    expect(fake.named("texImage2D")).toEqual([]);
    fake.reset();
    expect(producer.render(input).ok).toBe(true);
    const second = JSON.stringify(
      fake.calls.filter(
        (call) => call.name.startsWith("uniform") || call.name === "drawArrays",
      ),
    );
    expect(second).toBe(first);
    expect(fake.named("drawArrays").at(-1)?.args).toEqual([
      fake.gl.POINTS,
      0,
      16,
    ]);
    expect(source).toContain("if (v_alive < 0.5) discard;");
    expect(source).toContain("step(0.0, birth)");
  });

  it("runs the core Godot particle state and packed instance bytes into an owned stage target", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const sprite = value(
      stage.createShaderProducer({ fragmentSource: fragment }, 8, 4),
    ).target;
    const scratch = createGodotParticleScratch({
      amount: 3,
      lifetime: 1,
      emitting: true,
      seed: 17,
      textureUrl: "caller-owned",
      textureWidth: 8,
      textureHeight: 4,
      hframes: 2,
      vframes: 1,
      initialVelocityMin: 0,
      initialVelocityMax: 0,
      gravity: [0, 0],
    });
    const producer = value(
      stage.createGodotParticleProducer(
        {
          spriteTexture: sprite,
          scratch,
        },
        32,
        16,
      ),
    );
    value(producer.render({ time: 1, delta: 1 / 30, emitting: true }));
    expect(producer.target.texture).not.toBe(sprite.texture);
    expect(scratch.instances.count).toBeGreaterThan(0);
    const bytes = Array.from(
      scratch.instances.data.slice(0, scratch.instances.count * 10),
    );
    fake.reset();
    value(producer.render({ time: 1, delta: 0, emitting: true }));
    expect(
      Array.from(scratch.instances.data.slice(0, scratch.instances.count * 10)),
    ).toEqual(bytes);
    expect(fake.named("texImage2D")).toEqual([]);
    expect(source).not.toMatch(
      /document|requestAnimationFrame|setTimeout|MutationObserver/,
    );
  });

  it("preprocesses a direct particle pass before its first draw and after restart", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const scratch = createGodotParticleScratch({
      amount: 5,
      lifetime: 10,
      preprocess: 100,
      emitting: true,
      gravity: [50, 0],
    });
    const pass = value(stage.createGodotParticleDirectPass({ scratch }));
    const context = {
      gl: fake.gl,
      framebuffer: null,
      width: 64,
      height: 48,
      scissor: { x: 0, y: 0, width: 64, height: 48 },
    };
    value(pass.draw({ time: 0, delta: 0, emitting: true }, context));
    expect(scratch.instances.count).toBeGreaterThanOrEqual(4);
    expect(
      Math.max(
        ...scratch.state.particles.map((particle) => Math.abs(particle.x)),
      ),
    ).toBeGreaterThan(100);
    value(
      pass.draw({ time: 0, delta: 0, emitting: true, restart: true }, context),
    );
    expect(scratch.instances.count).toBeGreaterThanOrEqual(4);
  });

  it("applies optional straight inherited RGBA modulation to direct instances", () => {
    const fake = createFakeGl();
    const scratch = createGodotParticleScratch({
      amount: 1,
      lifetime: 1,
      emitting: true,
      baseColor: [0.8, 0.6, 0.4, 0.5],
      baseColorFromProcessMaterial: false,
      initialVelocityMin: 0,
      initialVelocityMax: 0,
      gravity: [0, 0],
    });
    const pass = value(
      createHeadlessEffectsStage(fake.gl).createGodotParticleDirectPass({
        scratch,
      }),
    );
    const context = {
      gl: fake.gl,
      framebuffer: null,
      width: 64,
      height: 48,
      scissor: { x: 0, y: 0, width: 64, height: 48 },
    };
    value(pass.draw({ time: 1 / 30, delta: 1 / 30, emitting: true }, context));
    const defaultParticle = scratch.state.particles.find(
      (particle) => particle.active,
    )!;
    const expectPackedColor = (expected: readonly number[]): void => {
      const actual = scratch.instances.data.slice(5, 9);
      for (let index = 0; index < expected.length; index += 1)
        expect(actual[index]).toBeCloseTo(expected[index]);
    };
    expectPackedColor([
      defaultParticle.r,
      defaultParticle.g,
      defaultParticle.b,
      defaultParticle.a,
    ]);

    const inherited: [number, number, number, number] = [0.25, 0.5, 0.75, 0.2];
    value(
      pass.draw(
        {
          time: 2 / 30,
          delta: 1 / 30,
          emitting: true,
          modulate: inherited,
        },
        context,
      ),
    );
    const modulatedParticle = scratch.state.particles.find(
      (particle) => particle.active,
    )!;
    expectPackedColor([
      modulatedParticle.r * inherited[0],
      modulatedParticle.g * inherited[1],
      modulatedParticle.b * inherited[2],
      modulatedParticle.a * inherited[3],
    ]);
    expect(
      pass.draw(
        {
          time: 3 / 30,
          delta: 1 / 30,
          emitting: true,
          modulate: [1, Number.NaN, 1, 1],
        },
        context,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "INVALID_RENDER_INPUT", feature: "modulate" },
    });
  });

  it("draws Godot particles directly into an executor target without a system surface", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const scratch = createGodotParticleScratch({
      amount: 1,
      lifetime: 1,
      emitting: true,
      seed: 17,
      initialVelocityMin: 0,
      initialVelocityMax: 0,
      gravity: [0, 0],
    });
    const pass = value(stage.createGodotParticleDirectPass({ scratch }));
    const list = createDrawList();
    list.pushExternalEffect(
      createHeadlessGodotParticleDirectEffect(pass, {
        time: 1 / 30,
        delta: 1 / 30,
        emitting: true,
        origin: [3, 5],
        transform: [2, 0, 0, 2, 10, 20],
      }),
    );
    const executor = createCanvasExecutor({ gl: fake.gl });
    fake.reset();
    expect(executor.execute(list, fakeProjection(64, 48))).toBe(true);
    expect(executor.stats.externalEffects).toBe(1);
    expect(executor.stats.externalEffectFailures).toBe(0);
    expect(fake.named("createTexture")).toEqual([]);
    expect(fake.named("createFramebuffer")).toEqual([]);
    expect(scratch.instances.count).toBeGreaterThan(0);
    const particle = scratch.state.particles.find((value) => value.active)!;
    expect(scratch.instances.data[0]).toBeCloseTo((3 + particle.x) * 2 + 10);
    expect(scratch.instances.data[1]).toBeCloseTo((5 + particle.y) * 2 + 20);
    expect(scratch.instances.data[2]).toBeCloseTo(32);
    expect(scratch.instances.data[4]).toBeCloseTo(0);
    expect(
      pass.draw(
        {
          time: 2 / 30,
          delta: 1 / 30,
          emitting: true,
          transform: [1, 0, 0.5, 1, 0, 0],
        },
        {
          gl: fake.gl,
          framebuffer: null,
          width: 64,
          height: 48,
          scissor: { x: 0, y: 0, width: 64, height: 48 },
        },
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_PARTICLE_FEATURE",
        feature: "transform",
      },
    });
    fake.reset();
    stage.invalidateContextLoss();
    expect(fake.named("deleteProgram")).toEqual([]);
    expect(fake.named("deleteBuffer")).toEqual([]);
    expect(
      pass.draw(
        {
          time: 2 / 30,
          delta: 1 / 30,
          emitting: true,
          transform: [1, 0, 0, 1, 0, 0],
        },
        {
          gl: fake.gl,
          framebuffer: null,
          width: 64,
          height: 48,
          scissor: { x: 0, y: 0, width: 64, height: 48 },
        },
      ).ok,
    ).toBe(true);
    expect(fake.named("createProgram")).toHaveLength(2);
  });

  it("shares one additive accumulator across direct systems on one GL context", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const direct = () =>
      value(
        stage.createGodotParticleDirectPass({
          config: {
            amount: 1,
            lifetime: 1,
            emitting: true,
            blendMode: 1,
            initialVelocityMin: 0,
            initialVelocityMax: 0,
            gravity: [0, 0],
          },
        }),
      );
    const first = direct();
    const second = direct();
    const context = {
      gl: fake.gl,
      framebuffer: null,
      width: 64,
      height: 48,
      scissor: { x: 0, y: 0, width: 64, height: 48 },
    };
    fake.reset();
    value(first.draw({ time: 1 / 30, delta: 1 / 30, emitting: true }, context));
    value(
      second.draw({ time: 1 / 30, delta: 1 / 30, emitting: true }, context),
    );
    // Both direct systems borrow the core renderer's one context-scoped
    // resolve target. There is no per-system target/FBO compositor surface.
    expect(fake.named("texImage2D")).toHaveLength(1);
    expect(fake.named("framebufferTexture2D")).toHaveLength(1);
    expect(fake.named("drawArraysInstanced")).toHaveLength(2);
    expect(fake.named("drawArrays")).toHaveLength(2);
  });

  it("refuses unresolved or foreign Godot particle textures before target mutation", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    expect(
      stage.createGodotParticleProducer(
        {
          config: {},
          spriteTexture: {
            texture: null,
            framebuffer: null,
            width: 4,
            height: 4,
          },
        },
        4,
        4,
      ),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "FOREIGN_TARGET", feature: "sprite-texture" },
    });
    expect(
      stage.createGodotParticleProducer(
        {
          config: {},
          spriteTexture: {
            texture: fake.gl.createTexture(),
            framebuffer: fake.gl.createFramebuffer(),
            width: 0,
            height: 1,
          },
        },
        4,
        4,
      ),
    ).toMatchObject({ ok: false, diagnostic: { code: "FOREIGN_TARGET" } });
    expect(
      stage.createGodotParticleProducer(
        {
          config: {},
          features: { collision: true },
        },
        4,
        4,
      ),
    ).toMatchObject({ ok: false, diagnostic: { feature: "collision" } });
  });

  it("uses the shared polar, erosion, mask, LUT and additive-resolve particle path", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const sourceTarget = () =>
      value(stage.createShaderProducer({ fragmentSource: fragment }, 4, 4))
        .target;
    const sprite = sourceTarget();
    const lut = sourceTarget();
    const mask = sourceTarget();
    const producer = value(
      stage.createGodotParticleProducer(
        {
          config: {
            amount: 2,
            lifetime: 1,
            textureUrl: "live",
            textureWidth: 4,
            textureHeight: 4,
            initialVelocityMin: 0,
            initialVelocityMax: 0,
            gravity: [0, 0],
            blendMode: 1,
            uvPolar: true,
            alphaErode: { threshold: 0.2, softness: 0.3 },
            alphaFromRed: true,
          },
          spriteTexture: sprite,
          lutTexture: lut,
          maskTexture: mask,
        },
        16,
        16,
      ),
    );
    value(producer.render({ time: 1 / 30, delta: 1 / 30, emitting: true }));
    expect(fake.named("drawArraysInstanced")).toHaveLength(1);
    expect(fake.named("drawArrays")).toHaveLength(1); // exact additive resolve
    expect(
      fake.named("bindTexture").some((call) => call.args[1] === mask.texture),
    ).toBe(true);
  });

  it("applies authored preprocess to target-backed flipbook particles, including restart", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const scratch = createGodotParticleScratch({
      amount: 1,
      lifetime: 1,
      preprocess: 0.5,
      textureWidth: 8,
      textureHeight: 8,
      hframes: 2,
      vframes: 2,
      initialVelocityMin: 0,
      initialVelocityMax: 0,
      gravity: [0, 0],
    });
    const producer = value(
      stage.createGodotParticleProducer({ scratch }, 16, 16),
    );

    value(producer.render({ time: 0, delta: 0, emitting: true }));
    expect(scratch.state.time).toBeCloseTo(0.5, 6);

    value(
      producer.render({ time: 0, delta: 0, emitting: true, restart: true }),
    );
    expect(scratch.state.time).toBeCloseTo(0.5, 6);
  });

  it("requires monotonic reconciled caller time and rejects mismatched scratch before allocation", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const scratch = createGodotParticleScratch({ amount: 1, seed: 4 });
    expect(
      stage.createGodotParticleProducer(
        {
          config: { amount: 2, seed: 4 },
          scratch,
        },
        8,
        8,
      ),
    ).toMatchObject({ ok: false, diagnostic: { feature: "scratch-config" } });
    const producer = value(
      stage.createGodotParticleProducer({ scratch }, 8, 8),
    );
    value(producer.render({ time: 1 / 30, delta: 1 / 30, emitting: true }));
    expect(
      producer.render({ time: 1 / 30, delta: 1 / 60, emitting: true }),
    ).toMatchObject({
      ok: false,
      diagnostic: { feature: "time-delta" },
    });
    expect(
      producer.render({ time: 0, delta: 0, emitting: true }),
    ).toMatchObject({
      ok: false,
      diagnostic: { feature: "time" },
    });
    expect(
      producer.render({ time: 0, delta: 0, emitting: true, restart: true }).ok,
    ).toBe(true);
  });

  it("borrows a same-context texture handle without requiring an FBO or deleting it", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const borrowed = { texture: fake.gl.createTexture()!, width: 8, height: 4 };
    const producer = value(
      stage.createGodotParticleProducer(
        {
          config: {
            amount: 1,
            textureUrl: "cache",
            textureWidth: 8,
            textureHeight: 4,
          },
          spriteTexture: borrowed,
        },
        8,
        8,
      ),
    );
    value(producer.render({ time: 1 / 30, delta: 1 / 30, emitting: true }));
    fake.reset();
    producer.dispose();
    expect(
      fake
        .named("deleteTexture")
        .some((call) => call.args[0] === borrowed.texture),
    ).toBe(false);
    expect(
      stage.createGodotParticleProducer(
        {
          config: { textureUrl: "dead" },
          spriteTexture: { texture: null, width: 1, height: 1 } as never,
        },
        4,
        4,
      ),
    ).toMatchObject({ ok: false, diagnostic: { code: "FOREIGN_TARGET" } });
  });

  it("keeps the shared particle program live until the final producer release", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const first = value(
      stage.createGodotParticleProducer({ config: { amount: 1 } }, 8, 8),
    );
    const second = value(
      stage.createGodotParticleProducer({ config: { amount: 1 } }, 8, 8),
    );
    value(first.warmUp());
    value(second.warmUp());
    fake.reset();
    first.dispose();
    expect(fake.named("deleteProgram")).toHaveLength(0);
    expect(second.render({ time: 0, delta: 0, emitting: true }).ok).toBe(true);
    second.dispose();
    expect(fake.named("deleteProgram").length).toBe(2);
  });

  it("uploads vec3 uniforms with uniform3f", () => {
    const fake = createFakeGl();
    const producer = value(
      createHeadlessEffectsStage(fake.gl).createShaderProducer(
        { fragmentSource: vec3Fragment, uniforms: { u_tint: [0.1, 0.2, 0.3] } },
        2,
        2,
      ),
    );
    value(producer.render({ time: 0, delta: 0 }));
    expect(
      fake
        .named("uniform3f")
        .some((call) => call.args.slice(1).join(",") === "0.1,0.2,0.3"),
    ).toBe(true);
  });

  it("invalidates without GL deletion and lazily recreates the exact last allocation", () => {
    const fake = createFakeGl();
    const stage = createHeadlessEffectsStage(fake.gl);
    const producer = value(stage.createParticleProducer(particles, 21, 13));
    value(producer.render({ time: 1, delta: 0.1, seed: 1 }));
    fake.reset();
    stage.invalidateContextLoss();
    expect(fake.calls).toEqual([]);
    expect(producer.target.texture).toBeNull();
    expect(producer.render({ time: 1, delta: 0.1, seed: 1 }).ok).toBe(true);
    expect(fake.named("texImage2D").at(-1)?.args.slice(3, 5)).toEqual([21, 13]);
  });

  it("refuses unsupported source capabilities with typed diagnostics", () => {
    const stage = createHeadlessEffectsStage(createFakeGl().gl);
    const shader = stage.createShaderProducer(
      { fragmentSource: fragment, features: ["external-textures"] },
      1,
      1,
    );
    expect(shader).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_SHADER_FEATURE",
        feature: "external-textures",
      },
    });
    const particle = stage.createParticleProducer(
      { ...particles, features: { collision: true } },
      1,
      1,
    );
    expect(particle).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_PARTICLE_FEATURE",
        feature: "collision",
      },
    });
    const sampler = stage.createShaderProducer(
      {
        fragmentSource: fragment.replace(
          "out vec4",
          "uniform sampler2D u_other;\nout vec4",
        ),
      },
      1,
      1,
    );
    expect(sampler).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_SHADER_FEATURE",
        feature: "external-textures",
      },
    });
    const implicitScreen = stage.createShaderProducer(
      { fragmentSource: screenFragment },
      1,
      1,
    );
    expect(implicitScreen).toMatchObject({
      ok: false,
      diagnostic: {
        code: "UNSUPPORTED_SHADER_FEATURE",
        feature: "screen-texture",
      },
    });
    expect(
      stage.createShaderProducer(
        { fragmentSource: fragment, features: ["seed", "seed"] },
        1,
        1,
      ),
    ).toMatchObject({ ok: false, diagnostic: { feature: "seed" } });
    expect(
      stage.createParticleProducer(
        { ...particles, startColor: [2, 0, 0, 1] },
        1,
        1,
      ),
    ).toMatchObject({ ok: false, diagnostic: { feature: "parameters" } });
    const valid = value(stage.createParticleProducer(particles, 1, 1));
    expect(valid.render({ time: Number.NaN, delta: 0, seed: 0 })).toMatchObject(
      {
        ok: false,
        diagnostic: { code: "INVALID_RENDER_INPUT" },
      },
    );
  });

  it("has no DOM, canvas creation, or scheduling dependency", () => {
    expect(source).not.toMatch(
      /\b(document|HTMLElement|createElement|getContext|requestAnimationFrame|setTimeout)\b/,
    );
  });
});
