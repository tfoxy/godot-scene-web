---
name: gsw-perf
description: Router into the godot-scene-web perf harness — pick the right scenario, run it correctly, and read the result. Use before running any A/B rendering measurement, adding a scenario, or interpreting a perf-report/1 envelope.
---

# Perf harness router

[`docs/perf-harness.md`](../../docs/perf-harness.md) is a 206 KB lab notebook. Load **one** section. This file
tells you which.

## Where to jump

| You want | Section |
| --- | --- |
| the command menu | `## Running it` (line 10) |
| what the harness can and cannot answer | `## The two things this harness exists to say` (69) |
| what each metric means | `## Metrics` (103), `## CPU and GPU` (116) |
| **the rules that make a number valid** | `## Methodology (non-negotiable)` (300) — read this before your first run |
| atlas sprite cost | `## Scenario S1: atlas-sprites` (331) |
| ancestor rescale (and its negative result) | `## Scenario S2` (427) |
| nine-patch atlas | `## Scenario S3` (518) |
| large image coexistence | `## Scenario S4` (588) |
| canvas vs `<img>` for finished drawings | `## Scenario S5: static-surfaces` (646) |
| is it the CPU particle sim? | `## Scenario S6: effects-runtime` (907) |
| would WebGPU help / the shipped WebGPU path | `## Scenario S7` (1150), `## Scenario S8` (1466) |
| crisp small rotated text | `## Scenario S9: text-render` (1950) |
| relational gates | `## perf assert` (2336) |
| real Chrome trace event names | `## Chrome trace event names (observed, not guessed)` (2404) |
| measuring on a phone | `## Measuring on a real phone: --env device` (2470) |
| adding your own scenario | `## Adding a scenario` (2888) |

Text-rendering work has its own notebook: [`docs/text-rendering.md`](../../docs/text-rendering.md) (the
green-channel fidelity rule, `hb-gpu` measured numbers).

## Run it

```bash
mise exec -- pnpm perf -- --help
mise exec -- pnpm perf -- validate-report <run>/<file>.json
```

Chrome: `GSW_PERF_CHROME` → newest `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` → `/snap/bin/chromium`.
Snap chromium is confined, so the profile stays at `artifacts/perf/chrome-profile/` inside the repo — never `/tmp`.

## Before you believe a number

- 1 discarded warmup, 5 repeats, medians.
- Fresh browser context and target per repeat, cache-busted image URLs — Chrome's decoded-image cache survives
  navigation and erases the cold-decode number.
- Real `http://`, never `data:` / `about:blank`.
- The presence guard (`nonEmptyRatio`, `sampleHits`) must pass; a repeat with `sampleHits < mounted` goes into
  `failures`, not into the average. **The harness's own stated number-one failure mode is measuring a blank page
  and reporting excellent numbers.**
- S7/S8 WebGPU arms are separate invocations.
- `test:webgpu-composite`, `test:webgl-composite`, `test:canvas-pixel` and `bench:canvas-upload` already run under
  `xvfb-run`. Never wrap another one around them.

## The envelope crosses repos

`perf-report/1` is specified in [`docs/perf-report-contract.md`](../../docs/perf-report-contract.md) and is
co-owned with `../spirectl` and `../sts2-couch-coop`, which shell out to `pnpm perf -- validate-report`. Changing
its shape is a cross-repo change.

## Related

The `gsw-perf-harness` agent, for running a full measurement round rather than looking one thing up.
