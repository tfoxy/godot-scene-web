#!/usr/bin/env bash
# Gate 7x page-level sabotages (gate7-design.md "G7x" "Sabotages"), on the desktop (D9), over the
# pace input with the expected.json shots. Each run must FAIL gate7x-checks.ts:
#   drop-draws      -> draw-count-parity and the pace shots
#   stale-item-row  -> the pace shot at every step after the first
#   digest-skip     -> record-digest-complete
# (skip-payload-hash is golden-level: `rs-core-check goldens --sabotage skip-payload-hash`.)
#
# Usage: run-g7x-sabotages.sh <inputs.json> <out dir> <pace reference shots dir>
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUTS="$1"
OUT="$2"
REF="$3"
FRAMES="$(python3 -c "import json;e=json.load(open('$HERE/../fixtures/gate7-pace/expected.json'));print(','.join(str(s['frame']) for s in e['steps']))")"
status=0
for sab in drop-draws stale-item-row digest-skip; do
	dir="$OUT/sabotage-$sab"
	rm -rf "$dir"
	mise exec -- pnpm exec tsx --conditions=development "$HERE/gate7-bench.ts" --arm gsw-rs \
		--inputs "$INPUTS" --only pace-patch --out "$dir" --warmup 0 --repeats 1 \
		--rs-sabotage "$sab" --shot-frames "$FRAMES" >"$dir.log" 2>&1 || true
	echo "== $sab"
	if ! mise exec -- pnpm exec tsx --conditions=development "$HERE/gate7x-checks.ts" --run "$dir" \
		--reference "$REF" --expect-fail; then
		status=1
	fi
done
exit "$status"
