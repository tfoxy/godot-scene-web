import { asNumber, asVector2, type GodotVariant } from "@godot-scene-web/core";
import {
  combinedMinimum,
  explicitSizeFromProps,
  sizeFromOffsets,
} from "./minimum-size";
import type { GodotLayoutOptions, GodotRect, IndexedNode } from "./types";

export function rootRect(
  indexed: IndexedNode,
  viewport: GodotRect,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): GodotRect {
  const minimum = combinedMinimum(indexed, byPath, options);
  const width =
    numeric(indexed.props, "size_width") ??
    sizeFromOffsets(indexed)?.width ??
    minimum?.width ??
    viewport.width;
  const height =
    numeric(indexed.props, "size_height") ??
    sizeFromOffsets(indexed)?.height ??
    minimum?.height ??
    viewport.height;
  return { x: viewport.x, y: viewport.y, width, height };
}

export function controlRect(
  indexed: IndexedNode,
  parent: GodotRect,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): GodotRect {
  const leftAnchor = numeric(indexed.props, "anchor_left") ?? 0;
  const topAnchor = numeric(indexed.props, "anchor_top") ?? 0;
  const rightAnchor = numeric(indexed.props, "anchor_right") ?? leftAnchor;
  const bottomAnchor = numeric(indexed.props, "anchor_bottom") ?? topAnchor;
  const position = asVector2(indexed.props.position);
  const leftOffset =
    numeric(indexed.props, "offset_left") ??
    numeric(indexed.props, "position_x") ??
    position?.x ??
    0;
  const topOffset =
    numeric(indexed.props, "offset_top") ??
    numeric(indexed.props, "position_y") ??
    position?.y ??
    0;
  const explicitSize = explicitSizeFromProps(indexed);
  // A missing right/bottom offset is Godot's default of 0 (the edge sits on its
  // anchor), not a copy of the start offset. Defaulting to the start offset would
  // give a spanning anchored node (anchor_right>anchor_left) zero size instead of
  // reaching the parent edge. An explicit `size` still derives the far offset.
  const rightOffset =
    numeric(indexed.props, "offset_right") ??
    (explicitSize ? leftOffset + explicitSize.width : 0);
  const bottomOffset =
    numeric(indexed.props, "offset_bottom") ??
    (explicitSize ? topOffset + explicitSize.height : 0);
  const left = parent.x + parent.width * leftAnchor + leftOffset;
  const top = parent.y + parent.height * topAnchor + topOffset;
  const right = parent.x + parent.width * rightAnchor + rightOffset;
  const bottom = parent.y + parent.height * bottomAnchor + bottomOffset;
  const rect = normalizeRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
  return growToMinimum(rect, indexed, byPath, options);
}

/**
 * Expands and repositions a rect when its combined minimum size exceeds the
 * offset-derived size, mirroring `Control::_size_changed`. The grow direction
 * (BEGIN shifts the start edge, BOTH centers, END only expands) applies
 * unconditionally, independent of anchors.
 */
export function growToMinimum(
  rect: GodotRect,
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): GodotRect {
  const minimum = combinedMinimum(indexed, byPath, options, rect);
  if (!minimum) {
    return rect;
  }
  let { x, y, width, height } = rect;
  if (minimum.width > width) {
    const delta = minimum.width - width;
    const grow = numeric(indexed.props, "grow_horizontal") ?? 1;
    if (grow === 0) {
      x -= delta;
    } else if (grow === 2) {
      x -= delta / 2;
    }
    width = minimum.width;
  }
  if (minimum.height > height) {
    const delta = minimum.height - height;
    const grow = numeric(indexed.props, "grow_vertical") ?? 1;
    if (grow === 0) {
      y -= delta;
    } else if (grow === 2) {
      y -= delta / 2;
    }
    height = minimum.height;
  }
  return { x, y, width, height };
}

export function numeric(
  props: Record<string, GodotVariant>,
  name: string,
): number | undefined {
  return asNumber(props[name]);
}

export function normalizeRect(rect: GodotRect): GodotRect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  };
}

/**
 * Apply a node's own `scale` around `pivotOffset` to its layout rect, producing
 * the on-screen global rect. Mirrors the renderer's `transform: scale(...)` with
 * `transform-origin: <pivotOffset>` (see node-style.ts): the pivot is a fixed
 * point, so the top-left corner maps to `rect.pos + pivot·(1 − scale)` and the
 * size scales. Godot's `Control.get_global_rect()` includes scale the same way,
 * which is what the live-game layout-diff compares against. Identity scale
 * returns the rect unchanged.
 */
export function scaledRect(
  rect: GodotRect,
  scale: { x: number; y: number },
  pivotOffset: { x: number; y: number },
): GodotRect {
  if (scale.x === 1 && scale.y === 1) {
    return rect;
  }
  return {
    x: rect.x + pivotOffset.x * (1 - scale.x),
    y: rect.y + pivotOffset.y * (1 - scale.y),
    width: rect.width * scale.x,
    height: rect.height * scale.y,
  };
}

/**
 * A 2×3 affine `(x,y) -> (a·x + c·y + tx, b·x + d·y + ty)` — the linear 2×2 part
 * `[[a,c],[b,d]]` plus a translation. Columns are the transformed basis axes:
 * column 0 `(a,b)` is the x-axis, column 1 `(c,d)` the y-axis. This represents a
 * node's full ancestor transform (scale AND rotation about a pivot) so a node's
 * `renderedRect` matches the live game's `get_global_rect()`, which includes every
 * ancestor's transform. A pure scale+translate is `b=c=0` (`a=sx`, `d=sy`).
 */
export interface RectAffine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY_AFFINE: RectAffine = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  tx: 0,
  ty: 0,
};

/** Compose two affines (2×3 matrix multiply) so the result maps `x -> outer(inner(x))`. */
export function composeAffine(
  outer: RectAffine,
  inner: RectAffine,
): RectAffine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/**
 * Apply an affine to a rect, producing an axis-aligned `GodotRect` matching Godot
 * `get_global_rect()`: the top-left ORIGIN is transformed through the full
 * (rotation-bearing) matrix, while width/height take the *unrotated* extent — each
 * axis scaled by its column magnitude (`hypot`), NOT inflated to a rotated bounding
 * box. For a pure scale+translate (`b=c=0`) this reduces bit-for-bit to the old
 * `sx·x+tx` behavior.
 */
export function applyAffine(transform: RectAffine, rect: GodotRect): GodotRect {
  const { a, b, c, d, tx, ty } = transform;
  if (a === 1 && b === 0 && c === 0 && d === 1 && tx === 0 && ty === 0) {
    return rect;
  }
  return {
    x: a * rect.x + c * rect.y + tx,
    y: b * rect.x + d * rect.y + ty,
    width: rect.width * Math.hypot(a, b),
    height: rect.height * Math.hypot(c, d),
  };
}

/**
 * The scale+rotation transform a node applies to its own content and all its
 * descendants, in the global (unscaled-layout) coordinate space, pivoting about the
 * node's global pivot `rect.pos + pivotOffset`. The linear part is Godot's
 * `Transform2D(rotation, scale)` basis — x-axis `(cos·sx, sin·sx)`, y-axis
 * `(-sin·sy, cos·sy)` — i.e. rotate∘scale, which is what the live game composes.
 *
 * NOTE: `rotation` is in radians. Correct when the rotation pivot is the rect origin
 * (`pivotOffset` 0, the only case in the captured data and the case the CSS renderer
 * pivots at the origin for); a non-zero pivot combined with self-rotation would also
 * shift the node's own top-left, which `renderedRect` does not model.
 */
export function ownTransformAffine(
  rect: GodotRect,
  scale: { x: number; y: number },
  rotation: number,
  pivotOffset: { x: number; y: number },
): RectAffine {
  const gx = rect.x + pivotOffset.x;
  const gy = rect.y + pivotOffset.y;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const a = cos * scale.x;
  const b = sin * scale.x;
  const c = -sin * scale.y;
  const d = cos * scale.y;
  // Translate so the global pivot `g` stays fixed: t = g − M·g.
  return {
    a,
    b,
    c,
    d,
    tx: gx - (a * gx + c * gy),
    ty: gy - (b * gx + d * gy),
  };
}

/** Pure scale-about-pivot (no rotation) — `ownTransformAffine` with `rotation = 0`. */
export function ownScaleAffine(
  rect: GodotRect,
  scale: { x: number; y: number },
  pivotOffset: { x: number; y: number },
): RectAffine {
  return ownTransformAffine(rect, scale, 0, pivotOffset);
}
