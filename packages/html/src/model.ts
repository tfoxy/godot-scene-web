import {
  asBoolean,
  asString,
  type GodotNode,
  type GodotResourceRefValue,
  type GodotVariant,
} from "@godot-scene-web/core";
import type {
  GodotRect,
  GodotSceneTree,
  GodotSceneTreeDiagnostic,
  GodotSceneTreeNode,
} from "@godot-scene-web/layout";
import type {
  GodotResourceStatus,
  SceneGraph,
  SceneGraphNode,
} from "@godot-scene-web/scene-graph";
import { godotSceneBaseCss } from "./base-css";
import { applyBrowserAnchorPositioning } from "./browser-anchors";
import {
  assignBrowserNativeLayout,
  assignBrowserNativeNodeLayout,
  type BrowserNativeParentContext,
} from "./browser-layout";
import { assignContainerLayoutStyles } from "./container-layout";
import {
  type ResolvedContentScale,
  resolveContentScale,
  rewritePxLengths,
  scaleStyleRecord,
} from "./content-scale";
import { round, safeClassSegment } from "./css-values";
import { assignMaterialAttributes, isShaderMaterialNode } from "./material";
import {
  assignBackgroundColor,
  assignDrawAttributes,
  assignOpacity,
  assignPointerEvents,
  assignPositionStyle,
  assignRangeStyles,
  assignSelfLayerFlip,
  assignTransform,
  assignZIndexStyle,
} from "./node-style";
import {
  imageResource,
  normalizeResource,
  sourceNodeForLayout,
  uniqueFontFaces,
} from "./resources";
import { assignInputStyleBoxStyles, assignPanelStyles } from "./style-box";
import { assignTextStyles, richTextLayeredHtml, textProp } from "./text";
import { resolveTextScale } from "./text-scale";
import { assignAnimatedSpriteStyles, assignTextureStyles } from "./textures";
import type {
  GodotHtmlFontFace,
  GodotHtmlModel,
  GodotHtmlNode,
  GodotHtmlRenderOptions,
} from "./types";
import {
  assignLine2DStyles,
  assignParticle2DStyles,
  assignPlaceholder2DStyles,
  assignSprite2DStyles,
} from "./visual-2d";

const RENDERABLE_TYPES = new Set([
  "AnimatedSprite2D",
  "AnimationPlayer",
  "AspectRatioContainer",
  "AudioStreamPlayer",
  "BackBufferCopy",
  "Button",
  "CanvasGroup",
  "CanvasLayer",
  "BoxContainer",
  "Camera2D",
  "Camera3D",
  "CenterContainer",
  "ColorRect",
  "Container",
  "Control",
  "CPUParticles2D",
  "FmodBankLoader",
  "FmodListener2D",
  "FlowContainer",
  "GPUParticles2D",
  "GPUParticles3D",
  "GridContainer",
  "HBoxContainer",
  "HFlowContainer",
  "Label",
  "LineEdit",
  "Line2D",
  "LightOccluder2D",
  "MarginContainer",
  "Marker2D",
  "MeshInstance2D",
  "MeshInstance3D",
  "Node",
  "Node2D",
  "Node3D",
  "NinePatchRect",
  "Panel",
  "PanelContainer",
  "Path2D",
  "PathFollow2D",
  "Range",
  "RichTextLabel",
  "ScrollContainer",
  "Sprite2D",
  "SubViewport",
  "SubViewportContainer",
  "TextEdit",
  "TextureRect",
  "VBoxContainer",
  "VFlowContainer",
  "WorldEnvironment",
]);

export function renderSceneToHtmlModel(
  scene: GodotSceneTree,
  options: GodotHtmlRenderOptions = {},
): GodotHtmlModel {
  const layout = scene;
  const resourceStatuses: GodotResourceStatus[] = [
    ...(layout.resourceStatuses ?? []),
  ];
  const renderOptions = withResourceStatusCollection(options, resourceStatuses);
  const classPrefix = options.classPrefix ?? "godot";
  const fontFaces: GodotHtmlFontFace[] = [];
  // Shared `<filter>` table (inner SVG markup -> id) collected while assigning
  // texture styles; emitted once and referenced via `filter: url(#id)` by
  // external color-matrix tints and consumer-supplied shader-fallback filters.
  const tintFilters = new Map<string, string>();
  const renderable = layout.nodes.filter(isRenderableNode);
  const layoutByPath = new Map(layout.nodes.map((node) => [node.path, node]));
  const renderablePaths = new Set(renderable.map((node) => node.path));
  const effectivelyVisible = effectiveVisibilityByPath(layoutByPath);
  const nodes: GodotHtmlNode[] = [];
  for (const node of renderable) {
    const parentPath = nearestRenderableParent(node, layout, renderablePaths);
    if (effectivelyVisible.get(node.path) ?? true) {
      nodes.push(
        htmlNodeFromLayoutNode(
          node,
          classPrefix,
          parentPath,
          parentPath ? layoutByPath.get(parentPath) : undefined,
          renderOptions,
          fontFaces,
          tintFilters,
        ),
      );
    } else if (
      parentPath === null ||
      (effectivelyVisible.get(parentPath) ?? true)
    ) {
      // Topmost hidden node of a pruned subtree (as seen in the rendered tree):
      // kept in position as a placeholder so every renderer can emit a comment
      // where the element would be. Deeper descendants are dropped entirely.
      nodes.push(hiddenPlaceholderNode(node, parentPath));
    }
  }
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  for (const node of nodes) {
    if (node.parentPath) {
      byPath.get(node.parentPath)?.children.push(node.path);
    }
  }
  for (const node of nodes) {
    node.children.sort(
      (left, right) =>
        (layoutByPath.get(left)?.drawOrder ?? 0) -
        (layoutByPath.get(right)?.drawOrder ?? 0),
    );
  }
  assignContainerLayoutStyles(
    nodes.filter((node) => node.kind !== "hidden-placeholder"),
    layoutByPath,
    renderOptions,
  );
  const contentScale = resolveContentScale(
    options.contentScale,
    layout.viewport,
  );
  let css = godotSceneBaseCss;
  if (contentScale && contentScale.technique === "container") {
    // Express the whole stage subtree in container-query units so the scene fits
    // its frame, preserving aspect, with no JavaScript. Inline geometry lives in
    // `style`/`selfStyle`; rich-text `[font_size]`/`[img]` px live inside `html`.
    const { base } = contentScale;
    for (const node of nodes) {
      scaleStyleRecord(node.style, base);
      scaleStyleRecord(node.selfStyle, base);
      if (node.html !== null) {
        node.html = rewritePxLengths(node.html, base);
      }
    }
    css = rewritePxLengths(godotSceneBaseCss, base);
  }
  return {
    viewport: {
      width: layout.viewport.width,
      height: layout.viewport.height,
    },
    nodes,
    fontFaces: uniqueFontFaces(fontFaces),
    tintFilters: [...tintFilters].map(([markup, id]) => ({ id, markup })),
    diagnostics: layout.diagnostics,
    resourceStatuses,
    css,
    contentScale,
  };
}

const SYNTHETIC_RECT: GodotRect = { x: 0, y: 0, width: 0, height: 0 };
export const DEFAULT_BROWSER_VIEWPORT = { width: 1280, height: 720 };

/**
 * Browser-native HTML model from a `SceneGraph` (the `deriveSceneGraph` output):
 * the SAME `GodotHtmlModel` the computed renderer produces, but geometry is left
 * to the CSS engine — containers flex/grid, children flow, anchored Controls use
 * CSS insets, text sizes itself. Reuses the shared per-node builder
 * (`htmlNodeFromLayoutNode`) for all paint/text/resource work by feeding it a
 * placeholder rect, then replaces the rect-pinning container pass with
 * `assignBrowserNativeLayout`. Because the output model shape is identical, every
 * downstream consumer (fragment builder, content-scale observer, fonts) is shared.
 */
export function renderSceneGraphToHtmlModel(
  graph: SceneGraph,
  options: GodotHtmlRenderOptions & {
    viewport?: { width?: number; height?: number };
  } = {},
): GodotHtmlModel {
  const resourceStatuses: GodotResourceStatus[] = [
    ...(graph.resourceStatuses ?? []),
  ];
  const renderOptions = withResourceStatusCollection(options, resourceStatuses);
  const classPrefix = options.classPrefix ?? "godot";
  const fontFaces: GodotHtmlFontFace[] = [];
  const tintFilters = new Map<string, string>();
  const viewport = {
    width: options.viewport?.width ?? DEFAULT_BROWSER_VIEWPORT.width,
    height: options.viewport?.height ?? DEFAULT_BROWSER_VIEWPORT.height,
  };
  // Wrap each graph node with a placeholder rect so the shared node builder runs;
  // `assignBrowserNativeLayout` overwrites all geometry afterward, so the rect
  // values themselves are never read.
  const layoutNodes: GodotSceneTreeNode[] = graph.nodes.map((node) => ({
    ...node,
    rect: { ...SYNTHETIC_RECT },
    renderedRect: { ...SYNTHETIC_RECT },
  }));
  const renderable = layoutNodes.filter(isRenderableNode);
  const layoutByPath = new Map(layoutNodes.map((node) => [node.path, node]));
  const renderablePaths = new Set(renderable.map((node) => node.path));
  const effectivelyVisible = effectiveVisibilityByPath(layoutByPath);
  const nodes: GodotHtmlNode[] = [];
  for (const node of renderable) {
    const parentPath = nearestRenderableParentPath(
      node,
      layoutByPath,
      renderablePaths,
    );
    if (effectivelyVisible.get(node.path) ?? true) {
      nodes.push(
        htmlNodeFromLayoutNode(
          node,
          classPrefix,
          parentPath,
          parentPath ? layoutByPath.get(parentPath) : undefined,
          renderOptions,
          fontFaces,
          tintFilters,
        ),
      );
    } else if (
      parentPath === null ||
      (effectivelyVisible.get(parentPath) ?? true)
    ) {
      nodes.push(hiddenPlaceholderNode(node, parentPath));
    }
  }
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  for (const node of nodes) {
    if (node.parentPath) {
      byPath.get(node.parentPath)?.children.push(node.path);
    }
  }
  for (const node of nodes) {
    node.children.sort(
      (left, right) =>
        (layoutByPath.get(left)?.drawOrder ?? 0) -
        (layoutByPath.get(right)?.drawOrder ?? 0),
    );
  }
  assignBrowserNativeLayout(
    nodes.filter((node) => node.kind !== "hidden-placeholder"),
    layoutByPath,
    renderOptions,
    viewport,
  );
  const diagnostics: GodotSceneTreeDiagnostic[] = [];
  if (options.anchorsByPath && Object.keys(options.anchorsByPath).length > 0) {
    // Runs before the container-technique px rewrite below so anchor-offset px
    // inside the emitted calc() expressions scale with everything else.
    applyBrowserAnchorPositioning(
      byPath,
      layoutByPath,
      options.anchorsByPath,
      diagnostics,
    );
  }
  const contentScale = resolveContentScale(options.contentScale, viewport);
  let css = godotSceneBaseCss;
  if (contentScale && contentScale.technique === "container") {
    const { base } = contentScale;
    for (const node of nodes) {
      scaleStyleRecord(node.style, base);
      scaleStyleRecord(node.selfStyle, base);
      if (node.html !== null) {
        node.html = rewritePxLengths(node.html, base);
      }
    }
    css = rewritePxLengths(godotSceneBaseCss, base);
  }
  return {
    viewport,
    nodes,
    fontFaces: uniqueFontFaces(fontFaces),
    tintFilters: [...tintFilters].map(([markup, id]) => ({ id, markup })),
    diagnostics,
    resourceStatuses,
    css,
    contentScale,
  };
}

/**
 * Per-node browser-native HTML for ONE `SceneGraph` node — the same paint/text/
 * resource/layout work `renderSceneGraphToHtmlModel` does per node, but callable
 * in isolation so the Vue component renderer can build (and memoize) one node at
 * a time. Feeds `htmlNodeFromLayoutNode` a placeholder rect (overwritten by
 * `assignBrowserNativeNodeLayout`, exactly as the batch model does) and threads
 * the parent's container context for the flow pass. `tintFilters` is the caller's
 * shared, lifetime-stable filter table (a markup keeps its id), so a reused node's
 * baked `filter: url(#id)` stays valid; `fontFaces`/`resourceStatuses` are this
 * node's own (the caller merges them into the view's registry).
 */
export interface GraphNodeBuildResult {
  node: GodotHtmlNode;
  // The synthetic-rect layout node — pass it as `parentLayout` when building this
  // node's children (matches the batch's `layoutByPath.get(parentPath)`).
  layout: GodotSceneTreeNode;
  fontFaces: GodotHtmlFontFace[];
  resourceStatuses: GodotResourceStatus[];
  // The context THIS node hands to its children (its container type/axis, or the
  // root context when it is not a CSS container).
  childContext: BrowserNativeParentContext;
}

export function buildGraphNodeHtml(
  graphNode: SceneGraphNode,
  parentLayout: GodotSceneTreeNode | undefined,
  parentPath: string | null,
  parentContext: BrowserNativeParentContext,
  options: GodotHtmlRenderOptions,
  tintFilters: Map<string, string>,
  viewport: { width: number; height: number },
  contentScale: ResolvedContentScale | null,
): GraphNodeBuildResult {
  const classPrefix = options.classPrefix ?? "godot";
  const fontFaces: GodotHtmlFontFace[] = [];
  const resourceStatuses: GodotResourceStatus[] = [];
  const renderOptions = withResourceStatusCollection(options, resourceStatuses);
  // Placeholder rect, as the batch model uses — geometry is overwritten below.
  const layout: GodotSceneTreeNode = {
    ...graphNode,
    rect: { ...SYNTHETIC_RECT },
    renderedRect: { ...SYNTHETIC_RECT },
  };
  const node = htmlNodeFromLayoutNode(
    layout,
    classPrefix,
    parentPath,
    parentLayout,
    renderOptions,
    fontFaces,
    tintFilters,
  );
  const childContext = assignBrowserNativeNodeLayout(
    node,
    layout,
    parentContext,
    renderOptions,
    viewport,
  );
  // Container-technique content scale rewrites inline px per node (the batch does
  // this in one sweep over `nodes`; the css rewrite is the caller's, once).
  if (contentScale && contentScale.technique === "container") {
    scaleStyleRecord(node.style, contentScale.base);
    scaleStyleRecord(node.selfStyle, contentScale.base);
    if (node.html !== null) {
      node.html = rewritePxLengths(node.html, contentScale.base);
    }
  }
  return { node, layout, fontFaces, resourceStatuses, childContext };
}

// The comment-placeholder model node for an effectively-hidden `SceneGraph` node —
// the component renderer emits it as `<!--godot:hidden …-->` (same as the batch),
// keeping the node's behind/normal paint slot among its siblings.
export function buildHiddenGraphNode(
  graphNode: SceneGraphNode,
  parentPath: string | null,
): GodotHtmlNode {
  return hiddenPlaceholderNode(graphNode, parentPath);
}

/**
 * The render STRUCTURE of a `SceneGraph` — which nodes render, and each renderable
 * parent's children split into the behind/normal paint slots (draw-order sorted),
 * flattening non-renderable nodes onto their nearest renderable ancestor. Pure and
 * visibility-agnostic: a hidden node still occupies its slot (the component renders
 * it as a comment); only the build skips DESCENDING into it. Mirrors the children-
 * wiring + draw-order sort + behind/normal partition `renderSceneGraphToHtmlModel`
 * does inline, so the component tree nests identically.
 */
export interface GraphSceneStructure {
  rootPaths: string[];
  nodesByPath: Map<string, SceneGraphNode>;
  childrenByPath: Map<string, { behind: string[]; normal: string[] }>;
}

export function buildSceneStructure(graph: SceneGraph): GraphSceneStructure {
  const nodesByPath = new Map(graph.nodes.map((node) => [node.path, node]));
  const renderable = graph.nodes.filter(isRenderableNode);
  const renderablePaths = new Set(renderable.map((node) => node.path));
  const rootPaths: string[] = [];
  const childNodesByParent = new Map<string, SceneGraphNode[]>();
  for (const node of renderable) {
    const parentPath = nearestRenderableParentPath(
      node,
      nodesByPath,
      renderablePaths,
    );
    if (parentPath === null) {
      // Roots stay in graph (document) order — the batch never sorts them.
      rootPaths.push(node.path);
      continue;
    }
    const siblings = childNodesByParent.get(parentPath);
    if (siblings) {
      siblings.push(node);
    } else {
      childNodesByParent.set(parentPath, [node]);
    }
  }
  const childrenByPath = new Map<
    string,
    { behind: string[]; normal: string[] }
  >();
  for (const [parentPath, children] of childNodesByParent) {
    children.sort((left, right) => left.drawOrder - right.drawOrder);
    const behind: string[] = [];
    const normal: string[] = [];
    for (const child of children) {
      (child.showBehindParent ? behind : normal).push(child.path);
    }
    childrenByPath.set(parentPath, { behind, normal });
  }
  return { rootPaths, nodesByPath, childrenByPath };
}

/**
 * Effective visibility per path: a node renders only when its own `visible`
 * AND every ancestor's are true (Godot hides the whole subtree). Memoized
 * parent-chain walk; node `visible` is the node's OWN flag, not inherited.
 */
function effectiveVisibilityByPath(
  layoutByPath: Map<string, GodotSceneTreeNode>,
): Map<string, boolean> {
  const effective = new Map<string, boolean>();
  const resolve = (path: string): boolean => {
    const cached = effective.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const node = layoutByPath.get(path);
    const visible =
      (node?.visible ?? true) &&
      (node?.parentPath ? resolve(node.parentPath) : true);
    effective.set(path, visible);
    return visible;
  };
  for (const path of layoutByPath.keys()) {
    resolve(path);
  }
  return effective;
}

/**
 * Minimal stand-in for the topmost node of an effectively-hidden subtree.
 * Renderers emit it as `<!--godot:hidden <path> (<Type>)-->` instead of an
 * element; it carries no styles/attributes except the mirrored
 * `data-godot-show-behind-parent` so it keeps the same behind/normal paint
 * slot among its siblings (stable child order and Vue keying across toggles).
 */
function hiddenPlaceholderNode(
  node: { path: string; name: string; type: string; showBehindParent: boolean },
  parentPath: string | null,
): GodotHtmlNode {
  const attributes: Record<string, string> = {};
  if (node.showBehindParent) {
    attributes["data-godot-show-behind-parent"] = "true";
  }
  return {
    kind: "hidden-placeholder",
    path: node.path,
    name: node.name,
    type: node.type,
    parentPath,
    children: [],
    positioning: "absolute",
    containerLayout: null,
    attributes,
    className: "",
    style: {},
    selfAttributes: {},
    selfStyle: {},
    text: null,
    html: null,
  };
}

function nearestRenderableParentPath(
  node: { parentPath: string | null },
  layoutByPath: Map<string, { parentPath: string | null }>,
  renderablePaths: Set<string>,
): string | null {
  let parentPath = node.parentPath;
  while (parentPath) {
    if (renderablePaths.has(parentPath)) {
      return parentPath;
    }
    parentPath = layoutByPath.get(parentPath)?.parentPath ?? null;
  }
  return null;
}

function withResourceStatusCollection(
  options: GodotHtmlRenderOptions,
  resourceStatuses: GodotResourceStatus[],
): GodotHtmlRenderOptions {
  return {
    ...options,
    resolveResource: options.resolveResource
      ? (ref, node) => {
          const value = options.resolveResource?.(ref, node);
          recordResourceStatus(resourceStatuses, value, {
            kind: "resource",
            ref,
            node,
          });
          return value;
        }
      : undefined,
    resolveResourcePath: options.resolveResourcePath
      ? (path, node) => {
          const value = options.resolveResourcePath?.(path, node);
          recordResourceStatus(resourceStatuses, value, {
            kind: "resource-path",
            path,
            node,
          });
          return value;
        }
      : undefined,
  };
}

function recordResourceStatus(
  statuses: GodotResourceStatus[],
  value: unknown,
  context: {
    kind: "resource" | "resource-path";
    node: GodotNode;
    ref?: GodotResourceRefValue;
    path?: string;
  },
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const status = (value as { status?: unknown }).status;
  if (status !== "pending" && status !== "error") {
    return;
  }
  statuses.push({
    kind: context.kind,
    status,
    nodePath: htmlResourceNodePath(context.node),
    path: asString((value as { path?: GodotVariant }).path) ?? context.path,
    ref: context.ref,
    message: asString((value as { message?: GodotVariant }).message),
  });
}

function htmlResourceNodePath(node: GodotNode): string {
  if (!node.parent) {
    return ".";
  }
  return node.parent === "." ? node.name : `${node.parent}/${node.name}`;
}

function htmlNodeFromLayoutNode(
  node: GodotSceneTreeNode,
  classPrefix: string,
  parentPath: string | null,
  parentNode: GodotSceneTreeNode | undefined,
  options: GodotHtmlRenderOptions,
  fontFaces: GodotHtmlFontFace[],
  tintFilters: Map<string, string>,
): GodotHtmlNode {
  const nodeOptions = options;
  const props = node.properties;
  const source = sourceNodeForLayout(node);
  // Whether this node's text tracks `var(--godot-text-scale, 1)`. Auto-fit text is
  // included by default; `exemptAutoFit` leaves it fitted to its box.
  const textScale = resolveTextScale(nodeOptions.textScale);
  const autoFitDirective = nodeOptions.textAutoFitByPath?.[node.path];
  const isAutoFitNode = Boolean(
    autoFitDirective &&
      (autoFitDirective.fitWidth || autoFitDirective.fitHeight),
  );
  const scaleText =
    textScale !== null && !(isAutoFitNode && textScale.exemptAutoFit);
  const style: Record<string, string> = {
    left: `${round(parentNode ? node.rect.x - parentNode.rect.x : node.rect.x)}px`,
    top: `${round(parentNode ? node.rect.y - parentNode.rect.y : node.rect.y)}px`,
    width: `${round(node.rect.width)}px`,
    height: `${round(node.rect.height)}px`,
    overflow: node.clipContents ? "hidden" : "visible",
  };
  const positioning = assignPositionStyle(style, node);
  assignZIndexStyle(style, node);
  const selfStyle: Record<string, string> = {
    position: "absolute",
    left: "0",
    top: "0",
    width: `${round(node.rect.width)}px`,
    height: `${round(node.rect.height)}px`,
    "box-sizing": "border-box",
    overflow: "visible",
    "pointer-events": "none",
  };
  const attributes: Record<string, string> = {
    "data-godot-path": node.path,
    "data-godot-type": node.type,
    "data-godot-name": node.name,
    "data-godot-positioning": positioning,
  };
  const selfAttributes: Record<string, string> = {
    "data-godot-self-layer": "true",
  };

  assignBackgroundColor(selfStyle, props, node.type);
  assignPointerEvents(style, props, node.type);
  assignOpacity(style, selfStyle, attributes, props);
  assignTransform(style, node, props);
  assignDrawAttributes(attributes, node, props);
  assignMaterialAttributes(
    attributes,
    style,
    props,
    source,
    nodeOptions,
    node.path,
  );
  if (
    nodeOptions.enableWebglShaders &&
    node.type === "ColorRect" &&
    props.color === undefined &&
    isShaderMaterialNode(props, source, nodeOptions)
  ) {
    delete selfStyle.background;
    selfAttributes["data-godot-shader-colorrect-fallback"] = "transparent";
  }
  let html: string | null = null;
  if (
    node.type === "Panel" ||
    node.type === "PanelContainer" ||
    node.type === "ScrollContainer"
  ) {
    assignPanelStyles(selfStyle, selfAttributes, props, node, nodeOptions);
  }
  if (node.type === "LineEdit" || node.type === "TextEdit") {
    assignInputStyleBoxStyles(
      selfStyle,
      selfAttributes,
      props,
      node,
      nodeOptions,
    );
  }
  if (node.type === "TextureRect" || node.type === "NinePatchRect") {
    html =
      assignTextureStyles(
        selfStyle,
        selfAttributes,
        props,
        source,
        nodeOptions,
        node.type === "NinePatchRect",
        // A `clip_children` nine-patch must mask the node's children, which live
        // in the outer element alongside the self-layer — so its alpha mask is
        // applied to the outer `style`/`attributes`, not the self-layer.
        style,
        attributes,
        tintFilters,
        node.path,
      ) ?? html;
  }
  if (node.type === "AnimatedSprite2D") {
    assignAnimatedSpriteStyles(
      style,
      selfAttributes,
      props,
      source,
      nodeOptions,
    );
    movePaintStyles(style, selfStyle);
    syncSelfLayerBox(style, selfStyle);
  }
  if (node.type === "Sprite2D") {
    assignSprite2DStyles(
      style,
      selfAttributes,
      props,
      source,
      nodeOptions,
      node.path,
    );
    movePaintStyles(style, selfStyle);
    syncSelfLayerBox(style, selfStyle);
  }
  if (node.type === "Line2D") {
    html =
      assignLine2DStyles(style, selfAttributes, props, source, nodeOptions) ??
      html;
    syncSelfLayerBox(style, selfStyle);
  }
  if (node.type === "CPUParticles2D" || node.type === "GPUParticles2D") {
    html =
      assignParticle2DStyles(
        style,
        selfAttributes,
        props,
        source,
        nodeOptions,
        node.type,
        node.path,
      ) ?? html;
    syncSelfLayerBox(style, selfStyle);
  } else if (isPlaceholderNodeType(node.type)) {
    assignPlaceholder2DStyles(
      style,
      selfAttributes,
      props,
      source,
      nodeOptions,
      node.type,
    );
    syncSelfLayerBox(style, selfStyle);
  }
  if (node.type === "Range") {
    assignRangeStyles(selfStyle, selfAttributes, props);
  }
  if (isTextNodeType(node.type)) {
    assignTextStyles(
      selfStyle,
      selfAttributes,
      node,
      props,
      nodeOptions,
      fontFaces,
      scaleText,
    );
    assignTextAutoFitAttributes(attributes, node, nodeOptions);
    if (scaleText) {
      // Read by the runtime auto-fit pass so its font-size override also tracks
      // the text-scale var.
      attributes["data-godot-text-scale"] = "true";
    }
  }

  const text =
    node.type === "LineEdit" || node.type === "TextEdit"
      ? (textProp(props.text) ?? textProp(props.placeholder_text))
      : textProp(props.text);
  if (
    (node.type === "LineEdit" || node.type === "TextEdit") &&
    typeof props.placeholder_text === "string"
  ) {
    attributes["data-godot-placeholder"] = props.placeholder_text;
  }
  // Apply texture flips to the self-layer (after every type block has finished
  // assembling `selfStyle`) so a flipped TextureRect/Sprite mirrors only its own
  // texture, never its child nodes.
  assignSelfLayerFlip(selfStyle, props);
  assignShaderLoadingFallback(selfStyle, selfAttributes, node, nodeOptions);
  mirrorSelfMetadata(attributes, selfAttributes);
  return {
    path: node.path,
    name: node.name,
    type: node.type,
    parentPath,
    children: [],
    positioning,
    containerLayout: null,
    attributes,
    className: `godot-scene-node ${classPrefix}-type-${safeClassSegment(node.type)}`,
    style,
    selfAttributes,
    selfStyle,
    text,
    html:
      node.type === "RichTextLabel" &&
      text !== null &&
      asBoolean(props.bbcode_enabled) === true
        ? richTextLayeredHtml(text, {
            customTags: nodeOptions.bbcodeTags,
            resolveImage: (path) =>
              imageResource(
                normalizeResource(
                  nodeOptions.resolveResourcePath?.(path, source),
                ),
                nodeOptions,
                source,
              ),
            textScale: scaleText,
          })
        : html,
  };
}

function assignShaderLoadingFallback(
  selfStyle: Record<string, string>,
  selfAttributes: Record<string, string>,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): void {
  if (!options.enableWebglShaders) {
    return;
  }
  const fallback = options.shaderLoadingFallbacksByPath?.[node.path];
  if (
    !fallback ||
    typeof fallback.background !== "string" ||
    fallback.background === ""
  ) {
    return;
  }
  selfAttributes["data-godot-shader-loading-fallback"] = "1";
  selfAttributes["data-godot-shader-loading"] = "1";
  selfStyle.background = fallback.background;
  if (typeof fallback.clipPath === "string" && fallback.clipPath !== "") {
    selfStyle["clip-path"] = fallback.clipPath;
  }
  if (
    typeof fallback.borderRadius === "string" &&
    fallback.borderRadius !== ""
  ) {
    selfStyle["border-radius"] = fallback.borderRadius;
  }
}

function assignTextAutoFitAttributes(
  attributes: Record<string, string>,
  node: GodotSceneTreeNode,
  options: GodotHtmlRenderOptions,
): void {
  const directive = options.textAutoFitByPath?.[node.path];
  if (!directive) {
    return;
  }
  attributes["data-godot-text-auto-fit"] = "true";
  attributes["data-godot-text-auto-fit-min-font-size-px"] = String(
    directive.minFontSizePx,
  );
  attributes["data-godot-text-auto-fit-max-font-size-px"] = String(
    directive.maxFontSizePx,
  );
  if (directive.nominalFontSizePx !== undefined) {
    attributes["data-godot-text-auto-fit-nominal-font-size-px"] = String(
      directive.nominalFontSizePx,
    );
  }
  if (directive.nominalMetrics) {
    attributes["data-godot-text-auto-fit-nominal-metrics"] = JSON.stringify(
      directive.nominalMetrics,
    );
  }
  attributes["data-godot-text-auto-fit-width"] = String(directive.fitWidth);
  attributes["data-godot-text-auto-fit-height"] = String(directive.fitHeight);
  if (directive.wrapMode !== undefined) {
    attributes["data-godot-text-auto-fit-wrap-mode"] = directive.wrapMode;
  }
  if (directive.textOverrunBehavior !== undefined) {
    attributes["data-godot-text-auto-fit-overrun-behavior"] =
      directive.textOverrunBehavior;
  }
}

function mirrorSelfMetadata(
  attributes: Record<string, string>,
  selfAttributes: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(selfAttributes)) {
    if (name !== "data-godot-self-layer") {
      attributes[name] = value;
    }
  }
}

function syncSelfLayerBox(
  style: Record<string, string>,
  selfStyle: Record<string, string>,
): void {
  selfStyle.width = style.width;
  selfStyle.height = style.height;
}

function movePaintStyles(
  style: Record<string, string>,
  selfStyle: Record<string, string>,
): void {
  for (const property of [
    "background-image",
    "background-repeat",
    "background-size",
    "background-position",
    "image-rendering",
  ]) {
    const value = style[property];
    if (value !== undefined) {
      selfStyle[property] = value;
      delete style[property];
    }
  }
}

function isRenderableNode(node: { type: string }): boolean {
  return RENDERABLE_TYPES.has(node.type);
}

function isTextNodeType(type: string): boolean {
  return (
    type === "Label" ||
    type === "RichTextLabel" ||
    type === "LineEdit" ||
    type === "TextEdit" ||
    type === "Button"
  );
}

function isPlaceholderNodeType(type: string): boolean {
  return (
    type === "AnimationPlayer" ||
    type === "AudioStreamPlayer" ||
    type === "BackBufferCopy" ||
    type === "Camera2D" ||
    type === "Camera3D" ||
    type === "FmodBankLoader" ||
    type === "FmodListener2D" ||
    type === "GPUParticles3D" ||
    type === "LightOccluder2D" ||
    type === "Marker2D" ||
    type === "MeshInstance2D" ||
    type === "MeshInstance3D" ||
    type === "Node" ||
    type === "Node3D" ||
    type === "Path2D" ||
    type === "PathFollow2D" ||
    type === "SubViewport" ||
    type === "WorldEnvironment"
  );
}

function nearestRenderableParent(
  node: GodotSceneTreeNode,
  layout: GodotSceneTree,
  renderablePaths: Set<string>,
): string | null {
  const byPath = new Map(
    layout.nodes.map((candidate) => [candidate.path, candidate]),
  );
  let parentPath = node.parentPath;
  while (parentPath) {
    if (renderablePaths.has(parentPath)) {
      return parentPath;
    }
    parentPath = byPath.get(parentPath)?.parentPath ?? null;
  }
  return null;
}
