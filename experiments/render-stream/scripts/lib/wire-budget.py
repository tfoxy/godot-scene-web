#!/usr/bin/env python3
"""WB (results/p3/wb.md): the warm wire budget of a render-stream recording, offline.

Reads a /2..=/10 file recording (and its payload store) without validating it, tracks the resolved
item, canvas and mesh state, and reports per scene, per warm patch transaction:

- bytes by category (framing, transaction header, item state JSON, item floats, command JSON and
  floats by op group, mesh table, mesh bodies, materials, ...), plus the churn behind them;
- an approximation of the /11 message (render-stream-11.md "Dynamic mesh surfaces": changed mesh
  bodies inline in `mesh_u8`, `hash: null` on dynamic surfaces);
- that message under zstd (levels 3 and 9, with and without a dictionary trained on an earlier
  window of the same scene), permessage-deflate (context takeover) and streaming zstd (one context
  for the whole connection), applied to the meta alone, the blocks alone and the whole message;
- delta coding of item floats, command floats and mesh bodies against the previous resolved state
  of the same item or mesh (XOR or integer subtraction of the 32-bit patterns), with and without
  zstd;
- a quantized-float tier (f16 or fixed point positions and UVs, u8 colours): bytes saved and the
  error in screen pixels (positions taken through the item's full transform chain) and in 8-bit
  colour steps.

  wire-budget.py analyze --recording <file> [--store <dir>] --scene <name>:<f0>-<f1> ...
                         [--warm-skip 30] [--train-frac 0.3] [--quant-every 10] [--out <json>]
  wire-budget.py self-test

zstd needs Python 3.14's `compression.zstd` (run through `mise exec -- python3`); without it the
zstd rows are reported as unavailable and everything else still runs.
"""

from __future__ import annotations

import argparse
import json
import math
import mmap
import os
import re
import struct
import sys
import tempfile
import time
import zlib

try:  # Python 3.14+
    from compression import zstd  # type: ignore
except ImportError:  # pragma: no cover - depends on the interpreter
    zstd = None

SCHEMA = "render-stream-wire-budget/1"
WS_FPS = 60

# ---------------------------------------------------------------- record reader


def version_of_magic(b: bytes) -> int:
    """Byte 3 of `GRS?` is the version as one uppercase hex digit (render-stream-10.md): `A` is 10."""
    if len(b) < 8 or b[:3] != b"GRS" or b[4:] != b"\r\n\x1a\n":
        raise ValueError("bad-magic")
    return int(chr(b[3]), 16)


BLOCK_WIDTH = {"f32": 4, "i32": 4, "u8": 1, "f64": 8}


class Record:
    __slots__ = ("meta", "meta_bytes", "blocks", "size")

    def __init__(self, meta, meta_bytes, blocks, size):
        self.meta = meta
        self.meta_bytes = meta_bytes
        self.blocks = blocks  # name -> (type, count, bytes)
        self.size = size  # 4 + record_len


def read_records(path: str):
    with open(path, "rb") as fh:
        mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            ver = version_of_magic(mm[:8])
            off = 8
            n = len(mm)
            while off + 4 <= n:
                (rl,) = struct.unpack_from("<I", mm, off)
                body = off + 4
                (ml,) = struct.unpack_from("<I", mm, body)
                mb = bytes(mm[body + 4 : body + 4 + ml])
                meta = json.loads(mb)
                p = body + 4 + ml
                (bc,) = struct.unpack_from("<I", mm, p)
                p += 4
                blocks = {}
                for d in meta.get("blocks", [])[:bc]:
                    (bl,) = struct.unpack_from("<I", mm, p)
                    p += 4
                    blocks[d["name"]] = (d["type"], d["count"], bytes(mm[p : p + bl]))
                    p += bl
                yield ver, Record(meta, mb, blocks, 4 + rl)
                off = body + rl
        finally:
            mm.close()


def cj(o) -> bytes:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def ws_header(n: int) -> int:
    return 2 if n < 126 else 4 if n < 65536 else 10


# ---------------------------------------------------------------- op tables

TEXT_OPS = {"add_msdf_texture_rect_region", "add_lcd_texture_rect_region"}
XFORM_OPS = {"add_set_transform"}
MESH_OPS = {"add_mesh", "add_multimesh"}

# Field roles per op for the quantized tier: P position/size (screen units before the transform
# chain), L linear part of a 2x3 transform, S source rect (texels), C colour, W width/radius,
# X scalars kept as f32. Variable-length ops are expanded by `roles_of`.
ROLES = {
    "add_rect": "PPPPCCCC",
    "add_texture_rect": "PPPPCCCC",
    "add_texture_rect_region": "PPPPSSSSCCCC",
    "add_msdf_texture_rect_region": "PPPPSSSSCCCCXX",
    "add_lcd_texture_rect_region": "PPPPSSSSCCCC",
    "add_nine_patch": "PPPPSSSSPPPPCCCC",
    "add_set_transform": "LLLLPP",
    "add_mesh": "LLLLPPCCCC",
    "add_line": "PPPPCCCCW",
    "add_circle": "PPWCCCC",
}


def roles_of(cmd: dict, nfloats: int) -> str | None:
    op = cmd["op"]
    r = ROLES.get(op)
    if r is not None:
        return r if len(r) == nfloats else None
    if op in ("add_primitive", "add_polygon", "add_triangle_array"):
        r = "P" * (2 * cmd["n"]) + "C" * (4 * cmd["colors"]) + "U" * (2 * cmd["uvs"])
        return r if len(r) == nfloats else None
    if op in ("add_polyline", "add_multiline"):
        r = "W" + "P" * (2 * cmd["n"]) + "C" * (4 * cmd["colors"])
        return r if len(r) == nfloats else None
    return None


def op_group(op: str) -> str:
    if op in XFORM_OPS:
        return "transforms"
    if op in TEXT_OPS:
        return "text"
    if op in MESH_OPS:
        return "mesh_draws"
    return "other_draws"


ITEM_ROLES18 = "LLLLPPCCCCCCCCPPPP"  # xform, modulate, self_modulate, custom rect

# ---------------------------------------------------------------- numeric helpers


def xor_bytes(a: bytes, b: bytes) -> bytes:
    n = len(a)
    return (int.from_bytes(a, "little") ^ int.from_bytes(b, "little")).to_bytes(n, "little")


def sub_words(a: bytes, b: bytes) -> bytes:
    """(a - b) mod 2^32 per little-endian u32 word (lossless, unlike float subtraction)."""
    n = len(a) // 4
    va = struct.unpack(f"<{n}I", a)
    vb = struct.unpack(f"<{n}I", b)
    return struct.pack(f"<{n}I", *[(x - y) & 0xFFFFFFFF for x, y in zip(va, vb)])


def sparse_size(words: bytes) -> int:
    """A dependency-free sparse coding of a delta: one bit per 32-bit word, then the non-zero words."""
    n = len(words) // 4
    nz = sum(1 for (w,) in struct.iter_unpack("<I", words[: 4 * n]) if w)
    return (n + 7) // 8 + 4 * nz


def shuffle4(b: bytes) -> bytes:
    """Byte-plane transpose of 32-bit words (blosc-style), a cheap pre-pass for float compression."""
    n = len(b) // 4
    return b"".join(b[i : 4 * n : 4] for i in range(4)) + b[4 * n :]


def stats(xs):
    if not xs:
        return {"n": 0, "mean": None, "p95": None}
    s = sorted(xs)
    p95 = s[min(len(s) - 1, max(0, math.ceil(0.95 * len(s)) - 1))]
    return {"n": len(s), "mean": round(sum(s) / len(s), 1), "p95": round(p95, 1)}


def mbps(bytes_per_frame):
    return None if bytes_per_frame is None else round(bytes_per_frame * 8 * WS_FPS / 1e6, 2)


def row(xs):
    st = stats(xs)
    st["mbps_mean"] = mbps(st["mean"])
    st["mbps_p95"] = mbps(st["p95"])
    return st


# ---------------------------------------------------------------- affine helpers (2x3, Godot order)


def compose(a, b):
    """a * b for Godot Transform2D (x.x, x.y, y.x, y.y, o.x, o.y): apply b, then a."""
    ax, ay, bx, by, ox, oy = a
    cx, cy, dx, dy, px, py = b
    return (
        ax * cx + bx * cy,
        ay * cx + by * cy,
        ax * dx + bx * dy,
        ay * dx + by * dy,
        ax * px + bx * py + ox,
        ay * px + by * py + oy,
    )


def apply(t, x, y):
    return (t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5])


IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def quant_body(body: bytes, nv: int, fmt: int) -> bytes:
    """The tiered tier on one mesh surface body: positions to i16 at 1/16 px (clamped), UVs to u16
    normalized (clamped); the 40-byte geometry, colours, skin and indices unchanged."""
    geo, rest = body[:40], body[40:]
    pos = struct.unpack(f"<{2 * nv}f", rest[: 8 * nv])
    qpos = struct.pack(f"<{2 * nv}h", *[max(-32768, min(32767, round(v * 16))) if math.isfinite(v) else 0 for v in pos])
    has_c, has_uv = bool(fmt & (1 << 3)), bool(fmt & (1 << 4))
    stride = (4 if has_c else 0) + (8 if has_uv else 0)
    attr = rest[8 * nv : 8 * nv + stride * nv]
    out = bytearray()
    for k in range(nv):
        o = k * stride
        if has_c:
            out += attr[o : o + 4]
            o += 4
        if has_uv:
            u, v = struct.unpack_from("<2f", attr, o)
            out += struct.pack("<2H", *[max(0, min(65535, round(x * 65535))) if math.isfinite(x) else 0 for x in (u, v)])
    return geo + qpos + bytes(out) + rest[8 * nv + stride * nv :]


def q_f16(v: float) -> float:
    try:
        return struct.unpack("<e", struct.pack("<e", v))[0]
    except (OverflowError, struct.error):
        return float("inf")


def q_fixed(v: float, step: float, lo: float, hi: float):
    if not math.isfinite(v):
        return None
    q = round(v / step) * step
    return q if lo <= q <= hi else None  # None: out of range, would fall back to f32


# Quantization schemes per role: (bytes per value, quantizer -> value or None for fallback).
SCHEMES = {
    "f16": {
        "P": (2, q_f16),
        "L": (2, q_f16),
        "S": (2, q_f16),
        "C": (2, q_f16),
        "U": (2, q_f16),
        "W": (2, q_f16),
    },
    "tiered": {
        # positions: i16 at 1/16 px (range +-2048); source rects: u16 at 1/8 texel (0..8191);
        # colours: u8 when in [0, 1]; mesh UVs: u16 normalized when in [0, 1]; linear and
        # scalars stay f32.
        "P": (2, lambda v: q_fixed(v, 1 / 16, -2048, 2047.9375)),
        "S": (2, lambda v: q_fixed(v, 1 / 8, 0, 8191.875)),
        "C": (1, lambda v: q_fixed(v, 1 / 255, 0, 1)),
        "U": (2, lambda v: q_fixed(v, 1 / 65535, 0, 1)),
        "W": (2, lambda v: q_fixed(v, 1 / 16, -2048, 2047.9375)),
    },
}


# ---------------------------------------------------------------- the analyzer


class Scene:
    def __init__(self, name, f0, f1, warm_skip, train_frac):
        self.name, self.f0, self.f1 = name, f0, f1
        self.w0 = f0 + warm_skip
        self.split = self.w0 + int((f1 - self.w0) * train_frac)
        self.tx = 0
        self.cat = {}  # category -> list of bytes per warm tx
        self.churn = {}
        self.samples = {"meta": [], "blocks": [], "whole": []}
        self.dicts = None
        self.comp = {}
        self.delta = {}
        self.quant = {
            s: {"saved": [], "fallback": 0, "values": 0, "pos_err_px": 0.0, "col_err_steps": 0.0}
            for s in SCHEMES
        }
        self.quant_tx = 0
        self.quant_roles = {}

    def phase(self, frame):
        if frame < self.w0 or frame > self.f1:
            return None
        return "train" if frame < self.split else "test"

    def add(self, d, key, v):
        d.setdefault(key, []).append(v)


class Analyzer:
    def __init__(self, store, scenes, quant_every=10, compress=True, dyn_frames=4, levels=(3, 9)):
        self.store = store
        self.scenes = scenes
        self.quant_every = quant_every
        self.compress = compress and zstd is not None
        self.dyn_frames = dyn_frames
        self.levels = levels
        # resolved state
        self.items = {}  # id -> dict(hdr=bytes, f=bytes, cmds=list, cmdf=bytes, cmdj=bytes)
        self.canvases = {}  # id -> floats bytes
        self.meshes = {}  # id -> dict(hashes=list, bodies=list|None)
        self.mesh_changes = {}  # id -> last content-change frame
        self.dynamic = set()
        self.prev_unsupported = None
        self.version = None
        self.payload_cache = {}
        self.qcache = {}
        self._qmesh = None
        # streaming compressors over the whole connection
        self.defl = zlib.compressobj(6, zlib.DEFLATED, -15, 9)
        self.zs = {}
        if self.compress:
            for lv in levels:
                self.zs[lv] = zstd.ZstdCompressor(level=lv)
            self.zs_x = zstd.ZstdCompressor(level=3)  # the delta-coded stream
            self.zs_l = zstd.ZstdCompressor(level=3)  # the lean stream
            self.zs_ld = zstd.ZstdCompressor(level=3)  # lean, XOR-delta numeric blocks
            self.zs_ldq = zstd.ZstdCompressor(level=3)  # lean, XOR-delta, tiered mesh bodies
        self.prev_whole = self.prev_lean = None
        self.transactions = 0

    # -- payloads
    def body(self, h: str) -> bytes | None:
        if self.store is None:
            return None
        b = self.payload_cache.get(h)
        if b is not None:
            return b
        p = os.path.join(self.store, "sha256", h + ".grm")
        try:
            with open(p, "rb") as fh:
                raw = fh.read()
        except OSError:
            return None
        (ml,) = struct.unpack_from("<I", raw, 8)
        b = raw[12 + ml :]
        if len(self.payload_cache) > 4096:
            self.payload_cache.clear()
        self.payload_cache[h] = b
        return b

    def qbody(self, h, body, nv, fmt):
        q = self.qcache.get(h)
        if q is None:
            q = quant_body(body, min(nv, (len(body) - 40) // 8), fmt)
            if len(self.qcache) > 4096:
                self.qcache.clear()
            self.qcache[h] = q
        return q

    def scene_of(self, frame):
        for s in self.scenes:
            ph = s.phase(frame)
            if ph:
                return s, ph
        return None, None

    # -- one transaction
    def transaction(self, rec: Record):
        m = rec.meta
        frame = m["frame"]
        full = m["encoding"] == "full"
        sc, ph = self.scene_of(frame)
        warm = sc is not None and not full
        cats = {}

        def c(k, v):
            cats[k] = cats.get(k, 0) + v

        # framing: length, meta length, block count, one length per block; one WS frame
        nblk = len(rec.blocks)
        c("framing", 12 + 4 * nblk + ws_header(rec.size))

        # top-level meta keys
        big = {"items", "meshes", "unsupported", "materials", "shaders", "textures", "canvases"}
        rest = len(rec.meta_bytes)
        for k in big:
            if k in m:
                v = len(cj(m[k]))
                rest -= v
                c({"items": "item_json", "meshes": "mesh_json", "unsupported": "unsupported_json",
                   "materials": "material_json", "shaders": "shader_json",
                   "textures": "texture_json", "canvases": "canvas_json"}[k], v)
        c("tx_header_json", rest)
        # blocks
        for name, (_t, _n, b) in rec.blocks.items():
            if name == "cmd_f32":
                continue  # split by op below
            key = {"item_f32": "item_f32", "canvas_f32": "canvas_f32", "cmd_i32": "cmd_i32",
                   "mesh_f32": "mesh_f32", "param_f64": "param_f64",
                   "backbuffer_f32": "backbuffer_f32"}.get(name, "other_blocks")
            c(key, len(b))

        cmdf = rec.blocks.get("cmd_f32", ("f32", 0, b""))[2]
        itemf = rec.blocks.get("item_f32", ("f32", 0, b""))[2]
        items = m.get("items", [])
        per_item = (len(itemf) // 4 // len(items)) if items else 18
        # command float spans
        fl = []
        for it in items:
            for cmd in it.get("commands") or []:
                if "f" in cmd and cmd["f"] is not None:
                    fl.append(cmd["f"])
        ends = {}
        total_f = len(cmdf) // 4
        for i, f in enumerate(fl):
            ends[f] = fl[i + 1] if i + 1 < len(fl) else total_f

        churn = {}

        def ch(k, v=1):
            churn[k] = churn.get(k, 0) + v

        # delta and plain numeric streams (item floats, command floats, mesh bodies)
        plain_items, x_items, s_items = [], [], []
        plain_cmds, x_cmds, s_cmds = [], [], []
        new_items = {}
        key_bytes = 0
        redundant = set()  # item indexes in the patch only for a content_version over equal commands
        lean_f, lean_c, lean_xf, lean_xc = [], [], [], []
        for idx, it in enumerate(items):
            iid = it["id"]
            cmds = it.get("commands")
            hdr = dict(it)
            hdr.pop("commands", None)
            hj = cj(hdr)
            key_bytes += sum(len(k) + 3 for k in it.keys())
            fbytes = itemf[idx * per_item * 4 : (idx + 1) * per_item * 4]
            prev = self.items.get(iid)
            cmd_json_total = 0
            cfl = b""
            if cmds is not None:
                for ci, cmd in enumerate(cmds):
                    # each command's JSON plus its comma; the brackets go to the first one
                    cjb = len(cj(cmd)) + 1 + (1 if ci == 0 else 0)
                    cmd_json_total += cjb
                    g = op_group(cmd["op"])
                    c("cmd_json_" + g, cjb)
                    if "f" in cmd and cmd["f"] is not None:
                        f0 = cmd["f"]
                        seg = cmdf[f0 * 4 : ends[f0] * 4]
                        c("cmd_f32_" + g, len(seg))
                        cfl += seg
            # churn classification
            if prev is None:
                ch("items_new")
            else:
                hdr_same = prev["hdr"] == hj
                f_same = prev["f"] == fbytes
                if cmds is not None:
                    cmdj = cj(cmds)
                    if cmdj == prev["cmdj"] and cfl == prev["cmdf"]:
                        ch("items_cmds_resent_identical")
                        ch("bytes_cmds_resent_identical", cmd_json_total + len(cfl))
                        # in the patch only because content_version moved over identical commands
                        ph_ = dict(json.loads(prev["hdr"]), content_version=hdr["content_version"])
                        if cj(ph_) == hj and f_same:
                            ch("items_redundant")
                            redundant.add(idx)
                            ch("bytes_items_redundant", len(cj(it)) + 1 + len(fbytes) + len(cfl))
                    elif cmdj == prev["cmdj"]:
                        ch("items_cmds_floats_changed")
                    else:
                        ch("items_cmds_structure_changed")
                elif not f_same and hdr_same:
                    ch("items_floats_only")
                elif not hdr_same and f_same:
                    ch("items_header_only")
                else:
                    ch("items_header_and_floats")
                if hdr_same:
                    ch("bytes_item_header_unchanged", len(hj))
                if f_same:
                    ch("bytes_item_f32_unchanged", len(fbytes))
                else:
                    # which of the 18 floats moved
                    n = len(fbytes) // 4
                    a = struct.unpack(f"<{n}I", fbytes)
                    b = struct.unpack(f"<{n}I", prev["f"]) if len(prev["f"]) == len(fbytes) else None
                    if b:
                        for j, (x, y) in enumerate(zip(a, b)):
                            if x != y:
                                ch("item_f32_changed_" + ("xform" if j < 6 else "modulate" if j < 14 else "custom_rect"))
            # delta coding
            plain_items.append(fbytes)
            if prev is not None and len(prev["f"]) == len(fbytes):
                x_items.append(xor_bytes(fbytes, prev["f"]))
                s_items.append(sub_words(fbytes, prev["f"]))
            else:
                x_items.append(fbytes)
                s_items.append(fbytes)
            if cmds is not None:
                plain_cmds.append(cfl)
                if prev is not None and len(prev["cmdf"]) == len(cfl):
                    x_cmds.append(xor_bytes(cfl, prev["cmdf"]))
                    s_cmds.append(sub_words(cfl, prev["cmdf"]))
                else:
                    x_cmds.append(cfl)
                    s_cmds.append(cfl)
            new_items[iid] = (hj, fbytes, cmds, cfl)
            if idx not in redundant:
                lean_f.append(fbytes)
                lean_xf.append(x_items[-1])
                if cmds is not None:
                    lean_c.append(cfl)
                    lean_xc.append(x_cmds[-1])
        if items:
            # item state JSON = items JSON minus commands
            c("item_json", 0)
        c("item_key_names", 0)
        churn["items_in_patch"] = len(items)
        churn["item_key_name_bytes"] = key_bytes

        # split item_json into state vs commands (commands counted per op above)
        cmd_json_all = sum(v for k, v in cats.items() if k.startswith("cmd_json_"))
        cats["item_json"] = cats.get("item_json", 0) - cmd_json_all
        cats["item_state_json"] = cats.pop("item_json")
        cats.pop("item_key_names", None)

        # meshes: hashes, dynamic classification, /11 bodies
        mesh_body = []
        qmesh_p, qmesh_x = [], []
        plain_mesh, x_mesh, s_mesh = [], [], []
        new_meshes = {}
        hash_json = 0
        mesh11 = []
        off = 0
        for e in m.get("meshes", []):
            mid = e["id"]
            hashes = [s.get("hash") for s in e.get("surfaces", [])]
            hash_json += sum(len('"hash":"",') + 64 for h in hashes if h)
            prev = self.meshes.get(mid)
            changed = prev is None or prev["hashes"] != hashes
            if changed and hashes and prev is not None:
                last = self.mesh_changes.get(mid)
                if last is not None and frame - last < self.dyn_frames:
                    self.dynamic.add(mid)
                self.mesh_changes[mid] = frame
            elif changed and hashes:
                self.mesh_changes[mid] = frame
            dyn = mid in self.dynamic and e.get("status") == "ok" and bool(hashes)
            bodies = None
            if hashes and all(hashes):
                bodies = [self.body(h) for h in hashes]
                if any(b is None for b in bodies):
                    bodies = None
            e2 = {k: e[k] for k in e if k != "surfaces"}
            u8 = None
            if dyn and (changed or full) and bodies is not None:
                u8 = off
                blob = b"".join(bodies)
                off += len(blob)
                mesh_body.append(blob)
                ch("mesh_bodies_sent")
                shapes = [(sf["vertex_count"], sf["format"]) for sf in e.get("surfaces", [])]
                qb = b"".join(self.qbody(h, bb, *sh) for h, bb, sh in zip(hashes, bodies, shapes))
                qprev = (b"".join(self.qbody(h, bb, *sh) for h, bb, sh in zip(prev["hashes"], prev["bodies"], shapes))
                         if prev and prev.get("bodies") and len(prev["bodies"]) == len(bodies) else None)
                qmesh_p.append(qb)
                qmesh_x.append(xor_bytes(qb, qprev) if qprev is not None and len(qprev) == len(qb) else qb)
                pb = b"".join(prev["bodies"]) if prev and prev.get("bodies") else None
                plain_mesh.append(blob)
                if pb is not None and len(pb) == len(blob):
                    x_mesh.append(xor_bytes(blob, pb))
                    s_mesh.append(sub_words(blob[: len(blob) // 4 * 4], pb[: len(blob) // 4 * 4]) + blob[len(blob) // 4 * 4 :])
                else:
                    x_mesh.append(blob)
                    s_mesh.append(blob)
            if changed and not dyn and hashes:
                ch("static_mesh_hash_changes")
                c("mesh_payload_records_static", sum(len(b) + 12 + 200 for b in bodies or []))
            if changed and hashes:
                ch("mesh_hash_changes")
                # /10: each new payload is a resource record (inline <= 4096) or a GET
                c("mesh_payload_records_v10", sum(len(b) + 12 + 186 + 200 for b in bodies or []))
            e2["u8"] = u8
            e2["surfaces"] = [dict(s, hash=None) if dyn else s for s in e.get("surfaces", [])]
            # key order: ... "f", "u8", "surfaces"
            order = [k for k in e if k != "surfaces"] + ["u8", "surfaces"]
            mesh11.append({k: e2[k] for k in order})
            new_meshes[mid] = {"hashes": hashes, "bodies": bodies,
                               "nv": [s.get("vertex_count", 0) for s in e.get("surfaces", [])]}
        c("mesh_hash_json", hash_json)
        cats["mesh_json"] = cats.get("mesh_json", 0) - hash_json
        mesh_u8 = b"".join(mesh_body)
        self._qmesh = (b"".join(qmesh_p), b"".join(qmesh_x))
        c("mesh_u8_v11", len(mesh_u8))

        # unsupported list repeated verbatim
        uj = cj(m.get("unsupported", []))
        unsup_same = self.prev_unsupported == uj
        if unsup_same:
            ch("bytes_unsupported_repeated", len(uj))
        self.prev_unsupported = uj

        # ---- /11 approximation of the message
        m11 = dict(m)
        if "meshes" in m11:
            m11["meshes"] = mesh11
        blocks11 = [dict(d) for d in m.get("blocks", [])]
        blocks11.append({"name": "mesh_u8", "type": "u8", "count": len(mesh_u8)})
        blocks11.append({"name": "mm_f32", "type": "f32", "count": 0})
        m11["blocks"] = blocks11
        meta11 = cj(m11)
        blk = [b for (_t, _n, b) in rec.blocks.values()] + [mesh_u8, b""]
        blocks_bytes = b"".join(struct.pack("<I", len(b)) + b for b in blk)
        whole = struct.pack("<I", 4 + len(meta11) + 4 + len(blocks_bytes)) + struct.pack("<I", len(meta11)) + meta11 + struct.pack("<I", len(blk)) + blocks_bytes
        msg11 = len(whole) + ws_header(len(whole))

        # the lean /11 message: what the same transaction would weigh if the capture kept
        # content_version over an identical re-recorded command list (those items leave the patch)
        # and `unsupported` were sent only when it changed (here: an empty list when unchanged)
        ml = dict(m11)
        ml["items"] = [it for k, it in enumerate(items) if k not in redundant]
        if unsup_same:
            ml["unsupported"] = []
        lblk = []
        for name, (_t, _n, b) in rec.blocks.items():
            lblk.append(b"".join(lean_f) if name == "item_f32" else b"".join(lean_c) if name == "cmd_f32" else b)
        lblk += [mesh_u8, b""]
        lbd = [dict(d) for d in blocks11]
        for d_, b_ in zip(lbd, lblk):
            d_["count"] = len(b_) // BLOCK_WIDTH[d_["type"]]
        ml["blocks"] = lbd
        lmeta = cj(ml)
        lean = struct.pack("<II", 0, len(lmeta)) + lmeta + struct.pack("<I", len(lblk)) + b"".join(
            struct.pack("<I", len(b)) + b for b in lblk)

        # the lean message with its numeric blocks XOR-delta coded (mesh bodies plain-XOR, or
        # tiered-quantized then XOR): the combined candidate the compression rows test
        def lean_with(xm):
            out = []
            for name, (_t, _n, b) in rec.blocks.items():
                out.append(b"".join(lean_xf) if name == "item_f32" else b"".join(lean_xc) if name == "cmd_f32" else b)
            out += [xm, b""]
            return struct.pack("<II", 0, len(lmeta)) + lmeta + struct.pack("<I", len(out)) + b"".join(
                struct.pack("<I", len(b)) + b for b in out)

        lean_d = lean_with(b"".join(x_mesh))
        lean_dq = lean_with(b"".join(qmesh_x))

        # delta-coded whole message (numeric blocks replaced by their XOR deltas)
        def xblocks(xi, xc, xm):
            out = []
            for name, (_t, _n, b) in rec.blocks.items():
                if name == "item_f32":
                    out.append(b"".join(xi))
                elif name == "cmd_f32":
                    # deltas only cover items that resent commands, in item order: same length
                    out.append(b"".join(xc))
                else:
                    out.append(b)
            out += [b"".join(xm), b""]
            return b"".join(struct.pack("<I", len(b)) + b for b in out)

        x_whole = struct.pack("<II", 0, len(meta11)) + meta11 + struct.pack("<I", len(blk)) + xblocks(x_items, x_cmds, x_mesh)

        # ---- feed streaming compressors (whole connection, every transaction)
        if self.compress:
            stream_out = {lv: len(self.zs[lv].compress(whole, zstd.ZstdCompressor.FLUSH_BLOCK)) for lv in self.levels}
            stream_x = len(self.zs_x.compress(x_whole, zstd.ZstdCompressor.FLUSH_BLOCK))
            stream_l = len(self.zs_l.compress(lean, zstd.ZstdCompressor.FLUSH_BLOCK))
            # the base's message as a raw prefix: a function of (B, T), so shareable across viewers
            prev_w, prev_l = self.prev_whole, self.prev_lean
            t0 = time.perf_counter()
            ref = len(zstd.compress(whole, level=3, zstd_dict=zstd.ZstdDict(prev_w, is_raw=True).as_prefix)) if prev_w else None
            ref_us = (time.perf_counter() - t0) * 1e6
            ref_l = ref_ld = ref_ldq = None
            if prev_l:
                pre = zstd.ZstdDict(prev_l, is_raw=True).as_prefix
                ref_l = len(zstd.compress(lean, level=3, zstd_dict=pre))
                ref_ld = len(zstd.compress(lean_d, level=3, zstd_dict=pre))
                ref_ldq = len(zstd.compress(lean_dq, level=3, zstd_dict=pre))
            self.prev_whole, self.prev_lean = whole, lean
            stream_ld = len(self.zs_ld.compress(lean_d, zstd.ZstdCompressor.FLUSH_BLOCK))
            stream_ldq = len(self.zs_ldq.compress(lean_dq, zstd.ZstdCompressor.FLUSH_BLOCK))
        t0 = time.perf_counter()
        d = self.defl.compress(whole) + self.defl.flush(zlib.Z_SYNC_FLUSH)
        defl_us = (time.perf_counter() - t0) * 1e6
        defl_ctx = len(d) - 4 + ws_header(len(d) - 4)  # RFC 7692 strips 00 00 ff ff

        # ---- account
        if warm:
            sc.tx += 1
            for k, v in cats.items():
                sc.add(sc.cat, k, v)
            sc.add(sc.cat, "record_v10", rec.size + ws_header(rec.size))
            sc.add(sc.cat, "message_v11", msg11)
            sc.add(sc.cat, "message_v11_lean", len(lean) + ws_header(len(lean)))
            sc.add(sc.cat, "meta_v11", len(meta11))
            sc.add(sc.cat, "blocks_v11", len(blocks_bytes))
            for k, v in churn.items():
                sc.add(sc.churn, k, v)
            parts = {"meta": meta11, "blocks": blocks_bytes, "whole": whole}
            if ph == "train":
                for k, v in parts.items():
                    if len(sc.samples[k]) < 400:
                        sc.samples[k].append(v)
            elif ph == "test":
                self.measure(sc, parts, cats, msg11, defl_ctx, defl_us,
                             stream_out if self.compress else None,
                             stream_x if self.compress else None,
                             (stream_l, ref, ref_l, lean, ref_us, ref_ld, ref_ldq, stream_ld, stream_ldq,
                              len(lean_d), len(lean_dq)) if self.compress else None,
                             (plain_items, x_items, s_items), (plain_cmds, x_cmds, s_cmds),
                             (plain_mesh, x_mesh, s_mesh), whole)
                if self.quant_every and sc.tx % self.quant_every == 0:
                    self.quantize(sc, m, rec, items, new_items, new_meshes, mesh_body)

        # ---- resolve
        if full:
            self.items, self.canvases, self.meshes = {}, {}, {}
        for i in m.get("removed_items", []):
            self.items.pop(i, None)
        for i in m.get("removed_canvases", []):
            self.canvases.pop(i, None)
        for i in m.get("removed_meshes", []):
            self.meshes.pop(i, None)
            self.dynamic.discard(i)
        for iid, (hj, fb, cmds, cfl) in new_items.items():
            prev = self.items.get(iid)
            if cmds is None and prev is not None:
                cmds, cfl, cmdj = prev["cmds"], prev["cmdf"], prev["cmdj"]
            else:
                cmdj = cj(cmds) if cmds is not None else b"null"
            self.items[iid] = {"hdr": hj, "f": fb, "cmds": cmds or [], "cmdf": cfl, "cmdj": cmdj,
                               "parent": json.loads(hj)["parent"]}
        canv = rec.blocks.get("canvas_f32", ("f32", 0, b""))[2]
        cs = m.get("canvases", [])
        if cs:
            per = len(canv) // 4 // len(cs)
            for k, e in enumerate(cs):
                self.canvases[e["id"]] = struct.unpack(f"<{per}f", canv[k * per * 4 : (k + 1) * per * 4])[:6]
        for mid, v in new_meshes.items():
            self.meshes[mid] = v
        self.transactions += 1

    # -- compression lab, test window only
    def measure(self, sc, parts, cats, msg11, defl_ctx, defl_us, stream_out, stream_x, lean, pi, pc, pm, whole):
        a = sc.add
        comp = sc.comp
        a(comp, "deflate_ctx_whole", defl_ctx)
        a(comp, "deflate_ctx_us", defl_us)
        a(comp, "deflate_noctx_whole", len(zlib.compress(whole, 6, -15)) - 0)
        if self.compress:
            if sc.dicts is None:
                sc.dicts = {}
                for k, samples in sc.samples.items():
                    try:
                        sc.dicts[k] = zstd.train_dict(samples, 112 * 1024) if len(samples) >= 8 else None
                    except Exception:  # noqa: BLE001 - too few or degenerate samples
                        sc.dicts[k] = None
                sc.samples = {k: [] for k in sc.samples}
            for lv in self.levels:
                for k, v in parts.items():
                    t0 = time.perf_counter()
                    out = zstd.compress(v, level=lv)
                    us = (time.perf_counter() - t0) * 1e6
                    a(comp, f"zstd{lv}_{k}", len(out))
                    if k == "whole":
                        a(comp, f"zstd{lv}_whole_us", us)
                        t0 = time.perf_counter()
                        zstd.decompress(out)
                        a(comp, f"zstd{lv}_whole_decomp_us", (time.perf_counter() - t0) * 1e6)
                    dct = sc.dicts.get(k)
                    if dct is not None:
                        a(comp, f"zstd{lv}_dict_{k}", len(zstd.compress(v, level=lv, zstd_dict=dct)))
                a(comp, f"zstd{lv}_stream_whole", stream_out[lv] + ws_header(stream_out[lv]))
            a(comp, "zstd3_stream_delta_whole", stream_x + ws_header(stream_x))
            stream_l, ref, ref_l, lmsg, ref_us, ref_ld, ref_ldq, stream_ld, stream_ldq, n_ld, n_ldq = lean
            a(comp, "zstd3_refbase_whole_us", ref_us)
            a(comp, "raw_lean_delta", n_ld)
            a(comp, "raw_lean_delta_tiered", n_ldq)
            a(comp, "zstd3_stream_lean_delta", stream_ld + ws_header(stream_ld))
            a(comp, "zstd3_stream_lean_delta_tiered", stream_ldq + ws_header(stream_ldq))
            if ref_ld is not None:
                a(comp, "zstd3_refbase_lean_delta", ref_ld + ws_header(ref_ld))
                a(comp, "zstd3_refbase_lean_delta_tiered", ref_ldq + ws_header(ref_ldq))
            a(comp, "zstd3_stream_lean", stream_l + ws_header(stream_l))
            a(comp, "zstd3_lean", len(zstd.compress(lmsg, level=3)))
            if ref is not None:
                a(comp, "zstd3_refbase_whole", ref + ws_header(ref))
            if ref_l is not None:
                a(comp, "zstd3_refbase_lean", ref_l + ws_header(ref_l))
        # delta lab over the numeric streams: item floats, command floats, mesh bodies
        dl = sc.delta
        for label, (pl, xx, ss) in (("item_f32", pi), ("cmd_f32", pc), ("mesh_u8", pm)):
            P, X, S = b"".join(pl), b"".join(xx), b"".join(ss)
            a(dl, f"{label}_plain", len(P))
            a(dl, f"{label}_xor_sparse", sparse_size(X))
            if self.compress:
                a(dl, f"{label}_plain_zstd3", len(zstd.compress(P, level=3)) if P else 0)
                a(dl, f"{label}_plain_shuf_zstd3", len(zstd.compress(shuffle4(P), level=3)) if P else 0)
                a(dl, f"{label}_xor_zstd3", len(zstd.compress(X, level=3)) if X else 0)
                a(dl, f"{label}_xor_shuf_zstd3", len(zstd.compress(shuffle4(X), level=3)) if X else 0)
                a(dl, f"{label}_sub_shuf_zstd3", len(zstd.compress(shuffle4(S), level=3)) if S else 0)
        if self.compress and pm[0] and getattr(self, "_qmesh", None) is not None:
            qp, qx = self._qmesh
            a(dl, "mesh_u8_tiered_plain", len(qp))
            a(dl, "mesh_u8_tiered_zstd3", len(zstd.compress(qp, level=3)))
            a(dl, "mesh_u8_tiered_xor_zstd3", len(zstd.compress(qx, level=3)))

    # -- quantized tier on a sample of test transactions
    def global_xform(self, iid, getf, memo, depth=0):
        if iid in memo:
            return memo[iid]
        it = self.items.get(iid)
        if it is None or depth > 256:
            return IDENT
        local = getf(it["f"][:24])
        par = it["parent"]
        if isinstance(par, dict) and par.get("kind") == "item":
            g = compose(self.global_xform(par["id"], getf, memo, depth + 1), local)
        elif isinstance(par, dict) and par.get("kind") == "canvas":
            g = compose(self.canvases.get(par["id"], IDENT), local)
        else:
            g = local
        memo[iid] = g
        return g

    def quantize(self, sc, m, rec, items, new_items, new_meshes, mesh_body):
        sc.quant_tx += 1
        # bytes: every float in item_f32, cmd_f32 and the mesh bodies' positions and UVs this tx
        for name, sch in SCHEMES.items():
            q = sc.quant[name]
            saved = 0
            vals = 0
            fallback = 0

            def count(roles, raw):
                nonlocal saved, vals, fallback
                fs = struct.unpack(f"<{len(roles)}f", raw)
                for r, v in zip(roles, fs):
                    s = sch.get(r)
                    if s is None:
                        continue
                    vals += 1
                    if s[1](v) is None or not math.isfinite(s[1](v)):
                        fallback += 1
                    else:
                        saved += 4 - s[0]

            for iid, (hj, fb, cmds, cfl) in new_items.items():
                n = len(fb) // 4
                roles = ITEM_ROLES18 if n == 18 else None
                if roles:
                    count(roles, fb)
                off = 0
                for cmd in cmds or []:
                    if "f" not in cmd or cmd["f"] is None:
                        continue
                    # floats per command from the item's own concatenated span
                    r = ROLES.get(cmd["op"])
                    nf = len(r) if r else None
                    if nf is None:
                        # variable-length op: recover its length from n/colors/uvs
                        r2 = roles_of(cmd, 2 * cmd.get("n", 0) + 4 * cmd.get("colors", 0) + 2 * cmd.get("uvs", 0)
                                      + (1 if cmd["op"] in ("add_polyline", "add_multiline") else 0))
                        nf = len(r2) if r2 else None
                        r = r2
                    if nf is None:
                        break
                    seg = cfl[off * 4 : (off + nf) * 4]
                    if len(seg) == nf * 4:
                        count(r, seg)
                    off += nf
            for mid, v in new_meshes.items():
                if not v["bodies"] or mid not in self.dynamic:
                    continue
                for e in m.get("meshes", []):
                    if e["id"] != mid:
                        continue
                    for s, b in zip(e.get("surfaces", []), v["bodies"]):
                        nv = s["vertex_count"]
                        fmt = s["format"]
                        geo = 40
                        pos = b[geo : geo + 8 * nv]
                        count("P" * (2 * nv), pos)
                        attr = b[geo + 8 * nv :]
                        has_c = bool(fmt & (1 << 3))
                        has_uv = bool(fmt & (1 << 4))
                        stride = (4 if has_c else 0) + (8 if has_uv else 0)
                        if has_uv and stride:
                            for k in range(nv):
                                uvo = k * stride + (4 if has_c else 0)
                                count("UU", attr[uvo : uvo + 8])
            q["saved"].append(saved)
            q["values"] += vals
            q["fallback"] += fallback

        # errors: screen-space corner error through the full chain, and colour steps
        for name, sch in SCHEMES.items():
            q = sc.quant[name]

            def qv(v, r):
                s = sch.get(r)
                if s is None:
                    return v
                x = s[1](v)
                return v if x is None or not math.isfinite(x) else x

            def getq(raw):
                fs = struct.unpack("<6f", raw)
                return tuple(qv(v, "LLLLPP"[k]) for k, v in enumerate(fs))

            def geto(raw):
                return struct.unpack("<6f", raw)

            mo, mq = {}, {}
            worst = q["pos_err_px"]
            cworst = q["col_err_steps"]
            for iid, it in self.items.items():
                if not it["cmds"]:
                    continue
                go = self.global_xform(iid, geto, mo)
                gq = self.global_xform(iid, getq, mq)
                if not all(map(math.isfinite, go)) or abs(go[0]) + abs(go[1]) + abs(go[2]) + abs(go[3]) == 0:
                    continue
                co, cq = IDENT, IDENT
                off = 0
                cfl = it["cmdf"]
                for cmd in it["cmds"]:
                    if "f" not in cmd or cmd["f"] is None:
                        continue
                    r = ROLES.get(cmd["op"])
                    if r is None:
                        r = roles_of(cmd, 2 * cmd.get("n", 0) + 4 * cmd.get("colors", 0) + 2 * cmd.get("uvs", 0)
                                     + (1 if cmd["op"] in ("add_polyline", "add_multiline") else 0))
                    if r is None:
                        break
                    seg = cfl[off * 4 : (off + len(r)) * 4]
                    off += len(r)
                    if len(seg) != len(r) * 4:
                        break
                    fs = struct.unpack(f"<{len(r)}f", seg)
                    fq = [qv(v, rr) for v, rr in zip(fs, r)]
                    for rr, a, b in zip(r, fs, fq):
                        if rr == "C" and 0 <= a <= 1:
                            cworst = max(cworst, abs(a - b) * 255)
                    if cmd["op"] == "add_set_transform":
                        co, cq = tuple(fs), tuple(fq)
                        continue
                    if cmd["op"] == "add_mesh":
                        continue  # mesh vertices are checked below
                    pts = [k for k, rr in enumerate(r) if rr == "P"]
                    if r.startswith("PPPP"):
                        x, y, w, h = fs[:4]
                        xq, yq, wq, hq = fq[:4]
                        corners = [((x, y), (xq, yq)), ((x + w, y + h), (xq + wq, yq + hq))]
                    else:
                        corners = [((fs[pts[k]], fs[pts[k + 1]]), (fq[pts[k]], fq[pts[k + 1]]))
                                   for k in range(0, len(pts) - 1, 2)]
                    to, tq = compose(go, co), compose(gq, cq)
                    for (po, pq) in corners:
                        ao = apply(to, *po)
                        aq = apply(tq, *pq)
                        if all(map(math.isfinite, ao + aq)) and -4000 < ao[0] < 6000 and -4000 < ao[1] < 5000:
                            worst = max(worst, abs(ao[0] - aq[0]), abs(ao[1] - aq[1]))
            # mesh vertices of dynamic meshes, through their add_mesh transform
            for iid, it in self.items.items():
                for cmd in it["cmds"]:
                    if cmd["op"] != "add_mesh":
                        continue
                    mv = self.meshes.get(cmd.get("mesh"))
                    if not mv or not mv.get("bodies"):
                        continue
                    go = self.global_xform(iid, geto, mo)
                    gq = self.global_xform(iid, getq, mq)
                    for b, nv in zip(mv["bodies"], mv.get("nv", [])):
                        nv = min(nv, (len(b) - 40) // 8)
                        pos = struct.unpack(f"<{2 * nv}f", b[40 : 40 + 8 * nv])
                        for k in range(0, min(len(pos), 64), 2):
                            x, y = pos[k], pos[k + 1]
                            ao = apply(go, x, y)
                            aq = apply(gq, qv(x, "P"), qv(y, "P"))
                            if all(map(math.isfinite, ao + aq)) and abs(ao[0]) < 1e5:
                                worst = max(worst, abs(ao[0] - aq[0]), abs(ao[1] - aq[1]))
                    break
            q["pos_err_px"] = worst
            q["col_err_steps"] = cworst

    # -- run
    def run(self, path):
        session = None
        for ver, rec in read_records(path):
            self.version = ver
            t = rec.meta.get("type")
            if t == "session":
                session = rec.meta
            elif t == "transaction":
                self.transaction(rec)
        return session

    def report(self, path, session):
        out = {"schema": SCHEMA, "recording": os.path.basename(path), "version": self.version,
               "transactions": self.transactions, "zstd": None if zstd is None else ".".join(map(str, zstd.zstd_version_info)),
               "viewport": (session or {}).get("viewport", {}).get("presentation_size"),
               "dynamic_meshes": len(self.dynamic), "scenes": {}}
        for sc in self.scenes:
            r = {"frames": [sc.f0, sc.f1], "warm_from": sc.w0, "test_from": sc.split, "warm_tx": sc.tx,
                 # a counter a transaction did not touch is a zero for it
                 "bytes": {k: row(v + [0] * (sc.tx - len(v))) for k, v in sorted(sc.cat.items())},
                 "churn": {k: stats(v + [0] * (sc.tx - len(v))) for k, v in sorted(sc.churn.items())},
                 "compression": {k: row(v) if not k.endswith("_us") else stats(v) for k, v in sorted(sc.comp.items())},
                 "delta": {k: row(v) for k, v in sorted(sc.delta.items())},
                 "quant": {}}
            for name, q in sc.quant.items():
                r["quant"][name] = {"tx": sc.quant_tx, "saved": row(q["saved"]), "values": q["values"],
                                    "fallback_values": q["fallback"],
                                    "max_pos_err_px": round(q["pos_err_px"], 4),
                                    "max_colour_err_steps": round(q["col_err_steps"], 3)}
            out["scenes"][sc.name] = r
        return out


# ---------------------------------------------------------------- CLI


def parse_scene(s, warm_skip, train_frac):
    name, rng = s.split(":")
    a, b = rng.split("-")
    return Scene(name, int(a), int(b), warm_skip, train_frac)


def cmd_analyze(argv):
    ap = argparse.ArgumentParser(prog="wire-budget.py analyze")
    ap.add_argument("--recording", required=True)
    ap.add_argument("--store")
    ap.add_argument("--scene", action="append", required=True)
    ap.add_argument("--warm-skip", type=int, default=30)
    ap.add_argument("--train-frac", type=float, default=0.3)
    ap.add_argument("--quant-every", type=int, default=10)
    ap.add_argument("--no-compress", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    scenes = [parse_scene(s, a.warm_skip, a.train_frac) for s in a.scene]
    an = Analyzer(a.store, scenes, quant_every=a.quant_every, compress=not a.no_compress)
    t0 = time.time()
    session = an.run(a.recording)
    rep = an.report(a.recording, session)
    rep["wall_s"] = round(time.time() - t0, 1)
    text = json.dumps(rep, indent=1)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    for name, s in rep["scenes"].items():
        b = s["bytes"]
        print(f"wire-budget: {name}: {s['warm_tx']} warm tx, /10 record {b.get('record_v10', {}).get('mean')} B, "
              f"/11 message {b.get('message_v11', {}).get('mean')} B", file=sys.stderr)
    return 0


# ---------------------------------------------------------------- synthetic self-test


def synth_recording(path, store, frames=80):
    """A tiny /10 recording: a canvas, an animated item with a transform + rect + text glyph, a
    static item, and a mesh whose pose (store payload) changes every frame."""
    os.makedirs(os.path.join(store, "sha256"), exist_ok=True)
    import hashlib

    def rec(meta, blocks):
        meta = dict(meta)
        meta["blocks"] = [{"name": n, "type": t, "count": len(v) // BLOCK_WIDTH[t]} for n, t, v in blocks]
        mb = cj(meta)
        body = struct.pack("<I", len(mb)) + mb + struct.pack("<I", len(blocks))
        for _n, _t, v in blocks:
            body += struct.pack("<I", len(v)) + v
        return struct.pack("<I", len(body)) + body

    def item(iid, parent, cv, cmds):
        return {"id": iid, "origin": "created", "parent": parent, "children": [], "visible": True,
                "draw_index": iid, "z_index": 0, "z_relative": True, "behind": False, "clip": False,
                "custom_rect": False, "visibility_layer": 1, "texture_filter": "default",
                "texture_repeat": "default", "material": None, "use_parent_material": False,
                "instance_params": [], "content_version": cv, "commands": cmds}

    def mesh_payload(k):
        nv = 4
        meta = cj({"type": "mesh-surface", "primitive": "triangles", "format": (1 << 3) | (1 << 4) | 1,
                   "vertex_count": nv, "index_count": 6, "vertex_bytes": 8 * nv, "attribute_bytes": 12 * nv,
                   "skin_bytes": 0, "index_bytes": 12})
        geo = struct.pack("<10f", 0, 0, 0, 10, 10, 0, 1, 1, 0, 0)
        pos = struct.pack("<8f", 0, 0, 10 + k * 0.25, 0, 10, 10, 0, 10)
        attr = b"".join(b"\xff\xff\xff\xff" + struct.pack("<2f", u, v) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)))
        idx = struct.pack("<6H", 0, 1, 2, 0, 2, 3)
        p = b"GRM1\r\n\x1a\n" + struct.pack("<I", len(meta)) + meta + geo + pos + attr + idx
        h = hashlib.sha256(p).hexdigest()
        with open(os.path.join(store, "sha256", h + ".grm"), "wb") as fh:
            fh.write(p)
        return h, len(p)

    out = bytearray(b"GRSA\r\n\x1a\n")
    out += rec({"type": "session", "viewport": {"presentation_size": [1920, 1080]}}, [])
    for fr in range(1, frames + 1):
        full = fr == 1
        x = 100.0 + 0.3 * fr  # the animated item's x moves 0.3 units a frame (off the 1/16 grid)
        items, itemf, cmdf = [], b"", b""
        a_cmds = [{"op": "add_set_transform", "f": 0}, {"op": "add_rect", "aa": False, "f": 6},
                  {"op": "add_msdf_texture_rect_region", "tex": 1, "outline": 0, "f": 14},
                  {"op": "add_mesh", "mesh": 1, "tex": None, "f": 28}]
        items.append(item(1, {"kind": "canvas", "id": 1}, fr, a_cmds))
        itemf += struct.pack("<18f", 1, 0, 0, 1, x, 50, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0)
        cmdf += struct.pack("<6f", 1, 0, 0, 1, 0.5 * fr, 0)  # the glyph run slides
        cmdf += struct.pack("<8f", 0, 0, 32, 16, 0.5, 0.25, 1.0, 1.0)
        cmdf += struct.pack("<14f", 4, 4, 8, 8, 0, 0, 16, 16, 1, 1, 1, 1, 4, 1)
        cmdf += struct.pack("<10f", 1, 0, 0, 1, 0, 0, 1, 1, 1, 1)
        if full:
            items.append(item(2, {"kind": "canvas", "id": 1}, 1, [{"op": "add_rect", "aa": False, "f": 38}]))
            itemf += struct.pack("<18f", 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0)
            cmdf += struct.pack("<8f", 0, 0, 1920, 1080, 0.1, 0.1, 0.1, 1)
        # item 3 re-records the same rect every frame: content_version moves, nothing else does
        items.append(item(3, {"kind": "canvas", "id": 1}, fr, [{"op": "add_rect", "aa": False, "f": len(cmdf) // 4}]))
        itemf += struct.pack("<18f", 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0)
        cmdf += struct.pack("<8f", 8, 8, 64, 64, 1, 0, 0, 1)
        h, n = mesh_payload(fr)
        meshes = [{"id": 1, "origin": "created", "adopted_content": None, "status": "ok", "reason": None,
                   "version": fr, "f": 0, "surfaces": [{"hash": h, "payload_bytes": n, "primitive": "triangles",
                                                        "format": (1 << 3) | (1 << 4) | 1, "vertex_count": 4,
                                                        "index_count": 6}]}]
        canvases = [{"id": 1}] if full else []
        canvf = struct.pack("<10f", 1, 0, 0, 1, 0, 0, 1, 1, 1, 1) if full else b""
        meta = {"type": "transaction", "seq": fr, "frame": fr, "encoding": "full" if full else "patch",
                "base_seq": None if full else fr - 1, "status": "ok", "failures": [],
                "unsupported": [{"op": "viewport_attach_canvas", "item": None, "reason": "non-root-viewport"}],
                "removed_items": [], "removed_meshes": [], "canvases": canvases, "items": items,
                "meshes": meshes}
        out += rec(meta, [("item_f32", "f32", itemf), ("canvas_f32", "f32", canvf), ("cmd_f32", "f32", cmdf),
                          ("cmd_i32", "i32", b""), ("mesh_f32", "f32", struct.pack("<6f", 0, 0, 0, 0, 0, 0)),
                          ("param_f64", "f64", b"")])
    out += rec({"type": "end"}, [])
    with open(path, "wb") as fh:
        fh.write(out)


def self_test():
    fails = []

    def check(name, ok):
        print(("ok   " if ok else "FAIL ") + name)
        if not ok:
            fails.append(name)

    check("magic: GRSA is 10", version_of_magic(b"GRSA\r\n\x1a\n") == 10)
    check("magic: GRS8 is 8", version_of_magic(b"GRS8\r\n\x1a\n") == 8)
    try:
        version_of_magic(b"GRT1\r\n\x1a\n")
        check("magic: refuses GRT1", False)
    except ValueError:
        check("magic: refuses GRT1", True)
    a = struct.pack("<3f", 1.0, 2.0, 3.0)
    check("xor of equal floats is zero", xor_bytes(a, a) == b"\0" * 12)
    check("sparse size counts non-zero words", sparse_size(struct.pack("<4I", 0, 5, 0, 0)) == 1 + 4)
    check("sub is lossless mod 2^32", sub_words(struct.pack("<I", 1), struct.pack("<I", 2)) == struct.pack("<I", 0xFFFFFFFF))
    check("shuffle4 is a permutation", sorted(shuffle4(b"abcdefgh")) == sorted(b"abcdefgh"))
    check("compose applies b then a", compose((2, 0, 0, 2, 10, 0), (1, 0, 0, 1, 5, 0))[4] == 20)
    check("tiered P quantizes to 1/16", SCHEMES["tiered"]["P"][1](1.03) == 1.0)
    check("tiered P refuses out of range", SCHEMES["tiered"]["P"][1](5000.0) is None)
    check("tiered C refuses overbright", SCHEMES["tiered"]["C"][1](1.5) is None)
    with tempfile.TemporaryDirectory() as td:
        rp, sp = os.path.join(td, "s.rs10"), os.path.join(td, "store")
        synth_recording(rp, sp, frames=80)
        an = Analyzer(sp, [Scene("all", 1, 80, 5, 0.3)], quant_every=2, compress=True)
        session = an.run(rp)
        rep = an.report(rp, session)
        s = rep["scenes"]["all"]
        b = s["bytes"]
        ch = s["churn"]
        check("version from GRSA magic", rep["version"] == 10)
        check("warm tx count (frames 6..80, all patches)", s["warm_tx"] == 75)
        check("two items per patch", ch["items_in_patch"]["mean"] == 2)
        check("its commands change only in floats", ch["items_cmds_floats_changed"]["mean"] == 1)
        check("item_f32 is 18 floats an item", b["item_f32"]["mean"] == 144)
        check("cmd_f32 split: transform 24 B", b["cmd_f32_transforms"]["mean"] == 24)
        check("cmd_f32 split: text 56 B", b["cmd_f32_text"]["mean"] == 56)
        check("cmd_f32 split: mesh draw 40 B", b["cmd_f32_mesh_draws"]["mean"] == 40)
        check("cmd_f32 split: other 2 x 32 B", b["cmd_f32_other_draws"]["mean"] == 64)
        check("the mesh becomes dynamic", rep["dynamic_meshes"] == 1)
        body = 40 + 32 + 48 + 12
        check("mesh_u8 carries one body a tx", b["mesh_u8_v11"]["mean"] == body)
        rec_mean = b["record_v10"]["mean"]
        # + body, 2 block lengths, 2 descriptors (86 B), "u8":0, (7 B), and "hash":null for the hex
        check("/11 message = /10 record + body + framing - hash", abs(b["message_v11"]["mean"] - (rec_mean + body + 8 + 86 + 7 - 62)) <= 4)
        d = s["delta"]
        # only x (frame) moves in item_f32: XOR leaves one non-zero word
        check("item_f32 xor sparse = bitmap + 1 word", d["item_f32_xor_sparse"]["mean"] == 5 + 4)
        check("mesh body xor sparse = bitmap + 1 word", d["mesh_u8_xor_sparse"]["mean"] == (body // 4 + 7) // 8 + 4)
        if zstd is not None:
            check("tiered mesh body: positions and UVs halve", d["mesh_u8_tiered_plain"]["mean"] == body - 16 - 16)
        check("an identical command resend is counted", ch["items_redundant"]["mean"] == 1)
        check("the lean message drops it (and the repeated unsupported list)",
              b["message_v11"]["mean"] - b["message_v11_lean"]["mean"] >= ch["bytes_items_redundant"]["mean"])
        if zstd is not None:
            c = s["compression"]
            check("base-as-prefix beats per-message zstd", c["zstd3_refbase_whole"]["mean"] < c["zstd3_whole"]["mean"])
        q = s["quant"]["tiered"]
        check("tiered: position error <= 1/32 px", 0 < q["max_pos_err_px"] <= 1 / 32 + 1e-6)
        check("tiered: colour error <= 0.5 step", q["max_colour_err_steps"] <= 0.5 + 1e-6)
        check("tiered saves bytes", q["saved"]["mean"] > 0)
        cats = ["framing", "tx_header_json", "unsupported_json", "item_state_json", "mesh_json", "mesh_hash_json",
                "canvas_json", "item_f32", "canvas_f32", "cmd_i32", "mesh_f32", "param_f64"]
        parts = sum(b[k]["mean"] for k in cats if k in b) + sum(
            b[k]["mean"] for k in b if k.startswith("cmd_json_") or k.startswith("cmd_f32_"))
        check("categories sum to the /10 record", abs(parts - rec_mean) < 1.0)
        if zstd is not None:
            c = s["compression"]
            check("zstd stream beats per-message zstd", c["zstd3_stream_whole"]["mean"] < c["zstd3_whole"]["mean"])
            check("deflate with context beats without", c["deflate_ctx_whole"]["mean"] < c["deflate_noctx_whole"]["mean"])
        else:
            print("skip zstd rows (no compression.zstd: run under Python 3.14)")
    print(f"wire-budget self-test: {'FAIL' if fails else 'ok'} ({len(fails)} failed)")
    return 1 if fails else 0


def main(argv):
    if not argv or argv[0] not in ("analyze", "self-test"):
        print(__doc__, file=sys.stderr)
        return 2
    if argv[0] == "self-test":
        return self_test()
    return cmd_analyze(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
