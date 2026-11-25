#!/usr/bin/env bash
# Optional correctness legs; no downloads or timing measurements.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(realpath "$HERE/../../..")"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
if [ ! -x "$BINARY" ] || ! command -v ffmpeg >/dev/null; then
  echo 'SKIP: audio assets require cached official template and ffmpeg'
  exit 77
fi
for mode in original remux-failure stereo stereo-remux-failure; do
  args=()
  case "$mode" in *remux-failure) args+=(--ogg-remux-fail) ;; esac
  case "$mode" in stereo*) args+=(--stereo) ;; esac
  bash "$HERE/run-audio-samples.sh" --assets "${args[@]}" --out "$ROOT/.local/audio-assets-self-test/$mode"
done
bash "$HERE/run-audio-early.sh" --out "$ROOT/.local/audio-assets-self-test/early"
