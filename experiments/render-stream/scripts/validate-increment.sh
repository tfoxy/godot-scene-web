#!/usr/bin/env bash
# validate-increment.sh -- the GRT smoke tier (results/grt.md; gate7-design.md "Scoped re-runs and
# milestone sweeps"): maps an increment's diff to the receivers, cores, gates and gate 7 groups it
# can reach (scripts/smoke-map.json, through lib/smoke-plan.py) and runs only those.
#
#   bash experiments/render-stream/scripts/validate-increment.sh [--base main] [--out DIR] \
#     [--plan] [--milestone] [--only id,id] [-j N] [--paths p1,p2]
#
#   --plan       print the plan (targets, sabotage decision, runs) and exit
#   --tier T     smoke (default): one representative leg per reached live group and receiver, one
#                receiver leg per file group (smoke-map.json "smoke"); full: every leg of the
#                reached groups, run once at the end of the increment
#   --milestone  the full sweep: every target, every sabotage leg
#   --fast-frames on|off
#                GRT3 (scripts/README.md "Fast frames (GRT3)"): run the allowlisted live correctness
#                legs faster than real time (RS_FAST_FRAMES=all, RS_FAST_FRAMES_MAX_FPS=--fast-fps,
#                and GATE7_FAST_FRAMES=1 on the g7-1/g7-2/g7-5/g7-55 live runs). Default on for
#                --tier smoke and full, off under --milestone (sweeps keep real time). Timing legs and
#                every denylisted leg stay real time either way (lib/legs.sh).
#   --fast-fps N the fast-frame rate (default 240)
#   --base REF   the diff is `git diff --name-only REF...HEAD` plus uncommitted and untracked
#                files (default main); --paths replaces it with an explicit list
#   --only       run only these run ids (from --plan)
#   -j N         up to N runs at once within a phase (default 1). Phases run in order: pure
#                self-tests, lock tests and builds; native gates (rust-core full runs are
#                published to the source cache, so gate 7 reuses them); then gate 7.
#
# The tiers:
#   pure     every run: golden checks and self-test-*.ts, holding no lock (test/run-pure-self-tests.sh)
#   scoped   the plan's targets; a changed file no rule matches reaches EVERY target
#   sabotage native sabotage legs run only when a checker, runner, sabotage or mutation file is in
#            the diff (smoke-map.json sabotage_paths / sabotage_content); otherwise the runners get
#            RS_SABOTAGE_TIER=skip and their sabotage checks are reported skipped-by-tier, not
#            failed (any other failing check still fails the run)
#   milestone --milestone: everything; the orchestrator's sweeps
#
# Writes <out>/plan.json, one directory per run, and <out>/validate-summary.json; prints one line
# per run and exits non-zero when any run fails.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
BASE=main
OUT=""
PLAN_ONLY=0
MILESTONE=0
TIER=smoke
ONLY=""
JOBS=1
PATHS=""
FAST_FRAMES=""
FAST_FPS=240
while [ $# -gt 0 ]; do
	case "$1" in
	--base) BASE="$2" && shift 2 ;;
	--out) OUT="$2" && shift 2 ;;
	--plan) PLAN_ONLY=1 && shift ;;
	--milestone) MILESTONE=1 && shift ;;
	--tier) TIER="$2" && shift 2 ;;
	--only) ONLY="$2" && shift 2 ;;
	-j) JOBS="$2" && shift 2 ;;
	--paths) PATHS="$2" && shift 2 ;;
	--fast-frames) FAST_FRAMES="$2" && shift 2 ;;
	--fast-fps) FAST_FPS="$2" && shift 2 ;;
	*) echo "validate-increment: unknown argument $1" >&2 && exit 2 ;;
	esac
done
# GRT3: fast frames on for the smoke and full tiers, off for milestone sweeps (real time).
if [ -z "$FAST_FRAMES" ]; then
	FAST_FRAMES=on
	[ "$MILESTONE" = 1 ] && FAST_FRAMES=off
fi
case "$FAST_FRAMES" in
on | off) ;;
*) echo "validate-increment: --fast-frames must be on or off" >&2 && exit 2 ;;
esac
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/validate/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"

if [ -n "$PATHS" ]; then
	tr ',' '\n' <<<"$PATHS" >"$OUT/changed-paths.txt"
else
	{
		git -C "$REPO_ROOT" diff --name-only "$BASE...HEAD"
		git -C "$REPO_ROOT" diff --name-only HEAD
		git -C "$REPO_ROOT" ls-files --others --exclude-standard
	} | sort -u >"$OUT/changed-paths.txt"
fi
python3 "$SCRIPT_DIR/lib/smoke-plan.py" --map "$SCRIPT_DIR/smoke-map.json" --repo "$REPO_ROOT" \
	--tier "$TIER" $([ "$MILESTONE" = 1 ] && echo --milestone) --paths-from "$OUT/changed-paths.txt" >"$OUT/plan.json" || exit 2
python3 - "$OUT/plan.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(f"validate-increment: {len(p['paths'])} changed paths, {len(p['unmatched'])} unmatched (reach everything)")
for u in p["unmatched"][:10]:
    print(f"  unmatched: {u}")
print(f"validate-increment: {len(p['targets'])} targets; {len(p['skipped_targets'])} out of reach")
print(f"validate-increment: sabotage legs {'RUN' if p['sabotage']['run'] else 'skipped-by-tier'}"
      + (f" ({p['sabotage']['why'][0]}{' ...' if len(p['sabotage']['why']) > 1 else ''})" if p['sabotage']['why'] else ""))
smoke = full = 0
for r in p["runs"]:
    extra = r.get("groups") or r.get("gate") or r.get("crate") or ""
    sl = r.get("smoke_legs")
    note = ""
    if sl:
        note = "  [smoke: " + ", ".join(f"{g} {n} leg{'s' if n != 1 else ''}" for g, n in sl.items()) + (
            f" of {r['full_legs']}" if r.get("full_legs") else "") + "]"
        smoke += sum(sl.values())
    print(f"  run {r['id']}: {r['kind']} {extra if isinstance(extra, str) else ','.join(extra)}{note}")
print(f"validate-increment: tier {p['tier']}; {smoke} representative legs in filtered runs "
      f"({sum(1 for r in p['runs'] if r.get('smoke_legs'))} runs); every other run is whole; "
      f"{len(p['smoke_deferred'])} group targets deferred to the full tier")
PY
echo "validate-increment: fast frames $FAST_FRAMES$([ "$FAST_FRAMES" = on ] && echo " (--max-fps $FAST_FPS on allowlisted live legs; lib/legs.sh)")"
[ "$PLAN_ONLY" = 1 ] && exit 0
printf 'fast_frames=%s\nfast_fps=%s\n' "$FAST_FRAMES" "$FAST_FPS" >"$OUT/fast-frames.txt"
FAST_ENV=()
[ "$FAST_FRAMES" = on ] && FAST_ENV=(RS_FAST_FRAMES=all RS_FAST_FRAMES_MAX_FPS="$FAST_FPS")

EXT="$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension"
CAL="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
Q="$SCRIPT_DIR/lib/quiet.sh"

# run_one <id> <kind> <json>: one plan entry, into $OUT/<id>/, rc in $OUT/<id>/rc.
run_one() {
	local id="$1" kind="$2" js="$3" dir="$OUT/$1" rc=0
	mkdir -p "$dir"
	local t0="$EPOCHREALTIME"
	field() { python3 -c "import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print('' if v is None else ','.join(v) if isinstance(v, list) else str(v).lower() if isinstance(v, bool) else v)" "$js" "$1"; }
	case "$kind" in
	pure)
		bash "$SCRIPT_DIR/test/run-pure-self-tests.sh" --out "$dir" >"$dir/run.log" 2>&1 || rc=$?
		;;
	lock-tests)
		bash "$SCRIPT_DIR/test/self-test-quiet.sh" --out "$dir/quiet" >"$dir/run.log" 2>&1 || rc=$?
		bash "$SCRIPT_DIR/test/self-test-quiet-sched.sh" --out "$dir/sched" >>"$dir/run.log" 2>&1 || rc=$?
		;;
	capture-build)
		bash "$SCRIPT_DIR/build-capture.sh" >"$dir/run.log" 2>&1 || rc=$?
		;;
	cargo)
		local crate
		crate="$(field crate)"
		bash "$Q" shared --label "validate:cargo:$(basename "$crate")" -- \
			bash -c "cd '$REPO_ROOT/$crate' && cargo test --offline --release" >"$dir/run.log" 2>&1 || rc=$?
		;;
	pnpm-test)
		bash "$Q" shared --label validate:pnpm-test -- bash -c "cd '$REPO_ROOT' && mise exec -- pnpm test" \
			>"$dir/run.log" 2>&1 || rc=$?
		;;
	native)
		local gate core sab runner
		gate="$(field gate)"
		core="$(field core)"
		sab="$(field sabotage)"
		runner="$SCRIPT_DIR/run-${gate}.sh"
		local -a env=(RS_RECEIVER_CORE="$core" ${FAST_ENV[@]+"${FAST_ENV[@]}"})
		[ "$sab" = true ] || env+=(RS_SABOTAGE_TIER=skip)
		env "${env[@]}" bash "$runner" --extension "$EXT" --calibration "$CAL" --out "$dir/run" \
			>"$dir/run.log" 2>&1 || rc=$?
		# The tier verdict: with sabotage skipped, exactly the checks that name a skipped sabotage
		# leg may fail (lib/tier-verdict.py); a run with every leg keeps the runner's own verdict.
		if [ "$sab" != true ]; then
			python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --sabotage-skipped \
				>"$dir/tier-verdict.json" 2>&1 && rc=0 || rc=1
		fi
		# A rust-core full run with every leg feeds gate 7's source cache.
		if [ "$rc" = 0 ] && [ "$core" = rust ] && [ "$sab" = true ] && [ "$gate" != gate-minus1 ]; then
			(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-tool.ts" \
				source-provenance --extension "$EXT" --calibration "$CAL" --out "$dir/run/gate7-source.json") >>"$dir/run.log" 2>&1 &&
				bash "$SCRIPT_DIR/source-cache.sh" publish "$(bash "$SCRIPT_DIR/source-cache.sh" key)" "$gate" all "$dir/run" \
					>"$dir/source-cache.txt" 2>&1 || true
		fi
		;;
	g7 | g7live | g7x)
		local recv groups
		recv="$(field receiver)"
		groups="$(field groups)"
		local -a args=(--legs "$groups" --out "$dir/run" --extension "$EXT" --calibration "$CAL")
		[ "$kind" = g7 ] && args+=(--make-sources)
		[ "$kind" = g7live ] && args+=(--live)
		local -a genv=()
		local sl_live sl_file
		sl_live="$(field rs_smoke_legs)"
		sl_file="$(field gate7_smoke_legs)"
		[ -z "$sl_live" ] || genv+=(RS_SMOKE_LEGS="$sl_live")
		[ -z "$sl_file" ] || genv+=(GATE7_SMOKE_LEGS="$sl_file")
		# GRT3: only the live groups whose legs are allowlisted get fast frames (and an unthrottled
		# Chromium); g7-6, g7-lc, g7-r and g7-k are timing groups and keep real time.
		if [ "$kind" = g7live ] && [ "${#FAST_ENV[@]}" -gt 0 ] &&
			python3 -c 'import sys; sys.exit(0 if set(sys.argv[1].split(",")) <= {"g7-1", "g7-2", "g7-5", "g7-55"} else 1)' "$groups"; then
			genv+=("${FAST_ENV[@]}" GATE7_FAST_FRAMES=1)
		fi
		case "$recv" in
		gsw) args+=(--receiver gsw) ;;
		native) args+=(--receiver native) ;;
		web/*) args+=(--receiver web --web-core "${recv#web/}") ;;
		esac
		env ${genv[@]+"${genv[@]}"} bash "$SCRIPT_DIR/run-gate7.sh" "${args[@]}" >"$dir/run.log" 2>&1 || rc=$?
		if [ -n "$sl_live$sl_file" ]; then
			python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --smoke-legs "$sl_live" \
				>"$dir/tier-verdict.json" 2>&1 && rc=0 || rc=1
		fi
		;;
	esac
	echo "$rc" >"$dir/rc"
	python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 1))" \
		"$t0" "$EPOCHREALTIME" >"$dir/wall_s"
	echo "validate-increment: $id rc=$rc ($(cat "$dir/wall_s") s)"
}

mapfile -t RUNS < <(python3 -c "
import json, sys
p = json.load(open(sys.argv[1]))
only = set(filter(None, sys.argv[2].split(',')))
phase = {'pure': 0, 'lock-tests': 0, 'capture-build': 0, 'cargo': 0, 'pnpm-test': 0, 'native': 1}
for r in p['runs']:
    if only and r['id'] not in only:
        continue
    print(f\"{phase.get(r['kind'], 2)}\t{r['id']}\t{r['kind']}\t{json.dumps(r)}\")
" "$OUT/plan.json" "$ONLY")

t_all="$EPOCHREALTIME"
for phase in 0 1 2; do
	for line in "${RUNS[@]}"; do
		IFS=$'\t' read -r ph id kind js <<<"$line"
		[ "$ph" = "$phase" ] || continue
		while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 1; done
		run_one "$id" "$kind" "$js" &
	done
	wait
done

python3 - "$OUT" "$t_all" "$EPOCHREALTIME" <<'PY'
import glob, json, os, sys
out, t0, t1 = sys.argv[1], float(sys.argv[2].replace(",", ".")), float(sys.argv[3].replace(",", "."))
plan = json.load(open(os.path.join(out, "plan.json")))
rows, failed = [], 0
for r in plan["runs"]:
    d = os.path.join(out, r["id"])
    if not os.path.isdir(d):
        continue
    rc = open(os.path.join(d, "rc")).read().strip() if os.path.exists(os.path.join(d, "rc")) else "missing"
    tier = {}
    if os.path.exists(os.path.join(d, "tier-verdict.json")):
        tier = json.load(open(os.path.join(d, "tier-verdict.json")))
    wait = 0.0
    for q in glob.glob(os.path.join(d, "**", "quiet-lock-summary.json"), recursive=True):
        try:
            s = json.load(open(q))
            wait += s["modes"]["shared"]["wait_s_total"] + s["modes"]["exclusive"]["wait_s_total"]
        except (OSError, ValueError, KeyError):
            pass
    rows.append({"id": r["id"], "rc": rc, "wall_s": float(open(os.path.join(d, "wall_s")).read()),
                 "lock_wait_s": round(wait, 1), "skipped_by_tier": len(tier.get("skipped_by_tier", [])),
                 "failing": tier.get("failing", [])})
    failed += rc != "0"
summary = {"schema": "render-stream-validate-summary/1", "wall_s": round(t1 - t0, 1), "runs": rows,
           "sabotage": plan["sabotage"], "skipped_targets": len(plan["skipped_targets"]), "failed": failed}
json.dump(summary, open(os.path.join(out, "validate-summary.json"), "w"), indent=2)
for x in rows:
    print(f"  {x['id']:<28} rc={x['rc']:<3} {x['wall_s']:>8.1f} s  lock wait {x['lock_wait_s']:>7.1f} s"
          + (f"  skipped-by-tier {x['skipped_by_tier']}" if x["skipped_by_tier"] else ""))
print(f"validate-increment: {len(rows) - failed}/{len(rows)} runs pass in {t1 - t0:.0f} s; "
      f"{len(plan['skipped_targets'])} targets out of reach; summary {out}/validate-summary.json")
sys.exit(1 if failed else 0)
PY
