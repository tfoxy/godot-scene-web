// Gate 5.5 group g55s (P3-ST, protocol/gate5_5-design.md "Screen texture (P3-ST)"): screen-reading
// ShaderMaterials (`hint_screen_texture`) over fixtures/gate55-screen, judged against the Godot
// reference and an independent hand model of GLES3's back-buffer copies
// (drivers/gles3/rasterizer_canvas_gles3.cpp:397-540): one automatic full copy per canvas, before
// its first screen reader, reused by every later reader of that canvas; a mipmap-filtered reader
// builds the mip chain of that same copy; a CanvasLayer is a new canvas with a new copy.
//
// Pure over an evidence directory written by run-gate55.sh's run_g55s (<out>/screen/):
//   import/{fixture,receiver}/          editor --import passes
//   capture/                            headless capture, render-stream/8 full and patch sinks,
//                                       store/, steps.jsonl
//   reference/, reference-repeat/       rendered fixture: shots/step-<k>.png
//   receiver/, receiver-patch/          rendered receivers on the full and patch sinks:
//                                       shot-seqs.txt, shots/seq-<n>.png
//   sabotage-receiver-copy-per-reader/  RS_RECEIVER_SABOTAGE=screen-copy-per-reader
//
// Checks: the capture carries every screen shader `ok` (P3-ST: no longer `shader-screen-texture`)
// with its GRP1 payload in the store and no unsupported entry; the reference repeats exactly and
// equals the hand model everywhere but the blur reader (RE, whose gaussian mip chain is the
// engine's; RF's SCREEN_UV within 1); every receiver shot equals the reference exactly; the
// sabotage differs from the reference exactly where the model says a per-reader copy shows (LC
// under RB, in LC's own colour swizzled) and nowhere else.
//
// Browser receivers (gate 7 runs this group with GATE7_LIVE_KIND=web|gsw; a browser leg's directory
// holds page-config.json): RE's linearly filtered gaussian mip chain is driver arithmetic, measured
// within 1 per channel on GSW (ANGLE) against the native reference, so RE alone is judged within 1
// there. Every other pixel stays exact.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { readExitCode } from "./gate0-checks";
import { check } from "./gate3-checks";
import type { Gate5Check } from "./gate5-checks";
import type { Gate55LegEntry } from "./gate55c-checks";
import { resolveRecording } from "./render-stream-2";

export const G55S_STEPS = 6;
const WIDTH = 640;
const HEIGHT = 360;
const CLEAR: Rgb = [51, 51, 102];
const LC_COLOUR: Rgb = [204, 102, 0];

type Rgb = [number, number, number];
type Rect = [number, number, number, number];

const inRect = (x: number, y: number, r: Rect): boolean =>
  x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

/** The fixture's 32x32 pattern texel (gate55_screen.gd `_pattern_texture`). */
function texel(x: number, y: number, transposed: boolean): Rgb {
  const u = transposed ? y : x;
  const v = transposed ? x : y;
  let checker = ((u >> 3) + (v >> 3)) % 2 === 0;
  if (transposed) checker = !checker;
  return [u * 8, v * 8, checker ? 204 : 51];
}

/** RT: the screen reader the capture refuses (TIME), which receivers drop. */
const RT_RECT: Rect = [16, 120, 24, 24];

/** fixture geometry at a step (gate55_screen.gd `_ready` / `_apply_step`). */
export function g55sLayout(step: number) {
  const ox1 = step >= 1 ? 8 : 0;
  const lc: Rect = step >= 2 ? [232, 56, 32, 32] : [208, 48, 32, 32];
  const [lx, ly] = step >= 3 ? [8, 4] : [0, 0];
  return {
    t1: [16 + ox1, 16, 128, 128] as Rect,
    t2: [176, 16, 128, 128] as Rect,
    t2Transposed: step < 5,
    t3: [416, 16, 128, 128] as Rect,
    ra: [48, 48, 64, 64] as Rect,
    lc,
    rb: [192, 32, 96, 96] as Rect,
    rf: [336, 160, 64, 64] as Rect,
    re: [432, 32, 96, 96] as Rect,
    rt: RT_RECT,
    rc: [64 + lx, 96 + ly, 96, 64] as Rect,
    rd: [176 + lx, 100 + ly, 64, 64] as Rect,
  };
}

const invert = (c: Rgb): Rgb => [255 - c[0], 255 - c[1], 255 - c[2]];
const swizzle = (c: Rgb): Rgb => [c[1], c[2], c[0]];

/**
 * The hand model at pixel (x, y): `null` inside RE (the engine's blur), `rf` marks the
 * SCREEN_UV reader (compared within 1). `receiver`: a receiver's picture, where the refused
 * reader RT is dropped (gate5_5-design.md "Refused materials") and the back buffer shows; else
 * the reference's, where RT inverts it. `perReader` models the screen-copy-per-reader sabotage
 * (a fresh copy before every reader).
 */
export function g55sModel(
  step: number,
  x: number,
  y: number,
  perReader = false,
  receiver = false,
): { rgb: Rgb; tolerance: number } | null {
  const L = g55sLayout(step);
  const base = (px: number, py: number): Rgb => {
    if (inRect(px, py, L.t1))
      return texel((px - L.t1[0]) >> 2, (py - L.t1[1]) >> 2, false);
    if (inRect(px, py, L.t2))
      return texel((px - L.t2[0]) >> 2, (py - L.t2[1]) >> 2, L.t2Transposed);
    if (inRect(px, py, L.t3))
      return texel((px - L.t3[0]) >> 2, (py - L.t3[1]) >> 2, false);
    return CLEAR;
  };
  // Canvas 0's copy is taken before RA: base only. Under the sabotage RB's copy also holds RA's
  // output and LC (RA and RB do not overlap, so only LC shows).
  const copyForRb = (px: number, py: number): Rgb =>
    perReader && inRect(px, py, L.lc) ? LC_COLOUR : base(px, py);
  const final0 = (px: number, py: number): Rgb | "re" | "rf" => {
    if (inRect(px, py, L.re)) return "re";
    if (inRect(px, py, L.rf)) return "rf";
    if (inRect(px, py, L.rt))
      return receiver ? base(px, py) : invert(base(px, py));
    if (inRect(px, py, L.rb)) return swizzle(copyForRb(px, py));
    if (inRect(px, py, L.ra)) return invert(base(px, py));
    return base(px, py);
  };
  // Canvas 1 (the layer): one fresh copy of canvas 0's final picture before RC; RD reuses it
  // (under the sabotage RD's own copy holds RC's output too, which never overlaps RD).
  let c: Rgb | "re" | "rf";
  if (inRect(x, y, L.rd)) {
    const under = final0(x, y);
    if (under === "re" || under === "rf") return null;
    c = swizzle(under);
  } else if (inRect(x, y, L.rc)) {
    const under = final0(x, y);
    if (under === "re" || under === "rf") return null;
    c = invert(under);
  } else {
    c = final0(x, y);
  }
  if (c === "re") return null;
  if (c === "rf")
    return {
      rgb: [
        Math.round(((x + 0.5) / WIDTH) * 255),
        Math.round(((y + 0.5) / HEIGHT) * 255),
        CLEAR[2],
      ],
      tolerance: 1,
    };
  return { rgb: c, tolerance: 0 };
}

interface Shot {
  data: Uint8Array;
  width: number;
  height: number;
}

async function shot(path: string): Promise<Shot | undefined> {
  return decodePngRgba(path);
}

/** The blur reader's rect, the only region judged within 1 on a browser leg. */
const RE_RECT: Rect = [432, 32, 96, 96];

/**
 * Pixels where `a` and `b` differ in RGB beyond `tolerance` inside `loose` (exactly elsewhere),
 * their bounding box, and the largest delta inside `loose`.
 */
function diffShots(
  a: Shot,
  b: Shot,
  loose: Rect | null = null,
  tolerance = 0,
  skip: Rect | null = null,
): { count: number; bbox: Rect | null; pixels: number[]; looseMax: number } {
  let looseMax = 0;
  let count = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  const pixels: number[] = [];
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (skip !== null && inRect(x, y, skip)) continue;
      const i = (y * a.width + x) * 4;
      const delta = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      const isLoose = loose !== null && inRect(x, y, loose);
      if (isLoose) looseMax = Math.max(looseMax, delta);
      if (delta > (isLoose ? tolerance : 0)) {
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
    looseMax,
  };
}

/** A browser receiver leg (gate 7's harness writes page-config.json into its directory). */
const isBrowserLeg = (dir: string): boolean =>
  existsSync(join(dir, "page-config.json"));

/** Pixels of `s` that miss the model (outside RE), with the first few named. */
function modelMisses(
  s: Shot,
  step: number,
  perReader: boolean,
  receiver = false,
  only: Rect | null = null,
): { count: number; first: string[] } {
  let count = 0;
  const first: string[] = [];
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      if (only !== null && !inRect(x, y, only)) continue;
      const m = g55sModel(step, x, y, perReader, receiver);
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
    return seqs.length === G55S_STEPS && seqs.every(Number.isInteger)
      ? seqs
      : undefined;
  } catch {
    return undefined;
  }
}

export interface Gate55sResult {
  checks: Gate5Check[];
  legs: Record<string, Gate55LegEntry>;
  /** per leg and step: pixels differing from the reference (receivers) or the model (reference). */
  pixels: Record<string, number[]>;
}

const RECEIVER_LEGS = ["receiver", "receiver-patch"] as const;
const SABOTAGE_LEG = "sabotage-receiver-copy-per-reader";

export async function runGate55s(out: string): Promise<Gate55sResult> {
  const D = join(out, "screen");
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
        "g55s-import",
        "fixtures/gate55-screen and the receiver import cleanly (editor --import exit 0)",
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
      const last = txs[txs.length - 1];
      const shaders = last?.state.shaders ?? [];
      const allScreen = shaders.filter((s) =>
        s.uses.includes("screen_texture"),
      );
      // RT's shader reads TIME too: refused shader-time, never shader-screen-texture.
      const refused = allScreen.filter((s) => s.status !== "ok");
      const screen = allScreen.filter((s) => s.status === "ok");
      if (
        refused.length !== 1 ||
        refused[0].reason !== "shader-time" ||
        !refused[0].uses.includes("time")
      )
        problems.push(
          `refused screen shaders ${JSON.stringify(refused.map((s) => [s.id, s.reason]))}, want one shader-time`,
        );
      const materials0 = last?.state.materials ?? [];
      const rtItems = (last?.state.items ?? [])
        .filter((it) => {
          const m = materials0.find((mm) => mm.id === it.material);
          return m !== undefined && refused.some((r) => r.id === m.shader);
        })
        .map((it) => it.id);
      if (rtItems.length !== 1)
        problems.push(`items naming the refused shader: ${rtItems}`);
      for (const t of txs) {
        if (t.state.status !== "ok")
          problems.push(`seq ${t.seq}: status ${t.state.status}`);
        const u = t.state.unsupported;
        if (
          u.length !== 1 ||
          u[0].op !== "canvas_item_set_material" ||
          u[0].reason !== "unsupported-material" ||
          u[0].item !== rtItems[0]
        )
          problems.push(
            `seq ${t.seq}: unsupported ${JSON.stringify(u.slice(0, 3))}, want RT's unsupported-material only`,
          );
      }
      if (screen.length !== 4)
        problems.push(
          `${screen.length} ok screen-reading shaders on the wire, want 4`,
        );
      for (const s of screen) {
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
      const screenIds = new Set(screen.map((s) => s.id));
      const readers = (last?.state.items ?? []).filter((it) => {
        const m = materials.find((mm) => mm.id === it.material);
        return m !== undefined && m.shader !== null && screenIds.has(m.shader);
      });
      if (readers.length !== 6)
        problems.push(
          `${readers.length} items name a screen-reading material, want 6`,
        );
      detail = `${txs.length} transactions ok, each typing only RT (item ${rtItems[0]}) unsupported-material; ${screen.length} screen shaders ok with their GRP1 in the store and RT's refused shader-time; ${readers.length} reader items`;
    } catch (e) {
      problems.push(`recording: ${(e as Error).message}`);
    }
    checks.push(
      check(
        "g55s-capture-screen-shaders-ok",
        "the capture carries every hint_screen_texture shader as ok (uses screen_texture, GRP1 payload in the store) and types only RT, whose shader also reads TIME (shader-time; derived unsupported-material), unsupported (gate5_5-design.md D11 as amended by P3-ST)",
        problems,
        detail,
        [rel(cap)],
      ),
    );
    legs["screen/capture"] = {
      group: "g55s",
      expected_class: "unsupported",
      result_class: problems.length === 0 ? "unsupported" : "capture-failure",
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
    for (let k = 0; k < G55S_STEPS; k++) {
      const a = await shot(join(D, "reference", "shots", `step-${k}.png`));
      const b = await shot(
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
      const d = diffShots(a, b);
      if (d.count > 0)
        repeatProblems.push(
          `step ${k}: ${d.count} px differ in ${JSON.stringify(d.bbox)}`,
        );
      const m = modelMisses(a, k, false);
      pixels["reference-model"].push(m.count);
      if (m.count > 0)
        modelProblems.push(
          `step ${k}: ${m.count} px miss the model: ${m.first.join("; ")}`,
        );
    }
    checks.push(
      check(
        "g55s-reference-repeat",
        "the rendered reference repeats exactly (budget 0, every step)",
        repeatProblems,
        `${G55S_STEPS} steps identical`,
        [rel(join(D, "reference")), rel(join(D, "reference-repeat"))],
      ),
    );
    checks.push(
      check(
        "g55s-reference-hand-model",
        "the reference equals the hand model of GLES3's back-buffer copies everywhere but the blur reader RE (one copy per canvas before its first reader, reused by RB so LC never shows; the layer's fresh copy holds RA's and RB's outputs; RD clipped; RT inverts the cached copy; RF's SCREEN_UV top-left origin within 1)",
        modelProblems,
        `${G55S_STEPS} steps match the model`,
        [rel(join(D, "reference"))],
      ),
    );
  }

  // --- receivers: exact against the reference ------------------------------------------------
  for (const leg of RECEIVER_LEGS) {
    const dir = join(D, leg);
    const problems: string[] = [];
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`exit ${code}`);
    const seqs = await shotSeqs(dir);
    const browser = isBrowserLeg(dir);
    const tolerance = browser ? 1 : 0;
    let reMax = 0;
    pixels[leg] = [];
    if (!seqs) problems.push("shot-seqs.txt missing or not six seqs");
    for (let k = 0; k < G55S_STEPS && seqs; k++) {
      const r = refs[k];
      const s = await shot(join(dir, "shots", `seq-${seqs[k]}.png`));
      if (!r || !s) {
        problems.push(`step ${k}: missing shot`);
        pixels[leg].push(-1);
        continue;
      }
      const d = diffShots(r, s, RE_RECT, tolerance, RT_RECT);
      reMax = Math.max(reMax, d.looseMax);
      pixels[leg].push(d.count);
      if (d.count > 0)
        problems.push(
          `step ${k} (seq ${seqs[k]}): ${d.count} px differ in ${JSON.stringify(d.bbox)}`,
        );
      // RT: dropped, so the back buffer shows (the reference inverts it).
      const rt = modelMisses(s, k, false, true, RT_RECT);
      if (rt.count > 0)
        problems.push(
          `step ${k}: RT drawn (${rt.count} px are not the back buffer: ${rt.first.join("; ")})`,
        );
    }
    checks.push(
      check(
        `g55s-${leg}-equals-reference`,
        `${leg}: every settle shot equals the reference exactly (RGB, budget 0), the blur reader's mip chain included (a browser leg: RE within 1), except RT, whose refused screen reader the receiver drops so the back buffer shows (gate5_5-design.md "Refused materials")`,
        problems,
        `${G55S_STEPS} steps exact${browser ? ` outside RE; RE within ${reMax}` : ""}`,
        [rel(dir)],
      ),
    );
    legs[`screen/${leg}`] = {
      group: "g55s",
      expected_class: "success",
      result_class: problems.length === 0 ? "success" : "pixel-mismatch",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  // --- sabotage: the copy taken at the wrong time --------------------------------------------
  {
    const dir = join(D, SABOTAGE_LEG);
    const problems: string[] = [];
    const code = await readExitCode(dir);
    if (code !== 0) problems.push(`exit ${code}`);
    const seqs = await shotSeqs(dir);
    pixels[SABOTAGE_LEG] = [];
    if (!seqs) problems.push("shot-seqs.txt missing or not six seqs");
    let caught = 0;
    for (let k = 0; k < G55S_STEPS && seqs; k++) {
      const r = refs[k];
      const s = await shot(join(dir, "shots", `seq-${seqs[k]}.png`));
      if (!r || !s) {
        problems.push(`step ${k}: missing shot`);
        continue;
      }
      const d = diffShots(r, s, RE_RECT, isBrowserLeg(dir) ? 1 : 0, RT_RECT);
      pixels[SABOTAGE_LEG].push(d.count);
      const lc = g55sLayout(k).lc;
      const outside = d.pixels.filter(
        (p) => !inRect(p % WIDTH, Math.floor(p / WIDTH), lc),
      ).length;
      const model = modelMisses(s, k, true, true);
      // (RE is outside the model; a browser leg's RE is judged within 1 by diffShots above.)
      if (d.count === lc[2] * lc[3] && outside === 0 && model.count === 0)
        caught++;
      else
        problems.push(
          `step ${k}: ${d.count} px differ (${outside} outside LC ${JSON.stringify(lc)}), ${model.count} miss the per-reader model`,
        );
    }
    checks.push(
      check(
        "g55s-sabotage-copy-per-reader-detected",
        "screen-copy-per-reader (a back-buffer copy before every reader) differs from the reference exactly on LC's rect under RB, showing LC swizzled, at every step, and matches the per-reader model everywhere else",
        problems,
        `${caught}/${G55S_STEPS} steps differ exactly as predicted`,
        [rel(dir)],
      ),
    );
    legs[`screen/${SABOTAGE_LEG}`] = {
      group: "g55s",
      expected_class: "pixel-mismatch",
      result_class: caught === G55S_STEPS ? "pixel-mismatch" : "unexpected",
      reasons: problems.slice(0, 5),
      exit_code: code,
      artifacts: [rel(dir)],
    };
  }

  return { checks, legs, pixels };
}
