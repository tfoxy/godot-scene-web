// CAR2 (protocol/carrier-design.md D10, F6, Security): opt-in LAN serving, end to end through the
// production hub, CarrierSet, rs_ws and the net module, with capture/build/rs_live_host (the same
// functions as entry.cpp: capture/src/rs_expose.cpp; entry.cpp's own wiring is also judged by
// run-gate8.sh's g8l/lan leg). Four parts:
//   1. the refusal matrix: GRC_LIVE_EXPOSE / GRC_LIVE_LISTEN / GRC_LIVE_WT_LISTEN / token /
//      origins combinations, each exiting 2 with the typed reason and never listening. Includes
//      the sabotage "expose without a token" (lan-needs-token) and without origins;
//   2. ws on 0.0.0.0 under lan, reached through this machine's non-loopback IPv4 address: a /7
//      session whose received bytes equal the hub tap's, and equal (message count, close) to a
//      second session over 127.0.0.1; a foreign Origin gets 403; a resource GET without the
//      token gets 401 and with it 200; a hello with no token is refused. Typed `unavailable`
//      (skipped, not failed) when the machine has no non-loopback IPv4 address;
//   3. wt on 0.0.0.0 the same way (the rs-net-probe client through the LAN address);
//   4. live-carriers.json records `expose: lan`, ws `tls: none` and wt `self-signed`; the
//      default (no GRC_LIVE_EXPOSE) records `loopback`.
// Builds the net module and the probe first (scripts/build-rs-net.sh --no-test; a no-op if fresh).
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/self-test-lan.ts [--keep]
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const MODULE = join(RS, "capture/build/librender_stream_net.so");
const PROBE = join(RS, "rs-net/target/release/rs-net-probe");
const HASH = "1".repeat(64);
const TOKEN = "ab".repeat(32);
const ORIGIN = "http://lan.example:5173";
const keep = process.argv.includes("--keep");

let failed = 0;
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
}

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("127."))
        return a.address;
  return null;
}

function hello7(token: string | null): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/7",
    receiver: "lan-test",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: 1,
    inbound_buffer_bytes: 16777216,
    token,
    manifest_sha256: null,
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 1000,
  });
}

interface Host {
  proc: ChildProcess;
  wsPort: number;
  wtPort: number;
  cert: string;
  exited: Promise<number | null>;
}

interface Run {
  code: number | null;
  stderr: string;
  stdout: string;
}

/** A host that must refuse: the exit code and what it printed. */
async function refused(
  env: Record<string, string>,
  args: string[] = [],
): Promise<Run> {
  return new Promise((res) => {
    const p = spawn(HOST, [`--net-module=${MODULE}`, ...args], {
      env: { ...cleanEnv(), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout!.on("data", (d) => {
      stdout += String(d);
    });
    p.stderr!.on("data", (d) => {
      stderr += String(d);
    });
    const t = setTimeout(() => p.kill("SIGKILL"), 8000);
    p.on("exit", (code) => {
      clearTimeout(t);
      res({ code, stderr, stdout });
    });
  });
}

function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GRC_")) delete e[k];
  return e;
}

async function startHost(
  dir: string,
  env: Record<string, string>,
  args: string[],
  wt: boolean,
): Promise<Host> {
  const proc = spawn(
    HOST,
    [
      ...args,
      `--carriers=${wt ? "ws,wt" : "ws"}`,
      `--net-module=${MODULE}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--evidence-dir=${dir}`,
      `--summary=${join(dir, "live-summary.json")}`,
    ],
    { env: { ...cleanEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((r) =>
    proc.on("exit", (c) => r(c)),
  );
  const lines = createInterface({ input: proc.stdout! });
  const got: Record<string, string> = {};
  proc.stderr!.on("data", () => {});
  await new Promise<void>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error("rs_live_host did not print its ports")),
      15000,
    );
    lines.on("line", (l) => {
      const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
      if (m) got[m[1]] = m[2];
      if (
        got.RS_LIVE_HOST_PORT &&
        (!wt || (got.RS_LIVE_HOST_WT_PORT && got.RS_LIVE_HOST_CERT_SHA256))
      ) {
        clearTimeout(t);
        res();
      }
    });
    proc.on("exit", (c) =>
      rej(new Error(`rs_live_host exited ${c} before listening`)),
    );
  });
  return {
    proc,
    wsPort: Number(got.RS_LIVE_HOST_PORT),
    wtPort: Number(got.RS_LIVE_HOST_WT_PORT ?? 0),
    cert: got.RS_LIVE_HOST_CERT_SHA256 ?? "",
    exited,
  };
}

interface WsResult {
  messages: Uint8Array[];
  texts: string[];
  close: { code: number; reason: string } | null;
}

function wsClient(
  host: string,
  port: number,
  token: string | null,
): { opened: Promise<void>; done: Promise<WsResult> } {
  const ws = new WebSocket(
    `ws://${host}:${port}/render-stream`,
    "render-stream.7",
  );
  ws.binaryType = "arraybuffer";
  const messages: Uint8Array[] = [];
  const texts: string[] = [];
  let resolveOpen: () => void = () => {};
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const done = new Promise<WsResult>((res) => {
    ws.onopen = () => {
      ws.send(hello7(token));
      resolveOpen();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") texts.push(e.data);
      else messages.push(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = (e) =>
      res({ messages, texts, close: { code: e.code, reason: e.reason } });
    ws.onerror = () => {};
  });
  return { opened, done };
}

function httpStatus(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((res) => {
    const r = request({ host, port, path, method: "GET", headers }, (resp) => {
      resp.resume();
      res(resp.statusCode ?? 0);
    });
    r.on("error", () => res(0));
    r.end();
  });
}

/** An upgrade request with an Origin header (Node's WebSocket client sets none): the status line. */
function upgradeStatus(
  host: string,
  port: number,
  origin: string,
): Promise<number> {
  return new Promise((res) => {
    const r = request({
      host,
      port,
      path: "/render-stream",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": "render-stream.7",
        Origin: origin,
      },
    });
    r.on("response", (resp) => {
      resp.resume();
      res(resp.statusCode ?? 0);
    });
    r.on("upgrade", (resp, socket) => {
      socket.destroy();
      res(resp.statusCode ?? 0);
    });
    r.on("error", () => res(0));
    r.end();
  });
}

function probe(
  host: string,
  port: number,
  cert: string,
  out: string,
  token: string | null,
) {
  const proc = spawn(
    PROBE,
    [
      "--url",
      `https://${host}:${port}/render-stream?protocol=render-stream.7`,
      "--cert-sha256",
      cert,
      "--out",
      out,
      "--hello",
      hello7(token),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let resolveOpen: (v: boolean) => void = () => {};
  const opened = new Promise<boolean>((r) => {
    resolveOpen = r;
  });
  proc.stdout!.on("data", (d) => {
    stdout += String(d);
    if (stdout.includes("PROBE_OPEN")) resolveOpen(true);
    if (stdout.includes("PROBE_CONNECT_FAILED")) resolveOpen(false);
  });
  proc.stderr!.on("data", () => {});
  const done = new Promise<{
    exit: number | null;
    messages: number;
    received: Buffer | null;
    close: number | null;
  }>((res) =>
    proc.on("exit", (exit) => {
      resolveOpen(false);
      const sp = join(out, "probe.json");
      const rp = join(out, "received.rs2");
      const s = existsSync(sp)
        ? (JSON.parse(readFileSync(sp, "utf8")) as {
            messages: number;
            close: { code: number } | null;
          })
        : null;
      res({
        exit,
        messages: s?.messages ?? -1,
        close: s?.close?.code ?? null,
        received: existsSync(rp) ? readFileSync(rp) : null,
      });
    }),
  );
  return { opened, done };
}

/** carrier -> the tap bytes of its connection(s), per tap/live-<n>.jsonl `open` lines (D13). */
function tapsByCarrier(dir: string): Map<string, Buffer[]> {
  const out = new Map<string, Buffer[]>();
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return out;
  for (const f of readdirSync(tap).sort()) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    for (const line of readFileSync(join(tap, f), "utf8").split("\n")) {
      if (!line.includes('"open"')) continue;
      const rec = JSON.parse(line) as { carrier?: string };
      if (rec.carrier) {
        const s = join(tap, `stream-${m[1]}.rs2`);
        out.set(rec.carrier, [
          ...(out.get(rec.carrier) ?? []),
          existsSync(s) ? readFileSync(s) : Buffer.alloc(0),
        ]);
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CarriersJson {
  expose?: string;
  carriers: {
    name: string;
    address: string | null;
    tls: string;
    transport: string;
    status: string;
  }[];
}

const LAN_ENV = {
  GRC_LIVE_EXPOSE: "lan",
  GRC_LIVE_LISTEN: "0.0.0.0:0",
  GRC_LIVE_ALLOWED_ORIGINS: ORIGIN,
};

async function refusalMatrix(): Promise<void> {
  const wt = ["--carriers=ws,wt"];
  const rows: {
    what: string;
    env: Record<string, string>;
    args: string[];
    reason: string;
  }[] = [
    // The default is unchanged: loopback only, the old `non-loopback`.
    {
      what: "no EXPOSE, 0.0.0.0",
      env: { GRC_LIVE_LISTEN: "0.0.0.0:0" },
      args: [`--token=${TOKEN}`],
      reason: "non-loopback",
    },
    {
      what: "EXPOSE=loopback, 0.0.0.0",
      env: { GRC_LIVE_EXPOSE: "loopback", GRC_LIVE_LISTEN: "0.0.0.0:0" },
      args: [`--token=${TOKEN}`],
      reason: "non-loopback",
    },
    {
      what: "no EXPOSE, [::]",
      env: { GRC_LIVE_LISTEN: "[::]:0" },
      args: [],
      reason: "non-loopback",
    },
    {
      what: "no EXPOSE, a host IP",
      env: {
        GRC_LIVE_LISTEN: "192.168.0.5:0",
        GRC_LIVE_ALLOWED_ORIGINS: ORIGIN,
      },
      args: [`--token=${TOKEN}`],
      reason: "non-loopback",
    },
    {
      what: "no EXPOSE, wt on 0.0.0.0",
      env: { GRC_LIVE_WT_LISTEN: "0.0.0.0:0" },
      args: wt,
      reason: "non-loopback",
    },
    {
      what: "EXPOSE=wan",
      env: { ...LAN_ENV, GRC_LIVE_EXPOSE: "wan" },
      args: [`--token=${TOKEN}`],
      reason: "expose-invalid",
    },
    {
      what: "EXPOSE=LAN",
      env: { ...LAN_ENV, GRC_LIVE_EXPOSE: "LAN" },
      args: [`--token=${TOKEN}`],
      reason: "expose-invalid",
    },
    // SABOTAGE: expose without the token must be refused, however the rest is set.
    {
      what: "lan without a token",
      env: { ...LAN_ENV },
      args: [],
      reason: "lan-needs-token",
    },
    {
      what: "lan without a token, loopback listen",
      env: { GRC_LIVE_EXPOSE: "lan", GRC_LIVE_ALLOWED_ORIGINS: ORIGIN },
      args: [],
      reason: "lan-needs-token",
    },
    {
      what: "lan with a token, no origins",
      env: { GRC_LIVE_EXPOSE: "lan", GRC_LIVE_LISTEN: "0.0.0.0:0" },
      args: [`--token=${TOKEN}`],
      reason: "lan-needs-origins",
    },
    {
      what: "lan with a token, empty origins",
      env: { ...LAN_ENV, GRC_LIVE_ALLOWED_ORIGINS: "" },
      args: [`--token=${TOKEN}`],
      reason: "lan-needs-origins",
    },
    {
      what: "lan, token and origins, but a hostname",
      env: { ...LAN_ENV, GRC_LIVE_LISTEN: "localhost:0" },
      args: [`--token=${TOKEN}`],
      reason: "non-loopback",
    },
    {
      what: "lan, wt on a hostname",
      env: { ...LAN_ENV, GRC_LIVE_WT_LISTEN: "example.com:0" },
      args: [...wt, `--token=${TOKEN}`],
      reason: "non-loopback",
    },
    {
      what: "lan without a token, wt",
      env: { ...LAN_ENV, GRC_LIVE_WT_LISTEN: "0.0.0.0:0" },
      args: wt,
      reason: "lan-needs-token",
    },
  ];
  for (const r of rows) {
    const run = await refused(r.env, r.args);
    ok(
      run.code === 2 &&
        run.stderr.includes(r.reason) &&
        !run.stdout.includes("RS_LIVE_HOST_PORT"),
      `refused ${r.reason}: ${r.what} (exit ${run.code}, ${run.stderr.trim().split("\n").pop()})`,
    );
  }
}

async function lanWs(lan: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lan-ws-"));
  try {
    const host = await startHost(dir, LAN_ENV, [`--token=${TOKEN}`], false);
    ok(host.wsPort > 0, `ws bound 0.0.0.0, port ${host.wsPort}`);
    // The same hub over two addresses: the machine's LAN address and loopback.
    const viaLan = wsClient(lan, host.wsPort, TOKEN);
    await viaLan.opened;
    const viaLoop = wsClient("127.0.0.1", host.wsPort, TOKEN);
    await viaLoop.opened;
    ok(
      (await httpStatus(lan, host.wsPort, `/resources/sha256/${HASH}`, {})) ===
        401,
      "LAN resource GET without the token -> 401",
    );
    ok(
      (await httpStatus(lan, host.wsPort, `/resources/sha256/${HASH}`, {
        Authorization: `Bearer ${TOKEN}`,
      })) === 200,
      "LAN resource GET with the token -> 200",
    );
    ok(
      (await upgradeStatus(lan, host.wsPort, "http://evil.example")) === 403,
      "a foreign Origin over the LAN -> 403",
    );
    ok(
      (await upgradeStatus(lan, host.wsPort, ORIGIN)) !== 403,
      "the allowed Origin over the LAN is not refused",
    );
    const bad = wsClient(lan, host.wsPort, null);
    await bad.opened;
    const badResult = await bad.done;
    ok(
      badResult.texts.some((t) => t.includes('"unauthorized"')) &&
        badResult.close?.code === 1008,
      `a hello with no token over the LAN: unauthorized, close 1008 (${JSON.stringify(badResult.close)})`,
    );
    await sleep(1200);
    host.proc.kill("SIGTERM");
    const [a, b, code] = await Promise.all([
      viaLan.done,
      viaLoop.done,
      host.exited,
    ]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    const taps = tapsByCarrier(dir).get("ws") ?? [];
    const received = [Buffer.concat(a.messages), Buffer.concat(b.messages)];
    ok(
      received[0].length > 0 && taps.some((t) => t.equals(received[0])),
      `LAN session's received bytes equal a hub tap (${received[0].length} bytes)`,
    );
    ok(
      taps.some((t) => t.equals(received[1])),
      "loopback session's received bytes equal a hub tap",
    );
    ok(
      a.messages.length >= 3 &&
        a.messages.length === b.messages.length &&
        a.close?.code === b.close?.code,
      `LAN and loopback sessions: same message count and close (${a.messages.length}/${b.messages.length}, ${a.close?.code}/${b.close?.code})`,
    );
    const j = JSON.parse(
      readFileSync(join(dir, "live-carriers.json"), "utf8"),
    ) as CarriersJson;
    const ws = j.carriers.find((c) => c.name === "ws");
    ok(j.expose === "lan", `live-carriers.json expose lan (got ${j.expose})`);
    ok(
      ws?.tls === "none" && ws.transport === "tcp",
      `ws tls none (F6), tcp (got ${JSON.stringify(ws)})`,
    );
    ok(
      !existsSync(join(dir, "live.json")),
      "this host writes no live.json (exposure is never recorded there)",
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`kept ${dir}`);
  }
}

async function lanWt(lan: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lan-wt-"));
  try {
    const host = await startHost(
      dir,
      { ...LAN_ENV, GRC_LIVE_WT_LISTEN: "0.0.0.0:0" },
      [`--token=${TOKEN}`],
      true,
    );
    ok(
      host.wtPort > 0 && host.cert.length === 64,
      `wt bound 0.0.0.0 udp ${host.wtPort}`,
    );
    const wt = probe(lan, host.wtPort, host.cert, join(dir, "probe"), TOKEN);
    const ws = wsClient(lan, host.wsPort, TOKEN);
    await ws.opened;
    ok(await wt.opened, "WebTransport session opened through the LAN address");
    await sleep(1500);
    host.proc.kill("SIGTERM");
    const [pr, wsr, code] = await Promise.all([wt.done, ws.done, host.exited]);
    ok(code === 0, `rs_live_host exited 0 (got ${code})`);
    const taps = tapsByCarrier(dir);
    ok(
      pr.received !== null &&
        pr.received.length > 0 &&
        (taps.get("wt") ?? []).some((t) => t.equals(pr.received!)),
      `wt received over the LAN equals its tap (${pr.received?.length ?? 0} bytes)`,
    );
    ok(
      pr.messages === wsr.messages.length && pr.close === wsr.close?.code,
      `wt and ws over the LAN: same message count and close (${pr.messages}/${wsr.messages.length})`,
    );
    const j = JSON.parse(
      readFileSync(join(dir, "live-carriers.json"), "utf8"),
    ) as CarriersJson;
    const wtc = j.carriers.find((c) => c.name === "wt");
    ok(
      wtc?.tls === "self-signed" &&
        wtc.transport === "udp" &&
        wtc.address === "0.0.0.0",
      `wt: udp, self-signed, 0.0.0.0 (got ${JSON.stringify(wtc)})`,
    );
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`kept ${dir}`);
  }
}

async function defaultRecordsLoopback(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lan-default-"));
  try {
    const host = await startHost(dir, {}, [], false);
    const c = wsClient("127.0.0.1", host.wsPort, null);
    await c.opened;
    host.proc.kill("SIGTERM");
    await Promise.all([c.done, host.exited]);
    const j = JSON.parse(
      readFileSync(join(dir, "live-carriers.json"), "utf8"),
    ) as CarriersJson;
    ok(
      j.expose === "loopback" && j.carriers[0].address === "127.0.0.1",
      `default: expose loopback on 127.0.0.1 (got ${j.expose}, ${j.carriers[0].address})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const b = spawnSync(
    "bash",
    [join(RS, "scripts/build-rs-net.sh"), "--no-test"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (b.status !== 0 || !existsSync(HOST)) {
    console.error(
      `self-test-lan: build-rs-net.sh failed (${b.status}) or ${HOST} is missing (build-capture.sh)`,
    );
    process.exit(1);
  }
  await refusalMatrix();
  await defaultRecordsLoopback();
  const lan = lanAddress();
  if (lan === null) {
    // Typed unavailable: the runner has no non-loopback IPv4 address (carrier-design.md CAR2).
    console.log(
      "unavailable: no non-loopback IPv4 address on this machine; the LAN connection parts are skipped",
    );
  } else {
    console.log(`LAN address ${lan}`);
    await lanWs(lan);
    await lanWt(lan);
  }
  console.log(
    failed === 0
      ? "self-test-lan: all passed"
      : `self-test-lan: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
