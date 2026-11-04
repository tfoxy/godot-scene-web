#!/usr/bin/env python3
"""Check-id census: which checks a run's own verdict holds, so a sharded run can be shown to judge the
same checks as the unsharded one (docs/remote-compute.md "Scheduling and leg shards").

  check-census.py --job RUNDIR --id ID --label LABEL [--group G] [--legs a,b] --out FILE
      the checks of RUNDIR/result.json (the run's own verdict; tier-verdict.py's walk_checks rule:
      every {id, passed} object, gate 7's {id, ok} harness rows too) -> FILE
  check-census.py --merge --out FILE JOBFILE...
      per run id (<id>@<group> for one gate 7 group's jobs): the union of its jobs' check ids, which ids failed in some job, and the jobs
  check-census.py --compare A B [--id ID]
      A, B: a census (merged or per job; --id picks a run, or <id>@<group>, of a merged one), a result.json or a run
      dir holding one. Prints the ids only in A and only in B; exit 1 when the sets differ.
  check-census.py --self-test
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("tier_verdict", os.path.join(HERE, "tier-verdict.py"))
_tv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tv)
walk_checks = _tv.walk_checks


def result_checks(path):
    if os.path.isdir(path):
        path = os.path.join(path, "result.json")
    out = []
    walk_checks(json.load(open(path)), out)
    return out


def job_census(run, rid, label, legs, group=""):
    try:
        checks = result_checks(run)
        err = None
    except (OSError, ValueError) as e:
        checks, err = [], f"{type(e).__name__}: {e}"
    return {"schema": "render-stream-check-census/1", "id": rid, "group": group, "label": label, "legs": legs,
            "result": err or "ok", "n_checks": len(checks),
            "ids": sorted({c["id"] for c in checks}),
            "failing": sorted({c["id"] for c in checks if c.get("passed") is not True and c.get("gating") is not False})}


def merge(files):
    runs = {}
    for f in files:
        try:
            j = json.load(open(f))
        except (OSError, ValueError):
            continue
        key = j["id"] + (f"@{j['group']}" if j.get("group") else "")
        r = runs.setdefault(key, {"ids": set(), "failing": set(), "jobs": []})
        r["ids"] |= set(j["ids"])
        r["failing"] |= set(j["failing"])
        r["jobs"].append({k: j[k] for k in ("label", "legs", "result", "n_checks")})
    return {"schema": "render-stream-check-census/1", "merged": True,
            "runs": {i: {"ids": sorted(r["ids"]), "failing": sorted(r["failing"]),
                         "jobs": sorted(r["jobs"], key=lambda x: x["label"])} for i, r in sorted(runs.items())}}


def id_set(path, rid):
    if os.path.isdir(path) or path.endswith("result.json"):
        return {c["id"] for c in result_checks(path)}
    j = json.load(open(path))
    if j.get("merged"):
        if rid is None:
            if len(j["runs"]) != 1:
                sys.exit(f"check-census: {path} holds runs {', '.join(j['runs'])}: pass --id")
            rid = next(iter(j["runs"]))
        return set(j["runs"][rid]["ids"])
    if "ids" in j:
        return set(j["ids"])
    return {c["id"] for c in result_checks(path)}


def compare(a, b, rid):
    sa, sb = id_set(a, rid), id_set(b, rid)
    only_a, only_b = sorted(sa - sb), sorted(sb - sa)
    print(f"check-census: A {len(sa)} ids, B {len(sb)} ids, common {len(sa & sb)}")
    for x in only_a:
        print(f"  only in A: {x}")
    for x in only_b:
        print(f"  only in B: {x}")
    print("check-census: " + ("EQUAL" if not only_a and not only_b else "DIFFERENT"))
    return 0 if not only_a and not only_b else 1


def self_test():
    import tempfile
    fails = []

    def check(name, ok):
        print(("PASS " if ok else "FAIL ") + name)
        if not ok:
            fails.append(name)

    with tempfile.TemporaryDirectory() as d:
        def run(name, doc):
            p = os.path.join(d, name)
            os.makedirs(p)
            json.dump(doc, open(os.path.join(p, "result.json"), "w"))
            return p
        full = run("full", {"checks": [{"id": "a", "passed": True}, {"id": "b", "passed": False},
                                       {"id": "c", "passed": True, "gating": False}],
                            "results": {"g7-8": {"checks": [{"id": "g7", "ok": True}]}}})
        s1 = run("s1", {"checks": [{"id": "a", "passed": True}], "results": {"x": [{"id": "g7", "ok": True}]}})
        s2 = run("s2", {"checks": [{"id": "b", "passed": False}, {"id": "c", "passed": True, "gating": False}],
                        "results": {"x": [{"id": "g7", "ok": True}]}})
        j1 = job_census(s1, "r", "r-1of2", "ga")
        j2 = job_census(s2, "r", "r-2of2", "gb")
        jm = job_census(os.path.join(d, "missing"), "r", "r-3of3", "gc")
        check("a job census lists its checks (the {id, ok} rows too)", j1["ids"] == ["a", "g7"] and j1["result"] == "ok")
        check("a job census lists its gating failures", j2["failing"] == ["b"])
        check("a missing result.json is recorded, not an exception", jm["result"].startswith("FileNotFoundError") and jm["ids"] == [])
        for n, j in (("1", j1), ("2", j2)):
            json.dump(j, open(os.path.join(d, f"c{n}.json"), "w"))
        m = merge([os.path.join(d, "c1.json"), os.path.join(d, "c2.json"), os.path.join(d, "nope.json")])
        json.dump(m, open(os.path.join(d, "m.json"), "w"))
        check("merge: the union per run id, the jobs listed", m["runs"]["r"]["ids"] == ["a", "b", "c", "g7"]
              and [x["label"] for x in m["runs"]["r"]["jobs"]] == ["r-1of2", "r-2of2"])
        check("compare: the shards' union equals the whole run", compare(os.path.join(d, "m.json"), full, None) == 0)
        check("compare: a lost check is reported", compare(os.path.join(d, "c1.json"), full, None) == 1)
        json.dump(job_census(s1, "g7-x", "g7-x@g7-8-1of2", "ga", "g7-8"), open(os.path.join(d, "g1.json"), "w"))
        json.dump(job_census(s2, "g7-x", "g7-x@g7-0", "", "g7-0"), open(os.path.join(d, "g2.json"), "w"))
        mg = merge([os.path.join(d, "g1.json"), os.path.join(d, "g2.json")])
        check("merge: one gate 7 group's jobs are keyed <id>@<group>", sorted(mg["runs"]) == ["g7-x@g7-0", "g7-x@g7-8"])
    print(f"check-census self-test: {'FAIL' if fails else 'PASS'} ({len(fails)} failing)")
    return 1 if fails else 0


def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    a, rest, it = {}, [], iter(argv)
    for x in it:
        if x in ("--job", "--id", "--label", "--group", "--legs", "--out"):
            a[x] = next(it)
        elif x in ("--merge", "--compare"):
            a[x] = True
        else:
            rest.append(x)
    if "--job" in a:
        json.dump(job_census(a["--job"], a["--id"], a["--label"], a.get("--legs", ""), a.get("--group", "")),
                  open(a["--out"], "w"), indent=1)
        return 0
    if a.get("--merge"):
        json.dump(merge(rest), open(a["--out"], "w"), indent=1)
        return 0
    if a.get("--compare") and len(rest) == 2:
        return compare(rest[0], rest[1], a.get("--id"))
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
