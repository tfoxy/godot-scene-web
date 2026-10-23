## Gate 7kh result: the GSW soak's JS heap regression (2026-10-23)

The pre-G7z delta sweep ([sweep-pre-g7z.md](../sweep-pre-g7z.md), "`g7-k` GSW soak") found the
live `g7-k` 300 s soak on the GSW receiver failing `js-heap-bounded`: a slope of 834–837 KB/min
against the 512 KB/min budget (Q10), at any load. The web export's soak passed. **It was a real
leak, and the budget is unchanged.** At credit window 2, GSW folds about every other transaction,
and it logged two lines per fold into the page's log buffer (`shell.lines`), which keeps every
line until exit. After the fix the honest soak's slope is **310 KB/min at window 2** and
**307 KB/min at window 1**. Every `g7-k` sabotage still fails exactly its set.

### Cause and owner

- **Owner: G7q 3b904ca6. G7wd 2431d26f exposed it.** G7q added two `log()` lines per fold:
  `seq N folds into seq M …` in `foldIntoPending`, and `seq M applied with N (credit window 2)`
  in the apply. GSW's `log()` (`web/gsw-receiver/common.ts`) pushes `{t, stream, line}` onto
  `shell.lines`, the page's stdout mirror, which the harness reads once at the end. G7wd made
  window 2 the default, so the soak now runs it.
- **The soak itself changed.** G7k's soak ran at window 1: 5,452 records were received and applied,
  and the receiver logged 30 lines. The sweep's soak ran at window 2: 11,060 records were received
  but only 5,530 were applied (5,529 folds), and it logged 11,089 lines (811 KB of `stdout.log`).
  So the host publishes twice as fast and GSW still applies the same ~18/s. The per-fold lines
  scale with the fold rate; nothing the receiver applies does.
- **Evidence.** A diagnostic soak on unmodified main forced a GC through CDP, then read
  `JSHeapUsedSize` and took heap snapshots at 60, 180 and 330 s. That diagnostic is
  `artifacts/render-stream/gate7/g7kh/heap-diag-sampler.patch`, scratch and not committed.
  - The post-GC heap grew 2.47 → 4.11 → 6.06 MB, about 800 KB/min. It is retained memory, not
    floating garbage.
  - Snapshot diff from 60 s to 330 s: +40,476 concatenated strings (810 KB), +20,241 strings
    (371 KB) and +16,692 `Object`s (816 KB). These are the log lines and `report.shell`'s
    per-transaction facts. There were also +8,065 `ArrayBuffer` wrappers (935 KB, with 166 MB of
    backing store), which is the received-bytes tap, and +52,496 heap numbers (629 KB).
  - Ruled out as owners: G7o4, G7v, G7p, G8w and G8t. None of them adds per-record JS state on
    this path. G7v's tap cap was not applied to GSW soak legs, but the tap only doubled with the
    record rate.

### Fix

- **`web/gsw-receiver/live.ts`**:
  - Under `RS_RECEIVER_LOG=summary`, which every soak leg uses, the receiver keeps no
    per-transaction state. The two per-fold lines are logged only under `RS_RECEIVER_LOG=full`.
    The fold count goes into the final `ok:` line instead (`… 5529 folded …`).
  - `report.shell` (per-applied `ShellTx`) is filled only under a full log. `appliedJson` writes
    `transactions: null` under summary, so nothing read it.
  - Folds, acks and evidence under a full log are unchanged.
- **`scripts/run-gate6.sh`**: GSW soak legs now get the same 1 MiB cap the web export's soak legs
  already had (`RS_RECEIVER_RECEIVED_MAX_BYTES=1048576`, `GATE7_LIVE_KIND` = `web` or `gsw`).
  - Without the cap, the tap kept all 218 MB of received messages until exit, one JS
    `ArrayBuffer` per record (about 210 KB/min of the judged heap at window 2).
  - No g6s or g7-k check reads the recording; the soak judges shots and perf.
  - Native gate 6 never sets `GATE7_LIVE_KIND`, so its runs are unchanged.

### Slopes (honest `soak-scene`, GSW, `JSHeapUsedSize` least-squares over [60 s, 360 s])

| Build | Window | Slope | Growth | Source |
| --- | --- | --- | --- | --- |
| G7k 1feb8b2d | 1 | 435 KB/min (recomputed; G7k reported +2.0 MB) | +2.0 MB | `gate7/g7k/final` |
| main (sweep) | 2 | 834,002 / 837,354 B/min | — | sweep, sweep rerun |
| main (this diagnostic) | 2 | 834,149 B/min; post-GC ≈ 800 KB/min | — | `g7kh/diag-w2` |
| log + shell fix only | 2 | 442,102 B/min; post-GC ≈ 395 KB/min | 2.03 MB | `g7kh/fix1-w2` |
| **G7kh (fix + tap cap)** | **2** | **310,248 B/min** | 1.38 MB | `g7live-gsw-timing` |
| **G7kh (fix + tap cap)** | **1** | **307,456 B/min** | 1.44 MB | `g7kh/gsw-w1` |

The remaining ~310 KB/min is mostly `perf.samples`, one `FrameSample` per drawn frame (about
230 B each), which perf.json's exact p50/p95 histograms and the per-frame timeline are built from.
It is bounded by the drawn rate, not the credit window: the soak scene draws about 18/s, so a soak
of a 60/s scene would carry about 3× this. It was there at G7k and is not changed here. Bounding
it, for example with streaming histograms, changes the exact percentiles that g6c and g7-r judge,
so it is a follow-up and not part of this fix.

### Sabotages (unchanged sets, all exact)

| Leg | Window 2 | Window 1 |
| --- | --- | --- |
| `sabotage-soak-no-evict` (gsw) | exactly {js-heap-bounded, residency-bounded:receiver memory-cache entries, wasm-heap-bounded}; JS heap 983 KB/min | same; 1,003 KB/min |
| `sabotage-leak-gl-textures` (gsw) | exactly {residency-bounded:gl-textures}; JS heap 316 KB/min | same; 306 KB/min |

`js-heap-bounded` is `allowed` (not required) for `no-evict` (`G7K_SABOTAGE_SETS`). Its JS growth
comes from the payload bodies it never evicts, so the lower baseline does not hide it.

### Finding (not fixed here): `rss-bounded-renderer` samples the wrong renderer

`gate7k-samplers.ts` keeps the first `renderer` pid that `SystemInfo.getProcessInfo` lists. In the
diagnostic run there were three renderers:

- the sampled one, flat at 70 MB the whole soak;
- the receiver page's renderer, which grew 212 → 319 → 446 MB at 60/180/330 s (the 218 MB tap
  plus allocator slack);
- a third renderer, 101 → 109 MB.

G7k's "renderer RSS growth +1.06 MB" and every `rss-bounded-renderer` pass since then measured an
idle renderer. With the tap capped, GSW's real renderer growth should be the wasm heap (+5 MB) plus
the JS heap. But no run has measured it, and picking the page's renderer may change the no-evict
sets (its wasm grows by about 50 MB). It needs its own increment: identify the page's renderer
pid, then re-derive the sets. The evidence is in `artifacts/render-stream/gate7/g7kh/diag-w2/heap/`
(`procs.json`, `gc.jsonl`).

### What ran

- **Diagnosis:** two diagnostic `g7-k` soak-scene runs at window 2 (main, then the log + shell fix
  alone), with forced-GC heap readings and snapshots.
- **gsw `g7-k` at window 1, real time** (`--credit-window 1`): 40 PASS, 0 FAIL.
- **`scripts/remote-validate.sh --tier full --and-local`**, with `--only pure,cargo-gsw-rs,g7-gsw,
  g7-web-rust,g7live-gsw,g7live-gsw-timing,g7live-web-rust-timing`:
  - Remote: `pure`, `g7-gsw` (g7-0..g7-6), `g7-web-rust` (g7-6) and `g7live-gsw` (g7-5, g7-55)
    pass. `cargo-gsw-rs` rc 101 is the known failure.
  - Local `g7live-gsw-timing` at window 2, real time: g7-6 25, g7-lc 70 (+4 desktop
    `real-suspension@gsw-device` rows typed `unavailable`), g7-r 40, g7-k 40; 0 FAIL.
  - Local `g7live-web-rust-timing` at window 2, which includes web `g7-k`: g7-6 26, g7-lc 66
    (+3 `real-suspension@web-device` rows typed `unavailable`), g7-r 42, g7-k 31; 0 FAIL.
    `no-evict@web` failed exactly {residency-bounded:receiver memory-cache entries}.
  - Local `g7live-gsw` groups g7-1 and g7-2 (refused remotely): g7-1 38, g7-2 35; 0 FAIL.
    `resync-full@gsw` passed this time; it is intermittent at window 2 and has its own owner.
  - Each local run's wall time, lock wait and lock hold, in seconds:

    | Run | Wall | Lock wait | Lock hold |
    | --- | --- | --- | --- |
    | `g7live-gsw-timing` | 4884 | 7056 | 3192 |
    | `g7live-web-rust-timing` | 3354 | 1213 | 2916 |
    | `g7live-gsw` | 1444 | 3692 | 1030 |

**Out of scope** (the full plan's other targets):

- `native-rust-gate6`: the only `run-gate6.sh` change sits under `GATE7_LIVE_KIND` = `web` or
  `gsw`, which native gate 6 never sets.
- `g7live-native-timing` and `g7x`: they never run a g6s soak leg or the GSW live receiver's fold
  path.
- The native g5f timing group behind `g7-gsw`: native receiver legs, not reached by a GSW or soak
  change.
- `g7live-web-rust` g7-1, g7-2, g7-5 and g7-55: the web export does not run `live.ts`, and its soak
  is the only web leg `run-gate6.sh`'s line reaches (in `g7live-web-rust-timing`).

### Time

Implementation took about 40 min: reading, two diagnostic soaks of about 14 min each, and the
fix. Validation took about 2 h 50 min of wall clock (06:30–09:20). The window-1 run went in
parallel with the full tier, and two other increments' runs shared the quiet lock.

Evidence (ignored): `artifacts/render-stream/gate7/g7kh/`.
