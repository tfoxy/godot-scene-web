#!/usr/bin/env python3
"""GRT tier verdict (scripts/validate-increment.sh): did a run that skipped legs by tier pass?

  tier-verdict.py --run DIR [--sabotage-skipped] [--smoke-legs a,b,...] [--runner-rc N] [--self-test]

A run under RS_SABOTAGE_TIER=skip / RS_SMOKE_LEGS / GATE7_SMOKE_LEGS (lib/legs.sh,
lib/gate7-web-legs.ts) leaves `skipped-by-tier.txt` in every leg directory it did not launch, and a
remote run under RS_SKIP_TIMING_GROUPS=1 (lib/legs.sh) leaves `skipped-remote.txt` in every leg of a
timing group; both mark a skipped leg the same way, the second is also listed as `skipped_remote`
(legs) and `skipped_remote_groups` in the verdict. So
the checker fails the checks that needed that evidence. The verdict reads every gating check in the
run's own result.json (any `{id, passed, detail}` object in it) and excuses a failing
check only when
  - the sabotage legs were skipped and its id names "sabotage", or
  - its id or detail names a skipped leg (the last path component of a skipped directory, after
    dropping receiver/host/capture/reference/evidence, as a word: '-' and '/' delimit).
Every other failing check is real, so an unexplained failure stays loud. Each `--smoke-legs`
entry must also name a directory that was launched (exists, no marker): a wrong or stale entry
fails the verdict instead of skipping everything. No checks found is a failure.

Typed `unavailable` rows (GRT4a): a failing check whose status is `unavailable` or
`device-unavailable` (desktop g7-lc's real-suspension rows: no device run) is evidence that does not
exist on this machine, not a failure. It is listed under `unavailable` and never makes the verdict
fail, and never passes it either: `--runner-rc N` (the runner's exit code, validate-increment.sh
passes it) with N != 0 needs the exit explained, so a run whose runner failed with every check
passing stays a failure, and N >= 2 (a usage error or refusal) always fails. A check is any
`{id, passed}` object, or an `{id, ok}` one (gate 7's harness checks).

Typed `known-flake` rows (SWO): a failing check its own checker typed `known-flake` -- a failure
the checker matched to a documented runner nondeterminism outside the product, under the condition
that names it (today only g7-8's web multimesh rows under the CI lavapipe allowance,
lib/gate7b-adapters.ts typeLavapipeParticleFlake) -- is listed under `known_flakes` and treated like
an unavailable row: it explains a runner exit 1 and never fails the verdict, never passes it either,
and never hides a real failure beside it. The checker types it only on evidence; this file only
trusts the type.

Prints a JSON verdict; exit 0 on pass.
"""
import json
import os
import re
import sys

NOT_FAILURES = ("not-run", "not-applicable", "skipped")
UNAVAILABLE = ("unavailable", "device-unavailable")
KNOWN_FLAKE = ("known-flake",)
GENERIC = ("receiver", "host", "capture", "reference", "evidence")


def walk_checks(node, out):
    if isinstance(node, dict):
        if "id" in node and "passed" in node and isinstance(node["id"], str):
            out.append(node)
        elif "id" in node and isinstance(node.get("ok"), bool) and isinstance(node["id"], str):
            out.append({**node, "passed": node["ok"]})  # gate 7's harness checks
        else:
            for v in node.values():
                walk_checks(v, out)
    elif isinstance(node, list):
        for v in node:
            walk_checks(v, out)


def verdict(run, sabotage_skipped, smoke_legs, runner_rc=None):
    marked, launched = [], set()
    remote_marked, remote_groups = [], set()
    for root, dirs, files in os.walk(run):
        rel = os.path.relpath(root, run)
        if "skipped-by-tier.txt" in files or "skipped-remote.txt" in files:
            marked.append(rel)
            dirs[:] = []
            if "skipped-remote.txt" in files:
                remote_marked.append(rel)
                m = re.search(r"timing group ([A-Za-z0-9_-]+)", open(os.path.join(root, "skipped-remote.txt")).read())
                if m:
                    remote_groups.add(m.group(1))
    # a launched leg: any directory holding evidence that is not under a marked one
    for root, dirs, files in os.walk(run):
        rel = os.path.relpath(root, run)
        if any(rel == m or rel.startswith(m + os.sep) for m in marked):
            dirs[:] = []
            continue
        if files:
            launched.add(rel)
    tokens = set(remote_groups)
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
    excused, real, unavailable, flakes = [], [], [], []
    for c in failing:
        text = f"{c['id']} {c.get('detail', '')} {json.dumps(c.get('failures', ''))}"
        if remote_groups:
            # a check that is ABOUT a group skipped by RS_SKIP_TIMING_GROUPS names that group (or
            # a skipped leg) in its criterion: "on every g55f leg, ..."
            text += f" {c.get('criterion', '')}"
        if str(c.get("status", "")) in UNAVAILABLE:
            unavailable.append(c["id"])
        elif str(c.get("status", "")) in KNOWN_FLAKE:
            flakes.append(c["id"])
        elif sabotage_skipped and re.search(r"sabotage|catches|caught", c["id"]):
            # a "...-catches-..." / "...-caught" check judges a sabotage leg (its id need not say so)
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
    runner = None
    if runner_rc is not None and runner_rc != 0:
        if runner_rc >= 2:
            ok, runner = False, f"the runner exited {runner_rc} (a usage error or refusal)"
        elif not (excused or unavailable or flakes or real or missing):
            ok, runner = False, "the runner exited 1 but no check explains it"
    out = {"verdict": "pass" if ok else "fail", "checks": len(checks), "skipped_dirs": len(marked),
           "skipped_by_tier": sorted(set(excused)), "unavailable": sorted(set(unavailable)),
           "known_flakes": sorted(set(flakes)), "failing": sorted(set(real)), "smoke_legs_not_run": missing,
           "skipped_remote": sorted(remote_marked), "skipped_remote_groups": sorted(remote_groups)}
    if runner_rc is not None:
        out["runner_rc"] = runner_rc
    if runner:
        out["runner_unexplained"] = runner
    return out


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
            got = verdict(d, kw.get("sab", False), kw.get("smoke", ""), kw.get("rc"))["verdict"]
        print(("PASS " if got == want else "FAIL ") + name)
        fails += got != want

    res = lambda *cs: json.dumps({"checks": [{"id": i, "passed": p, "detail": d} for i, p, d in cs]})
    case("sabotage checks are excused only when sabotage was skipped",
         {"result.json": res(("a", True, ""), ("leg-class-sabotage-x", False, "no recording")),
          "live/applied.json": "{}"}, "pass", sab=True)
    case("a catches/caught check is excused when sabotage was skipped, real otherwise",
         {"result.json": res(("a", True, ""), ("coding-drop-base-caught", False, "no viewer report")),
          "live/applied.json": "{}"}, "pass", sab=True)
    case("a failing caught check is real when sabotage was not skipped",
         {"result.json": res(("coding-drop-base-caught", False, "x")), "live/applied.json": "{}"}, "fail")
    case("a failing sabotage check is real when sabotage was not skipped",
         {"result.json": res(("leg-class-sabotage-x", False, "x")), "live/applied.json": "{}"}, "fail")
    case("a check naming a skipped leg is excused",
         {"result.json": res(("a", True, ""), ("live-handshake", False, "live-stall: no connection")),
          "live/applied.json": "{}", "live-stall/skipped-by-tier.txt": "x"}, "pass")
    mark = "skipped-remote: RS_SKIP_TIMING_GROUPS=1 (timing group g1d: wall-clock legs stay local)"
    case("a check naming a leg skipped by RS_SKIP_TIMING_GROUPS is excused",
         {"result.json": res(("a", True, ""), ("live-handshake", False, "live-stall: no connection")),
          "live/applied.json": "{}", "live-stall/host/skipped-remote.txt": mark}, "pass")
    with tempfile.TemporaryDirectory() as d:
        mk(d, {"result.json": json.dumps({"checks": [
                   {"id": "warm-host-no-gets", "passed": False, "criterion": "on every g1d leg, the warm host is quiet", "detail": "0 GETs"},
                   {"id": "pixels", "passed": False, "criterion": "every shot equals the reference", "detail": "differs"}]}),
               "ok/a.json": "{}", "live-stall/skipped-remote.txt": mark})
        v = verdict(d, False, "", 1)
    okc = v["failing"] == ["pixels"] and v["skipped_by_tier"] == ["warm-host-no-gets"]
    print(("PASS " if okc else "FAIL ") + "a check whose criterion names the skipped timing group is excused, a bare one is not")
    fails += not okc
    case("an unexplained failure stays real beside a skipped-remote leg",
         {"result.json": res(("a", False, "pixels differ")), "live/applied.json": "{}",
          "live-stall/host/skipped-remote.txt": mark}, "fail")
    with tempfile.TemporaryDirectory() as d:
        mk(d, {"result.json": res(("a", True, ""), ("x", False, "live-stall missing")), "live/applied.json": "{}",
               "live-stall/host/skipped-remote.txt": mark, "live-reconnect/skipped-by-tier.txt": "x"})
        v = verdict(d, False, "")
    okr = v["skipped_remote"] == ["live-stall/host"] and v["skipped_remote_groups"] == ["g1d"] and v["skipped_dirs"] == 2
    print(("PASS " if okr else "FAIL ") + "skipped_remote lists only the remote-skipped legs and their groups")
    fails += not okr
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
    # GRT4a: typed unavailable rows (desktop g7-lc's real-suspension rows) are reported, not failed.
    unav = lambda i: {"id": i, "passed": False, "status": "unavailable", "gating": True, "detail": "no device run"}
    rows = lambda *cs: json.dumps({"gate_passed": False, "results": [{"checks": list(cs)}]})
    case("only typed unavailable rows: the run passes (runner rc 1 explained)",
         {"result.json": rows({"id": "a", "passed": True}, unav("real-suspension@gsw-device:hidden-2s")),
          "gate6/x.json": "{}"}, "pass", rc=1)
    case("unavailable rows do not hide a real failure",
         {"result.json": rows(unav("u"), {"id": "b", "passed": False, "detail": "pixels"}), "x/a.json": "{}"},
         "fail", rc=1)
    case("runner rc 1 with every check passing stays a failure",
         {"result.json": rows({"id": "a", "passed": True}), "x/a.json": "{}"}, "fail", rc=1)
    case("runner rc 2 (refusal) always fails", {"result.json": rows(unav("u")), "x/a.json": "{}"}, "fail", rc=2)
    case("a failing gate 7 harness check ({id, ok}) is real",
         {"result.json": json.dumps({"harness": {"checks": [{"id": "h", "ok": False, "detail": "x"}]},
                                     "results": [{"checks": [unav("u")]}]}), "x/a.json": "{}"}, "fail", rc=1)
    with tempfile.TemporaryDirectory() as d:
        mk(d, {"result.json": rows({"id": "a", "passed": True}, unav("u1"), unav("u2")), "x/a.json": "{}"})
        v = verdict(d, False, "", 1)
    ok = v["unavailable"] == ["u1", "u2"] and not v["failing"]
    print(("PASS " if ok else "FAIL ") + "the verdict still lists every unavailable row")
    fails += not ok
    # SWO: typed known-flake rows (g7-8's web particle rows under the CI lavapipe allowance).
    flake = lambda i: {"id": i, "passed": False, "status": "known-flake", "gating": True, "detail": "lavapipe"}
    case("only typed known-flake rows: the run passes (runner rc 1 explained)",
         {"result.json": rows({"id": "a", "passed": True}, flake("mm-reference@web")), "x/a.json": "{}"},
         "pass", rc=1)
    case("known-flake rows do not hide a real failure",
         {"result.json": rows(flake("mm-reference@web"), {"id": "b", "passed": False, "detail": "x"}),
          "x/a.json": "{}"}, "fail", rc=1)
    case("an untyped failing row with the same id stays real",
         {"result.json": rows({"id": "mm-reference@web", "passed": False, "detail": "C_FLIP"}), "x/a.json": "{}"},
         "fail", rc=1)
    with tempfile.TemporaryDirectory() as d:
        mk(d, {"result.json": rows(flake("f1"), unav("u1")), "x/a.json": "{}"})
        v = verdict(d, False, "", 1)
    ok = v["known_flakes"] == ["f1"] and v["unavailable"] == ["u1"] and not v["failing"]
    print(("PASS " if ok else "FAIL ") + "the verdict lists known flakes apart from unavailable rows")
    fails += not ok
    print("tier-verdict self-test: " + ("all pass" if not fails else f"{fails} FAIL"))
    return fails == 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if "--self-test" in a:
        sys.exit(0 if self_test() else 1)
    run = a[a.index("--run") + 1]
    smoke = a[a.index("--smoke-legs") + 1] if "--smoke-legs" in a else ""
    rc = int(a[a.index("--runner-rc") + 1]) if "--runner-rc" in a else None
    v = verdict(run, "--sabotage-skipped" in a, smoke, rc)
    print(json.dumps(v, indent=2))
    sys.exit(0 if v["verdict"] == "pass" else 1)
