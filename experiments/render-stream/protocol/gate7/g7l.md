### G7l — live in browsers: gates 1, 2, 5f, 5.5f (opus)

- **Files**: the browser live clients (web: the /7 hello in `rs_live_client.gd`; GSW: `live.ts`,
  `fetcher.ts`); live legs in `run-gate7.sh` reusing `legs.sh` host functions; the token through
  the fragment; `received.rs7`; the `g7-1`, `g7-2` live legs, plus g5f and g55f (gsw after G7t/G7s).
- **Checks**: gate 1/2/5f/55f live checks `@web`, `@gsw`; `live-vs-replay` (the file replay of
  `received.rs7` through the same browser equals the live shots); `hello-recorded`;
  `credit-from-paced-loop`; `token-not-logged`; the auth and origin legs of `g7-2`.
- **Sabotages**: the native live sabotages (`stale-coalesce` and others) with their native sets;
  `no-cors`, `no-token` and `bad-http-token` as `g7-2` states.
- *Amended 2026-10-15 (D29):* GSW's live client and fetcher stay TypeScript (WebSocket, `fetch`,
  credit). They feed the core through Q14c's single copy. The web export's live legs run on
  whichever core its build uses (GDScript until G7xw).

- **As built (G7l, 2026-10-16)**, results in [results/gate7/g7l.md](../../results/gate7/g7l.md).
  Every listed live leg runs in both browsers over /7. For `gsw`, all four groups pass. For `web`,
  three pass and `g7-5` fails only on G7b's typed `web-index-region-update`.
  - **Where the legs live.** There is no new leg table. `run-gate7.sh --live` runs each gate's own
    runner again with `GATE7_LIVE_KIND=web|gsw` (`--legs g1a,g1c,g1d` / `g2a,g2c,g2e` /
    `g5c,g5f` / `g55f`), into `<out>/<gate>/live-<kind>/`. `check-gate5.ts` judges g5f only when
    g5c is in the same run. Inside the runner, `lib/legs.sh` makes three substitutions:
    - Each live host gets `GRC_LIVE_ALLOWED_ORIGINS` (the harness origin) and one fixed listen
      port per run.
    - Each live receiver goes to a browser instead: every `RS_RECEIVER_MODE=live` launch and
      every file replay of a `received.rs7` (the live-replay legs). A headless native leg becomes
      a rendered browser leg with credit stage `applied`.
    - Gate 1's `killed` leg SIGKILLs the leg's Chromium processes (host close 1006).
  - **The launcher.** One browser daemon per runner, `gate7-tool.ts browser-daemon`
    (`lib/gate7-live-legs.ts`), keeps the next leg's fresh Chromium launched and its provenance
    checked. Each leg is one `curl` to the daemon. A one-shot launcher took about 7 s under load
    and missed the host's S = 300 join budget. Warm legs start on a copy of the cold leg's
    profile, so the browser HTTP cache answers. The cache is keyed by port, hence the fixed host
    port.
  - **Token.** The token travels only in the fragment. The launcher reads the host's
    `live-token`, and the page removes the fragment before anything runs. `timings.json` is
    scrubbed, because the navigation entry keeps the fragment.
  - **Hello rejection is a connect failure.** A 1008 `unauthorized` close before any session is
    `live-connect-failed` in both receivers, the /7 form of /6's 401. g2e's `auth-required`
    reads the host's hello rejection (`token_ok: false`) at /7.
  - **New g2e legs.** These run in GATE7 mode only. In `origin-refused`, the page is served from
    a second, non-allowed harness port: 403 on the upgrade, `live: 403 origin` logged, and the
    receiver fails `live-connect-failed`. In `sabotage-no-cors`, the host serves the GET, and the
    receiver fails `resource-unavailable` at seq 1.
  - **Receivers.** The web export uses `RS_RECEIVER_PROTOCOL=7`, the only value it accepts on
    the web; native keeps 6 as the default. The receiver also takes `RS_RECEIVER_TOKEN`,
    `RS_RECEIVER_CREDIT_WINDOW` and `RS_RECEIVER_MANIFEST_SHA256`. It writes `received.rs7`, and
    file mode replays GRS7. `submitted_process_frame` is written on the web only, so native
    `applied.json` is byte-identical. The GSW receiver's live mode is `web/gsw-receiver/live.ts`
    and `fetcher.ts`, and it feeds `gsw-rs`'s per-message API (one copy per message, each decoded
    on its own). Each transaction carries a `paced` block: the rAF that applied it, the rAF that
    drew it, and where and when its `submitted` ack was sent.
  - **Judging** (`lib/gate7-live.ts`, `check-gate7.ts --live`):
    - The gate's checker judges three views of the run: full, blank and banded. A check whose
      verdict changes when the browser legs are blanked is `<id>@<kind>`. Every other check must
      pass (`native-legs@<kind>`).
    - The banded view (Q7) snaps each browser pixel within one level of its nearest native image
      to that image. Gate 2's eight exact pixel checks pass only there, at delta 1, in both
      browsers.
    - Gate 7 adds `browser-provenance`, `console-clean`, `hello-recorded`,
      `credit-from-paced-loop`, `token-not-logged` (whole run tree, Chromium profiles excluded)
      and `live-vs-replay`.
  - **Checker fix.** g2c's `pins-bounded` and `obsolete-retired` now use g5f's
    `connTimelinesAtCallback`, moved into `gate2c-checks.ts`. A browser closes inside the quit
    frame 971, after that frame's callback, so the last send is rightly still a base. This is the
    race G5f found at 851.
  - **G7f is void.** G6s fixed D20 (`_data` resets per message), and GSW decodes each message on
    its own. Both browsers still hold `received.rs7` in memory until exit (MEMFS on the web, page
    memory in GSW), which matters for G7k's soak, not here.
