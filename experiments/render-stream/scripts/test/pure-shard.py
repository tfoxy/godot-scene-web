#!/usr/bin/env python3
"""pure-shard.py SHARD WEIGHTS.json NAME... -- print the units of shard SHARD ("i/n"), one per line.

WEIGHTS.json: {"weights": {test: seconds}, "parts": {test: p}}. A unit is a whole test, or, for a test
listed in "parts", one of its p parts "test@KofP" (the test's own scenario sharding, RS_SELF_TEST_SHARD=K/P,
which run-pure-self-tests.sh sets). A part weighs seconds/p plus PART_SETUP_S (each part rebuilds the
test's fixtures). Longest-processing-time-first: units sorted by (-weight, name) are each dealt to the
shard with the least total so far (lowest index on a tie). Deterministic, and the n shards partition the
units. A name absent from "weights" gets DEFAULT_S seconds.
"""
import json
import sys

DEFAULT_S = 20.0
PART_SETUP_S = 12.0


def units(names, weights, parts):
    out = []
    for n in names:
        w = weights.get(n, DEFAULT_S)
        p = int(parts.get(n, 1))
        if p > 1:
            out += [(f"{n}@{k}of{p}", w / p + PART_SETUP_S) for k in range(1, p + 1)]
        else:
            out.append((n, w))
    return out


def shards(names, weights, parts, n):
    load = [0.0] * n
    out = [[] for _ in range(n)]
    for name, w in sorted(units(names, weights, parts), key=lambda x: (-x[1], x[0])):
        k = min(range(n), key=lambda j: (load[j], j))
        out[k].append(name)
        load[k] += w
    return out, load


if __name__ == "__main__":
    try:
        i, n = (int(x) for x in sys.argv[1].split("/"))
        assert 1 <= i <= n
    except (ValueError, AssertionError):
        sys.exit(f"pure-shard: bad shard {sys.argv[1]!r}")
    try:
        cfg = json.load(open(sys.argv[2]))
    except (OSError, ValueError):
        cfg = {}
    sel, _ = shards(sys.argv[3:], cfg.get("weights", {}), cfg.get("parts", {}), n)
    print("\n".join(sel[i - 1]))
