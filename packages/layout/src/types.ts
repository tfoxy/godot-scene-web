import type {
  GodotNode,
  GodotRect,
  GodotResourceRefValue,
  GodotVariant,
} from "@godot-scene-web/core";
import type {
  GodotResourceStatus,
  GodotSceneNodeBase,
} from "@godot-scene-web/scene-graph";
import type { GodotAnchorMap } from "./anchor-grammar";

export type { GodotTextRunMetric } from "@godot-scene-web/scene-graph";
export type { GodotAnchorMap, GodotNodeAnchor } from "./anchor-grammar";
export type { GodotRect };
export interface GodotSceneTreeNode extends GodotSceneNodeBase {
  rect: GodotRect;
  /**
   * The on-screen global rect with the node's own `scale` applied around
   * `pivotOffset` (mirroring the CSS `transform: scale()` the HTML renderer
   * emits). `rect` stays pre-scale because child layout is computed in the
   * parent's unscaled local space; consumers that need the rendered geometry
   * (e.g. a layout-diff against the live game's `get_global_rect()`, which
   * includes scale) should read `renderedRect`.
   */
  renderedRect: GodotRect;
  /**
   * The cumulative scale+rotation+translate transform this node applies to its
   * descendants (its own scale-and-rotation-about-pivot composed with its
   * ancestors'), in global unscaled-layout space. Internal to layout: children read
   * it to bake every ancestor's transform into their own `renderedRect`. Stored as a
   * 2×3 affine `{ a, b, c, d, tx, ty }` (a pure scale+translate is `b=c=0`).
   */
  cumulativeTransform?: {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
  };
}
export interface GodotSceneTreeDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  nodePath?: string;
}
export interface GodotSceneTree {
  viewport: GodotRect;
  nodes: GodotSceneTreeNode[];
  diagnostics: GodotSceneTreeDiagnostic[];
  resourceStatuses: GodotResourceStatus[];
}
export type GodotLayoutModel = GodotSceneTree;
export type GodotLayoutNode = GodotSceneTreeNode;
export type GodotLayoutDiagnostic = GodotSceneTreeDiagnostic;

/**
 * Options for the computed rect engine. The structural fields (node inclusion,
 * prop/type/instance overrides, repeated-node expansion, external-scene mounting)
 * are inherited from {@link SceneStructureOptions} — they are consumed upstream by
 * `deriveSceneGraph`; the rect engine receives the already-indexed
 * {@link import("@godot-scene-web/core").SceneGraph} and only adds the
 * rect-/resource-specific fields below.
 */
export interface GodotLayoutOptions {
  viewport?: Partial<GodotRect>;
  resolveResource?: (ref: GodotResourceRefValue, node: GodotNode) => unknown;
  /**
   * Content-driven minimum size for a text node (`Label`/`RichTextLabel`), in
   * logical px — the text analogue of {@link resolveResource} for `TextureRect`.
   * The host measures the label's paragraph box from the actual font it paints
   * with (same font + size + glyph spacing), so a label with no explicit width
   * grows to fit its text the way Godot's `Label::get_minimum_size()` does.
   * Return `undefined` when no measurement is available (preserves the prior
   * behavior of collapsing to the explicit/custom size or 0).
   *
   * `availableWidth` is the laid-out column width when known (the layout pass for
   * a node already placed in its container); the host uses it to word-wrap a
   * reflowing label so its height matches the wrapped paragraph. It is omitted
   * during the bottom-up minimum pass (no width assigned yet) — a wrapping label
   * should then report a width that does not force its container wider.
   */
  resolveTextContentSize?: (
    node: GodotNode,
    path: string,
    props: Record<string, GodotVariant>,
    availableWidth?: number,
  ) => { width: number; height: number } | undefined;
  resolveTheme?: (node: GodotNode, name: string) => GodotVariant | undefined;
  /**
   * Declarative post-layout anchors, keyed by the anchored node's engine path.
   * Resolved after flow layout converges so a node can be placed relative to
   * another node's rendered (or content) edge. See {@link GodotAnchorMap}.
   */
  anchorsByPath?: GodotAnchorMap;
}

export interface IndexedNode {
  node: GodotNode;
  path: string;
  parentPath: string | null;
  children: string[];
  props: Record<string, GodotVariant>;
  order: number;
  /**
   * Memoized container `get_minimum_size()` result for this node, scoped to a
   * single `resolveGodotSceneTree` call. `undefined` = not yet computed,
   * `null` = computed and the node is not a content-sizing container.
   */
  minimumSize?: { width: number; height: number } | null;
  /**
   * For a flow container, its resolved main-axis extent (width for horizontal,
   * height for vertical) from the previous layout pass. Fed back into
   * `flowMinimum` so the iterative fixpoint converges to the wrapped layout the
   * way Godot's `cached_size` does across frames. `undefined` = no feedback yet.
   */
  flowMainExtent?: number;
}

export interface IndexedScene {
  nodes: IndexedNode[];
  resourceStatuses: GodotResourceStatus[];
}
