# Viewport surfaces fixture (`viewport-scene`, gate 8 group `g8vp`)

The fixture for render-stream/16's viewport surfaces (`protocol/render-stream-16.md`): non-root
viewports, their `viewport` textures and the `proxy` textures that show them. One scene,
`viewport_scene.tscn`, is run two ways by the same loader autoload, so a capture that adopted the
viewports at a late arm (`late`) can be compared with one that saw every viewport created (`born`).
The scene does not know about the capture and runs the same whether `GRC_EXTENSION` is set or not.
Everything is synthetic: polygons, lines, a procedural falloff texture and two solid frames.

## Files

- `project.godot`: gate 2's settings (640x360, stretch `disabled`, `gl_compatibility`, `msaa_2d=0`,
  `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, default filter Nearest, the `[debug]`
  warning-to-error keys), embedded subwindows, autoload `GrcLoader`, main scene
  `viewport_scene.tscn`.
- `loader.gd`: loads `GRC_EXTENSION` in `_enter_tree`. `RS_FIXTURE_ARM=born` (the runner sets
  `GRC_MODE=arm`) arms at load; `RS_FIXTURE_ARM=late` (the default; the runner sets
  `GRC_MODE=standby GRC_ADOPT=arm`) leaves the capture in standby and calls
  `RenderStreamCapture.arm({})` at fixture frame `K = RS_FIXTURE_ARM_FRAME` (default 12), the way a
  consumer arms. `RS_FIXTURE_ARM_LOG` gets one JSON line for the call (frame, return code, state
  before and after) and one per capture signal.
- `born.tscn` / `born.gd`: the `born` main scene, a plain `Node` that instantiates
  `viewport_scene.tscn` in `_ready`, after the capture armed.
- `viewport_scene.tscn` / `viewport_scene.gd`: the scene and its timeline (below).
- `late_drawing.tscn`: instantiated after the arm: a SubViewport shown through a scene
  `ViewportTexture` (`viewport_path`).
- `expected.json`: the hand-derived viewport census, per-leg accounts and the equivalence
  exceptions `scripts/lib/gate8-vp-checks.ts` reads.

Nothing is generated: the falloff texture and the animation frames are made in `_ready`.

## Scene

Every viewport has its own size, so the checker names each one by its parent chain and size.

| node                               | size         | what it covers                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DrawViewport` + `DrawRect`        | 480x810      | a transparent drawing surface with `Line2D` strokes and an eraser `Line2D` (`blend_sub` ShaderMaterial over a falloff texture in tile mode), shown by an expand `TextureRect` with a premultiplied-alpha `CanvasItemMaterial` through a scene `ViewportTexture`; update mode toggled `always` / `when_visible` |
| `OuterBox` > `OuterVP`             | 200x112      | a `SubViewportContainer` (stretch) holding a SubViewport with a `CanvasGroup` inside it                                                                                                                                                                                                                        |
| `OuterVP` > `InnerBox` > `InnerVP` | 96x54        | a nested SubViewport (`when_parent_visible`) in a container inside another SubViewport                                                                                                                                                                                                                         |
| `VP3D` + `View3D`                  | 96x96        | `Camera3D` and `MeshInstance3D` in its own `World3D`: `renders_3d`, `viewport-3d`                                                                                                                                                                                                                              |
| `EmptyCamVP` + `ViewEmpty`         | 64x48        | a `Camera3D` over an empty world: not 3D content                                                                                                                                                                                                                                                               |
| `SnapVP` + `ViewSnap`              | 48x48        | `disabled`, switched to `once` twice before the arm and once after (an adopted `once` viewport's `once_seq`)                                                                                                                                                                                                   |
| `AccumVP` + `ViewAccum`            | 64x64        | clear `never`: an accumulating surface                                                                                                                                                                                                                                                                         |
| `ShareA`, `ShareB` + views         | 40x40, 56x40 | one `World2D` in two viewports                                                                                                                                                                                                                                                                                 |
| `OpaqueVP` + `ViewOpaque`          | 72x40        | a non-transparent SubViewport                                                                                                                                                                                                                                                                                  |
| `Anim`                             |              | an `AnimatedTexture` (a proxy of images), paused so no host clock moves it                                                                                                                                                                                                                                     |
| `Popup`                            | 120x60       | an embedded borderless `Window`, last in the tree                                                                                                                                                                                                                                                              |
| `LateVP` + `ViewLate` (K+5)        | 50x30        | a SubViewport made by script after the arm, shown through its `get_texture()`; resized to 70x30 at K+20                                                                                                                                                                                                        |
| `LateDrawing` (K+5)                | 44x26        | a scene `ViewportTexture` re-pointed after the arm                                                                                                                                                                                                                                                             |

## Timeline

| frame    |                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------ |
| `_ready` | the scene as authored; textures bound, `ShareB` given `ShareA`'s world, `SnapVP` to `once` twice |
| 3        | `Stroke1` grows, `AccumDot` moves (before a late arm)                                            |
| K        | late: `arm()` from standby; checkpoint 0 settles at K+2                                          |
| K+5      | step 1: `LateVP` and `LateDrawing`                                                               |
| K+8      | `DrawViewport` to `when_visible`, `Stroke2` grows                                                |
| K+12     | the eraser stroke grows, `AccumDot` moves                                                        |
| K+14     | the `AnimatedTexture` shows frame 1                                                              |
| K+16     | step 2: `DrawViewport` to `always`, `SnapVP` to `once`, `AccumDot` moves                         |
| K+20     | `LateVP` resized to 70x30                                                                        |
| K+24     | `InnerPoly` turns, the canvas group fades, the popup moves                                       |
| K+28     | step 3: `DrawViewport` to `when_visible`, `Stroke1` grows                                        |
| K+44     | quit                                                                                             |

Steps settle 6 frames after they are applied. `RS_FIXTURE_STEP_LOG` gets one line per step,
`RS_FIXTURE_SHOT_DIR` a `step-<k>.png` at each settle frame on a rendered host.

## Expected

`expected.json` is hand-derived from the scene, not measured: 11 viewports before the arm, 2 after
it. `born` creates all 13 (13 constructor proxies bound by call adjacency, the two scene
`ViewportTexture`s by the node route on the headless host); `late` adopts 11 and creates 2. On a
rendered host the scene `ViewportTexture`s bind by render-target RID. `off` and `v15` count nothing.
The capture writes its evidence at stream end, after the scene's teardown freed every viewport,
so `freed` is only bounded and the final resolved viewport table is compared with
created + adopted instead.

One equivalence exception is this fixture's own: `Popup`, an embedded `Window`, registers before
the late arm, and that registration makes the root viewport's subwindow canvas (canvas layer 1024)
and the Window's texture-rect item on it. They are rendering-server objects no node exposes, so the
arm walk cannot adopt them. `born` has them and `late` does not. The checker excuses a root canvas
at layer 1024 that only `born` has, and only when it holds nothing but texture-rect draws of
viewports `late` adopted (`expected.json` `equivalence.subwindow_residue`). Anything else on that
canvas, or such a canvas only in `late`, still fails.

`run-gate8.sh --legs g8vp` runs the legs; `scripts/lib/gate8-vp-checks.ts` judges them.
