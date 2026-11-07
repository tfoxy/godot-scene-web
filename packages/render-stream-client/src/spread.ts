// The client-side route of the
// widescreen "spread" -- keep the game 16:9 and widen the layout in the browser with a generic
// module over the extension override table. This is a port of the old mirror's `computeSpread` GENERIC
// rules only (`sts2-couch-coop` `mirror/spreadLayout.ts`); the scene-identity re-centres and any
// STS2-specific tweaks live in the product's shape resolver, never here ("never in GSW").
//
// The rule set, faithfully, per item while a widening budget is open (delta > 0):
//   * anchored Controls move outward by `anchorLeft·Δ` (lifted by the parent's x-basis) and widen
//     their painted box by `(anchorRight−anchorLeft)·Δ`;
//   * a widened BoxContainer's children re-flow by alignment (0 begin / 0.5 centre / 1 end for an
//     hbox, 0 for a vbox) instead of running the anchor algebra;
//   * positional claimers ride a squeeze field `gameX·W/1920`;
//   * pass-through groups pass the budget through to each child;
//   * owner-anchored floaters ride their owner's shift; remote followers stay exact.
//
// The only rule the override table cannot express is the WIDEN: the table composes an affine
// (translate/scale), and scaling a box's paint also scales its flattened children (E composes down
// the tree), which is exactly the "no internal tearing" the mirror forbids. So the module computes
// `width` for the widened box and reports it, but writes only the translate shift. A product that
// needs a widened panel draws it with a product draw-list change (out of GSW's scope).

import {
  type Affine2D,
  type ItemMetaField,
  type ItemQuery,
  RAW_ITEM,
  type RawItemQuery,
  type Rect,
  type RenderStreamExtension,
} from "./extensions";

/** The per-item structural facts the generic rules read, resolved by the product (the wire's
 * `item_meta` carries scene/path/class, not anchors or container layout). */
export interface SpreadShape {
  /** Godot anchor fractions; both present for a Control with serialized anchors. */
  readonly anchorLeft?: number;
  readonly anchorRight?: number;
  /** A BoxContainer layout hint ("hbox-begin", "vbox-center", …), or null. */
  readonly containerLayout?: string | null;
  /** The item id of the Control this floater is positioned from (mirror's `anchorOwnerId`). */
  readonly anchorOwnerId?: number | null;
  /** A box-less paint kind that anchors its own visual at local (0,0) (a particle/spine anchor).
   * A positive-width `rect` already counts as paint, so only the zero-box kinds set this. */
  readonly pointAnchor?: boolean;
  /** A Control marker (the mirror's `anchored || mouseFilter`), for the boxed-control ride branch. */
  readonly isControl?: boolean;
}

/** The scene-identity answers the generic algebra cannot derive from geometry. An implementation
 * that returns the fallback everywhere is a legal (if less accurate) spread. */
export interface SpreadDeps {
  /** The cumulative shift an owner-anchored floater should ride; fallback is the parent's shift. */
  readonly ownerShift?: (ownerId: number, fallbackDx: number) => number;
  /** A remote follower's shift (a teammate's cursor, say); null for every non-follower. */
  readonly followerShift?: (
    id: number,
    gx: number,
    gy: number,
  ) => number | null;
  /** Overrides the geometric full-canvas centre claim (a 0/0 box spanning its frame). Defaults to
   * the geometry test; a product adds its scene-identity exceptions here. */
  readonly centerClaim?: (
    id: number,
    shape: SpreadShape,
    fullCanvas: boolean,
  ) => boolean;
}

/** The widening budget in presentation px: the extra width the product's CSS stretch turns into
 * `targetWidth − presentationWidth` on screen (the overrides are written in presentation space). */
export interface SpreadBudget {
  readonly presentationWidth: number;
  readonly targetWidth: number;
  /** `presentationWidth · (1 − presentationWidth / targetWidth)`, 0 at 16:9. */
  readonly delta: number;
}

/** The inherited spread context -- the subset of a walk's per-node context the algebra reads. */
export interface SpreadContext {
  /** The cumulative absolute shift already applied to the parent (presentation px). */
  readonly parentDx: number;
  /** How much this node's parent widened -- the budget the anchor fractions scale against. */
  readonly delta: number;
  /** How much the immediate anchor frame widened (0 under a zero-size pass-through group). */
  readonly anchorDelta: number;
  /** The shift a rigid (boxed Control) child rides -- a pass-through group's own claim. */
  readonly rideDx: number;
  /** The parent's local width (presentation px), for the full-canvas centre test. */
  readonly parentWidth: number;
  /** The parent's global x-basis x-component (`parentGlobal[0]` in the mirror). */
  readonly parentBasisX: number;
  /** True when `parentDx` came from the squeeze field rather than the anchor algebra. */
  readonly parentDxProp: boolean;
  /** Non-null when the parent is a widened BoxContainer: the child re-flow factor. */
  readonly containerAlign: number | null;
  /** True when that widened BoxContainer parent is vertical (cross-axis fill). */
  readonly containerVertical: boolean;
}

/** The algebra's whole answer for one item: its own shift and, for the anchor rule, the widened
 * box width, plus the context its children inherit. */
export interface SpreadOut {
  /** This item's absolute horizontal shift, in presentation px (ancestors' shifts included: the
   * override entry to write is this minus what the ancestors' entries already apply). */
  readonly dx: number;
  /** The anchor rule's widened painted box width (presentation px), or undefined. */
  readonly width?: number;
  readonly child: SpreadContext;
}

export interface SpreadOptions {
  /** The game's presentation width (16:9, e.g. 1920). */
  readonly presentationWidth: number;
  /** The viewer's target box width (e.g. 2520, the old mirror's 21:9 cap). */
  readonly targetWidth: number;
  /** The per-item shape resolver -- the product's scene-identity layer. */
  readonly shape: (id: number) => SpreadShape;
  readonly deps?: SpreadDeps;
  /** The identity fields the module asks for so it receives the item ids. Default `["class"]`
   * (the minimal grant that still delivers an id per item); a product whose own module already
   * asks for `scene`/`path` may leave this alone -- the union still delivers the ids. */
  readonly wants?: {
    readonly fields?: readonly ItemMetaField[];
  };
}

/** The widening budget at a target width; 0 at or below the presentation (16:9 = inert). */
export function spreadDelta(
  presentationWidth: number,
  targetWidth: number,
): number {
  if (!(presentationWidth > 0) || targetWidth <= presentationWidth) return 0;
  return presentationWidth * (1 - presentationWidth / targetWidth);
}

/** The squeeze field in presentation px: `gameX` shifts right by
 * `clamp(gameX, 0, W)·(1 − W/T)`, so after the product stretches the presentation to `T` the item
 * lands at the mirror's `gameX·T/W`. */
export function fieldDx(
  presentationWidth: number,
  targetWidth: number,
  gx: number,
): number {
  const delta = spreadDelta(presentationWidth, targetWidth);
  if (delta <= 0) return 0;
  const clamped = gx < 0 ? 0 : gx > presentationWidth ? presentationWidth : gx;
  return clamped * (delta / presentationWidth);
}

/** The horizontal re-flow factor for a child of a widened BoxContainer, or null for a non-box. */
export function containerHAlignFactor(
  containerLayout: string | null,
): number | null {
  if (!containerLayout) return null;
  if (containerLayout.startsWith("vbox")) return 0;
  if (!containerLayout.startsWith("hbox")) return null;
  return containerLayout.endsWith("-center")
    ? 0.5
    : containerLayout.endsWith("-end")
      ? 1
      : 0;
}

/** The context a walk root starts from: the root's parent is the viewport, which widens by the
 * whole budget. */
export function rootSpreadContext(
  presentationWidth: number,
  targetWidth: number,
): SpreadContext {
  return {
    parentDx: 0,
    delta: spreadDelta(presentationWidth, targetWidth),
    anchorDelta: spreadDelta(presentationWidth, targetWidth),
    rideDx: 0,
    parentWidth: presentationWidth,
    parentBasisX: 1,
    parentDxProp: false,
    containerAlign: null,
    containerVertical: false,
  };
}

function fieldAt(budget: SpreadBudget, gx: number): number {
  const delta = budget.delta;
  if (delta <= 0) return 0;
  const clamped =
    gx < 0 ? 0 : gx > budget.presentationWidth ? budget.presentationWidth : gx;
  return clamped * (delta / budget.presentationWidth);
}

/** One step's answer, written in place: the walk reuses one of these for every item, so a frame
 * that moves thousands of items allocates no per-item result or child context. */
interface SpreadStep {
  dx: number;
  hasWidth: boolean;
  width: number;
  parentDx: number;
  delta: number;
  anchorDelta: number;
  rideDx: number;
  parentWidth: number;
  parentBasisX: number;
  parentDxProp: boolean;
  containerAlign: number | null;
  containerVertical: boolean;
}

const newStep = (): SpreadStep => ({
  dx: 0,
  hasWidth: false,
  width: 0,
  parentDx: 0,
  delta: 0,
  anchorDelta: 0,
  rideDx: 0,
  parentWidth: 0,
  parentBasisX: 1,
  parentDxProp: false,
  containerAlign: null,
  containerVertical: false,
});

/** The algebra over scalars: `basisX` is `g[0]`, (`gx`, `gy`) the global origin `g[4]`, `g[5]`,
 * and (`rx`, `rw`) the own AABB's x and width when `hasRect`. */
function spreadInto(
  id: number,
  ctx: SpreadContext,
  shape: SpreadShape,
  basisX: number,
  gx: number,
  gy: number,
  hasRect: boolean,
  rx: number,
  rw: number,
  budget: SpreadBudget,
  deps: SpreadDeps,
  o: SpreadStep,
): void {
  let dx = ctx.parentDx;
  let hasWidth = false;
  let width = 0;
  let childDelta = ctx.delta;
  let childAnchorDelta = ctx.anchorDelta;
  let childParentDx = ctx.parentDx;
  let childRideDx = ctx.rideDx;
  let childDxProp = ctx.parentDxProp;
  let childAlign: number | null = null;
  let childVertical = false;
  const hasPaintBox = hasRect && rw > 0;

  if (budget.delta > 0 && ctx.delta > 0) {
    const anchored = shape.anchorLeft != null && shape.anchorRight != null;
    const leftClaim = anchored ? (shape.anchorLeft as number) : 0;
    const span = anchored
      ? (shape.anchorRight as number) - (shape.anchorLeft as number)
      : 0;
    const pointAnchor = shape.pointAnchor === true;
    const boxlessPositioner = !hasPaintBox && !pointAnchor;

    if (ctx.containerAlign != null) {
      // BOX CHILD: the parent is a widened BoxContainer that re-lays its packed row/column; a
      // Godot BoxContainer ignores child anchors. A vertical box's cross-axis-filling child that
      // spans the pre-widen width is full-frame background art and re-centres (0.5) instead.
      const boxClaim =
        ctx.containerVertical && hasPaintBox && rw >= ctx.parentWidth - 1
          ? 0.5
          : ctx.containerAlign;
      dx = ctx.parentDx + boxClaim * ctx.delta;
      childDelta = 0;
      childAnchorDelta = 0;
      childParentDx = dx;
      childRideDx = dx;
      childDxProp = false;
    } else if (boxlessPositioner && span <= 0.001) {
      // PASS-THROUGH GROUP: its own origin field shift, the budget passed through unconsumed so
      // each child claims the field for itself; its zero-size box gives descendants no anchor
      // frame, and its own claim becomes their ride shift.
      dx = fieldAt(budget, gx);
      childDelta = ctx.delta;
      childAnchorDelta = 0;
      childParentDx = ctx.parentDx;
      childRideDx = dx;
      childDxProp = ctx.parentDxProp;
    } else if (anchored && ctx.anchorDelta > 0) {
      // ANCHOR ALGEBRA: reproduce Godot's own resize (0/0 pins, 0/1 stretches, 1/1 hugs right,
      // 0.5/0.5 re-centres). A 0/0-anchored box spanning its whole frame is background art and
      // re-centres on ½Δ (the fullCanvas convention); the product's `centerClaim` adds the
      // scene-identity exceptions the geometry test cannot see.
      const fullCanvas =
        leftClaim <= 0.001 &&
        span <= 0.001 &&
        hasPaintBox &&
        rw >= ctx.parentWidth - 1;
      const centerClaim = deps.centerClaim
        ? deps.centerClaim(id, shape, fullCanvas)
        : fullCanvas;
      dx =
        ctx.parentDx +
        ctx.parentBasisX * (centerClaim ? 0.5 : leftClaim) * ctx.anchorDelta;
      const deltaW = span * ctx.anchorDelta;
      if (hasRect && Math.abs(deltaW) > 0.01) {
        hasWidth = true;
        width = rw + deltaW;
      }
      childDelta = deltaW;
      childAnchorDelta = deltaW;
      childParentDx = dx;
      childRideDx = dx;
      childDxProp = false;
    } else if ((anchored || shape.isControl === true) && hasPaintBox) {
      // BOXED CONTROL under a zero anchor-frame: rides its entity's one shift (the nearest
      // pass-through group's own claim), so the whole entity moves as one.
      dx = ctx.rideDx;
      childDelta = 0;
      childAnchorDelta = 0;
      childParentDx = dx;
      childRideDx = dx;
      childDxProp = true;
    } else {
      // POSITIONAL CLAIMER: world content placed at its own centre on the field, consuming the
      // budget; a point anchor (particle/spine) claims at its origin.
      dx = fieldAt(budget, hasPaintBox ? rx + rw / 2 : gx);
      childDelta = 0;
      childAnchorDelta = 0;
      childParentDx = dx;
      childRideDx = dx;
      childDxProp = true;
    }
  }

  // OWNER-ANCHORED FLOATER: the only correction is the owner's cumulative shift (the streamed
  // transform already sits at the owner's native rect). Overrides the field/anchor result; the
  // budget is consumed and the subtree rides the one shift. Applies whenever the session spread is
  // on (budget.delta > 0), even under a consumed subtree.
  if (budget.delta > 0 && shape.anchorOwnerId != null) {
    dx = deps.ownerShift?.(shape.anchorOwnerId, ctx.parentDx) ?? ctx.parentDx;
    hasWidth = false;
    childDelta = 0;
    childAnchorDelta = 0;
    childParentDx = dx;
    childRideDx = dx;
    childDxProp = false;
  }

  // REMOTE FOLLOWER: place it at the shift of the content under its true game point. Never
  // widens; the subtree rides the one shift rigidly.
  const followerDx =
    budget.delta > 0 ? (deps.followerShift?.(id, gx, gy) ?? null) : null;
  if (followerDx !== null) {
    dx = followerDx;
    hasWidth = false;
    childDelta = 0;
    childAnchorDelta = 0;
    childParentDx = dx;
    childRideDx = dx;
    childDxProp = false;
  }

  // CONTAINER RE-LAYOUT signal for this node's children: a widened BoxContainer re-lays its
  // children by alignment instead of the anchor algebra.
  if (budget.delta > 0 && childDelta > 0) {
    childAlign = containerHAlignFactor(shape.containerLayout ?? null);
    childVertical =
      childAlign != null && shape.containerLayout?.startsWith("vbox") === true;
  }

  o.dx = dx;
  o.hasWidth = hasWidth;
  o.width = width;
  o.parentDx = childParentDx;
  o.delta = childDelta;
  o.anchorDelta = childAnchorDelta;
  o.rideDx = childRideDx;
  o.parentWidth = hasPaintBox ? rw : ctx.parentWidth;
  o.parentBasisX = basisX;
  o.parentDxProp = childDxProp;
  o.containerAlign = childAlign;
  o.containerVertical = childVertical;
}

/**
 * WHERE ONE ITEM LANDS ON THE SQUEEZE FIELD, and what its children inherit. A faithful port of the
 * mirror's generic branches (`computeSpread` without the scene-identity env): the caller supplies
 * the item's game global (`g`), its own AABB (`rect`, null for a box-less item) and its shape, and
 * reads the answer and the child context out of the returned `SpreadOut`.
 *
 * `dx` is ABSOLUTE (the item's total shift). The override table composes an item's entry with
 * every ancestor's, so a caller writing overrides writes `dx` minus what its ancestors already
 * wrote, as `createSpreadExtension` does.
 */
export function computeSpreadItem(
  id: number,
  ctx: SpreadContext,
  shape: SpreadShape,
  g: Affine2D,
  rect: Rect | null,
  budget: SpreadBudget,
  deps: SpreadDeps,
): SpreadOut {
  const o = newStep();
  spreadInto(
    id,
    ctx,
    shape,
    g[0],
    g[4],
    g[5],
    rect != null,
    rect?.x ?? 0,
    rect?.w ?? 0,
    budget,
    deps,
    o,
  );
  return {
    dx: o.dx,
    width: o.hasWidth ? o.width : undefined,
    child: {
      parentDx: o.parentDx,
      delta: o.delta,
      anchorDelta: o.anchorDelta,
      rideDx: o.rideDx,
      parentWidth: o.parentWidth,
      parentBasisX: o.parentBasisX,
      parentDxProp: o.parentDxProp,
      containerAlign: o.containerAlign,
      containerVertical: o.containerVertical,
    },
  };
}

/** A local shift this small is float noise from `dx − ancestors`, not a move: no entry. */
const LOCAL_EPSILON = 1e-6;

/** Per walk-stack slot: the child context (9 values) and what the ancestors wrote (1). */
const STRIDE = 10;

/** `ItemQuery` gives no raw read: rebuild the `queryItem` layout from the public calls. */
function itemFromQuery(
  query: ItemQuery,
  id: number,
  out: Float64Array,
): ArrayLike<number> {
  const t = query.transform(id);
  if (t === null) return EMPTY_ITEM;
  out[2] = 1;
  for (let i = 0; i < 6; i++) out[3 + i] = t[i];
  const r = query.rect(id);
  out[9] = r === null ? 0 : 1;
  out[10] = r?.x ?? 0;
  out[11] = r?.y ?? 0;
  out[12] = r?.w ?? 0;
  out[13] = r?.h ?? 0;
  return out;
}

const EMPTY_ITEM: ArrayLike<number> = new Float64Array(0);

/**
 * A `RenderStreamExtension` that walks the draw tree and writes a translate override for every
 * item the spread moves.
 *
 * Composition: the table composes an item's override with its ancestors', so each item's entry is
 * its absolute shift minus the shifts its ancestors' entries already apply; `effective(id)` is
 * then the absolute shift `computeSpreadItem` answered.
 *
 * Cost: the walk runs once per newly applied transaction and after an identity change (an
 * `item_meta` record, a removal, a new session). A redraw (`seq` null) or a frame with no new
 * transaction costs one comparison. A walk reads each item once (one raw item query and one
 * children query), reuses one flat stack and one step record, and writes only entries whose value
 * changed. The `shape` and `deps` answers must be functions of the item's identity and the game
 * state (the walk does not rerun when they change by themselves). A whole-scene batched query (one
 * wasm call for the tree) is the next lever; it needs a core export.
 *
 * The module owns the override entries of every item it moves (single ownership per id, see
 * `OverrideTable`): a product module writing the same ids overwrites the spread and vice versa.
 */
export function createSpreadExtension(
  options: SpreadOptions,
): RenderStreamExtension {
  const budget: SpreadBudget = {
    presentationWidth: options.presentationWidth,
    targetWidth: options.targetWidth,
    delta: spreadDelta(options.presentationWidth, options.targetWidth),
  };
  const deps: SpreadDeps = options.deps ?? {};
  const ids = new Set<number>();
  let roots: number[] = [];
  let rootsDirty = true;
  /** An identity changed since the last walk (the shape answers may differ). */
  let walkDirty = true;
  /** The seq the last walk ran for (null: none this session). */
  let lastSeq: number | null = null;
  /** The local translate written per item, so a shift back to 0 clears the override, identity is
   * never written (a dx-0 translate would bloat the table with entries the core must copy and
   * re-cull), and an unchanged value is not written again. */
  const written = new Map<number, number>();

  // The walk's reused state: the DFS stack (ids + STRIDE floats per slot), one context the
  // algebra reads, one step it writes, and one item buffer for a query with no raw read.
  let stackIds = new Uint32Array(256);
  let stackCtx = new Float64Array(256 * STRIDE);
  const ctx = {
    parentDx: 0,
    delta: 0,
    anchorDelta: 0,
    rideDx: 0,
    parentWidth: 0,
    parentBasisX: 1,
    parentDxProp: false,
    containerAlign: null as number | null,
    containerVertical: false,
  };
  const step = newStep();
  const itemScratch = new Float64Array(14);
  const root = rootSpreadContext(budget.presentationWidth, budget.targetWidth);

  const reserve = (n: number): void => {
    if (n <= stackIds.length) return;
    let cap = stackIds.length * 2;
    while (cap < n) cap *= 2;
    const ids2 = new Uint32Array(cap);
    ids2.set(stackIds);
    stackIds = ids2;
    const ctx2 = new Float64Array(cap * STRIDE);
    ctx2.set(stackCtx);
    stackCtx = ctx2;
  };

  const recomputeRoots = (query: ItemQuery): number[] => {
    const out: number[] = [];
    for (const id of ids) if (query.parent(id) === null) out.push(id);
    out.sort((a, b) => a - b);
    return out;
  };

  return {
    id: "spread",
    wants: options.wants ?? { fields: ["class"] },
    onSession: () => {
      // A new session: a fresh table on both sides (the host cleared every entry).
      ids.clear();
      written.clear();
      rootsDirty = true;
      walkDirty = true;
      lastSeq = null;
    },
    onItemMeta: (batch) => {
      // A full replaces the identities, not the override table: `written` keeps mirroring it.
      if (batch.form === "full") ids.clear();
      for (const m of batch.items) ids.add(m.id);
      rootsDirty = true;
      walkDirty = true;
    },
    onItemsRemoved: (removed) => {
      for (const id of removed) {
        ids.delete(id);
        written.delete(id);
      }
      rootsDirty = true;
      walkDirty = true;
    },
    beforeDraw: (f) => {
      if (budget.delta <= 0) return;
      // A static frame (a redraw, or no new transaction) and no identity change: the table
      // already holds this state's answer.
      if (!walkDirty && (f.seq === null || f.seq === lastSeq)) return;
      if (f.seq !== null) lastSeq = f.seq;
      walkDirty = false;
      const query = f.query;
      if (rootsDirty) {
        roots = recomputeRoots(query);
        rootsDirty = false;
      }
      const raw = (query as RawItemQuery)[RAW_ITEM];
      const overrides = f.overrides;

      // Iterative DFS so a deep scene does not blow the JS stack; roots pop last-first.
      let n = 0;
      reserve(roots.length);
      for (const id of roots) {
        const b = n * STRIDE;
        stackIds[n] = id;
        stackCtx[b] = root.parentDx;
        stackCtx[b + 1] = root.delta;
        stackCtx[b + 2] = root.anchorDelta;
        stackCtx[b + 3] = root.rideDx;
        stackCtx[b + 4] = root.parentWidth;
        stackCtx[b + 5] = root.parentBasisX;
        stackCtx[b + 6] = root.parentDxProp ? 1 : 0;
        stackCtx[b + 7] = root.containerAlign ?? Number.NaN;
        stackCtx[b + 8] = root.containerVertical ? 1 : 0;
        stackCtx[b + 9] = 0;
        n++;
      }
      while (n > 0) {
        n--;
        const id = stackIds[n];
        const b = n * STRIDE;
        const item = raw ? raw(id) : itemFromQuery(query, id, itemScratch);
        if (item.length === 0 || item[2] === 0) continue;
        const basisX = item[3];
        const gx = item[7];
        const gy = item[8];
        const hasRect = item[9] !== 0;
        const rx = item[10];
        const rw = item[12];
        ctx.parentDx = stackCtx[b];
        ctx.delta = stackCtx[b + 1];
        ctx.anchorDelta = stackCtx[b + 2];
        ctx.rideDx = stackCtx[b + 3];
        ctx.parentWidth = stackCtx[b + 4];
        ctx.parentBasisX = stackCtx[b + 5];
        ctx.parentDxProp = stackCtx[b + 6] !== 0;
        const align = stackCtx[b + 7];
        ctx.containerAlign = Number.isNaN(align) ? null : align;
        ctx.containerVertical = stackCtx[b + 8] !== 0;
        const ancestorDx = stackCtx[b + 9];
        spreadInto(
          id,
          ctx,
          options.shape(id),
          basisX,
          gx,
          gy,
          hasRect,
          rx,
          rw,
          budget,
          deps,
          step,
        );
        // The table composes ancestors' entries: write only this item's own part.
        const local = step.dx - ancestorDx;
        let childAncestorDx = ancestorDx;
        if (local > LOCAL_EPSILON || local < -LOCAL_EPSILON) {
          childAncestorDx = ancestorDx + local;
          if (written.get(id) !== local) {
            overrides.translate(id, local, 0);
            written.set(id, local);
          }
        } else if (written.has(id)) {
          overrides.clear(id);
          written.delete(id);
        }
        const children = query.children(id);
        const count = children.length;
        if (count === 0) continue;
        reserve(n + count);
        for (let i = count - 1; i >= 0; i--) {
          const c = n * STRIDE;
          stackIds[n] = children[i];
          stackCtx[c] = step.parentDx;
          stackCtx[c + 1] = step.delta;
          stackCtx[c + 2] = step.anchorDelta;
          stackCtx[c + 3] = step.rideDx;
          stackCtx[c + 4] = step.parentWidth;
          stackCtx[c + 5] = step.parentBasisX;
          stackCtx[c + 6] = step.parentDxProp ? 1 : 0;
          stackCtx[c + 7] = step.containerAlign ?? Number.NaN;
          stackCtx[c + 8] = step.containerVertical ? 1 : 0;
          stackCtx[c + 9] = childAncestorDx;
          n++;
        }
      }
    },
  };
}
