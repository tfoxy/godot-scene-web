import type { SceneGraph, SceneGraphNode } from "@godot-scene-web/scene-graph";
import { isBoxContainerType, isFlowContainerType } from "./container-types";

/**
 * The nodes the rect cascade ({@link resolveGodotSceneTree}) would lay out, without
 * running it. The cascade drops exactly one class of node: an invisible child of a
 * Box/Grid/Flow container — and its whole subtree — because a hidden control takes
 * no space in those containers (`visibleChildren` in minimum-size.ts; every other
 * container type and plain parents lay out all children). Consumers that only need
 * per-node structural fields (`drawOrder`, `type`, `source`, `properties`) can use
 * this instead of the cascade and skip all rect math; `membership.test.ts` pins the
 * equivalence against the cascade.
 */
export function flattenSceneGraphNodes(graph: SceneGraph): SceneGraphNode[] {
  const byPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const out: SceneGraphNode[] = [];
  const visit = (node: SceneGraphNode): void => {
    out.push(node);
    const skipsInvisibleChildren =
      isBoxContainerType(node.type) ||
      isFlowContainerType(node.type) ||
      node.type === "GridContainer";
    for (const childPath of node.children) {
      const child = byPath.get(childPath);
      if (!child) {
        continue;
      }
      if (skipsInvisibleChildren && !child.visible) {
        continue;
      }
      visit(child);
    }
  };
  for (const node of graph.nodes) {
    if (node.parentPath === null) {
      visit(node);
    }
  }
  return out;
}
