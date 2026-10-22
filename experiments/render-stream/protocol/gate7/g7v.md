### G7v — phone acceptance on both phones, g31 first (opus; g86 arms operator-attended)

- **Files**:
  - the `g7-dev` legs and checks (Q13d) in `run-gate7.sh` and `check-gate7.ts`, per device, with
    the g31's `hd` legs marked `required: false`;
  - `RS_RECEIVER_DRAW_REPEAT` (gsw);
  - the web export's `--max-fps 0` device configuration in the shell;
  - the new-frame interval, `multi_apply_ticks` and main-thread accounting in both receivers'
    perf timelines;
  - the report/2 device rows (Q12).
- **Unattended first**: every `ctl-` arm on D9's harness, green and quoted.
- **Then the g31** (D28; unattended while it is attached, `device-unavailable` otherwise):
  `--env device --device g31 --legs g7-dev`. The window-1 and window-2 legs, the soak and startup
  legs, and the report-only variants run in one session where possible.
- **Then the g86, attended** (D28): the agent asks for the go-ahead and the phone, runs G7m's g86
  bench arm first if G7m could not, then `--env device --device g86 --legs g7-dev`.
- A session cut short is resumed leg by leg on the same build, never mixed across builds or
  devices.
- **Checks**: Q13d's decided checks for every leg; `device-provenance` and the watchdog on every
  repeat; and the acceptance statement per receiver, device and window.
- **README "Gate 7v result"**, as G6c's result is tabulated, the g31 first:
  - published, applied and drawn rates per receiver × device × workload × window, with T_p and
    the panel mode;
  - the g31's window-1 good/bad phase classes and drift, and any `phase-alias` repeat at window 2;
  - the new-frame interval histograms against Q13c's predicted shapes (one tick on the g31, 3:2 on
    the g86);
  - main-thread and GPU per drawn frame;
  - the phone/desktop and g31/g86 ratios per stage;
  - the soak's thermal, frequency-cap and memory curves, and startup;
  - which window met the target, per receiver and device, with the g31's `hd` stretch result
    beside it.
  Every miss is reported as measured, with its failing checks. A g86 miss on a workload the g31
  meets is explained from Q13c (D25).
- **Sabotages**:
  - gsw `ack-on-receipt` on the g31's `dev-scene-w1` must fail exactly `credit-from-paced-loop`;
  - `RS_RECEIVER_DRAW_REPEAT=8` on the g31's `scene` and the g86's `hd` must fail
    `dev-gpu-headroom` and `dev-rate`, which shows that the headroom leg can fail on each phone;
  - a soak with `leak-gl-textures` must fail exactly `dev-soak`'s GPU-memory clause.
- *Amended 2026-10-15 (D29, D33):*
  - From G7a on, `gsw` is the Rust path, so apply and draw are measured, not only decode. The
    `gsw-ts` bench arm runs beside it as a control and judges nothing.
  - The web export's `dev-` arms run on the Rust core if G7xw landed, and on GDScript otherwise.
    The result names the core.
  - Main-thread work per drawn frame counts the wasm calls and the boundary copies (Q14c's
    `total_us`).

- *As built (G7v, 2026-10-21; [results/gate7/g7v.md](../../results/gate7/g7v.md)):*
  - **Runner.** `run-gate7.sh --live --legs g7-dev [--env device --device g31]` runs G6c's group
    unforked (`lib/gate6c-legs.sh` "G7v", as G7r does): one `run-gate6.sh --legs g6c` per receiver
    kind and credit window, `G6C_LEGS` naming `dev-<base>-r<N>` legs (r0 the warmup) into
    `<out>/gate6/<ctl|dev-<id>>-<kind>-w<w>/`. Device legs go through G7u's device daemon
    (`lib/gate7-device-legs.ts`), which now also runs plain (non-lifecycle) legs. The g86's arms are
    implemented by the same path but never run: **g86 descoped by the user, 2026-10-22** (the g31 is
    enough; the device table keeps its entry, unused). The g31's `hd` stretch miss is accepted as
    measured, by the same decision.
  - **The measured window** is anchored at the receiver's connection (its first host timeline line
    + 6 s, for 20 s), not at the fixture's step 1: the web export needs about 10 s to connect on the
    g31. Every scene and hd timeline is shifted 12 s later for that (`RS_FIXTURE_TIME_OFFSET_S`, a new
    rate/soak knob in gate6-scene and gate6-hd, default 0), and pace quits at 42 s.
  - **Perf timelines.** The new-frame interval, `multi_apply_ticks` and main-thread accounting are
    computed by the checker (`lib/gate7v-checks.ts`) from evidence both receivers already write (GSW's
    `perf-timeline.jsonl` `raf_ts_ms` and folds; the web export's `submitted_process_frame` and
    `submitted_us`), plus a harness-injected page probe (`lib/browser-probes/dev-probe.js`: every rAF
    callback and WebSocket `message` handler timed, hidden time, the JS and wasm heaps). No receiver
    file changed for them, so no native gate needed re-running; the numbers are the same ones.
  - **Not traced.** No repeat is traced, so `contentUpdateHz`, activation gaps and `CrRendererMain`
    `tdur` are `unavailable`; the probe's page-script busy share stands beside the clause. GPU time per
    drawn frame is `unavailable` (no timer query on the g31, G7d); GSW's `gpu_complete` is judged.
  - **CSS fit.** On device legs the probe applies Godot's `keep` rule to the canvas (Q13a); desktop
    control arms are unfitted.
  - **`RS_RECEIVER_DRAW_REPEAT`** (gsw) draws each frame N times inside the drawing callback.
    `dev-gpu-headroom-<workload>-gsw` runs at window 2 only.
  - **Warm startup on a phone** re-navigates the previous leg's tab (the same browser context,
    harness words `RS_RECEIVER_DEV_KEEP_TAB`/`RS_RECEIVER_DEV_WARM`); the desktop copies G7k's profile.
  - **`dev-presence`** on a device allows 1 % of pixels beyond Q7's band against the desktop reference
    of the host's step-11 freeze (pace: the square's quadrants within 2 px of the host's last x).
  - **report/2 device rows** (Q12) are written as `<out>/g7v-summary.json` `device_rows`, in /2's stage
    names; report/2 itself is G7p's.
