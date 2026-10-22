## Gate 7p result (2026-10-22)

G7p ([protocol/gate7/g7p.md](../../protocol/gate7/g7p.md), gate7-design.md Q12 "Matrix (G7p)") adds
`render-stream-report/2`, the `g7-p` matrix driver and the checks that judge them. The report schema,
the generator, the driver and every check are proven by a self-test with sabotages
(`scripts/test/self-test-gate7p.ts`, 50 assertions) and by a real run on all three receivers. **The
matrix that ran is a declared subset of Q12's, not the whole of it** (release first, user 2026-10-22:
no extra measurement campaigns); the gap is listed under "What ran" and "Deviations". **The g86 is
descoped (user, 2026-10-22: "Moto G86 arms are not needed. Moto G31 is enough."): no g86 row is
required, none is pending.**

**The gsw device rows are present (rebased on G7v).** G7p's branch now sits on G7v's commit
(`1633c0f0`), and the gsw matrix was re-run on it. A bundle built in this worktree still cannot carry
G7v's sha: the sources are identical to G7v's (`receiver.html` and `receiver.js` hash the same, no Rust
differs) but the wasm is not reproducible across worktree paths (`rs_gsw_wasm_bg.wasm`: same 1643619
bytes, about 50k bytes differ, the 20 panic-location strings carry `.worktrees/g7p` vs `.worktrees/g7v`,
and the path-dependent crate metadata hash changes the symbols; two builds in one worktree, across
four commits, are byte-identical). The gsw legs therefore ran G7v's own gsw bundle
(`run-gate7.sh --gsw-bundle`, a copy of G7v's `gsw-bundle/`, `f4548380d0bf`): the same build the phone
measured, so `device-rows-present` passes for gsw with 9 rows, none omitted. The earlier gsw numbers
(bundle `85d91ace03d9`, five scenarios including `hd-half-rate-60` and `scene-constrained-60`) are not
in the report any more: the contended re-run (other agents' exclusive timing legs held the machine for
most of an hour) could only complete `scene-rate-60`, `scene-rate-60-cold` and `scene-rate-60-w2`, so
the gsw declared subset is those three. Those two scenarios on the previous bundle were: `hd-half-rate-60`
15.6/s published, hold 9.7 / 163.9 ms; `scene-constrained-60` 5.1/s, hold 69.4 / 193.0 ms, credit RTT
172.9 ms (history, not evidence in the report).

**User decisions (2026-10-22).** (1) **Phone criterion**: GSW at credit window 2 is accepted as gate 7's
phone receiver under F3(a), "met with a measured shortfall" (G7v's g31 rows above); the web export is
recorded **not met**. (2) **Window 2 becomes the default** (fork F1) in a separate increment; this
increment changes no runtime default. `render-stream-report/2` has no field naming a planned default
window, so the decision is recorded here only; each scenario's `config.credit_window` says which window
it ran.

### What report/2 contains

One report per receiver kind (`provenance.receiver.kind`: `native`, `web-export`, `gsw-canvas`),
`<out>/render-stream-report-<native|web|gsw>.json`. `validate` accepts /1 and /2
(`scripts/lib/render-stream-report.ts`); `pnpm render-stream:report2 -- validate|build`
(`scripts/report-gate7.ts`).

- **`provenance`**: /1's, plus `env` (`{kind: desktop|device, device_id, device, panel}`), `receiver.kind`,
  `receiver.browser` (`product`, `version`, `revision: chromium-1223`, `sha256`, `args`, `renderer`,
  `extensions_hash`) and `receiver.bundle` (`sha256` = `RS_RECEIVER_BUILD_SHA256`, `bytes`), both null
  for the native receiver, and `timing.receiver_clock` = `performance.now` for browsers.
- **`scenarios[].config`**: `receiver_kind`, `credit_window`, `late_poll`, `fetch_concurrency` (always 1)
  and `cache` (`cold`, `warm`, or `warm-http` for a browser's shared profile).
- **`repeats[].stages`**: `recv_raf_interval_us`, `recv_raf_after_submit_us` (GSW), `recv_gpu_complete_us`
  (GSW only), `recv_hold_us` (received to submitted) and `recv_preflight_us` (`unavailable`);
  `repeats[].startup` (`null`). GSW's perf.json histograms are summary-form (`p50`, `p95`): their
  dists carry p99 = p95 and say so in `source`. G6c's bucket reader would have reported p50 0 for them
  (it still does for GSW's base `recv_*` stages; G7p overrides those four in its repeats).
- **`device_rows`** (browser kinds): one row per phone, receiver, window and workload: `device_id`,
  `env` (the phone's perf-report/1 `env.device` block: model, androidRelease, chrome, battery and
  thermal before and after, warnings, serial, manufacturer, isolation, viewport; plus the panel),
  `build.bundle_sha256`, the repeats in Q12's device stage names (`recv_main_thread_us`,
  `recv_new_frame_interval_us`, `recv_credit_rtt_host_frames`, `recv_multi_apply_ticks`,
  `content_update_hz`, `activation_gap_ms` as G7v wrote them), `summary` (valid and invalid repeats and
  the mean drawn rate over the valid ones), and `control` (the desktop control row from G7v's
  `ctl:` run). `omitted_device_rows` names every row left out and why. `device_startup` carries the
  phone's startup summary.
- **Rules `validate` enforces for /2**: `env` present and consistent (a device has a `device_id` and an
  `env.device` with model, androidRelease and chrome; a desktop has neither); a native receiver has no
  browser or bundle; the receiver clock matches the kind; `presented` unavailable everywhere;
  `recv_gpu_render_ms` never measured for a browser; `recv_gpu_complete_us` measured only for
  `gsw-canvas`; a device row's bundle equals the report's (`stale-build`); a Q13b-watchdog repeat
  (hidden time, a rAF gap over 250 ms, or thermal not `none` before or after) is `invalid` with its
  reason and never averaged into the row's summary (`invalid-averaged`).

### What ran

Warm cache is one warmup plus five repeats, realtime, hook log off, window 1 unless `w2`, on the
Ryzen 5 5500 box under other agents' load (load average 7 to 17 throughout; G7v's sweep and this
increment's own full tier ran beside it, so these are report-shape evidence, not rate measurements).
Published/s is the median of five repeats; "hold" is received to submitted (p50 / p95 of the
repeats' p95s); `-` is a metric a repeat could not measure (see the web row).

| Receiver | Scenario | Published/s | Hold p50 / p95 ms | RAF interval p50 ms | gpu_complete p50 ms | Credit RTT p50 ms |
| --- | --- | --- | --- | --- | --- | --- |
| native (/7) | scene-rate-60 | 58.1 | 2.3 / 3.7 | n/a | n/a | 6.8 |
| native (/7) | scene-rate-60-cold | 59.0 | 2.1 / 18.1 | n/a | n/a | 5.5 |
| native (/7) | scene-rate-60-w2 | 60.0 | 2.1 / 3.2 | n/a | n/a | 13.2 |
| web-export | scene-rate-60 | - (3 of 5 repeats) | 4.6 / 21.6 | 16.78 | n/a | 17.6 |
| web-export | scene-rate-60-cold | 29.1 | 3.4 / 21.6 | 16.85 | n/a | 19.6 |
| web-export | scene-rate-60-w2 | 59.7 | 2.4 / 19.4 | 16.89 | n/a | 13.1 |
| gsw-canvas | scene-rate-60 | 59.1 | 9.2 / 25.8 | 16.70 | 16.4 | 9.5 |
| gsw-canvas | scene-rate-60-cold | 57.6 | 14.6 / 31.0 | 16.70 | 16.4 | 15.1 |
| gsw-canvas | scene-rate-60-w2 | 59.8 | 11.9 / 28.6 | 16.70 | 16.4 | 12.5 |

Window 2 publishes 59 to 60 per second on all three receivers where window 1 publishes 55 (gsw),
58 (native) and 29 to 43 (web) on the repeats that measured, which is G7q's finding again on the
matrix's own scenario. The web export's `scene-rate-60` published rate is `unavailable` on repeats 3
and 5: the page joined the host's window late (the host sent 514 of its 1083 transactions to repeat
3), so G6c's measure refused to read a rate from that leg; the other three repeats are 29 to 43 per
second. The aggregate drops the metric rather than averaging three repeats of five.

The per-metric CoV across five repeats exceeds 10 % on 28 (native), 46 (web) and 70 (gsw) metrics,
named by `repeat-stability` in `result.json`; most are the host-side p50s of a loaded machine and the
phase-dependent credit RTT, and none is averaged away.

**Device rows (web-export, 7 rows, bundle `dcdbc5b4b1fc` on both sides).** g31 drawn per second, mean of
five repeats (desktop control in brackets, `pace` and `scene` only), window 1 then window 2: pace
27.8 (57.8) then 55.9 (59.9); scene 8.7 (56.1) then 15.8 (58.1); hd 0.30 then 0.20; plus window 1's
`maxfps60-scene` 9.2. No repeat was `invalid`. Each row carries `env.device` (moto g31, Android 12,
Chrome 154, thermal and battery before and after, viewport 828x330 at DPR 2.625) and its panel (T_p
17.0 to 17.2 ms for pace and scene). These are G7v's numbers; G7p only carries them in the report.
**Device rows (gsw-canvas, 9 rows, bundle `f4548380d0bf` on both sides).** g31 drawn per second, mean of
the valid repeats, window 1 then window 2: pace 46.5 (4 valid, 1 invalid) then 58.1; scene 35.9 (4 valid,
1 invalid) then 54.3; hd 4.4 then 8.5; plus window 2's three `gpu-headroom-*` rows (pace 58.0, scene 54.2,
hd 7.5). The invalid repeats are the Q13b watchdog's (named in each row). These are G7v's numbers.

### Checks

| Check | native | web | gsw |
| --- | --- | --- | --- |
| `clean-exit` | pass | pass | pass |
| `after-window-shots` (exact for native, Q7's band for a browser) | pass | pass | pass |
| `report-valid` | pass | pass (7 device rows) | pass |
| `report-complete` (declared subset) | pass 3/3 | pass 3/3 | pass 3/3 |
| `repeat-stability` (CoV > 10 % named) | pass (28 named) | pass (46 named) | pass (29 named) |
| `device-rows-present` | pass (n/a, no phone rows) | pass (7 rows) | pass (9 rows) |

### Sabotages and self-tests

`scripts/test/self-test-gate7p.ts` (50 assertions; part of `run-pure-self-tests.sh`) shows each check
can fail:

- `report-valid`: no `provenance.env`; a native receiver with a browser block; a browser with the engine
  clock; `recv_gpu_complete_us` measured on the web export; `presented` measured; a missing /2 stage;
  a device row built on another bundle (`stale-build`); a device row without `env.device`; an invalid
  repeat averaged into its row (`invalid-averaged`); an unknown schema. A /1 report still validates.
- `report-complete`: `g7pScenarios` lists exactly Q12's matrix per kind and window (window 2 is
  `scene-rate-60` only; native has no `hd` or `constrained`), and a missing scenario directory or
  report scenario names itself. The real run's own verdict names the three scenarios of the full matrix
  it did not declare.
- `repeat-stability`: a noisy scenario's metrics are named with their CoV, a steady one names nothing,
  and a scenario with no aggregate fails.
- `after-window-shots`: an identical final shot passes; a shot of a frame before step 11 and a pixel
  beyond Q7's band each fail (`bandedFinalState`).
- `device-rows-present`: a complete set passes; a missing row, a missing desktop control row, a build
  that is not the report's, a missing `env.device`, a wrong `device_id` and an all-omitted kind each
  fail; a row replaced by an omission that names it passes. `loadDeviceRows` omits and names a row when
  the build has moved, which the first gsw run on the un-rebased tree also showed (9 rows). The watchdog marks hidden time, a
  289-ms rAF gap and a warm phone invalid.

### Re-running

```bash
# whole matrix, per kind and window (hours; G7P_SCENARIOS and G7P_WINDOWS narrow it)
experiments/render-stream/scripts/run-gate7.sh --live --legs g7-p --out artifacts/render-stream/gate7/g7p-<name>
# in pieces, then judged together (the runner refuses a non-empty --out)
experiments/render-stream/scripts/lib/compose-g7p.sh <out> <piece>...
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/check-gate7.ts \
  --out <out> --legs g7-p --live --device-evidence <g7v web>,<g7v gsw>,<g7v gsw-w2>,<g7v ctl run> \
  --g7p-scenarios scene-rate-60,scene-rate-60-cold,scene-rate-60-w2
```

This result's evidence is `artifacts/render-stream/gate7/g7p-final3/` (composed from `g7p-gsw-w1b`,
`g7p-gsw-w2b` (both with `--gsw-bundle g7v-gsw-bundle`, a copy of G7v's bundle), `g7p-mini3`,
`g7p-r-native-*` and `g7p-r-web-*`; the three reports and `result.json`). The native and web pieces
ran before the rebase on G7v (the rebase changes no file those legs read; the web export's bundle is
the same on both sides). The earlier un-rebased composition is `g7p-final/`, its first rebased gsw
attempt (own bundle, 9 rows omitted) `g7p-final2/`.

### Deviations

- **Declared subset.** Ran: `scene-rate-60`, `scene-rate-60-cold` and `scene-rate-60-w2` on all three
  receivers. Not run: `scene-rate-15`, `-30`, `-uncapped-host60`, `hd-native-rate-60` on every receiver,
  `hd-half-rate-60` and `scene-constrained-60` on all three (gsw ran both on its pre-rebase bundle, see
  above; the re-run on G7v's bundle was starved by other agents' exclusive timing legs and cut; the web
  export's `hd-half` run was cut at the start of the scenario earlier, leaving
  `hd-half-rate-60.cut-short` outside the matrix; native has neither). `report-complete` judges the declared list and names the rest.
- **`fetch_concurrency` 4 for gsw is not run**: GSW's fetcher is one `fetch` at a time and has no such
  option, and adding one would change the bundle the g31 rows were measured on (D28).
- **Not filled by the matrix legs**: `recv_*_rss`, `recv_js_heap`, `recv_wasm_heap`, device PSS memory
  and the per-repeat `startup` block (G7k's soak and startup runs, G7v's startup legs); `recv_preflight_us`
  is `unavailable` (the constrained leg's proxy statistics carry the preflight latency).
- **Desktop control rows** are G7v's `ctl:` run, `pace` and `scene` only; an `hd` row has none and
  `device-rows-present` requires one for `pace` and `scene` only.
- **The `native` kind speaks /7** (`RS_RECEIVER_PROTOCOL=7`, window 1 or 2); gate 6's native matrix
  stays /6.
- **Remote validation**: `scripts/remote-validate.sh --tier full --and-local` dispatched run 39750539697;
  every hosted job failed at setup (`jdx/mise-action` is not an allowed action in this repository, fixed
  on `main` by `40021ac1` after the dispatch). The remote-capable runs (pure, pnpm-test, cargo-*) were
  therefore run locally (below).

### Validation

Plan: `validate-increment.sh --plan --tier full` (52 targets: the diff touches `check-gate7.ts`,
`run-gate7.sh`, `run-gate6.sh`, `lib/render-stream-report.ts`, `lib/gate6p-legs.sh`, so it reaches
every native gate, every gate 7 group and the timing runs; `report-gate7.ts` and `lib/gate7p-*.ts`
reach `pure` only, `smoke-map.json`). 

The full tier ran on the pre-rebase tree (base `0230907c`, `validate-increment.sh --tier full --base main`); after the rebase on G7v (`1633c0f0`) the checks below were re-run on the rebased tree:

| Run | Result |
| --- | --- |
| remote attempt (`remote-validate.sh --tier full --and-local`, run 39750539697) | infrastructure failure: every hosted job died at setup (`jdx/mise-action` not allowed in this repository; fixed on `main` by `40021ac1` and `d6ffe1a8` after the dispatch). Fell back to local `validate-increment.sh --tier full` for those runs |
| pure (local) | pass (1603 s; includes `self-test-gate7p.ts`) |
| pnpm-test, cargo-rs-core, cargo-rs-core-capi, cargo-decode-proto-rs (local) | pass |
| cargo-gsw-rs (local) | **fail, pre-existing**: `cargo test --offline --release` in `web/gsw-rs` does not compile (E0432, `canvas_items::CanvasItemsExecutor` and three more are gated to `wasm32`); a clean `main` checkout fails identically, and this diff touches no Rust |
| lock-tests, capture-build | pass |
| native gates -1, 0, 1, 2, 3, 4, 5, 5.5 (sabotage legs run) | pass |
| g7-gsw (g7-0 to g7-6) | pass, `gate_passed=true` |
| g7live-gsw, g7live-web-rust | pass |
| g7live-native-timing (g7-r native), g7x | pass |
| g7-web-rust, g7live-gsw-timing, native gate 6 (pre-rebase) | pass (`g7p-validate-par`, `g7p-validate-timing`; wall 10100 to 10900 s, most of it waiting on other agents' exclusive timing legs) |
| g7live-web-rust-timing (pre-rebase) | rc=1: only `host-unperturbed@web:sim-hidden-2s` `[simulated-suspension]` failed (frame-interval p95 17026 us against 18950 us before, -10.2 %, at load 4 to 17) |
| g7-lc web legs re-run (`run-gate7.sh --live --legs g7-lc --receiver web --credit-window 1`, `g7p-lc-web/`, load 1.5 to 3.5) | **pass**: the same check read 17145 us against 16949 us (119 vs 120 frames), every web check passes; rc=1 only from the three phone `real-suspension` rows typed `unavailable` and gate 7's overall verdict. The earlier failure was load noise (G7p touches nothing g7-lc reads) |
| after the rebase: `tsc --noEmit -p experiments/render-stream` | only main's 5 pre-existing `gate2b-checks.ts` errors |
| after the rebase: `run-pure-self-tests.sh` (60 self-tests, includes `self-test-gate7p.ts`) | 60 passed, 0 failed |
| after the rebase: gsw matrix on G7v's bundle, `check-gate7.ts --live --legs g7-p` | `gate_passed=true`, 18 checks pass, every `device-rows-present` passes |



### What G7p does not prove

- A complete Q12 matrix: window 1 has 5 scenarios for native and 8 for each browser, and the run covers
  2 (native), 2 (web) and 4 (gsw) of them. Rates here are shape evidence under load, not the
  measurements a rate claim needs.
- Any g86 row (descoped), or a gsw bundle built in this worktree: the gsw legs ran G7v's bundle copy
  (sources identical; the wasm is not reproducible across worktree paths).
- Browser memory by process, the per-repeat startup block, or a GPU time per drawn frame
  (`recv_gpu_time_us` stays `unavailable`: no timer query).
