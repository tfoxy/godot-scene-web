#!/usr/bin/env bash
# remote-validate.sh -- run validate-increment.sh's runs on GitHub-hosted runners (docs/remote-compute.md).
#
#   scripts/remote-validate.sh [--base main] [--tier smoke|full] [--only id,id] [--paths p1,p2]
#                              [--milestone] [--no-wait] [--collect RUN_KEY] [--and-local] [--dry-run]
#
# Mirrors validate-increment.sh's planning flags. It plans locally (validate-increment.sh --plan),
# splits the runs into remote-capable ones and refused ones (smoke-map.json "remote"), snapshots the
# worktree (uncommitted and untracked files included, ignored files out) as a throwaway commit built
# with a temporary GIT_INDEX_FILE -- HEAD, the branch and the real index stay untouched -- pushes ONLY
# <sha>:refs/heads/remote-run/<worktree>-<shortsha>, dispatches .github/workflows/remote-validate.yml
# on that branch, waits (gh run watch), downloads the merged summary and the failing runs' evidence
# into artifacts/render-stream/remote/<UTC>/ and exits non-zero when any run failed.
#
#   --no-wait        print the run_key after dispatching and exit; the workflow deletes the branch itself
#   --collect KEY    wait for / download the run a previous --no-wait printed
#   --toolchain-smoke  instead of a plan, build the four toolchain outputs on a runner and fetch their sha256s
#   --and-local      run the refused runs through local validate-increment.sh while the remote run flies
#   --determinism R,R  repeat every run R times in each of len(R,R) jobs (e.g. 3,1: 3x on one runner,
#                    1x on another); lib/remote-determinism.ts compares all repeats' shots and dumps,
#                    and a disagreement fails the wrapper like a failed run
#   --browser-renderer lavapipe
#                    the CI-only software renderer gate 7's browser legs declare (RS_BROWSER_PROVENANCE,
#                    lib/browser-renderer.ts); lavapipe, the workflow's default, is the only one
#   --dry-run        plan and print what would be pushed and dispatched; touch nothing
#
# Cleanup: a failed push or dispatch, SIGINT/SIGTERM and a normal finish (unless --no-wait) cancel the
# run when needed and delete the branch through scripts/remote-run-branch.sh.
# Test seams: RV_PLANNER (planner script), RV_REMOTE (git remote, default origin), RV_POLL_S,
# RV_FIND_TRIES.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git rev-parse --show-toplevel)" || exit 2
PLANNER="${RV_PLANNER:-$REPO/experiments/render-stream/scripts/validate-increment.sh}"
SMOKE_MAP="$REPO/experiments/render-stream/scripts/smoke-map.json"
REMOTE="${RV_REMOTE:-origin}"
POLL_S="${RV_POLL_S:-4}"
FIND_TRIES="${RV_FIND_TRIES:-30}"
WORKFLOW=remote-validate.yml

BASE=main BASE_SET=0 TIER=smoke ONLY="" PATHS="" MILESTONE=0 TSMOKE=0 NO_WAIT=0 COLLECT="" AND_LOCAL=0 DRY=0 DETERMINISM="" BROWSER_RENDERER=""
while [ $# -gt 0 ]; do
	case "$1" in
	--base) BASE="$2" && BASE_SET=1 && shift 2 ;;
	--tier) TIER="$2" && shift 2 ;;
	--only) ONLY="$2" && shift 2 ;;
	--paths) PATHS="$2" && shift 2 ;;
	--milestone) MILESTONE=1 && shift ;;
	--no-wait) NO_WAIT=1 && shift ;;
	--collect) COLLECT="$2" && shift 2 ;;
	--and-local) AND_LOCAL=1 && shift ;;
	--dry-run) DRY=1 && shift ;;
	--toolchain-smoke) TSMOKE=1 && shift ;;
	--determinism) DETERMINISM="$2" && shift 2 ;;
	--browser-renderer) BROWSER_RENDERER="$2" && shift 2 ;;
	*) echo "remote-validate: unknown argument $1" >&2 && exit 2 ;;
	esac
done

if [ -n "$DETERMINISM" ] && ! [[ "$DETERMINISM" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; then
	echo "remote-validate: --determinism wants comma-separated repeat counts (e.g. 3,1), got $DETERMINISM" >&2
	exit 2
fi

case "$BROWSER_RENDERER" in
"" | lavapipe) ;;
*) echo "remote-validate: --browser-renderer wants lavapipe, got $BROWSER_RENDERER" >&2 && exit 2 ;;
esac

TMP="$(mktemp -d)"
BRANCH="" PUSHED=0 DISPATCHED=0 KEEP_BRANCH=0 RUN_ID="" RUN_KEY="" INTERRUPTED=0 CLEANED=0
WATCH_PID="" LOCAL_PID=""

find_run() { # find_run [branch] -> "id<TAB>url" for the run whose title carries RUN_KEY
	local args=(--workflow "$WORKFLOW" --json databaseId,displayTitle,url --limit 30)
	[ -n "${1:-}" ] && args+=(--branch "$1")
	gh run list "${args[@]}" 2>/dev/null | python3 -c '
import json, sys
key = sys.argv[1]
try:
    rows = json.load(sys.stdin)
except ValueError:
    sys.exit(1)
for r in rows:
    if key in r.get("displayTitle", ""):
        print(r["databaseId"], r.get("url", ""), sep="\t")
        sys.exit(0)
sys.exit(1)' "$RUN_KEY"
}

cleanup() {
	[ "$CLEANED" = 1 ] && return
	CLEANED=1
	[ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null
	[ -n "$LOCAL_PID" ] && [ "$INTERRUPTED" = 1 ] && kill "$LOCAL_PID" 2>/dev/null
	if [ "$INTERRUPTED" = 1 ] && [ "$DISPATCHED" = 1 ]; then
		if [ -z "$RUN_ID" ]; then
			RUN_ID="$(find_run "$BRANCH" | cut -f1)" || RUN_ID=""
		fi
		if [ -n "$RUN_ID" ]; then
			echo "remote-validate: cancelling run $RUN_ID" >&2
			gh run cancel "$RUN_ID" >/dev/null 2>&1
		fi
	fi
	if [ "$PUSHED" = 1 ] && [ "$KEEP_BRANCH" = 0 ]; then
		bash "$SCRIPT_DIR/remote-run-branch.sh" delete "refs/heads/$BRANCH" >&2
	fi
	rm -rf "$TMP"
}
on_signal() { INTERRUPTED=1; echo "remote-validate: interrupted ($1)" >&2; cleanup; exit "$2"; }
trap cleanup EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

# wait_and_download RUN_ID URL OUTDIR -> exit status of the verdict
wait_and_download() {
	local id="$1" dir="$3"
	echo "remote-validate: watching $2"
	gh run watch "$id" --interval 10 >"$TMP/watch.log" 2>&1 &
	WATCH_PID=$!
	wait "$WATCH_PID"
	WATCH_PID=""
	mkdir -p "$dir"
	rm -f "$dir/validate-summary.json" "$dir/determinism.json" # a same-second earlier run's
	gh run download "$id" -n summary -D "$dir" >/dev/null 2>&1
	gh run download "$id" -n failing-evidence -D "$dir/failing-evidence" >/dev/null 2>&1
	if [ ! -f "$dir/validate-summary.json" ]; then
		echo "remote-validate: no summary artifact for run $id (cancelled, or the merge job died); see $2" >&2
		return 1
	fi
	python3 - "$dir/validate-summary.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
for x in s["runs"]:
    print(f"  {x['id']:<28} [{str(x['phase']):<6}] rc={x['rc']:<3} {x['wall_s'] or 0:>8.1f} s")
r = s.get("remote", {})
for x in r.get("refused", []):
    print(f"  refused {x['id']:<24} {x['reason']}")
# Timing groups inside a correctness gate are never run on a hosted runner (RS_SKIP_TIMING_GROUPS=1):
# say which, and how to run each locally (quiet machine, `uptime` first).
LOCAL = {"g1c-rate": ("gate1", "g1a,g1c"), "g1d": ("gate1", "g1a,g1d"), "g2c-pins": ("gate2", "g2a,g2c"),
         "g5f": ("gate5", "g5f"), "g55f": ("gate55", "g55f")}
for x in s["runs"]:
    for g in x.get("skipped_remote_groups", []):
        gate, legs = LOCAL.get(g, (None, None))
        how = (f"bash experiments/render-stream/scripts/run-{gate}.sh --legs {legs} --extension ... --calibration ... "
               f"(or validate-increment.sh --only {x['id']} --tier full)") if gate else f"validate-increment.sh --only {x['id']} --tier full"
        print(f"  skipped timing group {g} ({x['id']}), run it locally: {how}")
n = len(s["runs"])
print(f"remote-validate: {n - s['failed']}/{n} runs pass; setup_s {r.get('setup_s')}; {r.get('run_url')}")
bad = 1 if s["failed"] else 0
try:
    d = json.load(open(sys.argv[1].replace("validate-summary.json", "determinism.json")))
except (OSError, ValueError):
    d = None
if d is not None:
    print(f"remote-validate: determinism {'AGREES' if d.get('ok') else 'DISAGREES'} over {d.get('runs')} runs: "
          f"{d.get('shots', {}).get('agree')}/{d.get('shots', {}).get('total')} shots, "
          f"{d.get('dumps', {}).get('agree')}/{d.get('dumps', {}).get('total')} dumps")
    for k, g in sorted((d.get("gates") or {}).items()):
        print(f"  determinism {k:<26} {'agrees' if g.get('ok') else 'DISAGREES'} over {g.get('runs')} runs: "
              f"{g.get('shots')}/{g.get('shots_total')} shots, {g.get('dumps')}/{g.get('dumps_total')} dumps"
              + (f", {g.get('live_sets')} live content sets" if g.get("live_sets") else "")
              + (", web pck sha256 drifts (export order; content agrees)" if g.get("build_raw_drift") and g.get("build_content_agree") else "")
              + (", web pck CONTENT differs" if g.get("build_content_agree") is False else ""))
    bad = bad or (0 if d.get("ok") else 1)
elif r.get("determinism"):
    print("remote-validate: determinism was requested but no determinism.json came back")
    bad = 1
sys.exit(bad)
PY
}

if [ -n "$COLLECT" ]; then
	RUN_KEY="$COLLECT"
	found="$(find_run)" || { echo "remote-validate: no run titled with key $COLLECT" >&2; exit 3; }
	OUTDIR="$REPO/artifacts/render-stream/remote/$(date -u +%Y%m%dT%H%M%SZ)"
	wait_and_download "$(cut -f1 <<<"$found")" "$(cut -f2 <<<"$found")" "$OUTDIR"
	rc=$?
	echo "remote-validate: results in $OUTDIR"
	exit $rc
fi

# ---- plan locally, split remote / refused ---------------------------------------------------------
HEAD_SHA="$(git rev-parse HEAD)" || exit 2
BASE_SHA="$(git merge-base "$BASE" HEAD 2>/dev/null || git rev-parse "$BASE" 2>/dev/null)" || {
	echo "remote-validate: cannot resolve --base $BASE" >&2
	exit 2
}
PLAN_ARGS=(--plan --tier "$TIER" --out "$TMP/plan")
[ -n "$PATHS" ] && PLAN_ARGS+=(--paths "$PATHS")
if [ "$MILESTONE" = 1 ]; then
	PLAN_ARGS+=(--milestone)
	[ "$BASE_SET" = 1 ] && PLAN_ARGS+=(--base "$BASE_SHA")
else
	PLAN_ARGS+=(--base "$BASE_SHA")
fi
bash "$PLANNER" "${PLAN_ARGS[@]}" >"$TMP/plan.log" 2>&1 || {
	echo "remote-validate: planning failed" >&2
	tail -20 "$TMP/plan.log" >&2
	exit 2
}
python3 - "$TMP/plan/plan.json" "$SMOKE_MAP" "$ONLY" >"$TMP/split.json" <<'PY' || exit 2
import fnmatch, json, re, sys
plan, smap, only = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), set(filter(None, sys.argv[3].split(",")))
rem = smap.get("remote", {})
cap, ref = rem.get("capable", []), rem.get("refuse", {})
planned = {r["id"] for r in plan["runs"]}
bad = sorted(only - planned)
if bad:
    # validate-increment --only silently drops an id the plan does not reach ("0/0 pass"); never here
    print(f"remote-validate: --only {','.join(bad)}: not in this plan (it reaches: {', '.join(sorted(planned)) or 'nothing'}). "
          "Force a run into the plan with --paths <a file it covers>, or use --milestone.", file=sys.stderr)
    sys.exit(2)
remote, refused = [], []
for r in plan["runs"]:
    if only and r["id"] not in only:
        continue
    why = ref.get("phases", {}).get(r.get("phase"))
    why = why or ref.get("ids", {}).get(r["id"])
    if not why:
        blob = json.dumps(r)
        why = next((w for pat, w in ref.get("match", {}).items() if re.search(pat, blob)), None)
    if not why and not any(fnmatch.fnmatch(r["id"], g) for g in cap):
        why = rem.get("default_reason", "not yet remote-capable")
    # R3: refuse.groups {<id glob>: {<group>: why}} refuses single groups of a gate 7 run (a check that
    # is load-sensitive on a runner): the run keeps its other groups remotely, and is refused
    # whole when none is left. A partial refusal is listed with its groups (run them locally with
    # RS_VALIDATE_GROUPS, as --and-local does).
    gw = {}
    if not why and r.get("kind") in ("g7", "g7live"):
        for pat, by_group in ref.get("groups", {}).items():
            if fnmatch.fnmatch(r["id"], pat):
                gw.update({g: by_group[g] for g in (r.get("groups") or []) if g in by_group})
        keep = [g for g in (r.get("groups") or []) if g not in gw]
        if gw and not keep:
            why = "; ".join(f"{g}: {w}" for g, w in gw.items())
        elif gw:
            r["groups"] = keep
            refused.append({"id": r["id"], "groups": sorted(gw), "reason": "; ".join(f"{g}: {w}" for g, w in gw.items())})
    (refused.append({"id": r["id"], "reason": why}) if why else remote.append(r["id"]))
# R3: a gate 7 run of several groups becomes one job per group (receiver x group); the workflow's
# merge folds them back into the run's one row. A run left with one group by a group refusal still
# names it, so the job runs only that group.
partial = {x["id"] for x in refused if x.get("groups")}
groups = {r["id"]: r["groups"] for r in plan["runs"]
          if r["id"] in remote and r.get("kind") in ("g7", "g7live")
          and (len(r.get("groups") or []) > 1 or r["id"] in partial)}
json.dump({"remote": remote, "refused": refused, "groups": groups}, sys.stdout)
PY
if [ "$TSMOKE" = 1 ]; then
	# R0b: not a planned run. Builds the four toolchain outputs on a runner (scripts/remote-toolchain-smoke.sh)
	echo '{"remote":["toolchain-smoke"],"refused":[]}' >"$TMP/split.json"
fi
REMOTE_IDS="$(python3 -c 'import json,sys; print(",".join(json.load(open(sys.argv[1]))["remote"]))' "$TMP/split.json")"
REFUSED_IDS="$(python3 -c 'import json,sys; print(",".join(x["id"] for x in json.load(open(sys.argv[1]))["refused"] if not x.get("groups")))' "$TMP/split.json")"
# R3: runs refused only in some groups: their ids, and the union of those groups (RS_VALIDATE_GROUPS)
PARTIAL_IDS="$(python3 -c 'import json,sys; print(",".join(x["id"] for x in json.load(open(sys.argv[1]))["refused"] if x.get("groups")))' "$TMP/split.json")"
PARTIAL_GROUPS="$(python3 -c 'import json,sys; print(",".join(sorted({g for x in json.load(open(sys.argv[1]))["refused"] for g in x.get("groups") or []})))' "$TMP/split.json")"
RUNS_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["remote"]))' "$TMP/split.json")"
REFUSED_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["refused"]))' "$TMP/split.json")"
GROUPS_JSON="$(python3 -c 'import json,sys; g=json.load(open(sys.argv[1])).get("groups") or {}; print(json.dumps(g) if g else "")' "$TMP/split.json")"

WT="$(basename "$REPO" | sed 's/[^A-Za-z0-9._-]/-/g')"
echo "remote-validate: remote runs: ${REMOTE_IDS:-none}"
python3 -c '
import json, sys
for x in json.load(open(sys.argv[1]))["refused"]:
    g = " groups " + ",".join(x["groups"]) if x.get("groups") else ""
    print("remote-validate: refused %s%s: %s" % (x["id"], g, x["reason"]))' "$TMP/split.json"

if [ -z "$REMOTE_IDS" ]; then
	echo "remote-validate: nothing remote-capable in this plan" >&2
	if [ "$AND_LOCAL" = 1 ] && [ "$DRY" = 0 ] && [ -n "$REFUSED_IDS" ]; then
		LOCAL_ARGS=(--only "$REFUSED_IDS" --tier "$TIER" --base "$BASE_SHA")
		[ -n "$PATHS" ] && LOCAL_ARGS+=(--paths "$PATHS")
		[ "$MILESTONE" = 1 ] && LOCAL_ARGS+=(--milestone)
		bash "$PLANNER" "${LOCAL_ARGS[@]}"
		exit $?
	fi
	[ "$DRY" = 1 ] && exit 0
	exit 2
fi

# ---- snapshot --------------------------------------------------------------------------------------
snapshot() {
	local idx="$TMP/snapshot.index" tree
	(
		cd "$REPO" || exit 1
		export GIT_INDEX_FILE="$idx"
		git read-tree HEAD &&
			git add -A &&
			tree="$(git write-tree)" &&
			GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-remote-validate}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-remote-validate@localhost}" \
				GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-remote-validate}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-remote-validate@localhost}" \
				git commit-tree "$tree" -p HEAD -m "remote-run snapshot of $WT at $(git rev-parse --short HEAD)"
	)
}

if [ "$DRY" = 1 ]; then
	echo "remote-validate: dry run: would snapshot $WT at ${HEAD_SHA:0:12}, push refs/heads/remote-run/$WT-<shortsha>, dispatch $WORKFLOW"
	echo "remote-validate: dry run: inputs worktree=$WT base=$BASE_SHA tier=$TIER milestone=$MILESTONE runs=$RUNS_JSON${DETERMINISM:+ determinism=$DETERMINISM}${BROWSER_RENDERER:+ browser_renderer=$BROWSER_RENDERER}${GROUPS_JSON:+ run_groups=$GROUPS_JSON}"
	exit 0
fi

SHA="$(snapshot)" || { echo "remote-validate: snapshot failed" >&2; exit 2; }
BRANCH="remote-run/$WT-${SHA:0:10}"
RUN_KEY="rv-$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:7}-$RANDOM"
echo "remote-validate: snapshot ${SHA:0:12} (HEAD ${HEAD_SHA:0:12}) -> $BRANCH, run_key $RUN_KEY"

PUSHED=1 # set before the push so that a half-failed push is still cleaned up (404 is success)
if ! git -C "$REPO" push --no-verify -q "$REMOTE" "$SHA:refs/heads/$BRANCH"; then
	echo "remote-validate: push failed" >&2
	exit 1
fi

milestone_in=""
if [ "$MILESTONE" = 1 ]; then milestone_in=complete && [ "$BASE_SET" = 1 ] && milestone_in=delta; fi
if ! gh workflow run "$WORKFLOW" --ref "$BRANCH" \
	-f "run_key=$RUN_KEY" -f "worktree=$WT" -f "sha=$SHA" -f "base=$BASE_SHA" -f "tier=$TIER" \
	-f "runs=$RUNS_JSON" -f "milestone=$milestone_in" -f "paths=$PATHS" -f "refused=$REFUSED_JSON" \
	${DETERMINISM:+-f "determinism=$DETERMINISM"} ${BROWSER_RENDERER:+-f "browser_renderer=$BROWSER_RENDERER"} \
	${GROUPS_JSON:+-f "run_groups=$GROUPS_JSON"} \
	>"$TMP/dispatch.log" 2>&1; then
	echo "remote-validate: dispatch failed:" >&2
	cat "$TMP/dispatch.log" >&2
	exit 1
fi
DISPATCHED=1

found=""
for ((i = 0; i < FIND_TRIES; i++)); do
	found="$(find_run "$BRANCH")" && break
	found=""
	sleep "$POLL_S" &
	wait $!
done
if [ -z "$found" ]; then
	echo "remote-validate: dispatched but could not find the run for key $RUN_KEY" >&2
	INTERRUPTED=1 # cancel by key if it shows up late, then drop the branch
	exit 1
fi
RUN_ID="$(cut -f1 <<<"$found")"
RUN_URL="$(cut -f2 <<<"$found")"
echo "remote-validate: run $RUN_ID $RUN_URL"

OUTDIR="$REPO/artifacts/render-stream/remote/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUTDIR"

if [ "$AND_LOCAL" = 1 ] && { [ -n "$REFUSED_IDS" ] || [ -n "$PARTIAL_IDS" ]; }; then
	LOCAL_ARGS=(--tier "$TIER" --base "$BASE_SHA")
	[ -n "$PATHS" ] && LOCAL_ARGS+=(--paths "$PATHS")
	[ "$MILESTONE" = 1 ] && LOCAL_ARGS+=(--milestone)
	(
		rc=0
		if [ -n "$REFUSED_IDS" ]; then
			bash "$PLANNER" --only "$REFUSED_IDS" --out "$OUTDIR/local" "${LOCAL_ARGS[@]}" || rc=1
		fi
		# the refused groups of partly remote runs, on their own (validate-increment RS_VALIDATE_GROUPS)
		if [ -n "$PARTIAL_IDS" ]; then
			RS_VALIDATE_GROUPS="$PARTIAL_GROUPS" bash "$PLANNER" --only "$PARTIAL_IDS" --out "$OUTDIR/local-groups" "${LOCAL_ARGS[@]}" || rc=1
		fi
		exit "$rc"
	) >"$OUTDIR/local.log" 2>&1 &
	LOCAL_PID=$!
	echo "remote-validate: local runs (${REFUSED_IDS}${PARTIAL_IDS:+${REFUSED_IDS:+, }$PARTIAL_IDS groups $PARTIAL_GROUPS}) started, log $OUTDIR/local.log"
fi

if [ "$NO_WAIT" = 1 ]; then
	KEEP_BRANCH=1 # the workflow's cleanup job deletes it; the janitor is the backstop
	lrc=0
	[ -n "$LOCAL_PID" ] && { wait "$LOCAL_PID"; lrc=$?; LOCAL_PID=""; }
	echo "remote-validate: dispatched; collect with: scripts/remote-validate.sh --collect $RUN_KEY"
	exit $lrc
fi

wait_and_download "$RUN_ID" "$RUN_URL" "$OUTDIR"
rrc=$?
lrc=0
[ -n "$LOCAL_PID" ] && { wait "$LOCAL_PID"; lrc=$?; LOCAL_PID=""; }
echo "remote-validate: results in $OUTDIR"
[ "$rrc" = 0 ] && [ "$lrc" = 0 ] && exit 0
exit 1
