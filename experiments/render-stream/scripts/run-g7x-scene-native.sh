#!/usr/bin/env bash
# Gate 7x, report-only (gate7-design.md "G7x" R1): the native receiver's rendered shots of the
# gate 6 scene bench input, so the GSW Rust arm's desktop shots of the same transactions can be
# compared per region. The receiver replays the capture's patch sink (scene-patch) inside a private
# 640x360 gamescope (lib/gamescope.sh, the runners' own plumbing) and shoots the settle seqs of the
# capture's steps.jsonl.
#
# Usage: run-g7x-scene-native.sh <scene capture dir> <out dir>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
CAPTURE="$(realpath "$1")"
OUT="$(mkdir -p "$2" && realpath "$2")"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
BINARY="$(realpath "$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64")"
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=240
HAVE_STRACE=0
LEGS_LOG="run-g7x-scene-native"
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"
set -euo pipefail
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT
gs_start 640 360 "$OUT/gamescope"
RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
run_rendered_receiver "$CAPTURE" "$OUT/receiver-patch"
gs_teardown "$OUT/gamescope"
GS_RUN_DIR=""
echo "shots: $OUT/receiver-patch/shots (seqs $(cat "$OUT/receiver-patch/shot-seqs.txt"))"
