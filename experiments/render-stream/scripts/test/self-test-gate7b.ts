#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for G7b's pure pieces (never a browser or a Godot run):
//
//  1. classifyShot (lib/gate7b-adapters.ts): identical pixels; a pair one 10-bit value reads back
//     as natively (floor(v/4)) and on the web (round(v*255/1023)) is `readback`; a one-level
//     colour difference no single v explains is `delta1`; a two-level difference or any alpha
//     difference is `other`.
//  2. discoverFileReceiverLegs: a file receiver leg is replayed; a live leg (RS_RECEIVER_URL), a
//     fixture leg and a capture are not legs at all; a traced, an editor-launched, a warm-cache
//     and a live-derived (its recording is a live receiver's received tap) leg are typed; a planned
//     launch that never ran (no exit-code.txt, no applied.json: W11e's g8w11 GSW plans) is no leg.
//  3. buildMirrorView: replaced legs link to their targets (nested ones too), every other entry
//     to the source, result.json is dropped and legs.json names only the view's groups.
//  4. dropMemoryCacheOccupancy (W11e): a /11 applied.json loses only its memory-cache occupancy.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMirrorView,
  classifyShot,
  discoverFileReceiverLegs,
  dropMemoryCacheOccupancy,
} from "../lib/gate7b-adapters";

let failures = 0;
function expect(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`,
  );
}

// 1. classifyShot.
{
  const px = (...v: number[][]) => new Uint8Array(v.flat());
  // v = 143: native 35, web 36 (G7b's dominant gate 6 pair); v = 972: native 243, web 242.
  const native = px(
    [10, 20, 30, 255],
    [35, 35, 35, 255],
    [243, 0, 0, 255],
    [170, 0, 0, 255],
    [100, 0, 0, 255],
    [50, 50, 50, 170],
  );
  const web = px(
    [10, 20, 30, 255],
    [36, 36, 36, 255],
    [242, 0, 0, 255],
    [169, 0, 0, 255],
    [102, 0, 0, 255],
    [50, 50, 50, 255],
  );
  const c = classifyShot(native, web);
  expect("classify identical", c.identical === 1, JSON.stringify(c));
  expect("classify readback", c.readback === 2, JSON.stringify(c));
  // 170 -> 169: native v in [680, 683], web 169 needs v <= 679: one level, not readback.
  expect("classify delta1", c.delta1 === 1, JSON.stringify(c));
  expect(
    "classify other (two levels; alpha)",
    c.other === 2 && c.other_max_delta === 85,
    JSON.stringify(c),
  );
}

// 4 (W11e): applied-equals-native ignores a /11 document's memory-cache occupancy only.
{
  const doc = {
    w11: {
      store_max_entries: 9,
      store_max_excess: 0,
      cache_released: 3,
      cache_released_bytes: 70,
      released_total: 4,
    },
    transactions: [{ seq: 1, w11: { store_entries: 9, names: 7, carried: 2 } }],
  };
  dropMemoryCacheOccupancy(doc);
  expect(
    "occupancy: only the cache's own counts dropped",
    JSON.stringify(doc) ===
      JSON.stringify({
        w11: { released_total: 4 },
        transactions: [{ seq: 1, w11: { names: 7, carried: 2 } }],
      }),
    JSON.stringify(doc),
  );
  const v10 = { transactions: [{ seq: 1 }] };
  dropMemoryCacheOccupancy(v10);
  expect(
    "occupancy: a /10 document is unchanged",
    JSON.stringify(v10) === '{"transactions":[{"seq":1}]}',
  );
}

// 2 and 3: a synthetic source run.
const root = mkdtempSync(join(tmpdir(), "g7b-selftest-"));
try {
  const src = join(root, "source");
  const tmpl = "/x/linux_release.x86_64";
  const receiver = "/repo/experiments/render-stream/receiver";
  const leg = (
    rel: string,
    env: string[],
    argv: string[],
    files: Record<string, string> = {},
    ran = true,
  ) => {
    const d = join(src, rel);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "env.txt"), `# header\n${env.join("\n")}\n`);
    writeFileSync(join(d, "argv.txt"), `${argv.join("\n")}\n`);
    // A leg that ran writes its exit code (run_rendered, run_headless); W11e: a planned launch
    // that never ran (`ran: false`) does not.
    if (ran) writeFileSync(join(d, "exit-code.txt"), "0\n");
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(d, f, ".."), { recursive: true });
      writeFileSync(join(d, f), body);
    }
  };
  const rec = (rel: string) =>
    `RS_RECEIVER_RECORDING=${join(src, rel, "recording.rs2")}`;
  const rendered = [tmpl, "--path", receiver, "--rendering-driver", "opengl3"];
  leg("receiver", [rec("receiver")], rendered, { "recording.rs2": "A" });
  leg(
    "hd/receiver-half",
    [rec("hd/receiver-half")],
    [...rendered, "--resolution", "960x540"],
    {
      "recording.rs2": "B",
    },
  );
  leg("trace", [rec("trace")], [tmpl, "--headless", "--path", receiver], {
    "recording.rs2": "C",
    "strace.txt": "",
  });
  leg(
    "typecheck/minimal",
    [rec("typecheck/minimal")],
    ["/x/godot", "--headless", "--path", receiver],
    {
      "recording.rs2": "D",
    },
  );
  leg("warm", [rec("warm"), "RS_RECEIVER_CACHE_MODE=warm"], rendered, {
    "recording.rs2": "E",
  });
  leg(
    "live/receiver",
    ["RS_RECEIVER_URL=ws://x", "RS_RECEIVER_RECORDING=unused"],
    rendered,
    {
      "received.rs2": "TAP",
    },
  );
  leg("live-replay", [rec("live-replay")], rendered, {
    "recording.rs2": "TAP",
  });
  leg(
    "sab/receiver",
    [rec("sab/receiver"), "RS_RECEIVER_SABOTAGE=ignore-clip"],
    rendered,
    {
      "recording.rs2": "F",
    },
  );
  leg(
    "capture",
    ["GRC_MODE=arm"],
    [tmpl, "--headless", "--path", "/repo/fixtures/gate1"],
  );
  leg("reference", [], [tmpl, "--path", "/repo/fixtures/gate1"]);
  // W11e: g8w11's GSW legs plan a native-shaped launch they never run (GSW replays it).
  leg("gsw/scale/plan", [rec("gsw/scale/plan")], rendered, {}, false);
  writeFileSync(join(src, "result.json"), "{}");
  writeFileSync(
    join(src, "legs.json"),
    JSON.stringify({
      groups_run: ["g1a", "g1b", "g1c"],
      groups_landed: ["g1a", "g1b", "g1c"],
    }),
  );

  const found = new Map(discoverFileReceiverLegs(src).map((d) => [d.leg, d]));
  expect(
    "discover: exactly the file receiver legs",
    [...found.keys()].sort().join(",") ===
      "hd/receiver-half,live-replay,receiver,sab/receiver,trace,typecheck/minimal,warm",
    [...found.keys()].join(","),
  );
  expect(
    "discover: receiver replayed",
    found.get("receiver")?.excluded === null,
  );
  expect(
    "discover: resolution and sabotage read",
    found.get("hd/receiver-half")?.resolution === "960x540" &&
      found.get("sab/receiver")?.sabotage === "ignore-clip",
  );
  expect(
    "discover: trace typed",
    found.get("trace")?.excluded === "native-only-trace",
  );
  expect(
    "discover: editor leg typed",
    found.get("typecheck/minimal")?.excluded === "native-only-editor",
  );
  expect(
    "discover: warm typed",
    found.get("warm")?.excluded === "native-only-warm-cache",
  );
  expect(
    "discover: live-derived typed",
    found.get("live-replay")?.excluded === "live-derived",
  );

  const view = join(root, "view");
  const webReceiver = join(root, "web", "receiver");
  const webHalf = join(root, "web", "hd", "receiver-half");
  mkdirSync(webReceiver, { recursive: true });
  mkdirSync(webHalf, { recursive: true });
  await buildMirrorView(
    src,
    new Map([
      ["receiver", webReceiver],
      ["hd/receiver-half", webHalf],
    ]),
    view,
    ["g1a", "g1b"],
  );
  expect(
    "view: replaced leg",
    readlinkSync(join(view, "receiver")) === webReceiver,
  );
  expect(
    "view: nested replaced leg",
    readlinkSync(join(view, "hd", "receiver-half")) === webHalf,
  );
  expect(
    "view: other entries link to the source",
    readlinkSync(join(view, "trace")) === join(src, "trace"),
  );
  let hasResult = true;
  try {
    readlinkSync(join(view, "result.json"));
  } catch {
    hasResult = false;
  }
  expect("view: result.json dropped", !hasResult);
  const legs = JSON.parse(readFileSync(join(view, "legs.json"), "utf8")) as {
    groups_run: string[];
  };
  expect(
    "view: legs.json filtered",
    legs.groups_run.join(",") === "g1a,g1b",
    legs.groups_run.join(","),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "self-test-gate7b: PASS"
    : `self-test-gate7b: ${failures} FAILED`,
);
if (failures > 0) process.exitCode = 1;
