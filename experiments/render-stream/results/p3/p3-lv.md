# P3-LV: the live transport at STS2 scale (2026-10-25)

**With the hand-off's settings, no receiver kept up live in STS2 combat: 0.1–0.9 updates a second,
0.9–5 s behind the game (p50).** Every animated spine pose is a new content-addressed mesh
payload, and every receiver fetched those one per frame over HTTP:

- the native receiver and GSW each issue one GET per frame (a Godot `HTTPClient` poll, and an rAF
  poll);
- the web export issues one GET at a time, at about 3 ms each.

A combat transaction needs about 100 new meshes. So each one waited 1–5 s for its payloads, and the
stream stalled at its credit window.

**`GRC_RESOURCE_INLINE_MAX_BYTES=4096`, a setting that already exists, removes that bottleneck.** It
sends every STS2 mesh surface in band: the largest is 2,284 B. GSW then follows the game at its frame
rate on the menu and the map (52–56 updates a second, 5–17 ms behind). As the only viewer in combat
(L5), it applied 34.8 of the host's 38.8 frames a second, 15 ms behind.

Two further limits, with numbers:

- **The host pays per viewer.** It publishes a diff and an encode per connection, plus about 70
  inline records each. Its combat frame rate falls from about 54 (L1, where nobody kept up) to 39
  fps with one GSW viewer, and to 24–35 fps with 3–4 viewers.
- **The GDScript receivers pay per record.** The native receiver and the web export spend their main
  thread on the roughly 2,000 inline records a second. They run at 26–40 fps and apply 6–15 combat
  updates a second.

One receiver hot spot is fixed here. GSW's payload store (`rs-core`) scanned every payload it held on
each insert, so its cost grew with session length. On STS2's own `a8-2` recording, combat went from
1.4 ms to 46 ms per transaction over 5,000 frames. It now stays flat at about 1.5 ms.

The real fix for mesh churn is a wire change, designed below. It sends dynamic mesh surfaces by id,
inline in the transaction, and should join `/11` next to multimesh buffers.

Live fidelity matches file-replay fidelity:

- with inline meshes, every receiver's shot paired with the reference at 0–1 frames;
- the dB on each scene equals P3-CT's replay figures (native and web 25.5–26.1 dB in combat, GSW
  24.6–25.0, map 64–65 dB native and web, 53 GSW);
- the menu stays at 2.9 dB, C3's screen-texture gap, which P3-ST has since fixed on `main`.

## Method

- **Game legs.** C3's harness (a8 route: menu, map, combat; `GRC_DISARM_AFTER_FRAMES=7200`), in a
  private copy (scratchpad `p3lv-harness/`) with:
  - two live modes. `live8` runs the hand-off environment at `/8` decoded. `live9` adds
    `basis-uastc` with a cold private texture cache. Both use `GRC_LIVE_LISTEN` on loopback,
    HTTP zstd (the default), up to 4 connections, a live tap (`GRC_LIVE_TAP_DIR`) and no file sink
    or store;
  - a receiver hook. It starts the receivers when the game is ready on the menu, and starts a late
    one after the combat shots. The receivers are:
    - native, rendered in its own headless gamescope at 1920x1080 and `--max-fps 60`;
    - GSW and the web export, in the gate 7 browser harness's pinned headless Chromium.
    The disarm's end record ends them.
  - C3's reference grabber `c3_shot.gd` with one addition, `C3_SHOT_ALIGN=300`. A shot waits for a
    frame P that is a multiple of 300. Each receiver gets `RS_RECEIVER_SHOT_WINDOWS` of
    `k:300k-(300k+299)`, so its shot k is the first transaction it applied with a host frame in
    [P, P+299]. The pair's frame offset is part of the result.
  - its own farm copy (`p3lv-root/`). The original farm's `c3_shot.gd` is untouched.

  Every leg ran under `live-qa-lock.mjs with --resource exclusive:game:p3-sts2` (plus
  `shared:install`, port 13767 and the leg's own live and page ports), and then the GSW quiet lock,
  exclusive. Every leg ended with `survivors: none`. All five hash sets (operator profile, Steam
  remote store, install binaries, install mods, mod build) were unchanged on every leg.
- **Measured on the host clock, for every receiver the same way** (the live tap: one line per frame
  callback, send and ack). `scripts/lib/bench-live-scale.py tap_stats`:
  - **sent/s** and **applies/s**: distinct receiver apply instants. `applied` acks that share the
    receiver's `t_us` were applied together, a window-2 fold.
  - **latency**: a transaction's send to its `applied` ack, which is host frame to receiver apply.
  - **credit RTT**: send to the ack at the connection's credit stage.
  - **first apply**: connection open to seq 1's `applied` ack.
  - **WS bytes** and **inline records** per second.
  - GETs per connection come from the tap only with a single connection. With several, the host
    attributes no GET, so only the totals are given.
- **The receivers' own numbers** come from their `perf.json`: decode, apply and draw/render per
  transaction, frame interval, and RSS or wasm heap. GSW times an inline record's accept in
  `onmessage`, outside its per-frame samples, so GSW's decode column omits it.
- **Scenes** are host-frame windows. A scene runs from 300 frames before its first reference shot to
  its last one; combat runs to the disarm.
- **Fixture legs** (no game). `fixtures/capture-scale`, P3-CAP's stock-template scene with STS2's
  combat shape: 76 mesh updates a frame, 2,667-B mesh payloads, 700 textures. It streams live to one
  receiver, with the same tap and metrics. That is the new `scripts/bench-live-scale.sh`.
- **Load.** The game legs waited for a 1-minute load under 4, and started at 3.3–3.7. The other P3
  agents' unlocked work (Node checkers, Chromium, Godot editors) pushed the load back to 4–6 during
  some legs. This is noted per leg. Real time only; no fast frames.
- **Concurrent receivers.** L1–L4 ran 3–4 receivers on one game, so each receiver's numbers include
  the others' CPU and GPU, and the host serves 3–4 connections. L5 and L6 are single-viewer legs.

## Results: STS2 (game legs)

| leg | mode | host settings beyond the hand-off | receivers (w = credit window) |
| --- | ---- | --------------------------------- | ----------------------------- |
| L1 | live8 | none (GETs for every payload) | GSW w1, GSW w2, web w2, native w2 |
| L2 | live8 | `GRC_RESOURCE_INLINE_MAX_BYTES=4096` | GSW w2, web w2, native w2; late GSW w2 |
| L3 | live8 | inline 4096 | GSW w1, web w1, native w1; late GSW w2 |
| L4 | live9 (`basis-uastc`, cold cache) | inline 4096 | GSW w2, web w2, native w2; late GSW w2 |
| L5 | live8 | inline 4096 | GSW w2 only, with this increment's `rs-core` |
| L6 | live8 | inline 4096 | web w2 only |

L2 and L3 ran a capture build that also read a `GRC_LIVE_MAX_HTTP_CLIENTS` knob. It was set to 32 and
dropped before landing: no leg saw a 503.

L2 and L3 were also meant to compare a GSW fetch-concurrency trial (6 GETs in flight, bundle `b`)
with the plain bundle `a`, through the late subscriber. That comparison is void. The browser
harness kept the first `gsw-bundle` link a static root got (P3-GX, `674c6215`, fixed it after
these legs). L2's late GSW therefore ran bundle `b` at its default of one GET, and L3's late
"concurrent" GSW ran bundle `a`, which ignores the knob. Both measured the one-GET path: 3,270 ms
twice. Every other GSW in L1–L6 was the first, or only, GSW link of its leg, so it ran the bundle
named here. The links that stayed in the leg directories confirm it: L1, L3 and L4 point to `a`, L2
to `b` and L5 to `c`. `a` and `b` share rs-core `2b69624d43f6`; `c` carries this increment's
`PayloadStore`. The web export used one bundle throughout, and the fixture runs each had a fresh
static root.

### Throughput per scene

| leg | receiver | w | scene | host fps | sent/s | applies/s (folded) | latency p50/p95 ms | credit RTT p50/p95 ms | WS KB/s | inline rec/s |
| --- | --- | - | --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | GSW | 1 | menu | 57.3 | 3.7 | 3.7 (0) | 205.0/364.0 | 219.7/453.2 | 128 | 0 |
| L1 | GSW | 1 | map | 59.2 | 46.4 | 46.4 (0) | 4.0/18.2 | 4.3/18.6 | 681 | 0 |
| L1 | GSW | 1 | combat | 53.6 | 0.5 | 0.5 (0) | 1773.0/2176.1 | 2060.0/2185.4 | 82 | 0 |
| L1 | GSW | 2 | menu | 57.3 | 6.0 | 3.0 (47) | 248.9/422.1 | 253.1/483.2 | 208 | 0 |
| L1 | GSW | 2 | map | 59.2 | 54.4 | 44.4 (152) | 11.2/20.3 | 11.4/20.6 | 797 | 0 |
| L1 | GSW | 2 | combat | 53.6 | 0.9 | 0.5 (21) | 1795.8/2184.8 | 2096.7/2238.3 | 163 | 0 |
| L1 | web | 2 | menu | 57.3 | 16.5 | 8.3 (130) | 74.6/191.6 | 76.3/206.5 | 576 | 0 |
| L1 | web | 2 | map | 59.2 | 54.0 | 52.4 (25) | 24.5/27.0 | 27.1/29.5 | 792 | 0 |
| L1 | web | 2 | combat | 53.6 | 1.8 | 0.9 (40) | 945.9/1318.7 | 1067.0/1569.3 | 311 | 0 |
| L1 | native | 2 | menu | 57.3 | 3.6 | 1.8 (28) | 528.6/749.7 | 530.8/752.5 | 124 | 0 |
| L1 | native | 2 | map | 59.2 | 46.3 | 29.8 (250) | 21.2/38.8 | 24.8/42.5 | 678 | 0 |
| L1 | native | 2 | combat | 53.6 | 0.3 | 0.1 (6) | 5146.7/9330.2 | 5627.0/9812.0 | 58 | 0 |
| L2 | GSW | 2 | menu | 57.4 | 56.6 | 55.8 (12) | 12.0/16.2 | 12.1/16.3 | 1970 | 481 |
| L2 | GSW | 2 | map | 59.2 | 55.4 | 54.9 (8) | 16.4/17.8 | 16.6/18.1 | 812 | 0 |
| L2 | GSW | 2 | combat | 28.8 | 23.0 | 22.7 (25) | 37.0/99.5 | 37.3/101.4 | 3961 | 2354 |
| L2 | web | 2 | menu | 57.4 | 53.0 | 51.6 (23) | 22.0/31.6 | 23.3/33.1 | 1845 | 453 |
| L2 | web | 2 | map | 59.2 | 41.5 | 40.1 (22) | 29.2/34.4 | 31.1/40.4 | 609 | 0 |
| L2 | web | 2 | combat | 28.8 | 8.0 | 8.0 (0) | 206.9/345.7 | 212.7/359.0 | 1396 | 824 |
| L2 | native | 2 | menu | 57.4 | 57.1 | 54.1 (48) | 14.4/23.6 | 16.3/25.4 | 1988 | 485 |
| L2 | native | 2 | map | 59.2 | 58.1 | 51.2 (105) | 12.7/23.8 | 15.0/25.8 | 851 | 0 |
| L2 | native | 2 | combat | 28.8 | 18.5 | 11.8 (625) | 53.9/108.9 | 59.3/118.2 | 3190 | 1894 |
| L2 | late GSW | 2 | combat | 26.7 | 21.2 | 21.1 (3) | 35.8/53.2 | 36.1/54.2 | 3720 | 2174 |
| L3 | GSW | 1 | menu | 57.3 | 52.1 | 52.1 (0) | 5.8/18.5 | 5.9/18.7 | 1814 | 451 |
| L3 | GSW | 1 | map | 59.3 | 53.0 | 53.0 (0) | 5.1/9.4 | 5.3/13.0 | 777 | 0 |
| L3 | GSW | 1 | combat | 34.6 | 17.9 | 17.9 (0) | 29.8/42.0 | 30.1/42.8 | 3087 | 1831 |
| L3 | web | 1 | menu | 57.3 | 27.2 | 27.2 (0) | 17.3/28.6 | 18.8/30.2 | 947 | 263 |
| L3 | web | 1 | map | 59.3 | 25.6 | 25.6 (0) | 14.6/31.2 | 16.6/33.3 | 376 | 0 |
| L3 | web | 1 | combat | 34.6 | 6.1 | 6.1 (0) | 127.6/192.9 | 132.9/203.1 | 1070 | 630 |
| L3 | native | 1 | menu | 57.3 | 28.4 | 28.4 (0) | 18.0/20.3 | 19.9/23.0 | 989 | 262 |
| L3 | native | 1 | map | 59.3 | 37.9 | 37.9 (0) | 10.7/22.9 | 13.0/26.0 | 556 | 0 |
| L3 | native | 1 | combat | 34.6 | 14.5 | 14.5 (0) | 35.2/67.4 | 40.7/74.1 | 2510 | 1486 |
| L3 | late GSW | 2 | combat | 32.0 | 24.0 | 23.9 (4) | 32.2/56.8 | 32.6/58.0 | 4207 | 2459 |
| L4 | GSW | 2 | menu | 52.1 | 51.3 | 49.8 (27) | 9.9/19.3 | 10.1/19.6 | 1790 | 514 |
| L4 | GSW | 2 | map | 56.5 | 52.9 | 51.5 (23) | 8.9/18.5 | 9.1/18.8 | 779 | 0 |
| L4 | GSW | 2 | combat | 24.1 | 19.2 | 19.1 (17) | 39.6/133.6 | 40.0/138.8 | 3312 | 1966 |
| L4 | web | 2 | menu | 52.1 | 45.6 | 44.7 (17) | 23.0/42.3 | 24.5/44.7 | 1592 | 467 |
| L4 | web | 2 | map | 56.5 | 47.1 | 45.9 (19) | 22.2/38.1 | 24.4/41.3 | 694 | 0 |
| L4 | web | 2 | combat | 24.1 | 6.8 | 6.8 (0) | 234.7/424.5 | 240.5/440.6 | 1185 | 698 |
| L4 | native | 2 | menu | 52.1 | 51.4 | 50.2 (21) | 14.6/25.1 | 16.3/27.4 | 1794 | 533 |
| L4 | native | 2 | map | 56.5 | 54.8 | 52.3 (40) | 15.8/23.7 | 18.1/26.3 | 807 | 0 |
| L4 | native | 2 | combat | 24.1 | 16.2 | 10.4 (725) | 61.5/127.5 | 66.2/134.2 | 2805 | 1662 |
| L4 | late GSW | 2 | combat | 22.5 | 19.2 | 19.1 (3) | 42.0/74.9 | 42.3/77.9 | 3358 | 1965 |
| L5 | GSW | 2 | menu | 57.4 | 56.6 | 54.4 (34) | 7.5/17.8 | 7.6/18.0 | 1968 | 475 |
| L5 | GSW | 2 | map | 59.3 | 55.4 | 53.7 (26) | 5.3/16.5 | 5.4/17.5 | 812 | 0 |
| L5 | GSW | 2 | combat | 38.8 | 34.8 | 34.8 (5) | 15.3/22.9 | 15.5/23.2 | 5977 | 3566 |
| L6 | web | 2 | menu | 57.5 | 54.7 | 52.4 (36) | 14.1/27.8 | 15.5/29.4 | 1904 | 446 |
| L6 | web | 2 | map | 59.3 | 50.6 | 48.5 (32) | 23.2/29.6 | 25.0/31.9 | 742 | 0 |
| L6 | web | 2 | combat | 56.9 | 10.3 | 10.3 (0) | 149.6/246.5 | 154.1/265.5 | 1788 | 1056 |

- **Combat is where receivers part.** Menu and map transactions are 35 KB and 15 KB, and every
  receiver follows them once meshes are inline.
- **The single-viewer legs are the cleanest.**
  - L5's GSW applied 34.8 of the host's 38.8 combat frames a second, 15 ms behind (p95 23).
  - L6's web export applied 10.3, 150 ms behind.
  - The host dropped to 38.8 fps even for one GSW viewer, because it publishes every frame to it.
    It stayed at 56.9 fps for the web viewer, which drew credit only 10 times a second.
- **L5 and L6 ran at a 1-minute load of 5.6 and about 4.** Other agents' unlocked work had not
  fallen below 4 in 13 minutes, so `game.sh` started them anyway. The host frame rates there are
  pessimistic.

### Receiver cost, first apply and memory

| leg | receiver | w | first apply ms | receiver fps | decode ms | apply ms | draw/render ms | frame interval ms | RSS or wasm heap MB | exit |
| --- | --- | - | --- | --- | --- | --- | --- | --- | --- | --- |
| L1 | GSW | 1 | 1930 | 54.6 | 0.55 | 0.38 | 0.73 | 18.32 | 590 | 0 |
| L1 | GSW | 2 | 1761 | 54.4 | 0.32 | 0.39 | 0.81 | 18.39 | 587 | 0 |
| L1 | web | 2 | 1755 | 54.3 | 0.7 | 0.95 | 0.92 | 18.42 | None | 0 |
| L1 | native | 2 | 1307 | 31.1 | 0.29 | 0.85 | 0.9 | 32.18 | 789 | 3 |
| L2 | GSW | 2 | 924 | 51.6 | 0.91 | 0.56 | 0.22 | 19.37 | 1252 | 0 |
| L2 | web | 2 | 1247 | 33.0 | 0.05 | 1.04 | 0.81 | 30.41 | None | 0 |
| L2 | native | 2 | 592 | 29.8 | 0.02 | 0.89 | 1.15 | 33.66 | 1363 | 0 |
| L2 | late GSW | 2 | 3270 | 54.2 | 1.71 | 1.22 | 0.47 | 18.44 | 930 | 0 |
| L3 | GSW | 1 | 1019 | 55.6 | 0.8 | 0.5 | 0.23 | 17.98 | 944 | 0 |
| L3 | web | 1 | 1217 | 40.1 | 0.05 | 1.07 | 0.87 | 24.92 | None | 0 |
| L3 | native | 1 | 597 | 35.8 | 0.02 | 1.0 | 1.15 | 28.0 | 1109 | 0 |
| L3 | late GSW | 2 | 3270 | 53.0 | 1.72 | 1.26 | 0.46 | 18.83 | 924 | 0 |
| L4 | GSW | 2 | 639 | 48.8 | 1.03 | 0.63 | 0.23 | 20.54 | 868 | 0 |
| L4 | web | 2 | 900 | 29.3 | 0.05 | 1.15 | 0.95 | 34.15 | None | 0 |
| L4 | native | 2 | 421 | 25.9 | 0.02 | 0.99 | 1.39 | 38.63 | 1184 | 0 |
| L4 | late GSW | 2 | 1672 | 55.1 | 1.82 | 1.09 | 0.38 | 18.13 | 588 | 0 |
| L5 | GSW | 2 | 1122 | 55.2 | 1.04 | 0.59 | 0.29 | 18.11 | 1336 | 0 |
| L6 | web | 2 | 1335 | 39.7 | 0.04 | 0.86 | 0.67 | 25.18 | None | 0 |

- "receiver fps" is the receiver's own frame rate: rAF for GSW, `Engine` frames for the GDScript
  receivers.
- GSW's decode column omits inline records (see Method).
- The native receiver's exit 3 in L1 is the disarm cutting its last GET; its report was written.
- GSW's wasm heap is 590 MB with GETs (L1) and 870–1,340 MB with inline meshes, because every pose
  stays in its store (bottleneck 6).
- The native receiver's RSS reached 0.8–1.4 GB in 2–3 minutes.

### Bytes and GETs (host totals)

| leg | duration | GETs (per s) | HTTP identity / zstd MB | host RSS max | host frame callback mean | carried hashes at the end, per connection |
| --- | -------- | ------------ | ----------------------- | ------------ | ------------------------ | ----------------------------------------- |
| L1 | 121 s | 26,158 (216) | 1,334 / 168 | 3.03 GB | 8.5 ms | 0 (nothing inline) |
| L2 | 166 s | 283 (2) | 1,207 / 148 | 3.27 GB | 15.2 ms | 252k, 97k, 203k, 130k |
| L3 | 150 s | 283 (2) | 1,207 / 148 | 3.22 GB | 12.6 ms | 169k, 63k, 132k, 122k |
| L4 | 197 s | 283 (1) | 323 / 82 | 3.44 GB | 21.3 ms | 279k, 110k, 235k, 170k |
| L5 | 145 s | 77 (1) | 330 / 39 | 3.09 GB | 9.7 ms | 327k (one GSW viewer) |
| L6 | 117 s | 77 (1) | 330 / 39 | 3.06 GB | 6.4 ms | 79k (one web viewer) |

With inline meshes, the 283 GETs are the textures and shaders, fetched once per receiver. The WS
carries 1.8–2.0 MB/s per connection on the menu, 0.8 MB/s on the map and 2.5–4.2 MB/s in combat.
Combat patches are 172–175 KB, as in C3, and inline records add 1.0–1.4 MB/s.

### Live fidelity (reference pairs)

Per receiver: dB (RGB PSNR) of each of the three shots per scene, and the frame offset of the
receiver's shot from the reference frame (`livecmp.py`; C3's metric).

| leg | receiver | menu dB (offset) | map dB (offset) | combat dB (offset) |
| --- | -------- | ---------------- | --------------- | ------------------ |
| L1 | GSW w1 | 2.94 (0–1) | 53.3 (0) | 24.0–24.2 (24–30) |
| L1 | native w2 | 2.94 (2) | 64.1–64.2 (0) | 24.8–25.2 (6–147) |
| L1 | web w2 | 2.94 (2) | 65.6 (0) | 25.2–25.9 (0–2) |
| L2 | GSW w2 | 2.94 (0) | 53.3 (0) | 24.8–24.9 (0) |
| L2 | native w2 | 2.94 (0) | 64.1–64.2 (0) | 25.5–26.0 (0–1) |
| L2 | web w2 | 2.94 (0) | 65.6 (0) | 25.9–26.1 (0) |
| L3 | GSW w1 | 2.93–2.95 (0) | 53.3 (0) | 24.6–25.0 (0–1) |
| L3 | native w1 | 2.93–2.95 (1) | 52.1–64.2 (0–1) | 25.7–26.1 (0–1) |
| L4 | GSW w2 (`/9`) | 2.94 (0) | 49.1–49.2 (0) | 24.8–24.9 (0) |
| L4 | native w2 (`/9`) | 2.94 (0) | 51.0–51.1 (0) | 25.5–26.0 (0–1) |
| L4 | web w2 (`/9`) | 2.94 (0) | 51.1–51.2 (0) | 25.5–26.0 (0–1) |
| L5 | GSW w2, alone | 2.94 (0) | 53.3 (0) | 24.8–25.0 (0) |
| L6 | web w2, alone | 2.93 (0–1) | 65.6 (0) | 25.4–25.6 (1) |

- At offset 0 these are file-replay figures: P3-CT's `a8-2` replay gives native 26.2 and GSW
  25.0 dB in combat, and C3 gives 64.1 / 53.3 on the map.
- The `/9` map is 13–15 dB lower, from UASTC's lossy encode of the map texture. Combat is unchanged.
- The menu is 2.9 dB on every receiver: C3's gap 1 (a screen-texture shader drawn white). P3-ST
  (`8b818b7b`) landed after these legs.
- L3's 52 dB map shots at offset 1 are a map animation one frame apart.
- Without inline meshes (L1), combat shots trail the reference by 24–147 frames (0.4–2.5 s). That
  costs about 1 dB of animation mismatch on top of the replay figure.

Contact sheets (reference and receiver, combat-1): `legs/p3lv-l*/live-sheet.png` in the research
folder.

## Results: fixture (`bench-live-scale.sh`)

`fixtures/capture-scale`, one receiver, 1,200 host frames.

Development runs (scratchpad `leg.sh`, the same host and receivers as the bench; load 2–5):

| receiver | w | config | applies/s (sent/s) | credit RTT p50/p95 ms | GETs/s | inline rec/s | first apply ms | receiver fps | receiver ms per tx: decode / apply / fetch |
| -------- | - | ------ | ------------------ | --------------------- | ------ | ------------ | -------------- | ------------ | ------------------------------------------ |
| native | 1 | default | 0.2 (0.3) | 3,183 / 7,646 | 59.8 | 0 | 7,272 | 54.7 | 15.1 / 69.4 / 4,012 |
| GSW | 1 | default | 0.2 (0.3) | 3,224 / 7,555 | 60.4 | 0 | 7,403 | 57.0 | 74.4 / 88.3 / 2.7 per GET |
| web | 1 | default | 0.8 (0.8) | 739 / 4,672 | 166.6 | 0 | 4,167 | 50.9 | 31.8 / 45.5 / 987 |
| native | 2 | default | 0.2 (0.4) | 5,783 / 7,272 | 56.5 | 0 | 7,262 | 53.1 | 9.7 / 68.9 / 4,944 |
| GSW | 2 | default | 0.2 (0.5) | 3,211 / 7,465 | 60.8 | 0 | 7,346 | 57.0 | 2.4 / 87.4 / 2.7 per GET |
| web | 2 | default | 0.3 (0.6) | 2,995 / 6,910 | 88.9 | 0 | 6,594 | 48.7 | 40.8 / 156.8 / 2,510 |
| native | 1 | inline 4096 | 19.3 (19.3) | 31 / 43 | 9.6 | 3,255 | 3,907 | 39.8 | 0.01 per record / 5.3 / 8.0 |
| GSW | 1 | inline 4096 | 18.3 (18.3) | 38 / 41 | 10.3 | 3,154 | 3,771 | 57.6 | 2.3 / 10.2 / 8.0 per GET |
| web | 1 | inline 4096 | 7.3 (7.3) | 72 / 158 | 11.0 | 1,368 | 3,849 | 49.3 | 0.04 per record / 12.3 / 14.8 |
| native | 2 | inline 4096 | 22.6 (31.4) | 33 / 62 | 9.6 | 3,532 | 3,875 | 35.9 | 0.02 per record / 5.3 / 6.8 |
| GSW | 2 | inline 4096 | 29.9 (38.3) | 23 / 40 | 10.3 | 3,595 | 3,776 | 57.7 | 1.3 / 9.4 / 7.8 per GET |
| web | 2 | inline 4096 | 9.8 (9.9) | 130 / 239 | 11.1 | 1,770 | 4,009 | 41.9 | 0.04 per record / 11.4 / 11.4 |

- The fixture is heavier than STS2 per transaction in one place: its 560 materials × 64
  parameters cost the core's material accounting about 2.5 ms a transaction
  (`MaterialResidency::apply` compares every named material's parameters). STS2's combat costs
  0.1 ms there.
- The default rows reproduce STS2's stall exactly. 187 meshes a transaction, at one GET a frame,
  is 3.2 s at 60 fps.
- Inline lifts every receiver by two orders of magnitude.
- The remaining fixture ceiling is GSW's 9.4 ms apply (materials), and the GDScript receivers'
  per-record cost.

`bench-live-scale.sh`, the committed bench, window 2 (load 8–12 from other agents' unlocked work,
so rates are low; the verdicts are the point):

| receiver | config | legs-ran | update-rate (applies/s) | credit-rtt (p50 / p95 ms) | first apply ms |
| -------- | ------ | -------- | ----------------------- | ------------------------- | -------------- |
| GSW | default | pass | **FAIL** 0.2 | **FAIL** 3,229 / 7,667 | 7,523 |
| GSW | inline 4096 | pass | pass 24.0 | pass 36.9 / 53.3 | 5,006 |
| web | default | **FAIL** (exit 3: a GET cut by the host's quit) | **FAIL** 0.2 | **FAIL** 4,574 / 6,438 | 6,187 |
| web | inline 4096 | pass | **FAIL** 8.1 | **FAIL** 150.6 / 259.9 | 4,800 |
| native | default | pass | **FAIL** 0.2 | **FAIL** 5,074 / 7,627 | 7,339 |
| native | inline 4096 | pass | pass 19.0 | pass 38.1 / 78.4 | 3,976 |

The web export fails the bench even with inline meshes. That is bottleneck 3: its per-record cost
on the fixture's 1,500–3,300 records a second.

## Bottlenecks, in the order they bind

1. **One GET per frame for every churned mesh payload (all receivers).**
   - The native fetcher (`rs_resource_fetcher.gd`) polls one keep-alive `HTTPClient` from
     `_process`, and stops at the first poll that has to wait for the network. So a GET costs one
     frame even on loopback.
   - GSW's `LiveFetcher` issues the next GET only from its rAF poll.
   - The web export chains `fetch()`es at about 3 ms each (G7wf).
   - A combat transaction names about 100 new mesh hashes (71 a frame, more across a credit
     round trip). In L1 that is 1.8 s per transaction on GSW, 0.9 s on the web export and 5.1 s on
     the native receiver (latency p50).
   - The host's I/O thread serves the GETs fine (L1: 216 GETs/s in total); the receivers are the
     limit.
   - **Fix (configuration): `GRC_RESOURCE_INLINE_MAX_BYTES=4096`.** STS2 mesh surfaces are p50
     316 B, p90 1,026 B, p99 2,038 B and max 2,284 B (`a8-2`'s 351,984 mesh payloads). At 1,024,
     P3-CAP's suggestion, 12 % of them would still be GETs, and with ~9 GETs per transaction the
     stall would remain on native and GSW. At 4,096 all of them ride the WebSocket; 142 small
     textures and every shader join them. The cap for live is 1 MiB.
2. **The host's publication cost per connection (multi-viewer).**
   - Every connection gets its own transaction against its own base, which costs:
     - a copy of the published `Snapshot` (`Snapshot cur = snapshot.state`) and the release of the
       previous base;
     - `make_patch` (0.8 ms) and `encode_transaction` (0.24–0.52 ms);
     - copying `base_payloads` and the `ServedResources` pin and retire maps (string-keyed);
     - one `encode_resource` and one enqueue per inline record (7–9 µs each).
   - A host profile with 3 receivers on the fixture (`perf record`, `m3-perf`) puts
     `Hub::send_transaction` at 35 % of the process. Of that: snapshot copy and release 11 %,
     `ServedResources` retire/add 11 %, `make_patch` 7 %, encode 5 %, deliver/enqueue 4.5 %.
   - On the fixture the frame callback goes from 6.9 ms (1 receiver) to 13.1 ms (3), about 3.1 ms per
     extra viewer. The live tap adds 1.6 ms of its own (14.7 ms), and the product does not set it.
   - In STS2 combat the host fell from 53.6 fps (L1: GET-bound receivers, almost no sends) to 24–35
     fps with 3–4 caught-up viewers. Everything published per frame is a per-connection multiple.
   - Not fixed here: see "Design" below.
3. **Per-record cost in the GDScript receivers (native, web export).**
   - Each inline record is one WebSocket message. It goes through `get_packet`, the core's
     `accept`, `_receive_resource`, `RsResourceCache.add_inline` (dictionary inserts and the
     stager's verify), each in GDScript.
   - In combat that is 1,500–1,900 records a second. The native receiver drops to 26–36 fps (frame
     interval 28–39 ms) and applies 10–15 updates a second. The web export drops to 29–40 fps and
     applies 6–8.
   - Both are fine on the menu and the map: 50–54 updates a second at window 2, 25–28 at window 1.
4. **GSW's payload store scan (fixed).**
   - `PayloadStore::insert` (rs-core `apply/payloads.rs`, used by GSW) searched its whole LRU deque
     for the hash before appending it: `iter().position`, then `remove`.
   - `total_bytes` summed every entry, once per eviction step.
   - Without a memory budget nothing is ever evicted, so mesh churn grows the store by one entry
     per pose: 250k entries in L2's three minutes.
   - The cost per payload grows with it, which makes a session quadratic. It is the likely cause of
     C3's 15-minute GSW replay of `a8-1` (gap 8).
   - The native receiver and the web export do not use this store (`rs-core-capi` keeps its own
     maps).
5. **Fresh-subscriber latency is bytes, not round trips.**
   - A late GSW subscriber in combat applied its first frame after 3.27 s at `/8` and 1.67 s at
     `/9` `basis-uastc`. Of the 3.27 s, about 1.0 s is verifying and decoding 227 MB of textures,
     0.6 s is applying and uploading them, and the rest is their GETs.
   - Fetch concurrency was measured only on the fixture, where 6 GETs in flight cut GSW's first
     apply from 3.86 to 2.91 s (`conc6`/`conc1`; its STS2 trial is void, see "Results: STS2").
     Whatever concurrency saves, the remaining ~1.6 s is verify, decode, apply and upload of the
     bytes.
   - A first subscriber on the menu takes 0.6–1.9 s.
   - Lever: `/9` with a prepared `GRC_TEXTURE_CACHE_DIR` (hand-off "Delivery and cache"), which
     also keeps the encodes off the session.
6. **Memory grows with mesh churn, on both sides (gap 7).**
   - Inline: the host's per-connection `carried` set (`std::set<std::string>`, about 150 B a hash,
     never pruned by the `/2` duplicate rule) gained 252k hashes in L2's 166 s. At 60 fps
     combat (about 4,300 new hashes a second) that is roughly 2.3 GB an hour per viewer.
   - The receivers' stores grow the same way: GSW to 250k entries and 737 MB in L2. A receiver
     memory budget (`RS_RECEIVER_MEMORY_BUDGET_BYTES`) bounds them, but the GDScript cache sums
     every entry on each add (`memory_bytes()`), and once over budget it sorts every entry on each
     add. At STS2 churn that is the per-record hot spot again.
   - Over GETs (L1) the host keeps nothing per connection, but the receivers grow just the same.
   - Only the wire change below removes both.

Credit window: window 2 never hurt GSW and helped the native receiver on the menu and the map. 54
against 28 updates a second (L2 against L3), and the native receiver folds about 1 transaction in 3
in combat. The web export gains on the menu and the map too (52 against 27). In combat every
GDScript receiver is bound by its main thread, not the window.

## Fixes in this increment

1. **`rs-core` `PayloadStore`** (`apply/payloads.rs`): the touch order is a deque of (hash, stamp)
   slots plus a hash → current-stamp map.
   - A touch pushes a new slot, and the old slot goes stale.
   - Eviction walks the slots oldest first. It skips stale slots and referenced entries, as it
     did, and evicts in place, with no shift of what follows.
   - Stale slots are dropped from the front, and all at once when they outnumber the live ones, so
     the deque stays bounded and a touch is amortised O(1).
   - `total_bytes` is a running sum.
   - The LRU order, the eviction rule (never a referenced hash) and every count are the scan's.
     The existing eviction tests pass unchanged, plus a new one
     (`stamped_touch_order_stays_bounded_and_counts_bytes`): 2,000 re-provides, an LRU eviction
     around a referenced entry, a re-provide after an eviction, and `clear`.
   - Bench: `rs-core-check profile` over the same recordings, `main` against this branch, provide
     and total µs per transaction (repeats 1):

     | recording | transactions | before (provide / total) | after (provide / total) |
     | --------- | ------------ | ------------------------ | ----------------------- |
     | STS2 `a8-2`, seq 1501–2000 (combat starts) | 500 | 1,976 / 3,004 | 526 / 1,406 |
     | STS2 `a8-2`, seq 2501–3000 | 500 | 9,011 / 10,512 | 414 / 1,675 |
     | STS2 `a8-2`, seq 4501–4960 | 460 | 44,381 / 45,917 | 305 / 1,643 |
     | STS2 `a8-2`, whole (4,960 tx) | | 63.7 s | 6.1 s |
     | `capture-scale`, 2,400 frames, tx 1–400 | 400 | 3,121 / 11,463 | 1,275 / 11,210 |
     | `capture-scale`, tx 1,201–1,600 | 400 | 17,280 / 28,101 | 816 / 11,410 |
     | `capture-scale`, whole | | 52.7 s | 26.9 s |

     The fixture's recording comes from the stock template (`fixtures/capture-scale`,
     `RS_FIXTURE_QUIT_FRAME=2400`, synchronous texture workers): a recording plus a store with
     151,886 mesh payloads.
2. **`scripts/bench-live-scale.sh`** (+ `lib/bench-live-scale.py`, pure self-test
   `test/self-test-bench-live-scale.sh`): the live receiver bench P3-CAP's fixture lacked.
   - It runs `capture-scale` armed with the hand-off environment and a live listener, plus one
     native, GSW or web receiver at window 1 or 2.
   - It is one timing leg under the exclusive quiet lock, judged from the live tap:
     - `update-rate`: distinct applies a second, at least 15;
     - `credit-rtt`: p50 at most 100 ms.
   - The default configuration fails both on every receiver (0.2–0.3 applies a second, 3–6 s round
     trips). `GRC_RESOURCE_INLINE_MAX_BYTES=4096` passes on GSW and native.
   - It is not a validate-increment target (smoke-map rule, `pure` only), like P3-CAP's bench.
3. **Hand-off** (`protocol/gate8-product-handoff.md`): `GRC_RESOURCE_INLINE_MAX_BYTES=4096`, credit
   window 2, the receiver to pick, the per-viewer host cost and the memory caveat ("Live at game
   scale").

## Design: dynamic mesh surfaces by id, inline (join `/11`)

The STS2 traffic that hurts is per-frame mesh re-uploads. 351,984 distinct poses in 5,000 frames,
1.22x zstd. Content-addressing them buys nothing: a pose almost never recurs.

Content-addressing also costs, on every path:

- a GET each (bottleneck 1), or an inline record each (bottlenecks 2 and 3);
- a hash forever in the host's `carried` set and in every receiver's store (bottleneck 6);
- a store file each in file mode (P3-CAP's writer thread).

**Proposal.** A mesh surface the capture sees updated within the last K frames (default 4) is
*dynamic*. Its bytes travel by mesh id, inline in the transaction, and every other surface keeps
today's content-addressed payload.

- **Table.** The mesh table entry (render-stream-4.md) gains `"dynamic": true` and, per surface,
  `"inline_u8": <offset>|null` into a new transaction block `mesh_u8`. The block holds the same
  GRM1 surface bytes a payload would. A dynamic surface carries `hash: null`; a static one carries
  its hash, as now.
- **Change detection** is the capture's existing per-surface hash. A dynamic surface's bytes go in
  the block only when its hash moved since the connection's base. An unchanged one costs nothing,
  and folds and coalescing need no new state.
- **Transitions.** Static to dynamic happens on the second update within K frames. Dynamic to
  static happens after K quiet frames, when the surface's current bytes go out once more as a
  hashed payload (so the receiver can cache it). A full transaction carries every dynamic surface
  inline.
- **Receivers** upload a dynamic surface's block bytes straight to the mesh RID or GL buffer, and
  never store them by hash. Nothing accumulates, and the GDScript receivers get one message per
  transaction again.
- **Host.** No `carried` entries and no `ServedResources` pins for dynamic surfaces. The per-record
  enqueue disappears, which removes most of bottleneck 2's inline share.
- **Size.** About 71 surfaces × 565 B ≈ 40 KB per combat frame, inside the transaction. Today that
  is the same bytes plus 71 record headers and messages. zstd on the WebSocket is a separate,
  later question.
- **Version.** `/11` already adds an inline float block for multimesh buffers (`mm_f32`,
  particles-multimesh-design.md) for exactly this reason ("spine's per-frame mesh payloads ... are
  the failure mode this avoids"). A `mesh_u8` block and a mesh-table flag share its codec,
  change-detection and receiver-upload machinery. **Recommendation: `/11` = `/10` +
  multimesh + dynamic mesh surfaces.** It needs no version of its own, and `/10` (P3-ST, CG1) stays
  untouched.

**Shared publication for several viewers (capture only, no wire change).**

- Connections in lockstep send byte-identical transactions: the same base seq and the same
  target, with only `seq` and the frame differing in the meta.
- Holding each published `Snapshot` once (`shared_ptr<const Snapshot>`, with per-connection
  `seq`, frame and version passed to `make_patch` and `make_full`, which read nothing else of
  them) removes the per-connection copy and release.
- Keyed pins (`ServedResources` by snapshot, not by connection) remove the string-map churn.
- Caching each inline record's encoded bytes per hash removes the re-encode.
- That is about 22 % of the 3-viewer host profile. It is P3-CAP's "dirty-set publication" type
  change in a smaller form, and it belongs with it.

**Budgeted GDScript cache (receiver only).** `RsResourceCache` should keep a running
`memory_bytes` total and evict along an insertion-ordered LRU (erase and re-insert on touch)
instead of summing and sorting every entry on each add. That makes `RS_RECEIVER_MEMORY_BUDGET_BYTES`
usable under churn on the native receiver and the web export. It is not done here, because it
touches every native gate's receiver path for a setting no gate leg uses at this scale. After the
`/11` change it matters only for textures.

## Validation

- **Remote full tier**
  ([run 40202204835](https://github.com/tfoxy/godot-scene-web/actions/runs/40202204835)) on
  `2b1a334b` (this diff on P3-ST's `8b818b7b`): 17 of 17 runs pass, sabotage legs included (the
  diff names a sabotage in `payloads.rs`'s comments). The runs:
  - pure (6 shards, with the new `self-test-bench-live-scale`);
  - `cargo-rs-core`, with the new `stamped_touch_order_stays_bounded_and_counts_bytes`, and
    `cargo-rs-core-capi`;
  - `bench-instr`: every case within ±0.3 % of the baseline (`g6-inline` −0.27 %);
  - native rust gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8;
  - g7 file groups on GSW and web-rust;
  - g7 live groups g7-2, g7-5, g7-55 and g7-8 on GSW and web-rust.
- **Locally, the runs the remote refuses**: `g7live-gsw` and `g7live-web-rust` group g7-1
  (`RS_VALIDATE_GROUPS=g7-1`, full tier) pass. `gate_passed=true` on both, 866 s and 394 s.
- **Timing groups are deferred to the milestone sweep**: native gate 6, `g7live-*-timing` and g7x,
  plus the timing groups inside the remote runs (g1c-rate, g1d, g2c-pins, g5f, g55f, decode-cost),
  which the remote skips. `bench-live-scale.sh` is a timing measurement too, not a tier target.
- **Rebase.** After the remote run, `main` gained P3-GX (`674c6215`, browser harness only; no file
  in common), and this diff was rebased onto it.

## Deviations

- **One run per configuration, several receivers per game.** The brief allows one run per
  configuration. To keep launches to six, L1–L4 ran three or four receivers on one game, so their
  host frame rates include every viewer's publication cost. The single-viewer legs L5 (GSW) and
  L6 (web export) give the clean product figures. The native receiver has no single-viewer game
  leg; it is not the product receiver, and the fixture bench covers it alone.
- **Credit window 1 at `/9` was not run.** Window 1 against window 2 is measured at `/8` (L3
  against L2) and on the fixture. `/9` changes texture bytes, not the per-frame path.
- **Two candidate fixes were tried and not landed:**
  - GSW fetch concurrency (`RS_RECEIVER_FETCH_CONCURRENCY`). It cut the fixture's first apply by
    25 %, but its STS2 trial is void (the stale bundle link). First-frame latency is a one-off at
    join and mostly bytes, so it is left as a measured option, not shipped.
  - A host knob for the HTTP connection cap: no 503 was seen.
- **Not fixed, designed instead** (bottlenecks 2, 3 and 6):
  - shared publication across viewers;
  - the per-record cost of the GDScript receivers;
  - the budgeted GDScript cache;
  - the dynamic-mesh wire change.
  The wire change is the one that removes bottlenecks 1, 3 and 6 at once.
- **The bench is not a gate group** (as P3-CAP's): a timing measurement belongs to the milestone
  sweep. Its self-test is pure.
- **The live tap was on in every game leg.** It costs the host about 1.6 ms a frame on the fixture
  with 3 connections; the product does not set it. `GRC_EVIDENCE_DIR`'s `resources.jsonl` was on
  too, as in C3 and P3-CAP.

## Evidence

- **Game legs**, sts2-couch-coop's ignored `.sts2/research/render-stream-p3-20261025/c3/legs/`:
  `p3lv-l1` … `p3lv-l6`. Each holds `notes.txt` (`survivors: none`), `steps.txt`, the reference
  shots, `evidence/` (host `perf.json`, `perf-timeline.jsonl`, `live-summary.json`), `tap/live-*.jsonl`
  (stream copies deleted), `rx-*/` (each receiver's `applied.json`, `perf.json`, shots),
  `p3lv-summary.jsonl`, `livecmp.json` and `live-sheet.png`. Hashes are in
  `hashes/compare-p3lv-l*.txt`, all unchanged.
- **Repository** (ignored), `artifacts/render-stream/p3/p3-lv/` in the main checkout:
  - `fixture/<leg>/`: each fixture run's host `live-summary.json`, `perf.json` and
    `scale-report.json`, its tap (`host_tap_live-1.jsonl.gz`) and the receiver's `perf.json`.
    Covers `proto-*` (default, window 1), `def-*` (default, window 2), `inl-*` (inline), `conc*`
    (the dropped GSW fetch-concurrency trial) and `m1-*`/`m3-*` (1 and 3 native receivers, tap on
    and off, and the profiled run);
  - `bench/<receiver>-<config>/`: `bench-live-scale.sh`'s `bench-live-scale.json` and
    `result.json`;
  - `profiles/`: `rs-core-check profile` before and after, for the whole `a8-2` recording
    (`profile-full-*.jsonl`) and the 2,400-frame `capture-scale` recording
    (`capture-scale-2400-*.jsonl`), plus `m3-perf-report.txt`, the 3-viewer host profile;
  - `game/p3lv-l*/`: each game leg's summary, `livecmp.json`, host `live-summary.json`,
    `perf.json`, steps and notes (numbers only; frames stay in the research folder);
  - `tools/`: the harness copy (`harness/`) and the scripts (`leg.sh`, `rx.sh`, `rxhook.sh`,
    `game.sh`, `summ.py`, `gsum.sh`, `mdtab.py`, `livecmp.py`, `multi.sh`, `matrix.sh`).
