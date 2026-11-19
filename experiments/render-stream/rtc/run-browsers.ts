import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Browser, chromium, webkit } from "@playwright/test";
import { quietAcquire } from "../scripts/lib/quiet-lock";
import { startProbe } from "./probe.mjs";
import { serve } from "./serve.mjs";

const { values } = parseArgs({
  options: {
    ip: { type: "string" },
    "webkit-executable": { type: "string" },
    browsers: { type: "string", default: "chromium,webkit" },
    out: { type: "string", default: ".local/rtc-g0/local.json" },
    seq: { type: "string" },
    conc: { type: "string" },
    get: { type: "string" },
    skip: { type: "string" },
    // Chromium only: CDP CPU slowdown factor, to tell a CPU-bound receiver from a window-bound one.
    "cpu-throttle": { type: "string" },
    "no-negative": { type: "boolean", default: false },
  },
});
if (!values.ip) throw Error("--ip <non-loopback LAN IPv4> is required");
const names = values.browsers!.split(",");
for (const name of names)
  if (name !== "chromium" && name !== "webkit")
    throw Error(`unknown browser ${name}`);
const out = resolve(values.out!);
await mkdir(dirname(out), { recursive: true });
const buildArgs = [
  "build",
  "--offline",
  "--locked",
  "--release",
  "--manifest-path",
  "experiments/render-stream/rs-net/Cargo.toml",
  "--features",
  "rtc",
  "--bin",
  "rs-net-rtc-probe",
];
const build = spawnSync(
  process.platform === "darwin" ? "cargo" : "bash",
  process.platform === "darwin"
    ? buildArgs
    : [
        "experiments/render-stream/scripts/lib/quiet.sh",
        "shared",
        "--",
        "cargo",
        ...buildArgs,
      ],
  { stdio: "inherit" },
);
if (build.status !== 0) throw Error("probe build failed");
const started = Date.now();
const cert = resolve(dirname(out), "cert");
let probe = await startProbe(values.ip, cert, `${out}.first-probe.jsonl`);
const originalFingerprint = probe.discovery.fp;
await probe.stop();
probe = await startProbe(values.ip, cert, `${out}.probe.jsonl`);
const persistence = originalFingerprint === probe.discovery.fp;
const { server, url } = await serve();
// quiet.sh depends on Linux procfs; hosted macOS jobs run without that lock.
const hold =
  process.platform === "darwin"
    ? undefined
    : await quietAcquire("exclusive", "rtc/browsers", {
        log: `${out}.quiet.jsonl`,
      });
const results: Record<string, unknown> = {};
let ok = persistence;
try {
  for (const name of names) {
    let browser: Browser;
    try {
      browser = await { chromium, webkit }[
        name as "chromium" | "webkit"
      ].launch({
        headless: true,
        ...(name === "webkit" && values["webkit-executable"]
          ? { executablePath: values["webkit-executable"] }
          : {}),
      });
    } catch (error) {
      results[name] = { ok: false, error: String(error) };
      ok = false;
      continue;
    }
    try {
      for (const negative of values["no-negative"] ? [false] : [false, true]) {
        const label = `${name}${negative ? "-negative" : ""}`;
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        if (name === "chromium" && values["cpu-throttle"]) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: Number(values["cpu-throttle"]),
          });
        }
        try {
          const target = new URL(url);
          target.searchParams.set(
            "h",
            `${probe.discovery.ip}:${probe.discovery.port}`,
          );
          target.searchParams.set("f", probe.discovery.fp);
          for (const key of ["seq", "conc", "get", "skip"] as const)
            if (values[key] !== undefined)
              target.searchParams.set(key, values[key]!);
          if (negative) target.searchParams.set("neg", "1");
          await page.goto(target.href);
          await page.waitForFunction(
            () =>
              Boolean(
                (window as unknown as { __rtcResult?: unknown }).__rtcResult,
              ),
            undefined,
            { timeout: 600000 },
          );
          const result = await page.evaluate(
            () =>
              (window as unknown as { __rtcResult: { ok: boolean } })
                .__rtcResult,
          );
          results[label] = {
            ...result,
            pageErrors: errors,
            browserVersion: browser.version(),
            executable:
              name === "webkit"
                ? (values["webkit-executable"] ?? webkit.executablePath())
                : chromium.executablePath(),
          };
          ok &&= result.ok && errors.length === 0;
        } catch (error) {
          results[label] = {
            ok: false,
            error: String(error),
            pageErrors: errors,
          };
          ok = false;
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await hold?.release();
  await probe.stop();
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await writeFile(
    out,
    `${JSON.stringify({ ok, discovery: probe.discovery, persistence, results, wall_s: (Date.now() - started) / 1000, lock_wait_s: hold?.waitS ?? 0 }, null, 2)}\n`,
  );
}
console.log(out);
if (!ok) process.exitCode = 1;
