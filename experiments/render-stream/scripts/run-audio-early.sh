#!/usr/bin/env bash
# Load before SceneTree construction: a clean no-stop-entry refusal, restored driver, no crash.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(realpath "$HERE/../../..")"
OUT="$(realpath -m "${2:-$ROOT/.local/audio-early}")"
if [ "$#" -gt 0 ] && { [ "$1" != --out ] || [ "$#" != 2 ]; }; then echo 'usage: run-audio-early.sh [--out DIR]' >&2; exit 2; fi
mkdir -p "$OUT/project/.godot" "$OUT/early/evidence"
: > "$OUT/quiet-lock.jsonl"
cp "$HERE/../fixtures/audio-samples/project.godot" "$HERE/../fixtures/audio-samples/main.tscn" "$OUT/project/"
cat > "$OUT/project/main.gd" <<'GD'
extends Node2D
func _ready() -> void:
	var player: AudioStreamPlayer = AudioStreamPlayer.new()
	var tone: AudioStreamWAV = AudioStreamWAV.new()
	tone.data = PackedByteArray([0, 1, 0, 255])
	player.stream = tone
	add_child(player)
	player.play()
	await get_tree().process_frame
	player.stop()
	get_tree().quit()
GD
LEGS_LOG=audio-early
HEADLESS_TIMEOUT_S=45
RENDERED_TIMEOUT_S=45
source "$HERE/lib/gamescope.sh"
source "$HERE/lib/legs.sh"
trap quiet_release EXIT
LEG_ENV=()
rm -f "$OUT/project/.godot/extension_list.cfg"
run_headless "$OUT/import" none -- mise exec -- godot --headless --import --path "$OUT/project"
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
printf '%s\n' "$ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension" > "$OUT/project/.godot/extension_list.cfg"
LEG_ENV=(GRC_LIVE_TRACKS=audio GRC_AUDIO=sample GRC_AUDIO_ABI_TABLE="$HERE/../calibration/abi/godot-4.5.1-audio-driver.json" GRC_EVIDENCE_DIR="$OUT/early/evidence")
run_headless "$OUT/early" none -- "$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64" --headless --path "$OUT/project"
[ "$(cat "$OUT/early/exit-code.txt")" = 0 ]
if grep -En 'SCRIPT ERROR|Parse Error|ERROR:' "$OUT/early/stdout.log"; then exit 1; fi
python3 - "$OUT/early/evidence/audio-probe.json" <<'PY'
import json, sys
probe = json.load(open(sys.argv[1]))
assert probe['status'] == 'refused' and probe['reason'] == 'no-stop-entry', probe
assert probe['bound_driver'] in ('', 'Dummy'), probe
print('audio-early: 1 passed, 0 failed/skipped; early load refused and native dummy playback stayed usable')
PY
legs_quiet_summary
