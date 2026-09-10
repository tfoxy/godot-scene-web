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
