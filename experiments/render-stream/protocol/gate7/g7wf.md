### G7wf — the web export's payload GETs through the browser's `fetch` (opus, rs-increment agent)

- **Why.** G7r measured each payload GET in the web export at 66 ms (four main-loop iterations),
  against 16.6 ms natively and 1.6 ms for GSW's `fetch`. Godot's web `HTTPClient` resolves each
  of its states (request, headers, every body chunk, done) on a later iteration, however fast the
  link is. That caps the web export near 45/s and fails `rate-achieved` at 15/s and 30/s (typed
  by `fetchTailCause`, still gating, D1). G7v needs the web export's rates without that tail.
- **Mechanism (decided here, delegated).** `JavaScriptBridge` in the shared GDScript shell
  (`rs_resource_fetcher.gd`), not an `EM_JS` fetch in the Rust side module. Transport is glue,
  as on GSW, where the fetch is TypeScript beside the Rust core. One shell fetcher serves both web
  cores, and nothing new crosses the capi. An `EM_JS` import in a Rust `wasm32-unknown-emscripten`
  side module needs hand-made `__em_js__` exports for the dylink loader and a wasm-to-JS
  completion callback on the pinned nightly. It would save no copy (see below), and it would
  move transport into the core on the web only.
- **The request.** It is the one `HTTPClientWeb` made (`hcw.cpp:82-106`, D3):
  - `GET http://<ws host>:<ws port><http_path><hash>`, with an IPv6 literal bracketed;
  - `Authorization: Bearer <token>` only when the session has a token, so a token-less GET stays
    a CORS simple request, never preflighted;
  - default credentials and cache mode, so the web's `http-cache` mode is unchanged.

  Routes, pins, retirement, 404, stale and refetch-after-evict handling, the timeout, the injected
  delay and the `wrong-http-token` sabotage are all `RsResourceFetcher`'s, unchanged. Hash
  verification and decode stay in `RsResourceCache.add_fetched` before use (D31, G7o2's
  "verify on arrival" unchanged). Only the transport differs.
- **Completion.** A page helper (`window.__rsFetch.start`, defined once by
  `JavaScriptBridge.eval`) starts the GET and returns its `AbortController`. Its promise callback
  (`JavaScriptBridge.create_callback`) runs between frames. It records `end_us` at the body's
  arrival and issues the next queued GET at once, so a multi-miss transaction's GETs chain
  without waiting a frame each. `poll()` only enforces the timeout and the delay. A cancel or
  failure aborts the request in flight and bumps a generation, so a late callback is ignored.
- **Copies.** The body crosses once, from the response's `ArrayBuffer` into one `PackedByteArray`
  (`JavaScriptBridge.js_buffer_to_packed_byte_array`, one `HEAPU8.set`). `HTTPClientWeb` copied
  each chunk into the heap and then appended it to the receiver's buffer (two copies). From the
  `PackedByteArray` on, the path is the native one: copy-on-write into the cache, then the core's
  own `provide` copy. Fetching straight into a core-owned buffer would need the side-module fetch
  rejected above, and would remove one memcpy of a payload that is usually under 4 KB.
- **Files.**
  - `receiver/rs_resource_fetcher.gd`: the `web_fetch` path (`_web_helper`, `_web_issue`,
    `_web_abort`, `_on_web_done`). The native `HTTPClient` path is byte-for-byte unchanged.
  - `receiver/receiver.gd`: `RS_RECEIVER_WEB_FETCH` (`fetch`, the web default, or `httpclient`,
    the pre-G7wf path kept for the A/B; a usage error natively); applied.json `live.fetch_impl`
    on the web only; a fetch entry's `browser` timing on the browser path only. A native
    receiver's applied.json gains no key.
  - Harness: `run-gate7.sh --web-fetch fetch|httpclient` passes `GATE7_WEB_FETCH` to the browser
    daemon. `webFetchOf` and `coreEnv` in `lib/gate7-live-legs.ts` add
    `RS_RECEIVER_WEB_FETCH=httpclient` on the A/B arm only. `check-gate7.ts --web-fetch` passes
    the expected mechanism to `checkGateLive` and `checkG7rKind`.
- **Checks.**
  - **New `fetch-impl@web`**, on every live web group and on `g7-r@web`. Every live web leg's
    applied.json `live.fetch_impl` must be the requested mechanism (`browser-fetch` by default).
  - **The A/B sabotage.** An `--web-fetch httpclient` run judged as `fetch` must fail
    `fetch-impl@web`. Judged as `httpclient`, it must reproduce G7r's tail.
  - **Every other live web check unchanged.** `http-gets-match-fetches`, `fetch-before-applied`,
    the warm `http-cache` rules, the token and CORS sabotages, pins and unpin, drop-resource and
    wrong-hash all run through the new transport.
  - **G7r's `rate-achieved` at 15/s and 30/s must pass on the web.**
- **Re-runs (scoped).**
  - The pure self-tests.
  - `g7-1`, `g7-2`, `g7-5`, `g7-55` and `g7-6` live, plus `g7-r`, on the web under both cores,
    because the fetcher is in the shared shell.
  - Native gate 2 (its live g2c/g2e) and g5f/g55f under both cores, because `receiver.gd` and
    `rs_resource_fetcher.gd` are shared files.

  Out of scope: GSW (G7r's numbers are the comparator), native gates 0, 1, 3, 4 and 6, the web
  file groups (`rs_io.gd` and the file path are untouched), `rs-core`/capi (untouched), and the
  phones (G7v).
- **As built (2026-10-18; [results/gate7/g7wf.md](../../results/gate7/g7wf.md)).** As designed.
  - GETs: 66.2/66.7 → 2.8/4.5 ms p50/p95 on the Rust core, and 2.4/3.2 ms on the GDScript core.
  - `g7-r@web`: 79/79 on both cores.
  - The live groups pass on the Rust core. The GDScript core keeps g7-5's five known
    `web-index-region-update` failures, and its `g7-6` passed on the one allowed rerun of the
    load-sensitive `motion-monotonic`.
  - The A/B arm reproduces G7r's two typed failures, and judged as `fetch` it fails
    `fetch-impl@web`.
