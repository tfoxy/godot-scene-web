#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Q7's pixel policy for the GSW canvas receiver (gate7-design.md Q7, D8, G7a): per gate and step,
// the masks the hand model does not decide exactly, derived from each gate's OWN expected.json and
// models, never from a GSW run, and committed as fixtures/gsw-tolerance.json.
//
//   delta1     translucent blends: Godot blends straight alpha in the blend unit
//              (SRC_ALPHA, ONE_MINUS_SRC_ALPHA), GSW premultiplied in the shader (ONE,
//              ONE_MINUS_SRC_ALPHA); equal in exact arithmetic, a level apart after rounding
//              (memory g7c-gpu-blend-conversion-facts). Channel <= 1, any count.
//   undecided  linearly filtered texture draws (the hand model samples texel centres only) and,
//              for gate 3c, the rotated-edge band of gate3x-expected.ts (`band_px` around every
//              non-axis-aligned edge, where the rasterizer's own edge rule decides). Diffs are
//              allowed only inside, counted and reported.
//   excluded   (G7t) the regions of an op GSW types (Q7's last row). Any difference, counted; the
//              typed reason is judged by its own check. No region is excluded since G7tm drew
//              gate 4e's MSDF text (`gsw-msdf` retired).
//   decided    every other pixel: channel 0, pixels 0 (P-G1).
//
// G7t adds gates 4 and 5. Gate 4's glyph boxes (each step's `text_regions`) are `delta1`: glyph
// coverage is partial alpha blended over what is below (P-G2 predicts exact, and gate7-gsw-g45.ts
// reports it per glyph box). G7tm puts gate 4e's MSDF glyph boxes in the same class: the MSDF
// coverage is canvas.glsl's own arithmetic, multiplied into alpha and blended the same way. Gate 5's masks are per pixel, from the gate's own rasterizer
// (geometry-raster.ts over make_expected.py's lowering, D13): pixels it decides within 1
// (interpolated colours, blends, off-grid texels) and antialiased shapes' feather bands are
// `delta1`; thin GL lines' bands, gate 5e's band region and every pixel it leaves undecided (edges
// within 1/16 px) are `undecided`. Those masks are synthesized when used; the committed document
// records their pixel counts per step, so --check pins the derivation.
//
// G7g adds gate 6 the same way, one raster of the gate's own model per SHOT rather than per step
// (`gate6`, `gate6-refused`: gate6-expected.ts rasterOfShot over the scene's default and refused
// variants; `gate6-hd-native`, `gate6-hd-half`: gate6h-checks.ts rasterOfShotHd at each
// presentation's scale and half op lists): the AN sprite, the MS mesh and the PB bar move between
// a settle shot and the mid shots. Gate 6's undecided boxes (text, the RichTextLabel, RF) are
// `undecided`; its feathers (HB's radius panel, the StyleBoxFlat AA bands) are `delta1`.
//
// Gates 0, 1 and 3 (main) draw opaque axis-aligned rects only: every pixel is decided. Gate 2's
// masks come from its expected.json: each draw's sampled texture content (alpha uniform or not,
// partial or not) and the filter in force (the `default_filter` and per-item `filter` invariants).
// Gate 5.5's (G7s) come from gate55-cim's op lists: each op whose blend multiplies source and
// destination in the blend unit (`gate55cim`); gate55-shader draws opaque fills only.
//
//   tsx --conditions=development experiments/render-stream/scripts/lib/gsw-tolerance.ts --write
//   tsx --conditions=development experiments/render-stream/scripts/lib/gsw-tolerance.ts --check
// --check regenerates the document and requires it byte-identical to the committed file.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Gate3xExpected } from "./gate3x-expected";
import { synthesizeGate3x } from "./gate3x-expected";
import type { Gate4Expected } from "./gate4-expected";
import { rastersOf } from "./gate5-checks";
import type { Gate5Expected } from "./gate5-expected";
import { type Gate5MeshExpected, meshRasters } from "./gate5c-checks";
import {
  type Gate6Expected,
  rasterOfShot,
  refusedView,
} from "./gate6-expected";
import { type Gate6HdExpected, rasterOfShotHd } from "./gate6h-checks";
import type { Gate5Raster } from "./geometry-raster";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "fixtures");
export const TOLERANCE_PATH = join(FIXTURES, "gsw-tolerance.json");

export type Rect = [number, number, number, number];

export interface StepMasks {
  step: number;
  delta1: { region: string; rect: Rect; why: string }[];
  undecided: { region: string; rect: Rect; why: string }[];
  /** gate 3c: the band's pixel count (gate3x-expected.ts synthesizeGate3x, `band_px`). */
  band_pixels?: number;
  /** G7t: regions of an op GSW types (Q7's last row), with the typed reason. */
  excluded?: { region: string; rect: Rect; why: string; reason: string }[];
  /** G7t: the synthesized per-pixel masks' sizes (gate 5's rasterizer; `raster` below). */
  raster_pixels?: { delta1: number; undecided: number };
}

/** A gate whose masks are synthesized per pixel by its own rasterizer (G7t). */
export type RasterKey = "gate5" | "gate5-mesh" | "gate5-style" | Gate6RasterKey;

/** G7g: gate 6's per-shot rasters. Their `step` is the shot's index in the fixture's
 * expected.json `shots` (settle and mid shots alike: AN, MS and PB move between them). */
export type Gate6RasterKey =
  | "gate6"
  | "gate6-refused"
  | "gate6-hd-native"
  | "gate6-hd-half";

export interface GateTolerance {
  expected: string;
  /** G7t: the per-pixel masks come from this gate's rasterizer (`classMask`). */
  raster?: RasterKey;
  steps: StepMasks[];
}

export interface ToleranceDoc {
  schema: "render-stream-gsw-tolerance/1";
  policy: string[];
  gates: Record<string, GateTolerance>;
}

function json<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;
}

interface TexContent {
  checker?: { even: number[]; odd: number[] };
  fill?: number[];
  rects?: number[][];
}

function alphas(t: TexContent): Set<number> {
  if (t.checker) return new Set([t.checker.even[3], t.checker.odd[3]]);
  return new Set([t.fill?.[3] ?? 255, ...(t.rects ?? []).map((r) => r[7])]);
}

function gate2(): GateTolerance {
  const expected = json<{
    textures: Record<string, TexContent>;
    steps: {
      step: number;
      regions: Record<string, Rect>;
      draws: { name: string; rect_px: Rect; sample?: { texture: string } }[];
      invariants: { kind: string; item?: string; value?: string }[];
    }[];
  }>("gate2/expected.json");
  let defaultFilter = "nearest";
  const itemFilter = new Map<string, string>();
  const steps: StepMasks[] = [];
  for (const s of expected.steps) {
    for (const inv of s.invariants) {
      if (inv.kind === "default_filter" && inv.value) defaultFilter = inv.value;
      if (inv.kind === "filter" && inv.item && inv.value)
        itemFilter.set(inv.item, inv.value);
    }
    // The mask is the draw's own rect inside the region it overlaps (never the whole region:
    // a region holding an opaque backdrop under the draw stays decided outside the draw).
    const delta1: StepMasks["delta1"] = [];
    const undecided: StepMasks["undecided"] = [];
    for (const d of s.draws) {
      if (!d.sample) continue;
      const content = expected.textures[d.sample.texture];
      if (!content) continue;
      const filter = itemFilter.get(d.name) ?? defaultFilter;
      const a = alphas(content);
      const partial = [...a].some((v) => v > 0 && v < 255);
      const [x, y, w, h] = d.rect_px;
      for (const [region, r] of Object.entries(s.regions).sort()) {
        const x0 = Math.max(x, r[0]);
        const y0 = Math.max(y, r[1]);
        const x1 = Math.min(x + w, r[0] + r[2]);
        const y1 = Math.min(y + h, r[1] + r[3]);
        if (x1 <= x0 || y1 <= y0) continue;
        const rect: Rect = [x0, y0, x1 - x0, y1 - y0];
        if (filter.startsWith("linear"))
          undecided.push({
            region,
            rect,
            why: `${d.name} samples ${d.sample.texture} with filter ${filter}`,
          });
        else if (partial)
          delta1.push({
            region,
            rect,
            why: `${d.name} blends ${d.sample.texture} (alpha ${[...a].join("/")}) over what is below`,
          });
      }
    }
    steps.push({ step: s.step, delta1, undecided });
  }
  return { expected: "fixtures/gate2/expected.json", steps };
}

function opaque(rel: string, count: number): GateTolerance {
  return {
    expected: rel,
    steps: Array.from({ length: count }, (_, step) => ({
      step,
      delta1: [],
      undecided: [],
    })),
  };
}

/** G7t: gate 4's glyph boxes. Each step's `text_regions` hold the glyphs a Label draws (gate
 * 4's own synthesis leaves them to the glyph oracle): `delta1`. For gate 4e's MSDF fixture (G7tm)
 * the coverage is the MSDF program's, in the same class. */
function gate4(rel: string, msdf = false): GateTolerance {
  const expected = json<Gate4Expected>(rel);
  return {
    expected: `fixtures/${rel}`,
    steps: expected.steps.map((s) => {
      const boxes = Object.entries(s.text_regions)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([region, b]) => ({
          region,
          rect: [b[0], b[1], b[2] - b[0], b[3] - b[1]] as Rect,
        }));
      return {
        step: s.step,
        delta1: boxes.map((b) => ({
          ...b,
          why: msdf
            ? `${b.region}'s MSDF glyph coverage (canvas.glsl's median and px-range arithmetic, multiplied into alpha) blends over what is below`
            : `${b.region}'s glyph coverage (partial alpha) blends over what is below`,
        })),
        undecided: [],
      };
    }),
  };
}

/** G7t: gate 5's per-pixel masks for one fixture, counted per step. */
function gate5(rel: string, raster: RasterKey): GateTolerance {
  const masks = rasterMasks(raster);
  return {
    expected: `fixtures/${rel}`,
    raster,
    steps: [...masks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([step, cls]) => {
        let d1 = 0;
        let und = 0;
        for (const c of cls) {
          if (c === CLASS_DELTA1) d1++;
          else if (c === CLASS_UNDECIDED) und++;
        }
        return {
          step,
          delta1: [],
          undecided: [],
          raster_pixels: { delta1: d1, undecided: und },
        };
      }),
  };
}

/** G7g: gate 6's `animate` variant (gate6-design.md Q6d) on the default scene's per-shot model.
 * Its continuous writes move or redraw five regions the default shots do not model: SC (the
 * v_scroll triangle wave), LB (the frame counter), CD (`k = ⌊f/15⌋ mod 4`), TR and RT (TEXA's
 * in-place updates). There every pixel the default model decides is `delta1` instead (what is
 * drawn there is decided only up to the blend's rounding, which animate does not change); its
 * undecided pixels stay undecided. Everything else is the default model's, shot for shot. */
const GATE6_ANIMATE_REGIONS = ["SC", "LB", "CD", "TR", "RT"] as const;

function gate6animate(): GateTolerance {
  const e = json<Gate6Expected>("gate6-scene/expected.json");
  const base = gate5("gate6-scene/expected.json", "gate6");
  return {
    ...base,
    steps: base.steps.map((s) => ({
      ...s,
      delta1: GATE6_ANIMATE_REGIONS.map((region) => {
        const b = (e.shots[s.step]?.regions ?? e.regions)[region];
        return {
          region,
          rect: [b[0], b[1], b[2] - b[0], b[3] - b[1]] as Rect,
          why: "animate (Q6d) moves or redraws this region beyond the default model's shots",
        };
      }),
    })),
  };
}

function gate3x(): GateTolerance {
  const expected = json<Gate3xExpected>("gate3-xform/expected.json");
  return {
    expected: "fixtures/gate3-xform/expected.json",
    steps: expected.steps.map((s) => ({
      step: s.step,
      delta1: [],
      undecided: [],
      band_pixels: synthesizeGate3x(expected, s.step).bandPixels,
    })),
  };
}

interface CimOp {
  vertices: [number, number][];
  colors: [number, number, number, number][];
  blend?: string;
}

/** Gate 5.5's CanvasItemMaterial scene (G7s): `delta1` is every op whose blend multiplies in the
 * blend unit, from the fixture's own op lists (the effective blend of each item at each step):
 * a translucent mix, add, sub or premul_alpha, and mul at any alpha. The rendered reference
 * blends in the native GL driver; ANGLE/Vulkan converts the source to the target's levels before
 * the blend (memory g7c-gpu-blend-conversion-facts), so a product of source and destination may
 * round one level apart. An opaque mix, add or sub (a replace or a sum of whole levels) and
 * `disabled` (no blend) stay decided. */
function gate55cim(variant: "base" | "modulate"): GateTolerance {
  const e = json<{
    viewport: [number, number];
    op_lists: Record<string, CimOp[]>;
    variants: Record<
      string,
      {
        steps: {
          step: number;
          items: {
            name: string;
            region: string;
            xform: number[];
            ops: string;
          }[];
        }[];
      }
    >;
  }>("gate55-cim/expected.json");
  const steps: StepMasks[] = [];
  for (const s of e.variants[variant].steps) {
    const delta1: StepMasks["delta1"] = [];
    for (const it of s.items) {
      // `xform` is the item's final translation, the step's canvas transform included.
      for (const op of e.op_lists[it.ops] ?? []) {
        const blend = op.blend ?? "mix";
        const alpha = Math.min(...op.colors.map((c) => c[3]));
        // Alpha 0 (light_only without lights) leaves the destination as it is in both.
        const multiplies =
          alpha > 0 && (blend === "mul" || (alpha < 1 && blend !== "disabled"));
        if (!multiplies) continue;
        const xs = op.vertices.map((v) => v[0] + it.xform[4]);
        const ys = op.vertices.map((v) => v[1] + it.xform[5]);
        const x0 = Math.max(Math.min(...xs), 0);
        const y0 = Math.max(Math.min(...ys), 0);
        const x1 = Math.min(Math.max(...xs), e.viewport[0]);
        const y1 = Math.min(Math.max(...ys), e.viewport[1]);
        if (x1 <= x0 || y1 <= y0) continue;
        delta1.push({
          region: it.region,
          rect: [x0, y0, x1 - x0, y1 - y0],
          why: `${it.name} draws ${blend} at alpha ${alpha.toFixed(3)}`,
        });
      }
    }
    steps.push({ step: s.step, delta1, undecided: [] });
  }
  return { expected: "fixtures/gate55-cim/expected.json", steps };
}

export function deriveTolerance(): ToleranceDoc {
  const g0 = json<{ steps: unknown[] }>("gate0/expected.json");
  const g1 = json<{ steps: unknown[] }>("gate1/expected.json");
  const g3 = json<{ steps: unknown[] }>("gate3/expected.json");
  return {
    schema: "render-stream-gsw-tolerance/1",
    policy: [
      "Q7: G against R. decided pixels: channel 0, pixels 0 (P-G1).",
      "delta1: translucent blends (straight-alpha blend unit vs premultiplied shader output, one rounding apart): channel <= 1, any count (P-G3).",
      "undecided: linearly filtered texture draws, and gate 3c's rotated-edge band: diffs only inside, counted and reported (P-G4).",
      "Masks are derived from each gate's expected.json by scripts/lib/gsw-tolerance.ts, never from a GSW run; widening one to pass is forbidden (D8).",
    ],
    gates: {
      gate0: opaque("fixtures/gate0/expected.json", g0.steps.length),
      gate1: opaque("fixtures/gate1/expected.json", g1.steps.length),
      gate2: gate2(),
      gate3: opaque("fixtures/gate3/expected.json", g3.steps.length),
      "gate3-xform": gate3x(),
      "gate55-cim": gate55cim("base"),
      "gate55-cim-modulate": gate55cim("modulate"),
      // G7s: every gate 5.5c shader writes an opaque fill (make_expected.py: every region exact).
      "gate55-shader": opaque(
        "fixtures/gate55-shader/expected.json",
        json<{ steps: unknown[] }>("gate55-shader/expected.json").steps.length,
      ),
      gate4: gate4("gate4/expected.json"),
      "gate4-layout": gate4("gate4-layout/expected.json"),
      "gate4-rich": gate4("gate4-rich/expected.json"),
      "gate4-i18n": gate4("gate4-i18n/expected.json"),
      "gate4-msdf": gate4("gate4-msdf/expected.json", true),
      gate5: gate5("gate5/expected.json", "gate5"),
      "gate5-mesh": gate5("gate5-mesh/expected.json", "gate5-mesh"),
      "gate5-style": gate5("gate5-style/expected.json", "gate5-style"),
      // G7g: gate 6's scene (default and refused variants) and HD fixture at both presentations.
      gate6: gate5("gate6-scene/expected.json", "gate6"),
      "gate6-animate": gate6animate(),
      "gate6-refused": gate5("gate6-scene/expected.json", "gate6-refused"),
      "gate6-hd-native": gate5("gate6-hd/expected.json", "gate6-hd-native"),
      "gate6-hd-half": gate5("gate6-hd/expected.json", "gate6-hd-half"),
    },
  };
}

// ------------------------------------------------------------------------- per-pixel classes

export const CLASS_DECIDED = 0;
export const CLASS_DELTA1 = 1;
export const CLASS_UNDECIDED = 2;
export const CLASS_EXCLUDED = 3;

/** Gate 5's raster to Q7 classes: decided within 1 or an antialiased shape's feather band ->
 * delta1; a thin line's band, a band region, or undecided -> undecided; else decided. */
function rasterClasses(r: Gate5Raster): Uint8Array {
  const out = new Uint8Array(r.width * r.height);
  for (let i = 0; i < out.length; i++) {
    if (r.exact[i]) out[i] = r.delta[i] > 0 ? CLASS_DELTA1 : CLASS_DECIDED;
    else if (r.band[i] && !r.thin[i]) out[i] = CLASS_DELTA1;
    else out[i] = CLASS_UNDECIDED;
  }
  return out;
}

const rasterCache = new Map<RasterKey, Map<number, Uint8Array>>();

/** Per step, the Q7 class of every pixel of a gate 5 fixture (cached per process). */
export function rasterMasks(key: RasterKey): Map<number, Uint8Array> {
  const hit = rasterCache.get(key);
  if (hit) return hit;
  let rasters: Map<number, Gate5Raster>;
  if (key === "gate6" || key === "gate6-refused") {
    // G7g: one raster per shot of gate 6's own model (gate6-expected.ts), indexed by shot.
    const all = json<Gate6Expected>("gate6-scene/expected.json");
    const e = key === "gate6" ? all : refusedView(all);
    rasters = new Map(e.shots.map((shot, i) => [i, rasterOfShot(e, shot)]));
  } else if (key === "gate6-hd-native" || key === "gate6-hd-half") {
    const e = json<Gate6HdExpected>("gate6-hd/expected.json");
    const pres = key === "gate6-hd-native" ? "native" : "half";
    rasters = new Map(
      e.shots.map((shot, i) => [i, rasterOfShotHd(e, shot, pres)]),
    );
  } else if (key === "gate5-mesh") {
    const e = json<Gate5MeshExpected>("gate5-mesh/expected.json");
    rasters = meshRasters(e);
    // The band region (DF: a texture under a non-affine mapping) is never synthesized.
    const [W] = e.viewport;
    for (const r of rasters.values())
      for (const name of e.band_regions) {
        const b = e.regions[name];
        for (let y = b[1]; y < b[3]; y++)
          for (let x = b[0]; x < b[2]; x++) r.thin[y * W + x] = 1;
      }
  } else {
    rasters = rastersOf(
      json<Gate5Expected>(
        key === "gate5" ? "gate5/expected.json" : "gate5-style/expected.json",
      ),
    );
  }
  const out = new Map<number, Uint8Array>();
  for (const [step, r] of rasters) out.set(step, rasterClasses(r));
  rasterCache.set(key, out);
  return out;
}

/** The Q7 class of every pixel of one step (`width`x`height`, row-major): rect masks, gate 3c's
 * band and gate 5's rasters folded into one array. Where masks overlap the larger class wins
 * (excluded over undecided over delta1). */
export function classMask(
  key: string,
  step: number,
  width: number,
  height: number,
  tol: ToleranceDoc = readTolerance(),
  xform?: Gate3xExpected,
): Uint8Array | null {
  const gate = tol.gates[key];
  const masks = gate?.steps.find((s) => s.step === step);
  if (!gate || !masks) return null;
  const out = gate.raster
    ? new Uint8Array(rasterMasks(gate.raster).get(step) ?? [])
    : new Uint8Array(width * height);
  if (out.length !== width * height) return null;
  const fill = (rects: { rect: Rect }[], c: number) => {
    for (const { rect: r } of rects)
      for (let y = Math.max(0, r[1]); y < Math.min(height, r[1] + r[3]); y++)
        for (let x = Math.max(0, r[0]); x < Math.min(width, r[0] + r[2]); x++)
          out[y * width + x] = Math.max(out[y * width + x], c);
  };
  fill(masks.delta1, CLASS_DELTA1);
  fill(masks.undecided, CLASS_UNDECIDED);
  if (key === "gate3-xform" && xform) {
    const band = synthesizeGate3x(xform, step).band;
    for (let i = 0; i < out.length; i++)
      if (band[i]) out[i] = Math.max(out[i], CLASS_UNDECIDED);
  }
  fill(masks.excluded ?? [], CLASS_EXCLUDED);
  return out;
}

export function readTolerance(): ToleranceDoc {
  return JSON.parse(readFileSync(TOLERANCE_PATH, "utf8")) as ToleranceDoc;
}

export interface Q7Verdict {
  ok: boolean;
  decided_px: number;
  decided_max: number;
  delta1_px: number;
  delta1_max: number;
  undecided_px: number;
  /** G7t: differing pixels in typed (excluded) regions. */
  excluded_px?: number;
}

/** Judges `got` against the reference `ref` under one step's per-pixel classes (`classMask`). */
export function judgeQ7Classes(
  ref: { width: number; height: number; data: Uint8Array },
  got: { width: number; height: number; data: Uint8Array },
  cls: Uint8Array,
): Q7Verdict {
  const v: Q7Verdict = {
    ok: true,
    decided_px: 0,
    decided_max: 0,
    delta1_px: 0,
    delta1_max: 0,
    undecided_px: 0,
    excluded_px: 0,
  };
  for (let i = 0; i < ref.width * ref.height; i++) {
    const o = i * 4;
    let d = 0;
    for (let c = 0; c < 4; c++)
      d = Math.max(d, Math.abs(ref.data[o + c] - got.data[o + c]));
    if (d === 0) continue;
    const c = cls[i];
    if (c === CLASS_EXCLUDED) v.excluded_px = (v.excluded_px ?? 0) + 1;
    else if (c === CLASS_UNDECIDED) v.undecided_px++;
    else if (c === CLASS_DELTA1) {
      v.delta1_px++;
      v.delta1_max = Math.max(v.delta1_max, d);
    } else {
      v.decided_px++;
      v.decided_max = Math.max(v.decided_max, d);
    }
  }
  v.ok = v.decided_px === 0 && v.delta1_max <= 1;
  return v;
}

/** Judges `got` against the reference `ref` under one step's masks (`band`: gate 3c's mask). */
export function judgeQ7(
  ref: { width: number; height: number; data: Uint8Array },
  got: { width: number; height: number; data: Uint8Array },
  masks: StepMasks,
  band?: Uint8Array,
): Q7Verdict {
  const v: Q7Verdict = {
    ok: true,
    decided_px: 0,
    decided_max: 0,
    delta1_px: 0,
    delta1_max: 0,
    undecided_px: 0,
  };
  const inside = (list: { rect: Rect }[], x: number, y: number) =>
    list.some(
      ({ rect: r }) =>
        x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3],
    );
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      const i = (y * ref.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(ref.data[i + c] - got.data[i + c]));
      if (d === 0) continue;
      if (band?.[y * ref.width + x] || inside(masks.undecided, x, y))
        v.undecided_px++;
      else if (inside(masks.delta1, x, y)) {
        v.delta1_px++;
        v.delta1_max = Math.max(v.delta1_max, d);
      } else {
        v.decided_px++;
        v.decided_max = Math.max(v.decided_max, d);
      }
    }
  v.ok = v.decided_px === 0 && v.delta1_max <= 1;
  return v;
}

function main(): void {
  const mode = process.argv
    .slice(2)
    .find((a) => a === "--write" || a === "--check");
  // The committed file is in the repo's own JSON format (biome, as `pnpm check` enforces), so the
  // derivation is formatted the same way before it is written or compared.
  const raw = `${JSON.stringify(deriveTolerance(), null, 2)}\n`;
  const biome = spawnSync(
    join(HERE, "..", "..", "..", "..", "node_modules", ".bin", "biome"),
    ["format", `--stdin-file-path=${TOLERANCE_PATH}`],
    { input: raw, encoding: "utf8" },
  );
  if (biome.status !== 0) throw new Error(`biome format: ${biome.stderr}`);
  const text = biome.stdout;
  if (mode === "--write") {
    writeFileSync(TOLERANCE_PATH, text);
    console.log(`gsw-tolerance: wrote ${TOLERANCE_PATH}`);
  } else if (mode === "--check") {
    const committed = readFileSync(TOLERANCE_PATH, "utf8");
    if (committed !== text) {
      console.error(
        `gsw-tolerance: ${TOLERANCE_PATH} is not what the derivation writes`,
      );
      process.exitCode = 1;
    } else console.log("gsw-tolerance: --check: byte-identical");
  } else {
    process.stdout.write(text);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
