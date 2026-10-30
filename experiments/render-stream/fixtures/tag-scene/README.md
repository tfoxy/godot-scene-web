# Item-identity fixture (`tag-scene`, TAG1)

TAG1's fixture
([`../../protocol/client-extensions-design.md`](../../protocol/client-extensions-design.md) §6,
"As built (TAG1)"; results in [`../../results/p3/tag1.md`](../../results/p3/tag1.md)).

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

| case | where |
| ---- | ----- |
| instance scene and scene-relative path | Card1..Card4: `res://card.tscn`, `.`, `CardContainer/DescriptionLabel`, `Art` |
| a reparented instance (identity unchanged) | Card2: Hand to Table at step 20 |
| scripts | `res://card.gd` on each card root |
| groups and meta set in `_ready` | card.gd |
| String, StringName and int meta | `rs_tag`, the container's `rs_tag`, `rs_slot`; Early's int `-3` |
| no owner: scene and path null | Loose (made in `_ready`), Mover, Early |
| no node | Board's TileMapLayer rendering quadrant (step 5) |
| an item a frame before its node enters the tree | Early: made at step 30, added at 31 |
| frees and re-adds | Card3 freed and Card4 instanced at 40; Plain removed at 40, re-added at 45 |
| a re-key | Mover moved under a SubViewport (never adopted: unknown) at 50, back at 60 |

## Environment

- `RS_FIXTURE_TAG_START` (default 0): every step's frame is shifted by that much. The live legs
  use 90, so that every viewer started beside the host is connected first.
- `RS_FIXTURE_QUIT_FRAME` (default 200 + start): the frame it quits at.
- `RS_FIXTURE_TAG_LOG` (an absolute path): the oracle, one JSON line per dump frame (1, 6, 21, 26,
  32, 41, 46, 51, 61, 150 after the start). Each line is
  `{"frame", "nodes": [{"rid", "class", "script", "scene", "path", "groups", "meta"}]}`, every
  CanvasItem in the tree keyed by `get_canvas_item().get_id()`. `groups` names the groups among
  `rs_hand`, `rs_text` and `rs_none` that the node is in. `meta` has one value per key in
  `rs_tag`, `rs_slot` and `rs_missing`: a String or StringName as itself, an int in decimal,
  otherwise null.

The fixture needs one editor `--import` before the release template can run it. The `g8tag` group
runs that import itself.
