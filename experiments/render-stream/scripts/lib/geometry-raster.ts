// A reference rasterizer for gate 5's geometry (protocol/gate5-design.md "Q6c", D9, D10, D13).
// Pure: it reads only the coverage model of fixtures/gate5/expected.json (make_expected.py's hand
// lowering of every RenderingServer call), never a capture or the engine. Gate 7's browser
// receivers inherit it as their conformance reference.
//
// What it models of GLES3's rasterization, and nothing more:
//   - A triangle covers a pixel when the pixel centre lies inside it. GL's tie rule is never
//     relied on: a pixel whose centre lies nearer than 1/16 px (`exact_edge_px`) to a boundary
//     edge of its shape is left undecided (GL guarantees 4 subpixel bits, so a vertex snaps by at
//     most 1/32 px). Edges shared by two triangles of one shape are not boundaries (vertices are
//     welded first: a closed strip and a circle fan repeat a vertex through another float path).
//   - Flat colours are exact: float32 in polygons, binary16 in primitives (the model carries the
//     rounded values), RGBA8 out with round-to-nearest. Per-vertex colours interpolate
//     barycentrically (allowed delta 1), and straight-alpha blending (GL_SRC_ALPHA,
//     GL_ONE_MINUS_SRC_ALPHA) runs in float with UNORM8 rounding (delta 1, gate4-design.md D8).
//   - Nearest texture sampling is floor(uv * size) at the pixel centre, decided only when every
//     texel within 1/16 texel of that point has one colour. Nine-patches map each axis as
//     drivers/gles3/shaders/canvas.glsl:521-558 does (`map_ninepatch_axis`), and an undrawn centre
//     has alpha 0 (:586-588).
//   - Each item's command list starts with the identity draw transform; `set_transform` replaces
//     it (never composes, D9) and applies to later shapes as item xform * draw transform.
//     `clip_ignore(true)` drops the item's scissor until `clip_ignore(false)` (D10). Scissors come
//     from the model (gate 3's derivation, written by make_expected.py).
//   - Band class (D13): an antialiased shape (`band_px`, FEATHER_SIZE + 1) marks every pixel
//     within `band_px` of its boundary as band, and a thin GL line every pixel within `band_px`
//     of its segment; those are never synthesized, only presence-checked and compared leg to leg.
//
// `exact` (1) marks every pixel whose synthesized value is decided; `delta` holds the channel
// delta allowed there (0 or 1); `band` the band pixels; `shapes` each shape's coverage for the
// presence check.

import {
  type Affine,
  applyAffine,
  type Box,
  compose,
  type Gate5Expected,
  type Gate5Item,
  type Gate5Op,
  type Gate5Texture,
  invertAffine,
  isShape,
  type MeshShape,
  type NinePatchAxis,
  type NinePatchShape,
  type Point,
  type Rgba,
  type Rgba8,
  stepOf5,
  type ThinLineShape,
  textureTexels,
} from "./gate5-expected";

export const EXACT_EDGE_PX = 1 / 16;
const WELD_PX = 1e-3;
const INSIDE_EPS = 1e-9;

export interface ShapeCoverage {
  item: string;
  region: string;
  shape: string;
  /** "mesh" | "thin_line" | "nine_patch" */
  kind: string;
  /** the shape is band class (antialiased or a thin line) */
  band_class: boolean;
  /** pixel centres the shape covers inside its scissor (decided or not; a thin line counts its
   * length in pixels) */
  covered: number;
  /** pixel indices where presence is counted: covered pixels and band pixels */
  area: number[];
  /** RGBA8 of the synthesized frame at `area`, just before this shape painted */
  underlay: Uint8Array;
}

export interface Gate5Raster {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** 1 where the synthesized value is decided */
  exact: Uint8Array;
  /** the allowed per-channel delta where exact (0 or 1) */
  delta: Uint8Array;
  /** 1 where the pixel is band class */
  band: Uint8Array;
  shapes: ShapeCoverage[];
}

export interface RasterScene {
  viewport: readonly [number, number] | readonly number[];
  clear: Rgba8;
  textures: Record<string, Gate5Texture>;
  opLists: Record<string, Gate5Op[]>;
  items: readonly Gate5Item[];
  exactEdgePx?: number;
}

interface Tex {
  width: number;
  height: number;
  texels: Uint8Array;
}

/** The squared distance from (px, py) to the segment a-b. */
export function segDist2(
  px: number,
  py: number,
  a: readonly number[],
  b: readonly number[],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  const ex = px - (a[0] + t * dx);
  const ey = py - (a[1] + t * dy);
  return ex * ex + ey * ey;
}

/** Barycentric weights of p in triangle abc when p lies inside or on it, else null. */
export function barycentric(
  p: Point,
  a: Point,
  b: Point,
  c: Point,
): [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const l0 =
    ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const l1 =
    ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  const l2 = 1 - l0 - l1;
  if (l0 < -INSIDE_EPS || l1 < -INSIDE_EPS || l2 < -INSIDE_EPS) return null;
  return [l0, l1, l2];
}

/** Each vertex index to the first index at the same position (within 1e-3 px). */
export function weld(vertices: readonly Point[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < vertices.length; i++) {
    let j = 0;
    while (
      Math.abs(vertices[j][0] - vertices[i][0]) > WELD_PX ||
      Math.abs(vertices[j][1] - vertices[i][1]) > WELD_PX
    )
      j++;
    out.push(j);
  }
  return out;
}

/** The welded, non-degenerate triangles of a mesh and its boundary edges (used by exactly one
 * of them), as vertex-index pairs. */
export function meshTopology(
  vertices: readonly Point[],
  triangles: readonly number[][],
): { triangles: [number, number, number][]; boundary: [number, number][] } {
  const w = weld(vertices);
  const tris: [number, number, number][] = [];
  const count = new Map<string, { a: number; b: number; n: number }>();
  for (const raw of triangles) {
    const t = [w[raw[0]], w[raw[1]], w[raw[2]]] as [number, number, number];
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    const [a, b, c] = t.map((i) => vertices[i]);
    if (
      Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) <
      1e-12
    )
      continue;
    tris.push(t);
    for (const [p, q] of [
      [t[0], t[1]],
      [t[1], t[2]],
      [t[2], t[0]],
    ]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      const e = count.get(key);
      if (e) e.n++;
      else count.set(key, { a: Math.min(p, q), b: Math.max(p, q), n: 1 });
    }
  }
  const boundary: [number, number][] = [];
  for (const e of count.values()) if (e.n === 1) boundary.push([e.a, e.b]);
  return { triangles: tris, boundary };
}

const to8 = (v: number): number =>
  Math.round(Math.max(0, Math.min(1, v)) * 255);

/** The texel colour (0..1) at texel coordinates (tx, ty), or null when a texel within
 * `edge` of the point has another colour (`extraX`/`extraY`: further candidate texels, the far
 * side of a tile wrap). */
function sampleNearest(
  tex: Tex,
  tx: number,
  ty: number,
  edge: number,
  extraX: number[] = [],
  extraY: number[] = [],
): Rgba | null {
  const clampX = (x: number) => Math.max(0, Math.min(tex.width - 1, x));
  const clampY = (y: number) => Math.max(0, Math.min(tex.height - 1, y));
  const xs = new Set(
    [
      Math.floor(tx),
      Math.floor(tx - edge),
      Math.floor(tx + edge),
      ...extraX,
    ].map(clampX),
  );
  const ys = new Set(
    [
      Math.floor(ty),
      Math.floor(ty - edge),
      Math.floor(ty + edge),
      ...extraY,
    ].map(clampY),
  );
  const at = (x: number, y: number) => (y * tex.width + x) * 4;
  const first = at(clampX(Math.floor(tx)), clampY(Math.floor(ty)));
  for (const x of xs)
    for (const y of ys) {
      const i = at(x, y);
      for (let c = 0; c < 4; c++)
        if (tex.texels[i + c] !== tex.texels[first + c]) return null;
    }
  return [
    tex.texels[first] / 255,
    tex.texels[first + 1] / 255,
    tex.texels[first + 2] / 255,
    tex.texels[first + 3] / 255,
  ];
}

/** One axis of `map_ninepatch_axis` (canvas.glsl:521-558), in texels: the texel coordinate, whether
 * the pixel is in the centre, the extra wrap candidate of a tile mode near its period, and whether
 * the pixel lies within `edge` of a margin boundary. */
export function mapNinePatchAxis(
  pixel: number,
  drawSize: number,
  texSize: number,
  marginBegin: number,
  marginEnd: number,
  mode: NinePatchAxis,
  edge: number,
): { texel: number; centre: boolean; wrap: number[]; undecided: boolean } {
  const undecided =
    Math.abs(pixel - marginBegin) < edge ||
    Math.abs(pixel - (drawSize - marginEnd)) < edge;
  if (pixel < marginBegin)
    return { texel: pixel, centre: false, wrap: [], undecided };
  if (pixel >= drawSize - marginEnd)
    return {
      texel: texSize - (drawSize - pixel),
      centre: false,
      wrap: [],
      undecided,
    };
  const srcArea = drawSize - marginBegin - marginEnd;
  const dstArea = texSize - marginBegin - marginEnd;
  const mod = (a: number, b: number) => a - b * Math.floor(a / b);
  if (mode === "stretch") {
    const ratio = (pixel - marginBegin) / srcArea;
    return {
      texel: marginBegin + ratio * dstArea,
      centre: true,
      wrap: [],
      undecided,
    };
  }
  let ofs: number;
  let period: number;
  if (mode === "tile") {
    ofs = mod(pixel - marginBegin, dstArea);
    period = dstArea;
  } else {
    const scale = Math.max(
      1,
      Math.floor(srcArea / Math.max(dstArea, 0.0000001) + 0.5),
    );
    ofs = mod(((pixel - marginBegin) / srcArea) * scale, 1) * dstArea;
    period = dstArea;
  }
  const wrap: number[] = [];
  if (ofs < edge) wrap.push(Math.floor(marginBegin + period - edge));
  if (ofs > period - edge) wrap.push(Math.floor(marginBegin));
  return { texel: marginBegin + ofs, centre: true, wrap, undecided };
}

class Canvas {
  readonly rgba: Uint8Array;
  readonly exact: Uint8Array;
  readonly delta: Uint8Array;
  readonly band: Uint8Array;
  readonly shapes: ShapeCoverage[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    clear: Rgba8,
  ) {
    this.rgba = new Uint8Array(width * height * 4);
    this.exact = new Uint8Array(width * height).fill(1);
    this.delta = new Uint8Array(width * height);
    this.band = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) this.rgba.set(clear, i * 4);
  }

  /** Paints a decided colour (0..1 straight alpha) at pixel index `i`. */
  paint(i: number, c: Rgba, tol: number): void {
    const a = c[3];
    if (a <= 0) return;
    const o = i * 4;
    if (a >= 1) {
      this.rgba[o] = to8(c[0]);
      this.rgba[o + 1] = to8(c[1]);
      this.rgba[o + 2] = to8(c[2]);
      this.rgba[o + 3] = 255;
      this.exact[i] = 1;
      this.band[i] = 0;
      this.delta[i] = tol;
      return;
    }
    for (let k = 0; k < 3; k++)
      this.rgba[o + k] = to8(c[k] * a + (this.rgba[o + k] / 255) * (1 - a));
    this.rgba[o + 3] = to8(a + (this.rgba[o + 3] / 255) * (1 - a));
    this.delta[i] = Math.max(this.delta[i], 1, tol);
  }

  undecided(i: number): void {
    this.exact[i] = 0;
  }

  markBand(i: number): void {
    this.exact[i] = 0;
    this.band[i] = 1;
  }
}

type Action =
  | { i: number; kind: "paint"; c: Rgba; tol: number }
  | { i: number; kind: "undecided" }
  | { i: number; kind: "band" };

function windowOf(
  points: readonly Point[],
  pad: number,
  width: number,
  height: number,
  scissor: Box | null,
): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let x0 = Math.max(0, Math.floor(Math.min(...xs) - pad) - 1);
  let y0 = Math.max(0, Math.floor(Math.min(...ys) - pad) - 1);
  let x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad) + 1);
  let y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad) + 1);
  if (scissor) {
    x0 = Math.max(x0, scissor[0]);
    y0 = Math.max(y0, scissor[1]);
    x1 = Math.min(x1, scissor[2]);
    y1 = Math.min(y1, scissor[3]);
  }
  return [x0, y0, x1, y1];
}

function meshActions(
  shape: MeshShape,
  m: Affine,
  scissor: Box | null,
  canvas: Canvas,
  textures: Map<string, Tex>,
  edge: number,
): { actions: Action[]; covered: number; area: number[] } {
  const verts = shape.vertices.map((v) => applyAffine(m, v));
  const topo = meshTopology(verts, shape.triangles);
  const edges = topo.boundary.map(([a, b]) => [verts[a], verts[b]] as const);
  const perVertex =
    shape.colors.length === shape.vertices.length && shape.colors.length > 1;
  const tex = shape.texture ? textures.get(shape.texture) : undefined;
  if (shape.texture && !tex)
    throw new Error(`geometry-raster: unknown texture ${shape.texture}`);
  const bandPx = shape.band_px;
  const [x0, y0, x1, y1] = windowOf(
    verts,
    bandPx ?? 0,
    canvas.width,
    canvas.height,
    scissor,
  );
  const actions: Action[] = [];
  const area: number[] = [];
  let covered = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * canvas.width + x;
      const p: Point = [x + 0.5, y + 0.5];
      let d2 = Number.POSITIVE_INFINITY;
      for (const [a, b] of edges) d2 = Math.min(d2, segDist2(p[0], p[1], a, b));
      const d = Math.sqrt(d2);
      let hit: {
        t: [number, number, number];
        w: [number, number, number];
      } | null = null;
      for (const t of topo.triangles) {
        const w = barycentric(p, verts[t[0]], verts[t[1]], verts[t[2]]);
        if (w) {
          hit = { t, w };
          break;
        }
      }
      if (hit) covered++;
      if (bandPx !== undefined && d < bandPx) {
        actions.push({ i, kind: "band" });
        area.push(i);
        continue;
      }
      if (hit) area.push(i);
      // Within 1/16 px of a boundary edge, inside or outside, GL's snapped edge decides.
      if (d < edge) {
        actions.push({ i, kind: "undecided" });
        continue;
      }
      if (!hit) continue;
      // Colour: the triangle's vertex colours, through the welded indices (a welded vertex shares
      // its position, and in every lowering its colour and uv, with the vertex it maps to).
      let c: Rgba;
      let tol = 0;
      if (perVertex) {
        const cs = hit.t.map((vi) => shape.colors[vi]);
        const flat = cs.every((cc) => cc.every((v, k) => v === cs[0][k]));
        c = [0, 1, 2, 3].map(
          (k) =>
            hit.w[0] * cs[0][k] + hit.w[1] * cs[1][k] + hit.w[2] * cs[2][k],
        ) as Rgba;
        if (!flat) tol = 1;
      } else {
        c = [...shape.colors[0]] as Rgba;
      }
      if (tex && shape.uvs) {
        const uv = [0, 1].map(
          (k) =>
            hit.w[0] * shape.uvs![hit.t[0]][k] +
            hit.w[1] * shape.uvs![hit.t[1]][k] +
            hit.w[2] * shape.uvs![hit.t[2]][k],
        );
        const texel = sampleNearest(
          tex,
          uv[0] * tex.width,
          uv[1] * tex.height,
          edge,
        );
        if (!texel) {
          actions.push({ i, kind: "undecided" });
          continue;
        }
        c = [
          c[0] * texel[0],
          c[1] * texel[1],
          c[2] * texel[2],
          c[3] * texel[3],
        ];
      }
      actions.push({ i, kind: "paint", c, tol });
    }
  return { actions, covered, area };
}

function thinLineActions(
  shape: ThinLineShape,
  m: Affine,
  scissor: Box | null,
  canvas: Canvas,
): { actions: Action[]; covered: number; area: number[] } {
  const a = applyAffine(m, shape.from);
  const b = applyAffine(m, shape.to);
  const [x0, y0, x1, y1] = windowOf(
    [a, b],
    shape.band_px,
    canvas.width,
    canvas.height,
    scissor,
  );
  const actions: Action[] = [];
  const area: number[] = [];
  const limit = shape.band_px * shape.band_px;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (segDist2(x + 0.5, y + 0.5, a, b) <= limit) {
        const i = y * canvas.width + x;
        actions.push({ i, kind: "band" });
        area.push(i);
      }
  return {
    actions,
    covered: Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])),
    area,
  };
}

function ninePatchActions(
  shape: NinePatchShape,
  m: Affine,
  scissor: Box | null,
  canvas: Canvas,
  textures: Map<string, Tex>,
  edge: number,
): { actions: Action[]; covered: number; area: number[] } {
  const tex = textures.get(shape.texture);
  if (!tex)
    throw new Error(`geometry-raster: unknown texture ${shape.texture}`);
  const [rx, ry, rw, rh] = shape.rect;
  const corners: Point[] = [
    [rx, ry],
    [rx + rw, ry],
    [rx + rw, ry + rh],
    [rx, ry + rh],
  ].map((p) => applyAffine(m, p));
  const inv = invertAffine(m);
  const [x0, y0, x1, y1] = windowOf(
    corners,
    0,
    canvas.width,
    canvas.height,
    scissor,
  );
  const [ml, mt, mr, mb] = shape.margins;
  const actions: Action[] = [];
  const area: number[] = [];
  let covered = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * canvas.width + x;
      const [lx, ly] = applyAffine(inv, [x + 0.5, y + 0.5]);
      const px = lx - rx;
      const py = ly - ry;
      const inside = px >= 0 && px < rw && py >= 0 && py < rh;
      const nearEdge =
        Math.min(
          Math.abs(px),
          Math.abs(px - rw),
          Math.abs(py),
          Math.abs(py - rh),
        ) < edge;
      if (!inside && !nearEdge) continue;
      const ax = mapNinePatchAxis(
        px,
        rw,
        tex.width,
        ml,
        mr,
        shape.x_axis,
        edge,
      );
      const ay = mapNinePatchAxis(
        py,
        rh,
        tex.height,
        mt,
        mb,
        shape.y_axis,
        edge,
      );
      // An undrawn centre has alpha 0 (canvas.glsl:586-588): not covered.
      const hollow = ax.centre && ay.centre && !shape.draw_center;
      if (inside && !hollow) {
        covered++;
        area.push(i);
      }
      if (nearEdge || ax.undecided || ay.undecided) {
        actions.push({ i, kind: "undecided" });
        continue;
      }
      if (hollow) continue;
      const texel = sampleNearest(
        tex,
        ax.texel,
        ay.texel,
        edge,
        ax.wrap,
        ay.wrap,
      );
      if (!texel) {
        actions.push({ i, kind: "undecided" });
        continue;
      }
      const c = shape.modulate;
      actions.push({
        i,
        kind: "paint",
        c: [c[0] * texel[0], c[1] * texel[1], c[2] * texel[2], c[3] * texel[3]],
        tol: 0,
      });
    }
  return { actions, covered, area };
}

/** Rasterizes a list of items in paint order (the lower-level entry the self-test drives). */
export function rasterizeItems(scene: RasterScene): Gate5Raster {
  const [width, height] = scene.viewport;
  const canvas = new Canvas(width, height, scene.clear);
  const edge = scene.exactEdgePx ?? EXACT_EDGE_PX;
  const textures = new Map<string, Tex>();
  for (const [name, t] of Object.entries(scene.textures))
    textures.set(name, {
      width: t.width,
      height: t.height,
      texels: textureTexels(t),
    });
  for (const item of scene.items) {
    const ops = scene.opLists[item.ops];
    if (!ops) throw new Error(`geometry-raster: unknown op list ${item.ops}`);
    let draw: Affine = [1, 0, 0, 1, 0, 0];
    let ignoreClip = false;
    for (const op of ops) {
      if (!isShape(op)) {
        if (op.op === "set_transform") draw = [...op.transform] as Affine;
        else if (op.op === "clip_ignore") ignoreClip = op.ignore;
        continue;
      }
      const m = compose(item.xform, draw);
      const scissor = ignoreClip ? null : item.clip_px;
      const r =
        op.kind === "mesh"
          ? meshActions(op, m, scissor, canvas, textures, edge)
          : op.kind === "thin_line"
            ? thinLineActions(op, m, scissor, canvas)
            : ninePatchActions(op, m, scissor, canvas, textures, edge);
      const underlay = new Uint8Array(r.area.length * 4);
      for (let k = 0; k < r.area.length; k++)
        underlay.set(
          canvas.rgba.subarray(r.area[k] * 4, r.area[k] * 4 + 4),
          k * 4,
        );
      for (const a of r.actions) {
        if (a.kind === "paint") canvas.paint(a.i, a.c, a.tol);
        else if (a.kind === "band") canvas.markBand(a.i);
        else canvas.undecided(a.i);
      }
      canvas.shapes.push({
        item: item.name,
        region: item.region,
        shape: op.name,
        kind: op.kind,
        band_class:
          op.kind === "thin_line" ||
          (op.kind === "mesh" && op.band_px !== undefined),
        covered: r.covered,
        area: r.area,
        underlay,
      });
    }
  }
  return {
    width,
    height,
    rgba: canvas.rgba,
    exact: canvas.exact,
    delta: canvas.delta,
    band: canvas.band,
    shapes: canvas.shapes,
  };
}

/** The expected frame of one step of fixtures/gate5 (Q6c's `rasterizeGate5`). */
export function rasterizeGate5(
  expected: Gate5Expected,
  step: number,
): Gate5Raster {
  const s = stepOf5(expected, step);
  return rasterizeItems({
    viewport: expected.viewport,
    clear: expected.clear_rgba8,
    textures: expected.textures,
    opLists: expected.op_lists,
    items: s.items,
    exactEdgePx: expected.exact_edge_px,
  });
}
