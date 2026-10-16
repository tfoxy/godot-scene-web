### G7n — capture: /7 listener, hello token, origin, CORS (opus)

- **Files**: `capture/src/rs_ws.{h,cpp}` (subprotocol choice, `OPTIONS`, CORS headers, `Origin`
  allowlist, `OriginRejected`); `rs_live.{h,cpp}` (per-connection version, /7 hello, `unauthorized`,
  window grant capped at 1); `entry.cpp` (`GRC_LIVE_ALLOWED_ORIGINS`,
  `GRC_LIVE_CREDIT_WINDOW_MAX`, sabotages `no-cors`, `accept-any-origin`, `token-ignored`); ctests;
  `self-test-rs-ws.ts` interop (Node's raw `http` for `Origin`, preflight and the /7 hello);
  `GS_STRIP_VARS` in every runner.
- **Checks**: the ctests; the interop tests (/6 and /7 on one listener at once; preflight headers
  exact; 403 for a foreign origin on all three routes; `unauthorized` close 1008 with its reason);
  gates 1, 2 and 6 (`g6l`, `g6c`) natively on /6 unchanged.
- **Sabotages**: `token-ignored` must make the interop test's wrong-token case connect (and its
  check fail); `accept-any-origin` must fail the 403 case.
- *As built (2026-10-15):* landed. The decisions the text left open (subprotocol order, the 403
  before every other check, CORS on every resource response, a 204 preflight with no
  `Content-Length`, listener sabotages kept off the wire) are in render-stream-7.md "As built
  (G7n)", and the runs in the README's "Gate 7n result".

