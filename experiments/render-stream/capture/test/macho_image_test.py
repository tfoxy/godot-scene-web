#!/usr/bin/env python3
"""Portable C++ Mach-O parsing agrees with the offline reader on synthetic images."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

CAPTURE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CAPTURE / "tools/test"))
import synth

DRIVER = sys.argv.pop(1)


class MachoImageTest(unittest.TestCase):
    def run_image(self, path, arch, ok=True):
        result = subprocess.run([DRIVER, str(path), str(synth.calibrate.MachO.CPUS.get(arch, 0))],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
        if not ok:
            self.assertTrue(result.stderr)
            self.assertFalse(result.stdout)
            return
        image = synth.calibrate.MachO(str(path), arch)
        actual = json.loads(result.stdout)
        fixups = [[addr, value or 0, image.binds.get(addr, ""), image.bind_addends.get(addr, 0)]
                  for addr, value in sorted(image.relocations.items())]
        self.assertEqual(actual.pop("fixups"), fixups)
        expected = image.identity()
        expected.pop("file_sha256")
        self.assertEqual(actual, expected)

    def test_fat_and_thin(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image"
            for fmt in (2, 6):
                for fat in (False, True):
                    for chained in (False, True):
                        synth.macho(path, fat=fat, chained=chained, pointer_format=fmt)
                        for arch in (("arm64", "x86_64") if fat else ("x86_64",)):
                            with self.subTest(fmt=fmt, fat=fat, chained=chained, arch=arch):
                                self.run_image(path, arch)
                        if fat:
                            self.run_image(path, None, False)
                        else:
                            self.run_image(path, "arm64", False)

    def test_fat64(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image"
            synth.macho(path)
            original = path.read_bytes()
            data = bytearray(original)
            struct.pack_into(">I", data, 0, 0xCAFEBABF)
            for i in range(2):
                cpu, subtype, off, size, align = struct.unpack_from(">5I", original, 8 + i * 20)
                struct.pack_into(">IIQQII", data, 8 + i * 32, cpu, subtype, off, size, align, 0)
            path.write_bytes(data)
            for arch in ("arm64", "x86_64"):
                self.run_image(path, arch)

    def test_corruptions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "image"
            synth.macho(path)
            original = path.read_bytes()
            image = synth.calibrate.MachO(str(path), "x86_64")
            arm = synth.calibrate.MachO(str(path), "arm64")
            for label, offset, fmt, value, arch in (
                ("fat-range", 16, ">I", 0xFFFFFF00, "x86_64"),
                ("fat-subtype", 12, ">I", 2, "x86_64"),
                ("thin-magic", image.slice_offset, "<I", 0, "x86_64"),
                ("command-size", image.slice_offset + 36, "<I", 0, "x86_64"),
                ("arm64e", arm.slice_offset + 8, "<I", 2, "arm64"),
                ("bind-symbol", image.slice_offset + original[image.slice_offset:].index(b"___cxa_pure_virtual"),
                 "<B", 0, "x86_64"),
            ):
                with self.subTest(label=label):
                    changed = bytearray(original)
                    struct.pack_into(fmt, changed, offset, value)
                    path.write_bytes(changed)
                    self.run_image(path, arch, False)
            for length in (0, 4, 31, image.slice_offset + 31):
                path.write_bytes(original[:length])
                self.run_image(path, "x86_64", False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
