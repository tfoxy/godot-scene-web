## Gate 7uf result (2026-10-20): findings

G7uf investigated why live `g7-6` on the web export (Rust core) fails `motion-monotonic@web`. The
check reports a 3-frame gap between applied transactions after a transaction the receiver held
for less than one frame. Earlier runs pointed at G7u (e7c8235f): a bundle built from `main` at G7u
failed 2 of 2 runs, the G7o3 branch failed 4 of 5, and a pre-G7u bundle passed 2 of 2.

**G7u is not the cause, and no code changed.** At matched load, the pre-G7u bundle fails the same
way, and so does `main` with G7u's receiver hunks reversed. The failures have two sources:

- **Timing events outside the receiver.** These are deliveries that miss a frame, and host frame
  hitches. Load from other repos, which this repo's quiet lock cannot see, makes them frequent.
- **A boundary in the check's attribution.** On a quiet machine, a transaction that waited one
  receiver frame for a payload fetch can still hold the credit for less than 16.667 ms. The check
  counts it as fast. This increment changes neither the check nor its bound. The orchestrator
  decides (Recommendation below).

### Runs (desktop, web export, Rust core)

Each run executes g7-6's live legs:

- **Rows without an `F`:** `run-gate6.sh --legs g6l` with g7-6's environment
  (`GATE7_LIVE_KIND=web`, Rust core, browser fetch).
- **`F` rows:** `run-gate7.sh --live --legs g7-6 --receiver web`, on `main` merged with G7k.

**Load** is the mean 1-min load over each leg's exclusive quiet-lock hold, sampled every 5 s.

**Unexcused** counts the gaps over 2 that `evaluateMotionMonotonic` does not excuse, per leg:
scene, warm, stall, reconnect, sabotage. The check fails on any. The scratchpad tool `mm.py`
reimplements `evaluateMotionMonotonic`. On every run check-gate7 also judged, the two agreed:
QA1, LP1, LA2 and F1–F5, plus the finisher's runs.

Bundles:

- **`main`:** the G7o3 tip, `279dee6b`. The `F` runs use `8ea8f46c`, which adds G7k.
- **`main − G7u`:** `main` with G7u's `receiver.gd`, `rs_resource_fetcher.gd` and `shell.html`
  hunks reversed, `978f95e7`.
- **`G7wf`:** `receiver/`, `rs-core` and `rs-core-capi` at 61fe688a, the last `main` before G7u,
  `0c0430b0`.

| Run | Bundle | Leg load | Unexcused | Verdict |
| --- | --- | --- | --- | --- |
| A1 | main | not sampled (3.7 at start, 14.5 at end) | 3, 2, 5, 1, 1 | fail |
| B1 | main − G7u | 11.0–14.0 | 2, 5, 6, 0, 5 | fail |
| LP1 | G7wf | 14.1–18.1 | 1, 20, 2, 18, 0 | fail (26/27) |
| LA2 | main | 5.2–6.1 | 0, 1, 0, 4, 2 | fail (26/27) |
| LP2 | G7wf | 11.3–19.6 | 17, 0, 0, 6, 7 | fail |
| LA3 | main | 8.4–14.6 | 0, 5, 3, 1, 1 | fail |
| F2 | main | 2.9–8.8 | 0, 1, 1, 2, 4 | fail (26/27) |
| QA1 | main | 2.3–3.5 | 0 | pass (27/27) |
| QP1 | G7wf | 3.4–5.2 | 0 | pass |
| QA2 | main | 3.9–5.4 | warm 1: late receipt | fail |
| QA3 | main | 2.2–3.8 | 0 | pass |
| QP2 | G7wf | 0.6–1.2 | 0 | pass |
| QA4 | main | 1.5–2.0 | warm 1: fetch under 16.667 ms | fail |
| QA5 | main | 1.5–2.2 | 0 | pass |
| F1 | main | 1.6–2.5 | warm 1: fetch under 16.667 ms | fail (26/27) |
| F3 | main | 2.7–3.5 | reconnect 1 (stream 2): host hitch | fail (26/27) |
| F4 | main | 2.6–3.4 | 0 | pass (27/27) |
| F5 | main | 2.1–3.4 | 0 | pass (27/27) |

**Failure rates at matched load:**

- **Loaded (leg load 5–20):** every bundle fails every run.

  | Bundle | Runs failed | Unexcused gaps per run |
  | --- | --- | --- |
  | `main` | 4 of 4 | 7–12 |
  | `main − G7u` | 1 of 1 | 18 |
  | G7wf | 2 of 2 | 41 and 30 |

  The bundle without G7u is no better than `main`.
- **Quiet (leg load under about 5):** `main` passes 5 of 9 runs and G7wf 2 of 2. Every quiet `main`
  failure is a single gap, and none of the kinds involves G7u's code. Two G7wf runs cannot
  separate the bundles: P(G7wf passes both by chance, given 7 passes in 11) is 0.38.
- **The 5 run-gate7 validation runs on merged `main`:** 2 pass (F4, F5). F2 ran under load. F1
  failed on the check boundary and F3 on a host hitch.

### Why G7u cannot be the cause

The receiver's per-transaction work is unchanged. Plain transactions (no fetch, no shot), on a
quiet machine:

| Bundle | Hold (receipt→`submitted`) p50 | p90 | Apply (receipt→`applied`) p50 |
| --- | --- | --- | --- |
| `main`, 8 runs | 1.7–2.0 ms | 1.9–2.5 ms | 0.7–0.9 ms |
| G7wf, 2 runs | 1.7–1.9 ms | 1.9–2.4 ms | 0.8–0.9 ms |

The receiver's frame cadence is the same in every bundle. Each leg has about 11–44 rAF intervals
that miss 16.7 ms by more than 4 ms.

G7u adds nothing to the per-frame path:

- `RS_RECEIVER_RECONNECT_ON_LOSS` acts only in `_process_live`'s connecting and closed branches.
- The fetcher's `account_suspension` costs two subtractions per `poll()`.
- `shell.html`'s change sits inside the `webglcontextlost` listener.
- G7k's `_web_mark` calls are one-shot.

The finisher's pre-G7u passes and post-G7u failures used the same harness, but the load at the
time of each run was not recorded.

### Decomposition: what holds the frame

The host sends `n` at the first frame callback after `p`'s credit: creditToSend is +0 in every
run. `p`'s round trip on the host clock, from its send to its `submitted` ack, is
`L + H + a`:

- **`L`, send→receipt.** Delivery plus the wait for the receiver's next frame poll. Delivery is
  normally under 1 ms. It is late when the host's websocket IO thread flushes late
  (`queued_bytes` > 0 on the tap's `sent` line) or the page delivers late. The wait is the phase
  between the two 60 Hz clocks, 0–16.7 ms, fixed for a leg: its median ran 1.1–17.4 ms across
  legs.
- **`H`, the hold.** The fetch wait, apply (about 0.8 ms), the draw and the frame boundary up to
  `frame_post_draw`.
- **`a`, the ack's transit.** Under 1 ms.

A gap of 3 means the round trip ran past about two host frame callbacks. The check assumes a
3-frame gap needs `H` to exceed one frame. That ignores `L`, which alone can approach a frame.

`decomp.py` classifies every unexcused gap. There are 200 across 23 runs, both streams. The first
column covers the 12 runs that were loaded or whose load was not recorded: the finisher's 5, plus
A1, B1, LP1, LA2, LP2, LA3 and F2. The second covers the 11 quiet runs.

| Kind | Loaded or unrecorded (12 runs) | Quiet (11 runs) | What happened |
| --- | --- | --- | --- |
| late receipt (`L` > leg median + 8 ms) | 154 | 1 | the receiver missed a frame poll for `p` behind a few-ms hold: delivery (host flush or page) was late |
| host hitch (host frames ran faster than wall time) | 24 | 1 | the host process stalled and caught up 2–3 frames at once |
| fetch under a frame (`fetched` > 0, `H` ≤ 16.667 ms) | 12 | 2 | see below |
| slow ack (`a` > 3 ms) | 3 | 0 | |
| other | 3 | 0 | slow frames under load |

The quiet gaps:

- **QA2 seq 595, late receipt.** `L` was 29.8 ms against a median of 12.5. The host flushed in
  time and the hold was 3.4 ms.
- **F3 stream 2 seq 135, host hitch.** The host sent 45 ms after the credit, then ran frames
  764–766 within about 3 ms.
- **QA4 seq 74, fetch under a frame.** `L` 18.5 ms, `H` 14.6 ms, 1 fetch.
- **F1 seq 362, fetch under a frame.** `L` 15.2 ms, `H` 16.2 ms, 2 fetches.

**Fetch under a frame.** G7wf's browser `fetch()` resolves asynchronously, so a fetching
transaction is always applied in a later receiver frame than it arrived in. Its hold is therefore
about one frame of rAF time: p50 18.3–19.3 ms over the 90–170 fetching transactions a run. rAF
jitter puts 0–3 of them a run under 16.667 ms. Combined with a leg phase `L` of about 13–18 ms,
such a hold carries the credit past two host frames. The receiver did hold the credit across one
of its frames, waiting on a fetch, but `receive_to_submit_us > G6L_FRAME_US` misses that by under
2.1 ms.

### Is the 3-frame bound realistic for the web export at 60/60?

Yes, for every transaction the receiver does not hold. A plain transaction has `H` of about 2 ms,
so even at the worst phase its round trip is about 19 ms plus delivery, under two frames.

G7r's phase lock is the gap-2 regime: at credit window 1, 60/60 publishes about 59/s or about
29/s depending on clock phase. Several legs here ran at about half rate, with 300–400 applied
transactions against about 800, and still had no gap over 2.

A transaction that waits a frame for a fetch or a shot can legitimately reach gap 3. The check
means to excuse it (below), but measures the wait in microseconds.

### The check's rule, as documented and as coded

The documentation and the code disagree:

- **Documented.** `lib/gate6l-checks.ts` line 126, the `G6L_MAX_GAP` comment, excuses a gap "after
  a transaction that waited on an HTTP fetch or was shot". So does gate6-design.md's G6l as-built
  finding 2.
- **Coded.** `evaluateMotionMonotonic` (line 642) also requires a hold of more than
  `G6L_FRAME_US` (16.667 ms) before it labels the cause fetch or shot.

A fetch hold is quantized to one receiver frame, so the coded threshold sits at the low edge of
its own population.

**Native gate 6 (G7k's report).** G7k saw two 3-frame gaps behind a hold of about 16.5 ms at load
1–4. That matches this boundary: a hold that took a receiver frame by count but measured just
under 16.667 ms, in a leg whose phase is near a frame. A native HTTPClient fetch is
frame-quantized too (about 14 ms, memory rs-g2c2-live-resource-facts). G7k's evidence was not
re-read here, so it is unconfirmed whether those transactions fetched or had a slow frame. Either
way they meet the same microsecond threshold.

### Recommendation (the orchestrator decides)

Keep `motion-monotonic` gating, keep its bound of 2, and make two changes.

1. **Attribute by frame count.** The receiver records a `received_process_frame`. Today
   applied.json has `process_frame` (the apply frame) and `submitted_process_frame`, but not the
   receipt frame. The check then counts `p` as held longer than a frame when
   `submitted_process_frame > received_process_frame`, on both receivers.
   - A fast transaction, received and submitted in one frame, still fails any gap over 2.
   - Late receipts and host hitches still fail.
   - On this increment's quiet `main` runs, this turns QA4 and F1 into passes: 7 of 9 instead of
     5 of 9.
   - Rejected alternative: apply the documented rule literally (`fetched > 0` or a shot, at any
     hold). It would also excuse a fetch that returned within its own frame, which the receiver
     never does on the web, but does not prove.
2. **Judge the rest as a timing check.** Late receipts and host hitches are timing events. The g6l
   legs already hold the quiet lock exclusive, so treat `motion-monotonic` like the other timing
   verdicts: one rerun when a run fails. Also gate the run on `/proc/loadavg`, because the lock
   cannot see other repos (F2 started at a 1-min load of 3.45; its legs ran at 7–9). After
   change 1, the quiet failure rate here is 2 of 9 runs, so one rerun would pass about 95% of the
   time.

### Re-runs (scoped)

No code changed, so the re-runs are the diagnosis itself:

- the 13 live `g6l` runs in the table;
- `run-gate7.sh --live --legs g7-6 --receiver web` 5 times on `main` + G7k (F1–F5);
- one discarded run: the first A1 attempt (chromium-1223 missing, Traps below).

Out of scope, and not run:

- Live `g7-1`/`g7-2`, `g7-lc`, the GDScript web core, native gates 1 and 2, and the pure
  self-tests, including `self-test-gate7u`. Each was conditional on a change to the live loop,
  the shared shell, `receiver.gd`'s native path or a checker. None changed.
- The g31. No device-leg code changed.
- The single-hunk bisect bundles (only the fetcher, only `receiver.gd`, only `shell.html`
  reversed). They were built but never run. Once G7wf itself failed the same way under load,
  splitting G7u's hunks could not find a cause.

### Traps

- **The pinned Chromium can disappear.** At 12:58 on 2026-10-20, a Playwright install outside
  this repo garbage-collected `~/.cache/ms-playwright/chromium-1223` and `ffmpeg-1011` (only
  `-1248` remained). Every browser leg then fails in `launchPersistentContext` with "executable
  doesn't exist", and the receiver exits 124.
  - The fix: the repo's own `pnpm exec playwright install --no-shell chromium` (playwright-core
    1.60.0, D9's pin). It restored the binary, whose sha256 matches `EXPECTED_CHROMIUM_SHA256`.
- **`pkill -f <pattern>` matches the shell that runs it** when the pattern appears in that
  shell's own command line. Kill by PID instead.
- **The quiet lock is blind to other repos.** Runs waited 20–30 min for the exclusive lock while
  another repo held the 1-min load at 10–19. Record load per leg (this increment's `load.txt` and
  `legload.py`); a load reading at the start alone does not show a run was quiet.
- **applied.json's `process_frame` is the apply frame, not the receipt frame.**
- **mm.py and the first `decomp.py` read only `live-1.jsonl`.** A gap in a reconnect leg's second
  stream (F3) needs `live-2.jsonl` too.

### Evidence (ignored; scratchpad `g7uf/`)

- `runs/<name>/`: run-gate6 output.
- `final/F*/`: run-gate7 output.
- `summary.txt`, `final.txt`, `judged.txt`: verdicts, with load at start and end.
- `load.txt`: the 5-s load samples.
- `decomp-all.txt`.
- The analysis scripts: `mm.py`, `decomp.py`, `legload.py`, `hold.py`, `fetchhold.py`,
  `frames.py`, `queued.py`, `late.py`, `around.py`.

The bundles are under `artifacts/render-stream/web-receiver/`.
