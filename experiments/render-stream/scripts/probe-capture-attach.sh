#!/usr/bin/env bash
# Rendered late-load evidence, standby counters, and resident detach/attach browser proof.
# Uses runner-owned projects; never changes the source fixtures or capture implementation.
# Usage: probe-capture-attach.sh --out DIR [--gsw-bundle DIR] [--cycle [--sabotage-detach]] [--resources] [--large-textures] [--extension FILE]
# Prerequisites: build-capture.sh. Default replay also needs receiver --import + build-rs-core-ext.sh.
# --cycle requires --gsw-bundle (build-rs-core.sh + gate7-tool.ts gsw-bundle) and Python Pillow.
# This is correctness evidence, not a timing A/B.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXPERIMENT_DIR/../.." && pwd)"
OUT=""
BUNDLE=""
CYCLE=0
SABOTAGE_DETACH=0
RESOURCES=0
LARGE_TEXTURES=0
PROBE_CALIBRATION=""
PROBE_EXTENSION=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	--out) OUT="$2"; shift 2 ;;
	--gsw-bundle) BUNDLE="$(realpath "$2")"; shift 2 ;;
	--calibration) PROBE_CALIBRATION="$(realpath "$2")"; shift 2 ;;
	--extension) PROBE_EXTENSION="$(realpath "$2")"; shift 2 ;;
	--cycle) CYCLE=1; shift ;;
	--resources) RESOURCES=1; CYCLE=1; shift ;;
	--large-textures) LARGE_TEXTURES=1; RESOURCES=1; CYCLE=1; shift ;;
	--sabotage-detach) SABOTAGE_DETACH=1; shift ;;
	--help|-h) sed -n '2,6p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
[ -n "$OUT" ] || { echo '--out is required' >&2; exit 2; }
if [ -n "$PROBE_EXTENSION" ]; then
	[ -f "$PROBE_EXTENSION" ] || { echo "missing extension: $PROBE_EXTENSION" >&2; exit 2; }
else
	[ -f "$EXPERIMENT_DIR/capture/build/librender_stream_capture.so" ] || {
	echo 'run build-capture.sh first' >&2; exit 2;
	}
fi
if [ "$CYCLE" != 1 ] && [ ! -f "$EXPERIMENT_DIR/receiver/ext/build/librs_core_ext.so" ]; then
	echo 'run the receiver import and build-rs-core-ext.sh first' >&2; exit 2
fi
if [ -n "$BUNDLE" ] && [ ! -f "$BUNDLE/build.json" ]; then
	echo "no GSW build.json in $BUNDLE" >&2; exit 2
fi
if [ "$SABOTAGE_DETACH" = 1 ] && [ "$CYCLE" != 1 ]; then
	echo '--sabotage-detach requires --cycle' >&2; exit 2
fi
if [ "$CYCLE" = 1 ] && [ -z "$BUNDLE" ]; then
	echo '--cycle requires --gsw-bundle' >&2; exit 2
fi
OUT="$(realpath -m "$OUT")"
[ ! -e "$OUT" ] || { echo "output already exists: $OUT" >&2; exit 2; }
mkdir -p "$OUT"
BINARY="$HOME/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64"
EXTENSION="${PROBE_EXTENSION:-$EXPERIMENT_DIR/capture/build/render_stream_capture.gdextension}"
CALIBRATION="${PROBE_CALIBRATION:-$EXPERIMENT_DIR/calibration/godot-4.5.1-stable-linux-release.json}"
RECEIVER_DIR="$EXPERIMENT_DIR/receiver"
FIXTURE_DIR=""
HEADLESS_TIMEOUT_S=120
RENDERED_TIMEOUT_S=60
HAVE_STRACE=0
LEGS_LOG=probe-capture-attach
# This by-hand correctness probe never inherits a gate's filtering or acceleration.
unset RS_SMOKE_LEGS RS_SABOTAGE_TIER RS_FAST_FRAMES GATE7_SMOKE_LEGS GATE7_FAST_FRAMES RS_LEG_SHARDS
source "$SCRIPT_DIR/lib/gamescope.sh"
# Use the existing private browser daemon and provenance checks for resident cycles.
GATE7_LIVE_KIND=""
if [ "$CYCLE" = 1 ]; then
	GATE7_LIVE_KIND=gsw
	GATE7_BUNDLE_DIR="$BUNDLE"
fi
source "$SCRIPT_DIR/lib/legs.sh"
RESIDENT_RUNNER_PID=""
cleanup() {
	if [ -n "$RESIDENT_RUNNER_PID" ]; then
		kill -TERM "$RESIDENT_RUNNER_PID" 2>/dev/null || true
		wait "$RESIDENT_RUNNER_PID" 2>/dev/null || true
	fi
	gate7_daemon_stop
	if [ -n "${CURRENT_CHILD_PID:-}" ] && kill -0 "$CURRENT_CHILD_PID" 2>/dev/null; then
		kill "$CURRENT_CHILD_PID" 2>/dev/null || true
	fi
	if [ -n "${GS_RUN_DIR:-}" ]; then gs_teardown "$GS_RUN_DIR" || true; fi
}
trap cleanup EXIT
if [ "$CYCLE" = 1 ]; then
	# One rendered host, three browser streams, two resident detach/re-attach cycles.
	fixture="$OUT/project"
	mkdir -p "$fixture" "$OUT/resident/evidence"
	cp "$EXPERIMENT_DIR/fixtures/live-swap/loader.gd" "$fixture/"
	cp "$SCRIPT_DIR/lib/resident-attach-probe.gd" "$fixture/resident_probe.gd"
	if [ "$RESOURCES" = 1 ]; then
		cp "$SCRIPT_DIR/lib/late-attach-resources.gd" "$fixture/late_resources.gd"
	fi
	python3 - "$EXPERIMENT_DIR/fixtures/live-swap/project.godot" "$fixture" <<'PYPROJECT'
from pathlib import Path
import sys
source, dest = Path(sys.argv[1]), Path(sys.argv[2])
project = source.read_text().replace('res://live_swap.tscn', 'res://main.tscn')
project = project.replace('GrcLoader="*res://loader.gd"', '')
project = project.replace('SwapDriver="*res://swap_driver.gd"', 'ResidentProbe="*res://resident_probe.gd"')
if (dest / 'late_resources.gd').exists():
    project = project.replace('res://resident_probe.gd', 'res://late_resources.gd')
(dest / 'project.godot').write_text(project)
(dest / 'main.tscn').write_text('[gd_scene format=3]\n\n[node name="Main" type="Node2D"]\n')
PYPROJECT
	LEG_ENV=()
	run_headless "$OUT/import" none -- mise exec -- godot --headless --path "$fixture" --import
	[ "$(cat "$OUT/import/exit-code.txt")" = 0 ]
	if rg -q 'SCRIPT ERROR|Parse Error' "$OUT/import/stdout.log"; then
		echo "resident probe: fixture import failed; see import/stdout.log" >&2; exit 1
	fi
	gs_start 640 360 "$OUT/gamescope-resident"
	RESIDENT_PROTOCOL=12
	if [ "$RESOURCES" = 1 ]; then RESIDENT_PROTOCOL=16; fi
	LEG_ENV=(GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=detached
		GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_STREAM_VERSION="$RESIDENT_PROTOCOL" GRC_VALIDATION_LOG=off
		GRC_PARTICLES=on GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0
		GRC_EVIDENCE_DIR="$OUT/resident/evidence" GRC_LIVE_LISTEN="127.0.0.1:0"
		GRC_LIVE_ALLOWED_ORIGINS="http://127.0.0.1:$GATE7_HARNESS_PORT"
		RS_RESIDENT_LARGE_TEXTURES="$LARGE_TEXTURES" RS_RESIDENT_OUT="$OUT/resident" RS_RESIDENT_SKIP_DETACH="$SABOTAGE_DETACH" XDG_DATA_HOME="$OUT/resident/xdg-data")
	RENDERED_TIMEOUT_S=300
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	(
		trap 'if [ -n "${CURRENT_CHILD_PID:-}" ]; then kill "$CURRENT_CHILD_PID" 2>/dev/null || true; wait "$CURRENT_CHILD_PID" 2>/dev/null || true; fi' EXIT
		trap 'exit 143' TERM INT
		run_rendered "$OUT/resident/host" "$fixture"
	) &
	RESIDENT_RUNNER_PID=$!
	wait_marker() {
		local ticks=0
		while [ ! -s "$1" ]; do
			if ! kill -0 "$RESIDENT_RUNNER_PID" 2>/dev/null || [ -f "$OUT/resident/failure.json" ] || [ "$ticks" -ge 1800 ]; then
				echo "resident probe: waiting for $1 failed; see resident/host/stdout.log" >&2
				return 1
			fi
			sleep 0.1
			ticks=$((ticks + 1))
		done
	}
	# Large payload fetch/transcode can exceed the small fixture's one-second receiver window.
	# Leave time for the attached proxy update after the complete first snapshot is applied.
	RECEIVER_STOP_S=1
	if [ "$LARGE_TEXTURES" = 1 ]; then RECEIVER_STOP_S=5; fi
	for round in 0 1 2; do
		wait_marker "$OUT/resident/ready-$round.json"
		dir="$OUT/resident/browser-$round"
		mkdir -p "$dir"
		python3 - "$OUT/resident/ready-$round.json" "$dir" <<'PYTOKEN'
import json, sys
from pathlib import Path
info = json.loads(Path(sys.argv[1]).read_text())['info']
Path(sys.argv[2], 'token').write_text(info['token'])
Path(sys.argv[2], 'url').write_text(info['listen'])
PYTOKEN
		LEG_ENV=(RS_RECEIVER_MODE=live RS_RECEIVER_PROTOCOL="$RESIDENT_PROTOCOL"
			RS_RECEIVER_URL="ws://$(cat "$dir/url")/render-stream"
			RS_RECEIVER_TOKEN_FILE="$dir/token" RS_RECEIVER_OUT="$dir/applied.json"
			RS_RECEIVER_LIVE_STOP_S="$RECEIVER_STOP_S" RS_RECEIVER_SHOT_FINAL=1)
		RENDERED_EXTRA_ARGS=(--resolution 640x360 --max-fps 60)
		run_rendered "$dir" "$RECEIVER_DIR"
		[ "$(cat "$dir/exit-code.txt")" = 0 ]
		echo '{}' >"$OUT/resident/stream-$round.done"
		wait_marker "$OUT/resident/busy-$round.done"
		# Independent OS proof: the former live listener cannot accept while detached.
		python3 "$SCRIPT_DIR/lib/check-attach-resident.py" --offline "$OUT/resident" "$round"
		echo '{}' >"$OUT/resident/resume-$round.done"
	done
	wait_marker "$OUT/resident/finished.json"
	wait "$RESIDENT_RUNNER_PID"
	RESIDENT_RUNNER_PID=""
	[ "$(cat "$OUT/resident/host/exit-code.txt")" = 0 ]
	legs_run_checker python3 "$SCRIPT_DIR/lib/check-attach-resident.py" "$OUT/resident"
	if [ "$RESOURCES" = 1 ]; then
		legs_run_checker python3 "$SCRIPT_DIR/lib/check-late-attach-resources.py" "$OUT/resident"
	fi
	echo "probe-capture-attach: resident evidence $OUT"
	exit 0
fi
for group in g8mm g8pt; do
	fixture="$OUT/projects/$group"
	mkdir -p "$fixture"
	cp "$EXPERIMENT_DIR/fixtures/gate8-${group#g8}"/* "$fixture/"
	cp "$SCRIPT_DIR/lib/attach-probe.gd" "$fixture/attach_probe.gd"
	python3 - "$fixture/project.godot" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('[autoload]', '[autoload]\nAttachProbe="*res://attach_probe.gd"'))
PY
	LEG_ENV=()
	run_headless "$OUT/$group/import" none -- mise exec -- godot --headless --path "$fixture" --import
	[ "$(cat "$OUT/$group/import/exit-code.txt")" = 0 ]
	gs_start 640 360 "$OUT/gamescope-$group"
	for mode in reference standby late; do
		dir="$OUT/$group/$mode"
		[ "$mode" = late ] && dir="$OUT/$group/capture"
		mkdir -p "$dir/shots" "$dir/evidence" "$dir/store"
		LEG_ENV=(RS_FIXTURE_SHOT_DIR="$dir/shots" RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
			RS_FIXTURE_QUIT_FRAME=120 RS_ATTACH_PROBE_LOG="$dir/readback.jsonl"
			XDG_DATA_HOME="$dir/xdg-data")
		if [ "$mode" != reference ]; then
			LEG_ENV+=(GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION"
				GRC_ADOPT=arm GRC_UNKNOWN_ITEM=skip GRC_VALIDATION_LOG=off
				GRC_EVIDENCE_DIR="$dir/evidence" GRC_STREAM_VERSION=12)
			if [ "$mode" = standby ]; then
				LEG_ENV+=(GRC_MODE=standby)
			else
				LEG_ENV+=(GRC_MODE=arm RS_FIXTURE_ARM=late RS_FIXTURE_ARM_FRAME=12
					GRC_STREAM_OUT="$dir/recording.rs12" GRC_RESOURCE_STORE_DIR="$dir/store")
			fi
		fi
		RENDERED_EXTRA_ARGS=(--max-fps 60)
		run_rendered "$dir" "$fixture"
		[ "$(cat "$dir/exit-code.txt")" = 0 ]
	done
	RECORDING_NAME=recording.rs12
	RECEIVER_EXTRA_ENV=(RS_RECEIVER_PROTOCOL=12)
	RECEIVER_STATE=1
	RENDERED_EXTRA_ARGS=(--max-fps 60)
	run_rendered_receiver "$OUT/$group/capture" "$OUT/$group/receiver"
	[ "$(cat "$OUT/$group/receiver/exit-code.txt")" = 0 ]
	gs_teardown "$OUT/gamescope-$group"
	GS_RUN_DIR=""
done
if [ -n "$BUNDLE" ]; then
	mise exec -- pnpm exec tsx --conditions=development -e '
		const { readFileSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const [scripts, source, bundle] = process.argv.slice(1);
		const { gswLegSpecs } = require(join(scripts, "lib/gate7-gsw.ts"));
		const { runWebLegs } = require(join(scripts, "lib/gate7-web-legs.ts"));
		const out = join(source, "browser");
		const wanted = new Set(["g8mm/receiver", "g8pt/receiver"]);
		const specs = gswLegSpecs("gate8", source, join(out, "gate8/gsw"))
			.filter(s => wanted.has(s.leg));
		const build = JSON.parse(readFileSync(join(bundle, "build.json"), "utf8"));
		runWebLegs({out, gate: "gate8", sourceDir: source, bundleDir: bundle,
			buildSha256: build.sha256, kind: "gsw"}, specs).then(results => {
			writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
			if (results.length !== 2 || results.some(r => r.exitCode !== 0 || !r.provenanceOk))
				process.exitCode = 1;
		}).catch(error => { console.error(error); process.exitCode = 1; });
	' "$SCRIPT_DIR" "$OUT" "$BUNDLE"
fi
quiet_summary "$OUT" "$(quiet__secs "$LEGS_QUIET_T0" "$EPOCHREALTIME")"
echo "probe-capture-attach: evidence $OUT"
