"""Synthetic MinGW PE shapes; no executable input is copied into fixtures."""

import copy
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calibrate import Pe
from calibrate_canvas_textures import derive


BASE = 0x140000000


def fixture(path, fault="", summed=False):
    text, data = bytearray(b"\xcc" * 4096), bytearray(4096)

    def code(off, value):
        text[off:off + len(value)] = value

    def word(off, value):
        struct.pack_into("<Q", data, off, value)

    def disp(value):
        return struct.pack("<i", value)

    def create(off):
        return b"\x48\x8b\x0d" + disp(0x8000 - (0x1000 + off + 7)) + b"\x48\x8b\x01\xff\x10"

    code(0, b"\x56\x48\x83\xec\x28\x48\x89\xce" + create(8))
    if fault == "global-ambiguous":
        code(24, create(24))
    word(16, BASE + 0x1000)
    for backend, owner in enumerate((256, 320)):
        table = 0x100 + backend * 0x100
        name = 0x400 + backend * 0x80
        rtti = table + 0x80
        spelling = ("N10RendererRD14TextureStorageE", "N5GLES314TextureStorageE")[backend]
        if fault == "rtti-missing" and backend == 0:
            spelling = "X" + spelling[1:]
        data[name:name + len(spelling) + 1] = spelling.encode() + b"\0"
        word(rtti + 8, BASE + 0x4000 + name)
        word(table + 8, BASE + 0x4000 + rtti)
        if fault == "rtti-refs" and backend == 0:
            word(0x700, BASE + 0x4000 + name)
        for slot in range(7):
            word(table + 16 + slot * 8, BASE + 0x1100 + backend * 0x600 + slot * 0x80)
        # Allocation path: quotient from elements_in_chunk, compared to chunk_limit.
        alloc = b"\xf7\xb6" + disp(owner + 24) + b"\x89\xc3\x3b\x9e" + disp(owner + (40 if fault == "limit" else 36)) + b"\xc3"
        code(0x100 + backend * 0x600, alloc)
        for slot in (3, 5, 6):
            off = 0x100 + backend * 0x600 + slot * 0x80
            validator = 72 + (4 if fault == "disagree" and slot == 6 and backend == 0 else 0)
            # Wildcard fields and scale: stride is 5 * 16, deliberately unlike either real image.
            body = b"\x48\x83\xec\x28\x8b\x81" + disp(owner + 28) + b"\x31\xd2\xf7\xb1" + disp(owner + 24)
            body += b"\x48\x8b\x89" + disp(owner + 8)
            if summed:
                body += b"\x89\xd2\x48\x8d\x14\x92\x48\xc1\xe2\x04\x48\x03\x14\xc1\x48\x89\xd0\x8b\x92" + disp(validator)
            else:
                body += b"\x48\x8b\x04\xc1\x48\x8d\x0c\x92\x48\xc1\xe1\x04\x8b\x94\x08" + disp(validator)
            body += b"\x44\x39\xca\x75\x3f"
            if not summed:
                body += b"\x48\x01\xc8"
            if fault == "stride" and slot == 5:
                body = body.replace(b"\xc1\xe1", b"\xc1\xe9").replace(b"\xc1\xe2", b"\xc1\xea")
            if slot == 3:
                body += b"\x41\x83\xf8\x01\x74\x0b\x41\x83\xf8\x02\x74\x0a\x4c\x89\x48\x08\xc3\x4c\x89\x48\x10\xc3\x4c\x89\x48\x18\xc3"
            else:
                body += b"\x44\x89\x40" + bytes([40 if slot == 5 else 44]) + b"\xc3"
            code(off, body)
    out = bytearray(0x2400)
    out[:2] = b"MZ"
    struct.pack_into("<I", out, 60, 0x80)
    out[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", out, 0x84, 0x8664, 3, 0, 0, 0, 240, 0x22)
    opt = 0x98
    struct.pack_into("<H", out, opt, 0x20b)
    struct.pack_into("<Q", out, opt + 24, BASE)
    struct.pack_into("<II", out, opt + 56, 0x9000, 0x400)
    struct.pack_into("<I", out, opt + 108, 16)
    for i, (name, va, size, raw, flags) in enumerate([
            (b".text", 0x1000, 4096, 0x400, 0x60000020),
            (b".rdata", 0x4000, 4096, 0x1400, 0x40000040),
            (b".bss", 0x8000, 4096, 0, 0x40000080 if fault == "readonly" else 0xc0000080)]):
        struct.pack_into("<8sIIIIIIHHI", out, opt + 240 + i * 40,
                         name, size, va, size if raw else 0, raw, 0, 0, 0, 0, flags)
    out[0x400:0x1400], out[0x1400:0x2400] = text, data
    path.write_bytes(out)
    pe = Pe(str(path))
    return {"engine": {"platform": "windows-x86_64", "image_sha256": pe.image_sha256()[0], "codeview_id": None},
            "rendering_server": {"concrete_vtable_vaddr": hex(BASE + 0x4000)},
            "slots": {"canvas_texture_create": 0}}


class CanvasPeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / "synthetic.exe"

    def test_operands(self):
        for summed in (False, True):
            with self.subTest(summed=summed):
                base = fixture(self.binary, summed=summed)
                record, evidence = derive(self.binary, base)
                r = record["canvas_texture_storage"]
                for prefix, owner in (("rd", 256), ("gles3", 320)):
                    for key, expected in dict(owner=owner, stride=80, validator=72, diffuse=8,
                                              normal=16, specular=24, filter=40, repeat=44).items():
                        self.assertEqual(r[prefix + "_" + key], expected)
                    self.assertEqual(evidence["backends"][prefix]["chunk_limit"], 36)

    def test_refusals(self):
        for fault, reason in [("global-ambiguous", "storage global"), ("rtti-missing", "RTTI name"),
                              ("rtti-refs", "typeinfo name reference"), ("disagree", "disagreement"),
                              ("stride", "stride shift"), ("readonly", "writable non-executable"),
                              ("limit", "chunk_limit differs")]:
            with self.subTest(fault=fault):
                base = fixture(self.binary, fault)
                with self.assertRaisesRegex(ValueError, reason):
                    derive(self.binary, base)

    def test_identity_first(self):
        for field in ("image_sha256", "codeview_id"):
            base = fixture(self.binary, "rtti-missing")
            base["engine"][field] = "mismatch"
            with self.assertRaisesRegex(ValueError, field):
                derive(self.binary, base)

    def test_verify(self):
        base = fixture(self.binary)
        record, _ = derive(self.binary, base)
        record_path = self.binary.with_suffix(".json")
        tool = Path(__file__).resolve().parents[1] / "calibrate_canvas_textures.py"
        for changed in (False, True):
            candidate = copy.deepcopy(record)
            if changed:
                candidate["canvas_texture_storage"]["rd_validator"] += 4
            record_path.write_text(json.dumps(candidate))
            run = subprocess.run([sys.executable, str(tool), "--binary", str(self.binary),
                                  "--base", str(record_path), "--verify"], capture_output=True, text=True)
            self.assertEqual(run.returncode, 1 if changed else 0, run.stderr)
            self.assertIn("rd_validator" if changed else "verified 20 storage fields", run.stderr if changed else run.stdout)


if __name__ == "__main__":
    unittest.main()
