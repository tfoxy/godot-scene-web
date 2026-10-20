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
#   source-cache.sh lookup <key> <gate> <legs|all>         prints a cached run's dir; exit 1 on a miss
#   source-cache.sh publish <key> <gate> <legs|all> <run>  copies a PASSING run in; prints its dir
#   source-cache.sh list                                   entries, newest first
#   source-cache.sh prune [--keep-days N]                  removes entries older than N days (14)
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
	[ $# = 3 ] || { echo "usage: source-cache.sh lookup <key> <gate> <legs|all>" >&2 && exit 2; }
	key="$1" gate="$2" legs="$3"
	root="$(cache_root)"
	for name in "$(entry_name "$gate" "$legs")" "$(entry_name "$gate" all)"; do
		d="$root/$key/$name"
		if [ -f "$d/cache.json" ] && [ -f "$d/gate7-source.json" ] &&
			grep -q "\"source_key\": \"$key\"" "$d/gate7-source.json"; then
			printf '%s\n' "$d"
			exit 0
		fi
	done
	exit 1
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
	printf '%s\n' "$final"
	;;
list)
	root="$(cache_root)"
	[ -d "$root" ] || exit 0
	find "$root" -mindepth 2 -maxdepth 2 -type d ! -name '.tmp-*' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-
	;;
prune)
	days=14
	[ "${1:-}" != "--keep-days" ] || days="$2"
	root="$(cache_root)"
	[ -d "$root" ] || exit 0
	find "$root" -mindepth 2 -maxdepth 2 -type d -mtime +"$days" -print0 |
		while IFS= read -r -d '' d; do
			chmod -R u+w "$d"
			rm -rf "$d"
			echo "pruned $d"
		done
	find "$root" -mindepth 1 -maxdepth 1 -type d -empty -delete
	;;
*)
	echo "usage: source-cache.sh root|key|lookup|publish|list|prune ..." >&2
	exit 2
	;;
esac
