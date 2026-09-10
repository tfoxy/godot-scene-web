import type { DamageRect } from "./damage";
import type { DrawList } from "./draw-list";
import type {
  CanvasExecutor,
  ExecuteOptions,
  ExecutorTexture,
} from "./executor-webgl";
import type { StageProjection } from "./present";
import { isPartialReplayMask, type ReplayMaskScratch } from "./replay";

/** An RGBA8 framebuffer that retains scene pixels between frames. */
export interface RetainedSurface {
  readonly gl: WebGL2RenderingContext;
  /** The achieved, integer backing dimensions. Zero means unallocated. */
  readonly width: number;
  readonly height: number;
  /** GPU allocation is live. It says nothing about whether it contains a frame. */
  readonly allocated: boolean;
  /** True only after a full replay; `present` refuses unseeded pixels. */
  readonly contentValid: boolean;
  /**
   * Allocate an RGBA8 texture/FBO at the exact snapped requested size. A size
   * change discards old pixels, so callers must replay a full frame afterwards.
   */
  resize(width: number, height: number): boolean;
  /**
   * Replay into the retained target. `damage` is top-left framebuffer pixels;
   * passing it restricts both clear and draw to that region. This operation is
   * explicit: direct `CanvasExecutor.execute` calls can neither seed this FBO
   * nor present it.
   */
  replay(
    executor: CanvasExecutor,
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
    options?: RetainedReplayOptions,
  ): boolean;
  /**
   * Replay a prevalidated exact cover into one retained target binding. Every
   * region keeps its own damage scissor and clip-complete mask, so painter
   * order, clips and blend modes are identical to individual partial replays.
   * The whole set is validated before its first clear; any failure invalidates
   * retained content and a caller must seed rather than present it.
   */
  replayRegions(
    executor: CanvasExecutor,
    list: DrawList<ExecutorTexture | null>,
    projection: StageProjection,
    regions: readonly RetainedReplayRegion[],
    options?: RetainedReplayRegionsOptions,
  ): boolean;
  /** Blit the retained texture once, 1:1, to the default framebuffer. */
  present(): boolean;
  /** Forget retained pixels while keeping the allocated FBO for the next seed. */
  invalidateContent(): void;
  /** Drop dead context handles without calling GL after a context loss. */
  invalidate(): void;
  /** Delete owned GL resources while the context is live. */
  dispose(): void;
}

export interface RetainedReplayOptions {
  /**
   * A physical-pixel damage region. Partial retained replay deliberately
   * requires one; an unbounded replay is a seed and therefore renders the
   * complete list without a mask.
   */
  damage?: DamageRect;
  /**
   * A validated, clip-complete selection from `createReplayMaskScratch` or a
   * compiled draw-list. A generic `CommandMask` is intentionally not accepted:
   * it could omit an unknown or screen-dependent command and leave stale FBO
   * pixels that `present()` would otherwise expose.
   */
  mask?: ReplayMaskScratch;
  /** Forwarded only for rare custom executor behaviour; clear defaults to true. */
  execute?: Omit<ExecuteOptions, "clear" | "damage" | "commandMask">;
}

/** One independently scissored, clip-complete member of a retained replay set. */
export interface RetainedReplayRegion {
  damage: DamageRect;
  mask: ReplayMaskScratch;
}

/** Shared executor options for every region in one retained replay set. */
export interface RetainedReplayRegionsOptions {
  execute?: Omit<ExecuteOptions, "clear" | "damage" | "commandMask">;
}

/** Snap a CSS/device calculation once at the allocation boundary. */
export function snapRetainedSize(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

function isValidDamage(
  damage: DamageRect,
  width: number,
  height: number,
): boolean {
  return (
    Number.isFinite(damage.x) &&
    Number.isFinite(damage.y) &&
    Number.isFinite(damage.width) &&
    Number.isFinite(damage.height) &&
    damage.width > 0 &&
    damage.height > 0 &&
    damage.x >= 0 &&
    damage.y >= 0 &&
    damage.x + damage.width <= width &&
    damage.y + damage.height <= height
  );
}

/**
 * Create a retained RGBA8 texture/FBO. It deliberately does not create a
 * canvas or context — a stage owns that DOM-facing concern — and it does not
 * monkey-patch an executor. Retention is opt-in per replay/present call.
 */
export function createRetainedSurface(
  gl: WebGL2RenderingContext,
): RetainedSurface {
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  let width = 0;
  let height = 0;
  let contentValid = false;

  function discard(callGl: boolean): void {
    if (callGl) {
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      if (texture) gl.deleteTexture(texture);
    }
    framebuffer = null;
    texture = null;
    width = 0;
    height = 0;
    contentValid = false;
  }

  function resize(requestedWidth: number, requestedHeight: number): boolean {
    const nextWidth = snapRetainedSize(requestedWidth);
    const nextHeight = snapRetainedSize(requestedHeight);
    if (
      texture &&
      framebuffer &&
      width === nextWidth &&
      height === nextHeight
    ) {
      return true;
    }
    const nextTexture = gl.createTexture();
    const nextFramebuffer = gl.createFramebuffer();
    if (!nextTexture || !nextFramebuffer) {
      if (nextTexture) gl.deleteTexture(nextTexture);
      if (nextFramebuffer) gl.deleteFramebuffer(nextFramebuffer);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, nextTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      nextWidth,
      nextHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
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
    // A texture allocation starts undefined. Never present it and never let a
    // partial replay pretend its untouched pixels belong to this frame.
    contentValid = false;
    return true;
  }

  return {
    gl,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get allocated() {
      return texture !== null && framebuffer !== null;
    },
    get contentValid() {
      return contentValid;
    },
    resize,

    replay(executor, list, projection, options) {
      if (!texture || !framebuffer) return false;
      const partial =
        options?.damage !== undefined || options?.mask !== undefined;
      // A masked draw is always partial, even if its current indices happen to
      // cover every command. A full seed has no damage and no mask; partial
      // replay requires the module-owned, fail-closed selection plus a bounded
      // physical-pixel region.
      if (
        partial &&
        (!options?.damage ||
          !options.mask ||
          !isValidDamage(options.damage, width, height) ||
          !isPartialReplayMask(options.mask, list))
      ) {
        return false;
      }
      if (partial && !contentValid) return false;
      // The retained target has no scaling policy. A mismatched projection would
      // draw to one size and blit a different one, leaving stale border pixels.
      if (
        projection.framebufferWidth !== width ||
        projection.framebufferHeight !== height
      ) {
        return false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      const execute: ExecuteOptions = {
        ...options?.execute,
        clear: true,
        damage: options?.damage,
        commandMask: options?.mask,
      };
      try {
        const replayed = executor.execute(list, projection, execute);
        if (!replayed) {
          // A lazy shader/glyph pass may have touched some pixels before it
          // declines. The next frame must seed, never blit a half-reconstructed
          // retained image.
          contentValid = false;
          return false;
        }
        if (!partial) contentValid = true;
        return replayed;
      } catch (error) {
        contentValid = false;
        throw error;
      } finally {
        // A lazy executor can decline its program. Do not strand the FBO as the
        // draw target: a later direct frame must still reach the stage canvas.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },

    replayRegions(executor, list, projection, regions, options) {
      // Unlike one-region `replay`, this operation owns an atomic multi-pass
      // contract: reject the complete set before the first clear, and never
      // leave a partly reconstructed target eligible for `present`.
      if (
        !texture ||
        !framebuffer ||
        !contentValid ||
        regions.length === 0 ||
        projection.framebufferWidth !== width ||
        projection.framebufferHeight !== height
      ) {
        contentValid = false;
        return false;
      }
      for (const region of regions) {
        if (
          !isValidDamage(region.damage, width, height) ||
          !isPartialReplayMask(region.mask, list)
        ) {
          contentValid = false;
          return false;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      try {
        for (const region of regions) {
          const replayed = executor.execute(list, projection, {
            ...options?.execute,
            clear: true,
            damage: region.damage,
            commandMask: region.mask,
          });
          if (!replayed) {
            contentValid = false;
            return false;
          }
        }
        return true;
      } catch (error) {
        contentValid = false;
        throw error;
      } finally {
        // Keep the direct path aimed at the stage even after a later region
        // refuses a lazy shader/glyph pass.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },

    present() {
      if (!texture || !framebuffer || !contentValid) return false;
      // Scissor is context state. A damage replay can leave it tight, and a
      // raster-path blit obeying that state would present only the dirty tile.
      gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
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

    invalidateContent() {
      // This is intentionally separate from `invalidate()`: an unrelated
      // direct executor frame may make its own program stale, but it must not
      // deallocate the retained target or turn a later explicit present into a
      // hidden allocation churn.
      contentValid = false;
    },

    invalidate() {
      discard(false);
    },
    dispose() {
      discard(true);
    },
  };
}
