#!/usr/bin/env python3
"""Add a fail-closed x86-64 CanvasTexture record to an existing calibration.

Only the inspected Godot 4.5.1 GCC instruction shapes are accepted. Addresses come
from the exact binary, never from another build. This does not execute the binary.
MinGW PE records decode operands independently; Mach-O remains unsupported.
"""

import argparse
import hashlib
import json
import re
import struct
from pathlib import Path

from calibrate import CalibrationError, Elf, find_vtable


def derive(binary, base):
    if base["engine"]["platform"] == "windows-x86_64":
        from ctres_pe import derive_windows
        return derive_windows(binary, base)
    image = Elf(str(binary))
    if base["engine"]["platform"] != "linux-x86_64":
        raise ValueError("Linux x86-64 records only")
    if hashlib.sha256(image.data).hexdigest() != base["engine"]["sha256"]:
        raise ValueError("base fingerprint does not match binary")

    def code(address, length):
        offset = image.vaddr_to_offset(address)
        if offset is None or offset + length > len(image.data):
            raise ValueError("code outside image")
        return image.data[offset:offset + length]

    table = int(base["rendering_server"]["concrete_vtable_vaddr"], 16) + 16
    create = image.read_u64(table + 8 * base["slots"]["canvas_texture_create"])
    # GCC queues the initialize forwarding function in a command object at +0x18.
    candidates = []
    for match in re.finditer(rb"\x48\xc7\x40\x18(.{4})", code(create, 0x180), re.S):
        address = struct.unpack("<I", match[1])[0]
        thunk = code(address, 13)
        if thunk[:3] == bytes.fromhex("488b3d") and thunk[7:] == bytes.fromhex("488b07ff6008"):
            candidates.append(address + 7 + struct.unpack_from("<i", thunk, 3)[0])
    if len(candidates) != 1:
        raise ValueError("no unique canvas initialize storage forwarding global")
    record = {"version": 1, "global": candidates[0]}
    evidence = {"create": hex(create), "global": hex(candidates[0]), "backends": {}}
    for prefix, name, owner, stride, validator, patterns in [
        ("rd", "N10RendererRD14TextureStorageE", 176, 144, 136,
         ["8b97cc000000", "f7b7c8000000", "488bbfb8000000", "488d14d248c1e204", "8b9288000000"]),
        ("gles3", "N5GLES314TextureStorageE", 128, 64, 56,
         ["8b979c000000", "f7b798000000", "488bbf88000000", "48c1e206", "8b4238"]),
    ]:
        names = image.find_bytes(name.encode() + b"\0")
        refs = [ref for address in names for ref in image.find_pointers_to(address)]
        if len(names) != 1 or len(refs) != 1:
            raise ValueError("ambiguous renderer RTTI: " + prefix)
        storage = find_vtable(image, refs[0] - 8, name)
        # Filter and repeat setters contain the complete inline typed owner lookup.
        for slot, write in [(5, "2c"), (6, "30")]:
            body = code(storage["slots"][slot], 128)
            if not all(bytes.fromhex(p) in body for p in patterns):
                raise ValueError("unsupported typed owner lookup: " + prefix)
            if not re.search(rb"\x89[\x70\x4a]" + bytes.fromhex(write), body):
                raise ValueError("unsupported sampling field: " + prefix)
        channel = code(storage["slots"][3], 192)
        # The setter must store diffuse at +0, normal at +8 and specular at +16.
        writes = ["488908", "48894808", "48894810"] if prefix == "rd" else ["48890a", "48894a08", "48894a10"]
        if not all(bytes.fromhex(p) in channel for p in writes):
            raise ValueError("unsupported channel stores: " + prefix)
        layout = {"vptr": storage["vtable_vaddr"] + 16, "owner": owner,
                  "stride": stride, "validator": validator, "diffuse": 0,
                  "normal": 8, "specular": 16, "filter": 44, "repeat": 48}
        record.update({prefix + "_" + key: value for key, value in layout.items()})
        evidence["backends"][prefix] = {"vptr": hex(layout["vptr"]),
                                          "setter": hex(storage["slots"][3]),
                                          "filter": hex(storage["slots"][5]),
                                          "repeat": hex(storage["slots"][6])}
    return {**base, "canvas_texture_storage": record}, evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--verify", action="store_true", help="rederive and compare storage fields in --base")
    args = parser.parse_args()
    try:
        base = json.loads(args.base.read_text())
        record, evidence = derive(args.binary, base)
        if args.verify:
            expected = base.get("canvas_texture_storage", {})
            actual = record["canvas_texture_storage"]
            differences = [f"{k}: record={expected.get(k)!r}, derived={actual.get(k)!r}"
                           for k in sorted(expected.keys() | actual.keys())
                           if expected.get(k) != actual.get(k)]
            if differences:
                raise ValueError("storage mismatch: " + "; ".join(differences))
            print(f"verified {len(actual)} storage fields")
            return
        if not args.out:
            raise ValueError("--out is required unless --verify is used")
    except (CalibrationError, ValueError, KeyError, OSError) as error:
        parser.exit(1, f"canvas calibration refused: {error}\n")
    args.out.write_text(json.dumps(record, indent=2) + "\n")
    args.out.with_suffix(".storage-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(f"calibrated RD + GLES3: {args.out}")


if __name__ == "__main__":
    main()
