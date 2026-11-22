#!/usr/bin/env python3
"""Build /18 credit-window vectors from /16's viewport recording, deterministically."""
import argparse
import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "golden-16" / "viewports.rs16"


def recording(version, window, file=False):
    data = SOURCE.read_bytes()
    out = bytearray(b"GRS" + bytes([ord("A") + version - 10]) + b"\r\n\x1a\n")
    offset = 8
    maximum = 0
    while offset < len(data):
        size, meta_size = struct.unpack_from("<II", data, offset)
        meta = json.loads(data[offset + 8:offset + 8 + meta_size])
        blocks = data[offset + 8 + meta_size:offset + 4 + size]
        if meta["type"] == "session":
            meta["protocol"] = f"render-stream/{version}"
            meta["publication"]["credit_window"] = window
            if not file:
                meta["stream"]["transport"] = "websocket"
                meta["stream"]["connection"] = 1
            if version < 16:
                del meta["viewports"]
            # /7-/15 use their own session's schema; only /16 shares this session.
        if meta["type"] == "end":
            meta["stats"]["bytes_total"] = len(out)
            meta["stats"]["max_record_bytes"] = maximum
        encoded = json.dumps(meta, separators=(",", ":"), ensure_ascii=False).encode()
        maximum = max(maximum, 8 + len(encoded) + len(blocks))
        out.extend(struct.pack("<II", 4 + len(encoded) + len(blocks), len(encoded)))
        out.extend(encoded)
        out.extend(blocks)
        offset += 4 + size
    return bytes(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare without writing")
    args = parser.parse_args()
    vectors = {}
    index = {"schema": "render-stream-18-golden-index/1", "protocol": "render-stream/18",
             "valid": [], "invalid": []}
    for window in (1, 2, 4, 8):
        name = f"window{window}.rs18"
        data = recording(18, window)
        vectors[name] = data
        index["valid"].append({"file": name, "sha256": hashlib.sha256(data).hexdigest()})
    for window in (0, 9):
        name = f"invalid/window{window}.rs18"
        vectors[name] = recording(18, window)
        index["invalid"].append({"file": name, "version": 18, "code": "publication-entry"})
    name = "invalid/file-window8.rs18"
    vectors[name] = recording(18, 8, file=True)
    index["invalid"].append({"file": name, "version": 18, "code": "publication-entry"})
    # Keep the older directories immutable. Their own valid session is changed only in the window.
    for version in range(7, 18):
        source = HERE.parent / f"golden-{version}" / f"rate.rs{version}"
        if not source.exists():
            source = HERE.parent / f"golden-{version}" / f"full.rs{version}"
        if version == 17:
            source = HERE.parent / "golden-17" / "full.rs17"
        data = source.read_bytes()
        size, meta_size = struct.unpack_from("<II", data, 8)
        meta = json.loads(data[16:16 + meta_size])
        meta["publication"]["credit_window"] = 3
        encoded = json.dumps(meta, separators=(",", ":"), ensure_ascii=False).encode()
        blocks = data[16 + meta_size:12 + size]
        name = f"invalid/window3.rs{version}"
        vectors[name] = data[:8] + struct.pack("<II", 4 + len(encoded) + len(blocks), len(encoded)) + encoded + blocks
        index["invalid"].append({"file": name, "version": version, "code": "publication-entry"})
    spec = importlib.util.spec_from_file_location("golden17", HERE.parent / "golden-17/make_golden.py")
    g17 = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = g17
    spec.loader.exec_module(g17)
    name = "node-tween.rs18"
    vectors[name] = g17.node_recording(18)
    index["valid"].append({"file": name, "sha256": hashlib.sha256(vectors[name]).hexdigest()})
    for name, code, kwargs in [
        ("tween-without-grant", "meta-schema", {"grant": False}),
        ("material-begin", "meta-schema", {"material": True}),
        ("client-tweens-key-order", "meta-schema", {"bad": "client-tweens-key-order"}),
        ("missing-t-us", "tween-association", {"bad": "missing-t-us"}),
    ]:
        name = "invalid/" + name + ".rs18"
        vectors[name] = g17.node_recording(18, **kwargs)
        index["invalid"].append({"file": name, "version": 18, "code": code})
    vectors["index.json"] = (json.dumps(index, indent=2) + "\n").encode()
    for name, data in vectors.items():
        path = HERE / name
        if args.check:
            if not path.is_file() or path.read_bytes() != data:
                raise SystemExit(f"golden-18: stale or missing {name}")
        else:
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
    print(f"golden-18: {len(vectors)} files {'checked' if args.check else 'written'}")


if __name__ == "__main__":
    main()
