#!/usr/bin/env python3
"""Mach-O file derivation parity and per-slice fingerprint refusal tests."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CAPTURE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CAPTURE / "tools/test"))
import synth

DERIVE, CHECK = sys.argv[1:3]
del sys.argv[1:3]
STOCK = Path(os.environ.get("GRC_MACOS_TEMPLATE", str(Path.home() /
    ".cache/godot-render-stream/templates/4.5.1-stable/godot_macos_release.universal")))


class MachoCalibrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="calib-macho-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.header, self.table = self.root / "fixture.h", self.root / "abi.json"
        synth.fixture_header(self.header)
        self.table.write_bytes(subprocess.check_output([
            sys.executable, "-I", str(CAPTURE / "tools/calibrate.py"),
            "--emit-abi-table", "--header", str(self.header)]))
        self.binary = self.root / "universal"
        synth.macho(self.binary)

    def record(self, arch):
        args = argparse.Namespace(binary=str(self.binary), arch=arch, header=str(self.header),
                                  abstract_class="RenderingServer", concrete_class="RenderingServerDefault",
                                  define=[], version_name="Godot Engine", flavor="template_release")
        return synth.calibrate.build_record(args, census=False)[0]

    def derive(self, binary, table, arch):
        command = [
            DERIVE, "--file", str(table), str(binary), "Godot Engine",
            "template_release", "--record"]
        if arch:
            command.append(str(synth.calibrate.MachO.CPUS[arch]))
        return subprocess.check_output(command)

    def verify(self, record, arch, ok=True, marker=None):
        path = self.root / "record.json"
        path.write_text(json.dumps(record))
        result = subprocess.run([CHECK, str(self.binary), str(path),
                                 str(synth.calibrate.MachO.CPUS[arch])], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if ok else 3, result.stdout + result.stderr)
        if marker:
            self.assertIn(marker, result.stdout)

    def test_synthetic_parity(self):
        for fmt in (2, 6):
            for chained in (False, True):
                for fat in (False, True):
                    synth.macho(self.binary, fat=fat, chained=chained, pointer_format=fmt)
                    for arch in (("x86_64", "arm64") if fat else ("x86_64",)):
                        with self.subTest(fmt=fmt, chained=chained, fat=fat, arch=arch):
                            record = self.record(arch)
                            # The file derive emits empty census fields without running a census.
                            calibrator = record.pop("calibrator")
                            record.update(devirtualized_slots=[], dropped_families=[], calibrator=calibrator)
                            expected = (json.dumps(record, indent=2) + "\n").encode()
                            self.assertEqual(self.derive(self.binary, self.table, arch if fat else None), expected)

    def test_identity_and_wrong_slice(self):
        x86, arm = self.record("x86_64"), self.record("arm64")
        self.verify(x86, "x86_64")
        self.verify(arm, "arm64")
        self.verify(x86, "arm64", False, "refused: fingerprint-mismatch")
        # Isolate CPU/subtype from the other independent identity guards.
        for key in ("cputype", "cpusubtype", "uuid", "sha256", "slice_offset", "slice_size", "platform", "pie"):
            with self.subTest(key=key):
                changed = copy.deepcopy(arm)
                value = changed["engine"][key]
                changed["engine"][key] = not value if isinstance(value, bool) else (
                    value + 1 if isinstance(value, int) else "changed")
                self.verify(changed, "arm64", False, "refused: fingerprint-mismatch")
        arm["engine"]["file_sha256"] = "informational"
        self.verify(arm, "arm64")

    def test_other_slice_is_not_hashed(self):
        record = self.record("x86_64")
        arm = synth.calibrate.MachO(str(self.binary), "arm64")
        data = bytearray(self.binary.read_bytes())
        data[arm.slice_offset + 0x1000] ^= 1
        self.binary.write_bytes(data)
        self.verify(record, "x86_64")

    def test_wrong_bind_refuses_derivation(self):
        for chained in (False, True):
            with self.subTest(chained=chained):
                synth.macho(self.binary, chained=chained)
                self.binary.write_bytes(self.binary.read_bytes().replace(
                    b"___cxa_pure_virtual", b"___cxa_fake_virtual"))
                result = subprocess.run([
                    DERIVE, "--file", str(self.table), str(self.binary), "Godot Engine",
                    "template_release", "--record", str(synth.calibrate.MachO.CPUS["arm64"])],
                    capture_output=True)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"expected uniform ___cxa_pure_virtual binds", result.stderr)

    def test_stock_records(self):
        binary = STOCK
        if not binary.is_file():
            self.skipTest("cached stock macOS template absent")
        self.assertEqual(hashlib.sha256(binary.read_bytes()).hexdigest(),
                         "3bdfef756b735361fb3000832faa68f6c7bc2ddd0a03d61e9d2981f63f14469a")
        table = CAPTURE.parent / "calibration/abi/godot-4.5.1-rendering-server.json"
        for arch in ("arm64", "x86_64"):
            with self.subTest(arch=arch):
                expected = CAPTURE.parent / f"calibration/godot-4.5.1-stable-macos-{arch}-release.json"
                self.assertEqual(self.derive(binary, table, arch), expected.read_bytes())


if __name__ == "__main__":
    stock = "--stock" in sys.argv
    if stock:
        sys.argv.remove("--stock")
        if not STOCK.is_file():
            print("SKIP: cached stock macOS template absent")
            sys.exit(77)
    names = ["MachoCalibrationTest." + name for name in dir(MachoCalibrationTest)
             if name.startswith("test_") and (name == "test_stock_records") == stock]
    unittest.main(defaultTest=names, verbosity=2)
