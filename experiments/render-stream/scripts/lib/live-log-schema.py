#!/usr/bin/env python3
"""G7q window-1 identity, the live-log half: compares two runs' host live logs by shape.

  python3 live-log-schema.py <before run dir> <after run dir> [--json OUT]

Every `live-<n>.jsonl` under each run (found recursively) is keyed by its path relative to the run
(so the same leg's logs pair up) and reduced to its shape: for each line kind (an event line's
`event`, or `frame` for a frame line, with `sent` split into its own kind) the ordered key list
and each key's JSON type. Two window-1 runs of the same legs must have identical shapes: the
transcripts (capture/test/rs_live_window_test.cpp) pin the bytes of a deterministic hub, and this
pins that the real hosts' logs gained no field and lost none (no `in_flight_seqs`, `discarded` or
`credit_window` at window 1). Timing and counts differ between runs, so values are not compared.
Also reports, per log, the largest `in_flight` count implied by its frame lines.
"""
import json
import sys
from pathlib import Path


def jtype(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def shape(path):
    kinds = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            kinds.setdefault("<unparseable>", set()).add("")
            continue
        kind = obj.get("event") or "frame"
        sig = tuple((k, jtype(v)) for k, v in obj.items())
        kinds.setdefault(kind, set()).add(sig)
        sent = obj.get("sent")
        if isinstance(sent, dict):
            kinds.setdefault("frame.sent", set()).add(
                tuple((k, jtype(v)) for k, v in sent.items()))
    return kinds


def logs(root):
    out = {}
    for p in sorted(Path(root).rglob("live-*.jsonl")):
        out[str(p.relative_to(root))] = p
    return out


def main():
    before, after = sys.argv[1], sys.argv[2]
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    a, b = logs(before), logs(after)
    common = sorted(set(a) & set(b))
    problems = []
    # The union of shapes per kind over every paired log (a kind's optional keys, such as a
    # resync's, appear in some runs only, so per-log sets are compared as unions per kind).
    ua, ub = {}, {}
    for rel in common:
        for kinds, path, union in ((ua, a[rel], ua), (ub, b[rel], ub)):
            for kind, sigs in shape(path).items():
                union.setdefault(kind, set()).update(sigs)
    for kind in sorted(set(ua) | set(ub)):
        sa, sb = ua.get(kind, set()), ub.get(kind, set())
        keys_a = {k for sig in sa for k, _ in sig}
        keys_b = {k for sig in sb for k, _ in sig}
        if keys_a != keys_b:
            problems.append(
                f"{kind}: keys only before {sorted(keys_a - keys_b)}, only after {sorted(keys_b - keys_a)}")
        orders_a = {tuple(k for k, _ in sig) for sig in sa}
        orders_b = {tuple(k for k, _ in sig) for sig in sb}
        if orders_b - orders_a:
            problems.append(f"{kind}: key orders only after: {sorted(orders_b - orders_a)[:2]}")
    for forbidden in ("in_flight_seqs", "discarded"):
        if any(forbidden in {k for sig in sigs for k, _ in sig} for sigs in ub.values()):
            problems.append(f"after: a window-1 log carries `{forbidden}`")
    report = {
        "before": before,
        "after": after,
        "paired_logs": len(common),
        "only_before": sorted(set(a) - set(b)),
        "only_after": sorted(set(b) - set(a)),
        "kinds": sorted(set(ua) | set(ub)),
        "problems": problems,
        "ok": len(common) > 0 and not problems,
    }
    text = json.dumps(report, indent=2)
    if out_json:
        Path(out_json).write_text(text + "\n")
    print(text)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
