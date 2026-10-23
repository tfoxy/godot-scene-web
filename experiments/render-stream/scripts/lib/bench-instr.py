#!/usr/bin/env python3
"""Instruction-count bench logic (R4, scripts/bench-instr.sh): cachegrind output in, verdict out.

  bench-instr.py parse FILE                 print the Ir total of a cachegrind out file or a
                                            `valgrind --tool=cachegrind` stderr summary
  bench-instr.py compare --results R.json --baseline B.json [--threshold PCT] [--result-json OUT]
  bench-instr.py --self-test

A baseline is {schema, cases: {name: {ir, threshold_pct?}}}; the default threshold is 1.0 percent. A
case regresses when its Ir exceeds the baseline by more than the threshold, improves when it is
lower by more than the threshold (reported, never a failure: the baseline is rewritten with
--update-baseline), and is otherwise ok. A case missing from the baseline or from the results fails.
`compare` writes a result.json with one check per case ({id, passed, detail}) that
lib/tier-verdict.py reads, and exits 1 on any failing check.
"""
import json
import re
import sys

DEFAULT_THRESHOLD = 1.0
BASELINE_SCHEMA = "render-stream-instr-baseline/1"


def parse_ir(text):
    """Total Ir: the `summary:` line of a cachegrind out file (`events: Ir` first), else the
    `I   refs:` line of the stderr summary. Raises ValueError when neither is there."""
    m = re.search(r"^events:\s*(.*)$", text, re.M)
    s = re.search(r"^summary:\s*(.*)$", text, re.M)
    if m and s:
        events = m.group(1).split()
        vals = s.group(1).split()
        if "Ir" in events and len(vals) >= len(events):
            return int(vals[events.index("Ir")])
    r = re.search(r"I\s+refs:\s+([\d,]+)", text)
    if r:
        return int(r.group(1).replace(",", ""))
    raise ValueError("no Ir total in the cachegrind output")


def judge(case, ir, base, default_threshold):
    if base is None:
        return {"case": case, "ir": ir, "status": "missing-baseline", "passed": False,
                "detail": f"{ir} Ir, but the baseline has no case {case} (run with --update-baseline)"}
    b = base["ir"]
    thr = float(base.get("threshold_pct", default_threshold))
    delta = (ir - b) / b * 100.0
    status = "regression" if delta > thr else "improvement" if delta < -thr else "ok"
    return {"case": case, "ir": ir, "baseline_ir": b, "delta_pct": round(delta, 4), "threshold_pct": thr,
            "status": status, "passed": status != "regression",
            "detail": f"{ir} Ir vs baseline {b} ({delta:+.3f}%, threshold {thr}%): {status}"}


def compare(results, baseline, threshold=None):
    thr = DEFAULT_THRESHOLD if threshold is None else threshold
    rows = []
    bases = baseline.get("cases", {})
    for case, r in results["cases"].items():
        rows.append(judge(case, r["ir"], bases.get(case), thr))
    for case in bases:
        if case not in results["cases"]:
            rows.append({"case": case, "status": "missing-result", "passed": False,
                         "detail": f"the baseline has case {case} but the run produced no result for it"})
    return rows


def result_json(rows):
    return {"schema": "render-stream-instr-result/1",
            "checks": [{"id": f"bench-instr-{r['case']}", "passed": r["passed"], "status": r["status"],
                        "detail": r["detail"]} for r in rows]}


def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    if argv[:1] == ["parse"]:
        print(parse_ir(open(argv[1]).read()))
        return 0
    if argv[:1] == ["compare"]:
        a = {argv[i]: argv[i + 1] for i in range(1, len(argv) - 1, 2)}
        results = json.load(open(a["--results"]))
        baseline = json.load(open(a["--baseline"]))
        thr = float(a["--threshold"]) if "--threshold" in a else None
        rows = compare(results, baseline, thr)
        for r in rows:
            print(f"  {r['status']:<16} {r['case']:<28} {r['detail']}")
        if "--result-json" in a:
            json.dump(result_json(rows), open(a["--result-json"], "w"), indent=2)
        bad = [r for r in rows if not r["passed"]]
        better = [r for r in rows if r["status"] == "improvement"]
        if better:
            print(f"bench-instr: {len(better)} improvement(s) over the baseline; rewrite it with --update-baseline")
        print(f"bench-instr: {len(rows) - len(bad)}/{len(rows)} cases within threshold")
        return 1 if bad else 0
    print(__doc__, file=sys.stderr)
    return 2


def self_test():
    n = 0

    def check(name, cond):
        nonlocal n
        n += 1
        print(("ok   " if cond else "FAIL ") + name)
        if not cond:
            sys.exit(1)

    out_file = "# fake\ndesc: x\ncmd: bin\nevents: Ir\nfl=a\nfn=f\n1 5\nsummary: 1234567\n"
    check("out file: events Ir, summary", parse_ir(out_file) == 1234567)
    two = "events: Dr Ir\nsummary: 7 99\n"
    check("out file: Ir picked by column", parse_ir(two) == 99)
    err = "==12== Cachegrind, a high-precision tracing profiler\n==12== \n==12== I   refs:      1,234,567\n"
    check("stderr summary with thousands separators", parse_ir(err) == 1234567)
    try:
        parse_ir("nothing here")
        check("garbage is an error", False)
    except ValueError:
        check("garbage is an error", True)
    base = {"cases": {"a": {"ir": 1000}, "b": {"ir": 1000, "threshold_pct": 5}, "c": {"ir": 1000}}}
    res = {"cases": {"a": {"ir": 1009}, "b": {"ir": 1049}, "c": {"ir": 980}}}
    rows = {r["case"]: r for r in compare(res, base)}
    check("+0.9% is ok at 1%", rows["a"]["status"] == "ok" and rows["a"]["passed"])
    check("+4.9% is ok at the per-case 5%", rows["b"]["status"] == "ok")
    check("-2% is an improvement and passes", rows["c"]["status"] == "improvement" and rows["c"]["passed"])
    res["cases"]["a"]["ir"] = 1011
    rows = {r["case"]: r for r in compare(res, base)}
    check("+1.1% regresses at 1%", rows["a"]["status"] == "regression" and not rows["a"]["passed"])
    res["cases"]["b"]["ir"] = 1051
    check("+5.1% regresses at the per-case 5%", {r["case"]: r for r in compare(res, base)}["b"]["status"] == "regression")
    check("--threshold overrides the default only", {r["case"]: r for r in compare(res, base, 0.5)}["c"]["status"] == "improvement")
    extra = {"cases": {"a": {"ir": 1000}, "z": {"ir": 5}}}
    rows = {r["case"]: r for r in compare(extra, {"cases": {"a": {"ir": 1000}, "gone": {"ir": 1}}})}
    check("a case without a baseline fails", rows["z"]["status"] == "missing-baseline" and not rows["z"]["passed"])
    check("a baselined case without a result fails", rows["gone"]["status"] == "missing-result")
    rj = result_json(list(rows.values()))
    check("one check per case, id-prefixed", sorted(c["id"] for c in rj["checks"]) == ["bench-instr-a", "bench-instr-gone", "bench-instr-z"])
    print(f"bench-instr.py self-test: {n} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
