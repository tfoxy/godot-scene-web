#!/usr/bin/env bash
# compose-g7p.sh <out> <g7-p run dir>...: assembles one evidence directory from several
# `run-gate7.sh --live --legs g7-p` runs (G7p, results/gate7/g7p.md). The runner refuses a non-empty
# --out, so a matrix run in pieces (or resumed after a cut) leaves one directory per piece; this
# links each piece's scenario directories into <out>/gate6/matrix-<kind>-w<window>/matrix/<scenario>/
# (and its provenance-input.json and bundle links, from the first piece that has them), so one
# `check-gate7.ts --live --legs g7-p --out <out>` judges them together. Nothing is copied or moved;
# a scenario named by two pieces is an error (a repeat is never silently replaced).
set -euo pipefail
OUT="$1"
shift
for src in "$@"; do
	src="$(realpath "$src")"
	for run in "$src"/gate6/matrix-*-w[12]; do
		[ -d "$run/matrix" ] || continue
		name="$(basename "$run")"
		dest="$OUT/gate6/$name"
		mkdir -p "$dest/matrix"
		for item in "$run"/matrix/*/; do
			id="$(basename "$item")"
			case "$id" in import | report-set) continue ;; esac
			if [ -e "$dest/matrix/$id" ]; then
				echo "compose-g7p: $name/$id is in two pieces" >&2
				exit 1
			fi
			ln -s "${item%/}" "$dest/matrix/$id"
		done
		for f in provenance-input.json g7p.json; do
			[ -e "$dest/matrix/$f" ] || [ ! -e "$run/matrix/$f" ] || ln -s "$run/matrix/$f" "$dest/matrix/$f"
		done
		for b in web-bundle gsw-bundle; do
			[ -e "$dest/$b" ] || [ ! -e "$run/$b" ] || ln -s "$(realpath "$run/$b")" "$dest/$b"
		done
	done
done
