#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7x correctness checks over a gate7-bench.ts run of the Rust arm (gate7-design.md "G7x" R1).
//
//   gate7x-checks.ts --run <gate7-bench --out dir> [--reference <dir of step-<k>.png>] [--expect-fail]
//                    [--scene-native <native receiver dir>]
//
// Reads every Rust page's raw JSON (`<run>/evidence/<nonce>/bench-<input>-<arm>.json`) and, for
// pace-patch, its shots (`shot-pace-patch-f<frame>.rgba`, W×H×4 rows top-down, the RGB10_A2 target
// read back), which it converts to PNG beside them and checks with gate7d-checks.ts's own
// `shotChecks`: 0 px against the model frames synthesized from fixtures/gate7-pace/expected.json,
// and 0 px against the native rendered reference when `--reference` names G7d's pace reference
// shots. Also, per page: `draw-count-parity` (no frame whose executed draw calls differ from its
// lowered draws minus typed skips minus merges) and `record-digest-complete` (no accepted record
// left without its digest before evidence was written).
// Exit 0 when every check passes; with --expect-fail (a sabotage run), exit 0 when at least one
// fails and print which. `--scene-native` (report-only: G7a and G7g own those pixels) compares the
// Rust arm's scene-patch shots with the native rendered receiver's shots of the same seqs
// (scripts/run-g7x-scene-native.sh), per region of fixtures/gate6-scene/expected.json, and writes
// `<run>/scene-vs-native.json`; it never changes the exit code.

import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "../../../packages/test-harness/node_modules/sharp/lib/index.js";
import { loadRecording } from "./lib/gate0-checks";
import {
  type Gate7Check,
  PACE_EXPECTED_PATH,
  type PaceExpected,
  shotChecks,
} from "./lib/gate7d-checks";

interface Args {
  run: string;
  reference: string | null;
  expectFail: boolean;
  sceneNative: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    run: "",
    reference: null,
    expectFail: false,
    sceneNative: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = () => argv[++i] ?? "";
    if (argv[i] === "--run") a.run = v();
    else if (argv[i] === "--reference") a.reference = v();
    else if (argv[i] === "--expect-fail") a.expectFail = true;
    else if (argv[i] === "--scene-native") a.sceneNative = v();
    else if (argv[i] !== "--") throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.run) throw new Error("--run is required");
  return a;
}

interface RsRepeat {
  warmup: boolean;
  error: string | null;
  parity_violations: number;
  digest_pending: number;
  shots: { frame: number; seq: number; path: string }[];
  samples: { kind: string }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const checks: Gate7Check[] = [];
  const evidence = join(args.run, "evidence");
  const nonces = existsSync(evidence) ? readdirSync(evidence) : [];
  const e = JSON.parse(
    await readFile(PACE_EXPECTED_PATH, "utf8"),
  ) as PaceExpected;
  for (const nonce of nonces) {
    const dir = join(evidence, nonce);
    for (const file of readdirSync(dir).filter((f) =>
      /^bench-.*-gsw-rs(-inline)?\.json$/.test(f),
    )) {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as {
        arm: string;
        input: { name: string };
        results: RsRepeat[];
      };
      const label = `${raw.input.name}-${raw.arm}`;
      const measured = raw.results.filter((r) => !r.warmup);
      checks.push({
        id: `${label}-ran`,
        ok: measured.length > 0 && measured.every((r) => !r.error),
        detail:
          measured.map((r) => r.error ?? "ok").join("; ") || "no measured run",
      });
      checks.push({
        id: `${label}-draw-count-parity`,
        ok: measured.every((r) => r.parity_violations === 0),
        detail: `${measured.reduce((n, r) => n + r.parity_violations, 0)} frame(s) whose executed calls differ from lowered - typed skips - merges, over ${measured.reduce((n, r) => n + r.samples.filter((s) => s.kind === "transaction").length, 0)} transactions`,
      });
      checks.push({
        id: `${label}-record-digest-complete`,
        ok: measured.every(
          (r) =>
            r.digest_pending === 0 &&
            !r.error?.startsWith("record-digest-complete"),
        ),
        detail: measured.map((r) => `${r.digest_pending} pending`).join("; "),
      });
      if (raw.input.name !== "pace-patch") continue;
      for (const r of measured) {
        if (r.shots.length === 0) continue;
        const shots: { step: number; frame: number; path: string }[] = [];
        for (const s of e.steps) {
          const shot = r.shots.find((x) => x.frame === s.frame);
          const png = join(dir, `pace-${raw.arm}-step-${s.step}.png`);
          if (shot) {
            const [w, h] = e.model.root_size;
            const bytes = await readFile(join(dir, shot.path));
            await sharp(bytes, { raw: { width: w, height: h, channels: 4 } })
              .png()
              .toFile(png);
          }
          shots.push({ step: s.step, frame: s.frame, path: png });
        }
        let reference: Map<number, Uint8Array> | null = null;
        if (args.reference) {
          reference = new Map();
          for (const s of e.steps) {
            const p = join(args.reference, `step-${s.step}.png`);
            if (!existsSync(p)) continue;
            const { data } = await sharp(p)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            reference.set(
              s.step,
              new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
            );
          }
        }
        checks.push(
          ...(await shotChecks(e, `pace-${raw.arm}`, shots, reference)),
        );
      }
    }
  }
  if (args.sceneNative) await sceneReport(args.run, args.sceneNative);
  for (const c of checks)
    console.log(
      `gate7x-checks: ${c.ok ? "PASS" : "FAIL"} ${c.id}: ${c.detail}`,
    );
  const failed = checks.filter((c) => !c.ok);
  if (checks.length === 0) {
    console.log("gate7x-checks: no Rust-arm page found");
    process.exitCode = 1;
  } else if (args.expectFail) {
    console.log(
      failed.length > 0
        ? `gate7x-checks: sabotage caught by ${failed.map((c) => c.id).join(", ")}`
        : "gate7x-checks: sabotage NOT caught",
    );
    process.exitCode = failed.length > 0 ? 0 : 1;
  } else {
    process.exitCode = failed.length > 0 ? 1 : 0;
  }
}

/** Report-only: Rust-arm scene shots against the native receiver's, per gate 6 region. */
async function sceneReport(run: string, nativeDir: string): Promise<void> {
  const expected = JSON.parse(
    await readFile(
      join(PACE_EXPECTED_PATH, "..", "..", "gate6-scene", "expected.json"),
      "utf8",
    ),
  ) as { regions: Record<string, [number, number, number, number]> };
  const seqs = (await readFile(join(nativeDir, "shot-seqs.txt"), "utf8"))
    .trim()
    .split(",")
    .map(Number);
  const evidence = join(run, "evidence");
  const shots = new Map<number, string>();
  for (const nonce of readdirSync(evidence)) {
    const f = join(evidence, nonce, "bench-scene-patch-gsw-rs.json");
    if (!existsSync(f)) continue;
    const raw = JSON.parse(await readFile(f, "utf8")) as {
      results: RsRepeat[];
    };
    for (const r of raw.results)
      for (const s of r.shots) shots.set(s.seq, join(evidence, nonce, s.path));
  }
  // gate6-scene's regions follow the root canvas (make_expected.py: "at steps 10 and 11 the root
  // canvas moves by (8, 4) and so do the regions"): offset each seq's boxes by its root canvas
  // origin (G7a: G7x's report used the step-0 boxes, which moved SM's and LE's pixels into "BG").
  const recording = await loadRecording(join(nativeDir, "recording.rs2"));
  const rootOrigin = (seq: number): [number, number] => {
    const t = recording.transactions.find((x) => x.meta.seq === seq);
    const root = t?.meta.canvases.find((c) => c.role === "root");
    return root ? [root.xform[4], root.xform[5]] : [0, 0];
  };
  const rows: unknown[] = [];
  for (const seq of seqs) {
    const [ox, oy] = rootOrigin(seq);
    const native = join(nativeDir, "shots", `seq-${seq}.png`);
    const mine = shots.get(seq);
    if (!mine || !existsSync(native)) {
      rows.push({ seq, missing: !mine ? "gsw" : "native" });
      continue;
    }
    const { data: n, info } = await sharp(native)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const g = await readFile(mine);
    const regions: Record<string, { px: number; max: number }> = {};
    const bump = (name: string, d: number) => {
      const r = regions[name] ?? { px: 0, max: 0 };
      if (d > 0) {
        r.px++;
        r.max = Math.max(r.max, d);
      }
      regions[name] = r;
    };
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const o = (y * info.width + x) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++)
          d = Math.max(d, Math.abs(n[o + c] - g[o + c]));
        const name =
          Object.entries(expected.regions).find(
            ([, b]) =>
              x >= b[0] + ox &&
              x < b[2] + ox &&
              y >= b[1] + oy &&
              y < b[3] + oy,
          )?.[0] ?? "BG";
        bump(name, d);
      }
    const differing = Object.fromEntries(
      Object.entries(regions).filter(([, r]) => r.px > 0),
    );
    rows.push({ seq, differing });
    console.log(
      `gate7x-checks: report scene-vs-native seq ${seq}: ${
        Object.entries(differing)
          .map(([k, r]) => `${k} ${r.px}px max ${r.max}`)
          .join(", ") || "0 px"
      }`,
    );
  }
  await writeFile(
    join(run, "scene-vs-native.json"),
    `${JSON.stringify({ schema: "render-stream-gate7x-scene-vs-native/1", report_only: true, rows }, null, 2)}\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
