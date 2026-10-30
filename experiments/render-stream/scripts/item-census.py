#!/usr/bin/env python3
"""Item-creation census of a render-stream recording (TAG-D, client-extensions-design.md §5).

Sizes the opt-in identity layer: how many items a session creates after its opening full
transaction, in which frames, and how long they live. Reads transaction metas only, through
wire-budget.py's record reader, and prints one JSON summary (never the recording).

  python3 -I experiments/render-stream/scripts/item-census.py <recording.rsN> [--fps 60]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os


def load_reader():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib", "wire-budget.py")
    spec = importlib.util.spec_from_file_location("wire_budget", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.read_records


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0


def census(path: str, fps: float) -> dict:
    live: dict[int, int] = {}  # id -> first frame
    births, bursts, lifetimes = [], [], []
    first_full = peak = removed = ntx = 0
    first = last = None
    origins: dict[str, int] = {}
    for _ver, rec in load_reader()(path):
        m = rec.meta
        if m.get("type") != "transaction":
            continue
        ntx += 1
        f = m["frame"]
        first = f if first is None else first
        last = f
        new = 0
        for it in m.get("items", []):
            if it["id"] not in live:
                live[it["id"]] = f
                new += 1
                origins[it.get("origin")] = origins.get(it.get("origin"), 0) + 1
        for i in m.get("removed_items", []):
            if i in live:
                lifetimes.append(f - live.pop(i))
                removed += 1
        if ntx == 1:
            first_full = new
        else:
            births.append(new)
            if new:
                bursts.append([f, new, rec.size])
        peak = max(peak, len(live))
    frames = (last - first + 1) if first is not None else 0
    total = sum(births)
    minutes = frames / fps / 60 if frames else 0
    nonzero = [b for b in births if b]
    return {
        "recording": os.path.basename(path),
        "transactions": ntx,
        "frames": frames,
        "items_in_first_full": first_full,
        "peak_live_items": peak,
        "new_items_after_first": total,
        "new_items_per_frame_mean": round(total / max(1, len(births)), 3),
        "new_items_per_minute_at_fps": round(total / minutes) if minutes else 0,
        "assumed_fps": fps,
        "transactions_with_new_items": len(nonzero),
        "new_per_tx_nonzero": {"p50": pct(nonzero, 0.5), "p95": pct(nonzero, 0.95), "max": max(births or [0])},
        "bursts_frame_new_recordbytes": bursts,
        "removed_items": removed,
        "lifetime_frames": {
            "p50": pct(lifetimes, 0.5),
            "p90": pct(lifetimes, 0.9),
            "le_30_frames_frac": round(sum(1 for x in lifetimes if x <= 30) / max(1, len(lifetimes)), 4),
        },
        "origins": origins,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("recording")
    ap.add_argument("--fps", type=float, default=60.0, help="host frame rate for the per-minute figure")
    a = ap.parse_args()
    print(json.dumps(census(a.recording, a.fps), indent=1))


if __name__ == "__main__":
    main()
