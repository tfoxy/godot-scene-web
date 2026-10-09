#!/usr/bin/env bash
# Gate -1 runner: drives the spike fixture (fixtures/spike/) through every headless and rendered
# leg the capture library's contract defines, and runs the TypeScript checker
# (check-gate-minus1.ts) against the evidence it produces. See scripts/README.md for the evidence
# layout this writes and ../fixtures/spike/README.md for the fixture itself.
#
# REQUIRES the sibling capture library's build output (a .gdextension) and a genuine calibration
# record for the exact release template binary -- neither exists in this repo; they are produced
# by experiments/render-stream/capture/ and .../calibration/ (owned by a different agent, built in
# parallel). This script refuses to run without them rather than silently skipping legs: see
# `--extension`/`--calibration` below.
#
#   bash run-gate-minus1.sh --extension /abs/path/capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR]
#
# NEVER Xvfb, never a window on the user's desktop: the two `rendered-*` legs run inside a private
# `gamescope --backend headless` instance (scripts/lib/gamescope.sh), display env fully stripped.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/spike"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""

usage() {
	sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
	case "$1" in
	--extension)
		EXTENSION="$2"
		shift 2
		;;
	--calibration)
		CALIBRATION="$2"
		shift 2
		;;
	--binary)
		BINARY="$2"
		shift 2
		;;
	--out)
		OUT="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		# `pnpm render-stream:gate-minus1 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate-minus1: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate-minus1: extension not found -- pass --extension /abs/path/to/capture.gdextension" >&2
	echo "  (the sibling capture library is built separately under experiments/render-stream/capture/" >&2
	echo "  and is not available in this checkout; this is expected before integration)" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate-minus1: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
if [ ! -x "$BINARY" ]; then
	echo "run-gate-minus1: binary not found or not executable: $BINARY" >&2
	exit 1
fi

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate-minus1: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate-minus1/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$OUT"
echo "run-gate-minus1: evidence directory: $OUT"

# Whatever ends this script -- success, a failed step under `set -e`, or gs_die because the
# private compositor vanished -- stops the Godot process it owns and tears its own compositor
# down. Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
CURRENT_CHILD_PID=""
cleanup() {
	if [ -n "$CURRENT_CHILD_PID" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate-minus1: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------
# Import pass: see fixtures/spike/README.md -- the release template cannot load a loose project
# directory until the editor has generated .godot/ (global script cache + import metadata) at
# least once. Idempotent and re-run on every invocation since the fixture may have changed.
# ---------------------------------------------------------------------------------------------
mise exec -- godot --headless --path "$FIXTURE_DIR" --import >"$OUT/import.log" 2>&1 || {
	echo "run-gate-minus1: import pass failed, see $OUT/import.log" >&2
	exit 1
}

# ---------------------------------------------------------------------------------------------
# A tampered binary copy for refuse-binary-byte: one bit flipped inside .comment, a PROGBITS
# section with no SHF_ALLOC flag (confirmed via readelf -S on the pinned template: not mapped at
# runtime), so the flip changes the file's sha256 without changing what the process does. Built
# once, reused by the refuse-binary-byte leg below.
# ---------------------------------------------------------------------------------------------
make_tampered_binary() {
	local out_path="$1"
	local section_line size_line offset_hex size_hex
	section_line="$(readelf -S "$BINARY" | grep -A1 '\.comment' | head -1)"
	size_line="$(readelf -S "$BINARY" | grep -A1 '\.comment' | tail -1)"
	offset_hex="$(echo "$section_line" | awk '{print $NF}')"
	size_hex="$(echo "$size_line" | awk '{print $1}')"
	if [ -z "$offset_hex" ] || [ -z "$size_hex" ]; then
		echo "run-gate-minus1: could not locate .comment section in $BINARY via readelf -S" >&2
		return 1
	fi
	cp "$BINARY" "$out_path"
	chmod u+w "$out_path"
	python3 - "$out_path" "$offset_hex" "$size_hex" <<'PY'
import sys
path, offset_hex, size_hex = sys.argv[1], sys.argv[2], sys.argv[3]
offset = int(offset_hex, 16)
size = int(size_hex, 16)
if size < 1:
	raise SystemExit(".comment section is empty")
flip_at = offset + (size // 2)
with open(path, "r+b") as f:
	f.seek(flip_at)
	byte = f.read(1)
	f.seek(flip_at)
	f.write(bytes([byte[0] ^ 0xFF]))
print(f"flipped byte at file offset 0x{flip_at:x} (within .comment [0x{offset:x}, 0x{offset + size:x}))")
PY
}

# ---------------------------------------------------------------------------------------------
# Headless legs: capture library evidence under $leg_dir/evidence (GRC_EVIDENCE_DIR), process
# evidence (argv/env/exit code, optionally strace + a /proc maps/fd sample) beside it.
# ---------------------------------------------------------------------------------------------
run_headless_leg() {
	local leg_name="$1" grc_mode="$2" calibration_path="$3" binary_path="$4" disarm_frames="${5:-}"
	local leg_dir="$OUT/$leg_name"
	local evidence_dir="$leg_dir/evidence"
	mkdir -p "$evidence_dir"

	# Inherited GRC_* values are stripped so, e.g., an exported GRC_CALIBRATION cannot leak into
	# refuse-nocal.
	local -a cmd=(env -u DISPLAY -u WAYLAND_DISPLAY -u GRC_CALIBRATION -u GRC_DISARM_AFTER_FRAMES -u GRC_SCREENSHOT -u GRC_SCREENSHOT_FRAME GRC_EXTENSION="$EXTENSION" GRC_MODE="$grc_mode" GRC_EVIDENCE_DIR="$evidence_dir")
	[ -n "$calibration_path" ] && cmd+=(GRC_CALIBRATION="$calibration_path")
	[ -n "$disarm_frames" ] && cmd+=(GRC_DISARM_AFTER_FRAMES="$disarm_frames")

	{
		echo "binary: $binary_path"
		echo "argv: --headless --path $FIXTURE_DIR"
		echo "GRC_EXTENSION=$EXTENSION"
		echo "GRC_MODE=$grc_mode"
		echo "GRC_EVIDENCE_DIR=$evidence_dir"
		echo "GRC_CALIBRATION=${calibration_path:-<unset>}"
		echo "GRC_DISARM_AFTER_FRAMES=${disarm_frames:-<unset>}"
	} >"$leg_dir/invocation.txt"

	local want_strace=0
	if [ "$leg_name" = "headless-armed" ]; then
		if command -v strace >/dev/null 2>&1; then
			want_strace=1
		else
			echo "unavailable" >"$leg_dir/strace-status.txt"
			echo "run-gate-minus1: strace not installed -- headless-armed leg's strace criterion will report unavailable, not pass/fail" >&2
		fi
	fi

	local exit_code pid sample_pid
	if [ "$want_strace" = "1" ]; then
		"${cmd[@]}" strace -f -tt -e trace=mprotect,openat -o "$leg_dir/strace.txt" \
			"$binary_path" --headless --path "$FIXTURE_DIR" \
			>"$leg_dir/stdout.txt" 2>"$leg_dir/stderr.txt" &
		pid=$!
	else
		"${cmd[@]}" "$binary_path" --headless --path "$FIXTURE_DIR" \
			>"$leg_dir/stdout.txt" 2>"$leg_dir/stderr.txt" &
		pid=$!
	fi
	CURRENT_CHILD_PID="$pid"

	# Sample /proc maps and fds once the capture library has decided (result.json exists): after
	# the engine brought its servers up and, on the armed leg, after the vptr store -- not at a
	# fixed delay that could land before the extension even loaded.
	local waited=0
	while [ "$waited" -lt 300 ] && [ ! -f "$evidence_dir/result.json" ] && kill -0 "$pid" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if [ "$want_strace" = "1" ]; then
		# strace -f's own pid is $pid; the traced godot process is its child.
		sample_pid="$(pgrep -P "$pid" 2>/dev/null | head -1 || true)"
	else
		sample_pid="$pid"
	fi

	if [ -n "$sample_pid" ] && [ -d "/proc/$sample_pid" ]; then
		cp "/proc/$sample_pid/maps" "$leg_dir/maps.txt" 2>/dev/null || true
		ls -la "/proc/$sample_pid/fd" >"$leg_dir/fd.txt" 2>/dev/null || true
	fi

	set +e
	wait "$pid"
	exit_code=$?
	set -e
	CURRENT_CHILD_PID=""
	echo "$exit_code" >"$leg_dir/exit-code.txt"
	echo "run-gate-minus1: $leg_name exit=$exit_code"
}

echo "run-gate-minus1: headless-armed"
run_headless_leg "headless-armed" "arm" "$CALIBRATION" "$BINARY" "60"

echo "run-gate-minus1: headless-validate"
run_headless_leg "headless-validate" "validate" "$CALIBRATION" "$BINARY" ""

echo "run-gate-minus1: refuse-sha"
mkdir -p "$OUT/refuse-sha"
mise exec -- node "$SCRIPT_DIR/lib/tamper-calibration.mjs" sha "$CALIBRATION" "$OUT/refuse-sha/tampered-calibration.json"
run_headless_leg "refuse-sha" "arm" "$OUT/refuse-sha/tampered-calibration.json" "$BINARY" "60"

echo "run-gate-minus1: refuse-prefix"
mkdir -p "$OUT/refuse-prefix"
mise exec -- node "$SCRIPT_DIR/lib/tamper-calibration.mjs" prefix "$CALIBRATION" "$OUT/refuse-prefix/tampered-calibration.json"
run_headless_leg "refuse-prefix" "arm" "$OUT/refuse-prefix/tampered-calibration.json" "$BINARY" "60"

echo "run-gate-minus1: refuse-nocal"
run_headless_leg "refuse-nocal" "arm" "" "$BINARY" "60"

echo "run-gate-minus1: refuse-binary-byte"
mkdir -p "$OUT/refuse-binary-byte"
TAMPERED_BINARY="$OUT/refuse-binary-byte/linux_release.x86_64"
make_tampered_binary "$TAMPERED_BINARY"
chmod +x "$TAMPERED_BINARY"
run_headless_leg "refuse-binary-byte" "arm" "$CALIBRATION" "$TAMPERED_BINARY" "60"

# A record as calibrator version 1 wrote it (gate -1 slots only): must still arm, with every later
# hook left out and reported. This is the record shape a sibling may produce for another binary
# with an older calibrator.
echo "run-gate-minus1: old-record"
mkdir -p "$OUT/old-record"
mise exec -- node "$SCRIPT_DIR/lib/tamper-calibration.mjs" v1 "$CALIBRATION" "$OUT/old-record/calibrator-v1-record.json"
run_headless_leg "old-record" "arm" "$OUT/old-record/calibrator-v1-record.json" "$BINARY" "60"

# ---------------------------------------------------------------------------------------------
# Rendered legs: one private gamescope compositor for both, identity reverified before each
# launch. "unarmed" runs with the capture extension absent; "armed" arms and disarms only at
# shutdown, so its screenshot is drawn through the shadow vtable. The two PNGs must be
# byte-identical -- interposition must be invisible.
# ---------------------------------------------------------------------------------------------
run_rendered_leg() {
	local leg_name="$1" grc_mode="$2" screenshot_name="$3"
	local leg_dir="$OUT/$leg_name"
	local evidence_dir="$leg_dir/evidence"
	mkdir -p "$evidence_dir"

	gs_require_live

	# "absent": the capture extension is not loaded at all (no GRC_* capture variables), the
	# baseline the handoff's transparency check names: "with capture armed and with capture absent".
	local -a grc_env=(GRC_SCREENSHOT="$leg_dir/$screenshot_name" GRC_SCREENSHOT_FRAME="60")
	if [ "$grc_mode" != "absent" ]; then
		grc_env+=(GRC_EXTENSION="$EXTENSION" GRC_MODE="$grc_mode" GRC_EVIDENCE_DIR="$evidence_dir" GRC_CALIBRATION="$CALIBRATION")
	fi
	{
		echo "binary: $BINARY"
		echo "argv: --path $FIXTURE_DIR --rendering-driver opengl3 --display-driver x11"
		echo "DISPLAY=$GS_DISPLAY"
		echo "capture: $grc_mode"
		printf '%s\n' "${grc_env[@]}"
	} >"$leg_dir/invocation.txt"

	GS_GODOT_ENV=("${grc_env[@]}")
	gs_launch_godot "$GS_DISPLAY" "$BINARY" "$FIXTURE_DIR" "$leg_dir/godot.log"
	local godot_pid="$GS_LAST_GODOT_PID"
	CURRENT_CHILD_PID="$godot_pid"

	sleep 0.5
	gs_verify_display_ownership "$GS_DISPLAY" "$GS_PID" "$GS_SID" "$godot_pid" "$leg_dir/display-ownership.json" || {
		echo "run-gate-minus1: WARNING: $leg_name display ownership check failed, see $leg_dir/display-ownership.json" >&2
	}

	local waited=0
	while [ "$waited" -lt 600 ]; do
		[ -d "/proc/$godot_pid" ] || break
		gs_require_live
		sleep 0.1
		waited=$((waited + 1))
	done

	set +e
	wait "$godot_pid" 2>/dev/null
	local exit_code=$?
	set -e
	CURRENT_CHILD_PID=""
	echo "$exit_code" >"$leg_dir/exit-code.txt"
	echo "run-gate-minus1: $leg_name exit=$exit_code"
}

echo "run-gate-minus1: bringing up private gamescope for rendered legs"
gs_start 640 360 "$OUT/gamescope"

echo "run-gate-minus1: rendered-unarmed"
run_rendered_leg "rendered-unarmed" "absent" "unarmed.png"

echo "run-gate-minus1: rendered-armed"
run_rendered_leg "rendered-armed" "arm" "armed.png"

gs_teardown "$OUT/gamescope"
GS_RUN_DIR=""

# ---------------------------------------------------------------------------------------------
# Checker
# ---------------------------------------------------------------------------------------------
echo "run-gate-minus1: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate-minus1.ts" --out "$OUT"
