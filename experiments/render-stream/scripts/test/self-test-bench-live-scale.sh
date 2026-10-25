#!/usr/bin/env bash
# Pure self-test of bench-live-scale.sh (P3-LV): its tap summary and verdict logic on synthetic legs
# (lib/bench-live-scale.py self-test) and its argument refusals. Launches nothing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
B="$SCRIPT_DIR/bench-live-scale.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
check() { # name cmd...
	local n="$1" && shift
	if "$@" >/dev/null 2>&1; then pass=$((pass + 1)) && echo "ok   $n"; else fail=$((fail + 1)) && echo "FAIL $n"; fi
}
python3 "$SCRIPT_DIR/lib/bench-live-scale.py" self-test >"$T/py.log" 2>&1 && { pass=$((pass + 1)) && echo "ok   bench-live-scale.py self-test"; } ||
	{ fail=$((fail + 1)) && echo "FAIL bench-live-scale.py self-test" && tail -3 "$T/py.log"; }
refuses() { # expected-exit cmd...
	local want="$1" && shift
	"$@" >/dev/null 2>&1
	[ "$?" = "$want" ]
}
check "no --extension: exit 2" refuses 2 bash "$B" --receiver native --out "$T/a"
check "an unknown argument: exit 2" refuses 2 bash "$B" --bogus
check "a bad --receiver: exit 2" refuses 2 bash "$B" --extension "$B" --receiver chrome --out "$T/b"
check "a bad --window: exit 2" refuses 2 bash "$B" --extension "$B" --receiver native --window 3 --out "$T/c"
check "a browser receiver without --bundle: exit 2" refuses 2 bash "$B" --extension "$B" --receiver gsw --out "$T/d"
check "no template: exit 2" refuses 2 bash "$B" --extension "$B" --receiver native --binary "$T/none" --out "$T/e"
check "a word for neither side: exit 2" refuses 2 bash "$B" --extension "$B" --receiver native --binary /bin/true \
	--calibration "$B" --out "$T/f" -- FOO=1
echo "self-test-bench-live-scale: $pass passed, $fail failed"
[ "$fail" = 0 ]
