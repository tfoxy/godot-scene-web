#!/usr/bin/env bash
# source-cache.sh -- the machine-wide cache of gate 7 SOURCE runs, keyed by their inputs (GRT,
# results/grt.md; D21 as amended). A source run is a native run-gate<N>.sh run that the browser
# receivers replay; its content key (lib/source-key.ts: template, capture library, calibration,
# receiver core and every source-shaping file) says when two are interchangeable, so one source
# set per key serves the native, gsw and web halves of a validation and every later increment
# whose inputs are the same.
#
#   source-cache.sh root                                   the cache directory
#   source-cache.sh key [--extension E] [--calibration C]  the current key (gate7-tool.ts source-key)
#   source-cache.sh lookup <key> <gate> <legs|all> [--lease PID]
#                                                          prints a cached run's dir; exit 1 on a miss
#   source-cache.sh publish <key> <gate> <legs|all> <run>  copies a PASSING run in; prints its dir;
#                                                          then prunes to the newest N keys (below)
#   source-cache.sh flight <key> <gate> <owner pid>        waits until <owner pid> is the one maker of
#   source-cache.sh land <key> <gate> <owner pid>          <key>'s <gate> source; `land` ends it
#   source-cache.sh list                                   entries, newest first
#   source-cache.sh prune [--keep N | --keep-days N]       keeps the N most recently used keys
#                                                          (default GSW_SOURCE_CACHE_KEEP), or drops
#                                                          entries older than N days
#
# Single flight (GRT4a). Two runs that miss the same <key>/<gate> at once (validate-increment.sh's
# g7-gsw and g7-web-rust, or two worktrees with the same inputs) used to make the same source twice.
# run-gate7.sh takes `flight` before its lookup and `land`s after its publish: the first maker
# holds <root>/.flight/<key>--<gate>/ (an mkdir, with its owner's pid and start time); every other
# run waits there, then looks up again and hits. A flight whose owner is gone is taken over; a
# wait past GSW_SOURCE_FLIGHT_MAX_S (default 7200) gives up and makes the source unshared.
#
# Pruning (GRT4a). Each key holds up to ~5 GB and a new key appears whenever a source-shaping
# input changes, so every publish prunes to the GSW_SOURCE_CACHE_KEEP (default 3; 0 = never) most
# recently used keys: <root>/<key>/.last-used is touched by every publish and lookup hit. A key with
# a live lease (<root>/<key>/.leases/<pid>-<start>: `lookup --lease PID`, run-gate7.sh passes its
# own pid, so a run replaying an entry keeps it) or a live flight is never pruned, nor is a key used
# or published within GSW_SOURCE_CACHE_MIN_AGE_S (default 21600, 6 h: a runner from before GRT4a
# takes no lease and refreshes nothing, and a full tier replays its sources for hours). Entries are
# read-only, so pruning does `chmod -R u+w` before `rm -rf`. Lookups and prunes serialize on
# <root>/.prune.lock (flock: shared for a lookup, exclusive for a prune).
#
# Layout: <root>/<key>/<gate>--<legs>/, where <legs> is `all` (a run of every leg group) or the
# comma-separated --legs list with `,` as `+`. A lookup for a legs list also accepts the gate's
# `all` entry (a superset). The root is the MAIN checkout's ignored
# artifacts/render-stream/source-cache/ (GSW_SOURCE_CACHE overrides it), never a worktree's own
# artifacts, so it outlives the worktree that made an entry.
#
# Publishing never shares or edits the maker's evidence: it COPIES the run to
# <root>/<key>/.tmp-<entry>-<pid>/, rewrites the run's own absolute path in every text file
# (env.txt and argv.txt record receiver paths, and a moved source used to break replays) to the
# entry's final path, writes cache.json, then renames the tmp dir into place (atomic; a racing
# publisher's rename fails and its copy is dropped) and makes the entry read-only. Only a run that
# passed is published: result.json gate_passed, or every failing check `not-run` (a partial
# source, G7s's rule), and whose gate7-source.json carries this key.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cache_root() {
	if [ -n "${GSW_SOURCE_CACHE:-}" ]; then
		printf '%s\n' "$GSW_SOURCE_CACHE"
		return
	fi
	local common main
	common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)"
	main="$(dirname "$common")"
	printf '%s\n' "$main/artifacts/render-stream/source-cache"
}

# pid_token <pid>: "<pid>-<start time>" (the start time in clock ticks, /proc/<pid>/stat field 22),
# so a reused pid never revives a dead owner; empty when the pid is gone.
pid_token() {
	local stat
	stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
	stat="${stat##*) }"
	# shellcheck disable=SC2086 # split the fields on purpose
	set -- $stat
	printf '%s\n' "${20}"
}
# token_alive <pid>-<start>: true while that very process runs.
token_alive() {
	local pid="${1%%-*}" start="${1#*-}"
	[ "$(pid_token "$pid" 2>/dev/null)" = "$start" ]
}
# key_busy <key dir>: a live lease or a live flight on it.
key_busy() {
	local k="$1" f key
	for f in "$k"/.leases/*; do
		[ -e "$f" ] || continue
		token_alive "$(basename "$f")" && return 0
	done
	key="$(basename "$k")"
	for f in "$(dirname "$k")"/.flight/"$key"--*/owner; do
		[ -f "$f" ] || continue
		token_alive "$(cat "$f")" && return 0
	done
	return 1
}
# prune_keep <root> <N>: keeps the N most recently used keys (.last-used, else the dir's mtime) and
# every busy or recently used key; removes the rest, read-only entries included.
prune_keep() {
	local root="$1" keep="$2" k t n=0 now min_age
	[ "$keep" -gt 0 ] 2>/dev/null || return 0
	[ -d "$root" ] || return 0
	now="$(date +%s)"
	min_age="${GSW_SOURCE_CACHE_MIN_AGE_S:-21600}"
	while IFS=' ' read -r t k; do
		n=$((n + 1))
		[ "$n" -gt "$keep" ] || continue
		if [ $((now - t)) -lt "$min_age" ]; then
			echo "source-cache.sh: kept $k (used $((now - t)) s ago, under GSW_SOURCE_CACHE_MIN_AGE_S)" >&2
			continue
		fi
		if key_busy "$k"; then
			echo "source-cache.sh: kept $k (in use)" >&2
			continue
		fi
		chmod -R u+w "$k" 2>/dev/null || true
		rm -rf "$k"
		echo "source-cache.sh: pruned $k (least recently used; keeping $keep)" >&2
	done < <(
		for k in "$root"/*/; do
			k="${k%/}"
			case "$(basename "$k")" in .*) continue ;; esac
			[ -d "$k" ] || continue
			if [ -e "$k/.last-used" ]; then t="$(stat -c %Y "$k/.last-used")"; else t="$(stat -c %Y "$k")"; fi
			printf '%s %s\n' "$t" "$k"
		done | sort -rn
	)
	# stale publish temp dirs (a publisher killed mid-copy) older than a day
	find "$root" -mindepth 2 -maxdepth 2 -type d -name '.tmp-*' -mmin +1440 -print0 2>/dev/null |
		while IFS= read -r -d '' t; do chmod -R u+w "$t" && rm -rf "$t"; done
}

entry_name() {
	local gate="$1" legs="$2"
	[ -n "$legs" ] || legs=all
	printf '%s--%s\n' "$gate" "${legs//,/+}"
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
root)
	cache_root
	;;
key)
	ext="$REPO_ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
	cal="$REPO_ROOT/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
	while [ $# -gt 0 ]; do
		case "$1" in
		--extension) ext="$2" && shift 2 ;;
		--calibration) cal="$2" && shift 2 ;;
		*) echo "source-cache.sh key: unknown argument $1" >&2 && exit 2 ;;
		esac
	done
	cd "$REPO_ROOT"
	mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-tool.ts" source-key \
		--extension "$(realpath "$ext")" --calibration "$(realpath "$cal")" | tail -1
	;;
lookup)
	lease=""
	if [ $# = 5 ] && [ "$4" = --lease ]; then
		lease="$5"
		set -- "$1" "$2" "$3"
	fi
	[ $# = 3 ] || { echo "usage: source-cache.sh lookup <key> <gate> <legs|all> [--lease PID]" >&2 && exit 2; }
	key="$1" gate="$2" legs="$3"
	root="$(cache_root)"
	[ -d "$root" ] || exit 1
	exec 8>>"$root/.prune.lock"
	flock -s 8
	for name in "$(entry_name "$gate" "$legs")" "$(entry_name "$gate" all)"; do
		d="$root/$key/$name"
		if [ -f "$d/cache.json" ] && [ -f "$d/gate7-source.json" ] &&
			grep -q "\"source_key\": \"$key\"" "$d/gate7-source.json"; then
			touch "$root/$key/.last-used" 2>/dev/null || true
			if [ -n "$lease" ] && tok="$(pid_token "$lease")"; then
				mkdir -p "$root/$key/.leases" && : >"$root/$key/.leases/$lease-$tok"
			fi
			printf '%s\n' "$d"
			exit 0
		fi
	done
	exit 1
	;;
flight)
	[ $# = 3 ] || { echo "usage: source-cache.sh flight <key> <gate> <owner pid>" >&2 && exit 2; }
	key="$1" gate="$2" owner="$3"
	root="$(cache_root)"
	fl="$root/.flight/$key--$gate"
	me="$owner-$(pid_token "$owner")" || { echo "source-cache.sh flight: no process $owner" >&2 && exit 2; }
	mkdir -p "$root/.flight"
	max="${GSW_SOURCE_FLIGHT_MAX_S:-7200}"
	t0="$(date +%s)"
	said=0
	while :; do
		if mkdir "$fl" 2>/dev/null; then
			printf '%s\n' "$me" >"$fl/owner"
			exit 0
		fi
		cur="$(cat "$fl/owner" 2>/dev/null || true)"
		[ "$cur" != "$me" ] || exit 0
		if [ -n "$cur" ] && ! token_alive "$cur"; then
			# the owner died mid-make: take its flight over
			rm -rf "$fl"
			continue
		fi
		if [ -z "$cur" ] && [ $(($(date +%s) - $(stat -c %Y "$fl" 2>/dev/null || date +%s))) -gt 10 ]; then
			rm -rf "$fl" # a flight dir that never got its owner file
			continue
		fi
		if [ "$said" = 0 ]; then
			echo "source-cache.sh: $gate source for key $key is being made by ${cur%%-*}; waiting for it" >&2
			said=1
		fi
		if [ $(($(date +%s) - t0)) -ge "$max" ]; then
			echo "source-cache.sh: waited ${max}s on $fl; making the source unshared" >&2
			exit 1
		fi
		sleep "${GSW_SOURCE_FLIGHT_POLL_S:-2}"
	done
	;;
land)
	[ $# = 3 ] || { echo "usage: source-cache.sh land <key> <gate> <owner pid>" >&2 && exit 2; }
	root="$(cache_root)"
	fl="$root/.flight/$1--$2"
	me="$3-$(pid_token "$3")" || me=""
	[ "$(cat "$fl/owner" 2>/dev/null || true)" != "$me" ] || rm -rf "$fl"
	exit 0
	;;
publish)
	[ $# = 4 ] || { echo "usage: source-cache.sh publish <key> <gate> <legs|all> <run dir>" >&2 && exit 2; }
	key="$1" gate="$2" legs="$3" run="$(realpath "$4")"
	root="$(cache_root)"
	final="$root/$key/$(entry_name "$gate" "$legs")"
	if [ -f "$final/cache.json" ]; then
		printf '%s\n' "$final"
		exit 0
	fi
	mkdir -p "$root/$key"
	tmp="$root/$key/.tmp-$(entry_name "$gate" "$legs")-$$"
	rm -rf "$tmp"
	python3 - "$run" "$tmp" "$final" "$key" "$gate" "$legs" <<'PY'
import json, os, shutil, sys, time

run, tmp, final, key, gate, legs = sys.argv[1:7]


def fail(msg):
    print(f"source-cache.sh: not published: {msg}", file=sys.stderr)
    sys.exit(3)


try:
    result = json.load(open(os.path.join(run, "result.json")))
except (OSError, ValueError):
    fail(f"{run}/result.json missing or unreadable")
failing = [c.get("id") for c in result.get("checks", [])
           if c.get("passed") is not True and c.get("status") != "not-run"]
if result.get("gate_passed") is not True and (failing or not result.get("checks")):
    fail(f"the run did not pass ({', '.join(map(str, failing[:4])) or 'gate_passed is not true'})")
try:
    prov = json.load(open(os.path.join(run, "gate7-source.json")))
except (OSError, ValueError):
    fail(f"{run}/gate7-source.json missing (gate7-tool.ts source-provenance)")
if prov.get("source_key") != key:
    fail(f"gate7-source.json source_key {prov.get('source_key')} != {key}")

shutil.copytree(run, tmp, symlinks=True)
old, new = run.encode(), final.encode()
rewritten = 0
for dp, dn, fn in os.walk(tmp):
    for f in fn:
        p = os.path.join(dp, f)
        if os.path.islink(p):
            t = os.readlink(p)
            if t.startswith(run):
                os.unlink(p)
                os.symlink(final + t[len(run):], p)
                rewritten += 1
            continue
        try:
            if os.path.getsize(p) > 512 * 1024 * 1024:
                continue
            with open(p, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        if b"\0" in data[:8192] or old not in data:
            continue
        # A fresh file (new inode), never an in-place write.
        with open(p + ".reloc", "wb") as fh:
            fh.write(data.replace(old, new))
        shutil.copymode(p, p + ".reloc")
        os.replace(p + ".reloc", p)
        rewritten += 1
with open(os.path.join(tmp, "cache.json"), "w") as fh:
    json.dump({"schema": "render-stream-source-cache/1", "key": key, "gate": gate,
               "legs": legs or "all", "made_from": run, "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "relocated_files": rewritten}, fh, indent=2)
    fh.write("\n")
try:
    os.rename(tmp, final)
except OSError:
    shutil.rmtree(tmp, ignore_errors=True)
    if not os.path.isfile(os.path.join(final, "cache.json")):
        fail(f"cannot rename into {final}")
PY
	chmod -R a-w "$final" 2>/dev/null || true
	touch "$root/$key/.last-used" 2>/dev/null || true
	printf '%s\n' "$final"
	# GRT4a: keep the cache to the newest GSW_SOURCE_CACHE_KEEP keys (default 3; 0 = never prune).
	(
		exec 8>>"$root/.prune.lock"
		flock -x 8
		prune_keep "$root" "${GSW_SOURCE_CACHE_KEEP:-3}"
	) || true
	;;
list)
	root="$(cache_root)"
	[ -d "$root" ] || exit 0
	find "$root" -mindepth 2 -maxdepth 2 -type d ! -name '.*' ! -path "$root/.*" -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-
	;;
prune)
	root="$(cache_root)"
	[ -d "$root" ] || exit 0
	if [ "${1:-}" = --keep ] || [ $# = 0 ]; then
		exec 8>>"$root/.prune.lock"
		flock -x 8
		prune_keep "$root" "${2:-${GSW_SOURCE_CACHE_KEEP:-3}}"
		exit 0
	fi
	days=14
	[ "${1:-}" != "--keep-days" ] || days="$2"
	find "$root" -mindepth 2 -maxdepth 2 -type d ! -name '.*' -mtime +"$days" -print0 |
		while IFS= read -r -d '' d; do
			chmod -R u+w "$d"
			rm -rf "$d"
			echo "pruned $d"
		done
	find "$root" -mindepth 1 -maxdepth 1 -type d -empty -delete
	;;
*)
	echo "usage: source-cache.sh root|key|lookup|publish|flight|land|list|prune ..." >&2
	exit 2
	;;
esac
