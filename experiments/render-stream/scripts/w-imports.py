#!/usr/bin/env python3
"""Check normal and delay imports of x86-64 PE32+ binaries, without dependencies."""

import argparse
import fnmatch
import json
from pathlib import Path
import re
import struct
import subprocess
import sys


ALLOW = [
    "kernel32.dll", "advapi32.dll", "ws2_32.dll", "bcrypt.dll", "ntdll.dll",
    "bcryptprimitives.dll",  # Rust std uses ProcessPrng on Windows since Rust 1.78.
    "userenv.dll", "api-ms-win-crt-*.dll", "api-ms-win-core-*.dll",
]


class PEError(ValueError):
    pass


class PE:
    def __init__(self, data):
        self.data = data
        if self.take(0, 2) != b"MZ":
            raise PEError("not a PE: missing MZ signature")
        pe = self.unpack("<I", 0x3C)[0]
        if self.take(pe, 4) != b"PE\0\0":
            raise PEError("not a PE: missing PE signature")
        machine, sections = self.unpack("<HH", pe + 4)
        if machine != 0x8664:
            raise PEError(f"not x86-64: machine 0x{machine:04x}")
        optional_size = self.unpack("<H", pe + 20)[0]
        opt = pe + 24
        self.take(opt, optional_size)
        if optional_size < 112 or self.unpack("<H", opt)[0] != 0x20B:
            raise PEError("not PE32+: optional header magic must be 0x20b")
        self.image_base = self.unpack("<Q", opt + 24)[0]
        self.headers_size = self.unpack("<I", opt + 60)[0]
        n_dirs = self.unpack("<I", opt + 108)[0]
        if 112 + n_dirs * 8 > optional_size:
            raise PEError("data directories exceed optional header")
        self.directories = [self.unpack("<II", opt + 112 + i * 8) for i in range(n_dirs)]
        self.sections = []
        for i in range(sections):
            section = opt + optional_size + i * 40
            self.take(section, 40)
            virtual_size, rva, raw_size, raw_offset = self.unpack("<IIII", section + 8)
            self.sections.append((rva, max(virtual_size, raw_size), raw_offset, raw_size))

    def take(self, offset, size):
        if offset < 0 or size < 0 or offset + size > len(self.data):
            raise PEError(f"truncated PE at file offset 0x{offset:x}")
        return self.data[offset:offset + size]

    def unpack(self, fmt, offset):
        return struct.unpack(fmt, self.take(offset, struct.calcsize(fmt)))

    def locate(self, rva, size=1):
        if 0 <= rva < self.headers_size and rva + size <= self.headers_size:
            self.take(rva, size)
            return rva, min(self.headers_size, len(self.data))
        for start, span, offset, raw_size in self.sections:
            if start <= rva < start + span:
                delta = rva - start
                if delta + size > raw_size:
                    raise PEError(f"RVA 0x{rva:x} has no backing file data")
                self.take(offset + delta, size)
                return offset + delta, min(offset + raw_size, len(self.data))
        raise PEError(f"unmapped RVA 0x{rva:x}")

    def dll_name(self, rva):
        offset, limit = self.locate(rva)
        end = self.data.find(b"\0", offset, limit)
        if end <= offset:
            raise PEError(f"empty or unterminated DLL name at RVA 0x{rva:x}")
        try:
            return self.data[offset:end].decode("ascii").lower()
        except UnicodeDecodeError as error:
            raise PEError(f"non-ASCII DLL name at RVA 0x{rva:x}") from error

    def imports(self, index, delay=False):
        if index >= len(self.directories):
            return []
        rva, size = self.directories[index]
        if rva == 0 and size == 0:
            return []
        if not rva or not size:
            raise PEError(f"invalid import directory {index}")
        stride = 32 if delay else 20
        names = set()
        for delta in range(0, size - stride + 1, stride):
            offset, _ = self.locate(rva + delta, stride)
            descriptor = self.take(offset, stride)
            if not any(descriptor):
                return sorted(names)
            words = struct.unpack("<" + "I" * (stride // 4), descriptor)
            name_rva = words[1] if delay else words[3]
            if delay and not words[0] & 1:
                name_rva -= self.image_base
            names.add(self.dll_name(name_rva))
        raise PEError(f"unterminated import directory {index}")

    def exports(self):
        if not self.directories or self.directories[0] == (0, 0):
            return []
        rva, size = self.directories[0]
        if not rva or size < 40:
            raise PEError("invalid export directory")
        offset, _ = self.locate(rva, 40)
        functions, names, function_table, name_table, ordinal_table = self.unpack("<IIIII", offset + 20)
        addresses = self.unpack(f"<{functions}I", self.locate(function_table, functions * 4)[0])
        name_rvas = self.unpack(f"<{names}I", self.locate(name_table, names * 4)[0])
        ordinals = self.unpack(f"<{names}H", self.locate(ordinal_table, names * 2)[0])
        if any(ordinal >= functions or not addresses[ordinal] for ordinal in ordinals):
            raise PEError("invalid named export ordinal")
        if set(ordinals) != {i for i, address in enumerate(addresses) if address}:
            raise PEError("module has unnamed exports")
        result = []
        for name_rva in name_rvas:
            start, limit = self.locate(name_rva)
            end = self.data.find(b"\0", start, limit)
            if end <= start:
                raise PEError("empty or unterminated export name")
            result.append(self.data[start:end].decode("ascii"))
        return sorted(result)


def inspect(path, objdump, expected_exports=None):
    pe = PE(Path(path).read_bytes())
    imports = pe.imports(1)
    delay_imports = pe.imports(13, delay=True)
    names = set(imports) | set(delay_imports)
    if objdump:
        output = subprocess.run(
            [objdump, "-p", path], check=True, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=60,
        ).stdout
        other = {m.lower() for m in re.findall(r"DLL Name:\s*(\S+)", output)}
        if other != names:
            raise PEError(f"objdump disagreement: parser={sorted(names)}, objdump={sorted(other)}")
    disallowed = sorted(name for name in names if not any(fnmatch.fnmatchcase(name, p) for p in ALLOW))
    result = dict(path=path, imports=imports, delay_imports=delay_imports, disallowed=disallowed)
    if expected_exports is not None:
        result["exports"] = pe.exports()
        if result["exports"] != expected_exports:
            raise PEError(f"unexpected exports: {result['exports']} (expected {expected_exports})")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", metavar="OUT")
    parser.add_argument("--objdump", metavar="PATH")
    parser.add_argument("--expect-disallowed", metavar="DLL[,DLL]")
    parser.add_argument("--expect-exports", metavar="SYMBOL[,SYMBOL]")
    parser.add_argument("pe", nargs="+", metavar="PE")
    args = parser.parse_args()
    expected_exports = None
    if args.expect_exports is not None:
        expected_exports = sorted(args.expect_exports.split(","))
        if "" in expected_exports or len(set(expected_exports)) != len(expected_exports):
            parser.error("--expect-exports requires distinct nonempty symbols")
    expected = set()
    if args.expect_disallowed is not None:
        expected = {name.strip().lower() for name in args.expect_disallowed.split(",")}
        if "" in expected:
            parser.error("--expect-disallowed requires nonempty DLL names")
    binaries = []
    try:
        for path in args.pe:
            binaries.append(inspect(path, args.objdump, expected_exports))
        for binary in binaries:
            path, bad = binary["path"], binary["disallowed"]
            if bad:
                print(f"FAIL {path}: disallowed {', '.join(bad)} (allowed: {', '.join(ALLOW)})")
            else:
                print(f"ok   {path}: {', '.join(sorted(set(binary['imports'] + binary['delay_imports'])))}")
        count = sum(not b["disallowed"] for b in binaries)
        print(f"w-imports: {count}/{len(binaries)} binaries import only system DLLs")
        ok = count == len(binaries)
        if expected:
            ok = True
            for binary in binaries:
                detected = expected <= set(binary["disallowed"])
                ok = ok and detected
                if detected:
                    print(f"w-imports: sabotage detected: {binary['path']} imports {', '.join(sorted(expected))}")
                else:
                    print(f"w-imports: sabotage not detected: {binary['path']} (expected {', '.join(sorted(expected))})")
        if args.json:
            Path(args.json).write_text(json.dumps({
                "schema": "render-stream-w-imports/1", "allow": ALLOW,
                "binaries": binaries, "ok": ok,
            }, indent=2) + "\n", encoding="utf-8")
        return 0 if ok else 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"w-imports: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
