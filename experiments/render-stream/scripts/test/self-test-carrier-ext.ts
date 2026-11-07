// CAR6 consumer carriers: capture/build/rs_live_host
// registers in-memory `mem` carriers (capture/test/rs_mem_carrier.*) through the exported
// grc_carrier_register, next to or instead of `ws`. Scenarios, each in its own temp dir:
//   1. honest, next to ws: every registration result, start/destroy counts, mem bytes == its tap,
//      ws bytes == its tap, same message count and close code on both, live-carriers.json shape;
//   2. admission total (D6): --max-clients=1 with two mem connections: one refused, ws gets 503;
//   3. mem instead of ws: port 0, no ws carrier, mem bytes == its tap;
//   4. a listed name left unregistered: exit 2, stderr carrier-unregistered;
//   5. sabotage: a carrier releasing a buffer twice is caught by the owner ledger
//      (faults["release-unknown"] == 1, host still exits 0) and the honest "faults {}" check fails.
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/self-test-carrier-ext.ts [--keep]
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const keep = process.argv.includes("--keep");

let failed = 0;
function ok(cond: boolean, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
}

function hello7(): string {
  return JSON.stringify({
    type: "hello",
    protocol: "render-stream/7",
    receiver: "carrier-ext",
    receiver_kind: "gsw-canvas",
    credit_stage: "submitted",
    credit_window: 1,
    inbound_buffer_bytes: 16777216,
    token: null,
    manifest_sha256: null,
    presentation_backing_w: 640,
    presentation_backing_h: 360,
    presentation_css_w: 640,
    presentation_css_h: 360,
    dpr_milli: 1000,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Host {
  proc: ChildProcess;
  port: number;
  lines: string[];
  stderr: () => string;
  exited: Promise<number | null>;
  dir: string;
}

function startHost(dir: string, args: string[]): Host {
  mkdirSync(join(dir, "ev"), { recursive: true });
  mkdirSync(join(dir, "mem"), { recursive: true });
  const proc = spawn(
    HOST,
    [
      ...args,
      `--tap-dir=${join(dir, "tap")}`,
      `--evidence-dir=${join(dir, "ev")}`,
      `--mem-out=${join(dir, "mem")}`,
      `--summary=${join(dir, "live-summary.json")}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines: string[] = [];
  let err = "";
  proc.stderr!.on("data", (d) => {
    err += String(d);
  });
  createInterface({ input: proc.stdout! }).on("line", (l) => lines.push(l));
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  return { proc, port: -1, lines, stderr: () => err, exited, dir };
}

async function waitPort(h: Host): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const m = h.lines.map((l) => /^RS_LIVE_HOST_PORT (\d+)$/.exec(l)).find((x) => x);
    if (m) {
      h.port = Number(m[1]);
      return;
    }
    if (h.proc.exitCode !== null) throw new Error(`rs_live_host exited ${h.proc.exitCode} before listening`);
    if (Date.now() - t0 > 15000) throw new Error("rs_live_host did not print its port");
    await sleep(20);
  }
}

interface WsResult {
  messages: Uint8Array[];
  close: { code: number; reason: string } | null;
}

function wsClient(port: number): Promise<WsResult> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/render-stream`, "render-stream.7");
  ws.binaryType = "arraybuffer";
  const messages: Uint8Array[] = [];
  return new Promise<WsResult>((res) => {
    ws.onopen = () => ws.send(hello7());
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") messages.push(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = (e) => res({ messages, close: { code: e.code, reason: e.reason } });
    ws.onerror = () => {};
  });
}

/** A raw upgrade request; resolves with the HTTP status if refused, 101 if upgraded. */
function upgradeStatus(port: number): Promise<number> {
  return new Promise((res) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/render-stream",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("carrier-ext-key!").toString("base64"),
        "Sec-WebSocket-Protocol": "render-stream.7",
      },
    });
    req.on("response", (r) => {
      res(r.statusCode ?? -1);
      r.resume();
    });
    req.on("upgrade", (_r, sock) => {
      res(101);
      sock.destroy();
    });
    req.on("error", () => res(-1));
    req.end();
  });
}

/** tap/live-<n>.jsonl's `open` line names the carrier; returns carrier -> tap bytes. */
function tapByCarrier(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tap = join(dir, "tap");
  if (!existsSync(tap)) return out;
  for (const f of readdirSync(tap)) {
    const m = /^live-(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    for (const line of readFileSync(join(tap, f), "utf8").split("\n")) {
      if (!line.includes('"open"')) continue;
      const rec = JSON.parse(line) as { carrier?: string };
      if (rec.carrier) {
        const s = join(tap, `stream-${m[1]}.rs2`);
        out.set(rec.carrier, existsSync(s) ? readFileSync(s) : Buffer.alloc(0));
      }
    }
  }
  return out;
}

interface MemJson {
  schema: string;
  name: string;
  fault: string;
  admit_refused: number;
  double_releases: number;
  connections: { local: number; messages: number; texts: number; bytes: number; close_code: number; close_reason: string; file: string }[];
}
interface CarriersJson {
  admitted_max: number;
  max_connections: number;
  carriers: {
    name: string;
    index: number;
    status: string;
    abi_version: number | null;
    transport: string | null;
    faults: Record<string, number>;
  }[];
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const memJson = (dir: string) => readJson<MemJson>(join(dir, "mem/mem-mem.json"));
const carriersJson = (dir: string) => readJson<CarriersJson>(join(dir, "ev/live-carriers.json"));
const noFaults = (c: CarriersJson, name: string) => {
  const e = c.carriers.find((x) => x.name === name);
  return e !== undefined && Object.keys(e.faults).length === 0;
};

async function scenario(name: string, body: (dir: string) => Promise<void>): Promise<void> {
  console.log(`-- ${name}`);
  const dir = mkdtempSync(join(root, "s-"));
  try {
    await body(dir);
  } catch (e) {
    ok(false, `${name}: ${(e as Error).message}`);
  }
  void dir;
}

let root = "";

async function honest(dir: string): Promise<void> {
  const host = startHost(dir, ["--carriers=ws,mem", "--register-checks", "--max-clients=4"]);
  await waitPort(host);
  const ws = wsClient(host.port);
  await sleep(1500);
  host.proc.kill("SIGTERM");
  const [wsr, code] = await Promise.all([ws, host.exited]);
  ok(code === 0, `rs_live_host exited 0 (got ${code})`);
  const out = host.lines;
  const has = (l: string) => out.includes(`RS_LIVE_HOST_${l}`);
  for (const l of [
    "REGISTER dlsym found",
    "REGISTER bad-version -1",
    "REGISTER short-size -1",
    "REGISTER null-entry -1",
    "REGISTER bad-name -1",
    "REGISTER reserved-ws -1",
    "REGISTER reserved-wt -1",
    "REGISTER refused-touched starts=0 destroys=6",
    "REGISTER mem 2",
    "REGISTER idle 3",
    "REGISTER duplicate -1",
    "REGISTER late -1",
    "EXT mem starts=1 destroys=1",
    "EXT idle starts=0 destroys=1",
  ])
    ok(has(l), `host line RS_LIVE_HOST_${l}`);
  const taps = tapByCarrier(dir);
  ok(taps.has("ws") && taps.has("mem"), `one tap per carrier (${[...taps.keys()].join(",")})`);
  const mj = memJson(dir);
  ok(mj.connections.length === 1, `mem recorded one connection (${mj.connections.length})`);
  const mc = mj.connections[0];
  const memBytes = mc ? readFileSync(mc.file) : Buffer.alloc(0);
  ok(memBytes.length > 0 && memBytes.equals(taps.get("mem") ?? Buffer.alloc(1)), `mem bytes == its tap (${memBytes.length} bytes)`);
  const wsBytes = Buffer.concat(wsr.messages);
  ok(wsBytes.length > 0 && wsBytes.equals(taps.get("ws") ?? Buffer.alloc(1)), `ws received == tap (${wsBytes.length} bytes)`);
  ok(
    mc !== undefined && mc.messages >= 3 && mc.messages === wsr.messages.length,
    `same message count on both carriers (mem ${mc?.messages}, ws ${wsr.messages.length})`,
  );
  ok(
    mc !== undefined && wsr.close !== null && mc.close_code === wsr.close.code,
    `same close code on both carriers (mem ${mc?.close_code} "${mc?.close_reason}", ws ${JSON.stringify(wsr.close)})`,
  );
  const cj = carriersJson(dir);
  const mem = cj.carriers.find((c) => c.name === "mem");
  ok(
    mem?.index === 2 && mem.abi_version === 1 && mem.transport === null && mem.status === "stopped" && noFaults(cj, "mem"),
    `live-carriers.json mem: ${JSON.stringify(mem)}`,
  );
  ok(!cj.carriers.some((c) => c.name === "idle"), "no carrier named idle in live-carriers.json");
  ok(cj.carriers.find((c) => c.name === "ws")?.abi_version === null, "ws has abi_version null");
}

async function admission(dir: string): Promise<void> {
  const host = startHost(dir, ["--carriers=ws,mem", "--max-clients=1", "--mem-connections=2"]);
  await waitPort(host);
  await sleep(500);
  const status = await upgradeStatus(host.port);
  await sleep(500);
  host.proc.kill("SIGTERM");
  const code = await host.exited;
  ok(code === 0, `rs_live_host exited 0 (got ${code})`);
  const mj = memJson(dir);
  ok(mj.admit_refused === 1 && mj.connections.length === 1, `mem admit_refused 1, one connection (${mj.admit_refused}, ${mj.connections.length})`);
  ok(status === 503, `ws upgrade refused with HTTP 503 (got ${status})`);
  ok(carriersJson(dir).admitted_max === 1, `admitted_max == 1 (${carriersJson(dir).admitted_max})`);
}

async function memOnly(dir: string): Promise<void> {
  const host = startHost(dir, ["--carriers=mem"]);
  await waitPort(host);
  ok(host.port === 0, `RS_LIVE_HOST_PORT 0 (got ${host.port})`);
  await sleep(1500);
  host.proc.kill("SIGTERM");
  const code = await host.exited;
  ok(code === 0, `rs_live_host exited 0 (got ${code})`);
  const cj = carriersJson(dir);
  ok(!cj.carriers.some((c) => c.name === "ws"), `no ws carrier (${cj.carriers.map((c) => c.name).join(",")})`);
  const mc = memJson(dir).connections[0];
  const memBytes = mc ? readFileSync(mc.file) : Buffer.alloc(0);
  ok(memBytes.length > 0 && memBytes.equals(tapByCarrier(dir).get("mem") ?? Buffer.alloc(1)), `mem bytes == its tap (${memBytes.length} bytes)`);
  ok(mc?.close_code === 1000, `mem close code 1000 (got ${mc?.close_code})`);
}

async function unregistered(dir: string): Promise<void> {
  const host = startHost(dir, ["--carriers=ws,nobody", "--skip-register=nobody"]);
  const code = await host.exited;
  ok(code === 2, `exit 2 (got ${code})`);
  ok(host.stderr().includes("carrier-unregistered"), `stderr names carrier-unregistered (${host.stderr().trim().slice(0, 120)})`);
}

async function sabotage(dir: string): Promise<void> {
  const host = startHost(dir, ["--carriers=mem", "--mem-fault=double-release"]);
  await waitPort(host);
  await sleep(1500);
  host.proc.kill("SIGTERM");
  const code = await host.exited;
  ok(code === 0, `host survives the double release, exit 0 (got ${code})`);
  const mj = memJson(dir);
  ok(mj.double_releases === 1, `mem-mem.json double_releases == 1 (${mj.double_releases})`);
  const cj = carriersJson(dir);
  const mem = cj.carriers.find((c) => c.name === "mem");
  ok(mem?.faults["release-unknown"] === 1, `owner ledger faults release-unknown == 1 (${JSON.stringify(mem?.faults)})`);
  ok(!noFaults(cj, "mem"), "sabotage caught: the honest 'faults must be {}' predicate fails on this run");
}

async function main(): Promise<void> {
  if (!existsSync(HOST)) {
    console.error(`self-test-carrier-ext: ${HOST} is missing (build-capture.sh)`);
    process.exit(1);
  }
  root = mkdtempSync(join(tmpdir(), "carrier-ext-"));
  try {
    await scenario("1 honest, next to ws", honest);
    await scenario("2 admission total (D6)", admission);
    await scenario("3 mem instead of ws", memOnly);
    await scenario("4 unregistered carrier", unregistered);
    await scenario("5 sabotage double-release", sabotage);
  } finally {
    if (failed === 0 && !keep) rmSync(root, { recursive: true, force: true });
    else console.log(`kept ${root}`);
  }
  console.log(failed === 0 ? "self-test-carrier-ext: all passed" : `self-test-carrier-ext: ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
