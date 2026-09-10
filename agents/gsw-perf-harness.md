---
name: gsw-perf-harness
description: Run and extend the A/B rendering-mechanism perf harness (packages/perf-harness, scenarios S1-S9) and the perf-report/1 envelope. Use whenever a rendering decision needs a measured number rather than an argument.
---

# Perf harness

This harness exists because rendering opinions are cheap and rendering measurements are not. Its methodology is
documented as non-negotiable, and the reason is blunt: **the number one failure mode of a perf harness is
measuring a blank page and reporting excellent numbers.**

Reference: [docs/perf-harness.md](../docs/perf-harness.md) — 206 KB, structured as a lab notebook. Its
`## Running it` section is a copy-pasteable command menu and `## Methodology (non-negotiable)` is the gate. Load
the scenario section you need; do not read it end to end. The `gsw-perf` skill routes you.

## Commands

```bash
mise exec -- pnpm perf -- --help
mise exec -- pnpm perf -- validate-report <run>/<file>.json      # sibling repos shell out to this
mise exec -- pnpm godot:text-bench
mise exec -- pnpm text:fidelity
mise exec -- pnpm test:webgpu-composite      # already xvfb-wrapped; never nest another
```

Chrome resolves from `GSW_PERF_CHROME`, then the newest
`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`, then `/snap/bin/chromium`. There is deliberately **no
Playwright dependency** for perf — this repo's `@playwright/test` pins a revision that is not on disk. Snap
chromium is confined, so the profile directory must stay inside the repo (`artifacts/perf/chrome-profile/`),
never `/tmp`.

## The methodology, and why each clause is there

- **1 discarded warmup, 5 repeats, medians.** A single run measures scheduling noise.
- **A fresh browser context and target per repeat, with cache-busted image URLs.** Chrome's decoded-image cache
  survives navigation and silently erases the cold-decode number you came for.
- **Served over real `http://`** — never `data:` or `about:blank`.
- **Every run ends with a presence guard** (`nonEmptyRatio`, `sampleHits`). A repeat with `sampleHits < mounted` is
  discarded into `failures`, not averaged in.
- **S7/S8 WebGPU arms are separate invocations.** A `ready()` failure on one arm otherwise aborts the whole run.
- The generated atlas page is ~15 MB and cached; that is expected, not a leak.

If you add a scenario, it inherits all of the above. A scenario without a presence guard is not a scenario.

## The envelope is shared

`perf-report/1` ([docs/perf-report-contract.md](../docs/perf-report-contract.md)) is co-owned with `../spirectl`
and `../sts2-couch-coop` — couch-coop emits it from three of its own measurements and validates through
`pnpm perf -- validate-report`. Changing the envelope shape is a cross-repo change; check the consumers before
you touch `env.kind`, `env.geometry` or the aggregation rules.

## Reporting

State the arms, the repeat count, the presence-guard result and the discard count. Report medians, not means, and
say what was dropped — a silently truncated matrix reads as full coverage. Any visual claim lists its image path.

## Stop conditions

A presence guard that fails on every repeat, a Chrome that will not resolve, or a WebGPU device gate that refuses:
stop and report the blocker with the run directory. Do not relax the methodology to get a number out.
