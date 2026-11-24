#!/usr/bin/env bash
# Self-test for scripts/phone-leg.sh, against a fake adb (no device needed).
# Covers argument and package allow-list refusals, the artifacts/ confinement, a full `run`,
# teardown on failure and on SIGTERM, and lock contention.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
LEG="$REPO/scripts/phone-leg.sh"

WORK="$(mktemp -d)"
OUT_REL="artifacts/phone-leg-selftest-$$"
cleanup() { rm -rf "$WORK" "$REPO/$OUT_REL"; }
trap cleanup EXIT

CALLS="$WORK/calls"
cat >"$WORK/adb" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_ADB_CALLS"
case "$*" in
  get-state) echo device ;;
  "shell date"*) echo "11-24 10:00:00.000" ;;
  "shell cmd package resolve-activity"*) echo "priority=0"; echo "dev.gsw.test/com.godot.game.GodotApp" ;;
  "shell pidof"*) echo 4242 ;;
  "exec-out screencap -p") [ -n "${FAKE_ADB_SCREENCAP_FAIL:-}" ] && exit 1; printf '\x89PNGfake' ;;
  logcat*--pid*) echo "I godot: digest=abc123" ;;
  logcat*) echo "I ActivityManager: start" ;;
esac
exit 0
FAKE
chmod +x "$WORK/adb"
APK="$WORK/app.apk"; : >"$APK"

export ADB="$WORK/adb" FAKE_ADB_CALLS="$CALLS" GSW_PHONE_LOCK="$WORK/lock" GSW_PHONE_POLL=0.1
export ANDROID_SERIAL=FAKE123

pass=0; fail=0
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $*" >&2; }

expect_refused() { # expect_refused <label> <args...>
  local label="$1"; shift
  : >"$CALLS"
  if "$LEG" "$@" 2>"$WORK/err"; then bad "$label: exited 0"; return; fi
  if [ -s "$CALLS" ]; then bad "$label: adb was called: $(tr '\n' ';' <"$CALLS")"; return; fi
  ok
}

ANDROID_SERIAL="" expect_refused "empty serial" stop --pkg dev.gsw.test
expect_refused "chrome refused" stop --pkg com.android.chrome
expect_refused "prefix lookalike" stop --pkg dev.gswx.test
expect_refused "bad package syntax" stop --pkg 'dev.gsw.test;rm'
expect_refused "out outside artifacts" screencap --out "$WORK" a.png
expect_refused "out escapes artifacts" screencap --out "artifacts/../src" a.png
expect_refused "bad shot name" screencap --out "$OUT_REL" ../x.png
expect_refused "bad reverse" run --pkg dev.gsw.test --out "$OUT_REL" --reverse tcp:abc
expect_refused "reverse non-tcp" run --pkg dev.gsw.test --out "$OUT_REL" --reverse localabstract:x
expect_refused "foreign activity" run --pkg dev.gsw.test --out "$OUT_REL" --activity com.other/.Main
expect_refused "unknown verb" uninstall --pkg dev.gsw.test
( unset ANDROID_SERIAL; expect_refused "unset serial" stop --pkg dev.gsw.test; exit $fail ) || bad "unset serial"

# Full run: install, clear, reverse, launch, shots, logcat, until-log, teardown.
: >"$CALLS"
if "$LEG" run --pkg dev.gsw.test --apk "$APK" --clear-data --reverse tcp:8765 --reverse tcp:13337 \
     --seconds 5 --shot 0:first.png --shot 99:late.png --until-log 'digest=' --out "$OUT_REL" 2>"$WORK/err"; then
  for want in "install -r $APK" "shell pm clear dev.gsw.test" "reverse tcp:8765 tcp:8765" \
              "reverse tcp:13337 tcp:13337" "shell am start -W -n dev.gsw.test/com.godot.game.GodotApp" \
              "shell am force-stop dev.gsw.test" "reverse --remove tcp:8765" "reverse --remove tcp:13337"; do
    grep -qxF -- "$want" "$CALLS" || bad "run: missing adb call '$want'"
  done
  for f in first.png late.png logcat.txt logcat-app.txt; do
    [ -s "$REPO/$OUT_REL/$f" ] || bad "run: missing $f"
  done
  [ "$(tail -n 3 "$CALLS" | tr '\n' ';')" = "shell am force-stop dev.gsw.test;reverse --remove tcp:8765;reverse --remove tcp:13337;" ] \
    || bad "run: teardown is not the final three calls: $(tail -n 3 "$CALLS" | tr '\n' ';')"
  ok
else
  bad "run: exited non-zero: $(cat "$WORK/err")"
fi

# Teardown on failure: until-log never matches -> exit 1, app still force-stopped.
: >"$CALLS"
if "$LEG" run --pkg dev.gsw.test --seconds 0 --until-log 'never-matches' --out "$OUT_REL" 2>/dev/null; then
  bad "unmatched until-log: exited 0"
else
  grep -qxF "shell am force-stop dev.gsw.test" "$CALLS" && ok || bad "unmatched until-log: no force-stop"
fi

# Teardown on SIGTERM mid-leg.
: >"$CALLS"
"$LEG" run --pkg dev.gsw.test --reverse tcp:8765 --seconds 30 --out "$OUT_REL" 2>/dev/null &
leg=$!
for _ in $(seq 50); do grep -q "am start" "$CALLS" 2>/dev/null && break; sleep 0.1; done
kill -TERM "$leg"; wait "$leg"; rc=$?
if [ "$rc" -ne 130 ]; then bad "sigterm: exit $rc, want 130"; fi
grep -qxF "shell am force-stop dev.gsw.test" "$CALLS" && grep -qxF "reverse --remove tcp:8765" "$CALLS" \
  && ok || bad "sigterm: teardown incomplete: $(tr '\n' ';' <"$CALLS")"

# Lock contention: a held lock makes the leg fail after the wait, without touching adb.
: >"$CALLS"
flock "$GSW_PHONE_LOCK" sleep 5 &
holder=$!
for _ in $(seq 50); do flock -n "$GSW_PHONE_LOCK" true 2>/dev/null || break; sleep 0.1; done
if GSW_PHONE_LOCK_WAIT=1 "$LEG" stop --pkg dev.gsw.test 2>"$WORK/err"; then
  bad "lock: exited 0 while held"
elif ! grep -q "phone is busy" "$WORK/err"; then
  bad "lock: unexpected error: $(cat "$WORK/err")"
elif [ -s "$CALLS" ]; then
  bad "lock: adb called while lock held"
else
  ok
fi
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null

# The adb call must not inherit the lock fd (a forked adb server would hold the lock forever).
cat >"$WORK/adb-fd" <<'FAKE'
#!/usr/bin/env bash
[ -e /proc/self/fd/9 ] && echo "fd9-open" >>"$FAKE_ADB_CALLS"
echo device
FAKE
chmod +x "$WORK/adb-fd"
: >"$CALLS"
ADB="$WORK/adb-fd" "$LEG" stop --pkg dev.gsw.test >/dev/null 2>&1
grep -q fd9-open "$CALLS" && bad "adb inherited the lock fd" || ok

echo "phone-leg self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
