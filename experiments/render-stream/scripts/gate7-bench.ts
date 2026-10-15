#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Gate 7 decode/apply microbench driver (G7d; protocol/gate7-design.md Q13e "The bench"). One
// command per receiver arm and environment, called by run-gate7.sh's g7-bench group (and directly
// by G7m):
//
//   gate7-bench.ts --arm native --inputs <inputs.json> --out <dir> --binary <template> \
//       --receiver-dir <receiver/>                                   # desktop native, headless
//   gate7-bench.ts --arm gsw --inputs <inputs.json> --out <dir>      # desktop Chromium (D9)
//   gate7-bench.ts --arm gsw --env device --device g31 --inputs <inputs.json> --out <dir> [--probes]
//   gate7-bench.ts --arm web ...    # `unavailable` until G7e lands the web export (see below)
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
//   web:    the web export of receiver/ (D5) needs G7e's export preset, shell and rs_config/rs_io
//           shims, which have not landed, so the arm writes `unavailable` with that reason and runs
//           nothing (G7m's web numbers wait for G7e, as Q13e's apply fallback foresees).
// Leg names (the g7-bench vocabulary): native-bench-<input>, ctl-bench-<input>-<gsw|web>,
// dev-bench-<input>-<gsw|web>-<device>. Each leg writes <out>/<leg>/summary.json; the arm writes
// <out>/<arm-env>.json. A harness refusal (browser-provenance, device-provenance,
// device-unavailable, device-orientation) is recorded as `harness-refused`, exit 3.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  arm: "native" | "gsw" | "web";
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
        if (arm !== "native" && arm !== "gsw" && arm !== "web")
          throw new HarnessUsageError(
            `--arm must be native, gsw or web (got ${arm})`,
          );
        a.arm = arm;
        break;
      }
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
  arm: Args["arm"],
  env: HarnessEnv,
  input: string,
  device: string | null,
): string {
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
  return site;
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
    for (const input of inputs) {
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
    if (args.arm === "web") {
      // D5/G7e: the web export arm needs export_presets.cfg, receiver/web/shell.html and the
      // rs_config/rs_io shims, none of which exist before G7e. Recorded, never faked.
      arm.status = "unavailable";
      arm.reason = "web-export-not-built";
      arm.detail =
        "G7e (web export: build, shims, gate 0) has not landed: no export preset, shell or rs_config/rs_io shim exists, so build-web-receiver.sh --bench has nothing to export. The web arm runs once G7e lands (Q13e apply fallback).";
      for (const input of inputs) {
        const leg = benchLegName(
          "web",
          args.env,
          input.name,
          args.device ?? null,
        );
        await mkdir(join(args.out, leg), { recursive: true });
        await writeFile(
          join(args.out, leg, "summary.json"),
          `${JSON.stringify({ schema: "render-stream-gate7-bench-leg/1", leg, status: "unavailable", reason: arm.reason, detail: arm.detail }, null, 2)}\n`,
        );
      }
      console.log(`gate7-bench: web arm unavailable: ${arm.detail}`);
    } else {
      const summaries =
        args.arm === "native"
          ? await runNativeArm(args, inputs)
          : await runGswArm(args, inputs);
      arm.status = "success";
      arm.legs = summaries.map((s) =>
        benchLegName(args.arm, args.env, s.input, args.device ?? null),
      );
    }
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
