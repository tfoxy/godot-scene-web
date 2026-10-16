#!/usr/bin/env bash
# Gate 6 group g6c (protocol/gate6-design.md "G6c", Q7b, Q7d): publication rates, rate mismatch,
# two receivers on one host, an injected receiver delay kept apart from a GPU-limited receiver, and
# a constrained transport, on render-stream/6. Sourced by run-gate6.sh after lib/legs.sh; it relies
# on run-gate6.sh's OUT, BINARY, EXTENSION, CALIBRATION, SCENE_FIXTURE_DIR, HD_FIXTURE_DIR,
# RECEIVER_DIR, SCRIPT_DIR, REPO_ROOT and EXTRA_CHILD_PIDS (stopped by its cleanup trap).
#
# Every leg runs the fixture's `rate` timeline (step k at game time 5 + k s for k <= 10, step 11 at
# 28 s, quit at 30 s; measured window [6 s, 26 s]) in `realtime` time (D6), the `animate` variant
# (gpu-heavy: gate6-hd's `gpu-heavy`), with GRC_HOOK_LOG=off, no file sink and no live tap (D11:
# the legs are timed). Evidence is the host's evidence/{perf.json,perf-timeline.jsonl,
# live-summary.json}, steps.jsonl (step 11's `freeze` leftovers) and a runner-side /proc sampler
# (proc-samples.jsonl, scripts/sample-proc.ts), and each receiver's applied.json, perf.json
# (RS_RECEIVER_PERF_OUT), proc-samples.jsonl and shots/final.png (RS_RECEIVER_SHOT_FINAL: the last
# applied state after the end record). Under <out>/rates/:
#   import/{fixture,receiver,hd-fixture}/   editor --import passes
#   <leg>/host/                             the live host (headless, armed, listening)
#   <leg>/receiver/ (dual: receiver-a/, receiver-b/)   rendered live receivers
#   <leg>/proxy/                            constrained legs: throttle-proxy.ts's stdout and stats.json
#   <leg>/reference/                        the rendered reference of the leg's final state: the
#                                           fixture's file timeline with RS_FIXTURE_FREEZE_STATE set
#                                           to the host's own step-11 `freeze` (shots/step-11.png)
#   gpu-heavy-calibration/round-<n>/{host,receiver}/ and calibration.json (the chosen iterations)
#   provenance-input.json                   what the shell knows for render-stream-report/1
# G6C_LEGS (runner environment, optional): a CSV of the legs to run (development); unset: all.

G6C_DIR_NAME="rates"
# Q6c's rate timeline runs 30 s of game time; a host gets this long to quit.
G6C_HOST_TIMEOUT_S=120
G6C_RECEIVER_TIMEOUT_S=150
# Q6e: G6c calibrates `iterations` until the receiver's GPU time is about this.
G6C_TARGET_GPU_MS=40
G6C_BURN_START=8000
G6C_CALIBRATION_ROUNDS=5
G6C_CALIBRATION_QUIT_FRAME=480
# The constrained sabotage: ignore-credit from game time ~15 s (after step 9 freed TEXA), and a
# later quit so the backlog it builds in front of the 4 Mbit/s link drains after step 11's freeze
# (gate6-design.md "As built (G6c)").
G6C_SABOTAGE_FRAME=900
G6C_SABOTAGE_QUIT_S=75
# Every payload inline on the sabotage leg: over HTTP, D7's pin ("the last transaction sent")
# assumes credit, so ignore-credit on a slow link retires payloads before the receiver fetches
# them (HTTP 404, resource-unavailable: measured), which is not the queue this leg is for.
G6C_INLINE_MAX_BYTES=1048576
G6C_ALL_LEGS=(rate-baseline rate-15 rate-30 rate-60 rate-uncapped-host60 rate-uncapped mismatch-60-recv30
	mismatch-15-recv60 dual-60-15 recv-delay constrained sabotage-constrained-ignore-credit gpu-heavy)

g6c_wanted() {
	[ -z "${G6C_LEGS:-}" ] && return 0
	case ",$G6C_LEGS," in
	*",$1,"*) return 0 ;;
	esac
	return 1
}

# g6c_sampler <pid> <out jsonl>: a /proc sampler (1 Hz) on <pid>; it exits once the pid is gone.
g6c_sampler() {
	local pid="$1" out="$2"
	(
		cd "$REPO_ROOT" && exec mise exec -- pnpm exec tsx --conditions=development \
			"$SCRIPT_DIR/sample-proc.ts" --pid "$pid" --out "$out"
	) >"${out%.jsonl}.log" 2>&1 &
	EXTRA_CHILD_PIDS+=("$!")
}

# g6c_start_host <dir> <fixture dir> <max fps> [env words...]: a live host in the background (armed,
# listening on 127.0.0.1:0, the rate timeline, GRC_HOOK_LOG=off unless a word sets it), a sampler
# on it, and G6C_PORT once evidence/live.json says listening ("" otherwise). Sets G6C_HOST_PID.
g6c_start_host() {
	local dir="$1" fixture="$2" fps="$3" waited=0 word hook="GRC_HOOK_LOG=off"
	shift 3
	for word in "$@"; do
		case "$word" in
		GRC_HOOK_LOG=*) hook="" ;;
		esac
	done
	mkdir -p "$dir/evidence"
	LEG_ENV=(
		GRC_EXTENSION="$EXTENSION" GRC_CALIBRATION="$CALIBRATION" GRC_MODE=arm
		GRC_EVIDENCE_DIR="$dir/evidence" GRC_ROOT_SIZE=enforce-min-size GRC_LIVE_LISTEN=127.0.0.1:0
		RS_FIXTURE_STEP_LOG="$dir/steps.jsonl"
	)
	[ -n "$hook" ] && LEG_ENV+=("$hook")
	LEG_ENV+=("$@")
	start_headless_bg "$dir" -- "$BINARY" --headless --max-fps "$fps" --path "$fixture"
	G6C_HOST_PID="$BG_PID"
	EXTRA_CHILD_PIDS+=("$G6C_HOST_PID")
	g6c_sampler "$G6C_HOST_PID" "$dir/proc-samples.jsonl"
	G6C_PORT=""
	while [ "$waited" -lt 400 ] && [ ! -s "$dir/evidence/live.json" ] && kill -0 "$G6C_HOST_PID" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	if grep -q '"status": "listening"' "$dir/evidence/live.json" 2>/dev/null; then
		G6C_PORT="$(sed -n 's/^ *"port": \([0-9][0-9]*\),*$/\1/p' "$dir/evidence/live.json")"
	fi
	echo "run-gate6: ${dir#"$OUT"/} listening on port ${G6C_PORT:-<none>}"
}

# g6c_start_receiver <dir> <port> <max fps> [godot args...]: a rendered live receiver in the
# background in the current gamescope (RS_RECEIVER_PERF_OUT, RS_RECEIVER_SHOT_FINAL=1, a fresh
# cache; G6C_RECEIVER_ENV words appended), and a sampler on it. Sets G6C_RECEIVER_PID ("" when
# there is no port).
G6C_RECEIVER_ENV=()
g6c_start_receiver() {
	local dir="$1" port="$2" fps="$3"
	shift 3
	local -a extra_env=()
	if [ "${#G6C_RECEIVER_ENV[@]}" -gt 0 ]; then
		extra_env=("${G6C_RECEIVER_ENV[@]}")
	fi
	G6C_RECEIVER_ENV=()
	G6C_RECEIVER_PID=""
	mkdir -p "$dir"
	if [ -z "$port" ]; then
		echo "the live host is not listening" >"$dir/skipped.txt"
		echo "run-gate6: ${dir#"$OUT"/} skipped: the host is not listening" >&2
		return 0
	fi
	LEG_ENV=(
		RS_RECEIVER_MODE=live RS_RECEIVER_URL="ws://127.0.0.1:$port/render-stream"
		RS_RECEIVER_OUT="$dir/applied.json" RS_RECEIVER_CACHE_DIR="$dir/cache"
		RS_RECEIVER_PERF_OUT="$dir/perf.json" RS_RECEIVER_SHOT_FINAL=1
	)
	if [ "${#extra_env[@]}" -gt 0 ]; then
		LEG_ENV+=("${extra_env[@]}")
	fi
	g6c_launch_rendered "$dir" "$RECEIVER_DIR" --max-fps "$fps" "$@"
	G6C_RECEIVER_PID="$G6C_LAUNCHED_PID"
	g6c_sampler "$G6C_RECEIVER_PID" "$dir/proc-samples.jsonl"
}

# g6c_launch_rendered <dir> <project> [godot args...]: the template in the current gamescope with
# LEG_ENV, in the background (G6C_LAUNCHED_PID), its display environment recorded.
g6c_launch_rendered() {
	local dir="$1" project="$2"
	shift 2
	mkdir -p "$dir"
	gs_require_live
	write_invocation "$dir" "$BINARY" --path "$project" --rendering-driver opengl3 --display-driver x11 "$@"
	echo "DISPLAY=$GS_DISPLAY" >>"$dir/env.txt"
	GS_GODOT_ENV=("${LEG_ENV[@]}")
	gs_launch_godot "$GS_DISPLAY" "$BINARY" "$project" "$dir/stdout.log" "$@"
	G6C_LAUNCHED_PID="$GS_LAST_GODOT_PID"
	EXTRA_CHILD_PIDS+=("$G6C_LAUNCHED_PID")
	sleep 0.3
	g6c_display_env "$dir" "$G6C_LAUNCHED_PID"
}

# The display proof, split (G6c): gs_verify_display_ownership walks every /proc/*/fd in bash,
# about 30 s of a busy core here, which would overlap a leg's measured window. The socket half
# (who listens on the display's X socket) belongs to the compositor session, so it runs once
# right after gs_start (g6c_session_display_proof); each receiver records the cheap half, its own
# DISPLAY and WAYLAND_DISPLAY, in display-ownership.json next to that session proof.
G6C_SESSION_PROOF=""
g6c_session_display_proof() {
	local out="$1" number socket_path listeners inode owner owner_sid mine="" foreign="" ok=true
	number="$(echo "$GS_DISPLAY" | sed -nE 's/^:([0-9]+)(\.[0-9]+)?$/\1/p')"
	socket_path="/tmp/.X11-unix/X${number}"
	listeners="$(gs_unix_listeners "$socket_path")"
	[ -n "$listeners" ] || ok=false
	while read -r inode _flags; do
		[ -n "$inode" ] || continue
		while read -r owner; do
			[ -n "$owner" ] || continue
			owner_sid="$(gs_proc_sid "$owner" 2>/dev/null || true)"
			if [ "$owner" = "$GS_PID" ] || [ "$owner_sid" = "$GS_SID" ]; then
				mine+="${mine:+,}$owner"
			else
				foreign+="${foreign:+,}$owner"
				ok=false
			fi
		done < <(gs_socket_owners "$inode")
	done <<<"$listeners"
	[ -n "$mine" ] || ok=false
	printf '{"schema":"render-stream-gamescope-socket-proof/1","display":"%s","socketPath":"%s","compositorPid":%s,"compositorSid":"%s","listenerOwnersOurs":[%s],"listenerOwnersForeign":[%s],"ok":%s}\n' \
		"$GS_DISPLAY" "$socket_path" "$GS_PID" "$GS_SID" "$mine" "$foreign" "$ok" >"$out"
	G6C_SESSION_PROOF="$out"
	[ "$ok" = "true" ] || echo "run-gate6: WARNING: $out: the display socket is not only the compositor's" >&2
}

g6c_display_env() {
	local dir="$1" pid="$2" display="" wayland=false ok=true
	if [ -r "/proc/$pid/environ" ]; then
		display="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | awk -F= '$1=="DISPLAY"{print substr($0,index($0,"=")+1)}')"
		tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -q '^WAYLAND_DISPLAY=' && wayland=true
	fi
	[ "$display" = "$GS_DISPLAY" ] || ok=false
	[ "$wayland" = "false" ] || ok=false
	grep -q '"ok":true' "$G6C_SESSION_PROOF" 2>/dev/null || ok=false
	printf '{"schema":"render-stream-gamescope-display-ownership/1","display":"%s","godotPid":%s,"godotDisplayEnv":"%s","godotHasWaylandDisplay":%s,"sessionSocketProof":"%s","ok":%s}\n' \
		"$GS_DISPLAY" "$pid" "$display" "$wayland" "$G6C_SESSION_PROOF" "$ok" >"$dir/display-ownership.json"
	[ "$ok" = "true" ] || echo "run-gate6: WARNING: $dir display ownership check failed, see display-ownership.json" >&2
}

# g6c_wait_receiver <dir> <pid>: waits (gamescope checked) for a g6c_launch_rendered child.
g6c_wait_receiver() {
	local dir="$1" pid="$2" ticks=0
	[ -n "$pid" ] || return 0
	while [ -d "/proc/$pid" ] && [ "$ticks" -lt $((G6C_RECEIVER_TIMEOUT_S * 10)) ]; do
		gs_require_live
		sleep 0.1
		ticks=$((ticks + 1))
	done
	wait_owned "$pid" 5
	[ "$ticks" -ge $((G6C_RECEIVER_TIMEOUT_S * 10)) ] && WAIT_EXIT=124
	echo "$WAIT_EXIT" >"$dir/exit-code.txt"
	echo "run-gate6: ${dir#"$OUT"/} exit=$WAIT_EXIT"
}

# g6c_start_proxy <dir> <target port>: scripts/throttle-proxy.ts `constrained` in front of the host
# (D12). Sets G6C_PROXY_PORT and G6C_PROXY_PID (the node process itself, from its first line).
g6c_start_proxy() {
	local dir="$1" target="$2" waited=0
	mkdir -p "$dir"
	G6C_PROXY_PORT=""
	G6C_PROXY_PID=""
	[ -n "$target" ] || return 0
	(
		cd "$REPO_ROOT" && exec mise exec -- pnpm exec tsx --conditions=development \
			"$SCRIPT_DIR/throttle-proxy.ts" --target-host 127.0.0.1 --target-port "$target" \
			--profile constrained --stats-out "$dir/stats.json"
	) >"$dir/stdout.log" 2>"$dir/stderr.log" &
	EXTRA_CHILD_PIDS+=("$!")
	while [ "$waited" -lt 600 ] && ! grep -q '"listening_port"' "$dir/stdout.log" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
	done
	G6C_PROXY_PORT="$(sed -n 's/.*"listening_port":\([0-9][0-9]*\).*/\1/p' "$dir/stdout.log" | head -1)"
	G6C_PROXY_PID="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$dir/stdout.log" | head -1)"
	[ -n "$G6C_PROXY_PID" ] && EXTRA_CHILD_PIDS+=("$G6C_PROXY_PID")
	echo "run-gate6: ${dir#"$OUT"/} constrained proxy on port ${G6C_PROXY_PORT:-<none>} -> $target"
}

# g6c_stop_proxy <dir>: SIGTERM (the proxy writes stats.json and exits), waiting up to 10 s.
g6c_stop_proxy() {
	local dir="$1" waited=0
	[ -n "${G6C_PROXY_PID:-}" ] || return 0
	kill -TERM "$G6C_PROXY_PID" 2>/dev/null || true
	while [ "$waited" -lt 100 ] && kill -0 "$G6C_PROXY_PID" 2>/dev/null; do
		sleep 0.1
		waited=$((waited + 1))
	done
	[ -s "$dir/stats.json" ] || echo "run-gate6: WARNING: ${dir#"$OUT"/} wrote no stats.json" >&2
	G6C_PROXY_PID=""
}

# g6c_finish_host <dir>: waits for the leg's host and lets its sampler see it go.
g6c_finish_host() {
	finish_bg "$1" "$G6C_HOST_PID" "$G6C_HOST_TIMEOUT_S"
	G6C_HOST_PID=""
	sleep 1.2
}

# g6c_leg <leg> <host max fps> <receiver max fps> [receiver godot args...]: one scene host (the
# G6C_HOST_ENV words added) and one receiver on it; G6C_PROXY=1 puts the constrained proxy between.
G6C_HOST_ENV=()
G6C_PROXY=0
G6C_HOST_TIMEOUT_OVERRIDE=""
g6c_leg() {
	local leg="$1" host_fps="$2" recv_fps="$3" D port proxy="$G6C_PROXY" timeout_save="$G6C_HOST_TIMEOUT_S"
	shift 3
	local -a host_env=()
	if [ "${#G6C_HOST_ENV[@]}" -gt 0 ]; then
		host_env=("${G6C_HOST_ENV[@]}")
	fi
	G6C_HOST_ENV=()
	G6C_PROXY=0
	[ -n "$G6C_HOST_TIMEOUT_OVERRIDE" ] && G6C_HOST_TIMEOUT_S="$G6C_HOST_TIMEOUT_OVERRIDE"
	G6C_HOST_TIMEOUT_OVERRIDE=""
	D="$G6C/$leg"
	g6c_start_host "$D/host" "$SCENE_FIXTURE_DIR" "$host_fps" RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate \
		${host_env[@]+"${host_env[@]}"}
	port="$G6C_PORT"
	if [ "$proxy" = "1" ]; then
		g6c_start_proxy "$D/proxy" "$G6C_PORT"
		port="$G6C_PROXY_PORT"
	fi
	g6c_start_receiver "$D/receiver" "$port" "$recv_fps" "$@"
	g6c_wait_receiver "$D/receiver" "$G6C_RECEIVER_PID"
	g6c_finish_host "$D/host"
	[ "$proxy" = "1" ] && g6c_stop_proxy "$D/proxy"
	G6C_HOST_TIMEOUT_S="$timeout_save"
}

# g6c_freeze_state <steps.jsonl>: step 11's `freeze` array as compact JSON ("" when absent).
g6c_freeze_state() {
	python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        for line in f:
            entry = json.loads(line)
            if entry.get("step") == 11 and isinstance(entry.get("freeze"), list):
                print(json.dumps(entry["freeze"], separators=(",", ":")))
                break
except (OSError, ValueError):
    pass
PY
}

# g6c_reference <leg dir> <fixture dir> [env words...]: the leg's final-state reference, rendered in
# the current gamescope on the fixture's file timeline with the host's step-11 leftovers.
# G6C_REFERENCE_ARGS (reset) are extra godot arguments.
G6C_REFERENCE_ARGS=()
g6c_reference() {
	local D="$1" fixture="$2" freeze
	shift 2
	mkdir -p "$D/reference/shots"
	freeze="$(g6c_freeze_state "$D/host/steps.jsonl")"
	if [ -z "$freeze" ]; then
		echo "the host logged no step-11 freeze state" >"$D/reference/skipped.txt"
		echo "run-gate6: ${D#"$OUT"/}/reference skipped: no step-11 freeze state" >&2
		G6C_REFERENCE_ARGS=()
		return 0
	fi
	local -a args=()
	if [ "${#G6C_REFERENCE_ARGS[@]}" -gt 0 ]; then
		args=("${G6C_REFERENCE_ARGS[@]}")
	fi
	G6C_REFERENCE_ARGS=()
	LEG_ENV=(
		RS_FIXTURE_FREEZE_STATE="$freeze" RS_FIXTURE_SHOT_DIR="$D/reference/shots"
		RS_FIXTURE_STEP_LOG="$D/reference/steps.jsonl" "$@"
	)
	# A correctness leg launched outside lib/legs.sh's run_rendered: its shared quiet hold here.
	legs_lock_enter "$D/reference"
	LEGS_LOCK_FG=$((LEGS_LOCK_FG + 1))
	g6c_launch_rendered "$D/reference" "$fixture" ${args[@]+"${args[@]}"}
	g6c_wait_receiver "$D/reference" "$G6C_LAUNCHED_PID"
	LEGS_LOCK_FG=$((LEGS_LOCK_FG - 1))
	legs_lock_leave
}

# g6c_gpu_p50 <perf.json>: the receiver's gpu_render_us and frame_interval_us medians, in ms, as
# "<gpu> <frame>" ("0 0" when missing).
g6c_gpu_p50() {
	python3 - "$1" <<'PY'
import json, sys

def p50(h):
    buckets = (h or {}).get("buckets") or []
    total = sum(n for _, n in buckets)
    if total == 0:
        return 0.0
    seen = 0
    for i, (lower, n) in enumerate(buckets):
        if seen + n >= total / 2:
            return lower / 1000.0
        seen += n
    return 0.0

try:
    with open(sys.argv[1]) as f:
        h = json.load(f).get("histograms", {})
    print("%.3f %.3f" % (p50(h.get("gpu_render_us")), p50(h.get("frame_interval_us"))))
except (OSError, ValueError):
    print("0 0")
PY
}

# Q6e: `iterations` for the gpu-heavy leg, calibrated until the 1920x1080 receiver's measured GPU
# time is about G6C_TARGET_GPU_MS. Each round is a short gate6-hd gpu-heavy host (file timeline,
# quit at frame 480) with a live receiver; the next guess scales by target / measured (at most 8x
# either way). Writes calibration.json and sets G6C_BURN_ITERATIONS.
g6c_calibrate_gpu_heavy() {
	local C="$G6C/gpu-heavy-calibration" iterations="$G6C_BURN_START" round gpu frame next chosen="" converged=false
	local rounds_json="" sep=""
	mkdir -p "$C"
	for round in $(seq 1 "$G6C_CALIBRATION_ROUNDS"); do
		echo "run-gate6: g6c: gpu-heavy calibration round $round (iterations $iterations)"
		g6c_start_host "$C/round-$round/host" "$HD_FIXTURE_DIR" 60 RS_FIXTURE_VARIANT=gpu-heavy \
			RS_FIXTURE_BURN_ITERATIONS="$iterations" RS_FIXTURE_QUIT_FRAME="$G6C_CALIBRATION_QUIT_FRAME"
		G6C_RECEIVER_ENV=(RS_RECEIVER_LOG=summary)
		g6c_start_receiver "$C/round-$round/receiver" "$G6C_PORT" 60 --resolution 1920x1080
		g6c_wait_receiver "$C/round-$round/receiver" "$G6C_RECEIVER_PID"
		g6c_finish_host "$C/round-$round/host"
		read -r gpu frame < <(g6c_gpu_p50 "$C/round-$round/receiver/perf.json")
		echo "run-gate6: g6c: calibration round $round: gpu p50 ${gpu} ms, frame interval p50 ${frame} ms"
		rounds_json+="$sep{\"round\":$round,\"iterations\":$iterations,\"gpu_p50_ms\":$gpu,\"frame_interval_p50_ms\":$frame}"
		sep=","
		next="$(python3 -c "import sys
i=int(sys.argv[1]); g=float(sys.argv[2]); t=float(sys.argv[3])
if g <= 0: print(i*8); sys.exit()
if abs(g - t) <= 0.15*t: print('ok'); sys.exit()
print(max(100, min(i*8, max(i//8, round(i*t/g)))))" "$iterations" "$gpu" "$G6C_TARGET_GPU_MS")"
		if [ "$next" = "ok" ]; then
			chosen="$iterations"
			converged=true
			break
		fi
		iterations="$next"
	done
	[ -z "$chosen" ] && chosen="$iterations"
	G6C_BURN_ITERATIONS="$chosen"
	printf '{"schema":"render-stream-gate6c-calibration/1","target_gpu_ms":%s,"tolerance":0.15,"rounds":[%s],"chosen_iterations":%s,"converged":%s}\n' \
		"$G6C_TARGET_GPU_MS" "$rounds_json" "$chosen" "$converged" \
		>"$C/calibration.json"
	echo "run-gate6: g6c: gpu-heavy iterations $G6C_BURN_ITERATIONS (calibration.json)"
}

g6c_provenance_input() {
	local lib receiver_sha
	lib="$(sed -n 's/^linux.x86_64 = "\(.*\)"$/\1/p' "$EXTENSION")"
	receiver_sha="$(cd "$RECEIVER_DIR" && find . -maxdepth 1 -type f \( -name '*.gd' -o -name '*.tscn' -o -name 'project.godot' \) | sort | xargs sha256sum | sha256sum | awk '{print $1}')"
	printf '{"engine_sha256":"%s","library_path":"%s","library_sha256":"%s","calibration":"%s","receiver_project_sha256":"%s","gamescope_sizes":[[640,360],[1920,1080]]}\n' \
		"$ACTUAL_BINARY_SHA256" "$lib" "$(sha256sum "$lib" | awk '{print $1}')" "$CALIBRATION" "$receiver_sha" \
		>"$G6C/provenance-input.json"
}

run_g6c() {
	local G6C="$OUT/$G6C_DIR_NAME" leg D
	mkdir -p "$G6C/import"
	echo "run-gate6: g6c: import (fixture, receiver, hd fixture)"
	LEG_ENV=()
	run_headless "$G6C/import/fixture" none -- mise exec -- godot --headless --path "$SCENE_FIXTURE_DIR" --import
	LEG_ENV=()
	run_headless "$G6C/import/receiver" none -- mise exec -- godot --headless --path "$RECEIVER_DIR" --import
	LEG_ENV=()
	run_headless "$G6C/import/hd-fixture" none -- mise exec -- godot --headless --path "$HD_FIXTURE_DIR" --import
	for leg in fixture receiver hd-fixture; do
		if [ "$(cat "$G6C/import/$leg/exit-code.txt")" != "0" ]; then
			echo "run-gate6: g6c: import $leg failed, see $G6C/import/$leg/stdout.log" >&2
			exit 1
		fi
	done
	g6c_provenance_input
	: >"$G6C/legs-run.txt"
	for leg in "${G6C_ALL_LEGS[@]}"; do
		if g6c_wanted "$leg"; then
			echo "$leg" >>"$G6C/legs-run.txt"
		fi
	done

	echo "run-gate6: bringing up private gamescope 640x360 for g6c legs"
	gs_start 640 360 "$OUT/gamescope-g6c"
	g6c_session_display_proof "$G6C/display-socket-proof-640x360.json"

	if g6c_wanted rate-baseline; then
		echo "run-gate6: g6c: rate-baseline (armed, listening, no subscriber, --max-fps 60)"
		D="$G6C/rate-baseline"
		g6c_start_host "$D/host" "$SCENE_FIXTURE_DIR" 60 RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate
		g6c_finish_host "$D/host"
	fi
	for leg in 15 30 60; do
		if g6c_wanted "rate-$leg"; then
			echo "run-gate6: g6c: rate-$leg (GRC_PUBLISH_FPS=$leg, host and receiver --max-fps 60)"
			G6C_HOST_ENV=(GRC_PUBLISH_FPS="$leg")
			g6c_leg "rate-$leg" 60 60
		fi
	done
	if g6c_wanted rate-uncapped-host60; then
		echo "run-gate6: g6c: rate-uncapped-host60 (uncapped, host and receiver --max-fps 60)"
		g6c_leg rate-uncapped-host60 60 60
	fi
	if g6c_wanted rate-uncapped; then
		echo "run-gate6: g6c: rate-uncapped (uncapped, host and receiver --max-fps 0)"
		g6c_leg rate-uncapped 0 0
	fi
	if g6c_wanted mismatch-60-recv30; then
		echo "run-gate6: g6c: mismatch-60-recv30 (GRC_PUBLISH_FPS=60, receiver --max-fps 30)"
		G6C_HOST_ENV=(GRC_PUBLISH_FPS=60)
		g6c_leg mismatch-60-recv30 60 30
	fi
	if g6c_wanted mismatch-15-recv60; then
		echo "run-gate6: g6c: mismatch-15-recv60 (GRC_PUBLISH_FPS=15, receiver --max-fps 60)"
		G6C_HOST_ENV=(GRC_PUBLISH_FPS=15)
		g6c_leg mismatch-15-recv60 60 60
	fi
	if g6c_wanted dual-60-15; then
		echo "run-gate6: g6c: dual-60-15 (uncapped, GRC_LIVE_MAX_CONNECTIONS=2; receivers --max-fps 60 and 15)"
		D="$G6C/dual-60-15"
		local pid_a pid_b
		g6c_start_host "$D/host" "$SCENE_FIXTURE_DIR" 60 RS_FIXTURE_VARIANT=animate RS_FIXTURE_TIMELINE=rate \
			GRC_LIVE_MAX_CONNECTIONS=2
		g6c_start_receiver "$D/receiver-b" "$G6C_PORT" 15
		pid_b="$G6C_RECEIVER_PID"
		g6c_start_receiver "$D/receiver-a" "$G6C_PORT" 60
		pid_a="$G6C_RECEIVER_PID"
		g6c_wait_receiver "$D/receiver-a" "$pid_a"
		g6c_wait_receiver "$D/receiver-b" "$pid_b"
		g6c_finish_host "$D/host"
	fi
	if g6c_wanted recv-delay; then
		echo "run-gate6: g6c: recv-delay (GRC_PUBLISH_FPS=60, receiver --max-fps 60 --frame-delay 40)"
		G6C_HOST_ENV=(GRC_PUBLISH_FPS=60)
		g6c_leg recv-delay 60 60 --frame-delay 40
	fi
	if g6c_wanted constrained; then
		echo "run-gate6: g6c: constrained (GRC_PUBLISH_FPS=60, through throttle-proxy constrained)"
		G6C_HOST_ENV=(GRC_PUBLISH_FPS=60)
		G6C_PROXY=1
		g6c_leg constrained 60 60
	fi
	if g6c_wanted sabotage-constrained-ignore-credit; then
		# Q3d: a sabotage never runs with the hook log off.
		echo "run-gate6: g6c: sabotage-constrained-ignore-credit (ignore-credit @$G6C_SABOTAGE_FRAME, quit at ${G6C_SABOTAGE_QUIT_S} s, inline payloads, through the proxy)"
		G6C_HOST_ENV=(GRC_PUBLISH_FPS=60 GRC_SABOTAGE=ignore-credit GRC_SABOTAGE_FRAME="$G6C_SABOTAGE_FRAME"
			GRC_HOOK_LOG=on RS_FIXTURE_QUIT_TIME="$G6C_SABOTAGE_QUIT_S"
			GRC_RESOURCE_INLINE_MAX_BYTES="$G6C_INLINE_MAX_BYTES" GRC_RESOURCE_MAX_PAYLOAD_BYTES="$G6C_INLINE_MAX_BYTES")
		G6C_PROXY=1
		G6C_HOST_TIMEOUT_OVERRIDE=$((G6C_SABOTAGE_QUIT_S + 60))
		g6c_leg sabotage-constrained-ignore-credit 60 60
	fi

	for leg in "${G6C_ALL_LEGS[@]}"; do
		case "$leg" in
		rate-baseline | gpu-heavy) continue ;;
		esac
		[ -f "$G6C/$leg/host/steps.jsonl" ] || continue
		echo "run-gate6: g6c: $leg/reference (the host's step-11 freeze state, file timeline)"
		g6c_reference "$G6C/$leg" "$SCENE_FIXTURE_DIR" RS_FIXTURE_VARIANT=animate
	done
	gs_teardown "$OUT/gamescope-g6c"
	GS_RUN_DIR=""

	if g6c_wanted gpu-heavy; then
		echo "run-gate6: bringing up private gamescope 1920x1080 for g6c gpu-heavy"
		gs_start 1920 1080 "$OUT/gamescope-g6c-hd"
		g6c_session_display_proof "$G6C/display-socket-proof-1920x1080.json"
		g6c_calibrate_gpu_heavy
		echo "run-gate6: g6c: gpu-heavy (gate6-hd gpu-heavy native, iterations $G6C_BURN_ITERATIONS, GRC_PUBLISH_FPS=60, receiver 1920x1080 --max-fps 60)"
		D="$G6C/gpu-heavy"
		g6c_start_host "$D/host" "$HD_FIXTURE_DIR" 60 RS_FIXTURE_VARIANT=gpu-heavy RS_FIXTURE_TIMELINE=rate \
			RS_FIXTURE_BURN_ITERATIONS="$G6C_BURN_ITERATIONS" GRC_PUBLISH_FPS=60
		g6c_start_receiver "$D/receiver" "$G6C_PORT" 60 --resolution 1920x1080
		g6c_wait_receiver "$D/receiver" "$G6C_RECEIVER_PID"
		g6c_finish_host "$D/host"
		echo "run-gate6: g6c: gpu-heavy/reference (gate6-hd gpu-heavy, the host's step-11 freeze state)"
		G6C_REFERENCE_ARGS=(--resolution 1920x1080)
		g6c_reference "$D" "$HD_FIXTURE_DIR" RS_FIXTURE_VARIANT=gpu-heavy RS_FIXTURE_BURN_ITERATIONS="$G6C_BURN_ITERATIONS"
		gs_teardown "$OUT/gamescope-g6c-hd"
		GS_RUN_DIR=""
	fi
}
