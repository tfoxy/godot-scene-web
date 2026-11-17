#!/usr/bin/env python3
"""Generate the render-stream/16 golden vectors (stdlib only, deterministic).

render-stream/16 (../render-stream-16.md) is render-stream/15 plus viewport surfaces: the session
key `viewports` (always present, the last key before `blocks`), the transaction keys
`removed_viewports` and `viewports` (after `shader_time`, before `predict_check`), the block
`viewport_f32` (after every /15 block), the texture kinds `viewport` and `proxy` (kind key right
after `variants`), the texture reason `proxy-unresolved` and the session-level reasons
`viewport-3d`, `viewport-hdr-2d` and `viewport-msaa-2d`. Every other byte is /15's.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Outputs:

- Every golden-15 vector re-stamped /16 (`restamp`): the GRSG magic, the session's "protocol",
  and `,"viewports":"on"` inserted into the session meta right before `,"blocks":[`. Every later
  record keeps its bytes and moves by that key's length; the end record's stats.bytes_total moves
  by it too and its max_record_bytes is recomputed when it was the input's own maximum (golden-13's
  `_fix_end`). `stamp15` is the exact inverse. The .decoded.json files
  (render-stream-16-decoded/1) carry the new offsets, lengths, sha256 values and the two changed
  metas; resolved.json, predict-resolved.json and hints-resolved.json are golden-15's under
  render-stream-16-resolved/1. invalid/bad-magic.rs16 is golden-15's full.rs15 (GRSF, not GRSG).
  golden-15's /14 files (hints.rs14, invalid/*-at-14.rs14) are not copied: index.json names them
  under ../golden-15, as it names the /12 and /13 twins under ../golden-12 and ../golden-13.
- viewports.rs16 (`viewport_states`, `encode_stream`): a small synthetic patch stream, seqs 1 and
  9 full, with viewports.hex, viewports.decoded.json and viewports-resolved.json computed here
  from the spec (`decode16`, `resolve16`), not by running a validator. Its content is the
  `VIEWPORTS_DESCRIPTION` below.
- invalid/viewport-*.rs16, invalid/proxy-*.rs16 and invalid/viewport-at-15.rs15
  (`build_invalid`): one rule of render-stream-16.md broken each, checked by this file's reference
  checker `viewport_check` (the /16 rules; every other rule taken as golden-15's).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN15 = HERE.parent / "golden-15"
G15_SPEC = importlib.util.spec_from_file_location("golden15_make_golden",
                                                  GOLDEN15 / "make_golden.py")
g15 = importlib.util.module_from_spec(G15_SPEC)
sys.modules["golden15_make_golden"] = g15
G15_SPEC.loader.exec_module(g15)  # type: ignore[union-attr]
g13 = g15.g13
g6 = g15.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSG\r\n\x1a\n"
PROTOCOL = "render-stream/16"
MAGIC_V15 = g15.MAGIC
PROTOCOL_V15 = g15.PROTOCOL
VIEWPORTS_ON = b',"viewports":"on"'
BLOCKS_MARK = b',"blocks":['

parse_record = g13.parse_record
make_record = g13.make_record


def records(data: bytes, magic: bytes = MAGIC) -> list[bytes]:
    return g13.split_records(data, magic)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _meta(rec: bytes) -> dict:
    return json.loads(parse_record(rec)[0])


def _is_end(rec: bytes) -> bool:
    try:
        return _meta(rec).get("type") == "end"
    except (ValueError, UnicodeDecodeError):
        return False


# --------------------------------------------------------------------------- restamp

def _session_key(meta_b: bytes, key: bytes, *, insert: bool) -> bytes:
    assert meta_b.count(BLOCKS_MARK) == 1, "one blocks key in the session"
    i = meta_b.index(BLOCKS_MARK)
    if insert:
        return meta_b[:i] + key + meta_b[i:]
    assert meta_b[i - len(key):i] == key, "the session's viewports key"
    return meta_b[:i - len(key)] + meta_b[i:]


def _retag(data: bytes, magic_in: bytes, magic_out: bytes, session_fn) -> bytes:
    recs = records(data, magic_in)
    out: list[bytes] = []
    seen: list[bytes] = []
    for i, rec in enumerate(recs):
        if i == 0:
            meta_b, blocks = parse_record(rec)
            assert json.loads(meta_b)["type"] == "session"
            out.append(make_record(session_fn(meta_b), blocks))
        elif i == len(recs) - 1 and _is_end(rec):
            meta_b, blocks = parse_record(rec)
            out.append(make_record(g13._fix_end(meta_b, out, seen), blocks))
        else:
            out.append(rec)
        seen.append(rec)
    return magic_out + b"".join(out)


def restamp(data15: bytes) -> bytes:
    """A /15 file re-stamped /16: the magic, the session's protocol, `"viewports":"on"` before
    the session's blocks, and the end record's stats following the moved bytes."""
    return _retag(data15, MAGIC_V15, MAGIC, lambda m: _session_key(
        g13._swap_protocol(m, PROTOCOL_V15, PROTOCOL), VIEWPORTS_ON, insert=True))


def stamp15(data16: bytes) -> bytes:
    """The inverse of `restamp`."""
    return _retag(data16, MAGIC, MAGIC_V15, lambda m: g13._swap_protocol(
        _session_key(m, VIEWPORTS_ON, insert=False), PROTOCOL, PROTOCOL_V15))


def _rename(rel: str) -> str:
    return rel[:-5] + ".rs16" if rel.endswith(".rs15") else rel


def _with_viewports_key(meta: dict, value: str = "on") -> dict:
    out = {}
    for k, v in meta.items():
        if k == "blocks":
            out["viewports"] = value
        out[k] = v
    return out


def _decoded16(text: bytes, data16: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-15-decoded/1"
    d["schema"] = "render-stream-16-decoded/1"
    d["magic"] = MAGIC.hex()
    recs = records(data16)
    assert len(recs) == len(d["records"])
    offset = len(MAGIC)
    for i, (rec, raw) in enumerate(zip(d["records"], recs)):
        if i == 0:
            assert rec["meta"]["protocol"] == PROTOCOL_V15
            rec["meta"] = _with_viewports_key(dict(rec["meta"], protocol=PROTOCOL))
        elif i == len(recs) - 1 and rec["meta"]["type"] == "end":
            rec["meta"] = _meta(raw)
        assert rec["meta"] == _meta(raw), i
        rec["offset"] = offset
        rec["byte_length"] = len(raw)
        rec["sha256"] = _sha256(raw)
        offset += len(raw)
    return g6.pretty(d)


def _resolved16(text: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-15-resolved/1"
    d["schema"] = "render-stream-16-resolved/1"
    return g6.pretty(d)


# --------------------------------------------------------------------------- the viewport stream
#
# A state: {"unsupported": [...], "canvases": {id: (json without id, 10 floats)},
#           "items": {id: (json without id and commands, [commands], 18 floats)},
#           "textures": {id: wire entry}, "viewports": {id: (json without id and f, floats)}}.
# A command: (json without f, floats). Viewport floats: [global 6] + one 6-list per canvases row.

IDENTITY = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
WHITE = [1.0, 1.0, 1.0, 1.0]
NO_RECT = [0.0, 0.0, 0.0, 0.0]
DEFAULT_FILTER = "nearest"
DEFAULT_REPEAT = "disabled"
VIEWPORTS_FULLS = (1, 9)

ITEM_KEYS = ("id", "origin", "parent", "children", "visible", "draw_index", "z_index",
             "z_relative", "behind", "clip", "custom_rect", "visibility_layer", "texture_filter",
             "texture_repeat", "material", "use_parent_material", "instance_params",
             "canvas_group", "copy_to_backbuffer", "content_version", "commands")
TEXTURE_KEYS = ("id", "origin", "adopted_content", "kind", "status", "reason", "version", "hash",
                "format", "source_format", "width", "height", "mipmaps", "payload_bytes",
                "variants")
VIEWPORT_KEYS = ("id", "origin", "parent", "active", "active_seq", "size", "transparent",
                 "update", "once_seq", "clear", "clear_seq", "disable_2d", "renders_3d", "hdr_2d",
                 "msaa_2d", "canvas_cull_mask", "default_texture_filter",
                 "default_texture_repeat", "snap_2d", "canvases", "f")
UPDATES = ("disabled", "once", "when_visible", "when_parent_visible", "always")
CLEARS = ("always", "never", "next_frame")
FILTERS = ("nearest", "linear", "nearest_mipmaps", "linear_mipmaps",
           "nearest_mipmaps_anisotropic", "linear_mipmaps_anisotropic")
REPEATS = ("disabled", "enabled", "mirror")
VIEWPORT_REASONS = {"viewport-3d": "viewport_attach_camera",
                    "viewport-hdr-2d": "viewport_set_use_hdr_2d",
                    "viewport-msaa-2d": "viewport_set_msaa_2d"}
VIEWPORT_3D = {"op": "viewport_attach_camera", "item": None, "reason": "viewport-3d"}
DERIVED_4 = {"op": "canvas_item_add_texture_rect", "item": 4, "reason": "unsupported-texture"}
CMD_FLOATS = {"add_texture_rect": 8, "add_texture_rect_region": 12, "add_rect": 8}
TABLES = ("removed_canvases", "removed_items", "removed_textures", "removed_meshes",
          "removed_shaders", "removed_materials", "canvases", "items", "textures", "meshes",
          "shaders", "materials")


def _patch_texture(tid: int) -> dict:
    """golden-15 patch lane's seq 1 texture tid (the payloads its store directory holds)."""
    return g15._texture(records(GOLDEN15.joinpath("patch.rs15").read_bytes(), MAGIC_V15), 1, tid)


def with_kind_key(entry: dict, key: str, value) -> dict:
    """entry with a kind key right after `variants`."""
    out = {}
    for k, v in entry.items():
        out[k] = v
        if k == "variants":
            out[key] = value
    return out


def _bare(kind: str, *, status: str = "ok", reason=None, version: int = 1, origin="created",
          key: str | None = None, value=None) -> dict:
    e = {"id": 0, "origin": origin, "adopted_content": "current" if origin == "adopted" else None,
         "kind": kind, "status": status, "reason": reason, "version": version, "hash": None,
         "format": None, "source_format": None, "width": 0, "height": 0, "mipmaps": False,
         "payload_bytes": 0, "variants": [], "canvas": None}
    return with_kind_key(e, key, value) if key else e


def viewport_texture(vid: int, **kw) -> dict:
    return _bare("viewport", key="viewport", value=vid, **kw)


def proxy(target, **kw) -> dict:
    return _bare("proxy", key="target", value=target, **kw)


def freed(entry: dict) -> dict:
    """entry as a `freed` tombstone (same version; a kind key keeps its last value)."""
    out = dict(entry, status="freed", reason=None, hash=None, format=None, source_format=None,
               width=0, height=0, mipmaps=False, payload_bytes=0, variants=[], canvas=None)
    out.pop("size_override", None)
    return out


def _item(canvas: int, draw_index: int, x: float, y: float, tex: int, rect) -> tuple:
    entry = {"origin": "created", "parent": {"kind": "canvas", "id": canvas}, "children": [],
             "visible": True, "draw_index": draw_index, "z_index": 0, "z_relative": True,
             "behind": False, "clip": False, "custom_rect": False,
             "visibility_layer": 4294967295, "texture_filter": "default",
             "texture_repeat": "default", "material": None, "use_parent_material": False,
             "instance_params": [], "canvas_group": None, "copy_to_backbuffer": None,
             "content_version": 1}
    command = ({"op": "add_texture_rect", "tex": tex, "tile": False, "transpose": False},
               list(rect) + WHITE)
    return entry, [command], [1.0, 0.0, 0.0, 1.0, x, y] + WHITE + WHITE + NO_RECT


def _viewport(*, origin: str, parent, active: bool, active_seq: int, size, transparent: bool,
              update: str, once_seq: int, clear: str, clear_seq: int, renders_3d: bool,
              cull: int, tfilter: str, trepeat: str, snap, canvases, floats) -> tuple:
    entry = {"origin": origin, "parent": parent, "active": active, "active_seq": active_seq,
             "size": list(size), "transparent": transparent, "update": update,
             "once_seq": once_seq, "clear": clear, "clear_seq": clear_seq, "disable_2d": False,
             "renders_3d": renders_3d, "hdr_2d": False, "msaa_2d": 0, "canvas_cull_mask": cull,
             "default_texture_filter": tfilter, "default_texture_repeat": trepeat,
             "snap_2d": list(snap), "canvases": [list(r) for r in canvases]}
    assert len(floats) == 6 * (1 + len(canvases))
    return entry, list(floats)


def viewport_states() -> list[dict]:
    """The nine states of viewports.rs16 (see VIEWPORTS_DESCRIPTION)."""
    img = dict(_patch_texture(1))
    unsup = dict(_patch_texture(3), id=2)
    assert img["status"] == "ok" and unsup["status"] == "unsupported"
    textures = {
        1: img,
        2: unsup,
        3: viewport_texture(1, origin="adopted"),
        4: viewport_texture(2),
        5: proxy(9),
        6: proxy(2),
        7: dict(_bare("canvas"), canvas={"diffuse": 5, "filter": "default", "repeat": "default"}),
        8: proxy(None, status="unsupported", reason="proxy-unresolved"),
        9: viewport_texture(3),
    }
    for tid, t in textures.items():
        t["id"] = tid
    s1 = {
        "unsupported": [DERIVED_4],
        "canvases": {
            1: ({"origin": "root-query", "role": "root", "attached": True, "layer": 0,
                 "sublayer": 0, "items": [1, 2, 6]}, IDENTITY + WHITE),
            2: ({"origin": "created", "role": None, "attached": False, "layer": 0,
                 "sublayer": 0, "items": [3, 4]}, IDENTITY + WHITE),
            3: ({"origin": "created", "role": None, "attached": True, "layer": 1,
                 "sublayer": 0, "items": [5]}, [1.0, 0.0, 0.0, 1.0, 0.0, 128.0] + WHITE),
        },
        "items": {
            1: _item(1, 0, 0.0, 0.0, 3, [0.0, 0.0, 64.0, 48.0]),
            2: _item(1, 1, 80.0, 0.0, 7, [0.0, 0.0, 16.0, 16.0]),
            3: _item(2, 0, 4.0, 4.0, 5, [0.0, 0.0, 16.0, 16.0]),
            4: _item(2, 1, 24.0, 4.0, 6, [0.0, 0.0, 8.0, 8.0]),
            5: _item(3, 0, 8.0, 8.0, 4, [0.0, 0.0, 32.0, 32.0]),
            6: _item(1, 2, 160.0, 0.0, 9, [0.0, 0.0, 16.0, 16.0]),
        },
        "textures": textures,
        "viewports": {
            1: _viewport(origin="adopted", parent=0, active=True, active_seq=1, size=(64, 48),
                         transparent=False, update="always", once_seq=0, clear="always",
                         clear_seq=0, renders_3d=False, cull=4294967295, tfilter="linear",
                         trepeat="disabled", snap=(False, False),
                         canvases=[(2, 0, 0), (3, 1, 0)],
                         floats=IDENTITY + IDENTITY + [0.5, 0.0, 0.0, 0.5, 8.0, 8.0]),
            2: _viewport(origin="created", parent=1, active=True, active_seq=2, size=(32, 32),
                         transparent=True, update="when_parent_visible", once_seq=0,
                         clear="next_frame", clear_seq=1, renders_3d=False, cull=1,
                         tfilter="nearest", trepeat="enabled", snap=(True, False),
                         canvases=[(2, 0, 0)], floats=IDENTITY + [1.0, 0.0, 0.0, 1.0, 2.0, 2.0]),
            3: _viewport(origin="created", parent=None, active=False, active_seq=0,
                         size=(16, 16), transparent=False, update="disabled", once_seq=0,
                         clear="always", clear_seq=0, renders_3d=False, cull=4294967295,
                         tfilter="linear", trepeat="disabled", snap=(False, False), canvases=[],
                         floats=IDENTITY),
        },
    }
    states = [s1]

    def step(fn):
        s = copy.deepcopy(states[-1])
        fn(s)
        states.append(s)

    def vp(s, vid, **changes):
        entry, floats = s["viewports"][vid]
        floats = changes.pop("floats", floats)
        s["viewports"][vid] = (dict(entry, **changes), floats)

    # 2: viewport 1's global canvas transform moves (floats only)
    step(lambda s: vp(s, 1, floats=[1.0, 0.0, 0.0, 1.0, -4.0, 0.0] + s["viewports"][1][1][6:]))
    # 3: viewport 2 resizes
    step(lambda s: vp(s, 2, size=[48, 40]))
    # 4: viewport 3 switches to once
    step(lambda s: vp(s, 3, update="once", once_seq=1))

    # 5: proxy 5 re-points from viewport texture 9 to image 1
    def s5(s):
        s["textures"][5] = dict(s["textures"][5], target=1, version=2)
    step(s5)

    # 6: viewport 2 renders 3D; the sticky session-level entry appears
    def s6(s):
        vp(s, 2, renders_3d=True)
        s["unsupported"] = [VIEWPORT_3D] + s["unsupported"]
    step(s6)

    # 7: image 1 is freed; proxy 5 keeps its tombstone
    def s7(s):
        s["textures"][1] = freed(s["textures"][1])
    step(s7)

    # 8: viewport 3 is removed and its viewport texture freed (item 6 still names it)
    def s8(s):
        del s["viewports"][3]
        s["textures"][9] = freed(s["textures"][9])
    step(s8)
    # 9: full, unchanged
    step(lambda s: None)
    return states


VIEWPORTS_DESCRIPTION = (
    "a patch stream (seqs 1 and 9 full) over canvas 1 (root: items 1, 2, 6), canvas 2 (attached "
    "only to viewports: items 3, 4) and canvas 3 (on the root at layer 1 and on viewport 1: item "
    "5). Viewports: 1 adopted (parent 0, canvases 2 and 3), 2 nested in 1 (canvas 2), 3 out of "
    "the tree (parent null, no canvas). Textures: 1 image, 2 unsupported image, 3 adopted viewport "
    "texture of viewport 1 (adopted_content current), 4 of viewport 2, 9 of viewport 3, 5 an ok "
    "proxy of 9, 6 an ok proxy of 2 (item 4 draws it: the derived unsupported-texture entry), 7 a "
    "canvas texture whose diffuse is proxy 5, 8 an unresolved proxy. 2: viewport 1's global "
    "transform moves; 3: viewport 2 resizes 32x32 -> 48x40; 4: viewport 3 switches to once "
    "(once_seq 1); 5: proxy 5 re-points to image 1 (version 2); 6: viewport 2 renders 3D (the "
    "sticky viewport-3d entry); 7: image 1 freed, kept as a tombstone by proxy 5; 8: viewport 3 "
    "removed and texture 9 freed (item 6 keeps it); 9: full")


def _differs_vp(a: tuple, b: tuple) -> bool:
    return a[0] != b[0] or g6.f32_pattern(a[1]) != g6.f32_pattern(b[1])


def _differs_item(a: tuple, b: tuple) -> bool:
    return a[0] != b[0] or g6.f32_pattern(a[2]) != g6.f32_pattern(b[2])


def _differs_canvas(a: tuple, b: tuple) -> bool:
    return a[0] != b[0] or g6.f32_pattern(a[1]) != g6.f32_pattern(b[1])


def _block(name: str, btype: str, data: bytes, count: int) -> tuple[dict, bytes]:
    return {"name": name, "type": btype, "count": count}, data


def _f32(values: list[float]) -> bytes:
    return g6.f32s(values)


def transaction(seq: int, base: dict | None, cur: dict, *, vp_hook=None, meta_hook=None
                ) -> bytes:
    """One /16 transaction record: a full when base is None, else a patch against base (seq-1).
    vp_hook(list of (id, json, floats)) may reorder or edit the listed viewports before their
    offsets are assigned; meta_hook(meta, blocks) -> (meta, blocks) edits the result (blocks as
    [(descriptor, bytes)])."""
    full = base is None
    b = base or {"unsupported": None, "canvases": {}, "items": {}, "textures": {},
                 "viewports": {}}
    item_f32: list[float] = []
    canvas_f32: list[float] = []
    cmd_f32: list[float] = []
    canvases = []
    for cid in sorted(cur["canvases"]):
        c = cur["canvases"][cid]
        if cid in b["canvases"] and not _differs_canvas(b["canvases"][cid], c):
            continue
        canvases.append(dict({"id": cid}, **c[0]))
        canvas_f32 += c[1]
    items = []
    for iid in sorted(cur["items"]):
        it = cur["items"][iid]
        old = b["items"].get(iid)
        if old is not None and not _differs_item(old, it):
            continue
        entry = dict({"id": iid}, **it[0])
        if old is not None and old[0]["content_version"] == it[0]["content_version"]:
            entry["commands"] = None
        else:
            cmds = []
            for cj, cf in it[1]:
                cmds.append(dict(cj, f=len(cmd_f32)))
                cmd_f32 += cf
            entry["commands"] = cmds
        assert tuple(entry) == ITEM_KEYS
        items.append(entry)
        item_f32 += it[2]
    textures = [cur["textures"][t] for t in sorted(cur["textures"])
                if b["textures"].get(t) != cur["textures"][t]]
    unsupported = cur["unsupported"]
    if not full and unsupported == b["unsupported"]:
        unsupported = None
    meta = {"type": "transaction", "seq": seq, "frame": seq,
            "encoding": "full" if full else "patch", "base_seq": None if full else seq - 1,
            "status": "ok", "failures": [], "unsupported": copy.deepcopy(unsupported),
            "default_texture_filter": DEFAULT_FILTER, "default_texture_repeat": DEFAULT_REPEAT}
    for key, cur_t, base_t in (("removed_canvases", cur["canvases"], b["canvases"]),
                               ("removed_items", cur["items"], b["items"]),
                               ("removed_textures", cur["textures"], b["textures"])):
        meta[key] = sorted(set(base_t) - set(cur_t))
    meta.update(removed_meshes=[], removed_shaders=[], removed_materials=[],
                canvases=canvases, items=items, textures=copy.deepcopy(textures), meshes=[],
                shaders=[], materials=[])
    removed_vp = sorted(set(b["viewports"]) - set(cur["viewports"]))
    listed = [(vid, cur["viewports"][vid][0], cur["viewports"][vid][1])
              for vid in sorted(cur["viewports"])
              if vid not in b["viewports"] or _differs_vp(b["viewports"][vid],
                                                         cur["viewports"][vid])]
    if vp_hook is not None:
        listed = vp_hook(listed)
    viewport_f32: list[float] = []
    vps = []
    for vid, entry, floats in listed:
        vps.append(dict({"id": vid}, **copy.deepcopy(entry), f=len(viewport_f32)))
        viewport_f32 += floats
    if removed_vp:
        meta["removed_viewports"] = removed_vp
    if vps:
        meta["viewports"] = vps
    meta["predict_check"] = g13.check_hex({})  # no mesh, no multimesh: the three blocks empty
    blocks = [_block("item_f32", "f32", _f32(item_f32), len(item_f32)),
              _block("canvas_f32", "f32", _f32(canvas_f32), len(canvas_f32)),
              _block("cmd_f32", "f32", _f32(cmd_f32), len(cmd_f32)),
              _block("cmd_i32", "i32", b"", 0),
              _block("mesh_f32", "f32", b"", 0),
              _block("param_f64", "f64", b"", 0),
              _block("backbuffer_f32", "f32", b"", 0),
              _block("mesh_u8", "u8", b"", 0),
              _block("mm_f32", "f32", b"", 0)]
    if vps:
        blocks.append(_block("viewport_f32", "f32", _f32(viewport_f32), len(viewport_f32)))
    if meta_hook is not None:
        meta, blocks = meta_hook(meta, blocks)
    meta = dict(meta, blocks=[d for d, _ in blocks])
    return make_record(g6.canonical_json(meta), [data for _, data in blocks])


def end_record(body: list[bytes], states: int, fulls: int) -> bytes:
    meta = {"type": "end", "transactions": states, "reason": "shutdown",
            "stats": {"bytes_total": len(MAGIC) + sum(len(r) for r in body),
                      "encode_ns_total": 250000, "snapshot_ns_total": 40000,
                      "diff_ns_total": 12345, "max_record_bytes": max(len(r) for r in body),
                      "full_transactions": fulls, "patch_transactions": states - fulls,
                      "resource_records": 0, "resource_bytes": 0},
            "blocks": []}
    return make_record(g6.canonical_json(meta), [])


def encode_stream(session: bytes, states: list[dict], *, fulls=VIEWPORTS_FULLS, hooks=None,
                  magic: bytes = MAGIC) -> bytes:
    """session record + one transaction per state + the end record. hooks: {seq: {"vp": fn,
    "meta": fn}} (see `transaction`)."""
    hooks = hooks or {}
    body = [session]
    for i, s in enumerate(states):
        seq = i + 1
        h = hooks.get(seq, {})
        body.append(transaction(seq, None if seq in fulls else states[i - 1], s,
                                vp_hook=h.get("vp"), meta_hook=h.get("meta")))
    return magic + b"".join(body) + end_record(body, len(states),
                                               sum(1 for s in fulls if s <= len(states)))


# --------------------------------------------------------------------------- decoded / resolved

def _decode_block(desc: dict, data: bytes):
    t, n = desc["type"], desc["count"]
    if t == "u8":
        assert len(data) == n
        return {"u8_bytes": n, "sha256": _sha256(data)}
    width = {"f32": 4, "i32": 4, "f64": 8}[t]
    assert len(data) == width * n
    return list(struct.unpack(f"<{n}{ {'f32': 'f', 'i32': 'i', 'f64': 'd'}[t] }", data))


def decode16(data: bytes) -> dict:
    """render-stream-16-decoded/1 of a stream with no mesh or multimesh: every predicted block is
    empty, so its /12 value is its (empty) wire value."""
    out = []
    offset = len(MAGIC)
    for raw in records(data):
        meta_b, blocks = parse_record(raw)
        meta = json.loads(meta_b)
        dec = []
        for desc, b in zip(meta["blocks"], blocks):
            if desc["name"] in g13.PREDICTED and meta["type"] == "transaction":
                assert b == b"" and desc["count"] == 0
            dec.append(_decode_block(desc, b))
        out.append({"offset": offset, "byte_length": len(raw), "sha256": _sha256(raw),
                    "meta": meta, "blocks": dec})
        offset += len(raw)
    return {"schema": "render-stream-16-decoded/1", "magic": MAGIC.hex(), "records": out}


def _named(meta: dict, dec: list) -> dict:
    return {d["name"]: v for d, v in zip(meta["blocks"], dec)}


def resolve16(decoded: dict) -> dict:
    """render-stream-16-resolved/1 from the decoded form (wire semantics only)."""
    st = None
    txs = []
    for rec in decoded["records"]:
        m = rec["meta"]
        if m["type"] != "transaction":
            continue
        blk = _named(m, rec["blocks"])
        if m["encoding"] == "full":
            st = {"unsupported": None, "canvases": {}, "items": {}, "textures": {},
                  "viewports": {}}
        else:
            st = copy.deepcopy(st)
        for rid in m["removed_canvases"]:
            del st["canvases"][rid]
        for rid in m["removed_items"]:
            del st["items"][rid]
        for rid in m["removed_textures"]:
            del st["textures"][rid]
        for rid in m.get("removed_viewports", []):
            del st["viewports"][rid]
        cf = blk["canvas_f32"]
        for k, c in enumerate(m["canvases"]):
            st["canvases"][c["id"]] = dict(c, xform=cf[10 * k:10 * k + 6],
                                           modulate=cf[10 * k + 6:10 * k + 10])
        itf, cmf = blk["item_f32"], blk["cmd_f32"]
        for k, it in enumerate(m["items"]):
            f = itf[18 * k:18 * k + 18]
            entry = {key: v for key, v in it.items() if key != "commands"}
            entry.update(xform=f[0:6], modulate=f[6:10], self_modulate=f[10:14],
                         custom_rect_rect=f[14:18])
            if it["commands"] is None:
                entry["commands"] = st["items"][it["id"]]["commands"]
            else:
                cmds = []
                for c in it["commands"]:
                    assert c["op"] == "add_texture_rect"
                    o = c["f"]
                    cmds.append({"op": c["op"], "tex": c["tex"], "tile": c["tile"],
                                 "transpose": c["transpose"], "rect": cmf[o:o + 4],
                                 "modulate": cmf[o + 4:o + 8]})
                entry["commands"] = cmds
            st["items"][it["id"]] = entry
        for t in m["textures"]:
            st["textures"][t["id"]] = t
        vf = blk.get("viewport_f32", [])
        for v in m.get("viewports", []):
            o = v["f"]
            rows = len(v["canvases"])
            entry = {key: val for key, val in v.items() if key != "f"}
            entry["floats"] = {"global_xform": vf[o:o + 6],
                               "canvas_xforms": [vf[o + 6 * (r + 1):o + 6 * (r + 2)]
                                                 for r in range(rows)]}
            st["viewports"][v["id"]] = entry
        if m["unsupported"] is not None:
            st["unsupported"] = m["unsupported"]
        state = {"status": m["status"], "failures": m["failures"],
                 "unsupported": st["unsupported"],
                 "default_texture_filter": m["default_texture_filter"],
                 "default_texture_repeat": m["default_texture_repeat"],
                 "canvases": [st["canvases"][i] for i in sorted(st["canvases"])],
                 "items": [st["items"][i] for i in sorted(st["items"])],
                 "textures": [st["textures"][i] for i in sorted(st["textures"])],
                 "meshes": [], "shaders": [], "materials": []}
        if st["viewports"]:
            state["viewports"] = [st["viewports"][i] for i in sorted(st["viewports"])]
        txs.append({"seq": m["seq"], "frame": m["frame"], "state": copy.deepcopy(state)})
    return {"schema": "render-stream-16-resolved/1", "transactions": txs}


# --------------------------------------------------------------------------- reference checker

class Fail(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _is_int(v, lo=None, hi=None) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and (lo is None or v >= lo) and (
        hi is None or v <= hi)


def _check_vp_shape(v) -> None:
    """viewport-entry's value rules on one listed entry (key set and order checked before)."""
    ok = (_is_int(v["id"], 1) and v["origin"] in ("created", "adopted")
          and (v["parent"] is None or _is_int(v["parent"], 0))
          and isinstance(v["active"], bool) and _is_int(v["active_seq"], 0)
          and isinstance(v["size"], list) and len(v["size"]) == 2
          and all(_is_int(x, 0) for x in v["size"])
          and isinstance(v["transparent"], bool) and v["update"] in UPDATES
          and _is_int(v["once_seq"], 0) and v["clear"] in CLEARS and _is_int(v["clear_seq"], 0)
          and all(isinstance(v[k], bool) for k in ("disable_2d", "renders_3d", "hdr_2d"))
          and v["msaa_2d"] in (0, 1, 2, 3) and _is_int(v["msaa_2d"])
          and _is_int(v["canvas_cull_mask"], 0, 4294967295)
          and v["default_texture_filter"] in FILTERS and v["default_texture_repeat"] in REPEATS
          and isinstance(v["snap_2d"], list) and len(v["snap_2d"]) == 2
          and all(isinstance(x, bool) for x in v["snap_2d"])
          and isinstance(v["canvases"], list)
          and all(isinstance(r, list) and len(r) == 3 and _is_int(r[0], 1) and _is_int(r[1])
                  and _is_int(r[2]) for r in v["canvases"])
          and _is_int(v["f"], 0))
    if not ok:
        raise Fail("viewport-entry")
    ids = [r[0] for r in v["canvases"]]
    if any(a >= b for a, b in zip(ids, ids[1:])):
        raise Fail("viewport-entry")


def _texture_rules(t: dict, on: bool) -> None:
    kind, status = t.get("kind"), t.get("status")
    keyed = {"viewport": "viewport", "proxy": "target"}
    if kind in keyed and not on:
        raise Fail("meta-schema")
    for k, key in keyed.items():
        if (key in t) != (kind == k):
            raise Fail("meta-schema")
    want = list(TEXTURE_KEYS) + (["size_override"] if "size_override" in t else []) + (
        [keyed[kind]] if kind in keyed else []) + ["canvas"]
    if list(t) != want:
        raise Fail("meta-schema")
    if t["reason"] == "proxy-unresolved" and not on:
        raise Fail("meta-schema")
    if kind in keyed:
        if status == "unsupported" and kind == "viewport":
            raise Fail("texture-entry")
        bare = (t["hash"] is None and t["format"] is None and t["source_format"] is None
                and t["width"] == 0 and t["height"] == 0 and t["mipmaps"] is False
                and t["payload_bytes"] == 0 and t["variants"] == [] and t["canvas"] is None)
        if not bare or status not in ("ok", "unsupported", "freed"):
            raise Fail("texture-entry")
        if status == "unsupported" and t["reason"] != "proxy-unresolved":
            raise Fail("texture-entry")
        if status != "unsupported" and t["reason"] is not None:
            raise Fail("texture-entry")
        if kind == "viewport" and status == "ok" and not _is_int(t["viewport"], 1):
            raise Fail("texture-entry")
        if t["origin"] == "adopted" and t["adopted_content"] != "current":
            raise Fail("adoption-entry")
    elif t["reason"] == "proxy-unresolved":
        raise Fail("texture-entry")


def _derived(items: dict, textures: dict) -> list[tuple]:
    """(item, op) pairs that need the derived unsupported-texture entry (render-stream-2.md, with
    /16's one proxy hop)."""
    def hop(tid):
        t = textures.get(tid)
        if t is not None and t["kind"] == "proxy" and t["status"] == "ok":
            return textures.get(t["target"])
        return t

    def unsupported_ref(tid) -> bool:
        t = hop(tid)
        if t is None:
            return False
        if t["status"] == "unsupported":
            return True
        if t["kind"] == "canvas" and t["canvas"] is not None:
            d = hop(t["canvas"]["diffuse"]) if t["canvas"]["diffuse"] is not None else None
            return d is not None and d["status"] == "unsupported"
        return False

    out = set()
    for iid, it in items.items():
        for c in it["commands"] or []:
            if c["op"] in ("add_texture_rect", "add_texture_rect_region") and \
                    c["tex"] is not None and unsupported_ref(c["tex"]):
                out.add((iid, "canvas_item_" + c["op"]))
    return sorted(out)


def viewport_check(data: bytes, version: int = 16):
    """The first /16 failure as (code, record_index, seq), else None."""
    recs = records(data, MAGIC if version >= 16 else MAGIC_V15)
    session = _meta(recs[0])
    keys = list(session)
    if version >= 16:
        if keys[-2:] != ["viewports", "blocks"] or keys[-3] != "adoption" or \
                session["viewports"] not in ("on", "off", "unavailable"):
            return ("meta-schema", 0, None)
        on = session["viewports"] == "on"
    else:
        if "viewports" in session:
            return ("meta-schema", 0, None)
        on = False
    st = None
    seen_vp: set[int] = set()
    for i, rec in enumerate(recs[1:], start=1):
        meta_b, blocks = parse_record(rec)
        m = json.loads(meta_b)
        if m.get("type") != "transaction":
            continue
        seq = m["seq"]
        try:
            full = m["encoding"] == "full"
            base = st
            if full:
                st = {"canvases": {}, "items": {}, "textures": {}, "viewports": {},
                      "unsupported": None}
            else:
                st = copy.deepcopy(st)
            mk = list(m)
            tail = mk[mk.index("materials") + 1:]
            opt = [k for k in tail if k in ("removed_viewports", "viewports")]
            if opt and not on:
                raise Fail("meta-schema")
            j = tail.index("predict_check")
            if tail[j - len(opt):j] != opt or opt not in ([], ["removed_viewports"],
                                                          ["viewports"],
                                                          ["removed_viewports", "viewports"]):
                raise Fail("meta-schema")
            for k in opt:
                if m[k] == []:
                    raise Fail("meta-schema")
            for v in m.get("viewports", []):
                if list(v) != list(VIEWPORT_KEYS):
                    raise Fail("meta-schema")
            names = [d["name"] for d in m["blocks"]]
            if "viewport_f32" in names and (not on or names[-1] != "viewport_f32"):
                raise Fail("meta-schema")
            for t in m["textures"]:
                _texture_rules(t, on)
            for u in m["unsupported"] or []:
                r = u["reason"]
                if r in VIEWPORT_REASONS and not on:
                    raise Fail("meta-schema")
            # resolve
            for rid in m["removed_canvases"]:
                st["canvases"].pop(rid, None)
            for rid in m["removed_items"]:
                st["items"].pop(rid, None)
            for rid in m["removed_textures"]:
                st["textures"].pop(rid, None)
            if "removed_viewports" in m:
                if full:
                    raise Fail("patch-encoding")
                for rid in m["removed_viewports"]:
                    if rid not in base["viewports"]:
                        raise Fail("patch-removed")
                    st["viewports"].pop(rid)
            for c in m["canvases"]:
                st["canvases"][c["id"]] = c
            for it in m["items"]:
                old = st["items"].get(it["id"])
                if it["commands"] is None:
                    it = dict(it, commands=old["commands"])
                st["items"][it["id"]] = it
            for t in m["textures"]:
                st["textures"][t["id"]] = t
            if m["unsupported"] is not None:
                st["unsupported"] = m["unsupported"]
            tex = st["textures"]
            # texture-ref (/15 half, with /16's diffuse kinds)
            for t in tex.values():
                if t["kind"] == "canvas" and t["canvas"] is not None and \
                        t["canvas"]["diffuse"] is not None:
                    d = tex.get(t["canvas"]["diffuse"])
                    if d is None or d["kind"] not in ("image", "placeholder", "viewport",
                                                      "proxy"):
                        raise Fail("texture-ref")
            for it in st["items"].values():
                for c in it["commands"] or []:
                    if c.get("tex") is not None and c["tex"] not in tex:
                        raise Fail("texture-ref")
            # unsupported-mismatch
            ulist = st["unsupported"] or []
            for u in ulist:
                if u["item"] is None:
                    if u["reason"] in VIEWPORT_REASONS and \
                            u["op"] != VIEWPORT_REASONS[u["reason"]]:
                        raise Fail("unsupported-mismatch")
                    if u["reason"] == "non-root-viewport" and on:
                        raise Fail("unsupported-mismatch")
            have = sorted((u["item"], u["op"]) for u in ulist
                          if u["reason"] == "unsupported-texture")
            if have != _derived(st["items"], tex):
                raise Fail("unsupported-mismatch")
            # viewport-offset
            vf = [d for d in m["blocks"] if d["name"] == "viewport_f32"]
            if ("viewports" in m) != bool(vf):
                raise Fail("viewport-offset")
            run = 0
            for v in m.get("viewports", []):
                if v["f"] != run:
                    raise Fail("viewport-offset")
                run += 6 + 6 * len(v["canvases"])
            if vf and vf[0]["count"] != run:
                raise Fail("viewport-offset")
            # resolved: viewport-entry
            for v in m.get("viewports", []):
                _check_vp_shape(v)
            ids = [v["id"] for v in m.get("viewports", [])]
            if any(a >= b for a, b in zip(ids, ids[1:])):
                raise Fail("viewport-entry")
            for v in m.get("viewports", []):
                if v["id"] in seen_vp and (base is None or v["id"] not in base["viewports"]):
                    raise Fail("id-reused")
                seen_vp.add(v["id"])
                if v["origin"] == "adopted" and session["adoption"] is None:
                    raise Fail("adoption-entry")
                st["viewports"][v["id"]] = v
            vps = st["viewports"]
            for v in vps.values():
                if any(r[0] not in st["canvases"] for r in v["canvases"]):
                    raise Fail("viewport-entry")
                if v["parent"] not in (None, 0) and v["parent"] not in vps:
                    raise Fail("viewport-entry")
                n = sum(1 for t in tex.values() if t["kind"] == "viewport"
                        and t["status"] == "ok" and t["viewport"] == v["id"])
                if n != 1:
                    raise Fail("viewport-entry")
            # viewport-parent-cycle
            for v in vps.values():
                walk, p = {v["id"]}, v["parent"]
                while p not in (None, 0):
                    if p in walk:
                        raise Fail("viewport-parent-cycle")
                    walk.add(p)
                    p = vps[p]["parent"]
            # texture-ref (viewport half), proxy-target
            for t in tex.values():
                if t["kind"] == "viewport" and t["status"] == "ok" and t["viewport"] not in vps:
                    raise Fail("texture-ref")
            for t in tex.values():
                if t["kind"] != "proxy" or t["status"] == "freed":
                    continue
                if t["status"] == "unsupported":
                    if t["target"] is not None:
                        raise Fail("proxy-target")
                    continue
                target = tex.get(t["target"]) if t["target"] is not None else None
                if target is None or target["kind"] == "proxy":
                    raise Fail("proxy-target")
        except Fail as e:
            return (e.code, i, seq)
    return None


def _session16(*, viewports: str | None = "on") -> bytes:
    """golden-16's patch.rs16 session record (viewports "on"), or with another value / none."""
    p15 = records(GOLDEN15.joinpath("patch.rs15").read_bytes(), MAGIC_V15)
    meta_b, blocks = parse_record(p15[0])
    meta_b = g13._swap_protocol(meta_b, PROTOCOL_V15, PROTOCOL)
    if viewports is not None:
        meta_b = _session_key(meta_b, f',"viewports":"{viewports}"'.encode("ascii"),
                              insert=True)
    return make_record(meta_b, blocks)


# --------------------------------------------------------------------------- invalid

def _all(fn, states=None, seqs=None):
    states = copy.deepcopy(states or viewport_states())
    for k, s in enumerate(states):
        if seqs is None or k + 1 in seqs:
            fn(s)
    return states


def _set_vp(vid, **changes):
    def fn(s):
        if vid in s["viewports"]:
            e, f = s["viewports"][vid]
            s["viewports"][vid] = (dict(e, **changes), f)
    return fn


def _set_tex(tid, **changes):
    def fn(s):
        if tid in s["textures"]:
            s["textures"][tid] = dict(s["textures"][tid], **changes)
    return fn


def _add_tex(entry):
    def fn(s):
        s["textures"][entry["id"]] = copy.deepcopy(entry)
    return fn


def _insert_before(meta: dict, before: str, key: str, value) -> dict:
    out = {}
    for k, v in meta.items():
        if k == before:
            out[key] = value
        out[k] = v
    return out


def build_invalid(outputs: dict[str, bytes]):
    """name -> (bytes, code, description, version, record_index, seq)."""
    sess = _session16()
    out = {}

    def add(name, data, code, description, at, seq, version=16):
        out[name] = (data, code, description, version, at, seq)

    def vec(states=None, hooks=None, session=sess):
        return encode_stream(session, states or viewport_states(), hooks=hooks)

    # viewport-entry
    add("viewport-entry-enum", vec(_all(_set_vp(1, update="sometimes"))), "viewport-entry",
        "viewport 1's update is \"sometimes\", not one of the five modes", 1, 1)
    # A bad id is viewport-entry's, never id-reused (a value error is reported before any id rule).
    for suffix, bad, what in (("zero", 0, "0"), ("negative", -3, "-3"), ("string", "x", '"x"')):
        add(f"viewport-entry-id-{suffix}", vec(_all(_set_vp(1, id=bad))), "viewport-entry",
            f"viewport 1's id is {what}, not an integer >= 1", 1, 1)
    add("viewport-entry-order", vec(hooks={1: {"vp": lambda lst: list(reversed(lst))}}),
        "viewport-entry", "seq 1 lists viewports 3, 2, 1 (offsets follow the listed order)", 1, 1)

    def extra_row(s):
        e, f = s["viewports"][1]
        s["viewports"][1] = (dict(e, canvases=e["canvases"] + [[9, 0, 0]]), f + IDENTITY)
    add("viewport-entry-canvas", vec(_all(extra_row)), "viewport-entry",
        "viewport 1 gains a canvases row [9, 0, 0] (with its 6 floats); no canvas 9 exists",
        1, 1)
    add("viewport-entry-parent", vec(_all(_set_vp(2, parent=7))), "viewport-entry",
        "viewport 2's parent is 7, neither null, 0 nor a viewport", 1, 1)

    vp3 = viewport_states()[0]["viewports"][3]

    def vp4(s):
        s["viewports"][4] = (dict(vp3[0], parent=0), list(vp3[1]))
    add("viewport-entry-no-texture", vec(_all(vp4)), "viewport-entry",
        "viewport 4 (viewport 3's values, parent 0) exists from seq 1 with no viewport texture",
        1, 1)
    add("viewport-entry-two-textures", vec(_all(_add_tex(dict(viewport_texture(1), id=10)))),
        "viewport-entry", "texture 10, a second ok viewport texture of viewport 1, from seq 1",
        1, 1)

    # viewport-parent-cycle
    add("viewport-parent-cycle", vec(_all(_set_vp(1, parent=2))), "viewport-parent-cycle",
        "viewport 1's parent is 2 while viewport 2's parent is 1", 1, 1)
    add("viewport-parent-self", vec(_all(_set_vp(3, parent=3))), "viewport-parent-cycle",
        "viewport 3 is its own parent (seqs 1-7)", 1, 1)

    # viewport-offset
    def wrong_f(meta, blocks):
        meta["viewports"][1]["f"] += 1
        return meta, blocks
    add("viewport-offset-wrong", vec(hooks={1: {"meta": wrong_f}}), "viewport-offset",
        "seq 1: viewport 2's f is 19, expected 18 (viewport 1 claims 18 floats)", 1, 1)
    add("viewport-offset-missing",
        vec(hooks={1: {"meta": lambda m, b: (m, [x for x in b if x[0]["name"] != "viewport_f32"])}}),
        "viewport-offset", "seq 1 lists three viewports but carries no viewport_f32 block", 1, 1)
    add("viewport-offset-stray",
        vec(hooks={5: {"meta": lambda m, b: (m, b + [_block("viewport_f32", "f32",
                                                             _f32(IDENTITY), 6)])}}),
        "viewport-offset",
        "seq 5 (no viewports key) carries a viewport_f32 block of 6 floats", 5, 5)

    # proxy-target
    add("proxy-target-proxy", vec(_all(_set_tex(5, target=6), seqs=range(1, 5))),
        "proxy-target", "seqs 1-4: ok proxy 5 targets proxy 6", 1, 1)
    add("proxy-target-null", vec(_all(_set_tex(5, target=None), seqs=range(1, 5))),
        "proxy-target", "seqs 1-4: ok proxy 5's target is null", 1, 1)
    add("proxy-target-unsupported", vec(_all(_set_tex(8, target=1))), "proxy-target",
        "unsupported proxy 8 (proxy-unresolved) has target 1", 1, 1)
    add("proxy-target-dangling", vec(_all(_set_tex(5, target=99), seqs=range(1, 5))),
        "proxy-target", "seqs 1-4: ok proxy 5 targets 99, no entry", 1, 1)

    # texture-entry
    add("proxy-unresolved-image", vec(_all(_set_tex(2, reason="proxy-unresolved"))),
        "texture-entry", "unsupported image 2's reason is proxy-unresolved", 1, 1)
    add("viewport-texture-unsupported",
        vec(_all(_add_tex(dict(viewport_texture(1, status="unsupported",
                                                reason="payload-unavailable"), id=10)))),
        "texture-entry",
        "texture 10, a viewport texture of viewport 1 with status unsupported (reason "
        "payload-unavailable), from seq 1 (texture 3 stays viewport 1's ok one)", 1, 1)

    # texture-ref
    add("viewport-texture-dangling", vec(_all(_add_tex(dict(viewport_texture(7), id=10)))),
        "texture-ref", "texture 10, an ok viewport texture of viewport 7, which does not exist",
        1, 1)
    add("viewport-diffuse-canvas",
        vec(_all(_add_tex(dict(_bare("canvas"), id=10,
                               canvas={"diffuse": 7, "filter": "default",
                                       "repeat": "default"})))),
        "texture-ref", "texture 10, a canvas texture whose diffuse is canvas texture 7", 1, 1)

    # unsupported-mismatch
    nrv = {"op": "viewport_attach_canvas", "item": None, "reason": "non-root-viewport"}

    def add_nrv(s):
        s["unsupported"] = [nrv] + s["unsupported"]
    add("viewport-non-root", vec(_all(add_nrv)), "unsupported-mismatch",
        "a session-level non-root-viewport entry from seq 1 under \"viewports\":\"on\"", 1, 1)

    def wrong_op(s):
        s["unsupported"] = [dict(u, op="viewport_set_msaa_2d") if u == VIEWPORT_3D else u
                            for u in s["unsupported"]]
    add("viewport-3d-op", vec(_all(wrong_op)), "unsupported-mismatch",
        "from seq 6 the viewport-3d entry's op is viewport_set_msaa_2d", 6, 6)

    def drop_derived(s):
        s["unsupported"] = [u for u in s["unsupported"] if u != DERIVED_4]
    add("proxy-derived-missing", vec(_all(drop_derived)), "unsupported-mismatch",
        "item 4 draws ok proxy 6 of unsupported image 2 with no derived unsupported-texture "
        "entry", 1, 1)

    # meta-schema
    add("viewport-key-off", vec(session=_session16(viewports="off")), "meta-schema",
        "viewports.rs16 with the session's viewports \"off\": seq 1's viewport table", 1, 1)

    def empty_vps(meta, blocks):
        assert "viewports" not in meta
        return _insert_before(meta, "predict_check", "viewports", []), blocks
    add("viewport-empty-list", vec(hooks={5: {"meta": empty_vps}}), "meta-schema",
        "seq 5 carries \"viewports\":[]", 5, 5)

    def kind_key(s):
        s["textures"][1] = with_kind_key(s["textures"][1], "viewport", 1)
    add("viewport-kind-key", vec(_all(kind_key)), "meta-schema",
        "image texture 1 carries a \"viewport\" key", 1, 1)
    add("viewport-session-missing", vec(session=_session16(viewports=None)), "meta-schema",
        "viewports.rs16 whose session has no viewports key", 0, None)

    # patch-removed
    def removed_absent(meta, blocks):
        return _insert_before(meta, "viewports", "removed_viewports", [5]), blocks
    add("viewport-removed-absent", vec(hooks={3: {"meta": removed_absent}}), "patch-removed",
        "seq 3 lists removed_viewports [5]; seq 2's state has no viewport 5", 3, 3)

    # /15 file with a viewports key
    p15 = records(GOLDEN15.joinpath("patch.rs15").read_bytes(), MAGIC_V15)
    meta_b, blocks = parse_record(p15[1])
    meta = json.loads(meta_b)
    assert g6.canonical_json(meta) == meta_b
    vp_entry = dict({"id": 1}, **viewport_states()[0]["viewports"][3][0], f=0)
    meta = _insert_before(meta, "predict_check", "viewports", [vp_entry])
    meta["blocks"] = meta["blocks"] + [{"name": "viewport_f32", "type": "f32", "count": 6}]
    p15[1] = make_record(g6.canonical_json(meta), blocks + [_f32(IDENTITY)])
    add("viewport-at-15", g15.with_end(p15), "meta-schema",
        "golden-15's patch.rs15 whose seq 1 carries a viewports key (one entry) and a "
        "viewport_f32 block: unknown below /16", 1, 1, version=15)

    for name, (data, code, _d, version, at, seq) in out.items():
        got = viewport_check(data, version)
        assert got == (code, at, seq), (name, got)
    return out


# --------------------------------------------------------------------------- build

def build() -> dict[str, bytes]:
    out15 = g15.build()
    for rel, data in out15.items():
        assert (GOLDEN15 / rel).read_bytes() == data, f"golden-15 is stale: {rel}"
    i15 = json.loads(out15["index.json"])
    outputs: dict[str, bytes] = {}
    for rel, data in out15.items():
        if rel == "invalid/bad-magic.rs15":
            outputs["invalid/bad-magic.rs16"] = out15["full.rs15"]
        elif rel.endswith(".rs15"):
            d16 = restamp(data)
            assert stamp15(d16) == data, rel
            assert len(d16) == len(data) + len(VIEWPORTS_ON), rel
            outputs[_rename(rel)] = d16
    for lane in ("full", "patch", "inline", "predict", "hints"):
        d16 = outputs[f"{lane}.rs16"]
        outputs[f"{lane}.hex"] = g6.to_hex(d16).encode("ascii")
        outputs[f"{lane}.decoded.json"] = _decoded16(out15[f"{lane}.decoded.json"], d16)
    for rel in ("resolved.json", "predict-resolved.json", "hints-resolved.json"):
        outputs[rel] = _resolved16(out15[rel])
    outputs["zero-runs.json"] = out15["zero-runs.json"]

    states = viewport_states()
    vp16 = encode_stream(_session16(), states)
    assert records(vp16)[0] == records(outputs["patch.rs16"])[0], "patch.rs16's session"
    err = viewport_check(vp16)
    assert err is None, err
    decoded = decode16(vp16)
    resolved = resolve16(decoded)
    assert [t["seq"] for t in resolved["transactions"]] == list(range(1, len(states) + 1))
    for tx, s in zip(resolved["transactions"], states):  # the resolver agrees with the states
        st = tx["state"]
        assert st["unsupported"] == s["unsupported"]
        assert [t["id"] for t in st["textures"]] == sorted(s["textures"])
        assert st["textures"] == [s["textures"][k] for k in sorted(s["textures"])]
        assert [v["id"] for v in st["viewports"]] == sorted(s["viewports"])
        for v in st["viewports"]:
            e, f = s["viewports"][v["id"]]
            assert {k: x for k, x in v.items() if k not in ("id", "floats")} == e
            assert v["floats"]["global_xform"] + sum(v["floats"]["canvas_xforms"], []) == f
    full9 = resolved["transactions"][-1]["state"]
    assert full9 == resolved["transactions"][-2]["state"], "seq 9 (full) resolves as seq 8"
    outputs["viewports.rs16"] = vp16
    outputs["viewports.hex"] = g6.to_hex(vp16).encode("ascii")
    outputs["viewports.decoded.json"] = g6.pretty(decoded)
    outputs["viewports-resolved.json"] = g6.pretty(resolved)

    bad = build_invalid(outputs)
    for name, (data, _c, _d, version, _at, _s) in bad.items():
        outputs[f"invalid/{name}.rs{version}"] = data

    def desc(text: str) -> str:
        return text.replace(".rs15", ".rs16")

    def ref15(rel: str) -> str:
        """A golden-15 path of a file golden-16 does not copy, as seen from golden-16."""
        return rel if rel.startswith("../") else f"../golden-15/{rel}"

    invalid = []
    for e in i15["invalid"]:
        if e["version"] < 15:
            e = dict(e, file=ref15(e["file"]))
        else:
            e = dict(e, file=_rename(e["file"]), version=16, description=desc(e["description"]))
        if e["file"] == "invalid/bad-magic.rs16":
            e["description"] = "golden-15's full.rs15: magic byte 3 is 'F' (GRSF), not 'G'"
        invalid.append(e)
    invalid += [
        {"file": f"invalid/{name}.rs{version}", "code": code, "version": version, "seq": seq,
         "record_index": at, "description": description}
        for name, (_d, code, description, version, at, seq) in bad.items()
    ]
    valid = [dict(e, file=_rename(e["file"]), sha256=_sha256(outputs[_rename(e["file"])]),
                  rs15=f"../golden-15/{e['file']}")
             for e in i15["valid"]]
    p = i15["predict"]
    predict = dict(p, file="predict.rs16", sha256=_sha256(outputs["predict.rs16"]),
                   rs15="../golden-15/predict.rs15")
    sabotage = {}
    for k, v in i15["sabotage"].items():
        v = dict(v)
        if "vector" in v:
            v["vector"] = _rename(v["vector"])
        if "fails" in v:
            v["fails"] = [dict(f, file=_rename(f["file"])) for f in v["fails"]]
        sabotage[k] = v
    item_meta_valid = []
    for e in i15["item_meta_valid"]:
        own = "sha256" in e
        rs15 = e["file"]
        e = dict(e, file=_rename(e["file"]), description=desc(e["description"]))
        if own:
            e["sha256"] = _sha256(outputs[e["file"]])
            e["rs15"] = f"../golden-15/{rs15}"
        item_meta_valid.append(e)
    h = i15["hints"]
    hints = {"file": "hints.rs16", "hex": "hints.hex", "decoded": "hints.decoded.json",
             "resolved": "hints-resolved.json", "sha256": _sha256(outputs["hints.rs16"]),
             "rs14": "../golden-15/hints.rs14", "rs15": "../golden-15/hints.rs15",
             "hints_at_end": h["hints_at_end"], "description": desc(h["description"])}
    index = {
        "schema": "render-stream-16-golden-index/1",
        "protocol": PROTOCOL,
        "valid": valid,
        "resolved": "resolved.json",
        "predict": predict,
        "predict_trace": {_rename(k): v for k, v in i15["predict_trace"].items()},
        "zero_runs": i15["zero_runs"],
        "sabotage": sabotage,
        "corrupt": [dict(e, file=_rename(e["file"]), description=desc(e["description"]))
                    for e in i15["corrupt"]],
        "invalid": invalid,
        "item_meta_valid": item_meta_valid,
        "hints": hints,
        "viewports": {
            "file": "viewports.rs16", "hex": "viewports.hex",
            "decoded": "viewports.decoded.json", "resolved": "viewports-resolved.json",
            "sha256": _sha256(vp16), "description": VIEWPORTS_DESCRIPTION,
        },
    }
    outputs["index.json"] = g6.pretty(index)
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
        print(f"golden-16: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"golden-16: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
