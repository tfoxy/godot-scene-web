# P3-VX: vertex() on GSW (2026-10-25)

**GSW now runs canvas_item `vertex()` code, in Godot 4.5.1's own order.** Before, its
item-shader transpiler refused every shader with a `vertex()` (`gsw-shader-transpile`, "vertex()
is not supported"), and GSW drew those items without their material.

On STS2 that refusal was the whole map gap: the settings gear's HSV shader (`v = 0.9`) only copies
`COLOR` into a varying. It also cost part of combat. Replayed without a game launch, GSW now
reaches:

- map **65.5 dB**, from 53.3 (native 64.1), with no pixel over 16;
- combat **26.2 dB**, from 25.0 (native 26.2);
- menu 31.1 dB, unchanged.

The native receiver and the web export were never affected: Godot compiles the code. There is
no wire change.

Design and reference: [gate5_5-design.md](../../protocol/gate5_5-design.md), "vertex() (P3-VX)".

## What changed

- **`packages/effects` transpiler** (`transpileGodotItemShader`):
  - `vertexGlsl` is a second module, beside the fragment one. It holds the same uniforms and
    samplers, the varyings `out` (with `flat`/`smooth` and precision kept), the constants and only
    the helpers `vertex()` reaches, and `godot_item_vertex(inout VERTEX, UV, COLOR, POINT_SIZE,
    in MODEL_MATRIX, CANVAS_MATRIX, SCREEN_MATRIX)`.
  - New result fields: `vertexStage`, `skipVertexTransform`, `worldVertexCoords` and `varyings`.
  - `skip_vertex_transform` needs the vertex stage even without a `vertex()`: GLES3 then never
    applies the model matrix. The old comment said it changed nothing.
  - `TEXTURE_PIXEL_SIZE` (both stages), `AT_LIGHT_PASS` (`false`) and `INSTANCE_CUSTOM`
    (`vec4(0)`, as for every non-multimesh draw) are admitted.
  - A shader without `fragment()` is admitted.
  - An int literal beside an `int(...)`/`ivecN(...)` call stays int. Before, `int(x) / 64` was
    promoted to `/ 64.0` and failed GL compilation.
  - Precise refusals remain, each naming its reason:
    - `TIME`, `VERTEX_ID` and `INSTANCE_ID` (GLES3's per-batch indices);
    - `CUSTOM0/1`;
    - fragment-only names in `vertex()`;
    - `mat`/sampler varyings and multi-name varying declarations.
- **`packages/canvas` executor** (`canvas_items::item_program_vertex`): the vertex stage in
  canvas.glsl's order.
  1. `COLOR` is the vertex colour times the row's modulate, before the code.
  2. `MODEL_MATRIX` is `canvas⁻¹ · row xform`.
  3. The render modes are applied around the code.
  4. Then the canvas transform, then the screen transform.
  Programs without a vertex stage keep the builtin stage unchanged.
- **`rs-core`**:
  - A vertex-stage binding carries its canvas's transform and Godot's float32 `affine_inverse` of
    it. Bindings are already per canvas, so batching is untouched.
  - Rect indices follow GLES3's indexed quad `{0, 2, 1, 3, 2, 0}`
    (rasterizer_canvas_gles3.cpp:2819): the same triangles, with the host's provoking vertices,
    so `flat` varyings match.
- **Sabotage `vertex-flat-varyings`** (native and GSW, `programs::flat_varyings`): every varying is
  made `flat` before the receiver compiles the code.

Found on the way: GLES3's rect provoking vertices are (0,1) and (0,0), not (1,1). The fixture's
first reference shot showed this, the source confirmed it (`indices[6] = {0, 2, 1, 3, 2, 0}`), and
GSW's quad order now follows it.

## Generic reproducer: `fixtures/gate55-vertex`, group `g55v`

Twelve items: VH (the gear's shape), VP, VD, VU, VF, VS1, VS2, VW, VT, VM, and VC/VLD in a scaled
CanvasLayer (see the fixture README). Five steps change a parameter, a node position, the layer
offset and a modulate.

The checks (`scripts/lib/gate55v-checks.ts`):

- the capture carries all 12 shaders `ok`;
- the reference repeats;
- the reference equals a hand model of the vertex stage at every solid or texel-exact item;
- every receiver equals the reference: native exactly, browsers within 1;
- the sabotage differs in VP and VM only.

Before the fix, GSW refused all twelve shaders and drew them plain.

| Receiver | g55v |
| -------- | ---- |
| native | 7/7: exact at every step; the sabotage differs in VP and VM only |
| web export (g7-55 live) | 7/7: within 1 (max delta 1) |
| GSW (g7-55 live) | 7/7: within 1 (max delta 1), geometry exact |

The reference matches the hand model in every probed item. That confirms canvas.glsl's order on
the engine itself: skip without `vertex()`, world coords, model after the code, the canvas matrix
split, TEXTURE_PIXEL_SIZE and SCREEN_MATRIX's y direction.

**Executor pixel test** (`canvasItemsProgramPixel.test.ts`, real GPU, both orientations): a new
`programVertex` case checks a hand model of displacement with the modulate fold, both skip modes,
a flat varying, a UV flip, world coords under a non-identity canvas matrix, and
TEXTURE_PIXEL_SIZE. It passes 22/22. With the wrapper mutated to apply the model before the code,
it fails.

## Validation

- **Remote, full tier** (run 40211051573, base `674c6215`): **19/19 pass**. That covers `pure`,
  cargo ×3, `pnpm-test` and `bench-instr`; native gates -1 to 5, 5.5 and 8 with their sabotage
  legs (gate 5.5 includes g55v); and `g7-gsw`, `g7-web-rust`, `g7live-gsw` and `g7live-web-rust`.
  Every gate 7 group stays exact after the rect index-order change.
- **Local, the remote's refused runs:** `g7live-gsw` and `g7live-web-rust` on group g7-1, 2/2 pass.
  The g7-55 live groups (g55f, g55s, g55v) on both browsers also pass, 2/2.
- **After rebasing onto `d22c3a53`** (P3-LV, P3-HX; only `receiver.gd` overlapped):
  - smoke `native-rust-gate55` and cargo ×3: 4/4 pass;
  - `g7live-gsw` on g7-55: pass.
- **Not run:** the timing runs (native gate 6, `g7live-*-timing`, `g7x`), deferred to the
  milestone sweep. The change adds per-binding uniforms for vertex-stage programs only.
- **Also run:**
  - `packages/effects` unit tests (173/173, eight new vertex-stage cases) and `pnpm test`
    (2527 pass);
  - `pnpm typecheck` and `typecheck:ts6`;
  - biome on the changed TypeScript;
  - `tsc` on the experiment (only the known `gate2b`, `gate8-cache` and `g8kv` errors);
  - `make-features --protocol 8 --check`;
  - the `rs-core` `flat_varyings` unit test. `replay.rs` pins `vertex-flat-varyings` as inert on
    golden-6, which has no varyings.

## STS2 confirmation (`p3st-a8-1`, `p3st-cut.rs8`, no game launch)

C3's `replay-gsw.sh` with this increment's final code: the served `build.json` reads
`rs_core_build sha=dfda0f940aad`, this worktree's commit. Port 13875, out `p3vx-gsw2`.
`launcher.out` records P3-GX's link replacement. An earlier bundle from before the rect
index-order change (`p3vx-gsw`, port 13874) gave identical numbers.

PSNR in dB against the in-process reference, min-max over the three shots per scene:

| scene | native (P3-GX) | GSW before (P3-GX) | GSW P3-VX |
| ----- | -------------- | ------------------ | --------- |
| menu | 31.06-31.16 | 31.09-31.19 | 31.09-31.19 |
| map | 64.09-64.18 | 53.25-53.26 (1,623 px > 16, all the gear) | **65.47-65.53** (0 px > 16) |
| combat | 26.16-26.19 | 24.97-24.99 (72k px > 16) | **26.17-26.20** (34k px > 16) |

In the replay, GSW transpiles the gear (`03ddc06b`), combat shaders 30 and 31 and the screen
reader `ed56752c`. Shader 32 (`22b48677`) stays refused: its sampler `flipbook_curve` has
`hint_default_black`. That is a separate gap (no black default texture in the binding), and so is
the particle shaders' `INSTANCE_CUSTOM` (GSW draws no multimesh/particles).

## Evidence

`artifacts/render-stream/p3/p3-vx/` (main checkout, ignored):

- `compare.json` and `compare.txt`: the three receivers above;
- `sheet-v2.png`: the contact sheet;
- `gear.png`: reference | native | GSW before | GSW after, at the gear, 5x;
- `sts2-launcher.out`;
- `g55v-native/`, `g55v-gsw/` and `g55v-web/`: result.json and shots;
- `validate-g7-55-summary.json`.

## Not done

- **Draw transforms:** GSW's vertices carry the command's draw transform already applied, so
  `vertex()` code that is not affine sees a different `VERTEX` under `draw_set_transform` or a
  mesh transform. No fixture or STS2 item needs this.
- **Nine-patch and clip-UV rects** are split into cells.
- **`hint_default_black`/`transparent` samplers** stay refused. That is STS2's shader 32, and a
  separate gap: the binding has no black default texture.
