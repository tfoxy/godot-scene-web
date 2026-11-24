#!/usr/bin/env bash
# Run the opt-in audio probe/log fixture on the cached official Linux release template.
# Usage: run-audio-seam.sh [--mode probe|log|off|all] [--binary PATH] [--out DIR]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(realpath "$HERE/../../..")"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
MODE=all
OUT="$ROOT/.local/audio-seam"
while [ "$#" -gt 0 ]; do
	case "$1" in
	--mode) MODE="$2"; shift 2 ;;
	--binary) BINARY="$(realpath "$2")"; shift 2 ;;
	--out) OUT="$(realpath -m "$2")"; shift 2 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
case "$MODE" in probe|log|off|all) ;; *) echo "invalid mode: $MODE" >&2; exit 2 ;; esac
mkdir -p "$OUT/project"
for file in project.godot main.tscn main.gd generate.py; do
	cp "$HERE/../fixtures/audio-seam/$file" "$OUT/project/"
done
python3 "$OUT/project/generate.py"
LEGS_LOG=audio-seam
HEADLESS_TIMEOUT_S=60
RENDERED_TIMEOUT_S=60
source "$HERE/lib/gamescope.sh"
source "$HERE/lib/legs.sh"
trap 'if [ -n "$CURRENT_CHILD_PID" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; fi; quiet_release' EXIT
LEG_ENV=()
run_headless "$OUT/import" none -- mise exec -- godot --headless --path "$OUT/project" --editor --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
if rg -n "SCRIPT ERROR|Parse Error|ERROR:" "$OUT/import/stdout.log"; then exit 1; fi
MODES=("$MODE")
[ "$MODE" != all ] || MODES=(probe log off)
for mode in "${MODES[@]}"; do
	mkdir -p "$OUT/$mode/evidence"
	# An output directory can be reused; stale evidence must not satisfy the checker.
	rm -f "$OUT/$mode/evidence/audio-probe.json" "$OUT/$mode/evidence/audio-commands.jsonl" "$OUT/$mode/evidence/audio-fixture.json"
	LEG_ENV=(GRC_EXTENSION="$ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
		GRC_AUDIO_ABI_TABLE="$HERE/../calibration/abi/godot-4.5.1-audio-driver.json"
		GRC_EVIDENCE_DIR="$OUT/$mode/evidence")
	[ "$mode" = off ] || LEG_ENV+=(GRC_AUDIO="$mode")
	if [ "$mode" = off ]; then
		run_headless "$OUT/$mode" none -- env -u GRC_AUDIO "$BINARY" --headless --path "$OUT/project"
	else
		run_headless "$OUT/$mode" none -- "$BINARY" --headless --path "$OUT/project"
	fi
	[ "$(cat "$OUT/$mode/exit-code.txt")" = 0 ]
	python3 "$HERE/check-audio-seam.py" "$OUT/$mode" "$mode"
done
legs_quiet_summary
