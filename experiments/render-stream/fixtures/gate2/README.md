# Gate 2 fixture

The reference rendering for gate 2's texture increments (G2a,
[`../../protocol/gate2-design.md`](../../protocol/gate2-design.md) "Q6. Fixture `fixtures/gate2/`").
Eleven steps (0..10) exercise one procedural texture shared by four drawers, an identical twin,
binary LA8 alpha over two backgrounds, two raw placeholders, flips, regions, a transpose, a
rotation, filter and repeat at the item and root-viewport levels, changing pixels, replacement
(including a format change and a placeholder becoming an image), and lifetime: a free, a freed
texture still drawn, a main-thread create whose image is blacked out right after the call, and a
worker-thread create. Like the gate 0 and gate 1 fixtures, the project does not know about the
capture library and runs the same whether `GRC_EXTENSION` is set or not.

Import it once with the mise editor before the release template can run it:

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate2 --import
```

## Files

- `project.godot`: gate 1's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, the same `[debug]`
  warning-to-error keys, autoload `GrcLoader`), plus
  `rendering/textures/canvas_textures/default_texture_filter=0` (Nearest), so default draws are
  exact.
- `loader.gd`: gate 1's loader. Under `RS_FIXTURE_VARIANT=unsupported` it also makes `PRE` (RGBA8
  4×4) before it loads the extension, so that texture's create is never hooked.
- `gate2.tscn`: a root `Node` (not a `CanvasItem`) with `gate2.gd`.
- `gate2.gd`: builds every texture from bytes (no `set_pixel` rounding), every node in `_ready()`
  in paint order, and the raw `RenderingServer` items `RAW1` (draw index 1000) and `RAW2` (1001);
  `_process()` applies the timeline. Every `Sprite2D` is `centered = false`, so its position is its
  top-left corner and a flip mirrors it in place. Output lines start with `[fixture]`.
- `payload.gd`: the fixture's own `render-stream-texture/1` encoder (GRT1 bytes, `HashingContext`
  SHA-256). It is deliberately not shared with the receiver.
- `make_expected.py`: writes `expected.json` (`--check` compares values). It encodes the
  hand derivation from the engine source (its docstring cites the lines), not anything measured.
- `expected.json` (`render-stream-gate2-expected/1`): texture contents as data, the texture objects
  and which content each shows from which step, and per step the regions (they follow `G` and the
  canvas transform), the draws in paint order (each a flat colour or a texture sample), the
  `synth_exclude` regions, the RenderingServer texture-call census and the texture invariants
  G2b2 evaluates, and (G2b2) `receiver_resources`, the fresh-cache receiver's texture traffic per step; plus the two variants and the engine's own texture calls (`engine_textures`).

## Timeline

`S` = `RS_FIXTURE_START_FRAME` (default 1) and `N` = `RS_FIXTURE_STEP_FRAMES` (default 10, at
least 8). Step 0 is the `_ready()` state at frame 1; step _k_ ≥ 1 is applied at `S + N·k` and
settles at `S + N·k + 7`. The fixture quits at `S + N·10 + 11` (112) unless
`RS_FIXTURE_QUIT_FRAME` asks for later. Every step recolours the `Marker`.

| step | change                                                                                                                                                       | RS texture calls (census)                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 0    | `A` (RGBA8 16×16 quadrants) drawn by `S1`, `S2`, `TR`, `DR`; its twin `Atwin` by `S3`; `B` (LA8) by `SB` over `BG`; `P1`, `P2` by `RAW1`, `RAW2`; `M` unused | 5 `texture_2d_create` (4 + the theme's hue strip), 2 placeholders, 11 + 11 item filter/repeat |
| 1    | `S1.flip_h`, `S2.flip_v`, `TR.flip_h`; `DR` draws source (4,0,8,8) transposed                                                                                | none                                                                                          |
| 2    | `G` moved; `S3` rotated 90° by its transform                                                                                                                 | none (transform only)                                                                         |
| 3    | `S2`: item filter LINEAR, a 16×16 region with `clip_uv`                                                                                                      | 1 item filter                                                                                 |
| 4    | root viewport default filter LINEAR                                                                                                                          | 1 viewport filter                                                                             |
| 5    | root default back to NEAREST; `TR` tiles at 48×32; `DR` MIRROR repeat over source (0,0,32,32)                                                                | 1 viewport filter, 1 item repeat                                                              |
| 6    | `A.update(A1)`                                                                                                                                               | 1 `texture_2d_update`                                                                         |
| 7    | `A.set_image(A2)` (32×32); `B.set_image` (RGBA8, alpha .4)                                                                                                   | 2 `texture_2d_create`, 2 `texture_replace`                                                    |
| 8    | `S3` gets `C` (blacked out after the create); `Atwin` released; `D` made on a worker `Thread`; `P1` freed while `RAW1` draws it                              | 1 create (main), 1 create (other), 2 `free`                                                   |
| 9    | `texture_replace(P2, texture_2d_create(E))`; `MM` gets `M` with LINEAR_WITH_MIPMAPS                                                                          | 1 create, 1 replace, 1 item filter                                                            |
| 10   | `G` moved; root canvas transform shifted by (8, 4)                                                                                                           | none (transform only)                                                                         |

Two choices the contract left open, both recorded in README "Gate 2a result": every sprite is
`centered = false` (the layout table's regions place each sprite's top-left at its position), and
`DR`'s step-1 source is (4,0,8,8) rather than (8,0,8,8), because (8,0,8,8) lies wholly inside A0's
green quadrant and would draw the same pixels with or without the transpose.

The census counts the hook log's lines per step window ([S+N·k, S+N·(k+1)), the last window
through the quit frame), keyed `<op>` on the main thread and `<op>@other` elsewhere. Step 0's fifth
create is the engine's: the default theme gives ColorPicker an 800×6 `GradientTexture2D` hue strip
(`scene/theme/default_theme.cpp:1093-1097`) whose deferred `update_now`
(`scene/resources/gradient_texture.cpp:220-225`) runs in frame 1, after arming, as a plain create
(`:273-278`). It is declared in `expected.json` `engine_textures`.

## Variants (`RS_FIXTURE_VARIANT`)

- `animate`: `ANIM` (RGBA8 8×8, `k = frame mod 6` → `(k·.2, 1−k·.2, .4)`) at (280,120), scale 4,
  `update()`d at every frame from frame 1.
- `unsupported`: `U1` (RGBAF 4×4 → `unsupported-format`) at (336,120) and `U2` drawing the pre-arm
  `PRE` (→ `unknown-texture`) at (392,120), both scale 8, from step 0.

Any other value exits 2, as does gate 1's `RS_FIXTURE_TIE`.

## Environment

`RS_FIXTURE_STEP_LOG`, `RS_FIXTURE_SHOT_DIR`, `RS_FIXTURE_START_FRAME`, `RS_FIXTURE_STEP_FRAMES`,
`RS_FIXTURE_QUIT_FRAME` and `RS_FIXTURE_SHOT_FRAMES` behave as in gate 1. `RS_FIXTURE_TEXTURE_LOG`
(absolute path) gets one line per texture operation the script makes:
`{"step","frame","op","name","thread","format","width","height","mipmaps","data_bytes","payload_sha256"}`,
`op` being the RenderingServer call it causes (`texture_2d_create`, `texture_2d_update`,
`texture_2d_placeholder_create`, `texture_replace`, `free`). Creates and updates carry the payload
SHA-256 `payload.gd` computed before anything mutated the image. Invalid values exit 2.
