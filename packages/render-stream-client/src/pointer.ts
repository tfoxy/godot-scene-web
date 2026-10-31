// INP1 (client-extensions-design.md "As built (INP1)"): where the stream's picture sits on the page,
// and the points that cross between the page (client CSS px) and the presentation (the host
// window's px, which is what the game's input takes). Pure functions over a box description, so
// they are testable without a DOM; `client.ts` reads the canvas on demand, never per frame.
//
// The backing store is the presentation 1:1 (mirror-client-design.md, D12), and the product sizes
// the canvas's CSS box. A box of another aspect shows the picture by the canvas's `object-fit`
// (`fill` stretches, `contain` letterboxes, `cover` crops, `none`, `scale-down`) at its
// `object-position`; the bars (or the crop) map to null.

import type { Point, Rect } from "./extensions";

export type ObjectFit = "fill" | "contain" | "cover" | "none" | "scale-down";

/** One axis of `object-position`: a fraction of the free space, or px from the box's start. */
export type PositionAxis = { fraction: number } | { px: number };

/** Where the canvas draws on the page. */
export interface PictureLayout {
  /** The canvas's content box in client CSS px (clipping: the picture shows only inside it). */
  readonly box: Rect;
  readonly fit: ObjectFit;
  readonly position: readonly [PositionAxis, PositionAxis];
  /** The backing store, in canvas px (the picture's natural size). */
  readonly backing: readonly [number, number];
  /** The session's presentation size: the host window's px. */
  readonly presentation: readonly [number, number];
}

const CENTRE: PositionAxis = { fraction: 0.5 };

/** The rect the picture occupies in client CSS px (it may exceed `box` under `cover`). */
export function pictureRect(l: PictureLayout): Rect {
  const { box } = l;
  const [bw, bh] = l.backing;
  let w = box.w;
  let h = box.h;
  const contain = Math.min(box.w / bw, box.h / bh);
  const cover = Math.max(box.w / bw, box.h / bh);
  switch (l.fit) {
    case "contain":
      w = bw * contain;
      h = bh * contain;
      break;
    case "cover":
      w = bw * cover;
      h = bh * cover;
      break;
    case "none":
      w = bw;
      h = bh;
      break;
    case "scale-down": {
      const s = Math.min(1, contain);
      w = bw * s;
      h = bh * s;
      break;
    }
    default:
      break;
  }
  const at = (a: PositionAxis, start: number, free: number) =>
    start + ("fraction" in a ? free * a.fraction : a.px);
  return {
    x: at(l.position[0], box.x, box.w - w),
    y: at(l.position[1], box.y, box.h - h),
    w,
    h,
  };
}

/** A client point on the picture, in presentation px; null on a bar, outside the box, or when
 * the layout has no area. */
export function clientToPresentation(
  l: PictureLayout,
  clientX: number,
  clientY: number,
): Point | null {
  const p = pictureRect(l);
  const b = l.box;
  if (!(p.w > 0 && p.h > 0)) return null;
  if (
    clientX < b.x ||
    clientY < b.y ||
    clientX >= b.x + b.w ||
    clientY >= b.y + b.h
  )
    return null;
  const u = (clientX - p.x) / p.w;
  const v = (clientY - p.y) / p.h;
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return null;
  return { x: u * l.presentation[0], y: v * l.presentation[1] };
}

/** A presentation-space rect on the page, in client CSS px (a DOM overlay anchored to an item;
 * subtract the canvas's `getBoundingClientRect()` for canvas-local px). */
export function presentationToClient(l: PictureLayout, r: Rect): Rect {
  const p = pictureRect(l);
  const sx = p.w / l.presentation[0];
  const sy = p.h / l.presentation[1];
  return { x: p.x + r.x * sx, y: p.y + r.y * sy, w: r.w * sx, h: r.h * sy };
}

const KEYWORD: Record<string, number> = {
  left: 0,
  top: 0,
  center: 0.5,
  right: 1,
  bottom: 1,
};

function axis(token: string | undefined): PositionAxis {
  if (token === undefined) return CENTRE;
  const k = KEYWORD[token];
  if (k !== undefined) return { fraction: k };
  const n = Number.parseFloat(token);
  if (!Number.isFinite(n)) return CENTRE;
  return token.endsWith("%") ? { fraction: n / 100 } : { px: n };
}

/** `object-position`'s computed value ("50% 50%", "left top", "10px 20px"): two axes. */
export function parseObjectPosition(
  value: string,
): readonly [PositionAxis, PositionAxis] {
  const t = value.trim().split(/\s+/);
  // A lone keyword names one axis and centres the other.
  if (t.length === 1) {
    const vertical = t[0] === "top" || t[0] === "bottom";
    return vertical ? [CENTRE, axis(t[0])] : [axis(t[0]), CENTRE];
  }
  // "top left" is accepted in either order.
  if (
    (t[0] === "top" || t[0] === "bottom") &&
    (t[1] === "left" || t[1] === "right")
  )
    return [axis(t[1]), axis(t[0])];
  return [axis(t[0]), axis(t[1])];
}

export function parseObjectFit(value: string): ObjectFit {
  return value === "contain" ||
    value === "cover" ||
    value === "none" ||
    value === "scale-down"
    ? value
    : "fill";
}

/** The canvas's picture layout now (a layout read: call from an event handler, not per frame). */
export function readLayout(
  canvas: HTMLCanvasElement,
  presentation: readonly [number, number] | null,
): PictureLayout {
  const r = canvas.getBoundingClientRect();
  const cs = getComputedStyle(canvas);
  // CSS transforms scale the rect against the element's own layout size.
  const sx = canvas.offsetWidth > 0 ? r.width / canvas.offsetWidth : 1;
  const sy = canvas.offsetHeight > 0 ? r.height / canvas.offsetHeight : 1;
  const pl = Number.parseFloat(cs.paddingLeft) || 0;
  const pt = Number.parseFloat(cs.paddingTop) || 0;
  const pr = Number.parseFloat(cs.paddingRight) || 0;
  const pb = Number.parseFloat(cs.paddingBottom) || 0;
  const box: Rect = {
    x: r.left + (canvas.clientLeft + pl) * sx,
    y: r.top + (canvas.clientTop + pt) * sy,
    w: Math.max(0, canvas.clientWidth - pl - pr) * sx,
    h: Math.max(0, canvas.clientHeight - pt - pb) * sy,
  };
  const backing: [number, number] = [canvas.width, canvas.height];
  return {
    box,
    fit: parseObjectFit(cs.objectFit),
    position: parseObjectPosition(cs.objectPosition),
    backing,
    presentation: presentation ?? backing,
  };
}
