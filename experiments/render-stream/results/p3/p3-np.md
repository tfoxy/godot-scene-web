# P3-NP: C3 gap 9 is unhooked `clip_children`, not nine-patch (2026-10-25)

**Not fixed in this increment: the diagnosis changes its scope.** The enemy HP bars are nine-patch
draws, and both receivers already draw those nine-patches the way Godot does. The bars look wrong
because STS2 clips them with `CanvasItem.clip_children`. In the engine that is
`canvas_item_set_canvas_group_mode`, which the capture does not hook. Every recording declares the
method in `features.unobserved`, `a8-2` included.

Gate 3 deferred this on purpose (gate3-design.md D5 and Q1f: "the handoff's CanvasGroup/masks
capability"). Fixing it is that whole capability:

- a capture hook and mirror state;
- a wire change;
- a re-issue in the native receiver and the web export;
- backbuffer compositing in GSW.

It also needs a game launch, because `a8-2` holds no group state to replay. That is well past this
increment's 4 h budget, so this increment lands the diagnosis and a proposed split (below) for the
orchestrator to schedule. No code changed, so the STS2 numbers are P3-CT's.

## What the bars are

Every HP bar is one `health_bar.tscn` instance (STS2's recovered project). At `a8-2` seq 1838,
for the Ironclad:

| item | node | commands | `clip_children` |
| ---- | ---- | -------- | --------------- |
| 7978 | `HpBackground` (`NinePatchRect`) | `add_nine_patch`, texture 20x16, margins 9/0/9/0, stretch/stretch, `draw_center` | 0 |
| 7980 | `HpForegroundContainer` (`Control`) | none | 1 (clip only) |
| 7981 | `Mask` (`NinePatchRect`) | `add_nine_patch`, texture 12x10 (pointed caps), 232x10, margins 6/0/6/0 | 1 (clip only) |
| 7982 | `HpMiddleground` | `add_nine_patch`, texture 15x16, 229x18 at y -4, modulate orange | 0 |
| 7984 | `HpForeground` | `add_nine_patch`, texture 15x16, 232x18 at y -4, self-modulate red | 2 (clip and draw) |

- **In Godot.** The 18 px red and orange fills are clipped to the alpha of `Mask`'s 10 px
  pointed-cap nine-patch, which itself is not drawn. The result is a thin bar with pointed caps.
- **In the replay.** The mode never reaches the wire, so the 18 px fills draw unclipped. That gives
  C3's square-ended, full-height bars, with the dark `HpBackground` tip showing past the right end.
  Crop: `artifacts/render-stream/p3/p3-np/p3np-crop-bars-before.png`, showing the reference, native
  and GSW.
- **The nine-patch path is right on both receivers.** GSW against native over the five bar rows
  differs by at most 1 at every pixel. Native against the reference differs by up to 228.
  - The commands carry everything the engine received: source rect, margins, axis modes and
    `draw_center`. Every bar is `stretch`/`stretch` with `draw_center` on.
  - The native receiver re-issues the same call to the same engine.
- **STS2-wide.** The recovered project has `clip_children` on 110 nodes in 59 scenes: 44 clip-only
  and 66 clip-and-draw. These include the HP bars, `card_grid`, the timeline screens and the boss
  and underdocks backgrounds. Two scenes use `CanvasGroup`, which sets the same RS state in
  `transparent` mode (`scene/2d/canvas_group.cpp:37`). The gap is wider than the HP bars.

## Engine semantics a receiver must reproduce (Godot 4.5.1)

- **State.** `canvas_item_set_canvas_group_mode(item, mode, clear_margin=5, fit_empty=false,
  fit_margin=0, blur_mipmaps=false)` (`rendering_server.h:1626`).
  - `clip_children` sends only `mode` (`canvas_item.cpp:1688-1705`), and never for a
    `CanvasGroup` node.
  - `CanvasGroup` sends `transparent` with `fit_empty=true`.
  - The state is item state, freed with the item (`renderer_canvas_cull.cpp:2015-2032`, `:2611`).
- **When it applies.** An item is a group owner only if it has commands, or `fit_empty`
  (`renderer_canvas_cull.cpp:452`, `:462`). So `HpForegroundContainer`, a `Control` with no draw,
  is not a group at all. Only `Mask` is.
- **Order.** A group owner's children, `behind` or not, are attached before the owner
  (`:468-478`). The owner draws after its subtree.
- **Range.** The group covers the draw-list entries of its z layer added since the owner started
  (`_attach_canvas_item_for_draw`, `:186-246`).
  - Its rect is the union of their global rects, grown by `clear_margin`.
  - With `fit_empty` and no commands, the owner gets a synthesized rect command
    (`CANVAS_RECT_IS_GROUP`).
- **Drawing** (`rasterizer_canvas_gles3.cpp:463-516`, `:608-619`). At the group's first entry, the
  target inside the group rect is copied to the back buffer (`clear` for `transparent`). A
  `clip and draw` owner is drawn plainly into it first, then the group's entries are drawn into
  it. At the owner, its own commands draw to the target:
  - `clip only` and `clip and draw` use the default clip-children shader. It sets
    `COLOR.rgb = backbuffer(SCREEN_UV).rgb` and keeps the owner's alpha
    (`rasterizer_canvas_gles3.cpp:2869-2883`).
  - `transparent` uses the canvas-group shader: un-premultiply the back buffer, `COLOR *= c`
    (`:2844-2860`). It uses the item's own material instead if it has one.
- **Nesting.** The renderer keeps one open group: an entry naming an inner group while one is open
  is ignored (`:463-490`).
  - A clip-only owner reached with no open group is skipped (`:492`).
  - So `HpForeground`'s `clip and draw` with no drawn children draws plainly inside `Mask`'s group.
- **Shared mechanism.** The back buffer is also what screen-texture shaders (P3-ST, gap 1) and
  `BackBufferCopy` (`canvas_item_set_copy_to_backbuffer`, also `unobserved`) use. GSW's
  implementation should be built once, for all three.

## Proposed split (for the orchestrator)

Wire: `/10` = `/9` plus one item key, `"canvas_group": null | {"mode": "clip_only" |
"clip_and_draw" | "transparent", "clear_margin", "fit_empty", "fit_margin", "blur_mipmaps"}`.

- The key is item state. It never bumps `content_version` and survives `canvas_item_clear`.
- `features.unobserved` loses the method.
- An optional key on `/8`/`/9` would avoid the bump. The only precedent for that is an opt-in
  (`unknown-item-skip.md`), and the versioning rule ("any change to … a key … is a new version")
  says bump. So bump.

1. **CG1: capture and wire.**
   - Calibrator 10 adds the slot. The hook is
     `void (*)(void *, RID, int32 mode, float, bool, float, bool)`.
   - Mirror state, snapshot and diff.
   - `/10` in the C++ encoder, the TS library and `rs-core` (decode, validate, resolve), with
     `golden-10`.
   - The STS2 calibration record (`sts2-megadot-4.5.1-m12.p3.json`) is regenerated with
     calibrator 10.
2. **CG2: native receiver, web export and the generic fixture.**
   - `rs-core-capi`'s plan re-issues the call on a change; the engine does the rest. The web
     export inherits this through the same planner.
   - New gate 8 group, by analogy with `g8c`: an unarmed reference, both sinks, a GSW band and a
     web half. Fixture `gate8-cg`, one cell per construction:
     - this HP bar (a command-less clip-only `Control`, a clip-only nine-patch mask over taller
       stretched fills, and a clip-and-draw child);
     - a clip-and-draw mask with partial alpha;
     - a `CanvasGroup` of overlapping translucent children;
     - a nested group;
     - a `behind` child;
     - a mode toggled at a step.
   - The pre-CG1 capture is the negative control: full-height fills.
3. **CG3: GSW compositing.** Back-buffer copy or clear of the group rect, the in-group draws into
   it, and the owner's commands with the clip or canvas-group program. It shares the back buffer
   with P3-ST's screen-texture work, so it should land after P3-ST, or with it.
4. **CG4: adoption and STS2 confirmation.**
   - `GRC_ADOPT=arm` must record the group state of nodes that exist at arm (gate 8 Q2's state
     pass).
   - Then one `a8` game leg to confirm, because the kept recordings cannot show group state.

Rough cost: CG1 and CG2 are about one increment each at this repo's validation depth. CG3 is the
largest. CG4 is small, plus one game launch.

## Other combat residuals (C3 gap 10)

- **Fainter creature shadows: not reproduced after P3-CT.** At `a8-2` seq 1838 the shadow ellipses
  under the slimes and the Ironclad match the reference by eye
  (`artifacts/render-stream/p3/p3-np/p3np-crop-shadow.png`). C3 saw them next to white spine
  silhouettes, before P3-CT.
- **GSW map gear edge (53 vs 64 dB): one-line diagnosis, not fixed.** The settings gear (item 2604)
  is one `add_texture_rect_region`:
  - a 114x110 source region of a 2048x2048 atlas, without mipmaps (BPTC, host-decoded);
  - drawn at 64x61, so minified about 1.8x, at a half-pixel y (`rect.y = 1.5`);
  - linear filter, under a ShaderMaterial (the h/s/v shader).

  The delta sits only on the icon's alpha edges, so this is GSW's custom-shader path sampling or
  blending translucent minified texels differently from GLES3. It is not related to clip children.

## STS2 numbers (kept `a8-2`, no game launch)

No receiver or capture code changed, so these are P3-CT's replays
(`legs/a8-2/replay/p3ct-{native,gsw}` in C3's research folder):

| scene | native | GSW |
| ----- | ------ | --- |
| menu | 2.93–2.94 dB (gap 1) | 2.93–2.94 dB |
| map | 64.12–64.17 dB | 53.26 dB |
| combat | 26.22–26.23 dB | 25.01–25.02 dB |

The HP bars account for about 1,000 pixels over 8 per enemy bar row (native against the reference).

## Validation

None was needed: this commit is documentation only. Nothing launched the game.

## Evidence

The evidence is in `artifacts/render-stream/p3/p3-np/` (ignored, game-derived):

- the bar and shadow crops;
- the raw item dump of the bar subtree (`p3np-items.json`) and of the gear (`p3np-items-gear.json`);
- the dump script (`p3np-dump.mts`, after C3's `dump-items.mts`, with full command arguments).
