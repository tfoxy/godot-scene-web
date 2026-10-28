#!/usr/bin/env python3
"""Attribute a `perf record -g` profile of a host process to named code paths (MX, 2026-10-28).

    perf-attribute.py <perf.data> --freq 499 --rule capture='librender_stream_capture' \
        --rule mirror='Spirectl|SceneWatcher' [--main-tid <pid>] [--seconds <window s>] [--json out]

Reads `perf script` (frames as `sym (dso)`) and counts, for each rule, the samples whose stack has
ANY frame matching the rule's regex (inclusive), over all threads and over the main thread
(--main-tid, default: the sampled pid). At a sampling frequency F a sample stands for 1/F s of
on-CPU time, so a rule's CPU ms is samples * 1000 / F; with --seconds it is also given per second
(divide by the frame rate for ms per frame). It also lists the top self (leaf) symbols inside each
rule and the busiest threads, so an attribution can be checked by eye. With --perf-map (a copy of
/tmp/perf-<pid>.map from DOTNET_PerfMapEnabled=1), unresolved frames are looked up by ip, which also
covers .NET's W^X double mapping (JIT code in a memfd that perf never matches to the map).
Generic: nothing here knows the game.
"""
import argparse, collections, json, re, subprocess, sys


class PerfMap:
    """/tmp/perf-<pid>.map ranges (`START SIZE name`, hex). perf skips the map for JIT code that .NET's
    W^X double mapping places in a file-backed memfd, so unknown frames are looked up here by ip."""

    def __init__(self, path):
        import bisect
        self.bisect = bisect
        rows = []
        for line in open(path, errors="replace"):
            parts = line.rstrip("\n").split(" ", 2)
            if len(parts) == 3:
                try:
                    rows.append((int(parts[0], 16), int(parts[1], 16), parts[2]))
                except ValueError:
                    pass
        rows.sort()
        self.starts = [r[0] for r in rows]
        self.rows = rows

    def lookup(self, ip):
        i = self.bisect.bisect_right(self.starts, ip) - 1
        if i >= 0 and ip < self.rows[i][0] + self.rows[i][1]:
            return self.rows[i][2] + " (jit)"
        return None


JIT = None


def samples(data):
    out = subprocess.run(["perf", "script", "-i", data, "-F", "pid,tid,comm,ip,sym,dso"],
                         capture_output=True, text=True, errors="replace")
    if out.returncode != 0:
        sys.exit(f"perf script failed: {out.stderr[-400:]}")
    cur = None
    for line in out.stdout.splitlines():
        if not line.strip():
            if cur:
                yield cur
            cur = None
            continue
        if not line.startswith((" ", "\t")):
            if cur:
                yield cur
            m = re.match(r"\s*(.+?)\s+(\d+)/(\d+)\s*$", line)
            if m:
                cur = {"comm": m.group(1), "pid": int(m.group(2)), "tid": int(m.group(3)), "frames": []}
            else:
                m = re.match(r"\s*(.+?)\s+(\d+)\s*$", line)
                cur = {"comm": m.group(1) if m else line.strip(), "pid": None,
                       "tid": int(m.group(2)) if m else -1, "frames": []}
            continue
        if cur is not None:
            parts = line.strip().split(None, 1)
            frame = parts[1] if len(parts) > 1 else parts[0]
            if JIT and frame.startswith("[unknown]"):
                try:
                    frame = JIT.lookup(int(parts[0], 16)) or frame
                except ValueError:
                    pass
            cur["frames"].append(frame)
    if cur:
        yield cur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--freq", type=float, required=True)
    ap.add_argument("--rule", action="append", default=[], help="name=regex (inclusive match)")
    ap.add_argument("--main-tid", type=int)
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--perf-map")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--json")
    a = ap.parse_args()
    rules = [(r.split("=", 1)[0], re.compile(r.split("=", 1)[1])) for r in a.rule]
    global JIT
    if a.perf_map:
        JIT = PerfMap(a.perf_map)
    rows = list(samples(a.data))
    pid = next((r["pid"] for r in rows if r["pid"]), None)
    main_tid = a.main_tid or pid
    ms = 1000.0 / a.freq
    res = {"data": a.data, "freq": a.freq, "pid": pid, "main_tid": main_tid, "samples": len(rows),
           "main_samples": sum(1 for r in rows if r["tid"] == main_tid), "rules": {}, "threads": []}
    for name, rx in rules:
        hit = [r for r in rows if any(rx.search(f) for f in r["frames"])]
        main_hit = [r for r in hit if r["tid"] == main_tid]
        leaf = collections.Counter(r["frames"][0] if r["frames"] else "?" for r in hit)
        res["rules"][name] = {
            "samples": len(hit), "cpu_ms": round(len(hit) * ms, 1),
            "main_samples": len(main_hit), "main_cpu_ms": round(len(main_hit) * ms, 1),
            "top_leaf": leaf.most_common(a.top),
        }
        if a.seconds:
            res["rules"][name]["cpu_ms_per_s"] = round(len(hit) * ms / a.seconds, 2)
            res["rules"][name]["main_cpu_ms_per_s"] = round(len(main_hit) * ms / a.seconds, 2)
    by = collections.Counter((r["tid"], r["comm"]) for r in rows)
    res["threads"] = [{"tid": t, "comm": c, "samples": n, "cpu_ms": round(n * ms, 1)}
                      for (t, c), n in by.most_common(a.top)]
    if a.seconds:
        res["seconds"] = a.seconds
        res["cpu_ms_per_s"] = round(len(rows) * ms / a.seconds, 1)
        res["main_cpu_ms_per_s"] = round(res["main_samples"] * ms / a.seconds, 1)
    text = json.dumps(res, indent=1)
    if a.json:
        open(a.json, "w").write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
