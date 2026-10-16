### G7a — GSW receiver on the Rust core: gates 0 to 3 file legs (opus, gsw-renderer agent)

*Revised 2026-10-15 (D29, D32).* G7a starts only after G7x's win. It turns the slice into the
receiver.

- **Files**:
  - `experiments/render-stream/web/gsw-receiver/` (`main.ts`, `config.ts`, `source.ts`,
    `evidence.ts`, `perf.ts`), a TypeScript shell over `rs-gsw-wasm` (Q14c).
  - `render-stream-core`: versions 2 to 7 (golden-2 to golden-6, and golden-7 once G7w lands;
    Q14d); D7's applier in full for gates 0 to 3 (per-z lists, `draw_behind_parent`,
    `z_as_relative`, `top_level`, `visible`, `clip_ignore`, `set_transform`, canvases by
    `(layer, sublayer)`); the textures; Q5's sabotages in the applier, selected by
    `RS_RECEIVER_SABOTAGE` through the config.
  - `canvas-items` executor features gates 0 to 3 need beyond the slice.
  - `scripts/lib/gsw-tolerance.ts` and `fixtures/gsw-tolerance.json` (gates 0 to 3 first).
  - The gate 0 to 3 adapters and the `g7-0..g7-3` gsw legs (file only).
  - `self-test-rs-core.ts` extended to every gate 0 to 3 source recording.
- **Checks**:
  - each gate's receiver checks `@gsw` under Q7;
  - `ordering-model`, a `cargo test` of the applier's walk against gate 1's z, behind-parent,
    `top_level` and visibility steps, from the resolved states (no GPU);
  - `clip-parity`: the Rust scissors equal `clip-derive.ts`'s for every gate 3 item and step
    (Q14d);
  - `transform-only-no-upload`: on gate 2's transform-only steps, zero texture uploads and zero
    vertex bytes, with only item rows uploaded;
  - golden-2 to golden-6 through the core, natively and as wasm.
- **Sabotages**: the native receiver sabotages with their native predicted sets; `ignore-z` must
  fail exactly gate 1's z steps; `premultiplied-upload` must fail exactly gate 2's
  translucent-filtered regions with channel delta > 1 (pixelmatch alone must be shown not to catch
  it, as the memory says).
- **Commit**: `feat(canvas): …` with a real `Changelog:` line if `canvas-items` changed, otherwise
  `test(render-stream): …`.
- **Fallback (G7x lost and the user keeps TypeScript, D32)**: the original spec. That is
  `rs-canvas-applier.ts` and `textures.ts` in TypeScript over `executor-webgl.ts` and G7j's
  decoder, with the same checks (`ordering-model` as a TypeScript unit test) and the same sabotages.
- **As built (G7a, 2026-10-15)**, details in the README's "Gate 7a result". `g7-0` to `g7-3` pass
  for `gsw`: 52 legs, 122 of 122 gating checks, every gate's receiver checks through its own
  checker. Gates 0, 1 and 3 are pixel-identical to the native receiver (25/25, 164/164 and 117
  of 120 shots). The 3 are gate 3c's ignore-clip sabotage, whose unclipped rotated edges fall in
  the band. On gate 2, 56 of 132 shots are identical, and the rest differ only at delta 1, inside
  `gsw-tolerance.json`'s masks.
  - **"Under Q7" is a view, not a fork.** The gates' checkers compare a receiver with the
    reference exactly. `lib/gate7-q7.ts` gives a gate's checker a Q7 view of each gsw leg. In it,
    a pixel within its mask's allowance (delta ≤ 1 in `delta1`, anything in `undecided`) takes the
    reference's value. Every other pixel stays as drawn, so the exact comparison judges exactly
    Q7's decided pixels. Only gate 2 and gate 3c have masks.
  - **Texture residency is the native receiver's.** A texture becomes resident when something
    first names it and leaves only when its entry does (`rs_applier.gd`, D5). Gate 2's
    `upload-accounting` needs this.
  - **Godot's viewport attach test.** An item draws only when its custom rect, else its content
    rect, touches the viewport (`_attach_canvas_item_for_draw`, borders included). G7x's "not
    culled is pixel-exact" was wrong for an off-screen custom rect (gate 3's `cull` region).
  - **`clip_uv`.** It is lowered exactly as a 3×3 split of the quad where the UV meets the
    half-texel inset (canvas.glsl:593-596). `slice-clip-uv-ignored` is gone.
  - **Mipmapped textures sample level 0.** This is `slice-mipmaps-level0`, counted but not typed.
    Q7 classes filtered scaled images `undecided`, and gate 2's `MM` measures delta 1.
  - **Receiver-typed refusals** are the remaining shortcuts that fire, each once, with seq and
    `item: null`: `gsw-shader-builtin`, `gsw-msdf`, `gsw-hairline`, `gsw-aa-feather`,
    `gsw-nine-patch-tile` and `gsw-mesh-primitive`. None fires in gates 0 to 3.
  - **Not applicable to a browser:** `receiver-headless-trace` (replaced by `no-source-scene`),
    `receiver-typecheck`, `receiver-typed-clean`, and the cache-directory checks (`warm-cache`,
    `fresh-cache`, the `ignore-cache` sabotage). The browser's HTTP cache stands in, as for the
    web export (Q4).
  - **Sabotages.** The native receiver's sabotages for gates 0 to 3 run in the applier.
    - `ignore-z` fails exactly step 4: the only gate 1 step where z decides a pixel, painted from
      gate 1's own resolved states.
    - `premultiplied-upload` fails exactly `{4:bg, 4:sb}` with delta > 1, and pixelmatch alone
      passes all 12 of its shots.
  - **`transform-only-no-upload`.** Gate 2's transform-only steps change the marker's colour
    every step. So the check requires zero texture bytes, re-lowering of exactly the items whose
    `content_version` changed, and zero vertex bytes when none did.
  - **Incremental structural apply.** Material and shader parameter changes no longer re-walk;
    content-shape changes re-assemble without a walk. hd-patch's walks fall from 111 to 14 of
    122. Its g31 total p95 still misses the stretch target: the remaining cost is payload
    verification, re-lowering text, and decode in the every-10th step transactions.
  - **/7** decodes in the core (golden-7 17/17, natively and as wasm). Live mode (the /7 client)
    is G7l's; the page refuses `RS_RECEIVER_MODE=live` as a usage error.
  - **G7x's `BG` difference** was its report's step-0 region boxes: the root canvas moves by
    (8, 4) at steps 10 and 11. **`LE`** is a StyleBoxFlat edge exactly on pixel centres, so float
    rounding decides which triangle owns the row. Godot composes canvas_inverse·final, then model,
    canvas and screen transforms; GSW composes one row. That is undecided in the hand model, and
    vertex-chain parity is G7t's.

