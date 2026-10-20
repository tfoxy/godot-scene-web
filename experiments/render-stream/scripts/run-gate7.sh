#!/usr/bin/env bash
# Gate 7 runner (G7h skeleton; G7d adds the phone-target groups g7-dev and g7-bench and the device
# environment; protocol/gate7-design.md "G7h", "G7d", Q13).
#
#   bash run-gate7.sh [--legs g7-dev,g7-bench,...] [--out DIR] \
#     [--env desktop|device] [--device g31|g86] [--receiver native|gsw|web] \
#     [--bench-inputs <inputs.json>] [--repeats N] [--hold-seconds S] [--plan-only] \
#     [--extension X.gdextension] [--calibration record.json] [--binary template] \
#     [--source gate0=/abs/run/dir,...] [--make-sources] [--skip-harness-selftest] \
#     [--bundle /abs/web-receiver/<sha>/bundle] [--gsw-bundle /abs/gsw-bundle/dir] \
#     [--rs-build /abs/artifacts/render-stream/rs-core/<sha>] [--live] [--web-core rust|gdscript]
#     [--web-fetch fetch|httpclient]
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
#               desktop: native-bench-<input> (receiver.gd file mode, headless), ctl-bench-<input>-gsw-ts
#                        (headless Chromium, D9), ctl-bench-<input>-web (G7e web export, same desktop
#                        Chromium, since G7m)
#               device:  dev-bench-<input>-gsw-ts-<id> and -web-<id> (both since G7m), plus the device
#                        probes (run once, by g7-dev's device session check, whichever --receiver)
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
# --web-core rust|gdscript (G7xw, gate7-design.md "G7xw", Q14e; G7xd made rust the default): every
# web-export leg and the web bench arm run on the shared Rust core through its dlink side module:
# build-web-receiver.sh --core rust (or `--bundle`, such a build), gate7-tool.ts web-legs --core
# rust (RS_RECEIVER_CORE=rust on every leg) and gate7-bench.ts --arm web --core rust. That is now
# the default; --web-core gdscript selects G7e's/G7b's frozen GDScript build (/7, milestone sweeps
# only, D34 amended). With --live (G7xwl), the web live legs and their received.rs7 replays run
# on the chosen core too (GATE7_WEB_CORE to the gate runners' browser daemon; check-gate7.ts
# --live --web-core <core> adds receiver-core@web, which fails a leg that did not decode and apply
# through the requested core).
#
# --web-fetch fetch|httpclient (G7wf, protocol/gate7/g7wf.md; --live only): how the web export
# GETs resource payloads. `fetch` (the default) is the browser's fetch() through JavaScriptBridge;
# `httpclient` (GATE7_WEB_FETCH to the browser daemon, RS_RECEIVER_WEB_FETCH=httpclient on every
# web leg) is Godot's web HTTPClient, the pre-G7wf path, kept for the A/B. check-gate7.ts
# --web-fetch adds fetch-impl@web, which fails a live web leg whose applied.json
# `live.fetch_impl` is not the requested mechanism.
#
# Groups landed (G7a, the GSW canvas receiver on the shared Rust core, gate7-design.md "G7a"):
#   g7-0..g7-3  gates 0 to 3's file-mode receiver legs in the GSW canvas receiver (`gsw`), and
#             g7-0's web half (G7e). Sources: `--source gate<N>=<dir>` or `--make-sources` (runs
#             run-gate<N>.sh and records gate7-source.json). The gsw half needs the core built:
#             build-rs-core.sh (or `--rs-build`), then the bundle (gate7-tool.ts gsw-bundle, or
#             `--gsw-bundle`), then once per run: rs-core-check goldens natively, the goldens
#             through the wasm module in Node, self-test-rs-core.ts over every source recording
#             (<out>/rs-core/*.log); per group gate7-tool.ts gsw-legs into <out>/gate<N>/gsw/,
#             and for g7-1 `cargo test ordering_model` on the gate 1 source's recording
#             (<out>/gate1/ordering-model.log). check-gate7.ts judges every gsw leg with its gate's
#             own checker (lib/gate7-gsw.ts) plus G7a's checks (lib/gate7-gsw-checks.ts).
#             `--receiver web|gsw` limits the run to one browser (the web half of g7-1..g7-3 is
#             G7b's, below).
# Groups landed (G7b): the web half of
#   g7-1 g7-2 g7-3 g7-4 g7-5 g7-55 g7-6
#             every FILE receiver leg of gates 1 to 6 in the web export (the gsw half is G7a's,
#             G7t's and G7s's; the live legs are G7l's and G7g's). Sources (D21): `--source
#             gate<N>=<dir>` per gate, or `--make-sources`, which runs run-gate<N>.sh with only the
#             gate's file-leg groups (g1a,g1b / g2a,g2b,g2d / g3a-g3d / g4a-g4f / g5b,g5c,g5d,g5e,g5g /
#             g55b-g55e / g6a,g6h,g6b) into <out>/sources-made/gate<N>/. gate7-tool.ts web-legs
#             discovers the source's file receiver legs (lib/gate7b-adapters.ts) and replays each one
#             in the web export into <out>/gate<N>/web/<leg>, then replays every leg whose shots
#             differ from native once more into <out>/gate<N>/web-repeat/<leg> (Q7's same-build
#             repeat). check-gate7.ts judges each gate with the gate's own checker through views of
#             the source (native, blank, web, banded; lib/gate7b-adapters.ts header).
#   g7-55 gsw (G7s) gate 5.5's file-mode receiver legs (g55d CanvasItemMaterial, g55e ShaderMaterial)
#             in the GSW canvas receiver, plus the GSW-only blend-swap sabotage, judged by
#             check-gate55.ts's g55d/g55e checks plus G7s's (lib/gate7-gsw-55-checks.ts). Its
#             source is the same shape as the web half's (run-gate55.sh --legs g55b-g55e; g55f's
#             live legs are G7l's), and source-run-valid@gsw accepts its not-run g55f.
#
# Groups landed (G7t, gates 4 and 5 in the GSW canvas receiver, gate7-design.md "G7t"):
#   g7-4, g7-5  gates 4 and 5's file-mode receiver legs (text, geometry, meshes, styleboxes) in the
#             GSW receiver, sourced and judged exactly as g7-0..g7-3 (lib/gate7-gsw-g45.ts), plus
#             G7t's checks (lib/gate7-gsw-g45-checks.ts; g7-5's lowering-parity runs
#             `rs-core-check lowered` over the gate 5 source recordings). g5f's live legs are G7l's.
#
# Live halves (G7l, gate7-design.md "G7l", Q8; `--live`, which runs ONLY these; G7g adds g7-6's
# g6l):
#   g7-1 g7-2 g7-5 g7-55  the live groups of gates 1 (g1c, g1d), 2 (g2c, g2e, plus G7l's
#             origin-refused and sabotage-no-cors), 5 (g5f) and 5.5 (g55f), delivered to a browser
#             receiver over render-stream/7. A live leg cannot replay a source: per gate and receiver
#             kind (`--receiver web|gsw`, else both) the gate's OWN runner runs again with
#             GATE7_LIVE_KIND set (lib/legs.sh substitutes the browser for every live receiver and
#             every received.rs7 replay; lib/gate7-live-legs.ts launches it) into
#             <out>/<gate>/live-<kind>/ with --legs g1a,g1c,g1d / g2a,g2c,g2e / g5c,g5f (check-gate5.ts judges g5f only beside g5c) / g55f, and its
#             checker judges it there. check-gate7.ts --live then reports the checks that read a
#             browser leg as `<id>@<kind>` plus gate 7's live checks (lib/gate7-live.ts). Timing-
#             sensitive: run it on a quiet machine.
#
# Group landed (G7g, protocol/gate7/g7g.md): the gsw half of
#   g7-6      gate 6's file receiver legs (g6a's scene, patch, inline, animate, refused and receiver
#             sabotages; g6h's HD native at a 1920x1080 backing store; g6b's HD half at 960x540, the
#             presentation hazard, ignore-presentation and ignore-canvas-stacking) in the GSW
#             receiver, sourced (`--make-sources`: run-gate6.sh --legs g6a,g6h,g6b) and judged as
#             g7-4/g7-5 (lib/gate7-gsw-g6.ts, check-gate6.ts buildGate6Report), plus
#             presentation-check (the page's canvas backing store equals presentation_size; the web
#             half gets it too, lib/gate7-g6-checks.ts). `--live` with g7-6 runs g6l in both browsers.
#
# Group landed (G7r, protocol/gate7/g7r.md, gate7-design.md Q9; `--live` only): pacing, rates, the
#   g7-r      60/60 phase study and dual receivers at credit window 1, on all three receivers. G6c's
#             group is reused unforked (lib/gate6c-legs.sh with receiver kinds): run-gate6.sh
#             --legs g6c runs once per receiver kind (`--receiver native|web|gsw`, else all three)
#             with G6C_LEGS naming the kind's legs, into <out>/gate6/rates-<kind>/:
#               native  rate-baseline, phase-60-r1..r5, phase-60-late-poll-r1..r5 (RS_RECEIVER_LATE_POLL)
#               web     rate-baseline, rate-15/30/60, rate-uncapped-host60, rate-uncapped,
#                       mismatch-60-recv30, phase-60-r1..r5, phase-60-late-poll-r1..r5,
#                       dual-native, constrained
#               gsw     web's legs without the late-poll runs, plus sabotage-ack-on-receipt
#             The native receivers (and dual-native's /6 one) run on RS_RECEIVER_CORE (default rust
#             here: D34 as amended demotes the GDScript decode/apply path); the web export on
#             --web-core. G7R_LEGS (a CSV) replaces every kind's list (development). Each browser
#             run's daemon launches its next spare browser only after a leg (GATE7_BROWSER_SPARE=
#             after), so no Chromium start-up lands in a timed window. check-gate7.ts --live judges
#             them (lib/gate7r-checks.ts). Timing legs: each holds the quiet lock exclusive.
#
# Group landed (G7u, protocol/gate7/g7u.md, g7u-as-built.md, D14; `--live` only): suspension
#   g7-lc     and lifecycle in both browser receivers. G6l's group is reused: run-gate6.sh --legs
#             g6l runs once per browser kind (`--receiver web|gsw`, else both) with G7U_LEGS naming
#             the kind's lifecycle legs (run-gate6.sh g6l_lc_words: RS_RECEIVER_LIFECYCLE, a harness
#             word the page shim lib/browser-probes/lifecycle-shim.js acts on; lib/gate7-lifecycle.ts
#             writes each receiver's lifecycle.json and compositor/screenshot.png), into
#             <out>/gate6/lc-<kind>/live/<leg>/, then reference-live-frames:
#               web     sim-hidden-2s, sim-hidden-30s, sim-frozen-30s, reload, close, context-loss
#               gsw     web's legs plus sabotage-ack-while-hidden, sabotage-css-opacity
#             Desktop suspensions are SIMULATED in the page (headless=new has no occlusion or freeze
#             model, G7h): `simulated-suspension`, never a pass of hidden/frozen. `--env device
#             --device <id>` with `--legs g7-lc` alone runs the real legs (hidden-2s, hidden-30s,
#             frozen-30s, reload, close, context-loss; gsw adds sabotage-ack-while-hidden) into
#             <out>/gate6/lc-<kind>-<id>/ with GATE7_LIFECYCLE_ENV=device and GATE7_DEVICE=<id>
#             passed to the browser daemon, whose device mode runs them on the phone's real Chrome
#             (lib/gate7-device-legs.ts; it never falls back to the desktop). A device run raises
#             S per kind (G7U_START_FRAME, default G7U_DEVICE_START_FRAME_<kind>: web 900, since the
#             web export needs ~9.5 s on the g31 to connect; gsw 300). G7U_LEGS (a CSV) replaces
#             every kind's list (development). check-gate7.ts --live judges them
#             (lib/gate7u-checks.ts). Timing legs.
#
# Group landed (G7k, protocol/gate7/g7k.md, gate7-design.md Q10 "Startup, memory"; `--live`
#   g7-k      only): startup cost and soak stability, on both browser receivers. Two run-gate6.sh
#             invocations per kind:
#               soak     --legs g6s (G6S_LEGS a CSV, run-gate6.sh's own new override; default per
#                        kind below) into <out>/gate6/g6s-<kind>/, reusing G6s's soak-scene and
#                        sabotage-soak-no-evict legs unmodified:
#                          web   soak-scene, sabotage-soak-no-evict
#                          gsw   web's legs plus sabotage-leak-gl-textures (GSW only: a throwaway
#                                WebGL context gsw-receiver/gl-leak.ts owns, never the canvas GSW
#                                draws into)
#               startup  --legs g6l (G7K_STARTUP_LEGS a CSV, run-gate6.sh's own new mode) into
#                        <out>/gate6/startup-<kind>/: startup-cold-r0..r5 (a fresh profile each)
#                        and startup-warm-r0..r5 (r0 a cold load, r1..r5 each a fresh copy of r0's
#                        profile -- RS_RECEIVER_CACHE_MODE=warm, the same mechanism a live-scene-warm
#                        leg uses, so each really is "a second load in the same profile"); no g6l
#                        leg, reference-file or reference-live-frames runs (a startup leg's
#                        timings.json, D15's navigation-relative marks, is its only evidence).
#             GATE7_MEM_SAMPLE=1 turns on the harness's 1 Hz memory samplers
#             (lib/gate7k-samplers.ts: /proc RSS of the browser/renderer/GPU processes, CDP JS
#             heap, nvidia-smi per-process GPU memory, the page's own wasm heap) for every g7-k
#             leg, never any other group's. check-gate7.ts --live judges them
#             (lib/gate7k-checks.ts). Both run-gate6.sh groups (g6s, g6l) are timing groups: each
#             leg holds the quiet lock exclusive, 300 s for a soak leg and a few seconds for a
#             startup one.
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
LANDED_GROUPS=(g7-0 g7-1 g7-2 g7-3 g7-4 g7-5 g7-55 g7-6 g7-lc g7-r g7-k g7-dev g7-bench)

# G7u: each browser kind's lifecycle legs (run-gate6.sh G7U_LEGS), desktop (simulated suspension)
# and device (real hidden/frozen). G7U_LEGS in the environment replaces every kind's list.
G7U_LC_COMMON=reload,close,context-loss
G7U_LEGS_web="sim-hidden-2s,sim-hidden-30s,sim-frozen-30s,$G7U_LC_COMMON"
G7U_LEGS_gsw="$G7U_LEGS_web,sabotage-ack-while-hidden,sabotage-css-opacity"
G7U_DEVICE_LEGS_web="hidden-2s,hidden-30s,frozen-30s,$G7U_LC_COMMON"
G7U_DEVICE_LEGS_gsw="$G7U_DEVICE_LEGS_web,sabotage-ack-while-hidden"
# G7u part D: a device run's S per kind (run-gate6.sh G7U_START_FRAME; the desktop is always 300).
G7U_DEVICE_START_FRAME_web=900
G7U_DEVICE_START_FRAME_gsw=300

# G7r: each receiver kind's g6c legs (lib/gate6c-legs.sh), and the native receivers' core.
G7R_PHASE=phase-60-r1,phase-60-r2,phase-60-r3,phase-60-r4,phase-60-r5
G7R_LATE=phase-60-late-poll-r1,phase-60-late-poll-r2,phase-60-late-poll-r3,phase-60-late-poll-r4,phase-60-late-poll-r5
G7R_BROWSER_RATES=rate-baseline,rate-15,rate-30,rate-60,rate-uncapped-host60,rate-uncapped,mismatch-60-recv30
G7R_LEGS_native="rate-baseline,$G7R_PHASE,$G7R_LATE"
G7R_LEGS_web="$G7R_BROWSER_RATES,$G7R_PHASE,$G7R_LATE,dual-native,constrained"
G7R_LEGS_gsw="$G7R_BROWSER_RATES,$G7R_PHASE,dual-native,constrained,sabotage-ack-on-receipt"
G7R_NATIVE_CORE="${RS_RECEIVER_CORE:-rust}"

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
WEB_CORE="rust"
WEB_FETCH="fetch"
GSW_BUNDLE=""
RS_BUILD=""
LIVE=0
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
	--live)
		LIVE=1
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
	--gsw-bundle)
		GSW_BUNDLE="${2:-}"
		shift 2
		;;
	--web-core)
		WEB_CORE="${2:-}"
		shift 2
		;;
	--web-fetch)
		WEB_FETCH="${2:-}"
		shift 2
		;;
	--rs-build)
		RS_BUILD="${2:-}"
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
case "$WEB_CORE" in
gdscript | rust) ;;
*)
	echo "run-gate7: --web-core must be gdscript or rust (got $WEB_CORE)" >&2
	exit 2
	;;
esac
case "$WEB_FETCH" in
fetch | httpclient) ;;
*)
	echo "run-gate7: --web-fetch must be fetch or httpclient (got $WEB_FETCH)" >&2
	exit 2
	;;
esac
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

# Measurement isolation (lib/quiet.sh, results/measurement-isolation.md): the machine-wide quiet
# lock is taken per leg, never around this run. The runners this one calls lock their own legs
# (gate 7's live legs exclusive: lib/legs.sh); the web and gsw file legs hold it shared, one leg
# at a time (lib/gate7-web-legs.ts); gate7-bench.ts holds it exclusive per arm, after its builds;
# the build scripts, the harness self-test and the checker hold it shared.
# shellcheck source=lib/quiet.sh
source "$SCRIPT_DIR/lib/quiet.sh"
QUIET_LOG="$OUT/quiet-lock.jsonl"
QUIET_T0="$EPOCHREALTIME"
gate7_checker() {
	local rc=0
	quiet_run shared run-gate7:checker -- "$@" || rc=$?
	quiet_summary "$OUT" "$(quiet__secs "$QUIET_T0" "$EPOCHREALTIME")" | sed 's/^/run-gate7: /' >&2
	return "$rc"
}
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

# --- G7l: --live runs only the live halves of g7-1, g7-2, g7-5 and g7-55, then judges them. -----
if [ "$LIVE" = "1" ]; then
	# G7u: `--env device --device <id>` is accepted for exactly `--legs g7-lc` (the real hidden and
	# frozen legs run on the phone); every other live group is desktop only.
	if [ "$HARNESS_ENV" != "desktop" ] && [ "${GROUPS_RUN[*]:-}" != "g7-lc" ]; then
		echo "run-gate7: --live runs on the desktop only (drop --env device), except --legs g7-lc alone" >&2
		exit 2
	fi
	if has_group g7-lc && [ "$RECEIVER" = "native" ]; then
		echo "run-gate7: g7-lc runs browser receivers only (--receiver web|gsw)" >&2
		exit 2
	fi
	if has_group g7-k && [ "$RECEIVER" = "native" ]; then
		echo "run-gate7: g7-k runs browser receivers only (--receiver web|gsw)" >&2
		exit 2
	fi
	if [ "$HARNESS_ENV" = device ]; then
		# Before any build: a device lifecycle run the daemon cannot drive fails here, loudly.
		if ! GATE7_LIFECYCLE_ENV=device GATE7_DEVICE="$DEVICE" g7tool lifecycle-env-check >&2; then
			echo "run-gate7: g7-lc --env device: refusing (see above); nothing ran on the desktop instead" >&2
			exit 1
		fi
	fi
	LIVE_RUNS=()
	for pair in g7-1:1:g1a,g1c,g1d g7-2:2:g2a,g2c,g2e g7-5:5:g5c,g5f g7-55:55:g55f g7-6:6:g6l; do
		group="${pair%%:*}"
		rest="${pair#*:}"
		has_group "$group" || continue
		LIVE_RUNS+=("$group:$rest")
	done
	if [ "${#LIVE_RUNS[@]}" -eq 0 ] && ! has_group g7-r && ! has_group g7-lc && ! has_group g7-k; then
		echo "run-gate7: --live needs one of g7-1, g7-2, g7-5, g7-55, g7-6, g7-lc, g7-r, g7-k in --legs" >&2
		exit 2
	fi
	if [ "$RECEIVER" = "native" ] && [ "${#LIVE_RUNS[@]}" -gt 0 ]; then
		echo "run-gate7: --live --receiver native runs g7-r only (the other live groups are browser halves)" >&2
		exit 2
	fi
	if [ ! -f "$EXTENSION" ]; then
		echo "run-gate7: --live needs the capture extension ($EXTENSION; build-capture.sh or --extension)" >&2
		exit 1
	fi
	EXTENSION="$(realpath "$EXTENSION")"
	LIVE_KINDS=()
	want_web_live() { [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; }
	want_gsw_live() { [ -z "$RECEIVER" ] || [ "$RECEIVER" = "gsw" ]; }
	if want_web_live; then
		if [ -z "$BUNDLE" ]; then
			echo "run-gate7: building the web receiver (build-web-receiver.sh --core $WEB_CORE)" >&2
			BUNDLE="$(bash "$SCRIPT_DIR/build-web-receiver.sh" --core "$WEB_CORE" | tail -1)"
		fi
		BUNDLE="$(realpath "$BUNDLE")"
		# G7xwl: the browser daemon refuses it too (webCoreOf); refused here before any host runs.
		bundle_core="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("core") or "gdscript")' "$BUNDLE/build.json")"
		if [ "$WEB_CORE" = rust ] && [ "$bundle_core" != rust ]; then
			echo "run-gate7: --live --web-core rust needs a build-web-receiver.sh --core rust bundle; $BUNDLE is $bundle_core" >&2
			exit 2
		fi
		LIVE_KINDS+=("web:$BUNDLE")
	fi
	if want_gsw_live; then
		if [ -z "$GSW_BUNDLE" ]; then
			if [ -z "$RS_BUILD" ]; then
				bash "$SCRIPT_DIR/build-rs-core.sh" >"$OUT/build-rs-core.log" 2>&1 || {
					echo "run-gate7: build-rs-core.sh failed, see $OUT/build-rs-core.log" >&2
					exit 1
				}
				RS_BUILD="$REPO_ROOT/artifacts/render-stream/rs-core/$(sed -n 's/^sha=//p' "$OUT/build-rs-core.log" | tail -1)"
			fi
			GSW_BUNDLE="$(g7tool gsw-bundle --out "$OUT/gsw-bundle-build" --rs-build "$(realpath "$RS_BUILD")" | tail -1)"
		fi
		GSW_BUNDLE="$(realpath "$GSW_BUNDLE")"
		LIVE_KINDS+=("gsw:$GSW_BUNDLE")
	fi
	for run in ${LIVE_RUNS[@]+"${LIVE_RUNS[@]}"}; do
		group="${run%%:*}"
		rest="${run#*:}"
		g="${rest%%:*}"
		runner_legs="${rest#*:}"
		for kb in "${LIVE_KINDS[@]}"; do
			kind="${kb%%:*}"
			bundle_dir="${kb#*:}"
			run_dir="$OUT/gate$g/live-$kind"
			mkdir -p "$OUT/gate$g"
			echo "run-gate7: $group live @$kind: run-gate$g.sh --legs $runner_legs into $run_dir" >&2
			set +e
			GATE7_LIVE_KIND="$kind" GATE7_BUNDLE_DIR="$bundle_dir" GATE7_WEB_CORE="$WEB_CORE" \
				GATE7_WEB_FETCH="$WEB_FETCH" bash "$SCRIPT_DIR/run-gate$g.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
				--binary "$BINARY" --out "$run_dir" --legs "$runner_legs" >"$OUT/gate$g/live-$kind.log" 2>&1
			live_exit=$?
			set -e
			echo "run-gate7: run-gate$g.sh @$kind exit=$live_exit (check-gate7.ts --live judges it)" >&2
		done
	done
	# G7r: run-gate6.sh --legs g6c once per receiver kind (header "Group landed (G7r)").
	if has_group g7-r; then
		G7R_KINDS=()
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "native" ]; then
			G7R_KINDS+=("native:")
		fi
		G7R_KINDS+=(${LIVE_KINDS[@]+"${LIVE_KINDS[@]}"})
		if [ "$G7R_NATIVE_CORE" = rust ] && [ ! -f "$EXPERIMENT_DIR/receiver/ext/build/librs_core_ext.so" ]; then
			echo "run-gate7: g7-r: building the native receiver's Rust core adapter (build-rs-core-ext.sh)" >&2
			bash "$SCRIPT_DIR/build-rs-core-ext.sh" --no-test >"$OUT/build-rs-core-ext.log" 2>&1 || {
				echo "run-gate7: build-rs-core-ext.sh failed, see $OUT/build-rs-core-ext.log" >&2
				exit 1
			}
		fi
		mkdir -p "$OUT/gate6"
		for kb in "${G7R_KINDS[@]}"; do
			kind="${kb%%:*}"
			bundle_dir="${kb#*:}"
			legs_var="G7R_LEGS_$kind"
			g7r_legs="${G7R_LEGS:-${!legs_var}}"
			run_dir="$OUT/gate6/rates-$kind"
			echo "run-gate7: g7-r @$kind: run-gate6.sh --legs g6c (G6C_LEGS=$g7r_legs) into $run_dir" >&2
			set +e
			if [ "$kind" = native ]; then
				RS_RECEIVER_CORE="$G7R_NATIVE_CORE" G6C_LEGS="$g7r_legs" \
					bash "$SCRIPT_DIR/run-gate6.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
					--binary "$BINARY" --out "$run_dir" --legs g6c >"$OUT/gate6/rates-$kind.log" 2>&1
			else
				GATE7_LIVE_KIND="$kind" GATE7_BUNDLE_DIR="$bundle_dir" GATE7_WEB_CORE="$WEB_CORE" \
					GATE7_WEB_FETCH="$WEB_FETCH" GATE7_BROWSER_SPARE=after RS_RECEIVER_CORE="$G7R_NATIVE_CORE" G6C_LEGS="$g7r_legs" \
					bash "$SCRIPT_DIR/run-gate6.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
					--binary "$BINARY" --out "$run_dir" --legs g6c >"$OUT/gate6/rates-$kind.log" 2>&1
			fi
			g7r_exit=$?
			set -e
			echo "run-gate7: g7-r run-gate6.sh @$kind exit=$g7r_exit (check-gate7.ts --live judges it)" >&2
		done
	fi
	# G7u: run-gate6.sh --legs g6l once per browser kind with G7U_LEGS (header "Group landed (G7u)").
	if has_group g7-lc; then
		mkdir -p "$OUT/gate6"
		for kb in "${LIVE_KINDS[@]}"; do
			kind="${kb%%:*}"
			bundle_dir="${kb#*:}"
			if [ "$HARNESS_ENV" = device ]; then
				legs_var="G7U_DEVICE_LEGS_$kind"
				run_name="lc-$kind-$DEVICE"
				start_var="G7U_DEVICE_START_FRAME_$kind"
				g7u_start="${G7U_START_FRAME:-${!start_var}}"
			else
				legs_var="G7U_LEGS_$kind"
				run_name="lc-$kind"
				g7u_start=""
			fi
			g7u_legs="${G7U_LEGS:-${!legs_var}}"
			run_dir="$OUT/gate6/$run_name"
			echo "run-gate7: g7-lc @$kind ($HARNESS_ENV${DEVICE:+ $DEVICE}): run-gate6.sh --legs g6l (G7U_LEGS=$g7u_legs) into $run_dir" >&2
			set +e
			GATE7_LIVE_KIND="$kind" GATE7_BUNDLE_DIR="$bundle_dir" GATE7_WEB_CORE="$WEB_CORE" \
				GATE7_BROWSER_SPARE=after GATE7_LIFECYCLE_ENV="$HARNESS_ENV" GATE7_DEVICE="$DEVICE" \
				G7U_LEGS="$g7u_legs" G7U_START_FRAME="$g7u_start" \
				bash "$SCRIPT_DIR/run-gate6.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
				--binary "$BINARY" --out "$run_dir" --legs g6l >"$OUT/gate6/$run_name.log" 2>&1
			g7u_exit=$?
			set -e
			echo "run-gate7: g7-lc run-gate6.sh @$kind exit=$g7u_exit (check-gate7.ts --live judges it)" >&2
			# A device run whose browser daemon cannot drive the phone fails here, loudly: it never
			# falls back to the desktop.
			if [ "$g7u_exit" != 0 ] && [ -f "$run_dir/gate7-browser/daemon.log" ] &&
				grep -q 'lifecycle: ' "$run_dir/gate7-browser/daemon.log"; then
				grep 'lifecycle: ' "$run_dir/gate7-browser/daemon.log" | head -3 | sed 's/^/run-gate7: g7-lc: /' >&2
				[ "$HARNESS_ENV" = device ] && exit 1
			fi
		done
	fi
	# G7k: run-gate6.sh --legs g6s (soak) and --legs g6l (startup, G7K_STARTUP_LEGS) once per
	# browser kind (header "Group landed (G7k)"). GATE7_MEM_SAMPLE=1 turns on the harness's memory
	# samplers (gate7k-samplers.ts) for every g7-k leg only, never any other group's.
	if has_group g7-k; then
		mkdir -p "$OUT/gate6"
		G7K_SOAK_LEGS_web="soak-scene,sabotage-soak-no-evict"
		G7K_SOAK_LEGS_gsw="soak-scene,sabotage-soak-no-evict,sabotage-leak-gl-textures"
		G7K_STARTUP_DEFAULT="startup-cold-r0,startup-cold-r1,startup-cold-r2,startup-cold-r3,startup-cold-r4,startup-cold-r5,startup-warm-r0,startup-warm-r1,startup-warm-r2,startup-warm-r3,startup-warm-r4,startup-warm-r5"
		for kb in "${LIVE_KINDS[@]}"; do
			kind="${kb%%:*}"
			bundle_dir="${kb#*:}"
			legs_var="G7K_SOAK_LEGS_$kind"
			g7k_soak_legs="${G7K_SOAK_LEGS:-${!legs_var}}"
			g7k_startup_legs="${G7K_STARTUP_LEGS:-$G7K_STARTUP_DEFAULT}"
			run_dir="$OUT/gate6/g6s-$kind"
			if [ "${G7K_SKIP_SOAK:-0}" != "1" ]; then
			echo "run-gate7: g7-k soak @$kind: run-gate6.sh --legs g6s (G6S_LEGS=$g7k_soak_legs) into $run_dir" >&2
			set +e
			GATE7_LIVE_KIND="$kind" GATE7_BUNDLE_DIR="$bundle_dir" GATE7_WEB_CORE="$WEB_CORE" \
				GATE7_WEB_FETCH="$WEB_FETCH" GATE7_BROWSER_SPARE=after GATE7_MEM_SAMPLE=1 \
				G6S_LEGS="$g7k_soak_legs" \
				bash "$SCRIPT_DIR/run-gate6.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
				--binary "$BINARY" --out "$run_dir" --legs g6s >"$OUT/gate6/g6s-$kind.log" 2>&1
			g7k_exit=$?
			set -e
			echo "run-gate7: g7-k soak run-gate6.sh @$kind exit=$g7k_exit (check-gate7.ts --live judges it)" >&2
			fi

			if [ "${G7K_SKIP_STARTUP:-0}" = "1" ]; then continue; fi
			run_dir="$OUT/gate6/startup-$kind"
			echo "run-gate7: g7-k startup @$kind: run-gate6.sh --legs g6l (G7K_STARTUP_LEGS=$g7k_startup_legs) into $run_dir" >&2
			set +e
			GATE7_LIVE_KIND="$kind" GATE7_BUNDLE_DIR="$bundle_dir" GATE7_WEB_CORE="$WEB_CORE" \
				GATE7_WEB_FETCH="$WEB_FETCH" GATE7_BROWSER_SPARE=after GATE7_MEM_SAMPLE=1 \
				G7K_STARTUP_LEGS="$g7k_startup_legs" GATE7_STATIC_CACHE=1 \
				bash "$SCRIPT_DIR/run-gate6.sh" --extension "$EXTENSION" --calibration "$CALIBRATION" \
				--binary "$BINARY" --out "$run_dir" --legs g6l >"$OUT/gate6/startup-$kind.log" 2>&1
			g7k_exit=$?
			set -e
			echo "run-gate7: g7-k startup run-gate6.sh @$kind exit=$g7k_exit (check-gate7.ts --live judges it)" >&2
		done
	fi
	# G7u: one 30-s lifecycle leg's host evidence (a 3180-frame scene recording, its patch sink, the
	# tap and the hook log, decoded) alone exceeds node's default 4 GB heap. G7k's soak (300 s) is
	# the same shape of problem.
	if has_group g7-lc || has_group g7-k; then
		export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=12288"
	fi
	echo "run-gate7: running check-gate7.ts --live" >&2
	cd "$REPO_ROOT"
	set +e
	gate7_checker mise exec -- pnpm exec tsx --conditions=development \
		"$SCRIPT_DIR/check-gate7.ts" --out "$OUT" --legs "$LEGS_ARG" --live --web-core "$WEB_CORE" \
		--web-fetch "$WEB_FETCH" ${RECEIVER:+--receiver "$RECEIVER"}
	exit $?
fi

# --- g7-0..g7-3 (G7e, G7a): the source runs, before anything else touches the machine. -----
CHECK_ARGS=(--out "$OUT" --legs "$LEGS_ARG")
[ -n "$RECEIVER" ] && CHECK_ARGS+=(--receiver "$RECEIVER")
want_gsw() { [ -z "$RECEIVER" ] || [ "$RECEIVER" = "gsw" ]; }
want_web() { [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; }
SOURCE_GATES=()
for g in 0 1 2 3 4 5 55 6; do
	has_group "g7-$g" || continue
	# G7s: gate 5.5's gsw half takes this path; its web half is G7b's (below).
	if [ "$g" = 55 ] && ! want_gsw; then continue; fi
	# G7g: so does gate 6's (its web half is G7b's).
	if [ "$g" = 6 ] && ! want_gsw; then continue; fi
	if [ "$HARNESS_ENV" != "desktop" ]; then
		echo "run-gate7: g7-$g runs on the desktop only (drop --env device)" >&2
		exit 2
	fi
	SOURCE_GATES+=("$g")
done
if [ "${#SOURCE_GATES[@]}" -gt 0 ]; then
	if [ ! -f "$EXTENSION" ]; then
		echo "run-gate7: g7-0..g7-6 and g7-55 need the capture extension ($EXTENSION; build-capture.sh or --extension)" >&2
		exit 1
	fi
	EXTENSION="$(realpath "$EXTENSION")"
fi
for g in "${SOURCE_GATES[@]}"; do
	if [ -z "${SOURCES[gate$g]:-}" ]; then
		if [ "$MAKE_SOURCES" = 0 ]; then
			echo "run-gate7: g7-$g needs --source gate$g=<run dir> or --make-sources" >&2
			exit 2
		fi
		echo "run-gate7: making the gate $g source run (run-gate$g.sh)" >&2
		# Gate 5.5: its file-leg groups only, the same source as G7b's web half (g55f is live, G7l).
		source_legs=()
		[ "$g" = 55 ] && source_legs=(--legs g55b,g55c,g55d,g55e)
		# Gate 6: g6a, g6h and g6b only (g6l is live, G7g's --live; g6s/g6c are timing groups).
		[ "$g" = 6 ] && source_legs=(--legs g6a,g6h,g6b)
		set +e
		bash "$SCRIPT_DIR/run-gate$g.sh" --extension "$EXTENSION" --calibration "$(realpath "$CALIBRATION")" \
			--out "$OUT/sources-made/gate$g" "${source_legs[@]}"
		gate_exit=$?
		set -e
		echo "run-gate7: run-gate$g.sh exit=$gate_exit (source-run-valid judges it)" >&2
		SOURCES[gate$g]="$OUT/sources-made/gate$g"
		g7tool source-provenance --extension "$EXTENSION" --out "${SOURCES[gate$g]}/gate7-source.json"
	fi
done
# G7b: the gates 1 to 6 sources (the same D21 rule as gate 0's).
G7B_GROUPS=(g7-1:gate1:run-gate1.sh:g1a,g1b g7-2:gate2:run-gate2.sh:g2a,g2b,g2d
	g7-3:gate3:run-gate3.sh:g3a,g3b,g3c,g3d g7-4:gate4:run-gate4.sh:g4a,g4b,g4c,g4d,g4e,g4f
	g7-5:gate5:run-gate5.sh:g5b,g5c,g5d,g5e,g5g g7-55:gate55:run-gate55.sh:g55b,g55c,g55d,g55e
	g7-6:gate6:run-gate6.sh:g6a,g6h,g6b)
G7B_RUN=()
for spec in "${G7B_GROUPS[@]}"; do
	IFS=: read -r group gate runner source_legs <<<"$spec"
	has_group "$group" && want_web || continue
	G7B_RUN+=("$group:$gate")
	if [ "$HARNESS_ENV" != "desktop" ]; then
		echo "run-gate7: $group runs on the desktop only (drop --env device)" >&2
		exit 2
	fi
	if [ -n "${SOURCES[$gate]:-}" ]; then
		continue
	fi
	if [ "$MAKE_SOURCES" = 0 ]; then
		echo "run-gate7: $group needs --source $gate=<run dir> or --make-sources" >&2
		exit 2
	fi
	if [ ! -f "$EXTENSION" ]; then
		echo "run-gate7: $group needs the capture extension ($EXTENSION; build-capture.sh or --extension)" >&2
		exit 1
	fi
	EXTENSION="$(realpath "$EXTENSION")"
	echo "run-gate7: making the $gate source run ($runner --legs $source_legs)" >&2
	set +e
	bash "$SCRIPT_DIR/$runner" --extension "$EXTENSION" --calibration "$(realpath "$CALIBRATION")" \
		--out "$OUT/sources-made/$gate" --legs "$source_legs"
	source_exit=$?
	set -e
	echo "run-gate7: $runner exit=$source_exit (source-run-valid judges it)" >&2
	SOURCES[$gate]="$OUT/sources-made/$gate"
	g7tool source-provenance --extension "$EXTENSION" --out "${SOURCES[$gate]}/gate7-source.json"
done
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
	g7h_selftest() {
		(cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
			"$SCRIPT_DIR/test/self-test-browser-harness.ts" --out "$OUT/g7h-probes")
	}
	quiet_run shared run-gate7:g7h-selftest -- g7h_selftest
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
		--arm gsw-ts --env device --device "$DEVICE" --inputs "$D/no-inputs.json" --out "$D" \
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
			bench --arm gsw-ts "${common[@]}" --out "$B"
		fi
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; then
			bench --arm web --core "$WEB_CORE" "${common[@]}" --out "$B"
		fi
	else
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "gsw" ]; then
			echo "run-gate7: g7-bench: gsw arm on $DEVICE (with the device probes)"
			bench --arm gsw-ts --env device --device "$DEVICE" "${common[@]}" --out "$B" --probes --hold-seconds "$HOLD_SECONDS"
		fi
		if [ -z "$RECEIVER" ] || [ "$RECEIVER" = "web" ]; then
			bench --arm web --core "$WEB_CORE" --env device --device "$DEVICE" "${common[@]}" --out "$B"
		fi
	fi
}

if has_group g7-0 && want_web; then
	if [ -z "$BUNDLE" ]; then
		BUNDLE="$(bash "$SCRIPT_DIR/build-web-receiver.sh" --core "$WEB_CORE" | tail -1)"
	fi
	BUNDLE="$(realpath "$BUNDLE")"
	echo "run-gate7: g7-0 web legs (bundle $BUNDLE)" >&2
	g7tool web-legs --group g7-0 --source "${SOURCES[gate0]}" --bundle "$BUNDLE" --out "$OUT" --core "$WEB_CORE"
	CHECK_ARGS+=(--bundle "$BUNDLE")
fi
if [ "${#SOURCE_GATES[@]}" -gt 0 ]; then
	SRC_LIST=""
	for g in "${SOURCE_GATES[@]}"; do SRC_LIST+="${SRC_LIST:+,}gate$g=${SOURCES[gate$g]}"; done
	CHECK_ARGS+=(--source "$SRC_LIST" --extension "$EXTENSION")
fi
if [ "${#SOURCE_GATES[@]}" -gt 0 ] && want_gsw; then
	# G7a: the core, the bundle, the goldens and the differential, once per run.
	if [ -z "$RS_BUILD" ]; then
		bash "$SCRIPT_DIR/build-rs-core.sh" >"$OUT/build-rs-core.log" 2>&1 || {
			echo "run-gate7: build-rs-core.sh failed, see $OUT/build-rs-core.log" >&2
			exit 1
		}
		RS_BUILD="$REPO_ROOT/artifacts/render-stream/rs-core/$(sed -n 's/^sha=//p' "$OUT/build-rs-core.log" | tail -1)"
	fi
	RS_BUILD="$(realpath "$RS_BUILD")"
	if [ -z "$GSW_BUNDLE" ]; then
		GSW_BUNDLE="$(g7tool gsw-bundle --out "$OUT/gsw-bundle-build" --rs-build "$RS_BUILD" | tail -1)"
	fi
	GSW_BUNDLE="$(realpath "$GSW_BUNDLE")"
	CHECK_ARGS+=(--gsw-bundle "$GSW_BUNDLE")
	mkdir -p "$OUT/rs-core"
	logged() {
		local log="$1"
		shift
		set +e
		"$@" >"$log" 2>&1
		echo "$?" >"$log.exit"
		set -e
	}
	echo "run-gate7: goldens through the core (native, wasm) and the differential" >&2
	logged "$OUT/rs-core/goldens-native.log" "$RS_BUILD/bin/rs-core-check" goldens --dir "$EXPERIMENT_DIR/protocol"
	logged "$OUT/rs-core/goldens-wasm.log" node "$SCRIPT_DIR/test/self-test-rs-core-wasm.mjs" --build "$RS_BUILD"
	g7tool source-inputs --source "$SRC_LIST" --out "$OUT/rs-core/source-inputs.json"
	logged "$OUT/rs-core/self-test-rs-core.log" bash -c "cd '$REPO_ROOT' && mise exec -- pnpm exec tsx --conditions=development '$SCRIPT_DIR/test/self-test-rs-core.ts' --inputs '$OUT/rs-core/source-inputs.json' --rs-core-check '$RS_BUILD/bin/rs-core-check'"
	for g in "${SOURCE_GATES[@]}"; do
		echo "run-gate7: g7-$g gsw legs (bundle $GSW_BUNDLE)" >&2
		g7tool gsw-legs --group "g7-$g" --source "${SOURCES[gate$g]}" --bundle "$GSW_BUNDLE" --out "$OUT"
		if [ "$g" = 1 ]; then
			mkdir -p "$OUT/gate1"
			logged "$OUT/gate1/ordering-model.log" env \
				RS_CORE_ORDERING_RECORDING="${SOURCES[gate1]}/capture/recording.rs2" \
				RS_CORE_ORDERING_SEQS="$(cat "${SOURCES[gate1]}/receiver/shot-seqs.txt")" \
				cargo test --offline --release --manifest-path "$EXPERIMENT_DIR/rs-core/Cargo.toml" \
				ordering_model -- --nocapture
		fi
	done
fi
if [ "${#G7B_RUN[@]}" -gt 0 ]; then
	if [ -z "$BUNDLE" ]; then
		BUNDLE="$(bash "$SCRIPT_DIR/build-web-receiver.sh" --core "$WEB_CORE" | tail -1)"
	fi
	BUNDLE="$(realpath "$BUNDLE")"
	EXTENSION="$(realpath "$EXTENSION")"
	for pair in "${G7B_RUN[@]}"; do
		group="${pair%%:*}"
		gate="${pair#*:}"
		echo "run-gate7: $group web legs ($gate, bundle $BUNDLE)" >&2
		g7tool web-legs --group "$group" --source "${SOURCES[$gate]}" --bundle "$BUNDLE" --out "$OUT" \
			--repeat-differing --core "$WEB_CORE"
		CHECK_ARGS+=(--source "$gate=${SOURCES[$gate]}")
	done
	case " ${CHECK_ARGS[*]} " in
	*" --bundle "*) ;;
	*) CHECK_ARGS+=(--bundle "$BUNDLE" --extension "$EXTENSION") ;;
	esac
fi
if has_group g7-dev; then
	if [ "$HARNESS_ENV" = "desktop" ]; then run_g7_dev_desktop; else run_g7_dev_device; fi
fi
if has_group g7-bench; then
	run_g7_bench
fi

echo "run-gate7: running check-gate7.ts" >&2
cd "$REPO_ROOT"
gate7_checker mise exec -- pnpm exec tsx --conditions=development \
	"$SCRIPT_DIR/check-gate7.ts" "${CHECK_ARGS[@]}"
