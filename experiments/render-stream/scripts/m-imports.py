#!/usr/bin/env python3
"""Check every slice of a Mach-O binary for non-system dynamic-library imports."""

import argparse
import json
from pathlib import Path
import posixpath
import re
import shutil
import struct
import subprocess
import sys


ARCHES = {0x01000007: "x86_64", 0x0100000C: "arm64"}
LOADS = {0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023}
ALLOW = ["/usr/lib/", "/System/Library/"]


class MachOError(ValueError):
    pass


def take(data, offset, size):
    if offset < 0 or size < 0 or offset + size > len(data):
        raise MachOError(f"truncated Mach-O at offset 0x{offset:x}")
    return bytes(data[offset:offset + size])


def unpack(data, fmt, offset):
    return struct.unpack(fmt, take(data, offset, struct.calcsize(fmt)))


def thin(data):
    magic = take(data, 0, 4)
    endian = {b"\xcf\xfa\xed\xfe": "<", b"\xfe\xed\xfa\xcf": ">"}.get(magic)
    if not endian:
        raise MachOError("expected a 64-bit Mach-O slice")
    _, cpu, _, _, count, size, _, _ = unpack(data, endian + "8I", 0)
    if cpu not in ARCHES:
        raise MachOError(f"unsupported CPU type 0x{cpu:x}")
    commands = take(data, 32, size)
    offset, imports, identity = 0, [], None
    for _ in range(count):
        cmd, length = unpack(commands, endian + "II", offset)
        if length < 8 or length % 8:
            raise MachOError("invalid load-command size or alignment")
        command = take(commands, offset, length)
        if cmd in LOADS or cmd == 0xD:  # LC_ID_DYLIB is identity, not an import.
            name_offset, _, _, _ = unpack(command, endian + "4I", 8)
            if not 24 <= name_offset < length:
                raise MachOError("invalid dylib name offset")
            end = command.find(b"\0", name_offset)
            if end <= name_offset:
                raise MachOError("empty or unterminated dylib name")
            try:
                name = command[name_offset:end].decode("utf-8")
            except UnicodeDecodeError as exc:
                raise MachOError("invalid UTF-8 dylib name") from exc
            if cmd == 0xD:
                if identity is not None:
                    raise MachOError("duplicate LC_ID_DYLIB")
                identity = name
            else:
                imports.append(name)
        offset += length
    if offset != len(commands):
        raise MachOError("load-command count does not match sizeofcmds")
    return {"arch": ARCHES[cpu], "imports": sorted(set(imports)), "identity": identity}


def slices(data):
    magic = take(data, 0, 4)
    fat = {b"\xca\xfe\xba\xbe": (">", False), b"\xbe\xba\xfe\xca": ("<", False),
           b"\xca\xfe\xba\xbf": (">", True), b"\xbf\xba\xfe\xca": ("<", True)}.get(magic)
    if not fat:
        return [thin(data)]
    endian, wide = fat
    count = unpack(data, endian + "I", 4)[0]
    stride = 32 if wide else 20
    take(data, 8, count * stride)
    if count == 0:
        raise MachOError("empty universal binary")
    result, ranges, seen = [], [], set()
    for index in range(count):
        entry = 8 + index * stride
        cpu, _ = unpack(data, endian + "II", entry)
        if wide:
            offset, size, alignment, reserved = unpack(data, endian + "QQII", entry + 8)
            if reserved:
                raise MachOError("nonzero fat_arch_64 reserved field")
        else:
            offset, size, alignment = unpack(data, endian + "III", entry + 8)
        if alignment > 63 or offset % (1 << alignment) or offset < 8 + count * stride:
            raise MachOError("invalid universal slice offset/alignment")
        if any(offset < end and start < offset + size for start, end in ranges):
            raise MachOError("overlapping universal slices")
        image = thin(take(data, offset, size))
        if ARCHES.get(cpu) != image["arch"] or cpu in seen:
            raise MachOError("duplicate or mismatched universal CPU type")
        seen.add(cpu)
        ranges.append((offset, offset + size))
        result.append(image)
    return result


def allowed(name):
    return any(name.startswith(prefix) and posixpath.normpath(name).startswith(prefix)
               for prefix in ALLOW)


def inspect(path, otool=None):
    images = slices(Path(path).read_bytes())
    for image in images:
        if otool:
            output = subprocess.run([otool, "-arch", image["arch"], "-L", str(path)],
                                    check=True, capture_output=True, text=True, timeout=60).stdout
            names = set(re.findall(r"^\s+(.+?) \(compatibility version .+\)$", output, re.MULTILINE))
            expected = set(image["imports"])
            if image["identity"] is not None:
                expected.add(image["identity"])
            if names != expected:
                raise MachOError(f"otool disagreement ({image['arch']}): parser={sorted(expected)}, "
                                 f"otool={sorted(names)}")
        image["disallowed"] = [name for name in image["imports"] if not allowed(name)]
    return {"path": str(path), "slices": images}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", metavar="OUT")
    parser.add_argument("--otool", default=shutil.which("otool"), metavar="PATH")
    parser.add_argument("--expect-disallowed", metavar="INSTALL_NAME")
    parser.add_argument("--require-universal", action="store_true")
    parser.add_argument("macho", nargs="+", metavar="MACHO")
    args = parser.parse_args()
    try:
        binaries = [inspect(path, args.otool) for path in args.macho]
        ok = True
        for binary in binaries:
            if args.require_universal and {s["arch"] for s in binary["slices"]} != set(ARCHES.values()):
                raise MachOError(f"{binary['path']}: expected arm64 and x86_64 slices")
            for image in binary["slices"]:
                bad = image["disallowed"]
                accepted = bad == [args.expect_disallowed] if args.expect_disallowed else not bad
                ok = ok and accepted
                print(f"{'ok  ' if accepted else 'FAIL'} {binary['path']} [{image['arch']}]: "
                      f"imports={image['imports']}, disallowed={bad}")
        print(f"m-imports: {'PASS' if ok else 'FAIL'} ({len(binaries)} binaries)")
        if args.json:
            Path(args.json).write_text(json.dumps({"schema": "render-stream-m-imports/1",
                "allow": ALLOW, "binaries": binaries, "ok": ok}, indent=2) + "\n", encoding="utf-8")
        return 0 if ok else 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"m-imports: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
