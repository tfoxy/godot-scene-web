# Gate 8h result (2026-10-23)

G8h ([protocol/gate8-design.md](../../protocol/gate8-design.md) D10, Q4 and "As built (G8h)")
passes. With `GRC_ADOPT=arm` and `GRC_ROOT_SIZE=presentation:640x360`, a capture armed late on a
`canvas_items`/`expand` scene adopts it on the headless 64x64 host and then calls
`Window.set_min_size(640,360)`. From the arm frame on, the host reports window 640x360, visible rect
640x360, stretch 1 and oversampling 1 (`host_size_status` `match`). The relayout, the stylebox
feather and the Labels' text reach the hooks as ordinary calls on adopted items. The stream equals a
capture armed at birth with the same policy, and the native receiver's shots equal the 640x360
rendered reference exactly. The default (non-presentation, non-adopting) path is unchanged.

## What the code does

`entry.cpp` already ran root query, adoption walk, then size policy (G8a). G8h adds only the
sabotage `size-before-adopt` (writes the size before the walk, skips the second write; refuses
unless adoption and `presentation:` are both set). Everything else is the `gate8-size` fixture
(`size.tscn`: feathered rounded panels, corner-anchored label and panel, an edge strip, a 32 px
title), `lib/gate8-size-checks.ts`, `test/self-test-gate8-size.ts` and the `g8h` group in
`run-gate8.sh`/`check-gate8.ts`. `gate8-adopt-checks.ts` only gained `export` on six helpers.

## Checks (`run-gate8.sh --legs g8h`, 9 of 9)

| check | result |
| ----- | ------ |
| `g8h-legs` | 13 legs exit 0 |
| `late-size-match` | late and born declare `match`, presentation 640x360, oversampling 1; the fixture's own engine read is 64x64 / visible 640x640 / oversampling 0.1 at K-1 and 640x360 / 640x360 / 1 at K+1; the control (no policy) declares `degenerate-visible` at 0.1 |
| `late-size-reference` (exact) | late (full and patch sinks) and born equal the reference at 3 of 3 checkpoints, the first 2 frames after the arm, 0 px |
| `late-size-needed` | the unpresented late arm differs from the reference in 146,297 px over the three checkpoints |
| `late-size-equivalence` | 27 of 27 frames from the arm equal born's, no residue |
| `late-size-atlas` | 3 textures drawn over 27 frames, all `created`, none unknown |
| `late-size-account` | 6 items adopted, first transaction at frame 12, 0 unknown calls |
| `sabotage-size-before-adopt` (skip) | detected by the account: 2 unknown calls; state and pixels still equal born and the reference (0 problems, 0 px) |
| `sabotage-size-before-adopt-strict` | sticky `pre-existing-object` |

## Deviations from the design

- **Skip is detected by the account, not by state or pixels.** Q4 predicted skip "loses the relayout
  of every adopted control". It does not, because the walk reads the nodes after the resize and
  redraws them (D3). The sabotage check asserts that `late-size-account` would fail on it. Recorded
  in "As built (G8h)". A product on skip that applied the size first would still render right.
- **`late-size-atlas` needs no D7 readback** for this fixture: after the resize every Label draws
  from oversampling-1 caches created post-arm. Atlases already drawn at oversampling 1 before arm
  stay G8r's.
- Two checks added beyond Q4's four: `late-size-needed` (the control that gives the exact pixel
  check teeth) and `late-size-account`.

## What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, iterating | capture ctests (25), `run-gate8.sh --legs g8h` (9/9), `self-test-gate8-size.ts` (22 assertions), `self-test-gate8-adopt.ts` (17) | pass |
| local smoke (`artifacts/render-stream/validate/g8h-smoke/`) | `pure`, `capture-build`, `native-rust-gate0`, `native-rust-gate8` | 4/4 |
| local smoke live (`g8h-live/`) | `g7live-gsw-g7-1`, `g7live-web-rust-g7-1` (4 legs of 11 each) | 2/2 |
| remote full tier | run 39988300574, key `rv-20261023T163716Z-dc4b29b-10933` (evidence `artifacts/render-stream/remote/20261023T175624Z`) | 20 of 21 pass; `cargo-gsw-rs` is the known rc 101 |

Default-path identity: the only change on the default path is a `bool` initialised false and a
sabotage-gated branch in `entry.cpp`; the golden checks inside `pure` are unchanged, the window-1
transcripts (`rs_live_window` ctest) are unchanged, and native gates -1 to 5.5 passed in full
remotely. No default recording was byte-compared against `main`.

## Out of scope, and why

Not run: the timing phase (`native-rust-gate6`, `g7live-*-timing`, `g7x`, `lock-tests`) and the
timing groups inside gates 1, 2, 5, 55 and 8 (`decode-cost`): no rate, pacing or cost path is
touched, so they wait for the pre-release delta sweep. Local g7-2 live and the g7-1 legs outside
smoke ran remotely only where the remote allows; the live groups the remote refuses ran at smoke
level locally (g7-1 only; the smoke plan does not reach g7-2). Known failures ignored:
`cargo-gsw-rs` rc 101.

## Time

Implementation (design reading, capture sabotage, fixture, checks, docs): about 1.4 h. Validation:
about 3.6 h of wall time, almost all of it waiting (local `pure` 807 s and the web live smoke 872 s
under other agents' load; the remote full tier about 4 h from dispatch, mostly queueing behind
other increments' runs).
