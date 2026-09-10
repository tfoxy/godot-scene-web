import {
  type CommandBounds,
  commandDamageBounds,
  type DamageRect,
  type DamageTransform,
  transformDamageRect,
} from "./damage";
import {
  DRAW_CLIP_POP,
  DRAW_CLIP_PUSH,
  DRAW_EXTERNAL_EFFECT,
  DRAW_SCREEN_EFFECT,
  type DrawList,
} from "./draw-list";

/** A sparse ordered command selection. The executor walks the original list in
 * order, so batching and painter ordering remain exactly the direct path's. */
export interface CommandMask {
  readonly count: number;
  /** A screen-dependent command exists; partial retained replay must decline. */
  readonly requiresFullReplay?: boolean;
  includes(index: number): boolean;
  indices(): readonly number[];
}

/** Retained replay must stay below this fraction of the complete painter list. */
export const RETAINED_MAX_REPLAY_FRACTION = 0.4;

/**
 * Largest command count that is strictly below the retained replay threshold.
 * Clip pushes/pops are commands too: omitting them would not restore the
 * original painter state, so they count against the same budget.
 */
export function maxPartialReplayCommands(commandCount: number): number {
  if (!Number.isFinite(commandCount) || commandCount <= 0) return 0;
  return Math.max(
    0,
    Math.ceil(commandCount * RETAINED_MAX_REPLAY_FRACTION) - 1,
  );
}

const REPLAY_MASK_SCRATCH = Symbol("ReplayMaskScratch");
const replayMaskFrames = new WeakMap<
  object,
  { list: unknown; structuralRevision: number; contentRevision: number }
>();

export interface ReplaySelectionOptions {
  /** Map design-space command bounds into the damage rectangle's space. */
  transform?: DamageTransform;
  /**
   * Final-damage-coordinate raster/effect reach added after `transform`.
   * Defaults to one final pixel so antialiasing/filtering still selects a
   * command whose geometry falls just beyond a tile edge. Use this for effects
   * whose reach is known in final coordinates; producer-local effects belong
   * in the command's own local bounds, not both places.
   */
  rasterOutset?: number;
  /** Optional cached bounds provider. `null` takes the unknown-bounds policy. */
  boundsAt?: (index: number, out: CommandBounds) => CommandBounds | null;
  /** Decline instead of returning an unboundedly large partial replay. */
  maxCommands?: number;
  /** Unknown visual bounds cannot safely seed a damaged tile. The default is a
   * full/direct fallback; `select` is available for callers that knowingly
   * prefer conservative overdraw. */
  unknownBounds?: "fullReplay" | "select";
}

/** Reusable storage for a replay selection. Its mask and `indices()` array keep
 * identity across calls; after high-water growth selecting a tile allocates no
 * arrays. A threshold/screen-effect decline clears the selection. */
export interface ReplayMaskScratch extends CommandMask {
  readonly thresholdExceeded: boolean;
  /** False until `select()` has validated this frame's complete list. */
  readonly selected: boolean;
  /** Internal nominal marker: only a validated selection may drive an FBO replay. */
  readonly [REPLAY_MASK_SCRATCH]: true;
  select<TTexture>(
    list: DrawList<TTexture>,
    damage: DamageRect,
    options?: ReplaySelectionOptions,
  ): ReplayMaskScratch;
}

/** True only for masks created by this module and safe for a partial FBO replay. */
export function isPartialReplayMask(
  mask: ReplayMaskScratch,
  list?: DrawList<unknown>,
): mask is ReplayMaskScratch {
  const frame = replayMaskFrames.get(mask);
  return (
    mask[REPLAY_MASK_SCRATCH] === true &&
    mask.selected &&
    !mask.requiresFullReplay &&
    (list === undefined ||
      (frame?.list === list &&
        frame.structuralRevision === list.structuralRevision &&
        frame.contentRevision === list.contentRevision))
  );
}

function isFiniteBounds(bounds: DamageRect): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

/** Intersect `bounds` after applying final-coordinate reach without mutating a
 * provider-owned cached rectangle. */
function boundsIntersectsDamage(
  bounds: DamageRect,
  damage: DamageRect,
  outset: number,
): boolean {
  const x = bounds.x - outset;
  const y = bounds.y - outset;
  const width = bounds.width + outset * 2;
  const height = bounds.height + outset * 2;
  return (
    width > 0 &&
    height > 0 &&
    damage.width > 0 &&
    damage.height > 0 &&
    x < damage.x + damage.width &&
    x + width > damage.x &&
    y < damage.y + damage.height &&
    y + height > damage.y
  );
}

export function createReplayMaskScratch(capacity = 0): ReplayMaskScratch {
  let selected = new Uint8Array(Math.max(1, capacity));
  let open = new Int32Array(Math.max(1, capacity));
  let openCount = 0;
  const output: number[] = [];
  const bounds = { x: 0, y: 0, width: 0, height: 0 };
  const transformed = { x: 0, y: 0, width: 0, height: 0 };
  let requiresFullReplay = false;
  let thresholdExceeded = false;
  let selectedForFrame = false;
  let selectionLimit: number | undefined;

  function ensure(count: number): void {
    if (selected.length >= count) return;
    let size = selected.length;
    while (size < count) size *= 2;
    selected = new Uint8Array(size);
    open = new Int32Array(size);
  }

  function selectIndex(index: number, count: number): boolean {
    if (selected[index] !== 0) return true;
    selected[index] = 1;
    output.push(index);
    if (selectionLimit !== undefined && output.length > selectionLimit) {
      thresholdExceeded = true;
      // An empty partial mask would clear the damaged region. Threshold is a
      // decline, just like an unknown bound, so retained surfaces must take
      // their existing full/direct path.
      requiresFullReplay = true;
      output.length = 0;
      selected.fill(0, 0, count);
      return false;
    }
    return true;
  }

  function finish<TTexture>(list: DrawList<TTexture>): ReplayMaskScratch {
    selectedForFrame = true;
    replayMaskFrames.set(scratch, {
      list,
      structuralRevision: list.structuralRevision,
      contentRevision: list.contentRevision,
    });
    return scratch;
  }

  const scratch: ReplayMaskScratch = {
    get count() {
      return output.length;
    },
    get requiresFullReplay() {
      return requiresFullReplay;
    },
    get thresholdExceeded() {
      return thresholdExceeded;
    },
    get selected() {
      return selectedForFrame;
    },
    [REPLAY_MASK_SCRATCH]: true,
    includes(index) {
      return index >= 0 && index < selected.length && selected[index] !== 0;
    },
    indices() {
      return output;
    },
    select(list, damage, options) {
      ensure(list.count);
      selected.fill(0, 0, list.count);
      output.length = 0;
      openCount = 0;
      requiresFullReplay = false;
      thresholdExceeded = false;
      selectedForFrame = false;
      selectionLimit = options?.maxCommands;
      if (
        selectionLimit !== undefined &&
        (!Number.isFinite(selectionLimit) || selectionLimit < 0)
      ) {
        requiresFullReplay = true;
        return finish(list);
      }
      if (selectionLimit !== undefined) {
        selectionLimit = Math.floor(selectionLimit);
      }
      const rasterOutset = options?.rasterOutset ?? 1;
      if (!Number.isFinite(rasterOutset) || rasterOutset < 0) {
        requiresFullReplay = true;
        return finish(list);
      }

      selection: for (let index = 0; index < list.count; index += 1) {
        const kind = list.kindAt(index);
        if (kind === DRAW_SCREEN_EFFECT || kind === DRAW_EXTERNAL_EFFECT) {
          requiresFullReplay = true;
          output.length = 0;
          selected.fill(0, 0, list.count);
          break;
        }
        if (kind === DRAW_CLIP_PUSH) {
          open[openCount] = index;
          openCount += 1;
          continue;
        }
        if (kind === DRAW_CLIP_POP) {
          if (openCount === 0) {
            requiresFullReplay = true;
            output.length = 0;
            selected.fill(0, 0, list.count);
            break;
          }
          openCount -= 1;
          const push = open[openCount];
          if (selected[push] !== 0 && !selectIndex(index, list.count)) break;
          continue;
        }
        const commandBounds = options?.boundsAt
          ? options.boundsAt(index, bounds)
          : commandDamageBounds(list, index, bounds);
        const mapped =
          commandBounds && options?.transform
            ? transformDamageRect(commandBounds, options.transform, transformed)
            : commandBounds;
        if (mapped === null && options?.unknownBounds !== "select") {
          requiresFullReplay = true;
          output.length = 0;
          selected.fill(0, 0, list.count);
          break;
        }
        if (mapped !== null && !isFiniteBounds(mapped)) {
          requiresFullReplay = true;
          output.length = 0;
          selected.fill(0, 0, list.count);
          break;
        }
        // Do not mutate `mapped`: a boundsAt provider may intentionally return
        // its stable cached object instead of filling `bounds`. Scalar math
        // keeps the final-coordinate expansion allocation-free and cache-safe.
        if (
          mapped !== null &&
          !boundsIntersectsDamage(mapped, damage, rasterOutset)
        ) {
          continue;
        }
        for (let depth = 0; depth < openCount; depth += 1) {
          if (!selectIndex(open[depth], list.count)) break selection;
        }
        if (!selectIndex(index, list.count)) break;
      }
      if (openCount !== 0 && !requiresFullReplay) {
        // A structural clip imbalance might be invisible in the selected tile
        // today, but a replay beginning from an empty clip state has no sound
        // way to preserve it. Decline to the direct path.
        requiresFullReplay = true;
        output.length = 0;
        selected.fill(0, 0, list.count);
      }
      return finish(list);
    },
  };
  return scratch;
}

/**
 * Select just the commands that can change `damage`, preserving all clip pushes
 * and pops needed to replay them from an empty clip stack. Unknown bounds are
 * selected conservatively. This is deliberately a mask rather than a copied
 * command list: all reads stay in the original retained arenas.
 */
export function createReplayMask<TTexture>(
  list: DrawList<TTexture>,
  damage: DamageRect,
  options?: ReplaySelectionOptions,
): ReplayMaskScratch {
  return createReplayMaskScratch(list.count).select(list, damage, options);
}
