#!/usr/bin/env python3
"""Run and inspect portable headless file-sink capture legs."""
import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import time
from collections import Counter
import json
from pathlib import Path
import re
import struct
import sys


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def read_text(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def read_object(path):
    value = read_json(path)
    return value if isinstance(value, dict) else {}


def stream_status(result):
    stream = result.get("stream")
    return stream.get("status") if isinstance(stream, dict) else None


def load_config(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    table = config.get("legs")
    if isinstance(table, str):
        document = json.loads((path.parent / table).read_text(encoding="utf-8"))
        table = document["legs"]
        config["excluded"] = document.get("excluded", [])
    if not isinstance(table, list) or not table:
        raise ValueError("empty legs: refusing to compare nothing")
    seen = set()
    for leg in table:
        key = (leg["gate"], leg["path"])
        if key in seen:
            raise ValueError(f"duplicate leg {key}")
        seen.add(key)
        if any(word.split("=", 1)[0] == "GRC_DISARM_AFTER_FRAMES" for word in leg["env"]):
            raise ValueError(f"{key}: GRC_DISARM_AFTER_FRAMES is forbidden")
        if not leg["sinks"]:
            raise ValueError(f"{key}: empty sinks")
    config["legs"] = table
    return config


def framing(path, version):
    data = path.read_bytes()
    if data[:8] != f"GRS{version:x}\r\n\x1a\n".encode("ascii"):
        raise ValueError("bad-magic")
    pos, types, end = 8, [], None
    while pos < len(data):
        if pos + 4 > len(data):
            raise ValueError("truncated")
        size = struct.unpack_from("<I", data, pos)[0]
        limit = pos + 4 + size
        if size < 8 or limit > len(data):
            raise ValueError("truncated")
        meta_len = struct.unpack_from("<I", data, pos + 4)[0]
        cursor = pos + 8 + meta_len
        if cursor + 4 > limit:
            raise ValueError("truncated")
        meta = json.loads(data[pos + 8:cursor])
        if not isinstance(meta, dict) or not isinstance(meta.get("type"), str):
            raise ValueError("record-meta-type")
        blocks = struct.unpack_from("<I", data, cursor)[0]
        cursor += 4
        for _ in range(blocks):
            if cursor + 4 > limit:
                raise ValueError("truncated")
            length = struct.unpack_from("<I", data, cursor)[0]
            cursor += 4 + length
            if cursor > limit:
                raise ValueError("truncated")
        if cursor != limit:
            raise ValueError("record-length")
        types.append(meta.get("type"))
        end = meta
        pos = limit
    return {"records": len(types), "bytes": len(data), "types": dict(Counter(types)),
            "first": types[0] if types else None, "last": types[-1] if types else None,
            "stats": end.get("stats") if end else None}


def evaluate(directory, leg):
    checks, frames = [], {}
    def check(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
    stdout = read_text(directory / "stdout.txt")
    stderr = read_text(directory / "stderr.txt")
    check("exit-zero", read_text(directory / "exit-code.txt").strip() == "0", read_text(directory / "exit-code.txt").strip())
    quit_line = re.search(r"\[fixture\] quitting frame=(\d+)", stdout)
    check("fixture-quit", quit_line is not None, quit_line.group(0) if quit_line else "missing quit line")
    check("script-cache", "Could not load global script cache" not in stdout + stderr, "global script cache")
    check("extension-load", "extension load status=OK" in stdout, "extension load status=OK")
    result = read_object(directory / "evidence/result.json")
    check("armed", result.get("status") == "armed", str(result.get("status")))
    check("vptr-written", result.get("vptr_written") is True, str(result.get("vptr_written")))
    check("stream-closed", stream_status(result) == "closed", str(result.get("stream")))
    # Older runners name default /6 sinks .rs2; the env selects the wire version.
    version = next((int(w.split("=", 1)[1]) for w in reversed(leg["env"]) if w.startswith("GRC_STREAM_VERSION=")), 6)
    for sink in leg["sinks"]:
        path = directory / sink
        if not path.is_file():
            check("sink-present:" + sink, False, "missing sink")
            continue
        try:
            info = framing(path, version)
        except (OSError, ValueError, struct.error, UnicodeError) as exc:
            check("framing:" + sink, False, str(exc))
            continue
        frames[sink] = info
        check("framing:" + sink, True, json.dumps(info))
        check("first-session:" + sink, info["first"] == "session", str(info["first"]))
        check("last-end:" + sink, info["last"] == "end", str(info["last"]))
    if leg["store"]:
        check("store-index", (directory / "store/index.jsonl").is_file(), "store/index.jsonl")
    return checks, frames, quit_line.group(1) if quit_line else "-"


def evaluate_gate(root, config, gate):
    legs = [leg for leg in config["legs"] if leg["gate"] == gate]
    if not legs:
        raise ValueError(f"{gate}: empty legs")
    failed, rows = False, []
    for leg in legs:
        directory = root / gate / leg["path"]
        checks, frames, quit_frame = evaluate(directory, leg)
        for check in checks:
            print(f"{'ok' if check['ok'] else 'FAIL'} {check['name']}: {leg['path']}: {check['detail']}")
        bad = any(not c["ok"] for c in checks)
        failed |= bad
        result = read_object(directory / "evidence/result.json")
        observation = read_object(directory / "observation.json")
        rows.append(f"{leg['path']} | {read_text(directory / 'exit-code.txt').strip()} | {quit_frame} | "
                    f"{sum(f['records'] for f in frames.values())} | {sum(f['bytes'] for f in frames.values())} | "
                    f"{stream_status(result)} | {observation.get('wall_s', '-')} | {'FAIL' if bad else 'ok'}")
    print(f"{gate}: leg | exit | quit frame | records | bytes | stream status | wall s | result")
    print("\n".join(rows))
    return int(failed)


def invocation(base, config, leg, directory, project, sabotage=False):
    words = [f"GRC_EXTENSION={(base / config['extension']).resolve()}",
             f"GRC_CALIBRATION={(base / config['record']).resolve()}", "GRC_MODE=arm",
             f"GRC_EVIDENCE_DIR={directory / 'evidence'}", f"GRC_STREAM_OUT={directory / leg['sinks'][0]}",
             f"RS_FIXTURE_STEP_LOG={(directory / 'steps.jsonl').as_posix()}", "GRC_VALIDATION_LOG=on"]
    if leg['store']:
        words.append(f"GRC_RESOURCE_STORE_DIR={directory / 'store'}")
    if len(leg['sinks']) > 1:
        words.append(f"GRC_STREAM_PATCH_OUT={directory / leg['sinks'][1]}")
    if leg['quit'] is not None:
        words.append(f"RS_FIXTURE_QUIT_FRAME={leg['quit']}")
    for word in leg['env']:
        path = directory.as_posix() if word.startswith('RS_') else str(directory)
        words.append(word.replace('{leg}', path))
    if sabotage:
        words.append('GRC_TEXTURE_DECODE=off')
    argv = [str((base / config['template']).resolve()), '--headless', '--path', str(project)]
    if leg.get('scene'):
        argv.append(leg['scene'])
    return {'argv': argv, 'env': words}


def launch_gate(config_path, config, gate, rep, output, sabotage=False):
    base = config_path.parent
    legs = [leg for leg in config['legs'] if leg['gate'] == gate and (not sabotage or leg['path'] == 'capture')]
    if not legs:
        raise ValueError(f'{gate}: no selected capture legs')
    imported = base / 'imports' / legs[0]['fixture']
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob('*')):
        raise ValueError(f"missing or empty import {imported}: refusing to launch")
    start = time.monotonic()
    binary = (base / config['template']).resolve()
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    print(f"template sha256={digest}, hash time={time.monotonic() - start:.3f} s", flush=True)
    if digest != config['template_sha256']:
        raise ValueError('template sha256 differs from pin')
    gate_root = output / rep / gate
    if gate_root.exists():
        raise ValueError(f"output already exists: {gate_root}")
    gate_root.mkdir(parents=True)
    project = gate_root / '_project'
    shutil.copytree(base / 'fixtures' / legs[0]['fixture'], project, ignore=shutil.ignore_patterns('.godot'))
    shutil.copytree(imported, project / '.godot')
    try:
        for leg in legs:
            directory = gate_root / leg['path']
            (directory / 'evidence').mkdir(parents=True)
            user = directory / 'user'
            user.mkdir()
            env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('GRC_', 'RS_')) and k not in ('DISPLAY', 'WAYLAND_DISPLAY')}
            if os.name == 'nt':
                import ctypes
                ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
                env.update(APPDATA=str(user), LOCALAPPDATA=str(user))
            else:
                env.update({k: str(user / k) for k in ('XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME')})
            inv = invocation(base, config, leg, directory, project, sabotage)
            env.update(word.split('=', 1) for word in inv['env'])
            (directory / 'invocation.json').write_text(json.dumps(inv, indent=2) + '\n', encoding='utf-8')
            print('invocation: ' + json.dumps(inv), flush=True)
            first_seen, start = {}, time.monotonic()
            rc, timed_out = 1, False
            with (directory / 'stdout.txt').open('wb') as stdout, (directory / 'stderr.txt').open('wb') as stderr:
                try:
                    child = subprocess.Popen(inv['argv'], env=env, cwd=project, stdout=stdout, stderr=stderr)
                    while True:
                        alive = child.poll() is None
                        for sink in leg['sinks']:
                            if sink not in first_seen and (directory / sink).is_file():
                                first_seen[sink] = round(time.monotonic() - start, 3)
                        if not alive:
                            rc = child.returncode
                            break
                        if time.monotonic() - start >= config.get('timeout_s', 180):
                            timed_out = True
                            child.kill()
                            child.wait()
                            rc = 124
                            break
                        time.sleep(0.05)
                except OSError as exc:
                    stderr.write(str(exc).encode('utf-8'))
            (directory / 'exit-code.txt').write_text(str(rc) + '\n', encoding='utf-8')
            observation = {'wall_s': round(time.monotonic() - start, 3), 'first_seen': first_seen, 'timed_out': timed_out}
            (directory / 'observation.json').write_text(json.dumps(observation, indent=2) + '\n', encoding='utf-8')
            checks, frames, _ = evaluate(directory, leg)
            diagnostics(directory, project, inv, checks, frames)
            shutil.rmtree(user)
    finally:
        shutil.rmtree(project)
    subset = dict(config, legs=legs)
    return evaluate_gate(output / rep, subset, gate)


def diagnostics(directory, project, inv, checks, frames):
    rc = int(read_text(directory / "exit-code.txt").strip())
    code = rc & 0xffffffff
    names = {0xC0000005: "ACCESS_VIOLATION", 0xC0000409: "STACK_BUFFER_OVERRUN",
             0xC0000135: "DLL_NOT_FOUND", 0xC000007B: "INVALID_IMAGE_FORMAT"}
    print(f"exit decimal={rc} hex=0x{code:08X} {names.get(code, '')}; "
          f"observation={json.dumps(read_object(directory / 'observation.json'))}", flush=True)
    evidence = [p.relative_to(directory).as_posix() for p in (directory / "evidence").rglob("*") if p.is_file()]
    store = [p for p in (directory / "store").rglob("*") if p.is_file()]
    paths = [str(p) for p in directory.rglob("*")] + [str(p) for p in project.rglob("*")]
    paths += inv["argv"] + [w.split("=", 1)[1] for w in inv["env"]]
    longest = max(paths, key=len)
    print(f"evidence: {json.dumps(evidence)}; store files={len(store)} "
          f"bytes={sum(p.stat().st_size for p in store)}; longest path={len(longest)}: {longest}")
    for name in ("calibration-check.json", "result.json"):
        print(name + ": " + json.dumps(read_json(directory / "evidence" / name)))
    counters = read_object(directory / "evidence/counters.json")
    captured = counters.get("captured")
    if not isinstance(captured, dict):
        captured = {}
    print("counters summary: " + json.dumps({
        "counts": counters.get("counts"), "frames_total": counters.get("frames_total"),
        "validation_log": counters.get("validation_log"),
        "table_sizes": {k: len(v) for k, v in captured.items() if isinstance(v, list)}}))
    print("framing: " + json.dumps(frames), flush=True)
    failed = any(not c["ok"] for c in checks)
    for name in ("stdout.txt", "stderr.txt"):
        lines = read_text(directory / name).splitlines()
        for line in lines:
            if re.search(r"\[grc\]|\[fixture\]|ERROR|WARNING|Vulkan|OpenGL|D3D|rasteriz", line):
                print(name + ": " + line)
        if failed:
            print(name + " last 200 lines:\n" + "\n".join(lines[-200:]))
    if failed:
        for index, log in enumerate((directory / "user").rglob("godot.log")):
            print(str(log) + ":\n" + read_text(log))
            shutil.copyfile(log, directory / f"godot-{index}.log")


def check_runner(root, config_path, config, gate):
    base = config_path.parent
    root = root.resolve()
    errors, count = [], 0
    legs = [leg for leg in config['legs'] if leg['gate'] == gate]
    if not legs:
        raise ValueError(f'{gate}: empty legs')
    for leg in legs:
        directory = root / leg['path']
        inv = invocation(base, config, leg, directory, root / '_project')
        runner_argv = read_text(directory / 'argv.txt').splitlines()
        runner_words = [w for w in read_text(directory / 'env.txt').splitlines() if w and not w.startswith('#')]
        def normalize(words):
            out = []
            for word in words:
                key, value = word.split('=', 1)
                if key in ('GRC_EXTENSION', 'GRC_CALIBRATION'):
                    value = '$' + key
                else:
                    value = value.replace(str(root), '$OUT')
                out.append(key + '=' + value)
            return Counter(out)
        expected, actual = normalize(inv['env']), normalize(runner_words)
        for word, n in (actual - expected).items():
            errors.append(f"{leg['path']}: extra runner word {word} x{n}")
        for word, n in (expected - actual).items():
            errors.append(f"{leg['path']}: missing runner word {word} x{n}")
        # Binary and fixture locations are deliberately different; all remaining args must match.
        if len(runner_argv) < 4 or runner_argv[1:3] != ['--headless', '--path'] or runner_argv[4:] != inv['argv'][4:]:
            errors.append(f"{leg['path']}: argv differs: {runner_argv}")
        count += 1
    included = {leg['path'] for leg in legs}
    for result in root.rglob('evidence/result.json'):
        directory = result.parent.parent
        if not any(p.is_file() for p in directory.glob('recording*')):
            continue
        path = directory.relative_to(root).as_posix()
        full = f'{gate}/{path}'
        excluded = any(full == row['path'] or (row['path'].endswith('/*') and full.startswith(row['path'][:-1]))
                       for row in config.get('excluded', []))
        if path not in included and not excluded:
            errors.append(f'{gate}/{path}: unlisted runner capture leg')
    for error in errors:
        print('FAIL ' + error)
    print(f"{gate}: checked {count} legs; {len(errors)} env/argv/unlisted differences")
    return int(bool(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--gate", required=True, choices=("gate0", "gate1", "gate2", "gate8"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--evaluate-only", type=Path)
    mode.add_argument("--check-against-runner", type=Path)
    parser.add_argument("--rep", choices=("a", "b"), default="a")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--sabotage", choices=("decode-off",))
    args = parser.parse_args()
    try:
        config_path = args.config.resolve()
        config = load_config(config_path)
        if not any(leg["gate"] == args.gate for leg in config["legs"]):
            raise ValueError(f"{args.gate}: empty legs")
        if args.sabotage and (args.gate != "gate8" or args.evaluate_only or args.check_against_runner):
            raise ValueError("decode-off sabotage requires launching gate8")
        if args.check_against_runner:
            return check_runner(args.check_against_runner, config_path, config, args.gate)
        if args.evaluate_only:
            return evaluate_gate(args.evaluate_only.resolve(), config, args.gate)
        print(f"wfile: Python {platform.python_version()} OS {platform.platform()}", flush=True)
        output = args.out or Path(os.environ.get("W_RUN_ARTIFACT_DIR", str(config_path.parent / "runs")))
        return launch_gate(config_path, config, args.gate, args.rep, output.resolve(), bool(args.sabotage))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"wfile: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
