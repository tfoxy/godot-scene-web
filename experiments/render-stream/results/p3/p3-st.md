# P3-ST: screen-texture shaders on every receiver (C3 gap 1, 2026-10-25)

**Fixed in the capture and in all three receivers.** Before, the capture typed every
`hint_screen_texture` shader `shader-screen-texture`, and both receivers drew its items without the
material. STS2's main-menu blur rect therefore came out as an opaque white rect over the whole
frame. Now:

- the capture carries these shaders `ok`, with their code;
- the native receiver and the web export let Godot take the back-buffer copies;
- GSW mirrors GLES3's copy points, back buffer and blurred mip chain.

A refused screen reader is no longer drawn plain. Every receiver drops it, under a per-reason
policy written into the gate 5.5 protocol.

On STS2, the menu reaches 31.1 dB natively, with the real blur shader rather than a hidden
item. That figure is together with P3-CT's canvas-texture fix (gap 2); without gap 2 fixed, the blur
reads white spines and the menu stays white. GSW draws the same blur on the generic fixture, but its STS2 menu number is still 3.0 dB. On
the new recording, P3-CT's GSW canvas-texture fix does not take: main's own bundle, without
P3-ST, gives the same bytes. So GSW's blur still reads white spines. That is a P3-CT follow-up,
described below.

Design and policy: [gate5_5-design.md](../../protocol/gate5_5-design.md), "Screen texture (P3-ST)".

## What Godot does, and what was missing

Godot 4.5.1's GLES3 canvas renderer (`rasterizer_canvas_gles3.cpp:397-540`) handles screen
readers per canvas, i.e. per `canvas_render_items` call:

- It copies the whole render target into the back buffer before the first item whose shader
  reads the screen.
- Every later reader in that canvas reuses the copy.
- When a reader samples with a mipmap filter, it builds a gaussian mip chain of the cached copy
  (`copy_effects.cpp:240-310`).
- The back buffer always samples linear, clamped, with mipmaps (the shader's hints are ignored).
  It has `max(1, mips - 4)` levels.

The capture already decoded and hashed the code. It refused the shader only at D11's token scan.
The native receiver already compiles whatever the wire calls `ok`. So the native fix is the scan
alone. GSW had none of it: its transpiler refused `hint_screen_texture` and `SCREEN_UV`, and its
executor had no back buffer.

## Changes

- **Capture** (`rs_shader_payload.cpp`): `hint_screen_texture` is a `use`, not a reason.
  - A shader that also reads `TIME`, the SDF or a global uniform keeps that reason.
  - No wire version and no flag. The entry shape is unchanged, and a session without a screen
    reader is byte-identical. `golden-5/` to `golden-9/` are untouched.
- **GSW**:
  - `packages/effects` transpiler: `screenTexture {names, mipmaps}`, `SCREEN_UV`,
    `SCREEN_PIXEL_SIZE`.
  - `rs-core` applier: GLES3's per-canvas copy points become `DRAW_SCREEN_COPY` /
    `DRAW_SCREEN_MIPMAPS` draw flags, and `SCREEN_TEXTURE` binds the back buffer.
  - `packages/canvas` executor: Godot-shaped back buffer, `blitFramebuffer` copy, and copy.glsl's
    13-tap gaussian per level.
- **Refused materials, every receiver.**
  - A refused material whose shader reads the screen draws nothing of its item (`rs-core`
    `MaterialEff::skip`, `rs-core-capi` `refused_screen_reader`).
  - Any other refused material draws plain, as before. This is GLES3's own fallback.
- **Native receiver sabotage `screen-copy-per-reader`**: a fresh back-buffer copy before every
  reader (`canvas_item_set_copy_to_backbuffer`, a new adapter op). GSW has the same sabotage.
- **gate55-shader's `refused` variant**: its SC screen shader is now `ok` and draws. The capture
  types four refused shaders, not five (`make_expected.py`, `expected.json`).
- **Manifests**: the /8 `canvas_item_set_copy_to_backbuffer` entry stays `unobserved`. Its note now
  says what is and is not carried. The gate 6 text claimed "hooked slot", which it never was.

**Not done: `BackBufferCopy`.** `canvas_item_set_copy_to_backbuffer` stays unhooked, so a host's
`BackBufferCopy` copies replay as the automatic ones. Carrying it needs calibrator slot 484 and an
item key: a render-stream/10. The protocol doc's "Capture and wire" has the design note. The
receivers are ready: the native op exists, and GSW's copy points are data.

Whether STS2 uses `BackBufferCopy` is not observable for the same reason. Its menu matches the
host at the automatic copy points (below), so the menu does not need it.

## The generic reproducer: `fixtures/gate55-screen`, group `g55s`

| Item | What it proves |
| ---- | -------------- |
| RA | the first reader takes the copy |
| LC, RB | a second reader reuses RA's copy, so the solid LC drawn between them never shows |
| RF | SCREEN_UV's top-left origin |
| RE | a mipmap blur builds the cached copy's mip chain at its own position |
| RT | a screen reader that also reads TIME: refused, dropped |
| RC, RD | a child CanvasLayer takes a fresh copy of canvas 0's outputs; RD is clipped |

Six steps move content, so a stale copy from an earlier frame would show.

Checks (`scripts/lib/gate55s-checks.ts`):

- the capture types only RT;
- the reference repeats, and equals a hand model of the copy points on every pixel but RE;
- every receiver equals the reference exactly, with RT dropped (browsers: RE within 1);
- the sabotage differs exactly on LC's 32x32 rect, as the model predicts.

Results (local, before the full tier):

| Receiver | Result |
| -------- | ------ |
| native | 7/7, exact everywhere |
| web export | 7/7, RE within 1 |
| GSW | 7/7, RE within 1, everything else exact |

Before the fix, the capture check fails (`shader-screen-texture`) and every receiver shot differs
in all six readers.

## STS2 confirmation

The kept `a8-2` recording cannot show the fix: the capture never stored the refused shaders' code.
One `a8` leg was run with the fixed capture: `p3st-a8-1`, menu, map and combat, under
`exclusive:game:p3-sts2`.

- It ended with `survivors: none`.
- All five hash sets were unchanged.

The recording yields the five screen shaders. The menu's is `texture(SCREEN_TEXTURE, SCREEN_UV,
lod)` with `filter_linear_mipmap`: the gaussian mip chain at bias `lod`, mixed toward black by
`mix_percentage`.

Replays of `p3st-a8-1`, cut after the last shot (seq 2221), with no game launch. PSNR in dB
against the in-process reference, min-max over the three shots per scene:

| Scene | a8-2, C3 (before) native / GSW | p3st-a8-1, this fix + P3-CT, native | p3st-a8-1, this fix + P3-CT, GSW |
| ----- | ------------------------------ | ----------------------------------- | -------------------------------- |
| menu | 2.93-2.94 / 2.93-2.94 | **31.06-31.16** | 2.97-2.98 |
| map | 64.12-64.17 / 53.26 | 64.09-64.18 | 53.25-53.26 |
| combat | 16.99-17.05 / 16.83-16.88 | 26.16-26.19 | 16.81-16.86 |

How to read the table:

- **The native menu draws the real blur.** C3's diagnostic hid the screen-texture items and
  patched gap 2. It reached 30.81-31.20 dB. With the blur drawn for real (`lod` 5 over the gaussian
  chain), the menu is 31.06-31.16.
- Without P3-CT, the native menu stays at 2.97: the blur faithfully reads the white spines.
- The native combat numbers are P3-CT's (26.2 on a8-2). This fix leaves them unchanged.

**The GSW gap on this recording (for P3-CT).**

- Every canvas-texture diffuse in `p3st-a8-1` stays unfetched in GSW, for example the combat
  atlases 1975, 1977, 1979 and 1981. GSW uploads 84 textures here, against 92 on a8-2.
- The same bundle replays a8-2's combat byte-identical to P3-CT's `p3ct-gsw` shot (seq 1789).
- A bundle built from main `c780d463`, without P3-ST, gives the same bytes on `p3st-a8-1` as this
  fix's bundle. So the recording, not this change, makes the difference.
- The native receiver fetches the same diffuses.
- The cause is not diagnosed here: it is P3-CT's residency path, and this recording is its new
  reproducer.

The capture carries the five `hint_screen_texture` shaders the recording names `ok`. In the
replayed span, GSW transpiles all of them but `ed56752c`, which uses `vertex()`, a typed
`gsw-shader-transpile`, so GSW drops its items. The ones it transpiles include the menu's blur,
`16909a22` (`texture(SCREEN_TEXTURE, SCREEN_UV, lod)`).
One more screen reader also reads `TIME`: it is refused `shader-time` and dropped on every
receiver.

## Validation

These ran on the tree rebased onto P3-CT (`60ee7c89`). After the final rebase onto P3-CAP
(`2b69624d`, which reworks the capture's per-frame snapshot), three runs were re-run locally and
passed: `capture-build` (ctest 30/30), native gate 5.5 (`g55s` 7/7 included) and native gate 8.

- **Remote, full tier** (run `40192449534`, base `60ee7c89`): 20 of 21 runs passed. Among them:
  - every reached native gate, -1 to 5, 5.5 and 8, with sabotage legs (gate 5.5 includes `g55s`
    on llvmpipe);
  - the cargo and pnpm tests;
  - `g7-web-rust`, and `g7live-gsw` / `g7live-web-rust` (`g7-55`'s live half runs `g55s` in both
    browsers).

  `g7-gsw@g7-55` failed on `shader-transpile-set@gsw`. Its prediction counted every
  `shader_scan` entry without a reason, so the `refused` variant's now-`ok` screen shader was
  expected on the base-scene legs. Fixed in `gate7-gsw-55-checks.ts` (variant-only shaders are
  excluded). `g7-gsw` was then re-run remotely: all nine groups passed (run `40197756458`).
- **Local, the runs the remote refuses:** `lock-tests` passed. `g7live-gsw` and
  `g7live-web-rust` passed on group `g7-1`. `g7-gsw` on group `g7-55` passed after the fix.
  - `compositor-equals-readback:shader@gsw` fails there, but it is not this increment's: the
    `PH` material's version changes every frame, so the last shot's state can never equal the
    exit state.
  - The verdict excuses it (`rc=0`), so it is not gating.
- **Deferred to the milestone sweep:** native gate 6, the `g7live-*-timing` runs and `g7x`.
- **Also run:**
  - `make-features --protocol 8 --check`, `self-test-gate8z` 41/41;
  - `pnpm typecheck` and `typecheck:ts6`;
  - `tsc` on `experiments/render-stream` (only the known `gate2b`/`gate8-cache`/`g8kv` errors);
  - biome on the changed TypeScript;
  - `build-capture.sh` (ctest) and `build-rs-core-ext.sh` (replay tests).
- **Not run:** `bench-instr` locally (no valgrind; the remote job produced it).

## Evidence

`artifacts/render-stream/p3/p3-st/` (main checkout). It holds:

- the g55s runs (native, web, GSW: result.json and shots);
- the STS2 compare.json and contact sheet.

The game-derived frames stay in sts2-couch-coop's research folder, `legs/p3st-a8-1/`.
