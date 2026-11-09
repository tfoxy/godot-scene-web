"""Deterministic, non-executable-by-the-tests ELF and Itanium PE fixtures."""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import calibrate

ANCHORS = (0, 2, 3, 7, 40)
GUID = bytes(range(16))
IMAGE_BASE = 0x140000000
STAMP = 0x5EED0001
SLOT_COUNT = 140
PREFIX = 5


def declarations():
    names = iter(accepted[0] for _, accepted in calibrate.WANTED_SLOTS)
    result = []
    for i in range(SLOT_COUNT - PREFIX):
        result.append((f"synth_anchor_{i}", False) if i in ANCHORS else (next(names), True))
    assert next(names, None) is None
    return result


def fixture_header(path):
    lines = ["class RenderingServer : public Object {"]
    for name, pure in declarations():
        lines.append(f"  virtual void {name}(RID p) = 0;" if pure else
                     f"  virtual bool {name}() const {{ return false; }}")
    lines += ["  virtual ~RenderingServer();", "};", ""]
    Path(path).write_text("\n".join(lines))


def build(path, variant, code=None):
    pe = variant not in ("elf", "elf-pie")
    code_placeholder = variant in ("pe-code", "placeholder-tie", "mixed-placeholder")
    base = IMAGE_BASE if pe else (0 if variant == "elf-pie" else 0x400000)
    text_va, rdata_va = base + 0x1000, base + 0x4000
    text = bytearray(b"\xcc" * 0x2000)
    for i in range(300):
        text[i * 16] = 0xC3
    placeholder = text_va + 0x1F00
    data = bytearray(0x1000)
    relocations = []

    def put(off, value, unresolved=False):
        struct.pack_into("<Q", data, off, value)
        if value or unresolved:
            relocations.append((rdata_va + off, value, unresolved))

    for off, string in ((1, b"15RenderingServer"), (32, b"22RenderingServerDefault"),
                        (80, b"Godot Engine v4.5.1.stable.synthetic")):
        data[off:off + len(string)] = string
    if variant == "msvc-rtti":
        data[1:19] = b"X" * 18
        data[128:149] = b".?AVRenderingServer@@\0"
    ati, cti = 0x100, 0x120
    put(ati, text_va)
    put(ati + 8, rdata_va + 1)
    put(ati + 16, rdata_va + 0xE0)
    put(cti, text_va)
    put(cti + 8, rdata_va + 32)
    put(cti + 16, rdata_va + ati)
    av = 0x180
    cv = av + 16 + SLOT_COUNT * 8
    put(av + 8, rdata_va + ati)
    put(cv + 8, rdata_va + cti)
    mask = [True, True, True, code_placeholder, code_placeholder] + [not pure for _, pure in declarations()]
    pure_indices = [i for i, flag in enumerate(mask) if not flag]
    # Code placeholders still represent every pure declaration.
    if code_placeholder:
        pure_indices = [PREFIX + i for i, (_, pure) in enumerate(declarations()) if pure]
    for i in range(SLOT_COUNT):
        impl = text_va + i * 16
        value = impl if mask[i] else (placeholder if code_placeholder else 0)
        if code_placeholder and i in pure_indices:
            value = placeholder
        if code_placeholder and i in (3, 4):
            value = text_va + (200 + i) * 16
        if variant == "placeholder-tie" and i in pure_indices[len(pure_indices) // 2:]:
            value = placeholder + 16
        if variant == "mixed-placeholder" and i == pure_indices[0]:
            value = 0
        put(av + 16 + i * 8, value, unresolved=variant == "elf-pie" and not mask[i])
        put(cv + 16 + i * 8, impl)
    struct.pack_into("<Q", data, cv + 16 + SLOT_COUNT * 8, 0xDEADBEEF)

    code_facts = {}
    if code is not None:
        code_facts = code(text, text_va, rdata_va, cv + 16) or {}

    if pe:
        blocks = bytearray()
        pages = {}
        unrelocated = rdata_va + cv + 16 + 8 * 10
        for addr, value, _ in relocations:
            if variant == "unrelocated-word" and addr == unrelocated:
                continue
            rva = addr - base
            pages.setdefault(rva & ~0xFFF, []).append(0xA000 | (rva & 0xFFF))
        for page, entries in sorted(pages.items()):
            if len(entries) % 2:
                entries.append(0)
            blocks += struct.pack("<II", page, 8 + len(entries) * 2)
            blocks += struct.pack("<" + "H" * len(entries), *entries)
        debug = bytearray(0x200)
        if code_placeholder:
            rsds = b"RSDS" + GUID + struct.pack("<I", 3) + b"synthetic.pdb\0"
            debug[32:32 + len(rsds)] = rsds
            struct.pack_into("<IIHHIIII", debug, 0, 0, STAMP, 0, 0, 2, len(rsds), 0x7020, 0x3820)
        sections = [(".text", 0x1000, text, 0x60000020, 0x400),
                    (".rdata", 0x4000, data, 0x40000040, 0x2400),
                    (".reloc", 0x6000, blocks, 0x42000040, 0x3400)]
        if code_placeholder:
            sections.append((".buildid", 0x7000, debug, 0x40000040, 0x3800))
        out = bytearray(0x3A00 if code_placeholder else 0x3800)
        out[:2] = b"MZ"
        struct.pack_into("<I", out, 0x3C, 0x80)
        out[0x80:0x84] = b"PE\0\0"
        struct.pack_into("<HHIIIHH", out, 0x84, 0xAA64 if variant == "machine-arm64" else 0x8664,
                         len(sections), STAMP, 0, 0, 240, 0x22)
        opt = 0x98
        struct.pack_into("<H", out, opt, 0x10B if variant == "pe32" else 0x20B)
        struct.pack_into("<Q", out, opt + 24, base)
        struct.pack_into("<II", out, opt + 32, 0x1000, 0x200)
        struct.pack_into("<II", out, opt + 56, 0x8000, 0x400)
        struct.pack_into("<H", out, opt + 70, 0x160)
        struct.pack_into("<I", out, opt + 108, 16)
        struct.pack_into("<II", out, opt + 112 + 5 * 8, 0x6000, len(blocks))
        if code_placeholder:
            struct.pack_into("<II", out, opt + 112 + 6 * 8, 0x7000, 28)
        for i, (name, va, content, flags, raw) in enumerate(sections):
            size = (len(content) + 0x1FF) & ~0x1FF
            struct.pack_into("<8sIIIIIIHHI", out, opt + 240 + i * 40, name.encode(), len(content), va,
                             size, raw, 0, 0, 0, 0, flags)
            out[raw:raw + len(content)] = content
        ranges = [(0, 0x400), (0x400, 0x2000), (0x2400, 0x1000)]
        expected = dict(codeview_id=GUID.hex() + ":3" if code_placeholder else None, time_date_stamp=STAMP,
                        size_of_image=0x8000, image_base=hex(base), dynamic_base=True,
                        dll_characteristics=0x160, image_hashed_bytes=sum(n for _, n in ranges))
    else:
        rela = bytearray()
        if variant == "elf-pie":
            for addr, value, unresolved in relocations:
                rela += struct.pack("<QQq", addr, (1 << 32) | 1 if unresolved else 8, 0 if unresolved else value)
        names = b"\0.text\0.rodata\0.data.rel.ro\0.rela.dyn\0.shstrtab\0"
        parts = [(".text", 1, 6, text_va, 0x1000, text, 0),
                 (".rodata", 1, 2, rdata_va, 0x4000, data[:0x100], 0),
                 (".data.rel.ro", 1, 3, rdata_va + 0x100, 0x4100, data[0x100:], 0),
                 (".rela.dyn", 4, 0, base + 0x6000, 0x6000, rela, 24),
                 (".shstrtab", 3, 0, 0, 0x9000, names, 0)]
        shoff = 0x9200
        out = bytearray(shoff + 64 * (len(parts) + 1))
        out[:16] = b"\x7fELF\x02\x01\x01" + bytes(9)
        struct.pack_into("<HHIQQQIHHHHHH", out, 16, 3 if variant == "elf-pie" else 2, 0x3E, 1,
                         0, 0, shoff, 0, 64, 56, 0, 64, len(parts) + 1, len(parts))
        for i, (name, kind, flags, va, off, content, entsize) in enumerate(parts, 1):
            out[off:off + len(content)] = content
            struct.pack_into("<IIQQQQIIQQ", out, shoff + i * 64, names.index(name.encode()), kind,
                             flags, va, off, len(content), 0, 0, 8, entsize)
        ranges, expected = [], {}
    Path(path).write_bytes(out)
    return dict(expected=expected, image_ranges=ranges, abstract=rdata_va + av, concrete=rdata_va + cv, code_facts=code_facts)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--write-pe":
        build(sys.argv[2], "pe-code")
    else:
        raise SystemExit("usage: synth.py --write-pe PATH")
