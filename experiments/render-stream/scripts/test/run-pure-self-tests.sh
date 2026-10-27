#!/usr/bin/env bash
# The pure self-tests (gate7-design.md "Re-runs": golden-1/ to golden-7/'s make_golden.py --check
# and every self-test-*.ts), run in parallel OUTSIDE the quiet lock's blocking path (GRT,
# results/grt.md): each runs as `quiet.sh light`, niced and holding nothing, so it never queues
# behind another agent's timing leg. While a timing leg holds the machine lock, at most one
# self-test runs at a time.
#
#   bash experiments/render-stream/scripts/test/run-pure-self-tests.sh [--out DIR] [-j N] [--lock-tests]
#     [--only name,name]
#
# Not here, because they are not pure: self-test-browser-harness.ts (Chromium; run-gate7.sh runs
# it), self-test-rs-core.ts, self-test-record-digest.ts and self-test-rs-core-wasm.mjs (need source
# recordings, bench inputs or a core build;
# run-gate7.sh runs them). --lock-tests adds the two lock self-tests (self-test-quiet.sh,
# self-test-quiet-sched.sh: private locks, ~5 min, timing-sensitive, so they run after the others,
# one at a time). Prints one PASS/FAIL line per test and a summary; exits non-zero on any FAIL.
#
# RS_PURE_SHARD=i/n (1 <= i <= n) runs only shard i of n: the remote workflow splits `pure` across n
# jobs (docs/remote-compute.md). The split is deterministic -- longest-processing-time-first over the
# per-test seconds in pure-shard-weights.json (a test missing there weighs 20 s), ties broken by
# name -- and the n shards cover every test exactly once. Unset or empty means the whole suite,
# exactly as before. --list prints the selected units and exits. A heavy test listed under "parts" in
# the weights file (gate 1, gate 2: ~10 minutes each on a runner) is itself split into parts "name@KofP",
# run with RS_SELF_TEST_SHARD=K/P, which test/shard.ts reads to run every P-th scenario.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
Q="$SCRIPT_DIR/lib/quiet.sh"
OUT=""
JOBS=4
LOCK_TESTS=0
ONLY=""
LIST=0
SHARD="${RS_PURE_SHARD:-}"
while [ $# -gt 0 ]; do
	case "$1" in
	--out) OUT="$2" && shift 2 ;;
	-j) JOBS="$2" && shift 2 ;;
	--lock-tests) LOCK_TESTS=1 && shift ;;
	--only) ONLY="$2" && shift 2 ;;
	--list) LIST=1 && shift ;;
	*) echo "run-pure-self-tests: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/pure-self-tests/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
LOG="$OUT/quiet-lock.jsonl"
: >"$LOG"

EXCLUDE=" self-test-browser-harness.ts self-test-rs-core.ts self-test-record-digest.ts "
NAMES=()
CMDS=()
for d in "$EXPERIMENT_DIR"/protocol/golden-*/; do
	[ -f "$d/make_golden.py" ] || continue
	NAMES+=("$(basename "$d")")
	CMDS+=("cd '$d' && python3 make_golden.py --check")
done
for f in "$SCRIPT_DIR"/test/self-test-*.ts; do
	b="$(basename "$f")"
	case "$EXCLUDE" in *" $b "*) continue ;; esac
	NAMES+=("${b%.ts}")
	CMDS+=("cd '$REPO_ROOT' && mise exec -- pnpm exec tsx --conditions=development '$f'")
done
# GRT2b and GRT4a pure bash self-tests: stub launches, a private lock dir, a private source cache.
# self-test-socket-owners.sh is not here, because its old-scan half walks every /proc fd (~1 min).
for b in self-test-par-legs.sh self-test-fast-frames.sh self-test-validate-tier.sh self-test-source-cache.sh self-test-bench-instr.sh \
	self-test-bench-capture-scale.sh self-test-bench-live-scale.sh self-test-wire-budget.sh; do
	NAMES+=("${b%.sh}")
	CMDS+=("bash '$SCRIPT_DIR/test/$b'")
done
if [ -n "$ONLY" ]; then
	keepn=()
	keepc=()
	for i in "${!NAMES[@]}"; do
		case ",$ONLY," in *",${NAMES[$i]},"*) keepn+=("${NAMES[$i]}") && keepc+=("${CMDS[$i]}") ;; esac
	done
	NAMES=(${keepn[@]+"${keepn[@]}"})
	CMDS=(${keepc[@]+"${keepc[@]}"})
fi

if [ -n "$SHARD" ]; then
	keep_out="$(python3 -I "$SCRIPT_DIR/test/pure-shard.py" "$SHARD" "$SCRIPT_DIR/test/pure-shard-weights.json" "${NAMES[@]}")" ||
		{ echo "run-pure-self-tests: bad RS_PURE_SHARD=$SHARD" >&2 && exit 2; }
	mapfile -t keep <<<"$keep_out"
	# a unit is a test, or "test@KofP": part K of P of a heavy test's own scenario shard
	keepn=()
	keepc=()
	for k in "${keep[@]}"; do
		[ -n "$k" ] || continue
		base="${k%@*}"
		for i in "${!NAMES[@]}"; do
			[ "${NAMES[$i]}" = "$base" ] || continue
			keepn+=("$k")
			if [ "$k" = "$base" ]; then
				keepc+=("${CMDS[$i]}")
			else
				part="${k#*@}"
				keepc+=("export RS_SELF_TEST_SHARD='${part%of*}/${part#*of}'; ${CMDS[$i]}")
			fi
			break
		done
	done
	NAMES=(${keepn[@]+"${keepn[@]}"})
	CMDS=(${keepc[@]+"${keepc[@]}"})
	case "$SHARD" in 1/*) ;; *) LOCK_TESTS=0 ;; esac
fi
if [ "$LIST" = 1 ]; then
	printf '%s\n' ${NAMES[@]+"${NAMES[@]}"}
	exit 0
fi

# exclusive_active: a timing leg holds the machine-wide lock right now.
exclusive_active() {
	bash "$Q" status 2>/dev/null | grep -q '^holders: .*exclusive '
}

t0="$EPOCHREALTIME"
declare -A PID_NAME=()
running() {
	local n=0 p
	for p in "${!PID_NAME[@]}"; do
		if kill -0 "$p" 2>/dev/null; then n=$((n + 1)); fi
	done
	echo "$n"
}
reap() {
	local p rc
	for p in "${!PID_NAME[@]}"; do
		kill -0 "$p" 2>/dev/null && continue
		wait "$p"
		rc=$?
		echo "$rc" >"$OUT/${PID_NAME[$p]}.rc"
		unset "PID_NAME[$p]"
	done
}
for i in "${!NAMES[@]}"; do
	while :; do
		reap
		limit="$JOBS"
		exclusive_active && limit=1
		[ "$(running)" -lt "$limit" ] && break
		sleep 0.5
	done
	bash "$Q" light --label "pure:${NAMES[$i]}" --log "$LOG" -- bash -c "${CMDS[$i]}" >"$OUT/${NAMES[$i]}.log" 2>&1 &
	PID_NAME[$!]="${NAMES[$i]}"
done
while [ "$(running)" -gt 0 ]; do
	reap
	sleep 0.5
done
reap

if [ "$LOCK_TESTS" = 1 ]; then
	for t in self-test-quiet self-test-quiet-sched; do
		NAMES+=("$t")
		bash "$Q" light --label "pure:$t" --log "$LOG" -- bash "$SCRIPT_DIR/test/$t.sh" --out "$OUT/$t" >"$OUT/$t.log" 2>&1
		echo "$?" >"$OUT/$t.rc"
	done
fi

pass=0
fail=0
failed=()
for n in "${NAMES[@]}"; do
	rc="$(cat "$OUT/$n.rc" 2>/dev/null || echo missing)"
	if [ "$rc" = 0 ]; then
		pass=$((pass + 1))
		echo "PASS $n"
	else
		fail=$((fail + 1))
		failed+=("$n")
		echo "FAIL $n (rc $rc; $OUT/$n.log)"
	fi
done
wall="$(python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 1))" "$t0" "$EPOCHREALTIME")"
printf '{"schema":"render-stream-pure-self-tests/1","passed":%d,"failed":%d,"wall_s":%s,"failures":[%s]}\n' \
	"$pass" "$fail" "$wall" "$(printf '"%s",' ${failed[@]+"${failed[@]}"} | sed 's/,$//')" >"$OUT/summary.json"
echo "run-pure-self-tests: $pass passed, $fail failed in ${wall}s (no lock held; $OUT)"
[ "$fail" = 0 ]
