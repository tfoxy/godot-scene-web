#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../lib/w-run.py", import.meta.url));
const scratchRoot = fileURLToPath(
  new URL("../../../../.local/", import.meta.url),
);
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "w-run-"));
const bundle = join(scratch, "bundle");
mkdirSync(join(bundle, "bin"), { recursive: true });
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
}
function exe(name: string, body: string) {
  writeFileSync(join(bundle, "bin", name), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
  return `bin/${name}`;
}
const pass = {
  name: "pass",
  exe: exe("pass", "echo pass; exit 0"),
  args: [],
  env: {},
};
const fail = {
  name: "fail",
  exe: exe("fail", "echo failure-detail; exit 7"),
  args: [],
  env: {},
};
const slow = {
  name: "slow",
  exe: exe("slow", "echo timeout-detail; exec sleep 10"),
  args: [],
  env: {},
};
const context = {
  name: "context",
  exe: exe(
    "context",
    'test "$W_RUN_ENV" = "évidence" && test "$1" = "hello world" && test -f manifest.json && test -n "$PATH"',
  ),
  args: ["hello world"],
  env: { W_RUN_ENV: "évidence" },
};
const importsTool = join(scratch, "imports.py");
// The real PE parser has its own self-test. Record all runner invocations independently here.
writeFileSync(
  importsTool,
  `import json, os, sys
with open(os.path.join(os.getcwd(), "imports-calls.jsonl"), "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("W_RUN_BAD_IMPORTS"):
    print("disallowed-import-detail")
    sys.exit(1)
print("imports checked")
`,
);
const toolchain = {
  schema: "render-stream-toolchain/1",
  name: "llvm-mingw",
  tag: "synthetic",
};
writeFileSync(join(bundle, "toolchain.json"), JSON.stringify(toolchain));
const summaryPath = join(scratch, "summary.md");
function manifest(
  tests: object[],
  importsOnly: object[] = [],
  sabotage: object[] = [],
) {
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({
      schema: "render-stream-w-manifest/1",
      tests,
      imports_only: importsOnly,
      sabotage,
      data: [],
    }),
  );
}
function run(
  name: string,
  missing = false,
  extraEnv: Record<string, string> = {},
) {
  const out = join(scratch, name);
  // Shorten only the synthetic timeout; production still passes timeout=300 to subprocess.run.
  const launcher = `import runpy, subprocess, sys
real_run = subprocess.run
def short_run(argv, **kwargs):
    if str(argv[0]).endswith("/slow"):
        kwargs["timeout"] = 0.05
    return real_run(argv, **kwargs)
subprocess.run = short_run
sys.argv = [sys.argv[1], *sys.argv[2:]]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      launcher,
      tool,
      "--bundle",
      missing ? join(scratch, "missing") : bundle,
      "--out",
      out,
      "--id",
      "windows",
      "--label",
      "windows-win",
      "--imports-tool",
      importsTool,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath, ...extraEnv },
    },
  );
  return { rc: result.status, text: result.stdout + result.stderr, out };
}
function json(out: string, name: string) {
  return JSON.parse(readFileSync(join(out, name), "utf8"));
}
try {
  // Exercise the build's manifest producer without invoking Cargo or the cross toolchain.
  const buildScript = readFileSync(
    fileURLToPath(new URL("../build-rs-net.sh", import.meta.url)),
    "utf8",
  );
  const producer = buildScript
    .split("<<'PYWINDOWS'\n")[1]
    .split("\nPYWINDOWS")[0];
  const build = join(scratch, "build with spaces");
  const net = join(build, "rs-net");
  mkdirSync(net, { recursive: true });
  const library = join(net, "render_stream_net.dll");
  writeFileSync(library, "synthetic-dll");
  writeFileSync(join(net, "toolchain.json"), JSON.stringify(toolchain));
  writeFileSync(
    join(net, "w-imports.json"),
    JSON.stringify({
      binaries: [{ exports: [], imports: [], delay_imports: [] }],
    }),
  );
  const netTests = [
    "abi_layout",
    "render_stream_net",
    "rs-net-lockstep",
    "rs-net-probe",
    "tls",
    "wt",
  ];
  const artifacts = netTests.map((name) => {
    const path = join(scratch, `${name}-hash.exe`);
    writeFileSync(path, `synthetic-test-${name}`);
    return {
      reason: "compiler-artifact",
      profile: { test: true },
      executable: path,
      target: { name, kind: ["test"] },
    };
  });
  writeFileSync(
    join(net, "test-artifacts.jsonl"),
    artifacts.map((a) => JSON.stringify(a)).join("\n"),
  );
  const template = {
    schema: "render-stream-w-manifest/1",
    tests: [context],
    imports_only: [],
    sabotage: [{ exe: "sabotage/dynamic.exe" }],
    data: ["protocol/golden-2"],
  };
  const templatePath = join(build, "w-capture-manifest.json");
  writeFileSync(templatePath, JSON.stringify(template));
  function produceManifest() {
    return spawnSync(
      "python3",
      [
        "-I",
        "-c",
        producer,
        net,
        "x86_64-pc-windows-gnullvm",
        "synthetic-rustc",
        "synthetic-cargo",
        templatePath,
      ],
      { encoding: "utf8" },
    );
  }
  const produced = produceManifest();
  const manifestPath = join(build, "w-manifest.json");
  check(
    "net-manifest-produced",
    produced.status === 0 && existsSync(manifestPath),
    produced.stdout + produced.stderr,
  );
  if (existsSync(manifestPath)) {
    const combined = json(build, "w-manifest.json");
    check(
      "net-manifest-preserves-capture",
      JSON.stringify(combined.tests[0]) === JSON.stringify(context) &&
        JSON.stringify(combined.data) === JSON.stringify(template.data) &&
        JSON.stringify(combined.sabotage) === JSON.stringify(template.sabotage),
    );
    check(
      "net-manifest-all-tests-run",
      combined.tests.length === 7 &&
        netTests.every((name) =>
          combined.tests.some(
            (t: { name: string; args: string[]; env: object; exe: string }) =>
              t.name === `rs-net-${name}` &&
              t.args.length === 0 &&
              Object.keys(t.env).length === 0 &&
              readFileSync(join(build, t.exe), "utf8") ===
                `synthetic-test-${name}`,
          ),
        ),
    );
    check(
      "net-manifest-dll-imports-only",
      combined.imports_only.length === 1 &&
        combined.imports_only[0].exe === "rs-net/render_stream_net.dll" &&
        combined.imports_only[0].why.length > 0,
    );
    const again = produceManifest();
    check(
      "net-manifest-rebuild-no-duplicates",
      again.status === 0 &&
        JSON.stringify(json(build, "w-manifest.json")) ===
          JSON.stringify(combined),
    );
  }
  manifest(
    [pass, context],
    [{ name: "only", exe: "bin/only", why: "built only" }],
    [
      {
        exe: "bin/dynamic",
        expect_disallowed: ["libc++.dll", "libunwind.dll"],
      },
    ],
  );
  const good = run("good");
  check("pass-env-cwd-args", good.rc === 0, good.text);
  if (good.rc === 0) {
    const report = json(good.out, "w-run.json");
    check(
      "report-provenance",
      report.schema === "render-stream-w-run/1" &&
        typeof report.python === "string" &&
        typeof report.platform === "string" &&
        report.toolchain.tag === "synthetic",
    );
    check(
      "per-test-results",
      report.tests.length === 2 &&
        report.tests.every(
          (t: { rc: number; wall_s: number }) => t.rc === 0 && t.wall_s >= 0,
        ),
    );
    const summary = json(good.out, "validate-summary.json");
    const row = summary.runs[0];
    check(
      "partial-row-shape",
      summary.schema === "render-stream-validate-summary/2" &&
        summary.partial === true &&
        summary.runs.length === 1 &&
        row.id === "windows" &&
        row.phase === "setup" &&
        row.rc === "0" &&
        row.lock_wait_s === 0 &&
        row.lock_hold_s === 0 &&
        row.lock_summaries === 0 &&
        row.skipped_by_tier === 0 &&
        Object.keys(row.lock).length === 0 &&
        [
          row.failing,
          row.skipped_remote,
          row.skipped_remote_groups,
          row.unavailable,
          row.known_flakes,
        ].every((a) => Array.isArray(a) && a.length === 0),
    );
    const calls = readFileSync(join(bundle, "imports-calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    check(
      "imports-tests-and-imports-only",
      calls[0].length === 3 &&
        ["pass", "context", "only"].every((n) =>
          calls[0].some((s: string) => s.endsWith(`/bin/${n}`)),
        ),
    );
    check(
      "imports-sabotage",
      calls[1][0] === "--expect-disallowed" &&
        calls[1][1] === "libc++.dll,libunwind.dll" &&
        calls[1][2].endsWith("/bin/dynamic"),
    );
    check(
      "step-summary",
      readFileSync(summaryPath, "utf8").includes("| pass | 0 |"),
    );
  }
  manifest([fail, slow, pass]);
  const bad = run("bad");
  check("fail-and-timeout", bad.rc === 1, bad.text);
  if (bad.rc === 1) {
    const report = json(bad.out, "w-run.json");
    check(
      "continue-after-failure",
      report.tests.length === 3 &&
        report.tests[0].rc === 7 &&
        report.tests[1].rc !== 0 &&
        report.tests[2].rc === 0,
    );
    const row = json(bad.out, "validate-summary.json").runs[0];
    check(
      "failing-names",
      row.rc === "1" && row.failing.join(",") === "fail,slow",
    );
    check(
      "failure-evidence",
      readFileSync(
        join(bad.out, "evidence/windows-win/fail.log"),
        "utf8",
      ).includes("failure-detail") &&
        readFileSync(
          join(bad.out, "evidence/windows-win/slow.log"),
          "utf8",
        ).includes("timeout-detail"),
    );
  }
  manifest(
    [pass],
    [],
    [{ exe: "bin/dynamic", expect_disallowed: ["libc++.dll"] }],
  );
  const importsBad = run("imports-bad", false, { W_RUN_BAD_IMPORTS: "1" });
  check("imports-failures", importsBad.rc === 1, importsBad.text);
  if (importsBad.rc === 1)
    check(
      "imports-failing-names",
      json(importsBad.out, "validate-summary.json").runs[0].failing.join(
        ",",
      ) === "w-imports,w-imports-sabotage",
    );
  const missing = run("missing-bundle", true);
  check("missing-bundle", missing.rc === 2, missing.text);
  if (missing.rc === 2)
    check(
      "missing-bundle-row",
      json(missing.out, "validate-summary.json").runs[0].rc === "2",
    );
  rmSync(join(bundle, "manifest.json"));
  const noManifest = run("missing-manifest");
  check("missing-manifest", noManifest.rc === 2, noManifest.text);
  if (noManifest.rc === 2)
    check(
      "missing-manifest-row",
      json(noManifest.out, "validate-summary.json").partial === true &&
        json(noManifest.out, "validate-summary.json").runs[0].rc === "2",
    );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`self-test-w-run: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
