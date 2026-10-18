### G7r — pacing, rates, phase study, dual (opus)

- **Files**: `g7-r` legs and checks (Q9), reusing G6c's `gate6c-legs.sh` and `gate6c-checks.ts`
  with receiver kinds; `RS_RECEIVER_LATE_POLL` (native and web); `RS_RECEIVER_MAX_FPS` (gsw).
- **Checks**: Q9's table. README "Gate 7r result" tabulates published/s for every phase run per
  receiver and variant, with the good/bad classification and hold distributions.
- **Sabotage**: `ack-on-receipt` (gsw) fails exactly `credit-from-paced-loop` and the
  `rate-mismatch` upper bound.

- **As built (G7r, 2026-10-17; [results/gate7/g7r.md](../../results/gate7/g7r.md)).** `g7-r`
  ran on all three receivers at credit window 1: native and GSW pass every gating check (45/45,
  59/59), and the web export passes 76/78. Its two failures are `rate-achieved` at 15/s and 30/s,
  whose cause the checker measures: each payload GET takes about 66 ms, four main-loop
  iterations. The ack-on-receipt sabotage fails exactly as required. No variant holds 60/60 on
  every clock phase, so D4's negative finding stands for browsers too.
  - **Where the legs live.** There is no new leg table. `run-gate7.sh --live --legs g7-r` runs
    `run-gate6.sh --legs g6c` once per receiver kind with `G6C_LEGS` naming that kind's legs, into
    `<out>/gate6/rates-<kind>/`. `lib/gate6c-legs.sh` takes receiver kinds. Under
    `GATE7_LIVE_KIND`, each g6c receiver is that browser (`run_browser_receiver`), and
    `dual-native`'s receiver-b stays native (`G6C_RECEIVER_NATIVE=1`). G7r's legs run only when
    `G6C_LEGS` names them, so gate 6 is unchanged:
    - `phase-60-r1..r5` (rate-60's configuration);
    - `phase-60-late-poll-r1..r5`;
    - `dual-native`;
    - `sabotage-ack-on-receipt`.

    `lib/gate7r-checks.ts` judges each run with G6c's own loader, measures and evaluators.
  - **Browsers are rAF-bound.** Where G6c's native receiver runs at `--max-fps 60`, a browser
    gets `--max-fps 0` (Q9's "browser rAF"); the 30 fps legs pass 30. GSW's `perf.json` gains a
    per-second `timeline` whose `frames` counts paced rAF callbacks. GSW draws only callbacks that
    applied something, so its drawn count is the published rate, not a receiver frame rate.
  - **Native and web: `RS_RECEIVER_LATE_POLL=1`** connects `_process_live` to
    `RenderingServer.frame_pre_draw` instead of `_process`. The `submitted` ack stays at that
    iteration's `frame_post_draw`. It is a usage error under `--headless`, where nothing draws.
    `applied.json` writes `live.late_poll: true` only when it is set, so every other leg is byte
    for byte what it was. GSW needs no variant: its credit is already sent in the rAF callback
    right after submit.
  - **Holds.** G6c's hold is `received_us` to `submitted_us`, and it means something different
    per receiver:
    - Native and web stamp `received_us` at the socket read in the main-loop iteration, so their
      hold is phase-free work.
    - GSW stamps it in `onmessage`, so its hold includes the wait for the next rAF: Q13c's hold.
      Its phase-free part (the applying rAF's timestamp to the ack) is reported beside it.

    `dual-independent` compares phase-free holds, within 10 % or 1 ms. GSW's phase-free hold is
    about 1 ms, and 10 % of that is below the browser clock's 100 µs quantum.
  - **Phase classes.** Q9's class (the window's mean credit RTT: good at 1.1 host frames or less,
    bad at 1.9 or more) is reported, and the class of the connection's whole-run median RTT is
    reported beside it. The web export's GET tail adds about 0.34 frames to every run's mean. So a
    web run in the good phase publishes about 45/s, with a mean of 1.34 frames and a median of 1.
    The mean alone calls it `between`.
  - **`final-latest-state`** is exact for native receivers (budget 0). A browser's final shot is
    judged against the same native reference under Q7's band: every differing pixel must be
    `readback` or `delta1`, using G7b's classes.
  - **`constrained` under `GATE7_LIVE_KIND` has bearer authorization** (`GRC_LIVE_AUTH=token`).
    Without the `Authorization` header a browser's GET is simple and is never preflighted, so
    there would be no preflight to time. `throttle-proxy.ts` observes each connection's HTTP/1.1
    exchanges: an OPTIONS to its 204 as delivered, and a GET to its response. These are
    `stats.json` `http`, reported as `preflight-latency`.
  - **The sabotage runs with every payload inline**, as G6c's ignore-credit sabotage does. Over
    HTTP, credit on receipt lets the host retire D7's pins before the receiver fetches, so the leg
    would fail `resource-unavailable` (404) first: measured in development. The host cannot see
    this sabotage. It shows `max_in_flight` 1, no send without credit, and a 0.9 ms credit RTT.
    Only the receiver's own paced-loop evidence and the rate against its frame rate catch it.
  - **The browser daemon's `--spare after`** (`GATE7_BROWSER_SPARE=after`, set by g7-r) launches
    the next leg's browser only once a leg has ended, so no Chromium start-up lands in a timed
    window.
  - **The web fetch tail stays failing.** `rate-achieved` at 15/s and 30/s fails on the web
    export, and D1 makes that the web export's failure. The checker names the cause only from
    evidence (`fetchTailCause`): at least 90 % of the leg's holds over two host frames waited for
    a GET, and the median GET exceeded the publication period minus one callback. G6c's bound
    uses the mean credit RTT, which is exact only when the target is the host's own rate. At a
    lower target, a transaction whose RTT outlasts the period costs a due tick. Native GETs take
    one iteration (16.6 ms) and GSW's take 1.6 ms, so neither misses.

