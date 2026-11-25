#!/usr/bin/env bash
# Exercise generated tones through the official template's dummy AudioDriver seam.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(realpath "$HERE/../../..")"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT="$ROOT/.local/audio-samples"
MODE=sample
IMPORT_ONLY=0
CLOCK=0
ASSETS=0
REMUX_FAIL=0
TONE_ARGS=()
while [ "$#" -gt 0 ]; do
	case "$1" in
	--binary) BINARY="$(realpath "$2")"; shift 2 ;;
	--out) OUT="$(realpath -m "$2")"; shift 2 ;;
	--mode) MODE="$2"; shift 2 ;;
	--import-only) IMPORT_ONLY=1; shift ;;
	--ogg-remux-fail) REMUX_FAIL=1; shift ;;
	--assets) ASSETS=1; MODE=sample; shift ;;
	--stereo) TONE_ARGS+=(--stereo); shift ;;
	--clock) CLOCK=1; MODE=sample; shift ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
case "$MODE" in sample|log|all) ;; *) echo "invalid mode: $MODE" >&2; exit 2 ;; esac
mkdir -p "$OUT/project" "$OUT/$MODE/evidence"
for file in project.godot main.tscn main.gd clock.gd assets.gd generate.py; do
	cp "$HERE/../fixtures/audio-samples/$file" "$OUT/project/"
done
if [ "$CLOCK" = 1 ]; then cp "$OUT/project/clock.gd" "$OUT/project/main.gd"; fi
if [ "$ASSETS" = 1 ]; then cp "$OUT/project/assets.gd" "$OUT/project/main.gd"; fi
python3 "$OUT/project/generate.py" "${TONE_ARGS[@]}"
LEGS_LOG=audio-samples
HEADLESS_TIMEOUT_S=60
RENDERED_TIMEOUT_S=60
: > "$OUT/quiet-lock.jsonl"
source "$HERE/lib/gamescope.sh"
source "$HERE/lib/legs.sh"
trap 'if [ -n "$CURRENT_CHILD_PID" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; fi; quiet_release' EXIT
LEG_ENV=()
run_headless "$OUT/import" none -- mise exec -- godot --headless --path "$OUT/project" --editor --import
[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
if grep -En 'SCRIPT ERROR|Parse Error|ERROR:' "$OUT/import/stdout.log"; then exit 1; fi
if [ "$IMPORT_ONLY" = 1 ]; then legs_quiet_summary; exit 0; fi
MODES=("$MODE")
[ "$MODE" != all ] || MODES=(log sample)
for MODE in "${MODES[@]}"; do
mkdir -p "$OUT/$MODE/evidence"
rm -f "$OUT/$MODE/evidence/audio-messages.jsonl" "$OUT/$MODE/evidence/audio-commands.jsonl" "$OUT/$MODE/evidence/audio-probe.json" "$OUT/$MODE/evidence/audio-fixture.json"
LEG_ENV=(GRC_EXTENSION="$ROOT/experiments/render-stream/capture/build/render_stream_capture.gdextension"
	GRC_AUDIO_ABI_TABLE="$HERE/../calibration/abi/godot-4.5.1-audio-driver.json"
	GRC_AUDIO_TEST_VARIANT_DIR="$OUT/project" GRC_LIVE_TRACKS=audio GRC_AUDIO="$MODE" GRC_AUDIO_TEST_NO_END="${GRC_AUDIO_TEST_NO_END:-}" GRC_EVIDENCE_DIR="$OUT/$MODE/evidence")
if [ "$ASSETS" = 1 ]; then LEG_ENV+=(GRC_AUDIO_TEST_ASSETS=1 GRC_LIVE_AUDIO_NO_STORE_BUSES=Private); fi
if [ "$REMUX_FAIL" = 1 ]; then LEG_ENV+=(GRC_AUDIO_TEST_OGG_REMUX_FAIL=1); fi
run_headless "$OUT/$MODE" none -- "$BINARY" --headless --path "$OUT/project"
[ "$(cat "$OUT/$MODE/exit-code.txt")" = 0 ]
if grep -En 'SCRIPT ERROR|Parse Error|ERROR:' "$OUT/$MODE/stdout.log"; then exit 1; fi
if [ "$ASSETS" = 1 ]; then
  python3 "$HERE/check-audio-assets.py" "$OUT/$MODE/evidence" "$OUT/project" "$REMUX_FAIL"
  continue
fi
python3 - "$OUT/$MODE/evidence" "$CLOCK" <<'PY'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
probe = json.loads((root / 'audio-probe.json').read_text())
assert probe['status'] == 'found' and probe['bound_driver'] == 'Dummy', probe
if sys.argv[2] == '1':
    clock = json.loads((root / 'audio-clock.json').read_text())
    assert clock['finished'] == 1 and not clock['playing'], clock
    assert abs(clock['paused_position'] - clock['before_pause']) < .005, clock
    assert 0 <= clock['finished_frame'] - clock['deadline_frame'] <= 1, clock
    messages = [json.loads(line) for line in (root / 'audio-messages.jsonl').read_text().splitlines()]
    starts = [m for m in messages if m['type'] == 'start']
    stops = [m for m in messages if m['type'] == 'stop']
    assert len(starts) == len(stops) == 1 and stops[0]['reason'] == 'end', messages
    assert starts[0]['voice'] == stops[0]['voice'], messages
    print('audio-clock: natural finished within one frame; end stop exactly once; pause and pitch integrated')
    sys.exit(0)
fixture = json.loads((root / 'audio-fixture.json').read_text())
assert fixture['players'] == 4, fixture
print('audio-samples: dummy seam armed, four generated-tone players exercised')
PY
done
if [ "${#MODES[@]}" = 2 ]; then
  python3 "$HERE/check-audio-samples.py" "$OUT/log/evidence/audio-commands.jsonl" "$OUT/sample/evidence/audio-messages.jsonl"
fi
legs_quiet_summary
