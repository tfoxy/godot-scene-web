#!/usr/bin/env bash
# Locked device-leg wrapper for the shared adb-attached phone.
#
# Raw `adb` is a root-only command for orchestrated workers (.codex-orchestration.toml [guard]);
# this script is the sanctioned path for them. It holds one exclusive lock per leg, so two
# worktrees never drive the phone at once. It acts only on packages under an allow-listed
# prefix, never on Chrome or other apps. On every exit, including interruption, it force-stops
# the app it launched and removes the reverses it added, so nothing is left rendering.
#
# Usage:
#   scripts/phone-leg.sh run --pkg <id> --out <artifacts/...> [--apk <file>] [--clear-data]
#                            [--reverse tcp:<port>]... [--seconds N] [--shot <sec>:<name.png>]...
#                            [--until-log <ERE>] [--activity <component>]
#   scripts/phone-leg.sh install --pkg <id> --apk <file>
#   scripts/phone-leg.sh screencap --out <artifacts/...> <name.png>
#   scripts/phone-leg.sh stop --pkg <id>
#
# `run` installs (if --apk), clears app data (if --clear-data), adds reverses (device port ->
# the same host port), launches the launcher activity, takes the scheduled screenshots, ends
# after --seconds (default 20) or as soon as app logcat matches --until-log, and writes
# logcat.txt (everything since launch) and logcat-app.txt (the app's pid only) to --out.
#
# Environment:
#   ANDROID_SERIAL          required; the device to drive.
#   GSW_PHONE_PKG_PREFIX    allow-listed package prefix (default "dev.gsw.").
#   GSW_PHONE_LOCK          lock file (default ~/.cache/gsw-phone-leg.lock).
#   GSW_PHONE_LOCK_WAIT     seconds to wait for the lock (default 900).
#   GSW_PHONE_POLL          seconds between --until-log polls (default 1).
#   ADB                     adb binary (default "adb"; the self-test substitutes a fake).
#
# --out must resolve inside the current checkout's ignored artifacts/ directory.

set -euo pipefail

ADB="${ADB:-adb}"
PKG_PREFIX="${GSW_PHONE_PKG_PREFIX:-dev.gsw.}"
LOCK="${GSW_PHONE_LOCK:-$HOME/.cache/gsw-phone-leg.lock}"
LOCK_WAIT="${GSW_PHONE_LOCK_WAIT:-900}"
POLL="${GSW_PHONE_POLL:-1}"

die() { echo "phone-leg: $*" >&2; exit 2; }
log() { echo "phone-leg: $*" >&2; }

# Every adb call closes the lock fd: a first call forks the adb server daemon, which would
# otherwise inherit fd 9 and hold the phone lock for as long as the server lives.
adbc() { "$ADB" "$@" 9>&-; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

check_pkg() {
  local pkg="$1"
  [[ "$pkg" =~ ^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$ ]] || die "invalid package id: $pkg"
  [[ "$pkg" == "$PKG_PREFIX"* ]] || die "package $pkg is outside the allow-listed prefix $PKG_PREFIX"
}

check_out() { # prints the resolved directory
  local out="$1" top resolved
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "--out needs to run inside a git checkout"
  resolved="$(realpath -m -- "$out")"
  [[ "$resolved" == "$top/artifacts/"* ]] || die "--out must be inside $top/artifacts/ (got $resolved)"
  printf '%s\n' "$resolved"
}

check_name() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+\.png$ ]] || die "screenshot name must be a plain *.png file name: $1"
}

check_port() {
  [[ "$1" =~ ^tcp:([0-9]{1,5})$ ]] && (( BASH_REMATCH[1] >= 1 && BASH_REMATCH[1] <= 65535 )) \
    || die "reverse spec must be tcp:<port>: $1"
}

acquire_lock() {
  [[ -n "${ANDROID_SERIAL:-}" ]] || die "ANDROID_SERIAL is required"
  export ANDROID_SERIAL
  mkdir -p "$(dirname "$LOCK")"
  exec 9>"$LOCK"
  if ! flock -w "$LOCK_WAIT" 9; then
    die "phone is busy: could not take $LOCK within ${LOCK_WAIT}s"
  fi
  local state
  state="$(adbc get-state 2>/dev/null || true)"
  [[ "$state" == device ]] || die "device $ANDROID_SERIAL is not ready (state: ${state:-absent})"
}

# --- teardown -------------------------------------------------------------------------------
TEARDOWN_PKG=""
TEARDOWN_PORTS=()
teardown() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [[ -n "$TEARDOWN_PKG" ]]; then
    adbc shell am force-stop "$TEARDOWN_PKG" >/dev/null 2>&1 || log "force-stop $TEARDOWN_PKG failed"
  fi
  local p
  for p in "${TEARDOWN_PORTS[@]+"${TEARDOWN_PORTS[@]}"}"; do
    adbc reverse --remove "$p" >/dev/null 2>&1 || log "reverse --remove $p failed"
  done
  exit "$rc"
}
on_signal() { log "interrupted; tearing down"; exit 130; }

screencap_to() { # screencap_to <file>
  local tmp="$1.part"
  adbc exec-out screencap -p >"$tmp"
  [[ -s "$tmp" ]] || { rm -f "$tmp"; log "screencap produced no bytes: $1"; return 1; }
  mv "$tmp" "$1"
  log "screenshot $1"
}

# --- verbs ----------------------------------------------------------------------------------
cmd_install() {
  local pkg="" apk=""
  while (($#)); do
    case "$1" in
      --pkg) pkg="${2:?}"; shift 2 ;;
      --apk) apk="${2:?}"; shift 2 ;;
      *) die "install: unknown argument $1" ;;
    esac
  done
  check_pkg "$pkg"; [[ -f "$apk" ]] || die "no such apk: $apk"
  acquire_lock
  adbc install -r "$apk"
}

cmd_stop() {
  local pkg=""
  while (($#)); do
    case "$1" in
      --pkg) pkg="${2:?}"; shift 2 ;;
      *) die "stop: unknown argument $1" ;;
    esac
  done
  check_pkg "$pkg"
  acquire_lock
  adbc shell am force-stop "$pkg"
}

cmd_screencap() {
  local out="" name=""
  while (($#)); do
    case "$1" in
      --out) out="${2:?}"; shift 2 ;;
      -*) die "screencap: unknown argument $1" ;;
      *) name="$1"; shift ;;
    esac
  done
  [[ -n "$out" && -n "$name" ]] || die "screencap needs --out <dir> <name.png>"
  check_name "$name"; out="$(check_out "$out")"
  acquire_lock
  mkdir -p "$out"
  screencap_to "$out/$name"
}

cmd_run() {
  local pkg="" out="" apk="" clear=0 seconds=20 until_re="" activity=""
  local -a ports=() shots=()
  while (($#)); do
    case "$1" in
      --pkg) pkg="${2:?}"; shift 2 ;;
      --out) out="${2:?}"; shift 2 ;;
      --apk) apk="${2:?}"; shift 2 ;;
      --clear-data) clear=1; shift ;;
      --reverse) ports+=("${2:?}"); shift 2 ;;
      --seconds) seconds="${2:?}"; shift 2 ;;
      --shot) shots+=("${2:?}"); shift 2 ;;
      --until-log) until_re="${2:?}"; shift 2 ;;
      --activity) activity="${2:?}"; shift 2 ;;
      *) die "run: unknown argument $1" ;;
    esac
  done
  check_pkg "$pkg"
  [[ -n "$out" ]] || die "run needs --out"
  out="$(check_out "$out")"
  [[ -z "$apk" || -f "$apk" ]] || die "no such apk: $apk"
  [[ "$seconds" =~ ^[0-9]+$ ]] || die "--seconds must be a whole number"
  local p s
  for p in "${ports[@]+"${ports[@]}"}"; do check_port "$p"; done
  for s in "${shots[@]+"${shots[@]}"}"; do
    [[ "$s" =~ ^([0-9]+):(.+)$ ]] || die "--shot must be <sec>:<name.png>: $s"
    check_name "${BASH_REMATCH[2]}"
  done
  if [[ -n "$activity" ]]; then
    [[ "$activity" == "$pkg/"* ]] || die "--activity must be a component of $pkg"
  fi

  acquire_lock
  mkdir -p "$out"
  TEARDOWN_PKG="$pkg"
  trap teardown EXIT
  trap on_signal INT TERM HUP

  [[ -z "$apk" ]] || adbc install -r "$apk"
  ((clear == 0)) || adbc shell pm clear "$pkg" >/dev/null
  for p in "${ports[@]+"${ports[@]}"}"; do
    adbc reverse "$p" "$p" >/dev/null
    TEARDOWN_PORTS+=("$p")
  done
  if [[ -z "$activity" ]]; then
    activity="$(adbc shell cmd package resolve-activity --brief -c android.intent.category.LAUNCHER "$pkg" \
      | tr -d '\r' | tail -n 1)"
    [[ "$activity" == "$pkg/"* ]] || die "could not resolve the launcher activity of $pkg (is it installed?)"
  fi

  local since
  since="$(adbc shell date +%m-%d\ %H:%M:%S.000 | tr -d '\r')"
  adbc shell am start -W -n "$activity" >/dev/null
  log "launched $activity"
  local t0=$SECONDS pid="" done_shots="" elapsed matched=0
  while :; do
    elapsed=$((SECONDS - t0))
    [[ -n "$pid" ]] || pid="$(adbc shell pidof "$pkg" 2>/dev/null | tr -d '\r' || true)"
    for s in "${shots[@]+"${shots[@]}"}"; do
      [[ "$s" =~ ^([0-9]+):(.+)$ ]]
      if (( elapsed >= BASH_REMATCH[1] )) && [[ " $done_shots " != *" ${BASH_REMATCH[2]} "* ]]; then
        screencap_to "$out/${BASH_REMATCH[2]}" || true
        done_shots+=" ${BASH_REMATCH[2]}"
      fi
    done
    if [[ -n "$until_re" && -n "$pid" ]] \
       && adbc logcat -d --pid="$pid" -T "$since" 2>/dev/null | grep -Eq -- "$until_re"; then
      matched=1; log "matched --until-log after ${elapsed}s"; break
    fi
    (( elapsed < seconds )) || break
    sleep "$POLL"
  done
  # A shot scheduled later than the end of the leg is still taken, once, before teardown.
  for s in "${shots[@]+"${shots[@]}"}"; do
    [[ "$s" =~ ^([0-9]+):(.+)$ ]]
    [[ " $done_shots " == *" ${BASH_REMATCH[2]} "* ]] || screencap_to "$out/${BASH_REMATCH[2]}" || true
  done
  adbc logcat -d -T "$since" >"$out/logcat.txt" 2>/dev/null || true
  if [[ -n "$pid" ]]; then
    adbc logcat -d --pid="$pid" -T "$since" >"$out/logcat-app.txt" 2>/dev/null || true
  else
    log "the app had no pid during the leg (crashed or never started); see logcat.txt"
  fi
  if [[ -n "$until_re" && $matched -eq 0 ]]; then
    log "--until-log did not match within ${seconds}s"
    exit 1
  fi
}

(($#)) || usage
verb="$1"; shift
case "$verb" in
  run) cmd_run "$@" ;;
  install) cmd_install "$@" ;;
  screencap) cmd_screencap "$@" ;;
  stop) cmd_stop "$@" ;;
  -h|--help|help) usage ;;
  *) die "unknown verb $verb (run|install|screencap|stop)" ;;
esac
