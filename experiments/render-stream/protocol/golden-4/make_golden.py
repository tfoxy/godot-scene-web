#!/usr/bin/env python3
"""Generate the render-stream/4 golden vectors (stdlib only, deterministic).

render-stream/4 (../render-stream-4.md) is render-stream/3 (../render-stream-3.md) plus eleven new
draw/state commands, a new `i32` block (`cmd_i32`), a mesh table (`meshes`/`removed_meshes`) with
its own `mesh_f32` transaction block, and a new mesh payload format (`render-stream-mesh/1`,
`GRM1`). Exactly as G4e1 did for /3, this script re-derives /3's seven states byte for byte (same
scene, same items/textures/commands, just re-encoded under the GRS4 magic and the
"render-stream/4" protocol string) and then adds four more:

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

    8  (new) item 7 appears (draw_index 6), drawing one of every new IMMEDIATE op in sequence:
       add_line, add_polyline (a hold-last two-colour list on four points), add_multiline (two
       segments), add_circle (antialiased), add_primitive (a triangle), add_polygon (a textured
       quad, against texture 7, "the page"), add_triangle_array (two triangles sharing four
       vertices, count 3 so only the first triangle draws), add_set_transform (a translation),
       add_nine_patch (tile_fit on both axes, against texture 7), add_clip_ignore (true then
       false). No mesh ops: those start at state 9.
    9  (new) two meshes: mesh 1 (two surfaces: a coloured triangle, a textured quad against
       texture 7) and mesh 2 (one surface: a coloured quad). Item 8 (new) draws mesh 1 with
       add_mesh, textured.
    10 (new) relative to state 9: ONLY mesh 2's surface changes (a new payload, same shape,
       version 2) -- no item changes at all, proving gate5-design.md's "a mesh version change
       with no item change" (the patch stream's seq 10 carries nothing but that one mesh entry).
    11 (new) relative to state 10: mesh 1 is freed with a surviving reference (item 8's add_mesh
       command still names it, unchanged -- a "freed" tombstone); item 9 (new) draws mesh 3,
       created in this same state as an "unsupported" (mesh-format) entry, producing the derived
       unsupported-mesh item-level entry; item 10 (new) draws add_mesh naming mesh id 999, which
       the capture never saw, becoming unsupported/unknown-mesh with its derived entry.

As built (G5w): gate5-design.md's Q4 describes this as three new states (8, 9, 10), with state 9
covering both the mesh-creation content AND "a mesh version change with no item change". Splitting
that into two states (9 and 10, with the freed/unsupported/unknown-mesh content moved to a new
state 11) keeps each proof point byte-isolated: state 9->10's patch is observably nothing but one
mesh entry changing, never conflated with an item or another mesh's status flipping to "freed" or
"unsupported" in the same transaction.

full.rs4 encodes all eleven states as full transactions, directory (out-of-band) delivery.
patch.rs4 encodes the same eleven states patch-encoded (seq 6 full again, as after a resync, as
/2's and /3's goldens already do; every other seq patch-encoded against its predecessor).
inline.rs4 encodes all eleven as full transactions again, but with inline delivery: a resource
record for each hash (four GRT1 payloads from /2's scene, the GRT1 "page" from /3, and every GRM1
mesh-surface payload new at /4) precedes the first transaction whose resolved table needs it. All
three resolve to the same resolved.json (stream_id and per-transaction "encoding" excepted, as
every earlier golden -- memory: rs1-resolved-json-excepted-fields).

invalid/ vectors cover exactly the new failure modes render-stream-4.md's "Golden vectors" section
lists (every code /2's and /3's own vectors already cover for an unchanged rule is not re-derived
here): a GRS3 stream (bad-magic), an add_line whose declared "f" is wrong (cmd-offset), an
add_triangle_array whose "i" is wrong (cmd-int-offset), an "ok" mesh entry with a non-null reason
(mesh-entry), an add_mesh naming an absent mesh id (mesh-ref), a mesh whose version decreases
(mesh-version), a mesh entry's "f" disagreeing with the running mesh_f32 offset (mesh-offset), an
unsupported add_mesh with no derived unsupported-mesh entry (unsupported-mismatch), a patch both
removing and listing a mesh (patch-removed), an i32 block declared in the mesh_f32 slot
(meta-schema), and a GRM1 payload whose meta disagrees with its mesh-table entry (resource-payload).
payload-invalid/ gains one GRM1 vector per payload code (payload-magic, payload-meta,
payload-length, payload-size), alongside golden-2's four GRT1 vectors (reused, unaffected by /4).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MAGIC = bytes([0x47, 0x52, 0x53, 0x34, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS4\r\n\x1a\n"
MAGIC_RS3 = bytes([0x47, 0x52, 0x53, 0x33, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS3\r\n\x1a\n"
GRT1_MAGIC = bytes([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRT1\r\n\x1a\n"
GRM1_MAGIC = bytes([0x47, 0x52, 0x4D, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRM1\r\n\x1a\n"
PROTOCOL = "render-stream/4"
PAYLOAD_SCHEMA = "render-stream-texture/1"
MESH_PAYLOAD_SCHEMA = "render-stream-mesh/1"

ITEM_FLOATS = 18  # xform 6, modulate 4, self_modulate 4, custom_rect 4 -- unchanged from /2
CANVAS_FLOATS = 6  # xform 6 -- unchanged from /2
MESH_AABB_FLOATS = 6  # position xyz, size xyz (render-stream-4.md "Mesh table")

# Fixed per-command float counts (render-stream-4.md "Command"). Variable-length ops
# (add_polyline/add_multiline/add_primitive/add_polygon/add_triangle_array) are computed from
# their own points/colors/uvs lists in _command_json() instead.
CMD_FLOATS_FIXED = {
    "add_rect": 8,
    "add_texture_rect": 8,
    "add_texture_rect_region": 12,
    "add_msdf_texture_rect_region": 14,
    "add_line": 9,
    "add_circle": 7,
    "add_nine_patch": 16,
    "add_mesh": 10,
    "add_set_transform": 6,
    "add_clip_ignore": 0,
    "unsupported": 0,
}

PIXEL_SIZES = {"L8": 1, "LA8": 2, "R8": 1, "RG8": 2, "RGB8": 3, "RGBA8": 4}
PERMITTED_FORMATS = sorted(PIXEL_SIZES)

FILTERS = ["default", "nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
           "nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic"]
REPEATS = ["default", "disabled", "enabled", "mirror"]

# render-stream-4.md Q1e-equivalent ARRAY_FORMAT_* bits this codec needs to compute a GRM1
# payload's expected buffer sizes. Carried as plain ints, never as a Mesh.ArrayFormat enum.
ARRAY_FORMAT_COLOR = 1 << 3
ARRAY_FORMAT_TEX_UV = 1 << 4
ARRAY_FORMAT_BONES = 1 << 10
ARRAY_FORMAT_WEIGHTS = 1 << 11
ARRAY_FORMAT_INDEX = 1 << 12
ARRAY_FLAG_USE_2D_VERTICES = 1 << 25
ARRAY_FLAG_USE_8_BONE_WEIGHTS = 1 << 27
ARRAY_FLAG_COMPRESS_ATTRIBUTES = 1 << 29

# Carried over verbatim from protocol/golden-3/make_golden.py: illustrative session data, not the
# production calibrator roster (G5w touches no hook or mirror file).
HOOKS_PLANNED = sorted(
    [
        "canvas_create", "canvas_item_add_circle", "canvas_item_add_line", "canvas_item_add_mesh",
        "canvas_item_add_msdf_texture_rect_region", "canvas_item_add_multimesh",
        "canvas_item_add_nine_patch", "canvas_item_add_polygon", "canvas_item_add_polyline",
        "canvas_item_add_primitive", "canvas_item_add_rect", "canvas_item_add_set_transform",
        "canvas_item_add_texture_rect", "canvas_item_add_texture_rect_region",
        "canvas_item_add_triangle_array", "canvas_item_clear", "canvas_item_create",
        "canvas_item_set_clip", "canvas_item_set_custom_rect", "canvas_item_set_draw_index",
        "canvas_item_set_material", "canvas_item_set_modulate", "canvas_item_set_parent",
        "canvas_item_set_self_modulate", "canvas_item_set_transform",
        "canvas_item_set_visibility_layer", "canvas_item_set_visible", "canvas_item_set_z_index",
        "free", "material_set_param", "mesh_add_surface", "mesh_clear", "mesh_create",
        "mesh_set_custom_aabb", "mesh_surface_update_attribute_region",
        "mesh_surface_update_vertex_region", "shader_create_from_code", "shader_set_code",
        "texture_2d_create", "texture_2d_update", "viewport_attach_canvas",
        "viewport_set_canvas_transform",
    ]
)

# render-stream-4.md "Features": /3's four ops plus the eleven new ones, fifteen total.
FEATURE_OPS = sorted([
    "add_rect", "add_texture_rect", "add_texture_rect_region", "add_msdf_texture_rect_region",
    "add_line", "add_polyline", "add_multiline", "add_circle", "add_primitive", "add_polygon",
    "add_triangle_array", "add_nine_patch", "add_mesh", "add_set_transform", "add_clip_ignore",
])
FEATURE_ITEM_STATE = sorted(
    [
        "children", "clip", "custom_rect", "draw_index", "modulate", "parent", "self_modulate",
        "transform", "visibility_layer", "visible", "z_index", "behind", "z_relative",
        "texture_filter", "texture_repeat",
    ]
)
FEATURE_RESOURCES = sorted(["texture_2d", "texture_2d_placeholder", "mesh"])
FEATURE_UNSUPPORTED_RESOURCES = []
# /3's observed_unsupported_ops minus the ten that became ops this version, keeping
# canvas_item_add_lcd_texture_rect_region/canvas_item_add_multimesh/canvas_item_set_material and
# gaining three calibrator-7 slots that stay refused (render-stream-4.md "Features").
FEATURE_OBSERVED_UNSUPPORTED_OPS = sorted(
    [
        "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
        "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
        "canvas_item_set_material",
    ]
)
# /3's list plus the two viewport snap settings (gate3-design.md "Deferred").
FEATURE_UNOBSERVED = sorted(
    [
        "canvas_item_set_canvas_group_mode",
        "canvas_item_set_instance_shader_parameter", "canvas_item_set_light_mask",
        "canvas_item_set_sort_children_by_y", "canvas_item_set_visibility_notifier",
        "canvas_set_modulate", "canvas_texture_set_shading_parameters",
        "texture_set_size_override", "viewport_remove_canvas", "viewport_set_canvas_cull_mask",
        "viewport_set_global_canvas_transform", "viewport_set_snap_2d_transforms_to_pixel",
        "viewport_set_snap_2d_vertices_to_pixel",
    ]
)
PUBLICATION = "snapshot-or-patch"

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]


# --------------------------------------------------------------------------- encoding (framing)
# Framing, canonical JSON and the u8 block type are unchanged from /2 and /3. The i32 block is new
# at /4 (render-stream-4.md "Block type i32"): same four-byte little-endian width as f32, signed.


def u32(value: int) -> bytes:
    assert 0 <= value <= 0xFFFFFFFF
    return struct.pack("<I", value)


def i32(value: int) -> bytes:
    assert -0x80000000 <= value <= 0x7FFFFFFF
    return struct.pack("<i", value)


def f32s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        packed = struct.pack("<f", value)
        assert struct.unpack("<f", packed)[0] == value, value
        out += packed
    return bytes(out)


def i32s(values: list[int]) -> bytes:
    out = bytearray()
    for value in values:
        out += i32(value)
    return bytes(out)


def f32_pattern(values: list[float]) -> list[bytes]:
    return [struct.pack("<f", v) for v in values]


def canonical_json(obj: object) -> bytes:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    raw = text.encode("ascii")
    assert all(0x20 <= b <= 0x7E for b in raw), "meta must be printable ASCII"
    return raw


def f32block(name: str, values: list[float]) -> tuple[str, str, list[float]]:
    return (name, "f32", values)


def i32block(name: str, values: list[int]) -> tuple[str, str, list[int]]:
    return (name, "i32", values)


def u8block(name: str, payload: bytes) -> tuple[str, str, bytes]:
    return (name, "u8", payload)


def encode_record(
    meta: dict, blocks: list[tuple[str, str, object]], short_block: str | None = None
) -> bytes:
    full = dict(meta)
    descriptors = []
    payloads: list[bytes] = []
    for name, btype, values in blocks:
        if btype == "f32":
            payload = f32s(values)  # type: ignore[arg-type]
            count = len(values)  # type: ignore[arg-type]
        elif btype == "i32":
            payload = i32s(values)  # type: ignore[arg-type]
            count = len(values)  # type: ignore[arg-type]
        else:
            assert btype == "u8"
            payload = bytes(values)  # type: ignore[arg-type]
            count = len(payload)
        if name == short_block:
            payload = payload[: len(payload) - (4 if btype in ("f32", "i32") else 1)]
        descriptors.append({"name": name, "type": btype, "count": count})
        payloads.append(payload)
    full["blocks"] = descriptors
    meta_raw = canonical_json(full)
    body = bytearray()
    body += u32(len(meta_raw))
    body += meta_raw
    body += u32(len(payloads))
    for payload in payloads:
        body += u32(len(payload))
        body += payload
    return u32(len(body)) + bytes(body)


# --------------------------------------------------------------------------- texture payload (GRT1)


def mip_chain_dims(width: int, height: int, mipmaps: bool) -> list[tuple[int, int]]:
    dims = [(width, height)]
    if mipmaps:
        w, h = width, height
        while w > 1 or h > 1:
            w = max(1, w // 2)
            h = max(1, h // 2)
            dims.append((w, h))
    return dims


def expected_data_bytes(fmt: str, width: int, height: int, mipmaps: bool) -> int:
    pixel_size = PIXEL_SIZES[fmt]
    return pixel_size * sum(w * h for w, h in mip_chain_dims(width, height, mipmaps))


def build_payload(fmt: str, width: int, height: int, mipmaps: bool, data: bytes) -> bytes:
    meta = {
        "type": "texture-2d",
        "format": fmt,
        "width": width,
        "height": height,
        "mipmaps": mipmaps,
        "data_bytes": len(data),
    }
    meta_raw = canonical_json(meta)
    return GRT1_MAGIC + u32(len(meta_raw)) + meta_raw + u32(len(data)) + data


def payload_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def quadrant_rgba8(width: int, height: int, tl, tr, bl, br) -> bytes:
    out = bytearray()
    for y in range(height):
        for x in range(width):
            color = (tl if x < width // 2 and y < height // 2 else
                     tr if x >= width // 2 and y < height // 2 else
                     bl if x < width // 2 else br)
            out += bytes(color)
    return bytes(out)


def checker_la8(width: int, height: int, on=(255, 255), off=(0, 0)) -> bytes:
    out = bytearray()
    for y in range(height):
        for x in range(width):
            out += bytes(on if (x + y) % 2 == 0 else off)
    return bytes(out)


def mip_pattern_rgba8(width: int, height: int, mipmaps: bool) -> bytes:
    out = bytearray()
    for level, (w, h) in enumerate(mip_chain_dims(width, height, mipmaps)):
        for y in range(h):
            for x in range(w):
                out += bytes(((level * 40 + x * 7 + y * 13) % 256, (level * 23 + x) % 256,
                              (level * 59 + y) % 256, 255))
    return bytes(out)


# Payloads #1-5: verbatim from golden-3 (A/Atwin's content, A's state-3 update, F, P's
# replacement, "the page"). No new GRT1 payload at /4 -- every new resource is a GRM1 mesh surface.
PAYLOAD_A1 = build_payload("RGBA8", 16, 16,
                            False, quadrant_rgba8(16, 16, (255, 0, 0, 255), (0, 255, 0, 255),
                                                   (0, 0, 255, 255), (255, 255, 0, 255)))
PAYLOAD_A2 = build_payload("RGBA8", 16, 16,
                            False, quadrant_rgba8(16, 16, (0, 255, 255, 255), (255, 0, 255, 255),
                                                   (255, 255, 255, 255), (0, 0, 0, 255)))
PAYLOAD_F = build_payload("LA8", 4, 4, False, checker_la8(4, 4))
PAYLOAD_P = build_payload("RGBA8", 8, 8, True, mip_pattern_rgba8(8, 8, True))
PAYLOAD_PAGE = build_payload("RGBA8", 16, 16,
                              False, quadrant_rgba8(16, 16, (255, 0, 255, 255), (0, 255, 255, 255),
                                                     (255, 255, 0, 255), (0, 0, 0, 255)))

HASH_A1 = payload_sha256(PAYLOAD_A1)
HASH_A2 = payload_sha256(PAYLOAD_A2)
HASH_F = payload_sha256(PAYLOAD_F)
HASH_P = payload_sha256(PAYLOAD_P)
HASH_PAGE = payload_sha256(PAYLOAD_PAGE)


def resource_record_bytes(hash_hex: str, payload: bytes) -> bytes:
    meta = {"type": "resource", "hash": hash_hex, "bytes": len(payload)}
    return encode_record(meta, [u8block("payload", payload)])


# --------------------------------------------------------------------------- mesh payload (GRM1)


def build_mesh_payload(
    primitive: str, format_bits: int, vertex_count: int, index_count: int,
    vertex_data: bytes, attribute_data: bytes, skin_data: bytes, index_data: bytes,
    aabb: list[float], uv_scale: list[float],
) -> bytes:
    """render-stream-4.md "Mesh payload": magic, meta, 40-byte geometry block, then the four
    buffers concatenated. Each buffer's own length lives in meta; there is no separate data_len
    the way GRT1 has one, since the four *_bytes fields already pin the data section's length."""
    meta = {
        "type": "mesh-surface",
        "primitive": primitive,
        "format": format_bits,
        "vertex_count": vertex_count,
        "index_count": index_count,
        "vertex_bytes": len(vertex_data),
        "attribute_bytes": len(attribute_data),
        "skin_bytes": len(skin_data),
        "index_bytes": len(index_data),
    }
    meta_raw = canonical_json(meta)
    assert len(aabb) == 6 and len(uv_scale) == 4
    geometry = f32s(aabb + uv_scale)
    assert len(geometry) == 40
    return (GRM1_MAGIC + u32(len(meta_raw)) + meta_raw + geometry
            + vertex_data + attribute_data + skin_data + index_data)


def mesh_payload_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def positions_f32(points: list[tuple[float, float]]) -> bytes:
    out = bytearray()
    for x, y in points:
        out += f32s([x, y])
    return bytes(out)


def colors_rgba8(colors: list[tuple[int, int, int, int]]) -> bytes:
    out = bytearray()
    for c in colors:
        out += bytes(c)
    return bytes(out)


def uvs_f32(uvs: list[tuple[float, float]]) -> bytes:
    out = bytearray()
    for u, v in uvs:
        out += f32s([u, v])
    return bytes(out)


def indices_u16(indices: list[int]) -> bytes:
    out = bytearray()
    for i in indices:
        out += struct.pack("<H", i)
    return bytes(out)


# Mesh 1, surface A: a coloured triangle, no UVs, no index (render-stream-4.md "state 9").
MESH1_SURFACE_A_FORMAT = ARRAY_FORMAT_COLOR | ARRAY_FLAG_USE_2D_VERTICES
MESH1_SURFACE_A_VERTS = [(0.0, 0.0), (16.0, 0.0), (0.0, 16.0)]
MESH1_SURFACE_A_COLORS = [(255, 102, 0, 255), (255, 102, 0, 255), (255, 102, 0, 255)]
MESH1_SURFACE_A_PAYLOAD = build_mesh_payload(
    "triangles", MESH1_SURFACE_A_FORMAT, 3, 0,
    positions_f32(MESH1_SURFACE_A_VERTS), colors_rgba8(MESH1_SURFACE_A_COLORS), b"", b"",
    [0.0, 0.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
HASH_MESH1_A = mesh_payload_sha256(MESH1_SURFACE_A_PAYLOAD)

# Mesh 1, surface B: a textured quad (two triangles), against texture 7 ("the page").
MESH1_SURFACE_B_FORMAT = ARRAY_FORMAT_TEX_UV | ARRAY_FORMAT_INDEX | ARRAY_FLAG_USE_2D_VERTICES
MESH1_SURFACE_B_VERTS = [(0.0, 0.0), (16.0, 0.0), (16.0, 16.0), (0.0, 16.0)]
MESH1_SURFACE_B_UVS = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
MESH1_SURFACE_B_INDICES = [0, 1, 2, 0, 2, 3]
MESH1_SURFACE_B_PAYLOAD = build_mesh_payload(
    "triangles", MESH1_SURFACE_B_FORMAT, 4, 6,
    positions_f32(MESH1_SURFACE_B_VERTS), uvs_f32(MESH1_SURFACE_B_UVS), b"",
    indices_u16(MESH1_SURFACE_B_INDICES),
    [0.0, 0.0, 0.0, 16.0, 16.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
HASH_MESH1_B = mesh_payload_sha256(MESH1_SURFACE_B_PAYLOAD)

# Mesh 2, one surface: a coloured quad (version 1, replaced wholesale at state 10).
MESH2_SURFACE_FORMAT = ARRAY_FORMAT_COLOR | ARRAY_FORMAT_INDEX | ARRAY_FLAG_USE_2D_VERTICES
MESH2_SURFACE_V1_VERTS = [(0.0, 0.0), (12.0, 0.0), (12.0, 12.0), (0.0, 12.0)]
MESH2_SURFACE_V1_COLORS = [(51, 153, 102, 255)] * 4
MESH2_SURFACE_V1_INDICES = [0, 1, 2, 0, 2, 3]
MESH2_SURFACE_V1_PAYLOAD = build_mesh_payload(
    "triangles", MESH2_SURFACE_FORMAT, 4, 6,
    positions_f32(MESH2_SURFACE_V1_VERTS), colors_rgba8(MESH2_SURFACE_V1_COLORS), b"",
    indices_u16(MESH2_SURFACE_V1_INDICES),
    [0.0, 0.0, 0.0, 12.0, 12.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
HASH_MESH2_V1 = mesh_payload_sha256(MESH2_SURFACE_V1_PAYLOAD)

# state 10: mesh 2's surface is wholly replaced (new vertex positions and colours; same shape).
MESH2_SURFACE_V2_VERTS = [(2.0, 2.0), (14.0, 2.0), (14.0, 14.0), (2.0, 14.0)]
MESH2_SURFACE_V2_COLORS = [(204, 51, 51, 255)] * 4
MESH2_SURFACE_V2_PAYLOAD = build_mesh_payload(
    "triangles", MESH2_SURFACE_FORMAT, 4, 6,
    positions_f32(MESH2_SURFACE_V2_VERTS), colors_rgba8(MESH2_SURFACE_V2_COLORS), b"",
    indices_u16(MESH2_SURFACE_V1_INDICES),
    [2.0, 2.0, 0.0, 12.0, 12.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
HASH_MESH2_V2 = mesh_payload_sha256(MESH2_SURFACE_V2_PAYLOAD)


# --------------------------------------------------------------------------- session


def session_record(
    stream_id: str,
    transport: str,
    encoding: str,
    session_id: str,
    *,
    delivery: str,
    host_size_status: str = "match",
) -> bytes:
    if delivery == "out-of-band":
        resources = {
            "hash": "sha256", "payloads": sorted([MESH_PAYLOAD_SCHEMA, PAYLOAD_SCHEMA]),
            "delivery": "out-of-band", "inline_max_bytes": 0, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "directory", "http_path": None,
            "auth": "none",
        }
    else:
        assert delivery == "inline"
        resources = {
            "hash": "sha256", "payloads": sorted([MESH_PAYLOAD_SCHEMA, PAYLOAD_SCHEMA]),
            "delivery": "inline", "inline_max_bytes": 16777216, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "none", "http_path": None,
            "auth": "none",
        }
    meta = {
        "type": "session",
        "protocol": PROTOCOL,
        "session_id": session_id,
        "stream": {
            "stream_id": stream_id,
            "connection": None,
            "transport": transport,
            "encoding": encoding,
        },
        "engine": {
            "version_string": "Godot Engine v4.5.1.stable.official",
            "sha256": "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c",
            "display_server": "headless",
            "rendering_driver": "opengl3",
            "rendering_method": "gl_compatibility",
        },
        "capture": {
            "calibrator_version": 3,
            "hooks_planned": HOOKS_PLANNED,
            "hooks_omitted": [],
        },
        "viewport": {
            "canvas_cull_mask": 4294967295,
            "root_canvas": 1,
            "logical_size": [640, 360],
            "stretch": {"mode": "disabled", "aspect": "ignore", "scale_mode": "fractional"},
            "stretch_applied_by": "receiver",
            "root_size_policy": "observe",
            "host_size_status": host_size_status,
            "host_window_size": [640, 360],
        },
        "resources": resources,
        "features": {
            "ops": FEATURE_OPS,
            "item_state": FEATURE_ITEM_STATE,
            "resources": FEATURE_RESOURCES,
            "unsupported_resources": FEATURE_UNSUPPORTED_RESOURCES,
            "observed_unsupported_ops": FEATURE_OBSERVED_UNSUPPORTED_OPS,
            "unobserved": FEATURE_UNOBSERVED,
            "publication": PUBLICATION,
        },
        "sabotage": None,
    }
    blocks = [
        f32block("clear_color", [0.25, 0.25, 0.5, 1.0]),
        f32block("root_canvas_xform", IDENTITY),
        f32block("host_visible_rect", [0.0, 0.0, 640.0, 360.0]),
        f32block("host_final_xform", IDENTITY),
        f32block("content_scale_factor", [1.0]),
    ]
    return encode_record(meta, blocks)


# --------------------------------------------------------------------------- transaction model


def item_differs(a: dict, b: dict) -> bool:
    for key in ("parent", "children", "visible", "draw_index", "z_index", "z_relative", "behind",
                "clip", "custom_rect", "visibility_layer", "texture_filter", "texture_repeat",
                "content_version"):
        if a[key] != b[key]:
            return True
    for key in ("xform", "modulate", "self_modulate", "crect"):
        if f32_pattern(a[key]) != f32_pattern(b[key]):
            return True
    return False


def canvas_differs(a: dict, b: dict) -> bool:
    for key in ("origin", "role", "attached", "items"):
        if a[key] != b[key]:
            return True
    return f32_pattern(a["xform"]) != f32_pattern(b["xform"])


TEXTURE_FIELDS = ("kind", "status", "reason", "version", "hash", "format", "width", "height",
                   "mipmaps", "payload_bytes", "canvas")


def texture_differs(a: dict, b: dict) -> bool:
    return any(a[key] != b[key] for key in TEXTURE_FIELDS)


MESH_FIELDS = ("status", "reason", "version", "custom_aabb", "surfaces")


def mesh_differs(a: dict, b: dict) -> bool:
    for key in ("status", "reason", "version", "surfaces"):
        if a[key] != b[key]:
            return True
    return f32_pattern(a["custom_aabb"]) != f32_pattern(b["custom_aabb"])


def diff_state(base: dict, cur: dict):
    base_items, cur_items = base["items"], cur["items"]
    base_canvases, cur_canvases = base["canvases"], cur["canvases"]
    base_textures, cur_textures = base["textures"], cur["textures"]
    base_meshes, cur_meshes = base["meshes"], cur["meshes"]
    removed_items = sorted(set(base_items) - set(cur_items))
    removed_canvases = sorted(set(base_canvases) - set(cur_canvases))
    removed_textures = sorted(set(base_textures) - set(cur_textures))
    removed_meshes = sorted(set(base_meshes) - set(cur_meshes))
    items_out = []
    for item_id in sorted(cur_items):
        cur_item = cur_items[item_id]
        base_item = base_items.get(item_id)
        if base_item is not None and not item_differs(base_item, cur_item):
            continue
        commands_null = base_item is not None and base_item["content_version"] == cur_item["content_version"]
        items_out.append((item_id, cur_item, commands_null))
    canvases_out = []
    for canvas_id in sorted(cur_canvases):
        cur_canvas = cur_canvases[canvas_id]
        base_canvas = base_canvases.get(canvas_id)
        if base_canvas is not None and not canvas_differs(base_canvas, cur_canvas):
            continue
        canvases_out.append((canvas_id, cur_canvas))
    textures_out = []
    for texture_id in sorted(cur_textures):
        cur_texture = cur_textures[texture_id]
        base_texture = base_textures.get(texture_id)
        if base_texture is not None and not texture_differs(base_texture, cur_texture):
            continue
        textures_out.append((texture_id, cur_texture))
    meshes_out = []
    for mesh_id in sorted(cur_meshes):
        cur_mesh = cur_meshes[mesh_id]
        base_mesh = base_meshes.get(mesh_id)
        if base_mesh is not None and not mesh_differs(base_mesh, cur_mesh):
            continue
        meshes_out.append((mesh_id, cur_mesh))
    return (removed_canvases, removed_items, removed_textures, removed_meshes,
            canvases_out, items_out, textures_out, meshes_out)


def _command_json(command: dict, cmd_f32: list[float], cmd_i32: list[int]) -> dict:
    op = command["op"]
    if op == "add_rect":
        out = {"op": "add_rect", "aa": command["aa"], "f": len(cmd_f32)}
        cmd_f32 += command["rect"] + command["color"]
        return out
    if op == "add_texture_rect":
        out = {"op": "add_texture_rect", "tex": command["tex"], "tile": command["tile"],
               "transpose": command["transpose"], "f": len(cmd_f32)}
        cmd_f32 += command["rect"] + command["modulate"]
        return out
    if op == "add_texture_rect_region":
        out = {"op": "add_texture_rect_region", "tex": command["tex"],
               "transpose": command["transpose"], "clip_uv": command["clip_uv"],
               "f": len(cmd_f32)}
        cmd_f32 += command["rect"] + command["src"] + command["modulate"]
        return out
    if op == "add_msdf_texture_rect_region":
        out = {"op": "add_msdf_texture_rect_region", "tex": command["tex"],
               "outline": command["outline"], "f": len(cmd_f32)}
        cmd_f32 += (command["rect"] + command["src"] + command["modulate"]
                    + [command["px_range"], command["scale"]])
        return out
    if op == "add_line":
        out = {"op": "add_line", "aa": command["aa"], "f": len(cmd_f32)}
        cmd_f32 += command["from"] + command["to"] + command["color"] + [command["width"]]
        return out
    if op in ("add_polyline", "add_multiline"):
        points: list[list[float]] = command["points"]
        colors: list[list[float]] = command["colors"]
        out = {"op": op, "aa": command["aa"], "n": len(points), "colors": len(colors),
               "f": len(cmd_f32)}
        cmd_f32.append(command["width"])
        for p in points:
            cmd_f32 += p
        for c in colors:
            cmd_f32 += c
        return out
    if op == "add_circle":
        out = {"op": "add_circle", "aa": command["aa"], "f": len(cmd_f32)}
        cmd_f32 += command["position"] + [command["radius"]] + command["color"]
        return out
    if op in ("add_primitive", "add_polygon"):
        points = command["points"]
        colors = command["colors"]
        uvs: list[list[float]] = command["uvs"]
        out = {"op": op, "tex": command["tex"], "n": len(points), "colors": len(colors),
               "uvs": len(uvs), "f": len(cmd_f32)}
        for p in points:
            cmd_f32 += p
        for c in colors:
            cmd_f32 += c
        for uv in uvs:
            cmd_f32 += uv
        return out
    if op == "add_triangle_array":
        points = command["points"]
        colors = command["colors"]
        uvs = command["uvs"]
        indices: list[int] = command["indices"]
        out = {"op": "add_triangle_array", "tex": command["tex"], "n": len(points),
               "colors": len(colors), "uvs": len(uvs), "indices": len(indices),
               "count": command["count"], "i": len(cmd_i32), "f": len(cmd_f32)}
        for p in points:
            cmd_f32 += p
        for c in colors:
            cmd_f32 += c
        for uv in uvs:
            cmd_f32 += uv
        cmd_i32 += indices
        return out
    if op == "add_nine_patch":
        out = {"op": "add_nine_patch", "tex": command["tex"], "x_axis": command["x_axis"],
               "y_axis": command["y_axis"], "draw_center": command["draw_center"],
               "f": len(cmd_f32)}
        cmd_f32 += (command["rect"] + command["source"] + command["margin_tl"]
                    + command["margin_br"] + command["modulate"])
        return out
    if op == "add_mesh":
        out = {"op": "add_mesh", "mesh": command["mesh"], "tex": command["tex"], "f": len(cmd_f32)}
        cmd_f32 += command["transform"] + command["modulate"]
        return out
    if op == "add_set_transform":
        out = {"op": "add_set_transform", "f": len(cmd_f32)}
        cmd_f32 += command["transform"]
        return out
    if op == "add_clip_ignore":
        return {"op": "add_clip_ignore", "ignore": command["ignore"]}
    assert op == "unsupported"
    return {"op": "unsupported", "name": command["name"], "reason": command["reason"]}


def _texture_json(texture_id: int, t: dict) -> dict:
    canvas = t["canvas"]
    return {
        "id": texture_id,
        "origin": "created",
        "kind": t["kind"],
        "status": t["status"],
        "reason": t["reason"],
        "version": t["version"],
        "hash": t["hash"],
        "format": t["format"],
        "width": t["width"],
        "height": t["height"],
        "mipmaps": t["mipmaps"],
        "payload_bytes": t["payload_bytes"],
        "canvas": None if canvas is None else {
            "diffuse": canvas["diffuse"], "filter": canvas["filter"], "repeat": canvas["repeat"],
        },
    }


def _mesh_json(mesh_id: int, m: dict, mesh_f32: list[float]) -> dict:
    if m["status"] == "freed":
        f = None
    else:
        f = len(mesh_f32)
        mesh_f32 += m["custom_aabb"]
    surfaces_out = []
    if m["status"] == "ok":
        for s in m["surfaces"]:
            surfaces_out.append({
                "hash": s["hash"], "payload_bytes": s["payload_bytes"],
                "primitive": s["primitive"], "format": s["format"],
                "vertex_count": s["vertex_count"], "index_count": s["index_count"],
            })
    return {
        "id": mesh_id, "origin": "created", "status": m["status"], "reason": m["reason"],
        "version": m["version"], "f": f, "surfaces": surfaces_out,
    }


def transaction_bytes(
    seq: int,
    frame: int,
    encoding: str,
    base_seq: int | None,
    canvases: list[tuple[int, dict]],
    items: list[tuple[int, dict, bool]],
    textures: list[tuple[int, dict]],
    meshes: list[tuple[int, dict]],
    unsupported: list[dict],
    default_filter: str,
    default_repeat: str,
    *,
    failures: list[dict] | None = None,
    removed_canvases: list[int] | None = None,
    removed_items: list[int] | None = None,
    removed_textures: list[int] | None = None,
    removed_meshes: list[int] | None = None,
) -> bytes:
    failures = failures or []
    removed_canvases = removed_canvases or []
    removed_items = removed_items or []
    removed_textures = removed_textures or []
    removed_meshes = removed_meshes or []
    item_f32: list[float] = []
    canvas_f32: list[float] = []
    cmd_f32: list[float] = []
    cmd_i32: list[int] = []
    mesh_f32: list[float] = []
    items_json = []
    for item_id, item, commands_null in sorted(items, key=lambda t: t[0]):
        commands_json: list[dict] | None
        if commands_null:
            commands_json = None
        else:
            commands_json = [_command_json(c, cmd_f32, cmd_i32) for c in item["commands"]]
        parent = item["parent"]
        items_json.append({
            "id": item_id,
            "origin": item.get("origin", "created"),
            "parent": None if parent is None else {"kind": parent[0], "id": parent[1]},
            "children": item["children"],
            "visible": item["visible"],
            "draw_index": item["draw_index"],
            "z_index": item["z_index"],
            "z_relative": item["z_relative"],
            "behind": item["behind"],
            "clip": item["clip"],
            "custom_rect": item["custom_rect"],
            "visibility_layer": item["visibility_layer"],
            "texture_filter": item["texture_filter"],
            "texture_repeat": item["texture_repeat"],
            "content_version": item["content_version"],
            "commands": commands_json,
        })
        item_f32 += item["xform"] + item["modulate"] + item["self_modulate"] + item["crect"]
    canvases_json = []
    for canvas_id, canvas in sorted(canvases, key=lambda t: t[0]):
        canvases_json.append({
            "id": canvas_id,
            "origin": canvas.get("origin", "created"),
            "role": canvas["role"],
            "attached": canvas["attached"],
            "items": canvas["items"],
        })
        canvas_f32 += canvas["xform"]
    textures_json = [_texture_json(tid, t) for tid, t in sorted(textures, key=lambda t: t[0])]
    meshes_json = [_mesh_json(mid, m, mesh_f32) for mid, m in sorted(meshes, key=lambda t: t[0])]
    meta = {
        "type": "transaction",
        "seq": seq,
        "frame": frame,
        "encoding": encoding,
        "base_seq": base_seq,
        "status": "ok" if not failures else "capture-failure",
        "failures": failures,
        "unsupported": unsupported,
        "default_texture_filter": default_filter,
        "default_texture_repeat": default_repeat,
        "removed_canvases": removed_canvases,
        "removed_items": removed_items,
        "removed_textures": removed_textures,
        "removed_meshes": removed_meshes,
        "canvases": canvases_json,
        "items": items_json,
        "textures": textures_json,
        "meshes": meshes_json,
    }
    blocks = [f32block("item_f32", item_f32), f32block("canvas_f32", canvas_f32),
              f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
              f32block("mesh_f32", mesh_f32)]
    return encode_record(meta, blocks)


def full_transaction_bytes(seq: int, frame: int, state: dict) -> bytes:
    items = [(iid, state["items"][iid], False) for iid in sorted(state["items"])]
    canvases = [(cid, state["canvases"][cid]) for cid in sorted(state["canvases"])]
    textures = [(tid, state["textures"][tid]) for tid in sorted(state["textures"])]
    meshes = [(mid, state["meshes"][mid]) for mid in sorted(state["meshes"])]
    return transaction_bytes(
        seq, frame, "full", None, canvases, items, textures, meshes, state["unsupported"],
        state["default_filter"], state["default_repeat"], failures=state["failures"],
    )


def patch_transaction_bytes(seq: int, frame: int, base_seq: int, base: dict, cur: dict) -> bytes:
    (removed_canvases, removed_items, removed_textures, removed_meshes,
     canvases, items, textures, meshes) = diff_state(base, cur)
    return transaction_bytes(
        seq, frame, "patch", base_seq, canvases, items, textures, meshes, cur["unsupported"],
        cur["default_filter"], cur["default_repeat"], failures=cur["failures"],
        removed_canvases=removed_canvases, removed_items=removed_items,
        removed_textures=removed_textures, removed_meshes=removed_meshes,
    )


def end_record(
    transactions: int,
    before_end: list[bytes],
    *,
    diff_ns_total: int,
    full_transactions: int,
    patch_transactions: int,
    resource_records: int,
    resource_bytes: int,
) -> bytes:
    meta = {
        "type": "end",
        "transactions": transactions,
        "reason": "shutdown",
        "stats": {
            "bytes_total": len(MAGIC) + sum(len(r) for r in before_end),
            "encode_ns_total": 250000,
            "snapshot_ns_total": 40000,
            "diff_ns_total": diff_ns_total,
            "max_record_bytes": max(len(r) for r in before_end),
            "full_transactions": full_transactions,
            "patch_transactions": patch_transactions,
            "resource_records": resource_records,
            "resource_bytes": resource_bytes,
        },
    }
    return encode_record(meta, [])


def recording(records: list[bytes], with_end_record: bytes | None) -> bytes:
    out = MAGIC + b"".join(records)
    if with_end_record is not None:
        out += with_end_record
    return out


# --------------------------------------------------------------------------- the eleven golden states


def item(
    *,
    parent: tuple[str, int] | None,
    children: list[int],
    xform: list[float],
    modulate: list[float] = WHITE,
    self_modulate: list[float] = WHITE,
    visible: bool = True,
    draw_index: int = 0,
    z_index: int = 0,
    z_relative: bool = True,
    behind: bool = False,
    clip: bool = False,
    custom_rect: bool = False,
    crect: list[float] = NO_RECT,
    visibility_layer: int = 0xFFFFFFFF,
    texture_filter: str = "default",
    texture_repeat: str = "default",
    content_version: int,
    commands: list[dict],
) -> dict:
    return {
        "origin": "created", "parent": parent, "children": children, "xform": xform,
        "modulate": modulate, "self_modulate": self_modulate, "visible": visible,
        "draw_index": draw_index, "z_index": z_index, "z_relative": z_relative, "behind": behind,
        "clip": clip, "custom_rect": custom_rect, "crect": crect,
        "visibility_layer": visibility_layer, "texture_filter": texture_filter,
        "texture_repeat": texture_repeat, "content_version": content_version,
        "commands": commands,
    }


def add_rect(rect, color, *, aa=False) -> dict:
    return {"op": "add_rect", "aa": aa, "rect": rect, "color": color}


def add_texture_rect(tex, tile, transpose, rect, modulate=WHITE) -> dict:
    return {"op": "add_texture_rect", "tex": tex, "tile": tile, "transpose": transpose,
            "rect": rect, "modulate": modulate}


def add_texture_rect_region(tex, transpose, clip_uv, rect, src, modulate=WHITE) -> dict:
    return {"op": "add_texture_rect_region", "tex": tex, "transpose": transpose,
            "clip_uv": clip_uv, "rect": rect, "src": src, "modulate": modulate}


def add_msdf_texture_rect_region(tex, outline, rect, src, modulate=WHITE, px_range=24.0,
                                  scale=1.0) -> dict:
    return {"op": "add_msdf_texture_rect_region", "tex": tex, "outline": outline, "rect": rect,
            "src": src, "modulate": modulate, "px_range": px_range, "scale": scale}


def add_line(frm, to, color, width, *, aa=False) -> dict:
    return {"op": "add_line", "aa": aa, "from": list(frm), "to": list(to), "color": color,
            "width": width}


def add_polyline(points, colors, width, *, aa=False, multiline=False) -> dict:
    return {"op": "add_multiline" if multiline else "add_polyline", "aa": aa,
            "points": [list(p) for p in points], "colors": colors, "width": width}


def add_circle(position, radius, color, *, aa=False) -> dict:
    return {"op": "add_circle", "aa": aa, "position": list(position), "radius": radius,
            "color": color}


def add_primitive(points, colors, uvs, tex=None, *, polygon=False) -> dict:
    return {"op": "add_polygon" if polygon else "add_primitive", "tex": tex,
            "points": [list(p) for p in points], "colors": colors,
            "uvs": [list(uv) for uv in uvs]}


def add_triangle_array(points, colors, uvs, indices, count, tex=None) -> dict:
    return {"op": "add_triangle_array", "tex": tex, "points": [list(p) for p in points],
            "colors": colors, "uvs": [list(uv) for uv in uvs], "indices": list(indices),
            "count": count}


def add_nine_patch(rect, source, margin_tl, margin_br, x_axis, y_axis, draw_center, tex,
                    modulate=WHITE) -> dict:
    return {"op": "add_nine_patch", "tex": tex, "rect": rect, "source": source,
            "margin_tl": list(margin_tl), "margin_br": list(margin_br), "x_axis": x_axis,
            "y_axis": y_axis, "draw_center": draw_center, "modulate": modulate}


def add_mesh(mesh_id, transform, modulate=WHITE, tex=None) -> dict:
    return {"op": "add_mesh", "mesh": mesh_id, "tex": tex, "transform": transform,
            "modulate": modulate}


def add_set_transform(transform) -> dict:
    return {"op": "add_set_transform", "transform": transform}


def add_clip_ignore(ignore) -> dict:
    return {"op": "add_clip_ignore", "ignore": ignore}


def unsupported_cmd(name: str, reason: str) -> dict:
    return {"op": "unsupported", "name": name, "reason": reason}


def texture(
    *, kind: str, status: str = "ok", reason: str | None = None, version: int,
    hash: str | None = None, format: str | None = None, width: int = 0, height: int = 0,
    mipmaps: bool = False, payload_bytes: int = 0, canvas: dict | None = None,
) -> dict:
    return {"kind": kind, "status": status, "reason": reason, "version": version, "hash": hash,
            "format": format, "width": width, "height": height, "mipmaps": mipmaps,
            "payload_bytes": payload_bytes, "canvas": canvas}


def mesh(
    *, status: str = "ok", reason: str | None = None, version: int,
    custom_aabb: list[float] = NO_RECT + [0.0, 0.0], surfaces: list[dict] | None = None,
) -> dict:
    return {"status": status, "reason": reason, "version": version,
            "custom_aabb": list(custom_aabb), "surfaces": surfaces or []}


def mesh_surface(hash: str, payload_bytes: int, primitive: str, format: int, vertex_count: int,
                  index_count: int) -> dict:
    return {"hash": hash, "payload_bytes": payload_bytes, "primitive": primitive,
            "format": format, "vertex_count": vertex_count, "index_count": index_count}


def root_canvas(items_list: list[int]) -> dict:
    return {"origin": "root-query", "role": "root", "attached": True, "xform": IDENTITY,
            "items": items_list}


UNSUPPORTED_ITEM3 = {"op": "canvas_item_add_texture_rect", "item": 3, "reason": "unknown-texture"}
UNSUPPORTED_TEXTURE_ITEM5 = {"op": "canvas_item_add_texture_rect", "item": 5,
                             "reason": "unsupported-texture"}
UNSUPPORTED_MSDF_ITEM6 = {"op": "canvas_item_add_msdf_texture_rect_region", "item": 6,
                          "reason": "unknown-texture"}
BASE_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5]
STATE7_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5, UNSUPPORTED_MSDF_ITEM6]
# new at state 11: item 9's add_mesh names mesh 3 (unsupported, mesh-format); item 10's add_mesh
# names mesh id 999, which the capture never saw.
UNSUPPORTED_MESH_ITEM9 = {"op": "canvas_item_add_mesh", "item": 9, "reason": "unsupported-mesh"}
UNSUPPORTED_UNKNOWN_MESH_ITEM10 = {"op": "canvas_item_add_mesh", "item": 10,
                                   "reason": "unknown-mesh"}
STATE11_UNSUPPORTED = sorted(
    STATE7_UNSUPPORTED + [UNSUPPORTED_MESH_ITEM9, UNSUPPORTED_UNKNOWN_MESH_ITEM10],
    key=lambda u: (u["item"], u["op"]),
)


def _base_items() -> dict:
    return {
        1: item(
            parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
            texture_filter="linear", texture_repeat="enabled",
            commands=[add_texture_rect(1, True, True, [0.0, 0.0, 16.0, 16.0])],
        ),
        2: item(
            parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 20.0, 0.0],
            draw_index=1, content_version=1,
            commands=[add_texture_rect_region(1, True, True, [32.0, 0.0, -16.0, 16.0],
                                               [16.0, 0.0, -16.0, 16.0])],
        ),
        3: item(
            parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 40.0, 0.0],
            draw_index=2, content_version=1,
            commands=[unsupported_cmd("canvas_item_add_texture_rect", "unknown-texture")],
        ),
        4: item(
            parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 60.0, 0.0],
            draw_index=3, content_version=1,
            commands=[add_texture_rect(5, False, False, [0.0, 0.0, 4.0, 4.0])],
        ),
        5: item(
            parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 80.0, 0.0],
            draw_index=4, content_version=1,
            commands=[add_texture_rect(3, False, False, [0.0, 0.0, 4.0, 4.0])],
        ),
    }


def state1() -> dict:
    textures = {
        1: texture(kind="image", version=1, hash=HASH_A1, format="RGBA8", width=16, height=16,
                   payload_bytes=len(PAYLOAD_A1)),
        2: texture(kind="image", version=1, hash=HASH_A1, format="RGBA8", width=16, height=16,
                   payload_bytes=len(PAYLOAD_A1)),
        3: texture(kind="image", status="unsupported", reason="unsupported-format", version=1,
                   format="RGBAF", width=4, height=4),
        4: texture(kind="placeholder", version=1),
        5: texture(kind="image", version=1, hash=HASH_F, format="LA8", width=4, height=4,
                   payload_bytes=len(PAYLOAD_F)),
    }
    return {
        "items": _base_items(), "canvases": {1: root_canvas([1, 2, 3, 4, 5])},
        "textures": textures, "meshes": {}, "unsupported": list(BASE_UNSUPPORTED), "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }


def state2() -> dict:
    state = state1()
    state["items"] = dict(state["items"])
    moved = dict(state["items"][1])
    moved["xform"] = [1.0, 0.0, 0.0, 1.0, 8.0, 0.0]  # transform-only
    state["items"][1] = moved
    return state


def state3() -> dict:
    state = state2()
    state["textures"] = dict(state["textures"])
    updated = dict(state["textures"][1])
    updated["version"] = 2
    updated["hash"] = HASH_A2
    state["textures"][1] = updated
    return state


def state4() -> dict:
    state = state3()
    textures = dict(state["textures"])
    replaced = dict(textures[4])
    replaced["kind"] = "image"
    replaced["version"] = 2
    replaced["hash"] = HASH_P
    replaced["format"] = "RGBA8"
    replaced["width"] = 8
    replaced["height"] = 8
    replaced["mipmaps"] = True
    replaced["payload_bytes"] = len(PAYLOAD_P)
    textures[4] = replaced
    freed = dict(textures[5])
    freed["status"] = "freed"
    freed["hash"] = None
    freed["format"] = None
    freed["width"] = 0
    freed["height"] = 0
    freed["mipmaps"] = False
    freed["payload_bytes"] = 0
    textures[5] = freed
    textures[6] = texture(kind="image", version=1, hash=HASH_A1, format="RGBA8", width=16,
                          height=16, payload_bytes=len(PAYLOAD_A1))
    state["textures"] = textures
    state["default_filter"] = "linear"
    return state


def state5() -> dict:
    state = state4()
    items = dict(state["items"])
    cleared = dict(items[4])
    cleared["content_version"] = 2
    cleared["commands"] = [add_texture_rect(None, False, False, [0.0, 0.0, 4.0, 4.0])]
    items[4] = cleared
    state["items"] = items
    textures = dict(state["textures"])
    del textures[5]  # the tombstone's last reference is cleared: it leaves the table
    state["textures"] = textures
    return state


def state6() -> dict:
    return state5()  # unchanged; re-sent in full, as after a resync


def item6_msdf() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 100.0, 0.0],
        draw_index=5, content_version=1,
        commands=[
            add_msdf_texture_rect_region(7, 0, [100.0, 0.0, 24.0, 24.0], [0.0, 0.0, 48.0, 48.0],
                                          px_range=24.0, scale=0.5),
            add_msdf_texture_rect_region(7, 4, [140.0, 0.0, -24.0, 24.0],
                                          [48.0, 0.0, 48.0, 48.0], px_range=24.0, scale=0.5),
            unsupported_cmd("canvas_item_add_msdf_texture_rect_region", "unknown-texture"),
        ],
    )


def texture_page() -> dict:
    return texture(kind="image", version=1, hash=HASH_PAGE, format="RGBA8", width=16,
                   height=16, payload_bytes=len(PAYLOAD_PAGE))


def state7() -> dict:
    # /3's state 6 (frozen, unchanged) plus one new item and one new texture.
    state = state6()
    items = dict(state["items"])
    items[6] = item6_msdf()
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 3, 4, 5, 6])}
    textures = dict(state["textures"])
    textures[7] = texture_page()
    state["textures"] = textures
    state["unsupported"] = list(STATE7_UNSUPPORTED)
    return state


def item7_immediate_ops() -> dict:
    # new at /4, state 8: one of every new IMMEDIATE op (render-stream-4.md "Golden vectors").
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 120.0, 0.0],
        draw_index=6, content_version=1,
        commands=[
            add_line((0.0, 0.0), (10.0, 0.0), [1.0, 1.0, 1.0, 1.0], 1.0),
            add_polyline(
                [(0.0, 10.0), (10.0, 10.0), (10.0, 20.0), (0.0, 20.0)],
                [[1.0, 0.0, 0.0, 1.0], [0.0, 1.0, 0.0, 1.0]], 2.0,
            ),
            add_polyline(
                [(0.0, 30.0), (10.0, 30.0), (0.0, 40.0), (10.0, 40.0)],
                [[0.25, 0.25, 1.0, 1.0]], 1.0, multiline=True,
            ),
            add_circle((5.0, 50.0), 4.0, [0.25, 0.75, 1.0, 1.0], aa=True),
            add_primitive(
                [(0.0, 60.0), (10.0, 60.0), (0.0, 70.0)], [[1.0, 1.0, 0.25, 1.0]], [],
            ),
            add_primitive(
                [(0.0, 80.0), (10.0, 80.0), (10.0, 90.0), (0.0, 90.0)], [[1.0, 1.0, 1.0, 1.0]],
                [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)], tex=7, polygon=True,
            ),
            add_triangle_array(
                [(0.0, 100.0), (10.0, 100.0), (10.0, 110.0), (0.0, 110.0)],
                [[0.75, 1.0, 0.75, 1.0]], [], [0, 1, 2, 0, 2, 3], 3,
            ),
            add_set_transform([1.0, 0.0, 0.0, 1.0, 2.0, 2.0]),
            add_nine_patch(
                [0.0, 120.0, 16.0, 16.0], [0.0, 0.0, 16.0, 16.0], (4.0, 4.0), (4.0, 4.0),
                "tile_fit", "tile_fit", True, 7,
            ),
            add_clip_ignore(True),
            add_clip_ignore(False),
        ],
    )


def state8() -> dict:
    state = state7()
    items = dict(state["items"])
    items[7] = item7_immediate_ops()
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 3, 4, 5, 6, 7])}
    return state


def item8_mesh() -> dict:
    # new at state 9: draws mesh 1, textured against texture 7.
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 140.0, 0.0],
        draw_index=7, content_version=1,
        commands=[add_mesh(1, IDENTITY, tex=7)],
    )


def state9() -> dict:
    state = state8()
    items = dict(state["items"])
    items[8] = item8_mesh()
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 3, 4, 5, 6, 7, 8])}
    state["meshes"] = {
        1: mesh(version=1, surfaces=[
            mesh_surface(HASH_MESH1_A, len(MESH1_SURFACE_A_PAYLOAD), "triangles",
                         MESH1_SURFACE_A_FORMAT, 3, 0),
            mesh_surface(HASH_MESH1_B, len(MESH1_SURFACE_B_PAYLOAD), "triangles",
                         MESH1_SURFACE_B_FORMAT, 4, 6),
        ]),
        2: mesh(version=1, surfaces=[
            mesh_surface(HASH_MESH2_V1, len(MESH2_SURFACE_V1_PAYLOAD), "triangles",
                         MESH2_SURFACE_FORMAT, 4, 6),
        ]),
    }
    return state


def state10() -> dict:
    # new at state 10: ONLY mesh 2's surface changes (new payload, version 2). No item, canvas or
    # texture changes at all -- render-stream-4.md "a mesh version change with no item change".
    state = state9()
    meshes = dict(state["meshes"])
    meshes[2] = mesh(version=2, surfaces=[
        mesh_surface(HASH_MESH2_V2, len(MESH2_SURFACE_V2_PAYLOAD), "triangles",
                     MESH2_SURFACE_FORMAT, 4, 6),
    ])
    state["meshes"] = meshes
    return state


def item9_unsupported_mesh() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 160.0, 0.0],
        draw_index=8, content_version=1,
        commands=[add_mesh(3, IDENTITY)],
    )


def item10_unknown_mesh() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 180.0, 0.0],
        draw_index=9, content_version=1,
        commands=[unsupported_cmd("canvas_item_add_mesh", "unknown-mesh")],
    )


def state11() -> dict:
    # new at state 11: mesh 1 is freed with a surviving reference (item 8 still names it); mesh 3
    # is created "unsupported" (mesh-format) and named by item 9 (-> derived unsupported-mesh);
    # item 10 names mesh id 999, which the capture never saw (-> unknown-mesh).
    state = state10()
    items = dict(state["items"])
    items[9] = item9_unsupported_mesh()
    items[10] = item10_unknown_mesh()
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])}
    meshes = dict(state["meshes"])
    meshes[1] = mesh(status="freed", version=1, custom_aabb=NO_RECT + [0.0, 0.0], surfaces=[])
    meshes[3] = mesh(status="unsupported", reason="mesh-format", version=1)
    state["meshes"] = meshes
    state["unsupported"] = list(STATE11_UNSUPPORTED)
    return state


STATES = [state1(), state2(), state3(), state4(), state5(), state6(), state7(), state8(),
          state9(), state10(), state11()]


# --------------------------------------------------------------------------- decoding


def decode(data: bytes) -> dict:
    assert data[:8] == MAGIC
    pos = 8
    records = []
    while pos < len(data):
        (record_len,) = struct.unpack_from("<I", data, pos)
        start = pos
        end = pos + 4 + record_len
        assert end <= len(data)
        pos += 4
        (meta_len,) = struct.unpack_from("<I", data, pos)
        pos += 4
        meta = json.loads(data[pos : pos + meta_len].decode("ascii"))
        pos += meta_len
        (block_count,) = struct.unpack_from("<I", data, pos)
        pos += 4
        blocks = []
        for index in range(block_count):
            (block_len,) = struct.unpack_from("<I", data, pos)
            pos += 4
            descriptor = meta["blocks"][index]
            if descriptor["type"] == "f32":
                assert block_len == 4 * descriptor["count"]
                blocks.append(list(struct.unpack_from(f"<{block_len // 4}f", data, pos)))
            elif descriptor["type"] == "i32":
                assert block_len == 4 * descriptor["count"]
                blocks.append(list(struct.unpack_from(f"<{block_len // 4}i", data, pos)))
            else:
                assert descriptor["type"] == "u8"
                assert block_len == descriptor["count"]
                payload = data[pos : pos + block_len]
                blocks.append({"u8_bytes": block_len, "sha256": hashlib.sha256(payload).hexdigest()})
            pos += block_len
        assert pos == end
        records.append({
            "offset": start, "byte_length": end - start,
            "sha256": hashlib.sha256(data[start:end]).hexdigest(), "meta": meta, "blocks": blocks,
        })
    return {"schema": "render-stream-4-decoded/1", "magic": MAGIC.hex(), "records": records}


def to_hex(data: bytes) -> str:
    text = data.hex()
    return "".join(text[i : i + 64] + "\n" for i in range(0, len(text), 64))


def pretty(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=True) + "\n").encode("ascii")


# --------------------------------------------------------------------------- resolved.json (ground truth)


def resolved_state(state: dict) -> dict:
    canvases_out = []
    for cid in sorted(state["canvases"]):
        c = state["canvases"][cid]
        canvases_out.append({"id": cid, "origin": c.get("origin", "created"), "role": c["role"],
                              "attached": c["attached"], "items": c["items"], "xform": c["xform"]})
    items_out = []
    for iid in sorted(state["items"]):
        it = state["items"][iid]
        commands_out = [_resolved_command(c) for c in it["commands"]]
        parent = it["parent"]
        items_out.append({
            "id": iid, "origin": it.get("origin", "created"),
            "parent": None if parent is None else {"kind": parent[0], "id": parent[1]},
            "children": it["children"], "visible": it["visible"], "draw_index": it["draw_index"],
            "z_index": it["z_index"], "z_relative": it["z_relative"], "behind": it["behind"],
            "clip": it["clip"], "custom_rect": it["custom_rect"],
            "visibility_layer": it["visibility_layer"], "texture_filter": it["texture_filter"],
            "texture_repeat": it["texture_repeat"], "content_version": it["content_version"],
            "xform": it["xform"], "modulate": it["modulate"], "self_modulate": it["self_modulate"],
            "custom_rect_rect": it["crect"], "commands": commands_out,
        })
    textures_out = [_texture_json(tid, state["textures"][tid]) for tid in sorted(state["textures"])]
    meshes_out = []
    for mid in sorted(state["meshes"]):
        m = state["meshes"][mid]
        entry = {"id": mid, "origin": "created", "status": m["status"], "reason": m["reason"],
                 "version": m["version"], "custom_aabb": m["custom_aabb"],
                 "surfaces": m["surfaces"] if m["status"] == "ok" else []}
        meshes_out.append(entry)
    return {
        "status": "ok" if not state["failures"] else "capture-failure",
        "failures": state["failures"], "unsupported": state["unsupported"],
        "default_texture_filter": state["default_filter"],
        "default_texture_repeat": state["default_repeat"],
        "canvases": canvases_out, "items": items_out, "textures": textures_out,
        "meshes": meshes_out,
    }


def _resolved_command(command: dict) -> dict:
    op = command["op"]
    if op == "add_rect":
        return {"op": "add_rect", "aa": command["aa"], "rect": command["rect"], "color": command["color"]}
    if op == "add_texture_rect":
        return {"op": "add_texture_rect", "tex": command["tex"], "tile": command["tile"],
                "transpose": command["transpose"], "rect": command["rect"],
                "modulate": command["modulate"]}
    if op == "add_texture_rect_region":
        return {"op": "add_texture_rect_region", "tex": command["tex"],
                "transpose": command["transpose"], "clip_uv": command["clip_uv"],
                "rect": command["rect"], "src": command["src"], "modulate": command["modulate"]}
    if op == "add_msdf_texture_rect_region":
        return {"op": "add_msdf_texture_rect_region", "tex": command["tex"],
                "outline": command["outline"], "rect": command["rect"], "src": command["src"],
                "modulate": command["modulate"], "px_range": command["px_range"],
                "scale": command["scale"]}
    if op == "add_line":
        return {"op": "add_line", "aa": command["aa"], "from": command["from"], "to": command["to"],
                "colour": command["color"], "width": command["width"]}
    if op in ("add_polyline", "add_multiline"):
        return {"op": op, "aa": command["aa"], "width": command["width"],
                "points": command["points"], "colors": command["colors"]}
    if op == "add_circle":
        return {"op": "add_circle", "aa": command["aa"], "position": command["position"],
                "radius": command["radius"], "colour": command["color"]}
    if op in ("add_primitive", "add_polygon"):
        return {"op": op, "tex": command["tex"], "points": command["points"],
                "colors": command["colors"], "uvs": command["uvs"]}
    if op == "add_triangle_array":
        return {"op": "add_triangle_array", "tex": command["tex"], "count": command["count"],
                "points": command["points"], "colors": command["colors"], "uvs": command["uvs"],
                "indices": command["indices"]}
    if op == "add_nine_patch":
        l, t = command["margin_tl"]
        r, b = command["margin_br"]
        return {"op": "add_nine_patch", "tex": command["tex"], "rect": command["rect"],
                "source": command["source"], "margins": [l, t, r, b],
                "x_axis": command["x_axis"], "y_axis": command["y_axis"],
                "draw_center": command["draw_center"], "modulate": command["modulate"]}
    if op == "add_mesh":
        return {"op": "add_mesh", "mesh": command["mesh"], "tex": command["tex"],
                "transform": command["transform"], "modulate": command["modulate"]}
    if op == "add_set_transform":
        return {"op": "add_set_transform", "transform": command["transform"]}
    if op == "add_clip_ignore":
        return {"op": "add_clip_ignore", "ignore": command["ignore"]}
    assert op == "unsupported"
    return {"op": "unsupported", "name": command["name"], "reason": command["reason"]}


# --------------------------------------------------------------------------- mini fixture (invalid vectors)
#
# A small, self-contained scene used by the new invalid-vector builders: canvas 1, item 1 (top-
# level) drawing add_line, item 2 drawing add_triangle_array, and (where needed) a one-surface
# mesh. The wire-schema rules under test don't need a realistic scene.

MINI_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

MINI_MESH_FORMAT = ARRAY_FORMAT_COLOR | ARRAY_FLAG_USE_2D_VERTICES
MINI_MESH_VERTS = [(0.0, 0.0), (4.0, 0.0), (0.0, 4.0)]
MINI_MESH_COLORS = [(255, 255, 255, 255)] * 3
MINI_MESH_PAYLOAD = build_mesh_payload(
    "triangles", MINI_MESH_FORMAT, 3, 0, positions_f32(MINI_MESH_VERTS),
    colors_rgba8(MINI_MESH_COLORS), b"", b"", [0.0, 0.0, 0.0, 4.0, 4.0, 0.0], [1.0, 1.0, 0.0, 0.0],
)
MINI_MESH_HASH = mesh_payload_sha256(MINI_MESH_PAYLOAD)


def mini_line_item() -> dict:
    return item(parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
                commands=[add_line((0.0, 0.0), (4.0, 0.0), WHITE, 1.0)])


def mini_triangle_array_item() -> dict:
    return item(parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=1, content_version=1,
                commands=[add_triangle_array(
                    [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)], [[1.0, 1.0, 1.0, 1.0]], [],
                    [0, 1, 2, 0, 2, 3], -1,
                )])


def mini_mesh_item(mesh_id: int) -> dict:
    return item(parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=2, content_version=1,
                commands=[add_mesh(mesh_id, IDENTITY)])


def mini_state(*, with_mesh: bool = False, with_triangle_array: bool = False,
                with_mesh_item: int | None = None) -> dict:
    items = {1: mini_line_item()}
    item_ids = [1]
    if with_triangle_array:
        items[2] = mini_triangle_array_item()
        item_ids.append(2)
    if with_mesh_item is not None:
        items[3] = mini_mesh_item(with_mesh_item)
        item_ids.append(3)
    meshes = {}
    if with_mesh:
        meshes[1] = mesh(version=1, surfaces=[
            mesh_surface(MINI_MESH_HASH, len(MINI_MESH_PAYLOAD), "triangles", MINI_MESH_FORMAT,
                         3, 0),
        ])
    return {
        "items": items, "canvases": {1: root_canvas(item_ids)},
        "textures": {}, "meshes": meshes, "unsupported": [], "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }


def mini_session(encoding: str) -> bytes:
    return session_record(MINI_STREAM_ID, "file", encoding, MINI_SESSION_ID, delivery="out-of-band")


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    """name -> (bytes, code, description). Exactly the new failure modes /4 introduces
    (render-stream-4.md "Golden vectors"); every rule /4 leaves unchanged is already covered by
    golden-2/invalid/ and golden-3/invalid/, and is not re-derived here."""
    out: dict[str, tuple[bytes, str, str]] = {}

    # bad-magic: a valid /4-shaped recording with the /3 magic byte.
    base = mini_state()
    t1 = full_transaction_bytes(1, 1, base)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    valid_recording = recording(records, end)
    bad_magic = bytearray(valid_recording)
    bad_magic[:8] = MAGIC_RS3
    out["bad-magic"] = (bytes(bad_magic), "bad-magic", "magic byte 3 is '3' (GRS3), not '4'")

    # cmd-offset: item 1 draws add_line (9 floats, f=0) then a second add_line declaring f=7 (as
    # if the first line had consumed only 7 floats instead of 9).
    mixed_state = mini_state()
    mixed_item = dict(mixed_state["items"][1])
    mixed_item["commands"] = [
        add_line((0.0, 0.0), (4.0, 0.0), WHITE, 1.0),
        add_line((0.0, 4.0), (4.0, 4.0), WHITE, 1.0),
    ]
    cmd_f32: list[float] = []
    cmd_i32: list[int] = []
    line0_json = _command_json(mixed_item["commands"][0], cmd_f32, cmd_i32)
    assert line0_json["f"] == 0 and len(cmd_f32) == 9
    line1_json = {"op": "add_line", "aa": False, "f": 7}  # WRONG: should be 9
    cmd_f32 += (mixed_item["commands"][1]["from"] + mixed_item["commands"][1]["to"]
                + mixed_item["commands"][1]["color"] + [mixed_item["commands"][1]["width"]])
    items_json = [{
        "id": 1, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
        "visible": True, "draw_index": 0, "z_index": 0, "z_relative": True, "behind": False,
        "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default", "content_version": 1,
        "commands": [line0_json, line1_json],
    }]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": items_json, "textures": [], "meshes": [],
    }
    item_f32 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] + WHITE + WHITE + NO_RECT
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
                                   f32block("mesh_f32", [])])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["cmd-offset"] = (
        recording(records, end), "cmd-offset",
        "the second add_line declares f=7, but the first add_line consumed 9 floats",
    )

    # cmd-int-offset: item 2 draws add_triangle_array (6 indices, i=0) then a second
    # add_triangle_array declaring i=4 (as if only 4 indices had been consumed instead of 6).
    ta_state = mini_state(with_triangle_array=True)
    ta_item = dict(ta_state["items"][2])
    ta_item["commands"] = [
        add_triangle_array([(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)], [[1.0, 1.0, 1.0, 1.0]],
                            [], [0, 1, 2, 0, 2, 3], -1),
        add_triangle_array([(0.0, 0.0), (4.0, 0.0), (4.0, 4.0)], [[1.0, 1.0, 1.0, 1.0]], [],
                            [0, 1, 2], -1),
    ]
    cmd_f32 = []
    cmd_i32 = []
    ta0_json = _command_json(ta_item["commands"][0], cmd_f32, cmd_i32)
    assert ta0_json["i"] == 0 and len(cmd_i32) == 6
    ta1_json = dict(_command_json(ta_item["commands"][1], cmd_f32, cmd_i32))
    ta1_json["i"] = 4  # WRONG: should be 6
    items_json = [{
        "id": 2, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
        "visible": True, "draw_index": 1, "z_index": 0, "z_relative": True, "behind": False,
        "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default", "content_version": 1,
        "commands": [ta0_json, ta1_json],
    }]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [2]}],
        "items": items_json, "textures": [], "meshes": [],
    }
    item_f32 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] + WHITE + WHITE + NO_RECT
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
                                   f32block("mesh_f32", [])])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["cmd-int-offset"] = (
        recording(records, end), "cmd-int-offset",
        "the second add_triangle_array declares i=4, but the first consumed 6 indices",
    )

    # mesh-entry: an "ok" mesh entry with a non-null reason (never legal -- render-stream-4.md
    # "Mesh table": "status: ok": reason null").
    base = mini_state(with_mesh=True)
    t1 = full_transaction_bytes(1, 1, base)
    mesh_f32: list[float] = []
    bad_mesh_json = _mesh_json(1, base["meshes"][1], mesh_f32)
    bad_mesh_json["reason"] = "mesh-format"  # WRONG: status "ok" must have reason null
    cmd_f32: list[float] = []
    cmd_i32: list[int] = []
    items_json = []
    item_f32: list[float] = []
    for iid in sorted(base["items"]):
        it = base["items"][iid]
        items_json.append({
            "id": iid, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
            "visible": True, "draw_index": it["draw_index"], "z_index": 0, "z_relative": True,
            "behind": False, "clip": False, "custom_rect": False,
            "visibility_layer": 0xFFFFFFFF, "texture_filter": "default", "texture_repeat": "default",
            "content_version": 1,
            "commands": [_command_json(c, cmd_f32, cmd_i32) for c in it["commands"]],
        })
        item_f32 += it["xform"] + it["modulate"] + it["self_modulate"] + it["crect"]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": items_json, "textures": [], "meshes": [bad_mesh_json],
    }
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
                                   f32block("mesh_f32", mesh_f32)])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["mesh-entry"] = (
        recording(records, end), "mesh-entry",
        "mesh 1's status is \"ok\" but it declares a non-null reason",
    )

    # mesh-ref: item 3's add_mesh names mesh id 99, which has no table entry at all.
    bad_state = mini_state(with_mesh_item=99)
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["mesh-ref"] = (
        recording(records, end), "mesh-ref",
        "item 3's add_mesh names mesh 99, which has no entry in the resolved table",
    )

    # mesh-version: mesh 1 goes from version 2 (seq 1) to version 1 (seq 2) -- a decrease.
    base = mini_state(with_mesh=True)
    base["meshes"] = {1: mesh(version=2, surfaces=base["meshes"][1]["surfaces"])}
    t1 = full_transaction_bytes(1, 1, base)
    regressed = dict(base)
    regressed["meshes"] = {1: mesh(version=1, surfaces=base["meshes"][1]["surfaces"])}
    t2 = full_transaction_bytes(2, 2, regressed)
    records = [mini_session("full"), t1, t2]
    end = end_record(2, records, diff_ns_total=0, full_transactions=2, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["mesh-version"] = (
        recording(records, end), "mesh-version",
        "mesh 1's version decreases from 2 (seq 1) to 1 (seq 2)",
    )

    # mesh-offset: mesh 1's declared "f" (3) disagrees with the running offset over meshes[] (0,
    # the only entry, so the running offset is 0).
    base = mini_state(with_mesh=True)
    mesh_f32 = []
    good_mesh_json = _mesh_json(1, base["meshes"][1], mesh_f32)
    bad_mesh_json = dict(good_mesh_json)
    bad_mesh_json["f"] = 3  # WRONG: should be 0
    items_json = []
    item_f32 = []
    cmd_f32 = []
    cmd_i32 = []
    for iid in sorted(base["items"]):
        it = base["items"][iid]
        items_json.append({
            "id": iid, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
            "visible": True, "draw_index": it["draw_index"], "z_index": 0, "z_relative": True,
            "behind": False, "clip": False, "custom_rect": False,
            "visibility_layer": 0xFFFFFFFF, "texture_filter": "default", "texture_repeat": "default",
            "content_version": 1,
            "commands": [_command_json(c, cmd_f32, cmd_i32) for c in it["commands"]],
        })
        item_f32 += it["xform"] + it["modulate"] + it["self_modulate"] + it["crect"]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": items_json, "textures": [], "meshes": [bad_mesh_json],
    }
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
                                   f32block("mesh_f32", mesh_f32)])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["mesh-offset"] = (
        recording(records, end), "mesh-offset",
        "mesh 1 declares f=3, but it is the only mesh entry (running offset 0)",
    )

    # unsupported-mismatch: item 3's add_mesh names an unsupported mesh, but the transaction omits
    # the required derived unsupported-mesh entry.
    bad_state = mini_state(with_mesh_item=1)
    bad_state["meshes"] = {1: mesh(status="unsupported", reason="mesh-format", version=1)}
    bad_state["unsupported"] = []  # missing the derived entry
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["unsupported-mismatch"] = (
        recording(records, end), "unsupported-mismatch",
        "item 3 draws add_mesh naming an unsupported mesh with no derived unsupported-mesh entry",
    )

    # patch-removed: a patch both removes mesh 1 and lists it present.
    base = mini_state(with_mesh=True)
    t1 = full_transaction_bytes(1, 1, base)
    mesh_f32 = []
    present_mesh_json = _mesh_json(1, base["meshes"][1], mesh_f32)
    meta = {
        "type": "transaction", "seq": 2, "frame": 2, "encoding": "patch", "base_seq": 1,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [1],
        "canvases": [], "items": [], "textures": [], "meshes": [present_mesh_json],
    }
    t2_bad = encode_record(meta, [f32block("item_f32", []), f32block("canvas_f32", []),
                                   f32block("cmd_f32", []), i32block("cmd_i32", []),
                                   f32block("mesh_f32", mesh_f32)])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1,
                      resource_records=0, resource_bytes=0)
    out["patch-removed"] = (
        recording(records, end), "patch-removed",
        "seq 2 both removes mesh 1 and lists it present in meshes[]",
    )

    # meta-schema: an i32 block declared in the mesh_f32 slot (wrong block type for that name --
    # mesh_f32 must always be "f32").
    base = mini_state()
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": [{
            "id": 1, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
            "visible": True, "draw_index": 0, "z_index": 0, "z_relative": True, "behind": False,
            "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
            "texture_filter": "default", "texture_repeat": "default", "content_version": 1,
            "commands": [{"op": "add_line", "aa": False, "f": 0}],
        }],
        "textures": [], "meshes": [],
    }
    item_f32 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] + WHITE + WHITE + NO_RECT
    line_cmd = base["items"][1]["commands"][0]
    cmd_f32 = list(line_cmd["from"]) + list(line_cmd["to"]) + line_cmd["color"] + [line_cmd["width"]]
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32), i32block("cmd_i32", []),
                                   i32block("mesh_f32", [])])  # WRONG: mesh_f32 must be f32
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["meta-schema"] = (
        recording(records, end), "meta-schema",
        "the mesh_f32 block is declared type \"i32\" instead of \"f32\"",
    )

    # resource-payload: mesh 1's GRM1 payload meta disagrees with its mesh-table entry's declared
    # shape (the entry says vertex_count 3; the payload itself was built for vertex_count 4).
    bad_surface_payload = build_mesh_payload(
        "triangles", MINI_MESH_FORMAT, 4, 0,
        positions_f32([(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]),
        colors_rgba8([(255, 255, 255, 255)] * 4), b"", b"",
        [0.0, 0.0, 0.0, 4.0, 4.0, 0.0], [1.0, 1.0, 0.0, 0.0],
    )
    bad_surface_hash = mesh_payload_sha256(bad_surface_payload)
    inline_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                     delivery="inline")
    mismatched_state = mini_state(with_mesh=True)
    mismatched_state["meshes"] = {1: mesh(version=1, surfaces=[
        mesh_surface(bad_surface_hash, len(bad_surface_payload), "triangles", MINI_MESH_FORMAT,
                     3, 0),
    ])}
    t1 = full_transaction_bytes(1, 1, mismatched_state)
    records = [inline_session, resource_record_bytes(bad_surface_hash, bad_surface_payload), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=1, resource_bytes=len(bad_surface_payload))
    out["resource-payload"] = (
        recording(records, end), "resource-payload",
        "the GRM1 payload decodes vertex_count 4, but the mesh table entry declares 3",
    )

    return out


# --------------------------------------------------------------------------- GRM1 payload-invalid


def build_payload_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    good = MINI_MESH_PAYLOAD
    out: dict[str, tuple[bytes, str, str]] = {}

    bad_magic = bytearray(good)
    bad_magic[3] = ord("X")
    out["payload-magic"] = (bytes(bad_magic), "payload-magic",
                             "the fourth magic byte is 'X', not '1'")

    # payload-meta: meta_len is shortened by one byte (declaring less of the buffer as meta than
    # is actually there), breaking the JSON -- the buffer's own total length is untouched, so
    # every length-sufficiency check still passes and only the JSON parse fails.
    good_meta_len = struct.unpack_from("<I", good, 8)[0]
    bad_meta = bytearray(good)
    bad_meta[8:12] = struct.pack("<I", good_meta_len - 1)
    out["payload-meta"] = (bytes(bad_meta), "payload-meta",
                            "meta_len is shortened by one byte, breaking the JSON")

    meta_len = struct.unpack_from("<I", good, 8)[0]
    data_start = 12 + meta_len
    truncated_length = good[: data_start + 40 + 4]  # cuts off most of the data section
    out["payload-length"] = (truncated_length, "payload-length",
                              "the trailing bytes are shorter than vertex_bytes+attribute_bytes+skin_bytes+index_bytes")

    wrong_size_meta = {
        "type": "mesh-surface", "primitive": "triangles", "format": MINI_MESH_FORMAT,
        "vertex_count": 3, "index_count": 0,
        "vertex_bytes": 999,  # WRONG: should be 8*3 = 24
        "attribute_bytes": 12, "skin_bytes": 0, "index_bytes": 0,
    }
    wrong_size_meta_raw = canonical_json(wrong_size_meta)
    wrong_size_payload = (GRM1_MAGIC + u32(len(wrong_size_meta_raw)) + wrong_size_meta_raw
                          + f32s([0.0, 0.0, 0.0, 4.0, 4.0, 0.0] + [1.0, 1.0, 0.0, 0.0])
                          + bytes(999) + colors_rgba8(MINI_MESH_COLORS))
    out["payload-size"] = (wrong_size_payload, "payload-size",
                            "vertex_bytes is declared 999, but vertex_count 3 implies 24")

    return out


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    stream_id = "0123456789abcdef0123456789abcdef"
    valid = {
        "hello-submitted": {"type": "hello", "protocol": "render-stream/4",
                             "receiver": "gate5-selftest", "credit_stage": "submitted",
                             "inbound_buffer_bytes": 16777216},
        "hello-applied": {"type": "hello", "protocol": "render-stream/4",
                           "receiver": "gate5-selftest-headless", "credit_stage": "applied",
                           "inbound_buffer_bytes": 65535},
        "ack-received": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "received", "t_us": 1000},
        "ack-applied": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "applied", "t_us": 2500},
        "ack-submitted": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "submitted", "t_us": 4200},
        "resync": {"type": "resync", "stream_id": stream_id, "seq": 7, "reason": "unapplied-stale"},
        "error-message-too-large": {"type": "error", "reason": "message-too-large",
                                     "detail": "transaction 42 is 20000000 bytes"},
    }
    invalid = {
        "hello-missing-field": {"type": "hello", "protocol": "render-stream/4", "receiver": "x",
                                 "credit_stage": "submitted"},
        "hello-bad-credit-stage": {"type": "hello", "protocol": "render-stream/4", "receiver": "x",
                                    "credit_stage": "eventually", "inbound_buffer_bytes": 1024},
        "hello-non-integer-buffer": {"type": "hello", "protocol": "render-stream/4", "receiver": "x",
                                      "credit_stage": "submitted", "inbound_buffer_bytes": 1.5},
        "hello-wrong-protocol": {"type": "hello", "protocol": "render-stream/3", "receiver": "x",
                                  "credit_stage": "submitted", "inbound_buffer_bytes": 1024},
        "ack-bad-stage": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "queued", "t_us": 10},
        "ack-missing-stream-id": {"type": "ack", "seq": 1, "stage": "received", "t_us": 10},
        "resync-missing-reason": {"type": "resync", "stream_id": stream_id, "seq": 1},
        "unknown-type": {"type": "ping"},
    }
    return {"valid": valid, "invalid": invalid}


# --------------------------------------------------------------------------- outputs


def build() -> dict[str, bytes]:
    full_session_id = "0123456789abcdef0123456789abcdef"
    full_stream_id = "1" * 32
    patch_session_id = "fedcba9876543210fedcba9876543210"
    patch_stream_id = "2" * 32
    inline_session_id = "22222222222222222222222222222222"
    inline_stream_id = "3" * 32

    full_session = session_record(full_stream_id, "file", "full", full_session_id, delivery="out-of-band")
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(full_transaction_bytes(i + 1, i + 1, state))
    full_end = end_record(11, full_records, diff_ns_total=0, full_transactions=11,
                           patch_transactions=0, resource_records=0, resource_bytes=0)
    full_rs4 = recording(full_records, full_end)

    patch_session = session_record(patch_stream_id, "file", "patch", patch_session_id, delivery="out-of-band")
    patch_records = [patch_session, full_transaction_bytes(1, 1, STATES[0])]
    for i in range(1, 5):
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_records.append(full_transaction_bytes(6, 6, STATES[5]))  # resync: full again
    for i in range(6, 11):
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_end = end_record(11, patch_records, diff_ns_total=12345, full_transactions=2,
                            patch_transactions=9, resource_records=0, resource_bytes=0)
    patch_rs4 = recording(patch_records, patch_end)

    mesh_payloads = [
        (HASH_MESH1_A, MESH1_SURFACE_A_PAYLOAD), (HASH_MESH1_B, MESH1_SURFACE_B_PAYLOAD),
        (HASH_MESH2_V1, MESH2_SURFACE_V1_PAYLOAD), (HASH_MESH2_V2, MESH2_SURFACE_V2_PAYLOAD),
    ]

    inline_session = session_record(inline_stream_id, "file", "full", inline_session_id, delivery="inline")
    inline_records = [inline_session, resource_record_bytes(HASH_A1, PAYLOAD_A1),
                       resource_record_bytes(HASH_F, PAYLOAD_F)]
    inline_records.append(full_transaction_bytes(1, 1, STATES[0]))
    inline_records.append(full_transaction_bytes(2, 2, STATES[1]))
    inline_records.append(resource_record_bytes(HASH_A2, PAYLOAD_A2))
    inline_records.append(full_transaction_bytes(3, 3, STATES[2]))
    inline_records.append(resource_record_bytes(HASH_P, PAYLOAD_P))
    inline_records.append(full_transaction_bytes(4, 4, STATES[3]))
    inline_records.append(full_transaction_bytes(5, 5, STATES[4]))
    inline_records.append(full_transaction_bytes(6, 6, STATES[5]))
    inline_records.append(resource_record_bytes(HASH_PAGE, PAYLOAD_PAGE))
    inline_records.append(full_transaction_bytes(7, 7, STATES[6]))
    inline_records.append(full_transaction_bytes(8, 8, STATES[7]))
    inline_records.append(resource_record_bytes(HASH_MESH1_A, MESH1_SURFACE_A_PAYLOAD))
    inline_records.append(resource_record_bytes(HASH_MESH1_B, MESH1_SURFACE_B_PAYLOAD))
    inline_records.append(resource_record_bytes(HASH_MESH2_V1, MESH2_SURFACE_V1_PAYLOAD))
    inline_records.append(full_transaction_bytes(9, 9, STATES[8]))
    inline_records.append(resource_record_bytes(HASH_MESH2_V2, MESH2_SURFACE_V2_PAYLOAD))
    inline_records.append(full_transaction_bytes(10, 10, STATES[9]))
    inline_records.append(full_transaction_bytes(11, 11, STATES[10]))
    inline_resource_bytes = (len(PAYLOAD_A1) + len(PAYLOAD_F) + len(PAYLOAD_A2) + len(PAYLOAD_P)
                              + len(PAYLOAD_PAGE) + sum(len(p) for _, p in mesh_payloads))
    inline_end = end_record(11, inline_records, diff_ns_total=0, full_transactions=11,
                             patch_transactions=0, resource_records=5 + len(mesh_payloads),
                             resource_bytes=inline_resource_bytes)
    inline_rs4 = recording(inline_records, inline_end)

    full_decoded = decode(full_rs4)
    patch_decoded = decode(patch_rs4)
    inline_decoded = decode(inline_rs4)
    resolved = {
        "schema": "render-stream-4-resolved/1",
        "transactions": [
            {"seq": i + 1, "frame": i + 1, "state": resolved_state(state)}
            for i, state in enumerate(STATES)
        ],
    }
    inline_resources = [
        {"hash": HASH_A1, "bytes": len(PAYLOAD_A1), "record_index": 1},
        {"hash": HASH_F, "bytes": len(PAYLOAD_F), "record_index": 2},
        {"hash": HASH_A2, "bytes": len(PAYLOAD_A2), "record_index": 5},
        {"hash": HASH_P, "bytes": len(PAYLOAD_P), "record_index": 7},
        {"hash": HASH_PAGE, "bytes": len(PAYLOAD_PAGE), "record_index": 11},
        {"hash": HASH_MESH1_A, "bytes": len(MESH1_SURFACE_A_PAYLOAD), "record_index": 14},
        {"hash": HASH_MESH1_B, "bytes": len(MESH1_SURFACE_B_PAYLOAD), "record_index": 15},
        {"hash": HASH_MESH2_V1, "bytes": len(MESH2_SURFACE_V1_PAYLOAD), "record_index": 16},
        {"hash": HASH_MESH2_V2, "bytes": len(MESH2_SURFACE_V2_PAYLOAD), "record_index": 18},
    ]

    # corrupt-meta: patch.rs4's seq 3 (record index 3: session=0, seq1=1, seq2=2, seq3=3), first
    # meta byte zeroed -- as every earlier golden's.
    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt = bytearray(patch_rs4)
    assert corrupt[seq3_offset + 8] == ord("{")
    corrupt[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    payload_invalid = build_payload_invalid_vectors()
    control = control_messages()

    index = {
        "schema": "render-stream-4-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs4", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs4).hexdigest()},
            {"file": "patch.rs4", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs4).hexdigest()},
            {"file": "inline.rs4", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs4).hexdigest()},
        ],
        "resolved": "resolved.json",
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs4", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs4 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs4", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        "payload_invalid": [
            {"file": f"payload-invalid/{name}.grm", "code": code, "description": description}
            for name, (_, code, description) in payload_invalid.items()
        ],
        "payloads": [
            {"file": "payloads/a1.grt", "hash": HASH_A1, "format": "RGBA8", "width": 16,
             "height": 16, "mipmaps": False, "bytes": len(PAYLOAD_A1)},
            {"file": "payloads/a2.grt", "hash": HASH_A2, "format": "RGBA8", "width": 16,
             "height": 16, "mipmaps": False, "bytes": len(PAYLOAD_A2)},
            {"file": "payloads/f.grt", "hash": HASH_F, "format": "LA8", "width": 4, "height": 4,
             "mipmaps": False, "bytes": len(PAYLOAD_F)},
            {"file": "payloads/p.grt", "hash": HASH_P, "format": "RGBA8", "width": 8, "height": 8,
             "mipmaps": True, "bytes": len(PAYLOAD_P)},
            {"file": "payloads/page.grt", "hash": HASH_PAGE, "format": "RGBA8", "width": 16,
             "height": 16, "mipmaps": False, "bytes": len(PAYLOAD_PAGE)},
        ],
        "mesh_payloads": [
            {"file": "payloads/mesh1-a.grm", "hash": HASH_MESH1_A, "primitive": "triangles",
             "format": MESH1_SURFACE_A_FORMAT, "vertex_count": 3, "index_count": 0,
             "bytes": len(MESH1_SURFACE_A_PAYLOAD)},
            {"file": "payloads/mesh1-b.grm", "hash": HASH_MESH1_B, "primitive": "triangles",
             "format": MESH1_SURFACE_B_FORMAT, "vertex_count": 4, "index_count": 6,
             "bytes": len(MESH1_SURFACE_B_PAYLOAD)},
            {"file": "payloads/mesh2-v1.grm", "hash": HASH_MESH2_V1, "primitive": "triangles",
             "format": MESH2_SURFACE_FORMAT, "vertex_count": 4, "index_count": 6,
             "bytes": len(MESH2_SURFACE_V1_PAYLOAD)},
            {"file": "payloads/mesh2-v2.grm", "hash": HASH_MESH2_V2, "primitive": "triangles",
             "format": MESH2_SURFACE_FORMAT, "vertex_count": 4, "index_count": 6,
             "bytes": len(MESH2_SURFACE_V2_PAYLOAD)},
        ],
    }

    outputs: dict[str, bytes] = {
        "full.rs4": full_rs4,
        "full.hex": to_hex(full_rs4).encode("ascii"),
        "full.decoded.json": pretty(full_decoded),
        "patch.rs4": patch_rs4,
        "patch.hex": to_hex(patch_rs4).encode("ascii"),
        "patch.decoded.json": pretty(patch_decoded),
        "inline.rs4": inline_rs4,
        "inline.hex": to_hex(inline_rs4).encode("ascii"),
        "inline.decoded.json": pretty(inline_decoded),
        "resolved.json": pretty(resolved),
        "corrupt-meta.rs4": bytes(corrupt),
        "index.json": pretty(index),
        "payloads/a1.grt": PAYLOAD_A1,
        "payloads/a2.grt": PAYLOAD_A2,
        "payloads/f.grt": PAYLOAD_F,
        "payloads/p.grt": PAYLOAD_P,
        "payloads/page.grt": PAYLOAD_PAGE,
        "payloads/mesh1-a.grm": MESH1_SURFACE_A_PAYLOAD,
        "payloads/mesh1-b.grm": MESH1_SURFACE_B_PAYLOAD,
        "payloads/mesh2-v1.grm": MESH2_SURFACE_V1_PAYLOAD,
        "payloads/mesh2-v2.grm": MESH2_SURFACE_V2_PAYLOAD,
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs4"] = data
    for name, (data, _, _) in payload_invalid.items():
        outputs[f"payload-invalid/{name}.grm"] = data
    for name, msg in control["valid"].items():
        outputs[f"control/valid/{name}.json"] = pretty(msg)
    for name, msg in control["invalid"].items():
        outputs[f"control/invalid/{name}.json"] = pretty(msg)
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
