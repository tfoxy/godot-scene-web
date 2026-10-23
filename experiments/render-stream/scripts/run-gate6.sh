#!/usr/bin/env bash
# Gate 6 runner: drives fixtures/gate6-scene through the legs of protocol/gate6-design.md
# "Q7. Runner, legs, checks, report" for the groups that have landed, then runs check-gate6.ts.
#
#   bash run-gate6.sh --extension /abs/path/render_stream_capture.gdextension \
#     --calibration /abs/path/record.json [--binary /abs/path/linux_release.x86_64] [--out DIR] \
#     [--legs g6a,g6h,g6l,g6b,g6c,g6z]
#
# --extension and --calibration are required; without them the runner refuses before doing
# anything. --binary defaults to the pinned 4.5.1 release template. --out defaults to
# artifacts/render-stream/gate6/<UTC>/ and must not already hold files. --legs selects leg groups
# (comma-separated); the default is every group whose increment has landed. Every capture and
# receiver speaks render-stream/6 since G6b. g6a (G6a): the fixture's and the receiver's import; under <out>/scene/ a 400-frame
# headless capture with both sinks and the store (capture-scene), an all-inline capture
# (capture-scene-inline), its rendered reference and a same-build repeat with the scene oracle on
# (reference-scene, -repeat), an extension-armed reference with the oracle off (-armed), and
# rendered receivers on the full sink, the patch sink with state dumps at the settle seqs and the
# inline capture (receiver-scene, -patch, -inline); under <out>/animate/ and <out>/refused/ the
# variant's capture, reference (oracle on) and receiver; and under <out>/scene/ the host sabotages
# freeze-frame @11, omit-op canvas_item_set_transform @21, perturb-vertex @21 and perturb-shader
# @21 (each a capture plus a rendered receiver) and the receiver sabotages ignore-clip and
# stale-texture on capture-scene. Every rendered leg shoots the settle frames and the
# intermediate frames 13, 53 and 93 (Q6c); receivers shoot the seqs published at those frames.
# g6h (G6h, lib/gate6h-legs.sh): fixtures/gate6-hd (1920x1080, canvas_items) under <out>/hd/: its
# native capture, references at 1920x1080 (repeat, armed) and 960x540 (repeat), and 1920x1080
# receivers on both sinks.
# g6l (G6l): under <out>/live/ the `animate` variant on the live timeline
# (S=300, N=60, quit 1080, `steps` time): live hosts with rendered live receivers shooting 12
# settle and 40 motion windows -- live-scene (fresh cache), live-scene-warm (on live-scene's
# cache), live-stall (RS_RECEIVER_STALL=2:2000), live-reconnect (RS_RECEIVER_RECONNECT=5, memory
# kept) and sabotage-live-stale-coalesce (the stall, stale-coalesce @420) -- then
# reference-live-frames (the reference shooting every host frame a receiver shot, and every
# stale_from frame) and reference-file (the animate reference on the file timeline).
# G7u (gate 7's g7-lc, protocol/gate7/g7u-as-built.md): with G7U_LEGS=<csv> (browser
# receivers only, GATE7_LIVE_KIND) g6l runs ONLY those lifecycle legs under <out>/live/<leg>/,
# then reference-live-frames with the run's largest quit frame; the g6l legs and reference-file
# are skipped. Desktop legs (simulated suspension): sim-hidden-2s, sim-hidden-30s,
# sim-frozen-30s; device legs (GATE7_LIFECYCLE_ENV=device): hidden-2s, hidden-30s, frozen-30s;
# either: reload, close, context-loss, sabotage-ack-while-hidden; desktop only:
# sabotage-css-opacity (g6l_lc_words).
# g6b (G6b, lib/gate6b-legs.sh; needs g6a and g6h in the same run): the
# HD fixture captured at presentation:960x540 (both sinks, and inline) with 960x540 receivers on
# each, the presentation hazard (an enforce-min-size capture presented at 960x540), a snap-to-pixel
# capture of a scratch copy of gate6-scene, and the receiver sabotages ignore-presentation (HD
# half) and ignore-canvas-stacking (scene).
# g6s (G6s, on render-stream/6 since G6b): under <out>/g6s/ the `animate` variant on the `soak`
# timeline (realtime, step 11 at game time 365 s, quit 370 s) with GRC_HOOK_LOG=off: four 370-s
# legs -- soak-scene (fresh cache, the full 1 MiB/4 MiB memory/disk budgets), soak-inline (every
# payload inline, no cache dir or store so eviction never runs -- a carried hash is never resent,
# memory g6s-carried-set-resource-duplicate -- the host's carried-hash set checked for growing
# only as fast as genuinely novel content explains), sabotage-soak-no-evict
# (RS_RECEIVER_SABOTAGE=no-evict) and sabotage-soak-retain-superseded
# (GRC_SABOTAGE=retain-superseded) -- each with a runner-side `/proc` sampler on the host pid
# (scripts/sample-proc.ts) and the receiver's own RS_RECEIVER_PERF_OUT timeline; then
# reference-step11 (a rendered `animate` reference on the soak timeline itself: realtime pacing
# makes the step-11 freeze land at a frame the file timeline cannot reproduce, gate6-design.md
# "As built (G6s)").
# G7k (gate7's g7-k, protocol/gate7/g7k.md): with G6S_LEGS=<csv> (a browser receiver only,
# GATE7_LIVE_KIND) run_g6s runs only the named legs under <out>/g6s/, plus reference-step11
# always. A fifth, GSW-only leg joins the vocabulary: sabotage-leak-gl-textures
# (RS_RECEIVER_SABOTAGE=leak-gl-textures). The default (G6S_LEGS unset) is every native leg,
# unchanged.
# g6c (G6c, lib/gate6c-legs.sh): under <out>/rates/ the publication-rate legs on the `rate`
# timeline (realtime, 30 s of game time, GRC_HOOK_LOG=off, no file sink, no tap): rate-baseline
# (armed, no subscriber), rate-15/-30/-60 (GRC_PUBLISH_FPS), rate-uncapped-host60, rate-uncapped
# (--max-fps 0 both ends), mismatch-60-recv30, mismatch-15-recv60, dual-60-15
# (GRC_LIVE_MAX_CONNECTIONS=2), recv-delay (--frame-delay 40), constrained and
# sabotage-constrained-ignore-credit (throttle-proxy.ts `constrained` between receiver and host),
# then each leg's final-state reference; then, in a 1920x1080 gamescope, the gpu-heavy calibration
# and the gpu-heavy leg on gate6-hd. Hosts and receivers carry a /proc sampler (sample-proc.ts).
# g6p (G6p, lib/gate6p-legs.sh; NOT in the default --legs, select it explicitly): Q7g's
# measurement matrix under <out>/matrix/ -- 20 scenarios, one discarded warmup plus 5 measured
# repeats each (about an hour): gate6-scene's unarmed/armed-idle arms, streaming at 15/30/60/
# uncapped-host60/uncapped, a cold-cache repeat of 60 and a hook-log-on repeat of 60 (D15's input);
# the same on gate6-hd native; gate6-hd half streaming at 60 (warm); gate6-scene constrained-60 and
# dual-60-15. `unarmed` loads no capture extension at all (sample-rate.ts's wall-clock step-log
# slope is its only host-rate signal); every other arm reuses gate6c-legs.sh's host/receiver/proxy/
# reference helpers on the same `rate` timeline g6c measures.
# g6z (G6z, scripts/make-features.ts + lib/gate6z-checks.ts; runs last, no capture of its own):
# Q8's four manifest checks against protocol/features/render-stream-6.json, reusing whichever of
# g6a's scene/{capture,capture-inline,animate/capture}, g6h's hd/capture-native, g6a's
# refused/capture and g6b's snap/capture recordings this run's groups produced.
#
# NEVER Xvfb and never a desktop window: rendered legs share ONE private
# `gamescope --backend headless` per group (scripts/lib/gamescope.sh). Headless legs strip DISPLAY
# and WAYLAND_DISPLAY. Every launch strips every inherited GRC_* and RS_* variable and passes only
# what its leg wants (env.txt records it). Every capture runs with GRC_ROOT_SIZE=enforce-min-size
# (gate6-design.md D4: stretch `disabled`; for gate6-hd the logical 1920x1080 window) except g6b's
# half captures, GRC_ROOT_SIZE=presentation:960x540 (D2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
SCENE_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate6-scene"
HD_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate6-hd"
FIXTURE_DIR="$SCENE_FIXTURE_DIR"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"

# shellcheck source=lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"
set -euo pipefail

EXPECTED_BINARY_SHA256="54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c"

# Groups whose increment has landed (selectable via --legs), in run order. g6z runs last: it has
# no capture of its own, only checks against whichever earlier groups ran in this invocation.
LANDED_GROUPS=(g6a g6h g6l g6b g6s g6c g6p g6z)
# The default run-set when --legs is omitted: every landed group except g6p, whose Q7g
# measurement matrix (warmup + 5 repeats x 20 scenarios) takes about an hour, so a plain
# `pnpm render-stream:gate6` stays fast; select it explicitly with --legs ...,g6p. g6z is cheap
# (no capture) and stays in the default set so a plain run always re-validates the manifest.
DEFAULT_GROUPS=(g6a g6h g6l g6b g6s g6c g6z)
KNOWN_GROUPS=(g6a g6h g6b g6l g6s g6c g6p g6z)

EXTENSION=""
CALIBRATION=""
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
OUT=""
LEGS_ARG=""

# The capture runs 400 frames so the /proc maps/fd sample has time to run (gate4-design.md G4a
# amendment); rendered legs and sabotage captures run the fixture's default file timeline (S=1,
# N=10, step k at 1 + 10k, settle +7, quit S + 11N + 11 = 122).
CAPTURE_QUIT_FRAME=400
HEADLESS_TIMEOUT_S=180
RENDERED_TIMEOUT_S=180
# Q6c: the file timeline's intermediate shot frames S + N k + 2, k in {1, 5, 9}.
MID_FRAMES=(13 53 93)

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
		# `pnpm render-stream:gate6 -- <flags>` forwards the separator itself.
		shift
		;;
	*)
		echo "run-gate6: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [ -z "$EXTENSION" ] || [ ! -f "$EXTENSION" ]; then
	echo "run-gate6: extension not found -- pass --extension /abs/path/to/render_stream_capture.gdextension" >&2
	exit 1
fi
if [ -z "$CALIBRATION" ] || [ ! -f "$CALIBRATION" ]; then
	echo "run-gate6: calibration not found -- pass --calibration /abs/path/to/record.json" >&2
	exit 1
fi
EXTENSION="$(realpath "$EXTENSION")"
CALIBRATION="$(realpath "$CALIBRATION")"
if [ ! -x "$BINARY" ]; then
	echo "run-gate6: binary not found or not executable: $BINARY" >&2
	exit 1
fi
BINARY="$(realpath "$BINARY")"
if [ ! -f "$SCENE_FIXTURE_DIR/project.godot" ]; then
	echo "run-gate6: $SCENE_FIXTURE_DIR/project.godot is missing" >&2
	exit 1
fi

GROUPS_RUN=()
if [ -z "$LEGS_ARG" ]; then
	GROUPS_RUN=("${DEFAULT_GROUPS[@]}")
else
	IFS=',' read -r -a requested <<<"$LEGS_ARG"
	for group in "${requested[@]}"; do
		case " ${KNOWN_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate6: unknown leg group: $group (known: ${KNOWN_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		case " ${LANDED_GROUPS[*]} " in
		*" $group "*) ;;
		*)
			echo "run-gate6: leg group $group has not landed yet (landed: ${LANDED_GROUPS[*]})" >&2
			exit 2
			;;
		esac
		GROUPS_RUN+=("$group")
	done
fi

# g6b replays g6a's scene capture and compares with g6h's half reference.
case " ${GROUPS_RUN[*]} " in
*" g6b "*)
	for needed in g6a g6h; do
		case " ${GROUPS_RUN[*]} " in
		*" $needed "*) ;;
		*)
			echo "run-gate6: leg group g6b needs g6a and g6h in the same run (--legs g6a,g6h,g6b)" >&2
			exit 2
			;;
		esac
	done
	;;
esac

# g6z's checks read g6a's scene/{capture,refused/capture} and g6b's snap/capture recordings.
case " ${GROUPS_RUN[*]} " in
*" g6z "*)
	for needed in g6a g6b; do
		case " ${GROUPS_RUN[*]} " in
		*" $needed "*) ;;
		*)
			echo "run-gate6: leg group g6z needs g6a and g6b in the same run (--legs g6a,g6h,g6b,g6z)" >&2
			exit 2
			;;
		esac
	done
	;;
esac

ACTUAL_BINARY_SHA256="$(sha256sum "$BINARY" | awk '{print $1}')"
if [ "$ACTUAL_BINARY_SHA256" != "$EXPECTED_BINARY_SHA256" ]; then
	echo "run-gate6: WARNING: $BINARY sha256 is $ACTUAL_BINARY_SHA256, expected $EXPECTED_BINARY_SHA256 (continuing: --binary may intentionally point at a different build)" >&2
fi

if [ -z "$OUT" ]; then
	OUT="$REPO_ROOT/artifacts/render-stream/gate6/$(date -u +%Y%m%dT%H%M%SZ)"
fi
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
	echo "run-gate6: $OUT already holds files; pass a fresh --out" >&2
	exit 1
fi
mkdir -p "$OUT"
OUT="$(realpath "$OUT")"
echo "run-gate6: evidence directory: $OUT (groups: ${GROUPS_RUN[*]})"
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
[ "$HAVE_STRACE" = "1" ] || echo "run-gate6: strace not installed -- headless-no-gpu will fail" >&2

# Whatever ends this script stops the Godot process it owns and tears its own compositor down.
# Only recorded pids are touched (gs_teardown re-verifies pid + start ticks).
# EXTRA_CHILD_PIDS (g6c): background hosts, receivers, samplers and proxies; each is stopped only
# while its command line still names this run's binary or a render-stream script (a recycled pid
# is never touched).
EXTRA_CHILD_PIDS=()
cleanup() {
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate6: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	local pid cmdline
	for pid in ${EXTRA_CHILD_PIDS[@]+"${EXTRA_CHILD_PIDS[@]}"}; do
		kill -0 "$pid" 2>/dev/null || continue
		cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
		case "$cmdline" in
		*"$BINARY"* | *render-stream/scripts/*)
			echo "run-gate6: stopping owned process $pid" >&2
			kill "$pid" 2>/dev/null || true
			;;
		esac
	done
	if [ -n "${GS_RUN_DIR:-}" ]; then
		gs_teardown "$GS_RUN_DIR" || true
	fi
}
trap cleanup EXIT

# The capture writes both sinks under gate 2's .rs2 names whatever wire version main speaks
# (render-stream/6 since G6b), and its payload store <capture>/store.
RECORDING_NAME=recording.rs2
PATCH_RECORDING_NAME=recording-patch.rs2
CAPTURE_WITH_PATCH=1
LEGS_LOG="run-gate6"
# shellcheck source=lib/legs.sh
source "$SCRIPT_DIR/lib/legs.sh"

# Every new GRC_*/RS_* variable gate 6 adds is covered by gs_strip_env_args's GRC_*/RS_* prefix
# strip; nothing else needs adding to GS_STRIP_VARS for G6a.

# A rendered fixture run (reference, reference-repeat, reference-armed): shots step-0..11 at the
# settle frames plus frame-13/53/93.png, and the step log. REFERENCE_ARMED=1 loads the capture
# extension armed with a full-sink stream and its store. REFERENCE_VARIANT sets
# RS_FIXTURE_VARIANT. REFERENCE_ORACLE=1 turns the scene oracle on
# (RS_FIXTURE_ORACLE_LOG=<dir>/oracle.jsonl). All are reset after the call.
REFERENCE_ARMED=0
REFERENCE_VARIANT=""
REFERENCE_ORACLE=0
run_reference() {
	local dir="$1" armed="$REFERENCE_ARMED" variant="$REFERENCE_VARIANT" oracle="$REFERENCE_ORACLE"
	REFERENCE_ARMED=0
	REFERENCE_VARIANT=""
	REFERENCE_ORACLE=0
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl")
	if [ -n "$variant" ]; then
		LEG_ENV+=(RS_FIXTURE_VARIANT="$variant")
	fi
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
	run_rendered "$dir" "$SCENE_FIXTURE_DIR"
}

# scene_capture <dir> <quit frame | default> [extra env words...]: the capture host (headless,
# release template, extension armed, both sinks and the store unless CAPTURE_STORE_DIR=none, strace
# + /proc maps/fd sample for the main captures).
scene_capture() {
	local dir="$1" quit="$2" mode="none"
	shift 2
	if [ "$quit" = "default" ]; then
		quit=""
	else
		mode="capture"
	fi
	CAPTURE_FIXTURE_DIR="$SCENE_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=(GRC_ROOT_SIZE=enforce-min-size "$@")
	run_capture "$dir" "$quit" "$mode"
}

# The seqs a receiver of <capture dir> shoots besides the settle seqs: the transactions published
# at MID_FRAMES (Q6c's intermediate frames).
mid_seqs() {
	local capture_dir="$1" frame seq out="" sep=""
	for frame in "${MID_FRAMES[@]}"; do
		seq="$(seq_at_frame "$capture_dir/$RECORDING_NAME" "$frame" 2>/dev/null)" || continue
		out+="$sep$seq"
		sep=","
	done
	echo "$out"
}

# A rendered receiver on <capture dir> shooting the settle seqs and the intermediate seqs; the
# RECEIVER_* knobs of lib/legs.sh may be set before the call.
scene_receiver() {
	local capture_dir="$1" dir="$2"
	if [ -f "$capture_dir/$RECORDING_NAME" ]; then
		RECEIVER_EXTRA_SHOTS="$(mid_seqs "$capture_dir")"
	fi
	run_rendered_receiver "$capture_dir" "$dir"
}

run_g6a() {
	local D="$OUT/scene" A="$OUT/animate" R="$OUT/refused" kind
	mkdir -p "$D/import"
	echo "run-gate6: g6a: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$D/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	if [ "$(cat "$D/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $SCENE_FIXTURE_DIR failed, see $D/import/fixture/stdout.log" >&2
		exit 1
	fi
	# The release template cannot run a loose project until the editor generated .godot/ (memory
	# receiver-needs-import-before-script).
	LEG_ENV=()
	run_headless "$D/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$D/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $RECEIVER_DIR failed, see $D/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate6: g6a: capture-scene"
	scene_capture "$D/capture" "$CAPTURE_QUIT_FRAME"
	echo "run-gate6: g6a: capture-scene-inline (every payload inline, no store)"
	CAPTURE_STORE_DIR=none
	scene_capture "$D/capture-inline" "$CAPTURE_QUIT_FRAME" GRC_RESOURCE_INLINE_MAX_BYTES=16777216 \
		GRC_RESOURCE_MAX_PAYLOAD_BYTES=16777216
	echo "run-gate6: g6a: capture-animate"
	scene_capture "$A/capture" "$CAPTURE_QUIT_FRAME" RS_FIXTURE_VARIANT=animate
	echo "run-gate6: g6a: capture-refused"
	scene_capture "$R/capture" "$CAPTURE_QUIT_FRAME" RS_FIXTURE_VARIANT=refused

	# Host sabotages on the default scene; predictions are fixtures/gate6-scene/expected.json
	# "predictions" (make_expected.py, never hand-edited). Frames: step 1 at 11, step 2 at 21.
	echo "run-gate6: g6a: sabotage-freeze (capture, freeze-frame @11)"
	scene_capture "$D/sabotage-freeze/capture" default GRC_SABOTAGE=freeze-frame GRC_SABOTAGE_FRAME=11
	echo "run-gate6: g6a: sabotage-omit-transform (capture, omit-op canvas_item_set_transform @21)"
	scene_capture "$D/sabotage-omit-transform/capture" default GRC_SABOTAGE=omit-op \
		GRC_SABOTAGE_OP=canvas_item_set_transform GRC_SABOTAGE_FRAME=21
	echo "run-gate6: g6a: sabotage-perturb-vertex (capture, perturb-vertex @21)"
	scene_capture "$D/sabotage-perturb-vertex/capture" default GRC_SABOTAGE=perturb-vertex GRC_SABOTAGE_FRAME=21
	echo "run-gate6: g6a: sabotage-perturb-shader (capture, perturb-shader @21)"
	scene_capture "$D/sabotage-perturb-shader/capture" default GRC_SABOTAGE=perturb-shader GRC_SABOTAGE_FRAME=21

	echo "run-gate6: bringing up private gamescope for g6a rendered legs"
	gs_start 640 360 "$OUT/gamescope-g6a"

	echo "run-gate6: g6a: reference-scene (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$D/reference"
	echo "run-gate6: g6a: reference-scene-repeat (oracle on)"
	REFERENCE_ORACLE=1
	run_reference "$D/reference-repeat"
	echo "run-gate6: g6a: reference-scene-armed (extension armed, stream on, oracle off)"
	REFERENCE_ARMED=1
	run_reference "$D/reference-armed"
	echo "run-gate6: g6a: reference-animate (oracle on)"
	REFERENCE_VARIANT=animate
	REFERENCE_ORACLE=1
	run_reference "$A/reference"
	echo "run-gate6: g6a: reference-refused (oracle on)"
	REFERENCE_VARIANT=refused
	REFERENCE_ORACLE=1
	run_reference "$R/reference"

	echo "run-gate6: g6a: receiver-scene (full sink)"
	scene_receiver "$D/capture" "$D/receiver"
	echo "run-gate6: g6a: receiver-scene-patch (patch sink, state dumps at the settle seqs)"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	RECEIVER_STATE=1
	scene_receiver "$D/capture" "$D/receiver-patch"
	echo "run-gate6: g6a: receiver-scene-inline (capture-inline, no store)"
	scene_receiver "$D/capture-inline" "$D/receiver-inline"
	echo "run-gate6: g6a: receiver-animate"
	scene_receiver "$A/capture" "$A/receiver"
	echo "run-gate6: g6a: receiver-refused"
	scene_receiver "$R/capture" "$R/receiver"
	for kind in freeze omit-transform perturb-vertex perturb-shader; do
		echo "run-gate6: g6a: sabotage-$kind (receiver)"
		scene_receiver "$D/sabotage-$kind/capture" "$D/sabotage-$kind/receiver"
	done
	for kind in ignore-clip stale-texture; do
		echo "run-gate6: g6a: sabotage-receiver-$kind (RS_RECEIVER_SABOTAGE=$kind on scene/capture)"
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_SABOTAGE="$kind")
		scene_receiver "$D/capture" "$D/sabotage-receiver-$kind"
	done

	gs_teardown "$OUT/gamescope-g6a"
	GS_RUN_DIR=""
}

# shellcheck source=lib/gate6h-legs.sh
source "$SCRIPT_DIR/lib/gate6h-legs.sh"
# shellcheck source=lib/gate6b-legs.sh
source "$SCRIPT_DIR/lib/gate6b-legs.sh"
# shellcheck source=lib/gate6c-legs.sh
source "$SCRIPT_DIR/lib/gate6c-legs.sh"
# shellcheck source=lib/gate6p-legs.sh
source "$SCRIPT_DIR/lib/gate6p-legs.sh"

# ---------------------------------------------------------------------------------------------
# G6l (gate6-design.md "G6l", Q7c): live motion, the 2-s stall, reconnect and the warm cache on
# fixtures/gate6-scene's `animate` variant with the live timeline (S=300, N=60, step k at 300 +
# 60k, settled 7 frames later, quit at S + 13N = 1080) and `steps` time (D6: host frame f is
# reference frame f whatever the wall clock does). Everything lives under <out>/live/:
#   import/{fixture,receiver}/  editor --import passes (memory receiver-needs-import-before-script)
#   <leg>/host/       a live host (headless, armed, both sinks and the store, tap, --max-fps 60)
#   <leg>/receiver/   its rendered live receiver (--max-fps 60, the shot windows of g6l_windows)
#   reference-live-frames/   the rendered reference on the live timeline shooting every host frame
#                            a receiver shot, plus every frame a shot transaction's snapshot came
#                            from (stale-coalesce's `stale_from`), as shots/frame-<f>.png
#   reference-file/          the rendered `animate` reference on the file timeline (live-steps)
# Legs: live-scene (fresh cache), live-scene-warm (a new host + receiver on live-scene's cache,
# mode warm), live-stall (RS_RECEIVER_STALL=2:2000), live-reconnect (RS_RECEIVER_RECONNECT=5,
# RS_RECEIVER_RECONNECT_MEMORY=keep), sabotage-live-stale-coalesce (the stall, host
# GRC_SABOTAGE=stale-coalesce from step 2's frame 420).
G6L_START_FRAME=300
# G7u part D: a DEVICE lifecycle run may raise S (G7U_START_FRAME, set by run-gate7.sh --env
# device per receiver kind: the web export's page needs ~9.5 s on the g31 to connect, past S=300's
# 5 s at 60 fps). Every frame below derives from S, the lc hosts and the reference get
# RS_FIXTURE_START_FRAME, and the device daemon records it in lifecycle.json; a desktop run, or an
# unset/300 value, is exactly S=300.
G6L_START_OVERRIDE=""
if [ -n "${G7U_START_FRAME:-}" ] && [ "$G7U_START_FRAME" != 300 ]; then
	if [ "${GATE7_LIFECYCLE_ENV:-desktop}" != device ] || [ -z "${G7U_LEGS:-}" ]; then
		echo "run-gate6: G7U_START_FRAME=$G7U_START_FRAME is for a device lifecycle run only (GATE7_LIFECYCLE_ENV=device with G7U_LEGS)" >&2
		exit 2
	fi
	case "$G7U_START_FRAME" in
	*[!0-9]* | "")
		echo "run-gate6: G7U_START_FRAME must be an integer >= 300 (got $G7U_START_FRAME)" >&2
		exit 2
		;;
	esac
	if [ "$G7U_START_FRAME" -lt 300 ]; then
		echo "run-gate6: G7U_START_FRAME must be an integer >= 300 (got $G7U_START_FRAME)" >&2
		exit 2
	fi
	G6L_START_FRAME=$G7U_START_FRAME
	G6L_START_OVERRIDE=1
fi
G6L_STEP_FRAMES=60
G6L_LAST_STEP=11
G6L_QUIT_FRAME=$((G6L_START_FRAME + G6L_STEP_FRAMES * 13))
G6L_STALL_SPEC="2:2000"
G6L_RECONNECT_STEP=5
G6L_SABOTAGE_FRAME=$((G6L_START_FRAME + G6L_STEP_FRAMES * 2))
# Q7c: 40 motion windows of 10 frames spread over frames 320..1060 (labels 100..139, from 320 +
# floor(18.5 i)), listed after the twelve settle windows (labels 0..11: from the settle frame to
# the frame before the next step, the last to the quit). The receiver shoots the first applied
# transaction in each window, trying windows in list order, so a motion window never takes a
# settle shot.
G6L_MOTION_WINDOWS=40
G6L_MOTION_FIRST=$((G6L_START_FRAME + 20))
G6L_MOTION_LABEL=100

g6l_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 "$G6L_LAST_STEP"); do
		from=$((G6L_START_FRAME + G6L_STEP_FRAMES * k + 7))
		to=$((G6L_START_FRAME + G6L_STEP_FRAMES * (k + 1) - 1))
		[ "$k" -eq "$G6L_LAST_STEP" ] && to=$G6L_QUIT_FRAME
		out+="$sep$k:$from-$to"
		sep=","
	done
	for k in $(seq 0 $((G6L_MOTION_WINDOWS - 1))); do
		from=$((G6L_MOTION_FIRST + (37 * k) / 2))
		out+=",$((G6L_MOTION_LABEL + k)):$from-$((from + 9))"
	done
	echo "$out"
}

# start_live_scene_host <dir> [extra env words...]: the gate6-scene host (headless, armed, both
# file sinks and their store, the live tap, --max-fps 60, `animate`, live timeline) serving on
# 127.0.0.1:0 in the background. Waits for evidence/live.json and sets LIVE_PORT ("" when the host
# is not listening).
start_live_scene_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/$RECORDING_NAME"
		GRC_STREAM_PATCH_OUT="$dir/$PATCH_RECORDING_NAME" GRC_RESOURCE_STORE_DIR="$dir/store"
		GRC_ROOT_SIZE=enforce-min-size GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=live RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" "$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$SCENE_FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate6: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

# g6l_receiver <leg dir> [extra env words...]: a rendered live receiver on the current host's
# port with a fresh cache at <leg>/receiver/cache (the extra words may override it), --max-fps 60
# and the shot windows of g6l_windows (credit stage submitted).
g6l_receiver() {
	local leg="$1" dir="$1/receiver"
	shift
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate6: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_CACHE_DIR="$dir/cache"
		RS_RECEIVER_SHOT_WINDOWS="$(g6l_windows)" "$@"
	)
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	run_rendered "$dir" "$RECEIVER_DIR"
}

# g6l_leg <leg> <host words...> -- <receiver words...>: one live host and one receiver against
# it, then the host to its quit frame.
g6l_leg() {
	local leg="$1"
	shift
	local -a host_words=() receiver_words=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		host_words+=("$1")
		shift
	done
	[ $# -gt 0 ] && shift
	receiver_words=("$@")
	start_live_scene_host "$L/$leg/host" ${host_words[@]+"${host_words[@]}"}
	g6l_receiver "$L/$leg" ${receiver_words[@]+"${receiver_words[@]}"}
	G6L_LOAD_END="$(g6l_load1)" # the host still holds the exclusive quiet lock here
	finish_bg "$L/$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
}

# G7mm: motion-monotonic is a timing check. g6l_motion_leg <leg> <g6l_leg words...> runs one of
# the five motion legs (a timing leg: g6l_leg's host holds the exclusive quiet lock), records the
# 1-min /proc/loadavg figure at the leg's start (before its host launches) and end (receiver done,
# host still running), and judges the leg's motion-monotonic through g6l-motion-leg.ts. A failed
# leg whose load exceeded G6L_RERUN_LOAD (the quiet lock cannot see other repos' load) runs exactly
# once more; its first attempt moves to <out>/g6l-attempts/<leg>-attempt1. The bound is never
# widened. <leg dir>/attempts.json lists every attempt; the checker reports it.
G6L_RERUN_LOAD="${G6L_RERUN_LOAD:-4}"
G6L_LOAD_END=""
g6l_tsx() {
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$@")
}
g6l_load1() {
	local l1=""
	read -r l1 _ </proc/loadavg
	printf '%s' "${l1:-0}"
}

g6l_motion_leg() {
	local leg="$1" attempt=1 load_start verdict pass rerun attempts_json=""
	while :; do
		load_start="$(g6l_load1)"
		G6L_LOAD_END=""
		g6l_leg "$@"
		[ -f "$L/$leg/host/skipped-by-tier.txt" ] && return 0
		verdict="$(quiet_run shared "$LEGS_LOG:g6l-motion-leg:$leg" -- \
			g6l_tsx "$SCRIPT_DIR/g6l-motion-leg.ts" "$L" "$leg" 2>/dev/null | tail -n 1)" || true
		pass=false
		case "$verdict" in *'"pass":true'*) pass=true ;; esac
		attempts_json+="${attempts_json:+,}{\"attempt\":$attempt,\"load_start\":$load_start,\"load_end\":${G6L_LOAD_END:-null},\"motion_pass\":$pass}"
		rerun=no
		if [ "$pass" = false ] && [ "$attempt" = 1 ] && [ -z "$G6L_START_OVERRIDE" ] &&
			awk -v a="$load_start" -v b="${G6L_LOAD_END:-0}" -v t="$G6L_RERUN_LOAD" 'BEGIN{exit !((a>t)||(b>t))}'; then
			rerun=yes
		fi
		echo "run-gate6: g6l: $leg attempt $attempt load $load_start -> ${G6L_LOAD_END:-?}, motion pass=$pass, rerun=$rerun"
		if [ "$rerun" = yes ]; then
			mkdir -p "$OUT/g6l-attempts"
			rm -rf "$OUT/g6l-attempts/$leg-attempt1"
			mv "$L/$leg" "$OUT/g6l-attempts/$leg-attempt1"
			attempt=2
			continue
		fi
		break
	done
	printf '{"attempts":[%s]}\n' "$attempts_json" >"$L/$leg/attempts.json"
}

# The host frames reference-live-frames must shoot (a CSV): for every shot of every g6l receiver,
# the frame of the transaction it shot and, when the host's live log says that send carried an
# older snapshot (stale-coalesce's `stale_from`), that frame too.
g6l_shot_frames() {
	python3 - "$1" <<'PY'
import json, os, sys

root = sys.argv[1]
frames = set()
for leg in sorted(os.listdir(root)):
    applied = os.path.join(root, leg, "receiver", "applied.json")
    if not os.path.isfile(applied):
        continue
    try:
        with open(applied) as f:
            a = json.load(f)
    except ValueError:
        continue
    tx = {(t.get("stream", 1), t.get("seq")): t.get("frame") for t in a.get("transactions") or []}
    stale = {}
    for n in (1, 2, 3, 4):
        path = os.path.join(root, leg, "host", "tap", "live-%d.jsonl" % n)
        if not os.path.isfile(path):
            continue
        with open(path) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                sent = entry.get("sent")
                if isinstance(sent, dict) and sent.get("stale_from") is not None:
                    stale[(n, sent.get("seq"))] = sent["stale_from"]
    for s in a.get("shots") or []:
        key = (s.get("stream", 1), s.get("seq"))
        if tx.get(key) is not None:
            frames.add(int(tx[key]))
        if key in stale:
            frames.add(int(stale[key]))
print(",".join(str(f) for f in sorted(frames)))
PY
}

# G7u lifecycle legs (header; g7u-as-built.md "Legs"): every lc receiver shoots its final
# state (RS_RECEIVER_SHOT_FINAL=1); RS_RECEIVER_LIFECYCLE and RS_RECEIVER_SHELL_SABOTAGE are
# harness words (lib/gate7-live-legs.ts mapBrowserLeg drops them from the page env). The 30-s legs
# run the host to frame 3180 (the suspension at step 2's shot, ~frame 427, ends ~frame 2230).
G7U_LONG_QUIT_FRAME=$((3180 + G6L_START_FRAME - 300))
G7U_LEGS="${G7U_LEGS:-}"

# G7k startup legs (gate7-design.md Q10 "Startup", protocol/gate7/g7k.md): with
# G7K_STARTUP_LEGS=<csv> (a browser receiver only, GATE7_LIVE_KIND) g6l runs ONLY the named
# startup-cold-r<N>/startup-warm-r<N> legs (N 0..5, 0 the discarded warmup) against a plain
# live-scene host; the g6l legs, reference-file and reference-live-frames are skipped (a startup
# leg's timings.json is its only evidence; it shoots nothing). Mutually exclusive with G7U_LEGS.
G7K_STARTUP_LEGS="${G7K_STARTUP_LEGS:-}"

# g6l_startup_words <leg>: sets ST_RECEIVER_WORDS for one startup leg; fails (with a message) on
# an unknown name. A cold leg is a fresh profile (the default `g6l_receiver` RS_RECEIVER_CACHE_DIR,
# dropped by the browser mapper anyway). A warm leg's browser starts on a copy of
# startup-warm-r0's own profile (RS_RECEIVER_CACHE_MODE=warm on its RS_RECEIVER_CACHE_DIR,
# gate7-live-legs.ts mapBrowserLeg's warmFrom) -- repeat 0 is both the discarded warmup D15 names
# and the one cold load every later warm repeat copies from (so each is independently "a second
# load in the same profile", never a sixth).
g6l_startup_words() {
	local leg="$1"
	ST_RECEIVER_WORDS=()
	case "$leg" in
	startup-cold-r[0-5] | startup-warm-r0) ;;
	startup-warm-r[1-5])
		ST_RECEIVER_WORDS=(
			RS_RECEIVER_CACHE_DIR="$L/startup-warm-r0/receiver/cache" RS_RECEIVER_CACHE_MODE=warm
		)
		;;
	*)
		echo "run-gate6: G7K_STARTUP_LEGS: unknown startup leg $leg" >&2
		return 1
		;;
	esac
	return 0
}

# g6l_lc_words <leg>: sets LC_HOST_WORDS and LC_RECEIVER_WORDS for one lc leg; fails (with a
# message) on an unknown leg, or one not of this environment (sim- legs are desktop only, the real
# hidden/frozen ones device only).
g6l_lc_words() {
	local leg="$1" device=0 lc=""
	[ "${GATE7_LIFECYCLE_ENV:-desktop}" = "device" ] && device=1
	LC_HOST_WORDS=()
	LC_LONG=0
	LC_RECEIVER_WORDS=(RS_RECEIVER_SHOT_FINAL=1)
	case "$leg" in
	sim-hidden-2s | hidden-2s) lc="suspend:hidden:2:2000" ;;
	sim-hidden-30s | hidden-30s)
		lc="suspend:hidden:2:30000:home"
		LC_HOST_WORDS=(RS_FIXTURE_QUIT_FRAME="$G7U_LONG_QUIT_FRAME")
		LC_LONG=1
		;;
	sim-frozen-30s | frozen-30s)
		lc="suspend:frozen:2:30000"
		LC_HOST_WORDS=(RS_FIXTURE_QUIT_FRAME="$G7U_LONG_QUIT_FRAME")
		LC_LONG=1
		# D14 as amended: a frozen page may lose its socket; the receiver recovers by G1d's
		# reconnect (a fresh session, the newest state first).
		LC_RECEIVER_WORDS+=(RS_RECEIVER_RECONNECT_ON_LOSS=1)
		;;
	reload) lc="reload:5" ;;
	close) lc="close:5" ;;
	context-loss) lc="context-loss:5:500" ;;
	sabotage-ack-while-hidden)
		lc="suspend:hidden:2:2000"
		LC_RECEIVER_WORDS+=(RS_RECEIVER_SABOTAGE=ack-while-hidden)
		;;
	sabotage-css-opacity)
		lc="suspend:hidden:2:2000"
		LC_RECEIVER_WORDS+=(RS_RECEIVER_SHELL_SABOTAGE=css-opacity)
		;;
	*)
		echo "run-gate6: G7U_LEGS: unknown lifecycle leg $leg" >&2
		return 1
		;;
	esac
	case "$leg" in
	sim-*)
		if [ "$device" = 1 ]; then
			echo "run-gate6: G7U_LEGS: $leg is a desktop (simulated-suspension) leg; the device runs ${leg#sim-}" >&2
			return 1
		fi
		;;
	hidden-* | frozen-*)
		if [ "$device" = 0 ]; then
			echo "run-gate6: G7U_LEGS: $leg needs a real suspension (GATE7_LIFECYCLE_ENV=device); the desktop runs sim-$leg" >&2
			return 1
		fi
		;;
	sabotage-css-opacity)
		if [ "$device" = 1 ]; then
			echo "run-gate6: G7U_LEGS: sabotage-css-opacity is a desktop leg" >&2
			return 1
		fi
		;;
	esac
	LC_RECEIVER_WORDS+=(RS_RECEIVER_LIFECYCLE="$lc")
	[ -n "$G6L_START_OVERRIDE" ] && LC_HOST_WORDS+=(RS_FIXTURE_START_FRAME="$G6L_START_FRAME")
	return 0
}

# run_g7u_lc: the G7U_LEGS legs (run_g6l validated every name before any host ran); sets
# G7U_MAX_QUIT_FRAME, the largest host quit frame of the run (reference-live-frames runs to it).
run_g7u_lc() {
	local leg
	local -a legs=()
	IFS=',' read -r -a legs <<<"$G7U_LEGS"
	G7U_MAX_QUIT_FRAME=$G6L_QUIT_FRAME
	for leg in "${legs[@]}"; do
		g6l_lc_words "$leg"
		if [ "$LC_LONG" = 1 ]; then
			G7U_MAX_QUIT_FRAME=$G7U_LONG_QUIT_FRAME
		fi
		echo "run-gate6: g6l: lc $leg (${LC_HOST_WORDS[*]:-host default} -- ${LC_RECEIVER_WORDS[*]})"
		g6l_leg "$leg" ${LC_HOST_WORDS[@]+"${LC_HOST_WORDS[@]}"} -- "${LC_RECEIVER_WORDS[@]}"
	done
}

run_g6l() {
	local L="$OUT/live" frames
	local -a quit_words=()
	if [ -n "$G7U_LEGS" ] && [ -n "$G7K_STARTUP_LEGS" ]; then
		echo "run-gate6: G7U_LEGS and G7K_STARTUP_LEGS are mutually exclusive" >&2
		exit 2
	fi
	if [ -n "$G7U_LEGS" ]; then
		if [ -z "$GATE7_LIVE_KIND" ]; then
			echo "run-gate6: G7U_LEGS needs a browser receiver (GATE7_LIVE_KIND=web|gsw; run-gate7.sh --live --legs g7-lc)" >&2
			exit 2
		fi
		# Validate every leg name before any host runs.
		local lc_leg
		local -a lc_legs=()
		IFS=',' read -r -a lc_legs <<<"$G7U_LEGS"
		for lc_leg in "${lc_legs[@]}"; do
			g6l_lc_words "$lc_leg" || exit 2
		done
		# A 30-s leg's host runs ~53 s at 60 fps, its receiver as long, the reference to frame 3180.
		HEADLESS_TIMEOUT_S=300
		RENDERED_TIMEOUT_S=300
	fi
	if [ -n "$G7K_STARTUP_LEGS" ]; then
		if [ -z "$GATE7_LIVE_KIND" ]; then
			echo "run-gate6: G7K_STARTUP_LEGS needs a browser receiver (GATE7_LIVE_KIND=web|gsw; run-gate7.sh --legs g7-k)" >&2
			exit 2
		fi
		local st_leg
		local -a st_legs=()
		IFS=',' read -r -a st_legs <<<"$G7K_STARTUP_LEGS"
		for st_leg in "${st_legs[@]}"; do
			g6l_startup_words "$st_leg" || exit 2
		done
	fi
	mkdir -p "$L/import"
	echo "run-gate6: g6l: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$L/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	if [ "$(cat "$L/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $SCENE_FIXTURE_DIR failed, see $L/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$L/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$L/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $RECEIVER_DIR failed, see $L/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate6: bringing up private gamescope for g6l legs"
	gs_start 640 360 "$OUT/gamescope-g6l"

	if [ -n "$G7K_STARTUP_LEGS" ]; then
		local st_leg
		local -a st_legs=()
		IFS=',' read -r -a st_legs <<<"$G7K_STARTUP_LEGS"
		for st_leg in "${st_legs[@]}"; do
			g6l_startup_words "$st_leg"
			echo "run-gate6: g6l: startup $st_leg (${ST_RECEIVER_WORDS[*]:-fresh profile})"
			g6l_leg "$st_leg" -- "${ST_RECEIVER_WORDS[@]}"
		done
		gs_teardown "$OUT/gamescope-g6l"
		GS_RUN_DIR=""
		return 0
	fi

	if [ -n "$G7U_LEGS" ]; then
		run_g7u_lc
		quit_words=(RS_FIXTURE_QUIT_FRAME="$G7U_MAX_QUIT_FRAME")
		[ -n "$G6L_START_OVERRIDE" ] && quit_words+=(RS_FIXTURE_START_FRAME="$G6L_START_FRAME")
		frames="$(g6l_shot_frames "$L")"
		echo "run-gate6: g6l: reference-live-frames (lc; quit $G7U_MAX_QUIT_FRAME; the frames the receivers shot: $frames)"
		mkdir -p "$L/reference-live-frames/shots"
		LEG_ENV=(
			RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=live RS_FIXTURE_SHOT_FRAMES="$frames"
			RS_FIXTURE_SHOT_DIR="$L/reference-live-frames/shots"
			RS_FIXTURE_STEP_LOG="$L/reference-live-frames/steps.jsonl" "${quit_words[@]}"
		)
		run_rendered "$L/reference-live-frames" "$SCENE_FIXTURE_DIR"
		gs_teardown "$OUT/gamescope-g6l"
		GS_RUN_DIR=""
		return 0
	fi

	echo "run-gate6: g6l: live-scene (host + rendered live receiver, fresh cache)"
	g6l_motion_leg live-scene
	echo "run-gate6: g6l: live-scene-warm (a new host + a new rendered receiver on live-scene's cache)"
	g6l_motion_leg live-scene-warm -- RS_RECEIVER_CACHE_DIR="$L/live-scene/receiver/cache" RS_RECEIVER_CACHE_MODE=warm
	echo "run-gate6: g6l: live-stall (RS_RECEIVER_STALL=$G6L_STALL_SPEC)"
	g6l_motion_leg live-stall -- RS_RECEIVER_STALL="$G6L_STALL_SPEC"
	echo "run-gate6: g6l: live-reconnect (RS_RECEIVER_RECONNECT=$G6L_RECONNECT_STEP, memory kept)"
	g6l_motion_leg live-reconnect -- RS_RECEIVER_RECONNECT="$G6L_RECONNECT_STEP" RS_RECEIVER_RECONNECT_MEMORY=keep
	echo "run-gate6: g6l: sabotage-live-stale-coalesce (stale-coalesce @$G6L_SABOTAGE_FRAME, RS_RECEIVER_STALL=$G6L_STALL_SPEC)"
	g6l_motion_leg sabotage-live-stale-coalesce GRC_SABOTAGE=stale-coalesce GRC_SABOTAGE_FRAME="$G6L_SABOTAGE_FRAME" -- \
		RS_RECEIVER_STALL="$G6L_STALL_SPEC"

	frames="$(g6l_shot_frames "$L")"
	echo "run-gate6: g6l: reference-live-frames (the frames the receivers shot: $frames)"
	mkdir -p "$L/reference-live-frames/shots"
	LEG_ENV=(
		RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=live RS_FIXTURE_SHOT_FRAMES="$frames"
		RS_FIXTURE_SHOT_DIR="$L/reference-live-frames/shots"
		RS_FIXTURE_STEP_LOG="$L/reference-live-frames/steps.jsonl"
	)
	run_rendered "$L/reference-live-frames" "$SCENE_FIXTURE_DIR"
	echo "run-gate6: g6l: reference-file (animate, file timeline: live-steps' step-determined regions)"
	mkdir -p "$L/reference-file/shots"
	LEG_ENV=(
		RS_FIXTURE_VARIANT=animate RS_FIXTURE_SHOT_DIR="$L/reference-file/shots"
		RS_FIXTURE_STEP_LOG="$L/reference-file/steps.jsonl"
	)
	run_rendered "$L/reference-file" "$SCENE_FIXTURE_DIR"

	gs_teardown "$OUT/gamescope-g6l"
	GS_RUN_DIR=""
}

# ---------------------------------------------------------------------------------------------
# G6s (gate6-design.md "G6s", Q5 "Resource budgets", Q7e "Stability (g6s)"): receiver cache
# budgets and eviction over a 300-s soak (realtime, timeline `soak`, variant `animate`,
# GRC_HOOK_LOG=off). No file sinks and no live tap: the soak has no use for either (the hook log
# is off, and nothing here reads tap/*.jsonl), so each leg's only evidence is the host's
# perf-timeline.jsonl, a runner-side `/proc` sampler on the host pid (scripts/sample-proc.ts) and
# the receiver's own applied.json/perf.json. Everything lives under <out>/g6s/.
G6S_MEMORY_BUDGET_BYTES=1048576 # 1 MiB (Q7e: 64 TEXA payloads)
G6S_CACHE_BUDGET_BYTES=4194304  # 4 MiB
G6S_INLINE_MAX_BYTES=1048576    # soak-inline: every payload goes inline (live mode's own cap)

# G7k (gate7-design.md Q10 "Soak", protocol/gate7/g7k.md): with G6S_LEGS=<csv> (a browser
# receiver only, GATE7_LIVE_KIND) run_g6s runs only the named legs under <out>/g6s/, in the order
# below -- never reorders, never dedupes a caller's duplicate. The default is every native leg,
# unchanged. `sabotage-leak-gl-textures` is GSW-only (RS_RECEIVER_SABOTAGE has no effect on the
# native receiver or the web export's engine: the real leak lives in gsw-receiver's own WebGL
# context wrapper, gate7-design.md Q10, gl-leak.ts) and is never selected by the default.
G6S_LEGS="${G6S_LEGS:-soak-scene,soak-inline,sabotage-soak-no-evict,sabotage-soak-retain-superseded}"
g6s_leg_wanted() {
	case ",$G6S_LEGS," in
	*",$1,"*) return 0 ;;
	*) return 1 ;;
	esac
}

# g6s_windows: 11 windows spread across frame 1000..20499 for early/mid motion sampling, plus one
# final window placed AFTER step 11's nominal trigger frame (60 fps * 365 s = 21900). Realtime
# pacing (D6) means the real trigger frame is unknown in advance, but the --max-fps 60 cap means
# the achieved rate can only be at or below 60 fps, so any slower run only reduces how many
# frames land inside the same 365 s of real time -- the actual trigger frame can therefore only be
# <= 21900, never above it. Starting the last window there always lands at or after the freeze
# (gate6-design.md "As built (G6s)"; a window starting at frame 1000+k*1850, as this used to do
# uniformly, could instead land its "first transaction" inside the window BEFORE the real trigger
# fired -- measured, a 546-frame-early shot at frame 21350 against a real trigger at 21896, 15 347
# mismatched pixels in exactly the continuous-formula regions step 11 freezes: SC, PB, SM, MS, AN,
# LB). Quit follows 5 s later (observed frame ~22144 at this build's achieved rate), leaving room
# for at least one applied transaction before the connection closes.
g6s_windows() {
	local k from to out="" sep=""
	for k in $(seq 0 9); do
		from=$((1000 + k * 1850))
		to=$((from + 1849))
		out+="$sep$k:$from-$to"
		sep=","
	done
	out+="$sep""10:20000-20499"
	out+="$sep""11:21910-22190"
	echo "$out"
}

# start_soak_scene_host <dir> [extra env words...]: the gate6-scene host (headless, armed, the
# soak timeline, animate variant, GRC_HOOK_LOG=off, the live listener, --max-fps 60) serving on
# 127.0.0.1:0 in the background. Waits for evidence/live.json and sets LIVE_PORT ("" when the host
# is not listening).
start_soak_scene_host() {
	local dir="$1" waited=0
	shift
	mkdir -p "$dir/evidence"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_ROOT_SIZE=enforce-min-size GRC_HOOK_LOG=off
		GRC_LIVE_LISTEN=127.0.0.1:0 RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=soak
		RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" "$@"
	)
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps 60 --path "$SCENE_FIXTURE_DIR"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate6: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

# g6s_receiver <leg dir> [extra env words...]: a rendered live receiver on the current host's
# port, RS_RECEIVER_LOG=summary (a 370-s soak's transaction array would be enormous), a perf.json,
# Q7e's memory budget by default (the caller's extra env words may override it, soak-inline's
# does), --max-fps 60 and the shot windows of g6s_windows().
g6s_receiver() {
	local leg="$1" dir="$1/receiver"
	shift
	mkdir -p "$dir"
	if [ -z "$LIVE_PORT" ]; then
		echo "the live host is not listening (see $leg/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate6: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$LIVE_PORT/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_LOG=summary RS_RECEIVER_PERF_OUT="$dir/perf.json"
		RS_RECEIVER_MEMORY_BUDGET_BYTES="$G6S_MEMORY_BUDGET_BYTES" RS_RECEIVER_SHOT_WINDOWS="$(g6s_windows)" "$@"
	)
	# G7k: the web export mirrors the received bytes in MEMFS and PUTs them at exit; for a 300-s
	# soak that is ~420 MB and ~20 minutes (the process outlived its work and the shots PUT after it
	# never arrived). A 1 MiB cap keeps the file a stream prefix; the soak judges shots and perf.
	# G7kh: GSW's tap holds every received message as an ArrayBuffer until exit (218 MB at credit
	# window 2, one JS wrapper per record: ~210 KB/min of the JS heap the soak judges), so it gets
	# the same cap. Native gate 6 never sets GATE7_LIVE_KIND.
	if [ "$GATE7_LIVE_KIND" = "web" ] || [ "$GATE7_LIVE_KIND" = "gsw" ]; then
		LEG_ENV+=(RS_RECEIVER_RECEIVED_MAX_BYTES=1048576)
	fi
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	run_rendered "$dir" "$RECEIVER_DIR"
}

# g6s_leg <leg> <host words...> -- <receiver words...>: one live host and one receiver against
# it, a runner-side /proc sampler on the host pid throughout (scripts/sample-proc.ts), then the
# host to its own 370-s quit.
g6s_leg() {
	local leg="$1"
	shift
	local -a host_words=() receiver_words=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do
		host_words+=("$1")
		shift
	done
	[ $# -gt 0 ] && shift
	receiver_words=("$@")
	start_soak_scene_host "$G6S/$leg/host" ${host_words[@]+"${host_words[@]}"}
	local sampler_pid=""
	if [ -n "$LIVE_HOST_PID" ]; then
		(
			cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
				"$SCRIPT_DIR/sample-proc.ts" --pid "$LIVE_HOST_PID" --out "$G6S/$leg/host/proc-samples.jsonl"
		) >"$G6S/$leg/host/sample-proc.log" 2>&1 &
		sampler_pid=$!
	fi
	g6s_receiver "$G6S/$leg" ${receiver_words[@]+"${receiver_words[@]}"}
	finish_bg "$G6S/$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
	LIVE_HOST_PID=""
	if [ -n "$sampler_pid" ]; then
		kill "$sampler_pid" 2>/dev/null || true
		wait "$sampler_pid" 2>/dev/null || true
	fi
}

run_g6s() {
	local G6S="$OUT/g6s" old_headless="$HEADLESS_TIMEOUT_S" old_rendered="$RENDERED_TIMEOUT_S"
	mkdir -p "$G6S/import"
	echo "run-gate6: g6s: import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$G6S/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	if [ "$(cat "$G6S/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $SCENE_FIXTURE_DIR failed, see $G6S/import/fixture/stdout.log" >&2
		exit 1
	fi
	LEG_ENV=()
	run_headless "$G6S/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	if [ "$(cat "$G6S/import/receiver/exit-code.txt")" != "0" ]; then
		echo "run-gate6: import of $RECEIVER_DIR failed, see $G6S/import/receiver/stdout.log" >&2
		exit 1
	fi

	echo "run-gate6: bringing up private gamescope for g6s legs"
	gs_start 640 360 "$OUT/gamescope-g6s"

	# Each leg (including this reference) runs the fixture's soak timeline to its own natural
	# ~370-s quit. G7k (As built, protocol/gate7/g7k.md): a browser receiver's own launch, any
	# quiet-lock wait before the leg's own 370 s even starts, AND a pre-existing gap in the web
	# export's live shutdown after this long a connection all need slack native never needed.
	# Measured twice, with and without gate7k-samplers.ts's memory sampler attached (ruling the
	# sampler out as the cause): a web-export soak-scene leg's own applied.json reaches
	# end_seen/status "ok" with every resources_summary figure complete (the replay itself
	# finished cleanly, by its own account), but the browser-receiver process does not exit on
	# its own afterward and needs an external kill at ~1250-1280 s. The evidence written before
	# the kill is unaffected (checked byte-identical both times), so the budget below just needs
	# to outlast that gap, not avoid it; closing the gap itself is receiver.gd's live shutdown
	# path, shared architecture outside this budget-and-samplers-scoped increment (G6s's own RSS
	# finding is the precedent for reporting rather than fixing a shared-architecture gap here).
	HEADLESS_TIMEOUT_S=420
	RENDERED_TIMEOUT_S=420
	if [ -n "$GATE7_LIVE_KIND" ]; then
		HEADLESS_TIMEOUT_S=420
		RENDERED_TIMEOUT_S=1500
	fi

	# reference-step11 MUST run the soak timeline itself, at the SAME --max-fps 60 as every host
	# and receiver here, not the file timeline and not uncapped: step 11's freeze (gate6_scene.gd's
	# `frozen` flag) stops every continuous per-frame update (MS, SM, AN, and the animate variant's
	# SC/LB/CD/TEXA) exactly where it happened to be on the frame before the freeze fired, and that
	# frame number depends on both the timeline (file: a deterministic frame count; soak: whatever
	# frame real-time pacing reached when game time first hit 365 s -- measured 21895 here,
	# consistently across --max-fps 60 runs on this host/build) and the achieved frame rate (an
	# uncapped rendered reference ran at roughly 1650 fps, crossing game time 365 s around frame
	# 500 000+ instead). Either mismatch alone is thousands of pixels (gate6-design.md
	# "As built (G6s)").
	echo "run-gate6: g6s: reference-step11 (soak timeline, animate variant, --max-fps 60: step 11's freeze)"
	mkdir -p "$G6S/reference-step11/shots"
	LEG_ENV=(
		RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=soak
		RS_FIXTURE_SHOT_DIR="$G6S/reference-step11/shots" RS_FIXTURE_STEP_LOG="$G6S/reference-step11/steps.jsonl"
	)
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	# Realtime-paced (its freeze frame depends on the achieved rate): a timing leg of its own.
	timing_leg g6s:reference-step11 run_rendered "$G6S/reference-step11" "$SCENE_FIXTURE_DIR"

	if g6s_leg_wanted soak-scene; then
		echo "run-gate6: g6s: soak-scene (fresh cache, memory 1 MiB / disk 4 MiB)"
		g6s_leg soak-scene -- RS_RECEIVER_CACHE_DIR="$G6S/soak-scene/receiver/cache" \
			RS_RECEIVER_CACHE_BUDGET_BYTES="$G6S_CACHE_BUDGET_BYTES"
	fi

	# No cache dir and no store (pure inline, G2c2's HTTP fetcher never starts): a hash evicted
	# from memory under budget pressure could never be recovered (the host never resends a
	# carried hash, memory g6s-carried-set-resource-duplicate), and MS's and SM's payloads
	# legitimately recur. So this leg keeps the receiver's own generous default memory budget
	# (268435456, which this fixture's whole payload footprint never approaches) rather than
	# Q7e's tight one, and exercises only the carried-set growth check.
	if g6s_leg_wanted soak-inline; then
		echo "run-gate6: g6s: soak-inline (every payload inline, no eviction pressure)"
		g6s_leg soak-inline GRC_RESOURCE_INLINE_MAX_BYTES="$G6S_INLINE_MAX_BYTES" \
			GRC_RESOURCE_MAX_PAYLOAD_BYTES="$G6S_INLINE_MAX_BYTES" -- \
			RS_RECEIVER_MEMORY_BUDGET_BYTES=268435456
	fi

	if g6s_leg_wanted sabotage-soak-no-evict; then
		echo "run-gate6: g6s: sabotage-soak-no-evict (RS_RECEIVER_SABOTAGE=no-evict)"
		g6s_leg sabotage-soak-no-evict -- RS_RECEIVER_CACHE_DIR="$G6S/sabotage-soak-no-evict/receiver/cache" \
			RS_RECEIVER_CACHE_BUDGET_BYTES="$G6S_CACHE_BUDGET_BYTES" RS_RECEIVER_SABOTAGE=no-evict
	fi

	if g6s_leg_wanted sabotage-soak-retain-superseded; then
		echo "run-gate6: g6s: sabotage-soak-retain-superseded (GRC_SABOTAGE=retain-superseded)"
		g6s_leg sabotage-soak-retain-superseded GRC_SABOTAGE=retain-superseded GRC_SABOTAGE_FRAME=1 -- \
			RS_RECEIVER_CACHE_DIR="$G6S/sabotage-soak-retain-superseded/receiver/cache" \
			RS_RECEIVER_CACHE_BUDGET_BYTES="$G6S_CACHE_BUDGET_BYTES"
	fi

	# G7k (gsw only: RS_RECEIVER_SABOTAGE=leak-gl-textures has no effect on the native receiver,
	# and run-gate7.sh never selects this leg for a web-core run). The memory budget still
	# applies, unrelated: the leak is a throwaway WebGL context gsw-receiver's gl-leak.ts owns.
	if g6s_leg_wanted sabotage-leak-gl-textures; then
		echo "run-gate6: g6s: sabotage-leak-gl-textures (RS_RECEIVER_SABOTAGE=leak-gl-textures)"
		g6s_leg sabotage-leak-gl-textures -- RS_RECEIVER_SABOTAGE=leak-gl-textures
	fi

	HEADLESS_TIMEOUT_S="$old_headless"
	RENDERED_TIMEOUT_S="$old_rendered"

	gs_teardown "$OUT/gamescope-g6s"
	GS_RUN_DIR=""
}

# g6b runs after g6a and g6h whatever order --legs names them in; g6s and g6p have no cross-group
# dependency, so each just runs wherever it falls in this fixed order (last is fine).
for group in g6a g6h g6l g6b g6s g6c g6p; do
	case " ${GROUPS_RUN[*]} " in
	*" $group "*) ;;
	*) continue ;;
	esac
	# g6l, g6s, g6c and g6p are timing groups (lib/legs.sh): each live leg (and g6p's unarmed and
	# armed-idle repeats) holds the exclusive quiet lock from its host's start to its finish_bg;
	# their imports and reference renders stay shared.
	case "$group" in
	g6l | g6s | g6c | g6p) LEGS_TIMING_GROUP="$group" ;;
	*) LEGS_TIMING_GROUP="" ;;
	esac
	case "$group" in
	g6a) run_g6a ;;
	g6h) run_g6h ;;
	g6l) run_g6l ;;
	g6b) run_g6b ;;
	g6s) run_g6s ;;
	g6c) run_g6c ;;
	g6p)
		if [ -n "${G7P_MATRIX:-}" ]; then run_g7p; else run_g6p; fi
		;;
	esac
	LEGS_TIMING_GROUP=""
done

# G7u: a lifecycle-only run (G7U_LEGS, --legs g6l) has none of g6l's own legs, so check-gate6's
# g6l verdict would only report them missing; check-gate7.ts --live --legs g7-lc judges it.
if [ -n "$G7U_LEGS" ] && [ "${GROUPS_RUN[*]}" = "g6l" ]; then
	echo "run-gate6: G7U_LEGS: check-gate6 skipped (check-gate7.ts --live --legs g7-lc judges the lifecycle legs)"
	legs_quiet_summary
	exit 0
fi
# G7k: a startup-only run (G7K_STARTUP_LEGS, --legs g6l) shoots nothing and has none of g6l's own
# legs; check-gate7.ts --live --legs g7-k reads each leg's timings.json instead.
if [ -n "$G7K_STARTUP_LEGS" ] && [ "${GROUPS_RUN[*]}" = "g6l" ]; then
	echo "run-gate6: G7K_STARTUP_LEGS: check-gate6 skipped (check-gate7.ts --live --legs g7-k judges the startup legs)"
	legs_quiet_summary
	exit 0
fi

# G7v: a g7-dev run (G6C_LEGS naming only dev-* legs, --legs g6c) has none of g6c's own legs;
# check-gate7.ts --live --legs g7-dev judges it.
if [ -n "${G6C_LEGS:-}" ] && [ "${GROUPS_RUN[*]}" = "g6c" ] && ! printf '%s\n' ${G6C_LEGS//,/ } | grep -qv '^dev-'; then
	echo "run-gate6: G6C_LEGS: dev legs only; check-gate6 skipped (check-gate7.ts --live --legs g7-dev judges them)"
	legs_quiet_summary
	exit 0
fi

# G7p: a browser (or native /7) matrix run; check-gate7.ts --live --legs g7-p builds and judges its
# render-stream-report/2 (check-gate6's g6p verdict is gate 6's native /6 matrix).
if [ -n "${G7P_MATRIX:-}" ] && [ "${GROUPS_RUN[*]}" = "g6p" ]; then
	echo "run-gate6: G7P_MATRIX: check-gate6 skipped (check-gate7.ts --live --legs g7-p judges the matrix)"
	legs_quiet_summary
	exit 0
fi

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate6: running checker"
cd "$REPO_ROOT"
# The checker only reads files, but it is heavy: it holds the shared quiet lock (lib/legs.sh),
# then the run's lock summary is written.
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate6.ts" --out "$OUT"
