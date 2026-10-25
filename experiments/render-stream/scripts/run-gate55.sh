#!/usr/bin/env bash
# Gate 5.5 runner: drives the gate 5.5 fixtures through the legs of protocol/gate5_5-design.md
# "Q7. Runner, legs, checks, report" for the groups that have landed, then runs check-gate55.ts.
#
#   bash run-gate55.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g55b,g55c,g55d,g55e,g55f,g55s,g55v,g55t]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate55/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g55b (G55b: the
# CanvasItemMaterial fixture fixtures/gate55-cim's import; for the base scene under <out>/cim/ and
# for variant `modulate` under <out>/cim-modulate/, a 400-frame headless capture with both sinks and
# the store -- `success` on render-stream/5 since G55d, every item naming its material --, its
# rendered reference, a same-build repeat and an extension-armed reference), g55c (G55c:
# fixtures/gate55-shader's import, a 400-frame headless capture with both sinks and the store --
# `success` on /5 since G55d --, its rendered reference and a same-build repeat with the material
# oracle on, an extension-armed reference with the oracle off, all under <out>/shader/; and the
# `refused` variant's capture -- `unsupported` with its five refused items and shaders typed -- and
# rendered reference with the oracle on, under <out>/shader-refused/) and g55d (G55d:
# CanvasItemMaterial end to end on render-stream/5 over g55b's two scene directories, reusing
# g55b's capture and reference there, so requesting g55d alone runs g55b first: the receiver/
# import once; per scene an all-inline 400-frame capture (capture-inline, no store) and rendered
# receivers on the capture's full sink (receiver), its patch sink with state dumps at the settle
# seqs (receiver-patch) and on capture-inline (receiver-inline); on the base scene the host
# sabotages freeze-frame @11 and omit-op material_set_shader @21 (sabotage-freeze,
# sabotage-omit-material-set-shader: a capture plus a rendered receiver each) and the receiver
# sabotage ignore-material on the main capture (sabotage-receiver-ignore-material); on the modulate
# scene the receiver sabotage ignore-canvas-modulate (sabotage-receiver-ignore-canvas-modulate))
# and g55e (G55e: ShaderMaterial end to end over g55c's directories, reusing g55c's captures and
# references there, so requesting g55e alone runs g55c first: the receiver/ import; an all-inline
# capture (shader/capture-inline); the `params` and `exclude` shader-policy captures
# (shader-policy-params/capture, shader-policy-exclude/capture); the host sabotages freeze-frame
# @11, omit-op material_set_param @21 and perturb-shader @21 (shader/sabotage-*/capture, each with a
# rendered receiver); rendered receivers on capture-shader's full and patch sinks and on
# capture-inline (shader/receiver{,-patch,-inline}), on capture-refused (shader-refused/receiver),
# on capture-policy-params without a library (receiver-nolib) and with the library the reference
# oracle dumped (receiver-lib, RS_RECEIVER_SHADER_LIBRARY); and the receiver sabotages
# ignore-material and stale-param on capture-shader) and g55f (G55f: live legs on
# fixtures/gate55-shader with gate 1's live timeline (S=300, N=60, LAST_STEP=9, quit=851) under
# <out>/shader-live/ -- a rendered reference at that same timeline (so PH's per-frame phase lines
# up with the live shots), live-shader (host + rendered live receiver, fresh cache),
# live-shader-warm (a new host + a new rendered receiver on live-shader's cache),
# live-shader-stall (RS_RECEIVER_STALL=1:2000, step 1) and sabotage-shader-stale-coalesce (the
# same stall, host GRC_SABOTAGE=stale-coalesce from step 1's frame); g55f imports both projects
# itself and does not need g55c's own legs) and g55s (P3-ST, gate5_5-design.md "Screen texture
# (P3-ST)": fixtures/gate55-screen under <out>/screen/ -- its import and the receiver's, a
# render-stream/8 capture, the rendered reference and a repeat, rendered receivers on the full and
# patch sinks, and the receiver sabotage screen-copy-per-reader; self-contained) and g55v (P3-VX,
# gate5_5-design.md "vertex() (P3-VX)": fixtures/gate55-vertex under <out>/vertex/, the same legs as
# g55s with the receiver sabotage vertex-flat-varyings; self-contained).
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Every capture runs with GRC_ROOT_SIZE=enforce-min-size
# (gate5_5-design.md Q6).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
SHADER_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate55-shader"
CIM_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate55-cim"
SCREEN_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate55-screen"
VERTEX_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate55-vertex"
TIME_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate55-time"
FIXTURE_DIR="$SHADER_FIXTURE_DIR"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order.
LANDED_GROUPS=(g55b g55c g55d g55e g55f g55s g55v g55t)
KNOWN_GROUPS=(g55b g55c g55d g55e g55f g55s g55v g55t)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The capture runs 400 frames so the /proc maps/fd sample has time to run (gate4-design.md G4a
# amendment); the rendered legs run the fixture's default quit frame (S + N*9 + 11 = 102).
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180

# G55f: the live timeline (gate 1's and gate 5f's pattern, memories rs-g1d-stall-facts and
# rs-g5f-live-mesh-facts) on fixtures/gate55-shader's own step model (LAST_STEP 9, SETTLE_OFFSET
# 7, QUIT_AFTER_LAST_SETTLE 4): S=300, N=60 so a 60 fps receiver has slack between steps, quit =
# S + N*LAST_STEP + 7 + 4. Identical numbers to gate5-design.md G5f's G5F_* on purpose: the same
# engine mechanics, measured there, carry over (gate5_5-design.md G55f).
G55F_LAST_STEP=9
G55F_START_FRAME=300
G55F_STEP_FRAMES=60
G55F_QUIT_FRAME=$((G55F_START_FRAME + G55F_STEP_FRAMES * G55F_LAST_STEP + 11))
# <step>:<ms> (gate1-design.md G1d): after step 1's shot, block the receiver long enough that PH
# (every-frame shader parameter) changes for well over 60 frames and step 3's code change (tint
# -> tint_b, applied frame S+3N=480) lands inside the stall.
# GRT3: in host frames at 60 fps; legs_stall_spec converts them at the leg's own host rate
# (exactly these milliseconds at 60 fps; scripts/README.md "Fast frames (GRT3)").
G55F_STALL_STEP=1
G55F_STALL_FRAMES=120 # 2000 ms
G55F_STALL_SPEC=""

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--extension)
		EXTENSION="${2:-}"
		shift 2
		;;
	--calibration)
		CALIBRATION="${2:-}"
		shift 2
		;;
	--binary)
		BINARY="${2:-}"
		shift 2
		;;
	--out)
		OUT="${2:-}"
		shift 2
		;;
	--legs)
		LEGS_ARG="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate55 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate55: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate55: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate55: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate55: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
for project in "$CIM_FIXTURE_DIR" "$SHADER_FIXTURE_DIR" "$SCREEN_FIXTURE_DIR" "$VERTEX_FIXTURE_DIR" "$TIME_FIXTURE_DIR"; do
	if [ ! -f "$project/project.godot" ]; then
		echo "run-gate55: $project/project.godot is missing" >&2
		exit 1
	fi
done

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${LANDED_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate55: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate55: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

# g55d's receivers replay g55b's captures and compare with g55b's references (gate5_5-design.md
# G55b amendment 8): requesting g55d without g55b runs g55b too. Groups run in LANDED order.
case " ${GROUPS_RUN[*]} " in
*" g55d "*)
	case " ${GROUPS_RUN[*]} " in
	*" g55b "*) ;;
	*)
		echo "run-gate55: g55d needs g55b's captures and references in the same run: adding g55b"
		GROUPS_RUN+=(g55b)
		;;
	esac
	;;
esac
# g55e's receivers replay g55c's captures and compare with g55c's references (and its params
# library comes from g55c's reference oracle): requesting g55e without g55c runs g55c too.
case " ${GROUPS_RUN[*]} " in
*" g55e "*)
	case " ${GROUPS_RUN[*]} " in
	*" g55c "*) ;;
	*)
		echo "run-gate55: g55e needs g55c's captures, references and oracle library in the same run: adding g55c"
		GROUPS_RUN+=(g55c)
		;;
	esac
	;;
esac
ORDERED_GROUPS=()
for group in "${LANDED_GROUPS[@]}"; do
	case " ${GROUPS_RUN[*]} " in
	*" $group "*) ORDERED_GROUPS+=("$group") ;;
	esac
done
GROUPS_RUN=("${ORDERED_GROUPS[@]}")

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate55: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate55/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate55: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate55: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
printf '{"path": "%s", "sha256": "%s"}\n' "$BINARY" "$ACTUAL_BINARY_SHA256" >"$OUT/binary.json"
{
	printf '{"groups_run": ['
	sep=""
	for group in "${GROUPS_RUN[@]}"; do
		printf '%s"%s"' "$sep" "$group"
		sep=", "
	done
	printf '], "groups_landed": ['
	sep=""
	for group in "${LANDED_GROUPS[@]}"; do
		printf '%s"%s"' "$sep" "$group"
		sep=", "
	done
	printf ']}\n'
} >"$OUT/legs.json"

HAVE_STRACE=0
command -v strace >/dev/null 2>&1 && HAVE_STRACE=1
[ "$HAVE_STRACE" = "1" ] || echo "run-gate55: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate55: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# The capture writes both sinks under gate 2's .rs2 names whatever wire version main speaks
# (render-stream/5 since G55d), and its payload store <capture>/store.
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate55"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# A rendered fixture run (reference, reference-repeat, reference-armed): shots step-0..9 at the
# settle frames and the step log. REFERENCE_ARMED=1 loads the capture extension armed with a
# full-sink stream and its store. REFERENCE_VARIANT sets RS_FIXTURE_VARIANT. REFERENCE_FIXTURE_DIR
# picks the project (default FIXTURE_DIR) and REFERENCE_MATERIAL_ORACLE=1 turns the material oracle
# on (RS_FIXTURE_MATERIAL_LOG=<dir>/materials.jsonl, fixtures/gate55-shader only).
# REFERENCE_START_FRAME / _STEP_FRAMES / _QUIT_FRAME (G55f, gate5-design.md G5f's identical
# pattern) override the fixture's own step timeline, so the shots land on the live timeline's own
# frames (PH's per-frame phase only lines up with a live shot taken at the identical frame
# number). All are reset after the call.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
REFERENCE_FIXTURE_DIR=""
REFERENCE_MATERIAL_ORACLE=0
REFERENCE_START_FRAME=""
REFERENCE_STEP_FRAMES=""
REFERENCE_QUIT_FRAME=""
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT"
	local project="${REFERENCE_FIXTURE_DIR:-$FIXTURE_DIR}" oracle="$REFERENCE_MATERIAL_ORACLE"
	local start="$REFERENCE_START_FRAME" span="$REFERENCE_STEP_FRAMES" quit="$REFERENCE_QUIT_FRAME"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	REFERENCE_FIXTURE_DIR=""
	REFERENCE_MATERIAL_ORACLE=0
	REFERENCE_START_FRAME=""
	REFERENCE_STEP_FRAMES=""
	REFERENCE_QUIT_FRAME=""
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
	if [ -n "$start" ]; then
		LEG_ENV+=(RS_FIXTURE_START_FRAME="$start")
	fi
	if [ -n "$span" ]; then
		LEG_ENV+=(RS_FIXTURE_STEP_FRAMES="$span")
	fi
	if [ -n "$quit" ]; then
		LEG_ENV+=(RS_FIXTURE_QUIT_FRAME="$quit")
	fi
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	if [ "$oracle" = "1" ]; then
		LEG_ENV+=(RS_FIXTURE_MATERIAL_LOG="$dir/materials.jsonl")
	fi
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store"
		)
	fi
	run_rendered "$dir" "$project"
}

# One scene of fixtures/gate55-cim (variant "" = base) under <scene dir>: the capture host
# (headless, release template, extension armed, both sinks and the store, strace + /proc maps/fd
# sample). On render-stream/5 (G55d) every material, shader and item material field is carried
# (before G55d every item naming a material was typed unsupported-state); counters.json counts the
# material calls.
run_cim_capture() {
	local scene="$1" variant="$2"
	echo "run-gate55: capture-${scene##*/}"
	CAPTURE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	if [ -n "$variant" ]; then
		CAPTURE_EXTRA_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	run_capture "$scene/capture" "$CAPTURE_QUIT_FRAME" capture
}

# Its three rendered legs, inside the group's gamescope (already up).
run_cim_rendered() {
	local scene="$1" variant="$2" label="reference-${1##*/}"
	echo "run-gate55: $label"
	REFERENCE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	REFERENCE_VARIANT="$variant"
	run_reference "$scene/reference"
	echo "run-gate55: $label-repeat"
	REFERENCE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	REFERENCE_VARIANT="$variant"
	run_reference "$scene/reference-repeat"
	echo "run-gate55: $label-armed (extension armed, stream on)"
	REFERENCE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	REFERENCE_VARIANT="$variant"
	REFERENCE_ARMED=1
	run_reference "$scene/reference-armed"
}

run_g55b() {
	local B="$OUT/cim" M="$OUT/cim-modulate"
	mkdir -p "$B/import"
	echo "run-gate55: g55b: import"
	LEG_ENV=()
	run_headless "$B/import/fixture" none -- mise exec -- godot --headless --path "$CIM_FIXTURE_DIR" --import
	if [ "$(cat "$B/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $CIM_FIXTURE_DIR failed, see $B/import/fixture/stdout.log" >&2
		exit 1
	fi

	run_cim_capture "$B" ""
	run_cim_capture "$M" modulate

	echo "run-gate55: bringing up private gamescope for g55b rendered legs"
	gs_start 640 360 "$OUT/gamescope-g55b"
	run_cim_rendered "$B" ""
	run_cim_rendered "$M" modulate
	gs_teardown "$OUT/gamescope-g55b"
	GS_RUN_DIR=""
}

run_g55c() {
	local D="$OUT/shader" R="$OUT/shader-refused"
	mkdir -p "$D/import"
	echo "run-gate55: g55c: import"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$SHADER_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $SHADER_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi

	# capture-shader and capture-refused: the capture host (headless, release template, extension
	# armed, both sinks and the store, strace + /proc maps/fd sample). On render-stream/5 (G55d)
	# capture-shader carries every ShaderMaterial; capture-refused types its five refused items and
	# shaders; counters.json counts the material calls.
	echo "run-gate55: capture-shader"
	CAPTURE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size)
	run_capture "$D/capture" "$CAPTURE_QUIT_FRAME" capture
	echo "run-gate55: capture-refused"
	CAPTURE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_VARIANT=refused)
	run_capture "$R/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate55: bringing up private gamescope for g55c rendered legs"
	gs_start 640 360 "$OUT/gamescope-g55c"

	echo "run-gate55: reference-shader (oracle on)"
	REFERENCE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	REFERENCE_MATERIAL_ORACLE=1
	run_reference "$D/reference"
	echo "run-gate55: reference-shader-repeat (oracle on)"
	REFERENCE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	REFERENCE_MATERIAL_ORACLE=1
	run_reference "$D/reference-repeat"
	echo "run-gate55: reference-shader-armed (extension armed, stream on, oracle off)"
	REFERENCE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	REFERENCE_ARMED=1
	run_reference "$D/reference-armed"
	echo "run-gate55: reference-refused (oracle on)"
	REFERENCE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	REFERENCE_VARIANT=refused
	REFERENCE_MATERIAL_ORACLE=1
	run_reference "$R/reference"

	gs_teardown "$OUT/gamescope-g55c"
	GS_RUN_DIR=""
}

# Step k's applied frame (S=1, N=10; gate5_5-design.md Q6).
step_frame55() { echo $((1 + 10 * $1)); }

# A headless sabotage capture of fixtures/gate55-cim's base scene on the fixture's own default run
# (102 frames), both sinks and its store.
cim_sabotage_capture() {
	local dir="$1"
	shift
	CAPTURE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "" none
}

# One scene's all-inline capture: the 400-frame capture again with no store and both thresholds
# raised so every payload, GRP1 included, is a resource record (memory rs-g2b2-texture-wire-facts).
run_cim_capture_inline() {
	local scene="$1" variant="$2"
	echo "run-gate55: g55d: capture-${scene##*/}-inline (every payload inline, no store)"
	CAPTURE_FIXTURE_DIR="$CIM_FIXTURE_DIR"
	CAPTURE_STORE_DIR=none
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_RESOURCE_INLINE_MAX_BYTES=16777216
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216)
	if [ -n "$variant" ]; then
		CAPTURE_EXTRA_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	run_capture "$scene/capture-inline" "$CAPTURE_QUIT_FRAME" none
}

# One scene's honest receivers, inside the group's gamescope: the capture's full sink, its patch
# sink (state dumps at the settle seqs) and capture-inline.
run_cim_receivers() {
	local scene="$1" name="${1##*/}"
	echo "run-gate55: g55d: receiver-$name (full sink)"
	run_rendered_receiver "$scene/capture" "$scene/receiver"
	echo "run-gate55: g55d: receiver-$name-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	run_rendered_receiver "$scene/capture" "$scene/receiver-patch"
	echo "run-gate55: g55d: receiver-$name-inline (capture-inline, no store)"
	run_rendered_receiver "$scene/capture-inline" "$scene/receiver-inline"
}

run_g55d() {
	local B="$OUT/cim" M="$OUT/cim-modulate" scene
	for scene in "$B" "$M"; do
		if [ ! -f "$scene/capture/$RECORDING_NAME" ] || [ ! -d "$scene/reference/shots" ]; then
			echo "run-gate55: g55d needs g55b's capture and reference in $scene (g55b ran first?)" >&2
			exit 2
		fi
	done
	# The release template cannot run a loose project until the editor generated .godot/ (memory
	# receiver-needs-import-before-script): import the receiver once.
	echo "run-gate55: g55d: import (receiver)"
	LEG_ENV=()
	run_headless "$B/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$B/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $B/import/receiver/stdout.log" >&2
		exit 1
	fi

	run_cim_capture_inline "$B" ""
	run_cim_capture_inline "$M" modulate

	# Host sabotages on the base scene; predictions are fixtures/gate55-cim/expected.json
	# "predictions" (make_expected.py, never hand-edited).
	echo "run-gate55: g55d: sabotage-freeze (capture, freeze-frame @$(step_frame55 1))"
	cim_sabotage_capture "$B/sabotage-freeze/capture" GRC_SABOTAGE=freeze-frame \
		GRC_SABOTAGE_FRAME="$(step_frame55 1)"
	echo "run-gate55: g55d: sabotage-omit-material-set-shader (capture, omit-op material_set_shader @$(step_frame55 2))"
	cim_sabotage_capture "$B/sabotage-omit-material-set-shader/capture" GRC_SABOTAGE=omit-op \
		GRC_SABOTAGE_OP=material_set_shader GRC_SABOTAGE_FRAME="$(step_frame55 2)"

	echo "run-gate55: bringing up private gamescope for g55d receiver legs"
	gs_start 640 360 "$OUT/gamescope-g55d"

	run_cim_receivers "$B"
	run_cim_receivers "$M"
	for kind in freeze omit-material-set-shader; do
		echo "run-gate55: g55d: sabotage-$kind (receiver)"
		run_rendered_receiver "$B/sabotage-$kind/capture" "$B/sabotage-$kind/receiver"
	done
	echo "run-gate55: g55d: sabotage-receiver-ignore-material (RS_RECEIVER_SABOTAGE=ignore-material on cim/capture)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-material)
	run_rendered_receiver "$B/capture" "$B/sabotage-receiver-ignore-material"
	echo "run-gate55: g55d: sabotage-receiver-ignore-canvas-modulate (RS_RECEIVER_SABOTAGE=ignore-canvas-modulate on cim-modulate/capture)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=ignore-canvas-modulate)
	run_rendered_receiver "$M/capture" "$M/sabotage-receiver-ignore-canvas-modulate"

	gs_teardown "$OUT/gamescope-g55d"
	GS_RUN_DIR=""
}

# A headless sabotage or policy capture of fixtures/gate55-shader: `default` runs the fixture's own
# default run (102 frames), anything else is a quit frame; both sinks and its store (CAPTURE_STORE_DIR
# as run_capture reads it).
shader_capture() {
	local dir="$1" quit="$2"
	shift 2
	[ "$quit" = "default" ] && quit=""
	CAPTURE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "$quit" none
}

run_g55e() {
	local D="$OUT/shader" R="$OUT/shader-refused" P="$OUT/shader-policy-params"
	local X="$OUT/shader-policy-exclude" kind
	if [ ! -f "$D/capture/$RECORDING_NAME" ] || [ ! -f "$R/capture/$RECORDING_NAME" ] ||
		[ ! -d "$D/reference/shots" ] || [ ! -d "$D/reference/shader-library/sha256" ]; then
		echo "run-gate55: g55e needs g55c's captures, reference and oracle library in $D and $R (g55c ran first?)" >&2
		exit 2
	fi
	echo "run-gate55: g55e: import (receiver)"
	LEG_ENV=()
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate55: g55e: capture-shader-inline (every payload inline, no store)"
	CAPTURE_STORE_DIR=none
	shader_capture "$D/capture-inline" "$CAPTURE_QUIT_FRAME" GRC_RESOURCE_INLINE_MAX_BYTES=16777216 \
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216
	echo "run-gate55: g55e: capture-policy-params (GRC_SHADER_POLICY=params)"
	shader_capture "$P/capture" "$CAPTURE_QUIT_FRAME" GRC_SHADER_POLICY=params
	echo "run-gate55: g55e: capture-policy-exclude (GRC_SHADER_POLICY=exclude)"
	shader_capture "$X/capture" "$CAPTURE_QUIT_FRAME" GRC_SHADER_POLICY=exclude

	# Host sabotages; predictions are fixtures/gate55-shader/expected.json "predictions"
	# (make_expected.py, never hand-edited).
	echo "run-gate55: g55e: sabotage-shader-freeze (capture, freeze-frame @$(step_frame55 1))"
	shader_capture "$D/sabotage-freeze/capture" default GRC_SABOTAGE=freeze-frame \
		GRC_SABOTAGE_FRAME="$(step_frame55 1)"
	echo "run-gate55: g55e: sabotage-shader-omit-param (capture, omit-op material_set_param @$(step_frame55 2))"
	shader_capture "$D/sabotage-omit-param/capture" default GRC_SABOTAGE=omit-op \
		GRC_SABOTAGE_OP=material_set_param GRC_SABOTAGE_FRAME="$(step_frame55 2)"
	echo "run-gate55: g55e: sabotage-shader-perturb-shader (capture, perturb-shader @$(step_frame55 2))"
	shader_capture "$D/sabotage-perturb-shader/capture" default GRC_SABOTAGE=perturb-shader \
		GRC_SABOTAGE_FRAME="$(step_frame55 2)"

	# The params receiver's operator-local library (D4): built from the reference oracle's dumps
	# (shader_get_code on the rendered reference, Q6e), never from the capture.
	mkdir -p "$P/library"
	cp -R "$D/reference/shader-library/sha256" "$P/library/"

	echo "run-gate55: bringing up private gamescope for g55e receiver legs"
	gs_start 640 360 "$OUT/gamescope-g55e"

	echo "run-gate55: g55e: receiver-shader (full sink)"
	run_rendered_receiver "$D/capture" "$D/receiver"
	echo "run-gate55: g55e: receiver-shader-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	run_rendered_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate55: g55e: receiver-shader-inline (capture-inline, no store)"
	run_rendered_receiver "$D/capture-inline" "$D/receiver-inline"
	echo "run-gate55: g55e: receiver-refused (capture-refused's full sink)"
	run_rendered_receiver "$R/capture" "$R/receiver"
	echo "run-gate55: g55e: receiver-params-nolib (capture-policy-params, no library)"
	run_rendered_receiver "$P/capture" "$P/receiver-nolib"
	echo "run-gate55: g55e: receiver-params-lib (capture-policy-params, RS_RECEIVER_SHADER_LIBRARY from the oracle)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SHADER_LIBRARY="$P/library")
	run_rendered_receiver "$P/capture" "$P/receiver-lib"
	for kind in freeze omit-param perturb-shader; do
		echo "run-gate55: g55e: sabotage-shader-$kind (receiver)"
		run_rendered_receiver "$D/sabotage-$kind/capture" "$D/sabotage-$kind/receiver"
	done
	for kind in ignore-material stale-param; do
		echo "run-gate55: g55e: sabotage-shader-receiver-$kind (RS_RECEIVER_SABOTAGE=$kind on shader/capture)"
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE="$kind")
		run_rendered_receiver "$D/capture" "$D/sabotage-receiver-$kind"
	done

	gs_teardown "$OUT/gamescope-g55e"
	GS_RUN_DIR=""
}

# G55f: live legs on fixtures/gate55-shader, gate 1's live timeline (G55F_START_FRAME,
# G55F_STEP_FRAMES, G55F_QUIT_FRAME above). start_live_shader_host <dir> [extra env words...]: the
# shader fixture host (headless, armed, both file sinks and their store, --max-fps 60) serving on
# 127.0.0.1:0 in the background. Waits for evidence/live.json and sets LIVE_PORT ("" when the host
# is not listening).
start_live_shader_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME" GRC_RESOURCE_STORE_DIR="$dir/store"
		GRC_ROOT_SIZE=enforce-min-size GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		RS_FIXTURE_START_FRAME="$G55F_START_FRAME" RS_FIXTURE_STEP_FRAMES="$G55F_STEP_FRAMES"
		RS_FIXTURE_QUIT_FRAME="$G55F_QUIT_FRAME" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" "$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$SHADER_FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate55: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

# The live receiver's shot windows for G55f's timeline: <step>:<from>-<to>, steps
# 0..G55F_LAST_STEP (gate 1's rule: from the settle frame to the frame before the next step; the
# last to the quit).
g55f_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 "$G55F_LAST_STEP"); do
		from=$((G55F_START_FRAME + G55F_STEP_FRAMES * k + 7))
		to=$((G55F_START_FRAME + G55F_STEP_FRAMES * (k + 1) - 1))
		[ "$k" -eq "$G55F_LAST_STEP" ] && to=$G55F_QUIT_FRAME
		out+="$sep$k:$from-$to"
		sep=","
	done
	echo "$out"
}

# g55f_receiver <leg dir> <rendered|headless> [extra env words...]: a live receiver on the
# current host's port with a fresh cache at <leg>/receiver/cache (the extra words may override
# it) and --max-fps 60. Rendered receivers shoot the step windows (credit stage submitted).
g55f_receiver() {
	local leg="$1" kind="$2" dir="$1/receiver"
	shift 2
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate55: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_CACHE_DIR="$dir/cache" "$@"
	)
	if [ "$kind" = "headless" ]; then
		LEG_ENV+=(RS_RECEIVER_CREDIT_STAGE=applied)
		run_headless "$dir" openat -- "$BINARY" --headless --max-fps 60 --path "$RECEIVER_DIR"
	else
		LEG_ENV+=(RS_RECEIVER_SHOT_WINDOWS="$(g55f_windows)")
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$dir" "$RECEIVER_DIR"
	fi
}

# g55f_leg <leg> <rendered|headless> <host words...> -- <receiver words...>: one live host and
# one receiver against it, then the host to its quit frame.
g55f_leg() {
	local leg="$1" kind="$2"
	shift 2
	local -a host_words=() receiver_words=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		host_words+=("$1")
		shift
	done
	[ $# -gt 0 ] && shift
	receiver_words=("$@")
	start_live_shader_host "$S/$leg/host" ${host_words[@]+"${host_words[@]}"}
	g55f_receiver "$S/$leg" "$kind" ${receiver_words[@]+"${receiver_words[@]}"}
	finish_bg "$S/$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
}

run_g55f() {
	local S="$OUT/shader-live" f1
	f1=$((G55F_START_FRAME + G55F_STEP_FRAMES * 1))
	mkdir -p "$S/import"
	echo "run-gate55: g55f: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$S/import/fixture-g55f" none -- mise exec -- godot --headless --path "$SHADER_FIXTURE_DIR" --import
	if [ "$(cat "$S/import/fixture-g55f/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $SHADER_FIXTURE_DIR failed, see $S/import/fixture-g55f/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$S/import/receiver-g55f" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$S/import/receiver-g55f/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $S/import/receiver-g55f/stdout.log" >&2
		exit 1
	fi

	echo "run-gate55: bringing up private gamescope for g55f legs"
	gs_start 640 360 "$OUT/gamescope-g55f"

	echo "run-gate55: g55f: reference-live (S=$G55F_START_FRAME N=$G55F_STEP_FRAMES quit=$G55F_QUIT_FRAME)"
	REFERENCE_FIXTURE_DIR="$SHADER_FIXTURE_DIR"
	REFERENCE_START_FRAME="$G55F_START_FRAME"
	REFERENCE_STEP_FRAMES="$G55F_STEP_FRAMES"
	REFERENCE_QUIT_FRAME="$G55F_QUIT_FRAME"
	run_reference "$S/reference-live"

	echo "run-gate55: g55f: live-shader (host + rendered live receiver, fresh cache, shot windows $(g55f_windows))"
	g55f_leg live-shader rendered
	echo "run-gate55: g55f: live-shader-warm (a new host + a new rendered receiver on live-shader's cache)"
	g55f_leg live-shader-warm rendered -- \
		RS_RECEIVER_CACHE_DIR="$S/live-shader/receiver/cache" RS_RECEIVER_CACHE_MODE=warm
	G55F_STALL_SPEC="$(legs_stall_spec "$S/live-shader-stall/host" "$G55F_STALL_STEP" "$G55F_STALL_FRAMES")"
	echo "run-gate55: g55f: live-shader-stall (RS_RECEIVER_STALL=$G55F_STALL_SPEC)"
	g55f_leg live-shader-stall rendered -- RS_RECEIVER_STALL="$G55F_STALL_SPEC"
	G55F_STALL_SPEC="$(legs_stall_spec "$S/sabotage-shader-stale-coalesce/host" "$G55F_STALL_STEP" "$G55F_STALL_FRAMES")"
	echo "run-gate55: g55f: sabotage-shader-stale-coalesce (stale-coalesce @$f1, RS_RECEIVER_STALL=$G55F_STALL_SPEC)"
	g55f_leg sabotage-shader-stale-coalesce rendered GRC_SABOTAGE=stale-coalesce GRC_SABOTAGE_FRAME="$f1" -- \
		RS_RECEIVER_STALL="$G55F_STALL_SPEC"

	gs_teardown "$OUT/gamescope-g55f"
	GS_RUN_DIR=""
}

# P3-ST (gate5_5-design.md "Screen texture (P3-ST)"): fixtures/gate55-screen under <out>/screen/.
# Its import and the receiver's; a headless capture on the fixture's own default run (62 frames)
# with both sinks and the store; inside one gamescope the rendered reference and a same-build
# repeat, rendered receivers on the full sink and the patch sink, and the receiver sabotage
# screen-copy-per-reader (a fresh back-buffer copy before every screen-reading item: the copy taken
# at the wrong time), which must differ from the reference where a later reader reuses a copy.
run_g55s() {
	local D="$OUT/screen"
	mkdir -p "$D/import"
	echo "run-gate55: g55s: import"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$SCREEN_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $SCREEN_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	# render-stream/8, the product's wire, so gate 7's browser receivers can replay the same
	# capture (lib/legs.sh gate7_browser_leg routes GRS7..9 recordings).
	echo "run-gate55: g55s: capture-screen"
	CAPTURE_FIXTURE_DIR="$SCREEN_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_STREAM_VERSION=8)
	run_capture "$D/capture" "" none

	echo "run-gate55: bringing up private gamescope for g55s rendered legs"
	gs_start 640 360 "$OUT/gamescope-g55s"
	echo "run-gate55: g55s: reference-screen"
	REFERENCE_FIXTURE_DIR="$SCREEN_FIXTURE_DIR"
	run_reference "$D/reference"
	echo "run-gate55: g55s: reference-screen-repeat"
	REFERENCE_FIXTURE_DIR="$SCREEN_FIXTURE_DIR"
	run_reference "$D/reference-repeat"
	echo "run-gate55: g55s: receiver-screen (full sink)"
	run_rendered_receiver "$D/capture" "$D/receiver"
	echo "run-gate55: g55s: receiver-screen-patch (patch sink)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate55: g55s: sabotage-screen-receiver-copy-per-reader (RS_RECEIVER_SABOTAGE=screen-copy-per-reader)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=screen-copy-per-reader)
	run_rendered_receiver "$D/capture" "$D/sabotage-receiver-copy-per-reader"
	gs_teardown "$OUT/gamescope-g55s"
	GS_RUN_DIR=""
}

# P3-VX (gate5_5-design.md "vertex() (P3-VX)"): fixtures/gate55-vertex under <out>/vertex/, legs as
# g55s's: imports, a render-stream/8 capture, inside one gamescope the rendered reference and a
# repeat, rendered receivers on the full and patch sinks, and the receiver sabotage
# vertex-flat-varyings (every varying made `flat` before the receiver compiles the code), which
# must differ from the reference exactly where a smooth varying varies across a primitive.
run_g55v() {
	local D="$OUT/vertex"
	mkdir -p "$D/import"
	echo "run-gate55: g55v: import"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$VERTEX_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $VERTEX_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate55: g55v: capture-vertex"
	CAPTURE_FIXTURE_DIR="$VERTEX_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_STREAM_VERSION=8)
	run_capture "$D/capture" "" none

	echo "run-gate55: bringing up private gamescope for g55v rendered legs"
	gs_start 640 360 "$OUT/gamescope-g55v"
	echo "run-gate55: g55v: reference-vertex"
	REFERENCE_FIXTURE_DIR="$VERTEX_FIXTURE_DIR"
	run_reference "$D/reference"
	echo "run-gate55: g55v: reference-vertex-repeat"
	REFERENCE_FIXTURE_DIR="$VERTEX_FIXTURE_DIR"
	run_reference "$D/reference-repeat"
	echo "run-gate55: g55v: receiver-vertex (full sink)"
	run_rendered_receiver "$D/capture" "$D/receiver"
	echo "run-gate55: g55v: receiver-vertex-patch (patch sink)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate55: g55v: sabotage-vertex-receiver-flat-varyings (RS_RECEIVER_SABOTAGE=vertex-flat-varyings)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=vertex-flat-varyings)
	run_rendered_receiver "$D/capture" "$D/sabotage-receiver-flat-varyings"
	gs_teardown "$OUT/gamescope-g55v"
	GS_RUN_DIR=""
}

# P3-TM (gate5_5-design.md "TIME and sampler defaults (P3-TM)"): fixtures/gate55-time under
# <out>/time/, legs as g55v's, but the capture is render-stream/10 (which carries the host's shader
# time per transaction) and both the capture host and the rendered reference run --fixed-fps 60,
# so TIME at frame F is the same F steps of 1/60 on both. The receiver sabotage
# shader-time-frozen (every TIME reads 0) must differ from the reference exactly in the TIME items.
run_g55t() {
	local D="$OUT/time"
	mkdir -p "$D/import"
	echo "run-gate55: g55t: import"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$TIME_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $TIME_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate55: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate55: g55t: capture-time"
	CAPTURE_FIXTURE_DIR="$TIME_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_STREAM_VERSION=10)
	CAPTURE_EXTRA_ARGS=(--fixed-fps 60)
	run_capture "$D/capture" "" none

	echo "run-gate55: bringing up private gamescope for g55t rendered legs"
	gs_start 640 360 "$OUT/gamescope-g55t"
	echo "run-gate55: g55t: reference-time"
	REFERENCE_FIXTURE_DIR="$TIME_FIXTURE_DIR"
	RENDERED_EXTRA_ARGS=(--fixed-fps 60)
	run_reference "$D/reference"
	echo "run-gate55: g55t: reference-time-repeat"
	REFERENCE_FIXTURE_DIR="$TIME_FIXTURE_DIR"
	RENDERED_EXTRA_ARGS=(--fixed-fps 60)
	run_reference "$D/reference-repeat"
	echo "run-gate55: g55t: receiver-time (full sink)"
	run_rendered_receiver "$D/capture" "$D/receiver"
	echo "run-gate55: g55t: receiver-time-patch (patch sink)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate55: g55t: sabotage-time-receiver-frozen (RS_RECEIVER_SABOTAGE=shader-time-frozen)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE=shader-time-frozen)
	run_rendered_receiver "$D/capture" "$D/sabotage-receiver-time-frozen"
	gs_teardown "$OUT/gamescope-g55t"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g55b) run_g55b ;;
	g55s) run_g55s ;;
	g55v) run_g55v ;;
	g55t) run_g55t ;;
	g55c) run_g55c ;;
	g55d) run_g55d ;;
	g55e) run_g55e ;;
	g55f)
		if ! legs_skip_group g55f "$OUT/shader-live/reference-live" "$OUT/shader-live/live-shader" "$OUT/shader-live/live-shader-warm" "$OUT/shader-live/live-shader-stall" \
			"$OUT/shader-live/sabotage-shader-stale-coalesce"; then
			LEGS_TIMING_GROUP=g55f
			run_g55f
			LEGS_TIMING_GROUP=""
		fi
		;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate55: running checker"
cd "$REPO_ROOT"
# The checker only reads files, but it is heavy: it holds the shared quiet lock (lib/legs.sh),
# then the run's lock summary is written.
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate55.ts" --out "$OUT"
