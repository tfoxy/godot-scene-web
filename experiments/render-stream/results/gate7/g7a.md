## Gate 7a result (2026-10-15)

G7a ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7a", Q5, Q7, Q8, Q14) builds the GSW
canvas receiver on the shared Rust core. G7x's slice is now a receiver: a TypeScript page shell over
`rs-gsw-wasm`, judged by gates 0 to 3's own checkers. **`g7-0` to `g7-3` pass for `gsw`:** 52
legs and 122 of 122 gating checks.

```bash
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-0,g7-1,g7-2,g7-3 --receiver gsw \
  --skip-harness-selftest --make-sources --out <dir>   # or --source gate0=<run>,...,gate3=<run>
```

**What was built**

- **The page** (`web/gsw-receiver/`): `config.ts`, `source.ts`, `evidence.ts`, `perf.ts` and
  `main.ts`.
  - It reads the native receiver's `RS_RECEIVER_*` values, mapped from a native leg's `env.txt` by
    `gate7-web-legs.ts` exactly as for the web export.
  - It replays the recording one record per rAF and fetches missing payloads from the store, one
    at a time, into wasm, where `provide` verifies them.
  - It writes the native file-mode evidence by PUT: `applied.json` as
    `render-stream-receiver-applied/7` with `receiver.kind` `gsw-canvas`, `shots/seq-<n>.png` read
    back from the RGB10_A2 target, `state/seq-<n>.json`, `stdout.log` and the exit code.
  - `perf.json` and `perf-timeline.jsonl` carry Q14c's timers per drawn frame. A usage error exits
    2, a replay failure 3. Live mode (/7 client and credit) is G7l's and refused as a usage error.
- **`render-stream-core`**, beyond the slice:
  - /7 (golden-7 17/17).
  - Native texture residency and upload accounting (`apply/residency.rs`).
  - Placeholders as the engine's 4×4 checker, and freed textures drawn white.
  - Godot's viewport attach test, and `clip_uv`.
  - The applier sabotages: `ignore-clip`, `clip-before-clear`, `reupload`, `stale-texture`,
    `ignore-material`, `ignore-canvas-modulate`, `ignore-canvas-stacking`, `ignore-presentation`
    and `ignore-z`.
  - State dumps byte-identical to `receiver.gd`'s, with Godot's float spelling
    (`canon::write_state_godot`).
  - The `ordering_model` cargo test, and the `scissors`, `state-dump` and `apply-bench` CLI
    commands.
- **`canvas-items`** gains the `premultiplied-upload` sabotage and nothing else. The default
  `rust-prototype` build is byte-identical (wasm `d810e2a3…`, JS `fed168e4…`).
- **Gate scripts:**
  - `lib/gate7-gsw.ts`: the gsw legs, the views and Q8's checks.
  - `lib/gate7-q7.ts`: Q7 views.
  - `lib/gate7-gsw-checks.ts`: G7a's checks.
  - `lib/gsw-tolerance.ts` and `fixtures/gsw-tolerance.json`: masks from each gate's
    `expected.json`, with `--check`.
  - `lib/gsw-bundle.ts`: esbuild with `conditions: ["development"]` plus the wasm, and a
    `build.json` that lists the metafile inputs.
  - `run-gate7.sh` and `check-gate7.ts` land `g7-1` to `g7-3`.
- **The `gsw` bench alias is retired.** The TypeScript arm is `gsw-ts`, including its leg names.

**How a gate judges a gsw leg.** Each gate's checker runs, unforked, on a view of its native source
run (D21) in which every replaced receiver leg points at its gsw leg. Its receiver checks are kept
with an `@gsw` suffix. "Under Q7" works the same way: for a gate with masks (gate 2, and gate 3c's
band), a leg's shots are given to the checker as a Q7 view. In that view, a pixel within its
mask's allowance (≤ 1 in `delta1`, anything in `undecided`) takes the reference's value. Every
other pixel stays as drawn, so the gate's exact comparison judges exactly Q7's decided pixels.
`q7-pixel-policy@gsw` reports the raw counts.

**Results** (`artifacts/render-stream/gate7/g7a/run3/result.json`, desktop D9 harness, pinned
chromium-1223, sources made on this build in `run1/sources-made/`):

| Group | gsw legs | Gating checks | Shots identical to native | Notable |
| ----- | -------- | ------------- | ------------------------- | ------- |
| `g7-0` | 8 | 24/24 | 25/25 | goldens 2-7 native and wasm (587/587); differential over 67 source recordings, 0 mismatches; `compositor-equals-readback` exact; `css-opacity` fails exactly it |
| `g7-1` | 13 | 29/29 | 164/164 | `ordering-model` 13 steps, 0 mismatching; state dumps byte-equal to native (`live-replay-equals-live`); `ignore-z` fails exactly step {4} |
| `g7-2` | 17 | 38/38 | 56/132; the rest delta 1 | Q7: decided exact, 10 240 px in `delta1` and 4 468 px in `undecided` masks; `upload-accounting`; `transform-only-no-upload`; `premultiplied-upload` fails exactly {4:bg, 4:sb}, pixelmatch alone passes all 12 of its shots |
| `g7-3` | 14 | 31/31 | 117/120 | `clip-parity` 15 736 (transaction, item) scissors equal; `cull` region exact after the attach test; the 3 differing shots are gate 3c's ignore-clip sabotage (unclipped rotated edges, 168 px each, in the band) |

Not applicable to a browser, and reported: `receiver-headless-trace` and
`receiver-never-loaded-fixture` (`no-source-scene@gsw` instead), `receiver-typecheck` and
`receiver-typed-clean`, and gate 2's cache-directory checks (`warm-cache`, `fresh-cache`, the
`ignore-cache` sabotage).

**Supported and refused.** Gates 0 to 3 need nothing refused.

- **Typed refusals** come when their shortcut first fires: `gsw-shader-builtin`, `gsw-msdf`,
  `gsw-hairline`, `gsw-aa-feather`, `gsw-nine-patch-tile` and `gsw-mesh-primitive`. These are
  G7s's and G7t's.
- **Not typed:** mipmapped textures sample level 0. Gate 2's `MM` measures delta 1, inside Q7's
  `undecided` class for filtered scaled images.

**Fixes found on the way** (each was a gate failure first):

- **Lazy texture residency.** `upload-accounting` needs the native rule: create on first name, and
  never upload what nothing names.
- **Godot's attach test** (renderer_canvas_cull.cpp:247). An off-screen custom rect hides
  on-screen content: gate 3's `cull`, 1 024 px at steps 0 and 1.
- **`clip_uv`.** Its UV clamp is now lowered as a 3×3 split (canvas.glsl:593-596). It was gate
  2's `dr` and `s2`, up to 96 levels off.
- **Item rects.** A command whose texture is skipped still counts toward the item rect.

**G7x's open differences:**

- **`BG` was never a rendering difference.** G7x's report used gate 6's step-0 region boxes, but
  the root canvas moves by (8, 4) at steps 10 and 11. With the boxes moved, which
  `gate7x-checks.ts` now does, BG differs in 0 px, and those 2 140 px belong to `SM` and `LE`.
- **`LE` (max 7) is a fill-rule tie.** The LineEdit's StyleBoxFlat has horizontal edges at local
  y = 29.5, exactly on pixel centres. Float rounding in the vertex chain decides which triangle
  owns the row. Godot does canvas_inverse·final on the CPU, then model, canvas and screen
  transforms (canvas.glsl:252-280, rasterizer_canvas_gles3.cpp:331-335); GSW uses one composed
  row and x·(2/w)−1. The hand model leaves such pixels undecided, and vertex-chain parity is G7t's.
- **`SM`** is still `slice-shader-builtin` (G7s).

**The incremental structural apply.** On hd-patch, 111 of 122 transactions took the walk, nearly all
because a material parameter animates every frame.

- The walk now keys materials on (status, shader) and shaders on (status, builtin), and a
  same-item change of content shape re-assembles without re-walking. Walks fall to 14.
- Natively, apply p50 drops from 233 to 44 µs.
- On the g31, apply p50 drops from 3.245 to 1.455 ms (p95 5.740 to 5.255). Total p95 still misses
  the stretch target, though. The remaining cost is in the every-10th step transactions: payload
  `provide` (now later, because residency is lazy), re-lowering their text, and decode.

**R2 to R4 on the moto g31**, re-run on the final build (`g31-r3`). Chrome 154, G7x's protocol
(five interleaved rounds, a fresh page per arm), T_p 17.01 to 17.02 ms (0.5·T_p 8.505), thermal
`none`, battery 100 %, 23.7 to 26.6 °C. cpufreq was sampled 37 times, 3 derated: A55 774 to
1 800 MHz, A75 998 to 2 000 MHz. Per phase, ms p50/p95 pooled:

| Input | Arm | decode | provide | apply | draw | **total** | evidence_hash |
| ----- | --- | ------ | ------- | ----- | ---- | --------- | ------------- |
| `scene-full` | `gsw-ts` | 3.250/3.805 (+ validate 0.970/1.380, resolve 0.795/0.985) | - | - | - | **5.065/5.925** | 6.195/7.090 |
| | `gsw-rs` | 2.410/2.935 | 0.000/0.555 | 0.370/1.050 | 0.525/1.020 | **3.420/5.760** | 3.400/3.620 |
| `scene-patch` | `gsw-ts` | 0.440/2.185 (+ 2.255/2.785, 0.170/1.485) | - | - | - | **3.160/5.580** | 0.350/2.975 |
| | `gsw-rs` | 0.355/1.410 | 0.000/0.590 | 0.090/1.095 | 0.640/1.250 | **1.180/4.920** | 0.100/0.905 |
| `hd-patch` | `gsw-ts` | 1.755/4.215 (+ 3.510/7.135, 0.975/1.655) | - | - | - | **6.330/10.955** | 4.510/7.415 |
| | `gsw-rs` | 1.525/2.760 | 0.805/2.955 | 1.455/5.255 | 1.325/2.365 | **5.200/13.595** | 1.470/2.575 |
| `pace-patch` | `gsw-ts` | 0.590/0.795 (+ 0.655/1.010, 0.170/0.320) | - | - | - | **1.440/1.955** | 0.410/0.595 |
| | `gsw-rs` | 0.500/0.735 | 0.000/0.000 | 0.125/0.205 | 0.480/0.700 | **1.170/1.580** | 0.115/0.130 |

R2, R3 and R4 hold on `scene-full`, `scene-patch` and `pace-patch` in every round (5/5 paired).
`gsw-rs` total p95 per round is at most 5.955, 5.100 and 1.625 ms against 8.505. hd-patch, the
stretch target, misses: 12.660 to 14.225 ms per round. Two earlier runs on intermediate builds
(`g31-r1`, `g31-r2`) agree within noise.

**Re-verified.**

- `rs-core` cargo tests pass (26, `ordering_model` run on gate 1's recording), and clippy is clean.
- `rust-prototype` cargo tests pass with and without `canvas-items`.
- `canvasItemsRustPixel` passes 24/24, byte-identical to the TypeScript executor.
- G7x's R1 desktop checks hold. The pace shots are 0 px from the model and the reference,
  `draw-count-parity` holds on all inputs, and `drop-draws`, `stale-item-row` and `digest-skip`
  are each caught.
- `pnpm test` passes: 168 files, 2 487 tests.
- **Consumer check.** `../sts2-couch-coop` was pointed at this worktree with its checkout left on
  clean `main`. Its `build-rust-prototype.sh` output is byte-identical, and its seven Rust
  renderer specs pass (195 tests). The canvas TypeScript API is unchanged, so `vue-tsc` was not
  needed.

**What G7a does not prove:**

- Gates 4 to 6, live legs, suspension and context loss through the page, and any device leg other
  than the bench. Those are G7t, G7s, G7g, G7l, G7u and G7v.
- hd-patch within budget.

**What G7t and G7s inherit:**

- **G7t** gets text, geometry and meshes:
  - MSDF, which is drawn plain and typed `gsw-msdf`.
  - Hairlines and AA feathers, typed.
  - Nine-patch tile, typed.
  - Godot's vertex transform chain, for `LE`-type pixel-centre ties.
  - The `geometry-raster.ts` differential.
  - Gate 4/5 masks in `gsw-tolerance.ts`.
- **G7s** gets custom shaders: `SM`, typed `gsw-shader-builtin`. Item-space programs go through
  the draw list's `program` id.
- **Both** extend `GSW_LEGS`, `GSW_RECEIVER_CHECKS` and `q7Plan` in `lib/gate7-gsw.ts` per gate.
- hd-patch's step transactions are the next optimization target, whoever takes it.

