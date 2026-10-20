#!/usr/bin/env python3
"""GRT smoke tier planner (scripts/validate-increment.sh, results/grt.md): changed paths in, the
validation targets they can reach out, from scripts/smoke-map.json.

  smoke-plan.py --map smoke-map.json --repo ROOT [--milestone] [--paths-from FILE | PATH...]
  smoke-plan.py --self-test --map smoke-map.json

Prints a plan (JSON): every changed path with the rules it matched (or `unmatched`, which reaches
everything), the expanded target set, whether sabotage legs run and why, and the runner
invocations (`runs`) validate-increment.sh executes in order.
"""
import json
import os
import re
import sys


def glob_re(glob):
    out, i = "", 0
    while i < len(glob):
        c = glob[i]
        if glob.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif glob.startswith("**", i):
            out += ".*"
            i += 2
        elif c == "*":
            out += "[^/]*"
            i += 1
        elif c == "?":
            out += "[^/]"
            i += 1
        elif c == "[":
            j = glob.index("]", i)
            out += glob[i:j + 1]
            i = j + 1
        else:
            out += re.escape(c)
            i += 1
    return re.compile("^" + out + "$")


def universe(m):
    u = m["universe"]
    t = set(u["other"])
    for g in u["native"]:
        if g == "gate-minus1":
            t.add("native:gate-minus1@rust")  # gate -1 has no receiver core: one target
        else:
            for c in u["cores"]:
                t.add(f"native:{g}@{c}")
    for g in u["g7"]:
        for r in u["g7_receivers"]:
            t.add(f"g7:{g}@{r}")
    for g in u["g7live"]:
        for r in u["g7live_receivers"]:
            if (g == "g7-r") != (r == "native") and g != "g7-lc":
                continue
            t.add(f"g7live:{g}@{r}")
    for g in u["g7x"]:
        t.add(f"g7x:{g}")
    for c in u["cargo"]:
        t.add(f"cargo:{c}")
    return t


def expand(pattern, uni):
    if pattern == "*":
        return set(uni)
    if pattern == "none":
        return set()
    if pattern == "native:gate-minus1@*":
        pattern = "native:gate-minus1@rust"
    rx = glob_re(pattern.replace("/", "\x00")) if "*" in pattern else None
    if rx is None:
        return {pattern} & uni if pattern in uni else {pattern}
    return {t for t in uni if rx.match(t.replace("/", "\x00"))}


def plan(m, paths, repo, milestone=False, tier="smoke"):
    uni = universe(m)
    rules = [(r, [glob_re(p) for p in r["paths"]]) for r in m["rules"]]
    sab_paths = [glob_re(p) for p in m["sabotage_paths"]]
    sab_content = re.compile(m["sabotage_content"])
    targets = {"pure"}
    per_path = []
    sabotage_why = []
    for p in paths:
        matched = []
        reach = set()
        for r, rxs in rules:
            if any(rx.match(p) for rx in rxs):
                matched.append(r["why"])
                for pat in r["reach"]:
                    reach |= expand(pat, uni)
                if r.get("exclusive"):
                    break
        if not matched:
            reach = set(uni)
        targets |= reach
        per_path.append({"path": p, "rules": matched or ["unmatched: reaches every target"],
                         "targets": len(reach)})
        if any(rx.match(p) for rx in sab_paths):
            sabotage_why.append(f"{p}: a checker/runner/sabotage path")
        elif not (matched and all(r.startswith("docs") for r in matched)):
            f = os.path.join(repo, p)
            try:
                if os.path.isfile(f) and os.path.getsize(f) < 32 * 1024 * 1024:
                    with open(f, "rb") as fh:
                        if sab_content.search(fh.read().decode("utf8", "replace")):
                            sabotage_why.append(f"{p}: its content names a sabotage/mutation")
            except OSError:
                pass
            if not matched and not os.path.exists(f):
                pass
    if milestone:
        targets = set(uni)
        sabotage_why = ["--milestone: a sweep runs every leg"]
    return {
        "schema": "render-stream-smoke-plan/1",
        "milestone": milestone,
        "tier": "full" if milestone else tier,
        "paths": per_path,
        "unmatched": [x["path"] for x in per_path if x["rules"][0].startswith("unmatched")],
        "targets": sorted(targets),
        "sabotage": {"run": bool(sabotage_why), "why": sabotage_why},
        "runs": runs(targets, m, bool(sabotage_why), "full" if milestone else tier),
        "skipped_targets": sorted(uni - targets),
        "smoke_deferred": list(DEFERRED),
    }


DEFERRED = []


def runs(targets, m, sabotage, tier="smoke"):
    """The runner invocations, in order: lock/pure/builds, then native gates (whose full runs feed
    the source cache), then gate 7's file groups, live groups and desktop extras."""
    u = m["universe"]
    out = []
    order = ["gate-minus1"] + [g for g in u["native"] if g != "gate-minus1"]
    if "lock-tests" in targets:
        out.append({"id": "lock-tests", "kind": "lock-tests"})
    out.append({"id": "pure", "kind": "pure"})
    if "capture-build" in targets:
        out.append({"id": "capture-build", "kind": "capture-build"})
    for c in u["cargo"]:
        if f"cargo:{c}" in targets:
            out.append({"id": f"cargo-{os.path.basename(c)}", "kind": "cargo", "crate": c})
    if "pnpm-test" in targets:
        out.append({"id": "pnpm-test", "kind": "pnpm-test"})
    for core in u["cores"]:
        gates = [g for g in order if f"native:{g}@{core}" in targets]
        for g in gates:
            if g == "gate-minus1" and core != "rust":
                continue
            out.append({"id": f"native-{core}-{g}", "kind": "native", "gate": g, "core": core,
                        "sabotage": sabotage})
    sm = m.get("smoke", {})
    collapse = sm.get("collapse_at", 3)
    deferred = []
    collapsed = False
    for r in u["g7_receivers"]:
        groups = [g for g in u["g7"] if f"g7:{g}@{r}" in targets]
        if not groups:
            continue
        if tier == "smoke" and sm.get("g7") and len(groups) >= collapse:
            # a change reaching most groups is shared code: the first group stands for the rest
            deferred += [f"g7:{g}@{r}" for g in groups[1:]]
            groups = groups[:1]
            collapsed = True
        run = {"id": f"g7-{r.replace('/', '-')}", "kind": "g7", "receiver": r, "groups": groups}
        if tier == "smoke" and sm.get("g7"):
            run["gate7_smoke_legs"] = ",".join(sm["g7"]["legs"])
            run["smoke_legs"] = {g: 1 for g in groups}
        out.append(run)
    for r in u["g7live_receivers"]:
        groups = [g for g in u["g7live"] if f"g7live:{g}@{r}" in targets]
        if not groups:
            continue
        rid = f"g7live-{r.replace('/', '-')}"
        table = sm.get("g7live", {})
        if tier == "smoke" and sum(1 for g in groups if g in table) >= collapse:
            first = next(g for g in groups if g in table)
            deferred += [f"g7live:{g}@{r}" for g in groups if g != first]
            groups = [first]
            collapsed = True
        elif tier == "smoke" and collapsed and not any(g in table for g in groups):
            deferred += [f"g7live:{g}@{r}" for g in groups]  # no smoke leg of its own
            continue
        keep = [g for g in groups if tier == "smoke" and g in table]
        rest = [g for g in groups if g not in keep]
        if rest:
            out.append({"id": rid, "kind": "g7live", "receiver": r, "groups": rest})
        for g in keep:  # one run per group: the filter is per native runner
            e = table[g]
            out.append({"id": f"{rid}-{g}", "kind": "g7live", "receiver": r, "groups": [g],
                        "rs_smoke_legs": ",".join(e["legs"]), "smoke_legs": {g: len(e["legs"])},
                        "full_legs": e.get("full_legs")})
    x = [g for g in u["g7x"] if f"g7x:{g}" in targets]
    if x and tier == "smoke" and collapsed:
        deferred += [f"g7x:{g}" for g in x]
        x = []
    DEFERRED[:] = deferred
    if x:
        out.append({"id": "g7x", "kind": "g7x", "groups": x})
    return out


def self_test(m):
    fails = 0

    def check(name, ok):
        nonlocal fails
        print(("PASS " if ok else "FAIL ") + name)
        fails += 0 if ok else 1

    repo = "/nonexistent"
    uni = universe(m)
    P = lambda *ps, ms=False: plan(m, list(ps), repo, ms)
    a = P("experiments/render-stream/results/grt.md")
    check("a doc reaches nothing but the pure self-tests", a["targets"] == ["pure"])
    b = P("experiments/render-stream/some/new/thing.xyz")
    check("an unknown path reaches every target", set(b["targets"]) == uni and b["unmatched"])
    c = P("experiments/render-stream/scripts/lib/quiet.sh")
    check("the lock reaches its own tests only", set(c["targets"]) == {"pure", "lock-tests"})
    d = P("experiments/render-stream/rs-core/src/decode.rs")
    nat = {t for t in d["targets"] if t.startswith("native:")}
    check("rs-core reaches native gates on the rust core only",
          nat and all(t.endswith("@rust") for t in nat) and "native:gate0@rust" in nat)
    check("rs-core reaches gsw and the web rust core, not the web gdscript core",
          "g7:g7-3@gsw" in d["targets"] and "g7:g7-3@web/rust" in d["targets"]
          and not any(t.endswith("@web/gdscript") for t in d["targets"]))
    e = P("experiments/render-stream/scripts/lib/gate3-checks.ts")
    check("a gate 3 checker reaches gate 3 only (both cores, every g7-3 receiver)",
          {t for t in e["targets"] if t.startswith("native:")} == {"native:gate3@rust", "native:gate3@gdscript"}
          and "g7:g7-3@gsw" in e["targets"] and "g7:g7-2@gsw" not in e["targets"])
    check("a checker in the diff runs the sabotage legs", e["sabotage"]["run"])
    check("rs-core without sabotage content skips the sabotage legs", not d["sabotage"]["run"])
    f = P("experiments/render-stream/capture/src/hooks.cpp")
    check("the capture library reaches everything", set(f["targets"]) == uni)
    g = P("experiments/render-stream/scripts/lib/gate5-checks.ts")
    check("gate5-* does not reach gate 5.5", "native:gate55@rust" not in g["targets"])
    h = P("experiments/render-stream/scripts/lib/gate55d-checks.ts")
    check("gate55* does not reach gate 5", "native:gate5@rust" not in h["targets"] and "native:gate55@rust" in h["targets"])
    i = P("experiments/render-stream/receiver/README.md")
    check("a .md under the receiver is still a doc (exclusive rule)", i["targets"] == ["pure"])
    j = P("experiments/render-stream/web/gsw-receiver/main.ts")
    check("the GSW page reaches gsw only", j["targets"] and all(
        t in ("pure", "cargo:experiments/render-stream/web/gsw-rs", "g7x:g7-dev", "g7x:g7-bench") or t.endswith("@gsw")
        for t in j["targets"]))
    k = P("experiments/render-stream/results/grt.md", ms=True)
    check("--milestone runs everything with sabotage", set(k["targets"]) == uni and k["sabotage"]["run"])
    kinds = [r["kind"] for r in f["runs"]]
    check("runs: native before g7 (sources first)", kinds.index("native") < kinds.index("g7"))
    check("every universe target is reachable by '*'", expand("*", uni) == uni)
    live = P("experiments/render-stream/scripts/lib/gate1-live.ts")
    sl = [r for r in live["runs"] if r["kind"] == "g7live" and r.get("rs_smoke_legs")]
    check("smoke: a gate 1 change plans one g7-1 live run per browser with its smoke legs",
          {r["id"] for r in sl} == {"g7live-gsw-g7-1", "g7live-web-rust-g7-1"}
          and all(r["rs_smoke_legs"] == "import,capture,reference,live" for r in sl))
    shared = P("experiments/render-stream/scripts/lib/gate7-live-legs.ts")
    check("smoke: shared live code runs g7-1 per browser and defers the other groups",
          {r["id"] for r in shared["runs"] if r["kind"] == "g7live"} >= {"g7live-gsw-g7-1", "g7live-web-rust-g7-1"}
          and "g7live:g7-6@gsw" in shared["smoke_deferred"]
          and not any(r["id"].endswith("g7-6") for r in shared["runs"]))
    full = plan(m, ["experiments/render-stream/scripts/lib/gate7-live-legs.ts"], repo, False, "full")
    check("full: the same diff plans each receiver's live groups whole, no leg filter",
          not any(r.get("rs_smoke_legs") for r in full["runs"]) and not full["smoke_deferred"]
          and any(r["id"] == "g7live-gsw" and "g7-6" in r["groups"] for r in full["runs"]))
    dd = P("experiments/render-stream/protocol/gate7-design.md")
    check("a doc naming sabotage does not run the sabotage legs", not dd["sabotage"]["run"])
    print(f"smoke-plan self-test: {'all pass' if not fails else f'{fails} FAIL'}")
    return fails == 0


def main():
    args = sys.argv[1:]
    mp, repo, milestone, paths_from, st, tier = None, ".", False, None, False, "smoke"
    paths = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--map":
            mp = args[i + 1]; i += 2
        elif a == "--repo":
            repo = args[i + 1]; i += 2
        elif a == "--milestone":
            milestone = True; i += 1
        elif a == "--paths-from":
            paths_from = args[i + 1]; i += 2
        elif a == "--tier":
            tier = args[i + 1]; i += 2
        elif a == "--self-test":
            st = True; i += 1
        else:
            paths.append(a); i += 1
    m = json.load(open(mp))
    if st:
        sys.exit(0 if self_test(m) else 1)
    if paths_from:
        paths += [l.strip() for l in open(paths_from) if l.strip()]
    print(json.dumps(plan(m, sorted(set(paths)), repo, milestone, tier), indent=2))


if __name__ == "__main__":
    main()
