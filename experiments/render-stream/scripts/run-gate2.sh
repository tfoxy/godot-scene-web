#!/usr/bin/env bash
# Gate 2 runner: drives fixtures/gate2/ through the legs of protocol/gate2-design.md "Q7. Runner,
# classes, report" for the groups that have landed, then runs check-gate2.ts.
#
#   bash run-gate2.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g2a,g2b,g2c]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate2/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g2a (G2a: the fixture,
# its rendered reference and a same-build repeat, the extension-armed reference, the RS call
# census and the copy at the hook) and g2b (G2b2: render-stream/2 with textures -- the store,
# inline records, cold/warm/patch/inline receivers, a live inline host, the unsupported variant
# and the sabotages) and g2c (G2c2: live resources over HTTP -- live hosts serving payloads by
# hash with pins and retirement, rendered and headless live receivers fetching before they apply,
# warm, replay, stall, reconnect and animate legs, and the unpin, drop-resource and live
# wrong-hash sabotages). g2b and g2c need g2a's captures and reference, so they only run together
# with g2a. Groups g2d-g2e arrive with their increments.
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Captured payloads are written only under the run
# directory (each capture's store/, each receiver's cache/), never anywhere else.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate2"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order. G2c-G2e add theirs here.
LANDED_GROUPS=(g2a g2b g2c)
KNOWN_GROUPS=(g2a g2b g2c g2d g2e)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The fixture's default timeline (fixtures/gate2/expected.json): step k >= 1 is applied at S + N*k.
# The main captures run 400 frames so the /proc maps/fd sample has time to run; the sabotage
# captures and the rendered legs run the fixture's default quit frame.
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180
START_FRAME=1
STEP_FRAMES=10
LAST_STEP=10
# The live inline leg (G2b2 "Live before HTTP"): gate 1's live timeline, S = 300, N = 60; the
# fixture quits at its default S + N*10 + 11.
LIVE_START_FRAME=300
LIVE_STEP_FRAMES=60
LIVE_QUIT_FRAME=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * LAST_STEP + 11))
step_frame() { echo $((START_FRAME + STEP_FRAMES * $1)); }

usage() {
	sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
		# `pnpm render-stream:gate2 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate2: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate2: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate2: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate2: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
if [ ! -f "$FIXTURE_DIR/project.godot" ]; then
	echo "run-gate2: $FIXTURE_DIR/project.godot is missing" >&2
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
			echo "run-gate2: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate2: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi
for group in g2b g2c; do
	case " ${GROUPS_RUN[*]} " in
	*" $group "*)
		case " ${GROUPS_RUN[*]} " in
		*" g2a "*) ;;
		*)
			echo "run-gate2: $group needs g2a's captures and reference; pass --legs g2a,$group" >&2
			exit 2
			;;
		esac
		;;
	esac
done

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate2: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate2/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate2: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate2: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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
[ "$HAVE_STRACE" = "1" ] || echo "run-gate2: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot processes it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
LIVE_HOST_PID=""
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate2: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${LIVE_HOST_PID:-}" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; then
		echo "run-gate2: stopping owned live host $LIVE_HOST_PID" >&2
		kill "$LIVE_HOST_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# render-stream/2 (G2b2): every capture writes both sinks (recording.rs2 full,
# recording-patch.rs2 patch) and its payload store <capture>/store.
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate2"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# A rendered fixture run (reference, reference-repeat, reference-armed, reference-unsupported):
# shots step-0..10 at the settle frames, the step log and the fixture's texture log.
# REFERENCE_ARMED=1 loads the capture extension armed with a full-sink stream and its store (so
# the texture hooks copy and hash at the hook); REFERENCE_VARIANT sets RS_FIXTURE_VARIANT.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	mkdir -p "$dir/shots"
	LEG_ENV=(
		RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
		RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl"
	)
	[ -n "$variant" ] && LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store"
		)
	fi
	run_rendered "$dir" "$FIXTURE_DIR"
}

# g2_capture <dir> <quit frame|""> <strace mode> [extra env words...]: a capture host on the
# gate 2 fixture (both sinks, the store at <dir>/store, GRC_ROOT_SIZE=enforce-min-size, the
# fixture's texture log), plus the extra words (sabotage, variant, inline policy).
# G2_NO_STORE=1 (reset after the call) leaves GRC_RESOURCE_STORE_DIR unset.
G2_NO_STORE=0
g2_capture() {
	local dir="$1" quit="$2" mode="$3"
	shift 3
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl" "$@")
	if [ "$G2_NO_STORE" = "1" ]; then
		CAPTURE_STORE_DIR=none
	else
		CAPTURE_EXTRA_ENV+=(GRC_RESOURCE_STORE_DIR="$dir/store")
	fi
	G2_NO_STORE=0
	run_capture "$dir" "$quit" "$mode"
}

# g2_receiver <capture dir> <dir> <rendered|headless> [extra env words...]: a file-mode receiver
# on a copy of the capture's full recording (G2_SOURCE, reset after the call, names another
# recording of that capture, e.g. the patch sink), with a fresh cache at <dir>/cache (the extra
# words may override it) and the capture's store as the origin when it has one. Rendered: shots
# and state dumps at the settle seqs. Headless: state dumps at the settle seqs; G2_TRACE=openat
# (reset after the call) runs it under strace.
G2_SOURCE=""
G2_TRACE=none
g2_receiver() {
	local capture_dir="$1" dir="$2" kind="$3" source="${G2_SOURCE:-$RECORDING_NAME}" trace="$G2_TRACE"
	shift 3
	G2_SOURCE=""
	G2_TRACE=none
	local seqs
	prepare_recording "$capture_dir/$source" "$dir" || return 0
	seqs="$(settle_seqs "$capture_dir" "$dir")" || return 0
	LEG_ENV=(RS_RECEIVER_RECORDING="$dir/$RECORDING_NAME" RS_RECEIVER_OUT="$dir/applied.json"
		RS_RECEIVER_CACHE_DIR="$dir/cache" RS_RECEIVER_STATE_SEQS="$seqs")
	[ -d "$capture_dir/store" ] && LEG_ENV+=(RS_RECEIVER_STORE_DIR="$capture_dir/store")
	LEG_ENV+=("$@")
	if [ "$kind" = "rendered" ]; then
		mkdir -p "$dir/shots"
		LEG_ENV+=(RS_RECEIVER_SHOT_SEQS="$seqs")
		run_rendered "$dir" "$RECEIVER_DIR"
	else
		run_headless "$dir" "$trace" -- "$BINARY" --headless --path "$RECEIVER_DIR"
	fi
}

run_g2a() {
	# import: the release template cannot load a loose project until the editor generated .godot/.
	echo "run-gate2: import"
	for project in fixture receiver; do
		local project_dir="$FIXTURE_DIR"
		[ "$project" = "receiver" ] && project_dir="$RECEIVER_DIR"
		LEG_ENV=()
		run_headless "$OUT/import/$project" none -- mise exec -- godot --headless --path "$project_dir" --import
		if [ "$(cat "$OUT/import/$project/exit-code.txt")" != "0" ]; then
			echo "run-gate2: import of $project_dir failed, see $OUT/import/$project/stdout.log" >&2
			exit 1
		fi
	done

	# Capture hosts (headless, release template, extension armed, both sinks and the store, the
	# texture hook log in evidence/resources.jsonl).
	echo "run-gate2: capture"
	g2_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate2: capture-unsupported (RS_FIXTURE_VARIANT=unsupported)"
	g2_capture "$OUT/capture-unsupported" "" none RS_FIXTURE_VARIANT=unsupported

	# Rendered legs: one private gamescope for all of them.
	echo "run-gate2: bringing up private gamescope for rendered legs"
	gs_start 640 360 "$OUT/gamescope"

	echo "run-gate2: reference"
	run_reference "$OUT/reference"
	echo "run-gate2: reference-repeat"
	run_reference "$OUT/reference-repeat"
	echo "run-gate2: reference-armed (extension armed, copy and hash at the hook active)"
	REFERENCE_ARMED=1
	run_reference "$OUT/reference-armed"

	gs_teardown "$OUT/gamescope"
	GS_RUN_DIR=""
}

# start_live_host <host dir> [extra env words...]: the gate 2 capture host (headless, armed, both
# file sinks and their store, --max-fps 60, the live timeline) serving on 127.0.0.1:0 in the
# background, plus the extra words (variant, sabotage, inline policy). Waits for
# evidence/live.json and sets LIVE_PORT ("" when the host is not listening).
start_live_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME" GRC_RESOURCE_STORE_DIR="$dir/store"
		GRC_ROOT_SIZE=enforce-min-size GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		RS_FIXTURE_START_FRAME="$LIVE_START_FRAME" RS_FIXTURE_STEP_FRAMES="$LIVE_STEP_FRAMES"
		RS_FIXTURE_QUIT_FRAME="$LIVE_QUIT_FRAME" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
		RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl" "$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	# Plain text parsing on purpose: a tsx start-up here would eat into the receiver's join budget.
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate2: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

run_g2b() {
	local f2 f6 f7 f21
	f2="$(step_frame 2)"
	f6="$(step_frame 6)"
	f7="$(step_frame 7)"
	f21="$f2"

	# Headless captures.
	echo "run-gate2: capture-inline (every payload in band, no store)"
	G2_NO_STORE=1
	g2_capture "$OUT/capture-inline" "$CAPTURE_QUIT_FRAME" none \
		GRC_RESOURCE_INLINE_MAX_BYTES=16777216 GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216

	echo "run-gate2: sabotage-omit-update (omit-op texture_2d_update @$f6)"
	g2_capture "$OUT/sabotage-omit-update/capture" "" none \
		GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update GRC_SABOTAGE_FRAME="$f6"
	echo "run-gate2: sabotage-omit-replace (omit-op texture_replace @$f7)"
	g2_capture "$OUT/sabotage-omit-replace/capture" "" none \
		GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_replace GRC_SABOTAGE_FRAME="$f7"
	echo "run-gate2: sabotage-stale-texture (stale-texture @$f6)"
	g2_capture "$OUT/sabotage-stale-texture/capture" "" none \
		GRC_SABOTAGE=stale-texture GRC_SABOTAGE_FRAME="$f6"
	echo "run-gate2: sabotage-wrong-hash (wrong-hash @$f6)"
	g2_capture "$OUT/sabotage-wrong-hash/capture" "" none \
		GRC_SABOTAGE=wrong-hash GRC_SABOTAGE_FRAME="$f6"
	echo "run-gate2: sabotage-spurious-update (spurious-texture-update @$f21)"
	g2_capture "$OUT/sabotage-spurious-update/capture" "" none \
		GRC_SABOTAGE=spurious-texture-update GRC_SABOTAGE_FRAME="$f21"

	# Headless receivers.
	echo "run-gate2: receiver-headless-trace (strace -e openat)"
	G2_TRACE=openat
	g2_receiver "$OUT/capture" "$OUT/receiver-headless-trace" headless
	echo "run-gate2: sabotage-wrong-hash receiver (fresh cache, the corrupted store)"
	g2_receiver "$OUT/sabotage-wrong-hash/capture" "$OUT/sabotage-wrong-hash/receiver" headless
	echo "run-gate2: sabotage-stale-texture receiver"
	g2_receiver "$OUT/sabotage-stale-texture/capture" "$OUT/sabotage-stale-texture/receiver" headless
	echo "run-gate2: sabotage-spurious-update receiver"
	g2_receiver "$OUT/sabotage-spurious-update/capture" "$OUT/sabotage-spurious-update/receiver" headless
	echo "run-gate2: sabotage-receiver-reupload (RS_RECEIVER_SABOTAGE=reupload)"
	g2_receiver "$OUT/capture" "$OUT/sabotage-receiver-reupload/receiver" headless \
		RS_RECEIVER_SABOTAGE=reupload

	# Live inline: every payload a resource record before its transaction. Since G2c2 live
	# connections follow the configured policy, so this host asks for inline delivery (1 MiB, the
	# live inline cap, covers the fixture's largest payload).
	echo "run-gate2: live-inline (host + headless live receiver, credit stage applied)"
	start_live_host "$OUT/live-inline/host" \
		GRC_RESOURCE_INLINE_MAX_BYTES=1048576 GRC_RESOURCE_MAX_PAYLOAD_BYTES=1048576
	mkdir -p "$OUT/live-inline/receiver"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see live-inline/host/evidence/live.json)" >"$OUT/live-inline/receiver/skipped.txt"
	else
		LEG_ENV=(
			RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
			RS_RECEIVER_OUT="$OUT/live-inline/receiver/applied.json"
			RS_RECEIVER_CACHE_DIR="$OUT/live-inline/receiver/cache" RS_RECEIVER_CREDIT_STAGE=applied
		)
		run_headless "$OUT/live-inline/receiver" none -- "$BINARY" --headless --max-fps 60 --path "$RECEIVER_DIR"
	fi
	finish_bg "$OUT/live-inline/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""

	# Rendered legs: one private gamescope.
	echo "run-gate2: bringing up private gamescope for g2b rendered legs"
	gs_start 640 360 "$OUT/gamescope-g2b"

	echo "run-gate2: reference-unsupported (rendered fixture, RS_FIXTURE_VARIANT=unsupported)"
	REFERENCE_VARIANT=unsupported
	run_reference "$OUT/reference-unsupported"
	echo "run-gate2: receiver-cold (fresh cache, store = capture/store)"
	g2_receiver "$OUT/capture" "$OUT/receiver-cold" rendered
	echo "run-gate2: receiver-warm (a new process on receiver-cold's cache, mode warm)"
	g2_receiver "$OUT/capture" "$OUT/receiver-warm" rendered \
		RS_RECEIVER_CACHE_DIR="$OUT/receiver-cold/cache" RS_RECEIVER_CACHE_MODE=warm
	echo "run-gate2: receiver-patch (the patch recording, its own fresh cache)"
	G2_SOURCE="$PATCH_RECORDING_NAME"
	g2_receiver "$OUT/capture" "$OUT/receiver-patch" rendered
	echo "run-gate2: receiver-inline (capture-inline, no store)"
	g2_receiver "$OUT/capture-inline" "$OUT/receiver-inline" rendered
	echo "run-gate2: unsupported-textures receiver (capture-unsupported)"
	g2_receiver "$OUT/capture-unsupported" "$OUT/unsupported-textures/receiver" rendered
	echo "run-gate2: sabotage-omit-update receiver"
	g2_receiver "$OUT/sabotage-omit-update/capture" "$OUT/sabotage-omit-update/receiver" rendered
	echo "run-gate2: sabotage-omit-replace receiver"
	g2_receiver "$OUT/sabotage-omit-replace/capture" "$OUT/sabotage-omit-replace/receiver" rendered

	gs_teardown "$OUT/gamescope-g2b"
	GS_RUN_DIR=""

	# A warm receiver that fetches anyway, on a copy of receiver-cold's cache (receiver-cold's own
	# stays as it left it).
	echo "run-gate2: sabotage-receiver-ignore-cache (warm, RS_RECEIVER_SABOTAGE=ignore-cache)"
	mkdir -p "$OUT/sabotage-receiver-ignore-cache/receiver"
	if [ -d "$OUT/receiver-cold/cache" ]; then
		cp -a "$OUT/receiver-cold/cache" "$OUT/sabotage-receiver-ignore-cache/receiver/warm-cache"
	fi
	g2_receiver "$OUT/capture" "$OUT/sabotage-receiver-ignore-cache/receiver" headless \
		RS_RECEIVER_CACHE_DIR="$OUT/sabotage-receiver-ignore-cache/receiver/warm-cache" \
		RS_RECEIVER_CACHE_MODE=warm RS_RECEIVER_SABOTAGE=ignore-cache
}

# The live receiver's shot windows for the live timeline: <step>:<from>-<to>, steps 0..LAST_STEP
# (gate 1's rule: from the settle frame to the frame before the next step; the last to the quit).
live_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 "$LAST_STEP"); do
		from=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * k + 7))
		to=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * (k + 1) - 1))
		[ "$k" -eq "$LAST_STEP" ] && to=$LIVE_QUIT_FRAME
		out+="$sep$k:$from-$to"
		sep=","
	done
	echo "$out"
}

# g2c_receiver <leg dir> <rendered|headless> [extra env words...]: a live receiver on the current
# host's port with a fresh cache at <leg>/receiver/cache (the extra words may override it) and
# --max-fps 60. Rendered receivers shoot the step windows (credit stage submitted); headless ones
# run with credit stage applied under strace -e openat.
g2c_receiver() {
	local leg="$1" kind="$2" dir="$1/receiver"
	shift 2
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate2: ${dir#"$OUT"/} skipped: the host is not listening" >&2
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
		LEG_ENV+=(RS_RECEIVER_SHOT_WINDOWS="$(live_windows)")
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$dir" "$RECEIVER_DIR"
	fi
}

# g2c_leg <leg> <rendered|headless> <host words...> -- <receiver words...>: one live host and one
# receiver against it, then the host to its quit frame.
g2c_leg() {
	local leg="$1" kind="$2"
	shift 2
	local -a host_words=() receiver_words=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		host_words+=("$1")
		shift
	done
	[ $# -gt 0 ] && shift
	receiver_words=("$@")
	start_live_host "$OUT/$leg/host" ${host_words[@]+"${host_words[@]}"}
	g2c_receiver "$OUT/$leg" "$kind" ${receiver_words[@]+"${receiver_words[@]}"}
	finish_bg "$OUT/$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
}

# g2c (G2c2): live resources over HTTP. Every host is the live timeline (S = 300, N = 60, quit 911)
# with both file sinks, the store, GRC_LIVE_LISTEN and GRC_LIVE_TAP_DIR, and the configured
# out-of-band policy (fetch http). The stall ends inside step 6's window, so step 6's texture
# update lands inside it and the first post-stall transaction carries A1 (gate2-design.md G2c2
# "As built"); unpin is armed from frame 1, before the receiver's first fetch, because ANIM has
# only six contents and a fresh cache holds all of them long before S + N.
G2C_STALL_SPEC="5:1300"
G2C_RECONNECT_STEP=7
G2C_FETCH_DELAY_MS=100
G2C_UNPIN_FRAME=1
run_g2c() {
	local f6 seqs
	f6=$((LIVE_START_FRAME + LIVE_STEP_FRAMES * 6))

	echo "run-gate2: live-headless (host + headless live receiver, fresh cache)"
	g2c_leg live-headless headless
	echo "run-gate2: sabotage-drop-resource (drop-resource @$f6, headless receiver)"
	g2c_leg sabotage-drop-resource headless GRC_SABOTAGE=drop-resource GRC_SABOTAGE_FRAME="$f6"
	echo "run-gate2: sabotage-wrong-hash-live (wrong-hash @$f6 served over HTTP, headless receiver)"
	g2c_leg sabotage-wrong-hash-live headless GRC_SABOTAGE=wrong-hash GRC_SABOTAGE_FRAME="$f6"

	echo "run-gate2: bringing up private gamescope for g2c rendered legs"
	gs_start 640 360 "$OUT/gamescope-g2c"

	echo "run-gate2: live (host + rendered live receiver, fresh cache, shot windows $(live_windows))"
	g2c_leg live rendered
	echo "run-gate2: live-replay (rendered file-mode receiver on live/receiver/received.rs2, store = live's cache)"
	if prepare_recording "$OUT/live/receiver/received.rs2" "$OUT/live-replay" &&
		seqs="$(gate0_tool live-shot-seqs "$OUT/live/receiver/applied.json")"; then
		mkdir -p "$OUT/live-replay/shots"
		LEG_ENV=(
			RS_RECEIVER_RECORDING="$OUT/live-replay/$RECORDING_NAME"
			RS_RECEIVER_OUT="$OUT/live-replay/applied.json" RS_RECEIVER_SHOT_SEQS="$seqs"
			RS_RECEIVER_STATE_SEQS="$seqs" RS_RECEIVER_CACHE_DIR="$OUT/live-replay/cache"
			RS_RECEIVER_STORE_DIR="$OUT/live/receiver/cache"
		)
		run_rendered "$OUT/live-replay" "$RECEIVER_DIR"
	fi
	echo "run-gate2: live-warm (a new host + a new rendered receiver on live's cache, mode warm)"
	g2c_leg live-warm rendered -- \
		RS_RECEIVER_CACHE_DIR="$OUT/live/receiver/cache" RS_RECEIVER_CACHE_MODE=warm
	echo "run-gate2: live-stall (RS_RECEIVER_STALL=$G2C_STALL_SPEC)"
	g2c_leg live-stall rendered -- RS_RECEIVER_STALL="$G2C_STALL_SPEC"
	echo "run-gate2: live-reconnect (RS_RECEIVER_RECONNECT=$G2C_RECONNECT_STEP)"
	g2c_leg live-reconnect rendered -- RS_RECEIVER_RECONNECT="$G2C_RECONNECT_STEP"
	echo "run-gate2: live-animate (RS_FIXTURE_VARIANT=animate, RS_RECEIVER_FETCH_DELAY_MS=$G2C_FETCH_DELAY_MS)"
	g2c_leg live-animate rendered RS_FIXTURE_VARIANT=animate -- \
		RS_RECEIVER_FETCH_DELAY_MS="$G2C_FETCH_DELAY_MS"
	echo "run-gate2: sabotage-unpin (as live-animate, unpin @$G2C_UNPIN_FRAME)"
	g2c_leg sabotage-unpin rendered RS_FIXTURE_VARIANT=animate GRC_SABOTAGE=unpin \
		GRC_SABOTAGE_FRAME="$G2C_UNPIN_FRAME" -- RS_RECEIVER_FETCH_DELAY_MS="$G2C_FETCH_DELAY_MS"

	gs_teardown "$OUT/gamescope-g2c"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g2a) run_g2a ;;
	g2b) run_g2b ;;
	g2c) run_g2c ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate2: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate2.ts" --out "$OUT"
