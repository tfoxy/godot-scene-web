#!/usr/bin/env python3
"""Helper for scripts/bench-live-scale.sh (P3-LV, results/p3/p3-lv.md).

  bench-live-scale.py verdict <out> [--min-rate R] [--max-credit-rtt-ms MS]
      Summarises <out>/host (the live tap's live-1.jsonl, the host's evidence) and <out>/rx (the
      receiver's perf.json) into <out>/bench-live-scale.json and writes <out>/result.json:
      {schema, checks: [{id, passed, detail}]}. Exit 1 when a check fails.
  bench-live-scale.py tap <live-N.jsonl> [--frames A-B]
      Prints the tap summary (tap_stats) of one connection as JSON, optionally over host frames A-B.
  bench-live-scale.py self-test
      The tap summary and the verdict on synthetic legs (no Godot, no browser).

The tap (rs_live.cpp, GRC_LIVE_TAP_DIR) has one line per frame callback (`state`, `pending`,
`sent`: seq, encoding, bytes), one per ack (`event: ack`, seq, stage, the receiver's `t_us`), one
per inline resource record and one per answered GET, all on the host clock. So every receiver kind
is measured the same way:
  latency      a transaction's send -> its `applied` ack (host clock both ends)
  credit RTT   send -> the ack at the connection's credit stage
  applies/s    distinct receiver apply instants (`applied` acks sharing the receiver's t_us were
               applied together: a credit-window-2 fold)
  first apply  connection open -> seq 1's `applied` ack (a fresh subscriber's first frame)
"""
import json
import os
import sys
import tempfile


def q(values, p):
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(p * len(v)))]


def r1(x):
    return None if x is None else round(x, 1)


def load_jsonl(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def tap_stats(lines, f0=None, f1=None):
    """One connection's tap over host frames [f0, f1] (None: the whole connection)."""
    open_t = None
    hello = {}
    sends = {}  # seq -> (frame, t_us, bytes, encoding)
    acks = {}  # (seq, stage) -> (t_us, receiver_t_us)
    frames = []  # (frame, t_us, pending)
    gets, resources = [], []
    for d in lines:
        ev = d.get("event")
        if ev == "open":
            open_t = d["t_us"]
        elif ev == "hello":
            hello = d
        elif ev == "ack":
            acks.setdefault((d["seq"], d["stage"]), (d["t_us"], d.get("receiver_t_us")))
        elif ev == "http-get":
            gets.append(d)
        elif ev == "resource":
            resources.append(d)
        elif ev is None and "state" in d:
            frames.append((d["frame"], d["t_us"], bool(d.get("pending"))))
            s = d.get("sent")
            if s:
                sends[s["seq"]] = (d["frame"], d["t_us"], s.get("bytes", 0), s.get("encoding"))

    def inwin(fr):
        return (f0 is None or fr >= f0) and (f1 is None or fr <= f1)

    fw = [x for x in frames if inwin(x[0])]
    if len(fw) < 2:
        return None
    dur = (fw[-1][1] - fw[0][1]) / 1e6
    if dur <= 0:
        return None
    sw = {s: v for s, v in sends.items() if inwin(v[0])}
    applied = {s: acks.get((s, "applied")) for s in sw}
    lat = [(a[0] - sw[s][1]) / 1000 for s, a in applied.items() if a]
    stage = hello.get("credit_stage") or "submitted"
    rtt = [(acks[(s, stage)][0] - v[1]) / 1000 for s, v in sw.items() if (s, stage) in acks]
    instants = [a[1] for a in applied.values() if a and a[1] is not None]
    gw = [g for g in gets if inwin(g["frame"])]
    rw = [r for r in resources if inwin(r["frame"])]
    patch_bytes = [v[2] for v in sw.values() if v[3] == "patch"]
    first = None
    if f0 is None and open_t is not None and (1, "applied") in acks:
        first = (acks[(1, "applied")][0] - open_t) / 1000
    return {
        "receiver_kind": hello.get("receiver_kind"),
        "credit_window": hello.get("credit_window_granted"),
        "frames": [fw[0][0], fw[-1][0]],
        "dur_s": round(dur, 2),
        "host_fps": r1((len(fw) - 1) / dur),
        "sent_per_s": r1(len(sw) / dur),
        "applied_per_s": r1(len(instants) / dur),
        "applies_per_s": r1(len(set(instants)) / dur),
        "folded": len(instants) - len(set(instants)),
        "never_applied": sum(1 for a in applied.values() if a is None),
        "coalesced_frames": sum(1 for x in fw if x[2]),
        "latency_ms_p50": r1(q(lat, 0.5)),
        "latency_ms_p95": r1(q(lat, 0.95)),
        "credit_rtt_ms_p50": r1(q(rtt, 0.5)),
        "credit_rtt_ms_p95": r1(q(rtt, 0.95)),
        "ws_kib_per_s": r1(sum(v[2] for v in sw.values()) / dur / 1024),
        "patch_kib_p50": r1(q(patch_bytes, 0.5) / 1024) if patch_bytes else None,
        "gets_per_s": r1(len(gw) / dur),
        "get_kib_per_s": r1(sum(g.get("bytes", 0) for g in gw) / dur / 1024),
        "inline_records_per_s": r1(len(rw) / dur),
        "inline_kib_per_s": r1(sum(r.get("bytes", 0) for r in rw) / dur / 1024),
        "first_apply_ms": None if first is None else round(first),
    }


def hist_ms(h):
    if not isinstance(h, dict) or not h.get("count"):
        return None
    mean = h.get("mean")
    if mean is None:
        mean = h.get("sum", 0) / h["count"]
    out = {"n": h["count"], "mean": round(mean / 1000, 2)}
    for k in ("p50", "p95", "max"):
        if h.get(k) is not None:
            out[k] = round(h[k] / 1000, 2)
    return out


def rx_stats(rx):
    """The receiver's own stage times (ms) and frame rate from its perf.json (native and web
    export: render-stream-receiver-perf/1; GSW: its perf.ts shape)."""
    out = {}
    path = os.path.join(rx, "exit.txt")
    if os.path.exists(path):
        out["exit"] = open(path).read().strip()
    path = os.path.join(rx, "perf.json")
    if not os.path.exists(path):
        return out
    d = json.load(open(path))
    h = d.get("histograms", {})
    out["stage_ms"] = {k[:-3]: hist_ms(h.get(k)) for k in (
        "decode_us", "apply_us", "draw_us", "total_us", "fetch_us", "payload_verify_us", "plan_us",
        "execute_us", "cpu_render_us", "gpu_render_us", "frame_interval_us") if hist_ms(h.get(k))}
    tl = d.get("timeline", [])
    if len(tl) >= 2:
        dt = (tl[-1]["t_us"] - tl[0]["t_us"]) / 1e6
        if dt > 0:
            out["frames_per_s"] = r1((tl[-1].get("frames", 0) - tl[0].get("frames", 0)) / dt)
        for k in ("rss_bytes", "wasm_heap_bytes", "cache_bytes_memory", "texture_mem_bytes"):
            v = [t.get(k) for t in tl if isinstance(t.get(k), (int, float))]
            if v:
                out[k.replace("_bytes", "_mib_max")] = round(max(v) / 2**20)
    return out


def verdict(out_dir, min_rate, max_rtt_ms):
    taps = sorted(f for f in os.listdir(os.path.join(out_dir, "host", "tap"))
                  if f.startswith("live-") and f.endswith(".jsonl")) \
        if os.path.isdir(os.path.join(out_dir, "host", "tap")) else []
    tap = tap_stats(load_jsonl(os.path.join(out_dir, "host", "tap", taps[0]))) if taps else None
    rx = rx_stats(os.path.join(out_dir, "rx"))
    host_exit = None
    path = os.path.join(out_dir, "host", "exit.txt")
    if os.path.exists(path):
        host_exit = open(path).read().strip()
    scale = None
    path = os.path.join(out_dir, "host", "scale-report.json")
    if os.path.exists(path):
        scale = json.load(open(path))
    ran = tap is not None and host_exit == "0" and rx.get("exit") == "0"
    checks = [{"id": "legs-ran", "passed": ran,
               "detail": f"host exit {host_exit}, receiver exit {rx.get('exit')}, tap {'seen' if tap else 'missing'}"}]
    rate = (tap or {}).get("applies_per_s")
    checks.append({"id": "update-rate", "passed": ran and rate is not None and rate >= min_rate,
                   "detail": f"{rate} distinct applies/s (>= {min_rate}); sent {(tap or {}).get('sent_per_s')}/s, "
                             f"folded {(tap or {}).get('folded')}"})
    rtt = (tap or {}).get("credit_rtt_ms_p50")
    checks.append({"id": "credit-rtt", "passed": ran and rtt is not None and rtt <= max_rtt_ms,
                   "detail": f"credit RTT p50 {rtt} ms (<= {max_rtt_ms}), p95 {(tap or {}).get('credit_rtt_ms_p95')}"})
    summary = {"schema": "render-stream-live-scale/1", "tap": tap, "receiver": rx, "host_scale": scale,
               "min_rate": min_rate, "max_credit_rtt_ms": max_rtt_ms}
    json.dump(summary, open(os.path.join(out_dir, "bench-live-scale.json"), "w"), indent=1)
    json.dump({"schema": "render-stream-live-scale-result/1", "checks": checks},
              open(os.path.join(out_dir, "result.json"), "w"), indent=2)
    for c in checks:
        print(f"bench-live-scale: {'pass' if c['passed'] else 'FAIL'} {c['id']}: {c['detail']}")
    if tap:
        print("bench-live-scale: " + json.dumps({k: tap[k] for k in (
            "latency_ms_p50", "latency_ms_p95", "ws_kib_per_s", "gets_per_s", "inline_records_per_s",
            "first_apply_ms")}))
    return 0 if all(c["passed"] for c in checks) else 1


def synthetic_tap(path, n_frames, every, rtt_frames, fold=False):
    """A tap whose receiver acks each send `rtt_frames` frames later (16.667 ms frames)."""
    lines = [{"frame": 1, "t_us": 0, "event": "open", "connection": 1},
             {"frame": 1, "t_us": 10, "event": "hello", "credit_stage": "submitted",
              "receiver_kind": "native", "credit_window_granted": 2 if fold else 1}]
    seq = 0
    for f in range(1, n_frames + 1):
        t = int(f * 16667)
        sent = None
        if (f - 1) % every == 0:
            seq += 1
            sent = {"seq": seq, "encoding": "full" if seq == 1 else "patch", "bytes": 1000}
        lines.append({"frame": f, "t_us": t, "state": "streaming", "pending": sent is None, "sent": sent})
        if sent:
            ta = t + rtt_frames * 16667
            rt = (seq // 2) if fold else seq  # fold: two seqs share one receiver apply instant
            for stage in ("received", "applied", "submitted"):
                lines.append({"frame": f + rtt_frames, "t_us": ta, "event": "ack", "seq": seq,
                              "stage": stage, "receiver_t_us": rt})
            lines.append({"frame": f, "t_us": t, "event": "resource", "bytes": 500})
    lines.sort(key=lambda d: d["t_us"])
    with open(path, "w") as f:
        for d in lines:
            f.write(json.dumps(d) + "\n")


def self_test():
    failures = 0

    def check(what, ok):
        nonlocal failures
        print(f"{'ok  ' if ok else 'FAIL'} {what}")
        failures += 0 if ok else 1

    with tempfile.TemporaryDirectory() as tmp:
        def leg(name, every, rtt_frames, fold=False, rx_exit="0"):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "host", "tap"))
            os.makedirs(os.path.join(d, "rx"))
            open(os.path.join(d, "host", "exit.txt"), "w").write("0\n")
            open(os.path.join(d, "rx", "exit.txt"), "w").write(rx_exit + "\n")
            synthetic_tap(os.path.join(d, "host", "tap", "live-1.jsonl"), 601, every, rtt_frames, fold)
            json.dump({"histograms": {"apply_us": {"count": 2, "sum": 8000, "mean": 4000}},
                       "timeline": [{"t_us": 0, "frames": 0}, {"t_us": 10_000_000, "frames": 600}]},
                      open(os.path.join(d, "rx", "perf.json"), "w"))
            return d

        fast = leg("fast", 2, 2)
        check("a keeping-up receiver passes", verdict(fast, 15, 100) == 0)
        s = json.load(open(os.path.join(fast, "bench-live-scale.json")))
        check("30 sends a second", s["tap"]["sent_per_s"] == 30.1)
        check("credit RTT is two frames", s["tap"]["credit_rtt_ms_p50"] == 33.3)
        check("first apply is seq 1's applied ack", s["tap"]["first_apply_ms"] == 50)
        check("inline records counted", s["tap"]["inline_records_per_s"] == 30.1)
        check("receiver frames per second", s["receiver"]["frames_per_s"] == 60.0)
        check("receiver apply stage in ms", s["receiver"]["stage_ms"]["apply"]["mean"] == 4.0)
        slow = leg("slow", 190, 189)
        check("a GET-bound receiver fails update-rate and credit-rtt", verdict(slow, 15, 100) == 1)
        res = json.load(open(os.path.join(slow, "result.json")))
        check("legs-ran passes, the two rate checks fail",
              [c["passed"] for c in res["checks"]] == [True, False, False])
        folded = leg("folded", 1, 3, fold=True)
        verdict(folded, 15, 100)
        s = json.load(open(os.path.join(folded, "bench-live-scale.json")))
        check("folds counted by shared receiver instants", s["tap"]["folded"] > 0 and
              s["tap"]["applies_per_s"] < s["tap"]["applied_per_s"])
        win = tap_stats(load_jsonl(os.path.join(fast, "host", "tap", "live-1.jsonl")), 100, 400)
        check("a frame window has no first apply", win["first_apply_ms"] is None and win["frames"] == [100, 400])
        crashed = leg("crashed", 2, 2, rx_exit="3")
        check("a failed receiver fails legs-ran", verdict(crashed, 15, 100) == 1)
    print("bench-live-scale self-test: " + ("PASS" if failures == 0 else f"{failures} FAILED"))
    return 0 if failures == 0 else 1


def main(argv):
    if argv[:1] == ["self-test"]:
        return self_test()
    if len(argv) >= 2 and argv[0] == "tap":
        f0 = f1 = None
        if "--frames" in argv:
            a, b = argv[argv.index("--frames") + 1].split("-")
            f0, f1 = int(a), int(b)
        print(json.dumps(tap_stats(load_jsonl(argv[1]), f0, f1)))
        return 0
    if len(argv) >= 2 and argv[0] == "verdict":
        opts = {"--min-rate": "15", "--max-credit-rtt-ms": "100"}
        rest = argv[2:]
        for i in range(0, len(rest) - 1, 2):
            opts[rest[i]] = rest[i + 1]
        return verdict(argv[1], float(opts["--min-rate"]), float(opts["--max-credit-rtt-ms"]))
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
