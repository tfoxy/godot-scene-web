#!/usr/bin/env python3
"""Every native gate 8 group stands alone in a remote leg shard: it builds what its own legs and
checkers load, and shares a `together` set with any group whose outputs its checks read.

A remote leg shard (lib/remote-matrix.py, remote-jobs.json `leg_shards["native-rust-gate8"]`) runs
any subset of run-gate8.sh's DEFAULT_GROUPS, so a group cannot rely on another group's build or
outputs: g8tag in a shard without g8mm/g8pt/g8w11 failed every tag-* check (no rs-core-check, then
no rs-core/latest/gsw-rs for lib/coding-receiver.ts), and g8l without g8t/g8f/g8a/g8h/g8m silently
dropped its g8l-<f>-replay-equals-file checks. Per group:

  - its checker modules: the lib/ modules check-gate8.ts calls inside `if (run.includes("<g>"))`,
    with their ./ imports (transitively; gate7-gsw-checks.ts, which only defines the paths, excluded)
  - its scripts: the .ts files its run_<g> block (and the run-gate8.sh functions it calls) runs
  - needs rs-core-check: a checker module names RS_CORE_CHECK
  - needs rs-gsw-wasm: a checker module or script loads `"gsw-rs"` from an rs-core build without
    running build-rs-core.sh itself (gate8-w11-tool.ts, gate8-delivery-tool.ts do)
  - build-rs-core.sh in its block provides rs-core-check unless --wasm-only, the wasm unless --native-only
  - reads: another group's out dir named in one of its own checker modules (not their imports, which
    are shared helpers: "g8a/late/receiver"); then both share a together set. g8t writes at the run root (receiver/), so no name finds it: its set is by hand.

  python3 test/gate8-build-deps.py [--run-gate8 FILE]   # exit 1 and list each gap
  python3 test/gate8-build-deps.py --self-test          # the real files pass, sabotaged ones fail
"""

import json
import re
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent
LIB = SCRIPTS / "lib"
DEFINES = LIB / "gate7-gsw-checks.ts"  # defines RS_CORE_CHECK; importing it for other helpers is not a need
LABEL = "native-rust-gate8"


def ts_closure(path: Path, seen: set[Path]) -> set[Path]:
    if path in seen or path == DEFINES or not path.exists() or SCRIPTS not in path.parents:
        return seen
    seen.add(path)
    for dep in re.findall(r'from\s*"(\.{1,2}/[^"]+)"', path.read_text()):
        ts_closure((path.parent / dep).with_suffix(".ts").resolve(), seen)
    return seen


def shell_reach(run_gate8: str, group: str) -> str:
    funcs = dict(re.findall(r"^(\w+)\(\) \{\n(.*?)^\}", run_gate8, re.M | re.S))
    todo, seen = [f"run_{group}"], set()
    while todo:
        f = todo.pop()
        if f in funcs and f not in seen:
            seen.add(f)
            todo += [w for w in re.findall(r"\b\w+\b", funcs[f]) if w in funcs]
    return "\n".join(funcs[f] for f in sorted(seen))


def group_checkers() -> dict[str, set[Path]]:
    src = (SCRIPTS / "check-gate8.ts").read_text()
    mod = {}
    for names, m in re.findall(r'import\s*\{([^}]*)\}\s*from\s*"\./lib/([^"]+)"', src):
        for name in re.findall(r"\b(?<!type )(\w+)\s*(?:,|$)", names.strip()):
            mod[name] = LIB / f"{m}.ts"
    out = {}
    for g, body in re.findall(r'^  if \(run\.includes\("(\w+)"\)\) \{\n(.*?)^  \}', src, re.M | re.S):
        out[g] = {mod[n] for n in re.findall(r"\b\w+\b", body) if n in mod}
    return out


def problems(run_gate8: str, table: dict) -> tuple[dict[str, list[str]], list[str]]:
    groups = re.search(r"^DEFAULT_GROUPS=\(([^)]*)\)", run_gate8, re.M).group(1).split()
    together = table["leg_shards"][LABEL].get("together", [])
    checkers = group_checkers()
    needs, out = {}, []
    for g in groups:
        reach = shell_reach(run_gate8, g)
        mods = set().union(*(ts_closure(m, set()) for m in checkers.get(g, ())))
        texts = [m.read_text() for m in mods]
        core = any(re.search(r"\bRS_CORE_CHECK\b", t) for t in texts)
        wasm = any('"gsw-rs"' in t for t in texts)
        for s in re.findall(r"\$SCRIPT_DIR/([\w/.-]+\.ts)", reach):
            st = [p.read_text() for p in ts_closure((SCRIPTS / s).resolve(), set())]
            wasm |= any('"gsw-rs"' in t for t in st) and not any("build-rs-core.sh" in t for t in st)
        builds = re.findall(r'bash "\$SCRIPT_DIR/build-rs-core\.sh"([^\n]*)', reach)  # not echo/comments
        direct = [m.read_text() for m in checkers.get(g, ()) if m.exists()]  # imports are shared helpers
        reads = sorted({r for t in direct for r in re.findall(r'"(g8\w+)[/"]', t) if r in groups and r != g})
        needs[g] = (["rs-core-check"] if core else []) + (["rs-gsw-wasm"] if wasm else []) + reads
        if core and not any("--wasm-only" not in b for b in builds):
            out.append(f"run_{g} must build rs-core-check (build-rs-core.sh, not --wasm-only)")
        if wasm and not any("--native-only" not in b for b in builds):
            out.append(f"run_{g} must build rs-gsw-wasm (build-rs-core.sh, not --native-only)")
        for r in reads:
            if not any(g in t and r in t for t in together):
                out.append(f"{g}'s checks read {r}'s outputs: put them in one {LABEL} together set")
    return needs, out


def main(argv: list[str]) -> int:
    real = (SCRIPTS / "run-gate8.sh").read_text()
    table = json.loads((SCRIPTS / "remote-jobs.json").read_text())
    if argv[:1] == ["--self-test"]:
        ok = True

        def case(name: str, got: list[str], want: list[str]) -> None:
            nonlocal ok
            hit = all(any(w in x for x in got) for w in want) and (want or not got)
            ok &= bool(hit)
            print(f"{'ok  ' if hit else 'FAIL'} {name}: {got or 'no gaps'}")

        needs, gaps = problems(real, table)
        seen = needs.get("g8tag", [])[:2] == ["rs-core-check", "rs-gsw-wasm"] and "g8f" in needs.get("g8l", [])
        ok &= seen
        print(f"{'ok  ' if seen else 'FAIL'} needs (g8tag both builds, g8l the file groups): "
              f"{ {g: n for g, n in needs.items() if n} }")
        case("the real run-gate8.sh and remote-jobs.json", gaps, [])
        build = re.search(r'bash "\$SCRIPT_DIR/build-rs-core\.sh" >"\$OUT/g8tag/', real).group(0)
        no_build = re.sub(r".*" + re.escape(build) + r".*\n", "", real, count=1)
        case("g8tag without its build", problems(no_build, table)[1], ["run_g8tag must build rs-core-check"])
        native = real.replace(build, build.replace('.sh"', '.sh" --native-only'), 1)
        case("g8tag building --native-only", problems(native, table)[1], ["run_g8tag must build rs-gsw-wasm"])
        split = json.loads(json.dumps(table))
        spec = split["leg_shards"][LABEL]
        spec["together"] = [t for t in spec["together"] if "g8l" not in t]
        case("g8l outside its file groups' together set", problems(real, split)[1], ["g8l's checks read g8a"])
        return 0 if ok else 1
    if argv[:1] == ["--run-gate8"] and len(argv) > 1:
        real = Path(argv[1]).read_text()
    needs, gaps = problems(real, table)
    for p in gaps:
        print(f"gate8-build-deps: {p}", file=sys.stderr)
    print(f"gate8-build-deps: {sum(1 for n in needs.values() if n)} groups with needs, {len(gaps)} gaps")
    return 1 if gaps else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
