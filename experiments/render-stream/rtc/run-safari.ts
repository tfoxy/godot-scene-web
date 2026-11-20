import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPage } from "./build-page.mjs";
import { startProbe } from "./probe.mjs";
import { errorDetails, runPage, selectSimulator } from "./safari.mjs";
import {
  collectSafariDiagnostics,
  withSafariDriver,
} from "./safari-driver.mjs";
import { serve } from "./serve.mjs";

const { values } = parseArgs({
  options: { ip: { type: "string" }, out: { type: "string" } },
});
if (process.platform !== "darwin" || !values.ip || !values.out)
  throw Error("macOS, --ip and --out required");
const out = resolve(values.out);
await mkdir(dirname(out), { recursive: true });
const started = Date.now();
const results: Record<string, unknown> = {};
const commands: Record<string, Record<string, unknown>[]> = {};
const diagnostics: Record<string, unknown> = {};
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 180000 }).trim();
let ok = true,
  device: string | undefined;
let probe: Awaited<ReturnType<typeof startProbe>> | undefined;
let server: Awaited<ReturnType<typeof serve>> | undefined;
try {
  await buildPage();
  probe = await startProbe(
    values.ip,
    resolve(dirname(out), "cert"),
    `${out}.first-probe.jsonl`,
  );
  const fp = probe.discovery.fp;
  await probe.stop();
  probe = await startProbe(
    values.ip,
    resolve(dirname(out), "cert"),
    // The active probe's log: rtc-run.py keeps its handshake milestones.
    `${out}.probe.jsonl`,
  );
  if (fp !== probe.discovery.fp)
    throw Error("fingerprint changed across restart");
  server = await serve();
  const pageUrl = server.url;
  const discovery = probe.discovery;
  let selection: ReturnType<typeof selectSimulator> | undefined;
  let simulatorError: unknown;
  try {
    selection = selectSimulator(
      JSON.parse(run("xcrun", ["simctl", "list", "runtimes", "-j"])),
      JSON.parse(run("xcrun", ["simctl", "list", "devicetypes", "-j"])),
    );
    device = run("xcrun", [
      "simctl",
      "create",
      "RTC ephemeral iPhone 13",
      selection.type,
      selection.runtime,
    ]);
    run("xcrun", ["simctl", "boot", device]);
    run("xcrun", ["simctl", "bootstatus", device, "-b"]);
  } catch (error) {
    // Desktop sessions can still run when simulator provisioning fails.
    simulatorError = error;
  }
  run("sudo", ["-n", "safaridriver", "--enable"]);
  commands.driver = [];
  await withSafariDriver(
    `${out}.safaridriver.log`,
    async (base: string) => {
      for (const leg of ["safari", "iphone-safari"]) {
        let legFailed = false;
        const legDevice = leg === "iphone-safari" ? device : undefined;
        try {
          for (const negative of [false, true]) {
            const label = `${leg}${negative ? "-negative" : ""}`;
            try {
              if (leg === "iphone-safari" && simulatorError)
                throw simulatorError;
              const url = new URL(pageUrl);
              url.searchParams.set("h", `${discovery.ip}:${discovery.port}`);
              url.searchParams.set("f", discovery.fp);
              if (legDevice) url.searchParams.set("seq", "200");
              if (negative) url.searchParams.set("neg", "1");
              commands[label] ??= [];
              const result = await runPage(base, url.href, legDevice, {
                commands: commands[label],
              });
              results[label] = {
                ...result,
                ...(legDevice ? { selection } : {}),
              };
              legFailed ||= result.ok !== true;
              ok &&= result.ok === true;
            } catch (error) {
              results[label] = { ok: false, ...errorDetails(error) };
              legFailed = true;
              ok = false;
            }
          }
        } finally {
          if (legFailed) {
            try {
              diagnostics[leg] = await collectSafariDiagnostics(
                resolve(dirname(out), "safari-diagnostics", leg),
                legDevice,
              );
            } catch (error) {
              diagnostics[leg] = errorDetails(error);
            }
          }
        }
      }
    },
    { commands: commands.driver, startupMs: 60000 },
  );
} catch (error) {
  results.setup = { ok: false, ...errorDetails(error) };
  ok = false;
  try {
    diagnostics.setup = await collectSafariDiagnostics(
      resolve(dirname(out), "safari-diagnostics", "setup"),
      device,
    );
  } catch (diagnosticError) {
    diagnostics.setup = errorDetails(diagnosticError);
  }
} finally {
  if (device) {
    try {
      run("xcrun", ["simctl", "delete", device]);
    } catch (error) {
      results.cleanup = { ok: false, ...errorDetails(error) };
      ok = false;
    }
  }
  await probe?.stop();
  if (server)
    await new Promise<void>((done) => server?.server.close(() => done()));
  await writeFile(
    out,
    `${JSON.stringify({ ok, persistence: probe !== undefined && !results.setup, discovery: probe?.discovery, results, commands, diagnostics, wall_s: (Date.now() - started) / 1000 }, null, 2)}\n`,
  );
}
if (!ok) process.exitCode = 1;
