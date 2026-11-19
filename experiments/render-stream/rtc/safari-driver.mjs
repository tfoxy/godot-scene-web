import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorDetails, request } from "./safari.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// One diagnosed driver serves sequential sessions; await its exit before cleanup.
export async function withSafariDriver(
  logPath,
  callback,
  {
    commands = /** @type {Record<string, unknown>[]} */ ([]),
    spawnDriver = spawn,
    requestDriver = request,
    startupMs = 60000,
    stopMs = 5000,
  } = {},
) {
  const log = createWriteStream(logPath);
  const driver = spawnDriver("safaridriver", ["--diagnose", "-p", "4444"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  let spawnError;
  const closed = new Promise((done) => {
    driver.once("close", () => {
      exited = true;
      done();
    });
  });
  driver.once("error", (error) => {
    spawnError = error;
    log.write(`${String(error)}\n`);
  });
  driver.stdout?.pipe(log, { end: false });
  driver.stderr?.pipe(log, { end: false });
  const base = "http://127.0.0.1:4444";
  let failure;
  let result;
  try {
    const deadline = Date.now() + startupMs;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited) throw Error("SafariDriver exited before startup");
      try {
        await requestDriver(base, "GET", "/status", undefined, {
          timeoutMs: 1000,
          commands,
        });
        ready = true;
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!ready) throw Error("SafariDriver startup timeout");
    result = await callback(base);
  } catch (error) {
    failure = error;
  } finally {
    const wait = async () => {
      let timer;
      try {
        await Promise.race([
          closed,
          new Promise((done) => {
            timer = setTimeout(done, stopMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (!exited) {
      driver.kill("SIGTERM");
      await wait();
    }
    if (!exited) {
      driver.kill("SIGKILL");
      await wait();
    }
    await new Promise((done) => log.end(done));
    if (!exited) {
      failure = Object.assign(
        Error("SafariDriver did not exit after SIGKILL"),
        { driverNotStopped: true },
      );
    }
  }
  if (failure) throw failure;
  return result;
}

// Retain bounded tails; diagnostic output must not make a failed job's artifact unbounded.
export async function collectSafariDiagnostics(
  out,
  udid,
  {
    logsDir = join(homedir(), "Library/Logs/com.apple.WebDriver"),
    run = execFileSync,
    maxBytes = 4 * 1024 * 1024,
    fileBytes = 256 * 1024,
  } = {},
) {
  await mkdir(out, { recursive: true });
  const report = { files: [], errors: [], bytes: 0, skipped: 0 };
  let entries = 0;
  async function copy(dir, relative = "", depth = 0) {
    if (depth > 4 || entries >= 512) {
      report.skipped++;
      return;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        ++entries > 512 ||
        report.files.length >= 32 ||
        report.bytes >= maxBytes
      ) {
        report.skipped++;
        break;
      }
      const name = join(relative, entry.name);
      const source = join(dir, entry.name);
      if (entry.isDirectory()) await copy(source, name, depth + 1);
      else if (entry.isFile()) {
        const handle = await open(source, "r");
        try {
          const { size } = await handle.stat();
          const count = Math.min(size, fileBytes, maxBytes - report.bytes);
          const buffer = Buffer.alloc(count);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            count,
            size - count,
          );
          const target = join(out, "webdriver", name);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, buffer.subarray(0, bytesRead));
          report.bytes += bytesRead;
          report.files.push({
            source,
            path: target,
            bytes: bytesRead,
            truncated: size > bytesRead,
          });
        } finally {
          await handle.close();
        }
      }
    }
  }
  try {
    await copy(logsDir);
  } catch (error) {
    report.errors.push({ phase: "webdriver-logs", ...errorDetails(error) });
  }
  if (udid) {
    const args = [
      "simctl",
      "spawn",
      udid,
      "log",
      "show",
      "--last",
      "5m",
      "--style",
      "compact",
      "--predicate",
      'process == "MobileSafari" OR process == "com.apple.WebKit.Networking"',
    ];
    let output;
    try {
      output = run("xcrun", args, {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      });
    } catch (error) {
      output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      report.errors.push({
        phase: "simulator-log",
        argv: ["xcrun", ...args],
        ...errorDetails(error),
      });
    }
    const bytes = Buffer.from(output);
    const excerpt = bytes.subarray(Math.max(0, bytes.length - 256 * 1024));
    const path = join(out, "simulator.log");
    await writeFile(path, excerpt);
    report.files.push({
      path,
      bytes: excerpt.length,
      truncated: bytes.length > excerpt.length,
    });
  }
  await writeFile(
    join(out, "diagnostics.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
