#!/usr/bin/env -S pnpm exec tsx --conditions=development
// WX (results/p3/wx.md): the web export's file replay on a store bigger than its wasm heap.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/bench-web-store.ts --bundle <web bundle> --out <dir> \
//     --port <N> [--textures 144] [--size 2048] [--arms lazy,staged] [--timeout-s 1800] [--keep-input]
//
// A synthetic render-stream/6 file recording (scripts/test/rs2-test-encoder.ts) of `--textures`
// transactions: transaction k draws one full-viewport add_texture_rect of texture k+1, a fresh
// `--size`² RGBA8 image of one colour (k's own), and drops texture k. So the live set is one
// texture, while the store (`<out>/input/store/sha256/<hash>.grt`, one out-of-band payload per
// transaction) totals textures x size² x 4 bytes: 2.4 GB by default, past the template's 2 GiB
// wasm limit. Shots at the middle and the last seq.
//
// Each arm replays it in the web export through `gate7-tool.ts browser-receiver`'s own path
// (lib/gate7-live-legs.ts runBrowserReceiver, the pinned Chromium, a fresh profile):
//   lazy    RS_RECEIVER_WEB_STORE unset (WX's default): must pass every check below;
//   staged  GATE7_WEB_STORE=staged (the pre-WX up-front staging): must NOT complete (the store
//           does not fit; CG4's `Cannot enlarge memory` abort). It is the negative control.
// Checks on an arm that completes: exit 0, applied.json status ok, every transaction applied,
// one `directory` fetch row per transaction and their bytes equal to the store's, one upload per
// transaction, each shot's centre pixel is its texture's colour, and the page's peak wasm heap
// (timings.json wasm_heap_bytes; the heap never shrinks) is under half the store's bytes.
// Writes <out>/summary.json and exits non-zero unless lazy passes and staged fails.
//
// The input is ignored build output (2.4 GB): deleted after the run unless --keep-input.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { decodePngRgba } from "./lib/gate-minus1-checks";
import {
  bundleBuildSha256,
  requireRustBundle,
  runBrowserReceiver,
} from "./lib/gate7-live-legs";
import {
  encodeRs2Recording,
  hueStrip,
  sha256Hex,
  type TItem,
  type TState,
  type TTexture,
  texturePayload,
} from "./test/rs2-test-encoder";
import { GATE0_HOOKS } from "./lib/gate0-checks";

type Arm = "lazy" | "staged";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Texture k's colour (RGB, alpha 255): unique per k for k < 2^16. */
function colourOf(k: number): [number, number, number] {
  return [(k * 37) & 255, (k >> 8) & 255 | 64, 255 - ((k * 11) & 127)];
}

interface Input {
  recording: string;
  store: string;
  storeBytes: number;
  transactions: number;
  shotSeqs: number[];
}

async function makeInput(dir: string, n: number, size: number): Promise<Input> {
  const store = join(dir, "store");
  const flat = join(store, "sha256");
  await mkdir(flat, { recursive: true });
  const states: TState[] = [];
  let storeBytes = 0;
  for (let k = 1; k <= n; k++) {
    const [r, g, b] = colourOf(k);
    const data = Buffer.alloc(size * size * 4);
    data.fill(Buffer.from([r, g, b, 255]));
    const payload = texturePayload("RGBA8", size, size, false, data);
    const hash = sha256Hex(payload);
    writeFileSync(join(flat, `${hash}.grt`), payload);
    storeBytes += payload.length;
    const texture: TTexture = {
      ...hueStrip(1),
      id: k + 1,
      hash,
      width: size,
      height: size,
      payload_bytes: payload.length,
    };
    const item: TItem = {
      id: 1,
      parent: { kind: "canvas", id: 1 },
      children: [],
      visible: true,
      draw_index: 1,
      z_index: 0,
      visibility_layer: 1,
      content_version: k,
      xform: [1, 0, 0, 1, 0, 0],
      modulate: [1, 1, 1, 1],
      self_modulate: [1, 1, 1, 1],
      commands: [
        {
          op: "add_texture_rect",
          tex: k + 1,
          rect: [0, 0, 640, 360],
          modulate: [1, 1, 1, 1],
        },
      ],
    };
    states.push({
      frame: k + 1,
      failures: [],
      unsupported: [],
      canvases: [{ id: 1, items: [1], xform: [1, 0, 0, 1, 0, 0] }],
      items: [item],
      textures: [hueStrip(1), texture],
    });
  }
  const recording = join(dir, "recording.rs2");
  writeFileSync(
    recording,
    encodeRs2Recording(states, { encoding: "patch", hooksPlanned: [...GATE0_HOOKS] }),
  );
  return {
    recording,
    store,
    storeBytes,
    transactions: n,
    shotSeqs: [Math.ceil(n / 2), n],
  };
}

interface ArmResult {
  arm: Arm;
  exit: number;
  status: string | null;
  failure: unknown;
  wall_ms: number;
  wasm_heap_bytes: number | null;
  transactions: number;
  fetch_rows: number;
  fetched_bytes: number;
  uploads: number;
  shots: { seq: number; centre: number[] | null; expected: number[] }[];
  web_store_line: string | null;
  oom: boolean;
  problems: string[];
  passed: boolean;
}

async function runArm(
  arm: Arm,
  input: Input,
  out: string,
  bundle: string,
  port: number,
  timeoutMs: number,
): Promise<ArmResult> {
  const dir = join(out, arm);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, "native-env.txt"),
    [
      `RS_RECEIVER_RECORDING=${input.recording}`,
      `RS_RECEIVER_OUT=${join(dir, "applied.json")}`,
      `RS_RECEIVER_SHOT_SEQS=${input.shotSeqs.join(",")}`,
      `RS_RECEIVER_STORE_DIR=${input.store}`,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "native-argv.txt"),
    [
      join(homedir(), ".cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"),
      "--path",
      resolve(import.meta.dirname, "../receiver"),
      "--resolution",
      "640x360",
      "",
    ].join("\n"),
  );
  if (arm === "staged") process.env.GATE7_WEB_STORE = "staged";
  else delete process.env.GATE7_WEB_STORE;
  const t0 = Date.now();
  const exit = await runBrowserReceiver(
    {
      kind: "web",
      bundleDir: bundle,
      staticRoot: out,
      buildSha256: bundleBuildSha256(bundle, "web"),
    },
    { dir, port, timeoutMs },
  );
  const wall = Date.now() - t0;
  delete process.env.GATE7_WEB_STORE;
  const read = async <T>(p: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(p, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const applied = await read<{
    status: string;
    failure: unknown;
    transactions: unknown[] | null;
    fetches: { source: string; bytes: number; verified: boolean }[] | null;
    uploads: { op: string }[] | null;
    shots: { seq: number; path: string }[];
  }>(join(dir, "applied.json"));
  const timings = await read<{ wasm_heap_bytes?: number | null }>(
    join(dir, "timings.json"),
  );
  const stdout = await readFile(join(dir, "stdout.log"), "utf8").catch(() => "");
  const consoleLog = await readFile(join(dir, "console.jsonl"), "utf8").catch(
    () => "",
  );
  const fetches = applied?.fetches ?? [];
  const uploads = (applied?.uploads ?? []).filter((u) => u.op !== "placeholder");
  const shots: ArmResult["shots"] = [];
  for (const seq of input.shotSeqs) {
    const [r, g, b] = colourOf(seq);
    const png = await decodePngRgba(join(dir, "shots", `seq-${seq}.png`));
    const p = png ? (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4 : 0;
    shots.push({
      seq,
      centre: png ? [...png.data.slice(p, p + 4)] : null,
      expected: [r, g, b, 255],
    });
  }
  const result: ArmResult = {
    arm,
    exit,
    status: applied?.status ?? null,
    failure: applied?.failure ?? null,
    wall_ms: wall,
    wasm_heap_bytes: timings?.wasm_heap_bytes ?? null,
    transactions: applied?.transactions?.length ?? 0,
    fetch_rows: fetches.length,
    fetched_bytes: fetches.reduce((n, f) => n + f.bytes, 0),
    uploads: uploads.length,
    shots,
    web_store_line:
      stdout.split("\n").find((l) => l.includes("[receiver] web store:")) ?? null,
    oom: /Cannot enlarge memory|out of memory|OOM/i.test(consoleLog + stdout),
    problems: [],
    passed: false,
  };
  const pr = result.problems;
  if (exit !== 0) pr.push(`exit ${exit}`);
  if (result.status !== "ok") pr.push(`status ${result.status}`);
  if (result.transactions !== input.transactions)
    pr.push(`${result.transactions} transactions applied, ${input.transactions} recorded`);
  if (result.fetch_rows !== input.transactions || fetches.some((f) => f.source !== "directory" || !f.verified))
    pr.push(`${result.fetch_rows} fetch rows (want ${input.transactions} verified directory rows)`);
  if (result.fetched_bytes !== input.storeBytes)
    pr.push(`fetched ${result.fetched_bytes} bytes, the store holds ${input.storeBytes}`);
  if (result.uploads !== input.transactions)
    pr.push(`${result.uploads} uploads, want ${input.transactions}`);
  for (const s of shots)
    if (!s.centre || s.centre.some((v, i) => Math.abs(v - s.expected[i]) > 1))
      pr.push(`shot seq ${s.seq}: centre ${JSON.stringify(s.centre)}, want ${JSON.stringify(s.expected)}`);
  if (result.wasm_heap_bytes === null || result.wasm_heap_bytes >= input.storeBytes / 2)
    pr.push(`peak wasm heap ${result.wasm_heap_bytes} is not under half the store (${input.storeBytes} bytes)`);
  result.passed = pr.length === 0;
  return result;
}

async function main(): Promise<void> {
  const bundle = resolve(arg("--bundle") ?? "");
  const out = resolve(arg("--out") ?? "");
  const port = Number(arg("--port"));
  if (!arg("--bundle") || !arg("--out") || !Number.isInteger(port))
    throw new Error("bench-web-store: needs --bundle, --out and --port");
  requireRustBundle("web", bundle);
  const n = Number(arg("--textures") ?? 144);
  const size = Number(arg("--size") ?? 2048);
  const arms = (arg("--arms") ?? "lazy,staged").split(",") as Arm[];
  const timeoutMs = 1000 * Number(arg("--timeout-s") ?? 1800);
  await mkdir(out, { recursive: true });
  const inputDir = join(out, "input");
  rmSync(inputDir, { recursive: true, force: true });
  const input = await makeInput(inputDir, n, size);
  console.log(
    `bench-web-store: ${n} transactions, store ${input.storeBytes} bytes (${(input.storeBytes / 2 ** 30).toFixed(2)} GiB), recording ${input.recording}`,
  );
  const results: ArmResult[] = [];
  try {
    for (const [i, arm] of arms.entries()) {
      const r = await runArm(arm, input, out, bundle, port + i, timeoutMs);
      console.log(
        `bench-web-store: ${arm}: ${r.passed ? "completed, every check passed" : `not passed (${r.problems.join("; ")})`}; heap ${r.wasm_heap_bytes}, ${r.wall_ms} ms${r.oom ? ", OOM in the console" : ""}`,
      );
      results.push(r);
    }
  } finally {
    if (!process.argv.includes("--keep-input"))
      rmSync(inputDir, { recursive: true, force: true });
  }
  const lazy = results.find((r) => r.arm === "lazy");
  const staged = results.find((r) => r.arm === "staged");
  const verdict = {
    lazy_passes: lazy ? lazy.passed : null,
    staged_fails: staged ? !staged.passed : null,
  };
  const passed = verdict.lazy_passes !== false && verdict.staged_fails !== false;
  await writeFile(
    join(out, "summary.json"),
    `${JSON.stringify(
      {
        schema: "render-stream-wx-web-store-bench/1",
        textures: n,
        size,
        store_bytes: input.storeBytes,
        wasm_limit_bytes: 2 ** 31,
        bundle_build_sha256: bundleBuildSha256(bundle, "web"),
        verdict,
        passed,
        arms: results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`bench-web-store: ${passed ? "PASS" : "FAIL"} (${JSON.stringify(verdict)}); ${join(out, "summary.json")}`);
  process.exit(passed ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
