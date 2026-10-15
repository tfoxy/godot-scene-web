#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 decode/apply microbench driver (G7d; protocol/gate7-design.md Q13e "The bench"). One
// command per receiver arm and environment, called by run-gate7.sh's g7-bench group (and directly
// by G7m):
//
//   gate7-bench.ts --arm native --inputs <inputs.json> --out <dir> --binary <template> \
//       --receiver-dir <receiver/>                                   # desktop native, headless
//   gate7-bench.ts --arm gsw --inputs <inputs.json> --out <dir>      # desktop Chromium (D9)
//   gate7-bench.ts --arm gsw --env device --device g31 --inputs <inputs.json> --out <dir> [--probes]
//   gate7-bench.ts --arm web --inputs <inputs.json> --out <dir>        # desktop Chromium, web export
//   gate7-bench.ts --arm web --env device --device g31 --inputs <inputs.json> --out <dir>
//   gate7-bench.ts --arm gsw-rs|gsw-rs-inline [--rs-build <dir>] ...  # G7x: rs-gsw-wasm (Q14c)
//   gate7-bench.ts --interleave gsw-ts,gsw-rs,gsw-rs-inline --rounds 5 ...  # G7x's bench protocol
// `gsw-ts` is the TypeScript arm (G7x renamed it); `gsw` stays its alias until G7a.
//
// Every arm replays each input of inputs.json (render-stream-gate7-bench-inputs/1) once as a warmup
// and then `--repeats` (5) times, one record per frame:
//   native: receiver.gd file mode (`--headless`, one record per _process, exactly G6c's replay) with
//           RS_RECEIVER_PERF_OUT and RS_RECEIVER_LOG=summary: rs_perf's decode_us and apply_us. The
//           warmup run fills a fresh cache; the repeats run warm on it.
//   gsw:    web/bench/ bundled by esbuild (platform browser), served cross-origin isolated by
//           browser-harness.ts's HarnessServer; decode/hash/validate/resolve per record per rAF.
//           Desktop: launchHarnessBrowser + checkBrowserProvenance (D9). Device: openHarnessDevice
//           + checkDeviceProvenance (D24, Q13b), the device sampler, the watchdog per repeat (an
//           invalid repeat re-runs the input once), and with --probes the Q13a/Q13b device probes.
//   web:    the G7e web export of receiver/ (build-web-receiver.sh, reused/cached by source sha256),
//           one fresh page per warmup/repeat at receiver.html?env=<base64url JSON>, the SAME file-mode
//           replay as native (RS_RECEIVER_RECORDING/_STORE_DIR mapped to same-origin URLs the harness
//           serves, RS_RECEIVER_OUT/_PERF_OUT in-memory paths RsIo PUTs to RS_RECEIVER_EVIDENCE_URL at
//           exit, Q4) rather than a second, embedded-recording build: G7e's HTTPClient source-fetch
//           path already generalizes to this, so no new export mode is needed. The canvas size must
//           equal the session's logical_size (a browser is never "headless", so receiver.gd's hard
//           viewport-mismatch check applies, unlike native/GSW) -- every bench input is the project's
//           640x360 default except gate6-hd's own 1920x1080 fixture (WEB_CANVAS_SIZE below). Device:
//           one self-contained rAF probe (the same web/bench/ page GSW uses, mode=probe) measures this
//           run's T_p for the decision rule, since the GDScript receiver reports no rAF timing itself.
// Leg names (the g7-bench vocabulary): native-bench-<input>, ctl-bench-<input>-<gsw|web>,
// dev-bench-<input>-<gsw|web>-<device>. Each leg writes <out>/<leg>/summary.json; the arm writes
// <out>/<arm-env>.json. A harness refusal (browser-provenance, device-provenance,
// device-unavailable, device-orientation) is recorded as `harness-refused`, exit 3.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  checkDeviceProvenance,
  type DeviceHarness,
  type DeviceId,
  type HarnessEnv,
  HarnessRefusal,
  HarnessServer,
  HarnessUsageError,
  launchHarnessBrowser,
  loadDeviceTable,
  openHarnessDevice,
  resolveDeviceSelection,
} from "./lib/browser-harness";
import { probeDeviceAdb } from "./lib/device-probes";
import { DeviceSampler } from "./lib/device-sampler";
import {
  type BenchInputSummary,
  decide,
  type GswBenchJson,
  type NativePerfJson,
  summarizeGswBench,
  summarizeNativeBench,
} from "./lib/gate7-bench-summary";
import { base64url } from "./lib/gate7-web-legs";
import {
  ARMS_7X,
  type Arm7x,
  judge,
  planInterleaved,
  type RoundResult,
  type RsBenchJson,
  summarizeRsPage,
  summarizeTsPage,
  tableRows,
} from "./lib/gate7x-bench";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(SCRIPT_DIR, "..", "web", "bench");

export interface BenchInput {
  name: string;
  recording: string;
  store: string | null;
  transactions: number | null;
  source: string;
}

interface Args {
  arm: "native" | "gsw" | "gsw-ts" | "gsw-rs" | "gsw-rs-inline" | "web";
  /** G7x: the arms of the interleaved rounds (empty: the single `arm`). */
  interleave: Arm7x[];
  rounds: number;
  /** G7x: the built rs-core output (scripts/build-rs-core.sh), for the Rust arms. */
  rsBuild: string;
  /** G7x: Rust-arm sabotages (drop-draws, stale-item-row, digest-skip, skip-payload-hash). */
  rsSabotage: string[];
  /** G7x: host frames whose RGB10_A2 target the Rust arm reads back (pace checks). */
  shotFrames: number[];
  /** G7x: transaction seqs to shoot likewise (the scene's settle seqs). */
  shotSeqs: number[];
  env: HarnessEnv;
  device: string | undefined;
  inputs: string;
  out: string;
  warmup: number;
  repeats: number;
  binary: string | undefined;
  receiverDir: string | undefined;
  probes: boolean;
  holdSeconds: number;
  adbBin: string | undefined;
  only: string[];
  /** gate7-design.md D31/G7o1; `gsw` only, ignored by `native` and `web` (GDScript stays inline). */
  recordDigest: "inline" | "deferred";
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    arm: "gsw",
    interleave: [],
    rounds: 5,
    rsBuild: join(
      SCRIPT_DIR,
      "..",
      "..",
      "..",
      "artifacts",
      "render-stream",
      "rs-core",
      "latest",
    ),
    rsSabotage: [],
    shotFrames: [],
    shotSeqs: [],
    env: "desktop",
    device: undefined,
    inputs: "",
    out: "",
    warmup: 1,
    repeats: 5,
    binary: undefined,
    receiverDir: undefined,
    probes: false,
    holdSeconds: 30,
    adbBin: undefined,
    only: [],
    recordDigest: "inline",
  };
  for (let i = 0; i < argv.length; i++) {
    const v = () => {
      const x = argv[++i];
      if (x === undefined)
        throw new HarnessUsageError(`${argv[i - 1]} needs a value`);
      return x;
    };
    switch (argv[i]) {
      case "--":
        break;
      case "--arm": {
        const arm = v();
        if (
          arm !== "native" &&
          arm !== "gsw" &&
          arm !== "gsw-ts" &&
          arm !== "gsw-rs" &&
          arm !== "gsw-rs-inline" &&
          arm !== "web"
        )
          throw new HarnessUsageError(
            `--arm must be native, gsw-ts (alias gsw), gsw-rs, gsw-rs-inline or web (got ${arm})`,
          );
        a.arm = arm;
        break;
      }
      case "--interleave": {
        const list = v()
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        for (const x of list)
          if (!(ARMS_7X as readonly string[]).includes(x))
            throw new HarnessUsageError(
              `--interleave takes ${ARMS_7X.join(",")} (got ${x})`,
            );
        a.interleave = list as Arm7x[];
        a.arm = "gsw-ts";
        break;
      }
      case "--rounds":
        a.rounds = Number(v());
        break;
      case "--rs-build":
        a.rsBuild = resolve(v());
        break;
      case "--rs-sabotage":
        a.rsSabotage = v()
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        break;
      case "--shot-frames":
        a.shotFrames = v().split(",").filter(Boolean).map(Number);
        break;
      case "--shot-seqs":
        a.shotSeqs = v().split(",").filter(Boolean).map(Number);
        break;
      case "--env": {
        const env = v();
        if (env !== "desktop" && env !== "device")
          throw new HarnessUsageError(
            `--env must be desktop or device (got ${env})`,
          );
        a.env = env;
        break;
      }
      case "--device":
        a.device = v();
        break;
      case "--inputs":
        a.inputs = resolve(v());
        break;
      case "--out":
        a.out = resolve(v());
        break;
      case "--warmup":
        a.warmup = Number(v());
        break;
      case "--repeats":
        a.repeats = Number(v());
        break;
      case "--binary":
        a.binary = resolve(v());
        break;
      case "--receiver-dir":
        a.receiverDir = resolve(v());
        break;
      case "--probes":
        a.probes = true;
        break;
      case "--hold-seconds":
        a.holdSeconds = Number(v());
        break;
      case "--adb":
        a.adbBin = v();
        break;
      case "--only":
        a.only = v()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--record-digest": {
        const rd = v();
        if (rd !== "inline" && rd !== "deferred")
          throw new HarnessUsageError(
            `--record-digest must be inline or deferred (got ${rd})`,
          );
        a.recordDigest = rd;
        break;
      }
      default:
        throw new HarnessUsageError(`unknown argument ${argv[i]}`);
    }
  }
  if (!a.inputs || !a.out)
    throw new HarnessUsageError("--inputs and --out are required");
  if (a.arm === "native" && a.env === "device")
    throw new HarnessUsageError(
      "the native arm runs on the desktop only (--env desktop)",
    );
  return a;
}

export function benchLegName(
  armIn: Args["arm"] | Arm7x,
  env: HarnessEnv,
  input: string,
  device: string | null,
): string {
  // G7x renamed the TypeScript arm gsw-ts; `gsw` is its alias and keeps G7d's leg names.
  const arm = armIn === "gsw-ts" ? "gsw" : armIn;
  if (arm === "native") return `native-bench-${input}`;
  return env === "device"
    ? `dev-bench-${input}-${arm}-${device}`
    : `ctl-bench-${input}-${arm}`;
}

function loadInputs(path: string, only: string[]): BenchInput[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    schema?: string;
    inputs?: BenchInput[];
  };
  if (parsed.schema !== "render-stream-gate7-bench-inputs/1" || !parsed.inputs)
    throw new HarnessUsageError(
      `${path} is not render-stream-gate7-bench-inputs/1`,
    );
  return parsed.inputs.filter(
    (i) => only.length === 0 || only.includes(i.name),
  );
}

// ------------------------------------------------------------------------------------------ native

function strippedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "DISPLAY" || k === "WAYLAND_DISPLAY" || /^(GRC|RS)_/.test(k))
      continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function runProcess(
  argv: string[],
  env: Record<string, string>,
  dir: string,
  timeoutMs: number,
): Promise<number | null> {
  mkdirSync(dir, { recursive: true });
  return new Promise((res) => {
    const child = spawn(argv[0], argv.slice(1), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => chunks.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", async (code) => {
      clearTimeout(timer);
      await writeFile(join(dir, "stdout.log"), Buffer.concat(chunks));
      await writeFile(join(dir, "exit-code.txt"), `${code ?? "null"}\n`);
      res(code);
    });
  });
}

async function runNativeArm(
  args: Args,
  inputs: BenchInput[],
): Promise<BenchInputSummary[]> {
  if (!args.binary || !args.receiverDir)
    throw new HarnessUsageError(
      "--arm native needs --binary and --receiver-dir",
    );
  const binary = args.binary;
  const receiverDir = args.receiverDir;
  const summaries: BenchInputSummary[] = [];
  for (const input of inputs) {
    const leg = benchLegName("native", "desktop", input.name, null);
    const legDir = join(args.out, leg);
    const cache = join(legDir, "cache");
    await rm(cache, { recursive: true, force: true });
    const perRepeat: {
      repeat: number;
      perf: NativePerfJson | null;
      exit: number | null;
    }[] = [];
    for (let r = 0; r < args.warmup + args.repeats; r++) {
      const dir = join(
        legDir,
        r < args.warmup ? `warmup-${r}` : `repeat-${r - args.warmup}`,
      );
      const env = strippedEnv({
        RS_RECEIVER_RECORDING: input.recording,
        RS_RECEIVER_OUT: join(dir, "applied.json"),
        RS_RECEIVER_CACHE_DIR: cache,
        RS_RECEIVER_CACHE_MODE: r === 0 ? "fresh" : "warm",
        RS_RECEIVER_PERF_OUT: join(dir, "perf.json"),
        RS_RECEIVER_LOG: "summary",
        ...(input.store ? { RS_RECEIVER_STORE_DIR: input.store } : {}),
      });
      const argv = [binary, "--headless", "--path", receiverDir];
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "argv.txt"), `${argv.join("\n")}\n`);
      await writeFile(
        join(dir, "env.txt"),
        `${Object.entries(env)
          .filter(([k]) => k.startsWith("RS_"))
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")}\n`,
      );
      const t0 = Date.now();
      const exit = await runProcess(argv, env, dir, 300_000);
      console.log(
        `gate7-bench: ${leg} ${r < args.warmup ? "warmup" : `repeat ${r - args.warmup}`} exit=${exit} ${Date.now() - t0} ms`,
      );
      if (r < args.warmup) continue;
      const perfPath = join(dir, "perf.json");
      perRepeat.push({
        repeat: r - args.warmup,
        perf: existsSync(perfPath)
          ? (JSON.parse(await readFile(perfPath, "utf8")) as NativePerfJson)
          : null,
        exit,
      });
    }
    const summary = summarizeNativeBench(input.name, perRepeat);
    await writeLegSummary(
      legDir,
      leg,
      summary,
      decide(summary, "desktop", null),
      {
        kind: "native",
        binary,
      },
    );
    summaries.push(summary);
  }
  return summaries;
}

// ------------------------------------------------------------------------------------------ gsw

async function buildSite(args: Args, inputs: BenchInput[]): Promise<string> {
  const site = join(args.out, "site");
  await mkdir(join(site, "inputs"), { recursive: true });
  copyFileSync(join(BENCH_DIR, "index.html"), join(site, "index.html"));
  const result = await build({
    entryPoints: [join(BENCH_DIR, "bench.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: join(site, "bench.js"),
    metafile: true,
    logLevel: "warning",
  });
  const nodeImports = Object.keys(result.metafile?.inputs ?? {}).filter((p) =>
    p.startsWith("node:"),
  );
  if (nodeImports.length > 0)
    throw new Error(
      `bench bundle pulls node: modules: ${nodeImports.join(", ")}`,
    );
  for (const input of inputs)
    copyFileSync(input.recording, join(site, "inputs", `${input.name}.rs2`));
  if (usesRustArm(args)) {
    // G7x: the Rust arm's page, its rs-gsw-wasm build, and each input's payload store (the
    // page prefetches it before its timed loop; Q14c's fetcher then copies each payload once).
    copyFileSync(join(BENCH_DIR, "rs.html"), join(site, "rs.html"));
    await build({
      entryPoints: [join(BENCH_DIR, "bench-rs.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      outfile: join(site, "bench-rs.js"),
      logLevel: "warning",
    });
    const wasmDir = join(args.rsBuild, "gsw-rs");
    if (!existsSync(join(wasmDir, "rs_gsw_wasm_bg.wasm")))
      throw new HarnessUsageError(
        `no rs-gsw-wasm build at ${wasmDir} (run scripts/build-rs-core.sh)`,
      );
    cpSync(wasmDir, join(site, "gsw-rs"), { recursive: true });
    for (const input of inputs)
      if (input.store)
        cpSync(input.store, join(site, "inputs", `${input.name}-store`), {
          recursive: true,
        });
  }
  return site;
}

function usesRustArm(args: Args): boolean {
  return (
    args.arm === "gsw-rs" ||
    args.arm === "gsw-rs-inline" ||
    args.interleave.some((a) => a !== "gsw-ts")
  );
}

/** G7x: the TypeScript (gsw-ts) or Rust (gsw-rs, gsw-rs-inline) page URL for one input. */
function pageUrl(
  args: Args,
  origin: string,
  nonce: string,
  input: BenchInput,
  arm: Arm7x,
  warmup: number,
  repeats: number,
): string {
  if (arm === "gsw-ts")
    return `${origin}/index.html?mode=bench&input=inputs/${input.name}.rs2&name=${input.name}&nonce=${nonce}&warmup=${warmup}&repeats=${repeats}&record-digest=${args.recordDigest}`;
  const q = new URLSearchParams({
    mode: "bench",
    arm,
    input: `inputs/${input.name}.rs2`,
    store: `inputs/${input.name}-store`,
    name: input.name,
    nonce,
    warmup: String(warmup),
    repeats: String(repeats),
  });
  if (args.rsSabotage.length) q.set("sabotage", args.rsSabotage.join(","));
  if (args.shotFrames.length) q.set("shot-frames", args.shotFrames.join(","));
  if (args.shotSeqs.length) q.set("shot-seqs", args.shotSeqs.join(","));
  return `${origin}/rs.html?${q.toString()}`;
}

/**
 * G7x's bench protocol (gate7-design.md "G7x"): per input, a warmup page per arm, then
 * `rounds` rounds of every arm, each on a fresh page (each page runs one in-page warmup pass,
 * then one measured pass). A single `--arm gsw-rs`/`gsw-rs-inline` run is one page with
 * `--warmup`/`--repeats`. Writes `<out>/g7x-bench.json` (every measured round and R2-R4).
 */
async function runRustProtocol(
  args: Args,
  inputs: BenchInput[],
  openPage: (url: string) => Promise<BenchPage>,
  origin: string,
  nonce: string,
  evidence: string,
  envLabel: string,
): Promise<void> {
  const arms: Arm7x[] =
    args.interleave.length > 0
      ? args.interleave
      : [args.arm === "gsw" ? "gsw-ts" : (args.arm as Arm7x)];
  const plan =
    args.interleave.length > 0
      ? planInterleaved(
          inputs.map((i) => i.name),
          arms,
          args.rounds,
        )
      : inputs.map((i) => ({ input: i.name, arm: arms[0], round: 1 }));
  const results: RoundResult[] = [];
  const pagesDir = join(args.out, "g7x-pages");
  await mkdir(pagesDir, { recursive: true });
  for (const step of plan) {
    const input = inputs.find((i) => i.name === step.input) as BenchInput;
    const single = args.interleave.length === 0;
    const warmup = single ? args.warmup : 1;
    const repeats = single ? args.repeats : step.round === 0 ? 0 : 1;
    let got: RoundResult[] = [];
    let t0 = Date.now();
    // The watchdog (Q13b): a measured page with an invalid repeat (hidden, throttled) is re-run
    // once, never read as slow; both attempts are kept.
    for (let attempt = 0; attempt < 2; attempt++) {
      const label = `${step.input} ${step.arm} ${step.round === 0 ? "warmup" : `round ${step.round}`}${attempt ? " (re-run)" : ""}`;
      t0 = Date.now();
      const page = await openPage(
        pageUrl(args, origin, nonce, input, step.arm, warmup, repeats),
      );
      try {
        await waitBench(page, 30 * 60_000, label);
      } finally {
        await page.close().catch(() => {});
      }
      const file =
        step.arm === "gsw-ts"
          ? `bench-${input.name}.json`
          : `bench-${input.name}-${step.arm}.json`;
      const raw = JSON.parse(
        await readFile(join(evidence, nonce, file), "utf8"),
      );
      await writeFile(
        join(
          pagesDir,
          `${input.name}-${step.arm}-r${step.round}${attempt ? "-rerun" : ""}.json`,
        ),
        JSON.stringify(raw),
      );
      got =
        step.arm === "gsw-ts"
          ? summarizeTsPage(raw, step.round)
          : summarizeRsPage(raw as RsBenchJson, step.round);
      if (step.round === 0 || got.every((g) => g.valid)) break;
      console.log(
        `gate7-bench: ${label}: invalid (${got.flatMap((g) => g.reasons).join("; ")}), re-running once`,
      );
    }
    const label = `${step.input} ${step.arm} ${step.round === 0 ? "warmup" : `round ${step.round}`}`;
    if (step.round === 0) continue;
    if (single) for (const [k, g] of got.entries()) g.round = k + 1;
    results.push(...got);
    for (const g of got)
      console.log(
        `gate7-bench: ${label}: ${g.valid ? "valid" : `INVALID (${g.reasons.join("; ")})`} T_p ${g.tp_ms?.toFixed(2)} ms; ${Object.entries(
          g.phases,
        )
          .map(
            ([k, v]) =>
              `${k.replace("_us", "")} ${(v.p50_us / 1000).toFixed(3)}/${(v.p95_us / 1000).toFixed(3)}`,
          )
          .join(" ")} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
      );
  }
  const rounds = args.interleave.length > 0 ? args.rounds : args.repeats;
  const judgements = args.interleave.length > 0 ? judge(results, rounds) : [];
  const slim = results.map(({ values: _values, ...rest }) => rest);
  await writeFile(
    join(args.out, `g7x-bench-${envLabel}.json`),
    `${JSON.stringify({ schema: "render-stream-gate7x-bench/1", env: envLabel, arms, rounds, results: slim, judgements, table: tableRows(results) }, null, 2)}\n`,
  );
  await writeFile(
    join(args.out, `g7x-bench-${envLabel}-values.json`),
    JSON.stringify(results),
  );
  for (const row of tableRows(results)) console.log(`gate7-bench: ${row}`);
  for (const j of judgements)
    console.log(
      `gate7-bench: ${j.rule} ${j.input}: ${j.pass ? "PASS" : "FAIL"}${j.required ? "" : " (stretch)"}: ${j.detail}`,
    );
}

interface BenchPage {
  evaluate<T>(expression: string): Promise<T>;
  close(): Promise<void>;
}

async function waitBench(
  page: BenchPage,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const state = await page
      .evaluate<{ state: string; detail: string } | null>(
        "window.__bench ?? null",
      )
      .catch(() => null);
    if (state) {
      if (state.detail !== last) {
        last = state.detail;
        console.log(`gate7-bench: ${label}: ${state.state}: ${state.detail}`);
      }
      if (state.state === "done") return;
      if (state.state === "error")
        throw new Error(`${label}: page error: ${state.detail}`);
    }
    if (Date.now() > deadline)
      throw new Error(
        `${label}: timed out after ${timeoutMs} ms (last: ${last})`,
      );
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function writeLegSummary(
  legDir: string,
  leg: string,
  summary: BenchInputSummary,
  decision: ReturnType<typeof decide>,
  provenance: unknown,
): Promise<void> {
  await mkdir(legDir, { recursive: true });
  await writeFile(
    join(legDir, "summary.json"),
    `${JSON.stringify({ schema: "render-stream-gate7-bench-leg/1", leg, status: "success", summary, decision, provenance }, null, 2)}\n`,
  );
  const fmt = (x: number | undefined) =>
    x === undefined ? "-" : (x / 1000).toFixed(3);
  const p = summary.phases;
  console.log(
    `gate7-bench: ${leg}: ${(
      [
        "decode",
        "hash",
        "validate",
        "resolve",
        "apply",
        "total",
        "evidence_hash",
      ] as const
    )
      .filter((k) => p[k])
      .map((k) => `${k} p50/p95 ${fmt(p[k]?.p50_us)}/${fmt(p[k]?.p95_us)} ms`)
      .join(", ")}; ${decision.verdict}: ${decision.detail}`,
  );
}

async function runGswArm(
  args: Args,
  inputs: BenchInput[],
): Promise<BenchInputSummary[]> {
  const table = loadDeviceTable();
  const sel = resolveDeviceSelection(args.env, args.device, table);
  const site = await buildSite(args, inputs);
  const nonce = randomBytes(8).toString("hex");
  const evidence = join(args.out, "evidence");
  const server = new HarnessServer({
    staticRoot: site,
    evidenceRoot: evidence,
    allowedLegNonces: [nonce],
    crossOriginIsolated: true,
  });
  server.enableWebSocketEcho("/echo");
  server.enableTicker("/tick");
  const { port, origin } = await server.start();
  const summaries: BenchInputSummary[] = [];
  let closeDriver: () => Promise<unknown> = async () => {};
  try {
    let openPage: (url: string) => Promise<BenchPage>;
    let provenance: unknown;
    let device: DeviceHarness | null = null;
    let sampler: DeviceSampler | null = null;
    if (sel.env === "desktop") {
      const launchArgs = [
        ...BROWSER_LAUNCH_ARGS,
        ...BACKGROUND_THROTTLING_ARGS,
      ];
      const launched = await launchHarnessBrowser();
      closeDriver = () => launched.browser.close();
      const context = await launched.browser.newContext({
        viewport: { width: 640, height: 360 },
      });
      const probe = await context.newPage();
      await probe.goto(`${origin}/index.html?mode=idle`);
      const prov = await checkBrowserProvenance(probe, launched, launchArgs, {
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
      });
      await probe.close();
      provenance = {
        kind: "browser-provenance",
        ...prov,
        processes: prov.processes.length,
      };
      if (!prov.ok)
        throw new HarnessRefusal("browser-provenance", prov.reasons.join("; "));
      openPage = async (url) => {
        const page = await context.newPage();
        await page.goto(url);
        return { evaluate: (e) => page.evaluate(e), close: () => page.close() };
      };
    } else {
      const entry = sel.entry;
      const id = sel.id as DeviceId;
      if (!entry) throw new HarnessUsageError("no device entry");
      if (
        entry.attendance === "operator-attended" &&
        process.env.RS_GATE7_OPERATOR_ATTENDED !== id
      )
        throw new HarnessRefusal(
          "device-unavailable",
          `${id} is operator-attended (D28): set RS_GATE7_OPERATOR_ATTENDED=${id} only with the user's go-ahead in this session`,
        );
      device = await openHarnessDevice({
        id,
        entry,
        serverPort: port,
        adbBin: args.adbBin,
        onProgress: (m) => console.log(`gate7-bench: device: ${m}`),
      });
      const harness = device;
      closeDriver = async () => {
        const settings = await harness.close();
        await writeFile(
          join(args.out, `session-settings-${id}.json`),
          `${JSON.stringify(settings, null, 2)}\n`,
        );
      };
      const probe = await harness.openPage(`${origin}/index.html?mode=idle`);
      const facts = await harness.facts(probe);
      await probe.close();
      const prov = checkDeviceProvenance(entry, facts);
      provenance = {
        kind: "device-provenance",
        ...prov,
        isolation: harness.browser.targets.isolation,
      };
      await writeFile(
        join(args.out, `device-provenance-${id}.json`),
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
      if (!prov.ok)
        throw new HarnessRefusal(
          prov.refusal ?? "device-provenance",
          prov.reasons.join("; "),
        );
      if (args.probes) {
        const adbProbes = await probeDeviceAdb(harness.browser.adb, id, entry);
        await writeFile(
          join(args.out, `device-adb-probes-${id}.json`),
          `${JSON.stringify(adbProbes, null, 2)}\n`,
        );
        const page = await harness.openPage(
          `${origin}/index.html?mode=probe&nonce=${nonce}&hold=${args.holdSeconds}`,
        );
        await waitBench(
          page,
          180_000 + args.holdSeconds * 1000,
          `probes-${id}`,
        );
        await page.close();
      }
      // Q13b "Samplers": the renderer and GPU PIDs come from CDP SystemInfo.getProcessInfo
      // (browser target) where the phone answers it (a device probe); else `pidof` (the browser
      // process only).
      const processInfo = await harness.browser.client
        .send<{ processInfo: { type: string; id: number }[] }>(
          "SystemInfo.getProcessInfo",
          {},
          { flat: true, timeoutMs: 10_000 },
        )
        .then((r) => ({ ok: true as const, processes: r.processInfo ?? [] }))
        .catch((e: Error) => ({ ok: false as const, error: e.message }));
      await writeFile(
        join(args.out, `device-cdp-processes-${id}.json`),
        `${JSON.stringify(processInfo, null, 2)}\n`,
      );
      const chromePackage = entry.chrome_package;
      sampler = new DeviceSampler(harness.browser.adb, {
        chromePackage,
        clusters: entry.cpu_clusters,
        pids: async () => {
          if (processInfo.ok) {
            const ids = processInfo.processes
              .filter(
                (p) =>
                  p.type === "renderer" ||
                  p.type === "GPU" ||
                  p.type === "browser",
              )
              .map((p) => p.id)
              .filter((pid) => pid > 0);
            if (ids.length > 0) return ids;
          }
          const text = await harness.browser.adb
            .shell(`pidof ${chromePackage}`)
            .catch(() => "");
          return text
            .trim()
            .split(/\s+/)
            .filter((x) => /^\d+$/.test(x))
            .map(Number);
        },
      });
      sampler.start();
      openPage = async (url) => {
        const page = await harness.openPage(url);
        return { evaluate: (e) => page.evaluate(e), close: () => page.close() };
      };
    }
    if (sel.env === "desktop" && args.probes) {
      const page = await openPage(
        `${origin}/index.html?mode=probe&nonce=${nonce}&hold=${args.holdSeconds}`,
      );
      await waitBench(
        page,
        180_000 + args.holdSeconds * 1000,
        "probes-desktop",
      );
      await page.close();
    }
    if (usesRustArm(args) || args.interleave.length > 0) {
      await runRustProtocol(
        args,
        inputs,
        openPage,
        origin,
        nonce,
        evidence,
        `${sel.env}${sel.id ? `-${sel.id}` : ""}`,
      );
    }
    for (const input of usesRustArm(args) || args.interleave.length > 0
      ? []
      : inputs) {
      const leg = benchLegName("gsw", sel.env, input.name, sel.id);
      const legDir = join(args.out, leg);
      let summary: BenchInputSummary | null = null;
      const attempts: BenchInputSummary[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `${origin}/index.html?mode=bench&input=inputs/${input.name}.rs2&name=${input.name}&nonce=${nonce}&warmup=${args.warmup}&repeats=${args.repeats}&record-digest=${args.recordDigest}`;
        const page = await openPage(url);
        try {
          await waitBench(
            page,
            30 * 60_000,
            `${leg}${attempt ? " (re-run)" : ""}`,
          );
        } finally {
          await page.close().catch(() => {});
        }
        const raw = JSON.parse(
          await readFile(
            join(evidence, nonce, `bench-${input.name}.json`),
            "utf8",
          ),
        ) as GswBenchJson;
        await mkdir(legDir, { recursive: true });
        await writeFile(
          join(legDir, attempt ? "raw-rerun.json" : "raw.json"),
          JSON.stringify(raw),
        );
        summary = summarizeGswBench(raw);
        attempts.push(summary);
        // The watchdog (Q13b): an invalid repeat is re-run, never read as slow.
        if (summary.repeats.every((r) => r.valid)) break;
        console.log(
          `gate7-bench: ${leg}: ${summary.repeats.filter((r) => !r.valid).length} invalid repeat(s), re-running once`,
        );
      }
      if (!summary) continue;
      if (attempts.length > 1)
        summary.notes.push(
          `re-run after an invalid repeat (first attempt: ${attempts[0].repeats
            .filter((r) => !r.valid)
            .map((r) => r.watchdog_reasons.join("; "))
            .join(" | ")})`,
        );
      await writeLegSummary(
        legDir,
        leg,
        summary,
        decide(summary, sel.env, summary.tp_ms),
        provenance,
      );
      summaries.push(summary);
    }
    if (sampler) {
      const timeline = await sampler.stop();
      await writeFile(
        join(args.out, `device-samples-${sel.id}.json`),
        `${JSON.stringify(timeline, null, 2)}\n`,
      );
    }
  } finally {
    await closeDriver().catch((e) => console.error(`gate7-bench: close: ${e}`));
    await server.stop();
  }
  return summaries;
}

// ------------------------------------------------------------------------------------------ web

// receiver.gd:771-775 (Q4 "Shell" item 6): a browser is never DisplayServer "headless", so the
// hard viewport-mismatch check applies there, unlike native/GSW -- the canvas must equal the
// session's logical_size. Every bench input but gate6-hd's own fixture (run-gate7.sh
// HD_FIXTURE_DIR, gate6-design.md D4: 1920x1080) replays at the receiver project's 640x360
// default.
const WEB_CANVAS_SIZE: Readonly<Record<string, [number, number]>> = {
  "hd-patch": [1920, 1080],
};
const DEFAULT_WEB_CANVAS: [number, number] = [640, 360];
const WEB_REPLAY_TIMEOUT_MS = 180_000;

/** build-web-receiver.sh (G7e, D5): reuses a cached bundle by the receiver/ source sha256, or
 * builds one (8 to 10 s). Called once per gate7-bench.ts invocation, not per repeat. */
function buildWebBundle(): { bundleDir: string; buildSha256: string } {
  const script = join(SCRIPT_DIR, "build-web-receiver.sh");
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`build-web-receiver.sh exited ${result.status ?? "null"}`);
  const bundleDir = result.stdout.trim().split("\n").filter(Boolean).pop();
  if (!bundleDir)
    throw new Error("build-web-receiver.sh printed no bundle directory");
  const manifest = JSON.parse(
    readFileSync(join(bundleDir, "build.json"), "utf8"),
  ) as { pck: { sha256: string } };
  return { bundleDir, buildSha256: manifest.pck.sha256 };
}

function ensureStaticLink(target: string, link: string): void {
  if (existsSync(link)) return;
  symlinkSync(target, link);
}

interface WebPageProbesJson {
  schema: string;
  raf: { tp_ms: number };
}

/**
 * Q13a/Q13b: the GDScript receiver reports no rAF timing of its own, so the device's T_p for the
 * decision rule comes from the same self-contained probe page the GSW arm uses (web/bench/,
 * mode=probe), read once per gate7-bench.ts invocation -- a property of this browser/device, not
 * of which receiver bundle is loaded. Returns null on any failure (desktop's early-signal verdict
 * does not need T_p; a device decision without it is then visibly "no measured T_p" rather than a
 * guessed budget).
 */
async function probeTpMs(
  origin: string,
  openPage: (url: string) => Promise<BenchPage>,
  server: HarnessServer,
  evidenceRoot: string,
): Promise<number | null> {
  const nonce = randomBytes(8).toString("hex");
  const dir = join(evidenceRoot, nonce);
  server.addLeg(nonce, dir);
  try {
    const page = await openPage(
      `${origin}/site/index.html?mode=probe&nonce=${nonce}&hold=0`,
    );
    try {
      await waitBench(page, 60_000, "web-tp-probe");
    } finally {
      await page.close().catch(() => {});
    }
    const raw = await readFile(join(dir, "page-probes.json"), "utf8").catch(
      () => null,
    );
    if (!raw) return null;
    return (JSON.parse(raw) as WebPageProbesJson).raf?.tp_ms ?? null;
  } catch (error) {
    console.error(`gate7-bench: web-tp-probe: ${error}`);
    return null;
  } finally {
    server.removeLeg(nonce);
  }
}

// Window.__rsShell is declared by lib/gate7-web-legs.ts (imported above); re-declaring it here
// with a narrower shape would conflict (TS2717), so waitWebExit only reads the fields it needs.

async function waitWebExit(
  page: BenchPage,
  timeoutMs: number,
): Promise<{ exit: number | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await page
      .evaluate<{ exit: { code: number } | null; error: string | null } | null>(
        "window.__rsShell ? { exit: window.__rsShell.exit, error: window.__rsShell.error } : null",
      )
      .catch(() => null);
    if (state?.exit) return { exit: state.exit.code, error: null };
    if (state?.error) return { exit: null, error: state.error };
    if (Date.now() > deadline) return { exit: null, error: "timed out" };
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The G7e web export of receiver/, replayed exactly as native's file mode (one record per
 * `_process`, RS_RECEIVER_PERF_OUT + RS_RECEIVER_LOG=summary -- the same GDScript, so the same
 * rs_perf.gd perf.json shape), but served over HTTP and run one fresh page per warmup/repeat
 * instead of one fresh process: RS_RECEIVER_RECORDING and RS_RECEIVER_STORE_DIR are same-origin
 * URLs the harness serves (Q4 rs_io.gd `prepare_sources`, already proven by G7e's gate 0 web
 * legs), and RS_RECEIVER_OUT/_PERF_OUT are in-memory paths RsIo PUTs to RS_RECEIVER_EVIDENCE_URL
 * at exit. No new "--bench" export or embedded-recording entry scene is needed: G7e's HTTPClient
 * source-fetch path already generalizes to this.
 */
async function runWebArm(
  args: Args,
  inputs: BenchInput[],
): Promise<BenchInputSummary[]> {
  const { bundleDir, buildSha256 } = buildWebBundle();
  const table = loadDeviceTable();
  const sel = resolveDeviceSelection(args.env, args.device, table);
  await mkdir(args.out, { recursive: true });
  ensureStaticLink(bundleDir, join(args.out, "web-bundle"));
  const assets = join(args.out, "web-assets");
  for (const input of inputs) {
    const dir = join(assets, input.name);
    await mkdir(dir, { recursive: true });
    copyFileSync(input.recording, join(dir, "recording.rs2"));
    if (input.store) ensureStaticLink(input.store, join(dir, "store"));
  }
  await buildSite(args, inputs); // reused only for the rAF probe page below (mode=probe)
  const evidence = join(args.out, "evidence");
  const server = new HarnessServer({
    staticRoot: args.out,
    evidenceRoot: evidence,
    allowedLegNonces: [],
  });
  server.enableWebSocketEcho("/echo");
  server.enableTicker("/tick");
  const { port, origin } = await server.start();
  const summaries: BenchInputSummary[] = [];
  let closeDriver: () => Promise<unknown> = async () => {};
  try {
    let openPage: (url: string) => Promise<BenchPage>;
    let provenance: unknown;
    let sampler: DeviceSampler | null = null;
    if (sel.env === "desktop") {
      const launchArgs = [
        ...BROWSER_LAUNCH_ARGS,
        ...BACKGROUND_THROTTLING_ARGS,
      ];
      const launched = await launchHarnessBrowser();
      closeDriver = () => launched.browser.close();
      const context = await launched.browser.newContext({
        viewport: { width: 640, height: 360 },
      });
      const probe = await context.newPage();
      await probe.goto(`${origin}/site/index.html?mode=idle`);
      const prov = await checkBrowserProvenance(probe, launched, launchArgs, {
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
      });
      await probe.close();
      provenance = {
        kind: "browser-provenance",
        ...prov,
        processes: prov.processes.length,
      };
      if (!prov.ok)
        throw new HarnessRefusal("browser-provenance", prov.reasons.join("; "));
      openPage = async (url) => {
        const page = await context.newPage();
        await page.goto(url);
        return { evaluate: (e) => page.evaluate(e), close: () => page.close() };
      };
    } else {
      const entry = sel.entry;
      const id = sel.id as DeviceId;
      if (!entry) throw new HarnessUsageError("no device entry");
      if (
        entry.attendance === "operator-attended" &&
        process.env.RS_GATE7_OPERATOR_ATTENDED !== id
      )
        throw new HarnessRefusal(
          "device-unavailable",
          `${id} is operator-attended (D28): set RS_GATE7_OPERATOR_ATTENDED=${id} only with the user's go-ahead in this session`,
        );
      const device = await openHarnessDevice({
        id,
        entry,
        serverPort: port,
        adbBin: args.adbBin,
        onProgress: (m) => console.log(`gate7-bench: device: ${m}`),
      });
      closeDriver = async () => {
        const settings = await device.close();
        await writeFile(
          join(args.out, `session-settings-${id}-web.json`),
          `${JSON.stringify(settings, null, 2)}\n`,
        );
      };
      const probe = await device.openPage(
        `${origin}/site/index.html?mode=idle`,
      );
      const facts = await device.facts(probe);
      await probe.close();
      const prov = checkDeviceProvenance(entry, facts);
      provenance = {
        kind: "device-provenance",
        ...prov,
        isolation: device.browser.targets.isolation,
      };
      await writeFile(
        join(args.out, `device-provenance-${id}-web.json`),
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
      if (!prov.ok)
        throw new HarnessRefusal(
          prov.refusal ?? "device-provenance",
          prov.reasons.join("; "),
        );
      const processInfo = await device.browser.client
        .send<{ processInfo: { type: string; id: number }[] }>(
          "SystemInfo.getProcessInfo",
          {},
          { flat: true, timeoutMs: 10_000 },
        )
        .then((r) => ({ ok: true as const, processes: r.processInfo ?? [] }))
        .catch((e: Error) => ({ ok: false as const, error: e.message }));
      await writeFile(
        join(args.out, `device-cdp-processes-${id}-web.json`),
        `${JSON.stringify(processInfo, null, 2)}\n`,
      );
      const chromePackage = entry.chrome_package;
      sampler = new DeviceSampler(device.browser.adb, {
        chromePackage,
        clusters: entry.cpu_clusters,
        pids: async () => {
          if (processInfo.ok) {
            const ids = processInfo.processes
              .filter(
                (p) =>
                  p.type === "renderer" ||
                  p.type === "GPU" ||
                  p.type === "browser",
              )
              .map((p) => p.id)
              .filter((pid) => pid > 0);
            if (ids.length > 0) return ids;
          }
          const text = await device.browser.adb
            .shell(`pidof ${chromePackage}`)
            .catch(() => "");
          return text
            .trim()
            .split(/\s+/)
            .filter((x) => /^\d+$/.test(x))
            .map(Number);
        },
      });
      sampler.start();
      openPage = async (url) => {
        const page = await device.openPage(url);
        return { evaluate: (e) => page.evaluate(e), close: () => page.close() };
      };
    }
    const tpMs =
      sel.env === "device"
        ? await probeTpMs(origin, openPage, server, evidence)
        : null;
    for (const input of inputs) {
      const leg = benchLegName("web", sel.env, input.name, sel.id);
      const legDir = join(args.out, leg);
      const [w, h] = WEB_CANVAS_SIZE[input.name] ?? DEFAULT_WEB_CANVAS;
      const perRepeat: {
        repeat: number;
        perf: NativePerfJson | null;
        exit: number | null;
      }[] = [];
      for (let r = 0; r < args.warmup + args.repeats; r++) {
        const dir = join(
          legDir,
          r < args.warmup ? `warmup-${r}` : `repeat-${r - args.warmup}`,
        );
        await mkdir(dir, { recursive: true });
        const nonce = randomBytes(8).toString("hex");
        server.addLeg(nonce, dir);
        const env: Record<string, string> = {
          RS_RECEIVER_RECORDING: `/web-assets/${input.name}/recording.rs2`,
          RS_RECEIVER_OUT: "/out/applied.json",
          RS_RECEIVER_PERF_OUT: "/out/perf.json",
          RS_RECEIVER_LOG: "summary",
          RS_RECEIVER_EVIDENCE_URL: `/evidence/${nonce}`,
          RS_RECEIVER_BUILD_SHA256: buildSha256,
          ...(input.store
            ? { RS_RECEIVER_STORE_DIR: `/web-assets/${input.name}/store` }
            : {}),
        };
        const pageConfig = {
          env,
          engine_args: [] as string[],
          canvas: [w, h] as [number, number],
          sabotage: null as string | null,
        };
        await writeFile(
          join(dir, "page-config.json"),
          `${JSON.stringify(pageConfig, null, 2)}\n`,
        );
        const url = `${origin}/web-bundle/receiver.html?env=${base64url(JSON.stringify(pageConfig))}`;
        const t0 = Date.now();
        const page = await openPage(url);
        let result: { exit: number | null; error: string | null };
        try {
          result = await waitWebExit(page, WEB_REPLAY_TIMEOUT_MS);
        } finally {
          await page.close().catch(() => {});
        }
        server.removeLeg(nonce);
        console.log(
          `gate7-bench: ${leg} ${r < args.warmup ? "warmup" : `repeat ${r - args.warmup}`} exit=${result.exit} ${result.error ? `error=${result.error} ` : ""}${Date.now() - t0} ms`,
        );
        if (r < args.warmup) continue;
        const perfPath = join(dir, "perf.json");
        perRepeat.push({
          repeat: r - args.warmup,
          perf: existsSync(perfPath)
            ? (JSON.parse(await readFile(perfPath, "utf8")) as NativePerfJson)
            : null,
          exit: result.exit,
        });
      }
      const summary = summarizeNativeBench(input.name, perRepeat, "web");
      await writeLegSummary(
        legDir,
        leg,
        summary,
        decide(summary, sel.env, tpMs),
        provenance,
      );
      summaries.push(summary);
    }
    if (sampler) {
      const timeline = await sampler.stop();
      await writeFile(
        join(args.out, `device-samples-${sel.id}-web.json`),
        `${JSON.stringify(timeline, null, 2)}\n`,
      );
    }
  } finally {
    await closeDriver().catch((e) => console.error(`gate7-bench: close: ${e}`));
    await server.stop();
  }
  return summaries;
}

// ------------------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const inputs = loadInputs(args.inputs, args.only);
  const armLabel = `${args.arm}-${args.env}${args.device ? `-${args.device}` : ""}`;
  const arm: Record<string, unknown> = {
    schema: "render-stream-gate7-bench-arm/1",
    arm: args.arm,
    env: args.env,
    device: args.device ?? null,
    inputs: inputs.map((i) => i.name),
    warmup: args.warmup,
    repeats: args.repeats,
    // D31/G7o1; meaningful for `gsw` only -- native and web stay inline (D31).
    record_digest: args.recordDigest,
    started_at: new Date().toISOString(),
  };
  try {
    const summaries =
      args.arm === "native"
        ? await runNativeArm(args, inputs)
        : args.arm === "web"
          ? await runWebArm(args, inputs)
          : await runGswArm(args, inputs);
    arm.status = "success";
    arm.legs = summaries.map((s) =>
      benchLegName(args.arm, args.env, s.input, args.device ?? null),
    );
  } catch (error) {
    if (error instanceof HarnessUsageError) throw error;
    if (error instanceof HarnessRefusal) {
      arm.status = "harness-refused";
      arm.reason = error.reason;
      arm.detail = error.detail;
      console.error(
        `gate7-bench: harness-refused: ${error.reason}: ${error.detail}`,
      );
      process.exitCode = 3;
    } else {
      arm.status = "error";
      arm.detail = error instanceof Error ? error.message : String(error);
      console.error(error);
      process.exitCode = 1;
    }
  }
  arm.finished_at = new Date().toISOString();
  await writeFile(
    join(args.out, `${armLabel}.json`),
    `${JSON.stringify(arm, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    if (error instanceof HarnessUsageError) {
      console.error(`gate7-bench: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
