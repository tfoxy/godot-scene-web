## Gate 7wf result (2026-10-18)

G7wf ([protocol/gate7/g7wf.md](../../protocol/gate7/g7wf.md); gate7-design.md Q4, D3, D31)
moves the web export's resource-payload GETs off Godot's web `HTTPClient` and onto the browser's
own `fetch()`. G7r measured each `HTTPClient` GET at 66 ms, four main-loop iterations, and that
tail capped the web export near 45/s.

**The web export now passes every gating check of `g7-r`: 79/79 on the Rust core (G7r: 76/78).**
`rate-achieved` at 15/s and 30/s passes, at 15.00/s and 30.00/s. The extra check is the new
`fetch-impl@web`.

- **Payload GET latency.** p50/p95 is 2.8/4.5 ms, down from 66.2/66.7 ms. GSW's is 1.5/2.3 ms.
  These are the rate-15/30/60 and phase-60 legs, pooled, about 1 550 GETs per arm.
- **Good-phase runs now publish 58.4–59.0/s, like GSW**, where they published about 45/s before.
  The web export now shows the same phase lock as the other receivers: one run of five locked
  bad (29.3/s) and one landed `between` (47.5/s).
- **The live groups pass on the Rust core**: g7-1 40/40, g7-2 37/37, g7-5 21/21, g7-55 21/21 and
  g7-6 27/27. Each count is G7r's plus `fetch-impl@web`. The web export's g5f and g6l credit
  tails, which G7l and G7xwl measured but left unattributed, mostly go away: g6l's RTT p95 drops
  from 5–10 frames to 2.
- **The A/B and sabotage arm** (`--web-fetch httpclient`, same build) reproduces G7r: 77/79,
  with the same two typed `rate-achieved` failures at 66.2 ms per GET. Judged as `fetch`, it
  fails `fetch-impl@web` on all 18 receivers.

**Mechanism decision (delegated): `JavaScriptBridge` in the shared GDScript shell, not an
`EM_JS` fetch in the Rust side module.** Transport is host glue, as on GSW (TypeScript `fetch`
beside the Rust core). Both web cores get it, nothing new crosses the capi, and the side-module
route would save no copy. The reasons are in protocol/gate7/g7wf.md.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-r --receiver web \
  --web-core rust --bundle <build-web-receiver.sh --core rust bundle> --skip-harness-selftest \
  --out artifacts/render-stream/gate7/g7wf/r-fetch
# the A/B's pre-G7wf arm on the same build: add --web-fetch httpclient (out r-httpclient)
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-1,g7-2,g7-5,g7-55,g7-6 \
  --receiver web --web-core rust --bundle <…> --skip-harness-selftest --out …/g7wf/live-rs
```

Box: Ryzen 5 5500, RTX 2060, gamescope headless, headless Chromium (`--headless=new`), the
same as G7r. `pgrep -c dosbox-x` read 0 at every check. Load came only from this increment's
own runners and, until it landed, G7hp's. No quiet-lock summary of any run here has a
`nested-unisolated` hold or a lock error.

### What was built

- **`rs_resource_fetcher.gd`, the `web_fetch` path.** It keeps the same queue, timeout, delay,
  results and error rules as the `HTTPClient` path. A page helper, defined once with
  `JavaScriptBridge.eval` as `window.__rsFetch.start(url, token, gen, done)`, issues the GET that
  `HTTPClientWeb` issued:
  - the same URL;
  - `Authorization: Bearer` only with a token (D3), so a token-less GET is never preflighted;
  - default credentials and cache mode.

  The promise's completion calls back into GDScript (`JavaScriptBridge.create_callback`). That
  happens between frames: the callback records `end_us` and issues the next queued GET at once.
  A cancel, a timeout or a failure aborts the request in flight through its `AbortController`
  and bumps a generation, so a late callback is ignored. The native `HTTPClient` path is
  unchanged.
- **Copies.** The body crosses once, from the response's `ArrayBuffer` into one
  `PackedByteArray` (`JavaScriptBridge.js_buffer_to_packed_byte_array`, one `HEAPU8.set`).
  `HTTPClientWeb` copied each chunk into the heap and then appended it. Verification and decode
  are unchanged: `RsResourceCache.add_fetched` before use (D31, G7o2's verify on arrival), then
  `rs-core-capi`'s `provide` copy on the Rust core. The payloads here have a median of 0.5 KB
  (gate 6 scene) and 1.1 KB (gate 2), so the remaining memcpy is not worth a side-module fetch.
- **Evidence.** On the web, applied.json `live.fetch_impl` is `browser-fetch` or `httpclient`. On
  the browser path, each `fetches[]` entry gains `browser`, the page clock's view in ms after the
  `fetch()` call: `headers_ms`, `body_ms` and `callback_ms`. It also gains `process_frames`, the
  main-loop iterations completed between the call and the callback. A native receiver's
  applied.json gains no key (gate 2 and g5f/g55f re-ran natively, below).
- **Config.** `RS_RECEIVER_WEB_FETCH` is web only, and a usage error natively. It is `fetch`, the
  default, or `httpclient`, the pre-G7wf path kept for the A/B.
- **Harness.**
  - `run-gate7.sh --web-fetch fetch|httpclient` sets `GATE7_WEB_FETCH`.
  - `webFetchOf` and `coreEnv` (`lib/gate7-live-legs.ts`) add `RS_RECEIVER_WEB_FETCH=httpclient`
    on the A/B arm only.
  - `check-gate7.ts --web-fetch` adds `fetch-impl@web`, to `checkGateLive` and to
    `checkG7rKind`.
- **`self-test-gate7l.ts` section 9** covers `webFetchOf`/`coreEnv` and `fetchImplProblems`:
  pass, the other mechanism, a pre-G7wf report, and no `live` object.

### Payload GET latency, before and after (desktop, G7r's legs)

GETs pooled over rate-15, rate-30, rate-60, phase-60-r1..r5 and phase-60-late-poll-r1..r5, in
ms. Per leg, p50 is 2.6–3.0 ms after and 66.1–66.2 ms before.

| Arm | GETs | p50 | p95 |
| --- | --- | --- | --- |
| G7r `r3` (main, `HTTPClient`) | 1 593 | 66.2 | 66.7 |
| `r-httpclient` (this build, `--web-fetch httpclient`) | 1 552 | 66.2 | 66.7 |
| **`r-fetch` (this build, browser `fetch`)** | 1 583 | **2.8** | **4.5** |
| `r-fetch-gd` (this build, browser `fetch`, gdscript core) | 1 583 | 2.4 | 3.2 |
| GSW (G7r `r3`, same legs) | 1 006 | 1.5 | 2.3 |

- **Where the 2.8 ms goes, on the page clock (`browser`, p50/p95).** The response arrives at 2.3
  ms (p95 3.6) and the whole body at 2.7 ms (p95 4.2). The callback runs within 0.1 ms of that.
  The GET is issued from `_process`, and its promise can run only once the page's main thread is
  free: after whatever that task still does once the GET is issued. GSW issues its GET from a
  near-empty rAF callback and keeps 1.3 ms over the web export. The GDScript core's GETs are
  0.4 ms faster than the Rust core's (2.4 ms), although its iteration is longer. So what counts
  is the work left after the issue point, not the length of the whole iteration. That split was
  not separately profiled.
- **All but 14 of 1 583 GETs complete before the next iteration.** `process_frames` was 1 for
  1 358 GETs and 0 for 211: those 211 are a multi-miss transaction's chained GETs, issued and
  completed between two iterations. It was 2–3 for 14. So a fetching transaction is applied one
  iteration after the one that issued its GET, where before it was four. The web's phase-run
  hold p95 falls from 68.4–69.2 ms to 18.3–19.3 ms, one frame, the same as native's.
- **`constrained`** (4 Mbit/s, preflighted bearer GETs): 124.4/263.9 ms, against 182.9/316.4 ms
  before and GSW's 123.8/255.4. That leg is bound by the link and the preflight, so the web export
  now pays only what GSW pays.
- **`mismatch-60-recv30`** (receiver `--max-fps 30`): 99.1/100.1 ms, against 132.5/133.5 ms
  before. The response lands at 32.4 ms and the body at 98.8 ms, one and three 30 fps iterations.
  `web_main.cpp`'s frame limiter waits in `OS::add_frame_delay` → `delay_usec` on the page's own
  thread (nothreads build), so promise tasks run only between iterations. This is inferred from
  the source and fits the timings, but no probe isolated it. It is also the most likely cause of
  G7r's unattributed 50.9 ms socket-read median at 30 fps. That leg's published rate is
  dominated by phase, not by the fetch: 10.11/s here, 16.42/s on the `httpclient` arm and 6.84/s
  in G7r's `r3`. It passes on both arms.

### Rates (web export, Rust core; `r-fetch` against the same build's `r-httpclient`)

| Leg | Requested | Published, fetch | Published, `httpclient` | Credit capacity, fetch / `httpclient` | RTT mean, fetch / `httpclient` (frames) |
| --- | --- | --- | --- | --- | --- |
| rate-15 | 15 | **15.00** | 14.16 (fails) | 55.34 / 21.27 | 1.08 / 2.82 |
| rate-30 | 30 | **30.00** | 25.05 (fails) | 57.77 / 38.21 | 1.04 / 1.57 |
| rate-60 | 60 | **58.90** | 41.63 | 58.90 / 41.49 | 1.02 / 1.45 |
| rate-uncapped-host60 | uncapped | 58.48 | 45.21 | 58.48 / 44.97 | 1.03 / 1.33 |
| rate-uncapped (`--max-fps 0` host) | uncapped | 59.16 | 45.37 | 59.16 / 45.02 | rAF-bound (419 / 551) |
| mismatch-60-recv30 | 60 | 10.11 | 16.42 | 10.07 / 16.46 | 5.96 / 3.64 |
| dual-native (A web /7, B native /6) | uncapped | 58.63 / 59.05 | 44.27 / 59.00 | — | 1.02 / 1.36 (A) |
| constrained | 60 | 4.11 | 3.00 | 4.13 / 2.98 | 14.5 / 20.1 |

G7r's `r3` on main published 13.90, 25.21 and 24.53/s at 15, 30 and 60. The `httpclient`
columns are this build's A/B arm, so the two arms differ only in the fetch. Every
`final-latest-state` is within Q7's band with 0 pixels outside it. The counts are G7r's exactly: 220 537 identical,
9 706 `readback`, 157 `delta1`. `dual-independent` passes: A's hold p95 is 18.3 ms, against
rate-uncapped-host60's 19.2.

### The phase study (rate-60 configuration, credit window 1; published/s per run)

| Variant | Runs 1–5 | Good / bad / between (mean RTT) | By median | Hold p50/p95 (ms) |
| --- | --- | --- | --- | --- |
| web, browser fetch | 58.69, **29.32**, 58.42, 47.48, 58.95 | 3 / 1 / 1 | 4 / 1 / 0 | 2.4–2.6 / 18.4–19.3 |
| web + late poll, browser fetch | 58.58, 58.58, 58.84, 59.00, 59.00 | 5 / 0 / 0 | 5 / 0 / 0 | 2.5 / 18.3–19.2 |
| web, `httpclient` (A/B) | 41.95, 41.26, 44.95, 45.00, **26.63** | 0 / 1 / 4 | 4 / 1 / 0 | 2.4 / 68.6–69.1 |
| web + late poll, `httpclient` | 44.05, 43.84, 45.00, 43.42, 45.26 | 0 / 0 / 5 | 5 / 0 / 0 | 2.4 / 68.9–69.1 |
| web, gdscript core, browser fetch | 58.74, **29.58**, **29.90**, **29.95**, 58.79 | 2 / 3 / 0 | 2 / 3 / 0 | 6.4–6.6 / 20.8–21.0 |
| web + late poll, gdscript core, browser fetch | 58.48, 56.74, **29.48**, 57.53, **29.58** | 3 / 2 / 0 | 3 / 2 / 0 | 6.3–6.6 / 20.7–21.1 |
| GSW (G7r `r1`+`r2`, ten runs; code unchanged since) | 58.4, 58.8, 58.2, 59.0, 58.6 / 59.1, 59.0, 59.1, 59.0, 59.0 | 10 / 0 / 0 | 10 / 0 / 0 | phase φ 2.1–13.3 / 18.6–29.9 |

- **The web's good phase is now GSW's.** Good runs publish 58.4–59.0/s at a mean RTT of
  1.02–1.03 frames, against GSW's 58.2–59.1/s in G7r. Before, the web's good-phase runs sat at
  about 45/s with a mean RTT of 1.34. Q9's mean-RTT class now calls them `good` instead of
  `between`.
- **The phase lock is unchanged, and now visible on the web.** Run 2 locked bad: 29.32/s, mean
  RTT 2.05 frames, median 2. Run 4 drifted (47.48/s, 1.26). Both still pass G6c's bound. That
  matches native's and GSW's G7r pattern. Late poll's 5/5 against plain's 3/5 is within chance
  at a good fraction near 0.8 (G7r finding 3). D4's negative finding stands: no browser variant
  is shown to hold 60/60 on every clock phase.
- **On the GDScript web core, the bad phase is more common: 3 of 5 runs and 2 of 5 with late
  poll.** Its GETs are as fast (2.4/3.2 ms), so this is not the fetch. Its hold p50 is
  6.4–6.6 ms, against the Rust core's 2.5 ms. That is the decode/apply work the frozen core still
  does on the frame, and it is G6c's finding again: native's GDScript core held 5.9–6.4 ms and
  locked bad in 5 of 11 runs. A larger hold leaves less of the frame for the clock phase φ (Q13c).
  Every run still passes G6c's bound, and so do rate-15 and rate-30 (15.00 and 30.00/s, mean RTT
  2.05 and 1.91).
- **GSW was not re-run the same day.** The same-day comparator failed to load: G7r's
  `gsw-bundle-2` had lost its `.wasm` to evidence pruning, and every leg failed
  `WebAssembly.instantiate` on a "not found" body. The run was discarded. GSW's code is unchanged
  since G7r, so G7r's ten-run GSW study is the comparator above.

### The live groups (web, both cores)

| Group | `web`, rust (`live-rs`) | `web`, gdscript (`live-gd`) | G7r `live-regress3` web (rust) |
| --- | --- | --- | --- |
| `g7-1` | 40/40 | 40/40 | 39/39 |
| `g7-2` | 37/37 | 37/37 | 36/36 |
| `g7-5` | 21/21 | 16/21 (the five known `web-index-region-update`, as G7xwl's 15/20) | 20/20 |
| `g7-55` | 21/21 | 21/21 | 20/20 |
| `g7-6` | 27/27 | 26/27, then 27/27 on the one allowed rerun (`motion-monotonic`, below) | 26/26 |

- **`fetch-impl@web` passes in every group.** That is 36 live legs and 892 GETs on `rust`, none
  through `HTTPClient`. g7-1 has no GETs (inline payloads) and is judged on its `live` objects.
- **Every G2c/G2e rule holds through the new transport.** That covers
  `http-gets-match-fetches`, `fetch-before-applied`, the `http-cache` warm leg, the
  bad-token/no-token/no-cors/origin-refused sabotages, `sabotage-unpin`, drop-resource and the
  live wrong-hash refusal.
- **Credit tails (RTT p95 in frames, per live leg; G7r `live-regress3` → here):**
  - g6l `live-scene` 7 → 2, `live-stall` 9 → 2, `live-scene-warm` 10 → 2, `live-reconnect`
    9/5 → 2/2. g6l's sent/offered is 807/979 on `live-scene` (372/960 before).
  - g5f `live-mesh-warm` 5 → 2, `live-mesh-stall` 6 → 3, `sabotage-mesh-stale-coalesce` 5 → 2.
  - g7-2 `live-animate` and `live-warm` 2 → 1.
  - `live-mesh` itself landed in the bad phase this time: p50 2, 440/750 sent, against 581/747.

  The tail G7xwl left unexplained ("the g5f tail is not GDScript cost") was this fetch.
- **`g7-6` on the GDScript core failed `motion-monotonic@web` once.** That was `live-scene`: two
  3-frame gaps behind receiver holds of 6.5 and 6.6 ms. It is the load-sensitive cadence check
  that G7g also saw fail once on this core, and G7n natively. The run shared the box with another
  agent's gate 2 and gate 5.5 live timing legs. The one allowed rerun (`live-gd-g76-rerun`) passed
  27/27. Its `motion-monotonic` passed with every gap above 2 attributed (50 after a receiver
  shot, 1 after a receiver fetch).
- **The GDScript core's five g7-5 failures** are G7b's typed `web-index-region-update`, named by
  `LIVE_KNOWN_FAILURES`, exactly as in G7xwl. The browser fetch neither fixes nor causes them.

### Native (shared files: `receiver.gd`, `rs_resource_fetcher.gd`)

Native gate 2 (default groups: g2a, g2b, g2c, g2d, g2e) is 85/85 on both `RS_RECEIVER_CORE=rust`
and `gdscript`. Gate 5 `--legs g5c,g5f` is 34/34 on both, and gate 5.5 `--legs g55f` is 15/15 on
both. The runners print FAIL 34/38 and 15/19 only for their `group-*` not-run lines (groups not
asked for). A first gate 5 attempt with `--legs g5f` alone judged nothing, because g5f's checks
need g5c's capture; G7l's `runnerLegs` is `g5c,g5f` for that reason. It was rerun and the attempt
deleted. The native fetch path is unchanged and gains no evidence key.

### Re-runs (scoped)

| What changed | Re-run | Result | Evidence |
| --- | --- | --- | --- |
| everything, merged on G7hp | pure self-tests: G7r's 43-item set (every `self-test-*.ts` but the browser harness's and the bench-input ones, `self-test-quiet.sh`, golden-2…7 `make_golden.py --check`) | 43/43 pass | `pure/` |
| `rs_resource_fetcher.gd` web path, `receiver.gd`, harness and checker | `g7-r` on the web, Rust core | 79/79 gating | `r-fetch/` |
| the same | `g7-r` on the web, Rust core, `--web-fetch httpclient` (A/B and sabotage) | 77/79, the two typed `rate-achieved`; judged as `fetch`: `fetch-impl@web` fails on 18/18 | `r-httpclient/` (`result.json`, `result-sabotage-judged-as-fetch.json`) |
| the same, GDScript web core (the shell is shared) | `g7-r` on the web, gdscript core | 79/79 gating (rate-15/30 pass; 3 of 5 phase runs bad, the core's 6.5 ms hold) | `r-fetch-gd/` |
| the same | `g7-1,g7-2,g7-5,g7-55,g7-6 --live` on the web, rust and gdscript | rust: all gating pass; gdscript: all pass but g7-5's five known, g7-6 after one rerun (see "The live groups") | `live-rs/`, `live-gd/`, `live-gd-g76-rerun/` |
| `receiver.gd`, `rs_resource_fetcher.gd` (shared with native) | native gate 2, gate 5 `g5c,g5f`, gate 5.5 `g55f`, each under `rust` and `gdscript` | 85/85, 34/34, 15/15 on both | `native/` |

Out of scope, and why:

- **GSW's code and its groups.** Nothing under `web/gsw-receiver/` or `rs-core` changed. GSW did
  not run: its G7r numbers are the comparator.
- **Native gates 0, 1, 3, 4 and 6.** They use no live resource fetch, or (gates 1 and 6) a live
  shell whose fetch is `HTTPClient` unchanged and reached by gate 2 and g5f/g55f above.
- **The web export's file groups (g7-0…g7-6 file legs).** `rs_io.gd`'s file-mode fetches still
  use `HTTPClient`, untouched, and the file path never constructs `RsResourceFetcher`.
- **`rs-core`, `rs-core-capi`, the side module.** Untouched, so there is no `cargo test` and no
  `rs-core-check goldens` run.
- **The g31 device arms.** G7v's item 3. A g31 smoke was optional and was not run.

### What G7wf does not prove

- **The phones.** The 2.8 ms here is a desktop number. On the g31 the issuing iteration is
  longer, so the GET waits longer for its promise. G7v measures it.
- **Why GSW keeps 1.3 ms.** It is attributed above to the main-thread work left after the GET
  is issued, from the page-clock breakdown. That was not separately profiled.
- **The 30 fps busy-wait.** It is inferred from `web_main.cpp`/`os.cpp` and the timings, not
  probed.

### Evidence (ignored; `artifacts/render-stream/gate7/g7wf/`)

- `r-fetch/`: the headline `g7-r` web run on the Rust core (`gate6/rates-web/g7r-summary.json`).
- `r-httpclient/`: the same build's `--web-fetch httpclient` arm. `result.json` is judged as
  `httpclient`, and `result-sabotage-judged-as-fetch.json` is the sabotage verdict.
- `r-fetch-gd/`: `g7-r` on the GDScript web core.
- `live-rs/`, `live-gd/`: the five live groups on each web core. `live-gd-g76-rerun/` is the
  GDScript core's single `g7-6` rerun.
- `native/`: gate 2, g5c+g5f and g55f under each core.
- `pure/`: the self-test logs and `summary.txt`.
- The two bundles: `artifacts/render-stream/web-receiver/e2a8bb962986e713/` (rust) and
  `852beb44f43b48db/` (gdscript).

The development runs (`dev-g72`, `dev-g7r`, `pure-dev`, the first g5f-only native attempt) were
deleted.
