#!/usr/bin/env bash
# GRT4a: source-cache.sh's single flight, leases and keep-N/LRU pruning, on a PRIVATE cache
# (GSW_SOURCE_CACHE) with fake passing source runs -- no Godot. Checks:
#   - two makers missing the same key and gate at once make the source ONCE: the second waits on
#     the flight, then hits (item 3; run-gate7.sh's flight -> lookup -> make -> publish -> land);
#   - a flight whose owner died is taken over at once;
#   - every publish prunes to GSW_SOURCE_CACHE_KEEP keys, least recently used first (a lookup hit
#     refreshes a key), read-only entries included; 0 never prunes (item 5);
#   - a key leased by a live process (`lookup --lease PID`) survives pruning, and goes once the
#     process is gone; a key used within GSW_SOURCE_CACHE_MIN_AGE_S survives too;
#   - a read-only entry stays byte-for-byte unmodified through lookups, flights and leases.
#
#   bash test/self-test-source-cache.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SC="$SCRIPT_DIR/source-cache.sh"
TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
export GSW_SOURCE_CACHE="$TMP/cache"
export GSW_SOURCE_FLIGHT_POLL_S=0.1
export GSW_SOURCE_CACHE_MIN_AGE_S=0 # the recency guard has its own case below
mkdir -p "$GSW_SOURCE_CACHE"

fails=0
check() {
	if eval "$2"; then
		echo "ok   $1"
	else
		echo "FAIL $1 ($2)"
		fails=$((fails + 1))
	fi
}

key_of() { printf '%032x\n' "$1"; }
# fake_run <dir> <key>: a passing source run carrying <key>
fake_run() {
	mkdir -p "$1/leg/receiver/shots"
	printf '{"gate_passed": true, "checks": [{"id": "a", "passed": true}]}\n' >"$1/result.json"
	printf '{"source_key": "%s"}\n' "$2" >"$1/gate7-source.json"
	printf 'shot\n' >"$1/leg/receiver/shots/seq-1.png"
	printf 'path %s\n' "$1" >"$1/leg/receiver/env.txt"
}
tree_sum() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1); }

# --- single flight ---------------------------------------------------------------------------
# maker <name>: run-gate7.sh's sequence for one gate, in its own process (its own pid owns the
# flight); a miss "makes" the source (0.8 s) and counts it.
K1="$(key_of 1)"
maker() {
	bash -c '
		SC="$1" K="$2" T="$3" n="$4"
		bash "$SC" flight "$K" gate0 $$
		if hit="$(bash "$SC" lookup "$K" gate0 all --lease $$)"; then
			echo "$n hit $hit" >>"$T/makers.log"
		else
			echo "$n made" >>"$T/makers.log"
			run="$T/made-$n"
			mkdir -p "$run/leg/receiver/shots"
			printf "{\"gate_passed\": true, \"checks\": [{\"id\": \"a\", \"passed\": true}]}\n" >"$run/result.json"
			printf "{\"source_key\": \"%s\"}\n" "$K" >"$run/gate7-source.json"
			sleep 0.8
			bash "$SC" publish "$K" gate0 all "$run" >/dev/null
		fi
		bash "$SC" land "$K" gate0 $$
	' _ "$SC" "$K1" "$TMP" "$1"
}
maker a &
maker b &
maker c &
wait
check "three concurrent makers of one key/gate make the source once" "[ \$(grep -c ' made$' '$TMP/makers.log') = 1 ]"
check "the other two wait on the flight and hit" "[ \$(grep -c ' hit ' '$TMP/makers.log') = 2 ]"
check "the flight is landed (no flight dir left)" "[ -z \"\$(ls -A '$GSW_SOURCE_CACHE/.flight' 2>/dev/null)\" ]"

# a dead owner's flight is taken over at once
mkdir -p "$GSW_SOURCE_CACHE/.flight/$K1--gate1"
bash -c 'exit 0' &
dead=$!
wait "$dead"
echo "$dead-1" >"$GSW_SOURCE_CACHE/.flight/$K1--gate1/owner"
t0=$SECONDS
GSW_SOURCE_FLIGHT_MAX_S=5 bash "$SC" flight "$K1" gate1 $$
frc=$?
check "a dead owner's flight is taken over" "[ $frc = 0 ] && grep -q '^$$-' '$GSW_SOURCE_CACHE/.flight/$K1--gate1/owner' && [ \$((SECONDS - t0)) -lt 3 ]"
bash "$SC" land "$K1" gate1 $$
# a live owner's flight is waited on, and the wait is bounded
sleep 30 &
holder=$!
bash "$SC" flight "$K1" gate2 "$holder"
GSW_SOURCE_FLIGHT_MAX_S=1 bash "$SC" flight "$K1" gate2 $$ 2>/dev/null
check "a live owner's flight makes a second maker wait, bounded by GSW_SOURCE_FLIGHT_MAX_S" "[ $? = 1 ]"
kill "$holder" 2>/dev/null
wait "$holder" 2>/dev/null

# --- read-only entry unmodified ----------------------------------------------------------------
E1="$(bash "$SC" lookup "$K1" gate0 all)"
before="$(tree_sum "$E1")"
check "a published entry is read-only" "! touch '$E1/leg/receiver/x' 2>/dev/null && [ ! -w '$E1/leg/receiver' ]"

# --- keep-N / LRU ------------------------------------------------------------------------------
publish_key() { # <n>: publishes key n's gate0 source
	local k
	k="$(key_of "$1")"
	fake_run "$TMP/run-$1" "$k"
	bash "$SC" publish "$k" gate0 all "$TMP/run-$1" >/dev/null 2>>"$TMP/prune.log"
	touch -d "@$((1700000000 + $1 * 10))" "$GSW_SOURCE_CACHE/$k/.last-used"
}
keys() { (cd "$GSW_SOURCE_CACHE" && ls -d */ 2>/dev/null | tr -d / | sort | tr '\n' ' '); }
touch -d "@1700000005" "$GSW_SOURCE_CACHE/$K1/.last-used"
export GSW_SOURCE_CACHE_KEEP=3
publish_key 2
publish_key 3
check "under the cap nothing is pruned" "[ \"\$(keys)\" = '$(key_of 1) $(key_of 2) $(key_of 3) ' ]"
# a lookup hit refreshes key 1, so key 2 is now the least recently used
bash "$SC" lookup "$K1" gate0 all >/dev/null
touch -d "@1700000100" "$GSW_SOURCE_CACHE/$K1/.last-used"
publish_key 4
touch -d "@1700000200" "$GSW_SOURCE_CACHE/$(key_of 4)/.last-used"
check "the 4th key prunes the least recently used one (key 2), not the oldest published (key 1)" \
	"[ \"\$(keys)\" = '$(key_of 1) $(key_of 3) $(key_of 4) ' ]"
check "pruning removed a read-only entry (chmod -R u+w first)" "[ ! -e '$GSW_SOURCE_CACHE/$(key_of 2)' ] && grep -q 'pruned' '$TMP/prune.log'"
check "the kept read-only entry is byte-for-byte unmodified" "[ \"\$(tree_sum '$E1')\" = '$before' ]"

# a live lease keeps a key past the cap; a dead lease does not
sleep 30 &
lessee=$!
bash "$SC" lookup "$(key_of 3)" gate0 all --lease "$lessee" >/dev/null
touch -d "@1700000001" "$GSW_SOURCE_CACHE/$(key_of 3)/.last-used"
publish_key 5
touch -d "@1700000300" "$GSW_SOURCE_CACHE/$(key_of 5)/.last-used"
check "a key leased by a live run survives pruning, beside the newest N (the cache may exceed N)" \
	"[ \"\$(keys)\" = '$(key_of 1) $(key_of 3) $(key_of 4) $(key_of 5) ' ]"
kill "$lessee" 2>/dev/null
wait "$lessee" 2>/dev/null
bash "$SC" prune >/dev/null 2>>"$TMP/prune.log"
check "once its run is gone the lease no longer protects it" "[ \"\$(keys)\" = '$(key_of 1) $(key_of 4) $(key_of 5) ' ]"
GSW_SOURCE_CACHE_KEEP=0 publish_key 6
GSW_SOURCE_CACHE_KEEP=0 publish_key 7
check "GSW_SOURCE_CACHE_KEEP=0 never prunes" "[ \$(keys | wc -w) = 5 ]"
touch -d "@1700000900" "$GSW_SOURCE_CACHE/$(key_of 7)/.last-used"
bash "$SC" prune --keep 1 >/dev/null 2>>"$TMP/prune.log"
check "prune --keep N keeps exactly the newest N" "[ \"\$(keys)\" = '$(key_of 7) ' ]"
publish_key 8
touch "$GSW_SOURCE_CACHE/$(key_of 8)/.last-used"
GSW_SOURCE_CACHE_MIN_AGE_S=3600 bash "$SC" prune --keep 0 >/dev/null 2>&1 # 0 = never: a no-op
touch "$GSW_SOURCE_CACHE/$(key_of 7)/.last-used" # two keys used just now, cap 1
GSW_SOURCE_CACHE_MIN_AGE_S=3600 bash "$SC" prune --keep 1 2>>"$TMP/prune.log" >/dev/null
check "keys used within GSW_SOURCE_CACHE_MIN_AGE_S survive past the cap (old-code runs take no lease)" \
	"[ \"\$(keys)\" = '$(key_of 7) $(key_of 8) ' ]"
touch -d "@1700000999" "$GSW_SOURCE_CACHE/$(key_of 7)/.last-used"
bash "$SC" prune --keep 1 >/dev/null 2>>"$TMP/prune.log"
check "once one is older (and the guard is off), the cap applies" "[ \"\$(keys)\" = '$(key_of 8) ' ]"
check "list shows entries only (no .flight/.leases)" "[ \"\$(bash '$SC' list | wc -l)\" = 1 ]"

echo "self-test-source-cache: $([ "$fails" = 0 ] && echo "all pass" || echo "$fails FAIL")"
[ "$fails" = 0 ]
