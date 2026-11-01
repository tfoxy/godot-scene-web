# G7K-FIX: `sabotage-soak-no-evict` no longer requires `wasm-heap-bounded` on GSW

## Finding (milestone-sweep)

The gate-7 soak sabotage `sabotage-soak-no-evict`'s GSW expected-failure set
(`G7K_SABOTAGE_SETS["sabotage-soak-no-evict"].required.gsw` in
`scripts/lib/gate7k-checks.ts`) still required `wasm-heap-bounded` to fail. It no longer does:
GLJ `2361d541` ("upload GSW textures from the payload store, not an arena") removed the draw-list
arena's second copy of texture pixels, so a never-evict store now grows only its own ~2.8 MB of
decoded payload bytes, well under the 16 MiB `wasm_heap` budget. The sabotage's real signature
(`residency-bounded:receiver memory-cache entries`) still fires correctly. This is a checker
recalibration, not a receiver or wire bug.

## Root cause

GLJ `2361d541` (results/p3/glj.md) made GSW uploads share the payload store's decoded pixels
instead of copying them into `DrawList::texture_bytes`. The original G7k result measured the
no-evict store's wasm heap growing 9.6 -> 58.9 MB (results/gate7/g7k.md), which the arena's second
copy accounted for; with that copy gone the store keeps only its own decoded bytes.

## Fix

In `G7K_SABOTAGE_SETS["sabotage-soak-no-evict"]` (scripts/lib/gate7k-checks.ts):

- `required.gsw` was
  `["residency-bounded:receiver memory-cache entries", "wasm-heap-bounded"]`; it is now
  `["residency-bounded:receiver memory-cache entries"]`.
- `allowed.gsw` was `["js-heap-bounded", "rss-bounded-renderer"]`; it is now
  `["js-heap-bounded", "rss-bounded-renderer", "wasm-heap-bounded"]` (the store's bytes still live
  in the wasm heap, so a larger never-evict scene could trip it — a consequence, not the signature).

The self-test `scripts/test/self-test-gate7k.ts` "sets: missing" line hard-coded `wasm-heap-bounded`
as the single failing key; it now passes `[]` so the "a required key missing from `failed` is
reported" case reports the one remaining required key,
`residency-bounded:receiver memory-cache entries`. The test is not weakened.

## Validation

- `self-test-gate7k.ts`: all passed (pure self-test).
- g7-k GSW live soak re-run (`run-gate7.sh --legs g7-k --receiver gsw --live`, `G7K_SKIP_STARTUP=1`),
  run 20261101T005253Z into `artifacts/render-stream/gate7/20261101T005253Z`: the soak legs
  (reference-step11, soak-scene, sabotage-soak-no-evict, sabotage-leak-gl-textures) all completed
  exit=0, and the failure-set check flipped to pass. The startup legs are orthogonal to this
  checker recalibration and were skipped, so their checks report `no timings.json`; the whole g7-k
  group therefore reports `gate_passed=false`, which is expected for this scoped re-run.

## Verdicts

- Before: `g7k-sabotage-soak-no-evict-failure-set` fails — `expected to fail but did not:
  wasm-heap-bounded` (the store's wasm heap now ends at 9.1 MB, value at 60 s 7.5 MB, +1.6 MB,
  well inside the 16 MiB budget, so `wasm-heap-bounded` no longer trips).
- After: `PASS g7-k g7k-sabotage-soak-no-evict-failure-set failed exactly {js-heap-bounded,
  residency-bounded:receiver memory-cache entries}` — `residency-bounded:receiver memory-cache
  entries` is the required signature and `js-heap-bounded` is an allowed consequence; the removed
  `wasm-heap-bounded` now reports `PASS` (wasm heap +1.6 MB, within budget).
