import type { GodotNode, GodotVariant } from "@godot-scene-web/core";
import type { GodotResourceStatus } from "./public-types";

/**
 * A node as produced by the structural index: flattened, with instances/mounts
 * resolved, overrides applied, anchor presets expanded, and draw order assigned.
 * Internal to `@godot-scene-web/scene-graph`; `deriveSceneGraph` maps each of
 * these to a rect-free `SceneGraphNode`.
 */
export interface IndexedNode {
  node: GodotNode;
  path: string;
  parentPath: string | null;
  children: string[];
  props: Record<string, GodotVariant>;
  order: number;
}

export interface IndexedScene {
  nodes: IndexedNode[];
  resourceStatuses: GodotResourceStatus[];
}
