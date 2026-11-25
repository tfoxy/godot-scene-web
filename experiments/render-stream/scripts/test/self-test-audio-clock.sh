#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(realpath "$HERE/../../..")"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
if [ ! -x "$BINARY" ] || ! command -v ffmpeg >/dev/null; then
  echo 'SKIP: audio clock requires cached official template and ffmpeg'
  exit 77
fi
OUT="$ROOT/.local/audio-clock-self-test"
bash "$HERE/run-audio-samples.sh" --clock --binary "$BINARY" --out "$OUT/normal"
if GRC_AUDIO_TEST_NO_END=audio-no-end bash "$HERE/run-audio-samples.sh" --clock --binary "$BINARY" --out "$OUT/audio-no-end" >"$OUT/audio-no-end.log" 2>&1; then
  echo 'FAIL: audio-no-end escaped the natural-finished oracle' >&2
  exit 1
fi
grep -q "AssertionError:.*'finished': 0" "$OUT/audio-no-end.log"
echo 'audio-clock: normal passed; audio-no-end caught; test switch confined to sabotage leg'
