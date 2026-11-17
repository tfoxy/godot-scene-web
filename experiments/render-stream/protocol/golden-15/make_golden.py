#!/usr/bin/env python3
"""Generate the render-stream/15 golden vectors (stdlib only, deterministic).

render-stream/15 (../render-stream-15.md) is render-stream/14 plus resource hints (the
`resource_hint` / `resource_unhint` records, canonical JSON with no blocks) and a texture entry's
optional `size_override` (right after `variants`). Every other byte is /14's.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Outputs:

- Every golden-14 vector re-stamped /15 (`restamp`: the magic and the session's "protocol"; every
  record keeps its length, so every expectation is golden-14's): full / patch / inline / predict
  .rs15 with .hex and .decoded.json (render-stream-15-decoded/1, each record's sha256 its /15
  bytes'), resolved.json and predict-resolved.json (render-stream-15-resolved/1), corrupt-meta.rs15,
  invalid/*.rs15, item-meta.rs15, item-meta-v2.rs15 and zero-runs.json (golden-14's, unchanged).
  The /12, /13 twins and golden-14's two /13 files are not copied: index.json names them under
  ../golden-12, ../golden-13 and ../golden-14. invalid/bad-magic.rs15 is golden-14's full.rs14
  (GRSE, not GRSF).
- hints.rs15: patch.rs15 with hints and a size override (`hints_stream`). Before seq 1: a `warm`
  hint of texture 1's payload with a path and a `warm` hint of texture 5's without one; before
  seq 3 a `create` hint of the payload seq 3 first names; before seq 7 a `create` hint with a path
  and a `block` variant of texture 11's payload (seq 7 creates it; seq 8 adds a uastc variant the
  hint does not list); after seq 12 an unhint of texture 5's payload. From seq 9 texture 11 draws
  at 15x13 (`size_override`, version 1 -> 2; the fulls after carry it). hints.rs14 is its
  `transcode --to 14` (`to14`); hints.decoded.json and hints-resolved.json its forms (golden-14's
  patch forms with the same edits).
- invalid/hint-*.rs15, invalid/size-override-*.rs15, invalid/hint-at-14.rs14 and
  invalid/size-override-at-14.rs14 (`build_invalid`): one rule of render-stream-15.md broken
  each.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN14 = HERE.parent / "golden-14"
G14_SPEC = importlib.util.spec_from_file_location("golden14_make_golden",
                                                  GOLDEN14 / "make_golden.py")
g14 = importlib.util.module_from_spec(G14_SPEC)
sys.modules["golden14_make_golden"] = g14
G14_SPEC.loader.exec_module(g14)  # type: ignore[union-attr]
g13 = g14.g13
g6 = g14.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x46, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSF\r\n\x1a\n"
PROTOCOL = "render-stream/15"
MAGIC_V14 = g14.MAGIC
PROTOCOL_V14 = g14.PROTOCOL

parse_record = g13.parse_record
make_record = g13.make_record


def records(data: bytes, magic: bytes = MAGIC) -> list[bytes]:
    return g13.split_records(data, magic)


def restamp(data14: bytes) -> bytes:
    """A /14 file re-stamped /15: the magic, and the session's protocol (the first record)."""
    recs = records(data14, MAGIC_V14)
    meta_b, blocks = parse_record(recs[0])
    recs[0] = make_record(g13._swap_protocol(meta_b, PROTOCOL_V14, PROTOCOL), blocks)
    return MAGIC + b"".join(recs)


def stamp14(data15: bytes) -> bytes:
    """A /15 file stamped /14, every record as it is (the inverse of `restamp`)."""
    recs = records(data15)
    meta_b, blocks = parse_record(recs[0])
    recs[0] = make_record(g13._swap_protocol(meta_b, PROTOCOL, PROTOCOL_V14), blocks)
    return MAGIC_V14 + b"".join(recs)


def with_end(recs: list[bytes]) -> bytes:
    """recs (session first, end last) with the end record's bytes_total and max_record_bytes
    recomputed (hint records count in both, and in nothing else)."""
    meta_b, blocks = parse_record(recs[-1])
    meta = json.loads(meta_b)
    assert meta["type"] == "end"
    body = recs[:-1]
    meta["stats"]["bytes_total"] = len(MAGIC) + sum(len(r) for r in body)
    meta["stats"]["max_record_bytes"] = max(len(r) for r in body)
    return MAGIC + b"".join(body) + make_record(g6.canonical_json(meta), blocks)


def _meta(rec: bytes) -> dict:
    return json.loads(parse_record(rec)[0])


# --------------------------------------------------------------------------- records

CAUSES = ("create", "warm", "predicted", "integrator")
HINT_KEYS = ("type", "hash", "kind", "format", "source_format", "width", "height", "mipmaps",
             "payload_bytes", "variants", "path", "cause", "priority", "blocks")
SIZE_MAX = 16384


def hint_meta(entry: dict, *, path, cause: str, priority: int, variants=None) -> dict:
    """A resource_hint's meta for an ok image texture entry (its payload's shape; `variants` the
    entry's unless given)."""
    assert entry["kind"] == "image" and entry["status"] == "ok"
    return {"type": "resource_hint", "hash": entry["hash"], "kind": "texture",
            "format": entry["format"], "source_format": entry["source_format"],
            "width": entry["width"], "height": entry["height"], "mipmaps": entry["mipmaps"],
            "payload_bytes": entry["payload_bytes"],
            "variants": copy.deepcopy(entry["variants"] if variants is None else variants),
            "path": path, "cause": cause, "priority": priority, "blocks": []}


def hint_record(meta: dict, blocks: list[bytes] | None = None) -> bytes:
    return make_record(g6.canonical_json(meta), blocks or [])


def unhint_record(hash_hex: str) -> bytes:
    return make_record(g6.canonical_json({"type": "resource_unhint", "hash": hash_hex,
                                          "blocks": []}), [])


def _texture(recs: list[bytes], seq: int, tid: int) -> dict:
    """Texture tid's entry in the transaction seq carries (it must carry it)."""
    for rec in recs:
        m = _meta(rec)
        if m["type"] == "transaction" and m["seq"] == seq:
            (t,) = [t for t in m["textures"] if t["id"] == tid]
            return t
    raise AssertionError((seq, tid))


def _tx_pos(recs: list[bytes], seq: int) -> int:
    for i, rec in enumerate(recs):
        m = _meta(rec)
        if m["type"] == "transaction" and m["seq"] == seq:
            return i
    raise AssertionError(seq)


def _edit_tx_meta(rec: bytes, fn) -> bytes:
    """rec with fn(meta) applied to its (canonical) meta; blocks unchanged (a texture entry is
    meta only, so no predicted block moves)."""
    meta_b, blocks = parse_record(rec)
    meta = json.loads(meta_b)
    assert g6.canonical_json(meta) == meta_b, "transaction meta round-trips canonically"
    fn(meta)
    return make_record(g6.canonical_json(meta), blocks)


def with_override(entry: dict, size) -> dict:
    """entry with `size_override` right after `variants` (and the key order kept)."""
    out = {}
    for k, v in entry.items():
        out[k] = v
        if k == "variants":
            out["size_override"] = list(size)
    return out


OVERRIDE_ID = 11
OVERRIDE_FROM = 9
OVERRIDE = (15, 13)


def apply_override(recs: list[bytes], tid: int, size, from_seq: int, *, version_bump=True,
                   only_seq: int | None = None) -> list[bytes]:
    """Texture tid draws at `size` from transaction from_seq on: that transaction carries its entry
    (version + 1 when version_bump), and every later full carries the same entry."""
    out = list(recs)
    base = None
    for i, rec in enumerate(out):
        m = _meta(rec)
        if m["type"] != "transaction":
            continue
        if m["seq"] < from_seq:
            for t in m["textures"]:
                if t["id"] == tid:
                    base = t
            continue
        if only_seq is not None and m["seq"] != only_seq:
            continue
        assert base is not None, "the texture exists before the override"
        listed = [t for t in m["textures"] if t["id"] == tid]
        if m["seq"] != from_seq and not listed:
            continue
        if listed:
            assert m["seq"] == from_seq or m["encoding"] == "full", \
                "no patch after the override re-sends the texture"
            assert {k: v for k, v in listed[0].items() if k != "size_override"} == base
        entry = dict(base, version=base["version"] + (1 if version_bump else 0))
        entry = with_override(entry, size)

        def fn(meta, entry=entry):
            meta["textures"] = sorted([t for t in meta["textures"] if t["id"] != tid] + [entry],
                                      key=lambda t: t["id"])
        out[i] = _edit_tx_meta(rec, fn)
    return out


# Payload hashes of golden-14's patch lane.
H_A = "e65a0caf1a46175e39e501f3000016c9b56958648fda140874f93c9fcbd03fa9"  # textures 1, 2 (RGBA8)
H_B = "2caeb3ac168881aa04708631b7cc1427c452c1a0393d096451a9eef6841bc740"  # seq 3's texture 1
H_C = "010fa78f5252bba55d7f689e94974819078dbe444ca78233993e50f709184047"  # texture 5 (LA8)
H_E = "9ecc93d4dea0bb489a9801d18d92f58d1095d88cc976d50029c1a21fd195f48e"  # texture 8, never hinted
H_G = "4285398666ce2fb9864bf79a22850c62f303b11d44f2f2811c96f77aa86f5501"  # texture 11


def hint_plan(recs: list[bytes]) -> list[tuple[str, int, bytes]]:
    """(where, seq, record): each hint record goes right "before" or "after" transaction seq."""
    a = hint_meta(_texture(recs, 1, 1), path="res://textures/icon.png", cause="warm", priority=0)
    c = hint_meta(_texture(recs, 1, 5), path=None, cause="warm", priority=1)
    b = hint_meta(_texture(recs, 3, 1), path=None, cause="create", priority=2)
    g_entry = _texture(recs, 7, 11)
    assert [v["encoding"] for v in g_entry["variants"]] == ["block"]
    g = hint_meta(g_entry, path="res://textures/atlas.png", cause="create", priority=3)
    assert (a["hash"], b["hash"], c["hash"], g["hash"]) == (H_A, H_B, H_C, H_G)
    return [("before", 1, hint_record(a)), ("before", 1, hint_record(c)),
            ("before", 3, hint_record(b)), ("before", 7, hint_record(g)),
            ("after", 12, unhint_record(H_C))]


def insert(recs: list[bytes], plan) -> list[bytes]:
    """recs with each planned record placed (records planned at one place keep their order)."""
    out = list(recs)
    for where, seq, rec in plan:
        i = _tx_pos(out, seq)
        if where == "before":
            # after any record already placed before this transaction
            out.insert(i, rec)
        else:
            j = i + 1
            while j < len(out) and _meta(out[j])["type"] in ("resource_hint", "resource_unhint"):
                j += 1
            out.insert(j, rec)
    return out


def hints_stream(patch15: bytes) -> bytes:
    recs = records(patch15)
    recs = apply_override(recs, OVERRIDE_ID, OVERRIDE, OVERRIDE_FROM)
    recs = insert(recs, hint_plan(recs))
    return with_end(recs)


# --------------------------------------------------------------------------- reference checks

def hint_check(data: bytes, version: int = 15, ask_item_meta: bool = False):
    """The /15 hint and size_override rules (every other rule taken as golden-14's): the first
    failure as (code, record_index, seq), else None, and the hints in effect at the end."""
    recs = records(data, MAGIC if version >= 15 else MAGIC_V14)
    session = _meta(recs[0])
    res = session["resources"]
    hints: dict[str, dict] = {}
    fresh: list[str] = []
    state: dict[int, dict] = {}
    pending_im = False

    def fail(code, i, seq=None):
        return (code, i, seq), sorted(hints)

    for i, rec in enumerate(recs[1:], start=1):
        meta_b, blocks = parse_record(rec)
        m = json.loads(meta_b)
        kind = m.get("type")
        if kind in ("resource_hint", "resource_unhint"):
            if version < 15:
                return fail("meta-schema", i)
            if kind == "resource_hint":
                if list(m) != list(HINT_KEYS) or m["blocks"] != [] or blocks \
                        or m["cause"] not in CAUSES or m["kind"] != "texture":
                    return fail("meta-schema", i)
            elif list(m) != ["type", "hash", "blocks"] or m["blocks"] != []:
                return fail("meta-schema", i)
            if pending_im:
                return fail("item-meta-orphan", i)
            h = m["hash"]
            if kind == "resource_hint":
                if res["delivery"] == "inline" or m["payload_bytes"] <= res["inline_max_bytes"]:
                    return fail("hint-inline", i)
                if h in hints:
                    return fail("hint-duplicate", i)
                hints[h] = m
                fresh.append(h)
            else:
                if h not in hints:
                    return fail("hint-unknown", i)
                del hints[h]
                fresh = [x for x in fresh if x != h]
        elif kind == "item_meta":
            pending_im = True
        elif kind == "transaction":
            pending_im = False
            seq = m["seq"]
            if m["encoding"] == "full":
                state = {}
            for t in m["textures"]:
                if "size_override" in t:
                    so = t["size_override"]
                    if version < 15 or not (isinstance(so, list) and len(so) == 2 and all(
                            isinstance(x, int) and 1 <= x <= SIZE_MAX for x in so)):
                        return fail("meta-schema", i, seq)
                    if t["kind"] != "image" or t["status"] != "ok" or \
                            so == [t["width"], t["height"]]:
                        return fail("texture-entry", i, seq)
                state[t["id"]] = t
            for tid in m.get("removed_textures", []):
                state.pop(tid, None)
            ids = {t["id"] for t in m["textures"]} | {
                tid for tid, t in state.items() if t["hash"] in fresh}
            for tid in sorted(ids):
                t = state.get(tid)
                if t is None or t["kind"] != "image" or t["status"] != "ok" \
                        or t["hash"] not in hints:
                    continue
                hm = hints[t["hash"]]
                differs = any(t[k] != hm[k] for k in ("format", "source_format", "width",
                                                       "height", "mipmaps", "payload_bytes"))
                hv = {v["encoding"]: v for v in hm["variants"]}
                for v in t["variants"]:
                    w = hv.get(v["encoding"])
                    if w is not None and (w["hash"], w["payload_bytes"]) != (
                            v["hash"], v["payload_bytes"]):
                        differs = True
                if differs:
                    return fail("hint-meta", i, seq)
            fresh = []
    return None, sorted(hints)


def to14(data15: bytes) -> bytes:
    """`rs-core-check transcode --to 14` from /15 (render-stream-15.md "Tools"), the reference:
    both hint record types dropped, every `size_override` key removed, the end record's stats
    following (golden-13's `_fix_end`)."""
    assert hint_check(data15)[0] is None
    recs = records(data15)
    meta_b, blocks = parse_record(recs[0])
    out = [make_record(g13._swap_protocol(meta_b, PROTOCOL, PROTOCOL_V14), blocks)]
    seen = [recs[0]]
    for rec in recs[1:]:
        meta_b, blocks = parse_record(rec)
        meta = json.loads(meta_b)
        kind = meta.get("type")
        if kind in ("resource_hint", "resource_unhint"):
            pass
        elif kind == "transaction" and any("size_override" in t for t in meta["textures"]):
            def fn(m):
                m["textures"] = [{k: v for k, v in t.items() if k != "size_override"}
                                 for t in m["textures"]]
            out.append(_edit_tx_meta(rec, fn))
        elif kind == "end":
            out.append(make_record(g13._fix_end(meta_b, out, seen), blocks))
        else:
            out.append(rec)
        seen.append(rec)
    return MAGIC_V14 + b"".join(out)


# --------------------------------------------------------------------------- forms

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _rename(rel: str) -> str:
    return rel[:-5] + ".rs15" if rel.endswith(".rs14") else rel


def _decoded15(text: bytes, data15: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-14-decoded/1"
    d["schema"] = "render-stream-15-decoded/1"
    d["magic"] = MAGIC.hex()
    assert d["records"][0]["meta"]["protocol"] == PROTOCOL_V14
    d["records"][0]["meta"]["protocol"] = PROTOCOL
    for rec, r15 in zip(d["records"], records(data15)):
        assert rec["byte_length"] == len(r15)
        rec["sha256"] = _sha256(r15)
    return g6.pretty(d)


def _resolved15(text: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-14-resolved/1"
    d["schema"] = "render-stream-15-resolved/1"
    return g6.pretty(d)


def hints_decoded(patch_decoded15: bytes, patch15: bytes, hints15: bytes) -> bytes:
    """hints.rs15's decoded form: patch.rs15's (blocks are the reconstructed /12 values, which
    neither hints nor a texture entry move), each record's meta, offset, length and sha256 its
    hints.rs15 record's, a hint record's blocks []."""
    d = json.loads(patch_decoded15)
    by_sha = {}
    for rec, raw in zip(d["records"], records(patch15)):
        by_sha[_sha256(raw)] = rec
    plain = {}
    for rec, raw in zip(d["records"], records(patch15)):
        m = _meta(raw)
        if m["type"] == "transaction":
            plain[m["seq"]] = rec["blocks"]
    out = []
    offset = len(MAGIC)
    for raw in records(hints15):
        m = _meta(raw)
        if m["type"] == "transaction":
            blocks = plain[m["seq"]]
        elif m["type"] in ("resource_hint", "resource_unhint", "end"):
            blocks = []
        else:
            blocks = by_sha[_sha256(raw)]["blocks"]
        out.append({"offset": offset, "byte_length": len(raw), "sha256": _sha256(raw),
                    "meta": m, "blocks": blocks})
        offset += len(raw)
    d["records"] = out
    return g6.pretty(d)


def hints_resolved(resolved15: bytes, hints15: bytes) -> bytes:
    """hints.rs15's resolved form: golden-14's (every lane resolves to it) with texture 11 at
    version 2 and its size_override from seq 9 on."""
    d = json.loads(resolved15)
    entry = None
    for rec in records(hints15):
        m = _meta(rec)
        if m["type"] == "transaction" and m["seq"] == OVERRIDE_FROM:
            (entry,) = [t for t in m["textures"] if t["id"] == OVERRIDE_ID]
    for tx in d["transactions"]:
        if tx["seq"] < OVERRIDE_FROM:
            continue
        ts = tx["state"]["textures"]
        (k,) = [k for k, t in enumerate(ts) if t["id"] == OVERRIDE_ID]
        assert {key: v for key, v in entry.items() if key not in ("size_override", "version")} \
            == {key: v for key, v in ts[k].items() if key != "version"}
        ts[k] = entry
    return g6.pretty(d)


# --------------------------------------------------------------------------- invalid

def _replace(recs: list[bytes], i: int, rec: bytes) -> bytes:
    out = list(recs)
    out[i] = rec
    return with_end(out)


def _find(recs: list[bytes], pred) -> int:
    (i,) = [i for i, r in enumerate(recs) if pred(_meta(r))]
    return i


def build_invalid(outputs: dict[str, bytes], hints15: bytes, im_ask: dict):
    """name -> (bytes, code, description, ask, version, record_index, seq)."""
    recs = records(hints15)
    out = {}

    def is_hint(h):
        return lambda m: m["type"] == "resource_hint" and m["hash"] == h

    out["hint-at-14"] = (stamp14(hints15), "meta-schema",
                         "hints.rs15 stamped render-stream/14 (GRSE, protocol render-stream/14): "
                         "its first resource_hint is an unknown record type below /15",
                         None, 14, 1, None)
    i3 = _tx_pos(recs, 3)
    dup = hint_meta(_texture(recs, 1, 1), path=None, cause="create", priority=4)
    out["hint-duplicate"] = (with_end(recs[:i3] + [hint_record(dup)] + recs[i3:]),
                             "hint-duplicate",
                             "hints.rs15 with a second resource_hint of texture 1's payload (still "
                             "hinted since before seq 1) before seq 3", None, 15, i3, None)
    i5 = _tx_pos(recs, 5)
    out["hint-unknown"] = (with_end(recs[:i5] + [unhint_record(H_E)] + recs[i5:]),
                           "hint-unknown",
                           "hints.rs15 with a resource_unhint before seq 5 of texture 8's payload, "
                           "which was never hinted", None, 15, i5, None)
    inline = records(outputs["inline.rs15"])
    j1 = _tx_pos(inline, 1)
    a = hint_meta(_texture(recs, 1, 1), path=None, cause="create", priority=0)
    out["hint-inline"] = (with_end(inline[:j1] + [hint_record(a)] + inline[j1:]), "hint-inline",
                          "inline.rs15 (resources.delivery \"inline\") with a resource_hint of "
                          "texture 1's payload before seq 1", None, 15, j1, None)
    ib = _find(recs, is_hint(H_B))
    bad = dict(_meta(recs[ib]), width=15)
    out["hint-meta"] = (_replace(recs, ib, hint_record(bad)), "hint-meta",
                        "hints.rs15 whose hint of seq 3's texture 1 payload says width 15 (the "
                        "entry seq 3 resolves is 16 wide)", None, 15, _tx_pos(recs, 3), 3)
    ic = _find(recs, is_hint(H_C))
    blk = dict(_meta(recs[ic]), blocks=[{"name": "payload", "type": "u8", "count": 1}])
    out["hint-blocks"] = (_replace(recs, ic, hint_record(blk, [b"\x00"])), "meta-schema",
                          "hints.rs15 whose hint of texture 5's payload carries a one-byte u8 "
                          "block (blocks must be [])", None, 15, ic, None)
    ia = _find(recs, is_hint(H_A))
    cause = dict(_meta(recs[ia]), cause="game")
    out["hint-cause"] = (_replace(recs, ia, hint_record(cause)), "meta-schema",
                         "hints.rs15 whose first hint has cause \"game\"", None, 15, ia, None)
    im = records(outputs["item-meta.rs15"])
    k = [i for i, r in enumerate(im) if _meta(r)["type"] == "item_meta"][0]
    assert _meta(im[k + 1])["type"] == "transaction"
    out["hint-orphan"] = (with_end(im[:k + 1] + [hint_record(a)] + im[k + 1:]),
                          "item-meta-orphan",
                          "item-meta.rs15 with a resource_hint between its first item_meta record "
                          "and that record's transaction", im_ask, 15, k + 1, None)
    base = records(outputs["patch.rs15"])
    out["size-override-equal"] = (
        with_end(insert(apply_override(base, OVERRIDE_ID, (16, 16), OVERRIDE_FROM),
                        hint_plan(base))), "texture-entry",
        "hints.rs15 with texture 11's size_override [16, 16], its payload's size",
        None, 15, _tx_pos(recs, OVERRIDE_FROM), OVERRIDE_FROM)
    i1 = _tx_pos(recs, 1)

    def placeholder(meta):
        meta["textures"] = [with_override(t, (4, 4)) if t["kind"] == "placeholder" else t
                            for t in meta["textures"]]
    out["size-override-placeholder"] = (
        _replace(recs, i1, _edit_tx_meta(recs[i1], placeholder)), "texture-entry",
        "hints.rs15 whose seq 1 gives placeholder texture 4 a size_override [4, 4]",
        None, 15, i1, 1)
    out["size-override-range"] = (
        with_end(insert(apply_override(base, OVERRIDE_ID, (SIZE_MAX + 1, 13), OVERRIDE_FROM),
                        hint_plan(base))), "meta-schema",
        "hints.rs15 with texture 11's size_override [16385, 13], past 16384",
        None, 15, _tx_pos(recs, OVERRIDE_FROM), OVERRIDE_FROM)
    so = with_end(apply_override(base, OVERRIDE_ID, OVERRIDE, OVERRIDE_FROM))
    out["size-override-at-14"] = (
        stamp14(so), "meta-schema",
        "patch.rs15 with texture 11's size_override from seq 9 (no hints), stamped "
        "render-stream/14: the key is unknown below /15", None, 14,
        _tx_pos(records(so), OVERRIDE_FROM), OVERRIDE_FROM)
    for name, (data, code, _d, ask, version, at, seq) in out.items():
        got = hint_check(data, version)[0]
        assert got == (code, at, seq), (name, got)
    return out


# --------------------------------------------------------------------------- build

def build() -> dict[str, bytes]:
    out14 = g14.build()
    for rel, data in out14.items():
        assert (GOLDEN14 / rel).read_bytes() == data, f"golden-14 is stale: {rel}"
    i14 = json.loads(out14["index.json"])
    outputs: dict[str, bytes] = {}
    for rel, data in out14.items():
        if rel == "invalid/bad-magic.rs14":
            outputs["invalid/bad-magic.rs15"] = out14["full.rs14"]
        elif rel.endswith(".rs14"):
            outputs[_rename(rel)] = restamp(data)
    for lane in ("full", "patch", "inline", "predict"):
        d15 = outputs[f"{lane}.rs15"]
        outputs[f"{lane}.hex"] = g6.to_hex(d15).encode("ascii")
        outputs[f"{lane}.decoded.json"] = _decoded15(out14[f"{lane}.decoded.json"], d15)
    outputs["resolved.json"] = _resolved15(out14["resolved.json"])
    outputs["predict-resolved.json"] = _resolved15(out14["predict-resolved.json"])
    outputs["zero-runs.json"] = out14["zero-runs.json"]

    patch15 = outputs["patch.rs15"]
    hints15 = hints_stream(patch15)
    err, at_end = hint_check(hints15)
    assert err is None, err
    assert at_end == sorted([H_A, H_B, H_G]), at_end
    hints14 = to14(hints15)
    assert to14(patch15) == out14["patch.rs14"], "no hints, no override: /14 unchanged"
    outputs["hints.rs15"] = hints15
    outputs["hints.rs14"] = hints14
    outputs["hints.hex"] = g6.to_hex(hints15).encode("ascii")
    outputs["hints.decoded.json"] = hints_decoded(outputs["patch.decoded.json"], patch15, hints15)
    outputs["hints-resolved.json"] = hints_resolved(outputs["resolved.json"], hints15)

    im_ask = i14["item_meta_valid"][0]["item_meta"]
    bad = build_invalid(outputs, hints15, im_ask)
    for name, (data, _c, _d, _a, version, _at, _s) in bad.items():
        outputs[f"invalid/{name}.rs{version}"] = data

    def desc(text: str) -> str:
        return text.replace(".rs14", ".rs15")

    def ref13(rel: str) -> str:
        """A golden-14 path of a /13 file, as seen from golden-15."""
        return rel if rel.startswith("../") else f"../golden-14/{rel}"

    invalid = []
    for e in i14["invalid"]:
        if e["version"] == 13:
            e = dict(e, file=ref13(e["file"]))
        else:
            e = dict(e, file=_rename(e["file"]), version=15, description=desc(e["description"]))
        if e["file"] == "invalid/bad-magic.rs15":
            e["description"] = "golden-14's full.rs14: magic byte 3 is 'E' (GRSE), not 'F'"
        invalid.append(e)
    invalid += [
        {"file": f"invalid/{name}.rs{version}", "code": code, "version": version, "seq": seq,
         "record_index": at, **({"item_meta": ask} if ask is not None else {}),
         "description": description}
        for name, (_d, code, description, ask, version, at, seq) in bad.items()
    ]
    valid = [dict(e, file=_rename(e["file"]), sha256=_sha256(outputs[_rename(e["file"])]))
             for e in i14["valid"]]
    p = i14["predict"]
    predict = dict(p, file="predict.rs15", sha256=_sha256(outputs["predict.rs15"]))
    sabotage = {}
    for k, v in i14["sabotage"].items():
        v = dict(v)
        if "vector" in v:
            v["vector"] = _rename(v["vector"])
        if "fails" in v:
            v["fails"] = [dict(f, file=_rename(f["file"])) for f in v["fails"]]
        sabotage[k] = v
    item_meta_valid = []
    for e in i14["item_meta_valid"]:
        e = dict(e, file=_rename(e["file"]), description=desc(e["description"]))
        if "sha256" in e:
            e["sha256"] = _sha256(outputs[e["file"]])
        if "rs13" in e:
            e["rs13"] = ref13(e["rs13"])
        item_meta_valid.append(e)
    index = {
        "schema": "render-stream-15-golden-index/1",
        "protocol": PROTOCOL,
        "valid": valid,
        "resolved": "resolved.json",
        "predict": predict,
        "predict_trace": {_rename(k): v for k, v in i14["predict_trace"].items()},
        "zero_runs": i14["zero_runs"],
        "sabotage": sabotage,
        "corrupt": [dict(e, file=_rename(e["file"]), description=desc(e["description"]))
                    for e in i14["corrupt"]],
        "invalid": invalid,
        "item_meta_valid": item_meta_valid,
        "hints": {
            "file": "hints.rs15", "hex": "hints.hex", "decoded": "hints.decoded.json",
            "resolved": "hints-resolved.json", "sha256": _sha256(hints15), "rs14": "hints.rs14",
            "hints_at_end": at_end,
            "description": "patch.rs15 with hints: warm hints of texture 1's payload (with a "
                           "path) and texture 5's (without) before seq 1, a create hint of the "
                           "payload seq 3 first names before seq 3, a create hint with a path and "
                           "a block variant of texture 11's payload before seq 7 (which creates "
                           "it), an unhint of texture 5's payload after seq 12; texture 11 draws "
                           "at 15x13 from seq 9 (size_override, version 1 -> 2). rs14 is its "
                           "transcode --to 14",
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
        print(f"golden-15: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"golden-15: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
