import { escapeAttribute } from "./css-values";
import type { GodotHtmlNode, GodotHtmlTintFilter } from "./types";

// Class names shared by every renderer (DOM, Vue, HTML string). The self-layer
// carries each node's paint/text styling; the stage is the scene root wrapper.
export const SELF_LAYER_CLASS = "godot-scene-self-layer";
export const STAGE_CLASS = "godot-scene-stage";
// Optional fill-parent wrapper that centers the stage and paints letterbox bars
// when Window content-scale is active. Absent in the default fixed-size render.
export const FRAME_CLASS = "godot-scene-frame";

// A hidden `<svg>` carrying the `<filter>` defs referenced by `filter: url(#id)`
// color-matrix tints (external textures). Emitted once per render by every
// renderer (DOM, HTML string, Vue), so the `url(#id)` references resolve.
export function tintFilterDefsMarkup(
  tintFilters: GodotHtmlTintFilter[] | undefined,
): string {
  if (!tintFilters || tintFilters.length === 0) {
    return "";
  }
  const filters = tintFilters
    .map(
      // `markup` is renderer-built SVG (controlled `feColorMatrix`/`feFlood`
      // values, not user input), emitted verbatim inside the `<filter>`.
      (filter) =>
        `<filter id="${escapeAttribute(filter.id)}" color-interpolation-filters="sRGB">${filter.markup}</filter>`,
    )
    .join("");
  return `<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs>${filters}</defs></svg>`;
}

// A node's OWN paint layer. Must be a DIRECT-child lookup: `show_behind_parent`
// children render BEFORE the self-layer, so a descendant `querySelector` would
// return the behind-child's layer instead (binding e.g. a WebGL shader to the
// wrong element and a solid-white fallback texture).
export function ownSelfLayer(node: HTMLElement): HTMLElement | null {
  return node.querySelector<HTMLElement>(`:scope > .${SELF_LAYER_CLASS}`);
}

// Nodes flagged with `show_behind_parent` paint before the parent's own
// self-layer; everything else paints after it.
export function isShowBehindParent(node: GodotHtmlNode): boolean {
  return node.attributes["data-godot-show-behind-parent"] === "true";
}

// Resolve a node's children and split them into the two paint groups every
// renderer needs. The self-layer is inserted between `behind` and `normal` by
// each renderer (it cannot live here because the emitted form differs per
// target: DOM element, vnode, or HTML string).
export function partitionChildren(
  node: GodotHtmlNode,
  nodeByPath: Map<string, GodotHtmlNode>,
): { behind: GodotHtmlNode[]; normal: GodotHtmlNode[] } {
  const children = node.children
    .map((path) => nodeByPath.get(path))
    .filter((child): child is GodotHtmlNode => child !== undefined);
  return {
    behind: children.filter(isShowBehindParent),
    normal: children.filter((child) => !isShowBehindParent(child)),
  };
}
