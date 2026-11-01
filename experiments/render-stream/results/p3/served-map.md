# SERVED-MAP: a binary key for the served set (2026-11-01)

The last HC4b leftover host-cost item (host-cost-design.md D1 "The diff, record planning, serving
and budget"; `results/p3/hc4b.md` "Notes for HC5": "`ServedResources::served_` is still a
`std::map<std::string, PayloadPtr>`, and a pin or retire copies a 64-character key"). No wire
change: every byte the capture writes is unchanged; only the host's private key representation
moves.

## The key

`ServedKey` (`capture/src/rs_resource_store.h`) is a 33-byte, trivially copyable key:

- **kind 0, a content hash**: 64 lowercase hex (the wire spelling) decoded to its 32 SHA-256 bytes.
- **kind 1, a keyed surface**: the literal `"hc3-key:<n>"` text (render-stream-11.md), at most 32
  bytes (`"hc3-key:"` plus a uint64's 20 digits is 28), NUL-padded.

`served_` and the G8kz coded-body cache `coded_` are both `std::map<ServedKey, …>` now. The choice
against `std::unordered_map` is ordering: the full walk's pin and retire events are emitted in
`std::string` key order (`retire()` retires "in key order as the full walk retires them"), and the
HC4b shadow oracle compares `served_`'s iteration order against a `std::set<std::string>`. The
encoding preserves that order exactly:

- a hash starts with `'0'`-`'f'`, an `hc3-key:` text with `'h'`, so every hash sorts before every
  text — which is also the kind byte's order (0 before 1);
- equal-length lowercase hex sorts as the bytes it spells, so decoding keeps digest order;
- NUL padding is below every printable byte, so a shorter text that is a prefix sorts first, as
  `std::string`'s prefix rule does.

`ServedKey::wire()` spells a key back (the 64 hex digits, or the text without its padding) for the
three places that need a string: a `ServeEvent` (a hook-log line), `retained_hashes()` and
`retained_payloads()`.

What the change removes from the hot paths:

- a 64-character `std::string` allocation and copy per pinned hash and per `coded_` entry (the
  served map's node no longer holds a string), and its free on retirement;
- `std::string(hash)` in `lookup()` — one heap allocation and 64-byte copy per HTTP GET, and two
  per coded lookup (`lookup_coded()` decoded under each lock scope before);
- one tree walk per pin: `served_.count()` + `operator[]` became one `emplace()`;
- the `ServeEvent`'s own hash copy on every pin and retirement when no hook log reads the events
  (`GRC_HOOK_LOG=off`): `entry.cpp` now passes a null event sink then, and `add_locked()` /
  `retire_one()` build an event only when one is taken. (With the log on the events are built and
  spelled exactly as before, so `resources.jsonl` is unchanged.)

Remaining `std::string` work, deliberately out of scope: the payload map's own keys (HC4b's
`SharedStrMap`, shared with every resource entry) and the raw `std::set<std::string>` of diffs and
extras that pin/retire walk (`extras_`, retirement candidates). Those are the map's representation,
not the served set's; changing them is a different increment.

## Byte identity

`cmp-rec.ts --tree` over two captures of everything the change can reach, base = main `6191bdd6`'s
capture library built before the edit (`artifacts/served-map/base-ext/`), after = this branch's.
Both sides ran this worktree's scripts, fixtures and receivers; only the capture library differs.
The capture-scale legs also `diff -r` their stores.

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 12 | identical |
| gate 2 (g2a, g2b, g2d) | 24 | identical |
| gate 2 + the live serving group (g2a, g2b, g2c, g2d) | 37 | 36 identical. `live-replay/recording.rs2` differs only in transaction `frame` fields (923/922 records): a live-paced file sink, the class `cmp-rec.ts` excludes for taps |
| gate 2 + g2c with its serving sabotages (`unpin`, `drop-resource`, `wrong-hash-live`) | 51 | 50 identical, the same `live-replay` file |
| gate 5 (g5c, g5e) | 11 | identical |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt) | 159 | 157 identical record-by-record. The 2 others are GSW browser receivers' `recording.rs2`, whose `GRSD` container `cmp-rec.ts` does not decode: both sides' files are the same size (8,401,147 and 10,380,263 bytes) and their 78 differing bytes are exactly the allowed ones — the session record's `session_id`/`stream.stream_id` (64 hex) and the end record's `encode_ns_total`/`snapshot_ns_total`/`diff_ns_total` |
| capture-scale /8, /9, /10, /11, /12, /13 (300 frames, sync workers, 64×48, redraws 170, Skip, hook log off) | 6 × 300 records | identical; stores `diff -r` equal |
| capture-scale /13 with `GRC_HC_SHADOW=1` | 300 records | identical; store equal |

The pin/retire events are the wire-adjacent output of the served set, and they are logged, so the
hook log (on in the gate runs) is a second comparison. `artifacts/served-map/serve-events-diff.py`
compares only the serving lines (op, hash, reason, payload bytes, sabotage flag; frame and clock
are pacing facts):

- gate 2 with g2c: 13 of 14 `resources.jsonl` equal;
- gate 2 with g2c and the serving sabotages: 17 of 19 equal, including the five events of
  `sabotage-drop-resource` (one `"sabotage":true` pin — the `dropped_key_` path) and the five of
  `sabotage-wrong-hash-live` (the `corrupt()` path). Every `live-*` leg's 13 events are equal.
- The 2 that differ are `live-animate` and `sabotage-unpin`, which `run-gate2.sh` itself declares
  timing legs ("The live-animate pins (live-animate, sabotage-unpin) are timing legs"): their
  fixture animates in real time, so the hashes and event order are a pacing fact. Control: the
  **same** base extension's own two runs of `live-animate` disagree at event 3 the same way
  (1838 vs 1833 events, `serve-events-timing-control.txt`).

## Shadow oracle

- The full tier (local and remote) runs every correctness run with `HC_SHADOW=1`
  (`GRC_HC_SHADOW=1`) and scans each run's hosts (`lib/hc-shadow-scan.py`): see "Checks and
  validation" for the host and snapshot counts; none mismatched.
- The capture-scale /13 leg above ran with the oracle on: 300 snapshots compared, 0 mismatches,
  and its bytes are identical.

## Host cost

`bench-live-scale.sh --receiver null --protocol 11 --perf` with `RS_BENCH_PERF_ARGS="-e
instructions -c 1000000"`, `GRC_HOOK_LOG=off`, inline 4096, churn (`RS_SCALE_REDRAWS=170`), 900
frames: two series of each leg, base = the same main `6191bdd6` extension. `perf-capture-split.py
--freq 1000 --fps 60` reports M instructions per main-thread frame (HC4b's convention).
`ls-p11-x11` is a /11 viewer on the /11 host — dynamic surfaces stay keyed, so the served keys are
`hc3-key:<n>` text; `ls-p11-x8` runs the host at /11 with a /8 viewer, so a below-/11 connection
makes the host read the surface hashes (`counters.json mesh_hashes.mirror_dynamic_surfaces`
68,137 over 900 frames) and the served keys are 64 hex.

| leg | | main | budget and serving | serve-event lines |
| --- | --- | ---: | ---: | ---: |
| /11 viewer, churn | base | 7.36 | 0.94 | 0.07 |
| | after | 7.10 | **0.73** | **0.00** |
| | base (2nd) | 7.35 | 0.92 | 0.10 |
| | after (2nd) | 7.30 | **0.73** | **0.00** |
| /8 viewer, churn | base | 8.69 | 1.52 | 0.08 |
| | after | 8.61 | **1.24** | **0.00** |
| | base (2nd) | 8.99 | 1.55 | 0.12 |
| | after (2nd) | 8.89 | **1.30** | **0.00** |

Serving's own share of a churn frame falls by 0.20-0.22 M instructions (21-23 %) with text keys and
0.25-0.28 M (17 %) with 64-hex keys; the serve-event call path disappears entirely with the hook
log off (0.07-0.12 M). Together that is 0.27-0.38 M instructions per frame (3-4 % of the frame) in
this fixture, on every frame a /11-scale session publishes new surface content. Each of the
68,800 pins (76 a frame) and 68,000 retirements loses its `std::string` node copy, and each HTTP
GET loses its 64-byte string allocation (this fixture issues no GETs for keyed surfaces, which is
why the serving bucket's delta is the tree and event work, not the GET path).

Wall clock is not resolvable at this size: frame-callback p50 1.216 → 1.216 ms (/11) and 1.792 →
1.728 ms (/8), mean 1.305 → 1.301 and 1.887 → 1.860.

## Checks and validation

- **Unit tests**: `build-capture.sh` (`ctest`) 46/46, including the new `test_served_key` — a hash
  round-trips, a mixed hash + `hc3-key:<n>` set orders exactly as `std::string` does, and a text key
  is pinned, looked up, listed by `retained_hashes()` and retired under its own spelling — and
  HC4b's incremental-vs-full-walk serving model, which replays 60 rounds of random maps and
  compares the pin and retire event sequences.
- **Local full tier, the runs `remote-validate.sh` refuses** (`validate-increment.sh --tier full
  --only lock-tests,g7live-gsw,g7live-web-rust`, `RS_VALIDATE_GROUPS=g7-1`): **3/3 pass** in 779 s.
  `g7live-gsw` and `g7live-web-rust` g7-1 each ran 16 hosts with the oracle on, 11,860 snapshots,
  0 mismatches; `lock-tests` passed.
- **Remote full tier** (`remote-validate.sh --tier full`, run
  [41320964270](https://github.com/tfoxy/godot-scene-web/actions/runs/41320964270), key
  `rv-20261101T152309Z-33bee03-6659`, snapshot `33bee03799` on `6191bdd6`): **21/22 runs pass**.
  - Passing: `pure`, `capture-build` (ctest), the four crates, `pnpm-test`, `bench-instr`
    (-0.89 % to +0.93 %), native gates -1, 0, 1, 2, 3, 4, 5, 5.5 and 8, `native-rust-hc1` (every
    sabotage), `g7-gsw`, `g7-web-rust`, `g7live-gsw`.
  - The one failure is `g7live-web-rust`'s single row `stale-coalesce@web` (g7-55): step 3's
    mismatching regions `IN,Marker,RM,TI` against the expected `IN,Marker,PH,RM,TI` — a browser
    shot-region check on a hosted runner. Every other check of that run passed, including
    `receiver-vs-reference@web`, `live-tap-equals-received@web` and the leg classes.
  - That group rerun locally at the full tier (`RS_VALIDATE_GROUPS=g7-55 validate-increment.sh
    --tier full --only g7live-web-rust`): **rc 0**, `stale-coalesce@web` PASS ("recovery seq 290
    at frame 492, stale_from 369; step 3's shot (frame 492) mismatches reference-live exactly in
    IN,Marker,PH,RM,TI"), 9 hosts with the oracle on, 3,674 snapshots, 0 mismatches. The remote
    row was a runner shot flake; the wire is identical (this doc's byte identity).
  - The oracle: **882 hosts, 837 with it on, 222,307 snapshots compared, 0 mismatched**. With the
    local `g7live` runs and the g7-55 rerun: 923 hosts, 878 with it on, **249,701 snapshots, 0
    mismatched**.
  - The snapshot predates one test-only reformat (two 64-character hex literals became a loop
    building the same strings); the tested code is identical.
- **Not run here**: the timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, g7x), which
  the milestone sweep owns, and the refused `g7live-*` g7-1 jobs are covered by the local runs
  above.

## Out of scope

- The receivers, the GDScript cores and the wire: unchanged by construction — this is a host-internal
  map representation, and every emitted hash spelling goes through `wire()`.
- `resources.jsonl` with the hook log on: the events are built exactly as before when the log keeps
  lines (the identity run compares the /11 and /13 recordings, and the gates that log compare their
  own evidence).
- Timing runs (native gate 6, the `g7live-*-timing` runs, g7x): the milestone sweep owns them.
