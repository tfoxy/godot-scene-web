#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7e's pure pieces (never a browser or a Godot run):
//
//  1. listPck (lib/godot-pck.ts) reads a synthetic format-3 .pck directory exactly, and refuses a
//     bad magic and an encrypted directory.
//  2. mapNativeLeg (lib/gate7-web-legs.ts) maps a native leg's env.txt/argv.txt: the recording is
//     copied and named by its URL, RS_RECEIVER_OUT moves to the web leg, RS_RECEIVER_CACHE_DIR is
//     dropped, a store under the source run becomes /sources/<gate>/..., other values pass
//     verbatim, --resolution becomes the canvas, --headless and the fixed args go; a path outside
//     both the leg and the source run is refused.
//  3. normalizeApplied/jsonDiffPaths (lib/gate7-adapters.ts): timings, paths, process frames,
//     `receiver`, `cache` and `display_server` are ignored, and any other difference is found.
//  4. buildGate0View: receiver legs link to the web legs, everything else to the source.

import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGate0View,
  jsonDiffPaths,
  normalizeApplied,
} from "../lib/gate7-adapters";
import { mapNativeLeg } from "../lib/gate7-web-legs";
import { listPck } from "../lib/godot-pck";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}

function pck(paths: string[], flags = 2, magic = 0x43504447): Uint8Array {
  const enc = new TextEncoder();
  const entries = paths.map((p) => {
    const raw = enc.encode(p);
    const padded = new Uint8Array(Math.ceil(raw.length / 4) * 4);
    padded.set(raw);
    return padded;
  });
  const headerLen = 4 * 6 + 8 + 8 + 16 * 4;
  const dirLen =
    4 + entries.reduce((s, e) => s + 4 + e.length + 8 + 8 + 16 + 4, 0);
  const buf = new Uint8Array(headerLen + dirLen);
  const v = new DataView(buf.buffer);
  let at = 0;
  const u32 = (x: number) => {
    v.setUint32(at, x, true);
    at += 4;
  };
  const u64 = (x: number) => {
    v.setBigUint64(at, BigInt(x), true);
    at += 8;
  };
  u32(magic);
  u32(3);
  u32(4);
  u32(5);
  u32(1);
  u32(flags);
  u64(headerLen + dirLen);
  u64(headerLen);
  at = headerLen;
  u32(entries.length);
  entries.forEach((e, i) => {
    u32(e.length);
    buf.set(e, at);
    at += e.length;
    u64(i * 16);
    u64(10 + i);
    for (let k = 0; k < 16; k++) buf[at + k] = k;
    at += 16;
    u32(0);
  });
  return buf;
}

// 1. listPck.
{
  const listing = listPck(
    pck(["res://receiver.gd", "res://project.binary", "res://a/b/c.tscn"]),
  );
  expect(
    "pck: engine and version",
    listing.engine === "4.5.1" && listing.formatVersion === 3,
  );
  expect(
    "pck: paths unpadded",
    JSON.stringify(listing.files.map((f) => f.path)) ===
      JSON.stringify([
        "res://receiver.gd",
        "res://project.binary",
        "res://a/b/c.tscn",
      ]),
    JSON.stringify(listing.files.map((f) => f.path)),
  );
  expect(
    "pck: sizes and md5",
    listing.files[2].size === 12 &&
      listing.files[0].md5 === "000102030405060708090a0b0c0d0e0f",
  );
  let threw = false;
  try {
    listPck(pck(["x"], 2, 0x12345678));
  } catch {
    threw = true;
  }
  expect("pck: bad magic refused", threw);
  threw = false;
  try {
    listPck(pck(["x"], 3));
  } catch {
    threw = true;
  }
  expect("pck: encrypted directory refused", threw);
}

// 2. mapNativeLeg.
const root = mkdtempSync(join(tmpdir(), "g7e-selftest-"));
try {
  const out = join(root, "g7");
  const source = join(root, "src");
  const nativeDir = join(source, "receiver");
  const webDir = join(out, "gate0", "web", "receiver");
  const envTxt = [
    "# unset: DISPLAY WAYLAND_DISPLAY",
    `RS_RECEIVER_RECORDING=${nativeDir}/recording.rs2`,
    `RS_RECEIVER_OUT=${nativeDir}/applied.json`,
    "RS_RECEIVER_SHOT_SEQS=3,5,7",
    `RS_RECEIVER_CACHE_DIR=${nativeDir}/cache`,
    `RS_RECEIVER_STORE_DIR=${source}/capture/store`,
    "GRC_SOMETHING=1",
    "DISPLAY=:9",
    "",
  ].join("\n");
  const argvTxt = [
    "/bin/godot",
    "--path",
    "/x/receiver",
    "--rendering-driver",
    "opengl3",
    "--display-driver",
    "x11",
    "--max-fps",
    "60",
    "--resolution",
    "960x540",
    "",
  ].join("\n");
  const m = mapNativeLeg(
    { leg: "receiver", nativeDir, webDir },
    { out, gate: "gate0", sourceDir: source },
    envTxt,
    argvTxt,
  );
  expect(
    "map: recording URL",
    m.env.RS_RECEIVER_RECORDING === "/gate0/web/receiver/recording.rs2",
    m.env.RS_RECEIVER_RECORDING,
  );
  expect(
    "map: recording copied",
    m.copies.length === 1 &&
      m.copies[0][0] === `${nativeDir}/recording.rs2` &&
      m.copies[0][1] === `${webDir}/recording.rs2`,
  );
  expect(
    "map: out moved",
    m.env.RS_RECEIVER_OUT === "/gate0/web/receiver/applied.json",
    m.env.RS_RECEIVER_OUT,
  );
  expect(
    "map: cache dropped",
    !("RS_RECEIVER_CACHE_DIR" in m.env) &&
      m.dropped.includes("RS_RECEIVER_CACHE_DIR"),
  );
  expect(
    "map: store via source link",
    m.env.RS_RECEIVER_STORE_DIR === "/sources/gate0/capture/store",
    m.env.RS_RECEIVER_STORE_DIR,
  );
  expect("map: verbatim value", m.env.RS_RECEIVER_SHOT_SEQS === "3,5,7");
  expect(
    "map: non-RS dropped",
    !("GRC_SOMETHING" in m.env) && !("DISPLAY" in m.env),
  );
  expect(
    "map: engine args",
    JSON.stringify(m.engineArgs) === JSON.stringify(["--max-fps", "60"]),
    JSON.stringify(m.engineArgs),
  );
  expect(
    "map: canvas from --resolution",
    m.canvas[0] === 960 && m.canvas[1] === 540,
  );
  const headless = mapNativeLeg(
    { leg: "corrupt", nativeDir, webDir },
    { out, gate: "gate0", sourceDir: source },
    envTxt,
    "/bin/godot\n--headless\n--path\n/x\n",
  );
  expect(
    "map: headless dropped, default canvas",
    headless.engineArgs.length === 0 &&
      headless.canvas[0] === 640 &&
      headless.canvas[1] === 360,
  );
  let threw = false;
  try {
    mapNativeLeg(
      { leg: "receiver", nativeDir, webDir },
      { out, gate: "gate0", sourceDir: source },
      "RS_RECEIVER_SHADER_LIBRARY=/elsewhere/lib\n",
      argvTxt,
    );
  } catch {
    threw = true;
  }
  expect("map: path outside leg and source refused", threw);

  // 3. normalizeApplied / jsonDiffPaths.
  const native = {
    schema: "render-stream-receiver-applied/7",
    receiver: { kind: "native" },
    cache: { dir: "/n/cache", mode: "fresh" },
    recording: { path: "/n/recording.rs2", sha256: "aa" },
    viewport: { display_server: "x11", size: [640, 360] },
    transactions: [
      {
        seq: 1,
        process_frame: 3,
        received_us: 1,
        resources: { fetch_us: 9, created: 2 },
      },
    ],
    shots: [{ seq: 1, path: "/n/shots/seq-1.png", process_frame: 4 }],
  };
  const web = {
    schema: "render-stream-receiver-applied/7",
    receiver: { kind: "web-export" },
    cache: { dir: null, mode: "http-cache" },
    recording: { path: "/gate0/web/receiver/recording.rs2", sha256: "aa" },
    viewport: { display_server: "web", size: [640, 360] },
    transactions: [
      {
        seq: 1,
        process_frame: 30,
        received_us: 99,
        resources: { fetch_us: 0, created: 2 },
      },
    ],
    shots: [
      {
        seq: 1,
        path: "/gate0/web/receiver/shots/seq-1.png",
        process_frame: 31,
      },
    ],
  };
  expect(
    "applied: declared differences ignored",
    jsonDiffPaths(normalizeApplied(native), normalizeApplied(web)).length === 0,
    jsonDiffPaths(normalizeApplied(native), normalizeApplied(web)).join(" | "),
  );
  const changed = structuredClone(web);
  changed.transactions[0].resources.created = 3;
  const diffs = jsonDiffPaths(
    normalizeApplied(native),
    normalizeApplied(changed),
  );
  expect(
    "applied: a real difference found",
    diffs.length === 1 &&
      diffs[0].includes("transactions[0].resources.created"),
    diffs.join(" | "),
  );

  // 4. buildGate0View.
  for (const d of [
    "capture",
    "reference",
    "receiver",
    "corrupt",
    "sabotage-omit/capture",
    "sabotage-omit/receiver",
    "unsupported/capture",
    "unsupported/receiver",
    "preexisting-skip/capture",
    "preexisting-skip/receiver",
    "sabotage-freeze/capture",
    "sabotage-freeze/receiver",
    "sabotage-perturb/capture",
    "sabotage-perturb/receiver",
  ]) {
    mkdirSync(join(source, d), { recursive: true });
  }
  writeFileSync(join(source, "binary.json"), "{}");
  writeFileSync(join(source, "result.json"), "{}");
  const webRoot = join(out, "gate0", "web");
  const view = join(out, "gate0", "web-view");
  await buildGate0View(source, webRoot, view);
  expect(
    "view: receiver -> web",
    readlinkSync(join(view, "receiver")) === join(webRoot, "receiver"),
  );
  expect(
    "view: corrupt -> web",
    readlinkSync(join(view, "corrupt")) === join(webRoot, "corrupt"),
  );
  expect(
    "view: capture -> source",
    readlinkSync(join(view, "capture")) === join(source, "capture"),
  );
  expect(
    "view: nested receiver -> web",
    readlinkSync(join(view, "sabotage-omit", "receiver")) ===
      join(webRoot, "sabotage-omit", "receiver"),
  );
  expect(
    "view: nested capture -> source",
    readlinkSync(join(view, "sabotage-omit", "capture")) ===
      join(source, "sabotage-omit", "capture"),
  );
  let resultLinked = true;
  try {
    readlinkSync(join(view, "result.json"));
  } catch {
    resultLinked = false;
  }
  expect("view: the source's result.json is not carried", !resultLinked);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "self-test-gate7e: ok"
    : `self-test-gate7e: ${failures} failure(s)`,
);
if (failures > 0) process.exitCode = 1;
