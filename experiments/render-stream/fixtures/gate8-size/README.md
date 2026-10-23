# Gate 8 size fixture (`gate8-size`, G8h)

The fixture for gate 8's presentation size at a late arm
([`../../protocol/gate8-design.md`](../../protocol/gate8-design.md) D10, "Q4. Host size at a late
arm", "As built (G8h)"). One scene, `size.tscn`, is run two ways by the same loader autoload: armed
after the scene exists (`late`, `GRC_ADOPT=arm`, `GRC_ROOT_SIZE=presentation:640x360`) and armed at
birth (`born`, main scene `born.tscn`). The scene does not know about the capture.

## Files

- `project.godot`: logical 640x360, stretch `canvas_items`, aspect `expand`, `gl_compatibility`,
  `msaa_2d=0`, snap controls to pixels, autoload `GrcLoader`, main scene `size.tscn`.
- `loader.gd`: as `gate8-adopt`'s (`RS_FIXTURE_ARM=born|late|thread`, `RS_FIXTURE_ARM_FRAME`,
  default 12).
- `born.tscn` / `born.gd`: instantiates `size.tscn` in `_ready`, after a birth arm.
- `size.tscn` / `size.gd`: the scene and its timeline (below).
- `expected.json`: the hand-derived host sizes and counts the checker reads.

## Scene

A `Control` filling the window, with a `Back` panel (rounded, bordered, anti-aliased `StyleBoxFlat`:
the stylebox feather reads the stretch scale), a `Corner` panel and a `Note` label anchored to the
bottom-right, an `Edge` strip anchored to the right edge (it shows the visible rect's width), and a
`Title` label (32 px). At the headless 64x64 root window the stretch scale is 0.1, the visible rect
640x640 and oversampling 0.1; after `set_min_size(640,360)` they are 1, 640x360 and 1.

## Timeline

| frame | |
| ----- | - |
| K=12 | the late capture arms and adopts, then sizes. Checkpoint 0 settles at K+2 |
| K+4 | Title gets new glyphs, Corner's self-modulate changes. Checkpoint 1: K+11 |
| K+14 | Note's font size grows, Back's border widens. Checkpoint 2: K+21 |
| K+26 | quit |

`RS_FIXTURE_SIZE_LOG` (absolute path) gets the engine's window, visible rect, stretch and
oversampling at K-1 and K+1. The reference is this project run unarmed in a 640x360 window.
