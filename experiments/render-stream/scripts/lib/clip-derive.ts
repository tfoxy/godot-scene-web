// An independent derivation of every item's final scissor from a render-stream/2 resolved state
// (protocol/gate3-design.md D2, Q1c, G3a). No engine code: this restates the cull's clip rules
// from the pinned 4.5.1 source so the checker can recompute what a receiver's engine will do, and
// it is the reference implementation gate 7's browser receiver follows.
//
// For each visible item, from the canvas transform down (servers/rendering/
// renderer_canvas_cull.cpp:296-418):
//   1. rect = the custom rect when custom_rect is set, else the union of the command rects
//      (servers/rendering/renderer_canvas_render.cpp:36-132): add_rect as given, the two texture
//      rects with their sizes made positive in place and swapped when transposed
//      (renderer_canvas_cull.cpp:1513-1648); no commands give Rect2().
//   2. final_xform = parent_xform * self_xform; global_rect = the axis-aligned bounding box of the
//      rect through it (core/math/transform_2d.h:223-234).
//   3. a clipping item intersects global_rect with its nearest clipping ancestor's already
//      rounded scissor, else the viewport rect (core/math/rect2.h:147-162); below 0.5 px on either
//      side the item and its subtree are skipped; else position and size are rounded separately,
//      half away from zero (core/math/math_funcs.h:625-630). Without a clip an item inherits its
//      parent's owner.
// An invisible item, one outside the cull mask, or one whose accumulated modulate alpha is below
// 0.007 is not visited, nor is its subtree (it draws nothing either way). Arithmetic is float32,
// as real_t is in the release template.
//
// An unsupported command contributes bounds the wire does not carry, so an item without a custom
// rect that holds one has an unknown rect: if it clips, it and its subtree derive as "unknown".

import type { ResolvedCanvas, ResolvedItem } from "./render-stream-2";

/** [x0, y0, x1, y1): integer, half-open. */
export type ClipRect = [number, number, number, number];

export interface DerivedClip {
  /** the item whose scissor applies (the item itself when it clips), or null */
  owner: number | null;
  /** that scissor, or null when no ancestor (and not the item) clips */
  rect: ClipRect | null;
}

export type DerivedEntry = DerivedClip | "skipped" | "unknown";

export interface DeriveInput {
  canvases: readonly Pick<ResolvedCanvas, "id" | "role" | "items" | "xform">[];
  items: readonly Pick<
    ResolvedItem,
    | "id"
    | "children"
    | "visible"
    | "visibility_layer"
    | "clip"
    | "custom_rect"
    | "custom_rect_rect"
    | "xform"
    | "modulate"
    | "commands"
  >[];
}

export interface DeriveOptions {
  /** the viewport's canvas cull mask (default every layer) */
  cullMask?: number;
  /** the canvas to walk (default: the one whose role is "root") */
  canvas?: number;
}

type Affine = [number, number, number, number, number, number];
type Box = [number, number, number, number]; // x, y, w, h

const f = Math.fround;

/** Godot Transform2D a * b (columns x.x, x.y, y.x, y.y, o.x, o.y): b applied first. */
export function mulAffine(a: readonly number[], b: readonly number[]): Affine {
  return [
    f(f(a[0] * b[0]) + f(a[2] * b[1])),
    f(f(a[1] * b[0]) + f(a[3] * b[1])),
    f(f(a[0] * b[2]) + f(a[2] * b[3])),
    f(f(a[1] * b[2]) + f(a[3] * b[3])),
    f(f(f(a[0] * b[4]) + f(a[2] * b[5])) + a[4]),
    f(f(f(a[1] * b[4]) + f(a[3] * b[5])) + a[5]),
  ];
}

/** Transform2D::xform(Rect2): position, then expand_to each of the other three corners. */
export function xformRect(t: readonly number[], r: Box): Box {
  const [x, y, w, h] = r;
  const px = f(f(f(t[0] * x) + f(t[2] * y)) + t[4]);
  const py = f(f(f(t[1] * x) + f(t[3] * y)) + t[5]);
  const ax = f(t[0] * w);
  const ay = f(t[1] * w);
  const bx = f(t[2] * h);
  const by = f(t[3] * h);
  const xs = [px, f(px + ax), f(px + bx), f(f(px + ax) + bx)];
  const ys = [py, f(py + ay), f(py + by), f(f(py + ay) + by)];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return [x0, y0, f(Math.max(...xs) - x0), f(Math.max(...ys) - y0)];
}

/** Rect2::intersects without borders. */
function intersects(a: Box, b: Box): boolean {
  return !(
    a[0] >= b[0] + b[2] ||
    a[0] + a[2] <= b[0] ||
    a[1] >= b[1] + b[3] ||
    a[1] + a[3] <= b[1]
  );
}

/** Rect2::intersection: Rect2() when the two do not overlap. */
export function intersectRect(a: Box, b: Box): Box {
  if (!intersects(a, b)) return [0, 0, 0, 0];
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  return [
    x0,
    y0,
    f(Math.min(f(a[0] + a[2]), f(b[0] + b[2])) - x0),
    f(Math.min(f(a[1] + a[3]), f(b[1] + b[3])) - y0),
  ];
}

/** Math::round (std::round): half away from zero. */
export function roundHalfAway(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** An item's cull rect (step 1), or null when an unsupported command makes it unknown. */
export function itemRect(item: DeriveInput["items"][number]): Box | null {
  if (item.custom_rect) {
    const [x, y, w, h] = item.custom_rect_rect;
    return [x, y, w, h];
  }
  let box: [number, number, number, number] | undefined;
  for (const c of item.commands) {
    if (c.op === "unsupported" || !c.rect) return null;
    let [x, y, w, h] = c.rect;
    if (c.op === "add_rect") {
      // Stored as given; a negative size spans the same corners.
      if (w < 0) [x, w] = [x + w, -w];
      if (h < 0) [y, h] = [y + h, -h];
    } else {
      // Texture rects: sizes made positive in place, then swapped when transposed.
      w = Math.abs(w);
      h = Math.abs(h);
      if (c.transpose) [w, h] = [h, w];
    }
    box = box
      ? [
          Math.min(box[0], x),
          Math.min(box[1], y),
          Math.max(box[2], f(x + w)),
          Math.max(box[3], f(y + h)),
        ]
      : [x, y, f(x + w), f(y + h)];
  }
  if (!box) return [0, 0, 0, 0];
  return [box[0], box[1], f(box[2] - box[0]), f(box[3] - box[1])];
}

/**
 * Every visited item's final scissor (see the header): a DerivedClip, "skipped" for an item a
 * zero-area clip removed (with its subtree), or "unknown". Items not visited (invisible, culled
 * by mask or modulate, or not on the canvas) are absent.
 */
export function deriveClipRects(
  state: DeriveInput,
  viewport: readonly [number, number] | readonly number[],
  opts: DeriveOptions = {},
): Map<number, DerivedEntry> {
  const out = new Map<number, DerivedEntry>();
  const items = new Map(state.items.map((i) => [i.id, i] as const));
  const canvas =
    opts.canvas !== undefined
      ? state.canvases.find((c) => c.id === opts.canvas)
      : state.canvases.find((c) => c.role === "root");
  if (!canvas) return out;
  const mask = (opts.cullMask ?? 0xffffffff) >>> 0;
  const vp: Box = [0, 0, viewport[0], viewport[1]];

  const mark = (id: number, value: "skipped" | "unknown", depth: number) => {
    const it = items.get(id);
    if (!it || depth > 4096) return;
    out.set(id, value);
    for (const c of it.children) mark(c, value, depth + 1);
  };

  const visit = (
    id: number,
    parentXf: readonly number[],
    owner: { id: number; rect: Box } | null,
    alpha: number,
    depth: number,
  ): void => {
    const it = items.get(id);
    if (!it || depth > 4096) return;
    if (!it.visible) return;
    if ((it.visibility_layer & mask) >>> 0 === 0) return;
    const a = f(it.modulate[3] * alpha);
    if (a < 0.007) return;
    const xf = mulAffine(parentXf, it.xform);
    let own = owner;
    if (it.clip) {
      const rect = itemRect(it);
      if (rect === null) {
        mark(id, "unknown", depth);
        return;
      }
      const fc = intersectRect(owner ? owner.rect : vp, xformRect(xf, rect));
      if (fc[2] < 0.5 || fc[3] < 0.5) {
        mark(id, "skipped", depth);
        return;
      }
      own = {
        id,
        rect: [
          roundHalfAway(fc[0]),
          roundHalfAway(fc[1]),
          roundHalfAway(fc[2]),
          roundHalfAway(fc[3]),
        ],
      };
    }
    out.set(id, {
      owner: own ? own.id : null,
      rect: own
        ? [
            own.rect[0],
            own.rect[1],
            own.rect[0] + own.rect[2],
            own.rect[1] + own.rect[3],
          ]
        : null,
    });
    for (const c of it.children) visit(c, xf, own, a, depth + 1);
  };

  for (const id of canvas.items) visit(id, canvas.xform, null, 1, 0);
  return out;
}

/** An owner's own entry for a clip_rects table: its scissor when it clips, null when it does not
 * (or is not visited), "skipped" / "unknown" as derived. */
export function ownerClip(
  derived: ReadonlyMap<number, DerivedEntry>,
  id: number,
): ClipRect | null | "skipped" | "unknown" {
  const d = derived.get(id);
  if (d === undefined) return null;
  if (d === "skipped" || d === "unknown") return d;
  return d.owner === id ? d.rect : null;
}
