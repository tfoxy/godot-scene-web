# HSD: a headless streaming seat streams spines (2026-10-29)

MIR-3's live leg (couch-coop 63a36493, leg `mir3-2`) put the product's streaming seat in front of
a browser viewer for the first time. The seat streamed the HUD, cards and room backgrounds, but no
creature in combat and a black character-select screen. The GPU-rendered C3 and W11z legs had
streamed both. HSD bisects the differences, fixes the cause generically in the capture, and
checks the fix on a stock 4.5.1 fixture and on the game.

## Cause: the seat's dummy renderer, through `CanvasTexture`

**The bisect.** One difference was changed at a time, on C3's harness. Leg A is GPU-rendered;
legs B and C add only `--headless`. Everything else is fixed:

- the a12 environment, which is the seat's table: `/12`, `GRC_ADOPT=arm`,
  `GRC_UNKNOWN_ITEM=skip`, `GRC_TEXTURE_DECODE=engine`, two workers,
  `presentation:1920x1080`, the raised caps, the float formats, inline 4096 and
  `GRC_MESH_DYNAMIC=auto`;
- the arm at mod init;
- a single-player instance;
- the native file-replay receiver;
- the same capture build, the same MIR-3 mod build (6982c47a) and calibration
  `sts2-megadot-4.5.1-m12.uit.json`.

Route menu → act-1 map → act-1 combat (C3 fixtures), 4,200 frames each:

| leg | host | `add_mesh` at the end | unsupported (tx count) | canvas textures |
| --- | ---- | -------------------- | ---------------------- | --------------- |
| `hsd-rend` | GPU-rendered | 102, all ok | `non-root-viewport` 7 | 22 ok |
| `hsd-hoff` | `--headless`, the three compensations off (= the seat before HSD) | **104, all `canvas-texture-headless`** | `canvas-texture-headless` 6,587, `unknown-particles` 387 | **none** |
| `hsd-hon` | `--headless`, HSD defaults | 104, all ok | `non-root-viewport` 10, `unknown-texture` 1 | 22 ok |

`--headless` alone reproduces MIR-3 exactly:

- no creature in combat;
- a black main menu, whose background and logo are spines too;
- in the live seat, a black character-select room (`char_select_bg_ironclad.tscn` is one
  `SpineSprite`).

So the other four differences are not the cause:

- the seat's environment table (it equals C3's a12);
- the arm timing (both arm at mod init, and `max_withheld` is 0 on every leg);
- multiplayer;
- GSW live against file replay.

**The mechanism.** STS2 loads spine-godot as a GDExtension (`libspine_godot…so` in the install).
Every `SpineMesh2D` draws `canvas_item_add_mesh(…, texture = <its atlas page's CanvasTexture>)`.
Godot's dummy rasterizer, which `--headless` selects, returns `RID()` from
`canvas_texture_allocate` (`servers/rendering/dummy/storage/texture_storage.h:54`). So every
`CanvasTexture` on the seat is the null RID, and the capture refuses every draw through one as
`canvas-texture-headless`. That is the G2d rule plus gate 5's D11, and it is correct: `RID()`
cannot be attributed. The fix for that already existed as an opt-in, the canvas-texture shim
(`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`, 2026-10-10, criterion 5 run on STS2). The particles
shim and the pre-draw pump from PM5 are opt-ins of the same kind. The seat's table
(`StreamingSeatLaunch.Environment`) set none of them, and nothing passes extra `GRC_*`
variables through to the seat.

**Hypotheses the brief listed, ruled out:**

- **The dummy keeps no mesh data.** It does keep it: dummy `mesh_storage.h` `mesh_add_surface`
  copies every buffer. The capture also never reads surfaces back. It takes `mesh_add_surface` and
  every `mesh_surface_update_*_region` from the hook arguments (`hooks.cpp`).
- **spine-godot skips mesh generation headless.** It does not. `hsd-hoff` has the same 104
  `add_mesh` commands as `hsd-hon`, each with its surfaces; only the texture is refused.
- **Dummy textures have no data for `GRC_TEXTURE_DECODE=engine`.** They have it: 1,548 ok images
  on every leg, the same count headless and rendered.
- **`RS::draw` never runs.** That holds, and it matters for `frame_pre_draw`, not for spines.
  CPUParticles2D buffers and AnimatedTexture frames come from `frame_pre_draw`, which is PM5's
  pump. `unknown-particles` (387 tx) is the GPU particles' `RID()`, which is PM5's particles shim.
  The shader clock already uses the tree delta on a headless host (P3-CK). HSD turns the pump and
  the particles shim on together with the canvas-texture shim.

The seat can supply the data, so no real renderer is needed offscreen.

## Fix: the headless compensations are the default at /12+

`GRC_HEADLESS_CANVAS_TEXTURE`, `GRC_HEADLESS_PARTICLES` and `GRC_PREDRAW_PUMP` accept `auto`, and
unset means `auto`. `auto` turns all three on exactly when the display server is `headless` and
`GRC_STREAM_VERSION` is at least 12. In every other case, and whenever a value is given
explicitly, the behaviour is the same as before (render-stream-12.md "Headless defaults (HSD)"):

- **A rendered host** never resolves anything on, so its wire is unchanged.
- **A headless host below /12**, which covers every gate leg up to gate 8's /11 and every
  golden, is unchanged byte for byte. That is why there is a version gate: those legs still
  test the refusal.
- **The product seat runs /12**, and /13 inherits the default, so the seat needs no couch-coop
  change.
- **`off`/`0` restores the refusal.**

Code:

- `rs_canvas_texture_shim.{h,cpp}`: `headless_defaults_apply` and `resolve_headless_default`,
  with 17 new ctest cases;
- `entry.cpp` `attempt()`: the resolution and its log line;
- `result.json` `canvas_texture_shim.default`.

## Generic fixture and checks

The fixture is g8c's `fixtures/gate8-ct`, which is the spine shape: an `add_mesh`, a `Polygon2D`,
sprites and a `TextureRect`, each drawn only through a `CanvasTexture`. HSD adds two **headless**
/12 captures of it, plus the /12 native receiver on each.

- **`ct-headless-seat`.** The defaults arm the shim by themselves (`default: true`, 8 private
  RIDs). The receiver on the full sink and on the patch sink equals the receiver of the rendered
  host's capture at both checkpoints, **0 px different**.
- **`ct-headless-off`.** All three are off, which is the pre-HSD seat. Every cell stays the clear
  colour (24,576 px = the 6 drawn cells of 64×64 differ from the rendered receiver). The checker
  confirms the control catches the bug.
- **g8pt.** `headless-shim` and `headless-pump` now take the defaults, so `pt-shim` and `pt-pump`
  judge the default. The `headless` and `headless-nopump` controls set all three off explicitly,
  so `headless-nopump` stays the /11 byte-identity witness.
- **`self-test-gate8-ct`** gains `headlessShimProblems`: 31/31.

## STS2 before and after

- **Bisect replays** (native receiver; PSNR against the rendered leg's own GPU reference shot, so
  across runs and animation phases):
  - combat: 23.0 dB before, **31.6 dB** after;
  - menu: 12.4 dB before, **34.9 dB** after.

  The rendered leg against its own reference is 56.2 dB in combat and 41.0 dB in the menu. That is
  the same-frame ceiling; the cross-run numbers carry pose and particle phase differences.
- **Live, on the real seat.** This is the MIR-3 harness, leg `hsd-mir3b`: a host-spawned
  `--headless` streaming seat, the product's own env table, and a GSW viewer in pinned Chromium.
  - The Ironclad character-select room is present.
  - The map is unchanged; it was already right.
  - Both Ironclads and the enemy are in combat.
  - The viewer applied 59.9–60 tx/s and 180 applies/s; combat ran at 8.4 Mbit/s (3.4 before HSD,
    when no spine streamed).
  - Seat evidence `result.json`: `canvas_texture_shim {env: synthesize, default: true, state:
    armed}`.
- **Pictures:** `artifacts/render-stream/p3/hsd/` holds the MIR-3 before/after/reference sheet and
  the menu and combat bisect sheets. These are ignored, game-derived frames. The leg data is in
  couch-coop `.sts2/research/render-stream-p3-20261025/{c3,mir3}/legs/hsd-*`.
- **Hygiene:** steam-remote, profile, install and mod hashes were unchanged on all four launches,
  and no game process survived any leg.

## Harness changes (couch-coop research, ignored)

- C3 `run-leg.sh`: `C3_HEADLESS=1` runs `--headless` instead of GPU-rendered.
- MIR-3 `common.sh`/`driver.mjs`: `MIR3_WT` defaults to couch-coop main, because the mir-3
  worktree is gone.
- The map vote needs `act mouse click` in `--mode dangerous`. `select-map-node` answers
  "screen: null" on a co-op map.

## Validation

- **Smoke, local** (`validate-increment.sh --tier smoke`, before the W13b rebase): 22 of 24 runs
  pass, and the other two do not bear on HSD. `lock-tests` failed one quiet self-test at load 10
  and passed on rerun. `bench-instr` cannot run here because valgrind is absent, so it ran remotely.
  - gate 8: 242/242, including `ct-headless-seat`, `ct-headless-off`, `pt-shim` and `pt-pump`.
  - gates −1 to 5.5 and hc1 pass.
  - The gate 6 timing run passes.
  - The g7 representative legs pass.
- **Smoke after the rebase onto W13b** (`capture-build`, `pure`, `native-rust-gate8`): gate 8
  passes 259/259, including W13b's `w13-file-equiv` and `w13-file-equiv-g8pt`. g8pt's /13 twins
  (`headless-shim13`, `headless-pump13`) now take the defaults like their /12 twins.
- **Full tier, remote:** run 40947044102, 22/22 pass, with the shadow oracle on and the
  `bench-instr` drift at +0.03 to +0.69 %. The planner refuses some runs remotely:
  - `lock-tests` passed locally;
  - g7-1 live legs: their smoke legs passed locally;
  - gate 6 and the other timing runs: gate 6 passed in the local smoke.
