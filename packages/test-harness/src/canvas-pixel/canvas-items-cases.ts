/**
 * The fixed lists of `test/canvasItemsRustPixel.test.ts`: each case is ONE spec drawn twice, once
 * as a packed `PDL1` list through the Rust `canvas-items` executor (gate7-design.md Q14b) and once
 * as the equivalent `@godot-scene-web/canvas` `DrawList` (DRAW_TEXTURED_MESH with vertex colours,
 * a tint, straight-alpha bindings and sampling options) through G7c's TypeScript executor, which
 * is the spec of record. The two shots must be byte-identical.
 *
 * WHERE THE TWO PATHS COMPUTE DIFFERENTLY, THE INPUTS ARE CHOSEN SO BOTH ARE EXACT:
 * - TypeScript transforms every vertex on the CPU in f64 and stores f32; Rust transforms on the
 *   GPU in f32 (possibly fused). Every transform entry here is 0, ±0.5, ±1, ±1.5 or ±2 and every
 *   origin and local position an integer or half-integer, so each product and sum is exact in
 *   both and the design positions are bit-equal.
 * - TypeScript premultiplies the modulate in JS and uploads the tint as f32; Rust multiplies the
 *   f32 modulate in the vertex shader. The page computes the tint as `fround(fround(c) ·
 *   fround(a))`, the correctly rounded f32 product, which is what an IEEE f32 multiply gives.
 * - The projection is `[2/w, -2/h, -1, 1]` in both, the f64 quotient rounded to f32.
 * Everything else (the interpolation, the sampler, the fragment arithmetic, the blend, the
 * RGB10_A2 conversion, the rounding blit) runs on the same GPU with the same shader expressions.
 *
 * Pure data: no DOM, imported by the page and by the test.
 */

export type Rgba = readonly [number, number, number, number];
export type Blend = "mix" | "add" | "sub" | "mul" | "premul_alpha" | "disabled";
export type Wrap = "clamp" | "repeat" | "mirror";
export type Filter = "nearest" | "linear";
export type TargetFormat = "rgb10a2" | "rgba8";

export interface ItemSpec {
  /** Godot `Transform2D` columns `x.x, x.y, y.x, y.y, origin.x, origin.y`. */
  xform: readonly [number, number, number, number, number, number];
  /** STRAIGHT modulate. */
  modulate: Rgba;
}

export interface VertexSpec {
  pos: readonly [number, number];
  uv: readonly [number, number];
  /** STRAIGHT colour. */
  color: Rgba;
}

/** One draw: a mesh of one item with its state. */
export interface MeshSpec {
  item: number;
  /** 0 is the white texel. */
  texture: number;
  filter: Filter;
  wrap: Wrap;
  blend: Blend;
  /** Top-left `[x, y, w, h]` in target pixels. */
  scissor?: readonly [number, number, number, number];
  vertices: readonly VertexSpec[];
  /** Triangle list into `vertices`. */
  indices: readonly number[];
}

export interface TextureSpec {
  id: number;
  width: number;
  height: number;
  /** Straight RGBA8. */
  rgba: Uint8Array;
}

export interface ItemsCase {
  name: string;
  width: number;
  height: number;
  format: TargetFormat;
  /** STRAIGHT clear colour. */
  clear: Rgba;
  textures: readonly TextureSpec[];
  meshes: readonly MeshSpec[];
  /** One entry per frame: the items of that frame. Frames after the first change ONLY items. */
  frames: readonly (readonly ItemSpec[])[];
}

const f32 = Math.fround;
const IDENTITY: ItemSpec["xform"] = [1, 0, 0, 1, 0, 0];
const WHITE: Rgba = [1, 1, 1, 1];

/** The tint G7c's executor takes: the f32 product a GPU multiply gives, or the modulate as given
 *  for premul_alpha. */
export function tintOf(modulate: Rgba, blend: Blend): Rgba {
  if (blend === "premul_alpha") return modulate.map(f32) as unknown as Rgba;
  const a = f32(modulate[3]);
  return [
    f32(f32(modulate[0]) * a),
    f32(f32(modulate[1]) * a),
    f32(f32(modulate[2]) * a),
    a,
  ];
}

const BLEND_CODES: Record<Blend, number> = {
  mix: 0,
  add: 1,
  sub: 2,
  mul: 3,
  premul_alpha: 4,
  disabled: 5,
};
const WRAP_CODES: Record<Wrap, number> = { clamp: 0, repeat: 1, mirror: 2 };

export function samplerBits(mesh: MeshSpec): number {
  return (mesh.filter === "linear" ? 1 : 0) | (WRAP_CODES[mesh.wrap] << 1);
}

/** The state `gsw_canvas_draw_list::mergeable` compares, as a key. */
function stateKey(mesh: MeshSpec): string {
  return [
    mesh.texture,
    samplerBits(mesh),
    BLEND_CODES[mesh.blend],
    mesh.scissor ? mesh.scissor.join(",") : "-",
  ].join("|");
}

/** Draw calls the Rust executor must issue: runs of adjacent meshes with equal state (their index
 *  ranges always touch, since meshes are packed in order). */
export function expectedDrawCalls(spec: ItemsCase): number {
  let calls = 0;
  let previous: string | null = null;
  for (const mesh of spec.meshes) {
    if (mesh.indices.length === 0) continue;
    const key = stateKey(mesh);
    if (key !== previous) calls += 1;
    previous = key;
  }
  return calls;
}

/** `PDL1` (see `gsw_canvas_draw_list::pdl1`) of `spec` with frame `frame`'s items. */
export function encodePdl1(spec: ItemsCase, frame: number): Uint8Array {
  const items = spec.frames[frame];
  const vertexCount = spec.meshes.reduce((n, m) => n + m.vertices.length, 0);
  const indexCount = spec.meshes.reduce((n, m) => n + m.indices.length, 0);
  const bytes = new ArrayBuffer(
    52 +
      items.length * 48 +
      vertexCount * 36 +
      indexCount * 4 +
      spec.meshes.length * 44,
  );
  const view = new DataView(bytes);
  let o = 0;
  const u32 = (v: number): void => {
    view.setUint32(o, v, true);
    o += 4;
  };
  const i32 = (v: number): void => {
    view.setInt32(o, v, true);
    o += 4;
  };
  const fl = (v: number): void => {
    view.setFloat32(o, v, true);
    o += 4;
  };
  for (const c of "PDL1") {
    view.setUint8(o, c.charCodeAt(0));
    o += 1;
  }
  u32(1);
  u32(spec.width);
  u32(spec.height);
  u32(spec.format === "rgb10a2" ? 0 : 1);
  for (const c of spec.clear) fl(c);
  u32(items.length);
  u32(vertexCount);
  u32(indexCount);
  u32(spec.meshes.length);
  for (const item of items) {
    for (const v of item.xform) fl(v);
    for (const v of item.modulate) fl(v);
    u32(0);
    u32(0);
  }
  for (const mesh of spec.meshes) {
    for (const vertex of mesh.vertices) {
      fl(vertex.pos[0]);
      fl(vertex.pos[1]);
      fl(vertex.uv[0]);
      fl(vertex.uv[1]);
      for (const v of vertex.color) fl(v);
      u32(mesh.item);
    }
  }
  let base = 0;
  for (const mesh of spec.meshes) {
    for (const index of mesh.indices) u32(base + index);
    base += mesh.vertices.length;
  }
  let first = 0;
  for (const mesh of spec.meshes) {
    u32(first);
    u32(mesh.indices.length);
    u32(mesh.texture);
    u32(samplerBits(mesh));
    u32(BLEND_CODES[mesh.blend]);
    u32(0);
    const scissor = mesh.scissor ?? [0, 0, 0, 0];
    for (const v of scissor) i32(v);
    u32(mesh.scissor ? 1 : 0);
    first += mesh.indices.length;
  }
  if (o !== bytes.byteLength) throw new Error("PDL1 size mismatch");
  return new Uint8Array(bytes);
}

// ---- builders -------------------------------------------------------------

interface QuadOptions {
  item?: number;
  texture?: number;
  filter?: Filter;
  wrap?: Wrap;
  blend?: Blend;
  scissor?: readonly [number, number, number, number];
  /** Corner colours top-left, top-right, bottom-right, bottom-left (STRAIGHT). */
  colors?: readonly [Rgba, Rgba, Rgba, Rgba];
  /** `[u0, v0, u1, v1]`. */
  uv?: readonly [number, number, number, number];
}

/** An axis-aligned quad in item-local space, two triangles. */
function quad(
  x: number,
  y: number,
  w: number,
  h: number,
  options: QuadOptions = {},
): MeshSpec {
  const c = options.colors ?? [WHITE, WHITE, WHITE, WHITE];
  const [u0, v0, u1, v1] = options.uv ?? [0, 0, 1, 1];
  return {
    item: options.item ?? 0,
    texture: options.texture ?? 0,
    filter: options.filter ?? "nearest",
    wrap: options.wrap ?? "clamp",
    blend: options.blend ?? "mix",
    scissor: options.scissor,
    vertices: [
      { pos: [x, y], uv: [u0, v0], color: c[0] },
      { pos: [x + w, y], uv: [u1, v0], color: c[1] },
      { pos: [x + w, y + h], uv: [u1, v1], color: c[2] },
      { pos: [x, y + h], uv: [u0, v1], color: c[3] },
    ],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

const solid = (color: Rgba): QuadOptions["colors"] => [
  color,
  color,
  color,
  color,
];

function texture(
  id: number,
  width: number,
  height: number,
  texels: readonly Rgba[],
): TextureSpec {
  const rgba = new Uint8Array(width * height * 4);
  texels.forEach((t, i) => {
    rgba.set(t, i * 4);
  });
  return { id, width, height, rgba };
}

/** A deterministic f32-friendly value in [0, 1]. */
function unitValue(seed: number): number {
  return f32((((seed * 2654435761) >>> 0) % 1000) / 999);
}

const items1 = (item: ItemSpec): readonly (readonly ItemSpec[])[] => [[item]];

// ---- textures --------------------------------------------------------------

/** 4x4: an opaque 2x2 centre inside a ring whose alpha and colour differ sharply (straight). */
const EDGE_TEXELS: Rgba[] = (() => {
  const out: Rgba[] = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const centre = x > 0 && x < 3 && y > 0 && y < 3;
      out.push(
        centre
          ? [230 - 40 * x, 30 + 60 * y, 90, 255]
          : [20, 200, 240, (x + y) % 2 === 0 ? 0 : 96],
      );
    }
  }
  return out;
})();

/** A 4x1 page with one translucent texel (straight). */
const WRAP_PAGE: Rgba[] = [
  [40, 0, 0, 255],
  [0, 180, 0, 160],
  [0, 0, 220, 255],
  [200, 160, 0, 64],
];

/** 2x2 premultiplied CONTENT (rgb <= a), for premul_alpha. */
const PREMUL_CONTENT: Rgba[] = [
  [100, 50, 0, 128],
  [20, 60, 90, 96],
  [200, 200, 200, 255],
  [0, 0, 0, 0],
];

/** 2x2 straight texels for the many-items case. */
const CHECKER: Rgba[] = [
  [255, 255, 255, 255],
  [255, 128, 0, 200],
  [0, 128, 255, 120],
  [40, 40, 40, 255],
];

// ---- the cases ---------------------------------------------------------------

const S = 64;

function solidQuads(): ItemsCase {
  return {
    name: "solidQuads",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.1, 0.2, 0.3, 1],
    textures: [],
    meshes: [
      quad(4, 4, 32, 24, { colors: solid([1, 0, 0, 1]) }),
      quad(20, 12, 36, 30, { colors: solid([0, 1, 0, 0.5]) }),
      quad(8, 30, 50, 28, { colors: solid([0.9, 0.3, 0.6, 0.35]) }),
      quad(0, 50, 64, 14, { colors: solid([0.05, 0.05, 0.05, 0.8]) }),
    ],
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

/** Colour AND alpha vary across the quad (G7c's vertexGradient), plus a vertical one. */
function gradient(format: TargetFormat): ItemsCase {
  const left: Rgba = [1, 0.5, 0, 1];
  const right: Rgba = [0, 0.5, 1, 0];
  return {
    name: format === "rgb10a2" ? "gradientRgb10a2" : "gradientRgba8",
    width: S,
    height: S,
    format,
    clear: [0.25, 0.25, 0.25, 1],
    textures: [],
    meshes: [
      quad(0, 0, S, 40, { colors: [left, right, right, left] }),
      quad(8, 24, 48, 40, {
        colors: [
          [0.2, 0.9, 0.4, 0.9],
          [0.2, 0.9, 0.4, 0.9],
          [0.8, 0.1, 0.7, 0.1],
          [0.8, 0.1, 0.7, 0.1],
        ],
      }),
    ],
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

/** A textured triangle fan (not a quad) with per-vertex colours and a translucent modulate,
 *  scaled 2x and translated by the item. */
function texturedMesh(): ItemsCase {
  const ring: [number, number][] = [
    [8, 0],
    [14, 4],
    [16, 10],
    [12, 16],
    [4, 16],
    [0, 10],
    [2, 4],
  ];
  const colors: Rgba[] = [
    [1, 1, 1, 1],
    [1, 0.5, 0.25, 1],
    [0.5, 1, 0.5, 0.75],
    [0.25, 0.5, 1, 0.5],
    [1, 1, 0, 1],
    [0, 1, 1, 0.25],
    [1, 0, 1, 1],
  ];
  const centre: VertexSpec = {
    pos: [8, 8],
    uv: [0.5, 0.5],
    color: [1, 1, 1, 1],
  };
  const vertices: VertexSpec[] = [
    centre,
    ...ring.map(
      ([x, y], i): VertexSpec => ({
        pos: [x, y],
        uv: [x / 16, y / 16],
        color: colors[i],
      }),
    ),
  ];
  const indices: number[] = [];
  for (let i = 0; i < ring.length; i += 1)
    indices.push(0, 1 + i, 1 + ((i + 1) % ring.length));
  return {
    name: "texturedMesh",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.15, 0.1, 0.05, 1],
    textures: [texture(1, 4, 4, EDGE_TEXELS)],
    meshes: [
      {
        item: 0,
        texture: 1,
        filter: "linear",
        wrap: "clamp",
        blend: "mix",
        vertices,
        indices,
      },
    ],
    frames: items1({
      xform: [2, 0, 0, 2, 16, 12],
      modulate: [1, 0.5, 1, 0.8],
    }),
  };
}

/** A 4x4 straight page with a translucent edge, magnified 12x. */
function filter(mode: Filter): ItemsCase {
  return {
    name: mode === "nearest" ? "filterNearest" : "filterLinear",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.5, 0.5, 0.5, 1],
    textures: [texture(1, 4, 4, EDGE_TEXELS)],
    meshes: [quad(8, 8, 48, 48, { texture: 1, filter: mode })],
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

/** Six bands: clamp / repeat / mirror x linear / nearest, uv -1 .. 2 across 48 px. */
function wrapModes(): ItemsCase {
  const meshes: MeshSpec[] = [];
  const bands: [Wrap, Filter][] = [
    ["clamp", "linear"],
    ["repeat", "linear"],
    ["mirror", "linear"],
    ["clamp", "nearest"],
    ["repeat", "nearest"],
    ["mirror", "nearest"],
  ];
  bands.forEach(([wrap, mode], i) => {
    meshes.push(
      quad(8, 2 + i * 10, 48, 8, {
        texture: 1,
        wrap,
        filter: mode,
        uv: [-1, -0.5, 2, 1.5],
      }),
    );
  });
  return {
    name: "wrapModes",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.2, 0.2, 0.2, 1],
    textures: [texture(1, 4, 1, WRAP_PAGE)],
    meshes,
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

/** One blend over a background with an opaque and a translucent half (and a transparent strip at
 *  the bottom), drawn with a texture, a vertex gradient and a translucent modulate. */
function blendCase(blend: Blend, format: TargetFormat = "rgb10a2"): ItemsCase {
  const premul = blend === "premul_alpha";
  const top: Rgba = premul ? [0.5, 0.25, 0.1, 0.5] : [1, 0.6, 0.2, 0.9];
  const bottom: Rgba = premul ? [0.1, 0.3, 0.6, 0.75] : [0.2, 0.7, 1, 0.4];
  const name = `blend${blend === "premul_alpha" ? "PremulAlpha" : blend[0].toUpperCase() + blend.slice(1)}${format === "rgba8" ? "Rgba8" : ""}`;
  return {
    name,
    width: S,
    height: S,
    format,
    clear: [0, 0, 0, 0],
    textures: [texture(1, 2, 2, premul ? PREMUL_CONTENT : CHECKER)],
    meshes: [
      quad(0, 0, 32, 56, { item: 0, colors: solid([0.6, 0.4, 0.2, 1]) }),
      quad(32, 0, 32, 56, { item: 0, colors: solid([0.2, 0.5, 0.8, 0.5]) }),
      quad(6, 6, 52, 54, {
        item: 1,
        texture: 1,
        filter: "linear",
        blend,
        colors: [top, top, bottom, bottom],
      }),
    ],
    frames: [
      [
        { xform: IDENTITY, modulate: WHITE },
        {
          xform: IDENTITY,
          modulate: premul ? [0.8, 0.9, 1, 0.75] : [0.9, 1, 0.8, 0.75],
        },
      ],
      // A steady frame: the foreground item moves by a pixel and fades a little.
      [
        { xform: IDENTITY, modulate: WHITE },
        {
          xform: [1, 0, 0, 1, 1, -1],
          modulate: premul ? [0.8, 0.9, 1, 0.5] : [0.9, 1, 0.8, 0.5],
        },
      ],
    ],
  };
}

/** `disabled` writes the source as is; with an opaque source that equals MIX, which is all the
 *  TypeScript executor can express (it has no disabled blend). */
function blendDisabledOpaque(): ItemsCase {
  return {
    name: "blendDisabledOpaque",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.3, 0.3, 0.3, 1],
    textures: [
      texture(
        1,
        2,
        2,
        CHECKER.map((t) => [t[0], t[1], t[2], 255]),
      ),
    ],
    meshes: [
      quad(0, 0, 40, 40, { colors: solid([0.9, 0.1, 0.1, 0.5]) }),
      quad(16, 16, 40, 40, { texture: 1, blend: "disabled" }),
    ],
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

function scissor(): ItemsCase {
  const full = (
    color: Rgba,
    box?: readonly [number, number, number, number],
  ): MeshSpec => quad(0, 0, S, S, { colors: solid(color), scissor: box });
  return {
    name: "scissor",
    width: S,
    height: S,
    format: "rgb10a2",
    clear: [0.05, 0.05, 0.1, 1],
    textures: [],
    meshes: [
      full([1, 0, 0, 0.7], [8, 8, 20, 20]),
      full([0, 1, 0, 0.6], [30, 4, 30, 10]),
      // Same scissor twice in a row: one call.
      full([0, 0, 1, 0.5], [30, 4, 30, 10]),
      full([1, 1, 0, 0.6], [-5, 40, 20, 30]),
      full([0, 1, 1, 0.8], [60, 60, 10, 10]),
      full([1, 0, 1, 1], [10, 10, 0, 5]),
      // Unscissored, drawn after the scissored ones.
      quad(24, 24, 16, 16, { colors: solid([1, 1, 1, 0.5]) }),
    ],
    frames: [
      [{ xform: IDENTITY, modulate: WHITE }],
      // Every draw is item 0: one row moves everything (the scissors stay in target pixels).
      [{ xform: [1, 0, 0, 1, 3, 2], modulate: [1, 0.5, 0.75, 0.8] }],
    ],
  };
}

/** Exact transforms for item `i` of a grid cell at `(cx, cy)`, `cell` px. */
function gridItem(i: number, cx: number, cy: number, cell: number): ItemSpec {
  const kind = i % 4;
  const xform: ItemSpec["xform"] =
    kind === 0
      ? [1, 0, 0, 1, cx, cy]
      : kind === 1
        ? [0, 1, -1, 0, cx + cell, cy] // 90 degrees
        : kind === 2
          ? [0.5, 0, 0, 0.5, cx + cell / 4, cy + cell / 4]
          : [-1, 0, 0, 1, cx + cell, cy]; // mirrored
  const alpha = [1, 0.75, 0.5, 0.9][(i >> 2) % 4];
  return {
    xform,
    modulate: [
      unitValue(i * 3 + 1),
      unitValue(i * 3 + 2),
      unitValue(i * 3 + 3),
      alpha,
    ],
  };
}

const GRID_COLS = 32;
const GRID_ROWS = 20;
const CELL = 4;

/** 640 items (two item-texture rows), one 4x4 quad each, textures alternating in runs so some
 *  adjacent draws merge and others do not. */
function manyItemsSpec(name: string): ItemsCase {
  const meshes: MeshSpec[] = [];
  const items: ItemSpec[] = [];
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i += 1) {
    const cx = (i % GRID_COLS) * CELL;
    const cy = Math.floor(i / GRID_COLS) * CELL;
    items.push(gridItem(i, cx, cy, CELL));
    const run = Math.floor(i / 5) % 3;
    meshes.push(
      quad(0, 0, CELL, CELL, {
        item: i,
        texture: run === 2 ? 0 : run + 1,
        filter: run === 1 ? "linear" : "nearest",
        wrap: "repeat",
        uv: [0, 0, 1.5, 1],
        colors: [
          [1, 1, 1, 1],
          [1, 0.8, 0.6, 1],
          [0.6, 0.8, 1, 0.7],
          [1, 1, 1, 0.9],
        ],
      }),
    );
  }
  return {
    name,
    width: GRID_COLS * CELL,
    height: GRID_ROWS * CELL,
    format: "rgb10a2",
    clear: [0.1, 0.1, 0.1, 1],
    textures: [texture(1, 2, 2, CHECKER), texture(2, 4, 4, EDGE_TEXELS)],
    meshes,
    frames: [items],
  };
}

/** Frames 2 and 3 move and recolour a few items only, across the 512-item row boundary. */
function itemsOnlyUpdate(): ItemsCase {
  const base = manyItemsSpec("itemsOnlyUpdate");
  const first = base.frames[0];
  const frame2 = first.slice();
  for (const i of [3, 4, 5, 300, 510, 511, 512, 513, 639]) {
    const old = first[i];
    frame2[i] = {
      xform: [
        old.xform[0],
        old.xform[1],
        old.xform[2],
        old.xform[3],
        old.xform[4] + 1,
        old.xform[5] - 2,
      ],
      modulate: [old.modulate[2], old.modulate[0], old.modulate[1], 1],
    };
  }
  const frame3 = frame2.slice();
  for (const i of [0, 100, 101, 600]) {
    const old = frame2[i];
    frame3[i] = {
      xform: [2, 0, 0, 2, old.xform[4] - 2, old.xform[5] - 2],
      modulate: [1, 0.25, 0.25, 0.5],
    };
  }
  return { ...base, frames: [first, frame2, frame3] };
}

/** G7c's rgb10a2Stack: an opaque base under five MIX layers of alpha 0.2 (left), one
 *  translucent quad over the transparent clear (right). */
function stack(format: TargetFormat): ItemsCase {
  const half = S / 2;
  const meshes: MeshSpec[] = [
    quad(0, 0, half, S, { colors: solid([98 / 255, 98 / 255, 98 / 255, 1]) }),
  ];
  for (let i = 0; i < 5; i += 1)
    meshes.push(quad(0, 0, half, S, { colors: solid([0.4, 0.4, 0.4, 0.2]) }));
  meshes.push(quad(half, 0, half, S, { colors: solid([0.3, 0.3, 0.3, 0.6]) }));
  return {
    name: format === "rgb10a2" ? "stackRgb10a2" : "stackRgba8",
    width: S,
    height: S,
    format,
    clear: [0, 0, 0, 0],
    textures: [],
    meshes,
    frames: items1({ xform: IDENTITY, modulate: WHITE }),
  };
}

export function buildCases(): ItemsCase[] {
  return [
    solidQuads(),
    gradient("rgb10a2"),
    gradient("rgba8"),
    texturedMesh(),
    filter("nearest"),
    filter("linear"),
    wrapModes(),
    blendCase("mix"),
    blendCase("add"),
    blendCase("sub"),
    blendCase("mul"),
    blendCase("premul_alpha"),
    blendCase("mix", "rgba8"),
    blendCase("premul_alpha", "rgba8"),
    blendDisabledOpaque(),
    scissor(),
    manyItemsSpec("manyItems"),
    stack("rgb10a2"),
    stack("rgba8"),
    itemsOnlyUpdate(),
  ];
}

export function caseByName(name: string): ItemsCase {
  const found = buildCases().find((c) => c.name === name);
  if (!found) throw new Error(`unknown canvas-items case "${name}"`);
  return found;
}

/** Items whose row differs between two frames (what a transform-only frame must upload). */
export function changedItems(spec: ItemsCase, frame: number): number {
  if (frame === 0) return spec.frames[0].length;
  const before = spec.frames[frame - 1];
  const after = spec.frames[frame];
  let changed = 0;
  for (let i = 0; i < after.length; i += 1) {
    const a = before[i];
    const b = after[i];
    const same =
      a.xform.every((v, k) => f32(v) === f32(b.xform[k])) &&
      a.modulate.every((v, k) => f32(v) === f32(b.modulate[k]));
    if (!same) changed += 1;
  }
  return changed;
}
