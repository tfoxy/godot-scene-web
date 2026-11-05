#!/usr/bin/env bash
# lib/legs.sh's legs_free_port with no launches: every pick is below the kernel's ephemeral range
# and bindable on 127.0.0.1, and a port somebody is listening on is never picked.
#
#   bash test/self-test-free-port.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
HOLDER=""
trap '[ -z "$HOLDER" ] || kill "$HOLDER" 2>/dev/null || true; rm -rf "$TMP"' EXIT
export RS_QUIET_LOCK_DIR="$TMP/lock"
mkdir -p "$RS_QUIET_LOCK_DIR"

# picks <n>: n legs_free_port results, one per line, from legs.sh sourced as a runner would.
picks() {
	OUT="$TMP" SCRIPT_DIR="$SCRIPT_DIR" N="$1" bash -c '
		set -euo pipefail
		LEGS_LOG=self-test-free-port
		RECEIVER_DIR=/r
		source "$SCRIPT_DIR/lib/gamescope.sh"
		source "$SCRIPT_DIR/lib/legs.sh"
		for _ in $(seq "$N"); do legs_free_port; done
	'
}

fails=0
fail() {
	echo "FAIL: $*"
	fails=$((fails + 1))
}

low="$(awk '{print $1}' /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || echo 32768)"
mapfile -t ports < <(picks 50)
[ "${#ports[@]}" = 50 ] || fail "50 picks printed ${#ports[@]} lines"
for p in "${ports[@]}"; do
	if ! [[ "$p" =~ ^[0-9]+$ ]] || [ "$p" -lt 10000 ] || [ "$p" -ge "$low" ]; then
		fail "pick $p is not in [10000, $low)"
	elif ! python3 -c 'import socket, sys; socket.socket().bind(("127.0.0.1", int(sys.argv[1])))' "$p" 2>/dev/null; then
		fail "pick $p does not bind"
	fi
done

# A two-port window below a fake range (LEGS_PORT_RANGE_FILE): with both ports held the probe
# refuses each and the helper falls back to bind(0), never printing a held port.
echo "10002 10010" >"$TMP/range"
python3 -c '
import socket, time
held = []
for p in (10000, 10001):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.listen(); held.append(s)
    except OSError:
        pass  # somebody else holds it: still unpickable
print("ready", flush=True)
time.sleep(60)
' >"$TMP/holder.log" &
HOLDER=$!
for _ in $(seq 100); do grep -q ready "$TMP/holder.log" 2>/dev/null && break; sleep 0.05; done
grep -q ready "$TMP/holder.log" || fail "the holder never started"
mapfile -t held < <(LEGS_PORT_RANGE_FILE="$TMP/range" picks 20)
[ "${#held[@]}" = 20 ] || fail "20 held-window picks printed ${#held[@]} lines"
for p in "${held[@]}"; do
	case "$p" in 10000 | 10001) fail "picked held port $p" ;; esac
	[[ "$p" =~ ^[0-9]+$ ]] || fail "held-window pick $p is not a port"
done
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
HOLDER=""

# A range with no room below 10000 goes straight to bind(0).
echo "9000 9100" >"$TMP/range"
p="$(LEGS_PORT_RANGE_FILE="$TMP/range" picks 1)"
[[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt 0 ] || fail "no-room fallback printed '$p'"

[ "$fails" = 0 ] && echo "self-test-free-port: PASS" || {
	echo "self-test-free-port: FAIL ($fails)"
	exit 1
}
