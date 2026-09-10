import {
  asBoolean,
  asNumber,
  asVector2,
  type GodotVariant,
} from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import { cssSize, round } from "./css-values";
import { sourceNodeForLayout } from "./resources";
import { panelStyleBoxMetrics } from "./style-box";
import type {
  GodotHtmlContainerLayout,
  GodotHtmlNode,
  GodotHtmlRenderOptions,
} from "./types";

// Godot `Control.SizeFlags` bits.
const SIZE_FILL = 1;
const SIZE_EXPAND = 2;
const SIZE_SHRINK_CENTER = 4;
const SIZE_SHRINK_END = 8;

/**
 * Browser-native geometry pass — the rect-free counterpart of
 * `assignContainerLayoutStyles`. Instead of pinning every node to a computed
 * pixel rect, it lets the CSS engine resolve layout: containers become flex/grid
 * boxes and their children flow; anchored Controls map their anchors+offsets to
 * CSS `position:absolute` insets; the root takes the viewport size. Real DOM text
 * therefore sizes itself (a label with no fixed size grows to its text), which is
 * the whole point — and why a missing `resolveTextContentSize` no longer collapses
 * a `RichTextLabel`.
 */
export function assignBrowserNativeLayout(
  nodes: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
  viewport: { width: number; height: number },
): void {
  const htmlByPath = new Map(nodes.map((node) => [node.path, node]));
  // Pass 1 — per-node box: the outer box from anchors (root takes the viewport).
  // Container children are reflowed in pass 2, which overrides this.
  for (const node of nodes) {
    const layout = layoutByPath.get(node.path);
    if (!layout) {
      continue;
    }
    if (node.parentPath === null) {
      assignRootGeometry(node, viewport);
    } else {
      assignAnchorGeometry(node, layout);
    }
  }
  // Pass 2 — CSS containers: emit the parent's flex/grid box (from properties, no
  // rects) and reflow each direct child as a native flow item.
  for (const parent of nodes) {
    const layout = layoutByPath.get(parent.path);
    if (!layout || !isCssContainerType(parent.type)) {
      continue;
    }
    parent.containerLayout = containerLayoutKind(parent.type);
    parent.attributes["data-godot-container-layout"] = parent.containerLayout;
    const horizontal = containerIsHorizontal(parent.type, layout);
    assignContainerParentStyle(parent, layout, options, horizontal);
    const children = parent.children
      .map((path) => htmlByPath.get(path))
      .filter((child): child is GodotHtmlNode => Boolean(child))
      .filter(
        (child) => layoutByPath.get(child.path)?.parentPath === parent.path,
      );
    for (const child of children) {
      // Godot containers only lay out CONTROL children (Container::_sort_children);
      // a Node2D child keeps its own canvas transform.
      if (isNode2DType(child.type)) {
        continue;
      }
      const childLayout = layoutByPath.get(child.path);
      if (childLayout) {
        setFlowChild(child, childLayout, parent.type, horizontal);
      }
    }
  }
  // Pass 3 — the self-layer (fill vs in-flow text). Runs after pass 2 so it reads
  // each node's FINAL outer box: a container child's anchor insets were replaced by
  // flow styles (and possibly a `min-height` from `custom_minimum_size`), which
  // changes the fill-vs-auto decision for text.
  for (const node of nodes) {
    if (layoutByPath.has(node.path)) {
      configureSelfLayer(node);
    }
  }
  // Invisible nodes need no geometry pass: the model builder prunes effectively
  // hidden subtrees to comment placeholders, which take no space in any flow —
  // matching Godot containers allocating nothing for a hidden child.
}

// What a container parent tells each of its children about itself, so the child
// can compute its own flow box (`setFlowChild` needs only the parent's TYPE and
// axis — never the parent's resolved style or its siblings). `parentType === null`
// ⇒ the parent is not a CSS container, so the child keeps its anchor box.
export interface BrowserNativeParentContext {
  parentType: string | null;
  parentHorizontal: boolean;
}

export const ROOT_PARENT_CONTEXT: BrowserNativeParentContext = {
  parentType: null,
  parentHorizontal: false,
};

// The per-node counterpart of `assignBrowserNativeLayout`: run the SAME three
// passes for ONE node, in the same order, and return the context this node hands
// to ITS children. The batch loop above does pass 1 for all nodes, then pass 2,
// then pass 3; but each pass touches only a node's own props + (for pass 2) the
// parent's type/axis — never a sibling — so collapsing them per node is identical
// as long as parents are visited before children (the Vue component renderer
// walks the structure parent-first). Keeping this beside the batch — calling the
// same private `assignRootGeometry`/`assignAnchorGeometry`/`assignContainerParentStyle`/
// `setFlowChild`/`configureSelfLayer` — means the only thing mirrored is the
// 4-step ORDER; the geometry math has a single source of truth. The batch path
// (and its goldens) is untouched.
export function assignBrowserNativeNodeLayout(
  node: GodotHtmlNode,
  layout: GodotSceneTreeNode,
  parent: BrowserNativeParentContext,
  options: GodotHtmlRenderOptions,
  viewport: { width: number; height: number },
): BrowserNativeParentContext {
  // Pass 1 — own outer box (root takes the viewport; others map anchors→insets).
  if (node.parentPath === null) {
    assignRootGeometry(node, viewport);
  } else {
    assignAnchorGeometry(node, layout);
  }
  // Pass 2a — this node AS a container parent: emit its flex/grid box and the
  // context its children consume.
  let childContext = ROOT_PARENT_CONTEXT;
  if (isCssContainerType(node.type)) {
    node.containerLayout = containerLayoutKind(node.type);
    node.attributes["data-godot-container-layout"] = node.containerLayout;
    const horizontal = containerIsHorizontal(node.type, layout);
    assignContainerParentStyle(node, layout, options, horizontal);
    childContext = { parentType: node.type, parentHorizontal: horizontal };
  }
  // Pass 2b — this node AS a container's child: replace the anchor box with flow.
  // Node2D children are exempt — Godot containers only lay out Controls
  // (Container::_sort_children); a Node2D keeps its own canvas transform.
  if (
    parent.parentType !== null &&
    isCssContainerType(parent.parentType) &&
    !isNode2DType(node.type)
  ) {
    setFlowChild(node, layout, parent.parentType, parent.parentHorizontal);
  }
  // Pass 3 — the self-layer, reading the node's FINAL outer box.
  configureSelfLayer(node);
  return childContext;
}

// Text gives a node its height: make the painted/text self-layer IN-FLOW so the
// real DOM text contributes content height to the outer element (which a parent
// container then flows). Non-text paint nodes keep an absolute self-layer that
// fills the anchor-/flow-sized outer box.
function configureSelfLayer(node: GodotHtmlNode): void {
  if (isTextNode(node.type)) {
    node.selfStyle.position = "relative";
    node.selfStyle.width = "100%";
    // The self-layer carries the real DOM text and its `vertical_alignment`
    // (emitted as `align-items` by assignTextStyles). When the OUTER box already
    // has a definite height — an explicit `height`, or both `top`+`bottom` insets
    // from stretch anchors — fill it so bottom/center alignment has room to work
    // (e.g. stacked lobby-nameplate Labels that bottom-align to avoid overlapping).
    // A flow child sized by `min-height` (from `custom_minimum_size`, e.g. the
    // TopBar HpLabel's 80px box) gets the SAME min-height mirrored onto the
    // self-layer — `height:100%` cannot resolve against a min-height-only parent,
    // but a px min-height gives the alignment its room while longer text can still
    // grow the box. When the height is indefinite — container-flowed, or
    // point-anchored with no size — leave it auto so the text DRIVES the box
    // height (the InfoPanel RichTextLabel fix).
    if (hasDefiniteHeight(node.style)) {
      node.selfStyle.height = "100%";
    } else {
      delete node.selfStyle.height;
      const minHeight = node.style["min-height"];
      if (minHeight !== undefined) {
        node.selfStyle["min-height"] = minHeight;
      }
    }
    delete node.selfStyle.left;
    delete node.selfStyle.top;
  } else {
    node.selfStyle.position = "absolute";
    node.selfStyle.left = "0";
    node.selfStyle.top = "0";
    node.selfStyle.width = "100%";
    node.selfStyle.height = "100%";
  }
}

// The outer box has a CSS-resolvable height when an explicit `height` is set, or
// when both `top` and `bottom` insets are pinned (absolute positioning then
// resolves the height). A lone `top` (point anchor / flow placeholder) does not.
function hasDefiniteHeight(style: Record<string, string>): boolean {
  if (style.height !== undefined) {
    return true;
  }
  return style.top !== undefined && style.bottom !== undefined;
}

// The horizontal counterpart: a definite width is an explicit px `width` (NOT the
// content-driven `min-content`/`max-content` keywords a point-anchored container
// emits), or both `left`+`right` insets pinned (stretch). An auto width (a grid/
// flow item, whose `width` was deleted) is NOT definite — it hugs/fills via its
// container. Used to decide whether an overlay grid may let a child's min-content
// grow it (content-driven) or must stay at its given size (definite).
function hasDefiniteWidth(style: Record<string, string>): boolean {
  if (
    style.width !== undefined &&
    style.width !== "min-content" &&
    style.width !== "max-content"
  ) {
    return true;
  }
  return style.left !== undefined && style.right !== undefined;
}

function assignRootGeometry(
  node: GodotHtmlNode,
  viewport: { width: number; height: number },
): void {
  node.positioning = "root";
  node.attributes["data-godot-positioning"] = "root";
  node.style.position = "relative";
  node.style.width = `${round(viewport.width)}px`;
  node.style.height = `${round(viewport.height)}px`;
  delete node.style.left;
  delete node.style.top;
}

// Node2D subclasses this renderer knows (the 2D branch of RENDERABLE_TYPES). A
// Node2D has NO anchors/offsets: in Godot its placement is its own canvas
// transform — `position`, then rotation/skew/scale around the node ORIGIN
// (Node2D::get_transform, scene/2d/node_2d.cpp) — not the Control anchor cascade.
// Containers also never lay out Node2D children (Container::_sort_children only
// touches Controls), so these keep their own transform even inside a flex/grid
// parent.
const NODE2D_TYPES = new Set([
  "AnimatedSprite2D",
  "BackBufferCopy",
  "Camera2D",
  "CanvasGroup",
  "CPUParticles2D",
  "FmodListener2D",
  "GPUParticles2D",
  "LightOccluder2D",
  "Line2D",
  "Marker2D",
  "MeshInstance2D",
  "Node2D",
  "Path2D",
  "PathFollow2D",
  "Sprite2D",
]);

export function isNode2DType(type: string): boolean {
  return NODE2D_TYPES.has(type);
}

// Browser-native placement for a Node2D: the anchor recompute (below) would delete
// the type-specific box the visual assigners computed RELATIVE TO THE NODE ORIGIN
// (a particle emitter's visibility-rect box, a centered sprite's -w/2 shift, a
// Line2D's points bbox) and reset the node to the parent origin at 0×0 (anchors/
// offsets read as 0) — which parked every background emitter/sprite at its parent's
// top-left corner. Instead, keep that own-origin box and translate it by the node's
// `position` (Godot: a Node2D's rect is position + transform · local — the computed
// rect path reads the same `position`/`position_x` fallbacks in layout/rects.ts).
// Rotation/scale/skew must pivot around the NODE ORIGIN, not the box corner or its
// center: the box corner sits at (bx, by) relative to the origin, so the origin in
// box-local coordinates is (-bx, -by). (For a centered Sprite2D this reproduces the
// `w/2 - offset` origin `assignSprite2DStyles` already emits.)
function assignNode2DGeometry(
  node: GodotHtmlNode,
  layout: GodotSceneTreeNode,
): void {
  node.positioning = "absolute";
  node.attributes["data-godot-positioning"] = "absolute";
  node.style.position = "absolute";
  const props = layout.properties;
  const position = asVector2(props.position);
  const x = asNumber(props.position_x) ?? position?.x ?? 0;
  const y = asNumber(props.position_y) ?? position?.y ?? 0;
  const boxX = cssSize(node.style.left) ?? 0;
  const boxY = cssSize(node.style.top) ?? 0;
  if (x !== 0 || y !== 0) {
    node.style.left = `${round(boxX + x)}px`;
    node.style.top = `${round(boxY + y)}px`;
  }
  if (node.style.transform && (boxX !== 0 || boxY !== 0)) {
    node.style["transform-origin"] = `${round(-boxX)}px ${round(-boxY)}px`;
  }
}

// Map a Control's anchors (fraction of parent) + offsets (px) to CSS absolute
// insets. Setting all four insets lets the browser resolve width/height exactly
// the way Godot derives the rect from anchors+offsets — for any anchor config
// (point anchors give a fixed size, FULL_RECT fills, …). The nearest positioned
// ancestor (the root, or another anchored Control — both `position:absolute`/
// `relative`) is the containing block, mirroring Godot's parent-relative anchors.
function assignAnchorGeometry(
  node: GodotHtmlNode,
  layout: GodotSceneTreeNode,
): void {
  // Node2Ds (Line2D, Sprite2D, particles, …) bypass the anchor recompute entirely —
  // see `assignNode2DGeometry`.
  if (isNode2DType(node.type)) {
    assignNode2DGeometry(node, layout);
    return;
  }
  const props = layout.properties;
  const anchorLeft = anchorFraction(props.anchor_left);
  const anchorTop = anchorFraction(props.anchor_top);
  const anchorRight = anchorFraction(props.anchor_right);
  const anchorBottom = anchorFraction(props.anchor_bottom);
  const offsetLeft = asNumber(props.offset_left) ?? 0;
  const offsetTop = asNumber(props.offset_top) ?? 0;
  const offsetRight = asNumber(props.offset_right) ?? 0;
  const offsetBottom = asNumber(props.offset_bottom) ?? 0;
  node.positioning = "absolute";
  node.attributes["data-godot-positioning"] = "absolute";
  node.style.position = "absolute";
  for (const side of ["left", "top", "right", "bottom", "width", "height"]) {
    delete node.style[side];
  }
  // Horizontal: a stretch anchor (left != right) pins both insets so the browser
  // resolves width; a point anchor (left == right) pins `left` plus an explicit
  // width from the offsets — or leaves width `auto` (content / min-size) when the
  // offsets give no size, so a container sizes to its children the way Godot's
  // `get_minimum_size()` does instead of collapsing to 0.
  //
  // A point-anchored box smaller than its `custom_minimum_size` grows to it the
  // way Godot's Control::_size_changed does (the inspect-relic FrameBg: a 40px
  // authored box with a 300px minimum): BEGIN(0) shifts the start edge back,
  // BOTH(2) centers, END(1, the default) extends forward. Offsets and minimum
  // are both static doc values, so the grown box is emitted directly. Zero-size
  // boxes keep the content-driven `auto` behavior above.
  const minimum = customMinimumSize(props);
  const growHorizontal = asNumber(props.grow_horizontal) ?? 1;
  node.style.left = cssInset(anchorLeft, offsetLeft);
  if (anchorLeft === anchorRight) {
    let width = offsetRight - offsetLeft;
    if (width > 0 && minimum.width > width) {
      const delta = minimum.width - width;
      if (growHorizontal === 0) {
        node.style.left = cssInset(anchorLeft, offsetLeft - delta);
      } else if (growHorizontal === 2) {
        node.style.left = cssInset(anchorLeft, offsetLeft - delta / 2);
      }
      width = minimum.width;
    }
    if (width > 0) {
      if (isCssContainerType(node.type)) {
        // A point-anchored container sizes to its content the way Godot's
        // `get_minimum_size()` does, growing past the authored box per
        // `grow_horizontal` (END right, BEGIN left, BOTH centered). Emit the
        // authored/min box as a `min-width` FLOOR and let CSS hug the content;
        // when content fits the box this resolves to the box width unchanged, so
        // only oversized content grows (e.g. a caption whose text exceeds a fixed
        // `MarginContainer`). Centering uses the independent `translate` longhand
        // so it composes with any scale/rotation `transform`.
        //
        // Use `min-content`, NOT `max-content`: Godot's `get_minimum_size()` is the
        // child MINIMUM, which for a wrapping `RichTextLabel`/`Label` (autowrap) is
        // the longest WORD — it wraps within the box rather than forcing the box to
        // its full unwrapped width. `max-content` measures the text UNWRAPPED (the
        // whole paragraph on one line), so a wrapping event/description label blew the
        // container far past its anchored width and never wrapped. `min-content` still
        // grows the box for NON-wrapping content (a single-line Label can't break, so
        // its min-content IS its full text), preserving the caption-exceeds-box case.
        node.style["min-width"] = `${round(width)}px`;
        node.style.width = "min-content";
        if (growHorizontal === 2) {
          node.style.left = cssInset(
            anchorLeft,
            (offsetLeft + offsetRight) / 2,
          );
          node.style.translate = "-50% 0";
        } else if (growHorizontal === 0) {
          delete node.style.left;
          node.style.right = cssInset(1 - anchorRight, -offsetRight);
        }
      } else {
        node.style.width = `${round(width)}px`;
      }
    }
  } else {
    node.style.right = cssInset(1 - anchorRight, -offsetRight);
  }
  node.style.top = cssInset(anchorTop, offsetTop);
  if (anchorTop === anchorBottom) {
    let height = offsetBottom - offsetTop;
    if (height > 0 && minimum.height > height) {
      const delta = minimum.height - height;
      const grow = asNumber(props.grow_vertical) ?? 1;
      if (grow === 0) {
        node.style.top = cssInset(anchorTop, offsetTop - delta);
      } else if (grow === 2) {
        node.style.top = cssInset(anchorTop, offsetTop - delta / 2);
      }
      height = minimum.height;
    }
    if (height > 0) {
      node.style.height = `${round(height)}px`;
    }
  } else {
    node.style.bottom = cssInset(1 - anchorBottom, -offsetBottom);
  }
}

function anchorFraction(value: GodotVariant | undefined): number {
  return asNumber(value) ?? 0;
}

// `<fraction>*100% (+|-) <px>px`, collapsed to the simplest form CSS accepts.
function cssInset(fraction: number, px: number): string {
  const percent = round(fraction * 100);
  const offset = round(px);
  if (offset === 0) {
    return `${percent}%`;
  }
  if (percent === 0) {
    return `${offset}px`;
  }
  return offset < 0
    ? `calc(${percent}% - ${round(Math.abs(px))}px)`
    : `calc(${percent}% + ${offset}px)`;
}

// Reflow a container's direct child as a native flow item: drop the absolute box,
// carry `custom_minimum_size` to CSS min-size, and translate Godot size flags to
// flex grow (main axis EXPAND) + align-self (cross-axis fill/shrink).
function setFlowChild(
  child: GodotHtmlNode,
  layout: GodotSceneTreeNode,
  parentType: string,
  parentHorizontal: boolean,
): void {
  child.positioning = "container-managed";
  child.attributes["data-godot-positioning"] = "container-managed";
  child.style.position = "relative";
  for (const side of ["left", "top", "right", "bottom", "width", "height"]) {
    delete child.style[side];
  }
  const props = layout.properties;
  const min = customMinimumSize(props);
  if (min.width > 0) {
    child.style["min-width"] = `${round(min.width)}px`;
  }
  if (min.height > 0) {
    child.style["min-height"] = `${round(min.height)}px`;
  }
  if (parentType === "GridContainer") {
    // Grid cells are tracked by the parent's `grid-template`; default stretch.
    return;
  }
  if (
    parentType === "CenterContainer" ||
    parentType === "AspectRatioContainer"
  ) {
    // The parent centers a single child; let it size to content.
    child.style.flex = "0 0 auto";
    return;
  }
  if (parentType === "MarginContainer" || parentType === "PanelContainer") {
    // EVERY child fills the same content rect and overlaps the others (Godot fits each
    // child to the rect; it never stacks them). One grid cell (overlayGrid on the parent)
    // + grid-area 1/1 overlays them — a column flex would split the height between them.
    child.style["grid-area"] = "1 / 1";
    // The grid cell is a DEFINITE rect (the parent fits each child to its content rect),
    // but grid-stretch alone is invisible to `hasDefiniteHeight` (it only reads inline
    // `height`/`top`+`bottom`). Make the fill explicit so a text child's self-layer gets
    // `height:100%` and `vertical_alignment` (align-items) has room to center — e.g. the
    // reward-row RichTextLabel inside its LabelContainer MarginContainer. A grid item's
    // `height:100%` resolves against the cell when definite and degrades to auto otherwise.
    child.style.height = "100%";
    return;
  }
  // Box / Flow containers.
  const horizontalFlags = asNumber(props.size_flags_horizontal) ?? SIZE_FILL;
  const verticalFlags = asNumber(props.size_flags_vertical) ?? SIZE_FILL;
  const mainFlags = parentHorizontal ? horizontalFlags : verticalFlags;
  const crossFlags = parentHorizontal ? verticalFlags : horizontalFlags;
  child.style.flex =
    (mainFlags & SIZE_EXPAND) === SIZE_EXPAND ? "1 1 auto" : "0 0 auto";
  const align = crossAlignSelf(crossFlags);
  if (align) {
    child.style["align-self"] = align;
  }
}

function crossAlignSelf(flags: number): string | undefined {
  if ((flags & SIZE_SHRINK_CENTER) === SIZE_SHRINK_CENTER) {
    return "center";
  }
  if ((flags & SIZE_SHRINK_END) === SIZE_SHRINK_END) {
    return "flex-end";
  }
  if ((flags & SIZE_FILL) === SIZE_FILL) {
    return "stretch";
  }
  return "flex-start";
}

function customMinimumSize(props: Record<string, GodotVariant>): {
  width: number;
  height: number;
} {
  const vector = asVector2(props.custom_minimum_size);
  return {
    width: vector?.x ?? asNumber(props.custom_minimum_size_x) ?? 0,
    height: vector?.y ?? asNumber(props.custom_minimum_size_y) ?? 0,
  };
}

// Emit the container's own CSS box from its properties/theme (rect-free). Mirrors
// the parent-side decisions of `assignContainerLayoutStyles` without the per-child
// pixel math.
function assignContainerParentStyle(
  parent: GodotHtmlNode,
  layout: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
  horizontal: boolean,
): void {
  const type = parent.type;
  const style = parent.style;
  if (isBoxContainerType(type)) {
    const separation = themeNumber(layout, "separation", options) ?? 0;
    style.display = "flex";
    style["flex-direction"] = horizontal ? "row" : "column";
    style["align-items"] = "stretch";
    const justify = alignmentJustify(layout);
    if (justify) {
      style["justify-content"] = justify;
    }
    if (separation !== 0) {
      style.gap = `${round(separation)}px`;
    }
    return;
  }
  if (isFlowContainerType(type)) {
    const hSeparation =
      themeNumber(layout, "h_separation", options) ??
      themeNumber(layout, "separation", options) ??
      0;
    const vSeparation =
      themeNumber(layout, "v_separation", options) ??
      themeNumber(layout, "separation", options) ??
      0;
    style.display = "flex";
    style["flex-direction"] = horizontal ? "row" : "column";
    style["flex-wrap"] = "wrap";
    style["align-content"] = "flex-start";
    style["align-items"] = "flex-start";
    const justify = alignmentJustify(layout);
    if (justify) {
      style["justify-content"] = justify;
    }
    if (hSeparation !== 0) {
      style["column-gap"] = `${round(hSeparation)}px`;
    }
    if (vSeparation !== 0) {
      style["row-gap"] = `${round(vSeparation)}px`;
    }
    return;
  }
  if (type === "GridContainer") {
    const columns = Math.max(1, asNumber(layout.properties.columns) ?? 1);
    const hSeparation =
      themeNumber(layout, "h_separation", options) ??
      themeNumber(layout, "separation", options) ??
      0;
    const vSeparation =
      themeNumber(layout, "v_separation", options) ??
      themeNumber(layout, "separation", options) ??
      0;
    style.display = "grid";
    style["grid-template-columns"] = `repeat(${columns}, auto)`;
    style["justify-items"] = "start";
    style["align-items"] = "start";
    if (hSeparation !== 0) {
      style["column-gap"] = `${round(hSeparation)}px`;
    }
    if (vSeparation !== 0) {
      style["row-gap"] = `${round(vSeparation)}px`;
    }
    return;
  }
  if (type === "CenterContainer" || type === "AspectRatioContainer") {
    style.display = "flex";
    style["align-items"] = "center";
    style["justify-content"] = "center";
    return;
  }
  if (type === "MarginContainer") {
    const left = Math.max(0, themeNumber(layout, "margin_left", options) ?? 0);
    const top = Math.max(0, themeNumber(layout, "margin_top", options) ?? 0);
    const right = Math.max(
      0,
      themeNumber(layout, "margin_right", options) ?? 0,
    );
    const bottom = Math.max(
      0,
      themeNumber(layout, "margin_bottom", options) ?? 0,
    );
    overlayGrid(style);
    growContentColumn(style);
    style.padding = `${round(top)}px ${round(right)}px ${round(bottom)}px ${round(left)}px`;
    return;
  }
  if (type === "PanelContainer") {
    const margins = panelStyleBoxMetrics(layout, options);
    overlayGrid(style);
    growContentColumn(style);
    style.padding = `${round(margins.top)}px ${round(margins.right)}px ${round(margins.bottom)}px ${round(margins.left)}px`;
    return;
  }
  if (type === "ScrollContainer") {
    const margins = panelStyleBoxMetrics(layout, options);
    style.display = "block";
    style.padding = `${round(margins.top)}px ${round(margins.right)}px ${round(margins.bottom)}px ${round(margins.left)}px`;
    style.overflow = "auto";
  }
}

function isTextNode(type: string): boolean {
  return (
    type === "Label" ||
    type === "RichTextLabel" ||
    type === "Button" ||
    type === "LineEdit" ||
    type === "TextEdit"
  );
}

function isCssContainerType(type: string): boolean {
  return (
    isBoxContainerType(type) ||
    isFlowContainerType(type) ||
    type === "AspectRatioContainer" ||
    type === "GridContainer" ||
    type === "CenterContainer" ||
    type === "MarginContainer" ||
    type === "PanelContainer" ||
    type === "ScrollContainer"
  );
}

function containerLayoutKind(type: string): GodotHtmlContainerLayout {
  if (isBoxContainerType(type)) {
    return "box";
  }
  if (isFlowContainerType(type)) {
    return "flow";
  }
  if (type === "AspectRatioContainer") {
    return "aspect-ratio";
  }
  if (type === "GridContainer") {
    return "grid";
  }
  if (type === "CenterContainer") {
    return "center";
  }
  if (type === "MarginContainer") {
    return "margin";
  }
  if (type === "PanelContainer") {
    return "panel";
  }
  return "scroll";
}

function isBoxContainerType(type: string): boolean {
  return (
    type === "BoxContainer" ||
    type === "HBoxContainer" ||
    type === "VBoxContainer"
  );
}

function isFlowContainerType(type: string): boolean {
  return (
    type === "FlowContainer" ||
    type === "HFlowContainer" ||
    type === "VFlowContainer"
  );
}

// Row vs column for Box/Flow containers: typed `H*`/`V*` win, else the `vertical`
// property (default horizontal).
function containerIsHorizontal(
  type: string,
  layout: GodotSceneTreeNode,
): boolean {
  if (type === "HBoxContainer" || type === "HFlowContainer") {
    return true;
  }
  if (type === "VBoxContainer" || type === "VFlowContainer") {
    return false;
  }
  // A bare BoxContainer/FlowContainer carries its axis as the boolean `vertical`
  // property (asBoolean, mirroring the computed path) — NOT a number; `asNumber(true)`
  // is undefined, which would wrongly flow a `vertical=true` list as a row.
  return !(asBoolean(layout.properties.vertical) ?? false);
}

// A Godot MarginContainer/PanelContainer fits EVERY child to the same content rect —
// children overlap as layers, they never stack. Model that as ONE grid cell that fills
// the (definite-size) container content box; grid's default `stretch` items + each child
// at `grid-area:1/1` (see setFlowChild) overlay and fill it. `minmax(0,1fr)` lets the
// track fill without a child's min-content forcing it larger.
function overlayGrid(style: Record<string, string>): void {
  style.display = "grid";
  style["grid-template-columns"] = "minmax(0, 1fr)";
  style["grid-template-rows"] = "minmax(0, 1fr)";
  delete style["flex-direction"];
}

// An overlay-grid container with NO definite width is content-driven (point-anchored
// `width:min-content`, or an auto-width grid/flow item). Its `minmax(0, 1fr)` column
// floor of 0 (chosen so a DEFINITE-size overlay's child can't force it wider) also
// blocks a NON-wrapping child's full-line min-content from growing it — collapsing a
// content-hugging container to its `min-width` floor (the card-pile/deck `BottomText`
// backdrop: a one-line RichTextLabel whose text lives in an out-of-flow self-layer, so
// only the grid track can carry its width up). Raise the floor to `min-content` so the
// child's minimum propagates and the container (and its ColorRect backdrop) hug the text
// the way Godot's `get_minimum_size()` does. Definite-width overlays keep `minmax(0,1fr)`.
function growContentColumn(style: Record<string, string>): void {
  if (!hasDefiniteWidth(style)) {
    style["grid-template-columns"] = "minmax(min-content, 1fr)";
  }
}

// Godot Box/Flow `alignment` (BEGIN=0 / CENTER=1 / END=2) packs children along the
// container's MAIN axis — exactly what CSS `justify-content` controls (for both row and
// column flex). BEGIN is the flex default, so emit nothing for it (mirrors the computed
// path's `alignmentOffset`). Without this, a centered HBox (e.g. the char-select button
// row) left-aligns and overflows instead of centering.
function alignmentJustify(layout: GodotSceneTreeNode): string | undefined {
  const alignment = asNumber(layout.properties.alignment) ?? 0;
  if (alignment === 1) {
    return "center";
  }
  if (alignment === 2) {
    return "flex-end";
  }
  return undefined;
}

function themeNumber(
  node: GodotSceneTreeNode,
  name: string,
  options: GodotHtmlRenderOptions,
): number | undefined {
  return (
    asNumber(node.properties[`theme_override_constants/${name}`]) ??
    asNumber(node.properties[`theme_constant_${name}`]) ??
    asNumber(options.resolveTheme?.(sourceNodeForLayout(node), name))
  );
}
