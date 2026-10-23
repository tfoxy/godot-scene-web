#!/usr/bin/env bash
# validate-increment.sh -- the GRT smoke tier (results/grt.md; gate7-design.md "Scoped re-runs and
# milestone sweeps"): maps an increment's diff to the receivers, cores, gates and gate 7 groups it
# can reach (scripts/smoke-map.json, through lib/smoke-plan.py) and runs only those.
#
#   bash experiments/render-stream/scripts/validate-increment.sh [--base main] [--out DIR] \
#     [--plan] [--milestone] [--only id,id] [-j N] [--timing-jobs N] [--paths p1,p2]
#
#   --plan       print the plan (targets, sabotage decision, runs) and exit
#   --tier T     smoke (default): one representative leg per reached live group and receiver, one
#                receiver leg per file group (smoke-map.json "smoke"); full: every leg of the
#                reached groups, run once at the end of the increment
#   --milestone  the complete sweep: every target, every sabotage leg. With an explicit --base REF,
#                the delta sweep (GRT4a): the full tier over the targets the diff since REF reaches,
#                every sabotage leg of those (a capture, wire or unmatched path still reaches
#                every target)
#   --fast-frames on|off
#                GRT3 (scripts/README.md "Fast frames (GRT3)"): run the allowlisted live correctness
#                legs faster than real time (RS_FAST_FRAMES=all, RS_FAST_FRAMES_MAX_FPS=--fast-fps,
#                and GATE7_FAST_FRAMES=1 on the g7-1/g7-2/g7-5/g7-55 live runs). Default on for every
#                tier, --milestone included (GRT4a). Every timing leg and every denylisted leg stays
#                real time either way (lib/legs.sh RS_FAST_ALLOW_LEGS / RS_FAST_DENY_LEGS; the
#                g7-6/g7-lc/g7-r/g7-k live runs and g7x never get the fast env).
#   --fast-fps N the fast-frame rate (default 240)
#   --base REF   the diff is `git diff --name-only REF...HEAD` plus uncommitted and untracked
#                files (default main; lib/smoke-plan.py --print-paths); --paths replaces it with an
#                explicit list
#   --only       run only these run ids (from --plan)
#   -j N         up to N runs at once within a phase (default 1). Phases run in order (each run's
#                plan `phase`, GRT4a): setup (pure self-tests, lock tests, builds, crates); native
#                (native correctness gates; rust-core full runs are published to the source cache,
#                so gate 7 reuses them); g7 (gate 7 file groups and correctness live groups); then
#                timing (native gate 6, the g7-6/g7-lc/g7-r/g7-k live runs, g7x), after everything else
#                so their exclusive legs never stall a correctness run of the same tier
#   --timing-jobs N
#                runs at once in the timing phase (default 1)
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
# Typed unavailable rows (GRT4a): a native or gate 7 run whose runner exits 1 is re-judged by
# lib/tier-verdict.py --runner-rc 1; when the only failing rows are typed `unavailable` (desktop
# g7-lc's real-suspension rows), the run passes and the summary lists those rows.
#
# Writes <out>/plan.json, one directory per run (with command.txt: the env and argv it launched),
# and <out>/validate-summary.json (per run: phase, wall time, quiet-lock wait and hold per mode from
# the run's own quiet-lock-summary.json files, unavailable rows); prints one line per run and exits
# non-zero when any run fails. RS_VALIDATE_STUB=<script> (self-tests only) runs that script instead
# of every runner, with the same env plus RS_VALIDATE_ID/KIND/DIR/ARGV.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
BASE=main
BASE_SET=0
TIMING_JOBS=1
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
	--base) BASE="$2" && BASE_SET=1 && shift 2 ;;
	--timing-jobs) TIMING_JOBS="$2" && shift 2 ;;
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
# GRT3/GRT4a: fast frames on for every tier, milestone sweeps included: they apply to the
# allowlisted correctness legs only, and every timing leg keeps real time (lib/legs.sh).
[ -n "$FAST_FRAMES" ] || FAST_FRAMES=on
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
	python3 "$SCRIPT_DIR/lib/smoke-plan.py" --repo "$REPO_ROOT" --base "$BASE" --print-paths \
		>"$OUT/changed-paths.txt" || exit 2
fi
PLAN_ARGS=(--tier "$TIER")
[ "$MILESTONE" = 1 ] && PLAN_ARGS+=(--milestone)
# --milestone with an explicit --base is the delta sweep (the diff's targets, every leg).
[ "$MILESTONE" = 1 ] && [ "$BASE_SET" = 1 ] && PLAN_ARGS+=(--base "$BASE")
python3 "$SCRIPT_DIR/lib/smoke-plan.py" --map "$SCRIPT_DIR/smoke-map.json" --repo "$REPO_ROOT" \
	"${PLAN_ARGS[@]}" --paths-from "$OUT/changed-paths.txt" >"$OUT/plan.json" || exit 2
python3 - "$OUT/plan.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
if p["milestone"]:
    print(f"validate-increment: milestone sweep, {p['milestone']}" + (f" (the diff since {p['base']})" if p.get("base") else ""))
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
    print(f"  run {r['id']}: [{r['phase']}] {r['kind']} {extra if isinstance(extra, str) else ','.join(extra)}{note}")
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

# launch <dir> <env assignment...> -- <command...>: records the env and argv in <dir>/command.txt,
# then runs the command under that env (or RS_VALIDATE_STUB with the same env, for the self-tests).
launch() {
	local dir="$1" && shift
	local -a e=()
	while [ "$1" != -- ]; do e+=("$1") && shift; done
	shift
	{
		printf 'env:'
		printf ' %q' ${e[@]+"${e[@]}"}
		printf '\nargv:'
		printf ' %q' "$@"
		printf '\n'
	} >"$dir/command.txt"
	if [ -n "${RS_VALIDATE_STUB:-}" ]; then
		env ${e[@]+"${e[@]}"} RS_VALIDATE_ID="$(basename "$dir")" RS_VALIDATE_KIND="$LAUNCH_KIND" RS_VALIDATE_DIR="$dir" \
			RS_VALIDATE_ARGV="$*" bash "$RS_VALIDATE_STUB"
	else
		env ${e[@]+"${e[@]}"} "$@"
	fi
}

# run_one <id> <kind> <json>: one plan entry, into $OUT/<id>/, rc in $OUT/<id>/rc.
run_one() {
	local id="$1" kind="$2" js="$3" dir="$OUT/$1" rc=0 judged=0
	mkdir -p "$dir"
	local t0="$EPOCHREALTIME"
	LAUNCH_KIND="$kind"
	field() { python3 -c "import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print('' if v is None else ','.join(v) if isinstance(v, list) else str(v).lower() if isinstance(v, bool) else v)" "$js" "$1"; }
	case "$kind" in
	pure)
		launch "$dir" -- bash "$SCRIPT_DIR/test/run-pure-self-tests.sh" --out "$dir" >"$dir/run.log" 2>&1 || rc=$?
		;;
	lock-tests)
		launch "$dir" -- bash -c 'rc=0; bash "$1" --out "$3/quiet" || rc=$?; bash "$2" --out "$3/sched" || rc=$?; exit $rc' _ \
			"$SCRIPT_DIR/test/self-test-quiet.sh" "$SCRIPT_DIR/test/self-test-quiet-sched.sh" "$dir" >"$dir/run.log" 2>&1 || rc=$?
		;;
	capture-build)
		launch "$dir" -- bash "$SCRIPT_DIR/build-capture.sh" >"$dir/run.log" 2>&1 || rc=$?
		;;
	cargo)
		local crate
		crate="$(field crate)"
		launch "$dir" -- bash "$Q" shared --label "validate:cargo:$(basename "$crate")" -- \
			bash -c "cd '$REPO_ROOT/$crate' && cargo test --offline --release" >"$dir/run.log" 2>&1 || rc=$?
		;;
	bench-instr)
		# R4: instruction counts, so load cannot disturb them: no timing lock, a shared one for the build
		launch "$dir" -- bash "$Q" shared --label validate:bench-instr -- \
			bash "$SCRIPT_DIR/bench-instr.sh" --out "$dir/run" >"$dir/run.log" 2>&1 || rc=$?
		;;
	pnpm-test)
		launch "$dir" -- bash "$Q" shared --label validate:pnpm-test -- bash -c "cd '$REPO_ROOT' && mise exec -- pnpm test" \
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
		launch "$dir" "${env[@]}" -- bash "$runner" --extension "$EXT" --calibration "$CAL" --out "$dir/run" \
			>"$dir/run.log" 2>&1 || rc=$?
		# The tier verdict: with sabotage skipped, exactly the checks that name a skipped sabotage
		# leg may fail (lib/tier-verdict.py); a run with every leg keeps the runner's own verdict
		# (apart from typed unavailable rows, below).
		if [ "$sab" != true ]; then
			python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --sabotage-skipped --runner-rc "$rc" \
				>"$dir/tier-verdict.json" 2>&1 && rc=0 || rc=1
			judged=1
		fi
		# A rust-core full run with every leg feeds gate 7's source cache.
		if [ "$rc" = 0 ] && [ "$core" = rust ] && [ "$sab" = true ] && [ "$gate" != gate-minus1 ] &&
			[ -z "${RS_VALIDATE_STUB:-}" ]; then
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
		# R3: a remote job runs one group of a multi-group gate 7 run (remote-validate.yml's matrix,
		# RS_VALIDATE_GROUPS; never set locally): the run keeps its id, the merge folds the jobs
		if [ -n "${RS_VALIDATE_GROUPS:-}" ]; then
			groups="$(python3 -c 'import sys; w=set(sys.argv[2].split(",")); print(",".join(g for g in sys.argv[1].split(",") if g in w))' \
				"$groups" "$RS_VALIDATE_GROUPS")"
			if [ -z "$groups" ]; then
				echo "validate-increment: $id has none of RS_VALIDATE_GROUPS=$RS_VALIDATE_GROUPS" >"$dir/run.log"
				echo 2 >"$dir/rc"
				echo 0 >"$dir/wall_s"
				echo "validate-increment: $id rc=2 (no group of RS_VALIDATE_GROUPS)"
				return
			fi
		fi
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
		launch "$dir" ${genv[@]+"${genv[@]}"} -- bash "$SCRIPT_DIR/run-gate7.sh" "${args[@]}" >"$dir/run.log" 2>&1 || rc=$?
		if [ -n "$sl_live$sl_file" ]; then
			python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --smoke-legs "$sl_live" --runner-rc "$rc" \
				>"$dir/tier-verdict.json" 2>&1 && rc=0 || rc=1
			judged=1
		fi
		;;
	esac
	# GRT4a: a whole run whose runner exited 1 passes when its only failing rows are typed
	# unavailable (desktop g7-lc's real-suspension rows); the verdict lists them.
	if [ "$judged" = 0 ] && [ "$rc" = 1 ] && [ -f "$dir/run/result.json" ]; then
		python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --runner-rc "$rc" \
			>"$dir/tier-verdict.json" 2>&1 && rc=0 || rc=1
	elif [ "$judged" = 0 ] && [ "$rc" = 0 ] && [ -n "${RS_SKIP_TIMING_GROUPS:-}" ] && [ -f "$dir/run/result.json" ]; then
		# R3: a remote run that passed still lists the timing groups it skipped (a gate 7 run's
		# sources excuse theirs inside source-run-valid, so its runner exits 0): the verdict is
		# recorded for the summary's skipped_remote[], never to change the runner's pass
		python3 "$SCRIPT_DIR/lib/tier-verdict.py" --run "$dir/run" --runner-rc 0 >"$dir/tier-verdict.json" 2>&1 || true
	fi
	echo "$rc" >"$dir/rc"
	python3 -c "import sys; print(round(float(sys.argv[2].replace(',','.')) - float(sys.argv[1].replace(',','.')), 1))" \
		"$t0" "$EPOCHREALTIME" >"$dir/wall_s"
	echo "validate-increment: $id rc=$rc ($(cat "$dir/wall_s") s)"
}

# An --only id the plan does not contain would silently validate nothing ("0/0 runs pass"): say so.
if [ -n "$ONLY" ]; then
	python3 - "$OUT/plan.json" "$ONLY" <<'PY' >&2
import json, sys
planned = {r["id"] for r in json.load(open(sys.argv[1]))["runs"]}
bad = [i for i in sys.argv[2].split(",") if i and i not in planned]
if bad:
    print(f"validate-increment: WARNING --only {','.join(bad)}: not in this plan (it reaches: {', '.join(sorted(planned)) or 'nothing'}), so "
          "nothing runs for it. Force it in with --paths <a file it covers> or --milestone.")
PY
fi

mapfile -t RUNS < <(python3 -c "
import json, sys
p = json.load(open(sys.argv[1]))
only = set(filter(None, sys.argv[2].split(',')))
phase = {'setup': 0, 'native': 1, 'g7': 2, 'timing': 3}
for r in p['runs']:
    if only and r['id'] not in only:
        continue
    print(f\"{phase[r['phase']]}\t{r['id']}\t{r['kind']}\t{json.dumps(r)}\")
" "$OUT/plan.json" "$ONLY")

t_all="$EPOCHREALTIME"
for phase in 0 1 2 3; do
	limit="$JOBS"
	[ "$phase" = 3 ] && limit="$TIMING_JOBS"
	for line in ${RUNS[@]+"${RUNS[@]}"}; do
		IFS=$'\t' read -r ph id kind js <<<"$line"
		[ "$ph" = "$phase" ] || continue
		while [ "$(jobs -rp | wc -l)" -ge "$limit" ]; do sleep 0.2; done
		run_one "$id" "$kind" "$js" &
	done
	wait
done

python3 "$SCRIPT_DIR/lib/validate-summary.py" "$OUT" "$t_all" "$EPOCHREALTIME"
