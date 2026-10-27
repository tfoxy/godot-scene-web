# P3-CK: the host shader clock under stalls, and GSW's half-float samplers (2026-10-27)

**Both card-glow residuals were defects, one in each place, and both are fixed.**

1. **The capture (the host clock).** P3-TM summed the tree's process delta, and Godot clamps that
   delta after a long iteration while it does not clamp the step GLES3 adds to `TIME`. Every stall
   (each C3 shot's `save_png` is about 0.4 s) left the wire behind the host for good. The capture
   now takes the step from a hooked `RenderingServer::draw`.
2. **GSW (the receiver).** rs-core quantized half-float textures to RGBA8. The ring shader takes
   `mod(TIME * 0.03 + COLOR.a, 0.02)` over the glow's RGBAH distance field, and one 8-bit step
   (1/255) is a fifth of that band. GSW now uploads them as `RGBA16F`, as GLES3 keeps them.

On STS2 (`p3ck-a10-1`, one new a10 game leg), combat went from **37.2-43.2 dB to 45.2-46.9 dB** on
both receivers. Against the reference, the hand-card band now has **0 / 97 / 0 px over 16**
natively, against 316 / 22,419 / 23,800 in CG4. Between native and GSW it has **0 px over 16
(max delta 1)** on every shot, against 2,487-2,650.

Design: [gate5_5-design.md](../../protocol/gate5_5-design.md) "Shader clock under stalls and
half-float samplers (P3-CK)". Wire: [render-stream-10.md](../../protocol/render-stream-10.md)
"Shader time" (P3-CK paragraph). **There is no wire change.**

## Diagnosis (offline, no game launch)

**The ring.** The ring is five items at the bottom of the hand-card band:

- items 911 / 945 / 979 / 1013 / 1047;
- each draws `add_texture_rect` of texture 8 (RGBAH 512x512);
- each uses materials 84-96 on shader 3, which is `blend_add`, with `ease` 0.005,
  `modulo_width` 0.02, `ripple_speed` 0.03 and `width` 0.075.

The fragment computes `mod(TIME * ripple_speed + COLOR.a, modulo_width)`, followed by a
`smoothstep` 0.075 wide. That gives a temporal period of 0.02 / 0.03 = 0.667 s (40 frames). The
texture's alpha runs 0.219-1.0 and has 2,218 distinct half values.

**Symptom 1 (P3-TM's 8-12 frame drift) is a host-clock bug.** `Main::iteration` computes
`scaled_step = process_step * time_scale` first (main.cpp:4693-4694). It then clamps
`process_step` alone when the iteration wants more than `max_physics_steps_per_frame` (8) physics
steps (:4710-4713). After that:

- the tree processes the clamped step, which is P3-TM's source, `Node.get_process_delta_time`;
- `RenderingServer::draw` gets the unclamped one (:4825-4829);
- `RasterizerGLES3::begin_frame` adds the unclamped one to `TIME`.

Both kept recordings show this. Their carried `shader_time` jumps exactly 8.47 frames after each
shot, which is the clamp, while the reference's wall clock moves about 0.43 s.

Between consecutive shots, the wall clock minus the carried time grew by these amounts (frames;
`times.mts` in the evidence):

| leg | menu-2 | menu-3 | map-1 | map-2 | map-3 | combat-1 | combat-2 | combat-3 |
| --- | ------ | ------ | ----- | ----- | ----- | -------- | -------- | -------- |
| cg4-a10-2 | 14.3 | 13.9 | 47.9 | 0.3 | 3.9 | 102.5 | 44.9 | 9.8 |
| p3tm-a10-2 | 16.2 | 17.8 | 65.3 | -5.2 | -1.4 | 83.6 | 17.7 | 18.5 |
| **p3ck-a10-1 (fixed)** | -1.2 | -0.1 | 1.8 | -0.7 | -1.6 | 1.8 | -0.2 | 0.7 |

- The wall clock only approximates GLES3's sum (the timer sync smooths it), so the fixed leg's
  residual is ±2 frames of measuring noise.
- Mod the 40-frame period, the drift explains why one combat shot per leg happened to match: CG4's
  combat-1 and P3-TM's combat-2.
- This also answers P3-TM's guess: `force_draw` is not the cause. The engine passes it the same
  `frame_step`, and the hook counts it anyway.

**Symptom 2 (native and GSW disagreeing by 2.5-3k px in the band) is a receiver disagreement,
GSW's.** Both receivers apply the same `TIME`:

- native rewrites `TIME` to `rs_host_time`, and GSW sets `uniform float TIME`;
- both round the same double to f32 per transaction, and the shot seq is the same;
- neither wraps or scales again.

What differs is `COLOR.a`. Native's planner uploads RGBAH as `Image.FORMAT_RGBAH` (exact).
rs-core's `texture_rgba8` quantized it to RGBA8, which is up to 1/510 off, or 0.1 of the band. g8f
never saw this because it reads float texels directly, and output rounding hides the quantization
there.

## What changed

**Capture:**

- **The calibrator** has a new `draw` key, at slot 552 on the stock template and on STS2's MegaDot
  alike. `calibrate.py` and the committed record changed.
- **The hook.** `hooks.cpp` `hook_draw` is conditional (/10 only, like CG1's two), so below /10
  nothing is planned or omitted and every session there is byte-identical. It feeds
  `shader_clock_draw(frame_step)`, but only for main-thread calls, since the engine refuses the
  others before drawing.
- **The clock.** In `rs_shader_clock`, the hooked draws keep the sum. The frame callback still
  advances a host that has never drawn (headless) by the tree's delta, so every headless fixture's
  `shader_time` is unchanged (g55t's bit-exact check passes). A record without the slot keeps
  P3-TM's sum.
- **The fault knob** `GRC_SHADER_CLOCK_FAULT=tree-delta` forces P3-TM's sum. It is a knob, not a
  `GRC_SABOTAGE` kind, because a new kind would be a wire change.
- **The log** names the clock's `source=draw-hook|frame-callback` at arm and its draw count and
  total at disarm.

**GSW:**

- **rs-core.** `texture_rgba16f` keeps `RH`..`RGBAH` as RGBA16F (`TexturePixels::half`), filling a
  missing channel with 0 and a missing alpha with 1.0, and `upload_pixels` sends it as such.
- **The draw list** (`packages/canvas/rust-draw-list`) gets `TextureOp::UploadHalf` and
  `DrawList::upload_half_texture`.
- **The executor** (`rust-prototype` `canvas_items/gl.rs`) validates the op and uploads
  `RGBA16F` / `HALF_FLOAT`, which filters in WebGL 2.
- **Out of scope:** the float32 formats stay quantized, because RGBA32F filtering needs
  `OES_texture_float_linear` and STS2 draws none of them.

## Generic reproducers: `fixtures/gate55-time`, group `g55t`

- **TH (base scene).** `fract(COLOR.a * 32 + TIME / 2)` over a 256x1 RGBAH alpha ramp, with alpha
  0.25 + i/512 (exact in binary16). It is drawn 1:1 with nearest filtering and is in the hand model
  within 1.
  - **Before the fix,** the pre-fix GSW bundle (CG3's `f931fc54…`) replayed on this capture differs
    from the reference by more than 1 in 3,712-3,744 of TH's 4,096 px (max 254) at every step, and
    nowhere else (`artifacts/.../th-before-gsw/`).
  - **After the fix,** GSW and the web export are within 1, and native is exact.
- **The `stall` variant.** It adds TC, a clock writing `floor(TIME * 1024)` as RGB bytes, plus a
  0.3 s `OS.delay_msec` at frames 12, 22, 32 and 42.
  - It runs in real time (`--max-fps 60`). `--fixed-fps` would disable the clamp.
  - It is rendered, with the capture armed in the same process, so the host's own shots are the
    reference.
- **Legs:**
  - `stall-host`;
  - `stall-receiver`, the native receiver or, in gate 7, a browser;
  - `sabotage-stall-host-clock-fault`, which runs the fault.
- **Checks:**
  - `g55t-stall-clock-carried`: the iteration after each stall is clamped (its tree delta is
    0.134-0.150 s, against 0.3 s unclamped), the source is `draw-hook`, and TC equals
    `floor(f32(shader_time) * 1024)` at every shot.
  - `g55t-stall-receiver-equals-host`.
  - `g55t-sabotage-stall-clock-fault-detected`: the wire equals TC at step 0 and is at least
    0.05 s behind at every later shot. It measured 0 / 154 / 324 / 478 / 631 codes of 1/1024 s,
    about 9 frames lost per stall, which is P3-TM's defect reproduced.

The g55t results, all 10 checks in each:

| run | g55t |
| --- | ---- |
| native (local, `run-gate55.sh --legs g55t`) | 10/10, receivers exact |
| g7live-web-rust g7-55 (local) | pass (the whole g7-55 group, g55f/s/v too) |
| g7live-gsw g7-55 (local) | 10/10 after loosening one bound (below) |

**The bound.** On GSW's first run one stall's next delta measured exactly 9/60 s, the timer sync's
remainder. The clamp bound was `< 9/60` and is now `< 10/60`. The same evidence passes 10/10 under
the new checker, and the rerun is listed under Validation.

## STS2

**Replay first, with no game.** CG4's recording (`cg4-a10-2`) replayed through the fixed GSW, with
the bundle `b98d9f4a…` served on the new port 13911 (build.json saved):

- combat **43.45 / 37.31 / 37.58 dB**, against GSW-after-CG3's 42.36 / 37.24 / 37.65 and native's
  43.22 / 37.25 / 37.52;
- native against GSW in the card band: **0 / 0 / 0 px over 16** (max 1), against 2,650 / 2,545 /
  2,487;
- the ring phase against the reference still drifted, as the recording's own clock did.

**The game leg (`p3ck-a10-1`).** Because the fix is in the capture, one a10 leg ran.

- **The lease:** `live-qa-lock.mjs with --owner p3ck-p3 --resource shared:install --resource
  exclusive:game:p3-sts2 --resource exclusive:port:13913`. It is the outermost wrapper, then GSW's
  quiet lock shared, then `leg-main.sh` (`artifacts/.../leg-cmd.sh`).
- **Isolation:**
  - a private farm and XDG under the scratchpad;
  - CG4's mod build `e86f9405`;
  - `gamescope --backend headless`;
  - the capture built from this branch;
  - the STS2 record recalibrated offline from the farm's byte-identical binary copy, as
    `…m12.ck.json`, which is `…m12.cg4.json` plus `draw` 552.
- **The clock:** `source=draw-hook draws=5000`.
- **The census:** 4,923 transactions, all `ok`.
- **Lifecycle:** TERM was ignored and the game KILLed by pid; `survivors: none`. The game,
  launcher and gamescope pids were checked gone afterwards.
- **Hashes:** all five sets unchanged. Nothing was written under `~/.steam`.

**PSNR (dB) against the in-process reference, min-max over the scene's three shots.** CG4 is the
"before": the same route, a different recording, with shots paired by step.

| scene | CG4 native | CG4 GSW (after CG3) | **P3-CK native** | **P3-CK GSW** |
| ----- | ---------- | ------------------- | ---------------- | ------------- |
| menu | 31.34-31.89 | 31.38-31.93 | 30.08-30.52 | 30.11-30.55 |
| map | 64.08-64.21 | 65.47-65.56 | 64.12-64.18 | 65.49-65.53 |
| combat | 37.25-43.22 | 37.24-42.36 | **45.20-46.44** | **45.56-46.87** |

**The hand-card band** (y 810-1080, px over 16):

| per combat shot | CG4 | P3-CK |
| --------------- | --- | ----- |
| native against the reference | 316 / 22,419 / 23,800 | **0 / 97 / 0** |
| native against GSW | 2,650 / 2,545 / 2,487 | **0 / 0 / 0** (max delta 1) |

- **Combat's remainder** is 1,842-2,549 px over 16 per shot (0.09-0.12 %). It sits outside the
  band (the known multimesh and particles gaps).
- **Menu.** Native and GSW agree within 1 on the menu. Its run-to-run change is all in the bottom
  grid row (y 810-1080), where the menu's unsupported particle items (1150 and 1151) draw. A 6x4
  grid shows every other cell under 60 px, apart from the same one at about 12-15k in both legs.
  That is particle randomness, not the clock.

## Validation

- **Plan:** the diff reaches everything (a capture change), with sabotage legs run.
- **Remote, full tier:** run **40517664977** (run_key `rv-20261027T140423Z-5186a2e-179`), on the
  snapshot taken before the bound fix. **18 of 21 runs pass**, among them `capture-build` (ctest
  31/31), cargo x4, `pnpm-test`, `bench-instr`, native gates -1 to 5, 5.5 and 8, `g7-gsw` and
  `g7-web-rust`. The three that fail:
  - `pure`: shard 4 of 6 lost its runner, so its job ended with no step run. `pure` passes locally,
    1/1.
  - `g7live-gsw` and `g7live-web-rust`: only g7-55 fails, and only the old `< 9/60` clamp bound.
    The deltas measured exactly 0.15 s, at the stall at frame 22 on GSW and at frame 12 on the web
    export. Every other g55t check passes on llvmpipe (GSW and web within 1, max delta 0) and every
    other group passes.
- **Local, after the bound fix:**
  - `g7live-gsw` g7-1 plus g7-55: pass;
  - `g7live-web-rust` g7-1: pass (its g7-55 passed in the earlier local run, and the bound only
    loosened);
  - `lock-tests` and `pure`: pass.
- **Local, earlier:**
  - native g55t 10/10;
  - `g7live-web-rust` g7-55: pass;
  - `cargo check` for rs-core;
  - the rs-core unit test `half_formats_keep_rgba16f`;
  - the GSW wasm build;
  - `tsc` on the experiment: only the known gate2b, gate8-cache and g8kv errors.
- **Deferred** to the sweep: timing.

## Evidence

In `artifacts/render-stream/p3/p3-ck/` (main checkout):

- `g55t-native-result.json` and `g55t-native/`: the stall shots, plus the stall and clock lines;
- `th-before-gsw/`: the pre-fix GSW TH shots and a reference;
- `sts2-p3ck-a10-1/`: compare, census, notes, steps, the clock lines, hashes and the leg console;
- `sts2-cg4-gsw-replay/`: compare and the bundle `build.json`;
- the STS2 calibration record and its stdout;
- `leg-cmd.sh` and `extension.sha256`;
- `times.mts`, `band.py`, `grid.py`, and the three legs' per-transaction times.

Elsewhere:

- **The recording:** `artifacts/render-stream/p3/fidelity-data/p3ck-a10-1/capture/` (ignored) holds
  `p3ck-cut.rs10` (cut after seq 2933) and `store`. The uncut recording was deleted.
- **Game frames and replays:** couch-coop's research folder, `c3/legs/p3ck-a10-1/` and
  `c3/legs/cg4-a10-2/replay/p3ck-gsw/`.

## Not done

- **Float32 textures** are still quantized on GSW (above).
- **Headless hosts** still use the tree's delta, so a headless host that stalls past the clamp
  would drift. No headless host draws, so there is no draw step to read; every fixture that does
  this runs at `--fixed-fps`, where there is no clamp.
- **A late-loaded extension** still starts its clock at 0 (P3-TM).
