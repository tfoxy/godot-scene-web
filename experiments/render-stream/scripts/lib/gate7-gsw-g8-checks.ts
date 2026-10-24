// Gate 8's GSW-only checks (G8g), beside the gate's own checks the gsw view judges (`@gsw`, through
// lib/gate7-gsw-g8.ts's tables):
//   compositor-equals-readback:<fixture>@gsw  Q7, one per fixture's honest full-sink leg; gating
//                    only when the leg's last shot is of the state the canvas shows at exit (a
//                    gate 8 fixture changes after its last checkpoint, as gate 5.5's shader scene)
//   gsw-band@gsw     report: each gate 8 gsw shot's classes against the native shot
//                    (lib/gate7-gsw-g8.ts gate8BandViews): delta1, undecided, excluded, other
//   float-texture-quantized@gsw  render-stream-8.md "As built (G8f)": GSW samples no float texture,
//                    so it takes every float payload as RGBA8 through rs-core's `texture_rgba8`
//                    (pinned by protocol/golden-8/float-quantize.json) and says so: the g8f legs'
//                    applied.json `receiver.caveats` holds `float-texture-quantized` and
//                    `receiver.float_quantized` names exactly the float formats the source carried
//                    (check-gate8.ts g8f.carried_formats); a leg with no float payload (g8t's
//                    `receiver`) has no caveat.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Gate7Check } from "./gate7-adapters";
import { compositorProblems, mk } from "./gate7-gsw";
import { type BandShot, GATE8_COMPOSITOR_LEGS } from "./gate7-gsw-g8";

interface Ctx {
  out: string;
  sourceDir: string;
}

const gswDir = (ctx: Ctx, leg: string) => join(ctx.out, "gate8", "gsw", leg);

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The fixture a compositor leg shows (`receiver` is g8t's gate8-tex). */
function fixtureOf(leg: string): string {
  return leg === "receiver" ? "g8t" : (leg.split("/")[0] ?? leg);
}

export async function gate8Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  for (const leg of GATE8_COMPOSITOR_LEGS) {
    const problems = await compositorProblems(gswDir(ctx, leg));
    const comparable = !problems.some((p) => /is not of the state/.test(p));
    out.push(
      mk(
        `compositor-equals-readback:${fixtureOf(leg)}@gsw`,
        "Q7: the CDP screenshot of the canvas, taken while the leg's applied.json PUT is held, equals the leg's last shot channel for channel",
        problems,
        "screenshot equals the last shot exactly",
        comparable,
      ),
    );
  }
  {
    const problems: string[] = [];
    const source = await readJson<{ g8f?: { carried_formats?: string[] } }>(join(ctx.sourceDir, "result.json"));
    const floats = new Set(["RF", "RGF", "RGBF", "RGBAF", "RH", "RGH", "RGBH", "RGBAH"]);
    const carried = (source?.g8f?.carried_formats ?? []).filter((f) => floats.has(f)).sort();
    if (carried.length === 0) problems.push("the source's g8f.carried_formats lists no float format");
    for (const leg of ["g8f/receiver", "g8f/receiver-patch"]) {
      const a = await readJson<{ receiver?: { caveats?: string[]; float_quantized?: string[] } }>(
        join(gswDir(ctx, leg), "applied.json"),
      );
      if (!a?.receiver?.caveats) {
        problems.push(`${leg}: applied.json receiver.caveats missing`);
        continue;
      }
      if (!a.receiver.caveats.includes("float-texture-quantized"))
        problems.push(`${leg}: caveats ${JSON.stringify(a.receiver.caveats)} lack float-texture-quantized`);
      const q = [...(a.receiver.float_quantized ?? [])].sort();
      if (JSON.stringify(q) !== JSON.stringify(carried))
        problems.push(`${leg}: quantized ${JSON.stringify(q)}, carried ${JSON.stringify(carried)}`);
    }
    const plain = await readJson<{ receiver?: { caveats?: string[] } }>(join(gswDir(ctx, "receiver"), "applied.json"));
    if ((plain?.receiver?.caveats ?? ["missing"]).length !== 0)
      problems.push(`receiver (g8t, no float payload): caveats ${JSON.stringify(plain?.receiver?.caveats)}`);
    out.push(
      mk(
        "float-texture-quantized@gsw",
        "G8g (render-stream-8.md As built (G8f)): GSW takes every float payload as RGBA8 by rs-core's quantization and reports the caveat float-texture-quantized naming exactly the float formats carried; a stream without floats has none",
        problems,
        `g8f legs quantized ${carried.join(",")}; g8t's receiver has no caveat`,
      ),
    );
  }
  {
    const band = await readJson<Record<string, BandShot[]>>(join(ctx.out, "gate8", "gsw-band.json"));
    const t = { shots: 0, banded: 0, identical: 0, raw: 0, delta1: 0, undecided: 0, excluded: 0, other: 0 };
    const raw: string[] = [];
    for (const [leg, shots] of Object.entries(band ?? {}))
      for (const s of shots) {
        t.shots++;
        t.delta1 += s.delta1;
        t.undecided += s.undecided;
        t.excluded += s.excluded;
        t.other += s.other;
        if (s.differing === 0) t.identical++;
        else if (s.banded) t.banded++;
        else {
          t.raw++;
          raw.push(`${leg}/${s.shot}: ${s.other} px beyond channel 1 outside the declared regions (max ${s.max_other})`);
        }
      }
    out.push(
      mk(
        "gsw-band@gsw",
        "G8g (report): each gate 8 gsw shot against the native receiver's same shot: within channel 1 or inside the fixture's declared regions (undecided filtering and nine-patch ties, excluded float-gain strips) it stands in for the native shot; any other difference stays the GSW shot for the gate's own checks",
        band === undefined ? ["gsw-band.json missing"] : raw,
        `${t.shots} shots: ${t.identical} identical, ${t.banded} within the band; pixels delta1 ${t.delta1}, undecided ${t.undecided}, excluded ${t.excluded}, other ${t.other}`,
        false,
      ),
    );
  }
  return out;
}
