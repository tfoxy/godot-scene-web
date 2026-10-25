# P3-SP: shared publication for several viewers (2026-10-25)

**The live host's cost per extra viewer fell to about two fifths, and in STS2 combat the seat now
holds 37–53 fps with one to four GSW viewers, where it ran at 22–35.** P3-LV measured the host
paying per viewer: a copy of every published snapshot, a diff, an encode and every inline record,
once per connection, plus a carried-hash set per connection that grew for the whole session. This
increment shares that work between connections and makes the remaining per-viewer state compact.
It changes no wire byte: a connection gets exactly the bytes it would get alone.

| | before (`main`) | after |
| - | - | - |
| fixture, 4 caught-up viewers (null receivers): host fps / frame callback | 40.1 fps / 23.4 ms | 59.4 fps / 11.3 ms |
| fixture, frame callback added per extra viewer (null receivers) | 4.4 ms | 1.7 ms |
| STS2 combat, 1 GSW viewer: host fps, viewer applies/s | 34.5, 32.1 | 52.7, 49.6 |
| STS2 combat, 4 GSW viewers: host fps, applies/s per viewer | 21.8, 19.1–19.3 | 37.1, 33.6–33.8 |
| host memory per carried hash | ~150 B per viewer | ~40 B for all viewers |
| fixture host RSS, 10 min of every-frame traffic to one viewer | +101 MB | +2 MB |
| receivers: inline payloads kept by rs-core's validator | every one, for the session | the last one |

The session-length bound the brief asked for is only partly possible without a wire change.
render-stream/2's resource rules make "carried" exact and lifelong on both ends: a hash may be
sent inline at most once per stream (`resource-duplicate`, G6s measured what pruning it breaks),
and every inline-sized hash must have arrived inline before a transaction names it
(`resource-missing`), so a host that forgets a hash can neither re-send it nor skip it. This
increment makes the host's set compact and shared (one entry of about 40 bytes per hash for every
viewer, not ~150 bytes per viewer), takes the host's other session-length stores off, stops the
receivers' validator from keeping every inline payload, and designs the `/11` rule that bounds the
carried sets themselves ([render-stream-2.md](../../protocol/render-stream-2.md), "Design, not
built"). A default bound on GSW's payload store was measured and dropped: on the fixture it turned
into a re-fetch storm.

## Method

- **Bench.** `scripts/bench-live-scale.sh` (P3-LV) gained `--viewers N` (1–4; receivers in
  `rx1/`..`rxN/`, one page port each, judged on the slowest) and `--perf` (`perf record -g -F 499
  -p <host pid>` for the whole leg, reports in `host/perf-report*.txt`). Its summary now carries the
  host's frame rate, frame callback, CPU cores and RSS for every N. A new receiver kind, `null`
  (`scripts/lib/null-receiver.ts`), decodes nothing and acks every transaction at every stage on
  arrival: every viewer stays caught up and in lockstep, so a null leg measures the host's own cost
  per viewer with no browser competing for the machine. That is the cleanest host figure, and the
  worst case for the host (it sends every frame to every viewer).
- **Fixture.** P3-CAP's `fixtures/capture-scale` (STS2's combat shape), the hand-off environment,
  `GRC_RESOURCE_INLINE_MAX_BYTES=4096`, credit window 2, real time, `--max-fps 60`, under the
  exclusive quiet lock. "Before" is `main`'s capture library (`26fbd9df`), built in this worktree
  before any change; "after" is this branch. Null legs alternate before and after.
- **STS2.** C3's harness in P3-LV's form (a private copy, own farm, `live8`, route menu, map,
  combat, `LEG_DISARM_FRAMES=8000`), one GSW viewer (window 2) from the menu, then a second right
  after the combat shots and two more 33 s later. Windows: combat with 1 viewer, with 2 (from the
  second's first apply + 2 s to the third's open), with 4 (from the fourth's first apply + 2 s to
  the disarm). Host fps from connection 1's live tap, CPU and RSS from the harness's 1 Hz sampler.
  Each leg ran under `live-qa-lock.mjs with --resource exclusive:game:p3-sts2` (plus
  `shared:install`, port 13767 and its own live and page ports), then the quiet lock, exclusive.
  Every leg ended `survivors: none` with all five hash sets unchanged.
- **Load.** Other agents' unlocked work kept the 1-minute load at 3–10. Every real-time leg waited
  for a load under 4 to start (the STS2 legs at 1.8–3.9, most fixture legs at 2.4–4.0); some
  rose during the leg. Browser-receiver legs are the most sensitive (four Chromiums plus the host).

## Where a viewer's cost went

`perf record` of the host, fixture, four GSW viewers (`base-x4` against this branch before the
transport change, `after2-x4`), shares of all host samples:

| under `Hub::send_transaction` | before | after |
| ----------------------------- | -----: | ----: |
| whole | 44.6 % | 24.7 % |
| `Snapshot` copy (per connection) | 9.2 % | — |
| `deliver` (tap copy and flush, enqueue) | 8.1 % | 7.9 % |
| `make_patch` | 6.5 % | 5.2 % |
| `encode_transaction` | 4.9 % | 4.9 % |
| freeing the previous base, string-set inserts | ~6 % | — |
| `encode_resource` | 1.3 % | 1.1 % |

The 3-viewer profile P3-LV took pointed the same way. Per connection and per frame, `main`:

1. copied the published `Snapshot` (`Snapshot cur = snapshot.state`) to stamp its seq, and kept
   the copy as its base, freeing the previous one;
2. copied the snapshot's payload map into `base_payloads` (a `std::map<std::string, ...>`);
3. diffed and encoded its transaction, even when another connection had just formed the same one;
4. encoded every inline record again, and probed and inserted every hash in its own
   `std::set<std::string>`;
5. made the served set build a `std::set` of every base's hashes, one copy per connection;
6. wrote one wake byte to the I/O thread per message (about 70 a frame per viewer), and flushed
   the live tap per message.

With lockstep viewers (the null legs), the after-profile's `send_transaction` is 22 % of host
samples with one viewer and 27 % with four: what a viewer still costs is its own copy of each
message into the WebSocket queue (`send_binary`, 5.6 %) and the live tap's copy (6.6 %, evidence
only; the product does not set `GRC_LIVE_TAP_DIR`).

## Fixes

All in the live hub, the served set, the transport and the receivers' stores; no wire change.

1. **Shared publication** (`rs_live.h/.cpp`, `entry.cpp`, `rs2_diff.h/.cpp`).
   - The published snapshot goes to the hub as a `shared_ptr<const Captured>`
     (`Hub::on_frame_shared`), moved in when there is no file sink and copied once when the
     publisher keeps its own. Every connection's base, in-flight window entry and stale-coalesce
     target holds that one object; nothing is copied per connection.
   - `make_full`/`make_patch` take the transaction's version, seq, frame and base seq as a `TxMeta`
     instead of reading them from a stamped copy of the snapshot (the old signatures wrap the new).
   - Within one frame callback, a connection sending the same transaction as another (the same
     base snapshot, or none for a full one, the same target and version) re-stamps that
     encode's leading meta fields (`seq`, `frame`, `encoding`, `base_seq`) and fixes the two
     length words. The re-stamp first checks that the source starts with exactly the prefix its own
     fields imply, and forms and encodes the transaction itself otherwise, so its bytes are never
     wrong. `shared_sends` in the perf timeline counts the re-stamped sends per connection.
   - Each inline record is encoded once per hash per callback, and each target's payload refs and
     carried-index ids are looked up once per callback.
   - A closed connection releases its snapshots at once.
2. **One carried index for every viewer** (`rs_carried.h`). Every connection's carried hashes live
   in one host-wide table: a hash's first 128 bits (any string that is not 64 hex digits goes to an
   exact side map) and a bit per connection slot, about 40 bytes a hash with its index and vector
   slack, for all viewers, against about 150 per viewer. The set is exactly the old one (never
   pruned, G6s): a closed connection's slot is retired and its bits are cleared before the slot is
   reused, and the table empties when no connection holds a slot, so the memory comes back when the
   viewers leave.
3. **Served set** (`rs_resource_store.cpp`). `retire()` looks hashes up in the bases' maps in
   place instead of building a set of every base's hashes, and the bases are listed once each
   (`base_payloads()` de-duplicates lockstep connections' shared snapshot). `seen_`, a set of every
   hash ever pinned, is only kept for the drop-resource sabotage: it grew by one string per payload
   ever published, for the session, with or without viewers.
4. **Transport** (`rs_ws.cpp`). The I/O thread is woken once per drain rather than once per
   message (an atomic flag: drain, then clear, then rebuild the poll set under the lock). The live
   tap and log flush once per frame callback (1 MiB tap buffer) instead of per message and line,
   and a connection's `sent_at` entry goes once every stage has answered (it grew by one map node
   per transaction).
5. **Receivers.**
   - rs-core's validator kept every inline payload of the stream (`inline_payloads`) besides the
     caller's own store. Every caller (GSW, `rs-core-capi` for the native receiver and the web
     export, the CLIs) takes a payload right after `accept`, so it now keeps only the last one,
     in a reused buffer.
   - GSW's `PayloadStore` stays as `main` has it: unbounded without
     `RS_RECEIVER_MEMORY_BUDGET_BYTES`. A default bound was built and measured, and dropped (see
     "GSW's payload store: a default bound, tried and dropped").
   - `RsResourceCache` (native receiver, web export) keeps a running byte total, and its LRU is the
     touch dictionary's own insertion order (a touch erases and re-inserts), so a budgeted add is
     O(1) amortised instead of a sum and a sort of every entry.

## Results: fixture

Null viewers (every viewer caught up, lockstep), 1,500 host frames, before and after interleaved:

| viewers | capture | runs | host fps | frame callback ms | host CPU cores | transactions sent (all viewers) | re-stamped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | main | 2 | 59.9 / 59.5 | 9.05 / 10.7 | 0.723 / 0.768 | 1454 / 1497 | 0 / 0 |
| 1 | P3-SP | 2 | 59.9 / 59.8 | 6.51 / 8.6 | 0.52 / 0.661 | 1450 / 1445 | 0 / 0 |
| 2 | main | 2 | 59.6 / 59.0 | 12.24 / 13.91 | 0.944 / 1.046 | 2894 / 2972 | 0 / 0 |
| 2 | P3-SP | 2 | 59.2 / 59.8 | 8.18 / 7.98 | 0.625 / 0.623 | 2985 / 2899 | 1491 / 1448 |
| 4 | main | 2 | 40.1 / 41.4 | 23.39 / 22.58 | 1.035 / 1.135 | 5950 / 5979 | 0 / 0 |
| 4 | P3-SP | 2 | 59.4 / 57.4 | 11.34 / 13.85 | 0.867 / 0.977 | 5872 / 5941 | 4404 / 4451 |

- Two runs each, separated by " / ". Every null viewer took every frame (1,450–1,500 transactions
  each in 1,500 host frames), so the work is the same before and after; with four viewers the
  re-stamped share is three quarters (every viewer after the first).
- The frame callback added per extra viewer (1 to 4 viewers, means of the two runs) fell from
  4.4 ms to 1.7 ms. With one viewer it fell from 9.9 to 7.6 ms (no snapshot copy, no per-message
  flush, no base-hash set).
- Host samples (`perf`, four viewers, run 1): 20,309 before and 11,429 after for the same 1,500
  frames; `Hub::on_frame` was 52 % of them and is 34 %.

GSW viewers in Chromium (window 2), 1,200–1,500 host frames. The receivers, not the host, bound
these: GSW's fixture apply is 9–11 ms a transaction (P3-LV: the fixture's 560 materials), and
four Chromiums on the same machine starve one another:

| leg | capture | load at start | viewers | host fps | frame callback ms | host cores | applies/s per viewer | latency p50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `base-x1` | main | 2.6 | 1 | 59.8 | 9.19 | 0.78 | 44.8 | 23.1 |
| `after3-x1` | P3-SP | 2.9 | 1 | 59.9 | 7.12 | 0.60 | 20.0 | 29.4 |
| `base-x2` | main | 2.7 | 2 | 55.6 | 13.48 | 1.04 | 35.1, 34.0 | 23.4, 30.5 |
| `after3-x2` | P3-SP | 3.3 | 2 | 58.7 | 11.16 | 0.89 | 25.2, 23.9 | 32.1, 35.0 |
| `base-x4` | main | 3.0 | 4 | 36.7 | 22.98 | 1.08 | 25.0–25.1 | 25.0–41.2 |
| `gsw-base-x4-r2` | main | 3.8 | 4 | 30.8 | 28.52 | 0.95 | 20.7–20.8 | 28.0–46.8 |
| `after2-x4` (before the transport change) | P3-SP | 3.1 | 4 | 52.8 | 14.70 | 0.99 | 24.3–25.3 | 31.6–38.3 |
| `after3-x4` | P3-SP | 4.0 | 4 | 31.3 | 25.41 | 0.43 | 7.4–7.5 | 39.9–46.5 |
| `gsw-new-x4-r2` | P3-SP | 18.0 | 4 | 38.8 | 21.33 | 0.62 | 13.2–14.4 | 60.8–70.3 |

- These legs are 20–25 s, of which the first 4 s are the viewer's first apply; the receivers'
  rates move with the machine's load and each other far more than with the host. `after3-x4`
  ran at a load of 4 rising to about 8 with four Chromiums starved (each viewer's GSW frame took
  35 ms against 12 ms alone, host cores 0.43); `gsw-new-x4-r2` started at 18. The host-side
  figures that do not depend on the receivers are the null legs above.
- What the GSW rows do show: the host's frame callback with one to two GSW viewers fell by 2.1–2.3
  ms, and with four the shared share is 40–75 % per viewer (viewers' bases diverge as they fold
  differently), against 100 % for lockstep null viewers.
- Over five minutes (`long-rx-before`, below) this branch's capture fed one GSW viewer 57
  transactions a second, so the host is not what limits a fixture viewer.

## Results: STS2 combat

| leg (capture) | viewers | window (s into combat) | host fps | host CPU cores | host RSS max MB | applies/s per viewer | latency p50 ms per viewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `p3sp-base-1` (main) | 1 | 0.0–32.2 | 34.5 | 1.09 | 3079 | 32.1 | 15.0 |
| `p3sp-base-1` (main) | 2 | 37.9–64.9 | 32.0 | 1.12 | 3169 | 28.2, 28.2 | 13.0, 24.8 |
| `p3sp-base-1` (main) | 4 | 79.1–163.3 | 21.8 | 1.14 | 3376 | 19.3, 19.1, 19.1, 19.1 | 17.2, 21.5, 31.5, 35.2 |
| `p3sp-new-3` (P3-SP) | 1 | 0.0–22.0 | 52.7 | 1.08 | 3096 | 49.6 | 16.5 |
| `p3sp-new-3` (P3-SP) | 2 | 28.0–55.1 | 49.1 | 1.08 | 3153 | 43.3, 43.2 | 16.2, 18.7 |
| `p3sp-new-3` (P3-SP) | 4 | 69.7–88.2 | 37.1 | 1.08 | 3208 | 33.7, 33.6, 33.8, 33.8 | 17.8, 21.0, 23.1, 24.7 |
| `p3sp-new-2` (P3-SP, GSW bound) | 1 | 0.0–21.1 | 54.1 | 1.05 | 3349 | 45.7 | 16.2 |
| `p3sp-new-2` (P3-SP, GSW bound) | 2 | 26.5–57.0 | 52.4 | 1.05 | 3415 | 35.8, 37.6 | 16.3, 17.9 |
| `p3sp-new-2` (P3-SP, GSW bound) | 4 | 69.2–81.4 | 40.1 | 1.06 | 3473 | 31.8, 31.6, 32.9, 33.1 | 16.8, 20.1, 21.7, 22.3 |

- `p3sp-base-1` and `p3sp-new-3` are the comparison: `main`'s capture and GSW bundle against this
  branch's. `p3sp-new-2` ran this branch's capture with the GSW payload-store bound that was
  dropped (below); its host figures agree with `p3sp-new-3`'s.
- The legs started at a 1-minute load of 3.8 (base) and about 2–3 (`p3sp-new-3`, which waited
  seven minutes for the quiet lock after a load of 1.8 at its lease). The host's main thread is
  saturated in both (about one core); what changes is how much of each frame the capture takes.
- With one viewer the seat ran at 52.7 fps against 34.5, and the viewer applied 49.6 updates a
  second against 32.1, 16.5 ms behind. P3-LV's single-viewer leg L5 had 38.8 fps and 34.8.
- With two: 49.1 fps against 32.0, 43 updates a second each against 28. With four: 37.1 fps against
  21.8, and each viewer applied 33.6–33.8 updates a second against 19. The new legs' 4-viewer
  windows are short (12–19 s): at the higher frame rate a session reaches its disarm frame sooner.
- Memory in the receivers: `p3sp-new-3`'s first viewer held 406,277 payloads and a 1,223 MB wasm
  heap at the disarm (165 s), growing about 6.7 MB a second in combat; `p3sp-base-1`'s grew about
  5.2 MB a second (it applied, and was sent, fewer transactions) and reached 1,484 MB by 210 s.
  Either reaches wasm32's 4 GB after about ten minutes of combat: the receiver ceiling the `/11`
  changes have to lift.

- The new-capture legs ran with this branch's GSW bundle, the base leg with `main`'s.
- `p3sp-new-1` (not in the table) ran an earlier version of the wake coalescing, which cleared the
  flag before draining the pipe: a wake that landed between the two was swallowed, and the next
  message waited for the I/O thread's 50 ms poll timeout. Its viewers' credit round trip was 46 ms
  against 15 ms. The fixed order is what `p3sp-new-2` and every fixture "after" row ran.

## Memory over a long run

Real time, fixture, one viewer, `GRC_RESOURCE_INLINE_MAX_BYTES=4096`, no live tap and no hook log
(`GRC_LIVE_TAP_DIR=`, `GRC_HOOK_LOG=off`, as a product runs), host RSS from the 0.5 s sampler:

| leg | capture | viewer | length | transactions sent | host RSS, first minute → end | growth |
| --- | ------- | ------ | ------ | ----------------- | ---------------------------- | ------ |
| `long-null-before` | main | null | 10 min | 35,998 | 1,928 → 2,030 MB | +11 MB a minute |
| `long-null-after` | P3-SP | null | 10 min | 35,998 | 1,902 → 1,904 MB | +0.2 MB a minute |
| `long-host-before` | main | GSW | 20 min | 4,548 | 2,197 → 2,308 MB | +6 MB a minute |
| `long-host-after` | P3-SP | GSW | 20 min | 4,284 | 2,149 → 2,156 MB | +0.4 MB a minute |

- The null legs are the accelerated churn: every frame goes out, 479,034 inline records in ten
  minutes. Both sent exactly the same 35,998 transactions, 479,034 records and 4,961,803,893
  bytes. `main`'s host grew by about 0.7 GB an hour for one viewer (its carried set, `seen_` and
  `sent_at`); this branch's stays flat (the carried index for 479,034 hashes is about 19 MB, inside
  what the process had already reserved).
- The GSW legs ran the payload-store bound described below, which held the viewer to about 3.6
  applies a second; the hosts are still comparable (the same viewer behaviour, 4,284 and 4,548
  transactions).
- The frame callback over the ten-minute null legs: 7.47 ms before, 5.15 ms after.

**The receivers.** `long-rx-before` ran this branch's capture with `main`'s GSW bundle for five
minutes: 57 applies a second, 386,863 payloads in the store (every fixture pose is new: its mesh
heights carry `frame * 0.001`), and a wasm heap that grew from 936 MB to 2,051 MB in four minutes,
about 4.6 MB a second. That viewer would have reached wasm32's 4 GB in about twelve minutes. The
validator's copy of every inline payload is gone from this branch's bundle; the store itself, and
the validator's carried map, still grow.

### GSW's payload store: a default bound, tried and dropped

The brief asked for GSW's `PayloadStore` to drop payloads no live item or resource references.
That was built (live mode with HTTP fetch only, past 65,536 entries or 256 MiB beyond the
referenced set, oldest-touched first) and measured:

- **STS2** (`p3sp-new-2`): the first viewer evicted 312,227 entries, re-fetched 185 payloads
  over HTTP (262 GETs against 77) in 140 s, and held its wasm heap at 734–792 MB.
- **Fixture, 20 min** (`long-host-after`): 402,279 evictions and 63,409 GETs; the viewer applied
  3.6 transactions a second. With the floor widened to every hash the resolved state names
  (textures, variants, mesh surfaces, shaders) as well as the applier's resident ones
  (`long6-rx-after2`, 6 min): 237,572 evictions, 16,553 GETs, 9.5 applies a second.

GSW fetches one payload per animation frame, so re-fetches at that rate stall it. Every fixture
pose is new, so the evicted payloads that came back were not poses returning; this increment did
not isolate which ones they were. The same eviction runs under an explicit
`RS_RECEIVER_MEMORY_BUDGET_BYTES` (G7k), which no leg drives at game churn. The bound is not in
this commit; GSW's store is `main`'s. A fix needs either that cause found, or the `/11` rules
below, under which a payload the state no longer names can simply be dropped and re-sent.

## Byte identity and multi-viewer correctness

- **Unit tests** (`capture/test/rs_live_test.cpp`):
  - `test_shared_publication_bytes`: five connections opened at different frames, with different
    ack periods and two resyncs, over 40 changing states with recurring hex-hashed textures.
    Every connection's messages are byte-identical to a hub serving that connection alone, and the
    connections share 40+ transactions. Re-stamping with the source's own meta (a sabotage run by
    hand) fails it on two connections.
  - `test_carried_index`: exact per-slot marks, stable ids through growth, a reused slot starts
    empty, the table stays while a slot is held.
  - Every existing live test passes unchanged, including `rs_live_window_test`'s window-1
    transcripts, which pin the exact bytes of scripted single-connection streams recorded before
    G7q.
- **Gate legs, `main`'s library against this branch's** (`cmp-rec.ts`, as P3-CAP): gate 1 (g1a,
  g1b) 43 files and gate 5 (g5c, g5e) 26 files equal apart from ids and timings. Gate 2 (g2a, g2b,
  g2c, g2d): every file recording, payload store and non-live hook log is equal; the live taps and
  received streams differ in record count, as live streams do run to run with credit timing
  (P3-CAP saw the same). Both runs pass all their checks.
- **Ten minutes of lockstep traffic**: the two null legs (`long-null-before`/`-after`, one viewer
  acking every frame) sent the same 35,998 transactions, 479,034 inline records and
  4,961,803,893 bytes.
- **Multi-viewer legs** ran correct to their end records: every fixture and STS2 viewer exited 0
  with its end record (bar the 20-minute GSW legs, whose bundle predated P3-HX's streamed evidence
  upload: Playwright failed on the 587 MB `applied.json` after the run, `ERR_STRING_TOO_LONG`, as
  P3-HX found; the viewer itself reached its end record).
- **Receiver self-test**: `receiver_selftest.gd` gained the cache budget's running total and LRU
  order (insertion-order eviction skipping a needed hash, a re-add counted once, `clear_memory`).

## Design: carried sets bounded by the resolved state (`/11`)

The wire change that bounds what this increment could only compact is written up as a
version-gated note in [render-stream-2.md](../../protocol/render-stream-2.md) ("Design, not built: a
carried set bounded by the resolved state"). In short: after each transaction both ends prune the
carried set to the hashes the resolved state names; `resource-duplicate` narrows to hashes still
carried; `resource-missing` is unchanged. The sets stay equal on both ends (they process the same
records in the same order), and are bounded by one state's size. Together with P3-LV's dynamic mesh
surfaces (poses by id, inline, not hashes), it removes the last session-length growth on the host
and in the receivers' validators. Until then, the receivers' validator `carried` maps grow by about
80 bytes per inline hash, and GSW's payload store by every pose it is sent: GSW's wasm heap grew
5–7 MB a second in STS2 combat, about ten minutes to wasm32's 4 GB.

## Validation

- **Remote full tier** ([run 40218819290](https://github.com/tfoxy/godot-scene-web/actions/runs/40218819290))
  on this branch rebased onto P3-VX (`f843a22d`): 21 of 21 runs pass, sabotage legs included
  (pure in 6 shards with the extended `self-test-bench-live-scale`, the cargo crates, `bench-instr`
  within ±0.7 % of its baseline, native rust gates −1 to 5.5 and 8, every g7 file group and the
  g7-2/5/55/8 live groups on GSW and web-rust). That snapshot still carried the GSW payload-store
  bound; after it was dropped, `cargo-rs-core`, `cargo-gsw-rs`, `g7-gsw` and `g7live-gsw` ran again
  remotely and pass ([run 40229836046](https://github.com/tfoxy/godot-scene-web/actions/runs/40229836046)).
  An earlier full run on the pre-P3-VX base (40211299978) failed only `g7live-web-rust@g7-55`'s
  `live-shader-stall` with "no shot for step 5", a hosted-runner shot-window miss; it passed on
  the next run.
- **Locally, the runs the remote refuses**: `g7live-gsw` and `g7live-web-rust` group g7-1 at the
  full tier pass (`RS_VALIDATE_GROUPS=g7-1`); `g7live-gsw` again after the GSW change (1,183 s).
- **Local smoke tier** (before the transport change and the rebases): 21 of 23 runs pass. The two
  that did not are `bench-instr` (no valgrind on this machine; the remote produces it) and native
  gate 6, a timing run, with `motion-monotonic` and `separation-gpu-heavy` failing at a load of
  8–18. `motion-monotonic` failed once more at a load of 3.8 beside other exclusive legs, then
  passed on this branch's final library on a quiet machine (load 2.5, `--legs g6a,g6l`), as it did
  on `main`'s library just before (G7uf: on a quiet machine `main` passed 5 of 9; the check is
  load-gated since G7mm).
- **Unit and self-tests**: the capture's 30 ctest suites (with the two new live tests), rs-core's
  cargo tests, `receiver_selftest.gd` (63 checks), `bench-live-scale.py self-test`.
- **Timing groups are deferred to the milestone sweep** as usual (native gate 6, the
  `g7live-*-timing` runs and g7x; the remote skips g1c-rate, g1d, g2c-pins, g5f, g55f and
  decode-cost). The benches here are timing measurements too, not tier targets.

## Deviations

- **Bound without a wire change: partly.** The brief's "LRU-bounded set with a correct re-send on
  miss" is not possible under `/2`'s rules: a re-send is `resource-duplicate`, and a GET instead of
  an inline record is `resource-missing` (rs-core `validate.rs`). The host's set is compact and
  shared instead, and the bound is designed for `/11`.
- **`rs-core-capi`'s own maps** (P3-HX's area) are untouched; the validator change reaches them
  only by keeping one inline payload instead of all.
- **Four STS2 launches** instead of one confirmation leg: `main`'s library (`p3sp-base-1`), this
  branch's (`p3sp-new-3`), one with the wake bug (`p3sp-new-1`) and one with the dropped GSW bound
  (`p3sp-new-2`). The new legs' 4-viewer windows are 12–19 s (the session reached its disarm frame
  sooner at the higher frame rate); the base leg's is 84 s.
- **GSW's payload store is not bounded** (built, measured, dropped; see "Memory over a long run").
  The receiver-side session-length growth is the next ceiling.
- **The 20-minute legs ran one viewer**, not 1, 2 and 4: the per-viewer host memory is the carried
  set, and the null legs measure its growth directly.
- **The host's per-frame served-set walk** (`ServedResources::retire`, 4–7 % of host samples)
  and the snapshot itself (`mirror_snapshot`) are per frame, not per viewer, and stay as they were.
- **Not shared yet:** each connection's copy of a message into its WebSocket queue (one framed
  vector per connection); sharing it needs the transport's queue to hold shared buffers.

## Evidence

In the main checkout's ignored `artifacts/render-stream/p3/p3-sp/`:

- `fixture/<leg>/`: every bench leg's `bench-live-scale.json` and `result.json`, the host's
  `perf.json`, `live-summary.json`, perf timeline and RSS/CPU samples, the `perf report` text
  (self and children) and each receiver's `perf.json`. Legs: `base-x*`, `after{1,2,3}-x*` and
  `gsw-*-x4-r2` (GSW viewers), `null-{base,new}-x{1,2,4}-r{1,2}` (null viewers),
  `long-*` (the long runs) and `long6-rx-after2` (the dropped GSW bound).
- `game/<leg>/`: the STS2 legs' `notes.txt` (`survivors: none`), steps, 1 Hz samples, receiver hook
  log, host `perf.json`/`live-summary.json`/perf timeline, every viewer's `perf.json`, the
  viewer-count windows (`windows.json`) and the hash comparison (all five sets unchanged). Frames
  stay in couch-coop's ignored research folder (`legs/p3sp-*`).
- `ident/`: `cmp-rec.ts` output for gates 1, 2 and 5 (`main`'s library against this branch's).
- `g6l/`: gate 6 `--legs g6a,g6l` results: `main`'s and this branch's library on a quiet machine
  (`base-`, `new-result.json`, both pass) and the loaded rerun (`rerun-result.json`).
- `remote/`: the two remote runs' `validate-summary.json`.
- `tools/`: the scratch scripts (bench matrices, long runs, the profile fold, the STS2 window
  analysis, the gate identity runner) and `sts2/` (the harness hooks: stage, leg, viewer steps).
