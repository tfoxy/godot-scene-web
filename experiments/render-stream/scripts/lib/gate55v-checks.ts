// Gate 5.5 group g55v (P3-VX, protocol/gate5_5-design.md "vertex() (P3-VX)"): canvas_item
// ShaderMaterials with a vertex() function or a vertex render mode over fixtures/gate55-vertex,
// judged against the Godot reference and a hand model of Godot 4.5.1's canvas.glsl vertex stage
// (drivers/gles3/shaders/canvas.glsl:179-280) at every solid or texel-exact item.
//
// Pure over an evidence directory written by run-gate55.sh's run_g55v (<out>/vertex/):
//   import/{fixture,receiver}/           editor --import passes
//   capture/                             headless capture, render-stream/8 full and patch sinks,
//                                        store/, steps.jsonl
//   reference/, reference-repeat/        rendered fixture: shots/step-<k>.png
//   receiver/, receiver-patch/           rendered receivers on the full and patch sinks:
//                                        shot-seqs.txt, shots/seq-<n>.png
//   sabotage-receiver-flat-varyings/     RS_RECEIVER_SABOTAGE=vertex-flat-varyings
//
// Checks: the capture carries every shader `ok` with its GRP1 payload in the store and types
// nothing unsupported; the reference repeats exactly and equals the hand model (where the model
// has a value: the skip/world/canvas-matrix rects land where Godot's order puts them, the flat
// varyings take the provoking vertex, the UV flip samples the transposed texel, SCREEN_MATRIX's
// clip position within 1); every receiver shot equals the reference, exactly natively; the
// sabotage differs from the reference inside the two items whose smooth varying varies across a
// primitive (VP, VM) at every step, and nowhere else.
//
// Browser receivers (gate 7 runs this group with GATE7_LIVE_KIND=web|gsw; a browser leg's directory
// holds page-config.json) are judged within 1 per channel everywhere: interpolated varyings and the
// HSV arithmetic are driver arithmetic (ANGLE against the native driver). Geometry is exact either
// way: every edge of the fixture keeps clear of pixel centres.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import { check } from "./gate3-checks";
import type { Gate5Check } from "./gate5-checks";
import type { Gate55LegEntry } from "./gate55c-checks";
import { resolveRecording } from "./render-stream-2";

export const G55V_STEPS = 5;
const WIDTH = 640;
const HEIGHT = 360;
const CLEAR: Rgb = [51, 51, 102];
/** Shaders the fixture makes (fixtures/gate55-vertex/shaders/). */
const SHADER_COUNT = 12;

type Rgb = [number, number, number];
type Rect = [number, number, number, number];

const inRect = (x: number, y: number, r: Rect): boolean =>
  x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

/** The fixture's 32x32 pattern texel (gate55_vertex.gd `_pattern_texture`). */
function texel(x: number, y: number): Rgb {
  const checker = ((x >> 3) + (y >> 3)) % 2 === 0;
  return [x * 8, y * 8, checker ? 204 : 51];
}

/** Item rects at a step (gate55_vertex.gd `_ready` / `_apply_step`). */
export function g55vLayout(step: number) {
  const [dx, dy] = step >= 2 ? [8, 4] : [0, 0];
  return {
    vh: [16, 16, 96, 96] as Rect,
    vp: [128, 16, 96, 96] as Rect,
    /** VD's bounding box (its top and bottom edges slope 1/4). */
    vd: [240 + dx, 16 + dy, 64, 80] as Rect,
    vdInside: [288 + dx, 40 + dy, 12, 40] as Rect,
    vdAboveEdge: [296 + dx, 16 + dy, 8, 8] as Rect,
    vu: [336, 16, 96, 96] as Rect,
    vf: [448, 16, 64, 64] as Rect,
    vs1: [16, 128, 32, 32] as Rect,
    /** Where VS1 would land if its model transform were applied. */
    vs1Transformed: [316, 328, 32, 32] as Rect,
    vs2: [64, 136, 32, 32] as Rect,
    vs2Above: [64, 128, 32, 8] as Rect,
    vw: [120, 128, 32, 32] as Rect,
    /** Where VW's +8 would end if it ran before the model transform (+16 on the 2x node). */
    vwLocalOrder: [152, 128, 8, 32] as Rect,
    vt: [180, 128, 32, 32] as Rect,
    vtLeft: [176, 128, 4, 32] as Rect,
    vm: [224, 128, 96, 64] as Rect,
    vc: (step >= 3 ? [526, 171, 32, 32] : [516, 166, 32, 32]) as Rect,
    vld: (step >= 3 ? [496, 140, 32, 32] : [488, 136, 32, 32]) as Rect,
  };
}

/**
 * The hand model at pixel (x, y) and step, or null where the model has no value (VH's HSV
 * arithmetic, VP's interpolated colours: judged against the reference only).
 */
export function g55vModel(
  step: number,
  x: number,
  y: number,
): { rgb: Rgb; tolerance: number } | null {
  const L = g55vLayout(step);
  const solid = (rgb: Rgb) => ({ rgb, tolerance: 0 });
  if (inRect(x, y, L.vh) || inRect(x, y, L.vp)) return null;
  // VD: the displaced quad's interior and the clear space above its sloped top edge; its edges
  // themselves are judged against the reference only.
  if (inRect(x, y, L.vdInside)) return solid([51, 153, 217]);
  if (inRect(x, y, L.vdAboveEdge)) return solid(CLEAR);
  if (inRect(x, y, L.vd)) return null;
  if (inRect(x, y, L.vu)) {
    // UV' = 1 - UV.yx, nearest: texel (32 - 32·v, 32 - 32·u) at the pixel centre.
    const u = (x - L.vu[0] + 0.5) / L.vu[2];
    const v = (y - L.vu[1] + 0.5) / L.vu[3];
    return solid(texel(Math.floor((1 - v) * 32), Math.floor((1 - u) * 32)));
  }
  // VF: GLES3's indexed quad {0, 2, 1, 3, 2, 0} ends the lower-left triangle on vertex_base
  // (0, 1) and the upper-right one on (0, 0) (GL's provoking vertex is the last): VERTEX (0, 64)
  // gives (0, .75, .25), VERTEX (0, 0) gives (0, 0, .25); `column` is 0 for both. The diagonal's
  // pixel centres are edge ties, left to the reference.
  if (inRect(x, y, L.vf)) {
    const below = y - L.vf[1] - (x - L.vf[0]);
    if (below === 0) return null;
    return solid(below > 0 ? [0, 191, 64] : [0, 0, 64]);
  }
  if (inRect(x, y, L.vs1)) return solid([217, 89, 38]);
  if (inRect(x, y, L.vs1Transformed)) return solid(CLEAR);
  if (inRect(x, y, L.vs2)) return solid([38, 217, 89]);
  if (inRect(x, y, L.vs2Above)) return solid(CLEAR);
  if (inRect(x, y, L.vw)) return solid([89, 38, 217]);
  if (inRect(x, y, L.vwLocalOrder)) return solid(CLEAR);
  // VT: TEXTURE_PIXEL_SIZE 1/32 (·20 = .625), AT_LIGHT_PASS false, INSTANCE_CUSTOM 0.
  if (inRect(x, y, L.vt)) return solid([159, 159, 191]);
  if (inRect(x, y, L.vtLeft)) return solid(CLEAR);
  if (inRect(x, y, L.vm))
    // SCREEN_MATRIX · CANVAS_MATRIX · MODEL_MATRIX: Godot's screen_transform maps canvas y
    // down to clip y up the render target, which is stored y-up, so green grows down the shot.
    return {
      rgb: [
        Math.round(((x + 0.5) / WIDTH) * 255),
        Math.round(((y + 0.5) / HEIGHT) * 255),
        128,
      ],
      tolerance: 1,
    };
  // VLD is drawn after VC, over their shared corner.
  if (inRect(x, y, L.vld)) return solid([64, 204, 204]);
  if (inRect(x, y, L.vc)) return solid([204, 204, 64]);
  return solid(CLEAR);
}

interface Shot {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Pixels where `a` and `b` differ in RGB beyond `tolerance`, their bounding box and the largest
 * delta.
 */
function diffShots(
  a: Shot,
  b: Shot,
  tolerance: number,
): { count: number; bbox: Rect | null; pixels: number[]; max: number } {
  let max = 0;
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  const pixels: number[] = [];
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      max = Math.max(max, delta);
      if (delta > tolerance) {
        count++;
        pixels.push(y * a.width + x);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  return {
    count,
    bbox: count > 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null,
    pixels,
    max,
  };
}

const isBrowserLeg = (dir: string): boolean =>
  existsSync(join(dir, "page-config.json"));

function modelMisses(
  s: Shot,
  step: number,
): { count: number; first: string[] } {
  let count = 0;
  const first: string[] = [];
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const m = g55vModel(step, x, y);
      if (m === null) continue;
      const i = (y * s.width + x) * 4;
      const got = [s.data[i], s.data[i + 1], s.data[i + 2]];
      if (got.some((v, k) => Math.abs(v - m.rgb[k]) > m.tolerance)) {
        count++;
        if (first.length < 4)
          first.push(
            `(${x},${y}) got ${got.join(",")} want ${m.rgb.join(",")}`,
          );
      }
    }
  return { count, first };
}

async function shotSeqs(dir: string): Promise<number[] | undefined> {
  try {
    const text = await readFile(join(dir, "shot-seqs.txt"), "utf8");
    const seqs = text
      .trim()
      .split(",")
      .filter((s) => s !== "")
      .map(Number);
    return seqs.length === G55V_STEPS && seqs.every(Number.isInteger)
      ? seqs
      : undefined;
  } catch {
    return undefined;
  }
}

export interface Gate55vResult {
  checks: Gate5Check[];
  legs: Record<string, Gate55LegEntry>;
  /** per leg and step: pixels differing from the reference (receivers) or the model (reference). */
  pixels: Record<string, number[]>;
}

const RECEIVER_LEGS = ["receiver", "receiver-patch"] as const;
const SABOTAGE_LEG = "sabotage-receiver-flat-varyings";

export async function runGate55v(out: string): Promise<Gate55vResult> {
  const D = join(out, "vertex");
  const checks: Gate5Check[] = [];
  const legs: Record<string, Gate55LegEntry> = {};
  const pixels: Record<string, number[]> = {};
  const rel = (p: string) => p.slice(out.length + 1);

  // --- imports -------------------------------------------------------------------------------
  {
    const problems: string[] = [];
    for (const which of ["fixture", "receiver"]) {
      const code = await readExitCode(join(D, "import", which));
      if (code !== 0) problems.push(`import/${which} exit ${code}`);
    }
    checks.push(
      check(
        "g55v-import",
        "fixtures/gate55-vertex and the receiver import cleanly (editor --import exit 0)",
        problems,
        "both imports exited 0",
        [rel(join(D, "import"))],
      ),
    );
  }

  // --- capture -------------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const cap = join(D, "capture");
    const code = await readExitCode(cap);
    if (code !== 0) problems.push(`capture exit ${code}`);
    let detail = "";
    try {
      const bytes = new Uint8Array(await readFile(join(cap, "recording.rs2")));
      const rec = resolveRecording(bytes, 8);
      const txs = rec.transactions;
      if (txs.length === 0) problems.push("no transactions");
      for (const t of txs) {
        if (t.state.status !== "ok")
          problems.push(`seq ${t.seq}: status ${t.state.status}`);
        if (t.state.unsupported.length > 0)
          problems.push(
            `seq ${t.seq}: unsupported ${JSON.stringify(t.state.unsupported.slice(0, 3))}`,
          );
      }
      const last = txs[txs.length - 1];
      const shaders = last?.state.shaders ?? [];
      if (shaders.length !== SHADER_COUNT)
        problems.push(
          `${shaders.length} shaders on the wire, want ${SHADER_COUNT}`,
        );
      for (const s of shaders) {
        if (s.status !== "ok" || s.reason !== null)
          problems.push(
            `shader ${s.id}: ${s.status}/${s.reason} (want ok/null)`,
          );
        if (s.source !== "payload" || s.hash === null)
          problems.push(`shader ${s.id}: source ${s.source}, hash ${s.hash}`);
        else if (!existsSync(join(cap, "store", "sha256", `${s.hash}.grp`)))
          problems.push(`shader ${s.id}: GRP1 ${s.hash} not in the store`);
      }
      const materials = last?.state.materials ?? [];
      const drawn = (last?.state.items ?? []).filter((it) =>
        materials.some((m) => m.id === it.material && m.shader !== null),
      );
      if (drawn.length !== SHADER_COUNT)
        problems.push(
          `${drawn.length} items name a shader material, want ${SHADER_COUNT}`,
        );
      detail = `${txs.length} transactions ok, nothing unsupported; ${shaders.length} shaders ok with their GRP1 in the store; ${drawn.length} items with a shader material`;
    } catch (e) {
      problems.push(`recording: ${(e as Error).message}`);
    }
    checks.push(
      check(
        "g55v-capture-vertex-shaders-ok",
        "the capture carries every vertex() / vertex-render-mode shader as ok (GRP1 payload in the store) and types nothing unsupported (gate5_5-design.md D11: vertex() was never a reason)",
        problems,
        detail,
        [rel(cap)],
      ),
    );
    legs["vertex/capture"] = {
      group: "g55v",
      expected_class: "success",
      result_class: problems.length === 0 ? "success" : "capture-failure",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(cap)],
    };
  }

  // --- reference: repeat and hand model ------------------------------------------------------
  const refs: (Shot | undefined)[] = [];
  {
    const repeatProblems: string[] = [];
    const modelProblems: string[] = [];
    pixels["reference-model"] = [];
    for (let k = 0; k < G55V_STEPS; k++) {
      const a = await decodePngRgba(
        join(D, "reference", "shots", `step-${k}.png`),
      );
      const b = await decodePngRgba(
        join(D, "reference-repeat", "shots", `step-${k}.png`),
      );
      refs.push(a);
      if (!a || !b) {
        repeatProblems.push(`step ${k}: missing shot`);
        modelProblems.push(`step ${k}: missing shot`);
        pixels["reference-model"].push(-1);
        continue;
      }
      if (a.width !== WIDTH || a.height !== HEIGHT)
        modelProblems.push(`step ${k}: ${a.width}x${a.height}`);
      const d = diffShots(a, b, 0);
      if (d.count > 0)
        repeatProblems.push(
          `step ${k}: ${d.count} px differ in ${JSON.stringify(d.bbox)}`,
        );
      const m = modelMisses(a, k);
      pixels["reference-model"].push(m.count);
      if (m.count > 0)
        modelProblems.push(
          `step ${k}: ${m.count} px miss the model: ${m.first.join("; ")}`,
        );
    }
    checks.push(
      check(
        "g55v-reference-repeat",
        "the rendered reference repeats exactly (budget 0, every step)",
        repeatProblems,
        `${G55V_STEPS} steps identical`,
        [rel(join(D, "reference")), rel(join(D, "reference-repeat"))],
      ),
    );
    checks.push(
      check(
        "g55v-reference-hand-model",
        "the reference equals the hand model of canvas.glsl's vertex stage wherever it has a value: skip_vertex_transform without vertex() never applies the model (VS1), with MODEL_MATRIX in the code (VS2); world_vertex_coords runs the code after the model (VW); VERTEX displaced before the model (VD's interior and sloped edge); flat varyings take the provoking vertex (VF); the transposed, flipped UV (VU); TEXTURE_PIXEL_SIZE, AT_LIGHT_PASS, INSTANCE_CUSTOM (VT); CANVAS_MATRIX apart from MODEL_MATRIX in a scaled CanvasLayer (VC, VLD); SCREEN_MATRIX's clip position within 1 (VM); the clear colour elsewhere",
        modelProblems,
        `${G55V_STEPS} steps match the model`,
        [rel(join(D, "reference"))],
      ),
    );
  }

  // --- receivers: equal to the reference -----------------------------------------------------
  for (const leg of RECEIVER_LEGS) {
    const dir = join(D, leg);
    const problems: string[] = [];
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`exit ${code}`);
    const seqs = await shotSeqs(dir);
    const browser = isBrowserLeg(dir);
    const tolerance = browser ? 1 : 0;
    let max = 0;
    pixels[leg] = [];
    if (!seqs) problems.push(`shot-seqs.txt missing or not ${G55V_STEPS} seqs`);
    for (let k = 0; k < G55V_STEPS && seqs; k++) {
      const r = refs[k];
      const s = await decodePngRgba(join(dir, "shots", `seq-${seqs[k]}.png`));
      if (!r || !s) {
        problems.push(`step ${k}: missing shot`);
        pixels[leg].push(-1);
        continue;
      }
      const d = diffShots(r, s, tolerance);
      max = Math.max(max, d.max);
      pixels[leg].push(d.count);
      if (d.count > 0)
        problems.push(
          `step ${k} (seq ${seqs[k]}): ${d.count} px differ beyond ${tolerance} in ${JSON.stringify(d.bbox)}`,
        );
    }
    checks.push(
      check(
        `g55v-${leg}-equals-reference`,
        `${leg}: every settle shot equals the reference (RGB; native budget 0, a browser leg within 1 per channel: interpolated varyings and the HSV arithmetic are driver arithmetic)`,
        problems,
        `${G55V_STEPS} steps ${browser ? `within 1 (max delta ${max})` : "exact"}`,
        [rel(dir)],
      ),
    );
    legs[`vertex/${leg}`] = {
      group: "g55v",
      expected_class: "success",
      result_class: problems.length === 0 ? "success" : "pixel-mismatch",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  // --- sabotage: varyings not interpolated ----------------------------------------------------
  {
    const dir = join(D, SABOTAGE_LEG);
    const problems: string[] = [];
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`exit ${code}`);
    const seqs = await shotSeqs(dir);
    const tolerance = isBrowserLeg(dir) ? 1 : 0;
    pixels[SABOTAGE_LEG] = [];
    if (!seqs) problems.push(`shot-seqs.txt missing or not ${G55V_STEPS} seqs`);
    let caught = 0;
    for (let k = 0; k < G55V_STEPS && seqs; k++) {
      const r = refs[k];
      const s = await decodePngRgba(join(dir, "shots", `seq-${seqs[k]}.png`));
      if (!r || !s) {
        problems.push(`step ${k}: missing shot`);
        continue;
      }
      const d = diffShots(r, s, tolerance);
      pixels[SABOTAGE_LEG].push(d.count);
      const L = g55vLayout(k);
      const at = (p: number): [number, number] => [
        p % WIDTH,
        Math.floor(p / WIDTH),
      ];
      const inVp = d.pixels.filter((p) => inRect(...at(p), L.vp)).length;
      const inVm = d.pixels.filter((p) => inRect(...at(p), L.vm)).length;
      const outside = d.count - inVp - inVm;
      // A flat varying is one vertex's value per triangle: most of each gradient changes.
      const quarter = (r: Rect) => (r[2] * r[3]) / 4;
      if (inVp > quarter(L.vp) && inVm > quarter(L.vm) && outside === 0)
        caught++;
      else
        problems.push(
          `step ${k}: ${inVp} px differ in VP, ${inVm} in VM, ${outside} elsewhere`,
        );
    }
    checks.push(
      check(
        "g55v-sabotage-flat-varyings-detected",
        "vertex-flat-varyings (every varying made flat before the receiver compiles the code) differs from the reference over more than a quarter of each item whose smooth varying varies across a primitive (VP's four-colour polygon, VM's clip position), at every step, and nowhere else (VH's COLOR varying is uniform over its rect; VF is flat already)",
        problems,
        `${caught}/${G55V_STEPS} steps differ exactly as predicted`,
        [rel(dir)],
      ),
    );
    legs[`vertex/${SABOTAGE_LEG}`] = {
      group: "g55v",
      expected_class: "pixel-mismatch",
      result_class: caught === G55V_STEPS ? "pixel-mismatch" : "unexpected",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  return { checks, legs, pixels };
}
