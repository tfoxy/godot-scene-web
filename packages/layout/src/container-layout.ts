import { asNumber, type GodotVariant } from "@godot-scene-web/core";
import { flowWrapLines } from "./flow-wrap";
import { makeLayoutNode } from "./layout-node";
import {
  alignmentOffset,
  combinedMinimum,
  hasExpandFlag,
  hasFillFlag,
  preferredSize,
  TEXT_CONTENT_TYPES,
  visibleChildren,
} from "./minimum-size";
import { normalizeRect, numeric } from "./rects";
import { contentRectForStyleBox, panelStyleBoxMetrics } from "./style-box";
import { themeNumber } from "./theme";
import type {
  GodotLayoutDiagnostic,
  GodotLayoutNode,
  GodotLayoutOptions,
  GodotRect,
  IndexedNode,
} from "./types";

export {
  boxContainerHorizontal,
  flowContainerVertical,
  isBoxContainerType,
  isFlowContainerType,
} from "./container-types";

export type LayoutChildDispatcher = (
  indexed: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
) => void;

function aspectAlignmentFactor(value: GodotVariant | undefined): number {
  const alignment = asNumber(value) ?? 1;
  if (alignment === 0) {
    return 0;
  }
  if (alignment === 2) {
    return 1;
  }
  return 0.5;
}

export function layoutBoxContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  horizontal: boolean,
  layoutChildren: LayoutChildDispatcher,
): void {
  const separation = themeNumber(parent, "separation", options) ?? 0;
  // Skip invisible children: a hidden control takes no space in a Godot container
  // (matching `visibleChildren` in minimum-size). Without this, an invisible
  // sibling would still consume main-axis extent and shift later children.
  const children = visibleChildren(parent, byPath);
  const sizes = children.map((child) => preferredSize(child, byPath, options));
  // Reflow text children to their laid-out column width. A wrapping `RichTextLabel`'s
  // height depends on its width; in the bottom-up minimum pass it reports width 0 (so
  // it never widens its container) and a single-line height. For a vertical box the
  // cross axis is the child's width, which the container fixes here — re-measure each
  // text child at that width so its height matches the wrapped paragraph (matching
  // Godot's `fit_content` reflow). Non-text children and horizontal boxes are untouched.
  if (!horizontal) {
    children.forEach((child, index) => {
      if (!TEXT_CONTENT_TYPES.has(child.node.type ?? "")) return;
      const cross = axisPlacement(
        rect.x,
        rect.width,
        sizes[index].width,
        child,
        true,
      );
      const reflowed = combinedMinimum(child, byPath, options, {
        x: 0,
        y: 0,
        width: cross.size,
        height: 0,
      });
      if (reflowed)
        sizes[index] = { width: sizes[index].width, height: reflowed.height };
    });
  }
  const totalMinimum =
    sizes.reduce(
      (sum, size) => sum + (horizontal ? size.width : size.height),
      0,
    ) +
    Math.max(0, children.length - 1) * separation;
  const available = horizontal ? rect.width : rect.height;
  const remaining = Math.max(0, available - totalMinimum);
  const expandCount = children.filter((child) =>
    hasExpandFlag(child, horizontal),
  ).length;
  let cursor =
    (horizontal ? rect.x : rect.y) +
    (expandCount > 0 ? 0 : alignmentOffset(parent, available, totalMinimum));

  children.forEach((child, index) => {
    const minimum = sizes[index] ?? { width: 0, height: 0 };
    const extra =
      expandCount > 0 && hasExpandFlag(child, horizontal)
        ? remaining / expandCount
        : 0;
    const fillExtra = hasFillFlag(child, horizontal) ? extra : 0;
    const crossAxis = horizontal
      ? axisPlacement(rect.y, rect.height, minimum.height, child, false)
      : axisPlacement(rect.x, rect.width, minimum.width, child, true);
    const childRect = horizontal
      ? {
          y: crossAxis.position,
          x: cursor,
          width: minimum.width + fillExtra,
          height: crossAxis.size,
        }
      : {
          x: crossAxis.position,
          y: cursor,
          width: crossAxis.size,
          height: minimum.height + fillExtra,
        };
    cursor +=
      (horizontal ? minimum.width + extra : minimum.height + extra) +
      separation;
    const layout = makeLayoutNode(
      child,
      childRect,
      layoutByPath.get(parent.path),
    );
    layoutByPath.set(child.path, layout);
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  });
}

export function layoutGridContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const columns = Math.max(
    1,
    Math.floor(numeric(parent.props, "columns") ?? 1),
  );
  const hSeparation =
    themeNumber(parent, "h_separation", options) ??
    themeNumber(parent, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(parent, "v_separation", options) ??
    themeNumber(parent, "separation", options) ??
    0;
  const children = visibleChildren(parent, byPath);
  const sizes = children.map((child) => preferredSize(child, byPath, options));
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      0,
      ...sizes
        .filter((_, index) => index % columns === column)
        .map((size) => size.width),
    ),
  );
  const rowCount = Math.ceil(children.length / columns);
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    Math.max(
      0,
      ...sizes
        .slice(row * columns, row * columns + columns)
        .map((size) => size.height),
    ),
  );
  const parentLayout = layoutByPath.get(parent.path);

  children.forEach((child, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x =
      rect.x +
      columnWidths.slice(0, column).reduce((sum, width) => sum + width, 0) +
      column * hSeparation;
    const y =
      rect.y +
      rowHeights.slice(0, row).reduce((sum, height) => sum + height, 0) +
      row * vSeparation;
    const cell = {
      x,
      y,
      width: columnWidths[column] ?? 0,
      height: rowHeights[row] ?? 0,
    };
    const horizontalPlacement = axisPlacement(
      cell.x,
      cell.width,
      sizes[index]?.width ?? 0,
      child,
      true,
    );
    const verticalPlacement = axisPlacement(
      cell.y,
      cell.height,
      sizes[index]?.height ?? 0,
      child,
      false,
    );
    const childRect = {
      x: horizontalPlacement.position,
      y: verticalPlacement.position,
      width: horizontalPlacement.size,
      height: verticalPlacement.size,
    };
    layoutByPath.set(
      child.path,
      makeLayoutNode(child, childRect, parentLayout),
    );
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  });
}

export function layoutFlowContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  vertical: boolean,
  layoutChildren: LayoutChildDispatcher,
): void {
  const hSeparation =
    themeNumber(parent, "h_separation", options) ??
    themeNumber(parent, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(parent, "v_separation", options) ??
    themeNumber(parent, "separation", options) ??
    0;
  const entries = visibleChildren(parent, byPath).map((child) => ({
    item: child,
    size: preferredSize(child, byPath, options),
  }));
  const lines = flowWrapLines(
    rect,
    entries,
    vertical,
    hSeparation,
    vSeparation,
  );
  for (const line of lines) {
    const crossSize = line.reduce(
      (max, entry) =>
        Math.max(max, vertical ? entry.size.width : entry.size.height),
      0,
    );
    for (const entry of line) {
      const childRect = vertical
        ? {
            x: entry.x,
            y: entry.y,
            width: crossSize,
            height: entry.size.height,
          }
        : {
            x: entry.x,
            y: entry.y,
            width: entry.size.width,
            height: crossSize,
          };
      layoutByPath.set(
        entry.item.path,
        makeLayoutNode(entry.item, childRect, layoutByPath.get(parent.path)),
      );
      layoutChildren(
        entry.item,
        childRect,
        byPath,
        layoutByPath,
        diagnostics,
        options,
      );
    }
  }
}

export function layoutAspectRatioContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const ratio = numeric(parent.props, "ratio") ?? 1;
  const safeRatio = ratio === 0 ? 1 : ratio;
  const stretchMode = numeric(parent.props, "stretch_mode") ?? 2;
  const alignX = aspectAlignmentFactor(parent.props.alignment_horizontal);
  const alignY = aspectAlignmentFactor(parent.props.alignment_vertical);
  const parentLayout = layoutByPath.get(parent.path);

  for (const childPath of parent.children) {
    const child = byPath.get(childPath);
    if (!child) {
      continue;
    }
    const minimum = combinedMinimum(child, byPath, options) ?? {
      width: 0,
      height: 0,
    };
    const base = { width: safeRatio, height: 1 };
    let scaleFactor: number;
    if (stretchMode === 0) {
      scaleFactor = rect.width / base.width;
    } else if (stretchMode === 1) {
      scaleFactor = rect.height / base.height;
    } else if (stretchMode === 3) {
      scaleFactor = Math.max(
        rect.width / base.width,
        rect.height / base.height,
      );
    } else {
      scaleFactor = Math.min(
        rect.width / base.width,
        rect.height / base.height,
      );
    }
    const width = Math.max(minimum.width, base.width * scaleFactor);
    const height = Math.max(minimum.height, base.height * scaleFactor);
    const childRect = {
      x: rect.x + (rect.width - width) * alignX,
      y: rect.y + (rect.height - height) * alignY,
      width,
      height,
    };
    layoutByPath.set(
      child.path,
      makeLayoutNode(child, childRect, parentLayout),
    );
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  }
}

export function layoutPanelContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const content = contentRectForStyleBox(
    rect,
    panelStyleBoxMetrics(parent, options),
  );
  layoutFitChildren(
    parent,
    content,
    byPath,
    layoutByPath,
    diagnostics,
    options,
    layoutChildren,
  );
}

export function layoutScrollContainerChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const content = contentRectForStyleBox(
    rect,
    panelStyleBoxMetrics(parent, options),
  );
  const scrollX = numeric(parent.props, "scroll_horizontal") ?? 0;
  const scrollY = numeric(parent.props, "scroll_vertical") ?? 0;
  const parentLayout = layoutByPath.get(parent.path);
  for (const childPath of parent.children) {
    const child = byPath.get(childPath);
    if (!child) {
      continue;
    }
    const size = preferredSize(child, byPath, options);
    const childRect = {
      x: content.x - scrollX,
      y: content.y - scrollY,
      width: hasExpandFlag(child, true)
        ? Math.max(content.width, size.width)
        : size.width,
      height: hasExpandFlag(child, false)
        ? Math.max(content.height, size.height)
        : size.height,
    };
    layoutByPath.set(
      child.path,
      makeLayoutNode(child, childRect, parentLayout),
    );
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  }
}

export function layoutMarginChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const left = themeNumber(parent, "margin_left", options) ?? 0;
  const top = themeNumber(parent, "margin_top", options) ?? 0;
  const right = themeNumber(parent, "margin_right", options) ?? 0;
  const bottom = themeNumber(parent, "margin_bottom", options) ?? 0;
  const content = normalizeRect({
    x: rect.x + left,
    y: rect.y + top,
    width: rect.width - left - right,
    height: rect.height - top - bottom,
  });
  // Godot's MarginContainer calls fit_child_in_rect on the content rect: managed
  // children fill it per-axis honoring size flags (FILL fills, SHRINK_* uses the
  // minimum at begin/center/end), rather than keeping their authored anchor/offset
  // size. layoutFitChildren is that exact logic (also used by PanelContainer).
  layoutFitChildren(
    parent,
    content,
    byPath,
    layoutByPath,
    diagnostics,
    options,
    layoutChildren,
  );
}

function layoutFitChildren(
  parent: IndexedNode,
  content: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  const parentLayout = layoutByPath.get(parent.path);
  for (const childPath of parent.children) {
    const child = byPath.get(childPath);
    if (!child) {
      continue;
    }
    const minimum = preferredSize(child, byPath, options);
    const horizontal = axisPlacement(
      content.x,
      content.width,
      minimum.width,
      child,
      true,
    );
    const vertical = axisPlacement(
      content.y,
      content.height,
      minimum.height,
      child,
      false,
    );
    const childRect = {
      x: horizontal.position,
      y: vertical.position,
      width: horizontal.size,
      height: vertical.size,
    };
    layoutByPath.set(
      child.path,
      makeLayoutNode(child, childRect, parentLayout),
    );
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  }
}

export function layoutCenterChildren(
  parent: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
  layoutChildren: LayoutChildDispatcher,
): void {
  for (const childPath of parent.children) {
    const child = byPath.get(childPath);
    if (!child) {
      continue;
    }
    const size = preferredSize(child, byPath, options);
    const childRect = {
      x: rect.x + (rect.width - size.width) / 2,
      y: rect.y + (rect.height - size.height) / 2,
      width: size.width,
      height: size.height,
    };
    layoutByPath.set(
      childPath,
      makeLayoutNode(child, childRect, layoutByPath.get(parent.path)),
    );
    layoutChildren(
      child,
      childRect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
    );
  }
}

function axisPlacement(
  start: number,
  available: number,
  minimum: number,
  indexed: IndexedNode,
  horizontalAxis: boolean,
): { position: number; size: number } {
  const flags =
    numeric(
      indexed.props,
      horizontalAxis ? "size_flags_horizontal" : "size_flags_vertical",
    ) ?? 0;
  const shrinkCenter = (flags & 4) === 4;
  const shrinkEnd = (flags & 8) === 8;
  const size =
    shrinkCenter || shrinkEnd ? minimum : Math.max(available, minimum);
  const position = shrinkEnd
    ? start + Math.max(0, available - size)
    : shrinkCenter
      ? start + Math.max(0, (available - size) / 2)
      : start;
  return { position, size };
}
