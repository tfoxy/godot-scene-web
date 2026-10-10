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
//
// render-stream/4 (gate5-design.md D9, D10, G5d). Step 1 follows Item::get_rect
// (renderer_canvas_render.cpp:36-132) for the /4 commands too:
//   - add_set_transform replaces the item's draw transform (never composed, reset per item, never
//     inherited by children): every LATER command's rect is the bounding box of its own rect
//     through it (Transform2D::xform(Rect2)), and once one has been seen every later rect is
//     transformed, identity included (`found_xform`). It contributes no rect of its own.
//   - add_clip_ignore contributes no rect (get_rect's default branch).
//   - add_nine_patch contributes its rect; add_primitive, add_polygon and add_triangle_array the
//     bounding box of their points (the Primitive points / Polygon::create's rect_cache; a
//     triangle array whose count x 3 exceeds its indices is refused by Polygon::create after the
//     command is allocated, leaving Rect2()); add_line the 2 points of a thin line (width < 0) or
//     the 4 corners of its quad (from/to +- the normalized orthogonal x width / 2, float32), and
//     add_polyline / add_multiline with width < 0 the bounding box of their points.
//   - Rects that depend on the server's lowering beyond that -- antialiased lines (feather
//     primitives), wide polylines and multilines (bisector strips, per-segment quads), circles
//     (cosf/sinf fans) -- and add_mesh (the mesh's AABB, G5e) are unknown, exactly as an
//     unsupported command is.
// GLES3 drops an item's scissor between add_clip_ignore(true) and add_clip_ignore(false) while it
// has a clip owner (rasterizer_canvas_gles3.cpp:1260-1274); clipIgnoredCommands() names the
// commands drawn that way, and deriveClipRects() reports them on the item's entry (`ignored`).

import type { ResolvedCanvas, ResolvedItem } from "./render-stream-2";

/** [x0, y0, x1, y1): integer, half-open. */
export type ClipRect = [number, number, number, number];

export interface DerivedClip {
  /** the item whose scissor applies (the item itself when it clips), or null */
  owner: number | null;
  /** that scissor, or null when no ancestor (and not the item) clips */
  rect: ClipRect | null;
  /** D10 (G5d): the item's own commands drawn without that scissor (clipIgnoredCommands), present
   * only when the item has an owner and at least one such command */
  ignored?: number[];
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

/** Rect2(points[0]) expanded to every later point (Rect2::expand_to), float32. */
function pointsBox(points: readonly (readonly number[])[]): Box {
  if (points.length === 0) return [0, 0, 0, 0];
  let x0 = points[0][0];
  let y0 = points[0][1];
  let x1 = x0;
  let y1 = y0;
  for (const p of points.slice(1)) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, f(x1 - x0), f(y1 - y0)];
}

/** canvas_item_add_line's stored points (renderer_canvas_cull.cpp:717-756), float32: the two end
 * points for width < 0, else the quad from/to +- orthogonal().normalized() * width * 0.5. */
export function linePoints(
  from: readonly number[],
  to: readonly number[],
  width: number,
): [number, number][] {
  if (width < 0)
    return [
      [from[0], from[1]],
      [to[0], to[1]],
    ];
  const dx = f(from[0] - to[0]);
  const dy = f(from[1] - to[1]);
  // Vector2::orthogonal() is (y, -x); normalized() divides by sqrtf(x^2 + y^2) when non-zero.
  let ox = dy;
  let oy = f(-dx);
  const l2 = f(f(ox * ox) + f(oy * oy));
  if (l2 !== 0) {
    const l = f(Math.sqrt(l2));
    ox = f(ox / l);
    oy = f(oy / l);
  }
  const tx = f(f(ox * width) * 0.5);
  const ty = f(f(oy * width) * 0.5);
  return [
    [f(from[0] + tx), f(from[1] + ty)],
    [f(from[0] - tx), f(from[1] - ty)],
    [f(to[0] - tx), f(to[1] - ty)],
    [f(to[0] + tx), f(to[1] + ty)],
  ];
}

/** One command's own rect for Item::get_rect (step 1), before the draw transform: a Box, "none"
 * for a command get_rect skips (add_set_transform, add_clip_ignore), or null when unknown. */
function commandRect(
  c: DeriveInput["items"][number]["commands"][number],
): Box | "none" | null {
  switch (c.op) {
    case "add_set_transform":
    case "add_clip_ignore":
      return "none";
    case "add_rect": {
      if (!c.rect) return null;
      let [x, y, w, h] = c.rect;
      // Stored as given; a negative size spans the same corners.
      if (w < 0) [x, w] = [x + w, -w];
      if (h < 0) [y, h] = [y + h, -h];
      return [x, y, w, h];
    }
    case "add_texture_rect":
    case "add_texture_rect_region":
    case "add_msdf_texture_rect_region": {
      if (!c.rect) return null;
      const [x, y] = c.rect;
      // Texture rects: sizes made positive in place, then swapped when transposed.
      let w = Math.abs(c.rect[2]);
      let h = Math.abs(c.rect[3]);
      if (c.transpose) [w, h] = [h, w];
      return [x, y, w, h];
    }
    case "add_nine_patch":
      return c.rect ? [c.rect[0], c.rect[1], c.rect[2], c.rect[3]] : null;
    case "add_primitive":
    case "add_polygon":
      return c.points ? pointsBox(c.points) : null;
    case "add_triangle_array": {
      if (!c.points || !c.indices) return null;
      const count = c.count ?? -1;
      if (count >= 0 && count * 3 > c.indices.length) return [0, 0, 0, 0];
      return pointsBox(c.points);
    }
    case "add_line":
      if (!c.from || !c.to || c.width === undefined || c.aa) return null;
      return pointsBox(linePoints(c.from, c.to, c.width));
    case "add_polyline":
    case "add_multiline":
      if (!c.points || c.width === undefined || c.width >= 0) return null;
      return pointsBox(c.points);
    default:
      // unsupported, add_circle, add_mesh: bounds the derivation does not model.
      return null;
  }
}

/** An item's cull rect (step 1), or null when a command makes it unknown. */
export function itemRect(item: DeriveInput["items"][number]): Box | null {
  if (item.custom_rect) {
    const [x, y, w, h] = item.custom_rect_rect;
    return [x, y, w, h];
  }
  let box: [number, number, number, number] | undefined;
  let xf: readonly number[] | null = null;
  for (const c of item.commands) {
    if (c.op === "add_set_transform") {
      // D9: replaced, not composed; applies to every later command of this item only.
      if (!c.transform) return null;
      xf = c.transform;
      continue;
    }
    const own = commandRect(c);
    if (own === null) return null;
    if (own === "none") continue;
    const r = xf ? xformRect(xf, own) : own;
    const [x, y, w, h] = r;
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
 * D10: the indices of an item's commands GLES3 draws with its scissor dropped -- those after an
 * add_clip_ignore(true) and before the next add_clip_ignore(false) -- assuming the item has a clip
 * owner (without one the commands change nothing). Repeated calls in the same direction are
 * no-ops (`ignore != reclip`); the state starts unclipped-ignore = false for every item.
 */
export function clipIgnoredCommands(
  item: Pick<DeriveInput["items"][number], "commands">,
): number[] {
  const out: number[] = [];
  let ignoring = false;
  item.commands.forEach((c, i) => {
    if (c.op === "add_clip_ignore") {
      ignoring = c.ignore === true;
      return;
    }
    if (ignoring && c.op !== "add_set_transform") out.push(i);
  });
  return out;
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
    const entry: DerivedClip = {
      owner: own ? own.id : null,
      rect: own
        ? [
            own.rect[0],
            own.rect[1],
            own.rect[0] + own.rect[2],
            own.rect[1] + own.rect[3],
          ]
        : null,
    };
    if (own) {
      const ignored = clipIgnoredCommands(it);
      if (ignored.length > 0) entry.ignored = ignored;
    }
    out.set(id, entry);
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
