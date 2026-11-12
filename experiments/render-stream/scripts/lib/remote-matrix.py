#!/usr/bin/env python3
"""The remote workflow's job matrix (.github/workflows/remote-validate.yml, plan job).

  remote-matrix.py --runs JSON [--run-groups JSON] [--determinism 3,1] [--pure-shards 6]
                   [--max-parallel 16] [--leg-shards auto|off|force] [--tier smoke|full] [--table FILE] [--repo DIR]
                   [--github-output FILE] [--explain]
  remote-matrix.py --refresh RUN_ID... [--table FILE]     rewrite the table's minutes from finished runs
  remote-matrix.py --self-test

Prints {"include": [...], "shards": {id: jobs}, "max_parallel": P, "estimate": {...}} (or appends
matrix=, shards= and max_parallel= to --github-output). Three things happen here:

1. Expansion, as the workflow always did: a gate 7 run of several groups is one job per group
   (<id>@<group>), `pure` is --pure-shards jobs (RS_PURE_SHARD k/n), --determinism repeats each job.
2. Leg shards: a run the table's `leg_shards` names (native gate 8, g7-8 on gsw and web-rust) can be
   split into k jobs by gate 8 group, each running `--legs` of one part (RS_VALIDATE_LEGS). A part
   written ["*"] takes every group of the runner's own list (read from the runner script) that no
   other part names, so a group added to a runner lands in a shard rather than nowhere. k is chosen
   by simulating the matrix on --max-parallel slots: the choice with the shortest simulated makespan,
   when it beats the unsharded matrix by more than a minute. Every shard repeats its job's setup
   (8-11 min on a hosted runner), so sharding is a loss when the run is throughput-bound and a win when a long job is the critical
   path: a scoped run gets shards, a full tier that already fills every slot may not. `off` never
   shards, `force` takes each run's largest k. Determinism mode and the smoke tier never shard (a
   smoke job runs a few representative legs, which a part of the groups may not hold).
3. Order: GitHub starts a matrix's jobs in `include` order as max-parallel slots free up, i.e. list
   scheduling, so `include` is sorted by expected minutes, longest first (LPT). Expected minutes come
   from the table (median job minutes, setup included, of named finished runs: `provenance`); a
   label the table does not know falls back to the longest matching `fallback_minutes` prefix, so a
   new job is still ordered sensibly. The per-job watchdog is 2x the expected validate minutes,
   clamped to [35, 60].
"""
import heapq
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TABLE = os.path.join(HERE, "..", "remote-jobs.json")
DEFAULT_REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
WATCHDOG_MIN, WATCHDOG_MAX = 35, 60
GAIN_MIN = 1.0  # a leg shard must cut the simulated makespan by more than this many minutes


def prefix_lookup(pairs, label, default):
    best = None
    for p, v in pairs:
        if label.startswith(p) and (best is None or len(p) > len(best[0])):
            best = (p, v)
    return best[1] if best else default


def expected_minutes(table, label):
    m = table.get("minutes", {})
    if label in m:
        return float(m[label])
    return float(prefix_lookup(table.get("fallback_minutes", []), label, 5.0))


def setup_minutes(table, label):
    return float(prefix_lookup(table.get("setup_minutes", []), label, 0.0))


def watchdog(table, est, label):
    validate = max(0.0, est - setup_minutes(table, label))
    return str(min(WATCHDOG_MAX, max(WATCHDOG_MIN, math.ceil(2 * validate))))


def runner_groups(repo, spec):
    """The runner's own group list: a bash array (`array`) or a comma-separated variable (`var`)."""
    text = open(os.path.join(repo, spec["from"])).read()
    if "array" in spec:
        m = re.search(r"^%s=\(([^)]*)\)" % re.escape(spec["array"]), text, re.M)
        return m.group(1).split() if m else None
    m = re.search(r"^%s=([A-Za-z0-9_,]+)\s*$" % re.escape(spec["var"]), text, re.M)
    return m.group(1).split(",") if m else None


def resolve_partition(parts, groups, together):
    """Explicit groups per part (runner order), "*" expanded to the rest; None when the partition is
    not exactly a disjoint cover of `groups` or splits a `together` set."""
    named = [g for p in parts for g in p if g != "*"]
    if len(set(named)) != len(named) or any(g not in groups for g in named):
        return None
    if sum(1 for p in parts if "*" in p) > 1:
        return None
    rest = [g for g in groups if g not in named]
    out = []
    for p in parts:
        want = set(x for x in p if x != "*") | (set(rest) if "*" in p else set())
        out.append([g for g in groups if g in want])
    if any(not p for p in out) or sorted(g for p in out for g in p) != sorted(groups):
        return None
    for t in together:
        if len({i for i, p in enumerate(out) for g in t if g in p}) > 1:
            return None
    return out


def shard_options(table, label, repo, warn):
    """{k: [(legs, minutes)] } for a leg-shardable label, k = 1 meaning the whole job; {} otherwise."""
    spec = table.get("leg_shards", {}).get(label)
    if not spec:
        return {}
    groups = runner_groups(repo, spec["groups"])
    if not groups:
        warn(f"{label}: cannot read its group list from {spec['groups']}; not sharded")
        return {}
    total = expected_minutes(table, label)
    setup = setup_minutes(table, label)
    fixed = float(spec.get("fixed_minutes", 0))
    w = spec.get("weights", {})
    known = [float(w[g]) for g in groups if g in w]
    mean = sum(known) / len(known) if known else 1.0
    weight = {g: float(w.get(g, mean)) for g in groups}
    wsum = sum(weight.values())
    body = max(0.0, total - setup - fixed)
    opts = {1: [("", total)]}
    for k, parts in sorted(spec.get("partitions", {}).items(), key=lambda kv: int(kv[0])):
        res = resolve_partition(parts, groups, spec.get("together", []))
        if res is None or len(res) != int(k):
            warn(f"{label}: partition {k} is not a disjoint cover of {','.join(groups)} "
                 f"(or splits {spec.get('together', [])}); not offered")
            continue
        opts[int(k)] = [(",".join(p), round(setup + fixed + body * sum(weight[g] for g in p) / wsum, 1)) for p in res]
    return opts


def makespan(durations, slots):
    """List scheduling of `durations` (in the given order) on `slots` parallel slots."""
    h = [0.0] * max(1, slots)
    for d in durations:
        heapq.heappush(h, heapq.heappop(h) + d)
    return max(h) if durations else 0.0


def sim(jobs, slots):
    return makespan(sorted((j["est"] for j in jobs), reverse=True), slots)


def expand(runs, run_groups=None, determinism=(), pure_shards=6, max_parallel=16, leg_shards="auto",
           table=None, repo=DEFAULT_REPO, warn=None, tier="full"):
    warn = warn or (lambda m: print(f"::warning::remote-matrix: {m}", file=sys.stderr))
    table = table if table is not None else json.load(open(DEFAULT_TABLE))
    rg = run_groups or {}
    det = list(determinism)
    jobs = []  # one per matrix entry, before leg shards: {"base": label, "entry": {...}, "est": m}
    for i in runs:
        gs = rg.get(i) or [""]
        if i == "windows":
            jobs.append({"base": i, "est": expected_minutes(table, i),
                         "entry": {"id": i, "shard": "", "legs": "", "label": i}})
        elif det:
            for g in gs:
                for k, r in enumerate(det, 1):
                    base = f"{i}{'@' + g if g else ''}"
                    jobs.append({"base": base, "est": expected_minutes(table, base),
                                 "entry": {"id": i, "shard": "", "group": g, "repeat": r, "legs": "",
                                           "label": f"{base}-det{k}x{r}"}})
        elif gs != [""]:
            for g in gs:
                base = f"{i}@{g}"
                jobs.append({"base": base, "est": expected_minutes(table, base),
                             "entry": {"id": i, "shard": "", "group": g, "legs": "", "label": base}})
        elif i == "pure" and pure_shards > 1:
            for k in range(1, pure_shards + 1):
                lab = f"pure-{k}of{pure_shards}"
                jobs.append({"base": lab, "est": expected_minutes(table, lab),
                             "entry": {"id": i, "shard": f"{k}/{pure_shards}", "legs": "", "label": lab}})
        else:
            jobs.append({"base": i, "est": expected_minutes(table, i),
                         "entry": {"id": i, "shard": "", "legs": "", "label": i}})
    # leg shards: grow k where it pays (auto), all the way (force), never (off, determinism)
    opts = {} if det or leg_shards == "off" or tier != "full" else {
        n: o for n, j in enumerate(jobs) for o in [shard_options(table, j["base"], repo, warn)] if len(o) > 1}
    choice = {n: 1 for n in opts}

    def with_choice(ch):
        out = []
        for n, j in enumerate(jobs):
            k = ch.get(n, 1)
            if k == 1:
                out.append(dict(j))
                continue
            for s, (legs, est) in enumerate(opts[n][k], 1):
                e = dict(j["entry"], legs=legs, label=f"{j['base']}-{s}of{k}")
                out.append({"base": j["base"], "est": est, "entry": e})
        return out

    if leg_shards == "force":
        choice = {n: max(o) for n, o in opts.items()}
    elif opts:
        # a global search, not greedy: several long poles only shorten the makespan together. For
        # each target T (every shard estimate seen), every job takes its smallest k whose longest
        # shard fits T; keep the choice with the shortest simulated makespan (ties: fewer job-min),
        # and only when it beats the unsharded matrix by more than GAIN_MIN.
        def score(ch):
            js = with_choice(ch)
            return (sim(js, max_parallel), sum(j["est"] for j in js))

        best = score(choice)
        base = best[0]
        targets = sorted({max(m for _, m in parts) for o in opts.values() for parts in o.values()})
        for t in targets:
            ch = {n: min([k for k, parts in o.items() if max(m for _, m in parts) <= t] or [max(o)])
                  for n, o in opts.items()}
            sc = score(ch)
            if sc[0] < base - GAIN_MIN and sc < best:
                best, choice = sc, ch
    final = with_choice(choice)
    # longest first; ties keep the plan's order (sorted() is stable)
    final.sort(key=lambda j: -j["est"])
    include, shards = [], {}
    for j in final:
        e = dict(j["entry"])
        e["watchdog"] = watchdog(table, j["est"], j["base"])
        e["est_min"] = j["est"]
        include.append(e)
        shards[e["id"]] = shards.get(e["id"], 0) + 1
    if "windows" in runs:
        shards["windows"] = shards.get("windows", 1) + 3
    shards = {i: n for i, n in shards.items() if n > 1}
    est = {"makespan_min": round(sim(final, max_parallel), 1), "job_minutes": round(sum(j["est"] for j in final), 1),
           "longest_min": round(max([j["est"] for j in final] + [0]), 1), "max_parallel": max_parallel,
           "leg_shards": {jobs[n]["base"]: k for n, k in choice.items()}}
    return {"include": include, "shards": shards, "max_parallel": max_parallel, "estimate": est}


# --------------------------------------------------------------------------------- --refresh

def refresh(table_path, run_ids):
    """Rewrite `minutes` (median job minutes per label) and `provenance` from finished runs (gh api)."""
    import statistics
    import subprocess
    from datetime import datetime

    def t(x):
        return datetime.fromisoformat(x.replace("Z", "+00:00"))

    seen = {}
    for rid in run_ids:
        out = subprocess.check_output(["gh", "api", "--paginate", f"repos/{{owner}}/{{repo}}/actions/runs/{rid}/jobs",
                                       "--jq", ".jobs[] | [.name, .conclusion, .started_at, .completed_at] | @tsv"], text=True)
        for line in out.splitlines():
            name, concl, s, c = line.split("\t")
            if concl not in ("success", "failure") or not c or name in ("plan", "merge", "cleanup", "determinism"):
                continue
            if re.search(r"-\d+of\d+$", name) and not name.startswith("pure-"):
                continue  # a leg shard's minutes are not its job's
            seen.setdefault(name, []).append((t(c) - t(s)).total_seconds() / 60)
    table = json.load(open(table_path))
    table["minutes"] = {k: round(statistics.median(v), 1) for k, v in sorted(seen.items())}
    table["provenance"]["runs"] = [int(r) for r in run_ids]
    table["provenance"]["jobs_seen"] = {k: len(v) for k, v in sorted(seen.items())}
    json.dump(table, open(table_path, "w"), indent=1)
    open(table_path, "a").write("\n")
    print(f"remote-matrix: {len(seen)} labels from runs {', '.join(run_ids)} -> {table_path}")


# --------------------------------------------------------------------------------- --self-test

def self_test():
    import tempfile
    fails = []

    def check(name, ok):
        print(("PASS " if ok else "FAIL ") + name)
        if not ok:
            fails.append(name)

    for det in ([], [3, 1]):
        win = expand(["windows"], determinism=det)
        check(f"windows: one build job and four expected shards, determinism={det}",
              len(win["include"]) == 1 and win["shards"] == {"windows": 4}
              and all(win["include"][0].get(k) == v for k, v in
                      {"id": "windows", "shard": "", "legs": "", "label": "windows"}.items())
              and "repeat" not in win["include"][0])
    real = json.load(open(DEFAULT_TABLE))
    warns = []
    w = warns.append
    # the real table against the real runners: every partition resolves, each together set stays
    for label, spec in real["leg_shards"].items():
        groups = runner_groups(DEFAULT_REPO, spec["groups"])
        check(f"{label}: the runner's group list is readable", bool(groups))
        o = shard_options(real, label, DEFAULT_REPO, w)
        check(f"{label}: every listed partition resolves", len(o) == 1 + len(spec["partitions"]))
        for k, parts in o.items():
            if k == 1:
                continue
            legs = [p.split(",") for p, _ in parts]
            check(f"{label} k={k}: the parts are a disjoint cover of the runner's groups",
                  sorted(g for p in legs for g in p) == sorted(groups))
            for t in spec.get("together", []):
                check(f"{label} k={k}: {'/'.join(t)} share a part",
                      all(len({g in p for g in t}) == 1 for p in legs))
            check(f"{label} k={k}: every shard is estimated shorter than the whole job",
                  all(m < o[1][0][1] for _, m in parts))
        check(f"{label}: the weights name only the runner's groups", set(spec.get("weights", {})) <= set(groups))
    check("the real table resolves without warnings", not warns)

    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "s"))
        open(os.path.join(d, "s", "run-x.sh"), "w").write("A=1\nGROUPS=(ga gb gc gd)\nLEGS=ga,gb,gc,gd\n")
        tab = {
            "minutes": {"long": 60, "mid": 20, "g7-x@g7-8": 40, "pure-1of2": 10, "pure-2of2": 10},
            "fallback_minutes": [["", 5], ["g7-", 18], ["native-", 11]],
            "setup_minutes": [["", 0.5], ["long", 10], ["g7-", 10]],
            "leg_shards": {"long": {"groups": {"from": "s/run-x.sh", "array": "GROUPS"}, "fixed_minutes": 2,
                                    "weights": {"ga": 3, "gb": 1, "gc": 1, "gd": 1},
                                    "together": [["gc", "gd"]],
                                    "partitions": {"2": [["ga"], ["*"]], "3": [["ga"], ["gb"], ["*"]],
                                                   "4": [["ga"], ["gb"], ["gc"], ["gd"]]}}},
        }
        ex = lambda runs, **kw: expand(runs, table=tab, repo=d, warn=w, **kw)
        warns.clear()
        r = ex(["mid", "long", "unknown", "native-rust-gate9"], max_parallel=10, leg_shards="off")
        labs = [e["label"] for e in r["include"]]
        check("off: longest first, unknown labels ordered by their prefix fallback",
              labs == ["long", "mid", "native-rust-gate9", "unknown"])
        check("off: no leg shards, no shard counts", all(e["legs"] == "" for e in r["include"]) and r["shards"] == {})
        check("watchdog: 2x expected validate minutes, clamped to [35, 60]",
              [e["watchdog"] for e in r["include"]] == ["60", "39", "35", "35"])
        r = ex(["long", "mid"], max_parallel=10)
        legs = sorted(e["legs"] for e in r["include"] if e["id"] == "long")
        check("auto with free slots: the long pole is sharded, k=2 (k=3 does not shorten the makespan: ga is the pole)",
              legs == ["ga", "gb,gc,gd"] and r["shards"] == {"long": 2})
        check("auto: shard labels are <label>-<k>of<n>",
              sorted(e["label"] for e in r["include"] if e["id"] == "long") == ["long-1of2", "long-2of2"])
        check("a partition splitting a together set warns and is not offered", any("partition 4" in x for x in warns))
        warns.clear()
        check("a shard is estimated setup + fixed + body x weight share",
              next(e["est_min"] for e in r["include"] if e["legs"] == "ga") == round(10 + 2 + 48 * 3 / 6, 1))
        busy = ["mid"] * 1 + [f"j{n}" for n in range(40)]
        tab["minutes"].update({f"j{n}": 30 for n in range(40)})
        r = ex(["long"] + busy, max_parallel=4)
        check("auto on a throughput-bound matrix: no leg shards (each costs a setup)",
              not any(e["legs"] for e in r["include"]) and r["include"][0]["label"] == "long")
        r = ex(["long"] + busy, max_parallel=4, leg_shards="force")
        check("force: the largest valid k regardless", r["shards"] == {"long": 3})
        r = ex(["long", "mid"], max_parallel=10, leg_shards="force", tier="smoke")
        check("the smoke tier never leg-shards, even forced", r["shards"] == {} and r["include"][0]["label"] == "long")
        r = ex(["g7-x", "pure"], run_groups={"g7-x": ["g7-0", "g7-8"]}, pure_shards=2, max_parallel=10)
        check("gate 7 groups and pure shards expand as before; unknown g7 group falls back to g7- minutes",
              [e["label"] for e in r["include"]] == ["g7-x@g7-8", "g7-x@g7-0", "pure-1of2", "pure-2of2"]
              and r["shards"] == {"g7-x": 2, "pure": 2}
              and r["include"][1]["group"] == "g7-0" and r["include"][2]["shard"] == "1/2")
        r = ex(["long", "pure"], determinism=[3, 1], pure_shards=2, max_parallel=10)
        check("determinism: one job per repeat count, never leg-sharded, pure not split",
              sorted(e["label"] for e in r["include"]) == ["long-det1x3", "long-det2x1", "pure-det1x3", "pure-det2x1"]
              and all(e["legs"] == "" for e in r["include"]) and r["shards"] == {"long": 2, "pure": 2})
        open(os.path.join(d, "s", "run-x.sh"), "w").write("nothing here\n")
        r = ex(["long", "mid"], max_parallel=10)
        check("an unreadable group list degrades to an unsharded job with a warning",
              [e["label"] for e in r["include"]] == ["long", "mid"] and any("cannot read" in x for x in warns))
        check("resolve_partition: '*' takes the rest in runner order",
              resolve_partition([["gc"], ["*"]], ["ga", "gb", "gc"], []) == [["gc"], ["ga", "gb"]])
        check("resolve_partition: an unknown or duplicated group is refused",
              resolve_partition([["gz"], ["*"]], ["ga"], []) is None
              and resolve_partition([["ga"], ["ga", "*"]], ["ga", "gb"], []) is None)
        check("resolve_partition: an empty part is refused", resolve_partition([["ga", "gb"], ["*"]], ["ga", "gb"], []) is None)
        check("makespan: list scheduling", makespan([5, 4, 3, 3], 2) == 8 and makespan([], 3) == 0)
    print(f"remote-matrix self-test: {'FAIL' if fails else 'PASS'} ({len(fails)} failing)")
    return 1 if fails else 0


def main(argv):
    a = {"--runs": "[]", "--run-groups": "{}", "--determinism": "", "--pure-shards": "6", "--max-parallel": "16",
         "--leg-shards": "auto", "--tier": "full", "--table": DEFAULT_TABLE, "--repo": DEFAULT_REPO, "--github-output": ""}
    flags, refresh_ids, it = set(), [], iter(argv)
    for x in it:
        if x in ("--self-test", "--explain"):
            flags.add(x)
        elif x == "--refresh":
            refresh_ids = [y for y in it]
        elif x in a:
            a[x] = next(it)
        else:
            sys.exit(f"remote-matrix: unknown argument {x}")
    if "--self-test" in flags:
        return self_test()
    if refresh_ids:
        refresh(a["--table"], refresh_ids)
        return 0
    if a["--leg-shards"] not in ("auto", "off", "force"):
        sys.exit(f"remote-matrix: --leg-shards wants auto, off or force, got {a['--leg-shards']}")
    r = expand(json.loads(a["--runs"]), json.loads(a["--run-groups"] or "{}"),
               [int(x) for x in a["--determinism"].split(",") if x.strip()], int(a["--pure-shards"]),
               int(a["--max-parallel"]), a["--leg-shards"], json.load(open(a["--table"])), a["--repo"], tier=a["--tier"])
    if a["--github-output"]:
        with open(a["--github-output"], "a") as f:
            f.write("matrix=" + json.dumps(r["include"]) + "\n")
            f.write("shards=" + json.dumps(r["shards"]) + "\n")
            f.write("max_parallel=" + str(r["max_parallel"]) + "\n")
    if "--explain" in flags:
        e = r["estimate"]
        print(f"remote-matrix: {len(r['include'])} jobs, {e['job_minutes']} job-min, est. makespan {e['makespan_min']} min "
              f"on {e['max_parallel']} slots, longest job {e['longest_min']} min"
              + (", leg shards " + ", ".join(f"{k} x{v}" for k, v in e["leg_shards"].items()) if e["leg_shards"] else ""))
        for x in r["include"]:
            print(f"  {x['est_min']:5.1f}  {x['label']}" + (f"  (--legs {x['legs']})" if x["legs"] else ""))
    elif not a["--github-output"]:
        json.dump(r, sys.stdout)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
