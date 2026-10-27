# CG3: GSW composites canvas groups and back-buffer copies (2026-10-27)

CG1 carried `clip_children`, `CanvasGroup` and `BackBufferCopy` on render-stream/10
([cg1.md](cg1.md)), and the native receiver and the web export re-issue them to their own Godot.
GSW only typed the state (`gsw-canvas-group`, `gsw-backbuffer-copy`) and drew /9's picture. Now GSW
composites both keys itself, as Godot 4.5.1's GLES3 canvas renderer does, on P3-ST's back buffer.
On `fixtures/gate8-cg` every GSW shot equals the native shot within channel 1, and g8cg's own checks
pass on GSW. No wire or capture change: /2 to /10 recordings are byte-identical, and the native
receiver and the web export are untouched.

## What GSW does now

Engine source: `renderer_canvas_cull.cpp:180-480` (`_attach_canvas_item_for_draw`,
`_cull_canvas_item`) and `rasterizer_canvas_gles3.cpp:409-540`, `:2205-2245`, `:2836-2883`
(`canvas_render_items`, `canvas_begin`, the default shaders), `texture_storage.cpp:3201-3283` and
`copy_effects.cpp:240-310` (the back-buffer functions).

- **The walk** (`rs-core/src/apply/mod.rs`, `cull`). An item whose `canvas_group` is set and that
  has commands, or `fit_empty`, culls its whole subtree before it attaches, `behind` or not. Its
  range is what that subtree attached at the owner's z. The range opens at its first entry; with
  nested owners the outermost owner wins that entry, as Godot's last write does. The owner's rect
  is its own global rect merged with the range's, grown by `clear_margin`. A `fit_empty` owner
  without commands draws the rect Godot synthesizes (`CANVAS_RECT_IS_GROUP`): the range's union
  grown by `fit_margin`, in the owner's space. Its four vertices live in a small slab of their own
  (`group_quads`). A `copy_to_backbuffer` item is attached for its copy, whether or not it draws.
- **The draw list** (`assemble`, `gsw-canvas-draw-list` `ScreenOp`). GLES3's per-item state
  machine, reset per canvas:
  - A `BackBufferCopy` outside a group sets a pending copy of its rect. GLES3 reads the rect
    untransformed, truncated to `Rect2i`; `Rect2()` is the whole target.
  - A screen reader outside a group copies the whole target, unless a copy was already taken in
    this canvas. A `BackBufferCopy`'s copy counts as one, as in GLES3.
  - The first entry of a range opens the group (one at a time). A clip group copies the owner's
    rect into the back buffer; a clip-and-draw owner is then drawn plainly into it. A transparent
    group clears the back buffer.
  - Draws inside an open group go into the back buffer (`DRAW_TO_BACK_BUFFER`), blended as GLES3
    blends into a transparent target.
  - The owner closes its group. With `blur_mipmaps`, the gaussian chain of its rect is built
    first. The owner then draws through Godot's default clip-children shader (`DRAW_GROUP_CLIP`)
    or canvas-group shader (`DRAW_GROUP_COMPOSITE`), both unshaded. It draws through its own
    material where GLES3 uses one: clip-only or transparent with a material set.
  - An item with group state, reached with no group open, draws nothing, unless it is
    clip-and-draw.

  The operations are a list beside the draws (`DrawList::screen_ops`, each before a draw flagged
  `DRAW_SCREEN_OPS`). P3-ST's two flags (`DRAW_SCREEN_COPY`, `DRAW_SCREEN_MIPMAPS`) became
  operations of the same list, so screen readers, copies and groups share one ordered state, as
  they do in GLES3.
- **The executor** (`packages/canvas/rust-prototype/src/canvas_items/gl.rs`). P3-ST's
  `ensure_screen`/`screen_pass` became `screen_op`, on the same back buffer:
  - a region copy, which is a `blitFramebuffer` of the region;
  - a clear;
  - the gaussian chain over a region. `copy_section`/`source_section` are as in copy.glsl; the
    whole-target chain is the same math as before.
  - Each operation sets the sampled levels (`GL_TEXTURE_MAX_LEVEL`) as `canvas_begin` would.

  The group program is the builtin vertex stage plus a fragment stage that follows Godot's two
  default shaders, made with the back buffer. A `SCREEN_TEXTURE` sampled by a draw into the back
  buffer reads white, as `canvas_begin` binds white there.
- **Sabotages.** The native receiver's `drop-canvas-group` and `full-backbuffer-copy` are now GSW
  applier sabotages too (`gsw-rs` options).
- **GSW applied.json** types neither `gsw-canvas-group` nor `gsw-backbuffer-copy` any more.

**Incremental paths.** A group's range, rect and synthesized rect depend on its descendants'
rects, which the rows-only and in-place paths do not revisit. So while any item holds /10 state,
every apply walks and re-assembles (`back_buffer_items`). A session without /10 state keeps every
G7o2/G7o3 shortcut. Both new item keys also join the walk's structural key, so a state-only patch
(TGL's toggle) re-walks. The cost on a group-heavy STS2 stream is for the milestone sweep to
measure. G7o2's `walk-diff` oracle (`paint_digest`) now hashes the operations too.

**Still not modelled (generic, documented in render-stream-10.md "Receivers"):**
- A canvas modulate's alpha on a clip-and-draw owner's clip pass. The row is the plain pass's, so
  a translucent `CanvasModulate` scales that pass's alpha once more.
- An MSDF owner drawn through a group program. It draws without its coverage.
- A `fit_empty` rect that Godot keeps from an earlier frame after the range emptied. Godot then
  skips that owner anyway.

## g8cg in g7-8: GSW against native

**Legs.** `lib/gate7-gsw-g8.ts`: every g8cg receiver leg now replaces the native one:
- `receiver`, `receiver-patch`, `late/receiver`;
- the /9 negative control `receiver-v9`;
- both receiver sabotages.

g8cg's own checks judge them through the gate 8 band. The GSW-only `gsw-receiver`, `gsw-*-patch`
and `gsw-late` legs are gone. So is `cg-gsw-typed@gsw`, replaced by `cg-gsw-untyped@gsw`, which
checks two things:
- no g8cg leg types anything but the headless capture's `degenerate-host-size`;
- every honest /10 shot is within channel 1 of native.

**Band: channel 1, no declared region.** This is the gate's existing class for GSW against
native (`gate8BandViews`, Q7's delta1: blend rounding and the native 10-bit target's readback).
g8cg needs no `undecided` or `excluded` region:
- every sample is nearest at integer scales;
- the group composites run on the same RGB10_A2 back buffer as native;
- GSW reproduces native everywhere to within one 8-bit step.

Local run (this machine, native source `run-gate8.sh --legs g8cg`, 12/12; GSW in the pinned
headless Chromium, 640x360):

| leg | shots | px beyond channel 1 | px at channel 1 |
| --- | ----- | ------------------- | --------------- |
| `receiver`, `receiver-patch` | 3 each | 0 | 8070 each |
| `late/receiver` | 2 | 0 | 8070 each |
| `receiver-v9` | 3 | 0 | 4502 each |
| `sabotage-drop-canvas-group/receiver` | 3 | 0 | 4502 each |
| `sabotage-full-backbuffer-copy/receiver` | 3 | 0 | 8070 each |

**Where the channel-1 pixels are.** Against the reference, GSW's /10 shot differs only by 1, and
only in the group cells: CLIPDRAW 1792, GROUP 2400, HPBAR 700, HPLOW 1774 and NESTED 1404. BBV,
BBR, TGL, PLAIN and everything outside the cells are exact. Against the /9 picture it differs in
every cell CG1's negative control names: HPBAR 1908, HPLOW 1960, CLIPDRAW 5632, GROUP 2800,
NESTED 4096, BBV 256, BBR 2048 and TGL 3072 px beyond 1.

**Checks** (`check-gate7.ts --legs g7-8 --receiver gsw` over that source), all PASS:
- `g8cg-legs@gsw` (13 legs);
- `cg-native-exact@gsw`, `cg-negative-control@gsw`, `cg-sabotage-drop-group@gsw`,
  `cg-sabotage-full-copy@gsw`, `cg-adopt@gsw`;
- `cg-gsw-untyped@gsw`;
- `gsw-band@gsw` (17 shots within the band).

**Sabotage: the comparison catches a GSW that ignores clip_children.** Two pieces of evidence:
- **Kept in g7-8.** The GSW `drop-canvas-group` leg differs from the reference in exactly the
  five group cells and TGL at step 2 (`cg-sabotage-drop-group@gsw` passes on it). The same holds
  for `full-backbuffer-copy`, which differs in BBR's right half only.
- **Shown once.** The sabotaged GSW output was substituted for the honest `g8cg/receiver` and the
  checker run again. Two checks fail:
  - `cg-native-exact@gsw`: 17474 px at steps 0 and 1 (HPBAR 2092, HPLOW 2854, CLIPDRAW 5632,
    GROUP 2800, NESTED 4096), 20546 px at step 2 (TGL added);
  - `cg-gsw-untyped@gsw`: 16396 and 19468 px beyond channel 1 of native, max 234.

Contact sheet (reference, native /10, GSW /10, GSW /9, GSW drop-canvas-group; 640x360 crop
(24,8)-(640,216) at 2x): `artifacts/render-stream/p3/cg3/g8cg-cells-gsw.png`.

## STS2 (no game launch)

**`p3tm-a10-2` carries no group state.** `p3tm-cut.rs10` is /10: 2922 records, 2920 transactions
and 168258 item entries. None has a non-null `canvas_group` or `copy_to_backbuffer`. The session
keeps both setters in `features.unobserved`. Its calibration record predates slots 484 and 495,
so the hooks were omitted, as cg1.md predicted.

**The GSW replay is unchanged.** The replay used:
- this increment's bundle (`build.json` `rs_core_build sha=66fe9b7a1a3d-dirty`, this worktree);
- `C3_GSW_PORT=13881`;
- the C3 harness (`replay-gsw.sh p3tm-a10-2 cg3-gsw`), over `p3tm-cut.rs10` with P3-TM's nine shot
  seqs (1175 to 2920: menu, map and combat).

All nine shots are byte-identical to P3-TM's GSW replay (`replay-gsw/`). `unsupported[]` is the
same: 4 non-root-viewport, 5 unsupported-material and 42 unsupported-op rows. That also exercises
P3-ST's screen readers through the new operation list: the menu blur's copy and mip chain give the
same bytes.

The HP-bar measurement is CG4's, on the recalibrated /10 leg.

## Validation

**Remote, full tier: 19/19 runs pass.** Run
[40464933182](https://github.com/tfoxy/godot-scene-web/actions/runs/40464933182), a snapshot of this
diff on 66fe9b7a. Summary: `artifacts/render-stream/p3/cg3/remote/validate-summary.json`.
- **Scope.** The plan reached everything: rs-core and `packages/canvas` map to `*`. Sabotage legs
  were on, because `rs-core/src/apply/mod.rs` names sabotages.
- **Setup:** `pure`, the four cargo runs (rs-core with the five new `cg3_tests` and the draw list's
  new `mergeable` test), `pnpm-test` and `bench-instr`. Instruction counts are within ±0.4% of
  baseline.
- **Native gates:** -1, 0, 1, 2, 3, 4, 5, 5.5 and 8.
- **Browsers:** `g7-gsw` and `g7-web-rust` over every group, `g7-8` with g8cg and `g7-55` with
  P3-ST's g55s included. Also the remote halves of `g7live-gsw` and `g7live-web-rust`: `g7-2`,
  `g7-5`, `g7-55` and `g7-8`.
- None of the known failures appeared.

**Local: the runs the hosted runners refuse** (both are g7-1's live halves), full tier:

| run | result |
| --- | ------ |
| `g7live-gsw` | 38 checks pass |
| `g7live-web-rust` | 39 checks pass |

Summary: `artifacts/render-stream/p3/cg3/local/validate-summary.json`.

**Smoke while iterating:** `pure`, `cargo-rs-core`, `cargo-gsw-rs` and `g7-gsw` (g7-0) pass, 4/4.

**After rebasing onto 0aa52cd0.** That commit (CGR) isolates the shader cache of g8cg's reference
runs. Two runs were repeated:
- native `run-gate8.sh --legs g8cg`: 12/12;
- GSW g8cg replay and checks on a bundle rebuilt from the rebased tree
  (`rs_core_build sha=d656d15c97b7`): the same numbers as above, every `cg-*@gsw` check passing.

**Also run:**
- `tsc` on `experiments/render-stream`: only the known `gate2b`/`gate8-cache`/`g8kv` errors;
- biome on the changed TypeScript: no new finding;
- `cargo fmt`: only this increment's hunks.

**Deferred to the milestone sweep:**
- native gate 6, the `g7live-*-timing` runs and `g7x`;
- the timing groups that the hosted runners skip.

A /10 session with group state now walks every apply. That cost belongs to the sweep's
measurements, not to this correctness change.

## Time

About 1 h of implementation:
- reading the engine and GSW code;
- the draw-list operations, the executor and the applier state machine;
- the g7-8 legs and the unit tests.

About 1 h 50 min of validation, mostly waiting:
- the local smoke (18 min; `pure` took 16 min under other agents' load);
- the STS2 replay (6 min);
- the local g7-1 live runs (37 min, most of it waiting for the quiet lock);
- the remote full tier (about 60 min).

The g8cg loop itself is cheap: native source 32 s, GSW replay of the six legs about 2 min.

## Evidence

`artifacts/render-stream/p3/cg3/` (main checkout):
- `g8cg-cells-gsw.png`, the contact sheet;
- `g8cg-native/result.json` and `g8cg-gsw/`: the gate 7 check log and the band classes of the
  post-rebase run;
- `sabotage-substituted-check.log`: the checker failing on the substituted drop-canvas-group
  output;
- `sts2-p3tm-a10-2/`: the scan output, the replay's notes and the shot comparison;
- `remote/` and `local/`: the validation summaries.
