#!/usr/bin/env bash
# remote-run-branch.sh -- the only code that deletes remote-run branches (docs/remote-compute.md,
# "Run branches never accumulate"). Used by the workflow's cleanup job, scripts/remote-validate.sh's
# traps and the scheduled janitor.
#
#   remote-run-branch.sh delete <refs/heads/remote-run/NAME>
#       Hard-refuses anything that is not a branch strictly under refs/heads/remote-run/ (main,
#       tags, the bare prefix, `..` and other odd path tricks). Deletes through
#       `gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/...`; a 404/422 "not found" is success.
#   remote-run-branch.sh janitor [--max-age-h 24] [--dry-run]
#       Lists remote-run/* refs with their tip committer dates and deletes those older than the age
#       limit. Test input: RR_LIST_FILE=<file> ("ref<TAB>ISO-8601 date" per line, `-` = stdin) replaces
#       the API listing; RR_NOW=<epoch s> replaces the clock.
set -uo pipefail

PREFIX="refs/heads/remote-run/"

valid_ref() {
	local ref="$1"
	[[ "$ref" == "$PREFIX"* ]] || return 1
	local name="${ref#"$PREFIX"}"
	[ -n "$name" ] || return 1
	[[ "$name" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
	[[ "$name" == */ || "$name" == /* || "$name" == *//* || "$name" == *.lock ]] && return 1
	local seg
	IFS=/ read -ra segs <<<"$name"
	for seg in "${segs[@]}"; do
		case "$seg" in '' | . | .. | .*) return 1 ;; esac
	done
	[[ "$name" == *..* ]] && return 1
	return 0
}

delete_ref() {
	local ref="$1"
	if ! valid_ref "$ref"; then
		echo "remote-run-branch: refusing to delete '$ref' (only ${PREFIX}NAME is allowed)" >&2
		return 2
	fi
	local out rc
	out="$(gh api -X DELETE "repos/{owner}/{repo}/git/$ref" 2>&1)"
	rc=$?
	if [ "$rc" = 0 ]; then
		echo "remote-run-branch: deleted $ref"
		return 0
	fi
	if grep -qiE 'HTTP 404|HTTP 422|Not Found|Reference does not exist' <<<"$out"; then
		echo "remote-run-branch: $ref already gone"
		return 0
	fi
	echo "remote-run-branch: delete $ref failed: $out" >&2
	return 1
}

list_refs() {
	# stdout: "ref<TAB>iso date"
	if [ -n "${RR_LIST_FILE:-}" ]; then
		if [ "$RR_LIST_FILE" = "-" ]; then cat; else cat "$RR_LIST_FILE"; fi
		return
	fi
	local ref sha date
	while IFS=$'\t' read -r ref sha; do
		[ -n "$ref" ] || continue
		date="$(gh api "repos/{owner}/{repo}/commits/$sha" --jq .commit.committer.date 2>/dev/null)" || date=""
		printf '%s\t%s\n' "$ref" "$date"
	done < <(gh api "repos/{owner}/{repo}/git/matching-refs/heads/remote-run/" --paginate \
		--jq '.[] | [.ref, .object.sha] | @tsv')
}

janitor() {
	local max_h=24 dry=0
	while [ $# -gt 0 ]; do
		case "$1" in
		--max-age-h) max_h="$2" && shift 2 ;;
		--dry-run) dry=1 && shift ;;
		*) echo "remote-run-branch: unknown janitor argument $1" >&2 && return 2 ;;
		esac
	done
	local listing stale
	listing="$(list_refs)" || { echo "remote-run-branch: listing failed" >&2; return 1; }
	stale="$(python3 -c '
import datetime, os, sys, time
now = float(os.environ.get("RR_NOW") or time.time())
limit = float(sys.argv[1]) * 3600
for line in sys.stdin:
    ref, _, date = line.rstrip("\n").partition("\t")
    if not ref.startswith("refs/heads/remote-run/") or not date.strip():
        continue
    try:
        t = datetime.datetime.fromisoformat(date.strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        continue
    if now - t > limit:
        print(ref)
' "$max_h" <<<"$listing")"
	local ref rc=0 n=0
	while IFS= read -r ref; do
		[ -n "$ref" ] || continue
		n=$((n + 1))
		if [ "$dry" = 1 ]; then echo "remote-run-branch: would delete $ref"; else delete_ref "$ref" || rc=1; fi
	done <<<"$stale"
	echo "remote-run-branch: janitor: $n stale ref(s) older than ${max_h} h"
	return $rc
}

case "${1:-}" in
delete) [ $# = 2 ] || { echo "usage: $0 delete <ref>" >&2; exit 2; }; delete_ref "$2" ;;
janitor) shift; janitor "$@" ;;
*) echo "usage: $0 delete <ref> | janitor [--max-age-h N] [--dry-run]" >&2; exit 2 ;;
esac
