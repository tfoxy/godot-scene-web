#!/usr/bin/env python3
"""Split a `perf record -g` profile of an armed host's main thread by capture function (HC).

    perf-capture-split.py <perf.data> --freq 999 [--window-s 8] [--fps 60] [--counters counters.json]
        [--json out.json]

Reads `perf script` for the sampled process's main thread (tid == pid), keeps the last --window-s
seconds before its last sample but one (the steady state, after the scene's setup), and charges
each sample to ONE bucket: the innermost capture frame (a frame in librender_stream_capture) whose
symbol matches a bucket's regex, walking from the leaf. A sample with no capture frame is `engine`
(the game, the renderer, the driver). A sample whose innermost capture frame is a hook_* entry
point but which has an engine frame below it (between the leaf and the hook) is the hooked engine
call itself, `engine (under a hook)`, not capture cost. libc and libstdc++ carry no frame pointers,
so their leaves are charged to the caller's caller, which is still inside the right function.

With --fps the buckets are also given in ms per frame (samples * 1000 / freq / (window * fps)).
With --counters (the capture's evidence/counters.json) each hook bucket also gets its calls per
frame and its microseconds per call. Generic: the buckets name capture functions only.
"""
import argparse, collections, json, re, subprocess, sys

CAPTURE = "librender_stream_capture"
# (bucket, regex over the symbol). Checked in order at each capture frame, leaf first; the first
# frame that matches any bucket decides. Narrow buckets come before the functions that call them.
BUCKETS = [
    ("zstd", r"ZSTD_|HUF_|FSE_|XXH|live_coding::"),
    ("sha256", r"[Ss]ha256|sha256_"),
    ("sha1", r"[Ss]ha1"),
    ("cv digest (command_list_digest)", r"command_list_digest"),
    ("encode: JSON and blocks", r"encode_transaction|encode_resource|encode_session|JsonWriter|"
                                r"rs2::.*encode|write_item|write_command"),
    ("diff (make_patch/make_full)", r"make_patch|make_full|item_state_equal|_entry_equal|IdIndex|"
                                    r"diff_tables"),
    ("record planning (inline/payload refs)", r"RecordPlanner|v11_records|inline_names|collect_names|"
                                              r"payload_refs|payload_names|target_refs|CarriedIndex|"
                                              r"plan_v11_records"),
    ("store bookkeeping", r"store_payloads|ResourceStore|FileWriter|FileRecordSink"),
    ("budget and serving (pin/retire/union)", r"payload_union_bytes|payload_map_bytes|ServedResources|"
                                              r"retained_bytes_beyond"),
    ("hub (connections, restamp, tap)", r"live::Hub|Hub::|restamp|LiveServer|rs_ws"),
    ("snapshot: material params", r"wire_params|wire_material|material_unsupported|to_param"),
    ("snapshot: textures/meshes/shaders", r"wire_entry|wire_mesh|wire_shader|classify_mesh|settle|"
                                          r"resolve_pending|res_publish_resources|res_share_update|"
                                          r"res_names_add|full_walk_resources"),
    ("snapshot: item walk and copies", r"Mirror::snapshot|find_ties|withheld_ids|is_withheld|"
                                       r"publish_items|own_entries|refresh_cv|stamp_cv|_state_difference|"
                                       r"texture_entry_unsupported|full_walk_items|shadow_compare"),
    ("adoption (pending material refs)", r"adopt_"),
    ("previous-snapshot release / publish", r"Publisher::publish|Captured::~|Snapshot::~"),
    ("evidence drain and perf timeline", r"resources_drain|perf_timeline|take_lines"),
    ("frame callback, other", r"stream_publish|on_frame|live_drain"),
    ("resource log lines (outside hooks: serve events)", r"ResourceLog::"),
    ("mirror (hook-side updates)", r"Mirror::"),
    ("mesh payloads (hook-side GRM1)", r"mesh_payload|MeshPayload|grm1|handle_mesh_region|mesh_surface"),
    ("hook census (log_entry/rect scan)", r"log_entry|same_rect_capture|same_as"),
]
HEADER = re.compile(r"\s*(\d+)/(\d+)\s+([\d.]+):\s*$")
HOOK = re.compile(r"\bhook_([a-z0-9_]+)")
NO_FP = re.compile(r"\((/usr)?/lib/.*(libc|libstdc\+\+|libm|ld-linux)[^)]*\)|\[kernel|\(\[unknown\]\)")


def samples(data):
    out = subprocess.run(["perf", "script", "-i", data, "-F", "pid,tid,time,ip,sym,dso"],
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
        m = HEADER.match(line)
        if m:
            if cur:
                yield cur
            cur = {"pid": int(m.group(1)), "tid": int(m.group(2)), "t": float(m.group(3)),
                   "frames": []}
            continue
        if cur is not None:
            parts = line.strip().split(None, 1)
            cur["frames"].append(parts[1] if len(parts) > 1 else parts[0])
    if cur:
        yield cur


def classify(frames):
    """(bucket, hook name or None) for one stack, leaf first."""
    engine_below = False
    for frame in frames:
        if CAPTURE not in frame:
            if not NO_FP.search(frame):
                engine_below = True
            continue
        hook = HOOK.search(frame)
        if hook:
            if engine_below:
                return "engine (under a hook)", None
            return "hook " + hook.group(1), hook.group(1)
        for name, rx in BUCKETS:
            if re.search(rx, frame):
                # The hook this sample sits under, if any (hook-side work is charged to its hook).
                for outer in frames:
                    h = HOOK.search(outer)
                    if h and CAPTURE in outer and name in ("mirror (hook-side updates)",
                                                           "resource log lines (outside hooks: serve events)",
                                                           "mesh payloads (hook-side GRM1)",
                                                           "hook census (log_entry/rect scan)",
                                                           "sha256"):
                        return "hook " + h.group(1), h.group(1)
                return name, None
        engine_below = False  # an unbucketed capture frame: keep walking toward the root
    return ("capture, unbucketed", None) if any(CAPTURE in f for f in frames) else ("engine", None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--freq", type=float, required=True)
    ap.add_argument("--window-s", type=float, default=8.0)
    ap.add_argument("--fps", type=float)
    ap.add_argument("--counters")
    ap.add_argument("--json")
    a = ap.parse_args()
    rows = list(samples(a.data))
    if not rows:
        sys.exit("no samples")
    pid = rows[0]["pid"]
    main = [r for r in rows if r["tid"] == pid]
    t_end = max(r["t"] for r in main) - 0.5
    t_start = t_end - a.window_s
    win = [r for r in main if t_start <= r["t"] <= t_end]
    others = [r for r in rows if r["tid"] != pid and t_start <= r["t"] <= t_end]
    ms = 1000.0 / a.freq
    frames = a.window_s * a.fps if a.fps else None
    buckets = collections.Counter()
    sub = collections.defaultdict(collections.Counter)
    for r in win:
        name, _ = classify(r["frames"])
        buckets[name] += 1
        leaf = next((f for f in r["frames"] if CAPTURE in f), r["frames"][0] if r["frames"] else "?")
        sub[name][re.sub(r"\s*\(.*\)$", "", leaf)[:90]] += 1
    calls = {}
    if a.counters:
        counters = json.load(open(a.counters))
        flat = counters.get("calls", counters)
        for k, v in flat.items():
            if isinstance(v, (int, float)):
                calls[k] = v
    res = {"data": a.data, "pid": pid, "freq": a.freq, "window_s": a.window_s, "fps": a.fps,
           "main_samples": len(win), "main_ms_per_frame": round(len(win) * ms / frames, 3) if frames else None,
           "buckets": []}
    for name, n in buckets.most_common():
        row = {"bucket": name, "samples": n, "share": round(n / len(win), 4)}
        if frames:
            row["ms_per_frame"] = round(n * ms / frames, 3)
        row["top"] = sub[name].most_common(4)
        res["buckets"].append(row)
    threads = collections.Counter(r["tid"] for r in others)
    res["other_threads_ms_per_frame"] = {str(t): round(n * ms / frames, 3) if frames else n
                                         for t, n in threads.most_common(6)}
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)
    print(f"main thread: {len(win)} samples over {a.window_s} s"
          + (f" = {res['main_ms_per_frame']} ms/frame at {a.fps} fps" if frames else ""))
    for row in res["buckets"]:
        print(f"  {row['share']*100:5.1f}%  {row.get('ms_per_frame', ''):>7}  {row['bucket']}")
    print("other threads ms/frame:", res["other_threads_ms_per_frame"])


if __name__ == "__main__":
    main()
