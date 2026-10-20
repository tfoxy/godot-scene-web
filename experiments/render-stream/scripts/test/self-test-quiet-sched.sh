#!/usr/bin/env bash
# Self-test of lib/quiet.sh's share-window scheduling (GRT, results/grt.md) and of its
# compatibility with the v1 lock code other worktrees still run (test/quiet-fixtures/quiet-v1.sh,
# a frozen copy of lib/quiet.sh as of 821606d3). Private lock (GSW_QUIET_DIR under a temp dir), so it
# is safe beside real runs. ~4 min.
#
#   bash experiments/render-stream/scripts/test/self-test-quiet-sched.sh [--out DIR]
#
# The workload reproduces the G7o3 starvation: one runner runs K back-to-back exclusive "timing"
# legs, while two other runners each run M short shared legs in sequence with a small gap (the
# per-leg lock of a correctness gate). Under v1 each shared runner gets about one leg per exclusive
# leg. It runs four ways -- exclusive side v1|v2 x shared side v1|v2 -- and checks, from each
# command's own start/end timestamps (taken INSIDE the hold, so they are the real lock intervals):
#   - exclusion: no exclusive command overlaps any other command, in every mix;
#   - starvation: v1/v1 runs about one shared leg per exclusive gap; v2/v2 several, and finishes
#     the shared work much sooner;
#   - mixed v1-exclusive/v2-shared and v2-exclusive/v1-shared: exclusion holds, nobody starves;
#   - bound: a v2 exclusive waits at most about one window plus one shared leg behind a continuous
#     shared stream;
#   - backfill: behind one long shared leg that an exclusive waits on, short shared legs whose
#     history says they end before it run meanwhile, without delaying the exclusive (and none run
#     under GSW_QUIET_SCHED=v1);
#   - `quiet.sh light` holds nothing: it runs straight through an exclusive hold.
# Prints one PASS/FAIL line per check and exits non-zero on any FAIL.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QV2="$SCRIPT_DIR/lib/quiet.sh"
QV1="$SCRIPT_DIR/test/quiet-fixtures/quiet-v1.sh"
OUT=""
[ "${1:-}" != "--out" ] || OUT="$2"
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/self-test-quiet-sched.XXXXXX")"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
unset GSW_QUIET_LOCK RS_QUIET_LOCK_DIR RS_TIMING_CPUSET RS_BACKGROUND_CPUSET GSW_QUIET_MARKER_MAX_S GSW_QUIET_SCHED
unset GSW_QUIET_SHARE_PCT GSW_QUIET_SHARE_MIN_S GSW_QUIET_SHARE_MAX_S GSW_QUIET_SHARE_LINGER_S
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
check() {
	local name="$1"
	shift
	if "$@"; then pass "$name"; else fail "$name"; fi
}

V1_SHA="e511cfccb4c79d85354ecfac5d355c0ca8aa7692bbe2c611cf62e84b77c13887"
check "fixture: quiet-v1.sh is the frozen v1 lock code (sha256 ${V1_SHA:0:12})" \
	bash -c "[ \"\$(sha256sum '$QV1' | cut -d' ' -f1)\" = '$V1_SHA' ]"

K=8  # exclusive legs: the soak runner outlasts the shared work, as another increment's soaks do
XS=4 # each holds 4 s (so a default 50 % share window is 2 s)
M=12 # shared legs per shared runner
SS=0.5 # runner sa's legs hold 0.5 s, runner sb's 0.7 s (so they drift apart)

# leg <quiet.sh> <mode> <label> <secs> <intervals file>: one leg; the command records its own
# start/end inside the hold.
leg() {
	local q="$1" mode="$2" label="$3" secs="$4" iv="$5"
	bash "$q" "$mode" --label "$label" --log "$CASE/lock.jsonl" -- \
		bash -c 's=$EPOCHREALTIME; sleep "$1"; printf "%s %s %s %s\n" "$2" "$3" "$s" "$EPOCHREALTIME" >>"$4"' _ \
		"$secs" "$mode" "$label" "$iv" 2>/dev/null
}
x_runner() {
	local q="$1" i
	for i in $(seq 1 "$K"); do
		leg "$q" exclusive "x$i" "$XS" "$CASE/iv.txt"
		sleep 0.2
	done
	echo "$EPOCHREALTIME" >"$CASE/x.done"
}
s_runner() {
	local q="$1" name="$2" secs="$3" i
	for i in $(seq 1 "$M"); do
		leg "$q" shared "$name-$i" "$secs" "$CASE/iv.txt"
		sleep 0.2
	done
	echo "$EPOCHREALTIME" >"$CASE/$name.done"
}

# run_case <name> <exclusive-side quiet.sh> <shared-side quiet.sh>
run_case() {
	CASE="$OUT/$1"
	rm -rf "$CASE"
	mkdir -p "$CASE"
	export GSW_QUIET_DIR="$CASE/lockdir"
	echo "$EPOCHREALTIME" >"$CASE/t0"
	x_runner "$2" &
	local xp=$!
	sleep 0.5
	s_runner "$3" sa "$SS" &
	local sa=$!
	sleep 0.1
	s_runner "$3" sb 0.7 &
	local sb=$!
	wait "$xp" "$sa" "$sb"
	python3 - "$CASE" "$K" "$M" >"$CASE/analysis.txt" <<'PY'
import sys
case, K, M = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
iv = []
for line in open(f"{case}/iv.txt"):
    mode, label, s, e = line.split()
    iv.append((float(s.replace(",", ".")), float(e.replace(",", ".")), mode, label))
xs = sorted(i for i in iv if i[2] == "exclusive")
overlaps = sum(1 for x in xs for o in iv if o is not x and o[0] < x[1] and x[0] < o[1])
t0 = float(open(f"{case}/t0").read().replace(",", "."))
s_done = max(float(open(f"{case}/{n}.done").read().replace(",", ".")) for n in ("sa", "sb"))
x_done = float(open(f"{case}/x.done").read().replace(",", "."))
# shared legs that STARTED in each gap between consecutive exclusive legs, per shared runner,
# over the gaps that closed while that runner still had legs to run
gaps = []
for r in ("sa", "sb"):
    done = float(open(f"{case}/{r}.done").read().replace(",", "."))
    for a, b in zip(xs, xs[1:]):
        if b[0] < done:
            gaps.append(sum(1 for o in iv if o[3].startswith(r + "-") and a[1] <= o[0] < b[0]))
per_gap = sum(gaps) / len(gaps) if gaps else 0.0
during = sum(1 for o in iv if o[2] == "shared" and o[0] < xs[-1][0])
print(f"overlaps={overlaps} per_gap={per_gap:.2f} shared_before_last_x={during} "
      f"x_span={x_done - t0:.1f} s_span={s_done - t0:.1f} legs={len(iv)}")
PY
	cat "$CASE/analysis.txt"
}
field() { sed -n "s/.*$2=\([0-9.]*\).*/\1/p" "$OUT/$1/analysis.txt"; }
fge() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)" "$1" "$2"; }
fle() { python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)" "$1" "$2"; }

echo "self-test-quiet-sched: private locks under $OUT"
# --- 1. starvation: v1 everywhere (the G7o3 pattern) vs v2 everywhere -------------------------
run_case v1-v1 "$QV1" "$QV1"
run_case v2-v2 "$QV2" "$QV2"
check "exclusion v1/v1: no exclusive leg overlaps another leg ($(field v1-v1 overlaps))" [ "$(field v1-v1 overlaps)" = 0 ]
check "exclusion v2/v2: no exclusive leg overlaps another leg ($(field v2-v2 overlaps))" [ "$(field v2-v2 overlaps)" = 0 ]
check "starvation reproduced under v1: <= 1.5 shared legs per runner per exclusive gap ($(field v1-v1 per_gap))" \
	fle "$(field v1-v1 per_gap)" 1.5
check "starvation fixed under v2: >= 2 shared legs per runner per exclusive gap ($(field v2-v2 per_gap))" \
	fge "$(field v2-v2 per_gap)" 2
v1s="$(field v1-v1 s_span)"
v2s="$(field v2-v2 s_span)"
check "v2 finishes the shared work sooner (v2 ${v2s}s <= 0.8 x v1 ${v1s}s)" \
	fle "$v2s" "$(python3 -c "print(0.8 * $v1s)")"
v2x="$(field v2-v2 x_span)"
check "v2 does not starve the exclusive runner (exclusive span ${v2x}s <= 3 x ${K} x ${XS}s)" fle "$v2x" $((3 * K * XS))

# --- 2. compatibility: mixed old and new holders on one lock -----------------------------------
run_case v1x-v2s "$QV1" "$QV2"
run_case v2x-v1s "$QV2" "$QV1"
check "mixed v1 exclusive + v2 shared: no overlap ($(field v1x-v2s overlaps))" [ "$(field v1x-v2s overlaps)" = 0 ]
check "mixed v2 exclusive + v1 shared: no overlap ($(field v2x-v1s overlaps))" [ "$(field v2x-v1s overlaps)" = 0 ]
# (A v1 exclusive does not defer, so it still takes the lock at the first instant no shared leg
# holds it; v2 shared legs can only bypass its marker while another shared leg holds on. This mix
# is transitional -- it lasts until every worktree has merged v2 -- so it only must not regress.)
check "mixed v1 exclusive + v2 shared: no worse than v1/v1 ($(field v1x-v2s per_gap) >= $(field v1-v1 per_gap) shared legs per gap)" \
	fge "$(field v1x-v2s per_gap)" "$(field v1-v1 per_gap)"
check "mixed v1 exclusive + v2 shared: the v1 exclusive runner is not starved ($(field v1x-v2s x_span)s <= $((3 * K * XS)))" \
	fle "$(field v1x-v2s x_span)" $((3 * K * XS))
check "mixed v2 exclusive + v1 shared: v1 shared runners finish ($(field v2x-v1s legs) legs = $((K + 2 * M)))" \
	[ "$(field v2x-v1s legs)" = $((K + 2 * M)) ]
check "mixed v2 exclusive + v1 shared: the v2 exclusive runner is not starved ($(field v2x-v1s x_span)s <= $((3 * K * XS)))" \
	fle "$(field v2x-v1s x_span)" $((3 * K * XS))
nb="$(grep -c '"bypassed_v1_marker":true' "$OUT/v1x-v2s/lock.jsonl" || true)"
echo "info: mixed v1 exclusive + v2 shared: $nb shared acquires bypassed a v1 marker inside a window"

# --- 3. bound: a v2 exclusive behind a continuous shared stream --------------------------------
# A 3-s exclusive hold opens a 1.5-s window (50 %); a stream of overlapping 0.8-s shared holds starts
# right after; a second exclusive requested in the window must get in within about the window plus
# one shared hold (and must not jump the window: it waits at least most of it).
CASE="$OUT/bound"
rm -rf "$CASE"
mkdir -p "$CASE"
export GSW_QUIET_DIR="$CASE/lockdir"
bash "$QV2" exclusive --label first --log "$CASE/lock.jsonl" -- sleep 3
(
	end=$(($(date +%s%N) / 1000000 + 6000))
	while [ $(($(date +%s%N) / 1000000)) -lt "$end" ]; do
		bash "$QV2" shared --label stream --log "$CASE/lock.jsonl" -- sleep 0.8 2>/dev/null &
		sleep 0.3
	done
	wait
) &
sp=$!
sleep 0.2
t0="$EPOCHREALTIME"
bash "$QV2" exclusive --label second --log "$CASE/lock.jsonl" -- true 2>/dev/null
waited="$(python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 2))" "$t0" "$EPOCHREALTIME")"
wait "$sp"
check "bound: a v2 exclusive waits about one window + one shared hold behind a stream (${waited}s in [0.8, 3.5])" \
	bash -c "python3 -c 'import sys; sys.exit(0 if 0.8 <= float(sys.argv[1]) <= 3.5 else 1)' '$waited'"
d="$(grep '"label":"second"' "$CASE/lock.jsonl" | grep -o '"deferred_s":[0-9.]*' | head -1 | cut -d: -f2)"
check "bound: the deferral is logged (deferred_s ${d:-missing} > 0.5)" bash -c "[ -n '$d' ] && python3 -c 'import sys; sys.exit(0 if float(sys.argv[1]) > 0.5 else 1)' '$d'"

# --- 4. no demand: an exclusive inside a window, with nobody waiting, barely defers -------------
CASE="$OUT/no-demand"
rm -rf "$CASE"
mkdir -p "$CASE"
export GSW_QUIET_DIR="$CASE/lockdir"
bash "$QV2" exclusive --label first --log "$CASE/lock.jsonl" -- sleep 4
t0="$EPOCHREALTIME"
bash "$QV2" exclusive --label second --log "$CASE/lock.jsonl" -- true 2>/dev/null
waited="$(python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 2))" "$t0" "$EPOCHREALTIME")"
check "no demand: an exclusive in an open window with no shared demand waits ~1 s (${waited}s <= 1.8)" fle "$waited" 1.8

# --- 5. backfill behind a long drain ---------------------------------------------------------
# A 6-s shared leg "long" holds; 0.5 s later an exclusive asks (no window: no exclusive release yet)
# and waits for it to drain; 1 s in, a runner loops 0.5-s shared legs "short" until the exclusive is
# done. With history for both labels, v2 admits the short legs that fit before "long" ends.
backfill_case() {
	local name="$1" sched="$2"
	CASE="$OUT/$name"
	rm -rf "$CASE"
	mkdir -p "$CASE"
	export GSW_QUIET_DIR="$CASE/lockdir"
	GSW_QUIET_SCHED="$sched" bash "$QV2" shared --label long --log "$CASE/seed.jsonl" -- sleep 6
	GSW_QUIET_SCHED="$sched" bash "$QV2" shared --label short --log "$CASE/seed.jsonl" -- sleep 0.5
	GSW_QUIET_SCHED="$sched" leg "$QV2" shared long 6 "$CASE/iv.txt" &
	local lp=$!
	sleep 0.5
	(GSW_QUIET_SCHED="$sched" leg "$QV2" exclusive x 0.5 "$CASE/iv.txt" && echo "$EPOCHREALTIME" >"$CASE/x.done") &
	local xp=$!
	sleep 0.5
	(
		while [ ! -f "$CASE/x.done" ]; do
			GSW_QUIET_SCHED="$sched" leg "$QV2" shared short 0.5 "$CASE/iv.txt"
			sleep 0.1
		done
	) &
	local sp=$!
	wait "$lp" "$xp" "$sp"
	python3 - "$CASE" >"$CASE/analysis.txt" <<'PY'
import sys
case = sys.argv[1]
iv = []
for line in open(f"{case}/iv.txt"):
    mode, label, s, e = line.split()
    iv.append((float(s.replace(",", ".")), float(e.replace(",", ".")), mode, label))
x = next(i for i in iv if i[2] == "exclusive")
long_ = next(i for i in iv if i[3] == "long")
overlaps = sum(1 for o in iv if o is not x and o[0] < x[1] and x[0] < o[1])
during = sum(1 for o in iv if o[3] == "short" and o[0] < x[0])
print(f"overlaps={overlaps} short_during_drain={during} x_after_long={x[0] - long_[1]:.2f}")
PY
	cat "$CASE/analysis.txt"
}
backfill_case backfill-v2 v2
backfill_case backfill-v1 v1
check "backfill: no overlap with the exclusive (v2 $(field backfill-v2 overlaps), v1 $(field backfill-v1 overlaps))" \
	[ "$(field backfill-v2 overlaps)$(field backfill-v1 overlaps)" = 00 ]
check "backfill: v2 runs short legs during the drain ($(field backfill-v2 short_during_drain) >= 2)" \
	[ "$(field backfill-v2 short_during_drain)" -ge 2 ]
check "backfill: v1 control runs none ($(field backfill-v1 short_during_drain))" [ "$(field backfill-v1 short_during_drain)" = 0 ]
check "backfill: the exclusive is not delayed past the long leg (starts $(field backfill-v2 x_after_long)s after it <= 0.8)" \
	fle "$(field backfill-v2 x_after_long)" 0.8
nb="$(grep -c '"backfill":true' "$OUT/backfill-v2/lockdir/quiet.lock.events.log" || true)"
check "backfill: logged on the acquire ($nb)" [ "$nb" -ge 2 ]

# --- 6. light holds nothing ---------------------------------------------------------------------
CASE="$OUT/light"
rm -rf "$CASE"
mkdir -p "$CASE"
export GSW_QUIET_DIR="$CASE/lockdir"
bash "$QV2" exclusive --label hold-x --log "$CASE/lock.jsonl" -- sleep 2 &
sleep 0.4
t0="$EPOCHREALTIME"
bash "$QV2" light --label pure --log "$CASE/lock.jsonl" -- true
waited="$(python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 2))" "$t0" "$EPOCHREALTIME")"
wait
check "light: runs straight through an exclusive hold (${waited}s < 0.5)" fle "$waited" 0.5
check "light: logged as a light event" grep -q '"event":"light"' "$CASE/lock.jsonl"
bash "$QV2" light -- false
check "light: returns the command's exit status" [ $? = 1 ]

echo "self-test-quiet-sched: $PASSES passed, $FAILS failed (evidence: $OUT)"
[ "$FAILS" = 0 ]
