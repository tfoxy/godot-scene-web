#!/usr/bin/env bash
# Font provisioning for the render-stream gate 4 fixtures (protocol/gate4-design.md "Q6a").
#
#   bash provision-fonts.sh <fixture dir>
#
# Reads <fixture>/fonts.lock.json ([{"file","source","bytes","sha256","license","license_file",
# "upstream"}]) and copies each source into <fixture>/fonts/<file>, whose .gitignore ignores
# everything but itself and .gdignore (the .gdignore stops the editor importing the fonts, so no
# .fontdata or pre-rendered cache ever exists). No font binary is committed a second time.
#
# A source is repo-relative; one starting with ../ (the engine checkout, ../godot-4.5.1-stable) is
# resolved against the repository root and, failing that, against the main checkout's root (a
# worktree's siblings are not the main checkout's). The source and the copy must both have the
# lock's byte size and SHA-256, and the licence file must exist. Exit 0 when every entry is
# provisioned, 2 on any mismatch or missing source (nothing is left half-copied: a mismatching
# copy is removed).

set -euo pipefail

if [ $# -ne 1 ] || [ ! -d "$1" ]; then
	echo "provision-fonts: usage: provision-fonts.sh <fixture dir>" >&2
	exit 2
fi
FIXTURE="$(cd "$1" && pwd)"
LOCK="$FIXTURE/fonts.lock.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MAIN_ROOT="$REPO_ROOT"
if common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
	MAIN_ROOT="$(dirname "$common")"
fi

if [ ! -f "$LOCK" ]; then
	echo "provision-fonts: $LOCK is missing" >&2
	exit 2
fi
if [ ! -f "$FIXTURE/fonts/.gitignore" ] || [ ! -f "$FIXTURE/fonts/.gdignore" ]; then
	echo "provision-fonts: $FIXTURE/fonts/ needs its committed .gitignore and .gdignore" >&2
	exit 2
fi

# One tab-separated line per entry: file, source, bytes, sha256, license_file.
entries="$(python3 - "$LOCK" <<'PY'
import json, sys
keys = ["file", "source", "bytes", "sha256", "license", "license_file", "upstream"]
with open(sys.argv[1], encoding="utf-8") as handle:
    lock = json.load(handle)
if not isinstance(lock, list) or not lock:
    sys.exit("fonts.lock.json is not a non-empty array")
for entry in lock:
    if not isinstance(entry, dict) or sorted(entry) != sorted(keys):
        sys.exit(f"fonts.lock.json entry {entry!r} does not have exactly the keys {keys}")
    if "/" in entry["file"] or not entry["file"]:
        sys.exit(f"fonts.lock.json file {entry['file']!r} is not a bare file name")
    print("\t".join(str(entry[k]) for k in ("file", "source", "bytes", "sha256", "license_file")))
PY
)" || {
	echo "provision-fonts: $LOCK is malformed" >&2
	exit 2
}

resolve() {
	local rel="$1"
	if [ -e "$REPO_ROOT/$rel" ]; then
		realpath "$REPO_ROOT/$rel"
	elif [ -e "$MAIN_ROOT/$rel" ]; then
		realpath "$MAIN_ROOT/$rel"
	else
		return 1
	fi
}

verify() {
	local path="$1" bytes="$2" sha="$3"
	[ "$(stat -c %s "$path")" = "$bytes" ] && [ "$(sha256sum "$path" | awk '{print $1}')" = "$sha" ]
}

status=0
while IFS=$'\t' read -r file source bytes sha license_file; do
	[ -n "$file" ] || continue
	if ! src="$(resolve "$source")"; then
		echo "provision-fonts: $file: source $source not found" >&2
		status=2
		continue
	fi
	if ! resolve "$license_file" >/dev/null; then
		echo "provision-fonts: $file: licence file $license_file not found" >&2
		status=2
		continue
	fi
	if ! verify "$src" "$bytes" "$sha"; then
		echo "provision-fonts: $file: source $src is not $bytes B / sha256 $sha" >&2
		status=2
		continue
	fi
	dest="$FIXTURE/fonts/$file"
	if [ ! -f "$dest" ] || ! verify "$dest" "$bytes" "$sha"; then
		cp "$src" "$dest.tmp"
		mv "$dest.tmp" "$dest"
	fi
	if ! verify "$dest" "$bytes" "$sha"; then
		rm -f "$dest"
		echo "provision-fonts: $file: the copy does not verify" >&2
		status=2
		continue
	fi
	echo "provision-fonts: $file ok ($bytes B, sha256 ${sha:0:12}...)"
done <<<"$entries"
exit "$status"
