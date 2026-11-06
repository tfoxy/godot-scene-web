// TRK4 live leg (protocol/tracks-design.md Q10, the TRK4 row): drives web/client-track-check/ (the
// client package's `./tracks` subpath alone) in the pinned headless Chromium against
// capture/build/rs_live_host --tracks over ws, with an echo receiver. Legs and checks (written to
// <dir>/client-track.json; exit 1 when one fails):
//   echo            a track with a down format: 20 payloads (non-ASCII too) reach the receiver in
//                   order between one `opened` and one `closed`, come back verbatim, and the
//                   page's close() is the receiver's `closed` 1000
//   keepalive       a silent track outlives the host's idle limit (3 x 250 ms): the client sent
//                   keepalives, the receiver saw none
//   rate            a burst far above the host's bucket: the client drops what the bucket would
//                   refuse, so the track stays open and the host counts no `track-rate` close
//   view-token      the view token as a credential: a typed `track-unauthorized`/`view-token`
//                   close, no reconnect; the host counts it apart
//   wrong-credential  `track-unauthorized`/`wrong`, no reconnect (SABOTAGE if it loops: the host
//                   would count more than one refusal and the page more than one connection)
//   kind-refused / format-refused   typed closes, no reconnect
//   local-guard     the view token as `credential` with the endpoint's token set throws
//                   `track-credential-is-view-token` and never connects
//   no-receiver     (a second host with no receiver) `track-no-receiver` 1013: the client keeps
//                   reconnecting with backoff, then close() stops it
//   stream-ended    SIGTERM of the host: the open track closes `stream-ended` 1001 and the client
//                   plans a reconnect
// No browser, no check: if the pinned Chromium is missing the leg says so and exits 0 (skipped).
//
//   tsx --conditions=development experiments/render-stream/scripts/client-track-check.ts \
//     --dir <out> [--port <page port>]

import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Page } from "playwright-core";
import {
  BROWSER_LAUNCH_ARGS,
  checkBrowserProvenance,
  HarnessServer,
  launchHarnessBrowser,
  resolvePinnedChromium,
} from "./lib/browser-harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = resolve(HERE, "..");
const HOST = join(RS, "capture", "build", "rs_live_host");
const PAGE_DIR = join(RS, "web", "client-track-check");
const VIEW_TOKEN = "cd".repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith("--") || a[i + 1] === undefined)
      throw new Error(`client-track-check: bad argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  if (!out.dir) throw new Error("client-track-check: --dir is required");
  return out;
}

interface Host {
  proc: ChildProcess;
  port: number;
  dir: string;
  credential: string;
  out: string;
  exited: Promise<number | null>;
}

async function startHost(
  dir: string,
  origin: string,
  extra: string[],
): Promise<Host> {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "track-out.jsonl");
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GRC_")) delete env[k];
  env.GRC_LIVE_ALLOWED_ORIGINS = origin;
  const proc = spawn(
    HOST,
    [
      "--tracks=input",
      `--evidence-dir=${dir}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--token=${VIEW_TOKEN}`,
      `--track-out=${out}`,
      ...extra,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((r) => proc.on("exit", r));
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const got: Record<string, string> = {};
  await new Promise<void>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`rs_live_host did not start\n${stderr}`)),
      15000,
    );
    createInterface({ input: proc.stdout as NodeJS.ReadableStream }).on(
      "line",
      (l) => {
        const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
        if (m) got[m[1]] = m[2];
        if (got.RS_LIVE_HOST_PORT && got.RS_LIVE_HOST_TRACK_TOKEN_FILE) {
          clearTimeout(t);
          res();
        }
      },
    );
    proc.on("exit", (c) =>
      rej(new Error(`rs_live_host exited ${c} before listening\n${stderr}`)),
    );
  });
  return {
    proc,
    port: Number(got.RS_LIVE_HOST_PORT),
    dir,
    credential: readFileSync(got.RS_LIVE_HOST_TRACK_TOKEN_FILE, "utf8").trim(),
    out,
    exited,
  };
}

async function stopHost(h: Host): Promise<void> {
  if (h.proc.exitCode !== null) return;
  h.proc.kill("SIGTERM");
  const t = setTimeout(() => h.proc.kill("SIGKILL"), 10000);
  await h.exited;
  clearTimeout(t);
}

interface Rec {
  event: "opened" | "message" | "closed";
  source: number;
  text?: string;
  code?: number;
  reason?: string;
}
const records = (h: Host): Rec[] =>
  existsSync(h.out)
    ? readFileSync(h.out, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Rec)
    : [];

interface KindStats {
  opened?: number;
  closed?: number;
  refused?: Record<string, number>;
  closes?: Record<string, number>;
}
interface TracksJson {
  refused?: Record<string, number>;
  tracks?: Record<string, KindStats>;
}
const evidence = (h: Host): TracksJson =>
  JSON.parse(readFileSync(join(h.dir, "live-tracks.json"), "utf8"));

interface PageState {
  state: string;
  ready: {
    source: number;
    format: string;
    downFormat: string | null;
    keepaliveMs: number;
  } | null;
  opens: unknown[];
  messages: string[];
  closes: {
    code: number;
    reason: string;
    detail: string | null;
    by: string;
    opened: boolean;
    willReconnect: boolean;
    reconnectInMs: number | null;
  }[];
  states: string[];
  stats: {
    sent: number;
    received: number;
    keepalivesSent: number;
    connections: number;
    dropped: { rate: number; notOpen: number; tooLarge: number; empty: number };
  };
}

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "client-track.json");
  if (!existsSync(HOST)) {
    console.log(
      `client-track-check: SKIP ${HOST} is not built (scripts/build-capture.sh, or cmake --build capture/build --target rs_live_host)`,
    );
    writeFileSync(reportPath, JSON.stringify({ skipped: "no rs_live_host" }));
    return 0;
  }
  try {
    resolvePinnedChromium();
  } catch (e) {
    console.log(`client-track-check: SKIP ${String(e)}`);
    writeFileSync(
      reportPath,
      JSON.stringify({ skipped: "no pinned Chromium", why: String(e) }),
    );
    return 0;
  }

  const staticDir = join(dir, "static");
  rmSync(staticDir, { recursive: true, force: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(
    join(staticDir, "index.html"),
    readFileSync(join(PAGE_DIR, "index.html")),
  );
  const bundle = await build({
    entryPoints: [join(PAGE_DIR, "page.ts")],
    bundle: true,
    splitting: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    conditions: ["development"],
    outdir: staticDir,
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(bundle.metafile?.inputs ?? {}).map((p) =>
    p.replace(/^.*packages\//, "packages/"),
  );
  const server = new HarnessServer({
    staticRoot: staticDir,
    evidenceRoot: join(dir, "evidence"),
    allowedLegNonces: [],
  });
  const { origin } = await server.start(Number(a.port ?? 0));

  const hostA = await startHost(join(dir, "host-a"), origin, [
    "--track-rate=100",
    "--track-keepalive-ms=250",
    "--track-down-formats=gsw-input-feedback/1",
    "--track-echo",
  ]);
  const hostB = await startHost(join(dir, "host-b"), origin, [
    "--track-receiver=none",
    "--track-keepalive-ms=250",
  ]);
  const launched = await launchHarnessBrowser();
  const checks: { id: string; passed: boolean; detail: string }[] = [];
  const check = (id: string, passed: boolean, detail: string) => {
    checks.push({ id, passed, detail });
    console.log(
      `client-track-check: ${passed ? "pass" : "FAIL"} ${id}: ${detail}`,
    );
  };
  const report: Record<string, unknown> = {
    schema: "render-stream-client-track-check/1",
    origin,
    chromium: launched.browser.version(),
    page_inputs: inputs.filter((p) => p.includes("render-stream-client")),
  };

  try {
    const page: Page = await launched.browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page] ${m.text()}`);
    });
    page.on("pageerror", (e) => console.log(`[page error] ${String(e)}`));
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__trk !== undefined,
    );
    const prov = await checkBrowserProvenance(
      page,
      launched,
      [...BROWSER_LAUNCH_ARGS],
      { DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    );
    check("browser-provenance", prov.ok, prov.reasons.join("; ") || "ok");
    check(
      "page-imports-no-view-client",
      !inputs.some((p) =>
        /render-stream-client\/src\/(client|loop|loader|core|extensions)\.ts$/.test(
          p,
        ),
      ),
      `${inputs.filter((p) => p.includes("render-stream-client")).join(", ")}`,
    );

    const wsUrl = (h: Host) => `ws://127.0.0.1:${h.port}/render-stream`;
    const open = (
      name: string,
      h: Host,
      o: Record<string, unknown>,
      token?: string,
    ) =>
      page.evaluate(
        ([n, ep, opt]) =>
          (
            window as unknown as {
              __trk: { open(n: string, e: unknown, o: unknown): string | null };
            }
          ).__trk.open(n, ep, opt),
        [
          name,
          { url: wsUrl(h), ...(token ? { token } : {}) },
          {
            kind: "input",
            formats: ["gsw-input/1"],
            credential: h.credential,
            client: `trk4-${name}`,
            ...o,
          },
        ] as const,
      );
    const get = (name: string) =>
      page.evaluate(
        (n) =>
          (
            window as unknown as { __trk: { get(n: string): unknown } }
          ).__trk.get(n),
        name,
      ) as Promise<PageState>;
    const send = (name: string, texts: string[]) =>
      page.evaluate(
        ([n, t]) =>
          (
            window as unknown as {
              __trk: { send(n: string, t: string[]): boolean[] };
            }
          ).__trk.send(n, t),
        [name, texts] as const,
      );
    const close = (name: string) =>
      page.evaluate(
        (n) =>
          (
            window as unknown as { __trk: { close(n: string): void } }
          ).__trk.close(n),
        name,
      );
    const until = async (
      name: string,
      pred: (s: PageState) => boolean,
      ms = 5000,
    ): Promise<PageState> => {
      const t0 = Date.now();
      let s = await get(name);
      while (!pred(s) && Date.now() - t0 < ms) {
        await sleep(25);
        s = await get(name);
      }
      return s;
    };

    // echo
    {
      const payloads = Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({ n: i, key: "KeyA", text: "é→😀" }),
      );
      await open("echo", hostA, { downFormats: ["gsw-input-feedback/1"] });
      let s = await until("echo", (x) => x.state === "open");
      const source = s.ready?.source ?? -1;
      const sent = await send("echo", payloads);
      s = await until("echo", (x) => x.messages.length >= payloads.length);
      await close("echo");
      const closed = await until("echo", (x) => x.state === "closed");
      await sleep(200);
      const recs = records(hostA).filter((r) => r.source === source);
      check(
        "echo-negotiated",
        s.ready?.format === "gsw-input/1" &&
          s.ready.downFormat === "gsw-input-feedback/1" &&
          s.ready.keepaliveMs === 250,
        JSON.stringify(s.ready),
      );
      check(
        "echo-delivered",
        sent.every(Boolean) &&
          JSON.stringify(
            recs.filter((r) => r.event === "message").map((r) => r.text),
          ) === JSON.stringify(payloads) &&
          recs[0]?.event === "opened" &&
          recs.at(-1)?.event === "closed" &&
          recs.at(-1)?.code === 1000,
        `receiver saw ${recs.length} records, last ${JSON.stringify(recs.at(-1))}`,
      );
      check(
        "echo-returned",
        JSON.stringify(s.messages) === JSON.stringify(payloads),
        `${s.messages.length} echoed`,
      );
      check(
        "echo-close-typed",
        closed.closes.length === 1 &&
          closed.closes[0].by === "client" &&
          !closed.closes[0].willReconnect &&
          closed.states.join(",") === "connecting,open,closed",
        JSON.stringify({ closes: closed.closes, states: closed.states }),
      );
    }

    // keepalive
    {
      await open("keepalive", hostA, {});
      let s = await until("keepalive", (x) => x.state === "open");
      const source = s.ready?.source ?? -1;
      await sleep(1600);
      s = await get("keepalive");
      const msgs = records(hostA).filter(
        (r) => r.source === source && r.event === "message",
      );
      check(
        "keepalive",
        s.state === "open" && s.stats.keepalivesSent >= 3 && msgs.length === 0,
        `state ${s.state}, ${s.stats.keepalivesSent} keepalives sent, receiver saw ${msgs.length} messages`,
      );
      await close("keepalive");
    }

    // rate (host bucket: 100/s, burst 200)
    {
      await open("rate", hostA, {});
      await until("rate", (x) => x.state === "open");
      const results = await send(
        "rate",
        Array.from({ length: 1000 }, (_, i) => `{"n":${i}}`),
      );
      await sleep(400);
      const s = await get("rate");
      const accepted = results.filter(Boolean).length;
      const closes = evidence(hostA).tracks?.input?.closes ?? {};
      check(
        "rate-dropped-not-closed",
        s.state === "open" &&
          accepted <= 220 &&
          accepted >= 200 &&
          s.stats.dropped.rate === 1000 - accepted &&
          closes["track-rate"] === undefined,
        `accepted ${accepted} of 1000, ${s.stats.dropped.rate} dropped, state ${s.state}, host closes ${JSON.stringify(closes)}`,
      );
      await close("rate");
    }

    // refusals, each followed by a wait longer than the reconnect backoff would take
    const refusal = async (
      name: string,
      h: Host,
      o: Record<string, unknown>,
      reason: string,
      detail: string | null,
      code: number,
    ) => {
      await open(name, h, o);
      await until(name, (x) => x.state === "closed", 3000);
      await sleep(1500); // would hold several reconnects at 250 ms doubling
      const s = await get(name);
      const c = s.closes[0];
      check(
        `${name}`,
        s.state === "closed" &&
          s.closes.length === 1 &&
          s.stats.connections === 1 &&
          c.reason === reason &&
          c.detail === detail &&
          c.code === code &&
          c.by === "host" &&
          !c.opened &&
          !c.willReconnect &&
          s.opens.length === 0,
        JSON.stringify({
          state: s.state,
          connections: s.stats.connections,
          closes: s.closes,
        }),
      );
    };
    await refusal(
      "view-token",
      hostA,
      { credential: VIEW_TOKEN },
      "track-unauthorized",
      "view-token",
      1008,
    );
    await refusal(
      "wrong-credential",
      hostA,
      { credential: "ee".repeat(32) },
      "track-unauthorized",
      "wrong",
      1008,
    );
    await refusal(
      "kind-refused",
      hostA,
      { kind: "clipboard" },
      "track-kind-refused",
      null,
      1008,
    );
    await refusal(
      "format-refused",
      hostA,
      { formats: ["x-other-thing/1"] },
      "track-format-refused",
      null,
      1008,
    );
    // local guard
    {
      const code = await open(
        "guard",
        hostA,
        { credential: VIEW_TOKEN },
        VIEW_TOKEN,
      );
      await sleep(300);
      check(
        "local-guard",
        code === "track-credential-is-view-token",
        `threw ${code} (the host-side counts below show it never connected)`,
      );
    }

    // no receiver: retried with backoff until close()
    {
      await open("no-receiver", hostB, {
        reconnect: { initialMs: 100, maxMs: 400 },
      });
      const s = await until(
        "no-receiver",
        (x) => x.stats.connections >= 4,
        6000,
      );
      await close("no-receiver");
      const s2 = await get("no-receiver");
      await sleep(800);
      const s3 = await get("no-receiver");
      const first = s.closes[0];
      check(
        "no-receiver-retried",
        first?.reason === "track-no-receiver" &&
          first.code === 1013 &&
          first.willReconnect &&
          s.stats.connections >= 4 &&
          s3.stats.connections === s2.stats.connections &&
          s3.state === "closed",
        `${s.stats.connections} connections, first close ${JSON.stringify(first)}, after close() ${s3.stats.connections}`,
      );
    }

    // stream-ended: the host stops while a track is open
    {
      await open("ended", hostA, {});
      await until("ended", (x) => x.state === "open");
      await stopHost(hostA);
      const s = await until("ended", (x) => x.closes.length > 0, 5000);
      const c = s.closes[0];
      check(
        "stream-ended",
        c?.reason === "stream-ended" &&
          c.code === 1001 &&
          c.by === "host" &&
          c.opened &&
          c.willReconnect,
        JSON.stringify(c),
      );
      await close("ended");
      {
        // The host wrote its final counts at stop: each leg above was one connection, so the view
        // token was refused once (not by a reconnect loop, nor by the guard's leg).
        const t = evidence(hostA);
        const k = t.tracks?.input ?? {};
        const refused = k.refused ?? {};
        check(
          "host-counts-each-refusal-once",
          refused["track-unauthorized:view-token"] === 1 &&
            refused["track-unauthorized"] === 1 &&
            refused["track-format-refused"] === 1 &&
            t.refused?.["track-kind-refused"] === 1 &&
            k.opened === 4,
          JSON.stringify({ opened: k.opened, input: refused, top: t.refused }),
        );
      }
      // The host is gone: close() must stop any retry (no unbounded timer left in the page).
      const s2 = await get("ended");
      check("closed-after-host-gone", s2.state === "closed", s2.state);
    }
    await page.close();
  } catch (e) {
    check("leg-completed", false, String((e as Error).stack ?? e));
  } finally {
    report.checks = checks;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
    await stopHost(hostA);
    await stopHost(hostB);
  }
  const failed = checks.filter((c) => !c.passed);
  console.log(
    `client-track-check: ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
