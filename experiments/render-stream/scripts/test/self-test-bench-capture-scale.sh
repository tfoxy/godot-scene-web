#!/usr/bin/env bash
# Pure self-test of bench-capture-scale.sh (P3-CAP): its summary and verdict logic on synthetic legs
# (lib/bench-capture-scale.py self-test) and its argument refusals. Launches nothing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
B="$SCRIPT_DIR/bench-capture-scale.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
check() { # name cmd...
	local n="$1" && shift
	if "$@" >/dev/null 2>&1; then pass=$((pass + 1)) && echo "ok   $n"; else fail=$((fail + 1)) && echo "FAIL $n"; fi
}
python3 "$SCRIPT_DIR/lib/bench-capture-scale.py" self-test >"$T/py.log" 2>&1 && { pass=$((pass + 1)) && echo "ok   bench-capture-scale.py self-test"; } ||
	{ fail=$((fail + 1)) && echo "FAIL bench-capture-scale.py self-test" && tail -3 "$T/py.log"; }
refuses() { # expected-exit cmd...
	local want="$1" && shift
	"$@" >/dev/null 2>&1
	[ "$?" = "$want" ]
}
check "no --extension: exit 2" refuses 2 bash "$B" --out "$T/a"
check "an unknown argument: exit 2" refuses 2 bash "$B" --bogus
check "a bad --mode: exit 2" refuses 2 bash "$B" --extension "$B" --binary /bin/true --mode wire --out "$T/b"
check "no template: exit 2" refuses 2 bash "$B" --extension "$B" --binary "$T/none" --out "$T/c"
echo "self-test-bench-capture-scale: $pass passed, $fail failed"
[ "$fail" = 0 ]
