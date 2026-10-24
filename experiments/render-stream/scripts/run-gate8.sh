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
#       G8kw adds, headless: workers/capture (capture/ again under GRC_TEXTURE_WORKERS=2 with every
#       copy on a worker and each job delayed, so publication is held back) and its fault leg
#       workers/sabotage-publish-before-ready/capture; and, in the timing group,
#       decode-cost/capture-workers (the cost textures at 2 workers: the calling thread's hook_ns).
#   g8a (G8a, Q2: arm-time adoption of canvases, layers and items, fixtures/gate8-adopt; every leg
#       under g8a/): the editor import of the fixture and the receiver; headless /8 captures under
#       GRC_UNKNOWN_ITEM=skip of `born` (main scene born.tscn, armed in the loader's _enter_tree:
#       every object created armed), `born-adopt` (the same with GRC_ADOPT=arm: nothing to adopt),
#       `late` (adopt.tscn as the main scene, armed at fixture frame K=12 with GRC_ADOPT=arm) and
#       `late-strict` (late without skip: the residue's pre-existing-object), `late-thread` (late,
#       loaded from a worker thread: the stream refuses adopt-thread), and the three walk
#       sabotages (adopt-skip-state, adopt-no-redraw, adopt-skip-layers); then, rendered, the
#       unarmed `reference` and the native receiver on born, late (full and patch sinks) and each
#       sabotage capture, shooting the four checkpoints. G8r (D6, D7: pre-arm textures, meshes and
#       glyph atlases adopted lazily) extends the same group: the sources step (make_sources.gd
#       writes the two imported textures), GRC_TEXTURE_DECODE=engine on every capture,
#       `late-workers` (late at GRC_TEXTURE_WORKERS=2, every copy on a delayed worker) and the
#       three GRC_ADOPT_FAULT captures (no-resources, atlas-from-dummy, claim-current), the first
#       two also through the receiver.
#   g8h (G8h, Q4: the presentation size at a late arm, fixtures/gate8-size; every leg under g8h/):
#       the fixture and receiver imports; headless /8 captures under GRC_UNKNOWN_ITEM=skip of `born`
#       (armed at birth, GRC_ROOT_SIZE=presentation:640x360), `late` (armed at frame K=12 with
#       GRC_ADOPT=arm and the same policy: the 64x64 host is resized after adoption),
#       `late-observe` (late without the policy: the degenerate control) and the sabotage
#       size-before-adopt under skip and under strict; then, rendered at 640x360, the unarmed
#       `reference` the native receiver on born, late (full and patch sinks), the sabotage and the observe control.
#   g8f (G8f, D9: float texture payloads end to end, fixtures/gate8-tex's gate8_float scene; every leg
#       under g8f/): STS2's small curve, gradient and loader-thread image textures as shader inputs.
#       The import (shared with g8t), then headless /8 captures under GRC_TEXTURE_DECODE=engine with
#       every float format in GRC_RESOURCE_FORMATS (`capture`, both sinks and the store), the same
#       with every copy on a texture worker (`workers/capture`), the default-formats control
#       (`capture-default`: floats stay refused), a /6 sink asking for floats (`refused-v6`) and the
#       perturb-decode sabotage; then, rendered, the `reference` (the hdr textures as the fixture's own
#       headless Image.decompress wrote them) and the native receiver on the full sink, the patch sink and the
#       sabotage capture.
#   g8m (G8m, Q5, D11, D12: pre-arm materials and shaders, fixtures/gate8-mat; every leg under g8m/):
#       the fixture and receiver imports; headless /8 captures under GRC_UNKNOWN_ITEM=skip of `born`
#       (main scene born.tscn, armed in the loader's _enter_tree) and `late` (mat.tscn armed at
#       K=12 with GRC_ADOPT=arm: its ShaderMaterials, CanvasItemMaterials, shaders, a texture
#       parameter, a shader default texture and an instance parameter are adopted at arm or at the
#       next frame boundary), the two Q5 sabotages (adopt-raw-shader-code, adopt-skip-params) and
#       the GRC_ADOPT_FAULT=no-include-path capture (the typed shader-adopt-include); then, rendered,
#       the unarmed `reference` with gate 5.5's material oracle (RS_FIXTURE_MATERIAL_LOG) and the
#       native receiver on born, late (full and patch sinks) and the no-include-path capture.
#   g8kp (G8kp, texture-delivery-design.md D1 `passthrough`, D3; fixtures/gate8-tex; every leg
#       under g8kp/): the import and oracle (shared with g8t when both run; the oracle also writes
#       each .ctex's block bytes as <name>.<family>.block.grt1), then headless /9 captures under
#       GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=passthrough (`capture`, full and patch
#       sinks and the store), the same at GRC_TEXTURE_WORKERS=2 (`workers/capture`: the block
#       variant hashed on the worker) and `refused-basis/capture` (basis-uastc at /9: the typed
#       refusal); then, rendered, `reference` and `reference-hw` (as g8t's) and the native receiver
#       on the full sink (`receiver`, default texture_encodings block,decoded with the GPU's
#       families), the patch sink (`receiver-patch`) and with s3tc,bptc,rgtc masked
#       (`receiver-masked`); last, in headless Chromium, the GSW receiver on the same recording
#       (`gsw`), with s3tc,bptc,rgtc masked (`gsw-masked`) and the ignore-format-mask sabotage
#       (`sabotage-ignore-format-mask/gsw`: the mask stated, not applied), through
#       gate8-delivery-tool.ts (the rs-core wasm and the GSW bundle are built first).
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

# Groups whose increment has landed, in run order (G8r, G8m add theirs).
LANDED_GROUPS=(g8t g8a g8h g8f g8m g8kp)
KNOWN_GROUPS=(g8t g8a g8h g8f g8m g8kp)

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
# G8kw (texture-delivery-design.md D11, Q7): the workers legs. Two workers take every copy
# (MIN_BYTES=0: the fixture's textures are 64x64), each job delayed so publication is held back
# for several frames whatever the machine's speed; worker-states-equal compares the result with
# capture/, frame by frame. The cost leg keeps the default threshold (its textures are 2048x2048).
G8T_WORKERS_ENV=(GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0 GRC_TEXTURE_WORKER_DELAY_MS=8)

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

# run_cost_capture_workers <dir>: the decode-cost capture at GRC_TEXTURE_WORKERS=2 (G8kw): the
# hook log's hook_ns is the calling thread's whole share, decode/copy/hash the worker's.
run_cost_capture_workers() {
	local dir="$1"
	mkdir -p "$dir"
	cat /proc/loadavg >"$dir/loadavg.txt" 2>/dev/null || true
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" GRC_TEXTURE_WORKERS=2 RS_FIXTURE_VARIANT=cost
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

	echo "run-gate8: workers/capture (GRC_TEXTURE_WORKERS=2, every copy on a worker, held back)"
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" "${G8T_WORKERS_ENV[@]}"
		RS_FIXTURE_TEXTURE_LOG="$OUT/workers/capture/textures.jsonl")
	run_capture "$OUT/workers/capture" "" none

	echo "run-gate8: workers/sabotage-publish-before-ready (capture, the hold-back's fault knob)"
	CAPTURE_EXTRA_ENV=("${G8T_DECODE_ENV[@]}" "${G8T_WORKERS_ENV[@]}"
		GRC_TEXTURE_WORKER_FAULT=publish-before-ready
		RS_FIXTURE_TEXTURE_LOG="$OUT/workers/sabotage-publish-before-ready/capture/textures.jsonl")
	run_capture "$OUT/workers/sabotage-publish-before-ready/capture" "" none

	# G8k9 (texture-delivery-design.md D4, Q5): the same fixture through a /9 file sink with the delivery
	# mode declared. Mode rgba offers no variant (G8kp: the Basis modes G8k9 declared here are
	# refused now, g8kp/refused-basis), so the result must be the /8 capture's, state for state,
	# with `variants: []` on every ok image and the session naming the mode.
	echo "run-gate8: delivery9/capture (GRC_STREAM_VERSION=9, GRC_TEXTURE_DELIVERY=rgba: no variant)"
	RECORDING_NAME=recording.rs9
	PATCH_RECORDING_NAME=recording-patch.rs9
	CAPTURE_EXTRA_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=rgba
		RS_FIXTURE_TEXTURE_LOG="$OUT/delivery9/capture/textures.jsonl")
	run_capture "$OUT/delivery9/capture" "" none
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8

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
	if ! legs_skip_group decode-cost "$OUT/decode-cost/oracle-timing" "$OUT/decode-cost/capture" \
		"$OUT/decode-cost/capture-workers"; then
		echo "run-gate8: decode-cost/oracle-timing (best-of-3 Image.decompress, 2048x2048)"
		timing_leg g8t-decode-cost-oracle run_oracle "$OUT/decode-cost/oracle-timing" 1
		echo "run-gate8: decode-cost/capture (the hook's decode, copy and hash on the cost textures)"
		timing_leg g8t-decode-cost-capture run_cost_capture "$OUT/decode-cost/capture"
		echo "run-gate8: decode-cost/capture-workers (the same at GRC_TEXTURE_WORKERS=2: hook_ns)"
		timing_leg g8t-decode-cost-workers run_cost_capture_workers "$OUT/decode-cost/capture-workers"
	fi
}

# ------------------------------------------------------------------------------------- g8a
G8A_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-adopt"
# The fixture's arm frame K (fixtures/gate8-adopt/loader.gd, expected.json arm_frame).
G8A_ARM_FRAME=12
# Every g8a capture: a /8 file sink (D2), the product's unknown-item policy (skip) and host decode
# (G8r: the VRAM-compressed pre-arm texture is adopted through G8t's decode), so born and late
# differ only by when they armed.
G8A_ENV=(GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip GRC_TEXTURE_DECODE=engine)
# G8r: the lazy-adoption fault knobs (GRC_ADOPT_FAULT, rs_adopt.h); the receiver runs on the two
# whose pixels differ (claim-current changes only the declaration).
G8R_FAULTS=(no-resources atlas-from-dummy claim-current)
G8R_FAULTS_RENDERED=(no-resources atlas-from-dummy)

run_import_g8a() {
	echo "run-gate8: g8a import (sources, fixture, receiver)"
	LEG_ENV=()
	run_headless "$OUT/g8a/import/sources" none -- mise exec -- godot --headless --path "$G8A_FIXTURE_DIR" --script res://make_sources.gd
	LEG_ENV=()
	run_headless "$OUT/g8a/import/fixture" none -- mise exec -- godot --headless --path "$G8A_FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$OUT/g8a/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	local leg
	for leg in sources fixture receiver; do
		if [ "$(cat "$OUT/g8a/import/$leg/exit-code.txt")" != "0" ]; then
			echo "run-gate8: g8a import ($leg) failed, see $OUT/g8a/import/$leg/stdout.log" >&2
			exit 1
		fi
	done
}

# run_capture_g8a <dir> <born|late|thread> <env word...>: a headless capture of the fixture, armed
# at birth (main scene res://born.tscn) or late (adopt.tscn at frame K, from the main thread or a
# worker thread), with the probe log beside it.
run_capture_g8a() {
	local dir="$1" arm="$2" scene=""
	shift 2
	[ "$arm" = born ] && scene="res://born.tscn"
	mkdir -p "$dir"
	CAPTURE_FIXTURE_DIR="$G8A_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=("$@" RS_FIXTURE_ARM="$arm" RS_FIXTURE_ARM_FRAME="$G8A_ARM_FRAME"
		RS_FIXTURE_PROBE_LOG="$dir/probe.jsonl")
	run_capture "$dir" "" none "$scene"
}

run_g8a() {
	run_import_g8a
	echo "run-gate8: g8a born (armed at birth, every object created under the hooks)"
	run_capture_g8a "$OUT/g8a/born/capture" born "${G8A_ENV[@]}"
	echo "run-gate8: g8a born-adopt (GRC_ADOPT=arm at birth: nothing to adopt)"
	run_capture_g8a "$OUT/g8a/born-adopt/capture" born "${G8A_ENV[@]}" GRC_ADOPT=arm
	echo "run-gate8: g8a late (armed at frame $G8A_ARM_FRAME, GRC_ADOPT=arm)"
	run_capture_g8a "$OUT/g8a/late/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm
	echo "run-gate8: g8a late-strict (late, GRC_UNKNOWN_ITEM unset: the residue fails)"
	run_capture_g8a "$OUT/g8a/late-strict/capture" late GRC_STREAM_VERSION=8 GRC_ADOPT=arm
	echo "run-gate8: g8a late-thread (late, armed from a worker thread: adopt-thread)"
	run_capture_g8a "$OUT/g8a/late-thread/capture" thread "${G8A_ENV[@]}" GRC_ADOPT=arm
	echo "run-gate8: g8a late-workers (late at GRC_TEXTURE_WORKERS=2: adopted textures on workers)"
	run_capture_g8a "$OUT/g8a/late-workers/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm "${G8T_WORKERS_ENV[@]}"
	local s
	for s in adopt-skip-state adopt-no-redraw adopt-skip-layers; do
		echo "run-gate8: g8a sabotage-$s (capture)"
		run_capture_g8a "$OUT/g8a/sabotage-$s/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm \
			GRC_SABOTAGE="$s" GRC_SABOTAGE_FRAME="$G8A_ARM_FRAME"
	done
	for s in "${G8R_FAULTS[@]}"; do
		echo "run-gate8: g8a fault-$s (capture, GRC_ADOPT_FAULT)"
		run_capture_g8a "$OUT/g8a/fault-$s/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm GRC_ADOPT_FAULT="$s"
	done

	echo "run-gate8: bringing up private gamescope for g8a's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8a"
	legs_par_begin
	echo "run-gate8: g8a reference (unarmed, rendered)"
	mkdir -p "$OUT/g8a/reference/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$OUT/g8a/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/g8a/reference/steps.jsonl"
		RS_FIXTURE_ARM_FRAME="$G8A_ARM_FRAME")
	run_rendered "$OUT/g8a/reference" "$G8A_FIXTURE_DIR"
	echo "run-gate8: g8a receivers (born, late, late patch sink)"
	run_rendered_receiver "$OUT/g8a/born/capture" "$OUT/g8a/born/receiver"
	run_rendered_receiver "$OUT/g8a/late/capture" "$OUT/g8a/late/receiver"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/g8a/late/capture" "$OUT/g8a/late/receiver-patch"
	for s in adopt-skip-state adopt-no-redraw adopt-skip-layers; do
		echo "run-gate8: g8a sabotage-$s (receiver)"
		run_rendered_receiver "$OUT/g8a/sabotage-$s/capture" "$OUT/g8a/sabotage-$s/receiver"
	done
	for s in "${G8R_FAULTS_RENDERED[@]}"; do
		echo "run-gate8: g8a fault-$s (receiver)"
		run_rendered_receiver "$OUT/g8a/fault-$s/capture" "$OUT/g8a/fault-$s/receiver"
	done
	legs_par_end
	gs_teardown "$OUT/gamescope-g8a"
	GS_RUN_DIR=""
}

# ------------------------------------------------------------------------------------- g8h
G8H_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-size"
# The fixture's arm frame K (fixtures/gate8-size/loader.gd, expected.json arm_frame).
G8H_ARM_FRAME=12
G8H_ENV=(GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip GRC_ROOT_SIZE=presentation:640x360)

run_import_g8h() {
	echo "run-gate8: g8h import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$OUT/g8h/import/fixture" none -- mise exec -- godot --headless --path "$G8H_FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$OUT/g8h/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	local leg
	for leg in fixture receiver; do
		if [ "$(cat "$OUT/g8h/import/$leg/exit-code.txt")" != "0" ]; then
			echo "run-gate8: g8h import ($leg) failed, see $OUT/g8h/import/$leg/stdout.log" >&2
			exit 1
		fi
	done
}

# run_capture_g8h <dir> <born|late> <env word...>: a headless capture of the fixture (64x64 host
# window), armed at birth (main scene res://born.tscn) or late (size.tscn at frame K), with the
# fixture's own size probe beside it.
run_capture_g8h() {
	local dir="$1" arm="$2" scene=""
	shift 2
	[ "$arm" = born ] && scene="res://born.tscn"
	mkdir -p "$dir"
	CAPTURE_FIXTURE_DIR="$G8H_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=("$@" RS_FIXTURE_ARM="$arm" RS_FIXTURE_ARM_FRAME="$G8H_ARM_FRAME"
		RS_FIXTURE_SIZE_LOG="$dir/size.jsonl")
	run_capture "$dir" "" none "$scene"
}

run_g8h() {
	run_import_g8h
	echo "run-gate8: g8h born (presentation: armed at birth)"
	run_capture_g8h "$OUT/g8h/born/capture" born "${G8H_ENV[@]}"
	echo "run-gate8: g8h late (armed at frame $G8H_ARM_FRAME, GRC_ADOPT=arm, presentation:)"
	run_capture_g8h "$OUT/g8h/late/capture" late "${G8H_ENV[@]}" GRC_ADOPT=arm
	echo "run-gate8: g8h late-observe (late, no presentation policy: the degenerate control)"
	run_capture_g8h "$OUT/g8h/late-observe/capture" late GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip GRC_ADOPT=arm
	echo "run-gate8: g8h sabotage-size-before-adopt (skip)"
	run_capture_g8h "$OUT/g8h/sabotage-size-before-adopt/capture" late "${G8H_ENV[@]}" GRC_ADOPT=arm \
		GRC_SABOTAGE=size-before-adopt GRC_SABOTAGE_FRAME="$G8H_ARM_FRAME"
	echo "run-gate8: g8h sabotage-size-before-adopt-strict"
	run_capture_g8h "$OUT/g8h/sabotage-size-before-adopt-strict/capture" late GRC_STREAM_VERSION=8 \
		GRC_ROOT_SIZE=presentation:640x360 GRC_ADOPT=arm \
		GRC_SABOTAGE=size-before-adopt GRC_SABOTAGE_FRAME="$G8H_ARM_FRAME"

	echo "run-gate8: bringing up private gamescope for g8h's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8h"
	legs_par_begin
	echo "run-gate8: g8h reference (unarmed, rendered at 640x360)"
	mkdir -p "$OUT/g8h/reference/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$OUT/g8h/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/g8h/reference/steps.jsonl"
		RS_FIXTURE_ARM_FRAME="$G8H_ARM_FRAME")
	run_rendered "$OUT/g8h/reference" "$G8H_FIXTURE_DIR"
	echo "run-gate8: g8h receivers (born, late, late patch sink, sabotage, observe control)"
	run_rendered_receiver "$OUT/g8h/born/capture" "$OUT/g8h/born/receiver"
	run_rendered_receiver "$OUT/g8h/late/capture" "$OUT/g8h/late/receiver"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/g8h/late/capture" "$OUT/g8h/late/receiver-patch"
	run_rendered_receiver "$OUT/g8h/sabotage-size-before-adopt/capture" "$OUT/g8h/sabotage-size-before-adopt/receiver"
	run_rendered_receiver "$OUT/g8h/late-observe/capture" "$OUT/g8h/late-observe/receiver"
	legs_par_end
	gs_teardown "$OUT/gamescope-g8h"
	GS_RUN_DIR=""
}

# ------------------------------------------------------------------------------------- g8f
G8F_SCENE="res://gate8_float.tscn"
G8F_FLOATS=RF,RGF,RGBF,RGBAF,RH,RGH,RGBH,RGBAH
G8F_ENV=(GRC_STREAM_VERSION=8 GRC_TEXTURE_DECODE=engine
	"GRC_RESOURCE_FORMATS=L8,LA8,R8,RG8,RGB8,RGBA8,$G8F_FLOATS")

# run_capture_g8f <dir> <env word...>: a headless capture of the float scene, its texture log
# (the fixture's independent expected payloads) beside it.
run_capture_g8f() {
	local dir="$1"
	shift
	mkdir -p "$dir"
	CAPTURE_EXTRA_ENV=("$@" RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl" RS_FIXTURE_HDR_DUMP="$dir/hdr")
	run_capture "$dir" "" none "$G8F_SCENE"
}

run_g8f() {
	# the hdr textures need the editor import (g8t's), once per out dir
	if [ ! -f "$OUT/import/fixture/exit-code.txt" ]; then
		run_import_g8t
	fi
	echo "run-gate8: g8f capture (/8, decode engine, every float format permitted)"
	run_capture_g8f "$OUT/g8f/capture" "${G8F_ENV[@]}"
	echo "run-gate8: g8f workers/capture (the same, every copy on a texture worker, held back)"
	run_capture_g8f "$OUT/g8f/workers/capture" "${G8F_ENV[@]}" "${G8T_WORKERS_ENV[@]}"
	echo "run-gate8: g8f capture-default (/8, decode engine, default formats: floats stay refused)"
	run_capture_g8f "$OUT/g8f/capture-default" "${G8T_DECODE_ENV[@]}"
	echo "run-gate8: g8f refused-v6 (a /6 sink asking for float formats: policy-needs-v8)"
	RECORDING_NAME=recording.rs2
	PATCH_RECORDING_NAME=recording-patch.rs2
	run_capture_g8f "$OUT/g8f/refused-v6" "GRC_RESOURCE_FORMATS=L8,LA8,R8,RG8,RGB8,RGBA8,$G8F_FLOATS"
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8
	echo "run-gate8: g8f sabotage-perturb-decode (capture, from frame 1)"
	run_capture_g8f "$OUT/g8f/sabotage-perturb-decode/capture" "${G8F_ENV[@]}" \
		GRC_SABOTAGE=perturb-decode GRC_SABOTAGE_FRAME=1

	echo "run-gate8: bringing up private gamescope for g8f's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8f"
	legs_par_begin
	echo "run-gate8: g8f reference (hdr decompressed by the fixture, plain textures)"
	mkdir -p "$OUT/g8f/reference/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$OUT/g8f/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/g8f/reference/steps.jsonl"
		RS_FIXTURE_TEXTURE_LOG="$OUT/g8f/reference/textures.jsonl" RS_FIXTURE_SOURCE=decoded
		RS_FIXTURE_DECODED_DIR="$OUT/g8f/capture/hdr")
	RENDERED_EXTRA_ARGS=("$G8F_SCENE")
	run_rendered "$OUT/g8f/reference" "$FIXTURE_DIR"
	echo "run-gate8: g8f receiver"
	run_rendered_receiver "$OUT/g8f/capture" "$OUT/g8f/receiver"
	echo "run-gate8: g8f receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/g8f/capture" "$OUT/g8f/receiver-patch"
	echo "run-gate8: g8f sabotage-perturb-decode (receiver)"
	run_rendered_receiver "$OUT/g8f/sabotage-perturb-decode/capture" "$OUT/g8f/sabotage-perturb-decode/receiver"
	legs_par_end
	gs_teardown "$OUT/gamescope-g8f"
	GS_RUN_DIR=""
}

# ------------------------------------------------------------------------------------- g8m
G8M_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-mat"
# The fixture's arm frame K (gate8-adopt's loader, expected.json arm_frame).
G8M_ARM_FRAME=12
G8M_ENV=(GRC_STREAM_VERSION=8 GRC_UNKNOWN_ITEM=skip)

run_import_g8m() {
	echo "run-gate8: g8m import (fixture, receiver)"
	LEG_ENV=()
	run_headless "$OUT/g8m/import/fixture" none -- mise exec -- godot --headless --path "$G8M_FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$OUT/g8m/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	local leg
	for leg in fixture receiver; do
		if [ "$(cat "$OUT/g8m/import/$leg/exit-code.txt")" != "0" ]; then
			echo "run-gate8: g8m import ($leg) failed, see $OUT/g8m/import/$leg/stdout.log" >&2
			exit 1
		fi
	done
}

# run_capture_g8m <dir> <born|late> <env word...>: a headless capture of the fixture, armed at birth
# (main scene res://born.tscn) or late (mat.tscn at frame K).
run_capture_g8m() {
	local dir="$1" arm="$2" scene=""
	shift 2
	[ "$arm" = born ] && scene="res://born.tscn"
	mkdir -p "$dir"
	CAPTURE_FIXTURE_DIR="$G8M_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=("$@" RS_FIXTURE_ARM="$arm" RS_FIXTURE_ARM_FRAME="$G8M_ARM_FRAME")
	run_capture "$dir" "" none "$scene"
}

run_g8m() {
	run_import_g8m
	echo "run-gate8: g8m born (armed at birth, every material and shader created under the hooks)"
	run_capture_g8m "$OUT/g8m/born/capture" born "${G8M_ENV[@]}"
	echo "run-gate8: g8m late (armed at frame $G8M_ARM_FRAME, GRC_ADOPT=arm)"
	run_capture_g8m "$OUT/g8m/late/capture" late "${G8M_ENV[@]}" GRC_ADOPT=arm
	local s
	for s in adopt-raw-shader-code adopt-skip-params; do
		echo "run-gate8: g8m sabotage-$s (capture)"
		run_capture_g8m "$OUT/g8m/sabotage-$s/capture" late "${G8M_ENV[@]}" GRC_ADOPT=arm \
			GRC_SABOTAGE="$s" GRC_SABOTAGE_FRAME="$G8M_ARM_FRAME"
	done
	echo "run-gate8: g8m fault-no-include-path (capture, GRC_ADOPT_FAULT: the typed shader-adopt-include)"
	run_capture_g8m "$OUT/g8m/fault-no-include-path/capture" late "${G8M_ENV[@]}" GRC_ADOPT=arm \
		GRC_ADOPT_FAULT=no-include-path

	echo "run-gate8: bringing up private gamescope for g8m's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8m"
	legs_par_begin
	echo "run-gate8: g8m reference (unarmed, rendered, gate 5.5's material oracle)"
	mkdir -p "$OUT/g8m/reference/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$OUT/g8m/reference/shots" RS_FIXTURE_STEP_LOG="$OUT/g8m/reference/steps.jsonl"
		RS_FIXTURE_MATERIAL_LOG="$OUT/g8m/reference/materials.jsonl" RS_FIXTURE_ARM_FRAME="$G8M_ARM_FRAME")
	run_rendered "$OUT/g8m/reference" "$G8M_FIXTURE_DIR"
	echo "run-gate8: g8m receivers (born, late, late patch sink, fault-no-include-path)"
	run_rendered_receiver "$OUT/g8m/born/capture" "$OUT/g8m/born/receiver"
	run_rendered_receiver "$OUT/g8m/late/capture" "$OUT/g8m/late/receiver"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/g8m/late/capture" "$OUT/g8m/late/receiver-patch"
	run_rendered_receiver "$OUT/g8m/fault-no-include-path/capture" "$OUT/g8m/fault-no-include-path/receiver"
	legs_par_end
	gs_teardown "$OUT/gamescope-g8m"
	GS_RUN_DIR=""
}

# ------------------------------------------------------------------------------------ g8kp
# G8kp (texture-delivery-design.md D1, D3, Q3): `passthrough` at /9 end to end.
G8KP_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=passthrough)
# The families a desktop receiver masks to stand in for one without BC (the g31's view of BC).
G8KP_MASK="s3tc,bptc,rgtc"

# run_g8kp_live: g8kp/live/{host,receiver} (inside g8kp's gamescope).
run_g8kp_live() {
	local host="$OUT/g8kp/live/host" receiver="$OUT/g8kp/live/receiver" waited=0 port=""
	mkdir -p "$host/evidence" "$receiver"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$host/evidence" GRC_STREAM_OUT="$host/$RECORDING_NAME"
		GRC_RESOURCE_STORE_DIR="$host/store" GRC_LIVE_LISTEN=127.0.0.1:0 "${G8KP_ENV[@]}"
		RS_FIXTURE_STEP_FRAMES=600 RS_FIXTURE_QUIT_FRAME=780 RS_FIXTURE_STEP_LOG="$host/steps.jsonl"
		RS_FIXTURE_TEXTURE_LOG="$host/textures.jsonl"
	)
	start_headless_bg "$host" -- "$BINARY" --headless --max-fps 60 --path "$FIXTURE_DIR"
	local pid="$BG_PID"
	while [ "$waited" -lt 400 ] && [ ! -s "$host/evidence/live.json" ] && kill -0 "$pid" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$host/evidence/live.json" 2>/dev/null; then
		port="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$host/evidence/live.json")"
	fi
	if [ -z "$port" ]; then
		echo "the live host is not listening (see g8kp/live/host/evidence/live.json)" >"$receiver/skipped.txt"
	else
		LEG_ENV=(
			RS_RECEIVER_MODE=live RS_RECEIVER_PROTOCOL=9 RS_RECEIVER_CREDIT_WINDOW=1
			RS_RECEIVER_URL="ws://127.0.0.1:$port/render-stream"
			RS_RECEIVER_OUT="$receiver/applied.json" RS_RECEIVER_CACHE_DIR="$receiver/cache"
		)
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$receiver" "$RECEIVER_DIR"
	fi
	finish_bg "$host" "$pid" "$HEADLESS_TIMEOUT_S"
}

run_g8kp() {
	if [ ! -f "$OUT/import/fixture/exit-code.txt" ]; then
		run_import_g8t
	fi
	if [ ! -f "$OUT/oracle/exit-code.txt" ]; then
		echo "run-gate8: oracle"
		run_oracle "$OUT/oracle"
	fi
	RECORDING_NAME=recording.rs9
	PATCH_RECORDING_NAME=recording-patch.rs9

	echo "run-gate8: g8kp capture (/9, GRC_TEXTURE_DELIVERY=passthrough)"
	CAPTURE_EXTRA_ENV=("${G8KP_ENV[@]}" RS_FIXTURE_TEXTURE_LOG="$OUT/g8kp/capture/textures.jsonl")
	run_capture "$OUT/g8kp/capture" "" none

	echo "run-gate8: g8kp workers/capture (the same at GRC_TEXTURE_WORKERS=2)"
	CAPTURE_EXTRA_ENV=("${G8KP_ENV[@]}" "${G8T_WORKERS_ENV[@]}"
		RS_FIXTURE_TEXTURE_LOG="$OUT/g8kp/workers/capture/textures.jsonl")
	run_capture "$OUT/g8kp/workers/capture" "" none

	echo "run-gate8: g8kp refused-basis/capture (GRC_TEXTURE_DELIVERY=basis-uastc at /9: refused)"
	CAPTURE_EXTRA_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=basis-uastc
		RS_FIXTURE_TEXTURE_LOG="$OUT/g8kp/refused-basis/capture/textures.jsonl")
	CAPTURE_WITH_PATCH=0
	run_capture "$OUT/g8kp/refused-basis/capture" "" none
	CAPTURE_WITH_PATCH=1

	echo "run-gate8: bringing up private gamescope for g8kp's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8kp"
	legs_par_begin
	echo "run-gate8: g8kp reference and reference-hw"
	run_reference_g8t "$OUT/g8kp/reference" decoded
	run_reference_g8t "$OUT/g8kp/reference-hw" ctex
	echo "run-gate8: g8kp receiver (block,decoded; the GPU's families)"
	run_rendered_receiver "$OUT/g8kp/capture" "$OUT/g8kp/receiver"
	echo "run-gate8: g8kp receiver-patch"
	RECEIVER_SOURCE="$PATCH_RECORDING_NAME"
	run_rendered_receiver "$OUT/g8kp/capture" "$OUT/g8kp/receiver-patch"
	echo "run-gate8: g8kp receiver-masked ($G8KP_MASK masked: decoded)"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_GPU_FORMAT_MASK="$G8KP_MASK")
	run_rendered_receiver "$OUT/g8kp/capture" "$OUT/g8kp/receiver-masked"
	legs_par_end

	# live: a /9 passthrough host serving the fixture (the desktop family current for 600 frames at
	# --max-fps 60) and the native receiver, rendered, joining with RS_RECEIVER_PROTOCOL=9: its hello
	# offers render-stream.9 with texture_encodings and gpu_formats, and the block variants it picks
	# are fetched over HTTP like any payload.
	echo "run-gate8: g8kp live (host /9 passthrough + rendered native receiver at RS_RECEIVER_PROTOCOL=9)"
	run_g8kp_live
	gs_teardown "$OUT/gamescope-g8kp"
	GS_RUN_DIR=""
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8

	# The GSW legs (headless Chromium, the repo-private pinned build): the native receiver leg's
	# own env and argv, replayed by the GSW receiver page (lib/gate7-web-legs.ts).
	echo "run-gate8: g8kp gsw legs (gsw, gsw-masked, sabotage-ignore-format-mask/gsw)"
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
		"$SCRIPT_DIR/gate8-delivery-tool.ts" gsw-legs --source "$OUT" --mask "$G8KP_MASK") \
		>"$OUT/g8kp/gsw-legs.log" 2>&1 || echo "run-gate8: g8kp gsw legs failed, see $OUT/g8kp/gsw-legs.log" >&2
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g8kp) run_g8kp ;;
	g8t) run_g8t ;;
	g8f) run_g8f ;;
	g8a) run_g8a ;;
	g8h) run_g8h ;;
	g8m) run_g8m ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate8: running checker"
cd "$REPO_ROOT"
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate8.ts" --out "$OUT"
