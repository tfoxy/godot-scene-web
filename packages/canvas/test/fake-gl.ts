/**
 * A recording stand-in for `WebGL2RenderingContext`: enough of the API for the
 * executor to build its program and issue draws, with every call logged.
 *
 * This is not a renderer and cannot say what a frame LOOKS like — that is what
 * the pixel tests in `@godot-scene-web/test-harness` are for. What it can say,
 * and what no pixel test can say cheaply, is HOW MANY draws a frame took, in what
 * order the state around them was set, and which textures each one bound. Those
 * are the properties the executor exists to get right.
 */

export interface GlCall {
  name: string;
  args: unknown[];
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  calls: GlCall[];
  /** Every `drawArraysInstanced`, with the texture units bound when it ran. */
  draws: {
    instanceCount: number;
    textures: unknown[];
    scissor: [number, number, number, number];
    blendFunc: number[];
    blendEquation: number[];
  }[];
  /** Every indexed triangle draw, captured separately from instanced quads. */
  elements: {
    count: number;
    textures: unknown[];
    scissor: [number, number, number, number];
    blendFunc: number[];
    blendEquation: number[];
  }[];
  named(name: string): GlCall[];
  reset(): void;
}

let nextObjectId = 1;
function glObject(kind: string): object {
  return { __gl: kind, id: nextObjectId++ };
}

/**
 * ADDITIVE EXTENSION for `@godot-scene-web/hb-gpu` — integer textures, instanced integer
 * attributes and the failure injection a construct-or-null renderer needs.
 *
 * The executor this file was written for uses none of it, so every knob here is optional and
 * defaults to "everything works", which is the behaviour every existing caller already gets.
 */
export interface FakeGlOptions {
  maxTextureUnits?: number;
  /** `gl.getParameter(MAX_TEXTURE_SIZE)`. Defaults to 4096; 2048 is WebGL2's actual guarantee. */
  maxTextureSize?: number;
  /** What `gl.isContextLost()` answers. */
  contextLost?: boolean;
  /** `gl.create<X>` returns null for each of these — the shape a lost context takes. */
  failCreate?: readonly (
    | "shader"
    | "program"
    | "buffer"
    | "texture"
    | "vao"
    | "framebuffer"
  )[];
  /** `COMPILE_STATUS` / `LINK_STATUS` come back false, with `infoLog` as the log. */
  compileFails?: boolean;
  linkFails?: boolean;
  infoLog?: string;
  /** Attribute names the "linker" dropped: `getAttribLocation` answers -1 for these.
   *
   *  `readonly`, like {@link FakeGlOptions.failCreate}, so a table of cases written with `as const`
   *  — the natural way to spell one — is assignable. Nothing here mutates either list. */
  missingAttributes?: readonly string[];
}

export function createFakeGl(options: FakeGlOptions = {}): FakeGl {
  const calls: GlCall[] = [];
  const draws: FakeGl["draws"] = [];
  const elements: FakeGl["elements"] = [];
  const boundTextures: unknown[] = [];
  let activeUnit = 0;
  let scissor: [number, number, number, number] = [0, 0, 0, 0];
  let blendFunc: number[] = [];
  let blendEquation: number[] = [];
  let readFramebuffer: unknown = null;
  let drawFramebuffer: unknown = null;
  const failCreate = new Set(options.failCreate ?? []);
  const attribLocations = new Map<string, number>();
  // Real `pixelStorei` state, so a caller that saves and restores `UNPACK_ALIGNMENT` can be caught
  // not doing it. `getParameter` reads this back.
  const pixelStore = new Map<number, number>();

  function record(name: string, ...args: unknown[]): void {
    calls.push({ name, args });
  }

  const constants: Record<string, number> = {
    ARRAY_BUFFER: 0x8892,
    BLEND: 0x0be2,
    CLAMP_TO_EDGE: 0x812f,
    COLOR_BUFFER_BIT: 0x4000,
    COLOR_ATTACHMENT0: 0x8ce0,
    COMPILE_STATUS: 0x8b81,
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    DST_ALPHA: 0x0304,
    DST_COLOR: 0x0306,
    DYNAMIC_DRAW: 0x88e8,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    FLOAT: 0x1406,
    FRAMEBUFFER: 0x8d40,
    READ_FRAMEBUFFER: 0x8ca8,
    DRAW_FRAMEBUFFER: 0x8ca9,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_BINDING: 0x8ca6,
    DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
    READ_FRAMEBUFFER_BINDING: 0x8caa,
    FRAGMENT_SHADER: 0x8b30,
    FUNC_ADD: 0x8006,
    FUNC_REVERSE_SUBTRACT: 0x800b,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    LINK_STATUS: 0x8b82,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    // hb-gpu's additions, all real WebGL2 enum values.
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    RGBA16I: 0x8d88,
    RGBA_INTEGER: 0x8d99,
    SHORT: 0x1402,
    UNSIGNED_INT: 0x1405,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    SCISSOR_TEST: 0x0c11,
    STATIC_DRAW: 0x88e4,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLE_STRIP: 5,
    TRIANGLES: 4,
    POINTS: 0,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
    ZERO: 0,
  };

  const api: Record<string, unknown> = {
    ...constants,

    isContextLost: () => options.contextLost === true,

    getParameter(pname: number) {
      record("getParameter", pname);
      if (pname === constants.MAX_TEXTURE_IMAGE_UNITS) {
        return options.maxTextureUnits ?? 16;
      }
      if (pname === constants.MAX_TEXTURE_SIZE) {
        return options.maxTextureSize ?? 4096;
      }
      if (
        pname === constants.FRAMEBUFFER_BINDING ||
        pname === constants.DRAW_FRAMEBUFFER_BINDING
      )
        return drawFramebuffer;
      if (pname === constants.READ_FRAMEBUFFER_BINDING) return readFramebuffer;
      if (pname === constants.UNPACK_ALIGNMENT)
        return pixelStore.get(constants.UNPACK_ALIGNMENT) ?? 4;
      // BOOLEANS, and read back as booleans, because that is what a real context answers for these
      // two and a caller saving them has to restore the same type it read. Both default false.
      if (
        pname === constants.UNPACK_FLIP_Y_WEBGL ||
        pname === constants.UNPACK_PREMULTIPLY_ALPHA_WEBGL
      ) {
        return Boolean(pixelStore.get(pname) ?? 0);
      }
      return 0;
    },

    createShader: (type: number) => {
      record("createShader", type);
      return failCreate.has("shader") ? null : glObject("shader");
    },
    shaderSource: (shader: unknown, source: string) => {
      record("shaderSource", shader, source);
    },
    compileShader: (shader: unknown) => record("compileShader", shader),
    getShaderParameter: () => options.compileFails !== true,
    getShaderInfoLog: () => options.infoLog ?? "",
    deleteShader: (shader: unknown) => record("deleteShader", shader),

    createProgram: () => {
      record("createProgram");
      return failCreate.has("program") ? null : glObject("program");
    },
    attachShader: () => {},
    linkProgram: (program: unknown) => record("linkProgram", program),
    getProgramParameter: () => options.linkFails !== true,
    getProgramInfoLog: () => options.infoLog ?? "",
    useProgram: (program: unknown) => record("useProgram", program),
    deleteProgram: (program: unknown) => record("deleteProgram", program),
    getUniformLocation: (_program: unknown, name: string) => {
      record("getUniformLocation", name);
      return glObject(`uniform:${name}`);
    },
    getAttribLocation: (_program: unknown, name: string) => {
      record("getAttribLocation", name);
      if (options.missingAttributes?.includes(name)) return -1;
      let location = attribLocations.get(name);
      if (location === undefined) {
        location = attribLocations.size;
        attribLocations.set(name, location);
      }
      return location;
    },

    createVertexArray: () => (failCreate.has("vao") ? null : glObject("vao")),
    bindVertexArray: (vao: unknown) => record("bindVertexArray", vao),
    deleteVertexArray: (vao: unknown) => record("deleteVertexArray", vao),

    createBuffer: () => (failCreate.has("buffer") ? null : glObject("buffer")),
    bindBuffer: (target: number, buffer: unknown) =>
      record("bindBuffer", target, buffer),
    bufferData: (target: number, data: unknown, usage: number) =>
      record("bufferData", target, data, usage),
    bufferSubData: (
      target: number,
      offset: number,
      data: unknown,
      srcOffset: number,
      length: number,
    ) => record("bufferSubData", target, offset, data, srcOffset, length),
    deleteBuffer: (buffer: unknown) => record("deleteBuffer", buffer),

    enableVertexAttribArray: (index: number) =>
      record("enableVertexAttribArray", index),
    disableVertexAttribArray: (index: number) =>
      record("disableVertexAttribArray", index),
    vertexAttribPointer: (...args: unknown[]) =>
      record("vertexAttribPointer", ...args),
    vertexAttribIPointer: (...args: unknown[]) =>
      record("vertexAttribIPointer", ...args),
    vertexAttribDivisor: (index: number, divisor: number) =>
      record("vertexAttribDivisor", index, divisor),

    createTexture: () =>
      failCreate.has("texture") ? null : glObject("texture"),
    deleteTexture: (texture: unknown) => record("deleteTexture", texture),
    createFramebuffer: () =>
      failCreate.has("framebuffer") ? null : glObject("framebuffer"),
    deleteFramebuffer: (framebuffer: unknown) =>
      record("deleteFramebuffer", framebuffer),
    bindFramebuffer: (target: number, framebuffer: unknown) => {
      if (target === constants.FRAMEBUFFER) {
        readFramebuffer = framebuffer;
        drawFramebuffer = framebuffer;
      } else if (target === constants.READ_FRAMEBUFFER)
        readFramebuffer = framebuffer;
      else if (target === constants.DRAW_FRAMEBUFFER)
        drawFramebuffer = framebuffer;
      record("bindFramebuffer", target, framebuffer);
    },
    framebufferTexture2D: (...args: unknown[]) =>
      record("framebufferTexture2D", ...args),
    checkFramebufferStatus: (target: number) => {
      record("checkFramebufferStatus", target);
      return constants.FRAMEBUFFER_COMPLETE;
    },
    blitFramebuffer: (...args: unknown[]) => record("blitFramebuffer", ...args),
    activeTexture: (unit: number) => {
      activeUnit = unit - constants.TEXTURE0;
      record("activeTexture", unit);
    },
    bindTexture: (target: number, texture: unknown) => {
      boundTextures[activeUnit] = texture;
      record("bindTexture", target, texture);
    },
    texImage2D: (...args: unknown[]) => record("texImage2D", ...args),
    texSubImage2D: (...args: unknown[]) => record("texSubImage2D", ...args),
    generateMipmap: (...args: unknown[]) => record("generateMipmap", ...args),
    texParameteri: (...args: unknown[]) => record("texParameteri", ...args),
    // `number | boolean`, because the two WEBGL unpack flags really are set with booleans and
    // storing `false` as `0` is what would let a save/restore look correct while restoring a
    // different type than it read.
    pixelStorei: (pname: number, value: number | boolean) => {
      pixelStore.set(pname, Number(value));
      record("pixelStorei", pname, value);
    },

    uniform1f: (...args: unknown[]) => record("uniform1f", ...args),
    uniform1i: (...args: unknown[]) => record("uniform1i", ...args),
    uniform1iv: (...args: unknown[]) => record("uniform1iv", ...args),
    uniform2f: (...args: unknown[]) => record("uniform2f", ...args),
    uniform3f: (...args: unknown[]) => record("uniform3f", ...args),
    uniform4f: (...args: unknown[]) => record("uniform4f", ...args),
    uniform4fv: (...args: unknown[]) => record("uniform4fv", ...args),
    uniformMatrix3fv: (...args: unknown[]) =>
      record("uniformMatrix3fv", ...args),
    uniformMatrix4fv: (...args: unknown[]) =>
      record("uniformMatrix4fv", ...args),

    viewport: (...args: unknown[]) => record("viewport", ...args),
    scissor: (x: number, y: number, w: number, h: number) => {
      scissor = [x, y, w, h];
      record("scissor", x, y, w, h);
    },
    enable: (cap: number) => record("enable", cap),
    disable: (cap: number) => record("disable", cap),
    blendEquationSeparate: (rgb: number, alpha: number) => {
      blendEquation = [rgb, alpha];
      record("blendEquationSeparate", rgb, alpha);
    },
    blendFuncSeparate: (...args: number[]) => {
      blendFunc = args;
      record("blendFuncSeparate", ...args);
    },
    // The non-separate forms, which set BOTH halves. `@godot-scene-web/hb-gpu` uses these; the
    // executor uses the `*Separate` pair above. Recorded into the same trackers so `draws` reports
    // the blend state whichever pair set it.
    blendEquation: (mode: number) => {
      blendEquation = [mode, mode];
      record("blendEquation", mode);
    },
    blendFunc: (source: number, destination: number) => {
      blendFunc = [source, destination, source, destination];
      record("blendFunc", source, destination);
    },
    clearColor: (...args: unknown[]) => record("clearColor", ...args),
    clear: (mask: number) => record("clear", mask),

    drawArraysInstanced: (
      mode: number,
      first: number,
      count: number,
      instanceCount: number,
    ) => {
      record("drawArraysInstanced", mode, first, count, instanceCount);
      draws.push({
        instanceCount,
        textures: [...boundTextures],
        scissor: [...scissor] as [number, number, number, number],
        blendFunc: [...blendFunc],
        blendEquation: [...blendEquation],
      });
    },
    drawArrays: (mode: number, first: number, count: number) => {
      record("drawArrays", mode, first, count);
    },
    drawElements: (
      mode: number,
      count: number,
      type: number,
      offset: number,
    ) => {
      record("drawElements", mode, count, type, offset);
      elements.push({
        count,
        textures: [...boundTextures],
        scissor: [...scissor] as [number, number, number, number],
        blendFunc: [...blendFunc],
        blendEquation: [...blendEquation],
      });
    },
  };

  return {
    gl: api as unknown as WebGL2RenderingContext,
    calls,
    draws,
    elements,
    named(name) {
      return calls.filter((call) => call.name === name);
    },
    reset() {
      calls.length = 0;
      draws.length = 0;
      elements.length = 0;
    },
  };
}

/** A projection like `./present` builds: design `w`x`h` onto a framebuffer of the
 *  same size, so a pixel assertion reads in design units. */
export function fakeProjection(
  designWidth: number,
  designHeight: number,
  framebufferWidth = designWidth,
  framebufferHeight = designHeight,
) {
  return {
    designWidth,
    designHeight,
    toClip: new Float32Array([2 / designWidth, -2 / designHeight, -1, 1]),
    toFramebuffer: new Float32Array([
      framebufferWidth / designWidth,
      0,
      0,
      framebufferHeight / designHeight,
      0,
      0,
    ]),
    framebufferWidth,
    framebufferHeight,
  };
}
