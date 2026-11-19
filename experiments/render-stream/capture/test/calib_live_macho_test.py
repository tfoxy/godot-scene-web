#!/usr/bin/env python3
"""Exercise running Mach-O slice collection and live RTTI on synthetic dyld mappings."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CAPTURE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CAPTURE / "tools/test"))
import synth

DRIVER = sys.argv.pop(1)


class LiveMachoTest(unittest.TestCase):
    def test_bundle_identities(self):
        with tempfile.TemporaryDirectory() as temp:
            binary = Path(temp) / "signed-universal"
            prefix = Path(temp) / "self-test.identity"
            synth.macho(binary)
            for arch in ("arm64", "x86_64"):
                with self.subTest(arch=arch):
                    subprocess.run([sys.executable, "-I", str(CAPTURE / "test/calib_macho_identity.py"),
                                    str(binary), arch, str(prefix)], check=True)
                    positive = json.loads(Path(str(prefix) + ".json").read_text())
                    negative = json.loads(Path(str(prefix) + ".bad.json").read_text())
                    image = synth.calibrate.MachO(str(binary), arch)
                    self.assertEqual(positive, dict(platform=image.platform, pie=image.pie, **image.identity()))
                    before = bytes.fromhex(positive["sha256"])
                    after = bytes.fromhex(negative.pop("sha256"))
                    self.assertEqual([a ^ b for a, b in zip(before, after)], [1] + [0] * 31)
                    positive.pop("sha256")
                    self.assertEqual(negative, positive)

    def test_running_slices(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            header, abi, binary, record = [root / name for name in ("header.h", "abi.json", "universal", "record.json")]
            synth.fixture_header(header)
            abi.write_bytes(subprocess.check_output([
                sys.executable, "-I", str(CAPTURE / "tools/calibrate.py"),
                "--emit-abi-table", "--header", str(header)]))
            for chained in (False, True):
                for data_const in (True, False):
                    for fat in (True, False):
                        synth.macho(binary, fat=fat, chained=chained)
                        if not data_const:
                            binary.write_bytes(binary.read_bytes().replace(
                                b"__DATA_CONST" + bytes(4), b"__DATA" + bytes(10)))
                        for arch in (("arm64", "x86_64") if fat else ("x86_64",)):
                            with self.subTest(chained=chained, data_const=data_const, fat=fat, arch=arch):
                                args = argparse.Namespace(binary=str(binary), arch=arch, header=str(header),
                                    abstract_class="RenderingServer", concrete_class="RenderingServerDefault",
                                    define=[], version_name="Godot Engine", flavor="template_release")
                                record.write_text(json.dumps(synth.calibrate.build_record(args, census=False)[0]))
                                result = subprocess.run([DRIVER, str(binary), str(synth.calibrate.MachO.CPUS[arch]),
                                                         str(abi), str(record)], capture_output=True, text=True)
                                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                                print(result.stdout, end="", flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
