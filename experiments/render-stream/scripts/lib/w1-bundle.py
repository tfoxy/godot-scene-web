#!/usr/bin/env python3
"""Prepare the pinned template, imported fixture and capture for portable runtime legs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=("linux", "windows"))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    rs = Path(__file__).resolve().parents[2]
    repo = rs.parents[1]
    out = args.out.resolve()
    w1 = out / "w1"
    w1.mkdir(parents=True, exist_ok=True)
    windows = args.target == "windows"
    record = rs / "calibration" / f"godot-4.5.1-stable-{args.target}-release.json"
    calibration = json.loads(record.read_text())
    pin_script = rs / "scripts" / ("fetch-windows-template.sh" if windows else "run-gate-minus1.sh")
    key = "EXPECTED_WINDOWS_TEMPLATE_SHA256" if windows else "EXPECTED_BINARY_SHA256"
    pin = re.search(key + r'="([0-9a-f]{64})"', pin_script.read_text()).group(1)
    name = "windows_release_x86_64.exe" if windows else "linux_release.x86_64"
    source = Path(os.environ.get("GRC_WINDOWS_TEMPLATE", str(Path.home() / ".cache/godot-render-stream/templates/4.5.1-stable" / name))) if windows else Path.home() / ".cache/godot-render-stream/templates/4.5.1-stable" / name
    digest = sha256(source)
    if digest != pin or digest != calibration["engine"]["sha256"]:
        raise ValueError("template sha256 differs from script pin or calibration engine.sha256")
    shutil.copy2(source, w1 / name)
    if sha256(w1 / name) != digest:
        raise ValueError("copied template sha256 differs")
    ext = w1 / "ext"
    ext.mkdir(exist_ok=True)
    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if windows else None
    if windows:
        dlls = [e["exe"] for e in manifest["imports_only"] if Path(e["exe"]).name == "render_stream_capture.dll"]
        if len(dlls) != 1:
            raise ValueError("expected exactly one imports_only render_stream_capture.dll")
        library = out / dlls[0]
    else:
        library = rs / "capture/build/librender_stream_capture.so"
    shutil.copy2(library, ext / library.name)
    descriptor = (rs / "capture/render_stream_capture.gdextension.in").read_text()
    configuration = descriptor[descriptor.index("[configuration]"):descriptor.index("[libraries]")]
    (ext / "render_stream_capture.gdextension").write_text(configuration + f'[libraries]\n{args.target}.x86_64 = "{library.name}"\n', encoding="utf-8")
    cal = w1 / "calibration"
    cal.mkdir(exist_ok=True)
    shutil.copyfile(record, cal / "record.json")
    subprocess.run(["mise", "exec", "--", "node", str(rs / "scripts/lib/tamper-calibration.mjs"), "prefix", str(record), str(cal / "shift.json")], cwd=repo, check=True)
    image_key = "image_sha256" if windows else "sha256"
    original = calibration["engine"][image_key]
    calibration["engine"][image_key] = "0123456789abcdef"[(int(original[0], 16) + 1) % 16] + original[1:]
    (cal / "image.json").write_text(json.dumps(calibration, indent=2) + "\n", encoding="utf-8")
    project = w1 / "spike"
    if project.exists():
        shutil.rmtree(project)
    shutil.copytree(rs / "fixtures/spike", project, ignore=shutil.ignore_patterns(".godot"))
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GRC_")}
    env.pop("DISPLAY", None)
    env.pop("WAYLAND_DISPLAY", None)
    result = subprocess.run(["mise", "exec", "--", "godot", "--headless", "--path", str(project), "--import"], cwd=repo, env=env, capture_output=True, timeout=180)
    (w1 / "import.log").write_bytes(result.stdout + result.stderr)
    result.check_returncode()
    imported = project / ".godot"
    if not imported.is_dir() or not any(p.is_file() for p in imported.rglob("*")):
        raise ValueError("editor import produced no .godot files")
    cache = w1 / "spike-import"
    if cache.exists():
        shutil.rmtree(cache)
    shutil.move(str(imported), cache)
    names = ("image_sha256 version_string codeview_id aslr_and_bias platform" if windows else "exe_sha256 version_string build_id pie_and_bias platform") + " singleton_available concrete_vptr slot_indices_in_range anchors_implemented hooked_slots_pure_in_abstract hooked_slots_implemented_in_concrete slot_count_tail behaviour_probe"
    config = {"target": args.target, "template": name, "template_sha256": pin,
              "extension": "ext/render_stream_capture.gdextension", "fixture": "spike", "import": "spike-import",
              "record": "calibration/record.json", "shift_record": "calibration/shift.json", "image_record": "calibration/image.json",
              "check_names": names.split(), "expected_anchors": "11/17" if windows else None, "timeout_s": 180,
              "expected": json.loads((project / "expected.json").read_text())}
    (w1 / "w1.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    shutil.copyfile(Path(__file__).with_name("w1-driver.py"), w1 / "w1-driver.py")
    if windows:
        for leg in ("control", "validate", "arm", "refuse-shift", "refuse-image"):
            manifest["tests"].append({"name": "w1-" + leg, "exe": "w1/w1-driver.py", "interpreter": "python",
                                      "args": ["--config", "w1/w1.json", "--leg", leg], "env": {}})
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    if size > 300_000_000:
        raise ValueError(f"bundle exceeds 300 MB: {size} bytes")
    print(f"w1 bundle: {w1}, template sha256={digest}, total bundle bytes={size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
