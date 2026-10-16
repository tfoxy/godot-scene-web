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

export function buildProgramCases(): ProgramCase[] {
  return [
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
