#!/usr/bin/env bash
# Gate 6 group g6h (protocol/gate6-design.md "G6h", "Q6e", "Q7b"): fixtures/gate6-hd, nine copies
# of the gate 6 scene at logical 1920x1080 under `canvas_items` stretch, on render-stream/5.
# Sourced by run-gate6.sh after lib/legs.sh; it relies on run-gate6.sh's OUT, HD_FIXTURE_DIR,
# RECEIVER_DIR, EXTENSION, CALIBRATION, RECORDING_NAME, PATCH_RECORDING_NAME and scene_receiver.
#
# Under <out>/hd/:
#   import/{fixture,receiver}/       the editor's --import of fixtures/gate6-hd and receiver/
#   capture-native/                  capture-hd-native: the release template, --headless, armed,
#                                    both sinks and the store, GRC_ROOT_SIZE=enforce-min-size (the
#                                    root window becomes the logical 1920x1080: stretch identity),
#                                    the fixture's own 122-frame file timeline
#   reference-native{,-repeat}/      reference-hd-native, -repeat: rendered in a private 1920x1080
#                                    gamescope, --resolution 1920x1080, oracle on
#   reference-native-armed/          reference-hd-native-armed: the same, extension armed with a
#                                    full-sink stream and a store, oracle off
#   receiver-native{,-patch}/        receiver-hd-native, -patch: rendered receivers at 1920x1080 on
#                                    capture-native's full and patch sinks (patch: state dumps)
#   reference-half{,-repeat}/        reference-hd-half, -repeat: rendered in a private 960x540
#                                    gamescope, --resolution 960x540 (stretch 0.5), oracle on
# Every rendered leg shoots the settle frames and frames 13, 53 and 93; receivers the seqs
# published at those frames.

HD_DIR_NAME="hd"

# hd_reference <dir> <WxH> [armed 0|1] [oracle 0|1]: the HD fixture rendered in the current
# private gamescope at --resolution WxH.
hd_reference() {
	local dir="$1" resolution="$2" armed="${3:-0}" oracle="${4:-1}"
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
	if [ "$oracle" = "1" ]; then
		LEG_ENV+=(RS_FIXTURE_ORACLE_LOG="$dir/oracle.jsonl")
	fi
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store" GRC_ROOT_SIZE=enforce-min-size
		)
	fi
	RENDERED_EXTRA_ARGS=(--resolution "$resolution")
	run_rendered "$dir" "$HD_FIXTURE_DIR"
}

run_g6h() {
	local H="$OUT/$HD_DIR_NAME"
	mkdir -p "$H/import"
	echo "run-gate6: g6h: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$H/import/fixture" none -- mise exec -- godot --headless --path "$HD_FIXTURE_DIR" --import
	if [ "$(cat "$H/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $HD_FIXTURE_DIR failed, see $H/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$H/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$H/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $RECEIVER_DIR failed, see $H/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate6: g6h: capture-hd-native (enforce-min-size: the root window is the logical 1920x1080)"
	CAPTURE_FIXTURE_DIR="$HD_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$H/capture-native" "" none

	echo "run-gate6: bringing up private gamescope 1920x1080 for g6h native legs"
	gs_start 1920 1080 "$OUT/gamescope-g6h-native"
	echo "run-gate6: g6h: reference-hd-native (oracle on)"
	hd_reference "$H/reference-native" 1920x1080 0 1
	echo "run-gate6: g6h: reference-hd-native-repeat (oracle on)"
	hd_reference "$H/reference-native-repeat" 1920x1080 0 1
	echo "run-gate6: g6h: reference-hd-native-armed (extension armed, stream on, oracle off)"
	hd_reference "$H/reference-native-armed" 1920x1080 1 0
	echo "run-gate6: g6h: receiver-hd-native (full sink)"
	RENDERED_EXTRA_ARGS=(--resolution 1920x1080)
	scene_receiver "$H/capture-native" "$H/receiver-native"
	echo "run-gate6: g6h: receiver-hd-native-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	RENDERED_EXTRA_ARGS=(--resolution 1920x1080)
	scene_receiver "$H/capture-native" "$H/receiver-native-patch"
	gs_teardown "$OUT/gamescope-g6h-native"
	GS_RUN_DIR=""

	echo "run-gate6: bringing up private gamescope 960x540 for g6h half legs"
	gs_start 960 540 "$OUT/gamescope-g6h-half"
	echo "run-gate6: g6h: reference-hd-half (oracle on)"
	hd_reference "$H/reference-half" 960x540 0 1
	echo "run-gate6: g6h: reference-hd-half-repeat (oracle on)"
	hd_reference "$H/reference-half-repeat" 960x540 0 1
	gs_teardown "$OUT/gamescope-g6h-half"
	GS_RUN_DIR=""
}
