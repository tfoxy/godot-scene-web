// Q7's pixel policy applied to a gate's own checker (gate7-design.md Q7, Q8, G7a): "each gate's
// receiver checks @gsw under Q7". The gates' checkers compare a receiver's shots with the rendered
// reference exactly, which is the native receiver's budget (0 almost everywhere). For the GSW
// receiver Q7 allows, per step, channel <= 1 inside the gate's `delta1` masks and any difference
// inside its `undecided` masks (fixtures/gsw-tolerance.json, derived from the gate's own
// expected.json, never from a GSW run), and nothing anywhere else.
//
// So the adapter hands the gate checker a Q7 view of each gsw leg: every file of the leg, except
// that in each shot of a step k, a pixel whose difference from the reference's step k is within
// Q7's allowance for its mask is replaced by the reference's pixel. A pixel outside every mask,
// or over its mask's allowance, is left as the receiver drew it, so the gate's exact comparison
// judges exactly Q7's "decided" pixels, and every sabotage still fails where it differs outside
// the masks. Each view directory records what it replaced (`q7-view.json`); the raw shots stay
// in the gsw leg and q7-pixel-policy@gsw reports the counts.

import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "../../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { decodePngRgba } from "./gate-minus1-checks";
import { type Gate3xExpected, synthesizeGate3x } from "./gate3x-expected";
import { readTolerance, type StepMasks } from "./gsw-tolerance";

export interface Q7Leg {
  /** the gsw leg directory (raw evidence) */
  gswDir: string;
  /** the view directory to create */
  viewDir: string;
  /** tolerance key in gsw-tolerance.json (`gate2`, `gate3-xform`, ...) */
  key: string;
  /** shot seq -> step */
  steps: Map<number, number>;
  /** the reference shots directory (`step-<k>.png`) */
  referenceDir: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const inside = (list: { rect: number[] }[], x: number, y: number) =>
  list.some(
    ({ rect: r }) =>
      x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3],
  );

/** Builds one leg's Q7 view; returns how many pixels were replaced per shot. */
export async function buildQ7View(
  leg: Q7Leg,
  xform?: Gate3xExpected,
): Promise<Record<string, { delta1: number; undecided: number }>> {
  const tol = readTolerance().gates[leg.key];
  await mkdir(join(leg.viewDir, "shots"), { recursive: true });
  for (const entry of readdirSync(leg.gswDir)) {
    if (entry === "shots") continue;
    const at = join(leg.viewDir, entry);
    if (!existsSync(at)) symlinkSync(join(leg.gswDir, entry), at);
  }
  const replaced: Record<string, { delta1: number; undecided: number }> = {};
  const shots = existsSync(join(leg.gswDir, "shots"))
    ? readdirSync(join(leg.gswDir, "shots"))
    : [];
  for (const f of shots) {
    const src = join(leg.gswDir, "shots", f);
    const dst = join(leg.viewDir, "shots", f);
    const seq = Number(/^seq-(\d+)\.png$/.exec(f)?.[1] ?? Number.NaN);
    const step = leg.steps.get(seq);
    const masks: StepMasks | undefined =
      step === undefined ? undefined : tol?.steps[step];
    const ref =
      step === undefined
        ? null
        : await decodePngRgba(join(leg.referenceDir, `step-${step}.png`));
    const got = await decodePngRgba(src);
    if (
      !masks ||
      !ref ||
      !got ||
      ref.width !== got.width ||
      ref.height !== got.height
    ) {
      if (!existsSync(dst)) symlinkSync(src, dst);
      continue;
    }
    const band =
      leg.key === "gate3-xform" && xform && step !== undefined
        ? synthesizeGate3x(xform, step).band
        : undefined;
    const out = Buffer.from(got.data);
    let d1 = 0;
    let und = 0;
    for (let y = 0; y < got.height; y++)
      for (let x = 0; x < got.width; x++) {
        const i = (y * got.width + x) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++)
          d = Math.max(d, Math.abs(ref.data[i + c] - got.data[i + c]));
        if (d === 0) continue;
        if (band?.[y * got.width + x] || inside(masks.undecided, x, y)) und++;
        else if (d <= 1 && inside(masks.delta1, x, y)) d1++;
        else continue;
        for (let c = 0; c < 4; c++) out[i + c] = ref.data[i + c];
      }
    await sharp(out, {
      raw: { width: got.width, height: got.height, channels: 4 },
    })
      .png()
      .toFile(dst);
    replaced[f] = { delta1: d1, undecided: und };
  }
  await writeFile(
    join(leg.viewDir, "q7-view.json"),
    `${JSON.stringify({ schema: "render-stream-gsw-q7-view/1", key: leg.key, replaced }, null, 2)}\n`,
  );
  return replaced;
}

/** shot seq -> step for a leg: its settle seqs (shot-seqs.txt, step k = k-th), or for a live
 * replay the live receiver's own `shots[]{step, seq}`. */
export async function stepsOf(
  sourceLegDir: string,
  liveApplied?: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (liveApplied) {
    const applied = await readJson<{
      shots?: { step?: number; seq?: number }[];
    }>(liveApplied);
    for (const s of applied?.shots ?? [])
      if (typeof s.step === "number" && typeof s.seq === "number")
        out.set(s.seq, s.step);
    return out;
  }
  try {
    const text = await readFile(join(sourceLegDir, "shot-seqs.txt"), "utf8");
    for (const [k, s] of text.trim().split(",").filter(Boolean).entries())
      out.set(Number(s), k);
  } catch {
    // no settle seqs: no step mapping, the view links the raw shots
  }
  return out;
}
