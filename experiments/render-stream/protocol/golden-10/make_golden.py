#!/usr/bin/env python3
"""Generate the render-stream/10 golden vectors (stdlib only, deterministic).

render-stream/10 (../render-stream-10.md) is render-stream/9 plus exactly: the GRSA magic (byte 3
is the version as one uppercase hex digit), the protocol string render-stream/10, the item keys
`canvas_group` and `copy_to_backbuffer` (right after `instance_params`, before `content_version`),
a seventh transaction block `backbuffer_f32` holding their floats, and a features.unobserved list
without `canvas_item_set_canvas_group_mode` and `canvas_item_set_copy_to_backbuffer` (both hooks
appear in capture.hooks_planned instead).

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Like golden-9 this builds on the earlier generators (it loads golden-9's make_golden.py, which loads
golden-8's, which loads golden-6's) and re-binds the few places whose wire shape changes at /10, so
/10's records are /9's byte for byte except for the magic, the protocol string, the session's two
hook lists, the two item keys and the seventh block. The shared scene is golden-9's eight states
plus two:

    9 (new) adds, on the root canvas: item 10, a `clip_only` owner with the RenderingServer
       defaults (clear margin 5, fit_empty false, fit margin 0, blur_mipmaps false) drawing a rect,
       with child item 11, a `clip_and_draw` owner (same defaults) drawing a rect; item 12, a
       command-less `transparent` owner (clear margin 10, fit_empty true, fit margin 10,
       blur_mipmaps true: a CanvasGroup); item 13, a command-less copy with the rect
       (-100, -100, 200, 200) (a BackBufferCopy in rect mode); item 14, a full-target copy,
       Rect2() (viewport mode), drawing a rect.
   10 (new) item 12's fit margin becomes 20 with its content unchanged (a patch carries it with
       commands null, its only difference a block float); item 10's group is disabled (null);
       item 13's copy is disabled (null); item 14 is cleared (canvas_item_clear: content_version
       2, no commands) and keeps its copy; item 11 is freed.

full.rs10 encodes all ten states as full transactions (directory delivery); patch.rs10
patch-encodes them (seq 1 full, seq 5 a full resync, every other seq a patch); inline.rs10 encodes
them as full transactions with inline delivery (golden-9's resource records; states 9 and 10 add
none). All three resolve to resolved.json. payloads/ is golden-9's, copied.

backbuffer_f32 layout (render-stream-10.md "Transaction blocks", invariant backbuffer-offset): over
the transaction's items in entry order, and within an item canvas_group before copy_to_backbuffer,
a non-null canvas_group appends (clear_margin, fit_margin) and a non-null copy_to_backbuffer
appends its rect (x, y, w, h); each one's `f` is the float count before it.

control/ holds a /10 hello (/9's hello under protocol render-stream/10) and a /9 hello, which a
/10 connection refuses; invalid/ covers exactly /10's failure modes (see index.json).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN9 = HERE.parent / "golden-9"
G9_SPEC = importlib.util.spec_from_file_location("golden9_make_golden", GOLDEN9 / "make_golden.py")
g9 = importlib.util.module_from_spec(G9_SPEC)
sys.modules["golden9_make_golden"] = g9
G9_SPEC.loader.exec_module(g9)  # type: ignore[union-attr]
g8 = g9.g8
g6 = g9.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x41, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSA\r\n\x1a\n"
PROTOCOL = "render-stream/10"
g6.MAGIC = MAGIC
g6.PROTOCOL = PROTOCOL
g8.PROTOCOL = PROTOCOL
g9.PROTOCOL = PROTOCOL

# render-stream-10.md "Features": both hooks are planned at /10, so neither method is unobserved.
# The capture's codec writes hooks_planned sorted (rs2_codec.cpp sorted_copy), so the two names
# take their sorted places; features.unobserved stays golden-6's sorted list minus the two.
NEW_HOOKS = ["canvas_item_set_copy_to_backbuffer", "canvas_item_set_canvas_group_mode"]
assert not set(NEW_HOOKS) & set(g6.HOOKS_PLANNED)
assert set(NEW_HOOKS) <= set(g6.FEATURE_UNOBSERVED)
g6.HOOKS_PLANNED = sorted(list(g6.HOOKS_PLANNED) + NEW_HOOKS)
g6.FEATURE_UNOBSERVED = [m for m in g6.FEATURE_UNOBSERVED if m not in NEW_HOOKS]

GROUP_MODES = ("clip_only", "clip_and_draw", "transparent")  # RS CanvasGroupMode 1, 2, 3

# --------------------------------------------------------------------------- item state


def canvas_group(mode: str, clear_margin: float = 5.0, fit_empty: bool = False,
                 fit_margin: float = 0.0, blur_mipmaps: bool = False) -> dict:
    """The setter's arguments, in its order (RenderingServer::canvas_item_set_canvas_group_mode's
    defaults are 5.0, false, 0.0, false)."""
    assert mode in GROUP_MODES
    return {"mode": mode, "clear_margin": clear_margin, "fit_empty": fit_empty,
            "fit_margin": fit_margin, "blur_mipmaps": blur_mipmaps}


def copy_to_backbuffer(rect: list[float]) -> dict:
    assert len(rect) == 4
    return {"rect": list(rect)}


def _canvas_group_json(cg: dict | None, backbuffer: list[float]) -> dict | None:
    if cg is None:
        return None
    out = {"mode": cg["mode"], "fit_empty": cg["fit_empty"], "blur_mipmaps": cg["blur_mipmaps"],
           "f": len(backbuffer)}
    backbuffer += [cg["clear_margin"], cg["fit_margin"]]
    return out


def _copy_json(copy: dict | None, backbuffer: list[float]) -> dict | None:
    if copy is None:
        return None
    out = {"f": len(backbuffer)}
    backbuffer += copy["rect"]
    return out


def _bb_pattern(value: dict | None) -> object:
    # An entry differs when any JSON value or any of its block floats differs (as float32 bits).
    if value is None:
        return None
    return {k: (g6.f32_pattern([v]) if isinstance(v, float) else
                g6.f32_pattern(v) if isinstance(v, list) else v)
            for k, v in value.items()}


g9_item_differs = g6.item_differs


def _item_differs(a: dict, b: dict) -> bool:
    return (g9_item_differs(a, b)
            or _bb_pattern(a.get("canvas_group")) != _bb_pattern(b.get("canvas_group"))
            or _bb_pattern(a.get("copy_to_backbuffer")) != _bb_pattern(b.get("copy_to_backbuffer")))


g6.item_differs = _item_differs

# A hook for invalid vectors: called with (meta, backbuffer) of every transaction before encoding,
# returns the (meta, backbuffer) to encode.
MUTATE = None

g9_transaction_bytes = g6.transaction_bytes


def _transaction_bytes(*args, **kwargs) -> bytes:
    # golden-6's transaction_bytes(seq, frame, encoding, base_seq, canvases, items, ...) builds the
    # /9 meta and the six blocks; this wraps its one encode_record() call to add the two item keys
    # (before content_version) and the seventh block.
    items = {item_id: it for item_id, it, _ in args[5]}
    encode = g6.encode_record

    def encode_v10(meta: dict, blocks: list, short_block: str | None = None) -> bytes:
        assert meta["type"] == "transaction"
        backbuffer: list[float] = []
        items_json = []
        for entry in meta["items"]:
            it = items[entry["id"]]
            out = {}
            for key, value in entry.items():
                if key == "content_version":
                    out["canvas_group"] = _canvas_group_json(it["canvas_group"], backbuffer)
                    out["copy_to_backbuffer"] = _copy_json(it["copy_to_backbuffer"], backbuffer)
                out[key] = value
            items_json.append(out)
        meta = dict(meta, items=items_json)
        if MUTATE is not None:
            meta, backbuffer = MUTATE(meta, backbuffer)
        return encode(meta, list(blocks) + [g6.f32block("backbuffer_f32", backbuffer)],
                      short_block)

    g6.encode_record = encode_v10
    try:
        return g9_transaction_bytes(*args, **kwargs)
    finally:
        g6.encode_record = encode


g6.transaction_bytes = _transaction_bytes

# --------------------------------------------------------------------------- the ten states

for _s in g9.STATES:
    for _it in _s["items"].values():
        _it.setdefault("canvas_group", None)
        _it.setdefault("copy_to_backbuffer", None)


def _bb_item(*, parent, children, x: float, draw_index: int, content_version: int,
             commands: list[dict], cg: dict | None = None, copy: dict | None = None) -> dict:
    out = g6.item(parent=parent, children=children, xform=[1.0, 0.0, 0.0, 1.0, x, 64.0],
                  draw_index=draw_index, content_version=content_version, commands=commands)
    out["canvas_group"] = cg
    out["copy_to_backbuffer"] = copy
    return out


def state9() -> dict:
    state = {k: (dict(v) if isinstance(v, dict) else v) for k, v in g9.STATES[7].items()}
    items = dict(state["items"])
    items[10] = _bb_item(
        parent=("canvas", 1), children=[11], x=0.0, draw_index=8, content_version=1,
        commands=[g6.add_rect([0.0, 0.0, 32.0, 32.0], [1.0, 0.5, 0.25, 1.0])],
        cg=canvas_group("clip_only"))
    items[11] = _bb_item(
        parent=("item", 10), children=[], x=8.0, draw_index=0, content_version=1,
        commands=[g6.add_rect([0.0, 0.0, 48.0, 16.0], [0.25, 0.5, 1.0, 1.0])],
        cg=canvas_group("clip_and_draw"))
    items[12] = _bb_item(
        parent=("canvas", 1), children=[], x=48.0, draw_index=9, content_version=1, commands=[],
        cg=canvas_group("transparent", 10.0, True, 10.0, True))
    items[13] = _bb_item(
        parent=("canvas", 1), children=[], x=96.0, draw_index=10, content_version=1, commands=[],
        copy=copy_to_backbuffer([-100.0, -100.0, 200.0, 200.0]))
    items[14] = _bb_item(
        parent=("canvas", 1), children=[], x=144.0, draw_index=11, content_version=1,
        commands=[g6.add_rect([0.0, 0.0, 16.0, 16.0], [0.5, 1.0, 0.5, 1.0])],
        copy=copy_to_backbuffer([0.0, 0.0, 0.0, 0.0]))
    state["items"] = items
    canvases = dict(state["canvases"])
    canvases[1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14])
    state["canvases"] = canvases
    return state


def state10() -> dict:
    state = state9()
    items = dict(state["items"])
    tr = dict(items[12])
    tr["canvas_group"] = canvas_group("transparent", 10.0, True, 20.0, True)
    items[12] = tr
    owner = dict(items[10])
    owner["canvas_group"] = None
    owner["children"] = []
    items[10] = owner
    rect_copy = dict(items[13])
    rect_copy["copy_to_backbuffer"] = None
    items[13] = rect_copy
    cleared = dict(items[14])
    cleared["content_version"] = 2
    cleared["commands"] = []
    items[14] = cleared
    del items[11]
    state["items"] = items
    return state


STATES = list(g9.STATES) + [state9(), state10()]

# --------------------------------------------------------------------------- decode / resolved


def decode(data: bytes) -> dict:
    out = g6.decode(data)
    out["schema"] = "render-stream-10-decoded/1"
    return out


def resolved_state(state: dict) -> dict:
    out = g9.resolved_state(state)
    items_out = []
    for entry in out["items"]:
        it = state["items"][entry["id"]]
        ordered = {}
        for key, value in entry.items():
            if key == "content_version":
                cg = it["canvas_group"]
                ordered["canvas_group"] = None if cg is None else dict(cg)
                copy = it["copy_to_backbuffer"]
                ordered["copy_to_backbuffer"] = None if copy is None else {"rect": list(copy["rect"])}
            ordered[key] = value
        items_out.append(ordered)
    out["items"] = items_out
    return out


# --------------------------------------------------------------------------- invalid vectors

MINI_SESSION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def mini_state() -> dict:
    owner = _bb_item(parent=("canvas", 1), children=[], x=0.0, draw_index=0, content_version=1,
                     commands=[g6.add_rect([0.0, 0.0, 8.0, 8.0], g6.WHITE)],
                     cg=canvas_group("transparent", 10.0, True, 10.0, True))
    copy = _bb_item(parent=("canvas", 1), children=[], x=16.0, draw_index=1, content_version=1,
                    commands=[], copy=copy_to_backbuffer([0.0, 0.0, 32.0, 32.0]))
    return {"items": {1: owner, 2: copy}, "canvases": {1: g6.root_canvas([1, 2])},
            "textures": {}, "meshes": {}, "shaders": {}, "materials": {}, "unsupported": [],
            "failures": [], "default_filter": "nearest", "default_repeat": "disabled"}


def mini_recording(mutate=None) -> bytes:
    global MUTATE
    session = g9.session_record(MINI_STREAM, "file", "full", MINI_SESSION,
                                delivery="out-of-band", adoption=None, decode="off")
    MUTATE = mutate
    try:
        tx = g6.full_transaction_bytes(1, 1, mini_state())
    finally:
        MUTATE = None
    records = [session, tx]
    end = g6.end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                        resource_records=0, resource_bytes=0)
    return g6.recording(records, end)


def _mutate_item(item_id: int, fn):
    def mutate(meta: dict, backbuffer: list[float]):
        items = []
        for entry in meta["items"]:
            entry = dict(entry)
            if entry["id"] == item_id:
                fn(entry)
            items.append(entry)
        return dict(meta, items=items), backbuffer
    return mutate


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    out: dict[str, tuple[bytes, str, str]] = {}
    out["bad-magic"] = ((GOLDEN9 / "full.rs9").read_bytes(), "bad-magic",
                        "golden-9's full.rs9: magic byte 3 is '9' (GRS9), not 'A'")

    def f_off_by_one(entry: dict) -> None:
        entry["copy_to_backbuffer"] = {"f": entry["copy_to_backbuffer"]["f"] + 1}

    out["backbuffer-offset"] = (
        mini_recording(_mutate_item(2, f_off_by_one)), "backbuffer-offset",
        "item 2's copy_to_backbuffer f is 3, expected 2 (item 1's canvas_group takes 2 floats)")
    out["backbuffer-offset-short"] = (
        mini_recording(lambda meta, bb: (meta, bb[:-1])), "backbuffer-offset",
        "backbuffer_f32 carries 5 floats (count 5), the items claim 6")

    def mode_disabled(entry: dict) -> None:
        entry["canvas_group"] = dict(entry["canvas_group"], mode="disabled")

    out["canvas-group-mode"] = (
        mini_recording(_mutate_item(1, mode_disabled)), "meta-schema",
        "item 1's canvas_group mode is \"disabled\" (disabled is null on the wire)")

    def group_extra_key(entry: dict) -> None:
        entry["canvas_group"] = dict(entry["canvas_group"], clear_margin=10)

    out["canvas-group-keys"] = (
        mini_recording(_mutate_item(1, group_extra_key)), "meta-schema",
        "item 1's canvas_group carries an extra key, clear_margin")

    def copy_rect_key(entry: dict) -> None:
        entry["copy_to_backbuffer"] = {"rect": [0, 0, 32, 32], "f": 2}

    out["copy-keys"] = (
        mini_recording(_mutate_item(2, copy_rect_key)), "meta-schema",
        "item 2's copy_to_backbuffer carries a rect key beside f")
    return out


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    hello9 = g9.control_messages()["valid"]["hello-native-block"]
    assert hello9["protocol"] == PROTOCOL
    hello10 = dict(hello9, receiver="gate10-native")
    return {
        "valid": {"hello-native-block": hello10},
        "invalid": {"hello-wrong-protocol": dict(hello10, protocol="render-stream/9")},
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
    full_rs10 = g6.recording(full_records, full_end)

    patch_session = g9.session_record("2" * 32, "file", "patch",
                                      "fedcba9876543210fedcba9876543210", delivery="out-of-band")
    patch_records = [patch_session, g6.full_transaction_bytes(1, 1, STATES[0])]
    for seq in (2, 3, 4):
        patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[seq - 2],
                                                        STATES[seq - 1]))
    patch_records.append(g6.full_transaction_bytes(5, 5, STATES[4]))  # resync: full again
    for seq in range(6, len(STATES) + 1):
        patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[seq - 2],
                                                        STATES[seq - 1]))
    patch_end = g6.end_record(len(STATES), patch_records, diff_ns_total=12345,
                              full_transactions=2, patch_transactions=len(STATES) - 2,
                              resource_records=0, resource_bytes=0)
    patch_rs10 = g6.recording(patch_records, patch_end)

    inline_session = g9.session_record("3" * 32, "file", "full",
                                       "22222222222222222222222222222222", delivery="inline")
    r = g6.resource_record_bytes
    inline_payloads: list[tuple[str, bytes]] = []

    def inline_resource(hash_hex: str, payload: bytes) -> bytes:
        inline_payloads.append((hash_hex, payload))
        return r(hash_hex, payload)

    records = [inline_session, inline_resource(g6.HASH_A1, g6.PAYLOAD_A1),
               inline_resource(g6.HASH_F, g6.PAYLOAD_F)]
    records.append(g6.full_transaction_bytes(1, 1, STATES[0]))
    records.append(g6.full_transaction_bytes(2, 2, STATES[1]))
    records.append(inline_resource(g6.HASH_A2, g6.PAYLOAD_A2))
    records.append(g6.full_transaction_bytes(3, 3, STATES[2]))
    records.append(inline_resource(g8.HASH_DEC, g8.PAYLOAD_DEC))
    records.append(inline_resource(g8.HASH_RGBAF, g8.PAYLOAD_RGBAF))
    records.append(inline_resource(g8.HASH_RH, g8.PAYLOAD_RH))
    records.append(inline_resource(g6.HASH_MESH1_A, g6.MESH1_SURFACE_A_PAYLOAD))
    records.append(inline_resource(g6.HASH_SHADER2_V1, g6.SHADER2_TINT_PAYLOAD_V1))
    records.append(g6.full_transaction_bytes(4, 4, STATES[3]))
    records.append(inline_resource(g6.HASH_MESH1_B, g6.MESH1_SURFACE_B_PAYLOAD))
    records.append(g6.full_transaction_bytes(5, 5, STATES[4]))
    records.append(g6.full_transaction_bytes(6, 6, STATES[5]))
    records.append(inline_resource(g9.HASH_MIP16, g9.PAYLOAD_MIP16))
    records.append(inline_resource(g9.HASH_DXT5_16M, g9.PAYLOAD_DXT5_16M))
    records.append(inline_resource(g9.HASH_DXT5_4, g9.PAYLOAD_DXT5_4))
    records.append(g6.full_transaction_bytes(7, 7, STATES[6]))
    records.append(inline_resource(g9.HASH_KTX2_16, g9.KTX2_16))
    records.append(inline_resource(g9.HASH_KTX2_4, g9.KTX2_4))
    records.append(g6.full_transaction_bytes(8, 8, STATES[7]))
    # States 9 and 10 draw rects only: no new resources.
    records.append(g6.full_transaction_bytes(9, 9, STATES[8]))
    records.append(g6.full_transaction_bytes(10, 10, STATES[9]))
    inline_end = g6.end_record(len(STATES), records, diff_ns_total=0,
                               full_transactions=len(STATES), patch_transactions=0,
                               resource_records=len(inline_payloads),
                               resource_bytes=sum(len(p) for _, p in inline_payloads))
    inline_rs10 = g6.recording(records, inline_end)

    full_decoded, patch_decoded = decode(full_rs10), decode(patch_rs10)
    inline_decoded = decode(inline_rs10)
    resolved = {
        "schema": "render-stream-10-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": resolved_state(s)}
                         for i, s in enumerate(STATES)],
    }

    # Inline record_index values come from the decoded records, never from counting by hand.
    by_hash = {}
    for i, rec in enumerate(inline_decoded["records"]):
        if rec["meta"]["type"] == "resource":
            by_hash[rec["meta"]["hash"]] = i
    inline_resources = [{"hash": h, "bytes": len(p), "record_index": by_hash[h]}
                        for h, p in inline_payloads]

    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt_rs10 = bytearray(patch_rs10)
    assert corrupt_rs10[seq3_offset + 8] == ord("{")
    corrupt_rs10[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()
    payload_files = [
        ("a1.grt", g6.HASH_A1, g6.PAYLOAD_A1, "RGBA8", 16, 16, False),
        ("a2.grt", g6.HASH_A2, g6.PAYLOAD_A2, "RGBA8", 16, 16, False),
        ("f.grt", g6.HASH_F, g6.PAYLOAD_F, "LA8", 4, 4, False),
        ("dec.grt", g8.HASH_DEC, g8.PAYLOAD_DEC, "RGBA8", 4, 4, False),
        ("rgbaf.grt", g8.HASH_RGBAF, g8.PAYLOAD_RGBAF, "RGBAF", 2, 2, False),
        ("rh.grt", g8.HASH_RH, g8.PAYLOAD_RH, "RH", 3, 2, True),
        ("mip16.grt", g9.HASH_MIP16, g9.PAYLOAD_MIP16, "RGBA8", 16, 16, True),
        ("dxt5-4x4.grt", g9.HASH_DXT5_4, g9.PAYLOAD_DXT5_4, "DXT5", 4, 4, False),
        ("dxt5-16x16-mips.grt", g9.HASH_DXT5_16M, g9.PAYLOAD_DXT5_16M, "DXT5", 16, 16, True),
    ]
    ktx2_files = [
        ("ktx2-16x16-mips.ktx2", g9.HASH_KTX2_16, g9.KTX2_16, 16, 16, 5),
        ("ktx2-4x4.ktx2", g9.HASH_KTX2_4, g9.KTX2_4, 4, 4, 1),
    ]
    index = {
        "schema": "render-stream-10-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs10", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs10).hexdigest()},
            {"file": "patch.rs10", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs10).hexdigest()},
            {"file": "inline.rs10", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs10).hexdigest()},
        ],
        "resolved": "resolved.json",
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs10", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs10 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs10", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        "control": {
            "valid": [f"control/valid/{name}.json" for name in control["valid"]],
            "invalid": [f"control/invalid/{name}.json" for name in control["invalid"]],
        },
        "payloads": [
            {"file": f"payloads/{name}", "hash": h, "format": fmt, "width": w, "height": hh,
             "mipmaps": mips, "bytes": len(p)}
            for name, h, p, fmt, w, hh, mips in payload_files
        ],
        "ktx2_payloads": [
            {"file": f"payloads/{name}", "hash": h, "width": w, "height": hh, "levels": levels,
             "bytes": len(p), "encoding": "uastc", "supercompression": "zstd"}
            for name, h, p, w, hh, levels in ktx2_files
        ],
        "mesh_payloads": [
            {"file": "payloads/mesh1-a.grm", "hash": g6.HASH_MESH1_A, "primitive": "triangles",
             "format": g6.MESH1_SURFACE_A_FORMAT, "vertex_count": 3, "index_count": 0,
             "bytes": len(g6.MESH1_SURFACE_A_PAYLOAD)},
            {"file": "payloads/mesh1-b.grm", "hash": g6.HASH_MESH1_B, "primitive": "triangles",
             "format": g6.MESH1_SURFACE_B_FORMAT, "vertex_count": 4, "index_count": 6,
             "bytes": len(g6.MESH1_SURFACE_B_PAYLOAD)},
        ],
        "shader_payloads": [
            {"file": "payloads/shader2-tint-v1.grp", "hash": g6.HASH_SHADER2_V1,
             "bytes": len(g6.SHADER2_TINT_PAYLOAD_V1)},
        ],
    }
    outputs: dict[str, bytes] = {
        "full.rs10": full_rs10, "full.hex": g6.to_hex(full_rs10).encode("ascii"),
        "full.decoded.json": g6.pretty(full_decoded),
        "patch.rs10": patch_rs10, "patch.hex": g6.to_hex(patch_rs10).encode("ascii"),
        "patch.decoded.json": g6.pretty(patch_decoded),
        "inline.rs10": inline_rs10, "inline.hex": g6.to_hex(inline_rs10).encode("ascii"),
        "inline.decoded.json": g6.pretty(inline_decoded),
        "resolved.json": g6.pretty(resolved),
        "corrupt-meta.rs10": bytes(corrupt_rs10),
        "index.json": g6.pretty(index),
        "payloads/mesh1-a.grm": g6.MESH1_SURFACE_A_PAYLOAD,
        "payloads/mesh1-b.grm": g6.MESH1_SURFACE_B_PAYLOAD,
        "payloads/shader2-tint-v1.grp": g6.SHADER2_TINT_PAYLOAD_V1,
    }
    for name, _, p, *_ in payload_files:
        outputs[f"payloads/{name}"] = p
    for name, _, p, *_ in ktx2_files:
        outputs[f"payloads/{name}"] = p
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs10"] = data
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
