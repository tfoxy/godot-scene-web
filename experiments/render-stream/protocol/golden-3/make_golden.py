#!/usr/bin/env python3
"""Generate the render-stream/3 golden vectors (stdlib only, deterministic).

render-stream/3 (../render-stream-3.md) is render-stream/2 (../render-stream-2.md) plus exactly
one new draw command, `add_msdf_texture_rect_region`, and one new host sabotage kind,
`perturb-glyph` (gate4-design.md D1, G4e1). G4e1 implements /3 in the SAME codec modules as /2,
behind a protocol-version switch, rather than forking a new module the way /1 forked from /0 and
/2 forked from /1 -- so this script, too, re-derives /2's six states verbatim (byte for byte
identical scene, just re-encoded with the GRS3 magic and the "render-stream/3" protocol string)
and then adds a seventh state that is /2's state 6 plus one new item and one new texture, drawing
three `add_msdf_texture_rect_region` commands:

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

    7  (new) item 6 appears (draw_index 5), drawing three msdf commands against a brand-new
       16x16 RGBA8 texture 7 ("the page" -- a stand-in; the real atlas is 512x512, D5):
         - outline 0, a plain rect
         - outline 4, a negative-width rect (a flip)
         - a third command naming a texture RID the capture never saw: unsupported/unknown-texture,
           with the matching derived top-level unsupported[] entry (as item 3's unknown-texture
           command already demonstrates for add_texture_rect)

full.rs3 encodes all seven states as full transactions, directory (out-of-band) delivery.
patch.rs3 encodes the same seven states patch-encoded (seq 6 full again, as after a resync; seq 7
patch-encoded against seq 6). inline.rs3 encodes all seven as full transactions again, but with
inline delivery: a resource record for each hash (the four from /2's scene, plus the page's)
precedes the first transaction whose resolved texture table needs it. All three resolve to the
same resolved.json (stream_id and per-transaction "encoding" excepted, as /2's and /1's goldens --
memory: rs1-resolved-json-excepted-fields).

invalid/ vectors cover exactly the five NEW failure modes gate4-design.md's G4e1 section lists
(the five codes /2's own vectors already cover for every unchanged rule are not re-derived here):
a GRS2 stream (bad-magic), an msdf command whose declared "f" treats it as 12 floats instead of
14 (cmd-offset), a negative "outline" (meta-schema), an msdf command naming a texture id with no
table entry (texture-ref), and an unsupported msdf command missing its derived top-level
unsupported-texture-shaped entry (unsupported-mismatch).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MAGIC = bytes([0x47, 0x52, 0x53, 0x33, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS3\r\n\x1a\n"
MAGIC_RS2 = bytes([0x47, 0x52, 0x53, 0x32, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS2\r\n\x1a\n"
GRT1_MAGIC = bytes([0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRT1\r\n\x1a\n"
PROTOCOL = "render-stream/3"
PAYLOAD_SCHEMA = "render-stream-texture/1"

ITEM_FLOATS = 18  # xform 6, modulate 4, self_modulate 4, custom_rect 4 -- unchanged from /2
CANVAS_FLOATS = 6  # xform 6 -- unchanged from /2
CMD_FLOATS = {
    "add_rect": 8,
    "add_texture_rect": 8,
    "add_texture_rect_region": 12,
    "add_msdf_texture_rect_region": 14,  # new at /3: rect 4, src 4, modulate 4, px_range, scale
    "unsupported": 0,
}

PIXEL_SIZES = {"L8": 1, "LA8": 2, "R8": 1, "RG8": 2, "RGB8": 3, "RGBA8": 4}
PERMITTED_FORMATS = sorted(PIXEL_SIZES)

FILTERS = ["default", "nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
           "nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic"]
REPEATS = ["default", "disabled", "enabled", "mirror"]

# Carried over verbatim from protocol/golden-2/make_golden.py (itself carried over from
# golden-1's): illustrative session data, not the production calibrator roster.
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

# render-stream-3.md "Features": /2's ops plus add_msdf_texture_rect_region.
FEATURE_OPS = sorted(["add_rect", "add_texture_rect", "add_texture_rect_region",
                      "add_msdf_texture_rect_region"])
FEATURE_ITEM_STATE = sorted(
    [
        "children", "clip", "custom_rect", "draw_index", "modulate", "parent", "self_modulate",
        "transform", "visibility_layer", "visible", "z_index", "behind", "z_relative",
        "texture_filter", "texture_repeat",
    ]
)
FEATURE_RESOURCES = sorted(["texture_2d", "texture_2d_placeholder"])
FEATURE_UNSUPPORTED_RESOURCES = []
# /2's observed_unsupported_ops, minus canvas_item_add_msdf_texture_rect_region (now a supported
# op instead -- render-stream-3.md "Features"). canvas_item_add_clip_ignore (gate3-design.md D4,
# calibrator 6) stays refused at /3 too: it is not one of the ops /3 adds support for.
FEATURE_OBSERVED_UNSUPPORTED_OPS = sorted(
    [
        "canvas_item_add_circle", "canvas_item_add_clip_ignore", "canvas_item_add_line",
        "canvas_item_add_mesh", "canvas_item_add_multimesh", "canvas_item_add_nine_patch",
        "canvas_item_add_polygon", "canvas_item_add_polyline", "canvas_item_add_primitive",
        "canvas_item_add_set_transform", "canvas_item_add_lcd_texture_rect_region",
        "canvas_item_add_triangle_array", "canvas_item_set_material",
    ]
)
# Unchanged from /2 (render-stream-3.md "Features": "every other features key... is unchanged
# from /2"), including canvas_item_set_visibility_notifier (gate3-design.md D6, calibrator 6).
FEATURE_UNOBSERVED = sorted(
    [
        "canvas_item_set_canvas_group_mode",
        "canvas_item_set_instance_shader_parameter", "canvas_item_set_light_mask",
        "canvas_item_set_sort_children_by_y", "canvas_item_set_visibility_notifier",
        "canvas_set_modulate", "canvas_texture_set_shading_parameters",
        "texture_set_size_override", "viewport_remove_canvas", "viewport_set_canvas_cull_mask",
        "viewport_set_global_canvas_transform",
    ]
)
PUBLICATION = "snapshot-or-patch"

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]


# --------------------------------------------------------------------------- encoding (framing)
# Identical to golden-2/make_golden.py: record framing, canonical JSON and the u8 block type are
# all unchanged at /3 (render-stream-3.md: "render-stream/3 is render-stream/2 plus exactly...").


def u32(value: int) -> bytes:
    assert 0 <= value <= 0xFFFFFFFF
    return struct.pack("<I", value)


def f32s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        packed = struct.pack("<f", value)
        assert struct.unpack("<f", packed)[0] == value, value
        out += packed
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
        else:
            assert btype == "u8"
            payload = bytes(values)  # type: ignore[arg-type]
            count = len(payload)
        if name == short_block:
            payload = payload[: len(payload) - (4 if btype == "f32" else 1)]
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


# Payloads #1-4: verbatim from golden-2 (A/Atwin's content, A's state-3 update, F, P's
# replacement). Payload #5 ("the page", new at /3): a stand-in RGBA8 atlas page for the new item 6
# at state 7. gate4-design.md's real MSDF atlas is 512x512 at msdf_size 48 (D5), but a codec-level
# golden vector only needs to exercise the wire shape, not a realistic page -- a 512x512 page
# bloated golden-3/ to 4.9 MB (its bytes are repeated inline in inline.rs3/.hex) against golden-2's
# 0.8 MB, so this uses 16x16, the same size already used for textures A/Atwin/N in the shared
# six-state scene (gate4-design.md G4e1, amended, "As built").
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
            "hash": "sha256", "payload": PAYLOAD_SCHEMA, "delivery": "out-of-band",
            "inline_max_bytes": 0, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "directory", "http_path": None,
            "auth": "none",
        }
    else:
        assert delivery == "inline"
        resources = {
            "hash": "sha256", "payload": PAYLOAD_SCHEMA, "delivery": "inline",
            "inline_max_bytes": 16777216, "max_payload_bytes": 16777216,
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


def diff_state(base: dict, cur: dict):
    base_items, cur_items = base["items"], cur["items"]
    base_canvases, cur_canvases = base["canvases"], cur["canvases"]
    base_textures, cur_textures = base["textures"], cur["textures"]
    removed_items = sorted(set(base_items) - set(cur_items))
    removed_canvases = sorted(set(base_canvases) - set(cur_canvases))
    removed_textures = sorted(set(base_textures) - set(cur_textures))
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
    return removed_canvases, removed_items, removed_textures, canvases_out, items_out, textures_out


def _command_json(command: dict, cmd_f32: list[float]) -> dict:
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


def transaction_bytes(
    seq: int,
    frame: int,
    encoding: str,
    base_seq: int | None,
    canvases: list[tuple[int, dict]],
    items: list[tuple[int, dict, bool]],
    textures: list[tuple[int, dict]],
    unsupported: list[dict],
    default_filter: str,
    default_repeat: str,
    *,
    failures: list[dict] | None = None,
    removed_canvases: list[int] | None = None,
    removed_items: list[int] | None = None,
    removed_textures: list[int] | None = None,
    short_block: str | None = None,
) -> bytes:
    failures = failures or []
    removed_canvases = removed_canvases or []
    removed_items = removed_items or []
    removed_textures = removed_textures or []
    item_f32: list[float] = []
    canvas_f32: list[float] = []
    cmd_f32: list[float] = []
    items_json = []
    for item_id, item, commands_null in sorted(items, key=lambda t: t[0]):
        commands_json: list[dict] | None
        if commands_null:
            commands_json = None
        else:
            commands_json = [_command_json(c, cmd_f32) for c in item["commands"]]
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
        "canvases": canvases_json,
        "items": items_json,
        "textures": textures_json,
    }
    blocks = [f32block("item_f32", item_f32), f32block("canvas_f32", canvas_f32),
              f32block("cmd_f32", cmd_f32)]
    return encode_record(meta, blocks, short_block=short_block)


def full_transaction_bytes(seq: int, frame: int, state: dict, *, short_block: str | None = None) -> bytes:
    items = [(iid, state["items"][iid], False) for iid in sorted(state["items"])]
    canvases = [(cid, state["canvases"][cid]) for cid in sorted(state["canvases"])]
    textures = [(tid, state["textures"][tid]) for tid in sorted(state["textures"])]
    return transaction_bytes(
        seq, frame, "full", None, canvases, items, textures, state["unsupported"],
        state["default_filter"], state["default_repeat"], failures=state["failures"],
        short_block=short_block,
    )


def patch_transaction_bytes(seq: int, frame: int, base_seq: int, base: dict, cur: dict) -> bytes:
    removed_canvases, removed_items, removed_textures, canvases, items, textures = diff_state(base, cur)
    return transaction_bytes(
        seq, frame, "patch", base_seq, canvases, items, textures, cur["unsupported"],
        cur["default_filter"], cur["default_repeat"], failures=cur["failures"],
        removed_canvases=removed_canvases, removed_items=removed_items,
        removed_textures=removed_textures,
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


# --------------------------------------------------------------------------- the seven golden states


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


def root_canvas(items_list: list[int]) -> dict:
    return {"origin": "root-query", "role": "root", "attached": True, "xform": IDENTITY,
            "items": items_list}


UNSUPPORTED_ITEM3 = {"op": "canvas_item_add_texture_rect", "item": 3, "reason": "unknown-texture"}
UNSUPPORTED_TEXTURE_ITEM5 = {"op": "canvas_item_add_texture_rect", "item": 5,
                             "reason": "unsupported-texture"}
# new at state 7: item 6's third msdf command names an RID the capture never saw (render-stream-3.md
# "Command": "A texture RID the mirror never saw created gives unsupported/unknown-texture, as for
# the other texture commands").
UNSUPPORTED_MSDF_ITEM6 = {"op": "canvas_item_add_msdf_texture_rect_region", "item": 6,
                          "reason": "unknown-texture"}
BASE_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5]
STATE7_UNSUPPORTED = [UNSUPPORTED_ITEM3, UNSUPPORTED_TEXTURE_ITEM5, UNSUPPORTED_MSDF_ITEM6]


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
        "textures": textures, "unsupported": list(BASE_UNSUPPORTED), "failures": [],
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
    # /2's state 6 (frozen, unchanged) plus one new item and one new texture (gate4-design.md
    # G4e1: "/2's six states re-encoded as /3, plus seq 7 with three msdf commands... a new
    # RGBA8 page").
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


STATES = [state1(), state2(), state3(), state4(), state5(), state6(), state7()]


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
    return {"schema": "render-stream-3-decoded/1", "magic": MAGIC.hex(), "records": records}


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
    return {
        "status": "ok" if not state["failures"] else "capture-failure",
        "failures": state["failures"], "unsupported": state["unsupported"],
        "default_texture_filter": state["default_filter"],
        "default_texture_repeat": state["default_repeat"],
        "canvases": canvases_out, "items": items_out, "textures": textures_out,
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
    assert op == "unsupported"
    return {"op": "unsupported", "name": command["name"], "reason": command["reason"]}


# --------------------------------------------------------------------------- mini fixture (invalid vectors)
#
# A small, self-contained scene used by the new invalid-vector builders: canvas 1, item 1
# (top-level) drawing add_msdf_texture_rect_region against texture 1 (a 16x16 RGBA8 image, reused
# as a stand-in "page" -- the invalid vectors below test wire-schema rules, not atlas realism).

MINI_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MINI_DATA = bytes(range(64))  # 4x4 RGBA8 = 64 bytes, deterministic
MINI_PAYLOAD = build_payload("RGBA8", 4, 4, False, MINI_DATA)
MINI_HASH = payload_sha256(MINI_PAYLOAD)


def mini_msdf_item() -> dict:
    return item(parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
                commands=[add_msdf_texture_rect_region(1, 0, [0.0, 0.0, 4.0, 4.0],
                                                         [0.0, 0.0, 4.0, 4.0])])


def mini_texture() -> dict:
    return texture(kind="image", version=1, hash=MINI_HASH, format="RGBA8", width=4, height=4,
                   payload_bytes=len(MINI_PAYLOAD))


def mini_state() -> dict:
    return {
        "items": {1: mini_msdf_item()}, "canvases": {1: root_canvas([1])},
        "textures": {1: mini_texture()}, "unsupported": [], "failures": [],
        "default_filter": "nearest", "default_repeat": "disabled",
    }


def mini_session(encoding: str) -> bytes:
    return session_record(MINI_STREAM_ID, "file", encoding, MINI_SESSION_ID, delivery="out-of-band")


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    """name -> (bytes, code, description). Exactly the five NEW failure modes G4e1 adds
    (gate4-design.md "G4e1: render-stream/3", "Golden vectors"); every other code /2's own
    invalid/ vectors already cover for a rule /3 leaves unchanged."""
    out: dict[str, tuple[bytes, str, str]] = {}

    # bad-magic: a valid /3-shaped recording with the /2 magic byte.
    base = mini_state()
    t1 = full_transaction_bytes(1, 1, base)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    valid_recording = recording(records, end)
    bad_magic = bytearray(valid_recording)
    bad_magic[:8] = MAGIC_RS2
    out["bad-magic"] = (bytes(bad_magic), "bad-magic", "magic byte 3 is '2' (GRS2), not '3'")

    # cmd-offset: item 1 draws add_msdf_texture_rect_region (14 floats, f=0) then add_rect, whose
    # declared f=12 assumes the preceding msdf command was 12 floats (region-sized) instead of 14.
    mixed_state = mini_state()
    mixed_item = dict(mixed_state["items"][1])
    mixed_item["commands"] = [
        add_msdf_texture_rect_region(1, 0, [0.0, 0.0, 4.0, 4.0], [0.0, 0.0, 4.0, 4.0]),
        add_rect([0.0, 0.0, 4.0, 4.0], WHITE),
    ]
    mixed_state["items"] = {1: mixed_item}
    cmd_f32: list[float] = []
    msdf_json = _command_json(mixed_item["commands"][0], cmd_f32)  # f=0, consumes 14 floats
    assert msdf_json["f"] == 0 and len(cmd_f32) == 14
    rect_json = {"op": "add_rect", "aa": False, "f": 12}  # WRONG: should be 14
    cmd_f32 += mixed_item["commands"][1]["rect"] + mixed_item["commands"][1]["color"]
    items_json = [{
        "id": 1, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
        "visible": True, "draw_index": 0, "z_index": 0, "z_relative": True, "behind": False,
        "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default", "content_version": 1,
        "commands": [msdf_json, rect_json],
    }]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": items_json, "textures": [_texture_json(1, mixed_state["textures"][1])],
    }
    item_f32 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] + WHITE + WHITE + NO_RECT
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32)])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["cmd-offset"] = (
        recording(records, end), "cmd-offset",
        "add_rect declares f=12, but the preceding add_msdf_texture_rect_region consumed 14 floats",
    )

    # meta-schema: an add_msdf_texture_rect_region command with "outline": -1 (the spec requires
    # an int >= 0, render-stream-3.md "Command").
    base = mini_state()
    t1 = full_transaction_bytes(1, 1, base)
    # Rewrite the command's "outline" in the already-encoded meta JSON would require re-parsing;
    # instead build the transaction by hand with the same floats but a bad "outline".
    cmd_f32 = []
    msdf_json = _command_json(base["items"][1]["commands"][0], cmd_f32)
    msdf_json["outline"] = -1
    items_json = [{
        "id": 1, "origin": "created", "parent": {"kind": "canvas", "id": 1}, "children": [],
        "visible": True, "draw_index": 0, "z_index": 0, "z_relative": True, "behind": False,
        "clip": False, "custom_rect": False, "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default", "content_version": 1,
        "commands": [msdf_json],
    }]
    meta = {
        "type": "transaction", "seq": 1, "frame": 1, "encoding": "full", "base_seq": None,
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [],
        "canvases": [{"id": 1, "origin": "root-query", "role": "root", "attached": True, "items": [1]}],
        "items": items_json, "textures": [_texture_json(1, base["textures"][1])],
    }
    item_f32 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] + WHITE + WHITE + NO_RECT
    t1_bad = encode_record(meta, [f32block("item_f32", item_f32), f32block("canvas_f32", IDENTITY),
                                   f32block("cmd_f32", cmd_f32)])
    records = [mini_session("full"), t1_bad]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["meta-schema"] = (
        recording(records, end), "meta-schema",
        "item 1's add_msdf_texture_rect_region declares outline -1 (must be an integer >= 0)",
    )

    # texture-ref: item 1's msdf command names texture 99, which has no table entry at all.
    base = mini_state()
    bad_item = dict(base["items"][1])
    bad_item["commands"] = [add_msdf_texture_rect_region(99, 0, [0.0, 0.0, 4.0, 4.0],
                                                            [0.0, 0.0, 4.0, 4.0])]
    bad_state = dict(base)
    bad_state["items"] = {1: bad_item}
    bad_state["unsupported"] = []
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["texture-ref"] = (
        recording(records, end), "texture-ref",
        "item 1's add_msdf_texture_rect_region names texture 99, which has no entry in the resolved table",
    )

    # unsupported-mismatch: item 1 draws an unsupported msdf command (unknown-texture), but the
    # transaction omits the required derived unsupported[] entry.
    base = mini_state()
    bad_item = dict(base["items"][1])
    bad_item["commands"] = [unsupported_cmd("canvas_item_add_msdf_texture_rect_region",
                                             "unknown-texture")]
    bad_state = dict(base)
    bad_state["items"] = {1: bad_item}
    bad_state["unsupported"] = []  # missing the derived entry
    t1 = full_transaction_bytes(1, 1, bad_state)
    records = [mini_session("full"), t1]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                      resource_records=0, resource_bytes=0)
    out["unsupported-mismatch"] = (
        recording(records, end), "unsupported-mismatch",
        "item 1 draws an unsupported add_msdf_texture_rect_region with no derived unsupported[] entry",
    )

    return out


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    stream_id = "0123456789abcdef0123456789abcdef"
    valid = {
        "hello-submitted": {"type": "hello", "protocol": "render-stream/3",
                             "receiver": "gate4-selftest", "credit_stage": "submitted",
                             "inbound_buffer_bytes": 16777216},
        "hello-applied": {"type": "hello", "protocol": "render-stream/3",
                           "receiver": "gate4-selftest-headless", "credit_stage": "applied",
                           "inbound_buffer_bytes": 65535},
        "ack-received": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "received", "t_us": 1000},
        "ack-applied": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "applied", "t_us": 2500},
        "ack-submitted": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "submitted", "t_us": 4200},
        "resync": {"type": "resync", "stream_id": stream_id, "seq": 7, "reason": "unapplied-stale"},
        "error-message-too-large": {"type": "error", "reason": "message-too-large",
                                     "detail": "transaction 42 is 20000000 bytes"},
    }
    invalid = {
        "hello-missing-field": {"type": "hello", "protocol": "render-stream/3", "receiver": "x",
                                 "credit_stage": "submitted"},
        "hello-bad-credit-stage": {"type": "hello", "protocol": "render-stream/3", "receiver": "x",
                                    "credit_stage": "eventually", "inbound_buffer_bytes": 1024},
        "hello-non-integer-buffer": {"type": "hello", "protocol": "render-stream/3", "receiver": "x",
                                      "credit_stage": "submitted", "inbound_buffer_bytes": 1.5},
        "hello-wrong-protocol": {"type": "hello", "protocol": "render-stream/2", "receiver": "x",
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
    full_end = end_record(7, full_records, diff_ns_total=0, full_transactions=7, patch_transactions=0,
                           resource_records=0, resource_bytes=0)
    full_rs3 = recording(full_records, full_end)

    patch_session = session_record(patch_stream_id, "file", "patch", patch_session_id, delivery="out-of-band")
    patch_records = [patch_session, full_transaction_bytes(1, 1, STATES[0])]
    for i in range(1, 5):
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_records.append(full_transaction_bytes(6, 6, STATES[5]))  # resync: full again
    patch_records.append(patch_transaction_bytes(7, 7, 6, STATES[5], STATES[6]))
    patch_end = end_record(7, patch_records, diff_ns_total=12345, full_transactions=2,
                            patch_transactions=5, resource_records=0, resource_bytes=0)
    patch_rs3 = recording(patch_records, patch_end)

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
    inline_resource_bytes = (len(PAYLOAD_A1) + len(PAYLOAD_F) + len(PAYLOAD_A2) + len(PAYLOAD_P)
                              + len(PAYLOAD_PAGE))
    inline_end = end_record(7, inline_records, diff_ns_total=0, full_transactions=7,
                             patch_transactions=0, resource_records=5,
                             resource_bytes=inline_resource_bytes)
    inline_rs3 = recording(inline_records, inline_end)

    full_decoded = decode(full_rs3)
    patch_decoded = decode(patch_rs3)
    inline_decoded = decode(inline_rs3)
    resolved = {
        "schema": "render-stream-3-resolved/1",
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
    ]

    # corrupt-meta: patch.rs3's seq 3 (record index 3: session=0, seq1=1, seq2=2, seq3=3), first
    # meta byte zeroed -- as golden-2's.
    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt = bytearray(patch_rs3)
    assert corrupt[seq3_offset + 8] == ord("{")
    corrupt[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()

    index = {
        "schema": "render-stream-3-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs3", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs3).hexdigest()},
            {"file": "patch.rs3", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs3).hexdigest()},
            {"file": "inline.rs3", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs3).hexdigest()},
        ],
        "resolved": "resolved.json",
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs3", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs3 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs3", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
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
    }

    outputs: dict[str, bytes] = {
        "full.rs3": full_rs3,
        "full.hex": to_hex(full_rs3).encode("ascii"),
        "full.decoded.json": pretty(full_decoded),
        "patch.rs3": patch_rs3,
        "patch.hex": to_hex(patch_rs3).encode("ascii"),
        "patch.decoded.json": pretty(patch_decoded),
        "inline.rs3": inline_rs3,
        "inline.hex": to_hex(inline_rs3).encode("ascii"),
        "inline.decoded.json": pretty(inline_decoded),
        "resolved.json": pretty(resolved),
        "corrupt-meta.rs3": bytes(corrupt),
        "index.json": pretty(index),
        "payloads/a1.grt": PAYLOAD_A1,
        "payloads/a2.grt": PAYLOAD_A2,
        "payloads/f.grt": PAYLOAD_F,
        "payloads/p.grt": PAYLOAD_P,
        "payloads/page.grt": PAYLOAD_PAGE,
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs3"] = data
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
