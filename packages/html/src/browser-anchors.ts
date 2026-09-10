import {
  type GodotAnchorHorizontalEdge,
  type GodotAnchorMap,
  type GodotAnchorVerticalEdge,
  type GodotSceneTreeDiagnostic,
  type GodotSceneTreeNode,
  parseAnchorEdge,
} from "@godot-scene-web/layout";
import {
  anchorInsetExpression,
  appendAnchorName as mergeAnchorName,
} from "./anchor-css";
import type { GodotHtmlNode } from "./types";

/**
 * Browser-native counterpart of the computed pipeline's `resolveAnchors`:
 * instead of translating rects after a layout cascade, it emits native CSS
 * Anchor Positioning (`anchor-name` + `anchor()` inset functions) so the
 * BROWSER keeps the anchored node glued to its target's rendered geometry —
 * including `content*` edges, which become `min()`/`max()` over the target's
 * visible children's anchors (e.g. "below however many relic rows exist").
 * Geometry then tracks wrap/resize/scale with no JavaScript; the expressions
 * are regenerated with every model rebuild, which is also when the child list
 * can change. Browsers without anchor-positioning support drop the
 * declarations and keep the node's static scene position.
 *
 * Spec constraint honored here: an absolutely-positioned anchor that occurs
 * LATER in tree order than the positioned element is "not acceptable" (CSS
 * Anchor Positioning §target anchor element), and so is anything inside it.
 * When target and positioned node are siblings, the positioned node is moved
 * directly after its target in the parent's child order. DOM order is paint
 * order in this model, but the only pairwise order that changes is
 * target↔positioned — and a successfully anchored node no longer overlaps its
 * target by construction.
 */
export function applyBrowserAnchorPositioning(
  byPath: Map<string, GodotHtmlNode>,
  layoutByPath: Map<string, GodotSceneTreeNode>,
  anchors: GodotAnchorMap,
  diagnostics: GodotSceneTreeDiagnostic[],
): void {
  const namesByTarget = new Map<string, string>();
  const anchorName = (targetPath: string): string => {
    let name = namesByTarget.get(targetPath);
    if (name === undefined) {
      name = `--gswa${namesByTarget.size}`;
      namesByTarget.set(targetPath, name);
    }
    return name;
  };

  for (const [selfPath, anchor] of Object.entries(anchors)) {
    const self = byPath.get(selfPath);
    if (!self || self.kind === "hidden-placeholder") {
      // Matches resolveAnchors: a declared-but-unrendered self is skipped
      // silently — an effectively-hidden node renders as a comment, so there
      // is no box to position.
      continue;
    }
    const target = byPath.get(anchor.anchorTo);
    if (!target) {
      diagnostics.push({
        severity: "warning",
        code: "anchor-target-missing",
        message: `Anchor target '${anchor.anchorTo}' not found for ${selfPath}.`,
        nodePath: selfPath,
      });
      continue;
    }
    const from = parseAnchorEdge(anchor.from);
    const to = parseAnchorEdge(anchor.to);
    if (!from || !to) {
      diagnostics.push({
        severity: "warning",
        code: "anchor-edge-unparsed",
        message: `Unrecognized anchor edge (from='${anchor.from}', to='${anchor.to}') for ${selfPath}.`,
        nodePath: selfPath,
      });
      continue;
    }
    if (
      to.vertical.startsWith("content") ||
      to.horizontal.startsWith("content") ||
      to.vertical === "vcenter" ||
      to.horizontal === "hcenter"
    ) {
      // `to` decides WHICH inset property is written; only the node's own box
      // corners map onto CSS insets. (Centering would need anchor-center
      // alignment — add when a consumer declares it.)
      diagnostics.push({
        severity: "warning",
        code: "anchor-edge-unsupported",
        message: `Browser anchor positioning only supports corner 'to' edges, got '${anchor.to}' for ${selfPath}.`,
        nodePath: selfPath,
      });
      continue;
    }
    if (self.positioning === "container-managed") {
      // A flow item can't be yanked to an absolute position without reflowing
      // its siblings — computed mode translates it, but that has no faithful
      // CSS counterpart here.
      diagnostics.push({
        severity: "warning",
        code: "anchor-order-unresolvable",
        message: `Anchored node ${selfPath} is container-managed; browser anchor positioning needs an absolutely positioned node.`,
        nodePath: selfPath,
      });
      continue;
    }

    ensureTargetPrecedesSelf(self, target, byPath);

    const name = anchorName(anchor.anchorTo);
    appendAnchorName(target, name);
    const needsContent =
      from.vertical.startsWith("content") ||
      from.horizontal.startsWith("content");
    const childNames: string[] = [];
    if (needsContent) {
      let index = 0;
      for (const childPath of target.children) {
        const child = byPath.get(childPath);
        if (!child || layoutByPath.get(childPath)?.visible === false) {
          continue;
        }
        const childName = `${name}c${index}`;
        appendAnchorName(child, childName);
        childNames.push(childName);
        index += 1;
      }
    }

    const targetNames = childNames.length > 0 ? childNames : [name];
    const offsetX = anchor.offset?.x ?? 0;
    const offsetY = anchor.offset?.y ?? 0;
    const vertical = anchorInsetExpression(
      verticalSide(from.vertical, childNames.length > 0),
      targetNames,
      from.vertical === "contentBottom" ? "max" : "min",
      // `bottom:` insets grow upward, so a downward catalog offset negates.
      to.vertical === "bottom" ? -offsetY : offsetY,
    );
    const horizontal = anchorInsetExpression(
      horizontalSide(from.horizontal, childNames.length > 0),
      targetNames,
      from.horizontal === "contentRight" ? "max" : "min",
      to.horizontal === "right" ? -offsetX : offsetX,
    );

    // Writing one inset of an axis releases the other so the box keeps its
    // content/min size instead of stretching between old and new insets.
    delete self.style.top;
    delete self.style.bottom;
    delete self.style.left;
    delete self.style.right;
    self.style[to.vertical === "bottom" ? "bottom" : "top"] = vertical;
    self.style[to.horizontal === "right" ? "right" : "left"] = horizontal;
    self.style.position = "absolute";
    self.positioning = "absolute";
    self.attributes["data-godot-positioning"] = "absolute";
  }
}

function appendAnchorName(node: GodotHtmlNode, name: string): void {
  node.style["anchor-name"] = mergeAnchorName(node.style["anchor-name"], name);
}

// The anchor() side queried on the target (or its children) for a given edge
// token. Zero-content fallback matches resolveAnchors' zero-size box at the
// node's own origin: content edges collapse to the target's top/left.
function verticalSide(
  edge: GodotAnchorVerticalEdge,
  hasContent: boolean,
): "top" | "bottom" | "center" {
  switch (edge) {
    case "bottom":
      return "bottom";
    case "vcenter":
      return "center";
    case "contentBottom":
      return hasContent ? "bottom" : "top";
    default:
      return "top";
  }
}

function horizontalSide(
  edge: GodotAnchorHorizontalEdge,
  hasContent: boolean,
): "left" | "right" | "center" {
  switch (edge) {
    case "right":
      return "right";
    case "hcenter":
      return "center";
    case "contentRight":
      return hasContent ? "right" : "left";
    default:
      return "left";
  }
}

// CSS Anchor Positioning's acceptability rule: an abs-pos anchor LATER in tree
// order than the positioned element never resolves. When both are siblings,
// move the positioned node directly after its target. Cross-parent late
// targets are left alone (the declarations then no-op, keeping the static
// position) — no real consumer has that shape.
function ensureTargetPrecedesSelf(
  self: GodotHtmlNode,
  target: GodotHtmlNode,
  byPath: Map<string, GodotHtmlNode>,
): void {
  if (self.parentPath === null || self.parentPath !== target.parentPath) {
    return;
  }
  const parent = byPath.get(self.parentPath);
  if (!parent) {
    return;
  }
  const selfIndex = parent.children.indexOf(self.path);
  const targetIndex = parent.children.indexOf(target.path);
  if (selfIndex === -1 || targetIndex === -1 || selfIndex > targetIndex) {
    return;
  }
  parent.children.splice(selfIndex, 1);
  // Recompute the target's slot after the removal shifted indices.
  parent.children.splice(
    parent.children.indexOf(target.path) + 1,
    0,
    self.path,
  );
}
