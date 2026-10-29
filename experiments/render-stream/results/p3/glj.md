# GLJ: a GSW viewer's late join no longer holds its texture set twice (2026-10-29)

GRH ([grh.md](grh.md), "Not done") found that a GSW viewer joining STS2 combat grows the wasm heap
by +496 MiB in its first `apply`, and wasm memory never shrinks, so the viewer keeps that peak for
its lifetime. GLJ confirms the cause, removes it and adds a check.

**Verdict.** Confirmed and fixed. The payload store already keeps every texture's decoded pixels,
and each upload copied them again into the draw list's byte arena (`DrawList::texture_bytes`,
one `Vec` grown by doubling) until the executor's `texImage2D`. A join uploads every texture in
one apply, so the arena peaked at the whole texture set. Uploads now share the store's own bytes
(no copy). A late join's first apply costs +6.6 MiB on STS2 combat (was +496.3 MiB) and +7.8 MiB
on capture-scale (was +636.8 MiB). Apply time also drops, from 502 ms to 40 ms on capture-scale.

## First apply, before and after

`live.gsw.first_apply` in applied.json (new, below). "before apply" is the heap with every payload
the transaction names already provided and resident. MB = 10^6 bytes, MiB = 2^20 bytes, both
`WebAssembly.Memory.buffer.byteLength`.

| viewer | texture bytes uploaded | heap before apply | after the first draw | step | apply | draw |
| ------ | ---------------------: | ----------------: | -------------------: | ---: | ----: | ---: |
| capture-scale, before (`arena-upload`) | 245.1 MB | 323.0 MB | 990.6 MB | **+636.8 MiB** | 502 ms | 212 ms |
| capture-scale, after | 245.1 MB | 323.0 MB | 331.2 MB | **+7.8 MiB** | 40 ms | 147 ms |
| STS2 combat late join, before (GRH `grh-2` `rx-gsw2`) | n/a | 363.4 MB | 883.8 MB | **+496.3 MiB** | n/a | n/a |
| STS2 combat late join, after (`glj-1` `rx-gsw2`) | 229.6 MB | 363.4 MB | 370.3 MB | **+6.6 MiB** | 31 ms | 304 ms |
| STS2 menu join, after (`glj-1` `rx-gsw1`) | 81.7 MB | 168.3 MB | 171.8 MB | +3.3 MiB | 20 ms | 145 ms |

- **capture-scale** (`bench-live-scale.sh --receiver gsw --protocol 11 --window 2 --frames 600`,
  one viewer from the host's start, so its first apply is the join of the whole state). "Before" is
  the same build under the receiver sabotage `arena-upload`, which copies every upload as main did.
  It reproduces GRH's main-build numbers to the page: GRH measured a 990.8 MB heap and a 637 MiB
  first apply on main. The end heap is 337.4 MB after the fix and 990.6 MB before.
- **STS2** (one game launch, `glj-1`, GRH's leg shape: GSW viewer 1 from the menu, forced coding
  resync at host frame 9000, viewer 2 joining in combat at +170 s). The "before" row is GRH's
  `grh-2` launch (main with GRH's fix), read from its per-call page counter (`apply(0) +496.3MB ->
  842.9MB`, `artifacts/render-stream/p3/grh/sts2-after/rx-gsw2-heapsteps.txt`). Its heap before
  the apply is the same 363,397,120 B as here, so the two rows are the same join. The served bundle
  was `39edd2af...` (build.json checked). Viewer 1's resync full uploaded 0 of 349 MB (GRH's fix
  holds), and its end heap was 506.6 MB (`grh-2`: 644.3 MB).
- **First-apply time.** The fix copies nothing, so the first apply is faster, not slower: 502 ->
  40 ms at capture-scale, where memcpy and the arena's doubling reallocations were the cost. The
  first draw does the same `texImage2D` calls from the same bytes (212 vs 147 ms there, real time
  under load average ~9). bench-live-scale's own `first_apply_ms`, from connect and including the
  fetches, was 4,785 ms before and 3,766 ms after. These timings are single real-time runs on a
  loaded machine, so they are evidence, not a benchmark.
- The remaining +7 MiB is the lowering's own tables (items, vertices, draws, bindings) for a whole
  scene. It does not grow with the texture set.

## Fix (no wire change)

- `packages/canvas/rust-draw-list`: `SharedBytes` (`Arc<Vec<u8>>`) and `TextureBytes` (`Arena
  {offset}` or `Shared {index}`). Each `TextureOp` upload names its bytes as one of these.
  `upload_*_shared` queues a producer's own bytes by reference into `texture_shared`, and
  `consumed` releases them. `texture_data` resolves and bounds-checks an op's bytes, and
  `queued_texture_bytes` reports `(arena, shared)`. The copying `upload_*` calls remain for
  producers that don't keep their pixels (placeholders, the canvas test harness).
  `Arc<Vec<u8>>`, not `Arc<[u8]>`: wrapping the decoded `Vec` moves it, while `Arc<[u8]>::from`
  would copy each texture once more at decode.
- `packages/canvas/rust-prototype` (`canvas_items/gl.rs`): `validate` checks every upload through
  `texture_data`, and `texture_ops` uploads from the resolved slice. The GL calls and the bytes are
  unchanged, so the first frame's pixels are unchanged.
- `rs-core` `payloads::TexturePixels`: `rgba`, `half` and `compressed` are `SharedBytes`.
  `upload_pixels` (the applier's uploads and a context restore's re-uploads) shares them.
- GSW-only receiver sabotage `arena-upload` (`ApplySabotage::arena_upload`): copies every upload,
  as before GLJ.
- A side effect: a payload that the store evicts after `apply` stays alive, through the list's
  count, until the draw that uploads it.

## Checks (g8w11c, `run-gate7.sh --live --legs g7-8 --receiver gsw`)

`live.gsw.first_apply` (live.ts) records the viewer's first applied transaction: seq; heap before
the apply, after it and after its draw; the texture bytes the draw uploaded; the bytes taken from
the arena and the shared bytes (gsw-rs `last_upload_bytes_json`); and the apply and draw times.

| check | rule | drop-base / wrong-prefix | sabotage leg (`rebuild-reupload,arena-upload`) |
| ----- | ---- | ------------------------ | ---------------------------------------------- |
| `first-apply-arena-{drop-base,wrong-prefix}` | at most half of the first draw's texture bytes come from the arena | arena 0 of 393,216 B (shared 393,216) | arena 393,216 of 393,216 B: refused |
| `first-apply-heap-{drop-base,wrong-prefix}` | heap after the first draw <= heap before the apply + 32 MiB | 13.6 -> 15.1 MB | n/a (small fixture) |
| `first-apply-arena-caught` | the sabotage leg fails `first-apply-arena` | | holds |

- The arena check is scale-free, like GRH's `coding-resync-uploads`: the old code copies every
  uploaded byte (ratio 1), the fix copies none apart from 64 B placeholders. It fails on this small
  fixture, and the sabotage proves it.
- The heap bound is the one that catches the defect at game scale (capture-scale +636.8 MiB,
  STS2 +496.3 MiB, both far past 32 MiB). The brief proposed max(largest texture, 32 MiB), but with
  no copy a single large texture costs nothing either (STS2 has a 65 MB payload), so a fixed
  32 MiB is enough. After the fix the steps are 3.3 to 7.8 MiB.
- `arena-upload` rides on GRH's sabotage leg instead of adding a leg. It acts at every upload but
  is judged only at the first apply, while `rebuild-reupload` is judged only at the resync's full
  by GL upload bytes, which `arena-upload` doesn't change. Neither masks the other, and both
  `-caught` checks hold.
- A native receiver and the web export have no `live.gsw`, so all five checks are `not-run`
  there. The sabotage leg runs under GSW only, as before.

## Validation

- Unit: `gsw-canvas-draw-list` `shared_uploads_copy_nothing_and_release_on_consume` (no arena
  bytes, exact bytes back, one count held until `consumed`, a wrong length refused); rs-core
  `rebuilt_applier_inherits_resident_textures_and_uploads_nothing_again` now also asserts that a
  fresh applier queues `(arena 0, shared 1024)`, holds the store's own allocation until `consumed`,
  and that `arena-upload` queues `(1024, 0)`. rs-core 106 pass. rust-prototype `--features
  canvas-items` passes except `stats_are_a_flat_word_block`, which fails identically on main
  (`ExecStats::WORDS` is no longer 22). This is pre-existing and not this diff.
- Local `run-gate7.sh --live --legs g7-8 --receiver gsw`: gate_passed, all five GLJ checks and
  GRH's five pass (795 s).
- Smoke (`validate-increment.sh`; the diff reaches every run): pure, cargo-rs-core, -capi, gsw-rs,
  pnpm-test, native gates -1 to 8 and hc1 (sabotage legs included), g7-gsw, g7-web-rust and the
  g7-1 smoke legs of g7live-gsw/web-rust all pass. `bench-instr` rc=3 (no valgrind locally; it
  passes remotely). I stopped `native-rust-gate6` (a timing run) and left it to the milestone sweep.
- Full tier, remote, run 40808940947 (base `86de9ab9`): 20/20 pass, including g7-gsw (g7-8 with
  the GLJ checks) and g7-web-rust. The wrapper first exited with "no summary artifact" while the
  run was still going; `remote-validate.sh --collect <run_key>` then waited and collected it.
- Refused remotely and run locally at full tier (`RS_VALIDATE_GROUPS=g7-1 validate-increment.sh
  --tier full --only g7live-gsw,g7live-web-rust`): 2/2 pass (all 11 g7-1 legs on each).
- Skipped, with the reason: the timing runs (gate 6, `g7live-*-timing`, `g7x`, the native gates'
  timing groups) go to the milestone sweep; device legs.

## Not done

- `alloc_payload`'s `payload_buf` keeps the largest payload's size for the viewer's lifetime (STS2:
  one 65 MB texture payload, +62 MiB at its fetch). That is a different buffer, a per-payload
  high-water mark that doesn't scale with the texture count, and is out of this increment.
- The web export and the native receiver upload through the engine (rs-core-capi has no draw
  list), so the defect cannot exist there.

## Memory-worthy facts

- A copying arena beside a store that keeps the same bytes doubles a join's texture memory, and the
  `Vec`'s doubling makes it worse: 245 MB of textures cost +637 MiB of wasm heap. Share the store's
  allocation (`Arc<Vec<u8>>`) with the frame's upload list instead.
- `arena-upload` reproduces main's capture-scale numbers exactly (990.6 vs GRH's 990.8 MB). A
  sabotage that restores old behaviour can serve as the "before" arm of a heap measurement without
  a second build.
