#!/usr/bin/env bash
# Gate 6 group g6b (protocol/gate6-design.md "G6b", "Q7b"): the render-stream/6 switch's own legs.
# Sourced by run-gate6.sh after lib/legs.sh and lib/gate6h-legs.sh; it relies on run-gate6.sh's OUT,
# SCENE_FIXTURE_DIR, HD_FIXTURE_DIR, RECEIVER_DIR, RECORDING_NAME, PATCH_RECORDING_NAME,
# scene_capture and scene_receiver. It reuses g6a's scene/capture (the ignore-canvas-stacking
# sabotage replays it) and g6h's hd/reference-half (every half receiver is compared with it), so
# run-gate6.sh refuses g6b without g6a and g6h in the same run.
#
# Under <out>/hd/:
#   capture-half/               capture-hd-half: the release template, --headless, armed, both
#                               sinks and the store, GRC_ROOT_SIZE=presentation:960x540 (the root
#                               window becomes 960x540: stretch 0.5, oversampling 0.5, the
#                               StyleBoxFlat feather at aa_size / 0.5), the fixture's 122 frames
#   capture-half-inline/        the same with every payload inline (no store)
#   capture-half-at-logical/    the hazard's capture: GRC_ROOT_SIZE=enforce-min-size (window
#                               1920x1080, oversampling 1, feather at aa_size)
#   receiver-half{,-patch,-inline}/  rendered receivers at --resolution 960x540 on capture-half's
#                               full and patch sinks (patch: state dumps) and capture-half-inline
#   receiver-half-at-logical/   the hazard: a 960x540 receiver on capture-half-at-logical
#   sabotage-receiver-ignore-presentation/  RS_RECEIVER_SABOTAGE=ignore-presentation, 960x540, on
#                               capture-half
# Under <out>/scene/:
#   sabotage-receiver-ignore-canvas-stacking/  RS_RECEIVER_SABOTAGE=ignore-canvas-stacking, 640x360,
#                               on g6a's scene/capture
# Under <out>/snap/:
#   project/                    a scratch copy of fixtures/gate6-scene with override.cfg setting
#                               rendering/2d/snap/snap_2d_transforms_to_pixel=true (Q6d `snap`)
#   import/                     the editor's --import of the copy
#   capture/                    capture-snap: a headless capture of the copy, both sinks, the store
# Under <out>/wide/ (PRES-A, gate6-design.md "Amendment (PRES-A)": viewer-aspect presentation):
#   project/, import/           a scratch copy of fixtures/gate6-hd with override.cfg setting
#                               display/window/stretch/aspect="expand" (the HD fixture otherwise
#                               unchanged: logical 1920x1080, canvas_items), and its --import
#   capture-<P>/                headless captures, both sinks and the store, at
#                               GRC_ROOT_SIZE=presentation:<P> for P = 2340x1080 and 2520x1080
#                               (21:9-ish, stretch scale 1: the visible rect widens to P),
#                               1170x540 (the 2340 wide frame at scale 0.5) and 1920x1080 (16:9:
#                               expand changes nothing but the session's aspect and policy keys)
#   reference-<P>/              rendered references of the copy at --resolution <P>, oracle on
#                               (2340x1080, 2520x1080, 1170x540)
#   receiver-<P>/               rendered receivers at --resolution <P> on capture-<P>'s full sink
#   sabotage-receiver-ignore-presentation/  RS_RECEIVER_SABOTAGE=ignore-presentation, 1170x540,
#                               on capture-1170x540 (at scale 1 the sabotage is a no-op: the
#                               disabled stretch of a 2340x1080 window IS the expand presentation)
#   sabotage-receiver-ignore-presentation-2340x1080/  the same at 2340x1080, reported (the no-op)
# Every rendered leg shoots the settle frames and frames 13, 53 and 93; receivers the seqs
# published at those frames.

G6B_HALF="960x540"
# PRES-A's presentations of the expand copy (wide/): scale 1 at 2340 and 2520 wide, scale 0.5.
G6B_WIDE_SIZES=(2340x1080 2520x1080 1170x540)
G6B_WIDE_HALF="1170x540"

# hd_capture <dir> <root size policy> [extra env words...]: the HD fixture's headless capture
# (both sinks and the store unless CAPTURE_STORE_DIR=none), its own 122-frame file timeline.
hd_capture() {
	local dir="$1" policy="$2"
	shift 2
	CAPTURE_FIXTURE_DIR="$HD_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE="$policy" "$@")
	run_capture "$dir" "" none
}

run_g6b() {
	local H="$OUT/$HD_DIR_NAME" D="$OUT/scene" P="$OUT/snap"
	if [ ! -f "$D/capture/$RECORDING_NAME" ] || [ ! -d "$H/reference-half" ]; then
		echo "run-gate6: g6b needs g6a's scene/capture and g6h's hd/reference-half in the same run" >&2
		exit 2
	fi

	echo "run-gate6: g6b: capture-hd-half (presentation:$G6B_HALF)"
	hd_capture "$H/capture-half" "presentation:$G6B_HALF"
	echo "run-gate6: g6b: capture-hd-half-inline (presentation:$G6B_HALF, every payload inline, no store)"
	CAPTURE_STORE_DIR=none
	hd_capture "$H/capture-half-inline" "presentation:$G6B_HALF" GRC_RESOURCE_INLINE_MAX_BYTES=16777216 \
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216
	echo "run-gate6: g6b: capture-hd-half-at-logical (the hazard: enforce-min-size, window 1920x1080)"
	hd_capture "$H/capture-half-at-logical" enforce-min-size

	echo "run-gate6: g6b: capture-snap (a scratch copy of gate6-scene with snap_2d_transforms_to_pixel)"
	mkdir -p "$P"
	rm -rf "$P/project"
	cp -a "$SCENE_FIXTURE_DIR" "$P/project"
	rm -rf "$P/project/.godot"
	printf '[rendering]\n\n2d/snap/snap_2d_transforms_to_pixel=true\n' >"$P/project/override.cfg"
	LEG_ENV=()
	run_headless "$P/import" none -- mise exec -- godot --headless --path "$P/project" --import
	if [ "$(cat "$P/import/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $P/project failed, see $P/import/stdout.log" >&2
		exit 1
	fi
	CAPTURE_FIXTURE_DIR="$P/project"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$P/capture" "" none

	echo "run-gate6: bringing up private gamescope $G6B_HALF for g6b half receivers"
	gs_start 960 540 "$OUT/gamescope-g6b-half"
	echo "run-gate6: g6b: receiver-hd-half (full sink)"
	RENDERED_EXTRA_ARGS=(--resolution "$G6B_HALF")
	scene_receiver "$H/capture-half" "$H/receiver-half"
	echo "run-gate6: g6b: receiver-hd-half-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	RENDERED_EXTRA_ARGS=(--resolution "$G6B_HALF")
	scene_receiver "$H/capture-half" "$H/receiver-half-patch"
	echo "run-gate6: g6b: receiver-hd-half-inline (capture-half-inline, no store)"
	RENDERED_EXTRA_ARGS=(--resolution "$G6B_HALF")
	scene_receiver "$H/capture-half-inline" "$H/receiver-half-inline"
	echo "run-gate6: g6b: receiver-hd-half-at-logical (the hazard: presented at $G6B_HALF)"
	RENDERED_EXTRA_ARGS=(--resolution "$G6B_HALF")
	scene_receiver "$H/capture-half-at-logical" "$H/receiver-half-at-logical"
	echo "run-gate6: g6b: sabotage-receiver-ignore-presentation (on capture-half)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-presentation)
	RENDERED_EXTRA_ARGS=(--resolution "$G6B_HALF")
	scene_receiver "$H/capture-half" "$H/sabotage-receiver-ignore-presentation"
	gs_teardown "$OUT/gamescope-g6b-half"
	GS_RUN_DIR=""

	echo "run-gate6: bringing up private gamescope 640x360 for g6b scene sabotage"
	gs_start 640 360 "$OUT/gamescope-g6b-scene"
	echo "run-gate6: g6b: sabotage-receiver-ignore-canvas-stacking (on scene/capture)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-canvas-stacking)
	scene_receiver "$D/capture" "$D/sabotage-receiver-ignore-canvas-stacking"
	gs_teardown "$OUT/gamescope-g6b-scene"
	GS_RUN_DIR=""

	run_g6b_wide
}

# PRES-A: the HD fixture under aspect=expand at the viewer-aspect presentations (wide/).
run_g6b_wide() {
	local X="$OUT/wide" size w h
	echo "run-gate6: g6b: wide project (a scratch copy of gate6-hd with stretch aspect expand)"
	mkdir -p "$X"
	rm -rf "$X/project"
	cp -a "$HD_FIXTURE_DIR" "$X/project"
	rm -rf "$X/project/.godot"
	printf '[display]\n\nwindow/stretch/aspect="expand"\n' >"$X/project/override.cfg"
	LEG_ENV=()
	run_headless "$X/import" none -- mise exec -- godot --headless --path "$X/project" --import
	if [ "$(cat "$X/import/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $X/project failed, see $X/import/stdout.log" >&2
		exit 1
	fi
	for size in 1920x1080 "${G6B_WIDE_SIZES[@]}"; do
		echo "run-gate6: g6b: capture-wide (presentation:$size, aspect expand)"
		CAPTURE_FIXTURE_DIR="$X/project"
		CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE="presentation:$size")
		run_capture "$X/capture-$size" "" none
	done
	for size in "${G6B_WIDE_SIZES[@]}"; do
		w="${size%x*}"
		h="${size#*x}"
		echo "run-gate6: bringing up private gamescope $size for g6b wide legs"
		gs_start "$w" "$h" "$OUT/gamescope-g6b-wide-$size"
		echo "run-gate6: g6b: reference-wide $size (oracle on)"
		mkdir -p "$X/reference-$size/shots"
		LEG_ENV=(RS_FIXTURE_SHOT_DIR="$X/reference-$size/shots"
			RS_FIXTURE_STEP_LOG="$X/reference-$size/steps.jsonl"
			RS_FIXTURE_ORACLE_LOG="$X/reference-$size/oracle.jsonl")
		RENDERED_EXTRA_ARGS=(--resolution "$size")
		run_rendered "$X/reference-$size" "$X/project"
		echo "run-gate6: g6b: receiver-wide $size (full sink)"
		RENDERED_EXTRA_ARGS=(--resolution "$size")
		scene_receiver "$X/capture-$size" "$X/receiver-$size"
		if [ "$size" = "$G6B_WIDE_HALF" ]; then
			echo "run-gate6: g6b: sabotage-receiver-ignore-presentation (wide, on capture-$size)"
			RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-presentation)
			RENDERED_EXTRA_ARGS=(--resolution "$size")
			scene_receiver "$X/capture-$size" "$X/sabotage-receiver-ignore-presentation"
		elif [ "$size" = "2340x1080" ]; then
			echo "run-gate6: g6b: sabotage-receiver-ignore-presentation-$size (reported: scale 1)"
			RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-presentation)
			RENDERED_EXTRA_ARGS=(--resolution "$size")
			scene_receiver "$X/capture-$size" "$X/sabotage-receiver-ignore-presentation-$size"
		fi
		gs_teardown "$OUT/gamescope-g6b-wide-$size"
		GS_RUN_DIR=""
	done
}
