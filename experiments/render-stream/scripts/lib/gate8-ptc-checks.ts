// Gate 8 g8pt particle colour checks (PFB, protocol/render-stream-12.md "As built (PFB)"):
// fixtures/gate8-ptc's three cells, each one still GPUParticles2D particle drawing a 32x32 white
// texture, rendered unarmed on both backends (ptc/reference-gl on gl_compatibility,
// ptc/reference-fwdplus on Forward+), captured armed on the Forward+ host (ptc/capture) and replayed
// by the gl_compatibility receivers (ptc/receiver, and ptc/sabotage-gl-particle-colors/receiver,
// the pre-PFB receiver that sets a particles material's colours as given).
//
//   ptc-host-colors     the premise, on the stock engine: reference-fwdplus is forward_plus and
//                       reference-gl gl_compatibility; each draws every cell as PTC_MODEL predicts
//                       for its backend (RendererRD runs the process material's `color` through
//                       Color::srgb_to_linear(), GLES3 does not; C_RAMP, a colour ramp texture,
//                       is the same on both), so C_MIX and C_ADD differ between them
//   ptc-validate        both sinks of ptc/capture pass the TypeScript validator and rs-core-check,
//                       and the capture host is forward_plus
//   ptc-receiver        ptc/receiver's every shot equals reference-fwdplus's shot of the same step
//                       within PTC_TOLERANCE at every cell's centre patch and the background
//   ptc-receiver-catches-gl-particle-colors  the sabotage receiver fails ptc-receiver (it draws the
//                       gl_compatibility colours)
//
// A host whose Vulkan is unavailable falls back to opengl3 (the fixture prints its rendering
// method): the checks are then not run (gating false, `unavailable` in the detail).

import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck, readText, skipped } from "./gate8-adopt-checks";

export const PTC_LEGS = {
  referenceGl: "ptc/reference-gl",
  referenceFwd: "ptc/reference-fwdplus",
  capture: "ptc/capture",
  receiver: "ptc/receiver",
  sabotage: "ptc/sabotage-gl-particle-colors/receiver",
} as const;

/** The fixture's cells (ptc.gd): centre, process-material colour, blend, and whether the colour
 * is a uniform (RendererRD linearizes it) or a ramp texture (it does not). */
export const PTC_CELLS = [
  { cell: "C_MIX", at: [160, 180], color: [0.5, 0.25, 0.75, 1], blend: "mix", uniform: true },
  { cell: "C_ADD", at: [320, 180], color: [0.6, 0.4, 0.2, 0.5], blend: "add", uniform: true },
  { cell: "C_RAMP", at: [480, 180], color: [0.5, 0.25, 0.75, 1], blend: "mix", uniform: false },
] as const;
/** project.godot's clear colour (0.2 grey) and a background sample point. */
export const PTC_CLEAR = 0.2;
export const PTC_BACKGROUND: readonly [number, number] = [40, 40];
/** Per-channel tolerance (levels) of a receiver against the reference, and of a reference
 * against PTC_MODEL (8-bit rounding and the blend's own rounding). */
export const PTC_TOLERANCE = 2;
/** The half-size of the sampled centre patch (the particle's quad is 32x32). */
const PATCH = 4;

/** Godot's Color::srgb_to_linear() on one channel (core/math/color.h:191-197). */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * (1 / 12.92) : ((c + 0.055) * (1 / 1.055)) ** 2.4;
}

/** The 8-bit RGB a backend draws at a cell's centre: the colour (linearized by RendererRD when it
 * is a uniform), mixed opaque or added at its alpha over the clear colour. */
export function ptcModel(cell: (typeof PTC_CELLS)[number], rd: boolean): [number, number, number] {
  const rgb = [0, 1, 2].map((k) => (rd && cell.uniform ? srgbToLinear(cell.color[k]) : cell.color[k]));
  const out = rgb.map((c) => (cell.blend === "add" ? Math.min(1, PTC_CLEAR + c * cell.color[3]) : c));
  return out.map((c) => c * 255) as [number, number, number];
}

type Img = { data: Uint8Array; width: number; height: number };

/** The patch's per-pixel RGB, row-major. */
function patch(img: Img, [cx, cy]: readonly [number, number] | readonly number[], half = PATCH): number[][] {
  const out: number[][] = [];
  for (let y = cy - half; y < cy + half; y++)
    for (let x = cx - half; x < cx + half; x++) {
      const i = (y * img.width + x) * 4;
      out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  return out;
}

/** Problems where `img`'s patch at `at` differs from `want` (one RGB, or the other image's same
 * patch) by more than `tol` in any channel. */
export function patchProblems(
  label: string,
  img: Img,
  at: readonly number[],
  want: readonly number[] | Img,
  tol: number,
): string[] {
  const got = patch(img, at);
  const ref = "data" in want ? patch(want, at) : got.map(() => want as readonly number[]);
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < got.length; i++)
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(got[i][k] - ref[i][k]);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
  if (worst <= tol) return [];
  return [`${label}: ${JSON.stringify(got[worstAt])} vs ${JSON.stringify(ref[worstAt].map((v) => Math.round(v)))} (off by ${worst})`];
}

function methodOf(stdout: string | undefined): string | null {
  return /\[fixture\] rendering_method=(\S+)/.exec(stdout ?? "")?.[1] ?? null;
}

/** The leg's shots in order: a reference's step-<k>.png, a receiver's seq-<n>.png by seq. */
async function shots(dir: string, reference: boolean): Promise<Img[] | null> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(join(dir, "shots"));
  } catch {
    return null;
  }
  const re = reference ? /^step-(\d+)\.png$/ : /^seq-(\d+)\.png$/;
  const ordered = names
    .map((n) => [n, re.exec(n)] as const)
    .filter((x): x is readonly [string, RegExpExecArray] => x[1] !== null)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]));
  const out: Img[] = [];
  for (const [n] of ordered) {
    const img = await decodePngRgba(join(dir, "shots", n));
    if (!img) return null;
    out.push(img);
  }
  return out;
}

/** Problems of a receiver leg against the Forward+ reference (ptc-receiver's criterion). */
async function receiverProblems(g: string, leg: string, fwd: Img[]): Promise<string[] | null> {
  const got = await shots(join(g, leg), false);
  if (!got) return null;
  if (got.length !== fwd.length) return [`${leg}: ${got.length} shots, the reference ${fwd.length}`];
  const problems: string[] = [];
  got.forEach((img, i) => {
    for (const c of PTC_CELLS) problems.push(...patchProblems(`${leg} step ${i} ${c.cell}`, img, c.at, fwd[i], PTC_TOLERANCE));
    problems.push(...patchProblems(`${leg} step ${i} background`, img, PTC_BACKGROUND, fwd[i], PTC_TOLERANCE));
  });
  return problems;
}

export interface PtcDeps {
  validate: (path: string) => Promise<[string, string] | null>;
}

export const PTC_CHECK_IDS = ["ptc-host-colors", "ptc-validate", "ptc-receiver", "ptc-receiver-catches-gl-particle-colors"] as const;

export async function runG8ptPtc(g: string, deps: PtcDeps, checks: G8aCheck[], report: Record<string, unknown>): Promise<void> {
  const dir = (leg: string) => join(g, leg);
  const anySkipped = Object.values(PTC_LEGS).find((l) => skipped(dir(l)));
  const notRun = (detail: string) => {
    for (const id of PTC_CHECK_IDS)
      checks.push({ id, criterion: "PFB: a RendererRD host's particle colours", passed: true, status: "not-run", detail, gating: false });
  };
  if (anySkipped) return notRun(`skipped: ${anySkipped}`);
  const fwdMethod = methodOf(await readText(join(dir(PTC_LEGS.referenceFwd), "stdout.log")));
  const capMethod = methodOf(await readText(join(dir(PTC_LEGS.capture), "stdout.log")));
  report.methods = { reference_fwdplus: fwdMethod, capture: capMethod };
  if (fwdMethod !== null && fwdMethod !== "forward_plus")
    return notRun(`unavailable: the Forward+ reference ran ${fwdMethod} (no Vulkan on this host)`);

  const gl = await shots(dir(PTC_LEGS.referenceGl), true);
  const fwd = await shots(dir(PTC_LEGS.referenceFwd), true);
  report.samples = Object.fromEntries(
    [
      ["reference-gl", gl],
      ["reference-fwdplus", fwd],
    ].map(([k, imgs]) => [k, (imgs as Img[] | null)?.[0] ? PTC_CELLS.map((c) => patch((imgs as Img[])[0], c.at, 1)[0]) : null]),
  );

  // ptc-host-colors
  {
    let problems: string[] | null = null;
    if (gl && fwd && gl.length > 0 && fwd.length > 0) {
      problems = [];
      const glMethod = methodOf(await readText(join(dir(PTC_LEGS.referenceGl), "stdout.log")));
      if (glMethod !== "gl_compatibility") problems.push(`reference-gl ran ${glMethod}`);
      if (fwdMethod !== "forward_plus") problems.push(`reference-fwdplus ran ${fwdMethod}`);
      for (const [name, imgs, rd] of [
        ["reference-gl", gl, false],
        ["reference-fwdplus", fwd, true],
      ] as const)
        imgs.forEach((img, i) => {
          for (const c of PTC_CELLS) problems!.push(...patchProblems(`${name} step ${i} ${c.cell}`, img, c.at, ptcModel(c, rd), PTC_TOLERANCE));
        });
      const differ = PTC_CELLS.filter((c) => c.uniform).every((c) => patchProblems("", gl[0], c.at, fwd[0], 16).length > 0);
      if (!differ) problems.push("C_MIX and C_ADD do not differ between the backends (the premise does not hold)");
    }
    checks.push(
      check(
        "ptc-host-colors",
        "PFB: on the stock engine a RendererRD host draws a particles material's colour linearized (Color::srgb_to_linear) and gl_compatibility as given; a colour ramp texture is the same on both",
        problems,
        `C_MIX gl ${JSON.stringify(ptcModel(PTC_CELLS[0], false).map(Math.round))}, forward_plus ${JSON.stringify(ptcModel(PTC_CELLS[0], true).map(Math.round))} (model)`,
      ),
    );
  }

  // ptc-validate
  {
    const problems: string[] = [];
    let any = false;
    for (const sink of ["recording.rs12", "recording-patch.rs12"]) {
      const v = await deps.validate(join(dir(PTC_LEGS.capture), sink));
      if (!v) continue;
      any = true;
      if (v[0] !== "ok") problems.push(`${sink}: TS ${v[0]}`);
      if (v[1] !== "ok") problems.push(`${sink}: rs-core ${v[1]}`);
    }
    if (capMethod !== "forward_plus") problems.push(`the capture host ran ${capMethod}`);
    checks.push(check("ptc-validate", "PFB: both sinks of the Forward+ capture pass both validators", any ? problems : null));
  }

  // ptc-receiver and its catch
  {
    const honest = fwd ? await receiverProblems(g, PTC_LEGS.receiver, fwd) : null;
    checks.push(
      check(
        "ptc-receiver",
        `PFB: the gl_compatibility receiver of the Forward+ capture draws every cell as the Forward+ host does (within ${PTC_TOLERANCE} levels)`,
        honest,
      ),
    );
    const sab = fwd ? await receiverProblems(g, PTC_LEGS.sabotage, fwd) : null;
    checks.push(
      check(
        "ptc-receiver-catches-gl-particle-colors",
        "PFB: the receiver that sets the colours as given (gl-particle-colors, the pre-PFB receiver) fails ptc-receiver",
        sab === null ? null : sab.length > 0 ? [] : ["ptc-receiver passed on the sabotage receiver"],
        sab?.[0],
      ),
    );
  }
}
