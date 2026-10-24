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
#       variant hashed on the worker) and `refused-basis/capture` (basis-etc1s at /9, since G8ku:
#       the typed refusal); then, rendered, `reference` and `reference-hw` (as g8t's) and the native receiver
#       on the full sink (`receiver`, default texture_encodings block,decoded with the GPU's
#       families), the patch sink (`receiver-patch`) and with s3tc,bptc,rgtc masked
#       (`receiver-masked`); last, in headless Chromium, the GSW receiver on the same recording
#       (`gsw`), with s3tc,bptc,rgtc masked (`gsw-masked`) and the ignore-format-mask sabotage
#       (`sabotage-ignore-format-mask/gsw`: the mask stated, not applied), through
#       gate8-delivery-tool.ts (the rs-core wasm and the GSW bundle are built first).
#   g8kc (G8kc, texture-delivery-design.md D7-D10: the persisted host texture cache, the prepare step
#       and the texture_set_path hook; fixtures/gate8-tex; every leg under g8kc/, all headless): the
#       import and oracle (shared), then /9 passthrough captures with GRC_TEXTURE_DECODE=engine:
#       `off/capture` (no cache directory: the control), `cold/capture` (an empty cache directory:
#       every decode is derived and stored), `warm/capture` (the same directory, a second session),
#       `warm-workers/capture` (the same at GRC_TEXTURE_WORKERS=2), `prepare/` (scripts/prepare-
#       textures.sh over the fixture's imported .ctex files into a second, empty directory) and
#       `prepared/capture` (a session on that directory), `bounded/capture` (a byte budget) and
#       `sabotage-corrupt/{capture,after/capture}` (a copy of the warm cache with a flipped byte, a
#       truncated file and a deleted file, then the session after the repair), and (G8ku)
#       `uastc-cold/capture` and `uastc-warm/capture` (fixtures/gate8-basis under basis-uastc twice
#       on one directory: the second session runs zero UASTC encodes). The cache
#       directories live under $XDG_CACHE_HOME (or ~/.cache) and are removed at exit.
#   g8l (G8g, D14: render-stream/8 live; every leg under g8l/<fixture>/): one live leg per fixture
#       (tex, float, adopt, size, mat), each a headless live host with its /8 file sink under the
#       fixture's gate 8 policy, a rendered live receiver at RS_RECEIVER_PROTOCOL=8 and the same
#       receiver replaying the host's file sink; plus `proxy` (tex through lib/reverse-proxy.ts, an
#       HTTP/1.1 reverse proxy: the WebSocket and every GET through a server in front of the
#       listener, D14). run-gate7.sh --live --legs g7-8 runs this group with a browser receiver.
#   g8ku (G8ku, texture-delivery-design.md D6, D12, D14, D16 `basis-uastc`; fixtures/gate8-basis;
#       every leg under g8ku/): the fixture import; headless /9 captures under
#       GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=basis-uastc GRC_TEXTURE_ENCODE_WAIT_FRAME=12
#       (`capture`: the lazy uastc variants publish at frame 12, full and patch sinks and the store),
#       the same at GRC_TEXTURE_WORKERS=2 (`workers/capture`) and with GRC_TEXTURE_ENCODE_FAULT=
#       perturb-ktx2 (`sabotage-perturb-ktx2/capture`); then, rendered, `reference`
#       (the procedural fixture), `reference-oracle` (every stored KTX2 through
#       Image.load_ktx_from_buffer on this GPU: oracle.json, the CPU decodes, and from step 1 the
#       uastc textures drawn from them), `reference-oracle-hw` (the same drawing the oracle's
#       transcoded blocks, sampled by the GPU), the native receiver with `keep` (`receiver`),
#       `upgrade` (`receiver-upgrade`, transcodes hashed) and on the perturbed store
#       (`sabotage-perturb-ktx2/receiver`, which must refuse), and `live/{host,receiver}` (a /9
#       basis-uastc host without the wait knob, the receiver at RS_RECEIVER_PROTOCOL=9, and a GET of
#       one KTX2 with Accept-Encoding: zstd, `live/host/ktx2-get.*`); last, in headless Chromium,
#       the web export on `receiver-upgrade`'s own launch (`g8ku-web/web`, beside g8ku/) through
#       gate8-delivery-tool.ts web-legs.
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
LANDED_GROUPS=(g8t g8a g8h g8f g8m g8kp g8ku g8kc g8l)
KNOWN_GROUPS=(g8t g8a g8h g8f g8m g8kp g8ku g8kc g8l)

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
	if [ -n "${G8KC_CACHE_ROOT:-}" ]; then
		rm -rf "$G8KC_CACHE_ROOT"
	fi
	if declare -F legs_par_cleanup >/dev/null; then
		legs_par_cleanup
	fi
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		echo "run-gate8: stopping owned process $CURRENT_CHILD_PID" >&2
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	# G8g: g8l's own reverse proxy and live host, when a leg was interrupted
	if [ -n "${PROXY_PID:-}" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
		kill "$PROXY_PID" 2>/dev/null || true
	fi
	if [ -n "${LIVE_HOST_PID:-}" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; then
		kill "$LIVE_HOST_PID" 2>/dev/null || true
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
	# mode declared. Mode rgba offers no variant (basis-uastc is group g8ku's since G8ku, and
	# basis-etc1s is refused, g8kp/refused-basis), so the result must be the /8 capture's, state for state,
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

	echo "run-gate8: g8kp refused-basis/capture (GRC_TEXTURE_DELIVERY=basis-etc1s at /9: refused)"
	CAPTURE_EXTRA_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=basis-etc1s
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

# ------------------------------------------------------------------------------------ g8kc
# G8kc (texture-delivery-design.md D7-D10): the persisted cache, the prepare step, the path hook.
G8KC_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=passthrough)
# Bound for the byte-budget leg: well under the fixture's decoded payloads (~190 kB).
G8KC_BOUND_BYTES=60000
G8KC_CACHE_ROOT=""

# run_g8kc_capture <dir> <cache dir or ""> [extra env words]: one headless capture, /9 passthrough.
run_g8kc_capture() {
	local dir="$1" cache="$2"
	shift 2
	mkdir -p "$dir"
	CAPTURE_EXTRA_ENV=("${G8KC_ENV[@]}" RS_FIXTURE_TEXTURE_LOG="$dir/textures.jsonl" "$@")
	if [ -n "$cache" ]; then
		CAPTURE_EXTRA_ENV+=(GRC_TEXTURE_CACHE_DIR="$cache")
	fi
	CAPTURE_WITH_PATCH=0
	run_capture "$dir" "" none
	CAPTURE_WITH_PATCH=1
}

# g8kc_keep_index <cache> <dir>: the cache's index and file listing, kept as evidence.
g8kc_keep_index() {
	local cache="$1" dir="$2"
	mkdir -p "$dir"
	cp "$cache/index-v1.jsonl" "$dir/index-v1.jsonl" 2>/dev/null || : >"$dir/index-v1.jsonl"
	(cd "$cache/sha256" 2>/dev/null && ls -l --time-style=+ . | sed '1d') >"$dir/files.txt" || : >"$dir/files.txt"
}

run_g8kc() {
	if [ ! -f "$OUT/import/fixture/exit-code.txt" ]; then
		run_import_g8t
	fi
	if [ ! -f "$OUT/oracle/exit-code.txt" ]; then
		echo "run-gate8: oracle"
		run_oracle "$OUT/oracle"
	fi
	RECORDING_NAME=recording.rs9
	PATCH_RECORDING_NAME=recording-patch.rs9
	local K="$OUT/g8kc"
	mkdir -p "$K"
	# Never inside a repository: a private directory under the user's cache.
	mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/godot-render-stream"
	G8KC_CACHE_ROOT="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/godot-render-stream/g8kc.XXXXXX")"
	local C="$G8KC_CACHE_ROOT"

	echo "run-gate8: g8kc off/capture (no cache directory: the control)"
	run_g8kc_capture "$K/off/capture" ""
	echo "run-gate8: g8kc cold/capture (an empty cache)"
	run_g8kc_capture "$K/cold/capture" "$C/main"
	g8kc_keep_index "$C/main" "$K/cold/cache"
	echo "run-gate8: g8kc warm/capture (the same cache, a second session)"
	run_g8kc_capture "$K/warm/capture" "$C/main"
	g8kc_keep_index "$C/main" "$K/warm/cache"
	echo "run-gate8: g8kc warm-workers/capture (the same at GRC_TEXTURE_WORKERS=2)"
	run_g8kc_capture "$K/warm-workers/capture" "$C/main" "${G8T_WORKERS_ENV[@]}"

	# prepare: the fixture's imported .ctex files (the 64x64 set the scene loads, not the 2048x2048
	# cost textures) into a second, empty cache; prepared/capture then needs nothing derived.
	echo "run-gate8: g8kc prepare (scripts/prepare-textures.sh --list, into an empty cache)"
	mkdir -p "$K/prepare"
	find "$FIXTURE_DIR/.godot/imported" -maxdepth 1 -name '*.ctex' ! -name 'cost_*' | LC_ALL=C sort >"$K/prepare/list.txt"
	LEG_ENV=()
	run_headless "$K/prepare" none -- "$SCRIPT_DIR/prepare-textures.sh" --cache "$C/prepared" \
		--list "$K/prepare/list.txt" --out "$K/prepare/out" --binary "$BINARY" \
		--extension "$EXTENSION" --calibration "$CALIBRATION"
	g8kc_keep_index "$C/prepared" "$K/prepare/cache"
	echo "run-gate8: g8kc prepared/capture (a session on the prepared cache)"
	run_g8kc_capture "$K/prepared/capture" "$C/prepared"

	echo "run-gate8: g8kc bounded/capture (GRC_TEXTURE_CACHE_MAX_BYTES=$G8KC_BOUND_BYTES)"
	run_g8kc_capture "$K/bounded/capture" "$C/bounded" GRC_TEXTURE_CACHE_MAX_BYTES="$G8KC_BOUND_BYTES"
	g8kc_keep_index "$C/bounded" "$K/bounded/cache"

	# sabotage-corrupt: a copy of the warm cache with three files damaged. The session must detect
	# the two that no longer match their names (never serving them), derive and store the three
	# again, and the session after it must find the repaired cache clean.
	echo "run-gate8: g8kc sabotage-corrupt (a flipped byte, a truncated file, a deleted file)"
	cp -a "$C/main" "$C/corrupt"
	local -a files
	mapfile -t files < <(find "$C/corrupt/sha256" -name '*.grt' | LC_ALL=C sort | head -3)
	mkdir -p "$K/sabotage-corrupt"
	if [ "${#files[@]}" -eq 3 ]; then
		printf '\377' | dd of="${files[0]}" bs=1 seek=40 conv=notrunc status=none
		truncate -s 10 "${files[1]}"
		rm -f "${files[2]}"
		printf '{"flipped": "%s", "truncated": "%s", "deleted": "%s"}\n' \
			"$(basename "${files[0]}" .grt)" "$(basename "${files[1]}" .grt)" \
			"$(basename "${files[2]}" .grt)" >"$K/sabotage-corrupt/damaged.json"
		cp "$C/corrupt/index-v1.jsonl" "$K/sabotage-corrupt/index-before.jsonl"
	fi
	run_g8kc_capture "$K/sabotage-corrupt/capture" "$C/corrupt"
	g8kc_keep_index "$C/corrupt" "$K/sabotage-corrupt/cache"
	run_g8kc_capture "$K/sabotage-corrupt/after/capture" "$C/corrupt"

	# uastc-cold / uastc-warm (G8ku): fixtures/gate8-basis under basis-uastc (its lazy encodes
	# attached at the wait frame, so the cold session stores every one) twice on one directory: the
	# second session serves every UASTC variant from the cache and runs zero encodes.
	if [ ! -f "$OUT/g8ku/import/fixture/exit-code.txt" ]; then
		run_import_g8ku
	fi
	echo "run-gate8: g8kc uastc-cold / uastc-warm (UASTC encodes through the cache)"
	CAPTURE_WITH_PATCH=0
	run_capture_g8ku "$K/uastc-cold/capture" GRC_TEXTURE_CACHE_DIR="$C/uastc"
	g8kc_keep_index "$C/uastc" "$K/uastc-cold/cache"
	run_capture_g8ku "$K/uastc-warm/capture" GRC_TEXTURE_CACHE_DIR="$C/uastc"
	g8kc_keep_index "$C/uastc" "$K/uastc-warm/cache"
	CAPTURE_WITH_PATCH=1

	# adopt-cold / adopt-warm (D9a): a pre-arm VRAM-compressed texture (gate8-adopt's chip_bc), armed
	# late with GRC_ADOPT=arm at /8, goes through the same copy as any hooked texture, so the cache
	# serves its adoption on the second session. (/8: the adopt fixture's own policy, no delivery mode.)
	if [ ! -f "$OUT/g8a/import/fixture/exit-code.txt" ]; then
		run_import_g8a
	fi
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8
	echo "run-gate8: g8kc adopt-cold / adopt-warm (late adoption through the cache)"
	CAPTURE_WITH_PATCH=0
	run_capture_g8a "$K/adopt-cold/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm GRC_TEXTURE_CACHE_DIR="$C/adopt"
	run_capture_g8a "$K/adopt-warm/capture" late "${G8A_ENV[@]}" GRC_ADOPT=arm GRC_TEXTURE_CACHE_DIR="$C/adopt"
	CAPTURE_WITH_PATCH=1

	rm -rf "$G8KC_CACHE_ROOT"
	G8KC_CACHE_ROOT=""
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8
}

# ------------------------------------------------------------------------------------- g8l
# G8g (gate8-design.md "Increments" G8g, D14): one live leg per gate 8 fixture at render-stream/8,
# the host's file sink beside it, the same receiver replaying that sink, and D14's reverse-proxy
# leg. Every leg lives under g8l/<fixture>/ (host/, receiver/, replay/; proxy/ adds proxy/):
#   tex    gate8-tex's main scene under g8t's decode policy (GRC_TEXTURE_DECODE=engine)
#   float  gate8-tex's float scene under g8f's policy (every float format permitted)
#   adopt  gate8-adopt armed late at K (GRC_ADOPT=arm, skip, decode: G8a and G8r's lazy resources)
#   size   gate8-size armed late at K with presentation:640x360 (G8h)
#   mat    gate8-mat armed late at K (G8m's materials and shaders)
#   proxy  tex again, its receiver connected through scripts/lib/reverse-proxy.ts (an HTTP/1.1
#          reverse proxy forwarding the upgrade and every GET): D14 without a wire change
#   basis  G8kb: gate8-basis at render-stream/9 under g8ku's basis-uastc policy (no wait knob: the
#          lazy uastc variants publish when their encodes finish), the receiver and its replay at
#          RS_RECEIVER_PROTOCOL=9 with RS_RECEIVER_VARIANT_POLICY=upgrade, so the live /9 hello
#          states uastc and the variants are fetched and transcoded over HTTP (texture-delivery-
#          design.md Q3, Q6); its tap and sink are .rs9
# A host is the fixture headless at --max-fps 60 with its /8 file sink and store, a live listener
# on 127.0.0.1:0 (lib/legs.sh moves it to GATE7_HOST_PORT for a browser), and
# GRC_LIVE_AWAIT_HELLO_MS (its timeline waits at the first armed frame for the receiver's hello, so
# a slow browser misses nothing). It lingers to G8L_QUIT_FRAME so every payload GET is served
# before it ends. The live receiver is rendered at 640x360, speaks render-stream/8
# (RS_RECEIVER_PROTOCOL=8: a gate 8 policy host offers only .8) and shoots its final state after the
# end record (RS_RECEIVER_SHOT_FINAL=1); the replay is run_rendered_receiver on the host's own
# recording (its checkpoints). Under GATE7_LIVE_KIND (run-gate7.sh --live --legs g7-8) every
# receiver and replay is that browser. Correctness legs: the checks judge states and the final
# image, never cadence, so they hold no timing group natively.
G8L_FIXTURES=(tex float adopt size mat proxy basis)
# Every fixture's default quit is below 60 (tex/float S+N+11, adopt K+38, size K+26, mat K+24);
# at 60 fps the linger is about 4 s.
G8L_QUIT_FRAME=300
G8L_AWAIT_HELLO_MS=60000

# g8l_spec <fixture>: G8L_PROJECT, G8L_SCENE (empty: the project's main scene) and G8L_ENV (the
# host's policy and fixture words) for one fixture, from its file group's own captures.
g8l_spec() {
	G8L_SCENE=""
	G8L_VERSION=8
	G8L_RECEIVER_ENV=()
	case "$1" in
	tex | proxy)
		G8L_PROJECT="$FIXTURE_DIR"
		G8L_ENV=("${G8T_DECODE_ENV[@]}")
		;;
	float)
		G8L_PROJECT="$FIXTURE_DIR"
		G8L_SCENE="$G8F_SCENE"
		G8L_ENV=("${G8F_ENV[@]}")
		;;
	adopt)
		G8L_PROJECT="$G8A_FIXTURE_DIR"
		G8L_ENV=("${G8A_ENV[@]}" GRC_ADOPT=arm RS_FIXTURE_ARM=late RS_FIXTURE_ARM_FRAME="$G8A_ARM_FRAME")
		;;
	size)
		G8L_PROJECT="$G8H_FIXTURE_DIR"
		G8L_ENV=("${G8H_ENV[@]}" GRC_ADOPT=arm RS_FIXTURE_ARM=late RS_FIXTURE_ARM_FRAME="$G8H_ARM_FRAME")
		;;
	mat)
		G8L_PROJECT="$G8M_FIXTURE_DIR"
		G8L_ENV=("${G8M_ENV[@]}" GRC_ADOPT=arm RS_FIXTURE_ARM=late RS_FIXTURE_ARM_FRAME="$G8M_ARM_FRAME")
		;;
	basis)
		G8L_PROJECT="$G8KU_FIXTURE_DIR"
		G8L_ENV=("${G8KU_ENV[@]}")
		G8L_VERSION=9
		G8L_RECEIVER_ENV=(RS_RECEIVER_VARIANT_POLICY=upgrade RS_RECEIVER_TRANSCODE_LOG=1)
		;;
	esac
}

# start_g8l_host <dir> <fixture>: the fixture's live host in the background (header above); sets
# LIVE_HOST_PID and LIVE_PORT ("" when the host is not listening).
start_g8l_host() {
	local dir="$1" waited=0
	g8l_spec "$2"
	mkdir -p "$dir/evidence" "$dir/tap"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_OUT="$dir/recording.rs$G8L_VERSION"
		GRC_RESOURCE_STORE_DIR="$dir/store" GRC_LIVE_LISTEN=127.0.0.1:0 GRC_LIVE_TAP_DIR="$dir/tap"
		GRC_LIVE_AWAIT_HELLO_MS="$G8L_AWAIT_HELLO_MS"
		RS_FIXTURE_QUIT_FRAME="$G8L_QUIT_FRAME" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl" "${G8L_ENV[@]}"
	)
	local -a argv=("$BINARY" --headless --max-fps 60 --path "$G8L_PROJECT")
	[ -n "$G8L_SCENE" ] && argv+=("$G8L_SCENE")
	start_headless_bg "$dir" -- "${argv[@]}"
	LIVE_HOST_PID="$BG_PID"
	LIVE_PORT=""
	while [ "$waited" -lt 600 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$LIVE_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		LIVE_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate8: ${dir#"$OUT"/} listening on port ${LIVE_PORT:-<none>}"
}

# g8l_receiver <leg dir> <port>: the live receiver on 127.0.0.1:<port> (the host's, or the proxy's).
g8l_receiver() {
	local dir="$1/receiver" port="$2"
	mkdir -p "$dir"
	if [ -z "$port" ]; then
		echo "the live host (or its proxy) is not listening (see $1/host/evidence/live.json)" >"$dir/skipped.txt"
		echo "run-gate8: ${dir#"$OUT"/} skipped: nothing is listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$port/render-stream"
		RS_RECEIVER_PROTOCOL="$G8L_VERSION" "${G8L_RECEIVER_ENV[@]}"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_CACHE_DIR="$dir/cache" RS_RECEIVER_SHOT_FINAL=1
	)
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	run_rendered "$dir" "$RECEIVER_DIR"
}

# start_g8l_proxy <dir> <target port>: scripts/lib/reverse-proxy.ts in front of the host; sets
# PROXY_PID and PROXY_PORT ("" when it did not bind).
start_g8l_proxy() {
	local dir="$1" target="$2" waited=0
	mkdir -p "$dir"
	PROXY_PID=""
	PROXY_PORT=""
	[ -n "$target" ] || return 0
	(cd "$REPO_ROOT" && exec mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/reverse-proxy.ts" \
		--target-port "$target" --log "$dir/requests.jsonl" --stats-out "$dir/stats.json") \
		>"$dir/stdout.log" 2>"$dir/stderr.log" &
	local wrapper=$!
	while [ "$waited" -lt 600 ] && ! grep -q listening_port "$dir/stdout.log" 2>/dev/null && kill -0 "$wrapper" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	PROXY_PORT="$(sed -n 's/^{"listening_port":\([0-9][0-9]*\),.*$/\1/p' "$dir/stdout.log" | head -1)"
	PROXY_PID="$(sed -n 's/^.*"pid":\([0-9][0-9]*\)}.*$/\1/p' "$dir/stdout.log" | head -1)"
	printf '{"target_port": %s, "listen_port": %s}\n' "$target" "${PROXY_PORT:-null}" >"$dir/ports.json"
	echo "run-gate8: ${dir#"$OUT"/} reverse proxy on ${PROXY_PORT:-<none>} -> $target"
}

stop_g8l_proxy() {
	[ -n "${PROXY_PID:-}" ] || return 0
	kill "$PROXY_PID" 2>/dev/null || true
	local i
	for i in $(seq 1 100); do
		kill -0 "$PROXY_PID" 2>/dev/null || break
		sleep 0.05
	done
	PROXY_PID=""
}

run_g8l() {
	# Each fixture's editor import, once per out dir (its file group's, when that ran first).
	[ -f "$OUT/import/fixture/exit-code.txt" ] || run_import_g8t
	[ -f "$OUT/g8a/import/fixture/exit-code.txt" ] || run_import_g8a
	[ -f "$OUT/g8h/import/fixture/exit-code.txt" ] || run_import_g8h
	[ -f "$OUT/g8m/import/fixture/exit-code.txt" ] || run_import_g8m
	[ -f "$OUT/g8ku/import/fixture/exit-code.txt" ] || run_import_g8ku
	echo "run-gate8: bringing up private gamescope for g8l's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8l"
	local f leg via
	for f in "${G8L_FIXTURES[@]}"; do
		leg="$OUT/g8l/$f"
		# G8kb: the web export's /9 basis live leg is not run here: live, its non-4-aligned BC7
		# texture (npot, 150x110) draws wrong while its replay of the same sink draws right (WebGL
		# refuses such a BC level 0; texture-delivery-design.md "As built (G8kb)"), a web-export
		# defect G8kf owns. The checks report the leg not-applicable from this marker.
		if [ "$f" = basis ] && [ "${GATE7_LIVE_KIND:-}" = web ]; then
			mkdir -p "$leg"
			echo "G8kb: the web export's live /9 basis leg waits for G8kf (non-4-aligned BC7 upload, live differs from replay)" >"$leg/not-applicable.txt"
			echo "run-gate8: g8l basis not run for the web export (see $leg/not-applicable.txt)"
			continue
		fi
		via=""
		[ "$f" = proxy ] && via=" through the reverse proxy"
		echo "run-gate8: g8l $f (live host at /8, receiver over render-stream.8$via)"
		start_g8l_host "$leg/host" "$f"
		if [ "$f" = proxy ]; then
			start_g8l_proxy "$leg/proxy" "$LIVE_PORT"
			g8l_receiver "$leg" "$PROXY_PORT"
		else
			g8l_receiver "$leg" "$LIVE_PORT"
		fi
		finish_bg "$leg/host" "$LIVE_HOST_PID" "$HEADLESS_TIMEOUT_S"
		LIVE_HOST_PID=""
		[ "$f" = proxy ] && stop_g8l_proxy
		echo "run-gate8: g8l $f replay (the host's /$G8L_VERSION file sink, the same receiver)"
		local recording_name="$RECORDING_NAME"
		RECORDING_NAME="recording.rs$G8L_VERSION"
		RECEIVER_EXTRA_ENV=("${G8L_RECEIVER_ENV[@]}")
		# G8kb: basis's variants attach whenever their encodes finish, after its step checkpoints;
		# its replay also shoots the sink's last transaction (seq = frame, from 1), the state the
		# live receiver's final shot shows.
		if [ "$f" = basis ]; then
			RECEIVER_EXTRA_SHOTS="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["stream"]["transactions"])' \
				"$leg/host/evidence/result.json" 2>/dev/null || true)"
		fi
		run_rendered_receiver "$leg/host" "$leg/replay"
		RECORDING_NAME="$recording_name"
	done
	gs_teardown "$OUT/gamescope-g8l"
	GS_RUN_DIR=""
}

# ------------------------------------------------------------------------------------ g8ku
# G8ku (texture-delivery-design.md D6, D12, D14, D16): `basis-uastc` at /9 end to end.
G8KU_FIXTURE_DIR="$EXPERIMENT_DIR/fixtures/gate8-basis"
# The fixture's step-1 frame: the `updated` texture's in-place update, and the frame the capture
# legs attach every lazy encode at (GRC_TEXTURE_ENCODE_WAIT_FRAME), so the recordings are exact.
G8KU_WAIT_FRAME=12
G8KU_ENV=(GRC_STREAM_VERSION=9 GRC_TEXTURE_DECODE=engine GRC_TEXTURE_DELIVERY=basis-uastc)

run_import_g8ku() {
	echo "run-gate8: g8ku import (fixture)"
	LEG_ENV=()
	run_headless "$OUT/g8ku/import/fixture" none -- mise exec -- godot --headless --path "$G8KU_FIXTURE_DIR" --import
	if [ "$(cat "$OUT/g8ku/import/fixture/exit-code.txt")" != "0" ]; then
		echo "run-gate8: g8ku import failed, see $OUT/g8ku/import/fixture/stdout.log" >&2
		exit 1
	fi
}

# run_capture_g8ku <dir> <env word...>: a headless /9 basis-uastc capture of the fixture, the lazy
# variants attached at G8KU_WAIT_FRAME.
run_capture_g8ku() {
	local dir="$1"
	shift
	CAPTURE_FIXTURE_DIR="$G8KU_FIXTURE_DIR"
	CAPTURE_EXTRA_ENV=("${G8KU_ENV[@]}" GRC_TEXTURE_ENCODE_WAIT_FRAME="$G8KU_WAIT_FRAME"
		RS_FIXTURE_UPDATE_FRAME="$G8KU_WAIT_FRAME" "$@")
	run_capture "$dir" "" none
}

# run_reference_g8ku <dir> <procedural|oracle> [cpu|blocks]: a rendered fixture run, shots
# step-<k>; oracle: from step 1 the uastc textures are the oracle's CPU decodes (cpu) or its
# transcoded blocks sampled by the GPU (blocks).
run_reference_g8ku() {
	local dir="$1" source="$2" draw="${3:-cpu}"
	mkdir -p "$dir/shots"
	LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
		RS_FIXTURE_SOURCE="$source" RS_FIXTURE_UPDATE_FRAME="$G8KU_WAIT_FRAME")
	[ "$source" = oracle ] && LEG_ENV+=(RS_FIXTURE_KTX2_DIR="$OUT/g8ku/capture/store"
		RS_FIXTURE_ORACLE_OUT="$dir/oracle" RS_FIXTURE_ORACLE_DRAW="$draw")
	run_rendered "$dir" "$G8KU_FIXTURE_DIR"
}

# run_g8ku_live: g8ku/live/{host,receiver} (inside g8ku's gamescope): no wait knob, so the
# variants publish when their encodes finish; the receiver joins at RS_RECEIVER_PROTOCOL=9. While
# it runs, one stored KTX2 is fetched with Accept-Encoding: zstd (live/host/ktx2-get.{headers,body}).
run_g8ku_live() {
	local host="$OUT/g8ku/live/host" receiver="$OUT/g8ku/live/receiver" waited=0 port=""
	mkdir -p "$host/evidence" "$receiver"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$host/evidence" GRC_STREAM_OUT="$host/$RECORDING_NAME"
		GRC_RESOURCE_STORE_DIR="$host/store" GRC_LIVE_LISTEN=127.0.0.1:0 "${G8KU_ENV[@]}"
		RS_FIXTURE_UPDATE_FRAME=600 RS_FIXTURE_QUIT_FRAME=780 RS_FIXTURE_STEP_LOG="$host/steps.jsonl"
	)
	start_headless_bg "$host" -- "$BINARY" --headless --max-fps 60 --path "$G8KU_FIXTURE_DIR"
	local pid="$BG_PID"
	while [ "$waited" -lt 400 ] && [ ! -s "$host/evidence/live.json" ] && kill -0 "$pid" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$host/evidence/live.json" 2>/dev/null; then
		port="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$host/evidence/live.json")"
	fi
	if [ -z "$port" ]; then
		echo "the live host is not listening (see g8ku/live/host/evidence/live.json)" >"$receiver/skipped.txt"
	else
		(
			local i=0 ktx=""
			while [ "$i" -lt 200 ] && [ -z "$ktx" ]; do
				ktx="$(find "$host/store/sha256" -name '*.ktx2' 2>/dev/null | sort | head -1)"
				[ -z "$ktx" ] && sleep 0.05
				i=$((i + 1))
			done
			if [ -n "$ktx" ]; then
				curl -s --max-time 5 -H 'Accept-Encoding: zstd, gzip' -D "$host/ktx2-get.headers" \
					-o "$host/ktx2-get.body" "http://127.0.0.1:$port/resources/sha256/$(basename "$ktx" .ktx2)" ||
					echo "curl failed: $?" >"$host/ktx2-get.error"
				basename "$ktx" .ktx2 >"$host/ktx2-get.hash"
			else
				echo "no .ktx2 in the host store within 10 s" >"$host/ktx2-get.error"
			fi
		) &
		local probe=$!
		LEG_ENV=(
			RS_RECEIVER_MODE=live RS_RECEIVER_PROTOCOL=9 RS_RECEIVER_CREDIT_WINDOW=1
			RS_RECEIVER_URL="ws://127.0.0.1:$port/render-stream" RS_RECEIVER_TRANSCODE_LOG=1
			RS_RECEIVER_OUT="$receiver/applied.json" RS_RECEIVER_CACHE_DIR="$receiver/cache"
		)
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$receiver" "$RECEIVER_DIR"
		wait "$probe" 2>/dev/null || true
	fi
	finish_bg "$host" "$pid" "$HEADLESS_TIMEOUT_S"
}

run_g8ku() {
	run_import_g8ku
	RECORDING_NAME=recording.rs9
	PATCH_RECORDING_NAME=recording-patch.rs9

	echo "run-gate8: g8ku capture (/9, GRC_TEXTURE_DELIVERY=basis-uastc, variants at frame $G8KU_WAIT_FRAME)"
	run_capture_g8ku "$OUT/g8ku/capture"
	echo "run-gate8: g8ku workers/capture (the same at GRC_TEXTURE_WORKERS=2)"
	run_capture_g8ku "$OUT/g8ku/workers/capture" "${G8T_WORKERS_ENV[@]}"
	echo "run-gate8: g8ku sabotage-perturb-ktx2/capture (one KTX2 byte flipped after hashing)"
	if ! legs_sabotage_skipped "$OUT/g8ku/sabotage-perturb-ktx2/capture"; then
		run_capture_g8ku "$OUT/g8ku/sabotage-perturb-ktx2/capture" GRC_TEXTURE_ENCODE_FAULT=perturb-ktx2
	fi

	echo "run-gate8: bringing up private gamescope for g8ku's rendered legs"
	gs_start 640 360 "$OUT/gamescope-g8ku"
	legs_par_begin
	echo "run-gate8: g8ku reference, reference-oracle and reference-oracle-hw"
	run_reference_g8ku "$OUT/g8ku/reference" procedural
	run_reference_g8ku "$OUT/g8ku/reference-oracle" oracle cpu
	run_reference_g8ku "$OUT/g8ku/reference-oracle-hw" oracle blocks
	echo "run-gate8: g8ku receiver (keep), receiver-upgrade, sabotage-perturb-ktx2/receiver"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_TRANSCODE_LOG=1)
	run_rendered_receiver "$OUT/g8ku/capture" "$OUT/g8ku/receiver"
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_VARIANT_POLICY=upgrade RS_RECEIVER_TRANSCODE_LOG=1)
	run_rendered_receiver "$OUT/g8ku/capture" "$OUT/g8ku/receiver-upgrade"
	if [ -f "$OUT/g8ku/sabotage-perturb-ktx2/capture/$RECORDING_NAME" ]; then
		RECEIVER_EXTRA_ENV=(RS_RECEIVER_VARIANT_POLICY=upgrade RS_RECEIVER_TRANSCODE_LOG=1)
		run_rendered_receiver "$OUT/g8ku/sabotage-perturb-ktx2/capture" "$OUT/g8ku/sabotage-perturb-ktx2/receiver"
	fi
	legs_par_end
	echo "run-gate8: g8ku live (host /9 basis-uastc + rendered native receiver at RS_RECEIVER_PROTOCOL=9)"
	run_g8ku_live
	gs_teardown "$OUT/gamescope-g8ku"
	GS_RUN_DIR=""
	RECORDING_NAME=recording.rs8
	PATCH_RECORDING_NAME=recording-patch.rs8

	echo "run-gate8: g8ku web legs (g8ku-web/web: the web export on receiver-upgrade's launch)"
	(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
		"$SCRIPT_DIR/gate8-delivery-tool.ts" web-legs --source "$OUT") \
		>"$OUT/g8ku/web-legs.log" 2>&1 || echo "run-gate8: g8ku web legs failed, see $OUT/g8ku/web-legs.log" >&2
}

for group in "${GROUPS_RUN[@]}"; do
	case "$group" in
	g8kp) run_g8kp ;;
	g8kc) run_g8kc ;;
	g8ku) run_g8ku ;;
	g8t) run_g8t ;;
	g8f) run_g8f ;;
	g8a) run_g8a ;;
	g8h) run_g8h ;;
	g8m) run_g8m ;;
	g8l) run_g8l ;;
	esac
done

# Checker: writes $OUT/result.json and exits non-zero unless gate_passed.
echo "run-gate8: running checker"
cd "$REPO_ROOT"
legs_run_checker mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/check-gate8.ts" --out "$OUT"
