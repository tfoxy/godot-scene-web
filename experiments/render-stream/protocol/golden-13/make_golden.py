#!/usr/bin/env python3
"""Generate the render-stream/13 golden vectors (stdlib only, deterministic).

render-stream/13 as built at W13a (../render-stream-13.md "As built (W13a)") is render-stream/12
plus exactly: the GRSD magic, the protocol string render-stream/13, a transaction key
`predict_check` (16 lowercase hex digits, right before "blocks", on every transaction), and the
predicted blocks: `mesh_u8`, `mesh_f32` and `mm_f32` carry residuals against the stream's two
previous transactions instead of /12's bytes. Every other byte is /12's: the JSON meta (canonical,
same keys), the framing, the block descriptors and lengths, and every other record.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

This file is the normative reference codec (`to13` / `to12` below). It works on records: a /13
file is a /12 file transcoded record by record, so the generator loads golden-12's generator for
the /12 recordings and transcodes them. The C++ writer, the TypeScript library and rs-core must
match every byte this file writes.

The codec, per transaction T (render-stream-13.md "As built (W13a)" is the prose version):

- History. R is the prediction state after a transaction: per mesh id its dynamic bodies (shape
  and bytes) and its six mesh_f32 floats, per multimesh id its buffer (instances, stride, bytes).
  H1 is R after T-1 and H2 is R after T-2, where T-1, T-2 are the previous transaction records of
  the stream. A full T resets: H1 = H2 = {} before it, so a full predicts nothing, and after it
  H1 = R(T), H2 = {}.
- Units. A mesh entry of T with non-null `u8` whose partition is valid is a body unit, predicted
  from H1 when H1 holds that mesh's bodies with the same shape (surface count and per surface
  primitive, format, vertex_count, index_count), to second order when H2 does too. A mesh entry
  with non-null `f` is an AABB unit (H1 / H2 hold its six floats). A multimesh entry with non-null
  `buffer_f` is a buffer unit (H1 / H2 hold a buffer with the same instances and stride).
- Residual, per 32-bit float word, on ord(u) = u ^ 0x80000000 if u < 2^31 else ~u:
  r = zz(ord(v) - (2 ord(b) - ord(p))) with b = H1's word, p = H2's (second order),
  r = zz(ord(v) - ord(b)) with only b (first order), r = v (raw: the word itself), all mod 2^32,
  zz(d) = (d << 1) ^ (d >> 31) on d as a signed 32-bit integer.
  Byte parts of a body (colours, skin, indices) are XORed with b's same part (b present) or sent
  as they are.
- Layout. mesh_u8: six streams over every carried surface, in entry then surface order: the
  40-byte geometry words, the positions, the colours (bytes), the UVs, the skin (bytes), the
  indices (bytes); each word stream (geometry, positions, UVs) byte-plane transposed. mesh_f32 and
  mm_f32: residuals in place, the whole block byte-plane transposed. Byte-plane transpose of n
  words: byte j of word k goes to j * n + k.
- Pass-through. A block whose /12 offset rule fails (mesh_u8: every non-null `u8` the running
  byte count and every carried surface's six parts summing to its payload_bytes, the total the
  block length; mesh_f32: every non-null `f` the running float count, 6 each; mm_f32: `aabb_f`
  then `buffer_f` the running float count, 6 and instances * stride each) is carried exactly as
  /12 carries it, so /12's validator reports that rule's code.
- predict_check: XXH64 (seed 0) of /12's mesh_f32 || mesh_u8 || mm_f32 bytes, as 16 lowercase
  hex digits.
- After T (either end): R(T) from R(T-1) and T's /12 blocks: a mesh entry that is ok and dynamic
  (at least one surface, every hash null) takes its new bodies when `u8` is non-null and keeps its
  bodies when `u8` is null; any other mesh entry drops them. A non-null `f` sets the AABB, a null
  one drops it. An ok multimesh entry with non-null `buffer_f` sets its buffer, with null keeps it;
  any other status drops it. removed_meshes and removed_multimeshes drop their ids.
- The file: GRSD magic; the session's "protocol" is "render-stream/13"; resource records are
  unchanged; the end record's stats.bytes_total and stats.max_record_bytes are the /13 file's own.

Outputs: full.rs13, patch.rs13 and inline.rs13 (golden-12's three recordings transcoded, with
.hex and .decoded.json; resolved.json is golden-12's states under render-stream-13-resolved/1);
predict.rs12 / predict.rs13 (the prediction lane below, with .hex, .decoded.json and
predict-resolved.json); corrupt-meta.rs13; invalid/ (index.json lists every vector with its code
and the seq it fails at); index.json, whose "predict_trace" lists every predicted unit and its
order per transaction of patch.rs13 and predict.rs13.

The prediction lane (predict.rs12/.rs13, a patch file, seqs 1 and 7 full) over one item drawing
mesh 1, mesh 2 and multimesh 1 (multimesh 2 from seq 8):

- mesh 1: dynamic, one surface. Seqs 1-3 a coloured, textured, indexed quad whose x origin b is
  1.25, 1.5, 1.75 (seq 3 is second order with an all-zero position residual: b moves at constant
  velocity inside one binade), y origin 0.5 - 0.25 s (crossing zero at seq 2); colours change at
  seq 2. Seq 4: a shape change (a textured triangle, no index: raw). Seqs 5, 6 the triangle at
  b = 2.25, 2.5 (first order, then second order). Seq 7 full (b = 3.0), 8 and 9 (b = 3.5, 4.0:
  first, then second order). Seq 10: only its AABB moves (u8 null; AABB second order).
  Its AABB moves at constant velocity inside one binade on every seq: [64 + 2s, -(32 + s), 0,
  16 + s / 4, 16, 0]. b crosses the binade at 2.0 between seqs 3 and 4 and between 7 and 8.
- mesh 2: dynamic, one skinned, textured, indexed triangle (bones and weights: 16 skin bytes a
  vertex). Seq 1 raw; seq 2 vertex 0 becomes (NaN 0x7fc00000, -0.0) and vertex 2 a payload NaN
  0xffc00001; seq 3 the NaNs stay and vertex 1 moves (second order); seq 4 moves; seq 5 is not in
  the patch (unchanged); seq 6 moves again after the pause (H1 = H2: zero-motion prediction);
  seq 7 full; seq 8 mesh 2 leaves the table (removed_meshes [2], the item stops drawing it).
- multimesh 1: colours and custom (stride 16). Seqs 1, 2 two instances (seq 2 first order); seq 3
  three instances (raw); seqs 4, 5 first and second order; seq 6 unchanged (not in the patch);
  seq 7 full; seqs 8-10 move (first, second, second order).
- multimesh 2 (seq 8 on): transforms only (stride 8), one instance: raw, then first, then second
  order.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN12 = HERE.parent / "golden-12"
G12_SPEC = importlib.util.spec_from_file_location("golden12_make_golden",
                                                  GOLDEN12 / "make_golden.py")
g12 = importlib.util.module_from_spec(G12_SPEC)
sys.modules["golden12_make_golden"] = g12
G12_SPEC.loader.exec_module(g12)  # type: ignore[union-attr]
g11 = g12.g11
g10 = g12.g10
g9 = g12.g9
g6 = g12.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x44, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSD\r\n\x1a\n"
PROTOCOL = "render-stream/13"
MAGIC_V12 = g12.MAGIC
PROTOCOL_V12 = g12.PROTOCOL
M32 = 0xFFFFFFFF
M64 = 0xFFFFFFFFFFFFFFFF


class DecodeError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}")
        self.code = code


# --------------------------------------------------------------------------- XXH64

P1 = 0x9E3779B185EBCA87
P2 = 0xC2B2AE3D27D4EB4F
P3 = 0x165667B19E3779F9
P4 = 0x85EBCA77C2B2AE63
P5 = 0x27D4EB2F165667C5


def _rotl(x: int, r: int) -> int:
    return ((x << r) | (x >> (64 - r))) & M64


def _round(acc: int, lane: int) -> int:
    acc = (acc + lane * P2) & M64
    return (_rotl(acc, 31) * P1) & M64


def _merge(acc: int, val: int) -> int:
    acc ^= _round(0, val)
    return (acc * P1 + P4) & M64


def xxh64(data: bytes, seed: int = 0) -> int:
    n, p = len(data), 0
    if n >= 32:
        v = [(seed + P1 + P2) & M64, (seed + P2) & M64, seed & M64, (seed - P1) & M64]
        while p + 32 <= n:
            lanes = struct.unpack_from("<4Q", data, p)
            v = [_round(a, b) for a, b in zip(v, lanes)]
            p += 32
        h = (_rotl(v[0], 1) + _rotl(v[1], 7) + _rotl(v[2], 12) + _rotl(v[3], 18)) & M64
        for a in v:
            h = _merge(h, a)
    else:
        h = (seed + P5) & M64
    h = (h + n) & M64
    while p + 8 <= n:
        (k,) = struct.unpack_from("<Q", data, p)
        h ^= _round(0, k)
        h = (_rotl(h, 27) * P1 + P4) & M64
        p += 8
    if p + 4 <= n:
        (k,) = struct.unpack_from("<I", data, p)
        h ^= (k * P1) & M64
        h = (_rotl(h, 23) * P2 + P3) & M64
        p += 4
    while p < n:
        h ^= (data[p] * P5) & M64
        h = (_rotl(h, 11) * P1) & M64
        p += 1
    h ^= h >> 33
    h = (h * P2) & M64
    h ^= h >> 29
    h = (h * P3) & M64
    h ^= h >> 32
    return h


assert xxh64(b"") == 0xEF46DB3751D8E999
assert xxh64(b"a") == 0xD24EC4F1A98C6E5B


# --------------------------------------------------------------------------- word arithmetic

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


def _words(b: bytes) -> list[int]:
    return list(struct.unpack(f"<{len(b) // 4}I", b))


def _pack(w: list[int]) -> bytes:
    return struct.pack(f"<{len(w)}I", *w)


def predict_words(cur: bytes, base: bytes | None, prev: bytes | None) -> bytes:
    """Residual words of one float unit: raw (no base), first order, or second order."""
    if base is None:
        return cur
    c, b = _words(cur), _words(base)
    if prev is None:
        return _pack([zz32(ordered(x) - ordered(y)) for x, y in zip(c, b)])
    p = _words(prev)
    return _pack([zz32(ordered(x) - 2 * ordered(y) + ordered(z)) for x, y, z in zip(c, b, p)])


def unpredict_words(res: bytes, base: bytes | None, prev: bytes | None) -> bytes:
    if base is None:
        return res
    r, b = _words(res), _words(base)
    if prev is None:
        return _pack([unordered((unzz32(x) + ordered(y)) & M32) for x, y in zip(r, b)])
    p = _words(prev)
    return _pack([unordered((unzz32(x) + 2 * ordered(y) - ordered(z)) & M32)
                  for x, y, z in zip(r, b, p)])


def xor_bytes(a: bytes, b: bytes | None) -> bytes:
    if b is None:
        return a
    return bytes(x ^ y for x, y in zip(a, b))


def transpose4(b: bytes) -> bytes:
    """Byte-plane transpose of a word stream: byte j of word k goes to j * n + k."""
    n = len(b) // 4
    assert len(b) == 4 * n
    return b"".join(b[j::4] for j in range(4))


def untranspose4(b: bytes) -> bytes:
    n = len(b) // 4
    assert len(b) == 4 * n
    out = bytearray(4 * n)
    for j in range(4):
        out[j::4] = b[j * n:(j + 1) * n]
    return bytes(out)


# --------------------------------------------------------------------------- body partition

SHAPE_KEYS = ("primitive", "format", "vertex_count", "index_count")


def body_parts(s: dict) -> tuple[int, int, int, int, int, int, int]:
    """(vertex count, colour bytes per vertex, UV bytes per vertex, geometry, positions, skin,
    indices) byte sizes of a surface body (render-stream-4.md "Mesh payload")."""
    n, fmt, ic = s["vertex_count"], s["format"], s["index_count"]
    col = 4 if fmt & (1 << 3) else 0
    uv = 8 if fmt & (1 << 4) else 0
    skin = 0
    if fmt & (1 << 10) and fmt & (1 << 11):
        skin = n * (32 if fmt & (1 << 27) else 16)
    idx = 0 if ic == 0 else ic * (2 if n <= 65536 else 4)
    return n, col, uv, 40, 8 * n, skin, idx


def body_len(s: dict) -> int:
    n, col, uv, geo, pos, skin, idx = body_parts(s)
    return geo + pos + n * (col + uv) + skin + idx


def split_body(body: bytes, s: dict) -> list[bytes]:
    """One body -> [geometry, positions, colours, UVs, skin, indices] (colour and UV
    de-interleaved)."""
    n, col, uv, geo, pos, skin, idx = body_parts(s)
    p = 0
    g = body[p:p + geo]
    p += geo
    ps = body[p:p + pos]
    p += pos
    stride = col + uv
    attr = body[p:p + stride * n]
    p += stride * n
    cs = b"".join(attr[k * stride:k * stride + col] for k in range(n))
    us = b"".join(attr[k * stride + col:k * stride + stride] for k in range(n))
    sk = body[p:p + skin]
    p += skin
    ix = body[p:p + idx]
    return [g, ps, cs, us, sk, ix]


def join_body(parts: list[bytes], s: dict) -> bytes:
    n, col, uv, _geo, _pos, _skin, _idx = body_parts(s)
    g, ps, cs, us, sk, ix = parts
    attr = bytearray()
    for k in range(n):
        attr += cs[k * col:(k + 1) * col]
        attr += us[k * uv:(k + 1) * uv]
    return g + ps + bytes(attr) + sk + ix


WORD_STREAMS = (0, 1, 3)  # geometry, positions, UVs (colours, skin, indices are bytes)


def shape_of(entry: dict) -> tuple:
    return tuple(tuple(s[k] for k in SHAPE_KEYS) for s in entry["surfaces"])


def mm_stride(entry: dict) -> int:
    return 8 + 4 * int(bool(entry["colors"])) + 4 * int(bool(entry["custom"]))


# --------------------------------------------------------------------------- history

def empty_state() -> dict:
    return {"body": {}, "aabb": {}, "mm": {}}


def copy_state(r: dict) -> dict:
    return {k: dict(v) for k, v in r.items()}


def is_dynamic(entry: dict) -> bool:
    return (entry.get("status") == "ok" and bool(entry.get("surfaces"))
            and all(s.get("hash") is None for s in entry["surfaces"]))


def u8_layout(meta: dict, u8_len: int):
    """[(mesh id, shape, [(surface, offset)])] of the carried bodies, or None when mesh_u8's
    offset rule fails (pass-through)."""
    out, run = [], 0
    try:
        for e in meta.get("meshes", []):
            if e.get("u8") is None:
                continue
            if e["u8"] != run:
                return None
            surfaces = []
            for s in e["surfaces"]:
                n = s["payload_bytes"]
                if body_len(s) != n:
                    return None
                surfaces.append((s, run))
                run += n
            out.append((e["id"], shape_of(e), surfaces))
    except (KeyError, TypeError):
        return None
    return out if run == u8_len else None


def f32_layout(meta: dict, n_floats: int):
    """[(mesh id, float offset)] of the AABB units, or None when mesh_f32's offset rule fails."""
    out, run = [], 0
    try:
        for e in meta.get("meshes", []):
            if e.get("f") is None:
                continue
            if e["f"] != run:
                return None
            out.append((e["id"], run))
            run += 6
    except (KeyError, TypeError):
        return None
    return out if run == n_floats else None


def mm_layout(meta: dict, n_floats: int):
    """[(multimesh id, instances, stride, float offset)] of the buffer units, or None when
    mm_f32's offset rule fails."""
    out, run = [], 0
    try:
        for e in meta.get("multimeshes", []):
            if e.get("aabb_f") is not None:
                if e["aabb_f"] != run:
                    return None
                run += 6
            if e.get("buffer_f") is not None:
                if e["buffer_f"] != run:
                    return None
                stride = mm_stride(e)
                out.append((e["id"], e["instances"], stride, run))
                run += e["instances"] * stride
    except (KeyError, TypeError):
        return None
    return out if run == n_floats else None


def advance(r: dict, meta: dict, blocks12: dict[str, bytes]) -> dict:
    """R(T) from R(T-1) (empty for a full) and T's /12 blocks."""
    r = empty_state() if meta.get("encoding") == "full" else copy_state(r)
    u8 = blocks12.get("mesh_u8", b"")
    layout = u8_layout(meta, len(u8))
    bodies = {}
    if layout is not None:
        for mid, shape, surfaces in layout:
            bodies[mid] = (shape, [u8[o:o + s["payload_bytes"]] for s, o in surfaces])
    mf = blocks12.get("mesh_f32", b"")
    for e in meta.get("meshes", []):
        mid = e["id"]
        if is_dynamic(e):
            if e.get("u8") is not None:
                if mid in bodies:
                    r["body"][mid] = bodies[mid]
                else:
                    r["body"].pop(mid, None)
        else:
            r["body"].pop(mid, None)
        if e.get("f") is not None and 4 * e["f"] + 24 <= len(mf):
            r["aabb"][mid] = mf[4 * e["f"]:4 * e["f"] + 24]
        else:
            r["aabb"].pop(mid, None)
    for mid in meta.get("removed_meshes", []):
        r["body"].pop(mid, None)
        r["aabb"].pop(mid, None)
    mm = blocks12.get("mm_f32", b"")
    for e in meta.get("multimeshes", []):
        mmid = e["id"]
        if e.get("status") != "ok":
            r["mm"].pop(mmid, None)
        elif e.get("buffer_f") is not None:
            stride = mm_stride(e)
            o, n = 4 * e["buffer_f"], 4 * e["instances"] * stride
            if o + n <= len(mm):
                r["mm"][mmid] = (e["instances"], stride, mm[o:o + n])
            else:
                r["mm"].pop(mmid, None)
    for mmid in meta.get("removed_multimeshes", []):
        r["mm"].pop(mmid, None)
    return r


class History:
    """One end's prediction history: H1 = R(T-1), H2 = R(T-2), reset by a full."""

    def __init__(self) -> None:
        self.h1 = empty_state()
        self.h2 = empty_state()

    def refs(self, meta: dict, *, stale: bool = False, no_reset: bool = False):
        """(H1, H2) to predict T from. stale (encoder sabotage predict-stale): predict from H2
        as if it were H1, first order. no_reset (decoder sabotage no-predict-reset): a full
        predicts like a patch."""
        if meta.get("encoding") == "full" and not no_reset:
            return empty_state(), empty_state()
        if stale:
            return self.h2, empty_state()
        return self.h1, self.h2

    def accept(self, meta: dict, blocks12: dict[str, bytes], *, no_reset: bool = False) -> None:
        full = meta.get("encoding") == "full" and not no_reset
        new = advance(empty_state() if full else self.h1, dict(meta, encoding="full") if full
                      else dict(meta, encoding="patch"), blocks12)
        self.h2 = empty_state() if full else self.h1
        self.h1 = new


def _body_refs(h1: dict, h2: dict, mid: int, shape: tuple):
    b = h1["body"].get(mid)
    if b is None or b[0] != shape:
        return None, None
    p = h2["body"].get(mid)
    if p is None or p[0] != shape:
        return b[1], None
    return b[1], p[1]


def _aabb_refs(h1: dict, h2: dict, mid: int):
    b = h1["aabb"].get(mid)
    if b is None:
        return None, None
    return b, h2["aabb"].get(mid)


def _mm_refs(h1: dict, h2: dict, mmid: int, instances: int, stride: int):
    b = h1["mm"].get(mmid)
    if b is None or b[:2] != (instances, stride):
        return None, None
    p = h2["mm"].get(mmid)
    if p is None or p[:2] != (instances, stride):
        return b[2], None
    return b[2], p[2]


def _order(base, prev) -> int:
    return 0 if base is None else 1 if prev is None else 2


def code_blocks(meta: dict, blocks: dict[str, bytes], h1: dict, h2: dict, *, inverse: bool,
                trace: list | None = None) -> dict[str, bytes]:
    """Predict (/12 -> /13) or un-predict (/13 -> /12) the three blocks of one transaction."""
    out = dict(blocks)
    # mesh_u8
    u8 = blocks.get("mesh_u8")
    layout = u8_layout(meta, len(u8)) if u8 is not None else None
    if layout is not None:
        surfaces = [(mid, shape, k, s, o) for mid, shape, ss in layout
                    for k, (s, o) in enumerate(ss)]
        sizes = [[len(p) for p in split_body(bytes(s["payload_bytes"]), s)]
                 for _m, _sh, _k, s, _o in surfaces]
        if not inverse:
            streams = [bytearray() for _ in range(6)]
            for (mid, shape, k, s, o), _sz in zip(surfaces, sizes):
                base, prev = _body_refs(h1, h2, mid, shape)
                cur = split_body(u8[o:o + s["payload_bytes"]], s)
                bp = split_body(base[k], s) if base is not None else None
                pp = split_body(prev[k], s) if prev is not None else None
                for i in range(6):
                    b = bp[i] if bp else None
                    if i in WORD_STREAMS:
                        streams[i] += predict_words(cur[i], b, pp[i] if pp else None)
                    else:
                        streams[i] += xor_bytes(cur[i], b)
                if trace is not None and k == 0:
                    trace.append({"block": "mesh_u8", "id": mid, "order": _order(base, prev)})
            out["mesh_u8"] = b"".join(transpose4(bytes(st)) if i in WORD_STREAMS else bytes(st)
                                      for i, st in enumerate(streams))
        else:
            totals = [sum(sz[i] for sz in sizes) for i in range(6)]
            streams, p = [], 0
            for i in range(6):
                chunk = u8[p:p + totals[i]]
                p += totals[i]
                streams.append(untranspose4(chunk) if i in WORD_STREAMS else chunk)
            at = [0] * 6
            body = bytearray()
            for (mid, shape, k, s, _o), sz in zip(surfaces, sizes):
                base, prev = _body_refs(h1, h2, mid, shape)
                bp = split_body(base[k], s) if base is not None else None
                pp = split_body(prev[k], s) if prev is not None else None
                parts = []
                for i in range(6):
                    d = streams[i][at[i]:at[i] + sz[i]]
                    at[i] += sz[i]
                    b = bp[i] if bp else None
                    if i in WORD_STREAMS:
                        parts.append(unpredict_words(d, b, pp[i] if pp else None))
                    else:
                        parts.append(xor_bytes(d, b))
                body += join_body(parts, s)
                if trace is not None and k == 0:
                    trace.append({"block": "mesh_u8", "id": mid, "order": _order(base, prev)})
            out["mesh_u8"] = bytes(body)
    # mesh_f32
    mf = blocks.get("mesh_f32")
    fl = f32_layout(meta, len(mf) // 4) if mf is not None else None
    if fl is not None:
        buf = bytearray(untranspose4(mf) if inverse else mf)
        for mid, off in fl:
            base, prev = _aabb_refs(h1, h2, mid)
            seg = bytes(buf[4 * off:4 * off + 24])
            buf[4 * off:4 * off + 24] = (unpredict_words(seg, base, prev) if inverse
                                        else predict_words(seg, base, prev))
            if trace is not None:
                trace.append({"block": "mesh_f32", "id": mid, "order": _order(base, prev)})
        out["mesh_f32"] = bytes(buf) if inverse else transpose4(bytes(buf))
    # mm_f32
    mm = blocks.get("mm_f32")
    ml = mm_layout(meta, len(mm) // 4) if mm is not None else None
    if ml is not None:
        buf = bytearray(untranspose4(mm) if inverse else mm)
        for mmid, instances, stride, off in ml:
            base, prev = _mm_refs(h1, h2, mmid, instances, stride)
            n = 4 * instances * stride
            seg = bytes(buf[4 * off:4 * off + n])
            buf[4 * off:4 * off + n] = (unpredict_words(seg, base, prev) if inverse
                                       else predict_words(seg, base, prev))
            if trace is not None:
                trace.append({"block": "mm_f32", "id": mmid, "order": _order(base, prev)})
        out["mm_f32"] = bytes(buf) if inverse else transpose4(bytes(buf))
    return out


def check_hex(blocks12: dict[str, bytes]) -> str:
    data = blocks12.get("mesh_f32", b"") + blocks12.get("mesh_u8", b"") + blocks12.get("mm_f32", b"")
    return f"{xxh64(data):016x}"


# --------------------------------------------------------------------------- records

def split_records(data: bytes, magic: bytes) -> list[bytes]:
    if data[:8] != magic:
        raise DecodeError("bad-magic", data[:8].hex())
    out, p = [], 8
    while p < len(data):
        if p + 4 > len(data):
            raise DecodeError("truncated", f"at {p}")
        (n,) = struct.unpack_from("<I", data, p)
        if p + 4 + n > len(data):
            raise DecodeError("truncated", f"at {p}")
        out.append(data[p:p + 4 + n])
        p += 4 + n
    return out


def parse_record(rec: bytes):
    """(meta bytes, [(block bytes)]) of one record (framing as render-stream-0.md)."""
    (meta_len,) = struct.unpack_from("<I", rec, 4)
    meta_b = rec[8:8 + meta_len]
    p = 8 + meta_len
    (count,) = struct.unpack_from("<I", rec, p)
    p += 4
    blocks = []
    for _ in range(count):
        (n,) = struct.unpack_from("<I", rec, p)
        p += 4
        blocks.append(rec[p:p + n])
        p += n
    assert p == len(rec), "record-length"
    return meta_b, blocks


def make_record(meta_b: bytes, blocks: list[bytes]) -> bytes:
    body = struct.pack("<I", len(meta_b)) + meta_b + struct.pack("<I", len(blocks))
    for b in blocks:
        body += struct.pack("<I", len(b)) + b
    return struct.pack("<I", len(body)) + body


BLOCKS_MARK = b',"blocks":['


def with_check(meta_b: bytes, hex16: str) -> bytes:
    i = meta_b.rindex(BLOCKS_MARK)
    return meta_b[:i] + b',"predict_check":"' + hex16.encode("ascii") + b'"' + meta_b[i:]


def without_check(meta_b: bytes) -> tuple[bytes, str | None]:
    i = meta_b.rindex(BLOCKS_MARK)
    key = b',"predict_check":"'
    j = i - len(key) - 17
    if j < 0 or meta_b[j:j + len(key)] != key or meta_b[i - 1:i] != b'"':
        return meta_b, None
    return meta_b[:j] + meta_b[i:], meta_b[j + len(key):i - 1].decode("ascii")


def _swap_protocol(meta_b: bytes, old: str, new: str) -> bytes:
    a = f'"protocol":"{old}"'.encode("ascii")
    assert a in meta_b, "session protocol"
    return meta_b.replace(a, f'"protocol":"{new}"'.encode("ascii"), 1)


def _fix_end(meta_b: bytes, before: list[bytes], before_in: list[bytes]) -> bytes:
    """The end record over transcoded records: stats.bytes_total moves by the size change (so an
    input that was consistent stays consistent, and one that was not stays off by as much), and
    stats.max_record_bytes is the output's own maximum when the input's was its own maximum."""
    meta = json.loads(meta_b)
    stats = meta.get("stats")
    if isinstance(stats, dict) and isinstance(stats.get("bytes_total"), int):
        stats["bytes_total"] += sum(len(r) for r in before) - sum(len(r) for r in before_in)
        mx = stats.get("max_record_bytes")
        if isinstance(mx, int) and before and before_in and mx == max(len(r) for r in before_in):
            stats["max_record_bytes"] = max(len(r) for r in before)
    return g6.canonical_json(meta)


def _named_blocks(meta: dict, blocks: list[bytes]) -> dict[str, bytes]:
    return {d["name"]: b for d, b in zip(meta.get("blocks", []), blocks)}


def _rebuild_blocks(meta: dict, blocks: list[bytes], named: dict[str, bytes]) -> list[bytes]:
    return [named.get(d["name"], b) for d, b in zip(meta.get("blocks", []), blocks)]


def to13(data12: bytes, *, stale: bool = False, trace: list | None = None) -> bytes:
    """Transcode a /12 file to /13 (the reference encoder). stale: the predict-stale sabotage."""
    hist = History()
    out: list[bytes] = []
    seen: list[bytes] = []
    for rec in split_records(data12, MAGIC_V12):
        meta_b, blocks = parse_record(rec)
        meta = json.loads(meta_b)
        kind = meta.get("type")
        if kind == "session":
            out.append(make_record(_swap_protocol(meta_b, PROTOCOL_V12, PROTOCOL), blocks))
        elif kind == "transaction":
            named = _named_blocks(meta, blocks)
            h1, h2 = hist.refs(meta, stale=stale)
            tt: list | None = [] if trace is not None else None
            coded = code_blocks(meta, named, h1, h2, inverse=False, trace=tt)
            if trace is not None:
                trace.append({"seq": meta.get("seq"), "units": tt})
            out.append(make_record(with_check(meta_b, check_hex(named)),
                                   _rebuild_blocks(meta, blocks, coded)))
            hist.accept(meta, named)
        elif kind == "end":
            out.append(make_record(_fix_end(meta_b, out, seen), blocks))
        else:
            out.append(rec)
        seen.append(rec)
    return MAGIC + b"".join(out)


def to12(data13: bytes, *, no_reset: bool = False) -> bytes:
    """Transcode a /13 file to /12 (the reference decoder). Raises DecodeError("predict-check")
    on a reconstruction mismatch. no_reset: the no-predict-reset sabotage."""
    hist = History()
    out: list[bytes] = []
    seen: list[bytes] = []
    for rec in split_records(data13, MAGIC):
        meta_b, blocks = parse_record(rec)
        meta = json.loads(meta_b)
        kind = meta.get("type")
        if kind == "session":
            out.append(make_record(_swap_protocol(meta_b, PROTOCOL, PROTOCOL_V12), blocks))
        elif kind == "transaction":
            plain, check = without_check(meta_b)
            if check is None or any(c not in "0123456789abcdef" for c in check):
                raise DecodeError("meta-schema", f"seq {meta.get('seq')}: predict_check")
            named = _named_blocks(meta, blocks)
            h1, h2 = hist.refs(meta, no_reset=no_reset)
            decoded = code_blocks(meta, named, h1, h2, inverse=True)
            if check_hex(decoded) != check:
                raise DecodeError("predict-check", f"seq {meta.get('seq')}")
            out.append(make_record(plain, _rebuild_blocks(meta, blocks, decoded)))
            hist.accept(meta, decoded, no_reset=no_reset)
        elif kind == "end":
            out.append(make_record(_fix_end(meta_b, out, seen), blocks))
        else:
            out.append(rec)
        seen.append(rec)
    return MAGIC_V12 + b"".join(out)


# --------------------------------------------------------------------------- decoded form

def decode(data13: bytes) -> dict:
    """render-stream-13-decoded/1: golden-12's decoded form of the /13 file, its blocks the /12
    values (un-predicted), its metas verbatim (predict_check included)."""
    recs13 = split_records(data13, MAGIC)
    recs12 = split_records(to12(data13), MAGIC_V12)
    # The un-predicted blocks, in the /13 file's own framing (equal block lengths).
    rebuilt = []
    for r13, r12 in zip(recs13, recs12):
        meta_b, blocks13 = parse_record(r13)
        _m12, blocks12 = parse_record(r12)
        if json.loads(meta_b).get("type") == "transaction":
            rebuilt.append(make_record(meta_b, blocks12))
        else:
            rebuilt.append(r13)
    saved = g6.MAGIC
    g6.MAGIC = MAGIC
    try:
        out = g6.decode(MAGIC + b"".join(rebuilt))
    finally:
        g6.MAGIC = saved
    for rec, r13 in zip(out["records"], recs13):
        rec["sha256"] = hashlib.sha256(r13).hexdigest()
    out["schema"] = "render-stream-13-decoded/1"
    return out


def resolved(states: list[dict]) -> dict:
    return {
        "schema": "render-stream-13-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": g12.resolved_state(s)}
                         for i, s in enumerate(states)],
    }


# --------------------------------------------------------------------------- prediction lane

PREDICT_SESSION = "dddddddddddddddddddddddddddddddd"
PREDICT_STREAM = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
PREDICT_FULLS = (1, 7)
NAN_QUIET = 0x7FC00000
NAN_PAYLOAD = 0xFFC00001
NEG_ZERO = 0x80000000

QUAD_FORMAT = (g6.ARRAY_FORMAT_COLOR | g6.ARRAY_FORMAT_TEX_UV | g6.ARRAY_FORMAT_INDEX
               | g6.ARRAY_FLAG_USE_2D_VERTICES)
TRI_FORMAT = g6.ARRAY_FORMAT_TEX_UV | g6.ARRAY_FLAG_USE_2D_VERTICES
SKIN_FORMAT = (g6.ARRAY_FORMAT_TEX_UV | g6.ARRAY_FORMAT_BONES | g6.ARRAY_FORMAT_WEIGHTS
               | g6.ARRAY_FORMAT_INDEX | g6.ARRAY_FLAG_USE_2D_VERTICES)


def _f32_word(v: float) -> int:
    return struct.unpack("<I", struct.pack("<f", v))[0]


def _pos_words(words: list[int]) -> bytes:
    return struct.pack(f"<{len(words)}I", *words)


def _mesh1_quad(b: float, y: float, colour: tuple[int, int, int, int]) -> dict:
    verts = [(b, y), (b + 16.0, y), (b + 16.0, y + 16.0), (b, y + 16.0)]
    uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    attr = bytearray()
    for (u, v) in uvs:
        attr += bytes(colour) + struct.pack("<2f", u, v)
    payload = g6.build_mesh_payload("triangles", QUAD_FORMAT, 4, 6, g6.positions_f32(verts),
                                    bytes(attr), b"", g6.indices_u16([0, 1, 2, 0, 2, 3]),
                                    [b, y, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0])
    return g11.dynamic_surface(payload, "triangles", QUAD_FORMAT, 4, 6)


def _mesh1_tri(b: float) -> dict:
    payload = g6.build_mesh_payload(
        "triangles", TRI_FORMAT, 3, 0,
        g6.positions_f32([(b, 0.0), (b + 16.0, 0.0), (b, 16.0)]),
        g6.uvs_f32([(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]), b"", b"",
        [b, 0.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0])
    return g11.dynamic_surface(payload, "triangles", TRI_FORMAT, 3, 0)


def _mesh2_skin(positions: list[int], bones: int) -> dict:
    skin = bytearray()
    for k in range(3):  # 4 bone indices (u16), 4 weights (u16 normalized)
        skin += struct.pack("<4H", bones + k, 0, 0, 0) + struct.pack("<4H", 65535, 0, 0, 0)
    payload = g6.build_mesh_payload(
        "triangles", SKIN_FORMAT, 3, 3, _pos_words(positions),
        g6.uvs_f32([(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]), bytes(skin), g6.indices_u16([0, 1, 2]),
        [0.0, 0.0, 0.0, 32.0, 32.0, 0.0], [1.0, 1.0, 0.0, 0.0])
    return g11.dynamic_surface(payload, "triangles", SKIN_FORMAT, 3, 3)


def _m2_positions(s: int) -> list[int]:
    """Mesh 2's vertex words at seq s (x0, y0, x1, y1, x2, y2)."""
    w = _f32_word
    if s == 1:
        return [w(0.0), w(0.0), w(32.0), w(0.0), w(0.0), w(32.0)]
    # from seq 2: vertex 0 is (NaN, -0.0), vertex 2's x a payload NaN; vertex 1 moves by 2 a seq
    x1 = {2: 34.0, 3: 36.0, 4: 38.0, 5: 38.0, 6: 40.0, 7: 42.0}[s]
    return [NAN_QUIET, NEG_ZERO, w(x1), w(0.0), NAN_PAYLOAD, w(32.0)]


def _mesh_aabb(s: int) -> list[float]:
    return [64.0 + 2.0 * s, -(32.0 + s), 0.0, 16.0 + s / 4.0, 16.0, 0.0]


def _mm1(s: int, n: int, version: int) -> dict:
    return g11.multimesh(version=version, instances=n, colors=True, custom=True,
                         buffer=g11.mm1_buffer(s, n))


def _mm2(s: int, version: int) -> dict:
    return g11.multimesh(version=version, instances=1, colors=False, custom=False,
                         buffer=g11.mm2_buffer(s, 1))


M1_B = {1: 1.25, 2: 1.5, 3: 1.75, 4: 2.0, 5: 2.25, 6: 2.5, 7: 3.0, 8: 3.5, 9: 4.0, 10: 4.0}
M1_COLOUR = {1: (255, 102, 0, 255), 2: (255, 103, 0, 255), 3: (255, 103, 0, 255)}
MM1_N = {1: 2, 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3}
MM1_S = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 5, 7: 7, 8: 8, 9: 9, 10: 10}


def predict_states() -> list[dict]:
    states = []
    for s in range(1, 11):
        m1_surface = (_mesh1_quad(M1_B[s], 0.5 - 0.25 * s, M1_COLOUR[s]) if s <= 3
                      else _mesh1_tri(M1_B[s]))
        meshes = {1: dict(g11.mini_mesh([m1_surface], version=s),
                          custom_aabb=_mesh_aabb(s))}
        if s <= 7:
            m2_seq = 4 if s == 5 else s  # unchanged at 5
            meshes[2] = dict(g11.mini_mesh([_mesh2_skin(_m2_positions(m2_seq), 3)],
                                           version=1 if s == 1 else 2 if s == 2 else m2_seq),
                             custom_aabb=[0.0, 0.0, 0.0, 32.0, 32.0, 0.0])
        state = g11.mini_state(meshes)
        commands = [g6.add_mesh(mid, g6.IDENTITY) for mid in sorted(meshes)]
        commands.append(g11.add_multimesh(1))
        multimeshes = {1: _mm1(MM1_S[s], MM1_N[s], version=MM1_S[s])}
        if s >= 8:
            commands.append(g11.add_multimesh(2))
            multimeshes[2] = _mm2(s, version=s)
        state["items"][1] = dict(state["items"][1], commands=commands,
                                 content_version=1 if s < 8 else 2)
        state["multimeshes"] = multimeshes
        state["particles"] = {}
        state["particle_emits"] = []
        states.append(state)
    return states


PREDICT_STATES = predict_states()


def predict_recording12() -> bytes:
    states = PREDICT_STATES
    session = g9.session_record(PREDICT_STREAM, "file", "patch", PREDICT_SESSION,
                                delivery="out-of-band", adoption=None, decode="off")
    records = [session]
    for i, state in enumerate(states):
        seq = i + 1
        if seq in PREDICT_FULLS:
            records.append(g6.full_transaction_bytes(seq, seq, state))
        else:
            records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, states[i - 1], state))
    end = g6.end_record(len(states), records, diff_ns_total=0,
                        full_transactions=len(PREDICT_FULLS),
                        patch_transactions=len(states) - len(PREDICT_FULLS),
                        resource_records=0, resource_bytes=0)
    return g6.recording(records, end)


# --------------------------------------------------------------------------- invalid vectors

def _records13(data: bytes) -> list[bytes]:
    return split_records(data, MAGIC)


def _tx_index(recs: list[bytes], seq: int) -> int:
    for i, r in enumerate(recs):
        meta = json.loads(parse_record(r)[0])
        if meta.get("type") == "transaction" and meta.get("seq") == seq:
            return i
    raise KeyError(seq)


def _edit_tx(data13: bytes, seq: int, fn) -> bytes:
    """Apply fn(meta bytes, named blocks) -> (meta bytes, named blocks) to one transaction of a
    /13 file; the end record's stats follow."""
    recs = _records13(data13)
    i = _tx_index(recs, seq)
    meta_b, blocks = parse_record(recs[i])
    meta = json.loads(meta_b)
    named = _named_blocks(meta, blocks)
    meta_b2, named2 = fn(meta_b, dict(named))
    recs[i] = make_record(meta_b2, _rebuild_blocks(meta, blocks, named2))
    end_meta_b, end_blocks = parse_record(recs[-1])
    if json.loads(end_meta_b).get("type") == "end":
        old = _records13(data13)[:-1]
        recs[-1] = make_record(_fix_end(end_meta_b, recs[:-1], old), end_blocks)
    return MAGIC + b"".join(recs)


def _flip(block: str, byte: int, bit: int = 0):
    def fn(meta_b: bytes, named: dict[str, bytes]):
        b = bytearray(named[block])
        b[byte] ^= 1 << bit
        named[block] = bytes(b)
        return meta_b, named
    return fn


def _drop_check(meta_b: bytes, named):
    plain, check = without_check(meta_b)
    assert check is not None
    return plain, named


def _upper_check(meta_b: bytes, named):
    plain, check = without_check(meta_b)
    assert check is not None and check != check.upper()
    return with_check(plain, check.upper()), named


def _short_check(meta_b: bytes, named):
    plain, check = without_check(meta_b)
    i = plain.rindex(BLOCKS_MARK)
    return plain[:i] + b',"predict_check":"' + check[1:].encode("ascii") + b'"' + plain[i:], named


def _edit_meta12(data12: bytes, seq: int, fn) -> bytes:
    recs = split_records(data12, MAGIC_V12)
    i = _tx_index(recs, seq)
    meta_b, blocks = parse_record(recs[i])
    meta = json.loads(meta_b)
    fn(meta)
    recs[i] = make_record(g6.canonical_json(meta), blocks)
    return MAGIC_V12 + b"".join(recs)


def _meta_mesh(mesh_id: int, key: str, delta: int):
    def fn(meta: dict) -> None:
        for e in meta["meshes"]:
            if e["id"] == mesh_id:
                if key == "vertex_count":
                    e["surfaces"][0]["vertex_count"] += delta
                else:
                    e[key] += delta
    return fn


def _meta_mm(mm_id: int, key: str, delta: int):
    def fn(meta: dict) -> None:
        for e in meta["multimeshes"]:
            if e["id"] == mm_id:
                e[key] += delta
    return fn


def _first_fail(data13: bytes, **kw) -> tuple[str, int | None]:
    """(code, seq) the reference decoder fails with."""
    try:
        to12(data13, **kw)
    except DecodeError as e:
        seq = None
        for tok in str(e).split():
            if tok.rstrip(":").isdigit():
                seq = int(tok.rstrip(":"))
        return e.code, seq
    return "pass", None


def build_invalid_vectors(predict13: bytes, patch13: bytes) -> dict[str, tuple[bytes, str, str, int, int | None]]:
    """name -> (bytes, code, description, version, seq). Every vector fails one rule."""
    out: dict[str, tuple[bytes, str, str, int, int | None]] = {}
    full12 = (GOLDEN12 / "full.rs12").read_bytes()
    out["bad-magic"] = (full12, "bad-magic",
                        "golden-12's full.rs12: magic byte 3 is 'C' (GRSC), not 'D'", 13, None)
    # predict.rs13 seq 3: mesh 1 second order, mesh 2 second order, multimesh 1 raw.
    tr: list = []
    to13(predict_recording12(), trace=tr)
    u8_seq = 3
    out["predict-check-u8"] = (
        _edit_tx(predict13, u8_seq, _flip("mesh_u8", 0, 0)), "predict-check",
        "predict.rs13 seq 3: bit 0 of mesh_u8's first residual byte (mesh 1's geometry, "
        "second order) flipped", 13, u8_seq)
    out["predict-check-aabb"] = (
        _edit_tx(predict13, 2, _flip("mesh_f32", 5, 3)), "predict-check",
        "predict.rs13 seq 2: bit 3 of mesh_f32 byte 5 (a first-order AABB residual, transposed) "
        "flipped", 13, 2)
    out["predict-check-mm"] = (
        _edit_tx(predict13, 5, _flip("mm_f32", 0, 1)), "predict-check",
        "predict.rs13 seq 5: bit 1 of mm_f32 byte 0 (multimesh 1, second order) flipped", 13, 5)
    out["predict-check-raw"] = (
        _edit_tx(predict13, 1, _flip("mesh_u8", 50, 7)), "predict-check",
        "predict.rs13 seq 1 (full, raw units): bit 7 of mesh_u8 byte 50 flipped", 13, 1)
    out["predict-stale"] = (
        to13(predict_recording12(), stale=True), "predict-check",
        "the predict-stale encoder sabotage over predict.rs12: every patch predicts from T-2 as "
        "if it were T-1 (first order); seq 2 is the first it touches", 13, 2)
    out["predict-check-missing"] = (
        _edit_tx(patch13, 2, _drop_check), "meta-schema",
        "patch.rs13 seq 2 carries no predict_check (a /12 transaction meta at /13)", 13, 2)
    out["predict-check-upper"] = (
        _edit_tx(patch13, 2, _upper_check), "meta-schema",
        "patch.rs13 seq 2's predict_check in uppercase hex", 13, 2)
    out["predict-check-short"] = (
        _edit_tx(patch13, 2, _short_check), "meta-schema",
        "patch.rs13 seq 2's predict_check has 15 hex digits", 13, 2)
    # Pass-through: predict.rs12 seq 3 with one offset rule broken, transcoded. The broken block
    # travels as /12 carries it, and /12's rule reports its code.
    predict12 = predict_recording12()
    for name, code, block, fn, desc in (
            ("pass-mesh-u8-offset", "mesh-u8-offset", "mesh_u8", _meta_mesh(2, "u8", 4),
             "mesh 2's u8 is 136, the running count 132"),
            ("pass-payload-size", "payload-size", "mesh_u8", _meta_mesh(1, "vertex_count", 1),
             "mesh 1's surface claims 5 vertices: its shape needs 152 bytes, payload_bytes 132"),
            ("pass-mesh-offset", "mesh-offset", "mesh_f32", _meta_mesh(2, "f", 1),
             "mesh 2's f is 7, the running count 6"),
            ("pass-mm-offset", "mm-offset", "mm_f32", _meta_mm(1, "buffer_f", 1),
             "multimesh 1's buffer_f is 7, the running count 6")):
        bad12 = _edit_meta12(predict12, 3, fn)
        bad13 = to13(bad12)
        recs12, recs13 = split_records(bad12, MAGIC_V12), _records13(bad13)
        i = _tx_index(recs13, 3)
        m12, b12 = parse_record(recs12[i])
        m13, b13 = parse_record(recs13[i])
        names = [d["name"] for d in json.loads(m12)["blocks"]]
        assert b13[names.index(block)] == b12[names.index(block)], name  # passed through
        assert to12(bad13) == bad12, name
        out[name] = (bad13, code, f"predict.rs13 seq 3, {desc}: {block} passes through as /12 "
                                  f"carries it", 13, 3)
    # golden-12's invalid vectors transcoded: each keeps its /12 code.
    index12 = json.loads((GOLDEN12 / "index.json").read_text())
    for entry in index12["invalid"]:
        if entry["version"] != 12 or entry["code"] == "bad-magic":
            continue
        name = Path(entry["file"]).stem
        data = (GOLDEN12 / entry["file"]).read_bytes()
        try:
            data13 = to13(data)
        except (AssertionError, KeyError, ValueError, json.JSONDecodeError) as exc:
            raise SystemExit(f"cannot transcode golden-12 {entry['file']}: {exc}")
        assert to12(data13) == data, f"g12-{name} round trip"
        out[f"g12-{name}"] = (data13, entry["code"],
                              f"golden-12's invalid/{name}.rs12 transcoded: {entry['description']}",
                              13, None)
    return out


# --------------------------------------------------------------------------- build

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build() -> dict[str, bytes]:
    full12 = (GOLDEN12 / "full.rs12").read_bytes()
    patch12 = (GOLDEN12 / "patch.rs12").read_bytes()
    inline12 = (GOLDEN12 / "inline.rs12").read_bytes()
    predict12 = predict_recording12()

    traces: dict[str, list] = {"patch.rs13": [], "predict.rs13": []}
    full13 = to13(full12)
    patch13 = to13(patch12, trace=traces["patch.rs13"])
    inline13 = to13(inline12)
    predict13 = to13(predict12, trace=traces["predict.rs13"])
    for d12, d13 in ((full12, full13), (patch12, patch13), (inline12, inline13),
                     (predict12, predict13)):
        assert to12(d13) == d12, "round trip"

    # corrupt-meta: patch.rs13 seq 3's first meta byte set to 0x00, framing intact.
    recs = _records13(patch13)
    seq3 = _tx_index(recs, 3)
    offset = 8 + sum(len(r) for r in recs[:seq3])
    corrupt = bytearray(patch13)
    assert corrupt[offset + 8] == ord("{")
    corrupt[offset + 8] = 0x00

    invalid = build_invalid_vectors(predict13, patch13)
    for name, (data, code, _desc, _v, seq) in invalid.items():
        if name == "bad-magic" or name.startswith(("g12-", "pass-")):
            continue
        got, at = _first_fail(data)
        assert got == code and at == seq, (name, got, at)
    got, at = _first_fail(predict13, no_reset=True)
    assert got == "predict-check" and at == 7, (got, at)
    got, at = _first_fail(patch13, no_reset=True)
    assert got == "predict-check", (got, at)
    no_reset_patch_seq = at

    g12_resolved = json.loads((GOLDEN12 / "resolved.json").read_text())
    main_resolved = dict(g12_resolved, schema="render-stream-13-resolved/1")
    index = {
        "schema": "render-stream-13-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": f"{lane}.rs13", "hex": f"{lane}.hex", "decoded": f"{lane}.decoded.json",
             "sha256": _sha256(d), "rs12": f"../golden-12/{lane}.rs12"}
            for lane, d in (("full", full13), ("patch", patch13), ("inline", inline13))
        ],
        "resolved": "resolved.json",
        "predict": {"file": "predict.rs13", "hex": "predict.hex",
                    "decoded": "predict.decoded.json", "resolved": "predict-resolved.json",
                    "sha256": _sha256(predict13), "rs12": "predict.rs12",
                    "rs12_sha256": _sha256(predict12), "fulls": list(PREDICT_FULLS)},
        "predict_trace": traces,
        "sabotage": {
            "predict-stale": {"vector": "invalid/predict-stale.rs13", "code": "predict-check",
                              "seq": 2},
            "no-predict-reset": {"code": "predict-check",
                                 "fails": [{"file": "predict.rs13", "seq": 7},
                                           {"file": "patch.rs13", "seq": no_reset_patch_seq}]},
        },
        "corrupt": [
            {"file": "corrupt-meta.rs13", "code": "meta-json", "record_index": seq3, "seq": 3,
             "description": "patch.rs13 transaction seq 3: first meta byte set to 0x00; framing "
                            "intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs{version}", "code": code, "version": version,
             "seq": seq, "description": description}
            for name, (_, code, description, version, seq) in invalid.items()
        ],
    }
    outputs: dict[str, bytes] = {}
    for lane, d in (("full", full13), ("patch", patch13), ("inline", inline13),
                    ("predict", predict13)):
        outputs[f"{lane}.rs13"] = d
        outputs[f"{lane}.hex"] = g6.to_hex(d).encode("ascii")
        outputs[f"{lane}.decoded.json"] = g6.pretty(decode(d))
    outputs["predict.rs12"] = predict12
    outputs["resolved.json"] = g6.pretty(main_resolved)
    outputs["predict-resolved.json"] = g6.pretty(resolved(PREDICT_STATES))
    outputs["corrupt-meta.rs13"] = bytes(corrupt)
    outputs["index.json"] = g6.pretty(index)
    for name, (data, _, _, version, _seq) in invalid.items():
        outputs[f"invalid/{name}.rs{version}"] = data
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="verify committed outputs; write nothing")
    args = parser.parse_args()
    outputs = build()
    if args.check:
        bad = [rel for rel, data in outputs.items()
               if not (HERE / rel).is_file() or (HERE / rel).read_bytes() != data]
        expected = set(outputs)
        extra = [str(p.relative_to(HERE)) for p in HERE.rglob("*")
                 if p.is_file() and p.name != "make_golden.py" and "__pycache__" not in p.parts
                 and str(p.relative_to(HERE)) not in expected]
        if bad or extra:
            for rel in bad:
                print(f"MISMATCH {rel}", file=sys.stderr)
            for rel in extra:
                print(f"UNEXPECTED {rel}", file=sys.stderr)
            return 1
        print(f"golden-13: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"golden-13: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
