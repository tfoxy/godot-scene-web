// Gate 8 g8c checks (P3-CT, protocol/gate8-design.md "As built (P3-CT)"): images drawn only
// through a CanvasTexture's diffuse, judged on fixtures/gate8-ct. The pure helpers (premiseProblems,
// regionProblems, uploadProblems) are exported so scripts/test/self-test-gate8-ct.ts can drive them
// on synthetic input.

import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  check,
  exitCode,
  type G8aCheck,
  loadRecording,
  type Rect,
  readJson,
  readText,
  shotDiff,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import type { ResolvedRecording, ResolvedTransaction } from "./render-stream-2";

export interface G8cExpected {
  schema: "render-stream-gate8-ct-expected/1";
  doc: string;
  checkpoints: { step: number; applied: number; settle: number }[];
  /** inclusive [x0, y0, x1, y1] per cell. */
  regions: Record<string, Rect>;
  drawn: string[];
  refused: string[];
  canvas_ok: number;
  canvas_refused: number;
  clear_color: [number, number, number];
}

export interface G8cReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  pixels: Record<
    string,
    { step: number; differing: number; outside_refused: number }[]
  >;
  canvas: { ok: number; refused: number; diffuses: number[] } | null;
}

type State = ResolvedTransaction["state"];

/** ct-premise over a whole recording: no command anywhere names an image that is some canvas
 * texture's diffuse (every diffuse is reached only through its canvas texture); at the last
 * checkpoint the canvas entries are `canvas_ok` ok ones, each over an ok image, and
 * `canvas_refused` unsupported `canvas-texture-channel` ones; one ok diffuse has a higher id than its
 * canvas texture; between the checkpoints one canvas texture's diffuse became a new id and one
 * diffuse's version rose while its canvas texture kept it. */
export function premiseProblems(
  rec: ResolvedRecording,
  expected: G8cExpected,
): { problems: string[]; ok: number; refused: number; diffuses: number[] } {
  const problems: string[] = [];
  const diffuseIds = new Set<number>();
  for (const t of rec.transactions)
    for (const x of t.state.textures)
      if (x.kind === "canvas" && x.canvas?.diffuse != null)
        diffuseIds.add(x.canvas.diffuse);
  for (const t of rec.transactions)
    for (const it of t.state.items)
      for (const c of it.commands)
        if (typeof c.tex === "number" && diffuseIds.has(c.tex))
          problems.push(
            `frame ${t.frame}: item ${it.id} ${c.op} names diffuse ${c.tex} directly`,
          );
  const [c0, c1] = expected.checkpoints;
  const s0 = stateAt(rec, c0.settle)?.state;
  const s1 = stateAt(rec, c1.settle)?.state;
  if (!s0 || !s1)
    return {
      problems: [...problems, "no state at a checkpoint"],
      ok: 0,
      refused: 0,
      diffuses: [],
    };
  const canvases = (s: State) => s.textures.filter((x) => x.kind === "canvas");
  const byId = (s: State) => new Map(s.textures.map((x) => [x.id, x]));
  const t1 = byId(s1);
  const ok = canvases(s1).filter((x) => x.status === "ok");
  const refused = canvases(s1).filter((x) => x.status === "unsupported");
  if (ok.length !== expected.canvas_ok)
    problems.push(
      `${ok.length} ok canvas textures, expected ${expected.canvas_ok}`,
    );
  if (
    refused.length !== expected.canvas_refused ||
    refused.some((x) => x.reason !== "canvas-texture-channel")
  )
    problems.push(
      `refused canvas textures ${JSON.stringify(refused.map((x) => [x.id, x.reason]))}, expected ${expected.canvas_refused} canvas-texture-channel`,
    );
  const diffuses: number[] = [];
  for (const c of ok) {
    const d = c.canvas?.diffuse;
    const img = d == null ? undefined : t1.get(d);
    if (d == null || !img || img.kind !== "image" || img.status !== "ok")
      problems.push(`canvas ${c.id}: diffuse ${d} is not an ok image`);
    else diffuses.push(d);
  }
  if (!ok.some((c) => (c.canvas?.diffuse ?? 0) > c.id))
    problems.push("no ok canvas texture has a diffuse created after it");
  const t0 = byId(s0);
  const swapped = canvases(s0).filter((c) => {
    const later = t1.get(c.id);
    return (
      c.status === "ok" &&
      later?.canvas?.diffuse != null &&
      later.canvas.diffuse !== c.canvas?.diffuse &&
      !t0.has(later.canvas.diffuse)
    );
  });
  if (swapped.length !== 1)
    problems.push(
      `${swapped.length} canvas textures got a new diffuse between the checkpoints, expected 1`,
    );
  const updated = canvases(s0).filter((c) => {
    const d = c.canvas?.diffuse;
    const later = t1.get(c.id);
    return (
      d != null &&
      later?.canvas?.diffuse === d &&
      (t1.get(d)?.version ?? 0) > (t0.get(d)?.version ?? 0)
    );
  });
  if (updated.length !== 1)
    problems.push(
      `${updated.length} diffuses updated in place between the checkpoints, expected 1`,
    );
  return {
    problems: [...new Set(problems)].slice(0, 20),
    ok: ok.length,
    refused: refused.length,
    diffuses,
  };
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** ct-reference-textured / ct-channel-refused: one region of a shot. `textured`: no white pixel,
 * no clear-colour pixel and at least 4 distinct colours; `clear`: every pixel the clear colour. */
export function regionProblems(
  img: Rgba,
  rect: Rect,
  want: "textured" | "clear",
  clear: [number, number, number],
): string[] {
  const colours = new Set<number>();
  let white = 0;
  let cleared = 0;
  let n = 0;
  for (let y = rect[1]; y <= rect[3]; y++)
    for (let x = rect[0]; x <= rect[2]; x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      n++;
      colours.add((r << 16) | (g << 8) | b);
      if (r === 255 && g === 255 && b === 255) white++;
      if (r === clear[0] && g === clear[1] && b === clear[2]) cleared++;
    }
  if (want === "clear")
    return cleared === n
      ? []
      : [`${n - cleared} of ${n} px not the clear colour`];
  const problems: string[] = [];
  if (white > 0) problems.push(`${white} white px`);
  if (cleared > 0) problems.push(`${cleared} clear-colour px`);
  if (colours.size < 4) problems.push(`${colours.size} distinct colours`);
  return problems;
}

interface UploadRow {
  id: number;
  op: string;
}

/** ct-diffuse-uploaded: every diffuse of an ok canvas texture was uploaded as an image (create, or
 * update in place); the canvas textures themselves are `canvas` rows. */
export function uploadProblems(
  uploads: UploadRow[] | undefined,
  diffuses: number[],
): string[] {
  if (!uploads) return ["no uploads[] in applied.json"];
  const problems: string[] = [];
  for (const d of diffuses)
    if (
      !uploads.some(
        (u) => u.id === d && (u.op === "create" || u.op === "replace"),
      )
    )
      problems.push(`diffuse ${d} never uploaded`);
  return problems;
}

export async function runG8c(
  out: string,
  expected: G8cExpected,
): Promise<{ checks: G8aCheck[]; report: G8cReport }> {
  const root = join(out, "g8c");
  const checks: G8aCheck[] = [];
  const receivers = ["receiver", "receiver-patch"];
  const headlessReceivers = ["headless/receiver", "headless/receiver-patch"];
  const legDirs = [
    "import/fixture",
    "import/receiver",
    "reference",
    "capture",
    ...receivers,
    "headless/capture",
    "headless-off/capture",
    ...headlessReceivers,
    "headless-off/receiver",
  ];
  const legs: G8cReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = {
      exit_code: await exitCode(join(root, l)),
      skipped: skipped(join(root, l)),
    };
  const ran = (l: string) =>
    legs[l].exit_code !== null && legs[l].skipped === null;
  const report: G8cReport = { legs, pixels: {}, canvas: null };
  const refusedRects = expected.refused.map((r) => expected.regions[r]);

  {
    const problems: string[] = [];
    for (const l of legDirs) {
      if (legs[l].skipped !== null) continue;
      if (legs[l].exit_code !== "0")
        problems.push(`${l} exit ${legs[l].exit_code}`);
    }
    checks.push(
      check(
        "g8c-legs",
        "every g8c leg that ran (the imports, the rendered reference, the /8 capture on the rendered host and both receivers; HSD: the two headless /12 captures and their receivers) exits 0",
        problems,
        `${legDirs.filter(ran).length} legs`,
      ),
    );
  }

  // --- ct-premise ---------------------------------------------------------------------------
  const cap = await loadRecording(join(root, "capture"));
  let diffuses: number[] = [];
  {
    let problems: string[] | null = null;
    if (cap.rec) {
      const p = premiseProblems(cap.rec, expected);
      problems = p.problems;
      diffuses = p.diffuses;
      report.canvas = { ok: p.ok, refused: p.refused, diffuses };
    } else if (ran("capture")) problems = [cap.error ?? "no recording"];
    checks.push(
      check(
        "ct-premise",
        `the capture's stream: no command names an image that is a canvas texture's diffuse (each is reached only through its canvas texture); at the last checkpoint ${expected.canvas_ok} ok canvas textures over ok images and ${expected.canvas_refused} unsupported canvas-texture-channel ones; one diffuse created after its canvas texture; between the checkpoints one canvas texture gets a new diffuse and one diffuse is updated in place`,
        problems,
        report.canvas
          ? `${report.canvas.ok} ok, ${report.canvas.refused} refused, diffuses ${report.canvas.diffuses.join(",")}`
          : undefined,
      ),
    );
  }

  // --- ct-reference-textured ------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (ran("reference")) {
      problems = [];
      for (const c of expected.checkpoints) {
        const img = await decodePngRgba(
          join(root, "reference", "shots", `step-${c.step}.png`),
        );
        if (!img) {
          problems.push(`reference step ${c.step}: no shot`);
          continue;
        }
        for (const r of [...expected.drawn, ...expected.refused])
          problems.push(
            ...regionProblems(
              img,
              expected.regions[r],
              "textured",
              expected.clear_color,
            ).map((p) => `step ${c.step} ${r}: ${p}`),
          );
      }
    }
    checks.push(
      check(
        "ct-reference-textured",
        "the unarmed reference draws every cell textured (no white, no clear-colour pixel, at least 4 colours), so a receiver drawing a canvas texture as Godot's white default, or not at all, cannot equal it",
        problems,
        `${expected.drawn.length + expected.refused.length} cells x ${expected.checkpoints.length} checkpoints`,
      ),
    );
  }

  // --- ct-reference -------------------------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of ["capture", ...receivers]) {
      if (!ran(l) || !ran("reference")) {
        problems = null;
        break;
      }
      report.pixels[l] = [];
      for (const c of expected.checkpoints) {
        const d = await shotDiff(
          join(root, l),
          join(root, "reference"),
          c.step,
          refusedRects,
        );
        if (!d.present) problems.push(`${l} step ${c.step}: shot missing`);
        // the capture host draws what Godot draws, refused cells included
        const outside = l === "capture" ? d.differing : d.outside;
        if (outside > 0)
          problems.push(
            `${l} step ${c.step}: ${outside} px differ (max ${d.max_delta})`,
          );
        report.pixels[l].push({
          step: c.step,
          differing: d.differing,
          outside_refused: outside,
        });
      }
    }
    checks.push(
      check(
        "ct-reference",
        `the native receiver on the full and patch sinks equals the unarmed reference exactly at every checkpoint outside the refused cells (${expected.refused.join(", ")}); the armed rendered capture host's own frames equal it everywhere`,
        problems,
      ),
    );
  }

  // --- ct-channel-refused -------------------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of receivers) {
      if (!ran(l)) {
        problems = null;
        break;
      }
      const seqs =
        (await readText(join(root, l, "shot-seqs.txt")))?.trim().split(",") ??
        [];
      for (const c of expected.checkpoints) {
        const img = await decodePngRgba(
          join(root, l, "shots", `seq-${seqs[c.step]}.png`),
        );
        if (!img) {
          problems.push(`${l} step ${c.step}: no shot`);
          continue;
        }
        for (const r of expected.refused)
          problems.push(
            ...regionProblems(
              img,
              expected.regions[r],
              "clear",
              expected.clear_color,
            ).map((p) => `${l} step ${c.step} ${r}: ${p}`),
          );
      }
      const applied = await readJson<{ unsupported?: { reason: string }[] }>(
        join(root, l, "applied.json"),
      );
      const n = (applied?.unsupported ?? []).filter(
        (u) => u.reason === "unsupported-texture",
      ).length;
      if (n !== expected.canvas_refused)
        problems.push(
          `${l}: ${n} unsupported-texture commands reported, expected ${expected.canvas_refused}`,
        );
    }
    checks.push(
      check(
        "ct-channel-refused",
        "a canvas texture with a normal or specular map stays the typed refusal (render-stream-2.md canvas-texture-channel; lighting is out of scope): each receiver skips and reports its command (unsupported-texture) and those cells stay the clear colour",
        problems,
      ),
    );
  }

  // --- ct-diffuse-uploaded ------------------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of receivers) {
      if (!ran(l) || diffuses.length === 0) {
        problems = null;
        break;
      }
      const applied = await readJson<{ uploads?: UploadRow[] }>(
        join(root, l, "applied.json"),
      );
      problems.push(
        ...uploadProblems(applied?.uploads, diffuses).map((p) => `${l}: ${p}`),
      );
    }
    checks.push(
      check(
        "ct-diffuse-uploaded",
        "each receiver made every ok canvas texture's diffuse resident (an image upload), although no command names it: a canvas texture names its diffuse",
        problems,
        `${diffuses.length} diffuses`,
      ),
    );
  }

  // --- ct-headless-seat (HSD) -----------------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of ["headless/capture", ...headlessReceivers, ...receivers])
      if (!ran(l)) problems = null;
    if (problems) {
      const shim = (await readJson<CaptureShimResult>(join(root, "headless/capture", "evidence", "result.json")))
        ?.canvas_texture_shim;
      problems.push(
        ...headlessShimProblems(shim, true, expected.canvas_ok + expected.canvas_refused).map(
          (p) => `headless/capture: ${p}`,
        ),
      );
      for (const l of headlessReceivers)
        for (const c of expected.checkpoints) {
          const d = await shotDiff(join(root, l), join(root, "receiver"), c.step);
          if (!d.present) problems.push(`${l} step ${c.step}: shot missing`);
          else if (d.differing > 0)
            problems.push(`${l} step ${c.step}: ${d.differing} px differ from receiver (max ${d.max_delta})`);
        }
    }
    checks.push(
      check(
        "ct-headless-seat",
        "HSD: the same fixture captured on a HEADLESS host at /12 with the headless defaults (the streaming seat's shape) arms the canvas-texture shim by itself (result.json canvas_texture_shim: default, armed, one private RID per canvas texture), and the native receiver on its full and patch sinks equals the receiver of the rendered host's capture pixel for pixel at every checkpoint",
        problems,
        `${headlessReceivers.length} receivers x ${expected.checkpoints.length} checkpoints`,
      ),
    );
  }

  // --- ct-headless-off (HSD's control) -----------------------------------------------------------
  {
    let problems: string[] | null = [];
    for (const l of ["headless-off/capture", "headless-off/receiver"]) if (!ran(l)) problems = null;
    if (problems) {
      const shim = (await readJson<CaptureShimResult>(join(root, "headless-off/capture", "evidence", "result.json")))
        ?.canvas_texture_shim;
      problems.push(...headlessShimProblems(shim, false, 0).map((p) => `headless-off/capture: ${p}`));
      const seqs = (await readText(join(root, "headless-off/receiver", "shot-seqs.txt")))?.trim().split(",") ?? [];
      for (const c of expected.checkpoints) {
        const img = await decodePngRgba(join(root, "headless-off/receiver", "shots", `seq-${seqs[c.step]}.png`));
        if (!img) {
          problems.push(`headless-off/receiver step ${c.step}: no shot`);
          continue;
        }
        for (const r of [...expected.drawn, ...expected.refused])
          problems.push(
            ...regionProblems(img, expected.regions[r], "clear", expected.clear_color).map(
              (p) => `headless-off/receiver step ${c.step} ${r}: ${p}`,
            ),
          );
      }
    }
    checks.push(
      check(
        "ct-headless-off",
        "HSD's control (the pre-HSD streaming seat): the headless /12 capture with GRC_HEADLESS_CANVAS_TEXTURE=off (and the particles shim and pump off) leaves the shim off, every canvas texture is RID() and every draw through one is refused canvas-texture-headless, so every cell stays the clear colour on the receiver -- what ct-headless-seat must not equal",
        problems,
      ),
    );
  }

  return { checks, report };
}

interface CaptureShimResult {
  canvas_texture_shim?: { env?: string; default?: boolean; state?: string; synthesized?: number };
}

/** ct-headless-seat / ct-headless-off: a headless capture's result.json canvas_texture_shim block.
 * `armed`: the headless default armed it (env synthesize, default true, state armed) and gave
 * `synthesized` canvas textures a private RID; otherwise it is off (state off, nothing synthesized). */
export function headlessShimProblems(
  shim: CaptureShimResult["canvas_texture_shim"] | undefined,
  armed: boolean,
  synthesized: number,
): string[] {
  if (!shim) return ["result.json has no canvas_texture_shim block"];
  const problems: string[] = [];
  const want = armed
    ? { env: "synthesize", default: true, state: "armed" }
    : { env: "off", default: false, state: "off" };
  for (const [k, v] of Object.entries(want))
    if (shim[k as keyof typeof want] !== v) problems.push(`canvas_texture_shim.${k} ${JSON.stringify(shim[k as keyof typeof want])}, expected ${JSON.stringify(v)}`);
  if (shim.synthesized !== synthesized)
    problems.push(`canvas_texture_shim.synthesized ${shim.synthesized}, expected ${synthesized}`);
  return problems;
}
