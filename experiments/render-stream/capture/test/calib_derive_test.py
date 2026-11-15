#!/usr/bin/env python3
"""Always-run file-backed ELF/PE parity and fail-closed corrupted-image tests."""

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


class DeriveFileTest(unittest.TestCase):
    def test_wanted_slot_names(self):
        with tempfile.TemporaryDirectory(prefix="calib-derive-names-") as temp:
            root = Path(temp)
            header, table, binary = root / "fixture.h", root / "abi.json", root / "elf"
            synth.fixture_header(header)
            original = json.loads(subprocess.check_output([
                sys.executable, "-I", str(CAPTURE / "tools/calibrate.py"),
                "--emit-abi-table", "--header", str(header)]))
            synth.build(binary, "elf")

            def run(changed):
                table.write_text(json.dumps(changed))
                return subprocess.run([
                    DRIVER, "--file", str(table), str(binary), "Godot Engine",
                    "template_release", "--record"], capture_output=True)

            changed = json.loads(json.dumps(original))
            slots = changed["wanted_slots"]
            first, second = "canvas_item_add_rect", "texture_2d_create"
            slots[first], slots[second] = slots[second], slots[first]
            with self.subTest(case="swapped valid pure indices"):
                result = run(changed)
                self.assertEqual(result.returncode, 2, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertIn(first.encode(), result.stderr)
                self.assertIn(str(slots[first]).encode(), result.stderr)
                self.assertIn(second.encode(), result.stderr)

            changed = json.loads(json.dumps(original))
            for virtual in changed["virtuals"]:
                if virtual["name"] == "free":
                    virtual["name"] = "free_rid"
            with self.subTest(case="accepted free_rid alias"):
                result = run(changed)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                golden = CAPTURE / "tools/test/golden/synth-elf.json"
                self.assertEqual(result.stdout, golden.read_bytes())

    def test_file_parity(self):
        with tempfile.TemporaryDirectory(prefix="calib-derive-") as temp:
            root = Path(temp)
            header, table = root / "fixture.h", root / "abi.json"
            synth.fixture_header(header)
            table.write_bytes(subprocess.check_output([
                sys.executable, "-I", str(CAPTURE / "tools/calibrate.py"),
                "--emit-abi-table", "--header", str(header)]))
            for variant in ("elf", "elf-pie", "pe-null", "pe-code"):
                with self.subTest(variant=variant):
                    binary = root / variant
                    synth.build(binary, variant)
                    actual = subprocess.check_output([
                        DRIVER, "--file", str(table), str(binary), "Godot Engine",
                        "template_release", "--record"])
                    expected = (CAPTURE / "tools/test/golden" / f"synth-{variant}.json").read_bytes()
                    self.assertEqual(actual, expected)

    def test_refuse_corruption(self):
        with tempfile.TemporaryDirectory(prefix="calib-derive-bad-") as temp:
            root = Path(temp)
            header, table = root / "fixture.h", root / "abi.json"
            synth.fixture_header(header)
            original = subprocess.check_output([
                sys.executable, "-I", str(CAPTURE / "tools/calibrate.py"),
                "--emit-abi-table", "--header", str(header)])
            table.write_bytes(original)
            for variant in ("placeholder-tie", "mixed-placeholder", "unrelocated-word", "msvc-rtti"):
                with self.subTest(variant=variant):
                    binary = root / variant
                    synth.build(binary, variant)
                    result = subprocess.run([
                        DRIVER, "--file", str(table), str(binary), "Godot Engine",
                        "template_release", "--record"], capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, b"")
                    self.assertIn(b"derive:", result.stderr)
            binary = root / "elf"
            synth.build(binary, "elf")
            mutations = {"schema": "unknown/1", "anchor_selection": "unknown",
                         "defines": ["DEBUG_ENABLED"], "wanted_slots": {"bad": -1},
                         "wanted_slot_aliases": {},
                         "virtuals": [],
                         "fractional_line": 1.5,
                         "fractional_slot": 1.5}
            for key, value in mutations.items():
                with self.subTest(key=key):
                    changed = json.loads(original)
                    if key == "fractional_line":
                        changed["virtuals"][0]["line"] = value
                    elif key == "fractional_slot":
                        changed["wanted_slots"][next(iter(changed["wanted_slots"]))] = value
                    else:
                        changed[key] = value
                    table.write_text(json.dumps(changed))
                    result = subprocess.run([
                        DRIVER, "--file", str(table), str(binary), "Godot Engine",
                        "template_release", "--record"], capture_output=True)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
