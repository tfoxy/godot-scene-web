#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
const tool = join(root, "experiments/render-stream/scripts/lib/w-equiv.py");
mkdirSync(join(root, ".local"), { recursive: true });
const scratch = mkdtempSync(join(root, ".local/w-equiv-test-"));
const gates = ["gate0", "gate1", "gate2", "gate8"];
const legs = gates.map((gate) => ({
  gate,
  path: "capture",
  sinks: ["recording.rs2", "recording-patch.rs2"],
  store: true,
}));
const stub = join(scratch, "cmp.py");
// This stand-in emits the real comparator's JSON + trailer contract. It also
// checks tree/non-tree use, the sole cross-OS allowance, and argv paths.
writeFileSync(
  stub,
  `import json, pathlib, sys
mode = pathlib.Path(sys.argv[1]).read_text()
args = sys.argv[2:]
a, b = map(pathlib.Path, args[-2:])
cross = '--allow-session' in args
tree = '--tree' in args
assert '--json' in args
assert args == (['--tree'] if tree else []) + ['--json'] + (['--allow-session', 'engine.sha256'] if cross else []) + [str(a), str(b)]
paths = sorted(a.rglob('recording*.rs*')) if tree else [a]
rows = []
for p in paths:
    q = b / p.relative_to(a) if tree else b
    sabotage = not tree
    differing = []
    if sabotage or (mode == 'finding' and cross) or (mode == 'noise' and not cross):
        differing = [{'index': 1, 'type': 'transaction', 'paths': ['items.0.rect.x']}]
    if sabotage and mode in ('sabotage-identical', 'sabotage-error', 'sabotage-session'):
        differing = [] if mode == 'sabotage-identical' else [{'index': -1 if mode == 'sabotage-error' else 0, 'type': 'error' if mode == 'sabotage-error' else 'session', 'paths': ['decode error']}]
    allowed = [{'index': 0, 'type': 'session', 'paths': ['session_id', 'stream.stream_id'] + (['engine.sha256'] if cross else [])}]
    if cross and mode == 'bad-allowance': allowed[0]['paths'].append('engine.version_string')
    if cross and mode == 'prefix-allowance': allowed[0]['paths'].append('engine.sha256.child')
    if cross and mode == 'no-session': allowed[0]['paths'] = ['engine.sha256']
    rows.append(dict(a=str(p), b=str(q), identical=not differing, whole_file_identical=cross and mode == 'same-file', records=[3,3], differing=differing, allowed=allowed))
if mode == 'duplicate-row' and tree and rows: rows[-1] = rows[0]
if mode == 'wrong-path' and tree and rows: rows[0]['b'] += '.wrong'
print(json.dumps(rows))
n = sum(r['identical'] for r in rows)
print(f'cmp-rec: {n}/{len(rows) + (1 if mode == "bad-count" and tree else 0)} identical')
sys.exit(0 if n == len(rows) else 1)
`,
);
let passed = 0;
let failed = 0;
function put(path: string, data: unknown = {}) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}
type Context = {
  dir: string;
  linux: string;
  windows: string;
  sabotage: string;
  table: string;
  mode: string;
  art: boolean;
};
function run(
  name: string,
  expected = "",
  mutate?: (c: Context) => void,
  rc = expected ? 1 : 0,
  verify?: (out: string, stdout: string) => boolean,
) {
  const dir = mkdtempSync(join(scratch, "case-"));
  const c: Context = {
    dir,
    linux: join(dir, "linux"),
    windows: join(dir, "windows"),
    sabotage: join(dir, "sab"),
    table: join(dir, "lib/wfile-legs.json"),
    mode: "honest",
    art: false,
  };
  put(c.table, { legs });
  for (const [side, base] of [
    ["linux", c.linux],
    ["windows", c.windows],
  ]) {
    for (const rep of ["a", "b"]) {
      for (const gate of gates) {
        const leg = join(base, rep, gate, "capture");
        put(join(leg, "recording.rs2"), `${side} ${rep}`);
        put(join(leg, "recording-patch.rs2"), `${side} ${rep}`);
        put(join(leg, "store/index.jsonl"), "");
        put(join(leg, "store/payload"), "payload");
        put(
          join(leg, "steps.jsonl"),
          '{"step":1,"applied_frame":2,"settle_frame":3}\n',
        );
        put(join(leg, "evidence/calibration-check.json"), {
          checks: [{ name: side === "linux" ? "exe_sha256" : "image_sha256" }],
        });
      }
    }
  }
  for (const sink of legs[3].sinks)
    put(join(c.sabotage, "a/gate8/capture", sink), "off");
  mutate?.(c);
  const caseTool = join(dir, "lib/w-equiv.py");
  cpSync(tool, caseTool);
  const mode = join(dir, "mode");
  put(mode, c.mode);
  const summary = join(dir, "step-summary.md");
  const result = spawnSync(
    "python3",
    [
      "-I",
      caseTool,
      "--linux",
      c.linux,
      c.art ? "--windows-art" : "--windows",
      c.windows,
      ...(c.art ? [] : ["--sabotage", c.sabotage]),
      "--out",
      join(dir, "out"),
      "--cmp-command",
      JSON.stringify(["python3", "-I", stub, mode]),
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
  );
  let ok = false;
  try {
    const report = JSON.parse(
      readFileSync(join(dir, "out/w-equiv.json"), "utf8"),
    );
    const partial = JSON.parse(
      readFileSync(join(dir, "out/validate-summary.json"), "utf8"),
    );
    const all = JSON.stringify(report);
    ok =
      result.status === rc &&
      report.rc === rc &&
      partial.runs[0].rc === String(rc) &&
      partial.failed === Number(rc !== 0) &&
      partial.partial === true &&
      partial.runs[0].id === "windows" &&
      (rc === 0
        ? partial.runs[0].failing.length === 0
        : partial.runs[0].failing.length > 0) &&
      report.schema === "render-stream-w-equiv/1" &&
      (rc !== 0 || !existsSync(join(dir, "out/evidence"))) &&
      (!verify || verify(join(dir, "out"), result.stdout)) &&
      (!expected || all.includes(expected)) &&
      readFileSync(summary, "utf8").includes("| Gate |") &&
      (rc !== 0 ||
        Object.values(
          report.gates as Record<
            string,
            { expected: number; pairs: Record<string, { identical: number }> }
          >,
        ).every(
          (g) =>
            g.expected === 2 &&
            Object.values(g.pairs).every((p) => p.identical === 2),
        ));
  } catch {}
  if (ok) passed++;
  else failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${expected ? `: ${expected}` : ""}`,
  );
  if (!ok) console.log(result.stdout, result.stderr);
}
run("honest");
run(
  "cross finding survives artifact cleanup with record paths and pair logs",
  "finding",
  (c) => {
    c.mode = "finding";
  },
  1,
  (out, stdout) => {
    const evidence = join(out, "evidence/windows-equiv");
    const report = JSON.parse(
      readFileSync(join(evidence, "w-equiv.json"), "utf8"),
    );
    const difference =
      report.gates.gate8.recordings["capture/recording.rs2"].pairs["cross-a"]
        .differing[0];
    return (
      difference.index === 1 &&
      difference.type === "transaction" &&
      difference.paths.includes("items.0.rect.x") &&
      stdout.includes("index=1 type=transaction paths=items.0.rect.x") &&
      ["cross-a", "cross-b"].every((pair) =>
        ["argv.json", "stdout.txt", "stderr.txt"].every(
          (suffix) =>
            readFileSync(
              join(evidence, "logs", `gate8-${pair}.${suffix}`),
              "utf8",
            ) ===
            readFileSync(join(out, "logs", `gate8-${pair}.${suffix}`), "utf8"),
        ),
      )
    );
  },
);
run(
  "failed sabotage retains comparison logs",
  "sabotage-not-detected",
  (c) => {
    c.mode = "sabotage-identical";
  },
  1,
  (out) =>
    ["recording.rs2", "recording-patch.rs2"].every((sink) =>
      ["argv.json", "stdout.txt", "stderr.txt"].every(
        (suffix) =>
          readFileSync(
            join(
              out,
              "evidence/windows-equiv/logs",
              `sabotage-${sink}.${suffix}`,
            ),
            "utf8",
          ) ===
          readFileSync(join(out, "logs", `sabotage-${sink}.${suffix}`), "utf8"),
      ),
    ),
);
for (const [mode, expected] of [
  ["finding", "finding"],
  ["noise", "noise"],
  ["same-file", "same-file"],
  ["bad-allowance", "session-allowance"],
  ["prefix-allowance", "session-allowance"],
  ["no-session", "session-allowance"],
  ["bad-count", "comparator-count"],
  ["duplicate-row", "comparator-paths"],
  ["wrong-path", "comparator-paths"],
  ["sabotage-identical", "sabotage-not-detected"],
  ["sabotage-error", "sabotage-not-detected"],
  ["sabotage-session", "sabotage-not-detected"],
])
  run(mode, expected, (c) => {
    c.mode = mode;
  });
run("recording missing on Windows", "missing", (c) => {
  rmSync(join(c.windows, "b/gate1/capture/recording.rs2"));
});
run("extra Windows recording", "missing", (c) => {
  put(join(c.windows, "a/gate2/extra/recording.rs8"), "extra");
});
run(
  "empty expected set",
  "empty expected set",
  (c) => {
    put(c.table, { legs: [] });
  },
  2,
);
run(
  "one empty gate",
  "empty expected set: gate8",
  (c) => {
    put(c.table, { legs: legs.slice(0, -1) });
  },
  2,
);
run("store byte flip", "finding", (c) => {
  for (const rep of ["a", "b"])
    put(join(c.windows, rep, "gate2/capture/store/payload"), "flip");
});
run("store repeat noise", "noise", (c) => {
  put(join(c.linux, "b/gate0/capture/store/payload"), "flip");
});
run("store missing", "missing", (c) => {
  rmSync(join(c.windows, "a/gate8/capture/store/index.jsonl"));
});
run("unexpected store outside table", "missing", (c) => {
  put(join(c.windows, "a/gate8/extra/store/payload"), "extra");
});
run("steps line change", "finding", (c) => {
  for (const rep of ["a", "b"])
    put(
      join(c.windows, rep, "gate1/capture/steps.jsonl"),
      '{"step":1,"applied_frame":3,"settle_frame":3}',
    );
});
run("steps parsed equality", "", (c) => {
  put(
    join(c.windows, "b/gate1/capture/steps.jsonl"),
    '{ "settle_frame":3, "step":1,"applied_frame":2 }\n',
  );
});
run("steps missing", "missing", (c) => {
  rmSync(join(c.windows, "b/gate0/capture/steps.jsonl"));
});
run("steps invalid", "steps-json", (c) => {
  put(join(c.windows, "b/gate0/capture/steps.jsonl"), "bad-json");
});
run("steps non-integer", "steps-json", (c) => {
  put(
    join(c.windows, "b/gate0/capture/steps.jsonl"),
    '{"step":true,"applied_frame":2,"settle_frame":3}',
  );
});
run("Windows PE provenance", "provenance", (c) => {
  put(join(c.windows, "b/gate8/capture/evidence/calibration-check.json"), {
    checks: [{ name: "exe_sha256" }],
  });
});
run("Linux provenance", "provenance", (c) => {
  put(join(c.linux, "a/gate0/capture/evidence/calibration-check.json"), {
    checks: [],
  });
});
run(
  "missing Windows artifact",
  "windows-art",
  (c) => {
    c.art = true;
    c.windows = join(c.dir, "absent");
  },
  2,
);
function artifact(c: Context) {
  const art = join(c.dir, "artifact");
  for (const rep of ["a", "b"])
    for (const gate of gates) {
      const dest = join(art, "artifacts", `wfile-${gate}-${rep}`, rep, gate);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(join(c.windows, rep, gate), dest, { recursive: true });
    }
  cpSync(c.sabotage, join(art, "artifacts/wfile-sabotage"), {
    recursive: true,
  });
  c.windows = art;
  c.art = true;
}
run("Windows artifact assembly", "", artifact);
run(
  "Windows artifact duplicate",
  "duplicate",
  (c) => {
    artifact(c);
    const dest = join(c.windows, "artifacts/wfile-gate0-b/a/gate0");
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(join(c.linux, "a/gate0"), dest, { recursive: true });
  },
  2,
);
run("missing sabotage", "sabotage-not-detected", (c) => {
  rmSync(c.sabotage, { recursive: true });
});
run("info is never judged", "", (c) => {
  put(join(c.windows, "b/gate2/capture/evidence/counters.json"), {
    counts: { draws: 999 },
  });
  put(join(c.windows, "a/gate1/capture/root.jsonl"), "different");
});
rmSync(scratch, { recursive: true, force: true });
console.log(`self-test-w-equiv: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
