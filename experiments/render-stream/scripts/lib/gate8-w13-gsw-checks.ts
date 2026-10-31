// Gate 8 g8w11's GSW checks at render-stream/13 (W13c, protocol/render-stream-13.md "As built
// (W13c)"), judged on the GSW-only legs gate8-w11-tool.ts gsw-legs writes under
// <run>/g8w11/gsw/<leg>/gsw from W13b's /13 captures and their /12 twins:
//
//   gsw-w13-replays          every /13 leg and /12 twin replays its whole recording (status ok, one
//                            applied transaction per recorded one), and no /13 leg failed
//                            predict-check (perf.json gsw.w13.predict_failures 0)
//   gsw-w13-dynamic-applied  at every applied /13 transaction the bodies GSW draws its dynamic meshes
//                            from (applied.json `dynamic_sha256`) equal the TypeScript resolved
//                            state of the /13 recording (render-stream-2.ts un-predicts it)
//   gsw-w13-equals-v12       each /13 leg's shots equal its /12 twin's at the same frames, pixel for
//                            pixel: the /13 accept path draws what /12's does
//   gsw-w13-mesh-band        gate5-mesh at /13 (mesh13) against the native receiver's /11 shots of
//                            the same frames (g8w11/mesh/receiver, gate 8's band classes): no
//                            pixel outside the band beyond what GSW's /11 mesh leg itself has, and
//                            mesh13 equals the /11 leg pixel for pixel
//   gsw-w13-no-predict-reset-caught  the decoder sabotage no-predict-reset (a full un-predicted
//                            against the history) on mesh13's full sink fails predict-check
//
// The live resync leg (predict-stale host, GSW at RS_RECEIVER_PROTOCOL=13) is g8w11c's
// (lib/gate8-w11-native-checks.ts).

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { check, type G8aCheck } from "./gate8-adopt-checks";
import { dynamicAppliedProblems, shotDiff } from "./gate8-w11-gsw-checks";
import { mmPairDiff } from "./gate7-gsw-g8-mm-checks";
import { classifyShot } from "./gate7b-adapters";
import { type ResolvedRecording, resolveRecording } from "./render-stream-2";

/** A /13 leg and its /12 twin. */
export const W13_TWINS: readonly [string, string][] = [
  ["scale13", "scale13-v12"],
  ["mesh13", "mesh13-v12"],
];
const CAPTURE: Record<string, [string, string, 12 | 13]> = {
  scale13: ["scale13/capture", "recording-patch.rs13", 13],
  "scale13-v12": ["scale13/v12/capture", "recording-patch.rs12", 12],
  mesh13: ["mesh13/capture", "recording.rs13", 13],
  "mesh13-v12": ["mesh13/v12/capture", "recording.rs12", 12],
};
export const W13_NO_RESET = "sabotage-no-predict-reset/mesh13";

interface Applied {
  status: string;
  failure: { seq: number | null; reason: string; detail: string } | null;
  transactions: { seq: number; frame: number; dynamic_sha256?: string }[];
}
interface W13Evidence {
  predict_failures: number;
  predict_dropped: number;
  no_predict_reset: boolean;
  history_units: number;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function runG8w13Gsw(g: string): Promise<G8aCheck[]> {
  const root = join(g, "gsw");
  const checks: G8aCheck[] = [];
  const web = (leg: string) => join(root, leg, "gsw");
  const applied = (leg: string) =>
    readJson<Applied>(join(web(leg), "applied.json"));
  const w13 = async (leg: string) =>
    (
      await readJson<{ gsw?: { w13?: W13Evidence } }>(
        join(web(leg), "perf.json"),
      )
    )?.gsw?.w13 ?? null;
  const frames =
    (await readJson<Record<string, Record<string, number>>>(
      join(root, "frames.json"),
    )) ?? {};
  const recs = new Map<string, ResolvedRecording | null>();
  const recOf = async (leg: string) => {
    if (!recs.has(leg)) {
      const [cap, sink, v] = CAPTURE[leg];
      const path = join(g, cap, sink);
      recs.set(
        leg,
        existsSync(path)
          ? resolveRecording(new Uint8Array(await readFile(path)), v)
          : null,
      );
    }
    return recs.get(leg) ?? null;
  };
  // Before W13b's captures exist (a gate 8 run without them) every check is not-run.
  if (
    !existsSync(join(g, "mesh13", "capture")) &&
    !existsSync(join(g, "scale13", "capture"))
  ) {
    return [
      "gsw-w13-replays",
      "gsw-w13-dynamic-applied",
      "gsw-w13-equals-v12",
      "gsw-w13-mesh-band",
      "gsw-w13-no-predict-reset-caught",
    ].map((id) => ({
      id,
      criterion: "W13c: GSW at render-stream/13 (g8w11's /13 captures)",
      passed: true,
      status: "not-run" as const,
      detail: "no /13 capture in this run",
      gating: false,
    }));
  }

  // gsw-w13-replays
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const leg of Object.keys(CAPTURE)) {
      const a = await applied(leg);
      const rec = await recOf(leg);
      if (!a || !rec) {
        problems.push(`${leg}: ${a ? "no capture" : "no applied.json"}`);
        continue;
      }
      if (a.status !== "ok")
        problems.push(
          `${leg}: ${a.failure?.reason}: ${a.failure?.detail?.slice(0, 160)}`,
        );
      else if (a.transactions.length !== rec.transactions.length)
        problems.push(
          `${leg}: ${a.transactions.length} applied of ${rec.transactions.length}`,
        );
      if (CAPTURE[leg][2] === 13) {
        const e = await w13(leg);
        if (!e) problems.push(`${leg}: no gsw.w13 evidence in perf.json`);
        else {
          if (e.predict_failures > 0)
            problems.push(
              `${leg}: ${e.predict_failures} predict-check failure(s)`,
            );
          notes.push(
            `${leg} ${a.transactions.length} txs, ${e.history_units} units held at the end`,
          );
        }
      }
    }
    checks.push(
      check(
        "gsw-w13-replays",
        "W13c: GSW replays every /13 capture (capture-scale's patch sink, gate5-mesh's full sink) and its /12 twin whole: status ok, every transaction applied, no predict-check failure",
        problems,
        notes.join("; "),
      ),
    );
  }

  // gsw-w13-dynamic-applied
  {
    const problems: string[] = [];
    const notes: string[] = [];
    let dynamic = 0;
    for (const leg of ["scale13", "mesh13"]) {
      const a = await applied(leg);
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
    if (dynamic === 0)
      problems.push("no transaction held a dynamic mesh (vacuous)");
    checks.push(
      check(
        "gsw-w13-dynamic-applied",
        "W13c: at every applied /13 transaction GSW draws each dynamic mesh from the body the TypeScript resolved state of the /13 recording names (body_sha256 of the un-predicted block)",
        problems,
        notes.join("; "),
      ),
    );
  }

  // gsw-w13-equals-v12
  const pairDiff = async (leg: string, twin: string) => {
    const out: { frame: string; px: number | null }[] = [];
    const fl = frames[leg] ?? {};
    const ft = frames[twin] ?? {};
    for (const [frame, seq] of Object.entries(fl)) {
      const tseq = ft[frame];
      if (tseq === undefined) continue;
      out.push({
        frame,
        px: await shotDiff(
          join(web(leg), "shots", `seq-${seq}.png`),
          join(web(twin), "shots", `seq-${tseq}.png`),
        ),
      });
    }
    return out;
  };
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of W13_TWINS) {
      const d = await pairDiff(leg, twin);
      if (d.length === 0)
        problems.push(`${leg}: no shared shot frames with ${twin}`);
      for (const { frame, px } of d)
        if (px === null) problems.push(`${leg}: frame ${frame}: shot missing`);
        else if (px > 0)
          problems.push(`${leg}: frame ${frame}: ${px} px differ from ${twin}`);
      notes.push(`${leg} ${d.length} frames`);
    }
    checks.push(
      check(
        "gsw-w13-equals-v12",
        "W13c: each /13 leg's shots equal its /12 twin's at the same frames, pixel for pixel",
        problems,
        notes.join("; "),
      ),
    );
  }

  // gsw-w13-mesh-band
  {
    const problems: string[] = [];
    const notes: string[] = [];
    const nativeFrames =
      (
        await readJson<Record<string, Record<string, number>>>(
          join(g, "native-frames.json"),
        )
      )?.["mesh/receiver"] ?? {};
    const fl = frames.mesh13 ?? {};
    const f11 = frames.mesh ?? {};
    let compared = 0;
    for (const [frame, seq] of Object.entries(fl)) {
      const nseq = nativeFrames[frame];
      const gseq = f11[frame];
      if (nseq === undefined || gseq === undefined) continue;
      const native = await decodePngRgba(
        join(g, "mesh", "receiver", "shots", `seq-${nseq}.png`),
      );
      const at13 = await decodePngRgba(
        join(web("mesh13"), "shots", `seq-${seq}.png`),
      );
      const at11 = await decodePngRgba(
        join(web("mesh"), "shots", `seq-${gseq}.png`),
      );
      if (!native || !at13 || !at11) {
        problems.push(
          `frame ${frame}: ${!native ? "native" : !at13 ? "mesh13" : "mesh"} shot missing`,
        );
        continue;
      }
      if (native.width !== at13.width || native.height !== at13.height) {
        problems.push(
          `frame ${frame}: mesh13 ${at13.width}x${at13.height}, native ${native.width}x${native.height}`,
        );
        continue;
      }
      compared++;
      const c13 = classifyShot(native.data, at13.data);
      const c11 = classifyShot(native.data, at11.data);
      if (c13.other > c11.other)
        problems.push(
          `frame ${frame}: ${c13.other} px outside the band (GSW /11: ${c11.other})`,
        );
      const same = await shotDiff(
        join(web("mesh13"), "shots", `seq-${seq}.png`),
        join(web("mesh"), "shots", `seq-${gseq}.png`),
      );
      if (same !== 0)
        problems.push(
          `frame ${frame}: mesh13 differs from GSW's /11 mesh leg by ${same} px`,
        );
      notes.push(
        `f${frame} identical ${c13.identical}, readback ${c13.readback}, delta1 ${c13.delta1}, other ${c13.other}`,
      );
    }
    if (compared === 0)
      problems.push(
        "no mesh13 frame shared with the native /11 mesh receiver's shots",
      );
    checks.push(
      check(
        "gsw-w13-mesh-band",
        "W13c: gate5-mesh at /13 (mesh13) within gate 8's band against the native receiver's shots of the same frames (no pixel outside it beyond GSW's /11 mesh leg's), and equal to that /11 GSW leg pixel for pixel",
        problems,
        notes.join("; "),
      ),
    );
  }

  // gsw-w13-no-predict-reset-caught
  {
    const id = "gsw-w13-no-predict-reset-caught";
    const criterion =
      "W13c: the decoder sabotage no-predict-reset (a full un-predicted against H1 and H2) on gate5-mesh's /13 full sink fails predict-check at the first full after units exist";
    if (existsSync(join(web(W13_NO_RESET), "skipped-by-tier.txt"))) {
      checks.push({
        id,
        criterion,
        passed: true,
        status: "not-run",
        detail: `skipped-by-tier: ${W13_NO_RESET}`,
        gating: false,
      });
    } else {
      const a = await applied(W13_NO_RESET);
      const problems: string[] | null = a ? [] : null;
      if (a && problems) {
        if (a.status === "ok") problems.push("the sabotaged replay ended ok");
        else if (a.failure?.reason !== "predict-check")
          problems.push(
            `failed ${a.failure?.reason} (expected predict-check): ${a.failure?.detail?.slice(0, 120)}`,
          );
      }
      checks.push(
        check(
          id,
          criterion,
          problems,
          a ? `${a.failure?.reason} at seq ${a.failure?.seq}` : "",
        ),
      );
    }
  }
  return checks;
}

interface LiveLeg {
  status: string;
  failure: { seq: number | null; reason: string; detail: string } | null;
  transactions: { seq: number; frame: number }[];
  live?: {
    coding?: { resyncs?: number };
    predict?: {
      resyncs?: number;
      predict_failures?: number;
      predict_dropped?: number;
    };
  };
}

/** The single receiver directory of a g8w11c leg (every directory but `host`). */
async function liveLegOf(root: string, leg: string) {
  const dir = join(root, leg);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir, { withFileTypes: true }).find(
    (e) => e.isDirectory() && e.name !== "host",
  )?.name;
  if (!name) return null;
  const summary = await readJson<{
    connections?: { predict?: { stale_seq?: number | null } }[];
  }>(join(dir, "host", "evidence", "live-summary.json"));
  return {
    applied: await readJson<LiveLeg>(join(dir, name, "applied.json")),
    finalShot: join(dir, name, "shots", "final.png"),
    staleSeq: summary?.connections?.[0]?.predict?.stale_seq ?? null,
  };
}

/**
 * W13c: g8w11c's GSW /13 resync legs (run-gate8.sh run_g8w11c_gsw13, GSW only):
 * - `gsw13-predict-resync`: under the host's predict-stale the GSW receiver fails predict-check,
 *   resyncs with reason coding, drops the patches before the full, ends ok, and its final shot
 *   equals the honest /13 leg's pixel for pixel (the pixel check);
 * - `gsw13-no-predict-reset-caught`: the receiver sabotage no-predict-reset fails that pixel
 *   check (the resync's full fails predict-check too, so the picture never catches up);
 * - `gsw13-zr-resync` (W13r): `gsw13-predict-resync`'s check under the host's zr-overrun (GSW
 *   fails zr-length).
 */
export async function runG8w11cGsw13(root: string): Promise<G8aCheck[]> {
  const checks: G8aCheck[] = [];
  const honestDir = join(root, "gsw13-honest");
  if (!existsSync(honestDir)) {
    return ["gsw13-predict-resync", "gsw13-no-predict-reset-caught", "gsw13-zr-resync"].map(
      (id) => ({
        id,
        criterion:
          "W13c: GSW's /13 resync legs (g8w11c, a browser receiver only)",
        passed: true,
        status: "not-run" as const,
        detail: "no browser receiver leg",
        gating: false,
      }),
    );
  }
  const honest = await liveLegOf(root, "gsw13-honest");
  const lastFrame = (a: LiveLeg | null | undefined) =>
    a?.transactions.at(-1)?.frame ?? null;
  // W13r: the host's zr-overrun is judged as predict-stale is (GSW fails zr-length instead).
  for (const [id, leg, what] of [
    ["gsw13-predict-resync", "gsw13-predict-stale", "W13c: under the host's predict-stale a coded GSW receiver at /13 fails predict-check"],
    ["gsw13-zr-resync", "gsw13-zr-overrun", "W13r: under the host's zr-overrun a coded GSW receiver at /13 fails zr-length"],
  ] as const) {
    const criterion = `${what}, resyncs (reason coding), drops the patches before the full, ends ok, and its final shot equals the honest /13 leg's pixel for pixel`;
    if (!existsSync(join(root, leg))) {
      checks.push({ id, criterion, passed: true, status: "not-run" as const, detail: `no ${leg} leg in this run`, gating: false });
      continue;
    }
    const v = await liveLegOf(root, leg);
    const problems: string[] | null = v && honest ? [] : null;
    let detail = "";
    if (v && honest && problems) {
      const a = v.applied;
      if (honest.applied?.status !== "ok")
        problems.push(
          `honest leg status ${honest.applied?.status}: ${honest.applied?.failure?.detail?.slice(0, 120)}`,
        );
      if ((honest.applied?.live?.predict?.resyncs ?? 0) !== 0)
        problems.push("the honest leg resynced on predict-check");
      if (a?.status !== "ok")
        problems.push(
          `status ${a?.status}: ${a?.failure?.reason} ${a?.failure?.detail?.slice(0, 120)}`,
        );
      if (v.staleSeq === null)
        problems.push("the host coded no patch stale (predict.stale_seq null)");
      const p = a?.live?.predict;
      if ((p?.resyncs ?? 0) < 1) problems.push("no predict-check resync");
      if ((a?.live?.coding?.resyncs ?? 0) < (p?.resyncs ?? 0))
        problems.push("a predict-check resync was not a coding resync");
      if (lastFrame(a) !== lastFrame(honest.applied))
        problems.push(
          `last applied frame ${lastFrame(a)}, honest ${lastFrame(honest.applied)}`,
        );
      const px = await shotDiff(v.finalShot, honest.finalShot);
      if (px === null) problems.push("a final shot is missing");
      else if (px > 0)
        problems.push(
          `the final shot differs from the honest leg's by ${px} px`,
        );
      detail = `stale seq ${v.staleSeq}, predict resyncs ${p?.resyncs}, dropped ${p?.predict_dropped}, last frame ${lastFrame(a)}, final shot diff ${px} px`;
    }
    checks.push(check(id, criterion, problems, detail));
  }
  {
    const id = "gsw13-no-predict-reset-caught";
    const criterion =
      "W13c: the receiver sabotage no-predict-reset (the resync's full un-predicted against the stale history) fails gsw13-predict-resync's pixel check: its final shot differs from the honest leg's";
    const leg = "gsw13-sabotage-no-predict-reset";
    if (existsSync(join(root, leg, "host", "skipped-by-tier.txt"))) {
      checks.push({
        id,
        criterion,
        passed: true,
        status: "not-run",
        detail: `skipped-by-tier: ${leg}`,
        gating: false,
      });
    } else {
      const v = await liveLegOf(root, leg);
      const problems: string[] | null = v && honest ? [] : null;
      let detail = "";
      if (v && honest && problems) {
        const px = await shotDiff(v.finalShot, honest.finalShot);
        const p = v.applied?.live?.predict;
        if (px === 0)
          problems.push(
            "the sabotaged final shot equals the honest one: the pixel check would pass",
          );
        detail = `final shot diff ${px === null ? "missing" : `${px} px`}, predict failures ${p?.predict_failures}, resyncs ${p?.resyncs}, last frame ${lastFrame(v.applied)} (honest ${lastFrame(honest.applied)}), status ${v.applied?.status}`;
      }
      checks.push(check(id, criterion, problems, detail));
    }
  }
  return checks;
}

/** W13c: `--set pt13`'s legs (<run>/g8pt/gsw13): the /13 leg, its /12 twin, the capture. */
const PT13: Record<string, [string, string, 12 | 13]> = {
  pump13: ["headless-pump13/capture", "recording.rs13", 13],
  "pump13-v12": ["headless-pump/capture", "recording.rs12", 12],
  shim13: ["headless-shim13/capture", "recording.rs13", 13],
  "shim13-v12": ["headless-shim/capture", "recording.rs12", 12],
};
const PT13_TWINS: readonly [string, string][] = [
  ["pump13", "pump13-v12"],
  ["shim13", "shim13-v12"],
];

/**
 * W13c: GSW at /13 on g8pt's headless /13 twins (gate8-w11-tool.ts --set pt13):
 * - `gsw-pt13-replays`: every leg replays whole (status ok, every transaction applied), no /13
 *   leg failed predict-check;
 * - `gsw-pt13-equals-v12`: the /13 legs' shots equal their /12 twins' pixel for pixel (multimesh
 *   buffers through mm_f32's prediction; particles beside it);
 * - `mm13-gsw-band`: pump13's shots at g8mm's settle frames against g8mm's unarmed reference,
 *   PM3's band (channel 1 outside the known-gap cells, lib/gate7-gsw-g8-mm-checks.ts mmPairDiff).
 */
export async function runG8pt13Gsw(
  out: string,
  mmPixels: {
    regions: Record<string, [number, number, number, number]>;
    known_gaps?: Record<string, { cells: string[] }>;
  } | null,
): Promise<G8aCheck[]> {
  const g = join(out, "g8pt");
  const root = join(g, "gsw13");
  const web = (leg: string) => join(root, leg, "gsw");
  const ids = ["gsw-pt13-replays", "gsw-pt13-equals-v12", "mm13-gsw-band"];
  if (
    !existsSync(join(g, "headless-pump13", "capture")) &&
    !existsSync(join(g, "headless-shim13", "capture"))
  )
    return ids.map((id) => ({
      id,
      criterion: "W13c: GSW at render-stream/13 on g8pt's headless /13 twins",
      passed: true,
      status: "not-run" as const,
      detail: "no /13 capture in this run",
      gating: false,
    }));
  const checks: G8aCheck[] = [];
  const frames =
    (await readJson<Record<string, Record<string, number>>>(
      join(root, "frames.json"),
    )) ?? {};
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, [cap, sink, v]] of Object.entries(PT13)) {
      const a = await readJson<Applied>(join(web(leg), "applied.json"));
      const path = join(g, cap, sink);
      if (!a || !existsSync(path)) {
        problems.push(`${leg}: ${a ? "no capture" : "no applied.json"}`);
        continue;
      }
      const rec = resolveRecording(new Uint8Array(await readFile(path)), v);
      if (a.status !== "ok")
        problems.push(
          `${leg}: ${a.failure?.reason}: ${a.failure?.detail?.slice(0, 160)}`,
        );
      else if (a.transactions.length !== rec.transactions.length)
        problems.push(
          `${leg}: ${a.transactions.length} applied of ${rec.transactions.length}`,
        );
      if (v === 13) {
        const e = (
          await readJson<{ gsw?: { w13?: W13Evidence } }>(
            join(web(leg), "perf.json"),
          )
        )?.gsw?.w13;
        if (!e) problems.push(`${leg}: no gsw.w13 evidence`);
        else if (e.predict_failures > 0)
          problems.push(
            `${leg}: ${e.predict_failures} predict-check failure(s)`,
          );
        else
          notes.push(
            `${leg} ${a.transactions.length} txs, ${e.history_units} units held at the end`,
          );
      }
    }
    checks.push(
      check(
        ids[0],
        "W13c: GSW replays g8pt's headless /13 captures (gate8-mm under the pump: multimesh buffers; gate8-pt under the particles shim) and their /12 twins whole, no predict-check failure",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const [leg, twin] of PT13_TWINS) {
      let n = 0;
      for (const [frame, seq] of Object.entries(frames[leg] ?? {})) {
        const tseq = frames[twin]?.[frame];
        if (tseq === undefined) continue;
        n++;
        const px = await shotDiff(
          join(web(leg), "shots", `seq-${seq}.png`),
          join(web(twin), "shots", `seq-${tseq}.png`),
        );
        if (px === null) problems.push(`${leg}: frame ${frame}: shot missing`);
        else if (px > 0)
          problems.push(`${leg}: frame ${frame}: ${px} px differ from ${twin}`);
      }
      if (n === 0) problems.push(`${leg}: no shared shot frames with ${twin}`);
      notes.push(`${leg} ${n} frames`);
    }
    checks.push(
      check(
        ids[1],
        "W13c: each g8pt /13 leg's shots equal its /12 twin's at the same frames, pixel for pixel",
        problems,
        notes.join("; "),
      ),
    );
  }
  {
    const id = ids[2];
    const criterion =
      "W13c: gate8-mm at /13 (pump13: every multimesh buffer through mm_f32's prediction) within PM3's band of g8mm's unarmed reference at each settle frame (and the frame before), outside the known-gap cells";
    const steps = (
      await readFile(join(out, "g8mm", "capture", "steps.jsonl"), "utf8").catch(
        () => "",
      )
    )
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { step: number; settle_frame: number });
    if (steps.length === 0 || !mmPixels) {
      checks.push({
        id,
        criterion,
        passed: true,
        status: "not-run",
        detail: "no g8mm reference in this run",
        gating: false,
      });
    } else {
      const skip = new Set(
        Object.values(mmPixels.known_gaps ?? {}).flatMap((x) => x.cells),
      );
      const problems: string[] = [];
      let pairs = 0;
      let delta1 = 0;
      for (const [frame, seq] of Object.entries(frames.pump13 ?? {})) {
        const f = Number(frame);
        const st = steps.find(
          (s) => s.settle_frame === f || s.settle_frame - 1 === f,
        );
        if (!st) continue;
        const ref =
          st.settle_frame === f
            ? `step-${st.step}.png`
            : `step-${st.step}-prev.png`;
        const a = await decodePngRgba(
          join(web("pump13"), "shots", `seq-${seq}.png`),
        );
        const b = await decodePngRgba(
          join(out, "g8mm", "reference", "shots", ref),
        );
        if (!a || !b) {
          problems.push(
            `frame ${f}: ${a ? `reference ${ref}` : "pump13 shot"} missing`,
          );
          continue;
        }
        const d = mmPairDiff(a, b, mmPixels.regions, skip);
        if (!d) {
          problems.push(
            `frame ${f}: ${a.width}x${a.height} against the reference's ${b.width}x${b.height}`,
          );
          continue;
        }
        pairs++;
        delta1 += d.delta1;
        const other = Object.entries(d.other);
        if (other.length > 0)
          problems.push(
            `frame ${f} (${ref}): beyond channel 1 in ${other.map(([c, n]) => `${c} ${n}`).join(", ")} (max ${d.max_other})`,
          );
      }
      if (pairs === 0)
        problems.push("no pump13 shot pairs with a reference shot");
      checks.push(
        check(
          id,
          criterion,
          problems,
          `${pairs} pairs, ${delta1} px at channel 1`,
        ),
      );
    }
  }
  return checks;
}
