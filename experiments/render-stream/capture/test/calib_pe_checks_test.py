"""Fingerprint group names, details and refusal boundary match the offline verifier."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

exe, tools = sys.argv[1:]
tools = Path(tools)
checks = 0
with tempfile.TemporaryDirectory() as tmp:
    binary = Path(tmp) / "synth.exe"
    record = Path(tmp) / "record.json"
    subprocess.run([sys.executable, "-I", str(tools / "test/synth.py"), "--write-pe", str(binary)], check=True)
    identity = json.loads(subprocess.check_output([sys.executable, "-I", str(tools / "calibrate.py"), "--pe-identity", str(binary)]))
    identity.update(version_string="Godot Engine v4.5.1.stable.synthetic", platform="windows-x86_64", image_sha256="wrong")
    # The hash mismatch deliberately stops the oracle before any slot-mask reads.
    for mutation in ({}, {"codeview_id": None}, {"codeview_id": "wrong"}, {"time_date_stamp": 0},
                     {"size_of_image": 1}, {"image_base": "0x140000001"}, {"dynamic_base": False},
                     {"version_string": "wrong"}, {"platform": "linux-x86_64"}):
        data = dict(schema="render-stream-calibration/1", engine=identity | mutation,
                    rendering_server=dict(abstract_vtable_vaddr="0x140004180", concrete_vtable_vaddr="0x1400045f0", slot_count=140),
                    slots={"hook": 35}, anchors={"anchor": 0})
        record.write_text(json.dumps(data))
        oracle = subprocess.run([sys.executable, "-I", str(tools / "calibrate.py"), "--verify-record", str(record), "--binary", str(binary), "--version-name", "Godot Engine"], capture_output=True, text=True)
        actual = subprocess.run([exe, str(binary), str(record)], capture_output=True, text=True)
        assert oracle.returncode == actual.returncode == 3, (oracle, actual)
        assert oracle.stdout == actual.stdout, (oracle.stdout, actual.stdout)
        assert len(actual.stdout.splitlines()) == 6
        checks += 1
print(f"calib_pe_checks: {checks} passed, 0 failed")
