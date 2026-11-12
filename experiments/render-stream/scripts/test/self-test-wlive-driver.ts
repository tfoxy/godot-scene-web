#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Pure Windows live-harness guards. No browser launch or download. Child imports simulate each
// OS so the Windows resolver can be checked on Linux, without accessing Playwright's cache.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(
  new URL("../lib/browser-harness.ts", import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), "wlive-guards-"));
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const child = (platform: string, executable?: string) => {
  const env = { ...process.env };
  delete env.RS_PINNED_CHROMIUM_EXE;
  if (executable !== undefined) env.RS_PINNED_CHROMIUM_EXE = executable;
  return spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--input-type=module",
      "-e",
      `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
     const h = await import(${JSON.stringify(harness)});
     console.log(JSON.stringify(h.resolvePinnedChromium()));`,
    ],
    { encoding: "utf8", env },
  );
};
try {
  const linux = child("linux", "/untrusted/chrome.exe");
  check(
    "refuses Windows executable override at module load on Linux",
    linux.status !== 0 &&
      linux.stderr.includes("RS_PINNED_CHROMIUM_EXE is Windows-only"),
  );
  const absent = child("win32");
  check(
    "Windows requires explicit pinned executable",
    absent.status !== 0 &&
      absent.stderr.includes("Windows requires RS_PINNED_CHROMIUM_EXE"),
  );
  const fake = join(root, "chrome.exe");
  writeFileSync(fake, "untrusted executable");
  const mismatch = child("win32", fake);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(readFileSync(fake)).digest("hex");
  const fetcher = readFileSync(
    new URL("../fetch-cft-windows.py", import.meta.url),
    "utf8",
  );
  const expected = /EXPECTED_EXE_SHA256 = "([a-f0-9]{64})"/.exec(fetcher)?.[1];
  check(
    "Windows digest mismatch names actual and pinned sha256 before cache resolution",
    !!expected &&
      mismatch.status !== 0 &&
      mismatch.stderr.includes(digest) &&
      mismatch.stderr.includes(expected),
  );
  const judge = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `
import contextlib, importlib.util, io, json, shutil, subprocess, sys
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('driver', sys.argv[1])
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
root = Path(sys.argv[2]) / 'judge'

def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')

def fixture(leg):
    if root.exists(): shutil.rmtree(root)
    for invocation in (['default', 'late'] if leg == 'carriers' else ['wss']):
        run = root / invocation
        names = {'default': ['ws', 'auto', 'auto-wrong-hash', 'auto-no-wt'], 'late': ['ws', 'ws-late'], 'wss': ['wss']}[invocation]
        ids = ['streams-ended', 'recording-equals-tap', 'page-is-package-only'] + {'default': ['sabotage-wrong-hash', 'sabotage-wrong-token', 'auto-fallbacks', 'ws-wt-same-pixels'], 'late': ['late-join'], 'wss': ['wss-tls']}[invocation]
        put(run / 'page/client-carrier.json', {'legs': {name: {'ended': True, 'applied': 2} for name in names}, 'checks': [{'id': name, 'passed': True} for name in ids]})
        (run / 'page/exit-code.txt').write_text('0')
        put(run / 'host.json', {'listened': True, 'exit_code': 0, 'openssl_ok': True})
        put(run / 'host/evidence/live-carriers.json', {'carriers': [{'name': 'ws', 'tls': 'consumer' if invocation == 'wss' else 'none', 'cert_sha256': 'a' * 64}] + ([] if invocation == 'wss' else [{'name': 'wt'}])})
        (run / 'host/evidence/wss-cert-sha256').write_text('a' * 64)
        tap = run / 'host/tap'
        tap.mkdir()
        for i, name in enumerate(names, 1):
            data = ('recording-' + name).encode()
            (run / f'page/recording-{name}.rs13').write_bytes(data)
            (tap / f'stream-{i}.rs2').write_bytes(data)
            (tap / f'live-{i}.jsonl').write_text(json.dumps({'carrier': 'wt' if name == 'auto' else 'ws'}, separators=(',', ':')))

def failures(leg):
    return [name for name, ok, _ in driver.evaluate(root, leg, {}) if not ok]

results = []
for leg in ('carriers', 'wss'):
    fixture(leg)
    results.append([leg + ' valid', failures(leg) == []])

for name, file, mutate, expected in [
    ('false gating check', 'page/client-carrier.json', lambda x: x['checks'][0].update(passed=False), 'gating-checks'),
    ('zero streaming legs', 'page/client-carrier.json', lambda x: x.update(legs={}), 'streaming-legs'),
    ('missing required check', 'page/client-carrier.json', lambda x: x.update(checks=[]), 'gating-checks'),
    ('wss plaintext', 'host/evidence/live-carriers.json', lambda x: x['carriers'][0].update(tls='none'), 'wss-tls'),
    ('wrong leaf', 'host/evidence/live-carriers.json', lambda x: x['carriers'][0].update(cert_sha256='b' * 64), 'wss-tls'),
    ('wrong carrier', 'host/evidence/live-carriers.json', lambda x: x['carriers'].append({'name': 'other'}), 'carrier-names'),
    ('host never listened', 'host.json', lambda x: x.update(listened=False), 'host-listened'),
    ('crash exit', 'host.json', lambda x: x.update(exit_code=0xc0000005), 'host-exit'),
    ('early termination', 'host.json', lambda x: x.update(exit_code=1, terminated_after_drain=True, tap_before_termination=True, drain_s=119), 'host-exit'),
    ('openssl missing', 'host.json', lambda x: x.update(openssl_ok=False), 'openssl'),
]:
    fixture('wss')
    path = root / 'wss' / file
    value = json.loads(path.read_text()); mutate(value); put(path, value)
    results.append([name, failures('wss') == ['wss/' + expected]])
for name in ('missing tap', 'empty taps', 'wrong tap carrier', 'different tap bytes'):
    fixture('wss')
    tap = root / 'wss/host/tap'
    if name in ('missing tap', 'empty taps'):
        (tap / 'stream-1.rs2').unlink()
    elif name == 'wrong tap carrier':
        (tap / 'live-1.jsonl').write_text('{"carrier":"wt"}')
    else:
        (tap / 'stream-1.rs2').write_bytes(b'not the recording')
    results.append([name, failures('wss') == ['wss/tap-files']])
fixture('carriers')
(root / 'late/host/tap/stream-1.rs2').unlink()
results.append(['late first ws tap required', failures('carriers') == ['late/tap-files']])
fixture('wss')
p = root / 'wss/host.json'; o = json.loads(p.read_text()); o.update(exit_code=1, terminated_after_drain=True, tap_before_termination=True, drain_s=120); put(p,o)
results.append(['termination after drain accepted', failures('wss') == []])
# Exercise real launch setup through TLS generation, without starting a host or browser.
base = Path(sys.argv[2]) / 'launch'
(base / 'fixture').mkdir(parents=True)
(base / 'import').mkdir()
config = {'fixture': 'fixture', 'import': 'import', 'extension': 'extension',
          'record': 'calibration', 'template': 'host'}
for cleanup_timeout in (False, True):
    artifact = base / ('timeout' if cleanup_timeout else 'exception')
    observed = {}
    def generate(argv, **kwargs):
        key = Path(argv[argv.index('-keyout') + 1])
        cert = Path(argv[argv.index('-out') + 1])
        key.write_text('private key')
        cert.write_text('public cert')
    class Host:
        def poll(self): return None
        def terminate(self): observed['deleted_before_terminate'] = not observed['key'].exists()
        def wait(self, timeout): raise subprocess.TimeoutExpired('simulated host', timeout)
    def start(argv, **kwargs):
        key = Path(kwargs['env']['GRC_LIVE_TLS_KEY'])
        observed.update(key=key, exists=key.is_file(), outside=not key.is_relative_to(artifact))
        if cleanup_timeout: return Host()
        raise ValueError('simulated failure after key generation')
    def fail_listen(*args, **kwargs): raise ValueError('simulated failure after key generation')
    with contextlib.ExitStack() as stack:
        stack.enter_context(patch.object(driver, 'openssl_path', return_value='/mock/openssl'))
        stack.enter_context(patch.object(driver.subprocess, 'check_output', side_effect=lambda *a, **kw: 'mock openssl' if kw.get('text') else b'public'))
        stack.enter_context(patch.object(driver.subprocess, 'run', side_effect=generate))
        stack.enter_context(patch.object(driver.subprocess, 'Popen', side_effect=start))
        stack.enter_context(patch.object(driver, 'read_json', side_effect=fail_listen))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        try: driver.run_invocation(base, config, base, artifact, 'wss', None)
        except subprocess.TimeoutExpired: pass
    results.append(['TLS key outside artifacts after ' + ('cleanup timeout' if cleanup_timeout else 'generation exception'),
                    observed.get('exists') and observed.get('outside') and not observed['key'].exists()
                    and not list(artifact.rglob('key.pem'))
                    and (not cleanup_timeout or observed.get('deleted_before_terminate'))])
driver.shutil.which = lambda _: None
if driver.os.name != 'nt':
    try: driver.openssl_path()
    except ValueError as exc: results.append(['missing resolved openssl fails by name', 'openssl:' in str(exc)])
    else: results.append(['missing resolved openssl fails by name', False])
print(json.dumps(results))
`,
      fileURLToPath(new URL("../lib/wlive-driver.py", import.meta.url)),
      root,
    ],
    { encoding: "utf8" },
  );
  if (judge.status !== 0) console.error(judge.stderr);
  check("driver synthetic evaluator executed", judge.status === 0);
  if (judge.status === 0)
    for (const [name, ok] of JSON.parse(judge.stdout) as [string, boolean][])
      check(name, ok);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`self-test-wlive-driver: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
