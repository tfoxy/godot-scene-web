// PM3 (render-stream-11.md "As built (PM3)"; particles-multimesh-design.md "Increments" PM3): GSW's
// instanced multimesh draws, judged against the UNARMED reference of fixtures/gate8-mm (the native
// gate 8 source's g8mm/reference shots, PM2), not against the native receiver. A GSW shot is paired
// with the reference shot of its transaction's host frame (step-<k>.png at a settle frame,
// step-<k>-prev.png the frame before). The band is gate 8's (lib/gate7-gsw-g8.ts): every pixel of
// the pair within channel 1, outside the cells expected.json's `pixels.known_gaps` names (PM2's
// identity-transform gap: D_GLOBAL's particles land in G_HIDDEN's cell on every receiver).
//
//   mm-gsw-band@gsw          the honest /11 legs (g8mm/receiver, g8mm/receiver-patch): every shot
//                            pairs with a reference shot and is within the band (2D transforms,
//                            colours and custom data through GLES3's half floats, INSTANCE_CUSTOM,
//                            visible_instances, the custom AABB, the replaced and the freed buffer)
//   mm-gsw-flipbook@gsw      C_FLIP (a CPUParticles2D with a particles_animation CanvasItemMaterial,
//                            four frames) within the band on the honest legs, and the GSW-only
//                            sabotage `no-flipbook` (the template drawn as its builtin, as before
//                            PM3) beyond it in C_FLIP's cell, with every cell below C_FLIP's row
//                            equal to the honest GSW leg (unflipped quads spill sideways only)
//   mm-gsw-catches-perturb-instance@gsw  the sabotaged patch sink (capture sabotage
//                            perturb-instance, from frame 30) replayed by GSW fails the band after
//                            frame 30 and holds it before
//   mm-gsw-catches-undrawn-multimesh@gsw  the receiver sabotage `undrawn-multimesh` (no instanced
//                            draw, as before PM3) fails the band

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePngRgba } from "./gate-minus1-checks";
import type { Gate7Check } from "./gate7-adapters";
import { mk } from "./gate7-gsw";

type Rgba = { data: Uint8Array; width: number; height: number };
type Region = [number, number, number, number];

interface Ctx {
  out: string;
  sourceDir: string;
}

export const MM_HONEST = ["g8mm/receiver", "g8mm/receiver-patch"] as const;
export const MM_PERTURB = "g8mm/sabotage-perturb-instance/receiver-patch";
export const MM_UNDRAWN = "g8mm/sabotage-undrawn-multimesh/receiver";
export const MM_NO_FLIPBOOK = "g8mm/sabotage-gsw-no-flipbook";
/** PM1's capture sabotage frame (run-gate8.sh G8MM_SABOTAGE_FRAME). */
const SABOTAGE_FRAME = 30;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EXPECTED = join(HERE, "..", "..", "fixtures", "gate8-mm", "expected.json");

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface Pixels {
  regions: Record<string, Region>;
  known_gaps?: Record<string, { cells: string[] }>;
}

/** One GSW shot against its reference shot. */
export interface MmPair {
  shot: string;
  frame: number;
  reference: string;
  /** Pixels beyond channel 1 outside the known-gap cells, per cell ("outside" for none). */
  other: Record<string, number>;
  max_other: number;
  delta1: number;
}

/** Inclusive-region lookup: the cell holding (x, y), or "outside". */
function cellOf(regions: Record<string, Region>, x: number, y: number): string {
  for (const [name, [x0, y0, x1, y1]] of Object.entries(regions))
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return name;
  return "outside";
}

export function mmPairDiff(
  a: Rgba,
  b: Rgba,
  regions: Record<string, Region>,
  skip: Set<string>,
): Omit<MmPair, "shot" | "frame" | "reference"> | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const other: Record<string, number> = {};
  let maxOther = 0;
  let delta1 = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    const i = p * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d === 0) continue;
    const cell = cellOf(regions, p % a.width, Math.floor(p / a.width));
    if (skip.has(cell)) continue;
    if (d === 1) {
      delta1++;
      continue;
    }
    other[cell] = (other[cell] ?? 0) + 1;
    maxOther = Math.max(maxOther, d);
  }
  return { other, max_other: maxOther, delta1 };
}

interface Applied {
  transactions?: { seq: number; frame: number }[];
  shots?: { seq: number; path: string }[];
}

/** Every shot of GSW leg `leg` paired with the reference shot of its host frame. */
async function legPairs(
  ctx: Ctx,
  leg: string,
  px: Pixels,
  skip: Set<string>,
  problems: string[],
): Promise<MmPair[]> {
  const dir = join(ctx.out, "gate8", "gsw", leg);
  const applied = await readJson<Applied>(join(dir, "applied.json"));
  if (!applied) {
    problems.push(`${leg}: applied.json missing`);
    return [];
  }
  const steps = (
    await readFile(join(ctx.sourceDir, "g8mm", "capture", "steps.jsonl"), "utf8").catch(() => "")
  )
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { step: number; settle_frame: number });
  const frameOf = new Map((applied.transactions ?? []).map((t) => [t.seq, t.frame]));
  const out: MmPair[] = [];
  for (const s of applied.shots ?? []) {
    const frame = frameOf.get(s.seq);
    const name = `seq-${s.seq}.png`;
    let ref: string | undefined;
    for (const st of steps) {
      if (frame === st.settle_frame) ref = `step-${st.step}.png`;
      else if (frame === st.settle_frame - 1) ref = `step-${st.step}-prev.png`;
    }
    if (frame === undefined || ref === undefined) continue;
    const a = await decodePngRgba(join(dir, "shots", name));
    const b = await decodePngRgba(join(ctx.sourceDir, "g8mm", "reference", "shots", ref));
    if (!a || !b) {
      problems.push(`${leg}/${name}: ${a ? "" : "the gsw shot "}${b ? "" : `the reference ${ref} `}missing`);
      continue;
    }
    const d = mmPairDiff(a, b, px.regions, skip);
    if (!d) {
      problems.push(`${leg}/${name}: ${a.width}x${a.height} against the reference's ${b.width}x${b.height}`);
      continue;
    }
    out.push({ shot: name, frame, reference: ref, ...d });
  }
  if (out.length === 0) problems.push(`${leg}: no shot pairs with a reference shot`);
  return out;
}

const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const cells = (o: Record<string, number>) =>
  Object.entries(o)
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");

/** The PM3 checks (header). Not emitted when the source ran no g8mm reference. */
export async function mmGswChecks(ctx: Ctx): Promise<Gate7Check[]> {
  if (!existsSync(join(ctx.sourceDir, "g8mm", "reference"))) return [];
  const expected = await readJson<{ pixels?: Pixels }>(FIXTURE_EXPECTED);
  const px = expected?.pixels;
  if (!px) return [mk("mm-gsw-band@gsw", "PM3", ["fixtures/gate8-mm/expected.json has no pixels"], "")];
  const skip = new Set(Object.values(px.known_gaps ?? {}).flatMap((g) => g.cells));
  const gaps = [...skip].join(", ") || "none";
  const out: Gate7Check[] = [];

  const honest: Record<string, MmPair[]> = {};
  {
    const problems: string[] = [];
    let n = 0;
    for (const leg of MM_HONEST) {
      honest[leg] = await legPairs(ctx, leg, px, skip, problems);
      for (const p of honest[leg]) {
        n++;
        if (total(p.other) > 0)
          problems.push(`${leg}/${p.shot} (frame ${p.frame}, ${p.reference}): beyond channel 1 in ${cells(p.other)} (max ${p.max_other})`);
      }
    }
    out.push(
      mk(
        "mm-gsw-band@gsw",
        "PM3: GSW draws /11 multimesh instanced (2D transforms, GLES3's half-float colours and custom data, INSTANCE_CUSTOM, visible_instances, the custom AABB): every shot of the honest legs is the unarmed reference within channel 1, outside the known-gap cells",
        problems,
        `${n} shots within channel 1 of the reference; known-gap cells skipped: ${gaps}`,
      ),
    );
  }

  {
    const problems: string[] = [];
    for (const leg of MM_HONEST)
      for (const p of honest[leg] ?? [])
        if ((p.other.C_FLIP ?? 0) > 0) problems.push(`${leg}/${p.shot}: C_FLIP ${p.other.C_FLIP} px beyond channel 1`);
    const sab = await legPairs(ctx, MM_NO_FLIPBOOK, px, skip, problems);
    const caught = sab.filter((p) => (p.other.C_FLIP ?? 0) > 0);
    if (sab.length > 0 && caught.length === 0)
      problems.push(`${MM_NO_FLIPBOOK}: C_FLIP within the band at every shot (the check has no teeth)`);
    // Unflipped quads are h_frames x v_frames larger, so they spill over C_FLIP's row (into
    // B_CUSTOM's cell); every cell below that row must equal the honest GSW leg's exactly.
    const lower = Object.entries(px.regions).filter(([, r]) => r[1] > (px.regions.C_FLIP?.[3] ?? 0));
    for (const p of sab) {
      const a = await decodePngRgba(join(ctx.out, "gate8", "gsw", MM_NO_FLIPBOOK, "shots", p.shot));
      const b = await decodePngRgba(join(ctx.out, "gate8", "gsw", MM_HONEST[0], "shots", p.shot));
      if (!a || !b) {
        problems.push(`${MM_NO_FLIPBOOK}/${p.shot}: no honest ${MM_HONEST[0]} shot to compare`);
        continue;
      }
      for (const [name, [x0, y0, x1, y1]] of lower) {
        let moved = 0;
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const i = (y * a.width + x) * 4;
            for (let c = 0; c < 4; c++)
              if (a.data[i + c] !== b.data[i + c]) {
                moved++;
                break;
              }
          }
        if (moved > 0) problems.push(`${MM_NO_FLIPBOOK}/${p.shot}: ${name} ${moved} px differ from the honest leg`);
      }
    }
    out.push(
      mk(
        "mm-gsw-flipbook@gsw",
        "PM3: a particles_animation CanvasItemMaterial draws through its template's vertex() over INSTANCE_CUSTOM.z (the flipbook): C_FLIP is the reference within channel 1 on the honest legs, and GSW's no-flipbook sabotage (the builtin, as before PM3) moves C_FLIP beyond it and leaves every cell below C_FLIP's row as the honest leg draws it",
        problems,
        `C_FLIP within channel 1 on ${MM_HONEST.length} legs; no-flipbook beyond it at ${caught.length} of ${sab.length} shots`,
      ),
    );
  }

  {
    const problems: string[] = [];
    const pairs = await legPairs(ctx, MM_PERTURB, px, skip, problems);
    const after = pairs.filter((p) => p.frame >= SABOTAGE_FRAME);
    const before = pairs.filter((p) => p.frame < SABOTAGE_FRAME);
    if (after.length === 0) problems.push(`${MM_PERTURB}: no shot at or after frame ${SABOTAGE_FRAME}`);
    else if (!after.some((p) => total(p.other) > 0))
      problems.push(`${MM_PERTURB}: within the band after frame ${SABOTAGE_FRAME} (not caught)`);
    for (const p of before)
      if (total(p.other) > 0) problems.push(`${MM_PERTURB}/${p.shot}: beyond the band before the sabotage (${cells(p.other)})`);
    const caught = after.filter((p) => total(p.other) > 0);
    out.push(
      mk(
        "mm-gsw-catches-perturb-instance@gsw",
        "PM3: the capture sabotage perturb-instance (one buffer float + 1.0 from frame 30, on the patch sink) replayed by GSW fails mm-gsw-band after frame 30 and holds it before",
        problems,
        `caught at ${caught.length} of ${after.length} shots after frame ${SABOTAGE_FRAME} (${caught.map((p) => cells(p.other)).join("; ")}); ${before.length} shots before it within the band`,
      ),
    );
  }

  {
    const problems: string[] = [];
    const pairs = await legPairs(ctx, MM_UNDRAWN, px, skip, problems);
    const caught = pairs.filter((p) => total(p.other) > 0);
    if (pairs.length > 0 && caught.length === 0) problems.push(`${MM_UNDRAWN}: within the band (not caught)`);
    out.push(
      mk(
        "mm-gsw-catches-undrawn-multimesh@gsw",
        "PM3: the receiver sabotage undrawn-multimesh (every add_multimesh skipped, as GSW drew before PM3) fails mm-gsw-band",
        problems,
        `caught at ${caught.length} of ${pairs.length} shots`,
      ),
    );
  }
  return out;
}
