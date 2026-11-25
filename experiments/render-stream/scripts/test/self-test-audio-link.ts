// Synthetic product link over real WS: warm clients receive cues without take bandwidth.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
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
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const host =
  arg("--host") ??
  join(root, "experiments/render-stream/capture/build/rs_live_host");
mkdirSync(join(root, ".local"), { recursive: true });
const out = arg("--out") ?? mkdtempSync(join(root, ".local/audio-link-"));
mkdirSync(out, { recursive: true });
const commands = join(out, "commands.txt");
writeFileSync(commands, "");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GRC_")) delete env[key];
const proc = spawn(
  host,
  [
    "--audio-link",
    `--audio-commands=${commands}`,
    `--evidence-dir=${out}`,
    "--track-keepalive-ms=30000",
    ...(process.argv.includes("--relay-to-all")
      ? ["--audio-link-relay-to-all"]
      : []),
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let stderr = "",
  stdout = "",
  acknowledged = 0,
  written = 0,
  passed = 0;
proc.stderr.on("data", (b) => (stderr += b.toString()));
const exited = new Promise<number | null>((yes) => proc.once("exit", yes));
const lines = createInterface({ input: proc.stdout });
lines.on("line", (line) => {
  stdout += `${line}\n`;
  const m = /^RS_AUDIO_COMMAND (\d+)$/.exec(line);
  if (m) acknowledged = Number(m[1]);
});
function check(value: unknown, name: string) {
  assert.ok(value, name);
  ++passed;
}
async function until(predicate: () => boolean, name: string) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert.equal(proc.exitCode, null, `host exited: ${stderr}`);
    assert.ok(Date.now() < end, `timeout: ${name}`);
    await delay(10);
  }
}
const clients: RawTrack[] = [];
const binaryMessages: Buffer[][] = [];
interface Text {
  type: string;
  c?: number;
  hash?: string;
  reason?: string;
  lanes: { id: number; state: string }[];
  fmod: { groups: Record<string, number> };
  audio: { fmod: boolean; lanes: { id: number }[] };
}
interface Evidence {
  connections: { messages: Record<string, number> }[];
  link: { wants: number; relayed_bytes: number; relayed_blocks: number };
  cue: { attached: boolean; ring_high_water: number };
}
async function open(port: number, credential: string) {
  const { track, status } = await RawTrack.open(port, "render-stream-audio.1");
  clients.push(track);
  check(status.includes("101"), "audio WS accepted");
  const blocks: Buffer[] = [];
  binaryMessages.push(blocks);
  let buf = Buffer.alloc(0);
  track.socket.on("data", (data: Buffer) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 2) {
      let len = buf[1] & 127,
        offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      if ((buf[0] & 15) === 2)
        blocks.push(Buffer.from(buf.subarray(offset, offset + len)));
      buf = buf.subarray(offset + len);
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
    () => texts().some((t) => t.type === "audio-state"),
    "audio snapshot",
  );
  check(
    texts()[0].type === "track-ready" && texts()[1].type === "audio-state",
    "ready then snapshot",
  );
  writeFileSync(
    join(out, `snapshot-${clients.length}.json`),
    JSON.stringify(texts(), null, 2),
  );
  check(
    texts()[0].audio.fmod === true &&
      texts()[0].audio.lanes.length === 1 &&
      texts()[1].fmod.groups.Music === 0.25,
    "reference link lanes and groups in snapshot",
  );
  return { track, texts, blocks };
}
async function command(text: string) {
  appendFileSync(commands, `${text}\n`);
  ++written;
  await until(() => acknowledged >= written, "command acknowledged");
}
const key = "event:/reference";
const kid = createHash("sha256")
  .update(Buffer.from([1]))
  .update(key)
  .digest("hex")
  .slice(0, 32);
const bankset = "1".repeat(32);
let clock = 0;
try {
  await until(() => /^RS_LIVE_HOST_PORT /m.test(stdout), "host port");
  const port = Number(/^RS_LIVE_HOST_PORT (\d+)/m.exec(stdout)?.[1]);
  const credential = readFileSync(
    join(out, "live-track-audio-token"),
    "utf8",
  ).trim();
  const warm = await open(port, credential),
    cold = await open(port, credential);
  const barrier = async (client: typeof warm) => {
    const c = ++clock;
    client.track.send(JSON.stringify({ type: "clock", c }));
    await until(
      () => client.texts().some((t) => t.type === "clock" && t.c === c),
      "ordered client barrier",
    );
  };
  const have = async (client: typeof warm, ids: string[]) => {
    client.track.send(
      JSON.stringify({ type: "have", bankset, key_ids: ids, reset: true }),
    );
    await barrier(client);
  };
  const count = (client: typeof warm, type: string) =>
    client.texts().filter((t) => t.type === type).length;
  const takes = (client: typeof warm) =>
    client.blocks.filter((b) => b[3] === 1);
  await have(warm, [kid]);
  await have(cold, []);
  await command("cue");
  await until(() => count(cold, "take-ready") === 1, "cold take ready");
  check(
    count(warm, "cue") === 1 && count(cold, "cue") === 1,
    "cue reaches both clients",
  );
  check(
    count(warm, "take-start") === 0 &&
      count(warm, "take-ready") === 0 &&
      takes(warm).length === 0,
    "warm client receives zero take bandwidth",
  );
  check(
    count(cold, "take-start") === 1 && takes(cold).length === 2,
    "cold client receives complete take",
  );
  check(
    takes(cold).reduce((n, b) => n + b.length, 0) === 4192,
    "cold take bandwidth is 4192 bytes including headers",
  );
  check(
    takes(cold)[0][4] === 1 &&
      takes(cold)[1][4] === 2 &&
      takes(cold).every((b) => b.readBigUInt64LE(40) > 0n),
    "first/last and seat send clock preserved",
  );
  const wav = Buffer.alloc(4140);
  wav.write("RIFF");
  wav.writeUInt32LE(4132, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(4096, 40);
  check(
    cold.texts().find((t) => t.type === "take-ready")?.hash ===
      createHash("sha256").update(wav).digest("hex"),
    "ready hash identifies canonical cached WAV",
  );
  await have(cold, [kid]);
  await command("cue");
  await until(
    () => count(cold, "cue") === 2 && count(warm, "cue") === 2,
    "warm repeat cue",
  );
  const evidence = () =>
    JSON.parse(readFileSync(join(out, "live-audio.json"), "utf8")) as Evidence;
  await until(
    () => evidence().connections.every((c) => c.messages.cue === 2),
    "cue evidence",
  );
  check(
    evidence().link.wants === 1 &&
      evidence().link.relayed_bytes === 4192 &&
      evidence().link.relayed_blocks === 2,
    "one want and one complete relay in evidence",
  );
  check(
    evidence().cue.attached &&
      evidence().cue.ring_high_water > 0 &&
      !JSON.stringify(evidence()).includes(key),
    "cue evidence is populated without keys",
  );
  warm.track.send('{"type":"lanes","ids":[1]}');
  await until(
    () => warm.blocks.some((b) => b[3] === 2),
    "reference lane media clock",
  );
  check(!cold.blocks.some((b) => b[3] === 2), "lane relays only to subscriber");
  const epoch = warm.blocks.find((b) => b[3] === 2)?.readUInt32LE(8);
  warm.track.send('{"type":"lanes","ids":[]}');
  await until(
    () =>
      warm
        .texts()
        .some((t) => t.type === "lanes" && t.lanes[0].state === "off"),
    "lane unsubscribed",
  );
  await barrier(warm);
  warm.track.send('{"type":"lanes","ids":[1]}');
  await until(
    () => warm.blocks.some((b) => b[3] === 2 && b.readUInt32LE(8) !== epoch),
    "lane media clock restarts with new epoch",
  );
  check(
    warm.blocks
      .filter((b) => b[3] === 2)
      .every((b) => b.readBigUInt64LE(32) > 0n),
    "lane blocks use real-time media due clock",
  );
  await have(cold, []);
  await command("link-down");
  await command("cue");
  await until(
    () => count(cold, "take-unavailable") === 1,
    "link-down unavailable",
  );
  check(
    cold.texts().find((t) => t.type === "take-unavailable")?.reason ===
      "link-down",
    "link-down reason delivered",
  );
  check(
    warm
      .texts()
      .some((t) => t.type === "lanes" && t.lanes[0].state === "unavailable"),
    "link-down marks lanes unavailable",
  );
  check(
    warm.track.closed === null && cold.track.closed === null,
    "link failure preserves audio connections",
  );
  writeFileSync(
    join(out, "bandwidth.json"),
    `${JSON.stringify(
      {
        schema: "audio-link-bandwidth/1",
        warm_take_bytes: takes(warm).reduce((n, b) => n + b.length, 0),
        cold_take_bytes: takes(cold).reduce((n, b) => n + b.length, 0),
        wants: evidence().link.wants,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  for (const [index, client] of clients.entries()) {
    writeFileSync(
      join(out, `client-${index}.json`),
      JSON.stringify(
        {
          types: client.texts
            .filter(Boolean)
            .map((t) => (JSON.parse(t) as Text).type),
          blocks: binaryMessages[index]?.map((b) => ({
            kind: b[3],
            flags: b[4],
            stream: b.readUInt32LE(8),
            bytes: b.length,
          })),
          take_bytes: binaryMessages[index]
            ?.filter((b) => b[3] === 1)
            .reduce((n, b) => n + b.length, 0),
        },
        null,
        2,
      ),
    );
    client.stopKeepalive();
    client.socket.destroy();
  }
  proc.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(5000, undefined, { ref: false }).then(() => {
      proc.kill("SIGKILL");
    }),
  ]);
  lines.close();
  writeFileSync(join(out, "stdout.log"), stdout);
  writeFileSync(join(out, "stderr.log"), stderr);
}
check((await exited) === 0, "reference host exits cleanly");
console.log(
  `self-test-audio-link: ${passed} passed, 0 failed; evidence: ${out}`,
);
