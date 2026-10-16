#!/usr/bin/env bash
# quiet.sh -- the machine-wide measurement-isolation lock for render-stream runs
# (results/measurement-isolation.md). One lock, shared by every worktree and agent on the box:
#
#   ${GSW_QUIET_LOCK:-${GSW_QUIET_DIR:-${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web}/quiet.lock}
#
#   exclusive  one TIMING leg (a rate, cadence or pacing measurement): nothing else heavy runs.
#   shared     one CORRECTNESS leg, a build step or other heavy work (a cargo build, a pnpm suite,
#              a checker): any number at once, but none while a timing leg holds or waits.
#
# No starvation: a waiting exclusive acquirer leaves a marker in <lock>.waiters/; a new shared
# acquirer waits while a live marker exists, and the current shared holders finish their one leg.
# A marker is stale (removed by whoever sees it) once its holder process is gone, or after
# GSW_QUIET_MARKER_MAX_S seconds (default 3600).
#
# Every lock is held by a small HOLDER process (`quiet.sh hold`), never by a runner's own file
# descriptor: Godot hosts, gamescope and browser daemons a runner starts can never inherit (and so
# keep) the lock, and a crash on either side frees it -- the kernel drops the lock when the holder
# dies, and the holder exits within 0.25 s of its owner dying. The holder also does the nesting
# check, the optional core pinning and the logging, so the bash library below and the TS twin
# (lib/quiet-lock.ts) stay thin.
#
# Nesting: when the owner, or any ancestor of it, is the owner of a live hold, a new acquire is a
# no-op logged `nested` (a runner calling a runner, `quiet.sh shared --` around something that
# locks again). An exclusive request under an ancestor's SHARED hold cannot be honoured without
# deadlocking on itself: it proceeds unisolated, logged `nested-unisolated` with a warning.
#
# Core pinning (both off by default): RS_TIMING_CPUSET pins an exclusive hold's owner and its
# whole process tree (descendants, plus every process in a session one of them leads: gamescope's
# XWayland) for the hold; RS_BACKGROUND_CPUSET does the same for shared holds. Children started
# during the hold inherit it; release restores what it pinned.
#
# Logging: every acquire, release and nested event is one JSON line, to the run's log (--log, or
# QUIET_LOG for the bash library) and to the machine-wide <lock>.events.log.
#
# Command use:
#   quiet.sh shared    [--label L] [--log F] -- <command...>   the command under a shared hold
#   quiet.sh exclusive [--label L] [--log F] -- <command...>   the command under an exclusive hold
#   quiet.sh status                                            live holders and waiters
#   quiet.sh summary <log.jsonl> [--wall-s S] [--out F.json]   totals per mode, per label
#   quiet.sh hold <shared|exclusive> --owner PID [--label L] [--log F]   (internal: the holder)
# Library use (sourced): quiet_acquire <mode> <label>, quiet_release, quiet_run <mode> <label> --
# <command...>, quiet_summary <out dir>. Set QUIET_LOG to the run's log first.

QUIET_SH="${QUIET_SH:-$(realpath "${BASH_SOURCE[0]}")}"
QUIET_DIR="${GSW_QUIET_DIR:-${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web}"
QUIET_LOCK="${GSW_QUIET_LOCK:-$QUIET_DIR/quiet.lock}"
QUIET_WAITERS="$QUIET_LOCK.waiters"
QUIET_HOLDERS="$QUIET_LOCK.holders"
QUIET_EVENTS="$QUIET_LOCK.events.log"
QUIET_MARKER_MAX_S="${GSW_QUIET_MARKER_MAX_S:-3600}"

# --- /proc helpers (builtins only: the holder polls them while a timing leg runs) ---------------

# quiet__stat <pid>: sets QUIET__STATE QUIET__PPID QUIET__SID QUIET__TICKS; fails when the process
# is gone or a zombie. Parses from the last ')' (comm may hold spaces or parens).
quiet__stat() {
	local s
	{ read -r s <"/proc/$1/stat"; } 2>/dev/null || return 1
	s="${s##*) }"
	local -a f
	read -r -a f <<<"$s"
	QUIET__STATE="${f[0]}"
	QUIET__PPID="${f[1]}"
	QUIET__SID="${f[3]}"
	QUIET__TICKS="${f[19]}"
	[ "$QUIET__STATE" != "Z" ] && [ "$QUIET__STATE" != "X" ]
}

# quiet__alive <pid> <ticks>: the same process (pid + start ticks) is still running.
quiet__alive() {
	quiet__stat "$1" && [ "$QUIET__TICKS" = "$2" ]
}

quiet__json_str() {
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	printf '"%s"' "$s"
}

# quiet__log <log file|""> <json fields without braces>: one line to the run log and the global one.
quiet__log() {
	local log="$1" line
	line="{\"t\":${EPOCHREALTIME/,/.},$2}"
	if [ -n "$log" ]; then
		printf '%s\n' "$line" >>"$log" 2>/dev/null || true
	fi
	if [ -f "$QUIET_EVENTS" ] && [ "$(stat -c %s "$QUIET_EVENTS" 2>/dev/null || echo 0)" -gt 4194304 ]; then
		mv -f "$QUIET_EVENTS" "$QUIET_EVENTS.1" 2>/dev/null || true
	fi
	printf '%s\n' "$line" >>"$QUIET_EVENTS" 2>/dev/null || true
}

# quiet__secs <start EPOCHREALTIME> <end>: the difference, as seconds with 3 decimals.
quiet__secs() {
	local a="${1/[.,]/}" b="${2/[.,]/}"
	local d=$(((10#$b - 10#$a) / 1000))
	[ "$d" -lt 0 ] && d=0
	printf '%d.%03d' $((d / 1000)) $((d % 1000))
}

# quiet__ancestor_hold <pid>: when <pid> or an ancestor owns a live hold, prints "<mode> <holder
# pid> <label>" for the nearest one.
quiet__ancestor_hold() {
	local -A owner_mode=() owner_line=()
	local f hpid hticks opid oticks mode since label
	for f in "$QUIET_HOLDERS"/*; do
		[ -f "$f" ] || continue
		{ read -r hpid hticks opid oticks mode since label <"$f"; } 2>/dev/null || continue
		if quiet__alive "$hpid" "$hticks"; then
			owner_mode["$opid:$oticks"]="$mode"
			owner_line["$opid:$oticks"]="$mode $hpid $label"
		else
			rm -f "$f"
		fi
	done
	[ "${#owner_mode[@]}" -gt 0 ] || return 1
	local p="$1" hops=0
	while [ -n "$p" ] && [ "$p" -gt 1 ] && [ "$hops" -lt 64 ]; do
		quiet__stat "$p" || return 1
		if [ -n "${owner_mode["$p:$QUIET__TICKS"]:-}" ]; then
			printf '%s\n' "${owner_line["$p:$QUIET__TICKS"]}"
			return 0
		fi
		p="$QUIET__PPID"
		hops=$((hops + 1))
	done
	return 1
}

# quiet__live_waiter: true when a live exclusive waiter's marker exists (removes stale ones).
quiet__live_waiter() {
	local f wpid wticks wsince rest
	for f in "$QUIET_WAITERS"/*; do
		[ -f "$f" ] || continue
		{ read -r wpid wticks wsince rest <"$f"; } 2>/dev/null || continue
		if quiet__alive "$wpid" "$wticks" && [ $((EPOCHSECONDS - wsince)) -le "$QUIET_MARKER_MAX_S" ]; then
			QUIET__WAITER="$wpid $rest"
			return 0
		fi
		rm -f "$f"
	done
	return 1
}

# quiet__tree <root pid>: prints the root, its descendants, and every process in a session one of
# them leads (gamescope's detached XWayland is reparented away but keeps gamescope's session).
quiet__tree() {
	local root="$1" d pid
	local -A kids=() sid_members=() seen=()
	for d in /proc/[0-9]*; do
		pid="${d#/proc/}"
		quiet__stat "$pid" || continue
		kids["$QUIET__PPID"]+=" $pid"
		sid_members["$QUIET__SID"]+=" $pid"
	done
	local -a queue=("$root")
	local i=0 p c
	while [ "$i" -lt "${#queue[@]}" ]; do
		p="${queue[$i]}"
		i=$((i + 1))
		[ -z "${seen[$p]:-}" ] || continue
		seen["$p"]=1
		for c in ${kids[$p]:-}; do queue+=("$c"); done
		# p leads a session (sid == pid) other than the root's own: its whole session too.
		if [ "$p" != "$root" ]; then
			for c in ${sid_members[$p]:-}; do queue+=("$c"); done
		fi
	done
	printf '%s\n' "${!seen[@]}"
}

# --- the holder ------------------------------------------------------------------------------

QUIET__PINNED=()
QUIET__ORIGINAL=()
QUIET__OWNER_MASK=""

quiet__pin() {
	local owner="$1" cpuset="$2" pid mask
	QUIET__OWNER_MASK="$(taskset -pc "$owner" 2>/dev/null | sed -n 's/.*: *//p')"
	for pid in $(quiet__tree "$owner"); do
		mask="$(taskset -pc "$pid" 2>/dev/null | sed -n 's/.*: *//p')" || continue
		[ -n "$mask" ] || continue
		if taskset -apc "$cpuset" "$pid" >/dev/null 2>&1; then
			QUIET__PINNED+=("$pid")
			QUIET__ORIGINAL+=("$mask")
		fi
	done
}

quiet__unpin() {
	local owner="$1" pid i
	[ -n "$QUIET__OWNER_MASK" ] || return 0
	local -A restored=()
	for i in "${!QUIET__PINNED[@]}"; do
		taskset -apc "${QUIET__ORIGINAL[$i]}" "${QUIET__PINNED[$i]}" >/dev/null 2>&1 || true
		restored["${QUIET__PINNED[$i]}"]=1
	done
	# Children started during the hold inherited the pinned mask: they get the owner's original.
	if quiet__stat "$owner"; then
		for pid in $(quiet__tree "$owner"); do
			[ -z "${restored[$pid]:-}" ] || continue
			[ "$pid" != "$BASHPID" ] || continue
			taskset -apc "$QUIET__OWNER_MASK" "$pid" >/dev/null 2>&1 || true
		done
	fi
}

# quiet hold <mode> --owner PID [--label L] [--log F]: prints exactly one line to stdout --
# `acquired <wait s>`, `nested <mode> <holder> <label>` or `error <reason>` -- and, when acquired,
# holds the lock until SIGTERM or its owner exits. Waiting notices go to stderr.
quiet__hold() {
	local mode="$1" owner="" label="" log=""
	shift
	while [ $# -gt 0 ]; do
		case "$1" in
		--owner) owner="$2" && shift 2 ;;
		--label) label="$2" && shift 2 ;;
		--log) log="$2" && shift 2 ;;
		*) echo "error unknown hold argument $1" && return 2 ;;
		esac
	done
	case "$mode" in shared | exclusive) ;; *) echo "error mode must be shared or exclusive" && return 2 ;; esac
	local t0="$EPOCHREALTIME" me="$BASHPID" common under
	if ! quiet__stat "$owner"; then
		echo "error owner $owner is not running"
		return 1
	fi
	local owner_ticks="$QUIET__TICKS"
	quiet__stat "$me"
	local my_ticks="$QUIET__TICKS"
	common="\"mode\":\"$mode\",\"label\":$(quiet__json_str "$label"),\"owner\":$owner,\"holder\":$me"
	if ! mkdir -p "$QUIET_DIR" "$QUIET_WAITERS" "$QUIET_HOLDERS" 2>/dev/null || ! : >>"$QUIET_LOCK" 2>/dev/null; then
		echo "error cannot create $QUIET_LOCK"
		quiet__log "$log" "\"event\":\"error\",$common,\"detail\":\"cannot create the lock\""
		return 1
	fi

	if under="$(quiet__ancestor_hold "$owner")"; then
		local under_mode="${under%% *}" event="nested"
		if [ "$mode" = "exclusive" ] && [ "$under_mode" = "shared" ]; then
			event="nested-unisolated"
			echo "quiet.sh: WARNING: $label wants the exclusive lock under an ancestor's shared hold ($under): it runs UNISOLATED" >&2
		fi
		quiet__log "$log" "\"event\":\"$event\",$common,\"under\":$(quiet__json_str "$under")"
		echo "nested $under"
		return 0
	fi

	local fd marker=""
	exec {fd}>>"$QUIET_LOCK"
	QUIET__HOLD_MARKER=""
	trap 'rm -f "$QUIET__HOLD_MARKER"; exit 0' TERM INT HUP
	if [ "$mode" = "exclusive" ] && [ "${GSW_QUIET_SELFTEST_NO_MARKER:-0}" != 1 ]; then
		# (GSW_QUIET_SELFTEST_NO_MARKER exists only so test/self-test-quiet.sh can show the
		# starvation the marker prevents.)
		marker="$QUIET_WAITERS/$me"
		QUIET__HOLD_MARKER="$marker"
		printf '%s %s %s %s %s\n' "$me" "$my_ticks" "$EPOCHSECONDS" "$owner" "$label" >"$marker"
	else
		local noticed=0 polls=0
		while quiet__live_waiter; do
			quiet__alive "$owner" "$owner_ticks" || exit 0
			if [ "$noticed" = 0 ] && [ "$polls" -ge 10 ]; then
				echo "quiet.sh: $label waits for a timing leg's exclusive turn (waiter $QUIET__WAITER)" >&2
				noticed=1
			fi
			sleep 0.2
			polls=$((polls + 1))
		done
	fi
	local flag=-s rc noticed=0
	[ "$mode" = "exclusive" ] && flag=-x
	while :; do
		rc=0
		flock -w 1 -E 75 "$flag" "$fd" || rc=$?
		[ "$rc" = 0 ] && break
		if [ "$rc" != 75 ]; then
			rm -f "$marker"
			echo "error flock exited $rc"
			quiet__log "$log" "\"event\":\"error\",$common,\"detail\":\"flock exited $rc\""
			return 1
		fi
		quiet__alive "$owner" "$owner_ticks" || {
			rm -f "$marker"
			exit 0
		}
		if [ "$noticed" = 0 ]; then
			echo "quiet.sh: $label waits for the $mode lock ($(quiet__holders_brief))" >&2
			noticed=1
		fi
		# A marker refreshed while it waits, so a long but live wait never looks stale.
		[ -z "$marker" ] || printf '%s %s %s %s %s\n' "$me" "$my_ticks" "$EPOCHSECONDS" "$owner" "$label" >"$marker"
	done
	rm -f "$marker"
	QUIET__HOLD_MARKER=""
	local t1="$EPOCHREALTIME" since="$EPOCHSECONDS"
	local holder_file="$QUIET_HOLDERS/$me"
	printf '%s %s %s %s %s %s %s\n' "$me" "$my_ticks" "$owner" "$owner_ticks" "$mode" "$since" "$label" >"$holder_file"

	local cpuset=""
	if [ "$mode" = "exclusive" ]; then cpuset="${RS_TIMING_CPUSET:-}"; else cpuset="${RS_BACKGROUND_CPUSET:-}"; fi
	[ -z "$cpuset" ] || quiet__pin "$owner" "$cpuset"

	local wait_s
	wait_s="$(quiet__secs "$t0" "$t1")"
	quiet__log "$log" "\"event\":\"acquire\",$common,\"wait_s\":$wait_s,\"cpuset\":$([ -n "$cpuset" ] && quiet__json_str "$cpuset" || echo null),\"pinned\":${#QUIET__PINNED[@]}"
	echo "acquired $wait_s"

	QUIET__HOLD_DONE=0
	quiet__hold_release() {
		[ "$QUIET__HOLD_DONE" = 0 ] || return 0
		QUIET__HOLD_DONE=1
		[ -z "$cpuset" ] || quiet__unpin "$owner"
		flock -u "$fd" 2>/dev/null || true
		rm -f "$holder_file"
		quiet__log "$log" "\"event\":\"release\",$common,\"hold_s\":$(quiet__secs "$t1" "$EPOCHREALTIME"),\"reason\":\"$1\""
	}
	trap 'quiet__hold_release released; exit 0' TERM INT HUP
	while quiet__alive "$owner" "$owner_ticks"; do
		sleep 0.25 {fd}>&- &
		wait $! 2>/dev/null || true
	done
	quiet__hold_release owner-exited
	exit 0
}

quiet__holders_brief() {
	local f hpid hticks opid oticks mode since label out="" sep=""
	for f in "$QUIET_HOLDERS"/*; do
		[ -f "$f" ] || continue
		{ read -r hpid hticks opid oticks mode since label <"$f"; } 2>/dev/null || continue
		quiet__alive "$hpid" "$hticks" || continue
		out+="$sep$mode $label (pid $opid, $((EPOCHSECONDS - since)) s)"
		sep="; "
	done
	printf '%s' "${out:-no recorded holder}"
}

# --- the bash library (sourced by lib/legs.sh and the runners) --------------------------------

QUIET_LOG="${QUIET_LOG:-}"
QUIET__DEPTH=0
QUIET__MODE=""
QUIET__HOLDER=""
QUIET__RFD=""

# quiet__spawn <mode> <label>: starts a holder for this shell and reads its one line.
quiet__spawn() {
	local mode="$1" label="$2" line="" owner="$BASHPID"
	exec {QUIET__RFD}< <(exec bash "$QUIET_SH" hold "$mode" --owner "$owner" --label "$label" --log "$QUIET_LOG" </dev/null)
	QUIET__HOLDER="$!"
	read -r -u "$QUIET__RFD" line || true
	exec {QUIET__RFD}<&-
	case "$line" in
	acquired*)
		QUIET__MODE="$mode"
		;;
	nested*)
		QUIET__MODE="nested"
		QUIET__HOLDER=""
		;;
	*)
		echo "quiet.sh: WARNING: $label runs without the $mode lock (${line:-the holder exited})" >&2
		QUIET__MODE="none"
		QUIET__HOLDER=""
		;;
	esac
}

# quiet__stop_holder: SIGTERM the holder and wait until it is gone (lock released, pins restored).
quiet__stop_holder() {
	local pid="$QUIET__HOLDER" n=0
	QUIET__HOLDER=""
	[ -n "$pid" ] || return 0
	kill -TERM "$pid" 2>/dev/null || true
	while [ -d "/proc/$pid" ] && [ "$n" -lt 200 ]; do
		quiet__stat "$pid" || break
		sleep 0.01
		n=$((n + 1))
	done
}

# quiet_acquire <shared|exclusive> <label>: blocks until this shell holds the lock (or is nested in
# an ancestor's hold). Re-entrant: an inner call only counts, except that an exclusive call inside
# this shell's own shared hold upgrades it (release, then a fresh exclusive acquire).
quiet_acquire() {
	local mode="$1" label="$2"
	if [ "$QUIET__DEPTH" -gt 0 ]; then
		if [ "$mode" = "exclusive" ] && [ "$QUIET__MODE" = "shared" ]; then
			quiet__stop_holder
			quiet__spawn exclusive "$label (upgrade)"
		fi
		QUIET__DEPTH=$((QUIET__DEPTH + 1))
		return 0
	fi
	quiet__spawn "$mode" "$label"
	QUIET__DEPTH=1
}

quiet_release() {
	[ "$QUIET__DEPTH" -gt 0 ] || return 0
	QUIET__DEPTH=$((QUIET__DEPTH - 1))
	[ "$QUIET__DEPTH" = 0 ] || return 0
	quiet__stop_holder
	QUIET__MODE=""
}

# quiet_run <mode> <label> -- <command...>: the command under a hold; returns its exit status.
quiet_run() {
	local mode="$1" label="$2" rc=0
	shift 3
	quiet_acquire "$mode" "$label"
	"$@" || rc=$?
	quiet_release
	return "$rc"
}

# quiet_summary <out dir> [wall s]: writes <out>/quiet-lock-summary.json from QUIET_LOG and prints
# its one-line digest.
quiet_summary() {
	local out="$1" wall="${2:-}"
	[ -n "$QUIET_LOG" ] || return 0
	[ -f "$QUIET_LOG" ] || : >"$QUIET_LOG"
	bash "$QUIET_SH" summary "$QUIET_LOG" ${wall:+--wall-s "$wall"} --out "$out/quiet-lock-summary.json" || true
}

quiet__summary_cmd() {
	local log="$1" wall="" out=""
	shift
	while [ $# -gt 0 ]; do
		case "$1" in
		--wall-s) wall="$2" && shift 2 ;;
		--out) out="$2" && shift 2 ;;
		*) echo "quiet.sh summary: unknown argument $1" >&2 && return 2 ;;
		esac
	done
	python3 - "$log" "$wall" "$out" <<'PY'
import json, sys

log, wall, out = sys.argv[1], sys.argv[2], sys.argv[3]
events = []
with open(log) as f:
    for line in f:
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
holds, nested, errors = [], [], []
acq = {}
for e in events:
    ev = e.get("event")
    if ev == "acquire":
        acq[e["holder"]] = e
    elif ev == "release":
        a = acq.pop(e["holder"], None)
        holds.append({"mode": e["mode"], "label": e["label"], "wait_s": a["wait_s"] if a else None,
                      "hold_s": e["hold_s"], "start_t": a["t"] if a else None, "reason": e.get("reason")})
    elif ev in ("nested", "nested-unisolated"):
        nested.append({"event": ev, "mode": e["mode"], "label": e["label"], "under": e.get("under")})
    elif ev == "error":
        errors.append(e)
open_holds = [{"mode": a["mode"], "label": a["label"], "wait_s": a["wait_s"], "start_t": a["t"]} for a in acq.values()]
if events:
    span = max(e["t"] for e in events) - min(e["t"] for e in events)
else:
    span = 0.0
wall_s = float(wall) if wall else round(span, 3)
modes = {}
for m in ("exclusive", "shared"):
    hs = [h for h in holds if h["mode"] == m]
    modes[m] = {
        "holds": len(hs),
        "hold_s_total": round(sum(h["hold_s"] for h in hs), 3),
        "hold_s_max": round(max((h["hold_s"] for h in hs), default=0.0), 3),
        "wait_s_total": round(sum(h["wait_s"] or 0 for h in hs), 3),
        "wait_s_max": round(max((h["wait_s"] or 0 for h in hs), default=0.0), 3),
    }
summary = {
    "schema": "render-stream-quiet-lock-summary/1",
    "log": log,
    "wall_s": wall_s,
    "exclusive_fraction": round(modes["exclusive"]["hold_s_total"] / wall_s, 4) if wall_s > 0 else None,
    "modes": modes,
    "nested": len([n for n in nested if n["event"] == "nested"]),
    "nested_unisolated": [n for n in nested if n["event"] == "nested-unisolated"],
    "errors": len(errors),
    "open_holds": open_holds,
    "holds": holds,
}
if out:
    with open(out, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
x, s = modes["exclusive"], modes["shared"]
print(f"quiet lock: exclusive {x['holds']} holds {x['hold_s_total']:.1f} s (max {x['hold_s_max']:.1f} s, waited {x['wait_s_total']:.1f} s); "
      f"shared {s['holds']} holds {s['hold_s_total']:.1f} s (waited {s['wait_s_total']:.1f} s); "
      f"nested {summary['nested']}; wall {wall_s:.1f} s; exclusive {100 * (summary['exclusive_fraction'] or 0):.1f}% of wall")
for h in holds:
    if h["mode"] == "exclusive":
        print(f"  exclusive {h['label']}: hold {h['hold_s']:.1f} s, waited {h['wait_s'] or 0:.1f} s")
PY
}

quiet__status_cmd() {
	local f
	echo "lock: $QUIET_LOCK"
	echo "holders: $(quiet__holders_brief)"
	local any=0 wpid wticks wsince rest
	for f in "$QUIET_WAITERS"/*; do
		[ -f "$f" ] || continue
		{ read -r wpid wticks wsince rest <"$f"; } 2>/dev/null || continue
		if quiet__alive "$wpid" "$wticks"; then
			echo "exclusive waiter: pid $wpid, $((EPOCHSECONDS - wsince)) s since last refresh: $rest"
			any=1
		fi
	done
	[ "$any" = 1 ] || echo "exclusive waiters: none"
}

quiet__main() {
	local cmd="${1:-}"
	[ $# -gt 0 ] && shift
	case "$cmd" in
	hold)
		quiet__hold "$@"
		;;
	shared | exclusive)
		local label="" rc=0
		while [ $# -gt 0 ] && [ "$1" != "--" ]; do
			case "$1" in
			--label) label="$2" && shift 2 ;;
			--log) QUIET_LOG="$2" && shift 2 ;;
			*) echo "quiet.sh: unknown option $1 (usage: quiet.sh $cmd [--label L] [--log F] -- <command...>)" >&2 && return 2 ;;
			esac
		done
		[ "${1:-}" = "--" ] || {
			echo "quiet.sh: usage: quiet.sh $cmd [--label L] [--log F] -- <command...>" >&2
			return 2
		}
		shift
		[ $# -gt 0 ] || {
			echo "quiet.sh: no command after --" >&2
			return 2
		}
		[ -n "$label" ] || label="$cmd: $*"
		label="${label:0:160}"
		# The command runs as a child (the hold outlives it); a TERM/INT/HUP to this wrapper is
		# passed on, so `timeout ... quiet.sh shared -- cmd` never leaves cmd running unlocked.
		quiet_acquire "$cmd" "$label"
		"$@" <&0 &
		local child=$!
		trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT HUP
		while :; do
			rc=0
			wait "$child" || rc=$?
			kill -0 "$child" 2>/dev/null || break
		done
		trap - TERM INT HUP
		quiet_release
		return "$rc"
		;;
	status)
		quiet__status_cmd
		;;
	summary)
		quiet__summary_cmd "$@"
		;;
	*)
		echo "usage: quiet.sh shared|exclusive [--label L] [--log F] -- <command...> | status | summary <log> [--wall-s S] [--out F]" >&2
		return 2
		;;
	esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	set -uo pipefail
	quiet__main "$@"
	exit $?
fi
