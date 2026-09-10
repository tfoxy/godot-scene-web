import {
  asBoolean,
  asNumber,
  type GodotNode,
  type GodotResourceRefValue,
  type GodotSceneState,
  type GodotVariant,
  isGodotSceneState,
} from "@godot-scene-web/core";
import {
  MOUNTED_INNER_SCENE_PATH_ATTRIBUTE,
  SOURCE_SCENE_PATH_ATTRIBUTE,
} from "./provenance";
import type {
  GodotResourceStatus,
  SceneStructureOptions,
} from "./public-types";
import type { IndexedNode, IndexedScene } from "./types";

// The scene a node was authored in (stamped per-scene on load by the project
// resolver). A mounted node merged onto an instance placeholder takes the OUTER
// scene's value (override wins); `MOUNTED_INNER_SCENE_PATH_ATTRIBUTE` records the
// INNER (instanced) scene so the resolver can still resolve the node's own
// base-authored ext-resource refs (whose ids are local to the inner scene).

// Godot `LayoutPreset` (anchors_preset) -> [anchor_left, anchor_top, anchor_right,
// anchor_bottom]. Real scenes set layout via the preset and only serialize explicit
// `anchor_*` when they differ from it, so the layout engine must expand the preset
// or every preset-anchored node falls back to anchors 0 (collapsing to 0 size or
// the top-left corner). Mirrors `Control::set_anchors_preset`.
const ANCHOR_PRESETS: Record<number, [number, number, number, number]> = {
  0: [0, 0, 0, 0], // TOP_LEFT
  1: [1, 0, 1, 0], // TOP_RIGHT
  2: [0, 1, 0, 1], // BOTTOM_LEFT
  3: [1, 1, 1, 1], // BOTTOM_RIGHT
  4: [0, 0.5, 0, 0.5], // CENTER_LEFT
  5: [0.5, 0, 0.5, 0], // CENTER_TOP
  6: [1, 0.5, 1, 0.5], // CENTER_RIGHT
  7: [0.5, 1, 0.5, 1], // CENTER_BOTTOM
  8: [0.5, 0.5, 0.5, 0.5], // CENTER
  9: [0, 0, 0, 1], // LEFT_WIDE
  10: [0, 0, 1, 0], // TOP_WIDE
  11: [1, 0, 1, 1], // RIGHT_WIDE
  12: [0, 1, 1, 1], // BOTTOM_WIDE
  13: [0.5, 0, 0.5, 1], // VCENTER_WIDE
  14: [0, 0.5, 1, 0.5], // HCENTER_WIDE
  15: [0, 0, 1, 1], // FULL_RECT
};

const EXPLICIT_ANCHOR_KEYS = [
  "anchor_left",
  "anchor_top",
  "anchor_right",
  "anchor_bottom",
] as const;

/**
 * Expand `anchors_preset` into explicit `anchor_*` props when the scene did not
 * already serialize them. Explicit anchors stay authoritative (a preset is only a
 * convenience the editor resolves to anchors), so a node carrying both is left
 * untouched.
 */
function applyAnchorPreset(
  props: Record<string, GodotVariant>,
): Record<string, GodotVariant> {
  const preset = asNumber(props.anchors_preset);
  if (preset === undefined) {
    return props;
  }
  const anchors = ANCHOR_PRESETS[preset];
  if (
    !anchors ||
    EXPLICIT_ANCHOR_KEYS.some((key) => props[key] !== undefined)
  ) {
    return props;
  }
  return {
    ...props,
    anchor_left: anchors[0],
    anchor_top: anchors[1],
    anchor_right: anchors[2],
    anchor_bottom: anchors[3],
  };
}

// Per-document memo of the state->GodotNode[] conversion. Derivation re-runs on
// every resolver settle while the mounted tree grows, and this conversion (plus
// everything keyed on the node `properties` records it allocates, see
// `basePropsCache`) is a pure function of the document — so the first derive of a
// document pays it and later derives reuse it, across every caller that holds the
// same document object (the Vue view and each lazy-flatten consumer share the
// fetch cache's identities). HARD CONTRACT this introduces: a `GodotSceneState`
// must not be mutated after its first derive. Producers that annotate documents
// (resource-path tagging, repeat splicing) must do so inside the loader before
// handing the document out, or produce a NEW document object.
const sceneNodesCache = new WeakMap<GodotSceneState, GodotNode[]>();

export function sceneNodesFromState(state: GodotSceneState): GodotNode[] {
  const cached = sceneNodesCache.get(state);
  if (cached) {
    return cached;
  }
  const nodes = state.nodes.map((node): GodotNode => {
    const properties = Object.fromEntries(
      node.properties.map((property) => [property.name, property.value]),
    );
    // Live producers reading `GetNodePath(…, for_parent=true)` emit the NodePath
    // form with a leading `./` (`./Panel/Flow`), whereas `.tscn` text and gsw's
    // computed `path` use the bare relative form (`Panel/Flow`). Strip a single
    // leading `./` so both resolve to the same parent; a bare `.` (root) is left
    // untouched. Safe and shape-unambiguous: `./X` and `X` denote the same node,
    // and text never emits `./`, so this is a no-op there.
    const normalizedParent = node.parent?.startsWith("./")
      ? node.parent.slice(2)
      : node.parent;
    const parent =
      node.index === 0 && (normalizedParent === "." || normalizedParent === "")
        ? undefined
        : normalizedParent;
    return {
      name: node.name,
      type: node.type,
      parent,
      instance: node.instance,
      attributes: {
        ...(node.owner !== undefined ? { owner: node.owner } : {}),
        ...(node.instancePlaceholder !== undefined
          ? { instance_placeholder: node.instancePlaceholder }
          : {}),
        ...(node.siblingIndex !== undefined
          ? { index: node.siblingIndex }
          : {}),
        ...(node.groups.length > 0 ? { groups: node.groups } : {}),
      },
      properties,
      propertyEntries: node.properties.map((property) => ({ ...property })),
    };
  });
  sceneNodesCache.set(state, nodes);
  return nodes;
}

export function indexSceneNodes(
  sceneNodes: GodotNode[],
  options: SceneStructureOptions,
): IndexedScene {
  const result: IndexedNode[] = [];
  const resourceStatuses: GodotResourceStatus[] = [];
  let order = 0;
  const nextOrder = () => order++;
  const sourceInfos = sourceNodeInfos(sceneNodes, options);
  const mountedScenes = new Map<string, GodotNode[]>();
  const blockedMountRoots = new Set<string>();
  for (const sourceNode of sceneNodes) {
    const path = godotNodeScenePath(sourceNode);
    const sourceInfo = sourceInfos.get(path);
    const instance = effectiveNodeInstance(sourceNode, path, options);
    if (!sourceInfo || sourceInfo.omitted || !instance) {
      continue;
    }
    const resolved = resolveMountedScene(
      instance,
      sourceNode,
      path,
      sourceInfo.props,
      sourceInfo.effectivelyVisible,
      options,
      resourceStatuses,
    );
    if (resolved.blockedSubtree) {
      blockedMountRoots.add(path);
    }
    if (resolved.scene?.nodes.length) {
      mountedScenes.set(path, sceneNodesFromState(resolved.scene));
    }
  }
  const mountedRootPaths = [...mountedScenes.keys()];
  const overrideNodes = new Map<string, GodotNode>();
  for (const sourceNode of sceneNodes) {
    const path = godotNodeScenePath(sourceNode);
    const sourceInfo = sourceInfos.get(path);
    if (
      !sourceInfo ||
      sourceInfo.omitted ||
      isBlocked(path, blockedMountRoots)
    ) {
      continue;
    }
    if (mountedRootPaths.some((rootPath) => path.startsWith(`${rootPath}/`))) {
      overrideNodes.set(path, sourceNode);
    }
  }
  const consumedOverrides = new Set<string>();

  for (const sourceNode of sceneNodes) {
    const path = godotNodeScenePath(sourceNode);
    const sourceInfo = sourceInfos.get(path);
    if (
      !sourceInfo ||
      sourceInfo.omitted ||
      isBlocked(path, blockedMountRoots)
    ) {
      continue;
    }
    // A node that overrides another mount's child is grafted by that enclosing
    // mount's `addMountedSceneNodes`, NOT here — even when it is ALSO a mount root
    // itself (an instance nested under an outer mount's added-child, e.g. a deck-view
    // sort button under the card-grid mount). Expanding it top-level too would
    // duplicate it against the enclosing mount's graft and collapse to a childless
    // leaf. So skip override children before the mount-root expansion below.
    if (overrideNodes.has(path)) {
      continue;
    }
    const mountedScene = mountedScenes.get(path);
    if (mountedScene) {
      addMountedSceneNodes(
        result,
        sourceNode,
        path,
        mountedScene,
        overrideNodes,
        consumedOverrides,
        options,
        resourceStatuses,
        nextOrder,
        new Set([resourceRefKey(sourceNode.instance)]),
        sourceInfo.effectivelyVisible,
      );
      continue;
    }
    addIndexedNode(result, sourceNode, options, nextOrder);
  }
  for (const [path, overrideNode] of overrideNodes) {
    if (!consumedOverrides.has(path)) {
      addIndexedNode(result, overrideNode, options, nextOrder);
    }
  }
  const byPath = new Map(result.map((node) => [node.path, node]));
  for (const node of result) {
    if (node.parentPath && byPath.has(node.parentPath)) {
      byPath.get(node.parentPath)?.children.push(node.path);
    }
  }
  reorderChildrenByIndex(result, byPath);
  reassignDrawOrder(result, byPath);
  return { nodes: result, resourceStatuses };
}

/**
 * Godot appends children in scene order, then relocates any node carrying an
 * explicit `index` to that position among its siblings (`SceneState::instantiate`
 * -> `Node::move_child`). Moves are applied in scene order, each against the live
 * sibling list, mirroring the engine. Nodes without `index` keep scene order.
 */
function reorderChildrenByIndex(
  result: IndexedNode[],
  byPath: Map<string, IndexedNode>,
): void {
  for (const node of result) {
    if (node.children.length < 2) {
      continue;
    }
    const moves = node.children
      .map((childPath) => ({
        path: childPath,
        index: asNumber(byPath.get(childPath)?.node.attributes.index),
      }))
      .filter(
        (move): move is { path: string; index: number } =>
          move.index !== undefined && move.index >= 0,
      );
    for (const move of moves) {
      const from = node.children.indexOf(move.path);
      if (from < 0) {
        continue;
      }
      node.children.splice(from, 1);
      node.children.splice(
        Math.min(move.index, node.children.length),
        0,
        move.path,
      );
    }
  }
}

/**
 * Re-derive `order` (draw order) from the resolved child lists via a pre-order
 * walk so z-stacking and HTML child order follow the final sibling order. When no
 * `index` reordering happened this reproduces the scene-order counter exactly,
 * because a well-formed scene already lists nodes in pre-order.
 */
function reassignDrawOrder(
  result: IndexedNode[],
  byPath: Map<string, IndexedNode>,
): void {
  let order = 0;
  const visit = (node: IndexedNode): void => {
    node.order = order++;
    for (const childPath of node.children) {
      const child = byPath.get(childPath);
      if (child) {
        visit(child);
      }
    }
  };
  for (const node of result) {
    if (!node.parentPath || !byPath.has(node.parentPath)) {
      visit(node);
    }
  }
}

function godotNodeScenePath(node: GodotNode): string {
  if (!node.parent) {
    return ".";
  }
  return node.parent === "." ? node.name : `${node.parent}/${node.name}`;
}

function godotNodeParentScenePath(node: GodotNode): string | null {
  if (!node.parent) {
    return null;
  }
  return node.parent;
}

interface SourceNodeInfo {
  props: Record<string, GodotVariant>;
  omitted: boolean;
  effectivelyVisible: boolean;
}

function sourceNodeInfos(
  sceneNodes: GodotNode[],
  options: SceneStructureOptions,
): Map<string, SourceNodeInfo> {
  const infos = new Map<string, SourceNodeInfo>();
  for (const node of sceneNodes) {
    const path = godotNodeScenePath(node);
    const props = effectiveNodeProps(node, path, options);
    const parentPath = godotNodeParentScenePath(node);
    const parentInfo = parentPath ? infos.get(parentPath) : undefined;
    const included = options.includeNode?.(node, path, props) ?? true;
    const omitted = !included || Boolean(parentInfo?.omitted);
    const effectivelyVisible =
      !omitted &&
      (asBoolean(props.visible) ?? true) &&
      (parentPath ? (parentInfo?.effectivelyVisible ?? true) : true);
    infos.set(path, { props, omitted, effectivelyVisible });
  }
  return infos;
}

// No-override effective props per `node.properties` identity. Keying on the
// properties record (not the node) makes the cache hit through every node wrapper
// that preserves the record — `remapMountedNode`, the `overrideNodeType` copy, and
// override-free `mergeMountedNode` — so mounted subtrees reuse it too. The cached
// value depends only on the record's contents plus `applyAnchorPreset` (pure), so
// it is safe to share across options/callers. The override branch is keyed BOTH by the record
// and by the override object (below), so it composes with this base cache.
const basePropsCache = new WeakMap<
  Record<string, GodotVariant>,
  Record<string, GodotVariant>
>();

// Override-branch merge cache, keyed by (node.properties, overrideProps). When the host keeps a
// node's override object identity-stable across renders for unchanged values, this returns the SAME
// merged object — so the derive node-memo's identity fast-path (`prev.props === node.props`) hits
// and the node is reused (no propsSignature / re-derive / re-render). Safe for the SAME reason
// basePropsCache is (the result is treated immutable downstream); option-safe because a different
// resolver / different content yields a different `overrideProps` object → a different entry.
const overrideMergeCache = new WeakMap<
  Record<string, GodotVariant>,
  WeakMap<Record<string, GodotVariant>, Record<string, GodotVariant>>
>();

function effectiveNodeProps(
  node: GodotNode,
  path: string,
  options: SceneStructureOptions,
): Record<string, GodotVariant> {
  const overrideProps = options.overrideNodeProps?.(node, path);
  if (overrideProps !== undefined && Object.keys(overrideProps).length > 0) {
    let byOverride = overrideMergeCache.get(node.properties);
    if (byOverride === undefined) {
      byOverride = new WeakMap();
      overrideMergeCache.set(node.properties, byOverride);
    }
    const cachedMerge = byOverride.get(overrideProps);
    if (cachedMerge !== undefined) return cachedMerge;
    const merged = applyAnchorPreset({ ...node.properties, ...overrideProps });
    byOverride.set(overrideProps, merged);
    return merged;
  }
  const cached = basePropsCache.get(node.properties);
  if (cached) {
    return cached;
  }
  const props = applyAnchorPreset({ ...node.properties });
  basePropsCache.set(node.properties, props);
  return props;
}

function isBlocked(path: string, blockedRoots: Set<string>): boolean {
  for (const root of blockedRoots) {
    if (path.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

function resolveMountedScene(
  ref: GodotResourceRefValue,
  node: GodotNode,
  nodePath: string,
  props: Record<string, GodotVariant>,
  effectivelyVisible: boolean,
  options: SceneStructureOptions,
  resourceStatuses: GodotResourceStatus[],
): { scene?: GodotSceneState; blockedSubtree?: boolean } {
  if (options.resolveExternalScene) {
    if (!effectivelyVisible) {
      return {};
    }
    const resolution = options.resolveExternalScene({
      ref,
      node,
      nodePath,
      props,
    });
    if (!resolution) {
      return {};
    }
    if (isGodotSceneState(resolution)) {
      return { scene: resolution };
    }
    if (resolution.status === "ready") {
      return { scene: resolution.scene };
    }
    resourceStatuses.push({
      kind: "external-scene",
      status: resolution.status,
      nodePath,
      path: resolution.path,
      ref,
      message: resolution.message,
    });
    return { blockedSubtree: true };
  }
  const scene = options.mountExternalScene?.(ref, node);
  return scene ? { scene } : {};
}

function addIndexedNode(
  result: IndexedNode[],
  sourceNode: GodotNode,
  options: SceneStructureOptions,
  nextOrder: () => number,
): void {
  const path = godotNodeScenePath(sourceNode);
  const props = effectiveNodeProps(sourceNode, path, options);
  if (options.includeNode?.(sourceNode, path, props) === false) {
    return;
  }
  result.push(
    makeIndexedNode(
      sourceNode,
      path,
      godotNodeParentScenePath(sourceNode),
      options,
      nextOrder(),
      props,
    ),
  );
  for (const repeated of options.expandRepeatedNode?.(sourceNode, path) ?? []) {
    const repeatedPath = godotNodeScenePath(repeated);
    const repeatedProps = effectiveNodeProps(repeated, repeatedPath, options);
    if (
      options.includeNode?.(repeated, repeatedPath, repeatedProps) === false
    ) {
      continue;
    }
    result.push(
      makeIndexedNode(
        repeated,
        repeatedPath,
        godotNodeParentScenePath(repeated),
        options,
        nextOrder(),
        repeatedProps,
      ),
    );
  }
}

function addMountedSceneNodes(
  result: IndexedNode[],
  hostNode: GodotNode,
  hostPath: string,
  mountedNodes: GodotNode[],
  overrideNodes: Map<string, GodotNode>,
  consumedOverrides: Set<string>,
  options: SceneStructureOptions,
  resourceStatuses: GodotResourceStatus[],
  nextOrder: () => number,
  mountStack: Set<string>,
  hostEffectiveVisible: boolean,
): void {
  const [mountedRoot, ...mountedChildren] = mountedNodes;
  if (!mountedRoot) {
    addIndexedNode(result, hostNode, options, nextOrder);
    return;
  }

  const hostMergedNode = mergeMountedNode(mountedRoot, hostNode, {
    name: hostNode.name,
    parent: hostNode.parent,
    instance: hostNode.instance,
  });
  const hostIndexed = makeIndexedNode(
    hostMergedNode,
    hostPath,
    godotNodeParentScenePath(hostNode),
    options,
    nextOrder(),
  );
  result.push(hostIndexed);

  const mountedPaths = new Set<string>([hostPath]);
  const nestedMountedOverridePaths = new Set<string>();
  const nestedBlockedMountRoots = new Set<string>();
  const effectiveVisibleByPath = new Map<string, boolean>([
    [
      hostPath,
      hostEffectiveVisible && (asBoolean(hostIndexed.props.visible) ?? true),
    ],
  ]);
  for (const mountedChild of mountedChildren) {
    const mountedChildPath = godotNodeScenePath(mountedChild);
    const path = remapMountedPath(hostPath, godotNodeScenePath(mountedChild));
    if (
      nestedMountedOverridePaths.has(path) ||
      isBlocked(path, nestedBlockedMountRoots)
    ) {
      continue;
    }
    const parentPath = remapMountedParentPath(
      hostPath,
      godotNodeParentScenePath(mountedChild),
    );
    const override = overrideNodes.get(path);
    if (override) {
      consumedOverrides.add(path);
    }
    // Force the host-remapped name/parent in BOTH branches. `override.parent` is the
    // override's raw scene-relative parent (e.g. a repeat mount's `CardGrid/ScrollContainer`),
    // which is NOT the assembled path in a nested mount — keeping it orphans the merged node
    // (its parent isn't in the index). `remapMountedNode` already does this for the no-override
    // branch; the merge must match so a mounted child WITH an override links under the same host.
    const node = override
      ? mergeMountedNode(mountedChild, override, {
          name: path.split("/").at(-1) ?? mountedChild.name,
          parent: parentPath ?? undefined,
        })
      : remapMountedNode(mountedChild, path, parentPath);
    const props = effectiveNodeProps(node, path, options);
    if (options.includeNode?.(node, path, props) === false) {
      nestedBlockedMountRoots.add(path);
      continue;
    }
    const parentEffectiveVisible =
      parentPath === null
        ? true
        : (effectiveVisibleByPath.get(parentPath) ?? true);
    const effectiveVisible =
      parentEffectiveVisible && (asBoolean(props.visible) ?? true);
    effectiveVisibleByPath.set(path, effectiveVisible);
    const nestedInstance = effectiveNodeInstance(node, path, options);
    const childMountKey = resourceRefKey(nestedInstance);
    const nestedResolved =
      nestedInstance && childMountKey && !mountStack.has(childMountKey)
        ? resolveMountedScene(
            nestedInstance,
            node,
            path,
            props,
            effectiveVisible,
            options,
            resourceStatuses,
          )
        : {};
    if (nestedResolved.blockedSubtree) {
      nestedBlockedMountRoots.add(path);
    }
    if (nestedResolved.scene?.nodes.length) {
      const nestedOverrideNodes = new Map(overrideNodes);
      for (const candidate of mountedChildren) {
        const candidatePath = godotNodeScenePath(candidate);
        if (!candidatePath.startsWith(`${mountedChildPath}/`)) {
          continue;
        }
        const remappedCandidatePath = remapMountedPath(hostPath, candidatePath);
        nestedOverrideNodes.set(remappedCandidatePath, candidate);
        nestedMountedOverridePaths.add(remappedCandidatePath);
      }
      addMountedSceneNodes(
        result,
        node,
        path,
        sceneNodesFromState(nestedResolved.scene),
        nestedOverrideNodes,
        consumedOverrides,
        options,
        resourceStatuses,
        nextOrder,
        new Set([...mountStack, childMountKey]),
        effectiveVisible,
      );
    } else {
      result.push(
        makeIndexedNode(node, path, parentPath, options, nextOrder(), props),
      );
    }
    mountedPaths.add(path);
  }

  for (const [path, override] of overrideNodes) {
    if (
      !path.startsWith(`${hostPath}/`) ||
      mountedPaths.has(path) ||
      isBlocked(path, nestedBlockedMountRoots)
    ) {
      continue;
    }
    consumedOverrides.add(path);
    // `path` is the override's host-remapped key; the raw `override` node still
    // carries its source `parent`/`name` (e.g. a child ADDED under an instance:
    // `parent="Relic"`). Grafting it raw makes `addIndexedNode` recompute the
    // un-remapped path ("Relic/AmountLabel"), which has no parent in a NESTED mount
    // and is dropped. Remap the node to `path` first (a no-op at the top level,
    // where the key already equals the raw path) so it links under the host.
    const parentPath = path.slice(0, path.lastIndexOf("/"));
    const node = remapMountedNode(override, path, parentPath);
    const props = effectiveNodeProps(node, path, options);
    const included = options.includeNode?.(node, path, props) !== false;
    // The override may itself be an instance (a mount root nested under this host's
    // added-child subtree, e.g. a deck-view sort button under the card-grid mount).
    // Resolve + recurse so its internals expand, exactly like the mounted-children
    // loop above; otherwise graft it flat (the common added-child case is unchanged).
    const nestedInstance = included
      ? effectiveNodeInstance(node, path, options)
      : undefined;
    const childMountKey = resourceRefKey(nestedInstance);
    const parentEffectiveVisible =
      effectiveVisibleByPath.get(parentPath) ?? true;
    const effectiveVisible =
      parentEffectiveVisible && (asBoolean(props.visible) ?? true);
    const nestedResolved =
      nestedInstance && childMountKey && !mountStack.has(childMountKey)
        ? resolveMountedScene(
            nestedInstance,
            node,
            path,
            props,
            effectiveVisible,
            options,
            resourceStatuses,
          )
        : {};
    if (nestedResolved.scene?.nodes.length) {
      effectiveVisibleByPath.set(path, effectiveVisible);
      // Its descendants are grafted by the recursion; block them in this outer loop.
      nestedBlockedMountRoots.add(path);
      mountedPaths.add(path);
      addMountedSceneNodes(
        result,
        node,
        path,
        sceneNodesFromState(nestedResolved.scene),
        new Map(overrideNodes),
        consumedOverrides,
        options,
        resourceStatuses,
        nextOrder,
        new Set([...mountStack, childMountKey]),
        effectiveVisible,
      );
    } else {
      if (nestedResolved.blockedSubtree) {
        nestedBlockedMountRoots.add(path);
      }
      addIndexedNode(result, node, options, nextOrder);
    }
  }
}

// The node's effective PackedScene instance ref: a host-injected override (a
// state-driven dynamic mount) wins over the authored `.tscn` instance.
function effectiveNodeInstance(
  node: GodotNode,
  path: string,
  options: SceneStructureOptions,
): GodotResourceRefValue | undefined {
  return options.overrideNodeInstance?.(node, path) ?? node.instance;
}

function makeIndexedNode(
  sourceNode: GodotNode,
  path: string,
  parentPath: string | null,
  options: SceneStructureOptions,
  order: number,
  precomputedProps?: Record<string, GodotVariant>,
): IndexedNode {
  const props =
    precomputedProps ?? effectiveNodeProps(sourceNode, path, options);
  const typeOverride = options.overrideNodeType?.(sourceNode, path);
  const node =
    typeOverride !== undefined && typeOverride !== sourceNode.type
      ? { ...sourceNode, type: typeOverride }
      : sourceNode;
  return {
    node,
    path,
    parentPath,
    children: [],
    props,
    order,
  };
}

function mergeMountedNode(
  base: GodotNode,
  override: GodotNode,
  forced: Partial<GodotNode> = {},
): GodotNode {
  // Reuse the base record when the instance site overrides nothing, so the
  // per-properties-identity caches keep hitting through the merge.
  const merged =
    Object.keys(override.properties).length === 0
      ? base.properties
      : { ...base.properties, ...override.properties };
  // `base` is the INNER (instanced) scene's node; `override` is the OUTER placeholder.
  // `source_scene_path` takes the outer value (override wins) so override-authored
  // refs (e.g. an outer-scene SubResource material) resolve against the outer scene.
  // But the node's OWN base-authored ext refs (e.g. a TextureRect's `texture`) use ext
  // ids LOCAL to the inner scene — record it so the resolver can fall back there.
  const baseScene = (base.properties as Record<string, GodotVariant>)?.[
    SOURCE_SCENE_PATH_ATTRIBUTE
  ];
  const overrideScene = (override.properties as Record<string, GodotVariant>)?.[
    SOURCE_SCENE_PATH_ATTRIBUTE
  ];
  const properties =
    typeof baseScene === "string" && baseScene !== overrideScene
      ? { ...merged, [MOUNTED_INNER_SCENE_PATH_ATTRIBUTE]: baseScene }
      : merged;
  return {
    name: forced.name ?? override.name,
    type: override.type ?? base.type,
    parent: forced.parent ?? override.parent,
    instance: forced.instance ?? override.instance ?? base.instance,
    attributes: { ...base.attributes, ...override.attributes },
    properties,
  };
}

function remapMountedNode(
  node: GodotNode,
  path: string,
  parentPath: string | null,
): GodotNode {
  return {
    ...node,
    name: path.split("/").at(-1) ?? node.name,
    parent: parentPath ?? undefined,
  };
}

function remapMountedPath(hostPath: string, mountedPath: string): string {
  return mountedPath === "." ? hostPath : `${hostPath}/${mountedPath}`;
}

function remapMountedParentPath(
  hostPath: string,
  parentPath: string | null,
): string | null {
  if (parentPath === null) {
    return null;
  }
  return parentPath === "." ? hostPath : `${hostPath}/${parentPath}`;
}

function resourceRefKey(ref: GodotResourceRefValue | undefined): string {
  return ref ? `${ref.type}:${ref.id ?? ref.path}` : "";
}
