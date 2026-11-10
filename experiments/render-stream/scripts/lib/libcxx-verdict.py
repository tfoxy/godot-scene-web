#!/usr/bin/env python3
"""Classify file-sink comparisons, repeat noise, runtime linkage and check parity."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

RECORDING = re.compile(r"^recording[^/]*\.rs\d+$")
EXCLUDED = "gate0/corrupt/recording.rs2"


def recordings(root):
    files = set()
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
        for name in names:
            p = Path(directory) / name
            if not p.is_symlink() and RECORDING.fullmatch(name) and "/tap/" not in str(p):
                files.add(p.relative_to(root).as_posix())
    return files


def comparison(path, root):
    # cmp-rec --json emits an array followed by a human-readable trailer.
    text = path.read_text().lstrip()
    rows, end = json.JSONDecoder().raw_decode(text)
    trailer = re.fullmatch(r"\s*cmp-rec: (\d+)/(\d+) identical\s*", text[end:])
    if not isinstance(rows, list) or not trailer or int(trailer[2]) != len(rows):
        raise ValueError("invalid cmp-rec JSON/trailer")
    if int(trailer[1]) != sum(r["identical"] is True for r in rows):
        raise ValueError("inconsistent cmp-rec trailer")
    out = {}
    for row in rows:
        key = Path(row["a"]).relative_to(root).as_posix()
        if key in out:
            raise ValueError("duplicate cmp-rec file")
        out[key] = row
    return out


def classify(run, gates, seam=False, ctest="pass", error=None):
    run = Path(run).resolve()
    errors, files, parity, gate_rows = [], [], [], []
    if error:
        errors.append(error)
    if ctest != "pass":
        errors.append("libcxx-ctest-failed" if ctest == "fail" else "libcxx-ctest-not-run")
    try:
        provenance = json.loads((run / "provenance.json").read_text())
        gcc = provenance["libraries"]["gcc"]["needed"]
        libcxx = provenance["libraries"]["libcxx"]["needed"]
        needed_ok = "libstdc++.so.6" in gcc and "libc++.so.1" in libcxx and "libstdc++.so.6" not in libcxx
        # A seam deliberately uses GCC's extension; report linkage but never certify it.
        if not needed_ok and not seam:
            errors.append("needed-check-failed")
    except (OSError, ValueError, KeyError, TypeError):
        needed_ok = False
        errors.append("provenance-missing-or-invalid")
    for gate in gates:
        roots = {label: run / label / gate for label in ("gcc-a", "libcxx", "gcc-b")}
        sets = {label: {f for f in recordings(root) if f"{gate}/{f}" != EXCLUDED}
                for label, root in roots.items()}
        gate_rows.append({"gate": gate, "recordings": {k: len(v) for k, v in sets.items()}})
        if not all(sets.values()):
            errors.append(f"{gate}:zero-recordings")
        comps = {}
        for name in ("gcc-repeat", "libcxx"):
            try:
                comps[name] = comparison(run / "comparisons" / gate / f"{name}.json", roots["gcc-a"])
            except (OSError, ValueError, KeyError, TypeError):
                comps[name] = {}
                errors.append(f"{gate}:{name}:comparison-missing-or-invalid")
        for f in sorted(set.union(*sets.values())):
            a, b, repeat = (f in sets[k] for k in ("gcc-a", "libcxx", "gcc-b"))
            row = {"path": f"{gate}/{f}"}
            if a != b:
                cls = "missing"
            elif not repeat or not a:
                cls = "noise"
            else:
                x, y = comps["gcc-repeat"].get(f), comps["libcxx"].get(f)
                if x is None or y is None:
                    errors.append(f"{gate}/{f}:comparison-row-missing")
                    cls = "missing"
                else:
                    cls = "noise" if not x["identical"] else "ok" if y["identical"] else "finding"
                    row["differing"] = y.get("differing", [])
            row["class"] = cls
            files.append(row)
        verdicts = {}
        for label, root in roots.items():
            try:
                v = json.loads((root / "tier-verdict.json").read_text())
                if not v.get("checks") or v.get("runner_unexplained") or v.get("smoke_legs_not_run"):
                    errors.append(f"{gate}:{label}:invalid-gate-verdict")
                verdicts[label] = set(v["failing"])
            except (OSError, ValueError, KeyError, TypeError):
                errors.append(f"{gate}:{label}:verdict-missing-or-invalid")
                verdicts[label] = set()
        new = sorted(verdicts["libcxx"] - (verdicts["gcc-a"] | verdicts["gcc-b"]))
        parity.append({"gate": gate, "new_failing": new})
        if new:
            errors.append(f"{gate}:verdict-parity-failed")
        gate_files = [f for f in files if f["path"].startswith(gate + "/")]
        gate_rows[-1]["whole_gate_noise"] = bool(gate_files) and all(f["class"] == "noise" for f in gate_files)
    counts = {c: sum(f["class"] == c for f in files) for c in ("ok", "noise", "finding", "missing")}
    rc = 1 if errors or counts["finding"] or counts["missing"] else 3 if seam else 0
    return {"schema": "render-stream-libcxx-control/1", "rc": rc, "seam": seam, "ctest": ctest,
            "needed_ok": needed_ok, "errors": errors, "counts": counts, "files": files,
            "gates": gate_rows, "parity": parity}


def self_test():
    with tempfile.TemporaryDirectory() as tmp:
        run = Path(tmp)
        def reset(gate="gate0"):
            import shutil
            for p in run.iterdir():
                shutil.rmtree(p) if p.is_dir() else p.unlink()
            for label in ("gcc-a", "libcxx", "gcc-b"):
                root = run / label / gate
                root.mkdir(parents=True)
                (root / "recording.rs2").write_bytes(b"test")
                (root / "tier-verdict.json").write_text(json.dumps({"checks": 1, "failing": []}))
            p = run / "comparisons" / gate
            p.mkdir(parents=True)
            row = {"a": str(run / "gcc-a" / gate / "recording.rs2"), "identical": True, "differing": []}
            for name in ("gcc-repeat", "libcxx"):
                (p / f"{name}.json").write_text(json.dumps([row]) + "\ncmp-rec: 1/1 identical\n")
            (run / "provenance.json").write_text(json.dumps({"libraries": {
                "gcc": {"needed": ["libstdc++.so.6"]}, "libcxx": {"needed": ["libc++.so.1"]}}}))
        def result(gate="gate0", **kw):
            return classify(run, [gate], **kw)
        def differs(name):
            p = run / f"comparisons/gate0/{name}.json"
            rows = json.JSONDecoder().raw_decode(p.read_text())[0]
            rows[0]["identical"] = False
            rows[0]["differing"] = [{"index": 1, "type": "tx", "paths": ["items"]}]
            p.write_text(json.dumps(rows) + "\ncmp-rec: 0/1 identical\n")
        tests = []
        def check(name, ok):
            tests.append(ok)
            print(("PASS " if ok else "FAIL ") + name)
        reset(); check("all-ok", result()["rc"] == 0)
        differs("libcxx"); check("finding", result()["counts"]["finding"] == 1 and result()["rc"] == 1)
        differs("gcc-repeat"); check("noise", result()["counts"]["noise"] == 1 and result()["rc"] == 0)
        reset()
        for label in ("gcc-a", "libcxx", "gcc-b"):
            root = run / label / "gate0"
            (root / "corrupt").mkdir(); (root / "corrupt/recording.rs2").touch()
            (root / "tap").mkdir(); (root / "tap/recording.rs2").touch()
            (root / "linked").symlink_to(root, target_is_directory=True)
        check("exact excluded path, tap and symlinks", len(result()["files"]) == 1)
        (run / "libcxx/gate0/corrupt/recording-other.rs2").touch()
        check("exclusion does not hide another corrupt recording", result()["counts"]["missing"] == 1)
        (run / "libcxx/gate0/corrupt/recording-other.rs2").unlink()
        (run / "libcxx/gate0/recording-only.rs2").touch()
        check("B-only file", result()["counts"]["missing"] == 1 and result()["rc"] == 1)
        reset(); (run / "gcc-b/gate0/recording.rs2").unlink()
        check("zero-recording gate", "gate0:zero-recordings" in result()["errors"])
        reset(); p = run / "provenance.json"; original = p.read_text()
        v = json.loads(original); v["libraries"]["libcxx"]["needed"].append("libstdc++.so.6"); p.write_text(json.dumps(v))
        check("bad NEEDED", result()["rc"] == 1)
        p.write_text(original)
        p = run / "libcxx/gate0/tier-verdict.json"; p.write_text(json.dumps({"checks": 1, "failing": ["new"]}))
        check("parity break", result()["rc"] == 1)
        (run / "gcc-b/gate0/tier-verdict.json").write_text(json.dumps({"checks": 1, "failing": ["new"]}))
        check("parity accepts a failure already in either GCC run", result()["rc"] == 0)
        reset(); check("seam -> 3", result(seam=True)["rc"] == 3)
        check("ctest failure", result(ctest="fail")["rc"] == 1)
        p = run / "comparisons/gate0/libcxx.json"; p.write_text(p.read_text().replace("1/1", "0/1"))
        check("cmp-rec trailer parse rejects inconsistent count", result()["rc"] == 1)
        reset(); (run / "comparisons/gate0/libcxx.json").write_text("[]\ncmp-rec: 0/0 identical\n")
        check("missing comparison row fails closed", result()["rc"] == 1)
        # Exercise the same raw-result -> tier-verdict -> control-verdict path as the driver.
        import importlib.util
        spec = importlib.util.spec_from_file_location("tier_verdict", Path(__file__).with_name("tier-verdict.py"))
        tier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tier)
        reset("gate2")
        selected = [{"id": "capture-texture-census", "passed": True}] + [
            {"id": f"group-g2{g}", "passed": False, "status": "not-run",
             "detail": f"g2{g} was not in --legs"} for g in "bcde"]
        def gate2_verdict(label, checks, rc=1):
            root = run / label / "gate2"
            (root / "result.json").write_text(json.dumps({"gate_passed": False, "checks": checks}))
            v = tier.verdict(str(root), True, "", rc)
            (root / "tier-verdict.json").write_text(json.dumps(v))
            return v
        for label in ("gcc-a", "libcxx", "gcc-b"):
            gate2_verdict(label, selected)
        check("gate2 not-run-only selection is valid", result("gate2")["rc"] == 0)
        v = gate2_verdict("libcxx", selected + [{"id": "texture-pixels", "passed": False}])
        got = result("gate2")
        check("gate2 real failure survives beside not-run groups",
              v["failing"] == ["texture-pixels"] and got["rc"] == 1
              and got["errors"] == ["gate2:verdict-parity-failed"])
        gate2_verdict("libcxx", [{"id": "capture-texture-census", "passed": True}])
        check("gate2 unexplained exit still invalid", result("gate2")["errors"] == ["gate2:libcxx:invalid-gate-verdict"])
        gate2_verdict("libcxx", selected, rc=2)
        check("gate2 refusal stays invalid beside not-run groups", result("gate2")["errors"] == ["gate2:libcxx:invalid-gate-verdict"])
        print(f"libcxx-verdict: {sum(tests)}/{len(tests)} passed")
        return 0 if all(tests) else 1


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--run", type=Path)
    p.add_argument("--gates", default="gate0,gate1,gate2,gate8")
    p.add_argument("--seam", action="store_true")
    p.add_argument("--ctest", choices=("pass", "fail", "not-run"), default="pass")
    p.add_argument("--error")
    args = p.parse_args()
    if args.self_test:
        return self_test()
    if args.run is None:
        p.error("--run is required")
    verdict = classify(args.run, args.gates.split(","), args.seam, args.ctest, args.error)
    (args.run / "libcxx-control.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"libcxx-control: rc={verdict['rc']} ctest={args.ctest} {verdict['counts']} errors={verdict['errors']}")
    return verdict["rc"]


if __name__ == "__main__":
    sys.exit(main())
