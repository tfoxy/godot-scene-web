import type { SceneGraph, SceneGraphNode } from "@godot-scene-web/scene-graph";
import { resolveAnchors } from "./anchors";
import {
  boxContainerHorizontal,
  flowContainerVertical,
  isBoxContainerType,
  isFlowContainerType,
  layoutAspectRatioContainerChildren,
  layoutBoxContainerChildren,
  layoutCenterChildren,
  layoutFlowContainerChildren,
  layoutGridContainerChildren,
  layoutMarginChildren,
  layoutPanelContainerChildren,
  layoutScrollContainerChildren,
} from "./container-layout";
import { makeLayoutNode } from "./layout-node";
import { controlRect, rootRect } from "./rects";
import type { GodotSceneTree } from "./types";

export type {
  GodotAnchorEdge,
  GodotAnchorHorizontalEdge,
  GodotAnchorVerticalEdge,
} from "./anchor-grammar";
export { anchorEdgePoint, parseAnchorEdge } from "./anchor-grammar";
export { flattenSceneGraphNodes } from "./membership";
export type {
  GodotAnchorMap,
  GodotLayoutDiagnostic,
  GodotLayoutModel,
  GodotLayoutNode,
  GodotLayoutOptions,
  GodotNodeAnchor,
  GodotRect,
  GodotSceneTree,
  GodotSceneTreeDiagnostic,
  GodotSceneTreeNode,
  GodotTextRunMetric,
} from "./types";
export function isGodotSceneTree(
  value: unknown,
): value is import("./types").GodotSceneTree {
  if (typeof value !== "object" || value === null) return false;
  const tree = value as {
    viewport?: unknown;
    nodes?: unknown;
    diagnostics?: unknown;
    resourceStatuses?: unknown;
  };
  return (
    isRectLike(tree.viewport) &&
    Array.isArray(tree.nodes) &&
    tree.nodes.every(isTreeNode) &&
    (tree.diagnostics === undefined || Array.isArray(tree.diagnostics)) &&
    (tree.resourceStatuses === undefined ||
      Array.isArray(tree.resourceStatuses))
  );
}
function isRectLike(value: unknown): value is import("./types").GodotRect {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number"
  );
}
function isTreeNode(
  value: unknown,
): value is import("./types").GodotSceneTreeNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.path === "string" &&
    typeof node.name === "string" &&
    typeof node.type === "string" &&
    (typeof node.parentPath === "string" || node.parentPath === null) &&
    Array.isArray(node.children) &&
    isRectLike(node.rect) &&
    typeof node.visible === "boolean" &&
    typeof node.zIndex === "number" &&
    typeof node.drawOrder === "number" &&
    typeof node.zAsRelative === "boolean" &&
    typeof node.showBehindParent === "boolean" &&
    typeof node.clipContents === "boolean" &&
    typeof node.properties === "object" &&
    node.properties !== null &&
    Array.isArray(node.resourceRefs)
  );
}

import type {
  GodotLayoutDiagnostic,
  GodotLayoutNode,
  GodotLayoutOptions,
  GodotRect,
  IndexedNode,
} from "./types";

const DEFAULT_VIEWPORT: GodotRect = { x: 0, y: 0, width: 1280, height: 720 };

// Flow containers report their wrapped cross extent based on the width a parent
// gives them, so a content-sizing ancestor can only converge by re-laying out
// with the resolved width fed back (mirroring Godot's cross-frame `cached_size`).
// Scenes without flow containers resolve in a single pass.
const MAX_LAYOUT_PASSES = 8;

// Rebuild the rect engine's mutable working node from a shared `SceneGraphNode`.
// The graph (from `deriveSceneGraph`) is the immutable structural + visual
// derivation shared with the browser emitter; the cascade needs a per-call node
// it can memoize minimum sizes / flow extents on, so it works on these
// reconstructed copies. Field values are unchanged — only the carrier differs,
// so the rect cascade and its goldens are untouched.
function toIndexedNode(node: SceneGraphNode): IndexedNode {
  return {
    node: node.source ?? {
      name: node.name,
      type: node.type,
      attributes: {},
      properties: node.properties,
    },
    path: node.path,
    parentPath: node.parentPath,
    children: [...node.children],
    props: node.properties,
    order: node.drawOrder,
  };
}

export function resolveGodotSceneTree(
  graph: SceneGraph,
  options: GodotLayoutOptions = {},
): GodotSceneTree {
  const viewport = { ...DEFAULT_VIEWPORT, ...options.viewport };
  const indexed = graph.nodes.map(toIndexedNode);
  const byPath = new Map(indexed.map((node) => [node.path, node]));
  const roots = indexed.filter((node) => node.parentPath === null);
  const flows = indexed.filter((node) =>
    isFlowContainerType(node.node.type ?? "Node"),
  );

  let layoutByPath = new Map<string, GodotLayoutNode>();
  let diagnostics: GodotLayoutDiagnostic[] = [];
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
    layoutByPath = new Map<string, GodotLayoutNode>();
    diagnostics = [];
    for (const node of indexed) {
      node.minimumSize = undefined;
    }
    for (const root of roots) {
      layoutNode(
        root.path,
        viewport,
        byPath,
        layoutByPath,
        diagnostics,
        options,
      );
    }
    if (flows.length === 0 || !updateFlowExtents(flows, layoutByPath)) {
      break;
    }
    if (pass === MAX_LAYOUT_PASSES - 1) {
      diagnostics.push({
        severity: "warning",
        code: "flow-layout-unconverged",
        message:
          "Flow container layout did not converge within the pass limit; rects may be unsettled.",
      });
    }
  }

  // Apply declarative anchors once layout (incl. flow wrapping) has settled, so a
  // node can be positioned against another node's final rendered/content edge.
  resolveAnchors(layoutByPath, options.anchorsByPath, diagnostics);

  return {
    viewport,
    nodes: [...layoutByPath.values()].sort(
      (left, right) =>
        left.zIndex - right.zIndex || left.drawOrder - right.drawOrder,
    ),
    diagnostics,
    resourceStatuses: graph.resourceStatuses,
  };
}

/**
 * Records each flow container's resolved main-axis extent for the next pass.
 * Returns true if any extent changed (i.e. another pass is warranted).
 */
function updateFlowExtents(
  flows: IndexedNode[],
  layoutByPath: Map<string, GodotLayoutNode>,
): boolean {
  let changed = false;
  for (const flow of flows) {
    const node = layoutByPath.get(flow.path);
    if (!node) {
      continue;
    }
    const extent = flowContainerVertical(flow)
      ? node.rect.height
      : node.rect.width;
    if (
      flow.flowMainExtent === undefined ||
      Math.abs(flow.flowMainExtent - extent) > 1e-6
    ) {
      flow.flowMainExtent = extent;
      changed = true;
    }
  }
  return changed;
}

function layoutNode(
  path: string,
  parentRect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
): GodotLayoutNode | undefined {
  const indexed = byPath.get(path);
  if (!indexed) {
    return undefined;
  }
  if (layoutByPath.has(path)) {
    return layoutByPath.get(path);
  }
  const rect =
    indexed.parentPath === null
      ? rootRect(indexed, parentRect, byPath, options)
      : controlRect(indexed, parentRect, byPath, options);
  const parentLayout = indexed.parentPath
    ? layoutByPath.get(indexed.parentPath)
    : undefined;
  const computedNode = makeLayoutNode(indexed, rect, parentLayout);
  layoutByPath.set(path, computedNode);
  layoutNodeChildren(indexed, rect, byPath, layoutByPath, diagnostics, options);

  return computedNode;
}

function layoutNodeChildren(
  indexed: IndexedNode,
  rect: GodotRect,
  byPath: Map<string, IndexedNode>,
  layoutByPath: Map<string, GodotLayoutNode>,
  diagnostics: GodotLayoutDiagnostic[],
  options: GodotLayoutOptions,
): void {
  const type = indexed.node.type ?? "Node";
  if (isBoxContainerType(type)) {
    layoutBoxContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      boxContainerHorizontal(indexed),
      layoutNodeChildren,
    );
  } else if (type === "AspectRatioContainer") {
    layoutAspectRatioContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else if (type === "GridContainer") {
    layoutGridContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else if (isFlowContainerType(type)) {
    layoutFlowContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      flowContainerVertical(indexed),
      layoutNodeChildren,
    );
  } else if (type === "PanelContainer") {
    layoutPanelContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else if (type === "ScrollContainer") {
    layoutScrollContainerChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else if (type === "MarginContainer") {
    layoutMarginChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else if (type === "CenterContainer") {
    layoutCenterChildren(
      indexed,
      rect,
      byPath,
      layoutByPath,
      diagnostics,
      options,
      layoutNodeChildren,
    );
  } else {
    for (const childPath of indexed.children) {
      layoutNode(childPath, rect, byPath, layoutByPath, diagnostics, options);
    }
  }
}
