import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evaluateGate, formatGateOutcome, getScenarioGate } from "./assert";
import { writeBaseline } from "./baseline";
import { AdbError } from "./device";
import {
  type BrowserPerfReport,
  REPORT_SCHEMA,
  validateReport,
} from "./report";
import {
  DEFAULT_ARTIFACTS_DIR,
  dumpTraceNames,
  runComparison,
  serveScenarios,
} from "./run";
import { getScenario, mechanismsOf, type ParamValue } from "./scenarios";
import { formatComparison } from "./table";

const USAGE = `perf — A/B rendering-mechanism instrument (godot-scene-web)

  pnpm perf -- [--scenario <name>] [options]
  pnpm perf -- compare <dir>
  pnpm perf -- assert --scenario <name> [dir]
  pnpm perf -- validate-report <file>

Options
  --scenario <name>       scenario to run (default: atlas-sprites)
  --mechanism <a,b,c>     mechanisms to compare (default: all declared by the scenario)
  --env device            measure on an Android phone over adb instead of local Chrome
  --env <label>           environment label recorded in the report (default: <platform>-chrome-<major>)
  --env-kind <ci|device>  environment kind (default: ci)
  --repeats <n>           measured repeats, medians reported (default: 5)
  --warmups <n>           discarded warmup repeats (default: 1)
  --cpu-throttle <n>      Emulation.setCPUThrottlingRate; 6 approximates the target phone (default: 1)
                          IGNORED for --env device: a phone is the slow hardware, not an emulation of one
  --viewport <WxH>        force a viewport in CSS px with Emulation.setDeviceMetricsOverride
                          (default: 1280x800 on ci; on --env device the phone's OWN viewport is used)
  --dpr <n>               device pixel ratio for the forced viewport (default: 1)
  --fit / --no-fit        scale the scenario's stage to fit the viewport, letterboxed, in either
                          orientation — the same uniform "keep" fit the consuming web client uses
                          (default: ON for --env device, OFF on ci so the committed desktop baseline
                          stays comparable). Runs at different fit scales are NOT comparable on
                          decode/raster; the report records the geometry in env.geometry.
  --no-gpu                skip the GPU trace categories (gpu, viz, gpu.service, skia.gpu) and report
                          gpu.available: false. PROTECTIVE, not cosmetic — those categories emit one
                          event per draw op and can overflow the trace buffer, which truncates a
                          capture into something that reads as an idle page. CPU numbers are
                          unaffected; the cpu block still covers browser + GPU processes.
  --memory-dump           ALSO request a Chrome memory-infra dump at the measurement bracket and report
                          the GPU allocator deltas (gpu/gl/textures, gpu/shared_images,
                          skia/gpu_resources/*). OFF BY DEFAULT: it is a CROSS-CHECK of the driver's
                          per-process VRAM figure, not a second answer — it is Chrome counting itself,
                          and where the two disagree THE DRIVER NUMBER IS THE TRUTH. Reads \`size\`, never
                          \`effective_size\` (which deduplicates a shared texture across processes and
                          would hide one the renderer owns and shares into the GPU process).
  --duration <ms>         measured window length (default: 2500)
  --param k=v             scenario parameter override, repeatable (e.g. --param mounted=50)
  --out <dir>             output directory (default: artifacts/perf/runs/<timestamp>)
  --baseline [name]       also write packages/perf-harness/baselines/<name>.json (default: the env label).
                          Works on \`compare <dir>\` too, so a baseline can be re-derived from a finished
                          run without re-measuring.
  --json                  print the reports as JSON instead of the table
  --serve                 start the server, print scenario URLs and stay up until Ctrl-C
                          (with --env device it also sets up adb reverse, so the phone can open them)
  --dump-trace-names      capture one trace, check the analyzer's matchers against it, print the histogram
  --headed                run Chrome headed (debugging)
  --chrome-arg <flag>     extra Chrome launch flag, repeatable; DESKTOP ONLY
                          (e.g. --chrome-arg --enable-unsafe-webgpu). IGNORED for --env device: the
                          phone's Chrome is attached to, never launched
  --help                  this text

assert re-runs the comparison (or reads an existing run directory) and checks the scenario's
RELATIONAL gate: ratios between arms measured in the same browser, never absolute wall-clock
thresholds, so the gate survives a different machine. Exits non-zero when a relation fails.

Device options (--env device)
  --device-serial <s>     which phone (default: ANDROID_SERIAL, or the only connected device)
  --devtools-port <n>     local port for adb forward -> localabstract:chrome_devtools_remote (default: 9222)
  --adb <path>            adb binary (default: GSW_PERF_ADB, then adb from PATH)

Chrome is resolved from GSW_PERF_CHROME, then ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome,
then /snap/bin/chromium. On device, Chrome is whatever is already installed on the phone.`;

interface Args {
  command: "run" | "compare" | "assert" | "validate-report";
  positional: string[];
  scenario: string;
  mechanisms: string[] | undefined;
  env: string | undefined;
  envKind: "ci" | "device";
  repeats: number;
  warmups: number;
  cpuThrottle: number;
  /** `undefined` = do not force one (the device's own viewport, or the ci default). */
  viewport: { width: number; height: number } | undefined;
  dpr: number;
  /** `undefined` = the per-environment default (on for device, off for ci). */
  fit: boolean | undefined;
  /** Collect the GPU trace categories and the `gpu` metric block. */
  gpu: boolean;
  /** Add the memory-infra category and the bracketed dumps. A cross-check; see USAGE. */
  memoryDump: boolean;
  duration: number;
  params: Record<string, ParamValue>;
  out: string | undefined;
  baseline: string | undefined;
  json: boolean;
  serve: boolean;
  dumpTraceNames: boolean;
  headed: boolean;
  /** Extra Chrome launch flags, in the order given. Desktop only — see `--chrome-arg` in USAGE. */
  chromeArgs: string[];
  help: boolean;
  device: { serial?: string; adbBin?: string; devtoolsPort?: number };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "run",
    positional: [],
    scenario: "atlas-sprites",
    mechanisms: undefined,
    env: undefined,
    envKind: "ci",
    repeats: 5,
    warmups: 1,
    cpuThrottle: 1,
    viewport: undefined,
    dpr: 1,
    fit: undefined,
    gpu: true,
    memoryDump: false,
    duration: 2500,
    params: {},
    out: undefined,
    baseline: undefined,
    json: false,
    serve: false,
    dumpTraceNames: false,
    headed: false,
    chromeArgs: [],
    help: false,
    device: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--scenario") {
      args.scenario = argv[++i];
    } else if (arg === "--mechanism") {
      args.mechanisms = argv[++i]
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (arg === "--env") {
      // `--env device` selects the ATTACH MODE (the documented spelling); any other value is an
      // environment label, which is what this flag has always meant.
      const value = argv[++i];
      if (value === "device" || value === "ci") {
        args.envKind = value;
      } else {
        args.env = value;
      }
    } else if (arg === "--env-kind") {
      args.envKind = argv[++i] === "device" ? "device" : "ci";
    } else if (arg === "--device-serial") {
      args.device.serial = argv[++i];
      args.envKind = "device";
    } else if (arg === "--devtools-port") {
      args.device.devtoolsPort = Number(argv[++i]);
    } else if (arg === "--adb") {
      args.device.adbBin = argv[++i];
    } else if (arg === "--repeats") {
      args.repeats = Number(argv[++i]);
    } else if (arg === "--warmups") {
      args.warmups = Number(argv[++i]);
    } else if (arg === "--cpu-throttle") {
      args.cpuThrottle = Number(argv[++i]);
    } else if (arg === "--viewport") {
      const [w, h] = argv[++i].split("x").map(Number);
      args.viewport = { width: w, height: h };
    } else if (arg === "--fit") {
      args.fit = true;
    } else if (arg === "--no-fit") {
      args.fit = false;
    } else if (arg === "--gpu") {
      args.gpu = true;
    } else if (arg === "--no-gpu") {
      args.gpu = false;
    } else if (arg === "--memory-dump") {
      args.memoryDump = true;
    } else if (arg === "--dpr") {
      args.dpr = Number(argv[++i]);
    } else if (arg === "--duration") {
      args.duration = Number(argv[++i]);
    } else if (arg === "--param") {
      const [key, ...rest] = argv[++i].split("=");
      args.params[key] = /^-?\d+(\.\d+)?$/.test(rest.join("="))
        ? Number(rest.join("="))
        : rest.join("=");
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--baseline") {
      const next = argv[i + 1];
      args.baseline = next && !next.startsWith("--") ? argv[++i] : "";
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--serve") {
      args.serve = true;
    } else if (arg === "--dump-trace-names") {
      args.dumpTraceNames = true;
    } else if (arg === "--headed") {
      args.headed = true;
    } else if (arg === "--chrome-arg") {
      // Consume the next token UNCONDITIONALLY. The values this flag exists to carry are themselves
      // Chrome switches (`--enable-unsafe-webgpu`), so the "peek, and only take it if it does not
      // start with --" shape used by `--baseline` would drop every realistic value and then fail on
      // it as an unknown flag.
      const flag = argv[++i];
      if (flag === undefined) {
        throw new Error(
          "--chrome-arg needs a flag, e.g. --chrome-arg --enable-unsafe-webgpu",
        );
      }
      args.chromeArgs.push(flag);
    } else if (arg.startsWith("--chrome-arg=")) {
      args.chromeArgs.push(arg.slice("--chrome-arg=".length));
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (!arg.startsWith("--")) {
      args.positional.push(arg);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (
    args.positional[0] === "compare" ||
    args.positional[0] === "assert" ||
    args.positional[0] === "validate-report"
  ) {
    args.command = args.positional.shift() as Args["command"];
  }
  return args;
}

async function loadReports(dir: string): Promise<BrowserPerfReport[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const reports: BrowserPerfReport[] = [];
  for (const entry of entries.sort()) {
    const parsed = JSON.parse(
      await readFile(join(dir, entry), "utf8"),
    ) as BrowserPerfReport;
    if (
      parsed.schema === REPORT_SCHEMA &&
      parsed.profile === "browser-render"
    ) {
      reports.push(parsed);
    }
  }
  return reports;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (args.command === "validate-report") {
    const path = args.positional[0];
    if (!path) {
      process.stderr.write("validate-report needs a file path\n");
      return 2;
    }
    const report = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
    const issues = validateReport(report);
    if (issues.length === 0) {
      process.stdout.write(`OK ${path} conforms to perf-report/1\n`);
      return 0;
    }
    process.stderr.write(
      `${issues.length} issue(s) in ${path}:\n${issues
        .map((issue) => `  ${issue.path || "<root>"}: ${issue.message}`)
        .join("\n")}\n`,
    );
    return 1;
  }

  if (args.command === "compare") {
    const dir = resolve(args.positional[0] ?? ".");
    // The table's rows are browser metrics; sibling profiles share the envelope, not the metrics.
    const reports = await loadReports(dir);
    if (reports.length === 0) {
      process.stderr.write(`no browser-render perf-report/1 files in ${dir}\n`);
      return 2;
    }
    process.stdout.write(`${formatComparison(reports)}\n`);
    // A baseline is just the medians the run already computed, so it must be derivable from a
    // FINISHED run. Re-measuring a phone for ten minutes to write a file out of numbers already on
    // disk is how baselines end up not being refreshed.
    if (args.baseline !== undefined) {
      const written = await writeBaseline(reports, {
        name: args.baseline || undefined,
      });
      process.stdout.write(`baseline: ${written.path}\n`);
    }
    return 0;
  }

  if (args.command === "assert") {
    const gate = getScenarioGate(args.scenario);
    // Either check a finished run directory, or measure one now. Both paths evaluate the SAME
    // relations, so a gate can be re-checked from committed evidence without re-running Chrome.
    let reports: BrowserPerfReport[];
    if (args.positional[0]) {
      reports = await loadReports(resolve(args.positional[0]));
    } else {
      const outcome = await runComparison({
        scenario: args.scenario,
        mechanisms: args.mechanisms,
        paramOverrides: args.params,
        repeats: args.repeats,
        warmups: args.warmups,
        viewport: args.viewport,
        deviceScaleFactor: args.dpr,
        fit: args.fit,
        gpu: args.gpu,
        memoryDump: args.memoryDump,
        durationMs: args.duration,
        outDir: args.out ? resolve(args.out) : undefined,
        artifactsDir: DEFAULT_ARTIFACTS_DIR,
        headless: !args.headed,
        extraArgs: args.chromeArgs,
        // The gate's one environment-scoped relation is only evaluable on the GPU decode cache, so
        // `assert --env device` has to be able to reach the phone exactly like a plain run does.
        device: args.device,
        env: {
          kind: args.envKind,
          label: args.env,
          cpuThrottle: args.cpuThrottle,
        },
        onProgress: (message) => process.stderr.write(`${message}\n`),
      });
      reports = outcome.reports;
      process.stdout.write(`${formatComparison(reports)}\n\n`);
      process.stdout.write(`reports: ${outcome.outDir}\n\n`);
    }
    const result = evaluateGate(gate, reports);
    process.stdout.write(`${formatGateOutcome(gate, result)}\n`);
    return result.ok ? 0 : 1;
  }

  if (args.dumpTraceNames) {
    const result = await dumpTraceNames({
      scenario: args.scenario,
      paramOverrides: args.params,
      durationMs: args.duration,
      viewport: args.viewport,
      fit: args.fit,
      gpu: args.gpu,
      headless: !args.headed,
      extraArgs: args.chromeArgs,
      env: { kind: args.envKind },
      device: args.device,
    });
    process.stdout.write(`${result.text}\n`);
    return 0;
  }

  if (args.serve) {
    const scenario = getScenario(args.scenario);
    const server = await serveScenarios({
      scenario: args.scenario,
      paramOverrides: args.params,
      durationMs: args.duration,
      fit: args.fit,
      device: args.device,
      reverseToDevice: args.envKind === "device",
    });
    process.stdout.write(`perf-harness serving ${server.origin}\n`);
    process.stdout.write(
      `scenario ${scenario.name}, mechanisms: ${mechanismsOf(scenario).join(", ")}\n\n`,
    );
    for (const url of server.urls) {
      process.stdout.write(`  ${url}\n`);
    }
    if (server.reversedTo) {
      process.stdout.write(
        `\nadb reverse is up on ${server.reversedTo}: open those exact URLs in Chrome ON THE PHONE.\n`,
      );
    }
    process.stdout.write("\nCtrl-C to stop.\n");
    await new Promise<void>((res) => {
      process.on("SIGINT", () => res());
      process.on("SIGTERM", () => res());
    });
    await server.close();
    return 0;
  }

  const { reports, outDir, notMeasured } = await runComparison({
    scenario: args.scenario,
    mechanisms: args.mechanisms,
    paramOverrides: args.params,
    repeats: args.repeats,
    warmups: args.warmups,
    viewport: args.viewport,
    deviceScaleFactor: args.dpr,
    fit: args.fit,
    gpu: args.gpu,
    memoryDump: args.memoryDump,
    durationMs: args.duration,
    outDir: args.out ? resolve(args.out) : undefined,
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    headless: !args.headed,
    extraArgs: args.chromeArgs,
    device: args.device,
    env: { kind: args.envKind, label: args.env, cpuThrottle: args.cpuThrottle },
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatComparison(reports)}\n`);
    // BELOW THE TABLE, NOT INSTEAD OF A ROW. An arm this checkout could not build is absent from
    // the comparison entirely — never a zero, which for a renderer is the score of a blank page —
    // and the reason plus the command that fixes it go here, in the harness's usual absence shape.
    for (const entry of notMeasured) {
      process.stdout.write(
        `\nNOT MEASURED: ${entry.mechanism} — ${entry.what}\n  ${entry.command}\n`,
      );
    }
    process.stdout.write(`\nreports: ${outDir}\n`);
  }

  if (args.baseline !== undefined) {
    const written = await writeBaseline(reports, {
      name: args.baseline || undefined,
    });
    process.stdout.write(`baseline: ${written.path}\n`);
  }

  const issues = reports.flatMap((report) => validateReport(report));
  if (issues.length > 0) {
    process.stderr.write(
      `\nreport validation failed:\n${issues
        .map((issue) => `  ${issue.path}: ${issue.message}`)
        .join("\n")}\n`,
    );
    return 1;
  }
  return reports.some((report) => (report.failures?.length ?? 0) > 0) ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  // An `AdbError` is an EXPECTED, user-actionable state — no phone, locked phone, no Chrome running.
  // Printing a stack trace for it buries the one sentence that says what to do; a stack is only
  // useful for a defect in this harness.
  process.stderr.write(
    `${
      error instanceof AdbError
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error)
    }\n`,
  );
  process.exitCode = 1;
}
