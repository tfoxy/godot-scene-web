// @vitest-environment node
//
// The viewer's honesty rules, as tests.
//
// Everything asserted here is a way the report could look CORRECT and be wrong: a Godot arm scored
// 0.00 against a reference it was never compared to, an absent input rendered as zeros, the
// reference crowned winner of a metric it defines, two environments sharing a column, or a
// scenario counter that one arm reports being silently attributed to an arm that does not.
//
// Pure node over hand-built fixture documents — no browser, no Godot, no filesystem. The reader is
// a pure function precisely so this file can exist.

import { describe, expect, it } from "vitest";
import {
  buildReportData,
  distortionOf,
  type FidelityDocument,
  type GodotDocument,
  type ReportInputs,
  type RunDocument,
} from "../src/text-report";
import { renderPage } from "../src/text-report-page";

const OFFSETS = [0, 0.618, 1.236, 1.854, 2.472, 3.09, 3.708, 4.326];

const FIDELITY: FidelityDocument = {
  dpr: 1,
  headed: false,
  box: { width: 185, height: 81 },
  offsets: OFFSETS,
  spec: {
    runs: [
      {
        kind: "han",
        text: "一二三四五六七八九十百千",
        fontFamily: "NotoSansSC-probe",
      },
    ],
    fontSize: 12,
    rotationDeg: 10,
  },
  results: [
    {
      arm: "reference",
      acutance: 1.9,
      shimmer: 0.001,
      edgeShimmer: 0.002,
      meanInk: 3.92,
      rmsVsReference: 0,
      samples: 8,
    },
    {
      arm: "dom",
      acutance: 1.58,
      shimmer: 0.0001,
      edgeShimmer: 0,
      meanInk: 4.1,
      rmsVsReference: 12.5,
      samples: 8,
      subpixelTravel: 0.944,
      subpixelResidualPx: 0.27,
    },
    {
      arm: "canvas2d",
      acutance: 1.885,
      shimmer: 0.0009,
      edgeShimmer: 0.00544,
      meanInk: 3.9,
      rmsVsReference: 9.1,
      samples: 8,
      subpixelTravel: 1.015,
      subpixelResidualPx: 0.047,
    },
    {
      arm: "godot-msdf",
      acutance: 1.843,
      shimmer: 0.0007,
      edgeShimmer: 0.0047,
      meanInk: 4.0,
      // The probe writes NaN here; JSON turns that into null. This IS the on-disk shape.
      rmsVsReference: null,
      samples: 8,
      subpixelTravel: 0.965,
      subpixelResidualPx: 0.147,
    },
  ],
};

const GODOT: GodotDocument[] = [
  {
    variant: "msdf",
    adapter: "NVIDIA GeForce RTX 2060",
    godot: "4.5.1-stable (official)",
    renderer: "forward_plus",
    msdf: true,
    msdfSize: 128,
    msdfPixelRange: 8,
    oversampling: 1,
    metrics: {
      textTextureMemBytes: 33554432,
      textBufferMemBytes: 0,
      drawCalls: { p50: 91 },
      frameMs: { p50: 27.9, p95: 29.4 },
      poolVideoMemBytes: { p50: 52428800 },
    },
  },
];

const RUNS: RunDocument[] = [
  {
    scenario: "text-render",
    params: { mechanism: "dom" },
    env: {
      label: "linux-chrome-148",
      geometry: { viewport: { width: 1280, height: 800 }, fitScale: 1 },
    },
    metrics: {
      frameCostMs: { p50: 4.2, p95: 11.1, max: 20.3 },
      contentUpdateHz: 59.9,
      rasterMs: 1833,
      mainThreadBusyMs: 640,
      layerCount: 4,
      cpu: { totalCpuMs: 935.1 },
      gpu: { hardware: "swiftshader" },
      presented: { sampleHits: 24, sampleCount: 24 },
      scenario: { runsDrawn: 24, domNodes: 24, fontLoadMs: 8.2 },
    },
  },
  {
    scenario: "text-render",
    params: { mechanism: "canvas2d" },
    env: {
      label: "linux-chrome-148",
      geometry: { viewport: { width: 1280, height: 800 }, fitScale: 1 },
    },
    metrics: {
      frameCostMs: { p50: 1.5, p95: 4.64, max: 8.97 },
      contentUpdateHz: 60.05,
      rasterMs: 0,
      mainThreadBusyMs: 197.9,
      layerCount: 2,
      cpu: { totalCpuMs: 360.2 },
      gpu: { hardware: "swiftshader" },
      presented: { sampleHits: 24, sampleCount: 24 },
      scenario: { runsDrawn: 24, fillTextCalls: 2184, fontLoadMs: 7.7 },
    },
  },
];

function inputs(overrides: Partial<ReportInputs> = {}): ReportInputs {
  return {
    fidelity: FIDELITY,
    godot: GODOT,
    runs: RUNS,
    stills: {},
    diffs: {},
    sources: [],
    ...overrides,
  };
}

const groupOf = (data: ReturnType<typeof buildReportData>, id: string) => {
  const group = data.groups.find((entry) => entry.id === id);
  if (!group) {
    throw new Error(`no ${id} group`);
  }
  return group;
};
const rowOf = (
  data: ReturnType<typeof buildReportData>,
  id: string,
  label: string,
) => {
  const row = groupOf(data, id).rows.find((entry) => entry.label === label);
  if (!row) {
    throw new Error(`no ${id}.${label} row`);
  }
  return row;
};

describe("absent is never zero", () => {
  it("renders a null rmsVsReference as an em dash, NEVER as 0.00", () => {
    // The whole reason the probe writes NaN there: a Godot still scored against a Skia-drawn
    // reference ranks hinting policy. A `0.00` in that cell would read as a perfect match — the
    // single most flattering wrong number this page could print.
    const data = buildReportData(inputs());
    const row = rowOf(data, "fidelity", "rmsVsReference");
    expect(row.cells["godot-msdf"]).toBe("—");
    expect(row.cells.dom).toBe("12.50");
  });

  it("omits a metric the arm never reported instead of substituting a zero", () => {
    const data = buildReportData(inputs());
    // `domNodes` is a dom-only counter and `fillTextCalls` is canvas2d-only. Both rows exist,
    // because the row set is their union, and each is blank on the arm that does not report it.
    expect(rowOf(data, "browser", "domNodes").cells.canvas2d).toBe("—");
    expect(rowOf(data, "browser", "fillTextCalls").cells.dom).toBe("—");
    expect(rowOf(data, "browser", "domNodes").cells.dom).toBe("24");
    expect(rowOf(data, "browser", "fillTextCalls").cells.canvas2d).toBe("2184");
  });

  it("distinguishes a measured zero from an absent one", () => {
    // canvas2d really did cost 0 ms of raster — it composites — and that must still print as 0.
    const data = buildReportData(inputs());
    expect(rowOf(data, "browser", "rasterMs").cells.canvas2d).toBe("0");
    expect(
      rowOf(data, "browser", "rasterMs").cells["godot-msdf"],
    ).toBeUndefined();
  });

  it("names the command for every input it could not find, and renders no group for it", () => {
    const data = buildReportData(
      inputs({ fidelity: null, godot: [], runs: [] }),
    );
    expect(data.groups).toHaveLength(0);
    expect(data.missing).toHaveLength(3);
    for (const entry of data.missing) {
      expect(entry.command).toMatch(/pnpm/);
    }
    expect(data.missing.map((entry) => entry.command).join("\n")).toContain(
      "text:fidelity",
    );
  });
});

describe("environments never share a column", () => {
  it("gives each group its own arm list and its own environment line", () => {
    const data = buildReportData(inputs());
    expect(groupOf(data, "fidelity").arms).toEqual([
      "reference",
      "dom",
      "canvas2d",
      "godot-msdf",
    ]);
    // The browser group has NO godot column, and the godot group has no browser column: there is
    // no cell in which a SwiftShader millisecond could be lined up against an RTX 2060 one.
    expect(groupOf(data, "browser").arms).toEqual(["dom", "canvas2d"]);
    expect(groupOf(data, "godot").arms).toEqual(["godot-msdf"]);
    for (const group of data.groups) {
      expect(group.environment).not.toBe("");
    }
    expect(groupOf(data, "browser").environment).toContain("swiftshader");
    expect(groupOf(data, "godot").environment).toContain("RTX 2060");
  });

  it("keeps Godot's present-bound frame cost and its pool total labelled as non-answers", () => {
    const data = buildReportData(inputs());
    expect(rowOf(data, "godot", "frameMs p50").hint).toMatch(/PRESENT-BOUND/);
    const pool = rowOf(data, "godot", "pool video memory (NOT a cost)");
    expect(pool.hint).toMatch(/quantised/);
    // It is reported — hiding it would invite someone re-deriving it — but it can never win a row.
    expect(pool.better).toBeUndefined();
    expect(pool.best).toEqual([]);
  });
});

describe("distortion", () => {
  it("is derived from the reference, not read from the file", () => {
    // The JSON has no `distortion` key at all; it is |1 - acutance/ref| computed here.
    expect(FIDELITY.results?.[1]).not.toHaveProperty("distortion");
    const dom = FIDELITY.results?.[1];
    const reference = FIDELITY.results?.[0];
    expect(distortionOf(dom!, reference)).toBeCloseTo(
      Math.abs(1 - 1.58 / 1.9),
      9,
    );
    const data = buildReportData(inputs());
    expect(rowOf(data, "fidelity", "distortion").cells.dom).toBe("0.168");
  });

  it("is null, not 0, when there is nothing to compare against", () => {
    expect(distortionOf({ arm: "x", acutance: 1 }, undefined)).toBeNull();
    expect(
      distortionOf({ arm: "x" }, { arm: "reference", acutance: 1 }),
    ).toBeNull();
    expect(
      distortionOf(
        { arm: "x", acutance: 1 },
        { arm: "reference", acutance: 0 },
      ),
    ).toBeNull();
  });
});

describe("the reference is a ceiling, not a competitor", () => {
  it("never wins a row it defines", () => {
    const data = buildReportData(inputs());
    // Its distortion is 0 by construction and its residual is whatever the 8x render did; letting
    // either take the highlight would tell the reader an unshippable arm is the one to pick.
    for (const label of ["distortion", "subpixelResidualPx"]) {
      expect(rowOf(data, "fidelity", label).best).not.toContain("reference");
    }
    expect(rowOf(data, "fidelity", "distortion").best).toEqual(["canvas2d"]);
    expect(rowOf(data, "fidelity", "subpixelResidualPx").best).toEqual([
      "canvas2d",
    ]);
  });

  it("highlights nothing on a row with no direction", () => {
    // Acutance is not higher-is-better: above the reference is aliasing, below it is blur.
    const acutance = rowOf(data(), "fidelity", "acutance");
    expect(acutance.better).toBeUndefined();
    expect(acutance.best).toEqual([]);
    expect(rowOf(data(), "fidelity", "meanInk").best).toEqual([]);
  });

  it("refuses to crown the arm that could not move", () => {
    // `dom` scores a perfect 0.00000 edgeShimmer, and it is the WORST arm on that axis: its
    // 0.270 px residual is the signature of snapping translation to whole pixels, so it cannot
    // shimmer because it cannot move. A green cell there would recommend the arm this whole round
    // exists to replace. Blur hides the crawl the same way, which is why the row has no winner at
    // all rather than a cleverer one.
    const row = rowOf(data(), "fidelity", "edgeShimmer");
    expect(row.cells.dom).toBe("0.00000");
    expect(row.better).toBeUndefined();
    expect(row.best).toEqual([]);
  });

  const data = () => buildReportData(inputs());
});

describe("arms and offsets", () => {
  it("unions arms across all three inputs, so an arm with only one of them still appears", () => {
    const data = buildReportData(
      inputs({
        // Measured for crispness but not yet for cost, which is exactly the state a new arm
        // lands in. It must still be visible rather than silently dropped.
        runs: [],
        godot: [],
      }),
    );
    expect(data.arms.map((arm) => arm.arm)).toEqual([
      "reference",
      "dom",
      "canvas2d",
      "godot-msdf",
    ]);
    expect(data.groups.map((group) => group.id)).toEqual(["fidelity"]);
  });

  it("classifies arms so the page can caption them", () => {
    const kinds = Object.fromEntries(
      buildReportData(inputs()).arms.map((arm) => [arm.arm, arm.kind]),
    );
    expect(kinds).toEqual({
      reference: "reference",
      dom: "browser",
      canvas2d: "browser",
      "godot-msdf": "godot",
    });
  });

  it("labels the offset axis with the sub-pixel translation, not an index", () => {
    expect(buildReportData(inputs()).offsets).toEqual(OFFSETS);
  });

  it("falls back to an index axis when an older probe did not publish the offsets", () => {
    const older: FidelityDocument = {
      ...FIDELITY,
      offsets: undefined,
      results: [
        { arm: "dom", acutance: 1, samples: 8, inkSamples: Array(8).fill(1) },
      ],
    };
    expect(buildReportData(inputs({ fidelity: older })).offsets).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("pads a partial still set to the offset axis, so a gap is a gap and not a shift", () => {
    // Half a sweep on disk must leave holes at the RIGHT indices: reusing offset 0's image for
    // offset 5 would make the flip view animate a lie.
    const data = buildReportData(
      inputs({ stills: { dom: ["dom-0.png", null, "dom-2.png"] } }),
    );
    const dom = data.arms.find((arm) => arm.arm === "dom");
    expect(dom?.stills).toEqual([
      "dom-0.png",
      null,
      "dom-2.png",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(dom?.diffs).toHaveLength(OFFSETS.length);
  });
});

describe("headline numbers on the grid cards", () => {
  it("shows each arm the cost that its own environment measured", () => {
    const cards = Object.fromEntries(
      buildReportData(inputs()).arms.map((arm) => [
        arm.arm,
        Object.fromEntries(arm.headline.map((h) => [h.label, h.value])),
      ]),
    );
    expect(cards.dom).toMatchObject({ distortion: "0.168", raster: "1833 ms" });
    expect(cards["godot-msdf"]).toMatchObject({
      "text texture": "32.00 MB",
      "draw calls": "91",
    });
    // No browser cost on a Godot card and no VRAM on a browser card: the card is a summary of the
    // tables, and the tables do not have those cells either.
    expect(cards["godot-msdf"]).not.toHaveProperty("raster");
    expect(cards.dom).not.toHaveProperty("text texture");
    // The reference has no distortion from itself to report; it shows the acutance it defines.
    expect(cards.reference).toMatchObject({ acutance: "1.9000" });
  });
});

describe("alignment — the licence for every per-pixel column", () => {
  // The bug this guard exists for: the dom arm anchored its baseline by CSS half-leading while the
  // canvas arms anchored the em top, so it drew 2.35 px low. Nothing in the table said so, and
  // `rmsVsReference` (19.61 against canvas2d's 5.33) plus the whole diff view were scoring that
  // translation as a rasterizer difference. Every assertion below is one way that could return.
  const misalignedInputs = (
    tolerance?: number,
    alignment: Record<string, number> = {
      reference: 0,
      dom: 2.35,
      canvas2d: 0.06,
    },
  ) =>
    inputs({
      fidelity: {
        ...FIDELITY,
        alignmentTolerancePx: tolerance,
        results: FIDELITY.results?.map((row) =>
          row.arm in alignment
            ? { ...row, alignmentPx: alignment[row.arm] }
            : row,
        ),
      },
    });

  it("flags the misaligned arm on the arm itself, where its diff is shown", () => {
    const data = buildReportData(misalignedInputs());
    const dom = data.arms.find((arm) => arm.arm === "dom");
    // On the ARM, not only in the table: the flip and diff views show one arm with no table in
    // sight, which is exactly where the offset went unnoticed.
    expect(dom?.alignmentWarning).toContain("2.35 px");
    expect(dom?.alignmentWarning).toContain("rmsVsReference");
    expect(
      data.arms.find((arm) => arm.arm === "canvas2d")?.alignmentWarning,
    ).toBeNull();
  });

  it("marks the arm's rmsVsReference without erasing it", () => {
    const data = buildReportData(misalignedInputs());
    const rms = rowOf(data, "fidelity", "rmsVsReference");
    // The number STAYS. Blanking it would make a misaligned arm indistinguishable from an
    // unmeasured one, and this reader never conflates those two.
    expect(rms.cells.dom).toBe("12.50 ⚠");
    expect(rms.cells.canvas2d).toBe("9.10");
    // Absent stays absent — a Godot arm has no rms to mark either way.
    expect(rms.cells["godot-msdf"]).toBe("—");
  });

  it("puts alignment px directly above the rows it licenses", () => {
    const data = buildReportData(misalignedInputs());
    const labels = groupOf(data, "fidelity").rows.map((row) => row.label);
    expect(labels.indexOf("alignment px")).toBe(
      labels.indexOf("rmsVsReference") - 1,
    );
    expect(rowOf(data, "fidelity", "alignment px").cells.dom).toBe("2.350");
    // The reference defines alignment; it cannot also win it.
    expect(rowOf(data, "fidelity", "alignment px").best).toEqual(["canvas2d"]);
  });

  it("uses the tolerance the run recorded, not the one this reader was built with", () => {
    // A pure reader draws the line the producing run drew. A hardcoded threshold here would
    // silently re-judge old artifacts against a rule they were never measured under.
    const data = buildReportData(misalignedInputs(3));
    expect(
      data.arms.find((arm) => arm.arm === "dom")?.alignmentWarning,
    ).toBeNull();
    expect(rowOf(data, "fidelity", "rmsVsReference").cells.dom).toBe("12.50");
  });

  it("treats an unmeasured alignment as unmeasured, not as aligned", () => {
    // Artifacts from before the guard existed. They get a dash and no verdict either way —
    // claiming alignment we never measured is the same sin as claiming a zero we never measured.
    const data = buildReportData(inputs());
    expect(rowOf(data, "fidelity", "alignment px").cells.dom).toBe("—");
    expect(
      data.arms.find((arm) => arm.arm === "dom")?.alignmentWarning,
    ).toBeNull();
    expect(rowOf(data, "fidelity", "rmsVsReference").cells.dom).toBe("12.50");
  });

  it("prefers the arm's OWN allowance to the table-wide tolerance", () => {
    // The allowance carries a measured correction for that arm's blur (the registration estimator
    // reads ~0.65 px of spurious offset per unit of distortion), so a soft-but-aligned arm gets
    // room and a sharp-but-displaced one does not. Judging both against one flat number flagged
    // `dom` and `godot-default`, which are blurry, alongside `godot-msdf`, which is actually
    // displaced — three warnings where one was true.
    const data = buildReportData(
      inputs({
        fidelity: {
          ...FIDELITY,
          alignmentTolerancePx: 0.25,
          results: FIDELITY.results?.map((row) =>
            row.arm === "dom"
              ? { ...row, alignmentPx: 0.31, alignmentAllowancePx: 0.35 }
              : row.arm === "canvas2d"
                ? { ...row, alignmentPx: 0.31, alignmentAllowancePx: 0.25 }
                : row,
          ),
        },
      }),
    );
    expect(
      data.arms.find((arm) => arm.arm === "dom")?.alignmentWarning,
    ).toBeNull();
    const sharp = data.arms.find((arm) => arm.arm === "canvas2d");
    expect(sharp?.alignmentWarning).toContain("0.31 px");
    expect(sharp?.alignmentWarning).toContain("allowed 0.25 px");
  });

  it("names the flagged arms in the group note", () => {
    const flagged = groupOf(
      buildReportData(misalignedInputs()),
      "fidelity",
    ).notes.join(" ");
    expect(flagged).toContain("FLAGGED NOW: dom");
    const clean = groupOf(buildReportData(inputs()), "fidelity").notes.join(
      " ",
    );
    expect(clean).not.toContain("FLAGGED NOW");
  });
});

describe("two scripts, two groups", () => {
  // The probe measures each run's rows separately, so `results` has a row per arm PER BAND. The
  // viewer has to keep them apart: Han and Latin have different correct acutances, so a Han
  // distortion and a Latin distortion are two different scales printed in the same units. One
  // merged table would invite exactly the comparison the banding exists to prevent.
  const BANDED: FidelityDocument = {
    dpr: 1,
    headed: true,
    box: { width: 277, height: 159 },
    offsets: OFFSETS,
    bands: [
      { kind: "han", y0: 17, y1: 71 },
      { kind: "latin", y0: 71, y1: 141 },
    ],
    spec: {
      runs: [
        { kind: "han", text: "一二三", fontFamily: "NotoSansSC-probe" },
        { kind: "latin", text: "Sphinx", fontFamily: "Roboto-probe" },
      ],
      fontSize: 14,
      rotationDeg: 10,
    },
    results: [
      { arm: "reference", band: "han", acutance: 1.9, samples: 8 },
      { arm: "reference", band: "latin", acutance: 1.2, samples: 8 },
      {
        arm: "dom",
        band: "han",
        acutance: 1.6,
        samples: 8,
        alignmentPx: 0.18,
        alignmentAllowancePx: 0.35,
      },
      {
        arm: "dom",
        band: "latin",
        acutance: 1.14,
        samples: 8,
        alignmentPx: 0.62,
        alignmentAllowancePx: 0.28,
      },
    ],
  };

  const inputs = (): ReportInputs => ({
    fidelity: BANDED,
    godot: [],
    runs: [],
    stills: { reference: ["reference-0.png"], dom: ["dom-0.png"] },
    diffs: {},
    sources: [],
  });

  it("renders one fidelity group per band, each naming its band and its face", () => {
    const groups = buildReportData(inputs()).groups.filter((group) =>
      group.id.startsWith("fidelity"),
    );
    expect(groups.map((group) => group.id)).toEqual([
      "fidelity-han",
      "fidelity-latin",
    ]);
    // Two groups with identical row labels and identical arm columns are indistinguishable in the
    // readout panel unless the titles say which is which.
    expect(groups[0].title).toContain("han");
    expect(groups[0].title).toContain("NotoSansSC-probe");
    expect(groups[1].title).toContain("latin");
    expect(groups[1].title).toContain("Roboto-probe");
    expect(groups[0].title).not.toBe(groups[1].title);
  });

  it("scores each band against its OWN reference", () => {
    const groups = buildReportData(inputs()).groups;
    const distortion = (id: string) =>
      groups
        .find((group) => group.id === id)
        ?.rows.find((row) => row.label === "distortion")?.cells.dom;
    // 1 - 1.6/1.9 = 0.158 against 1 - 1.14/1.2 = 0.050. Sharing one reference would print the
    // same number twice, and one of them would be a statement about the other script.
    expect(distortion("fidelity-han")).toBe("0.158");
    expect(distortion("fidelity-latin")).toBe("0.050");
  });

  it("keeps ONE column per arm, not one per arm per band", () => {
    const data = buildReportData(inputs());
    expect(data.arms.map((arm) => arm.arm)).toEqual(["reference", "dom"]);
    // And the still it shows is the whole box, shared by both bands.
    expect(data.arms[1].stills[0]).toBe("dom-0.png");
  });

  it("names the band when an arm is misaligned in only one of them", () => {
    // "0.62 px out" and "0.62 px out IN LATIN" are different facts, and only the second points at
    // a cause. The warning is carried on the ARM because the diff view shows the whole box.
    const dom = buildReportData(inputs()).arms.find((arm) => arm.arm === "dom");
    expect(dom?.alignmentWarning).toContain("latin");
    expect(dom?.alignmentWarning).toContain("0.62");
  });

  it("still renders one group for an artifact written before the bands existed", () => {
    // The reader must keep working against older artifacts rather than crash and leave the user
    // with nothing — `band` is absent there, and one unnamed group is the honest rendering.
    const groups = buildReportData({
      fidelity: FIDELITY,
      godot: [],
      runs: [],
      stills: {},
      diffs: {},
      sources: [],
    }).groups.filter((group) => group.id.startsWith("fidelity"));
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("fidelity");
  });
});

describe("zoom is in DEVICE pixels", () => {
  // The viewer's whole claim is that at an integer zoom, under `image-rendering: pixelated`, what is
  // on screen ARE the still's pixels. That is only true if one source pixel covers a whole number of
  // DEVICE pixels — and a CSS size does not control device pixels. Measured on this page at
  // `devicePixelRatio` 1.25, sizing by zoom alone:
  //
  //   zoom  1     2    4   8   16      <- what the label said
  //   px    1.25  2.5  5   10  20      <- device px per source pixel it actually drew
  //
  // At 1x and 2x that is fractional, so `pixelated` renders some source pixels 1 device px wide and
  // their neighbours 2 — an uneven blocking that no rasterizer produced, laid over every arm, in the
  // one tool whose entire job is telling two nearly-identical rasterisations apart. At 4x and above
  // it was merely 25% larger than it claimed. Dividing the CSS size by the ratio makes every row
  // above read 1/2/4/8/16, which is verified in a real browser rather than here.
  //
  // This is a SOURCE-level pin and it is deliberately literal: the page is a template string, so
  // there is no function here to call. What it defends is the exact revert — sizing an image by
  // `naturalWidth * state.zoom` with the ratio dropped.
  const page = renderPage(buildReportData(inputs()));

  it("sizes every image through the device-ratio helper", () => {
    expect(page).toContain("window.devicePixelRatio");
    // Three sizing sites: the flip/diff stack's images, that stack's box, and the grid cards.
    expect(page.match(/cssPx\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it("never sizes an image by zoom alone", () => {
    // The pre-fix expression, in the two spellings it had.
    expect(page).not.toContain('naturalWidth * state.zoom + "px"');
    expect(page).not.toContain('naturalHeight * state.zoom + "px"');
  });

  it("re-lays out when the ratio changes under it", () => {
    // Browser zoom changes `devicePixelRatio`, and browser zoom is exactly what someone comparing
    // two stills reaches for. A `resolution` media query is the only event for it.
    expect(page).toContain("watchDeviceRatio");
    expect(page).toContain("dppx");
  });

  it("names the ratio in the zoom label when it is not 1", () => {
    // The image gets SMALLER at a fractional ratio — 0.8x its old size at dpr 1.25. Unexplained,
    // that reads as a bug in the viewer rather than as the correction it is.
    expect(page).toContain("device px @ dpr");
  });
});
