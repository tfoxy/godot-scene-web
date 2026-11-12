#!/usr/bin/env python3
"""Launch and judge portable live capture legs against the existing client checker (stdlib)."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time

LEGS = ('carriers', 'wss')


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def text(path):
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return ''


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def evaluate(directory, leg, config):
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    invocations = ['default', 'late'] if leg == 'carriers' else ['wss']
    for invocation in invocations:
        run = directory / invocation
        prefix = invocation + '/'
        obs = read_json(run / 'host.json', {})
        report = read_json(run / 'page/client-carrier.json', {})
        expected = {'default': ['ws', 'auto', 'auto-wrong-hash', 'auto-no-wt'],
                    'late': ['ws', 'ws-late'], 'wss': ['wss']}[invocation]
        legs = report.get('legs', {})
        check(prefix + 'streaming-legs', isinstance(legs, dict) and sorted(legs) == sorted(expected)
              and all(isinstance(r, dict) and r.get('ended') is True and r.get('applied', 0) > 0
                      for r in legs.values()), json.dumps(legs))
        table = report.get('checks', [])
        required = {'streams-ended', 'recording-equals-tap', 'page-is-package-only'}
        required |= {'default': {'sabotage-wrong-hash', 'sabotage-wrong-token', 'auto-fallbacks', 'ws-wt-same-pixels'},
                     'late': {'late-join'}, 'wss': {'wss-tls'}}[invocation]
        check(prefix + 'gating-checks', isinstance(table, list) and required.issubset({c.get('id') for c in table})
              and all(c.get('passed') is True for c in table), json.dumps(table))
        check(prefix + 'page-exit', text(run / 'page/exit-code.txt').strip() == '0', text(run / 'page/exit-code.txt').strip())
        check(prefix + 'host-listened', obs.get('listened') is True, json.dumps(obs))
        check(prefix + 'host-exit', obs.get('exit_code') == 0 or
              (obs.get('terminated_after_drain') is True and obs.get('tap_before_termination') is True
               and obs.get('drain_s', 0) >= 120), json.dumps(obs))
        carriers = read_json(run / 'host/evidence/live-carriers.json', {}).get('carriers', [])
        want = {'ws'} if invocation == 'wss' else {'ws', 'wt'}
        check(prefix + 'carrier-names', {c.get('name') for c in carriers} == want, json.dumps(carriers))
        if invocation == 'wss':
            ws = next((c for c in carriers if c.get('name') == 'ws'), {})
            leaf = text(run / 'host/evidence/wss-cert-sha256').strip()
            check(prefix + 'wss-tls', ws.get('tls') == 'consumer' and len(leaf) == 64
                  and ws.get('cert_sha256') == leaf, json.dumps(ws))
            check(prefix + 'openssl', obs.get('openssl_ok') is True, obs.get('openssl', 'missing'))
        # Check actual files against every page, not only the checker's aggregate boolean.
        taps = list((run / 'host/tap').glob('stream-*.rs2'))
        matches = []
        for name in expected:
            recording = run / f'page/recording-{name}.rs13'
            carrier = 'wt' if name == 'auto' else 'ws'
            matches.append(recording.is_file() and recording.stat().st_size > 8 and any(
                p.read_bytes() == recording.read_bytes() and
                f'"carrier":"{carrier}"' in text(p.with_name('live-' + p.stem.split('-')[1] + '.jsonl'))
                for p in taps))
        check(prefix + 'tap-files', bool(taps) and all(matches), f'{len(taps)} taps; per-page matches={matches}')
    return checks


def pick_port(udp=False):
    for _ in range(8):
        with socket.socket() as tcp:
            tcp.bind(('127.0.0.1', 0))
            port = tcp.getsockname()[1]
            if not udp:
                return port
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.bind(('127.0.0.1', port))
                return port
            except OSError:
                pass
    raise ValueError('no free TCP+UDP port in eight attempts')


def openssl_path():
    candidate = (Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Git/usr/bin/openssl.exe'
                 if os.name == 'nt' else shutil.which('openssl'))
    if not candidate or not Path(candidate).is_file():
        raise ValueError('openssl: missing explicitly resolved executable')
    return str(candidate)


def run_invocation(base, config, repo, directory, invocation, browser):
    directory.mkdir(parents=True)
    host = directory / 'host'
    evidence = host / 'evidence'
    evidence.mkdir(parents=True)
    tap = host / 'tap'
    tap.mkdir()
    page = directory / 'page'
    page.mkdir()
    project = directory / 'project'
    shutil.copytree(base / config['fixture'], project, ignore=shutil.ignore_patterns('.godot'))
    shutil.copytree(base / config['import'], project / '.godot')
    user = directory / 'user'
    user.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    if os.name == 'nt':
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
        env.update(APPDATA=str(user), LOCALAPPDATA=str(user))
    else:
        env.update({k: str(user / k) for k in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME')})
    port, page_port = pick_port(True), pick_port()
    while page_port == port:
        page_port = pick_port()
    observation = {'ports': {'live_tcp_udp': port, 'page_tcp': page_port}, 'listened': False}
    print('wlive ports: ' + json.dumps(observation['ports']), flush=True)
    env.update(GRC_EXTENSION=str(base / config['extension']), GRC_CALIBRATION=str(base / config['record']),
               GRC_MODE='arm', GRC_EVIDENCE_DIR=str(evidence), GRC_STREAM_VERSION='13',
               GRC_ROOT_SIZE='presentation:640x360', GRC_ADOPT='arm', GRC_UNKNOWN_ITEM='skip',
               RS_FIXTURE_ARM='late', RS_FIXTURE_QUIT_FRAME='1500', RS_FIXTURE_TAG_START='60',
               GRC_LIVE_LISTEN=f'127.0.0.1:{port}', GRC_LIVE_CARRIERS='ws' if invocation == 'wss' else 'ws,wt',
               GRC_LIVE_AUTH='token', GRC_LIVE_TAP_DIR=str(tap), GRC_LIVE_MAX_CONNECTIONS='4',
               GRC_LIVE_AWAIT_HELLO_MS='60000', GRC_LIVE_ALLOWED_ORIGINS=f'http://127.0.0.1:{page_port}')
    # Keep private TLS material outside the uploaded evidence even if the driver is killed.
    tls_directory = tempfile.TemporaryDirectory(prefix='wlive-tls-')
    key = Path(tls_directory.name) / 'key.pem'
    process = None
    try:
        extra = []
        if invocation == 'wss':
            openssl = openssl_path()
            version = subprocess.check_output([openssl, 'version'], text=True).strip()
            observation.update(openssl_ok=True, openssl=openssl + ': ' + version)
            print('wlive openssl: ' + observation['openssl'], flush=True)
            cert = Path(tls_directory.name) / 'cert.pem'
            with (directory / 'openssl.log').open('wb') as log:
                subprocess.run([openssl, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                                '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '2', '-subj', '/CN=localhost',
                                '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], stdout=log, stderr=log, check=True)
            der = subprocess.check_output([openssl, 'x509', '-in', str(cert), '-outform', 'der'])
            (evidence / 'wss-cert-sha256').write_text(hashlib.sha256(der).hexdigest(), encoding='utf-8')
            pub = subprocess.check_output([openssl, 'x509', '-in', str(cert), '-pubkey', '-noout'])
            spki = subprocess.check_output([openssl, 'pkey', '-pubin', '-outform', 'der'], input=pub)
            import base64
            extra = ['--legs', 'wss', '--wss', f'wss://127.0.0.1:{port}/render-stream',
                     '--wss-spki', base64.b64encode(hashlib.sha256(spki).digest()).decode('ascii')]
            env.update(GRC_LIVE_TLS_CERT=str(cert), GRC_LIVE_TLS_KEY=str(key))
        elif invocation == 'late':
            extra = ['--legs', 'late', '--late-join', '30']
        with (host / 'stdout.log').open('wb') as stdout:
            process = subprocess.Popen([str(base / config['template']), '--headless', '--max-fps', '60', '--path', str(project)],
                                       env=env, stdout=stdout, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                listening = read_json(evidence / 'live.json', {}).get('status') == 'listening'
                if listening and (invocation == 'wss' or bool(text(evidence / 'live-cert-sha256').strip())):
                    observation['listened'] = True
                    break
                time.sleep(0.05)
            if not observation['listened']:
                raise ValueError('host-listened: host never listened')
            page_env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
            if browser:
                page_env['RS_PINNED_CHROMIUM_EXE'] = str(browser)
            pnpm = shutil.which('pnpm')
            if not pnpm:
                raise ValueError('page-exit: pnpm missing')
            argv = [pnpm, 'exec', 'tsx', '--conditions=development',
                    str(repo / 'experiments/render-stream/scripts/client-carrier-check.ts'),
                    '--dir', str(page), '--port', str(page_port), '--ws', f'ws://127.0.0.1:{port}/render-stream',
                    '--http', f'http://127.0.0.1:{port}', '--wt', f'https://127.0.0.1:{port}/render-stream',
                    '--evidence', str(evidence), '--tap', str(tap), '--core', str(base / 'core'), *extra]
            print('wlive page argv: ' + json.dumps(argv), flush=True)
            with (page / 'stdout.log').open('wb') as log:
                result = subprocess.run(argv, cwd=repo, env=page_env, stdout=log, stderr=subprocess.STDOUT, timeout=210)
            (page / 'exit-code.txt').write_text(str(result.returncode), encoding='utf-8')
            start = time.monotonic()
            try:
                process.wait(timeout=120)
            except subprocess.TimeoutExpired:
                observation.update(terminated_after_drain=True, tap_before_termination=any(tap.glob('stream-*.rs2')))
                process.terminate()
                process.wait(timeout=10)
            observation.update(drain_s=round(time.monotonic() - start, 3), exit_code=process.returncode)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        observation['error'] = str(exc)
        print('FAIL ' + str(exc), flush=True)
    finally:
        # Teardown can itself time out; remove the key before any process cleanup can raise.
        key.unlink(missing_ok=True)
        tls_directory.cleanup()
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        write_json(directory / 'host.json', observation)
        print(text(page / 'stdout.log'), flush=True)
        lines = text(host / 'stdout.log').splitlines()
        print('\n'.join(line for line in lines if '[grc]' in line), flush=True)
        if observation.get('error'):
            print('host last 200 lines:\n' + '\n'.join(lines[-200:]), flush=True)
            print('tap listing: ' + json.dumps([p.name for p in tap.iterdir()]), flush=True)


def launch(config_path, config, leg, repo):
    base = config_path.resolve().parent
    directory = Path(os.environ.get('W_RUN_ARTIFACT_DIR', str(base / 'runs' / leg))).resolve()
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    binary = base / config['template']
    if hashlib.sha256(binary.read_bytes()).hexdigest() != config['template_sha256']:
        raise ValueError('template sha256 differs from pin')
    with tempfile.TemporaryDirectory(prefix='wlive-cft-') as temp:
        browser = None
        if os.name == 'nt':
            spec = importlib.util.spec_from_file_location('cft', base / 'fetch-cft-windows.py')
            cft = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cft)
            browser = cft.fetch(Path(temp))
            cft.probe(browser, base / 'wlive-probe.html', directory)
            write_json(directory / 'cft-pins.json', {'zip_sha256': cft.EXPECTED_ZIP_SHA256,
                       'exe_sha256': cft.EXPECTED_EXE_SHA256, 'version': cft.VERSION})
            if read_json(directory / 'probe-result.json', {}).get('variant') != 'cdp-swiftshader':
                raise ValueError('hosted probe no longer passes fixed cdp-swiftshader variant')
        for invocation in (['default', 'late'] if leg == 'carriers' else ['wss']):
            run_invocation(base, config, repo, directory / invocation, invocation, browser)
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--leg', required=True, choices=LEGS)
    parser.add_argument('--repo', type=Path, default=os.environ.get('WLIVE_REPO_ROOT'))
    parser.add_argument('--evaluate-only', type=Path)
    args = parser.parse_args()
    config = read_json(args.config)
    if not config or (not args.evaluate_only and not args.repo):
        print('FAIL config: config and --repo (or WLIVE_REPO_ROOT) required')
        return 1
    print(f'wlive: Python {platform.python_version()} OS {platform.platform()}', flush=True)
    try:
        directory = args.evaluate_only or launch(args.config, config, args.leg, args.repo.resolve())
        checks = evaluate(directory, args.leg, config)
    except (OSError, ValueError, KeyError) as exc:
        print('FAIL launch: ' + str(exc), flush=True)
        return 1
    for name, ok, detail in checks:
        print(f'{"ok" if ok else "FAIL"} {name}: {detail}', flush=True)
    failed = sum(not ok for _, ok, _ in checks)
    summary = {'leg': args.leg, 'checks': checks, 'passed': len(checks) - failed, 'failed': failed,
               'invocations': {name: read_json(p / 'page/client-carrier-summary.json')
                               for name in ('default', 'late', 'wss') if (p := directory / name).is_dir()}}
    write_json(directory / 'wlive-summary.json', summary)
    if failed:
        for log in directory.glob('*/host/stdout.log'):
            print(str(log) + ' last 200 lines:\n' + '\n'.join(text(log).splitlines()[-200:]))
        print('tap listing: ' + json.dumps([str(p.relative_to(directory)) for p in directory.glob('*/host/tap/*')]))
    print(f'wlive-{args.leg}: {len(checks) - failed} passed, {failed} failed', flush=True)
    return int(failed != 0)


if __name__ == '__main__':
    sys.exit(main())
