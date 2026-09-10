import type { GodotRect } from "./types";
export interface GodotNodeAnchor {
  anchorTo: string;
  from: string;
  to: string;
  offset?: { x?: number; y?: number };
}
export type GodotAnchorMap = Record<string, GodotNodeAnchor>;
export type GodotAnchorVerticalEdge =
  | "top"
  | "bottom"
  | "vcenter"
  | "contentTop"
  | "contentBottom";
export type GodotAnchorHorizontalEdge =
  | "left"
  | "right"
  | "hcenter"
  | "contentLeft"
  | "contentRight";
export interface GodotAnchorEdge {
  vertical: GodotAnchorVerticalEdge;
  horizontal: GodotAnchorHorizontalEdge;
}
const verticals: Array<[string, GodotAnchorVerticalEdge]> = [
  ["contentbottom", "contentBottom"],
  ["contenttop", "contentTop"],
  ["vcenter", "vcenter"],
  ["bottom", "bottom"],
  ["top", "top"],
];
const horizontals: Record<string, GodotAnchorHorizontalEdge> = {
  contentright: "contentRight",
  contentleft: "contentLeft",
  hcenter: "hcenter",
  right: "right",
  left: "left",
};
export function parseAnchorEdge(token: string): GodotAnchorEdge | undefined {
  const normalized = token.toLowerCase();
  if (normalized === "center")
    return { vertical: "vcenter", horizontal: "hcenter" };
  for (const [key, vertical] of verticals) {
    if (!normalized.startsWith(key)) continue;
    const horizontal = horizontals[normalized.slice(key.length)];
    if (horizontal) return { vertical, horizontal };
  }
  return undefined;
}
export function anchorEdgePoint(
  token: string,
  own: GodotRect,
  content: GodotRect,
): { x: number; y: number } | undefined {
  const edge = parseAnchorEdge(token);
  if (!edge) return undefined;
  const x =
    edge.horizontal === "contentRight"
      ? content.x + content.width
      : edge.horizontal === "contentLeft"
        ? content.x
        : edge.horizontal === "hcenter"
          ? own.x + own.width / 2
          : edge.horizontal === "right"
            ? own.x + own.width
            : own.x;
  const y =
    edge.vertical === "contentBottom"
      ? content.y + content.height
      : edge.vertical === "contentTop"
        ? content.y
        : edge.vertical === "vcenter"
          ? own.y + own.height / 2
          : edge.vertical === "bottom"
            ? own.y + own.height
            : own.y;
  return { x, y };
}
