#!/usr/bin/env python3
"""Generate the render-stream/1 golden vectors (stdlib only, deterministic).

The wire format is specified in ../render-stream-1.md (which extends
../render-stream-0.md). This script is the reference encoder: the C++ codec
(capture/src/rs1_codec.cpp) and diff (capture/src/rs1_diff.cpp) must reproduce
full.rs1 and patch.rs1 byte for byte, and the TypeScript and GDScript decoders
must turn them into full.decoded.json / patch.decoded.json and resolve both
to resolved.json.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Every float is a multiple of 1/256 with an exact float32 encoding, so a float
never depends on a decimal parser (as in protocol/golden/make_golden.py).

Six logical states (STATE 1..6) describe the same small scene over time:

    1  initial: items 1 (top-level, child 3), 2 (top-level, unsupported cmd),
       3 (child of 1), 4 (top-level, `behind`); canvas 1 holds [1,2,4]
    2  item 2 moves (transform-only: content_version unchanged)
    3  item 4 freed; item 5 created (top-level); item 2's draw_index changes
       (no content change); item 1 recoloured (content_version bump)
    4  unchanged
    5  item 5 reparented under item 1, landing on item 3's draw_index (0):
       a draw-index tie between items 3 and 5, both drawing
    6  unchanged from 5, re-sent in full (as a resync would)

full.rs1 encodes all six as full transactions. patch.rs1 encodes seq 1 and 6
as full (6 as if after a resync) and seq 2-5 as patches against the previous
state, using the render-stream-1.md "Patch transactions" inclusion rule.
Both streams resolve to the same six states (resolved.json), which the
self-tests compare against with the stream_id and per-transaction "encoding"
fields excepted, since those legitimately differ between the two streams.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MAGIC = bytes([0x47, 0x52, 0x53, 0x31, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS1\r\n\x1a\n"
MAGIC_RS0 = bytes([0x47, 0x52, 0x53, 0x30, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS0\r\n\x1a\n"
PROTOCOL = "render-stream/1"

ITEM_FLOATS = 18  # xform 6, modulate 4, self_modulate 4, custom_rect 4
CANVAS_FLOATS = 6  # xform 6
RECT_FLOATS = 8  # rect 4, colour 4

# Carried over verbatim from protocol/golden/make_golden.py: gate 1 does not change the hook
# roster (that is G1a/G1c1's job in entry.cpp), so the golden session reuses the same constants.
HOOKS_PLANNED = sorted(
    [
        "canvas_create",
        "canvas_item_add_circle",
        "canvas_item_add_line",
        "canvas_item_add_mesh",
        "canvas_item_add_msdf_texture_rect_region",
        "canvas_item_add_multimesh",
        "canvas_item_add_nine_patch",
        "canvas_item_add_polygon",
        "canvas_item_add_polyline",
        "canvas_item_add_primitive",
        "canvas_item_add_rect",
        "canvas_item_add_set_transform",
        "canvas_item_add_texture_rect",
        "canvas_item_add_texture_rect_region",
        "canvas_item_add_triangle_array",
        "canvas_item_clear",
        "canvas_item_create",
        "canvas_item_set_clip",
        "canvas_item_set_custom_rect",
        "canvas_item_set_draw_index",
        "canvas_item_set_material",
        "canvas_item_set_modulate",
        "canvas_item_set_parent",
        "canvas_item_set_self_modulate",
        "canvas_item_set_transform",
        "canvas_item_set_visibility_layer",
        "canvas_item_set_visible",
        "canvas_item_set_z_index",
        "free",
        "material_set_param",
        "mesh_add_surface",
        "mesh_clear",
        "mesh_create",
        "mesh_set_custom_aabb",
        "mesh_surface_update_attribute_region",
        "mesh_surface_update_vertex_region",
        "shader_create_from_code",
        "shader_set_code",
        "texture_2d_create",
        "texture_2d_update",
        "viewport_attach_canvas",
        "viewport_set_canvas_transform",
    ]
)

FEATURE_OPS = ["add_rect"]
# render-stream-1.md "Session": gate 0's item_state plus "behind" and "z_relative", sorted
# ascending by byte value ("behind" < "children"; "z_index" < "z_relative").
FEATURE_ITEM_STATE = sorted(
    [
        "children",
        "clip",
        "custom_rect",
        "draw_index",
        "modulate",
        "parent",
        "self_modulate",
        "transform",
        "visibility_layer",
        "visible",
        "z_index",
        "behind",
        "z_relative",
    ]
)
FEATURE_OBSERVED_UNSUPPORTED_OPS = sorted(
    [
        "canvas_item_add_circle",
        "canvas_item_add_line",
        "canvas_item_add_mesh",
        "canvas_item_add_msdf_texture_rect_region",
        "canvas_item_add_multimesh",
        "canvas_item_add_nine_patch",
        "canvas_item_add_polygon",
        "canvas_item_add_polyline",
        "canvas_item_add_primitive",
        "canvas_item_add_set_transform",
        "canvas_item_add_texture_rect",
        "canvas_item_add_texture_rect_region",
        "canvas_item_add_triangle_array",
        "canvas_item_set_material",
    ]
)
# render-stream-1.md "Session": gate 0's unobserved list plus
# "viewport_set_global_canvas_transform", sorted ascending.
FEATURE_UNOBSERVED = sorted(
    [
        "canvas_item_set_canvas_group_mode",
        "canvas_item_set_default_texture_filter",
        "canvas_item_set_default_texture_repeat",
        "canvas_item_set_draw_behind_parent",
        "canvas_item_set_instance_shader_parameter",
        "canvas_item_set_light_mask",
        "canvas_item_set_sort_children_by_y",
        "canvas_item_set_z_as_relative_to_parent",
        "canvas_set_modulate",
        "viewport_remove_canvas",
        "viewport_set_canvas_cull_mask",
        "viewport_set_global_canvas_transform",
    ]
)
PUBLICATION = "snapshot-or-patch"

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]


# --------------------------------------------------------------------------- encoding (framing)
#
# Record framing, canonical JSON and the u32le/f32le primitives are unchanged from render-stream-
# 0.md ("Everything this document does not change is exactly as in render-stream-0.md"), so these
# helpers are the same as protocol/golden/make_golden.py's.


def u32(value: int) -> bytes:
    assert 0 <= value <= 0xFFFFFFFF
    return struct.pack("<I", value)


def f32s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        packed = struct.pack("<f", value)
        assert struct.unpack("<f", packed)[0] == value, value
        assert (value * 256).is_integer(), value
        out += packed
    return bytes(out)


def f32_pattern(values: list[float]) -> list[bytes]:
    """The 32-bit pattern of each float, for the patch inclusion rule's bitwise comparison."""
    return [struct.pack("<f", v) for v in values]


def canonical_json(obj: object) -> bytes:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    raw = text.encode("ascii")
    assert all(0x20 <= b <= 0x7E for b in raw), "meta must be printable ASCII"
    return raw


def encode_record(
    meta: dict, blocks: list[tuple[str, list[float]]], short_block: str | None = None
) -> bytes:
    full = dict(meta)
    full["blocks"] = [{"name": n, "type": "f32", "count": len(v)} for n, v in blocks]
    meta_raw = canonical_json(full)
    body = bytearray()
    body += u32(len(meta_raw))
    body += meta_raw
    body += u32(len(blocks))
    for name, values in blocks:
        payload = f32s(values)
        if name == short_block:
            payload = payload[:-4]
        body += u32(len(payload))
        body += payload
    return u32(len(body)) + bytes(body)


# --------------------------------------------------------------------------- session


def session_record(
    stream_id: str,
    transport: str,
    encoding: str,
    session_id: str,
    *,
    host_size_status: str = "match",
) -> bytes:
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
        "features": {
            "ops": FEATURE_OPS,
            "item_state": FEATURE_ITEM_STATE,
            "observed_unsupported_ops": FEATURE_OBSERVED_UNSUPPORTED_OPS,
            "unobserved": FEATURE_UNOBSERVED,
            "publication": PUBLICATION,
        },
        "sabotage": None,
    }
    blocks = [
        ("clear_color", [0.25, 0.25, 0.5, 1.0]),
        ("root_canvas_xform", IDENTITY),
        ("host_visible_rect", [0.0, 0.0, 640.0, 360.0]),
        ("host_final_xform", IDENTITY),
        ("content_scale_factor", [1.0]),
    ]
    return encode_record(meta, blocks)


# --------------------------------------------------------------------------- transaction model
#
# A "state" is {"canvases": {id: canvas_dict}, "items": {id: item_dict}, "unsupported": [...],
# "failures": [...]}. canvas_dict: {"origin","role","attached","xform","items"}. item_dict:
# {"origin","parent": (kind,id)|None,"children","xform","modulate","self_modulate","visible",
# "draw_index","z_index","z_relative","behind","clip","custom_rect","crect","visibility_layer",
# "content_version","commands"}. `unsupported`/`failures` are hand-computed per state (render-
# stream-1.md's draw-index-tie detection is a *mirror* responsibility in production, per gate1-
# design.md G1b2 -- this generator plays that role for its own fixed, by-hand-verified states).


def item_differs(a: dict, b: dict) -> bool:
    for key in (
        "parent",
        "children",
        "visible",
        "draw_index",
        "z_index",
        "z_relative",
        "behind",
        "clip",
        "custom_rect",
        "visibility_layer",
        "content_version",
    ):
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


def diff_state(
    base: dict, cur: dict
) -> tuple[list[int], list[int], list[tuple[int, dict]], list[tuple[int, dict, bool]]]:
    """render-stream-1.md "Patch transactions": removed ids, then the entries that are new or
    differ (ascending by id), with each item's `commands_null` decided by its content_version."""
    base_items, cur_items = base["items"], cur["items"]
    base_canvases, cur_canvases = base["canvases"], cur["canvases"]
    removed_items = sorted(set(base_items) - set(cur_items))
    removed_canvases = sorted(set(base_canvases) - set(cur_canvases))
    items_out: list[tuple[int, dict, bool]] = []
    for item_id in sorted(cur_items):
        cur_item = cur_items[item_id]
        base_item = base_items.get(item_id)
        if base_item is not None and not item_differs(base_item, cur_item):
            continue
        commands_null = base_item is not None and base_item["content_version"] == cur_item["content_version"]
        items_out.append((item_id, cur_item, commands_null))
    canvases_out: list[tuple[int, dict]] = []
    for canvas_id in sorted(cur_canvases):
        cur_canvas = cur_canvases[canvas_id]
        base_canvas = base_canvases.get(canvas_id)
        if base_canvas is not None and not canvas_differs(base_canvas, cur_canvas):
            continue
        canvases_out.append((canvas_id, cur_canvas))
    return removed_canvases, removed_items, canvases_out, items_out


def transaction_bytes(
    seq: int,
    frame: int,
    encoding: str,
    base_seq: int | None,
    canvases: list[tuple[int, dict]],
    items: list[tuple[int, dict, bool]],
    unsupported: list[dict],
    *,
    failures: list[dict] | None = None,
    removed_canvases: list[int] | None = None,
    removed_items: list[int] | None = None,
    short_block: str | None = None,
) -> bytes:
    failures = failures or []
    removed_canvases = removed_canvases or []
    removed_items = removed_items or []
    item_f32: list[float] = []
    canvas_f32: list[float] = []
    cmd_f32: list[float] = []
    items_json = []
    for item_id, item, commands_null in sorted(items, key=lambda t: t[0]):
        commands_json: list[dict] | None
        if commands_null:
            commands_json = None
        else:
            commands_json = []
            for command in item["commands"]:
                if command["op"] == "add_rect":
                    commands_json.append(
                        {"op": "add_rect", "aa": command["aa"], "f": len(cmd_f32)}
                    )
                    cmd_f32 += command["rect"] + command["color"]
                else:
                    commands_json.append({"op": "unsupported", "name": command["name"]})
        parent = item["parent"]
        items_json.append(
            {
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
                "content_version": item["content_version"],
                "commands": commands_json,
            }
        )
        item_f32 += item["xform"] + item["modulate"] + item["self_modulate"] + item["crect"]
    canvases_json = []
    for canvas_id, canvas in sorted(canvases, key=lambda t: t[0]):
        canvases_json.append(
            {
                "id": canvas_id,
                "origin": canvas.get("origin", "created"),
                "role": canvas["role"],
                "attached": canvas["attached"],
                "items": canvas["items"],
            }
        )
        canvas_f32 += canvas["xform"]
    meta = {
        "type": "transaction",
        "seq": seq,
        "frame": frame,
        "encoding": encoding,
        "base_seq": base_seq,
        "status": "ok" if not failures else "capture-failure",
        "failures": failures,
        "unsupported": unsupported,
        "removed_canvases": removed_canvases,
        "removed_items": removed_items,
        "canvases": canvases_json,
        "items": items_json,
    }
    blocks = [("item_f32", item_f32), ("canvas_f32", canvas_f32), ("cmd_f32", cmd_f32)]
    return encode_record(meta, blocks, short_block=short_block)


def full_transaction_bytes(seq: int, frame: int, state: dict, *, short_block: str | None = None) -> bytes:
    items = [(iid, state["items"][iid], False) for iid in sorted(state["items"])]
    canvases = [(cid, state["canvases"][cid]) for cid in sorted(state["canvases"])]
    return transaction_bytes(
        seq,
        frame,
        "full",
        None,
        canvases,
        items,
        state["unsupported"],
        failures=state["failures"],
        short_block=short_block,
    )


def patch_transaction_bytes(seq: int, frame: int, base_seq: int, base: dict, cur: dict) -> bytes:
    removed_canvases, removed_items, canvases, items = diff_state(base, cur)
    return transaction_bytes(
        seq,
        frame,
        "patch",
        base_seq,
        canvases,
        items,
        cur["unsupported"],
        failures=cur["failures"],
        removed_canvases=removed_canvases,
        removed_items=removed_items,
    )


def end_record(
    transactions: int,
    before_end: list[bytes],
    *,
    diff_ns_total: int,
    full_transactions: int,
    patch_transactions: int,
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
        },
    }
    return encode_record(meta, [])


def recording(records: list[bytes], with_end_record: bytes | None) -> bytes:
    out = MAGIC + b"".join(records)
    if with_end_record is not None:
        out += with_end_record
    return out


# --------------------------------------------------------------------------- the six golden states


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
    content_version: int,
    commands: list[dict],
) -> dict:
    return {
        "origin": "created",
        "parent": parent,
        "children": children,
        "xform": xform,
        "modulate": modulate,
        "self_modulate": self_modulate,
        "visible": visible,
        "draw_index": draw_index,
        "z_index": z_index,
        "z_relative": z_relative,
        "behind": behind,
        "clip": clip,
        "custom_rect": custom_rect,
        "crect": crect,
        "visibility_layer": visibility_layer,
        "content_version": content_version,
        "commands": commands,
    }


def add_rect(rect: list[float], color: list[float], *, aa: bool = False) -> dict:
    return {"op": "add_rect", "aa": aa, "rect": rect, "color": color}


def unsupported_cmd(name: str) -> dict:
    return {"op": "unsupported", "name": name}


def root_canvas(items_list: list[int]) -> dict:
    return {"origin": "root-query", "role": "root", "attached": True, "xform": IDENTITY, "items": items_list}


UNSUPPORTED_ITEM2 = {"op": "canvas_item_add_circle", "item": 2, "reason": "unsupported-op"}
TIE_ITEM3_5 = {"op": "canvas_item_set_draw_index", "item": 3, "reason": "draw-index-tie"}


def state1() -> dict:
    items = {
        1: item(
            parent=("canvas", 1),
            children=[3],
            xform=[1.0, 0.0, 0.0, 1.0, 10.0, 10.0],
            draw_index=0,
            content_version=1,
            commands=[add_rect([0.0, 0.0, 20.0, 20.0], [1.0, 0.0, 0.0, 1.0])],
        ),
        2: item(
            parent=("canvas", 1),
            children=[],
            xform=[1.0, 0.0, 0.0, 1.0, 50.0, 10.0],
            draw_index=1,
            z_relative=False,
            content_version=1,
            commands=[
                add_rect([0.0, 0.0, 16.0, 16.0], [0.0, 1.0, 0.0, 1.0], aa=True),
                unsupported_cmd("canvas_item_add_circle"),
            ],
        ),
        3: item(
            parent=("item", 1),
            children=[],
            xform=[1.0, 0.0, 0.0, 1.0, 0.0, 30.0],
            draw_index=0,
            content_version=1,
            commands=[add_rect([0.0, 0.0, 8.0, 8.0], [0.0, 0.0, 1.0, 1.0])],
        ),
        4: item(
            parent=("canvas", 1),
            children=[],
            xform=[1.0, 0.0, 0.0, 1.0, 90.0, 10.0],
            draw_index=2,
            behind=True,
            content_version=1,
            commands=[add_rect([0.0, 0.0, 12.0, 12.0], [1.0, 1.0, 0.0, 1.0])],
        ),
    }
    canvases = {1: root_canvas([1, 2, 4])}
    return {"items": items, "canvases": canvases, "unsupported": [UNSUPPORTED_ITEM2], "failures": []}


def state2() -> dict:
    state = state1()
    # Transform-only: content_version unchanged, no new commands.
    state["items"] = dict(state["items"])
    moved = dict(state["items"][2])
    moved["xform"] = [1.0, 0.0, 0.0, 1.0, 50.0, 40.0]
    state["items"][2] = moved
    return state


def state3() -> dict:
    state = state2()
    items = dict(state["items"])
    del items[4]  # freed
    recoloured = dict(items[1])
    recoloured["content_version"] = 2
    recoloured["commands"] = [add_rect([0.0, 0.0, 20.0, 20.0], [0.5, 0.0, 0.5, 1.0])]
    items[1] = recoloured
    reindexed = dict(items[2])
    reindexed["draw_index"] = 4
    items[2] = reindexed
    items[5] = item(
        parent=("canvas", 1),
        children=[],
        xform=[1.0, 0.0, 0.0, 1.0, 130.0, 10.0],
        draw_index=3,
        content_version=1,
        commands=[add_rect([0.0, 0.0, 10.0, 10.0], [1.0, 0.0, 1.0, 1.0])],
    )
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2, 5])}
    return state


def state4() -> dict:
    return state3()  # unchanged


def state5() -> dict:
    state = state4()
    items = dict(state["items"])
    parent1 = dict(items[1])
    parent1["children"] = [3, 5]
    items[1] = parent1
    moved5 = dict(items[5])
    moved5["parent"] = ("item", 1)
    moved5["draw_index"] = 0  # ties with item 3's draw_index under item 1
    items[5] = moved5
    state["items"] = items
    state["canvases"] = {1: root_canvas([1, 2])}
    state["unsupported"] = [UNSUPPORTED_ITEM2, TIE_ITEM3_5]
    return state


def state6() -> dict:
    return state5()  # unchanged; re-sent in full, as after a resync


STATES = [state1(), state2(), state3(), state4(), state5(), state6()]


# --------------------------------------------------------------------------- decoding (shared framing)


def decode(data: bytes) -> dict:
    """The decoded form a decoder must produce for a valid /1 recording (same framing as /0)."""
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
            assert block_len == 4 * meta["blocks"][index]["count"]
            blocks.append(list(struct.unpack_from(f"<{block_len // 4}f", data, pos)))
            pos += block_len
        assert pos == end
        records.append(
            {
                "offset": start,
                "byte_length": end - start,
                "sha256": hashlib.sha256(data[start:end]).hexdigest(),
                "meta": meta,
                "blocks": blocks,
            }
        )
    return {"schema": "render-stream-1-decoded/1", "magic": MAGIC.hex(), "records": records}


def to_hex(data: bytes) -> str:
    text = data.hex()
    return "".join(text[i : i + 64] + "\n" for i in range(0, len(text), 64))


def pretty(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=True) + "\n").encode("ascii")


# --------------------------------------------------------------------------- resolved.json (ground truth)
#
# Built directly from STATES, independent of any decode/resolve algorithm under test: these ARE
# the resolved states by construction. Shape per render-stream-1.md "Decoded and resolved forms",
# minus the top-level session_id/stream_id and the per-transaction "encoding" field, which the
# spec explicitly excepts from the full.rs1-vs-patch.rs1 comparison (they legitimately differ
# between the two streams). A self-test strips those same fields from its own resolveRecording()
# output before comparing against this file.


def resolved_state(state: dict) -> dict:
    canvases_out = []
    for cid in sorted(state["canvases"]):
        c = state["canvases"][cid]
        canvases_out.append(
            {"id": cid, "origin": c.get("origin", "created"), "role": c["role"], "attached": c["attached"], "items": c["items"], "xform": c["xform"]}
        )
    items_out = []
    for iid in sorted(state["items"]):
        it = state["items"][iid]
        commands_out = []
        for command in it["commands"]:
            if command["op"] == "add_rect":
                commands_out.append({"op": "add_rect", "aa": command["aa"], "rect": command["rect"], "color": command["color"]})
            else:
                commands_out.append({"op": "unsupported", "name": command["name"]})
        parent = it["parent"]
        items_out.append(
            {
                "id": iid,
                "origin": it.get("origin", "created"),
                "parent": None if parent is None else {"kind": parent[0], "id": parent[1]},
                "children": it["children"],
                "visible": it["visible"],
                "draw_index": it["draw_index"],
                "z_index": it["z_index"],
                "z_relative": it["z_relative"],
                "behind": it["behind"],
                "clip": it["clip"],
                "custom_rect": it["custom_rect"],
                "visibility_layer": it["visibility_layer"],
                "content_version": it["content_version"],
                "xform": it["xform"],
                "modulate": it["modulate"],
                "self_modulate": it["self_modulate"],
                "custom_rect_rect": it["crect"],
                "commands": commands_out,
            }
        )
    return {
        "status": "ok" if not state["failures"] else "capture-failure",
        "failures": state["failures"],
        "unsupported": state["unsupported"],
        "canvases": canvases_out,
        "items": items_out,
    }


# --------------------------------------------------------------------------- mini fixture for invalid vectors
#
# A small, self-contained 2-item base (item 1 top-level under canvas 1, item 2 a child of item 1)
# used by the invalid-vector builders below. Kept separate from STATES so each invalid vector is
# easy to read in isolation.

MINI_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def mini_item1() -> dict:
    return item(
        parent=("canvas", 1),
        children=[2],
        xform=IDENTITY,
        draw_index=0,
        content_version=1,
        commands=[add_rect([0.0, 0.0, 10.0, 10.0], [1.0, 0.0, 0.0, 1.0])],
    )


def mini_item2() -> dict:
    return item(
        parent=("item", 1),
        children=[],
        xform=[1.0, 0.0, 0.0, 1.0, 0.0, 20.0],
        draw_index=0,
        content_version=1,
        commands=[add_rect([0.0, 0.0, 10.0, 10.0], [0.0, 1.0, 0.0, 1.0])],
    )


def mini_state() -> dict:
    return {
        "items": {1: mini_item1(), 2: mini_item2()},
        "canvases": {1: root_canvas([1])},
        "unsupported": [],
        "failures": [],
    }


def mini_session(encoding: str) -> bytes:
    return session_record(MINI_STREAM_ID, "file", encoding, MINI_SESSION_ID)


def mini_valid_patch_recording() -> list[bytes]:
    """session + t1(full) + t2(patch, unchanged) -- a clean 2-transaction recording, used as the
    base for bad-magic and no-end (each flawed in a way unrelated to the transaction content)."""
    base = mini_state()
    t1 = full_transaction_bytes(1, 1, base)
    t2 = patch_transaction_bytes(2, 2, 1, base, base)
    return [mini_session("patch"), t1, t2]


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    """name -> (bytes, code, description), matching render-stream-1.md "Golden vectors"."""
    base = mini_state()
    out: dict[str, tuple[bytes, str, str]] = {}

    # bad-magic: a valid /1-shaped recording, but with the /0 magic byte.
    valid_records = mini_valid_patch_recording()
    valid_end = end_record(len(valid_records) - 1, valid_records, diff_ns_total=100, full_transactions=1, patch_transactions=1)
    valid_recording = recording(valid_records, valid_end)
    bad_magic = bytearray(valid_recording)
    bad_magic[:8] = MAGIC_RS0
    out["bad-magic"] = (bytes(bad_magic), "bad-magic", "magic byte 3 is '0' (GRS0), not '1'")

    # patch-first: the very first transaction of the stream is a patch.
    t1_patch_first = transaction_bytes(1, 1, "patch", 1, [], [], [])
    records = [mini_session("patch"), t1_patch_first]
    end = end_record(1, records, diff_ns_total=0, full_transactions=0, patch_transactions=1)
    out["patch-first"] = (
        recording(records, end),
        "patch-base",
        "seq 1 is encoded as a patch, but a stream's first transaction must be full",
    )

    # patch-base-gap: seq 3's base_seq names seq 1 instead of the previous transaction, seq 2.
    t1 = full_transaction_bytes(1, 1, base)
    t2 = patch_transaction_bytes(2, 2, 1, base, base)
    t3_gap = transaction_bytes(3, 3, "patch", 1, [], [], [])  # should be base_seq 2
    records = [mini_session("patch"), t1, t2, t3_gap]
    end = end_record(3, records, diff_ns_total=0, full_transactions=1, patch_transactions=2)
    out["patch-base-gap"] = (
        recording(records, end),
        "patch-base",
        "seq 3 declares base_seq 1, but the previous transaction's seq is 2",
    )

    # patch-after-gap: seq 3 never arrives; seq 4 is a patch on it (base_seq 3), as after a lost
    # live message (G1c2's drop-message sabotage). The gap is reported, not the base: decoders
    # check seq continuity before the patch rules.
    t4_after_gap = transaction_bytes(4, 4, "patch", 3, [], [], [])
    records = [mini_session("patch"), t1, t2, t4_after_gap]
    end = end_record(3, records, diff_ns_total=0, full_transactions=1, patch_transactions=2)
    out["patch-after-gap"] = (
        recording(records, end),
        "seq-gap",
        "seq 4 (a patch on seq 3) follows seq 2: seq 3 is missing",
    )

    # full-with-base: a full transaction with a non-null base_seq.
    items = [(iid, base["items"][iid], False) for iid in sorted(base["items"])]
    canvases = [(cid, base["canvases"][cid]) for cid in sorted(base["canvases"])]
    t1_full_with_base = transaction_bytes(1, 1, "full", 1, canvases, items, [])
    records = [mini_session("full"), t1_full_with_base]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0)
    out["full-with-base"] = (
        recording(records, end),
        "patch-encoding",
        "seq 1 is encoded as full but carries a non-null base_seq",
    )

    # removed-unknown: removed_items names an id that was never in the base.
    t1 = full_transaction_bytes(1, 1, base)
    t2_bad = transaction_bytes(2, 2, "patch", 1, [], [], [], removed_items=[99])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1)
    out["removed-unknown"] = (
        recording(records, end),
        "patch-removed",
        "seq 2 removes item 99, which is absent from the base state",
    )

    # removed-and-present: item 2 is both removed and present in the same patch.
    reindexed2 = dict(base["items"][2])
    reindexed2["draw_index"] = 1
    t1 = full_transaction_bytes(1, 1, base)
    t2_bad = transaction_bytes(2, 2, "patch", 1, [], [(2, reindexed2, False)], [], removed_items=[2])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1)
    out["removed-and-present"] = (
        recording(records, end),
        "patch-removed",
        "seq 2 lists item 2 as both removed and present",
    )

    # null-commands-new-item: a brand-new item (id 3) with commands:null.
    new_item = item(
        parent=("canvas", 1),
        children=[],
        xform=IDENTITY,
        draw_index=1,
        content_version=1,
        commands=[add_rect([0.0, 0.0, 5.0, 5.0], [0.0, 0.0, 1.0, 1.0])],
    )
    t1 = full_transaction_bytes(1, 1, base)
    t2_bad = transaction_bytes(2, 2, "patch", 1, [], [(3, new_item, True)], [])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1)
    out["null-commands-new-item"] = (
        recording(records, end),
        "patch-commands",
        "seq 2 introduces new item 3 with commands:null",
    )

    # null-commands-changed-version: item 2 claims a new content_version but commands:null.
    bumped2 = dict(base["items"][2])
    bumped2["content_version"] = 2
    t1 = full_transaction_bytes(1, 1, base)
    t2_bad = transaction_bytes(2, 2, "patch", 1, [], [(2, bumped2, True)], [])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1)
    out["null-commands-changed-version"] = (
        recording(records, end),
        "patch-commands",
        "seq 2 bumps item 2's content_version to 2 but still claims commands:null",
    )

    # tie-unflagged: items 1 and 2, both top-level under canvas 1 with draw_index 0 and non-empty
    # commands, with no draw-index-tie entry declared.
    tied1 = item(
        parent=("canvas", 1), children=[], xform=IDENTITY, draw_index=0, content_version=1,
        commands=[add_rect([0.0, 0.0, 5.0, 5.0], [1.0, 0.0, 0.0, 1.0])],
    )
    tied2 = item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 20.0, 0.0], draw_index=0,
        content_version=1, commands=[add_rect([0.0, 0.0, 5.0, 5.0], [0.0, 1.0, 0.0, 1.0])],
    )
    tied_state = {"items": {1: tied1, 2: tied2}, "canvases": {1: root_canvas([1, 2])}, "unsupported": [], "failures": []}
    t1_tied = full_transaction_bytes(1, 1, tied_state)
    records = [mini_session("full"), t1_tied]
    end = end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0)
    out["tie-unflagged"] = (
        recording(records, end),
        "unsupported-mismatch",
        "items 1 and 2 tie on draw_index 0 under canvas 1, but no draw-index-tie entry is declared",
    )

    # dangling-after-patch: item 1 (the parent) is removed, but item 2 (its listed child) is left
    # untouched, so the resolved state has item 2 pointing at a parent that no longer exists.
    t1 = full_transaction_bytes(1, 1, base)
    canvas1_emptied = root_canvas([])
    t2_bad = transaction_bytes(2, 2, "patch", 1, [(1, canvas1_emptied)], [], [], removed_items=[1])
    records = [mini_session("patch"), t1, t2_bad]
    end = end_record(2, records, diff_ns_total=0, full_transactions=1, patch_transactions=1)
    out["dangling-after-patch"] = (
        recording(records, end),
        "dangling-parent",
        "seq 2 removes item 1 but leaves item 2 (its child) unresolved",
    )

    # no-end: a clean 2-transaction recording missing its end record.
    out["no-end"] = (
        recording(mini_valid_patch_recording(), None),
        "recording-incomplete",
        "the end record is missing",
    )

    return out


# --------------------------------------------------------------------------- control messages (live transport)
#
# Plain JSON objects as they appear inside a text WebSocket frame (render-stream-1.md "Live
# transport"). Not wire-framed. Consumed by G1c2's C++ control-message parser test; this
# generator only has to produce deterministic, schema-plausible fixtures.


def control_messages() -> dict[str, dict]:
    stream_id = "0123456789abcdef0123456789abcdef"
    valid = {
        "hello-submitted": {
            "type": "hello",
            "protocol": "render-stream/1",
            "receiver": "gate1-selftest",
            "credit_stage": "submitted",
            "inbound_buffer_bytes": 16777216,
        },
        "hello-applied": {
            "type": "hello",
            "protocol": "render-stream/1",
            "receiver": "gate1-selftest-headless",
            "credit_stage": "applied",
            "inbound_buffer_bytes": 65535,
        },
        "ack-received": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "received", "t_us": 1000},
        "ack-applied": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "applied", "t_us": 2500},
        "ack-submitted": {"type": "ack", "stream_id": stream_id, "seq": 1, "stage": "submitted", "t_us": 4200},
        "resync": {"type": "resync", "stream_id": stream_id, "seq": 6, "reason": "unapplied-stale"},
        "error-message-too-large": {
            "type": "error",
            "reason": "message-too-large",
            "detail": "transaction 42 is 20000000 bytes",
        },
    }
    invalid = {
        "hello-missing-field": {
            "type": "hello",
            "protocol": "render-stream/1",
            "receiver": "x",
            "credit_stage": "submitted",
        },
        "hello-bad-credit-stage": {
            "type": "hello",
            "protocol": "render-stream/1",
            "receiver": "x",
            "credit_stage": "eventually",
            "inbound_buffer_bytes": 1024,
        },
        "hello-non-integer-buffer": {
            "type": "hello",
            "protocol": "render-stream/1",
            "receiver": "x",
            "credit_stage": "submitted",
            "inbound_buffer_bytes": 1.5,
        },
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

    full_session = session_record(full_stream_id, "file", "full", full_session_id)
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(full_transaction_bytes(i + 1, i + 1, state))
    full_end = end_record(6, full_records, diff_ns_total=0, full_transactions=6, patch_transactions=0)
    full_rs1 = recording(full_records, full_end)

    patch_session = session_record(patch_stream_id, "file", "patch", patch_session_id)
    patch_records = [patch_session, full_transaction_bytes(1, 1, STATES[0])]
    for i in range(1, 5):  # seq 2..5, patches against the immediately previous state
        patch_records.append(patch_transaction_bytes(i + 1, i + 1, i, STATES[i - 1], STATES[i]))
    patch_records.append(full_transaction_bytes(6, 6, STATES[5]))  # resync: full again
    patch_end = end_record(6, patch_records, diff_ns_total=12345, full_transactions=2, patch_transactions=4)
    patch_rs1 = recording(patch_records, patch_end)

    full_decoded = decode(full_rs1)
    patch_decoded = decode(patch_rs1)
    resolved = {
        "schema": "render-stream-1-resolved/1",
        "transactions": [
            {"seq": i + 1, "frame": i + 1, "state": resolved_state(state)} for i, state in enumerate(STATES)
        ],
    }

    # corrupt-meta: patch.rs1's seq 3 (record index 3: session=0, seq1=1, seq2=2, seq3=3), first
    # meta byte zeroed. Framing stays intact; the meta is no longer valid JSON.
    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt = bytearray(patch_rs1)
    assert corrupt[seq3_offset + 8] == ord("{")
    corrupt[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()

    index = {
        "schema": "render-stream-1-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {
                "file": "full.rs1",
                "hex": "full.hex",
                "decoded": "full.decoded.json",
                "sha256": hashlib.sha256(full_rs1).hexdigest(),
            },
            {
                "file": "patch.rs1",
                "hex": "patch.hex",
                "decoded": "patch.decoded.json",
                "sha256": hashlib.sha256(patch_rs1).hexdigest(),
            },
        ],
        "resolved": "resolved.json",
        "corrupt": [
            {
                "file": "corrupt-meta.rs1",
                "code": "meta-json",
                "record_index": 3,
                "seq": 3,
                "description": "patch.rs1 transaction seq 3: first meta byte set to 0x00; framing intact",
            }
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs1", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
    }

    outputs: dict[str, bytes] = {
        "full.rs1": full_rs1,
        "full.hex": to_hex(full_rs1).encode("ascii"),
        "full.decoded.json": pretty(full_decoded),
        "patch.rs1": patch_rs1,
        "patch.hex": to_hex(patch_rs1).encode("ascii"),
        "patch.decoded.json": pretty(patch_decoded),
        "resolved.json": pretty(resolved),
        "corrupt-meta.rs1": bytes(corrupt),
        "index.json": pretty(index),
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs1"] = data
    for name, msg in control["valid"].items():
        outputs[f"control/valid/{name}.json"] = pretty(msg)
    for name, msg in control["invalid"].items():
        outputs[f"control/invalid/{name}.json"] = pretty(msg)
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check", action="store_true", help="verify committed outputs; write nothing"
    )
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
