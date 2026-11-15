#!/usr/bin/env python3
"""ABI table regeneration and record parity; optional binaries are never executed."""

import difflib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CAPTURE = Path(__file__).resolve().parents[1]
REPO = CAPTURE.parents[2]
TOOL = Path(os.environ.get("GRC_CALIBRATE_TOOL", CAPTURE / "tools/calibrate.py"))
TABLE = CAPTURE.parent / "calibration/abi/godot-4.5.1-rendering-server.json"
HEADER = REPO.parent / "godot-4.5.1-stable/servers/rendering_server.h"
sys.path.insert(0, str(CAPTURE / "tools/test"))
import synth


def invoke(*args):
    result = subprocess.run([sys.executable, "-I", str(TOOL), *map(str, args)],
                            capture_output=True)
    if result.returncode:
        raise AssertionError(result.stderr.decode())
    return result.stdout


def equal_bytes(actual, expected, label):
    if actual != expected:
        diff = "".join(difflib.unified_diff(expected.decode().splitlines(True),
                                           actual.decode().splitlines(True),
                                           fromfile=label, tofile="generated"))
        raise AssertionError(diff)


class AbiTableTest(unittest.TestCase):
    def test_regenerate(self):
        if not HEADER.is_file():
            self.skipTest(f"Godot header absent: {HEADER}")
        actual = invoke("--emit-abi-table", "--header", HEADER,
                        "--version-name", "Godot Engine")
        equal_bytes(actual, TABLE.read_bytes(), str(TABLE))

    def test_synthetic_parity(self):
        # Always exercise both entry points, even without a local engine/header.
        with tempfile.TemporaryDirectory(prefix="abi-table-") as temp:
            root = Path(temp)
            header, table = root / "fixture.h", root / "abi.json"
            synth.fixture_header(header)
            table.write_bytes(invoke("--emit-abi-table", "--header", header))
            for variant in ("elf", "elf-pie", "pe-null", "pe-code"):
                with self.subTest(variant=variant):
                    binary = root / variant
                    synth.build(binary, variant)
                    expected = invoke("--binary", binary, "--header", header)
                    actual = invoke("--binary", binary, "--abi-table", table)
                    golden = CAPTURE / "tools/test/golden" / f"synth-{variant}.json"
                    equal_bytes(expected, golden.read_bytes(), str(golden))
                    equal_bytes(actual, expected, variant)

    def test_reject_invalid_table(self):
        with tempfile.TemporaryDirectory(prefix="abi-invalid-") as temp:
            root = Path(temp)
            header, table = root / "fixture.h", root / "abi.json"
            synth.fixture_header(header)
            original = json.loads(invoke("--emit-abi-table", "--header", header))
            binary = root / "elf"
            synth.build(binary, "elf")
            for key, value in (("schema", "unknown/1"), ("anchor_selection", "unknown"),
                               ("wanted_slots", {}), ("wanted_slot_aliases", {}), ("virtuals", [])):
                with self.subTest(key=key):
                    table.write_text(json.dumps({**original, key: value}))
                    result = subprocess.run([sys.executable, "-I", str(TOOL), "--binary",
                                             str(binary), "--abi-table", str(table)],
                                            capture_output=True)
                    self.assertEqual(result.returncode, 2, result.stderr.decode())
                    self.assertIn(b"calibrate:", result.stderr)
                    self.assertEqual(result.stdout, b"")


def parity_test(binary, record):
    def test(self):
        if not binary.is_file() or not record.is_file():
            self.skipTest(f"binary or record absent: {binary}={record}")
        expected = record.read_bytes()
        facts = json.loads(expected)
        brand = facts["engine"]["version_string"].split(" v", 1)[0]
        args = ("--binary", binary, "--version-name", brand,
                "--flavor", facts["engine"]["flavor"],
                "--concrete-class", facts["rendering_server"]["concrete_class"])
        actual = invoke(*args, "--abi-table", TABLE)
        equal_bytes(actual, expected, str(record))
        if HEADER.is_file():
            equal_bytes(invoke(*args, "--header", HEADER), actual, "header vs table")
        print(f"parity matched: {binary}={record}", flush=True)
    return test


pairs = os.environ.get("GRC_PARITY_BINARIES", "")
if not pairs:
    @unittest.skip("GRC_PARITY_BINARIES is unset; no local binary pairs supplied")
    def no_binaries(self):
        pass
    AbiTableTest.test_binary_parity = no_binaries
else:
    for index, pair in enumerate(pairs.split(";")):
        binary, record = pair.split("=", 1)
        setattr(AbiTableTest, f"test_binary_parity_{index:03d}",
                parity_test(Path(binary), Path(record)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
