#!/usr/bin/env bash
# Run the gsw-input Godot selftests (packages/input/godot/tests/*_selftest.gd) headless.
#
#   mise exec -- pnpm test:input-godot          (or: scripts/test-godot.sh [name_selftest ...])
#
# A fresh checkout has no packages/input/godot/.godot/ (gitignored), and without its global class
# cache every `class_name` reference degrades to Variant, so one editor `--import` pass runs first.
# A selftest passes only when Godot exits 0, prints its "<tag> ok" line and logs no script error:
# a parse error can leave a --script run exiting 0 with nothing tested.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$root/packages/input/godot"
godot="${GODOT:-godot}"
command -v "$godot" >/dev/null || { echo "error: $godot not on PATH (run through mise exec --)" >&2; exit 2; }

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

if ! timeout 300 "$godot" --headless --path "$project" --import >"$log" 2>&1 || grep -q 'SCRIPT ERROR' "$log"; then
  cat "$log"
  echo "error: the --import pass failed" >&2
  exit 1
fi

if (($#)); then
  tests=("$@")
else
  tests=()
  for file in "$project"/tests/*_selftest.gd; do tests+=("$(basename "$file" .gd)"); done
fi

failed=0
for name in "${tests[@]}"; do
  status=0
  timeout 300 "$godot" --headless --path "$project" --script "res://tests/$name.gd" >"$log" 2>&1 || status=$?
  if ((status == 0)) && ! grep -qE 'SCRIPT ERROR|Parse Error' "$log" && grep -qE '^\[[a-z-]+-selftest\] ok( |$)' "$log"; then
    grep -E '^\[[a-z-]+-selftest\] ok( |$)' "$log" | tail -1
  else
    grep -vE '^Godot Engine v|^$' "$log" | tail -60
    echo "FAIL: $name (exit $status)"
    failed=1
  fi
done
exit "$failed"
