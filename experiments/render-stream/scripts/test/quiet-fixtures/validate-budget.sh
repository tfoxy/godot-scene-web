#!/usr/bin/env bash
# Sourced by self-test-quiet.sh. Block the real pnpm-test entry's shared acquisition, so its
# command never starts: this needs no engine, GPU, build or stubbed dispatcher.
: >"$BUDGET_LEDGER"
rm -f "$OUT/validate-budget-ready"
bash "$Q" exclusive --label validate-budget-blocker -- bash -c \
	'touch "$1"; exec sleep 15' _ "$OUT/validate-budget-ready" &
budget_blocker=$!
for _ in $(seq 1 100); do
	[ ! -f "$OUT/validate-budget-ready" ] || break
	sleep 0.02
done
t0="$EPOCHREALTIME"
env -u GSW_QUIET_WAIT_BUDGET_S -u GSW_QUIET_WAIT_LEDGER timeout 12 \
	bash "$SCRIPT_DIR/validate-increment.sh" --only pnpm-test --paths vitest.config.ts \
	--max-lock-wait 3 --out "$OUT/validate-budget" >"$OUT/validate-budget.log" 2>&1
validate_budget_rc=$?
validate_budget_elapsed="$(since "$t0")"
budget_unblock
ok=0
[ "$validate_budget_rc" = 75 ] && flt "$validate_budget_elapsed" 7 &&
	grep -q 'verdicts above are INCOMPLETE, not code failures' "$OUT/validate-budget.log" && ok=1
check "validate budget: exits 75 promptly with INCOMPLETE verdict (${validate_budget_elapsed}s)" [ "$ok" = 1 ]
check "validate budget: summary records budget 3 s, exhaustion and spent wait" python3 - "$OUT/validate-budget/validate-summary.json" <<'PYTEST'
import json, sys
s = json.load(open(sys.argv[1]))
b = s['lock_wait_budget']
assert b['budget_s'] == 3 and b['spent_s'] >= 3 and b['exhausted'] is True
assert len(s['runs']) == 1 and s['runs'][0]['rc'] == '75'
PYTEST
check "validate budget: startup line names the private queue" grep -q '^validate-increment: quiet lock holders: exclusive validate-budget-blocker' "$OUT/validate-budget.log"
check "validate budget: pnpm command never starts" bash -c 'grep -q "gave up: this run.s lock-wait budget is spent" "$1/pnpm-test/run.log" && ! grep -q "vitest" "$1/pnpm-test/run.log"' _ "$OUT/validate-budget"

# Cheap successful dispatches exercise the public option/env precedence and the non-exhausted
# summary without invoking pnpm. The stub still takes a real private shared hold.
cat >"$OUT/validate-budget-stub.sh" <<STUB
exec bash "$Q" shared --label validate-budget-stub -- true
STUB
validate_budget_setting() {
	local name="$1" expected="$2"
	shift 2
	env -u GSW_QUIET_WAIT_BUDGET_S -u RS_VALIDATE_MAX_LOCK_WAIT_S \
		RS_VALIDATE_STUB="$OUT/validate-budget-stub.sh" "$@" \
		bash "$SCRIPT_DIR/validate-increment.sh" --only pnpm-test --paths vitest.config.ts \
		--out "$OUT/validate-budget-$name" >"$OUT/validate-budget-$name.log" 2>&1
	local rc=$?
	check "validate budget: $name dispatch passes (rc $rc)" [ "$rc" = 0 ]
	check "validate budget: $name budget is $expected s and not exhausted" python3 - "$OUT/validate-budget-$name/validate-summary.json" "$expected" <<'PYTEST'
import json, sys
s = json.load(open(sys.argv[1]))
b = s['lock_wait_budget']
assert b['budget_s'] == float(sys.argv[2]) and b['exhausted'] is False
assert b['spent_s'] >= 0 and s['runs'][0]['rc'] == '0'
PYTEST
}
validate_budget_setting default 10800 env
validate_budget_setting env 5 env RS_VALIDATE_MAX_LOCK_WAIT_S=5
# A shell wrapper appends flags after the env/command, preserving simple argv passing above.
cat >"$OUT/validate-budget-flag.sh" <<'STUB'
exec "$@" --max-lock-wait 0
STUB
validate_budget_setting disabled 0 bash "$OUT/validate-budget-flag.sh"
validate_budget_setting explicit-env 2 env GSW_QUIET_WAIT_BUDGET_S=2 bash "$OUT/validate-budget-flag.sh"
