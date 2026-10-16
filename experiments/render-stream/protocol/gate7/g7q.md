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

