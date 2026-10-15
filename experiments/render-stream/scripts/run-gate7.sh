#!/usr/bin/env bash
# Gate 7 runner (G7h skeleton; G7d adds the phone-target groups g7-dev and g7-bench and the device
# environment; protocol/gate7-design.md "G7h", "G7d", Q13).
#
#   bash run-gate7.sh [--legs g7-dev,g7-bench,...] [--out DIR] \
#     [--env desktop|device] [--device g31|g86] [--receiver native|gsw|web] \
#     [--bench-inputs <inputs.json>] [--repeats N] [--hold-seconds S] [--plan-only] \
#     [--extension X.gdextension] [--calibration record.json] [--binary template] \
#     [--source gate0=/abs/run/dir,...] [--make-sources] [--skip-harness-selftest] \
#     [--bundle /abs/web-receiver/<sha>/bundle]
#
# Device arms never run without both `--env device` and `--device <id>` (D28): either flag alone is
# a usage error (exit 2), and a run without `--env device` never selects a `dev-` arm. The g86 is
# operator-attended (D28): its device arms also need RS_GATE7_OPERATOR_ATTENDED=g86, set only with
# the user's go-ahead in that session. The g31 has standing approval.
#
# Groups landed (G7d):
#   g7-dev    Q13d's phone legs. Desktop (no --env device): <out>/g7-dev/plan.json lists only the
#             `ctl-` control arms, plus the pace fixture's native legs, which run now:
#               pace/import/{fixture,receiver}  the editor's --import of both projects
#               pace/capture/                   fixtures/gate7-pace, release template, --headless,
#                                               armed, full + patch sinks and the store, 400 frames
#               pace/reference/                 rendered in a private 640x360 gamescope, 8 shots
#               pace/receiver{,-patch}/         rendered receivers on the full and patch sinks
#             Every live dev-/ctl- leg waits for the increments its plan entry names (G7a, G7e,
#             G7n, G7l, G7q, G7k; G7v runs them) and is reported not-run. With --env device:
#             the device's plan, and a device session check (device-provenance, the session
#             settings recorded and restored, the Q13a/Q13b device probes) into
#             <out>/g7-dev/dev-session-<id>/.
#   g7-bench  Q13e's decode/apply microbench. Inputs: --bench-inputs, or captured here into
#             <out>/g7-bench/inputs/ (gate6-scene `animate` 400 frames, gate6-hd native, the pace
#             fixture; headless captures, both sinks). Arms (scripts/gate7-bench.ts):
#               desktop: native-bench-<input> (receiver.gd file mode, headless), ctl-bench-<input>-gsw
#                        (headless Chromium, D9), ctl-bench-<input>-web (unavailable until G7e)
#               device:  dev-bench-<input>-gsw-<id> and -web-<id>, plus the device probes
#             --receiver limits the run to one receiver: one command per phone and per receiver,
#               pnpm render-stream:gate7 -- --legs g7-bench --env device --device g31 --receiver gsw \
#                 --bench-inputs <a desktop run>/g7-bench/inputs/inputs.json
#
# G7h's browser-harness self-test (scripts/test/self-test-browser-harness.ts) runs first into
# <out>/g7h-probes/ unless --plan-only, --env device or --skip-harness-selftest.
#
# Group landed (G7e):
#   g7-0      gate 0's receiver legs in the web export (the gsw half is G7a's). Sources (D21):
#             `--source gate0=<dir>` names a native gate 0 run, or `--make-sources` makes one by
#             running run-gate0.sh (with --extension/--calibration) into <out>/sources-made/gate0/
#             and records the build's provenance there (gate7-source.json: git commit, the build
#             paths' dirty digest, capture library and template sha256); check-gate7.ts's
#             source-run-valid refuses a source from another build or one whose native receiver
#             legs did not pass. build-web-receiver.sh (or `--bundle`, an existing build) exports
#             the web receiver; gate7-tool.ts web-legs replays every gate 0 receiver leg, the
#             css-opacity sabotage and the render-time probe through lib/browser-harness.ts into
#             <out>/gate0/web/<leg>/; check-gate7.ts judges them with gate 0's own checker
#             (lib/gate7-adapters.ts). Sources are recorded in <out>/sources.json.
#
# NEVER Xvfb, never a desktop window, never headed Chromium (D9, memory
# xvfb-does-not-isolate-on-wayland): Chromium launches through scripts/lib/browser-harness.ts only,
# and rendered Godot legs share ONE private `gamescope --backend headless` (lib/gamescope.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
PACE_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate7-pace"
SCENE_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate6-scene"
HD_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate6-hd"
FIXTURE_DIR="$PACE_FIXTURE_DIR"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# The final leg-group vocabulary (gate7-design.md "Gate 7 passes when…") plus the phone groups.
KNOWN_GROUPS=(g7-0 g7-1 g7-2 g7-3 g7-4 g7-5 g7-55 g7-6 g7-lc g7-r g7-k g7-dev g7-bench)
LANDED_GROUPS=(g7-0 g7-dev g7-bench)

OUT=""
LEGS_ARG=""
SOURCE_ARG=""
MAKE_SOURCES=0
HARNESS_ENV="desktop"
DEVICE=""
RECEIVER=""
BENCH_INPUTS=""
REPEATS=5
HOLD_SECONDS=30
PLAN_ONLY=0
SKIP_HARNESS_SELFTEST=0
BUNDLE=""
EXTENSION="$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180
PACE_QUIT_FRAME=400
SCENE_QUIT_FRAME=400

usage() {
	sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--legs)
		LEGS_ARG="${2:-}"
		shift 2
		;;
	--out)
		OUT="${2:-}"
		shift 2
		;;
	--source)
		SOURCE_ARG="${2:-}"
		shift 2
		;;
	--make-sources)
		MAKE_SOURCES=1
		shift
		;;
	--env)
		HARNESS_ENV="${2:-}"
		shift 2
		;;
	--device)
		DEVICE="${2:-}"
		shift 2
		;;
	--receiver)
		RECEIVER="${2:-}"
		shift 2
		;;
	--bench-inputs)
		BENCH_INPUTS="${2:-}"
		shift 2
		;;
	--repeats)
		REPEATS="${2:-}"
		shift 2
		;;
	--hold-seconds)
		HOLD_SECONDS="${2:-}"
		shift 2
		;;
	--plan-only)
		PLAN_ONLY=1
		shift
		;;
	--skip-harness-selftest)
		SKIP_HARNESS_SELFTEST=1
		shift
		;;
	--bundle)
		BUNDLE="${2:-}"
		shift 2
		;;
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
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate7 -- <flags>` forwards the separator itself (memory
		# pnpm-script-dashdash-forwarding).
		shift
		;;
	*)
		echo "run-gate7: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

tool() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-phone-tool.ts" "$@")
}

# D28: --env device and --device go together, and the id must be in the device table.
set +e
tool check-selection "$HARNESS_ENV" "$DEVICE"
selection_exit=$?
set -e
if [ "$selection_exit" != "0" ]; then
	echo "run-gate7: refusing (see above)" >&2
	exit 2
fi
case "$RECEIVER" in
"" | native | gsw | web) ;;
*)
	echo "run-gate7: --receiver must be native, gsw or web (got $RECEIVER)" >&2
	exit 2
	;;
esac
if [ "$HARNESS_ENV" = "device" ] && [ "$RECEIVER" = "native" ]; then
	echo "run-gate7: the native receiver runs on the desktop only (drop --env device)" >&2
	exit 2
fi

GROUPS_RUN=()
if [ -n "$LEGS_ARG" ]; then
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate7: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate7: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]}; see protocol/gate7-design.md \"Increments\")" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate7/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate7: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate7: evidence directory: $OUT (groups: ${GROUPS_RUN[*]:-none}; env: $HARNESS_ENV${DEVICE:+ device $DEVICE})"

# D21 sources (G7e): --source gate0=<dir>, or --make-sources below.
declare -A SOURCES=()
if [ -n "$SOURCE_ARG" ]; then
	IFS=',' read -r -a pairs <<<"$SOURCE_ARG"
	for pair in "${pairs[@]}"; do
		SOURCES["${pair%%=*}"]="$(realpath "${pair#*=}")"
	done
fi
printf '{"env": "%s", "device": %s, "receiver": %s, "groups": "%s", "plan_only": %s}\n' "$HARNESS_ENV" \
	"$([ -n "$DEVICE" ] && echo "\"$DEVICE\"" || echo null)" "$([ -n "$RECEIVER" ] && echo "\"$RECEIVER\"" || echo null)" \
	"${GROUPS_RUN[*]:-}" "$([ "$PLAN_ONLY" = 1 ] && echo true || echo false)" >"$OUT/run.json"

has_group() {
	case " ${GROUPS_RUN[*]:-} " in
	*" $1 "*) return 0 ;;
	*) return 1 ;;
	esac
}

# --- Plans (always, cheap). -----------------------------------------------------------------
for group in g7-dev g7-bench; do
	has_group "$group" || continue
	plan_args=(plan --group "$group" --out "$OUT/$group/plan.json")
	[ -n "$DEVICE" ] && plan_args+=(--device "$DEVICE")
	[ "$group" = "g7-bench" ] && [ -n "$BENCH_INPUTS" ] && plan_args+=(--inputs "$BENCH_INPUTS")
	tool "${plan_args[@]}"
done
if [ "$PLAN_ONLY" = "1" ]; then
	echo "run-gate7: --plan-only: plans written, nothing launched"
	exit 0
fi

g7tool() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-tool.ts" "$@")
}

# --- g7-0 (G7e): the gate 0 source run, before anything else touches the machine. -----------
CHECK_ARGS=(--out "$OUT" --legs "$LEGS_ARG")
if has_group g7-0; then
	if [ "$HARNESS_ENV" != "desktop" ]; then
		echo "run-gate7: g7-0 runs on the desktop only (drop --env device)" >&2
		exit 2
	fi
	if [ ! -f "$EXTENSION" ]; then
		echo "run-gate7: g7-0 needs the capture extension ($EXTENSION; build-capture.sh or --extension)" >&2
		exit 1
	fi
	EXTENSION="$(realpath "$EXTENSION")"
	if [ -z "${SOURCES[gate0]:-}" ]; then
		if [ "$MAKE_SOURCES" = 0 ]; then
			echo "run-gate7: g7-0 needs --source gate0=<run dir> or --make-sources" >&2
			exit 2
		fi
		echo "run-gate7: making the gate 0 source run (run-gate0.sh)" >&2
		set +e
		bash "$SCRIPT_DIR/run-gate0.sh" --extension "$EXTENSION" --calibration "$(realpath "$CALIBRATION")" \
			--out "$OUT/sources-made/gate0"
		gate0_exit=$?
		set -e
		echo "run-gate7: run-gate0.sh exit=$gate0_exit (source-run-valid judges it)" >&2
		SOURCES[gate0]="$OUT/sources-made/gate0"
		g7tool source-provenance --extension "$EXTENSION" --out "${SOURCES[gate0]}/gate7-source.json"
	fi
fi
{
	printf '{"sources": {'
	first=1
	for key in "${!SOURCES[@]}"; do
		[ "$first" = 1 ] || printf ', '
		first=0
		printf '"%s": "%s"' "$key" "${SOURCES[$key]}"
	done
	printf '}, "make_sources": %s, "bundle": "%s"}\n' "$([ "$MAKE_SOURCES" = 1 ] && echo true || echo false)" "$BUNDLE"
} >"$OUT/sources.json"

# --- G7h's browser-harness self-test (desktop Chromium). ------------------------------------
if [ "$HARNESS_ENV" = "desktop" ] && [ "$SKIP_HARNESS_SELFTEST" = "0" ]; then
	echo "run-gate7: running the G7h browser-harness self-test into $OUT/g7h-probes" >&2
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
		"$SCRIPT_DIR/test/self-test-browser-harness.ts" --out "$OUT/g7h-probes")
fi

# --- Godot plumbing (desktop captures and rendered legs only). ------------------------------
NEED_GODOT=0
if [ "$HARNESS_ENV" = "desktop" ] && has_group g7-dev; then NEED_GODOT=1; fi
if has_group g7-bench && [ -z "$BENCH_INPUTS" ]; then NEED_GODOT=1; fi
if has_group g7-bench && [ "$HARNESS_ENV" = "desktop" ] && { [ -z "$RECEIVER" ] || [ "$RECEIVER" = "native" ]; }; then NEED_GODOT=1; fi

if [ "$NEED_GODOT" = "1" ]; then
	for f in "$EXTENSION" "$CALIBRATION"; do
		if [ ! -f "$f" ]; then
			echo "run-gate7: $f not found (build-capture.sh, or pass --extension/--calibration)" >&2
			exit 1
		fi
	done
	if [ ! -x "$BINARY" ]; then
		echo "run-gate7: binary not found or not executable: $BINARY" >&2
		exit 1
	fi
	EXTENSION="$(realpath "$EXTENSION")"
	CALIBRATION="$(realpath "$CALIBRATION")"
	BINARY="$(realpath "$BINARY")"
	printf '{"path": "%s", "sha256": "%s"}\n' "$BINARY" "$(sha256sum "$BINARY" | awk '{print $1}')" >"$OUT/binary.json"
	# shellcheck source=lib/gamescope.sh
	source "$SCRIPT_DIR/lib/gamescope.sh"
	set -euo pipefail
	HAVE_STRACE=0
	command -v strace >/dev/null 2>&1 && HAVE_STRACE=1
	CURRENT_CHILD_PID=""
	cleanup() {
		if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
			echo "run-gate7: stopping owned process $CURRENT_CHILD_PID" >&2
			kill "$CURRENT_CHILD_PID" 2>/dev/null || true
		fi
		if [ -n "${GS_RUN_DIR:-}" ]; then
			gs_teardown "$GS_RUN_DIR" || true
		fi
	}
	trap cleanup EXIT
	RECORDING_NAME=recording.rs2
	PATCH_RECORDING_NAME=recording-patch.rs2
	CAPTURE_WITH_PATCH=1
	LEGS_LOG="run-gate7"
	# shellcheck source=lib/legs.sh
	source "$SCRIPT_DIR/lib/legs.sh"
fi

godot_import() {
	local dir="$1" project="$2"
	LEG_ENV=()
	run_headless "$dir" none -- mise exec -- godot --headless --path "$project" --import
	if [ "$(cat "$dir/exit-code.txt")" != "0" ]; then
		echo "run-gate7: import of $project failed, see $dir/stdout.log" >&2
		exit 1
	fi
}

# capture_into <dir> <fixture> <quit frame | ""> [extra env...]: headless capture host, both sinks
# and the store, GRC_ROOT_SIZE=enforce-min-size (as every gate 6 capture).
capture_into() {
	local dir="$1" fixture="$2" quit="$3"
	shift 3
	CAPTURE_FIXTURE_DIR="$fixture"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "$quit" none
}

# --- g7-dev ----------------------------------------------------------------------------------
run_g7_dev_desktop() {
	local P="$OUT/g7-dev/pace"
	mkdir -p "$P/import"
	echo "run-gate7: g7-dev: pace import (fixture, receiver)"
	godot_import "$P/import/fixture" "$PACE_FIXTURE_DIR"
	godot_import "$P/import/receiver" "$RECEIVER_DIR"
	echo "run-gate7: g7-dev: pace capture (400 frames, full + patch sinks)"
	capture_into "$P/capture" "$PACE_FIXTURE_DIR" "$PACE_QUIT_FRAME"
	echo "run-gate7: g7-dev: bringing up private gamescope 640x360"
	gs_start 640 360 "$OUT/gamescope-g7-dev"
	echo "run-gate7: g7-dev: pace reference (rendered, 8 shots)"
	mkdir -p "$P/reference/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$P/reference/shots" RS_FIXTURE_STEP_LOG="$P/reference/steps.jsonl")
	run_rendered "$P/reference" "$PACE_FIXTURE_DIR"
	echo "run-gate7: g7-dev: pace receiver (full sink)"
	run_rendered_receiver "$P/capture" "$P/receiver"
	echo "run-gate7: g7-dev: pace receiver-patch (patch sink)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$P/capture" "$P/receiver-patch"
	gs_teardown "$OUT/gamescope-g7-dev"
	GS_RUN_DIR=""
}

run_g7_dev_device() {
	local D="$OUT/g7-dev/dev-session-$DEVICE"
	mkdir -p "$D"
	printf '{"schema": "render-stream-gate7-bench-inputs/1", "inputs": []}\n' >"$D/no-inputs.json"
	echo "run-gate7: g7-dev: device session check on $DEVICE (provenance, session settings, probes)"
	set +e
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-bench.ts" \
		--arm gsw --env device --device "$DEVICE" --inputs "$D/no-inputs.json" --out "$D" \
		--probes --hold-seconds "$HOLD_SECONDS")
	echo "$?" >"$D/exit-code.txt"
	set -e
}

# --- g7-bench --------------------------------------------------------------------------------
run_g7_bench() {
	local B="$OUT/g7-bench" inputs="$BENCH_INPUTS"
	mkdir -p "$B"
	if [ -z "$inputs" ]; then
		local I="$B/inputs"
		mkdir -p "$I/import"
		echo "run-gate7: g7-bench: importing the three fixtures and the receiver"
		godot_import "$I/import/scene" "$SCENE_FIXTURE_DIR"
		godot_import "$I/import/hd" "$HD_FIXTURE_DIR"
		godot_import "$I/import/pace" "$PACE_FIXTURE_DIR"
		godot_import "$I/import/receiver" "$RECEIVER_DIR"
		echo "run-gate7: g7-bench: capture scene (gate6-scene animate, 400 frames)"
		capture_into "$I/scene/capture" "$SCENE_FIXTURE_DIR" "$SCENE_QUIT_FRAME" RS_FIXTURE_VARIANT=animate
		echo "run-gate7: g7-bench: capture hd (gate6-hd native, its own 122-frame timeline)"
		capture_into "$I/hd/capture" "$HD_FIXTURE_DIR" ""
		echo "run-gate7: g7-bench: capture pace (400 frames)"
		capture_into "$I/pace/capture" "$PACE_FIXTURE_DIR" "$PACE_QUIT_FRAME"
		tool bench-inputs --root "$I" --out "$I/inputs.json"
		inputs="$I/inputs.json"
	fi
	local -a common=(--inputs "$inputs" --repeats "$REPEATS")
	bench() {
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/gate7-bench.ts" "$@") ||
			echo "run-gate7: gate7-bench $* exited $?" >&2
	}
	if [ "$HARNESS_ENV" = "desktop" ]; then
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "native" ]; then
			if [ -n "$BENCH_INPUTS" ]; then
				# The template cannot run a loose project before one editor --import (memory
				# receiver-needs-import-before-script).
				godot_import "$B/import-receiver" "$RECEIVER_DIR"
			fi
			echo "run-gate7: g7-bench: native arm (receiver.gd file mode, headless)"
			bench --arm native "${common[@]}" --out "$B" --binary "$BINARY" --receiver-dir "$RECEIVER_DIR"
		fi
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "gsw" ]; then
			echo "run-gate7: g7-bench: gsw arm (desktop headless Chromium, D9)"
			bench --arm gsw "${common[@]}" --out "$B"
		fi
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; then
			bench --arm web "${common[@]}" --out "$B"
		fi
	else
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "gsw" ]; then
			echo "run-gate7: g7-bench: gsw arm on $DEVICE (with the device probes)"
			bench --arm gsw --env device --device "$DEVICE" "${common[@]}" --out "$B" --probes --hold-seconds "$HOLD_SECONDS"
		fi
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; then
			bench --arm web --env device --device "$DEVICE" "${common[@]}" --out "$B"
		fi
	fi
}

if has_group g7-0; then
	if [ -z "$BUNDLE" ]; then
		BUNDLE="$(bash "$SCRIPT_DIR/build-web-receiver.sh" | tail -1)"
	fi
	BUNDLE="$(realpath "$BUNDLE")"
	echo "run-gate7: g7-0 web legs (bundle $BUNDLE)" >&2
	g7tool web-legs --group g7-0 --source "${SOURCES[gate0]}" --bundle "$BUNDLE" --out "$OUT"
	CHECK_ARGS+=(--source "gate0=${SOURCES[gate0]}" --bundle "$BUNDLE" --extension "$EXTENSION")
fi
if has_group g7-dev; then
	if [ "$HARNESS_ENV" = "desktop" ]; then run_g7_dev_desktop; else run_g7_dev_device; fi
fi
if has_group g7-bench; then
	run_g7_bench
fi

echo "run-gate7: running check-gate7.ts" >&2
(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
	"$SCRIPT_DIR/check-gate7.ts" "${CHECK_ARGS[@]}")
