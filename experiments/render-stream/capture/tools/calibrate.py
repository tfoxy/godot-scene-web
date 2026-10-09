#!/usr/bin/env python3
"""Derive a RenderingServer vtable calibration record from a Godot ELF binary.

Gate -1 of docs/handoff-headless-render-stream.md. Stdlib only, read-only: the
binary is never modified and never executed.

What it does, in order:

1. Parses the ELF (sections, program headers, notes, dynamic relocations).
2. Finds the Itanium-ABI RTTI typeinfo name strings for `RenderingServer` and
   its concrete subclass, then the typeinfo objects that point at them, then the
   vtables that point at those typeinfo objects.
3. Walks each vtable from its address point and records, per slot, whether it
   holds a real code address ("implemented") or the pure-virtual placeholder.
4. Parses the ordered virtual-method list of `class RenderingServer` out of the
   pinned `servers/rendering_server.h`, honouring the release preprocessor
   define set, and derives the `Object` vtable prefix from the slot count.
5. Verifies that every non-pure method in the header lands on an implemented
   slot and every pure method on a placeholder slot, with the matching prefix
   unique, then emits the record.

The record is evidence, not a contract with the engine: the extension re-checks
every claim against live memory before it writes anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys

CALIBRATOR_VERSION = "1"
SCHEMA = "render-stream-calibration/1"

# Slots the capture library needs, as `record key -> accepted header names`.
# Hooked slots plus read-only probe slots used for the behavioural method-bind
# cross-check. A key keeps its name in the record even when the engine renamed
# the method (4.6 renamed `RenderingServer::free` to `free_rid`).
WANTED_SLOTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("canvas_item_add_rect", ("canvas_item_add_rect",)),
    ("canvas_item_add_texture_rect", ("canvas_item_add_texture_rect",)),
    ("canvas_item_add_texture_rect_region", ("canvas_item_add_texture_rect_region",)),
    ("canvas_item_add_msdf_texture_rect_region", ("canvas_item_add_msdf_texture_rect_region",)),
    ("canvas_item_add_polygon", ("canvas_item_add_polygon",)),
    ("texture_2d_create", ("texture_2d_create",)),
    ("texture_2d_update", ("texture_2d_update",)),
    ("free", ("free", "free_rid")),
    ("get_default_clear_color", ("get_default_clear_color",)),
)

ET_EXEC = 2
ET_DYN = 3
SHT_NOBITS = 8
SHT_RELA = 4
SHF_ALLOC = 0x2
SHF_EXECINSTR = 0x4
R_X86_64_64 = 1
R_X86_64_RELATIVE = 8


class CalibrationError(Exception):
    pass


class Elf:
    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, "rb") as handle:
            self.data = handle.read()
        d = self.data
        if d[:4] != b"\x7fELF":
            raise CalibrationError(f"{path}: not an ELF file")
        if d[4] != 2:
            raise CalibrationError(f"{path}: not ELFCLASS64")
        if d[5] != 1:
            raise CalibrationError(f"{path}: not little-endian")
        (self.e_type,) = struct.unpack_from("<H", d, 0x10)
        (e_machine,) = struct.unpack_from("<H", d, 0x12)
        if e_machine != 0x3E:
            raise CalibrationError(f"{path}: not x86-64 (e_machine={e_machine})")
        (self.e_phoff,) = struct.unpack_from("<Q", d, 0x20)
        (self.e_shoff,) = struct.unpack_from("<Q", d, 0x28)
        self.e_phentsize, self.e_phnum = struct.unpack_from("<HH", d, 0x36)
        self.e_shentsize, self.e_shnum, self.e_shstrndx = struct.unpack_from("<HHH", d, 0x3A)
        self.sections = self._read_sections()
        self.segments = self._read_segments()
        self.alloc = [s for s in self.sections if (s["flags"] & SHF_ALLOC) and s["type"] != SHT_NOBITS]
        self.exec_ranges = [
            (s["addr"], s["addr"] + s["size"]) for s in self.alloc if s["flags"] & SHF_EXECINSTR
        ]
        self.relocations = self._read_relocations()
        self.pie = self.e_type == ET_DYN

    def _read_sections(self) -> list[dict]:
        out = []
        for i in range(self.e_shnum):
            off = self.e_shoff + i * self.e_shentsize
            fields = struct.unpack_from("<IIQQQQIIQQ", self.data, off)
            out.append(
                {
                    "name_off": fields[0],
                    "type": fields[1],
                    "flags": fields[2],
                    "addr": fields[3],
                    "offset": fields[4],
                    "size": fields[5],
                    "link": fields[6],
                    "entsize": fields[9],
                }
            )
        strtab = out[self.e_shstrndx]["offset"]
        for s in out:
            start = strtab + s["name_off"]
            end = self.data.index(b"\0", start)
            s["name"] = self.data[start:end].decode("utf-8", "replace")
        return out

    def _read_segments(self) -> list[dict]:
        out = []
        for i in range(self.e_phnum):
            off = self.e_phoff + i * self.e_phentsize
            p_type, p_flags, p_offset, p_vaddr, _p_paddr, p_filesz, p_memsz, _align = struct.unpack_from(
                "<IIQQQQQQ", self.data, off
            )
            out.append(
                {
                    "type": p_type,
                    "flags": p_flags,
                    "offset": p_offset,
                    "vaddr": p_vaddr,
                    "filesz": p_filesz,
                    "memsz": p_memsz,
                }
            )
        return out

    def _read_relocations(self) -> dict[int, int | None]:
        """Map target vaddr -> link-time value, for relocations we can resolve.

        `None` means "relocated against something we cannot resolve statically"
        (an undefined dynamic symbol, e.g. `__cxa_pure_virtual` from libstdc++).
        Non-PIE release templates have no relocations inside vtables at all;
        this exists so the calibrator also behaves on a PIE build.
        """
        out: dict[int, int | None] = {}
        for s in self.sections:
            if s["type"] != SHT_RELA or not s["entsize"]:
                continue
            count = s["size"] // s["entsize"]
            for i in range(count):
                off = s["offset"] + i * s["entsize"]
                r_offset, r_info, r_addend = struct.unpack_from("<QQq", self.data, off)
                r_type = r_info & 0xFFFFFFFF
                if r_type == R_X86_64_RELATIVE:
                    out[r_offset] = r_addend
                elif r_type == R_X86_64_64:
                    out[r_offset] = None
        return out

    def notes(self) -> list[tuple[str, int, bytes]]:
        out = []
        for s in self.sections:
            if s["type"] != 7:  # SHT_NOTE
                continue
            off, end = s["offset"], s["offset"] + s["size"]
            while off + 12 <= end:
                namesz, descsz, ntype = struct.unpack_from("<III", self.data, off)
                name_off = off + 12
                desc_off = name_off + ((namesz + 3) & ~3)
                desc_end = desc_off + descsz
                name = self.data[name_off : name_off + namesz].rstrip(b"\0").decode("ascii", "replace")
                out.append((name, ntype, self.data[desc_off:desc_end]))
                off = desc_end + ((-descsz) & 3)
        return out

    def build_id(self) -> str | None:
        for name, ntype, desc in self.notes():
            if name == "GNU" and ntype == 3:  # NT_GNU_BUILD_ID
                return desc.hex()
        return None

    def vaddr_to_offset(self, vaddr: int) -> int | None:
        for s in self.alloc:
            if s["addr"] <= vaddr < s["addr"] + s["size"]:
                return s["offset"] + (vaddr - s["addr"])
        return None

    def offset_to_vaddr(self, offset: int) -> int | None:
        for s in self.alloc:
            if s["offset"] <= offset < s["offset"] + s["size"]:
                return s["addr"] + (offset - s["offset"])
        return None

    def section_of(self, vaddr: int) -> str | None:
        for s in self.alloc:
            if s["addr"] <= vaddr < s["addr"] + s["size"]:
                return s["name"]
        return None

    def is_code(self, vaddr: int) -> bool:
        return any(lo <= vaddr < hi for lo, hi in self.exec_ranges)

    def read_u64(self, vaddr: int) -> int | None:
        """Link-time value of the pointer-sized word at `vaddr`.

        `None` when a dynamic relocation decides it (unresolvable statically).
        """
        if vaddr in self.relocations:
            return self.relocations[vaddr]
        off = self.vaddr_to_offset(vaddr)
        if off is None or off + 8 > len(self.data):
            return None
        (value,) = struct.unpack_from("<Q", self.data, off)
        return value

    def read_cstring(self, vaddr: int, limit: int = 256) -> str | None:
        off = self.vaddr_to_offset(vaddr)
        if off is None:
            return None
        end = self.data.find(b"\0", off, off + limit)
        if end < 0:
            return None
        raw = self.data[off:end]
        try:
            return raw.decode("ascii")
        except UnicodeDecodeError:
            return None

    def find_bytes(self, needle: bytes) -> list[int]:
        """All vaddrs of `needle` inside allocated sections."""
        out = []
        for match in re.finditer(re.escape(needle), self.data):
            vaddr = self.offset_to_vaddr(match.start())
            if vaddr is not None:
                out.append(vaddr)
        return out

    def find_pointers_to(self, target: int) -> list[int]:
        """All aligned vaddrs whose pointer-sized word equals `target`."""
        out = []
        for vaddr in self.find_bytes(struct.pack("<Q", target)):
            if vaddr % 8 == 0:
                out.append(vaddr)
        for addr, value in self.relocations.items():
            if value == target and addr % 8 == 0 and addr not in out:
                out.append(addr)
        return sorted(out)


# ---------------------------------------------------------------------------
# RTTI / vtable discovery
# ---------------------------------------------------------------------------


def mangled_name(class_name: str) -> bytes:
    return f"{len(class_name)}{class_name}".encode("ascii")


def find_typeinfo(elf: Elf, class_name: str) -> tuple[int, int]:
    """Return (typeinfo_name_vaddr, typeinfo_vaddr) for a top-level class."""
    needle = mangled_name(class_name) + b"\0"
    candidates = []
    for vaddr in elf.find_bytes(needle):
        off = elf.vaddr_to_offset(vaddr)
        assert off is not None
        if off > 0 and elf.data[off - 1 : off] != b"\0":
            continue  # tail of a longer mangled name
        candidates.append(vaddr)
    if not candidates:
        raise CalibrationError(f"typeinfo name {needle!r} not found")
    typeinfos = []
    for name_vaddr in candidates:
        for ref in elf.find_pointers_to(name_vaddr):
            # std::type_info layout: { vptr, name }, so the object starts 8 bytes
            # before the name pointer.
            typeinfos.append((name_vaddr, ref - 8))
    if len(typeinfos) != 1:
        raise CalibrationError(
            f"expected exactly one typeinfo for {class_name}, got {[hex(t[1]) for t in typeinfos]}"
        )
    return typeinfos[0]


def looks_like_typeinfo(elf: Elf, vaddr: int) -> bool:
    """Cheap test: a type_info object's second word points at a mangled name."""
    name_ptr = elf.read_u64(vaddr + 8)
    if not name_ptr:
        return False
    text = elf.read_cstring(name_ptr, 128)
    return bool(text) and bool(re.match(r"^(\d+[A-Za-z_]|N\d|P[A-Za-z0-9])", text))


def find_vtable(elf: Elf, typeinfo_vaddr: int, class_name: str) -> dict:
    """Locate the primary vtable for a single-inheritance class."""
    found = []
    for ref in elf.find_pointers_to(typeinfo_vaddr):
        offset_to_top = elf.read_u64(ref - 8)
        if offset_to_top != 0:
            continue  # typeinfo base pointer, or a secondary vtable
        found.append(ref)
    if len(found) != 1:
        raise CalibrationError(
            f"expected exactly one primary vtable for {class_name}, got {[hex(f) for f in found]}"
        )
    typeinfo_ref = found[0]
    vtable_vaddr = typeinfo_ref - 8
    address_point = typeinfo_ref + 8

    slots: list[int | None] = []
    index = 0
    while True:
        vaddr = address_point + 8 * index
        value = elf.read_u64(vaddr)
        if value is None:
            # A dynamic relocation decides this slot (e.g. __cxa_pure_virtual in
            # a PIE build). Treat it as a placeholder, flagged as unresolved.
            slots.append(None)
            index += 1
            continue
        if value == 0:
            # A zero can be a pure-virtual placeholder or the offset-to-top of
            # the next vtable in the section. Peek at the following word.
            following = elf.read_u64(vaddr + 8)
            if following and looks_like_typeinfo(elf, following):
                break
            slots.append(0)
            index += 1
            continue
        if not elf.is_code(value):
            break
        slots.append(value)
        index += 1
        if index > 4096:
            raise CalibrationError(f"{class_name}: vtable walk did not terminate")
    if not slots:
        raise CalibrationError(f"{class_name}: empty vtable")
    return {
        "class_name": class_name,
        "vtable_vaddr": vtable_vaddr,
        "address_point": address_point,
        "slots": slots,
    }


# ---------------------------------------------------------------------------
# Header parsing
# ---------------------------------------------------------------------------


def parse_virtuals(header_path: str, class_name: str, defines: set[str]) -> list[dict]:
    """Ordered list of virtual members declared directly by `class_name`.

    Itanium ABI vtable order is declaration order. Entries marked `override`
    reuse a base slot and are reported with `override: True`; so does a virtual
    destructor whose base destructor is already virtual (`Object` has one).
    """
    with open(header_path, encoding="utf-8") as handle:
        lines = handle.read().split("\n")

    opener = re.compile(r"^class\s+" + re.escape(class_name) + r"\b.*\{")
    try:
        start = next(i for i, line in enumerate(lines) if opener.match(line.strip()))
    except StopIteration as exc:
        raise CalibrationError(f"{header_path}: class {class_name} not found") from exc

    cond: list[bool | None] = []
    depth = 0
    entered = False
    out: list[dict] = []
    for i in range(start, len(lines)):
        raw = lines[i]
        text = raw.strip()
        directive = re.match(r"#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*(.*)", text)
        if directive:
            keyword, rest = directive.group(1), directive.group(2)
            if keyword == "ifdef":
                cond.append(rest.split()[0] in defines)
            elif keyword == "ifndef":
                cond.append(rest.split()[0] not in defines)
            elif keyword == "if":
                cond.append(None)
            elif keyword == "else":
                cond[-1] = (not cond[-1]) if cond[-1] is not None else None
            elif keyword == "elif":
                cond[-1] = None
            else:
                if not cond:
                    raise CalibrationError(f"{header_path}:{i + 1}: unbalanced #endif")
                cond.pop()
            continue
        if any(value is None for value in cond):
            raise CalibrationError(
                f"{header_path}:{i + 1}: unsupported preprocessor condition in {class_name}"
            )
        if not all(cond):
            continue
        if not entered:
            entered = True
            depth = raw.count("{") - raw.count("}")
            continue
        depth_before = depth
        depth += raw.count("{") - raw.count("}")
        if depth <= 0:
            break
        if depth_before != 1 or not text.startswith("virtual"):
            continue
        if "(" not in text:
            raise CalibrationError(f"{header_path}:{i + 1}: unparsed virtual declaration: {text}")
        head = text.split("(")[0]
        is_dtor = "~" in head
        name = "~" + class_name if is_dtor else re.findall(r"[A-Za-z_][A-Za-z0-9_]*", head)[-1]
        out.append(
            {
                "name": name,
                "pure": bool(re.search(r"=\s*0\s*;\s*(//.*)?$", text)),
                "override": " override" in text,
                "destructor": is_dtor,
                "line": i + 1,
            }
        )
    if cond:
        raise CalibrationError(f"{header_path}: unterminated preprocessor condition")
    if not out:
        raise CalibrationError(f"{header_path}: no virtual declarations found in {class_name}")
    return out


# ---------------------------------------------------------------------------
# Record assembly
# ---------------------------------------------------------------------------


def engine_version_string(elf: Elf) -> str:
    """The exact `GDExtensionGodotVersion2::string` literal (VERSION_FULL_NAME)."""
    candidates = set()
    for match in re.finditer(rb"Godot Engine v[0-9][ -~]{0,80}?\x00", elf.data):
        if elf.offset_to_vaddr(match.start()) is None:
            continue
        candidates.add(match.group()[:-1].decode("ascii"))
    if len(candidates) != 1:
        raise CalibrationError(f"expected one engine version string, got {sorted(candidates)}")
    return candidates.pop()


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def derive(
    elf: Elf,
    header_path: str,
    abstract_class: str,
    concrete_class: str,
    defines: set[str],
) -> dict:
    _name_vaddr, abstract_ti = find_typeinfo(elf, abstract_class)
    _name_vaddr2, concrete_ti = find_typeinfo(elf, concrete_class)
    abstract = find_vtable(elf, abstract_ti, abstract_class)
    concrete = find_vtable(elf, concrete_ti, concrete_class)

    slots = abstract["slots"]
    slot_count = len(slots)
    if len(concrete["slots"]) != slot_count:
        raise CalibrationError(
            f"{concrete_class} vtable has {len(concrete['slots'])} slots, "
            f"{abstract_class} has {slot_count}: the concrete class adds slots, "
            "which this calibrator does not model"
        )
    unimplemented = {value for value in slots if value is None or not elf.is_code(value)}
    if len(unimplemented) > 1:
        raise CalibrationError(
            f"{abstract_class}: pure-virtual slots are not uniform: {sorted(unimplemented, key=str)}"
        )
    concrete_pure = [i for i, value in enumerate(concrete["slots"]) if value is None or not elf.is_code(value)]
    if concrete_pure:
        raise CalibrationError(f"{concrete_class}: unexpected non-code slots at {concrete_pure}")

    virtuals = parse_virtuals(header_path, abstract_class, defines)
    new_slots = [v for v in virtuals if not v["override"] and not v["destructor"]]
    expected_pure = [v["pure"] for v in new_slots]
    if len(new_slots) > slot_count:
        raise CalibrationError(
            f"header declares {len(new_slots)} new virtuals but the vtable has {slot_count} slots"
        )
    implemented = [value is not None and elf.is_code(value) for value in slots]

    def matches(prefix: int) -> bool:
        return all(implemented[prefix + i] == (not pure) for i, pure in enumerate(expected_pure))

    prefix = slot_count - len(new_slots)
    viable = [p for p in range(0, slot_count - len(new_slots) + 1) if matches(p)]
    if prefix not in viable:
        mismatches = [
            (i, new_slots[i]["name"], "pure" if pure else "implemented")
            for i, pure in enumerate(expected_pure)
            if implemented[prefix + i] == pure
        ]
        raise CalibrationError(
            f"header/binary mask mismatch at prefix {prefix}: "
            f"{len(mismatches)} of {len(expected_pure)} slots disagree, first few {mismatches[:8]}"
        )
    if viable != [prefix]:
        raise CalibrationError(
            f"prefix is ambiguous: mask also matches at {[p for p in viable if p != prefix]}"
        )

    anchors = {
        v["name"]: prefix + i for i, v in enumerate(new_slots) if not v["pure"]
    }
    index_by_name: dict[str, int] = {}
    for i, v in enumerate(new_slots):
        if v["name"] in index_by_name:
            raise CalibrationError(
                f"{abstract_class}::{v['name']} is overloaded; slot lookup by name is ambiguous"
            )
        index_by_name[v["name"]] = prefix + i

    wanted = {}
    for key, accepted in WANTED_SLOTS:
        match = next((name for name in accepted if name in index_by_name), None)
        if match is None:
            raise CalibrationError(
                f"{abstract_class}::{'/'.join(accepted)} not declared in the header"
            )
        wanted[key] = index_by_name[match]
    return {
        "abstract": abstract,
        "concrete": concrete,
        "prefix": prefix,
        "slot_count": slot_count,
        "anchors": anchors,
        "slots": wanted,
        "new_slot_count": len(new_slots),
        "pure_placeholder": sorted(unimplemented, key=str),
    }


def build_record(args: argparse.Namespace) -> dict:
    elf = Elf(args.binary)
    derived = derive(elf, args.header, args.abstract_class, args.concrete_class, set(args.define))
    flavor = args.flavor
    if flavor == "auto":
        flavor = "template_debug" if "debug" in os.path.basename(args.binary) else "template_release"
    return {
        "schema": SCHEMA,
        "engine": {
            "version_string": engine_version_string(elf),
            "build_id": elf.build_id(),
            "sha256": sha256_file(args.binary),
            "platform": "linux-x86_64",
            "flavor": flavor,
            "pie": elf.pie,
        },
        "rendering_server": {
            "abstract_vtable_vaddr": hex(derived["abstract"]["vtable_vaddr"]),
            "concrete_class": args.concrete_class,
            "concrete_vtable_vaddr": hex(derived["concrete"]["vtable_vaddr"]),
            "object_prefix": derived["prefix"],
            "slot_count": derived["slot_count"],
            "anchors_total": len(derived["anchors"]),
            "anchors_matched": len(derived["anchors"]),
        },
        "slots": derived["slots"],
        "anchors": derived["anchors"],
        "calibrator": {
            "version": CALIBRATOR_VERSION,
            "header_sha256": sha256_file(args.header),
        },
    }, derived


def report_mask(args: argparse.Namespace) -> int:
    """Print the raw vtable facts without deriving anything from a header.

    Used for a binary whose matching `rendering_server.h` is not available
    locally: the implemented-slot mask is a measurement, the Object prefix is
    not derivable from it alone.
    """
    elf = Elf(args.binary)
    _n1, abstract_ti = find_typeinfo(elf, args.abstract_class)
    _n2, concrete_ti = find_typeinfo(elf, args.concrete_class)
    abstract = find_vtable(elf, abstract_ti, args.abstract_class)
    concrete = find_vtable(elf, concrete_ti, args.concrete_class)
    implemented = [i for i, v in enumerate(abstract["slots"]) if v is not None and elf.is_code(v)]
    print(f"binary: {args.binary}")
    print(f"version: {engine_version_string(elf)}")
    print(f"sha256: {sha256_file(args.binary)}")
    print(f"pie: {elf.pie}  build_id: {elf.build_id()}")
    print(f"{args.abstract_class} vtable: {hex(abstract['vtable_vaddr'])} slots {len(abstract['slots'])}")
    print(f"{args.concrete_class} vtable: {hex(concrete['vtable_vaddr'])} slots {len(concrete['slots'])}")
    print(f"implemented slots ({len(implemented)}): {implemented}")
    print(f"implemented-slot gaps: {[b - a for a, b in zip(implemented, implemented[1:])]}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", required=True, help="Godot ELF binary to calibrate against")
    parser.add_argument("--header", help="matching servers/rendering_server.h")
    parser.add_argument(
        "--mask-only",
        action="store_true",
        help="report the measured vtable mask and stop (no header, no record)",
    )
    parser.add_argument("--out", help="write the record here (default: stdout)")
    parser.add_argument("--abstract-class", default="RenderingServer")
    parser.add_argument("--concrete-class", default="RenderingServerDefault")
    parser.add_argument(
        "--define",
        action="append",
        default=[],
        help="preprocessor define active in the build (default: the release set, none)",
    )
    parser.add_argument(
        "--flavor",
        default="auto",
        choices=["auto", "template_release", "template_debug"],
        help="engine flavor recorded in the record",
    )
    args = parser.parse_args(argv)

    try:
        if args.mask_only:
            return report_mask(args)
        if not args.header:
            parser.error("--header is required unless --mask-only is given")
        record, derived = build_record(args)
    except CalibrationError as exc:
        print(f"calibrate: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(record, indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)

    rs = record["rendering_server"]
    print(
        f"calibrate: {os.path.basename(args.binary)} {record['engine']['version_string']}\n"
        f"  abstract vtable {rs['abstract_vtable_vaddr']} concrete {rs['concrete_vtable_vaddr']}\n"
        f"  slots {rs['slot_count']} = object prefix {rs['object_prefix']} + "
        f"{derived['new_slot_count']} RenderingServer virtuals\n"
        f"  anchors {rs['anchors_matched']}/{rs['anchors_total']} matched, "
        f"pure placeholder {derived['pure_placeholder']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
