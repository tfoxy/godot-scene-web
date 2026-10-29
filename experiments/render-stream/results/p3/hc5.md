# HC5: the formation thread (2026-10-29)

HC5 of `protocol/host-cost-design.md` (D4 "Moving work off the main thread"). No wire change. As
built is recorded in the design doc under D4, "As built (HC5)".

1. **The hub decides on the main thread; one job per sending connection forms.** In
   `on_frame_shared` the frame callback still decides everything that is frame-paired:
   - which connection sends, its target, base, seq, frame and encoding;
   - credit, the window and rate ticks;
   - the drop-message, stale-coalesce, ignore-credit and window-overrun sabotages;
   - the below-/11 CarriedIndex marks.

   The connection's state advances at once. `send_transaction` now only fills that connection's
   `Hub::Job`. The job does the rest:
   - the /11 record plan (`plan_v11_records`);
   - the resource records;
   - `make_full`/`make_patch` and `encode_transaction`, or a lockstep connection's re-stamp;
   - the live coding (zstd).

   It hands the messages to the transport in order: the session message (a connection's first),
   then the records, then the transaction.
2. **One encode thread runs the jobs in submission order** (`Hub::Former`,
   `LiveConfig::formation = Thread`, entry.cpp's default). `GRC_HC_FORMATION=inline` runs them on
   the frame callback's thread at its end, which is also the unit tests' default. The P3-SP, W11b
   and W11t memos move to the job runner (`Hub::Memo`), so a lockstep connection's job finds the
   first one's transaction, records and coded bytes. A batch-end job hands the memo back so the
   main thread releases its snapshots, and flushes the taps.
3. **A job writes only its own outputs, the memo and its connection's `FormState`.** `FormState`
   holds the transport id, the tap, the coding and the coding prefix. The job reports:
   - counters (`Hub::Counters`);
   - live-log event lines (resource, the coding-wrong-prefix sabotage, send-failed);
   - a `message-too-large` error, whose text it sends itself, so nothing follows it.

   `Hub::sync()` waits for the queue and completes the jobs on the main thread. It runs at the
   top of every entry point (event, frame, finish, close, GET) and at the top of each frame
   callback (entry.cpp `live_drain`). Completion applies the counters and writes the lines, then
   either the error close or the frame line carrying the transaction's bytes. The live log
   therefore holds the lines a synchronous hub wrote, in the same order. A job's frame line is
   written at the next sync, before any later line of that connection. Undoing a too-large send's
   `sent` count (the state already advanced) keeps the summary equal too.
4. **File lanes form on the P3-CAP writer** (`Publisher::set_former`, `form_lane`). Each
   publication queues one task per lane behind its store writes. The task encodes the records and
   `make_full`/`make_patch` and writes them with the sinks' new `write_direct`/`flush_direct`.
   `publish()` keeps the record plan, the carried set, the `inline` resource events (whose `ok` is
   the queue's verdict, as with P3-CAP's writer before) and the patch-drop-item decision. The lanes'
   end stats belong to the writer until `finish()` drains it. The published snapshot is held shared
   (`last_published_shared()`), so the live hub takes it without the copy it made before.
5. **Snapshots can now drop their last reference on another thread.** Every copy-on-write site
   that writes in place when `use_count() == 1` takes an acquire fence: `SharedStrMap::own_root`
   and `own_chunk`, and the mirror's multimesh buffer and material floats. `SharedVector` and
   `SharedTable` already did.
6. **Sabotage `reorder`** (`GRC_HC_SABOTAGE=reorder`): every job sends its transaction before its
   resource records.

## Perf (capture-scale, /11, product hand-off env: inline 4096, hook log off, no tap)

`hc5-perf.sh` (from `hc4b-perf.sh`) ran 900 frames per leg, in real time, under the leg's
exclusive quiet lock. "Before" is main 8bfb9490, built from a `git archive` of main; "after" is
this branch. Both sides used the same scripts and fixture; only the extension differs. The legs
were interleaved base, hc5, base, hc5. **Load from other agents was 3.6 to 9.7** (`uptime`, in
`perf/hc5-perf.log`), above the brief's 4, so these are indicative numbers and the milestone sweep
owns the final timing. The 1-viewer legs run without a tap, as in HC4b, so `bench-live-scale`'s
own checks report "taps 0" (rc 1). The host's `perf.json` is the measurement.

Real time, ms. `perf.json` histogram means; p50 is the median bucket's upper bound.

| leg | callback p50 before → after | callback mean before → after | snapshot mean | encode mean (now on the encode thread) |
| --- | --- | --- | --- | --- |
| 1 viewer, static | ≤ 0.19 → **≤ 0.12** | 0.26 → 0.19 | 0.07 → 0.05 | 0.05 → 0.05 |
| 1 viewer, churn (`RS_SCALE_REDRAWS=170`) | ≤ 2.82 → **≤ 1.54** | 2.89 → 1.70 | 1.28 → 1.15 | 0.44 → 0.42 |
| file sink, no viewer, static (`--mode file`) | ≤ 0.10 → ≤ 0.05 | 0.63 → 0.55 | 0.06 → 0.04 | |
| file sink, no viewer, churn | ≤ 1.34 → ≤ 0.93 | 1.88 → 1.40 | 0.83 → 0.91 | |

The 1-viewer legs were rerun once the load fell to **1.4–2.3** (`-r2`, `perf/hc5-perf2.log`):

| leg (load 1.4–2.3) | callback p50 before → after | callback mean before → after | snapshot mean | encode mean |
| --- | --- | --- | --- | --- |
| 1 viewer, static | ≤ 0.17 → **≤ 0.10** | 0.22 → 0.16 | 0.06 → 0.05 | 0.05 → 0.05 |
| 1 viewer, churn | ≤ 1.98 → **≤ 1.22** | 2.05 → 1.23 | 0.89 → 0.82 | 0.35 → 0.34 |

HC5 takes **0.8 ms off the 1-viewer churn callback at low load** (p50 and mean), and about 1.3
ms under the first series' load. The design estimated ~0.6 ms. The difference is zstd and record
encoding, which `encode_us` never counted (`coding_ns` sits in the live summary, not a
histogram). HC4b measured that work at 6 M of the 12.8 M capture instructions a churn frame
retires (its "Notes for HC5"). The snapshot (0.8 ms at low load) is now most of what the churn
callback spends. The file sink's churn callback drops about 0.4 ms: the lane's `make_patch` and
encodes. The static legs were already near the floor. `diff_us` and `encode_us` hardly move,
because they now time the same work on the encode thread.

Evidence: `artifacts/render-stream/p3/hc5/perf/`: `realtime-table.txt` and
`realtime-table-r2.txt`, each leg's `perf.json`, and the drivers `hc5-perf.sh` and
`hc5-realtime-table*.py`.

## Byte identity (`cmp-rec.ts --tree`, main 8bfb9490 against this branch)

`hc5-ident.sh` (from `hc4b-ident.sh`). Base is main's library, built from a `git archive` of main.
Both sides ran this branch's scripts. The branch ran its default: the hub and the file lanes form
on their threads.

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 12 | identical |
| gate 2 (g2a, g2b, g2d) | 24 | identical |
| gate 5 (g5c, g5e) | 11 | identical |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt; Skip legs included) | 118 | 116 identical. The 2 that differ are `g8a/late-workers` (both sinks), which depend on worker timing (HC4b's note: main's own reruns disagree on them) |
| capture-scale /8, /10, /11, /12 (300 frames, sync workers, 64x48, redraws 170, Skip, hook log off), and /11 with the shadow oracle on | 5 x 300 records | identical; stores `diff -r` equal |
| `resources.jsonl` minus timing fields | 54 | 45 equal. The 9 that differ are HC4b's known set: the three g8w11 coding hosts and `gate2/live-inline`, by live pacing (live-inline: the same 10 pins and 3 retires, joined at frame 24 instead of 23); the g8pt captures, by `particles_set_seed`'s engine seeds; and `late-workers` |
| every check verdict of those gate runs (`result.json`) | 279 | the same on both sides: gate 1 28/36, gate 2 46/57, gate 5 35/46, gate 8 125/140. The failures are the sabotage legs `RS_SABOTAGE_TIER=skip` leaves out on both sides |

The live wire's identity is proven in the unit tests below (`test_hc5_formation_thread`), where
the pacing is deterministic. A live gate leg's acks follow the clock. The cmp-rec layers cover the
file lanes, which now form on the writer.

Outputs: `artifacts/render-stream/p3/hc5/ident/`: the cmp-rec output per layer, `resjsonl.txt`,
both sides' gate `result.json` files, and the drivers. The recordings were pruned after the
comparison.

## Checks

- **`rs_live_test::test_hc5_formation_thread`** (new) runs a /11 inline host with four
  connections for 40 callbacks plus finish, once inline and once on the encode thread with no
  per-callback wait (`sync()` before the test reads anything). The connections are two lockstep
  zstd-base viewers, an uncoded /11 viewer acking every other frame with a resync at 17, and a /6
  viewer (the CarriedIndex path). Compared to the inline hub, the threaded one gives:
  - every connection the same messages, byte for byte (the session's fresh stream id and the end
    record's timing stats aside);
  - the same transport calls per connection, in the same order;
  - equal taps and live logs (8 files; stream ids masked);
  - equal summary counters, `shared_sends` (78) and `coded_shared` included: the lockstep pair
    still shares transactions and coded bytes.

  The /11 stream passes the receiver model (`model_accepts`). Under `reorder` the model refuses
  it with `resource-missing`.
- **Every hub test on the encode thread.** The new ctests `rs_live_thread` and
  `rs_live_window_thread` run all of `rs_live_test` (741 checks) and `rs_live_window_test` (64,
  the window-1 transcripts included) with `--formation=thread`. Every hub then forms on the encode
  thread, and each callback waits for its own jobs before the test reads the fake transport.
- **`rs_publish_test::test_lane_former`** (new) forms both lanes on the writer at inline
  thresholds 0, B's payload and 16 MiB. Against `publish()`'s own formation it gives the same
  bytes in both sinks, the same store index and files, the same resource events in the same
  order, and equal end-stat counts.
- **ThreadSanitizer**: `rs_live_test` (inline and `--formation=thread`), `rs_live_window_test
  --formation=thread` and `rs_publish_test` built with `-fsanitize=thread` report no race. Run them
  under `setarch -R`: this kernel's ASLR otherwise aborts TSan with "unexpected memory mapping".
- **`sabotage-reorder-gate2-caught`** (new, `run-hc1.sh` / `hc1-checks.ts`):
  `GRC_HC_SABOTAGE=reorder` under `run-gate2.sh --legs g2a,g2b`. The live-inline receiver
  (rs-core) fails `resource-missing` at seq 1 ("texture 1's hash 2b32ed0e3bfd... never arrived as
  a resource record"), so `leg-class-live-inline` is `replay-failure`. Gate 2's own `live-inline`
  check fails on the same `resource-missing` in its validation of `received.rs2`.
- ctest 45/45 (main's 43 plus `rs_live_thread` and `rs_live_window_thread`).

## Validation

- **Remote full tier** (`remote-validate.sh --tier full`, run 40877728612, key
  `rv-20261029T125813Z-d0c72ea-23302`, tree d0c72ea3 on 8bfb9490): **22/22 runs pass**.
  - The runs: native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8, `native-rust-hc1` (every sabotage,
    `sabotage-reorder-gate2-caught` included), `g7-gsw`, `g7-web-rust`, `g7live-gsw` and
    `g7live-web-rust` (g7-2, g7-5, g7-55, g7-8), the crates, `pure`, `pnpm-test`, and
    `bench-instr` (−0.26 % to +0.47 %).
  - **The shadow oracle ran on every correctness gate leg**: 729 hosts and 196,329 snapshots
    compared, no mismatch.

    | run | hosts | snapshots |
    | --- | ---: | ---: |
    | gate 0 | 7 | 712 |
    | gate 1 | 13 | 4,828 |
    | gate 2 | 28 | 16,707 |
    | gate 3 | 11 | 1,568 |
    | gate 4 | 19 | 3,348 |
    | gate 5 | 14 | 2,620 |
    | gate 5.5 | 22 | 4,686 |
    | gate 8 | 98 | 10,850 |
    | hc1 | 24 | 4,540 |
    | g7-gsw | 202 | 45,576 |
    | g7-web-rust | 202 | 45,570 |
    | g7live-gsw | 45 | 27,973 |
    | g7live-web-rust | 44 | 27,351 |
- **Local, full tier, the groups the remote refuses**: `g7live-gsw` and `g7live-web-rust` g7-1
  (`RS_VALIDATE_GROUPS=g7-1`) both rc 0. The oracle covered 16 hosts and 11,860 snapshots each,
  with no mismatch.
- **Local smoke** (`validate-increment.sh`, on 8bfb9490, sabotage legs run): 22/24.
  - Passed: `lock-tests`, `pure`, the crates, `pnpm-test`, every native correctness gate,
    `native-rust-hc1` (25/25, `sabotage-reorder-gate2-caught` included), `g7-gsw`,
    `g7-web-rust`, and the g7-1 live smokes.
  - `bench-instr` returned 3: there is no valgrind locally. It passed remotely.
  - The timing run `native-rust-gate6` failed five checks:
    - `pins-bounded` and `obsolete-retired` on g6l's `live-reconnect`: the pre-existing gap HC4b
      documented, with the same frames 609–611. Main's 900afa5c, which landed during this
      increment, fixes them on the checker side.
    - `host-unperturbed-constrained`: the constrained leg's frame-interval p95 was 17.4 ms against
      a baseline of 18.8 ms (−7.5 %; the check is two-sided at 5 %). The baseline leg itself ran
      above a 60 fps frame (16.7 ms), at loads up to 9.
    - `leg-class-sabotage-constrained-ignore-credit` (the same host-unperturbed term) and
      `manifest-evidence`, which cites that check.

    These are timing verdicts taken under other agents' load. They go to the milestone sweep,
    along with window 1's phase.
- **Not run:** the timing runs other than the smoke's gate 6 (`g7live-*-timing`, g7x) and credit
  RTT and rate, which are the sweep's.
- **Time:** implementation about 1 h 15 min (the job split, the file lanes, the unit tests, the
  sabotage leg). Validation and measurement took about 3 h 30 min, mostly lock waits behind other
  agents' timing legs: the identity sets, two perf series, the local smoke (gate 6 alone ran
  69 min), the remote full tier, and the local g7-1 runs.

## Notes for W13b

- **The predictor state goes in `Hub::FormState`**, beside `last_tx`. Only the job runner touches
  it, and it advances in job order, so the T−2 base a /13 connection predicts from is that
  connection's own last formed transactions, the same chain the zstd-base prefix follows.
  Create it when the session job is built (`on_frame_shared`'s hello branch sets
  `form->coding` there), and reset it where a full transaction resets `last_tx` (a resync).
- **What a /13 job needs is already in it**: `target`, `tx_base` (null for a full one), `meta`
  (seq, base_seq, frame, version) and `full`. Shared /13 encodes can join `Memo` keyed like
  `SharedTx`, plus the predictor's base identity. Two lockstep connections share a /13
  transaction only when their predictor states agree.
- **Counters and log lines go through `Job::out` / `Job::lines`**, never `Conn`. The main thread
  must not read `FormState` while a job may run; read it after `sync()`.
- **The frame line is written at completion.** A /13 field in the `sent` object belongs in
  `complete()`, from what the job reported.

## Notes for the sweep

- `perf.json`'s `encode_us` and `diff_us` are now the encode thread's times (sampled at
  completion), and `enqueue_us` is the transport hand-off on that thread. `frame_callback_us` no
  longer contains them.
- `perf-timeline.jsonl`'s per-connection `bytes_sent`, `carried_size` and `shared_sends` are
  read in the same callback, before that callback's jobs complete, so they lag by one callback.
  `sent` and `credits` do not lag.
- Window 1's credit phase may shift by the encode time, since the bytes leave after the callback
  rather than inside it. That is a timing question for the milestone sweep (the design's "Not
  proven here").
- `ServedResources::served_` is still a `std::map<std::string, PayloadPtr>`. HC4b's note on the
  76 keyed dynamic surfaces stands; HC5 did not touch serving.
