#!/usr/bin/env bash
# Self-test of scripts/lib/quiet.sh and its TS twin lib/quiet-lock.ts (the measurement-isolation
# lock; results/measurement-isolation.md). Runs against a PRIVATE lock (GSW_QUIET_DIR under a
# temporary directory), never the machine-wide one, so it is safe beside real runs. ~40 s.
#
#   bash experiments/render-stream/scripts/test/self-test-quiet.sh [--out DIR]
#
# Cases: exclusive/shared semantics (4), the waiter marker against a stream of shared holders
# (and the same stream with the marker disabled, to show the starvation it prevents), stale
# markers (dead pid, recycled pid, expired age, and a live one that is honoured), nesting (CLI in
# CLI in every mode pair, the library re-entrant and upgrading, a runner calling a runner), crash
# release (owner SIGKILLed, holder SIGKILLed), the run log and its summary, core pinning, and the TS
# twin (acquire/release, nested under a bash hold, exclusion against bash). Prints one PASS/FAIL
# line per case and exits non-zero on any FAIL.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
Q="$SCRIPT_DIR/lib/quiet.sh"
OUT=""
if [ "${1:-}" = "--out" ]; then
	OUT="$2"
fi
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/self-test-quiet.XXXXXX")"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
export GSW_QUIET_DIR="$OUT/lockdir"
unset GSW_QUIET_LOCK RS_TIMING_CPUSET RS_BACKGROUND_CPUSET GSW_QUIET_MARKER_MAX_S
rm -rf "$GSW_QUIET_DIR"
LOG="$OUT/self-test.jsonl"
: >"$LOG"
FAILS=0
PASSES=0

pass() {
	PASSES=$((PASSES + 1))
	echo "PASS $1"
}
fail() {
	FAILS=$((FAILS + 1))
	echo "FAIL $1"
}
# check <name> <condition words...>
check() {
	local name="$1"
	shift
	if "$@"; then pass "$name"; else fail "$name"; fi
}
now() { echo "${EPOCHREALTIME/,/.}"; }
# ge/lt on decimal seconds
fge() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)" "$1" "$2"; }
flt() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$1" "$2"; }
since() { python3 -c "import sys; print(round(float(sys.argv[2]) - float(sys.argv[1]), 3))" "$1" "$(now)"; }
qsh() { bash "$Q" "$@"; }
# timed <cmd...>: runs it (10 s guard against a deadlock) and prints its elapsed seconds.
timed() {
	local t0
	t0="$(now)"
	timeout 10 "$@" >/dev/null 2>&1
	echo "$?" >"$OUT/timed.rc"
	since "$t0"
}
settle() { sleep 0.3; }

echo "self-test-quiet: private lock under $GSW_QUIET_DIR"

# --- 1. semantics -----------------------------------------------------------------------------
qsh exclusive --label hold-x --log "$LOG" -- sleep 1.2 &
settle
e="$(timed bash "$Q" exclusive --label x-after-x --log "$LOG" -- true)"
wait
check "exclusive excludes exclusive (waited ${e}s >= 0.6)" fge "$e" 0.6

qsh shared --label hold-s --log "$LOG" -- sleep 1.2 &
settle
e="$(timed bash "$Q" shared --label s-beside-s --log "$LOG" -- true)"
wait
check "shared holders run together (waited ${e}s < 0.5)" flt "$e" 0.5

qsh shared --label hold-s --log "$LOG" -- sleep 1.2 &
settle
e="$(timed bash "$Q" exclusive --label x-after-s --log "$LOG" -- true)"
wait
check "shared excludes exclusive (waited ${e}s >= 0.6)" fge "$e" 0.6

qsh exclusive --label hold-x --log "$LOG" -- sleep 1.2 &
settle
e="$(timed bash "$Q" shared --label s-after-x --log "$LOG" -- true)"
wait
check "exclusive excludes shared (waited ${e}s >= 0.6)" fge "$e" 0.6

# --- 2. no starvation: a stream of overlapping shared holders ---------------------------------
# A new 0.8-s shared holder every 0.3 s for 7 s keeps the lock shared-held throughout. An exclusive
# request 1 s in must get its turn within about one shared hold; with the marker disabled it waits
# for the whole stream to end.
stream() {
	local end=$(($(date +%s%N) / 1000000 + 7000)) i=0
	while [ $(($(date +%s%N) / 1000000)) -lt "$end" ]; do
		qsh shared --label "stream-$i" --log "$1" -- sleep 0.8 &
		i=$((i + 1))
		sleep 0.3
	done
	wait
}
starve_case() {
	local label="$1" no_marker="$2" log="$OUT/starve-$1.jsonl"
	: >"$log"
	stream "$log" &
	local spid=$!
	sleep 1
	local e
	e="$(GSW_QUIET_SELFTEST_NO_MARKER="$no_marker" timed bash "$Q" exclusive --label "x-$label" --log "$log" -- sleep 0.2)"
	wait "$spid"
	echo "$e"
}
e="$(starve_case marker 0)"
check "waiter marker: exclusive gets its turn in a shared stream (waited ${e}s < 2.0)" flt "$e" 2.0
e_off="$(starve_case no-marker 1)"
check "control: without the marker the same stream starves it (waited ${e_off}s >= 4.0)" fge "$e_off" 4.0
# Every shared hold that STARTED while the exclusive waited (after its request) began only after
# the exclusive released, or was already blocked in flock when the marker appeared (at most a few).
late="$(python3 - "$OUT/starve-marker.jsonl" <<'PY'
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1])]
x_acq = next(e for e in ev if e["event"] == "acquire" and e["label"] == "x-marker")
x_req = x_acq["t"] - x_acq["wait_s"]
x_rel = next(e for e in ev if e["event"] == "release" and e["label"] == "x-marker")["t"]
print(sum(1 for e in ev if e["event"] == "acquire" and e["mode"] == "shared"
          and x_req + 0.25 < e["t"] < x_rel))
PY
)"
check "waiter marker: no shared hold starts while the exclusive waits ($late started)" [ "$late" = 0 ]

# --- 3. stale markers -------------------------------------------------------------------------
W="$GSW_QUIET_DIR/quiet.lock.waiters"
mkdir -p "$W"
sh -c 'exit 0' &
dead=$!
wait "$dead"
echo "$dead 123 $EPOCHSECONDS 1 dead-owner" >"$W/$dead"
e="$(timed bash "$Q" shared --label after-dead-marker --log "$LOG" -- true)"
ok=0
flt "$e" 0.5 && [ ! -e "$W/$dead" ] && ok=1
check "stale marker: dead pid is ignored (waited ${e}s < 0.5) and removed" [ "$ok" = 1 ]

sleep 30 &
live=$!
echo "$live 1 $EPOCHSECONDS 1 recycled-pid" >"$W/$live"
e="$(timed bash "$Q" shared --label after-recycled-marker --log "$LOG" -- true)"
check "stale marker: a live pid with other start ticks is ignored (waited ${e}s < 0.5)" flt "$e" 0.5

live_ticks="$(sed 's/.*) //' "/proc/$live/stat" | awk '{print $20}')"
echo "$live $live_ticks $((EPOCHSECONDS - 100)) 1 expired" >"$W/$live"
e="$(GSW_QUIET_MARKER_MAX_S=5 timed bash "$Q" shared --label after-expired-marker --log "$LOG" -- true)"
check "stale marker: an expired one is ignored (waited ${e}s < 0.5)" flt "$e" 0.5

sleep 2 &
fresh=$!
fresh_ticks="$(sed 's/.*) //' "/proc/$fresh/stat" | awk '{print $20}')"
echo "$fresh $fresh_ticks $EPOCHSECONDS 1 live-waiter" >"$W/$fresh"
e="$(timed bash "$Q" shared --label after-live-marker --log "$LOG" -- true)"
check "a live marker is honoured until its waiter is gone (waited ${e}s >= 1.2)" fge "$e" 1.2
kill "$live" 2>/dev/null
wait 2>/dev/null

# --- 4. nesting -------------------------------------------------------------------------------
for outer in exclusive shared; do
	for inner in exclusive shared; do
		: >"$OUT/nest.jsonl"
		e="$(timed bash "$Q" "$outer" --label "outer-$outer" --log "$OUT/nest.jsonl" -- bash "$Q" "$inner" --label "inner-$inner" --log "$OUT/nest.jsonl" -- true)"
		rc="$(cat "$OUT/timed.rc")"
		want=nested
		[ "$outer" = shared ] && [ "$inner" = exclusive ] && want=nested-unisolated
		got="$(grep -c "\"event\":\"$want\"" "$OUT/nest.jsonl")"
		ok=0
		[ "$rc" = 0 ] && [ "$got" = 1 ] && flt "$e" 2 && ok=1
		check "nesting: $inner inside $outer returns (rc $rc, ${e}s) logged $want" [ "$ok" = 1 ]
	done
done

cat >"$OUT/lib-nest.sh" <<EOF
source "$Q"
QUIET_LOG="$OUT/lib-nest.jsonl"
quiet_acquire exclusive lib-outer
quiet_acquire shared lib-inner
quiet_release
holders=\$(ls "$GSW_QUIET_DIR/quiet.lock.holders" | wc -l)
quiet_release
after=\$(ls "$GSW_QUIET_DIR/quiet.lock.holders" | wc -l)
echo "\$holders \$after"
quiet_acquire shared lib-up
quiet_acquire exclusive lib-up-x
mode=\$(cut -d' ' -f5 "$GSW_QUIET_DIR"/quiet.lock.holders/*)
quiet_release
quiet_release
echo "\$mode"
# a runner calling a runner: the inner one locks again in its own process
quiet_acquire exclusive runner-outer
bash -c 'source "$Q"; QUIET_LOG="$OUT/lib-nest.jsonl"; quiet_acquire exclusive runner-inner; quiet_release; echo inner-done'
quiet_release
EOF
: >"$OUT/lib-nest.jsonl"
res="$(timeout 15 bash "$OUT/lib-nest.sh" 2>/dev/null | tr '\n' ' ')"
check "library: re-entrant (1 holder while nested, 0 after: '$res')" [ "${res%% exclusive*}" = "1 0" ]
check "library: an exclusive inside its own shared hold upgrades ('$res')" bash -c "[[ '$res' == *' exclusive inner-done '* ]]"
check "library: a runner calling a runner nests instead of deadlocking" bash -c "grep -q '\"event\":\"nested\".*runner-inner' '$OUT/lib-nest.jsonl'"

# --- 5. crash release -------------------------------------------------------------------------
{ bash -c "source '$Q'; quiet_acquire exclusive crashing-owner; kill -9 \$\$"; } 2>/dev/null
e="$(timed bash "$Q" exclusive --label after-owner-crash --log "$LOG" -- true)"
check "owner SIGKILLed while holding: the lock frees within 1 s (${e}s)" flt "$e" 1.0

qsh exclusive --label victim --log "$LOG" -- sleep 5 &
vpid=$!
settle
hpid="$(cut -d' ' -f1 "$GSW_QUIET_DIR"/quiet.lock.holders/* 2>/dev/null | head -1)"
kill -9 "$hpid" 2>/dev/null
e="$(timed bash "$Q" exclusive --label after-holder-crash --log "$LOG" -- true)"
kill "$vpid" 2>/dev/null
wait 2>/dev/null
check "holder SIGKILLed: the kernel frees the lock at once (${e}s < 0.5)" flt "$e" 0.5

# --- 6. log and summary -----------------------------------------------------------------------
qsh summary "$LOG" --out "$OUT/summary.json" >"$OUT/summary.txt"
check "summary: exclusive and shared holds counted from the run log" python3 -c "
import json, sys
s = json.load(open('$OUT/summary.json'))
x, sh = s['modes']['exclusive'], s['modes']['shared']
sys.exit(0 if x['holds'] >= 6 and sh['holds'] >= 6 and x['hold_s_total'] > 1 and s['wall_s'] > 0 else 1)"
check "log: every acquire has wait_s and every release hold_s" python3 -c "
import json, sys
ev = [json.loads(l) for l in open('$LOG')]
ok = all('wait_s' in e for e in ev if e['event'] == 'acquire') and all('hold_s' in e for e in ev if e['event'] == 'release')
sys.exit(0 if ok and ev else 1)"

# --- 7. core pinning --------------------------------------------------------------------------
orig="$(taskset -pc $$ | sed 's/.*: *//')"
cat >"$OUT/pin.sh" <<EOF
source "$Q"
QUIET_LOG="$OUT/pin.jsonl"
sleep 5 &
child=\$!
quiet_acquire exclusive pinned
a=\$(taskset -pc \$child | sed 's/.*: *//')
b=\$(sh -c 'taskset -pc \$\$' | sed 's/.*: *//')
quiet_release
c=\$(taskset -pc \$child | sed 's/.*: *//')
d=\$(taskset -pc \$\$ | sed 's/.*: *//')
kill \$child
echo "\$a|\$b|\$c|\$d"
EOF
res="$(RS_TIMING_CPUSET=0 timeout 15 bash "$OUT/pin.sh")"
check "pinning: RS_TIMING_CPUSET pins the owner's tree and new children, release restores ('$res')" [ "$res" = "0|0|$orig|$orig" ]
res="$(RS_BACKGROUND_CPUSET=1 timeout 10 bash "$Q" shared --label bg -- sh -c 'taskset -pc $$' | sed 's/.*: *//')"
check "pinning: RS_BACKGROUND_CPUSET pins a shared hold's command ('$res')" [ "$res" = 1 ]

# --- 8. the TS twin ---------------------------------------------------------------------------
cat >"$OUT/twin.mts" <<EOF
import { quietAcquire } from "$SCRIPT_DIR/lib/quiet-lock.ts";
const mode = process.argv[2] as "shared" | "exclusive";
const hold = await quietAcquire(mode, "ts-" + mode, { log: "$OUT/twin.jsonl" });
console.log(hold.state + " " + hold.waitS.toFixed(3));
await new Promise((r) => setTimeout(r, Number(process.argv[3] ?? "0")));
await hold.release();
EOF
TSX=(mise exec -- pnpm exec tsx --conditions=development)
: >"$OUT/twin.jsonl"
res="$(cd "$REPO_ROOT" && timeout 30 "${TSX[@]}" "$OUT/twin.mts" exclusive 0 2>&1 | tail -1)"
check "TS twin: acquires and releases ('$res')" bash -c "[[ '$res' == acquired* ]] && grep -q '\"event\":\"release\".*ts-exclusive' '$OUT/twin.jsonl'"
res="$(cd "$REPO_ROOT" && timeout 30 bash "$Q" exclusive --label bash-outer --log "$OUT/twin.jsonl" -- "${TSX[@]}" "$OUT/twin.mts" exclusive 0 2>&1 | tail -1)"
check "TS twin: nested under a bash runner's hold ('$res')" bash -c "[[ '$res' == nested* ]]"
(cd "$REPO_ROOT" && timeout 30 "${TSX[@]}" "$OUT/twin.mts" exclusive 2500 >/dev/null 2>&1) &
tpid=$!
# wait until the TS hold is registered, then a bash exclusive must wait for it
for _ in $(seq 1 100); do
	grep -q '"event":"acquire".*ts-exclusive' <(tail -1 "$OUT/twin.jsonl") && break
	sleep 0.1
done
e="$(timed bash "$Q" exclusive --label bash-after-ts --log "$OUT/twin.jsonl" -- true)"
wait "$tpid"
check "TS twin: its hold excludes a bash exclusive (waited ${e}s >= 1.0)" fge "$e" 1.0

echo "self-test-quiet: $PASSES passed, $FAILS failed (evidence: $OUT)"
[ "$FAILS" = 0 ]
