#!/usr/bin/env python3
"""validate-summary.py -- the one writer of validate-summary.json (render-stream-validate-summary/2).

  write  validate-summary.py OUT T0 T1
         what validate-increment.sh ran inline until R0a: reads OUT/plan.json and each run
         directory's rc / wall_s / tier-verdict.json / quiet-lock-summary.json, writes
         OUT/validate-summary.json, prints one line per run and exits 1 when any run failed.
  merge  validate-summary.py --merge --out DIR [--expect id,id] [--remote-json FILE] JOBDIR...
         remote runs (scripts/remote-validate.sh, .github/workflows/remote-validate.yml): every
         matrix job ran `validate-increment.sh --only <id>` and left a JOBDIR with its own
         validate-summary.json (and optionally `setup_s`, a number). Combines their rows into one
         summary of the same schema plus an additive `remote` block {run_url, sha, run_key,
         setup_s[], refused[]} taken from --remote-json. An id in --expect with no job summary
         becomes a rc="missing" (failed) row, so a job that died before writing one still fails.
"""
import json
import os
import sys

PHASE_ORDER = {"setup": 0, "native": 1, "g7": 2, "timing": 3}


def lock_totals(d):
    """Quiet-lock wait and hold per mode, summed over the run's own quiet-lock-summary.json files
    (each runner, nested source runs included, writes one from its own log). Symlinked
    directories are not followed: a gate 7 view links its source run, often a source-cache entry
    made by ANOTHER run, and following it counted those holds again (G7q's g7-gsw: 18.6 ks of
    summed wait, of which 6.2 ks were its own)."""
    t = {m: {"holds": 0, "wait_s": 0.0, "hold_s": 0.0} for m in ("shared", "exclusive")}
    files = 0
    for root, dirs, fs in os.walk(d, followlinks=False):
        if "quiet-lock-summary.json" not in fs:
            continue
        try:
            s = json.load(open(os.path.join(root, "quiet-lock-summary.json")))
            for m in t:
                t[m]["holds"] += s["modes"][m]["holds"]
                t[m]["wait_s"] += s["modes"][m]["wait_s_total"]
                t[m]["hold_s"] += s["modes"][m]["hold_s_total"]
            files += 1
        except (OSError, ValueError, KeyError):
            pass
    for m in t:
        t[m]["wait_s"], t[m]["hold_s"] = round(t[m]["wait_s"], 1), round(t[m]["hold_s"], 1)
    return t, files


def collect_rows(out, plan):
    rows, failed = [], 0
    for r in plan["runs"]:
        d = os.path.join(out, r["id"])
        if not os.path.isdir(d):
            continue
        rc = open(os.path.join(d, "rc")).read().strip() if os.path.exists(os.path.join(d, "rc")) else "missing"
        tier = {}
        if os.path.exists(os.path.join(d, "tier-verdict.json")):
            try:
                tier = json.load(open(os.path.join(d, "tier-verdict.json")))
            except ValueError:
                pass
        lock, files = lock_totals(d)
        wall = float(open(os.path.join(d, "wall_s")).read()) if os.path.exists(os.path.join(d, "wall_s")) else None
        rows.append({"id": r["id"], "phase": r.get("phase"), "rc": rc, "wall_s": wall,
                     "lock_wait_s": round(lock["shared"]["wait_s"] + lock["exclusive"]["wait_s"], 1),
                     "lock_hold_s": round(lock["shared"]["hold_s"] + lock["exclusive"]["hold_s"], 1),
                     "lock": lock, "lock_summaries": files,
                     "skipped_by_tier": len(tier.get("skipped_by_tier", [])),
                     "unavailable": tier.get("unavailable", []), "failing": tier.get("failing", [])})
        failed += rc != "0"
    return rows, failed


def phase_totals(rows):
    phases = {}
    for x in rows:
        ph = phases.setdefault(x["phase"], {"runs": 0, "wall_s_sum": 0.0, "lock_wait_s": 0.0, "lock_hold_s": 0.0})
        ph["runs"] += 1
        ph["wall_s_sum"] = round(ph["wall_s_sum"] + (x["wall_s"] or 0), 1)
        ph["lock_wait_s"] = round(ph["lock_wait_s"] + x["lock_wait_s"], 1)
        ph["lock_hold_s"] = round(ph["lock_hold_s"] + x["lock_hold_s"], 1)
    return phases


def rc_rank(rc):
    """Worse is larger: 0 passes, a number is the exit status, anything else (missing) is worst."""
    try:
        return int(rc)
    except (TypeError, ValueError):
        return 1 << 30


def fold_shards(rows, expected):
    """Sharded runs (the workflow splits `pure` into RS_PURE_SHARD jobs) arrive as several rows with
    one id. Fold each id into ONE row so readers and run ids are unchanged: rc = the worst, wall_s =
    the max (shards run in parallel), lock times and skipped_by_tier summed, failing/unavailable
    unioned. `expected` maps id -> shard count: fewer rows than that (a shard job died before writing
    its summary) makes the folded rc "missing". The row gains `shards`: [{rc, wall_s}] for audit."""
    by_id, order = {}, []
    for r in rows:
        if r["id"] not in by_id:
            order.append(r["id"])
        by_id.setdefault(r["id"], []).append(r)
    out = []
    for i in order:
        g = by_id[i]
        want = expected.get(i, 1)
        if len(g) == 1 and want <= 1:
            out.append(g[0])
            continue
        f = dict(g[0])
        worst = max(g, key=lambda r: rc_rank(r["rc"]))
        f["rc"] = "missing" if len(g) < want else worst["rc"]
        walls = [r["wall_s"] for r in g if r["wall_s"] is not None]
        f["wall_s"] = max(walls) if walls else None
        f["lock_wait_s"] = round(sum(r["lock_wait_s"] for r in g), 1)
        f["lock_hold_s"] = round(sum(r["lock_hold_s"] for r in g), 1)
        f["lock_summaries"] = sum(r["lock_summaries"] for r in g)
        f["lock"] = {m: {k: round(sum(r["lock"].get(m, {}).get(k, 0) for r in g), 1) for k in ("holds", "wait_s", "hold_s")}
                     for m in ("shared", "exclusive")} if any(r["lock"] for r in g) else {}
        f["skipped_by_tier"] = sum(r["skipped_by_tier"] for r in g)
        for k in ("unavailable", "failing"):
            seen = []
            for r in g:
                seen += [x for x in r[k] if x not in seen]
            f[k] = seen
        f["shards"] = [{"rc": r["rc"], "wall_s": r["wall_s"]} for r in g]
        out.append(f)
    return out


def emit(out, summary, rows, failed, t0, t1, n_skipped):
    json.dump(summary, open(os.path.join(out, "validate-summary.json"), "w"), indent=2)
    for x in rows:
        print(f"  {x['id']:<28} [{str(x['phase']):<6}] rc={x['rc']:<3} {x['wall_s'] or 0:>8.1f} s  lock wait {x['lock_wait_s']:>7.1f} s"
              f"  hold {x['lock_hold_s']:>7.1f} s"
              + (f"  skipped-by-tier {x['skipped_by_tier']}" if x["skipped_by_tier"] else "")
              + (f"  unavailable {len(x['unavailable'])}" if x["unavailable"] else ""))
    print(f"validate-increment: {len(rows) - failed}/{len(rows)} runs pass in {t1 - t0:.0f} s; "
          f"{n_skipped} targets out of reach; summary {out}/validate-summary.json")
    return 1 if failed else 0


def write_mode(out, t0, t1):
    plan = json.load(open(os.path.join(out, "plan.json")))
    rows, failed = collect_rows(out, plan)
    summary = {"schema": "render-stream-validate-summary/2", "wall_s": round(t1 - t0, 1), "runs": rows,
               "phases": phase_totals(rows), "milestone": plan.get("milestone"), "base": plan.get("base"),
               "sabotage": plan["sabotage"], "skipped_targets": len(plan["skipped_targets"]), "failed": failed}
    return emit(out, summary, rows, failed, t0, t1, len(plan["skipped_targets"]))


def merge_mode(argv):
    out, expect, remote_json, jobs, wall = None, [], None, [], None
    it = iter(argv)
    for a in it:
        if a == "--out":
            out = next(it)
        elif a == "--expect":
            expect = [x for x in next(it).split(",") if x]
        elif a == "--remote-json":
            remote_json = next(it)
        elif a == "--wall-s":
            wall = float(next(it))
        else:
            jobs.append(a)
    if not out:
        sys.exit("validate-summary: --merge needs --out")
    os.makedirs(out, exist_ok=True)
    rows, first, setup_s = [], None, []
    for j in jobs:
        p = os.path.join(j, "validate-summary.json")
        try:
            s = json.load(open(p))
        except (OSError, ValueError):
            continue
        first = first or s
        rows.extend(s.get("runs", []))
        try:
            setup_s.append(float(open(os.path.join(j, "setup_s")).read().strip()))
        except (OSError, ValueError):
            pass
    expected_shards = {}
    if remote_json:
        try:
            expected_shards = json.load(open(remote_json)).get("shards") or {}
        except (OSError, ValueError):
            pass
    rows = fold_shards(rows, expected_shards)
    have = {r["id"] for r in rows}
    for i in expect:
        if i not in have:
            rows.append({"id": i, "phase": None, "rc": "missing", "wall_s": None, "lock_wait_s": 0.0,
                         "lock_hold_s": 0.0, "lock": {}, "lock_summaries": 0, "skipped_by_tier": 0,
                         "unavailable": [], "failing": []})
    if expect:
        order = {i: n for n, i in enumerate(expect)}
        rows.sort(key=lambda r: (PHASE_ORDER.get(r["phase"], 9), order.get(r["id"], 1 << 30)))
    else:
        rows.sort(key=lambda r: PHASE_ORDER.get(r["phase"], 9))
    failed = sum(1 for r in rows if r["rc"] != "0")
    first = first or {}
    if wall is None:
        wall = round(max([r["wall_s"] or 0 for r in rows] + [0]), 1)
    remote = {"run_url": None, "sha": None, "run_key": None, "refused": []}
    if remote_json:
        remote.update(json.load(open(remote_json)))
    remote["setup_s"] = setup_s
    summary = {"schema": "render-stream-validate-summary/2", "wall_s": wall, "runs": rows,
               "phases": phase_totals(rows), "milestone": first.get("milestone"), "base": first.get("base"),
               "sabotage": first.get("sabotage"), "skipped_targets": first.get("skipped_targets", 0),
               "failed": failed, "remote": remote}
    return emit(out, summary, rows, failed, 0.0, wall, summary["skipped_targets"])


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--merge":
        sys.exit(merge_mode(sys.argv[2:]))
    out = sys.argv[1]
    sys.exit(write_mode(out, float(sys.argv[2].replace(",", ".")), float(sys.argv[3].replace(",", "."))))
