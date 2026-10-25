// Gate 5.5 group g55t (P3-TM, protocol/gate5_5-design.md "TIME and sampler defaults (P3-TM)"):
// canvas_item ShaderMaterials that read TIME, and samplers left unset under each default hint,
// over fixtures/gate55-time, judged against the Godot reference and a hand model of Godot 4.5.1's
// GLES3 TIME (RasterizerGLES3::begin_frame: each drawn frame's scaled step summed, wrapped at
// time_rollover_secs; drivers/gles3/rasterizer_gles3.cpp:97-107) and default textures
// (drivers/gles3/storage/material_storage.cpp:928-953, texture_storage.cpp:66-155).
//
// Pure over an evidence directory written by run-gate55.sh's run_g55t (<out>/time/):
//   import/{fixture,receiver}/           editor --import passes
//   capture/                             headless capture at --fixed-fps 60, render-stream/10 full
//                                        and patch sinks, store/, steps.jsonl
//   reference/, reference-repeat/        rendered fixture at --fixed-fps 60: shots/step-<k>.png
//   receiver/, receiver-patch/           rendered receivers on the full and patch sinks:
//                                        shot-seqs.txt, shots/seq-<n>.png
//   sabotage-receiver-time-frozen/       RS_RECEIVER_SABOTAGE=shader-time-frozen
//
// Checks: the capture carries every shader `ok` (TIME a use, not a reason) with its GRP1 payload
// in the store, types nothing unsupported, and every transaction carries `shader_time` equal to
// its frame's F steps of 1/60 summed in double, bit for bit; the reference repeats exactly and
// equals the hand model (TP's sine pulse within 2, TV's whole-pixel shift exact, every default
// texture within 1, DS's set and cleared texture); every receiver shot equals the reference,
// exactly natively; the sabotage differs from the reference inside the three TIME items at every
// step, and nowhere else.
//
// Browser receivers (gate 7 runs this group with GATE7_LIVE_KIND=web|gsw; a browser leg's directory
// holds page-config.json) are judged within 1 per channel everywhere: the sine and the linear
// filtering are driver arithmetic (ANGLE against the native driver).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import { check } from "./gate3-checks";
import type { Gate5Check } from "./gate5-checks";
import type { Gate55LegEntry } from "./gate55c-checks";
import { resolveRecording } from "./render-stream-2";

export const G55T_STEPS = 5;
const WIDTH = 640;
const HEIGHT = 360;
const CLEAR: Rgb = [51, 51, 102];
/** Shaders the fixture makes (fixtures/gate55-time/shaders/): three read TIME. */
const SHADER_COUNT = 10;
const TIME_SHADERS = 3;
/** The fixture's step model (gate55_time.gd): S=1, N=10, settle +7. */
const SETTLE_FRAMES = [8, 18, 28, 38, 48];

type Rgb = [number, number, number];
type Rect = [number, number, number, number];

const inRect = (x: number, y: number, r: Rect): boolean =>
  x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

/** GLES3's TIME at frame F under --fixed-fps 60: F steps of 1/60, each wrapped at 3600. */
export function g55tTime(frame: number): number {
  let t = 0;
  for (let i = 0; i < frame; i++) t = (t + 1 / 60) % 3600;
  return t;
}

const f32 = Math.fround;
const unorm = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/** Item rects at a step (gate55_time.gd `_ready`). */
export function g55tLayout(step: number) {
  const shift = Math.floor(f32(f32(g55tTime(SETTLE_FRAMES[step])) * 30) + 0.25);
  const row = (i: number): Rect => [16 + 64 * i, 160, 48, 48];
  return {
    tp: [16, 16, 96, 96] as Rect,
    ts: [128, 16, 96, 96] as Rect,
    tv: [240, 16 + shift, 32, 32] as Rect,
    /** Every row TV can cover or uncover, over all steps. */
    tvBand: [240, 16, 32, 64] as Rect,
    defaults: [0, 1, 2, 3, 4, 5, 6].map(row),
    ds: row(7),
  };
}

/** The default textures' texels as the fixture's shaders fold them: (r, g/2 + a/2, b). */
const DEFAULT_RGB: Rgb[] = [
  [255, 255, 255], // D0: no hint, white
  [255, 255, 255], // DW: hint_default_white
  [0, 128, 0], // DB: hint_default_black (0,0,0,1)
  [0, 0, 0], // DT: hint_default_transparent (0,0,0,0)
  [127, 191, 255], // DN: hint_normal (127,127,255,255)
  [127, 191, 255], // DR: hint_roughness_normal, the normal texture
  [255, 191, 255], // DA: hint_anisotropy (255,127,255,255)
];

/**
 * The hand model at pixel (x, y) and step, or null where the model has no value (TS's filtered
 * scroll: judged against the reference only).
 */
export function g55tModel(
  step: number,
  x: number,
  y: number,
): { rgb: Rgb; tolerance: number } | null {
  const L = g55tLayout(step);
  if (inRect(x, y, L.ts)) return null;
  if (inRect(x, y, L.tp)) {
    const t = f32(g55tTime(SETTLE_FRAMES[step]));
    const p = 0.5 + 0.5 * Math.sin(t * 3);
    const tint = step >= 1 ? [0.5, 1.0, 0.75] : [1.0, 0.5, 0.25];
    return {
      rgb: [unorm(tint[0] * p), unorm(tint[1]), unorm(tint[2] * (1 - p))],
      tolerance: 2,
    };
  }
  if (inRect(x, y, L.tv)) return { rgb: [64, 204, 153], tolerance: 0 };
  if (inRect(x, y, L.tvBand)) return { rgb: CLEAR, tolerance: 0 };
  for (let i = 0; i < L.defaults.length; i++)
    if (inRect(x, y, L.defaults[i]))
      return { rgb: DEFAULT_RGB[i], tolerance: 1 };
  if (inRect(x, y, L.ds))
    return {
      rgb: step === 2 ? [200, 178, 50] : DEFAULT_RGB[2],
      tolerance: 1,
    };
  return { rgb: CLEAR, tolerance: 0 };
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
      const m = g55tModel(step, x, y);
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
    return seqs.length === G55T_STEPS && seqs.every(Number.isInteger)
      ? seqs
      : undefined;
  } catch {
    return undefined;
  }
}

export interface Gate55tResult {
  checks: Gate5Check[];
  legs: Record<string, Gate55LegEntry>;
  /** per leg and step: pixels differing from the reference (receivers) or the model (reference). */
  pixels: Record<string, number[]>;
}

const RECEIVER_LEGS = ["receiver", "receiver-patch"] as const;
const SABOTAGE_LEG = "sabotage-receiver-time-frozen";

export async function runGate55t(out: string): Promise<Gate55tResult> {
  const D = join(out, "time");
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
        "g55t-import",
        "fixtures/gate55-time and the receiver import cleanly (editor --import exit 0)",
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
      const rec = resolveRecording(bytes, 10);
      const txs = rec.transactions;
      if (txs.length === 0) problems.push("no transactions");
      let timeMisses = 0;
      for (const t of txs) {
        if (t.state.status !== "ok")
          problems.push(`seq ${t.seq}: status ${t.state.status}`);
        if (t.state.unsupported.length > 0)
          problems.push(
            `seq ${t.seq}: unsupported ${JSON.stringify(t.state.unsupported.slice(0, 3))}`,
          );
        // Every TIME shader exists from frame 1 (the fixture makes them in _ready).
        const want = g55tTime(t.frame);
        if (t.state.shader_time !== want) {
          timeMisses++;
          if (timeMisses <= 3)
            problems.push(
              `seq ${t.seq} frame ${t.frame}: shader_time ${t.state.shader_time}, want ${want}`,
            );
        }
      }
      const last = txs[txs.length - 1];
      const shaders = last?.state.shaders ?? [];
      if (shaders.length !== SHADER_COUNT)
        problems.push(
          `${shaders.length} shaders on the wire, want ${SHADER_COUNT}`,
        );
      let timed = 0;
      for (const s of shaders) {
        if (s.status !== "ok" || s.reason !== null)
          problems.push(
            `shader ${s.id}: ${s.status}/${s.reason} (want ok/null)`,
          );
        if (s.uses.includes("time")) timed++;
        if (s.source !== "payload" || s.hash === null)
          problems.push(`shader ${s.id}: source ${s.source}, hash ${s.hash}`);
        else if (!existsSync(join(cap, "store", "sha256", `${s.hash}.grp`)))
          problems.push(`shader ${s.id}: GRP1 ${s.hash} not in the store`);
      }
      if (timed !== TIME_SHADERS)
        problems.push(`${timed} shaders use time, want ${TIME_SHADERS}`);
      detail = `${txs.length} transactions ok, each with shader_time equal to its frame's F/60 sum; ${shaders.length} shaders ok (${timed} use time) with their GRP1 in the store`;
    } catch (e) {
      problems.push(`recording: ${(e as Error).message}`);
    }
    checks.push(
      check(
        "g55t-capture-time-carried",
        "the render-stream/10 capture carries every shader as ok (TIME a use, not shader-time; GRP1 payload in the store), types nothing unsupported, and every transaction's shader_time is GLES3's TIME at its frame (F steps of 1/60 at --fixed-fps 60), bit for bit",
        problems,
        detail,
        [rel(cap)],
      ),
    );
    legs["time/capture"] = {
      group: "g55t",
      expected_class: "success",
      result_class: problems.length === 0 ? "success" : "capture-failure",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(cap)],
    };
  }

  const refs: (Shot | undefined)[] = [];
  {
    const repeatProblems: string[] = [];
    const modelProblems: string[] = [];
    pixels["reference-model"] = [];
    for (let k = 0; k < G55T_STEPS; k++) {
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
        "g55t-reference-repeat",
        "the rendered reference repeats exactly (budget 0, every step)",
        repeatProblems,
        `${G55T_STEPS} steps identical`,
        [rel(join(D, "reference")), rel(join(D, "reference-repeat"))],
      ),
    );
    checks.push(
      check(
        "g55t-reference-hand-model",
        "the reference equals the hand model wherever it has a value: TP's sine pulse in TIME at its settle frame (within 2), TV's vertex() shift of floor(TIME*30+0.25) whole pixels (exact), each unset sampler's default texture -- white with no hint or hint_default_white, black, transparent, the normal for hint_normal and hint_roughness_normal, anisotropy (within 1) -- and DS's texture while set (step 2), its black default before and after; the clear colour elsewhere",
        modelProblems,
        `${G55T_STEPS} steps match the model`,
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
    if (!seqs) problems.push(`shot-seqs.txt missing or not ${G55T_STEPS} seqs`);
    for (let k = 0; k < G55T_STEPS && seqs; k++) {
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
        `g55t-${leg}-equals-reference`,
        `${leg}: every settle shot equals the reference (RGB; native budget 0, a browser leg within 1 per channel: the sine and the linear filtering are driver arithmetic)`,
        problems,
        `${G55T_STEPS} steps ${browser ? `within 1 (max delta ${max})` : "exact"}`,
        [rel(dir)],
      ),
    );
    legs[`time/${leg}`] = {
      group: "g55t",
      expected_class: "success",
      result_class: problems.length === 0 ? "success" : "pixel-mismatch",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  // --- sabotage: TIME frozen at 0 --------------------------------------------------------------
  {
    const dir = join(D, SABOTAGE_LEG);
    const problems: string[] = [];
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`exit ${code}`);
    const seqs = await shotSeqs(dir);
    const tolerance = isBrowserLeg(dir) ? 1 : 0;
    pixels[SABOTAGE_LEG] = [];
    if (!seqs) problems.push(`shot-seqs.txt missing or not ${G55T_STEPS} seqs`);
    let caught = 0;
    for (let k = 0; k < G55T_STEPS && seqs; k++) {
      const r = refs[k];
      const s = await decodePngRgba(join(dir, "shots", `seq-${seqs[k]}.png`));
      if (!r || !s) {
        problems.push(`step ${k}: missing shot`);
        continue;
      }
      const d = diffShots(r, s, tolerance);
      pixels[SABOTAGE_LEG].push(d.count);
      const L = g55tLayout(k);
      const at = (p: number): [number, number] => [
        p % WIDTH,
        Math.floor(p / WIDTH),
      ];
      const inTp = d.pixels.filter((p) => inRect(...at(p), L.tp)).length;
      const inTs = d.pixels.filter((p) => inRect(...at(p), L.ts)).length;
      const inTv = d.pixels.filter((p) => inRect(...at(p), L.tvBand)).length;
      const outside = d.count - inTp - inTs - inTv;
      // TIME 0 is a different pulse over all of TP, an unshifted scroll over a large part of TS
      // (everywhere but the flat stripe interiors), and TV at its unshifted rows.
      const quarter = (r: Rect) => (r[2] * r[3]) / 4;
      if (
        inTp === L.tp[2] * L.tp[3] &&
        inTs > quarter(L.ts) &&
        inTv > 0 &&
        outside === 0
      )
        caught++;
      else
        problems.push(
          `step ${k}: ${inTp} px differ in TP, ${inTs} in TS, ${inTv} in TV, ${outside} elsewhere`,
        );
    }
    checks.push(
      check(
        "g55t-sabotage-time-frozen-detected",
        "shader-time-frozen (the receiver ignores the carried shader time, so every TIME reads 0) differs from the reference over all of TP, more than a quarter of TS and TV's rows, at every step, and nowhere else (the default-texture items read no TIME)",
        problems,
        `${caught}/${G55T_STEPS} steps differ exactly as predicted`,
        [rel(dir)],
      ),
    );
    legs[`time/${SABOTAGE_LEG}`] = {
      group: "g55t",
      expected_class: "pixel-mismatch",
      result_class: caught === G55T_STEPS ? "pixel-mismatch" : "unexpected",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  return { checks, legs, pixels };
}
