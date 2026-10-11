#!/usr/bin/env python3
"""Generate the render-stream/6 golden vectors (stdlib only, deterministic).

render-stream/6 (../render-stream-6.md) is render-stream/5 (../render-stream-5.md) plus
presentation stretch declarations (viewport.presentation_size/font_oversampling/snap_2d), a new
top-level session key `publication` (rate control), canvas `layer`/`sublayer` and five new
session-level unsupported reasons. Exactly as G6w did for /6 (gate6-design.md), this script
re-derives /5's fifteen states byte for byte under the GRS6 magic and the "render-stream/6"
protocol string (presentation_size equal to logical_size, font_oversampling 1, snap_2d both false,
publication "every-frame"/null, root canvas at layer 0/sublayer 0) and then adds four more:

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

    16 (new) a second canvas (id 2) attached to the root viewport at layer 1/sublayer 0, with a
       non-identity transform, a non-white modulate, and two new items (18, 19) parented to it.
    17 (new) relative to 16: ONLY canvas 2's layer changes (1 -> -1) -- the patch carries exactly
       one canvas entry, nothing else.
    18 (new) relative to 17: canvas 2 is removed from the viewport (attached: false); its items
       (18, 19) stay in the table, parented to it, as gate 0 keeps a detached canvas's items.
    19 (new) relative to 18: canvas 2 is reattached (layer 2/sublayer 0) and a third canvas (id 3,
       no items) is created at the SAME (layer, sublayer) -- a canvas-stacking-tie -- and the
       session gains canvas-repeat, canvas-follow-viewport and global-canvas-transform together
       (none of the three has an independent wire signal, so they are declared, not derived).

As built (G6w): the canonical JSON float form for `font_oversampling` (the only JSON-embedded
float this wire carries) is this script's own decision, shared identically by the C++ codec
(rs2_codec.cpp's `append_json_float()`) and documented in render-stream-6.md "As built": the
shortest fixed-point decimal that round-trips to the exact float64 widening of the value, matching
JavaScript's own `Number::toString` (no trailing ".0" on a whole number, unlike Python's
`repr(1.0)`). The FEATURE_* session lists below are illustrative session data, not the production
calibrator roster (G6w touches no hook, mirror or calibrator file).

full.rs6 encodes all nineteen states as full transactions, directory (out-of-band) delivery.
patch.rs6 encodes the same nineteen states patch-encoded (seq 6 full again, as after a resync, as
every earlier golden's; every other seq patch-encoded against its predecessor).
inline.rs6 encodes all nineteen as full transactions again, but with inline delivery: a resource
record for each hash precedes the first transaction whose resolved table needs it. All three
resolve to the same resolved.json (stream_id and per-transaction "encoding" excepted, as every
earlier golden -- memory: rs1-resolved-json-excepted-fields).

presentation.rs6, snap.rs6 and rate.rs6 are each a SEPARATE, small, independent recording (its own
session), mirroring how params.rs6 is independent of golden-5's shared streams: presentation.rs6
proves the `presentation` root_size_policy (canvas_items stretch, logical 1920x1080, presentation
960x540, font_oversampling 0.5); snap.rs6 proves `snap_2d` (both flags true, every transaction
carries the snap-2d entry); rate.rs6 proves `publication` rate control (a websocket stream,
publication {"mode":"rate","target_fps":30}). Each resolves to its own resolved-*.json.

invalid/ vectors cover exactly the new failure modes render-stream-6.md's "Golden vectors" section
lists (every code /2's-/5's own vectors already cover for an unchanged rule is not re-derived
here): a GRS5 stream (bad-magic); presentation_size disagreeing with logical_size without the
"presentation" policy (viewport-entry); font_oversampling zero (viewport-entry); a host_size_status
that contradicts host_window_size/presentation_size (viewport-entry); publication "rate" with a
null target_fps, an out-of-range target_fps, and "rate" on a file stream (publication-entry, three
vectors); a canvas entry whose sublayer is not an integer (canvas-entry); two attached canvases
sharing (layer, sublayer) with no canvas-stacking-tie entry, and a canvas-stacking-tie entry with
no actual tie (unsupported-mismatch, two vectors); a session declaring snap_2d with a transaction
missing the snap-2d entry, and a snap-2d entry while snap_2d is false (unsupported-mismatch, two
vectors); and an unsupported[] entry naming reason extra-canvas, never legal at /6
(unsupported-mismatch).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MAGIC = bytes([0x47, 0x52, 0x53, 0x36, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS6\r\n\x1a\n"
MAGIC_RS5 = bytes([0x47, 0x52, 0x53, 0x35, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS5\r\n\x1a\n"
GRT1_MAGIC = bytes([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRT1\r\n\x1a\n"
GRM1_MAGIC = bytes([0x47, 0x52, 0x4D, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRM1\r\n\x1a\n"
GRP1_MAGIC = bytes([0x47, 0x52, 0x50, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRP1\r\n\x1a\n"
PROTOCOL = "render-stream/6"
PAYLOAD_SCHEMA = "render-stream-texture/1"
MESH_PAYLOAD_SCHEMA = "render-stream-mesh/1"
SHADER_PAYLOAD_SCHEMA = "render-stream-shader/1"

ITEM_FLOATS = 18  # xform 6, modulate 4, self_modulate 4, custom_rect 4 -- unchanged from /2
CANVAS_FLOATS = 6  # xform 6
CANVAS_MODULATE_FLOATS = 4  # new at /5 (render-stream-5.md "Canvas"): canvas_f32 grows 6 -> 10
MESH_AABB_FLOATS = 6  # position xyz, size xyz (render-stream-4.md "Mesh table")

# Fixed per-command float counts (render-stream-4.md "Command"); unchanged at /5 (no new ops).
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

# render-stream-4.md Q1e-equivalent ARRAY_FORMAT_* bits, carried over unchanged (golden-5 still
# builds golden-4's own mesh surfaces for states 1-11).
ARRAY_FORMAT_COLOR = 1 << 3
ARRAY_FORMAT_TEX_UV = 1 << 4
ARRAY_FORMAT_BONES = 1 << 10
ARRAY_FORMAT_WEIGHTS = 1 << 11
ARRAY_FORMAT_INDEX = 1 << 12
ARRAY_FLAG_USE_2D_VERTICES = 1 << 25
ARRAY_FLAG_USE_8_BONE_WEIGHTS = 1 << 27
ARRAY_FLAG_COMPRESS_ATTRIBUTES = 1 << 29

# gate5_5-design.md D8: float64 components per element of a Variant type, in Godot's own member
# order. "nil"/"rid" never contribute floats. As built (G55w): wire spellings are this codec's own
# decision (snake_case, matching the engine's own type names) -- see render-stream-5.md "As built".
VARIANT_COMPONENTS = {
    "nil": 0, "bool": 1, "int": 1, "float": 1, "vector2": 2, "vector2i": 2,
    "rect2": 4, "rect2i": 4, "vector3": 3, "vector3i": 3, "transform2d": 6,
    "vector4": 4, "vector4i": 4, "plane": 4, "quaternion": 4, "aabb": 6,
    "basis": 9, "transform3d": 12, "projection": 16, "color": 4, "rid": 0,
    "packed_int32_array": 1, "packed_int64_array": 1, "packed_float32_array": 1,
    "packed_float64_array": 1, "packed_vector2_array": 2, "packed_vector3_array": 3,
    "packed_vector4_array": 4, "packed_color_array": 4,
}

# Carried over verbatim from protocol/golden-4/make_golden.py: illustrative session data, not the
# production calibrator roster (G55w touches no hook, mirror or calibrator file).
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
        "free", "material_create", "material_create_from_shader", "material_set_param",
        "material_set_shader", "mesh_add_surface", "mesh_clear", "mesh_create",
        "mesh_set_custom_aabb", "mesh_surface_update_attribute_region",
        "mesh_surface_update_vertex_region", "shader_create", "shader_create_from_code",
        "shader_set_code", "shader_set_default_texture_parameter", "texture_2d_create",
        "texture_2d_update", "viewport_attach_canvas", "viewport_set_canvas_transform",
    ]
)

# render-stream-4.md "Features": fifteen ops, unchanged at /5 (no new draw/state ops this gate).
FEATURE_OPS = sorted([
    "add_rect", "add_texture_rect", "add_texture_rect_region", "add_msdf_texture_rect_region",
    "add_line", "add_polyline", "add_multiline", "add_circle", "add_primitive", "add_polygon",
    "add_triangle_array", "add_nine_patch", "add_mesh", "add_set_transform", "add_clip_ignore",
])
# render-stream-5.md "Session": item_state gains instance_params/material/use_parent_material.
FEATURE_ITEM_STATE = sorted(
    [
        "children", "clip", "custom_rect", "draw_index", "modulate", "parent", "self_modulate",
        "transform", "visibility_layer", "visible", "z_index", "behind", "z_relative",
        "texture_filter", "texture_repeat", "material", "use_parent_material", "instance_params",
    ]
)
# render-stream-5.md "Session": a new features key, right after item_state. render-stream-6.md
# "Features": gains "layer" at /6.
FEATURE_CANVAS_STATE = sorted(["modulate", "transform", "layer"])
# render-stream-4.md's three plus "material" and "shader" (render-stream-5.md "Session").
FEATURE_RESOURCES = sorted(["texture_2d", "texture_2d_placeholder", "mesh", "material", "shader"])
FEATURE_UNSUPPORTED_RESOURCES = []
# /5's six (canvas_light_attach_to_canvas etc.) plus render-stream-6.md "Features"'s three new
# canvas ops (calibrator 9 hooks canvas_set_item_mirroring/_repeat/canvas_set_parent, which now
# surface as observed-unsupported rather than unhooked).
FEATURE_OBSERVED_UNSUPPORTED_OPS = sorted(
    [
        "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
        "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
        "canvas_light_attach_to_canvas", "canvas_set_item_mirroring", "canvas_set_item_repeat",
        "canvas_set_parent",
    ]
)
# /5's nineteen minus viewport_remove_canvas and viewport_set_global_canvas_transform (both now
# hooked and session-level-observed at /6), plus canvas_set_disable_scale (render-stream-6.md
# "Features": calibrator 9 hooks its five siblings but leaves slot 440 unhooked).
FEATURE_UNOBSERVED = sorted(
    [
        "canvas_item_set_canvas_group_mode", "canvas_item_set_light_mask",
        "canvas_item_set_sort_children_by_y", "canvas_item_set_visibility_notifier",
        "canvas_texture_set_shading_parameters", "texture_set_size_override",
        "viewport_set_canvas_cull_mask", "viewport_set_snap_2d_transforms_to_pixel",
        "viewport_set_snap_2d_vertices_to_pixel",
        "canvas_item_set_copy_to_backbuffer", "global_shader_parameter_add",
        "global_shader_parameter_remove", "global_shader_parameter_set",
        "global_shader_parameter_set_override", "material_set_next_pass",
        "material_set_render_priority", "shader_set_path_hint", "canvas_set_disable_scale",
    ]
)
PUBLICATION = "snapshot-or-patch"


# render-stream-6.md "As built": the shortest fixed-point decimal that round-trips to the exact
# float64 widening of a float32 value, matching JavaScript's own Number::toString in this
# magnitude range (no trailing ".0" on a whole number) -- the only JSON-embedded float this wire
# carries (font_oversampling). json.dumps()/repr() would print "1.0"; this prints "1".
def _json_float(value: float) -> str:
    for precision in range(0, 18):
        candidate = f"{value:.{precision}f}"
        if float(candidate) == value:
            break
    else:
        candidate = repr(value)
    if "." in candidate:
        candidate = candidate.rstrip("0")
        if candidate.endswith("."):
            candidate = candidate[:-1]
    return candidate


class _RawFloat(float):
    """A float that `canonical_json()` must render as `_json_float(self)` instead of Python's own
    repr -- json.dumps() has no per-value number-formatting hook, so `canonical_json()` below
    detects this marker type and splices in the canonical text (quoted as a placeholder string,
    then unquoted) rather than letting the stdlib encoder print it."""

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]


# --------------------------------------------------------------------------- encoding (framing)
# Framing, canonical JSON and the u8/i32 block types are unchanged from /2-/4. The f64 block is
# new at /5 (render-stream-5.md "Block type f64"): 8 bytes per value, legal only as a transaction's
# sixth block, "param_f64".


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


def f64s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        out += struct.pack("<d", value)
    return bytes(out)


def f32_pattern(values: list[float]) -> list[bytes]:
    return [struct.pack("<f", v) for v in values]


def canonical_json(obj: object) -> bytes:
    # render-stream-6.md "As built": json.dumps() has no per-value number-formatting hook, and
    # Python's own float repr prints "1.0" for a whole number where this wire wants "1"
    # (font_oversampling is the only JSON-embedded float -- render-stream-0.md "Floats never
    # appear in JSON" holds for everything else). Mark every _RawFloat with a unique sentinel
    # STRING, dump normally, then splice the canonical unquoted digits back in at that exact
    # position.
    raw_floats: list[str] = []

    def _mark(value: object) -> object:
        if isinstance(value, _RawFloat):
            # Plain ASCII, no control characters: json.dumps() would otherwise escape a raw
            # \x00 as the six-character sequence "\u0000", which this function's later literal
            # text.replace() would then never find.
            token = "@@RAWFLOAT%d@@" % len(raw_floats)
            raw_floats.append(_json_float(float(value)))
            return token
        if isinstance(value, dict):
            return {k: _mark(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [_mark(v) for v in value]
        return value

    marked = _mark(obj)
    text = json.dumps(marked, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    for i, digits in enumerate(raw_floats):
        text = text.replace('"@@RAWFLOAT%d@@"' % i, digits)
    raw = text.encode("ascii")
    assert all(0x20 <= b <= 0x7E for b in raw), "meta must be printable ASCII"
    return raw


def f32block(name: str, values: list[float]) -> tuple[str, str, list[float]]:
    return (name, "f32", values)


def i32block(name: str, values: list[int]) -> tuple[str, str, list[int]]:
    return (name, "i32", values)


def f64block(name: str, values: list[float]) -> tuple[str, str, list[float]]:
    return (name, "f64", values)


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
        elif btype == "f64":
            payload = f64s(values)  # type: ignore[arg-type]
            count = len(values)  # type: ignore[arg-type]
        else:
            assert btype == "u8"
            payload = bytes(values)  # type: ignore[arg-type]
            count = len(payload)
        if name == short_block:
            width = 8 if btype == "f64" else (4 if btype in ("f32", "i32") else 1)
            payload = payload[: len(payload) - width]
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


# Payloads #1-5: verbatim from golden-4 (A/Atwin's content, A's state-3 update, F, P's
# replacement, "the page"). No new GRT1 payload at /5.
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
    buffers concatenated. Carried over unchanged at /5."""
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


# --------------------------------------------------------------------------- shader payload (GRP1)


def build_shader_payload(code: str) -> bytes:
    """render-stream-5.md "Shader payload render-stream-shader/1": magic, u32 meta_len, canonical
    JSON meta ({"type":"shader-code","code_bytes":<int>}), then the code as UTF-8, exactly the
    string the RenderingServer received. No geometry block (unlike GRM1) and no separate data_len
    (unlike GRT1): the payload simply ends where meta.code_bytes says it does."""
    data = code.encode("utf-8")
    meta = {"type": "shader-code", "code_bytes": len(data)}
    meta_raw = canonical_json(meta)
    return GRP1_MAGIC + u32(len(meta_raw)) + meta_raw + data


def shader_payload_sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


# Shader 1: the builtin CanvasItemMaterial "add" blend template (gate5_5-design.md Q1e). No
# particles block (particles_animation false); light_mode "normal" is the default and omitted.
SHADER1_CIM_ADD_CODE = (
    "// NOTE: Shader automatically converted from Godot Engine v4.5.1.stable.official's "
    "CanvasItemMaterial.\n\nshader_type canvas_item;\nrender_mode blend_add;\n"
)
SHADER1_CIM_ADD_PAYLOAD = build_shader_payload(SHADER1_CIM_ADD_CODE)
HASH_SHADER1 = shader_payload_sha256(SHADER1_CIM_ADD_PAYLOAD)

# Shader 2: a custom "source" shader (material 2's).
SHADER2_TINT_CODE_V1 = (
    "shader_type canvas_item;\nuniform vec4 tint : source_color = vec4(1.0);\n"
    "void fragment() {\n\tCOLOR = tint;\n}\n"
)
SHADER2_TINT_PAYLOAD_V1 = build_shader_payload(SHADER2_TINT_CODE_V1)
HASH_SHADER2_V1 = shader_payload_sha256(SHADER2_TINT_PAYLOAD_V1)

# state 14: shader 2's code changes (new hash, same id).
SHADER2_TINT_CODE_V2 = (
    "shader_type canvas_item;\nuniform vec4 tint : source_color = vec4(1.0);\n"
    "void fragment() {\n\tCOLOR = tint * 0.9;\n}\n"
)
SHADER2_TINT_PAYLOAD_V2 = build_shader_payload(SHADER2_TINT_CODE_V2)
HASH_SHADER2_V2 = shader_payload_sha256(SHADER2_TINT_PAYLOAD_V2)

# Shader 3, state 15: uses TIME (gate5_5-design.md D11 -> shader-time).
SHADER3_TIME_CODE = (
    "shader_type canvas_item;\nvoid fragment() {\n\tCOLOR = vec4(TIME, 0.0, 0.0, 1.0);\n}\n"
)
SHADER3_TIME_PAYLOAD = build_shader_payload(SHADER3_TIME_CODE)
HASH_SHADER3 = shader_payload_sha256(SHADER3_TIME_PAYLOAD)


# --------------------------------------------------------------------------- session


def session_record(
    stream_id: str,
    transport: str,
    encoding: str,
    session_id: str,
    *,
    delivery: str,
    host_size_status: str = "match",
    shader_policy: str = "source",
    logical_size: tuple[int, int] = (640, 360),
    host_window_size: tuple[int, int] = (640, 360),
    root_size_policy: str = "observe",
    presentation_size: tuple[int, int] | None = None,
    font_oversampling: float = 1.0,
    snap_2d: tuple[bool, bool] = (False, False),
    stretch_mode: str = "disabled",
    stretch_aspect: str = "ignore",
    stretch_scale_mode: str = "fractional",
    publication_mode: str = "every-frame",
    publication_target_fps: int | None = None,
    clear_color: list[float] = (0.25, 0.25, 0.5, 1.0),
    host_visible_rect: list[float] | None = None,
    host_final_xform: list[float] = IDENTITY,
    content_scale_factor: float = 1.0,
) -> bytes:
    if presentation_size is None:
        presentation_size = logical_size
    if host_visible_rect is None:
        host_visible_rect = [0.0, 0.0, float(logical_size[0]), float(logical_size[1])]
    if delivery == "out-of-band":
        resources = {
            "hash": "sha256",
            "payloads": sorted([MESH_PAYLOAD_SCHEMA, SHADER_PAYLOAD_SCHEMA, PAYLOAD_SCHEMA]),
            "delivery": "out-of-band", "inline_max_bytes": 0, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "directory", "http_path": None,
            "auth": "none",
        }
    else:
        assert delivery == "inline"
        resources = {
            "hash": "sha256",
            "payloads": sorted([MESH_PAYLOAD_SCHEMA, SHADER_PAYLOAD_SCHEMA, PAYLOAD_SCHEMA]),
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
            "calibrator_version": 8,
            "hooks_planned": HOOKS_PLANNED,
            "hooks_omitted": [],
        },
        "viewport": {
            "canvas_cull_mask": 4294967295,
            "root_canvas": 1,
            "logical_size": list(logical_size),
            "stretch": {"mode": stretch_mode, "aspect": stretch_aspect,
                        "scale_mode": stretch_scale_mode},
            "stretch_applied_by": "receiver",
            "root_size_policy": root_size_policy,
            "presentation_size": list(presentation_size),
            "host_size_status": host_size_status,
            "host_window_size": list(host_window_size),
            "font_oversampling": _RawFloat(font_oversampling),
            "snap_2d": {"transforms": snap_2d[0], "vertices": snap_2d[1]},
        },
        "resources": resources,
        "materials": {"shader_policy": shader_policy},
        "features": {
            "ops": FEATURE_OPS,
            "item_state": FEATURE_ITEM_STATE,
            "canvas_state": FEATURE_CANVAS_STATE,
            "resources": FEATURE_RESOURCES,
            "unsupported_resources": FEATURE_UNSUPPORTED_RESOURCES,
            "observed_unsupported_ops": FEATURE_OBSERVED_UNSUPPORTED_OPS,
            "unobserved": FEATURE_UNOBSERVED,
            "publication": PUBLICATION,
        },
        "publication": {"mode": publication_mode, "target_fps": publication_target_fps},
        "sabotage": None,
    }
    blocks = [
        f32block("clear_color", list(clear_color)),
        f32block("root_canvas_xform", IDENTITY),
        f32block("host_visible_rect", list(host_visible_rect)),
        f32block("host_final_xform", list(host_final_xform)),
        f32block("content_scale_factor", [content_scale_factor]),
    ]
    return encode_record(meta, blocks)


# --------------------------------------------------------------------------- transaction model


def item_differs(a: dict, b: dict) -> bool:
    for key in ("parent", "children", "visible", "draw_index", "z_index", "z_relative", "behind",
                "clip", "custom_rect", "visibility_layer", "texture_filter", "texture_repeat",
                "content_version", "material", "use_parent_material", "instance_params"):
        if a[key] != b[key]:
            return True
    for key in ("xform", "modulate", "self_modulate", "crect"):
        if f32_pattern(a[key]) != f32_pattern(b[key]):
            return True
    return False


def canvas_differs(a: dict, b: dict) -> bool:
    for key in ("origin", "role", "attached", "items", "layer", "sublayer"):
        if a[key] != b[key]:
            return True
    # new at /5: canvas modulate participates too (render-stream-5.md "Canvas").
    return f32_pattern(a["xform"]) != f32_pattern(b["xform"]) or \
        f32_pattern(a["modulate"]) != f32_pattern(b["modulate"])


TEXTURE_FIELDS = ("kind", "status", "reason", "version", "hash", "format", "width", "height",
                   "mipmaps", "payload_bytes", "canvas")


def texture_differs(a: dict, b: dict) -> bool:
    return any(a[key] != b[key] for key in TEXTURE_FIELDS)


def mesh_differs(a: dict, b: dict) -> bool:
    for key in ("status", "reason", "version", "surfaces"):
        if a[key] != b[key]:
            return True
    return f32_pattern(a["custom_aabb"]) != f32_pattern(b["custom_aabb"])


# render-stream-5.md "Shader table"/"Material table": exactly the texture/mesh table's full/patch
# semantics, so every JSON field participates. Params carry float64 (Python floats are already
# float64-precision), so plain equality is exact -- no bit-pattern helper is needed the way /2-/4
# need one for float32.
def shader_differs(a: dict, b: dict) -> bool:
    return a != b


def material_differs(a: dict, b: dict) -> bool:
    return a != b


def diff_state(base: dict, cur: dict):
    base_items, cur_items = base["items"], cur["items"]
    base_canvases, cur_canvases = base["canvases"], cur["canvases"]
    base_textures, cur_textures = base["textures"], cur["textures"]
    base_meshes, cur_meshes = base["meshes"], cur["meshes"]
    base_shaders, cur_shaders = base["shaders"], cur["shaders"]
    base_materials, cur_materials = base["materials"], cur["materials"]
    removed_items = sorted(set(base_items) - set(cur_items))
    removed_canvases = sorted(set(base_canvases) - set(cur_canvases))
    removed_textures = sorted(set(base_textures) - set(cur_textures))
    removed_meshes = sorted(set(base_meshes) - set(cur_meshes))
    removed_shaders = sorted(set(base_shaders) - set(cur_shaders))
    removed_materials = sorted(set(base_materials) - set(cur_materials))
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
    shaders_out = []
    for shader_id in sorted(cur_shaders):
        cur_shader = cur_shaders[shader_id]
        base_shader = base_shaders.get(shader_id)
        if base_shader is not None and not shader_differs(base_shader, cur_shader):
            continue
        shaders_out.append((shader_id, cur_shader))
    materials_out = []
    for material_id in sorted(cur_materials):
        cur_material = cur_materials[material_id]
        base_material = base_materials.get(material_id)
        if base_material is not None and not material_differs(base_material, cur_material):
            continue
        materials_out.append((material_id, cur_material))
    return (removed_canvases, removed_items, removed_textures, removed_meshes, removed_shaders,
            removed_materials, canvases_out, items_out, textures_out, meshes_out, shaders_out,
            materials_out)


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


def _param_json(p: dict, param_f64: list[float]) -> dict:
    """render-stream-5.md "Material table": one <param> object. "f" is a running offset into
    param_f64 OVER MATERIALS IN TABLE ORDER FIRST, then items in item order (gate5_5-design.md D8
    "param-offset") -- callers must therefore build every material's params (in table order)
    before any item's instance_params."""
    out = {"name": p["name"], "type": p["type"], "n": p["n"], "tex": p["tex"], "f": len(param_f64)}
    param_f64.extend(p["floats"])
    return out


def _shader_json(shader_id: int, s: dict) -> dict:
    return {
        "id": shader_id, "origin": "created", "status": s["status"], "reason": s["reason"],
        "version": s["version"], "mode": s["mode"], "source": s["source"], "hash": s["hash"],
        "payload_bytes": s["payload_bytes"], "builtin": s["builtin"], "uses": s["uses"],
        "default_textures": s["default_textures"],
    }


def _material_json(material_id: int, m: dict, param_f64: list[float]) -> dict:
    return {
        "id": material_id, "origin": "created", "status": m["status"], "reason": m["reason"],
        "version": m["version"], "shader": m["shader"],
        "params": [_param_json(p, param_f64) for p in m["params"]],
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
    shaders: list[tuple[int, dict]],
    materials: list[tuple[int, dict]],
    unsupported: list[dict],
    default_filter: str,
    default_repeat: str,
    *,
    failures: list[dict] | None = None,
    removed_canvases: list[int] | None = None,
    removed_items: list[int] | None = None,
    removed_textures: list[int] | None = None,
    removed_meshes: list[int] | None = None,
    removed_shaders: list[int] | None = None,
    removed_materials: list[int] | None = None,
) -> bytes:
    failures = failures or []
    removed_canvases = removed_canvases or []
    removed_items = removed_items or []
    removed_textures = removed_textures or []
    removed_meshes = removed_meshes or []
    removed_shaders = removed_shaders or []
    removed_materials = removed_materials or []

    # gate5_5-design.md D8 "param-offset": materials' params claim their param_f64 offsets FIRST
    # (table order), so this must run before the items loop below.
    param_f64: list[float] = []
    materials_json = [_material_json(mid, m, param_f64)
                       for mid, m in sorted(materials, key=lambda t: t[0])]

    item_f32: list[float] = []
    cmd_f32: list[float] = []
    cmd_i32: list[int] = []
    items_json = []
    for item_id, item, commands_null in sorted(items, key=lambda t: t[0]):
        commands_json: list[dict] | None
        if commands_null:
            commands_json = None
        else:
            commands_json = [_command_json(c, cmd_f32, cmd_i32) for c in item["commands"]]
        parent = item["parent"]
        entry = {
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
            "material": item["material"],
            "use_parent_material": item["use_parent_material"],
            "instance_params": [_param_json(p, param_f64) for p in item["instance_params"]],
            "content_version": item["content_version"],
            "commands": commands_json,
        }
        items_json.append(entry)
        item_f32 += item["xform"] + item["modulate"] + item["self_modulate"] + item["crect"]

    canvases_json = []
    canvas_f32: list[float] = []
    for canvas_id, canvas in sorted(canvases, key=lambda t: t[0]):
        canvases_json.append({
            "id": canvas_id,
            "origin": canvas.get("origin", "created"),
            "role": canvas["role"],
            "attached": canvas["attached"],
            "layer": canvas["layer"],
            "sublayer": canvas["sublayer"],
            "items": canvas["items"],
        })
        canvas_f32 += canvas["xform"] + canvas["modulate"]

    textures_json = [_texture_json(tid, t) for tid, t in sorted(textures, key=lambda t: t[0])]
    mesh_f32: list[float] = []
    meshes_json = [_mesh_json(mid, m, mesh_f32) for mid, m in sorted(meshes, key=lambda t: t[0])]
    shaders_json = [_shader_json(sid, s) for sid, s in sorted(shaders, key=lambda t: t[0])]

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
        "removed_shaders": removed_shaders,
        "removed_materials": removed_materials,
        "canvases": canvases_json,
        "items": items_json,
        "textures": textures_json,
        "meshes": meshes_json,
        "shaders": shaders_json,
        "materials": materials_json,
    }
    blocks = [f32block("item_f32", item_f32), f32block("canvas_f32", canvas_f32),
              f32block("cmd_f32", cmd_f32), i32block("cmd_i32", cmd_i32),
              f32block("mesh_f32", mesh_f32), f64block("param_f64", param_f64)]
    return encode_record(meta, blocks)


def full_transaction_bytes(seq: int, frame: int, state: dict) -> bytes:
    items = [(iid, state["items"][iid], False) for iid in sorted(state["items"])]
    canvases = [(cid, state["canvases"][cid]) for cid in sorted(state["canvases"])]
    textures = [(tid, state["textures"][tid]) for tid in sorted(state["textures"])]
    meshes = [(mid, state["meshes"][mid]) for mid in sorted(state["meshes"])]
    shaders = [(sid, state["shaders"][sid]) for sid in sorted(state["shaders"])]
    materials = [(mid, state["materials"][mid]) for mid in sorted(state["materials"])]
    return transaction_bytes(
        seq, frame, "full", None, canvases, items, textures, meshes, shaders, materials,
        state["unsupported"], state["default_filter"], state["default_repeat"],
        failures=state["failures"],
    )


def patch_transaction_bytes(seq: int, frame: int, base_seq: int, base: dict, cur: dict) -> bytes:
    (removed_canvases, removed_items, removed_textures, removed_meshes, removed_shaders,
     removed_materials, canvases, items, textures, meshes, shaders, materials) = diff_state(
        base, cur)
    return transaction_bytes(
        seq, frame, "patch", base_seq, canvases, items, textures, meshes, shaders, materials,
        cur["unsupported"], cur["default_filter"], cur["default_repeat"],
        failures=cur["failures"],
        removed_canvases=removed_canvases, removed_items=removed_items,
        removed_textures=removed_textures, removed_meshes=removed_meshes,
        removed_shaders=removed_shaders, removed_materials=removed_materials,
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


# --------------------------------------------------------------------------- the fifteen golden states


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
    material: int | None = None,
    use_parent_material: bool = False,
    instance_params: list[dict] | None = None,
) -> dict:
    return {
        "origin": "created", "parent": parent, "children": children, "xform": xform,
        "modulate": modulate, "self_modulate": self_modulate, "visible": visible,
        "draw_index": draw_index, "z_index": z_index, "z_relative": z_relative, "behind": behind,
        "clip": clip, "custom_rect": custom_rect, "crect": crect,
        "visibility_layer": visibility_layer, "texture_filter": texture_filter,
        "texture_repeat": texture_repeat, "content_version": content_version,
        "commands": commands, "material": material, "use_parent_material": use_parent_material,
        "instance_params": instance_params or [],
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


def root_canvas(items_list: list[int], modulate: list[float] = WHITE, *, layer: int = 0,
                 sublayer: int = 0) -> dict:
    return {"origin": "root-query", "role": "root", "attached": True, "xform": IDENTITY,
            "items": items_list, "modulate": modulate, "layer": layer, "sublayer": sublayer}


# render-stream-6.md "Canvas"/"Golden vectors": a non-root canvas attached to the root viewport
# (state 16-19), a new /6 capability (gate6-design.md D3, Q2).
def canvas_entry(items_list: list[int], *, attached: bool = True, xform: list[float] = IDENTITY,
                  modulate: list[float] = WHITE, layer: int = 0, sublayer: int = 0) -> dict:
    return {"origin": "created", "role": None, "attached": attached, "xform": xform,
            "items": items_list, "modulate": modulate, "layer": layer, "sublayer": sublayer}


def param(name: str, type_: str, *, n: int = 1, tex: int | None = None,
          floats: list[float] | None = None) -> dict:
    assert (tex is not None) == (type_ == "rid"), name
    return {"name": name, "type": type_, "n": n, "tex": tex, "floats": list(floats or [])}


def builtin_cim(blend_mode: str, light_mode: str = "normal", particles_animation: bool = False) -> dict:
    return {"kind": "canvas_item_material", "blend_mode": blend_mode, "light_mode": light_mode,
            "particles_animation": particles_animation}


def shader(
    *, status: str = "ok", reason: str | None = None, version: int, mode: str | None = "canvas_item",
    source: str | None = "payload", hash: str | None = None, payload_bytes: int = 0,
    builtin: dict | None = None, uses: list[str] | None = None,
    default_textures: list[dict] | None = None,
) -> dict:
    return {
        "status": status, "reason": reason, "version": version, "mode": mode, "source": source,
        "hash": hash, "payload_bytes": payload_bytes, "builtin": builtin,
        "uses": sorted(uses or []), "default_textures": default_textures or [],
    }


def material(
    *, status: str = "ok", reason: str | None = None, version: int, shader: int | None = None,
    params: list[dict] | None = None,
) -> dict:
    return {"status": status, "reason": reason, "version": version, "shader": shader,
            "params": params or []}


UNSUPPORTED_ITEM3 = {"op": "canvas_item_add_texture_rect", "item": 3, "reason": "unknown-texture"}
UNSUPPORTED_TEXTURE_ITEM5 = {"op": "canvas_item_add_texture_rect", "item": 5,
                             "reason": "unsupported-texture"}
UNSUPPORTED_MSDF_ITEM6 = {"op": "canvas_item_add_msdf_texture_rect_region", "item": 6,
                          "reason": "unknown-texture"}
BASE_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5]
STATE7_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5, UNSUPPORTED_MSDF_ITEM6]
UNSUPPORTED_MESH_ITEM9 = {"op": "canvas_item_add_mesh", "item": 9, "reason": "unsupported-mesh"}
UNSUPPORTED_UNKNOWN_MESH_ITEM10 = {"op": "canvas_item_add_mesh", "item": 10,
                                   "reason": "unknown-mesh"}
STATE11_UNSUPPORTED = sorted(
    STATE7_UNSUPPORTED + [UNSUPPORTED_MESH_ITEM9, UNSUPPORTED_UNKNOWN_MESH_ITEM10],
    key=lambda u: (u["item"], u["op"]),
)
# new at /5 (state 15): an item-level unsupported-material/unknown-material/param-type entry sorts
# by item ascending like any other. As built (G55w): every session-level ("item": null) entry
# (here, the sticky canvas-light one, gate5_5-design.md D10) sorts FIRST, before any item-level
# entry -- /2's validator invariant already requires every session-level entry to precede every
# item-level one (checked by every protocol version's decoder), so a sticky entry observed mid-
# stream is still reported at the front of unsupported[], not at the position it was first
# observed.
UNSUPPORTED_MATERIAL_ITEM15 = {"op": "canvas_item_set_material", "item": 15,
                                "reason": "unsupported-material"}
UNKNOWN_MATERIAL_ITEM16 = {"op": "canvas_item_set_material", "item": 16,
                            "reason": "unknown-material"}
PARAM_TYPE_ITEM17 = {"op": "canvas_item_set_instance_shader_parameter", "item": 17,
                      "reason": "param-type"}
CANVAS_LIGHT = {"op": "canvas_light_attach_to_canvas", "item": None, "reason": "canvas-light"}
STATE15_UNSUPPORTED = [CANVAS_LIGHT] + sorted(
    STATE11_UNSUPPORTED + [UNSUPPORTED_MATERIAL_ITEM15, UNKNOWN_MATERIAL_ITEM16,
                            PARAM_TYPE_ITEM17],
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
        "textures": textures, "meshes": {}, "shaders": {}, "materials": {},
        "unsupported": list(BASE_UNSUPPORTED), "failures": [],
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
            # gate5-design.md "As built (G5d)" point 6: golden-4's own state 8 uses count=3 over
            # 6 indices, which the real engine refuses (count * 3 > indices.size(),
            # renderer_canvas_render.h Polygon::create) -- harmless to the codecs, but golden-5
            # must not carry the defect forward. count=1 still draws only the first triangle
            # (1 * 3 <= 6), validly.
            add_triangle_array(
                [(0.0, 100.0), (10.0, 100.0), (10.0, 110.0), (0.0, 110.0)],
                [[0.75, 1.0, 0.75, 1.0]], [], [0, 1, 2, 0, 2, 3], 1,
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


# --- state 12, new at /5: shaders, materials, canvas modulate, item material state ------------

# Material 1: the builtin CIM's own three params (gate5_5-design.md Q1a: material_set_param x 3,
# particles_anim_h_frames 1, particles_anim_v_frames 1, particles_anim_loop false), sorted by name.
MATERIAL1_PARAMS = [
    param("particles_anim_h_frames", "int", floats=[1.0]),
    param("particles_anim_loop", "bool", floats=[0.0]),
    param("particles_anim_v_frames", "int", floats=[1.0]),
]

# Material 2: one param of every supported Variant type (gate5_5-design.md D8), sorted by name.
MATERIAL2_PARAMS_V1 = [
    param("p_aabb", "aabb", floats=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]),
    param("p_basis", "basis", floats=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]),
    param("p_bool", "bool", floats=[1.0]),
    param("p_color", "color", floats=[0.2, 0.4, 0.6, 1.0]),
    param("p_float", "float", floats=[2.5]),
    param("p_int", "int", floats=[7.0]),
    param("p_nil", "nil", floats=[]),
    param("p_packed_color_array", "packed_color_array", n=2,
          floats=[0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0]),
    param("p_packed_float32_array", "packed_float32_array", n=3, floats=[0.1, 0.2, 0.3]),
    param("p_packed_float64_array", "packed_float64_array", n=2, floats=[1.5, -1.5]),
    param("p_packed_int32_array", "packed_int32_array", n=3, floats=[1.0, 2.0, 3.0]),
    param("p_packed_int64_array", "packed_int64_array", n=2, floats=[100.0, 200.0]),
    param("p_packed_vector2_array", "packed_vector2_array", n=2, floats=[1.0, 2.0, 3.0, 4.0]),
    param("p_packed_vector3_array", "packed_vector3_array", n=2,
          floats=[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]),
    param("p_packed_vector4_array", "packed_vector4_array", n=1, floats=[1.0, 2.0, 3.0, 4.0]),
    param("p_plane", "plane", floats=[0.0, 0.0, 1.0, 5.0]),
    param("p_projection", "projection",
          floats=[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
    param("p_quaternion", "quaternion", floats=[0.0, 0.0, 0.0, 1.0]),
    param("p_rect2", "rect2", floats=[1.0, 2.0, 3.0, 4.0]),
    param("p_rect2i", "rect2i", floats=[0.0, 0.0, 8.0, 8.0]),
    param("p_rid", "rid", tex=7, floats=[]),
    param("p_transform2d", "transform2d", floats=[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
    param("p_transform3d", "transform3d",
          floats=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]),
    param("p_vector2", "vector2", floats=[1.0, 2.0]),
    param("p_vector2i", "vector2i", floats=[3.0, 4.0]),
    param("p_vector3", "vector3", floats=[1.0, 2.0, 3.0]),
    param("p_vector3i", "vector3i", floats=[4.0, 5.0, 6.0]),
    param("p_vector4", "vector4", floats=[1.0, 2.0, 3.0, 4.0]),
    param("p_vector4i", "vector4i", floats=[5.0, 6.0, 7.0, 8.0]),
]
assert [p["name"] for p in MATERIAL2_PARAMS_V1] == sorted(p["name"] for p in MATERIAL2_PARAMS_V1)
assert {p["type"] for p in MATERIAL2_PARAMS_V1} == set(VARIANT_COMPONENTS)  # every type, once


def _materials_v1() -> dict:
    return {
        1: material(version=1, shader=1, params=MATERIAL1_PARAMS),
        2: material(version=1, shader=2, params=MATERIAL2_PARAMS_V1),
        3: material(version=1, shader=None, params=[]),
    }


def _shaders_v1() -> dict:
    return {
        1: shader(version=1, hash=HASH_SHADER1, payload_bytes=len(SHADER1_CIM_ADD_PAYLOAD),
                  builtin=builtin_cim("add")),
        2: shader(version=1, hash=HASH_SHADER2_V1, payload_bytes=len(SHADER2_TINT_PAYLOAD_V1)),
    }


def item11_cim_material() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 200.0, 0.0],
        draw_index=10, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.25, 0.75, 0.25, 1.0])],
        material=1,
    )


def item12_custom_material() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 220.0, 0.0],
        draw_index=11, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.25, 0.75, 0.5, 1.0])],
        material=2,
        instance_params=[
            param("glow", "float", floats=[0.5]),
            param("hidden_default", "nil", floats=[]),
        ],
    )


def item13_use_parent_material() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 240.0, 0.0],
        draw_index=12, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.75, 0.75, 0.75, 1.0])],
        use_parent_material=True,
    )


def item14_null_shader_material() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 260.0, 0.0],
        draw_index=13, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.75, 0.75, 0.25, 1.0])],
        material=3,
    )


CANVAS12_MODULATE = [0.5, 0.75, 1.0, 1.0]


def state12() -> dict:
    state = state11()
    items = dict(state["items"])
    items[11] = item11_cim_material()
    items[12] = item12_custom_material()
    items[13] = item13_use_parent_material()
    items[14] = item14_null_shader_material()
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
                                         modulate=CANVAS12_MODULATE)}
    state["shaders"] = _shaders_v1()
    state["materials"] = _materials_v1()
    return state


# state 13: ONE parameter change on material 2 (p_float 2.5 -> 9.5); the patch carries exactly
# one materials[] entry.
def state13() -> dict:
    state = state12()
    state["seq"] = 13
    materials = dict(state["materials"])
    params_v2 = [dict(p) for p in MATERIAL2_PARAMS_V1]
    for p in params_v2:
        if p["name"] == "p_float":
            p["floats"] = [9.5]
    materials[2] = material(version=2, shader=2, params=params_v2)
    state["materials"] = materials
    return state


# state 14: ONE shader code change on shader 2 (new hash); the patch carries exactly one
# shaders[] entry.
def state14() -> dict:
    state = state13()
    shaders = dict(state["shaders"])
    shaders[2] = shader(version=2, hash=HASH_SHADER2_V2, payload_bytes=len(SHADER2_TINT_PAYLOAD_V2))
    state["shaders"] = shaders
    return state


def item15_unsupported_material() -> dict:
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 280.0, 0.0],
        draw_index=14, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.25, 0.25, 0.25, 1.0])],
        material=4,
    )


def item16_unknown_material() -> dict:
    # render-stream-5.md "Item"/gate5_5-design.md Q3b: an unknown non-null material RID -> wire
    # "material": null, plus the derived unknown-material entry.
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 300.0, 0.0],
        draw_index=15, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.25, 0.25, 0.25, 1.0])],
        material=None,
    )


def item17_instance_param_type() -> dict:
    # The attempted instance param had an unsupported type: there is nothing representable to
    # carry, so instance_params stays [] and only the derived param-type entry proves it happened.
    return item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 320.0, 0.0],
        draw_index=16, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.25, 0.25, 0.25, 1.0])],
        instance_params=[],
    )


def state15() -> dict:
    state = state14()
    state["seq"] = 15
    items = dict(state["items"])
    items[15] = item15_unsupported_material()
    items[16] = item16_unknown_material()
    items[17] = item17_instance_param_type()
    state["items"] = items
    state["canvases"] = {1: root_canvas(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], modulate=CANVAS12_MODULATE,
    )}
    shaders = dict(state["shaders"])
    shaders[3] = shader(version=1, status="unsupported", reason="shader-time",
                        hash=HASH_SHADER3, payload_bytes=len(SHADER3_TIME_PAYLOAD),
                        uses=["time"])
    state["shaders"] = shaders
    materials = dict(state["materials"])
    materials[4] = material(version=1, shader=3, params=[])
    materials[5] = material(version=1, status="unsupported", reason="param-type", shader=None,
                            params=[])
    state["materials"] = materials
    state["unsupported"] = list(STATE15_UNSUPPORTED)
    return state


# --- states 16-19, new at /6 (G6w): a second canvas, layer changes, removal, a stacking tie ----
# render-stream-6.md "Golden vectors".

CANVAS2_XFORM = [1.0, 0.0, 0.0, 1.0, 50.0, 50.0]
CANVAS2_MODULATE = [0.75, 0.625, 0.25, 1.0]

CANVAS_STACKING_TIE = {"op": "viewport_set_canvas_stacking", "item": None,
                        "reason": "canvas-stacking-tie"}
CANVAS_REPEAT = {"op": "canvas_set_item_mirroring", "item": None, "reason": "canvas-repeat"}
CANVAS_FOLLOW_VIEWPORT = {"op": "canvas_set_parent", "item": None,
                           "reason": "canvas-follow-viewport"}
GLOBAL_CANVAS_TRANSFORM = {"op": "viewport_set_global_canvas_transform", "item": None,
                            "reason": "global-canvas-transform"}
# Session-level entries sort first (no ordering constraint is enforced AMONG them -- only that
# every session-level entry precedes every item-level one); STATE15_UNSUPPORTED's own item-level
# tail is reused verbatim.
STATE19_UNSUPPORTED = (
    [CANVAS_LIGHT, CANVAS_STACKING_TIE, CANVAS_REPEAT, CANVAS_FOLLOW_VIEWPORT,
     GLOBAL_CANVAS_TRANSFORM]
    + STATE15_UNSUPPORTED[1:]
)


def item18() -> dict:
    return item(
        parent=("canvas", 2), children=[], xform=IDENTITY, draw_index=0, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.875, 0.5, 0.125, 1.0])],
    )


def item19() -> dict:
    return item(
        parent=("canvas", 2), children=[], xform=[1.0, 0.0, 0.0, 1.0, 20.0, 0.0], draw_index=1,
        content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], [0.125, 0.5, 0.875, 1.0])],
    )


def state16() -> dict:
    # A second canvas (id 2) attached to the root viewport at layer 1/sublayer 0, with a
    # non-identity transform, a non-white modulate, and two new items (18, 19).
    state = state15()
    state["seq"] = 16
    items = dict(state["items"])
    items[18] = item18()
    items[19] = item19()
    state["items"] = items
    canvases = dict(state["canvases"])
    canvases[2] = canvas_entry([18, 19], xform=CANVAS2_XFORM, modulate=CANVAS2_MODULATE,
                                layer=1, sublayer=0)
    state["canvases"] = canvases
    return state


def state17() -> dict:
    # Relative to 16: ONLY canvas 2's layer changes (1 -> -1) -- the patch carries exactly one
    # canvas entry, nothing else.
    state = state16()
    state["seq"] = 17
    canvases = dict(state["canvases"])
    canvases[2] = canvas_entry([18, 19], xform=CANVAS2_XFORM, modulate=CANVAS2_MODULATE,
                                layer=-1, sublayer=0)
    state["canvases"] = canvases
    return state


def state18() -> dict:
    # Relative to 17: canvas 2 is removed from the viewport (attached: false); its items (18,
    # 19) stay in the table, parented to it, as gate 0 keeps a detached canvas's items.
    state = state17()
    state["seq"] = 18
    canvases = dict(state["canvases"])
    canvases[2] = canvas_entry([18, 19], attached=False, xform=CANVAS2_XFORM,
                                modulate=CANVAS2_MODULATE, layer=-1, sublayer=0)
    state["canvases"] = canvases
    return state


def state19() -> dict:
    # Relative to 18: canvas 2 is reattached (layer 2/sublayer 0, never carrying forward its
    # detached layer -1 -- render-stream-6.md "As built": a freshly (re)attached canvas's
    # layer/sublayer reset) and a third canvas (id 3, no items) is created at the SAME
    # (layer, sublayer) -- a canvas-stacking-tie -- and the session gains canvas-repeat,
    # canvas-follow-viewport and global-canvas-transform together.
    state = state18()
    state["seq"] = 19
    canvases = dict(state["canvases"])
    canvases[2] = canvas_entry([18, 19], attached=True, xform=CANVAS2_XFORM,
                                modulate=CANVAS2_MODULATE, layer=2, sublayer=0)
    canvases[3] = canvas_entry([], layer=2, sublayer=0)
    state["canvases"] = canvases
    state["unsupported"] = list(STATE19_UNSUPPORTED)
    return state


STATES = [state1(), state2(), state3(), state4(), state5(), state6(), state7(), state8(),
          state9(), state10(), state11(), state12(), state13(), state14(), state15(),
          state16(), state17(), state18(), state19()]


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
            elif descriptor["type"] == "f64":
                assert block_len == 8 * descriptor["count"]
                blocks.append(list(struct.unpack_from(f"<{block_len // 8}d", data, pos)))
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
    return {"schema": "render-stream-6-decoded/1", "magic": MAGIC.hex(), "records": records}


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
                              "attached": c["attached"], "layer": c["layer"],
                              "sublayer": c["sublayer"], "items": c["items"], "xform": c["xform"],
                              "modulate": c["modulate"]})
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
            "texture_repeat": it["texture_repeat"], "material": it["material"],
            "use_parent_material": it["use_parent_material"],
            "instance_params": [_resolved_param(p) for p in it["instance_params"]],
            "content_version": it["content_version"],
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
    shaders_out = []
    for sid in sorted(state["shaders"]):
        s = state["shaders"][sid]
        shaders_out.append({
            "id": sid, "origin": "created", "status": s["status"], "reason": s["reason"],
            "version": s["version"], "mode": s["mode"], "source": s["source"], "hash": s["hash"],
            "payload_bytes": s["payload_bytes"], "builtin": s["builtin"], "uses": s["uses"],
            "default_textures": s["default_textures"],
        })
    materials_out = []
    for mid in sorted(state["materials"]):
        m = state["materials"][mid]
        materials_out.append({
            "id": mid, "origin": "created", "status": m["status"], "reason": m["reason"],
            "version": m["version"], "shader": m["shader"],
            "params": [_resolved_param(p) for p in m["params"]],
        })
    return {
        "status": "ok" if not state["failures"] else "capture-failure",
        "failures": state["failures"], "unsupported": state["unsupported"],
        "default_texture_filter": state["default_filter"],
        "default_texture_repeat": state["default_repeat"],
        "canvases": canvases_out, "items": items_out, "textures": textures_out,
        "meshes": meshes_out, "shaders": shaders_out, "materials": materials_out,
    }


def _resolved_param(p: dict) -> dict:
    """render-stream-5.md "Decoded and resolved forms": a <param> resolves to {"name","type",
    "value"}, with "value" a number (n=1, non-rid, non-nil), an array of numbers (a flat packed
    scalar array), an array of arrays (a packed vector/color array, grouped by component count),
    {"tex": <id>} (rid) or null (nil)."""
    name, type_, n, tex, floats = p["name"], p["type"], p["n"], p["tex"], p["floats"]
    if type_ == "nil":
        value = None
    elif type_ == "rid":
        value = {"tex": tex}
    elif type_.startswith("packed_"):
        components = VARIANT_COMPONENTS[type_]
        if components == 1:
            value = list(floats)
        else:
            value = [floats[i : i + components] for i in range(0, len(floats), components)]
    else:
        value = floats[0] if len(floats) == 1 else list(floats)
    return {"name": name, "type": type_, "value": value}


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
# A small, self-contained scene used by the new invalid-vector builders: canvas 1 (modulate
# white), item 1 drawing add_rect with material 1 (shader 1), item 2 (no material). The wire-
# schema rules under test don't need a realistic scene.

MINI_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

MINI_SHADER_CODE = "shader_type canvas_item;\nvoid fragment() {\n\tCOLOR = vec4(1.0);\n}\n"
MINI_SHADER_PAYLOAD = build_shader_payload(MINI_SHADER_CODE)
MINI_SHADER_HASH = shader_payload_sha256(MINI_SHADER_PAYLOAD)
# Sorted by name ascending ("gain" < "tint"): params[] must be sorted strictly ascending by name.
MINI_MATERIAL_PARAMS = [param("gain", "float", floats=[1.0]),
                        param("tint", "color", floats=[1.0, 1.0, 1.0, 1.0])]


def mini_item(material: int | None = None) -> dict:
    return item(parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
                commands=[add_rect([0.0, 0.0, 4.0, 4.0], WHITE)], material=material)


def mini_state(*, with_material: bool = False, item_material: int | None = None) -> dict:
    items = {1: mini_item(material=item_material)}
    shaders = {}
    materials = {}
    if with_material:
        shaders[1] = shader(version=1, hash=MINI_SHADER_HASH, payload_bytes=len(MINI_SHADER_PAYLOAD))
        materials[1] = material(version=1, shader=1, params=MINI_MATERIAL_PARAMS)
    return {
        "items": items, "canvases": {1: root_canvas([1])},
        "textures": {}, "meshes": {}, "shaders": shaders, "materials": materials,
        "unsupported": [], "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }


def mini_session(encoding: str) -> bytes:
    return session_record(MINI_STREAM_ID, "file", encoding, MINI_SESSION_ID, delivery="out-of-band")


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    """name -> (bytes, code, description). Exactly the new failure modes /6 introduces
    (render-stream-6.md "Golden vectors"); every rule /6 leaves unchanged is already covered by
    golden-2/-3/-4/-5/invalid/ and is not re-derived here. No new payload format at /6, so (unlike
    golden-2/-4/-5) there is no build_payload_invalid_vectors() here -- golden-3's precedent."""
    out: dict[str, tuple[bytes, str, str]] = {}

    # bad-magic: a valid /6-shaped recording with the /5 magic byte.
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    valid_recording = recording(records, end)
    bad_magic = bytearray(valid_recording)
    bad_magic[:8] = MAGIC_RS5
    out["bad-magic"] = (bytes(bad_magic), "bad-magic", "magic byte 3 is '5' (GRS5), not '6'")

    # viewport-presentation: presentation_size differs from logical_size under root_size_policy
    # "observe" (presentation_size may differ from logical_size only under "presentation").
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", presentation_size=(999, 999))
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["viewport-presentation"] = (
        recording(records, end), "viewport-entry",
        "presentation_size is [999,999], but root_size_policy is \"observe\" (must equal logical_size)",
    )

    # viewport-oversampling: font_oversampling is zero (must be positive).
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", font_oversampling=0.0)
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["viewport-oversampling"] = (
        recording(records, end), "viewport-entry",
        "font_oversampling is 0, which is not positive",
    )

    # viewport-size-status: host_size_status "match" while host_window_size disagrees with
    # presentation_size (the visible rect still matches logical_size, so this must be
    # "degenerate-window", not "match").
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", host_size_status="match",
                                  host_window_size=(999, 999))
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["viewport-size-status"] = (
        recording(records, end), "viewport-entry",
        "host_size_status is \"match\" but host_window_size [999,999] disagrees with presentation_size [640,360]",
    )

    # publication-rate-null: publication mode "rate" with a null target_fps (must be non-null,
    # 1..240, exactly for "rate").
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "websocket", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", publication_mode="rate",
                                  publication_target_fps=None)
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["publication-rate-null"] = (
        recording(records, end), "publication-entry",
        "publication.mode is \"rate\" but target_fps is null",
    )

    # publication-rate-range: publication mode "rate" with target_fps 300 (out of 1..240).
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "websocket", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", publication_mode="rate",
                                  publication_target_fps=300)
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["publication-rate-range"] = (
        recording(records, end), "publication-entry",
        "publication.target_fps is 300, out of range 1..240",
    )

    # publication-file-rate: a "file" stream declaring publication "rate" (file sinks are always
    # every-frame/null).
    base = mini_state(with_material=True, item_material=1)
    t1 = full_transaction_bytes(1, 1, base)
    bad_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", publication_mode="rate",
                                  publication_target_fps=30)
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["publication-file-rate"] = (
        recording(records, end), "publication-entry",
        "stream.transport is \"file\" but publication.mode is \"rate\"",
    )

    # canvas-entry: a canvas entry whose "sublayer" is a string, not an integer.
    base = mini_state()
    cmd_f32_ce: list[float] = []
    cmd_i32_ce: list[int] = []
    it_ce = base["items"][1]
    items_json_ce = [{
        "id": 1, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
        "visible": True, "draw_index": 0, "z_index": 0, "z_relative": True, "behind": False,
        "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default", "material": None,
        "use_parent_material": False, "instance_params": [], "content_version": 1,
        "commands": [_command_json(c, cmd_f32_ce, cmd_i32_ce) for c in it_ce["commands"]],
    }]
    item_f32_ce = it_ce["xform"] + it_ce["modulate"] + it_ce["self_modulate"] + it_ce["crect"]
    meta_ce = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [], "removed_meshes": [],
        "removed_shaders": [], "removed_materials": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True,
                      "layer": 0, "sublayer": "x",  # WRONG: must be an integer
                      "items": [1]}],
        "items": items_json_ce, "textures": [], "meshes": [], "shaders": [], "materials": [],
    }
    t1_bad = encode_record(meta_ce, [
        f32block("item_f32", item_f32_ce), f32block("canvas_f32", IDENTITY + WHITE),
        f32block("cmd_f32", cmd_f32_ce), i32block("cmd_i32", cmd_i32_ce),
        f32block("mesh_f32", []), f64block("param_f64", []),
    ])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["canvas-entry"] = (
        recording(records, end), "canvas-entry",
        "canvas 1's \"sublayer\" is a string, not an integer",
    )

    # canvas-stacking-tie-miss: two attached canvases (the root and a second one) share
    # (layer, sublayer) 0/0, but no canvas-stacking-tie entry is declared.
    bad_state = mini_state()
    bad_state["canvases"] = dict(bad_state["canvases"])
    bad_state["canvases"][2] = canvas_entry([])  # layer 0, sublayer 0: ties with the root canvas
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["canvas-stacking-tie-miss"] = (
        recording(records, end), "unsupported-mismatch",
        "canvases 1 and 2 both sit at layer 0/sublayer 0, but no canvas-stacking-tie entry is declared",
    )

    # canvas-stacking-tie-false: a canvas-stacking-tie entry declared with no actual tie (one
    # canvas only).
    bad_state = mini_state()
    bad_state["unsupported"] = [CANVAS_STACKING_TIE]
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["canvas-stacking-tie-false"] = (
        recording(records, end), "unsupported-mismatch",
        "a canvas-stacking-tie entry is declared, but only one canvas exists (no tie)",
    )

    # snap-miss: the session declares snap_2d.transforms true, but the transaction carries no
    # snap-2d entry.
    bad_state = mini_state()
    t1 = full_transaction_bytes(1, 1, bad_state)
    bad_session = session_record(MINI_STREAM_ID, "file", "full", MINI_SESSION_ID,
                                  delivery="out-of-band", snap_2d=(True, False))
    records = [bad_session, t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["snap-miss"] = (
        recording(records, end), "unsupported-mismatch",
        "the session declares snap_2d.transforms true, but the transaction has no snap-2d entry",
    )

    # snap-false: a snap-2d entry is declared, but the session's snap_2d is both false.
    bad_state = mini_state()
    bad_state["unsupported"] = [
        {"op": "viewport_set_snap_2d_transforms_to_pixel", "item": None, "reason": "snap-2d"},
    ]
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["snap-false"] = (
        recording(records, end), "unsupported-mismatch",
        "a snap-2d entry is declared, but the session's snap_2d flags are both false",
    )

    # extra-canvas-on-root: an unsupported[] entry naming reason "extra-canvas" -- never legal at
    # /6 (a canvas attached to the root viewport is supported).
    bad_state = mini_state()
    bad_state["unsupported"] = [
        {"op": "viewport_attach_canvas", "item": None, "reason": "extra-canvas"},
    ]
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["extra-canvas-on-root"] = (
        recording(records, end), "unsupported-mismatch",
        "an unsupported[] entry names reason \"extra-canvas\", which is never valid at /6",
    )

    return out


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    stream_id = "0123456789abcdef0123456789abcdef"
    valid = {
        "hello-submitted": {"type": "hello", "protocol": "render-stream/6",
                             "receiver": "gate6-selftest", "credit_stage": "submitted",
                             "inbound_buffer_bytes": 16777216},
        "hello-applied": {"type": "hello", "protocol": "render-stream/6",
                           "receiver": "gate6-selftest-headless", "credit_stage": "applied",
                           "inbound_buffer_bytes": 65535},
        "ack-received": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "received", "t_us": 1000},
        "ack-applied": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "applied", "t_us": 2500},
        "ack-submitted": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "submitted", "t_us": 4200},
        "resync": {"type": "resync", "stream_id": stream_id, "seq": 7, "reason": "unapplied-stale"},
        "error-message-too-large": {"type": "error", "reason": "message-too-large",
                                     "detail": "transaction 42 is 20000000 bytes"},
    }
    invalid = {
        "hello-missing-field": {"type": "hello", "protocol": "render-stream/6", "receiver": "x",
                                 "credit_stage": "submitted"},
        "hello-bad-credit-stage": {"type": "hello", "protocol": "render-stream/6", "receiver": "x",
                                    "credit_stage": "eventually", "inbound_buffer_bytes": 1024},
        "hello-non-integer-buffer": {"type": "hello", "protocol": "render-stream/6", "receiver": "x",
                                      "credit_stage": "submitted", "inbound_buffer_bytes": 1.5},
        "hello-wrong-protocol": {"type": "hello", "protocol": "render-stream/5", "receiver": "x",
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
    presentation_session_id = "44444444444444444444444444444444"
    presentation_stream_id = "4" * 32
    snap_session_id = "55555555555555555555555555555555"
    snap_stream_id = "5" * 32
    rate_session_id = "66666666666666666666666666666666"
    rate_stream_id = "6" * 32

    full_session = session_record(full_stream_id, "file", "full", full_session_id, delivery="out-of-band")
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(full_transaction_bytes(i + 1, i + 1, state))
    full_end = end_record(len(STATES), full_records, diff_ns_total=0, full_transactions=len(STATES),
                           patch_transactions=0, resource_records=0, resource_bytes=0)
    full_rs5 = recording(full_records, full_end)

    patch_session = session_record(patch_stream_id, "file", "patch", patch_session_id, delivery="out-of-band")
    patch_records = [patch_session, full_transaction_bytes(1, 1, STATES[0])]
    for i in range(1, 5):
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_records.append(full_transaction_bytes(6, 6, STATES[5]))  # resync: full again
    for i in range(6, len(STATES)):
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_end = end_record(len(STATES), patch_records, diff_ns_total=12345, full_transactions=2,
                            patch_transactions=len(STATES) - 2, resource_records=0, resource_bytes=0)
    patch_rs5 = recording(patch_records, patch_end)

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
    inline_records.append(resource_record_bytes(HASH_SHADER1, SHADER1_CIM_ADD_PAYLOAD))
    inline_records.append(resource_record_bytes(HASH_SHADER2_V1, SHADER2_TINT_PAYLOAD_V1))
    inline_records.append(full_transaction_bytes(12, 12, STATES[11]))
    inline_records.append(full_transaction_bytes(13, 13, STATES[12]))
    inline_records.append(resource_record_bytes(HASH_SHADER2_V2, SHADER2_TINT_PAYLOAD_V2))
    inline_records.append(resource_record_bytes(HASH_SHADER3, SHADER3_TIME_PAYLOAD))
    inline_records.append(full_transaction_bytes(14, 14, STATES[13]))
    inline_records.append(full_transaction_bytes(15, 15, STATES[14]))
    # states 16-19 (new at /6): no new textures/meshes/shaders, so no new resource records.
    inline_records.append(full_transaction_bytes(16, 16, STATES[15]))
    inline_records.append(full_transaction_bytes(17, 17, STATES[16]))
    inline_records.append(full_transaction_bytes(18, 18, STATES[17]))
    inline_records.append(full_transaction_bytes(19, 19, STATES[18]))
    mesh_payloads = [
        (HASH_MESH1_A, MESH1_SURFACE_A_PAYLOAD), (HASH_MESH1_B, MESH1_SURFACE_B_PAYLOAD),
        (HASH_MESH2_V1, MESH2_SURFACE_V1_PAYLOAD), (HASH_MESH2_V2, MESH2_SURFACE_V2_PAYLOAD),
    ]
    shader_payloads = [
        (HASH_SHADER1, SHADER1_CIM_ADD_PAYLOAD), (HASH_SHADER2_V1, SHADER2_TINT_PAYLOAD_V1),
        (HASH_SHADER2_V2, SHADER2_TINT_PAYLOAD_V2), (HASH_SHADER3, SHADER3_TIME_PAYLOAD),
    ]
    inline_resource_bytes = (len(PAYLOAD_A1) + len(PAYLOAD_F) + len(PAYLOAD_A2) + len(PAYLOAD_P)
                              + len(PAYLOAD_PAGE) + sum(len(p) for _, p in mesh_payloads)
                              + sum(len(p) for _, p in shader_payloads))
    inline_end = end_record(len(STATES), inline_records, diff_ns_total=0,
                             full_transactions=len(STATES), patch_transactions=0,
                             resource_records=5 + len(mesh_payloads) + len(shader_payloads),
                             resource_bytes=inline_resource_bytes)
    inline_rs5 = recording(inline_records, inline_end)

    # presentation.rs6 (render-stream-6.md "Golden vectors"): a small, independent single-
    # transaction recording proving the "presentation" root_size_policy -- canvas_items stretch,
    # logical 1920x1080, presentation 960x540, font_oversampling 0.5, host_final_xform scale 0.5.
    presentation_item = item(
        parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
        commands=[add_rect([0.0, 0.0, 32.0, 32.0], WHITE)],
    )
    presentation_state = {
        "items": {1: presentation_item}, "canvases": {1: root_canvas([1])},
        "textures": {}, "meshes": {}, "shaders": {}, "materials": {},
        "unsupported": [], "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }
    presentation_session = session_record(
        presentation_stream_id, "file", "full", presentation_session_id, delivery="out-of-band",
        logical_size=(1920, 1080), host_window_size=(960, 540), root_size_policy="presentation",
        presentation_size=(960, 540), font_oversampling=0.5, stretch_mode="canvas_items",
        stretch_aspect="keep", host_final_xform=[0.5, 0.0, 0.0, 0.5, 0.0, 0.0],
    )
    presentation_records = [presentation_session,
                             full_transaction_bytes(1, 1, presentation_state)]
    presentation_end = end_record(1, presentation_records, diff_ns_total=0, full_transactions=1,
                                   patch_transactions=0, resource_records=0, resource_bytes=0)
    presentation_rs6 = recording(presentation_records, presentation_end)

    # snap.rs6: both snap_2d flags true; every transaction of the session carries the snap-2d
    # session-level entry (D17: a session-level constant, never derived per-frame) -- a full
    # transaction and an "idle" patch (nothing else changes) both carry it.
    snap_item = item(
        parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], WHITE)],
    )
    snap_state = {
        "items": {1: snap_item}, "canvases": {1: root_canvas([1])},
        "textures": {}, "meshes": {}, "shaders": {}, "materials": {},
        "unsupported": [
            {"op": "viewport_set_snap_2d_transforms_to_pixel", "item": None, "reason": "snap-2d"},
        ],
        "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }
    snap_session = session_record(snap_stream_id, "file", "patch", snap_session_id,
                                   delivery="out-of-band", snap_2d=(True, True))
    snap_records = [snap_session, full_transaction_bytes(1, 1, snap_state),
                     patch_transaction_bytes(2, 2, 1, snap_state, snap_state)]
    snap_end = end_record(2, snap_records, diff_ns_total=0, full_transactions=1,
                           patch_transactions=1, resource_records=0, resource_bytes=0)
    snap_rs6 = recording(snap_records, snap_end)

    # rate.rs6: a recorded live stream (transport websocket), publication rate/30.
    rate_item = item(
        parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
        commands=[add_rect([0.0, 0.0, 16.0, 16.0], WHITE)],
    )
    rate_state = {
        "items": {1: rate_item}, "canvases": {1: root_canvas([1])},
        "textures": {}, "meshes": {}, "shaders": {}, "materials": {},
        "unsupported": [], "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }
    rate_session = session_record(rate_stream_id, "websocket", "full", rate_session_id,
                                   delivery="out-of-band", publication_mode="rate",
                                   publication_target_fps=30)
    rate_records = [rate_session, full_transaction_bytes(1, 1, rate_state)]
    rate_end = end_record(1, rate_records, diff_ns_total=0, full_transactions=1,
                           patch_transactions=0, resource_records=0, resource_bytes=0)
    rate_rs6 = recording(rate_records, rate_end)

    full_decoded = decode(full_rs5)
    patch_decoded = decode(patch_rs5)
    inline_decoded = decode(inline_rs5)
    presentation_decoded = decode(presentation_rs6)
    snap_decoded = decode(snap_rs6)
    rate_decoded = decode(rate_rs6)
    resolved = {
        "schema": "render-stream-6-resolved/1",
        "transactions": [
            {"seq": i + 1, "frame": i + 1, "state": resolved_state(state)}
            for i, state in enumerate(STATES)
        ],
    }
    resolved_presentation = {
        "schema": "render-stream-6-resolved/1",
        "transactions": [{"seq": 1, "frame": 1, "state": resolved_state(presentation_state)}],
    }
    resolved_snap = {
        "schema": "render-stream-6-resolved/1",
        "transactions": [
            {"seq": 1, "frame": 1, "state": resolved_state(snap_state)},
            {"seq": 2, "frame": 2, "state": resolved_state(snap_state)},
        ],
    }
    resolved_rate = {
        "schema": "render-stream-6-resolved/1",
        "transactions": [{"seq": 1, "frame": 1, "state": resolved_state(rate_state)}],
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
        {"hash": HASH_SHADER1, "bytes": len(SHADER1_CIM_ADD_PAYLOAD), "record_index": 21},
        {"hash": HASH_SHADER2_V1, "bytes": len(SHADER2_TINT_PAYLOAD_V1), "record_index": 22},
        {"hash": HASH_SHADER2_V2, "bytes": len(SHADER2_TINT_PAYLOAD_V2), "record_index": 25},
        {"hash": HASH_SHADER3, "bytes": len(SHADER3_TIME_PAYLOAD), "record_index": 26},
    ]

    # corrupt-meta: patch.rs6's seq 3 (record index 3: session=0, seq1=1, seq2=2, seq3=3), first
    # meta byte zeroed -- as every earlier golden's.
    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt = bytearray(patch_rs5)
    assert corrupt[seq3_offset + 8] == ord("{")
    corrupt[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()

    index = {
        "schema": "render-stream-6-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs6", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs5).hexdigest()},
            {"file": "patch.rs6", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs5).hexdigest()},
            {"file": "inline.rs6", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs5).hexdigest()},
        ],
        "resolved": "resolved.json",
        # presentation.rs6/snap.rs6/rate.rs6 (render-stream-6.md "Golden vectors") are each a
        # SEPARATE, independent small recording (its own session, its own scene) -- none resolves
        # to the shared resolved.json the way full/patch/inline do, so each is kept out of "valid"
        # and given its own leg here, mirroring params.rs5's own leg at /5.
        "presentation_leg": {"file": "presentation.rs6", "hex": "presentation.hex",
                              "decoded": "presentation.decoded.json",
                              "sha256": hashlib.sha256(presentation_rs6).hexdigest(),
                              "resolved": "resolved-presentation.json"},
        "snap_leg": {"file": "snap.rs6", "hex": "snap.hex", "decoded": "snap.decoded.json",
                     "sha256": hashlib.sha256(snap_rs6).hexdigest(),
                     "resolved": "resolved-snap.json"},
        "rate_leg": {"file": "rate.rs6", "hex": "rate.hex", "decoded": "rate.decoded.json",
                     "sha256": hashlib.sha256(rate_rs6).hexdigest(),
                     "resolved": "resolved-rate.json"},
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs6", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs6 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs6", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        # No new payload format at /6, so golden-6 carries no "payload_invalid" key -- golden-3's
        # precedent (render-stream-3.md does not change the payload format either).
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
        "shader_payloads": [
            {"file": "payloads/shader1-add.grp", "hash": HASH_SHADER1,
             "bytes": len(SHADER1_CIM_ADD_PAYLOAD)},
            {"file": "payloads/shader2-tint-v1.grp", "hash": HASH_SHADER2_V1,
             "bytes": len(SHADER2_TINT_PAYLOAD_V1)},
            {"file": "payloads/shader2-tint-v2.grp", "hash": HASH_SHADER2_V2,
             "bytes": len(SHADER2_TINT_PAYLOAD_V2)},
            {"file": "payloads/shader3-time.grp", "hash": HASH_SHADER3,
             "bytes": len(SHADER3_TIME_PAYLOAD)},
        ],
    }

    outputs: dict[str, bytes] = {
        "full.rs6": full_rs5,
        "full.hex": to_hex(full_rs5).encode("ascii"),
        "full.decoded.json": pretty(full_decoded),
        "patch.rs6": patch_rs5,
        "patch.hex": to_hex(patch_rs5).encode("ascii"),
        "patch.decoded.json": pretty(patch_decoded),
        "inline.rs6": inline_rs5,
        "inline.hex": to_hex(inline_rs5).encode("ascii"),
        "inline.decoded.json": pretty(inline_decoded),
        "presentation.rs6": presentation_rs6,
        "presentation.hex": to_hex(presentation_rs6).encode("ascii"),
        "presentation.decoded.json": pretty(presentation_decoded),
        "snap.rs6": snap_rs6,
        "snap.hex": to_hex(snap_rs6).encode("ascii"),
        "snap.decoded.json": pretty(snap_decoded),
        "rate.rs6": rate_rs6,
        "rate.hex": to_hex(rate_rs6).encode("ascii"),
        "rate.decoded.json": pretty(rate_decoded),
        "resolved.json": pretty(resolved),
        "resolved-presentation.json": pretty(resolved_presentation),
        "resolved-snap.json": pretty(resolved_snap),
        "resolved-rate.json": pretty(resolved_rate),
        "corrupt-meta.rs6": bytes(corrupt),
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
        "payloads/shader1-add.grp": SHADER1_CIM_ADD_PAYLOAD,
        "payloads/shader2-tint-v1.grp": SHADER2_TINT_PAYLOAD_V1,
        "payloads/shader2-tint-v2.grp": SHADER2_TINT_PAYLOAD_V2,
        "payloads/shader3-time.grp": SHADER3_TIME_PAYLOAD,
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs6"] = data
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
