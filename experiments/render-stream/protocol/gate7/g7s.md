### G7s — GSW materials and shaders: gate 5.5 (opus)

- **Files**: `packages/canvas` (the item-space program path: a transpiled fragment body inside the
  instanced quad and mesh programs, uniforms per material, instance uniforms per draw);
  `packages/effects` (accepting preprocessed server code with `@@` markers, filter hints on sampler
  uniforms, `instance uniform`); the applier's material path (CIM builtin to blends and light
  modes, `use_parent_material`, canvas modulate, `params` policy through the library); the
  `g7-55` gsw file legs.
- **Predicted transpile set** (gate 5.5c and 6 shaders, checked by running): `sh_a`, `sh_b`,
  `phase`, `phase_tint`, `tint`, `tint_b`, `pal`, `types` and `inst` all transpile and are exact;
  the refused shaders are already wire-typed. Any shader that fails is `gsw-shader-transpile`, and
  its regions are excluded.
- **Checks**: gate 5.5 receiver checks `@gsw`; `shader-param-parity` (GSW's uniform values per
  frame equal the wire's resolved values); package tests and the downstream consumer check.
- **Sabotages**: native `ignore-material`, `stale-param`, `ignore-canvas-modulate` with native sets;
  a GSW `blend-swap` (`sub`↔`add`) must fail exactly gate 5.5b's sub/add regions.
- *Amended 2026-10-15 (D29):* the item-space program path goes into `canvas-items` (GLSL ES 3.00),
  not `executor-webgl.ts`. `packages/effects`' transpiler stays TypeScript, and its GLSL crosses
  into wasm once per shader resource (Q14c). Uniforms and instance uniforms are set from the core's
  resolved parameters, and `shader-param-parity` reads them through `evidence_json()`.
- **As built (G7s, 2026-10-15)**, details in the README's "Gate 7s result". `g7-55` passes for
  `gsw`: 22 legs, 49 of 49 gating checks, every g55d/g55e receiver check through check-gate55.ts's
  own code. `g7-0` to `g7-3` pass again. Every ShaderMaterial leg, sabotages included, is
  pixel-identical to the native receiver. The CanvasItemMaterial legs differ only at delta 1,
  inside the `delta1` masks.
  - **The predicted transpile set held.** These are `sh_a`, `sh_b`, `phase`, `tint`, `tint_b`,
    `pal`, `types` and `inst`, plus `phase_tint` (the gate 6 scene's `SM`: 0 px against native at
    every settle seq, report-only). `burn` passes in the package pixel suite. None is typed.
  - **Where it lives.** The transpiler entry is `transpileGodotItemShader` in
    `packages/effects/src/shaders/item-shader.ts`. It emits a module (uniforms, samplers, helpers,
    `godot_item_fragment(inout COLOR, UV)`), not a program: the executor keeps `canvas.glsl`'s
    order around it (`COLOR` = vertex × modulate × straight texel, then the code, then the canvas
    modulate). `gsw-canvas-draw-list` carries the program and its values as `DrawList::bindings`,
    named by `Draw::program`, and not as PDL1 arrays. A binding is keyed by (material, canvas,
    item when the code has instance uniforms, code hash).
  - **`Target::opaque` amends D7's model.** Godot's root target is non-transparent. Every blend
    keeps the destination alpha, and `mul`/`disabled` use the straight source
    (rasterizer_canvas_gles3.cpp:742-798). G7c's TypeScript executor, the byte-identity spec,
    models the transparent canvas. Both modes exist, and the applier sets `opaque`.
  - **`shader-param-parity`** reads `gsw/shader-params.jsonl`, the core's per-binding values
    whenever they change, rather than `evidence_json()`. That avoids a per-frame JSON blob.
  - **The masks for `delta1`** on gate55-cim are every op whose blend multiplies in the blend unit:
    translucent mix/add/sub/premul_alpha, and mul at any alpha. They are derived from the fixture's
    op lists (`gsw-tolerance.ts` `gate55cim`). `gate55-shader` is all decided.
  - **The `applied.json` /5 counters** (`shaders_created`, `shader_code_sets`,
    `materials_created`, `param_sets`, `instance_param_sets`) follow `rs_applier.gd`'s residency
    (`rs-core` `material_residency.rs`). They are accounting only, because g55d's
    `resource-quiet` and g55e's `receiver-typed` judge them.
  - **The gate 5.5 source has G7b's shape** (`run-gate55.sh --legs g55b,g55c,g55d,g55e`; g55f
    is G7l's). `source-run-valid@gsw` accepts a source whose only failing checks are `not-run`
    groups.
  - **Not supported, typed `gsw-shader-transpile`:** `TIME`, `vertex()`, varyings, the screen
    texture and SDF built-ins, global and matrix uniforms, `TEXTURE_PIXEL_SIZE` and the other
    fragment built-ins, uvec/bvec, and non-literal defaults.

