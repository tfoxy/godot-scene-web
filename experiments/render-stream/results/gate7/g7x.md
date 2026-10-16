## Gate 7x result (2026-10-15)

G7x ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7x", D29 to D34, Q14) is the smallest
end-to-end Rust path: the four G7d bench recordings go through `render-stream-core`, become a packed
CanvasItem draw list, and are drawn by the Rust renderer's new `canvas-items` executor, on the moto
g31, timed per phase against the TypeScript path in the same session. **It wins: R1 to R4 hold on
the g31.** `hd-patch`, the stretch target, misses R4 (below).

**What was built** (about 18.7k lines of Rust, all offline against the local registry):

- `experiments/render-stream/rs-core/` (`render-stream-core`): /2 to /6 framing, canonical meta,
  blocks and payloads (GRT1/GRM1/GRP1) behind a `version` parameter; the validator and resolver,
  delta-driven (patch transactions touch only what they name; full transactions are applied in
  place against the retained state and skip entries bitwise equal to it); payload hash
  verification; D31's record digest with an `Inline`/`Deferred` policy; the D7 applier
  (`src/apply/`) with lowering for every op class the four inputs contain; and the
  `rs-core-check` CLI (`goldens`, `diff`, `bench`, `validate`). /7 is not decoded: the contract
  defers it to G7a.
- `packages/canvas/rust-draw-list/` (`gsw-canvas-draw-list`): the packed draw list. Items are
  48 B rows (2x3 transform, modulate, flags), vertices 36 B (position, uv, RGBA f32 colour, item
  index), draws 44 B (index range, texture, sampler, Godot blend, program, integer scissor), with
  dirty ranges, texture upload/free ops and a `pdl1` dump format. No dependency on the core.
- `packages/canvas/rust-prototype`, cargo feature `canvas-items`, **off by default**: a WebGL2
  executor for that list. Vertex-colour meshes, item rows in an RGBA32F texture, integer scissor,
  Godot's blend modes, an RGB10_A2 target with a rounding blit to the canvas, readback and fence
  polling. G7c's TypeScript executor is the spec; `canvasItemsRustPixel.test.ts` (24 cases, both
  executors, same GPU) is byte-identical. The default build is byte-identical to `main`'s
  (`build-web.sh`: wasm `d810e2a3…`, JS `fed168e4…`): the existing renderer exports are gated on
  the existing `webgl` feature, because enabling any additional feature changes the default bytes.
- `experiments/render-stream/web/gsw-rs/` (`rs-gsw-wasm`): the core and the executor in one
  wasm32 module (1 220 026 B, wasm-bindgen 0.2.129). The recording crosses the boundary once
  (`alloc_recording` + `load`); per transaction the page calls `accept`, then `provide` for any
  payloads the applier needs, `apply`, `draw`; stats come back through one shared `u32` view.
- `web/bench/bench-rs.ts` + `rs.html`, and `gate7-bench.ts` arms `gsw-rs` and `gsw-rs-inline`, plus
  `--interleave` / `--rounds` (the contract's protocol: per input, a warmup page per arm, then five
  rounds of `gsw-ts`, `gsw-rs`, `gsw-rs-inline`, each on a fresh page load; an invalid page is
  re-run once). The TypeScript arm is renamed `gsw-ts`; `gsw` remains an alias until G7a.
- `scripts/build-rs-core.sh`, `scripts/gate7x-checks.ts`, `scripts/run-g7x-{desktop-checks,
  sabotages,scene-native}.sh`, `scripts/test/self-test-rs-core.ts` (Rust-against-TypeScript
  differential) and `self-test-rs-core-wasm.mjs` (goldens through the wasm module in Node).

### Op census (TypeScript decoder, before any lowering was written)

| Input | Tx | Max items | Ops in the resolved state |
| ----- | -- | --------- | ------------------------- |
| `scene-full` / `scene-patch` | 400 | 54 | `add_rect`, `add_texture_rect` (no tile/transpose), `add_texture_rect_region` (glyphs on a 256² LA8 atlas, no clip_uv), `add_set_transform`, `add_triangle_array` (StyleBoxFlat: untextured, per-vertex colours, count -1), `add_nine_patch` (stretch/stretch, draw_center), `add_polygon` (5 points, 1 colour), `add_polyline` and `add_line` (width > 0, no AA), `add_circle`, `add_mesh` (one untextured triangle surface, colours + indices) |
| `hd-patch` | 122 | 496 | the same ops (2 137 commands per transaction), 1920x1080, ten layered canvases (L-9 to L9) |
| `pace-patch` | 400 | 1 | `add_texture_rect_region`, RGBA8 32x32, nearest |

Materials: CanvasItemMaterial `add` and `sub` blends, and one custom ShaderMaterial. Two items clip;
one item has a non-zero z; canvas 2 moves between layer 1 and -1; the root canvas carries an (8, 4)
offset for 300 of `scene`'s transactions. Nothing unsupported, no AA, no hairlines, no MSDF, no
`clip_ignore`, no stretch where presentation differs from logical size.

### Interim shortcuts (none drops a draw)

Fired on these inputs: **`slice-shader-builtin`** (the custom ShaderMaterial draws with the builtin
program and its CanvasItemMaterial-equivalent blend; region `SM` below).

Typed, implemented, and never reached by these inputs (each counted per frame in the stats, each
either drawn approximately or, for the three `*-skipped` resource cases, counted against
`draw-count-parity` as a typed skip): `slice-aa-feather-omitted`, `slice-hairline-as-quads`,
`slice-clip-uv-ignored`, `slice-ninepatch-tile-as-stretch`, `slice-msdf-as-plain`,
`slice-mesh-primitive-skipped`, `slice-mipmaps-level0`, `slice-material-unsupported-default`,
`slice-tie-append-order`, `unsupported-command`, `texture-unavailable-skipped`,
`texture-not-resident-skipped`, `mesh-unavailable-skipped`.

Untyped approximations, listed so G7a and G7t find them: `add_set_transform` and mesh transforms
are baked into item-local vertices on the CPU in f32; primitive colours are f32, not half floats;
there is no viewport culling (pixel-neutral, it only costs draws); presentation size different from
logical size is untested (the global transform is `host_final_xform`); lines and polylines use
Godot's vertex counts and non-AA strip lowering but not its exact joint geometry (G7t owns that);
the `disabled` blend is not compared against the TypeScript executor; WebGL context loss is
implemented in the executor (`context_restored`, a full re-upload) but untested through the
receiver path.

### R1, correctness (desktop, D9's harness, pinned chromium-1223 headless)

- **Goldens**: golden-2 to golden-6 through the core natively, 569/569 checks plus the
  cross-version checks; the same 569 through `rs-gsw-wasm` in Node (`self-test-rs-core-wasm.mjs`).
  Sabotage `skip-payload-hash` fails golden `resource-hash`.
- **Differential** (`self-test-rs-core.ts`): the Rust resolved state equals the TypeScript
  decoder's after every transaction of all four inputs, 1 322 transactions, 0 mismatches.
- **`draw-count-parity`**: 0 violating frames on every input (executed calls equal lowered draws
  minus typed skips minus merges).
- **Pace shots**: 8/8 at `fixtures/gate7-pace/expected.json`'s frames, 0 px against the
  synthesized model and 0 px against the rendered reference (`gate7d-checks.ts`'s `shotChecks`).
- **Gate 6 scene against the native receiver** (report-only, twelve seqs 8 to 118):
  every region within max delta 1 except `SM` (3 072 px, max 255: `slice-shader-builtin`, the
  custom shader), `LE` (about 4 000 px, max 7, on the LineEdit's StyleBoxFlat border and selection;
  the resolved commands match the TypeScript decoder's, so the difference is in lowering,
  rasterization or colour interpolation, G7t's) and, from seq 108, when the root canvas carries
  its (8, 4) offset, `BG` (about 2 140 px, max 255). Neither `LE` nor `BG` is root-caused here:
  G7a and G7g own those pixels. Evidence: `desktop-checks/scene/scene-vs-native.json`.
- **Sabotages**, each run on the page and each caught: `drop-draws` (the executor skips every
  second merged call, counted across frames) fails `draw-count-parity` on 200/400 frames and every
  pace shot; `stale-item-row` (the dirty item-row upload is skipped) fails every pace shot against
  the model and the reference; `digest-skip` fails `record-digest-complete`.
- **Executor**: `GSW_CANVAS_ITEMS_PIXEL=1 vitest canvasItemsRustPixel` 24/24 byte-identical to
  the TypeScript executor; `rust-prototype` cargo tests pass with and without `canvas-items`.

### R2 to R4 on the moto g31

Chrome 154.0.8037.127, the contract's protocol: per input a warmup page per arm, then five rounds
of `gsw-ts` (deferred digest), `gsw-rs` (deferred), `gsw-rs-inline`, each on a fresh page load, one
transaction per rAF, every page valid. T_p measured 17.01 ms on every page, so 0.5·T_p is
8.505 to 8.507 ms.

```bash
mise exec -- pnpm exec tsx --conditions=development experiments/render-stream/scripts/gate7-bench.ts \
  --interleave gsw-ts,gsw-rs,gsw-rs-inline --rounds 5 --record-digest deferred \
  --env device --device g31 --inputs artifacts/render-stream/gate7/g7x/inputs/inputs.json \
  --out artifacts/render-stream/gate7/g7x/g31-r3
```

| Input | R2: `gsw-rs-inline` decode p95 vs G7m TS | R3: `gsw-rs` decode p95 vs `gsw-ts` (pooled; paired) | R4: `gsw-rs` total p95 per round vs 0.5·T_p |
| ----- | ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| `scene-full` | **pass** 6.130 < 12.990 | **pass** 2.820 < 6.110; 5/5 | **pass** 5.930, 5.895, 5.410, 5.775, 5.225 |
| `scene-patch` | **pass** 2.220 < 7.395 | **pass** 1.330 < 5.450; 5/5 | **pass** 5.135, 3.990, 4.335, 4.915, 5.240 |
| `hd-patch` | **pass** 4.550 < 16.790 | **pass** 2.465 < 11.095; 5/5 | stretch, **miss**: 11.260, 12.870, 10.545, 11.960, 12.350 |
| `pace-patch` | **pass** 0.745 < 2.160 | **pass** 0.660 < 1.880; 5/5 | **pass** 1.405, 1.450, 1.575, 1.480, 1.390 |

`gsw-ts`'s like-for-like quantity in R3 is its decode + validate + resolve, its `total`. The Rust
`total` additionally contains `provide`, `apply` and `draw`, which the TypeScript arm does not do at
all, so R4 judges the Rust path doing strictly more work than the TypeScript budget figure.

Per phase, ms p50/p95 pooled over the five rounds (G7m's inline TypeScript numbers from "Gate 7o1
result"'s table):

| Input | Arm | decode | validate | resolve | provide | apply | draw | **total** | evidence_hash |
| ----- | --- | ------ | -------- | ------- | ------- | ----- | ---- | --------- | ------------- |
| `scene-full` | G7m TS, inline | 9.935/10.985 | 0.990/1.250 | 0.830/0.995 | - | - | - | **11.790/12.990** | - |
|  | `gsw-ts` | 3.245/4.000 | 0.990/1.400 | 0.800/1.030 | - | - | - | **5.105/6.110** | 6.280/7.180 |
| | `gsw-rs` | 2.255/2.820 | (in decode) | (in decode) | 0.000/0.550 | 0.330/1.230 | 0.540/1.235 | **3.235/5.775** | 3.415/3.720 |
| | `gsw-rs-inline` | 5.190/6.130 | (in decode) | (in decode) | 0.000/0.545 | 0.340/1.135 | 0.530/1.240 | **6.520/9.010** | 0.000/0.000 |
| `scene-patch` | G7m TS, inline | 0.750/4.715 | 2.015/2.630 | 0.130/0.920 | - | - | - | **3.040/7.395** | - |
|  | `gsw-ts` | 0.480/2.085 | 2.290/2.860 | 0.170/1.440 | - | - | - | **3.215/5.450** | 0.355/2.955 |
| | `gsw-rs` | 0.285/1.330 | (in decode) | (in decode) | 0.000/0.610 | 0.055/1.190 | 0.655/1.455 | **1.090/4.875** | 0.100/1.025 |
| | `gsw-rs-inline` | 0.360/2.220 | (in decode) | (in decode) | 0.000/0.600 | 0.055/1.210 | 0.650/1.425 | **1.150/5.790** | 0.000/0.000 |
| `hd-patch` | G7m TS, inline | 6.130/10.785 | 3.550/7.220 | 0.875/1.530 | - | - | - | **10.565/16.790** | - |
|  | `gsw-ts` | 1.780/3.775 | 3.505/6.555 | 1.015/1.640 | - | - | - | **6.380/11.095** | 4.540/7.100 |
| | `gsw-rs` | 1.215/2.465 | (in decode) | (in decode) | 0.590/2.050 | 3.245/5.740 | 1.275/2.255 | **6.370/12.300** | 1.405/2.440 |
| | `gsw-rs-inline` | 2.690/4.550 | (in decode) | (in decode) | 0.565/2.160 | 3.390/5.590 | 1.340/2.340 | **8.320/14.945** | 0.000/0.000 |
| `pace-patch` | G7m TS, inline | 0.975/1.310 | 0.425/0.790 | 0.125/0.205 | - | - | - | **1.575/2.160** | - |
|  | `gsw-ts` | 0.595/0.810 | 0.755/0.965 | 0.175/0.290 | - | - | - | **1.530/1.880** | 0.420/0.590 |
| | `gsw-rs` | 0.450/0.660 | (in decode) | (in decode) | 0.000/0.000 | 0.100/0.135 | 0.485/0.715 | **1.085/1.480** | 0.115/0.135 |
| | `gsw-rs-inline` | 0.530/0.745 | (in decode) | (in decode) | 0.000/0.000 | 0.095/0.130 | 0.470/0.680 | **1.140/1.540** | 0.000/0.000 |

Per round (`derated samples` counts cpufreq samples in the round's window whose `scaling_max_khz`
was below `cpuinfo_max_khz`; thermal status stayed `none` throughout, battery 100 %, 24.3 to
27.4 °C; the A55 cluster's `scaling_max` is 1 800 MHz and the A75's 2 000 MHz when not derated):

| Input | Round | T_p ms | `gsw-ts` total p95 | `gsw-rs` decode p95 | `gsw-rs` total p95 | `gsw-rs-inline` decode p95 | A55 cur MHz | A75 cur MHz | derated samples |
| ----- | ----- | ------ | ------------------ | ------------------- | ------------------ | -------------------------- | ----------- | ----------- | --------------- |
| `scene-full` | 1 | 17.01 | 6.905 | 2.745 | 5.930 | 2.340 | 1100-1450 | 2000-2000 | 0/4 |
| `scene-full` | 2 | 17.01 | 5.870 | 3.200 | 5.895 | 6.050 | 1275-1450 | 1800-2000 | 0/6 |
| `scene-full` | 3 | 17.01 | 5.905 | 2.730 | 5.410 | 6.265 | 1175-1375 | 2000-2000 | 0/6 |
| `scene-full` | 4 | 17.01 | 5.950 | 2.690 | 5.775 | 6.395 | 999-1625 | 1295-2000 | 0/6 |
| `scene-full` | 5 | 17.01 | 6.140 | 2.710 | 5.225 | 6.215 | 900-1625 | 1295-2000 | 0/6 |
| `scene-patch` | 1 | 17.01 | 5.530 | 1.430 | 5.135 | 2.285 | 1275-1450 | 1176-2000 | 0/4 |
| `scene-patch` | 2 | 17.01 | 5.790 | 1.250 | 3.990 | 2.240 | 1175-1800 | 1354-2000 | 0/6 |
| `scene-patch` | 3 | 17.01 | 5.025 | 1.150 | 4.335 | 2.155 | 1100-1800 | 998-2000 | 1/6 |
| `scene-patch` | 4 | 17.01 | 5.055 | 1.430 | 4.915 | 2.155 | 1050-1100 | 1950-2000 | 0/4 |
| `scene-patch` | 5 | 17.01 | 4.945 | 1.240 | 5.240 | 2.095 | 1050-1800 | 1900-2000 | 0/6 |
| `hd-patch` | 1 | 17.01 | 9.170 | 2.330 | 11.260 | 4.395 | 1375-1800 | 2000-2000 | 0/4 |
| `hd-patch` | 2 | 17.01 | 10.205 | 2.465 | 12.870 | 4.630 | 1325-1800 | 1354-2000 | 0/4 |
| `hd-patch` | 3 | 17.01 | 11.040 | 2.415 | 10.545 | 4.055 | 1325-1800 | 1354-2000 | 0/4 |
| `hd-patch` | 4 | 17.01 | 12.150 | 2.510 | 11.960 | 4.220 | 1800-1800 | 2000-2000 | 0/6 |
| `hd-patch` | 5 | 17.01 | 11.205 | 2.230 | 12.350 | 4.730 | 1275-1800 | 1443-2000 | 0/4 |
| `pace-patch` | 1 | 17.01 | 1.885 | 0.645 | 1.405 | 0.705 | 1275-1625 | 1900-2000 | 0/4 |
| `pace-patch` | 2 | 17.01 | 1.895 | 0.635 | 1.450 | 0.815 | 1325-1625 | 1443-1900 | 0/6 |
| `pace-patch` | 3 | 17.01 | 1.880 | 0.695 | 1.575 | 0.380 | 1325-1800 | 1850-2000 | 0/4 |
| `pace-patch` | 4 | 17.01 | 1.825 | 0.660 | 1.480 | 0.760 | 850-1800 | 998-2000 | 2/6 |
| `pace-patch` | 5 | 17.01 | 1.840 | 0.675 | 1.390 | 0.745 | 774-1800 | 998-2000 | 4/8 |

`gsw-rs-inline` ran two pages (`scene-full` round 1, `pace-patch` round 3) about 2.5x faster in
every phase, `draw` included, which no code path explains: device scheduling state, the same noise
that moves the other arms' rounds. They are in the pooled numbers; R2's margin does not depend on
them. Report-only: the wasm heap was 48.1 MB (`scene-full`, the whole recording is in it), 10.9
(`scene-patch`), 24.8 (`hd-patch`) and 1.8 (`pace-patch`); `gpu_complete_ms` (a `fenceSync` polled
on later frames) has p50 11 to 16 ms, the rAF poll's granularity, and says only that the GPU
finished within about one frame.

**`hd-patch` misses its stretch target**, by 24 to 51 %. Its Rust decode is 4.5x faster than the
TypeScript path's at p95, but its `apply` is 3.2/5.7 ms: 111 of its 122 transactions take the
structural path (some item's order, visibility, z, clip, material or content shape changed), which
re-walks all 496 items and rebuilds the index buffer and draw table, instead of the rows-only or
in-place paths. That is G7a's first optimization target (an incremental structural apply), and
D25 already records `hd-patch` as the stretch case.

**The history, reported whole.** Three g31 runs were made. Runs 1 and 2
(`artifacts/render-stream/gate7/g7x/g31-r1`, `g31-r2`) used the first build of the core, whose JSON
layer was a general parser: run 1 met every required criterion (R3 `scene-full` 6.150 < 6.770 ms,
5/5 paired), run 2 failed R3 on `scene-full` (pooled 6.175 > 6.070 ms, 2/5 paired). That first build
merely tied V8's native `JSON.parse` on the 98 KB full transactions; on the g31 wasm runs about 11x
slower than on the desktop while V8's JavaScript runs about 5x slower, which the desktop arms
(2.8x faster in Rust) did not predict. The core then gained a schema-directed fast path for
canonical transaction metas (`src/meta/fast.rs`, falling back to the general parser on anything
unusual) and applies full transactions in place, skipping entries bitwise equal to the retained
state (native `scene-full` accept p50 120 to 34 µs; Node wasm 190 to 52 µs). Goldens, the
differential, the sabotages and every desktop R1 check were re-run on that build before run 3,
which is the result above. The branch was also rebased onto `f5d29fcc` (render-stream/7 codecs,
TypeScript) around run 2; `gsw-ts` stayed within run-to-run noise across all three runs
(`scene-full` total p95 6.770, 6.070, 6.110 ms).

Desktop control (`artifacts/render-stream/gate7/g7x/desktop-r2`, D9's harness, chromium-1223
headless, Ryzen 5 5500, same build and protocol), ms p50/p95 pooled:

| Input | Arm | decode | validate | resolve | provide | apply | draw | **total** | evidence_hash |
| ----- | --- | ------ | -------- | ------- | ------- | ----- | ---- | --------- | ------------- |
| `scene-full` | `gsw-ts` | 0.630/0.905 | 0.185/0.275 | 0.115/0.205 | - | - | - | **0.940/1.355** | 0.720/0.940 |
| | `gsw-rs` | 0.195/0.265 | (in decode) | (in decode) | 0.000/0.075 | 0.035/0.110 | 0.095/0.185 | **0.340/0.655** | 0.330/0.440 |
| | `gsw-rs-inline` | 0.550/0.745 | (in decode) | (in decode) | 0.000/0.070 | 0.035/0.110 | 0.095/0.175 | **0.710/1.025** | 0.000/0.000 |
| `scene-patch` | `gsw-ts` | 0.055/0.220 | 0.160/0.225 | 0.010/0.080 | - | - | - | **0.240/0.470** | 0.025/0.200 |
| | `gsw-rs` | 0.040/0.140 | (in decode) | (in decode) | 0.000/0.080 | 0.010/0.110 | 0.100/0.175 | **0.145/0.525** | 0.010/0.090 |
| | `gsw-rs-inline` | 0.050/0.230 | (in decode) | (in decode) | 0.000/0.070 | 0.010/0.105 | 0.095/0.170 | **0.155/0.620** | 0.000/0.000 |
| `hd-patch` | `gsw-ts` | 0.375/0.695 | 0.775/1.020 | 0.180/0.305 | - | - | - | **1.345/1.965** | 0.665/1.265 |
| | `gsw-rs` | 0.210/0.325 | (in decode) | (in decode) | 0.110/0.395 | 0.565/0.705 | 0.205/0.375 | **1.090/1.780** | 0.275/0.530 |
| | `gsw-rs-inline` | 0.525/0.880 | (in decode) | (in decode) | 0.100/0.365 | 0.545/0.710 | 0.200/0.360 | **1.375/2.305** | 0.000/0.000 |
| `pace-patch` | `gsw-ts` | 0.065/0.090 | 0.060/0.090 | 0.020/0.025 | - | - | - | **0.140/0.200** | 0.025/0.040 |
| | `gsw-rs` | 0.050/0.075 | (in decode) | (in decode) | 0.000/0.000 | 0.010/0.015 | 0.075/0.110 | **0.140/0.190** | 0.010/0.015 |
| | `gsw-rs-inline` | 0.055/0.085 | (in decode) | (in decode) | 0.000/0.000 | 0.010/0.015 | 0.075/0.110 | **0.145/0.205** | 0.000/0.000 |

Every desktop criterion passes, `hd-patch` R4 included (total p95 at most 1.915 ms per round
against 8.333).

### Consumer check (Q14f)

`../sts2-couch-coop` builds `rust-prototype` through `scripts/build-rust-prototype.sh`; pointed at
this worktree (`COUCHCOOP_GSW_ROOT`), its output is byte-identical to `main`'s (wasm `d810e2a3…`,
JS `fed168e4…`), because `canvas-items` is off by default. Its six Rust renderer specs pass (174
tests). The couch checkout stayed on clean `main`; this repo's shared checkout was not switched.
`packages/canvas` 466 tests pass; `rust-prototype` cargo tests pass in the default build and with
`canvas-items`.

### What G7x does not prove

- Pixels on the phone: shots are desktop-only (R1). The g31 runs check `draw-count-parity` and
  `record-digest-complete` on every page, not pixels.
- Gates 0 to 6 through the Rust receiver, /7, live transport, suspension, context loss on the
  receiver path, text exactness (MSDF, outlines), AA, hairlines, custom shaders: G7a, G7t, G7s, G7l
  and G7u own them. The scene's `SM`, `LE` and `BG` differences above are open.
- `hd-patch` within budget: it is not (stretch, above).
- The Rust-against-GDScript question for the native and web-export receivers (D34): G7xn and G7xw.
- A second phone: the g86 did not run.

