import { asBoolean, asNumber } from "@godot-scene-web/core";
import type { GodotSceneTreeNode } from "@godot-scene-web/layout";
import { round } from "./css-values";
import { sourceNodeForLayout } from "./resources";
import { panelStyleBoxMetrics } from "./style-box";
import type {
  GodotHtmlContainerLayout,
  GodotHtmlNode,
  GodotHtmlRenderOptions,
} from "./types";

export function assignContainerLayoutStyles(
  nodes: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
): void {
  const htmlByPath = new Map(nodes.map((node) => [node.path, node]));
  for (const parent of nodes) {
    const parentLayout = layoutByPath.get(parent.path);
    if (!parentLayout || !isCssContainerType(parent.type)) {
      continue;
    }
    parent.containerLayout = containerLayoutKind(parent.type);
    parent.attributes["data-godot-container-layout"] = parent.containerLayout;
    const children = parent.children
      .map((path) => htmlByPath.get(path))
      .filter((child): child is GodotHtmlNode => Boolean(child))
      .filter(
        (child) => layoutByPath.get(child.path)?.parentPath === parent.path,
      );
    if (children.length === 0) {
      continue;
    }
    if (isBoxContainerType(parent.type)) {
      assignBoxContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
        boxContainerHorizontal(parentLayout),
      );
    } else if (parent.type === "AspectRatioContainer") {
      assignAspectRatioContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
      );
    } else if (isFlowContainerType(parent.type)) {
      assignFlowContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
        flowContainerVertical(parentLayout),
      );
    } else if (parent.type === "GridContainer") {
      assignGridContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
      );
    } else if (parent.type === "CenterContainer") {
      assignCenterContainerStyles(parent, parentLayout, children, layoutByPath);
    } else if (parent.type === "MarginContainer") {
      assignMarginContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
      );
    } else if (parent.type === "PanelContainer") {
      assignPanelContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
      );
    } else if (parent.type === "ScrollContainer") {
      assignScrollContainerStyles(
        parent,
        parentLayout,
        children,
        layoutByPath,
        options,
      );
    }
  }
}

function isCssContainerType(type: string): boolean {
  return (
    type === "AspectRatioContainer" ||
    type === "BoxContainer" ||
    type === "HBoxContainer" ||
    type === "VBoxContainer" ||
    type === "HFlowContainer" ||
    type === "FlowContainer" ||
    type === "VFlowContainer" ||
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

function boxContainerHorizontal(node: GodotSceneTreeNode): boolean {
  if (node.type === "HBoxContainer") {
    return true;
  }
  if (node.type === "VBoxContainer") {
    return false;
  }
  return !(asBoolean(node.properties.vertical) ?? false);
}

function isFlowContainerType(type: string): boolean {
  return (
    type === "FlowContainer" ||
    type === "HFlowContainer" ||
    type === "VFlowContainer"
  );
}

function flowContainerVertical(node: GodotSceneTreeNode): boolean {
  if (node.type === "VFlowContainer") {
    return true;
  }
  if (node.type === "HFlowContainer") {
    return false;
  }
  return asBoolean(node.properties.vertical) ?? false;
}

function assignBoxContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
  horizontal: boolean,
): void {
  const separation = themeNumber(parentLayout, "separation", options) ?? 0;
  parent.style.display = "flex";
  parent.style["flex-direction"] = horizontal ? "row" : "column";
  parent.style["align-items"] = "flex-start";
  if (separation !== 0) {
    parent.style.gap = `${round(separation)}px`;
  }
  let previousEnd = horizontal ? parentLayout.rect.x : parentLayout.rect.y;
  children.forEach((child, index) => {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      return;
    }
    setManagedChildPosition(child);
    if (horizontal) {
      child.style.flex = `0 0 ${round(layout.rect.width)}px`;
      child.style.width = `${round(layout.rect.width)}px`;
      child.style.height = `${round(layout.rect.height)}px`;
      setMargin(
        child.style,
        "left",
        layout.rect.x - previousEnd - (index > 0 ? separation : 0),
      );
      setMargin(child.style, "top", layout.rect.y - parentLayout.rect.y);
      previousEnd = layout.rect.x + layout.rect.width;
    } else {
      child.style.flex = `0 0 ${round(layout.rect.height)}px`;
      child.style.width = `${round(layout.rect.width)}px`;
      child.style.height = `${round(layout.rect.height)}px`;
      setMargin(
        child.style,
        "top",
        layout.rect.y - previousEnd - (index > 0 ? separation : 0),
      );
      setMargin(child.style, "left", layout.rect.x - parentLayout.rect.x);
      previousEnd = layout.rect.y + layout.rect.height;
    }
  });
}

function assignFlowContainerStyles(
  parent: GodotHtmlNode,
  _parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
  vertical: boolean,
): void {
  const hSeparation =
    themeNumber(_parentLayout, "h_separation", options) ??
    themeNumber(_parentLayout, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(_parentLayout, "v_separation", options) ??
    themeNumber(_parentLayout, "separation", options) ??
    0;
  parent.style.display = "flex";
  parent.style["flex-direction"] = vertical ? "column" : "row";
  parent.style["flex-wrap"] = "wrap";
  parent.style["align-content"] = "flex-start";
  parent.style["align-items"] = "flex-start";
  if (hSeparation !== 0) {
    parent.style["column-gap"] = `${round(hSeparation)}px`;
  }
  if (vSeparation !== 0) {
    parent.style["row-gap"] = `${round(vSeparation)}px`;
  }
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.flex = `0 0 ${round(vertical ? layout.rect.height : layout.rect.width)}px`;
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
  }
}

function assignAspectRatioContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
): void {
  parent.style.display = "grid";
  parent.style["justify-items"] = "start";
  parent.style["align-items"] = "start";
  parent.attributes["data-godot-aspect-ratio"] = String(
    asNumber(parentLayout.properties.ratio) ?? 1,
  );
  parent.attributes["data-godot-stretch-mode"] = String(
    asNumber(parentLayout.properties.stretch_mode) ?? 2,
  );
  parent.attributes["data-godot-alignment-horizontal"] = String(
    asNumber(parentLayout.properties.alignment_horizontal) ?? 1,
  );
  parent.attributes["data-godot-alignment-vertical"] = String(
    asNumber(parentLayout.properties.alignment_vertical) ?? 1,
  );
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    child.style["grid-area"] = "1 / 1";
    setMargin(child.style, "left", layout.rect.x - parentLayout.rect.x);
    setMargin(child.style, "top", layout.rect.y - parentLayout.rect.y);
  }
}

function assignGridContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
): void {
  const hSeparation =
    themeNumber(parentLayout, "h_separation", options) ??
    themeNumber(parentLayout, "separation", options) ??
    0;
  const vSeparation =
    themeNumber(parentLayout, "v_separation", options) ??
    themeNumber(parentLayout, "separation", options) ??
    0;
  const layouts = children
    .map((child) => layoutByPath.get(child.path))
    .filter((node): node is GodotSceneTreeNode => Boolean(node));
  const columns = layoutTracks(layouts, "x", "width");
  const rows = layoutTracks(layouts, "y", "height");
  parent.style.display = "grid";
  parent.style["grid-template-columns"] = columns
    .map((track) => `${round(track.size)}px`)
    .join(" ");
  parent.style["grid-template-rows"] = rows
    .map((track) => `${round(track.size)}px`)
    .join(" ");
  parent.style["justify-items"] = "start";
  parent.style["align-items"] = "start";
  if (hSeparation !== 0) {
    parent.style["column-gap"] = `${round(hSeparation)}px`;
  }
  if (vSeparation !== 0) {
    parent.style["row-gap"] = `${round(vSeparation)}px`;
  }
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    const columnIndex = columns.findIndex((track) =>
      nearlyEqual(track.start, layout.rect.x),
    );
    const rowIndex = rows.findIndex((track) =>
      nearlyEqual(track.start, layout.rect.y),
    );
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    child.style["grid-column"] = String(Math.max(1, columnIndex + 1));
    child.style["grid-row"] = String(Math.max(1, rowIndex + 1));
  }
}

function assignCenterContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
): void {
  parent.style.display = "grid";
  parent.style["place-items"] = "center";
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    child.style["grid-area"] = "1 / 1";
    setMargin(
      child.style,
      "left",
      layout.rect.x -
        parentLayout.rect.x -
        (parentLayout.rect.width - layout.rect.width) / 2,
    );
    setMargin(
      child.style,
      "top",
      layout.rect.y -
        parentLayout.rect.y -
        (parentLayout.rect.height - layout.rect.height) / 2,
    );
  }
}

function assignMarginContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
): void {
  const left = themeNumber(parentLayout, "margin_left", options) ?? 0;
  const top = themeNumber(parentLayout, "margin_top", options) ?? 0;
  const right = themeNumber(parentLayout, "margin_right", options) ?? 0;
  const bottom = themeNumber(parentLayout, "margin_bottom", options) ?? 0;
  // CSS padding cannot be negative, but Godot MarginContainer margins can be (and
  // commonly are — e.g. top-bar icon positioners use negative margins to make a child
  // overflow its box). A negative padding is silently dropped by the browser, which
  // would leave the child at the container's top-left instead of shifted outward. Clamp
  // the padding inset to >= 0 and let the (negative-capable) child margin carry the full
  // remaining offset, so the child lands at its computed rect for any margin sign.
  const padLeft = Math.max(0, left);
  const padTop = Math.max(0, top);
  const padRight = Math.max(0, right);
  const padBottom = Math.max(0, bottom);
  parent.style.display = "grid";
  parent.style.padding = `${round(padTop)}px ${round(padRight)}px ${round(padBottom)}px ${round(padLeft)}px`;
  parent.style["justify-items"] = "start";
  parent.style["align-items"] = "start";
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    child.style["grid-area"] = "1 / 1";
    setMargin(
      child.style,
      "left",
      layout.rect.x - parentLayout.rect.x - padLeft,
    );
    setMargin(child.style, "top", layout.rect.y - parentLayout.rect.y - padTop);
  }
}

function assignPanelContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
): void {
  const margins = panelStyleBoxMetrics(parentLayout, options);
  // The stylebox border is painted on the absolutely-positioned self-layer, so
  // it is out of flow here: the grid's content inset is the full content margin.
  parent.style.display = "grid";
  parent.style.padding = `${round(margins.top)}px ${round(margins.right)}px ${round(margins.bottom)}px ${round(margins.left)}px`;
  parent.style["justify-items"] = "start";
  parent.style["align-items"] = "start";
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    child.style["grid-area"] = "1 / 1";
    setMargin(
      child.style,
      "left",
      layout.rect.x - parentLayout.rect.x - margins.left,
    );
    setMargin(
      child.style,
      "top",
      layout.rect.y - parentLayout.rect.y - margins.top,
    );
  }
}

function assignScrollContainerStyles(
  parent: GodotHtmlNode,
  parentLayout: GodotSceneTreeNode,
  children: GodotHtmlNode[],
  layoutByPath: Map<string, GodotSceneTreeNode>,
  options: GodotHtmlRenderOptions,
): void {
  const margins = panelStyleBoxMetrics(parentLayout, options);
  // The stylebox border lives on the out-of-flow self-layer, so the scroll
  // viewport inset is the full content margin (see assignPanelContainerStyles).
  parent.style.display = "block";
  parent.style.padding = `${round(margins.top)}px ${round(margins.right)}px ${round(margins.bottom)}px ${round(margins.left)}px`;
  parent.style["overflow-x"] = scrollOverflow(
    asNumber(parentLayout.properties.horizontal_scroll_mode),
  );
  parent.style["overflow-y"] = scrollOverflow(
    asNumber(parentLayout.properties.vertical_scroll_mode),
  );
  delete parent.style.overflow;
  for (const child of children) {
    const layout = layoutByPath.get(child.path);
    if (!layout) {
      continue;
    }
    setManagedChildPosition(child);
    child.style.width = `${round(layout.rect.width)}px`;
    child.style.height = `${round(layout.rect.height)}px`;
    setMargin(
      child.style,
      "left",
      layout.rect.x - parentLayout.rect.x - margins.left,
    );
    setMargin(
      child.style,
      "top",
      layout.rect.y - parentLayout.rect.y - margins.top,
    );
  }
}

function scrollOverflow(mode: number | undefined): string {
  if (mode === 0 || mode === 3) {
    return "hidden";
  }
  if (mode === 2) {
    return "scroll";
  }
  return "auto";
}

function setManagedChildPosition(child: GodotHtmlNode): void {
  child.positioning = "container-managed";
  child.attributes["data-godot-positioning"] = "container-managed";
  child.style.position = "relative";
  delete child.style.left;
  delete child.style.top;
}

function setMargin(
  style: Record<string, string>,
  side: "left" | "top",
  value: number,
): void {
  const property = side === "left" ? "margin-left" : "margin-top";
  if (Math.abs(value) > 0.001) {
    style[property] = `${round(value)}px`;
  } else {
    delete style[property];
  }
}

function layoutTracks(
  nodes: GodotSceneTreeNode[],
  startKey: "x" | "y",
  sizeKey: "width" | "height",
): Array<{ start: number; size: number }> {
  const byStart = new Map<number, number>();
  for (const node of nodes) {
    const start = node.rect[startKey];
    const existing = byStart.get(start) ?? 0;
    byStart.set(start, Math.max(existing, node.rect[sizeKey]));
  }
  return [...byStart.entries()]
    .sort(([left], [right]) => left - right)
    .map(([start, size]) => ({ start, size }));
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
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
