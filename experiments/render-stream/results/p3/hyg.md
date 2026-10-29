# HYG: hygiene fixes (tsc, stale Rust test, fetch buffer)

1. **tsc**: `transport_skip(): void` was missing from `GswRs` in `web/gsw-receiver/common.ts`
   (GTS added the call in `live.ts` `codingResync()`). Added. `tsc -p experiments/render-stream/tsconfig.json`
   no longer reports it; the remaining errors (`gate2b-checks.ts`, `gate8-cache-checks.ts`,
   `g8kv-validate-ktx2.ts`) are pre-existing and untouched (not one-line fixes). `bench-rs.ts` has
   its own `GswRs` that never calls it. `pnpm typecheck` / `typecheck:ts6` (packages only) are clean.
2. **`stats_are_a_flat_word_block`** (`packages/canvas/rust-prototype`): the test was stale, the code
   right. `ExecStats` grew `screen_copies`/`screen_mipmaps` (P3-ST, CG3) so `WORDS` is 24, not 22,
   and the `WORDS - 3`/`WORDS - 1` indexes no longer pointed at `fence_issued`/`binding_uploads`.
   The TS side reads `to_json()` (named keys), not the words, so no reader changed. The test now
   pins the indexes absolutely (19, 21, last = 23).
3. **Fetch receive buffer**: `alloc_payload` kept `payload_buf` at the largest payload's size. New
   `rs-core` `apply::payloads::fit_payload_buf` frees a buffer above 4 MiB when the next payload fits
   under 4 MiB (another huge payload keeps it). Lazy release: the big buffer goes at the next small
   fetch. Unit-tested on the host in rs-core (gsw-rs is wasm-only, so the helper lives in rs-core).

Validation: remote full tier 18/20 runs: all native gates, g7-gsw, g7live-web-rust pass; g7-web-rust fails only the
known hosted flake (g7-8 mm-reference/web-repeat-identical @web) and the timing-sensitive g8 decode-cost/
worker-hook-time; g7live-gsw g7-5 missed live-mesh shots 8,9 under runner load, then passed locally
(g7live-gsw, g7-5, full). Timing runs and valgrind not run.
