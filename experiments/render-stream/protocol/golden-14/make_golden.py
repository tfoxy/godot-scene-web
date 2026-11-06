#!/usr/bin/env python3
"""Generate the render-stream/14 golden vectors (stdlib only, deterministic).

render-stream/14 (../render-stream-14.md, ID3) is render-stream/13 plus item_meta v2: the GRSE
magic, the protocol string render-stream/14, two opt-in item_meta columns (`instance_id`, an
inline decimal string, and `mouse_filter`, an int in 0..6, each or null) and re-stamped rows (a
delta row for an id the receiver holds replaces the held row). Every other byte is /13's.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Outputs:

- Every golden-13 vector re-stamped /14 (`restamp`: the magic and the session's "protocol"; every
  record keeps its length, so every expectation is golden-13's): full / patch / inline / predict
  .rs14 with .hex and .decoded.json (render-stream-14-decoded/1, each record's sha256 its /14
  bytes'), resolved.json and predict-resolved.json (render-stream-14-resolved/1), corrupt-meta.rs14,
  invalid/*.rs14, item-meta.rs14, and zero-runs.json (golden-13's, unchanged). The /12 and /13
  twins are not copied: index.json names them under ../golden-12 and ../golden-13 (`rs12`, `rs13`).
  invalid/bad-magic.rs14 is golden-13's full.rs13 (GRSD, not GRSE).
- item-meta-v2.rs14: patch.rs14 with a v2 grant (class, scene, path, instance_id, mouse_filter,
  both groups and the meta key) and the request naming all six fields. A full before every full
  transaction, a delta before every patch that adds items, a re-stamp-only delta before patch
  seq 12 (item 7's mouse_filter 5 -> 4), and a delta before seq 17 that adds items 16 and 17 and
  re-stamps item 1 (1 -> 2). Sprite2D rows (no Control) have a null mouse_filter, items 7 and 5
  a `_has_point` value (5, 6), item 5 the 20-digit instance_id 18446744073709551615 and item 10 a
  null one; items 3 and 13 have no node. Later fulls carry the re-stamped values.
  item-meta-v2.rs13 is its /13 transcode (`to13`, the reference for `rs-core-check transcode
  --to 13`): the v2 columns and grant names dropped, the re-stamp-only delta dropped, item 1's
  re-stamped row dropped from the seq 17 delta.
- invalid/item-meta-v2-*.rs14: item-meta-v2.rs14 with one column broken (every one
  `item-meta-schema`), and invalid/item-meta-v2-grant-at-13.rs13: item-meta-v2.rs14 stamped /13,
  whose v2 grant names are unknown fields there (`item-meta-schema` at the first full).

The item_meta rules (`item_meta_check`) are golden-13's plus the v2 column types; validators
(rs-core `item_meta.rs` / `validate.rs`, scripts/lib/render-stream-2.ts) must agree with it on
every vector.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN13 = HERE.parent / "golden-13"
G13_SPEC = importlib.util.spec_from_file_location("golden13_make_golden",
                                                  GOLDEN13 / "make_golden.py")
g13 = importlib.util.module_from_spec(G13_SPEC)
sys.modules["golden13_make_golden"] = g13
G13_SPEC.loader.exec_module(g13)  # type: ignore[union-attr]
g6 = g13.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x45, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSE\r\n\x1a\n"
PROTOCOL = "render-stream/14"
MAGIC_V13 = g13.MAGIC
PROTOCOL_V13 = g13.PROTOCOL

parse_record = g13.parse_record
make_record = g13.make_record


def records(data: bytes, magic: bytes = MAGIC) -> list[bytes]:
    return g13.split_records(data, magic)


def restamp(data13: bytes) -> bytes:
    """A /13 file re-stamped /14: the magic, and the session's protocol (the first record)."""
    recs = records(data13, MAGIC_V13)
    meta_b, blocks = parse_record(recs[0])
    recs[0] = make_record(g13._swap_protocol(meta_b, PROTOCOL_V13, PROTOCOL), blocks)
    return MAGIC + b"".join(recs)


def stamp13(data14: bytes) -> bytes:
    """A /14 file stamped /13, every record as it is (the inverse of `restamp`)."""
    recs = records(data14)
    meta_b, blocks = parse_record(recs[0])
    recs[0] = make_record(g13._swap_protocol(meta_b, PROTOCOL, PROTOCOL_V13), blocks)
    return MAGIC_V13 + b"".join(recs)


def with_end(recs: list[bytes]) -> bytes:
    """recs (session first, end last) with the end record's stats recomputed (g13._with_end)."""
    meta_b, blocks = parse_record(recs[-1])
    meta = json.loads(meta_b)
    assert meta["type"] == "end"
    body = recs[:-1]
    meta["stats"]["bytes_total"] = len(MAGIC) + sum(len(r) for r in body)
    meta["stats"]["max_record_bytes"] = max(len(r) for r in body)
    return MAGIC + b"".join(body) + make_record(g6.canonical_json(meta), blocks)


# --------------------------------------------------------------------------- item_meta v2

V1_FIELDS = ("class", "script", "scene", "path")
FIELDS = V1_FIELDS + ("instance_id", "mouse_filter")
V2_FIELDS = ("instance_id", "mouse_filter")
INSTANCE_ID = re.compile(r"[1-9][0-9]{0,19}")
MAX_MOUSE_FILTER = 6

REQUEST_V2 = {"fields": list(FIELDS), "groups": ["rs_hand", "rs_ui"], "meta_keys": ["rs_tag"]}
# The host's grant: the request without `script` (as golden-13's).
GRANT_V2 = {"fields": ["class", "scene", "path", "instance_id", "mouse_filter"],
            "groups": ["rs_hand", "rs_ui"], "meta_keys": ["rs_tag"]}
# (seq, item, mouse_filter): from that seq's target state on, the item's filter is this value.
RESTAMPS = ((12, 7, 4), (17, 1, 2))
U64_MAX = "18446744073709551615"


def _instance_id(item: int) -> str | None:
    if item == 5:
        return U64_MAX
    if item == 10:
        return None
    return str(30000000000 + item * 1000003)


def _mouse_filter(item: int, seq: int) -> int | None:
    if item % 4 == 2:  # Sprite2D: not a Control
        return None
    value = (item % 3) | (4 if item in (5, 7) else 0)
    for at, it, v in RESTAMPS:
        if it == item and seq >= at:
            value = v
    return value


def _row_v2(item: int, seq: int, table: list[str], index: dict[str, int]) -> list:
    """item's wire row under GRANT_V2 at seq's target state (golden-13's `_row` plus the two v2
    columns after `path`)."""
    row = g13._row(item, table, index)
    if len(row) == 1:
        return row
    # g13 row: [id, class, scene, path, groups, tag]
    return row[:4] + [_instance_id(item), _mouse_filter(item, seq)] + row[4:]


def item_meta_v2_stream(patch14: bytes) -> tuple[bytes, dict]:
    """item-meta-v2.rs14 and its expected dump."""
    recs = records(patch14)
    out = [recs[0]]
    table: list[str] = []
    index: dict[str, int] = {}
    items: set[int] = set()
    fulls = deltas = 0
    for rec in recs[1:]:
        meta = json.loads(parse_record(rec)[0])
        if meta.get("type") == "transaction":
            seq = meta["seq"]
            after = g13._tx_items(meta, items)
            if meta["encoding"] == "full":
                table, index = [], {}
                rows = [_row_v2(i, seq, table, index) for i in sorted(after)]
                out.append(g13.item_meta_record("full", GRANT_V2, 0, list(table), rows))
                fulls += 1
            else:
                restamped = {it for at, it, _v in RESTAMPS if at == seq and it in items}
                new = sorted((after - items) | restamped)
                if new:
                    start = len(table)
                    rows = [_row_v2(i, seq, table, index) for i in new]
                    out.append(g13.item_meta_record("delta", None, start, table[start:], rows))
                    deltas += 1
            items = after
        out.append(rec)
    data = with_end(out)
    dump = item_meta_check(data, REQUEST_V2)
    assert dump["error"] is None, dump["error"]
    assert dump["full_records"] == fulls and dump["delta_records"] == deltas
    del dump["error"]
    return data, dump


def _resolve_row(row: list, grant: dict, table: list[str]):
    """A dump row (rs-core-check --item-meta-dump): null for no node, else {field: value, ...,
    "groups": mask, "meta": {key: string|null}}; instance_id and mouse_filter as they are."""
    if len(row) == 1:
        return None
    cols = row[1:]
    out: dict = {}
    k = 0
    for f in grant["fields"]:
        if f in V2_FIELDS:
            out[f] = cols[k]
        else:
            out[f] = None if cols[k] is None else table[cols[k]]
        k += 1
    if grant["groups"]:
        out["groups"] = cols[k]
        k += 1
    if grant["meta_keys"]:
        out["meta"] = {key: (None if cols[k + j] is None else table[cols[k + j]])
                       for j, key in enumerate(grant["meta_keys"])}
    return out


def _grant_error(g, version: int) -> str | None:
    if not isinstance(g, dict) or list(g.keys()) != ["fields", "groups", "meta_keys"]:
        return "grant keys"
    known = FIELDS if version >= 14 else V1_FIELDS
    for key, cap in (("fields", len(known)), ("groups", 31), ("meta_keys", 8)):
        v = g[key]
        if not isinstance(v, list) or len(v) > cap or len(set(map(str, v))) != len(v):
            return key
        for s in v:
            if not isinstance(s, str) or not 1 <= len(s) <= 64 or \
                    any(not 0x20 <= ord(c) <= 0x7E for c in s):
                return key
    if [f for f in known if f in g["fields"]] != g["fields"]:
        return "fields order"
    if not (g["fields"] or g["groups"] or g["meta_keys"]):
        return "empty grant"
    return None


def _is_uint(c) -> bool:
    return isinstance(c, int) and not isinstance(c, bool) and c >= 0


def _row_error(r: list, g: dict, version: int) -> bool:
    """A node row's columns against the grant (count and types): True when item-meta-schema."""
    nf = len(g["fields"])
    ncols = nf + (1 if g["groups"] else 0) + len(g["meta_keys"])
    cols = r[1:]
    for c in cols:
        if not (c is None or _is_uint(c) or (version >= 14 and isinstance(c, str))):
            return True  # the record-local column parse
    if len(cols) != ncols:
        return True
    for k, c in enumerate(cols):
        f = g["fields"][k] if k < nf else None
        if g["groups"] and k == nf:
            if not (_is_uint(c) and c < 2 ** len(g["groups"])):
                return True
        elif f == "instance_id":
            if not (c is None or (isinstance(c, str) and INSTANCE_ID.fullmatch(c))):
                return True
        elif f == "mouse_filter":
            if not (c is None or (_is_uint(c) and c <= MAX_MOUSE_FILTER)):
                return True
        elif isinstance(c, str):
            return True
    return False


def item_meta_check(data: bytes, ask, version: int = 14) -> dict:
    """golden-13's `item_meta_check` (the reference item_meta rules; every other record taken as
    valid) at /13 or /14: a v2 name in a grant below /14 is item-meta-schema; at /14 the
    instance_id and mouse_filter columns are type-checked, and a delta row for a held id replaces
    the held row (as /13 already does)."""
    recs = records(data, MAGIC if version >= 14 else MAGIC_V13)
    grant = None
    table: list[str] = []
    rows: dict[int, list] = {}
    seen: dict[int, object] = {}
    pending = None
    items: set[int] = set()
    counts = [0, 0]

    def fail(code: str, i: int) -> dict:
        return {"error": (code, i)}

    for i, rec in enumerate(recs[1:], start=1):
        meta = json.loads(parse_record(rec)[0])
        kind = meta.get("type")
        if kind == "item_meta":
            if ask == "none":
                return fail("item-meta-unexpected", i)
            if pending is not None:
                return fail("item-meta-orphan", i)
            full = meta["form"] == "full"
            g = meta["grant"] if full else grant
            if full and _grant_error(g, version) is not None:
                return fail("item-meta-schema", i)
            if full and isinstance(ask, dict) and not (
                    set(g["fields"]) <= set(ask["fields"])
                    and g["groups"] in ([], ask["groups"])
                    and g["meta_keys"] in ([], ask["meta_keys"])):
                return fail("item-meta-schema", i)
            ids = [r[0] for r in meta["items"]]
            if ids != sorted(set(ids)) or any(not 1 <= x < 2 ** 32 for x in ids):
                return fail("item-meta-schema", i)
            if any(len(r) > 1 and any(not (c is None or _is_uint(c) or
                                           (version >= 14 and isinstance(c, str)))
                                      for c in r[1:]) for r in meta["items"]):
                return fail("item-meta-schema", i)
            if g is None:
                return fail("item-meta-form", i)
            if any(len(r) > 1 and _row_error(r, g, version) for r in meta["items"]):
                return fail("item-meta-schema", i)
            size = 0 if full else len(table)
            if meta["strings_from"] != size:
                return fail("item-meta-string", i)
            size += len(meta["strings"])
            nf = len(g["fields"])
            for r in meta["items"]:
                for k, c in enumerate(r[1:]):
                    if g["groups"] and k == nf:
                        continue
                    if k < nf and g["fields"][k] in V2_FIELDS:
                        continue
                    if c is not None and not 0 <= c < size:
                        return fail("item-meta-string", i)
            pending = meta
        elif kind == "transaction":
            full = meta["encoding"] == "full"
            if pending is not None and (pending["form"] == "full") != full:
                return fail("item-meta-form", i)
            if pending is None and full and grant is not None:
                return fail("item-meta-missing", i)
            after = g13._tx_items(meta, items)
            if pending is not None:
                if any(r[0] not in after for r in pending["items"]):
                    return fail("item-meta-id", i)
                if full:
                    grant, table, rows = pending["grant"], list(pending["strings"]), {}
                    counts[0] += 1
                else:
                    table += pending["strings"]
                    counts[1] += 1
                for r in pending["items"]:
                    rows[r[0]] = r
                    seen[r[0]] = _resolve_row(r, grant, table)
                pending = None
            rows = {k: v for k, v in rows.items() if k in after}
            items = after
        elif pending is not None:
            return fail("item-meta-orphan", i)
    return {
        "error": None,
        "grant": grant,
        "strings": table,
        "rows": {str(k): _resolve_row(rows[k], grant, table) for k in sorted(rows)},
        "seen": {str(k): seen[k] for k in sorted(seen)},
        "full_records": counts[0],
        "delta_records": counts[1],
    }


def to13(data14: bytes) -> bytes:
    """`rs-core-check transcode --to 13` from /14 (render-stream-14.md "Tools"), the reference:
    the v2 columns and grant names dropped; a full whose grant is left empty dropped with the
    deltas after it; a re-stamped row equal to the held row after the drop dropped; a delta left
    with no rows and no strings dropped; the end record's stats follow (golden-13's `_fix_end`)."""
    assert item_meta_check(data14, None)["error"] is None
    recs = records(data14)
    meta_b, blocks = parse_record(recs[0])
    out = [make_record(g13._swap_protocol(meta_b, PROTOCOL, PROTOCOL_V13), blocks)]
    seen = [recs[0]]
    grant = None
    keep: list[int] = []
    dropping = False
    held: dict[int, list] = {}  # projected rows of the current state
    pending: dict | None = None
    items: set[int] = set()

    def project(r: list) -> list:
        return r if len(r) == 1 else [r[0]] + [r[1 + k] for k in keep]

    for rec in recs[1:]:
        meta_b, blocks = parse_record(rec)
        meta = json.loads(meta_b)
        kind = meta.get("type")
        if kind == "item_meta":
            full = meta["form"] == "full"
            if full:
                grant = meta["grant"]
                n = len(grant["fields"]) + (1 if grant["groups"] else 0) + len(grant["meta_keys"])
                keep = [k for k in range(n)
                        if k >= len(grant["fields"]) or grant["fields"][k] not in V2_FIELDS]
                g13_grant = dict(grant, fields=[f for f in grant["fields"] if f not in V2_FIELDS])
                dropping = not keep
            rows = [project(r) for r in meta["items"]]
            pending = {"full": full, "rows": rows}
            if not full:
                rows = [r for r in rows if held.get(r[0]) != r]
            if dropping or (not full and not rows and not meta["strings"]):
                pass
            else:
                m = dict(meta, grant=g13_grant if full else None, items=rows)
                out.append(make_record(g6.canonical_json(m), blocks))
        elif kind == "transaction":
            after = g13._tx_items(meta, items)
            if pending is not None:
                if pending["full"]:
                    held = {}
                for r in pending["rows"]:
                    held[r[0]] = r
                pending = None
            held = {k: v for k, v in held.items() if k in after}
            items = after
            out.append(rec)
        elif kind == "end":
            out.append(make_record(g13._fix_end(meta_b, out, seen), blocks))
        else:
            out.append(rec)
        seen.append(rec)
    return MAGIC_V13 + b"".join(out)


def _im_meta(data: bytes, i: int) -> dict:
    return json.loads(parse_record(records(data)[i])[0])


def _im_index(data: bytes, before_seq: int) -> int:
    recs = records(data)
    i = g13._tx_index(recs, before_seq) - 1
    assert json.loads(parse_record(recs[i])[0])["type"] == "item_meta"
    return i


def _edit_row(data: bytes, before_seq: int, item: int, fn) -> tuple[bytes, int]:
    """data with fn(row) as item's row in the item_meta record before transaction before_seq;
    returns (file, record index)."""
    i = _im_index(data, before_seq)
    m = _im_meta(data, i)
    assert any(r[0] == item for r in m["items"]), (before_seq, item)
    m["items"] = [fn(list(r)) if r[0] == item else r for r in m["items"]]
    recs = records(data)
    recs[i] = make_record(g6.canonical_json(m), [])
    return with_end(recs), i


def _set(k: int, v):
    def fn(r: list) -> list:
        r[k] = v
        return r
    return fn


# Row columns under GRANT_V2: 1 class, 2 scene, 3 path, 4 instance_id, 5 mouse_filter, 6 groups,
# 7 rs_tag.
IID, MF = 4, 5


def build_v2_vectors(stream: bytes) -> dict[str, tuple[bytes, str, str, object, int, int]]:
    """name -> (bytes, code, description, ask, version, record_index)."""
    cases = [
        ("item-meta-v2-instance-id-number", 1, 1, _set(IID, 30000001000003),
         "item 1's instance_id in the first full is a JSON number, not a string"),
        ("item-meta-v2-instance-id-zero", 4, 6, _set(IID, "0"),
         "item 6's instance_id in the delta before seq 4 is \"0\""),
        ("item-meta-v2-instance-id-leading-zero", 1, 1, _set(IID, "030000001000003"),
         "item 1's instance_id in the first full has a leading zero"),
        ("item-meta-v2-instance-id-long", 1, 2, _set(IID, "100000000000000000000"),
         "item 2's instance_id in the first full has 21 digits"),
        ("item-meta-v2-instance-id-empty", 5, 4, _set(IID, ""),
         "item 4's instance_id in the full before seq 5 is the empty string"),
        ("item-meta-v2-mouse-filter-7", 12, 7, _set(MF, 7),
         "item 7's re-stamped mouse_filter in the delta before seq 12 is 7, past 0..6"),
        ("item-meta-v2-mouse-filter-string", 1, 1, _set(MF, "1"),
         "item 1's mouse_filter in the first full is the string \"1\""),
        ("item-meta-v2-mouse-filter-missing", 1, 4, lambda r: r[:MF] + r[MF + 1:],
         "item 4's row in the first full lacks its mouse_filter column (six columns, the grant "
         "seven)"),
        ("item-meta-v2-string-column", 4, 7, _set(1, "TextureRect"),
         "item 7's class in the delta before seq 4 is an inline string, not a string index"),
    ]
    out = {}
    for name, seq, item, fn, desc in cases:
        data, i = _edit_row(stream, seq, item, fn)
        out[name] = (data, "item-meta-schema", f"item-meta-v2.rs14 with {desc}", REQUEST_V2, 14,
                     i)
    out["item-meta-v2-grant-at-13"] = (
        stamp13(stream), "item-meta-schema",
        "item-meta-v2.rs14 stamped render-stream/13 (GRSD, protocol render-stream/13): the first "
        "full's grant names instance_id and mouse_filter, unknown fields below /14", None, 13, 1)
    for name, (data, code, _d, ask, version, at) in out.items():
        got = item_meta_check(data, ask, version)["error"]
        assert got == (code, at), (name, got)
    return out


# --------------------------------------------------------------------------- build

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _rename(rel: str) -> str:
    return rel[:-5] + ".rs14" if rel.endswith(".rs13") else rel


def _decoded14(text: bytes, data14: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-13-decoded/1"
    d["schema"] = "render-stream-14-decoded/1"
    d["magic"] = MAGIC.hex()
    assert d["records"][0]["meta"]["protocol"] == PROTOCOL_V13
    d["records"][0]["meta"]["protocol"] = PROTOCOL
    for rec, r14 in zip(d["records"], records(data14)):
        assert rec["byte_length"] == len(r14)
        rec["sha256"] = _sha256(r14)
    return g6.pretty(d)


def _resolved14(text: bytes) -> bytes:
    d = json.loads(text)
    assert d["schema"] == "render-stream-13-resolved/1"
    d["schema"] = "render-stream-14-resolved/1"
    return g6.pretty(d)


def build() -> dict[str, bytes]:
    out13 = g13.build()
    for rel, data in out13.items():
        assert (GOLDEN13 / rel).read_bytes() == data, f"golden-13 is stale: {rel}"
    i13 = json.loads(out13["index.json"])
    outputs: dict[str, bytes] = {}
    for rel, data in out13.items():
        if rel == "invalid/bad-magic.rs13":
            outputs["invalid/bad-magic.rs14"] = out13["full.rs13"]
        elif rel.endswith(".rs13"):
            outputs[_rename(rel)] = restamp(data)
    for lane in ("full", "patch", "inline", "predict"):
        d14 = outputs[f"{lane}.rs14"]
        outputs[f"{lane}.hex"] = g6.to_hex(d14).encode("ascii")
        outputs[f"{lane}.decoded.json"] = _decoded14(out13[f"{lane}.decoded.json"], d14)
    outputs["resolved.json"] = _resolved14(out13["resolved.json"])
    outputs["predict-resolved.json"] = _resolved14(out13["predict-resolved.json"])
    outputs["zero-runs.json"] = out13["zero-runs.json"]

    patch14 = outputs["patch.rs14"]
    v2, v2_dump = item_meta_v2_stream(patch14)
    v2_13 = to13(v2)
    assert g13.to12(v2_13) == (HERE.parent / "golden-12" / "patch.rs12").read_bytes()
    assert g13.item_meta_check(v2_13, None)["error"] is None
    assert to13(outputs["item-meta.rs14"]) == out13["item-meta.rs13"], "v1 grant: /13 unchanged"
    assert item_meta_check(patch14, REQUEST_V2)["error"] is None  # item-meta-v2-refused
    v2_invalid = build_v2_vectors(v2)
    outputs["item-meta-v2.rs14"] = v2
    outputs["item-meta-v2.rs13"] = v2_13
    for name, (data, _c, _d, _a, version, _at) in v2_invalid.items():
        outputs[f"invalid/{name}.rs{version}"] = data

    def desc(text: str) -> str:
        return text.replace(".rs13", ".rs14")

    invalid = []
    for e in i13["invalid"]:
        e = dict(e, file=_rename(e["file"]), version=14, description=desc(e["description"]))
        if e["file"] == "invalid/bad-magic.rs14":
            e["description"] = "golden-13's full.rs13: magic byte 3 is 'D' (GRSD), not 'E'"
        invalid.append(e)
    invalid += [
        {"file": f"invalid/{name}.rs{version}", "code": code, "version": version, "seq": None,
         "record_index": at, **({"item_meta": ask} if ask is not None else {}),
         "description": description}
        for name, (_d, code, description, ask, version, at) in v2_invalid.items()
    ]
    valid = [dict(e, file=_rename(e["file"]), sha256=_sha256(outputs[_rename(e["file"])]),
                  rs13=f"../golden-13/{e['file']}") for e in i13["valid"]]
    p = i13["predict"]
    predict = dict(p, file="predict.rs14", sha256=_sha256(outputs["predict.rs14"]),
                   rs12="../golden-13/predict.rs12", rs13="../golden-13/predict.rs13")
    sabotage = {}
    for k, v in i13["sabotage"].items():
        v = dict(v)
        if "vector" in v:
            v["vector"] = _rename(v["vector"])
        if "fails" in v:
            v["fails"] = [dict(f, file=_rename(f["file"])) for f in v["fails"]]
        sabotage[k] = v
    item_meta_valid = []
    for e in i13["item_meta_valid"]:
        e = dict(e, file=_rename(e["file"]), description=desc(e["description"]))
        if "sha256" in e:
            e["sha256"] = _sha256(outputs[e["file"]])
            e["rs13"] = "../golden-13/item-meta.rs13"
        item_meta_valid.append(e)
    item_meta_valid += [
        {"name": "item-meta-v2", "file": "item-meta-v2.rs14", "item_meta": REQUEST_V2,
         "sha256": _sha256(v2), "rs12": "../golden-12/patch.rs12", "rs13": "item-meta-v2.rs13",
         "dump": v2_dump,
         "description": "patch.rs14 with a v2 grant (class, scene, path, instance_id, "
                        "mouse_filter, groups, rs_tag): a full before each full transaction, a "
                        "delta before each patch that adds items, a re-stamp-only delta before "
                        "seq 12 (item 7's mouse_filter 5 -> 4) and a delta before seq 17 adding "
                        "items 16, 17 and re-stamping item 1 (1 -> 2); null mouse_filter for "
                        "Sprite2D rows, _has_point values 5 and 6, a 20-digit and a null "
                        "instance_id. rs13 is its transcode --to 13"},
        {"name": "item-meta-v2-refused", "file": "patch.rs14", "item_meta": REQUEST_V2,
         "description": "a viewer asked for v2 fields and the host granted nothing: no "
                        "item_meta record at all is valid"},
    ]
    index = {
        "schema": "render-stream-14-golden-index/1",
        "protocol": PROTOCOL,
        "valid": valid,
        "resolved": "resolved.json",
        "predict": predict,
        "predict_trace": {_rename(k): v for k, v in i13["predict_trace"].items()},
        "zero_runs": i13["zero_runs"],
        "sabotage": sabotage,
        "corrupt": [dict(e, file=_rename(e["file"]), description=desc(e["description"]))
                    for e in i13["corrupt"]],
        "invalid": invalid,
        "item_meta_valid": item_meta_valid,
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
        print(f"golden-14: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"golden-14: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
