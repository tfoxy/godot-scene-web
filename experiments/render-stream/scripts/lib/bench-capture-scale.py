#!/usr/bin/env python3
"""Helper for scripts/bench-capture-scale.sh (P3-CAP, results/p3/p3-cap.md).

  bench-capture-scale.py run <leg dir> -- <command...>
      Runs the command (stdout/stderr to <leg dir>/stdout.log, stderr.log), samples its /proc stat
      and status every 0.5 s into samples.txt (ms since start, utime+stime ticks, VmRSS kB) and
      exits with the command's exit code.
  bench-capture-scale.py verdict <out> [--mode M] [--budget-callback-ms MS] [--min-fps-ratio R]
                                       [--perf 0|1]
      Summarises <out>/unarmed and <out>/armed into <out>/bench-capture-scale.json and writes
      <out>/result.json: {schema, checks: [{id, passed, detail}]}. Exit 1 when a check fails.
  bench-capture-scale.py self-test
      The summary and verdict logic on synthetic legs (no Godot).
"""
import json
import os
import subprocess
import sys
import tempfile
import time


def run(leg_dir, argv):
    with open(os.path.join(leg_dir, "stdout.log"), "wb") as out, \
            open(os.path.join(leg_dir, "stderr.log"), "wb") as err:
        proc = subprocess.Popen(argv, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        start = time.monotonic()
        with open(os.path.join(leg_dir, "samples.txt"), "w") as samples:
            while proc.poll() is None:
                try:
                    with open(f"/proc/{proc.pid}/stat") as f:
                        fields = f.read().rsplit(")", 1)[1].split()
                    ticks = int(fields[11]) + int(fields[12])  # utime + stime
                    rss = 0
                    with open(f"/proc/{proc.pid}/status") as f:
                        for line in f:
                            if line.startswith("VmRSS:"):
                                rss = int(line.split()[1])
                    samples.write(f"{int((time.monotonic() - start) * 1000)} {ticks} {rss}\n")
                    samples.flush()
                except (OSError, IndexError, ValueError):
                    pass
                time.sleep(0.5)
        code = proc.wait()
    with open(os.path.join(leg_dir, "exit.txt"), "w") as f:
        f.write(f"{code}\n")
    return code


def percentile(hist, q):
    """The bucket lower bound at quantile q of a capture perf.json histogram (rs_histogram.h)."""
    n = hist.get("count", 0)
    if n == 0:
        return None
    acc = 0
    for bucket, count in hist.get("buckets", []):
        acc += count
        if acc >= q * n:
            return bucket
    return None


def summarize(leg_dir, hz):
    out = {"exit": None}
    path = os.path.join(leg_dir, "exit.txt")
    if os.path.exists(path):
        out["exit"] = int(open(path).read().strip() or -1)
    path = os.path.join(leg_dir, "scale-report.json")
    out["scale"] = json.load(open(path)) if os.path.exists(path) else None
    rows = []
    path = os.path.join(leg_dir, "samples.txt")
    if os.path.exists(path):
        for line in open(path):
            parts = line.split()
            if len(parts) == 3:
                rows.append(tuple(int(p) for p in parts))
    if len(rows) > 4:
        # steady state: the last 60 % of the samples (setup and arm come first)
        a, b = rows[int(len(rows) * 0.4)], rows[-1]
        out["cores"] = round((b[1] - a[1]) / hz / max(1e-9, (b[0] - a[0]) / 1000), 3)
        out["rss_mb_max"] = round(max(r[2] for r in rows) / 1024, 1)
        out["rss_mb_end"] = round(b[2] / 1024, 1)
    path = os.path.join(leg_dir, "evidence", "perf.json")
    if os.path.exists(path):
        hists = json.load(open(path)).get("histograms", {})
        for key in ("frame_callback_us", "snapshot_us", "frame_interval_us", "diff_us", "encode_us"):
            h = hists.get(key)
            if isinstance(h, dict) and h.get("count"):
                out[key] = {"count": h["count"], "mean": round(h["mean"]), "p50": percentile(h, 0.5),
                            "p95": percentile(h, 0.95), "max": h.get("max")}
    return out


def verdict(out_dir, mode, budget_ms, min_ratio, perf, hz=None):
    hz = hz or os.sysconf("SC_CLK_TCK")
    legs = {name: summarize(os.path.join(out_dir, name), hz) for name in ("unarmed", "armed")}
    checks = []
    un_fps = ((legs["unarmed"].get("scale") or {}).get("fps")) or 0
    ar_fps = ((legs["armed"].get("scale") or {}).get("fps")) or 0
    ran = all(leg["exit"] == 0 and leg.get("scale") for leg in legs.values())
    checks.append({"id": "legs-ran", "passed": ran,
                   "detail": f"exit unarmed={legs['unarmed']['exit']} armed={legs['armed']['exit']}"})
    ratio = ar_fps / un_fps if un_fps else 0
    checks.append({"id": "armed-fps", "passed": ran and ratio >= min_ratio,
                   "detail": f"armed {ar_fps:.1f} fps / unarmed {un_fps:.1f} fps = {ratio:.3f} "
                             f"(>= {min_ratio})" + (" [perf-wrapped: not a rate]" if perf else "")})
    cb = legs["armed"].get("frame_callback_us") or {}
    p50 = cb.get("p50")
    checks.append({"id": "callback-p50", "passed": p50 is not None and p50 <= budget_ms * 1000,
                   "detail": f"frame_callback_us p50 {p50} (<= {budget_ms * 1000}); mean "
                             f"{cb.get('mean')}, p95 {cb.get('p95')}; snapshot_us p50 "
                             f"{(legs['armed'].get('snapshot_us') or {}).get('p50')}"})
    summary = {"schema": "render-stream-capture-scale/1", "mode": mode, "legs": legs,
               "budget_callback_ms": budget_ms, "min_fps_ratio": min_ratio, "perf_wrapped": bool(perf)}
    json.dump(summary, open(os.path.join(out_dir, "bench-capture-scale.json"), "w"), indent=1)
    json.dump({"schema": "render-stream-capture-scale-result/1", "checks": checks},
              open(os.path.join(out_dir, "result.json"), "w"), indent=2)
    for c in checks:
        print(f"bench-capture-scale: {'pass' if c['passed'] else 'FAIL'} {c['id']}: {c['detail']}")
    for name, leg in legs.items():
        print(f"bench-capture-scale: {name}: cores {leg.get('cores')} rss_mb_max {leg.get('rss_mb_max')}")
    return 0 if all(c["passed"] for c in checks) else 1


def self_test():
    failures = 0

    def check(what, ok):
        nonlocal failures
        print(f"{'ok  ' if ok else 'FAIL'} {what}")
        failures += 0 if ok else 1

    hist = {"count": 4, "mean": 10, "buckets": [[1000, 1], [2048, 2], [9000, 1]]}
    check("p50 is the bucket holding the median", percentile(hist, 0.5) == 2048)
    check("p95 is the top bucket", percentile(hist, 0.95) == 9000)
    check("an empty histogram has no percentile", percentile({"count": 0}, 0.5) is None)
    with tempfile.TemporaryDirectory() as tmp:
        def leg(name, fps, cb_p50_bucket):
            d = os.path.join(tmp, name)
            os.makedirs(os.path.join(d, "evidence"))
            open(os.path.join(d, "exit.txt"), "w").write("0\n")
            json.dump({"fps": fps, "frames": 479}, open(os.path.join(d, "scale-report.json"), "w"))
            open(os.path.join(d, "samples.txt"), "w").write(
                "".join(f"{i * 500} {i * 10} {1024 * (100 + i)}\n" for i in range(10)))
            if cb_p50_bucket is not None:
                json.dump({"histograms": {"frame_callback_us": {
                    "count": 2, "mean": cb_p50_bucket, "max": cb_p50_bucket,
                    "buckets": [[cb_p50_bucket, 2]]}}},
                    open(os.path.join(d, "evidence", "perf.json"), "w"))
        leg("unarmed", 60.0, None)
        leg("armed", 59.5, 3000)
        check("a fast armed leg passes", verdict(tmp, "file", 6, 0.95, 0, hz=100) == 0)
        res = json.load(open(os.path.join(tmp, "result.json")))
        check("three checks, all passed", [c["passed"] for c in res["checks"]] == [True, True, True])
        s = json.load(open(os.path.join(tmp, "bench-capture-scale.json")))
        check("cores from the steady samples", s["legs"]["armed"]["cores"] == 0.2)
        json.dump({"fps": 45.0}, open(os.path.join(tmp, "armed", "scale-report.json"), "w"))
        check("a slow armed leg fails armed-fps", verdict(tmp, "file", 6, 0.95, 0, hz=100) == 1)
        json.dump({"fps": 60.0}, open(os.path.join(tmp, "armed", "scale-report.json"), "w"))
        check("a callback over budget fails", verdict(tmp, "file", 2, 0.95, 0, hz=100) == 1)
        open(os.path.join(tmp, "armed", "exit.txt"), "w").write("1\n")
        check("a crashed leg fails", verdict(tmp, "file", 6, 0.95, 0, hz=100) == 1)
    print("bench-capture-scale self-test: " + ("PASS" if failures == 0 else f"{failures} FAILED"))
    return 0 if failures == 0 else 1


def main(argv):
    if len(argv) >= 1 and argv[0] == "self-test":
        return self_test()
    if len(argv) >= 3 and argv[0] == "run" and argv[2] == "--":
        return run(argv[1], argv[3:])
    if len(argv) >= 2 and argv[0] == "verdict":
        opts = {"--mode": "file", "--budget-callback-ms": "8", "--min-fps-ratio": "0.95", "--perf": "0"}
        rest = argv[2:]
        for i in range(0, len(rest) - 1, 2):
            opts[rest[i]] = rest[i + 1]
        return verdict(argv[1], opts["--mode"], float(opts["--budget-callback-ms"]),
                       float(opts["--min-fps-ratio"]), opts["--perf"] == "1")
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
