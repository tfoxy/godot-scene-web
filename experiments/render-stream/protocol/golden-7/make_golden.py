#!/usr/bin/env python3
"""Generate the render-stream/7 golden vectors (stdlib only, deterministic).

render-stream/7 (../render-stream-7.md) is a LIVE-TRANSPORT delta on render-stream/6
(../render-stream-6.md), per gate7-design.md D2/Q2: the magic and protocol string change, the
hello gains nine keys (receiver_kind/credit_window/token/manifest_sha256/five presentation
integers), the session's top-level `publication` key gains `credit_window`, `error.reason` gains
`unauthorized`, and HTTP gains CORS. Records, transactions, payloads and HTTP routes are
byte-identical to /6 -- this script does NOT re-derive golden-6's nineteen full/patch/inline
states (there is no full.rs7/patch.rs7/inline.rs7): it only re-encodes golden-6's "rate" leg
(rate.rs6 -> rate.rs7) and adds one new leg, window2.rs7, proving credit_window 2 (two chained
patches), plus the control (hello) vectors and the three new invalid vectors D2/Q2 ask for.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

rate.rs7: golden-6's rate.rs6 scene (one root canvas, one item, one add_rect), re-encoded under
GRS7/"render-stream/7", publication {"mode":"rate","target_fps":30,"credit_window":1}.
window2.rs7: the SAME scene and session shape, credit_window 2, as three transactions: a full
(seq 1), then two CONSECUTIVE patches whose bases chain (seq 2 bases on seq 1, seq 3 bases on
seq 2) -- nothing in the scene changes, so both patches carry empty canvases/items/textures
arrays (a legitimate "idle frame", the simplest possible chained-patch pair). Both legs resolve
to resolved-rate.json: window2.rs7's three transactions each carry the identical state rate.rs7's
single transaction does (As built, below).

invalid/ (gate7-design.md Q2 "Golden vectors"): bad-magic (golden-6's rate.rs6 verbatim -- a real
GRS6 stream handed to a /7 decoder); publication-window (credit_window 3, out of 1..2); and
publication-file-window (a "file" stream declaring credit_window 2, which must always be 1 on a
file sink).

control/ (gate7-design.md Q2 "Control vectors", used by rs_live_test.cpp's parse_control and the
TypeScript/GDScript self-test hello parsers): valid hellos covering every receiver_kind, both
credit_window values and with/without a token; invalid hellos covering a missing key, an unknown
key, credit_window 0 and 3, a non-hex token, a /6 protocol string and a float dpr_milli.

As built (G7w): "Both resolve to resolved-rate.json" (Q2) is read as "every transaction's
resolved `state`, not the transaction COUNT, matches" -- window2.rs7 has three transactions
where rate.rs7 has one, so self-tests compare window2's transactions[i].state (for every i)
against resolved-rate.json's single transactions[0].state, not the whole resolved document.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN6 = HERE.parent / "golden-6"

MAGIC = bytes([0x47, 0x52, 0x53, 0x37, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS7\r\n\x1a\n"
PROTOCOL = "render-stream/7"
PAYLOAD_SCHEMA = "render-stream-texture/1"
MESH_PAYLOAD_SCHEMA = "render-stream-mesh/1"
SHADER_PAYLOAD_SCHEMA = "render-stream-shader/1"

PIXEL_SIZES = {"L8": 1, "LA8": 2, "R8": 1, "RG8": 2, "RGB8": 3, "RGBA8": 4}
PERMITTED_FORMATS = sorted(PIXEL_SIZES)

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]

# Carried over verbatim from protocol/golden-6/make_golden.py (illustrative session data, not the
# production calibrator roster -- G7w touches no hook, mirror or calibrator file).
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

FEATURE_OPS = sorted([
    "add_rect", "add_texture_rect", "add_texture_rect_region", "add_msdf_texture_rect_region",
    "add_line", "add_polyline", "add_multiline", "add_circle", "add_primitive", "add_polygon",
    "add_triangle_array", "add_nine_patch", "add_mesh", "add_set_transform", "add_clip_ignore",
])
FEATURE_ITEM_STATE = sorted(
    [
        "children", "clip", "custom_rect", "draw_index", "modulate", "parent", "self_modulate",
        "transform", "visibility_layer", "visible", "z_index", "behind", "z_relative",
        "texture_filter", "texture_repeat", "material", "use_parent_material", "instance_params",
    ]
)
FEATURE_CANVAS_STATE = sorted(["modulate", "transform", "layer"])
FEATURE_RESOURCES = sorted(["texture_2d", "texture_2d_placeholder", "mesh", "material", "shader"])
FEATURE_UNSUPPORTED_RESOURCES: list = []
FEATURE_OBSERVED_UNSUPPORTED_OPS = sorted(
    [
        "canvas_item_add_animation_slice", "canvas_item_add_lcd_texture_rect_region",
        "canvas_item_add_multimesh", "canvas_item_add_particles", "canvas_item_attach_skeleton",
        "canvas_light_attach_to_canvas", "canvas_set_item_mirroring", "canvas_set_item_repeat",
        "canvas_set_parent",
    ]
)
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


# --------------------------------------------------------------------------- encoding (framing)
# Framing and canonical JSON are unchanged from /2-/6 (gate7-design.md D2: /7 changes only the
# magic/protocol/hello/publication.credit_window/two error reasons/CORS).


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


def i32s(values: list[int]) -> bytes:
    out = bytearray()
    for value in values:
        out += struct.pack("<i", value)
    return bytes(out)


def f64s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        out += struct.pack("<d", value)
    return bytes(out)


def canonical_json(obj: object) -> bytes:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    raw = text.encode("ascii")
    assert all(0x20 <= b <= 0x7E for b in raw), "meta must be printable ASCII"
    return raw


def f32block(name: str, values: list[float]) -> tuple[str, str, list[float]]:
    return (name, "f32", values)


def i32block(name: str, values: list[int]) -> tuple[str, str, list[int]]:
    return (name, "i32", values)


def f64block(name: str, values: list[float]) -> tuple[str, str, list[float]]:
    return (name, "f64", values)


def encode_record(meta: dict, blocks: list[tuple[str, str, object]]) -> bytes:
    full = dict(meta)
    descriptors = []
    payloads: list[bytes] = []
    for name, btype, values in blocks:
        if btype == "f32":
            payload = f32s(values)  # type: ignore[arg-type]
        elif btype == "i32":
            payload = i32s(values)  # type: ignore[arg-type]
        else:
            assert btype == "f64"
            payload = f64s(values)  # type: ignore[arg-type]
        count = len(values)  # type: ignore[arg-type]
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


# --------------------------------------------------------------------------- session / transaction


def session_record(
    stream_id: str,
    transport: str,
    encoding: str,
    session_id: str,
    *,
    credit_window: int,
    clear_color: list[float] = (0.25, 0.25, 0.5, 1.0),
    host_visible_rect: list[float] | None = None,
    host_final_xform: list[float] = IDENTITY,
    content_scale_factor: float = 1.0,
    logical_size: tuple[int, int] = (640, 360),
    host_window_size: tuple[int, int] = (640, 360),
) -> bytes:
    if host_visible_rect is None:
        host_visible_rect = [0.0, 0.0, float(logical_size[0]), float(logical_size[1])]
    resources = {
        "hash": "sha256",
        "payloads": sorted([MESH_PAYLOAD_SCHEMA, SHADER_PAYLOAD_SCHEMA, PAYLOAD_SCHEMA]),
        "delivery": "out-of-band", "inline_max_bytes": 0, "max_payload_bytes": 16777216,
        "permitted_formats": PERMITTED_FORMATS, "fetch": "directory", "http_path": None,
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
            "stretch": {"mode": "disabled", "aspect": "ignore", "scale_mode": "fractional"},
            "stretch_applied_by": "receiver",
            "root_size_policy": "observe",
            "presentation_size": list(logical_size),
            "host_size_status": "match",
            "host_window_size": list(host_window_size),
            "font_oversampling": 1,
            "snap_2d": {"transforms": False, "vertices": False},
        },
        "resources": resources,
        "materials": {"shader_policy": "source"},
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
        # render-stream-7.md "Session": publication gains credit_window, right after target_fps
        # (gate7-design.md D2/D4). mode "rate"/target_fps 30 matches golden-6's rate.rs6 exactly.
        "publication": {"mode": "rate", "target_fps": 30, "credit_window": credit_window},
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


def item(*, parent: tuple[str, int], content_version: int, commands: list[dict]) -> dict:
    return {
        "origin": "created", "parent": parent, "children": [], "xform": IDENTITY,
        "modulate": WHITE, "self_modulate": WHITE, "visible": True, "draw_index": 0,
        "z_index": 0, "z_relative": True, "behind": False, "clip": False, "custom_rect": False,
        "crect": [0.0, 0.0, 0.0, 0.0], "visibility_layer": 0xFFFFFFFF,
        "texture_filter": "default", "texture_repeat": "default",
        "content_version": content_version, "commands": commands, "material": None,
        "use_parent_material": False, "instance_params": [],
    }


def add_rect(rect: list[float], color: list[float]) -> dict:
    return {"op": "add_rect", "aa": False, "rect": rect, "color": color}


def root_canvas(items_list: list[int]) -> dict:
    return {"origin": "root-query", "role": "root", "attached": True, "xform": IDENTITY,
            "items": items_list, "modulate": WHITE, "layer": 0, "sublayer": 0}


def _command_json(command: dict, cmd_f32: list[float]) -> dict:
    assert command["op"] == "add_rect"
    out = {"op": "add_rect", "aa": command["aa"], "f": len(cmd_f32)}
    cmd_f32 += command["rect"] + command["color"]
    return out


def full_transaction_bytes(seq: int, frame: int, state: dict) -> bytes:
    return _transaction_bytes(seq, frame, "full", None, state["items"], state["canvases"])


def empty_patch_bytes(seq: int, frame: int, base_seq: int, state: dict) -> bytes:
    """A patch against `base_seq` that changes nothing (gate7-design.md Q2's window2.rs7: "two
    consecutive patches whose bases chain") -- the simplest legitimate patch, an idle frame."""
    meta = {
        "type": "transaction", "seq": seq, "frame": frame, "encoding": "patch",
        "base_seq": base_seq, "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": state["default_filter"],
        "default_texture_repeat": state["default_repeat"],
        "removed_canvases": [], "removed_items": [], "removed_textures": [],
        "removed_meshes": [], "removed_shaders": [], "removed_materials": [],
        "canvases": [], "items": [], "textures": [], "meshes": [], "shaders": [], "materials": [],
    }
    # render-stream-5.md "Transaction": six blocks at /5 and later (gate7-design.md D2: /7's
    # transactions are byte-identical to /6/5) -- cmd_i32/mesh_f32/param_f64 stay empty, this
    # scene has no mesh, triangle-array or material entries.
    blocks = [f32block("item_f32", []), f32block("canvas_f32", []), f32block("cmd_f32", []),
              i32block("cmd_i32", []), f32block("mesh_f32", []), f64block("param_f64", [])]
    return encode_record(meta, blocks)


def _transaction_bytes(
    seq: int, frame: int, encoding: str, base_seq: int | None, items: dict, canvases: dict,
) -> bytes:
    item_f32: list[float] = []
    cmd_f32: list[float] = []
    items_json = []
    for item_id in sorted(items):
        it = items[item_id]
        commands_json = [_command_json(c, cmd_f32) for c in it["commands"]]
        parent = it["parent"]
        items_json.append({
            "id": item_id, "origin": it["origin"],
            "parent": {"kind": parent[0], "id": parent[1]},
            "children": it["children"], "visible": it["visible"], "draw_index": it["draw_index"],
            "z_index": it["z_index"], "z_relative": it["z_relative"], "behind": it["behind"],
            "clip": it["clip"], "custom_rect": it["custom_rect"],
            "visibility_layer": it["visibility_layer"], "texture_filter": it["texture_filter"],
            "texture_repeat": it["texture_repeat"], "material": it["material"],
            "use_parent_material": it["use_parent_material"],
            "instance_params": it["instance_params"], "content_version": it["content_version"],
            "commands": commands_json,
        })
        item_f32 += it["xform"] + it["modulate"] + it["self_modulate"] + it["crect"]
    canvas_f32: list[float] = []
    canvases_json = []
    for canvas_id in sorted(canvases):
        c = canvases[canvas_id]
        canvases_json.append({
            "id": canvas_id, "origin": c["origin"], "role": c["role"], "attached": c["attached"],
            "layer": c["layer"], "sublayer": c["sublayer"], "items": c["items"],
        })
        canvas_f32 += c["xform"] + c["modulate"]
    meta = {
        "type": "transaction", "seq": seq, "frame": frame, "encoding": encoding,
        "base_seq": base_seq, "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": "nearest", "default_texture_repeat": "disabled",
        "removed_canvases": [], "removed_items": [], "removed_textures": [],
        "removed_meshes": [], "removed_shaders": [], "removed_materials": [],
        "canvases": canvases_json, "items": items_json, "textures": [], "meshes": [], "shaders": [],
        "materials": [],
    }
    blocks = [f32block("item_f32", item_f32), f32block("canvas_f32", canvas_f32),
              f32block("cmd_f32", cmd_f32), i32block("cmd_i32", []), f32block("mesh_f32", []),
              f64block("param_f64", [])]
    return encode_record(meta, blocks)


def end_record(
    transactions: int, before_end: list[bytes], *, full_transactions: int, patch_transactions: int,
) -> bytes:
    meta = {
        "type": "end",
        "transactions": transactions,
        "reason": "shutdown",
        "stats": {
            "bytes_total": len(MAGIC) + sum(len(r) for r in before_end),
            "encode_ns_total": 250000,
            "snapshot_ns_total": 40000,
            "diff_ns_total": 0,
            "max_record_bytes": max(len(r) for r in before_end),
            "full_transactions": full_transactions,
            "patch_transactions": patch_transactions,
            "resource_records": 0,
            "resource_bytes": 0,
        },
    }
    return encode_record(meta, [])


def recording(records: list[bytes], with_end_record: bytes) -> bytes:
    return MAGIC + b"".join(records) + with_end_record


def to_hex(data: bytes) -> str:
    text = data.hex()
    return "".join(text[i : i + 64] + "\n" for i in range(0, len(text), 64))


def pretty(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=True) + "\n").encode("ascii")


# --------------------------------------------------------------------------- decode (ground truth)


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
                assert descriptor["type"] == "f64"
                assert block_len == 8 * descriptor["count"]
                blocks.append(list(struct.unpack_from(f"<{block_len // 8}d", data, pos)))
            pos += block_len
        assert pos == end
        records.append({
            "offset": start, "byte_length": end - start,
            "sha256": hashlib.sha256(data[start:end]).hexdigest(), "meta": meta, "blocks": blocks,
        })
        pos = end
    return {"schema": "render-stream-7-decoded/1", "magic": MAGIC.hex(), "records": records}


def _resolved_command(command: dict) -> dict:
    assert command["op"] == "add_rect"
    return {"op": "add_rect", "aa": command["aa"], "rect": command["rect"],
            "color": command["color"]}


def resolved_state(state: dict) -> dict:
    canvases_out = []
    for cid in sorted(state["canvases"]):
        c = state["canvases"][cid]
        canvases_out.append({"id": cid, "origin": c["origin"], "role": c["role"],
                              "attached": c["attached"], "layer": c["layer"],
                              "sublayer": c["sublayer"], "items": c["items"], "xform": c["xform"],
                              "modulate": c["modulate"]})
    items_out = []
    for iid in sorted(state["items"]):
        it = state["items"][iid]
        parent = it["parent"]
        items_out.append({
            "id": iid, "origin": it["origin"],
            "parent": {"kind": parent[0], "id": parent[1]},
            "children": it["children"], "visible": it["visible"], "draw_index": it["draw_index"],
            "z_index": it["z_index"], "z_relative": it["z_relative"], "behind": it["behind"],
            "clip": it["clip"], "custom_rect": it["custom_rect"],
            "visibility_layer": it["visibility_layer"], "texture_filter": it["texture_filter"],
            "texture_repeat": it["texture_repeat"], "material": it["material"],
            "use_parent_material": it["use_parent_material"],
            "instance_params": it["instance_params"], "content_version": it["content_version"],
            "xform": it["xform"], "modulate": it["modulate"], "self_modulate": it["self_modulate"],
            "custom_rect_rect": it["crect"],
            "commands": [_resolved_command(c) for c in it["commands"]],
        })
    return {
        "status": "ok", "failures": [], "unsupported": [],
        "default_texture_filter": state["default_filter"],
        "default_texture_repeat": state["default_repeat"],
        "canvases": canvases_out, "items": items_out, "textures": [], "meshes": [], "shaders": [],
        "materials": [],
    }


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    token_a = "a" * 64
    token_b = "b" * 64
    manifest_a = "c" * 64
    valid = {
        "hello-native-w1-token": {
            "type": "hello", "protocol": "render-stream/7", "receiver": "gate7-native",
            "receiver_kind": "native", "credit_stage": "submitted", "credit_window": 1,
            "inbound_buffer_bytes": 16777216, "token": token_a, "manifest_sha256": manifest_a,
            "presentation_backing_w": 640, "presentation_backing_h": 360,
            "presentation_css_w": 640, "presentation_css_h": 360, "dpr_milli": 1000,
        },
        "hello-web-export-w2-notoken": {
            "type": "hello", "protocol": "render-stream/7", "receiver": "gate7-web-export",
            "receiver_kind": "web-export", "credit_stage": "applied", "credit_window": 2,
            "inbound_buffer_bytes": 1048576, "token": None, "manifest_sha256": None,
            "presentation_backing_w": 1280, "presentation_backing_h": 720,
            "presentation_css_w": 1280, "presentation_css_h": 720, "dpr_milli": 1000,
        },
        "hello-gsw-canvas-w1-notoken": {
            "type": "hello", "protocol": "render-stream/7", "receiver": "gate7-gsw-canvas",
            "receiver_kind": "gsw-canvas", "credit_stage": "submitted", "credit_window": 1,
            "inbound_buffer_bytes": 1048576, "token": None, "manifest_sha256": None,
            "presentation_backing_w": 640, "presentation_backing_h": 360,
            "presentation_css_w": 640, "presentation_css_h": 360, "dpr_milli": 2000,
        },
        "hello-native-w2-token": {
            "type": "hello", "protocol": "render-stream/7", "receiver": "gate7-native-w2",
            "receiver_kind": "native", "credit_stage": "applied", "credit_window": 2,
            "inbound_buffer_bytes": 16777216, "token": token_b, "manifest_sha256": None,
            "presentation_backing_w": 640, "presentation_backing_h": 360,
            "presentation_css_w": 640, "presentation_css_h": 360, "dpr_milli": 1000,
        },
    }
    base = valid["hello-native-w1-token"]
    invalid = {
        # a missing key (inbound_buffer_bytes dropped).
        "hello-missing-field": {k: v for k, v in base.items() if k != "inbound_buffer_bytes"},
        # an unknown key.
        "hello-unknown-key": {**base, "extra": 1},
        # credit_window 0 and 3 (outside 1..2).
        "hello-credit-window-0": {**base, "credit_window": 0},
        "hello-credit-window-3": {**base, "credit_window": 3},
        # a non-hex token (odd length / bad characters would both do; use uppercase hex).
        "hello-token-not-hex": {**base, "token": "A" * 64},
        # a /6 protocol string on an otherwise-/7-shaped hello.
        "hello-wrong-protocol": {**base, "protocol": "render-stream/6"},
    }
    return {"valid": valid, "invalid": invalid}


# --------------------------------------------------------------------------- outputs


def build() -> dict[str, bytes]:
    rate_stream_id = "7" * 32
    rate_session_id = "7" * 32
    window2_stream_id = "8" * 32
    window2_session_id = "8" * 32

    scene_item = item(parent=("canvas", 1), content_version=1,
                       commands=[add_rect([0.0, 0.0, 16.0, 16.0], WHITE)])
    state = {
        "items": {1: scene_item}, "canvases": {1: root_canvas([1])},
        "default_filter": "nearest", "default_repeat": "disabled",
    }

    # rate.rs7: golden-6's rate.rs6 scene, re-encoded as /7 with credit_window 1.
    rate_session = session_record(rate_stream_id, "websocket", "full", rate_session_id,
                                   credit_window=1)
    rate_records = [rate_session, full_transaction_bytes(1, 1, state)]
    rate_end = end_record(1, rate_records, full_transactions=1, patch_transactions=0)
    rate_rs7 = recording(rate_records, rate_end)

    # window2.rs7: the same scene, credit_window 2, a full transaction plus two chained
    # no-op patches (gate7-design.md Q2: "two consecutive patches whose bases chain").
    window2_session = session_record(window2_stream_id, "websocket", "patch", window2_session_id,
                                      credit_window=2)
    window2_records = [
        window2_session,
        full_transaction_bytes(1, 1, state),
        empty_patch_bytes(2, 2, 1, state),
        empty_patch_bytes(3, 3, 2, state),
    ]
    window2_end = end_record(3, window2_records, full_transactions=1, patch_transactions=2)
    window2_rs7 = recording(window2_records, window2_end)

    rate_decoded = decode(rate_rs7)
    window2_decoded = decode(window2_rs7)
    resolved_rate = {
        "schema": "render-stream-7-resolved/1",
        "transactions": [{"seq": 1, "frame": 1, "state": resolved_state(state)}],
    }

    # --- invalid/ -------------------------------------------------------------------------------
    invalid: dict[str, tuple[bytes, str, str]] = {}

    # bad-magic: a real GRS6 stream (golden-6's own rate.rs6, byte for byte) handed to a /7
    # decoder (gate7-design.md Q2: "invalid/ holds bad-magic (GRS6)").
    rate_rs6_bytes = (GOLDEN6 / "rate.rs6").read_bytes()
    invalid["bad-magic"] = (
        rate_rs6_bytes, "bad-magic", "magic byte 3 is '6' (GRS6), not '7'",
    )

    # publication-window: credit_window 3 on a websocket stream (out of 1..2).
    bad_session = session_record("9" * 32, "websocket", "full", "9" * 32, credit_window=3)
    bad_records = [bad_session, full_transaction_bytes(1, 1, state)]
    bad_end = end_record(1, bad_records, full_transactions=1, patch_transactions=0)
    invalid["publication-window"] = (
        recording(bad_records, bad_end), "publication-entry",
        "publication.credit_window is 3, out of range 1..2",
    )

    # publication-file-window: a "file" stream declaring credit_window 2 (a file sink's
    # credit_window is always 1).
    bad_file_session = session_record("a" * 32, "file", "full", "a" * 32, credit_window=2)
    bad_file_records = [bad_file_session, full_transaction_bytes(1, 1, state)]
    bad_file_end = end_record(1, bad_file_records, full_transactions=1, patch_transactions=0)
    invalid["publication-file-window"] = (
        recording(bad_file_records, bad_file_end), "publication-entry",
        "stream.transport is \"file\" but publication.credit_window is 2, not 1",
    )

    control = control_messages()

    index = {
        "schema": "render-stream-7-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [],
        "resolved": "resolved-rate.json",
        "rate_leg": {"file": "rate.rs7", "hex": "rate.hex", "decoded": "rate.decoded.json",
                     "sha256": hashlib.sha256(rate_rs7).hexdigest(),
                     "resolved": "resolved-rate.json"},
        "window2_leg": {"file": "window2.rs7", "hex": "window2.hex",
                         "decoded": "window2.decoded.json",
                         "sha256": hashlib.sha256(window2_rs7).hexdigest(),
                         "resolved": "resolved-rate.json"},
        "inline_resources": [],
        "corrupt": [],
        "invalid": [
            {"file": f"invalid/{name}.rs7", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        "payloads": [],
    }

    outputs: dict[str, bytes] = {
        "rate.rs7": rate_rs7,
        "rate.hex": to_hex(rate_rs7).encode("ascii"),
        "rate.decoded.json": pretty(rate_decoded),
        "window2.rs7": window2_rs7,
        "window2.hex": to_hex(window2_rs7).encode("ascii"),
        "window2.decoded.json": pretty(window2_decoded),
        "resolved-rate.json": pretty(resolved_rate),
        "index.json": pretty(index),
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs7"] = data
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
