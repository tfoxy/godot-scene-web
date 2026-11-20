#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_CHROMIUM_SHA256_MACOS } from "../lib/browser-harness";
// Engine-free macOS live guards; platform simulation never launches a browser.
import {
  makeSelfTestTempDir,
  removeSelfTestTempDir,
} from "../lib/self-test-temp";

const root = makeSelfTestTempDir(join(tmpdir(), "mlive-guards-"));
let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean) => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const child = (arch: string, executable?: string) => {
  const env = { ...process.env };
  delete env.RS_PINNED_CHROMIUM_EXE;
  if (executable !== undefined) env.RS_PINNED_CHROMIUM_EXE = executable;
  return spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--input-type=module",
      "-e",
      `Object.defineProperty(process, 'platform', { value: 'darwin' });
       Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });
       const h = await import(${JSON.stringify(fileURLToPath(new URL("../lib/browser-harness.ts", import.meta.url)))});
       console.log(JSON.stringify(h.resolvePinnedChromium()));`,
    ],
    { encoding: "utf8", env },
  );
};
try {
  for (const arch of ["arm64", "x64"] as const) {
    const absent = child(arch);
    check(
      `${arch}: macOS requires explicit pinned executable`,
      absent.status !== 0 &&
        absent.stderr.includes("macOS requires RS_PINNED_CHROMIUM_EXE"),
    );
    const fake = join(root, `chrome-${arch}`);
    writeFileSync(fake, "untrusted executable");
    const mismatch = child(arch, fake);
    check(
      `${arch}: executable mismatch reports actual and pinned digests`,
      mismatch.status !== 0 &&
        mismatch.stderr.includes(
          createHash("sha256").update("untrusted executable").digest("hex"),
        ) &&
        mismatch.stderr.includes(EXPECTED_CHROMIUM_SHA256_MACOS[arch]),
    );
  }
  const judge = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `import contextlib, hashlib, importlib.util, io, json, shutil, subprocess, sys, zipfile
from pathlib import Path
from unittest.mock import patch
scripts, root = Path(sys.argv[1]), Path(sys.argv[2])
harness_pins = json.loads(sys.argv[3])

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

driver = load('driver', scripts / 'lib/mlive-driver.py')
cft = load('cft', scripts / 'fetch-cft-macos.py')
bundle = load('bundle', scripts / 'lib/mlive-bundle.py')
results = []

def check(name, ok): results.append([name, bool(ok)])
def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')

judge = root / 'judge'
names = {'default': ['ws', 'auto', 'auto-wrong-hash', 'auto-no-wt'],
         'late': ['ws', 'ws-late'], 'wss': ['wss']}
ids = ['streams-ended', 'recording-equals-tap', 'page-is-package-only', 'sabotage-wrong-hash',
       'sabotage-wrong-token', 'auto-fallbacks', 'ws-wt-same-pixels', 'browser-version', 'browser-provenance']

def fixture():
    if judge.exists(): shutil.rmtree(judge)
    for invocation, pages in names.items():
        run = judge / invocation
        checks = ids if invocation == 'default' else ids[:3] + ['browser-version', 'browser-provenance',
                  'late-join' if invocation == 'late' else 'wss-tls']
        put(run / 'page/client-carrier.json', {'legs': {n: {'ended': True, 'applied': 2} for n in pages},
            'checks': [{'id': n, 'passed': True} for n in checks]})
        (run / 'page/exit-code.txt').write_text('0')
        put(run / 'host.json', {'listened': True, 'exit_code': 0, 'openssl_ok': True})
        put(run / 'host/evidence/live-carriers.json', {'carriers': [{'name': 'ws', 'tls': 'consumer',
            'cert_sha256': 'a' * 64}] + ([] if invocation == 'wss' else [{'name': 'wt'}])})
        (run / 'host/evidence/wss-cert-sha256').write_text('a' * 64)
        tap = run / 'host/tap'
        tap.mkdir()
        for i, name in enumerate(pages):
            data = ('recording-' + name).encode()
            (run / f'page/recording-{name}.rs13').write_bytes(data)
            (tap / f'stream-{i}.rs2').write_bytes(data)
            (tap / f'live-{i}.jsonl').write_text(json.dumps(
                {'carrier': 'wt' if name == 'auto' else 'ws'}, separators=(',', ':')))

def failures(): return [name for name, ok, _ in driver.evaluate(judge, 'carriers', {}) if not ok]
fixture()
check('default, late and wss: all 23 checks pass', len(driver.evaluate(judge, 'carriers', {})) == 23 and not failures())
for name, path, mutate, want in [
    ('empty legs', 'page/client-carrier.json', lambda x: x.update(legs={}), 'streaming-legs'),
    ('page not ended', 'page/client-carrier.json', lambda x: x['legs']['auto'].update(ended=False), 'streaming-legs'),
    ('failed negative test', 'page/client-carrier.json', lambda x: x['checks'][3].update(passed=False), 'gating-checks'),
    ('missing CDP check', 'page/client-carrier.json', lambda x: x.update(checks=[c for c in x['checks'] if c['id'] != 'browser-version']), 'gating-checks'),
    ('missing renderer check', 'page/client-carrier.json', lambda x: x.update(checks=x['checks'][:-1]), 'gating-checks'),
    ('host never listened', 'host.json', lambda x: x.update(listened=False), 'host-listened'),
    ('host crash', 'host.json', lambda x: x.update(exit_code=139), 'host-exit'),
    ('early termination', 'host.json', lambda x: x.update(exit_code=1, terminated_after_drain=True, tap_before_termination=True, drain_s=119), 'host-exit'),
    ('missing WT', 'host/evidence/live-carriers.json', lambda x: x.update(carriers=[{'name': 'ws'}]), 'carrier-names'),
]:
    fixture()
    file = judge / 'default' / path
    value = json.loads(file.read_text()); mutate(value); put(file, value)
    check(name, failures() == ['default/' + want])
for name in names['default']:
    for mutation in ('missing', 'different bytes', 'wrong carrier'):
        fixture()
        i = names['default'].index(name)
        tap = judge / f'default/host/tap/stream-{i}.rs2'
        if mutation == 'missing': tap.unlink()
        elif mutation == 'different bytes': tap.write_bytes(b'wrong bytes')
        else: tap.with_name(f'live-{i}.jsonl').write_text('{"carrier":"other"}')
        check(f'{name}: {mutation} tap refused', failures() == ['default/tap-files'])
fixture()
(judge / 'default/page/exit-code.txt').write_text('1')
check('page failure refused', failures() == ['default/page-exit'])
fixture()
put(judge / 'default/host.json', {'listened': True, 'exit_code': 1, 'terminated_after_drain': True,
                               'tap_before_termination': True, 'drain_s': 120})
check('Windows drain bound retained', not failures())

# Every invocation must enforce byte equality, browser checks and its dedicated gate.
for invocation in ('late', 'wss'):
    for missing in ('browser-version', 'browser-provenance', 'late-join' if invocation == 'late' else 'wss-tls'):
        fixture()
        path = judge / invocation / 'page/client-carrier.json'
        report = json.loads(path.read_text())
        report['checks'] = [c for c in report['checks'] if c['id'] != missing]
        put(path, report)
        check(f'{invocation}: missing {missing} refused', failures() == [invocation + '/gating-checks'])
    for name in names[invocation]:
        fixture()
        (judge / invocation / f'page/recording-{name}.rs13').write_bytes(b'wrong recording')
        check(f'{name}: different tap refused', failures() == [invocation + '/tap-files'])
    fixture()
    shutil.rmtree(judge / invocation)
    check(f'{invocation}: absent invocation refused', bool(failures()))
for field, value, want in [('tls', 'none', 'wss-tls'), ('cert_sha256', 'b' * 64, 'wss-tls')]:
    fixture()
    path = judge / 'wss/host/evidence/live-carriers.json'
    report = json.loads(path.read_text()); report['carriers'][0][field] = value; put(path, report)
    check(f'wss: wrong {field} refused', failures() == ['wss/' + want])
fixture()
put(judge / 'wss/host.json', {'listened': True, 'exit_code': 0})
check('wss: absent openssl evidence refused', failures() == ['wss/openssl'])

# Never contact the network: missing pins must still fail before urlopen.
for arch in cft.PINS:
    check(arch + ': measured archive and executable pins', all(len(cft.PINS[arch][k]) == 64 and
          all(c in '0123456789abcdef' for c in cft.PINS[arch][k]) for k in ('zip_sha256', 'exe_sha256')))
    check(arch + ': fetcher and harness pins agree', cft.PINS[arch]['exe_sha256'] == harness_pins['arm64' if arch == 'arm64' else 'x64'])
    with patch.dict(cft.PINS, {arch: {**cft.PINS[arch], 'zip_sha256': 'UNMEASURED'}}), patch.object(cft.urllib.request, 'urlopen', side_effect=AssertionError('network called')), contextlib.redirect_stdout(io.StringIO()):
        try: cft.fetch(root / 'never-created', arch)
        except ValueError as exc: check(arch + ': missing digest fails before download', 'unmeasured macOS CfT' in str(exc))
        else: check(arch + ': missing digest fails before download', False)
check('fail-closed fetch creates no output', not (root / 'never-created').exists())

# Exercise both digest guards and ditto extraction with a tiny local synthetic zip.
for arch in cft.PINS:
    pin, url, inner = cft.release(arch)
    check(arch + ': exact official CfT URL', url == f'https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.96/{pin["platform"]}/chrome-{pin["platform"]}.zip')
    archive = root / f'{arch}.zip'
    payload = b'synthetic pinned Chrome'
    with zipfile.ZipFile(archive, 'w') as zipped: zipped.writestr(inner, payload)
    measured = {**pin, 'zip_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'exe_sha256': hashlib.sha256(payload).hexdigest()}
    for variant in ('zip', 'exe', 'ok'):
        pins = dict(measured)
        if variant != 'ok': pins[variant + '_sha256'] = '0' * 64
        destination = root / f'fetch-{arch}-{variant}'
        extracted = []
        def extract(argv, **kwargs):
            extracted.append(argv)
            with zipfile.ZipFile(argv[3]) as zipped: zipped.extractall(argv[4])
        with patch.dict(cft.PINS, {arch: pins}), patch.object(cft.urllib.request, 'urlopen', side_effect=lambda *a, **kw: archive.open('rb')), patch.object(cft.subprocess, 'run', side_effect=extract), contextlib.redirect_stdout(io.StringIO()):
            try: exe = cft.fetch(destination, arch)
            except ValueError as exc:
                check(f'{arch}: {variant} mismatch prevents extraction', variant != 'ok' and str(exc) == variant + '_sha256 mismatch' and not extracted)
            else:
                check(f'{arch}: verified app extracted with ditto', variant == 'ok' and exe.read_bytes() == payload and bool(exe.stat().st_mode & 0o111) and extracted[0][:3] == ['/usr/bin/ditto', '-x', '-k'])

# Native attachment restores template mode, requires both dylibs and refuses a foreign slice.
base = root / 'native'
base.mkdir()
(base / 'host').write_bytes(b'host')
(base / 'host').chmod(0o644)
(base / 'ext').mkdir()
native = base / 'native'; native.mkdir()
for name in ('librender_stream_capture.dylib', 'librender_stream_net.dylib'): (native / name).write_bytes(name.encode())
config = {'target': 'macos', 'arch': 'arm64', 'template': 'host', 'template_sha256': hashlib.sha256(b'host').hexdigest(), 'extension': 'ext/capture.gdextension'}
with patch.object(driver.platform, 'system', return_value='Darwin'), patch.object(driver.platform, 'machine', return_value='arm64'):
    driver.attach_native(base, config, native)
    check('attaches capture and net dylibs and restores template execution', len(list((base / 'ext').glob('*.dylib'))) == 2 and (base / 'host').stat().st_mode & 0o111)
    try: driver.attach_native(base, {**config, 'arch': 'x86_64'}, native)
    except ValueError as exc: check('foreign slice refused', 'matching native macOS slice' in str(exc))
    else: check('foreign slice refused', False)
    try: driver.attach_native(base, {**config, 'template_sha256': '0' * 64}, native)
    except ValueError as exc: check('template mismatch refused', 'template sha256' in str(exc))
    else: check('template mismatch refused', False)

# Missing hosted inputs must still yield a failing row for the merge's five-shard census.
missing = root / 'missing'
with patch.object(sys, 'argv', ['mlive', '--config', str(missing / 'absent.json'), '--repo', str(root), '--native-bundle', str(native), '--out', str(missing), '--label', 'macos-live-arm64']), contextlib.redirect_stdout(io.StringIO()):
    rc = driver.main()
summary = json.loads((missing / 'validate-summary.json').read_text())
check('missing bundle preserves failing validation summary', rc == 1 and summary['failed'] == 1 and summary['runs'][0]['id'] == 'macos' and summary['runs'][0]['failing'] == ['macos-live-arm64:launch'])

# Prepare the real fixture tree with mocked editor/core builds; check both slice configs.
prepared = root / 'prepared'
m1 = prepared / 'm1'; m1.mkdir(parents=True)
(m1 / 'host').write_bytes(b'universal-host')
for arch in ('arm64', 'x86_64'):
    put(m1 / f'm1-{arch}.json', {'target': 'macos', 'arch': arch, 'template': 'host', 'template_sha256': hashlib.sha256(b'universal-host').hexdigest(), 'extension': 'ext/capture.gdextension', 'record': f'calibration/{arch}/record.json'})
def build(argv, **kwargs):
    if '--import' in argv:
        cache = Path(argv[argv.index('--path') + 1]) / '.godot'
        cache.mkdir(); (cache / 'imported').write_text('cache')
    else:
        core = Path(argv[-1]); core.mkdir(); (core / 'build.json').write_text('{}')
with patch.object(sys, 'argv', ['mlive-bundle', '--out', str(prepared)]), patch.object(bundle.subprocess, 'run', side_effect=build), contextlib.redirect_stdout(io.StringIO()):
    rc = bundle.main()
configs = [json.loads((prepared / f'mlive/mlive-{arch}.json').read_text()) for arch in ('arm64', 'x86_64')]
check('bundle prepares both native configs and shared imported fixture/core', rc == 0 and [c['arch'] for c in configs] == ['arm64', 'x86_64'] and all(c['template'] == '../m1/host' and c['fixture'] == 'fixtures/tag-scene' for c in configs) and (prepared / 'mlive/imports/tag-scene/imported').is_file() and (prepared / 'mlive/core/build.json').is_file())
check('bundle includes driver and fail-closed fetcher', all((prepared / 'mlive' / name).is_file() for name in ('mlive-driver.py', 'fetch-cft-macos.py')))
# Exercise the actual default host/page launch path without starting external processes.
launch_base = root / 'launch'
(launch_base / 'fixture').mkdir(parents=True)
(launch_base / 'import').mkdir()
launch_config = {'fixture': 'fixture', 'import_cache': 'import', 'template': 'stock-host',
                 'extension': 'ext/capture.gdextension', 'record': 'arm64-record.json'}
observed = {'starts': 0}
class Host:
    returncode = 0
    finished = False
    def poll(self): return 0 if self.finished else None
    def wait(self, timeout): observed['wait_s'] = timeout; self.finished = True; return 0
    def terminate(self): observed['terminated'] = True

def start(argv, **kwargs):
    observed.update(host_argv=argv, host_env=kwargs['env'], starts=observed['starts'] + 1)
    evidence = Path(kwargs['env']['GRC_EVIDENCE_DIR'])
    put(evidence / 'live.json', {'status': 'listening'})
    (evidence / 'live-cert-sha256').write_text('a' * 64)
    return Host()

def page(argv, **kwargs):
    observed.update(page_argv=argv, page_env=kwargs['env'])
    return subprocess.CompletedProcess(argv, 0)
artifact = root / 'launch-artifact'
with patch.object(driver.subprocess, 'Popen', side_effect=start), patch.object(driver.subprocess, 'run', side_effect=page), patch.object(driver.shutil, 'which', return_value='/mock/pnpm'), patch.dict(driver.os.environ, {'GRC_MODE': 'bad', 'RS_FIXTURE_ARM': 'bad', 'RS_PINNED_CHROMIUM_EXE': '/bad/chrome', 'DISPLAY': ':99', 'WAYLAND_DISPLAY': 'bad'}), contextlib.redirect_stdout(io.StringIO()):
    driver.run_invocation(launch_base, launch_config, root, artifact, 'default', Path('/pinned/chrome'))
check('host starts once, headless at 60 fps using stock template', observed['starts'] == 1 and observed['host_argv'][:5] == [str(launch_base / 'stock-host'), '--headless', '--max-fps', '60', '--path'])
check('host env uses both carriers and four-connection cap', observed['host_env']['GRC_LIVE_CARRIERS'] == 'ws,wt' and observed['host_env']['GRC_LIVE_MAX_CONNECTIONS'] == '4' and observed['host_env']['RS_FIXTURE_ARM'] == 'late' and 'DISPLAY' not in observed['host_env'] and 'WAYLAND_DISPLAY' not in observed['host_env'])
check('page uses source conditions and explicit pinned executable', '--conditions=development' in observed['page_argv'] and observed['page_env']['RS_PINNED_CHROMIUM_EXE'] == '/pinned/chrome' and not any(k.startswith('GRC_') for k in observed['page_env']))
check('page gets matching host and tap evidence paths', observed['page_argv'][observed['page_argv'].index('--evidence') + 1] == str(artifact / 'host/evidence') and observed['page_argv'][observed['page_argv'].index('--tap') + 1] == str(artifact / 'host/tap'))
check('launch retains exit, listening and 120-second drain evidence', (artifact / 'page/exit-code.txt').read_text() == '0' and json.loads((artifact / 'host.json').read_text())['listened'] and observed['wait_s'] == 120)

# Late join and wss each use their own host; keys never enter the artifact tree.
for scenario in ('late', 'wss', 'wss-page-error', 'wss-host-error', 'wss-openssl-error'):
    invocation = 'late' if scenario == 'late' else 'wss'
    artifact = root / scenario
    observed = {'starts': 0}
    secrets = []
    def tls_output(argv, **kwargs):
        if argv[1] == 'version': return 'OpenSSL synthetic'
        if argv[1] == 'pkey': return b'synthetic-spki'
        return b'synthetic-leaf' if '-pubkey' not in argv else b'synthetic-pubkey'
    def tls_page(argv, **kwargs):
        if argv[1] == 'req':
            key = Path(argv[argv.index('-keyout') + 1]); secrets.append(key)
            key.write_bytes(b'per-run-secret')
            Path(argv[argv.index('-out') + 1]).write_bytes(b'certificate')
            observed['tls_config'] = Path(argv[argv.index('-config') + 1]).read_text()
            if scenario == 'wss-openssl-error': raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0)
        if scenario == 'wss-page-error': raise subprocess.TimeoutExpired(argv, 210)
        return page(argv, **kwargs)
    def tls_start(argv, **kwargs):
        if invocation == 'wss':
            observed['key_present_at_start'] = Path(kwargs['env']['GRC_LIVE_TLS_KEY']).read_bytes() == b'per-run-secret'
        if scenario == 'wss-host-error': raise OSError('synthetic host launch error')
        return start(argv, **kwargs)
    with patch.object(driver.subprocess, 'Popen', side_effect=tls_start), patch.object(driver.subprocess, 'run', side_effect=tls_page), patch.object(driver.subprocess, 'check_output', side_effect=tls_output), patch.object(driver, 'openssl_path', return_value='/mock/openssl'), patch.object(driver.shutil, 'which', return_value='/mock/pnpm'), contextlib.redirect_stdout(io.StringIO()):
        driver.run_invocation(launch_base, launch_config, root, artifact, invocation, Path('/pinned/chrome'))
    obs = json.loads((artifact / 'host.json').read_text())
    if invocation == 'late':
        argv = observed['page_argv']
        check('late join starts a separate capped host and waits for 30 applied transactions', observed['starts'] == 1 and
              argv[argv.index('--legs') + 1] == 'late' and argv[argv.index('--late-join') + 1] == '30' and observed['host_env']['GRC_LIVE_MAX_CONNECTIONS'] == '4')
        continue
    check(scenario + ': private key stays outside uploaded artifacts and is removed', bool(secrets) and
          all(not p.is_relative_to(artifact) and not p.exists() and not p.parent.exists() for p in secrets) and
          not any(p.suffix == '.pem' or (p.is_file() and b'per-run-secret' in p.read_bytes()) for p in artifact.rglob('*')))
    if scenario != 'wss':
        check(scenario + ': failure retains observation', 'error' in obs)
        continue
    argv = observed['page_argv']
    import base64
    check('wss pins the per-run SPKI with the checker opt-in', argv[argv.index('--legs') + 1] == 'wss' and
          argv[argv.index('--wss') + 1].startswith('wss://127.0.0.1:') and
          argv[argv.index('--wss-spki') + 1] == base64.b64encode(hashlib.sha256(b'synthetic-spki').digest()).decode('ascii'))
    check('wss host uses only ws and sees its private key', observed['host_env']['GRC_LIVE_CARRIERS'] == 'ws' and observed['key_present_at_start'])
    check('wss leaf evidence and SAN config match the per-run certificate',
          (artifact / 'host/evidence/wss-cert-sha256').read_text() == hashlib.sha256(b'synthetic-leaf').hexdigest() and
          'subjectAltName=DNS:localhost,IP:127.0.0.1' in observed['tls_config'] and obs['openssl_ok'])

# The hosted entry point must run all three invocations with the verified browser.
calls = []
with patch.object(driver, 'attach_native'), patch.object(cft, 'fetch', return_value=Path('/pinned/chrome')), patch.object(driver.importlib.util, 'module_from_spec', return_value=cft), patch.object(driver.importlib.machinery.SourceFileLoader, 'exec_module'), patch.object(driver, 'run_invocation', side_effect=lambda *args: calls.append(args)):
    driver.launch(root / 'mlive-arm64.json', {'arch': 'arm64'}, root, root, native)
check('hosted launch runs default, late and wss separately', [c[4] for c in calls] == ['default', 'late', 'wss'] and
      [c[3].name for c in calls] == ['default', 'late', 'wss'] and all(c[5] == Path('/pinned/chrome') for c in calls))

print(json.dumps(results))
`,
      fileURLToPath(new URL("..", import.meta.url)),
      root,
      JSON.stringify(EXPECTED_CHROMIUM_SHA256_MACOS),
    ],
    { encoding: "utf8" },
  );
  if (judge.status !== 0) console.error(judge.stderr);
  check(
    "driver, fetcher and bundle synthetic tests executed",
    judge.status === 0,
  );
  if (judge.status === 0)
    for (const [name, ok] of JSON.parse(judge.stdout) as [string, boolean][])
      check(name, ok);
} finally {
  removeSelfTestTempDir(root);
}
console.log(`self-test-mlive-driver: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
