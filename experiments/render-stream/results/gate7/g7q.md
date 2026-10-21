## Gate 7q result (2026-10-21)

G7q ([protocol/gate7/g7q.md](../../protocol/gate7/g7q.md); gate7-design.md D4, Q2, Q9, fork F1)
implements credit window 2, opt-in: the host keeps up to two transactions in flight per
receiver, and each receiver applies several queued transactions per frame. Window 1 stays the
default and the correctness baseline.

**Q9's window-2 prediction holds on every receiver: five of five runs at least 0.95 × 60.**

| Receiver | Published/s, five runs | Mean credit RTT (frames) | Hold p50 / p95 (ms) |
| --- | --- | --- | --- |
| native (Rust core, /7) | 59.85, 59.85, 59.77, 59.83, 59.84 | 1.02–1.03 | 2.4–3.0 / 18.1–18.8 |
| web export (Rust core) | 59.05, 60.00, 59.90, 60.00, 60.00 | 1.02–1.07 | 2.1–2.7 / 19.2–19.4 |
| GSW | 58.95, 59.06, 59.05, 59.05, 59.05 | 1.38–1.40 | 7.3–14.1 / 39.6–46.7 |

- **GSW shows what the window buys.** All five window-2 runs sat at a mean credit RTT of
  1.38–1.40 frames, which window 1 classes `between`, and all five published 59.0/s. A window-1
  control on the same build, run right after it (`w1-gsw-phase-control`), published 58.9, 49.6,
  59.1, 59.0 and 59.1/s. Its 49.6/s run had a hold p50 of 15.1 ms, the same phase as window-2
  runs r2, r3 and r5 (13.3–14.1 ms), which published 59.05/s each.
- **The cost is per-transaction latency on GSW.** The `submitted` ack latency p95 rises from
  22.8–32.3 ms at window 1 to 40.2–47.2 ms at window 2. GSW folded about a third of its
  transactions into the next one (589 folds over 1 686 transactions in r2). Each fold happened
  while the older transaction was still pending at the next message, and the older one is acked
  only at the newer one's draw. The native receiver (p95 19.9–27.7 ms) and the web export
  (23.9–29.9 ms) fold about 5 % and keep their window-1 tails. *Explained and fixed by the
  finisher* ("GSW's fold in place" below): the first build cancelled the fetcher on every fold
  and started the newest's fetches over. With the fold in place, GSW's p95 is 19.5–28.7 ms and its
  rate 59.84/s on five of five runs (`w2-gsw-r2`).
- **Constrained** (4 Mbit/s, 30 ms each way) passes at window 2 on both browsers: web 8.42/s at
  a mean RTT of 13.8 frames, GSW 8.63/s at 13.5 frames, two in flight, the queue bounded.

**The window-overrun sabotage fails exactly `pending-bounded` and `queue-bounded`** (class
`delivery-violation`): 1 069 in flight against a window of 2, and 636 819 bytes queued against
2 × 131 366 + 65 536. `host-unperturbed` and `final-latest-state` pass.

**Window 1 is byte-identical to before:**

- **Transcripts.** `capture/test/rs_live_window_test.cpp` replays ten seeded window-1 scenarios
  through the hub and a modelled receiver: every ack stage, stalls, stale and foreign acks,
  resyncs, inline and HTTP pins, rate control at 30 and 60, two connections, /6 and /7 (a /7
  hello asking for 2 under the default maximum), and the drop-message, ignore-credit and
  stale-coalesce sabotages. Each transcript holds every message (record metas and body digests),
  every close, the pin set after every frame, the live logs, the taps and the summary. They are
  pinned by sha256 in `capture/test/golden/live-window1-transcripts.txt`, recorded from the
  unchanged hub before any G7q edit. The G7q hub reproduces all ten byte for byte. Normalized:
  the random stream ids, and the end record's wall-clock encode costs, with the three lengths
  their digit count changes. 300 reruns of the old hub gave one digest per scenario once those
  were normalized.
- **Live logs.** `scripts/lib/live-log-schema.py` compares the native gate 1 live legs at window
  1 (smoke tier, Rust core) with a gate 1 source made on `main` the same evening: 11 paired logs,
  identical line kinds, key sets, key orders and value types. No window-2 field appears.
- **Goldens.** `golden-1/` to `golden-7/` `make_golden.py --check` pass (the pure self-tests).
- **Receivers.** At window 1 nothing is folded. Every receiver's older-superseded path, the one
  the sabotages that return credit early take, is unchanged.

```bash
# the phase study and the sabotage (native), then the browsers
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-r --receiver native \
  --credit-window 2 --skip-harness-selftest --out artifacts/render-stream/gate7/g7q/w2-native-r1
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-r --receiver web|gsw \
  --credit-window 2 --web-core rust --skip-harness-selftest --out …/g7q/w2-<kind>-r1
# the window-1 GSW control: the same with --credit-window 1 and
# G7R_LEGS=rate-baseline,phase-60-r1,phase-60-r2,phase-60-r3,phase-60-r4,phase-60-r5
```

Box: Ryzen 5 5500, RTX 2060, gamescope headless, headless Chromium (`--headless=new`). Every
timed leg held the quiet lock exclusive. This increment's smoke tier and its other runs shared
the machine through that lock. A separate agent's Node test processes also loaded the box
(1-min load 2.4–8.4 during the runs), and the lock cannot see them.

### What was built

- **Host** (`capture/src/rs_live.{h,cpp}`, `entry.cpp`):
  - Window slots replace the single in-flight seq. Each slot returns on its own seq's
    credit-stage ack.
  - A resync for any in-flight seq returns every later slot, listed as `discarded` on its line.
  - The pins cover every in-flight transaction's payloads.
  - Window-2 frame lines add `in_flight_seqs`, and the host timeline adds `credit_window`.
  - `kHostCreditWindow` is 2. `GRC_LIVE_CREDIT_WINDOW_MAX` still defaults to 1.
  - `window-overrun` is a listener sabotage.
  - At window ≥ 2, stale-coalesce repeats its stale target on every send made while the stale
    send holds its slot, so a receiver's fold still draws it (`rs_live.h`).
- **Receivers.** All three apply the newest resolved state once for every accepted transaction
  waiting on a frame. Each folded seq gets its own `applied` and `submitted` acks, in seq order,
  and is marked `coalesced_into` in applied.json.
  - `receiver.gd` serves both the native receiver and the web export. On the Rust core,
    `plan.rs` already merged the touched sets across accepts.
  - GSW's wasm applier is delta-driven. `rs-core`'s `Applier::prepare` now merges deltas across
    prepares (`TxDelta::merge`, an ascending union per list).
  - `apply/window_tests.rs` checks that applies grouped in twos and threes paint exactly what
    sequential applies do (`paint_digest`, scissors, lowered items). It runs on golden-2 to
    golden-7, plus a gate 2 and two gate 5 recordings: 751 grouped applies. A mutation that
    ignores the merged delta fails it.
  - GSW's `live.ts` folds in place: the pending transaction becomes the newest and keeps its
    bodies and GETs in flight, and only new misses are queued. Each fetch and failure is logged
    at the seq that first needed the payload.
- **Checkers** read the granted window:
  - `pending-bounded`: `max_in_flight ≤ w`, at most w transactions queued;
  - `queue-bounded`: w × the largest message + 64 KiB;
  - G6c's `legClass`;
  - G1's delivery report: in flight, resync `discarded`, and the queued limit over the w
    largest credit windows;
  - G7u's two window checks;
  - the credit capacity (w / RTT);
  - G7l/G7r's hello check: the window asked for is the window granted;
  - g6l's `motion-monotonic` (cadence and the G7mm hold rule), `pending-bounded`, `stall-latest`
    and `fetch-latest-only`, and the shot-window candidates (one per apply);
  - G7u's `pending-bounded`, `stall-latest` and `resume-no-burst` over a suspension;
  - gate 2's `stall-newest-texture`, and g5f's and g55f's recovery fetch and stale tolerance.

  New: `phase-window2-rate` and the overrun sabotage rule, in `gate7r-checks.ts`.
- **Runners**: `run-gate7.sh --credit-window 1|2` exports `GATE7_CREDIT_WINDOW`
  (`lib/gamescope.sh`, `lib/legs.sh`, `lib/gate6c-legs.sh`):
  - live hosts get `GRC_LIVE_CREDIT_WINDOW_MAX=2`;
  - browser receivers ask for window 2;
  - g6c's native receivers speak /7 at window 2 (dual-native's /6 receiver stays at 1);
  - `g7-r` runs `G7R_W2_LEGS_<kind>`.
- **Self-tests**:
  - `rs_live_window_test` (60 checks);
  - `rs_live_test` (the /7 grant is now 2 under a maximum of 2);
  - `rs-ws-g7n.ts` (the same);
  - `self-test-gate6c.ts` (window-2 pending and queue bounds);
  - `self-test-gate7r.ts` (the window-2 leg lists against the runner);
  - `self-test-gate6l.ts` and `self-test-gate7u.ts` (a passing and a failing window-2 case per
    rule).

### Every live group at window 2

Every browser live group ran at `--credit-window 2` on the final tree's code (Rust web core, web
bundle `469f70d02089cb58`, GSW bundle `gsw-bundle-build4`, `rs-core` b3124f19b17a), each judged
by the committed checker. Fast frames where GRT3's allowlist permits them; `g7-6` and `g7-lc`
are real time.

| Group | Frames | web | GSW | Run |
| --- | --- | --- | --- | --- |
| `g7-1` (g1a, g1c, g1d) | fast | 78/78 over both | | `w2-live-fast-r4` |
| `g7-2` (g2a, g2c, g2e) | fast | 37/37 | 35/35 | `w2-live-fast-r6` |
| `g7-5` (g5c, g5f) | fast | 21/21 | 19/19 | `w2-live-fast-r5`, re-judged |
| `g7-55` (g55c, g55f) | fast | 21/21 | 19/19 | `w2-live-fast-r5`, re-judged |
| `g7-6` (g6l) | real time | 27/27 | 25/25 | `w2-live-g76-r2` (web), `-r3` (GSW) |
| `g7-lc` (desktop lifecycle) | real time | 72/72 | 70/70 | `validate/g7q-full3-w2` |

The full tier then re-ran every group at window 2 on the final tree (`validate/g7q-full3-w2`,
bundles built from it) with the same counts, `g7-lc`'s GSW sabotage included.

The counts are per-receiver checks; the run-level checks (`live-run`, `console-clean`,
`browser-provenance` and the like) pass too. The stale-coalesce sabotage of every group fails
exactly its window-1 set at window 2, and every stall leg's `fetch-latest-only` and
`newest-after-stall` hold.

#### `g7-6` at window 2: two mechanisms, neither in an applier

The first window-2 run failed `leg-class-live-stall` identically on both browsers, which pointed
away from the two independent appliers. The reason text "windows 112 missed" names **one**
window, motion window 12 (frames 542 to 551), not 112 of them. The nine-region, 10 k px
"pixel-mismatch at frame 307" in the same reason is the exact view, which every browser shot
fails by Q7's readback band; the band view passed. Two mechanisms were real:

- **A fold leaves one candidate for two windows.** After the stall the host sent the recovery
  seq at frame 549 and the next at 550, and both receivers folded them into one apply (frame 550).
  That apply is the first candidate of settle window 4 (547 to 599), which is listed first, so
  motion window 112 had nothing left to shoot. `windowsWithoutCandidate` counted the folded
  transaction as a candidate of its own. The exact window-w rule: the candidates are the
  applies, each at its newest transaction's frame, so a transaction with `coalesced_into` is no
  candidate. Nothing is folded at window 1, so window 1's rule is unchanged.
- **A fold could hide the stale-coalesce sabotage.** GSW folded the stale recovery into the next
  send, which patched from the stale state to the newest, so the stale target never reached the
  screen and the post-stall shot was fresh. That would change the sabotage's set at window 2
  (g5f's and g55f's stale checks judge the post-stall shot the same way). The host now repeats the
  stale target on every send made while the stale send still holds its window slot
  (`rs_live.h`, stale-coalesce; at window 1 nothing is sent then). Whatever the receiver folds,
  the post-stall picture is the stale one. `rs_live_window_test` checks the repeat and the return
  to the newest state after the stale seq's credit, and the ten window-1 transcripts still match.

The four window-1 premises in `gate6l-checks.ts` became exact window-w rules, each read from the
granted window (the hello line's `credit_window_granted`):

- `motion-monotonic`'s cadence (`creditToSend`): a send needs the credit of the seq w sends back
  (window 1: the previous one), and goes at the first callback with a free slot, one per callback.
  The gap rule built on G7mm's frame rule: after send p the host is blocked only while all w slots
  are held, so a gap after p is excused by the hold of seq p − w + 1, the slot the next send took.
- `pending-bounded`: at most w in flight, and at most w − 1 sends between the stalled seq and its
  credit.
- `stall-latest`: the recovery is the first transaction after the stalled seq's w − 1 in-window
  sends, and its picture is that of the apply it was folded into.
- `fetch-latest-only`: a fetch is attributed to the apply it served (`appliedAs`).
- G7u's `stall-latest` and `fetch-latest-only` over a suspension, the resume fold
  (`resumeFoldAhead`, second finisher). An honest window-w page holds the stalled seq and at most
  its w − 1 in-window sends at resume, and folds them into the newest; the recovery is then the
  first post-resume picture. The `ack-while-hidden` sabotage returns credit to the hidden page, so
  the page holds far more: GSW folds the whole held queue into its newest (278..398 into 399 in
  `w2-live-lc-sab-r2`), applies and shoots it in the first resumed frame, and only then does the
  recovery (400, the first send after the stalled credit) arrive, applied alone and unshot. When
  the stalled seq's fold target lies past its w − 1 in-window sends and before the recovery, that
  apply is the first post-resume picture. `stall-latest` then requires it to carry no stale_from,
  to equal the host's full recording at its frame, and its shot to equal the reference, in place
  of the recovery's shot. `fetch-latest-only` requires the one in-suspension TEXA version fetched
  to be the one current at its frame, fetched for it. The recovery's own checks stand: no
  stale_from, its state equal to the mirror, and the first apply after the stalled seq's
  in-suspension sends. Nothing folds at window 1, so the rule is inert there; an honest window-2
  resume (365 into 366) is not a fold ahead. The sabotage now fails exactly `pending-bounded`
  and `credit-from-paced-loop` at window 2, its window-1 set, and the window-1 control
  (`w1-live-lc-sab-control`, re-judged) fails that same set.

`self-test-gate6l.ts` has a passing and a failing window-2 case for each.

#### GSW's fold in place

`live.ts` used to cancel the fetcher on a fold and refetch the newest's needed set. The cancelled
GETs still reached the host, and their bodies were dropped unlogged. In `live-scene` the host
served 130 GETs against 108 in the receiver's log, and the 22 missing were bodies fetched and
thrown away. The fold now happens in place. The pending transaction becomes the newest and keeps
every body fetched and every GET in flight; wasm's stage is keyed by hash. Queued requests the
newest no longer needs are dropped, and only new misses are queued. The apply waits for a GET
still in flight. A body the newest no longer needs goes to the store, verified on arrival, as
`receiver.gd`'s fetched payloads go to its memory. Each fetch and failure is logged at the seq it
was made for, so `sabotage-wrong-hash-live` fails at 295 and `no-cors-withheld` at 1, as the
check expects.

| `g7-6` GSW leg | host GETs | receiver fetches | discarded or unverified |
| --- | --- | --- | --- |
| live-scene, before (`w2-live-g76-r1`) | 130 | 108 | 22 |
| live-stall, before | 127 | 98 | 29 |
| live-reconnect, before | 130 | 101 | 29 |
| live-scene, after (`w2-live-g76-r3`) | 131 | 131 | 0 |
| live-stall, after | 128 | 128 | 0 |
| live-reconnect, after | 131 | 131 | 0 |

**The host's GET count did not drop, and could not.** Every distinct payload version is fetched
once in both builds; the old build simply never logged 22 to 29 of them per leg. What went away
is the waste: bodies fetched and discarded, and a log that disagreed with the host.
`http-gets-match-fetches` and `warm-fetch` pass. An intermediate build without the wait and the
store made the cost visible: 172 receiver requests for 129 payloads, 70 never verified.

**It also removed GSW's window-2 latency tail.** The fold-in-place build was the only
change between the two `g7-r` GSW runs at window 2, both real time. The credit-RTT p95 per phase
run fell from 38.9, 45.1, 47.1, 41.0 and 47.1 ms (`w2-gsw-r1`) to 20.5, 24.6, 28.7, 21.5 and
19.5 ms (`w2-gsw-r2`). The rate rose from 58.95–59.06/s to 59.84/s on all five. Each figure is
the lower bound of the `credit_rtt_us` submitted histogram's p95 bucket in the host's
`perf.json`. The window-1 control gives 22.5–31.7 ms. A cancelled fetch had held the folded
transaction pending until the newest's refetch finished, and the next message landed in that
time. That fits a third of GSW's transactions being folded in that build; the fold counts of
`w2-gsw-r2` were not compared.

### Deviation: native gates 1, 2 and 6 at window 2 (orchestrator-scoped)

G7q's Checks ask for every live leg of gates 1, 2, 6 and 7 at window 2. The native receiver runs
gates 1, 2 and 6 on /6 by D2, and /6 has no credit window: a /6 hello cannot ask for 2. Window 2
is a /7 feature. So the native receiver's window 2 is proven by the /7 `g7-r` legs (the phase
study, `constrained` and the window-overrun sabotage, `w2-native-r1`). Gates 1, 2 and 6 at
window 2 are covered by their browser runs, `g7-1`, `g7-2` and `g7-6`, on both browser
receivers. No native /7 legs were built for gates 1, 2 and 6.

### Re-runs (scoped)

The diff reaches every target (`validate-increment.sh --plan --tier full`: 65 targets, none out
of reach). The capture, `receiver.gd` and every live checker are in it, so the full tier runs
with the sabotage legs.

- **Window 2**: every browser live group (the table above), plus `g7-r` on all three receivers.
- **Window 1**: the full tier, `validate/g7q-full2`, at `--fast-frames on`.
  - pass: lock-tests, pure, capture-build (21/21 ctests), the cargo crates but gsw-rs, and the
    native gates −1 to 6 on both cores (Rust 6: 154/154). Checkers changed after it began, so
    the second finisher re-ran on the final tree: `pure` (53/53, `validate/g7q-full3-w1`), and
    the Rust core's gates 2, 5 and 5.5 (`validate/g7q-full3-native`), all rc=0. Rust gate 6 was
    re-judged by `check-gate6.ts` on the final checkers (154/154). GDScript gates 4 to 6 began
    after the last semantic checker change, so they stand.
  - fail, not G7q's:
    - `cargo-gsw-rs` fails with E0432, because the `canvas_items` items are cfg'd to wasm32 and
      a native `cargo test` cannot compile them. G7q does not touch gsw-rs; main fails the same.
    - `pnpm-test` fails because `chromium_headless_shell-1223` is missing from the shared
      Playwright cache. That is environmental, and nothing was downloaded.
- **Self-tests**: self-test-gate2, -gate5f, -gate55f, -gate6 (267, with the window-2 g6l cases),
  -gate7u (117, with the resume-fold cases) and `rs_live_window_test` (the held stale target) pass.
- **Gate 7, full tier on the final tree** (`RS_LEG_SHARDS=2`, fast frames where allowlisted;
  `g7-6`, `g7-lc` and `g7-r` real time). Counts are per-receiver PASS rows of `check-gate7.ts`.
  Every `g7-lc` run also lists the phone's real-suspension rows as UNAV (3 web, 4 GSW; no device
  run, G7h Finding 1), which make its rc 1 with no FAIL row.

  | Run | Window | web | GSW | Native |
  | --- | --- | --- | --- | --- |
  | `g7live` (g7-1, -2, -5, -55, -6, -lc) | 2 | 40, 37, 21, 21, 27, 72 | 38, 35, 19, 19, 25, 70 | |
  | `g7-r` native (run directly, see below) | 2 | | | 32 PASS, no FAIL |
  | `g7live` | 1 | 40, 37, 21, 21, 27, 72 | 38, 35, 19, 19, 25, 70 | |
  | `g7-r` native | 1 | | | 46 PASS, no FAIL |
  | file groups `g7-gsw`, `g7-web-rust`, `g7-web-gdscript` | (none) | `g7-web-rust` 326 PASS; `g7-gsw` 329 PASS (rc 0); `g7-web-gdscript` deferred to the milestone sweep (D34); see below | | |

  Window 1 matches window 2 count for count on `g7live`; the only non-PASS rows are the g7-lc
  real-suspension UNAV rows (3 web, 4 GSW), so rc 1 is not a FAIL. `g7-web-gdscript` (the frozen
  GDScript core, covered by milestone sweeps under D34): the first run exited 1 because the gate-1
  checker tried to write `diff/*.png` into a read-only source-cache hit (a harness trap, not G7q).
  A re-run with `RS_SOURCE_CACHE=0` gave 316 PASS and 9 FAIL, all the known g7-5
  `mesh_surface_update_index_region` rows (`web-index-region-update`), so nothing new. The
  full-tier sweep of that core is left to the milestone sweep.

  `validate-increment.sh`'s `g7live-native` exits 2 in a second at either window: its plan pairs
  `g7-lc` with the native receiver, and `run-gate7.sh` refuses that. That is the plan's, on main
  too. Its real content is `g7-r` on the native receiver, run directly
  (`artifacts/render-stream/gate7/g7q/tools/run-g7r-native.sh`).
- **Not re-run, out of scope**: `g7x` (the phone bench and dev arms). G7q changes no decode or
  apply path that `gate7-bench.ts` times.

### Recommendation: window 2 as the eventual default

**Recommended, but not flipped in G7q. Flip it after G7v measures window 2 on the g31.**

- **The rate.** Window 2 holds Q9's 0.95 × 60 on every phase run: 15 of 15 across the three
  receivers. That includes GSW at a mean credit RTT of 1.38–1.40 frames, which at window 1 is the
  phase that cost a control run 49.6/s. Window 1's phase lock is the one 60/60 failure a receiver
  cannot fix on its own (D4).
- **The correctness.** Every browser live group passes at window 2 with each window-1 premise
  turned into an exact window-w rule. Every sabotage keeps its window-1 set, and window 1 is byte
  identical (the ten transcripts).
- **The cost.** On the final tree, none was measured. GSW's submitted-credit RTT p95 is 19.5–28.7
  ms at window 2 (`w2-gsw-r2`), against 22.5–31.7 ms at window 1 (`w1-gsw-phase-control`). The
  first build's 38.9–47.1 ms (`w2-gsw-r1`) was the cancel-and-refetch, not the window. The native
  receiver and the web export fold about 5 % and keep their window-1 tails. Neither run was
  interleaved with the other on the box, so compare them as ranges, not run by run.
- **Why not now.** The receiver that needs window 2 most is a phone, and D26 predicts the g31
  meets 60/60 only at window 2. G7v measures exactly that. Flipping before it would change the
  baseline every milestone sweep compares against without the measurement that justifies it.
- **What the flip is.** `GRC_LIVE_CREDIT_WINDOW_MAX` defaults to 2, and both browser receivers
  keep asking for 2. Window 1 stays selectable as the correctness baseline, and its transcripts
  stay pinned.

### Traps

- **"windows 112 missed" names one window.** It is motion window 12, not 112 windows. Also, an
  exact-view "pixel-mismatch" in a browser leg's reasons is Q7's readback band, and the band view
  is the verdict. Read both views before chasing pixels.
- **A fold leaves one candidate for two windows.** It also hides a stale-coalesce recovery.
  Every check that maps a transaction to a shot, a fetch or a failure must go through the apply
  (`appliedAs` / `coalesced_into`). Every check that counts sends around a stall must skip the
  stalled seq's w − 1 in-window sends.
- **The in-window send is not always folded.** `stall-newest-texture` assumed it was, and passed
  once by luck. The receiver may apply it alone right after the stall.
- **Cancelling a GSW fetch does not cancel the GET.** It reaches the host anyway, and its body
  was silently dropped. A fold must keep in-flight requests, and must wait for one whose payload
  the newest no longer needs, or the log loses a GET the host served.
- **A page that got credit while hidden folds its queue ahead of the recovery.** The stall's
  "recovery" (the first send after the stalled credit) is then not the first post-resume picture,
  and the step's shot is of the fold. Judge the fold (`resumeFoldAhead`); never drop the shot.
- **Folded entries must not re-ack.** The GSW-only sabotages already ack in `onmessage`. Acking a
  folded entry again at draw overwrote `submitted_from` and hid `credit-from-paced-loop`'s
  failure.
- **Held stale crosses step boundaries.** At window 2, repeating the stale target can carry a
  snapshot from before a step. g5f's and g55f's "DF/PH only" tolerance became "DF/PH plus every
  region the fresh table says the crossed steps touch", which is still exact.
- **Stopping a runner leaves orphans.** Killing `run-gate7.sh` leaves its `run-gate<N>.sh`
  children and their headless Godot running. Kill them by PID, after checking their `--out`.
- **A 430 ms receiver block under load drops a settle window.** It happened on `g7-2`'s web
  live-stall, at seq 230, on a fast-frames host. Under fast frames, a block that long covers a
  whole 53-frame window. It is not window-specific.
