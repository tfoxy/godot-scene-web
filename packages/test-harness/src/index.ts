import type {
  GodotSceneTreeNode,
  GodotTextRunMetric,
} from "@godot-scene-web/layout";

export type LiveTreeNode = Partial<
  Omit<GodotSceneTreeNode, "path" | "rect" | "textRuns">
> &
  Pick<GodotSceneTreeNode, "path" | "rect"> & {
    textRuns?: TextRunMetric[];
  };

export interface DomTreeNode {
  path: string;
  name?: string;
  type?: string;
  parentPath?: string | null;
  visible?: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  textRuns?: TextRunMetric[];
}

export type TextRunMetric = GodotTextRunMetric;

export interface TreeComparisonOptions {
  tolerancePx?: number;
  compareVisibility?: boolean;
  compareType?: boolean;
  compareParent?: boolean;
  /**
   * How effectively-hidden live nodes (own `visible: false`, or any ancestor
   * hidden) relate to the DOM tree. `"compare"` (default) checks them like any
   * other node — the layout-tree oracle still computes rects for hidden nodes.
   * `"expect-absent"` asserts the renderer PRUNED them: a hidden live node
   * present in the DOM is a `hidden-node-rendered` mismatch, and an absent one
   * (with its whole subtree) is correct, skipping all other checks.
   */
  hiddenLiveNodes?: "compare" | "expect-absent";
}

export interface TreeComparisonResult {
  ok: boolean;
  mismatches: TreeMismatch[];
  imageDiff?: import("./image-diff-types").ImageDiffResult;
}

export interface TreeMismatch {
  code: string;
  path: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export function compareLiveTreeToDomTree(
  liveNodes: LiveTreeNode[],
  domNodes: DomTreeNode[],
  options: TreeComparisonOptions = {},
): TreeComparisonResult {
  const tolerance = options.tolerancePx ?? 0.5;
  const domByPath = new Map(domNodes.map((node) => [node.path, node]));
  const liveByPath = new Map(liveNodes.map((node) => [node.path, node]));
  const mismatches: TreeMismatch[] = [];
  const effectivelyVisible =
    options.hiddenLiveNodes === "expect-absent"
      ? effectiveVisibilityByPath(liveByPath)
      : undefined;

  for (const live of liveNodes) {
    const dom = domByPath.get(live.path);
    if (effectivelyVisible && effectivelyVisible.get(live.path) === false) {
      // The renderer prunes effectively-hidden subtrees to a comment, so the
      // node (and every descendant, hidden by the same walk) must be absent.
      if (dom) {
        mismatches.push({
          code: "hidden-node-rendered",
          path: live.path,
          message:
            "Effectively hidden Godot node must not render a DOM element.",
          actual: dom.rect,
        });
      }
      continue;
    }
    if (!dom) {
      mismatches.push({
        code: "missing-dom-node",
        path: live.path,
        message: "Live Godot node does not have a matching DOM node.",
      });
      continue;
    }
    if (
      options.compareType !== false &&
      live.type &&
      dom.type &&
      live.type !== dom.type
    ) {
      mismatches.push({
        code: "type-mismatch",
        path: live.path,
        message: "Node type differs.",
        expected: live.type,
        actual: dom.type,
      });
    }
    if (
      options.compareParent !== false &&
      (live.parentPath ?? null) !== (dom.parentPath ?? null)
    ) {
      mismatches.push({
        code: "parent-mismatch",
        path: live.path,
        message: "Parent path differs.",
        expected: live.parentPath ?? null,
        actual: dom.parentPath ?? null,
      });
    }
    if (
      options.compareVisibility !== false &&
      live.visible !== undefined &&
      dom.visible !== undefined &&
      live.visible !== dom.visible
    ) {
      mismatches.push({
        code: "visibility-mismatch",
        path: live.path,
        message: "Visibility differs.",
        expected: live.visible,
        actual: dom.visible,
      });
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      const expected = live.rect[key];
      const actual = dom.rect[key];
      if (Math.abs(expected - actual) > tolerance) {
        mismatches.push({
          code: `rect-${key}-mismatch`,
          path: live.path,
          message: `Rect ${key} differs by more than ${tolerance}px.`,
          expected,
          actual,
        });
      }
    }
    compareTextRuns(live, dom, tolerance, mismatches);
  }

  for (const dom of domNodes) {
    if (!liveByPath.has(dom.path)) {
      mismatches.push({
        code: "extra-dom-node",
        path: dom.path,
        message: "DOM node does not have a matching live Godot node.",
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

// Effective visibility over the LIVE tree: a node is effectively hidden when its
// own `visible` is false or any ancestor's is (Godot hides the whole subtree).
// Live nodes carry OWN visibility; missing `visible`/`parentPath` (or a dangling
// parent path) default to visible, matching the renderer's derivation.
function effectiveVisibilityByPath(
  liveByPath: Map<string, LiveTreeNode>,
): Map<string, boolean> {
  const effective = new Map<string, boolean>();
  const resolve = (path: string): boolean => {
    const cached = effective.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const node = liveByPath.get(path);
    const parentPath = node?.parentPath ?? null;
    const visible =
      (node?.visible ?? true) && (parentPath ? resolve(parentPath) : true);
    effective.set(path, visible);
    return visible;
  };
  for (const path of liveByPath.keys()) {
    resolve(path);
  }
  return effective;
}

function compareTextRuns(
  live: LiveTreeNode,
  dom: DomTreeNode,
  tolerance: number,
  mismatches: TreeMismatch[],
): void {
  const liveRuns = live.textRuns ?? [];
  const domRuns = dom.textRuns ?? [];
  if (liveRuns.length === 0 && domRuns.length === 0) {
    return;
  }
  if (liveRuns.length !== domRuns.length) {
    mismatches.push({
      code: "text-run-count-mismatch",
      path: live.path,
      message: "Rendered text run count differs.",
      expected: liveRuns.length,
      actual: domRuns.length,
    });
    return;
  }
  for (let index = 0; index < liveRuns.length; index += 1) {
    const expectedRun = liveRuns[index];
    const actualRun = domRuns[index];
    if (!expectedRun || !actualRun) {
      continue;
    }
    if (
      expectedRun.text !== actualRun.text ||
      (expectedRun.style ?? "") !== (actualRun.style ?? "")
    ) {
      mismatches.push({
        code: "text-run-mismatch",
        path: live.path,
        message: `Rendered text run ${index} differs.`,
        expected: { text: expectedRun.text, style: expectedRun.style ?? "" },
        actual: { text: actualRun.text, style: actualRun.style ?? "" },
      });
      continue;
    }
    const comparedKeys =
      expectedRun.text.includes("\n") || actualRun.text.includes("\n")
        ? (["width", "height"] as const)
        : (["x", "y", "width", "height"] as const);
    for (const key of comparedKeys) {
      const expected = expectedRun.rect[key];
      const actual = actualRun.rect[key];
      if (Math.abs(expected - actual) > tolerance) {
        mismatches.push({
          code: `text-run-${key}-mismatch`,
          path: live.path,
          message: `Rendered text run ${index} ${key} differs by more than ${tolerance}px.`,
          expected: {
            text: expectedRun.text,
            style: expectedRun.style ?? "",
            value: expected,
          },
          actual: {
            text: actualRun.text,
            style: actualRun.style ?? "",
            value: actual,
          },
        });
      }
    }
  }
}
