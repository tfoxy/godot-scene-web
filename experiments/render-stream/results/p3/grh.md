# GRH: GSW's coding resync no longer steps the wasm heap (2026-10-28)

W11z ([w11z.md](w11z.md)) saw GSW's wasm heap step up for good at a forced coding resync in live
STS2 combat: 561.5 -> 969.7 MB (+73%). GRH finds the cause, fixes it and adds a generic check.

**Verdict.** A real defect, but not the one W11z guessed. The resync's fresh applier had no
resident textures, so the resync's full transaction uploaded every texture again, into the draw
list's byte arena, in one apply. The fix hands the old applier's residency to the fresh one (the
native receiver's reconcile). On STS2 combat the resync now costs +25 MB instead of +428 MB.

## Heap before and after the resync

| leg | at the resync | after the resync's full | end of leg | step |
| --- | ------------: | ----------------------: | ---------: | ---: |
| STS2 combat, before the fix (`grh-1`) | 618.8 MB | 1,046.8 MB | 1,046.8 MB | **+428.0 MB (+69%)** |
| STS2 combat, after the fix (`grh-2`) | 619.1 MB | 644.3 MB | 644.3 MB | **+25.2 MB (+4%)** |
| capture-scale, before (bench-live-scale, GSW, /11, window 2) | 990.8 MB | 990.8 MB | 990.8 MB | 0 |
| capture-scale, after | 990.8 MB | 990.8 MB | 990.8 MB | 0 |
| g8w11c drop-base (small fixture), after | 21.3 MB | 21.3 MB | 43.6 MB (creep) | 0 |
| g8w11c drop-base with `rebuild-reupload` (the old behaviour) | 20.6 MB | 20.6 MB | 44.2 MB (creep) | 0 |

(MB = 10^6 bytes, `WebAssembly.Memory.buffer.byteLength`. The "after the resync's full" column is the
heap right after the first transaction drawn after the rebuild.)

- **Capture-scale does not reproduce the step, before or after.** Its first apply already took
  637 MiB, so the heap's high-water mark is set at connect (the viewer had uploaded 245 MB of
  textures by the resync), and the resync's re-upload reuses that memory. STS2's viewer joined at
  the menu, built its textures up through the session (about 600 MB of heap at the resync), and
  met its largest upload set only at the resync. With the fix the capture-scale resync full uploads 0 of the 245 MB it had uploaded.
- **The step is the first-apply cost of a state, not the resync.** A second STS2 viewer that joins
  in the same combat (`grh-1`/`grh-2` `rx-gsw2`, no resync) pays +496 MiB in its first `apply` (heap
  883.8 MB). That is a join's cost: the same arena, filled once. It is not changed here; see
  "Not done".
- The previous agent's measurements on g8w11c (+5.9 MB before `accept_bytes`) were the small
  fixture's own creep and ingest, not this defect; they are unchanged by the fix.

## Attribution

A temporary per-call page counter in gsw-rs (not kept) logged which exported call grew the wasm
memory. STS2 combat, viewer 1 (`grh-1`; `artifacts/render-stream/p3/grh/sts2-before/`):

| call | growth |
| ---- | -----: |
| `live_accept` of the resync's full (validate and resolve; 1.5 MB message) | +24.1 MiB |
| **`apply` (the fresh applier's first apply)** | **+384.1 MiB** |
| everything else at the resync (decode buffers, `rx`, `live_rebuild`, `compute_needed`) | 0 |

The decode path is not involved: a full transaction is 1.5 MB on STS2, the decoder's buffers moved
by 0.1 MB at the resync, and `live_rebuild` itself allocated nothing. `apply` +384 MiB is
`DrawList::upload_texture` copying every texture's pixels into `texture_bytes` (one `Vec`, grown by
doubling) because the fresh applier's `resident` table was empty; the old applier had made the same
uploads one transaction at a time, over the whole session, and wasm memory never shrinks.

## Fix

- `rs-core/src/apply/mod.rs`: `Applier::inherit_residency(old)` moves `resident`, `kept`, `delivery`
  and `stream_version` from the old applier. The fresh applier's first apply is the native
  reconcile (`sync_textures` with `first`): a texture whose chosen payload is already resident is
  not uploaded; one the new state does not name is freed. The executor keeps its GL textures.
- `web/gsw-rs/src/lib.rs`: `live_rebuild` takes the old applier out of `self` before preparing the
  new one (so its other state is gone before the walk) and calls it. This also fixes a latent
  omission: `live_rebuild` never carried the delivery preferences or the stream version over.
- `rebuild-reupload` (receiver sabotage, GSW only): skips the inheritance, as before GRH.
- Unit test `rebuilt_applier_inherits_resident_textures_and_uploads_nothing_again` (rs-core): a fresh
  applier uploads the texture again (1 upload, 1,024 arena bytes: the defect's shape); a rebuilt one
  uploads 0 and leaves the arena empty; a texture the new state lacks is freed.
- rs-core-capi has no `Applier` (the native receiver and the web export render through the engine),
  so the same bug cannot exist there.

## Checks (g8w11c, run-gate7.sh --live --legs g7-8)

`live.coding.rebuild_applies[]` in applied.json (live.ts) records, for the first transaction drawn
after each rebuild, the wasm heap, the heap when the rebuild began, the texture bytes the GPU took
for it and the bytes it took before.

| check | rule | drop-base / wrong-prefix | sabotage `rebuild-reupload` |
| ----- | ---- | ------------------------ | --------------------------- |
| `coding-resync-uploads-{drop-base,wrong-prefix}` | the full uploads at most half of the earlier uploads | 0 of 393,216 B | 393,216 of 393,216 B: refused (caught) |
| `coding-resync-heap-{drop-base,wrong-prefix}` | heap right after the full <= heap at the rebuild + 32 MiB | +0 | n/a (small fixture) |
| `coding-resync-reupload-caught` | the sabotage leg fails `coding-resync-uploads` | | holds |

The previous attempt's `coding-resync-heap-*` compared the leg's END heap with the heap at the
resync with a 16 MiB bound, and failed on the stream's own creep (about 0.2 MB per 12 transactions,
17 -> 44 MB over the leg). It now compares the heap right after the resync's full. The 32 MiB bound
is the full's own accept (24 MiB on STS2, 4 MiB on g8w11c) with room, so it catches the STS2 step
(+428 MB) but not this fixture's 393 KB of textures; `coding-resync-uploads` is the check that
fails on the small fixture, at any scale, and the heap bound backs it at game scale. Only GSW has
either check (the native receiver and the web export have no `live.coding.heap_at_resync`: `not-run`); the sabotage leg
`native-sabotage-drop-base-reupload` runs only under GSW (`GATE7_LIVE_KIND=gsw`).

## Validation

- STS2 (one game launch each, C3 harness, lease `exclusive:game:p3-sts2`, private farm and XDG,
  `GRC_HOOK_LOG=off`, drop-message at frame 9000, viewer 2 joining at +170 s; hashes unchanged,
  `survivors: none`): `grh-1` (instrumented, no fix) and `grh-2` (instrumented, fixed). Harness
  scripts: `artifacts/render-stream/p3/grh/{leg-cmd.sh,rx-grh.sh}`. The bundles served the builds
  `616243e6...` (before) and `787c9041...` (after).
- Local: rs-core unit test; `run-gate7.sh --live --legs g7-8 --receiver gsw`: gate_passed, all
  seven coding checks above pass (402 s). Capture-scale bench-live-scale before/after (table above).
- Smoke (`validate-increment.sh`; the diff reaches every run): pure, cargo-rs-core, -capi, gsw-rs,
  native gates -1 to 8 and hc1, g7-gsw, g7-web-rust, g7live-gsw/web-rust (g7-1) pass. `bench-instr`
  rc=3: no valgrind locally (passes remotely). `native-rust-gate6` is a timing run, stopped and left
  to the milestone sweep.
- Full tier, remote, run 40793567879 (base `60ddee77`): 17/19 pass; g7-web-rust (`mm-reference@web`,
  `web-repeat-identical@web`: g8mm receiver-patch shots, not this diff) and g7live-web-rust
  (`console-clean@web`, `native-legs@web`: my first version ran the `rebuild-reupload` sabotage leg
  under the web export too, which does not know the sabotage) failed. The leg now runs under GSW only
  (`GATE7_LIVE_KIND=gsw`). Re-dispatch `--only g7-web-rust,g7live-web-rust` (run 40801328272): 2/2
  pass, so the g8mm failures did not recur (a runner-hardware difference, none of the diff's paths).
- After rebasing onto `74e58b5d` (PM7): rs-core `cargo test` 106 pass; `run-gate7.sh --live --legs
  g7-8 --receiver gsw` again passes all seven coding checks.
- Skipped, with the reason: timing runs (gate 6, `g7live-*-timing`, `g7x`, the timing groups of the
  native gates: milestone sweep); device legs.

## Not done

- The join cost: a viewer's first `apply` of a large state fills the draw list's byte arena at once
  (+496 MiB for STS2 combat, 637 MB at capture-scale), and the arena grows by `Vec` doubling. A
  fresh viewer on a phone pays it; chunking the first apply's uploads or `reserve_exact` would trim
  it. It is not a resync defect and needs a canvas-package change (`rust-draw-list`).
- The W11z harness's `rx-w11z.sh` and the 28-minute leg were not re-run: the fix is exercised by
  the short STS2 legs above.

## Memory-worthy facts

- Attribute wasm heap steps with a per-exported-call page counter (a `Drop` guard comparing
  `memory_size(0)`), logged by the shell; it names the call in one STS2 launch where the page-mark
  guess at accept time (previous attempt) pointed at the wrong place.
- capture-scale hides upload-arena defects: its first apply already sets the high-water mark.
  An STS2 viewer joined at the menu and a game-scale resync full is the shape that shows them.
