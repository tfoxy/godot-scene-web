import type { RenderElement } from "./render-tree";

// Identity stabilization for successive `RenderElement` fragments.
//
// The model pipeline rebuilds the whole element tree on every change, so even a
// one-node update hands a renderer all-new objects — an incremental target (the
// Vue view's vnode cache) then has nothing to key reuse on. `stabilizeRenderElements`
// walks the fresh fragment against the previous one and, wherever an element's
// rendered content (tag/class/key/text/rawHtml/attributes/style) AND its entire
// child subtree are unchanged, swaps the fresh object for the PREVIOUS one. After
// the pass, `element === previousElement` ⟺ "nothing in this subtree changed",
// which a renderer can use as a perfect memoization key. Unchanged subtrees keep
// identity through arbitrarily many generations.
//
// `sourceNode` is deliberately EXCLUDED from the comparison: the model rebuild
// churns its identity every cycle while the rendered output ignores it. The one
// consumer of `sourceNode` (the Vue `#node` slot) must therefore not combine the
// slot with stabilization-keyed caching — the Vue view disables its cache when
// that slot is present.
export function stabilizeRenderElements(
  previous: RenderElement[] | undefined,
  next: RenderElement[],
): RenderElement[] {
  if (!previous) {
    return next;
  }
  return stabilizeChildren(previous, next);
}

function stabilizeChildren(
  previous: RenderElement[],
  next: RenderElement[],
): RenderElement[] {
  // Index-aligned fast path with a lazy key map for inserted/reordered keyed
  // elements (node elements are keyed by scene path).
  let byKey: Map<string, RenderElement> | undefined;
  return next.map((child, index) => {
    const indexMatch = previous[index];
    if (indexMatch && isSameElementType(indexMatch, child)) {
      return stabilizeElement(indexMatch, child);
    }
    if (child.key !== undefined) {
      byKey ??= keyMap(previous);
      const keyMatch = byKey.get(child.key);
      if (keyMatch && keyMatch.tag === child.tag) {
        return stabilizeElement(keyMatch, child);
      }
    }
    return child;
  });
}

function keyMap(elements: RenderElement[]): Map<string, RenderElement> {
  const map = new Map<string, RenderElement>();
  for (const element of elements) {
    if (element.key !== undefined && !map.has(element.key)) {
      map.set(element.key, element);
    }
  }
  return map;
}

// Mirrors vnode reconciliation: same position is only a candidate match when tag
// and key agree (a key change means a different node landed here).
function isSameElementType(a: RenderElement, b: RenderElement): boolean {
  return a.tag === b.tag && a.key === b.key;
}

function stabilizeElement(
  previous: RenderElement,
  next: RenderElement,
): RenderElement {
  // Identity fast-path: when an upstream cross-render memo (the model build) already handed
  // back the SAME element object, the whole subtree is unchanged — skip the recursive deep
  // compare entirely. Harmless no-op until that memo exists (the references never match
  // today); collapses the per-render deep-compare once node identity flows through.
  if (previous === next) {
    return previous;
  }
  let childrenStable: boolean;
  if (next.children) {
    const stabilized = stabilizeChildren(
      previous.children ?? [],
      next.children,
    );
    // Fresh elements are throwaway per build; rewriting children in place keeps
    // the stabilized subtree without re-allocating the element.
    next.children = stabilized;
    childrenStable =
      previous.children !== undefined &&
      previous.children.length === stabilized.length &&
      stabilized.every((child, index) => child === previous.children?.[index]);
  } else {
    childrenStable = previous.children === undefined;
  }
  if (
    childrenStable &&
    previous.tag === next.tag &&
    previous.className === next.className &&
    previous.key === next.key &&
    previous.text === next.text &&
    previous.rawHtml === next.rawHtml &&
    recordsEqual(previous.attributes, next.attributes) &&
    recordsEqual(previous.style, next.style)
  ) {
    return previous;
  }
  return next;
}

function recordsEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    // Treat absent and empty as the same rendered output.
    return Object.keys(a ?? b ?? {}).length === 0;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}
