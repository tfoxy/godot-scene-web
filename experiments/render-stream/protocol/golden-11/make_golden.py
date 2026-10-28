#!/usr/bin/env python3
"""Generate the render-stream/11 golden vectors (stdlib only, deterministic).

render-stream/11 (../render-stream-11.md) is render-stream/10 plus exactly: the GRSB magic, the
protocol string render-stream/11, the session key `resources.mesh_dynamic` (last), the carried-set
rules (prune after every transaction, `resource-unnamed`), dynamic mesh surfaces (a mesh entry key
`u8` right after `f`, a surface `hash` that is null on a dynamic mesh, the eighth block `mesh_u8`),
the ninth block `mm_f32` (empty until PM1 adds the multimesh table), a stable `content_version`
(invariant `content-version-stable`) and a patched `unsupported` (null in a patch means "as the
base").

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Like golden-10 this loads the earlier generators (golden-10's, which loads golden-9's, ...) and
re-binds what changes. The scene is golden-10's ten states plus six (render-stream-11.md "Golden
vectors"):

   11 mesh 1 (static since state 4) becomes dynamic with new bytes: the patch carries it with
      `hash: null` and a non-null `u8` (the transition), and its old hash leaves the state. Mesh 2
      is new and dynamic with two surfaces (a coloured indexed quad, a coloured triangle), drawn
      by the new item 15: its bodies follow mesh 1's in `mesh_u8`.
   12 mesh 1's custom AABB changes with equal bytes (version 4, `u8` null). Texture 5 is updated
      to golden-6's A2 image, so its hash F leaves the state.
   13 texture 5 returns to F: inline.rs11 re-carries F with a new record (at /10 that record is
      the invalid vector resource-duplicate-v10). Mesh 2's first surface gets new bytes of the
      same shape (`u8` non-null, mesh 1's `u8` absent: mesh 1 is not in the patch).
   14 mesh 1's shape changes (a triangle instead of a quad; `u8` required). Item 15 adds a texture
      rect against the unsupported texture 3, so the patch's `unsupported` is a new list.
   15 mesh 2 is freed (`u8` null) and item 15 removed; `unsupported` returns to golden-10's list.
   16 unchanged, re-sent full as after a resync: every dynamic body, and no record (the records
      before a transaction T whose stream predecessor is B are inline(T) minus inline(B)).

PM1 (render-stream-11.md "As built (PM1): decisions") adds the multimesh table to /11 and five
states. The session record changes per rule 8 in every golden-11 output (features.ops gains
"add_multimesh", features.resources gains "multimesh", features.observed_unsupported_ops loses
"canvas_item_add_multimesh"; each list stays sorted); every transaction of states 1-16 is
byte-identical to before PM1 (no multimesh key, mm_f32 empty). Buffers are f32, Godot's
TRANSFORM_2D layout per instance [xx, yx, 0, ox, xy, yy, 0, oy] then colour RGBA then custom RGBA:

    mm1_buffer(s, n), stride 16 (colors, custom), instance i = 0..n-1:
        [1, 0, 0, 10*i + s, 0, 1, 0, 5*i + 0.5,  0.25*(i+1), 0.5, 0.75, 1,  s, i, 0.5, 0.125]
    mm2_buffer(s, n), stride 8 (transforms only), instance i:
        [2, 0, 0, 32 + 16*i, 0, 2, 0, s + 0.5*i]

Every multimesh is origin "created". AABBs are the six floats (position xyz, size xyz).

   17 (from 16) three multimeshes and two new items:
      - multimesh 1: ok, version 4, mesh 1, format 2d, colors true, custom true, instances 3,
        visible -1, custom AABB all zero (none set), buffer mm1_buffer(17, 3) (48 floats).
      - multimesh 2: ok, version 5, mesh null, 2d, colors false, custom false, instances 2,
        visible 1, custom AABB [-4, -4, 0, 72, 40, 0], buffer mm2_buffer(17, 2) (16 floats).
      - multimesh 3: unsupported, reason multimesh-3d, version 2, mesh null, format "3d", colors
        false, custom false, instances 4, visible -1, AABB zero, no buffer (buffer_f null).
      - item 16 (canvas 1, xform x 192 y 64, draw_index 12, content_version 1): commands
        add_multimesh 1 tex 1 (an ok texture), add_multimesh 2 tex null, add_multimesh 3 tex null.
      - item 17 (x 208 y 64, draw_index 13, content_version 1): one command
        {"op":"unsupported","name":"canvas_item_add_multimesh","reason":"unknown-multimesh"} (an
        add_multimesh on a RID the mirror never saw created). It is a separate item because an
        item holds one unsupported[] entry per (item, op), and item 16 already holds
        (16, canvas_item_add_multimesh) for multimesh 3.
      - canvas 1's items gain 16 and 17; unsupported gains, after golden-10's two entries,
        {"op":"canvas_item_add_multimesh","item":16,"reason":"unsupported-multimesh"} and
        {"op":"canvas_item_add_multimesh","item":17,"reason":"unknown-multimesh"}.
      mm_f32 of the patch (and of full.rs11's seq 17): mm1 aabb_f 0, buffer_f 6; mm2 aabb_f 54,
      buffer_f 60; mm3 aabb_f 76, buffer_f null; count 82.
   18 multimesh 1: version 5, buffer mm1_buffer(18, 3). Multimesh 2: version 6, custom AABB
      [-8, -8, 0, 80, 48, 0], buffer unchanged. No item or unsupported change. The patch carries
      mm1 (aabb_f 0, buffer_f 6) and mm2 (aabb_f 54, buffer_f null: equal floats); count 60; mm3
      is absent (unchanged).
   19 multimesh 1 re-allocated: version 7, instances 5, buffer mm1_buffer(19, 5) (80 floats).
      Multimesh 3 freed: version 3, the tombstone (status freed, reason null, mesh null, 2d,
      colors/custom false, instances 0, visible -1, aabb_f and buffer_f null), still named by
      item 16. unsupported drops item 16's unsupported-multimesh entry (a freed multimesh is not
      unsupported). The patch carries mm1 (aabb_f 0, buffer_f 6) and mm3 (tombstone); count 86.
   20 item 16 draws only add_multimesh 1 tex 1 (content_version 2); multimeshes 2 and 3 leave
      the table: the patch carries removed_multimeshes [2, 3] and no "multimeshes" key (mm1 is
      unchanged), mm_f32 empty; unsupported is null (as 19).
   21 unchanged, re-sent full as after a resync: multimesh 1 only (aabb_f 0, buffer_f 6, count
      86, every buffer).

UIT (render-stream-11.md "As built (UIT)") adds the item key `use_identity_transform` (only ever
true, right after copy_to_backbuffer, absent when false) and two states; every transaction of
states 1-21 is byte-identical to before UIT:
   22 (from 21) item 18 is new, a child of item 16 (whose children become [18]): xform x 8 y 64,
      draw_index 0, content_version 1, one add_rect [0, 0, 8, 8] colour (1, 0.25, 0.5, 1), and
      use_identity_transform true. The patch carries items 16 and 18.
   23 item 18's use_identity_transform turns false (the key absent), nothing else: the patch
      carries item 18 alone, commands null (content_version 1 unchanged).
full.rs11 encodes the twenty-three states as full transactions (out-of-band); patch.rs11 patch-
encodes them (seq 1, 5, 16 and 21 full, every other seq a patch; `unsupported` is null in every
patch except 14, 15, 17 and 19); inline.rs11 encodes them as full transactions with inline
delivery, each transaction preceded by exactly the records inline(T) minus inline(B), in table
order (textures by id, each texture's hash then its variants; meshes by id, static surfaces in
order; shaders by id); states 17-21 add no record. All three resolve to resolved.json, whose
states 17-21 carry "multimeshes" (after "materials"; buffer_sha256 = SHA-256 of the buffer's LE
f32 bytes, null unless ok; custom_aabb null when freed). coding/*.coded are
capture/build/rs_live_coding_tool's `encode` of full/patch/inline.rs11 (regenerate them with it
after any change here).

The multimesh invalid vectors use mini_mm_states() (below): seq 1 full with multimesh 1 (ok,
colors+custom, 2 instances, mesh 1, version 3, mm1_buffer(101, 2)) and multimesh 2 (ok,
transforms only, 1 instance, visible 1, AABB [0, 0, 0, 16, 16, 0], version 2, mm2_buffer(101,
1)), item 1 drawing add_mesh 1, add_multimesh 1, add_multimesh 2; seq 2 a patch where multimesh 1
gets mm1_buffer(102, 2) at version 4. Each fails exactly one rule (index.json lists them).
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN10 = HERE.parent / "golden-10"
G10_SPEC = importlib.util.spec_from_file_location("golden10_make_golden",
                                                  GOLDEN10 / "make_golden.py")
g10 = importlib.util.module_from_spec(G10_SPEC)
sys.modules["golden10_make_golden"] = g10
G10_SPEC.loader.exec_module(g10)  # type: ignore[union-attr]
g9 = g10.g9
g8 = g9.g8
g6 = g9.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x42, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSB\r\n\x1a\n"
PROTOCOL = "render-stream/11"
MAGIC_V10 = g10.MAGIC
PROTOCOL_V10 = g10.PROTOCOL
MESH_DYNAMIC = {"mode": "auto", "frames": 4, "max_bytes": 65536}

# Every module that formats the magic or the protocol string, at the version being written.
_PROTO_MODULES = (g6, g8, g9, g10)
V10 = False  # True while writing a /10 record (resource-duplicate-v10): no /11 rewriting.


def _set_version(magic: bytes, protocol: str) -> None:
    g6.MAGIC = magic
    for module in _PROTO_MODULES:
        module.PROTOCOL = protocol


_set_version(MAGIC, PROTOCOL)


@contextlib.contextmanager
def as_v10():
    global V10
    V10 = True
    _set_version(MAGIC_V10, PROTOCOL_V10)
    try:
        yield
    finally:
        V10 = False
        _set_version(MAGIC, PROTOCOL)


# --------------------------------------------------------------------------- dynamic bodies


def body_of(payload: bytes) -> bytes:
    """A dynamic surface's body: its render-stream-mesh/1 payload without the 12-byte header
    (magic, meta length) and the meta, i.e. the 40-byte geometry block then the vertex,
    attribute, skin and index bytes."""
    assert payload[:8] == g6.GRM1_MAGIC
    meta_len = int.from_bytes(payload[8:12], "little")
    return payload[12 + meta_len:]


def dynamic_surface(payload: bytes, primitive: str, fmt: int, vertex_count: int,
                    index_count: int) -> dict:
    body = body_of(payload)
    return {"hash": None, "payload_bytes": len(body), "primitive": primitive, "format": fmt,
            "vertex_count": vertex_count, "index_count": index_count, "body": body}


SHAPE_KEYS = ("primitive", "format", "vertex_count", "index_count")


def is_dynamic(m: dict | None) -> bool:
    return (m is not None and m["status"] == "ok" and bool(m["surfaces"])
            and all(s["hash"] is None for s in m["surfaces"]))


def same_shape(a: dict, b: dict) -> bool:
    return len(a["surfaces"]) == len(b["surfaces"]) and all(
        all(sa[k] == sb[k] for k in SHAPE_KEYS) for sa, sb in zip(a["surfaces"], b["surfaces"]))


def bodies_needed(base: dict | None, cur: dict) -> bool:
    """render-stream-11.md "Mesh entry": a dynamic mesh's u8 is null only in a patch whose
    resolved entry was already dynamic with the same shapes, and (the host's serial rule) whose
    bytes did not change since the base."""
    if not is_dynamic(base) or not same_shape(base, cur):  # full, new, transition, shape change
        return True
    return any(sa["body"] != sb["body"] for sa, sb in zip(base["surfaces"], cur["surfaces"]))


# Mesh 1 at state 11: golden-6's textured quad B, moved right by one pixel.
MESH1_DYN_VERTS = [(x + 1.0, y) for x, y in g6.MESH1_SURFACE_B_VERTS]
MESH1_DYN_PAYLOAD = g6.build_mesh_payload(
    "triangles", g6.MESH1_SURFACE_B_FORMAT, 4, 6,
    g6.positions_f32(MESH1_DYN_VERTS), g6.uvs_f32(g6.MESH1_SURFACE_B_UVS), b"",
    g6.indices_u16(g6.MESH1_SURFACE_B_INDICES),
    [1.0, 0.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
# Mesh 1 at state 14: a textured triangle (3 vertices, no index): a shape change.
MESH1_TRI_FORMAT = g6.ARRAY_FORMAT_TEX_UV | g6.ARRAY_FLAG_USE_2D_VERTICES
MESH1_TRI_PAYLOAD = g6.build_mesh_payload(
    "triangles", MESH1_TRI_FORMAT, 3, 0,
    g6.positions_f32([(1.0, 0.0), (17.0, 0.0), (1.0, 16.0)]),
    g6.uvs_f32([(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]), b"", b"",
    [1.0, 0.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
# Mesh 2's second surface: golden-6's coloured triangle, moved down by 20 pixels.
MESH2_TRI_PAYLOAD = g6.build_mesh_payload(
    "triangles", g6.MESH1_SURFACE_A_FORMAT, 3, 0,
    g6.positions_f32([(x, y + 20.0) for x, y in g6.MESH1_SURFACE_A_VERTS]),
    g6.colors_rgba8(g6.MESH1_SURFACE_A_COLORS), b"", b"",
    [0.0, 20.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)


def mesh1_dyn() -> dict:
    return dynamic_surface(MESH1_DYN_PAYLOAD, "triangles", g6.MESH1_SURFACE_B_FORMAT, 4, 6)


def mesh1_tri() -> dict:
    return dynamic_surface(MESH1_TRI_PAYLOAD, "triangles", MESH1_TRI_FORMAT, 3, 0)


def mesh2_quad(payload: bytes) -> dict:
    return dynamic_surface(payload, "triangles", g6.MESH2_SURFACE_FORMAT, 4, 6)


def mesh2_tri() -> dict:
    return dynamic_surface(MESH2_TRI_PAYLOAD, "triangles", g6.MESH1_SURFACE_A_FORMAT, 3, 0)


# --------------------------------------------------------------------------- multimesh (PM1)

NO_AABB = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
SHAPE_MM_KEYS = ("instances", "format", "colors", "custom")
MM_JSON_KEYS = ("origin", "status", "reason", "version", "mesh", "format", "colors", "custom",
                "instances", "visible")


def mm_stride(m: dict) -> int:
    return 8 + 4 * int(m["colors"]) + 4 * int(m["custom"])


def multimesh(*, version: int, instances: int, colors: bool, custom: bool, buffer: list[float],
              mesh: int | None = None, visible: int = -1, custom_aabb: list[float] = NO_AABB,
              status: str = "ok", reason: str | None = None, fmt: str = "2d",
              origin: str = "created") -> dict:
    m = {"origin": origin, "status": status, "reason": reason, "version": version, "mesh": mesh,
         "format": fmt, "colors": colors, "custom": custom, "instances": instances,
         "visible": visible, "custom_aabb": list(custom_aabb), "buffer": list(buffer)}
    if status == "ok":
        assert reason is None and fmt == "2d" and visible <= instances
        assert len(buffer) == instances * mm_stride(m), (len(buffer), instances)
    else:
        assert reason is not None and not buffer
    return m


def freed_multimesh(version: int, origin: str = "created") -> dict:
    return {"origin": origin, "status": "freed", "reason": None, "version": version,
            "mesh": None, "format": "2d", "colors": False, "custom": False, "instances": 0,
            "visible": -1, "custom_aabb": None, "buffer": []}


def mm1_buffer(s: int, n: int) -> list[float]:
    """Multimesh 1's buffer at state s (colors and custom, stride 16): instance i is
    [1, 0, 0, 10i + s, 0, 1, 0, 5i + 0.5,  0.25(i + 1), 0.5, 0.75, 1,  s, i, 0.5, 0.125]."""
    out: list[float] = []
    for i in range(n):
        out += [1.0, 0.0, 0.0, 10.0 * i + s, 0.0, 1.0, 0.0, 5.0 * i + 0.5,
                0.25 * (i + 1), 0.5, 0.75, 1.0, float(s), float(i), 0.5, 0.125]
    return out


def mm2_buffer(s: int, n: int) -> list[float]:
    """Multimesh 2's buffer at state s (transforms only, stride 8): instance i is
    [2, 0, 0, 32 + 16i, 0, 2, 0, s + 0.5i]."""
    out: list[float] = []
    for i in range(n):
        out += [2.0, 0.0, 0.0, 32.0 + 16.0 * i, 0.0, 2.0, 0.0, s + 0.5 * i]
    return out


def add_multimesh(mm_id: int, tex: int | None = None) -> dict:
    return {"op": "add_multimesh", "multimesh": mm_id, "tex": tex}


g10_command_json = g6._command_json


def _command_json(command: dict, cmd_f32: list[float], cmd_i32: list[int]) -> dict:
    if command["op"] == "add_multimesh":  # PM1 rule 7: no floats, no "f"
        return {"op": "add_multimesh", "multimesh": command["multimesh"], "tex": command["tex"]}
    return g10_command_json(command, cmd_f32, cmd_i32)


g6._command_json = _command_json
g10_resolved_command = g6._resolved_command


def _resolved_command(command: dict) -> dict:
    if command["op"] == "add_multimesh":  # PM1 rule 10
        return {"op": "add_multimesh", "multimesh": command["multimesh"], "tex": command["tex"]}
    return g10_resolved_command(command)


g6._resolved_command = _resolved_command


def buffer_needed(full: bool, base: dict | None, cur: dict) -> bool:
    """PM1 rule 3: an ok entry's buffer_f is non-null in a full, for a new entry, when the base
    entry was not ok, after a shape change, and (the capture's serial rule) when its floats
    changed since the base."""
    if cur["status"] != "ok":
        return False
    if full or base is None or base["status"] != "ok":
        return True
    if any(base[k] != cur[k] for k in SHAPE_MM_KEYS):
        return True
    return g6.f32_pattern(base["buffer"]) != g6.f32_pattern(cur["buffer"])


def mm_differs(base: dict, cur: dict) -> bool:
    return (any(base[k] != cur[k] for k in MM_JSON_KEYS)
            or (base["custom_aabb"] is None) != (cur["custom_aabb"] is None)
            or (cur["custom_aabb"] is not None
                and g6.f32_pattern(base["custom_aabb"]) != g6.f32_pattern(cur["custom_aabb"])))


def _mm_entry_json(mm_id: int, m: dict, with_buffer: bool, mm_f32: list[float]) -> dict:
    aabb_f = None
    if m["status"] != "freed":
        aabb_f = len(mm_f32)
        mm_f32 += m["custom_aabb"]
    buffer_f = None
    if with_buffer:
        buffer_f = len(mm_f32)
        mm_f32 += m["buffer"]
    return {"id": mm_id, "origin": m["origin"], "status": m["status"], "reason": m["reason"],
            "version": m["version"], "mesh": m["mesh"], "format": m["format"],
            "colors": m["colors"], "custom": m["custom"], "instances": m["instances"],
            "visible": m["visible"], "aabb_f": aabb_f, "buffer_f": buffer_f}


def _multimesh_tables(encoding: str, base: dict | None, cur: dict,
                      mm_f32: list[float]) -> tuple[list[dict], list[int]]:
    """(multimeshes, removed_multimeshes) of one /11 transaction (PM1 rules 1-4 and 9)."""
    cur_mm = cur.get("multimeshes", {})
    full = encoding == "full"
    base_mm = {} if full else base.get("multimeshes", {})
    entries = []
    for mm_id in sorted(cur_mm):
        m, b = cur_mm[mm_id], base_mm.get(mm_id)
        with_buffer = buffer_needed(full, b, m)
        if not full and b is not None and not with_buffer and not mm_differs(b, m):
            continue
        entries.append(_mm_entry_json(mm_id, m, with_buffer, mm_f32))
    removed = [] if full else sorted(set(base_mm) - set(cur_mm))
    return entries, removed


def resolved_multimesh(mm_id: int, m: dict) -> dict:
    ok = m["status"] == "ok"
    return {"id": mm_id, "origin": m["origin"], "status": m["status"], "reason": m["reason"],
            "version": m["version"], "mesh": m["mesh"], "format": m["format"],
            "colors": m["colors"], "custom": m["custom"], "instances": m["instances"],
            "visible": m["visible"],
            "custom_aabb": None if m["custom_aabb"] is None else list(m["custom_aabb"]),
            "buffer_sha256": hashlib.sha256(g6.f32s(m["buffer"])).hexdigest() if ok else None}


# --------------------------------------------------------------------------- names and records

PAYLOADS = {
    g6.HASH_A1: g6.PAYLOAD_A1, g6.HASH_A2: g6.PAYLOAD_A2, g6.HASH_F: g6.PAYLOAD_F,
    g8.HASH_DEC: g8.PAYLOAD_DEC, g8.HASH_RGBAF: g8.PAYLOAD_RGBAF, g8.HASH_RH: g8.PAYLOAD_RH,
    g6.HASH_MESH1_A: g6.MESH1_SURFACE_A_PAYLOAD, g6.HASH_MESH1_B: g6.MESH1_SURFACE_B_PAYLOAD,
    g6.HASH_MESH2_V1: g6.MESH2_SURFACE_V1_PAYLOAD, g6.HASH_MESH2_V2: g6.MESH2_SURFACE_V2_PAYLOAD,
    g6.HASH_SHADER2_V1: g6.SHADER2_TINT_PAYLOAD_V1,
    g9.HASH_MIP16: g9.PAYLOAD_MIP16, g9.HASH_DXT5_16M: g9.PAYLOAD_DXT5_16M,
    g9.HASH_DXT5_4: g9.PAYLOAD_DXT5_4, g9.HASH_KTX2_16: g9.KTX2_16, g9.HASH_KTX2_4: g9.KTX2_4,
}


def names(state: dict) -> list[str]:
    """names(S) in table order, first occurrence only (render-stream-11.md "Definitions")."""
    out: list[str] = []

    def add(h: str | None) -> None:
        if h is not None and h not in out:
            out.append(h)

    for tid in sorted(state["textures"]):
        t = state["textures"][tid]
        if t["status"] == "ok" and t["kind"] == "image":
            add(t["hash"])
            for v in t.get("variants", []):
                add(v["hash"])
    for mid in sorted(state["meshes"]):
        m = state["meshes"][mid]
        if m["status"] == "ok":
            for s in m["surfaces"]:
                add(s["hash"])  # None on a dynamic surface: not named
    for sid in sorted(state["shaders"]):
        s = state["shaders"][sid]
        if s["status"] == "ok" and s.get("source") == "payload":
            add(s["hash"])
    return out


def records_before(base: dict | None, target: dict) -> list[str]:
    """inline(T) minus inline(B) (L2). Every golden payload is inline-sized under inline
    delivery (inline_max_bytes 16 MiB), so inline(S) is names(S)."""
    held = set(names(base)) if base is not None else set()
    return [h for h in names(target) if h not in held]


# --------------------------------------------------------------------------- encoding

# Set by the full/patch wrappers for the one transaction being encoded.
CONTEXT: dict | None = None
CV_CHURN = False  # set while writing the content-version-stable vector
# A hook for invalid vectors: called with (meta, blocks) of every /11 transaction before
# encoding; returns the (meta, blocks) to encode.
MUTATE = None

g10_encode_record = g6.encode_record


def _rewrite_transaction(meta: dict, blocks: list) -> tuple[dict, list]:
    assert CONTEXT is not None, "a /11 transaction outside full/patch_transaction_bytes"
    encoding, base, cur = CONTEXT["encoding"], CONTEXT["base"], CONTEXT["cur"]
    out = dict(meta)
    if encoding == "patch" and MUTATE is None and not CV_CHURN:
        for entry in meta["items"]:  # the valid vectors obey content-version-stable
            b = base["items"].get(entry["id"])
            if b is not None and entry["commands"] is not None:
                assert b["commands"] != cur["items"][entry["id"]]["commands"], entry["id"]
    if encoding == "patch" and cur["unsupported"] == base["unsupported"]:
        out["unsupported"] = None
    mesh_u8 = bytearray()
    meshes_json = []
    for entry in meta["meshes"]:
        m = cur["meshes"][entry["id"]]
        base_m = base["meshes"].get(entry["id"]) if encoding == "patch" else None
        u8 = None
        if is_dynamic(m) and bodies_needed(base_m, m):
            u8 = len(mesh_u8)
            for s in m["surfaces"]:
                mesh_u8 += s["body"]
        ordered = {}
        for key, value in entry.items():
            ordered[key] = value
            if key == "f":
                ordered["u8"] = u8
        meshes_json.append(ordered)
    out["meshes"] = meshes_json
    out["items"] = [_with_identity(entry, cur["items"][entry["id"]].get("use_identity_transform",
                                                                         False))
                    for entry in out["items"]]
    mm_f32: list[float] = []
    multimeshes_json, removed_multimeshes = _multimesh_tables(encoding, base, cur, mm_f32)
    if multimeshes_json or removed_multimeshes:  # PM1 rule 1: only when non-empty
        out = _with_after(out, "materials", [("multimeshes", multimeshes_json),
                                             ("removed_multimeshes", removed_multimeshes)])
    blocks = list(blocks) + [g6.u8block("mesh_u8", bytes(mesh_u8)),
                             g6.f32block("mm_f32", mm_f32)]
    if MUTATE is not None:
        out, blocks = MUTATE(out, blocks)
    return out, blocks


def _with_after(meta: dict, after: str, pairs: list[tuple[str, object]]) -> dict:
    """meta with each non-empty (key, list) of pairs inserted right after key `after`."""
    out = {}
    for key, value in meta.items():
        out[key] = value
        if key == after:
            for k, v in pairs:
                if v:
                    out[k] = v
    return out


def _pm1_features(features: dict) -> dict:
    """PM1 rule 8: the session record of a /11 capture with the multimesh hooks planned."""
    assert "add_multimesh" not in features["ops"]
    assert "canvas_item_add_multimesh" in features["observed_unsupported_ops"]
    return dict(
        features,
        ops=sorted(list(features["ops"]) + ["add_multimesh"]),
        resources=sorted(list(features["resources"]) + ["multimesh"]),
        observed_unsupported_ops=[op for op in features["observed_unsupported_ops"]
                                  if op != "canvas_item_add_multimesh"],
    )


def _encode_record(meta: dict, blocks: list, short_block: str | None = None) -> bytes:
    if not V10:
        if meta["type"] == "session":
            meta = dict(meta, resources=dict(meta["resources"],
                                             mesh_dynamic=dict(SESSION_MESH_DYNAMIC)))
            if PM1_FEATURES:
                meta["features"] = _pm1_features(meta["features"])
        elif meta["type"] == "transaction":
            meta, blocks = _rewrite_transaction(meta, blocks)
    return g10_encode_record(meta, blocks, short_block)


g6.encode_record = _encode_record
SESSION_MESH_DYNAMIC = dict(MESH_DYNAMIC)
PM1_FEATURES = True  # False while writing multimesh-feature (a session from before PM1)

g10_full_transaction_bytes = g6.full_transaction_bytes
g10_patch_transaction_bytes = g6.patch_transaction_bytes


def _full_transaction_bytes(seq: int, frame: int, state: dict) -> bytes:
    global CONTEXT
    CONTEXT = {"encoding": "full", "base": None, "cur": state}
    try:
        return g10_full_transaction_bytes(seq, frame, state)
    finally:
        CONTEXT = None


def _patch_transaction_bytes(seq: int, frame: int, base_seq: int, base: dict, cur: dict) -> bytes:
    global CONTEXT
    CONTEXT = {"encoding": "patch", "base": base, "cur": cur}
    try:
        return g10_patch_transaction_bytes(seq, frame, base_seq, base, cur)
    finally:
        CONTEXT = None


g6.full_transaction_bytes = _full_transaction_bytes
g6.patch_transaction_bytes = _patch_transaction_bytes

g10_item_differs = g6.item_differs


def _item_differs(a: dict, b: dict) -> bool:
    # UIT: use_identity_transform is a JSON value of the entry (absent is false).
    return (g10_item_differs(a, b)
            or a.get("use_identity_transform", False) != b.get("use_identity_transform", False))


g6.item_differs = _item_differs


def _with_identity(entry: dict, flag: bool) -> dict:
    """UIT: entry with "use_identity_transform": true right after copy_to_backbuffer when flag."""
    if not flag:
        return entry
    out = {}
    for key, value in entry.items():
        out[key] = value
        if key == "copy_to_backbuffer":
            out["use_identity_transform"] = True
    assert "use_identity_transform" in out
    return out

# g8's mesh_differs compares the surface lists, which hold the dynamic bodies: a changed body
# re-sends the entry. Its version moves too (mesh-version), so this is belt and braces.

# --------------------------------------------------------------------------- the six states


def _copy(state: dict) -> dict:
    return {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
            for k, v in state.items()}


def state11() -> dict:
    state = _copy(g10.STATES[9])
    meshes = state["meshes"]
    meshes[1] = dict(meshes[1], version=3, surfaces=[mesh1_dyn()])
    meshes[2] = dict(g6.mesh(version=1, surfaces=[mesh2_quad(g6.MESH2_SURFACE_V1_PAYLOAD),
                                                  mesh2_tri()]),
                     origin="created", adopted_content=None)
    items = state["items"]
    items[15] = g10._bb_item(parent=("canvas", 1), children=[], x=192.0, draw_index=12,
                             content_version=1, commands=[g6.add_mesh(2, g6.IDENTITY)])
    state["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 15])
    return state


def state12() -> dict:
    state = _copy(STATES[10])
    state["meshes"][1] = dict(state["meshes"][1], version=4,
                              custom_aabb=[0.0, 0.0, 0.0, 32.0, 32.0, 0.0])
    state["textures"][5] = dict(state["textures"][5], version=2, hash=g6.HASH_A2, format="RGBA8",
                                width=16, height=16, payload_bytes=len(g6.PAYLOAD_A2))
    return state


def state13() -> dict:
    state = _copy(STATES[11])
    state["textures"][5] = dict(g10.STATES[9]["textures"][5], version=3)
    state["meshes"][2] = dict(state["meshes"][2], version=2,
                              surfaces=[mesh2_quad(g6.MESH2_SURFACE_V2_PAYLOAD), mesh2_tri()])
    return state


def state14() -> dict:
    state = _copy(STATES[12])
    state["meshes"][1] = dict(state["meshes"][1], version=5, surfaces=[mesh1_tri()])
    it = dict(state["items"][15])
    it["content_version"] = 2
    it["commands"] = [g6.add_mesh(2, g6.IDENTITY),
                      g6.add_texture_rect(3, False, False, [0.0, 0.0, 4.0, 4.0])]
    state["items"][15] = it
    state["unsupported"] = list(state["unsupported"]) + [
        {"op": "canvas_item_add_texture_rect", "item": 15, "reason": "unsupported-texture"}]
    return state


def state15() -> dict:
    state = _copy(STATES[13])
    state["meshes"][2] = dict(g6.mesh(status="freed", version=3), origin="created",
                              adopted_content=None)
    del state["items"][15]
    state["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14])
    state["unsupported"] = list(g10.STATES[9]["unsupported"])
    return state


def state16() -> dict:
    return _copy(STATES[14])


# --------------------------------------------------------------------------- the five multimesh states

MM_UNSUPPORTED_16 = {"op": "canvas_item_add_multimesh", "item": 16,
                     "reason": "unsupported-multimesh"}
MM_UNKNOWN_17 = {"op": "canvas_item_add_multimesh", "item": 17, "reason": "unknown-multimesh"}


def state17() -> dict:
    state = _copy(STATES[15])
    state["multimeshes"] = {
        1: multimesh(version=4, instances=3, colors=True, custom=True, mesh=1,
                     buffer=mm1_buffer(17, 3)),
        2: multimesh(version=5, instances=2, colors=False, custom=False, visible=1,
                     custom_aabb=[-4.0, -4.0, 0.0, 72.0, 40.0, 0.0], buffer=mm2_buffer(17, 2)),
        3: multimesh(version=2, instances=4, colors=False, custom=False, status="unsupported",
                     reason="multimesh-3d", fmt="3d", buffer=[]),
    }
    items = state["items"]
    items[16] = g10._bb_item(parent=("canvas", 1), children=[], x=192.0, draw_index=12,
                             content_version=1,
                             commands=[add_multimesh(1, 1), add_multimesh(2), add_multimesh(3)])
    items[17] = g10._bb_item(parent=("canvas", 1), children=[], x=208.0, draw_index=13,
                             content_version=1,
                             commands=[g6.unsupported_cmd("canvas_item_add_multimesh",
                                                          "unknown-multimesh")])
    state["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 16, 17])
    state["unsupported"] = list(state["unsupported"]) + [MM_UNSUPPORTED_16, MM_UNKNOWN_17]
    return state


def state18() -> dict:
    state = _copy(STATES[16])
    mms = state["multimeshes"]
    mms[1] = dict(mms[1], version=5, buffer=mm1_buffer(18, 3))
    mms[2] = dict(mms[2], version=6, custom_aabb=[-8.0, -8.0, 0.0, 80.0, 48.0, 0.0])
    return state


def state19() -> dict:
    state = _copy(STATES[17])
    mms = state["multimeshes"]
    mms[1] = dict(mms[1], version=7, instances=5, buffer=mm1_buffer(19, 5))
    mms[3] = freed_multimesh(3)
    state["unsupported"] = [u for u in state["unsupported"] if u != MM_UNSUPPORTED_16]
    return state


def state20() -> dict:
    state = _copy(STATES[18])
    state["multimeshes"] = {1: state["multimeshes"][1]}
    state["items"][16] = dict(state["items"][16], content_version=2,
                              commands=[add_multimesh(1, 1)])
    return state


def state21() -> dict:
    return _copy(STATES[19])


# --------------------------------------------------------------------------- the two UIT states


def state22() -> dict:
    state = _copy(STATES[20])
    items = state["items"]
    items[16] = dict(items[16], children=[18])
    items[18] = g10._bb_item(parent=("item", 16), children=[], x=8.0, draw_index=0,
                             content_version=1,
                             commands=[g6.add_rect([0.0, 0.0, 8.0, 8.0], [1.0, 0.25, 0.5, 1.0])])
    items[18]["use_identity_transform"] = True
    return state


def state23() -> dict:
    state = _copy(STATES[21])
    item = dict(state["items"][18])
    del item["use_identity_transform"]
    state["items"][18] = item
    return state


STATES: list[dict] = list(g10.STATES)
for _make in (state11, state12, state13, state14, state15, state16,
              state17, state18, state19, state20, state21, state22, state23):
    STATES.append(_make())

# --------------------------------------------------------------------------- decode / resolved


def decode(data: bytes) -> dict:
    out = g6.decode(data)
    out["schema"] = "render-stream-11-decoded/1"
    return out


def resolved_state(state: dict) -> dict:
    out = g10.resolved_state(state)
    for entry in out["meshes"]:
        m = state["meshes"][entry["id"]]
        surfaces = []
        for s in (m["surfaces"] if m["status"] == "ok" else []):
            body = s.get("body")
            surfaces.append({
                "hash": s["hash"],
                "body_sha256": None if body is None else hashlib.sha256(body).hexdigest(),
                "payload_bytes": s["payload_bytes"], "primitive": s["primitive"],
                "format": s["format"], "vertex_count": s["vertex_count"],
                "index_count": s["index_count"],
            })
        entry["surfaces"] = surfaces
    out["items"] = [_with_identity(entry, state["items"][entry["id"]].get(
        "use_identity_transform", False)) for entry in out["items"]]
    mms = state.get("multimeshes", {})
    if mms:  # PM1 rule 10: right after "materials", only when non-empty
        assert list(out)[-1] == "materials"
        out["multimeshes"] = [resolved_multimesh(i, mms[i]) for i in sorted(mms)]
    return out


# --------------------------------------------------------------------------- recordings


def inline_recording(states: list[dict], *, session_id: str, stream_id: str,
                     drop: tuple[int, str] | None = None,
                     extra: dict[int, list[str]] | None = None,
                     trailing: list[str] = ()) -> tuple[bytes, list[tuple[str, bytes]]]:
    """Full transactions with inline delivery, each preceded by records_before(previous, it).
    drop=(seq, hash) withholds one record (keep-carried's output); extra={seq: [hash]} sends
    more records before seq; trailing sends records after the last transaction."""
    session = g9.session_record(stream_id, "file", "full", session_id, delivery="inline")
    records = [session]
    sent: list[tuple[str, bytes]] = []

    def record(h: str) -> None:
        sent.append((h, PAYLOADS[h]))
        records.append(g6.resource_record_bytes(h, PAYLOADS[h]))

    prev = None
    for i, state in enumerate(states):
        seq = i + 1
        for h in records_before(prev, state):
            if drop != (seq, h):
                record(h)
        for h in (extra or {}).get(seq, []):
            record(h)
        records.append(g6.full_transaction_bytes(seq, seq, state))
        prev = state
    for h in trailing:
        record(h)
    end = g6.end_record(len(states), records, diff_ns_total=0, full_transactions=len(states),
                        patch_transactions=0, resource_records=len(sent),
                        resource_bytes=sum(len(p) for _, p in sent))
    return g6.recording(records, end), sent


INLINE_SESSION = "33333333333333333333333333333333"
INLINE_STREAM = "3" * 32


def build_inline() -> tuple[bytes, list[tuple[str, bytes]]]:
    return inline_recording(STATES, session_id=INLINE_SESSION, stream_id=INLINE_STREAM)


# --------------------------------------------------------------------------- invalid vectors

MINI_SESSION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def mini_state(meshes: dict) -> dict:
    item = g10._bb_item(parent=("canvas", 1), children=[], x=0.0, draw_index=0,
                        content_version=1,
                        commands=[g6.add_mesh(mid, g6.IDENTITY) for mid in sorted(meshes)])
    return {"items": {1: item}, "canvases": {1: g6.root_canvas([1])}, "textures": {},
            "meshes": meshes, "shaders": {}, "materials": {}, "unsupported": [],
            "failures": [], "default_filter": "nearest", "default_repeat": "disabled"}


def mini_mesh(surfaces: list[dict], version: int = 1) -> dict:
    return dict(g6.mesh(version=version, surfaces=surfaces), origin="created",
                adopted_content=None)


def mini_states() -> list[dict]:
    """Two dynamic meshes (mesh 2's bodies follow mesh 1's), then a patch that moves only mesh 1's AABB."""
    one = mini_state({1: mini_mesh([mesh1_dyn()]),
                      2: mini_mesh([mesh2_quad(g6.MESH2_SURFACE_V1_PAYLOAD)])})
    two = _copy(one)
    two["meshes"][1] = dict(two["meshes"][1], version=2,
                            custom_aabb=[0.0, 0.0, 0.0, 8.0, 8.0, 0.0])
    return [one, two]


def mini_recording(states: list[dict] | None = None, mutate=None, *, patch: bool = False,
                   mutate_seq: int | None = None) -> bytes:
    """A mini out-of-band recording: seq 1 full, then patches when patch is set. mutate applies
    to every transaction, or to seq mutate_seq only."""
    global MUTATE
    states = states or mini_states()
    session = g9.session_record(MINI_STREAM, "file", "patch" if patch else "full", MINI_SESSION,
                                delivery="out-of-band", adoption=None, decode="off")
    records = [session]
    for i, state in enumerate(states):
        seq = i + 1
        MUTATE = mutate if (mutate_seq is None or mutate_seq == seq) else None
        try:
            if patch and i > 0:
                records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, states[i - 1],
                                                          state))
            else:
                records.append(g6.full_transaction_bytes(seq, seq, state))
        finally:
            MUTATE = None
    end = g6.end_record(len(states), records, diff_ns_total=0,
                        full_transactions=1 if patch else len(states),
                        patch_transactions=len(states) - 1 if patch else 0,
                        resource_records=0, resource_bytes=0)
    return g6.recording(records, end)


def _mesh_entry(mesh_id: int, fn):
    def mutate(meta: dict, blocks: list):
        meshes = []
        for entry in meta["meshes"]:
            entry = dict(entry)
            if entry["id"] == mesh_id:
                fn(entry)
            meshes.append(entry)
        return dict(meta, meshes=meshes), blocks
    return mutate


def _block(name: str, fn):
    def mutate(meta: dict, blocks: list):
        return meta, [fn(b) if b[0] == name else b for b in blocks]
    return mutate


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str, int]]:
    global SESSION_MESH_DYNAMIC, CV_CHURN
    out: dict[str, tuple[bytes, str, str, int]] = {}
    out["bad-magic"] = ((GOLDEN10 / "full.rs10").read_bytes(), "bad-magic",
                        "golden-10's full.rs10: magic byte 3 is 'A' (GRSA), not 'B'", 11)

    # The carried set, over the shared scene's inline stream.
    def inline_variant(**kw) -> bytes:
        return inline_recording(STATES, session_id=INLINE_SESSION, stream_id=INLINE_STREAM,
                                **kw)[0]

    out["resource-missing"] = (
        inline_variant(drop=(13, g6.HASH_F)), "resource-missing",
        "inline.rs11 without seq 13's record for F, which left the state at seq 12 and returns "
        "(sabotage keep-carried: an encoder that keeps /10's lifelong set writes exactly this)",
        11)
    out["resource-duplicate"] = (
        inline_variant(extra={12: [g6.HASH_F]}), "resource-duplicate",
        "inline.rs11 plus a record for F before seq 12: F is still carried (seq 11 names it), "
        "and seq 12 prunes it only after its own checks", 11)
    out["resource-unnamed"] = (
        inline_variant(extra={16: [g6.HASH_MESH2_V2]}), "resource-unnamed",
        "inline.rs11 plus a record before seq 16 for golden-6's mesh 2 v2 surface, which seq 16 "
        "does not name", 11)
    out["resource-unnamed-end"] = (
        inline_variant(trailing=[g6.HASH_MESH2_V2]), "resource-unnamed",
        "inline.rs11 plus a record after the last transaction, before the end record", 11)

    # resource-duplicate-v10: the returning texture at /10, where "carried" is lifelong. States
    # 1, 12 and 13's textures alone (no dynamic mesh: /10 has none), as a /10 stream.
    def v10_state(state: dict) -> dict:
        s = _copy(state)
        s["meshes"] = {}
        s["items"] = {k: v for k, v in s["items"].items() if k not in (8, 15)}
        s["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 9, 10, 12, 13, 14])
        return s

    with as_v10():
        v10, _ = inline_recording([v10_state(STATES[i]) for i in (10, 11, 12)],
                                  session_id=INLINE_SESSION, stream_id=INLINE_STREAM)
    out["resource-duplicate-v10"] = (
        v10, "resource-duplicate",
        "a render-stream/10 inline stream of states 11 to 13's textures (meshes dropped): F is "
        "carried at seq 1, leaves at seq 2 and is re-carried before seq 3, a duplicate at /10 "
        "(valid at /11, where inline.rs11 does the same)", 10)

    # Dynamic meshes.
    def mixed(entry: dict) -> None:
        entry["surfaces"] = [dict(entry["surfaces"][0], hash=g6.HASH_MESH2_V1)] + \
            entry["surfaces"][1:]

    two_surface = [mini_state({1: mini_mesh([mesh1_dyn()]),
                               2: mini_mesh([mesh2_quad(g6.MESH2_SURFACE_V1_PAYLOAD),
                                             mesh2_tri()])})]
    out["mesh-dynamic-mixed"] = (
        mini_recording(two_surface, _mesh_entry(2, mixed)), "mesh-dynamic",
        "mesh 2 has a static first surface (a hash) and a dynamic second one (hash null)", 11)
    out["mesh-dynamic-full-null"] = (
        mini_recording(None, _drop_bodies(2)), "mesh-dynamic",
        "a full transaction carries dynamic mesh 2 with u8 null (and mesh_u8 without its body)",
        11)
    static = [mini_state({1: mini_mesh([g6.mesh_surface(
        g6.HASH_MESH2_V1, len(g6.MESH2_SURFACE_V1_PAYLOAD), "triangles", g6.MESH2_SURFACE_FORMAT,
        4, 6)])})]
    out["mesh-dynamic-static-u8"] = (
        mini_recording(static, _mesh_entry(1, lambda e: e.update(u8=0))), "mesh-dynamic",
        "static mesh 1 (its surface has a hash) carries u8 0", 11)

    shape = mini_states()
    shape[1]["meshes"][1] = dict(shape[1]["meshes"][1], surfaces=[mesh1_tri()], version=3)
    out["mesh-dynamic-shape-null"] = (
        mini_recording(shape, _drop_bodies(1), patch=True, mutate_seq=2),
        "mesh-dynamic",
        "seq 2 changes dynamic mesh 1's shape (a triangle) but leaves its u8 null", 11)

    B1 = len(body_of(MESH1_DYN_PAYLOAD))
    B2 = len(body_of(g6.MESH2_SURFACE_V1_PAYLOAD))
    out["mesh-u8-offset"] = (
        mini_recording(None, _mesh_entry(2, lambda e: e.update(u8=e["u8"] + 1))),
        "mesh-u8-offset", f"mesh 2's u8 is {B1 + 1}, expected {B1} (mesh 1's one body is {B1} bytes)",
        11)
    out["mesh-u8-offset-short"] = (
        mini_recording(None, _block("mesh_u8", lambda b: (b[0], b[1], b[2][:-1]))),
        "mesh-u8-offset",
        f"mesh_u8 carries {B1 + B2 - 1} bytes (count {B1 + B2 - 1}), the meshes claim {B1 + B2}",
        11)

    def short_body(meta: dict, blocks: list):
        meta, blocks = _mesh_entry(2, lambda e: e.update(surfaces=[
            dict(e["surfaces"][0], payload_bytes=e["surfaces"][0]["payload_bytes"] - 1)]))(
            meta, blocks)
        return meta, [(b[0], b[1], b[2][:-1]) if b[0] == "mesh_u8" else b for b in blocks]

    out["payload-size"] = (
        mini_recording(None, short_body), "payload-size",
        f"mesh 2's body is one byte short: payload_bytes {B2 - 1}, its shape needs {B2}", 11)
    out["mm-f32-type"] = (
        mini_recording(None, _block("mm_f32", lambda b: ("mm_f32", "u8", b""))), "meta-schema",
        "the ninth block mm_f32 has type u8 (a u8 block is legal only as mesh_u8)", 11)
    out["mm-offset"] = (
        mini_recording(None, _block("mm_f32", lambda b: ("mm_f32", "f32", [1.0]))), "mm-offset",
        "mm_f32 carries one float, but no multimesh entry claims any", 11)

    # The session key.
    SESSION_MESH_DYNAMIC = {"mode": "sometimes", "frames": 4, "max_bytes": 65536}
    try:
        out["mesh-dynamic-policy"] = (
            mini_recording(), "mesh-dynamic-policy",
            "resources.mesh_dynamic.mode is \"sometimes\", not auto, off or all", 11)
        SESSION_MESH_DYNAMIC = {"mode": "auto", "frames": 0, "max_bytes": 65536}
        out["mesh-dynamic-policy-frames"] = (
            mini_recording(), "mesh-dynamic-policy",
            "resources.mesh_dynamic.frames is 0, outside 1..60", 11)
    finally:
        SESSION_MESH_DYNAMIC = dict(MESH_DYNAMIC)

    # WB: stable content_version and patched unsupported.
    churn = mini_states()
    churn[1]["items"][1] = dict(churn[1]["items"][1], content_version=2)
    CV_CHURN = True
    try:
        cv_churn = mini_recording(churn, patch=True)
    finally:
        CV_CHURN = False
    out["content-version-stable"] = (
        cv_churn, "content-version-stable",
        "seq 2 re-sends item 1 with commands equal to the base's under content_version 2 (the "
        "capture sabotage cv-churn's shape)", 11)
    out["unsupported-null-full"] = (
        mini_recording(None, lambda meta, blocks: (dict(meta, unsupported=None), blocks)),
        "meta-schema", "a full transaction's unsupported is null (legal in a patch only)", 11)
    out.update(build_multimesh_vectors())
    out.update(build_identity_vectors())
    return out


# --------------------------------------------------------------------------- multimesh vectors


def mini_mm_states() -> list[dict]:
    """Seq 1 (full): dynamic mesh 1; multimesh 1 (ok, colors and custom, 2 instances, mesh 1,
    version 3, buffer mm1_buffer(101, 2)) and multimesh 2 (ok, transforms only, 1 instance,
    visible 1, mesh null, custom AABB [0, 0, 0, 16, 16, 0], version 2, buffer mm2_buffer(101,
    1)); item 1 draws add_mesh 1, add_multimesh 1 and add_multimesh 2 (tex null). Seq 2 (a
    patch): multimesh 1's buffer becomes mm1_buffer(102, 2), version 4."""
    one = mini_state({1: mini_mesh([mesh1_dyn()])})
    one["items"][1] = dict(one["items"][1], commands=[g6.add_mesh(1, g6.IDENTITY),
                                                      add_multimesh(1), add_multimesh(2)])
    one["multimeshes"] = {
        1: multimesh(version=3, instances=2, colors=True, custom=True, mesh=1,
                     buffer=mm1_buffer(101, 2)),
        2: multimesh(version=2, instances=1, colors=False, custom=False, visible=1,
                     custom_aabb=[0.0, 0.0, 0.0, 16.0, 16.0, 0.0], buffer=mm2_buffer(101, 1)),
    }
    two = _copy(one)
    two["multimeshes"][1] = dict(two["multimeshes"][1], version=4, buffer=mm1_buffer(102, 2))
    return [one, two]


def _mm_entry(mm_id: int, fn):
    def mutate(meta: dict, blocks: list):
        mms = []
        for entry in meta["multimeshes"]:
            entry = dict(entry)
            if entry["id"] == mm_id:
                fn(entry)
            mms.append(entry)
        return dict(meta, multimeshes=mms), blocks
    return mutate


def _cut_buffer(mm_id: int):
    """Null mm_id's buffer_f and cut its floats out of mm_f32 (later offsets move down), so that
    only the buffer_f rule fails."""
    def mutate(meta: dict, blocks: list):
        cut = None
        mms = []
        for entry in meta["multimeshes"]:
            entry = dict(entry)
            if entry["id"] == mm_id:
                stride = 8 + 4 * int(entry["colors"]) + 4 * int(entry["custom"])
                cut = (entry["buffer_f"], entry["buffer_f"] + entry["instances"] * stride)
                entry["buffer_f"] = None
            mms.append(entry)
        assert cut is not None
        for entry in mms:
            for key in ("aabb_f", "buffer_f"):
                if entry[key] is not None and entry[key] >= cut[1]:
                    entry[key] -= cut[1] - cut[0]
        blocks = [(b[0], b[1], b[2][:cut[0]] + b[2][cut[1]:]) if b[0] == "mm_f32" else b
                  for b in blocks]
        return dict(meta, multimeshes=mms), blocks
    return mutate


def _insert_after_materials(key: str, value):
    def mutate(meta: dict, blocks: list):
        out = {}
        for k, v in meta.items():
            out[k] = v
            if k == "materials":
                out[key] = value
        return out, blocks
    return mutate


def build_multimesh_vectors() -> dict[str, tuple[bytes, str, str, int]]:
    global PM1_FEATURES
    out: dict[str, tuple[bytes, str, str, int]] = {}
    mm = mini_mm_states()
    full1 = [mm[0]]
    # Seq 1's mm_f32: multimesh 1's AABB at 0, its 32 buffer floats at 6, multimesh 2's AABB at
    # 38, its 8 buffer floats at 44: 52 floats.
    out["mm-offset-wrong"] = (
        mini_recording(full1, _mm_entry(2, lambda e: e.update(buffer_f=e["buffer_f"] + 1))),
        "mm-offset", "multimesh 2's buffer_f is 45, expected 44 (6 + 32 + 6 floats before it)",
        11)
    out["mm-offset-short"] = (
        mini_recording(full1, _block("mm_f32", lambda b: (b[0], b[1], b[2][:-1]))),
        "mm-offset", "mm_f32 carries 51 floats (count 51), the multimeshes claim 52", 11)
    out["multimesh-entry"] = (
        mini_recording(full1, _mm_entry(1, lambda e: e.update(reason="multimesh-3d"))),
        "multimesh-entry", "multimesh 1 is ok with reason \"multimesh-3d\" (ok needs null)", 11)
    out["multimesh-entry-full-null"] = (
        mini_recording(full1, _cut_buffer(1)), "multimesh-entry",
        "a full transaction carries ok multimesh 1 with buffer_f null (its floats cut from "
        "mm_f32, later offsets moved down)", 11)
    shape = mini_mm_states()
    shape[1]["multimeshes"][1] = dict(shape[1]["multimeshes"][1], version=5, instances=3,
                                      buffer=mm1_buffer(102, 3))
    out["multimesh-entry-shape-null"] = (
        mini_recording(shape, _cut_buffer(1), patch=True, mutate_seq=2), "multimesh-entry",
        "seq 2 re-allocates multimesh 1 to 3 instances (a shape change) but leaves its buffer_f "
        "null", 11)

    def unsupported_with_buffer(meta: dict, blocks: list):
        meta, blocks = _mm_entry(1, lambda e: e.update(status="unsupported",
                                                       reason="multimesh-interpolated"))(
            meta, blocks)
        return dict(meta, unsupported=[{"op": "canvas_item_add_multimesh", "item": 1,
                                        "reason": "unsupported-multimesh"}]), blocks

    out["multimesh-entry-unsupported-buffer"] = (
        mini_recording(full1, unsupported_with_buffer), "multimesh-entry",
        "multimesh 1 is unsupported (multimesh-interpolated, with its derived item entry) but "
        "carries buffer_f 6 and its floats", 11)

    def extra_command(meta: dict, blocks: list):
        items = []
        for entry in meta["items"]:
            entry = dict(entry)
            if entry["id"] == 1:
                entry["commands"] = list(entry["commands"]) + [add_multimesh(9)]
            items.append(entry)
        return dict(meta, items=items), blocks

    out["multimesh-ref"] = (
        mini_recording(full1, extra_command), "multimesh-ref",
        "item 1 also draws add_multimesh 9, which has no multimesh entry", 11)
    out["multimesh-ref-mesh"] = (
        mini_recording(full1, _mm_entry(1, lambda e: e.update(mesh=7))), "multimesh-ref",
        "multimesh 1's mesh is 7, which has no mesh entry", 11)
    out["multimesh-version"] = (
        mini_recording(mm, _mm_entry(1, lambda e: e.update(version=2)), patch=True,
                       mutate_seq=2), "multimesh-version",
        "seq 2 carries multimesh 1 (new floats) at version 2, below the base's 3", 11)
    out["multimesh-empty-key"] = (
        mini_recording(None, _insert_after_materials("multimeshes", [])), "meta-schema",
        "a transaction carries \"multimeshes\": [] (the key is present only when non-empty)", 11)
    out["multimesh-removed-empty-key"] = (
        mini_recording(None, _insert_after_materials("removed_multimeshes", []), patch=True,
                       mutate_seq=2), "meta-schema",
        "a patch carries \"removed_multimeshes\": [] (the key is present only when non-empty)",
        11)
    PM1_FEATURES = False
    try:
        out["multimesh-feature"] = (
            mini_recording(full1), "meta-schema",
            "item 1 draws add_multimesh in a session whose features.ops lacks add_multimesh "
            "(the session record from before PM1)", 11)
    finally:
        PM1_FEATURES = True

    # A /10 stream (golden-10's mini scene) whose transaction carries a multimeshes key.
    entry = {"id": 1, "origin": "created", "status": "ok", "reason": None, "version": 1,
             "mesh": None, "format": "2d", "colors": False, "custom": False, "instances": 0,
             "visible": -1, "aabb_f": 0, "buffer_f": 6}

    def v10_key(meta: dict, backbuffer: list[float]):
        out10 = {}
        for k, v in meta.items():
            out10[k] = v
            if k == "materials":
                out10["multimeshes"] = [entry]
        return out10, backbuffer

    with as_v10():
        v10 = g10.mini_recording(v10_key)
    out["multimesh-v10"] = (
        v10, "meta-schema",
        "a render-stream/10 transaction (golden-10's mini scene) carries a \"multimeshes\" key, "
        "which exists only at /11", 10)
    return out


def build_identity_vectors() -> dict[str, tuple[bytes, str, str, int]]:
    """UIT: the item key's two spellings that are not the wire's."""
    out: dict[str, tuple[bytes, str, str, int]] = {}

    def identity_key(value):
        def mutate(meta: dict, blocks: list):
            items = [_with_identity(entry, True) for entry in meta["items"]]
            items = [dict(entry, use_identity_transform=value) for entry in items]
            return dict(meta, items=items), blocks
        return mutate

    out["identity-transform-false"] = (
        mini_recording(None, identity_key(False)), "meta-schema",
        "item 1 carries \"use_identity_transform\": false (the key is present only when true)",
        11)

    def v10_identity(meta: dict, backbuffer: list[float]):
        items = []
        for entry in meta["items"]:
            item = {}
            for k, v in entry.items():
                item[k] = v
                if k == "copy_to_backbuffer":
                    item["use_identity_transform"] = True
            items.append(item)
        return dict(meta, items=items), backbuffer

    with as_v10():
        v10 = g10.mini_recording(v10_identity)
    out["identity-transform-v10"] = (
        v10, "meta-schema",
        "a render-stream/10 transaction (golden-10's mini scene) carries an item's "
        "\"use_identity_transform\": true, which exists only at /11", 10)
    return out


def _drop_bodies(mesh_id: int):
    """Null mesh_id's u8 and cut its bodies out of mesh_u8, so that only mesh-dynamic fails."""
    def mutate(meta: dict, blocks: list):
        cut = None
        meshes = []
        for entry in meta["meshes"]:
            entry = dict(entry)
            if entry["id"] == mesh_id:
                cut = (entry["u8"], entry["u8"] + sum(s["payload_bytes"]
                                                      for s in entry["surfaces"]))
                entry["u8"] = None
            meshes.append(entry)
        assert cut is not None
        for entry in meshes:  # later offsets move down by the cut
            if entry["u8"] is not None and entry["u8"] >= cut[1]:
                entry["u8"] -= cut[1] - cut[0]
        blocks = [(b[0], b[1], b[2][:cut[0]] + b[2][cut[1]:]) if b[0] == "mesh_u8" else b
                  for b in blocks]
        return dict(meta, meshes=meshes), blocks
    return mutate


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    hello10 = g10.control_messages()["valid"]["hello-native-block"]
    assert hello10["protocol"] == PROTOCOL
    hello11 = dict(hello10, receiver="gate11-native")
    # W11t (render-stream-11.md "As built (W11t)"): a /11 hello may offer `live_coding`, the
    # receiver's codings in its preference order (^[a-z0-9-]+(,[a-z0-9-]+)*$); the only optional
    # key of any control message. Its invalid twin breaks the grammar.
    return {
        "valid": {
            "hello-native-block": hello11,
            "hello-live-coding": dict(hello11, live_coding="zstd-base,zstd"),
        },
        "invalid": {
            "hello-wrong-protocol": dict(hello11, protocol="render-stream/10"),
            "hello-live-coding-grammar": dict(hello11, live_coding="zstd-base,"),
        },
    }


# --------------------------------------------------------------------------- build


def build() -> dict[str, bytes]:
    full_session = g9.session_record("1" * 32, "file", "full", "0123456789abcdef0123456789abcdef",
                                     delivery="out-of-band")
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(g6.full_transaction_bytes(i + 1, i + 1, state))
    full_end = g6.end_record(len(STATES), full_records, diff_ns_total=0,
                             full_transactions=len(STATES), patch_transactions=0,
                             resource_records=0, resource_bytes=0)
    full_rs11 = g6.recording(full_records, full_end)

    patch_session = g9.session_record("2" * 32, "file", "patch",
                                      "fedcba9876543210fedcba9876543210", delivery="out-of-band")
    full_seqs = (1, 5, 16, 21)  # 5, 16 and 21: a resync's full
    patch_records = [patch_session]
    for i, state in enumerate(STATES):
        seq = i + 1
        if seq in full_seqs:
            patch_records.append(g6.full_transaction_bytes(seq, seq, state))
        else:
            patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[i - 1],
                                                            state))
    patch_end = g6.end_record(len(STATES), patch_records, diff_ns_total=12345,
                              full_transactions=len(full_seqs),
                              patch_transactions=len(STATES) - len(full_seqs),
                              resource_records=0, resource_bytes=0)
    patch_rs11 = g6.recording(patch_records, patch_end)

    inline_rs11, inline_payloads = build_inline()

    full_decoded, patch_decoded = decode(full_rs11), decode(patch_rs11)
    inline_decoded = decode(inline_rs11)
    resolved = {
        "schema": "render-stream-11-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": resolved_state(s)}
                         for i, s in enumerate(STATES)],
    }

    # Every inline record, in stream order, with its index and the seq it precedes. A hash may
    # appear more than once at /11 (F at seq 1 and seq 13).
    inline_resources = []
    next_seq = None
    pending = []
    for i, rec in enumerate(inline_decoded["records"]):
        meta = rec["meta"]
        if meta["type"] == "resource":
            pending.append({"hash": meta["hash"], "bytes": meta["bytes"], "record_index": i})
        elif meta["type"] == "transaction":
            next_seq = meta["seq"]
            for p in pending:
                inline_resources.append(dict(p, before_seq=next_seq))
            pending = []
    assert not pending and len(inline_resources) == len(inline_payloads)

    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt_rs11 = bytearray(patch_rs11)
    assert corrupt_rs11[seq3_offset + 8] == ord("{")
    corrupt_rs11[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()
    dynamic_bodies = [
        {"file": "payloads/mesh1-dyn.body", "source": "mesh1-b moved right by 1",
         "sha256": hashlib.sha256(body_of(MESH1_DYN_PAYLOAD)).hexdigest(),
         "bytes": len(body_of(MESH1_DYN_PAYLOAD))},
        {"file": "payloads/mesh1-tri.body", "source": "textured triangle",
         "sha256": hashlib.sha256(body_of(MESH1_TRI_PAYLOAD)).hexdigest(),
         "bytes": len(body_of(MESH1_TRI_PAYLOAD))},
        {"file": "payloads/mesh2-tri.body", "source": "mesh1-a moved down by 20",
         "sha256": hashlib.sha256(body_of(MESH2_TRI_PAYLOAD)).hexdigest(),
         "bytes": len(body_of(MESH2_TRI_PAYLOAD))},
    ]
    index = {
        "schema": "render-stream-11-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs11", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs11).hexdigest()},
            {"file": "patch.rs11", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs11).hexdigest()},
            {"file": "inline.rs11", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs11).hexdigest()},
        ],
        "resolved": "resolved.json",
        "inline_resources": inline_resources,
        "names": [{"seq": i + 1, "names": names(s)} for i, s in enumerate(STATES)],
        "dynamic_bodies": dynamic_bodies,
        "corrupt": [
            {"file": "corrupt-meta.rs11", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs11 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs{version}", "code": code, "version": version,
             "description": description}
            for name, (_, code, description, version) in invalid.items()
        ],
        "control": {
            "valid": [f"control/valid/{name}.json" for name in control["valid"]],
            "invalid": [f"control/invalid/{name}.json" for name in control["invalid"]],
        },
    }
    outputs: dict[str, bytes] = {
        "full.rs11": full_rs11, "full.hex": g6.to_hex(full_rs11).encode("ascii"),
        "full.decoded.json": g6.pretty(full_decoded),
        "patch.rs11": patch_rs11, "patch.hex": g6.to_hex(patch_rs11).encode("ascii"),
        "patch.decoded.json": g6.pretty(patch_decoded),
        "inline.rs11": inline_rs11, "inline.hex": g6.to_hex(inline_rs11).encode("ascii"),
        "inline.decoded.json": g6.pretty(inline_decoded),
        "resolved.json": g6.pretty(resolved),
        "corrupt-meta.rs11": bytes(corrupt_rs11),
        "index.json": g6.pretty(index),
        "payloads/mesh1-dyn.body": body_of(MESH1_DYN_PAYLOAD),
        "payloads/mesh1-tri.body": body_of(MESH1_TRI_PAYLOAD),
        "payloads/mesh2-tri.body": body_of(MESH2_TRI_PAYLOAD),
    }
    for name, (data, _, _, version) in invalid.items():
        outputs[f"invalid/{name}.rs{version}"] = data
    for kind in ("valid", "invalid"):
        for name, msg in control[kind].items():
            outputs[f"control/{kind}/{name}.json"] = g6.pretty(msg)
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="verify committed outputs; write nothing")
    args = parser.parse_args()
    outputs = build()
    if args.check:
        bad = []
        for rel, data in outputs.items():
            path = HERE / rel
            if not path.is_file() or path.read_bytes() != data:
                bad.append(rel)
        if bad:
            print("make_golden: out of date: " + ", ".join(bad), file=sys.stderr)
            return 1
        print(f"make_golden: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"make_golden: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
