#!/usr/bin/env python3
"""Generate the render-stream/0 golden vectors (stdlib only, deterministic).

The wire format is specified in ../render-stream-0.md. This script is the
reference encoder: the C++ codec (capture/src/rs0_codec.cpp) must reproduce
minimal.bin byte for byte from the same structures, and the TypeScript and
GDScript decoders must turn minimal.bin into minimal.decoded.json and reject
every vector listed in index.json with the code named there.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Every float is a multiple of 1/256 with an exact float32 encoding, so a float
never depends on a decimal parser.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

MAGIC = bytes([0x47, 0x52, 0x53, 0x30, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS0\r\n\x1a\n"
PROTOCOL = "render-stream/0"

ITEM_FLOATS = 18  # xform 6, modulate 4, self_modulate 4, custom_rect 4
CANVAS_FLOATS = 6  # xform 6
RECT_FLOATS = 8  # rect 4, colour 4

# Gate-0 constants that every encoder emits verbatim (render-stream-0.md, "Session").
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
assert len(HOOKS_PLANNED) == 42

FEATURE_OPS = ["add_rect"]
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
    ]
)
PUBLICATION = "complete-snapshot-per-frame"

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]


# --------------------------------------------------------------------------- encoding


def u32(value: int) -> bytes:
    assert 0 <= value <= 0xFFFFFFFF
    return struct.pack("<I", value)


def f32s(values: list[float]) -> bytes:
    out = bytearray()
    for value in values:
        packed = struct.pack("<f", value)
        # Exactly representable and on the 1/256 grid: no decimal parser can disagree.
        assert struct.unpack("<f", packed)[0] == value, value
        assert (value * 256).is_integer(), value
        out += packed
    return bytes(out)


def canonical_json(obj: object) -> bytes:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    raw = text.encode("ascii")
    assert all(0x20 <= b <= 0x7E for b in raw), "meta must be printable ASCII"
    return raw


def encode_record(
    meta: dict, blocks: list[tuple[str, list[float]]], short_block: str | None = None
) -> bytes:
    """meta without "blocks"; blocks as (name, floats). `short_block` names a block whose
    payload is written one float short of its declared count (invalid vector only)."""
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


# --------------------------------------------------------------------------- model


def session_record() -> bytes:
    meta = {
        "type": "session",
        "protocol": PROTOCOL,
        "session_id": "0123456789abcdef0123456789abcdef",
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
        "viewport": {"canvas_cull_mask": 4294967295, "root_canvas": 1},
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
    ]
    return encode_record(meta, blocks)


def make_item(
    item_id: int,
    parent: tuple[str, int] | None,
    children: list[int],
    *,
    xform: list[float],
    modulate: list[float] = WHITE,
    self_modulate: list[float] = WHITE,
    visible: bool = True,
    draw_index: int = 0,
    z_index: int = 0,
    clip: bool = False,
    custom_rect: bool = False,
    crect: list[float] = NO_RECT,
    visibility_layer: int = 1,
    content_version: int = 0,
    commands: list[dict] | None = None,
) -> dict:
    """commands: {"op":"add_rect","aa":bool,"rect":[4],"color":[4]} or
    {"op":"unsupported","name":str}; offsets are assigned at encode time."""
    return {
        "id": item_id,
        "parent": parent,
        "children": children,
        "xform": xform,
        "modulate": modulate,
        "self_modulate": self_modulate,
        "visible": visible,
        "draw_index": draw_index,
        "z_index": z_index,
        "clip": clip,
        "custom_rect": custom_rect,
        "crect": crect,
        "visibility_layer": visibility_layer,
        "content_version": content_version,
        "commands": commands or [],
    }


def transaction_record(
    seq: int,
    frame: int,
    canvases: list[dict],
    items: list[dict],
    unsupported: list[dict],
    failures: list[dict] | None = None,
    short_block: str | None = None,
) -> bytes:
    failures = failures or []
    item_f32: list[float] = []
    canvas_f32: list[float] = []
    cmd_f32: list[float] = []
    items_json = []
    for item in sorted(items, key=lambda i: i["id"]):
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
                "id": item["id"],
                "origin": "created",
                "parent": None if parent is None else {"kind": parent[0], "id": parent[1]},
                "children": item["children"],
                "visible": item["visible"],
                "draw_index": item["draw_index"],
                "z_index": item["z_index"],
                "clip": item["clip"],
                "custom_rect": item["custom_rect"],
                "visibility_layer": item["visibility_layer"],
                "content_version": item["content_version"],
                "commands": commands_json,
            }
        )
        item_f32 += item["xform"] + item["modulate"] + item["self_modulate"] + item["crect"]
    canvases_json = []
    for canvas in sorted(canvases, key=lambda c: c["id"]):
        canvases_json.append(
            {
                "id": canvas["id"],
                "origin": canvas["origin"],
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
        "status": "ok" if not failures else "capture-failure",
        "failures": failures,
        "unsupported": unsupported,
        "canvases": canvases_json,
        "items": items_json,
    }
    blocks = [("item_f32", item_f32), ("canvas_f32", canvas_f32), ("cmd_f32", cmd_f32)]
    return encode_record(meta, blocks, short_block=short_block)


def end_record(transactions: int, before_end: list[bytes]) -> bytes:
    meta = {
        "type": "end",
        "transactions": transactions,
        "reason": "shutdown",
        "stats": {
            "bytes_total": len(MAGIC) + sum(len(r) for r in before_end),
            "encode_ns_total": 250000,
            "snapshot_ns_total": 40000,
            "max_record_bytes": max(len(r) for r in before_end),
        },
    }
    return encode_record(meta, [])


def root_canvas(items: list[int]) -> dict:
    return {
        "id": 1,
        "origin": "root-query",
        "role": "root",
        "attached": True,
        "xform": IDENTITY,
        "items": items,
    }


def item1(children: list[int]) -> dict:
    return make_item(
        1,
        ("canvas", 1),
        children,
        xform=[1.0, 0.0, 0.0, 1.0, 100.0, 50.0],
        draw_index=0,
        content_version=1,
        commands=[
            {
                "op": "add_rect",
                "aa": False,
                "rect": [0.0, 0.0, 64.0, 48.0],
                "color": [1.0, 0.5, 0.25, 1.0],
            }
        ],
    )


def item2() -> dict:
    return make_item(
        2,
        ("item", 1),
        [],
        xform=[1.0, 0.0, 0.0, 1.0, 8.0, 8.0],
        modulate=[1.0, 1.0, 1.0, 0.5],
        self_modulate=[0.75, 1.0, 1.0, 1.0],
        draw_index=1,
        z_index=-1,
        clip=True,
        custom_rect=True,
        crect=[0.0, 0.0, 32.0, 32.0],
        content_version=2,
        commands=[
            {
                "op": "add_rect",
                "aa": True,
                "rect": [2.0, 2.0, 16.0, 16.0],
                "color": [0.0, 0.5, 1.0, 1.0],
            },
            {"op": "unsupported", "name": "canvas_item_add_circle"},
        ],
    )


def item3() -> dict:
    return make_item(
        3,
        ("canvas", 1),
        [],
        xform=[0.0, 1.0, -1.0, 0.0, 200.0, 120.0],  # 90 degree rotation, moved
        draw_index=1,
        content_version=1,
        commands=[
            {
                "op": "add_rect",
                "aa": False,
                "rect": [0.0, 0.0, 40.0, 40.0],
                "color": [0.25, 0.75, 0.0, 1.0],
            }
        ],
    )


UNSUPPORTED_T1 = [{"op": "canvas_item_add_circle", "item": 2, "reason": "unsupported-op"}]


def t1(short_block: str | None = None) -> bytes:
    return transaction_record(
        1, 1, [root_canvas([1])], [item1([2]), item2()], UNSUPPORTED_T1, short_block=short_block
    )


def t2(seq: int = 2, dangling: bool = False) -> bytes:
    i3 = item3()
    canvas_items = [1, 3]
    if dangling:
        i3["parent"] = ("item", 9)
        canvas_items = [1]
    return transaction_record(seq, 2, [root_canvas(canvas_items)], [item1([]), i3], [])


def t3_reused() -> bytes:
    reborn = make_item(2, ("canvas", 1), [], xform=IDENTITY, draw_index=2)
    return transaction_record(3, 3, [root_canvas([1, 3, 2])], [item1([]), item3(), reborn], [])


def recording(records: list[bytes], with_end: bool = True, magic: bytes = MAGIC) -> bytes:
    transactions = len(records) - 1
    out = magic + b"".join(records)
    if with_end:
        out += end_record(transactions, records)
    return out


# --------------------------------------------------------------------------- decoding


def decode(data: bytes) -> dict:
    """The decoded form a decoder must produce for a valid recording."""
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
    return {"schema": "render-stream-0-decoded/1", "magic": MAGIC.hex(), "records": records}


def to_hex(data: bytes) -> str:
    text = data.hex()
    return "".join(text[i : i + 64] + "\n" for i in range(0, len(text), 64))


def pretty(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=True) + "\n").encode("ascii")


# --------------------------------------------------------------------------- outputs


def build() -> dict[str, bytes]:
    session = session_record()
    minimal = recording([session, t1(), t2()])

    # corrupt-meta: transaction 2's meta, first byte -> 0x00 (framing intact, JSON invalid).
    decoded = decode(minimal)
    t2_offset = decoded["records"][2]["offset"]
    corrupt = bytearray(minimal)
    corrupt[t2_offset + 8] = 0x00  # record_len (4) + meta_len (4), then meta[0]
    assert minimal[t2_offset + 8] == ord("{")

    bad_magic = bytearray(minimal)
    bad_magic[3] = 0x31  # "GRS1": a different major version must be refused

    invalid = {
        "bad-magic": (bytes(bad_magic), "bad-magic", "magic byte 3 is '1' (GRS1), not '0'"),
        "short-block": (
            recording([session, t1(short_block="cmd_f32"), t2()]),
            "block-length",
            "transaction 1 cmd_f32 declares count 16 but carries 60 bytes",
        ),
        "seq-gap": (
            recording([session, t1(), t2(seq=3)]),
            "seq-gap",
            "second transaction has seq 3 after seq 1",
        ),
        "reused-id": (
            recording([session, t1(), t2(), t3_reused()]),
            "id-reused",
            "item id 2 is freed in seq 2 and reappears in seq 3",
        ),
        "dangling-parent": (
            recording([session, t1(), t2(dangling=True)]),
            "dangling-parent",
            "seq 2 item 3 names parent item 9, which is not in the transaction",
        ),
        "no-end": (
            recording([session, t1(), t2()], with_end=False),
            "recording-incomplete",
            "the end record is missing",
        ),
    }

    index = {
        "schema": "render-stream-0-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {
                "file": "minimal.bin",
                "hex": "minimal.hex",
                "decoded": "minimal.decoded.json",
                "sha256": hashlib.sha256(minimal).hexdigest(),
            }
        ],
        "corrupt": [
            {
                "file": "corrupt-meta.bin",
                "code": "meta-json",
                "record_index": 2,
                "seq": 2,
                "description": "transaction seq 2: first meta byte set to 0x00; framing intact",
            }
        ],
        "invalid": [
            {
                "file": f"invalid/{name}.bin",
                "code": code,
                "description": description,
            }
            for name, (_, code, description) in invalid.items()
        ],
    }

    outputs: dict[str, bytes] = {
        "minimal.bin": minimal,
        "minimal.hex": to_hex(minimal).encode("ascii"),
        "minimal.decoded.json": pretty(decoded),
        "corrupt-meta.bin": bytes(corrupt),
        "index.json": pretty(index),
    }
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.bin"] = data
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
