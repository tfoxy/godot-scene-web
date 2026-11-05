// CAR10 (protocol/carrier-design.md "As built (CAR10)"): the credit loop over WebTransport on an
// impaired UDP path, in the pinned headless Chromium with the client package's own WebTransport
// transport (packages/render-stream-client/src/webtransport.ts, bundled into the page). The host
// is rs-net-lockstep (the `wt` carrier with the hub's credit rule: a ~2.4 KB binary message every
// 16 ms while fewer than 2 are unacknowledged); the page answers each message as the client does
// (`received` and `applied` at once, `submitted` at the next animation frame), so the host sees
// the browser's real ack traffic. Between them runs lib/udp-impair-proxy.ts.
//
// Legs, one host and one page each (the transport's default uplink, Q4.3a, unless named):
//   clean       the proxy forwards everything                  -> every message acknowledged
//   wifi        2% loss, 60 ms fades, 3 ms + up to 8 ms jitter -> every message acknowledged
//   wedge       the page's wedge injector (0.3% of stream writes wedge their stream for good,
//               the CAR10 defect of Chrome on Android, modelled) -> every message acknowledged
//   wedge-live  the same with `uplink: "live"`, the pre-CAR10 client: the SABOTAGE leg, which
//               must stall (the g31 freeze: the page applied everything, the host still waits)
// A leg stalls when the host sees no credit for 5 s while it is owed one.
//
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/wt-impaired-chromium.ts \
//          [--out DIR] [--legs clean,wifi,wedge,wedge-live] [--messages N] [--profile SPEC]
//          [--stats-ms MS] [--netlog FILE]
// --profile replaces the wifi leg's profile (lib/udp-impair-proxy.ts parseProfile).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_THROTTLING_ARGS,
  BROWSER_LAUNCH_ARGS,
  launchHarnessBrowser,
} from "../lib/browser-harness";
import {
  IMPAIR_PROFILES,
  type ImpairProfile,
  parseProfile,
  startImpairProxy,
} from "../lib/udp-impair-proxy";
import {
  bundleTransport,
  LOCKSTEP,
  pageHtml,
  readPageState,
  runHost,
} from "../lib/wt-lockstep";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const OUT = opt("--out") ? resolve(opt("--out") as string) : null;
const LEGS = (opt("--legs") ?? "clean,wifi,wedge,wedge-live").split(",");
const LEG_SETUP: Record<
  string,
  {
    profile: string;
    messages: number;
    uplink: "streams" | "live";
    wedge: number;
    expectStall: boolean;
  }
> = {
  clean: {
    profile: "clean",
    messages: 600,
    uplink: "streams",
    wedge: 0,
    expectStall: false,
  },
  wifi: {
    profile: "wifi",
    messages: 1200,
    uplink: "streams",
    wedge: 0,
    expectStall: false,
  },
  wedge: {
    profile: "clean",
    messages: 1800,
    uplink: "streams",
    wedge: 0.003,
    expectStall: false,
  },
  "wedge-live": {
    profile: "clean",
    messages: 1800,
    uplink: "live",
    wedge: 0.003,
    expectStall: true,
  },
};
const MESSAGES = Number(opt("--messages") ?? "0");
const STATS_MS = opt("--stats-ms") ?? "0";

let failed = 0;
const results: { check: string; ok: boolean }[] = [];
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  results.push({ check: what, ok: cond });
  if (!cond) failed++;
}

async function main(): Promise<void> {
  const b = spawnSync(
    "bash",
    [join(RS, "scripts/build-rs-net.sh"), "--no-test"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (b.status !== 0 || !existsSync(LOCKSTEP))
    throw new Error("build-rs-net.sh failed or rs-net-lockstep is missing");
  const page = pageHtml(await bundleTransport());
  const server = createServer((_q, s) => {
    s.writeHead(200, { "content-type": "text/html" });
    s.end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const profileDir = mkdtempSync(join(tmpdir(), "wt-impaired-profile-"));
  // --netlog FILE: Chromium's net log (QUIC frames included) for a by-hand diagnosis.
  const netlog = opt("--netlog");
  const { browser } = await launchHarnessBrowser({
    userDataDir: profileDir,
    ...(netlog
      ? {
          args: [
            ...BROWSER_LAUNCH_ARGS,
            ...BACKGROUND_THROTTLING_ARGS,
            `--log-net-log=${resolve(netlog)}`,
            "--net-log-capture-mode=Everything",
          ],
        }
      : {}),
  });
  console.log(`chromium ${browser.version()}`);
  const report: Record<string, unknown> = {
    schema: "rs-wt-impaired/1",
    chromium: browser.version(),
    legs: {},
  };
  try {
    for (const leg of LEGS) {
      const setup = LEG_SETUP[leg];
      if (!setup) throw new Error(`unknown leg ${leg}`);
      const profile: ImpairProfile =
        leg === "wifi" && opt("--profile")
          ? parseProfile(opt("--profile") as string)
          : IMPAIR_PROFILES[setup.profile];
      const messages = MESSAGES > 0 ? MESSAGES : setup.messages;
      const log: string[] = [];
      const host = await runHost(messages, log, ["--stats-ms", STATS_MS]);
      const proxy = await startImpairProxy(
        { host: "127.0.0.1", port: host.port },
        profile,
      );
      const p = await browser.newPage();
      await p.goto(pageUrl);
      const url = `https://127.0.0.1:${proxy.port}/render-stream?protocol=render-stream.13`;
      await p.evaluate(
        ([u, c, o]) =>
          (
            window as unknown as {
              lockstep: (u: string, c: string, o: unknown) => boolean;
            }
          ).lockstep(u, c, o),
        [
          url,
          host.cert,
          { uplink: setup.uplink, wedge: setup.wedge, seed: 7 },
        ] as const,
      );
      const timeout = new Promise<null>((r) =>
        setTimeout(() => r(null), (messages / 60) * 1000 * 3 + 30000),
      );
      const result = await Promise.race([host.result, timeout]);
      const page = await p.evaluate(readPageState);
      const quietMs = {
        up: Date.now() - proxy.counts.lastUpAt,
        down: Date.now() - proxy.counts.lastDownAt,
      };
      console.log(
        `  proxy: client ports ${proxy.counts.clientPorts.join(",")}; last datagram up ${quietMs.up} ms ago, down ${quietMs.down} ms ago`,
      );
      host.proc.kill("SIGTERM");
      await p.close();
      await proxy.close();
      (report.legs as Record<string, unknown>)[leg] = {
        profile,
        messages,
        result,
        page,
        proxy: proxy.counts,
        hostLog: log.slice(-40),
      };
      const rate = result ? result.credits_per_s.toFixed(1) : "-";
      const stalled =
        result !== null && !result.ok && result.why.startsWith("stall");
      ok(
        setup.expectStall
          ? stalled && page.received === result.sent
          : result?.ok === true,
        `${leg}${setup.expectStall ? " (sabotage: must stall)" : ""}: wedged streams ${page.wedged}; ${result ? `${result.credited}/${messages} credited in ${result.seconds.toFixed(1)} s (${rate}/s)${result.ok ? "" : `, ${result.why}`}` : "no result"}; page received ${page.received}, wrote ${page.acksSent} acks (stream writes ${page.writes.issued} issued, ${page.writes.resolved} settled, desiredSize ${page.writes.desired}); proxy up ${proxy.counts.up.forwarded}/-${proxy.counts.up.dropped} down ${proxy.counts.down.forwarded}/-${proxy.counts.down.dropped}`,
      );
      if (result && !result.ok && !setup.expectStall)
        for (const l of log.slice(-12)) console.log(`  host: ${l}`);
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
  report.results = results;
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, "wt-impaired.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    failed === 0
      ? "wt-impaired-chromium: all passed"
      : `wt-impaired-chromium: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
