# MX: render-stream vs couch-coop's node-geometry mirror on STS2 (2026-10-28)

The question: is interception at the RenderingServer the cheapest way to get the game to a
browser? MX measured both paths on the same STS2 scenes (menu, map, combat), warm, on the same
machine and in the same seat-shaped process. The paths:

- **render-stream** (RS): /11, base-prefix zstd coded (the default), one live GSW viewer.
- **The node-geometry mirror**: couch-coop's scene-delta stream, rendered by its frontend over this
  repo's `html` packages.

**Bottom line: the claim does not hold as stated.**

- **The mirror is cheaper on every cost axis.** On host time, warm idle, it costs 0.2–2.4 ms of
  main thread per frame, against RS's 2.7–9.1 ms. On the wire it sends 0 to 0.43 Mbps, against
  RS's 0.15–11.9 Mbps.
- **As shipped, its seat runs the idle game at 8 fps.** The whole process uses 0.15–0.19 cores,
  against about 1 core for the RS streaming seat in combat.
- **It buys this by not reproducing pixels.** It does not send what moves: spines, particles and
  shaders. The client replays or approximates them, and it needs a per-game semantic model.
- **The claim holds in a narrower form:** RS is the cheapest of the paths that reproduce *any*
  Godot game pixel-exactly.
  - **Wire:** 0.15–6 Mbps idle and 12 Mbps in an active turn, below 1080p60 video's 15–25 Mbps.
  - **Client:** 0.6–2.2 ms per frame in the browser, with no video decode.
  - **Host:** not cheaper than video. RS costs 3–9 ms of the game's main thread per frame. NVENC
    costs 1–3 ms of a GPU engine, off the game's CPU.

## Side by side

All rows are warm: the first 3 s after a viewer connects are dropped, and 20 s are measured.
"Main-thread" ms are on minus off for the game's main thread, at 60 fps. Two legs per arm are
given as `leg 1 / leg 2`.

| scene | **RS** host ms/frame | **mirror** host ms/frame | RS wire, coded (raw) | mirror wire (JSON) | GSW client ms/update (p95) | mirror client ms/update | fidelity vs in-process reference |
| ----- | ----------------- | --------------------- | -------------------- | ------------------ | -------------------------- | ----------------------- | -------------------------------- |
| menu ¹ | 2.7 / 3.7 | 0.95 / 0.93 | **0.43 Mbps**, 59 msg/s | **0**, 0 msg/s | 0.61 / 0.68 (0.8–1.0) | — (no deltas) | GSW 30.6–30.9 dB ² · mirror ≥ 24.9 dB ³ |
| map | 6.4 / 6.2 | 2.35 / 2.39 | **0.155 Mbps**, 59 msg/s (5.0 Mbps) | **0.009 Mbps**, 1 msg/s | 0.97 / 1.04 (1.3) | 32 deltas / 30 s | GSW 65.5 dB · mirror ≥ 19.3 dB |
| combat, idle | **9.0 / 8.9** | 0.21 / 0.34 | **5.9 Mbps**, 59 msg/s (37.6 Mbps) | **0**, 0 msg/s | 2.20 / 2.20 (2.8) | — (no deltas) | GSW 44.3–47.1 dB · mirror ≥ 18.9 dB |
| combat, active (one end-turn) | 8.8 / 9.4 | 3.1 | **11.9 Mbps**, 59 msg/s (≈ 80 Mbps) | **0.43 Mbps**, 21.6 msg/s | 2.14 / 2.09 (2.6–2.7) | 3.0–3.1 script ms/delta; 6.9 % frames dropped (GPU) | — |
| game fps, path on / off | 58.6–60 / 60 | 59.3–60 / 60 | | | | | |

1. With the seat flag every arm's "menu" is the seat's "Choose Friend to Join" screen, not
   C3's main menu (see Method). That is why RS's menu is 0.43 Mbps here, against W11t's 0.53.
2. The GSW fidelity figures are W11c's (`w11c.md`), from the same fixtures at /11.
3. The mirror figures are a **lower bound**. The replay ran with the game down: no static
   background (502) and no spine stills (404), so creatures are red placeholders
   (`artifacts/render-stream/p3/mx/client/sheet-ref-vs-mirror.png`).

- **Keyframes on connect or scene entry.**
  - The mirror sends a full JSON scene: menu 859 KB, map 1.79 MB, combat 1.97 MB. Under zstd-3
    those would be 46, 98 and 112 KB. Assets come separately over HTTP.
  - RS sends its full transaction, plus texture payloads over HTTP. The cold viewer fetched 80 GETs
    (392 MB) over the whole route.
- **Raw RS.**
  - Over both legs the coded wire is 1/7.1 of the uncoded messages (573.6 MB in, 80.5 MB sent).
  - Per scene, the raw figures in parentheses are W11t's for the same fixtures: map 10.5 KB and
    combat 78.4 KB per frame.
  - No tap ran, because a tap would load the timed host (gate 6 D11).
- **Mirror compression.** The mirror ships plain JSON text frames: no permessage-deflate, no zstd.
  The active turn's 53.8 KB/s would be:
  - 16.1 KB/s under per-message zstd-3;
  - 15.2 KB/s under per-message deflate;
  - 4.5 KB/s under context-takeover deflate (permessage-deflate's default).
- **The map's mirror delta** is one 1.1 KB upsert a second: the run clock in the top bar.

### The production mirror seat (`mx-mirp-1`)

The rows above give the mirror the same unsuspended, animated scene RS gets. A shipped mirror seat
also installs CouchCoop's visual suspender: it freezes the decorative animators, spine and particle
simulation, and throttles `Engine.MaxFps` while idle.

| mx-mirp-1 | menu | map (viewer on) | combat idle | combat active |
| --------- | ---- | --------------- | ----------- | ------------- |
| game fps | 8 | 59 | 8 | 46 |
| whole-process CPU, ms/s | 154–391 | 439 | 163–193 | 586 |
| mirror wire | 0 | 1 msg/s, 1.1 KB/s | 0 | 19.9 msg/s, 0.42 Mbps |

At idle the whole seat (game, walk and all) costs 0.15–0.19 cores. The RS streaming seat's process
in combat costs 0.93–0.97 cores. Production seats run `--headless` (no GPU rendering); MX rendered
on the GPU in all arms.

## Where each path's cost goes, and what it scales with

- **RS host: about 9 ms a frame in combat, all on the game's main thread.**
  - The capture's own histogram over each whole leg: frame callback mean 7.0 / 7.4 ms, p95
    9.7 / 10.2 ms. Of that, snapshot is 3.2, diff 0.8, encode 0.09 and zstd about 0.25.
  - The per-call RS hooks run outside the callback and make up the rest of the on/off delta. So
    the 5.7 ms "host capture" figure in the brief understates the full host cost by about 3 ms in
    combat.
  - Perf's inclusive attribution to `librender_stream_capture.so` gives 4.9–10.8 ms. That is an
    upper bound: an interposed call's stack includes the engine's own work underneath it.
  - The leaf symbols are `memcmp` and `_Rb_tree_increment` under `Mirror::snapshot`. The
    snapshot and diff walk every canvas item every frame.
  - So **RS host time scales with item count** (the static map still costs 6.3 ms), and **RS
    wire scales with draw-state churn**:
    - the map is 0.3 KB a frame;
    - idle combat is 12.4 KB a frame, because spine meshes and particles change every frame;
    - an end-turn doubles it.
  - Neither scales with pixels. Making RS's host cost follow churn rather than item count would
    take dirty tracking at hook time; that is a design option, not measured here.
- **Mirror host: Spirectl's scene watcher on the main thread, at 100 Hz.** Inclusive of the
  engine getters it calls, and unchanged across the two legs:
  - menu: 6.5 / 6.9 ms/s;
  - map: 152 / 154 ms/s;
  - combat: 54 / 50 ms/s;
  - active combat: 178 ms/s.

  Its cost scales with **watched node count and semantic changes**, not with what animates:
  - The map, with 2,826 nodes, costs 2.4 ms a frame for one delta a second.
  - Combat, with 3,116 nodes but hidden subtrees skipped, costs 0.2–0.9 ms.
  - Spine and particle motion is never sent, so it costs nothing.
  - JSON serialization runs on the thread pool and is negligible warm.
  - The menu's on/off delta (0.9 ms) is higher than its attribution (0.1 ms): the window holds
    post-keyframe .NET work (thread-pool and finalizer time).
- **Video, for reference:** encode time scales with pixels, and bitrate with motion. NVENC 1080p60
  costs 1–3 ms on the GPU and 15–25 Mbps whatever the scene.
- **Clients.**
  - **GSW** applies every host frame. It costs 0.6 ms a frame in the menu, 1.0 ms on the map and
    2.1–2.2 ms in combat (decode about 0.9, apply about 0.9, draw 0.3). It kept up with 93–100 %
    of host frames (55–60 applies/s against 58.6–60 host fps).
    - Its wasm heap was 760 MB at the end, mostly texture residency, as in W11c.
  - **The mirror** does nothing between deltas, apart from its client-side animation loops.
    - In the active turn, each of the 494 deltas costs 3.0–3.1 ms of script (DOM reconcile).
    - The main thread was 24.5 % busy on the GPU and 34 % in software.
    - It dropped 6.9 % of frames on the GPU and 13.7 % in software, with 10–11 long tasks of up
      to 164 ms per repeat.
    - JS heap 62–76 MB.
    - The map replay on the GPU was anomalous: 90 % busy and 10–43 % of frames dropped across the
      repeats, against 24 % busy and 0.6 % dropped in software. Both are reported; MX did not
      chase it.

## Fidelity

GSW holds pixel parity with the game: 44–47 dB in combat, where the remainder is the known
multimesh and particle gaps, and 65.5 dB on the map (W11c).

The mirror, by design, does not show:

- **Spine skeletal animation.** It shows host-baked stills by default (`spineMode` static);
  geoclip clips play only in dynamic/auto mode.
- **Shaders and particles.** The product default is one frozen frame per surface (`STATIC`); with
  effects off they draw nothing, apart from baked stills for a few effects.
- **Decorative loops** (orb spin, intent bob, top-bar icons). They are not streamed; the client
  replays its own version.
- **The background.** It is flattened to a host-rendered raster.
- **Text and layout.** Text is set in browser fonts, and the layout is adapted for phones (a
  wider legend and spread hands; see the contact sheet).

MX's PSNR of the mirror replay against the in-process reference was 24.9, 19.3 and 18.9 dB
(menu, map, combat). Those figures are a floor, from the replay's missing background and stills.
A live mirror page against the running game would fetch both, but it would also load the timed
host with asset serving, so MX did not run one. The mirror also needs a per-game model; RS needs
none.

## Method

- **Same process shape in every arm.**
  - The same private farm (binary sha-identical to the install), C1's couch-coop e86f9405 build,
    and the same calibration (`…m12.ck.json`).
  - Run under `gamescope --backend headless` at 1920×1080, GPU-rendered.
  - Seat flag `COUCHCOOP_HEADLESS_CLIENT=1`. Since couch-coop 8ba929e9 (2026-10-16), a host's
    browser access requires a multiplayer lobby or run, and C3's fixtures are singleplayer. A
    seat's access is always allowed, and the seat is the process the product actually streams
    from.
    - Side effects in every arm: FMOD audio off, joypad bindings removed, and the
      "Choose Friend to Join" screen as the menu.
  - Also in every arm: `COUCHCOOP_HEADLESS_PROFILE=1` (1 Hz fps/cpu), `DOTNET_PerfMapEnabled=1`,
    `GRC_HOOK_LOG=off`, and no file sink.
- **The arms.**
  - **RS:** the streaming seat (`COUCHCOOP_STREAMING_SEAT=1`), armed /11 live, coding on, one
    GSW viewer (window 2). It disarms at frame 14000, after the active window.
  - **mirror:** the same streaming seat with the capture loaded *unarmed* (`GRC_MODE=validate`:
    no vptr store, engine untouched). The visual suspender stays off, so the scene animates
    exactly as in the RS arm. A passive `record-mirror-stream.mjs` viewer (`staticBg=1`, the
    product default) connects per scene.
  - **mirp:** not the streaming seat (no capture), so the suspender and texture evictor are
    installed as on a shipped seat.
- **Windows.** The route is menu, map, combat at 60 s each:
  - off [6, 21) s, viewer warm [21, 24), on [24, 44), perf [44, 53);
  - then an active window: one `sts2 act end-turn` (the second, 10 s later, was refused by the game
    in every leg: the enemy turn was still running);
  - for RS, post-disarm off and perf windows in the same combat.
- **Host measurements.**
  - Main-thread and process ms: `/proc` task ticks, sampled at 1 Hz.
  - Wire bytes: `ss -tni` `bytes_sent` on each path's server port, which counts exactly what TCP
    carried; the RS figures match W11t's to within 2 %.
  - Perf: `perf record -g -F 499 -p <game>`, attributed with
    `scripts/perf-attribute.py`. It resolves .NET JIT frames through the perf map by IP, because
    .NET's W^X double mapping puts JIT code in a memfd that perf never matches to the map.
- **Clients.**
  - GSW: the live viewer's per-transaction timeline, mapped to the windows through the capture's
    frame timeline.
  - Mirror: couch-coop's `bench-mirror-replay.mjs` replaying MX's recordings:
    - recorded pace, 1920×1080 at DPR 1, 3 fresh-page repeats;
    - real assets from the extracted resource root, effects off (the bench default);
    - the same pinned Chromium 1223 as GSW, in software and on the GPU (ANGLE Vulkan, as GSW's
      harness runs);
    - served from couch-coop main's frontend through a scratch Vite config, which keeps Vite's
      cache in the research dir.
- **Load and noise.** Each leg started at a 1-minute load below 4.
  - The mirror legs ran at 1.2–3.8.
  - The RS legs ran at 4–6.6, from bursts by another repository's test suite. GSW's quiet lock
    cannot see it.
  - The headline RS combat delta is taken against its own post-disarm window, so it does not
    depend on cross-leg load: 9.03 and 8.90 ms. The wire repeated to within 2 % (743 and 729 KB/s).
  - The perf-window attribution varies 15–30 % between legs.
  - fps is capped at 60 by vsync, so it hardly separates the arms; main-thread headroom does. The
    game alone uses 5–6.7 ms of main thread a frame, and RS combat takes it to about 15 of the
    16.7 ms budget.

## Validation

The diff (this doc, `scripts/perf-attribute.py`, its `smoke-map.json` rule) reaches only the pure
self-tests: `validate-increment.sh --tier full` passed 1/1 (`pure`, 1,657 s at load 12–17).

## Evidence

- `artifacts/render-stream/p3/mx/`, per leg (`mx-{rs,mir}-{1,2}`, `mx-mirp-1`):
  - `analysis.json`, the per-window numbers;
  - `attr-*.json`, perf attribution;
  - capture and GSW `perf.json`, `live-summary.json`;
  - steps, notes and hash compares.
- `mx-summary.txt` holds the cross-leg deltas.
- `client/` and `client-gpu/` hold the mirror bench `BENCH_RESULT`s, `psnr.json` and the contact
  sheet.
- `harness/` holds copies of the leg scripts (`mx-leg.sh`, `mx-hook.sh`, `mx-driver.py`,
  `mx-analyze.py`, `mx-client.sh`, `mx-vite.config.mts`). They live in couch-coop's ignored
  research dir `.sts2/research/render-stream-p3-20261025/c3/harness/`; the exact leg command is
  `bash mx-leg.sh <leg> <rs|mir|mirp>`.
- Every leg's hashes came out unchanged:
  - Steam remote store;
  - operator profile;
  - install binaries and mods;
  - the mod build.
- Every leg ended `survivors: none`. Each game ignored TERM for 25 s and was KILLed by pid, as
  in C3.
