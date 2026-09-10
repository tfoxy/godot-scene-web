// Drive `bake-probe.html` on the connected phone (or this box with --local) and print the table.
//
//   mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts
//   mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts --local
//   mise exec -- pnpm exec tsx packages/perf-harness/probes/bake-probe.ts --query phases=blit
//
// Reuses the harness's own device attach (adb reverse for transport, adb forward + flattened CDP for
// control, foreground probe, lock check) so the phone is driven exactly as a real run drives it.
//
// This is a PROBE, not a scenario. It answers "what does the encoder actually cost, and what does it
// cost us in fidelity" — questions about mechanisms nobody has committed to — and it deliberately
// does NOT produce a `perf-report/1` envelope: it measures no frame rate, takes no trace and runs no
// presence guard, so dressing its output up as a report would put numbers that were never measured
// under this harness's methodology next to numbers that were.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalBrowser } from "../src/browser.ts";
import { openDeviceBrowser } from "../src/device.ts";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const local = argv.includes("--local");
const queryIndex = argv.indexOf("--query");
const query = queryIndex >= 0 ? (argv[queryIndex + 1] ?? "") : "";
const timeoutIndex = argv.indexOf("--timeout-min");
const timeoutMin = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 15;
// A device probe run takes MINUTES and cannot be repeated cheaply, so the result is written to disk
// as well as printed. Piping the run through `tail` once and losing the bake table to the scrollback
// is a real way to burn ten minutes of phone time for nothing.
const outIndex = argv.indexOf("--out");
const outPath =
  outIndex >= 0
    ? resolve(argv[outIndex + 1])
    : join(
        here,
        "../../../artifacts/perf/probes",
        `bake-probe-${local ? "local" : "device"}.json`,
      );

const html = await readFile(join(here, "bake-probe.html"), "utf8");
const server = createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
console.log(`serving on 127.0.0.1:${port}`);

const browser = local
  ? await openLocalBrowser({
      artifactsDir: join(here, "../../../artifacts/perf"),
    })
  : await openDeviceBrowser({
      serverPort: port,
      onProgress: (m) => console.log(`  ${m}`),
    });
console.log(browser.describe);

const lease = await browser.targets.acquire({ width: 360, height: 640 });
const client = browser.client;
const send = (method: string, params: Record<string, unknown> = {}) =>
  client.send(method, params, { sessionId: lease.sessionId });

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", {
    url: `http://127.0.0.1:${port}/${query ? `?${query}` : ""}`,
  });

  const deadline = Date.now() + timeoutMin * 60_000;
  let result: { results?: unknown[]; error?: string } | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const value = await client
      .send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: "window.__bakeProbe ?? null",
          returnByValue: true,
        },
        { sessionId: lease.sessionId, timeoutMs: 30_000 },
      )
      .then((r) => r.result?.value as typeof result)
      .catch(() => undefined);
    if (value) {
      result = value;
      break;
    }
    process.stdout.write(".");
  }
  console.log();

  if (!result) {
    console.log(`TIMED OUT — no result after ${timeoutMin} min`);
    process.exitCode = 1;
  } else if (result.error) {
    console.log("PAGE ERROR:", result.error);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (result) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${outPath}`);
  }
} finally {
  await lease.release().catch(() => {});
  await browser.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
