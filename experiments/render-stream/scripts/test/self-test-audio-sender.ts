// Engine-free payload leg over the production ws carrier; binary and text ordering are observed.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hostAt = process.argv.indexOf("--host");
const host =
  hostAt < 0
    ? join(root, "experiments/render-stream/capture/build/rs_live_host")
    : process.argv[hostAt + 1];
mkdirSync(join(root, ".local"), { recursive: true });
const out = mkdtempSync(join(root, ".local/audio-sender-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GRC_")) delete env[key];
const viewToken = "ad".repeat(32);
const proc = spawn(
  host,
  ["--audio-demo", `--token=${viewToken}`, `--evidence-dir=${out}`],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
const exited = new Promise<void>((r) => proc.once("exit", () => r()));
let stderr = "";
proc.stderr.on("data", (v) => {
  stderr += v;
});
let passed = 0;
function check(value: unknown, name: string) {
  assert.ok(value, name);
  passed++;
}
const clients: WebSocket[] = [];
try {
  const port = await new Promise<number>((yes, no) => {
    const timeout = setTimeout(
      () => no(new Error(`host timeout: ${stderr}`)),
      10000,
    );
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const match = /^RS_LIVE_HOST_PORT (\d+)$/.exec(line);
      if (match) {
        clearTimeout(timeout);
        yes(Number(match[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      no(new Error(`host exit ${code}: ${stderr}`));
    });
  });
  check(
    existsSync(join(out, "live-track-audio-token")),
    "audio-demo arms the audio credential",
  );
  const credential = readFileSync(
    join(out, "live-track-audio-token"),
    "utf8",
  ).trim();
  const open = async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/render-stream`,
      "render-stream-audio.1",
    );
    clients.push(ws);
    ws.binaryType = "arraybuffer";
    const messages: (Record<string, unknown> | Buffer)[] = [];
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        if (e.data) messages.push(JSON.parse(e.data));
      } else messages.push(Buffer.from(e.data as ArrayBuffer));
    });
    const until = (predicate: () => boolean) =>
      new Promise<void>((yes, no) => {
        if (predicate()) return yes();
        const timeout = setTimeout(() => {
          ws.removeEventListener("message", inspect);
          no(new Error(`payload timeout (${messages.length} messages)`));
        }, 5000);
        const inspect = () => {
          if (predicate()) {
            clearTimeout(timeout);
            ws.removeEventListener("message", inspect);
            yes();
          }
        };
        ws.addEventListener("message", inspect);
      });
    await new Promise<void>((yes, no) => {
      ws.addEventListener("open", () => yes(), { once: true });
      ws.addEventListener("error", () => no(new Error("upgrade failed")), {
        once: true,
      });
    });
    ws.send(
      JSON.stringify({
        type: "track-hello",
        protocol: "render-stream-audio/1",
        kind: "audio",
        formats: ["gsw-audio/1"],
        credential,
      }),
    );
    await until(() =>
      messages.some((m) => !Buffer.isBuffer(m) && m.type === "take-ready"),
    );
    return { ws, messages, until };
  };
  const first = await open();
  const texts = first.messages.filter(
    (m): m is Record<string, unknown> => !Buffer.isBuffer(m),
  );
  check(
    texts[0].type === "track-ready" && texts[1].type === "audio-state",
    "ready then snapshot",
  );
  const sample = texts.find((m) => m.type === "sample");
  const start = texts.find((m) => m.type === "start");
  const stop = texts.find((m) => m.type === "stop");
  check(
    sample &&
      start &&
      stop &&
      sample.id === start.sample &&
      start.voice === stop.voice,
    "sample and paired voice events",
  );
  check(
    texts.some((m) => m.type === "cue"),
    "cue delivered",
  );
  for (const m of texts.slice(1))
    check(
      typeof m.t === "number" && typeof m.s === "number" && m.s >= m.t,
      `timestamps ${m.type}`,
    );
  const takes = first.messages.filter((m): m is Buffer => Buffer.isBuffer(m));
  check(
    takes.length === 2 && takes[0][4] === 1 && takes[1][4] === 2,
    "first/last take blocks",
  );
  for (const b of takes)
    check(
      b.length === 2096 &&
        b.subarray(0, 2).toString() === "GA" &&
        b[3] === 1 &&
        b.readBigUInt64LE(40) > 0n,
      "PCM block header and hand-off stamp",
    );
  const cue = texts.find((m) => m.type === "cue");
  check(
    takes[0].readBigUInt64LE(32) === BigInt(Number(cue?.t)) &&
      takes[1].readBigUInt64LE(32) - takes[0].readBigUInt64LE(32) === 10666n,
    "take deadlines follow the cue media clock",
  );
  const lastIndex = first.messages.indexOf(takes[1]);
  check(
    first.messages.findIndex(
      (m) => !Buffer.isBuffer(m) && m.type === "take-ready",
    ) > lastIndex,
    "take-ready follows last binary block",
  );
  const variants = sample?.variants as { hash: string; bytes: number }[];
  const asset = await fetch(
    `http://127.0.0.1:${port}/resources/sha256/${variants[0].hash}`,
    { headers: { Authorization: `Bearer ${viewToken}` } },
  );
  const wav = Buffer.from(await asset.arrayBuffer());
  check(
    asset.ok &&
      wav.length === variants[0].bytes &&
      createHash("sha256").update(wav).digest("hex") === variants[0].hash,
    "sample WAV served by advertised hash",
  );
  check(
    wav.subarray(44).equals(Buffer.concat(takes.map((b) => b.subarray(48)))),
    "take hash names canonical WAV",
  );
  first.ws.send(
    JSON.stringify({
      type: "have",
      bankset: "0".repeat(32),
      key_ids: [],
      reset: true,
    }),
  );
  first.ws.send(JSON.stringify({ type: "clock", c: 12.5 }));
  first.ws.send(JSON.stringify({ type: "lanes", ids: [1] }));
  await first.until(
    () =>
      first.messages.filter((m) => Buffer.isBuffer(m) && m[3] === 2).length >=
      3,
  );
  const lanes = first.messages.filter(
    (m): m is Buffer => Buffer.isBuffer(m) && m[3] === 2,
  );
  check(
    lanes.every((b) => b[5] === 1 && b.readUInt16LE(20) === 512),
    "512-frame subscribed lane",
  );
  check(
    lanes[1].readUInt32LE(12) === lanes[0].readUInt32LE(12) + 1,
    "lane sequence advances",
  );
  check(
    first.messages.some(
      (m) => !Buffer.isBuffer(m) && m.type === "clock" && m.c === 12.5,
    ),
    "clock echo",
  );
  first.ws.send(JSON.stringify({ type: "lanes", ids: [] }));
  await first.until(() =>
    first.messages.some(
      (m) =>
        !Buffer.isBuffer(m) &&
        m.type === "lanes" &&
        JSON.stringify(m.lanes).includes('"off"'),
    ),
  );
  const second = await open();
  const start2 = second.messages.find(
    (m): m is Record<string, unknown> =>
      !Buffer.isBuffer(m) && m.type === "start",
  );
  check(
    start2 &&
      !Buffer.isBuffer(start2) &&
      Number(start2.voice) > Number(start?.voice),
    "voice id never reused across connections",
  );
  const stream2 = second.messages.find(
    (m): m is Buffer => Buffer.isBuffer(m) && m[3] === 1,
  );
  check(
    stream2 && stream2.readUInt32LE(8) > takes[0].readUInt32LE(8),
    "take stream ids never reused",
  );
  first.ws.send('{"type":"unknown"}');
  const closed = await new Promise<CloseEvent>((yes) =>
    first.ws.addEventListener("close", yes, { once: true }),
  );
  check(
    closed.code === 1002 && closed.reason === "audio-protocol",
    "payload grammar closes with audio-protocol",
  );
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify({ passed, failed: 0, skipped: 0 }),
  );
  console.log(`${passed} passed, 0 failed, 0 skipped; evidence ${out}`);
} finally {
  for (const ws of clients) ws.close();
  proc.kill("SIGTERM");
  await exited;
  writeFileSync(join(out, "stderr.log"), stderr);
}
