#!/usr/bin/env bash
# Sourced by self-test-quiet.sh: all contention is on that test's private lock.
# Each attempt has an outer timeout so a regression cannot leave a queued self-test behind.
BUDGET_LEDGER="$OUT/budget-ledger"
export GSW_QUIET_WAIT_LEDGER="$BUDGET_LEDGER"

budget_attempt() {
	local mode="$1" budget="$2" t0="$EPOCHREALTIME"
	rm -f "$OUT/budget-ran" "$BUDGET_LEDGER.exhausted"
	env ${budget:+GSW_QUIET_WAIT_BUDGET_S="$budget"} timeout 5 bash "$Q" "$mode" --label budget-test \
		--log "$OUT/budget.jsonl" -- touch "$OUT/budget-ran" >"$OUT/budget.out" 2>"$OUT/budget.err"
	budget_rc=$?
	budget_elapsed="$(since "$t0")"
}
budget_ok() {
	[ "$budget_rc" = 75 ] && [ ! -e "$OUT/budget-ran" ] &&
		[ -f "$BUDGET_LEDGER.exhausted" ] && flt "$budget_elapsed" "$1" &&
		grep -q "this run's lock-wait budget is spent" "$OUT/budget.err"
}
# A raw flock holder cannot nest with our attempts, and signals readiness without a fixed sleep.
budget_block() {
	rm -f "$OUT/budget-ready"
	flock -x "$GSW_QUIET_DIR/quiet.lock" bash -c 'touch "$1"; exec sleep 15' _ "$OUT/budget-ready" &
	budget_blocker=$!
	for _ in $(seq 1 100); do
		[ ! -f "$OUT/budget-ready" ] || return 0
		sleep 0.02
	done
	return 1
}
budget_unblock() {
	# flock's child owns the sleeping process; terminate both without leaving an orphan.
	pkill -TERM -P "$budget_blocker" 2>/dev/null || true
	kill "$budget_blocker" 2>/dev/null || true
	wait "$budget_blocker" 2>/dev/null || true
}
: >"$BUDGET_LEDGER"
budget_block
budget_attempt exclusive 2
check "budget: exclusive exits 75 within 4 s, skips command, marks exhausted (${budget_elapsed}s)" budget_ok 4
budget_unblock

# A live exclusive waiter marker, without a flock holder, exercises the marker loop itself.
sleep 15 &
budget_marker=$!
budget_ticks="$(sed 's/.*) //' "/proc/$budget_marker/stat" | awk '{print $20}')"
printf '%s %s %s %s budget-marker\n' "$budget_marker" "$budget_ticks" "$EPOCHSECONDS" "$$" >"$W/$budget_marker.v2"
: >"$BUDGET_LEDGER"
budget_attempt shared 2
check "budget: shared behind a live marker exits 75 within 4 s (${budget_elapsed}s)" budget_ok 4
check "budget: shared waiter registration removed on exhaustion" bash -c 'test -z "$(ls -A "$1" 2>/dev/null)"' _ "$GSW_QUIET_DIR/quiet.lock.swaiters"
kill "$budget_marker" 2>/dev/null
wait "$budget_marker" 2>/dev/null || true
rm -f "$W/$budget_marker.v2"

printf '1.5\n' >"$BUDGET_LEDGER"
budget_block
budget_attempt exclusive 2
ok=0
budget_ok 2 && fge "$budget_elapsed" 0.5 && ok=1
check "budget: ledger 1.5 s plus this wait exhausts 2 s (${budget_elapsed}s)" [ "$ok" = 1 ]
budget_unblock

printf '3\n' >"$BUDGET_LEDGER"
budget_attempt exclusive 2
check "budget: already over budget gives up without waiting (${budget_elapsed}s < 0.5)" budget_ok 0.5

# A later subshell must give up immediately even though the failed wait wasn't an acquisition.
printf '0\n' >"$BUDGET_LEDGER"
GSW_QUIET_WAIT_BUDGET_S=2 timeout 5 bash "$Q" shared -- true >"$OUT/budget-again.out" 2>&1
check "budget: exhausted sentinel stops a later acquisition" [ "$?" = 75 ]

rm -f "$BUDGET_LEDGER.exhausted"
: >"$BUDGET_LEDGER"
budget_block
(sleep 1.2; budget_unblock) &
budget_releaser=$!
budget_attempt exclusive ""
wait "$budget_releaser" 2>/dev/null || true
wait "$budget_blocker" 2>/dev/null || true
ok=0
[ "$budget_rc" = 0 ] && [ -f "$OUT/budget-ran" ] && fge "$budget_elapsed" 0.8 && ok=1
check "budget: unset budget still waits and runs command (${budget_elapsed}s)" [ "$ok" = 1 ]

printf '3\n' >"$BUDGET_LEDGER"
budget_attempt exclusive 0
check "budget: zero disables the budget even with an over-budget ledger" [ "$budget_rc" = 0 ]

rm -f "$BUDGET_LEDGER.exhausted"
GSW_QUIET_WAIT_BUDGET_S=0 timeout 5 bash "$Q" exclusive -- bash -c \
	'GSW_QUIET_WAIT_BUDGET_S=2 bash "$1" shared -- true' _ "$Q" >"$OUT/budget-nested.out" 2>&1
check "budget: nested hold ignores the exhausted budget" [ "$?" = 0 ]
: >"$BUDGET_LEDGER"
GSW_QUIET_WAIT_BUDGET_S=2 timeout 5 bash "$Q" shared -- true
check "budget: a successful acquisition appends one decimal wait to the ledger" python3 - "$BUDGET_LEDGER" <<'PYTEST'
import sys
values = [float(line) for line in open(sys.argv[1])]
assert len(values) == 1 and 0 <= values[0] < 0.5
PYTEST

# The existing twin script runs its body only after quietAcquire resolves.
printf '3\n' >"$BUDGET_LEDGER"
rm -f "$BUDGET_LEDGER.exhausted"
GSW_QUIET_WAIT_BUDGET_S=2 timeout 15 "${TSX[@]}" "$OUT/twin.mts" exclusive 0 >"$OUT/budget-ts.out" 2>&1
budget_ts_rc=$?
ok=0
[ "$budget_ts_rc" = 75 ] && [ -f "$BUDGET_LEDGER.exhausted" ] &&
	grep -q "this run's lock-wait budget is spent" "$OUT/budget-ts.out" &&
	! grep -q '^acquired\|^none' "$OUT/budget-ts.out" && ok=1
check "budget: TS twin exits 75 without running unlocked (rc $budget_ts_rc)" [ "$ok" = 1 ]

# The caller can already own a probe with piped stdio before attempting its hold.
cat >"$OUT/budget-ts-child.mts" <<EOF
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { quietAcquire } from "$SCRIPT_DIR/lib/quiet-lock.ts";
const child = spawn("sleep", ["20"], { stdio: ["ignore", "pipe", "pipe"] });
writeFileSync(process.argv[2], String(child.pid));
try {
  await quietAcquire("exclusive", "budget-ts-child");
} finally {
  child.kill("SIGTERM");
}
EOF
rm -f "$BUDGET_LEDGER.exhausted"
GSW_QUIET_WAIT_BUDGET_S=2 timeout 15 "${TSX[@]}" "$OUT/budget-ts-child.mts" "$OUT/budget-ts-child.pid" >"$OUT/budget-ts-child.out" 2>&1
budget_ts_rc=$?
budget_child="$(cat "$OUT/budget-ts-child.pid")"
budget_child_gone() {
	local stat
	[ -f "/proc/$budget_child/stat" ] || return 0
	read -r stat <"/proc/$budget_child/stat" || return 0
	[[ "${stat##*) }" = Z\ * ]]
}
for _ in $(seq 1 100); do
	budget_child_gone && break
	sleep 0.02
done
check "budget: TS twin exits 75 and stops its pre-existing child within 2 s" bash -c 'test "$1" = 75 && test "$2" = gone' _ "$budget_ts_rc" "$(budget_child_gone && echo gone)"
# Always clean up the stand-in, including on the unfixed implementation.
kill "$budget_child" 2>/dev/null || true

# Prime the cursor once, then repeated empty polls must not rescan a long ledger.
python3 - "$OUT/budget-long-ledger" <<'PYTEST'
import sys
open(sys.argv[1], 'w').write('0.001\n' * 3000)
PYTEST
cat >"$OUT/budget-polls.sh" <<'POLL'
source "$1"
ledger="$2" budget_us=10800000000 start_us="$(quiet__now_us)"
ledger_fd="" ledger_spent_us=0 QUIET__CLEAN=()
quiet__check_budget
t0="$EPOCHREALTIME"
for _ in {1..20}; do quiet__check_budget; done
python3 - "$t0" "$EPOCHREALTIME" <<'PYTEST'
import sys
elapsed = float(sys.argv[2]) - float(sys.argv[1])
print(f'{elapsed:.6f}')
assert elapsed < 1, elapsed
PYTEST
POLL
timeout 5 bash "$OUT/budget-polls.sh" "$Q" "$OUT/budget-long-ledger" >"$OUT/budget-polls.out" 2>&1
check "budget: 20 primed checks on a 3000-line ledger finish within 1 s" [ "$?" = 0 ]

# The cursor must see another holder's append after this acquisition has begun waiting.
rm -f "$BUDGET_LEDGER.exhausted"
: >"$BUDGET_LEDGER"
budget_block
(
	for _ in $(seq 1 100); do
		compgen -G "$W/*.v2" >/dev/null && break
		sleep 0.02
	done
	sleep 0.3
	printf '31\n' >>"$BUDGET_LEDGER"
) &
budget_appender=$!
budget_attempt exclusive 30
wait "$budget_appender"
check "budget: a concurrent ledger append exhausts an already waiting holder" budget_ok 3
budget_unblock
check "budget: JSON events include spent, budget, holders in both logs" python3 - "$OUT/budget.jsonl" "$GSW_QUIET_DIR/quiet.lock.events.log" <<'PYTEST'
import json, sys
for path in sys.argv[1:]:
    events = [json.loads(line) for line in open(path)]
    budget = [e for e in events if e['event'] == 'wait-budget']
    assert len(budget) >= 4
    assert all(e['spent_s'] > e['budget_s'] and isinstance(e['holders'], str) for e in budget)
PYTEST
unset GSW_QUIET_WAIT_LEDGER
