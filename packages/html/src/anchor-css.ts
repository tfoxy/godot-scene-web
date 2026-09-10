import { round } from "./css-values";

/**
 * Pure CSS Anchor Positioning string-building helpers. Shared by any anchor-name emitter in
 * this package — the offline `browser-anchors.ts` model builder, and consumers outside this
 * package (e.g. spirectl's hover-tip materializer) that emit CSS anchor properties directly
 * onto their own node/style records without going through the offline HTML-model pipeline at
 * all. Kept dependency-free (no `GodotHtmlNode`/model types) so it can be imported from either
 * side without pulling in this package's whole model.
 */

/** Merge `name` into an existing `anchor-name` value (comma-separated), or start a fresh one. */
export function appendAnchorName(existing: string | undefined, name: string): string {
  if (existing === undefined) return name;
  return existing.split(",").some((entry) => entry.trim() === name) ? existing : `${existing}, ${name}`;
}

/**
 * Build an inset value (for `top`/`right`/`bottom`/`left`) that anchors to one or more named
 * targets: `anchor(name side)`, `min()`/`max()` over several candidates, optionally wrapped in
 * `calc(... ± Npx)` for a nonzero offset. `combine` only matters when `targetNames.length > 1`.
 */
export function anchorInsetExpression(
  side: string,
  targetNames: string[],
  combine: "min" | "max",
  offset: number,
): string {
  const anchorOf = (name: string): string => `anchor(${name} ${side})`;
  const base =
    targetNames.length === 0
      ? anchorOf("")
      : targetNames.length === 1
        ? anchorOf(targetNames[0] as string)
        : `${combine}(${targetNames.map(anchorOf).join(", ")})`;
  if (offset === 0) {
    // anchor() is valid as the entire value of an inset property; a bare function is fine.
    return base;
  }
  const magnitude = `${round(Math.abs(offset))}px`;
  return offset < 0 ? `calc(${base} - ${magnitude})` : `calc(${base} + ${magnitude})`;
}

/**
 * A `position-try-fallbacks` value for the common "flip to the opposite side when the planned
 * placement would overflow the viewport" case. `flip-inline` flips the inline-axis insets
 * (left/right) and reproduces a manual "flush to the owner's opposite edge" overflow-flip
 * exactly (verified against a real Chromium/Firefox render: a right-anchored box positioned
 * near the viewport's right edge flips so its own right edge sits flush at the owner's left
 * edge — the same target a hand-written overflow-flip computes). `flip-block` is the same for
 * the block axis (top/bottom).
 */
export function positionTryFallback(...kinds: Array<"flip-inline" | "flip-block" | "flip-start">): string {
  return kinds.join(", ");
}
