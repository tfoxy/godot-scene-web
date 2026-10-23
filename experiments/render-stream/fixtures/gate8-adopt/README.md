# Gate 8 adoption fixture (`gate8-adopt`, G8a)

The fixture for gate 8's arm-time late-join adoption
([`../../protocol/gate8-design.md`](../../protocol/gate8-design.md) D3-D5, "Q2. Late-join adoption").
One scene, `adopt.tscn`, is run two ways by the same loader autoload, so a capture armed after the
scene exists (`late`, `GRC_ADOPT=arm`) can be compared with one armed before it existed (`born`).
The scene does not know about the capture and runs the same whether `GRC_EXTENSION` is set or not.

## Files

- `project.godot`: gate 2's settings (640x360, stretch `disabled`, `gl_compatibility`, `msaa_2d=0`,
  `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, default filter Nearest, the `[debug]`
  warning-to-error keys), autoload `GrcLoader`, main scene `adopt.tscn`.
- `loader.gd`: gate 1's loader plus a late arm. `RS_FIXTURE_ARM=born` loads `GRC_EXTENSION` in
  `_enter_tree`; `RS_FIXTURE_ARM=late` (the default) loads it in `_process` at fixture frame
  `K = RS_FIXTURE_ARM_FRAME` (default 12, at least 8) through `GDExtensionManager.load_extension`,
  the modder's route (Q1a); `RS_FIXTURE_ARM=thread` does the same from a worker `Thread` (the
  stream must refuse `adopt-thread`). The autoload processes before the main scene, so the capture
  arms before the scene's own frame K.
- `born.tscn` / `born.gd`: the `born` main scene, a plain `Node` that instantiates `adopt.tscn` in
  `_ready`, after the capture armed: every canvas, layer and item is created under the hooks
  (memory gate0-route-a-fixture-rule).
- `adopt.tscn` / `adopt.gd`: the scene and its timeline (below). `box.gd`: a custom-drawn rect.
- `expected.json`: the hand-derived census and timeline the checker reads.

## Scene

| node | what it covers |
| ---- | -------------- |
| `World` (Node2D) | a moved, modulated parent; its texture filter changes before arm and its children inherit it |
| `World/Box`, `World/Box/BoxChild` | self-modulate (not inherited), z index 1, a nested item |
| `World/Behind` | `show_behind_parent`; moved to index 0 after arm (a child draw-index change) |
| `World/Spin` | rotation and scale, a rect and a circle |
| `World/Hidden`, `World/Hidden/HiddenRect` (ColorRect) | hidden before arm, shown after it: no commands until shown (Q2's exception) |
| `World/Sprite` (Sprite2D, scale 8) | a post-arm 4x4 texture, filter inherited from `World` (linear) |
| `World/TopA`, `World/TopB` | top-level items on the root canvas, raised before and after arm (move_to_front) |
| `World/ZHigh` | absolute z 3; freed after arm (an adopted item freed) |
| `UI` (Control, `clip_contents`) > `Back`, `Overflow` (clipped), `Inner` > `InnerRect`, `Tiled` (TextureRect tile, repeat enabled) | nested Controls, a clip, a clip turned on after arm, a tiled post-arm texture |
| `Layer` (CanvasLayer, layer 2, offset) > `Tint` (CanvasModulate), `LayerBox`, `LayerUI` | an adopted layer canvas, its stacking, transform and canvas modulate; hidden after arm |
| the residue | `RenderingServer.canvas_item_create` in `_ready`, parented to the root canvas at draw index 1000, no commands: an RS-only item with no node, which adoption cannot reach |

## Timeline

Fixture frames are the main-loop iteration (`_process` count). Under `GRC_ADOPT=arm` the capture
dates its frames the same way (entry.cpp aligns its counter with `Engine.get_process_frames()`), so
born and late recordings, the step log and the reference all share one clock.

| frame | |
| ----- | - |
| `_ready` | the scene as authored, the residue item |
| 5 | (before a late arm) World moves, TopA is raised above TopB, Hidden hides, World's filter becomes linear, UI moves |
| K | late: the capture arms and adopts. Checkpoint 0 settles at K+2 |
| K+4 | Hidden shows; a 4x4 checker `ImageTexture` is created and drawn by Sprite and Tiled; the residue is moved (`canvas_item_set_transform`); World's modulate changes. Checkpoint 1 at K+11 |
| K+14 | Behind moves to index 0, TopB is raised, Spin turns, Inner clips, the CanvasModulate colour and the layer offset change. Checkpoint 2 at K+21 |
| K+24 | the layer hides, a new item `Late` is added under World, ZHigh is freed, UI moves. Checkpoint 3 at K+31 |
| K+38 | quit |

The step log holds only the four checkpoints, in every leg, so the shots line up. At K-1 and K+1
the probe (`RS_FIXTURE_PROBE_LOG`) hashes every stored property of every node under `Adopt` and
records the `draw` signals seen so far (`adopt-no-scene-mutation`).

## Expected

`expected.json` is derived from the scene, not measured: 20 CanvasItems (World and its 10
descendants, UI and its 5, the layer's 3), 1 layer and its canvas, 2 items hidden at arm, 7
canvas-group members re-raised (World, TopA, TopB, UI on the root canvas; Tint, LayerBox, LayerUI
on the layer's), 1 CanvasModulate, 18 draw signals from the arm-time redraws, 22 probed nodes, 1
residue RID, and under strict the residue's call at K+4 as the sticky `pre-existing-object`.

Run it through `scripts/run-gate8.sh --legs g8a`.
