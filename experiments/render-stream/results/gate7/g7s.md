## Gate 7s result (2026-10-15)

G7s ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7s", Q5 "Materials", Q7, Q14) draws gate
5.5's materials in the GSW canvas receiver. CanvasItemMaterial blend and light modes map to the
executor's blends. Custom ShaderMaterial code runs as item-space programs with live parameters.
Anything outside the subset gets a typed refusal. Before G7s, the receiver drew `SM` with the
builtin program and refused it with `gsw-shader-builtin`. **`g7-55` passes for `gsw`:** 22 legs
and 49 of 49 gating checks. `g7-0` to `g7-3` pass again as regression.

The gate 5.5 source is G7b's shape: `run-gate55.sh --legs g55b,g55c,g55d,g55e`, because g55f's
live legs are G7l's. `source-run-valid@gsw` therefore accepts a source whose only failing checks are
`not-run` groups.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-0,g7-1,g7-2,g7-3,g7-55 --receiver gsw \
  --skip-harness-selftest --make-sources --out <dir>   # or --source gate55=<run>,...
```

**What was built**

- **`packages/effects`: `transpileGodotItemShader`** turns the code a RenderingServer receives
  into an item-space module. That code has whitespace runs collapsed and includes between
  `@@>`/`@@<` markers. The module holds the uniforms, the samplers, the helpers and
  `godot_item_fragment(inout vec4 COLOR, in vec2 UV)`. It does not seed `COLOR`, apply a modulate
  or own `main()`, because the renderer keeps Godot's `canvas.glsl` order around it.
  - Supported: `COLOR`, `UV`, `TEXTURE`, PI/TAU/E, `render_mode` blend/unshaded/light_only, helper
    functions and constants, and `instance uniform`.
  - Uniforms: bool, int, float, vec/ivec 2 to 4, and arrays of them. Declared defaults are kept,
    else Godot's unset value applies (`source_color` vec4 (0,0,0,1), else zero).
  - `sampler2D`: `filter_nearest`/`filter_linear`, `repeat_enable`/`repeat_disable` and
    `hint_default_white`.
  - Integer literals stay integers where Godot keeps them (`phase % 6`, `5 - p`).
  - `light()` is dropped, because it runs only per light.
  - Refused, each with a message naming it: `vertex()`, varyings, `TIME`, the screen texture,
    the SDF built-ins, global uniforms, matrix uniforms, `TEXTURE_PIXEL_SIZE`, `FRAGCOORD` and the
    rest of the fragment built-ins, uvec/bvec, other hints and render modes, and non-literal
    defaults.
  - The fullscreen effect transpiler's output is unchanged. Its parser now records each
    declaration's qualifier, hints and default (`ParsedShader.declarations`). It now refuses
    `instance` and `global` uniforms instead of emitting junk.
- **`gsw-canvas-draw-list`**:
  - `Draw::program` names a `DrawList::bindings` slot. A binding is the program, its uniform values,
    its sampler textures and a `post_modulate` (the canvas modulate, applied after the code).
  - `Target::opaque` is Godot's non-transparent render target (rasterizer_canvas_gles3.cpp:742-798).
    Every blend keeps the destination alpha (`GL_ZERO, GL_ONE`), and `mul` and `disabled` take the
    straight source colour. The PDL1 format word carries it in bit 8.
- **`canvas-items`**:
  - `define_program` compiles a module inside the item-space fragment stage:
    `COLOR = vertex × modulate × straight texel`, then the code, then `post_modulate`, then
    premultiply unless `premul_alpha`.
  - Uniforms are set by GL type. They are re-sent only when the binding slot or its version changes.
  - Program samplers use units 3 and up.
  - A compile failure returns GL's log, and that program's draws are skipped.
  - Programs are recompiled after a restored context.
  - The opaque target's blend states.
- **`render-stream-core`**:
  - `apply/programs.rs`: Godot's Variant-to-uniform conversion (material_storage.cpp:49-349,
    717-794). Floats become f32, ints are truncated, bools become 0/1, and short arrays are
    zero-filled whole elements.
  - The applier draws a custom shader through a binding keyed by (material, canvas, item if it has
    instance uniforms, code hash). That covers `use_parent_material` and instance parameters.
  - Such an item's row carries no canvas modulate.
  - A refused shader draws as no material, as natively, and is reported once per (shader, hash):
    `shader_set_code` with `gsw-shader-transpile` (and the reason) or `shader-withheld`.
  - `apply/material_residency.rs` mirrors `rs_applier.gd`'s shader and material residency, so
    `applied.json` carries the native /5 counters (`shaders_created`, `shader_code_sets`,
    `materials_created`, `param_sets`, `instance_param_sets`).
  - Sabotages: `stale-param` (native: parameters frozen when a material becomes resident) and
    `blend-swap` (GSW-only: `add` ↔ `sub`).
- **`rs-gsw-wasm` and the page**:
  - After `provide`, the page asks for `pending_shaders()`. It transpiles each code once per hash
    (`web/gsw-receiver/programs.ts`, shared with the bench page). A `withheld` code comes from
    RS_RECEIVER_SHADER_LIBRARY, verified in wasm against its name.
  - `perf.json` times this as `program_us`, inside `total_us`, and counts programs.
  - `gsw/shader-params.jsonl` logs every binding's values whenever they change, for
    `shader-param-parity`.
- **Gate scripts**:
  - `lib/gate7-gsw-55.ts`: the legs, the receiver checks and the Q7 plan, merged into
    `lib/gate7-gsw.ts` with one line per table.
  - `lib/gate7-gsw-55-checks.ts`: G7s's checks.
  - `gsw-tolerance.ts`: `gate55-cim` and `gate55-cim-modulate` masks, from the fixture's op lists.
    The masks are every op whose blend multiplies in the blend unit: a translucent mix, add, sub or
    premul_alpha, and mul at any alpha. `gate55-shader` is all decided.
  - `check-gate7.ts` judges gsw legs with check-gate55.ts's g55d and g55e checks.

**Results** (`artifacts/render-stream/gate7/g7s/run3/result.json`, on G7b's main). Desktop D9
harness, pinned chromium-1223, sources made on this build (`run3/sources-made/`). Totals: 74 gsw
legs and 171 of 171 gating checks.

| Group | gsw legs | Gating checks | Shots identical to native | Notable |
| ----- | -------- | ------------- | ------------------------- | ------- |
| `g7-0` | 8 | 24/24 | 25/25 | unchanged from G7a |
| `g7-1` | 13 | 29/29 | 164/164 | unchanged |
| `g7-2` | 17 | 38/38 | 56/132; the rest delta 1 | unchanged (Q7: 10 240 px `delta1`, 4 468 px `undecided`) |
| `g7-3` | 14 | 31/31 | 117/120 | unchanged (the 3 are gate 3c's ignore-clip sabotage, in the band) |
| `g7-55` | 22 | 49/49 | 110/210; the rest delta 1 | every ShaderMaterial leg, sabotages included, identical to native; CIM legs differ only at delta 1, inside `delta1` masks (Q7: decided exact, 152 064 px masked) |

`g7-55` in detail:

- **Every g55d and g55e receiver check `@gsw` passes** (37). These are leg classes for the honest,
  patch, inline, refused, params-lib and params-nolib legs; pixels against the reference and the
  raster; state dumps; `resource-quiet`; `receiver-typed`; and every native sabotage at its native
  predicted set (`freeze`, `omit-material-set-shader`, `omit-param`, `perturb-shader`,
  `ignore-material` on both fixtures, `ignore-canvas-modulate`, `stale-param`).
- **`shader-transpile-set`**: the predicted set is `sh_a`, `sh_b`, `phase`, `tint`, `tint_b`,
  `pal`, `types` and `inst`. All 8 transpile and compile, one program per code hash, on all four
  honest ShaderMaterial legs. The params-lib leg's 8 come from the operator library. None is
  typed. `phase_tint` (gate 6) is shown below and in the package suite.
- **`shader-param-parity`**: 20 880 uniform values over every applied transaction equal the wire's
  resolved values after Godot's conversion. 3 120 declared uniforms are unset on the wire and stay
  at their defaults.
- **`sabotage-blend-swap`** mismatches the cim reference in exactly the predicted (step, region)s:
  `{BA, BS, RC, UP}`, and `{BA, BS, UP}` at step 4 when `RI` has no material. The prediction
  comes from `expected.json`'s `effective` table.
- **`compositor-equals-readback`** holds exactly on both cim scenes. The shader scene's `PH` changes
  every frame, so its last settle shot is never the exit frame. That comparison is reported, not
  gated, as in G7a.

**The gate 6 scene's `SM`** (`phase_tint`) is report-only. The bench page replayed G7d's
`scene-patch` input (sha256 `0a7daa1c…`) through the Rust arm against the native receiver's shots
(`run-g7x-scene-native.sh`). `SM` differs in **0 px at all 12 settle seqs**, and no shortcut fired
(`artifacts/render-stream/gate7/g7s/sm-scene/scene-vs-native.json`). Under G7a it was drawn with
the builtin program. The other regions are as G7a left them: `LE` is the max-7 pixel-centre tie (G7t's), and the rest are
delta 1.

**Supported and refused.** The supported subset is listed under "What was built". Custom shaders
outside it draw without their material and are typed `gsw-shader-transpile` with the transpiler's
message or GL's log. Gate 5.5's own refused shaders (`TIME`, screen texture, SDF, global uniform,
`spatial`) are already refused on the wire and draw as the native receiver draws them.
`gsw-shader-builtin` can now fire only for a custom shader the adapter never registered, and none
did.

**Findings** (each was a failing check first):

- **Godot's root target is not G7c's transparent canvas.** On a non-transparent target, Godot keeps
  the destination alpha for every blend, and `mul` multiplies by the straight source. The first
  gsw run had `BU` at 85 levels and `BD`'s alpha at 170 instead of 255. G7c's TypeScript executor,
  the spec of record for the byte-identity suite, models the transparent premultiplied canvas.
  `Target::opaque` keeps both, and that suite still passes 24/24.
- **ANGLE/Vulkan's source conversion** (memory g7c-gpu-blend-conversion-facts) puts mul at any
  alpha, and every translucent blend, one level from the native reference. The masks say so in
  advance, from the fixture's op lists. Opaque mix, add and sub, and disabled, stay exact.
- **gate55-cim's `items[].xform` already includes the step's canvas transform.** A first mask
  derivation added it twice, at step 9.

**Re-verified.**

- `packages/effects`: 164 tests, including the new item-shader suite.
- `canvasItemsRustPixel` 24/24 byte-identical. The new `canvasItemsProgramPixel` 8/8 is exact
  against a hand model: tint through an `@@` include, int `%` and subtraction, `lv[k]`, `iv`, a
  `filter_nearest` sampler, instance uniforms, `COLOR`/`TEXTURE` input, the post-code canvas
  modulate, `phase_tint`, `burn`, a compile failure, and the opaque target's mul and disabled.
- `rs-core` cargo tests pass (27). `rust-prototype` tests pass with and without `canvas-items`.
  Clippy is clean on every changed crate.
- `pnpm test`: 169 files, 2 510 tests (after the rebase onto G7b).
- The default `rust-prototype` build is byte-identical to main (wasm `d810e2a3…`, JS
  `fed168e4…`).
- **Consumer check.** `../sts2-couch-coop` was pointed at this worktree, with its checkout left on
  clean `main`. `build-rust-prototype.sh` output is byte-identical. Its eight Rust renderer specs
  pass (217 tests), its full vitest passes (5 702), and `vue-tsc` is clean against the worktree.
  `@godot-scene-web/effects` gained exports.
- An earlier full run on the pre-G7b base (`run1`) gave the same verdicts. Its gate 2 source
  failed only `pins-bounded` and `obsolete-retired` on the native `live-animate` leg ("servable,
  named by nothing" at frame 971), the known live pin-replay flake under load. `run3`'s gate 2
  source passed 85/85.

**What G7s does not prove:**

- Live shader legs in the browser (G7l, gate 5.5f).
- Shaders using `TIME`, `vertex()`, varyings, the screen texture, matrix uniforms or
  `TEXTURE_PIXEL_SIZE`. These are typed, not drawn.
- Phone timing with programs. G7s names no g31 run.

**What G7g inherits:** the gate 6 scene's `SM` is already exact natively and in the bench. The
`hd` input's animated material parameter now drives a binding every frame (one uniform re-send per
changed slot). Its cost on the g31 has not been measured.


