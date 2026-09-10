import type { GodotRect } from "./types";

export interface FlowEntry<T> {
  item: T;
  size: { width: number; height: number };
}

export interface PlacedFlowEntry<T> extends FlowEntry<T> {
  x: number;
  y: number;
}

/**
 * Wraps flow-container entries into lines, mirroring Godot's
 * `FlowContainer::_resort()` wrapping. The cross axis advances by the line's
 * largest cross extent plus the relevant separation.
 */
export function flowWrapLines<T>(
  rect: GodotRect,
  entries: FlowEntry<T>[],
  vertical: boolean,
  hSeparation: number,
  vSeparation: number,
): PlacedFlowEntry<T>[][] {
  const lines: PlacedFlowEntry<T>[][] = [];
  let currentLine: PlacedFlowEntry<T>[] = [];
  let cursorX = rect.x;
  let cursorY = rect.y;
  let lineCrossSize = 0;
  for (const entry of entries) {
    const size = entry.size;
    if (vertical) {
      if (cursorY > rect.y && cursorY + size.height > rect.y + rect.height) {
        lines.push(currentLine);
        currentLine = [];
        cursorX += lineCrossSize + hSeparation;
        cursorY = rect.y;
        lineCrossSize = 0;
      }
      currentLine.push({ ...entry, x: cursorX, y: cursorY });
      cursorY += size.height + vSeparation;
      lineCrossSize = Math.max(lineCrossSize, size.width);
    } else {
      if (cursorX > rect.x && cursorX + size.width > rect.x + rect.width) {
        lines.push(currentLine);
        currentLine = [];
        cursorX = rect.x;
        cursorY += lineCrossSize + vSeparation;
        lineCrossSize = 0;
      }
      currentLine.push({ ...entry, x: cursorX, y: cursorY });
      cursorX += size.width + hSeparation;
      lineCrossSize = Math.max(lineCrossSize, size.height);
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  return lines;
}

/** Total cross-axis extent of wrapped lines: Σ line cross size + separations. */
export function flowCrossExtent<T>(
  lines: PlacedFlowEntry<T>[][],
  vertical: boolean,
  hSeparation: number,
  vSeparation: number,
): number {
  const crossSeparation = vertical ? hSeparation : vSeparation;
  const lineCrossSizes = lines.map((line) =>
    line.reduce(
      (max, entry) =>
        Math.max(max, vertical ? entry.size.width : entry.size.height),
      0,
    ),
  );
  return (
    lineCrossSizes.reduce((sum, size) => sum + size, 0) +
    Math.max(0, lines.length - 1) * crossSeparation
  );
}
