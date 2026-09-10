// @vitest-environment node
//
// THE INVARIANT S9's hb-gpu ARM USED TO GET FOR FREE, NOW PAID FOR IN EVIDENCE.
//
// `mountHbGpu` shaped with npm `harfbuzzjs` — the same `createHarfBuzzShaper` object `hb-atlas` and
// `hb-run` use — so its pen positions were byte-identical to theirs BY CONSTRUCTION, and any
// disagreement the fidelity probe's alignment guard saw could only be the renderer. That was the
// entire licence for reading `alignmentPx` as a statement about Slug rather than about two shapers.
//
// The arm now shapes in hb-gpu's own wasm (`shapeRunWithHbGpu`), which is what collapses two
// HarfBuzz builds and two copies of every face into one — and destroys that construction. The
// invariant is unchanged; what changed is that it is now a CLAIM ABOUT TWO SHAPERS AGREEING, and a
// claim has to be checked. That is this file.
//
// WHAT IT CHECKS, AND WHY IT IS NOT `packages/hb-gpu/test/shape.test.ts` AGAIN. That file grades the
// two HarfBuzz builds against each other on runs chosen to stress a SHAPER: ligatures, kern pairs,
// an explicit RTL Latin run, features on and off. This one asks a narrower and more specific
// question — do the exact strings S9 draws, at the size S9 draws them, through the two code paths
// S9 actually calls, produce the same `ShapedGlyph[]`? Both halves of that matter: the strings are
// the fixture's own (a Han spread with a U+25A0 beacon, and the indexed Latin pangram), and the
// comparison is of `key` and `penPx` — the two fields every arm's placement is computed from —
// rather than of raw HarfBuzz fields. A `toPx` applied half a step out would leave every raw field
// identical and move every glyph.
//
// THE PROBE'S OWN RUN STRINGS ARE COVERED TOO, from `probeLayout`, because the probe is where the
// consequence lands: `probes/text-fidelity-hb.ts` still shapes its hb-gpu arm with harfbuzzjs, so
// the arm the guard grades is only the arm S9 times while these two agree.
//
// LOADS THE VENDORED GLUE THE WAY `packages/hb-gpu/test/shape.test.ts` DOES: it is built
// `-sENVIRONMENT=web,worker`, so a node import aborts unless `{ wasmBinary }` is passed —
// `-sINCOMING_MODULE_JS_API=wasmBinary` is what makes that key supported. `loadHbGpuModule` is not
// used here because it fetches both files over HTTP from the harness's own origin.
//
// SKIPPED, NOT FAILED, when a fixture font cannot be obtained: both are gitignored and fetched on
// demand, and a checkout with no network has nothing to compare.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createHbGpu,
  type HbGpuFont,
  type HbGpuModuleFactory,
} from "@godot-scene-web/hb-gpu";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureCjkFont } from "../../../scripts/ensure-cjk-font";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import { probeLayout } from "../probes/text-fidelity";
import { createHbGpuFonts, shapeRunWithHbGpu } from "../src/scenarios/text-gpu";
import {
  createHarfBuzzShaper,
  harfbuzzGlyphIdOf,
  type TextShaper,
} from "../src/scenarios/text-hb";
import {
  latinRunString,
  type TextRunKind,
  textParamsSpec,
  textRunString,
} from "../src/scenarios/text-render";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDOR = join(REPO_ROOT, "packages", "hb-gpu", "vendor");
const GLUE_FILE = join(VENDOR, "hb-gpu.mjs");
const WASM_FILE = join(VENDOR, "hb-gpu.wasm");

/** The scenario's own defaults, read from the scenario, so a changed default moves this test too. */
const PARAMS = textParamsSpec();
const FONT_SIZE = Number(PARAMS.fontSize.default);
const CHARS = Number(PARAMS.chars.default);
const GLYPHS = Number(PARAMS.glyphs.default);
const LABELS = Number(PARAMS.labels.default);
const ROTATION_DEG = Number(PARAMS.rotationDeg.default);

/** One run of the comparison: which face shapes it, and what it says. */
interface Run {
  kind: TextRunKind;
  what: string;
  text: string;
}

/**
 * Every string S9 shapes at the defaults, plus the fidelity probe's two.
 *
 * ALL 20 INDICES, not a sample. The Han runs are 20 different spreads of the glyph pool and the
 * Latin ones differ only in a two-digit prefix, so a disagreement confined to one glyph of one face
 * — which is exactly what a cmap or a GSUB difference between two builds would look like — has 20
 * chances to show up rather than one.
 */
function scenarioRuns(): Run[] {
  const runs: Run[] = [];
  for (let index = 0; index < LABELS; index += 1) {
    runs.push({
      kind: "han",
      what: `the Han run of cell ${index}`,
      text: textRunString(index, CHARS, GLYPHS),
    });
    runs.push({
      kind: "latin",
      what: `the Latin run of cell ${index}`,
      text: latinRunString(index),
    });
  }
  for (const run of probeLayout({
    script: "both",
    chars: CHARS,
    fontSize: FONT_SIZE,
    rotationDeg: ROTATION_DEG,
  }).runs) {
    runs.push({
      kind: run.kind as TextRunKind,
      what: `the fidelity probe's ${run.kind} run`,
      text: run.text,
    });
  }
  return runs;
}

const RUNS = scenarioRuns();

let skipReason = "";
const fonts = new Map<string, HbGpuFont>();
const shapers = new Map<TextRunKind, TextShaper>();

/** A `Buffer` as an `ArrayBuffer` both shapers can be handed, with no view arithmetic left in it. */
function detach(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

beforeAll(async () => {
  if (!existsSync(GLUE_FILE) || !existsSync(WASM_FILE)) {
    skipReason = `${GLUE_FILE} is missing — hb-gpu's wasm is committed (packages/hb-gpu/vendor/VENDOR.md) and packages/hb-gpu/build.sh rebuilds it`;
    return;
  }

  const bytesByFace = new Map<string, ArrayBuffer>();
  try {
    // The SAME files the harness serves to the page — `run.ts` calls these two functions to decide
    // what `/fixture/font.ttf` and `/fixture/latin.ttf` are. A test that shaped some other copy of
    // Noto Sans SC would be comparing two shapers on a face neither arm ever sees.
    const [han, latin] = await Promise.all([
      ensureCjkFont(REPO_ROOT),
      ensureLatinBenchFont(REPO_ROOT),
    ]);
    bytesByFace.set("han", detach(await readFile(han.path)));
    bytesByFace.set("latin", detach(await readFile(latin.path)));
  } catch (cause) {
    skipReason = `the fixture fonts are gitignored and could not be fetched (${cause instanceof Error ? cause.message : String(cause)}) — run scripts/ensure-cjk-font.ts and scripts/ensure-latin-font.ts`;
    return;
  }

  const wasmBinary = await readFile(WASM_FILE);
  const glue = (await import(pathToFileURL(GLUE_FILE).href)) as {
    default: HbGpuModuleFactory;
  };
  const hbGpu = await createHbGpu(glue.default, wasmBinary, {
    // A refusal here is not a shaping disagreement, and must not be reported as one.
    onError: (failure) => {
      throw new Error(
        `hb-gpu refused (${failure.reason}) — ${failure.message}`,
      );
    },
  });
  // `createHbGpuFonts` and not `module.createFont`: the arm's own construction path, so a face this
  // test could shape but the arm could not would still fail here.
  for (const [faceId, font] of createHbGpuFonts(hbGpu, bytesByFace)) {
    fonts.set(faceId, font);
  }
  for (const kind of ["han", "latin"] as const) {
    const bytes = bytesByFace.get(kind);
    if (!bytes) continue;
    // A COPY, because `createHarfBuzzShaper` hands its buffer to harfbuzzjs and hb-gpu already holds
    // the original — two wasm modules must never share one detachable buffer.
    shapers.set(
      kind,
      await createHarfBuzzShaper(bytes.slice(0), FONT_SIZE, kind),
    );
  }
}, 600_000);

describe("S9's two shapers place a glyph in the same px", () => {
  for (const run of RUNS) {
    it(`agrees on ${run.what}`, ({ skip }) => {
      if (skipReason) skip(skipReason);
      const shaper = shapers.get(run.kind);
      expect(
        shaper,
        `no harfbuzzjs shaper for face "${run.kind}"`,
      ).toBeDefined();
      const mine = shapeRunWithHbGpu(fonts, run.kind, run.text, FONT_SIZE);
      const reference = (shaper as TextShaper).shape(run.text);

      // NON-EMPTY FIRST. Two shapers that both produced nothing would agree perfectly, and "no
      // glyphs at all" is precisely what a broken buffer plumbing produces.
      expect(mine.length, "the run shaped to no glyphs at all").toBeGreaterThan(
        0,
      );
      // `toEqual` on the whole array, not a loop with a tolerance: `penPx` is the number a quad's
      // corner is computed from, and the claim being made about this arm is EQUALITY, not
      // closeness. A tolerance here is the fraction of a pixel `alignmentPx` exists to catch.
      expect(mine).toEqual(reference);
    });
  }

  it("emits keys the outline encoder can read a glyph id out of", ({
    skip,
  }) => {
    if (skipReason) skip(skipReason);
    // The other half of what `hb-gpu` needs from a shaper: `createHbGpuText` turns every key back
    // into a gid with `harfbuzzGlyphIdOf` and encodes THAT outline. A key format only the atlas
    // arms understood would throw at mount, but the check costs one line here.
    for (const run of RUNS.slice(0, 4)) {
      for (const glyph of shapeRunWithHbGpu(
        fonts,
        run.kind,
        run.text,
        FONT_SIZE,
      )) {
        expect(harfbuzzGlyphIdOf(glyph.key), glyph.key).not.toBeNull();
      }
    }
  });

  it("answers an empty run with an empty array rather than a refusal", ({
    skip,
  }) => {
    if (skipReason) skip(skipReason);
    // `HbGpuFont.shape` distinguishes `[]` (nothing to shape) from `null` (could not shape), and
    // `shapeRunWithHbGpu` turns only the second into a throw. Pinned because collapsing the two
    // would either make an empty run fail a sweep or make an unshapeable one draw silently short.
    expect(shapeRunWithHbGpu(fonts, "han", "", FONT_SIZE)).toEqual([]);
  });

  it("throws for a face it has no font for, rather than dropping the run", ({
    skip,
  }) => {
    if (skipReason) skip(skipReason);
    // A missing face renders as absent text, which every metric in this round reports as an
    // unusually cheap and unusually crisp arm.
    expect(() => shapeRunWithHbGpu(fonts, "greek", "abc", FONT_SIZE)).toThrow(
      /no hb-gpu font for face "greek"/,
    );
  });
});
