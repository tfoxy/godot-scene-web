### G7z — three manifests, gate 7 summary (sonnet)

- **Files**: `make-features.ts --receiver`, `feature-evidence.ts` (per receiver),
  `protocol/features/render-stream-7/{native,web-export,gsw-canvas}.json`, `check-gate7.ts` group
  `g7-z`, and the README.
- **Checks**: Q11's seven checks against one final full run, including `manifest-device-target`.
- **Pass**: one `--legs` run of every group green on one build, with its source runs, and gates −1
  to 6 green on the same build. The phone criterion comes from a `g7-dev` run on the g31 on that
  build (D25, D28, F3). Without one, the g31's device targets are `unverified` and gate 7 is not
  declared passed. Each manifest records per-device results: twelve `device_targets` per browser
  receiver, the g31's and the g86's, each from its own device's run (Q11). A g86 entry without a
  run on that build is `unverified` and named; it does not block the pass. The README gains
  "Gate 7z result" and, last, the "Gate 7 summary":
  - run directories and image paths per group and receiver;
  - per-leg classes;
  - P-W1 and P-G1..4 as measured, and every band with its cause;
  - the three manifests side by side;
  - rates per receiver, including the 60/60 phase study;
  - the phone target per receiver × device × workload × window, the g31 first (met at window 1,
    met at window 2 only, or not met with its failing checks; the g31's `hd` marked stretch), with
    T_p, the panel mode, the Chrome version and the thermal and frequency-cap outcome;
  - suspension and lifecycle outcomes;
  - startup cold and warm;
  - memory by process;
  - an explicit "what this does not prove" list.

