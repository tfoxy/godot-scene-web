// Real ws backpressure: stop reading the TCP socket, then inspect sender evidence and recovery.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RawTrack } from "../lib/raw-track-client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hostAt = process.argv.indexOf("--host");
const host =
  hostAt < 0
    ? join(root, "experiments/render-stream/capture/build/rs_live_host")
    : process.argv[hostAt + 1];
mkdirSync(join(root, ".local"), { recursive: true });
const out = mkdtempSync(join(root, ".local/audio-live-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GRC_")) delete env[key];
const viewToken = "ef".repeat(32);
const protocol = "render-stream-audio.1";
let passed = 0;
function check(value: unknown, name: string) {
  assert.ok(value, name);
  passed++;
}
async function until(predicate: () => boolean, name: string, ms = 6000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < end, `timeout: ${name}`);
    await delay(20);
  }
}
interface Connection {
  connection: number;
  carrier: string;
  closed: boolean;
  send_path: string;
  messages: Record<string, number>;
  blocks: Record<string, { sent: number; dropped: number }>;
  classes: Record<string, { sent: number; dropped: number }>;
  gaps: number;
  max_lateness_us: number;
  backpressured_lane_drops: number;
  stalls: number;
}
interface Evidence {
  schema: string;
  godot: { state: string; unsampled: number };
  cue: { attached: boolean; ring_high_water: number };
  link: { state: string; clock_domain: string | null; bankset: string | null };
  send_path: Record<string, string>;
  connections: Connection[];
  assets: { codec: string; hash: string; hits: number; bytes: number }[];
}
async function start(name: string, audio: boolean) {
  const dir = join(out, name);
  mkdirSync(dir);
  const commands = join(dir, "commands.txt");
  writeFileSync(commands, "");
  const proc = spawn(
    host,
    [
      `--token=${viewToken}`,
      `--evidence-dir=${dir}`,
      ...(audio
        ? [
            "--audio-demo",
            `--audio-commands=${commands}`,
            "--track-keepalive-ms=30000",
          ]
        : []),
    ],
    {
      env: {
        ...env,
        ...(audio
          ? {
              GRC_LIVE_AUDIO_QUEUE_BYTES: "4096",
              GRC_LIVE_AUDIO_LANE_LATE_MS: "60",
              GRC_LIVE_AUDIO_STALL_MS: "1500",
            }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<number | null>((r) => proc.once("exit", r));
  let commandCount = 0;
  const port = await new Promise<number>((yes, no) => {
    const timeout = setTimeout(
      () => no(new Error(`host timeout: ${stderr}`)),
      10000,
    );
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const m = /^RS_LIVE_HOST_PORT (\d+)$/.exec(line);
      if (m) {
        clearTimeout(timeout);
        yes(Number(m[1]));
      }
      const c = /^RS_AUDIO_COMMAND (\d+)$/.exec(line);
      if (c) commandCount = Number(c[1]);
    });
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      no(new Error(`host exit ${code}: ${stderr}`));
    });
  }).catch((error) => {
    proc.kill("SIGKILL");
    throw error;
  });
  let commandsWritten = 0;
  return {
    port,
    dir,
    evidence: () =>
      JSON.parse(
        readFileSync(join(dir, "live-audio.json"), "utf8"),
      ) as Evidence,
    command: async (text: string) => {
      appendFileSync(commands, `${text}\n`);
      commandsWritten += text.split("\n").length;
      const n = commandsWritten;
      await until(() => commandCount >= n, "synthetic command acknowledged");
    },
    stop: async () => {
      proc.kill("SIGTERM");
      const code = await exited;
      writeFileSync(join(dir, "stderr.log"), stderr);
      check(code === 0, `${name}: host exits cleanly`);
    },
  };
}
type Text = Record<string, unknown>;
const clients: RawTrack[] = [];
async function open(port: number, credential: string) {
  const { track, status } = await RawTrack.open(port, protocol);
  clients.push(track);
  check(status.includes("101"), "audio websocket accepted");
  // RawTrack owns text/close handling; this observer decodes the same unmasked server frames.
  const blocks: Buffer[] = [];
  let buf = Buffer.alloc(0);
  track.socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) break;
      if ((buf[0] & 15) === 2)
        blocks.push(Buffer.from(buf.subarray(off, off + len)));
      buf = buf.subarray(off + len);
    }
  });
  const texts = () =>
    track.texts.filter(Boolean).map((t) => JSON.parse(t) as Text);
  track.send(
    JSON.stringify({
      type: "track-hello",
      protocol: "render-stream-audio/1",
      kind: "audio",
      formats: ["gsw-audio/1"],
      credential,
    }),
  );
  track.startKeepalive(1000);
  await until(
    () => texts().some((t) => t.type === "take-ready"),
    "initial snapshot and take",
  );
  return { track, texts, blocks };
}
const live = await start("stall", true);
try {
  // Also the regression predicate: the accepted step-2 host cannot produce this file.
  check(
    existsSync(join(live.dir, "live-audio.json")),
    "granted audio writes live-audio.json",
  );
  const credential = readFileSync(
    join(live.dir, "live-track-audio-token"),
    "utf8",
  ).trim();
  const first = await open(live.port, credential);
  const snapshot = first.texts().find((t) => t.type === "audio-state");
  const sample = first.texts().find((t) => t.type === "sample");
  check(
    first.texts()[0].type === "track-ready" &&
      first.texts()[1].type === "audio-state",
    "ready precedes state",
  );
  check(snapshot && sample, "source snapshot and registered sample delivered");
  const variant = (sample?.variants as { hash: string; bytes: number }[])[0];
  const asset = await fetch(
    `http://127.0.0.1:${live.port}/resources/sha256/${variant.hash}`,
    {
      headers: { Authorization: `Bearer ${viewToken}` },
    },
  );
  check(
    asset.ok && (await asset.arrayBuffer()).byteLength === variant.bytes,
    "synthetic asset served",
  );
  first.track.send('{"type":"lanes","ids":[1]}');
  await until(() => first.blocks.some((b) => b[3] === 2), "lane subscribed");
  await until(
    () => live.evidence().connections.length === 1,
    "connection evidence",
  );
  const id = live.evidence().connections[0].connection;
  const stats = () =>
    live.evidence().connections.find((c) => c.connection === id) as Connection;
  const before = stats().backpressured_lane_drops;
  first.track.socket.pause();
  await until(
    () => stats().backpressured_lane_drops > before,
    "paused TCP reader backpressures carrier",
    90000,
  );
  check(
    first.track.closed === null && stats().stalls === 0,
    "lane-only stall drops without closing",
  );
  // Queue reliable cues and paired voices while the actual socket is still blocked.
  const cues = first.texts().filter((t) => t.type === "cue").length;
  await live.command("cue\npair\ncue\npair\ncue\npair");
  first.track.socket.resume();
  await until(
    () => first.texts().filter((t) => t.type === "cue").length === cues + 3,
    "all reliable cues delivered after resuming",
  );
  await until(
    () => first.blocks.some((b) => b[3] === 2 && b[4] & 8),
    "next live lane carries gap",
  );
  await until(
    () => first.texts().filter((t) => t.type === "stop").length === 4,
    "all paired stops delivered",
  );
  const starts = first.texts().filter((t) => t.type === "start");
  const stops = first.texts().filter((t) => t.type === "stop");
  check(
    starts.length === 4 &&
      starts.every(
        (s) => stops.filter((t) => t.voice === s.voice).length === 1,
      ),
    "every reliable start has exactly one stop after short stall",
  );
  check(
    new Set(starts.map((s) => s.voice)).size === starts.length,
    "voice ids are unique",
  );
  await until(() => stats().gaps > 0, "gap evidence");
  const sentBeforeStall = first.blocks.filter((b) => b[3] === 2);
  check(
    sentBeforeStall.some(
      (b, i) =>
        i > 0 &&
        b.readUInt32LE(12) > sentBeforeStall[i - 1].readUInt32LE(12) + 1 &&
        b[4] & 8,
    ),
    "wire lane sequence skips dropped blocks and marks gap",
  );

  const dropped = stats().backpressured_lane_drops;
  first.track.socket.pause();
  await until(
    () => stats().backpressured_lane_drops > dropped + 3,
    "second real socket stall",
    90000,
  );
  // A voice remains active at the source even if this connection loses it at stall-close.
  await live.command("start");
  await live.command("cue");
  await until(
    () => stats().stalls === 1,
    "reliable class stalls and closes",
    7000,
  );
  check(stats().closed, "stalled connection retained as closed in evidence");
  first.track.socket.resume();
  await until(
    () => first.track.closed !== null,
    "audio-stalled close arrives",
    10000,
  );
  check(
    first.track.closed?.code === 1001 &&
      first.track.closed?.reason === "audio-stalled",
    "long stall closes 1001 audio-stalled",
  );
  first.track.destroy();
  const second = await open(live.port, credential);
  const state = second.texts().find((t) => t.type === "audio-state");
  const voices = (
    state?.godot as {
      voices: {
        voice: number;
        sample: number;
        paused: boolean;
        position_s: number;
      }[];
    }
  ).voices;
  check(
    voices.length === 1 &&
      voices[0].sample === sample?.id &&
      voices[0].paused === false &&
      voices[0].position_s >= 0,
    "reconnect snapshot resyncs the active source voice",
  );
  const voice = voices[0].voice;
  const nextStart = second.texts().find((t) => t.type === "start");
  check(
    voice > Math.max(...starts.map((s) => Number(s.voice))) &&
      Number(nextStart?.voice) > voice,
    "reconnected voice ids never reuse earlier ids",
  );
  check(
    second.texts().find((t) => t.type === "sample")?.id === sample?.id,
    "reconnect reannounces the registered sample",
  );
  await live.command("stop");
  await until(
    () => second.texts().some((t) => t.type === "stop" && t.voice === voice),
    "snapshot voice stop",
  );
  check(
    second.texts().filter((t) => t.type === "stop" && t.voice === voice)
      .length === 1,
    "snapshot voice receives exactly one stop",
  );
  second.track.destroy();
  await until(
    () =>
      live.evidence().connections.length === 2 &&
      live.evidence().connections.every((c) => c.closed),
    "closed connections preserved",
  );
  const e = live.evidence();
  check(
    e.schema === "render-stream-live-audio/1" &&
      e.godot.state === "synthetic" &&
      e.godot.unsampled === 0,
    "schema and synthetic Godot source state",
  );
  check(
    e.cue.attached === false &&
      e.cue.ring_high_water === 0 &&
      e.link.state === "detached" &&
      e.link.clock_domain === null &&
      e.link.bankset === null,
    "uninstalled cue ABI and link reported honestly",
  );
  check(
    e.send_path.ws === "thread" &&
      e.connections.every(
        (c) => c.carrier === "ws" && c.send_path === "thread",
      ),
    "ws uses capture-owned audio sender thread",
  );
  check(
    e.connections[0].messages.cue === cues + 3 &&
      e.connections[0].messages.start === 4 &&
      e.connections[0].messages.stop === 4,
    "per-type evidence counts actual hand-offs",
  );
  check(
    e.connections.every(
      (c) =>
        c.blocks.take.sent === 2 &&
        c.blocks.take.dropped === 0 &&
        c.classes.control.dropped === 0,
    ),
    "reliable classes have no silent drops",
  );
  check(
    e.connections[0].blocks.lane.dropped > 0 &&
      e.connections[0].gaps > 0 &&
      Number.isSafeInteger(e.connections[0].max_lateness_us) &&
      e.connections[0].stalls === 1,
    "lane drops, gaps, lateness in us and stall counted",
  );
  check(
    e.assets.length === 1 &&
      e.assets[0].codec === "wav" &&
      e.assets[0].hash === variant.hash &&
      e.assets[0].hits === 1 &&
      e.assets[0].bytes === variant.bytes,
    "asset hits and bytes by codec",
  );
  const serialized = JSON.stringify(e);
  check(
    !serialized.includes("event:/") &&
      !serialized.includes(credential) &&
      !serialized.includes(viewToken) &&
      !serialized.includes("key_id"),
    "evidence contains counts, no cue keys or credentials",
  );
} finally {
  for (const c of clients) c.destroy();
  await live.stop();
}
const pure = await start("pure", false);
try {
  const audio = await RawTrack.open(pure.port, protocol);
  clients.push(audio.track);
  const unknown = await RawTrack.open(
    pure.port,
    "render-stream-unrecognized.1",
  );
  clients.push(unknown.track);
  check(
    audio.status.includes("400") && audio.head === unknown.head,
    "without grant audio upgrade is byte-identical to unknown subprotocol 400",
  );
  check(
    !existsSync(join(pure.dir, "live-audio.json")) &&
      !existsSync(join(pure.dir, "live-track-audio-token")),
    "pure path writes no audio evidence or credential",
  );
} finally {
  for (const c of clients) c.destroy();
  await pure.stop();
}
check(
  !existsSync(join(pure.dir, "live-audio.json")),
  "pure shutdown writes no audio evidence",
);
writeFileSync(
  join(out, "summary.json"),
  JSON.stringify({ passed, failed: 0, skipped: 0 }),
);
console.log(`${passed} passed, 0 failed, 0 skipped; evidence ${out}`);
