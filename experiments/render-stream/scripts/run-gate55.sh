#!/usr/bin/env bash
# Gate 5.5 runner: drives the gate 5.5 fixtures through the legs of protocol/gate5_5-design.md
# "Q7. Runner, legs, checks, report" for the groups that have landed, then runs check-gate55.ts.
#
#   bash run-gate55.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g55b,g55c,g55d]
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
# scene the receiver sabotage ignore-canvas-modulate (sabotage-receiver-ignore-canvas-modulate)).
# g55e and g55f are known but have not landed.
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
FIXTURE_DIR="$SHADER_FIXTURE_DIR"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order.
LANDED_GROUPS=(g55b g55c g55d)
KNOWN_GROUPS=(g55b g55c g55d g55e g55f)

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
for project in "$CIM_FIXTURE_DIR" "$SHADER_FIXTURE_DIR"; do
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
# on (RS_FIXTURE_MATERIAL_LOG=<dir>/materials.jsonl, fixtures/gate55-shader only). All are reset
# after the call.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
REFERENCE_FIXTURE_DIR=""
REFERENCE_MATERIAL_ORACLE=0
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT"
	local project="${REFERENCE_FIXTURE_DIR:-$FIXTURE_DIR}" oracle="$REFERENCE_MATERIAL_ORACLE"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	REFERENCE_FIXTURE_DIR=""
	REFERENCE_MATERIAL_ORACLE=0
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
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

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g55b) run_g55b ;;
	g55c) run_g55c ;;
	g55d) run_g55d ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate55: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate55.ts" --out "$OUT"
