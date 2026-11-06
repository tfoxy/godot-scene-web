// DOM client px -> host root-window px for a picture drawn with CSS `object-fit` (docs/input.md
// "Pointer", "Coordinate space"). DOM-free: the box is any `{left, top, width, height}` (a
// `DOMRect` fits), read live when given as a function so a resize needs no new mapper.
//
// A render-stream consumer passes its client's own mapping (`cssToPresentation`, or
// `clientToGame(..)?.point` to honour hit-override inverses) instead; this is for everyone else:
// a `<canvas>` or `<video>` whose picture is letterboxed or cropped inside its element.

/** Where `map` puts a client point: host root-window px. */
export interface PointerPoint {
  x: number;
  y: number;
}

/** A client-space rectangle (`Element.getBoundingClientRect()` returns one). */
export interface PointerBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The picture's own size: the host root window, in host px. */
export interface PointerPresentationSize {
  width: number;
  height: number;
}

/** CSS `object-fit`. */
export type PointerObjectFit =
  | "contain"
  | "cover"
  | "fill"
  | "none"
  | "scale-down";

/**
 * CSS `object-position` as fractions of the free space: `{x: 0.5, y: 0.5}` (the CSS default) is
 * centred, `{x: 0, y: 0}` is `left top`.
 */
export interface PointerObjectPosition {
  x: number;
  y: number;
}

/** `(clientX, clientY) -> host px`, or `null` outside the drawn picture (letterbox, off picture). */
export type PointerMap = (
  clientX: number,
  clientY: number,
) => PointerPoint | null;

/**
 * Build a `map` for a picture of `presentation` size drawn in `box` with `fit` and `position`.
 * Points outside the visible picture map to `null`: the letterbox bars of `contain`, the area
 * outside the box for every fit (`cover` crops there), and anything when the box or picture is
 * empty.
 */
export function objectFitMapper(
  box: PointerBox | (() => PointerBox),
  presentation: PointerPresentationSize | (() => PointerPresentationSize),
  fit: PointerObjectFit = "contain",
  position: PointerObjectPosition = { x: 0.5, y: 0.5 },
): PointerMap {
  const readBox = typeof box === "function" ? box : () => box;
  const readSize =
    typeof presentation === "function" ? presentation : () => presentation;
  return (clientX, clientY) => {
    const b = readBox();
    const p = readSize();
    if (!(b.width > 0 && b.height > 0 && p.width > 0 && p.height > 0))
      return null;
    let scaleX: number;
    let scaleY: number;
    if (fit === "fill") {
      scaleX = b.width / p.width;
      scaleY = b.height / p.height;
    } else {
      const contain = Math.min(b.width / p.width, b.height / p.height);
      const scale =
        fit === "contain"
          ? contain
          : fit === "cover"
            ? Math.max(b.width / p.width, b.height / p.height)
            : fit === "none"
              ? 1
              : Math.min(1, contain);
      scaleX = scale;
      scaleY = scale;
    }
    const drawnWidth = p.width * scaleX;
    const drawnHeight = p.height * scaleY;
    const left = b.left + (b.width - drawnWidth) * position.x;
    const top = b.top + (b.height - drawnHeight) * position.y;
    // Visible = the drawn picture clipped by the box.
    const visLeft = Math.max(left, b.left);
    const visTop = Math.max(top, b.top);
    const visRight = Math.min(left + drawnWidth, b.left + b.width);
    const visBottom = Math.min(top + drawnHeight, b.top + b.height);
    if (
      clientX < visLeft ||
      clientX > visRight ||
      clientY < visTop ||
      clientY > visBottom
    )
      return null;
    return {
      x: (clientX - left) / scaleX,
      y: (clientY - top) / scaleY,
    };
  };
}
