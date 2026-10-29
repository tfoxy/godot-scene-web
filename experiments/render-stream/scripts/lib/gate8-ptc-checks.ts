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
// PSE (render-stream-12.md "As built (PSE)"): two more cells, S_BOX and S_SPHERE, are 48 still
// particles each on one uniform-switched process shader (fixtures/gate8-ptc/ptc_switched.gdshader:
// `emission_shape` a uniform, and an `emit_subparticle` call only RendererRD declares), one
// material a box and one a sphere:
//
//   pts-host-switched   the premise, on the stock engine: reference-fwdplus draws S_BOX as a box
//                       (wide and flat) and S_SPHERE as a disc (as tall as it is wide), and
//                       reference-gl draws neither (GLES3 fails to compile emit_subparticle)
//   ptc-receiver        (extended) every shot's S_BOX and S_SPHERE regions are reference-fwdplus's
//                       within PTS_TOLERANCE_PX pixels off by more than PTS_LEVEL levels
//   ptc-receiver-catches-no-subparticle-stub  the receiver that sets a RendererRD host's particles
//                       code as given (no-subparticle-stub, the pre-PSE receiver) fails
//                       ptc-receiver (it draws neither switched cell)
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
  sabotageStub: "ptc/sabotage-no-subparticle-stub/receiver",
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

/** PSE: the switched cells (ptc.gd): 48 particles of a 4x4 white quad each, emitted in a box of
 * extents (70, 22) or a sphere of radius 45 around `at`; `half` bounds the region judged (the
 * shape plus the quad's half and a margin). */
export const PTS_CELLS = [
  { cell: "S_BOX", at: [200, 290], half: [76, 28], shape: "box" },
  { cell: "S_SPHERE", at: [440, 290], half: [50, 50], shape: "sphere" },
] as const;
/** PSE: a pixel is drawn when a channel is more than PTS_LEVEL levels off the clear colour, and
 * two shots differ at a pixel when a channel differs by more than PTS_LEVEL. */
export const PTS_LEVEL = 16;
/** PSE: the pixels of a switched cell a receiver may differ from the reference by. */
export const PTS_TOLERANCE_PX = 0;

export interface PtsRegion {
  /** Pixels drawn (off the clear colour by more than PTS_LEVEL). */
  drawn: number;
  /** The drawn pixels' bounding box [x0, y0, x1, y1] (inclusive), or null when none is. */
  bbox: [number, number, number, number] | null;
}

/** PSE: a switched cell's drawn pixels in `img`. */
export function ptsRegion(img: Img, c: (typeof PTS_CELLS)[number]): PtsRegion {
  const clear = Math.round(PTC_CLEAR * 255);
  let drawn = 0;
  let bbox: [number, number, number, number] | null = null;
  for (let y = c.at[1] - c.half[1]; y <= c.at[1] + c.half[1]; y++)
    for (let x = c.at[0] - c.half[0]; x <= c.at[0] + c.half[0]; x++) {
      const i = (y * img.width + x) * 4;
      if (![0, 1, 2].some((k) => Math.abs(img.data[i + k] - clear) > PTS_LEVEL)) continue;
      drawn++;
      bbox = bbox ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)] : [x, y, x, y];
    }
  return { drawn, bbox };
}

/** PSE: the pixels of a switched cell where `img` and `ref` differ by more than PTS_LEVEL. */
export function ptsDiff(img: Img, ref: Img, c: (typeof PTS_CELLS)[number]): number {
  let n = 0;
  for (let y = c.at[1] - c.half[1]; y <= c.at[1] + c.half[1]; y++)
    for (let x = c.at[0] - c.half[0]; x <= c.at[0] + c.half[0]; x++) {
      const i = (y * img.width + x) * 4;
      if ([0, 1, 2].some((k) => Math.abs(img.data[i + k] - ref.data[i + k]) > PTS_LEVEL)) n++;
    }
  return n;
}

/** PSE: problems of `img`'s switched cells against `ref`'s (ptc-receiver's switched half). */
export function ptsProblems(label: string, img: Img, ref: Img): string[] {
  const out: string[] = [];
  for (const c of PTS_CELLS) {
    const d = ptsDiff(img, ref, c);
    if (d > PTS_TOLERANCE_PX) {
      const got = ptsRegion(img, c);
      const want = ptsRegion(ref, c);
      out.push(
        `${label} ${c.cell}: ${d} px differ (drawn ${got.drawn} px in ${JSON.stringify(got.bbox)}, the reference ${want.drawn} px in ${JSON.stringify(want.bbox)})`,
      );
    }
  }
  return out;
}

/** PSE: problems of a reference shot's switched cells against the shapes the materials ask for
 * (`drawn`: the Forward+ host's; else gl_compatibility's, which draws neither). */
export function ptsShapeProblems(label: string, img: Img, drawn: boolean): string[] {
  const out: string[] = [];
  for (const c of PTS_CELLS) {
    const r = ptsRegion(img, c);
    if (!drawn) {
      if (r.drawn > 0) out.push(`${label} ${c.cell}: ${r.drawn} px drawn (gl_compatibility compiles no emit_subparticle)`);
      continue;
    }
    if (!r.bbox || r.drawn < 100) {
      out.push(`${label} ${c.cell}: ${r.drawn} px drawn`);
      continue;
    }
    const w = r.bbox[2] - r.bbox[0] + 1;
    const h = r.bbox[3] - r.bbox[1] + 1;
    // A box of extents (70, 22) is about 144x48 px; a sphere of radius 45 about 94x94.
    const ok = c.shape === "box" ? w >= 100 && h <= 50 : w >= 60 && h >= 60 && w <= 100 && h <= 100;
    if (!ok) out.push(`${label} ${c.cell}: drawn ${w}x${h} px, not a ${c.shape}`);
  }
  return out;
}

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
    problems.push(...ptsProblems(`${leg} step ${i}`, img, fwd[i]));
  });
  return problems;
}

export interface PtcDeps {
  validate: (path: string) => Promise<[string, string] | null>;
}

export const PTC_CHECK_IDS = [
  "ptc-host-colors",
  "pts-host-switched",
  "ptc-validate",
  "ptc-receiver",
  "ptc-receiver-catches-gl-particle-colors",
  "ptc-receiver-catches-no-subparticle-stub",
] as const;

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
  report.switched = Object.fromEntries(
    [
      ["reference-gl", gl],
      ["reference-fwdplus", fwd],
    ].map(([k, imgs]) => [k, (imgs as Img[] | null)?.[0] ? PTS_CELLS.map((c) => ({ cell: c.cell, ...ptsRegion((imgs as Img[])[0], c) })) : null]),
  );
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

  // pts-host-switched
  {
    let problems: string[] | null = null;
    if (gl && fwd && gl.length > 0 && fwd.length > 0) {
      problems = [];
      gl.forEach((img, i) => problems!.push(...ptsShapeProblems(`reference-gl step ${i}`, img, false)));
      fwd.forEach((img, i) => problems!.push(...ptsShapeProblems(`reference-fwdplus step ${i}`, img, true)));
    }
    const r = fwd?.[0] ? PTS_CELLS.map((c) => `${c.cell} ${JSON.stringify(ptsRegion(fwd[0], c).bbox)}`).join(", ") : "";
    checks.push(
      check(
        "pts-host-switched",
        "PSE: on the stock engine a process shader shared by two ParticleProcessMaterials whose emission shape is a uniform draws each material's own shape on a Forward+ host (S_BOX a box, S_SPHERE a disc), and gl_compatibility draws neither (GLES3 declares no emit_subparticle)",
        problems,
        `forward_plus ${r}; gl_compatibility none`,
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
        `PFB: the gl_compatibility receiver of the Forward+ capture draws every cell as the Forward+ host does (within ${PTC_TOLERANCE} levels); PSE: and the switched cells' particles exactly where the host does (at most ${PTS_TOLERANCE_PX} px more than ${PTS_LEVEL} levels off)`,
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
    const stub = fwd ? await receiverProblems(g, PTC_LEGS.sabotageStub, fwd) : null;
    checks.push(
      check(
        "ptc-receiver-catches-no-subparticle-stub",
        "PSE: the receiver that sets a RendererRD host's particles code as given (no-subparticle-stub, the pre-PSE receiver) fails ptc-receiver",
        stub === null ? null : stub.length > 0 ? [] : ["ptc-receiver passed on the sabotage receiver"],
        stub?.[0],
      ),
    );
  }
}
