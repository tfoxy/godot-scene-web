## Gate 7n result (2026-10-15)

G7n ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7n", Q3, D2 to D4) passes. The
capture's live listener now serves render-stream/6 and render-stream/7 side by side, takes the
/7 token in the hello, enforces an `Origin` allowlist, and speaks CORS on its resource route.
Everything a /6 client sees is unchanged, and gates −1, 0, 1, 2 and 6 pass natively on /6.

**What a host does now** (render-stream-7.md "As built (G7n)" has the details):

- **Two subprotocols on one listener.** The upgrade accepts `render-stream.7` and
  `render-stream.6`, and prefers /7 when a client offers both. Each connection speaks the version
  it chose. Its magic, its session's `protocol` and `publication.credit_window`, and the hello it
  must send all follow that choice. One published snapshot per frame still serves every
  connection, and every record after the session is byte-identical between /6 and /7
  (`rs_live_test`: seq 1 is the same bytes on both).
- **The /7 hello.** On a `bearer` session the /7 upgrade is not bearer-checked. Instead the
  hello's `token` is compared in constant time. A null or wrong token gets `error`
  `unauthorized`, then close 1008 with reason `unauthorized`, and nothing else is ever sent. The
  host grants `min(credit_window, GRC_LIVE_CREDIT_WINDOW_MAX, 1)`, because window 2 is G7q's. A
  /6 upgrade still needs `Authorization: Bearer`, and so do resource GETs at both versions.
- **Origin and CORS.** `GRC_LIVE_ALLOWED_ORIGINS` is parsed at arm. An entry that is not exactly
  `scheme://host:port` refuses the listener (`origin-config-invalid`). A request whose `Origin`
  is not in the list gets 403 on the upgrade, on GET and on `OPTIONS`, before any other check.
  The 403 is logged to `stdout.log` as `live: 403 origin <origin> <method> <route>` and counted
  in `live-summary.json`'s `resources.origin_rejected`. For an allowed origin, every resource
  response adds `Access-Control-Allow-Origin` and `Vary: Origin`. An `OPTIONS` preflight answers
  204 for any hash, with no bearer check and no `Content-Length`. It is logged as an `http-get`
  hook-log line ending in `"method":"OPTIONS"`, its only new key, and counted as `preflights`. A
  request without `Origin` is exactly /6.
- **Evidence.** `live.json` gains `allowed_origins`, `credit_window_max` and
  `listener_sabotage`. Each `live-summary.json` connection gains `version`, `receiver_kind`,
  `credit_window` (the grant) and `credit_window_requested`, `manifest_sha256`, the five
  presentation integers, `origin`, `token_ok` and `preflights`. The live log's `open` line gains
  `version` and `origin`. The /7 `hello` line carries every hello key except `token`, plus
  `token_ok`. Preflights get their own `preflight` event line.
- **Sabotages** (`GRC_SABOTAGE`): `no-cors`, `accept-any-origin` and `token-ignored`. They act
  on the listener only, so the session declares `sabotage: null` and `live.json` names them.
  Putting them in the session's sabotage enum would have changed /6's wire.

**Refused**: a /7 hello on a /6 connection and the reverse (`protocol`, 1002); `credit_window`
outside 1..2 (`protocol`); an invalid `GRC_LIVE_ALLOWED_ORIGINS` entry or
`GRC_LIVE_CREDIT_WINDOW_MAX` outside 1..2 (the listener refuses at arm); `token-ignored` without
`GRC_LIVE_AUTH=token`; and any listener sabotage without `GRC_LIVE_LISTEN`. **Not done here**:
window-2 behaviour (G7q, fork F1); the receivers' /7 hello and browser live legs, including
`g7-2`'s `origin-refused` and `sabotage-no-cors` (G7l). The receivers still speak /6.

**Tests.**

- **ctests, 20/20.** `rs_ws_test` adds 5 G7n tests (260 checks in all). They cover the
  subprotocol choice, the /7 upgrade without a bearer header while /6 keeps it, 403 and
  `OriginRejected` on all three routes with exact origin matching, CORS on allowed GETs (200, 404
  and 401), the exact 204 preflight for a servable, unknown and malformed hash, both sabotage
  switches, and `parse_allowed_origins` (3 valid and 16 invalid forms). `rs_live_test` adds 3
  hub tests (333 checks in all). They cover /6 and /7 on one hub, the cross-version hello errors,
  window 3, null, wrong and right tokens, `token-ignored`, a /6 connection on a bearer session,
  and preflight attribution with its log lines. `rs_resource_log_test` checks the preflight
  line.
- **Interop.** `self-test-rs-ws.ts` drives the new `test/rs-ws-g7n.ts` against
  `capture/build/rs_live_host`, a new test-only host that wires the production `rs_ws` and
  `rs_live` around a fixed scene. It checks the following:
  - /6 and /7 on one listener at once. Each stream validates as its own version with
    `validateRecording` and ends with its end record. The /7 session declares window 1 for a hello
    asking 2 under `GRC_LIVE_CREDIT_WINDOW_MAX=2`.
  - The exact preflight headers.
  - 403 on all three routes for a foreign origin.
  - `unauthorized` close 1008 with its reason, for a wrong token and for a null one.
  - The host's log and summary.

  Every listener sabotage fails exactly its predicted checks:

  | Sabotage | Fails exactly |
  | --- | --- |
  | `token-ignored` | `token-wrong`, `token-null` (both connect), `summary-token` |
  | `accept-any-origin` | the three `origin-403-*` checks, `origin-403-logged` |
  | `no-cors` | `cors-get`, `preflight-exact` |

  `run-rs-ws-interop.sh` passes: Node, `ws_selftest.gd` and `http_selftest.gd`.
- **Real capture.** `self-test-rs-ws.ts --capture` runs the same checks against the capture
  library in a headless 4.5.1 release template on `fixtures/gate1`. It adds `live-json`,
  `wire-no-sabotage` and `preflight-hooklog`, so it covers `entry.cpp`'s wiring: the environment
  variables, the listener sabotages via `GRC_SABOTAGE`, the token written to `evidence/live-token`,
  and the hook log's preflight line, which `validateResourceLine` now accepts. All 31 checks
  pass, and so do the three sabotage sets. `self-test-gate2` adds two `validateResourceLine`
  cases (408/408).
- **Codecs**: `golden-2/` to `golden-7/` `make_golden.py --check`, `self-test-rs2.ts` and
  `codec2_selftest.gd` all pass.

**Gates, natively on /6** (the committed build, 20/20 ctests; gate 0 was made as `g7-0`'s
source run). Every gate also passed once before, with the same counts and no rerun
(`artifacts/render-stream/g7n/{gate-minus1,gate1,gate2,gate7}/`). That earlier build differed
only in the wording of one refusal message, the one for a listener sabotage whose listener had
refused:

| Gate | Result | Evidence (ignored) |
| --- | --- | --- |
| −1 | PASS 29/29, 79 hooks planned | `artifacts/render-stream/g7n/r2/gate-minus1/` |
| 0 | PASS 24/24 | `artifacts/render-stream/g7n/r2/gate7/sources-made/gate0/` |
| 1 | PASS 66/66 | `artifacts/render-stream/g7n/r2/gate1/` |
| 2 | PASS 85/85 | `artifacts/render-stream/g7n/r2/gate2/` |
| 6, `--legs g6a,g6l,g6c` | 94/95 for the groups run, then g6l rerun 22/22: PASS after one rerun (below) | `artifacts/render-stream/g7n/r2/gate6/`, `…/r2/gate6-g6l-rerun/` |
| 7, `--legs g7-0 --make-sources` | gate_passed true: G7h harness 7/7, g7-0@web 22/22 (P-W1 25/25 shots identical) | `artifacts/render-stream/g7n/r2/gate7/` |

**Gate 6 rerun.** The first run failed exactly one check, `motion-monotonic`, which is a listed load-sensitive check. On `live-scene-warm`, one host-frame gap of 3 (frames 541 → 544) fell where the receiver had held the earlier transaction for only 14.7 ms. Every g6c timing check passed in that run (`host-unperturbed`, `rate-achieved`, `dual-independent`). The rerun of `--legs g6l` passed all 22 g6l checks. The overall verdicts read FAIL 94/99 and 22/28 only because of the `group-*` checks for groups not requested. G7n changes no pacing or credit code, only the per-connection version, the hello and the HTTP checks.

All 35 `scripts/test/self-test-*.ts` pass (`artifacts/render-stream/g7n/selftests/`).
`self-test-record-digest` needs the G7x bench inputs, and was run against G7d's
`g7d-r1/g7-bench/inputs/inputs.json`. The capture interop passes 31/31 on the committed build
(`artifacts/render-stream/g7n/r2/capture-interop/`). The refusal paths were run on the real
capture too (`artifacts/render-stream/g7n/refusals/`): `token-ignored` without auth, `no-cors`
without a listener, an origin with a trailing slash, and `GRC_LIVE_CREDIT_WINDOW_MAX=3`. Each
refuses with its reason.

### What G7n does not prove

- That a browser can use the listener. No browser connected in this increment: Node's raw
  `http` sent every `Origin`-carrying request, and Node's `WebSocket` sends no `Origin` at all.
  Chromium's real preflight, its preflight cache and a page's `WebSocket` from an allowed origin
  are G7l's live legs.
- Window 2. The key is parsed and the grant is recorded, but the host never holds two
  transactions in flight (G7q, fork F1).
- Any device result. G7n changes `rs_ws` and `rs_live`, which marks the phones' recorded device
  results stale under D28. No device leg runs before G7v, so nothing is re-run here.

