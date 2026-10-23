#!/usr/bin/env bash
# Gate 8 runner: drives the gate 8 fixtures through the legs of protocol/gate8-design.md "Q7.
# Runner, legs, smoke map" for the groups that have landed, then runs check-gate8.ts.
#
#   bash run-gate8.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g8t]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate8/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed:
#
#   g8t (G8t, Q3: host decode of block-compressed textures, fixtures/gate8-tex): the import (the
#       pinned editor writes the synthetic sources, make_sources.gd, and VRAM-compresses them into
#       S3TC/BPTC and ETC2/ASTC variants: release templates cannot encode), the decode oracle (a
#       separate headless template process decoding every .ctex with Image.decompress), a headless
#       /8 capture under GRC_TEXTURE_DECODE=engine (both sinks and the store), the
#       GRC_TEXTURE_DECODE=off control capture (default /6, today's refusals), the perturb-decode
#       sabotage capture; then, rendered, the `reference` (the oracle's CPU-decoded payloads drawn
#       as plain textures), `reference-hw` (the .ctex sampled by the GPU or GLES3's own fallback:
#       an informative band), the native receiver on the full and the patch sink, and the receiver
#       on the sabotage capture; last the decode-cost timing group (decode-cost/oracle-timing:
#       best-of-3 Image.decompress of the 2048x2048 cost textures; decode-cost/capture: the hook's
#       own decode/copy/hash times on them), each under the exclusive quiet lock (timing_leg).
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-tex"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order (G8a, G8h, G8f, G8r, G8m add theirs).
LANDED_GROUPS=(g8t)
KNOWN_GROUPS=(g8t)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The fixture's default timeline (fixtures/gate8-tex/gate8_tex.gd): step 1 at S + N = 11.
START_FRAME=1
STEP_FRAMES=10
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
		shift
		;;
	*)
		echo "run-gate8: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate8: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate8: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate8: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
if [ ! -f "$FIXTURE_DIR/project.godot" ]; then
	echo "run-gate8: $FIXTURE_DIR/project.godot is missing" >&2
	exit 1
fi

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${LANDED_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate8: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate8: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate8/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate8: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate8: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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

cleanup() {
	if declare -F legs_par_cleanup >/dev/null; then
		legs_par_cleanup
	fi
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate8: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# render-stream/8 file sinks (GRC_STREAM_VERSION=8, gate8-design.md D2): every gate 8 policy needs
# them. The decode-off control capture is the default /6 and names its recording accordingly.
RECORDING_NAME=recording.rs8
PATCH_RECORDING_NAME=recording-patch.rs8
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate8"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# The decode policy every g8t capture but decode-off runs with.
G8T_DECODE_ENV=(GRC_STREAM_VERSION=8 GRC_TEXTURE_DECODE=engine)

# run_import_g8t: the editor writes the sources (make_sources.gd) and imports them; the receiver
# project is imported too (the release template cannot load a loose project before that).
run_import_g8t() {
	echo "run-gate8: import (sources, fixture, receiver)"
	LEG_ENV=()
	run_headless "$OUT/import/sources" none -- mise exec -- godot --headless --path "$FIXTURE_DIR" --script res://make_sources.gd
	LEG_ENV=()
	run_headless "$OUT/import/fixture" none -- mise exec -- godot --headless --path "$FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$OUT/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	local leg
	for leg in sources fixture receiver; do
		if [ "$(cat "$OUT/import/$leg/exit-code.txt")" != "0" ]; then
			echo "run-gate8: import ($leg) failed, see $OUT/import/$leg/stdout.log" >&2
			exit 1
		fi
	done
}

# run_oracle <dir> [timing]: oracle.gd on the release template, headless (gate8-design.md D15).
run_oracle() {
	local dir="$1" timing="${2:-0}"
	mkdir -p "$dir"
	LEG_ENV=(RS_ORACLE_OUT="$dir")
	if [ "$timing" = 1 ]; then
		LEG_ENV+=(RS_ORACLE_TIMING=1)
		cat /proc/loadavg >"$dir/loadavg.txt" 2>/dev/null || true
	fi
	run_headless "$dir" none -- "$BINARY" --headless --path "$FIXTURE_DIR" --script res://oracle.gd
}

# run_cost_capture <dir>: the decode-cost capture (RS_FIXTURE_VARIANT=cost), the machine's load
# recorded beside it once the exclusive hold is taken (the numbers are only as quiet as the host).
run_cost_capture() {
	local dir="$1"
	mkdir -p "$dir"
	cat /proc/loadavg >"$dir/loadavg.txt" 2>/dev/null || true
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" RS_FIXTURE_VARIANT=cost
		RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl")
	CAPTURE_WITH_PATCH=0
	run_capture "$dir" "" none
	CAPTURE_WITH_PATCH=1
}

# run_reference_g8t <dir> <ctex|decoded>: a rendered fixture run, shots step-<k> at the settle frames.
run_reference_g8t() {
	local dir="$1" source="$2"
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
		RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl" RS_FIXTURE_SOURCE="$source")
	[ "$source" = decoded ] && LEG_ENV+=(RS_FIXTURE_DECODED_DIR="$OUT/oracle")
	run_rendered "$dir" "$FIXTURE_DIR"
}

run_g8t() {
	run_import_g8t

	echo "run-gate8: oracle"
	run_oracle "$OUT/oracle"

	echo "run-gate8: capture (GRC_TEXTURE_DECODE=engine, /8)"
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" RS_FIXTURE_TEXTURE_LOG="$OUT/capture/textures.jsonl")
	run_capture "$OUT/capture" "" none

	echo "run-gate8: decode-off (GRC_TEXTURE_DECODE unset, default /6: today's refusals)"
	RECORDING_NAME=recording.rs2
	PATCH_RECORDING_NAME=recording-patch.rs2
	CAPTURE_EXTRA_ENV=(RS_FIXTURE_TEXTURE_LOG="$OUT/decode-off/capture/textures.jsonl")
	run_capture "$OUT/decode-off/capture" "" none
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8

	local f1=$((START_FRAME + STEP_FRAMES))
	echo "run-gate8: sabotage-perturb-decode (capture, perturb-decode @$f1)"
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" GRC_SABOTAGE=perturb-decode GRC_SABOTAGE_FRAME="$f1"
		RS_FIXTURE_TEXTURE_LOG="$OUT/sabotage-perturb-decode/capture/textures.jsonl")
	run_capture "$OUT/sabotage-perturb-decode/capture" "" none

	echo "run-gate8: bringing up private gamescope for g8t's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8t"
	legs_par_begin

	echo "run-gate8: reference (the oracle's CPU-decoded payloads)"
	run_reference_g8t "$OUT/reference" decoded
	echo "run-gate8: reference-hw (the .ctex, GPU-sampled or GLES3's fallback; informative)"
	run_reference_g8t "$OUT/reference-hw" ctex

	echo "run-gate8: receiver"
	run_rendered_receiver "$OUT/capture" "$OUT/receiver"
	echo "run-gate8: receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/capture" "$OUT/receiver-patch"
	echo "run-gate8: sabotage-perturb-decode (receiver)"
	run_rendered_receiver "$OUT/sabotage-perturb-decode/capture" "$OUT/sabotage-perturb-decode/receiver"

	legs_par_end
	gs_teardown "$OUT/gamescope-g8t"
	GS_RUN_DIR=""

	# decode-cost (Q3, a timing group): real time, each leg under the exclusive quiet lock.
	if ! legs_skip_group decode-cost "$OUT/decode-cost/oracle-timing" "$OUT/decode-cost/capture"; then
		echo "run-gate8: decode-cost/oracle-timing (best-of-3 Image.decompress, 2048x2048)"
		timing_leg g8t-decode-cost-oracle run_oracle "$OUT/decode-cost/oracle-timing" 1
		echo "run-gate8: decode-cost/capture (the hook's decode, copy and hash on the cost textures)"
		timing_leg g8t-decode-cost-capture run_cost_capture "$OUT/decode-cost/capture"
	fi
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g8t) run_g8t ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate8: running checker"
cd "$REPO_ROOT"
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate8.ts" --out "$OUT"
