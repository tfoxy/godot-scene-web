#!/usr/bin/env bash
# Gate 6 group g6p (protocol/gate6-design.md "G6p", Q7g): the measurement matrix -- one discarded
# warmup plus five measured repeats per scenario, cold and warm caches kept apart, on
# render-stream/6. Sourced by run-gate6.sh after lib/gate6c-legs.sh, which it reuses heavily:
# g6c_start_host, g6c_start_receiver, g6c_start_proxy/g6c_stop_proxy, g6c_wait_receiver,
# g6c_finish_host, g6c_reference and g6c_sampler all run the SAME `rate` timeline window
# (gate6-design.md Q6c/Q7d) this group's lib/gate6p-checks.ts measures with gate6c-checks.ts's own
# `loadG6cLeg`/`measureLeg`/`repeatOf`. Relies on run-gate6.sh's OUT, BINARY, EXTENSION,
# CALIBRATION, SCENE_FIXTURE_DIR, HD_FIXTURE_DIR, RECEIVER_DIR, SCRIPT_DIR, REPO_ROOT,
# ACTUAL_BINARY_SHA256 and EXTRA_CHILD_PIDS, and gate6c-legs.sh's g6c_* helpers.
#
# D11's three arms: `unarmed` (no capture extension loaded at all -- no GRC_* env, no listener, no
# receiver) measures host frame rate the only way available without extension instrumentation: a
# wall-clock slope over RS_FIXTURE_STEP_LOG's step lines (scripts/sample-rate.ts; D6's realtime
# pacing makes one game second one wall-clock second here). `armed-idle` is g6c's own
# `rate-baseline` shape (armed, listening, no subscriber). `streaming` runs a receiver (or two, for
# `dual-60-15`) exactly as g6c's rate/uncapped/mismatch/dual legs do.
#
# Warm cache (the default): one shared `<scenario>/shared-cache` directory for the warmup and all
# five repeats (RS_RECEIVER_CACHE_DIR override via G6C_RECEIVER_ENV), so every measured repeat
# starts from the warmup's fully-populated cache. Cold cache: each repeat (warmup included) gets
# its own fresh `<repeat>/receiver/cache` -- g6c_start_receiver's own default, so no override is
# needed; every repeat re-fetches from nothing.
#
# Under <out>/matrix/: import/{fixture,receiver,hd-fixture}/, provenance-input.json, and per
# scenario <id>/{warmup,1,2,3,4,5}/{host,receiver[,receiver-a,receiver-b][,proxy],reference}/, the
# same per-repeat shape gate6c-legs.sh writes per leg (loadG6cLeg reads either identically).

G6P_DIR_NAME="matrix"

# g6p_provenance_input: as g6c_provenance_input, into <out>/matrix/provenance-input.json.
g6p_provenance_input() {
	local lib receiver_sha
	lib="$(sed -n 's/^linux.x86_64 = "\(.*\)"$/\1/p' "$EXTENSION")"
	receiver_sha="$(cd "$RECEIVER_DIR" && find . -maxdepth 1 -type f \( -name '*.gd' -o -name '*.tscn' -o -name 'project.godot' \) | sort | xargs sha256sum | sha256sum | awk '{print $1}')"
	printf '{"engine_sha256":"%s","library_path":"%s","library_sha256":"%s","calibration":"%s","receiver_project_sha256":"%s","gamescope_sizes":[[640,360],[1920,1080],[960,540]]}\n' \
		"$ACTUAL_BINARY_SHA256" "$lib" "$(sha256sum "$lib" | awk '{print $1}')" "$CALIBRATION" "$receiver_sha" \
		>"$G6P/provenance-input.json"
}

# g6p_run_unarmed <scenario id> <fixture dir> <host max fps>: warmup + 5 repeats with NO capture
# extension loaded at all (D11). Each repeat's host runs the fixture's `rate` timeline directly
# (no GRC_* env, no listener), sampled by a /proc sampler throughout and, for the 5 measured
# repeats only (not the discarded warmup), scripts/sample-rate.ts's wall-clock step-log slope.
g6p_run_unarmed() {
	local id="$1" fixture="$2" fps="$3" D label pid
	echo "run-gate6: g6p: $id (warmup + 5 repeats, unarmed: no extension)"
	for label in warmup 1 2 3 4 5; do
		D="$G6P/$id/$label"
		mkdir -p "$D/host"
		LEG_ENV=(
			RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate
			RS_FIXTURE_STEP_LOG="$D/host/steps.jsonl"
		)
		start_headless_bg "$D/host" -- "$BINARY" --headless --max-fps "$fps" --path "$fixture"
		pid="$BG_PID"
		EXTRA_CHILD_PIDS+=("$pid")
		g6c_sampler "$pid" "$D/host/proc-samples.jsonl"
		if [ "$label" != "warmup" ]; then
			(
				cd "$REPO_ROOT" && mise exec -- pnpm exec tsx --conditions=development \
					"$SCRIPT_DIR/sample-rate.ts" --pid "$pid" --steps "$D/host/steps.jsonl" \
					--out "$D/host/wall-rate.json"
			) >"$D/host/sample-rate.log" 2>&1 || true
		fi
		finish_bg "$D/host" "$pid" "$HEADLESS_TIMEOUT_S"
	done
}

# g6p_run_armed_idle <scenario id> <fixture dir> <host max fps>: warmup + 5 repeats, armed,
# listening, no subscriber (g6c's own rate-baseline shape).
g6p_run_armed_idle() {
	local id="$1" fixture="$2" fps="$3" D label
	echo "run-gate6: g6p: $id (warmup + 5 repeats, armed-idle: no subscriber)"
	for label in warmup 1 2 3 4 5; do
		D="$G6P/$id/$label"
		g6c_start_host "$D/host" "$fixture" "$fps" RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate
		g6c_finish_host "$D/host"
	done
}

# g6p_run_scenario: warmup + 5 repeats of a `streaming` scenario, reading its definition from the
# G6P_SCN_* scratch globals (set by the caller right before the call; all reset here). Warm cache
# (G6P_SCN_CACHE=warm, the default) points every repeat's receiver(s) at one shared cache
# directory under the scenario; cold leaves each repeat's default (fresh, per-repeat) cache.
G6P_SCN_ID=""
G6P_SCN_FIXTURE=""
G6P_SCN_HOST_FPS=60
G6P_SCN_TARGET_FPS=""
G6P_SCN_RECV_FPS=""
G6P_SCN_DUAL=0
G6P_SCN_CACHE="warm"
G6P_SCN_HOOK_LOG="off"
G6P_SCN_TRANSPORT="loopback"
G6P_SCN_ROOT_SIZE="enforce-min-size"
G6P_SCN_RESOLUTION_ARGS=()
G6P_SCN_REFERENCE_ARGS=()
g6p_run_scenario() {
	local id="$G6P_SCN_ID" fixture="$G6P_SCN_FIXTURE" host_fps="$G6P_SCN_HOST_FPS" \
		target="$G6P_SCN_TARGET_FPS" recv_fps="$G6P_SCN_RECV_FPS" dual="$G6P_SCN_DUAL" \
		cache="$G6P_SCN_CACHE" hook="$G6P_SCN_HOOK_LOG" transport="$G6P_SCN_TRANSPORT" \
		root_size="$G6P_SCN_ROOT_SIZE" label D shared_cache port cache_dir pid_a pid_b
	local -a resolution_args=() reference_args=()
	[ "${#G6P_SCN_RESOLUTION_ARGS[@]}" -gt 0 ] && resolution_args=("${G6P_SCN_RESOLUTION_ARGS[@]}")
	[ "${#G6P_SCN_REFERENCE_ARGS[@]}" -gt 0 ] && reference_args=("${G6P_SCN_REFERENCE_ARGS[@]}")
	G6P_SCN_ID=""
	G6P_SCN_FIXTURE=""
	G6P_SCN_HOST_FPS=60
	G6P_SCN_TARGET_FPS=""
	G6P_SCN_RECV_FPS=""
	G6P_SCN_DUAL=0
	G6P_SCN_CACHE="warm"
	G6P_SCN_HOOK_LOG="off"
	G6P_SCN_TRANSPORT="loopback"
	G6P_SCN_ROOT_SIZE="enforce-min-size"
	G6P_SCN_RESOLUTION_ARGS=()
	G6P_SCN_REFERENCE_ARGS=()

	echo "run-gate6: g6p: $id (warmup + 5 repeats, cache $cache, hook log $hook, transport $transport)"
	shared_cache="$G6P/$id/shared-cache"
	for label in warmup 1 2 3 4 5; do
		D="$G6P/$id/$label"
		local -a host_env=(RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate GRC_ROOT_SIZE="$root_size")
		[ -n "$target" ] && host_env+=(GRC_PUBLISH_FPS="$target")
		[ "$hook" = "on" ] && host_env+=(GRC_HOOK_LOG=on)
		[ "$dual" = "1" ] && host_env+=(GRC_LIVE_MAX_CONNECTIONS=2)
		g6c_start_host "$D/host" "$fixture" "$host_fps" "${host_env[@]}"
		port="$G6C_PORT"
		if [ "$transport" = "constrained" ]; then
			g6c_start_proxy "$D/proxy" "$G6C_PORT"
			port="$G6C_PROXY_PORT"
		fi
		# A shared cache directory is created empty by the warmup's own "fresh" open (the
		# default mode: absent-or-empty, created on open) and reused by every measured repeat
		# with an explicit "warm" open (the only other mode: the directory must already exist).
		# Passing "warm" on the warmup itself would fail with cache-not-fresh, since nothing has
		# created the directory yet (receiver/rs_resource_cache.gd "open").
		local -a warm_mode_env=()
		[ "$cache" = "warm" ] && [ "$label" != "warmup" ] && warm_mode_env=(RS_RECEIVER_CACHE_MODE=warm)
		if [ "$dual" = "1" ]; then
			cache_dir="$shared_cache"
			[ "$cache" = "cold" ] && cache_dir="$D/receiver"
			G6C_RECEIVER_ENV=(RS_RECEIVER_CACHE_DIR="${cache_dir}-b" "${warm_mode_env[@]}")
			g6c_start_receiver "$D/receiver-b" "$port" 15 "${resolution_args[@]}"
			pid_b="$G6C_RECEIVER_PID"
			G6C_RECEIVER_ENV=(RS_RECEIVER_CACHE_DIR="${cache_dir}-a" "${warm_mode_env[@]}")
			g6c_start_receiver "$D/receiver-a" "$port" 60 "${resolution_args[@]}"
			pid_a="$G6C_RECEIVER_PID"
			g6c_wait_receiver "$D/receiver-a" "$pid_a"
			g6c_wait_receiver "$D/receiver-b" "$pid_b"
		elif [ -n "$recv_fps" ]; then
			if [ "$cache" = "warm" ]; then
				G6C_RECEIVER_ENV=(RS_RECEIVER_CACHE_DIR="$shared_cache" "${warm_mode_env[@]}")
			fi
			g6c_start_receiver "$D/receiver" "$port" "$recv_fps" "${resolution_args[@]}"
			g6c_wait_receiver "$D/receiver" "$G6C_RECEIVER_PID"
		fi
		g6c_finish_host "$D/host"
		[ "$transport" = "constrained" ] && g6c_stop_proxy "$D/proxy"
		# The warmup is discarded (report-gate6.ts: "{run_dir}, discarded; not read") -- no
		# reference is read for it, so skip the extra render.
		if [ "$label" != "warmup" ] && { [ "$dual" = "1" ] || [ -n "$recv_fps" ]; }; then
			G6C_REFERENCE_ARGS=("${reference_args[@]}")
			g6c_reference "$D" "$fixture" RS_FIXTURE_VARIANT=animate
		fi
	done
}

run_g6p() {
	G6P="$OUT/$G6P_DIR_NAME"
	mkdir -p "$G6P/import"
	echo "run-gate6: g6p: import (fixture, receiver, hd-fixture)"
	LEG_ENV=()
	run_headless "$G6P/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$G6P/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	LEG_ENV=()
	run_headless "$G6P/import/hd-fixture" none -- mise exec -- godot --headless --path "$HD_FIXTURE_DIR" --import
	local which
	for which in fixture receiver hd-fixture; do
		if [ "$(cat "$G6P/import/$which/exit-code.txt")" != "0" ]; then
			echo "run-gate6: g6p: import $which failed, see $G6P/import/$which/stdout.log" >&2
			exit 1
		fi
	done
	g6p_provenance_input

	echo "run-gate6: g6p: unarmed and armed-idle arms (no gamescope needed)"
	g6p_run_unarmed scene-unarmed "$SCENE_FIXTURE_DIR" 60
	g6p_run_armed_idle scene-armed-idle "$SCENE_FIXTURE_DIR" 60
	g6p_run_unarmed hd-native-unarmed "$HD_FIXTURE_DIR" 60
	g6p_run_armed_idle hd-native-armed-idle "$HD_FIXTURE_DIR" 60

	echo "run-gate6: bringing up private gamescope 640x360 for g6p gate6-scene streaming scenarios"
	gs_start 640 360 "$OUT/gamescope-g6p-scene"
	g6c_session_display_proof "$G6P/display-socket-proof-640x360.json"

	G6P_SCN_ID=scene-rate-15
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=15
	G6P_SCN_RECV_FPS=60
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-30
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=30
	G6P_SCN_RECV_FPS=60
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-60
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-uncapped-host60
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_RECV_FPS=60
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-uncapped
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_HOST_FPS=0
	G6P_SCN_RECV_FPS=0
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-60-cold
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_CACHE=cold
	g6p_run_scenario

	G6P_SCN_ID=scene-rate-60-hooklog
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_HOOK_LOG=on
	g6p_run_scenario

	G6P_SCN_ID=scene-constrained-60
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_TRANSPORT=constrained
	g6p_run_scenario

	G6P_SCN_ID=scene-dual-60-15
	G6P_SCN_FIXTURE="$SCENE_FIXTURE_DIR"
	G6P_SCN_DUAL=1
	g6p_run_scenario

	gs_teardown "$OUT/gamescope-g6p-scene"
	GS_RUN_DIR=""

	echo "run-gate6: bringing up private gamescope 1920x1080 for g6p gate6-hd native streaming scenarios"
	gs_start 1920 1080 "$OUT/gamescope-g6p-hd-native"
	g6c_session_display_proof "$G6P/display-socket-proof-1920x1080.json"

	G6P_SCN_ID=hd-native-rate-15
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=15
	G6P_SCN_RECV_FPS=60
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	G6P_SCN_ID=hd-native-rate-30
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=30
	G6P_SCN_RECV_FPS=60
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	G6P_SCN_ID=hd-native-rate-60
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	G6P_SCN_ID=hd-native-rate-uncapped-host60
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_RECV_FPS=60
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	G6P_SCN_ID=hd-native-rate-uncapped
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_HOST_FPS=0
	G6P_SCN_RECV_FPS=0
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	G6P_SCN_ID=hd-native-rate-60-cold
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_CACHE=cold
	G6P_SCN_RESOLUTION_ARGS=(--resolution 1920x1080)
	G6P_SCN_REFERENCE_ARGS=(--resolution 1920x1080)
	g6p_run_scenario

	gs_teardown "$OUT/gamescope-g6p-hd-native"
	GS_RUN_DIR=""

	echo "run-gate6: bringing up private gamescope 960x540 for g6p gate6-hd half streaming scenario"
	gs_start 960 540 "$OUT/gamescope-g6p-hd-half"
	g6c_session_display_proof "$G6P/display-socket-proof-960x540.json"

	G6P_SCN_ID=hd-half-rate-60
	G6P_SCN_FIXTURE="$HD_FIXTURE_DIR"
	G6P_SCN_TARGET_FPS=60
	G6P_SCN_RECV_FPS=60
	G6P_SCN_ROOT_SIZE="presentation:960x540"
	G6P_SCN_RESOLUTION_ARGS=(--resolution 960x540)
	G6P_SCN_REFERENCE_ARGS=(--resolution 960x540)
	g6p_run_scenario

	gs_teardown "$OUT/gamescope-g6p-hd-half"
	GS_RUN_DIR=""
}
