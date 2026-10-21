### G7q — credit window 2 (opus; fork F1, only with the user's go-ahead)

- **Files**: `rs_live.{h,cpp}` (window w in-flight accounting, pins over every in-flight base,
  resync of an earlier seq, the `GRC_LIVE_CREDIT_WINDOW_MAX=2` grant); receivers applying several
  queued transactions per frame (native, web, gsw); the `phase-60` legs at window 2;
  `pending-bounded` generalized to `max_in_flight ≤ w`.
- **Checks**: Q9's window-2 prediction (five of five runs ≥ 0.95 × 60 on every receiver); every
  live leg of gates 1, 2, 6 and 7 at window 2 (stall, reconnect, fetch-latest-only, stale-coalesce
  sets unchanged); window 1 byte-identical to before (golden and live-log comparison).
- **Sabotage**: `GRC_SABOTAGE=window-overrun` (sends a third) must fail exactly `pending-bounded`
  and `queue-bounded`.


#### As built (G7q, 2026-10-20; finisher 2026-10-21)

- **Host** (`rs_live.{h,cpp}`). The single in-flight seq became a window of slots
  (`Conn::window`, oldest first, `window_slots` = the grant). `kHostCreditWindow` is 2, and the
  grant is still capped by `GRC_LIVE_CREDIT_WINDOW_MAX`, which defaults to 1, so window 2 is
  opt-in. A slot returns on its own seq's credit-stage ack. A resync for any in-flight seq also
  returns every later slot, and the live log's resync line lists them as `discarded`.
  `base_payloads()` pins every in-flight transaction's payloads. A window-2 frame line adds
  `in_flight_seqs`, and the host timeline adds `credit_window`. Nothing is added at window 1.
- **Window-1 identity**. `capture/test/rs_live_window_test.cpp` drives ten seeded scenarios at
  window 1 through a modelled receiver: every ack stage, stalls, stale and foreign acks, resyncs,
  inline and HTTP pins, rate control, two connections, /6 and /7, and the drop-message,
  ignore-credit and stale-coalesce sabotages. Its transcripts (every message, close, per-frame
  pin set, live log, tap and summary; stream ids and the end record's wall-clock costs
  normalized) are pinned by sha256 in `test/golden/live-window1-transcripts.txt`, recorded from
  the hub before G7q. The same file tests window 2.
- **Sabotage** `window-overrun` is a listener sabotage, like G7n's: the wire declares none. From
  `GRC_SABOTAGE_FRAME` (default 1), a connection with a full window still sends at every due
  tick, still paced, so the third transaction and every later one go out without credit. "Sends a
  third" alone could not fail `queue-bounded`: three small patches never exceed two largest
  messages plus 64 KiB. The overrun past the window builds G6c's backlog on the constrained
  link, as ignore-credit does at window 1. Its leg is G6c's constrained sabotage with this kind
  (`sabotage-constrained-window-overrun`, native receiver, `--credit-window 2`).
- **Receivers.** All three keep decoding on receipt. When several accepted transactions wait for
  one frame, they apply the newest resolved state once and draw it. Each folded seq is acked
  `applied` and `submitted` with it, in seq order, and marked `coalesced_into`. A resync refusal
  refuses the folded seqs too. Native and web share `receiver.gd`, and their Rust core already
  merges the touched sets across accepts (`plan.rs`). GSW's delta-driven wasm applier needed
  `rs-core`'s `Applier::prepare` to merge deltas (`TxDelta::merge`). `apply/window_tests.rs`
  checks that grouped applies paint what sequential ones do, on the goldens and on real
  recordings. Window 1 keeps every receiver's superseded path exactly.
- **Checkers.** `pending-bounded` is `max_in_flight ≤ w` with at most w transactions queued.
  `queue-bounded` is w largest messages plus 64 KiB. G6c's `legClass`, G1's delivery report
  (in-flight, resync `discarded`, queued limit over the w largest windows), G7u's window checks
  and the credit capacity (w / RTT) all read the granted window. `phase-window2-rate` is Q9's
  prediction.
- **Runners.** `run-gate7.sh --credit-window 2` exports `GATE7_CREDIT_WINDOW`
  (`lib/gamescope.sh`): live hosts get `GRC_LIVE_CREDIT_WINDOW_MAX=2`, browser receivers ask for
  2, and g6c's native receivers speak /7 at 2. With `g7-r`, each kind runs the window-2 list
  (`G7R_W2_LEGS_<kind>`). Native gates 1, 2 and 6 run on /6 and have no window.
- **Scoped deviation (orchestrator decision).** Native gates 1, 2 and 6 run on /6 by D2, and /6
  has no credit window. The native receiver's window 2 is proven by the /7 `g7-r` legs. Gates 1,
  2 and 6 at window 2 are covered by their browser runs, `g7-1`, `g7-2` and `g7-6`. No native
  /7 legs were built for gates 1, 2 and 6.
- **Folds and the checks (finisher).** A fold makes one apply out of several transactions. Every
  check that ties a transaction to a shot, fetch or failure now goes through the apply
  (`coalesced_into`, `appliedAs`). Every check that counts sends around a stall or suspension
  allows the stalled seq's w − 1 in-window sends. These include g6l's shot-window candidates,
  `motion-monotonic` (cadence and the G7mm hold), `pending-bounded`, `stall-latest` and
  `fetch-latest-only`. They also include G7u's suspension checks, gate 2's
  `stall-newest-texture`, and g5f's and g55f's recovery fetch. When credit flowed to a suspended
  page (`ack-while-hidden`), GSW folds the whole held queue ahead of the recovery; G7u's
  `stall-latest` and `fetch-latest-only` then judge that resume apply as the first post-resume
  picture (`resumeFoldAhead`, inert at window 1), and the sabotage keeps its window-1 set.
- **Stale-coalesce at window w.** A send made while the stale send still holds its slot repeats
  the stale target, so a folding receiver still draws it, and the sabotage keeps its window-1
  set. A repeat can reach back past a step boundary. g5f's and g55f's DF/PH-only tolerance is
  therefore DF/PH plus the regions the fresh table gives for the crossed steps.
- **GSW folds in place.** A fold keeps the bodies fetched and the GETs in flight (the cancelled
  GETs had reached the host, and their bodies were dropped unlogged). It waits for a GET whose
  payload the newest no longer needs, and stores that body. Each fetch and failure is logged at
  the seq that first needed the payload, and a folded entry that already acked in `onmessage` is
  not acked again.
