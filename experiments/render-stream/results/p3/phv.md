# PHV: the moto g31 as a viewer of a real STS2 co-op seat (2026-10-30)

PHV is the first end-to-end product measurement of the new renderer on a phone. A real STS2 co-op host
(couch-coop main `b944c52b`) launches its headless streaming seat (MIR-3/MIR-4), and the moto g31
(Chrome 156.0.8078.47, Mali-G52 over ANGLE, adb `ZY22FD8XP3`) opens couch-coop's real mirror page as a
player. It turns "Use new renderer (Beta)" on, as a viewer would. A desktop headless Chromium viewer
watches the same seat at the same time. The GSW side is main `a19faccf` (PH3's defaults: credit at
`applied`, apply on message), at /12, credit window 2, W11t `zstd-base`.

**Verdict.**

- **The phone streams the product, after one fix.**
  - On `a19faccf` the lobby fails on the phone. The stage stops with
    `execute: Invalid("texture 36: size 5380x1320")`. STS2's character-select background is wider than
    the g31's `MAX_TEXTURE_SIZE` of 4096, and the `canvas_items` executor refused the whole frame. The
    desktop's limit is 16384.
  - The executor now reduces an oversize upload at upload time, by an integer box filter that fits the
    limit (`fix(canvas)`, below). With it, the lobby, the map and combat all stream on the phone.
  - Nothing is missing in any scene, by eye, against the desktop viewer of the same seat.
- **The phone stays below the bar in the busy scenes, and the cause is drawing, not the stream.**

  | scene | applies/s | frame p50 / p95 | credit RTT p50 / p95 |
  | --- | ---: | ---: | ---: |
  | map | 54–58 | 17 / 29–32 ms | 10–12 / 14–17 ms |
  | lobby | 41 | 23 / 51 ms | 15.6 / 21.7 ms |
  | combat | 38 | 18.5 / 50 ms | 18 / 25 ms |

  - The desktop viewer of the same seat applies 59–60/s in every scene.
  - The phone's main thread is 40% idle in combat. Its frame callbacks take 2.3 ms at p50, yet the
    frames come at 44/s, so the bound is the GPU or the compositor.
  - The client's apply-on-message cap then makes the applies wait for draws, and the credit makes the
    host's sends follow them. The seat runs at 60 fps but sends the phone 38/s, with at most one
    transaction in flight and 50 ms gaps.
  - The stage's canvas backing is the host's 1920×1080. The phone shows it at 1541×866 device pixels,
    so the backing has 1.56× the pixels the panel needs.
  - This is the next increment (see "Next").
- **Recovery works on the phone.**
  - Renderer off/on (unmount/mount) recovers in 9.3–10.4 s to the first drawn frame in combat.
  - A real hidden tab recovers too: HOME for 76–77 s, then Chrome brought back. Android freezes the page
    in the background, so the stage's 60 s hidden dispose never runs. On resume, all three sockets close
    with 1006 and the page rejoins. The first drawn frame comes 12.6–13.5 s after `visible`.
  - MIR-4's blank-after-show does not occur.
- **Memory is the risk to watch.** In combat the renderer's PSS is 840–1040 MiB, with a 489–580 MiB wasm
  heap, on a 3.8 GB phone. No tab was killed.

## Per scene: phone, desktop and PH3

Leg `phv-2`: fixed client, real time, 60 s windows. Each window held GSW's quiet lock exclusive and
started with a 1-minute load under 4 (1.6–3.3). The phone and the desktop viewer were connected
together; "combat solo" closed the desktop viewer first. Leg `phv-1` (unfixed client, phone only at map
and combat) is in brackets. PH3 F is capture-scale `/12` on the bench (`ph3.md`).

| | lobby | map | combat | combat solo | PH3 F (capture-scale) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **phone** distinct applies/s (transactions/s) | 41.4 (41.5) | 54.0 (54.0) [58.2] | 38.2 (38.2) [37.9] | 37.5 | 60.0 |
| host sends/s to the phone (proxy tap) | 41.5 | 54.8 [58.2] | 38.2 [38.6] | 37.6 | 60.0 |
| draws with a new state /s; rAF/s | 27.4; 38.9 | 48.9; 55.7 | 28.8; 44.2 | 28.9; 44.7 | 53.3; 57.7 |
| frame interval p50 / p95 / p99 (ms) | 23.2 / 50.5 / 57.3 | 17.0 / 28.8 / 35.9 | 18.5 / 49.8 / 57.2 | 17.6 / 50.4 / 61.2 | 17 / 17.2 / 34 |
| frames over 1.5 Tp, per minute | 601 | 296 [266] | 788 [817] | 785 | 64 |
| credit RTT p50 / p95 (ms); over 33.3 ms | 15.6 / 21.7; 0.2% | 12.0 / 16.6; 0% [10.3 / 14.3] | 18.1 / 25.5; 1.0% [17.5 / 25.9] | 18.4 / 24.6; 0.1% | 15.4 / 19.9; 0.4% |
| `received` → `applied` p50 / p95 (ms) | 6.8 / 10.9 | 6.8 / 10.8 | 5.0 / 9.2 | 5.1 / 8.8 | 3.4 / 6.0 |
| `onmessage` p50 / p95 (busy ms/s) | 9.4 / 14.0 (411) | 8.3 / 12.8 (481) | 9.7 / 15.4 (395) | 9.9 / 15.1 (392) | 8.7 / 10.2 (523) |
| rAF callback p50 / p95 (busy ms/s) | 1.8 / 7.4 (74) | 1.2 / 1.8 (66) | 2.3 / 4.1 (87) | 2.3 / 3.9 (86) | 2.6 / 3.3 (141) |
| wire to the phone (Mbps) | 2.62 | 0.11 | 5.43 | 5.31 | 1.85 (/13) |
| wasm heap (MiB); renderer PSS (MiB) | 283; 584 | 328; 648 [212; 633] | 580; 840 [489; 1040] | 580; 856 | —; 441 |
| battery temperature; thermal status | 29.2 → 29.8 °C; 0 | 29.8 → 30.1; 0 | 30.7 → 31.2; 0 | 31.5 → 31.8; 0 | 29.3 → 30.8; 0 |
| **desktop** applies/s; frame p95; `onmessage` p50 | 60.0; 16.8; 1.2 | 59.0; 16.8; 1.3 | 60.0; 16.8; 1.3 | — | — |
| desktop wire (Mbps); wasm heap (MiB) | 3.78; 279 | 0.12; 330 | 8.49; 581 | — | — |

Notes on the table.

- **Credit RTT** is host-side, as in PH3's tap: `phv-proxy.mjs` times the phone's `applied` ack
  against the binary message that carried that seq. The phone reaches the hub through it, via
  `adb reverse tcp:13366 tcp:13466`.
- **The wire** is the WebSocket bytes to the phone. Resource GETs come on top of it.
- **The phone's wire is lower than the desktop's** because it receives fewer, larger transactions. The
  desktop's combat figure (8.49 Mbps) matches HCz's seat (8.45).
- **Renderer PSS** is the largest Chrome sandboxed process (`dumpsys meminfo`).
- **Battery** stayed at 100% on USB power throughout.

## Why the phone tops out at ~38–41/s in the lobby and combat

- **Not the main thread.** A 10 s CDP profile in combat (`cpu-profile-combat.json`) shows the page
  39.9% idle. Most of the busy time is the apply (4.1%), the cull (4.0%), zstd literals (3.0%) and
  `WebSocket.send` of the acks (3.0%).
- **The frames are slow anyway.** Frame callbacks take 2.3 ms at p50, but the frame interval is
  18.5 ms at p50 and 50 ms at p95.
- **Not the host, and not a second viewer.** The seat logs 60.0 fps. The desktop viewer gets 60/s from
  it. Closing the desktop viewer leaves the phone at 37.5/s.
- **The credit loop follows the draw.** At every send to the phone, at most one transaction is in flight
  (proxy tap). Sends come 16.7 ms or 50 ms apart.
  - With apply on message, the client applies at once only while fewer than
    `MESSAGE_APPLY_MAX_UNDRAWN` (2) applies wait for a draw (`loop.ts`). So when draws lag, `applied`
    waits for the next frame callback, and the host waits for `applied`.
  - The draw rate (rAF 44/s in combat, 39/s in the lobby) therefore sets the rate. The RTT stays
    short only because the host sends little.
- **The bound is the GPU or the compositor.** The stage draws a 1920×1080 backing, which the compositor
  shows at 1541×866 device pixels (587×330 CSS at DPR 2.625). STS2's lobby and combat stack
  full-screen layers (fog, particles, shader backgrounds).
- **The map shows the contrast.** It is light, and runs 54–58/s at 17 ms frames.

## Visual check

The phone's shots are CDP `Page.captureScreenshot` of the phone tab, not `adb screencap`:

- `screencap` exits 1 with an empty file while the tab is in a CDP browser context, which Android
  Chrome treats as incognito (`FLAG_SECURE`).
- The CDP shot is the page's own composited frame.

Each pair is cropped to the stage canvas and scaled to 960×540 (`phv-psnr.py`, `sheets/`):

| scene | PSNR phone vs desktop | by eye |
| --- | ---: | --- |
| lobby (with the 5380×1320 background, reduced ×2) | 21.8 dB | same content; the background is visibly softer |
| map | 28.8 dB | same content |
| combat | 24.2 dB | same content |

The pairs are seconds apart and the scenes animate (idle bob, fog, particles). The page's gear and
fullscreen icons are also drawn over the canvas at different sizes. The PSNR therefore bounds
alignment, not fidelity. HCz measured fidelity against the game itself on the desktop, at
60–65 dB on map and combat.

## Recovery cycles (phone, first drawn frame)

| cycle | `phv-2` (fixed) | `phv-1` |
| --- | ---: | ---: |
| lobby: checkbox on with the seat not streaming (MIR-4 restart) | 19.2 s (socket open +7.9 s, then 11.3 s) | failed: the 5380×1320 texture |
| map: "Try again" after that failure | — | 4.3 s |
| combat: renderer off for 12–13 s, then on (mount) | 9.3 s | 10.4 s |
| combat: HOME 76–77 s, then `am start` Chrome | 12.6 s after `visible` | 13.5 s |
| desktop: join with the renderer on (seat already streaming) | 4.0 s after the socket opened | — |

- **Hidden on Android.** HOME freezes the page. During the freeze the stage stays `streaming` and no
  60 s dispose runs, because timers are frozen. On resume, the host socket, the seat socket and the
  render-stream socket all close with 1006, and the page rejoins.
- **Most of each recovery is the resource reload.** Most of the 9–13 s goes to reloading textures over
  adb, as PHN measured for capture-scale joins (11–14 s).
- **Off/on unmounts and remounts.** It never restarts the seat, as MIR-4 decided.

## Bugs

### Fixed: oversize textures stopped the stream on the phone (`fix(canvas)`)

**What failed.** `CanvasItemsExecutor::validate` refused any upload wider or taller than the context's
`MAX_TEXTURE_SIZE`. The error failed the frame, and the client failed with it. A host can send any size
Godot accepts: STS2's character-select background is 5380×1320. So a 4096-limit GPU could not show the
lobby at all.

**The fix.** It is in `packages/canvas/rust-prototype/src/canvas_items/`.

- An RGBA8 upload over the limit is reduced by the smallest integer factor `k` that fits it, with each
  side rounded up. The filter is a box filter weighted by alpha, so transparent texels do not darken
  an edge.
- An RGBA16F upload is reduced by keeping the first texel of each block.
- Draws sample with normalized UVs, so the image draws in place at a lower resolution. Only shaders
  that read the texel size see the reduced size.
- Block-compressed uploads over the limit are still refused, since they cannot be reduced without
  re-encoding.
- Every upload within the limit is unchanged.

**Tests.** Three unit tests cover the factor, the alpha weighting with the odd edge column, and the
half-float path. The fix was confirmed on the g31: the lobby streams, and `texture 36` is drawn
reduced.

### Product lead, not chased: the phone's checkbox sent nothing in `phv-1`

In `phv-1` the phone's tab had re-joined: the driver was restarted, the fresh tab connected to the seat
before its own join, and then a desktop tab joined under the same name. Switching the renderer on (and
off) in the phone's panel then sent no `set-renderer` on any socket. This was checked by wrapping
`WebSocket.send`.

In the same state, the desktop tab's switch restarted the seat 0.45 s later. With one clean phone viewer
(`phv-2`) the switch worked at once.

The lead is the `MirrorApp.vue` watcher's early return (`!joined || directView ||
hostClient === activeClient`) after a re-join. It is a couch-coop question. It was seen once.

## Next (named, not implemented)

**PHG: GPU frame cost of STS2 on the g31.**

- Attribute the g31's GPU time in the lobby and combat with a Chrome GPU-process trace and PHN's GL
  probe.
- A/B the stage's backing at display size (CSS × DPR, capped at the host size) against the host's
  1920×1080. The client package already draws into a smaller backing (PHN's page used 1540×866).
- Measure the overdraw of the full-screen layers.

The goal: frames at the panel rate in combat. Once draws keep up, applies and host sends follow; the
credit RTT (18 / 25 ms) is not what limits them.

## Method

**The harness.** It lives in couch-coop's ignored research directory,
`.sts2/research/render-stream-p3-20261025/phv/harness/`, with a copy in the evidence. It extends
MIR-4's.

- `phv-cmd.sh` takes the couch-coop lease (`exclusive:game:p3-sts2`, `shared:install`, and every port:
  14337, 13357, 13366, 33771, 13367, 13376, proxy 13466, DevTools 9334) and runs `leg-main.sh`.
  That script hashes the profile, the Steam remote store, the install and the mod build before and
  after the leg.
- `run-leg.sh` runs one owned host from a private farm under `gamescope --backend headless`, with
  `--force-steam off`, a private XDG, `GRC_HOOK_LOG=off` (the seat's table) and the `pc-lobby-host`
  fixture. It also:
  - starts the proxy;
  - records the phone's session settings and applies them (stay-awake, landscape lock);
  - sets up `adb forward` to Chrome's DevTools socket, and `adb reverse` for the page (14337) and the
    hub (13366 → the proxy);
  - undoes all of this on every exit path, and closes the game by pid.
- **`phv-driver.mjs`** is MIR-4's raw-CDP driver, extended to the phone's real Chrome. Each viewer is its
  own browser context. An init script times every rAF callback and every render-stream `onmessage`. It
  logs each ack the client sends, attributing each `received` ack to the message index of its handler.
  It also reads the wasm memories.
  - `win <label> <s>` marks a window and reads the phone's battery, thermal status, cpufreq and
    renderer PSS at both ends.
  - `phv-window.sh` takes GSW's quiet lock exclusive for each window. No quiet lock is held around the
    whole leg.
- **`phv-sum.py`** builds the table. It counts as PH3 does: a gap over 3 ms between ack times starts a
  new instant. `phv-firstframe.py` gives the first-frame times, `phv-psnr.py` the shots and
  `phv-profile.mjs` the CPU profile.
- **Builds.**
  - The capture was built from `a19faccf` and staged with MIR-3's calibration. `phv-1` and `phv-2`
    used the same capture.
  - The mod was built from couch-coop `b944c52b`, with its client core and frontend from this
    worktree: `rs_core_build sha=a19faccfae52` for `phv-1`, and `sha=6d5c7b161ad8` (the fix) for
    `phv-2`.
- **Driving.** As in HCz: `act ready` on the host and the seat, then
  `act mouse click --x 907 --y 768 --mode dangerous` on both.

## Deviations

- **Screenshots.** The phone's shots are CDP screenshots, not `adb screencap` (see "Visual check").
  There is no separate host reference: the seat is headless, and the host's own screen shows another
  player's view. The desktop viewer of the same seat is the reference.
- **Two viewers.** Lobby, map and combat ran with both viewers on the seat, so that the comparison is
  the same session. "Combat solo" shows that the second viewer does not move the phone's numbers.
- **`phv-1` is partial.** Its lobby failed (the bug), and its map shots were taken with the settings
  panel open, so its PSNR is not reported. Its numbers are in brackets.

## Validation

The fix (`packages/canvas`):

- `cargo test --features canvas-items canvas_items::tests`: the three new tests pass.
  `stats_are_a_flat_word_block` fails both before and after the fix, so the failure is pre-existing.
- `cargo check --target wasm32-unknown-unknown --features canvas-items` is clean.
- `rustfmt` is clean on the new code. The file's older hunks are untouched.
- `validate-increment.sh --plan` reaches 24 targets, with the sabotage legs: `gl.rs` names a
  sabotage.
- **Full tier, once, remotely** (`rv-20261030T100446Z-efa943d-21703`, run 41038084914): **6 of 6 runs
  pass**: `pure`, `cargo-gsw-rs`, `pnpm-test`, `native-rust-gate8`, and `g7-gsw` and `g7live-gsw` in
  every remote-capable group.
- **The refused group, locally at the full tier** (`RS_VALIDATE_GROUPS=g7-1 … --tier full --only
  g7live-gsw`): it passes.
  The first attempt failed only `native-legs@gsw`: this worktree had not run
  `build-rs-core-ext.sh`, so the native receiver could not load `rs_core.gdextension`. After that
  build it passes.
- **The local smoke** passed `pure`, `cargo-gsw-rs` and `pnpm-test`. It was stopped while it waited
  behind another agent's exclusive game leg, because the remote full tier covers every one of its runs.
- **Timing runs** (`g7live-gsw-timing`, `g7x`) are deferred to the milestone sweep, as the brief
  allows. The phone legs above are this increment's timing evidence.

## Evidence

`artifacts/render-stream/p3/phv/` (main checkout, ignored):

- `phv-1/` and `phv-2/`: `sum.json` (every row above), `marks.jsonl`, `events.jsonl` (page states,
  every socket close with its code), the gzipped probes, the proxy tap, the shots, `steps.txt`,
  `windows.txt` (load and lock per window), `seats.jsonl` and the phone's settings before and after.
  `phv-2/` also holds `cpu-profile-combat.json`.
- `sheets/`: the cropped phone | desktop pairs.
- `harness/`: every script and the exact leg command.
- `extension.sha256`, `frontend-core-assets.txt` and the hash compares (all unchanged).

On both launches every hash was unchanged, the leg ended `survivors: none`, and the adb reverses and
forwards were gone. `phv-1`'s teardown restored `user_rotation` by hand: the restore loop's `adb shell`
consumed its stdin, which is fixed for `phv-2`.

## Memory-worthy facts

- **The g31's `MAX_TEXTURE_SIZE` is 4096, and STS2 sends a 5380×1320 texture.** The `canvas_items`
  executor now reduces any oversize upload instead of failing the frame.
- **Android Chrome refuses `adb screencap` while a tab is in a CDP browser context** (incognito,
  `FLAG_SECURE`). It exits 1 with an empty file. Use `Page.captureScreenshot`.
- **A HOME-hidden page on Android is frozen.** The stage's hidden-dispose timer never fires. On resume,
  every WebSocket closes with 1006 and the page must rejoin (about 13 s for STS2 combat over adb).
- **With apply on message, a GPU-bound phone sets the host's send rate.** The undrawn cap holds
  `applied` for the draw. So the phone's applies/s in a heavy scene is its frame rate, not its
  credit RTT.
- **`adb shell` inside a `while read` loop eats the loop's stdin.** Give it `</dev/null`.
