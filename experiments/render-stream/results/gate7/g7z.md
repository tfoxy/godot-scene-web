## Gate 7z result (2026-10-24)

G7z ([protocol/gate7/g7z.md](../../protocol/gate7/g7z.md), gate7-design.md Q11) writes gate 7's
three `render-stream-features/2` manifests, judges Q11's seven manifest checks per receiver, and
makes gate 7's closing run: every group on one build, gates −1 to 6 on that build, and the g31 on
both browser receivers. **Gate 7 is declared passed on build 6a454065** (main with G7rf, so G7kh
0fc739f7, G7w2c d78be95f and G7kr 099a92f9 are in it) — every group green on that build (one
load-sensitive g7-lc sabotage row passed on its one permitted rerun), gates −1 to 6 green on it, the
g31 run on it on both browsers, and all seven g7-z checks pass on all three receivers. The summary is
[../gate7.md](../gate7.md).

The manifests and every number below describe the **6a454065 build**. G7z's own diff is tooling,
manifests and docs; G8f d0911ac1 (float texture formats) and G8r 489c05c8 (pre-arm adoption) landed
on main while the run was going and change capture, rs-core and receiver code, so these manifests
describe 6a454065, not main at landing.

### What G7z adds

- `scripts/make-features.ts --receiver native|web-export|gsw-canvas|all [--check]` writes
  [protocol/features/render-stream-7/](../../protocol/features/render-stream-7/) `native.json`,
  `web-export.json` and `gsw-canvas.json`; `--collect [--evidence-root]` derives the receiver
  blocks (from the native gate 6 run and the browsers' g7-6 **file** runs) and the g31 device
  targets into `collected.json`. Generation is pure, so `--check` survives evidence pruning.
- `scripts/lib/feature-evidence-7.ts`: the per-receiver evidence map. Every file has the same 123
  entry ids (render-stream-6.json's 115 plus eight /7 entries). Each browser translates every /1
  reference to its own leg and check; an entry no browser leg replays is `declared-unverified`
  for that browser, with the gap named. `EVIDENCE_RUNS` names the run each group@kind is quoted
  from: every row is this closing run (`gate7/g7z/`).
- `scripts/lib/gate7z-checks.ts` and `check-gate7.ts --legs g7-z [--evidence-root <dir>]`: the
  seven checks per receiver kind plus a report-only `evidence-builds` row. A check whose evidence
  does not exist yet is `pending` (a failure, never a pass).
- `run-gate7.sh --manifest-hello`: every live hello sends its kind's file sha256 (browsers through
  the daemon's `GATE7_MANIFEST_SHA256_<KIND>`, native through `lib/gate6c-legs.sh`'s /7 path).
- `scripts/test/self-test-gate7z.ts` (pure, synthetic evidence root): 35/35, one mutation per
  check (stale file, failed evidence, substituted evidence, an unlisted refusal, a wrong hello
  sha, a claimed `met`, a target on another build, a native `met`).

Two harness bugs the closing run hit, fixed here (neither changes a verdict on evidence that
judged before):

- **A gate 6 view wrote into its source.** The GSW and web adapters judge a browser's g7-6 legs
  by running gate 6's own checker on a view of the native source run (symlinks). g6c's
  `writeLegReport` rewrites each rate leg's `report-set/` and `render-stream-report.json`, so
  through a link it rewrote the source run's reports with the view's id. When the source comes
  from the GRT source cache, which is read-only, the write fails (`EACCES`) and the whole g7-gsw
  check aborts: this run's native gate 6 published the source before the g7 phase reused it,
  which the sweeps' phase order (gate 6 last) never did. `lib/gate7-adapters.ts`
  `CHECKER_WRITES` names the paths a checker writes; both views (`gate7-gsw.ts` `buildView`,
  `gate7b-adapters.ts`) leave them for the checker to create in the view and make their parents
  real directories. The g7-gsw run was re-judged (legs untouched): rc 0.
- **A device leg without `applied.json` crashed the g7-dev checker.** `pacedLoopProblems`
  (`lib/gate7-live.ts`) dereferenced a missing document; it now fails
  `credit-from-paced-loop` by name.

### The closing run

One worktree at 6a454065 plus this diff, run locally (remote runs keep only verdicts, and the
manifests need per-check reports), 2026-10-23 21:16 to 02:25 2026-10-24 (-03:00). Evidence under
`artifacts/render-stream/gate7/g7z/` of the main checkout. Order, so the manifest bytes every
live hello carries were final before the first hello: native gates and the browser file groups,
the g31 runs, `make-features.ts --collect` and `--receiver all` (shas frozen in
`g7z/manifest-shas-frozen.txt`), then every live group with `--manifest-hello`, then g7-z.

| Run | Path (`gate7/g7z/…`) | Result |
| --- | --- | --- |
| setup: `pure` (71 self-tests), `lock-tests`, `capture-build`, cargo `rs-core`, `rs-core-capi`, `decode-proto-rs`, `pnpm-test` (2518 tests) | `va/`; `pure-final/` | pass (`pure` rerun on the final code after the two fixes: 71/71) |
| `cargo-gsw-rs` | `va/cargo-gsw-rs` | rc 101, **known** (E0432: `CanvasItemsExecutor` gated behind `wasm32`) |
| `bench-instr` | `va/bench-instr` | rc 3: valgrind is not installed locally; its producer is the remote job (not a gate 7 group) |
| native gates −1, 0, 1, 2, 3, 4, 5, 5.5 (sabotage legs, fast frames on the allowlisted legs) | `va/native-rust-gate*/run` | pass: 29/29 criteria, 24, 66, 91, 56, 185, 131, 130 checks |
| native gate 6 (every group incl. g6z, sabotages; recordings kept for g7-z) | `vg6/native-rust-gate6/run` | pass, 154/154 |
| g7-0..g7-6 file legs, gsw | `va/g7-gsw/run` | pass after re-judge (see "What G7z adds"): 25, 30, 38/39, 32, 69/71, 42/44, 49/51, 37/38 (the rest report-only) |
| g7-0..g7-6 file legs, web/rust | `va/g7-web-rust/run` | pass: 22, 30, 31/35, 36, 72/74, 47/49, 47/49, 34/36 (the rest report-only) |
| g7x (desktop g7-dev and g7-bench) | `va/g7x/run` | pass: 36 checks, group checks 29/29 |
| live g7-1, g7-5, g7-55 (fast frames) | `live/{gsw,web}-corr/run` | gsw 38, 19, 19; web 39, 20, 20: all pass (`resync-full` on both) |
| live g7-2 | `live/{gsw,web}-g7-2/run` | gsw 40, web 41: all pass (web `live-vs-reference` and `drop-resource` included, at load 2.6–3.7) |
| live g7-6, g7-lc, g7-k, window 2 (real time) | `live/{gsw,web}-timing/run` | web 26, 66, 29/33: pass (3 `unavailable` desktop real-suspension rows, 2 `known-shortfall` `rss-bounded-renderer` rows). gsw 25, 69/70, 39/45: one g7-lc sabotage row over its set under load (below) |
| live g7-lc gsw, the one rerun (real time) | `live/gsw-g7-lc-rerun/run` | 70/70 (4 `unavailable`) at load 2.3–4.3 |
| g7-r, window 2 (real time) | `live/{native,gsw,web}-g7-r/run` | native 32, gsw 41, web 42/43 (`phase-summary@web` report-only): pass |
| g7-r, `--credit-window 1` (real time) | `live/{native,gsw,web}-g7-r-w1/run` | native 44/46, gsw 61, web 80/82 (the rest `phase-summary` report-only): pass |
| g31 g7-dev, gsw, window 2 | `g31-gsw/run` | ran; Q13d: not met (see "Device targets") |
| g31 g7-dev, web/rust, window 2 | `g31-web/run` | ran; Q13d: not met |

**The g31 gsw run lost Chrome once.** At 22:40:09 Android's ActivityManager killed the phone's
Chrome as a cached "empty" process (the Android Auto car service was starting), so
`dev-gpu-headroom-hd-r1..r5` timed out on `Runtime.enable` and wrote no `applied.json`, and the
g7-dev checker crashed on them (fixed above). The web run that followed found no Chrome devtools
socket and stopped at once (`g31-web-attempt1/`). Chrome was relaunched (`am start`), the six
hd-headroom legs were rerun on the same build and bundle (`g31-gsw-hdh/run`) and copied into
`g31-gsw/run` (the first attempt's six are in `g31-gsw/attempt1-gpu-headroom-hd/`,
`g31-gsw/SPLICE.txt`), the run re-judged, and the web run repeated. Battery 100 % on USB power
throughout; battery temperature 26.4 → 28.7 °C; Android thermal status 0 before and after every
run; no harness tab left open (the two remaining tabs predate the run).

### The three manifests

| | native | web-export | gsw-canvas |
| --- | --- | --- | --- |
| file sha256 (the hellos' `manifest_sha256`) | `efdc1152…` | `316cf617…` | `b069dbef…` |
| build (`receiver.build.sha256`) | template `54cc2284…` + rs-core GDExtension | bundle `d2a55ca9…` (template `68162ae9…`) | bundle `3955c721…` |
| commit | 6a454065 | 6a454065 | 6a454065 |
| platform | GL 3.3 compat, NVIDIA RTX 2060 | Chromium 148 (chromium-1223), ANGLE/Vulkan | Chromium 148 (chromium-1223), ANGLE/Vulkan |
| `supported` | 64 (exact 55, repeat-budget 1, n/a 8) | 66 (delta1 54, exact 1, repeat-budget 1, n/a 10) | 66 (band 50, exact 4, delta1 1, repeat-budget 1, n/a 10) |
| `receiver-typed` | none | `cache-budget-unsupported` (`delivery.disk_cache_budget`) | none |
| `declared-unverified` | 7 | 7 | 8 |
| `typed-unsupported` / `unobserved` | 20 / 32 | 20 / 29 | 20 / 29 |
| credit windows | [1, 2], default 2 | [1, 2], default 2 | [1, 2], default 2 |
| cache / fetch concurrency | memory+disk / 1 | memory+http-cache / 1 | memory+http-cache / 1 |
| WebGL compression extensions | – | s3tc, s3tc_srgb | s3tc, s3tc_srgb |
| `max_texture_size` | null | null | null |

Headline per receiver: **native** supports 64 of 123 entries and refuses 20 typed; **web-export**
supports 66, refuses 20 typed plus its own `cache-budget-unsupported`, and its g31 targets are
not met; **gsw-canvas** supports 66 and refuses 20 typed, and its g31 window-2 targets are
`not-met` by Q13d with `acceptance: met with measured shortfall` (F3 (a)).

`band` is GSW's Q7 view: decided pixels exact, delta1 and undecided regions counted, tied to a
`fixtures/gsw-tolerance.json` gate id (`gate6` for most scene entries). The web export's `delta1`
is G7b's band (readback rounding ∪ one level per channel). `declared-unverified` on every
receiver: the transpile-subset shader, the canvas-stacking tie, the global canvas transform and
three stretch variants, which no gate leg exercises; on the browsers also the snap pair (no
browser replays gate 6's snap variant); on native `delivery.live_token_and_origin` (the native
receiver sends no Origin); on GSW the file-mode disk budget. **The web export's
`rss-bounded-renderer` is not cited** (`delivery.soak_memory_bounded` cites the residency, wasm-heap
and GPU bounds): it is G7kr's report-only `known-shortfall`, owner G7kw2. `max_texture_size` is
null on purpose: no evidence file records it and no leg uploads near it.

### Device targets (the g31; the g86 is descoped)

Drawn and published per second are the mean of five repeats (`collected.json`).

| Receiver | Window | Workload | Status (Q13d) | Acceptance | Drawn / published per s | Failing checks | Run (build) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gsw | 2 | pace | not-met | **met with measured shortfall** (F3 (a)) | 57.80 / 59.89 | `dev-cadence` (pace and its headroom leg), `dev-gpu-headroom` | `g31-gsw` (6a454065) |
| gsw | 2 | scene | not-met | **met with measured shortfall** (F3 (a)) | 54.11 / 57.99 | `dev-rate`, `dev-cadence`, `dev-gpu-headroom` | same |
| gsw | 2 | hd (stretch) | not-met | stretch miss, accepted as measured | 5.05 / 8.77 | rate, cadence, main thread, GPU, headroom | same |
| web | 2 | pace | not-met | not met | 56.06 / 57.71 | `dev-rate`, `dev-cadence`, `dev-main-thread` | `g31-web` (6a454065) |
| web | 2 | scene | not-met | not met | 16.72 / 19.61 | `dev-rate`, `dev-cadence`, `dev-main-thread` | same |
| web | 2 | hd (stretch) | not-met | stretch miss, accepted as measured | 0.18 / 0.34 | rate, cadence, main thread, `dev-presence` | same |
| gsw | 1 | pace / scene / hd | unverified | not met at window 1 | 47.0 / 35.9 / 4.4 | rate, cadence, unthrottled | G7v `g7v-g31-gsw` (bundle `f4548380`) |
| web | 1 | pace / scene / hd | unverified | not met | 27.8 / 8.7 / 0.30 | rate, cadence, main thread | G7v `g7v-g31-web` (bundle `dcdbc5b4`) |

Window 1 was not rerun on this build (window 2 is the default, G7wd), so those six targets quote
G7v's runs and are `unverified` here by D28. On the g31: T_p 17.0 ms (rAF p50) on every gsw
repeat and on web pace; the web export's scene and hd repeats measured 17.0–33.9 and 51–68 ms,
because its rAF is its own main loop (the page's iteration time, not the panel); panel 60 Hz, its
only mode (dumpsys); Chrome 155.0.8059.84 (the phone updated from G7v's 154); thermal `none`
before and after every leg; the A75 frequency cap read `derated` on some 30-s samples
(report-only). Main-thread p95 (median of five): gsw pace 4.6, scene 7.9, hd 29.3 ms; web pace
14.5, scene 34.3, hd 65.0 ms. First submitted frame (median): gsw 0.79–1.69 s, web 7.7–9.0 s.

### g7-z

`check-gate7.ts --legs g7-z --evidence-root <main>/artifacts/render-stream/gate7`, after every
run, into `g7z/g7-z/`:

| Check | native | web | gsw |
| --- | --- | --- | --- |
| `manifest-check` | pass | pass | pass |
| `manifest-matches-session` | pass (4 sessions) | pass (4) | pass (4) |
| `manifest-evidence` | pass (106 checks) | pass (95) | pass (97) |
| `manifest-no-substitution` | pass (own evidence) | pass | pass |
| `manifest-refused` | pass ({}) | pass ({`cache-budget-unsupported`}) | pass ({}) |
| `manifest-matches-hello` | pass (6 hellos, `efdc1152…`) | pass (195, `316cf617…`) | pass (201, `b069dbef…`) |
| `manifest-device-target` | pass (6, not-applicable) | pass (6) | pass (6) |
| `evidence-builds` (report) | every run on 6a454065 | same | same |

`manifest-matches-session` decoded native gate 6's `scene/capture`, `scene/capture-inline`,
`animate/capture` and `hd/capture-native` recordings (`vg6/native-rust-gate6/run`), kept until
now. `self-test-gate7z.ts` 35/35 on the final code.

### Labelled failures (not chased, per the brief)

- `cargo-gsw-rs` rc 101 (known: an E0432 import of a `wasm32`-gated item).
- `bench-instr` rc 3: valgrind is not installed on this machine; not a gate 7 group.
- `rss-bounded-renderer@web` (g7-k): report-only `known-shortfall`, 9.93 MB/min post-GC against
  2 MiB/min (owner G7kw2); also on web `no-evict`. Never a pass, never gating.
- `sabotage@gsw:sabotage-ack-while-hidden` (g7-lc, first run): failed `host-unperturbed` beyond
  its set (host frame-interval p95 +14.9 % at a 1-min load of 9 to 12); passed on its one rerun.
- gsw g7-5 `gsw-vs-native@gsw` (max delta 1, P-G3) and `compositor-equals-readback-g5-mesh@gsw`
  (the mesh leg's last shot is not its exit state): non-passing, both non-gating rows here.
- Not seen in this run (each was on the brief's known list): the g7-2
  web fold/seq flakes (`drop-resource@web` passed); `self-test-report` and `lock-tests` (both
  passed); `host-unperturbed-constrained@web` (passed in both g7-r runs, 17 362 and 17 359 µs,
  at loads 2.5–4.4).
- The 5 known tsc errors in `gate2b-checks.ts` (`tsc -p experiments/render-stream`): unchanged,
  no other.
- **g7-2 web `live-vs-reference` (G8f's report, owner G7lw)**: did not reproduce here (passed at
  load 2.6–3.7: 12/12 shots on every leg), which fits contention-dependence; not disproven, and
  not a manifest entry this run cites as failing.

### Deviations

- **Six device targets per browser, not twelve**: the g86 is descoped (g7z.md amendment).
- **`acceptance` beside `status`**: Q13d's verdict stays the status; the user's F3 (a) decision is
  recorded next to it, never instead of it.
- **Window 1 on the g31 quotes G7v** (unverified on this build): the brief made it optional
  ("if cheap"); a g31 window costs about 25 min (web) to 90 min (gsw).
- **The receiver blocks come from the browsers' g7-6 file runs**, not the live g7-6 run: every
  live hello carries the file's sha256, so the file cannot be generated from a live run.
- **A spliced device run**: `g31-gsw/run` holds the rerun's six hd-headroom legs (above).
- **Extra fields**: `evidence_runs`, `limits.receiver.default_credit_window`, and per target
  `t_p_ms`, `panel_mode`, `thermal`, `freq_cap_derated`, `published_hz`, `drawn_hz`, `run_build`,
  `acceptance`, `notes`.
- **Result text lives here and in [../gate7.md](../gate7.md)**; the README links both (its "Docs
  layout" makes it an index).

### Time

About 5 h 35 min of wall time (21:16 to 02:50), nearly all of it waiting on real-time legs and
the lock; three agents shared the machine (G8f and G8r landed during it).

| Phase | Wall | Notes |
| --- | --- | --- |
| setup (rebase, install, capture, import, rs-core ext) | ~5 min | |
| g31: gsw 91 min, hd-headroom rerun 10 min, web 22 min, Chrome diagnosis | ~2 h 10 min (21:21–23:29) | in parallel with the next two |
| native gates −1..5.5, setup runs, file groups, g7x (`va/`) | 2 h 47 min (21:30–00:17) | lock wait summed over runs ~18.5 h, most of it the file groups' legs queued behind exclusive timing legs |
| native gate 6 (`vg6/`) | 1 h 43 min | lock wait 50 min |
| two harness fixes and the g7-gsw re-judge | ~40 min | during the above |
| manifests, then every live run in three chains | 2 h 22 min (00:02–02:24) | |
| g7-z, docs, landing | ~25 min after the runs | the docs were written while the live runs ran |

### Traps

- `defaultEvidenceRoot()` prefers the worktree's own `artifacts/render-stream/gate7/` as soon as
  it exists (a g7x run creates `g7x/` there), so `--collect` and g7-z need `--evidence-root
  <main checkout>/artifacts/render-stream/gate7` from a worktree.
- Running native gate 6 before the g7 file groups publishes its source to the read-only source
  cache, which exposed the view write (fixed). The sweeps' phase order hid it.
- The g31's Chrome can be killed as a cached process mid-run; the harness does not relaunch it,
  and with Chrome gone it forwards to another app's devtools socket
  (`stetho_com.google.android.apps.messaging_devtools_remote`). Check `pidof com.android.chrome`
  before a device run.
- The live hello's sha covers the whole manifest, `evidence_runs` included, so every quoted path
  is fixed before the live runs, and a rerun replaces its run in place.
