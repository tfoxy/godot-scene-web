// @vitest-environment node
//
// The Latin fixture font, against the REAL file — the one place the round's Latin geometry is not
// taken on trust.
//
// `LATIN_RUN_EM_WIDTH` and `LATIN_PANGRAM_EM_WIDTH` are constants in a browser-safe module, and
// everything downstream is built on them: the Latin run box, the cell size, whether 20 labels fit a
// 1280x800 viewport, and the fidelity probe's whole image. Nothing at runtime checks them — the
// scenario cannot, because the cell size is decided before a font is loaded. So they are checked
// here, by shaping the actual subset fixture with HarfBuzz.
//
// It also pins the two claims the fixture itself has to satisfy: that Roboto carries U+25A0 (S9's
// presence beacon reaches the screen through the same glyph path as the text, in BOTH faces), and
// that the beacon's ink box is where `BEACON_INK` says it is — the sample point aims at its centre,
// and a wrong constant there is a presence failure that reads as a rendering failure.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureLatinBenchFont } from "../../../scripts/ensure-latin-font";
import {
  LATIN_PANGRAM,
  LATIN_PANGRAM_EM_WIDTH,
  LATIN_RUN_EM_WIDTH,
  latinRunString,
} from "../src/scenarios";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Shaper {
  upem: number;
  advanceEm(text: string): number;
  inkEm(text: string): {
    x0: number;
    x1: number;
    yTop: number;
    yBottom: number;
  };
}

let shaper: Shaper;

beforeAll(async () => {
  const fixture = await ensureLatinBenchFont(REPO_ROOT);
  const hb = await import("harfbuzzjs");
  const blob = new hb.Blob(new Uint8Array(await readFile(fixture.path)));
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  const upem = face.upem;
  font.setScale(upem, upem);

  const shape = (text: string) => {
    const buffer = new hb.Buffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hb.shape(font, buffer);
    return buffer.getGlyphInfosAndPositions();
  };

  shaper = {
    upem,
    advanceEm(text) {
      let pen = 0;
      for (const item of shape(text)) pen += item.xAdvance ?? 0;
      return pen / upem;
    },
    inkEm(text) {
      const gid = shape(text)[0].codepoint;
      const extents = font.glyphExtents(gid);
      if (!extents) {
        // A glyph with no ink is a `.notdef` box or a missing cmap entry, and either would make
        // every assertion below vacuously "close to 0".
        throw new Error(`the fixture has no ink for "${text}" (gid ${gid})`);
      }
      // HarfBuzz extents are y-UP with a NEGATIVE height: `yBearing` is the ink's top.
      return {
        x0: extents.xBearing / upem,
        x1: (extents.xBearing + extents.width) / upem,
        yTop: extents.yBearing / upem,
        yBottom: (extents.yBearing + extents.height) / upem,
      };
    },
  };
}, 120_000);

describe("the Latin fixture font", () => {
  it("carries U+25A0, so the Latin run can lead with the same beacon the Han run does", () => {
    // Without this the Latin run would have no presence beacon at all, and 40/40 would quietly
    // become "the Han runs rendered".
    const ink = shaper.inkEm("■");
    expect(ink.x1).toBeGreaterThan(ink.x0);
    expect(ink.yTop).toBeGreaterThan(ink.yBottom);
  });

  it("puts the beacon's ink where BEACON_INK says — the sample point aims at its centre", () => {
    // These four numbers are copied into `text-render.ts` because that module may take no node
    // imports. If the fixture is ever re-subset from a different upstream they move, the sample
    // point stops landing on ink, and the presence guard blames the renderer.
    const ink = shaper.inkEm("■");
    expect(ink.x0).toBeCloseTo(0.07177734375, 6);
    expect(ink.x1).toBeCloseTo(0.53173828125, 6);
    expect(ink.yTop).toBeCloseTo(0.46044921875, 6);
    expect(ink.yBottom).toBeCloseTo(0, 6);
    // And the centre of the ink is inside the advance, which is what makes aiming at it sane.
    expect((ink.x0 + ink.x1) / 2).toBeLessThan(shaper.advanceEm("■"));
  });

  it("shapes every Latin run to exactly LATIN_RUN_EM_WIDTH", () => {
    // Every index, not a sample: the claim is that Roboto's digits are tabular, so all 20 runs are
    // the same width and one constant sizes the cell. If it were ever false, the widest run would
    // overflow its declared box and the fidelity band would clip it.
    const widths = new Set<number>();
    for (let index = 0; index < 100; index += 1) {
      widths.add(shaper.advanceEm(latinRunString(index)));
    }
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeCloseTo(LATIN_RUN_EM_WIDTH, 6);
  });

  it("shapes the bare pangram to exactly LATIN_PANGRAM_EM_WIDTH", () => {
    expect(shaper.advanceEm(LATIN_PANGRAM)).toBeCloseTo(
      LATIN_PANGRAM_EM_WIDTH,
      6,
    );
  });

  it("fits its ascent and descent inside the shared 1.35 em line box", () => {
    // Both faces share one run-box height and one baseline rule (alphabetic baseline at `fontSize`
    // below the box top). Roboto's descender has to fit the 0.35 em left under it, or the Latin
    // run's tails would fall outside the band its metrics are measured over.
    const j = shaper.inkEm("j");
    expect(-j.yBottom).toBeLessThan(0.35);
    const h = shaper.inkEm("h");
    expect(h.yTop).toBeLessThan(1.0);
  });
});
