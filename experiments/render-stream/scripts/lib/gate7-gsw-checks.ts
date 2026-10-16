// G7a's own checks for the GSW canvas receiver (gate7-design.md G7a "Checks" and "Sabotages",
// Q7, Q14d), beside each gate's checks that lib/gate7-gsw.ts runs through the gate's own checker:
//
//   all     gsw-vs-native (report only: Q7's triangulation, G against N per shot) and
//           record-digest-complete (D31: every applied transaction carries its record digest)
//   g7-0    compositor-equals-readback and its css-opacity sabotage (Q7); goldens-through-core
//           (golden-2..7 natively and as wasm in Node) and rs-core-differential
//           (self-test-rs-core.ts over every gate 0-3 source recording), from run-gate7.sh's logs
//   g7-1    ordering-model (the applier's walk against gate 1's hand model, `cargo test`, from
//           run-gate7.sh's log) and sabotage-ignore-z (fails exactly the steps where z decides a
//           pixel, predicted from gate 1's own resolved states by an independent painter)
//   g7-2    transform-only-no-upload (gate 2's transform-only steps upload no texture and no
//           vertex byte, only item rows) and sabotage-premultiplied-upload (fails exactly the
//           (step, region)s where a texture with non-uniform alpha is filtered linearly, predicted
//           from gate 2's expected.json, with channel delta > 1; pixelmatch alone at its default
//           budget is shown not to catch it)
//   g7-3    clip-parity (the Rust applier's scissor equals clip-derive.ts's for every gate 3 item
//           and transaction)
// Every prediction comes from the gates' own expected.json or resolved states, never from a GSW
// run (Q7 "Masks come from the gates' own expected.json and models").

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareRgbaBuffers } from "../../../../packages/test-harness/src/image-diff";
import { deriveClipRects } from "./clip-derive";
import { decodePngRgba } from "./gate-minus1-checks";
import { loadRecording } from "./gate0-checks";
import type { Gate2Expected } from "./gate2-expected";
import { stepWindow, TRANSFORM_ONLY_STEPS } from "./gate2b-checks";
import type { Gate3xExpected } from "./gate3x-expected";
import type { Gate7Check } from "./gate7-adapters";
import {
  compositorProblems,
  GSW_LEGS,
  type GswGate,
  mk,
  q7Plan,
} from "./gate7-gsw";
import { GATE55_Q7_LEGS, gate55Checks } from "./gate7-gsw-55-checks";
import { earlySteps } from "./gate7-gsw-g45";
import { g45ExtraChecks } from "./gate7-gsw-g45-checks";
import { classMask, judgeQ7Classes, readTolerance } from "./gsw-tolerance";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(HERE, "..", "..");
export const RS_CORE_CHECK = join(
  EXPERIMENT_DIR,
  "rs-core",
  "target",
  "release",
  "rs-core-check",
);

interface Ctx {
  out: string;
  sourceDir: string;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

type Rgba = { width: number; height: number; data: Uint8Array };

/** Per (rect) max channel delta and differing pixel count. */
function regionDelta(a: Rgba, b: Rgba, rect?: readonly number[]) {
  const [x0, y0, w, h] = rect ?? [0, 0, a.width, a.height];
  let px = 0;
  let max = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(a.width, x0 + w); x++) {
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
      if (d > 0) px++;
      max = Math.max(max, d);
    }
  return { px, max };
}

function gswDir(out: string, gate: GswGate, leg: string): string {
  return join(out, gate, "gsw", leg);
}

function shotSeqs(dir: string): number[] {
  const text = readText(join(dir, "shot-seqs.txt"));
  return (text ?? "").trim().split(",").filter(Boolean).map(Number);
}

// --------------------------------------------------------------------------------- all groups

async function gswVsNative(gate: GswGate, ctx: Ctx): Promise<Gate7Check> {
  let shots = 0;
  let identical = 0;
  const differing: string[] = [];
  for (const d of GSW_LEGS[gate].filter((x) => x.replaces)) {
    const native = join(ctx.sourceDir, d.leg, "shots");
    const gsw = join(gswDir(ctx.out, gate, d.leg), "shots");
    if (!existsSync(native)) continue;
    for (const f of readdirSync(native)
      .filter((x) => x.endsWith(".png"))
      .sort()) {
      shots++;
      const a = await decodePngRgba(join(native, f));
      const b = existsSync(join(gsw, f))
        ? await decodePngRgba(join(gsw, f))
        : null;
      if (!a || !b || a.width !== b.width || a.height !== b.height) {
        differing.push(`${d.leg}/${f}: missing or size differs`);
        continue;
      }
      const r = regionDelta(a, b);
      if (r.px === 0) identical++;
      else differing.push(`${d.leg}/${f}: ${r.px} px (max delta ${r.max})`);
    }
  }
  return mk(
    "gsw-vs-native@gsw",
    "Q7 (report only, triangulation): every gsw shot against the native receiver's same shot",
    differing,
    `${identical}/${shots} shots identical`,
    false,
  );
}

async function digestsComplete(gate: GswGate, ctx: Ctx): Promise<Gate7Check> {
  const problems: string[] = [];
  let n = 0;
  for (const d of GSW_LEGS[gate]) {
    const applied = await readJson<{
      status?: string;
      transactions?: { seq: number; record_sha256: string | null }[] | null;
    }>(join(gswDir(ctx.out, gate, d.leg), "applied.json"));
    if (!applied) {
      problems.push(`${d.leg}: applied.json missing`);
      continue;
    }
    for (const t of applied.transactions ?? []) {
      n++;
      if (typeof t.record_sha256 !== "string" || t.record_sha256.length !== 64)
        problems.push(`${d.leg} seq ${t.seq}: no record_sha256`);
    }
  }
  return mk(
    "record-digest-complete@gsw",
    "D31: every transaction a gsw leg applied carries its record digest in applied.json (computed after its frame, before the evidence was written)",
    problems,
    `${n} transactions, every one digested`,
  );
}

/** compositor-equals-readback on a leg whose last shot may not be of its final state: gating
 * when the two are the same frame, else reported with the reason (Q7 asks it of opaque frames at
 * the leg's last shot). */
async function compositorCheck(
  id: string,
  legDir: string,
): Promise<Gate7Check> {
  const problems = await compositorProblems(legDir);
  const comparable = !problems.some((p) => /is not of the state/.test(p));
  return mk(
    id,
    "Q7: the CDP screenshot of the canvas equals the receiver's own readback of the same opaque frame, channel 0",
    problems,
    "screenshot equals the last shot exactly",
    comparable,
  );
}

// ------------------------------------------------------------------------------------------ g7-0

function logCheck(
  id: string,
  criterion: string,
  path: string,
  okPattern: RegExp,
): Gate7Check {
  const text = readText(path);
  const exit = readText(`${path}.exit`)?.trim();
  const problems: string[] = [];
  if (text === undefined)
    problems.push(`${path} missing (run-gate7.sh writes it)`);
  else {
    if (exit !== "0") problems.push(`exit ${exit ?? "unknown"}`);
    if (!okPattern.test(text)) problems.push(`no ${okPattern} line in ${path}`);
  }
  const last =
    text?.split("\n").find((l) => okPattern.test(l)) ??
    text?.trim().split("\n").slice(-1)[0] ??
    "";
  return mk(id, criterion, problems, last);
}

async function gate0Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const honest = gswDir(ctx.out, "gate0", "receiver");
  const sab = gswDir(ctx.out, "gate0", "sabotage-css-opacity");
  const comp = await compositorProblems(honest);
  const sabComp = await compositorProblems(sab);
  const sabProblems: string[] = [];
  if (sabComp.length === 0)
    sabProblems.push(
      "compositor-equals-readback passed on the css-opacity sabotage",
    );
  else if (!/px differ/.test(sabComp[0]))
    sabProblems.push(`it failed for another reason: ${sabComp[0]}`);
  for (const f of existsSync(join(honest, "shots"))
    ? readdirSync(join(honest, "shots"))
    : []) {
    const a = await decodePngRgba(join(honest, "shots", f));
    const b = await decodePngRgba(join(sab, "shots", f));
    if (!a || !b || regionDelta(a, b).px > 0)
      sabProblems.push(`shots/${f} differs from the honest gsw leg`);
  }
  const rs = join(ctx.out, "rs-core");
  return [
    mk(
      "compositor-equals-readback@gsw",
      "Q7: the CDP screenshot of the canvas equals the receiver's own RGB10_A2 readback of the same opaque frame, channel 0",
      comp,
      "screenshot equals the last shot exactly",
    ),
    mk(
      "sabotage-css-opacity@gsw",
      "Q7: `opacity: 0.99` on the canvas fails exactly compositor-equals-readback (its readback shots still equal the honest gsw leg's)",
      sabProblems,
      `fails exactly compositor-equals-readback (${sabComp[0] ?? ""})`,
    ),
    logCheck(
      "goldens-native@gsw",
      "G7a/Q14d: golden-2 to golden-7 through render-stream-core natively (rs-core-check goldens)",
      join(rs, "goldens-native.log"),
      /rs-core-check goldens: all checks passed/,
    ),
    logCheck(
      "goldens-wasm@gsw",
      "G7a/Q14d: golden-2 to golden-7 through rs-gsw-wasm in Node (self-test-rs-core-wasm.mjs, the module the page loads)",
      join(rs, "goldens-wasm.log"),
      /self-test-rs-core-wasm: (\d+)\/\1 checks pass/,
    ),
    logCheck(
      "rs-core-differential@gsw",
      "G7a/Q14d: self-test-rs-core.ts: the Rust resolved state equals render-stream-2.ts's after every transaction of every gate 0 to 3 source recording, and every record digest",
      join(rs, "self-test-rs-core.log"),
      /self-test-rs-core: all checks passed/,
    ),
  ];
}

// ------------------------------------------------------------------------------------------ g7-1

interface DumpItem {
  id: number;
  parent: { kind: string; id: number } | null;
  children: number[];
  visible: boolean;
  draw_index: number;
  z_index: number;
  z_relative: boolean;
  behind: boolean;
  visibility_layer: number;
  xform: number[];
  modulate: number[];
  self_modulate: number[];
  commands: { op: string; rect?: number[]; color?: number[] }[];
}
interface DumpState {
  canvases: {
    id: number;
    attached: boolean;
    layer?: number;
    sublayer?: number;
    items: number[];
    xform: number[];
  }[];
  items: DumpItem[];
}

const mulAff = (a: number[], b: number[]): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** An independent painter for gate 1's opaque, axis-aligned rect scenes (D7's walk, restated in
 * TypeScript from renderer_canvas_cull.cpp): canvases by (layer, sublayer), children by
 * draw_index, behind-parent children first, per-z lists in z order unless `ignoreZ`. */
export function paintGate1(
  st: DumpState,
  size: [number, number],
  clear: number[],
  ignoreZ: boolean,
): Uint8Array {
  const items = new Map(st.items.map((i) => [i.id, i] as const));
  const draws: { z: number; it: DumpItem; xf: number[]; mod: number[] }[] = [];
  const sorted = (ids: number[]) =>
    ids
      .map((id) => items.get(id))
      .filter((x): x is DumpItem => x !== undefined)
      .sort((a, b) => a.draw_index - b.draw_index);
  const cull = (
    it: DumpItem,
    xf: number[],
    pm: number[],
    z: number,
    depth: number,
  ) => {
    if (depth > 4096 || !it.visible || it.visibility_layer === 0) return;
    const mod = it.modulate.map((v, k) => v * pm[k]);
    if (mod[3] < 0.007) return;
    const fx = mulAff(xf, it.xform);
    const fz = it.z_relative ? z + it.z_index : it.z_index;
    const kids = sorted(it.children);
    for (const c of kids) if (c.behind) cull(c, fx, mod, fz, depth + 1);
    draws.push({
      z: fz,
      it,
      xf: fx,
      mod: mod.map((v, k) => v * it.self_modulate[k]),
    });
    for (const c of kids) if (!c.behind) cull(c, fx, mod, fz, depth + 1);
  };
  const canvases = st.canvases
    .filter((c) => c.attached)
    .sort(
      (a, b) =>
        (a.layer ?? 0) - (b.layer ?? 0) ||
        (a.sublayer ?? 0) - (b.sublayer ?? 0) ||
        a.id - b.id,
    );
  const order: typeof draws = [];
  for (const c of canvases) {
    draws.length = 0;
    for (const it of sorted(c.items)) cull(it, c.xform, [1, 1, 1, 1], 0, 0);
    const list = draws.map((d, i) => ({ d, i }));
    if (!ignoreZ) list.sort((a, b) => a.d.z - b.d.z || a.i - b.i);
    order.push(...list.map((x) => x.d));
  }
  const [w, h] = size;
  const px = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h; i++)
    for (let k = 0; k < 4; k++) px[i * 4 + k] = clear[k] / 255;
  for (const d of order)
    for (const c of d.it.commands) {
      if (c.op !== "add_rect" || !c.rect || !c.color) continue;
      const [x, y, rw, rh] = c.rect;
      // Gate 1's transforms are axis-aligned up to quarter turns: the corners' bounding box is
      // the drawn rect exactly.
      const corners = [
        [x, y],
        [x + rw, y],
        [x, y + rh],
        [x + rw, y + rh],
      ].map(([px, py]) => [
        d.xf[0] * px + d.xf[2] * py + d.xf[4],
        d.xf[1] * px + d.xf[3] * py + d.xf[5],
      ]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const col = c.color.map((v, k) => v * d.mod[k]);
      for (let py = 0; py < h; py++) {
        if (py + 0.5 < Math.min(...ys) || py + 0.5 >= Math.max(...ys)) continue;
        for (let qx = 0; qx < w; qx++) {
          if (qx + 0.5 < Math.min(...xs) || qx + 0.5 >= Math.max(...xs))
            continue;
          const i = (py * w + qx) * 4;
          const a = col[3];
          for (let k = 0; k < 3; k++)
            px[i + k] = col[k] * a + px[i + k] * (1 - a);
          px[i + 3] = a + px[i + 3] * (1 - a);
        }
      }
    }
  return Uint8Array.from(px, (v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255),
  );
}

async function gate1Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  out.push(
    logCheck(
      "ordering-model@gsw",
      "G7a: `cargo test ordering_model`: the applier's walk, from gate 1's resolved states with no GPU, paints every step's draws in expected.json's order (z, behind-parent, top_level, visibility)",
      join(ctx.out, "gate1", "ordering-model.log"),
      /ordering-model: ran \d+ steps .*: 0 mismatching/,
    ),
  );
  // sabotage-ignore-z: predicted from gate 1's resolved states (the native receiver's own state
  // dumps at the settle seqs) by paintGate1 with and without z.
  const expected = await readJson<{
    viewport: number[];
    clear_rgba8: number[];
  }>(join(EXPERIMENT_DIR, "fixtures", "gate1", "expected.json"));
  const seqs = shotSeqs(join(ctx.sourceDir, "receiver"));
  const predicted: number[] = [];
  const problems: string[] = [];
  for (const [k, seq] of seqs.entries()) {
    const st = await readJson<DumpState>(
      join(ctx.sourceDir, "receiver", "state", `seq-${seq}.json`),
    );
    if (!st || !expected) {
      problems.push(`step ${k}: no native state dump seq-${seq}`);
      continue;
    }
    const size: [number, number] = [expected.viewport[0], expected.viewport[1]];
    const a = paintGate1(st, size, expected.clear_rgba8, false);
    const b = paintGate1(st, size, expected.clear_rgba8, true);
    if (a.some((v, i) => v !== b[i])) predicted.push(k);
  }
  const failed: number[] = [];
  for (const [k, seq] of seqs.entries()) {
    const honest = await decodePngRgba(
      join(gswDir(ctx.out, "gate1", "receiver"), "shots", `seq-${seq}.png`),
    );
    const sab = await decodePngRgba(
      join(
        gswDir(ctx.out, "gate1", "sabotage-gsw-ignore-z"),
        "shots",
        `seq-${seq}.png`,
      ),
    );
    if (!honest || !sab) {
      problems.push(`step ${k}: shot seq-${seq} missing`);
      continue;
    }
    if (regionDelta(honest, sab).px > 0) failed.push(k);
  }
  if (predicted.length === 0)
    problems.push("the prediction is empty (no step where z decides a pixel)");
  if (JSON.stringify(failed) !== JSON.stringify(predicted))
    problems.push(
      `differs from the honest gsw leg at steps {${failed}}, predicted {${predicted}}`,
    );
  out.push(
    mk(
      "sabotage-ignore-z@gsw",
      "G7a: ignore-z (each canvas in draw_index walk order, no per-z lists) fails exactly gate 1's z steps: the steps where painting gate 1's own resolved state with and without z differs",
      problems,
      `fails exactly steps {${predicted}} (predicted from the resolved states)`,
    ),
  );
  out.push(
    await compositorCheck(
      "compositor-equals-readback-g1@gsw",
      gswDir(ctx.out, "gate1", "receiver"),
    ),
  );
  return out;
}

// ------------------------------------------------------------------------------------------ g7-2

/** Gate 2's (step, region)s where a draw samples a texture with non-uniform alpha under a linear
 * filter, from expected.json alone (its texture contents, draws, regions and filter invariants). */
export function premultipliedPrediction(expected: Gate2Expected): Set<string> {
  type Tex = {
    checker?: { even: number[]; odd: number[] };
    fill?: number[];
    rects?: number[][];
  };
  const textures = (expected as unknown as { textures: Record<string, Tex> })
    .textures;
  const nonUniformAlpha = (name: string): boolean => {
    const t = textures[name];
    if (!t) return false;
    if (t.checker) return t.checker.even[3] !== t.checker.odd[3];
    const alphas = new Set<number>([
      t.fill?.[3] ?? 255,
      ...(t.rects ?? []).map((r) => r[7]),
    ]);
    return alphas.size > 1;
  };
  const out = new Set<string>();
  let defaultFilter = "nearest";
  const itemFilter = new Map<string, string>();
  const steps = (
    expected as unknown as {
      steps: {
        step: number;
        regions: Record<string, number[]>;
        draws: {
          name: string;
          rect_px: number[];
          sample?: { texture: string };
        }[];
        invariants: { kind: string; item?: string; value?: string }[];
      }[];
    }
  ).steps;
  for (const s of steps) {
    for (const inv of s.invariants) {
      if (inv.kind === "default_filter" && inv.value) defaultFilter = inv.value;
      if (inv.kind === "filter" && inv.item && inv.value)
        itemFilter.set(inv.item, inv.value);
    }
    for (const d of s.draws) {
      if (!d.sample || !nonUniformAlpha(d.sample.texture)) continue;
      const f = itemFilter.get(d.name) ?? defaultFilter;
      if (!f.startsWith("linear")) continue;
      const [x, y, w, h] = d.rect_px;
      for (const [region, r] of Object.entries(s.regions))
        if (x < r[0] + r[2] && r[0] < x + w && y < r[1] + r[3] && r[1] < y + h)
          out.add(`${s.step}:${region}`);
    }
  }
  return out;
}

async function gate2Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  const expected = (await readJson<Gate2Expected>(
    join(EXPERIMENT_DIR, "fixtures", "gate2", "expected.json"),
  )) as Gate2Expected;
  // transform-only-no-upload: the perf timeline of every rendered receiver leg, against the
  // resolved states of the leg's own recording (which items' commands changed in each
  // transaction). On gate 2's transform-only steps only the marker's content changes (its colour
  // per step, expected.json): every other item may move its row only.
  {
    const problems: string[] = [];
    let rows = 0;
    let seen = 0;
    for (const leg of [
      "receiver-cold",
      "receiver-warm",
      "receiver-patch",
      "receiver-inline",
    ]) {
      const text = readText(
        join(gswDir(ctx.out, "gate2", leg), "perf-timeline.jsonl"),
      );
      if (!text) {
        problems.push(`${leg}: perf-timeline.jsonl missing`);
        continue;
      }
      const rec = await loadRecording(
        join(ctx.sourceDir, leg, "recording.rs2"),
      );
      const changed = new Map<number, number>();
      let prev = new Map<number, number>();
      for (const t of rec.transactions) {
        const now = new Map(
          t.meta.items.map((i) => [i.id, i.content_version] as const),
        );
        let n = 0;
        for (const [id, cv] of now) if (prev.get(id) !== cv) n++;
        changed.set(t.meta.seq, n);
        prev = now;
      }
      const samples = text
        .split("\n")
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              seq: number;
              frame: number;
              texture_upload_bytes: number;
              vertex_bytes: number;
              item_bytes: number;
              relowered: number;
            },
        );
      for (const step of TRANSFORM_ONLY_STEPS) {
        const [from, to] = stepWindow(
          expected,
          step,
          expected.quit_frame_default,
        );
        for (const s of samples.filter(
          (x) => x.frame >= from && x.frame <= to,
        )) {
          seen++;
          const c = changed.get(s.seq) ?? -1;
          if (s.texture_upload_bytes !== 0)
            problems.push(
              `${leg} step ${step} seq ${s.seq}: ${s.texture_upload_bytes} texture bytes`,
            );
          if (s.relowered !== c)
            problems.push(
              `${leg} step ${step} seq ${s.seq}: ${s.relowered} items re-lowered, ${c} changed content`,
            );
          if (c === 0 && s.vertex_bytes !== 0)
            problems.push(
              `${leg} step ${step} seq ${s.seq}: ${s.vertex_bytes} vertex bytes with no content change`,
            );
          if (s.item_bytes > 0) rows++;
        }
      }
    }
    if (seen === 0)
      problems.push("no transaction in the transform-only windows");
    if (rows === 0)
      problems.push("no item row was uploaded in any transform-only window");
    out.push(
      mk(
        "transform-only-no-upload@gsw",
        `G7a: on gate 2's transform-only steps (${TRANSFORM_ONLY_STEPS.join(", ")}), every applied transaction uploads zero texture bytes, re-lowers exactly the items whose commands changed (the step marker) and, where none did, zero vertex bytes: moved items upload item rows only`,
        problems,
        `${seen} transactions in the windows, ${rows} uploading item rows`,
      ),
    );
  }
  // sabotage-premultiplied-upload.
  {
    const predicted = premultipliedPrediction(expected);
    const seqs = shotSeqs(join(ctx.sourceDir, "receiver-cold"));
    const failed = new Set<string>();
    const problems: string[] = [];
    let pixelmatchCaught = 0;
    let delta1Only = 0;
    for (const [k, seq] of seqs.entries()) {
      const a = await decodePngRgba(
        join(
          gswDir(ctx.out, "gate2", "receiver-cold"),
          "shots",
          `seq-${seq}.png`,
        ),
      );
      const b = await decodePngRgba(
        join(
          gswDir(ctx.out, "gate2", "sabotage-gsw-premultiplied-upload"),
          "shots",
          `seq-${seq}.png`,
        ),
      );
      if (!a || !b) {
        problems.push(`step ${k}: shot seq-${seq} missing`);
        continue;
      }
      const regions = (
        expected.steps[k] as unknown as { regions: Record<string, number[]> }
      ).regions;
      for (const [name, r] of Object.entries(regions)) {
        const d = regionDelta(a, b, r);
        if (d.max > 1) failed.add(`${k}:${name}`);
        else if (d.max === 1) delta1Only++;
      }
      // pixelmatch alone at its default budget (threshold 0.12, 1 % of pixels).
      const pm = await compareRgbaBuffers(a.data, b.data, {
        width: a.width,
        height: a.height,
        maxChannelDelta: 255,
      });
      if (!pm.ok) pixelmatchCaught++;
    }
    const want = [...predicted].sort();
    const got = [...failed].sort();
    if (want.length === 0) problems.push("the prediction is empty");
    if (JSON.stringify(want) !== JSON.stringify(got))
      problems.push(`delta > 1 in {${got}}, predicted {${want}}`);
    out.push(
      mk(
        "sabotage-premultiplied-upload@gsw",
        "G7a: premultiplying textures on upload (so linear filtering mixes premultiplied texels) fails exactly gate 2's translucent-filtered (step, region)s with channel delta > 1, predicted from expected.json",
        problems,
        `fails exactly {${want}}; ${delta1Only} other (step, region)s at delta 1 (8-bit premultiply rounding, inside Q7's delta1 class)`,
      ),
    );
    out.push(
      mk(
        "premultiplied-upload-pixelmatch-blind@gsw",
        "memory pixelmatch-hides-alpha-errors: pixelmatch alone (threshold 0.12, 1 % budget) does not catch the premultiplied-upload sabotage; only the raw channel delta does",
        pixelmatchCaught === 0
          ? []
          : [`pixelmatch flagged ${pixelmatchCaught} shot(s)`],
        `pixelmatch passes all ${seqs.length} sabotaged shots; the channel delta fails them`,
      ),
    );
  }
  out.push(
    await compositorCheck(
      "compositor-equals-readback-g2@gsw",
      gswDir(ctx.out, "gate2", "receiver-cold"),
    ),
  );
  return out;
}

// ------------------------------------------------------------------------------------------ g7-3

async function gate3Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const problems: string[] = [];
  let compared = 0;
  for (const capture of ["capture", "capture-xform", "capture-clip-ignore"]) {
    const recording = join(ctx.sourceDir, capture, "recording.rs2");
    if (!existsSync(recording)) {
      problems.push(`${capture}/recording.rs2 missing`);
      continue;
    }
    if (!existsSync(RS_CORE_CHECK)) {
      problems.push(`${RS_CORE_CHECK} missing (build-rs-core.sh)`);
      break;
    }
    const r = spawnSync(
      RS_CORE_CHECK,
      ["scissors", recording, "--store", join(ctx.sourceDir, capture, "store")],
      {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    if (r.status !== 0) {
      problems.push(
        `${capture}: rs-core-check scissors exit ${r.status}: ${r.stderr.slice(0, 200)}`,
      );
      continue;
    }
    const rust = new Map<number, Map<number, number[] | null>>();
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const j = JSON.parse(line) as {
        seq: number;
        items: [number, number[] | null][];
      };
      rust.set(j.seq, new Map(j.items));
    }
    const rec = await loadRecording(recording);
    const viewport = (
      rec.session as unknown as { viewport?: { logical_size?: number[] } }
    )?.viewport?.logical_size ?? [640, 360];
    for (const t of rec.transactions) {
      const seq = t.meta.seq;
      const derived = deriveClipRects(t.meta as never, viewport);
      const got = rust.get(seq);
      if (!got) {
        problems.push(`${capture} seq ${seq}: no Rust line`);
        continue;
      }
      for (const [id, d] of derived) {
        compared++;
        const g = got.get(id);
        if (d === "skipped") {
          if (g !== undefined)
            problems.push(
              `${capture} seq ${seq} item ${id}: derive skipped, Rust visited`,
            );
          continue;
        }
        if (d === "unknown") continue;
        if (g === undefined) {
          problems.push(
            `${capture} seq ${seq} item ${id}: derive visited, Rust did not`,
          );
          continue;
        }
        if (JSON.stringify(g) !== JSON.stringify(d.rect))
          problems.push(
            `${capture} seq ${seq} item ${id}: Rust ${JSON.stringify(g)} != clip-derive ${JSON.stringify(d.rect)}`,
          );
      }
      for (const id of got.keys())
        if (!derived.has(id))
          problems.push(
            `${capture} seq ${seq} item ${id}: Rust visited, derive did not`,
          );
    }
  }
  return [
    mk(
      "clip-parity@gsw",
      "G7a/Q14d: the Rust applier's integer scissor equals clip-derive.ts's for every item of every transaction of gate 3's captures (main, xform, clip-ignore)",
      problems,
      `${compared} (transaction, item) scissors equal`,
    ),
    await compositorCheck(
      "compositor-equals-readback-g3@gsw",
      gswDir(ctx.out, "gate3", "receiver"),
    ),
  ];
}

/** Q7's rendered legs per gate: gsw leg, reference directory, tolerance key. */
const Q7_LEGS: Record<GswGate, [string, string, string][]> = {
  gate0: [["receiver", "reference", "gate0"]],
  gate1: [
    ["receiver", "reference", "gate1"],
    ["receiver-patch", "reference", "gate1"],
  ],
  gate2: [
    ["receiver-cold", "reference", "gate2"],
    ["receiver-warm", "reference", "gate2"],
    ["receiver-patch", "reference", "gate2"],
    ["receiver-inline", "reference", "gate2"],
  ],
  gate3: [
    ["receiver", "reference", "gate3"],
    ["receiver-patch", "reference", "gate3"],
    ["receiver-xform", "reference-xform", "gate3-xform"],
    ["receiver-xform-patch", "reference-xform", "gate3-xform"],
    ["receiver-clip-ignore", "reference-clip-ignore", "gate3"],
  ],
  gate55: GATE55_Q7_LEGS,
  // G7t: the honest legs of gates 4 and 5; key and reference from q7Plan (with gate 4's early
  // shots). gate 4e's MSDF legs count their typed regions as excluded.
  gate4: [
    "receiver",
    "receiver-patch",
    "layout/receiver",
    "layout/receiver-patch",
    "rich-receiver",
    "rich-receiver-patch",
    "rich-underline/receiver",
    "i18n/receiver",
    "i18n/receiver-patch",
    "msdf/receiver",
    "msdf/receiver-patch",
  ].map((l) => [l, "", ""]),
  gate5: [
    "receiver",
    "receiver-patch",
    "mesh/receiver",
    "mesh/receiver-patch",
    "mesh/receiver-inline",
    "style/receiver",
    "style/receiver-patch",
  ].map((l) => [l, "", ""]),
};

/** Q7 (D8): each rendered success leg's shots against the rendered reference, decided pixels
 * exact, the delta1 class at channel <= 1, undecided masks counted. */
async function q7Policy(gate: GswGate, ctx: Ctx): Promise<Gate7Check> {
  const tol = readTolerance();
  const xform = await readJson<Gate3xExpected>(
    join(EXPERIMENT_DIR, "fixtures", "gate3-xform", "expected.json"),
  );
  const problems: string[] = [];
  let shots = 0;
  let delta1 = 0;
  let undecided = 0;
  let excluded = 0;
  for (const [leg, fixedRef, fixedKey] of Q7_LEGS[gate]) {
    // G7t: gates 4 and 5 take the key, the reference and gate 4's early shots from q7Plan.
    const plan = fixedKey ? null : q7Plan(gate, leg, ctx.sourceDir);
    const key = fixedKey || plan?.key || "";
    const refDir = fixedRef || plan?.reference || "";
    const seqs = new Map(
      shotSeqs(join(ctx.sourceDir, leg)).map((seq, k) => [seq, k] as const),
    );
    if (plan?.refs)
      for (const [seq, k] of earlySteps(plan.refs)) seqs.set(seq, k);
    if (!tol.gates[key]) {
      problems.push(`${leg}: no ${key} masks in gsw-tolerance.json`);
      continue;
    }
    for (const [seq, k] of seqs) {
      const ref = await decodePngRgba(
        join(
          ctx.sourceDir,
          refDir,
          "shots",
          plan?.refs?.get(seq) ?? `step-${k}.png`,
        ),
      );
      const got = await decodePngRgba(
        join(gswDir(ctx.out, gate, leg), "shots", `seq-${seq}.png`),
      );
      if (!ref || !got) {
        problems.push(`${leg} seq ${seq}: shot or reference missing`);
        continue;
      }
      const cls = classMask(key, k, got.width, got.height, tol, xform);
      if (!cls) {
        problems.push(`${leg} step ${k}: no ${key} masks for the step`);
        continue;
      }
      const v = judgeQ7Classes(ref, got, cls);
      shots++;
      delta1 += v.delta1_px;
      undecided += v.undecided_px;
      excluded += v.excluded_px ?? 0;
      if (!v.ok)
        problems.push(
          `${leg} step ${k} (seq ${seq}): ${v.decided_px} decided px differ (max ${v.decided_max}), delta1 max ${v.delta1_max}`,
        );
    }
  }
  return mk(
    "q7-pixel-policy@gsw",
    "Q7/D8: every rendered gsw success leg's shot against the rendered reference: decided pixels exact (P-G1), the delta1 class within channel 1 (P-G3), undecided masks counted (P-G4), typed regions excluded and counted; masks from fixtures/gsw-tolerance.json",
    problems,
    `${shots} shots: decided exact; ${delta1} px in delta1 masks, ${undecided} px in undecided masks${excluded ? `, ${excluded} px in typed (excluded) regions` : ""}`,
  );
}

export async function gswExtraChecks(
  gate: GswGate,
  ctx: Ctx,
): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [
    await q7Policy(gate, ctx),
    await gswVsNative(gate, ctx),
    await digestsComplete(gate, ctx),
  ];
  if (gate === "gate0") out.push(...(await gate0Checks(ctx)));
  if (gate === "gate1") out.push(...(await gate1Checks(ctx)));
  if (gate === "gate2") out.push(...(await gate2Checks(ctx)));
  if (gate === "gate3") out.push(...(await gate3Checks(ctx)));
  if (gate === "gate55") out.push(...(await gate55Checks(ctx)));
  if (gate === "gate4" || gate === "gate5")
    out.push(
      ...(await g45ExtraChecks(gate, {
        ...ctx,
        experimentDir: EXPERIMENT_DIR,
        rsCoreCheck: RS_CORE_CHECK,
      })),
    );
  return out;
}
