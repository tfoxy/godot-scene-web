#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tool = join(
  root,
  "experiments/render-stream/scripts/lib/wfile-driver.py",
);
mkdirSync(join(root, ".local"), { recursive: true });
const scratch = mkdtempSync(join(root, ".local/wfile-judge-"));
let passed = 0;
let failed = 0;
function recording(version: number, last = "end", first: unknown = "session") {
  function record(type: unknown) {
    const meta = Buffer.from(JSON.stringify({ type, blocks: [] }));
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(8 + meta.length, 0);
    prefix.writeUInt32LE(meta.length, 4);
    return Buffer.concat([prefix, meta, Buffer.alloc(4)]);
  }
  return Buffer.concat([
    Buffer.from(`GRS${version}\r\n\x1a\n`),
    record(first),
    record(last),
  ]);
}
function sample(version: number) {
  return {
    stdout: "[fixture] extension load status=OK\n[fixture] quitting frame=52\n",
    stderr: "",
    exit: "0",
    result: {
      status: "armed",
      vptr_written: true,
      stream: { status: "closed" },
    } as unknown,
    sink: recording(version),
    patch: true,
    store: true,
    env: [`GRC_STREAM_VERSION=${version}`],
    empty: false,
    second: false,
  };
}
type Sample = ReturnType<typeof sample>;
function run(
  name: string,
  mutate?: (s: Sample) => void,
  want: string[] = [],
  version = 2,
) {
  const s = sample(version);
  mutate?.(s);
  const dir = mkdtempSync(join(scratch, "case-"));
  const leg = join(dir, "a/gate0/capture");
  mkdirSync(join(leg, "evidence"), { recursive: true });
  writeFileSync(join(leg, "stdout.txt"), s.stdout);
  writeFileSync(join(leg, "stderr.txt"), s.stderr);
  writeFileSync(join(leg, "exit-code.txt"), s.exit);
  writeFileSync(join(leg, "evidence/result.json"), JSON.stringify(s.result));
  writeFileSync(join(leg, `recording.rs${version}`), s.sink);
  if (s.patch)
    writeFileSync(
      join(leg, `recording-patch.rs${version}`),
      recording(version),
    );
  if (s.store) {
    mkdirSync(join(leg, "store"));
    writeFileSync(join(leg, "store/index.jsonl"), "");
  }
  const config = join(dir, "config.json");
  const legs = [
    {
      gate: "gate0",
      path: "capture",
      fixture: "gate0",
      quit: 52,
      sinks: [`recording.rs${version}`, `recording-patch.rs${version}`],
      store: true,
      env: s.env,
    },
  ];
  if (s.second) legs.push({ ...legs[0], path: "later" });
  writeFileSync(
    config,
    JSON.stringify({
      legs: s.empty ? [] : legs,
    }),
  );
  const result = spawnSync(
    "python3",
    [
      "-I",
      tool,
      "--config",
      config,
      "--gate",
      "gate0",
      "--evaluate-only",
      join(dir, "a"),
    ],
    { encoding: "utf8" },
  );
  const found = [...result.stdout.matchAll(/^FAIL ([^ ]+): capture:/gm)]
    .map((m) => m[1])
    .sort();
  const configError = want[0]?.startsWith("config:");
  const ok = configError
    ? result.status === 2 && result.stderr.includes(want[0].slice(7))
    : result.status === (want.length ? 1 : 0) &&
      JSON.stringify(found) === JSON.stringify([...want].sort()) &&
      (!s.second || result.stdout.includes("FAIL exit-zero: later:"));
  ok ? passed++ : failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}: ${want.join(", ") || "all checks pass"}`,
  );
  if (!ok) console.log(result.stdout, result.stderr);
}
run("honest gate /2");
run("honest gate /8", undefined, [], 8);
const mutations: [string, (s: Sample) => void, string][] = [
  [
    "exit 1",
    (s) => {
      s.exit = "1";
    },
    "exit-zero",
  ],
  [
    "no quit line",
    (s) => {
      s.stdout = s.stdout.split("\n")[0];
    },
    "fixture-quit",
  ],
  [
    "script cache error",
    (s) => {
      s.stdout += "Could not load global script cache";
    },
    "script-cache",
  ],
  [
    "load FAILED",
    (s) => {
      s.stdout = s.stdout.replace("status=OK", "status=FAILED");
    },
    "extension-load",
  ],
  [
    "refused",
    (s) => {
      s.result = {
        status: "refused",
        vptr_written: true,
        stream: { status: "closed" },
      };
    },
    "armed",
  ],
  [
    "vptr false",
    (s) => {
      s.result = {
        status: "armed",
        vptr_written: false,
        stream: { status: "closed" },
      };
    },
    "vptr-written",
  ],
  [
    "open failed",
    (s) => {
      s.result = {
        status: "armed",
        vptr_written: true,
        stream: { status: "open-failed" },
      };
    },
    "stream-closed",
  ],
  [
    "missing patch",
    (s) => {
      s.patch = false;
    },
    "sink-present:recording-patch.rs2",
  ],
  [
    "bad magic",
    (s) => {
      s.sink[0] = 0;
    },
    "framing:recording.rs2",
  ],
  [
    "truncated last",
    (s) => {
      s.sink = s.sink.subarray(0, -1);
    },
    "framing:recording.rs2",
  ],
  [
    "last not end",
    (s) => {
      s.sink = recording(2, "transaction");
    },
    "last-end:recording.rs2",
  ],
  [
    "no store index",
    (s) => {
      s.store = false;
    },
    "store-index",
  ],
  [
    "forbidden disarm env",
    (s) => {
      s.env.push("GRC_DISARM_AFTER_FRAMES=60");
    },
    "config:GRC_DISARM_AFTER_FRAMES",
  ],
  [
    "empty legs",
    (s) => {
      s.empty = true;
    },
    "config:empty legs",
  ],
];
for (const [name, mutate, check] of mutations) run(name, mutate, [check]);
run(
  "script cache error on stderr",
  (s) => {
    s.stderr = "Could not load global script cache";
  },
  ["script-cache"],
);
run(
  "first not session",
  (s) => {
    s.sink = recording(2, "end", "transaction");
  },
  ["first-session:recording.rs2"],
);
run(
  "malformed record type continues to later leg",
  (s) => {
    s.sink = recording(2, "end", []);
    s.second = true;
  },
  ["framing:recording.rs2"],
);
run(
  "malformed evidence continues to later leg",
  (s) => {
    s.result = [];
    s.second = true;
  },
  ["armed", "vptr-written", "stream-closed"],
);
run(
  "malformed stream evidence continues to later leg",
  (s) => {
    s.result = { status: "armed", vptr_written: true, stream: null };
    s.second = true;
  },
  ["stream-closed"],
);
run("last environment version wins", (s) => {
  s.env.unshift("GRC_STREAM_VERSION=8");
});
// The anti-drift check compares ordered argv and the complete env-word multiset,
// including duplicate words whose later value wins at launch.
const runner = join(scratch, "runner");
const config = join(scratch, "runner-config.json");
const capture = join(runner, "capture");
mkdirSync(join(capture, "evidence"), { recursive: true });
writeFileSync(join(capture, "evidence/result.json"), "{}");
writeFileSync(join(capture, "recording.rs2"), "recording");
const leg = {
  gate: "gate0",
  path: "capture",
  fixture: "gate0",
  quit: 52,
  sinks: ["recording.rs2"],
  store: true,
  env: ["GRC_ROOT_SIZE=enforce-min-size", "GRC_RESOURCE_STORE_DIR={leg}/store"],
};
writeFileSync(
  config,
  JSON.stringify({
    template: "template",
    extension: "ext",
    record: "record",
    legs: [leg],
    excluded: [{ path: "gate0/timing/*", reason: "timing group" }],
  }),
);
const words = [
  "GRC_EXTENSION=/runner/ext",
  "GRC_CALIBRATION=/runner/record",
  "GRC_MODE=arm",
  `GRC_EVIDENCE_DIR=${capture}/evidence`,
  `GRC_STREAM_OUT=${capture}/recording.rs2`,
  `RS_FIXTURE_STEP_LOG=${capture}/steps.jsonl`,
  "GRC_VALIDATION_LOG=on",
  `GRC_RESOURCE_STORE_DIR=${capture}/store`,
  "RS_FIXTURE_QUIT_FRAME=52",
  "GRC_ROOT_SIZE=enforce-min-size",
  `GRC_RESOURCE_STORE_DIR=${capture}/store`,
];
const argv = ["/runner/template", "--headless", "--path", "/runner/fixture"];
function drift(name: string, env: string[], args: string[], want = "") {
  writeFileSync(join(capture, "env.txt"), `${env.join("\n")}\n`);
  writeFileSync(join(capture, "argv.txt"), `${args.join("\n")}\n`);
  const result = spawnSync(
    "python3",
    [
      "-I",
      tool,
      "--config",
      config,
      "--gate",
      "gate0",
      "--check-against-runner",
      runner,
    ],
    { encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  const ok = want
    ? result.status !== 0 && output.includes(want)
    : result.status === 0;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${want ? `: ${want}` : ""}`);
  if (!ok) console.log(output);
}
drift("runner honest duplicate words", words, argv);
drift(
  "runner changed quit",
  words.map((w) =>
    w === "RS_FIXTURE_QUIT_FRAME=52" ? "RS_FIXTURE_QUIT_FRAME=53" : w,
  ),
  argv,
  "RS_FIXTURE_QUIT_FRAME",
);
drift(
  "runner missing duplicate word",
  words.slice(0, -1),
  argv,
  "GRC_RESOURCE_STORE_DIR",
);
drift(
  "runner unexpected inherited RS word",
  [...words, "RS_FIXTURE_START_FRAME=9"],
  argv,
  "RS_FIXTURE_START_FRAME",
);
drift(
  "runner scene differs",
  words,
  [...argv, "res://other.tscn"],
  "argv differs",
);
const extra = join(runner, "timing/capture");
mkdirSync(join(extra, "evidence"), { recursive: true });
writeFileSync(join(extra, "evidence/result.json"), "{}");
writeFileSync(join(extra, "recording.rs2"), "recording");
drift("runner table exclusion", words, argv);
const unlisted = join(runner, "workers-x/capture");
mkdirSync(join(unlisted, "evidence"), { recursive: true });
writeFileSync(join(unlisted, "evidence/result.json"), "{}");
writeFileSync(join(unlisted, "recording.rs2"), "recording");
drift(
  "runner unlisted capture",
  words,
  argv,
  "workers-x/capture: unlisted runner capture leg",
);
// A tiny executable exercises process launch without Godot or native builds.
const launchRoot = join(scratch, "launch");
mkdirSync(join(launchRoot, "fixtures/gate0"), { recursive: true });
mkdirSync(join(launchRoot, "imports/gate0"), { recursive: true });
writeFileSync(join(launchRoot, "imports/gate0/imported"), "cache");
const template = join(launchRoot, "template");
writeFileSync(
  template,
  `#!/usr/bin/env python3
import json, os, pathlib, struct, sys
env = {k: v for k, v in os.environ.items() if k.startswith(('GRC_', 'RS_'))}
directory = pathlib.Path(env['GRC_EVIDENCE_DIR']).parent
project = pathlib.Path(sys.argv[3])
(directory / 'probe.json').write_text(json.dumps({'env': env, 'imported': (project / '.godot/imported').is_file(), 'display': os.environ.get('DISPLAY')}))
if env.get('RS_FIXTURE_VARIANT') == 'fail':
    sys.exit(1)
meta = lambda kind: json.dumps({'type': kind}).encode()
record = lambda data: struct.pack('<II', 8 + len(data), len(data)) + data + struct.pack('<I', 0)
pathlib.Path(env['GRC_STREAM_OUT']).write_bytes(b'GRS6\\r\\n\\x1a\\n' + record(meta('session')) + record(meta('end')))
pathlib.Path(env['GRC_EVIDENCE_DIR'], 'result.json').write_text(json.dumps({'status': 'armed', 'vptr_written': True, 'stream': {'status': 'closed'}}))
print('[fixture] extension load status=OK')
print('[fixture] quitting frame=52')
`,
);
chmodSync(template, 0o755);
const launchConfig = join(launchRoot, "config.json");
const launchLeg = {
  ...leg,
  store: false,
  env: ["GRC_TEXTURE_DECODE=engine", "GRC_TEXTURE_DECODE=off"],
};
writeFileSync(
  launchConfig,
  JSON.stringify({
    template: "template",
    template_sha256: createHash("sha256")
      .update(readFileSync(template))
      .digest("hex"),
    extension: "ext",
    record: "record",
    legs: [launchLeg],
  }),
);
function launchTest(
  name: string,
  out: string,
  expected: number,
  more: string[] = [],
  detail = "",
) {
  const result = spawnSync(
    "python3",
    [
      "-I",
      tool,
      "--config",
      launchConfig,
      "--gate",
      "gate0",
      "--out",
      out,
      ...more,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GRC_INHERITED: "bad",
        RS_FIXTURE_START_FRAME: "bad",
        DISPLAY: ":bad",
      },
    },
  );
  const output = result.stdout + result.stderr;
  const ok = result.status === expected && output.includes(detail);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) console.log(output);
}
const honestOut = join(launchRoot, "honest");
launchTest("launch honest", honestOut, 0);
const probe = JSON.parse(
  readFileSync(join(honestOut, "a/gate0/capture/probe.json"), "utf8"),
);
const isolated =
  probe.imported &&
  !probe.display &&
  !probe.env.GRC_INHERITED &&
  !probe.env.RS_FIXTURE_START_FRAME &&
  probe.env.GRC_TEXTURE_DECODE === "off" &&
  !existsSync(join(honestOut, "a/gate0/_project"));
if (isolated) passed++;
else failed++;
console.log(
  `${isolated ? "PASS" : "FAIL"} launch restores imports, strips inherited env, last word wins, removes project`,
);
const configData = JSON.parse(readFileSync(launchConfig, "utf8"));
configData.legs = [
  { ...launchLeg, path: "failed", env: ["RS_FIXTURE_VARIANT=fail"] },
  { ...launchLeg, path: "later" },
];
writeFileSync(launchConfig, JSON.stringify(configData));
launchTest(
  "launch failure still runs later leg",
  join(launchRoot, "continued"),
  1,
  [],
  "later | 0 | 52",
);
rmSync(join(launchRoot, "imports/gate0"), { recursive: true });
launchTest(
  "launch refuses missing import before process",
  join(launchRoot, "missing"),
  2,
  [],
  "missing or empty import",
);
rmSync(scratch, { recursive: true, force: true });
console.log(`self-test-wfile-driver: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
