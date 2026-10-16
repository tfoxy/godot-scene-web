## Gate 7m result (2026-10-15)

G7m ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7m", D24 to D28, Q13e) ran G7d's
documented bench command on the moto g31, the only phone attached (standing approval, D28). The
g86 is not attached; its arm stays `device-unavailable` and operator-attended, out of scope here
(G7v's attended session runs it, per the design doc's fork). The web-export receiver arm stays
`unavailable` (`web-export-not-built`): it needs G7e, which is pending, and it was not built here.

Command, reusing G7d's final desktop run's bench recordings verbatim (copied into this worktree's
ignored `artifacts/render-stream/gate7/g7m-inputs/`, not regenerated):

```bash
pnpm render-stream:gate7 -- --legs g7-dev,g7-bench --env device --device g31 --receiver gsw \
  --bench-inputs artifacts/render-stream/gate7/g7m-inputs/inputs/inputs.json
```

`check-gate7.ts`: 12/12 group checks pass, including the five-repeat `dev-bench-<input>-gsw-g31-
complete` checks (5/5 valid repeats each) and `device-provenance` / `device-session-settings-
restored`. Evidence kept at `artifacts/render-stream/gate7/g7m-g31/` (ignored, not committed).

**The budget, recomputed from the measured panel.** rAF `tp_ms` measured 17.00 to 17.03 ms across
the run's two independent probes, matching G7d's 17.02 ms smoke finding (not the nominal 16.67 ms
"60 Hz"). **0.5·T_p is therefore about 8.50 to 8.51 ms, not the nominal 8.3 ms.** The table below
uses each leg's own measured budget.

**g31 five-repeat bench (GSW), ms p50/p95, against G7d's desktop numbers** (Ryzen 5 5500,
headless Chromium 148, from "Gate 7d result"):

| Input | phase | g31 p50/p95 | desktop p50/p95 | g31/desktop (p50) |
| --- | --- | --- | --- | --- |
| scene-full | decode (incl. hash) | 9.935 / 10.985 | 1.41 / 2.03 | 7.0x |
| scene-full | hash | 6.525 / 7.260 | 0.75 / 1.15 | 8.7x |
| scene-full | validate | 0.990 / 1.250 | 0.17 / 0.26 | 5.8x |
| scene-full | resolve | 0.830 / 0.995 | 0.11 / 0.20 | 7.5x |
| scene-full | **total** | **11.790 / 12.990** | 1.69 / 2.44 | **7.0x** |
| scene-patch | decode (incl. hash) | 0.750 / 4.715 | 0.06 / 0.40 | 12.5x |
| scene-patch | hash | 0.290 / 2.920 | 0.02 / 0.22 | 14.5x |
| scene-patch | validate | 2.015 / 2.630 | 0.13 / 0.19 | 15.5x |
| scene-patch | resolve | 0.130 / 0.920 | 0.01 / 0.07 | 13.0x |
| scene-patch | **total** | **3.040 / 7.395** | 0.21 / 0.61 | **14.5x** |
| hd-patch | decode (incl. hash) | 6.130 / 10.785 | 1.09 / 1.81 | 5.6x |
| hd-patch | hash | 4.375 / 7.260 | 0.73 / 1.24 | 6.0x |
| hd-patch | validate | 3.550 / 7.220 | 0.67 / 0.85 | 5.3x |
| hd-patch | resolve | 0.875 / 1.530 | 0.16 / 0.27 | 5.5x |
| hd-patch | **total** | **10.565 / 16.790** | 1.89 / 2.89 | **5.6x** |
| pace-patch | decode (incl. hash) | 0.975 / 1.310 | 0.07 / 0.11 | 13.9x |
| pace-patch | hash | 0.365 / 0.585 | 0.02 / 0.03 | 18.3x |
| pace-patch | validate | 0.425 / 0.790 | 0.04 / 0.07 | 10.6x |
| pace-patch | resolve | 0.125 / 0.205 | 0.01 / 0.02 | 12.5x |
| pace-patch | **total** | **1.575 / 2.160** | 0.12 / 0.19 | **13.1x** |

Against the measured budget (p95 total vs 0.5·T_p): **scene-full misses at 12.990 ms vs 8.505 ms
(+53 %)**; **hd-patch misses at 16.790 ms vs 8.507 ms (+97 %)**; scene-patch passes at 7.395 ms vs
8.505 ms (1.11 ms headroom); pace-patch passes at 2.160 ms vs 8.507 ms (6.35 ms headroom). Apply is
not applicable: GSW's applier does not exist before G7a, so this bench measures decode, hash,
validate and resolve only (apply is G7v's measurement). Native and web rows do not apply to this
device bench (native is desktop-only in G7d; web is `unavailable`).

**D27 verdict for GSW on the g31: not met.** `scene-full` and `hd-patch` — the two inputs carrying
a full frame or a large inline resource payload — miss the 0.5·T_p budget at p95. The typed
finding is `device-decode-over-budget` (receiver `gsw`, phone `g31`, inputs `scene-full` and
`hd-patch`, per-phase numbers in the table above). `scene-patch` and `pace-patch` (small
per-transaction deltas, no large payload to hash) pass with headroom. The phone/desktop ratio
(5.6x to 14.5x on p50) is well above D27's estimated 4 to 5x factor, confirming G7d's one-repeat
smoke over five repeats. **This triggers G7o** for the GSW receiver; it is not void. The g86 arm
did not run (not attached) and is recorded `device-unavailable`; G7v runs it first, attended.

**Ranked bottlenecks, for G7o.**

1. **SHA-256 hashing** (G7j's pure-TypeScript inline-payload hash) is the single largest phase on
   both inputs that carry a large payload: 6.525 ms p50 (55 % of scene-full's 11.790 ms total) and
   4.375 ms p50 (41 % of hd-patch's 10.565 ms) — confirms G7d's one-repeat finding over five
   repeats. G7o's candidates (move hashing off the rAF path, or a wasm SHA-256) target this first.
2. **Decode minus hash** (framing and value parsing) is the second-largest cost on those same two
   inputs (about 3.41 ms p50 on scene-full, 1.76 ms on hd-patch), and the dominant cost on the
   small patch-only inputs, though their totals stay well under budget regardless (G7o's
   candidate: `DataView` decoding with no per-record object churn).
3. **Validate** is disproportionately costly on `scene-patch` (2.015 ms p50, 66 % of its 3.040 ms
   total, bigger than its own decode) and shows a wide p50/p95 spread on `hd-patch` (3.550 /
   7.220 ms, about 2.0x), worth watching for GC-pause-like jitter, though not yet the top target.
4. **Resolve** is the smallest contributor everywhere (0.13 to 1.53 ms p50) and not a G7o priority.

**CPU frequency and thermal**, sampled at the two session-start probes plus six 30-s samples over
the run (about 150 s: the g7-dev session check and the four g7-bench legs):

- Both clusters ran **uncapped** this run: A55 `scaling_max_khz` 1 800 000 of `cpuinfo_max_khz`
  1 800 000 (`derated: false`); A75 `scaling_max_khz` 2 000 000 of 2 000 000 (`derated: false`).
  This **differs from G7d's one-repeat smoke**, which found the A75 capped at 1 354 000
  (`derated` true). **The cap varies between runs; it is not a fixed property of the device.**
  `scaling_cur_khz` still dropped under idle between legs (A55 observed down to 774 000 at one
  30-s sample), consistent with a normal governor, not a sustained throttle.
- Thermal status stayed `none` (code 0) for all samples; CPU/GPU/NPU reported a flat 45.5 °C
  (likely a coarse sensor ceiling, as G7d also saw); battery temperature rose 23.3 to 23.6 °C.
- Battery held at 72 % throughout (charging on USB); no drop recorded over the run.
- Session settings (`stay_on_while_plugged_in`, `accelerometer_rotation`, `user_rotation`) were
  applied for the run and fully restored afterward (2 / 0 / 0, as found); no adb forward or
  reverse was left behind.

### Deviations

- Only the GSW receiver ran. The web-export arm needs G7e and was not attempted, per scope.
- The g86 arm did not run: the phone is not attached, and the task's scope excludes targeting it.
- `--bench-inputs` reused G7d's final desktop run's recordings (`g7d-r1/g7-bench/inputs`) verbatim,
  copied into this worktree's artifacts; no desktop capture was regenerated.

### What G7m does not prove

It does not cover the g86 (G7v's attended session runs that arm first), the web-export receiver
(waits for G7e), or GSW's apply cost (G7a's applier, measured at G7v). Per the contract, the
`device-decode-over-budget` finding is itself the result: G7o is scoped next, and no decode
optimization was attempted here.

## Gate 7m (web export) result (2026-10-15)

G7e landed (README "Gate 7e result"), so the web-export arm of G7m -- stubbed `unavailable`
above -- now runs the same bench, same method, same phone. `gate7-bench.ts`'s web arm was
`unavailable` only because nothing had ever driven the G7e bundle through a decode/apply bench;
no new build mode was needed. G7e's `rs_io.gd` already stages `RS_RECEIVER_RECORDING` and
`RS_RECEIVER_STORE_DIR` from same-origin URLs into emscripten's in-memory filesystem before
`_ready` (proven by G7e's gate 0 web legs), so the web arm now replays each bench input exactly
as native's file mode -- one record per `_process`, `RS_RECEIVER_PERF_OUT` +
`RS_RECEIVER_LOG=summary` -- over HTTP, one fresh page per warmup/repeat instead of one fresh
process. Q13e's design text called for a second, `--bench`-only export with an embedded
recording; that turned out to be unnecessary (see "Deviations").

Command (the g31, standing approval; reusing the same `g7d-r1`-derived bench recordings as the
GSW arm, copied into this worktree's ignored `artifacts/render-stream/gate7/g7m-inputs/`):

```bash
pnpm render-stream:gate7 -- --legs g7-dev,g7-bench --env device --device g31 --receiver web \
  --bench-inputs artifacts/render-stream/gate7/g7m-inputs/inputs/inputs.json
```

`check-gate7.ts`: **11/11** group checks pass, including the five-repeat `dev-bench-<input>-web-g31-
complete` checks (5/5 valid repeats each), `bench-web-device-provenance`, `device-provenance` and
`device-session-settings-restored`. A companion desktop run (`ctl-bench-<input>-web`, the early
signal G7d's table left blank) is **6/6**. Evidence: `artifacts/render-stream/gate7/g7m-g31-web/`
(ignored; the desktop run and a pace-patch recheck, below, are also kept under
`g7m-g31-web-desktop/` and `g7m-g31-web-pace-recheck/`).

**The budget.** This run's own probe (the same self-contained rAF page the GSW arm uses, since
the GDScript receiver reports no rAF timing of its own) measured `tp_ms` 17.00 ms median / 17.10 ms
p95 over a 3-s window -- matching G7d's and the GSW arm's 17.00-17.03 ms exactly. **0.5*T_p is
8.500 ms**, the same budget the GSW table used.

**g31 five-repeat bench (web export), ms p50/p95, against this worktree's own desktop web run**
(Ryzen 5 5500, headless Chromium, same bundle):

| Input | phase | g31 p50/p95 | desktop p50/p95 | g31/desktop (p50) |
| --- | --- | --- | --- | --- |
| scene-full | decode | 41.984 / 44.032 | 9.472 / 12.544 | 4.4x |
| scene-full | apply | 5.760 / 10.496 | 1.312 / 2.496 | 4.4x |
| scene-patch | decode | 11.520 / 16.896 | 1.696 / 3.648 | 6.8x |
| scene-patch | apply | 9.472 / 12.544 | 1.312 / 2.880 | 7.2x |
| hd-patch | decode | 75.776 / 96.256 | 16.896 / 29.184 | 4.5x |
| hd-patch | apply | 64.512 / 79.872 | 15.104 / 24.064 | 4.3x |
| pace-patch *(recheck)* | decode | 4.736 / 7.040 | 0.592 / 0.816 | 8.0x |
| pace-patch *(recheck)* | apply | 1.184 / 2.112 | 0.102 / 0.204 | 11.6x |

Native/web-export receivers report only `decode` (= decode + validation + resolve, same as G7d's
native table) and `apply`; there is no per-transaction `total` sample to take a percentile of, so
-- matching G7d's own native table -- `total_p95_us = p95(decode) + p95(apply)` is an upper bound,
not a true joint percentile. Against the 8.500 ms budget: **scene-full 54.528 ms (desktop 15.040
ms, OVER), scene-patch 29.440 ms (desktop 6.528 ms, OVER), hd-patch 176.128 ms (desktop 53.248 ms,
OVER), pace-patch 9.152 ms (desktop 1.020 ms, OVER by +7.7 %)**.

**D27 verdict for the web export on the g31: not met, on all four inputs.** `device-decode-over-
budget` (receiver `web`, phone `g31`, inputs `scene-full`, `scene-patch`, `hd-patch`,
`pace-patch`). This is a materially worse outcome than the GSW arm, which passed `scene-patch` and
`pace-patch` with headroom (README "Gate 7m result"). Against GSW's own g31 p95 totals, the web
export is **4.0x to 10.5x worse on the same phone, same inputs**: scene-full 54.528 vs 12.990 ms
(4.2x), scene-patch 29.440 vs 7.395 ms (4.0x), hd-patch 176.128 vs 16.790 ms (**10.5x**, the
largest gap), pace-patch 9.152 vs 2.160 ms (4.2x). `pace-patch` is GSW's only other near-miss
shape on this phone and the web export's only input close to the line; the other three miss by
3x to 20x.

**Phone/desktop ratio** (4.3x to 11.6x on p50, this table) is in the same band D27 predicted for
GSW (4-5x) at the low end but runs higher on the small-delta inputs (`apply` on `pace-patch`,
11.6x) -- consistent with a fixed per-call GDScript/wasm overhead that a tiny transaction can't
amortize, the same shape the decode profile found for GDScript generally (`_check_resolved_
invariants` is a ~595 us constant per transaction on desktop, native).

**wasm overhead, isolated** (this worktree's web-export desktop numbers against G7d's *native*
desktop numbers, same GDScript, same machine, decode p50 ms): scene-full 9.472 vs 6.53 (1.45x),
scene-patch 1.696 vs 1.06 (1.60x), hd-patch 16.896 vs 12.54 (1.35x), pace-patch 0.592 vs 0.34
(1.74x) -- squarely inside Q13e's "wasm adds 1.3-2x against native Godot" prediction.

**Top bottleneck phase.** `decode` (which bundles framing, validation and resolve) is the larger
share on every input -- 88 % of `scene-full`'s p50 total, 80 % of `pace-patch`'s -- except
`hd-patch`, where `apply` is nearly as large (64.512 of 140.288 ms, 46 %). The within-`decode`
breakdown is already measured in "Receiver decode profile" above (GDScript, same receiver code):
`_check_resolved_invariants` alone is 42-61 % of `accept_record` on the patch-shaped inputs and a
constant ~595 us regardless of how little changed, which is why `scene-patch` and `pace-patch` --
tiny per-transaction deltas -- still miss: there is little to amortize a fixed, O(resolved-state)
cost against. `hd-patch`'s apply cost tracks its 496-item resolved state the same way (`needed()`
and the item/texture/order passes walk every item).

**CPU frequency and thermal**, sampled every 30 s for the whole ~1052 s run (`device-samples-g31-
web.json`; a separate pace-patch recheck below has its own, shorter sample set):

- **Every in-run sample stayed uncapped**: A55 `scaling_max_khz` 1 800 000 of `cpuinfo_max_khz`
  1 800 000 and A75 2 000 000 of 2 000 000 (`derated: false`) at every 30-s mark from t=0 to
  t=1020 s, across all four inputs' warmup-plus-five-repeats. `scaling_cur_khz` dipped under the
  normal governor between legs (A55 observed down to 1 275 000 at idle moments), not a throttle.
- **Only the very last sample, taken while the harness was closing the browser/adb session (not
  during a benched leg), showed a cap**: A55 900 000 / A75 998 000 (`derated: true`) at t=1050 s,
  recovering to full (`scaling_max_freq` 1 800 000 / 2 000 000 unrooted-read) within about two
  minutes after the run ended. **The standalone pace-patch recheck below reproduces the identical
  pattern on a 92-s run** (uncapped at t=0/30/60/90 s, capped only at its final t=92 s sample) --
  this is a teardown artifact of closing the session, not sustained thermal throttling during the
  benched legs, and it does not touch the reported numbers (every repeat ran before it).
- Thermal status stayed `none`/0 throughout (CPU/GPU/NPU sensor ceiling 45.5 C, briefly 47.8-49.2 C
  mid-run). Battery held 100 % (charging on USB); battery temperature rose 22.9 to 27.6 C over the
  ~17.5-minute run. Session settings (stay-awake, rotation) were applied and fully restored on both
  runs; no adb forward/reverse was left behind.

**The pace-patch recheck.** In the main run, `pace-patch`'s fifth repeat took 167.3 s of wall clock
against ~14.2-14.5 s for its other four repeats and the other inputs' every repeat (coincident with
the tail-end cpufreq sample above, though that sample is itself post-leg). Because `pace-patch`'s
miss was the narrowest (+7.7 % over budget) and a stalled repeat could plausibly have skewed its
p95, a standalone `--only pace-patch` rerun (fresh device session, five clean ~14.2-14.5 s repeats,
no anomaly) reproduced the same miss almost exactly: decode 4.480/6.784 -> 4.736/7.040 ms, apply
1.120/2.240 -> 1.184/2.112 ms, total p95 9.024 -> 9.152 ms. The table above reports the clean
recheck; the verdict is unchanged either way.

### Deviations

- **No new `--bench` export or embedded-recording entry scene was built.** Q13e's design text
  anticipated one because, when it was written, nothing had proven the general web export's
  HTTPClient source-fetch path could serve a bench's inputs. G7e proved exactly that (gate 0's web
  legs already fetch `RS_RECEIVER_RECORDING` from a same-origin URL into memory), so the web arm
  reuses the one `build-web-receiver.sh` bundle verbatim, mapping each bench repeat's env the same
  way `lib/gate7-web-legs.ts` already maps a native leg's `env.txt` to the web.
- **The canvas size must equal each input's session `logical_size`.** A browser is never
  `DisplayServer.get_name() == "headless"`, so `receiver.gd`'s hard viewport-mismatch check applies
  (native and GSW never hit it). `scene-*`/`pace-patch` use the project's 640x360 default;
  `hd-patch` needs 1920x1080 (gate6-hd's own fixture size, `run-gate7.sh` `HD_FIXTURE_DIR`). This
  is a small hardcoded table in `gate7-bench.ts` (`WEB_CANVAS_SIZE`), not derived from the
  recording, since only these four named bench inputs exist today.
- **`hd-patch`'s warmup timed out once** (180 s) on its first page load of the run, before any
  repeat; repeat 0 then completed in 45.7 s and every later repeat was consistent with it. The
  warmup's result is never read (matching native's own warmup-fills-the-cache design), so this did
  not affect the reported numbers; it reads as a one-time cold-start cost (GPU/shader pipeline or
  wasm module warm-up on first navigation), not a sustained problem.
- **The desktop web arm (`ctl-bench-<input>-web`) now runs too**, closing G7d's "stubbed
  `unavailable`" gap for the web export; its numbers are folded into the table above and
  `gate7d-checks.ts`'s `${leg}-unavailable-recorded` special case was removed in favour of the same
  `${leg}-complete` check native and GSW already use, plus a new `bench-web-browser-provenance` /
  `bench-web-device-provenance` check mirroring GSW's.
- `--bench-inputs` reused this worktree's copy of G7d's final desktop run's recordings (same
  `g7d-r1`-derived `inputs.json` G7m's GSW arm used), not regenerated.
- The g86 arm did not run (not attached; out of scope here, as for the GSW arm).

### What this increment does not prove

It does not cover the g86, GSW's apply cost (G7a's applier, G7v), or live mode on the web (G7l).
With the web export now measured `device-decode-over-budget` on every input, G7o's web-export
tier-1 candidates (already ranked against the desktop decode profile in "G7o candidates, ranked
against the g31" below -- delta-driven `_check_resolved_invariants`/`needed()`/apply, packed-array
lifting, schema paths on failure only) are now the binding ones for closing the web export's gap,
not just an estimate.

