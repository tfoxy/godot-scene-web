// PRES-C (client-extensions-design.md §6, results/p3/pres-c.md): the client-side route of the
// widescreen "spread" -- keep the game 16:9 and widen the layout in the browser with a generic
// module over TAG2's override table. This is a port of the old mirror's `computeSpread` GENERIC
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
// The only rule TAG2's override table cannot express is the WIDEN: the table composes an affine
// (translate/scale), and scaling a box's paint also scales its flattened children (E composes down
// the tree), which is exactly the "no internal tearing" the mirror forbids. So the module computes
// `width` for the widened box and reports it, but writes only the translate shift. A product that
// needs a widened panel draws it with a product draw-list change (out of GSW's scope).

import type {
  Affine2D,
  ItemMetaField,
  Rect,
  RenderStreamExtension,
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
  /** This item's absolute horizontal shift, in presentation px. */
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

/**
 * WHERE ONE ITEM LANDS ON THE SQUEEZE FIELD, and what its children inherit. A faithful port of the
 * mirror's generic branches (`computeSpread` without the scene-identity env): the caller supplies
 * the item's game global (`g`), its own AABB (`rect`, null for a box-less item) and its shape, and
 * reads the answer and the child context out of the returned `SpreadOut`.
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
  let dx = ctx.parentDx;
  let width: number | undefined;
  let childDelta = ctx.delta;
  let childAnchorDelta = ctx.anchorDelta;
  let childParentDx = ctx.parentDx;
  let childRideDx = ctx.rideDx;
  let childDxProp = ctx.parentDxProp;
  let childAlign: number | null = null;
  let childVertical = false;

  if (budget.delta > 0 && ctx.delta > 0) {
    const anchored = shape.anchorLeft != null && shape.anchorRight != null;
    const leftClaim = anchored ? (shape.anchorLeft as number) : 0;
    const span = anchored
      ? (shape.anchorRight as number) - (shape.anchorLeft as number)
      : 0;
    const hasPaintBox = rect != null && rect.w > 0;
    const pointAnchor = shape.pointAnchor === true;
    const boxlessPositioner = !hasPaintBox && !pointAnchor;

    if (ctx.containerAlign != null) {
      // BOX CHILD: the parent is a widened BoxContainer that re-lays its packed row/column; a
      // Godot BoxContainer ignores child anchors. A vertical box's cross-axis-filling child that
      // spans the pre-widen width is full-frame background art and re-centres (0.5) instead.
      const boxClaim =
        ctx.containerVertical &&
        hasPaintBox &&
        rect != null &&
        rect.w >= ctx.parentWidth - 1
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
      dx = fieldAt(budget, g[4]);
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
        rect != null &&
        rect.w >= ctx.parentWidth - 1;
      const centerClaim = (deps.centerClaim ?? ((_i, _s, fc) => fc))(
        id,
        shape,
        fullCanvas,
      );
      dx =
        ctx.parentDx +
        ctx.parentBasisX * (centerClaim ? 0.5 : leftClaim) * ctx.anchorDelta;
      const deltaW = span * ctx.anchorDelta;
      if (rect != null && Math.abs(deltaW) > 0.01) {
        width = rect.w + deltaW;
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
      const gx = hasPaintBox && rect != null ? rect.x + rect.w / 2 : g[4];
      dx = fieldAt(budget, gx);
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
    width = undefined;
    childDelta = 0;
    childAnchorDelta = 0;
    childParentDx = dx;
    childRideDx = dx;
    childDxProp = false;
  }

  // REMOTE FOLLOWER: place it at the shift of the content under its true game point. Never
  // widens; the subtree rides the one shift rigidly.
  const followerDx =
    budget.delta > 0 ? (deps.followerShift?.(id, g[4], g[5]) ?? null) : null;
  if (followerDx !== null) {
    dx = followerDx;
    width = undefined;
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

  return {
    dx,
    width,
    child: {
      parentDx: childParentDx,
      delta: childDelta,
      anchorDelta: childAnchorDelta,
      rideDx: childRideDx,
      parentWidth: rect != null && rect.w > 0 ? rect.w : ctx.parentWidth,
      parentBasisX: g[0],
      parentDxProp: childDxProp,
      containerAlign: childAlign,
      containerVertical: childVertical,
    },
  };
}

/** A `RenderStreamExtension` that walks the draw tree each frame and writes a translate override
 * for every item the spread moves. The table keeps only real changes, so a static frame costs the
 * walk and nothing else. */
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
  /** The last written dx per item, so a shift back to 0 clears the override and identity is never
   * written (a dx-0 translate would bloat the table with entries the core must copy and re-cull). */
  const written = new Map<number, number>();

  const recomputeRoots = (query: {
    parent(id: number): number | null;
  }): number[] => {
    const out: number[] = [];
    for (const id of ids) if (query.parent(id) === null) out.push(id);
    out.sort((a, b) => a - b);
    return out;
  };

  return {
    id: "spread",
    wants: options.wants ?? { fields: ["class"] },
    onItemMeta: (batch) => {
      if (batch.form === "full") {
        ids.clear();
        written.clear();
      }
      for (const m of batch.items) ids.add(m.id);
      rootsDirty = true;
    },
    onItemsRemoved: (removed) => {
      for (const id of removed) {
        ids.delete(id);
        written.delete(id);
      }
      rootsDirty = true;
    },
    beforeDraw: (f) => {
      if (budget.delta <= 0) return;
      if (rootsDirty) {
        roots = recomputeRoots(f.query);
        rootsDirty = false;
      }
      // Iterative DFS so a deep scene does not blow the JS stack.
      const stack: { id: number; ctx: SpreadContext }[] = roots.map((id) => ({
        id,
        ctx: rootSpreadContext(budget.presentationWidth, budget.targetWidth),
      }));
      while (stack.length > 0) {
        const { id, ctx } = stack.pop() as { id: number; ctx: SpreadContext };
        const g = f.query.transform(id);
        if (g === null) continue;
        const rect = f.query.rect(id);
        const out = computeSpreadItem(
          id,
          ctx,
          options.shape(id),
          g,
          rect,
          budget,
          deps,
        );
        if (out.dx !== 0) {
          f.overrides.translate(id, out.dx, 0);
          written.set(id, out.dx);
        } else if (written.has(id)) {
          f.overrides.clear(id);
          written.delete(id);
        }
        const children = f.query.children(id);
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ id: children[i], ctx: out.child });
        }
      }
    },
  };
}
