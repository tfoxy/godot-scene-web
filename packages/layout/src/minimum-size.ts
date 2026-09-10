import { asBoolean, asResourceRef, asVector2 } from "@godot-scene-web/core";
import {
  boxContainerHorizontal,
  flowContainerVertical,
} from "./container-types";
import { flowCrossExtent, flowWrapLines } from "./flow-wrap";
import { numeric } from "./rects";
import { panelStyleBoxMetrics } from "./style-box";
import { themeNumber } from "./theme";
import type { GodotLayoutOptions, GodotRect, IndexedNode } from "./types";

type Size = { width: number; height: number };

export function preferredSize(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  return (
    combinedMinimum(indexed, byPath, options) ??
    explicitSizeFromProps(indexed) ??
    sizeFromOffsets(indexed) ?? { width: 0, height: 0 }
  );
}

export function explicitSizeFromProps(indexed: IndexedNode): Size | undefined {
  const size = asVector2(indexed.props.size);
  if (size) {
    return { width: size.x, height: size.y };
  }
  const width = numeric(indexed.props, "size_width");
  const height = numeric(indexed.props, "size_height");
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

export function sizeFromOffsets(indexed: IndexedNode): Size | undefined {
  const left = numeric(indexed.props, "offset_left") ?? 0;
  const top = numeric(indexed.props, "offset_top") ?? 0;
  const right = numeric(indexed.props, "offset_right");
  const bottom = numeric(indexed.props, "offset_bottom");
  if (right === undefined || bottom === undefined) {
    return undefined;
  }
  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function customMinimum(indexed: IndexedNode): Size | undefined {
  const vector = asVector2(indexed.props.custom_minimum_size);
  if (vector) {
    return { width: vector.x, height: vector.y };
  }
  const width =
    numeric(indexed.props, "custom_minimum_width") ??
    numeric(indexed.props, "minimum_width");
  const height =
    numeric(indexed.props, "custom_minimum_height") ??
    numeric(indexed.props, "minimum_height");
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

function declaredCombinedMinimum(indexed: IndexedNode): Size | undefined {
  const vector = asVector2(indexed.props.combined_minimum_size);
  if (vector) {
    return { width: vector.x, height: vector.y };
  }
  const width = numeric(indexed.props, "combined_minimum_width");
  const height = numeric(indexed.props, "combined_minimum_height");
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

export function combinedMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
  currentRect?: GodotRect,
): Size | undefined {
  const declared = declaredCombinedMinimum(indexed);
  const custom = customMinimum(indexed);
  const internal = internalMinimum(indexed, options, currentRect);
  const container = containerMinimumSize(indexed, byPath, options);
  return maxSize(declared, maxSize(custom, maxSize(internal, container)));
}

function maxSize(a: Size | undefined, b: Size | undefined): Size | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return {
    width: Math.max(a.width, b.width),
    height: Math.max(a.height, b.height),
  };
}

/**
 * Container analogue of Godot `Container::get_minimum_size()`, memoized on the
 * IndexedNode. Non-container controls return `undefined` (a plain Control/Node
 * does not size to its children). Recurses through `byPath` children, which
 * already include flattened instanced PackedScene content.
 */
export function containerMinimumSize(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size | undefined {
  if (indexed.minimumSize !== undefined) {
    return indexed.minimumSize ?? undefined;
  }
  const size = computeContainerMinimum(indexed, byPath, options);
  indexed.minimumSize = size ?? null;
  return size;
}

function computeContainerMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size | undefined {
  const type = indexed.node.type ?? "Node";
  switch (type) {
    case "BoxContainer":
    case "HBoxContainer":
    case "VBoxContainer":
      return boxMinimum(indexed, byPath, options);
    case "GridContainer":
      return gridMinimum(indexed, byPath, options);
    case "FlowContainer":
    case "HFlowContainer":
    case "VFlowContainer":
      return flowMinimum(indexed, byPath, options);
    case "MarginContainer":
      return marginMinimum(indexed, byPath, options);
    case "CenterContainer":
      return maxChildMinimum(indexed, byPath, options);
    case "AspectRatioContainer":
      return maxChildMinimum(indexed, byPath, options);
    case "PanelContainer":
      return panelMinimum(indexed, byPath, options);
    case "ScrollContainer":
      return scrollMinimum(indexed, byPath, options);
    default:
      return undefined;
  }
}

export function visibleChildren(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
): IndexedNode[] {
  return indexed.children
    .map((path) => byPath.get(path))
    .filter(
      (child): child is IndexedNode =>
        Boolean(child) && (asBoolean(child!.props.visible) ?? true),
    );
}

function childSizes(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size[] {
  return visibleChildren(indexed, byPath).map(
    (child) =>
      combinedMinimum(child, byPath, options) ?? { width: 0, height: 0 },
  );
}

function boxMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const horizontal = boxContainerHorizontal(indexed);
  const separation = themeNumber(indexed, "separation", options) ?? 0;
  const sizes = childSizes(indexed, byPath, options);
  let main = 0;
  let cross = 0;
  sizes.forEach((size, index) => {
    const childMain = horizontal ? size.width : size.height;
    const childCross = horizontal ? size.height : size.width;
    main += childMain + (index === 0 ? 0 : separation);
    cross = Math.max(cross, childCross);
  });
  return horizontal
    ? { width: main, height: cross }
    : { width: cross, height: main };
}

function gridMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const columns = Math.max(
    1,
    Math.floor(numeric(indexed.props, "columns") ?? 1),
  );
  const hSeparation =
    themeNumber(indexed, "h_separation", options) ??
    themeNumber(indexed, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(indexed, "v_separation", options) ??
    themeNumber(indexed, "separation", options) ??
    0;
  const sizes = childSizes(indexed, byPath, options);
  const columnWidths = new Map<number, number>();
  const rowHeights = new Map<number, number>();
  let maxColumn = 0;
  let maxRow = 0;
  sizes.forEach((size, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths.set(
      column,
      Math.max(columnWidths.get(column) ?? 0, size.width),
    );
    rowHeights.set(row, Math.max(rowHeights.get(row) ?? 0, size.height));
    maxColumn = Math.max(maxColumn, column);
    maxRow = Math.max(maxRow, row);
  });
  const width =
    [...columnWidths.values()].reduce((sum, value) => sum + value, 0) +
    hSeparation * maxColumn;
  const height =
    [...rowHeights.values()].reduce((sum, value) => sum + value, 0) +
    vSeparation * maxRow;
  return { width, height };
}

function flowMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const vertical = flowContainerVertical(indexed);
  const hSeparation =
    themeNumber(indexed, "h_separation", options) ??
    themeNumber(indexed, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(indexed, "v_separation", options) ??
    themeNumber(indexed, "separation", options) ??
    0;
  const sizes = childSizes(indexed, byPath, options);
  const maxWidth = sizes.reduce((max, size) => Math.max(max, size.width), 0);
  const maxHeight = sizes.reduce((max, size) => Math.max(max, size.height), 0);

  // Godot's flow minimum cross extent comes from the previous resort at the
  // container's actual size. The iterative fixpoint in `resolveGodotSceneTree`
  // feeds the resolved main-axis extent back via `flowMainExtent`; before that
  // is known we fall back to the authored offset/explicit size, then to the
  // single-line floor (the browser's `flex-wrap` stays authoritative on-screen).
  const offsetSize = explicitSizeFromProps(indexed) ?? sizeFromOffsets(indexed);
  const offsetMain = vertical ? offsetSize?.height : offsetSize?.width;
  const mainExtent =
    indexed.flowMainExtent ??
    (offsetMain !== undefined && offsetMain > 0 ? offsetMain : undefined);
  if (mainExtent !== undefined && mainExtent > 0) {
    const rect: GodotRect = vertical
      ? { x: 0, y: 0, width: maxWidth, height: mainExtent }
      : { x: 0, y: 0, width: mainExtent, height: maxHeight };
    const lines = flowWrapLines(
      rect,
      sizes.map((size) => ({ item: size, size })),
      vertical,
      hSeparation,
      vSeparation,
    );
    const crossExtent = flowCrossExtent(
      lines,
      vertical,
      hSeparation,
      vSeparation,
    );
    return vertical
      ? { width: crossExtent, height: maxHeight }
      : { width: maxWidth, height: crossExtent };
  }
  return { width: maxWidth, height: maxHeight };
}

function marginMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const left = themeNumber(indexed, "margin_left", options) ?? 0;
  const top = themeNumber(indexed, "margin_top", options) ?? 0;
  const right = themeNumber(indexed, "margin_right", options) ?? 0;
  const bottom = themeNumber(indexed, "margin_bottom", options) ?? 0;
  const max = maxChildMinimum(indexed, byPath, options);
  return { width: max.width + left + right, height: max.height + top + bottom };
}

function panelMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const metrics = panelStyleBoxMetrics(indexed, options);
  const max = maxChildMinimum(indexed, byPath, options);
  return {
    width: max.width + metrics.left + metrics.right,
    height: max.height + metrics.top + metrics.bottom,
  };
}

function scrollMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  const metrics = panelStyleBoxMetrics(indexed, options);
  const largest = maxChildMinimum(indexed, byPath, options);
  const horizontalDisabled =
    (numeric(indexed.props, "horizontal_scroll_mode") ?? 1) === 0;
  const verticalDisabled =
    (numeric(indexed.props, "vertical_scroll_mode") ?? 1) === 0;
  return {
    width:
      metrics.left + metrics.right + (horizontalDisabled ? largest.width : 0),
    height:
      metrics.top + metrics.bottom + (verticalDisabled ? largest.height : 0),
  };
}

function maxChildMinimum(
  indexed: IndexedNode,
  byPath: Map<string, IndexedNode>,
  options: GodotLayoutOptions,
): Size {
  return childSizes(indexed, byPath, options).reduce(
    (max, size) => ({
      width: Math.max(max.width, size.width),
      height: Math.max(max.height, size.height),
    }),
    { width: 0, height: 0 },
  );
}

export const TEXT_CONTENT_TYPES = new Set(["Label", "RichTextLabel"]);

function internalMinimum(
  indexed: IndexedNode,
  options: GodotLayoutOptions,
  currentRect?: GodotRect,
): Size | undefined {
  // Text nodes derive a content-driven minimum from the host's measurement of
  // their text (the analogue of a `TextureRect`'s intrinsic texture size below).
  // `combinedMinimum` already takes the max against `custom_minimum_size`, so this
  // matches Godot's `Label::get_minimum_size()` = max(custom, paragraph box).
  if (TEXT_CONTENT_TYPES.has(indexed.node.type ?? "")) {
    const size = options.resolveTextContentSize?.(
      indexed.node,
      indexed.path,
      indexed.props,
      // During layout the node already has a column width (`currentRect.width`);
      // hand it to the host so a reflowing label wraps to it. In the bottom-up
      // minimum pass there is no rect yet, so this is `undefined`.
      currentRect?.width,
    );
    if (!size || size.width < 0 || size.height < 0) {
      return undefined;
    }
    return size;
  }
  if (indexed.node.type !== "TextureRect") {
    return undefined;
  }
  const textureRef = asResourceRef(indexed.props.texture);
  if (!textureRef) {
    return undefined;
  }
  const textureSize = resourceSize(
    options.resolveResource?.(textureRef, indexed.node),
  );
  if (!textureSize || textureSize.width <= 0 || textureSize.height <= 0) {
    return undefined;
  }
  const expandMode = numeric(indexed.props, "expand_mode") ?? 0;
  if (expandMode === 0) {
    return textureSize;
  }
  if (expandMode === 2) {
    return { width: currentRect?.height ?? 0, height: 0 };
  }
  if (expandMode === 3) {
    return {
      width:
        ((currentRect?.height ?? 0) * textureSize.width) / textureSize.height,
      height: 0,
    };
  }
  if (expandMode === 4) {
    return { width: 0, height: currentRect?.width ?? 0 };
  }
  if (expandMode === 5) {
    return {
      width: 0,
      height:
        ((currentRect?.width ?? 0) * textureSize.height) / textureSize.width,
    };
  }
  return undefined;
}

function resourceSize(resource: unknown): Size | undefined {
  if (!resource || typeof resource !== "object") {
    return undefined;
  }
  const record = resource as Record<string, unknown>;
  const size = record.size;
  if (size && typeof size === "object" && !Array.isArray(size)) {
    const sizeRecord = size as Record<string, unknown>;
    const width =
      typeof sizeRecord.width === "number" ? sizeRecord.width : undefined;
    const height =
      typeof sizeRecord.height === "number" ? sizeRecord.height : undefined;
    return width !== undefined && height !== undefined
      ? { width, height }
      : undefined;
  }
  const width = typeof record.width === "number" ? record.width : undefined;
  const height = typeof record.height === "number" ? record.height : undefined;
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

export function hasExpandFlag(
  indexed: IndexedNode,
  horizontal: boolean,
): boolean {
  const flags =
    numeric(
      indexed.props,
      horizontal ? "size_flags_horizontal" : "size_flags_vertical",
    ) ?? 0;
  return (flags & 2) === 2;
}

export function hasFillFlag(
  indexed: IndexedNode,
  horizontal: boolean,
): boolean {
  const flags =
    numeric(
      indexed.props,
      horizontal ? "size_flags_horizontal" : "size_flags_vertical",
    ) ?? 0;
  return (flags & 1) === 1;
}

export function alignmentOffset(
  indexed: IndexedNode,
  available: number,
  content: number,
): number {
  const alignment = numeric(indexed.props, "alignment") ?? 0;
  if (alignment === 1) {
    return Math.max(0, (available - content) / 2);
  }
  if (alignment === 2) {
    return Math.max(0, available - content);
  }
  return 0;
}
