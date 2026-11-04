#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for the wide +-1 tolerance (lib/wide-tolerance.ts) and its browser-side caller
// wideCompositionCheck (lib/gate7-g6-checks.ts; the native caller, gate6b's
// wide-reference-extends-native, shares the helper and needs a Godot tree):
//
// 1. widePm1Problems: a within-bound tally passes; too many +-1 px, a partial shot set and an empty
//    tally fail.
// 2. wideCompositionCheck on fabricated small PNG shots (injected legs and shot list): the good
//    tree passes (a few +-1 px in the base columns are tolerated); a partial leg, too many +-1 px,
//    a >1 level diff in the base columns, any diff in the added columns, a missing seq and an empty
//    shot list each fail.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-wide-tolerance.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { wideCompositionCheck } from "../lib/gate7-g6-checks";
import { WIDE_PM1_MAX_FRACTION, widePm1Problems } from "../lib/wide-tolerance";

let failures = 0;
function expect(ok: boolean, what: string, detail?: unknown): void {
  if (ok) return;
  failures++;
  console.error(
    `FAIL: ${what}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`,
  );
}

// 1. The helper.
{
  const ok = { shots: 15, expectedShots: 15, compared: 30_000_000, pm1: 15 };
  expect(
    widePm1Problems("leg", ok).length === 0,
    "helper: measured-like tally passes",
  );
  const edge = Math.floor(ok.compared * WIDE_PM1_MAX_FRACTION);
  expect(
    widePm1Problems("leg", { ...ok, pm1: edge }).length === 0,
    "helper: exactly at the bound passes",
  );
  expect(
    widePm1Problems("leg", { ...ok, pm1: edge + 1 }).length === 1,
    "helper: one over the bound fails",
  );
  expect(
    widePm1Problems("leg", { ...ok, shots: 14 }).some((p) =>
      /14 of 15 shots/.test(p),
    ),
    "helper: a partial leg fails",
  );
  expect(
    widePm1Problems("leg", { shots: 0, expectedShots: 15, compared: 0, pm1: 0 })
      .length > 0,
    "helper: an empty tally fails",
  );
  expect(
    widePm1Problems("leg", { shots: 0, expectedShots: 0, compared: 0, pm1: 0 })
      .length > 0,
    "helper: no expected shots fails",
  );
}

// 2. wideCompositionCheck.
const W = 400;
const H = 250;
const BASE_W = 300;
const FRAMES = [10, 20];
const SHOTS = FRAMES.map((frame, i) => ({
  id: `s${i}`,
  frame,
  regions: { SC: [0, 0, 1000, 500] } as Record<string, number[]>,
}));
const LEGS = [
  {
    leg: "receiver-wide",
    base: "hd/receiver-native",
    size: [W, H] as [number, number],
    baseWidth: BASE_W,
  },
];

type Rgba = Buffer;
function solid(w: number, h: number): Rgba {
  const d = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([40, 90, 140, 255], i * 4);
  return d;
}
async function png(path: string, w: number, h: number, d: Rgba): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp(d, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(path);
}
const bump = (d: Rgba, w: number, x: number, y: number, by: number): void => {
  const i = (y * w + x) * 4;
  d[i] = Math.min(255, d[i] + by);
};

interface Variant {
  /** Number of the SHOTS whose wide/base/ref files are written (default all). */
  written?: number;
  /** `n` pixels in the base columns of shot 0 get +delta on the wide shot. */
  baseDiff?: { n: number; delta: number };
  /** One pixel in the added columns of the wide shot differs from the reference. */
  addedDiff?: boolean;
  /** Drop the applied.json entry for the second frame. */
  noSeqForLast?: boolean;
  shots?: typeof SHOTS;
}
const roots: string[] = [];
async function run(
  v: Variant = {},
): Promise<{ passed: boolean; detail: string }> {
  const root = mkdtempSync(join(tmpdir(), "self-test-wide-tolerance-"));
  roots.push(root);
  const source = join(root, "source");
  const browser = join(root, "browser");
  const seqs = FRAMES.map((frame, i) => ({ frame, seq: 100 + i }));
  mkdirSync(join(source, "wide", "receiver-wide"), { recursive: true });
  writeFileSync(
    join(source, "wide", "receiver-wide", "applied.json"),
    JSON.stringify({ transactions: v.noSeqForLast ? seqs.slice(0, 1) : seqs }),
  );
  for (let i = 0; i < (v.written ?? SHOTS.length); i++) {
    const seq = 100 + i;
    const base = solid(BASE_W, H);
    const ref = solid(W, H);
    const wide = solid(W, H);
    if (v.baseDiff && i === 0) {
      for (let k = 0; k < v.baseDiff.n; k++)
        bump(wide, W, k % BASE_W, Math.floor(k / BASE_W), v.baseDiff.delta);
    }
    if (v.addedDiff && i === 0) bump(wide, W, BASE_W + 5, 5, 1);
    await png(
      join(browser, "hd", "receiver-native", "shots", `seq-${seq}.png`),
      BASE_W,
      H,
      base,
    );
    await png(
      join(browser, "wide", "receiver-wide", "shots", `seq-${seq}.png`),
      W,
      H,
      wide,
    );
    await png(
      join(source, "wide", "reference-400x250", "shots", `s${i}.png`),
      W,
      H,
      ref,
    );
  }
  const r = await wideCompositionCheck(
    "test",
    source,
    (leg) => join(browser, leg),
    { legs: LEGS, shots: v.shots ?? SHOTS },
  );
  return { passed: r.passed, detail: r.detail };
}

{
  const r = await run();
  expect(r.passed, "good: identical shots pass", r.detail);
}
{
  // 10 +-1 px of 200 000 compared = 5e-5, under the 1e-4 bound: tolerated.
  const r = await run({ baseDiff: { n: 10, delta: 1 } });
  expect(
    r.passed,
    "good: a few +-1 px in the base columns are tolerated",
    r.detail,
  );
}
{
  const r = await run({ baseDiff: { n: 60, delta: 1 } });
  expect(
    !r.passed && /differ by one level/.test(r.detail),
    "bad: too many +-1 px fail",
    r.detail,
  );
}
{
  const r = await run({ baseDiff: { n: 1, delta: 2 } });
  expect(
    !r.passed && /differ from hd\/receiver-native/.test(r.detail),
    "bad: a 2-level diff in the base columns fails",
    r.detail,
  );
}
{
  const r = await run({ addedDiff: true });
  expect(
    !r.passed && /added columns/.test(r.detail),
    "bad: a diff in the added columns fails",
    r.detail,
  );
}
{
  const r = await run({ written: 1 });
  expect(
    !r.passed && /1 of 2 shots compared/.test(r.detail),
    "bad: a partial leg (one of two shots) fails",
    r.detail,
  );
}
{
  const r = await run({ noSeqForLast: true });
  expect(
    !r.passed && /no seq for frame 20/.test(r.detail),
    "bad: an expected shot with no seq fails",
    r.detail,
  );
}
{
  const r = await run({ shots: [] });
  expect(
    !r.passed && /no shot compared/.test(r.detail),
    "bad: an empty shot list fails",
    r.detail,
  );
}
{
  const r = await run({ written: 0 });
  expect(!r.passed, "bad: no shot files fails", r.detail);
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
if (failures > 0) {
  console.error(`self-test-wide-tolerance: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-wide-tolerance: ok");
