### G7r — pacing, rates, phase study, dual (opus)

- **Files**: `g7-r` legs and checks (Q9), reusing G6c's `gate6c-legs.sh` and `gate6c-checks.ts`
  with receiver kinds; `RS_RECEIVER_LATE_POLL` (native and web); `RS_RECEIVER_MAX_FPS` (gsw).
- **Checks**: Q9's table. README "Gate 7r result" tabulates published/s for every phase run per
  receiver and variant, with the good/bad classification and hold distributions.
- **Sabotage**: `ack-on-receipt` (gsw) fails exactly `credit-from-paced-loop` and the
  `rate-mismatch` upper bound.

