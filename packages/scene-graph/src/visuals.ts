import {
  asBoolean,
  asNumber,
  asResourceRef,
  asString,
  asVector2,
  type GodotResourceRefValue,
  type GodotVariant,
} from "@godot-scene-web/core";
import type { DerivedNodeInput, GodotSceneNodeBase } from "./public-types";

/**
 * Derive a node's rect-free render fields (scale, pivot, z-index, alignment,
 * visibility, draw order, resource refs, …) from its resolved properties and its
 * parent's z-index. Shared by the browser-native producer (`deriveSceneGraph`,
 * which stops here) and the computed rect engine (`makeLayoutNode`, which adds
 * `rect`/`renderedRect`/`cumulativeTransform`), so the two render modes can never
 * drift on these values.
 */
export function deriveNodeVisuals(
  indexed: DerivedNodeInput,
  parentZIndex: number | undefined,
): GodotSceneNodeBase {
  const visuals = propsVisuals(indexed.props);
  return {
    path: indexed.path,
    name: indexed.node.name,
    type: indexed.node.type ?? "Node",
    parentPath: indexed.parentPath,
    children: [...indexed.children],
    source: indexed.node,
    visible: visuals.visible,
    zIndex: visuals.zAsRelative
      ? (parentZIndex ?? 0) + visuals.ownZIndex
      : visuals.ownZIndex,
    drawOrder: indexed.order,
    zAsRelative: visuals.zAsRelative,
    showBehindParent: visuals.showBehindParent,
    clipContents: visuals.clipContents,
    textAlign: visuals.textAlign,
    textVerticalAlign: visuals.textVerticalAlign,
    scale: visuals.scale,
    pivotOffset: visuals.pivotOffset,
    properties: indexed.props,
    resourceRefs: visuals.resourceRefs,
  };
}

// The props-only slice of a node's visuals, memoized per effective-props record
// identity. The scene index keeps those records identity-stable for unchanged
// documents across derives, so re-derives (and the rect engine's repeated layout
// passes) skip the per-property coercions and the recursive `collectResourceRefs`
// walk. Context-dependent fields (path/name/type, children, draw order, the
// parent-composed zIndex) must never enter this memo — `type` in particular is
// option-scoped via `overrideNodeType`.
interface PropsVisuals {
  visible: boolean;
  ownZIndex: number;
  zAsRelative: boolean;
  showBehindParent: boolean;
  clipContents: boolean;
  textAlign: GodotSceneNodeBase["textAlign"];
  textVerticalAlign: GodotSceneNodeBase["textVerticalAlign"];
  scale: { x: number; y: number };
  pivotOffset: { x: number; y: number };
  resourceRefs: GodotResourceRefValue[];
}

const propsVisualsCache = new WeakMap<
  Record<string, GodotVariant>,
  PropsVisuals
>();

function propsVisuals(props: Record<string, GodotVariant>): PropsVisuals {
  const cached = propsVisualsCache.get(props);
  if (cached) {
    return cached;
  }
  const visuals: PropsVisuals = {
    visible: asBoolean(props.visible) ?? true,
    ownZIndex: asNumber(props.z_index) ?? 0,
    zAsRelative: asBoolean(props.z_as_relative) ?? true,
    showBehindParent: asBoolean(props.show_behind_parent) ?? false,
    clipContents:
      (asBoolean(props.clip_contents) ?? false) ||
      (asNumber(props.clip_children) ?? 0) > 0,
    textAlign: deriveTextAlign(props.horizontal_alignment),
    textVerticalAlign: deriveTextVerticalAlign(props.vertical_alignment),
    scale: asVector2(props.scale) ?? {
      x: asNumber(props.scale_x) ?? 1,
      y: asNumber(props.scale_y) ?? 1,
    },
    pivotOffset: asVector2(props.pivot_offset) ?? {
      x: asNumber(props.pivot_offset_x) ?? 0,
      y: asNumber(props.pivot_offset_y) ?? 0,
    },
    resourceRefs: collectResourceRefs(props),
  };
  propsVisualsCache.set(props, visuals);
  return visuals;
}

function deriveTextAlign(
  value: GodotVariant | undefined,
): GodotSceneNodeBase["textAlign"] {
  const number = asNumber(value);
  if (number === 1) {
    return "center";
  }
  if (number === 2) {
    return "right";
  }
  if (number === 3) {
    return "fill";
  }
  const string = asString(value)?.toLowerCase();
  if (string === "center" || string === "horizontal_alignment_center") {
    return "center";
  }
  if (string === "right" || string === "horizontal_alignment_right") {
    return "right";
  }
  if (string === "fill" || string === "horizontal_alignment_fill") {
    return "fill";
  }
  return "left";
}

function deriveTextVerticalAlign(
  value: GodotVariant | undefined,
): GodotSceneNodeBase["textVerticalAlign"] {
  const number = asNumber(value);
  if (number === 1) {
    return "center";
  }
  if (number === 2) {
    return "bottom";
  }
  if (number === 3) {
    return "fill";
  }
  const string = asString(value)?.toLowerCase();
  if (string === "center" || string === "vertical_alignment_center") {
    return "center";
  }
  if (string === "bottom" || string === "vertical_alignment_bottom") {
    return "bottom";
  }
  if (string === "fill" || string === "vertical_alignment_fill") {
    return "fill";
  }
  return "top";
}

function collectResourceRefs(
  props: Record<string, GodotVariant>,
): GodotResourceRefValue[] {
  return Object.values(props).flatMap(
    function collect(value): GodotResourceRefValue[] {
      const ref = asResourceRef(value);
      if (ref) {
        return [ref];
      }
      if (Array.isArray(value)) {
        return value.flatMap(collect);
      }
      if (value && typeof value === "object") {
        return Object.values(value).flatMap(collect);
      }
      return [];
    },
  );
}
