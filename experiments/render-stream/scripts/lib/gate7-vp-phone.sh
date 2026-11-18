# shellcheck shell=bash
# VS5b: the phone and identity helpers of run-gate7.sh's vp sweeps (`G7V_LEGS=vp-...`, header
# "Group landed (G7v)" in run-gate7.sh and "VS5b" in lib/gate6c-legs.sh). Sourced by run-gate7.sh
# and lib/gate6c-legs.sh. Nothing here runs unless a vp sweep runs; the adb functions only under
# `--env device`.
#
#   vp_adb ARGS...              adb on ANDROID_SERIAL (required for a device sweep, run-gate7.sh)
#   vp_chrome_start <log> [label]  opens the phone's Chrome on about:blank and waits (20 s) for
#                               EXACTLY @chrome_devtools_remote (never another app's socket), logged
#                               to events.log too; fails when it never appears. Every daemon (re)start
#                               of a device sweep follows a successful one;
#                               DevTools socket: the device daemon attaches, it never launches
#   vp_chrome_stop <json>       `am force-stop com.android.chrome`, then records Chrome's pids and the
#                               foreground activity (both must be gone/other); always returns 0
#   vp_phone_lock_path          the phone lock every G31 session shares: the main checkout's
#                               artifacts/perf/g31-phone.lock (G7V_PHONE_LOCK overrides)
#   vp_sweep_run <run dir> <device 0|1> <log> -- <child command...>
#                               one sweep (run-gate7.sh g7v_vp_sweep): the child (run-gate6.sh,
#                               whose --out is <run dir> and must stay fresh) in the background with
#                               its output in <log>; the wrapper's own evidence in <run dir>.sweep/.
#                               On a device: the phone lock taken BEFORE Chrome is opened and held
#                               for the whole child (phone-lock.json), Chrome opened on about:blank
#                               (chrome-start.log); on every exit the child is stopped first (its
#                               host and daemon), then the daemon it left is waited for, then Chrome
#                               is force-stopped (chrome-stop-final.json), then the lock released;
#                               the daemon wait, the force-stop and the release run only once the
#                               lock was taken (an interrupted wait touches nothing).
#                               Returns the child's exit code (130 on a signal, 1 when Chrome's
#                               DevTools socket never appeared)
#   vp_identity_json <bundle> <extension> [core root]
#                               one JSON object: the served GSW bundle's files hashed as
#                               lib/gsw-bundle.ts hashes them (`build_id`), build.json's own sha256
#                               and rs-core build, and the capture library's sha256; summary
#                               (gate7-vp-summary.ts) flags any arm whose build_id differs

VP_CHROME_PACKAGE="${VP_CHROME_PACKAGE:-com.android.chrome}"
VP_CHROME_ACTIVITY="${VP_CHROME_ACTIVITY:-com.google.android.apps.chrome.Main}"

vp_adb() {
	adb ${ANDROID_SERIAL:+-s "$ANDROID_SERIAL"} "$@"
}

# vp_chrome_socket_up: Chrome stable's own DevTools socket, exactly @chrome_devtools_remote, is in
# /proc/net/unix (an app's Stetho or a WebView socket never counts).
vp_chrome_socket_up() {
	# Read the whole table first: `grep -q` exits at its first match, the upstream adb takes SIGPIPE,
	# and under the caller's `set -o pipefail` a found socket would read as missing.
	local table
	table="$(vp_adb shell cat /proc/net/unix 2>/dev/null | tr -d '\r' || true)"
	grep -qE '@chrome_devtools_remote([[:space:]]|$)' <<<"$table"
}

# vp_event <text>: one line in the sweep's events.log (G7V_VP_EVENTS, set by vp_sweep_run).
vp_event() {
	[ -n "${G7V_VP_EVENTS:-}" ] || return 0
	echo "$(date -u +%FT%T.%3NZ) $*" >>"$G7V_VP_EVENTS"
}

vp_chrome_start() {
	local log="$1" i tries="${VP_CHROME_WAIT_TRIES:-40}"
	{
		echo "$(date -u +%FT%T.%3NZ) chrome start"
		vp_adb shell am start -a android.intent.action.VIEW -d about:blank -n "$VP_CHROME_PACKAGE/$VP_CHROME_ACTIVITY" 2>&1
	} >>"$log"
	for i in $(seq 1 "$tries"); do
		if vp_chrome_socket_up; then
			echo "$(date -u +%FT%T.%3NZ) @chrome_devtools_remote up after ${i}x0.5 s" >>"$log"
			vp_event "chrome socket up after ${i}x0.5 s${2:+ ($2)}"
			sleep 1
			return 0
		fi
		sleep 0.5
	done
	echo "$(date -u +%FT%T.%3NZ) no @chrome_devtools_remote after ${tries}x0.5 s" >>"$log"
	vp_event "no chrome socket after ${tries}x0.5 s${2:+ ($2)}"
	return 1
}

vp_chrome_stop() {
	local out="$1" pids top
	vp_adb shell am force-stop "$VP_CHROME_PACKAGE" >/dev/null 2>&1 || true
	sleep 1.5
	pids="$(vp_adb shell pidof "$VP_CHROME_PACKAGE" 2>/dev/null | tr -d '\r' || true)"
	# The first of topResumedActivity=, mResumedActivity:, ResumedActivity: (the g31 has only the
	# last two), as lib/device-sampler.ts parseTopResumedActivity reads them.
	local acts
	acts="$(vp_adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' || true)"
	top="$(grep -m1 'topResumedActivity=' <<<"$acts" || grep -m1 'mResumedActivity:' <<<"$acts" || grep -m1 -E '(^|[[:space:]])ResumedActivity:' <<<"$acts" || true)"
	top="$(sed 's/^ *//; s/"/\\"/g' <<<"$top")"
	printf '{"schema":"render-stream-gate7-vp-chrome-stop/1","at":"%s","chrome_pids":"%s","top_resumed_activity":"%s"}\n' \
		"$(date -u +%FT%T.%3NZ)" "$pids" "$top" >"$out"
	return 0
}

vp_phone_lock_path() {
	if [ -n "${G7V_PHONE_LOCK:-}" ]; then
		echo "$G7V_PHONE_LOCK"
		return 0
	fi
	local common
	common="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
	[ -n "$common" ] || common="$REPO_ROOT/.git"
	echo "$(dirname "$common")/artifacts/perf/g31-phone.lock"
}

vp__sha() { sha256sum "$1" 2>/dev/null | cut -c1-64; }

vp_identity_json() {
	local bundle="$1" extension="$2" root="${3:-$REPO_ROOT}" f lines="" files_sha declared rs_sha rs_wasm lib="" lib_sha="" tree
	for f in receiver.html receiver.js gsw-rs/rs_gsw_wasm.js gsw-rs/rs_gsw_wasm_bg.wasm basis-worker.js basis/basis_transcoder.wasm; do
		lines+="${lines:+$'\n'}$f $(vp__sha "$bundle/$f")"
	done
	files_sha="$(printf '%s' "$lines" | sha256sum | cut -c1-64)"
	declared="$(sed -n 's/^  "sha256": "\([0-9a-f]*\)",*$/\1/p' "$bundle/build.json" 2>/dev/null | head -1)"
	rs_sha="$(sed -n 's/.*sha=\([0-9a-f]*\(-dirty\)*\).*/\1/p' "$bundle/build.json" 2>/dev/null | head -1)"
	rs_wasm="$(sed -n 's/.*wasm_sha256=\([0-9a-f]*\).*/\1/p' "$bundle/build.json" 2>/dev/null | head -1)"
	# The capture library the .gdextension names for linux (the host's code).
	if [ -f "$extension" ]; then
		lib="$(sed -n 's/^linux[^=]*= *"\([^"]*\)".*/\1/p' "$extension" | head -1)"
		case "$lib" in
		res://* | "") ;;
		/*) ;;
		*) lib="$(dirname "$extension")/$lib" ;;
		esac
		[ -n "$lib" ] && [ -f "$lib" ] && lib_sha="$(vp__sha "$lib")"
	fi
	tree="$(bash "$root/packages/render-stream-client/scripts/core-tree.sh" "$root" 2>/dev/null || true)"
	printf '{"build_id":"%s","bundle_dir":"%s","bundle_sha256_declared":"%s","bundle_matches_declared":%s,"rs_core_build":"%s","rs_core_wasm_sha256":"%s","bundle_wasm_sha256":"%s","rs_core_tree_at_arm":"%s","extension":"%s","capture_library":"%s","capture_library_sha256":"%s","at":"%s"}' \
		"$files_sha" "$bundle" "$declared" "$([ "$files_sha" = "$declared" ] && echo true || echo false)" \
		"$rs_sha" "$rs_wasm" "$(vp__sha "$bundle/gsw-rs/rs_gsw_wasm_bg.wasm")" "$tree" "$extension" "$lib" "$lib_sha" \
		"$(date -u +%FT%T.%3NZ)"
}

vp_sweep_run() {
	local run_dir="$1" device="$2" log="$3"
	shift 3
	[ "${1:-}" = "--" ] && shift
	local ev="$run_dir.sweep"
	mkdir -p "$ev" "$(dirname "$log")"
	(
		child=""
		child_started=0
		lock_fd=""
		lock_held=0
		vp__sweep_cleanup() {
			set +e
			local dpid waited=0
			if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
				kill -TERM "$child" 2>/dev/null
				wait "$child" 2>/dev/null
			fi
			[ "$child_started" = 1 ] && echo "$(date -u +%FT%T.%3NZ) child stopped" >>"$ev/events.log"
			# The phone is touched only by the sweep that holds the lock: a sweep interrupted while it
			# waited must not force-stop another session's Chrome mid-measurement.
			if [ "$device" = 1 ] && [ "$lock_held" = 1 ]; then
				# A daemon the child left (it exits within a second of its parent, restoring the
				# phone's session settings over adb) goes before Chrome does.
				dpid="$(sed -n 's/^.*"pid":\([0-9][0-9]*\).*$/\1/p' "$run_dir/gate7-browser/daemon.json" 2>/dev/null || true)"
				while [ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null && [ "$waited" -lt 150 ]; do
					sleep 0.1
					waited=$((waited + 1))
				done
				[ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null && kill -TERM "$dpid" 2>/dev/null
				vp_chrome_stop "$ev/chrome-stop-final.json"
				echo "$(date -u +%FT%T.%3NZ) chrome force-stopped" >>"$ev/events.log"
				echo "vp_sweep_run: Chrome force-stopped ($(cat "$ev/chrome-stop-final.json"))" >&2
			fi
			if [ "$lock_held" = 1 ]; then
				flock -u "$lock_fd"
				echo "$(date -u +%FT%T.%3NZ) lock released" >>"$ev/events.log"
				echo "vp_sweep_run: phone lock released" >&2
			fi
		}
		trap vp__sweep_cleanup EXIT
		trap 'exit 130' INT TERM HUP
		if [ "$device" = 1 ]; then
			local lock t0
			lock="$(vp_phone_lock_path)"
			mkdir -p "$(dirname "$lock")"
			exec {lock_fd}>>"$lock"
			t0="$(date +%s.%N)"
			echo "vp_sweep_run: waiting for the phone lock $lock" >&2
			if ! flock "$lock_fd"; then
				echo "vp_sweep_run: the phone lock $lock was not taken (interrupted or failed); nothing ran on the phone" >&2
				exit 1
			fi
			lock_held=1
			echo "$(date -u +%FT%T.%3NZ) lock taken" >>"$ev/events.log"
			printf '{"lock":"%s","wait_s":%s,"acquired_at":"%s"}\n' "$lock" \
				"$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.1f", b - a }')" "$(date -u +%FT%T.%3NZ)" >"$ev/phone-lock.json"
			if ! G7V_VP_EVENTS="$ev/events.log" vp_chrome_start "$ev/chrome-start.log" sweep; then
				echo "vp_sweep_run: Chrome's DevTools socket did not appear (see $ev/chrome-start.log)" >&2
				exit 1
			fi
			echo "$(date -u +%FT%T.%3NZ) chrome started" >>"$ev/events.log"
		fi
		G7V_VP_EVENTS="$ev/events.log" "$@" >"$log" 2>&1 &
		child=$!
		child_started=1
		echo "$(date -u +%FT%T.%3NZ) child started" >>"$ev/events.log"
		wait "$child"
		rc=$?
		child=""
		echo "$(date -u +%FT%T.%3NZ) child exit $rc" >>"$ev/events.log"
		exit "$rc"
	)
}
