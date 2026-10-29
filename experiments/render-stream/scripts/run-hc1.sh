#!/usr/bin/env bash
# HC1 quiet-path legs (results/p3/hc1.md, protocol/host-cost-design.md D5, D6): small capture-scale
# hosts (stock release template, headless) armed with a live listener, a viewer that joins late, and
# the hook log on or off. Judged by scripts/lib/hc1-checks.ts:
#   hook-log-off-formats-nothing   counters.json hook_log_lines_formatted is 0 with GRC_HOOK_LOG=off
#                                  and equals resources.jsonl's line count with it on
#   no-snapshot-without-viewer     a listener with no viewer takes no snapshot (idle leg: 0)
#   late-join-served               a viewer joining a running host gets the full state a file sink
#                                  recorded and every GET it makes answers 200
#   sabotage-pin-late              (pin-late: no pin before the first transaction) 404s fail the above
# HC2's legs (results/p3/hc2.md; /11 file sinks, RS_SCALE_REDRAWS=40 of the 60 drawing items):
#   cv-stable-on-rerecord          identical re-records keep their content_version and stay out of
#                                  every patch; result.json: one digest per item, none after
#   rerecord-unequal-patched       RS_SCALE_REDRAW_VARY=8: the 8 re-records a frame that differ in one
#                                  float are patched with their new list under a new content_version
#   sabotage-rerecord-stale        (GRC_HC_SABOTAGE=rerecord-stale) fails rerecord-unequal-patched
#   sabotage-cv-churn              (GRC_SABOTAGE=cv-churn) fails cv-stable-on-rerecord
# HC3's legs (results/p3/hc3.md, host-cost-design.md D2; /11, mesh churn: 10 of the 20 meshes take
# region updates every frame, so they turn dynamic):
#   dyn-hash-log-off               a hook-log-off /11 file leg's counters.json mesh_hashes shows no
#                                  SHA-256 over a dynamic surface (mirror or hook) while meshes are
#                                  dynamic and change; its hook-log-on twin shows them (not vacuous)
#   dyn-wire-log-independent       the two legs' /11 recordings (full and patch) are cmp-rec-equal
#   late-join-v8-on-v11            a /8 viewer joining a /11 host (log off) gets real SHA-256s for
#                                  every mesh surface in every transaction, and every GET answers 200
#                                  with a body that hashes to its name
#   sabotage-dyn-hash-unread       (GRC_HC_SABOTAGE=dyn-hash-unread: the /8 viewer is not counted as
#                                  a hash reader) fails late-join-v8-on-v11
# HC4a's (results/p3/hc4a.md, host-cost-design.md D1 and "Byte-identity proof method"; the
# persistent item and canvas tables and their shadow oracle, GRC_HC_SHADOW=1):
#   shadow-oracle-agrees           rr-vary and dyn-off run with the oracle on: every snapshot of
#                                  theirs equals the full walk (counters.json hc_shadow)
#   sabotage-hc-skip-dirty-oracle  (GRC_HC_SABOTAGE=hc-skip-dirty: every 16th dirty mark lost) the
#                                  oracle ends the stream with hc-shadow-mismatch
#   sabotage-hc-skip-dirty-gate1   the same sabotage under run-gate1.sh --legs g1a fails gate 1's
#                                  receiver pixel checks (receiver-vs-reference,
#                                  expected-image-receiver)
#   sabotage-hc-stale-derived-oracle (hc-stale-derived: one item keeps stale item-level entries)
#                                  under run-gate2.sh --legs g2a: the oracle ends capture-unsupported
#                                  with an `unsupported` mismatch
#   sabotage-hc-stale-derived-gate2 the same under --legs g2a,g2b fails gate 2's unsupported checks
#                                  (recordings-decode-2 unsupported-mismatch,
#                                  leg-class-unsupported-textures)
#
#   bash experiments/render-stream/scripts/run-hc1.sh --extension EXT [--out DIR] [--calibration PATH]
#     [--binary PATH]
set -uo pipefail
if [ -z "${RS_QUIET_HC1_WRAPPED:-}" ]; then
	RS_QUIET_HC1_WRAPPED=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/lib/quiet.sh" shared \
		--label run-hc1 -- bash "${BASH_SOURCE[0]}" "$@"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
FIXTURE="$EXPERIMENT_DIR/fixtures/capture-scale"
EXTENSION="" OUT="" PORT="${RS_HC1_PORT:-13851}"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
CALIBRATION="$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json"
while [ $# -gt 0 ]; do
	case "$1" in
	--extension) EXTENSION="$2" && shift 2 ;;
	--out) OUT="$2" && shift 2 ;;
	--calibration) CALIBRATION="$2" && shift 2 ;;
	--binary) BINARY="$2" && shift 2 ;;
	-h | --help) sed -n 2,40p "${BASH_SOURCE[0]}" && exit 0 ;;
	*) echo "run-hc1: unknown argument $1" >&2 && exit 2 ;;
	esac
done
[ -f "$EXTENSION" ] || { echo "run-hc1: pass --extension /abs/path/render_stream_capture.gdextension" >&2; exit 2; }
[ -x "$BINARY" ] || { echo "run-hc1: no template at $BINARY" >&2; exit 2; }
EXTENSION="$(realpath "$EXTENSION")"
[ -n "$OUT" ] || OUT="$REPO_ROOT/artifacts/render-stream/hc1/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT" && OUT="$(realpath "$OUT")"

SMALL=(RS_SCALE_ITEMS=400 RS_SCALE_TEXTURES=60 RS_SCALE_TEX_W=64 RS_SCALE_TEX_H=48 RS_SCALE_DRAWN_TEXTURES=40
	RS_SCALE_MESHES=20 RS_SCALE_MATERIALS=40 RS_SCALE_SHADERS=4 RS_SCALE_FLOAT_TEXTURES=20 RS_SCALE_PARAMS=8)
STATIC=(RS_SCALE_MESH_UPDATES=0 RS_SCALE_MOVERS=0 RS_SCALE_PARAM_UPDATES=0)
CHURN=(RS_SCALE_MESH_UPDATES=10 RS_SCALE_MOVERS=10 RS_SCALE_PARAM_UPDATES=2 RS_SCALE_REDRAWS=20)
FRAMES=360 DELAY_MS=2500

# leg <name> <frames> <viewer 0|1> <sink 0|1> <hook on|off> <scene words...> [-- extra host env]
leg() {
	local name="$1" frames="$2" viewer="$3" sink="$4" hook="$5"
	shift 5
	local -a scene=() extra=()
	while [ $# -gt 0 ] && [ "$1" != "--" ]; do scene+=("$1") && shift; done
	[ $# -gt 0 ] && shift
	extra=("$@")
	local dir="$OUT/$name"
	rm -rf "$dir" && mkdir -p "$dir/evidence" "$dir/viewer"
	local -a env=(HOME="$HOME" PATH="$PATH" RS_FIXTURE_ARM=born RS_FIXTURE_QUIT_FRAME="$frames" RS_SCALE_WARMUP=30
		RS_SCALE_REPORT="$dir/scale-report.json" "${SMALL[@]}" "${scene[@]}"
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_VERSION=8 GRC_TEXTURE_DECODE=engine
		GRC_TEXTURE_WORKERS=sync GRC_ROOT_SIZE=presentation:1920x1080 GRC_HOOK_LOG="$hook"
		GRC_RESOURCE_INLINE_MAX_BYTES=256 GRC_RESOURCE_STORE_DIR="$dir/store")
	# HC4a: the shadow oracle under HC_SHADOW=1 (lib/gamescope.sh gs_strip_env_args)
	if [ "${HC_SHADOW:-}" = 1 ]; then env+=(GRC_HC_SHADOW=1); fi
	if [ "$sink" = 1 ]; then env+=(GRC_STREAM_OUT="$dir/recording-full.rs8"); fi
	if [ "$viewer" != x ]; then env+=(GRC_LIVE_LISTEN="127.0.0.1:$PORT" GRC_LIVE_TAP_DIR="$dir/tap"); fi
	[ "${#extra[@]}" -gt 0 ] && env+=("${extra[@]}")
	mkdir -p "$dir/tap"
	printf '%s\n' "${env[@]}" >"$dir/env.txt"
	echo "run-hc1: $name (viewer=$viewer sink=$sink hook_log=$hook, $frames frames)"
	local rx_pid=""
	if [ "$viewer" = 1 ]; then
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/null-receiver.ts" \
			--url "ws://127.0.0.1:$PORT/render-stream" --out "$dir/viewer" --protocol 8 --window 1 \
			--delay-ms "$DELAY_MS" --fetch-first "http://127.0.0.1:$PORT" --timeout-s 60 \
			>"$dir/viewer/stdout.log" 2>&1) &
		rx_pid=$!
	fi
	env -i "${env[@]}" "$BINARY" --headless --max-fps 60 --path "$FIXTURE" >"$dir/stdout.log" 2>"$dir/stderr.log"
	echo "$?" >"$dir/exit.txt"
	[ -n "$rx_pid" ] && { wait "$rx_pid"; echo "$?" >"$dir/viewer/exit.txt"; }
	return 0
}

leg ref-static "$FRAMES" x 1 on "${STATIC[@]}"
leg idle 120 0 0 on "${STATIC[@]}"
leg late-static "$FRAMES" 1 0 on "${STATIC[@]}"
leg late-static-off "$FRAMES" 1 0 off "${STATIC[@]}"
leg late-churn "$FRAMES" 1 1 on "${CHURN[@]}"
# HC2: /11 file sinks (full and patch), no listener.
RR=(RS_SCALE_REDRAWS=40)
RR_FRAMES=150
rr_sinks() { echo "GRC_STREAM_VERSION=11 GRC_STREAM_OUT=$OUT/$1/recording.rs11 GRC_STREAM_PATCH_OUT=$OUT/$1/recording-patch.rs11"; }
# shellcheck disable=SC2046 # word-split on purpose: three VAR=value words
leg rr-same "$RR_FRAMES" x 0 off "${STATIC[@]}" "${RR[@]}" -- $(rr_sinks rr-same)
# shellcheck disable=SC2046
leg rr-vary "$RR_FRAMES" x 0 off "${STATIC[@]}" "${RR[@]}" RS_SCALE_REDRAW_VARY=8 -- $(rr_sinks rr-vary) GRC_HC_SHADOW=1
if [ "${RS_SABOTAGE_TIER:-run}" = skip ]; then
	# the smoke tier (lib/legs.sh's contract): tier-verdict.py excuses the check naming "sabotage"
	for s in sabotage-pin-late sabotage-rr-stale sabotage-rr-cv-churn; do
		mkdir -p "$OUT/$s"
		echo "skipped-by-tier: RS_SABOTAGE_TIER=skip" >"$OUT/$s/skipped-by-tier.txt"
	done
else
	leg sabotage-pin-late "$FRAMES" 1 0 on "${STATIC[@]}" -- GRC_HC_SABOTAGE=pin-late
	# shellcheck disable=SC2046
	leg sabotage-rr-stale "$RR_FRAMES" x 0 off "${STATIC[@]}" "${RR[@]}" RS_SCALE_REDRAW_VARY=8 -- \
		$(rr_sinks sabotage-rr-stale) GRC_HC_SABOTAGE=rerecord-stale
	# shellcheck disable=SC2046
	leg sabotage-rr-cv-churn "$RR_FRAMES" x 0 off "${STATIC[@]}" "${RR[@]}" -- \
		$(rr_sinks sabotage-rr-cv-churn) GRC_SABOTAGE=cv-churn
fi
# HC3: /11 file sinks with mesh churn, hook log off and on; a /8 viewer on a /11 host.
DYN_FRAMES=150
dyn_sinks() { echo "GRC_STREAM_VERSION=11 GRC_STREAM_OUT=$OUT/$1/recording.rs11 GRC_STREAM_PATCH_OUT=$OUT/$1/recording-patch.rs11"; }
# shellcheck disable=SC2046
leg dyn-off "$DYN_FRAMES" x 0 off "${CHURN[@]}" -- $(dyn_sinks dyn-off) GRC_HC_SHADOW=1
# shellcheck disable=SC2046
leg dyn-on "$DYN_FRAMES" x 0 on "${CHURN[@]}" -- $(dyn_sinks dyn-on)
mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/cmp-rec.ts" --tree "$OUT/dyn-off" "$OUT/dyn-on" \
	>"$OUT/dyn-cmp.txt" 2>&1
echo "$?" >"$OUT/dyn-cmp.exit"
# shellcheck disable=SC2046
leg late-dyn-v8 "$FRAMES" 1 0 off "${CHURN[@]}" -- GRC_STREAM_VERSION=11 GRC_STREAM_OUT="$OUT/late-dyn-v8/recording.rs11"
if [ "${RS_SABOTAGE_TIER:-run}" = skip ]; then
	mkdir -p "$OUT/sabotage-dyn-hash-unread"
	echo "skipped-by-tier: RS_SABOTAGE_TIER=skip" >"$OUT/sabotage-dyn-hash-unread/skipped-by-tier.txt"
else
	leg sabotage-dyn-hash-unread "$FRAMES" 1 0 off "${CHURN[@]}" -- GRC_STREAM_VERSION=11 \
		GRC_STREAM_OUT="$OUT/sabotage-dyn-hash-unread/recording.rs11" GRC_HC_SABOTAGE=dyn-hash-unread
fi

# HC4a: the sabotages, caught by the shadow oracle and by the gates' own checks. A nested gate run
# gets the sabotage through HC_SABOTAGE (lib/gamescope.sh), its own sabotage legs skipped, and the
# oracle only where the leg is the oracle's (HC_SHADOW=0 elsewhere, so the stream runs to its end).
nested_gate() { # <name> <gate n> <legs> <hc sabotage> <shadow 0|1>
	local name="$1" n="$2" legs="$3" sab="$4" shadow="$5" dir="$OUT/$1"
	rm -rf "$dir" && mkdir -p "$dir"
	echo "run-hc1: $name (run-gate$n.sh --legs $legs, GRC_HC_SABOTAGE=$sab, shadow $shadow)"
	env HC_SABOTAGE="$sab" HC_SHADOW="$shadow" RS_SABOTAGE_TIER=skip bash "$SCRIPT_DIR/run-gate$n.sh" \
		--extension "$EXTENSION" --calibration "$CALIBRATION" --binary "$BINARY" --out "$dir/gate" --legs "$legs" \
		>"$dir/run.log" 2>&1
	echo "$?" >"$dir/exit.txt"
}
HC4A_SABOTAGES=(sabotage-hc-skip-dirty-oracle sabotage-hc-skip-dirty-gate1 sabotage-hc-stale-derived-oracle
	sabotage-hc-stale-derived-gate2)
if [ "${RS_SABOTAGE_TIER:-run}" = skip ]; then
	for s in "${HC4A_SABOTAGES[@]}"; do
		mkdir -p "$OUT/$s"
		echo "skipped-by-tier: RS_SABOTAGE_TIER=skip" >"$OUT/$s/skipped-by-tier.txt"
	done
else
	# shellcheck disable=SC2046
	leg sabotage-hc-skip-dirty-oracle "$DYN_FRAMES" x 0 off "${CHURN[@]}" -- $(dyn_sinks sabotage-hc-skip-dirty-oracle) \
		GRC_HC_SHADOW=1 GRC_HC_SABOTAGE=hc-skip-dirty
	nested_gate sabotage-hc-skip-dirty-gate1 1 g1a hc-skip-dirty 0
	nested_gate sabotage-hc-stale-derived-oracle 2 g2a hc-stale-derived 1
	nested_gate sabotage-hc-stale-derived-gate2 2 g2a,g2b hc-stale-derived 0
fi

mise exec -- pnpm exec tsx --conditions=development "$SCRIPT_DIR/lib/hc1-checks.ts" "$OUT"
