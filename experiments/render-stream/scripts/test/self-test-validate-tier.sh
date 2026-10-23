#!/usr/bin/env bash
# GRT4a: validate-increment.sh's planner, phases, verdicts, summary and fast-frame env, with every
# runner replaced by a stub (RS_VALIDATE_STUB) on a PRIVATE quiet lock -- no Godot, no browser.
# Checks:
#   - smoke-plan.py --self-test and tier-verdict.py --self-test (item 1's native/g7-lc pairing,
#     item 2's typed unavailable rows, item 4's phases, item 8's --base and delta sweep);
#   - a stubbed --milestone sweep: the timing phase starts after every correctness run ended, and
#     no shared hold overlaps an exclusive one (item 4);
#   - a run whose runner exits 1 with only typed unavailable rows passes and the summary lists
#     them (item 2);
#   - validate-summary.json has per-run wall, lock wait and lock hold from the run's own
#     quiet-lock-summary.json files, never from a symlinked source (item 6);
#   - --milestone gives RS_FAST_FRAMES only to the native runs and the correctness live runs, and
#     lib/legs.sh under that env makes an allowlisted leg fast and a gate 6 leg real time (item 7);
#   - --plan --milestone --base REF plans a delta sweep (item 8).
#
#   bash test/self-test-validate-tier.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export RS_QUIET_LOCK_DIR="$TMP/lock"
mkdir -p "$RS_QUIET_LOCK_DIR"
Q="$SCRIPT_DIR/lib/quiet.sh"

fails=0
check() {
	if eval "$2"; then
		echo "ok   $1"
	else
		echo "FAIL $1 ($2)"
		fails=$((fails + 1))
	fi
}

check "smoke-plan.py --self-test" "python3 '$SCRIPT_DIR/lib/smoke-plan.py' --self-test --map '$SCRIPT_DIR/smoke-map.json' >'$TMP/plan-st.log' 2>&1"
check "tier-verdict.py --self-test" "python3 '$SCRIPT_DIR/lib/tier-verdict.py' --self-test >'$TMP/verdict-st.log' 2>&1"
grep '^FAIL' "$TMP/plan-st.log" "$TMP/verdict-st.log" || true

# The stub: holds the private lock for 0.25 s (exclusive in the timing phase, shared otherwise),
# records its start and end, writes the run's quiet-lock summary. g7live-gsw-timing exits 1 with
# only typed unavailable rows; native-rust-gate0 also links a foreign run holding a summary.
mkdir -p "$TMP/foreign"
cat >"$TMP/foreign/quiet-lock-summary.json" <<'JSON'
{"modes": {"shared": {"holds": 9, "hold_s_total": 999, "wait_s_total": 999},
           "exclusive": {"holds": 9, "hold_s_total": 999, "wait_s_total": 999}}}
JSON
cat >"$TMP/stub.sh" <<'STUB'
set -u
d="$RS_VALIDATE_DIR"
plan="$(dirname "$d")/plan.json"
phase="$(python3 -c 'import json,sys; print(next(r["phase"] for r in json.load(open(sys.argv[1]))["runs"] if r["id"] == sys.argv[2]))' "$plan" "$RS_VALIDATE_ID")"
mode=shared
[ "$phase" = timing ] && mode=exclusive
mkdir -p "$d/run"
t0="$EPOCHREALTIME"
bash "$STUB_Q" "$mode" --label "stub:$RS_VALIDATE_ID" --log "$d/run/quiet-lock.jsonl" -- sleep 0.25
printf '%s %s %s %s\n' "$RS_VALIDATE_ID" "$phase" "$t0" "$EPOCHREALTIME" >>"$STUB_TIMES"
bash "$STUB_Q" summary "$d/run/quiet-lock.jsonl" --out "$d/run/quiet-lock-summary.json" >/dev/null
env | grep -E '^(RS_FAST_FRAMES|RS_FAST_FRAMES_MAX_FPS|GATE7_FAST_FRAMES|RS_SABOTAGE_TIER)=' | sort >"$d/stub-env.txt"
case "$RS_VALIDATE_ID" in
native-rust-gate0)
	ln -s "$STUB_FOREIGN" "$d/run/view"
	;;
g7live-gsw-timing)
	cat >"$d/run/result.json" <<'JSON'
{"gate_passed": false, "results": [{"checks": [
 {"id": "lc@gsw:sim-hidden-2s", "passed": true, "gating": true},
 {"id": "real-suspension@gsw-device:hidden-2s", "passed": false, "gating": true, "status": "unavailable", "detail": "no device run"},
 {"id": "real-suspension@gsw-device:frozen-30s", "passed": false, "gating": true, "status": "unavailable", "detail": "no device run"}]}]}
JSON
	exit 1
	;;
esac
exit 0
STUB
OUT="$TMP/out"
STUB_Q="$Q" STUB_TIMES="$TMP/times.txt" STUB_FOREIGN="$TMP/foreign" RS_VALIDATE_STUB="$TMP/stub.sh" \
	bash "$SCRIPT_DIR/validate-increment.sh" --milestone -j 4 --out "$OUT" \
	--paths experiments/render-stream/scripts/lib/gate3-checks.ts >"$TMP/validate.log" 2>&1
vrc=$?
check "the stubbed milestone sweep passes (rc 0)" "[ $vrc = 0 ]"
[ "$vrc" = 0 ] || tail -20 "$TMP/validate.log"

check "every planned run ran" "[ \$(wc -l <'$TMP/times.txt') = \$(python3 -c 'import json; print(len(json.load(open(\"$OUT/plan.json\"))[\"runs\"]))') ]"
check "the timing phase starts after every correctness run ended" "python3 - '$TMP/times.txt' <<'PY'
import sys
rows = [l.split() for l in open(sys.argv[1])]
t = [(float(a), float(b)) for i, p, a, b in rows if p == 'timing']
c = [(float(a), float(b)) for i, p, a, b in rows if p != 'timing']
sys.exit(0 if t and c and min(a for a, b in t) >= max(b for a, b in c) else 1)
PY"
check "the timing runs include native gate 6 and the -timing live runs" \
	"grep -q '^native-rust-gate6 timing' '$TMP/times.txt' && grep -q '^g7live-gsw-timing timing' '$TMP/times.txt' && grep -q '^g7live-native-timing timing' '$TMP/times.txt'"
check "no shared hold overlaps an exclusive one" "python3 - '$OUT' <<'PY'
import glob, json, sys
h = []
for f in glob.glob(sys.argv[1] + '/*/run/quiet-lock-summary.json'):
    for x in json.load(open(f))['holds']:
        h.append((x['mode'], x['start_t'], x['start_t'] + x['hold_s']))
ex = [x for x in h if x[0] == 'exclusive']
sh = [x for x in h if x[0] == 'shared']
bad = [(a, b) for a in ex for b in sh if a[1] < b[2] and b[1] < a[2]]
sys.exit(0 if ex and sh and not bad else 1)
PY"
check "the planner never pairs the native receiver with g7-lc" "python3 - '$OUT/plan.json' <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
sys.exit(0 if all(set(r['groups']) <= {'g7-r'} for r in p['runs'] if r.get('receiver') == 'native') else 1)
PY"
check "the milestone plans g7-r and g7-k in each browser's -timing run" "python3 - '$OUT/plan.json' <<'PY'
import json, sys
r = {x['id']: x for x in json.load(open(sys.argv[1]))['runs']}
sys.exit(0 if all({'g7-r', 'g7-k'} <= set(r['g7live-' + k + '-timing']['groups']) for k in ('gsw', 'web-rust')) else 1)
PY"
S="$OUT/validate-summary.json"
check "typed unavailable rows: the run passes and the summary lists them" "python3 - '$S' <<'PY'
import json, sys
r = {x['id']: x for x in json.load(open(sys.argv[1]))['runs']}['g7live-gsw-timing']
sys.exit(0 if r['rc'] == '0' and len(r['unavailable']) == 2 and not r['failing'] else 1)
PY"
check "the summary has per-run phase, wall, lock wait and hold (own summaries only)" "python3 - '$S' <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
ok = s['schema'] == 'render-stream-validate-summary/2' and set(s['phases']) == {'setup', 'native', 'g7', 'timing'}
for x in s['runs']:
    ok &= x['wall_s'] is not None and x['wall_s'] > 0 and x['lock_hold_s'] >= 0.2 and x['lock_summaries'] == 1
    ok &= x['lock']['exclusive' if x['phase'] == 'timing' else 'shared']['holds'] == 1
g0 = {x['id']: x for x in s['runs']}['native-rust-gate0']
ok &= g0['lock_wait_s'] < 900 and g0['lock_hold_s'] < 900  # the symlinked foreign summary is not counted
sys.exit(0 if ok else 1)
PY"
# Item 7: fast frames under --milestone.
fast_of() { grep -c '^RS_FAST_FRAMES=all$' "$OUT/$1/stub-env.txt"; }
g7fast_of() { grep -c '^GATE7_FAST_FRAMES=1$' "$OUT/$1/stub-env.txt"; }
check "--milestone: native runs get RS_FAST_FRAMES=all (lib/legs.sh picks the legs)" \
	"[ \$(fast_of native-rust-gate1) = 1 ] && [ \$(fast_of native-rust-gate6) = 1 ]"
check "--milestone: the correctness live runs run fast, Chromium unthrottled" \
	"[ \$(fast_of g7live-gsw) = 1 ] && [ \$(g7fast_of g7live-gsw) = 1 ] && [ \$(fast_of g7live-web-rust) = 1 ]"
check "--milestone: timing live runs, file groups and g7x stay real time" \
	"[ \$(fast_of g7live-gsw-timing) = 0 ] && [ \$(fast_of g7live-native-timing) = 0 ] && [ \$(fast_of g7-gsw) = 0 ] && [ \$(fast_of g7x) = 0 ]"
check "--milestone: every sabotage leg runs (no RS_SABOTAGE_TIER=skip)" "! grep -q RS_SABOTAGE_TIER '$OUT'/native-*/stub-env.txt"
check "fast-frames.txt records on for the milestone" "grep -q '^fast_frames=on' '$OUT/fast-frames.txt'"
legs_fast() { # <env file> <runner> <timing group> <leg>: lib/legs.sh's decision under that env
	env $(cat "$1") OUT="$TMP/legs" SCRIPT_DIR="$SCRIPT_DIR" bash -c "
		LEGS_LOG=$2; source '$SCRIPT_DIR/lib/gamescope.sh'; source '$SCRIPT_DIR/lib/legs.sh'
		LEGS_TIMING_GROUP='$3'; legs_fast_applies \"\$OUT/$4\" && echo yes || echo no" 2>/dev/null
}
mkdir -p "$TMP/legs"
check "under the milestone env an allowlisted leg (g1d live-stall) runs fast" \
	"[ \"\$(legs_fast '$OUT/native-rust-gate1/stub-env.txt' run-gate1 g1d live-stall/host)\" = yes ]"
check "under the milestone env every gate 6 timing leg stays real time" \
	"[ \"\$(legs_fast '$OUT/native-rust-gate6/stub-env.txt' run-gate6 g6l live/host)\" = no ] && [ \"\$(legs_fast '$OUT/native-rust-gate6/stub-env.txt' run-gate6 g6c rates/host)\" = no ]"
check "under the milestone env the g1c rate leg stays real time" \
	"[ \"\$(legs_fast '$OUT/native-rust-gate1/stub-env.txt' run-gate1 g1c-rate live-rate-30/host)\" = no ]"
# Item 8: --plan --milestone --base is a delta sweep, plain --milestone the complete one.
bash "$SCRIPT_DIR/validate-increment.sh" --plan --milestone --base HEAD --out "$TMP/delta" >/dev/null 2>&1
check "--plan --milestone --base REF records a delta sweep over that diff" \
	"python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); sys.exit(0 if p[\"milestone\"] == \"delta\" and p[\"base\"] == \"HEAD\" and p[\"tier\"] == \"full\" else 1)' '$TMP/delta/plan.json'"
check "--milestone without --base stays complete" \
	"python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); sys.exit(0 if p[\"milestone\"] == \"complete\" and p[\"base\"] is None else 1)' '$OUT/plan.json'"

# R2: RS_SKIP_TIMING_GROUPS (remote workflow only). legs_skip_group is inert unless the env is 1; set,
# it marks each leg dir skipped-remote.txt and tier-verdict excuses exactly the checks naming them.
skip_group() { # <env value or ""> <dir>
	env OUT="$TMP/skip" RS_SKIP_TIMING_GROUPS="$1" bash -c "
		LEGS_LOG=run-gate1; source '$SCRIPT_DIR/lib/gamescope.sh'; source '$SCRIPT_DIR/lib/legs.sh'
		legs_skip_group g1d \"\$OUT/live-stall\" \"\$OUT/live-reconnect\" && echo skipped || echo ran" 2>/dev/null
}
mkdir -p "$TMP/skip"
check "RS_SKIP_TIMING_GROUPS unset: legs_skip_group runs the group and writes nothing" \
	"[ \"\$(skip_group '')\" = ran ] && [ -z \"\$(ls -A '$TMP/skip')\" ]"
check "RS_SKIP_TIMING_GROUPS=0: still runs the group" "[ \"\$(skip_group 0)\" = ran ] && [ -z \"\$(ls -A '$TMP/skip')\" ]"
check "RS_SKIP_TIMING_GROUPS=1: skips the group, a marker in every leg dir" \
	"[ \"\$(skip_group 1)\" = skipped ] && grep -q 'timing group g1d' '$TMP/skip/live-stall/skipped-remote.txt' && [ -f '$TMP/skip/live-reconnect/skipped-remote.txt' ]"
cat >"$TMP/stub-remote.sh" <<'STUB'
d="$RS_VALIDATE_DIR"
mkdir -p "$d/run/live-stall/host" "$d/run/live-ok"
echo '{}' >"$d/run/live-ok/applied.json"
cat >"$d/run/result.json" <<'JSON'
{"gate_passed": false, "checks": [
 {"id": "a", "passed": true},
 {"id": "g1d-stall-recovery", "passed": false, "detail": "live-stall: no receiver evidence"}]}
JSON
if [ "${RS_SKIP_TIMING_GROUPS:-}" = 1 ]; then
	echo "skipped-remote: RS_SKIP_TIMING_GROUPS=1 (timing group g1d: wall-clock legs stay local)" >"$d/run/live-stall/host/skipped-remote.txt"
else
	echo '{}' >"$d/run/live-stall/host/applied.json"
fi
exit 1
STUB
for mode in unset 1; do
	envs=(); [ "$mode" = 1 ] && envs=(RS_SKIP_TIMING_GROUPS=1)
	env ${envs[@]+"${envs[@]}"} RS_VALIDATE_STUB="$TMP/stub-remote.sh" \
		bash "$SCRIPT_DIR/validate-increment.sh" --milestone --only native-rust-gate1 --out "$TMP/remote-$mode" \
		--paths experiments/render-stream/scripts/lib/gate3-checks.ts >"$TMP/remote-$mode.log" 2>&1
	echo $? >"$TMP/remote-$mode.rc"
done
check "without the env a failing check naming a leg is a failed run (local behaviour unchanged)" \
	"[ \"\$(cat '$TMP/remote-unset.rc')\" = 1 ] && [ \"\$(cat '$TMP/remote-unset/native-rust-gate1/rc')\" = 1 ]"
check "with the env that check is excused: the full run passes, rc 0" \
	"[ \"\$(cat '$TMP/remote-1.rc')\" = 0 ] && [ \"\$(cat '$TMP/remote-1/native-rust-gate1/rc')\" = 0 ]"
check "the summary lists the skipped timing group and leg per run (skipped_remote[])" "python3 - '$TMP/remote-1/validate-summary.json' <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))['runs'][0]
sys.exit(0 if r['skipped_remote'] == ['live-stall/host'] and r['skipped_remote_groups'] == ['g1d'] else 1)
PY"
# R3: a remote run whose runner passed (gate 7: its sources excuse their skipped timing checks in
# source-run-valid) still lists the skipped groups in the summary, and stays a pass.
cat >"$TMP/stub-remote-pass.sh" <<'STUB'
d="$RS_VALIDATE_DIR"
mkdir -p "$d/run/sources-made/gate1/live-stall" "$d/run/gate1/gsw/receiver"
echo '{}' >"$d/run/gate1/gsw/receiver/applied.json"
echo '{"gate_passed": true, "checks": [{"id": "source-run-valid@gsw", "passed": true}]}' >"$d/run/result.json"
echo "skipped-remote: RS_SKIP_TIMING_GROUPS=1 (timing group g1d: wall-clock legs stay local)" >"$d/run/sources-made/gate1/live-stall/skipped-remote.txt"
exit 0
STUB
env RS_SKIP_TIMING_GROUPS=1 RS_VALIDATE_STUB="$TMP/stub-remote-pass.sh" \
	bash "$SCRIPT_DIR/validate-increment.sh" --milestone --only native-rust-gate1 --out "$TMP/remote-pass" \
	--paths experiments/render-stream/scripts/lib/gate3-checks.ts >"$TMP/remote-pass.log" 2>&1
echo $? >"$TMP/remote-pass.rc"
check "a passing remote run lists its skipped timing groups and stays a pass" "python3 - '$TMP/remote-pass' <<'PY'
import json, sys
r = json.load(open(sys.argv[1] + '/validate-summary.json'))['runs'][0]
rc = open(sys.argv[1] + '.rc').read().strip()
sys.exit(0 if rc == '0' and r['rc'] == '0' and r['skipped_remote_groups'] == ['g1d'] else 1)
PY"
check "a different failing check stays real beside a skipped-remote leg" "python3 - '$SCRIPT_DIR' <<'PY'
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location('tv', sys.argv[1] + '/lib/tier-verdict.py')
tv = importlib.util.module_from_spec(spec); spec.loader.exec_module(tv)
with tempfile.TemporaryDirectory() as d:
    os.makedirs(d + '/live-stall'); os.makedirs(d + '/other')
    open(d + '/live-stall/skipped-remote.txt', 'w').write('skipped-remote: timing group g1d')
    open(d + '/other/a.json', 'w').write('{}')
    json.dump({'checks': [{'id': 'pixels', 'passed': False, 'detail': 'differs'}]}, open(d + '/result.json', 'w'))
    sys.exit(0 if tv.verdict(d, False, '', 1)['verdict'] == 'fail' else 1)
PY"
# R2: an --only id the plan does not contain warns (it is not an error) instead of a silent 0/0.
RS_VALIDATE_STUB="$TMP/stub.sh" STUB_Q="$Q" STUB_TIMES="$TMP/times2.txt" STUB_FOREIGN="$TMP/foreign" \
	bash "$SCRIPT_DIR/validate-increment.sh" --only native-rust-gate99,pure --out "$TMP/unplanned" \
	--paths experiments/render-stream/scripts/lib/gate3-checks.ts >"$TMP/unplanned.log" 2>&1
check "an unplanned --only id prints a warning naming it and the way to force it" \
	"grep -q 'WARNING --only native-rust-gate99: not in this plan' '$TMP/unplanned.log' && grep -q -- '--paths' '$TMP/unplanned.log'"
check "the warning is not an error: the planned ids still run" "grep -q 'pure rc=0' '$TMP/unplanned.log'"

echo "self-test-validate-tier: $([ "$fails" = 0 ] && echo "all pass" || echo "$fails FAIL")"
[ "$fails" = 0 ]
