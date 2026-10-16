## Gate 0 WP1: calibrator 3, mirror and root query (2026-10-09)

Calibrator 3 adds the 11 tier-3 hooks (slot table above). Gate −1 with them, run
`artifacts/render-stream/gate-minus1/20261009T043727Z/` (ignored), passes 28 of 28 checks with
42 hooks planned and none omitted, and `armed.png` is still byte-identical to `unarmed.png`. The
headless-armed counts of the new hooks are `viewport_attach_canvas`, `viewport_set_canvas_transform`,
`canvas_create`, `canvas_item_set_self_modulate` and `canvas_item_set_z_index` 1 each (the spike's
post-arm `CanvasLayer` and `Node2D`); `canvas_item_set_parent`, `_set_visible`,
`_set_visibility_layer` and `_set_draw_index` 6 each (the scene entering the tree after arming);
and `canvas_item_set_clip` and `_set_custom_rect` 5 each (`Control` redraws). The captured values
decode exactly: the `ColorRect`'s custom rect is `0,0,120,80`, `z_index` is 1, and the
self-modulate bits are those of `Color(0.5, 0.75, 1, 1)`.

A temporary `GRC_RS0_PROBE` hook (removed when the stream was wired) proved the mirror and the
root query at runtime before the publisher existed. On a
scratch fixture shaped like gate 0's (a root `Node` that creates its `Node2D`s in `_ready`), the
root query returned the root viewport and canvas RIDs, an identity canvas transform, cull mask
`0xffffffff` and the project's clear colour, and the snapshot was `ok`: two items on canvas 1 in
append order with draw indices 0 and 1, the moved transform, the redrawn colour, and the freed
child gone. On the spike, whose scene items exist before arming, it was `pre-existing-object` at
the root node's `canvas_item_set_parent`, with the `CanvasLayer` reported as `extra-canvas`.

One measured fact differed from the first contract text: under `--headless`, the root
`Viewport.get_visible_rect()` at arm time is `0, 0, 64, 64`, not `0, 0, 0, 0`. The headless
display server reports `Size2i()`, but `SceneTree` gives the root window a 64×64 minimum size
(`scene/main/scene_tree.cpp:2035`), and `Window::_update_window_size` clamps to it
(`scene/main/window.cpp:1144-1150`). The session records the value as read, so only the
documentation was affected; both protocol documents now say 64×64.

## Gate 0 result (2026-10-09)

**Pass.** The integrated run is `artifacts/render-stream/gate0/20261009T050442Z/` (ignored, not
committed; produced in the integration worktree). Its `result.json` has `gate_passed: true` and
passes 19 of 19 checks ([protocol/gate0-design.md](../protocol/gate0-design.md) "Checks"). Every leg
classifies as expected. The capture host is the pinned release template under `--headless` with
the 42-hook library armed at `scene-init` (calibrator 3, none omitted); the reference and the
receiver are the same template rendering OpenGL 3.3 on the RTX 2060 inside one private gamescope.
Gate −1 on the same build still passes 28 of 28
(`artifacts/render-stream/gate-minus1/20261009T050631Z/`).

| Leg                       | Class (expected = measured)           | Measured                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                 | `success`                             | 400 transactions, frames 1..400, every status `ok`; `bytes_total` 429 425 (file 429 610 with the end record), `max_record_bytes` 2 873 (the session; transactions 1 062–1 067), `encode_ns_total` 2 184 113, `snapshot_ns_total` 378 958                    |
|                           |                                       | session: `display_server` `headless`, `clear_color` `0.2, 0.2, 0.4, 1`, identity root canvas transform, cull mask `4294967295`, `host_visible_rect` `0, 0, 64, 64`; no GPU device or library in the `openat` trace or the maps/fd sample                    |
|                           |                                       | 39 intercepted calls in 400 frames: 2 `canvas_item_create` (the `Node2D`s, after arming), 4 `set_parent`, 2 `set_draw_index` (0 and 1), 4 `set_transform` (2 initial, 2 moves), 8 `clear` + 8 `add_rect` (3 subject and 5 marker draws), 6 `free`           |
| `reference`               | support                               | 5 shots, each equal to `synthesizeExpected(k)` exactly                                                                                                                                                                                                      |
| `receiver`                | `success`                             | 400 seqs applied in order, each `record_sha256` equal to the host's; shots of seqs 8, 18, 28, 38, 48 (the settle frames), each equal to `synthesizeExpected(k)` and to the reference: 0 mismatched pixels, max channel delta 0, full frame and both regions |
| `receiver-headless-trace` | support                               | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a fixture file                                                                                                                                                |
| `sabotage-freeze`         | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), steps 3 and 4: 13 312 px each; max channel delta 255                                                                                                                      |
| `sabotage-omit`           | `pixel-mismatch`, step {2}            | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), delta 255; steps 3–4 exact again (the next update repairs the snapshot)                                                                                                   |
| `sabotage-perturb`        | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; steps 2–4: 192 px each (subject 64, marker 32 inside the regions: one-pixel columns at both edges of each rect), delta 204                                                                                                |
| `unsupported`             | `unsupported`                         | the recording carries `canvas_item_add_circle` as an `unsupported` command and an `unsupported-op` entry from step 2; the headless receiver reports it in `applied.json`, does not draw it, and ends `ok`                                                   |
| `preexisting`             | `capture-failure`                     | every one of 52 transactions is `pre-existing-object`: `rid=… op=canvas_item_set_parent frame=1` (the `.tscn`'s `Node2D`, constructed before arming)                                                                                                        |
| `corrupt`                 | `replay-failure` (seq 3, `meta-json`) | the receiver applied seqs 1–2 (24 and 0 RS calls), rejected seq 3 (`meta byte 0 is 0x00`) before any RS call for it, and exited 3                                                                                                                           |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..4).
- Receiver: `receiver/shots/seq-{8,18,28,38,48}.png`; per-step diffs `receiver/diff/step-<k>.png`
  (all blank).
- Sabotage: `sabotage-{freeze,omit,perturb}/receiver/shots/seq-<n>.png` and
  `sabotage-*/receiver/diff/step-<k>.png`; for example `sabotage-freeze/receiver/diff/step-3.png`
  marks the stale marker, the stale subject and the missing moved subject.

### The gate fails when it should

| Sabotage (capture host)                                 | What the receiver drew                                    | Check that classifies it                        |
| ------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `freeze-frame` at 21: republish the frame-20 snapshot   | step 1's picture from step 2 on                           | `leg-class-sabotage-freeze`                     |
| `omit-update` at 21: mutations stamped 21 not mirrored  | step 1's picture at step 2 only; step 3 repairs it        | `leg-class-sabotage-omit`                       |
| `perturb-transform` at 21: `origin.x + 1` on every item | everything one pixel to the right from step 2             | `leg-class-sabotage-perturb`                    |
| fixture draws a circle (`RS_FIXTURE_VARIANT`)           | the rectangles, with the circle reported and not drawn    | `leg-class-unsupported`                         |
| scene item constructed before arming                    | (no receiver: the capture is unusable)                    | `leg-class-preexisting` (`pre-existing-object`) |
| seq 3's first meta byte zeroed in the receiver's copy   | seqs 1–2, then a replay failure with no RS call for seq 3 | `leg-class-corrupt`                             |

In each sabotage leg steps 0 and 1 matched exactly, so the mismatch starts where the sabotage does.
The classifier never reads `session.sabotage`. The publisher's refusal path was also run by hand
(not a gate leg): `GRC_SABOTAGE=bogus` and `GRC_SABOTAGE_FRAME=0` each armed, created no file and
left `stream.status: "refused"`; `GRC_DISARM_AFTER_FRAMES=30` ended a valid recording with
`reason: "disarm"` after 30 transactions.

### What this proves

- The stock 4.5.1 release template under `--headless`, with no GPU device opened, can publish a
  self-validating snapshot of the hooked canvas state every frame, through the gate −1
  interposition alone, and the snapshot is enough to redraw this fixture exactly.
- A separate Godot project that has no extension, no autoload and no copy of the fixture rebuilds
  that canvas from the recording through ordinary `RenderingServer` calls, and renders it
  pixel-identically to both the fixture rendered normally and an image synthesized from
  `expected.json` at five checkpoints.
- The receiver consumed exactly the bytes the host wrote (record hashes match), and a frozen,
  dropped or shifted update shows up as a pixel mismatch at the step where it starts.

### What this does not prove

- One rectangle per item, opaque, axis-aligned, integer coordinates, colours that land exactly on
  8-bit values, no overlap, no ties in `draw_index`. Every other draw op is only reported as
  `unsupported`; textures, text, materials and meshes are not streamed.
- The `unobserved` state in the session (texture filter/repeat, light mask, `z_as_relative`,
  y-sort, `canvas_set_modulate`, ...) is not hooked, so a scene that changes it would replay
  wrongly without any failure being reported.
- Arming must precede every canvas item (route (a), a fixture autoload). Late join and the
  deferred-arming path are gate 8; on them the capture is `pre-existing-object` by design.
- The receiver replays from a file, one transaction per `_process`, with no pacing, transport,
  credit or coalescing (gate 1). Cost numbers are for two items: about 5.4 µs encode and 0.95 µs
  snapshot per frame, about 1 060 bytes per transaction.
- Not run on MegaDot or the shipped game.

