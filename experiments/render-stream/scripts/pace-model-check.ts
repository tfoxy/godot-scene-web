// GPU-bound viewer model, measured in the pinned desktop browser or device-table Chrome.
// mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/pace-model-check.ts \
//   --dir artifacts/render-stream/pace-model --targets 30,45 --seconds 20
// --closed-loop adds live host-policy runs; --closed-loop-only skips the open-loop segments.
// Phone (operator only): append --device g31; ANDROID_SERIAL selects the attached phone.
// A failed model check is a measured result. Calibration is reported, not gating.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CDPSession } from "@playwright/test";
import { build } from "esbuild";
import type { HostOptions } from "../web/pace-model/host";
import {
  drawMetrics,
  pacingMetrics,
  percentile,
} from "../web/pace-model/metrics";
import {
  type Calibration,
  callbackRate,
  displayIntervalMs,
  idleReturnsDisplay,
  type Segment,
} from "../web/pace-model/probe";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  checkDeviceProvenance,
  DEVICE_PAGE_FACTS_EXPRESSION,
  type DeviceHarness,
  type DeviceId,
  type DevicePageFacts,
  HarnessServer,
  launchHarnessBrowser,
  loadDeviceTable,
  openHarnessDevice,
  withAttachedSerial,
} from "./lib/browser-harness";
import { isNvidiaRenderer } from "./lib/browser-renderer";
import { readCpuFreqs } from "./lib/device-sampler";
import { quietAcquire } from "./lib/quiet-lock";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PAGE = join(ROOT, "experiments/render-stream/web/pace-model");

function args() {
  const a = process.argv.slice(2);
  const options: Record<string, string> = {};
  let closedLoop = false;
  let closedLoopOnly = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--closed-loop" || a[i] === "--closed-loop-only") {
      closedLoop = true;
      closedLoopOnly ||= a[i] === "--closed-loop-only";
      continue;
    }
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`pace-model-check: invalid argument ${a[i]}`);
    const key = a[i].slice(2);
    if (!["dir", "targets", "seconds", "device"].includes(key))
      throw new Error(`pace-model-check: unknown option --${key}`);
    options[key] = a[++i];
  }
  if (!options.dir) throw new Error("pace-model-check: --dir is required");
  const targets = (options.targets ?? "30,45").split(",").map(Number);
  const seconds = Number(options.seconds ?? 20);
  if (!targets.length || targets.some((t) => !Number.isFinite(t) || t <= 0))
    throw new Error("pace-model-check: targets must be positive Hz");
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("pace-model-check: seconds must be positive");
  const device = options.device;
  if (device !== undefined && device !== "g31" && device !== "g86")
    throw new Error(`pace-model-check: no device ${device}`);
  return {
    dir: resolve(options.dir),
    targets,
    seconds,
    device,
    closedLoop,
    closedLoopOnly,
  };
}

function score(raw: Segment) {
  return {
    callback_hz: callbackRate(raw),
    drawn_hz:
      (raw.drew.reduce((a, b) => a + b, 0) * 1000) / (raw.endMs - raw.startMs),
    duration_p95_ms: percentile(raw.durationMs, 0.95),
    ping_p95_ms: percentile(raw.ping.delayMs, 0.95),
    raw,
  };
}

function scoreHost(raw: Segment, options: HostOptions, policy: string) {
  if (!raw.host) throw new Error("pace-model: host series missing");
  const draws = raw.drew.reduce((a, b) => a + b, 0);
  const histogram: Record<string, number> = {};
  for (const n of raw.host.consumed) {
    if (n > 0) histogram[n] = (histogram[n] ?? 0) + 1;
  }
  return {
    ...score(raw),
    ...options,
    policy,
    ...drawMetrics(raw.ts, raw.drew, raw.host.captureMs),
    pacing: raw.pacing
      ? {
          ...raw.pacing,
          ...pacingMetrics(raw.pacing, raw.startMs, raw.endMs),
        }
      : null,
    content_age_delta_off_ms: null as number | null,
    content_age_delta_paced_off_ms: null as number | null,
    steadiness_delta_off: null as {
      stddev_ms: number | null;
      stutter_share: number | null;
    } | null,
    steadiness_delta_paced_off: null as {
      stddev_ms: number | null;
      stutter_share: number | null;
    } | null,
    draws_paced_off: null as number | null,
    sends_hz: (1000 * raw.host.sendMs.length) / (raw.endMs - raw.startMs),
    sends_per_draw: draws ? raw.host.sendMs.length / draws : null,
    consumed_per_draw: histogram,
    draws_off: null as number | null,
  };
}

interface Check {
  id: string;
  target_hz: number;
  pass: boolean;
  gating: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const { dir, targets, seconds, device, closedLoop, closedLoopOnly } = args();
  const tableEntry = device ? loadDeviceTable()[device] : null;
  if (device && !tableEntry)
    throw new Error(`pace-model-check: no device ${device}`);
  const entry = tableEntry ? withAttachedSerial(tableEntry) : null;
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const checks: Check[] = [];
  const results: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    schema: "render-stream-pace-model/1",
    targets_hz: targets,
    seconds,
    checks,
    targets: results,
    ...(closedLoop
      ? { closed_loop: true, closed_loop_only: closedLoopOnly }
      : {}),
  };
  const save = () =>
    writeFileSync(join(dir, "pace-model.json"), JSON.stringify(report));
  const check = (
    id: string,
    target: number,
    pass: boolean,
    detail: string,
    gating = true,
  ) => {
    checks.push({ id, target_hz: target, pass, gating, detail });
    console.log(
      `${pass ? "PASS" : "FAIL"} ${id} target=${target}Hz${gating ? "" : " (reported)"}: ${detail}`,
    );
  };
  const staticRoot = join(dir, "page");
  mkdirSync(staticRoot, { recursive: true });
  await build({
    entryPoints: [join(PAGE, "page.ts")],
    outfile: join(staticRoot, "page.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["development"],
  });
  copyFileSync(join(PAGE, "index.html"), join(staticRoot, "index.html"));
  const server = new HarnessServer({
    staticRoot,
    evidenceRoot: join(dir, "evidence"),
    allowedLegNonces: [],
    crossOriginIsolated: true,
  });
  const { origin } = await server.start();
  let launched: Awaited<ReturnType<typeof launchHarnessBrowser>> | undefined;
  let cdp: CDPSession | undefined;
  let harness: DeviceHarness | undefined;
  let lease:
    | Awaited<ReturnType<DeviceHarness["browser"]["targets"]["acquire"]>>
    | undefined;
  const interrupted = new AbortController();
  const onSignal = (signal: NodeJS.Signals) =>
    interrupted.abort(new Error(`pace-model: interrupted by ${signal}`));
  // Device cleanup must also run on Ctrl-C/termination, including during a long CDP sample.
  if (device) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    // One browser for the entire campaign; each timing leg holds its own lock.
    const setup = await quietAcquire("exclusive", "pace-model/setup", {
      log: join(dir, "quiet-lock.jsonl"),
    });
    report.setup_lock_wait_s = setup.waitS;
    try {
      if (setup.state !== "acquired")
        throw new Error(`pace-model: quiet lock ${setup.state}`);
      if (device && entry) {
        // Minimal device setup from client-device-check.ts: the same table entry,
        // page-port reverse, target lease, page facts and session-setting owner.
        harness = await openHarnessDevice({
          id: device as DeviceId,
          entry,
          serverPort: Number(new URL(origin).port),
          onProgress: (message) =>
            console.log(`pace-model: device: ${message}`),
        });
        interrupted.signal.throwIfAborted();
        report.device = device;
        report.conditions_before = await harness.browser.conditions();
        report.cpufreq_before = await readCpuFreqs(
          harness.browser.adb,
          entry.cpu_clusters ?? [],
        );
        lease = await harness.browser.targets.acquire({
          width: entry.screen_css_px[0],
          height: entry.screen_css_px[1],
        });
        await harness.browser.client.send("Page.navigate", {
          url: `${origin}/index.html?device=1`,
        });
        const deadline = Date.now() + 30_000;
        while (
          !(await evaluate<boolean>("window.paceModel !== undefined").catch(
            () => false,
          ))
        ) {
          interrupted.signal.throwIfAborted();
          if (Date.now() > deadline)
            throw new Error(
              "pace-model: the device page never exposed paceModel",
            );
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const facts = await harness.facts({
          evaluate: (e, o) => harness!.browser.client.evaluate(e, o),
          facts: () =>
            harness!.browser.client.evaluate<DevicePageFacts>(
              DEVICE_PAGE_FACTS_EXPRESSION,
              { timeoutMs: 10_000 },
            ),
          close: async () => {},
        });
        const provenance = checkDeviceProvenance(entry, facts);
        report.provenance = provenance;
        report.backing = await evaluate<number[]>("window.paceModel.backing");
        save();
        if (!provenance.ok)
          throw new Error(
            `pace-model: device provenance refused: ${provenance.reasons.join(", ")}`,
          );
      } else {
        launched = await launchHarnessBrowser();
        const page = await launched.browser.newPage({
          viewport: { width: 1280, height: 720 },
        });
        page.on("pageerror", (error) =>
          console.error(`[page] ${error.message}`),
        );
        await page.goto(`${origin}/index.html`);
        await page.waitForFunction("window.paceModel !== undefined");
        const provenance = await checkBrowserProvenance(
          page,
          launched,
          [...BROWSER_LAUNCH_ARGS, ...BACKGROUND_THROTTLING_ARGS],
          { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
        );
        report.provenance = provenance;
        save();
        if (!provenance.ok || !isNvidiaRenderer(provenance.renderer ?? ""))
          throw new Error(
            `pace-model: provenance refused: ${provenance.reasons.join(", ")} renderer=${provenance.renderer}`,
          );
        cdp = await page.context().newCDPSession(page);
      }
    } finally {
      await setup.release();
    }

    async function evaluate<T>(expression: string): Promise<T> {
      if (harness) {
        interrupted.signal.throwIfAborted();
        let abort: () => void = () => {};
        try {
          return await Promise.race([
            harness.browser.client.evaluate<T>(expression, {
              awaitPromise: true,
              timeoutMs: Math.max(180_000, (seconds + 30) * 1000),
            }),
            new Promise<never>((_, reject) => {
              abort = () => reject(interrupted.signal.reason);
              interrupted.signal.addEventListener("abort", abort, {
                once: true,
              });
            }),
          ]);
        } finally {
          interrupted.signal.removeEventListener("abort", abort);
        }
      }
      if (!cdp) throw new Error("pace-model: no CDP session");
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: Math.max(180_000, (seconds + 30) * 1000),
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      return result.result.value as T;
    }

    let displayReference: Segment | null = null;
    for (const target of targets) {
      interrupted.signal.throwIfAborted();
      const hold = await quietAcquire("exclusive", `pace-model/${target}Hz`, {
        log: join(dir, "quiet-lock.jsonl"),
      });
      const legStart = Date.now();
      const row: Record<string, unknown> = {
        target_hz: target,
        lock_wait_s: hold.waitS,
      };
      results.push(row);
      try {
        if (hold.state !== "acquired")
          throw new Error(`pace-model: quiet lock ${hold.state}`);
        if (displayReference === null) {
          console.log("RUN unloaded display reference");
          displayReference = await evaluate<Segment>(
            `window.paceModel.run(${JSON.stringify({ seconds: 1, draw: "none" })})`,
          );
          report.display_reference = {
            ...score(displayReference),
            display_interval_ms: displayIntervalMs(displayReference),
          };
          save();
          if (displayIntervalMs(displayReference) <= 0)
            throw new Error(
              "pace-model: unloaded display reference unavailable",
            );
        }
        row.display_interval_ms = displayIntervalMs(displayReference);
        console.log(`RUN target=${target}Hz calibration`);
        const calibration = await evaluate<Calibration>(
          `window.paceModel.calibrate(${target})`,
        );
        row.calibration = calibration;
        check(
          "calibrated",
          target,
          calibration.calibrated,
          `${calibration.reachedHz.toFixed(3)}Hz, iterations=${calibration.iterations}, target tolerance=5%${calibration.limitation ? `, ${calibration.limitation}` : ""}`,
          false,
        );
        save();
        if (
          !calibration.backpressure &&
          !(device && calibration.limitation === "minimum-workload-too-slow")
        )
          throw new Error(
            "pace-model: calibration produced no GPU backpressure; see calibration samples",
          );
        if (!closedLoopOnly) {
          const every = score(
            await evaluate<Segment>(
              `window.paceModel.run(${JSON.stringify({ seconds, draw: "every" })})`,
            ),
          );
          row.every = every;
          save();
          const none = score(
            await evaluate<Segment>(
              `window.paceModel.run(${JSON.stringify({ seconds, draw: "none" })})`,
            ),
          );
          row.none = none;
          save();
          const contentHz = Math.round((target * 2) / 3);
          const content = score(
            await evaluate<Segment>(
              `window.paceModel.run(${JSON.stringify({ seconds, draw: { contentHz } })})`,
            ),
          );
          row.content = content;
          const displayHz = 1000 / displayIntervalMs(displayReference);
          check(
            "load-tracks-capacity",
            target,
            Math.abs(every.callback_hz / calibration.reachedHz - 1) <= 0.08,
            `${every.callback_hz.toFixed(3)}Hz vs calibrated ${calibration.reachedHz.toFixed(3)}Hz (8%)`,
          );
          check(
            "idle-returns-display",
            target,
            idleReturnsDisplay(displayReference, none.raw),
            `${none.callback_hz.toFixed(3)}Hz vs display ${displayHz.toFixed(3)}Hz (95%)`,
          );
          check(
            "spare-visible",
            target,
            content.callback_hz >= 1.25 * contentHz,
            `${content.callback_hz.toFixed(3)}Hz vs content ${contentHz}Hz (125%)`,
          );
          check(
            "main-thread-free",
            target,
            every.ping_p95_ms !== null && every.ping_p95_ms <= 4,
            `ping p95=${every.ping_p95_ms}ms (<=4ms)`,
          );
        }
        if (closedLoop) {
          const groups: Record<string, unknown>[] = [];
          row.closed_loop = groups;
          for (const oneWayMs of [0.5, 24]) {
            const runs: ReturnType<typeof scoreHost>[] = [];
            const group: Record<string, unknown> = {
              one_way_ms: oneWayMs,
              runs,
            };
            groups.push(group);
            for (const policy of [
              "off",
              "d1",
              "d3",
              "cap05",
              "cap20",
              "pacedOff",
              "paced",
              "off",
            ] as const) {
              const host: HostOptions = {
                policy:
                  policy === "cap05" || policy === "cap20" ? "cap" : policy,
                ...(policy === "cap05"
                  ? { capOffset: 0.05 }
                  : policy === "cap20"
                    ? { capOffset: 0.2 }
                    : {}),
                oneWayMs,
                jitterMs: 2,
                applyMs: 1,
              };
              console.log(
                `RUN target=${target}Hz host=${policy} oneWay=${oneWayMs}ms`,
              );
              const raw = await evaluate<Segment>(
                `window.paceModel.run(${JSON.stringify({ seconds, draw: { host } })})`,
              );
              runs.push(scoreHost(raw, host, policy));
              save();
            }
            const firstOff = runs[0].drawn_hz;
            const lastOff = runs[runs.length - 1].drawn_hz;
            const off = (firstOff + lastOff) / 2;
            const difference = Math.abs(firstOff - lastOff);
            group.off_drawn_hz = off;
            group.off_difference_hz = difference;
            group.off_difference_fraction = off > 0 ? difference / off : null;
            console.log(
              `NOISE target=${target}Hz oneWay=${oneWayMs}ms off difference=${difference.toFixed(3)}Hz, mean=${off.toFixed(3)}Hz`,
            );
            const offRuns = [runs[0], runs[runs.length - 1]];
            const pacedOff = runs.find((run) => run.policy === "pacedOff")!;
            const meanOff = (
              value: (run: (typeof runs)[number]) => number | null,
            ) => {
              const values = offRuns.map(value);
              return values.every((v) => v !== null)
                ? (values[0]! + values[1]!) / 2
                : null;
            };
            const ageOff = meanOff((run) => run.content_age_ms.mean);
            const stddevOff = meanOff((run) => run.steadiness.stddev_ms);
            const stutterOff = meanOff((run) => run.steadiness.stutter_share);
            group.off_content_age_mean_ms = ageOff;
            group.off_steadiness = {
              stddev_ms: stddevOff,
              stutter_share: stutterOff,
            };
            const delta = (value: number | null, reference: number | null) =>
              value !== null && reference !== null ? value - reference : null;
            for (const run of runs) {
              run.content_age_delta_off_ms = delta(
                run.content_age_ms.mean,
                ageOff,
              );
              run.steadiness_delta_off = {
                stddev_ms: delta(run.steadiness.stddev_ms, stddevOff),
                stutter_share: delta(run.steadiness.stutter_share, stutterOff),
              };
              if (run.policy === "paced" || run.policy === "pacedOff") {
                run.draws_paced_off =
                  pacedOff.drawn_hz > 0
                    ? run.drawn_hz / pacedOff.drawn_hz
                    : null;
                run.content_age_delta_paced_off_ms = delta(
                  run.content_age_ms.mean,
                  pacedOff.content_age_ms.mean,
                );
                run.steadiness_delta_paced_off = {
                  stddev_ms: delta(
                    run.steadiness.stddev_ms,
                    pacedOff.steadiness.stddev_ms,
                  ),
                  stutter_share: delta(
                    run.steadiness.stutter_share,
                    pacedOff.steadiness.stutter_share,
                  ),
                };
              }
              run.draws_off = off > 0 ? run.drawn_hz / off : null;
              console.log(
                `HOST target=${target}Hz oneWay=${oneWayMs}ms policy=${run.policy}: callbacks=${run.callback_hz.toFixed(3)}/s draws=${run.drawn_hz.toFixed(3)}/s sends=${run.sends_hz.toFixed(3)}/s sends/draw=${run.sends_per_draw} draws/off=${run.draws_off} age mean/p95=${run.content_age_ms.mean}/${run.content_age_ms.p95}ms age-off=${run.content_age_delta_off_ms}ms stddev=${run.steadiness.stddev_ms}ms stutters=${run.steadiness.stutter_share} draws/pacedOff=${run.draws_paced_off} patterns=${JSON.stringify(run.pacing?.pattern ?? [])} changes=${run.pacing?.pattern_changes ?? 0} probes kept/reverted/pending=${run.pacing?.probes_kept ?? 0}/${run.pacing?.probes_reverted ?? 0}/${run.pacing?.probes_pending ?? 0} histogram=${JSON.stringify(run.pacing?.pattern_histogram ?? {})} missed=${run.pacing?.slots_missed ?? 0} missed-share=${run.pacing?.missed_slot_share ?? null}`,
              );
              if (run.policy !== "off" && run.policy !== "pacedOff") {
                const reference =
                  run.policy === "paced" ? run.draws_paced_off : run.draws_off;
                check(
                  `closed-loop-${run.policy}-${oneWayMs === 0.5 ? "short" : "long"}`,
                  target,
                  run.sends_per_draw !== null &&
                    run.sends_per_draw <= 1.05 &&
                    reference !== null &&
                    reference >= 0.98,
                  `oneWay=${oneWayMs}ms sends/draw=${run.sends_per_draw} (<=1.05), draws/${run.policy === "paced" ? "pacedOff" : "off"}=${reference} (>=0.98)`,
                  false,
                );
              }
            }
            save();
          }
        }
      } finally {
        row.wall_s = (Date.now() - legStart) / 1000;
        await hold.release();
        save();
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`FAIL pace-model: ${report.error}`);
  } finally {
    if (harness && entry) {
      report.conditions_after = await harness.browser
        .conditions()
        .catch((error: Error) => ({ error: error.message }));
      report.cpufreq_after = await readCpuFreqs(
        harness.browser.adb,
        entry.cpu_clusters ?? [],
      );
      if (lease) {
        // The harness can fall back to borrowing the foreground tab. Release
        // does not close a borrowed tab, so first stop its GPU workload.
        if (harness.browser.targets.isolation === "reused-tab")
          await harness.browser.client
            .send("Page.navigate", { url: "about:blank" })
            .catch(() => {});
        await lease.release().catch(() => {});
      }
      report.session_settings = await harness.close().catch((error: Error) => ({
        error: error.message,
      }));
    }
    if (device) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    await cdp?.detach().catch(() => {});
    await launched?.browser.close();
    await server.stop();
    report.wall_s = (Date.now() - started) / 1000;
    report.lock_wait_s =
      Number(report.setup_lock_wait_s ?? 0) +
      results.reduce((sum, row) => sum + Number(row.lock_wait_s), 0);
    report.complete = !report.error && results.length === targets.length;
    save();
  }
  return report.error || checks.some((c) => c.gating && !c.pass) ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
