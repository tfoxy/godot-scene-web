#!/usr/bin/env bash
# quiet.sh -- the machine-wide measurement-isolation lock for render-stream runs
# (results/measurement-isolation.md). One lock, shared by every worktree and agent on the box:
#
#   ${GSW_QUIET_LOCK:-${GSW_QUIET_DIR:-${RS_QUIET_LOCK_DIR:-${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web}}/quiet.lock}
#
# RS_QUIET_LOCK_DIR (GRT) points a run at a PRIVATE lock directory: correctness-only runs (the lock
# and pure self-tests, synthetic scheduler tests) then neither wait on nor disturb other agents'
# timing legs. Never set it for a gate run whose legs share the machine with other agents.
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
# Scheduling v2 (GRT, results/grt.md) changes only WHEN holders are admitted, never the exclusion.
#
# Share window: the marker alone let each concurrent runner run ONE shared leg per exclusive leg --
# a runner's next leg always found the next timing leg's marker up -- so a series of 6-minute soaks
# stalled every correctness runner for hours. Now, after an exclusive release, shared work gets a
# window of GSW_QUIET_SHARE_PCT percent of that hold (default 50, clamped to
# [GSW_QUIET_SHARE_MIN_S, GSW_QUIET_SHARE_MAX_S], default 0 and 180 s):
#   - an exclusive acquirer arriving inside the window DEFERS (no marker yet) while shared demand
#     exists: a live shared holder, or a shared waiter registered in <lock>.swaiters/. It stops
#     deferring when the window closes or demand has been absent for GSW_QUIET_SHARE_LINGER_S
#     (default 3 s; 1 s on entry), then posts its marker (`<pid>.v2`) and proceeds as before;
#   - a shared acquirer inside the window ignores markers written by old (v1) holders, which do
#     not defer; it honours every `.v2` marker, posted only once its window is over.
# The window starts at the last exclusive `release` in <lock>.events.log, which v1 and v2 holders
# both write. The exclusion itself is flock's and unchanged: no shared hold coexists with an
# exclusive one whichever version took either. GSW_QUIET_SCHED=v1 restores the old scheduling.
#
# Backfill: an exclusive acquirer waiting for in-flight shared legs to drain used to block every
# new shared leg behind the longest of them (10.9 h of 95 h on this box had exactly ONE shared
# holder running while an exclusive waited: a checker, or a wrapped test suite). A v2 shared holder
# records its hold length per label (<lock>.stats/, last 5) and, while it holds, its expected end
# (<lock>.expect/<holder>: start + the label's shortest recent hold). A new shared leg behind a
# drain is admitted when its label's longest recent hold x 1.25 + 1 s ends before every in-flight
# shared holder is expected to; any holder without an expectation (v1, or no history) or any
# exclusive holder means no backfill. A misestimate delays the exclusive by at most the overrun.
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
QUIET_DIR="${GSW_QUIET_DIR:-${RS_QUIET_LOCK_DIR:-${XDG_RUNTIME_DIR:-/tmp}/godot-scene-web}}"
QUIET_LOCK="${GSW_QUIET_LOCK:-$QUIET_DIR/quiet.lock}"
QUIET_WAITERS="$QUIET_LOCK.waiters"
QUIET_HOLDERS="$QUIET_LOCK.holders"
QUIET_EVENTS="$QUIET_LOCK.events.log"
QUIET_MARKER_MAX_S="${GSW_QUIET_MARKER_MAX_S:-3600}"
QUIET_SWAITERS="$QUIET_LOCK.swaiters"
QUIET_DEFERRED="$QUIET_LOCK.deferred"
QUIET_SCHED="${GSW_QUIET_SCHED:-v2}"
QUIET_SHARE_PCT="${GSW_QUIET_SHARE_PCT:-50}"
QUIET_SHARE_MIN_S="${GSW_QUIET_SHARE_MIN_S:-0}"
QUIET_SHARE_MAX_S="${GSW_QUIET_SHARE_MAX_S:-180}"
QUIET_SHARE_LINGER_S="${GSW_QUIET_SHARE_LINGER_S:-3}"
QUIET_STATS="$QUIET_LOCK.stats"
QUIET_EXPECT="$QUIET_LOCK.expect"

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

# quiet__live_waiter: true when a live exclusive waiter's marker exists (removes stale ones). Sets
# QUIET__WAITER_V2=1 when one of the live markers is a v2 one (`<pid>.v2`: posted after its share
# window, so never bypassed), else 0 (only v1 markers, which a share window may bypass).
quiet__live_waiter() {
	local f wpid wticks wsince rest found=1
	QUIET__WAITER_V2=0
	for f in "$QUIET_WAITERS"/*; do
		[ -f "$f" ] || continue
		{ read -r wpid wticks wsince rest <"$f"; } 2>/dev/null || continue
		if quiet__alive "$wpid" "$wticks" && [ $((EPOCHSECONDS - wsince)) -le "$QUIET_MARKER_MAX_S" ]; then
			QUIET__WAITER="$wpid $rest"
			found=0
			case "$f" in *.v2) QUIET__WAITER_V2=1 ;; esac
			continue
		fi
		rm -f "$f"
	done
	return "$found"
}

# --- the share window (header: "Share window") ---------------------------------------------

quiet__now_us() {
	local t="${EPOCHREALTIME/[.,]/}"
	printf '%s' "$((10#$t))"
}

# quiet__last_excl_release: sets QUIET__XREL_US (when) and QUIET__XHOLD_US (how long it held) from
# the last exclusive release in the machine-wide events log (v1 and v2 holders both log it).
quiet__last_excl_release() {
	local line="" f
	for f in "$QUIET_EVENTS" "$QUIET_EVENTS.1"; do
		[ -f "$f" ] || continue
		line="$(tail -c 262144 "$f" 2>/dev/null | grep -F '"event":"release","mode":"exclusive"' | tail -n 1)"
		[ -z "$line" ] || break
	done
	[[ $line =~ \"t\":([0-9]+)[.,]([0-9]{6}) ]] || return 1
	QUIET__XREL_US=$((10#${BASH_REMATCH[1]} * 1000000 + 10#${BASH_REMATCH[2]}))
	[[ $line =~ \"hold_s\":([0-9]+)\.([0-9]{3}) ]] || return 1
	QUIET__XHOLD_US=$(((10#${BASH_REMATCH[1]} * 1000 + 10#${BASH_REMATCH[2]}) * 1000))
}

# quiet__secs_us <decimal seconds>: as integer microseconds (up to 6 decimals).
quiet__secs_us() {
	local s="$1" i f
	i="${s%%.*}"
	f=""
	[ "$i" = "$s" ] || f="${s#*.}"
	f="${f}000000"
	f="${f:0:6}"
	printf '%s' "$((10#${i:-0} * 1000000 + 10#$f))"
}

# quiet__share_window_open: true while the share window after the last exclusive release is open;
# sets QUIET__WINDOW_LEFT_US.
quiet__share_window_open() {
	[ "$QUIET_SCHED" != v1 ] || return 1
	quiet__last_excl_release || return 1
	local len min max now
	len=$((QUIET__XHOLD_US * QUIET_SHARE_PCT / 100))
	min="$(quiet__secs_us "$QUIET_SHARE_MIN_S")"
	max="$(quiet__secs_us "$QUIET_SHARE_MAX_S")"
	[ "$len" -ge "$min" ] || len="$min"
	[ "$len" -le "$max" ] || len="$max"
	now="$(quiet__now_us)"
	QUIET__WINDOW_LEFT_US=$((QUIET__XREL_US + len - now))
	[ "$QUIET__WINDOW_LEFT_US" -gt 0 ]
}

# quiet__shared_demand: true when a live shared holder or a registered shared waiter exists.
quiet__shared_demand() {
	local f a b c d mode rest
	for f in "$QUIET_HOLDERS"/*; do
		[ -f "$f" ] || continue
		{ read -r a b c d mode rest <"$f"; } 2>/dev/null || continue
		[ "$mode" = shared ] && quiet__alive "$a" "$b" && return 0
	done
	for f in "$QUIET_SWAITERS"/*; do
		[ -f "$f" ] || continue
		{ read -r a b rest <"$f"; } 2>/dev/null || continue
		quiet__alive "$a" "$b" && return 0
		rm -f "$f"
	done
	return 1
}

# --- backfill (header: "Backfill") ----------------------------------------------------------

# quiet__label_key <label>: a file-name-safe key for a label's hold history.
quiet__label_key() {
	local k
	k="$(printf '%s' "$1" | cksum)"
	printf '%s' "${k%% *}"
}

# quiet__history <label>: sets QUIET__HMIN_US / QUIET__HMAX_US from the label's last holds (up to
# 5); fails when it has none.
quiet__history() {
	local f v us
	f="$QUIET_STATS/$(quiet__label_key "$1")"
	[ -f "$f" ] || return 1
	QUIET__HMIN_US=""
	QUIET__HMAX_US=""
	while read -r v; do
		[ -n "$v" ] || continue
		us="$(quiet__secs_us "$v")"
		[ -n "$QUIET__HMIN_US" ] && [ "$us" -ge "$QUIET__HMIN_US" ] || QUIET__HMIN_US="$us"
		[ -n "$QUIET__HMAX_US" ] && [ "$us" -le "$QUIET__HMAX_US" ] || QUIET__HMAX_US="$us"
	done <"$f" 2>/dev/null
	[ -n "$QUIET__HMAX_US" ]
}

# quiet__record <label> <hold s>: appends a shared hold's length to its label's history (last 5).
quiet__record() {
	local f tmp
	f="$QUIET_STATS/$(quiet__label_key "$1")"
	mkdir -p "$QUIET_STATS" 2>/dev/null || return 0
	tmp="$f.$BASHPID"
	{
		tail -n 4 "$f" 2>/dev/null
		printf '%s\n' "$2"
	} >"$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null
	rm -f "$tmp" 2>/dev/null || true
	# Labels with run-specific words (a wrapped command's paths) would grow the history forever:
	# about one release in 200 drops histories nobody has updated for 30 days.
	[ $((RANDOM % 200)) != 0 ] || find "$QUIET_STATS" -type f -mtime +30 -delete 2>/dev/null || true
}

# quiet__backfill_fits <own label>: while an exclusive acquirer waits for the in-flight shared
# holds to drain, true when this leg is expected to end before the drain does -- so admitting it
# costs the exclusive acquirer nothing. Needs an expected end (<lock>.expect/<holder>, from the
# label's SHORTEST recent hold) for every in-flight shared holder (a v1 holder or a label without
# history has none: then never), no exclusive holder, and this label's LONGEST recent hold x 1.25
# + 1 s to fit before the latest of them.
quiet__backfill_fits() {
	[ "$QUIET_SCHED" != v1 ] || return 1
	quiet__history "$1" || return 1
	local need=$((QUIET__HMAX_US * 5 / 4 + 1000000))
	local f a b c d mode rest e_pid e_ticks e_end drain=0 any=0
	for f in "$QUIET_HOLDERS"/*; do
		[ -f "$f" ] || continue
		{ read -r a b c d mode rest <"$f"; } 2>/dev/null || continue
		quiet__alive "$a" "$b" || continue
		[ "$mode" = shared ] || return 1
		{ read -r e_pid e_ticks e_end <"$QUIET_EXPECT/$a"; } 2>/dev/null || return 1
		[ "$e_ticks" = "$b" ] || return 1
		any=1
		[ "$e_end" -le "$drain" ] || drain="$e_end"
	done
	[ "$any" = 1 ] || return 1
	[ $(($(quiet__now_us) + need)) -le "$drain" ]
}

# quiet__defer <owner> <owner ticks> <label> <me> <ticks> <since>: an exclusive acquirer inside a share
# window waits, without a marker, while shared demand lasts. Sets QUIET__DEFER_US.
quiet__defer() {
	local owner="$1" oticks="$2" label="$3" me="$4" ticks="$5"
	QUIET__DEFER_US=0
	quiet__share_window_open || return 0
	local start now last linger noticed=0 f="$QUIET_DEFERRED/$me"
	start="$(quiet__now_us)"
	linger="$(quiet__secs_us "$QUIET_SHARE_LINGER_S")"
	last=$((start - (linger > 1000000 ? linger - 1000000 : 0)))
	mkdir -p "$QUIET_DEFERRED" 2>/dev/null || true
	printf '%s %s %s %s %s\n' "$me" "$ticks" "$EPOCHSECONDS" "$owner" "$label" >"$f"
	QUIET__CLEAN+=("$f")
	now="$start"
	while quiet__share_window_open; do
		quiet__alive "$owner" "$oticks" || {
			rm -f "$f"
			exit 0
		}
		now="$(quiet__now_us)"
		# Never longer than one maximal window in all, however often other exclusive holders
		# (v1 ones, which do not defer) reopen it meanwhile.
		[ $((now - start)) -lt "$(quiet__secs_us "$QUIET_SHARE_MAX_S")" ] || break
		if quiet__shared_demand; then
			last="$now"
		elif [ $((now - last)) -ge "$linger" ]; then
			break
		fi
		if [ "$noticed" = 0 ] && [ $((now - start)) -ge 1000000 ]; then
			echo "quiet.sh: $label lets queued shared legs run first (share window, $((QUIET__WINDOW_LEFT_US / 1000000)) s left)" >&2
			noticed=1
		fi
		sleep 0.25
	done
	rm -f "$f"
	now="$(quiet__now_us)"
	QUIET__DEFER_US=$((now - start))
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

	local fd marker="" swaiter="" sched="\"sched\":\"$QUIET_SCHED\""
	exec {fd}>>"$QUIET_LOCK"
	QUIET__CLEAN=()
	trap 'rm -f "${QUIET__CLEAN[@]}"; exit 0' TERM INT HUP
	if [ "$mode" = "exclusive" ]; then
		QUIET__DEFER_US=0
		[ "$QUIET_SCHED" = v1 ] || quiet__defer "$owner" "$owner_ticks" "$label" "$me" "$my_ticks"
		sched+=",\"deferred_s\":$(quiet__secs 0 "$QUIET__DEFER_US")"
	fi
	if [ "$mode" = "exclusive" ] && [ "${GSW_QUIET_SELFTEST_NO_MARKER:-0}" != 1 ]; then
		# (GSW_QUIET_SELFTEST_NO_MARKER exists only so test/self-test-quiet.sh can show the
		# starvation the marker prevents.) A v2 marker is never bypassed by a share window: this
		# acquirer already deferred to it. GSW_QUIET_SCHED=v1 writes the v1 name.
		marker="$QUIET_WAITERS/$me"
		[ "$QUIET_SCHED" = v1 ] || marker+=".v2"
		QUIET__CLEAN+=("$marker")
		printf '%s %s %s %s %s\n' "$me" "$my_ticks" "$EPOCHSECONDS" "$owner" "$label" >"$marker"
	else
		# Registered while it waits, so a deferring exclusive acquirer sees the demand.
		if [ "$mode" = "shared" ] && [ "$QUIET_SCHED" != v1 ]; then
			mkdir -p "$QUIET_SWAITERS" 2>/dev/null || true
			swaiter="$QUIET_SWAITERS/$me"
			QUIET__CLEAN+=("$swaiter")
			printf '%s %s %s %s %s\n' "$me" "$my_ticks" "$EPOCHSECONDS" "$owner" "$label" >"$swaiter"
		fi
		local noticed=0 polls=0
		while quiet__live_waiter; do
			quiet__alive "$owner" "$owner_ticks" || {
				rm -f "$swaiter"
				exit 0
			}
			# Inside a share window, a v1 (non-deferring) waiter's marker does not hold this leg.
			if [ "$mode" = "shared" ] && [ "$QUIET__WAITER_V2" = 0 ] && quiet__share_window_open; then
				sched+=",\"bypassed_v1_marker\":true"
				break
			fi
			# Behind a drain, a leg that will be done before the drain is admitted (backfill).
			if [ "$mode" = "shared" ] && quiet__backfill_fits "$label"; then
				sched+=",\"backfill\":true"
				break
			fi
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
			rm -f "$marker" "$swaiter"
			echo "error flock exited $rc"
			quiet__log "$log" "\"event\":\"error\",$common,\"detail\":\"flock exited $rc\""
			return 1
		fi
		quiet__alive "$owner" "$owner_ticks" || {
			rm -f "$marker" "$swaiter"
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
	local t1="$EPOCHREALTIME" since="$EPOCHSECONDS"
	local holder_file="$QUIET_HOLDERS/$me"
	printf '%s %s %s %s %s %s %s\n' "$me" "$my_ticks" "$owner" "$owner_ticks" "$mode" "$since" "$label" >"$holder_file"
	# (After the holder file, so a deferring exclusive acquirer never sees a gap in the demand.)
	[ -z "$swaiter" ] || rm -f "$swaiter"
	QUIET__CLEAN=()
	local expect_file=""
	if [ "$mode" = "shared" ] && [ "$QUIET_SCHED" != v1 ] && quiet__history "$label"; then
		mkdir -p "$QUIET_EXPECT" 2>/dev/null || true
		expect_file="$QUIET_EXPECT/$me"
		printf '%s %s %s\n' "$me" "$my_ticks" "$(($(quiet__now_us) + QUIET__HMIN_US))" >"$expect_file"
	fi

	local cpuset=""
	if [ "$mode" = "exclusive" ]; then cpuset="${RS_TIMING_CPUSET:-}"; else cpuset="${RS_BACKGROUND_CPUSET:-}"; fi
	[ -z "$cpuset" ] || quiet__pin "$owner" "$cpuset"

	local wait_s
	wait_s="$(quiet__secs "$t0" "$t1")"
	quiet__log "$log" "\"event\":\"acquire\",$common,\"wait_s\":$wait_s,$sched,\"cpuset\":$([ -n "$cpuset" ] && quiet__json_str "$cpuset" || echo null),\"pinned\":${#QUIET__PINNED[@]}"
	echo "acquired $wait_s"

	QUIET__HOLD_DONE=0
	quiet__hold_release() {
		[ "$QUIET__HOLD_DONE" = 0 ] || return 0
		QUIET__HOLD_DONE=1
		[ -z "$cpuset" ] || quiet__unpin "$owner"
		flock -u "$fd" 2>/dev/null || true
		rm -f "$holder_file" ${expect_file:+"$expect_file"}
		local hold_s
		hold_s="$(quiet__secs "$t1" "$EPOCHREALTIME")"
		quiet__log "$log" "\"event\":\"release\",$common,\"hold_s\":$hold_s,\"reason\":\"$1\""
		[ "$mode" != "shared" ] || [ "$QUIET_SCHED" = v1 ] || quiet__record "$label" "$hold_s"
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
                      "hold_s": e["hold_s"], "start_t": a["t"] if a else None, "reason": e.get("reason"),
                      "deferred_s": a.get("deferred_s") if a else None,
                      "bypassed_v1_marker": bool(a.get("bypassed_v1_marker")) if a else False})
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
        "deferred_s_total": round(sum(h.get("deferred_s") or 0 for h in hs), 3),
        "bypassed_v1_marker": sum(1 for h in hs if h.get("bypassed_v1_marker")),
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
	for f in "$QUIET_DEFERRED"/*; do
		[ -f "$f" ] || continue
		{ read -r wpid wticks wsince rest <"$f"; } 2>/dev/null || continue
		quiet__alive "$wpid" "$wticks" && echo "exclusive deferring to shared demand: pid $wpid, $((EPOCHSECONDS - wsince)) s: $rest"
	done
	local n=0
	for f in "$QUIET_SWAITERS"/*; do
		[ -f "$f" ] || continue
		{ read -r wpid wticks rest <"$f"; } 2>/dev/null || continue
		quiet__alive "$wpid" "$wticks" && n=$((n + 1))
	done
	echo "shared waiters (v2): $n"
	echo "scheduling: $QUIET_SCHED"
	if quiet__share_window_open; then
		echo "share window: open, $((QUIET__WINDOW_LEFT_US / 1000000)) s left"
	else
		echo "share window: closed"
	fi
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
