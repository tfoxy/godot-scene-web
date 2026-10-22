## Gate 7wd result (2026-10-22)

G7wd makes credit window 2 the default (gate7-design.md fork F1, D4). The user approved the flip
after G7v ([g7v.md](g7v.md)) measured it on the g31: window 2 raises every receiver's drawn rate
and never lowers one (gsw pace 47.0 to 58.1, scene 35.9 to 54.4; web pace 27.8 to 55.9), and
window 1 cannot reach 57/s on the panel's 58.8 Hz. Window 1 stays selectable and stays the
correctness baseline. No protocol change: /7 already carried `credit_window` 1..2.

### What changed

- **Host**: `GRC_LIVE_CREDIT_WINDOW_MAX` defaults to 2 (`capture/src/entry.cpp`, `LiveConfig`'s
  default in `capture/src/rs_live.h`, `capture/test/rs_live_host.cpp`). A hello asking 1 is
  still granted 1, and /6 has no window.
- **Receivers' hello**: the GSW receiver (`web/gsw-receiver/config.ts`) and the native /7 receiver
  (`receiver/receiver.gd`, also the web export) ask for 2 unless `RS_RECEIVER_CREDIT_WINDOW=1`.
  The native receiver on /6 is unchanged. (receiver.gd: one default line; no logic added.)
- **Runners**: `run-gate7.sh --live` exports `GATE7_CREDIT_WINDOW=2` unless `--credit-window 1`.
  `lib/gamescope.sh` defaults it to 2 under a browser `GATE7_LIVE_KIND` and to 1 for the native
  gates run directly, so gates 1, 2 and 6 natively stay on /6 and byte-for-byte what they were.
  Every live host launch now gets `GRC_LIVE_CREDIT_WINDOW_MAX=<window>` and every browser
  receiver `RS_RECEIVER_CREDIT_WINDOW=<window>` explicitly, so window 1 is written down.
- **g7-r decision**: its default list follows the window. At the default 2 a `--live --legs g7-r`
  run uses `G7R_W2_LEGS_<kind>`; `--credit-window 1` runs `G7R_LEGS_<kind>` as before (those
  lists, dual-native, late-poll and `sabotage-ack-on-receipt` included, are window-1 legs). A
  sweep that wants both runs both.
- **Window 1 pinned**: the ten sha-pinned hub transcripts are produced with an explicit
  `credit_window_max = 1` (`rs_live_window_test.cpp` `window1_config()`), unchanged shas.
  g7p's native window-1 rows already set `RS_RECEIVER_PROTOCOL=7 RS_RECEIVER_CREDIT_WINDOW=1`.
- Checker fallbacks that assumed 1 when no env names a window (`lib/gate7-live.ts`,
  `lib/gate7p-device.ts`, `self-test-gate7u.ts`'s hello fixture) now assume 2.
- Docs: gate7-design.md F1 and D4, [g7q.md](g7q.md) amendment note, g7v.md, `scripts/README.md`.

### Validation

- Capture ctests: 21/21, including `rs_live` and the window-1 transcripts (cap.log).
- Pure tier: 60/61 first run; the one failure (`self-test-gate7u`, a hello fixture that assumed
  window 1) fixed, re-run alone 117/117. The rest of the pure tier was not repeated.
- Smoke, default window (`validate-increment.sh --tier smoke --only <run>`): `g7live-gsw-g7-1`
  and `g7live-web-rust-g7-1` pass, `native-rust-gate1` passes. Window 2 negotiated by default:
  the host tap's hello in `artifacts/render-stream/validate/20261022T173401Z/g7live-gsw-g7-1/run/
  gate1/live-gsw/live/host/tap/live-1.jsonl` reads `"credit_window":2,"credit_window_granted":2`,
  and the host's `live.json` `credit_window_max` is 2.
- Explicit window 1: `run-gate7.sh --live --legs g7-1 --receiver gsw --credit-window 1`
  (`artifacts/render-stream/g7wd-w1/`): gate passed, every hello and `live.json` shows
  `credit_window_granted` 1 and `credit_window_max` 1.
- **Not run**: the full tier. The orchestrator's pre-G7z delta sweep covers it. g7-r, g7-lc,
  g7-k, g7-6 and the timing groups are unexercised at the new default.
