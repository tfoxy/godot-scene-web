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

