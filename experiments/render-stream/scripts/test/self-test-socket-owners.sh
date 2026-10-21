#!/usr/bin/env bash
# GRT2b: lib/gamescope.sh's gs_socket_owners (one `find` over /proc/*/fd) must report exactly what
# the old per-fd readlink walk (gs_socket_owners_slow) does, in the same order, for a socket this
# test owns and the box's listening X11 sockets (4 sockets in all). Prints both timings. Read-only.
#
#   bash test/self-test-socket-owners.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/gamescope.sh
source "$SCRIPT_DIR/lib/gamescope.sh"

fail=0
cases=0
# A socket this test owns (a listening unix socket held by a python child), so at least one case
# exists even on a box with no X server.
tmp="$(mktemp -d)"
python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); print("up", flush=True); time.sleep(120)' \
	"$tmp/sock" >"$tmp/up" &
own_pid=$!
for _ in $(seq 50); do [ -s "$tmp/up" ] && break; sleep 0.1; done

paths=("$tmp/sock")
for x in /tmp/.X11-unix/X*; do
	[ -e "$x" ] && paths+=("$x")
done
for path in "${paths[@]}"; do
	while read -r inode _flags; do
		[ -n "$inode" ] || continue
		# the slow walk costs ~15 s per socket on a busy box: four cases are plenty
		[ "$cases" -lt 4 ] || continue
		cases=$((cases + 1))
		t0=$EPOCHREALTIME
		fast="$(gs_socket_owners "$inode" | tr '\n' ' ')"
		t1=$EPOCHREALTIME
		slow="$(gs_socket_owners_slow "$inode" | tr '\n' ' ')"
		t2=$EPOCHREALTIME
		# a process can exit between the two scans; retry once before calling it a mismatch
		if [ "$fast" != "$slow" ]; then
			fast="$(gs_socket_owners "$inode" | tr '\n' ' ')"
		fi
		if [ "$fast" = "$slow" ]; then
			status=ok
		else
			status=MISMATCH
			fail=1
		fi
		printf '%s %s inode %s owners [%s] fast %.3fs slow %.3fs\n' "$status" "$path" "$inode" "$fast" \
			"$(echo "$t1 - $t0" | bc)" "$(echo "$t2 - $t1" | bc)"
	done < <(gs_unix_listeners "$path")
done
kill "$own_pid" 2>/dev/null || true
wait "$own_pid" 2>/dev/null || true
rm -rf "$tmp"
if [ "$cases" = 0 ]; then
	echo "self-test-socket-owners: FAIL: no listening socket found (not even our own)"
	exit 1
fi
if [ "$fail" = 0 ]; then
	echo "self-test-socket-owners: PASS ($cases sockets)"
else
	echo "self-test-socket-owners: FAIL"
fi
exit "$fail"
