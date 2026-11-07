#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for FRZ-P's receiver checks (runG8ptFrzp in lib/gate8-pt-receiver-checks.ts) on a
// fabricated tree of small PNG shots:
//
// 1. A good tree: frzp/receiver equals the reference, sabotage-freeze-drop-events/receiver has a
//    cell dark, so frzp-frozen-burst and frzp-catches-freeze-drop-events pass.
// 2. frzp-catches-freeze-drop-events fails when: the sabotage leg looks like the reference (unseen);
//    its shot set is short (missing shots are a failed leg, NOT a catch); a shot file is
//    unreadable; the reference lacks a shot; the leg has no shots at all.
// 3. frzp-frozen-burst fails when a frozen cell is dark or the leg is short.
//
// NOT covered, deliberately: a "frozen wire is smaller on the frozen cells" check. The frzp legs'
// evidence cannot support it: frzp/capture's recording can be LARGER than the
// unfrozen frzp-grant's (the nudge adds a record;
// the receiver simulates emitters, so the unfrozen wire carries no per-frame positions either).
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-frzp.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import type { G8aCheck } from "../lib/gate8-adopt-checks";
import { type PtPixels, runG8ptFrzp } from "../lib/gate8-pt-receiver-checks";

let failures = 0;
function expect(ok: boolean, what: string, detail?: unknown): void {
  if (ok) return;
  failures++;
  console.error(
    `FAIL: ${what}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`,
  );
}

const W = 20;
const H = 8;
const px: PtPixels = {
  regions: { A_BOX: [0, 0, 5, 5], D_ONESHOT: [10, 0, 15, 5] },
  background: [19, 7],
  tail_frames: [30],
  dark: {},
  coverage_band: 2,
};
const checkpoints = [{ step: 1, settle: 10 }];
const LABELS = ["step-1-prev", "step-1", "tail-30"];

type Cells = { A: boolean; D: boolean };
async function shot(path: string, c: Cells): Promise<void> {
  const data = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([0, 0, 0, 255], i * 4);
  const ink = (x0: number) => {
    for (let y = 1; y < 4; y++)
      for (let x = x0 + 1; x < x0 + 4; x++)
        data.set([255, 200, 0, 255], (y * W + x) * 4);
  };
  if (c.A) ink(0);
  if (c.D) ink(10);
  await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(path);
}

interface Leg {
  /** One entry per shot written; fewer than three makes a short leg. */
  cells: Cells[];
  /** Write `garbage` instead of a PNG for shot i. */
  garbage?: number;
}

async function writeLeg(
  g: string,
  leg: string,
  spec: Leg | null,
  byLabel: boolean,
): Promise<void> {
  const dir = join(g, leg);
  mkdirSync(join(dir, "shots"), { recursive: true });
  if (spec === null) return;
  writeFileSync(join(dir, "exit-code.txt"), "0");
  for (let i = 0; i < spec.cells.length; i++) {
    const name = byLabel ? `${LABELS[i]}.png` : `seq-${100 + i * 7}.png`;
    if (spec.garbage === i)
      writeFileSync(join(dir, "shots", name), "not a png");
    else await shot(join(dir, "shots", name), spec.cells[i]);
  }
}

const BOTH: Cells = { A: true, D: true };
const NO_D: Cells = { A: true, D: false };
const full = (c: Cells): Leg => ({ cells: [c, c, c] });

interface Tree {
  reference: Leg | null;
  receiver: Leg | null;
  drop: Leg | null;
}
const roots: string[] = [];
async function run(t: Tree): Promise<Record<string, G8aCheck>> {
  const g = mkdtempSync(join(tmpdir(), "self-test-gate8-frzp-"));
  roots.push(g);
  await writeLeg(g, "reference", t.reference, true);
  await writeLeg(g, "frzp/receiver", t.receiver, false);
  await writeLeg(g, "sabotage-freeze-drop-events/receiver", t.drop, false);
  const checks: G8aCheck[] = [];
  await runG8ptFrzp(g, checkpoints, px, checks, {});
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

const good: Tree = {
  reference: full(BOTH),
  receiver: full(BOTH),
  drop: full(NO_D),
};

{
  const v = await run(good);
  expect(
    v["frzp-frozen-burst"]?.passed === true,
    "good: frzp-frozen-burst passes",
    v["frzp-frozen-burst"]?.detail,
  );
  expect(
    v["frzp-catches-freeze-drop-events"]?.passed === true,
    "good: catches passes",
    v["frzp-catches-freeze-drop-events"]?.detail,
  );
}
{
  const v = await run({ ...good, drop: full(BOTH) });
  expect(
    v["frzp-catches-freeze-drop-events"]?.passed === false,
    "unseen sabotage fails the catch",
    v["frzp-catches-freeze-drop-events"]?.detail,
  );
}
{
  // Only the first two of three shots exist, and they DO differ: still a failure, not a catch.
  const v = await run({ ...good, drop: { cells: [NO_D, NO_D] } });
  const c = v["frzp-catches-freeze-drop-events"];
  expect(c?.passed === false, "short sabotage leg is not a catch", c?.detail);
  expect(
    /2 shots, 3 wanted/.test(c?.detail ?? ""),
    "short leg names the shot count",
    c?.detail,
  );
}
{
  const v = await run({
    ...good,
    drop: { cells: [NO_D, NO_D, NO_D], garbage: 1 },
  });
  expect(
    v["frzp-catches-freeze-drop-events"]?.passed === false,
    "an unreadable shot is not a catch",
    v["frzp-catches-freeze-drop-events"]?.detail,
  );
}
{
  const v = await run({ ...good, drop: { cells: [] } });
  expect(
    v["frzp-catches-freeze-drop-events"]?.passed === false,
    "a sabotage leg with no shots is not a catch",
    v["frzp-catches-freeze-drop-events"]?.detail,
  );
}
{
  const v = await run({ ...good, reference: { cells: [BOTH, BOTH] } });
  expect(
    v["frzp-catches-freeze-drop-events"]?.passed === false,
    "a reference missing a shot fails the catch",
    v["frzp-catches-freeze-drop-events"]?.detail,
  );
}
{
  const v = await run({ ...good, receiver: { cells: [BOTH, NO_D, BOTH] } });
  expect(
    v["frzp-frozen-burst"]?.passed === false,
    "a dark frozen cell fails frzp-frozen-burst",
    v["frzp-frozen-burst"]?.detail,
  );
}
{
  const v = await run({ ...good, receiver: { cells: [BOTH, BOTH] } });
  expect(
    v["frzp-frozen-burst"]?.passed === false,
    "a short frozen leg fails frzp-frozen-burst",
    v["frzp-frozen-burst"]?.detail,
  );
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
if (failures > 0) {
  console.error(`self-test-gate8-frzp: ${failures} failure(s)`);
  process.exit(1);
}
console.log("self-test-gate8-frzp: ok");
