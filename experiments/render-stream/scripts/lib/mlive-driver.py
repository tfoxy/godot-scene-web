#!/usr/bin/env python3
"""Launch and judge native macOS live capture against the existing client checker (stdlib)."""
import argparse
import base64
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
import zipfile

INVOCATIONS = ('default', 'late', 'wss')


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

    for invocation in INVOCATIONS:
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
        required |= {'browser-version', 'browser-provenance'}
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
    candidate = shutil.which('openssl')
    if not candidate or not Path(candidate).is_file():
        raise ValueError('openssl: missing explicitly resolved executable')
    return candidate


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
    shutil.copytree(base / config['import_cache'], project / '.godot')
    user = directory / 'user'
    user.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_'))}
    env.pop('DISPLAY', None)
    env.pop('WAYLAND_DISPLAY', None)
    env.update({k: str(user / k) for k in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME')})
    port, page_port = pick_port(True), pick_port()
    while page_port == port:
        page_port = pick_port()
    observation = {'ports': {'live_tcp_udp': port, 'page_tcp': page_port}, 'listened': False}
    print('mlive ports: ' + json.dumps(observation['ports']), flush=True)
    env.update(GRC_EXTENSION=str(base / config['extension']), GRC_CALIBRATION=str(base / config['record']),
               GRC_MODE='arm', GRC_EVIDENCE_DIR=str(evidence), GRC_STREAM_VERSION='13',
               GRC_ROOT_SIZE='presentation:640x360', GRC_ADOPT='arm', GRC_UNKNOWN_ITEM='skip',
               RS_FIXTURE_ARM='late', RS_FIXTURE_QUIT_FRAME='1500', RS_FIXTURE_TAG_START='60',
               GRC_LIVE_LISTEN=f'127.0.0.1:{port}', GRC_LIVE_CARRIERS='ws' if invocation == 'wss' else 'ws,wt',
               GRC_LIVE_AUTH='token', GRC_LIVE_TAP_DIR=str(tap), GRC_LIVE_MAX_CONNECTIONS='4',
               GRC_LIVE_AWAIT_HELLO_MS='60000', GRC_LIVE_ALLOWED_ORIGINS=f'http://127.0.0.1:{page_port}')
    # Keys stay outside the uploaded evidence even if this driver is killed.
    tls_directory = tempfile.TemporaryDirectory(prefix='mlive-tls-')
    key = Path(tls_directory.name) / 'key.pem'
    process = None
    try:
        extra = []
        if invocation == 'wss':
            openssl = openssl_path()
            version = subprocess.check_output([openssl, 'version'], text=True).strip()
            observation.update(openssl_ok=True, openssl=openssl + ': ' + version)
            cert = Path(tls_directory.name) / 'cert.pem'
            # A config works with both macOS LibreSSL and OpenSSL; -addext is not universal.
            tls_config = Path(tls_directory.name) / 'openssl.cnf'
            tls_config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=extensions\n'
                                  '[dn]\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
                                  encoding='utf-8')
            with (directory / 'openssl.log').open('wb') as log:
                subprocess.run([openssl, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                                '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '2', '-subj', '/CN=localhost',
                                '-config', str(tls_config)], stdout=log, stderr=log, check=True)
            der = subprocess.check_output([openssl, 'x509', '-in', str(cert), '-outform', 'der'])
            (evidence / 'wss-cert-sha256').write_text(hashlib.sha256(der).hexdigest(), encoding='utf-8')
            pub = subprocess.check_output([openssl, 'x509', '-in', str(cert), '-pubkey', '-noout'])
            spki = subprocess.check_output([openssl, 'pkey', '-pubin', '-outform', 'der'], input=pub)
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
            print('mlive page argv: ' + json.dumps(argv), flush=True)
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
        # Remove the key before any host cleanup that could itself raise or time out.
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


def attach_native(base, config, native):
    if config['target'] != 'macos' or config['arch'] != platform.machine() or platform.system() != 'Darwin':
        raise ValueError('mlive requires the matching native macOS slice; no Rosetta fallback')
    binary = base / config['template']
    if hashlib.sha256(binary.read_bytes()).hexdigest() != config['template_sha256']:
        raise ValueError('template sha256 differs from pin')
    binary.chmod(0o755)  # Downloaded artifacts lose executable mode.
    ext = (base / config['extension']).parent
    for name in ('librender_stream_capture.dylib', 'librender_stream_net.dylib'):
        shutil.copy2(native / name, ext / name)


def launch(config_path, config, repo, directory, native):
    base = config_path.resolve().parent
    attach_native(base, config, native)
    spec = importlib.util.spec_from_file_location('cft', base / 'fetch-cft-macos.py')
    cft = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cft)
    with tempfile.TemporaryDirectory(prefix='mlive-cft-') as temp:
        browser = cft.fetch(Path(temp), config['arch'])
        write_json(directory / 'cft-pins.json', {'version': cft.VERSION, **cft.PINS[config['arch']]})
        for invocation in INVOCATIONS:
            run_invocation(base, config, repo, directory / invocation, invocation, browser)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--label', required=True)
    parser.add_argument('--repo', type=Path)
    parser.add_argument('--native-bundle', type=Path)
    parser.add_argument('--evaluate-only', action='store_true')
    args = parser.parse_args()
    if not args.evaluate_only and (not args.repo or not args.native_bundle):
        parser.error('--repo and --native-bundle required for launch')
    started = time.monotonic()
    directory = args.out.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    checks = []
    print(f'mlive: Python {platform.python_version()} OS {platform.platform()}', flush=True)
    try:
        config = read_json(args.config)
        if not config:
            raise ValueError('missing or invalid mlive config')
        if not args.evaluate_only:
            launch(args.config, config, args.repo.resolve(), directory, args.native_bundle.resolve())
        checks = evaluate(directory, 'carriers', config)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as exc:
        checks.append(('launch', False, str(exc)))
    for name, ok, detail in checks:
        print(f'{"ok" if ok else "FAIL"} {name}: {detail}', flush=True)
    failed = [name for name, ok, _ in checks if not ok]
    wall = round(time.monotonic() - started, 3)
    write_json(directory / 'mlive-summary.json', {'checks': checks, 'passed': len(checks) - len(failed),
               'failed': len(failed), 'wall_s': wall})
    row = {'id': 'macos', 'phase': 'setup', 'rc': str(int(bool(failed))), 'wall_s': wall,
           'lock_wait_s': 0, 'lock_hold_s': 0, 'lock': {}, 'lock_summaries': 0,
           'skipped_by_tier': 0, 'skipped_remote': [], 'skipped_remote_groups': [],
           'unavailable': [], 'known_flakes': [], 'failing': [args.label + ':' + name for name in failed]}
    write_json(directory / 'validate-summary.json', {'schema': 'render-stream-validate-summary/2',
               'partial': True, 'wall_s': wall, 'runs': [row], 'failed': int(bool(failed))})
    print(f'mlive-carriers: {len(checks) - len(failed)} passed, {len(failed)} failed, wall {wall} s', flush=True)
    return int(bool(failed))


if __name__ == '__main__':
    sys.exit(main())
