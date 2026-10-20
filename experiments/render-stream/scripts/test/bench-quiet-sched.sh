#!/usr/bin/env bash
# GRT's synthetic scheduler benchmark (results/grt.md): fake runners on a PRIVATE lock, no Godot.
# One "soak" runner runs X exclusive timing legs (`sleep XS`, default 3 x 20 s) back to back while R
# correctness runners each run L shared legs (`sleep LS`, default 4 runners x 15 legs x 2 s) in
# sequence with a 0.3 s gap -- the pattern that starved G7o3's gate runners behind 6-minute soaks.
# It runs four ways: exclusive side v1|v2 x shared side v1|v2 (v1 = test/quiet-fixtures/quiet-v1.sh,
# the frozen pre-GRT lib/quiet.sh), and reports, from timestamps each leg takes INSIDE its hold:
#   - the invariant: exclusive legs overlapping any other leg (must be 0 in every mix);
#   - total wall, the soak runner's span and the shared runners' finish;
#   - per-leg wait (request to start) for shared and exclusive legs: mean, p95, max;
#   - shared legs started per exclusive gap (v1's starvation signature is 1 per runner).
#
#   bash experiments/render-stream/scripts/test/bench-quiet-sched.sh [--out DIR]
#   (env: X XS R L LS to rescale; D DS add a "checker" runner of D shared legs of DS s, the long
#   holds a timing leg must drain; CASES picks the mixes, default all four. Shared legs are labelled
#   per runner, as a runner's legs recur from run to run, and every label's hold history is seeded
#   as an earlier run would have left it, so v2 can backfill.)
# Exits non-zero if any mix breaks the invariant.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QV2="$SCRIPT_DIR/lib/quiet.sh"
QV1="$SCRIPT_DIR/test/quiet-fixtures/quiet-v1.sh"
OUT=""
[ "${1:-}" != "--out" ] || OUT="$2"
[ -n "$OUT" ] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/bench-quiet-sched.XXXXXX")"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
unset GSW_QUIET_LOCK RS_QUIET_LOCK_DIR RS_TIMING_CPUSET RS_BACKGROUND_CPUSET GSW_QUIET_SCHED
X="${X:-3}" XS="${XS:-20}" R="${R:-4}" L="${L:-15}" LS="${LS:-2}" D="${D:-0}" DS="${DS:-30}"
CASES="${CASES:-v1-v1 v2-v2 v1x-v2s v2x-v1s}"

leg() { # <quiet.sh> <mode> <label> <secs> <file>
	local req="$EPOCHREALTIME"
	bash "$1" "$2" --label "$3" -- \
		bash -c 's=$EPOCHREALTIME; sleep "$1"; printf "%s %s %s %s %s\n" "$2" "$3" "$4" "$s" "$EPOCHREALTIME" >>"$5"' _ \
		"$4" "$2" "$3" "$req" "$5" 2>/dev/null
}
run_case() { # <name> <exclusive-side quiet.sh> <shared-side quiet.sh>
	local c="$OUT/$1" i r
	rm -rf "$c"
	mkdir -p "$c"
	# GSW_QUIET_DIR, not RS_QUIET_LOCK_DIR: the v1 code predates RS_QUIET_LOCK_DIR and would take
	# the MACHINE-WIDE lock instead.
	export GSW_QUIET_DIR="$c/lockdir"
	# Seed each label's history (lib/quiet.sh quiet__record's files) as an earlier run would.
	mkdir -p "$c/lockdir/quiet.lock.stats"
	local lab k
	for lab in chk $(for r in $(seq 1 "$R"); do echo "r$r"; done); do
		k="$(printf '%s' "$lab" | cksum)"
		if [ "$lab" = chk ]; then echo "$DS.000"; else echo "$LS.000"; fi >"$c/lockdir/quiet.lock.stats/${k%% *}"
	done
	local t0="$EPOCHREALTIME"
	if [ "$D" -gt 0 ]; then
		(sleep 2; for i in $(seq 1 "$D"); do leg "$3" shared chk "$DS" "$c/legs.txt"; sleep 5; done) &
	fi
	(for i in $(seq 1 "$X"); do leg "$2" exclusive "x$i" "$XS" "$c/legs.txt"; sleep 0.3; done
		echo "$EPOCHREALTIME" >"$c/x.done") &
	sleep 1
	for r in $(seq 1 "$R"); do
		(for i in $(seq 1 "$L"); do leg "$3" shared "r$r" "$LS" "$c/legs.txt"; sleep 0.3; done
			echo "$EPOCHREALTIME" >"$c/r$r.done") &
		sleep 0.2
	done
	wait
	echo "$t0" >"$c/t0"
	python3 - "$c" "$1" <<'PY'
import glob, json, sys
c, name = sys.argv[1], sys.argv[2]
f = lambda s: float(s.replace(",", "."))
legs = []
for line in open(f"{c}/legs.txt"):
    mode, label, req, s, e = line.split()
    legs.append({"mode": mode, "label": label, "req": f(req), "s": f(s), "e": f(e)})
legs.sort(key=lambda l: l["s"])
t0 = f(open(f"{c}/t0").read())
xs = sorted((l for l in legs if l["mode"] == "exclusive"), key=lambda l: l["s"])
overlaps = sum(1 for x in xs for o in legs if o is not x and o["s"] < x["e"] and x["s"] < o["e"])
def stats(ws):
    ws = sorted(ws)
    return {"n": len(ws), "mean": round(sum(ws) / len(ws), 2), "p95": round(ws[int(0.95 * (len(ws) - 1))], 2), "max": round(ws[-1], 2)}
done = {p.split("/")[-1][:-5]: f(open(p).read()) for p in glob.glob(f"{c}/r*.done")}
gaps = []
for r, d in done.items():
    for a, b in zip(xs, xs[1:]):
        if b["s"] < d:
            gaps.append(sum(1 for l in legs if l["label"] == r and a["e"] <= l["s"] < b["s"]))
res = {"case": name, "overlaps": overlaps, "wall_s": round(max(l["e"] for l in legs) - t0, 1),
       "soak_span_s": round(f(open(f"{c}/x.done").read()) - t0, 1),
       "shared_done_s": round(max(done.values()) - t0, 1),
       "shared_wait": stats([l["s"] - l["req"] for l in legs if l["mode"] == "shared" and l["label"] != "chk"]),
       "exclusive_wait": stats([l["s"] - l["req"] for l in legs if l["mode"] == "exclusive"]),
       "shared_legs_per_runner_per_gap": round(sum(gaps) / len(gaps), 2) if gaps else None}
json.dump(res, open(f"{c}/result.json", "w"), indent=2)
w = res["shared_wait"]; x = res["exclusive_wait"]
print(f"{name:<10} overlaps={overlaps} wall={res['wall_s']}s soak={res['soak_span_s']}s shared-done={res['shared_done_s']}s "
      f"shared wait mean/p95/max={w['mean']}/{w['p95']}/{w['max']}s excl wait max={x['max']}s per-gap={res['shared_legs_per_runner_per_gap']}")
PY
}
echo "bench-quiet-sched: X=$X x ${XS}s exclusive, R=$R runners x L=$L x ${LS}s shared; private locks under $OUT"
for cs in $CASES; do
	case "$cs" in
	v1-v1) run_case v1-v1 "$QV1" "$QV1" ;;
	v2-v2) run_case v2-v2 "$QV2" "$QV2" ;;
	v1x-v2s) run_case v1x-v2s "$QV1" "$QV2" ;;
	v2x-v1s) run_case v2x-v1s "$QV2" "$QV1" ;;
	esac
done
python3 - "$OUT" $CASES <<'PY'
import json, sys
rs = [json.load(open(f"{sys.argv[1]}/{n}/result.json")) for n in sys.argv[2:]]
json.dump(rs, open(f"{sys.argv[1]}/bench.json", "w"), indent=2)
bad = [r["case"] for r in rs if r["overlaps"]]
print(f"bench-quiet-sched: invariant {'BROKEN in ' + ','.join(bad) if bad else f'held in all {len(rs)} mixes (0 overlaps)'}; {sys.argv[1]}/bench.json")
sys.exit(1 if bad else 0)
PY
