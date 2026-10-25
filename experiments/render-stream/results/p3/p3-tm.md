# P3-TM: shader TIME and sampler defaults on every receiver (C3 gap 4, 2026-10-25)

**Canvas shaders that read `TIME` now draw on every receiver, with the host's shader time.** A
render-stream/10 capture carries that time per transaction. GSW also binds Godot's default
textures for an unset sampler under `hint_default_black`, `hint_default_transparent`, `hint_normal`,
`hint_roughness_normal` and `hint_anisotropy`.

The card glow's half-float texture turned out to be **product config only**: adding `RGBAH` to
`GRC_RESOURCE_FORMATS` is enough, and no code changed for it.

On STS2 the hand cards' glow is back:

- combat went from **26.2 dB to 32.6-33.9 dB** on both receivers;
- the menu and map are unchanged or slightly up;
- no `shader-time` refusal remains, and GSW refuses no canvas shader (STS2's shader 32,
  `22b48677`, transpiles).

Design: [gate5_5-design.md](../../protocol/gate5_5-design.md) "TIME and sampler defaults
(P3-TM)"; wire: [render-stream-10.md](../../protocol/render-stream-10.md) "Shader time".

## The two questions

1. **Is the shader time observable at the RS boundary? Not as a value.**
   - Godot 4.5.1's canvas `TIME` is `RasterizerGLES3::time_total`. `begin_frame` adds each draw's
     `frame_step` (`RenderingServer::draw(.., scaled_step)`, main.cpp:4825-4829) and wraps the sum at
     `time_rollover_secs` (rasterizer_gles3.cpp:97-107).
   - No `RenderingServer` getter or `global_shader_parameter` carries it.
   - Its inputs are observable from the capture's frame callback, which runs after each
     iteration's draw (main.cpp:4839):
     - `Engine.get_frames_drawn()` moves exactly when the iteration drew;
     - `Node.get_process_delta_time()` is the same `process_step * time_scale` double.
   - So the capture keeps the rasterizer's sum (`rs_shader_clock.cpp`). A headless host, which
     never draws, advances every iteration: the time a rendered host would have.
2. **Does carrying it need a wire field? Yes.** No /2-/9 key carries a per-transaction value.
   - It joins /10, which is CG1's and still unreleased. This branch is built on CG1's
     `8c7daf2a` wip.
   - The new key is `shader_time: {f}`. It sits right after `materials`, and its value is
     `param_f64`'s last float (the host's double).
   - The key is present exactly when the resolved state holds an `ok` shader that uses `time`.
   - The rest is unchanged: /2-/9, and /10 without a TIME reader, are byte-identical, and
     `golden-5/` to `golden-10/` pass unchanged.
   - In a /10 session the D11 scan types `TIME` as a use, not `shader-time`. While a TIME reader
     exists, a new time moves the mirror epoch, so live connections still send when only the time
     changed.

## What changed

- **Capture:**
  - `rs_shader_clock.{h,cpp}`: the GLES3 sum, ticked every frame callback.
  - `scan_shader_code(code, time_carried)`.
  - `Mirror::set_carry_shader_time` / `set_shader_time` and `Snapshot/Transaction::shader_time`, with
    the diff copying it.
  - The encoder's /10 key.
  - `rs10_codec_test`: `test_shader_time`.
- **Decoders and validation:**
  - TypeScript `render-stream-2.ts`: the schema, `param-offset`, the `shader-time` presence rule,
    and `shader_time` in the resolved form.
  - Rust `meta.rs` and `meta/fast.rs`: the optional key.
  - Rust `validate.rs`: the offset, the presence rule (`shader-time`) and `ResolvedState::shader_time`.
  - Rust `canon.rs`: the resolved form.
- **Native and web export** (`rs-core-capi` planner):
  - A TIME shader's code is compiled with `TIME` read from `uniform float rs_host_time`
    (`programs::host_time`, the capture's token rule).
  - Its materials get that parameter whenever the transaction's time changes.
  - The receiver's own rasterizer clock never reaches the picture.
- **GSW:**
  - `packages/effects` `transpileGodotItemShader` admits `TIME` in both stages as a renderer-set
    `uniform float TIME` (`time: true`). It also admits the five hints above and names each
    sampler's `default`.
  - `rs-core` applier:
    - it puts the transaction's time in `DrawList::shader_time`;
    - it binds the hint's default when the material sets no texture;
    - a set texture that is not resident still draws white.
  - The `canvas_items` executor holds GLES3's black, transparent, normal and anisotropy textures
    beside white (`BLACK_TEXTURE` and the others in `rust-draw-list`), and sets `TIME` per program
    as a float.
- **Sabotage `shader-time-frozen`** (native and GSW): every `TIME` reads 0.

## Generic reproducer: `fixtures/gate55-time`, group `g55t`

The fixture:

- TP: a sine pulse in `TIME` through a helper.
- TS: UV scrolling with `TIME`.
- TV: `TIME` in `vertex()`, a whole-pixel shift.
- The unset-sampler row: no hint, white, black, transparent, normal, roughness_normal and
  anisotropy.
- DS: a black-hint sampler, set at step 2 and cleared at step 3.

The capture host and the reference run `--fixed-fps 60`, so `TIME` at frame F is F steps of 1/60 on
both. Before this change, the capture typed TP, TS and TV `shader-time` and every receiver drew them
plain, and GSW refused DB, DT, DN, DR, DA and DS.

| Receiver | g55t |
| -------- | ---- |
| native (full and patch sinks) | 7/7: the /10 capture's `shader_time` equals the F/60 sum bit for bit in all 52 transactions; the reference repeats and matches the hand model; both receivers exact at every step; the sabotage differs in TP, TS and TV only |
| web export (g7-55 live half) | 7/7: within 1 (max delta 1) |
| GSW (g7-55 live half) | 7/7: within 1 (max delta 1) |

## STS2 (`p3tm-a10-2`, one a8-style leg at /10)

**The leg.** One game leg ran under `exclusive:game:p3-sts2`, with a private harness copy and
C3's farm:

- the mode is a new `a10`: `GRC_STREAM_VERSION=10` and
  `GRC_RESOURCE_FORMATS=L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH`;
- the leg ended with `survivors: none`;
- all five hash sets were unchanged.

**The census:**

- 4916 transactions, all `ok`;
- shaders: 65 `ok` and 7 `shader-mode` (a8-2 had 33 `shader-time` refusals);
- the RGBAH 512x512 card-glow texture is `ok`. The 846 remaining unsupported float textures are
  the particle curves, and no drawn command names an unsupported texture.

**The clock.** The capture armed at scene init, before the first tick, so the clock started at
iteration 1.

**The replays.** The recording was cut after the last shot (seq 2920) and replayed with this
branch's receivers. The table gives PSNR in dB against the in-process reference, min-max over the
three shots per scene:

| scene | before (P3-VX, p3st-a8-1) native / GSW | P3-TM native | P3-TM GSW |
| ----- | -------------------------------------- | ------------ | --------- |
| menu | 31.1 / 31.1 | 31.17-31.43 | 31.20-31.47 |
| map | 64.1 / 65.5 | 64.14-64.17 | 65.51-65.53 |
| combat | 26.2 / 26.2 | **32.57-33.84** | **32.58-33.85** |

The before numbers are a different recording of the same route, so their shots are paired by step,
not by frame.

**What the TIME half adds.** The same recording was replayed natively with `shader-time-frozen`;
combat then reads 32.69 / 32.74 / 32.84 dB.

- The regions where the carried time matters are 15-20k px per shot, where native and frozen
  differ by more than 16.
- At combat-2 the carried time matches the reference: mean error 8.5 there, against 33.1 frozen.
- At combat-1 and combat-3 it does not (29.9 against 27.6 and 25.6). There the reference best
  matches transactions 8 to 12 frames away.
- The fixture shows the receivers reproduce the carried time exactly. So this residual is
  host-side and **not diagnosed**. Candidates:
  - draws the frame callback does not count, such as `RenderingServer.force_draw`, which adds its
    own step and does not move `frames_drawn`;
  - game-side per-card animation state.
- The exact alternative is to sum the rasterizer's own steps by hooking `RenderingServer::draw`.
  That needs a calibrated slot, which is a follow-up.

The card glow, at combat-2 (`artifacts/render-stream/p3/p3-tm/glow.png`):

- before: no glow on either receiver;
- reference;
- P3-TM native and GSW;
- native with TIME frozen.

## Validation

All of this ran on this branch on top of CG1's wip `8c7daf2a`.

**Remote, full tier** (run 40224586459): 20 of 21 runs pass. They include `pure`, `capture-build`
(ctest 31/31, with `rs10_codec_test`'s new `test_shader_time`), cargo x4, `pnpm-test`,
`bench-instr`, native gates -1 to 5, 5.5 (`g55t` included) and 8, and `g7-gsw`, `g7-web-rust`,
`g7live-gsw` and `g7live-web-rust`. `g55t` passes in both browsers on llvmpipe.

The one failure is `native-rust-gate8`, which is not this increment's:

- CG1's own `cg-reference-repeat` failed on the runner;
- `decode-cost` / `worker-hook-time` have no evidence because remote skips timing.

**Local:**

- native `g55t` 7/7;
- `g7live-gsw` and `g7live-web-rust` on `g7-55` (g55f, g55s, g55v, g55t): 2/2 pass, g55t 7/7 each;
- the remote's refused runs: `g7live-gsw` and `g7live-web-rust` on `g7-1` (2/2) and `lock-tests`,
  all pass;
- `pure`, `capture-build`, cargo x4: 6/6 pass;
- `packages/effects` tests 175/175;
- `pnpm typecheck` and `typecheck:ts6`;
- biome on the changed TypeScript;
- `tsc` on the experiment: only the known `gate2b`, `gate8-cache` and `g8kv` errors;
- `make-features --protocol 8 --check`.

**Deferred** to the milestone sweep: the timing runs (native gate 6, `g7live-*-timing`, `g7x`).

## Evidence

`artifacts/render-stream/p3/p3-tm/` (main checkout): `glow.png`, `compare.json`, `contact-sheet.png`,
`census.json`, `grc-lines.txt`, `notes.txt`, `g55t-native/` and `g55t-native-result.json`. The
recording and store are in `artifacts/render-stream/p3/fidelity-data/p3tm-a10-2/` (ignored), and the
game-derived frames and replays are in sts2-couch-coop's research folder, `legs/p3tm-a10-2/`.

## Not done

- **Late load:** an extension loaded after the first iteration starts its clock at 0, so the phase
  is offset by the time before the load. It logs `start_frames_drawn`.
- **Below /10**, `TIME` stays refused (`shader-time`).
- **The undiagnosed STS2 phase residual** above.
- **GSW default textures** are 1x1, where GLES3's are 4x4. Only `textureSize()` on an unset sampler
  could tell them apart.
