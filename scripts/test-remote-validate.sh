#!/usr/bin/env bash
# Synthetic self-test for scripts/remote-validate.sh and scripts/remote-run-branch.sh
# (docs/remote-compute.md). Nothing here touches the network or the real origin: a temporary clone
# pushes to a local bare repository, and a fake `gh` on PATH records every call, simulates the
# dispatch, a failed dispatch and a hung watch, and deletes refs in that bare repository.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

pass=0; fail=0
TMP="$(mktemp -d)" || { echo "mktemp failed" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT
check() { # check <desc> <command...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $desc" >&2; fi
}

BARE="$TMP/origin.git"; CLONE="$TMP/clone"; BIN="$TMP/bin"; export FAKE_GH_LOG="$TMP/gh.log" FAKE_BARE="$BARE"
mkdir -p "$BIN"
git init -q --bare -b main "$BARE"
git init -q -b main "$TMP/seed"
(
	cd "$TMP/seed" || exit 1
	git config user.email t@example.com && git config user.name t
	printf 'ign/\nartifacts/\n' >.gitignore
	echo one >a.txt && echo two >b.txt
	mkdir -p experiments/render-stream/scripts scripts
	cp "$ROOT/experiments/render-stream/scripts/smoke-map.json" experiments/render-stream/scripts/
	cp "$ROOT/scripts/remote-validate.sh" "$ROOT/scripts/remote-run-branch.sh" scripts/
	git add -A && git commit -qm seed && git remote add origin "$BARE" && git push -q origin main
)
git clone -q "$BARE" "$CLONE"
git -C "$CLONE" config user.email t@example.com && git -C "$CLONE" config user.name t

# ---- fake gh ---------------------------------------------------------------------------------------
cat >"$BIN/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_GH_LOG"
G="git --git-dir=$FAKE_BARE"
case "$1 $2" in
"workflow run")
	[ "${FAKE_GH_MODE:-ok}" = dispatch-fail ] && { echo "HTTP 422: no workflow" >&2; exit 1; }
	br=""; prev=""
	for a in "$@"; do [ "$prev" = --ref ] && br="$a"; prev="$a"; done
	$G ls-tree -r --name-only "refs/heads/$br" >"$FAKE_BARE/../snapshot-files.txt"
	$G for-each-ref --format='%(refname)' >"$FAKE_BARE/../refs-at-dispatch.txt"
	$G rev-parse "refs/heads/$br^" >"$FAKE_BARE/../snapshot-parent.txt"
	;;
"run list")
	key="$(grep -o 'run_key=[^ ]*' "$FAKE_GH_LOG" | tail -1 | cut -d= -f2)"
	printf '[{"databaseId":4242,"displayTitle":"remote-validate %s","url":"https://example.invalid/runs/4242"}]\n' "$key"
	;;
"run watch")
	if [ "${FAKE_GH_MODE:-ok}" = hang ]; then touch "$FAKE_BARE/../watching"; exec sleep 120; fi
	;;
"run download")
	name=""; dir=""; prev=""
	for a in "$@"; do [ "$prev" = -n ] && name="$a"; [ "$prev" = -D ] && dir="$a"; prev="$a"; done
	mkdir -p "$dir"
	if [ "$name" = summary ]; then
		f="${FAKE_GH_FAILED:-0}"
		printf '{"schema":"render-stream-validate-summary/2","wall_s":1.0,"failed":%s,"runs":[{"id":"pure","phase":"setup","rc":"0","wall_s":1.0}],"remote":{"run_url":"u","setup_s":[3.0],"refused":[]}}\n' "$f" >"$dir/validate-summary.json"
	else
		[ "${FAKE_GH_FAILED:-0}" = 1 ] && echo x >"$dir/pure-evidence.txt"
	fi
	;;
"run cancel") ;;
api*)
	if [ "$1 $2" = "api -X" ] && [ "$3" = DELETE ]; then
		ref="${4#*git/refs/}"
		$G rev-parse -q --verify "refs/$ref" >/dev/null || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
		$G update-ref -d "refs/$ref"
	elif [[ "$2" == *matching-refs* ]]; then
		$G for-each-ref --format='%(refname)	%(objectname)' refs/heads/remote-run/
	elif [[ "$2" == */commits/* ]]; then
		$G log -1 --format=%cI "${2##*/}"
	fi
	;;
esac
exit 0
GH
chmod +x "$BIN/gh"

# ---- stub planner: a canned plan.json ---------------------------------------------------------------
cat >"$TMP/planner.sh" <<'PL'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = --out ] && out="$a"; prev="$a"; done
mkdir -p "$out"
cat >"$out/plan.json" <<'JSON'
{"runs":[
 {"id":"pure","kind":"pure","phase":"setup"},
 {"id":"cargo-rs-core","kind":"cargo","phase":"setup","crate":"x/rs-core"},
 {"id":"pnpm-test","kind":"pnpm-test","phase":"setup"},
 {"id":"lock-tests","kind":"lock-tests"},
 {"id":"native-rust-gate0","kind":"native","phase":"native","gate":"gate0"},
 {"id":"native-rust-gate6","kind":"native","phase":"timing","gate":"gate6"},
 {"id":"g7live-gsw-device","kind":"g7live","phase":"g7","groups":["g7-lc-device"]},
 {"id":"g7x","kind":"g7x","phase":"g7","groups":["g7-bench"]}]}
JSON
PL
echo '{}' >"$TMP/dummy"

export PATH="$BIN:$PATH" RV_PLANNER="$TMP/planner.sh" RV_POLL_S=0.1 RV_FIND_TRIES=5
WRAP="$CLONE/scripts/remote-validate.sh"
remote_branches() { git --git-dir="$BARE" for-each-ref --format='%(refname)' refs/heads/remote-run/; }

# ---- refusals (dry run) -------------------------------------------------------------------------------
( cd "$CLONE" && bash "$WRAP" --dry-run ) >"$TMP/dry.out" 2>&1
check "dry run exits 0" grep -q 'dry run: would snapshot' "$TMP/dry.out"
check "remote-capable runs are pure, cargo-*, pnpm-test only" grep -q 'remote runs: pure,cargo-rs-core,pnpm-test$' "$TMP/dry.out"
check "timing run refused" grep -q 'refused native-rust-gate6: timing run' "$TMP/dry.out"
check "lock-tests refused" grep -q 'refused lock-tests: lock self-tests' "$TMP/dry.out"
check "g7x refused" grep -q 'refused g7x:' "$TMP/dry.out"
check "device run refused" grep -q 'refused g7live-gsw-device: device-related' "$TMP/dry.out"
check "not-yet-capable run refused with its reason" grep -q 'refused native-rust-gate0: not yet remote-capable' "$TMP/dry.out"
check "--only narrows the plan" bash -c "cd '$CLONE' && bash '$WRAP' --dry-run --only pure 2>&1 | grep -q 'remote runs: pure\$'"
check "dry run pushed nothing" test -z "$(remote_branches)"

# ---- snapshot -------------------------------------------------------------------------------------------
cd "$CLONE" || exit 1
echo changed >a.txt; echo fresh >new.txt; mkdir -p ign; echo hidden >ign/x
git add b.txt 2>/dev/null; echo staged >>b.txt; git add b.txt # a staged change must not be committed to the branch
before_head="$(git rev-parse HEAD)"; before_branch="$(git rev-parse refs/heads/main)"
before_index="$(cksum <.git/index)"; before_status="$(git status --porcelain)"
: >"$FAKE_GH_LOG"
FAKE_GH_MODE=ok bash "$WRAP" --tier full >"$TMP/ok.out" 2>&1; rc=$?
check "a green remote run exits 0" test "$rc" = 0
check "HEAD unchanged" test "$(git rev-parse HEAD)" = "$before_head"
check "the branch ref unchanged" test "$(git rev-parse refs/heads/main)" = "$before_branch"
check "the real index file byte-identical" test "$(cksum <.git/index)" = "$before_index"
check "git status identical" test "$(git status --porcelain)" = "$before_status"
check "snapshot parent is HEAD" test "$(cat "$TMP/snapshot-parent.txt")" = "$before_head"
check "snapshot has the modified tracked file" grep -qx 'a.txt' "$TMP/snapshot-files.txt"
check "snapshot has the untracked file" grep -qx 'new.txt' "$TMP/snapshot-files.txt"
check "snapshot omits the ignored file" bash -c "! grep -q '^ign/' '$TMP/snapshot-files.txt'"
check "only main and the run branch exist on origin at dispatch" bash -c \
	"[ \"\$(grep -vc '^refs/heads/remote-run/${CLONE##*/}-' '$TMP/refs-at-dispatch.txt')\" = 1 ] && grep -qx refs/heads/main '$TMP/refs-at-dispatch.txt'"
check "dispatch carried run_key, sha, base, tier and the run list" bash -c \
	"grep -q 'workflow run remote-validate.yml --ref remote-run/clone-' '$FAKE_GH_LOG' && grep -q 'run_key=rv-' '$FAKE_GH_LOG' && grep -q 'sha=' '$FAKE_GH_LOG' && grep -q 'base=' '$FAKE_GH_LOG' && grep -q 'tier=full' '$FAKE_GH_LOG' && grep -q 'runs=\[\"pure\", \"cargo-rs-core\", \"pnpm-test\"\]' '$FAKE_GH_LOG' && grep -q 'worktree=clone' '$FAKE_GH_LOG'"
check "the summary landed under artifacts/render-stream/remote/" bash -c "ls '$CLONE'/artifacts/render-stream/remote/*/validate-summary.json"
check "the branch is deleted after a normal finish" test -z "$(remote_branches)"
check "the output names the results directory" grep -q 'results in .*artifacts/render-stream/remote/' "$TMP/ok.out"
FAKE_GH_FAILED=1 FAKE_GH_MODE=ok bash "$WRAP" >"$TMP/red.out" 2>&1; rc=$?
check "a summary with failed > 0 exits non-zero" test "$rc" != 0
check "failing evidence is downloaded" bash -c "ls '$CLONE'/artifacts/render-stream/remote/*/failing-evidence/pure-evidence.txt"

# ---- failed dispatch, SIGINT, SIGTERM ---------------------------------------------------------------------
FAKE_GH_MODE=dispatch-fail bash "$WRAP" >"$TMP/df.out" 2>&1; rc=$?
check "a failed dispatch exits non-zero" test "$rc" != 0
check "a failed dispatch deletes the branch" test -z "$(remote_branches)"
check "a failed dispatch never cancels (nothing to cancel)" bash -c "! grep -q 'run cancel' '$FAKE_GH_LOG' || ! tail -3 '$FAKE_GH_LOG' | grep -q 'run cancel'"

signal_case() { # signal_case SIGNAL
	local sig="$1"
	rm -f "$TMP/watching"; : >"$FAKE_GH_LOG"
	FAKE_GH_MODE=hang python3 - "$sig" "$TMP/watching" "$WRAP" "$CLONE" >"$TMP/sig-$sig.out" 2>&1 <<'PY'
import os, signal, subprocess, sys, time
sig, marker, wrap, cwd = sys.argv[1:5]
p = subprocess.Popen(["bash", wrap], cwd=cwd)
for _ in range(300):
    if os.path.exists(marker):
        break
    time.sleep(0.1)
else:
    p.kill(); sys.exit(3)
p.send_signal(getattr(signal, "SIG" + sig))
try:
    sys.exit(0 if p.wait(timeout=30) != 0 else 4)
except subprocess.TimeoutExpired:
    p.kill(); sys.exit(5)
PY
	return $?
}
signal_case INT; rc=$?
check "SIGINT during the wait: wrapper exits non-zero promptly" test "$rc" = 0
check "SIGINT cancels the run" grep -q 'run cancel 4242' "$FAKE_GH_LOG"
check "SIGINT deletes the branch" test -z "$(remote_branches)"
signal_case TERM; rc=$?
check "SIGTERM during the wait: wrapper exits non-zero promptly" test "$rc" = 0
check "SIGTERM cancels the run" grep -q 'run cancel 4242' "$FAKE_GH_LOG"
check "SIGTERM deletes the branch" test -z "$(remote_branches)"

# ---- --no-wait keeps the branch (the workflow deletes it) ------------------------------------------------------
FAKE_GH_MODE=ok bash "$WRAP" --no-wait >"$TMP/nw.out" 2>&1
check "--no-wait prints the collect command" grep -q 'collect with: scripts/remote-validate.sh --collect rv-' "$TMP/nw.out"
check "--no-wait leaves the run branch for the workflow's cleanup job" test -n "$(remote_branches)"
key="$(grep -o -- '--collect rv-[^ ]*' "$TMP/nw.out" | cut -d' ' -f2)"
FAKE_GH_MODE=ok bash "$WRAP" --collect "$key" >"$TMP/col.out" 2>&1; rc=$?
check "--collect downloads and judges the run" test "$rc" = 0
git push -q origin ":refs/heads/$(remote_branches | sed 's#refs/heads/##')" 2>/dev/null

# ---- remote-run-branch.sh delete ----------------------------------------------------------------------------------------
RRB="$CLONE/scripts/remote-run-branch.sh"
git --git-dir="$BARE" tag lightweight main
git --git-dir="$BARE" update-ref refs/heads/remote-run/keep main
for bad in refs/heads/main refs/tags/lightweight refs/heads/remote-run refs/heads/remote-run/ \
	refs/heads/remote-run/../main refs/heads/remote-run/a/../../main heads/remote-run/keep \
	refs/heads/remote-run//keep refs/heads/remote-run/.hidden refs/heads/remote-runner/keep 'refs/heads/remote-run/k eep'; do
	bash "$RRB" delete "$bad" >/dev/null 2>&1; rc=$?
	check "delete refuses '$bad'" test "$rc" = 2
done
check "main and the tag survive the refusals" bash -c \
	"git --git-dir='$BARE' rev-parse -q --verify refs/heads/main && git --git-dir='$BARE' rev-parse -q --verify refs/tags/lightweight && git --git-dir='$BARE' rev-parse -q --verify refs/heads/remote-run/keep"
check "a missing ref counts as deleted (404)" bash "$RRB" delete refs/heads/remote-run/never-existed
check "a real run ref is deleted" bash -c "bash '$RRB' delete refs/heads/remote-run/keep && ! git --git-dir='$BARE' rev-parse -q --verify refs/heads/remote-run/keep"

# ---- janitor ----------------------------------------------------------------------------------------------------------------

oldc="$(cd "$TMP/seed" && GIT_COMMITTER_DATE="$(date -u -d '3 days ago' +%Y-%m-%dT%H:%M:%SZ)" git commit-tree 'HEAD^{tree}' -p HEAD -m old)"
newc="$(cd "$TMP/seed" && git commit-tree 'HEAD^{tree}' -p HEAD -m new)"
(cd "$TMP/seed" && git push -q "$BARE" "$oldc:refs/heads/remote-run/stale" "$newc:refs/heads/remote-run/fresh" \
	"$oldc:refs/heads/feature-old" "$oldc:refs/heads/remote-runner/old")
have() { git --git-dir="$BARE" rev-parse -q --verify "$1" >/dev/null; }
: >"$FAKE_GH_LOG"
bash "$RRB" janitor --dry-run >"$TMP/jd.out" 2>&1
check "janitor --dry-run names the stale ref" grep -q 'would delete refs/heads/remote-run/stale' "$TMP/jd.out"
check "janitor --dry-run deletes nothing" have refs/heads/remote-run/stale
bash "$RRB" janitor >"$TMP/j.out" 2>&1
check "janitor deletes a stale remote-run ref" bash -c "! git --git-dir='$BARE' rev-parse -q --verify refs/heads/remote-run/stale"
check "janitor keeps a fresh remote-run ref" have refs/heads/remote-run/fresh
check "janitor keeps a stale ref outside remote-run/" have refs/heads/feature-old
check "janitor keeps a lookalike prefix" have refs/heads/remote-runner/old
check "janitor keeps main" have refs/heads/main
# injected listing: stale entries outside remote-run/ in the input are skipped, --max-age-h applies
printf 'refs/heads/main\t2001-01-01T00:00:00Z\nrefs/tags/v1\t2001-01-01T00:00:00Z\nrefs/heads/remote-run/a\t2026-01-01T00:00:00Z\nrefs/heads/remote-run/b\t2026-01-01T10:00:00Z\n' >"$TMP/list.tsv"
git --git-dir="$BARE" update-ref refs/heads/remote-run/a main; git --git-dir="$BARE" update-ref refs/heads/remote-run/b main
RR_LIST_FILE="$TMP/list.tsv" RR_NOW="$(date -u -d 2026-01-01T12:00:00Z +%s)" bash "$RRB" janitor --max-age-h 5 >"$TMP/ji.out" 2>&1
check "injected listing: 12 h old ref deleted at 5 h" bash -c "! git --git-dir='$BARE' rev-parse -q --verify refs/heads/remote-run/a"
check "injected listing: 2 h old ref kept at 5 h" have refs/heads/remote-run/b
check "injected listing: main and tags never touched" bash -c "git --git-dir='$BARE' rev-parse -q --verify refs/heads/main && git --git-dir='$BARE' rev-parse -q --verify refs/tags/lightweight"

# ---- validate-summary.py --merge --------------------------------------------------------------------------------------------------
VS="$ROOT/experiments/render-stream/scripts/lib/validate-summary.py"
mkdir -p "$TMP/jobs/job-pure" "$TMP/jobs/job-cargo-a"
mk() { # mk <dir> <id> <phase> <rc> <setup_s>
	printf '{"schema":"render-stream-validate-summary/2","wall_s":%s,"runs":[{"id":"%s","phase":"%s","rc":"%s","wall_s":2.5,"lock_wait_s":0.0,"lock_hold_s":0.0,"lock":{},"lock_summaries":0,"skipped_by_tier":0,"unavailable":[],"failing":[]}],"phases":{},"milestone":null,"base":"abc","sabotage":{"run":false,"why":[]},"skipped_targets":7,"failed":0}\n' "2.5" "$2" "$3" "$4" >"$1/validate-summary.json"
	echo "$5" >"$1/setup_s"
}
mk "$TMP/jobs/job-pure" pure setup 0 41; mk "$TMP/jobs/job-cargo-a" cargo-a setup 1 55
echo '{"run_url":"https://x/runs/1","sha":"deadbeef","run_key":"rv-1","refused":[{"id":"g7x","reason":"r"}]}' >"$TMP/remote.json"
python3 "$VS" --merge --out "$TMP/merged" --expect pure,cargo-a,pnpm-test --remote-json "$TMP/remote.json" "$TMP/jobs"/*/ >"$TMP/merge.out" 2>&1; rc=$?
check "merge exits 1 when a run failed or is missing" test "$rc" = 1
check "merged summary: schema, 3 runs, failed 2 (cargo-a rc 1 + missing pnpm-test)" python3 - "$TMP/merged/validate-summary.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
assert s["schema"] == "render-stream-validate-summary/2"
assert [r["id"] for r in s["runs"]] == ["pure", "cargo-a", "pnpm-test"], [r["id"] for r in s["runs"]]
assert s["failed"] == 2 and s["base"] == "abc" and s["skipped_targets"] == 7
assert s["runs"][2]["rc"] == "missing"
assert s["phases"]["setup"]["runs"] == 2
r = s["remote"]
assert r["run_url"] == "https://x/runs/1" and r["sha"] == "deadbeef" and r["run_key"] == "rv-1"
assert sorted(r["setup_s"]) == [41.0, 55.0] and r["refused"][0]["id"] == "g7x"
PY
python3 "$VS" --merge --out "$TMP/merged2" --expect pure "$TMP/jobs/job-pure" >/dev/null 2>&1
check "an all-green merge exits 0 with failed 0" bash -c "[ \$? = 0 ] && python3 -c 'import json,sys; sys.exit(json.load(open(\"$TMP/merged2/validate-summary.json\"))[\"failed\"])'"

# ---- workflows -----------------------------------------------------------------------------------------------------------------------
check "workflow YAML parses" python3 - "$ROOT" <<'PY'
import glob, sys
try:
    import yaml
except ImportError:
    sys.exit(0)
for f in glob.glob(sys.argv[1] + "/.github/workflows/remote-*.yml") + [sys.argv[1] + "/.github/actions/rs-setup/action.yml"]:
    yaml.safe_load(open(f))
PY
check "every action is pinned to a full commit sha" bash -c "! grep -hE '^\s*-?\s*uses: ' '$ROOT'/.github/workflows/remote-*.yml '$ROOT'/.github/actions/rs-setup/action.yml | grep -v '\./' | grep -vE 'uses: [^@]+@[0-9a-f]{40} # v'"
check "only the cleanup job and the janitor may write contents" bash -c \
	"[ \"\$(grep -c 'contents: write' '$ROOT/.github/workflows/remote-validate.yml')\" = 1 ]"
if command -v actionlint >/dev/null 2>&1; then AL=actionlint; elif mise exec actionlint@latest -- actionlint -version >/dev/null 2>&1; then AL="mise exec actionlint@latest -- actionlint"; else AL=""; fi
if [ -n "$AL" ]; then
	check "actionlint is clean" bash -c "cd '$ROOT' && $AL .github/workflows/remote-validate.yml .github/workflows/remote-run-janitor.yml"
else
	echo "note: actionlint unavailable, skipped"
fi

echo
if [ "$fail" -eq 0 ]; then
	echo "remote-validate self-test: $pass checks passed, 0 failures"
else
	echo "remote-validate self-test: $pass passed, $fail FAILED" >&2
	exit 1
fi
