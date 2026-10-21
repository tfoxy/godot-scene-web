#!/usr/bin/env bash
# GRT2b: lib/legs.sh's parallel regions (RS_LEG_SHARDS) with the launches stubbed out -- no Godot,
# no gamescope, a private quiet-lock directory. Checks: N workers really overlap; a legs_par_unit
# keeps its legs in order on one worker; legs_par_wait is a barrier; a failed unit fails
# legs_par_end; one-shot globals do not leak to the next dispatch; serial mode runs inline; a
# timing group refuses a region; every leg holds its own shared lock.
#
#   bash test/self-test-par-legs.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RS_QUIET_LOCK_DIR="$TMP/lock"
mkdir -p "$RS_QUIET_LOCK_DIR"

fails=0
check() {
	if eval "$2"; then
		echo "ok   $1"
	else
		echo "FAIL $1 ($2)"
		fails=$((fails + 1))
	fi
}

# run_case <shards> <case dir>: sources the library in a fresh bash with stub launches and runs
# a small region script; the stubs log "<start> <end> <dir> <RECEIVER_STORE_DIR>" per leg.
run_case() {
	local shards="$1" out="$2"
	mkdir -p "$out"
	RS_LEG_SHARDS="$shards" OUT="$out" SCRIPT_DIR="$SCRIPT_DIR" REPO_ROOT="$REPO_ROOT" bash -c '
		set -euo pipefail
		LEGS_LOG=selftest
		source "$SCRIPT_DIR/lib/gamescope.sh"
		source "$SCRIPT_DIR/lib/legs.sh"
		legs__run_rendered() {
			local t0=$EPOCHREALTIME store="$RECEIVER_STORE_DIR"
			RECEIVER_STORE_DIR=""
			sleep "${LEG_SLEEP:-0.6}"
			[ "${LEG_FAIL:-0}" = 0 ] || return 3
			echo "$t0 $EPOCHREALTIME ${1#"$OUT"/} ${store:-none} ${LEGS_PAR_CHILD:-inline}" >>"$OUT/legs.log"
		}
		pair() {
			LEG_ENV=(); run_rendered "$OUT/pair-a" x
			LEG_ENV=(); run_rendered "$OUT/pair-b" x
		}
		legs_par_begin
		RECEIVER_STORE_DIR=leaky
		LEG_ENV=(); run_rendered "$OUT/a" x
		LEG_ENV=(); run_rendered "$OUT/b" x
		legs_par_unit pair
		LEG_ENV=(); run_rendered "$OUT/c" x
		legs_par_wait
		echo "$EPOCHREALTIME barrier" >>"$OUT/legs.log"
		LEG_ENV=(); run_rendered "$OUT/d" x
		rc=0
		legs_par_end || rc=$?
		echo "end rc=$rc" >>"$OUT/legs.log"
		LEG_FAIL=1
		legs_par_begin
		LEG_ENV=(); run_rendered "$OUT/e" x || echo "inline-fail" >>"$OUT/legs.log"
		rc=0
		legs_par_end || rc=$?
		echo "end2 rc=$rc" >>"$OUT/legs.log"
		LEG_FAIL=0
		LEGS_TIMING_GROUP=g
		legs_par_begin 2>/dev/null
		echo "timing-open=$LEGS_PAR_OPEN" >>"$OUT/legs.log"
		LEGS_TIMING_GROUP=""
		quiet_summary "$OUT" >/dev/null
	' >"$out/stdout.log" 2>&1
}

run_case 2 "$TMP/par"
run_case off "$TMP/ser"
P="$TMP/par/legs.log"
S="$TMP/ser/legs.log"

overlap="$(python3 - "$P" <<'PY'
import sys
legs = [l.split() for l in open(sys.argv[1]) if len(l.split()) == 5]
iv = {l[2]: (float(l[0]), float(l[1]), l[4]) for l in legs}
a, b = iv["a"], iv["b"]
print(1 if a[0] < b[1] and b[0] < a[1] and a[2] != b[2] else 0)
PY
)"
check "two legs overlap on two workers" '[ "$overlap" = 1 ]'
order="$(python3 - "$P" <<'PY'
import sys
legs = {l.split()[2]: l.split() for l in open(sys.argv[1]) if len(l.split()) == 5}
a, b = legs["pair-a"], legs["pair-b"]
print(1 if float(a[1]) <= float(b[0]) and a[4] == b[4] else 0)
PY
)"
check "a unit's legs run in order on one worker" '[ "$order" = 1 ]'
barrier="$(python3 - "$P" <<'PY'
import sys
lines = [l.split() for l in open(sys.argv[1])]
bar = next(float(l[0]) for l in lines if len(l) == 2 and l[1] == "barrier")
ends = [float(l[1]) for l in lines if len(l) == 5 and l[2] in ("a", "b", "c", "pair-a", "pair-b")]
d = next(float(l[0]) for l in lines if len(l) == 5 and l[2] == "d")
print(1 if max(ends) <= bar <= d else 0)
PY
)"
check "legs_par_wait is a barrier" '[ "$barrier" = 1 ]'
check "the one-shot store reaches only the first dispatch" \
	'[ "$(awk "\$3==\"a\"{print \$4}" "$P")" = leaky ] && [ "$(awk "\$3==\"b\"{print \$4}" "$P")" = none ]'
check "a clean region ends 0" 'grep -qx "end rc=0" "$P"'
check "a failed unit fails legs_par_end" 'grep -qx "end2 rc=3" "$P"'
check "a timing group refuses a region" 'grep -qx "timing-open=0" "$P"'
check "serial mode runs every leg inline, in order" \
	'[ "$(awk "NF==5{print \$3\":\"\$5}" "$S" | tr "\n" " ")" = "a:inline b:inline pair-a:inline pair-b:inline c:inline d:inline " ]'
check "serial mode: a failing leg fails inline" 'grep -qx "inline-fail" "$S"'
holds="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["modes"]["shared"]["holds"])' "$TMP/par/quiet-lock-summary.json")"
check "every parallel leg held its own shared lock (7 holds)" '[ "$holds" = 7 ]'

if [ "$fails" = 0 ]; then
	echo "self-test-par-legs: PASS"
else
	echo "self-test-par-legs: FAIL ($fails)"
	sed -n 1,80p "$TMP/par/stdout.log"
	exit 1
fi
