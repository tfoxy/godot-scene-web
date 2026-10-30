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
import type { Gate7Check } from "../lib/gate7-adapters";
import {
  type RepeatDiff,
  repeatDiff,
  typeLavapipeParticleFlake,
} from "../lib/gate7-web-flakes";
import { join } from "node:path";
import {
  approximateRegions,
  buildMirrorView,
  classifyShot,
  discoverFileReceiverLegs,
  dropMemoryCacheOccupancy,
  maskApproximate,
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

// 3b (PM6a): g8pt's legs mask their emitter regions before P-W1's classes; other legs do not.
{
  const regions = approximateRegions("g8pt/receiver");
  expect(
    "approximate regions: g8pt has nine",
    regions?.length === 9,
    JSON.stringify(regions),
  );
  expect(
    "approximate regions: other groups none",
    approximateRegions("g8mm/receiver") === null,
  );
  const native = new Uint8Array(4 * 4 * 4);
  const web = new Uint8Array(native.length);
  web.set([200, 0, 0, 255], (1 * 4 + 1) * 4);
  web.set([200, 0, 0, 255], (3 * 4 + 3) * 4);
  const n = maskApproximate(native, web, 4, [[0, 0, 1, 1]]);
  const c = classifyShot(native, web);
  expect(
    "maskApproximate: one inside masked",
    n === 1 && c.other === 1,
    JSON.stringify({ n, c }),
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

// SWO: the CI lavapipe particle flake (lib/gate7-web-flakes.ts) is typed only on its evidence.
{
  const lavapipe = {
    renderer: "lavapipe",
    github_actions: "true",
    runner_environment: "github-hosted",
  } as const;
  const cellNames = ["C_FLIP", "D_GLOBAL", "G_HIDDEN"];
  const row = (id: string, detail: string): Gate7Check => ({
    id,
    criterion: "",
    passed: false,
    gating: true,
    detail,
  });
  const black: RepeatDiff = {
    leg: "g8mm/receiver",
    shot: "seq-46.png",
    inside: 888,
    outside: 0,
    black: 888,
  };
  const ev = { diffs: [black, { ...black, shot: "seq-47.png" }] };
  const rows = [
    row(
      "mm-reference@web",
      "2 problem(s): receiver step 2-prev: 851 px differ (C_FLIP 851); receiver step 2: 862 px differ (C_FLIP 853, D_GLOBAL 9)",
    ),
    row(
      "web-repeat-identical@web",
      "g8mm/receiver/shots/seq-46.png differs between the two web runs; g8mm/receiver/shots/seq-47.png differs between the two web runs",
    ),
    row("pw1-classes@web", "g8mm/receiver/seq-46.png: 851 px unexplained"),
  ];
  const status = (cs: { id: string; status?: string }[], id: string) =>
    cs.find((c) => c.id === id)?.status;
  const t = typeLavapipeParticleFlake(rows, ev, lavapipe, cellNames);
  expect(
    "particle flake: lavapipe + black repeat evidence types mm-reference and web-repeat-identical",
    status(t, "mm-reference@web") === "known-flake" &&
      status(t, "web-repeat-identical@web") === "known-flake" &&
      t.every((c) => c.passed === false),
    JSON.stringify(t.map((c) => [c.id, c.status])),
  );
  expect(
    "particle flake: another row is never typed",
    status(t, "pw1-classes@web") === undefined,
  );
  expect(
    "particle flake: nothing is typed without the lavapipe allowance (a local NVIDIA run)",
    typeLavapipeParticleFlake(rows, ev, null, cellNames).every(
      (c) => (c as { status?: string }).status === undefined,
    ),
  );
  expect(
    "particle flake: a deterministic failure (the two web runs agree) is never typed",
    typeLavapipeParticleFlake(rows, { diffs: [] }, lavapipe, cellNames).every(
      (c) => (c as { status?: string }).status === undefined,
    ),
  );
  const outside = typeLavapipeParticleFlake(
    rows,
    {
      diffs: [
        ...ev.diffs,
        { ...black, leg: "g8mm/receiver-patch", outside: 3 },
      ],
    },
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: one repeat difference outside the particle cells types nothing",
    outside.every((c) => (c as { status?: string }).status === undefined),
  );
  const noBlack = typeLavapipeParticleFlake(
    rows,
    { diffs: ev.diffs.map((d) => ({ ...d, black: 0 })) },
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: a repeat difference without black particle pixels types nothing",
    noBlack.every((c) => (c as { status?: string }).status === undefined),
  );
  const mixed = typeLavapipeParticleFlake(
    rows,
    { diffs: [ev.diffs[0], { ...ev.diffs[1], black: 0, inside: 102 }] },
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: a stale-frame shot beside a black one in the same run still types",
    status(mixed, "mm-reference@web") === "known-flake",
  );
  const otherCell = typeLavapipeParticleFlake(
    [
      row(
        "mm-reference@web",
        "1 problem(s): receiver step 1: 40 px differ (C_FLIP 30, E_VISIBLE 10)",
      ),
    ],
    ev,
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: an mm-reference problem in another cell stays FAIL",
    (otherCell[0] as { status?: string }).status === undefined,
  );
  // W13d: g8pt's headless-pump legs replay gate8-mm, so the same flake types their rows.
  const pumpEv = {
    diffs: [
      { ...black, leg: "g8pt/headless-pump/receiver", shot: "seq-26.png" },
      { ...black, leg: "g8pt/headless-pump/receiver", shot: "seq-27.png", black: 0, inside: 102 },
    ],
  };
  const pumpRows = [
    row(
      "native-pt13-equals-v12@web",
      "2 problem(s): headless-pump13/receiver: frame 26: 1083 px differ from headless-pump/receiver (C_FLIP 1000, D_GLOBAL 83); headless-pump13/receiver: frame 27: 102 px differ from headless-pump/receiver (C_FLIP 102)",
    ),
    row(
      "web-repeat-identical@web",
      "g8pt/headless-pump/receiver/shots/seq-26.png differs between the two web runs; g8pt/headless-pump/receiver/shots/seq-27.png differs between the two web runs",
    ),
    row(
      "mm13-reference@web",
      "1 problem(s): frame 26 (step-1-prev.png): 400 px differ (C_FLIP 400)",
    ),
  ];
  const pump = typeLavapipeParticleFlake(pumpRows, pumpEv, lavapipe, cellNames);
  expect(
    "particle flake (W13d): g8pt headless-pump repeat evidence types native-pt13-equals-v12 and web-repeat-identical",
    status(pump, "native-pt13-equals-v12@web") === "known-flake" &&
      status(pump, "web-repeat-identical@web") === "known-flake",
    JSON.stringify(pump.map((c) => [c.id, c.status])),
  );
  expect(
    "particle flake (W13d): mm13-reference is typed only when pump13's own web runs disagree",
    status(pump, "mm13-reference@web") === undefined &&
      status(
        typeLavapipeParticleFlake(
          pumpRows,
          { diffs: [...pumpEv.diffs, { ...black, leg: "g8pt/headless-pump13/receiver" }] },
          lavapipe,
          cellNames,
        ),
        "mm13-reference@web",
      ) === "known-flake",
  );
  const pumpOutside = typeLavapipeParticleFlake(
    [
      row(
        "native-pt13-equals-v12@web",
        "1 problem(s): headless-pump13/receiver: frame 26: 50 px differ from headless-pump/receiver (C_FLIP 40, outside 10)",
      ),
    ],
    pumpEv,
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake (W13d): a pump twin difference outside the particle cells stays FAIL",
    (pumpOutside[0] as { status?: string }).status === undefined,
  );
  const shimRow = typeLavapipeParticleFlake(
    [
      row(
        "native-pt13-equals-v12@web",
        "1 problem(s): headless-shim13/receiver: frame 26: 50 px differ from headless-shim/receiver",
      ),
    ],
    pumpEv,
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake (W13d): a shim twin difference is never typed",
    (shimRow[0] as { status?: string }).status === undefined,
  );
  const otherLeg = typeLavapipeParticleFlake(
    [
      row(
        "mm-reference@web",
        "1 problem(s): receiver-patch step 1: 40 px differ (C_FLIP 40)",
      ),
    ],
    ev,
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: an mm-reference problem on a leg whose web runs agreed stays FAIL",
    (otherLeg[0] as { status?: string }).status === undefined,
  );
  const missing = typeLavapipeParticleFlake(
    [
      row(
        "mm-reference@web",
        "2 problem(s): receiver step 2: 40 px differ (C_FLIP 40); receiver step 1: shot missing",
      ),
    ],
    ev,
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: a missing shot beside it keeps the row FAIL",
    (missing[0] as { status?: string }).status === undefined,
  );
  const catches = typeLavapipeParticleFlake(
    [
      row(
        "mm-reference-catches-stale-buffer@web",
        "1 problem(s): step 1-prev (before the sabotage): 942 px differ (C_FLIP 942)",
      ),
    ],
    { diffs: [{ ...black, leg: "g8mm/sabotage-stale-buffer/receiver-patch" }] },
    lavapipe,
    cellNames,
  );
  const uncaught = typeLavapipeParticleFlake(
    [
      row(
        "mm-reference-catches-stale-buffer@web",
        "1 problem(s): all 2 shots after the sabotage equal the reference (unseen)",
      ),
    ],
    { diffs: [{ ...black, leg: "g8mm/sabotage-stale-buffer/receiver-patch" }] },
    lavapipe,
    cellNames,
  );
  expect(
    "particle flake: a catches row before the sabotage is typed, an uncaught sabotage never",
    (catches[0] as { status?: string }).status === "known-flake" &&
      (uncaught[0] as { status?: string }).status === undefined,
  );
  // repeatDiff: one black pixel inside C_FLIP's region, one difference outside.
  const img = () => ({
    width: 4,
    height: 2,
    data: new Uint8Array(4 * 2 * 4).fill(60),
  });
  const a = img();
  const b = img();
  b.data.set([0, 0, 0, 255], 0);
  const d = repeatDiff("g8mm/receiver", "seq-4.png", a, b, [[0, 0, 1, 1]]);
  b.data.set([1, 2, 3, 255], (1 * 4 + 3) * 4);
  const d2 = repeatDiff("g8mm/receiver", "seq-4.png", a, b, [[0, 0, 1, 1]]);
  expect(
    "repeatDiff: counts inside, outside and black particle pixels",
    d?.inside === 1 && d.outside === 0 && d.black === 1 && d2?.outside === 1,
    JSON.stringify([d, d2]),
  );
  expect(
    "repeatDiff: identical frames are no difference",
    repeatDiff("g8mm/receiver", "seq-4.png", a, img(), [[0, 0, 1, 1]]) === null,
  );
}

console.log(
  failures === 0
    ? "self-test-gate7b: PASS"
    : `self-test-gate7b: ${failures} FAILED`,
);
if (failures > 0) process.exitCode = 1;
