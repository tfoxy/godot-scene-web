#!/usr/bin/env python3
"""GRT tier verdict (scripts/validate-increment.sh): did a run that skipped legs by tier pass?

  tier-verdict.py --run DIR [--sabotage-skipped] [--smoke-legs a,b,...] [--self-test]

A run under RS_SABOTAGE_TIER=skip / RS_SMOKE_LEGS / GATE7_SMOKE_LEGS (lib/legs.sh,
lib/gate7-web-legs.ts) leaves `skipped-by-tier.txt` in every leg directory it did not launch, so
the checker fails the checks that needed that evidence. The verdict reads every gating check in the
run's own result.json (any `{id, passed, detail}` object in it) and excuses a failing
check only when
  - the sabotage legs were skipped and its id names "sabotage", or
  - its id or detail names a skipped leg (the last path component of a skipped directory, after
    dropping receiver/host/capture/reference/evidence, as a word: '-' and '/' delimit).
Every other failing check is real, so an unexplained failure stays loud. Each `--smoke-legs`
entry must also name a directory that was launched (exists, no marker): a wrong or stale entry
fails the verdict instead of skipping everything. No checks found is a failure.

Prints a JSON verdict; exit 0 on pass.
"""
import json
import os
import re
import sys

NOT_FAILURES = ("not-run", "not-applicable", "skipped")
GENERIC = ("receiver", "host", "capture", "reference", "evidence")


def walk_checks(node, out):
    if isinstance(node, dict):
        if "id" in node and "passed" in node and isinstance(node["id"], str):
            out.append(node)
        else:
            for v in node.values():
                walk_checks(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_checks(v, out)


def verdict(run, sabotage_skipped, smoke_legs):
    marked, launched = [], set()
    for root, dirs, files in os.walk(run):
        rel = os.path.relpath(root, run)
        if "skipped-by-tier.txt" in files:
            marked.append(rel)
            dirs[:] = []
    # a launched leg: any directory holding evidence that is not under a marked one
    for root, dirs, files in os.walk(run):
        rel = os.path.relpath(root, run)
        if any(rel == m or rel.startswith(m + os.sep) for m in marked):
            dirs[:] = []
            continue
        if files:
            launched.add(rel)
    tokens = set()
    for m in marked:
        comps = [c for c in m.split(os.sep) if c != "."]
        while len(comps) > 1 and comps[-1] in GENERIC:
            comps.pop()  # "sabotage-omit/receiver" names the leg sabotage-omit
        if comps and len(comps[-1]) >= 4:
            tokens.add(comps[-1])
    # Only the run's own result.json is the verdict: nested result.json files are views and
    # per-leg sub-results the gate's checker already folded in (or excused).
    checks = []
    try:
        walk_checks(json.load(open(os.path.join(run, "result.json"))), checks)
    except (OSError, ValueError):
        pass
    failing = [c for c in checks if c.get("passed") is not True and c.get("gating") is not False
               and str(c.get("status", "")) not in NOT_FAILURES]
    excused, real = [], []
    for c in failing:
        text = f"{c['id']} {c.get('detail', '')} {json.dumps(c.get('failures', ''))}"
        if sabotage_skipped and "sabotage" in c["id"]:
            excused.append(c["id"])
        elif any(re.search(r"(?<![A-Za-z0-9])" + re.escape(t) + r"(?![A-Za-z0-9])", text) for t in tokens):
            excused.append(c["id"])
        else:
            real.append(c["id"])
    missing = []
    for e in [x for x in smoke_legs.split(",") if x and not x.startswith("@")]:
        ok = any((os.sep + e + os.sep) in (os.sep + r + os.sep) for r in launched)
        if not ok:
            missing.append(e)
    ok = bool(checks) and not real and not missing
    return {"verdict": "pass" if ok else "fail", "checks": len(checks), "skipped_dirs": len(marked),
            "skipped_by_tier": sorted(set(excused)), "failing": sorted(set(real)),
            "smoke_legs_not_run": missing}


def self_test():
    import tempfile
    fails = 0

    def mk(root, files):
        for rel, content in files.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").write(content)

    def case(name, files, want, **kw):
        nonlocal fails
        with tempfile.TemporaryDirectory() as d:
            mk(d, files)
            got = verdict(d, kw.get("sab", False), kw.get("smoke", ""))["verdict"]
        print(("PASS " if got == want else "FAIL ") + name)
        fails += got != want

    res = lambda *cs: json.dumps({"checks": [{"id": i, "passed": p, "detail": d} for i, p, d in cs]})
    case("sabotage checks are excused only when sabotage was skipped",
         {"result.json": res(("a", True, ""), ("leg-class-sabotage-x", False, "no recording")),
          "live/applied.json": "{}"}, "pass", sab=True)
    case("a failing sabotage check is real when sabotage was not skipped",
         {"result.json": res(("leg-class-sabotage-x", False, "x")), "live/applied.json": "{}"}, "fail")
    case("a check naming a skipped leg is excused",
         {"result.json": res(("a", True, ""), ("live-handshake", False, "live-stall: no connection")),
          "live/applied.json": "{}", "live-stall/skipped-by-tier.txt": "x"}, "pass")
    case("an unexplained failure stays real",
         {"result.json": res(("a", False, "pixels differ")), "live/applied.json": "{}",
          "live-stall/skipped-by-tier.txt": "x"}, "fail")
    case("only the last component of a skipped leg is its token (mesh/live-mesh-warm skipped, mesh kept)",
         {"result.json": res(("a", False, "mesh mismatch")), "mesh/live-mesh/applied.json": "{}",
          "mesh/live-mesh-warm/skipped-by-tier.txt": "x"}, "fail")
    case("a smoke entry that never ran fails the verdict",
         {"result.json": res(("a", True, "")), "live/skipped-by-tier.txt": "x", "other/a.json": "{}"},
         "fail", smoke="live")
    case("no checks at all is a failure", {"live/applied.json": "{}"}, "fail")
    print("tier-verdict self-test: " + ("all pass" if not fails else f"{fails} FAIL"))
    return fails == 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if "--self-test" in a:
        sys.exit(0 if self_test() else 1)
    run = a[a.index("--run") + 1]
    smoke = a[a.index("--smoke-legs") + 1] if "--smoke-legs" in a else ""
    v = verdict(run, "--sabotage-skipped" in a, smoke)
    print(json.dumps(v, indent=2))
    sys.exit(0 if v["verdict"] == "pass" else 1)
