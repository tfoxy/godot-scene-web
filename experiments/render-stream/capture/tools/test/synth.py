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
SLOT_COUNT = 161
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
        if variant == "placeholder-tie":
            # Two placeholders with equal counts; an odd count leaves its last slot a third value.
            odd = len(pure_indices) % 2
            if odd and i == pure_indices[-1]:
                value = placeholder + 32
            elif i in pure_indices[len(pure_indices) // 2:len(pure_indices) - odd]:
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


def macho(path, chained=False, fat=True, pointer_format=6, code=None):
    """Stripped universal fixture; x86 uses dyld opcodes, arm64 chained pointers."""
    import tempfile

    def uleb(value):
        out = bytearray()
        while value >= 128:
            out.append((value & 127) | 128)
            value >>= 7
        return out + bytes([value])

    def thin(arch, chain):
        with tempfile.TemporaryDirectory() as temp:
            elfpath = Path(temp) / "source"
            facts = build(elfpath, "elf")
            source = calibrate.Elf(str(elfpath))
        base = 0x100000000
        data = bytearray(source.data[0x4000:0x5000])
        strings = bytearray(data[:0x100])
        strings[0] = ord("X")  # RTTI names are packed, not NUL-preceded.
        data[:0x100] = bytes(0x100)
        text = bytearray(source.data[0x1000:0x3000])
        if arch == "arm64":
            for k in range(300):
                text[k * 16:k * 16 + 4] = bytes.fromhex("c0035fd6")  # ret
        if code is not None:
            code(arch, text, base + 0x1000, base + facts["concrete"] - 0x400000)
        fixups = {}
        for off in range(0x100, len(data), 8):
            value = struct.unpack_from("<Q", data, off)[0]
            if 0x400000 <= value < 0x405000:
                value += base - 0x400000
                if base + 0x4000 <= value < base + 0x4100:
                    value -= 0x1000  # names live in __TEXT,__const
                struct.pack_into("<Q", data, off, value)
                fixups[off] = value
        av = facts["abstract"] - 0x404000
        for k in range(SLOT_COUNT):
            off = av + 16 + k * 8
            if struct.unpack_from("<Q", data, off)[0] == 0:
                fixups[off] = None
        link = bytearray()
        if chain:
            positions = sorted(fixups)
            for k, off in enumerate(positions):
                value = fixups[off]
                nxt = (positions[k + 1] - off) // 4 if k + 1 < len(positions) else 0
                word = (1 << 63) if value is None else value - (base if pointer_format == 6 else 0)
                struct.pack_into("<Q", data, off, word | (nxt << 51))
            # Header, starts-in-image (3 segments), starts-in-segment, import, symbols.
            starts = struct.pack("<4I", 3, 0, 16, 0)
            starts += struct.pack("<IHHQIH", 24, 4096, pointer_format, 0x4000, 0, 1)
            starts += struct.pack("<H", positions[0])
            imports = 28 + len(starts)
            link = bytearray(struct.pack("<7I", 0, 28, imports, imports + 4, 1, 1, 0))
            link += starts + struct.pack("<I", 1) + b"___cxa_pure_virtual\0"
            dyld = struct.pack("<4I", 0x80000034, 16, 0x5000, len(link))
        else:
            rebase, bind = bytearray(b"\x11"), bytearray(b"\x11\x40___cxa_pure_virtual\0\x51")
            for off, value in sorted(fixups.items()):
                if value is None:
                    bind += b"\x71" + uleb(off) + b"\x90"
                else:
                    rebase += b"\x21" + uleb(off) + b"\x51"
            rebase += b"\0"
            bind += b"\0"
            link = rebase + bind
            dyld = struct.pack("<12I", 0x80000022, 48, 0x5000, len(rebase),
                               0x5000 + len(rebase), len(bind), 0, 0, 0, 0, 0, 0)

        def segment(name, off, length, sections):
            cmd = bytearray(struct.pack("<II16sQQQQIIII", 0x19, 72 + 80 * len(sections),
                                       name.encode(), base + off, length, off, length, 7, 5 if name == "__TEXT" else 3,
                                       len(sections), 0))
            for sn, fo, length, flags in sections:
                cmd += struct.pack("<16s16sQQ8I", sn.encode(), name.encode(), base + fo,
                                   length, fo, 3, 0, 0, flags, 0, 0, 0)
            return cmd

        commands = segment("__TEXT", 0, 0x4000, [("__text", 0x1000, len(text), 0x80000400),
                                                 ("__const", 0x3000, len(strings), 0)])
        commands += segment("__DATA_CONST", 0x4000, len(data), [("__const", 0x4000, len(data), 0)])
        commands += segment("__LINKEDIT", 0x5000, len(link), [])
        uuid = bytes([1 if arch == "arm64" else 2, int(chain)]) + bytes(range(2, 16))
        commands += struct.pack("<II16s", 0x1B, 24, uuid) + dyld
        out = bytearray(0x5000 + len(link))
        struct.pack_into("<8I", out, 0, 0xFEEDFACF, {"arm64": 0x0100000C, "x86_64": 0x01000007}[arch],
                         0 if arch == "arm64" else 3, 2, 5, len(commands), 0x200000, 0)
        out[32:32 + len(commands)] = commands
        out[0x1000:0x3000], out[0x3000:0x3100], out[0x4000:0x5000] = text, strings, data
        out[0x5000:] = link
        return out

    x86 = thin("x86_64", chained)
    arm = thin("arm64", True)
    if fat:
        armoff = (0x1000 + len(x86) + 0xFFF) & ~0xFFF
        out = bytearray(armoff + len(arm))
        struct.pack_into(">II", out, 0, 0xCAFEBABE, 2)
        struct.pack_into(">5I", out, 8, 0x01000007, 3, 0x1000, len(x86), 12)
        struct.pack_into(">5I", out, 28, 0x0100000C, 0, armoff, len(arm), 12)
        out[0x1000:0x1000 + len(x86)], out[armoff:] = x86, arm
    else:
        out = x86
    Path(path).write_bytes(out)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--write-pe":
        build(sys.argv[2], "pe-code")
    else:
        raise SystemExit("usage: synth.py --write-pe PATH")
