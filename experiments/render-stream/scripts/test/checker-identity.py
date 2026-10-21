#!/usr/bin/env python3
"""Checker byte-identity and cost harness (GRT4b, results/grt.md "Part 4b").

Runs one checker over a fresh copy of preserved evidence and keeps every file the checker wrote,
canonicalised, so two checker versions can be diffed. Timing fields are dropped; nothing else is.

  checker-identity.py run --work DIR --save DIR --label L --name N --pristine DIR \
      [--map OLD=NEW ...] [--cpu-prof] -- <checker argv, @OUT@ = the copy>
  checker-identity.py compare --save DIR --name N A B

`run` copies --pristine to <work>/<name> (the same path for every label, so absolute paths the
checker embeds match), points absolute symlinks under each --map OLD at NEW (a moved run's own links at the copy, a
source-cache entry's at a private read-only copy), runs the checker
under /usr/bin/time -v (as `quiet.sh shared`, it is heavy work), then saves every file created or
modified under the copy to <save>/<label>/<name>/files/, JSON and JSONL canonicalised with sorted
keys and timing keys removed, plus <save>/<label>/<name>/cost.json (wall, user, sys, peak RSS,
exit code). `compare` exits 1 unless both labels wrote the same files with the same bytes and the
same exit code, after each checkout's own path is written as @CODE@ (code_root) and its current
source key as @SOURCE_KEY@.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

# Keys whose values are wall-clock facts of the checker run itself, never verdicts.
TIMING_KEY = re.compile(r"^(generated_at|checked_at|wall_s|elapsed_s|elapsed_ms|duration_ms|checker_s)$")
SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def strip_timing(v):
    if isinstance(v, dict):
        return {k: strip_timing(x) for k, x in v.items() if not TIMING_KEY.match(k)}
    if isinstance(v, list):
        return [strip_timing(x) for x in v]
    return v


def canonical(path, data):
    if path.endswith(".json"):
        try:
            return (json.dumps(strip_timing(json.loads(data)), sort_keys=True, indent=1) + "\n").encode()
        except ValueError:
            return data
    if path.endswith(".jsonl"):
        out = []
        for line in data.decode(errors="surrogateescape").splitlines():
            try:
                out.append(json.dumps(strip_timing(json.loads(line)), sort_keys=True))
            except ValueError:
                out.append(line)
        return ("\n".join(out) + "\n").encode(errors="surrogateescape")
    return data


def relink(root, maps):
    n = 0
    for d, dirs, files in os.walk(root):
        for f in dirs + files:
            p = os.path.join(d, f)
            if os.path.islink(p):
                t = os.readlink(p)
                for old, new in maps:
                    if t.startswith(old):
                        os.unlink(p)
                        os.symlink(new + t[len(old):], p)
                        n += 1
                        break
    return n


def snapshot(root):
    snap = {}
    for d, dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            if os.path.islink(p):
                continue
            st = os.stat(p)
            snap[os.path.relpath(p, root)] = (st.st_mtime_ns, st.st_size, st.st_ino)
    return snap


def cmd_run(a):
    work = os.path.join(os.path.abspath(a.work), a.name)
    if os.path.exists(work):
        subprocess.run(["chmod", "-R", "u+w", work], check=True)
        shutil.rmtree(work)
    os.makedirs(os.path.dirname(work), exist_ok=True)
    subprocess.run(["cp", "-a", a.pristine, work], check=True)
    subprocess.run(["chmod", "-R", "u+w", work], check=True)
    maps = [tuple(m.replace("@OUT@", work).split("=", 1)) for m in a.map]
    relinked = relink(work, maps)
    before = snapshot(work)
    save = os.path.join(os.path.abspath(a.save), a.label, a.name)
    if os.path.exists(save):
        shutil.rmtree(save)
    os.makedirs(save)
    argv = a.argv[1:] if a.argv[:1] == ["--"] else a.argv
    argv = [x.replace("@OUT@", work) for x in argv]
    env = dict(os.environ)
    if a.cpu_prof:
        prof = os.path.join(save, "cpu-prof")
        os.makedirs(prof)
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") +
                               f" --cpu-prof --cpu-prof-dir={prof} --cpu-prof-interval=5000").strip()
    timef = os.path.join(save, "time-v.txt")
    full = ["bash", os.path.join(SCRIPT_DIR, "lib", "quiet.sh"), "shared", "--",
            "/usr/bin/time", "-v", "-o", timef] + argv
    t0 = time.time()
    with open(os.path.join(save, "stdout.txt"), "wb") as so, open(os.path.join(save, "stderr.txt"), "wb") as se:
        rc = subprocess.run(full, stdout=so, stderr=se, env=env).returncode
    wall = time.time() - t0
    tv = open(timef).read()

    def field(name):
        m = re.search(re.escape(name) + r":\s*(.+)", tv)
        return m.group(1).strip() if m else None

    after = snapshot(work)
    written = sorted(p for p, s in after.items() if before.get(p) != s)
    digests = {}
    for rel in written:
        data = canonical(rel, open(os.path.join(work, rel), "rb").read())
        dst = os.path.join(save, "files", rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, "wb").write(data)
        digests[rel] = hashlib.sha256(data).hexdigest()
    cost = {
        "name": a.name, "label": a.label, "argv": argv, "exit": rc, "relinked": relinked,
        "wall_s": round(wall, 2), "user_s": float(field("User time (seconds)") or 0),
        "sys_s": float(field("System time (seconds)") or 0),
        "peak_rss_mib": round(int(field("Maximum resident set size (kbytes)") or 0) / 1024, 1),
        "load_start": os.getloadavg(), "written": digests,
    }
    json.dump(cost, open(os.path.join(save, "cost.json"), "w"), indent=1, sort_keys=True)
    print(f"{a.label}/{a.name}: exit {rc} wall {cost['wall_s']} s user {cost['user_s']} s "
          f"peak RSS {cost['peak_rss_mib']} MiB, {len(written)} files written")
    return 0


def code_root(cost):
    """The checkout whose checker ran: before and after run from two checkouts, and a checker
    names its own receiver/fixture paths in some details, so those compare as @CODE@."""
    for x in cost["argv"]:
        m = re.match(r"(.*)/experiments/render-stream/scripts/check-[^/]+\.ts$", x)
        if m:
            return m.group(1)
    return None


def normalized_digests(save, label, name, cost):
    root = code_root(cost)
    out = {}
    for rel in cost["written"]:
        data = open(os.path.join(save, label, name, "files", rel), "rb").read()
        if root:
            data = data.replace((root + "/experiments/").encode(), b"@CODE@/experiments/")
        # source-key.ts hashes the checkout's own inputs, scripts included: a checker edit moves
        # "current <key>" by design (only a check's pass/fail on it would be a verdict change).
        data = re.sub(rb"current [0-9a-f]{32}\b", b"current @SOURCE_KEY@", data)
        out[rel] = hashlib.sha256(data).hexdigest()
    return out


def cmd_compare(a):
    c = [json.load(open(os.path.join(a.save, lab, a.name, "cost.json"))) for lab in (a.a, a.b)]
    d = [normalized_digests(a.save, lab, a.name, cost) for lab, cost in zip((a.a, a.b), c)]
    bad = []
    if c[0]["exit"] != c[1]["exit"]:
        bad.append(f"exit {c[0]['exit']} vs {c[1]['exit']}")
    for rel in sorted(set(d[0]) | set(d[1])):
        x, y = d[0].get(rel), d[1].get(rel)
        if x != y:
            bad.append(f"{rel}: {x and x[:12]} vs {y and y[:12]}")
    for line in bad:
        print("DIFF", a.name, line)
    print(f"{a.name}: {a.a} vs {a.b}: {len(c[0]['written'])} files, "
          f"{'IDENTICAL' if not bad else str(len(bad)) + ' differences'}; "
          f"wall {c[0]['wall_s']} -> {c[1]['wall_s']} s, user {c[0]['user_s']} -> {c[1]['user_s']} s, "
          f"peak RSS {c[0]['peak_rss_mib']} -> {c[1]['peak_rss_mib']} MiB")
    return 1 if bad else 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    for k in ("--work", "--save", "--label", "--name", "--pristine"):
        r.add_argument(k, required=True)
    r.add_argument("--map", action="append", default=[],
                   help="OLD=NEW: point absolute symlinks under OLD at NEW (@OUT@ = the copy)")
    r.add_argument("--cpu-prof", action="store_true")
    r.add_argument("argv", nargs=argparse.REMAINDER)
    c = sub.add_parser("compare")
    c.add_argument("--save", required=True)
    c.add_argument("--name", required=True)
    c.add_argument("a")
    c.add_argument("b")
    a = p.parse_args()
    return cmd_run(a) if a.cmd == "run" else cmd_compare(a)


if __name__ == "__main__":
    sys.exit(main())
