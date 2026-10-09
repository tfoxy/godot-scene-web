// Gate 3c cases for scripts/test/self-test-gate3.ts: the rotated/scaled fixture's synthesis, its
// expected.json rules and the reference-side checks of lib/gate3x-checks.ts, each with a passing
// and a failing case. The receiver-side checks share the band arithmetic tested here (bandDiff,
// overBudget) and gate 0's classifyLeg, which self-test-gate0/1 cover.
//
// 1. A hand-computed 8x8 case: a 45-degree diamond |x - 3.5| + |y - 3.5| <= 3 over pixel centres
//    covers 24 pixels; the band (centres within 1 px of an edge) is the 36 pixels with
//    2 <= |x - 3.5| + |y - 3.5| <= 4; a scissor confines both.
// 2. The six D7 semantic probes: the derived colour of every model against Q6d's table, typed in
//    here independently of make_expected.py.
// 3. checkExpectedSelfConsistentX on the committed file and on broken copies.
// 4. Small evidence trees of synthesized PNGs: expected-image-reference-xform, band-budget,
//    semantic-probes, probes-reference-xform and armed-transparent-xform pass and fail.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import {
  bandDiff,
  checkArmedTransparentX,
  checkBandBudget,
  checkExpectedImageReferenceX,
  checkExpectedSelfConsistentX,
  checkProbesReferenceX,
  checkSemanticProbes,
  overBudget,
} from "../lib/gate3x-checks";
import {
  CLIP_MODELS,
  type Gate3xExpected,
  type Point,
  paintDraws,
  synthesizeGate3x,
} from "../lib/gate3x-expected";

type Assert = (name: string, ok: boolean, detail?: string) => void;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const mask = (rows: string[]) => rows.join("");

function handQuadCases(assert: Assert): void {
  const diamond = {
    name: "D",
    quad: [
      [4, 1],
      [7, 4],
      [4, 7],
      [1, 4],
    ] as [Point, Point, Point, Point],
    rgba8: [255, 255, 255, 255] as [number, number, number, number],
    clip_px: null,
  };
  const f = paintDraws([diamond], [8, 8], [0, 0, 0, 255], 1.0);
  const cover = [...Array(64).keys()]
    .map((i) => (f.rgba[i * 4] === 255 ? "#" : "."))
    .join("");
  const band = [...f.band].map((b) => (b ? "b" : ".")).join("");
  const wantCover = mask([
    "........",
    "...##...",
    "..####..",
    ".######.",
    ".######.",
    "..####..",
    "...##...",
    "........",
  ]);
  const wantBand = mask([
    "...bb...",
    "..bbbb..",
    ".bbbbbb.",
    "bbb..bbb",
    "bbb..bbb",
    ".bbbbbb.",
    "..bbbb..",
    "...bb...",
  ]);
  assert(
    "8x8 diamond: pixel-centre coverage is the 24 hand-computed pixels",
    cover === wantCover,
    cover,
  );
  assert(
    "8x8 diamond: the band is the 36 hand-computed pixels",
    band === wantBand && f.bandPixels === 36,
    `${band} (${f.bandPixels})`,
  );
  const clipped = paintDraws(
    [{ ...diamond, clip_px: [0, 0, 4, 8] }],
    [8, 8],
    [0, 0, 0, 255],
    1.0,
  );
  const leftHalf = (s: string) =>
    [...s].map((c, i) => (i % 8 < 4 ? c : ".")).join("");
  assert(
    "8x8 diamond under scissor [0,0,4,8): coverage and band confined to x < 4",
    [...Array(64).keys()]
      .map((i) => (clipped.rgba[i * 4] === 255 ? "#" : "."))
      .join("") === leftHalf(wantCover) &&
      [...clipped.band].map((b) => (b ? "b" : ".")).join("") ===
        leftHalf(wantBand),
  );
  // bandDiff / overBudget.
  const a = new Uint8Array(4 * 4 * 4);
  const b = new Uint8Array(a);
  const bm = new Uint8Array(16);
  bm[5] = 1;
  b[5 * 4] = 9; // a band pixel
  const inBand = bandDiff(a, b, 4, 4, bm);
  assert(
    "bandDiff: a band pixel counts as band, not outside",
    inBand.band.mismatched_pixels === 1 &&
      inBand.outside.mismatched_pixels === 0 &&
      overBudget(inBand, { pixels: 1, max_channel_delta: 9 })
        .mismatched_pixels === 0 &&
      overBudget(inBand, { pixels: 0, max_channel_delta: 0 })
        .mismatched_pixels === 1,
  );
  b[0] = 1; // outside the band
  const out = bandDiff(a, b, 4, 4, bm);
  assert(
    "overBudget: a pixel outside the band always mismatches",
    overBudget(out, { pixels: 99, max_channel_delta: 255 })
      .mismatched_pixels === 1,
  );
}

// gate3-design.md Q6d's semantic-probe table, typed in: per probe, the item each model shows.
const RQF = "255,153,0,255";
const SQF = "204,204,51,255";
const SRF = "255,51,153,255";
const CLEAR = "51,51,102,255";
const HAND_SEMANTIC: Record<string, [number, number, string[]]> = {
  "rot.corner@0": [84, 84, [RQF, CLEAR, RQF, RQF]],
  "rot.bottom@0": [100, 157, [RQF, CLEAR, CLEAR, CLEAR]],
  "rot.bottom@2": [100, 166, [CLEAR, CLEAR, RQF, RQF]],
  "half.right@0": [402, 60, [SQF, CLEAR, CLEAR, CLEAR]],
  "half.bottom@0": [380, 73, [SQF, CLEAR, CLEAR, CLEAR]],
  "half.sliver@0": [401, 60, [SRF, SQF, SQF, SQF]],
};

function semanticCases(assert: Assert, expected: Gate3xExpected): void {
  assert(
    "semantic probes: six, named as Q6d",
    expected.semantic_probes.map((p) => p.name).join(",") ===
      Object.keys(HAND_SEMANTIC).join(","),
  );
  for (const p of expected.semantic_probes) {
    const hand = HAND_SEMANTIC[p.name];
    if (!hand) continue;
    assert(
      `semantic ${p.name}: at (${hand[0]},${hand[1]}), every model's colour is Q6d's`,
      p.xy.join(",") === `${hand[0]},${hand[1]}` &&
        CLIP_MODELS.every((m, i) => p.models[m].join(",") === hand[2][i]),
      JSON.stringify(p.models),
    );
    const synth = synthesizeGate3x(expected, p.step);
    const i = (p.xy[1] * 640 + p.xy[0]) * 4;
    assert(
      `semantic ${p.name}: the engine column is synthesizeGate3x's pixel`,
      [...synth.rgba.slice(i, i + 4)].join(",") === hand[2][0],
    );
  }
  for (const [k, m] of CLIP_MODELS.entries())
    if (k > 0)
      assert(
        `semantic: ${m} differs from the engine model at one probe or more`,
        Object.values(HAND_SEMANTIC).some((h) => h[2][k] !== h[2][0]),
      );
}

function selfConsistentCases(assert: Assert, expected: Gate3xExpected): void {
  const ok = checkExpectedSelfConsistentX(expected);
  assert(
    "expected-self-consistent-xform passes on the committed expected.json",
    ok.passed,
    ok.detail,
  );
  const broken: [string, (e: Gate3xExpected) => void][] = [
    [
      "a hand-table scissor off by one",
      (e) => {
        e.hand_clip_rects["0"].RQ = [83, 83, 172, 157];
      },
    ],
    [
      "a semantic model column changed",
      (e) => {
        e.semantic_probes[1].models["edge-round"] = e.semantic_probes[1].models
          .engine as (typeof e.semantic_probes)[1]["models"]["engine"];
      },
    ],
    [
      "an alternative that never disagrees",
      (e) => {
        for (const p of e.semantic_probes) {
          p.models["pixel-centre"] = p.models.engine;
          p.hand["pixel-centre"] = p.hand.engine;
        }
      },
    ],
    [
      "a band size that synthesis does not reproduce",
      (e) => {
        e.steps[2].band_pixels += 1;
      },
    ],
    [
      "a probe colour that is not the synthesized pixel",
      (e) => {
        e.steps[0].probes[0].rgba8 = [0, 0, 0, 255];
      },
    ],
    [
      "a sabotage step set off the contract",
      (e) => {
        e.predictions["sabotage-xform-perturb"].steps = [2, 3, 4];
      },
    ],
    [
      "an unlisted non-decisive edge",
      (e) => {
        e.non_decisive_edges = [];
      },
    ],
  ];
  for (const [what, edit] of broken) {
    const e = clone(expected);
    edit(e);
    const c = checkExpectedSelfConsistentX(e);
    assert(
      `expected-self-consistent-xform fails on ${what}`,
      !c.passed,
      c.detail.slice(0, 160),
    );
  }
}

async function png(
  path: string,
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

/** reference-xform{,-repeat,-armed} shots synthesized from expected.json, with `edit` applied to
 * one leg's frame of one step. */
async function writeShots(
  dir: string,
  expected: Gate3xExpected,
  edit?: { leg: string; step: number; xy: [number, number]; rgba: number[] },
): Promise<void> {
  for (const leg of [
    "reference-xform",
    "reference-xform-repeat",
    "reference-xform-armed",
  ])
    for (const s of expected.steps) {
      const f = synthesizeGate3x(expected, s.step);
      const rgba = new Uint8Array(f.rgba);
      if (edit && edit.leg === leg && edit.step === s.step)
        rgba.set(edit.rgba, (edit.xy[1] * f.width + edit.xy[0]) * 4);
      await png(
        join(dir, leg, "shots", `step-${s.step}.png`),
        rgba,
        f.width,
        f.height,
      );
    }
  await mkdir(join(dir, "reference-xform-armed", "evidence"), {
    recursive: true,
  });
  await writeFile(
    join(dir, "reference-xform-armed", "evidence", "result.json"),
    JSON.stringify({ status: "armed", stream: { status: "closed" } }),
  );
}

function firstBandPixel(e: Gate3xExpected, step: number): [number, number] {
  const f = synthesizeGate3x(e, step);
  const i = f.band.indexOf(1);
  return [i % f.width, Math.floor(i / f.width)];
}

async function evidenceCases(
  assert: Assert,
  expected: Gate3xExpected,
  root: string,
): Promise<void> {
  const good = join(root, "g3c-good");
  await writeShots(good, expected);
  const [img, budget, sem, probes, armed] = [
    await checkExpectedImageReferenceX(good, expected),
    await checkBandBudget(good, expected),
    await checkSemanticProbes(good, expected),
    await checkProbesReferenceX(good, expected),
    await checkArmedTransparentX(good, expected),
  ];
  assert(
    "g3c synthesized tree: expected-image-reference-xform, band-budget (0), semantic-probes, probes-reference-xform and armed-transparent-xform pass",
    img.check.passed &&
      budget.check.passed &&
      budget.budget.pixels === 0 &&
      sem.check.passed &&
      probes.check.passed &&
      armed.passed,
    [img.check, budget.check, sem.check, probes.check, armed]
      .filter((c) => !c.passed)
      .map((c) => `${c.id}: ${c.detail.slice(0, 160)}`)
      .join(" | "),
  );

  // A band pixel off in the reference: the image check ignores it; the repeat then differs only
  // in the band, which becomes a budget of 1 px.
  const bandXy = firstBandPixel(expected, 0);
  const bandTree = join(root, "g3c-band");
  await writeShots(bandTree, expected, {
    leg: "reference-xform",
    step: 0,
    xy: bandXy,
    rgba: [1, 2, 3, 255],
  });
  const bandImg = await checkExpectedImageReferenceX(bandTree, expected);
  const bandBudget = await checkBandBudget(bandTree, expected);
  const bandArmed = await checkArmedTransparentX(bandTree, expected);
  assert(
    "g3c band pixel off: expected-image-reference-xform passes, band-budget passes with a budget of 1 px, armed-transparent-xform fails",
    bandImg.check.passed &&
      bandBudget.check.passed &&
      bandBudget.budget.pixels === 1 &&
      !bandArmed.passed,
    `${bandImg.check.detail} | ${bandBudget.check.detail} | ${bandArmed.detail}`,
  );

  // The engine's half.sliver pixel painted as SQF (every alternative's answer): the image, the
  // semantic probes and the repeat all fail.
  const sliver = expected.semantic_probes.find(
    (p) => p.name === "half.sliver@0",
  );
  if (sliver) {
    const tree = join(root, "g3c-sliver");
    await writeShots(tree, expected, {
      leg: "reference-xform",
      step: 0,
      xy: sliver.xy,
      rgba: sliver.models["edge-round"],
    });
    const i = await checkExpectedImageReferenceX(tree, expected);
    const s = await checkSemanticProbes(tree, expected);
    const b = await checkBandBudget(tree, expected);
    assert(
      "g3c half.sliver drawn as an alternative predicts: expected-image-reference-xform, semantic-probes and band-budget fail",
      !i.check.passed && !s.check.passed && !b.check.passed,
      `${i.check.detail.slice(0, 100)} | ${s.check.detail.slice(0, 100)}`,
    );
  }

  // A probe pixel off: probes-reference-xform names it.
  const probe = expected.steps[1].probes.find((p) => p.side === "outside");
  if (probe) {
    const tree = join(root, "g3c-probe");
    await writeShots(tree, expected, {
      leg: "reference-xform",
      step: 1,
      xy: probe.xy,
      rgba: [255, 255, 255, 255],
    });
    const p = await checkProbesReferenceX(tree, expected);
    assert(
      `g3c probe ${probe.name} off: probes-reference-xform fails by name`,
      !p.check.passed && p.tally["1"].failed.includes(probe.name),
      p.check.detail.slice(0, 160),
    );
  }

  // An expected.json whose alternative agrees everywhere with the reference: semantic-probes
  // cannot refute it.
  const e = clone(expected);
  for (const p of e.semantic_probes)
    p.models["rotated-exact"] = p.models.engine;
  const s = await checkSemanticProbes(good, e);
  assert(
    "g3c an alternative equal to the engine everywhere: semantic-probes fails",
    !s.check.passed,
    s.check.detail.slice(0, 160),
  );
}

export async function gate3xCases(
  assert: Assert,
  expected: Gate3xExpected,
  root: string,
): Promise<void> {
  handQuadCases(assert);
  semanticCases(assert, expected);
  selfConsistentCases(assert, expected);
  await evidenceCases(assert, expected, root);
}
