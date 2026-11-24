// Engine-free audio admission and handshake over the production ws carrier.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RawTrack } from "../lib/raw-track-client";
import { mintTrackCapFor, readCapKeyFile } from "../lib/track-cap";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const hostAt = process.argv.indexOf("--host");
const hostBin =
  hostAt < 0
    ? join(root, "experiments/render-stream/capture/build/rs_live_host")
    : process.argv[hostAt + 1];
mkdirSync(join(root, ".local"), { recursive: true });
const out = mkdtempSync(join(root, ".local/audio-handshake-"));
const viewToken = "cd".repeat(32);
const audioSp = "render-stream-audio.1";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("GRC_")) delete env[key];
let passed = 0;
function check(value: unknown, name: string): void {
  assert.ok(value, name);
  passed++;
}
function hello(
  credential: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "track-hello",
    protocol: "render-stream-audio/1",
    kind: "audio",
    formats: ["gsw-audio/1"],
    credential,
    client: "self-test-audio",
    ...extra,
  });
}
async function start(
  name: string,
  args: string[],
  extra: Record<string, string> = {},
) {
  const dir = join(out, name);
  mkdirSync(dir);
  const proc = spawn(
    hostBin,
    [...args, `--evidence-dir=${dir}`, `--token=${viewToken}`],
    {
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const lines = createInterface({ input: proc.stdout });
  const port = await new Promise<number>((res, rej) => {
    const timeout = setTimeout(
      () => rej(new Error(`host timeout: ${stderr}`)),
      10000,
    );
    lines.on("line", (line) => {
      const m = /^RS_LIVE_HOST_PORT (\d+)$/.exec(line);
      if (m) {
        clearTimeout(timeout);
        res(Number(m[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      rej(new Error(`host exit ${code}: ${stderr}`));
    });
  }).catch((error) => {
    proc.kill("SIGKILL");
    throw error;
  });
  return {
    port,
    dir,
    credential: () =>
      readFileSync(join(dir, "live-track-audio-token"), "utf8").trim(),
    stop: async () => {
      proc.kill("SIGTERM");
      await exited;
      writeFileSync(join(dir, "stderr.log"), stderr);
    },
  };
}
async function connection(port: number, subprotocol = audioSp) {
  const result = await RawTrack.open(port, subprotocol);
  check(result.status.includes("101"), "ws upgrade");
  assert.ok(result.track);
  return result.track;
}
async function refusal(
  port: number,
  text: string | Buffer | null,
  reason: string,
  code: number,
  detail?: string,
) {
  const client = await connection(port);
  try {
    if (typeof text === "string") client.send(text);
    else if (text) client.frame(1, text);
    await client.until(() => client.closed !== null, 2500);
    check(
      client.closed?.code === code && client.closed.reason === reason,
      `${reason}: ${JSON.stringify(client.closed)}`,
    );
    if (detail !== undefined)
      check(
        client
          .controls()
          .some((v) => v.reason === reason && v.detail === detail),
        `${reason}/${detail}`,
      );
  } finally {
    client.destroy();
  }
}
async function ready(
  port: number,
  credential: string,
  extra: Record<string, unknown> = {},
) {
  const client = await connection(port);
  client.send(hello(credential, extra));
  await client.until(
    () =>
      client.texts.some((s) => s.includes('"audio-state"')) ||
      client.closed !== null,
    2000,
  );
  const messages = client.texts.filter(Boolean).map((s) => JSON.parse(s));
  const r = messages[0];
  check(
    r?.type === "track-ready" &&
      r.protocol === "render-stream-audio/1" &&
      r.kind === "audio" &&
      r.format === "gsw-audio/1",
    "audio ready",
  );
  check(
    r.audio.clock_us > 0 &&
      r.audio.rate === 48000 &&
      r.audio.lane_block_frames === 512 &&
      r.audio.codec === "pcm16",
    "ready audio clock/format",
  );
  check(
    r.audio.godot === true &&
      r.audio.fmod === false &&
      r.audio.lanes.length === 0,
    "empty synthetic capabilities",
  );
  check(
    messages[1]?.type === "audio-state" &&
      messages[1].godot.voices.length === 0 &&
      messages[1].godot.buses.length === 0 &&
      messages[1].fmod === null,
    "empty source snapshot follows ready",
  );
  return client;
}
async function main() {
  // Check configuration before starting any listener, including explicit empty values.
  const invalid: [string, string, string][] = [
    ["GODOT", "", "godot"],
    ["GODOT", "stream", "godot"],
    ["QUEUE_BYTES", "4095", "queue-bytes"],
    ["QUEUE_BYTES", "1048577", "queue-bytes"],
    ["LANE_LATE_MS", "9", "lane-late-ms"],
    ["LANE_LATE_MS", "1001", "lane-late-ms"],
    ["STALL_MS", "499", "stall-ms"],
    ["STALL_MS", "30001", "stall-ms"],
    ["STORE_MAX_MS", "999", "store-max-ms"],
    ["STORE_MAX_MS", "60001", "store-max-ms"],
    ["NO_STORE_BUSES", "Music,", "no-store-buses"],
    ["NO_STORE_BUSES", ",Music", "no-store-buses"],
    ["NO_STORE_BUSES", "Music\n", "no-store-buses"],
  ];
  for (const suffix of [
    "QUEUE_BYTES",
    "LANE_LATE_MS",
    "STALL_MS",
    "STORE_MAX_MS",
  ]) {
    for (const v of [
      "",
      "-1",
      "1.0",
      " 1000",
      "1000x",
      "999999999999999999999999999",
    ]) {
      invalid.push([suffix, v, suffix.toLowerCase().replaceAll("_", "-")]);
    }
  }
  for (const [suffix, value, reason] of invalid) {
    const r = spawnSync(hostBin, ["--audio", "--frames=1"], {
      env: { ...env, [`GRC_LIVE_AUDIO_${suffix}`]: value },
      encoding: "utf8",
      timeout: 2000,
      killSignal: "SIGKILL",
    });
    check(
      r.status === 2 && r.stderr.includes(`audio-${reason}-invalid`),
      `config ${suffix}=${JSON.stringify(value)}: exit=${r.status} signal=${r.signal} ${r.stderr}`,
    );
  }
  for (const suffix of [
    "GODOT",
    "QUEUE_BYTES",
    "LANE_LATE_MS",
    "STALL_MS",
    "STORE_MAX_MS",
    "NO_STORE_BUSES",
    "UNKNOWN",
  ]) {
    const r = spawnSync(hostBin, ["--frames=1"], {
      env: { ...env, [`GRC_LIVE_AUDIO_${suffix}`]: "" },
      encoding: "utf8",
      timeout: 2000,
      killSignal: "SIGKILL",
    });
    check(
      r.status === 2 && r.stderr.includes("audio-not-granted"),
      `not granted ${suffix}`,
    );
  }
  const host = await start("honest", [
    "--audio",
    "--tracks=input,audio",
    "--track-keepalive-ms=250",
    "--hello-timeout-ms=150",
    "--max-tracks=2",
    "--track-rate=10",
  ]);
  try {
    const credential = host.credential();
    const input = readFileSync(
      join(host.dir, "live-track-input-token"),
      "utf8",
    ).trim();
    check(
      credential !== input &&
        credential !== viewToken &&
        /^[0-9a-f]{64}$/.test(credential),
      "separate audio credential",
    );
    check(
      (statSync(join(host.dir, "live-track-audio-token")).mode & 0o777) ===
        0o600,
      "credential mode",
    );
    for (const extra of [
      {},
      { audio: { codecs: ["pcm16"], sample_codecs: ["mp3"] } },
    ]) {
      const client = await ready(host.port, credential, extra);
      client.close();
      await client.until(() => client.closed !== null, 1000);
      client.destroy();
    }
    await refusal(host.port, "{", "track-protocol", 1002, "json");
    await refusal(host.port, Buffer.from([0xc0, 0x80]), "track-utf8", 1007);
    await refusal(
      host.port,
      hello(credential, { protocol: "render-stream-track/1" }),
      "track-protocol",
      1002,
      "protocol",
    );
    await refusal(
      host.port,
      hello(credential, { kind: "input" }),
      "track-protocol",
      1002,
      "kind",
    );
    await refusal(
      host.port,
      hello(credential, { audio: { codecs: [], sample_codecs: [] } }),
      "track-protocol",
      1002,
      "audio",
    );
    await refusal(
      host.port,
      hello(credential, { audio: null }),
      "track-protocol",
      1002,
      "audio",
    );
    await refusal(
      host.port,
      hello(viewToken),
      "track-unauthorized",
      1008,
      "view-token",
    );
    await refusal(host.port, hello(input), "track-unauthorized", 1008, "wrong");
    await refusal(host.port, hello(""), "track-unauthorized", 1008, "missing");
    await refusal(
      host.port,
      hello(credential, { formats: ["unknown/1"] }),
      "track-format-refused",
      1008,
    );
    await refusal(host.port, null, "track-hello-timeout", 1002);
    const idle = await ready(host.port, credential);
    await idle.until(() => idle.closed !== null, 1800);
    check(
      idle.closed?.reason === "track-idle" && idle.closed.code === 1001,
      "idle",
    );
    idle.destroy();
    const rate = await ready(host.port, credential);
    for (let i = 0; i < 30; i++) rate.send("");
    await rate.until(() => rate.closed !== null, 1000);
    check(
      rate.closed?.reason === "track-rate" && rate.closed.code === 1008,
      "rate",
    );
    rate.destroy();
    for (const [op, payload, code] of [
      [2, Buffer.from([1]), 1003],
      [1, Buffer.alloc(4097, 97), 1009],
    ] as const) {
      const client = await connection(host.port);
      client.frame(op, payload);
      await client.until(() => client.closed !== null, 1000);
      check(client.closed?.code === code, `inbound ${code}`);
      client.destroy();
    }
    const one = await connection(host.port);
    const two = await connection(host.port, "render-stream-track.1");
    const third = await RawTrack.open(host.port, audioSp);
    check(third.status.includes("503"), "shared track admission cap");
    third.track?.destroy();
    one.destroy();
    two.destroy();
  } finally {
    await host.stop();
  }
  for (const [name, values] of [
    ["minimum", ["4096", "10", "500", "1000"]],
    ["maximum", ["1048576", "1000", "30000", "60000"]],
  ] as const) {
    const boundary = await start(name, ["--audio"], {
      GRC_LIVE_TRACKS: "audio",
      GRC_LIVE_AUDIO_GODOT: "off",
      GRC_LIVE_AUDIO_QUEUE_BYTES: values[0],
      GRC_LIVE_AUDIO_LANE_LATE_MS: values[1],
      GRC_LIVE_AUDIO_STALL_MS: values[2],
      GRC_LIVE_AUDIO_STORE_MAX_MS: values[3],
      GRC_LIVE_AUDIO_NO_STORE_BUSES: name === "minimum" ? "" : "Music,Ambience",
    });
    try {
      const client = await ready(boundary.port, boundary.credential());
      client.send('{"type":"unknown"}');
      await client.until(() => client.closed !== null, 1000);
      check(
        client.closed?.reason === "audio-protocol" &&
          client.closed.code === 1002,
        "invalid audio payload",
      );
      client.destroy();
    } finally {
      await boundary.stop();
    }
  }
  const noSource = await start("no-source", ["--tracks=audio"]);
  try {
    const ungranted = await connection(noSource.port, "render-stream-track.1");
    ungranted.send(
      hello("wrong", {
        protocol: "render-stream-track/1",
        kind: "input",
        formats: ["gsw-input/1"],
      }),
    );
    await ungranted.until(() => ungranted.closed !== null, 1000);
    check(
      ungranted.closed?.reason === "track-kind-refused" &&
        ungranted.closed.code === 1008,
      "ungranted kind checked before credential",
    );
    ungranted.destroy();
    await refusal(
      noSource.port,
      hello(noSource.credential()),
      "track-no-receiver",
      1013,
    );
  } finally {
    await noSource.stop();
  }
  const caps = await start("caps", ["--audio", "--track-caps=hmac"]);
  try {
    const key = readCapKeyFile(join(caps.dir, "live-track-cap-key"));
    const client = await ready(
      caps.port,
      mintTrackCapFor(key, "audio", "audio-viewer", 300),
    );
    client.destroy();
    await refusal(
      caps.port,
      hello(mintTrackCapFor(key, "input", "viewer", 300)),
      "track-unauthorized",
      1008,
      "wrong-kind",
    );
    await refusal(
      caps.port,
      hello(
        mintTrackCapFor(
          key,
          "audio",
          "viewer",
          1,
          Math.floor(Date.now() / 1000) - 100,
        ),
      ),
      "track-unauthorized",
      1008,
      "expired",
    );
  } finally {
    await caps.stop();
  }
  const pure = await start("pure", []);
  try {
    const audio = await RawTrack.open(pure.port, audioSp);
    const unknown = await RawTrack.open(pure.port, "unknown.1");
    check(
      audio.status.includes("400") && audio.head === unknown.head,
      "pure audio upgrade byte identical",
    );
    audio.track?.destroy();
    unknown.track?.destroy();
  } finally {
    await pure.stop();
  }
  console.log(`self-test-audio: ${passed} passed, 0 failed; logs ${out}`);
}
main().catch((e) => {
  console.error(e);
  console.error(`logs: ${out}`);
  process.exitCode = 1;
});
