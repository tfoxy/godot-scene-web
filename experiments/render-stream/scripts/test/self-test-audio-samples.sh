#!/usr/bin/env bash
# This optional native leg uses only preinstalled tools and the cached official template.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(realpath "$HERE/../../..")"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
if [ ! -x "$BINARY" ] || ! command -v ffmpeg >/dev/null; then
  echo 'SKIP: audio sample seam requires cached official template and ffmpeg'
  exit 77
fi
exec bash "$HERE/run-audio-samples.sh" --mode all --binary "$BINARY" --out "$ROOT/.local/audio-samples-self-test"
