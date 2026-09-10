import { anchorEdgePoint, type GodotAnchorMap } from "./anchor-grammar";
import type {
  GodotLayoutDiagnostic,
  GodotLayoutNode,
  GodotRect,
} from "./types";

// The anchor declaration types and the edge grammar live in core (shared with
// the browser-native CSS anchor-positioning emitter in `html`); re-export them
// so layout's public API is unchanged.
export type { GodotAnchorMap, GodotNodeAnchor } from "./anchor-grammar";

const edgePoint = anchorEdgePoint;

/** Union of a node's visible direct children's rendered rects (its content box). */
function contentExtent(
  node: GodotLayoutNode,
  layoutByPath: Map<string, GodotLayoutNode>,
): GodotRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const childPath of node.children) {
    const child = layoutByPath.get(childPath);
    if (!child || child.visible === false) {
      continue;
    }
    const rect = child.renderedRect;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
    found = true;
  }
  if (!found) {
    // No content: collapse to a zero-size box at the node's own origin so a
    // `contentBottom`/`contentRight` edge equals the node's top-left (matching a
    // flow container with nothing in it).
    const { x, y } = node.renderedRect;
    return { x, y, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Translate a node and its whole subtree by `(dx, dy)` in global space. */
function translateSubtree(
  root: GodotLayoutNode,
  dx: number,
  dy: number,
  layoutByPath: Map<string, GodotLayoutNode>,
): void {
  const stack = [root.path];
  while (stack.length > 0) {
    const node = layoutByPath.get(stack.pop() as string);
    if (!node) {
      continue;
    }
    // `rect` drives the renderer's relative CSS `left/top`; `renderedRect` is the
    // global rect the layout-diff oracle compares. Both shift by the same pure
    // translation. Only the anchored root's parent stays put, so the root's offset
    // relative to its parent changes while descendants move rigidly with it.
    node.rect = {
      x: node.rect.x + dx,
      y: node.rect.y + dy,
      width: node.rect.width,
      height: node.rect.height,
    };
    node.renderedRect = {
      x: node.renderedRect.x + dx,
      y: node.renderedRect.y + dy,
      width: node.renderedRect.width,
      height: node.renderedRect.height,
    };
    if (node.cumulativeTransform) {
      node.cumulativeTransform = {
        ...node.cumulativeTransform,
        tx: node.cumulativeTransform.tx + dx,
        ty: node.cumulativeTransform.ty + dy,
      };
    }
    for (const childPath of node.children) {
      stack.push(childPath);
    }
  }
}

/**
 * Resolve every declared anchor, translating each anchored node (and its subtree)
 * so its `to` edge lands on its target's `from` edge. Targets that are themselves
 * anchored are resolved first; cycles are broken with a diagnostic.
 */
export function resolveAnchors(
  layoutByPath: Map<string, GodotLayoutNode>,
  anchors: GodotAnchorMap | undefined,
  diagnostics: GodotLayoutDiagnostic[],
): void {
  if (!anchors) {
    return;
  }
  const resolved = new Set<string>();
  const inProgress = new Set<string>();

  const resolveOne = (path: string): void => {
    if (resolved.has(path)) {
      return;
    }
    const anchor = anchors[path];
    const self = layoutByPath.get(path);
    if (!anchor || !self) {
      resolved.add(path);
      return;
    }
    if (inProgress.has(path)) {
      diagnostics.push({
        severity: "warning",
        code: "anchor-cycle",
        message: `Anchor cycle detected resolving ${path}; leaving it unmoved.`,
        nodePath: path,
      });
      return;
    }
    inProgress.add(path);
    // Resolve the target first when it is itself anchored, so its `from` edge is
    // already in its final position.
    if (anchors[anchor.anchorTo]) {
      resolveOne(anchor.anchorTo);
    }
    const target = layoutByPath.get(anchor.anchorTo);
    if (!target) {
      diagnostics.push({
        severity: "warning",
        code: "anchor-target-missing",
        message: `Anchor target '${anchor.anchorTo}' not found for ${path}.`,
        nodePath: path,
      });
    } else {
      const targetPoint = edgePoint(
        anchor.from,
        target.renderedRect,
        contentExtent(target, layoutByPath),
      );
      const selfPoint = edgePoint(
        anchor.to,
        self.renderedRect,
        contentExtent(self, layoutByPath),
      );
      if (!targetPoint || !selfPoint) {
        diagnostics.push({
          severity: "warning",
          code: "anchor-edge-unparsed",
          message: `Unrecognized anchor edge (from='${anchor.from}', to='${anchor.to}') for ${path}.`,
          nodePath: path,
        });
      } else {
        const dx = targetPoint.x - selfPoint.x + (anchor.offset?.x ?? 0);
        const dy = targetPoint.y - selfPoint.y + (anchor.offset?.y ?? 0);
        if (dx !== 0 || dy !== 0) {
          translateSubtree(self, dx, dy, layoutByPath);
        }
      }
    }
    inProgress.delete(path);
    resolved.add(path);
  };

  for (const path of Object.keys(anchors)) {
    resolveOne(path);
  }
}
