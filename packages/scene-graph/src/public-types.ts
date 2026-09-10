import type {
  GodotNode,
  GodotRect,
  GodotResourceRefValue,
  GodotSceneState,
  GodotVariant,
} from "@godot-scene-web/core";

/**
 * The rect-free fields shared by a structural {@link SceneGraphNode} (the
 * browser-native producer output) and a fully laid-out {@link GodotSceneTreeNode}
 * (the computed rect-engine output). Everything here is derived from the node's
 * own properties and its place in the tree — no rect math. `deriveNodeVisuals`
 * produces it; the rect engine layers `rect`/`renderedRect`/`cumulativeTransform`
 * on top.
 */
export interface GodotSceneNodeBase {
  path: string;
  name: string;
  type: string;
  parentPath: string | null;
  children: string[];
  source?: GodotNode;
  visible: boolean;
  zIndex: number;
  drawOrder: number;
  zAsRelative: boolean;
  showBehindParent: boolean;
  clipContents: boolean;
  textAlign: "left" | "center" | "right" | "fill";
  textVerticalAlign: "top" | "center" | "bottom" | "fill";
  scale: { x: number; y: number };
  pivotOffset: { x: number; y: number };
  properties: Record<string, GodotVariant>;
  resourceRefs: GodotResourceRefValue[];
  textRuns?: GodotTextRunMetric[];
  fontMetadata?: Record<string, unknown>;
}

/**
 * A node in the browser-native {@link SceneGraph}: structure + the rect-free
 * visual derivation, with NO computed rect. The browser HTML emitter consumes
 * this directly (the CSS engine resolves geometry); the computed rect engine
 * (`resolveGodotSceneTree`) layers `rect`/`renderedRect` on top to produce a
 * {@link GodotSceneTreeNode}.
 */
export type SceneGraphNode = GodotSceneNodeBase;

/**
 * The structural + rect-free render model — the output of `deriveSceneGraph`
 * (`@godot-scene-web/scene-graph`). The browser HTML emitter consumes it as-is;
 * the computed rect engine (`@godot-scene-web/layout`) consumes it as the input
 * to the rect cascade. Neither package depends on `scene-graph`; they exchange
 * this shared type.
 */
export interface SceneGraph {
  nodes: SceneGraphNode[];
  resourceStatuses: GodotResourceStatus[];
}

export interface GodotTextRunMetric {
  text: string;
  style?: string;
  fontSize?: number;
  rect: GodotRect;
}

export type GodotResourceStatusKind =
  | "external-scene"
  | "resource"
  | "resource-path";

export type GodotResourceLoadStatus = "ready" | "pending" | "error";

export interface GodotResourceStatus {
  kind: GodotResourceStatusKind;
  status: GodotResourceLoadStatus;
  nodePath?: string;
  path?: string;
  ref?: GodotResourceRefValue;
  message?: string;
}

export type GodotExternalSceneResolution =
  | GodotSceneState
  | { status: "ready"; scene: GodotSceneState; path?: string }
  | { status: "pending"; path?: string; message?: string }
  | { status: "error"; path?: string; message: string };

export interface GodotExternalSceneResolveContext {
  ref: GodotResourceRefValue;
  node: GodotNode;
  nodePath: string;
  props: Record<string, GodotVariant>;
}

/**
 * The structural options consumed by `deriveSceneGraph`
 * (`@godot-scene-web/scene-graph`): node inclusion, prop/type/instance overrides,
 * repeated-node expansion, and external-scene mounting. The rect engine's
 * `GodotLayoutOptions` and the host's render options extend this with their own
 * rect-/resource-specific fields.
 */
export interface SceneStructureOptions {
  overrideNodeProps?: (
    node: GodotNode,
    path: string,
  ) => Record<string, GodotVariant> | undefined;
  /**
   * Override a node's reported Godot `type` (e.g. retype a `SpineSprite` to a
   * `TextureRect`). Applied during indexing without mutating the source scene;
   * return `undefined` to keep the authored type.
   */
  overrideNodeType?: (node: GodotNode, path: string) => string | undefined;
  /**
   * Inject (or replace) the PackedScene `instance` ref on an existing node — a
   * state-driven dynamic mount. Applied during indexing; resolved through the
   * same `resolveExternalScene`/`mountExternalScene` path. Return `undefined` to
   * keep the authored instance (if any).
   */
  overrideNodeInstance?: (
    node: GodotNode,
    path: string,
  ) => GodotResourceRefValue | undefined;
  includeNode?: (
    node: GodotNode,
    path: string,
    props: Record<string, GodotVariant>,
  ) => boolean;
  mountExternalScene?: (
    ref: GodotResourceRefValue,
    node: GodotNode,
  ) => GodotSceneState | undefined;
  resolveExternalScene?: (
    context: GodotExternalSceneResolveContext,
  ) => GodotExternalSceneResolution | undefined;
  expandRepeatedNode?: (
    node: GodotNode,
    path: string,
  ) => GodotNode[] | undefined;
}

/**
 * Structural input to {@link deriveNodeVisuals}: a node already flattened by the
 * scene index, carrying its resolved props, scene-tree path, and source node.
 */
export interface DerivedNodeInput {
  node: GodotNode;
  path: string;
  parentPath: string | null;
  children: string[];
  props: Record<string, GodotVariant>;
  order: number;
}
