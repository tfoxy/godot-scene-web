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


**Amended 2026-10-23 (G7z first pass, user decisions of 2026-10-22/23).**

- **The g86 is descoped (user, 2026-10-22: "Moto G86 arms are not needed. Moto G31 is enough").**
  Its `device_targets` are removed, not kept as `unverified`: an `unverified` entry promises a run
  that will never come. Each browser file has six targets (the g31's: `pace`, `scene`, `hd` ×
  windows 1 and 2) and `native` six `not-applicable` ones. `manifest-device-target` checks for six.
  Q11's "twelve per browser receiver" and Q13's g86 rows stand as the design record only.
- **Phone criterion: F3 (a).** GSW at credit window 2 is gate 7's phone receiver, **met with a
  measured shortfall**. Its g31 targets are on the pre-G7z sweep's build (d5cc1456, bundle
  `6748db72`): drawn 58.2/s (`pace`), 54.1/s (`scene`) and 5.1/s (`hd`, stretch). Q13d's checks
  give `not-met` (pace `dev-cadence`; scene `dev-rate`, `dev-cadence`, `dev-gpu-headroom`), so
  the target `status` is `not-met` with those `failed_checks`, and the user's acceptance is a
  separate `acceptance` field. The status always equals what Q13d gives; a decision never
  rewrites it. The `hd` stretch miss is accepted as measured.
- **The web export is `not-met`**, recorded with G7v's g31 numbers (pace 27.8 / 55.9, scene 8.7 /
  15.8, hd 0.30 / 0.20 drawn per second at windows 1 / 2), because the sweep's web g31 run was
  dropped. That run is on G7v's build (bundle `dcdbc5b4`), not the manifest's, so Q11 makes the
  entries `unverified`, quoting G7v's run and build, with `acceptance` "not met". A g31 web run on
  the final build turns them into `not-met` on that build.
- **Credit window 2 is the default** (F1, G7wd 2431d26f): `limits.receiver.credit_windows` is
  `[1, 2]`, with `default_credit_window` 2. Window 1 stays explicit.
- **Evidence.** The manifests quote the pre-G7z sweep (d5cc1456) where it kept per-check reports,
  and the pre-G7v sweep (c9026a06) for the browser file groups and the live g7-5/g7-55 groups, whose
  pre-G7z runs went to hosted runners (verdicts only). The post-sweep fixes are quoted where they
  replace a sweep result: G7kh 0fc739f7 (the gsw soak heap), G7w2c d78be95f (the window-2 checkers,
  and window-1 g7-r on both browsers), and, when they land, G7rf (the receivers' resync fold fix,
  for live g7-1 `resync-full` on both browsers) and G7kr (the renderer-RSS sampler, for every
  `rss-bounded-renderer` row). `feature-evidence-7.ts` `EVIDENCE_RUNS` lists every quoted run and
  its build; g7-z's `evidence-builds` row names the runs off the manifest build.
- **As built.** Generation is pure: `make-features.ts --collect` reads the device runs once into
  `protocol/features/render-stream-7/collected.json`, and `--receiver <kind>` builds the file from
  that and `lib/feature-evidence-7.ts`, so `--check` survives evidence pruning. `check-gate7.ts
  --legs g7-z` judges Q11's seven checks per receiver kind (`lib/gate7z-checks.ts`); a check whose
  evidence does not exist yet is `pending` (a failure, never a pass). `run-gate7.sh
  --manifest-hello` makes every live hello send its kind's file sha256. Eight entries a /2 file
  could not take from /1 are new, in all three files: `delivery.live_credit_window`,
  `delivery.live_token_and_origin`, `delivery.page_lifecycle`, `delivery.soak_memory_bounded`,
  `delivery.startup`, `delivery.disk_cache_budget` and the two `material.shader-*transpile-subset`
  entries. The receiver-typed set is what the legs show: the web export's
  `cache-budget-unsupported`.
  GSW's `gsw-shader-transpile` and its file-mode `cache-budget-unsupported` are
  `declared-unverified`, because no gate leg makes either happen.
- **Closing run (2026-10-23/24).** One build, main at 6a454065, run locally into
  `gate7/g7z/`; every `EVIDENCE_RUNS` row is this run, and the g31's window-2 targets are this
  build's (`not-met` by Q13d on both browsers, GSW's `acceptance: met with measured shortfall`).
  Window 1 on the g31 quotes G7v (`unverified` here). `--collect` takes the browsers' receiver
  blocks from the g7-6 **file** runs, because a live run carries the file's own sha256 in its
  hello. Results: [results/gate7/g7z.md](../../results/gate7/g7z.md), summary
  [results/gate7.md](../../results/gate7.md).
