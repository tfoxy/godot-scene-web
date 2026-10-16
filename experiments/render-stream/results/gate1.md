## Gate 1a result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T055845Z/` (ignored, not committed;
produced in the G1a worktree). Its `result.json` (`render-stream-gate1-report/1`) has
`gate_passed: true`, with groups `g1a` run and none missing, and 22 of 22 checks pass
([protocol/gate1-design.md](../protocol/gate1-design.md) "G1a"). Every leg classifies as expected.
The hosts are gate 0's: the pinned release template under `--headless`, with the 42-hook library
armed at `scene-init`; and the same template rendering OpenGL 3.3 on the RTX 2060 inside one
private gamescope. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T060059Z/` still passes 19 of 19, with
  `run-gate0.sh` now on the shared `lib/legs.sh`;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T060243Z/` still passes 28 of 28.

**Root geometry.** The capture host's `evidence/root.json` reads:

- logical size 640×360, stretch `disabled`/`keep`/`fractional`, content scale factor 1;
- before the policy, window 64×64 and visible rect `0,0,64,64` (the headless minimum);
- after `Window.set_min_size(640×360)`, window 640×360 and visible rect `0,0,640,360`;
- canvas and final transforms identity both before and after, so `host_size_status` is `match`.

The host fixture's own `root.jsonl` equals the reference's line for line except `display_server`
(`headless` against `X11`). Canvas 1's transform in the recording equals the reference's at all 11
settle transactions: identity through step 9, `1,0,0,1,8,4` at step 10. Without the policy
(`root-size-observe`), the host declares `degenerate-visible` with window and visible rect
64×64.

| Leg                        | Class (expected = measured)            | Measured                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                  | `success`                              | 400 transactions, every status `ok`, 20 item ids in creation order (P=1 … X=19, L2=20); `bytes_total` 2 339 645, `max_record_bytes` 6 924, `encode_ns_total` 5 599 177 (14 µs/frame), `snapshot_ns_total` 1 366 025 (3.4 µs/frame); no GPU device or library opened |
|                            |                                        | all 45 `expected.json` invariants hold on the settle transactions; no draw-index tie in any of the 400 transactions; marker colours first published at frames 1, 11, 21, …, 101                                                                                     |
| `reference`                | support                                | 11 shots, each equal to `synthesizeGate1(k)` exactly                                                                                                                                                                                                                |
| `receiver`                 | `success`                              | 400 seqs applied in order with the host's hashes, 321 RS calls (227 at seq 1); shots at seqs 8, 18, …, 108 equal to the reference and to `synthesizeGate1(k)`: 0 pixels, full frame and all 8 regions                                                               |
| `receiver-headless-trace`  | support                                | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a `fixtures/gate1` file                                                                                                                                               |
| `sabotage-omit-modulate`   | `pixel-mismatch`, steps {1..10}        | step 1: 8 448 px (hierarchy 7 424, marker 1 024); steps 2–10: hierarchy 7 424 each (`P`, `C`, `G` keep their step-0 colours); delta 255                                                                                                                             |
| `sabotage-omit-transform`  | `pixel-mismatch`, steps {2..10}        | step 2: 10 240 px (hierarchy 6 912, order 2 304 = `R1`'s lost recolour, marker 1 024); steps 3–4: 9 216; steps 5–10: hierarchy 6 912 (`R1` is under `Q1` from step 5 and redrawn when re-added at 9); delta 204–255                                                 |
| `sabotage-omit-order`      | `pixel-mismatch`, steps {3}            | step 3: 2 048 px (the 32×32 `Q1`/`Q2` overlap and the marker); steps 4–10 exact again                                                                                                                                                                               |
| `sabotage-omit-visibility` | `pixel-mismatch`, steps {7..10}        | step 7: 7 424 px (visibility 4 096 = `V` still hidden, content 2 304 = `K` not cleared, marker 1 024); steps 8–10: visibility 4 096; delta 153–204                                                                                                                  |
| `root-size-observe`        | `unsupported` (`degenerate-host-size`) | declared `degenerate-visible`, visible `0,0,64,64`; every step mismatches in exactly `corner` (1 024 px) and `corner-degenerate` (1 024 px), with 0 px outside the regions. At step 10 `corner` has 672 px: the shifted `Corner` at 616,332 is clipped to 24×28     |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10).
- Receiver: `receiver/shots/seq-{8,18,…,108}.png`. The per-step diffs
  `receiver/diff/step-<k>.png` are all blank.
- Sabotage: `sabotage-omit-{modulate,transform,order,visibility}/receiver/shots/seq-<n>.png` and
  `…/receiver/diff/step-<k>.png`. For example, `sabotage-omit-order/receiver/diff/step-3.png`
  marks only the `Q1`/`Q2` overlap and the marker.
- Root size: `root-size-observe/receiver/diff/step-<k>.png` marks the missing bottom-right
  `Corner` and the one drawn at 32,32.

### The sabotage predictions, confirmed

Each sabotage drops every mirror mutation stamped with one step's applied frame (`omit-update`).
The engine still renders it.

| Sabotage                                    | Predicted (gate1-design.md)                        | Measured | Why the set ends where it does (engine source)                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omit-update` at 11 (modulate)              | {1..10}                                            | {1..10}  | `modulate` and `self_modulate` are never set again                                                                                                                                    |
| `omit-update` at 21 (transform)             | {2..10}                                            | {2..10}  | `P` and `C` never move again. `R1`'s lost recolour is only repaired at step 9, when re-entering calls `queue_redraw` (`scene/main/canvas_item.cpp:286`), so it cannot end the set     |
| `omit-update` at 31 (order)                 | {3}                                                | {3}      | `move_child` sets child draw indices in the same frame (`update_draw_order`, `canvas_item.cpp:443-444`). At step 4 `Q2`'s z puts it on top in both worlds, and step 5 moves `Q1` away |
| `omit-update` at 71 (visibility)            | {7..10}                                            | {7..10}  | `V` is never shown again in the mirror. `K` is repaired at step 8. `V1` is hidden either way (layer 0 against stale `visible: false`)                                                 |
| `GRC_ROOT_SIZE` unset (`root-size-observe`) | `unsupported`, regions {corner, corner-degenerate} | same     | the `Corner` `ColorRect` lays out against a 64×64 parent rect                                                                                                                         |

Every prediction held on the first run, so no expectation was changed. Two refusal paths were also
run by hand rather than as legs. `GRC_ROOT_SIZE=stretch-it` armed, created no recording and left
`stream.status: "refused"` with the reason. `RS_FIXTURE_STEP_FRAMES=7`,
`RS_FIXTURE_START_FRAME=0`, `RS_FIXTURE_QUIT_FRAME=100`, a relative `RS_FIXTURE_ROOT_LOG` and
`RS_FIXTURE_VARIANT` each print `[fixture] error: …` and exit 2. `S=300, N=60` (the live legs'
timeline) logs step 1 at frame 360 and step 10 at frame 900.

### Findings

- **Root size.** `enforce-min-size` is enough on a headless 4.5.1 host. One ptrcall of
  `Window.set_min_size` at arm grows the root from 64×64 to the logical size. That happens before
  the main scene's `Control`s lay out, so the size-anchored `ColorRect` is pixel-exact. The final
  (stretch × global canvas) transform stays identity. Without the policy,
  the only pixel difference in this fixture is that `Control`.
- **Draw-order ties are transient, not absent, in node-driven scenes.** None of the capture's 400
  transactions has a tie. But a top-level `CanvasItem` gets its index from `_top_level_raise_self`,
  a deferred group call that is queued while the message queue flushes. That is after
  `SceneTree::process`'s last `_flush_ugc` (`scene/main/scene_tree.cpp:708-709`), so it runs at
  the next iteration's first one (`:644`). Measured in this run: step 8's re-raise lands at frame
  82, and step 9's at 92. On frame 91, `L2` still has the RenderingServer default index 0 and the
  re-added `D` its stale 7. They tie with nothing only because step 8 had already moved the other
  top-level items to 10..16. A scratch copy of the fixture that adds a top-level node at step 1
  shows the tie: on frame 11 the new item and `P` both have index 0, and on frame 12 the new item
  has 10. So D7's "node-driven scenes never produce ties" holds only for frames after the raise.
  Once G1b2 reports `draw-index-tie`, any scene that adds a top-level item at runtime will report
  it for that one frame. Child indices (`move_child`, reparenting under an item) are set in the
  same frame. G1b2 has to decide whether such a one-frame tie is item-level `unsupported` or
  something the receiver resolves (the engine's sort is stable up to 16 siblings, so the newly
  appended item is drawn last).
- **Receiver.** The three candidates gate1-design.md listed needed no change: `X` orphaned by a
  raw parent free, `R1` re-appended under an unchanged parent, and `D` re-attached with its old
  id. The applier's free pass, parent pass and order pass already reproduce the engine's
  semantics (receiver shots exact at steps 8 and 9). Mirror unit tests now pin the two
  mirror-side cases (`rs0_mirror_test.cpp`: detach and re-attach keep the id; a raw parent free
  leaves a detached, still addressable child).

### What G1a does not prove

- render-stream/1, patches, the live adapter, credit, stalls, resync and reconnect: G1b–G1d.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture never changes
  them.
- The root-size policy was measured only on stretch `disabled`. `canvas_items` and `viewport`
  hosts declare their stretch but were not run, and the receiver applies no stretch of its own
  (G1b2 declares it on the wire).
- The fixture is still axis-aligned opaque rects on integer pixels (the one rotation is exactly
  90°), with no textures or text.

## Gate 1b result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T070813Z/` (ignored, not committed;
produced in the G1b2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a` and `g1b`
run and none missing, and 34 of 34 checks pass
([protocol/gate1-design.md](../protocol/gate1-design.md) "G1b2"). Every leg classifies as expected.
The capture library, the receiver and both runners now speak
[render-stream/1](../protocol/render-stream-1.md); render-stream/0's encoder, publisher and GDScript
decoder are gone, and its goldens stay as checked history. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T071223Z/` passes 19 of 19 on /1, every capture
  under `GRC_ROOT_SIZE=enforce-min-size` (400 transactions, `bytes_total` 486 354,
  `max_record_bytes` 3 402);
- gate −1: `artifacts/render-stream/gate-minus1/20261009T071402Z/` still passes 28 of 28.

**Full sink against patch sink.** Every gate 1 capture writes both from one mirror snapshot per
frame. For the 400-frame `capture` leg (end records, rounded per frame):

| Sink                          | `bytes_total` | `max_record_bytes` | median / max transaction | `encode_ns_total` | `diff_ns_total`  | `snapshot_ns_total` (shared) |
| ----------------------------- | ------------- | ------------------ | ------------------------ | ----------------- | ---------------- | ---------------------------- |
| full (`recording.rs1`)        | 2 728 254     | 8 078              | 6 532 / 8 078 B          | 8 255 748 (21 µs) | 0                | 3 304 783 (8.3 µs)           |
| patch (`recording-patch.rs1`) | 171 195       | 7 623 (seq 1)      | 354 / 3 496 B            | 878 177 (2.2 µs)  | 1 999 967 (5 µs) | 3 304 783                    |

The patch sink is 6.3 % of the full one. Its seq 1 is the one full transaction (7 623 bytes); the
largest patch, 3 496 bytes, is a step that redraws several items. Resolved, the patch recording
equals the full one at all 400 frames, floats bit for bit.

| Leg                      | Group | Class (expected = measured)            | Measured                                                                                                                                                             |
| ------------------------ | ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                | g1a   | `success`                              | 400 transactions, 21 item ids (P=1 … X=19, T=20, L2=21); all 48 invariants hold; one declared tie, frame 11, harmless                                                |
| `receiver`               | g1a   | `success`                              | shots at the 11 settle seqs equal the reference and `synthesizeGate1(k)`; state dumps at the settle seqs                                                             |
| `sabotage-omit-*` (four) | g1a   | `pixel-mismatch`                       | step sets as at G1a: {1..10}, {2..10}, {3}, {7..10}                                                                                                                  |
| `root-size-observe`      | g1a   | `unsupported` (`degenerate-host-size`) | now declared in the session (`degenerate-visible`, `host_visible_rect` 0,0,64,64) and in every transaction; mismatch only in `corner` and `corner-degenerate`        |
| `receiver-patch`         | g1b   | `success`                              | on the patch recording: the same 11 shots as `receiver`, pixel for pixel; equal state dumps; identical RS calls at all 400 seqs (378 in all)                         |
| `sabotage-omit-free`     | g1b   | `pixel-mismatch`, steps {8,9,10}       | 1 280 px in `lifetime`: the raw `Y` and its child `X` stay drawn; `L`, `M`, `M1` left the tree (`set_parent` to none) before their `free`, so they vanish either way |
| `sabotage-omit-visible`  | g1b   | `pixel-mismatch`, steps {6}            | 6 400 px: `V` and `V1` drawn while hidden; step 7 shows them again in both worlds                                                                                    |
| `sabotage-patch-drop`    | g1b   | `capture-failure` (`patch-divergence`) | the patch sink drops the `Marker` entry at frame 51; frames 51–60 resolve differently from the full sink (the receiver on it shows the stale marker at step 5)       |
| `tie-overlap`            | g1b   | `unsupported` (`draw-index-tie`)       | the same frame-11 tie with a 224×32 `T` over `P` and `Q`'s children, not harmless                                                                                    |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10) and `reference/shots/frame-11.png`.
- Receivers: `receiver/shots/seq-{8,…,108}.png` and `seq-11.png`, the same names under
  `receiver-patch/shots/`; state dumps `receiver{,-patch}/state/seq-<n>.json`.
- Sabotage: `sabotage-omit-{free,visible}/receiver/diff/step-<k>.png`,
  `sabotage-patch-drop/receiver/diff/step-5.png` (the stale marker).
- Tie: `tie-overlap/reference/shots/frame-{11,12}.png`, `tie-overlap/receiver/shots/seq-{11,12}.png`.

### The one-frame draw-index tie, decided

A top-level item added at runtime keeps the RenderingServer default index 0 for one rendered frame
(G1a finding). Fixture step 1 now provokes it: `T` enters at frame 11 while `P` holds 0. The
capture declares exactly one tie in 400 transactions: frame 11, canvas 1, `{P, T}`. On frame 12 the
raise gives `T` 10. The decision (gate1-design.md D7 and G1b2 "As built") is:

- the wire declares every tie, as render-stream-1.md invariant 9 requires;
- the checker classifies a tie by what it can do to pixels. `P`'s subtree paints
  `[79,79]–[209,169]` and `T` paints `[79,303]–[113,337]` (footprints grown by 1 px), which are
  disjoint, so every order paints the same frame. The tie is **harmless**: listed in
  `harmless_ties` (`11:1`), no reason, and the legs stay `success`;
- `tie-frame-pixels` confirms it: `reference/shots/frame-11.png` equals both receivers' shot of
  seq 11 exactly;
- with `T` over `P` and `Q`'s children (`tie-overlap`) the same tie is not harmless and the leg is
  `unsupported`.

The overlap legs also measure what the engine and the receiver actually drew. This is not gated.
The variant reference's frames 11 and 12 differ in 1 536 px: on the tie frame `T` is drawn right
after `P` and under `Q`'s children, and one frame later it is raised over them. That matches the
stable insertion sort of `render_canvas` (`renderer_canvas_cull.cpp:490-493`,
`core/templates/sort_array.h:289-301`), which keeps the appended `T` after `P`. The receiver drew
both frames exactly as the reference did (0 px each). That is the expected outcome for an appended
item in a container of at most 16 siblings. In general (more siblings, or ties between items that
were already siblings) the order depends on each process's sort history, which is why a tie that
can change pixels stays `unsupported`.

### What this proves

- One mirror snapshot per frame feeds a full and a patch sink that resolve to the same state at
  every frame, bit for bit. A receiver replaying the patch recording does the same RenderingServer
  work per transaction and draws the same pixels as one replaying the full recording.
- Transform-only and canvas-only changes travel as `commands: null`: at step 2 only `R1`'s and the
  marker's rects are encoded, and at step 10 only the marker's.
- A dropped patch entry is caught by the full/patch comparison before any pixel is looked at, and
  dropping `free` or `canvas_item_set_visible` from the mirror shows up at exactly the steps the
  engine semantics predict.
- The runtime top-level tie is declared on the frame it happens and only then, and a harmless tie
  costs nothing on screen.

### What this does not prove

- Live delivery, credit, stalls, resync and reconnect (G1c2, G1d). The patch base here is always
  the previous frame of a file stream.
- That ties between items that were already siblings, or in containers of more than 16 children,
  replay in the engine's order. They are declared and classified `unsupported` unless their
  footprints are disjoint.
- The footprint analysis knows only `add_rect`; any unsupported command makes a footprint
  unbounded.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture is still
  axis-aligned opaque rects.

## Gate 1c result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T080634Z/` (ignored, not committed;
produced in the G1c2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a`, `g1b` and
`g1c` run and none missing, and 50 of 50 checks pass
([protocol/gate1-design.md](../protocol/gate1-design.md) "G1c2"). Every leg classifies as expected.
The capture library now links `rs_ws` and serves render-stream/1 live (`GRC_LIVE_LISTEN`); the
receiver has a live mode. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T080454Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T080356Z/` still passes 28 of 28 (the
  library's imports still have no `mprotect` or `mmap`).

**Delivery.** Each live host paces the fixture at 60 frames per second with S = 300, N = 60 and
quits at frame 960; the receiver joins long before step 0 settles (first applied host frame 38,
85 and 40, against 307). Counts from each host's `live-summary.json` and the receiver's
`applied.json`; presented is reported as `"unavailable"` throughout, since Godot gives no
presentation feedback.

| Leg                     | Credit stage | Frames offered | Formed | Sent | Received / applied / submitted (receiver) | Coalesced | Credit round trip p50 / p95 / max |
| ----------------------- | ------------ | -------------- | ------ | ---- | ----------------------------------------- | --------- | --------------------------------- |
| `live`                  | `submitted`  | 923            | 912    | 912  | 912 / 912 / 912                           | 0         | 10.9 / 11.3 / 19.7 ms             |
| `live-headless`         | `applied`    | 876            | 876    | 876  | 876 / 876 / –                             | 0         | 7.1 / 7.6 / 11.6 ms               |
| `sabotage-drop-message` | `submitted`  | 522            | 517    | 516  | 515 / 515 / 515, then `seq-gap` at 517    | 0         | 9.3 / 10.0 / 20.1 ms              |

Host-side ack latency, from the main thread's send to the I/O thread's receipt of each stage's ack
(`live`, p50 / p95): received 8.9 / 9.1 ms, applied 9.2 / 9.3 ms, submitted 10.9 / 11.3 ms. On the
receiver, received → applied takes 0.64 ms (median, max 1.4) and applied → submitted (the next
`frame_post_draw`) 1.8 ms (median, max 10.5). The credit returns within 1 host frame at the
median and 2 at most, so the host sends on 912 of 923 streaming frames (99 %); none of the 11
frames without credit saw the mirror change, so nothing coalesced. Queued bytes never exceeded
7 628 (bound: the largest message, 7 624, + 4 096).

**Bytes.** The live stream is the patch encoding: a 3 405-byte session message (magic included),
seq 1 full at 7 624 bytes, then patches with a median of 354 bytes and a maximum of 3 499 (a step
that redraws several items), and a 258-byte end record: 352 749 bytes for 912 transactions on
`live`. The tap equals the received file byte for byte on `live` and `live-headless`.

| Leg                     | Group | Class (expected = measured)  | Measured                                                                                                                                                                         |
| ----------------------- | ----- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`                  | g1c   | `success`                    | 912 transactions; one shot per step window (seqs 270, 329, … 860), each equal to the reference and `synthesizeGate1(k)`; every live state equals the full recording at its frame |
| `live-replay`           | g1c   | `success`                    | the file-mode replay of `live/receiver/received.rs1`: same 912 seqs and record hashes, identical shots and state dumps at the 11 shot seqs                                       |
| `live-headless`         | g1c   | `success`                    | credit stage `applied` (forced under `--headless`), 876 transactions; under `strace -e openat` it opens nothing under `fixtures/`                                                |
| `sabotage-drop-message` | g1c   | `replay-failure` (`seq-gap`) | the host formed seq 516 at frame 560, tapped it and did not send it; the receiver failed at seq 517 (`seq-gap`), after 5 of the 11 step shots                                    |

g1a and g1b classify exactly as in "Gate 1b result". Images, all under the run directory:
`reference/shots/step-<k>.png`; `live/receiver/shots/seq-{270,329,…,860}.png` with
`live/receiver/state/seq-<n>.json`; `live-replay/shots/seq-<n>.png` for the same seqs;
`sabotage-drop-message/receiver/shots/seq-<n>.png` for steps 0–4.

### Findings

- **A Godot client never reads a message that arrives with the close frame.** The first run's
  live receiver applied 942 transactions and then reported `live-disconnected`: the host had sent
  the end record and close 1000 together, and `WebSocketPeer` returns no packets once its state
  is not `STATE_OPEN` and clears its buffer on a clean close (`modules/websocket/wsl_peer.cpp:654`,
  `:746-752`, `:827-832`, `:843-870`). The host now sends the end record and lingers (up to
  1.5 s) for the receiver to close first; error close reasons repeat the error's reason.
- **A patch after a lost message reported its base, not the gap.** Both decoders checked the
  patch rules before seq continuity, so the drop-message sabotage read `patch-base`. They now
  report `seq-gap` first (golden `invalid/patch-after-gap.rs1`).
- **Typed GDScript is checked only by the debug editor.** The release template ran the live
  receiver happily while the editor's parse of `receiver.gd` failed on one Variant passed to an
  `int` parameter; `receiver-typed-clean` caught it.

### What this proves

- The capture library can serve the stream live from inside the game process without the frame
  callback ever waiting on a socket: encoding stays on the main thread, the I/O thread only moves
  bytes, and one transaction is in flight at a time, by the host's own log and by an independent
  recount from its ack lines.
- Live delivery loses nothing a recording has: every live transaction resolves to the full file
  recording's state at its frame, and a live receiver's pixels equal both the reference and a
  file replay of exactly the bytes it received.
- A lost transaction is caught at the receiver as a sequence gap before anything is drawn from it.

### What this does not prove

- Stalls, coalescing under a slow receiver, resync and reconnect: G1d. The host handles `resync`
  and a second connection (unit-tested), but no leg exercises them, and coalescing never fired
  here because the receiver keeps up.
- Presentation: `presented` is unavailable in Godot; `submitted` is "Godot submitted the frame".
- Rates other than 60 frames per second, more than one receiver, non-loopback serving and
  constrained links (gate 6, gate 2).

## Gate 1d result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T0930Z-g1d/` (ignored, not committed;
produced in the G1d worktree). Its `result.json` has `gate_passed: true`, all four groups (`g1a`,
`g1b`, `g1c`, `g1d`) run and none missing, and 65 of 65 checks pass
([protocol/gate1-design.md](../protocol/gate1-design.md) "G1d"). Every leg classifies as expected.
Runs on the same library:

- gate 0: `artifacts/render-stream/gate0/20261009T090439Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T090340Z/` still passes 28 of 28.

**The stall.** `live-stall`'s receiver takes its step 1 shot (seq 332, host frame 367), then blocks
its main loop for 2 000.05 ms with `OS.delay_msec` before that seq's `submitted` ack. The delay is
injected and declared so (`live.stall.injected`, with the mechanism); it is not GPU-limited work,
and the host cannot tell the difference: it only sees a credit that does not return.

| Measured on the host (`tap/live-1.jsonl`)                       | `live-stall`                                     |
| --------------------------------------------------------------- | ------------------------------------------------ |
| frames simulated between the stalled send and its credit        | 121 (367 → 488), every one logged, 16.67 ms mean |
| fixture steps applied inside the stall                          | 2 (frame 420) and 3 (frame 480)                  |
| transactions sent during the stall                              | 0                                                |
| coalesced callbacks during the stall                            | 68 (one per frame from 420 to 487)               |
| pending targets at once                                         | at most 1 (a flag; the target is the mirror)     |
| oldest pending target                                           | 68 frames, 1 133 ms                              |
| max queued bytes (whole leg / during the stall)                 | 7 628 / 2 361 (bound 11 720)                     |
| max in flight                                                   | 1                                                |
| recovery: first transaction after the credit                    | seq 333, a 2 357-byte patch on seq 332           |
| … sent after the credit arrived                                 | 0 frames (the same callback), 1.4 ms             |
| … its `applied` / `submitted` ack after the credit (host clock) | 3.6 ms / 13.0 ms                                 |
| … equal to the full recording at its frame (488)                | yes                                              |

The coalesced count starts at frame 420, not at the start of the stall: the hub counts a callback
only when the mirror changed since the last send, and this fixture changes the mirror only at step
frames (see "Findings"). Step 2's window (`[427, 479]`) lies wholly inside the stall and is the
only step without a shot, exactly as derived from the host log. The first shot after the stall
(step 3, seq 333) equals the reference and shows all 9 216 pixels step 2 changed inside the stall
(the hierarchy's new transforms and `R1`'s colour) that still show at step 3.

| Leg                       | Group | Class (expected = measured)          | Measured                                                                                                                                                                                                                                   |
| ------------------------- | ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-stall`              | g1d   | `success`                            | 569 transactions; 10 shots, all equal to the reference; step 2 missed inside the stall; numbers above                                                                                                                                      |
| `live-reconnect`          | g1d   | `success`                            | connection 1: 505 sent, closed by the receiver with 1000 after the step 4 shot (seq 505); `dispose` freed 20 of 20 RIDs, 0 left; connection 2: fresh `stream_id`, same `session_id`, seq 1 full at frame 552, 403 sent; 6 shots, all equal |
| `live-resync`             | g1d   | `success`                            | seq 629 (frame 667, step 6's window) refused unapplied, acked `received` only; the host credited the `resync` and sent seq 630 full (`base_seq` null); 2 full transactions in 922; every shot equal                                        |
| `live-receiver-killed`    | g1d   | support                              | headless receiver SIGKILLed at host frame 601; the host's connection closed 1006 (connection reset) after frame 602; the fixture quit at 960, exit 0, both file sinks complete                                                             |
| `sabotage-ignore-credit`  | g1d   | `delivery-violation`                 | from frame 488 (the receiver's 500 ms stall after its step 3 shot) 38 sends without credit, up to 31 in flight; nothing before the sabotage frame 480                                                                                      |
| `sabotage-stale-coalesce` | g1d   | `delivery-violation` (`stale-state`) | the first post-stall transaction (seq 330, frame 488) carries frame 420's state (`stale_from: 420`); its step 3 shot also differs from the reference (2 048 px)                                                                            |

g1a, g1b and g1c classify exactly as in "Gate 1c result". Images, all under the run directory:
`live-stall/receiver/shots/seq-{…,332,333,…}.png` (step 1 before the stall, step 3 after it),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 5–10 on connection 2),
`live-resync/receiver/shots/seq-630.png` (step 6, the full transaction after the resync) and
`sabotage-stale-coalesce/receiver/shots/seq-330.png` with `diff/step-3.png`.

**Acks and bytes.** Credit round trips on the host clock (send → the credit-stage ack's receipt),
p50 / p95: `live-stall` 7.3 / 18.4 ms outside the stall (max 2 015 ms, the stall),
`live-reconnect` 13.8 / 14.5 ms and 14.4 / 14.7 ms (connections 1 and 2), `live-resync`
6.8 / 7.1 ms. The g1c `live` leg measured 16.7 / 17.2 ms in this run against 10.9 / 11.3 ms in the
G1c2 run: a rendered receiver's `submitted` stage follows the private gamescope's frame timing,
which varies between runs; the credit still returned within 1–2 host frames. Bytes are G1c2's:
patches of a few hundred bytes, the stall's recovery patch 2 357 bytes (two steps' changes at
once), a fresh connection's seq 1 about 8 KB. On the host, one snapshot copy costs about 14 µs per
frame, a patch diff about 7 µs and its encoding about 2 µs (the ignore-credit host's end stats).

### Findings

- **The contract's `coalesced` bound assumed a mirror that changes every frame.** The hub counts
  a coalesced callback only when the mirror changed since the last send (Q4), and the fixture
  changes it only at step frames, so a 121-frame stall coalesced 68 callbacks (from step 2's frame
  to the credit), not "stall frames − 2". The check measures from the first in-stall change, and
  requires one coalesced callback per pending frame line.
- **ignore-credit is unobservable against a receiver that keeps up.** With credit returning in
  well under a frame (p50 8.5 ms in the first full run), a host that ignores credit sends exactly
  what a correct host sends, and that run classified the sabotage `success`. The leg now gives its
  receiver a 500 ms stall after the step 3 shot, which ends before step 4's window: the host keeps
  sending into it, 31 in flight.
- **stale-coalesce is visible only because a step lands before the credit.** The stale copy is
  frame 420's state; it differs from the newest state at the credit (488) only through step 3
  (480). A stall that ended 8 frames sooner would hide the sabotage and fail its leg check.
- **A reconnect's first stream stops short of the host's tap.** The host sends the next
  transaction as soon as the reconnect step's `submitted` ack returns the credit; the receiver
  closes without reading it. The received stream is a byte prefix of the tap, without an end
  record, and the checker requires exactly that.

### What this proves

- A receiver that stops reading for two seconds costs the host nothing it would not spend anyway:
  the simulation runs at 60 frames per second throughout, nothing is serialized for a target the
  receiver will never see, at most one transaction is in flight and one target pending, and the
  queue never grows past one message.
- The receiver catches up in one transaction to the newest state, including changes made while
  it was stalled, and draws exactly the reference afterwards.
- `resync` turns a refused transaction into one full transaction on the same stream; a reconnect
  is a fresh session that owes nothing to the old stream, with every receiver RID freed in
  between; a receiver killed mid-stream leaves the host and its recordings intact.
- A host that ignores credit, or that coalesces to a stale target, is caught by the checker.

### What this does not prove

- GPU-limited receivers: the stall is an injected main-loop block, and `submitted` is "Godot
  submitted the frame", not presentation or GPU completion (gate 6 measures those).
- Resources (no textures yet: pinning in-flight resource versions is gate 2), more than one
  receiver, arm-on-first-subscriber, non-loopback serving, other rates and constrained links.

## Gate 1e result (2026-10-09)

**Pass.** Calibrator 4 hooks `canvas_item_set_z_as_relative_to_parent` (slot 483) and
`canvas_item_set_draw_behind_parent` (slot 460), feeding the mirror's `z_relative`/`behind` fields
that render-stream/1 already carried since G1b1 (and the receiver already applied). Both leave
the session's `unobserved` list. G1e was built on G1b2 and integrated after G1c2 and G1d; the runs
below are on the integrated tree (ignored, not committed):

- gate −1: `artifacts/render-stream/gate-minus1/g1e-onto-main/` passes 28 of 28, 44 hooks planned,
  none omitted (the `older-record-loads` leg's calibrator-1 record still omits 36 and arms);
  `optional-hook-counts` includes both new hooks (the spike's post-arm `Node2D` sets non-default
  `z_as_relative`/`show_behind_parent`, so the setters' early return on an unchanged value does
  not skip the `RenderingServer` call).
- gate 0: `artifacts/render-stream/gate0/g1e-onto-main/` passes 19 of 19, `hooks_planned` exactly
  the 44 names.
- gate 1, all four groups, run twice: `artifacts/render-stream/gate1/g1e-onto-main-run1/` and
  `…-run2/` each pass 65 of 65, every leg at its expected class.

**Fixture.** Two appended steps, each adding new top-level items (so each ties with `P` at index 0
for one frame, as `T` does at step 1):

- step 11: `ZP` (z_index 1, draws nothing) with child `ZC` (z_index −1, `z_as_relative = false`,
  so its effective z is −1, not 0 — its own z_index alone, ignoring the parent's).
- step 12: `ZB` (a new top-level sibling at effective z 0, overlapping `ZC` by 32 px — the overlap
  shows `ZB`, which proves the receiver applied step 11's setter) and `BP`/child `BC`
  (`BC.show_behind_parent = true`, overlapping `BP` by 32 px — the overlap shows `BP`, not `BC`).

`ZB` is deferred to step 12 rather than joining `ZP` at step 11: two new top-level items entering
the same frame tie with each other too (not just with `P`), and a tie's harmlessness is a
footprint check over each member's whole subtree — `ZC`/`ZB`'s by-design overlap would have made
that tie `unsupported`. A step apart, `ZP` and `ZB`/`BP` each only tie with `P` (disjoint
footprints, harmless), and `ZC` — not top-level — never ties with `ZB` at all. Measured:
`draw-index-ties` reports 3 ties, all harmless (frame 11 `{P,T}`, frame 111 `{P,ZP}`, frame 121
`{P,ZB,BP}`); `tie-overlap` still finds only frame 11's not harmless.

**Sabotage step sets, extended.** The sabotages whose dropped state is never reset by a later step
now mismatch through steps 11 and 12 too (measured): `sabotage-omit-modulate` {1..12},
`sabotage-omit-transform` {2..12}, `sabotage-omit-visibility` {7..12}, `sabotage-omit-free`
{8..12}. `sabotage-omit-order` ({3}) and `sabotage-omit-visible` ({6}) are unchanged: both
re-converge with the reference before step 11.

**Patch sink**, the same 400-frame capture: full 3 252 541 B (max record 8 447), patch 175 125 B
(max record 7 623); median transaction 8 379 B full against 354 B patch. Resolved, the patch
recording equals the full one at all 400 frames.

**Live timeline, re-derived by running.** The fixture's default quit is now `S + 12N + 11`, so the
live hosts' `S + 11N` (960) would be refused; they quit at `S + 13N` = 1080, and the receivers
shoot 13 windows, step 12's being `[1027, 1080]`. Everything G1d measured lies before step 4 and
is unchanged in both runs:

| Measured (run 1 / run 2)                    | Value                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-stall`: stalled send → credit         | 367 → 488 / 367 → 489; steps 2 (420) and 3 (480) inside; coalesced 68 / 69 from frame 420; recovery patch 2 357 B, 0 frames after the credit              |
| `sabotage-stale-coalesce`: first post-stall | frame 489, frame 420's state (`stale_from`), step 3 shot 2 048 px off, in both runs; run 2 also caught an ordinary-gap stale copy at frame 361 (step 1's) |
| `sabotage-ignore-credit`                    | violations from frame 480 / 488 (sabotage frame 480); 49 / 33 sends without credit; up to 32 / 33 in flight                                               |
| `live-receiver-killed`                      | killed at host frame 601, closed 1006, the fixture quit at 1080, both sinks complete                                                                      |
| `live`                                      | 1 020 / 1 044 transactions, 13 shots equal to the reference; two more harmless one-frame ties (frames 960 and 1020)                                       |

The step-3-before-credit margin `stale-coalesce` depends on (step 3 at 480, credit at 488–489) is
untouched: steps 11 and 12 come after every G1d event.

**What this does not prove.** A new top-level item's tie with an existing one other than `P`, or
two new top-level items whose subtrees are disjoint but which overlap a third tied member — neither
is exercised.

## Gate 1 summary

Gate 1 passes as of 2026-10-09 with all four groups in one run (65 checks): G1a, G1b2, G1c2, G1d
and G1e, built on G1b1's codecs and G1c1's WebSocket server (G1e's calibrator 4 adds no check of
its own; it extends the fixture, the hook set and the sabotage step sets).

What gate 1 proves, on the pinned 4.5.1 release template under `--headless`:

- **Retained state (1a).** Parent/child transforms and modulation, transform changes without a
  redraw, draw order (index swap, z over index, reparent, same-parent re-append), visibility and
  layer culling, content replacement and clearing, create/free/recreate and detach/re-attach, and a
  canvas transform, and (1e) `z_as_relative_to_parent` and `draw_behind_parent`: thirteen steps,
  each pixel-exact against the rendered reference and an image painted from `expected.json`, each
  sabotage failing at exactly its predicted steps.
- **Root geometry (1a).** The headless host's degenerate 64×64 root is declared, never guessed;
  `GRC_ROOT_SIZE=enforce-min-size` makes it match the 640×360 logical size.
- **render-stream/1 (1b).** Patch transactions resolve bit for bit to the full snapshots of the
  same frames and cost the receiver the same RenderingServer calls; a corrupt patch is caught as
  `patch-divergence`. The one-frame draw-index tie of a top-level item added at runtime is
  declared on the wire and classified by its effect.
- **Live delivery (1c).** The capture library serves the stream from inside the game process over
  its own loopback WebSocket server, encoding on the main thread at the frame boundary, one
  transaction in flight, credit returned from the receiver's paced render loop; live pixels equal
  the reference and a file replay of the received bytes; a lost message is a sequence gap.
- **Slow receivers (1d).** Stall, coalescing to one pending target, newest-state recovery,
  resync, reconnect and receiver loss, as above.

Unsupported or deferred, by design: textures and every resource payload (gate 2), clipping
semantics (gate 3), `viewport_set_global_canvas_transform`, `canvas_set_modulate`, y-sort, light masks and texture
filter/repeat (in the session's `unobserved` list), equal-draw-index ties that can change pixels
(`draw-index-tie`, unsupported), a degenerate host size (`degenerate-host-size`, unsupported),
arm-on-first-subscriber and late join (gate 8), more than one receiver, publication-rate control
and real presentation timing (gate 6), non-loopback serving and authorization (gate 2).

Costs, measured on the gate 1 hosts (60 frames per second, the 21-item fixture before G1e, 26 since): one mirror
snapshot copy per frame, about 14 µs; a patch diff about 7 µs and its encoding about 2 µs; a
transaction is a few hundred bytes (about 350 KB for 900 frames), a full snapshot about 8 KB; the
credit round trip is 1–2 host frames for a rendered receiver (`submitted`) and about 1.5 ms for a
headless one (`applied`); the receiver applies a transaction in about 0.6 ms (median, G1c2). The
hook itself stays armed for the whole session (D6), a cost gate 1 does not measure.

