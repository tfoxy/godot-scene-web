// Gate 8's native receiver checks at render-stream/13 (W13d, protocol/render-stream-13.md "As built
// (W13d)"). The legs are W13c's GSW legs, planned for the native receiver by gate8-w11-tool.ts
// native-plan (the same captures, sinks, sabotage and shot frames):
//
// g8w11 (<run>/g8w11/<leg>/receiver, frames in native-frames.json), on W13b's /13 captures:
//   native-w13-replays        every /13 leg and its /12 twin replays its whole recording (status ok,
//                             one applied transaction per recorded one), and no /13 leg failed
//                             predict-check (applied.json `w13.predict_failures` 0)
//   native-w13-dynamic-applied  at every applied /13 transaction the bodies the receiver draws its
//                             dynamic meshes from (applied.json `dynamic_sha256`) equal the
//                             TypeScript resolved state of the /13 recording (render-stream-2.ts
//                             un-predicts it): the ingest reads the reconstructed /12 record
//   native-w13-equals-v12     each /13 leg's shots equal its /12 twin's at the same frames, pixel for
//                             pixel: the /13 accept path draws what /12's does
//   native-w13-mesh-exact     gate5-mesh at /13 (mesh13: g5c's and g5e's meshes) equals the native
//                             /11 mesh leg (g8w11/mesh/receiver, which native-w11-equals-v10 ties to
//                             the /10 path gate 5 judges against Godot) pixel for pixel at every
//                             shared frame
//   native-w13-no-predict-reset-caught  the decoder sabotage no-predict-reset (a full un-predicted
//                             against the history) on mesh13's full sink fails predict-check
//
// g8pt (<run>/g8pt/<capture's directory>/receiver, frames in native-frames-pt13.json), on W13b's
// headless /13 twins (gate8-w11-tool.ts native-plan --set pt13):
//   native-pt13-replays       pump13 (gate8-mm under the frame_pre_draw pump: multimesh buffers through
//                             mm_f32's prediction), shim13 (gate8-pt under the particles shim) and
//                             their /12 twins replay whole, no predict-check failure
//   native-pt13-equals-v12    each /13 leg's shots equal its /12 twin's at the same frames
//   mm13-reference            pump13 equals g8mm's unarmed reference exactly at each settle frame and
//                             the frame before, outside the known-gap cells (mm-reference's verdict)
//
// g8w11c (<run>/g8w11c/<leg>/coded), live, run_g8w11c_native13:
//   native13-predict-resync   under the host's predict-stale a coded receiver at /13 fails
//                             predict-check, resyncs (reason coding, a coding resync), holds the
//                             patches before the full, ends ok on the honest leg's last frame with
//                             the honest leg's drawn dynamic bodies there, and (a browser receiver,
//                             gate 7's live half) its final shot equals the honest leg's pixel for pixel
//   native13-no-predict-reset-caught  the receiver sabotage no-predict-reset fails that check (the
//                             resync's full fails predict-check too, so the receiver never catches up)
//
// Gate 7's g7-8 web half replays the file legs in the web export and judges them with these checks
// (`@web`); its live half runs g8w11c's native13 legs with the web export (GSW runs W13c's gsw13).

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck } from "./gate8-adopt-checks";
import { mmCellDiff, mmExactProblems } from "./gate8-mm-checks";
import { dynamicAppliedProblems, shotDiff } from "./gate8-w11-gsw-checks";
import { type ResolvedRecording, resolveRecording } from "./render-stream-2";

/** g8w11's native /13 legs: receiver directory -> [capture, sink, version]. */
const W13_CAPTURE: Record<string, [string, string, 12 | 13]> = {
  "scale13/receiver": ["scale13/capture", "recording-patch.rs13", 13],
  "scale13/v12/receiver": ["scale13/v12/capture", "recording-patch.rs12", 12],
  "mesh13/receiver": ["mesh13/capture", "recording.rs13", 13],
  "mesh13/v12/receiver": ["mesh13/v12/capture", "recording.rs12", 12],
};
const W13_TWINS: readonly [string, string][] = [
  ["scale13/receiver", "scale13/v12/receiver"],
  ["mesh13/receiver", "mesh13/v12/receiver"],
];
const W13_NO_RESET = "mesh13/sabotage-no-predict-reset/receiver";
/** The native /11 gate5-mesh leg (W11d). */
const MESH11 = "mesh/receiver";

/** g8pt's native /13 legs. */
const PT13_CAPTURE: Record<string, [string, string, 12 | 13]> = {
  "headless-pump13/receiver": ["headless-pump13/capture", "recording.rs13", 13],
  "headless-pump/receiver": ["headless-pump/capture", "recording.rs12", 12],
  "headless-shim13/receiver": ["headless-shim13/capture", "recording.rs13", 13],
  "headless-shim/receiver": ["headless-shim/capture", "recording.rs12", 12],
};
const PT13_TWINS: readonly [string, string][] = [
  ["headless-pump13/receiver", "headless-pump/receiver"],
  ["headless-shim13/receiver", "headless-shim/receiver"],
];

interface Applied {
  status: string;
  failure: { seq: number | null; reason: string; detail: string } | null;
  transactions: { seq: number; frame: number; dynamic_sha256?: string }[];
  w13?: W13Evidence;
  live?: {
    coding?: { resyncs?: number };
    predict?: Partial<W13Evidence> & { resyncs?: number };
  };
}
/** receiver.gd's `w13` (rs-core-capi `counters`' w13_*, GSW's `gsw.w13` names). */
interface W13Evidence {
  predict_failures: number;
  predict_dropped: number;
  no_predict_reset: number | boolean;
  history_units: number;
  predict_resyncs?: number;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const notRun = (id: string, criterion: string, detail: string): G8aCheck => ({
  id,
  criterion,
  passed: true,
  status: "not-run",
  detail,
  gating: false,
});

/** Replays whole and no /13 predict-check failure: the problems and a note per leg. */
async function replayProblems(
  root: string,
  table: Record<string, [string, string, 12 | 13]>,
  recOf: (leg: string) => Promise<ResolvedRecording | null>,
): Promise<{ problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const [leg, [, , v]] of Object.entries(table)) {
    const a = await readJson<Applied>(join(root, leg, "applied.json"));
    const rec = await recOf(leg);
    if (!a || !rec) {
      problems.push(`${leg}: ${a ? "no capture" : "no applied.json"}`);
      continue;
    }
    if (a.status !== "ok")
      problems.push(`${leg}: ${a.failure?.reason}: ${a.failure?.detail?.slice(0, 160)}`);
    else if (a.transactions.length !== rec.transactions.length)
      problems.push(`${leg}: ${a.transactions.length} applied of ${rec.transactions.length}`);
    if (v === 13) {
      if (!a.w13) problems.push(`${leg}: applied.json has no w13 evidence`);
      else if (a.w13.predict_failures > 0)
        problems.push(`${leg}: ${a.w13.predict_failures} predict-check failure(s)`);
      else notes.push(`${leg} ${a.transactions.length} txs, ${a.w13.history_units} units held at the end`);
    }
  }
  return { problems, notes };
}

/** Shots of `leg` and `twin` at their shared frames: the problems and the frame count. */
async function twinProblems(
  root: string,
  frames: Record<string, Record<string, number>>,
  leg: string,
  twin: string,
  /** gate8-mm's cells: a difference also names them (lib/gate7-web-flakes.ts reads them). */
  regions?: Record<string, [number, number, number, number]>,
): Promise<{ problems: string[]; n: number }> {
  const problems: string[] = [];
  let n = 0;
  for (const [frame, seq] of Object.entries(frames[leg] ?? {})) {
    const tseq = frames[twin]?.[frame];
    if (tseq === undefined) continue;
    n++;
    const px = await shotDiff(
      join(root, leg, "shots", `seq-${seq}.png`),
      join(root, twin, "shots", `seq-${tseq}.png`),
    );
    if (px === null) problems.push(`${leg}: frame ${frame}: shot missing`);
    else if (px > 0) {
      let where = "";
      if (regions) {
        const a = await decodePngRgba(join(root, leg, "shots", `seq-${seq}.png`));
        const b = await decodePngRgba(join(root, twin, "shots", `seq-${tseq}.png`));
        const d = a && b ? mmCellDiff(a, b, regions) : null;
        if (d) {
          const parts = Object.entries(d.cells)
            .filter(([, n]) => n > 0)
            .map(([c, n]) => `${c} ${n}`);
          if (d.outside > 0) parts.push(`outside ${d.outside}`);
          where = ` (${parts.join(", ")})`;
        }
      }
      problems.push(`${leg}: frame ${frame}: ${px} px differ from ${twin}${where}`);
    }
  }
  if (n === 0) problems.push(`${leg}: no shot frame shared with ${twin}`);
  return { problems, n };
}

function recordingCache(root: string, table: Record<string, [string, string, 12 | 13]>) {
  const recs = new Map<string, ResolvedRecording>();
  return async (leg: string): Promise<ResolvedRecording | null> => {
    if (!recs.has(leg)) {
      const [cap, sink, v] = table[leg];
      const path = join(root, cap, sink);
      if (!existsSync(path)) return null;
      recs.set(leg, resolveRecording(new Uint8Array(await readFile(path)), v));
    }
    return recs.get(leg) ?? null;
  };
}

/** W13d: g8w11's native /13 file legs (`g` is <run>/g8w11). */
export async function runG8w13Native(g: string): Promise<G8aCheck[]> {
  const ids = [
    "native-w13-replays",
    "native-w13-dynamic-applied",
    "native-w13-equals-v12",
    "native-w13-mesh-exact",
    "native-w13-no-predict-reset-caught",
  ];
  if (!existsSync(join(g, "scale13", "capture")) && !existsSync(join(g, "mesh13", "capture")))
    return ids.map((id) => notRun(id, "W13d: the native receiver at render-stream/13 on g8w11's /13 captures", "no /13 capture in this run"));
  if (!existsSync(join(g, "native-plan.tsv")))
    return ids.map((id) => check(id, "W13d: the native g8w11 /13 legs ran", null));
  const checks: G8aCheck[] = [];
  const frames =
    (await readJson<Record<string, Record<string, number>>>(join(g, "native-frames.json"))) ?? {};
  const recOf = recordingCache(g, W13_CAPTURE);

  {
    const { problems, notes } = await replayProblems(g, W13_CAPTURE, recOf);
    checks.push(
      check(
        ids[0],
        "W13d: the native receiver replays W13b's /13 captures (capture-scale's patch sink, gate5-mesh's full sink) and their /12 twins whole, no predict-check failure",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const problems: string[] = [];
    const notes: string[] = [];
    let dynamic = 0;
    for (const leg of ["scale13/receiver", "mesh13/receiver"]) {
      const a = await readJson<Applied>(join(g, leg, "applied.json"));
      const rec = await recOf(leg);
      if (!a || !rec) {
        problems.push(`${leg}: evidence missing`);
        continue;
      }
      const r = dynamicAppliedProblems(rec, a.transactions);
      dynamic += r.dynamicTxs;
      problems.push(...r.problems.slice(0, 4).map((p) => `${leg}: ${p}`));
      notes.push(`${leg} ${r.compared} txs (${r.dynamicTxs} dynamic)`);
    }
    if (dynamic === 0) problems.push("no transaction held a dynamic mesh (vacuous)");
    checks.push(
      check(
        ids[1],
        "W13d: at every applied /13 transaction the native receiver draws each dynamic mesh from the body the TypeScript resolved state of the /13 recording names (body_sha256)",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of W13_TWINS) {
      const r = await twinProblems(g, frames, leg, twin);
      problems.push(...r.problems);
      notes.push(`${leg} ${r.n} frames`);
    }
    checks.push(
      check(
        ids[2],
        "W13d: each native /13 leg's shots equal its /12 twin's at the same frames, pixel for pixel",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const r = await twinProblems(g, frames, "mesh13/receiver", MESH11);
    checks.push(
      check(
        ids[3],
        "W13d: gate5-mesh at /13 (g5c's and g5e's meshes) equals the native /11 mesh leg pixel for pixel at every shared frame (native-w11-equals-v10 ties that leg to the /10 path gate 5 judges against Godot exactly)",
        r.problems,
        `${r.n} frames`,
      ),
    );
  }
  {
    const id = ids[4];
    const criterion =
      "W13d: the decoder sabotage no-predict-reset (a full un-predicted against H1 and H2) on gate5-mesh's /13 full sink fails predict-check";
    if (existsSync(join(g, W13_NO_RESET, "skipped-by-tier.txt"))) {
      checks.push(notRun(id, criterion, `skipped-by-tier: ${W13_NO_RESET}`));
    } else {
      const a = await readJson<Applied>(join(g, W13_NO_RESET, "applied.json"));
      const problems: string[] | null = a ? [] : null;
      if (a && problems) {
        if (a.status === "ok") problems.push("the sabotaged replay ended ok");
        else if (a.failure?.reason !== "predict-check")
          problems.push(`failed ${a.failure?.reason} (expected predict-check): ${a.failure?.detail?.slice(0, 120)}`);
      }
      checks.push(check(id, criterion, problems, a ? `${a.failure?.reason} at seq ${a.failure?.seq}` : ""));
    }
  }
  return checks;
}

/** W13d: g8pt's native /13 legs (`out` is the gate 8 run). */
export async function runG8pt13Native(
  out: string,
  mmPixels: {
    regions: Record<string, [number, number, number, number]>;
    known_gaps?: Record<string, { cells: string[] }>;
  } | null,
): Promise<G8aCheck[]> {
  const g = join(out, "g8pt");
  const ids = ["native-pt13-replays", "native-pt13-equals-v12", "mm13-reference"];
  if (!existsSync(join(g, "headless-pump13", "capture")) && !existsSync(join(g, "headless-shim13", "capture")))
    return ids.map((id) => notRun(id, "W13d: the native receiver at render-stream/13 on g8pt's headless /13 twins", "no /13 capture in this run"));
  if (!existsSync(join(g, "native-plan-pt13.tsv")))
    return ids.map((id) => check(id, "W13d: the native g8pt /13 legs ran", null));
  const checks: G8aCheck[] = [];
  const frames =
    (await readJson<Record<string, Record<string, number>>>(join(g, "native-frames-pt13.json"))) ?? {};
  const recOf = recordingCache(g, PT13_CAPTURE);
  {
    const { problems, notes } = await replayProblems(g, PT13_CAPTURE, recOf);
    checks.push(
      check(
        ids[0],
        "W13d: the native receiver replays g8pt's headless /13 captures (gate8-mm under the pump: multimesh buffers; gate8-pt under the particles shim) and their /12 twins whole, no predict-check failure",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of PT13_TWINS) {
      const r = await twinProblems(
        g,
        frames,
        leg,
        twin,
        leg.startsWith("headless-pump") ? mmPixels?.regions : undefined,
      );
      problems.push(...r.problems);
      notes.push(`${leg} ${r.n} frames`);
    }
    checks.push(
      check(
        ids[1],
        "W13d: each native g8pt /13 leg's shots equal its /12 twin's at the same frames, pixel for pixel",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const id = ids[2];
    const criterion =
      "W13d: gate8-mm at /13 (pump13: every multimesh buffer through mm_f32's prediction) on the native receiver equals g8mm's unarmed reference exactly at each settle frame and the frame before, outside the known-gap cells (mm-reference's verdict)";
    const steps = (await readFile(join(out, "g8mm", "capture", "steps.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { step: number; settle_frame: number });
    if (steps.length === 0 || !mmPixels) {
      checks.push(notRun(id, criterion, "no g8mm reference in this run"));
    } else {
      const gaps = [...new Set(Object.values(mmPixels.known_gaps ?? {}).flatMap((x) => x.cells))];
      const problems: string[] = [];
      let pairs = 0;
      const leg = "headless-pump13/receiver";
      for (const [frame, seq] of Object.entries(frames[leg] ?? {})) {
        const f = Number(frame);
        const st = steps.find((s) => s.settle_frame === f || s.settle_frame - 1 === f);
        if (!st) continue;
        const ref = st.settle_frame === f ? `step-${st.step}.png` : `step-${st.step}-prev.png`;
        const a = await decodePngRgba(join(g, leg, "shots", `seq-${seq}.png`));
        const b = await decodePngRgba(join(out, "g8mm", "reference", "shots", ref));
        if (!a || !b) {
          problems.push(`frame ${f}: ${a ? `reference ${ref}` : "pump13 shot"} missing`);
          continue;
        }
        const d = mmCellDiff(a, b, mmPixels.regions);
        if (!d) {
          problems.push(`frame ${f}: ${a.width}x${a.height} against the reference's ${b.width}x${b.height}`);
          continue;
        }
        pairs++;
        for (const p of mmExactProblems(d, gaps)) problems.push(`frame ${f} (${ref}): ${p}`);
      }
      if (pairs === 0) problems.push("no pump13 shot pairs with a reference shot");
      checks.push(check(id, criterion, problems, `${pairs} pairs${gaps.length > 0 ? `, known gaps ${gaps.join(", ")} not judged` : ""}`));
    }
  }
  return checks;
}

/** The receiver directory of a g8w11c leg (every directory but `host`) and the host's stale seq. */
async function liveLeg(root: string, leg: string) {
  const dir = join(root, leg);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name !== "host")?.name;
  if (!name) return null;
  const summary = await readJson<{ connections?: { predict?: { stale_seq?: number | null } }[] }>(
    join(dir, "host", "evidence", "live-summary.json"),
  );
  const applied = await readJson<Applied>(join(dir, name, "applied.json"));
  /** frame -> the drawn dynamic bodies' digest, for every applied transaction that has one. */
  const byFrame = new Map<number, string>();
  let staleFrame: number | null = null;
  const staleSeq = summary?.connections?.[0]?.predict?.stale_seq ?? null;
  for (const t of applied?.transactions ?? []) {
    if (t.dynamic_sha256 !== undefined) byFrame.set(t.frame, t.dynamic_sha256);
    if (staleSeq !== null && t.seq < staleSeq) staleFrame = t.frame;
  }
  return {
    applied,
    finalShot: join(dir, name, "shots", "final.png"),
    staleSeq,
    /** The last frame applied before the stale transaction. */
    staleFrame,
    lastFrame: applied?.transactions.at(-1)?.frame ?? null,
    byFrame,
  };
}

/** W13d: g8w11c's native13 resync legs (`root` is <run>/g8w11c). */
export async function runG8w11cNative13(root: string): Promise<G8aCheck[]> {
  const ids = ["native13-predict-resync", "native13-no-predict-reset-caught"];
  if (!existsSync(join(root, "native13-honest")))
    return ids.map((id) =>
      notRun(id, "W13d: the native receiver's /13 resync legs (g8w11c; GSW runs W13c's gsw13 legs)", "no native13 leg in this run"),
    );
  const checks: G8aCheck[] = [];
  const honest = await liveLeg(root, "native13-honest");
  const browser = existsSync(honest?.finalShot ?? "");
  {
    const id = ids[0];
    const criterion =
      "W13d: under the host's predict-stale a coded receiver at /13 fails predict-check, resyncs (reason coding), holds the patches before the full, ends ok within two frames of the honest /13 leg's last frame, and at every frame both legs applied after the stale transaction draws the honest leg's dynamic bodies (the host's frames are deterministic; a browser receiver whose last frame is the honest leg's: and its final shot equals that leg's pixel for pixel)";
    const v = await liveLeg(root, "native13-predict-stale");
    const problems: string[] | null = v && honest ? [] : null;
    let detail = "";
    if (v && honest && problems) {
      const a = v.applied;
      if (honest.applied?.status !== "ok")
        problems.push(`honest leg status ${honest.applied?.status}: ${honest.applied?.failure?.detail?.slice(0, 120)}`);
      if ((honest.applied?.live?.predict?.resyncs ?? 0) !== 0) problems.push("the honest leg resynced on predict-check");
      if (a?.status !== "ok") problems.push(`status ${a?.status}: ${a?.failure?.reason} ${a?.failure?.detail?.slice(0, 120)}`);
      if (v.staleSeq === null) problems.push("the host coded no patch stale (predict.stale_seq null)");
      const p = a?.live?.predict;
      if ((p?.resyncs ?? 0) < 1) problems.push("no predict-check resync");
      if ((a?.live?.coding?.resyncs ?? 0) < (p?.resyncs ?? 0)) problems.push("a predict-check resync was not a coding resync");
      if (v.lastFrame === null || honest.lastFrame === null || v.lastFrame < honest.lastFrame - 2)
        problems.push(`last applied frame ${v.lastFrame}, honest ${honest.lastFrame}: the receiver did not catch up`);
      let shared = 0;
      const differ: number[] = [];
      for (const [frame, digest] of v.byFrame) {
        if (v.staleFrame === null || frame <= v.staleFrame) continue;
        const h = honest.byFrame.get(frame);
        if (h === undefined) continue;
        shared++;
        if (h !== digest) differ.push(frame);
      }
      if (shared === 0) problems.push("no frame after the stale transaction applied by both legs");
      if (differ.length > 0)
        problems.push(`the drawn dynamic bodies differ from the honest leg's at ${differ.length} frame(s), first ${differ[0]}`);
      let px: number | null | string = "headless receiver: no shot";
      if (browser) {
        if (v.lastFrame === honest.lastFrame) {
          px = await shotDiff(v.finalShot, honest.finalShot);
          if (px === null) problems.push("a final shot is missing");
          else if (px > 0) problems.push(`the final shot differs from the honest leg's by ${px} px`);
        } else px = `not compared (last frames ${v.lastFrame} and ${honest.lastFrame})`;
      }
      detail = `stale seq ${v.staleSeq}, predict resyncs ${p?.resyncs}, held ${p?.predict_dropped}, last frame ${v.lastFrame} (honest ${honest.lastFrame}), ${shared} shared frames after the stale one with equal bodies ${shared - differ.length}, final shot ${typeof px === "number" ? `diff ${px} px` : px}`;
    }
    checks.push(check(id, criterion, problems, detail));
  }
  {
    const id = ids[1];
    const criterion =
      "W13d: the receiver sabotage no-predict-reset (the resync's full un-predicted against the stale history) fails native13-predict-resync: the receiver never reaches the honest leg's last state";
    const leg = "native13-sabotage-no-predict-reset";
    if (existsSync(join(root, leg, "host", "skipped-by-tier.txt"))) {
      checks.push(notRun(id, criterion, `skipped-by-tier: ${leg}`));
    } else {
      const v = await liveLeg(root, leg);
      const problems: string[] | null = v && honest ? [] : null;
      let detail = "";
      if (v && honest && problems) {
        const caughtUp =
          v.applied?.status === "ok" &&
          v.lastFrame !== null &&
          honest.lastFrame !== null &&
          v.lastFrame >= honest.lastFrame - 2;
        let px: number | null = null;
        if (browser) px = await shotDiff(v.finalShot, honest.finalShot);
        if (caughtUp)
          problems.push("the sabotaged receiver caught up with the honest leg: the resync check would pass");
        const p = v.applied?.live?.predict;
        detail = `predict failures ${p?.predict_failures}, resyncs ${p?.resyncs}, last frame ${v.lastFrame} (honest ${honest.lastFrame}), status ${v.applied?.status}${browser ? `, final shot diff ${px === null ? "missing" : `${px} px`}` : ""}`;
      }
      checks.push(check(id, criterion, problems, detail));
    }
  }
  return checks;
}
