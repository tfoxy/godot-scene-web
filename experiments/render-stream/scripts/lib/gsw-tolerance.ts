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
//   decided    every other pixel: channel 0, pixels 0 (P-G1).
//
// Gates 0, 1 and 3 (main) draw opaque axis-aligned rects only: every pixel is decided. Gate 2's
// masks come from its expected.json: each draw's sampled texture content (alpha uniform or not,
// partial or not) and the filter in force (the `default_filter` and per-item `filter` invariants).
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
}

export interface GateTolerance {
  expected: string;
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
    },
  };
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
