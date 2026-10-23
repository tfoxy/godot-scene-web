## Gate 7kr result: the receiver page's renderer RSS (2026-10-23)

G7kh found that `rss-bounded-renderer` sampled the wrong process: the first `renderer` pid
`SystemInfo.getProcessInfo` listed, an idle renderer flat at 70 MB. So every pass of that check
from G7k to G7kh said nothing about the receiver. G7kr makes the sampler find the receiver page's
own renderer and judge it on settled samples. It records every Chromium process per leg, and it
decides the bound per receiver:

- **GSW: gating**, Q10's bound plus 5 KiB per payload GET. That per-GET allowance pays for the
  measurement harness (Playwright turns on CDP's Network domain), not for the receiver or Chromium.
- **Web export: report-only**, typed as a known measured shortfall. Its page renderer grows
  linearly, about 7.4-10.3 MB/min post-GC, against a 2 MiB/min bound. Two causes were found:
  - the engine's GL-id tables, about 1-1.4 MB/min of JS heap;
  - about 5.8 MB/min of PartitionAlloc that no one-factor control explains. It is specific to
    the receiver path.

  The row is `known-shortfall`: never a pass, never gating, never in a sabotage's failure set. The
  follow-up increment **G7kw2** owns it.

Design notes: [protocol/gate7/g7k.md](../../protocol/gate7/g7k.md), "G7kr". Q10:
[gate7-design.md](../../protocol/gate7-design.md), "Soak".

### What changed

- **`scripts/lib/gate7k-samplers.ts`**:
  - **Finding the page's renderer.** The pinned Chromium 1223 has no target-to-pid call when
    headless, so the page proves which renderer is its own. The sampler makes the page touch a
    128 MiB buffer, and the renderer whose RSS rises by at least half of that is the page's. The
    buffer is then dropped and collected.
  - **Per-process records.** Each leg writes `mem-procs.json` (every process with its role:
    `browser`, `GPU`, `page-renderer`, `other-renderer-<pid>`, utility processes) and
    `mem-summary.json`. The summary holds, per role: start, medians at 60-90 s and 330-360 s, end,
    extremes and settled points. `mem-timeline.jsonl` keys `rss_bytes` by role.
  - **Settled samples.** Every 30th tick forces a full GC (`HeapProfiler.collectGarbage`) before
    it reads RSS, and marks that sample `post_gc`.
- **`scripts/lib/gate7k-checks.ts`**:
  - `rss-bounded-renderer` judges the page renderer's post-GC points with `rssRendererBudget`:
    16 MiB / 2 MiB/min, plus `RSS_BYTES_PER_GET` (5 KiB) per payload GET.
  - On the web export the row goes through `asKnownShortfall(…, WEB_RENDERER_RSS_SHORTFALL)`. The
    result has `passed: false`, `gating: false`, `status: "known-shortfall"` and `owner: "G7kw2"`.
    It also carries the measured growth and slope (`measured`), the bound's own verdict, and the
    cause summary. Sabotage failure sets skip known-shortfall rows, as they skip `unavailable` rows.
  - `no-evict` allows `rss-bounded-renderer` on GSW and no longer lists it for the web export.
- **`scripts/test/self-test-gate7k.ts`**: tests for the budget and the shortfall typing (33 pass).

### Per-process RSS (honest `soak-scene`, window 2, final runs)

RSS in MB from `mem-summary.json`, from the final `g7live-<kind>-timing` runs (window 2, real
time). The GSW soak ran 19:14-19:21 and the web soak 19:35-19:41. The 1-min load was about 2.6-3.4
when sampled around them.

| Process | GSW start | GSW 60-90 s | GSW 330-360 s | GSW max | Web start | Web 60-90 s | Web 330-360 s | Web max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **page renderer** | 151.1 | 179.1 | 228.4 | 233.6 | 340.5 | 442.0 | 453.4 | 608.9 |
| other renderer (idle, what G7k-G7kh sampled) | 70.1 | 70.2 | 70.2 | 70.2 | 70.5 | 70.6 | 71.7 | 71.7 |
| other renderer | 102.0 | 102.5 | 109.3 | 109.3 | 102.2 | 102.8 | 109.8 | 109.8 |
| browser | 193.0 | 195.5 | 196.8 | 198.3 | 198.8 | 199.3 | 201.6 | 201.8 |
| GPU | 284.3 | 267.8 | 268.3 | 284.3 | 289.8 | 298.6 | 299.6 | 300.2 |
| network service | 119.9 | 121.9 | 123.2 | 123.7 | 121.0 | 121.4 | 122.0 | 122.1 |
| storage service | 52.6 | 52.6 | 52.6 | 52.6 | 52.2 | 52.2 | 53.4 | 53.5 |

The page renderer's post-GC least-squares slope over [60 s, 360 s], per leg:

| Leg | GSW | Web export |
| --- | --- | --- |
| honest `soak-scene`, window 2 | 11.08 MB/min (178.3 -> 227.5 MB) | 7.79 MB/min (408.9 -> 444.6 MB) |
| honest `soak-scene`, window 1 (`gsw-w1`, 16,535 GETs) | 10.84 MB/min, growth 48.3 MB: **pass** | — |
| `sabotage-soak-no-evict` | 3.55 MB/min | 7.80 MB/min |
| `sabotage-leak-gl-textures` | 10.91 MB/min | — |

GSW's budget at about 16,500 GETs is about 101 MB of growth and about 15 MB/min of slope. The web
export's budget at about 124 GETs would be 17.4 MB and 2.2 MB/min. Its row reports
`known-shortfall` with the measured figures.

### The GSW bound: a harness cost per GET

GSW's page renderer grows linearly: 48.5-51 MB and 10.8-11.1 MB/min over [60 s, 360 s], with
about 16,500 payload GETs. Every control below was read right after a forced GC, which is the
check's own measure. Together they place the growth in the DevTools Network agent's per-request
record. Playwright enables the Network domain on every page it drives:

| Control (pinned Chromium 1223, headless, 6 min) | Renderer growth | Per GET |
| --- | --- | --- |
| bare cross-origin `fetch` loop, 45 GET/s, 375 B bodies, 16,842 GETs (`controls/fetch-p`) | +3.8 MB | 0.23 KB |
| the same loop with `Network.enable` on the page session (`controls/fetch-pw`) | +66 MB (`[anon:v8]` +38.6, PartitionAlloc +18) | 3.9 KB |
| the same, `maxTotalBufferSize=0` (`controls/fetch-pw-nobuf`) | `[anon:v8]` still +38.6 MB | 3.2 KB |
| honest GSW soak, 16,539 GETs (`diag/diag-gsw4`) | 165.5 -> 224.5 MB over 330 s (`[anon:v8]` 6.3 -> 39.1, PA +9.5) | 3.6 KB |

A simulated critical memory-pressure notification reclaims none of it. So the 5 KiB/GET allowance
is the control's 3.9 KB plus about 28%.

The first pass derived about 3.0 KB/GET and called it "Chromium fetch churn". That figure came from
raw RSS with no forced GC, and the second pass superseded it. The GSW JS heap (+1.3 MB) and wasm
heap (+5 MB) stay inside their own bounds, so this growth is not receiver state.

First-pass controls: raw RSS with no forced GC, superseded where they disagree with the table
above.

- A bare-Chromium `fetch` loop grew its renderer 8 MB/min, about 3.0 KB/GET. The second pass's
  post-GC read of the same loop is 0.23 KB/GET bare and 3.9 KB/GET with the Network domain on.
- A no-op loop, a 60 msg/s x 2 KB WebSocket loop and in-page ArrayBuffers stayed flat.
- GSW `no-evict` (131 GETs) grew 15.5 MB, carried by the wasm heap (+11) and the JS heap (+5).

### The web export: what was measured

The web export fetches only about 124 payloads, so the per-GET allowance is about 0.6 MB. Its page
renderer still grows linearly, post-GC:

- **JS heap, about 1-1.4 MB/min: the engine's GL-id tables** (second pass, `diag/diag-web1`, `diag-web2`).
  - Heap snapshots at 60 s and 330 s show `GL.buffers`, `GL.framebuffers`, `GL.textures`,
    `GL.vaos` and `GL.syncs` each growing from 203 KB to 1.55 MB of element storage.
  - The cause is emscripten's `getNewId`: it never reuses ids, and it null-fills each table up to
    `GL.counter`.
  - Godot GLES3 creates GL objects fast: about 490 buffers/s, 247 VAOs/s and 118 fence syncs/s.
    These come from `request_polygon`'s buffer and VAO per re-recorded polygon, and from the
    canvas fence. That is about 20 B per GL object.
  - Reproduced with no stream: a Godot web export re-recording 54 polygons per frame grows its JS
    heap 26 -> 77 MB in 6 min, with or without CDP domains (`controls/godot-busy*`). Its
    PartitionAlloc stays flat.
- **PartitionAlloc, about 5.8-6.3 MB/min: unexplained.** It is linear and a critical
  memory-pressure notification does not reclaim it. The wasm heap's touched pages stay flat.
  - Flat controls (6 min at 60 fps):
    - an idle Godot web export, with and without CDP domains;
    - bare WebGL rAF;
    - WebGL object churn, with and without emscripten-style tables;
    - WebSocket traffic at 60 msg/s x 20 KB, binary or text, with and without the Network domain;
    - a Godot web export doing exactly the receiver's WebSocket pattern (`gws.gd`: 4-36 KB binary
      at 60/s, 3 JSON text acks each).
  - The pages PA made resident during the soak hold serialized CDP `Network.webSocketFrameSent`
    events and transaction-record JSON headers (`diag-web6`). But PA slots keep freed content, so
    that only shows which traffic touched the pages.

**G7kr's time-boxed diagnosis (finisher 2):** one factor per run on the real web `soak-scene` leg,
window 2, at real time. Each read was taken after a forced GC (`HeapProfiler.collectGarbage`). The
slopes are least-squares over [60 s, 360 s]: PartitionAlloc and JS heap from 13 reads at 1, 31,
…, 361 s; the page renderer from the leg's own post-GC series (the check's input).

| Run (`finisher2/diag/<run>`) | Factor off | Soak wall (1-min load) | PA slope | JS heap slope | Page renderer, post-GC |
| --- | --- | --- | --- | --- | --- |
| baseline (second pass, `diag-web3`; no forced GC) | none | — | 6.3 MB/min | — | 8.1 MB/min |
| `nonet` | Playwright's Network domain: `G7KR_DIAG_NONET=1` rewrote all 3 `Network.enable`s on the CDP pipe | 16:47-16:54 (1.5-5.0) | 5.97 MB/min | 1.31 MB/min | 7.42 MB/min (401 -> 433 MB) |
| `noshots` | shots and their MEMFS evidence: `RS_RECEIVER_SHOT_WINDOWS=` | 17:06-17:12 (2.6-5.2) | 5.75 MB/min | 0.81 MB/min | 8.86 MB/min (408 -> 449 MB) |
| `httpclient` | the JavaScriptBridge `fetch()` glue: `--web-fetch httpclient` | 17:34-17:41 (4.8-8.2) | 5.97 MB/min | 1.20 MB/min | 3.20 MB/min least-squares, but +7.7 MB/min (93-303 s, 445 -> 472 MB) before one 63 MB drop at 303-334 s |
| `cap0` | the received-bytes copy into MEMFS: `RS_RECEIVER_RECEIVED_MAX_BYTES=0` | 18:00-18:07 (4.2-12.8) | +4.7 MB/min (61-241 s), then +6.0 MB/min (271-361 s) | 1.10 MB/min | -4.90 MB/min, artifact of the drop |

The two drops (`httpclient`, `cap0`) both came in the two runs at the highest load, while system
swap rose. In `httpclient` the drop was outside PartitionAlloc: diag PA kept climbing, 129 -> 160 MB.
That suggests the kernel reclaimed file-backed pages. Neither drop changes the rate on either side
of it.

`cap0` needs a closer reading. Its least-squares PA slope is -16 MB/min, but that comes from a
single release between 241 s and 271 s: PA fell 181 -> 101 MB and RSS fell 471 -> 393 MB. On either
side of the drop PA climbs at the same rate as every other run.

- The second pass's `diag-web5` saw the same kind of drop after a critical pressure notification.
  Its after-pressure floor still climbed about 6 MB/min (115 -> 145 MB).
- System swap rose by 190 MB during `cap0`, so the drop was most likely Chromium's own memory
  pressure, not the factor.
- So part of the PA growth is free but committed and reclaimable under pressure. A floor that
  grows about 6 MB/min is not.
- The factor was off by construction anyway: the soak legs already cap the copy at 1 MiB, so after
  the first megabyte nothing more reaches MEMFS.

The measured baseline (six real legs, first and second passes) is a post-GC page-renderer slope of
7.4-10.3 MB/min and a PA slope of 6.0-6.3 MB/min. Swap was in use for the whole session, at
7.7-8.6 GB of 16 GB. Every factor run recorded zero `VmSwap` for the page renderer, so swap did
not move these numbers.

**Decision (b).** No factor removes the growth. The remaining suspects are in the engine and
Chromium below the receiver's own code: the rust-core side module's loading, Godot's web
`WebSocketPeer` at the receiver's 16 MiB inbound buffer, and the GL command stream of a real scene.
Finding which one needs more than a small fix inside this increment. So
`rss-bounded-renderer@web` is report-only and typed `known-shortfall`, owner **G7kw2**. G7kw2's
next steps:

- bisect the receiver path (the core's decode without apply, then apply without draw);
- count GL objects per frame so the JS-heap half can get a per-object allowance. Wrap
  `WebGL2RenderingContext.prototype.create*`/`fenceSync` at sampler start, as `diag-web2` did.

### Sabotage sets

These are from the final window-2 runs, `g7live-<kind>-timing` (real time). Every failure set
holds exactly:

| Sabotage | GSW | Web export |
| --- | --- | --- |
| `sabotage-leak-gl-textures` | **exact** `{residency-bounded:gl-textures}` (GL textures 86 -> 186) | — (GSW only) |
| `sabotage-soak-no-evict` | **exact** `{js-heap-bounded, residency-bounded:receiver memory-cache entries, rss-bounded-renderer, wasm-heap-bounded}` | **exact** `{residency-bounded:receiver memory-cache entries}` |

- **GSW `no-evict`.** `rss-bounded-renderer` is one of its first pass's `allowed` declarations
  (slope 3.55 MB/min against a 2.20 MB/min budget at 130 GETs), and it tripped. So did the
  required `wasm-heap-bounded` (+50 MB) and the allowed `js-heap-bounded`.
- **Web `no-evict`.** It reports `rss-bounded-renderer` as a known shortfall (7.80 MB/min). No
  failure set counts such a row, so the web set has nothing in `allowed`.
- **`leak-gl-textures`.** It does not trip `rss-bounded-renderer` (10.91 MB/min, inside its per-GET
  budget). The leak sits in GPU memory, which is not attributable here (`gpu-mem-bounded` is
  `unavailable` on that leg, as since G7k).

### What ran

Everything below ran on the final code, and each run's outcome is listed.

- **The validation snapshot.** It was a detached worktree at the squash content: the diff against
  main is `gate7k-checks.ts`, `gate7k-samplers.ts`, `self-test-gate7k.ts` and docs. The scratch
  diagnostic hooks were left out. `validate-increment.sh --plan --tier full` reaches:
  - `pure`;
  - `g7live-gsw` and `g7live-web-rust` (g7-1, g7-2, g7-5, g7-55);
  - `g7live-gsw-timing` and `g7live-web-rust-timing` (g7-6, g7-lc, g7-r, g7-k);
  - `g7live-native-timing`.

  The sabotage legs run, because a checker path is in the diff. 36 targets are out of reach: every
  native gate, the g7 file groups, g7x and the crates, none of which loads these files.
- **Remote full tier.** `scripts/remote-validate.sh --tier full`, run 40013216302: `pure`,
  `g7live-gsw` and `g7live-web-rust`, groups g7-5 and g7-55. **3/3 pass.**
- **Local full tier, the groups refused remotely** (g7-1 and g7-2 with `RS_VALIDATE_GROUPS`):
  - `g7live-gsw` **passes**: 73 PASS, 0 FAIL.
  - `g7live-web-rust` has 73 PASS and 2 FAIL. Both are g7-2's known R3 window-2 fold-seq class:
    `leg-class-sabotage-drop-resource@web` failed at seq 611 against 610, and
    `no-cors-withheld@web` at seq 2 against 1. That is the remote refusal's "two transactions
    folded in one poll, the failure at the other seq". The diff does not reach gate 2's receiver
    or checks. A single rerun of web g7-2 was started, but it had not finished at landing time.
- **Local timing:**
  - `g7live-gsw-timing` **passes**: 174 PASS, 4 `unavailable` (desktop g7-lc's phone rows).
  - `g7live-web-rust-timing` has 162 PASS, 3 `unavailable` and 1 FAIL:
    `host-unperturbed-constrained@web` (g7-r) measured a host frame-interval p95 5.1 % over
    baseline (18,240 vs 17,357 us) on a contended machine. g7-r never loads the memory sampler or
    the g7-k checks, so this is out of the diff's reach. It was not rerun, to stay in budget.
  - Both runs' g7-k ran every soak and sabotage leg, plus all 12 startup legs per receiver.
- **GSW window 1.** `run-gate7.sh --live --legs g7-k --receiver gsw --credit-window 1` ran the
  `soak-scene` leg only. Its honest checks all **pass**: `rss-bounded-renderer` growth 48.3 MB and
  slope 10.84 MB/min with 16,535 GETs, and `js-heap-bounded` 300 KB/min.
- **Smoke.** `validate-increment.sh --tier smoke`: **3/3 pass** (`pure`, and g7-1 for each receiver
  at one leg).
- **Self-test.** `self-test-gate7k.ts`: 33 pass.
- **Out of scope:** `g7live-native-timing` (g7-r native). The diff cannot reach a native receiver
  (no browser, no memory sampler), and the brief names the two browser timing runs as enough.

### Time per pass

- **First pass:** about 4 h 20 min (wip f02fc4db). It built the sampler, the per-process records
  and the GSW bound, and it found the web growth.
- **Second pass:** about 3 h 40 min, almost all of it diagnosis: raw-CDP and Godot web controls,
  heap snapshots, and PA page contents. No validation ran.
- **Finisher 2:** about 4 h (16:28-20:30). Diagnosis took 1 h 32 min (16:36-18:08, four
  factor runs). Most of the rest was lock-contended validation: the timing runs spent 5.4 h of
  combined lock wait in 3.3 h of wall time.

### Evidence

Under `artifacts/render-stream/gate7/g7kr/` (not committed):

- first pass: `*.json*`, `*.log`;
- second pass: `finisher1/controls`, `finisher1/diag`, `finisher1/godot-controls`, and the scratch
  sampler `finisher1/diag-sampler.patch`;
- this pass: `finisher2/diag/<factor>/diag.jsonl`, `finisher2/diag/<factor>.load` and the leg
  timelines under `finisher2/runs/<factor>/gate6/g6s-web/g6s/soak-scene/receiver/`.

The scratch diagnostic hooks are not committed. They were `G7KR_DIAG_NONET`, which rewrites
Playwright's `Network.enable` into `Network.disable` on its CDP pipe, and `G7KR_DIAG_ENV`, which
overrides the soak receiver's env words.
