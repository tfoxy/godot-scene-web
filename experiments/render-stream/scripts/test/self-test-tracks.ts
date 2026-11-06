// TRK1 (protocol/tracks-design.md, TRK1 row): render-stream-track/1 end to end through the
// production TrackHub, CarrierSet and rs_ws, with capture/build/rs_live_host --tracks (the same
// routing as entry.cpp's live_drain) and an independent Node track client over raw sockets.
//
// Checks (each a named predicate):
//   delivered          payloads the client sent equal what the host's test receiver recorded,
//                      in order, between one `opened` and one `closed`; `track-ready` has the
//                      negotiated format; keepalives ("") are never delivered; a down payload
//                      comes back when a down format was agreed
//   view-token         the view token as the credential: track-error + close 1008
//                      `track-unauthorized`, detail `view-token`; no `opened`
//   wrong-credential   track-unauthorized `wrong`
//   kind-refused       an ungranted kind: `track-kind-refused` 1008
//   rate               a burst above the bucket: close 1008 `track-rate` and a `closed`
//   idle               a client that stops sending: close 1001 `track-idle` and a `closed`
//   kill-closed        a client socket destroyed mid-track: the receiver gets its `closed`
//   no-receiver        nothing bound: `track-no-receiver` 1013 (a host with --track-receiver=none)
//   view-beside        a /7 view session beside an open track gets its stream; the hub tap holds
//                      view files for view connections only, and the track tap holds no payload
//                      and a redacted credential
//   evidence           live-tracks.json counts (opened, refused incl. the view-token key) and
//                      live-carriers.json `sessions` counting view connections only
//   pure-path          a host without --tracks answers a track upgrade with the same bytes as an
//                      unknown subprotocol's, writes no track file, and its live-carriers.json has
//                      the same members as a tracks-on run's
//   caps (TRK5)        a host with --track-caps=hmac: the key file (64 hex, 0600, no shared token
//                      file); a capability minted by scripts/lib/track-cap.ts opens with its
//                      `subject` and delivers; one 5 s past exp opens (skew); `cap-expired`,
//                      `cap-bad-mac` (payload changed after signing), `cap-wrong-kind`,
//                      `cap-shared-form` (a 64-hex credential: malformed) and the view token are
//                      refused with their details; `cap-no-secret`: no tap, evidence file, stdout
//                      or stderr line holds the key or a capability's MAC; `cap-evidence`:
//                      live-tracks.json `caps: "hmac"` and the refusals under
//                      `track-unauthorized:<detail>`
// Sabotages (GRC_SABOTAGE on the host): track-view-token-accepted must fail `view-token`,
// track-rate-off `rate`, track-grant-ignored `kind-refused`, track-no-release `kill-closed`,
// track-cap-exp-ignored `cap-expired`, track-cap-mac-ignored `cap-bad-mac`.
// The default run does the honest pass and all six; `--only honest|<sabotage>` runs one.
// Usage: mise exec -- pnpm exec tsx --conditions=development \
//          experiments/render-stream/scripts/test/self-test-tracks.ts [--only X] [--keep]
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { type Closed, RawTrack } from "../lib/raw-track-client";
import {
  mintTrackCap,
  mintTrackCapFor,
  readCapKeyFile,
} from "../lib/track-cap";

const RS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = join(RS, "capture/build/rs_live_host");
const VIEW_TOKEN = "cd".repeat(32);
const SUBPROTOCOL = "render-stream-track.1";
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;

function hello(
  credential: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "track-hello",
    protocol: "render-stream-track/1",
    kind: "input",
    formats: ["gsw-input/1"],
    down_formats: [],
    credential,
    client: "self-test-tracks",
    view: null,
    ...extra,
  });
}

// ----------------------------------------------------------------------------- the host

interface Host {
  proc: ChildProcess;
  port: number;
  tokenFile: string | null;
  capKeyFile: string | null;
  exited: Promise<number | null>;
  stdout: string[];
  stderr: () => string;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GRC_")) delete e[k];
  return e;
}

async function startHost(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Host> {
  const proc = spawn(
    HOST,
    [
      ...args,
      `--evidence-dir=${dir}`,
      `--tap-dir=${join(dir, "tap")}`,
      `--token=${VIEW_TOKEN}`,
    ],
    { env: { ...cleanEnv(), ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((r) =>
    proc.on("exit", (c) => r(c)),
  );
  const stdout: string[] = [];
  let stderr = "";
  proc.stderr!.on("data", (d) => {
    stderr += String(d);
  });
  const lines = createInterface({ input: proc.stdout! });
  const got: Record<string, string> = {};
  const tracks = args.some((a) => a.startsWith("--tracks="));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`rs_live_host did not start\n${stderr}`)),
      15000,
    );
    lines.on("line", (l) => {
      stdout.push(l);
      const m = /^(RS_LIVE_HOST_[A-Z0-9_]+) (\S+)$/.exec(l);
      if (m) got[m[1]] = m[2];
      if (
        got.RS_LIVE_HOST_PORT &&
        (!tracks ||
          got.RS_LIVE_HOST_TRACK_TOKEN_FILE ||
          got.RS_LIVE_HOST_TRACK_CAP_KEY_FILE)
      ) {
        clearTimeout(t);
        res();
      }
    });
    proc.on("exit", (c) =>
      rej(new Error(`rs_live_host exited ${c} before listening\n${stderr}`)),
    );
  });
  return {
    proc,
    port: Number(got.RS_LIVE_HOST_PORT),
    tokenFile: got.RS_LIVE_HOST_TRACK_TOKEN_FILE ?? null,
    capKeyFile: got.RS_LIVE_HOST_TRACK_CAP_KEY_FILE ?? null,
    exited,
    stdout,
    stderr: () => stderr,
  };
}

async function stopHost(h: Host): Promise<number | null> {
  h.proc.kill("SIGTERM");
  const t = setTimeout(() => h.proc.kill("SIGKILL"), 10000);
  const c = await h.exited;
  clearTimeout(t);
  return c;
}

interface Rec {
  event: "opened" | "message" | "closed";
  source: number;
  text?: string;
  code?: number;
  reason?: string;
  format?: string;
  down_format?: string | null;
  subject?: string;
}

function records(file: string): Rec[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Rec);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An open track: the client after its track-ready (or its refusal). */
async function openTrack(
  port: number,
  helloText: string,
): Promise<{
  track: RawTrack;
  ready: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}> {
  const { status, track } = await RawTrack.open(port, SUBPROTOCOL);
  if (!status.includes(" 101 ")) throw new Error(`track upgrade: ${status}`);
  track.send(helloText);
  await track.until(() => track.controls().length > 0 || track.ended, 3000);
  const c = track.controls()[0] ?? null;
  return {
    track,
    ready: c && c.type === "track-ready" ? c : null,
    error: c && c.type === "track-error" ? c : null,
  };
}

// ----------------------------------------------------------------------------- one pass

type Results = Map<string, boolean>;

async function viewSession(
  port: number,
): Promise<{ binary: number; close: Closed | null }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/render-stream`,
    "render-stream.7",
  );
  ws.binaryType = "arraybuffer";
  let binary = 0;
  let close: Closed | null = null;
  const done = new Promise<void>((res) => {
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: "render-stream/7",
          receiver: "self-test-tracks",
          receiver_kind: "gsw-canvas",
          credit_stage: "submitted",
          credit_window: 1,
          inbound_buffer_bytes: 16777216,
          token: VIEW_TOKEN,
          manifest_sha256: null,
          presentation_backing_w: 640,
          presentation_backing_h: 360,
          presentation_css_w: 640,
          presentation_css_h: 360,
          dpr_milli: 1000,
        }),
      );
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") binary++;
    };
    ws.onclose = (e) => {
      close = { code: e.code, reason: e.reason };
      res();
    };
    ws.onerror = () => {};
  });
  const t0 = Date.now();
  while (binary === 0 && Date.now() - t0 < 3000) await sleep(20);
  ws.close(1000);
  await Promise.race([done, sleep(2000)]);
  return { binary, close };
}

async function mainPass(
  label: string,
  sabotage: string | null,
): Promise<Results> {
  const r: Results = new Map();
  const note = (name: string, ok: boolean, why = "") => {
    r.set(name, (r.get(name) ?? true) && ok);
    console.log(
      `  [${label}] ${ok ? "ok  " : "FAIL"} ${name}${why ? ` (${why})` : ""}`,
    );
  };
  const dir = mkdtempSync(join(tmpdir(), "rs-tracks-"));
  const out = join(dir, "track-out.jsonl");
  const host = await startHost(
    dir,
    [
      "--tracks=input",
      "--track-rate=100",
      "--track-keepalive-ms=250",
      "--track-down-formats=gsw-input-feedback/1",
      "--track-echo",
      `--track-out=${out}`,
    ],
    sabotage ? { GRC_SABOTAGE: sabotage } : {},
  );
  const credential = readFileSync(host.tokenFile!, "utf8").trim();
  note(
    "credential",
    /^[0-9a-f]{64}$/.test(credential) && credential !== VIEW_TOKEN,
  );
  const mode = (await import("node:fs")).statSync(host.tokenFile!).mode & 0o777;
  note("credential-mode-0600", mode === 0o600, mode.toString(8));
  try {
    // delivered (with a down format: each payload echoes back)
    {
      const { track, ready } = await openTrack(
        host.port,
        hello(credential, { down_formats: ["gsw-input-feedback/1"] }),
      );
      track.startKeepalive(100);
      const sent: string[] = [];
      for (let i = 0; i < 40; i++) {
        const p = JSON.stringify({ n: i, key: "KeyA", text: "é→😀" });
        sent.push(p);
        track.send(p);
        if (i % 10 === 0) track.send("");
      }
      await track.until(
        () =>
          track.texts.filter((t) => t.startsWith('{"n":')).length >=
          sent.length,
        3000,
      );
      const echoed = track.texts.filter((t) => t.startsWith('{"n":'));
      track.close(1000);
      await track.until(() => track.ended, 3000);
      await sleep(150);
      const source = Number(ready?.source ?? 0);
      const mine = records(out).filter((x) => x.source === source);
      const msgs = mine.filter((x) => x.event === "message").map((x) => x.text);
      note(
        "delivered",
        ready !== null &&
          ready.format === "gsw-input/1" &&
          ready.down_format === "gsw-input-feedback/1" &&
          ready.keepalive_ms === 250 &&
          mine[0]?.event === "opened" &&
          mine.filter((x) => x.event === "opened").length === 1 &&
          mine.filter((x) => x.event === "closed").length === 1 &&
          mine[mine.length - 1]?.event === "closed" &&
          JSON.stringify(msgs) === JSON.stringify(sent) &&
          JSON.stringify(echoed) === JSON.stringify(sent),
        `ready=${JSON.stringify(ready)} delivered=${msgs.length}/${sent.length} echoed=${echoed.length}`,
      );
    }
    const before = records(out).length;
    // view-token
    {
      const { track, error, ready } = await openTrack(
        host.port,
        hello(VIEW_TOKEN),
      );
      await track.until(() => track.closed !== null || track.ended, 2000);
      note(
        "view-token",
        ready === null &&
          error?.reason === "track-unauthorized" &&
          error?.detail === "view-token" &&
          track.closed?.code === 1008 &&
          track.closed?.reason === "track-unauthorized",
        JSON.stringify({ error, closed: track.closed }),
      );
      track.destroy();
    }
    // wrong-credential
    {
      const { track, error } = await openTrack(
        host.port,
        hello("ab".repeat(32)),
      );
      await track.until(() => track.closed !== null || track.ended, 2000);
      note(
        "wrong-credential",
        error?.reason === "track-unauthorized" &&
          error?.detail === "wrong" &&
          track.closed?.code === 1008,
      );
      track.destroy();
    }
    // kind-refused
    {
      const { track, error } = await openTrack(
        host.port,
        hello(credential, { kind: "gamepad" }),
      );
      await track.until(() => track.closed !== null || track.ended, 2000);
      note(
        "kind-refused",
        error?.reason === "track-kind-refused" &&
          track.closed?.code === 1008 &&
          track.closed?.reason === "track-kind-refused",
        JSON.stringify({ error, closed: track.closed }),
      );
      track.destroy();
    }
    await sleep(100);
    note(
      "refused-no-opened",
      records(out).length === before ||
        sabotage === "track-view-token-accepted" ||
        sabotage === "track-grant-ignored",
    );
    // rate: 400 texts at once against a bucket of 200
    {
      const { track, ready } = await openTrack(host.port, hello(credential));
      for (let i = 0; i < 400; i++) track.send(`{"r":${i}}`);
      await track.until(() => track.closed !== null || track.ended, 3000);
      await sleep(150);
      const source = Number(ready?.source ?? 0);
      const closed = records(out).filter(
        (x) => x.source === source && x.event === "closed",
      );
      note(
        "rate",
        track.closed?.code === 1008 &&
          track.closed?.reason === "track-rate" &&
          closed.length === 1 &&
          closed[0].reason === "track-rate",
        JSON.stringify({ closed: track.closed, recorded: closed }),
      );
      track.destroy();
    }
    // idle: no keepalive from the client; the host closes after 3 x 250 ms
    {
      const t0 = Date.now();
      const { track, ready } = await openTrack(host.port, hello(credential));
      await track.until(() => track.closed !== null || track.ended, 3000);
      const ms = Date.now() - t0;
      await sleep(100);
      const source = Number(ready?.source ?? 0);
      const closed = records(out).filter(
        (x) => x.source === source && x.event === "closed",
      );
      const keepalives = track.texts.filter((t) => t === "").length;
      note(
        "idle",
        track.closed?.code === 1001 &&
          track.closed?.reason === "track-idle" &&
          closed.length === 1 &&
          keepalives >= 1 &&
          ms >= 700,
        `${ms} ms, ${keepalives} host keepalives, closed ${JSON.stringify(track.closed)}`,
      );
      track.destroy();
    }
    // kill-closed
    {
      const { track, ready } = await openTrack(host.port, hello(credential));
      track.send('{"held":"KeyW"}');
      await sleep(100);
      track.destroy();
      const source = Number(ready?.source ?? 0);
      const t0 = Date.now();
      let closed: Rec[] = [];
      while (Date.now() - t0 < 2000) {
        closed = records(out).filter(
          (x) => x.source === source && x.event === "closed",
        );
        if (closed.length > 0) break;
        await sleep(50);
      }
      note(
        "kill-closed",
        ready !== null && closed.length === 1,
        JSON.stringify(closed),
      );
    }
    // view-beside
    {
      const { track, ready } = await openTrack(host.port, hello(credential));
      track.startKeepalive(100);
      track.send('{"secret":"hunter2"}');
      const view = await viewSession(host.port);
      track.close(1000);
      await track.until(() => track.ended, 2000);
      await sleep(150);
      const tap = readdirSync(join(dir, "tap"));
      const viewFiles = tap.filter((f) => /^(stream|live)-/.test(f));
      const trackTap = join(
        dir,
        "tap",
        `track-${Number(ready?.source ?? 0)}.jsonl`,
      );
      const trackText = existsSync(trackTap)
        ? readFileSync(trackTap, "utf8")
        : "";
      const allTrackTaps = tap
        .filter((f) => f.startsWith("track-"))
        .map((f) => readFileSync(join(dir, "tap", f), "utf8"))
        .join("\n");
      note(
        "view-beside",
        view.binary > 0 &&
          viewFiles.length === 2 &&
          trackText.includes('"credential":"<redacted>"') &&
          !allTrackTaps.includes("hunter2") &&
          !allTrackTaps.includes(credential) &&
          !allTrackTaps.includes(VIEW_TOKEN),
        `view binary=${view.binary} view files=${viewFiles.join(",")}`,
      );
    }
  } finally {
    const code = await stopHost(host);
    note("host-exit", code === 0, String(code));
  }
  // evidence
  {
    const lt = JSON.parse(readFileSync(join(dir, "live-tracks.json"), "utf8"));
    const lc = JSON.parse(
      readFileSync(join(dir, "live-carriers.json"), "utf8"),
    );
    const input = lt.tracks?.input ?? {};
    const ws = (lc.carriers ?? []).find(
      (c: { name: string }) => c.name === "ws",
    );
    const recs = records(out);
    const opened = recs.filter((x) => x.event === "opened").length;
    const closed = recs.filter((x) => x.event === "closed").length;
    note(
      "evidence",
      lt.schema === "render-stream-live-tracks/1" &&
        input.opened === opened &&
        (sabotage === "track-view-token-accepted" ||
          input.refused?.["track-unauthorized:view-token"] === 1) &&
        (sabotage === "track-grant-ignored" ||
          lt.refused?.["track-kind-refused"] === 1) &&
        ws?.sessions === 1 &&
        lt.carriers?.[0]?.tracks === true,
      `opened=${opened} json=${JSON.stringify({ opened: input.opened, refused: input.refused, top: lt.refused })} ws.sessions=${ws?.sessions}`,
    );
    // T8: one closed per opened, whatever ended it (stream-ended included)
    note(
      "pairing",
      opened === closed || sabotage === "track-no-release",
      `opened=${opened} closed=${closed}`,
    );
  }
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`  [${label}] kept ${dir}`);
  return r;
}

/** Every file under `dir`, recursively, as text. */
function allFiles(dir: string): string {
  let text = "";
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    text += e.isDirectory() ? allFiles(p) : `${readFileSync(p, "utf8")}\n`;
  }
  return text;
}

async function capsPass(
  label: string,
  sabotage: string | null,
): Promise<Results> {
  const r: Results = new Map();
  const note = (name: string, ok: boolean, why = "") => {
    r.set(name, (r.get(name) ?? true) && ok);
    console.log(
      `  [${label}] ${ok ? "ok  " : "FAIL"} ${name}${why ? ` (${why})` : ""}`,
    );
  };
  const dir = mkdtempSync(join(tmpdir(), "rs-tracks-caps-"));
  const out = join(dir, "track-out.jsonl");
  const host = await startHost(
    dir,
    ["--tracks=input", "--track-caps=hmac", `--track-out=${out}`],
    sabotage ? { GRC_SABOTAGE: sabotage } : {},
  );
  const keyFile = host.capKeyFile ?? join(dir, "live-track-cap-key");
  const keyHex = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
  const mode = existsSync(keyFile)
    ? (await import("node:fs")).statSync(keyFile).mode & 0o777
    : 0;
  note(
    "cap-key",
    host.capKeyFile !== null &&
      host.tokenFile === null &&
      /^[0-9a-f]{64}$/.test(keyHex) &&
      keyHex !== VIEW_TOKEN &&
      mode === 0o600 &&
      !existsSync(join(dir, "live-track-input-token")),
    `mode ${mode.toString(8)}`,
  );
  const key = readCapKeyFile(keyFile);
  const now = Math.floor(Date.now() / 1000);
  const presented: string[] = [];
  const attempt = async (credential: string) => {
    presented.push(credential);
    const t = await openTrack(host.port, hello(credential));
    return t;
  };
  const refusedWith = async (
    name: string,
    credential: string,
    detail: string,
  ) => {
    const { track, error } = await attempt(credential);
    await track.until(() => track.closed !== null || track.ended, 2000);
    note(
      name,
      error?.reason === "track-unauthorized" &&
        error?.detail === detail &&
        track.closed?.code === 1008 &&
        track.closed?.reason === "track-unauthorized",
      `${JSON.stringify(error)} ${JSON.stringify(track.closed)}`,
    );
    track.destroy();
  };
  try {
    {
      const { track, ready } = await attempt(
        mintTrackCapFor(key, "input", "viewer-1", 300),
      );
      track.send('{"n":1}');
      await sleep(200);
      track.close(1000);
      await track.until(() => track.ended, 3000);
      await sleep(100);
      const recs = records(out);
      const opened = recs.find(
        (x) => x.event === "opened" && x.source === Number(ready?.source),
      );
      const msgs = recs.filter(
        (x) => x.event === "message" && x.source === Number(ready?.source),
      );
      note(
        "cap-accepted",
        ready !== null &&
          opened?.subject === "viewer-1" &&
          msgs.length === 1 &&
          msgs[0].text === '{"n":1}',
        `ready=${ready !== null} opened=${JSON.stringify(opened)}`,
      );
    }
    {
      const { track, ready } = await attempt(
        mintTrackCap(key, { kind: "input", sub: "viewer-skew", exp: now - 5 }),
      );
      note("cap-skew", ready !== null);
      track.destroy();
    }
    await refusedWith(
      "cap-expired",
      mintTrackCap(key, { kind: "input", sub: "viewer-old", exp: now - 120 }),
      "expired",
    );
    {
      const good = mintTrackCapFor(key, "input", "viewer-1", 300);
      const forged = Buffer.from(
        JSON.stringify({ v: 1, kind: "input", sub: "admin", exp: now + 300 }),
      ).toString("base64url");
      await refusedWith(
        "cap-bad-mac",
        `cap1.${forged}.${good.split(".")[2]}`,
        "bad-mac",
      );
    }
    await refusedWith(
      "cap-wrong-kind",
      mintTrackCapFor(key, "clipboard", "viewer-1", 300),
      "wrong-kind",
    );
    await refusedWith("cap-shared-form", "9f".repeat(32), "malformed");
    await refusedWith("cap-view-token", VIEW_TOKEN, "view-token");
  } finally {
    const code = await stopHost(host);
    note("host-exit", code === 0, String(code));
  }
  {
    // The key and every presented MAC: in no tap, evidence file (bar the key file) or log line.
    const files = allFiles(dir).replace(keyHex, "<the key file>");
    const logs = `${host.stdout.join("\n")}\n${host.stderr()}`;
    const secrets = [
      keyHex,
      ...presented
        .filter((c) => c.startsWith("cap1."))
        .map((c) => c.split(".")[2]),
    ];
    const leaks = secrets.filter(
      (x) => x.length > 0 && (files.includes(x) || logs.includes(x)),
    );
    note(
      "cap-no-secret",
      leaks.length === 0 && !files.includes("cap1.") && !logs.includes("cap1."),
      `${leaks.length} leaked`,
    );
    const lt = JSON.parse(readFileSync(join(dir, "live-tracks.json"), "utf8"));
    const refused = lt.tracks?.input?.refused ?? {};
    note(
      "cap-evidence",
      lt.caps === "hmac" &&
        refused["track-unauthorized:view-token"] === 1 &&
        refused["track-unauthorized:malformed"] === 1 &&
        refused["track-unauthorized:wrong-kind"] === 1 &&
        (sabotage === "track-cap-exp-ignored" ||
          refused["track-unauthorized:expired"] === 1) &&
        (sabotage === "track-cap-mac-ignored" ||
          refused["track-unauthorized:bad-mac"] === 1) &&
        refused["track-unauthorized"] === undefined,
      JSON.stringify(refused),
    );
  }
  if (!keep) rmSync(dir, { recursive: true, force: true });
  else console.log(`  [${label}] kept ${dir}`);
  return r;
}

async function noReceiverPass(): Promise<Results> {
  const r: Results = new Map();
  const dir = mkdtempSync(join(tmpdir(), "rs-tracks-nr-"));
  const host = await startHost(dir, [
    "--tracks=input",
    "--track-receiver=none",
  ]);
  const credential = readFileSync(host.tokenFile!, "utf8").trim();
  try {
    const { track, error } = await openTrack(host.port, hello(credential));
    await track.until(() => track.closed !== null || track.ended, 2000);
    const ok =
      error?.reason === "track-no-receiver" &&
      track.closed?.code === 1013 &&
      track.closed?.reason === "track-no-receiver";
    console.log(
      `  [no-receiver] ${ok ? "ok  " : "FAIL"} no-receiver (${JSON.stringify(track.closed)})`,
    );
    r.set("no-receiver", ok);
    track.destroy();
  } finally {
    await stopHost(host);
  }
  rmSync(dir, { recursive: true, force: true });
  return r;
}

/** The whole response to an upgrade offering `protocols`, read until the server closes. */
async function upgradeResponse(
  port: number,
  protocols: string,
): Promise<string> {
  const { head, track } = await RawTrack.open(port, protocols);
  track.destroy();
  return head;
}

async function purePathPass(): Promise<Results> {
  const r: Results = new Map();
  const dir = mkdtempSync(join(tmpdir(), "rs-tracks-off-"));
  const host = await startHost(dir, []);
  let track = "";
  let unknown = "";
  try {
    track = await upgradeResponse(host.port, SUBPROTOCOL);
    unknown = await upgradeResponse(host.port, "nope.1");
  } finally {
    await stopHost(host);
  }
  const files = readdirSync(dir);
  const onDir = mkdtempSync(join(tmpdir(), "rs-tracks-on-"));
  const on = await startHost(onDir, ["--tracks=input"]);
  await stopHost(on);
  const keysOff = Object.keys(
    JSON.parse(readFileSync(join(dir, "live-carriers.json"), "utf8")),
  ).sort();
  const keysOn = Object.keys(
    JSON.parse(readFileSync(join(onDir, "live-carriers.json"), "utf8")),
  ).sort();
  const ok =
    track.startsWith("HTTP/1.1 400") &&
    track === unknown &&
    !files.some((f) => f.startsWith("live-track")) &&
    JSON.stringify(keysOff) === JSON.stringify(keysOn);
  console.log(
    `  [pure-path] ${ok ? "ok  " : "FAIL"} pure-path (${JSON.stringify(track.split("\r\n")[0])}, files ${files.join(",")})`,
  );
  r.set("pure-path", ok);
  rmSync(dir, { recursive: true, force: true });
  rmSync(onDir, { recursive: true, force: true });
  return r;
}

// ----------------------------------------------------------------------------- main

const SABOTAGES: Record<string, string> = {
  "track-view-token-accepted": "view-token",
  "track-rate-off": "rate",
  "track-grant-ignored": "kind-refused",
  "track-no-release": "kill-closed",
};
// TRK5: run against the caps pass.
const CAP_SABOTAGES: Record<string, string> = {
  "track-cap-exp-ignored": "cap-expired",
  "track-cap-mac-ignored": "cap-bad-mac",
};

async function main(): Promise<number> {
  if (!existsSync(HOST)) {
    console.error(
      `self-test-tracks: ${HOST} is missing (scripts/build-capture.sh)`,
    );
    return 2;
  }
  let failed = 0;
  if (only === null || only === "honest") {
    console.log("honest:");
    const all = new Map([
      ...(await mainPass("honest", null)),
      ...(await noReceiverPass()),
      ...(await capsPass("caps", null)),
      ...(await purePathPass()),
    ]);
    for (const [name, ok] of all)
      if (!ok) {
        console.log(`FAIL honest: ${name}`);
        failed++;
      }
  }
  for (const [sabotage, predicate] of Object.entries(SABOTAGES)) {
    if (only !== null && only !== sabotage) continue;
    console.log(`sabotage ${sabotage} (must fail ${predicate}):`);
    const res = await mainPass(sabotage, sabotage);
    if (res.get(predicate) !== false) {
      console.log(`FAIL sabotage ${sabotage} went unnoticed by ${predicate}`);
      failed++;
    } else {
      console.log(`ok   sabotage ${sabotage} caught by ${predicate}`);
    }
  }
  for (const [sabotage, predicate] of Object.entries(CAP_SABOTAGES)) {
    if (only !== null && only !== sabotage) continue;
    console.log(`sabotage ${sabotage} (must fail ${predicate}):`);
    const res = await capsPass(sabotage, sabotage);
    if (res.get(predicate) !== false) {
      console.log(`FAIL sabotage ${sabotage} went unnoticed by ${predicate}`);
      failed++;
    } else {
      console.log(`ok   sabotage ${sabotage} caught by ${predicate}`);
    }
  }
  console.log(
    failed === 0
      ? "self-test-tracks: PASS"
      : `self-test-tracks: FAIL (${failed})`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
