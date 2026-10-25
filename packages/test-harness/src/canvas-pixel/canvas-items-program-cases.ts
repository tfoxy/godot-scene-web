/**
 * G7s: the cases of `test/canvasItemsProgramPixel.test.ts`. Each draws Godot `canvas_item` shader
 * code through the whole item-space path on the real GPU: `@godot-scene-web/effects`'
 * `transpileGodotItemShader` (in the page), the Rust `canvas-items` executor's program compile and
 * binding, and a `PDL1` list into Godot's non-transparent RGB10_A2 target (`Target::opaque`). The
 * TypeScript executor has no item-space programs, so the reference is a hand model: every
 * expected pixel below is the shader's arithmetic done by hand (in f32 where it matters) and
 * converted the way the target and its readback convert (`round(v·1023)` to 10 bits, then
 * `round(q·255/1023)`; alpha's 2 bits `round(a·3)`, read `round(q·255/3)`).
 *
 * The shader text is the code a Godot RenderingServer receives (whitespace runs collapsed,
 * includes expanded between `@@>`/`@@<` markers), including the gate 5.5c and gate 6 shaders the
 * render-stream fixtures use (`tint`, `phase`, `types`, `pal`, `inst`, `phase_tint`, `burn`),
 * written out here so the package needs nothing outside it.
 *
 * Pure data: no DOM, imported by the page and by the test.
 */

import {
  type ItemsCase,
  type QuadOptions,
  quad,
  type Rgba,
  texture,
} from "./canvas-items-cases";

export interface ProgramSpec {
  id: number;
  /** Godot shader code; `null`: a module that is not GLSL (the compile-failure case). */
  code: string | null;
}

export interface BindingSpec {
  slot: number;
  program: number;
  post_modulate?: Rgba;
  uniforms?: { name: string; float?: number[]; int?: number[] }[];
  samplers?: { name: string; texture: number; sampler: number }[];
}

export interface Expectation {
  /** `[x, y, w, h]`, target pixels. */
  rect: readonly [number, number, number, number];
  /** The 8-bit readback the hand model predicts. */
  rgba: Rgba;
  /** Allowed per-channel difference (0 everywhere but a blend-unit product, see `opaqueBlends`). */
  maxDelta: number;
  why: string;
}

export interface ProgramCase {
  name: string;
  items: ItemsCase;
  programs: ProgramSpec[];
  bindings: BindingSpec[];
  expect: Expectation[];
  /** Programs whose definition must fail. */
  failing?: number[];
  /** Draws the executor must skip. */
  skipped?: number;
  /** An executor sabotage (`Sabotage::parse`) the case runs under; its expectations are the
   * sabotaged arithmetic, so the honest cases' values cannot pass it. */
  sabotage?: string;
}

const server = (text: string): string => text.replace(/[ \t]+/g, " ");

const TINT = server(`shader_type canvas_item;

@@>res://inc/common.gdshaderinc
vec4 grid(vec4 c) {
	return vec4(c.rgb, 1.0);
}

@@<res://inc/common.gdshaderinc

uniform vec4 tint = vec4(1.0);
uniform float gain = 1.0;

void fragment() {
	COLOR = grid(tint * gain);
}
`);
const PHASE = server(`shader_type canvas_item;

uniform int phase;

void fragment() {
	int p = phase % 6;
	COLOR = vec4(float(p) * 0.2, float(5 - p) * 0.2, 0.4, 1.0);
}
`);
const TYPES = server(`shader_type canvas_item;

uniform bool on;
uniform int k;
uniform float f;
uniform vec2 v2;
uniform vec3 v3;
uniform ivec2 iv;
uniform float lv[4];

void fragment() {
	COLOR = on ? vec4(v2.x, v3.y, lv[k], 1.0) : vec4(f, float(iv.y) * 0.2, 0.0, 1.0);
}
`);
const PAL = server(`shader_type canvas_item;

uniform sampler2D pal : filter_nearest;
uniform vec4 mul = vec4(1.0);

void fragment() {
	COLOR = texture(pal, UV) * mul;
}
`);
const INST = server(`shader_type canvas_item;

instance uniform vec4 inst_color = vec4(1.0);

void fragment() {
	COLOR = vec4(inst_color.rgb, 1.0);
}
`);
const PHASE_TINT = server(`shader_type canvas_item;

uniform int phase;
uniform vec4 tint;

void fragment() {
	COLOR = vec4(tint.rgb * (float(phase % 6) * 0.2), 1.0);
}
`);
const BURN = server(`shader_type canvas_item;

uniform int iterations;

void fragment() {
	float acc = 0.0;
	vec2 p = UV;
	for (int i = 0; i < iterations; i++) {
		acc += fract(sin(dot(p, vec2(12.9898, 78.233)) + float(i)) * 43758.5453);
		p += vec2(0.001 * acc, 0.0);
	}
	COLOR = vec4(0.0, 0.0, 0.0, step(1e9, acc));
}
`);
/** Reads the incoming COLOR (vertex colour × item modulate × texel). Every expected value below
 * keeps clear of a 10-bit rounding tie (0.5·1023 = 511.5 is one). */
const QUARTER = server(`shader_type canvas_item;

void fragment() {
	COLOR = vec4(COLOR.rgb * 0.25, 1.0);
}
`);
/** Halves the incoming colour and keeps its alpha (G7tm: the MSDF coverage enters as COLOR.a). */
const HALF_KEEP_ALPHA = server(`shader_type canvas_item;

void fragment() {
	COLOR = vec4(COLOR.rgb * 0.5, COLOR.a);
}
`);
/** Samples the item's own texture. */
const OWN_TEXTURE = server(`shader_type canvas_item;

void fragment() {
	COLOR = texture(TEXTURE, UV);
}
`);

const f32 = Math.fround;
/** The RGB10_A2 target's value of `v` as its 8-bit readback. */
export const level = (v: number): number =>
  Math.round((Math.round(Math.min(1, Math.max(0, v)) * 1023) * 255) / 1023);
/** Alpha's 2 bits as read back. */
export const alphaLevel = (a: number): number =>
  Math.round((Math.round(Math.min(1, Math.max(0, a)) * 3) * 255) / 3);
const px = (r: number, g: number, b: number, a = 1): Rgba => [
  level(r),
  level(g),
  level(b),
  alphaLevel(a),
];

const S = 64;
const CLEAR: Rgba = [0.2, 0.2, 0.4, 1];
const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
const WHITE: Rgba = [1, 1, 1, 1];
const NEAREST_CLAMP = 0;

function scene(
  name: string,
  meshes: ItemsCase["meshes"],
  textures: ItemsCase["textures"] = [],
  modulates: Rgba[] = [WHITE],
): ItemsCase {
  return {
    name,
    width: S,
    height: S,
    format: "rgb10a2",
    opaque: true,
    clear: CLEAR,
    textures,
    meshes,
    frames: [modulates.map((modulate) => ({ xform: IDENTITY, modulate }))],
  };
}

const at = (x: number, y: number, w: number, h: number, options: QuadOptions) =>
  quad(x, y, w, h, options);

/** 2x2 straight, opaque: red, green / blue, white. */
const QUADRANTS = texture(2, 2, 2, [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [255, 255, 255, 255],
]);

function quadrants(
  x: number,
  y: number,
  scale: Rgba,
  why: string,
): Expectation[] {
  const c = (r: number, g: number, b: number): Rgba =>
    px(r * scale[0], g * scale[1], b * scale[2]);
  return [
    { rect: [x, y, 8, 8], rgba: c(1, 0, 0), maxDelta: 0, why: `${why} TL` },
    { rect: [x + 8, y, 8, 8], rgba: c(0, 1, 0), maxDelta: 0, why: `${why} TR` },
    { rect: [x, y + 8, 8, 8], rgba: c(0, 0, 1), maxDelta: 0, why: `${why} BL` },
    {
      rect: [x + 8, y + 8, 8, 8],
      rgba: c(1, 1, 1),
      maxDelta: 0,
      why: `${why} BR`,
    },
  ];
}

// ---- G7tm: the MSDF program (canvas.glsl:562-618) ------------------------------------------

/** A uniform MSDF texel: every sample of it is exact under either filter, so the hand model is
 * the shader's arithmetic on one texel. Distances r 0.6, g 0.45, b ~0.549 (median b, max r) and
 * a ~0.502 (the true distance an outline uses). */
const MSDF_TEXEL: Rgba = [153, 115, 140, 128];
const msdfTexture = (id: number, side: number) =>
  texture(
    id,
    side,
    side,
    Array.from({ length: side * side }, () => MSDF_TEXEL),
  );
const unit = (v: number) => f32(v / 255);
/** canvas.glsl's coverage for an axis-aligned `quad`-px quad over a whole `side`-texel texture:
 * `fwidth(uv) = (1/quad, 1/quad)` exactly, so `px_size = max(0.5·(pr/side·quad + pr/side·quad), 1)`. */
function msdfCoverage(
  pr: number,
  outline: number,
  side: number,
  quadPx: number,
  median = true,
): number {
  const [r, g, b, a] = MSDF_TEXEL.map(unit);
  const dest = f32(1 / f32(1 / quadPx));
  const per = f32(f32(pr) / side);
  const pxSize = Math.max(f32(0.5 * f32(f32(per * dest) + f32(per * dest))), 1);
  let d = median
    ? Math.max(Math.min(r, g), Math.min(Math.max(r, g), b))
    : Math.min(r, g, b);
  if (outline > 0) {
    const cr = f32(Math.min(Math.max(outline, 0), f32(pr / 2) - 1) / f32(pr));
    d = Math.min(d, a);
    return Math.min(Math.max(f32(f32(f32(d - 0.5) + cr) * pxSize), 0), 1);
  }
  return Math.min(Math.max(f32(f32(f32(d - 0.5) * pxSize) + 0.5), 0), 1);
}
/** A straight colour `c` at coverage-scaled alpha `a`, MIX-blended (premultiplied in the shader,
 * `ONE, ONE_MINUS_SRC_ALPHA`) over the clear on the opaque target. */
const over = (c: readonly number[], a: number): Rgba =>
  px(
    c[0] * a + CLEAR[0] * (1 - a),
    c[1] * a + CLEAR[1] * (1 - a),
    c[2] * a + CLEAR[2] * (1 - a),
    1,
  );

function msdfCases(): ProgramCase[] {
  const violet: Rgba = [0.4, 0.2, 0.6, 1];
  const items = (name: string) =>
    scene(
      name,
      [
        // Vertex colour × modulate, the texel's colour NOT multiplied in.
        at(4, 4, 16, 16, {
          texture: 1,
          filter: "linear",
          colors: [violet, violet, violet, violet],
          msdf: [1, 0],
        }),
        // An outline pass: min(median, a) with cr = clamp(1.5, 0, 8/2 - 1) / 8.
        at(28, 4, 16, 16, { texture: 2, filter: "linear", msdf: [8, 1.5] }),
        // px_size below 1 is held at 1.
        at(4, 28, 16, 16, { texture: 1, filter: "linear", msdf: [0.0625, 0] }),
        // Through an item-space program: canvas.glsl's MSDF branch runs before the fragment code.
        at(28, 28, 16, 16, {
          texture: 1,
          filter: "linear",
          msdf: [1, 0],
          program: 1,
          item: 1,
        }),
        // Twice the screen size: px_size follows 1 / fwidth(uv).
        at(0, 48, 32, 16, {
          texture: 1,
          filter: "linear",
          msdf: [1, 0],
          uv: [0, 0, 1, 0.5],
        }),
      ],
      [msdfTexture(1, 4), msdfTexture(2, 32)],
      [WHITE, [1, 0.5, 1, 1]],
    );
  const expect = (no: boolean): Expectation[] => {
    const cov = (pr: number, o: number, side: number, q: number) =>
      msdfCoverage(pr, o, side, q, !no);
    return [
      {
        rect: [4, 4, 16, 16],
        rgba: over(violet, cov(1, 0, 4, 16)),
        maxDelta: 1,
        why: `plain: coverage ${cov(1, 0, 4, 16)} into alpha, vertex colour only`,
      },
      {
        rect: [28, 4, 16, 16],
        rgba: over([1, 1, 1], cov(8, 1.5, 32, 16)),
        maxDelta: 1,
        why: `outline: min(median, a), cr = 0.1875, coverage ${cov(8, 1.5, 32, 16)}`,
      },
      {
        rect: [4, 28, 16, 16],
        rgba: over([1, 1, 1], cov(0.0625, 0, 4, 16)),
        maxDelta: 1,
        why: `px_size held at 1: coverage ${cov(0.0625, 0, 4, 16)}`,
      },
      {
        rect: [28, 28, 16, 16],
        // Modulate (1, 0.5, 1), then the program halves the colour and keeps alpha.
        rgba: over([0.5, 0.25, 0.5], cov(1, 0, 4, 16)),
        maxDelta: 1,
        why: `through a program: COLOR.a enters as coverage ${cov(1, 0, 4, 16)}`,
      },
      {
        // The quad spans 32 px for 4 texels across and 16 px for 2 down: fwidth (1/32, 1/32).
        rect: [0, 48, 32, 16],
        rgba: over([1, 1, 1], cov(1, 0, 4, 32)),
        maxDelta: 1,
        why: `twice the screen size: coverage ${cov(1, 0, 4, 32)}`,
      },
    ];
  };
  const programs = [{ id: 1, code: HALF_KEEP_ALPHA }];
  const bindings: BindingSpec[] = [
    { slot: 0, program: 1, post_modulate: [1, 1, 1, 1] },
  ];
  return [
    {
      name: "msdfCoverage",
      items: items("msdfCoverage"),
      programs,
      bindings,
      expect: expect(false),
    },
    {
      // The sabotage's own arithmetic (min of three): the honest median's values fail it.
      name: "msdfNoMedianSabotage",
      items: items("msdfNoMedianSabotage"),
      programs,
      bindings,
      expect: expect(true),
      sabotage: "msdf-no-median",
    },
  ];
}

// ---- P3-VX: programs with their own vertex stage (canvas.glsl:179-280) ----------------------

const VERTEX_SHIFT = server(`shader_type canvas_item;
varying vec4 c;
void vertex() {
	VERTEX.x += 16.0;
	c = COLOR;
}
void fragment() {
	COLOR = vec4(c.rgb * 0.6, 1.0);
}
`);
const SKIP_PLAIN = server(`shader_type canvas_item;
render_mode skip_vertex_transform;
void fragment() {
	COLOR = vec4(0.8, 0.1, 0.1, 1.0);
}
`);
const SKIP_MODEL = server(`shader_type canvas_item;
render_mode skip_vertex_transform;
void vertex() {
	VERTEX = (MODEL_MATRIX * vec4(VERTEX, 0.0, 1.0)).xy + vec2(8.0, 0.0);
}
void fragment() {
	COLOR = vec4(0.1, 0.8, 0.1, 1.0);
}
`);
const FLAT = server(`shader_type canvas_item;
varying flat vec4 f;
void vertex() {
	f = COLOR;
}
void fragment() {
	COLOR = f;
}
`);
const UV_FLIP = server(`shader_type canvas_item;
void vertex() {
	UV = vec2(1.0) - UV;
}
`);
const WORLD = server(`shader_type canvas_item;
render_mode world_vertex_coords;
void vertex() {
	VERTEX.x += 8.0;
}
void fragment() {
	COLOR = vec4(0.1, 0.45, 0.8, 1.0);
}
`);
const PIXEL_SIZE = server(`shader_type canvas_item;
void vertex() {
	VERTEX.x += 4.0 / TEXTURE_PIXEL_SIZE.x;
}
void fragment() {
	COLOR = vec4(TEXTURE_PIXEL_SIZE.y * 1.2, 0.25, 0.1, 1.0);
}
`);

/** Column-major `mat4` of a 2D translation. */
const translation = (x: number, y: number): number[] => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  0,
  1,
];

function vertexCase(): ProgramCase {
  const V = 96;
  const red: Rgba = [0.8, 0.1, 0.1, 1];
  const green: Rgba = [0.1, 0.8, 0.1, 1];
  const blue: Rgba = [0.1, 0.1, 0.8, 1];
  const grey: Rgba = [0.7, 0.7, 0.7, 1];
  const clear = px(CLEAR[0], CLEAR[1], CLEAR[2]);
  const meshes = [
    at(4, 4, 8, 8, { item: 0, program: 1 }),
    at(36, 4, 8, 8, { item: 1, program: 2 }),
    at(4, 4, 8, 8, { item: 2, program: 3 }),
    at(36, 36, 16, 16, {
      item: 3,
      program: 4,
      colors: [red, green, blue, grey],
    }),
    at(4, 48, 16, 16, { item: 4, program: 5, texture: 2 }),
    at(4, 4, 8, 8, { item: 5, program: 6 }),
    at(4, 80, 8, 8, { item: 6, program: 7, texture: 2 }),
  ];
  const item = (
    xform: readonly [number, number, number, number, number, number],
    modulate: Rgba = WHITE,
  ) => ({ xform, modulate });
  const items: ItemsCase = {
    name: "programVertex",
    width: V,
    height: V,
    format: "rgb10a2",
    opaque: true,
    clear: CLEAR,
    textures: [QUADRANTS],
    meshes,
    frames: [
      [
        item(IDENTITY, [1, 0.5, 1, 1]),
        item([1, 0, 0, 1, 0, 16]),
        item([1, 0, 0, 1, 0, 32]),
        item(IDENTITY),
        item(IDENTITY),
        // final = canvas (translate 48, 0) · model (scale 2, translate 0, 64).
        item([2, 0, 0, 2, 48, 64]),
        item(IDENTITY),
      ],
    ],
  };
  const programs = [
    VERTEX_SHIFT,
    SKIP_PLAIN,
    SKIP_MODEL,
    FLAT,
    UV_FLIP,
    WORLD,
    PIXEL_SIZE,
  ].map((code, k) => ({ id: k + 1, code }));
  const bindings: BindingSpec[] = programs.map((p, k) => ({
    slot: k,
    program: p.id,
    ...(p.code === WORLD
      ? {
          uniforms: [
            { name: "gsw_canvas_matrix", float: translation(48, 0) },
            { name: "gsw_canvas_inverse", float: translation(-48, 0) },
          ],
        }
      : {}),
  }));
  return {
    name: "programVertex",
    items,
    programs,
    bindings,
    expect: [
      {
        rect: [20, 4, 8, 8],
        rgba: px(0.6, f32(0.5 * f32(0.6)), 0.6),
        maxDelta: 0,
        why: "VERTEX displaced before the model transform; COLOR is the vertex colour × the modulate (1, .5, 1) before vertex(), through a smooth varying",
      },
      {
        rect: [4, 4, 8, 8],
        rgba: clear,
        maxDelta: 0,
        why: "A's own place stays clear",
      },
      {
        rect: [36, 4, 8, 8],
        rgba: px(0.8, 0.1, 0.1),
        maxDelta: 0,
        why: "skip_vertex_transform with no vertex(): the item's translation (0, 16) is never applied",
      },
      {
        rect: [36, 20, 8, 8],
        rgba: clear,
        maxDelta: 0,
        why: "B's transformed place stays clear",
      },
      {
        rect: [12, 36, 8, 8],
        rgba: px(0.1, 0.8, 0.1),
        maxDelta: 0,
        why: "skip_vertex_transform: the code applies MODEL_MATRIX itself, then shifts 8",
      },
      {
        rect: [46, 37, 5, 3],
        rgba: px(0.1, 0.1, 0.8),
        maxDelta: 0,
        why: "flat varying: triangle (TL, TR, BR) takes its provoking (last) vertex, BR",
      },
      {
        rect: [37, 46, 3, 5],
        rgba: px(0.7, 0.7, 0.7),
        maxDelta: 0,
        why: "flat varying: triangle (TL, BR, BL) takes BL",
      },
      {
        rect: [4, 48, 8, 8],
        rgba: px(1, 1, 1),
        maxDelta: 0,
        why: "UV flipped in vertex(): TL shows texel (1,1)",
      },
      {
        rect: [12, 48, 8, 8],
        rgba: px(0, 0, 1),
        maxDelta: 0,
        why: "UV flipped: TR shows texel (0,1)",
      },
      {
        rect: [4, 56, 8, 8],
        rgba: px(0, 1, 0),
        maxDelta: 0,
        why: "UV flipped: BL shows texel (1,0)",
      },
      {
        rect: [12, 56, 8, 8],
        rgba: px(1, 0, 0),
        maxDelta: 0,
        why: "UV flipped: BR shows texel (0,0)",
      },
      {
        rect: [64, 72, 16, 16],
        rgba: px(0.1, 0.45, 0.8),
        maxDelta: 0,
        why: "world_vertex_coords: model (scale 2) applied before the code's +8, then the binding's canvas matrix (translate 48)",
      },
      {
        rect: [80, 72, 8, 16],
        rgba: clear,
        maxDelta: 0,
        why: "where +8 before the model would land",
      },
      {
        rect: [12, 80, 8, 8],
        rgba: px(f32(0.5 * f32(1.2)), 0.25, 0.1),
        maxDelta: 0,
        why: "TEXTURE_PIXEL_SIZE is 1 / the 2x2 texture's size in both stages",
      },
    ],
  };
}

export function buildProgramCases(): ProgramCase[] {
  return [
    ...msdfCases(),
    vertexCase(),
    {
      name: "programTint",
      items: scene("programTint", [
        at(4, 4, 16, 16, { program: 1 }),
        at(28, 4, 16, 16, { program: 2 }),
      ]),
      programs: [{ id: 1, code: TINT }],
      bindings: [
        {
          slot: 0,
          program: 1,
          uniforms: [
            { name: "tint", float: [0.2, 0.4, 0.2, 1] },
            { name: "gain", float: [2] },
          ],
        },
        {
          // The declared defaults: tint vec4(1.0), gain 1.0.
          slot: 1,
          program: 1,
          uniforms: [
            { name: "tint", float: [1, 1, 1, 1] },
            { name: "gain", float: [1] },
          ],
        },
      ],
      expect: [
        {
          rect: [4, 4, 16, 16],
          rgba: px(f32(f32(0.2) * 2), f32(f32(0.4) * 2), f32(f32(0.2) * 2)),
          maxDelta: 0,
          why: "grid(tint * gain) through an @@-include helper",
        },
        {
          rect: [28, 4, 16, 16],
          rgba: px(1, 1, 1),
          maxDelta: 0,
          why: "the declared defaults",
        },
        {
          rect: [48, 48, 8, 8],
          rgba: px(0.2, 0.2, 0.4),
          maxDelta: 0,
          why: "clear",
        },
      ],
    },
    {
      name: "programIntTypes",
      items: scene("programIntTypes", [
        at(4, 4, 12, 12, { program: 1 }),
        at(20, 4, 12, 12, { program: 2 }),
        at(36, 4, 12, 12, { program: 3 }),
      ]),
      programs: [
        { id: 1, code: PHASE },
        { id: 2, code: TYPES },
      ],
      bindings: [
        { slot: 0, program: 1, uniforms: [{ name: "phase", int: [8] }] },
        {
          slot: 1,
          program: 2,
          uniforms: [
            { name: "on", int: [1] },
            { name: "k", int: [2] },
            { name: "f", float: [0] },
            { name: "v2", float: [0.4, 0] },
            { name: "v3", float: [0, 0.8, 0] },
            { name: "iv", int: [0, 0] },
            { name: "lv", float: [0.1, 0.2, 0.75, 0.4] },
          ],
        },
        {
          slot: 2,
          program: 2,
          uniforms: [
            { name: "on", int: [0] },
            { name: "k", int: [0] },
            { name: "f", float: [0.6] },
            { name: "v2", float: [0, 0] },
            { name: "v3", float: [0, 0, 0] },
            { name: "iv", int: [0, 3] },
            { name: "lv", float: [0, 0, 0, 0] },
          ],
        },
      ],
      expect: [
        {
          rect: [4, 4, 12, 12],
          // p = 8 % 6 = 2: (2·0.2, (5-2)·0.2, 0.4), integer % and int arithmetic.
          rgba: px(f32(2 * f32(0.2)), f32(3 * f32(0.2)), 0.4),
          maxDelta: 0,
          why: "phase: int modulo and int subtraction",
        },
        {
          rect: [20, 4, 12, 12],
          rgba: px(0.4, 0.8, 0.75),
          maxDelta: 0,
          why: "types on: lv[k] dynamic index into a uniform float array",
        },
        {
          rect: [36, 4, 12, 12],
          rgba: px(0.6, f32(3 * f32(0.2)), 0),
          maxDelta: 0,
          why: "types off: float(iv.y) from an ivec2",
        },
      ],
    },
    {
      name: "programSampler",
      items: scene(
        "programSampler",
        [at(4, 4, 16, 16, { program: 1 }), at(28, 4, 16, 16, { program: 2 })],
        [QUADRANTS],
      ),
      programs: [{ id: 1, code: PAL }],
      bindings: [
        {
          slot: 0,
          program: 1,
          uniforms: [{ name: "mul", float: [1, 1, 1, 1] }],
          samplers: [{ name: "pal", texture: 2, sampler: NEAREST_CLAMP }],
        },
        {
          slot: 1,
          program: 1,
          uniforms: [{ name: "mul", float: [0.75, 0.25, 0.375, 1] }],
          samplers: [{ name: "pal", texture: 2, sampler: NEAREST_CLAMP }],
        },
      ],
      expect: [
        ...quadrants(4, 4, [1, 1, 1, 1], "pal × (1,1,1,1)"),
        ...quadrants(
          28,
          4,
          [0.75, 0.25, 0.375, 1],
          "pal × (0.75,0.25,0.375,1)",
        ),
      ],
    },
    {
      name: "programInstance",
      items: scene(
        "programInstance",
        [
          at(4, 4, 16, 16, { program: 1 }),
          at(28, 4, 16, 16, { program: 2, item: 1 }),
        ],
        [],
        [WHITE, WHITE],
      ),
      programs: [{ id: 1, code: INST }],
      bindings: [
        {
          slot: 0,
          program: 1,
          uniforms: [{ name: "inst_color", float: [0.2, 0.8, 0.4, 1] }],
        },
        {
          slot: 1,
          program: 1,
          uniforms: [{ name: "inst_color", float: [0.8, 0.2, 0.6, 1] }],
        },
      ],
      expect: [
        {
          rect: [4, 4, 16, 16],
          rgba: px(0.2, 0.8, 0.4),
          maxDelta: 0,
          why: "item 0's value",
        },
        {
          rect: [28, 4, 16, 16],
          rgba: px(0.8, 0.2, 0.6),
          maxDelta: 0,
          why: "item 1's value",
        },
      ],
    },
    {
      name: "programColorInput",
      items: scene(
        "programColorInput",
        [
          at(4, 4, 16, 16, {
            program: 1,
            colors: [
              [0.8, 0.4, 0.2, 1],
              [0.8, 0.4, 0.2, 1],
              [0.8, 0.4, 0.2, 1],
              [0.8, 0.4, 0.2, 1],
            ],
          }),
          at(28, 4, 16, 16, { program: 2, texture: 2, item: 1 }),
        ],
        [QUADRANTS],
        [
          [1, 0.5, 1, 1],
          [1, 1, 1, 1],
        ],
      ),
      programs: [
        { id: 1, code: QUARTER },
        { id: 2, code: OWN_TEXTURE },
      ],
      bindings: [
        // post_modulate: a canvas modulate applied after the code (Godot's canvas_modulation).
        { slot: 0, program: 1, post_modulate: [0.5, 1, 1, 1] },
        { slot: 1, program: 2 },
      ],
      expect: [
        {
          rect: [4, 4, 16, 16],
          // COLOR = vertex (0.8,0.4,0.2) × modulate (1,0.5,1) = (0.8,0.2,0.2); × 0.25; × post
          // (0.5,1,1).
          rgba: px(
            f32(f32(f32(0.8) * 0.25) * 0.5),
            f32(f32(f32(0.4) * 0.5) * 0.25),
            f32(f32(0.2) * 0.25),
          ),
          maxDelta: 0,
          why: "COLOR in is vertex colour × modulate; the canvas modulate comes after",
        },
        ...quadrants(28, 4, [1, 1, 1, 1], "TEXTURE is the item's own texture"),
      ],
    },
    {
      name: "programGate6",
      items: scene("programGate6", [
        at(4, 4, 16, 16, { program: 1 }),
        at(28, 4, 16, 16, { program: 2 }),
      ]),
      programs: [
        { id: 1, code: PHASE_TINT },
        { id: 2, code: BURN },
      ],
      bindings: [
        {
          slot: 0,
          program: 1,
          uniforms: [
            { name: "phase", int: [9] },
            { name: "tint", float: [1, 0.5, 0.25, 1] },
          ],
        },
        { slot: 1, program: 2, uniforms: [{ name: "iterations", int: [3] }] },
      ],
      expect: [
        {
          rect: [4, 4, 16, 16],
          // phase 9 % 6 = 3: tint.rgb × 0.6.
          rgba: px(
            f32(1 * f32(3 * f32(0.2))),
            f32(0.5 * f32(3 * f32(0.2))),
            f32(0.25 * f32(3 * f32(0.2))),
          ),
          maxDelta: 0,
          why: "phase_tint",
        },
        {
          rect: [28, 4, 16, 16],
          rgba: px(0.2, 0.2, 0.4),
          maxDelta: 0,
          why: "burn: alpha step(1e9, acc) = 0, the target unchanged",
        },
      ],
    },
    {
      name: "programCompileFailure",
      items: scene("programCompileFailure", [
        at(4, 4, 16, 16, { program: 1 }),
        at(28, 4, 16, 16, { program: 2 }),
      ]),
      programs: [
        { id: 1, code: QUARTER },
        { id: 9, code: null },
      ],
      bindings: [
        { slot: 0, program: 1 },
        { slot: 1, program: 9 },
      ],
      failing: [9],
      skipped: 1,
      expect: [
        {
          rect: [4, 4, 16, 16],
          rgba: px(0.25, 0.25, 0.25),
          maxDelta: 0,
          why: "the program that compiled",
        },
        {
          rect: [28, 4, 16, 16],
          rgba: px(0.2, 0.2, 0.4),
          maxDelta: 0,
          why: "a binding of a program that failed to compile is not drawn",
        },
      ],
    },
    {
      name: "opaqueBlends",
      items: scene("opaqueBlends", [
        at(0, 0, 64, 32, {
          colors: [
            [0.4, 0.6, 0.2, 1],
            [0.4, 0.6, 0.2, 1],
            [0.4, 0.6, 0.2, 1],
            [0.4, 0.6, 0.2, 1],
          ],
        }),
        at(4, 4, 16, 16, {
          blend: "mul",
          colors: [
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
          ],
        }),
        at(28, 4, 16, 16, {
          blend: "disabled",
          colors: [
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
            [0.4, 0.2, 0.6, 0.6],
          ],
        }),
        at(4, 40, 16, 16, {
          blend: "mul",
          colors: [
            [0.5, 0.25, 0.75, 0.6],
            [0.5, 0.25, 0.75, 0.6],
            [0.5, 0.25, 0.75, 0.6],
            [0.5, 0.25, 0.75, 0.6],
          ],
        }),
      ]),
      programs: [],
      bindings: [],
      expect: [
        {
          rect: [4, 4, 16, 16],
          // GL_DST_COLOR × the STRAIGHT source, alpha kept (GL_ZERO, GL_ONE).
          rgba: px(0.4 * 0.4, 0.6 * 0.2, 0.2 * 0.6, 1),
          maxDelta: 1,
          why: "mul on Godot's non-transparent target: dst × straight src, dst alpha kept (a product in the blend unit: within 1)",
        },
        {
          rect: [28, 4, 16, 16],
          rgba: px(0.4, 0.2, 0.6, 0.6),
          maxDelta: 0,
          why: "disabled: the straight source, its own alpha (2 bits)",
        },
        {
          rect: [4, 40, 16, 16],
          // Over the clear (0.2, 0.2, 0.4): exact binary fractions, so no rounding ambiguity.
          rgba: px(0.2 * 0.5, 0.2 * 0.25, 0.4 * 0.75, 1),
          maxDelta: 1,
          why: "mul over the clear colour, dst alpha kept",
        },
      ],
    },
  ];
}

export function programCaseByName(name: string): ProgramCase {
  const c = buildProgramCases().find((x) => x.name === name);
  if (!c) throw new Error(`no program case ${name}`);
  return c;
}
