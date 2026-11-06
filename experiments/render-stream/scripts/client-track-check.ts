// TRK4 live leg (protocol/tracks-design.md Q10, the TRK4 row): drives web/client-track-check/ (the
// client package's `./tracks` subpath alone) in the pinned headless Chromium against
// capture/build/rs_live_host --tracks with an echo receiver, over ws (default) or, TRK3, the net
// module's wt carrier. Legs and checks (written to <dir>/client-track.json; exit 1 when one fails):
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
//   cred-*          CRED1, against a third host under GRC_LIVE_TRACK_CAPS=hmac (`--track-caps=hmac`)
//                   whose capabilities the driver mints (scripts/lib/track-cap.ts) and the page's
//                   credential provider asks for through `window.__mintCap`:
//                   cred-static-expired   a string capability already past exp + 30 s: `expired`,
//                                         final, one connection (the pre-CRED1 behaviour, kept)
//                   cred-expired-retried  a provider whose first value is expired and second fresh:
//                                         `expired` is not final, the retry opens with the new value
//                   cred-refresh-after-drop  a capability with exp 2 s ahead, held past its exp, the
//                                         transport dropped: the reconnect's hello carries a freshly
//                                         minted capability (a different one), the receiver sees
//                                         two opens with the viewer's subject
//                   cred-provider-failure  a provider that throws once, then answers: the typed
//                                         `track-credential-failed` close, a retry, then open
//                   cred-close-while-pending  a provider that never answers and close(): closed, no
//                                         connection reaches the host
//                   cred-host-counts      (after the host stops) the host counted one `expired`
//                                         refusal per expired value, opened the right number of
//                                         tracks and counted no other refusal
//   carrier-is-ws / carrier-is-wt  (after the last leg, per pass) every track the host's receiver
//                   saw opened carries `carrier` = the pass's carrier, live-tracks.json says that
//                   carrier serves tracks, and the page constructed only that transport's class
//                   (WebSocket vs WebTransport, counted by page.ts)
// --carrier ws|wt|both (default ws, which is exactly the pre-TRK3 run): `wt` starts both hosts with
// `--carriers=ws,wt --net-module=capture/build/librender_stream_net.so`, pins the host's
// self-signed certificate through `serverCertificateHashes` and opens every track with
// `carrier: "webtransport"`; `both` runs a ws pass then a wt pass in one browser launch and one
// report. In the report `checks` is flat (wt ids are prefixed `wt:`), `carrier` is the flag and
// `passes` has one `{ carrier, wall_ms, checks }` per pass. Over wt the host's close arrives as a
// CLOSE_WEBTRANSPORT_SESSION code; the same typed closes and reconnect rules must hold.
// No browser, no check: if the pinned Chromium is missing the leg says so and exits 0 (skipped);
// so it does when rs_live_host is not built, or (wt) librender_stream_net.so is not (with `both`
// only the wt pass is skipped).
//
//   tsx --conditions=development experiments/render-stream/scripts/client-track-check.ts \
//     --dir <out> [--port <page port>] [--carrier ws|wt|both]

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
import { mintTrackCap, readCapKeyFile } from "./lib/track-cap";

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = resolve(HERE, "..");
const HOST = join(RS, "capture", "build", "rs_live_host");
const NET_MODULE = join(RS, "capture", "build", "librender_stream_net.so");
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
  /** The capability key file (GRC_LIVE_TRACK_CAPS=hmac), or "". */
  capKeyFile: string;
  /** UDP port and certificate hash (hex SHA-256) of the `wt` carrier; 0 and "" when it is off. */
  wtPort: number;
  cert: string;
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
  const wt = extra.includes("--carriers=ws,wt");
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
        if (
          got.RS_LIVE_HOST_PORT &&
          (got.RS_LIVE_HOST_TRACK_TOKEN_FILE ||
            got.RS_LIVE_HOST_TRACK_CAP_KEY_FILE) &&
          (!wt || (got.RS_LIVE_HOST_WT_PORT && got.RS_LIVE_HOST_CERT_SHA256))
        ) {
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
    credential: got.RS_LIVE_HOST_TRACK_TOKEN_FILE
      ? readFileSync(got.RS_LIVE_HOST_TRACK_TOKEN_FILE, "utf8").trim()
      : "",
    capKeyFile: got.RS_LIVE_HOST_TRACK_CAP_KEY_FILE ?? "",
    wtPort: Number(got.RS_LIVE_HOST_WT_PORT ?? 0),
    cert: got.RS_LIVE_HOST_CERT_SHA256 ?? "",
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
  carrier?: string;
  text?: string;
  code?: number;
  reason?: string;
  subject?: string;
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
  carriers?: { name: string; tracks: boolean | null }[];
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
  mints: string[];
  mintCalls: number;
  stats: {
    sent: number;
    received: number;
    keepalivesSent: number;
    connections: number;
    dropped: { rate: number; notOpen: number; tooLarge: number; empty: number };
  };
}

type Check = { id: string; passed: boolean; detail: string };
interface PassContext {
  dir: string;
  origin: string;
  launched: Awaited<ReturnType<typeof launchHarnessBrowser>>;
  inputs: string[];
  first: boolean;
}

/** One full run of every leg over one carrier, with its own pair of hosts and its own page. */
async function runPass(
  carrier: "ws" | "wt",
  ctx: PassContext,
  report: Record<string, unknown>,
): Promise<Check[]> {
  const { dir, origin, launched, inputs } = ctx;
  // ws: the hosts exactly as before TRK3. wt: the net module's carriers beside ws.
  const more =
    carrier === "wt" ? ["--carriers=ws,wt", `--net-module=${NET_MODULE}`] : [];
  const sub = carrier === "wt" ? "wt-" : "";
  const hostA = await startHost(join(dir, `${sub}host-a`), origin, [
    "--track-rate=100",
    "--track-keepalive-ms=250",
    "--track-down-formats=gsw-input-feedback/1",
    "--track-echo",
    ...more,
  ]);
  const hostB = await startHost(join(dir, `${sub}host-b`), origin, [
    "--track-receiver=none",
    "--track-keepalive-ms=250",
    ...more,
  ]);
  const hostC = await startHost(join(dir, `${sub}host-c`), origin, [
    "--track-caps=hmac",
    "--track-keepalive-ms=250",
    ...more,
  ]);
  type MintStep = "expired" | "short" | "fresh" | "throw" | "hang";
  const plans = new Map<string, MintStep[]>();
  const checks: Check[] = [];
  const check = (id: string, passed: boolean, detail: string) => {
    checks.push({ id: carrier === "wt" ? `wt:${id}` : id, passed, detail });
    console.log(
      `client-track-check: ${passed ? "pass" : "FAIL"} ${carrier === "wt" ? "wt:" : ""}${id}: ${detail}`,
    );
  };
  try {
    const page: Page = await launched.browser.newPage();
    // CRED1: the page's credential provider asks the driver, which holds the key, per call. The
    // plan for a track is consumed one entry per call; the last entry repeats.
    await page.exposeFunction("__mintCap", (name: string) => {
      const plan = plans.get(name) ?? ["fresh"];
      const step = plan.length > 1 ? (plan.shift() as MintStep) : plan[0];
      if (step === "throw") throw new Error("mint server down");
      if (step === "hang") return new Promise<string>(() => {});
      const now = Math.floor(Date.now() / 1000);
      const exp = { expired: now - 40, short: now + 2, fresh: now + 300 }[step];
      return Promise.resolve(
        mintTrackCap(readCapKeyFile(hostC.capKeyFile), {
          kind: "input",
          sub: "viewer-1",
          exp,
        }),
      );
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[page] ${m.text()}`);
    });
    page.on("pageerror", (e) => console.log(`[page error] ${String(e)}`));
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__trk !== undefined,
    );
    if (ctx.first) {
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
    }

    const wsUrl = (h: Host) => `ws://127.0.0.1:${h.port}/render-stream`;
    const endpoint = (h: Host, token?: string) => ({
      url: wsUrl(h),
      ...(carrier === "wt"
        ? {
            webTransport: {
              url: `https://127.0.0.1:${h.wtPort}/render-stream`,
              certificateHashes: [h.cert],
            },
          }
        : {}),
      ...(token ? { token } : {}),
    });
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
          endpoint(h, token),
          {
            kind: "input",
            formats: ["gsw-input/1"],
            credential: h.credential,
            client: `trk4-${name}`,
            carrier: carrier === "wt" ? "webtransport" : "websocket",
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
        // Which transport carried every track, on both sides: the host's receiver saw
        // `opened.carrier` (the CarrierSet's name for the connection), live-tracks.json says the
        // carrier serves tracks, and the page counts the constructors it called.
        const opened = records(hostA).filter((r) => r.event === "opened");
        const tc = t.carriers?.find((c) => c.name === carrier);
        const pageT = await page.evaluate(() =>
          (
            window as unknown as {
              __trk: {
                transports(): { websocket: number; webtransport: number };
              };
            }
          ).__trk.transports(),
        );
        report.page_transports = {
          ...(report.page_transports as object | undefined),
          [carrier]: pageT,
        };
        check(
          `carrier-is-${carrier}`,
          opened.length === k.opened &&
            opened.length > 0 &&
            opened.every((r) => r.carrier === carrier) &&
            tc?.tracks === true &&
            (carrier === "wt"
              ? pageT.webtransport > 0 && pageT.websocket === 0
              : pageT.websocket > 0 && pageT.webtransport === 0),
          JSON.stringify({
            opened: opened.map((r) => r.carrier),
            live_tracks_carrier: tc ?? null,
            page: pageT,
          }),
        );
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

    // CRED1 legs (hostC mints capabilities; the page's provider asks `__mintCap`).
    {
      const nowS = () => Math.floor(Date.now() / 1000);
      const capOpen = (name: string, o: Record<string, unknown>) =>
        open(name, hostC, { credential: undefined, ...o });
      const capStatic = (exp: number) =>
        mintTrackCap(readCapKeyFile(hostC.capKeyFile), {
          kind: "input",
          sub: "viewer-1",
          exp,
        });

      // A string capability already past exp + 30 s: final, one connection.
      await capOpen("cred-static", { credential: capStatic(nowS() - 40) });
      await until("cred-static", (x) => x.state === "closed", 3000);
      await sleep(1500);
      {
        const s = await get("cred-static");
        const c = s.closes[0];
        check(
          "cred-static-expired",
          s.state === "closed" &&
            s.closes.length === 1 &&
            s.stats.connections === 1 &&
            c.reason === "track-unauthorized" &&
            c.detail === "expired" &&
            !c.willReconnect,
          JSON.stringify({
            state: s.state,
            connections: s.stats.connections,
            closes: s.closes,
          }),
        );
      }

      // A provider whose first value is expired and whose second is fresh.
      plans.set("cred-exp", ["expired", "fresh"]);
      await capOpen("cred-exp", { provider: true });
      {
        const s = await until("cred-exp", (x) => x.state === "open", 6000);
        const c = s.closes[0];
        check(
          "cred-expired-retried",
          s.state === "open" &&
            s.mintCalls === 2 &&
            s.mints.length === 2 &&
            s.mints[0] !== s.mints[1] &&
            c?.reason === "track-unauthorized" &&
            c.detail === "expired" &&
            c.willReconnect === true &&
            s.stats.connections === 2 &&
            s.opens.length === 1,
          JSON.stringify({
            state: s.state,
            mintCalls: s.mintCalls,
            closes: s.closes,
            connections: s.stats.connections,
          }),
        );
        await close("cred-exp");
      }

      // exp 2 s ahead, held past its exp, transport dropped: the reconnect carries a new capability.
      plans.set("cred-refresh", ["short", "fresh"]);
      await capOpen("cred-refresh", { provider: true });
      {
        let s = await until("cred-refresh", (x) => x.state === "open");
        await sleep(2600); // past the first capability's exp (the host's 30 s skew still admits it)
        const dropped = await page.evaluate(() =>
          (window as unknown as { __trk: { drop(): string } }).__trk.drop(),
        );
        s = await until(
          "cred-refresh",
          (x) => x.opens.length >= 2 && x.state === "open",
          8000,
        );
        const cap = (t: string) =>
          JSON.parse(
            Buffer.from(t.split(".")[1], "base64url").toString("utf8"),
          ) as { exp: number; nonce: string };
        const [m1, m2] = s.mints.map(cap);
        await close("cred-refresh");
        await sleep(200);
        const subjects = records(hostC)
          .filter((r) => r.event === "opened")
          .map((r) => r.subject);
        check(
          "cred-refresh-after-drop",
          dropped === (carrier === "wt" ? "webtransport" : "websocket") &&
            s.mints.length === 2 &&
            m1 !== undefined &&
            m2 !== undefined &&
            m1.nonce !== m2.nonce &&
            m2.exp > m1.exp + 100 &&
            m1.exp < nowS() &&
            s.opens.length === 2 &&
            s.stats.connections === 2 &&
            s.closes.length === 1 &&
            s.closes[0].willReconnect === true &&
            subjects.filter((x) => x === "viewer-1").length >= 2,
          JSON.stringify({
            dropped,
            exps: [m1?.exp, m2?.exp],
            opens: s.opens.length,
            closes: s.closes,
            subjects,
          }),
        );
      }

      // A provider that fails once (the page sees the driver's throw as a rejection).
      plans.set("cred-fail", ["throw", "fresh"]);
      await capOpen("cred-fail", {
        provider: true,
        reconnect: { initialMs: 100, maxMs: 400 },
      });
      {
        const s = await until("cred-fail", (x) => x.state === "open", 6000);
        const c = s.closes[0];
        check(
          "cred-provider-failure",
          s.state === "open" &&
            c?.reason === "track-credential-failed" &&
            c.by === "client" &&
            (c.detail ?? "").startsWith("rejected") &&
            c.willReconnect === true &&
            s.stats.connections === 2,
          JSON.stringify({
            state: s.state,
            closes: s.closes,
            connections: s.stats.connections,
          }),
        );
        await close("cred-fail");
      }

      // A provider that never answers, then close().
      plans.set("cred-hang", ["hang"]);
      await capOpen("cred-hang", { provider: true });
      await sleep(300);
      {
        const before = await get("cred-hang");
        await close("cred-hang");
        await sleep(300);
        const s = await get("cred-hang");
        check(
          "cred-close-while-pending",
          before.state === "connecting" &&
            before.mintCalls === 1 &&
            s.state === "closed" &&
            s.closes.length === 1 &&
            s.closes[0].reason === "client-close" &&
            s.stats.connections === 1 &&
            s.opens.length === 0,
          JSON.stringify({
            before: before.state,
            state: s.state,
            closes: s.closes,
          }),
        );
      }

      // After the host stops: counts. cred-static and cred-exp's first value were each refused
      // `expired` once; opened = cred-exp, cred-refresh x2, cred-fail.
      await stopHost(hostC);
      {
        const k = evidence(hostC).tracks?.input ?? {};
        const refused = k.refused ?? {};
        check(
          "cred-host-counts",
          refused["track-unauthorized:expired"] === 2 &&
            Object.keys(refused).length === 1 &&
            k.opened === 4,
          JSON.stringify({ opened: k.opened, refused }),
        );
      }
    }
    await page.close();
  } catch (e) {
    check("leg-completed", false, String((e as Error).stack ?? e));
  } finally {
    await stopHost(hostA);
    await stopHost(hostB);
    await stopHost(hostC);
  }
  return checks;
}

async function main(): Promise<number> {
  const a = args();
  const dir = resolve(a.dir);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "client-track.json");
  const carrierArg = a.carrier ?? "ws";
  if (!["ws", "wt", "both"].includes(carrierArg))
    throw new Error("client-track-check: --carrier must be ws, wt or both");
  const passes: ("ws" | "wt")[] =
    carrierArg === "both" ? ["ws", "wt"] : [carrierArg as "ws" | "wt"];
  if (!existsSync(HOST)) {
    console.log(
      `client-track-check: SKIP ${HOST} is not built (scripts/build-capture.sh, or cmake --build capture/build --target rs_live_host)`,
    );
    writeFileSync(reportPath, JSON.stringify({ skipped: "no rs_live_host" }));
    return 0;
  }
  const skippedPasses: { carrier: string; skipped: string }[] = [];
  if (passes.includes("wt") && !existsSync(NET_MODULE)) {
    const why = `${NET_MODULE} is not built (cmake --build capture/build --target render_stream_net)`;
    console.log(`client-track-check: SKIP wt pass: ${why}`);
    if (carrierArg === "wt") {
      writeFileSync(
        reportPath,
        JSON.stringify({ skipped: "no librender_stream_net.so", why }),
      );
      return 0;
    }
    passes.splice(passes.indexOf("wt"), 1);
    skippedPasses.push({
      carrier: "wt",
      skipped: "no librender_stream_net.so",
    });
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

  const launched = await launchHarnessBrowser();
  const checks: Check[] = [];
  const report: Record<string, unknown> = {
    schema: "render-stream-client-track-check/1",
    carrier: carrierArg,
    origin,
    chromium: launched.browser.version(),
    page_inputs: inputs.filter((p) => p.includes("render-stream-client")),
  };
  const passReports: Record<string, unknown>[] = [...skippedPasses];
  try {
    let first = true;
    for (const carrier of passes) {
      const t0 = Date.now();
      const pc = await runPass(
        carrier,
        { dir, origin, launched, inputs, first },
        report,
      );
      first = false;
      checks.push(...pc);
      passReports.push({ carrier, wall_ms: Date.now() - t0, checks: pc });
    }
  } finally {
    report.checks = checks;
    report.passes = passReports;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await launched.browser.close().catch(() => {});
    await server.stop().catch(() => {});
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
