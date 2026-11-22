#!/usr/bin/env python3
"""Deterministic /17 restamps and announced-tween records (no engine required)."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("golden16", HERE.parent / "golden-16/make_golden.py")
g16 = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = g16
spec.loader.exec_module(g16)
MAGIC = b"GRSH\r\n\x1a\n"


def record(meta, floats=()):
    blocks = [struct.pack("<" + "f" * len(floats), *floats)] if floats else []
    return g16.make_record(json.dumps(meta, separators=(",", ":")).encode(), blocks)


def tween_meta():
    return {
        "type": "tween", "seq": 1, "frame": 10, "t_us": 102000,
        "events": [{"op": "begin", "tween_id": "-9223372036854775808", "item": 7,
                    "order": 1, "begin_us": 1000, "end_us": 1001000,
                    "steps": [{"property": "position", "start_us": 0, "duration_us": 1000000,
                               "trans": 0, "ease": 2, "from": None, "to": 0}]}],
        "poses": [{"item": 7, "kind": "node2d", "f": 2}],
        "blocks": [{"name": "tween_f32", "type": "f32", "count": 18}],
    }


def node_recording(version=17, *, grant=True, material=False, bad=None):
    """One granted picture, or one grammar mutation, built without newer generators."""
    source = g16.records((HERE.parent / "golden-16/viewports.rs16").read_bytes())
    session_bytes, session_blocks = g16.parse_record(source[0])
    session = json.loads(session_bytes)
    session["protocol"] = f"render-stream/{version}"
    session["publication"]["credit_window"] = 1
    session["stream"]["transport"] = "websocket"
    session["stream"]["connection"] = 1
    if grant:
        session = {k: v for k, v in session.items() if k != "blocks"} | {
            "client_tweens": True, "blocks": session["blocks"]}
    if bad == "client-tweens-key-order":
        session = {k: v for k, v in session.items() if k not in ("viewports", "blocks")} | {
            "viewports": session["viewports"], "blocks": session["blocks"]}
    tx_bytes, tx_blocks = g16.parse_record(source[1])
    tx = json.loads(tx_bytes)
    if grant and bad != "missing-t-us":
        tx = dict(list(tx.items())[:3] + [("t_us", 0)] + list(tx.items())[3:])
    meta = tween_meta()
    meta["frame"] = 1
    meta["t_us"] = 0
    event = meta["events"][0]
    event["item"] = meta["poses"][0]["item"] = 1
    event["begin_us"] = 0
    event["end_us"] = 1000000
    values = [100, 200, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]
    if material:
        meta["events"] = [{"op": "begin", "tween_id": "7001", "material": 1,
                           "order": 1, "begin_us": 0, "end_us": 1000000,
                           "steps": [{"param": "threshold", "type": "float", "component": None,
                                      "start_us": 0, "duration_us": 1000000, "trans": 0,
                                      "ease": 2, "from": 0, "to": 1}]}]
        meta["poses"] = []
        meta["blocks"][0]["count"] = 2
        values = [1, 0]
    pack = lambda m, blocks: g16.make_record(json.dumps(m, separators=(",", ":")).encode(), blocks)
    body = [pack(session, session_blocks)]
    # A grant requires timestamps even in pictures with no active tween.
    if bad != "missing-t-us":
        body.append(record(meta, values))
    body.append(pack(tx, tx_blocks))
    magic = b"GRS" + bytes([ord("A") + version - 10]) + b"\r\n\x1a\n"
    return magic + b"".join(body) + g16.end_record(body, 1, 1)


def build(*, include_associated=True):
    outputs = {}
    index = {"schema": "render-stream-17-golden-index/1", "protocol": "render-stream/17",
             "valid": [], "invalid": []}
    # Opted-out transaction/resource records are retained byte for byte, including prediction.
    for source in sorted((HERE.parent / "golden-16").glob("*.rs16")):
        if source.name.startswith("corrupt-"):
            continue
        data = g16._retag(source.read_bytes(), g16.MAGIC, MAGIC,
                         lambda m: g16.g13._swap_protocol(m, "render-stream/16", "render-stream/17"))
        name = source.stem + ".rs17"
        outputs[name] = data
        outputs[source.stem + ".hex"] = (data.hex() + "\n").encode()
        index["valid"].append({"file": name, "hex": source.stem + ".hex",
                               "sha256": hashlib.sha256(data).hexdigest(),
                               "rs16": "../golden-16/" + source.name})
    floats = [100, 200, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1]
    begin = tween_meta()
    vectors = {"begin": (begin, floats)}
    cancel = {"type": "tween", "seq": 2, "frame": 11, "t_us": 103000,
              "events": [{"op": "cancel", "tween_id": "-9223372036854775808"}],
              "poses": [], "blocks": []}
    vectors["cancel-removed"] = (cancel, [])
    poses = copy.deepcopy(begin)
    poses["seq"] = 2
    poses["frame"] = 11
    poses["t_us"] = 103000
    poses["events"] = []
    poses["poses"][0]["f"] = 0
    poses["blocks"][0]["count"] = 16
    vectors["poses"] = (poses, floats[2:])
    for name, (meta, values) in vectors.items():
        data = record(meta, values)
        outputs[name + ".record"] = data
        outputs[name + ".hex"] = (data.hex() + "\n").encode()
        decoded = {"meta": meta, "tween_f32": values}
        outputs[name + ".decoded.json"] = (json.dumps(decoded, indent=2) + "\n").encode()
        index["valid"].append({"file": name + ".record", "hex": name + ".hex",
                               "decoded": name + ".decoded.json",
                               "sha256": hashlib.sha256(data).hexdigest(), "record_only": True})
    # Record-only invalid vectors specify the associated-picture assumptions explicitly.
    mutations = [
        ("unknown-key", "meta-schema", lambda m: m.update(extra=1)),
        ("unknown-property", "meta-schema", lambda m: m["events"][0]["steps"][0].update(property="global_position")),
        ("bad-id", "meta-schema", lambda m: m["events"][0].update(tween_id="-0")),
        ("bad-easing", "meta-schema", lambda m: m["events"][0]["steps"][0].update(ease=4)),
        ("wrong-offset", "tween-offset", lambda m: m["events"][0]["steps"][0].update(to=1)),
        ("wrong-count", "tween-offset", lambda m: m["blocks"][0].update(count=19)),
        ("empty-steps", "tween-entry", lambda m: m["events"][0].update(steps=[])),
        ("wrong-end", "tween-entry", lambda m: m["events"][0].update(end_us=1001001)),
        ("missing-pose", "tween-entry", lambda m: m.update(poses=[])),
        ("future-start", "tween-time", lambda m: m["events"][0].update(begin_us=102001, end_us=1102001)),
        ("mismatch-frame", "tween-association", lambda m: m.update(frame=9)),
    ]
    for name, error, mutate in mutations:
        meta = copy.deepcopy(begin)
        mutate(meta)
        name = "invalid/" + name + ".record"
        values = floats
        if name.endswith("empty-steps.record"):
            values = floats[2:]
            meta["poses"][0]["f"] = 0
            meta["blocks"][0]["count"] = 16
        if name.endswith("missing-pose.record"):
            values = floats[:2]
            meta["blocks"][0]["count"] = 2
        outputs[name] = record(meta, values)
        index["invalid"].append({"file": name, "error": error, "record_only": True,
                                 "association": {"seq": 1, "frame": 10, "t_us": 102000},
                                 "grant": True, "items": [7]})
    if include_associated:
        name = "node-tween.rs17"
        outputs[name] = node_recording()
        index["valid"].append({"file": name, "sha256": hashlib.sha256(outputs[name]).hexdigest()})
        for name, error, kwargs in [
            ("tween-without-grant", "meta-schema", {"grant": False}),
            ("material-begin", "meta-schema", {"material": True}),
            ("client-tweens-key-order", "meta-schema", {"bad": "client-tweens-key-order"}),
            ("missing-t-us", "tween-association", {"bad": "missing-t-us"}),
        ]:
            name = "invalid/" + name + ".rs17"
            outputs[name] = node_recording(**kwargs)
            index["invalid"].append({"file": name, "error": error})
    outputs["index.json"] = (json.dumps(index, indent=2) + "\n").encode()
    return outputs


def main():
    outputs = build()
    if "--check" in sys.argv:
        wrong = [name for name, data in outputs.items()
                 if not (HERE / name).exists() or (HERE / name).read_bytes() != data]
        if wrong:
            print("stale /17 vectors: " + ", ".join(wrong), file=sys.stderr)
            return 1
        print(f"golden-17: {len(outputs)} files match")
        return 0
    for name, data in outputs.items():
        path = HERE / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"golden-17: wrote {len(outputs)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
