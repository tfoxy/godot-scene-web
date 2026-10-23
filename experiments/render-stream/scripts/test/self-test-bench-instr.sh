#!/usr/bin/env bash
# Pure self-test of bench-instr.sh (R4): a fake valgrind writes cachegrind out files with chosen Ir
# totals and a fake binary stands in for the build, so the parse, threshold, improvement,
# update-baseline and missing-valgrind paths run with no valgrind or cargo.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
B="$SCRIPT_DIR/bench-instr.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
pass=0 fail=0
check() { # name cmd...
	local n="$1" && shift
	if "$@" >/dev/null 2>&1; then pass=$((pass + 1)) && echo "ok   $n"; else fail=$((fail + 1)) && echo "FAIL $n"; fi
}
python3 "$SCRIPT_DIR/lib/bench-instr.py" --self-test >"$T/py.log" 2>&1 && { pass=$((pass + 1)) && echo "ok   bench-instr.py self-test"; } ||
	{ fail=$((fail + 1)) && echo "FAIL bench-instr.py self-test" && tail -3 "$T/py.log"; }

# fake valgrind: Ir from $T/ir/<recording basename>, default 1000000
cat >"$T/valgrind" <<'FAKE'
#!/usr/bin/env bash
[ "$1" = --version ] && { echo "valgrind-0.0.0-fake"; exit 0; }
for a in "$@"; do case "$a" in --cachegrind-out-file=*) o="${a#*=}" ;; esac; done
# argv: ... BIN RECORDING REPEATS -> the recording is the second to last
n=$#; args=("$@"); rec="${args[$((n - 2))]}"
ir=1000000; [ -f "$IRDIR/$(basename "$rec")" ] && ir="$(cat "$IRDIR/$(basename "$rec")")"
printf 'events: Ir\nsummary: %s\n' "$ir" >"$o"
"${args[$((n - 3))]}" "$rec" "${args[$((n - 1))]}"
FAKE
chmod +x "$T/valgrind"
printf '#!/usr/bin/env bash\necho "transactions 1 paint-checksum 00"\n' >"$T/bin"
chmod +x "$T/bin"
mkdir -p "$T/ir"
export IRDIR="$T/ir" RS_BENCH_VALGRIND="$T/valgrind"
run() { bash "$B" --bin "$T/bin" --baseline "$T/base.json" --out "$T/out-$1" "${@:2}"; }

check "no baseline: fails and says so" bash -c "! RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/none.json' --out '$T/out-nb'"
check "--update-baseline writes a baseline of 6 cases and passes" bash -c "
	RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-u' --update-baseline &&
	python3 -c \"import json; d=json.load(open('$T/base.json')); assert len(d['cases'])==6 and all(c['ir']==1000000 for c in d['cases'].values()) and d['valgrind']\""
check "an unchanged run passes; result.json has one check per case" bash -c "
	RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-p' &&
	python3 -c \"import json; d=json.load(open('$T/out-p/result.json')); assert len(d['checks'])==6 and all(c['passed'] for c in d['checks'])\"
	python3 -c \"import json; d=json.load(open('$T/out-p/bench-instr.json')); assert d['binary_sha256'] and d['cpu_model'] is not None and d['cases']['g6-inline']['ir']==1000000\""
echo 1020000 >"$T/ir/inline.rs6"
check "+2% on one case fails and names it" bash -c "
	! RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-r' >'$T/r.log' 2>&1 &&
	grep -q 'regression .*g6-inline' '$T/r.log' &&
	python3 -c \"import json; d=json.load(open('$T/out-r/result.json')); bad=[c['id'] for c in d['checks'] if not c['passed']]; assert bad==['bench-instr-g6-inline'], bad\""
check "--threshold 3 accepts the same +2%" bash -c "RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-t' --threshold 3"
echo 900000 >"$T/ir/inline.rs6"
check "-10% is an improvement: passes and says to update" bash -c "
	RS_BENCH_VALGRIND='$T/valgrind' IRDIR='$T/ir' bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-i' >'$T/i.log' 2>&1 &&
	grep -q 'improvement .*g6-inline' '$T/i.log' && grep -q 'update-baseline' '$T/i.log'"
check "no valgrind: exit 3 naming it" bash -c "RS_BENCH_VALGRIND=/nonexistent/valgrind bash '$B' --bin '$T/bin' --baseline '$T/base.json' --out '$T/out-nv' >'$T/nv.log' 2>&1; [ \$? = 3 ] && grep -q 'not installed' '$T/nv.log'"
echo "bench-instr self-test: $pass passed, $fail failed"
[ "$fail" = 0 ]
