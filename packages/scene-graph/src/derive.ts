import type { GodotSceneState, GodotVariant } from "@godot-scene-web/core";
import type {
  SceneGraph,
  SceneGraphNode,
  SceneStructureOptions,
} from "./public-types";
import { indexSceneNodes, sceneNodesFromState } from "./scene-index";
import type { IndexedNode } from "./types";
import { deriveNodeVisuals } from "./visuals";

interface SceneGraphNodeMemoEntry {
  props: Record<string, GodotVariant>;
  propsSig: string;
  parentZIndex: number | undefined;
  name: string;
  type: string;
  order: number;
  childrenKey: string;
  zAsRelative: boolean;
  output: SceneGraphNode;
}

/**
 * Cross-render per-node derivation cache (one per view, persisted across
 * {@link deriveSceneGraph} calls). Lets an unchanged node reuse its prior
 * {@link SceneGraphNode} object so its identity survives a re-derive — the
 * prerequisite for the html/render memos downstream. Opaque to callers.
 */
export type SceneGraphNodeMemo = Map<string, SceneGraphNodeMemoEntry>;

export function createSceneGraphNodeMemo(): SceneGraphNodeMemo {
  return new Map();
}

// Content signature of a node's resolved props. Used as the change signal when the
// props RECORD identity is not stable across renders — which is the case for any node
// carrying an override (the producer rebuilds `{...base, ...override}` fresh every
// render even when the override value is unchanged). Deterministic: the same node's
// props are assembled by the same code path, so key order is stable.
function propsSignature(props: Record<string, GodotVariant>): string {
  return JSON.stringify(props);
}

/**
 * Produce the browser-native {@link SceneGraph} from a parsed scene: structurally
 * index the nodes (flatten instances/mounts, apply overrides, expand anchor
 * presets, resolve sibling/draw order), then derive each node's rect-free render
 * fields. This is the single shared producer — the browser HTML emitter consumes
 * the graph directly (CSS resolves geometry), and the computed rect engine
 * (`resolveGodotSceneTree`) consumes it as the input to the rect cascade. Neither
 * the `layout` nor `html` package depends on this one; they exchange the shared
 * `SceneGraph` type (declared in `@godot-scene-web/core`).
 *
 * Pass a {@link SceneGraphNodeMemo} (one per view, reused across calls) to preserve
 * the object identity of nodes whose derived render fields are unchanged across
 * renders — so an overrides-only host change re-derives only the changed nodes.
 */
export function deriveSceneGraph(
  scene: GodotSceneState,
  options: SceneStructureOptions = {},
  nodeMemo?: SceneGraphNodeMemo,
): SceneGraph {
  const indexed = indexSceneNodes(sceneNodesFromState(scene), options);
  const byPath = new Map(indexed.nodes.map((node) => [node.path, node]));
  const derivedByPath = new Map<string, SceneGraphNode>();
  // z-index is parent-relative when `z_as_relative`, so a node's derived z-index
  // needs its parent's. Derive lazily + memoized up the parent chain (the tree is
  // acyclic), independent of array order.
  const derive = (node: IndexedNode): SceneGraphNode => {
    const inCall = derivedByPath.get(node.path);
    if (inCall) {
      return inCall;
    }
    const parent = node.parentPath ? byPath.get(node.parentPath) : undefined;
    const parentZIndex = parent ? derive(parent).zIndex : undefined;

    // Cross-render reuse: an unchanged node keeps its `SceneGraphNode` identity so the
    // downstream html/render memos can bail out. The output is a pure function of
    // (props, parentZIndex when z_as_relative, name, type, order, children). Guard on
    // the cheap value fields first; for props, fast-path on record identity (true for
    // un-overridden nodes when the doc is stable), else fall back to a content signature
    // (overridden nodes get a fresh-but-equal record every render).
    const name = node.node.name;
    const type = node.node.type ?? "Node";
    const childrenKey = node.children.join("\0");
    const prev = nodeMemo?.get(node.path);
    const structureMatches =
      prev !== undefined &&
      prev.name === name &&
      prev.type === type &&
      prev.order === node.order &&
      prev.childrenKey === childrenKey &&
      (!prev.zAsRelative || prev.parentZIndex === parentZIndex);
    if (structureMatches && prev.props === node.props) {
      derivedByPath.set(node.path, prev.output);
      return prev.output;
    }
    let sig: string | undefined;
    if (structureMatches) {
      sig = propsSignature(node.props);
      if (sig === prev.propsSig) {
        prev.props = node.props; // refresh → next render takes the identity fast-path
        derivedByPath.set(node.path, prev.output);
        return prev.output;
      }
    }

    const derived = deriveNodeVisuals(node, parentZIndex);
    nodeMemo?.set(node.path, {
      props: node.props,
      propsSig: sig ?? propsSignature(node.props),
      parentZIndex,
      name,
      type,
      order: node.order,
      childrenKey,
      zAsRelative: derived.zAsRelative,
      output: derived,
    });
    derivedByPath.set(node.path, derived);
    return derived;
  };
  return {
    nodes: indexed.nodes.map(derive),
    resourceStatuses: indexed.resourceStatuses,
  };
}
