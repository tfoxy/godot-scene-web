# g86 synthesized adb/CDP fixture

The g86 has never been queried by gate 7 (its legs are operator-attended, D28). These files are
SYNTHESIZED from `packages/perf-harness/baselines/moto-g86-5g-effects-webgpu-runtime.json`'s
`env.device` (model, Android 15 / SDK 35, Chrome 151.0.7922.137, battery 58 %, thermal none, max
47.713 C, landscape 790x316 at DPR 3.4876) and docs/perf-harness.md ("Mali-G615 MC2 (ANGLE)", an
adaptive panel Chrome measured at 89-90 Hz). Shapes follow the g31's recorded dumps. G7v replaces
them with the g86's own at its first attended session.
