# Item-identity fixture (`tag-scene`)

The fixture for the capture's `item_meta` identity rows
([`../../protocol/render-stream-13.md`](../../protocol/render-stream-13.md)).

It is a scene tagged with Godot's own mechanisms only: groups, metadata, instance scenes and
scripts. The capture resolves its canvas items into `item_meta` rows. The scene knows nothing about
the capture, and writes its own identity table as the oracle the rows are checked against.

## Files

- `project.godot`: 640x360, stretch disabled (`GRC_ROOT_SIZE=presentation:640x360`),
  `gl_compatibility`, autoload `GrcLoader`, main scene `tag.tscn`.
- `loader.gd`: capture-scale's loader (`RS_FIXTURE_ARM=born|late|thread`). The `g8tag` legs arm
  `late` at frame 12 with `GRC_ADOPT=arm` and `GRC_UNKNOWN_ITEM=skip`. Under a `born` arm the
  main scene's nodes exist before the capture arms.
- `tag.tscn` / `tag.gd`: the scene, its timeline and the oracle dump. The header comment of
  `tag.gd` lists every step.
- `card.tscn` / `card.gd`: the instanced card. Its root has a script. In `_ready` it joins group
  `rs_hand` and sets meta `rs_tag` (String) and `rs_slot` (int), and its `CardContainer` joins
  `rs_text` with a StringName `rs_tag`.

## What it exercises

| case                                            | where                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| instance scene and scene-relative path          | Card1..Card4: `res://card.tscn`, `.`, `CardContainer/DescriptionLabel`, `Art` |
| a reparented instance (identity unchanged)      | Card2: Hand to Table at step 20                                               |
| scripts                                         | `res://card.gd` on each card root                                             |
| groups and meta set in `_ready`                 | card.gd                                                                       |
| String, StringName and int meta                 | `rs_tag`, the container's `rs_tag`, `rs_slot`; Early's int `-3`               |
| no owner: scene and path null                   | Loose (made in `_ready`), Mover, Early                                        |
| no node                                         | Board's TileMapLayer rendering quadrant (step 5)                              |
| an item a frame before its node enters the tree | Early: made at step 30, added at 31                                           |
| frees and re-adds                               | Card3 freed and Card4 instanced at 40; Plain removed at 40, re-added at 45    |
| a re-key                                        | Mover moved under a SubViewport (never adopted: unknown) at 50, back at 60    |

## Environment

- `RS_FIXTURE_TAG_START` (default 0): every step's frame is shifted by that much. The live legs
  use 90, so that every viewer started beside the host is connected first.
- `RS_FIXTURE_QUIT_FRAME` (default 200 + start): the frame it quits at.
- `RS_FIXTURE_TAG_DUMP_AT` (LS3; a comma list of absolute frames, unset: none): an extra oracle dump
  at each of those frames. Gate 8's `g8re` re-arm round uses it to dump in every armed and idle
  phase of its swap cycle.
- `RS_FIXTURE_TAG_LOG` (an absolute path): the oracle, one JSON line per dump frame (1, 6, 21, 26,
  32, 41, 46, 51, 61, 150 after the start). Each line is
  `{"frame", "nodes": [{"rid", "class", "script", "scene", "path", "groups", "meta"}]}`, every
  CanvasItem in the tree keyed by `get_canvas_item().get_id()`. `groups` names the groups among
  `rs_hand`, `rs_text` and `rs_none` that the node is in. `meta` has one value per key in
  `rs_tag`, `rs_slot` and `rs_missing`: a String or StringName as itself, an int in decimal,
  otherwise null.

The fixture needs one editor `--import` before the release template can run it. The `g8tag` group
runs that import itself.

## Variants

`RS_FIXTURE_TAG_VARIANT` (unset: the base timeline exactly) adds two steps. At step 70 the game
makes the change a client override makes in the `override-oracle` check: `moved` moves Card1 by (0, −119),
`scaled` scales Card1's `DescriptionLabel` by 1.24 about its bottom centre (`pivot_offset`),
`hidden` hides `Table`, `tinted` sets `Hand`'s modulate to (1, 0.5, 0.5, 0.75), and `base` does
nothing. At step 80, under any variant, `Hand` moves by (10, 0): a transform-only frame that the
client's rows-only path must compose with the overrides. At step 100, `RS_FIXTURE_TAG_PAUSE_MS`
makes the main thread sleep that long: no frame, so no transaction (from /12 every frame's patch
carries the shader time), which is the window `override-redraw` animates in. The `g8tag2` legs (`run-gate8.sh`) run
the variants and the base scene beside an extension that makes the same change by tag.

## Pick

`RS_FIXTURE_TAG_PICK` (any value) replaces `tag.tscn` with `pick.tscn` / `pick.gd` before the
capture arms (`change_scene_to_file`, deferred from `tag.gd`'s `_ready`; the base timeline does not
run). The scene has one case per rule of Godot 4.5.1's GUI pick
(`Viewport::gui_find_control`) that the client's tree-order pick reproduces. The header comment of `pick.gd` lists them.

| case                                                                                                     | Godot picks                         | the stream's draw order shows |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------- |
| `ZHigh` (`z_index` 5) and its later sibling `ZLow`                                                       | `ZLow` where they overlap           | `ZHigh` on top                |
| `BChild` (`show_behind_parent`) in `BParent`                                                             | `BChild`                            | `BParent` on top              |
| `Card`: IGNORE `Face`, a drawn item with no node (step 5), STOP `Hitbox` drawing nothing                 | `Hitbox`                            | the no-node art               |
| `Pool`: a scaled, zero-size holder pooled outside the tree beyond 120 frames, with an undrawn STOP child | `PoolHitbox`                        | no drawn content              |
| `ClipBox` (`clip_contents`) and its child `Spill` reaching outside it                                    | not `Spill` outside the clip        | `Spill` scissored             |
| `Under` / `Over` in CanvasLayers -1 and 1                                                                | by layer                            | by layer                      |
| `TopKid` (`top_level`) in `TopParent`, the later `Late`                                                  | `TopKid` (a root after the scene's) | `TopKid`                      |
| `Decor` (a Polygon2D) over `Button`                                                                      | `Button`                            | `Decor`                       |
| `Rot` (30 degrees)                                                                                       | inside its rotated rect only        | the same                      |
| `Hidden` (with a visible child) over `UnderHidden`                                                       | `UnderHidden`                       | `UnderHidden`                 |
| `Ghost` (modulate alpha 0) over `UnderGhost`                                                             | `Ghost`                             | `UnderGhost` (Ghost culled)   |
| `Veil`, a transparent IGNORE ColorRect over `VeilButton`                                                 | `VeilButton`                        | `Veil`                        |

Every CanvasItem carries meta `rs_pick` (its name) and `rs_mf` (its
`get_mouse_filter_with_override()` as `"stop"`, `"pass"` or `"ignore"`; `"ignore"` for a CanvasItem
that is not a Control), which the `g8id` legs' extension states with `ExtensionSession.mouseFilter`.
At step 170 the fixture pushes a mouse motion (`Viewport.push_input`) at the centre of every cell of a
24x16 grid and records `gui_get_hovered_control()`'s `rs_pick`: one JSON line in
`RS_FIXTURE_TAG_PICK_LOG`, `{"frame", "size", "grid", "filters", "points"}` (points row by row, top
first, null for no Control). `RS_FIXTURE_QUIT_FRAME` defaults to start + 200 in this mode. The no-node
item is freed in `_exit_tree`, after the last frame, so the client's last frame still holds it.

## Variant V2

`RS_FIXTURE_TAG_V2` (any value; unset: the base scene exactly; no effect under `RS_FIXTURE_TAG_PICK`) is the fixture of item_meta
v2 (`instance_id`, `mouse_filter`, re-stamped rows; [`../../protocol/render-stream-14.md`](../../protocol/render-stream-14.md)). In `_ready` it adds, owned by
the scene:

| node                                                                                                                    | what it is for                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Flipper` (ColorRect)                                                                                                   | flipped with Card1 (an instance root) by `set_mouse_filter`    |
| `Nest` (Control) > `NestA` (Panel) > `NestB` (ColorRect) > `NestC` (ColorRect, PASS), and `NestD` (Label) under `NestA` | the recursive disable, which emits no signal: the sweep's case |
| `Pointy` (ColorRect, `haspoint.gd`)                                                                                     | a script `_has_point`: `mouse_filter` + 4                      |
| `Hitbox` (Control)                                                                                                      | a STOP Control that draws nothing                              |

The steps (shifted by `RS_FIXTURE_TAG_START`, after the base scene's work of that step):

- **40:** Card1 and Flipper `set_mouse_filter(IGNORE)` (from STOP).
- **50:** Card1 and Flipper `set_mouse_filter(PASS)`.
- **60:** `Nest.mouse_behavior_recursive = DISABLED`: Nest and every Control below it read IGNORE.

The oracle gains dumps at steps 40, 50 and 60 (after the change) and at the quit frame. Each line
also has `process_frames` (`Engine.get_process_frames()` in that `_process`; the capture stamps
that iteration's frame `process_frames + 1`) and, on a step's frame, `flips`:
`[{"step", "node", "rid", "mouse_filter"}]`, each Control changed, by its path from the scene
root, its canvas-item RID and its value after. Each node gains `instance_id` (`get_instance_id()`
in decimal), `mouse_filter` (`get_mouse_filter_with_override()`, plus 4 when the script's
`get_script_method_list()` has `_has_point`; null for a non-Control) and `plc_custom` (the custom
Callables connected to the Control's `property_list_changed`, from `get_signal_connection_list`;
null for a non-Control). The fixture knows nothing about the capture: those are Godot's own
answers. The `g8id14` legs (`run-gate8.sh`) run it.

`RS_FIXTURE_TAG_REARM_REENTRY=1` extends the re-arm round: Plain changes `rs_tag` while
detached before its first re-entry and again at frames 480–485 in arm 2. The two viewers
must receive both metadata updates with the same instance id, one filter connection while
armed, and no connections after either disarm. Other fixture runs keep their original schedule.
