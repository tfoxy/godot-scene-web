# CG4: STS2 at render-stream/10, canvas groups on the real game (2026-10-27)

**The native receiver now draws STS2's HP bars as the game does.** One a10 game leg (menu, map,
combat) at `/10`, recorded with a recalibrated STS2 record, carried the game's canvas-group and
back-buffer state. Replayed natively, the five combat HP bars went from **14.92 dB to 56.3 dB**:
0 pixels over 16, against 4,345 before. Whole-frame combat went from 32.6-33.8 dB (P3-TM) to
**37.3-43.2 dB**. GSW still types the state as unsupported, so its "before" is unchanged until
CG3 lands. The web export matches native within 1 on menu and map. It cannot replay combat: the
store it stages up front does not fit its 2 GiB heap (gap 2).

No GSW code changed. This commit is this result doc. The harness changes are in couch-coop's
ignored research folder (step 2 below).

## Calibration

`calibrate.py --version-name MegaDot` ran offline against the installed `SlayTheSpire2` (sha256
`0c21999e…`, read only, never executed) and the pinned 4.5.1 `rendering_server.h`. It wrote
`calibration/sts2-megadot-4.5.1-m12.cg4.json` in couch-coop's research folder:

- 588 slots = prefix 23 + 565; anchors 17/17; calibrator 9.
- It is identical to `…m12.p3.json` except for two new keys: `canvas_item_set_copy_to_backbuffer`
  484 and `canvas_item_set_canvas_group_mode` 495. Both equal the pinned template's slots, as CG1
  predicted.
- STS2 records are game-derived and were never committed (GSW commits only the stock template's
  record), so the new one stays in the research folder.

## Harness (`analyze.mts` and the a10 mode)

The C3 harness lives only in couch-coop's ignored research folder
(`.sts2/research/render-stream-p3-20261025/c3/harness/`). GSW has no committed copy, so it was
fixed there. Its README has a "CG4 additions" section:

- **The magic digit.** `analyze.mts` and `dump-items.mts` read magic byte 3 as `data[3] - 0x30`,
  which reads `GRSA` as version 17. Both now parse it as a hex digit and refuse anything outside
  8-15. `analyze.mts` also reports `session.features`, `session.capture` and a `/10` census.
- **`a10` is now a harness mode.** P3-TM's private copy is gone. `run-leg.sh a10` sets
  `GRC_STREAM_VERSION=10`, `GRC_RESOURCE_FORMATS=L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH` and writes
  `recording-patch.rs10`.
- **Environment overrides.** The harness hard-coded P3-TM's vanished scratch root.
  - The root, mod build, calibration, port, owner and lease game resource now come from the
    environment. The defaults are unchanged.
  - `seed.py` refused the first attempt (`cg4-a10-1`) before writing anything, because its
    ownership root was still hard-coded. It now follows `C3_ROOT`.
- **New scripts:**
  - `replay-web.sh`, the web-export replay;
  - `hpbar.py`, the HP-bar crops;
  - `cg4-gsw-after.sh`, the GSW "after" replay (below).

## The leg (`cg4-a10-2`)

- **Lease:** `live-qa-lock.mjs with --owner cg4-p3 --resource shared:install --resource
  exclusive:game:p3-sts2 --resource exclusive:port:13777`. It is the outermost wrapper, so it is
  taken before any quiet lock. The exact command is in `artifacts/render-stream/p3/cg4/leg-cmd.sh`.
- **Isolation:**
  - a private farm, with the binary copied byte-identical and C1's couch-coop `e86f9405`
    streaming-seat build rebuilt into the scratchpad with `build-local-mod.sh --output`, not
    deployed;
  - a private `XDG_*`;
  - `gamescope --backend headless`;
  - the capture built from GSW `3e152862`.
- **Lifecycle:** the capture disarmed by frames (5000). TERM was ignored for 25 s, so the game was
  KILLed by pid from the EXIT trap. The leg ended with `survivors: none`. No SlayTheSpire2,
  crashpad or gamescope process of ours remained, and nothing was pkilled.
- **Hashes:** all five sets (Steam remote, operator profile, install binaries, install mods, mod
  build) were unchanged. Nothing was written under `~/.steam`, and nothing was deployed into the
  install.
- **Route:** ready in 18 s; menu, map and combat, with 3 reference shots each.

## Census (the recording, 4941 transactions, all `ok`)

- **Features.** `session.capture.hooks_planned` includes both `canvas_item_set_canvas_group_mode`
  and `canvas_item_set_copy_to_backbuffer`, and `hooks_omitted` is empty.
  - `features.unobserved` lists neither (16 methods remain).
  - P3-TM's leg, with the old record, listed both.
- **Wire:**
  - 79 `canvas_group` item entries in 14 transactions, from seq 1 (the adoption);
  - one `copy_to_backbuffer`.
- **Resolved state at the combat shots:**
  - 30 `transparent` groups;
  - 10 `clip_only` and 5 `clip_and_draw` visible items, which are the five HP bars: per bar, the
    clip-only container and mask and the clip-and-draw `HpForeground`. These are exactly
    P3-NP's item roles;
  - 6 hidden clip items;
  - one visible full-target `copy_to_backbuffer`.
- **On the menu:** 9 hidden `clip_only` and 4 hidden `clip_and_draw` items.
- **Shaders:** 65 `ok` and 7 `shader-mode`, as in P3-TM.
- **Unsupported, unchanged:** multimesh (33), particles (9) and 5 `unsupported-material`.

## Per-scene fidelity

Reference: the in-process root-viewport readback.

- The recording was cut after the last shot, at seq 2847 (`cg4-cut.rs10`), and replayed with GSW
  `3e152862`:
  - native: stock 4.5.1 template, opengl3, Rust core;
  - GSW: canvas bundle, `rs_core_build sha=3e152862540a`, served bundle sha256 `98f31208…`, port
    13891;
  - web export: Rust core, `web_dlink_nothreads`.
- Each cell is the min-max over the scene's three shots.
- P3-TM's row is a different recording of the same route, so its shots pair by step, not by frame.

**PSNR (dB):**

| scene | P3-TM native / GSW | CG4 native | CG4 web export | CG4 GSW (before) |
| ----- | ------------------ | ---------- | -------------- | ---------------- |
| menu | 31.17-31.43 / 31.20-31.47 | 31.34-31.89 | 31.38-31.92 | 31.38-31.93 |
| map | 64.14-64.17 / 65.51-65.53 | 64.08-64.21 | 65.55-65.63 | 65.47-65.56 |
| combat | 32.57-33.84 / 32.58-33.85 | **37.25-43.22** | not run (gap 2) | 32.60-33.78 |

**% of pixels over 16, and max delta:**

| scene | P3-TM native | CG4 native | CG4 web | CG4 GSW (before) |
| ----- | ------------ | ---------- | ------- | ---------------- |
| menu | 7.88-8.45 %, 123 | 7.64-8.17 %, 124 | 7.64-8.15 %, 124 | 7.62-8.14 %, 124 |
| map | 0 %, 3 | 0 %, 3 | 0 %, 3 | 0 %, 3 |
| combat | 0.60-1.53 %, 228 | **0.21-1.34 %, 102** | — | 0.53-1.54 %, 228 |

- **Web against native:** within 1 on all six menu and map shots (57.0-66.3 dB, 0 pixels over 16).
- **Where the combat gain comes from.** On combat-1 (an 8x8 grid of pixels over 16), native
  removes every GSW-before error in the HP-bar band (y 675-810: 4,345 px, exactly the bar count
  below). It also removes most of them in the hand-card band below it (2,541 to 316 px). Every
  other cell is within a few pixels.
- **What remains in combat is not group state.** The lower combat-2/-3 numbers are P3-TM's
  undiagnosed card-glow `TIME` phase. The other residuals are the known multimesh and particles
  gaps.

## HP bars

Five bar rows at y 772-794 (x 374/1069/1321/1562/1762), 23,188 px. The stats are on the union, per
combat shot. The /9-style output is P3-TM's `p3tm-a10-2` replay: a /10 recording made with the
old calibration record, so it has no group state. Its bar rows match this leg's reference to within
1 per channel, except one row in combat-3.

| receiver | PSNR (dB) | px over 16 | max delta |
| -------- | --------- | ---------- | --------- |
| /9-style native (p3tm-a10-2) | 14.92 | 4,346-4,360 (18.7-18.8 %) | 228 |
| /9-style GSW (p3tm-a10-2) | 14.92 | 4,345-4,359 | 228 |
| **CG4 /10 native** | **56.3 / 56.3 / 50.2** | **0 / 0 / 24** | **2 / 2 / 30** |
| CG4 GSW (before, typed `gsw-canvas-group`) | 14.92 | 4,345-4,359 | 228 |
| CG4 web export | not measured (gap 2) | | |

- **combat-3's 24 px** are all in the third enemy's crop (1562), at 43.5 dB. The other four bars
  are 56.0-56.6 dB with a max delta of 2.
- The two references themselves differ by up to 30 in that crop, so the residual is animated
  content passing the crop edge, not the bar.
- Visually, the native bar has the pointed caps and thin fill. The /9-style and GSW-before bars are
  square and full height, with the background tip showing. Crops:
  `artifacts/render-stream/p3/cg4/hpbar/combat-{1,2,3}.png`, where each bar shows reference,
  /9-native, /9-GSW, /10-native and GSW-before at x4.

## GSW "after" (for the CG3 resume)

The GSW "before" replay logged 70 `canvas_item_set_canvas_group_mode` (`gsw-canvas-group`) refusals
and 1 `canvas_item_set_copy_to_backbuffer` (`gsw-backbuffer-copy`) refusal. Once CG3 is on main,
run this from any GSW worktree at that commit (after the worktree setup), with a port not used
before:

```bash
C3_GSW=/home/user/repo/godot-scene-web/.worktrees/<wt> C3_GSW_PORT=<new port> \
  bash /home/user/repo/sts2-couch-coop/.sts2/research/render-stream-p3-20261025/c3/harness/cg4-gsw-after.sh gsw-after
```

- **Build.** It runs `build-rs-core.sh`, then `gate7-tool.ts gsw-bundle` into
  `artifacts/render-stream/p3/fidelity-data/cg4-a10-2/gsw-bundle-gsw-after`, and prints the
  bundle sha and `rs_core_build sha=`.
- **Replay.** It replays
  `artifacts/render-stream/p3/fidelity-data/cg4-a10-2/capture/cg4-cut.rs10` with `replay-gsw.sh`
  (store `capture/store`, seqs `1090,1215,1339,1892,2016,2151,2600,2715,2847`).
- **Compare.** It prints the refusal count, the per-scene compare against the reference and
  native, and the per-shot HP-bar stats.
- **Check.** Dry-run on this commit, it reproduced the "before" exactly: every shot equal, HP bars
  14.92 dB.

## Gaps (ranked)

1. **GSW composites no canvas group yet.** This is CG3, in flight. Native shows the ceiling: 56 dB
   on the bars and +4 to +10 dB on combat.
2. **The web export cannot replay a full STS2 combat recording.**
   - **The cause.** `rs_io.gd` stages every store file into MEMFS before `_ready`. This recording
     references 73,825 payloads (1.03 GB, 96 % of them textures) plus the 162 MB recording. With
     the engine, that passed the template's 2 GiB wasm heap after 13 min:
     `Cannot enlarge memory … limit is 2147483648`, then a CowData realloc abort
     (`artifacts/render-stream/p3/cg4/web-full-oom-console.jsonl`).
   - **The menu and map fit.** A cut at seq 2151 staged 16,439 files (996 MB) in 190 s and peaked
     at a 1.72 GB heap.
   - **Pruning cannot help.** Only 121 MB of texture payloads are freed before combat; 867 MB are
     still live there.
   - **The fix is not small.** It needs lazy per-transaction payload fetches (as live mode already
     GETs payloads) or a recording-to-live-host replay, so it stays out of this increment.
   - The web export shares native's `rs-core-capi` planner and matched it on CG1's `g8cg` fixture,
     so its bars are expected to match native. That is not measured here.
3. **`browser-harness.ts` `listFiles` cannot list a store of about 200k files or more.**
   - `out.push(...listFiles(...))` spreads the recursive result into call arguments. Node throws
     `RangeError: Maximum call stack size exceeded` between 120k and 200k entries. The full store
     (288k files) answered `?list` with 500.
   - The fix is a one-line loop. It is tooling-only and moot until gap 2 is fixed, so it is
     reported, not made. CG4 worked around it with hard-linked, pruned stores.
4. **The game's own TERM path** ignored TERM for 25 s again and was KILLed, as in C2's legs. This is
   not a GSW issue.

## Validation

- `validate-increment.sh --plan`: the diff is this doc only, which reaches the `pure` run alone.
  The smoke tier ran `pure`.
- No gate, capture or receiver code changed, so no full tier was needed and none was run remotely.
- The harness changes were checked on real data:
  - the fixed `analyze.mts` on P3-TM's recording: version 10, 2920 transactions;
  - `cg4-gsw-after.sh` as a dry run;
  - the census and every replay above.
- Timing: none (no timing claim is made).

## Evidence

- **`artifacts/render-stream/p3/cg4/` (main checkout):**
  - `hpbar/` (crops and stats);
  - `compare-native-gsw.json`, `compare-native-web.json`;
  - `census.json`;
  - `notes.txt`, `steps.txt`, `grc-lines.txt`;
  - `hashes-compare.txt`;
  - `calibrate.cg4.stdout.txt`;
  - `extension.sha256`;
  - the GSW and web bundle `build.json` files;
  - `web-full-oom-*` and `web-menumap-timings.json`;
  - `leg-cmd.sh`.
- **Replay inputs:** `artifacts/render-stream/p3/fidelity-data/cg4-a10-2/`, ignored:
  - `capture/recording-patch.rs10` and `capture/cg4-cut.rs10`;
  - `capture/store`;
  - the hard-linked pruned stores `store-cut` and `store-cut-map`;
  - `capture/cg4-cut-map.rs10`.
- **Game-derived frames and replays:** couch-coop's research folder, `c3/legs/cg4-a10-2/`.
