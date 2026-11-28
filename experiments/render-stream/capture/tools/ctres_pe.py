"""Offline MinGW instruction-shape proofs; never execute or retain image code."""

import re
import subprocess

from calibrate import Pe, find_vtable


NAMES = {"rd": "N10RendererRD14TextureStorageE", "gles3": "N5GLES314TextureStorageE"}
REG = r"(?:r(?:[abcd]x|[sd]i|[sb]p|[89]|1[0-5])|e[abcd]x|r(?:[89]|1[0-5])d)"


def reg(value):
    if value.startswith("e"):
        return "r" + value[1:]
    return value.removesuffix("d") if value.startswith(("r8", "r9", "r1")) else value


def mem(operand):
    match = re.fullmatch(r"(?:QWORD|DWORD) PTR \[(\w+)(?:\+(0x[0-9a-f]+))?\]", operand)
    return (reg(match[1]), int(match[2] or "0", 16)) if match else None


def instructions(image, address, size):
    if not image.is_code(address) or not image.is_code(address + size - 1):
        raise ValueError("setter code outside executable image")
    run = subprocess.run(["objdump", "-d", "--no-show-raw-insn", "-Mintel",
                          f"--start-address={address}", f"--stop-address={address + size}",
                          image.path], capture_output=True, text=True, check=True)
    result = []
    for line in run.stdout.splitlines():
        match = re.match(r"\s*([0-9a-f]+):\s+([\w.]+)\s*(.*)", line)
        if match:
            mn, args = match[2], match[3].split("#")[0].strip()
            if mn.startswith("rex"):
                if len(args.split(None, 1)) != 2:
                    continue
                mn, args = args.split(None, 1)
            result.append((int(match[1], 16), mn, args))
    return result


def unique(values, why):
    if len(values) != 1:
        raise ValueError(f"{why}: expected one candidate, got {len(values)}")
    return values[0]


def lookup(ins):
    """Decode the two GCC inline RID lookup grammars, with wildcard displacements."""
    prefix = ins[:next((i for i, (_, op, _) in enumerate(ins) if op == "ret"), len(ins))]
    div_index = unique([i for i, (_, op, args) in enumerate(prefix)
                        if op == "div" and mem(args) and mem(args)[0] == "rcx"],
                       "elements_in_chunk division")
    elements = mem(ins[div_index][2])[1]
    loads = [(i, args.split(",", 1)) for i, (_, op, args) in enumerate(ins[:div_index])
             if op == "mov" and "," in args and mem(args.split(",", 1)[1])]
    _, maximum = unique([(i, mem(ops[1])[1]) for i, ops in loads if mem(ops[1])[0] == "rcx"],
                        "max_alloc load")
    i = div_index + 1
    if ins[i][1] == "shr":  # validator's high RID word may be scheduled here
        i += 1
    if ins[i][1] != "mov" or not ins[i][2].startswith("rcx,QWORD PTR [rcx+"):
        raise ValueError("unsupported chunks load")
    chunks = mem(ins[i][2].split(",", 1)[1])[1]
    owner = chunks - 8
    if owner < 0 or elements != owner + 24 or maximum != owner + 28:
        raise ValueError("RID_Alloc prefix displacements disagree")
    i += 1
    loaded_chunk = ins[i][1:] == ("mov", "rax,QWORD PTR [rcx+rax*8]")
    if loaded_chunk:
        i += 1
    elif ins[i][1:] == ("mov", "edx,edx"):
        i += 1
    multiplier = 1
    if ins[i][1] == "lea":
        m = re.fullmatch(r"(\w+),\[rdx\+rdx\*([248])\]", ins[i][2])
        if not m:
            raise ValueError("unsupported stride lea")
        stride_reg, multiplier = m[1], 1 + int(m[2])
        i += 1
    else:
        stride_reg = "rdx"
    shift = re.fullmatch(r"(\w+),(0x[0-9a-f]+)", ins[i][2])
    if ins[i][1] != "shl" or not shift or shift[1] != stride_reg:
        raise ValueError("unsupported stride shift")
    stride = multiplier << int(shift[2], 16)
    if not 8 <= stride <= 4096:
        raise ValueError("unsupported stride extent")
    i += 1
    if not loaded_chunk:
        if ins[i][1:] != ("add", f"{stride_reg},QWORD PTR [rcx+rax*8]"):
            raise ValueError("unsupported chunk/element addition")
        i += 1
        if ins[i][1:] == ("mov", f"rax,{stride_reg}"):
            i += 1
        operand = ins[i][2].split(",", 1)
        field = mem(operand[1]) if len(operand) == 2 else None
        if ins[i][1] != "mov" or not field or field[0] != stride_reg:
            raise ValueError("unsupported validator load")
        validator = field[1]
        element_reg = "rax" if stride_reg == "rdx" and operand[0] == "edx" else stride_reg
    else:
        m = re.fullmatch(r"(\w+),DWORD PTR \[rax\+" + stride_reg + r"\*1\+(0x[0-9a-f]+)\]", ins[i][2])
        if ins[i][1] != "mov" or not m:
            raise ValueError("unsupported indexed validator load")
        validator = int(m[2], 16)
        element_reg = "rax"
    validator_reg = reg(ins[i][2].split(",")[0])
    i += 1
    if ins[i][1] != "cmp" or not ins[i][2].startswith(
            (validator_reg + ",", "e" + validator_reg[1:] + ",")):
        raise ValueError("missing validator comparison")
    i += 1
    if ins[i][1] != "jne":
        raise ValueError("missing validator rejection")
    i += 1
    if loaded_chunk:
        if ins[i][1:] != ("add", f"rax,{stride_reg}"):
            raise ValueError("unsupported element address")
        i += 1
    return {"owner": owner, "stride": stride, "validator": validator}, i, element_reg


def channel_store(ins, start, element_reg, channel):
    """Follow only channel selector branches, with element-address register aliases."""
    positions = {a: i for i, (a, _, _) in enumerate(ins)}
    aliases = {element_reg: 0}
    zero = None
    i = start
    for _ in range(48):
        _, op, args = ins[i]
        ops = args.split(",", 1)
        if op == "mov" and len(ops) == 2 and ops[1] in aliases:
            aliases[ops[0]] = aliases[ops[1]]
        elif op == "lea" and len(ops) == 2:
            m = re.fullmatch(r"\[(\w+)\+(0x[0-9a-f]+)\]", ops[1])
            if not m or m[1] not in aliases:
                raise ValueError("unsupported channel address")
            aliases[ops[0]] = aliases[m[1]] + int(m[2], 16)
        elif op in ("cmp", "test") and ops[0] == "r8d":
            zero = channel == (0 if op == "test" else int(ops[1], 0))
        elif op in ("je", "jne", "jmp"):
            if op != "jmp" and zero is None:
                raise ValueError("unsupported channel branch")
            if op == "jmp" or (zero if op == "je" else not zero):
                target = int(args.split()[0], 16)
                if target not in positions:
                    raise ValueError("channel branch outside window")
                i = positions[target]
                continue
        elif op == "mov" and len(ops) == 2 and ops[1] == "r9":
            field = mem(ops[0])
            if field and field[0] in aliases:
                return aliases[field[0]] + field[1]
            raise ValueError("unsupported channel store")
        else:
            raise ValueError("unsupported channel selector instruction: " + op)
        i += 1
    raise ValueError("channel selector exceeds bounded window")


def chunk_limit(ins, owner, elements):
    """Prove the allocation quotient is compared with owner.chunk_limit."""
    candidates = []
    for i, (_, op, args) in enumerate(ins):
        field = mem(args)
        if op != "div" or not field or field[1] != elements:
            continue
        base = field[0]
        quotient = "rax"
        for _, next_op, next_args in ins[i + 1:i + 4]:
            ops = next_args.split(",", 1)
            if next_op == "mov" and len(ops) == 2 and reg(ops[1]) == quotient:
                quotient = reg(ops[0])
            elif next_op == "cmp" and len(ops) == 2:
                for a, b in (ops, ops[::-1]):
                    m = mem(a)
                    if m and m[0] == base and reg(b) == quotient:
                        candidates.append(m[1] - owner)
                break
            else:
                break
    limit = unique(candidates, "allocation chunk_limit comparison")
    if limit != 36:
        raise ValueError("allocation chunk_limit differs from runtime RID_Alloc prefix")
    return limit


def derive_windows(binary, base):
    image = Pe(str(binary))
    engine = base["engine"]
    if image.image_sha256()[0] != engine["image_sha256"]:
        raise ValueError("base image_sha256 does not match PE")
    if image.codeview() != engine["codeview_id"]:
        raise ValueError("base codeview_id does not match PE")
    table = int(base["rendering_server"]["concrete_vtable_vaddr"], 16) + 16
    create = image.read_u64(table + 8 * base["slots"]["canvas_texture_create"])
    ins = instructions(image, create, 64)
    globals_ = []
    for i, (address, op, args) in enumerate(ins[:-2]):
        m = re.fullmatch(r"(\w+),QWORD PTR \[rip([+-]0x[0-9a-f]+)\]", args)
        if op != "mov" or not m:
            continue
        vload, call = ins[i + 1:i + 3]
        v = vload[2].split(",", 1)
        if vload[1] == "mov" and len(v) == 2 and v[1] == f"QWORD PTR [{m[1]}]" and \
                call[1:] == ("call", f"QWORD PTR [{v[0]}]"):
            globals_.append(address + 7 + int(m[2], 16))
    if not globals_:
        # A non-inlined MinGW forwarding thunk may load the global through an
        # image-owned pointer. Decode the thunk, including its tail dispatch.
        for _, op, args in ins:
            if op != "call" or not re.fullmatch(r"(?:0x)?[0-9a-f]+(?: .*)?", args):
                continue
            thunk = instructions(image, int(args.split()[0], 16), 16)
            if len(thunk) != 4:
                continue
            a, load, vload, tail = thunk
            m = re.fullmatch(r"(\w+),QWORD PTR \[rip([+-]0x[0-9a-f]+)\]", a[2])
            if a[1] == "mov" and m and load[1:] == ("mov", f"rcx,QWORD PTR [{m[1]}]") and \
                    vload[1:] == ("mov", "rax,QWORD PTR [rcx]") and \
                    tail[1:] == ("jmp", "QWORD PTR [rax]"):
                pointer = a[0] + 7 + int(m[2], 16)
                if not any(s["addr"] <= pointer and pointer + 8 <= s["addr"] + s["size"] and
                           s["flags"] & 0x40000000 and not s["flags"] & 0xA0000000
                           for s in image.sections):
                    raise ValueError("forwarding global pointer outside readonly image")
                globals_.append(image.read_u64(pointer))
    global_ = unique(globals_, "canvas create storage global")
    if not any(s["addr"] <= global_ and global_ + 8 <= s["addr"] + s["virtual_size"] and
               s["flags"] & 0xC0000000 == 0xC0000000 and not s["flags"] & 0x20000000
               for s in image.sections):
        raise ValueError("storage global outside writable non-executable PE section")
    record = {"version": 1, "global": global_}
    evidence = {"create": hex(create), "global": hex(global_), "backends": {}}
    for prefix, name in NAMES.items():
        names = image.find_bytes(name.encode() + b"\0")
        address = unique(names, prefix + " RTTI name")
        ref = unique(image.find_pointers_to(address), prefix + " typeinfo name reference")
        storage = find_vtable(image, ref - 8, name)
        layouts = []
        for slot in (5, 6):
            body = instructions(image, storage["slots"][slot], 192)
            layout, i, element = lookup(body)
            write = body[i]
            ops = write[2].split(",", 1)
            field = mem(ops[0])
            if write[1] != "mov" or len(ops) != 2 or ops[1] != "r8d" or not field or field[0] != element:
                raise ValueError(prefix + " unsupported sampling store")
            layouts.append((layout, field[1]))
        if layouts[0][0] != layouts[1][0]:
            raise ValueError(prefix + " filter/repeat owner/stride/validator disagreement")
        layout = layouts[0][0]
        body = instructions(image, storage["slots"][3], 384)
        channel_layout, start, element = lookup(body)
        if channel_layout != layout:
            raise ValueError(prefix + " channel/sampling layout disagreement")
        channels = [channel_store(body, start, element, c) for c in range(3)]
        if len(set(channels)) != 3 or any(c < 0 or c + 8 > layout["validator"] for c in channels):
            raise ValueError(prefix + " inconsistent channel fields")
        limit = chunk_limit(instructions(image, storage["slots"][0], 192),
                            layout["owner"], layout["owner"] + 24)
        layout = {"vptr": storage["address_point"], **layout,
                  **dict(zip(("diffuse", "normal", "specular"), channels)),
                  "filter": layouts[0][1], "repeat": layouts[1][1]}
        if layout["filter"] == layout["repeat"] or any(
                layout[k] < 0 or layout[k] + 4 > layout["validator"] for k in ("filter", "repeat")):
            raise ValueError(prefix + " inconsistent sampling fields")
        record.update({prefix + "_" + k: v for k, v in layout.items()})
        evidence["backends"][prefix] = {"vptr": hex(layout["vptr"]),
            "allocation": hex(storage["slots"][0]), "chunk_limit": limit,
            "chunk_limit_proof": "allocation quotient compared with owner-relative field",
            "setter": hex(storage["slots"][3]), "filter": hex(storage["slots"][5]),
            "repeat": hex(storage["slots"][6])}
    return {**base, "canvas_texture_storage": record}, evidence
