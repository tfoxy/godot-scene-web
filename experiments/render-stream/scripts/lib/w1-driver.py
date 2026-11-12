#!/usr/bin/env python3
"""Launch and judge the portable, headless capture runtime legs (stdlib only)."""
import argparse
import json
import hashlib
import os
import shutil
import subprocess
import time
from pathlib import Path
import platform
import re
import sys

LEGS = ("control", "validate", "arm", "refuse-shift", "refuse-image")


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


def evaluate(directory, leg, config):
    evidence = directory / "evidence"
    stdout = read_text(directory / "stdout.txt")
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    check("fixture-completed", bool(re.search(r"\bframes=400\b", stdout)), "stdout must contain frames=400")
    check("exit-code", read_text(directory / "exit-code.txt").strip() == "0", "exit=" + read_text(directory / "exit-code.txt").strip())
    check("script-cache", "Could not load global script cache" not in stdout + read_text(directory / "stderr.txt"), "no global script cache error")
    status = "skipped" if leg == "control" else "OK"
    check("extension-load", f"[fixture] extension load status={status}" in stdout, f"load status={status}")
    if leg == "control":
        return checks
    result = read_json(evidence / "result.json", {})
    expected_status = {"validate": "validated", "arm": "armed"}.get(leg, "refused")
    reason = {"refuse-shift": "slot-mask-mismatch", "refuse-image": "fingerprint-mismatch"}.get(leg)
    check("capture-decision", result.get("status") == expected_status and (reason is None or result.get("reason") == reason), json.dumps(result))
    check("vptr-written", result.get("vptr_written") is (leg == "arm"), f"vptr_written={result.get('vptr_written')}")
    table = read_json(evidence / "calibration-check.json", {}).get("checks", [])
    # Success reaches the hook plan after all 13 calibration checks. A shifted
    # record stops after the 12 slot-mask checks; an image mismatch stops at 5.
    names = config["check_names"] + ["hook_plan"]
    expected_ok = [True] * len(names)
    if leg == "refuse-image":
        names = config["check_names"][:5]
        expected_ok = [False, True, True, True, True]
    elif leg == "refuse-shift":
        names = config["check_names"][:12]
        expected_ok = [True] * len(names)
    # The anchor result has its own check so its sabotage has one named failure.
    judged = [c for c in table if leg != "refuse-shift" or c.get("name") != "anchors_implemented"]
    ok_names = [name for name in names if leg != "refuse-shift" or name != "anchors_implemented"]
    check("calibration-checks", [c.get("name") for c in table] == names and
          [c.get("ok") for c in judged] == (expected_ok if leg != "refuse-shift" else [True] * len(ok_names)), json.dumps(table))
    counters = read_json(evidence / "counters.json")
    if leg == "refuse-shift":
        anchor = next((c for c in table if c.get("name") == "anchors_implemented"), {})
        prefix = config.get("expected_anchors")
        check("shift-anchors", anchor.get("ok") is False and (not prefix or anchor.get("detail", "").startswith(prefix)), str(anchor))
        vtable = result.get("vtable")
        check("nothing-patched", (vtable is None or vtable.get("published") == "engine") and (counters is None or all(n == 0 for n in counters.get("counts", {}).values())), "vtable=" + json.dumps(vtable) + " counts=" + json.dumps((counters or {}).get("counts")))
    if leg != "arm":
        return checks
    check("headless", result.get("display_server") == "headless", f"display_server={result.get('display_server')}")
    check("counters-present", isinstance(counters, dict), "counters.json must exist and parse")
    if isinstance(counters, dict):
        check("validation-log", counters.get("validation_log") == "on", f"validation_log={counters.get('validation_log')}")
        captured = counters.get("captured", {})
        check("captured-present", bool(captured), "captured tables must be non-empty")
        if captured:
            expected = config["expected"]
            rects = captured.get("canvas_item_add_rect", [])
            for name, key in (("colorrect-add-rect", "colorrect_add_rect"), ("script-add-rect", "script_add_rect")):
                matches = [r for r in rects if all(r.get(k) == expected[key][k] for k in ("rect_bits", "color_bits"))]
                check(name, bool(matches), "matched=" + json.dumps(matches))
            counts = counters.get("counts", {})
            glyphs = sum(counts.get(k, 0) for k in ("canvas_item_add_texture_rect_region", "canvas_item_add_msdf_texture_rect_region"))
            late = [e for e in captured.get("texture_2d_update", []) if e.get("frame", -1) >= expected["label_glyphs"]["relabel_frame"]]
            check("label-glyph-path", glyphs > 0 and counts.get("texture_2d_create", 0) > 0 and bool(late), f"glyphs={glyphs}, creates={counts.get('texture_2d_create', 0)}, late updates=" + json.dumps(late))
        check("frames-total", counters.get("frames_total", -1) >= 300, f"frames_total={counters.get('frames_total')}")
    disarm = read_json(evidence / "disarm.json")
    check("disarm-restored", isinstance(disarm, dict) and disarm.get("disarmed") is True and disarm.get("vptr_restored") is True, json.dumps(disarm))
    if isinstance(disarm, dict):
        seen = read_json(directory / "observation.json", {}).get("first_seen", {}).get("disarm.json", {})
        check("disarm-while-running", seen.get("while_running") is True, json.dumps(seen))
        if isinstance(counters, dict):
            frames = counters.get("frames_total", -1) - disarm.get("frame", 10**9)
            check("frames-after-disarm", frames >= 300, f"frames after disarm={frames}")
    return checks


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def launch(config_path, config, leg):
    base = config_path.resolve().parent
    directory = Path(os.environ.get("W_RUN_ARTIFACT_DIR", str(base / "runs" / leg))).resolve()
    if directory.exists():
        shutil.rmtree(directory)
    evidence = directory / "evidence"
    evidence.mkdir(parents=True)
    start_hash = time.monotonic()
    binary = base / config["template"]
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    print(f"binary sha256={digest}, hashing took {time.monotonic() - start_hash:.3f} s", flush=True)
    if digest != config["template_sha256"]:
        raise ValueError("template sha256 differs from pinned config")
    imported = base / config["import"]
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob("*")):
        raise ValueError("missing or empty spike-import: editor --import cache is required; refusing to launch")
    project = directory / "project"
    shutil.copytree(base / config["fixture"], project, ignore=shutil.ignore_patterns(".godot"))
    shutil.copytree(imported, project / ".godot")
    user = directory / "user"
    user.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GRC_")}
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
        env.update(APPDATA=str(user), LOCALAPPDATA=str(user))
    else:
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
        env.update({k: str(user / k) for k in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME")})
    grc = {}
    if leg != "control":
        record = config[{"refuse-shift": "shift_record", "refuse-image": "image_record"}.get(leg, "record")]
        grc = {"GRC_EXTENSION": str(base / config["extension"]), "GRC_EVIDENCE_DIR": str(evidence),
               "GRC_VALIDATION_LOG": "on", "GRC_MODE": "validate" if leg == "validate" else "arm",
               "GRC_CALIBRATION": str(base / record)}
        if leg == "arm":
            grc["GRC_DISARM_AFTER_FRAMES"] = "60"
    env.update(grc)
    argv = [str(binary), "--headless", "--path", str(project)]
    invocation = {"argv": argv, "env": grc, "user": str(user)}
    write_json(directory / "invocation.json", invocation)
    print("invocation: " + json.dumps(invocation), flush=True)
    observation = {"first_seen": {}, "timed_out": False}
    start = time.monotonic()
    with (directory / "stdout.txt").open("wb") as stdout, (directory / "stderr.txt").open("wb") as stderr:
        process = subprocess.Popen(argv, env=env, cwd=project, stdout=stdout, stderr=stderr)
        while True:
            alive = process.poll() is None
            for path in sorted(evidence.iterdir()):
                if path.is_file() and path.name not in observation["first_seen"]:
                    observation["first_seen"][path.name] = {"seconds": round(time.monotonic() - start, 3),
                                                           "while_running": alive and process.poll() is None}
            if not alive:
                break
            if time.monotonic() - start >= config.get("timeout_s", 180):
                observation["timed_out"] = True
                process.kill()
                process.wait()
                print("TIMEOUT: evidence existed: " + ", ".join(observation["first_seen"]), flush=True)
            time.sleep(0.05)
    observation["wall_s"] = round(time.monotonic() - start, 3)
    write_json(directory / "observation.json", observation)
    (directory / "exit-code.txt").write_text(str(process.returncode) + "\n", encoding="utf-8")
    return directory


def diagnostics(directory, failed):
    rc = read_text(directory / "exit-code.txt").strip()
    try:
        code = int(rc) & 0xffffffff
    except ValueError:
        code = 0
    named = {0xC0000005: "ACCESS_VIOLATION", 0xC0000409: "STACK_BUFFER_OVERRUN",
             0xC0000135: "DLL_NOT_FOUND", 0xC000007B: "INVALID_IMAGE_FORMAT"}
    print(f"exit decimal={rc} hex=0x{code:08X} {named.get(code, '')}")
    print("observation: " + json.dumps(read_json(directory / "observation.json")))
    evidence = directory / "evidence"
    for filename in ("calibration-check.json", "result.json", "disarm.json"):
        value = read_json(evidence / filename)
        print(filename + ": " + json.dumps(value))
        if filename == "result.json" and isinstance(value, dict) and value.get("display_server") not in (None, "headless"):
            print("DIAGNOSIS: display_server is not headless")
    counters = read_json(evidence / "counters.json", {})
    print("counters summary: " + json.dumps({"nonzero_counts": {k: v for k, v in counters.get("counts", {}).items() if v},
          "table_sizes": {k: len(v) for k, v in counters.get("captured", {}).items() if isinstance(v, list)},
          "capture_metadata": {k: v for k, v in counters.get("captured", {}).items() if not isinstance(v, list)},
          "frames_total": counters.get("frames_total"), "validation_log": counters.get("validation_log")}))
    for filename in ("stdout.txt", "stderr.txt"):
        lines = read_text(directory / filename).splitlines()
        for line in lines:
            if "[grc] fingerprint: image hash " in line:
                print("K6 (information; warm file cache): " + line)
            if re.search(r"\[grc\]|\[fixture\]|ERROR|WARNING|Vulkan|OpenGL|D3D|rasteriz", line):
                print(filename + ": " + line)
        if any(re.search(r"ERROR.*(Vulkan|OpenGL|D3D|rasteriz)|(Vulkan|OpenGL|D3D|rasteriz).*ERROR", line, re.I) for line in lines):
            print("DIAGNOSIS: renderer error appears in " + filename)
        if failed:
            print(filename + " last 200 lines:\n" + "\n".join(lines[-200:]))
    if failed:
        for log in (directory / "user").rglob("godot.log"):
            print(str(log) + ":\n" + read_text(log))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--leg", required=True, choices=LEGS)
    parser.add_argument("--evaluate-only", type=Path)
    args = parser.parse_args()
    print(f"w1: Python {platform.python_version()} OS {platform.platform()}", flush=True)
    config = read_json(args.config)
    if config is None:
        print("FAIL config: missing or invalid JSON")
        return 1
    try:
        directory = args.evaluate_only or launch(args.config, config, args.leg)
        checks = evaluate(directory, args.leg, config)
    except (OSError, ValueError, KeyError) as exc:
        print(f"FAIL launch: {exc}", flush=True)
        return 1
    for name, ok, detail in checks:
        print(f"{'ok' if ok else 'FAIL'} {name}: {detail}")
    failed = sum(not ok for _, ok, _ in checks)
    diagnostics(directory, failed != 0)
    print(f"w1-{args.leg}: {len(checks) - failed} passed, {failed} failed")
    return int(failed != 0)


if __name__ == "__main__":
    sys.exit(main())
