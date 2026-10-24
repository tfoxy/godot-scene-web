#!/usr/bin/env bash
# G8kv: encode with the capture's basisu wrapper, validate the KTX2 files with the TS validator,
# then round-trip them through stock Godot 4.5.1's transcoder and print the PSNR table.
#
#   scripts/test/g8kv-roundtrip.sh [out-dir]      (run by ctest as rs_basis_roundtrip)
# Exit 77 (ctest SKIP) when godot is unavailable. The engine step runs under `timeout`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXP="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$EXP/../.." && pwd)"
OUT="${1:-$EXP/capture/build/g8kv-roundtrip}"
rm -rf "$OUT" && mkdir -p "$OUT"

"$EXP/capture/build/rs_basis_encode_test" --emit "$OUT" > "$OUT/encode.log" 2>&1 || { cat "$OUT/encode.log"; exit 1; }
(cd "$REPO" && mise exec -- pnpm exec tsx --conditions=development "$HERE/g8kv-validate-ktx2.ts" "$OUT") | tee "$OUT/ts-validate.log"
[ "${PIPESTATUS[0]}" = 0 ] || exit 1
if ! (cd "$REPO" && mise exec -- godot --version) >/dev/null 2>&1; then echo "godot unavailable: skip"; exit 77; fi
# The first run in a fresh worktree needs the class cache; harmless when already imported.
[ -d "$EXP/receiver/.godot" ] || (cd "$REPO" && timeout 300 mise exec -- godot --headless --path "$EXP/receiver" --import >/dev/null 2>&1)
(cd "$REPO" && timeout 120 mise exec -- godot --headless --path "$EXP/receiver" --script "$EXP/capture/test/g8kv_transcode.gd" -- "$OUT") > "$OUT/godot.log" 2>&1
rc=$?
cat "$OUT/godot.log"
[ "$rc" = 0 ] && grep -q '^RESULT ok' "$OUT/godot.log"
