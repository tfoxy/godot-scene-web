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
  extraArgs: string[] = [],
) {
  const out = join(scratch, name);
  // Simulate a 450 s leg without waiting; shorten only the actual sleep timeout.
  const launcher = `import runpy, subprocess, sys
real_run = subprocess.run
def short_run(argv, **kwargs):
    if any(str(arg).endswith("/wswap/synthetic.py") for arg in argv):
        kwargs["stdout"].write(f"swap timeout_s={kwargs['timeout']}\\n".encode())
    if str(argv[0]).endswith("/timeout-probe"):
        elapsed = 450
        limit = kwargs["timeout"]
        if elapsed > limit:
            raise subprocess.TimeoutExpired(argv, limit)
        kwargs["stdout"].write(f"simulated {elapsed} s within {limit} s timeout\\n".encode())
        return subprocess.CompletedProcess(argv, 0)
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
      ...extraArgs,
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
  const fetcher = fileURLToPath(
    new URL("../fetch-cft-windows.py", import.meta.url),
  );
  const probeCases = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `import contextlib, html, io, json, pathlib, runpy, struct, subprocess, sys, tempfile
m = runpy.run_path(sys.argv[1])
good = {"userAgent": "Mozilla/5.0 HeadlessChrome/148.0.0.0 Safari/537.36",
        "webTransport": "function", "renderer": "none", "canvasPixel": [17, 34, 51, 255]}
def dom(value):
    return '<pre id="probe">' + html.escape(json.dumps(value)) + '</pre>'
cases = [("probe-valid-renderer-not-gated", dom(good), None),
         ("probe-empty-dom", "", "missing or empty"),
         ("probe-empty-pre", '<pre id="probe"></pre>', "missing or empty"),
         ("probe-duplicate-pre", dom(good) + dom(good), "missing or empty"),
         ("probe-invalid-json", '<pre id="probe">pending</pre>', "Expecting value"),
         ("probe-wrong-version", dom({**good, "userAgent": "Chrome/147.0.0.0"}), "wrong user-agent major version"),
         ("probe-major-prefix", dom({**good, "userAgent": "Chrome/1480.0.0.0"}), "wrong user-agent major version"),
         ("probe-no-webtransport", dom({**good, "webTransport": "undefined"}), "typeof WebTransport"),
         ("probe-wrong-pixel", dom({**good, "canvasPixel": [0, 0, 0, 0]}), "failed canvas readback")]
results = []
for name, text, expected in cases:
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m["judge_probe"](text, m["VERSION"])
        ok = expected is None
    except ValueError as exc:
        ok = expected is not None and expected in str(exc)
    results.append([name, ok])
for version in ("148.0.7778.960", "147.0.7778.96", "", None):
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m["judge_probe"](dom(good), version)
        results.append(["probe-wrong-full-version-" + str(version), False])
    except ValueError as exc:
        results.append(["probe-wrong-full-version-" + str(version), "wrong executable version" in str(exc)])
with tempfile.TemporaryDirectory() as scratch:
    root = pathlib.Path(scratch)
    # A minimal PE32+ resource tree with one RT_VERSION/name/language entry.
    image = bytearray(1024)
    def put(offset, fmt, *values):
        struct.pack_into("<" + fmt, image, offset, *values)
    image[:2] = b"MZ"
    put(0x3c, "I", 0x80)
    image[0x80:0x84] = bytes([80, 69, 0, 0])
    put(0x86, "H", 1)
    put(0x94, "H", 240)
    put(0x98, "H", 0x20b)
    put(0x98 + 112 + 16, "II", 0x1000, 512)
    put(0x98 + 240 + 12, "III", 0x1000, 512, 512)
    for relative, name, child in ((0, 16, 0x80000018), (24, 1, 0x80000030), (48, 1033, 72)):
        put(512 + relative + 14, "H", 1)
        put(512 + relative + 16, "II", name, child)
    put(512 + 72, "II", 0x1000 + 96, 92)
    put(608, "HHH", 92, 52, 0)
    key = ("VS_VERSION_INFO" + chr(0)).encode("utf-16le")
    image[614:614 + len(key)] = key
    put(648, "IIIIII", 0xfeef04bd, 0x10000, 0, 0, 148 << 16, (7778 << 16) | 96)
    exe = root / "chrome.exe"
    exe.write_bytes(image)
    results.append(["probe-reads-pe-product-version", m["executable_version"](exe) == m["VERSION"]])
    bad = root / "bad.exe"
    bad.write_bytes(image[:650])
    try:
        m["executable_version"](bad)
        results.append(["probe-invalid-version-resource", False])
    except ValueError as exc:
        results.append(["probe-invalid-version-resource", "invalid executable version resource" in str(exc)])
    namespace = m["probe"].__globals__
    calls = []
    snapshots = []
    stops = []
    mode = "good"
    class FakeProcess:
        pid = 12345
        def __init__(self, argv, **kwargs):
            calls.append((argv, kwargs))
            profile = pathlib.Path(next(a.split("=", 1)[1] for a in argv if a.startswith("--user-data-dir=")))
            (profile / "DevToolsActivePort").write_text("9222" + chr(10) + "/devtools/browser/test")
            (profile / "chrome_debug.log").write_text("profile diagnostics")
            kwargs["stdout"].write(b"stdout diagnostics")
            kwargs["stdout"].flush()
            kwargs["stderr"].write(b"stderr diagnostics")
            kwargs["stderr"].flush()
        def poll(self):
            return 7 if mode == "exit" else None
    class FakeCDP:
        def __init__(self, url, deadline):
            self.deadline = deadline
            assert url == "ws://127.0.0.1:9222/devtools/browser/test"
        def call(self, method, params=None, session=None):
            if mode == "timeout":
                raise TimeoutError("synthetic timeout")
            if method == "Browser.getVersion":
                return {"product": "Chrome/" + ("147.0.0.0" if mode == "version" else m["VERSION"])}
            if method == "Target.createTarget":
                return {"targetId": "target"}
            if method == "Target.attachToTarget":
                return {"sessionId": "session"}
            if method == "Page.navigate":
                assert params["url"].startswith("file:///") and "%20" in params["url"]
            if method == "Runtime.evaluate":
                assert session == "session"
                return {"result": {"value": '<pre id="probe">pending</pre>' if mode == "dom" else dom(good)}}
            return {}
        def close(self):
            pass
    real_popen = subprocess.Popen
    saved = {key: namespace[key] for key in ("CDP", "process_snapshot", "stop_chrome")}
    subprocess.Popen = FakeProcess
    namespace["CDP"] = FakeCDP
    namespace["process_snapshot"] = lambda proc, evidence: snapshots.append(evidence.name)
    namespace["stop_chrome"] = lambda proc, evidence: stops.append(evidence.name)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            m["probe"](exe, root / "page with spaces.html", root)
        argv, kwargs = calls[0]
        profile = next(a.split("=", 1)[1] for a in argv if a.startswith("--user-data-dir="))
        results.append(["probe-cdp-args-isolated-profile", "--use-angle=vulkan" not in argv
                        and "--headless=new" in argv and "--dump-dom" not in argv
                        and "--remote-debugging-port=0" in argv and "--use-angle=swiftshader" in argv
                        and "--no-first-run" in argv and "--no-default-browser-check" in argv
                        and "--disable-gpu-sandbox" in argv and "--enable-logging=stderr" in argv and "--v=1" in argv
                        and "DISPLAY" not in kwargs["env"] and "WAYLAND_DISPLAY" not in kwargs["env"]
                        and not pathlib.Path(profile).exists()])
        evidence = root / "cdp-swiftshader"
        launch = json.loads((evidence / "launch.json").read_text())
        results.append(["probe-saves-live-logs-dom-and-profile-log", (evidence / "probe.html").read_text() == dom(good)
                        and (evidence / "chrome-stdout.log").read_bytes() == b"stdout diagnostics"
                        and (evidence / "chrome-stderr.log").read_bytes() == b"stderr diagnostics"
                        and (evidence / "profile-chrome_debug.log").read_text() == "profile diagnostics"])
        results.append(["probe-first-output-and-wall-time", launch["first_output_s"] is not None
                        and 0 <= launch["first_output_s"] <= launch["wall_s"]])
        results.append(["probe-stops-at-first-success", len(calls) == 1 and stops == ["cdp-swiftshader"]
                        and json.loads((root / "probe-result.json").read_text())["variant"] == "cdp-swiftshader"])
        for mode, expected in (("exit", "Chrome exit 7"), ("timeout", "synthetic timeout"),
                               ("version", "wrong CDP full version"), ("dom", "Expecting value")):
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    m["probe"](exe, root / "page with spaces.html", root / mode)
                results.append(["probe-rejects-" + mode, False])
            except ValueError as exc:
                results.append(["probe-rejects-" + mode, expected in str(exc)])
        results.append(["probe-failure-snapshots-and-teardown", len(snapshots) == 8 and len(stops) == 9])
        timeout_launch = json.loads((root / "timeout/cdp-swiftshader/launch.json").read_text())
        results.append(["probe-timeout-evidence", timeout_launch["timed_out"] is True
                        and "Browser.getVersion" in timeout_launch["error"]])
        mode = "good"
        original_variant = namespace["probe_variant"]
        attempted = []
        def fallback(exe, page, out, variant, args, version):
            attempted.append((variant, args))
            if variant == "cdp-swiftshader":
                raise TimeoutError("first launch hung")
        namespace["probe_variant"] = fallback
        text = io.StringIO()
        try:
            with contextlib.redirect_stdout(text):
                m["probe"](exe, root / "page.html", root)
            results.append(["probe-disable-gpu-fallback-and-old-skip", len(attempted) == 2
                            and "--disable-gpu" in attempted[1][1] and "--enable-gpu" not in attempted[1][1]
                            and "skip headless=old" in text.getvalue()
                            and "selected variant: cdp-disable-gpu" in text.getvalue()])
        finally:
            namespace["probe_variant"] = original_variant
        # Windows failure diagnostics precede taskkill /T /F, and the parent is reaped.
        command_log = []
        real_run = subprocess.run
        old_name = namespace["os"].name
        subprocess.run = lambda argv, **kw: command_log.append(argv)
        class Child:
            pid = 42
            def wait(self, timeout):
                command_log.append(["wait", timeout])
        try:
            namespace["os"].name = "nt"
            saved["process_snapshot"](Child(), root)
            saved["stop_chrome"](Child(), root)
            results.append(["probe-windows-tree-before-kill", command_log == [
                ["tasklist", "/v"], ["taskkill", "/PID", "42", "/T", "/F"], ["wait", 5]]])
        finally:
            namespace["os"].name = old_name
            subprocess.run = real_run
    finally:
        subprocess.Popen = real_popen
        namespace.update(saved)
# Exercise the stdlib WebSocket transport, including Chrome's case-sensitive accept value,
# fragmented replies, unsolicited CDP events and ping/pong while awaiting a command reply.
namespace = m["CDP"].__init__.__globals__
socket_module = namespace["socket"]
real_connect = socket_module.create_connection
class FakeSocket:
    def __init__(self, bad=False):
        self.buffer = bytearray()
        self.bad = bad
        self.closed = False
        self.pong = False
    def settimeout(self, timeout):
        assert 0 < timeout <= 30
    def sendall(self, data):
        if data.startswith(b"GET "):
            key = data.split(b"Sec-WebSocket-Key: ")[1].split(bytes([13, 10]))[0]
            accept = namespace["base64"].b64encode(namespace["hashlib"].sha1(
                key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            if self.bad:
                accept = b"wrong"
            self.buffer.extend(b"HTTP/1.1 101 Switching Protocols" + bytes([13, 10])
                               + b"Sec-WebSocket-Accept: " + accept + bytes([13, 10, 13, 10]))
        else:
            size = data[1] & 127
            assert size < 126
            mask = data[2:6]
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(data[6:]))
            if data[0] == 0x8a:
                self.pong = payload == b"ping"
                return
            command = json.loads(payload)
            reply = json.dumps({"id": command["id"], "result": {"product": "Chrome/" + m["VERSION"]}}).encode()
            event = json.dumps({"method": "event"}).encode()
            self.buffer.extend(bytes([0x81, len(event)]) + event + bytes([0x89, 4]) + b"ping")
            self.buffer.extend(bytes([1, 10]) + reply[:10] + bytes([0x80, len(reply) - 10]) + reply[10:])
    def recv(self, count):
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data
    def close(self):
        self.closed = True
try:
    sock = FakeSocket()
    socket_module.create_connection = lambda *a: sock
    cdp = m["CDP"]("ws://127.0.0.1:9222/devtools/browser/test", namespace["time"].monotonic() + 30)
    reply = cdp.call("Browser.getVersion")
    cdp.close()
    results.append(["probe-cdp-handshake-events-ping-fragments", reply == {"product": "Chrome/" + m["VERSION"]}
                    and sock.pong and sock.closed])
    sock = FakeSocket(bad=True)
    try:
        m["CDP"]("ws://127.0.0.1:9222/devtools/browser/test", namespace["time"].monotonic() + 30)
        results.append(["probe-cdp-rejects-bad-accept", False])
    except ValueError as exc:
        results.append(["probe-cdp-rejects-bad-accept", "handshake rejected" in str(exc) and sock.closed])
    try:
        m["CDP"]("ws://example.com:9222/devtools/browser/test", namespace["time"].monotonic() + 30)
        results.append(["probe-cdp-loopback-only", False])
    except ValueError as exc:
        results.append(["probe-cdp-loopback-only", "non-loopback" in str(exc)])
finally:
    socket_module.create_connection = real_connect
print(json.dumps(results))
`,
      fetcher,
    ],
    { encoding: "utf8" },
  );
  check("probe-pure-cases-run", probeCases.status === 0, probeCases.stderr);
  if (probeCases.status === 0) {
    for (const [name, ok] of JSON.parse(probeCases.stdout)) check(name, ok);
  }
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
  const pythonPath = "bin/interpreter test.py";
  writeFileSync(
    join(bundle, pythonPath),
    `import os, pathlib, sys
assert sys.flags.isolated == 1
assert sys.argv[1:] == ["hello world"]
assert os.environ["W_RUN_ENV"] == "évidence"
assert pathlib.Path("manifest.json").is_file()
art = pathlib.Path(os.environ["W_RUN_ARTIFACT_DIR"])
art.mkdir(parents=True, exist_ok=True)
(art / "runtime-proof.txt").write_text(sys.executable, encoding="utf-8")
`,
  );
  const pythonTest = {
    name: "python-test",
    exe: pythonPath,
    interpreter: "python",
    args: ["hello world"],
    env: { W_RUN_ENV: "évidence", W_RUN_ARTIFACT_DIR: "wrong-directory" },
  };
  rmSync(join(bundle, "imports-calls.jsonl"));
  manifest(
    [pass, pythonTest],
    [{ ...pythonTest, expect_exports: ["not-a-PE-export"] }],
    [
      { ...pythonTest, expect_disallowed: ["not-a-PE-import"] },
      { exe: "bin/dynamic", expect_disallowed: ["libc++.dll"] },
    ],
  );
  const interpreted = run("interpreted");
  check(
    "python-interpreter-runs-isolated",
    interpreted.rc === 0,
    interpreted.text,
  );
  check(
    "passing-run-has-no-evidence",
    !existsSync(join(interpreted.out, "evidence")),
  );
  check(
    "python-interpreter-artifact-dir",
    existsSync(
      join(interpreted.out, "artifacts/python-test/runtime-proof.txt"),
    ),
    interpreted.text,
  );
  check(
    "python-interpreter-count",
    interpreted.text.includes("1 interpreter tests"),
    interpreted.text,
  );
  const interpreterImports = readFileSync(
    join(bundle, "imports-calls.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  check(
    "python-interpreter-skips-imports",
    interpreterImports.length === 2 &&
      interpreterImports[0].length === 1 &&
      interpreterImports[0][0].endsWith("/bin/pass") &&
      interpreterImports[1][0] === "--expect-disallowed" &&
      interpreterImports[1][2].endsWith("/bin/dynamic") &&
      interpreterImports.every((args) =>
        args.every((arg) => !arg.endsWith(".py")),
      ),
    JSON.stringify(interpreterImports),
  );
  writeFileSync(
    join(bundle, "bin/long-failure.py"),
    'import sys\nprint("first-leg-failure-detail")\nprint("later-passing-leg\\n" * 2000)\nsys.exit(1)\n',
  );
  manifest([
    {
      name: "wfile-gate8-a",
      exe: "bin/long-failure.py",
      interpreter: "python",
    },
    {
      name: "other-long-failure",
      exe: "bin/long-failure.py",
      interpreter: "python",
    },
  ]);
  const longFailure = run("long-failure");
  const wfileEvidence = readFileSync(
    join(longFailure.out, "evidence/windows-win/wfile-gate8-a.log"),
    "utf8",
  );
  check(
    "wfile-failure-preserves-first-line-beyond-20KB",
    longFailure.rc === 1 &&
      wfileEvidence.length > 20 * 1024 &&
      wfileEvidence.startsWith("first-leg-failure-detail\n") &&
      wfileEvidence ===
        readFileSync(join(longFailure.out, "logs/wfile-gate8-a.log"), "utf8"),
    longFailure.text,
  );
  check(
    "other-failure-retains-20KB-tail",
    readFileSync(
      join(longFailure.out, "evidence/windows-win/other-long-failure.log"),
    ).length ===
      20 * 1024 &&
      !readFileSync(
        join(longFailure.out, "evidence/windows-win/other-long-failure.log"),
        "utf8",
      ).includes("first-leg-failure-detail"),
    longFailure.text,
  );
  rmSync(join(bundle, "imports-calls.jsonl"));
  manifest([{ ...pythonTest, interpreter: "ruby" }]);
  const unknownInterpreter = run("unknown-interpreter");
  check(
    "unknown-interpreter-bundle-error",
    unknownInterpreter.rc === 2 &&
      unknownInterpreter.text.includes("unknown interpreter") &&
      json(unknownInterpreter.out, "w-run.json").tests.length === 0 &&
      !existsSync(join(bundle, "imports-calls.jsonl")),
    unknownInterpreter.text,
  );
  const timeoutProbe = {
    name: "wfile-timeout-probe",
    exe: exe("timeout-probe", "exit 99"),
    args: [],
    env: {},
  };
  manifest([{ ...timeoutProbe, timeout_s: 900 }]);
  const extendedTimeout = run("extended-timeout");
  check(
    "timeout-override-outlives-300s-stub",
    extendedTimeout.rc === 0 &&
      readFileSync(
        join(extendedTimeout.out, "logs/wfile-timeout-probe.log"),
        "utf8",
      ).includes("simulated 450 s within 900 s timeout"),
    extendedTimeout.text,
  );
  manifest([{ ...pass, timeout_s: 1800 }]);
  const longTimeout = run("positive-timeout-without-live-cap");
  check(
    "capture-timeout-keeps-W5-positive-integer-contract",
    longTimeout.rc === 0,
    longTimeout.text,
  );
  manifest([timeoutProbe]);
  const defaultTimeout = run("default-timeout");
  check(
    "timeout-default-stays-300s",
    defaultTimeout.rc === 1 &&
      json(defaultTimeout.out, "w-run.json").tests[0].timed_out &&
      readFileSync(
        join(defaultTimeout.out, "logs/wfile-timeout-probe.log"),
        "utf8",
      ).includes("timed out after 300 s"),
    defaultTimeout.text,
  );
  for (const timeout of [0, -1, 1.5, "900", true, null]) {
    rmSync(join(bundle, "imports-calls.jsonl"), { force: true });
    manifest([{ ...pass, timeout_s: timeout }]);
    const invalid = run(`invalid-timeout-${JSON.stringify(timeout)}`);
    check(
      `invalid-timeout-${JSON.stringify(timeout)}-bundle-error`,
      invalid.rc === 2 &&
        invalid.text.includes("timeout_s") &&
        json(invalid.out, "w-run.json").tests.length === 0 &&
        !existsSync(join(bundle, "imports-calls.jsonl")),
      invalid.text,
    );
  }
  manifest(
    [
      pass,
      fail,
      { ...pass, name: "w1-arm" },
      { ...fail, name: "w1-refuse" },
      { ...pass, name: "wfile-gate0-a" },
      { ...pass, name: "wfile-sabotage" },
    ],
    [{ name: "only", exe: "bin/only", expect_exports: ["exported"] }],
    [{ exe: "bin/dynamic", expect_disallowed: ["libc++.dll"] }],
  );
  const grouped = run("grouped");
  check(
    "gate-W-groups-counts",
    grouped.rc === 1 &&
      JSON.stringify(json(grouped.out, "w-run.json").groups) ===
        JSON.stringify({
          "w-ctest": { passed: 1, total: 2 },
          "w-imports": { passed: 3, total: 3 },
          "w-1": { passed: 1, total: 2 },
          "w-file": { passed: 2, total: 2 },
          "w-swap": { passed: 0, total: 0 },
        }),
    grouped.text,
  );
  check(
    "gate-W-single-summary-line",
    grouped.text.split("\n").filter((line) => line.startsWith("gate W:"))
      .length === 1 &&
      grouped.text.includes("w-ctest 1/2") &&
      grouped.text.includes("w-imports 3/3") &&
      grouped.text.includes("w-1 1/2") &&
      grouped.text.includes("w-file 2/2"),
    grouped.text,
  );
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
  // Live is a separate suite: capture jobs never execute these Python/Node legs.
  mkdirSync(join(bundle, "wlive"), { recursive: true });
  const liveScript = join(bundle, "wlive", "synthetic.py");
  writeFileSync(
    liveScript,
    `import json, os
from pathlib import Path
p = Path(os.environ["W_RUN_ARTIFACT_DIR"])
p.mkdir(parents=True)
(p / "wlive-summary.json").write_text(json.dumps({"variant": "synthetic"}))
print("client-carrier-check: leg ws: synthetic success")
`,
  );
  const liveEntries = ["wlive-carriers", "wlive-wss"].map((name) => ({
    name,
    exe: "wlive/synthetic.py",
    interpreter: "python",
    args: [],
    env: {},
    timeout_s: 600,
  }));
  const liveManifest = {
    schema: "render-stream-w-manifest/1",
    tests: liveEntries,
    imports_only: [],
    sabotage: [],
  };
  const livePath = join(bundle, "wlive/manifest.json");
  writeFileSync(livePath, JSON.stringify(liveManifest));
  rmSync(join(bundle, "imports-calls.jsonl"), { force: true });
  const live = run("live-suite", false, {}, ["--suite", "live"]);
  check(
    "live-suite-runs-exactly-two-legs",
    live.rc === 0 && json(live.out, "w-run.json").tests.length === 2,
    live.text,
  );
  check(
    "live-suite-skips-native-import-checks",
    live.rc === 0 &&
      json(live.out, "w-run.json").checks.length === 0 &&
      !existsSync(join(bundle, "imports-calls.jsonl")),
    live.text,
  );
  check(
    "live-success-summary-kept",
    existsSync(join(live.out, "artifacts/wlive-carriers/wlive-summary.json")) &&
      existsSync(join(live.out, "artifacts/wlive-wss/wlive-summary.json")),
    live.text,
  );
  check(
    "live-success-leg-printed",
    live.text.includes("client-carrier-check: leg ws: synthetic success"),
    live.text,
  );
  writeFileSync(livePath, JSON.stringify({ ...liveManifest, tests: [] }));
  check(
    "empty-live-suite-refused",
    run("live-empty", false, {}, ["--suite", "live"]).rc === 2,
  );
  writeFileSync(
    livePath,
    JSON.stringify({
      ...liveManifest,
      tests: [{ ...liveEntries[0], timeout_s: -1 }, liveEntries[1]],
    }),
  );
  const invalidTimeout = run("invalid-timeout", false, {}, ["--suite", "live"]);
  check(
    "invalid-manifest-timeout-refused",
    invalidTimeout.rc === 2 && invalidTimeout.text.includes("timeout_s"),
    invalidTimeout.text,
  );
  mkdirSync(join(bundle, "wswap"), { recursive: true });
  writeFileSync(
    join(bundle, "wswap/synthetic.py"),
    `import json, os, sys
from pathlib import Path
assert sys.flags.isolated == 1
assert os.environ["WSWAP_REPO_ROOT"] == "synthetic checkout"
assert Path("wswap/manifest.json").is_file()
p = Path(os.environ["W_RUN_ARTIFACT_DIR"])
p.mkdir(parents=True)
(p / "wswap-summary.json").write_text(json.dumps({"platform": "windows"}))
print("wswap leg swap: exit=0 wall_s=1")
print("wswap check swap-accounting: PASS synthetic")
if os.environ.get("WSWAP_TEST_FAIL"):
    print("swap-failure-detail")
    sys.exit(7)
`,
  );
  const swapEntry = {
    name: "wswap",
    exe: "wswap/synthetic.py",
    interpreter: "python",
    timeout_s: 1500,
    env: {},
  };
  const swapManifest = { ...liveManifest, tests: [swapEntry] };
  const swapPath = join(bundle, "wswap/manifest.json");
  writeFileSync(swapPath, JSON.stringify(swapManifest));
  const swapEnv = { WSWAP_REPO_ROOT: "synthetic checkout" };
  const swap = run("swap-suite", false, swapEnv, ["--suite", "swap"]);
  check(
    "swap-suite-runs-one-python-entry",
    swap.rc === 0 && json(swap.out, "w-run.json").tests.length === 1,
    swap.text,
  );
  check(
    "swap-suite-skips-imports",
    swap.rc === 0 &&
      json(swap.out, "w-run.json").checks.length === 0 &&
      !existsSync(join(bundle, "imports-calls.jsonl")),
    swap.text,
  );
  check(
    "swap-success-evidence-kept",
    existsSync(join(swap.out, "artifacts/wswap/wswap-summary.json")),
    swap.text,
  );
  check(
    "swap-leg-and-check-lines-printed",
    swap.text.includes("wswap leg swap:") &&
      swap.text.includes("wswap check swap-accounting: PASS"),
    swap.text,
  );
  check(
    "swap-tally",
    swap.rc === 0 &&
      JSON.stringify(json(swap.out, "w-run.json").groups["w-swap"]) ===
        JSON.stringify({ passed: 1, total: 1 }) &&
      swap.text.includes("w-swap 1/1"),
    swap.text,
  );
  check(
    "swap-timeout-1500s",
    swap.rc === 0 &&
      readFileSync(join(swap.out, "logs/wswap.log"), "utf8").includes(
        "swap timeout_s=1500",
      ),
    swap.text,
  );
  const swapBad = run(
    "swap-fail",
    false,
    { ...swapEnv, WSWAP_TEST_FAIL: "1" },
    ["--suite", "swap"],
  );
  check(
    "swap-failure-summary-and-diagnostic",
    swapBad.rc === 1 &&
      json(swapBad.out, "w-run.json").groups["w-swap"].passed === 0 &&
      readFileSync(
        join(swapBad.out, "evidence/windows-win/wswap.log"),
        "utf8",
      ).includes("swap-failure-detail"),
    swapBad.text,
  );
  const invalidSwaps = [
    ["empty", { ...swapManifest, tests: [] }],
    ["duplicate", { ...swapManifest, tests: [swapEntry, swapEntry] }],
    [
      "wrong-name",
      { ...swapManifest, tests: [{ ...swapEntry, name: "other" }] },
    ],
    [
      "native",
      { ...swapManifest, tests: [{ ...swapEntry, interpreter: undefined }] },
    ],
    [
      "missing-timeout",
      { ...swapManifest, tests: [{ ...swapEntry, timeout_s: undefined }] },
    ],
    [
      "wrong-timeout",
      { ...swapManifest, tests: [{ ...swapEntry, timeout_s: 1499 }] },
    ],
    ["imports", { ...swapManifest, imports_only: [{ exe: "extra.exe" }] }],
    ["sabotage", { ...swapManifest, sabotage: [{ exe: "extra.exe" }] }],
  ] as const;
  for (const [name, invalid] of invalidSwaps) {
    writeFileSync(swapPath, JSON.stringify(invalid));
    const result = run(`swap-invalid-${name}`, false, swapEnv, [
      "--suite",
      "swap",
    ]);
    check(
      `swap-${name}-refused`,
      result.rc === 2 && result.text.includes("swap manifest"),
      result.text,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`self-test-w-run: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
