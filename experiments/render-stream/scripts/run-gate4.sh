#!/usr/bin/env bash
# Gate 4 runner: drives fixtures/gate4/ through the legs of protocol/gate4-design.md "Q7. Runner,
# legs, checks, report" for the groups that have landed, then runs check-gate4.ts.
#
#   bash run-gate4.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g4a,g4b]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate4/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed: g4a (G4a: font
# provisioning and the Latin grayscale fixture's import, a 400-frame headless capture with both
# sinks and the store, its rendered reference and a same-build repeat with the glyph oracle on,
# and an extension-armed reference with the oracle off), g4b (G4b: the unchanged receiver on the
# main capture's full and patch sinks plus a headless openat trace, and three sabotage captures
# -- freeze-frame, perturb-transform and omit-op texture_2d_update -- each with its own rendered
# receiver). g4b needs g4a's capture and reference in the same run (pass --legs g4a,g4b). g4c (G4c:
# fixtures/gate4-layout -- sizes, pages, wrapping, alignment, clip_text, outline, shadow, subpixel,
# page lifetime -- through G4a's and G4b's legs under <out>/layout/, plus the LCD variant's
# capture, reference and receiver and sabotage-layout-omit-atlas; independent of g4a/g4b). g4d
# (G4d: fixtures/gate4-rich/, a RichTextLabel with colour, font_size, bold, italic, bgcolor and
# outlined spans plus an append_text step, under its own rich-*/ directories so it never collides
# with g4a/g4b; three rendered references, two rendered receivers, and an underline variant --
# rich-underline/{capture,reference,receiver} -- whose add_line is typed unsupported) is also
# independent of g4a/g4b and can run alone. g4f (G4f: fixtures/gate4-i18n -- multilingual shaping
# with Open Sans and the three pinned engine fallbacks: Greek, Cyrillic, NFD Vietnamese, Arabic,
# Persian, Hebrew with niqqud, mixed bidi, Devanagari and a hex box -- through G4a's and G4b's legs
# under <out>/i18n/, plus sabotage-i18n-omit-atlas) is independent of the others too. g4e (MSDF on
# render-stream/3) is known but has not landed.
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Every capture runs with GRC_ROOT_SIZE=enforce-min-size
# (gate4-design.md D12). Fonts are provisioned (scripts/lib/provision-fonts.sh, Q6a) before the
# import; a mismatching or missing font stops the run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate4"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed, in run order.
LANDED_GROUPS=(g4a g4b g4c g4d g4f)
KNOWN_GROUPS=(g4a g4b g4c g4d g4e g4f)

# The fixture's default timeline (fixtures/gate4/expected.json): S=1, N=10, so step k's applied
# frame is S+N*k and its "early" shot (one frame after an upload, Q6b "Intermediate shots") is
# S+N*k+1.
START_FRAME4=1
STEP_FRAMES4=10
step_frame4() { echo $((START_FRAME4 + STEP_FRAMES4 * $1)); }

# fixtures/gate4-rich/ (G4d): its own fixture (RichTextLabel spans), so its legs live under
# rich-*/ to avoid colliding with g4a/g4b's capture/, reference/, receiver/. Its timeline is
# S=1, N=10 too, but only 6 steps (0..5, no "early" shots).
RICH_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate4-rich"
step_frame4d() { echo $((START_FRAME4 + STEP_FRAMES4 * $1)); }

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The main capture runs 400 frames so the /proc maps/fd sample has time to run (as gates 0-3; the
# contract's leg table said 102, see gate4-design.md "As built"); the rendered legs run the
# fixture's default quit frame (S + N*9 + 11 = 102).
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
		# `pnpm render-stream:gate4 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate4: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate4: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate4: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate4: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
if [ ! -f "$FIXTURE_DIR/project.godot" ]; then
	echo "run-gate4: $FIXTURE_DIR/project.godot is missing" >&2
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
			echo "run-gate4: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate4: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi
case " ${GROUPS_RUN[*]} " in
*" g4b "*)
	case " ${GROUPS_RUN[*]} " in
	*" g4a "*) ;;
	*)
		echo "run-gate4: g4b needs g4a's capture and reference; pass --legs g4a,g4b" >&2
		exit 2
		;;
	esac
	;;
esac

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate4: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate4/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate4: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate4: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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
[ "$HAVE_STRACE" = "1" ] || echo "run-gate4: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate4: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# render-stream/2: every capture writes both sinks (recording.rs2 full, recording-patch.rs2 patch)
# and its payload store <capture>/store (the glyph atlas pages and the engine's hue strip).
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate4"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# A rendered fixture run (reference, reference-repeat, reference-armed): shots step-0..9 at the
# settle frames and early-1,4,7 one frame after the steps that upload, the step log and env.json.
# REFERENCE_ORACLE=1 turns the glyph oracle on (oracle/glyphs.jsonl, oracle/pages/);
# REFERENCE_ARMED=1 loads the capture extension armed with a full-sink stream and its store (the
# oracle is then off: the fixture refuses it next to any GRC_* variable).
# REFERENCE_FIXTURE_DIR picks another fixture project (g4c: fixtures/gate4-layout) and
# REFERENCE_VARIANT sets RS_FIXTURE_VARIANT; all four are reset after the call.
REFERENCE_ARMED=0
REFERENCE_ORACLE=0
REFERENCE_FIXTURE_DIR=""
REFERENCE_VARIANT=""
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" oracle="$REFERENCE_ORACLE"
	local project="${REFERENCE_FIXTURE_DIR:-$FIXTURE_DIR}" variant="$REFERENCE_VARIANT"
	REFERENCE_ARMED=0
	REFERENCE_ORACLE=0
	REFERENCE_FIXTURE_DIR=""
	REFERENCE_VARIANT=""
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" RS_FIXTURE_ENV_LOG="$dir/env.json")
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	if [ "$oracle" = "1" ]; then
		mkdir -p "$dir/oracle"
		LEG_ENV+=(RS_FIXTURE_GLYPH_LOG="$dir/oracle/glyphs.jsonl")
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

run_g4a() {
	# Fonts first (gate4-design.md Q6a): the lock's bytes, verified, into the ignored fonts/.
	echo "run-gate4: provisioning fonts"
	mkdir -p "$OUT/import"
	if ! bash "$SCRIPT_DIR/lib/provision-fonts.sh" "$FIXTURE_DIR" >"$OUT/import/fonts.log" 2>&1; then
		cat "$OUT/import/fonts.log" >&2
		echo "run-gate4: font provisioning failed, see $OUT/import/fonts.log" >&2
		exit 1
	fi

	# import: the release template cannot load a loose project until the editor generated .godot/.
	echo "run-gate4: import"
	LEG_ENV=()
	run_headless "$OUT/import/fixture" none -- mise exec -- godot --headless --path "$FIXTURE_DIR" --import
	if [ "$(cat "$OUT/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $FIXTURE_DIR failed, see $OUT/import/fixture/stdout.log" >&2
		exit 1
	fi

	# The capture host (headless, release template, extension armed, both sinks and the store,
	# strace + /proc maps/fd sample, env.json; the oracle never runs here).
	echo "run-gate4: capture"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_ENV_LOG="$OUT/capture/env.json")
	run_capture "$OUT/capture" "$CAPTURE_QUIT_FRAME" capture

	# Rendered legs: one private gamescope for all of them.
	echo "run-gate4: bringing up private gamescope for rendered legs"
	gs_start 640 360 "$OUT/gamescope"

	echo "run-gate4: reference (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$OUT/reference"
	echo "run-gate4: reference-repeat (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$OUT/reference-repeat"
	echo "run-gate4: reference-armed (extension armed, stream on, oracle off)"
	REFERENCE_ARMED=1
	run_reference "$OUT/reference-armed"

	gs_teardown "$OUT/gamescope"
	GS_RUN_DIR=""
}

# early_shots_csv <recording>: CSV of the seqs published at the gate 4 fixture's early frames
# (12, 42, 72 -- S+N*k+1 for k in {1,4,7}, gate4-design.md Q6b "Intermediate shots"; G4a's As-built
# note: receivers must also shoot these, or a page published one frame late would be missed).
early_shots_csv() {
	local rec="$1" out="" sep="" seq
	for k in 1 4 7; do
		seq="$(seq_at_frame "$rec" "$(($(step_frame4 "$k") + 1))" || true)"
		if [ -n "$seq" ]; then
			out="$out$sep$seq"
			sep=","
		fi
	done
	echo "$out"
}

# g4_capture <dir> [extra env words...]: a headless capture host on fixtures/gate4 at the
# fixture's own default quit frame (102, unlike g4a's 400-frame main capture), both sinks and its
# store, for a sabotage leg.
g4_capture() {
	local dir="$1"
	shift
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "" none
}

run_g4b() {
	# The unchanged receiver on the main capture: full sink, patch sink, and a headless trace
	# (openat, for receiver-never-loaded-fixture / receiver-never-shapes).
	echo "run-gate4: receiver-headless-trace"
	if prepare_recording "$OUT/capture/$RECORDING_NAME" "$OUT/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$OUT/capture/store"
		run_receiver_headless "$OUT/receiver-headless-trace" openat
	fi

	# Sabotage captures (headless, the fixture's default 102-frame run): freeze-frame at step 1's
	# applied frame (11), perturb-transform at step 2's (21), omit-op texture_2d_update at step
	# 4's (41) -- gate4-design.md "G4b" leg table; predictions are fixtures/gate4/expected.json
	# "predictions" (make_expected.py, never hand-edited).
	echo "run-gate4: sabotage-freeze (capture, freeze-frame @$(step_frame4 1))"
	g4_capture "$OUT/sabotage-freeze/capture" GRC_SABOTAGE=freeze-frame GRC_SABOTAGE_FRAME="$(step_frame4 1)"
	echo "run-gate4: sabotage-perturb (capture, perturb-transform @$(step_frame4 2))"
	g4_capture "$OUT/sabotage-perturb/capture" GRC_SABOTAGE=perturb-transform GRC_SABOTAGE_FRAME="$(step_frame4 2)"
	echo "run-gate4: sabotage-omit-atlas (capture, omit-op texture_2d_update @$(step_frame4 4))"
	g4_capture "$OUT/sabotage-omit-atlas/capture" GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update GRC_SABOTAGE_FRAME="$(step_frame4 4)"

	# Rendered receiver legs: one private gamescope for all of them (the main receiver, its patch
	# twin, and the three sabotage receivers).
	echo "run-gate4: bringing up private gamescope for g4b receiver legs"
	gs_start 640 360 "$OUT/gamescope-g4b"

	echo "run-gate4: receiver (full sink)"
	RECEIVER_EXTRA_SHOTS="$(early_shots_csv "$OUT/capture/$RECORDING_NAME")"
	run_rendered_receiver "$OUT/capture" "$OUT/receiver"

	echo "run-gate4: receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_EXTRA_SHOTS="$(early_shots_csv "$OUT/capture/$RECORDING_NAME")"
	run_rendered_receiver "$OUT/capture" "$OUT/receiver-patch"

	for kind in freeze perturb omit-atlas; do
		echo "run-gate4: sabotage-$kind (receiver)"
		run_rendered_receiver "$OUT/sabotage-$kind/capture" "$OUT/sabotage-$kind/receiver"
	done

	gs_teardown "$OUT/gamescope-g4b"
	GS_RUN_DIR=""
}

# --- g4c: fixtures/gate4-layout (gate4-design.md "G4c"), every leg under $OUT/layout/ ---

LAYOUT_DIR="$EXPERIMENT_DIR/fixtures/gate4-layout"
# The layout fixture's early shots (one frame after each step that uploads: its expected.json
# early_shot_steps) and its multi-page step (sabotage-layout-omit-atlas).
LAYOUT_EARLY_STEPS=(1 2 3 4 6 7 8)
LAYOUT_OMIT_STEP=7

# layout_early_csv <recording>: CSV of the seqs published at S+N*k+1 for the layout's early steps.
layout_early_csv() {
	local rec="$1" out="" sep="" seq k
	for k in "${LAYOUT_EARLY_STEPS[@]}"; do
		seq="$(seq_at_frame "$rec" "$(($(step_frame4 "$k") + 1))" || true)"
		if [ -n "$seq" ]; then
			out="$out$sep$seq"
			sep=","
		fi
	done
	echo "$out"
}

run_g4c() {
	local L="$OUT/layout"
	mkdir -p "$L/import"
	echo "run-gate4: g4c: provisioning fonts for fixtures/gate4-layout"
	if ! bash "$SCRIPT_DIR/lib/provision-fonts.sh" "$LAYOUT_DIR" >"$L/import/fonts.log" 2>&1; then
		cat "$L/import/fonts.log" >&2
		echo "run-gate4: font provisioning failed, see $L/import/fonts.log" >&2
		exit 1
	fi
	# import: the release template cannot load a loose project (or resolve the receiver's
	# class_name scripts) until the editor generated its .godot/; a fresh worktree has none.
	echo "run-gate4: g4c: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$L/import/fixture" none -- mise exec -- godot --headless --path "$LAYOUT_DIR" --import
	if [ "$(cat "$L/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $LAYOUT_DIR failed, see $L/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$L/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$L/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $RECEIVER_DIR failed, see $L/import/receiver/stdout.log" >&2
		exit 1
	fi

	# capture-layout: as g4a's capture (400 frames, both sinks, store, strace + maps, env.json).
	echo "run-gate4: capture-layout"
	CAPTURE_FIXTURE_DIR="$LAYOUT_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_ENV_LOG="$L/capture/env.json")
	run_capture "$L/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate4: sabotage-layout-omit-atlas (capture, omit-op texture_2d_update @$(step_frame4 "$LAYOUT_OMIT_STEP"))"
	CAPTURE_FIXTURE_DIR="$LAYOUT_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update
		GRC_SABOTAGE_FRAME="$(step_frame4 "$LAYOUT_OMIT_STEP")")
	run_capture "$L/sabotage-omit-atlas/capture" "" none

	echo "run-gate4: capture-lcd (RS_FIXTURE_VARIANT=lcd)"
	CAPTURE_FIXTURE_DIR="$LAYOUT_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_VARIANT=lcd)
	run_capture "$L/lcd/capture" "" none

	echo "run-gate4: g4c: receiver-headless-trace"
	if prepare_recording "$L/capture/$RECORDING_NAME" "$L/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$L/capture/store"
		run_receiver_headless "$L/receiver-headless-trace" openat
	fi

	echo "run-gate4: bringing up private gamescope for g4c rendered legs"
	gs_start 640 360 "$OUT/gamescope-g4c"

	echo "run-gate4: reference-layout (oracle on)"
	REFERENCE_FIXTURE_DIR="$LAYOUT_DIR"
	REFERENCE_ORACLE=1
	run_reference "$L/reference"
	echo "run-gate4: reference-layout-repeat (oracle on)"
	REFERENCE_FIXTURE_DIR="$LAYOUT_DIR"
	REFERENCE_ORACLE=1
	run_reference "$L/reference-repeat"
	echo "run-gate4: reference-layout-armed (extension armed, stream on, oracle off)"
	REFERENCE_FIXTURE_DIR="$LAYOUT_DIR"
	REFERENCE_ARMED=1
	run_reference "$L/reference-armed"
	echo "run-gate4: reference-lcd (RS_FIXTURE_VARIANT=lcd, oracle off)"
	REFERENCE_FIXTURE_DIR="$LAYOUT_DIR"
	REFERENCE_VARIANT=lcd
	run_reference "$L/lcd/reference"

	echo "run-gate4: receiver-layout (full sink)"
	RECEIVER_EXTRA_SHOTS="$(layout_early_csv "$L/capture/$RECORDING_NAME")"
	run_rendered_receiver "$L/capture" "$L/receiver"
	echo "run-gate4: receiver-layout-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_EXTRA_SHOTS="$(layout_early_csv "$L/capture/$RECORDING_NAME")"
	run_rendered_receiver "$L/capture" "$L/receiver-patch"
	echo "run-gate4: sabotage-layout-omit-atlas (receiver)"
	run_rendered_receiver "$L/sabotage-omit-atlas/capture" "$L/sabotage-omit-atlas/receiver"
	echo "run-gate4: receiver-lcd"
	run_rendered_receiver "$L/lcd/capture" "$L/lcd/receiver"

	gs_teardown "$OUT/gamescope-g4c"
	GS_RUN_DIR=""
}

# run_rich_reference <dir> [variant]: as run_reference, for fixtures/gate4-rich. `variant`
# (optional, e.g. "underline") sets RS_FIXTURE_VARIANT. REFERENCE_ARMED/REFERENCE_ORACLE as
# run_reference (both reset to 0 after the call).
run_rich_reference() {
	local dir="$1" variant="${2:-}" armed="$REFERENCE_ARMED" oracle="$REFERENCE_ORACLE"
	REFERENCE_ARMED=0
	REFERENCE_ORACLE=0
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" RS_FIXTURE_ENV_LOG="$dir/env.json")
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
	if [ "$oracle" = "1" ]; then
		mkdir -p "$dir/oracle"
		LEG_ENV+=(RS_FIXTURE_GLYPH_LOG="$dir/oracle/glyphs.jsonl")
	fi
	if [ "$armed" = "1" ]; then
		mkdir -p "$dir/evidence"
		LEG_ENV+=(
			GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
			GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
			GRC_RESOURCE_STORE_DIR="$dir/store"
		)
	fi
	run_rendered "$dir" "$RICH_FIXTURE_DIR"
}

# run_g4d: fixtures/gate4-rich/ (RichTextLabel spans). Its own fixture, provisioned and imported
# like g4a's, then a 400-frame capture (env.json, both sinks, store), three rendered references
# (oracle on, oracle on again, extension-armed with oracle off) and two rendered receivers (full
# and patch sinks) -- all under rich-*/ so they never collide with g4a/g4b's directories in the
# same --out. The underline variant (RS_FIXTURE_VARIANT=underline) gets its own fresh capture,
# rendered reference and rendered receiver under rich-underline/ (gate4-design.md "G4d": "capture-
# underline and receiver-underline -> unsupported, mismatch only in its region", which needs a
# rendered reference-underline too, to know where the real stroke pixels are -- not named in the
# contract's leg list, added here as built, mirroring G4c's three-leg LCD variant).
run_g4d() {
	echo "run-gate4: provisioning fonts (gate4-rich)"
	mkdir -p "$OUT/rich-import"
	if ! bash "$SCRIPT_DIR/lib/provision-fonts.sh" "$RICH_FIXTURE_DIR" >"$OUT/rich-import/fonts.log" 2>&1; then
		cat "$OUT/rich-import/fonts.log" >&2
		echo "run-gate4: font provisioning failed (gate4-rich), see $OUT/rich-import/fonts.log" >&2
		exit 1
	fi

	echo "run-gate4: import (gate4-rich)"
	LEG_ENV=()
	run_headless "$OUT/rich-import/fixture" none -- mise exec -- godot --headless --path "$RICH_FIXTURE_DIR" --import
	if [ "$(cat "$OUT/rich-import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $RICH_FIXTURE_DIR failed, see $OUT/rich-import/fixture/stdout.log" >&2
		exit 1
	fi

	echo "run-gate4: rich-capture"
	CAPTURE_FIXTURE_DIR="$RICH_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_ENV_LOG="$OUT/rich-capture/env.json")
	run_capture "$OUT/rich-capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate4: rich-underline capture (headless, fixture's own default quit)"
	CAPTURE_FIXTURE_DIR="$RICH_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_VARIANT=underline)
	run_capture "$OUT/rich-underline/capture" "" none

	echo "run-gate4: bringing up private gamescope for g4d rendered legs"
	gs_start 640 360 "$OUT/gamescope-g4d"

	echo "run-gate4: rich-reference (oracle on)"
	REFERENCE_ORACLE=1
	run_rich_reference "$OUT/rich-reference"
	echo "run-gate4: rich-reference-repeat (oracle on)"
	REFERENCE_ORACLE=1
	run_rich_reference "$OUT/rich-reference-repeat"
	echo "run-gate4: rich-reference-armed (extension armed, stream on, oracle off)"
	REFERENCE_ARMED=1
	run_rich_reference "$OUT/rich-reference-armed"
	echo "run-gate4: rich-underline reference (no oracle)"
	run_rich_reference "$OUT/rich-underline/reference" underline

	echo "run-gate4: rich-receiver (full sink)"
	run_rendered_receiver "$OUT/rich-capture" "$OUT/rich-receiver"
	echo "run-gate4: rich-receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/rich-capture" "$OUT/rich-receiver-patch"
	echo "run-gate4: rich-underline receiver"
	run_rendered_receiver "$OUT/rich-underline/capture" "$OUT/rich-underline/receiver"

	gs_teardown "$OUT/gamescope-g4d"
	GS_RUN_DIR=""
}

# --- g4f: fixtures/gate4-i18n (gate4-design.md "G4f"), every leg under $OUT/i18n/ ---

I18N_DIR="$EXPERIMENT_DIR/fixtures/gate4-i18n"
# The i18n fixture's early shots (one frame after each step that uploads: its expected.json
# early_shot_steps) and the step that first shows Devanagari (sabotage-i18n-omit-atlas).
I18N_EARLY_STEPS=(1 2 3 4 5)
I18N_OMIT_STEP=5

# i18n_early_csv <recording>: CSV of the seqs published at S+N*k+1 for the i18n early steps.
i18n_early_csv() {
	local rec="$1" out="" sep="" seq k
	for k in "${I18N_EARLY_STEPS[@]}"; do
		seq="$(seq_at_frame "$rec" "$(($(step_frame4 "$k") + 1))" || true)"
		if [ -n "$seq" ]; then
			out="$out$sep$seq"
			sep=","
		fi
	done
	echo "$out"
}

run_g4f() {
	local I="$OUT/i18n"
	mkdir -p "$I/import"
	echo "run-gate4: g4f: provisioning fonts for fixtures/gate4-i18n (Open Sans and the three engine fallbacks)"
	if ! bash "$SCRIPT_DIR/lib/provision-fonts.sh" "$I18N_DIR" >"$I/import/fonts.log" 2>&1; then
		cat "$I/import/fonts.log" >&2
		echo "run-gate4: font provisioning failed, see $I/import/fonts.log" >&2
		exit 1
	fi
	# import: the release template cannot load a loose project (or resolve the receiver's
	# class_name scripts) until the editor generated its .godot/; a fresh worktree has none.
	echo "run-gate4: g4f: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$I/import/fixture" none -- mise exec -- godot --headless --path "$I18N_DIR" --import
	if [ "$(cat "$I/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $I18N_DIR failed, see $I/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$I/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$I/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate4: import of $RECEIVER_DIR failed, see $I/import/receiver/stdout.log" >&2
		exit 1
	fi

	# capture-i18n: as g4a's capture (400 frames, both sinks, store, strace + maps, env.json).
	echo "run-gate4: capture-i18n"
	CAPTURE_FIXTURE_DIR="$I18N_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size RS_FIXTURE_ENV_LOG="$I/capture/env.json")
	run_capture "$I/capture" "$CAPTURE_QUIT_FRAME" capture

	echo "run-gate4: sabotage-i18n-omit-atlas (capture, omit-op texture_2d_update @$(step_frame4 "$I18N_OMIT_STEP"))"
	CAPTURE_FIXTURE_DIR="$I18N_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size GRC_SABOTAGE=omit-op GRC_SABOTAGE_OP=texture_2d_update
		GRC_SABOTAGE_FRAME="$(step_frame4 "$I18N_OMIT_STEP")")
	run_capture "$I/sabotage-omit-atlas/capture" "" none

	echo "run-gate4: g4f: receiver-headless-trace"
	if prepare_recording "$I/capture/$RECORDING_NAME" "$I/receiver-headless-trace"; then
		RECEIVER_STORE_DIR="$I/capture/store"
		run_receiver_headless "$I/receiver-headless-trace" openat
	fi

	echo "run-gate4: bringing up private gamescope for g4f rendered legs"
	gs_start 640 360 "$OUT/gamescope-g4f"

	echo "run-gate4: reference-i18n (oracle on)"
	REFERENCE_FIXTURE_DIR="$I18N_DIR"
	REFERENCE_ORACLE=1
	run_reference "$I/reference"
	echo "run-gate4: reference-i18n-repeat (oracle on)"
	REFERENCE_FIXTURE_DIR="$I18N_DIR"
	REFERENCE_ORACLE=1
	run_reference "$I/reference-repeat"
	echo "run-gate4: reference-i18n-armed (extension armed, stream on, oracle off)"
	REFERENCE_FIXTURE_DIR="$I18N_DIR"
	REFERENCE_ARMED=1
	run_reference "$I/reference-armed"

	echo "run-gate4: receiver-i18n (full sink)"
	RECEIVER_EXTRA_SHOTS="$(i18n_early_csv "$I/capture/$RECORDING_NAME")"
	run_rendered_receiver "$I/capture" "$I/receiver"
	echo "run-gate4: receiver-i18n-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_EXTRA_SHOTS="$(i18n_early_csv "$I/capture/$RECORDING_NAME")"
	run_rendered_receiver "$I/capture" "$I/receiver-patch"
	echo "run-gate4: sabotage-i18n-omit-atlas (receiver)"
	run_rendered_receiver "$I/sabotage-omit-atlas/capture" "$I/sabotage-omit-atlas/receiver"

	gs_teardown "$OUT/gamescope-g4f"
	GS_RUN_DIR=""
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g4a) run_g4a ;;
	g4b) run_g4b ;;
	g4c) run_g4c ;;
	g4d) run_g4d ;;
	g4f) run_g4f ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate4: running checker"
cd "$REPO_ROOT"
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate4.ts" --out "$OUT"
