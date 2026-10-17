## Gate 7tm result (2026-10-17)

G7tm ([protocol/gate7/g7tm.md](../../protocol/gate7/g7tm.md), gate7-design.md Q5, Q7, Q14b) draws
MSDF text in the GSW canvas receiver. Before G7tm, gate 4e's three MSDF legs classed
`unsupported` with `gsw-msdf` and drew nothing. Now `add_msdf_texture_rect_region` goes through
Godot 4.5.1's GLES3 MSDF branch, ported into `canvas-items`. **`g7-4` passes for `gsw` with every
gate 4e check judged by gate 4e's own code, and `g7-0` to `g7-5` and `g7-55` still pass:** 282 of
282 gating checks over the seven groups, on sources made on this build.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-0,g7-1,g7-2,g7-3,g7-4,g7-5,g7-55 \
  --receiver gsw --skip-harness-selftest --make-sources --out <dir>
```

**What Godot does, and what was mirrored** (all 4.5.1; the web export and the native reference
both draw through GLES3):

- `modules/text_server_adv/text_server_adv.cpp:4025,4167`: each MSDF glyph is
  `canvas_item_add_msdf_texture_rect_region(rect, page, uv_rect, modulate, outline_size,
  msdf_range, size / msdf_source_size)`. The fill pass sends outline 0.
- `servers/rendering/renderer_canvas_cull.cpp:1544-1576`: a region rect with `CANVAS_RECT_MSDF`.
  It takes the region's flips, then `outline = (float)p_outline_size / p_scale / 4.0` and
  `px_range` as sent. The lowering computes the same f32 quotient. The second division is in
  double and exact, so the result is the f32 quotient.
- `drivers/gles3/rasterizer_canvas_gles3.cpp:999-1004`: `INSTANCE_FLAGS_USE_MSDF` and
  `msdf[0..1] = {px_range, outline}`. In `rasterizer_canvas_gles3.h:214-215`, `msdf` and
  `ninepatch_margins` share a union, so the shader reads them back as
  `read_draw_data_ninepatch_margins.xy`.
- `drivers/gles3/shaders/canvas.glsl:562-564` (`msdf_median`) and `601-618`, ported statement for
  statement into `canvas_items::MSDF_COVERAGE`:
  - `px_size = max(0.5·dot(px_range / textureSize, 1 / fwidth(uv)), 1)`.
  - With an outline: `cr = clamp(outline, 0, px_range/2 − 1) / px_range`, `d = min(median, a)`,
    and the coverage is `clamp((d − 0.5 + cr)·px_size)`.
  - Without one, the coverage is `clamp((median − 0.5)·px_size + 0.5)`.
  - The coverage multiplies `color.a` of `color_interp`, which is the vertex colour times the
    modulation (lines 181/229 and 266). The texel's colour is not multiplied in. The canvas modulate
    follows at line 716, and the blend is the builtin's.

**What was built**

- **`gsw-canvas-draw-list`** (generic, no render-stream concept):
  - `DRAW_MSDF`, a `Draw::flags` bit, and `Draw::msdf: [px_range, outline]`. `Draw` grows from 44
    to 52 bytes and loses `Eq`, because it now holds floats.
  - `mergeable` compares the parameters of MSDF draws.
  - `PDL1` version 2 carries 52-byte draws. `encode` writes version 1 whenever no draw is MSDF, so
    every earlier dump is byte-identical, and `decode` reads both versions. The TypeScript case
    encoder (`canvas-items-cases.ts`) does the same.
- **`canvas-items`**:
  - The builtin program has an MSDF variant (`VERT` + `msdf_fragment()`). Its vertex stage passes
    the modulate straight. Its fragment stage computes Godot's straight `color.a = coverage ·
    color.a` and premultiplies last for every blend but `premul_alpha`.
  - Item-space programs run the same branch before their fragment code, as canvas.glsl does, using
    the `gsw_msdf_on`, `gsw_msdf` and `gsw_msdf_no_median` uniforms. Uniforms are re-sent only when
    they change.
  - The new sabotage is `msdf-no-median`.
- **`render-stream-core`**: `add_msdf_texture_rect_region` lowers as a region whose draw carries
  `msdf`. `Shortcut::MsdfSkipped` and the `slice-msdf-skipped` → `gsw-msdf` typed reason are
  removed. The native `drop-msdf` sabotage still skips the command. The new GSW-only sabotage is
  `msdf-px-range`, which halves `px_range`.
- **Gate scripts**:
  - The five gate 4e checks that G7t typed or set aside are judged `@gsw` again:
    `leg-class-receiver-msdf{,-patch}`, `leg-class-sabotage-msdf-perturb-glyph`,
    `ink-presence-receiver-msdf` and `sabotage-msdf-perturb-glyph-regions`.
  - Gate 4e's glyph boxes are `delta1` in `fixtures/gsw-tolerance.json`, like gate 4's others.
  - New legs `msdf/sabotage-gsw-msdf-{no-median,px-range}` and the checks
    `sabotage-msdf-{no-median,px-range}@gsw`.
  - `glyph-boxes-exact` reports the MSDF leg too.

**Results** (`artifacts/render-stream/gate7/g7tm/final/result.json`, on main `452a09e7` plus this
change; desktop D9 harness, pinned Chromium; sources in `final/sources-made/`):

| Group | Gating checks | Notable |
| ----- | ------------- | ------- |
| `g7-0` | 24/24 | 25/25 shots identical to native |
| `g7-1` | 29/29 | 164/164 identical |
| `g7-2` | 38/38 | Q7: 10 240 px `delta1`, 4 468 px `undecided` (G7t's numbers) |
| `g7-3` | 31/31 | 120/120 identical |
| `g7-4` | **69/69** (G7t: 65) | Q7: decided exact, 151 526 px `delta1`, 0 undecided, nothing excluded; `atlas-upload-parity` 82 rows on 10 legs |
| `g7-5` | 42/42 | `lowering-parity` 615/615; `polygon-winding` exactly `{PG}` |
| `g7-55` | 49/49 | G7s's verdicts |

Gate 4e's MSDF legs, each GSW shot against the rendered reference
(`artifacts/render-stream/gate7/g7tm/msdf-legs.txt`):

| Leg | Settle shots | Pixels differing | Max delta | Outside the glyph boxes | Glyph boxes exact |
| --- | ------------ | ---------------- | --------- | ----------------------- | ----------------- |
| `msdf/receiver` | 10 | 13 525 | 1 | 0 | 0/50 |
| `msdf/receiver-patch` | 10 | 13 525 | 1 | 0 | 0/50 |
| `msdf/sabotage-perturb-glyph/receiver` (against its native leg) | 10 | 14 459 | 1 | 0 | 0/50 |
| `msdf/receiver`, early shots 12 and 72 | 2 | 1 077, 1 419 | 1 | 0 | — |

- **Every decided pixel is exact and every MSDF glyph box is within `delta1`.** Nothing falls
  outside the band. Gate 4e's `receiver-vs-reference-msdf` (budget 0 on the Q7 view) and
  `expected-image-receiver-msdf` (exact outside the text regions) pass. The `outline` pass (M40
  from step 3), the 24 → 56 px size change, the colour changes and `MR`'s rotated, scaled Label
  are all inside the band.
- **Where the delta-1 pixels lie.** 13 503 of the 13 525 lie where the reference is strictly
  between the background and the text colour, which is partial coverage. The other 22 lie where
  the reference shows the bare background, at coverage close to 0. This is Q7's translucent-blend
  cause, the same as gate 4's grayscale glyph boxes (P-G2: 35 of the other 316 boxes exact). Godot
  takes the straight alpha in the blend unit, while GSW premultiplies in the shader. The run does
  not separate that from any rounding difference in the `fwidth` arithmetic through ANGLE (Q7's
  "at risk" list), because both stay within one level.
- **Sabotages**, each against the honest gsw leg at every settle step:
  - `msdf-no-median` (the minimum of the three distances): differs in exactly that step's text
    regions and nowhere else, 11 417 px over 10 steps.
  - `msdf-px-range` (half the range): exactly the text regions, 59 693 px.
  - The native `drop-msdf` and `perturb-glyph` sabotages fail exactly their native predicted
    regions, as natively.
  - A first try of `msdf-no-median` took the maximum. That spilled ink outside the glyph boxes
    (870 to 2 120 px per step) into the distance field's padding, so "exactly the text regions"
    could not hold for it. The minimum never exceeds the median, so it can only remove ink the
    honest leg drew, and that ink lies inside the text regions.
- **The package pixel suite** (`canvasItemsProgramPixel`, both orientations, 20/20) adds
  `msdfCoverage` against a hand model on uniform MSDF texels. It covers a plain glyph (vertex
  colour only, texel colour not multiplied in), an outline, `px_size` held at 1, the branch through
  an item-space program, and twice the screen size (`1/fwidth`). Every rect is exact except one,
  which is within 1 (a blend product). `msdfNoMedianSabotage` runs the sabotage against its own
  arithmetic, so the honest values fail it.

**Re-verified**

- Cargo tests: `gsw-canvas-draw-list` 5 (the PDL1 versions and MSDF merging), `render-stream-core`
  35 (the MSDF lowering test replaces G7t's typed one), `rust-prototype` with `canvas-items`
  57 + 34 + 6. `rs-core-capi` builds. `rs-gsw-wasm` is wasm-only: its native `cargo test` fails to
  resolve the wasm32-only executor, as on main, and `build-rs-core.sh` builds it. Clippy is clean on
  the draw list and the core. On `canvas-items` for wasm32, every finding is in an untouched file
  (`contract.rs`, `geometry.rs`, `idle.rs`).
- `rs-core-check goldens`: native, all checks pass. As wasm in Node: 587/587 (golden-2 to 7).
  `self-test-rs-core.ts`: the final run's every source recording, plus the four bench inputs
  (scene-full, scene-patch, hd-patch, pace-patch; 0 mismatches). `self-test-record-digest.ts` on the
  four bench inputs passes.
- Every pure self-test (`scripts/test/self-test-*.ts`, `self-test-quiet.sh`) passes.
  `gsw-tolerance.ts --check` is byte-identical.
- `pnpm test`: 172 files, 2 518 tests. Package typecheck: only the known
  `upload-bench-entry.ts` error. The render-stream scripts' `tsc` is clean, and biome is clean on
  the touched files.
- `canvasItemsRustPixel`: 24/24 byte-identical (no MSDF case, PDL1 version 1).
  `canvasItemsProgramPixel`: 20/20.
- The rust-prototype README's pixel and integration suites pass on both backends (wgpu and
  `GSW_RUST_BACKEND=gl`, headless).
- **`build-web.sh`'s default exports are unchanged**: wasm `d810e2a3…`, JS `fed168e4…`, the same
  bytes as main built in this worktree (the canvas crates reverted for that build). They are also
  G7t's numbers.
- **Consumer check.** A scratch copy of `../sts2-couch-coop` main (`554c5658`), pointed at this
  worktree (`COUCHCOOP_GSW_ROOT`), ran `scripts/build-rust-prototype.sh`. The output was
  byte-identical (the same two hashes). Its Rust renderer specs pass: 8 files, 218 tests. The couch
  checkout was not touched. No TypeScript export consumers read changed.

**What G7tm does not prove:** MSDF on gate 6's Kreon or under `canvas_items` stretch (G7g), MSDF
on the web export (G7b's legs are unchanged), several MSDF pages, `msdf_size` 128, mipmapped MSDF
pages (the lowering still samples level 0), and an MSDF Label with a ShaderMaterial on the wire
(the program branch is covered by the package suite only).
