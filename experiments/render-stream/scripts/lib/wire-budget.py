#!/usr/bin/env python3
"""WB (results/p3/wb.md): the warm wire budget of a render-stream recording, offline.

Reads a /2..=/10 file recording (`analyze`; `measure` reads /11 too) (and its payload store) without validating it, tracks the resolved
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
  wire-budget.py measure --recording <file> --scene <name>:<f0>-<f1> ... [--warm-skip 30]
                         [--top 12] [--out <json>]
  wire-budget.py proto13 --recording <file> --scene <name>:<f0>-<f1> ... [--warm-skip 30]
                         [--codings bin,bin_p2_soa,...] [--attribute ...] [--verify-every 1]
                         [--quant-every 10] [--max-frame N] [--out <json>]
  wire-budget.py bin13 --recording <file.rs13> [--plain <file.rs12>] --scene <name>:<f0>-<f1> ...
                       [--warm-skip 30] [--zr-min 4] [--dump <dir> --dump-n 300] [--out <json>]
  wire-budget.py self-test

`measure` (W11b) reads any version, /11 included, and reports what the file's own records cost per
warm patch transaction: the message a viewer receives (the transaction record plus the resource
records just before it, one WebSocket frame each), its parts (mesh_u8, items, unsupported, meshes,
records), zstd-3 per message and with the previous transaction record as a raw prefix (W11t's
base-prefix coding), and the largest transactions (scene transitions). It infers nothing: a /10
file written without inline records measures the transaction record alone.

`proto13` (WB-D, results/p3/wb-d.md) reads a /11 or /12 recording and re-encodes every transaction
as the /13 design's binary structure (protocol/render-stream-13.md) under several block codings
(raw, XOR, subtraction, zigzag of order-preserving integers, second-order prediction, and lossy
fixed-point positions), measures each warm patch raw, per-message zstd-3 and base-prefix zstd-3,
splits the /12 record into categories (raw and coded against the base's same category), and decodes
every lossless coding back to the record to prove the counts are of lossless messages.

`bin13` (BIN-D, results/p3/bin-d.md) reads a /13 recording as built (rs-core-check transcode --to
13) and measures today's wire against the deferred binary syntax and a compact residual (zero runs
in the three predicted blocks), each decoded back. Since W13r the recording's predicted blocks are
zero runs (`j13_zr` is the recording itself, checked byte for byte; `j13` is W13a's wire, the runs
expanded); `--wire w13a` reads a recording made before W13r; `--dump` writes the messages `bin13-bench.c`
times through the capture's zstd and rs-core's `examples/coded_decode.rs` through ruzstd.

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


def proto13_checks(check, rp, td):
    """WB-D: the /13 prototype's arithmetic (every numeric mode inverts exactly, NaN and signed
    zero included), a dynamic mesh coded and decoded through three transactions (raw, first
    order, second order), and the structure round trip over the synthetic recording."""
    edge = [0, 1, 0x7F7FFFFF, 0x80000000, 0x80000001, 0x7FC00000, 0xFFC00001, 0x3F800000, 0xBF800000, 0xFFFFFFFF]
    check("WB-D: ordered() is an order-preserving bijection on edge patterns",
          all(unordered(ordered(u)) == u for u in edge)
          and ordered(0xBF800000) < ordered(0x80000000) < ordered(0) < ordered(0x3F800000))
    check("WB-D: zigzag32 inverts", all(unzz32(zz32(d)) == d & M32 for d in (0, 1, -1, 2**31 - 1, -(2**31))))
    a, b, c = pack_words(edge), pack_words(edge[::-1]), pack_words([(x * 7 + 3) & M32 for x in edge])
    check("WB-D: every numeric mode inverts exactly",
          all(num_undelta(num_delta(a, b, c, m), b, c, m) == a for m in ("raw", "xor", "sub", "zz", "p2")))
    check("WB-D: p2 of a constant-velocity float (one binade) is zero",
          num_delta(struct.pack("<f", 1.75), struct.pack("<f", 1.5), struct.pack("<f", 1.25), "p2") == b"\0" * 4)
    check("WB-D: unshuffle4 inverts shuffle4", unshuffle4(shuffle4(bytes(range(23)))) == bytes(range(23)))

    def body(k):
        geo = struct.pack("<10f", 0, 0, 0, 10, 10, 0, 1, 1, 0, 0)
        pos = struct.pack("<8f", 0, 0, 10 + k * 0.3, 0, 10, 10 + k * 0.7, 0, 10)
        attr = b"".join(b"\xff\x80\x00\xff" + struct.pack("<2f", u, v) for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)))
        return geo + pos + attr + struct.pack("<6H", 0, 1, 2, 0, 2, 3)

    surf = {"hash": None, "payload_bytes": len(body(0)), "primitive": "triangles",
            "format": (1 << 3) | (1 << 4) | 1 | (1 << 12), "vertex_count": 4, "index_count": 6}
    metas = []
    for t in range(3):
        meta = {"type": "transaction", "seq": t + 1, "encoding": "full" if t == 0 else "patch",
                "meshes": [{"id": 7, "status": "ok", "f": 0, "u8": 0, "surfaces": [surf]}],
                "blocks": [{"name": "mesh_f32", "type": "f32", "count": 6}, {"name": "mesh_u8", "type": "u8", "count": len(body(t))}]}
        blocks = {"mesh_f32": ("f32", 6, struct.pack("<6f", 0, 0, 0, 10 + t, 10, 0)), "mesh_u8": ("u8", len(body(t)), body(t))}
        metas.append((meta, Record(meta, cj(meta), blocks, 0)))
    sch = Schema13()
    for meta, _r in metas:
        sch.learn({k: v for k, v in meta.items() if k not in ("type", "blocks")}, "tx")
    sch.freeze()
    pr = Proto13(sch, True)
    ok, sizes = True, []
    for meta, r in metas:
        sb, _m = pr.structure(meta)
        segs, *_ = pr.segments(meta, r)
        for cdg in LOSSLESS13:
            msg, _n, blocks = pr.encode(meta, r, cdg, sb, segs)
            ok = ok and pr.check_roundtrip(meta, r, cdg, msg) is None
            if cdg == "bin_p2_soa":
                sizes.append(sum(1 for x in blocks["mesh_u8"] if x))
        pr.advance(meta, r)
    check("WB-D: a dynamic mesh round-trips under every lossless coding (raw, then first, then second order)", ok)
    check("WB-D: the second-order residual of a constant-velocity pose is all zero", sizes[2] == 0 and sizes[1] > 0)
    if zstd is not None:
        p13 = os.path.join(td, "p13.json")
        rc = cmd_proto13(["--recording", rp, "--scene", "all:1-80", "--warm-skip", "5", "--out", p13])
        with open(p13) as fh:
            r13 = json.load(fh)
        b13 = r13["scenes"]["all"]["bytes"]
        check("WB-D: proto13 round-trips all 75 warm patches", rc == 0 and r13["verified_tx"] == 75
              and r13["roundtrip_failure_count"] == 0)
        check("WB-D: the binary structure is smaller than the JSON record",
              b13["bin.raw"]["mean"] < b13["json.record"]["mean"])
        check("WB-D: json categories sum to the record", abs(b13["json.record"]["mean"] - sum(
            v["mean"] for k, v in b13.items() if k.startswith("json.") and k not in ("json.record", "json.message")
            and not k.startswith("json.zstd3"))) < 1.0)


def self_test():
    fails = []

    def check(name, ok):
        print(("ok   " if ok else "FAIL ") + name)
        if not ok:
            fails.append(name)

    check("magic: GRSA is 10", version_of_magic(b"GRSA\r\n\x1a\n") == 10)
    check("magic: GRS8 is 8", version_of_magic(b"GRS8\r\n\x1a\n") == 8)
    check("magic: GRSB is 11", version_of_magic(b"GRSB\r\n\x1a\n") == 11)
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
        # W11b: `measure` reads the same file: the message is the record (no inline records here)
        mp = os.path.join(td, "measure.json")
        cmd_measure(["--recording", rp, "--scene", "all:1-80", "--warm-skip", "5", "--out", mp])
        with open(mp) as fh:
            mrep = json.load(fh)
        mb = mrep["scenes"]["all"]["bytes"]
        check("measure: 80 transactions, 75 warm", mrep["transactions"] == 80 and mrep["scenes"]["all"]["warm_tx"] == 75)
        check("measure: message = record_v10 + its WebSocket header",
              mb["message"]["mean"] == mb["tx_record"]["mean"] and abs(mb["tx_record"]["mean"] - b["record_v10"]["mean"]) < 1)
        check("measure: two items a patch", mb["items"]["mean"] == 2)
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
        proto13_checks(check, rp, td)
    # BIN-D: the compact residual's zero runs invert on edge buffers, elide only runs >= min,
    # and a 16-hex predict_check takes 8 bytes in the structure
    bufs = [b"", bytes(3), bytes(4), bytes(40), b"a", b"\0\0\0a\0\0\0\0b", b"ab" + bytes(9) + b"c" + bytes(5),
            bytes(range(256)) * 3 + bytes(100)]
    check("BIN-D: zero runs invert (min 1, 4, 16)",
          all(zr_decode(zr_encode(b, m), len(b)) == b for b in bufs for m in (1, 4, 16)))
    check("BIN-D: zero runs: a 3-byte run stays literal at min 4, a 4-byte run goes",
          zr_encode(b"a\0\0\0b", 4) == b"\0\x05a\0\0\0b" and zr_encode(b"a\0\0\0\0b", 4) == b"\0\x01a\x04\x01b")
    sch = Schema13()
    for v in ("00112233445566ff", "ffeeddccbbaa9988"):
        sch.learn({"seq": 1, "predict_check": v}, "tx")
    sch.freeze()
    out = bytearray()
    sch.enc({"seq": 1, "predict_check": "00112233445566ff"}, "tx", out)
    check("BIN-D: predict_check is 8 bytes in the structure", len(out) == 9
          and sch.dec(bytes(out), 0, "tx")[0] == {"seq": 1, "predict_check": "00112233445566ff"})
    print(f"wire-budget self-test: {'FAIL' if fails else 'ok'} ({len(fails)} failed)")
    return 1 if fails else 0


def read_raw(path: str):
    """(version, meta, raw record bytes) per record, the record's own framing included."""
    with open(path, "rb") as fh:
        mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            ver = version_of_magic(mm[:8])
            off = 8
            n = len(mm)
            while off + 4 <= n:
                (rl,) = struct.unpack_from("<I", mm, off)
                (ml,) = struct.unpack_from("<I", mm, off + 4)
                meta = json.loads(bytes(mm[off + 8 : off + 8 + ml]))
                yield ver, meta, bytes(mm[off : off + 4 + rl])
                off += 4 + rl
        finally:
            mm.close()


def cmd_measure(argv):
    ap = argparse.ArgumentParser(prog="wire-budget.py measure")
    ap.add_argument("--recording", required=True)
    ap.add_argument("--scene", action="append", default=[])
    ap.add_argument("--warm-skip", type=int, default=30)
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    scenes = []
    for spec in a.scene:
        name, rng = spec.split(":")
        f0, f1 = (int(x) for x in rng.split("-"))
        scenes.append((name, f0, f1))
    rows = {name: {} for name, _f0, _f1 in scenes}
    tops = []
    pending = []  # resource records since the last transaction
    prev_tx = None
    version = None
    count = 0
    t0 = time.time()
    for ver, meta, raw in read_raw(a.recording):
        version = ver
        kind = meta.get("type")
        if kind == "resource":
            pending.append(len(raw))
            continue
        if kind != "transaction":
            continue
        count += 1
        frame = meta["frame"]
        rec_bytes = sum(n + ws_header(n) for n in pending)
        msg = len(raw) + ws_header(len(raw)) + rec_bytes
        tops.append((len(raw), frame, meta["seq"]))
        tops = sorted(tops, reverse=True)[: a.top]
        scene = next((sc for sc in scenes if sc[1] + a.warm_skip <= frame <= sc[2]), None)
        if scene is not None and meta["encoding"] == "patch":
            r = rows[scene[0]]

            def add(key, v, r=r):
                r.setdefault(key, []).append(v)

            add("message", msg)
            add("tx_record", len(raw) + ws_header(len(raw)))
            add("resource_records", len(pending))
            add("resource_record_bytes", rec_bytes)
            add("items", len(meta.get("items", [])))
            add("item_json", len(cj(meta.get("items", []))))
            add("mesh_entries", len(meta.get("meshes", [])))
            add("mesh_json", len(cj(meta.get("meshes", []))))
            add("unsupported_json", len(cj(meta.get("unsupported"))))
            u8 = next((b["count"] for b in meta.get("blocks", []) if b["name"] == "mesh_u8"), 0)
            add("mesh_u8", u8)
            if zstd is not None:
                z = len(zstd.compress(raw, level=3))
                add("zstd3_tx", z + ws_header(z) + rec_bytes)
                if prev_tx is not None:
                    pre = zstd.ZstdDict(prev_tx, is_raw=True)
                    zp = len(zstd.compress(raw, level=3, zstd_dict=pre.as_prefix))
                    add("zstd3_prefix_tx", zp + ws_header(zp) + rec_bytes)
        pending = []
        prev_tx = raw
    out = {"schema": SCHEMA + "#measure", "recording": os.path.basename(a.recording), "version": version,
           "transactions": count, "warm_skip": a.warm_skip, "wall_s": round(time.time() - t0, 1),
           "largest": [{"bytes": b, "frame": f, "seq": q} for b, f, q in tops], "scenes": {}}
    for name, f0, f1 in scenes:
        r = rows[name]
        out["scenes"][name] = {"frames": [f0, f1], "warm_tx": len(r.get("message", [])),
                               "bytes": {k: row(v) for k, v in sorted(r.items())}}
        msg = row(r.get("message", [0]))
        print(f"wire-budget measure: {name}: {len(r.get('message', []))} warm tx, message mean "
              f"{msg.get('mean')} B, prefix-zstd3 {row(r.get('zstd3_prefix_tx', [0])).get('mean')} B",
              file=sys.stderr)
    text = json.dumps(out, indent=1)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 0


# ---------------------------------------------------------------- WB-D: a /13 binary prototype
#
# `proto13` (WB-D, results/p3/wb-d.md, protocol/render-stream-13-binary-design.md) reads a /11 or
# /12 file recording and re-encodes every transaction record as the binary structure the /13 design
# proposes, under several block codings, then measures each warm patch raw, zstd-3 per message and
# zstd-3 with the previous message of the same coding as a raw prefix (W11t's base-prefix coding).
# Every lossless coding is decoded back and compared with the recording (structure by canonical
# JSON bytes, blocks byte for byte), so the lossless rows are measured, not estimated.
#
# The schema is learned from the recording (per JSON path: key tuples, value types, string tables).
# A real /13 fixes it in the spec; learning it gives the byte count of a schema encoding without
# writing one per table. Each object pays a shape id only where its path has more than one shape
# (commands: the op), and each value a type tag only where its path has more than one type, so the
# counts are those of a fixed schema, give or take enum widths.

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")  # /13's predict_check (BIN-D): 8 bytes in a binary syntax
BLOCKS13 = ["item_f32", "canvas_f32", "cmd_f32", "cmd_i32", "mesh_f32", "param_f64", "backbuffer_f32",
            "mesh_u8", "mm_f32", "pt_f32"]
BLOCK_TYPE13 = {"cmd_i32": "i32", "param_f64": "f64", "mesh_u8": "u8"}
OPTIONAL_BLOCKS13 = {"pt_f32"}  # /12: present only when non-empty


def uvarint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_uvarint(buf, p):
    n = shift = 0
    while True:
        b = buf[p]
        p += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return n, p


def zz(n: int) -> int:
    return n * 2 if n >= 0 else -n * 2 - 1


def unzz(u: int) -> int:
    return u >> 1 if not u & 1 else -((u + 1) >> 1)


def tname(v) -> str:
    if v is None:
        return "n"
    if isinstance(v, bool):
        return "b"
    if isinstance(v, int):
        return "i"
    if isinstance(v, str):
        return "s"
    if isinstance(v, list):
        return "l"
    if isinstance(v, dict):
        return "d"
    raise ValueError(f"unexpected JSON value type {type(v).__name__} (floats never appear in meta)")


TAGS = "nbisld"


class Schema13:
    """The stand-in for /13's fixed transaction schema (see the section comment)."""

    def __init__(self):
        self.shapes = {}  # path -> {key tuple: id}
        self.types = {}  # path -> set of tnames
        self.strs = {}  # path -> {string: id}
        self.hex = {}  # path -> (all hex64, any hex64)
        self.hex16 = {}  # path -> every value 16 lowercase hex digits
        self.frozen = False

    def learn(self, v, path):
        t = tname(v)
        self.types.setdefault(path, set()).add(t)
        if t == "d":
            kt = tuple(v.keys())
            sh = self.shapes.setdefault(path, {})
            if kt not in sh:
                sh[kt] = len(sh)
            for k, x in v.items():
                self.learn(x, path + "." + k)
        elif t == "l":
            for x in v:
                self.learn(x, path + "[]")
        elif t == "s":
            h = bool(HEX64.match(v))
            a, b = self.hex.get(path, (True, False))
            self.hex[path] = (a and h, b or h)
            self.hex16[path] = self.hex16.get(path, True) and bool(HEX16.match(v))
            st = self.strs.setdefault(path, {})
            if len(st) <= 256 and v not in st:
                st[v] = len(st)

    def freeze(self):
        self.mode = {}
        for path, (allh, anyh) in self.hex.items():
            if allh:
                self.mode[path] = "hex"
            elif self.hex16.get(path):
                self.mode[path] = "hex16"
            elif not anyh and len(self.strs[path]) <= 255:
                self.mode[path] = "enum"
            else:
                self.mode[path] = "text"
        self.rshapes = {p: {i: k for k, i in sh.items()} for p, sh in self.shapes.items()}
        self.rstrs = {p: {i: s for s, i in st.items()} for p, st in self.strs.items()}
        self.frozen = True

    def enc(self, v, path, out: bytearray):
        types = self.types[path]
        t = tname(v)
        if len(types) > 1:
            if types == {"n", "i"}:
                out += uvarint(0 if v is None else zz(v) + 1)
                return
            if len(types) == 2 and "n" in types:
                out.append(0 if v is None else 1)
            else:
                out.append(TAGS.index(t))
        if t == "n":
            return
        if t == "b":
            out.append(1 if v else 0)
        elif t == "i":
            out += uvarint(zz(v))
        elif t == "s":
            m = self.mode[path]
            if m == "enum":
                out += uvarint(self.strs[path][v])
            elif m in ("hex", "hex16"):
                out += bytes.fromhex(v)
            else:
                b = v.encode()
                out += uvarint(len(b)) + b
        elif t == "l":
            out += uvarint(len(v))
            for x in v:
                self.enc(x, path + "[]", out)
        else:
            sh = self.shapes[path]
            if len(sh) > 1:
                out += uvarint(sh[tuple(v.keys())])
            for k, x in v.items():
                self.enc(x, path + "." + k, out)

    def dec(self, buf, p, path):
        types = self.types[path]
        if len(types) > 1:
            if types == {"n", "i"}:
                u, p = read_uvarint(buf, p)
                return (None if u == 0 else unzz(u - 1)), p
            if len(types) == 2 and "n" in types:
                present = buf[p]
                p += 1
                if not present:
                    return None, p
                t = next(iter(types - {"n"}))
            else:
                t = TAGS[buf[p]]
                p += 1
        else:
            t = next(iter(types))
        if t == "n":
            return None, p
        if t == "b":
            return bool(buf[p]), p + 1
        if t == "i":
            u, p = read_uvarint(buf, p)
            return unzz(u), p
        if t == "s":
            m = self.mode[path]
            if m == "enum":
                u, p = read_uvarint(buf, p)
                return self.rstrs[path][u], p
            if m == "hex":
                return bytes(buf[p : p + 32]).hex(), p + 32
            if m == "hex16":
                return bytes(buf[p : p + 8]).hex(), p + 8
            n, p = read_uvarint(buf, p)
            return bytes(buf[p : p + n]).decode(), p + n
        if t == "l":
            n, p = read_uvarint(buf, p)
            out = []
            for _ in range(n):
                x, p = self.dec(buf, p, path + "[]")
                out.append(x)
            return out, p
        sh = self.shapes[path]
        sid = 0
        if len(sh) > 1:
            sid, p = read_uvarint(buf, p)
        out = {}
        for k in self.rshapes[path][sid]:
            out[k], p = self.dec(buf, p, path + "." + k)
        return out, p


def unshuffle4(b: bytes) -> bytes:
    n = len(b) // 4
    planes = [b[i * n : (i + 1) * n] for i in range(4)]
    out = bytearray(4 * n)
    for i in range(4):
        out[i::4] = planes[i]
    return bytes(out) + b[4 * n :]


def sub_i32(a: bytes, b: bytes) -> bytes:
    return sub_words(a, b)


def add_i32(d: bytes, b: bytes) -> bytes:
    n = len(d) // 4
    vd = struct.unpack(f"<{n}I", d)
    vb = struct.unpack(f"<{n}I", b)
    return struct.pack(f"<{n}I", *[(x + y) & 0xFFFFFFFF for x, y in zip(vd, vb)])


def surface_parts(s: dict):
    """Byte lengths of a dynamic surface body's parts: geometry (40), positions, colours, UVs,
    skin, indices (render-stream-4.md "Mesh payload"). The attribute section interleaves colour
    and UV per vertex."""
    n, fmt, ic = s["vertex_count"], s["format"], s["index_count"]
    has_c, has_uv = bool(fmt & (1 << 3)), bool(fmt & (1 << 4))
    skin = 0
    if fmt & (1 << 10) and fmt & (1 << 11):
        skin = n * (32 if fmt & (1 << 27) else 16)
    idx = 0 if ic == 0 else ic * (2 if n <= 65536 else 4)
    return n, has_c, has_uv, skin, idx


def split_body(body: bytes, s: dict):
    """One surface body -> (geo, pos, col, uv, skin, idx) byte strings (colour and UV
    de-interleaved: the structure-of-arrays the /13 design sends)."""
    n, has_c, has_uv, skin, idx = surface_parts(s)
    geo, p = body[:40], 40
    pos = body[p : p + 8 * n]
    p += 8 * n
    stride = (4 if has_c else 0) + (8 if has_uv else 0)
    attr = body[p : p + stride * n]
    p += stride * n
    col = b"".join(attr[k * stride : k * stride + 4] for k in range(n)) if has_c else b""
    o = 4 if has_c else 0
    uv = b"".join(attr[k * stride + o : k * stride + o + 8] for k in range(n)) if has_uv else b""
    sk = body[p : p + skin]
    p += skin
    ix = body[p : p + idx]
    return geo, pos, col, uv, sk, ix


def join_body(parts, s: dict) -> bytes:
    geo, pos, col, uv, sk, ix = parts
    n, has_c, has_uv, _skin, _idx = surface_parts(s)
    attr = bytearray()
    for k in range(n):
        if has_c:
            attr += col[4 * k : 4 * k + 4]
        if has_uv:
            attr += uv[8 * k : 8 * k + 8]
    return geo + pos + bytes(attr) + sk + ix


def shape_key(surfaces):
    return tuple((s["primitive"], s["format"], s["vertex_count"], s["index_count"]) for s in surfaces)


# Codings: name -> (layout, numeric mode, position step or None). `aos` keeps each body's bytes in
# place; `soa` gathers every body's geometry, positions, colours, UVs, skin and indices into six
# streams and byte-plane shuffles the float streams. Numeric modes, per 32-bit word against the
# same word of the base (the mesh's last sent body, the item's or multimesh's resolved floats):
#   raw   unchanged;
#   xor   bit-pattern XOR (WB);
#   sub   u32 subtraction of the bit patterns;
#   zz    the float mapped to an order-preserving integer, subtracted, zigzagged;
#   p2    as zz against the linear prediction 2*last - previous (a dynamic mesh's last two sent
#         bodies; floats with no history fall back to zz).
# A position step quantizes dynamic mesh positions to integers of that many local units (lossy,
# measured as screen error); everything else in that coding is lossless.
# The fourth field names the float blocks predicted besides mesh_u8. `w13` is the coding the /13
# design specifies (protocol/render-stream-13.md "Predicted blocks"): the dynamic bodies, the custom
# AABBs and the multimesh buffers predicted to second order, every other block as /12 sends it.
# `json_w13` is w13's blocks behind /12's JSON meta and framing (the structure's own share).
ALL_FLOAT_BLOCKS = ("item_f32", "cmd_f32", "mm_f32", "mesh_f32")
W13_FLOAT_BLOCKS = ("mm_f32", "mesh_f32")
CODINGS13 = {
    "bin": ("aos", "raw", None, ALL_FLOAT_BLOCKS),
    "bin_xor": ("aos", "xor", None, ALL_FLOAT_BLOCKS),
    "bin_xor_soa": ("soa", "xor", None, ALL_FLOAT_BLOCKS),
    "bin_sub_soa": ("soa", "sub", None, ALL_FLOAT_BLOCKS),
    "bin_zz_soa": ("soa", "zz", None, ALL_FLOAT_BLOCKS),
    "bin_p2_soa": ("soa", "p2", None, ALL_FLOAT_BLOCKS),
    "bin_q16": ("soa", "zz", 1 / 16, ALL_FLOAT_BLOCKS),
    "bin_q64": ("soa", "zz", 1 / 64, ALL_FLOAT_BLOCKS),
    "bin_q256": ("soa", "zz", 1 / 256, ALL_FLOAT_BLOCKS),
    "bin_q64p2": ("soa", "p2", 1 / 64, ALL_FLOAT_BLOCKS),
    "w13": ("soa", "p2", None, W13_FLOAT_BLOCKS),
    "json_w13": ("soa", "p2", None, W13_FLOAT_BLOCKS),
    "w13_q16": ("soa", "p2", 1 / 16, W13_FLOAT_BLOCKS),
    "w13_q64": ("soa", "p2", 1 / 64, W13_FLOAT_BLOCKS),
    "w13_q256": ("soa", "p2", 1 / 256, W13_FLOAT_BLOCKS),
}
LOSSLESS13 = tuple(k for k, v in CODINGS13.items() if v[2] is None and k != "json_w13")
QSTEPS13 = {k: v[2] for k, v in CODINGS13.items() if v[2] is not None}
FLOAT_STREAMS = (0, 1, 3)  # geometry, positions, UVs (colours, skin and indices are bytes: XOR)
M32 = 0xFFFFFFFF


def ordered(u: int) -> int:
    return u ^ 0x80000000 if u < 0x80000000 else (~u) & M32


def unordered(o: int) -> int:
    return o ^ 0x80000000 if o >= 0x80000000 else (~o) & M32


def zz32(d: int) -> int:
    d &= M32
    s = d - (1 << 32) if d & 0x80000000 else d
    return ((s << 1) ^ (s >> 31)) & M32


def unzz32(u: int) -> int:
    return ((u >> 1) ^ -(u & 1)) & M32


def words(b: bytes):
    return struct.unpack(f"<{len(b) // 4}I", b)


def pack_words(w) -> bytes:
    return struct.pack(f"<{len(w)}I", *w)


def num_delta(cur: bytes, base: bytes | None, prev: bytes | None, mode: str, ints=False) -> bytes:
    """One float (or, with `ints`, quantized-integer) stream against its base. A missing base is
    zeros (a body new to the receiver goes raw); a missing previous makes p2 first order."""
    if mode == "raw":
        return cur
    if base is None or len(base) != len(cur):
        base, prev = bytes(len(cur)), None
    if prev is not None and len(prev) != len(cur):
        prev = None
    if mode == "xor":
        return xor_bytes(cur, base)
    c, b = words(cur), words(base)
    if mode == "sub":
        return pack_words([(x - y) & M32 for x, y in zip(c, b)])
    o = (lambda v: v) if ints else ordered
    if mode == "zz" or prev is None:
        return pack_words([zz32(o(x) - o(y)) for x, y in zip(c, b)])
    p = words(prev)
    return pack_words([zz32(o(x) - (2 * o(y) - o(z))) for x, y, z in zip(c, b, p)])


def num_undelta(d: bytes, base: bytes | None, prev: bytes | None, mode: str) -> bytes:
    if mode == "raw":
        return d
    if base is None or len(base) != len(d):
        base, prev = bytes(len(d)), None
    if prev is not None and len(prev) != len(d):
        prev = None
    if mode == "xor":
        return xor_bytes(d, base)
    w, b = words(d), words(base)
    if mode == "sub":
        return pack_words([(x + y) & M32 for x, y in zip(w, b)])
    if mode == "zz" or prev is None:
        return pack_words([unordered((unzz32(x) + ordered(y)) & M32) for x, y in zip(w, b)])
    p = words(prev)
    return pack_words([unordered((unzz32(x) + 2 * ordered(y) - ordered(z)) & M32) for x, y, z in zip(w, b, p)])


def q_positions(pos: bytes, step: float) -> bytes:
    n = len(pos) // 4
    return struct.pack(f"<{n}i", *[max(-(2**31), min(2**31 - 1, round(v / step))) if math.isfinite(v) else 0
                                   for v in struct.unpack(f"<{n}f", pos)])


def lin_norm(a, b, c, d) -> float:
    """Spectral norm of the 2x2 linear part [[a, c], [b, d]] (Godot x.x, x.y, y.x, y.y)."""
    p = a * a + b * b + c * c + d * d
    q = (a * d - b * c) ** 2
    return math.sqrt(max(0.0, (p + math.sqrt(max(0.0, p * p - 4 * q))) / 2))


class Proto13:
    """Tracks the resolved state a /13 delta needs (each dynamic mesh's last two sent bodies,
    multimesh buffers, item and command floats by item) and encodes each transaction under every
    coding."""

    def __init__(self, schema: Schema13, verify: bool):
        self.s = schema
        self.verify = verify
        self.bodies = {}  # mesh id -> (shape key, [surface body bytes]): the last sent
        self.prevbodies = {}  # mesh id -> the one sent before it (same shape), for p2
        self.mm = {}  # multimesh id -> buffer bytes
        self.meshf = {}  # mesh id -> its 6 mesh_f32 floats (custom AABB)
        self.meshf_prev, self.mm_prev = {}, {}  # the values before those, for p2
        self.itemf = {}  # item id -> item_f32 bytes
        self.cmdf = {}  # item id -> its cmd_f32 slice
        self.items = {}  # item id -> (parent, xform 6, commands, cmd floats) for the error bound
        self.canvases = {}
        self.qhist = {}  # (coding, mesh id, surface) -> (last, previous) quantized positions
        self.verified = 0
        self.max_scale = 0.0
        self.qerr = {k: 0.0 for k in QSTEPS13}

    # -- structure
    def structure(self, meta):
        m = {k: v for k, v in meta.items() if k not in ("type", "blocks")}
        out = bytearray()
        self.s.enc(m, "tx", out)
        return bytes(out), m

    def structure_parts(self, meta):
        """Bytes per top-level key of the binary structure (the sum is the structure)."""
        parts = {}
        for k, v in meta.items():
            if k in ("type", "blocks"):
                continue
            out = bytearray()
            self.s.enc(v, "tx." + k, out)
            parts[k] = len(out)
        return parts

    # -- block codings
    def dyn_jobs(self, meta, u8: bytes | None):
        """(mesh id, surface index, surface, body or None, base body, previous body) per dynamic
        surface the transaction carries (u8 non-null), in wire order."""
        jobs = []
        for me in meta.get("meshes", []):
            if me.get("u8") is None:
                continue
            sk = shape_key(me["surfaces"])
            base = self.bodies.get(me["id"])
            same = base is not None and base[0] == sk
            prev = self.prevbodies.get(me["id"]) if same else None
            pv = prev is not None and prev[0] == sk
            off = me["u8"]
            for k, s in enumerate(me["surfaces"]):
                body = u8[off : off + s["payload_bytes"]] if u8 is not None else None
                off += s["payload_bytes"]
                jobs.append((me["id"], k, s, body, base[1][k] if same else None, prev[1][k] if pv else None))
        return jobs

    def mesh_code(self, meta, u8: bytes, coding: str, commit_q: bool) -> bytes:
        layout, mode, qstep, _fb = CODINGS13[coding]
        jobs = self.dyn_jobs(meta, u8)
        if layout == "aos":
            return b"".join(num_delta(body, bb, None, "raw" if mode == "raw" else "xor") for _m, _k, _s, body, bb, _p in jobs)
        streams = [bytearray() for _ in range(6)]
        for mid, k, s, body, bb, pb in jobs:
            cur = split_body(body, s)
            ref = split_body(bb, s) if bb is not None else None
            prv = split_body(pb, s) if pb is not None else None
            for i in range(6):
                r = ref[i] if ref else None
                p = prv[i] if prv else None
                if i == 1 and qstep is not None:
                    qc = q_positions(cur[1], qstep)
                    key = (coding, mid, k)
                    last, before = self.qhist.get(key, (None, None)) if ref is not None else (None, None)
                    streams[1] += num_delta(qc, last, before, mode, ints=True)
                    if commit_q:
                        self.qhist[key] = (qc, last)
                elif i in FLOAT_STREAMS:
                    streams[i] += num_delta(cur[i], r, p, mode)
                else:
                    streams[i] += xor_bytes(cur[i], r) if r is not None and len(r) == len(cur[i]) else cur[i]
        return b"".join(shuffle4(bytes(st)) if i in FLOAT_STREAMS else bytes(st) for i, st in enumerate(streams))

    def mesh_decode(self, meta, data: bytes, coding: str) -> bytes:
        """The inverse of mesh_code for the lossless codings: the original mesh_u8."""
        layout, mode, _q, _fb = CODINGS13[coding]
        jobs = self.dyn_jobs(meta, None)
        if layout == "aos":
            out, p = bytearray(), 0
            for _m, _k, s, _b, bb, _p in jobs:
                n = s["payload_bytes"]
                out += num_undelta(data[p : p + n], bb, None, "raw" if mode == "raw" else "xor")
                p += n
            return bytes(out)
        lens = [0] * 6
        for _m, _k, s, _b, _bb, _p in jobs:
            for i, part in enumerate(split_body(bytes(s["payload_bytes"]), s)):
                lens[i] += len(part)
        streams, p = [], 0
        for i in range(6):
            chunk = data[p : p + lens[i]]
            p += lens[i]
            streams.append(unshuffle4(chunk) if i in FLOAT_STREAMS else chunk)
        out, at = bytearray(), [0] * 6
        for _m, _k, s, _b, bb, pb in jobs:
            ref = split_body(bb, s) if bb is not None else None
            prv = split_body(pb, s) if pb is not None else None
            sizes = [len(x) for x in split_body(bytes(s["payload_bytes"]), s)]
            parts = []
            for i in range(6):
                d = streams[i][at[i] : at[i] + sizes[i]]
                at[i] += sizes[i]
                r = ref[i] if ref else None
                if i in FLOAT_STREAMS:
                    parts.append(num_undelta(d, r, prv[i] if prv else None, mode))
                else:
                    parts.append(xor_bytes(d, r) if r is not None and len(r) == len(d) else d)
            out += join_body(parts, s)
        return bytes(out)

    def float_code(self, data: bytes, segs, coding: str, inverse=False) -> bytes:
        """item_f32 / cmd_f32 / mm_f32 / mesh_f32: each (offset, length, base, previous) segment
        against its base (p2 uses the previous where one is kept: multimesh buffers and custom
        AABBs; item and command floats are first order); SoA codings shuffle the block."""
        layout, mode, _q, _fb = CODINGS13[coding]
        if mode == "raw":
            return data
        if inverse and layout == "soa":
            data = unshuffle4(data)
        buf = bytearray(data)
        for off, n, base, prev in segs:
            if base is None or len(base) != n:
                continue
            cur = bytes(buf[off : off + n])
            pv = prev if mode == "p2" else None
            buf[off : off + n] = num_undelta(cur, base, pv, mode) if inverse else num_delta(cur, base, pv, mode)
        out = bytes(buf)
        if not inverse and layout == "soa":
            out = shuffle4(out)
        return out

    def segments(self, meta, rec):
        """Delta segments per float block, against the resolved state before this transaction."""
        full = meta.get("encoding") == "full"
        items = meta.get("items", [])
        itf = rec.blocks.get("item_f32", ("f32", 0, b""))[2]
        per = len(itf) // max(1, len(items)) if items else 0
        seg_item = [(k * per, per, None if full else self.itemf.get(it["id"]), None) for k, it in enumerate(items)]
        cmdb = rec.blocks.get("cmd_f32", ("f32", 0, b""))[2]
        starts = []
        for it in items:
            fs = [c["f"] for c in (it.get("commands") or []) if "f" in c]
            if fs:
                starts.append((it["id"], 4 * min(fs)))
        seg_cmd = []
        for k, (iid, o) in enumerate(starts):
            end = starts[k + 1][1] if k + 1 < len(starts) else len(cmdb)
            seg_cmd.append((o, end - o, None if full else self.cmdf.get(iid), None))
        mmb = rec.blocks.get("mm_f32", ("f32", 0, b""))[2]
        seg_mm = []
        for e in meta.get("multimeshes", []):
            if e.get("buffer_f") is None:
                continue
            stride = (12 if e.get("format") == "3d" else 8) + 4 * bool(e.get("colors")) + 4 * bool(e.get("custom"))
            seg_mm.append((4 * e["buffer_f"], 4 * stride * e["instances"], None if full else self.mm.get(e["id"]),
                           None if full else self.mm_prev.get(e["id"])))
        seg_mesh = [(4 * me["f"], 24, None if full else self.meshf.get(me["id"]),
                     None if full else self.meshf_prev.get(me["id"]))
                    for me in meta.get("meshes", []) if me.get("f") is not None]
        return {"item_f32": seg_item, "cmd_f32": seg_cmd, "mm_f32": seg_mm, "mesh_f32": seg_mesh}, itf, cmdb, mmb

    def encode(self, meta, rec, coding, struct_b, segs):
        """One transaction as a /13 prototype message: type byte, length, structure, then each
        block as a length and its coded bytes. Returns (message, structure bytes, coded blocks)."""
        blocks = {}
        for name in BLOCKS13:
            data = rec.blocks.get(name, (None, 0, b""))[2]
            if name == "mesh_u8":
                data = self.mesh_code(meta, data, coding, commit_q=True)
            elif name in segs and name in CODINGS13[coding][3]:
                data = self.float_code(data, segs[name], coding)
            blocks[name] = data
        body = bytearray(struct_b)
        for name in BLOCKS13:
            body += uvarint(len(blocks[name])) + blocks[name]
        msg = bytes([2]) + uvarint(len(body)) + bytes(body)
        return msg, len(struct_b), blocks

    def check_roundtrip(self, meta, rec, coding, msg):
        """Decode a lossless message back to the record's meta (canonical JSON bytes) and blocks."""
        p = 1
        _n, p = read_uvarint(msg, p)
        m, p = self.s.dec(msg, p, "tx")
        if cj(m) != cj({k: v for k, v in meta.items() if k not in ("type", "blocks")}):
            return "structure"
        segs, _a, _b, _c = self.segments(m, rec)  # the decoder's own view (state before this tx)
        for name in BLOCKS13:
            n, p = read_uvarint(msg, p)
            data = msg[p : p + n]
            p += n
            if name == "mesh_u8":
                data = self.mesh_decode(m, data, coding)
            elif name in segs and name in CODINGS13[coding][3]:
                data = self.float_code(data, segs[name], coding, inverse=True)
            want = rec.blocks.get(name, (None, 0, b""))[2]
            if data != want:
                return name
            d = next((b for b in meta["blocks"] if b["name"] == name), None)
            if d is None and n:  # an absent block (optional, or not in this version) is empty
                return name + "-descriptor"
        return None

    # -- state after the transaction (shared by every coding: the lossless ones reproduce it)
    def advance(self, meta, rec):
        full = meta.get("encoding") == "full"
        if full:
            self.bodies, self.mm, self.itemf, self.cmdf = {}, {}, {}, {}
            self.items, self.canvases = {}, {}
            self.prevbodies, self.qhist, self.meshf = {}, {}, {}
            self.meshf_prev, self.mm_prev = {}, {}
        segs, itf, cmdb, mmb = self.segments(meta, rec)
        for (off, n, _b, _p), it in zip(segs["item_f32"], meta.get("items", [])):
            self.itemf[it["id"]] = itf[off : off + n]
        k = 0
        for it in meta.get("items", []):
            cmds = it.get("commands")
            if cmds is None:
                continue
            if any("f" in c for c in cmds):
                off, n, _b, _p = segs["cmd_f32"][k]
                self.cmdf[it["id"]] = cmdb[off : off + n]
                k += 1
            else:
                self.cmdf.pop(it["id"], None)
        for iid in meta.get("removed_items", []):
            self.itemf.pop(iid, None)
            self.cmdf.pop(iid, None)
            self.items.pop(iid, None)
        for (off, n, _b, _p), e in zip(segs["mm_f32"], [e for e in meta.get("multimeshes", []) if e.get("buffer_f") is not None]):
            old = self.mm.get(e["id"])
            if old is not None and len(old) == n:
                self.mm_prev[e["id"]] = old
            else:
                self.mm_prev.pop(e["id"], None)
            self.mm[e["id"]] = mmb[off : off + n]
        for e in meta.get("multimeshes", []):
            if e.get("status") != "ok":
                self.mm.pop(e["id"], None)
                self.mm_prev.pop(e["id"], None)
        for mid in meta.get("removed_multimeshes", []):
            self.mm.pop(mid, None)
            self.mm_prev.pop(mid, None)
        new = {}
        for mid, _k, s, body, _bb, _pb in self.dyn_jobs(meta, rec.blocks.get("mesh_u8", (None, 0, b""))[2]):
            new.setdefault(mid, []).append((s, body))
        for me in meta.get("meshes", []):
            mid = me["id"]
            if mid in new:
                sk = shape_key([s for s, _b in new[mid]])
                old = self.bodies.get(mid)
                if old is not None and old[0] == sk:
                    self.prevbodies[mid] = old
                else:
                    self.prevbodies.pop(mid, None)
                self.bodies[mid] = (sk, [b for _s, b in new[mid]])
            elif me.get("status") != "ok" or any(s.get("hash") for s in me["surfaces"]):
                self.bodies.pop(mid, None)
                self.prevbodies.pop(mid, None)
        mf = rec.blocks.get("mesh_f32", ("f32", 0, b""))[2]
        for me in meta.get("meshes", []):
            if me.get("f") is not None:
                old = self.meshf.get(me["id"])
                if old is not None:
                    self.meshf_prev[me["id"]] = old
                self.meshf[me["id"]] = mf[4 * me["f"] : 4 * me["f"] + 24]
            else:
                self.meshf.pop(me["id"], None)
                self.meshf_prev.pop(me["id"], None)
        for mid in meta.get("removed_meshes", []):
            self.bodies.pop(mid, None)
            self.prevbodies.pop(mid, None)
            self.meshf.pop(mid, None)
            self.meshf_prev.pop(mid, None)
        # the transform chain, for the quantized codings' error bound
        canv = rec.blocks.get("canvas_f32", ("f32", 0, b""))[2]
        cs = meta.get("canvases", [])
        if cs and canv:
            per = len(canv) // 4 // len(cs)
            for k2, e in enumerate(cs):
                self.canvases[e["id"]] = struct.unpack_from("<6f", canv, 4 * per * k2)
        for (off, n, _b, _p), it in zip(segs["item_f32"], meta.get("items", [])):
            prev = self.items.get(it["id"])
            cmds = it.get("commands")
            if cmds is None:
                cmds = prev[2] if prev is not None else []
            self.items[it["id"]] = (it["parent"], struct.unpack_from("<6f", itf, off), cmds, self.cmdf.get(it["id"], b""))

    def gx(self, iid, memo, depth=0):
        if iid in memo:
            return memo[iid]
        it = self.items.get(iid)
        if it is None or depth > 256:
            return IDENT
        par = it[0]
        if isinstance(par, dict) and par.get("kind") == "item":
            g = compose(self.gx(par["id"], memo, depth + 1), it[1])
        elif isinstance(par, dict) and par.get("kind") == "canvas":
            g = compose(self.canvases.get(par["id"], IDENT), it[1])
        else:
            g = it[1]
        memo[iid] = g
        return g

    def mesh_scales(self):
        """Mesh id -> the largest spectral norm of the linear part it is drawn through (canvas,
        item chain, the item's current set_transform, the add_mesh transform)."""
        memo, out = {}, {}
        for iid, (_p, _x, cmds, cf) in self.items.items():
            if not any(c.get("op") == "add_mesh" for c in cmds):
                continue
            g = self.gx(iid, memo)
            base_f = min((c["f"] for c in cmds if "f" in c), default=0)
            cur = g
            for c in cmds:
                op = c.get("op")
                if op == "add_set_transform":
                    o = 4 * (c["f"] - base_f)
                    if o + 24 <= len(cf):
                        cur = compose(g, struct.unpack_from("<6f", cf, o))
                elif op == "add_mesh":
                    o = 4 * (c["f"] - base_f)
                    t = struct.unpack_from("<6f", cf, o) if o + 24 <= len(cf) else IDENT
                    a = compose(cur, t)
                    nrm = lin_norm(*a[:4])
                    out[c["mesh"]] = max(out.get(c["mesh"], 0.0), nrm)
        return out

    def quant_error(self, meta, rec):
        """Largest screen error (px) of each quantized coding's positions in this transaction:
        |q*step - v| per vertex through the mesh's largest drawn scale (the norm bound)."""
        scales = self.mesh_scales()
        u8 = rec.blocks.get("mesh_u8", (None, 0, b""))[2]
        for me in meta.get("meshes", []):
            if me.get("u8") is None:
                continue
            sc = scales.get(me["id"], 0.0)
            self.max_scale = max(self.max_scale, sc)
            off = me["u8"]
            for s in me["surfaces"]:
                body = u8[off : off + s["payload_bytes"]]
                off += s["payload_bytes"]
                pos = split_body(body, s)[1]
                vals = struct.unpack(f"<{len(pos) // 4}f", pos)
                for name, step in QSTEPS13.items():
                    e = 0.0
                    for k in range(0, len(vals) - 1, 2):
                        ex = abs(round(vals[k] / step) * step - vals[k])
                        ey = abs(round(vals[k + 1] / step) * step - vals[k + 1])
                        e = max(e, math.hypot(ex, ey))
                    self.qerr[name] = max(self.qerr[name], e * sc)


JSON_CATS = {"items": None, "meshes": "mesh", "multimeshes": "multimesh", "removed_multimeshes": "multimesh",
             "particles": "particles", "removed_particles": "particles", "particle_emits": "particles",
             "textures": "tables_other", "shaders": "tables_other", "materials": "tables_other",
             "canvases": "tables_other", "unsupported": "unsupported", "blocks": "block_descriptors"}
BLOCK_CATS = {"item_f32": "item_f32", "cmd_f32": "cmd_f32", "mesh_u8": "mesh_u8", "mm_f32": "mm_f32",
              "pt_f32": "particles"}


def json_categories(meta, rec):
    """The /12 record split into categories whose byte counts sum to the record (4 + record_len),
    each with the bytes themselves (for per-category coding against the base's same category)."""
    cats = {}

    def add(k, b):
        cats[k] = cats.get(k, b"") + b

    nb = len(meta.get("blocks", []))
    add("framing", b"\0" * (12 + 4 * nb))
    first = True
    for k, v in meta.items():
        frag = (b"" if first else b",") + cj(k) + b":"
        first = False
        cat = JSON_CATS.get(k, "header")
        if k == "items":
            add("item_state_json", frag + b"[]")
            for i, it in enumerate(v):
                cmds = it.get("commands")
                if cmds is None:
                    add("item_state_json", (b"," if i else b"") + cj(it))
                    continue
                add("item_state_json", (b"," if i else b"") + cj({**it, "commands": []}))
                for j, c in enumerate(cmds):
                    add("cmd_json_" + op_group(c["op"]), (b"," if j else b"") + cj(c))
            continue
        if k == "meshes":
            hs = [s["hash"] for me in v for s in me["surfaces"] if s.get("hash")]
            nulled = [{**me, "surfaces": [{**s, "hash": None} for s in me["surfaces"]]} for me in v]
            add("mesh_json", frag + cj(nulled))
            add("mesh_hash_json", b"".join(h.encode()[:62] for h in hs))
            continue
        add(cat + ("_json" if cat not in ("header", "particles", "block_descriptors") else ""), frag + cj(v))
    add("header", b"{}")
    for name, (_t, _c, data) in rec.blocks.items():
        add(BLOCK_CATS.get(name, "blocks_other"), data)
    return cats


def cmd_proto13(argv):
    ap = argparse.ArgumentParser(prog="wire-budget.py proto13")
    ap.add_argument("--recording", required=True)
    ap.add_argument("--scene", action="append", required=True)
    ap.add_argument("--warm-skip", type=int, default=30)
    ap.add_argument("--verify-every", type=int, default=1, help="round-trip every Nth warm patch (0: none)")
    ap.add_argument("--quant-every", type=int, default=10, help="quantization error on every Nth warm patch")
    ap.add_argument("--codings", default=",".join(CODINGS13))
    ap.add_argument("--max-frame", type=int, default=0, help="stop after this frame (0: the whole recording)")
    ap.add_argument("--attribute", default="bin,w13,w13_q64",
                    help="codings whose structure and blocks are also coded one by one, each against its own base")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    if zstd is None:
        print("wire-budget proto13: needs Python 3.14's compression.zstd (mise exec -- python3)", file=sys.stderr)
        return 2
    codings = a.codings.split(",")
    scenes = []
    for spec in a.scene:
        name, rng = spec.split(":")
        f0, f1 = (int(x) for x in rng.split("-"))
        scenes.append((name, f0, f1))
    t0 = time.time()
    schema = Schema13()
    version = None
    for ver, rec in read_records(a.recording):
        version = ver
        if rec.meta.get("type") == "transaction":
            schema.learn({k: v for k, v in rec.meta.items() if k not in ("type", "blocks")}, "tx")
    schema.freeze()
    pr = Proto13(schema, a.verify_every > 0)
    rows = {name: {} for name, _f0, _f1 in scenes}
    prev = {}  # coding -> previous message (the base-prefix coding's prefix)
    prev_cat = {}
    prev_parts = {}  # coding -> {part: bytes} of the previous message
    attribute = [c for c in a.attribute.split(",") if c]
    pending = []
    failures = []
    warm_n = {name: 0 for name, _f0, _f1 in scenes}
    particles_tx = {name: 0 for name, _f0, _f1 in scenes}
    for ver, rec in read_records(a.recording):
        meta = rec.meta
        kind = meta.get("type")
        if kind == "resource":
            pending.append(rec.size)
            continue
        if kind != "transaction":
            continue
        frame = meta["frame"]
        if a.max_frame and frame > a.max_frame:
            break
        sc = next((s for s in scenes if s[1] + a.warm_skip <= frame <= s[2]), None)
        warm = sc is not None and meta["encoding"] == "patch"
        msgs = {}
        struct_b, _m = pr.structure(meta)
        segs, _itf, _cmdb, _mmb = pr.segments(meta, rec)
        parts_now = {}
        for c in codings:
            msg, struct_n, blocks = pr.encode(meta, rec, c, struct_b, segs)
            if c == "json_w13":  # w13's blocks behind /12's JSON meta and framing
                msg = record_bytes(meta, rec, blocks)
                struct_n = len(rec.meta_bytes)
            msgs[c] = (msg, struct_n)
            if c in attribute:
                parts_now[c] = {"structure": struct_b, **blocks}
        if warm:
            r = rows[sc[0]]
            warm_n[sc[0]] += 1

            def add(key, v, r=r):
                r.setdefault(key, []).append(v)

            rec_bytes = sum(n + ws_header(n) for n in pending)
            add("resource_records", len(pending))
            add("resource_record_bytes", rec_bytes)
            if any(k in meta for k in ("particles", "removed_particles", "particle_emits")):
                particles_tx[sc[0]] += 1
            # the /12 record as recorded, by category, raw and coded against the base's category
            cats = json_categories(meta, rec)
            tot = 0
            for k, b in cats.items():
                add("json." + k, len(b))
                tot += len(b)
                pb = prev_cat.get(k)
                if pb:
                    zc = len(zstd.compress(b, level=3, zstd_dict=zstd.ZstdDict(pb, is_raw=True).as_prefix)) if b else 0
                else:
                    zc = len(zstd.compress(b, level=3)) if b else 0
                add("json_coded." + k, zc)
            add("json.record", rec.size)
            if tot != rec.size:
                failures.append(f"seq {meta['seq']}: categories sum {tot} != record {rec.size}")
            # the whole /12 record as W11t codes it (+24 B envelope, +4 B checksum)
            add("json.message", rec.size + ws_header(rec.size) + rec_bytes)
            for c, (msg, struct_n) in msgs.items():
                add(c + ".raw", len(msg))
                add(c + ".structure", struct_n)
                add(c + ".message", len(msg) + ws_header(len(msg)) + rec_bytes)
                z = len(zstd.compress(msg, level=3)) + 4
                add(c + ".zstd3", z + ws_header(z) + rec_bytes)
                if c in prev:
                    t1 = time.perf_counter()
                    zp = len(zstd.compress(msg, level=3, zstd_dict=zstd.ZstdDict(prev[c], is_raw=True).as_prefix)) + 28
                    add(c + ".zstd3_base_us", (time.perf_counter() - t1) * 1e6)
                    add(c + ".zstd3_base", zp + ws_header(zp) + rec_bytes)
            if warm_n[sc[0]] % 5 == 0:
                for k, n in pr.structure_parts(meta).items():
                    add("bin_part." + k, n)
            for c, parts in parts_now.items():
                for k, b in parts.items():
                    add(f"{c}.part.{k}", len(b))
                    pb = prev_parts.get(c, {}).get(k)
                    if not b:
                        zc = 0
                    elif pb:
                        zc = len(zstd.compress(b, level=3, zstd_dict=zstd.ZstdDict(pb, is_raw=True).as_prefix))
                    else:
                        zc = len(zstd.compress(b, level=3))
                    add(f"{c}.part_coded.{k}", zc)
            if a.verify_every and warm_n[sc[0]] % a.verify_every == 0:
                for c in codings:
                    if c in QSTEPS13 or c == "json_w13":
                        continue
                    bad = pr.check_roundtrip(meta, rec, c, msgs[c][0])
                    if bad:
                        failures.append(f"seq {meta['seq']} {c}: round trip differs in {bad}")
                pr.verified += 1
            if a.quant_every and warm_n[sc[0]] % a.quant_every == 0:
                pr.quant_error(meta, rec)
        # the uncoded /12 record's own base-prefix coding needs the record bytes: rebuild them
        jr = record_bytes(meta, rec)
        if warm and "_json" in prev:
            t1 = time.perf_counter()
            zp = len(zstd.compress(jr, level=3, zstd_dict=zstd.ZstdDict(prev["_json"], is_raw=True).as_prefix)) + 28
            rows[sc[0]].setdefault("json.zstd3_base_us", []).append((time.perf_counter() - t1) * 1e6)
            rows[sc[0]].setdefault("json.zstd3_base", []).append(zp + ws_header(zp) + sum(n + ws_header(n) for n in pending))
            z = len(zstd.compress(jr, level=3)) + 4
            rows[sc[0]].setdefault("json.zstd3", []).append(z + ws_header(z) + sum(n + ws_header(n) for n in pending))
        prev["_json"] = jr
        for c, (msg, _n) in msgs.items():
            prev[c] = msg
        prev_cat = json_categories(meta, rec)
        prev_parts = parts_now
        pr.advance(meta, rec)
        pending = []
    out = {"schema": SCHEMA + "#proto13", "recording": os.path.basename(a.recording), "version": version,
           "warm_skip": a.warm_skip, "codings": codings, "wall_s": round(time.time() - t0, 1),
           "verified_tx": pr.verified, "roundtrip_failures": failures[:50], "roundtrip_failure_count": len(failures),
           "quant": {"max_mesh_scale": round(pr.max_scale, 4),
                     "max_screen_err_px": {k: round(v, 5) for k, v in pr.qerr.items()},
                     "steps_local_units": {k: v for k, v in QSTEPS13.items()}},
           "schema_paths": len(schema.types), "scenes": {}}
    for name, f0, f1 in scenes:
        r = rows[name]
        for k, v in r.items():  # a category absent from a transaction is 0 bytes there
            if (k.startswith("json.") or k.startswith("json_coded.")) and not k.endswith("_us") and \
                    not k.startswith("json.zstd3") and len(v) < warm_n[name]:
                v.extend([0] * (warm_n[name] - len(v)))
        out["scenes"][name] = {"frames": [f0, f1], "warm_tx": warm_n[name], "particles_tx": particles_tx[name],
                               "bytes": {k: row(v) for k, v in sorted(r.items())}}
        b = out["scenes"][name]["bytes"]
        line = ", ".join(f"{c} {b.get(c + '.raw', {}).get('mean')}/{b.get(c + '.zstd3_base', {}).get('mean')}"
                         for c in codings)
        print(f"wire-budget proto13: {name}: {warm_n[name]} warm tx; json {b.get('json.record', {}).get('mean')}/"
              f"{b.get('json.zstd3_base', {}).get('mean')}; {line}", file=sys.stderr)
    print(f"wire-budget proto13: verified {pr.verified} tx, {len(failures)} round-trip failures", file=sys.stderr)
    text = json.dumps(out, indent=1)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 1 if failures else 0

# ---------------------------------------------------------------- BIN-D: today's /13 wire

# BIN-D (results/p3/bin-d.md) measures the /13 wire as built (W13a: /12's JSON meta and framing,
# the three predicted blocks) from a real /13 recording (`rs-core-check transcode --to 13`), and
# what two further wire changes would do to it:
#
# - `b13`: the deferred binary transaction syntax (render-stream-13.md "The syntax"): the meta as
#   Schema13's structure (learned, so within a byte or two an object of a fixed table), the blocks
#   in the design's fixed order, each `uvarint len` + payload, no descriptors;
# - `_zr`: a compact residual: each predicted block (`mesh_f32`, `mesh_u8`, `mm_f32`) as zero runs,
#   `uvarint zeros, uvarint n, n literal bytes` repeated until the plain length (the descriptor's
#   count) is reached. Zero runs shorter than `--zr-min` stay literal. Layout-free: it needs nothing
#   but the plain length, so the byte-plane transposed residual's empty high planes go whole.
#
# Every variant of every warm patch is decoded back (the structure to the record's canonical meta
# bytes, the zero runs to the plain block) before it is counted.

PRED13 = ("mesh_f32", "mesh_u8", "mm_f32")
VARIANTS_BIN13 = ("j13", "j13_zr", "b13", "b13_zr")
ZERO_RUN = {}


def zr_encode(b: bytes, minrun: int) -> bytes:
    """Tokens `uvarint zeros, uvarint n, n literal bytes` until len(b) is covered; the last token's
    literal may be empty, and a trailing zero run is a token with n = 0."""
    pat = ZERO_RUN.get(minrun)
    if pat is None:
        pat = ZERO_RUN[minrun] = re.compile(b"\x00{%d,}" % minrun)
    out = bytearray()
    p = 0
    zeros = 0
    for m in pat.finditer(b):
        lit = b[p : m.start()]
        if lit or zeros:
            out += uvarint(zeros) + uvarint(len(lit)) + lit
        zeros = m.end() - m.start()
        p = m.end()
    lit = b[p:]
    if lit or zeros:
        out += uvarint(zeros) + uvarint(len(lit)) + lit
    return bytes(out)


def zr_decode(c: bytes, n: int) -> bytes:
    out = bytearray()
    p = 0
    while len(out) < n:
        z, p = read_uvarint(c, p)
        k, p = read_uvarint(c, p)
        out += bytes(z) + c[p : p + k]
        p += k
    if len(out) != n or p != len(c):
        raise ValueError("zr: length")
    return bytes(out)


def bin13_message(sb: bytes, blocks: dict) -> bytes:
    body = struct.pack("<I", 0) + sb
    for name in BLOCKS13:
        d = blocks.get(name, b"")
        body += uvarint(len(d)) + d
    return struct.pack("<I", len(body)) + body


def cmd_bin13(argv):
    ap = argparse.ArgumentParser(prog="wire-budget.py bin13")
    ap.add_argument("--recording", required=True, help="a /13 recording (rs-core-check transcode --to 13)")
    ap.add_argument("--plain", help="the /12 recording it was transcoded from (adds the /12 rows)")
    ap.add_argument("--scene", action="append", required=True)
    ap.add_argument("--warm-skip", type=int, default=30)
    ap.add_argument("--zr-min", type=int, default=4)
    ap.add_argument("--wire", choices=("w13r", "w13a"), default="w13r",
                    help="the recording's /13: w13r (zero runs, today's) or w13a (before W13r)")
    ap.add_argument("--dump", help="directory: write each variant's first --dump-n warm messages per scene "
                                   "(and the one before, the first's base) for bin13-bench.c")
    ap.add_argument("--dump-n", type=int, default=300)
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    if zstd is None:
        print("wire-budget bin13: needs Python 3.14's compression.zstd (mise exec -- python3)", file=sys.stderr)
        return 2
    scenes = []
    for spec in a.scene:
        name, rng = spec.split(":")
        f0, f1 = (int(x) for x in rng.split("-"))
        scenes.append((name, f0, f1))
    t0 = time.time()
    schema = Schema13()
    for ver, rec in read_records(a.recording):
        if ver != 13:
            print(f"wire-budget bin13: {a.recording} is /{ver}, not /13", file=sys.stderr)
            return 2
        if rec.meta.get("type") == "transaction":
            schema.learn({k: v for k, v in rec.meta.items() if k not in ("type", "blocks")}, "tx")
    schema.freeze()
    plain = read_records(a.plain) if a.plain else None
    variants = list(VARIANTS_BIN13) + (["j12"] if plain else [])
    rows = {name: {} for name, _f0, _f1 in scenes}
    warm_n = {name: 0 for name, _f0, _f1 in scenes}
    prev = {}  # variant -> (message, meta part, blocks part)
    pending = []
    failures = []
    verified = 0
    dumps = {}  # (variant, scene) -> [messages]
    dump_open = {}  # scene -> still dumping (consecutive warm patches)

    def code(msg, base):
        if base is None or len(base) < 8:  # zstd refuses a prefix under 8 bytes: code it alone
            return len(zstd.compress(msg, level=3)) + 4
        return len(zstd.compress(msg, level=3, zstd_dict=zstd.ZstdDict(base, is_raw=True).as_prefix)) + 4

    for ver, rec in read_records(a.recording):
        prec = next(plain)[1] if plain else None
        meta = rec.meta
        kind = meta.get("type")
        if kind == "resource":
            pending.append(rec.size)
            continue
        if kind != "transaction":
            continue
        frame = meta["frame"]
        sc = next((s for s in scenes if s[1] + a.warm_skip <= frame <= s[2]), None)
        warm = sc is not None and meta["encoding"] == "patch"
        # the parts of every variant: (message, meta part, blocks part)
        jm = cj(meta)
        if jm != rec.meta_bytes:
            failures.append(f"seq {meta['seq']}: canonical JSON differs from the record's meta")
        plain_blocks = {n: rec.blocks[n][2] for n in rec.blocks}
        if a.wire == "w13r":
            for n in PRED13:
                if n in plain_blocks:
                    ty, cnt, _b = rec.blocks[n]
                    plain_blocks[n] = zr_decode(plain_blocks[n], cnt * (1 if ty == "u8" else 4))
        zr_blocks = dict(plain_blocks)
        for n in PRED13:
            if n in zr_blocks:
                zr_blocks[n] = zr_encode(zr_blocks[n], a.zr_min)
        sb = bytearray()
        schema.enc({k: v for k, v in meta.items() if k not in ("type", "blocks")}, "tx", sb)
        sb = bytes(sb)

        def bl(blocks, meta=meta):
            return b"".join(blocks[d["name"]] for d in meta.get("blocks", []))

        parts = {
            "j13": (record_bytes(meta, rec, plain_blocks), jm, bl(plain_blocks)),
            "j13_zr": (record_bytes(meta, rec, zr_blocks), jm, bl(zr_blocks)),
            "b13": (bin13_message(sb, plain_blocks), sb, bl(plain_blocks)),
            "b13_zr": (bin13_message(sb, zr_blocks), sb, bl(zr_blocks)),
        }
        own = "j13_zr" if a.wire == "w13r" else "j13"
        if len(parts[own][0]) != rec.size or (a.wire == "w13r" and a.zr_min == 4 and
                                              parts[own][0] != record_bytes(meta, rec)):
            failures.append(f"seq {meta['seq']}: rebuilt record {len(parts[own][0])} != {rec.size}")
        if prec is not None:
            if prec.meta.get("seq") != meta["seq"]:
                failures.append(f"seq {meta['seq']}: the /12 file is out of step")
            parts["j12"] = (record_bytes(prec.meta, prec), prec.meta_bytes,
                            b"".join(prec.blocks[d["name"]][2] for d in prec.meta.get("blocks", [])))
        if warm:
            name = sc[0]
            r = rows[name]
            warm_n[name] += 1

            def add(key, v, r=r):
                r.setdefault(key, []).append(v)

            add("records.n", len(pending))
            add("records.raw", sum(n + ws_header(n) for n in pending))
            for n in PRED13:
                if n in plain_blocks:
                    add(f"block.{n}.raw", len(plain_blocks[n]))
                    add(f"block.{n}.zr", len(zr_blocks[n]))
                    pb = prev.get("_blk", {}).get(n)
                    add(f"block.{n}.coded", code(plain_blocks[n], pb) - 4 if plain_blocks[n] else 0)
                    pz = prev.get("_zblk", {}).get(n)
                    add(f"block.{n}.zr_coded", code(zr_blocks[n], pz) - 4 if zr_blocks[n] else 0)
            for v in variants:
                msg, mp, bp = parts[v]
                add(v + ".raw", len(msg))
                add(v + ".meta_raw", len(mp))
                add(v + ".blocks_raw", len(bp))
                if v in prev:
                    pm, pmp, pbp = prev[v]
                    z = code(msg, pm) + 24
                    add(v + ".coded", z + ws_header(z))
                    add(v + ".meta_coded", code(mp, pmp) - 4)
                    add(v + ".blocks_coded", code(bp, pbp) - 4)
            # proof: every variant decodes back
            dec, p = schema.dec(sb, 0, "tx")
            if p != len(sb) or cj({"type": "transaction", **dec, "blocks": meta["blocks"]}) != jm:
                failures.append(f"seq {meta['seq']}: the structure does not decode back")
            for n in PRED13:
                if n in plain_blocks and zr_decode(zr_blocks[n], len(plain_blocks[n])) != plain_blocks[n]:
                    failures.append(f"seq {meta['seq']}: {n} zero runs do not decode back")
            verified += 1
            if a.dump and dump_open.get(name, True):
                if name not in dump_open:
                    dump_open[name] = True
                    for v in variants:  # the first warm patch's base
                        dumps[(v, name)] = [prev[v][0]] if v in prev else []
                    dumps[("pred", name)] = [b""]
                    dumps[("pred_zr", name)] = [b""]
                for v in variants:
                    dumps[(v, name)].append(parts[v][0])
                dumps[("pred", name)].append(b"".join(plain_blocks.get(n, b"") for n in PRED13))
                dumps[("pred_zr", name)].append(b"".join(zr_blocks.get(n, b"") for n in PRED13))
                if len(dumps[("j13", name)]) > a.dump_n:
                    dump_open[name] = False
        elif sc is None:
            for name in dump_open:
                dump_open[name] = False
        for v in variants:
            prev[v] = parts[v]
        prev["_blk"] = plain_blocks
        prev["_zblk"] = zr_blocks
        pending = []
    if a.dump:
        os.makedirs(a.dump, exist_ok=True)
        for (v, name), msgs in dumps.items():
            with open(os.path.join(a.dump, f"{v}-{name}.msgs"), "wb") as fh:
                fh.write(struct.pack("<I", len(msgs)))
                for m in msgs:
                    fh.write(struct.pack("<I", len(m)) + m)
    out = {"schema": SCHEMA + "#bin13", "recording": os.path.basename(a.recording), "warm_skip": a.warm_skip,
           "zr_min": a.zr_min, "variants": variants, "wall_s": round(time.time() - t0, 1), "verified_tx": verified,
           "failures": failures[:50], "failure_count": len(failures), "scenes": {}}
    for name, f0, f1 in scenes:
        r = rows[name]
        out["scenes"][name] = {"frames": [f0, f1], "warm_tx": warm_n[name],
                               "bytes": {k: row(v) for k, v in sorted(r.items())}}
        b = out["scenes"][name]["bytes"]
        line = ", ".join(f"{v} {b.get(v + '.raw', {}).get('mean')}/{b.get(v + '.coded', {}).get('mean')}"
                         for v in variants)
        print(f"wire-budget bin13: {name}: {warm_n[name]} warm tx; {line}", file=sys.stderr)
    print(f"wire-budget bin13: verified {verified} tx, {len(failures)} failures", file=sys.stderr)
    text = json.dumps(out, indent=1)
    if a.out:
        with open(a.out, "w") as fh:
            fh.write(text + "\n")
    else:
        print(text)
    return 1 if failures else 0


def record_bytes(meta, rec, blocks=None) -> bytes:
    """A record's own bytes rebuilt from its parts (framing, meta, blocks), as on the wire; with
    `blocks`, those bytes in place of the record's (each with its own length)."""
    mb = cj(meta)
    body = struct.pack("<I", len(mb)) + mb + struct.pack("<I", len(meta.get("blocks", [])))
    for d in meta.get("blocks", []):
        data = (blocks or {}).get(d["name"], rec.blocks[d["name"]][2])
        body += struct.pack("<I", len(data)) + data
    return struct.pack("<I", len(body)) + body


def main(argv):
    if not argv or argv[0] not in ("analyze", "measure", "proto13", "bin13", "self-test"):
        print(__doc__, file=sys.stderr)
        return 2
    if argv[0] == "self-test":
        return self_test()
    if argv[0] == "measure":
        return cmd_measure(argv[1:])
    if argv[0] == "proto13":
        return cmd_proto13(argv[1:])
    if argv[0] == "bin13":
        return cmd_bin13(argv[1:])
    return cmd_analyze(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
