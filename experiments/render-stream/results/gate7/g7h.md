## Gate 7h result (2026-10-14)

G7h ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7h") passes. It lands the browser
harness, the provenance guard and the eight Q1b/Q6 probes gate 7 relies on, before any later
increment (G7e, G7a, …) launches a browser through it. New files:
`scripts/lib/browser-harness.ts` (launch, `HarnessServer`, `checkBrowserProvenance`,
`SuspensionController`), `scripts/lib/browser-probes/index.html` (the minimal WebGL 2 probe page),
`scripts/test/self-test-browser-harness.ts` (runs every probe and check against a REAL launch, not
a synthetic fixture), `scripts/run-gate7.sh` and `scripts/check-gate7.ts` (skeletons: argument
parsing and the final leg-group vocabulary, zero `g7-*` groups landed), and `package.json`'s
`render-stream:gate7`.

`mise exec -- pnpm render-stream:gate7` passes **7/7** G7h checks on a real launch, evidence at
`artifacts/render-stream/gate7/20261015T002407Z/` (gitignored; `g7h-probes/evidence/probes.json`
is the probe record, `result.json` the checker's report):

| Check | Result |
| --- | --- |
| `browser-provenance` | PASS — `ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX 2060), NVIDIA)`, binary sha256 `adc1c21c…fe05c6f` matches chromium-1223/148.0.7778.96 |
| `wayland-fd-zero` | PASS — 0 Wayland fds across 6 Chromium processes (browser, GPU, network, storage, renderer ×2) |
| `probe-rect-exact-readback` | PASS — 4 sampled px exactly equal the drawn RGBA |
| `compositor-equals-readback` | PASS — CDP screenshot vs `readPixels`, max channel delta 0 over 65 536 px |
| `evidence-put-outside-nonce-rejected` | PASS — unknown nonce → 403; `..`-escaping path → 404 (see Finding 4); no file escaped |
| `evidence-put-allowed-nonce-accepted` | PASS — 200, proving the rejection above is a real guard |
| `sabotage-swiftshader-refused` | PASS — `--use-angle=swiftshader` renderer string correctly refused |

**Probe results** (`probes.json`; probes 2–6 are recorded findings, not pass/fail, exactly as the
contract specifies):

1. **Renderer and extensions (D9).** `ANGLE (NVIDIA, Vulkan 1.4.329 …)`; 29 WebGL2 extensions
   including `EXT_disjoint_timer_query_webgl2` (probe 7: **available**).
2. **rAF rate when visible.** Settles at **60 Hz** after a compositor warm-up of roughly 0.5 s
   (the first ~400 ms after `goto` delivers as few as 2–9 callbacks; a clean post-warm-up window
   reads 60–61 over 2 000 ms consistently across runs).
3. **Which Q1b mechanism hides a headless=new page.** **None of the three.**
   `Target.activateTarget` on an auxiliary page/target, `Browser.setWindowBounds` with
   `windowState: "minimized"`, and `Emulation.setFocusEmulationEnabled(false)` all return success
   but leave `document.visibilityState` at `"visible"` and rAF running at the full rate. See
   Finding 1 below.
4. **`Page.setWebLifecycleState("frozen")`.** Also **no effect**: rAF and a `setInterval` both
   kept running at their normal rate through a 1.2 s frozen window (confirmed with a purely
   passive measurement — the page pushes its own counters to `console.log` so no DevTools
   round-trip is needed to observe them), no `visibilitychange` fired, and no `Page.lifecycleEvent`
   named `frozen`/`resume` was ever emitted. The WebSocket opened before the freeze call stayed
   `OPEN` throughout (the one half of this probe that holds, trivially, since nothing paused).
5. **Preflight caching and its lifetime.** Confirmed via an isolated minimal-server probe (see
   Finding 3): one preflight per (origin, URL) per browser **process**, reused for a same-page
   repeat and across a same-process `page.reload()`, and a **fresh** browser process issues a new
   preflight. Not cleanly reproducible inside the full combined probe sequence — see Finding 3.
6. **HTTP-cache reuse for `Authorization` + `private, max-age` GETs.** Same pattern as probe 5 and
   the same caveat: confirmed in isolation (a cold fetch costs one GET, a warm repeat and a
   same-process reload cost zero, a fresh process costs one more), noisy inside the full sequence.
7. **`EXT_disjoint_timer_query_webgl2`.** Available under D9's flags (folded into probe 1's result).
8. **`compositor-equals-readback`.** Exact — see the check table above.

### Findings

1. **headless=new has no page-occlusion model on this Chromium build (148.0.7778.96) — a load-
   bearing contradiction of D14's "a hidden document gets no rAF callbacks" and "a frozen document
   runs no tasks" predictions.** Every CDP mechanism this contract names (Q1b's three hide
   candidates, plus `Page.setWebLifecycleState("frozen")` itself, which D14 cites directly) was
   tried, repeatedly, through `SuspensionController`, and NONE changes `document.visibilityState`
   or throttles rAF/timers. This was cross-checked three ways before being recorded: (a) through
   the harness's own CDP calls, (b) with `Page.setLifecycleEventsEnabled(true)` confirming no
   `frozen`/`resume` lifecycle event is ever emitted, and (c) with a fully passive page that
   reports its own counters via `console.log` on a timer, so no `Runtime.evaluate` round-trip from
   Node could itself be "waking" the page. **Consequence for later increments:** G7u (suspension
   and lifecycle) cannot exercise D14's hidden/frozen legs through any CDP override on this
   Chromium build and this sandbox — it needs either a different mechanism (a real display; an
   older/different Chromium release; or accepting `unavailable` for the hidden/frozen legs under
   headless=new and testing D14's actual claims some other way, e.g. unit-testing Godot's own
   `wm.cpp` gap-reset logic without a browser at all) or the user's sign-off to narrow D14's scope
   for headless. `SuspensionController.hideViaActivateAuxiliary/hideViaMinimize/hideViaFocusEmulation`
   and `.freeze()` are still implemented (later increments need a controller to call), and each
   returns a measured `tookEffect` rather than assuming the CDP call's own success.
2. **`Browser.process()` is `undefined` on this `@playwright/test` (1.60.0).** Despite older
   Playwright documentation, `typeof browser.process === "undefined"` here, so there is no OS pid
   to walk a `ps` process tree from after a launch. `collectChromiumProcesses` uses CDP
   `SystemInfo.getProcessInfo` instead, over a dedicated `browser.newBrowserCDPSession()` (detached
   immediately after) — the authoritative, documented source for every Chromium process's type and
   pid (browser, GPU, renderer, `network.mojom.NetworkService`, `storage.mojom.StorageService`).
   Sending that command on a page-scoped session instead throws `"only supported on the browser
   target"` **and was observed to leave that session unable to close cleanly afterwards** —
   `browser.close()` hung until an external timeout. Always use the correctly scoped session for a
   browser-only CDP domain.
3. **Probe 5/6's hit counts are clean in isolation, confounded inside the full probe sequence.** A
   minimal reproduction (two sequential `launchHarnessBrowser()` processes, a plain `node:http`
   resource server, no other probes run first) shows exactly the predicted pattern: browser A's
   first fetch costs 1 GET + 1 OPTIONS, its second costs 0, a reload costs 0, and a **second,
   fresh** browser process's first fetch costs 1 more of each. Inside
   `self-test-browser-harness.ts`'s full sequence (after probes 1–4 have exercised the suspension
   controller and the WebSocket on the same browser/page), the measured counts are different and
   repeatable in their own way: the very first fetch costs 2 of each instead of 1, and the
   fresh-process phase shows **zero** new hits (stuck at the same count as the reload phase). A
   400 ms settle delay before each read did not change this, ruling out a simple late-arriving-
   request race; the cause was not isolated further given the time this already cost. The
   QUALITATIVE prediction (preflight and HTTP cache persist within a process and across reload; a
   fresh process redoes both) is demonstrated true; the exact per-fetch hit attribution inside the
   combined harness is not trustworthy and is recorded as such in `probes.json`'s
   `probe5_6_same_process` / `probe5_6_fresh_process` fields rather than hidden behind a clean-
   looking boolean. **Consequence:** if G7l needs an exact preflight/cache COUNT (rather than the
   qualitative behaviour), it should measure with a dedicated, isolated probe rather than reusing
   this harness's combined sequence numbers.
4. **The evidence-PUT traversal guard in `HarnessServer.handlePut` is unreachable through normal
   HTTP/`fetch()` use.** A `..`-escaping path (`/evidence/selftest/../../../escaped.json`) never
   reaches it as a literal `..`: both `fetch()`'s URL parser (client) and Node's `new URL()`
   (server) apply the same WHATWG URL normalization, collapsing `.`/`..` segments out of the
   pathname before either side ever sees one. The request arrives as `/escaped.json`, matches no
   route, and gets the generic 404 — which is a safe outcome (nothing is written outside the leg
   directory) but not the guard's own 403. The guard is kept as defense in depth for a caller that
   bypasses URL normalization (a raw socket write); the check this increment ships for "an evidence
   PUT outside the leg nonce rejected" asserts the SAFETY PROPERTY (status ≠ 200, and no file lands
   outside the evidence tree) rather than one fixed status code.
5. **An attached CDP session on an auxiliary page must be detached before closing that page.**
   Found while implementing `hideViaActivateAuxiliary`'s repeated open/close cycle; `auxSession` is
   now explicitly `.detach()`ed first.

### Deviations

- Q6's "Samplers" bullet (`/proc` RSS, `Performance.getMetrics`, `nvidia-smi`, 1 Hz) is not
  implemented here — it is D16/G7k's own deliverable (startup, memory, soak), and no probe in this
  increment's list needs it.
- `run-gate7.sh` and `check-gate7.ts` are genuinely minimal skeletons: they parse every flag the
  contract lists (`--source`, `--make-sources`, `--legs`, `--out`) and know the final `g7-*`
  vocabulary, but refuse every `g7-*` leg (none have landed) and always run G7h's own harness
  self-test regardless of `--legs`, since that self-test is not itself one of the `g7-*` groups.

### What G7h does not prove

- Any `g7-*` gate leg (G7a onward), the web export (G7e; the 4.5.1 web template is not installed,
  fork F2), the GSW canvas receiver, live legs, or anything about rates, startup or memory.
- Suspension and lifecycle beyond the probes above: the hidden/frozen leg's actual CONTENT (bounded
  pending state, newest-state-on-resume) is G7u's to measure, and Finding 1 means it cannot rely on
  CDP to produce a genuinely hidden/frozen page on this build.
- Firefox, WebKit, or any Chromium other than the pinned chromium-1223 build.
