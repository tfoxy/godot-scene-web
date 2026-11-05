// CAR10 device leg (protocol/carrier-design.md "As built (CAR10)"): the credit loop of
// wt-impaired-chromium.ts on a real phone over Wi-Fi. rs-net-lockstep serves `wt` on the LAN
// (expose=lan, self-signed, pinned by hash); the page is served on loopback and reaches the
// phone through `adb reverse` (TCP), so it is a secure context at http://localhost:<port>; its
// WebTransport session goes over Wi-Fi to <lan ip>:<udp port> (adb reverse carries no UDP).
// Chrome is driven over CDP (adb forward to the phone's devtools socket). Every wait polls on a
// node timer. At the end the tab is closed and the reverse and forward this run added removed.
//
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/wt-phone-lockstep.ts --lan 192.168.1.50 \
//          [--serial PHONESERIAL31] [--seconds 300] [--stats-ms 1000] [--out DIR] [--cdp-port 9232]
//          [--uplink streams|live] [--size B] [--trace FILE]
// --uplink live is the pre-CAR10 client (acks on the live stream): on the g31 it stalls within
// seconds to a minute. --trace FILE writes the host's quinn trace (a diagnosis aid).
// Exit 0 when every message was acknowledged, 1 on a stall or a missing result.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  bundleTransport,
  type LockstepResult,
  pageHtml,
  readPageState,
  runHost,
} from "../lib/wt-lockstep";

const argv = process.argv.slice(2);
const opt = (name: string, d: string | null = null): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const SERIAL = opt("--serial", "PHONESERIAL31") as string;
const LAN = opt("--lan");
const SECONDS = Number(opt("--seconds", "300"));
const STATS_MS = opt("--stats-ms", "1000") as string;
const CDP_PORT = Number(opt("--cdp-port", "9232"));
const UPLINK = opt("--uplink", "streams") as string;
const OUT = opt("--out") ? resolve(opt("--out") as string) : null;
if (!LAN) throw new Error("--lan <this host's LAN address> is required");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const adb = (...a: string[]) =>
  execFileSync("adb", ["-s", SERIAL, ...a], { encoding: "utf8" });
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main(): Promise<void> {
  const page = pageHtml(await bundleTransport());
  const server = createServer((_q, s) => {
    s.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    s.end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const pagePort = (server.address() as AddressInfo).port;
  const hadForward = adb("forward", "--list").includes(`tcp:${CDP_PORT}`);
  if (!hadForward)
    adb("forward", `tcp:${CDP_PORT}`, "localabstract:chrome_devtools_remote");
  adb("reverse", `tcp:${pagePort}`, `tcp:${pagePort}`);
  const pageUrl = `http://localhost:${pagePort}/`;
  const messages = Math.round(SECONDS * 62.5);
  const hostLog: string[] = [];
  const host = await runHost(messages, hostLog, [
    "--listen",
    `${LAN}:0`,
    "--stats-ms",
    STATS_MS,
    "--stall-ms",
    "10000",
    "--size",
    opt("--size", "2400") as string,
    ...(opt("--trace") ? ["--trace", resolve(opt("--trace") as string)] : []),
  ]);
  log(`host wt ${LAN}:${host.port}, page ${pageUrl}, ${messages} messages`);
  const version = (await (
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
  ).json()) as Record<string, string>;
  const report: Record<string, unknown> = {
    schema: "rs-wt-phone-lockstep/1",
    uplink: UPLINK,
    serial: SERIAL,
    chrome: version.Browser,
    lan: LAN,
  };
  let tabId: string | null = null;
  let result: LockstepResult | null = null;
  const samples: { t: number; received: number; acksSent: number }[] = [];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  try {
    adb(
      "shell",
      `am start -a android.intent.action.VIEW -d '${pageUrl}' -n com.android.chrome/com.google.android.apps.chrome.Main --ez create_new_tab true`,
    );
    let target: { id: string; url: string } | null = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(500);
      const list = (await (
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      ).json()) as { id: string; url: string; type: string }[];
      target =
        list.find((t) => t.type === "page" && t.url.startsWith(pageUrl)) ??
        null;
    }
    if (!target) throw new Error("the phone did not open the page");
    tabId = target.id;
    let p = null;
    for (let i = 0; i < 20 && !p; i++) {
      p =
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((x) => x.url().startsWith(pageUrl)) ?? null;
      if (!p) await sleep(500);
    }
    if (!p) throw new Error("CDP did not attach to the page");
    const facts = await p.evaluate(() => ({
      secure: isSecureContext,
      wt: typeof WebTransport,
      ua: navigator.userAgent,
    }));
    report.page = facts;
    log(`page ${JSON.stringify(facts)}`);
    const url = `https://${LAN}:${host.port}/render-stream?protocol=render-stream.13`;
    await p.evaluate(
      ([u, c, o]) =>
        (
          window as unknown as {
            lockstep: (u: string, c: string, o: unknown) => boolean;
          }
        ).lockstep(u, c, o),
      [url, host.cert, { uplink: UPLINK }] as const,
    );
    const t0 = Date.now();
    const deadline = t0 + SECONDS * 1500 + 60000;
    let done = false;
    void host.result.then((r) => {
      result = r;
      done = true;
    });
    while (!done && Date.now() < deadline) {
      await sleep(1000);
      const s = await Promise.race([
        p.evaluate(readPageState),
        sleep(8000).then(() => null),
      ]);
      if (s) {
        samples.push({
          t: Date.now() - t0,
          received: s.received,
          acksSent: s.acksSent,
        });
        if (samples.length % 30 === 0)
          log(
            `page received ${s.received}, acks ${s.acksSent}; host ${hostLog.filter((l) => l.startsWith("LOCKSTEP_PROGRESS")).at(-1) ?? ""}`,
          );
      }
    }
    report.finalPage = await Promise.race([
      p.evaluate(readPageState),
      sleep(8000).then(() => null),
    ]);
  } finally {
    host.proc.kill("SIGTERM");
    if (tabId)
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tabId}`).catch(
        () => {},
      );
    await browser.close().catch(() => {});
    try {
      adb("reverse", "--remove", `tcp:${pagePort}`);
    } catch {}
    if (!hadForward) {
      try {
        adb("forward", "--remove", `tcp:${CDP_PORT}`);
      } catch {}
    }
    server.close();
  }
  // appliesPerSec as the client reports it: messages received per second, from the 1 s samples.
  const rates = samples
    .slice(1)
    .map(
      (s, i) =>
        (s.received - samples[i].received) / ((s.t - samples[i].t) / 1000),
    );
  const sorted = [...rates].sort((a, b) => a - b);
  const r = result as LockstepResult | null;
  report.result = r;
  report.appliesPerSec = {
    n: rates.length,
    mean: rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length),
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    min: sorted[0] ?? null,
    zeroSamples: rates.filter((x) => x === 0).length,
  };
  report.samples = samples;
  report.hostLog = hostLog.slice(-60);
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "wt-phone-lockstep.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  const ok = r?.ok === true;
  console.log(
    `${ok ? "ok  " : "FAIL"} phone wt: ${r ? `${r.credited}/${messages} credited in ${r.seconds.toFixed(1)} s, ${r.why}` : "no result"}; appliesPerSec ${JSON.stringify(report.appliesPerSec)}`,
  );
  if (!ok) for (const l of hostLog.slice(-10)) console.log(`  host: ${l}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
