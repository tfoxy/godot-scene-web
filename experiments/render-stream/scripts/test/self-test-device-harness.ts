#!/usr/bin/env -S pnpm exec tsx --conditions=development
// G7d self-test (protocol/gate7-design.md "G7d" Checks and Sabotage): the device harness, dry-run
// with no phone. A fake `adb` binary (written here, driven by scripts/test/device-fixtures/<id>/:
// the g31's recorded 2026-10-15 adb excerpts and the g86's synthesized ones) and a fake DevTools
// endpoint (HTTP /json/version plus a flattened-CDP WebSocket answering the handful of methods
// perf-harness's openDeviceBrowser sends) let the REAL path run end to end:
// browser-harness.ts openHarnessDevice -> perf-harness selectDevice / readDeviceProps / lock check /
// DevTools socket discovery / adb forward + reverse / CDP attach / foreground probe -> page facts
// -> checkDeviceProvenance.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-device-harness.ts [--out <dir>]
//
// Checks: device-provenance passes for both phones on their own facts; with two fake phones
// attached, --device g31 targets only the g31's serial and no serial refuses; the session
// settings are applied and restored (g31) or never touched (g86); the device probes and the
// sampler parse the recorded dumps; the watchdog; the g7-dev / g7-bench leg selection; the bench
// summaries and Q13e's decision rule; gate7-bench.ts's and run-gate7.sh's argument refusals.
// Sabotage: the g86's model under --device g31 and the reverse, and a SwiftShader renderer, make
// device-provenance refuse; `adb devices` without the selected serial gives device-unavailable; a
// trace with 300 ms of hidden time makes the watchdog mark the repeat invalid.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AdbError,
  selectDevice,
} from "../../../../packages/perf-harness/src/device";
import {
  acceptWebSocket,
  checkDeviceProvenance,
  DEVICE_PAGE_FACTS_EXPRESSION,
  type DeviceFacts,
  type DevicePageFacts,
  HarnessRefusal,
  HarnessUsageError,
  loadDeviceTable,
  openHarnessDevice,
  resolveDeviceSelection,
  watchdogVerdict,
} from "../lib/browser-harness";
import { probeDeviceAdb } from "../lib/device-probes";
import { DeviceSampler, parseCpuFreqLines } from "../lib/device-sampler";
import {
  decide,
  type GswBenchJson,
  histogramPercentile,
  mergeHistograms,
  summarizeGswBench,
  summarizeNativeBench,
} from "../lib/gate7-bench-summary";
import { planGate7Bench, planGate7Dev } from "../lib/gate7-dev-legs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SCRIPT_DIR, "device-fixtures");
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");

const table = loadDeviceTable();
const G31 = table.g31;
const G86 = table.g86;

let failures = 0;
let passes = 0;
const results: { id: string; ok: boolean; detail: string }[] = [];
function check(id: string, ok: boolean, detail = ""): void {
  results.push({ id, ok, detail });
  if (ok) passes++;
  else failures++;
  console.log(
    `${ok ? "[SELF-TEST OK]" : "[SELF-TEST FAIL]"} ${id}${detail ? ` -- ${detail}` : ""}`,
  );
}

async function expectRejects(
  fn: () => Promise<unknown>,
  match: (e: unknown) => boolean,
): Promise<{ ok: boolean; error: unknown }> {
  try {
    await fn();
    return { ok: false, error: null };
  } catch (e) {
    return { ok: match(e), error: e };
  }
}

// ------------------------------------------------------------------------------- the fake adb

const FAKE_ADB = `#!/bin/sh
# self-test-device-harness.ts's fake adb: FAKE_ADB_ROOT/<serial>/ holds that phone's dumps,
# FAKE_ADB_ROOT/devices.txt the \`adb devices -l\` body, FAKE_ADB_ROOT/state/<serial>/<ns>.<key> the
# mutable settings. Every call is logged to FAKE_ADB_ROOT/calls.log.
echo "$*" >> "$FAKE_ADB_ROOT/calls.log"
serial=""
if [ "$1" = "-s" ]; then serial="$2"; shift 2; fi
case "$1" in
  devices) printf 'List of devices attached\\n'; cat "$FAKE_ADB_ROOT/devices.txt"; printf '\\n'; exit 0 ;;
  forward|reverse) exit 0 ;;
  shell) shift ;;
  *) echo "fake adb: unhandled: $*" >&2; exit 1 ;;
esac
dir="$FAKE_ADB_ROOT/$serial"
state="$FAKE_ADB_ROOT/state/$serial"
if [ -z "$serial" ] || [ ! -d "$dir" ]; then echo "adb: device '$serial' not found" >&2; exit 1; fi
cmd="$*"
case "$cmd" in
  *"getprop ro.product.model"*) cat "$dir/props.txt" ;;
  "dumpsys battery") cat "$dir/battery.txt" ;;
  "dumpsys thermalservice") cat "$dir/thermalservice.txt" ;;
  "dumpsys window") cat "$dir/window.txt" ;;
  "cat /proc/net/unix") cat "$dir/net-unix.txt" ;;
  "dumpsys display") cat "$dir/display.txt" ;;
  "dumpsys SurfaceFlinger") cat "$dir/surfaceflinger.txt" ;;
  "wm size; wm density") cat "$dir/wm.txt" ;;
  *"/cpufreq/"*) cat "$dir/cpufreq.txt" ;;
  "ls /sys/class/devfreq/ 2>&1") cat "$dir/devfreq-ls.txt" ;;
  *"<</sys/kernel/ged"*) cat "$dir/gpu-nodes.txt" ;;
  "pidof com.android.chrome") cat "$dir/pidof.txt" ;;
  "dumpsys meminfo "*) cat "$dir/meminfo.txt" ;;
  "dumpsys gfxinfo "*) cat "$dir/gfxinfo.txt" ;;
  "svc power stayon usb") echo 2 > "$state/global.stay_on_while_plugged_in" ;;
  "settings get "*) set -- $cmd; if [ -f "$state/$3.$4" ]; then cat "$state/$3.$4"; else echo null; fi ;;
  "settings put "*) set -- $cmd; echo "$5" > "$state/$3.$4" ;;
  "settings delete "*) set -- $cmd; rm -f "$state/$3.$4" ;;
  *) echo "fake adb: unhandled shell: $cmd" >&2; exit 1 ;;
esac
`;

interface FakePhone {
  serial: string;
  fixture: string;
  state?: string;
}

function makeFakeAdb(phones: FakePhone[]): { bin: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rs-g7d-fake-adb-"));
  const bin = join(root, "adb");
  writeFileSync(bin, FAKE_ADB);
  chmodSync(bin, 0o755);
  writeFileSync(
    join(root, "devices.txt"),
    phones
      .map(
        (p) =>
          `${p.serial}             ${p.state ?? "device"} usb:1-3 product:fake model:${p.fixture === "g31" ? "moto_g31" : "moto_g86_5G"} transport_id:1`,
      )
      .join("\n"),
  );
  for (const p of phones) {
    cpSync(join(FIXTURES, p.fixture), join(root, p.serial), {
      recursive: true,
    });
    const state = join(root, "state", p.serial);
    mkdirSync(state, { recursive: true });
    for (const line of readFileSync(
      join(FIXTURES, p.fixture, "settings.txt"),
      "utf8",
    ).split("\n")) {
      const m = /^(\w+)\.(\w+)=(.*)$/.exec(line.trim());
      if (m) writeFileSync(join(state, `${m[1]}.${m[2]}`), `${m[3]}\n`);
    }
  }
  writeFileSync(join(root, "calls.log"), "");
  process.env.FAKE_ADB_ROOT = root;
  return { bin, root };
}

function readState(root: string, serial: string): Record<string, string> {
  const dir = join(root, "state", serial);
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir))
    out[f] = readFileSync(join(dir, f), "utf8").trim();
  return out;
}

// ------------------------------------------------------------------------------- the fake CDP

interface FakeCdp {
  port: number;
  calls: string[];
  close(): Promise<void>;
}

/** The DevTools endpoint the adb forward would reach: /json/version and a flattened CDP socket.
 * Android-like: Target.createBrowserContext is "Not supported", so perf-harness uses a new tab. */
async function startFakeCdp(
  fixture: string,
  facts: DevicePageFacts,
): Promise<FakeCdp> {
  const version = JSON.parse(
    readFileSync(join(FIXTURES, fixture, "version.json"), "utf8"),
  ) as Record<string, string>;
  const calls: string[] = [];
  let navigated = "about:blank";
  const server: Server = createServer((req, res) => {
    if (req.url === "/json/version") {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ...version,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const ws = acceptWebSocket(req, socket);
    ws?.onMessage((data) => {
      const msg = JSON.parse(data.toString("utf8")) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      calls.push(msg.method);
      const reply = (result: unknown) =>
        ws.send(
          JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId }),
        );
      const error = (message: string) =>
        ws.send(
          JSON.stringify({ id: msg.id, error: { code: -32000, message } }),
        );
      switch (msg.method) {
        case "Tracing.end":
          return error("Tracing is not started");
        case "Target.createBrowserContext":
          return error("Not supported");
        case "Target.createTarget":
          return reply({ targetId: "FAKE-TARGET" });
        case "Target.attachToTarget":
          return reply({ sessionId: "FAKE-SESSION" });
        case "Page.navigate":
          navigated = String(msg.params?.url ?? "");
          return reply({ frameId: "F" });
        case "Runtime.evaluate": {
          const expr = String(msg.params?.expression ?? "");
          if (expr === "1")
            return reply({ result: { type: "number", value: 1 } });
          if (expr === DEVICE_PAGE_FACTS_EXPRESSION)
            return reply({ result: { type: "object", value: facts } });
          if (expr.startsWith("document.readyState"))
            return reply({
              result: { type: "string", value: `complete ${navigated}` },
            });
          return reply({ result: { type: "undefined" } });
        }
        default:
          return reply({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function pageFacts(fixture: string): DevicePageFacts {
  return JSON.parse(
    readFileSync(join(FIXTURES, fixture, "page-facts.json"), "utf8"),
  ) as DevicePageFacts;
}

async function openAndCheck(
  id: "g31" | "g86",
  phones: FakePhone[],
  facts: DevicePageFacts,
  cdpFixture: string,
): Promise<{
  facts: DeviceFacts;
  provenance: ReturnType<typeof checkDeviceProvenance>;
  calls: string[];
  root: string;
  settingsAfterOpen: Record<string, string>;
  settingsAfterClose: Record<string, string>;
}> {
  const { bin, root } = makeFakeAdb(phones);
  const cdp = await startFakeCdp(cdpFixture, facts);
  const entry = table[id];
  try {
    const harness = await openHarnessDevice({
      id,
      entry,
      serverPort: 47999,
      adbBin: bin,
      devtoolsPort: cdp.port,
      foregroundTimeoutMs: 3000,
    });
    const settingsAfterOpen = readState(root, entry.serial);
    const page = await harness.openPage(
      "http://127.0.0.1:47999/index.html?mode=idle",
    );
    const deviceFacts = await harness.facts(page);
    await page.close();
    await harness.close();
    const settingsAfterClose = readState(root, entry.serial);
    return {
      facts: deviceFacts,
      provenance: checkDeviceProvenance(entry, deviceFacts),
      calls: readFileSync(join(root, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean),
      root,
      settingsAfterOpen,
      settingsAfterClose,
    };
  } finally {
    await cdp.close();
  }
}

async function main(): Promise<void> {
  let out: string | null = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === "--out") out = resolve(argv[++i]);

  // --- 1. --env / --device resolution (D28: device arms never run without both flags).
  check(
    "selection-desktop-default",
    resolveDeviceSelection("desktop", undefined, table).id === null,
  );
  check(
    "selection-device-g31",
    resolveDeviceSelection("device", "g31", table).entry?.serial === G31.serial,
  );
  for (const [label, env, dev] of [
    ["selection-device-without-id-refused", "device", undefined],
    ["selection-id-without-device-env-refused", "desktop", "g31"],
    ["selection-unknown-id-refused", "device", "pixel"],
  ] as const) {
    let refused = false;
    try {
      resolveDeviceSelection(env, dev, table);
    } catch (e) {
      refused = e instanceof HarnessUsageError;
    }
    check(label, refused);
  }

  // --- 2. Two fake phones attached: --device g31 selects the g31's serial; no serial refuses.
  const both: FakePhone[] = [
    { serial: G31.serial, fixture: "g31" },
    { serial: G86.serial, fixture: "g86" },
  ];
  {
    const { bin } = makeFakeAdb(both);
    const r = await expectRejects(
      () => selectDevice({ adbBin: bin }),
      (e) =>
        e instanceof AdbError &&
        /more than one device/.test((e as Error).message),
    );
    check(
      "two-phones-no-serial-refused",
      r.ok,
      String((r.error as Error)?.message ?? "").split("\n")[0],
    );
  }
  const g31Run = await openAndCheck("g31", both, pageFacts("g31"), "g31");
  const shellCalls = g31Run.calls.filter((c) => c.includes(" shell "));
  check(
    "two-phones-device-g31-targets-its-serial",
    shellCalls.length > 0 &&
      shellCalls.every((c) => c.startsWith(`-s ${G31.serial} `)) &&
      !g31Run.calls.some((c) => c.includes(G86.serial)),
    `${shellCalls.length} shell calls, all on -s ${G31.serial}`,
  );
  check(
    "reverse-and-forward-on-the-g31",
    g31Run.calls.some(
      (c) => c === `-s ${G31.serial} reverse tcp:47999 tcp:47999`,
    ) &&
      g31Run.calls.some((c) => c.startsWith(`-s ${G31.serial} forward tcp:`)) &&
      g31Run.calls.some(
        (c) => c === `-s ${G31.serial} reverse --remove tcp:47999`,
      ),
  );

  // --- 3. device-provenance on each phone's own facts.
  check(
    "device-provenance-g31",
    g31Run.provenance.ok,
    [...g31Run.provenance.reasons, ...g31Run.provenance.notes].join("; "),
  );
  check(
    "device-provenance-g31-records-backend",
    g31Run.provenance.notes.some((n) => /GPU backend: ANGLE/.test(n)) &&
      g31Run.provenance.angle,
  );
  check(
    "device-provenance-g31-chrome-recorded",
    g31Run.provenance.chromeVersion === "Chrome/154.0.8037.127",
  );
  const g86Run = await openAndCheck("g86", both, pageFacts("g86"), "g86");
  check(
    "device-provenance-g86",
    g86Run.provenance.ok && g86Run.provenance.angle,
    [...g86Run.provenance.reasons, ...g86Run.provenance.notes].join("; "),
  );

  // --- 4. D28 session settings: the g31's applied, then restored; the g86 never touched.
  const before = readFileSync(join(FIXTURES, "g31", "settings.txt"), "utf8");
  check(
    "session-settings-applied-g31",
    g31Run.settingsAfterOpen["global.stay_on_while_plugged_in"] === "2" &&
      g31Run.settingsAfterOpen["system.accelerometer_rotation"] === "0" &&
      g31Run.settingsAfterOpen["system.user_rotation"] === "1",
    JSON.stringify(g31Run.settingsAfterOpen),
  );
  check(
    "session-settings-restored-g31",
    before
      .split("\n")
      .filter(Boolean)
      .every((line) => {
        const [k, v] = line.split("=");
        return g31Run.settingsAfterClose[k] === v;
      }),
    JSON.stringify(g31Run.settingsAfterClose),
  );
  check(
    "session-settings-untouched-g86",
    !g86Run.calls.some((c) => /settings put|settings delete|svc power/.test(c)),
  );

  // --- 5. Sabotage: the other phone's model, a SwiftShader renderer -> device-provenance refuses.
  {
    const swapped = await openAndCheck(
      "g31",
      [{ serial: G31.serial, fixture: "g86" }],
      pageFacts("g31"),
      "g31",
    );
    check(
      "sabotage-g86-model-under-g31-refused",
      !swapped.provenance.ok &&
        swapped.provenance.refusal === "device-provenance" &&
        swapped.provenance.reasons.some((r) => /model/.test(r)),
      swapped.provenance.reasons.join("; "),
    );
    const reverse = await openAndCheck(
      "g86",
      [{ serial: G86.serial, fixture: "g31" }],
      pageFacts("g86"),
      "g86",
    );
    check(
      "sabotage-g31-model-under-g86-refused",
      !reverse.provenance.ok &&
        reverse.provenance.reasons.some((r) => /model/.test(r)),
      reverse.provenance.reasons.join("; "),
    );
    const swift = await openAndCheck(
      "g31",
      [{ serial: G31.serial, fixture: "g31" }],
      { ...pageFacts("g31"), renderer: "Google SwiftShader" },
      "g31",
    );
    check(
      "sabotage-swiftshader-refused",
      !swift.provenance.ok &&
        swift.provenance.reasons.some((r) => /software|does not name/.test(r)),
      swift.provenance.reasons.join("; "),
    );
    const noAngle = checkDeviceProvenance(G86, {
      ...g86Run.facts,
      page: { ...pageFacts("g86"), renderer: "Mali-G615 MC2" },
    });
    check(
      "sabotage-g86-without-angle-refused",
      !noAngle.ok && noAngle.reasons.some((r) => /ANGLE/.test(r)),
    );
    const portrait = checkDeviceProvenance(G31, {
      ...g31Run.facts,
      page: {
        ...pageFacts("g31"),
        innerWidth: 411,
        innerHeight: 800,
        orientation: "portrait-primary",
      },
    });
    check(
      "portrait-is-device-orientation",
      !portrait.ok && portrait.refusal === "device-orientation",
    );
    const hot = checkDeviceProvenance(G31, {
      ...g31Run.facts,
      conditions: {
        ...g31Run.facts.conditions,
        thermalStatus: "light",
        thermalStatusCode: 1,
        batteryPct: 15,
      },
    });
    check(
      "thermal-and-battery-refused",
      !hot.ok && hot.reasons.length === 2,
      hot.reasons.join("; "),
    );
    const changed = checkDeviceProvenance(G31, {
      ...g31Run.facts,
      previousChromeVersion: "Chrome/153.0.0.0",
    });
    check(
      "chrome-change-is-a-note",
      changed.ok && changed.notes.some((n) => /Chrome changed/.test(n)),
    );
  }

  // --- 6. device-unavailable: missing serial, unauthorized, locked, no DevTools socket.
  for (const [label, phones, mutate] of [
    [
      "device-unavailable-not-listed",
      [{ serial: G86.serial, fixture: "g86" }],
      null,
    ],
    [
      "device-unavailable-unauthorized",
      [{ serial: G31.serial, fixture: "g31", state: "unauthorized" }],
      null,
    ],
    [
      "device-unavailable-locked",
      [{ serial: G31.serial, fixture: "g31" }],
      "locked",
    ],
    [
      "device-unavailable-no-devtools-socket",
      [{ serial: G31.serial, fixture: "g31" }],
      "nosocket",
    ],
  ] as [string, FakePhone[], string | null][]) {
    const { bin, root } = makeFakeAdb(phones);
    if (mutate === "locked")
      writeFileSync(
        join(root, G31.serial, "window.txt"),
        "    mAwake=true\n    mDreamingLockscreen=true\n",
      );
    if (mutate === "nosocket")
      writeFileSync(join(root, G31.serial, "net-unix.txt"), "Num RefCount\n");
    const r = await expectRejects(
      () =>
        openHarnessDevice({
          id: "g31",
          entry: G31,
          serverPort: 47999,
          adbBin: bin,
          devtoolsPort: 1,
          foregroundTimeoutMs: 1000,
        }),
      (e) => e instanceof HarnessRefusal && e.reason === "device-unavailable",
    );
    check(
      label,
      r.ok,
      String((r.error as Error)?.message ?? "no error")
        .split("\n")[0]
        .slice(0, 140),
    );
  }

  // --- 7. The watchdog: 300 ms hidden -> invalid; an uncaused 400-ms gap -> invalid; a gap the
  // receiver's own work explains -> valid.
  const clean = { hiddenMs: 0, hides: 0, longGaps: [], tpMs: 16.7 };
  check("watchdog-clean-valid", watchdogVerdict(clean).valid);
  check(
    "sabotage-watchdog-300ms-hidden-invalid",
    !watchdogVerdict({ ...clean, hiddenMs: 300, hides: 1 }).valid,
  );
  check(
    "watchdog-uncaused-gap-invalid",
    !watchdogVerdict({ ...clean, longGaps: [{ gapMs: 400, prevWorkMs: 5 }] })
      .valid,
  );
  check(
    "watchdog-receiver-caused-gap-valid",
    watchdogVerdict({ ...clean, longGaps: [{ gapMs: 400, prevWorkMs: 380 }] })
      .valid,
  );

  // --- 8. Device probes and the sampler, on the recorded g31 dumps.
  {
    const { bin, root } = makeFakeAdb([{ serial: G31.serial, fixture: "g31" }]);
    const { Adb } = await import(
      "../../../../packages/perf-harness/src/device"
    );
    const adb = new Adb({ bin, serial: G31.serial });
    const probes = await probeDeviceAdb(adb, "g31", G31);
    check(
      "probe-panel-g31",
      probes.display.modes.length === 1 &&
        probes.display.active_fps === 60 &&
        probes.surfaceflinger.refresh_hz === 60 &&
        Math.abs((probes.panel_tp_ms ?? 0) - 16.667) < 0.01,
      JSON.stringify(probes.display),
    );
    check(
      "probe-gles-g31",
      probes.surfaceflinger.gles?.includes("Mali-G52 MC2") === true,
    );
    check(
      "probe-wm-g31",
      probes.wm.physical?.[0] === 1080 && probes.wm.density === 420,
    );
    check(
      "probe-cpufreq-readable-g31",
      probes.cpu_freq_readable === true &&
        probes.cpu_freq?.every((c) => c.derated === false) === true,
    );
    check(
      "probe-gpu-counters-unreadable-g31",
      probes.gpu_counters.length === 4 &&
        probes.gpu_counters.every((n) => !n.readable),
    );
    check(
      "probe-meminfo-readable-g31",
      probes.meminfo_readable && probes.meminfo?.pss_kb === 150681,
    );
    check("probe-gfxinfo-g31", probes.gfxinfo_gpu_memory_bytes === 14372668);
    check(
      "probe-trace-names-delegated",
      probes.trace_names.delegated_to.includes(`--device-serial ${G31.serial}`),
    );
    const sampler = new DeviceSampler(adb, {
      chromePackage: "com.android.chrome",
      clusters: G31.cpu_clusters,
      pids: () => [15792],
      conditionsMs: 60,
      memoryMs: 40,
    });
    sampler.start();
    await new Promise((r) => setTimeout(r, 400));
    const tl = await sampler.stop();
    check(
      "sampler-dry-run-g31",
      tl.conditions.length >= 2 &&
        tl.conditions.every(
          (c) => c.thermalStatusCode === 0 && c.batteryPct === 36,
        ) &&
        tl.meminfo.length >= 2 &&
        tl.meminfo[0].samples[0].pss_kb === 150681 &&
        tl.gpu_memory[0].bytes === 14372668 &&
        !tl.derated,
      `${tl.conditions.length} condition, ${tl.meminfo.length} meminfo samples`,
    );
    writeFileSync(
      join(root, G31.serial, "cpufreq.txt"),
      "cpu0/cpuinfo_max_freq=1800000\ncpu0/scaling_max_freq=1200000\ncpu0/scaling_cur_freq=1200000\ncpu6/cpuinfo_max_freq=2000000\ncpu6/scaling_max_freq=2000000\ncpu6/scaling_cur_freq=2000000\n",
    );
    const derated = parseCpuFreqLines(
      readFileSync(join(root, G31.serial, "cpufreq.txt"), "utf8"),
      G31.cpu_clusters ?? [],
    );
    check(
      "sampler-derated-cap-detected",
      derated[0].derated === true && derated[1].derated === false,
    );
    const unreadable = parseCpuFreqLines(
      "cpu0/scaling_max_freq=cat: Permission denied\n",
      G31.cpu_clusters ?? [],
    );
    check(
      "sampler-unreadable-cap-is-null",
      unreadable[0].derated === null && unreadable[0].errors.length > 0,
    );
  }

  // --- 9. Leg selection: --legs g7-dev without --env device runs only ctl- arms.
  {
    const desktop = planGate7Dev(null, table);
    check(
      "g7-dev-desktop-only-ctl",
      desktop.length > 0 &&
        desktop.every((l) => l.arm === "ctl" && l.name.startsWith("ctl-")),
      `${desktop.length} ctl legs`,
    );
    const g31 = planGate7Dev("g31", table);
    const g31Dev = g31.filter((l) => l.arm === "dev");
    check(
      "g7-dev-g31-legs",
      g31Dev.filter((l) => /^dev-(pace|scene|hd)-w[12]-(web|gsw)$/.test(l.name))
        .length === 12 &&
        !g31Dev.some((l) => l.name.startsWith("dev-panel-")) &&
        g31Dev.some((l) => l.name === "dev-soak-hd-gsw" && l.report_only) &&
        g31Dev.find((l) => l.name === "dev-soak-gsw")?.workload === "scene" &&
        g31Dev
          .filter((l) => l.workload === "hd" && /^dev-hd-/.test(l.name))
          .every((l) => !l.required) &&
        g31.filter((l) => l.arm === "ctl").length === g31Dev.length,
      `${g31Dev.length} dev + ${g31.length - g31Dev.length} ctl`,
    );
    const g86 = planGate7Dev("g86", table).filter((l) => l.arm === "dev");
    check(
      "g7-dev-g86-legs",
      g86.filter((l) => l.name.startsWith("dev-panel-")).length === 8 &&
        g86.find((l) => l.name === "dev-soak-gsw")?.workload === "hd" &&
        !g86.some((l) => l.name.startsWith("dev-soak-hd-")) &&
        g86.filter((l) => /^dev-hd-/.test(l.name)).every((l) => l.required),
    );
    const bench = planGate7Bench(null, ["pace-patch"]);
    check(
      "g7-bench-desktop-arms",
      bench.map((l) => l.name).join(",") ===
        "native-bench-pace-patch,ctl-bench-pace-patch-gsw,ctl-bench-pace-patch-web",
    );
    check(
      "g7-bench-device-arms",
      planGate7Bench("g31", ["pace-patch"]).every(
        (l) => l.arm === "dev" && l.name.endsWith("-g31"),
      ),
    );
  }

  // --- 10. Bench summaries and Q13e's decision rule.
  {
    const h = {
      count: 4,
      sum: 4000,
      min: 900,
      max: 1100,
      mean: 1000,
      buckets: [
        [896, 2],
        [1024, 2],
      ] as [number, number][],
    };
    const merged = mergeHistograms([h, h]);
    check(
      "histogram-merge",
      merged.count === 8 && merged.sum === 8000 && merged.buckets.length === 2,
    );
    check(
      "histogram-percentile",
      histogramPercentile(merged, 0.5) < 1024 &&
        histogramPercentile(merged, 0.95) >= 1024 &&
        histogramPercentile(merged, 0.95) <= 1100,
    );
    const native = summarizeNativeBench("x", [
      {
        repeat: 0,
        perf: {
          schema: "render-stream-receiver-perf/1",
          histograms: { decode_us: h, apply_us: h },
        },
        exit: 0,
      },
    ]);
    check(
      "native-summary",
      native.phases.decode?.mean_us === 1000 && native.total_p95_us !== null,
    );
    const sample = (total: number) => ({
      kind: "transaction",
      total_us: total,
      decode_us: total / 2,
      hash_us: total / 4,
      resolve_us: total / 4,
      validate_us: total / 4,
    });
    const json: GswBenchJson = {
      schema: "render-stream-gate7-gsw-bench/1",
      input: { name: "x", records: 3 },
      page: { crossOriginIsolated: true, timer_resolution_us: 5 },
      results: [
        {
          repeat: 0,
          warmup: true,
          error: null,
          raf: { tp_ms: 16.7 },
          watchdog: clean,
          samples: [sample(99999)],
        },
        {
          repeat: 1,
          warmup: false,
          error: null,
          raf: { tp_ms: 16.7 },
          watchdog: clean,
          samples: [sample(1000), sample(3000)],
        },
        {
          repeat: 2,
          warmup: false,
          error: null,
          raf: { tp_ms: 16.7 },
          watchdog: { ...clean, hiddenMs: 300, hides: 1 },
          samples: [sample(50000)],
        },
      ],
    };
    const gsw = summarizeGswBench(json);
    check(
      "gsw-summary-excludes-warmup-and-invalid",
      gsw.phases.total?.max_us === 3000 &&
        gsw.repeats.length === 2 &&
        !gsw.repeats[1].valid,
    );
    check(
      "decision-device-pass",
      decide(gsw, "device", 16.7).verdict === "pass",
    );
    check(
      "decision-device-over-budget",
      decide({ ...gsw, total_p95_us: 9000 }, "device", 16.7).verdict ===
        "device-decode-over-budget",
    );
    check(
      "decision-desktop-early-signal",
      decide(gsw, "desktop", null).verdict === "early-signal",
    );
  }

  // --- 11. The command lines refuse device arms without both flags.
  const tsx = (args: string[]) =>
    spawnSync(
      "mise",
      [
        "exec",
        "--",
        "pnpm",
        "exec",
        "tsx",
        "--conditions=development",
        ...args,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
  const inputsPath = join(
    mkdtempSync(join(tmpdir(), "rs-g7d-inputs-")),
    "inputs.json",
  );
  writeFileSync(
    inputsPath,
    JSON.stringify({
      schema: "render-stream-gate7-bench-inputs/1",
      inputs: [],
    }),
  );
  const benchScript = join(SCRIPT_DIR, "..", "gate7-bench.ts");
  const noDevice = tsx([
    benchScript,
    "--arm",
    "gsw",
    "--env",
    "device",
    "--inputs",
    inputsPath,
    "--out",
    join(dirname(inputsPath), "o1"),
  ]);
  check(
    "bench-cli-device-env-without-device-exit-2",
    noDevice.status === 2,
    noDevice.stderr.trim().split("\n").pop(),
  );
  const nativeOnDevice = tsx([
    benchScript,
    "--arm",
    "native",
    "--env",
    "device",
    "--device",
    "g31",
    "--inputs",
    inputsPath,
    "--out",
    join(dirname(inputsPath), "o2"),
  ]);
  check(
    "bench-cli-native-on-device-exit-2",
    nativeOnDevice.status === 2,
    nativeOnDevice.stderr.trim().split("\n").pop(),
  );
  const runner = join(SCRIPT_DIR, "..", "run-gate7.sh");
  const planOut = mkdtempSync(join(tmpdir(), "rs-g7d-plan-"));
  const plan = spawnSync(
    "bash",
    [runner, "--legs", "g7-dev", "--plan-only", "--out", join(planOut, "p")],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  let planned: { name: string }[] = [];
  try {
    planned = (
      JSON.parse(
        readFileSync(join(planOut, "p", "g7-dev", "plan.json"), "utf8"),
      ) as { legs: { name: string }[] }
    ).legs;
  } catch {
    planned = [];
  }
  check(
    "runner-g7-dev-without-env-device-plans-only-ctl",
    plan.status === 0 &&
      planned.length > 0 &&
      planned.every((l) => l.name.startsWith("ctl-")),
    `${planned.length} legs, exit ${plan.status}`,
  );
  const runnerNoDevice = spawnSync(
    "bash",
    [
      runner,
      "--legs",
      "g7-dev",
      "--env",
      "device",
      "--plan-only",
      "--out",
      join(planOut, "q"),
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  check(
    "runner-env-device-without-device-exit-2",
    runnerNoDevice.status === 2,
    runnerNoDevice.stderr.trim().split("\n").pop(),
  );

  console.log(
    `\nself-test-device-harness: ${passes} passed, ${failures} failed`,
  );
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "self-test-device-harness.json"),
      `${JSON.stringify({ schema: "render-stream-gate7d-device-selftest/1", passes, failures, checks: results }, null, 2)}\n`,
    );
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
