import { asNumber } from "@godot-scene-web/core";
import { deriveNodeVisuals } from "@godot-scene-web/scene-graph";
import {
  applyAffine,
  composeAffine,
  IDENTITY_AFFINE,
  ownTransformAffine,
  scaledRect,
} from "./rects";
import type { GodotLayoutNode, GodotRect, IndexedNode } from "./types";

export function makeLayoutNode(
  indexed: IndexedNode,
  rect: GodotRect,
  parent?: GodotLayoutNode,
): GodotLayoutNode {
  // The rect-free render fields (scale, pivot, z-index, alignment, visibility,
  // resource refs, …) are derived by the shared `deriveNodeVisuals` — the SAME
  // function the browser-native producer (`deriveSceneGraph`) uses, so computed
  // and browser modes can never drift on these. This node only adds the
  // rect-domain geometry on top.
  const base = deriveNodeVisuals(indexed, parent?.zIndex);
  // `rotation` (radians) ?? `rotation_degrees` (degrees) ?? 0 — matching the CSS
  // renderer's precedence (node-style.ts). Rotation propagates to DESCENDANTS via
  // `cumulativeTransform` but is deliberately left out of this node's OWN
  // `renderedRect` (see below).
  const rotationDegrees = asNumber(indexed.props.rotation_degrees);
  const rotation =
    asNumber(indexed.props.rotation) ??
    (rotationDegrees === undefined ? 0 : (rotationDegrees * Math.PI) / 180);
  // `renderedRect` must match the live game's `get_global_rect()`, which includes
  // every ancestor's transform. The layout positions nodes in unscaled space and
  // applies each node's transform as a CSS `transform` that cascades to its
  // descendants, so bake the parent's cumulative transform onto this node's own
  // scaled rect, and pass our own composed transform down to our children. The
  // node's OWN rotation is intentionally NOT applied to its own `renderedRect`
  // (rotation stays visual-only for the node itself — `get_global_rect()` reports
  // the unrotated origin/size when pivoting at the origin); it IS folded into
  // `cumulativeTransform` so descendant origins follow the rotated frame.
  const parentTransform = parent?.cumulativeTransform ?? IDENTITY_AFFINE;
  const renderedRect = applyAffine(
    parentTransform,
    scaledRect(rect, base.scale, base.pivotOffset),
  );
  const cumulativeTransform = composeAffine(
    parentTransform,
    ownTransformAffine(rect, base.scale, rotation, base.pivotOffset),
  );
  return { ...base, rect, renderedRect, cumulativeTransform };
}
