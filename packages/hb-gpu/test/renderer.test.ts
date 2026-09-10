// What `createHbGpuRenderer` does when things go wrong, checked without a GPU.
//
// THE PIXEL TEST CANNOT SEE ANY OF THIS. `glyphPixelXvfb.test.ts` needs a real Chromium, a real
// driver and a `dist/` that only `build.sh` produces, so it is skipped on most checkouts and it
// grades a picture. The properties below are the opposite kind: they are about what the renderer
// REFUSES to do, and the whole difficulty with them is that every one of them, done wrong, produces
// a frame that looks right or a frame that is silently empty.
//
// Two of them are the reason this file exists at all:
//
//   1. THE EVICTION GENERATION GUARD. `push` used to draw a slot whose allocation had been evicted,
//      using the stale offset — a DIFFERENT glyph's outline, at the right size, in the right
//      position, perfectly antialiased. No ink metric, no registration metric and no RMS can tell
//      that from correct text. The perf harness never hit it because it pre-sizes the atlas to the
//      entire known working set, which is exactly what a live app cannot do.
//   2. CONSTRUCT-OR-NULL. Every failure used to be a throw, which is right for a measurement arm
//      and wrong for a renderer a product falls back from. `null` plus a named reason is the repo's
//      idiom (`createCanvasStage`); a silent `null` would be worse than a throw, because a renderer
//      that declined reports as a cheap one.

import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../canvas/test/fake-gl";
import type {
  EncodedGlyph,
  HbGpu,
  HbGpuFailure,
  HbGpuFont,
} from "../src/index";
import {
  ATLAS_WIDTH,
  createHbGpuRenderer,
  HB_GPU_CONTRAST_NONE,
  type HbGpuContrast,
  type HbGpuFace,
} from "../src/webgl";

/**
 * A stand-in for the wasm module. The renderer reads exactly one thing out of it.
 *
 * The GLSL is empty on purpose: the fake GL never compiles anything, and a copy of HarfBuzz's
 * shader library here would only be a second thing to keep in step with the wasm.
 */
function fakeModule(): HbGpu {
  return {
    heapBytes: 0,
    shaderLibrary: () => "",
    createFont: () => null,
    destroy: () => {},
  };
}

/** Deterministic blobs: glyph `id` encodes to `texels` texels whose first byte is `id`. */
function fakeFont(
  options: { upem?: number; texels?: number; encode?: boolean } = {},
): HbGpuFont & { encodeCalls: number[]; alive: boolean } {
  const texels = options.texels ?? 400;
  const font = {
    upem: options.upem ?? 1000,
    encodeCalls: [] as number[],
    alive: true,
    glyphFor: (codepoint: number) => codepoint,
    // The renderer is handed pre-shaped glyph ids and never shapes; this satisfies the interface
    // and would fail loudly rather than plausibly if that ever stopped being true.
    shape: () => null,
    encode(id: number): EncodedGlyph | null {
      font.encodeCalls.push(id);
      if (options.encode === false || !font.alive) return null;
      const bytes = new Uint8Array(texels * 8);
      bytes[0] = id & 0xff;
      return {
        texels: bytes,
        extents: { xBearing: 0, yBearing: 700, width: 600, height: -700 },
      };
    },
    destroy() {
      font.alive = false;
    },
  };
  return font;
}

/** A renderer plus the fake context under it, with failures collected rather than thrown. */
function makeRenderer(
  options: Parameters<typeof createFakeGl>[0] & {
    atlasTexels?: number;
    /** The DESIGN pair — object space, the units `push` takes. */
    design?: [number, number];
    /** The ACHIEVED drawing buffer. Omitted means "same as design", i.e. a DPR of 1. */
    framebuffer?: [number, number];
    /** Omitted means OMITTED — the renderer's own default, which is what a consumer gets. */
    contrast?: HbGpuContrast;
    perInstanceRunState?: boolean;
  } = {},
) {
  const { atlasTexels, design, framebuffer, contrast, perInstanceRunState, ...glOptions } = options;
  const fake = createFakeGl(glOptions);
  const failures: HbGpuFailure[] = [];
  const renderer = createHbGpuRenderer(fakeModule(), {
    gl: fake.gl,
    designWidth: design?.[0] ?? 640,
    designHeight: design?.[1] ?? 480,
    framebufferWidth: framebuffer?.[0],
    framebufferHeight: framebuffer?.[1],
    atlasTexels,
    contrast,
    perInstanceRunState,
    onError: (failure) => failures.push(failure),
  });
  return { fake, failures, renderer };
}

const reasons = (failures: HbGpuFailure[]) => failures.map((f) => f.reason);

/**
 * Which uniform a recorded `uniform*` call wrote.
 *
 * `createFakeGl().getUniformLocation` hands back a tagged object rather than the name, so a naive
 * `String(call.args[0])` is `"[object Object]"` for EVERY uniform — a filter written that way
 * matches nothing and the assertion under it passes on an empty list.
 */
function uniformName(location: unknown): string {
  if (typeof location !== "object" || location === null) return "";
  const tag = (location as { __gl?: unknown }).__gl;
  return typeof tag === "string" && tag.startsWith("uniform:")
    ? tag.slice("uniform:".length)
    : "";
}

describe("createHbGpuRenderer construct-or-null", () => {
  it("builds on a working context and reports nothing", () => {
    const { renderer, failures } = makeRenderer();
    expect(renderer).not.toBeNull();
    expect(failures).toEqual([]);
    expect(renderer?.atlasWidth).toBe(ATLAS_WIDTH);
  });

  for (const [name, options, reason] of [
    ["an already-lost context", { contextLost: true }, "context-lost"],
    [
      "a shader that will not compile",
      { compileFails: true },
      "shader-compile",
    ],
    ["a program that will not link", { linkFails: true }, "program-link"],
    [
      "a linker that dropped an attribute",
      { missingAttributes: ["a_glyphLoc"] },
      "program-link",
    ],
    [
      "gl.createProgram returning null",
      { failCreate: ["program"] },
      "gl-object",
    ],
    ["gl.createShader returning null", { failCreate: ["shader"] }, "gl-object"],
    [
      "gl.createTexture returning null",
      { failCreate: ["texture"] },
      "gl-object",
    ],
    [
      "gl.createVertexArray returning null",
      { failCreate: ["vao"] },
      "gl-object",
    ],
    [
      "a MAX_TEXTURE_SIZE below any usable atlas",
      { maxTextureSize: 512 },
      "texture-size",
    ],
  ] as const) {
    it(`returns null and names the reason for ${name}`, () => {
      const { renderer, failures } = makeRenderer({ ...options });
      // NULL, NOT A THROW: the consumer has a DOM text path to fall back to, and only it knows
      // whether falling back is acceptable.
      expect(renderer).toBeNull();
      expect(reasons(failures)).toContain(reason);
      // ...but never a silent null. A renderer that declined without saying so reports as a cheap
      // one, which in a perf table is a measurement of something that did not happen.
      expect(failures[0]?.message).toMatch(/^hb-gpu: /);
      expect(
        failures[0]?.message.replace("hb-gpu: ", "").length,
      ).toBeGreaterThan(20);
    });
  }

  it("does not leak the objects it built before the failure", () => {
    // Link fails after the program exists, so the program has to be deleted on the way out. A
    // construct-or-null that leaked would burn a program per attempt on a device that always fails.
    const { fake, renderer } = makeRenderer({ linkFails: true });
    expect(renderer).toBeNull();
    expect(fake.named("deleteProgram").length).toBe(1);
    expect(fake.named("deleteShader").length).toBe(2);
  });
});

describe("atlas capability probe", () => {
  it("clamps the width to MAX_TEXTURE_SIZE and tells the shader about it", () => {
    // WebGL2 guarantees only 2048. `ATLAS_WIDTH` was a hardcoded 4096 with no probe: on such a
    // device `texImage2D` fails, the sampler reads zero, and the page has no text on it.
    const { renderer, failures, fake } = makeRenderer({
      maxTextureSize: 2048,
      atlasTexels: 4096,
    });
    expect(renderer?.atlasWidth).toBe(2048);
    expect(reasons(failures)).toContain("atlas-clamped");
    // Two rows of 2048, not one of 4096 — the reservation is a property of the device now.
    expect(renderer?.atlas.capacityTexels).toBe(4096);
    expect(renderer?.atlas.reservationBytes).toBe(4096 * 8);
    const created = fake
      .named("texImage2D")
      .find((call) => call.args[3] === 2048);
    expect(
      created,
      "the texture was not created at the clamped width",
    ).toBeTruthy();

    // And the shader is handed the achieved width, not the module constant. Getting this wrong
    // unwraps every offset at the wrong stride, which reads band headers as curve data.
    const face = renderer?.registerFace(fakeFont({ texels: 4 }), "f");
    const slot =
      face && renderer?.upload(face, 7, fakeFont({ texels: 4 }).encode(7)!);
    renderer?.begin();
    if (slot) renderer?.push(slot, 0, 0, 14);
    renderer?.end();
    const widthUniform = fake
      .named("uniform1i")
      .map((call) => call.args[1])
      .filter((value) => value === 2048);
    expect(widthUniform.length).toBe(1);
  });
});

describe("face namespacing", () => {
  it("keeps glyph 42 of one face away from glyph 42 of another", () => {
    // THE BUG THIS PREVENTS renders fluent, crisp, WRONG text. Before `registerFace` the atlas key
    // was a caller-supplied string and nothing at this layer could tell the two faces apart.
    const { renderer } = makeRenderer({ atlasTexels: 4096 });
    const fontA = fakeFont({ texels: 100 });
    const fontB = fakeFont({ texels: 100 });
    const a = renderer?.registerFace(fontA, "noto");
    const b = renderer?.registerFace(fontB, "roboto");
    expect(a?.id).not.toBe(b?.id);

    const slotA = renderer?.upload(a!, 42, fontA.encode(42)!);
    const slotB = renderer?.upload(b!, 42, fontB.encode(42)!);
    expect(slotA?.loc).toBe(0);
    expect(slotB?.loc).toBe(100);
    expect(slotA?.key).not.toBe(slotB?.key);
    expect(renderer?.atlas.entries).toBe(2);
    expect(renderer?.atlas.faces).toBe(2);
  });

  it("refuses a face whose upem would make every glyph NaN", () => {
    // `push` divides by `upem`. A zero makes the scale Infinity, every instance record NaN, and the
    // draw a silent no-op — a blank page with no error anywhere.
    const { renderer, failures } = makeRenderer();
    expect(renderer?.registerFace(fakeFont({ upem: 0 }), "broken")).toBeNull();
    expect(reasons(failures)).toContain("degenerate-upem");
  });

  it("refuses a face handle it never issued", () => {
    const { renderer, failures } = makeRenderer();
    const other = makeRenderer();
    const font = fakeFont({ texels: 4 });
    const foreign = other.renderer?.registerFace(font, "elsewhere");
    expect(renderer?.upload(foreign!, 1, font.encode(1)!)).toBeNull();
    expect(reasons(failures)).toContain("face-unregistered");
  });
});

describe("the eviction generation guard", () => {
  /** A 1024-texel atlas that holds exactly two 400-texel glyphs. */
  function tinyAtlas() {
    const made = makeRenderer({ maxTextureSize: 1024, atlasTexels: 1024 });
    const font = fakeFont({ texels: 400 });
    const face = made.renderer?.registerFace(font, "f");
    return { ...made, font, face: face! };
  }

  it("skips a slot whose allocation was evicted instead of drawing another glyph", () => {
    const { renderer, font, face } = tinyAtlas();
    const one = renderer?.upload(face, 1, font.encode(1)!);
    const two = renderer?.upload(face, 2, font.encode(2)!);
    expect(one?.loc).toBe(0);
    expect(two?.loc).toBe(400);

    // Glyph 3 wraps the cursor to 0 and lands on glyph 1's texels.
    const three = renderer?.upload(face, 3, font.encode(3)!);
    expect(three?.loc).toBe(0);
    expect(renderer?.atlas.evictions).toBe(1);

    renderer?.begin();
    // `one` still names offset 0, which now holds glyph 3's blob. Drawing it would put glyph 3's
    // outline exactly where glyph 1 belongs: right size, right place, perfectly antialiased.
    renderer?.push(one!, 10, 10, 14);
    renderer?.push(two!, 20, 10, 14);
    const frame = renderer?.end();
    expect(frame?.instances).toBe(1);
    expect(renderer?.atlas.staleSkips).toBe(1);
  });

  it("does not accept a slot whose key was re-used by a later allocation", () => {
    // THE CASE A KEY COMPARISON CANNOT CATCH, and the reason the slot carries a generation rather
    // than only a key: the glyph is evicted and then re-uploaded, so the key resolves again and the
    // stale slot's offset is still a plausible one — pointing at whatever now lives there.
    const { renderer, font, face } = tinyAtlas();
    const oneFirst = renderer?.upload(face, 1, font.encode(1)!);
    renderer?.upload(face, 2, font.encode(2)!);
    renderer?.upload(face, 3, font.encode(3)!); // evicts glyph 1
    const oneAgain = renderer?.upload(face, 1, font.encode(1)!); // evicts glyph 2

    expect(oneAgain?.key).toBe(oneFirst?.key);
    expect(oneAgain?.generation).not.toBe(oneFirst?.generation);

    renderer?.begin();
    renderer?.push(oneFirst!, 0, 0, 14);
    expect(renderer?.end().instances).toBe(0);

    renderer?.begin();
    renderer?.push(oneAgain!, 0, 0, 14);
    expect(renderer?.end().instances).toBe(1);
  });

  it("throws only when the atlas cannot hold ONE frame's glyphs", () => {
    // THE ONE THROW LEFT IN THE PACKAGE, and it is a sizing bug in the embedder rather than a
    // runtime condition: evicting the victim draws the wrong outline, declining the newcomer leaves
    // the frame short every frame forever, and neither is something this layer can choose honestly.
    const { renderer, font, face } = tinyAtlas();
    const one = renderer?.upload(face, 1, font.encode(1)!);
    renderer?.upload(face, 2, font.encode(2)!);
    renderer?.begin();
    renderer?.push(one!, 0, 0, 14);
    expect(() => renderer?.upload(face, 3, font.encode(3)!)).toThrow(
      /already drawn this frame/,
    );
  });

  it("declines rather than throws for a blob no atlas of this size could hold", () => {
    // Data-dependent, unlike the guard above: one pathological outline in a font nobody chose. A
    // live app has to survive it with a hole in one run.
    const { renderer, failures } = makeRenderer({
      maxTextureSize: 1024,
      atlasTexels: 1024,
    });
    const font = fakeFont({ texels: 2000 });
    const face = renderer?.registerFace(font, "f");
    expect(renderer?.upload(face!, 1, font.encode(1)!)).toBeNull();
    expect(reasons(failures)).toContain("blob-too-large");
  });

  it("declines a blob that is not a whole number of texels", () => {
    const { renderer, failures } = makeRenderer();
    const font = fakeFont({ texels: 4 });
    const face = renderer?.registerFace(font, "f");
    const glyph = font.encode(1)!;
    expect(
      renderer?.upload(face!, 1, {
        ...glyph,
        texels: glyph.texels.subarray(0, 30),
      }),
    ).toBeNull();
    expect(reasons(failures)).toContain("blob-malformed");
  });

  it("returns null for an inkless glyph without allocating anything", () => {
    const { renderer, failures } = makeRenderer();
    const font = fakeFont({ texels: 4 });
    const face = renderer?.registerFace(font, "f");
    const empty: EncodedGlyph = {
      texels: new Uint8Array(0),
      extents: { xBearing: 0, yBearing: 0, width: 0, height: 0 },
    };
    expect(renderer?.upload(face!, 1, empty)).toBeNull();
    expect(renderer?.atlas.entries).toBe(0);
    // A space is not a failure.
    expect(failures).toEqual([]);
  });
});

describe("the pass in a borrowed context", () => {
  function drewOneGlyph(extra: Parameters<typeof makeRenderer>[0] = {}) {
    const made = makeRenderer({ atlasTexels: 4096, ...extra });
    const font = fakeFont({ texels: 100 });
    const face = made.renderer?.registerFace(font, "f");
    const slot = made.renderer?.upload(face!, 1, font.encode(1)!);
    made.fake.reset();
    made.renderer?.begin();
    made.renderer?.push(slot!, 10, 20, 14);
    const frame = made.renderer?.end();
    // `face` and `slot` come back so a case can draw a SECOND frame through the same renderer —
    // both are handles the renderer itself issued, and a fabricated one would be refused by the
    // registration and generation guards rather than drawn.
    return { ...made, frame, face, slot };
  }

  it("never clears and never sets the viewport", () => {
    // A clear inside a glyph pass erases everything the embedder's executor already drew, and a
    // viewport call silently overrides a scissored or letterboxed pass. Both were here while this
    // package owned a stage.
    const { fake, frame } = drewOneGlyph();
    expect(frame?.instances).toBe(1);
    expect(fake.named("clear")).toEqual([]);
    expect(fake.named("clearColor")).toEqual([]);
    expect(fake.named("viewport")).toEqual([]);
  });

  it("leaves exactly the state its doc comment promises", () => {
    const { fake } = drewOneGlyph();
    const draw = fake.draws[0];
    // Premultiplied MIX. Getting this wrong is SILENT — the picture is merely darker.
    expect(draw.blendEquation).toEqual([fake.gl.FUNC_ADD, fake.gl.FUNC_ADD]);
    expect(draw.blendFunc.slice(0, 2)).toEqual([
      fake.gl.ONE,
      fake.gl.ONE_MINUS_SRC_ALPHA,
    ]);
    expect(fake.named("enable").at(-1)?.args[0]).toBe(fake.gl.BLEND);
    // The VAO is left UNBOUND, not restored — WebGL2 has no cheap read-back of the binding.
    expect(fake.named("bindVertexArray").at(-1)?.args[0]).toBeNull();
    // Texture unit 0 holds the atlas when the pass returns.
    expect(draw.textures[0]).toBeTruthy();
  });

  it("keeps the default renderer on its compact uniform record layout", () => {
    const { fake } = makeRenderer();
    const floatInstances = fake
      .named("vertexAttribPointer")
      .filter((call) => call.args[4] === 40);
    expect(floatInstances).toHaveLength(3);
    expect(
      fake.named("vertexAttribIPointer").filter((call) => call.args[3] === 40),
    ).toHaveLength(1);
    const names = fake.named("getAttribLocation").map((call) => call.args[0]);
    expect(names).not.toContain("a_model0");
    expect(names).not.toContain("a_color");
    const { fake: drawn } = drewOneGlyph();
    const matrices = drawn.named("uniformMatrix4fv");
    expect((matrices[0]?.args[0] as { __gl?: string })?.__gl).toBe(
      "uniform:u_matViewProjection",
    );
    const sources = fake.named("shaderSource").map((call) => String(call.args[1]));
    const vertex = sources.find((source) => source.includes("a_normal"));
    const fragment = sources.find((source) => source.includes("fragColor"));
    expect(vertex).toContain("u_matViewProjection");
    expect(vertex).not.toContain("a_model0");
    expect(vertex).not.toContain("a_spreadPx");
    expect(fragment).not.toContain("v_spreadPx");
    expect(fragment).not.toContain("v_color");
  });

  it("uses expanded per-instance state only when the batching renderer requests it", () => {
    const { fake } = makeRenderer({ perInstanceRunState: true });
    expect(
      fake.named("vertexAttribPointer").filter((call) => call.args[4] === 84),
    ).toHaveLength(8);
    expect(
      fake.named("vertexAttribIPointer").filter((call) => call.args[3] === 84),
    ).toHaveLength(1);
    const names = fake.named("getAttribLocation").map((call) => call.args[0]);
    expect(names).toEqual(expect.arrayContaining(["a_model0", "a_color", "a_spreadPx"]));
  });

  it("updates legacy color and spread uniforms only when their retained values change", () => {
    const { fake, renderer, slot } = drewOneGlyph();
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 10, 20, 14);
    renderer?.end();
    expect(fake.named("uniform4fv")).toEqual([]);
    expect(
      fake.named("uniform1f").filter((call) => uniformName(call.args[0]) === "u_spreadPx"),
    ).toEqual([]);

    fake.reset();
    renderer?.setColor(0.2, 0.3, 0.4, 0.5);
    renderer?.setSpread(2.5);
    renderer?.begin();
    renderer?.push(slot!, 10, 20, 14);
    renderer?.end();
    expect(fake.named("uniform4fv")).toHaveLength(1);
    expect(
      fake.named("uniform1f").filter((call) => uniformName(call.args[0]) === "u_spreadPx")[0]?.args[1],
    ).toEqual(2.5);
  });

  it("ships contrast constants on program build, not every frame", () => {
    // WHAT A FAKE CONTEXT CAN SEE ABOUT A CONTRAST CURVE, and it is exactly the half
    // `glyphPixelXvfb.test.ts` cannot: that the DEFAULT is on, and that the uniforms are written
    // per frame rather than once at construction. The pixel suite needs a GPU and is skipped on
    // most checkouts, so "the shipped default is stem darkening" would otherwise be a claim nothing
    // in a plain `pnpm test` checks — and a default silently flipped to off draws perfectly good,
    // slightly washed-out text.
    const reads = (
      fake: ReturnType<typeof makeRenderer>["fake"],
      name: string,
    ) =>
      fake
        .named("uniform1f")
        .filter((call) => uniformName(call.args[0]) === name)
        .map((call) => call.args[1]);

    const constructed = makeRenderer();
    expect(reads(constructed.fake, "u_stemDarken")).toEqual([1]);
    expect(reads(constructed.fake, "u_gamma")).toEqual([1]);
    const { fake, renderer, slot } = drewOneGlyph();

    // Uniforms belong to this program, so using another program between frames cannot dirty
    // them. The hot path must not re-state constants.
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 10, 20, 14);
    renderer?.end();
    expect(reads(fake, "u_stemDarken")).toEqual([]);
    expect(reads(fake, "u_gamma")).toEqual([]);

    // AND THE SHADER REALLY CALLS IT. The uniform could be written by a program whose `main` no
    // longer uses it — the linker is allowed to keep the location — so the source is checked too.
    // A FRESH renderer, because `drewOneGlyph` resets the recorder after construction and the
    // compile happens there; reading `fake` above would find no `shaderSource` call at all and the
    // `find` would quietly return `undefined`.
    const fresh = makeRenderer({ atlasTexels: 4096 });
    const fragmentSource = fresh.fake
      .named("shaderSource")
      .map((call) => String(call.args[1]))
      .find((source) => source.includes("fragColor"));
    expect(
      fragmentSource,
      "no fragment source reached gl.shaderSource, so the check below is vacuous",
    ).toBeTruthy();
    expect(fragmentSource).toContain("hb_gpu_stem_darken");
  });

  it("takes HB_GPU_CONTRAST_NONE and a custom gamma through to the uniforms", () => {
    const reads = (
      fake: ReturnType<typeof makeRenderer>["fake"],
      name: string,
    ) =>
      fake
        .named("uniform1f")
        .filter((call) => uniformName(call.args[0]) === name)
        .map((call) => call.args[1]);

    // THE MEASUREMENT ARM'S OPT-OUT, checked as a value that reaches the program rather than as an
    // option somebody passed. `packages/perf-harness/src/scenarios/text-gpu.ts` passes exactly this.
    const off = makeRenderer({ contrast: HB_GPU_CONTRAST_NONE });
    expect(reads(off.fake, "u_stemDarken")).toEqual([0]);
    expect(reads(off.fake, "u_gamma")).toEqual([1]);
    expect(off.failures).toEqual([]);

    const gamma = makeRenderer({
      contrast: { gamma: 2.2, stemDarkening: false },
    });
    expect(reads(gamma.fake, "u_gamma")).toEqual([2.2]);
    expect(reads(gamma.fake, "u_stemDarken")).toEqual([0]);
    expect(gamma.failures).toEqual([]);
  });

  it("refuses a gamma `pow` cannot take, and says so instead of writing a NaN every frame", () => {
    // A NaN OR NON-POSITIVE EXPONENT IS NOT A WRONG PICTURE, it is an undefined one: `pow (cov,
    // NaN)` is a NaN alpha, and a NaN through a premultiplied MIX blend is whatever the driver
    // does with it — a black box on some, the previous frame on others. Neither reads as "somebody
    // typed a bad number into a renderer option", so it falls back to 1 and reports.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const constructed = makeRenderer({
        contrast: { gamma: bad, stemDarkening: true },
      });
      const written = constructed.fake
        .named("uniform1f")
        .filter((call) => uniformName(call.args[0]) === "u_gamma")
        .map((call) => call.args[1]);
      expect(
        written,
        `contrast.gamma ${String(bad)} reached the shader`,
      ).toEqual([1]);
      expect(reasons(constructed.failures)).toEqual(["degenerate-contrast"]);
      const drawn = drewOneGlyph({
        contrast: { gamma: bad, stemDarkening: true },
      });
      // NOT FATAL, and the difference matters: a renderer that refused to construct over a contrast
      // option would take a consumer's text away entirely to avoid making it slightly wrong.
      expect(
        drawn.fake.named("drawArraysInstanced").length,
        "the renderer stopped drawing over a bad gamma — it is supposed to fall back and report",
      ).toBe(1);
      // And the OTHER half of the option is untouched by the fallback.
      expect(
        constructed.fake
          .named("uniform1f")
          .filter((call) => uniformName(call.args[0]) === "u_stemDarken")
          .map((call) => call.args[1]),
      ).toEqual([1]);
    }
  });

  it("clamps a negative or non-finite spread to 0 rather than making a degenerate quad", () => {
    // `u_spreadPx > 0.0` is false for NaN, so the FRAGMENT would take the single-tap path — but the
    // VERTEX multiplies the corner normal by it unconditionally, so a NaN would collapse the quad
    // and the run would simply vanish. A negative one would shrink the quad inside the ink box and
    // clip the glyph's own antialiased rim. Neither reads as a bad argument.
    const { fake, renderer, slot } = drewOneGlyph();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      renderer?.setSpread(2);
      fake.reset();
      renderer?.setSpread(bad);
      renderer?.begin();
      renderer?.push(slot!, 10, 20, 14);
      renderer?.end();
      const written = fake
        .named("uniform1f")
        .find((call) => uniformName(call.args[0]) === "u_spreadPx")?.args[1];
      expect(written, `setSpread(${bad}) reached the shader`).toEqual(0);
    }
  });

  it("touches nothing at all on an empty frame", () => {
    const { fake, renderer } = makeRenderer();
    fake.reset();
    renderer?.begin();
    expect(renderer?.end()).toEqual({ instances: 0, drawCalls: 0 });
    expect(fake.calls).toEqual([]);
  });

  it("saves and restores UNPACK_ALIGNMENT around an upload", () => {
    // CONTEXT state, not texture state. `packages/canvas/src/textures.ts` sets it to 1 for its
    // tightly packed RGBA uploads; inheriting this file's 4 skews every row of the next texture
    // uploaded after the first glyph.
    const { fake, renderer } = makeRenderer({ atlasTexels: 4096 });
    fake.gl.pixelStorei(fake.gl.UNPACK_ALIGNMENT, 1);
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    renderer?.upload(face!, 1, font.encode(1)!);
    expect(fake.gl.getParameter(fake.gl.UNPACK_ALIGNMENT)).toBe(1);
    const alignmentCalls = fake
      .named("pixelStorei")
      .filter((call) => call.args[0] === fake.gl.UNPACK_ALIGNMENT)
      .map((call) => call.args[1]);
    expect(alignmentCalls).toEqual([1, 4, 1]);
  });

  it("forces the two WEBGL unpack flags false around an upload, and restores them", () => {
    // NOT A TIDINESS FIX — this pair is ILLEGAL for the upload below, not merely wrong for it.
    // WebGL2 defines `UNPACK_FLIP_Y_WEBGL` / `UNPACK_PREMULTIPLY_ALPHA_WEBGL` only for the
    // `texSubImage2D` overloads taking an image-like source, and requires `INVALID_OPERATION` when
    // either is true for an `ArrayBufferView` one — which is the overload `uploadTexels` uses.
    //
    // `packages/canvas/src/textures.ts` sets premultiply true for its colour uploads and leaves it
    // set, as it is entitled to. So ANY embedder that uploaded one texture before its first glyph
    // was making an illegal call, and on ANGLE/Vulkan the observed result was not the specified
    // error but the renderer process EXITING — no GL error, no exception, nothing on the console.
    // Found downstream in `sts2-couch-coop`, as a hard crash on the first atlas upload.
    const { fake, renderer } = makeRenderer({ atlasTexels: 4096 });
    fake.gl.pixelStorei(fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    fake.gl.pixelStorei(fake.gl.UNPACK_FLIP_Y_WEBGL, true);
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    renderer?.upload(face!, 1, font.encode(1)!);

    const flagCalls = (pname: number): unknown[] =>
      fake
        .named("pixelStorei")
        .filter((call) => call.args[0] === pname)
        .map((call) => call.args[1]);
    // Set by the test, forced false for the upload, restored. The middle value is the whole point.
    expect(flagCalls(fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toEqual([
      true,
      false,
      true,
    ]);
    expect(flagCalls(fake.gl.UNPACK_FLIP_Y_WEBGL)).toEqual([true, false, true]);

    // Ordering, because "false at some point" is not the claim — false BEFORE the upload is. A
    // restore that landed early would leave the illegal state in place for the texSubImage2D.
    const order = fake.calls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call }) =>
          call.name === "texSubImage2D" ||
          (call.name === "pixelStorei" &&
            call.args[0] === fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
      );
    const firstUpload = order.findIndex(
      ({ call }) => call.name === "texSubImage2D",
    );
    expect(order[firstUpload - 1]?.call.args[1]).toBe(false);

    // And the embedder's state is back, so its next colour upload still premultiplies. Restoring to
    // `false` here would composite every subsequent texture at a-squared — silently, as a darker
    // picture, which is the failure mode `pixelmatch` cannot see either.
    expect(fake.gl.getParameter(fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)).toBe(
      true,
    );
    expect(fake.gl.getParameter(fake.gl.UNPACK_FLIP_Y_WEBGL)).toBe(true);
  });

  it("leaves both unpack flags alone when the embedder already had them false", () => {
    // The common case, and it must cost nothing: a `pixelStorei` this renderer did not need to make
    // is a state change an embedder's own tracker may be caching against.
    const { fake, renderer } = makeRenderer({ atlasTexels: 4096 });
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    renderer?.upload(face!, 1, font.encode(1)!);
    const touched = fake
      .named("pixelStorei")
      .filter(
        (call) =>
          call.args[0] === fake.gl.UNPACK_FLIP_Y_WEBGL ||
          call.args[0] === fake.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      );
    expect(touched).toEqual([]);
  });

  it("re-projects when the embedder resizes its drawing buffer", () => {
    const { fake, renderer } = makeRenderer({
      atlasTexels: 4096,
      design: [640, 480],
    });
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    const slot = renderer?.upload(face!, 1, font.encode(1)!);
    renderer?.setViewport(320, 200);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    // `u_viewport` is what `hb_gpu_dilate` measures half a screen pixel against.
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([320, 200]);
    // And the projection is `createCanvasStage`'s `toClip`, to the byte: 2/w and -2/h, with the
    // NEGATIVE scaleY that turns y-down design space into y-up clip space.
    const mvp = fake.named("uniformMatrix4fv")[0].args[2] as Float32Array;
    // `Math.fround`, not `toBeCloseTo`: `toClip` is a Float32Array in both files, so "byte
    // identical to the stage" is an exact claim and worth asserting exactly.
    expect(mvp[0]).toBe(Math.fround(2 / 320));
    expect(mvp[5]).toBe(Math.fround(-2 / 200));
    expect(mvp[12]).toBe(-1);
    expect(mvp[13]).toBe(1);
  });

  it("projects from the DESIGN size and dilates against the FRAMEBUFFER size", () => {
    // THE 2x-DPR CASE, and the reason the two are separate parameters. `u_viewport` is what
    // `hb_gpu_dilate` turns half a SCREEN pixel into object units with, so handed the design size
    // on a 2x stage it dilates by half a DESIGN pixel — twice as far as it should.
    //
    // ON SCREEN, AT 2x, THAT IS INVISIBLE, which is exactly why it is asserted HERE as a uniform
    // rather than only in pixels. `hb_gpu_dilate` moves `position` and `texcoord` together, so the
    // shader's own ppem does not move with the quad and the extra fragments evaluate to coverage
    // 0 — measured at zero differing bytes on ANGLE/NVIDIA. It bites in the other direction, when
    // the buffer is smaller than design space and the AA rim is clipped off;
    // `packages/test-harness/test/canvasGlyphPixelXvfb.test.ts` is where both directions are put
    // through real pixels.
    const { fake, renderer } = makeRenderer({
      atlasTexels: 4096,
      design: [640, 480],
      framebuffer: [1280, 960],
    });
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    const slot = renderer?.upload(face!, 1, font.encode(1)!);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([1280, 960]);
    const mvp = fake.named("uniformMatrix4fv")[0].args[2] as Float32Array;
    expect(mvp[0]).toBe(Math.fround(2 / 640));
    expect(mvp[5]).toBe(Math.fround(-2 / 480));
  });

  it("defaults the framebuffer pair to the design pair", () => {
    // The standalone case — a canvas sized in device pixels, nothing scaling it — where the two
    // genuinely are one number and making a caller repeat it would be ceremony people copy wrong.
    const { fake, renderer } = makeRenderer({
      atlasTexels: 4096,
      design: [256, 128],
    });
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    const slot = renderer?.upload(face!, 1, font.encode(1)!);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([256, 128]);
  });

  it("setViewport moves both pairs, and defaults the second to the first", () => {
    const { fake, renderer } = makeRenderer({
      atlasTexels: 4096,
      design: [640, 480],
      framebuffer: [1280, 960],
    });
    const font = fakeFont({ texels: 100 });
    const face = renderer?.registerFace(font, "f");
    const slot = renderer?.upload(face!, 1, font.encode(1)!);
    renderer?.setViewport(800, 600, 2400, 1800);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([2400, 1800]);
    const mvp = fake.named("uniformMatrix4fv")[0].args[2] as Float32Array;
    expect(mvp[0]).toBe(Math.fround(2 / 800));

    // An unchanged viewport is not a state transition, so it must not re-dirty either uniform.
    renderer?.setViewport(800, 600, 2400, 1800);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    expect(fake.named("uniform2f")).toEqual([]);
    expect(fake.named("uniformMatrix4fv")).toEqual([]);

    // Two arguments means "they are the same", not "leave the old framebuffer pair alone" — the
    // latter would silently keep a 3x dilation on a stage that just went back to 1x.
    renderer?.setViewport(400, 300);
    fake.reset();
    renderer?.begin();
    renderer?.push(slot!, 0, 0, 14);
    renderer?.end();
    expect(fake.named("uniform2f")[0].args.slice(1)).toEqual([400, 300]);
  });
});

describe("resolve", () => {
  /** A renderer with one 100-texel glyph of one face already resident. */
  function withOneGlyph(atlasTexels = 4096) {
    const made = makeRenderer({ atlasTexels });
    const font = fakeFont({ texels: 100 });
    const face = made.renderer?.registerFace(font, "f");
    return { ...made, font, face: face! };
  }

  it("hands back a slot equal to the one upload gave, without an encoder", () => {
    // THE WHOLE POINT: a retained draw list stores slot IDS and has to turn them back into slots
    // every frame. `upload` needs an `EncodedGlyph`, and encoding a Han working set costs ~180 ms.
    const { renderer, font, face } = withOneGlyph();
    const uploaded = renderer?.upload(face, 7, font.encode(7)!);
    const before = font.encodeCalls.length;
    const resolved = renderer?.resolve(face, 7);
    expect(resolved).toEqual(uploaded);
    // Not one call into the encoder. That is the difference between a frame and a stall.
    expect(font.encodeCalls.length).toBe(before);
  });

  it("returns one immutable owned slot on the numeric hot path", () => {
    const { renderer, font, face } = withOneGlyph();
    const uploaded = renderer?.upload(face, 7, font.encode(7)!);
    const resolved = renderer?.resolve(face, 7);
    expect(resolved).toBe(uploaded);
    expect(resolved).toMatchObject({ faceId: face.id, glyphId: 7 });
  });

  it("accepts copied slots but refuses an owned slot from another renderer", () => {
    const first = withOneGlyph();
    const second = withOneGlyph();
    const original = first.renderer?.upload(
      first.face,
      7,
      first.font.encode(7)!,
    );
    // The ordinary structural copy keeps public numeric metadata but not the private provenance
    // marker. It remains source-compatible and stays on the per-face numeric path.
    const copy = { ...original! };
    first.renderer?.begin();
    first.renderer?.push(copy, 0, 0, 14);
    expect(first.renderer?.end().instances).toBe(1);
    // Old structural slots had no numeric metadata at all; their cold key fallback remains.
    const legacy = { ...copy };
    delete legacy.faceId;
    delete legacy.glyphId;
    first.renderer?.begin();
    first.renderer?.push(legacy, 0, 0, 14);
    expect(first.renderer?.end().instances).toBe(1);
    second.renderer?.begin();
    second.renderer?.push(original!, 0, 0, 14);
    expect(second.renderer?.end().instances).toBe(0);
    expect(second.renderer?.atlas.staleSkips).toBe(1);
  });

  it("returns null for a glyph that was never uploaded", () => {
    const { renderer, failures, face } = withOneGlyph();
    expect(renderer?.resolve(face, 99)).toBeNull();
    // A miss is the mechanism working, not a failure: the caller encodes and uploads.
    expect(failures).toEqual([]);
  });

  it("returns null for an evicted glyph, so the caller re-uploads instead of drawing stale", () => {
    const made = makeRenderer({ maxTextureSize: 1024, atlasTexels: 1024 });
    const font = fakeFont({ texels: 400 });
    const face = made.renderer?.registerFace(font, "f") as HbGpuFace;
    made.renderer?.upload(face, 1, font.encode(1)!);
    made.renderer?.upload(face, 2, font.encode(2)!);
    made.renderer?.upload(face, 3, font.encode(3)!); // wraps the cursor onto glyph 1
    expect(made.renderer?.atlas.evictions).toBe(1);

    expect(made.renderer?.resolve(face, 1)).toBeNull();
    // And a re-upload makes it resolvable again, at a NEW generation — the stale slot from before
    // the eviction still fails `push`'s guard, which is what stops a different outline being drawn
    // at the right size in the right place.
    const again = made.renderer?.upload(face, 1, font.encode(1)!);
    expect(made.renderer?.resolve(face, 1)?.generation).toBe(again?.generation);
  });

  it("refuses a face handle it never issued, loudly", () => {
    const { renderer, failures } = withOneGlyph();
    const other = makeRenderer();
    const foreign = other.renderer?.registerFace(fakeFont(), "elsewhere");
    expect(renderer?.resolve(foreign!, 1)).toBeNull();
    // Unlike a miss, this one is reported: a foreign handle is a bug in the embedder and the
    // symptom without a word about it is a run that draws nothing at all.
    expect(reasons(failures)).toContain("face-unregistered");
  });

  it("answers null while the context is lost, without touching GL", () => {
    const { fake, renderer, font, face } = withOneGlyph();
    renderer?.upload(face, 1, font.encode(1)!);
    renderer?.notifyContextLost();
    fake.reset();
    // The allocation table SURVIVES a loss — `rebuild` puts the same texels back at the same
    // offsets — but nothing may be drawn until it has, and a slot `push` would discard is worse
    // than a miss the caller can act on.
    expect(renderer?.resolve(face, 1)).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(renderer?.rebuild()).toBe(true);
    expect(renderer?.resolve(face, 1)).not.toBeNull();
  });
});

describe("context-loss lifecycle", () => {
  function lostAndRebuilt() {
    const made = makeRenderer({ atlasTexels: 4096 });
    const font = fakeFont({ texels: 100 });
    const face = made.renderer?.registerFace(font, "f");
    const one = made.renderer?.upload(face!, 1, font.encode(1)!);
    const two = made.renderer?.upload(face!, 2, font.encode(2)!);
    return { ...made, font, face: face!, one: one!, two: two! };
  }

  it("goes inert without calling into GL after a loss", () => {
    const { fake, renderer, font, face, one } = lostAndRebuilt();
    renderer?.notifyContextLost();
    expect(renderer?.contextLost).toBe(true);
    fake.reset();
    // NOT `gl.delete*`: every handle is already invalid, and freeing them is at best ignored and at
    // worst an INVALID_OPERATION the embedder's own error check reports as its bug.
    expect(renderer?.upload(face, 3, font.encode(3)!)).toBeNull();
    renderer?.begin();
    renderer?.push(one, 0, 0, 14);
    expect(renderer?.end()).toEqual({ instances: 0, drawCalls: 0 });
    expect(fake.calls).toEqual([]);
  });

  it("rebuilds the atlas byte for byte, so held slots stay valid", () => {
    // SAME OFFSETS, DELIBERATELY. Repacking would invalidate every slot the embedder holds, which
    // the generation guard would then turn into a silently empty frame — better than garbage, still
    // wrong. Re-materialising means a restore needs no cooperation beyond one call.
    const { fake, renderer, one, two, font } = lostAndRebuilt();
    const before = font.encodeCalls.length;
    renderer?.notifyContextLost();
    fake.reset();
    expect(renderer?.rebuild()).toBe(true);
    expect(renderer?.contextLost).toBe(false);
    // The blobs came back out of the retained FONT rather than a retained copy of the bytes: zero
    // resident bytes between the loss and the restore, at the cost of encoding again.
    expect(font.encodeCalls.slice(before)).toEqual([1, 2]);
    expect(fake.named("createProgram").length).toBe(1);
    expect(fake.named("texImage2D").length).toBe(1);
    expect(fake.named("texSubImage2D").length).toBe(2);

    renderer?.begin();
    renderer?.push(one, 0, 0, 14);
    renderer?.push(two, 0, 0, 14);
    expect(renderer?.end().instances).toBe(2);
    expect(renderer?.atlas.staleSkips).toBe(0);
  });

  it("drops the glyphs of a face whose font did not outlive the renderer", () => {
    const { renderer, failures, one, font } = lostAndRebuilt();
    font.destroy();
    renderer?.notifyContextLost();
    expect(renderer?.rebuild()).toBe(true);
    expect(reasons(failures)).toContain("rebuild-incomplete");
    // Dropped, not left pointing at texels that were never written: those slots now fail the
    // generation check and are skipped rather than drawn as whatever the texture happens to hold.
    expect(renderer?.atlas.entries).toBe(0);
    renderer?.begin();
    renderer?.push(one, 0, 0, 14);
    expect(renderer?.end().instances).toBe(0);
  });

  it("keeps offset order after rebuild drops a middle allocation and the ring wraps", () => {
    const made = makeRenderer({ maxTextureSize: 1024, atlasTexels: 1024 });
    const font = fakeFont({ texels: 300 });
    const face = made.renderer?.registerFace(font, "f") as HbGpuFace;
    made.renderer?.upload(face, 1, font.encode(1)!);
    made.renderer?.upload(face, 2, font.encode(2)!);
    made.renderer?.upload(face, 3, font.encode(3)!);

    // Refuse only the allocation in the middle of offset order during rebuild.
    // The two survivors must remain ordered around its hole.
    const encode = font.encode.bind(font);
    font.encode = (id) => (id === 2 ? null : encode(id));
    made.renderer?.notifyContextLost();
    expect(made.renderer?.rebuild()).toBe(true);
    expect(reasons(made.failures)).toContain("rebuild-incomplete");
    expect(made.renderer?.atlas.entries).toBe(2);
    expect(made.renderer?.atlas.liveTexels).toBe(600);

    // The cursor was at the end, so glyph 4 wraps over glyph 1. Glyph 5 then
    // fills the middle hole without disturbing glyph 3 at the high offset.
    made.renderer?.upload(face, 4, font.encode(4)!);
    made.renderer?.upload(face, 5, font.encode(5)!);
    expect(made.renderer?.resolve(face, 1)).toBeNull();
    expect(made.renderer?.resolve(face, 2)).toBeNull();
    expect(made.renderer?.resolve(face, 3)).not.toBeNull();
    expect(made.renderer?.resolve(face, 4)).not.toBeNull();
    expect(made.renderer?.resolve(face, 5)).not.toBeNull();
    expect(made.renderer?.atlas.entries).toBe(3);
    expect(made.renderer?.atlas.liveTexels).toBe(900);
  });

  it("reports and stays lost when the rebuild itself cannot allocate", () => {
    const fake = createFakeGl();
    const failures: HbGpuFailure[] = [];
    const renderer = createHbGpuRenderer(fakeModule(), {
      gl: fake.gl,
      designWidth: 64,
      designHeight: 64,
      onError: (failure) => failures.push(failure),
    });
    renderer?.notifyContextLost();
    // The context came back and went away again mid-rebuild, which is a real sequence on a driver
    // reset storm.
    (fake.gl as unknown as { createProgram: () => null }).createProgram = () =>
      null;
    expect(renderer?.rebuild()).toBe(false);
    expect(reasons(failures)).toContain("gl-object");
    expect(renderer?.contextLost).toBe(true);
  });
});

describe("dispose", () => {
  it("deletes what it created and nothing the embedder owns", () => {
    const { fake, renderer } = makeRenderer();
    fake.reset();
    renderer?.dispose();
    expect(fake.named("deleteProgram").length).toBe(1);
    expect(fake.named("deleteTexture").length).toBe(1);
    expect(fake.named("deleteVertexArray").length).toBe(1);
    expect(fake.named("deleteBuffer").length).toBe(2);
  });

  it("frees nothing through a dead context", () => {
    const { fake, renderer } = makeRenderer();
    renderer?.notifyContextLost();
    fake.reset();
    renderer?.dispose();
    expect(fake.calls).toEqual([]);
  });
});
