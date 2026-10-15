/**
 * The stage: a WebGL2 context of its OWN on a caller-supplied canvas, its exact
 * backing-store size, the design->screen projection every other module in this
 * package reads, and the context-loss plumbing.
 *
 * THE ONLY MODULE IN `@godot-scene-web/canvas` THAT TOUCHES A CANVAS. Everything
 * else takes a `WebGL2RenderingContext` and does arithmetic; keeping the DOM
 * surface to one file is what makes the rest of the package testable without a
 * browser and reusable off the main thread.
 *
 * ITS OWN CONTEXT, not `html`'s shared one. The shared context exists so that N
 * per-node effect canvases on one page do not each burn one of the browser's ~16
 * live contexts; it renders offscreen and BLITS onto each node. The stage is the
 * opposite shape — ONE canvas for the whole scene, presented directly — so it
 * neither needs the blit nor wants to share a drawing buffer that is sized,
 * cleared and grown by two other runtimes on their own schedule.
 *
 * THE CONTEXT ATTRIBUTES, and why each one:
 *
 * - `alpha: true` — the stage composites over whatever the page puts behind it
 *   (letterbox bars, a background layer), so it must carry real transparency.
 * - `premultipliedAlpha: true` — the contract stated end to end: textures upload
 *   premultiplied (`./textures`), tints are premultiplied (the draw-list's own
 *   documentation), every fragment emits `vec4(rgb*a, a)`, the MIX blend is
 *   `(ONE, ONE_MINUS_SRC_ALPHA)`. This flag changes no byte in the drawing
 *   buffer; it tells the compositor how to READ them. Declare it wrong and
 *   nothing errors — the page simply multiplies by alpha a second time and every
 *   translucent pixel comes out dark. `html/webgl/shared-gl.ts` has the long
 *   version of this note and the bug that produced it.
 * - `stencil: false`, `depth: false` — a painter's-algorithm 2D renderer uses
 *   neither, and both cost drawing-buffer memory on every device.
 * - `antialias: false` — there is no geometry to multisample: every edge in the
 *   scene is a texture's own alpha, which LINEAR filtering already smooths. MSAA
 *   here would allocate a multisample buffer and resolve it every frame to change
 *   nothing.
 * - `preserveDrawingBuffer: false` — the stage clears and repaints every frame,
 *   and preserving forces the implementation to keep a copy. Measurement trap
 *   that follows: once the stage is idle, a JS-side readback (`toDataURL`,
 *   `drawImage` of the canvas) returns an EMPTY image while the composited
 *   frame on screen is correct — the drawing buffer is gone after present, by
 *   design. Judge presentation only by compositor capture (a real screenshot
 *   of the tab), never by reading the canvas back.
 * - `desynchronized` is deliberately NOT set. It can cut latency by letting the
 *   canvas bypass the compositor, but it also makes readback and screenshot
 *   behaviour implementation-defined — which is exactly what the pixel tests
 *   assert on — and on several drivers it silently disables the alpha compositing
 *   path the point above depends on. A latency measurement can turn it on later,
 *   with a test that proves the composite still holds.
 */

/** The subset of a canvas the stage needs. Structural so that both an
 *  `HTMLCanvasElement` and an `OffscreenCanvas` satisfy it. */
export interface StageCanvas {
  width: number;
  height: number;
  getContext(
    contextId: "webgl2",
    options?: WebGLContextAttributes,
  ): WebGL2RenderingContext | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** How design coordinates reach the screen, in the two forms consumers need. */
export interface StageProjection {
  /** Exact scene coordinate extent, independent of float32 matrix rounding. */
  readonly designWidth: number;
  readonly designHeight: number;
  /**
   * Design -> clip space as `(scaleX, scaleY, translateX, translateY)`:
   * `clip = design * scale + translate`. `scaleY` is NEGATIVE — design space
   * measures Y downwards and clip space upwards.
   */
  readonly toClip: Float32Array;
  /**
   * Design -> framebuffer pixels as a 2x3 in the draw-list's `Transform2D` order
   * `[xx, xy, yx, yy, originX, originY]`, with Y measured DOWN from the top. This
   * is what `./clip-stack` turns into a scissor box.
   */
  readonly toFramebuffer: Float32Array;
  /** The drawing buffer's REAL size — see {@link CanvasStage.setStageSize}. */
  readonly framebufferWidth: number;
  readonly framebufferHeight: number;
}

export interface CanvasStageOptions {
  canvas: StageCanvas;
  /** The scene's own coordinate extent, e.g. 1920x1080. */
  designWidth: number;
  designHeight: number;
  /**
   * Request an alpha-capable drawing buffer. Omitted preserves the stage's
   * compositing default (`true`); an opaque scene may opt out when it paints
   * every output pixel itself.
   */
  alpha?: boolean;
  /**
   * Called after `webglcontextlost`. Every GL object the caller holds is dead:
   * drop programs, buffers and textures (`CanvasTextureCache.reset`,
   * `CanvasExecutor.invalidate`) without calling into GL to free them.
   */
  onContextLost?(): void;
  /** Called after `webglcontextrestored`: rebuild programs, buffers, textures. */
  onContextRestored?(): void;
}

export interface CanvasStage {
  readonly canvas: StageCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly designWidth: number;
  readonly designHeight: number;
  /** The drawing buffer's real width/height, which may be smaller than asked. */
  readonly stageWidth: number;
  readonly stageHeight: number;
  /** True between `webglcontextlost` and `webglcontextrestored`. */
  readonly contextLost: boolean;
  /**
   * Whether the context actually has an alpha channel. This is read from the
   * created context when available, rather than assuming the request won.
   */
  readonly alpha: boolean;
  /**
   * Size the backing store EXACTLY. Not grow-only: a stage that kept the largest
   * size it had ever been asked for would keep a 4K drawing buffer alive after a
   * window shrank, and would leave `gl.viewport` and the projection describing a
   * buffer bigger than the one being presented. Re-reads the ACHIEVED size
   * afterwards, because setting `canvas.width` only REQUESTS an allocation — an
   * implementation may return a smaller buffer, and trusting the attribute over
   * the buffer is how a renderer ends up drawing into rows that do not exist.
   */
  setStageSize(width: number, height: number): void;
  /** Change the design extent (a scene that re-lays-out for a new aspect). */
  setDesignSize(width: number, height: number): void;
  /** The current projection. The returned object is reused; read it, don't keep it. */
  projection(): StageProjection;
  /** Set `gl.viewport` to the whole drawing buffer. */
  applyViewport(): void;
  /** Detach the context-loss listeners. Does not delete the context. */
  dispose(): void;
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  stencil: false,
  depth: false,
  antialias: false,
  preserveDrawingBuffer: false,
};

/** The attributes the stage asks for, exported so a test can assert the contract
 *  rather than restate it. */
export const STAGE_CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes> =
  CONTEXT_ATTRIBUTES;

/**
 * Create a stage on `canvas`, or `null` when the browser gives no WebGL2 context.
 *
 * Note what is NOT here: no software-renderer refusal. `html`'s shared context
 * declines SwiftShader/llvmpipe because running full-screen procedural fragment
 * shaders on a CPU rasterizer costs more than the CSS fallback it has. The stage
 * has no fallback to fall back TO — it is the renderer — and its fragment shader
 * is a texture fetch and a multiply, which software GL runs perfectly well. The
 * decision of whether this device should use the canvas renderer at all belongs
 * to the consumer, one level up, where the alternative is known.
 */
export function createCanvasStage(
  options: CanvasStageOptions,
): CanvasStage | null {
  const canvas = options.canvas;
  // Do not mutate the exported default object: callers and tests use it as the
  // package-wide transparent-stage contract. The opaque request is one stage's
  // private getContext dictionary.
  const contextAttributes =
    options.alpha === undefined
      ? CONTEXT_ATTRIBUTES
      : { ...CONTEXT_ATTRIBUTES, alpha: options.alpha };
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", contextAttributes);
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;
  const alpha =
    context.getContextAttributes?.()?.alpha ?? contextAttributes.alpha ?? true;

  let designWidth = Math.max(1, options.designWidth);
  let designHeight = Math.max(1, options.designHeight);
  let stageWidth = 0;
  let stageHeight = 0;
  let contextLost = false;

  const projection: {
    designWidth: number;
    designHeight: number;
    toClip: Float32Array;
    toFramebuffer: Float32Array;
    framebufferWidth: number;
    framebufferHeight: number;
  } = {
    designWidth,
    designHeight,
    toClip: new Float32Array(4),
    toFramebuffer: new Float32Array([1, 0, 0, 1, 0, 0]),
    framebufferWidth: 0,
    framebufferHeight: 0,
  };

  function readBackingSize(): void {
    // The ACHIEVED buffer, not the requested attribute. A context that came back
    // short still reports the truth here, and every rect this stage produces has
    // to be measured against the truth.
    const width = context.drawingBufferWidth || canvas.width;
    const height = context.drawingBufferHeight || canvas.height;
    stageWidth = Math.max(1, width);
    stageHeight = Math.max(1, height);
  }

  function refreshProjection(): void {
    projection.designWidth = designWidth;
    projection.designHeight = designHeight;
    projection.toClip[0] = 2 / designWidth;
    projection.toClip[1] = -2 / designHeight;
    projection.toClip[2] = -1;
    projection.toClip[3] = 1;
    projection.toFramebuffer[0] = stageWidth / designWidth;
    projection.toFramebuffer[1] = 0;
    projection.toFramebuffer[2] = 0;
    projection.toFramebuffer[3] = stageHeight / designHeight;
    projection.toFramebuffer[4] = 0;
    projection.toFramebuffer[5] = 0;
    projection.framebufferWidth = stageWidth;
    projection.framebufferHeight = stageHeight;
  }

  readBackingSize();
  refreshProjection();

  const onLost = (event: Event): void => {
    // WITHOUT `preventDefault` the browser never fires `webglcontextrestored` —
    // the canvas is simply dead for the rest of the page's life.
    event.preventDefault();
    contextLost = true;
    options.onContextLost?.();
  };
  const onRestored = (): void => {
    contextLost = false;
    // The context OBJECT survives a restore; only its resources are gone. So
    // there is nothing to re-`getContext`, but the drawing buffer was
    // reallocated and has to be re-measured.
    readBackingSize();
    refreshProjection();
    options.onContextRestored?.();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    canvas,
    gl: context,
    get designWidth() {
      return designWidth;
    },
    get designHeight() {
      return designHeight;
    },
    get stageWidth() {
      return stageWidth;
    },
    get stageHeight() {
      return stageHeight;
    },
    get contextLost() {
      return contextLost;
    },
    get alpha() {
      return alpha;
    },

    setStageSize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      // Guarded because ASSIGNING `canvas.width` reallocates and clears the
      // drawing buffer even when the value is unchanged — a resize handler that
      // fires on every scroll would otherwise blank the stage.
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      readBackingSize();
      refreshProjection();
    },

    setDesignSize(width, height) {
      designWidth = Math.max(1, width);
      designHeight = Math.max(1, height);
      refreshProjection();
    },

    projection() {
      return projection;
    },

    applyViewport() {
      context.viewport(0, 0, stageWidth, stageHeight);
    },

    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    },
  };
}

/**
 * The colour format of a {@link StageTarget}.
 *
 * - `"rgb10_a2"` is `GL_RGB10_A2`: 10 bits per colour channel and 2 of alpha,
 *   which is what Godot's GLES3 renderer draws a non-transparent viewport into
 *   (`drivers/gles3/storage/texture_storage.cpp:2144-2150` in 4.5.1). Blends
 *   whose result falls between two 8-bit levels are therefore quantised as
 *   Godot quantises them, and only the 8-bit READBACK rounds them further. A
 *   2-bit alpha holds only 0, 1/3, 2/3 and 1, read back as 0, 85, 170 and 255.
 * - `"rgba8"` is the stage canvas's own format, for a caller that wants the same
 *   offscreen seam without the precision change.
 */
export type StageTargetFormat = "rgba8" | "rgb10_a2";

export interface StageTargetOptions {
  /** Defaults to `"rgb10_a2"`, the reason this type exists. */
  format?: StageTargetFormat;
  /** Optional initial size; otherwise call {@link StageTarget.resize}. */
  width?: number;
  height?: number;
}

/**
 * An offscreen colour target the executor draws into, blitted 1:1 to the stage
 * canvas. Allocate it at the stage's {@link CanvasStage.stageWidth} by
 * {@link CanvasStage.stageHeight} and the stage's own projection applies.
 *
 * A frame is `target.bind()`, `executor.execute(...)`, `target.blit()`: the
 * executor draws into whatever framebuffer is bound and never binds one itself.
 * Readback comes from the target rather than the canvas, so it does not depend
 * on `preserveDrawingBuffer` or on the compositor.
 *
 * The context must be single-sampled (the stage's `antialias: false`): WebGL2
 * refuses a blit from a single-sample target into a multisampled default
 * framebuffer with `INVALID_OPERATION`.
 *
 * THE CANVAS HOLDS EXACTLY WHAT `readPixels` RETURNS. An `"rgb10_a2"` target is
 * not copied with `blitFramebuffer`: its 10 -> 8-bit conversion is the
 * implementation's, and on ANGLE/Vulkan over an RTX 2060 it MEASURES one level
 * low for 95 of 2048 ramp pixels whose exact value is 0.50-0.55 of a level
 * above a midpoint, which `readPixels` rounds to nearest. So the presented
 * frame and the frame read back for a shot would disagree, and a
 * compositor-equals-readback check could never pass. Instead `blit` draws one
 * triangle that `texelFetch`es each texel and writes `floor(c * 255 + 0.5) /
 * 255`: an exact 8-bit level, which no conversion can move.
 */
export interface StageTarget {
  readonly gl: WebGL2RenderingContext;
  readonly format: StageTargetFormat;
  /** Integer backing size; 0 while unallocated. */
  readonly width: number;
  readonly height: number;
  readonly allocated: boolean;
  /** The colour attachment, for a caller that samples the frame afterwards. */
  readonly texture: WebGLTexture | null;
  readonly framebuffer: WebGLFramebuffer | null;
  /**
   * (Re)allocate at an exact integer size. Contents are undefined afterwards, so
   * the next frame must clear. Returns false when allocation failed or the
   * framebuffer is incomplete (the format is not colour-renderable here); the
   * previous allocation is then kept.
   */
  resize(width: number, height: number): boolean;
  /** Bind as the `FRAMEBUFFER` (draw and read). False while unallocated. */
  bind(): boolean;
  /**
   * Copy the whole target 1:1 into `destination` (the stage canvas's default
   * framebuffer when omitted), rounding each channel to its nearest 8-bit level
   * exactly as {@link StageTarget.readPixels} does. Leaves `destination` bound
   * for drawing and nothing bound for reading.
   *
   * An `"rgba8"` target is a `blitFramebuffer`. An `"rgb10_a2"` one is a draw
   * (see above) that also changes the program, the vertex array, unit 0's
   * texture and the `BLEND`, `SCISSOR_TEST` and viewport state; the executor
   * re-establishes every one of those at the start of its next `execute`.
   * Returns false while unallocated or when the present program cannot link.
   */
  blit(destination?: WebGLFramebuffer | null): boolean;
  /**
   * Read `RGBA`/`UNSIGNED_BYTE` with rows TOP-DOWN (design order: row 0 is the
   * top) into `out`, which is replaced by a new array when it is too small. The
   * GL converts each 10- or 2-bit channel to the nearest 8-bit level,
   * `round(v * 255 / 1023)` and `round(a * 255 / 3)`.
   */
  readPixels(out?: Uint8Array): Uint8Array | null;
  /**
   * The raw `UNSIGNED_INT_2_10_10_10_REV` words, rows top-down, for an
   * `"rgb10_a2"` target whose implementation-chosen read format offers them;
   * `null` otherwise. Red is bits 0-9, green 10-19, blue 20-29, alpha 30-31.
   */
  readPacked(out?: Uint32Array): Uint32Array | null;
  /** After a context loss: forget the dead handles without calling GL. */
  invalidate(): void;
  /** Delete the texture and framebuffer. */
  dispose(): void;
}

const PRESENT_VERTEX_SRC = `#version 300 es
void main() {
  // One triangle over the viewport: (-1,-1) (3,-1) (-1,3). No attributes.
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const PRESENT_FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D u_frame;
out vec4 fragColor;
void main() {
  // texelFetch: no filtering, no wrap, the stored level as v / (2^bits - 1).
  vec4 c = texelFetch(u_frame, ivec2(gl_FragCoord.xy), 0);
  // readPixels' conversion, made explicit: the nearest 8-bit level, which the
  // RGBA8 destination then stores without any rounding of its own.
  fragColor = floor(c * 255.0 + 0.5) / 255.0;
}`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

/** Create an offscreen {@link StageTarget}; allocation waits for a size. */
export function createStageTarget(
  gl: WebGL2RenderingContext,
  options: StageTargetOptions = {},
): StageTarget {
  const format = options.format ?? "rgb10_a2";
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  let width = 0;
  let height = 0;
  let byteRow = new Uint8Array(0);
  let wordRow = new Uint32Array(0);
  let presentProgram: WebGLProgram | null = null;
  let presentVao: WebGLVertexArrayObject | null = null;

  function ensurePresentProgram(): WebGLProgram | null {
    if (presentProgram) return presentProgram;
    const vs = compile(gl, gl.VERTEX_SHADER, PRESENT_VERTEX_SRC);
    const fs = compile(gl, gl.FRAGMENT_SHADER, PRESENT_FRAGMENT_SRC);
    const program = vs && fs ? gl.createProgram() : null;
    if (program && vs && fs) {
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
    }
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    if (!program) return null;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn(
        "[gsw canvas] stage target present program failed:",
        gl.getProgramInfoLog(program),
      );
      gl.deleteProgram(program);
      return null;
    }
    gl.useProgram(program);
    const frame = gl.getUniformLocation(program, "u_frame");
    if (frame) gl.uniform1i(frame, 0);
    presentProgram = program;
    presentVao = gl.createVertexArray();
    return program;
  }

  function discardPresent(callGl: boolean): void {
    if (callGl) {
      if (presentProgram) gl.deleteProgram(presentProgram);
      if (presentVao) gl.deleteVertexArray(presentVao);
    }
    presentProgram = null;
    presentVao = null;
  }

  function discard(callGl: boolean): void {
    if (callGl) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (texture) gl.deleteTexture(texture);
    }
    texture = null;
    framebuffer = null;
    width = 0;
    height = 0;
  }

  function resize(requestedWidth: number, requestedHeight: number): boolean {
    const nextWidth = Math.max(1, Math.floor(requestedWidth));
    const nextHeight = Math.max(1, Math.floor(requestedHeight));
    if (texture && framebuffer && nextWidth === width && nextHeight === height)
      return true;
    const nextTexture = gl.createTexture();
    const nextFramebuffer = gl.createFramebuffer();
    if (!nextTexture || !nextFramebuffer) {
      if (nextTexture) gl.deleteTexture(nextTexture);
      if (nextFramebuffer) gl.deleteFramebuffer(nextFramebuffer);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, nextTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Immutable storage with an explicit internal format: the format is the
    // whole point, so it is not left to a texImage2D format/type pairing.
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      format === "rgb10_a2" ? gl.RGB10_A2 : gl.RGBA8,
      nextWidth,
      nextHeight,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      nextTexture,
      0,
    );
    const complete =
      gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteFramebuffer(nextFramebuffer);
      gl.deleteTexture(nextTexture);
      return false;
    }
    discard(true);
    texture = nextTexture;
    framebuffer = nextFramebuffer;
    width = nextWidth;
    height = nextHeight;
    return true;
  }

  if (options.width !== undefined && options.height !== undefined) {
    resize(options.width, options.height);
  }

  // GL rows come back bottom-up; flip in place through one row of scratch.
  function flipBytes(data: Uint8Array, stride: number): void {
    if (byteRow.length < stride) byteRow = new Uint8Array(stride);
    for (
      let top = 0, bottom = height - 1;
      top < bottom;
      top += 1, bottom -= 1
    ) {
      const a = top * stride;
      const b = bottom * stride;
      byteRow.set(data.subarray(a, a + stride));
      data.copyWithin(a, b, b + stride);
      data.set(byteRow.subarray(0, stride), b);
    }
  }

  function flipWords(data: Uint32Array, stride: number): void {
    if (wordRow.length < stride) wordRow = new Uint32Array(stride);
    for (
      let top = 0, bottom = height - 1;
      top < bottom;
      top += 1, bottom -= 1
    ) {
      const a = top * stride;
      const b = bottom * stride;
      wordRow.set(data.subarray(a, a + stride));
      data.copyWithin(a, b, b + stride);
      data.set(wordRow.subarray(0, stride), b);
    }
  }

  return {
    gl,
    format,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get allocated() {
      return texture !== null && framebuffer !== null;
    },
    get texture() {
      return texture;
    },
    get framebuffer() {
      return framebuffer;
    },
    resize,

    bind() {
      if (!framebuffer) return false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      return true;
    },

    blit(destination = null) {
      if (!framebuffer) return false;
      gl.disable(gl.SCISSOR_TEST);
      if (format === "rgb10_a2") {
        const program = ensurePresentProgram();
        if (!program) return false;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.BLEND);
        gl.useProgram(program);
        gl.bindVertexArray(presentVao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return true;
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, destination);
      gl.blitFramebuffer(
        0,
        0,
        width,
        height,
        0,
        0,
        width,
        height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      return true;
    },

    readPixels(out) {
      if (!framebuffer) return null;
      const length = width * height * 4;
      const data = out && out.length >= length ? out : new Uint8Array(length);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      flipBytes(data, width * 4);
      return data;
    },

    readPacked(out) {
      if (!framebuffer || format !== "rgb10_a2") return null;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      const readFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
      const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
      if (
        readFormat !== gl.RGBA ||
        readType !== gl.UNSIGNED_INT_2_10_10_10_REV
      ) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        return null;
      }
      const length = width * height;
      const data = out && out.length >= length ? out : new Uint32Array(length);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(
        0,
        0,
        width,
        height,
        gl.RGBA,
        gl.UNSIGNED_INT_2_10_10_10_REV,
        data,
      );
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      flipWords(data, width);
      return data;
    },

    invalidate() {
      discard(false);
      discardPresent(false);
    },

    dispose() {
      discard(true);
      discardPresent(true);
    },
  };
}
