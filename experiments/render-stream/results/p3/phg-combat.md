# PHG-COMBAT: re-measure the two draw-list levers in combat on the g31 (2026-11-01)

PHG-COMBAT answers the one question the lobby verdict left open (`phg2-lobby-lever-verdict`): do the
static-background and backstop-occlusion draw-list levers pay in **combat**, where the scene has an opaque
Overgrowth fog/background and cards that might be occluded. Same device (moto g31, adb `ZY22FD8XP3`), same
single-seat PHG harness, re-pointed at current tips: GSW main `7a5f1b90` (capture `.so` sha `a8407ed3…` +
render-stream client core wasm `rs_core_build=sha=7a5f1b90e522`) and couch main `acb09e86` (the KEPT
throwaway `phgMeasure.ts` + the `localStorage` gate, dirty). This is the first PHG leg to reach combat.

## Verdict

**Neither draw-list lever pays in combat.** The client is decode-bound, not draw-bound: `onmessage`
(stream decode + apply) is **391 ms/s = 39.1% of a core**, while the whole draw submission (`drawElements`
+ `bindTexture`) is **~50 ms/s = 5.0% of a core** and rAF busy is **103.8 ms/s = 10.4%**. Both levers only
touch the draw side, so their ceiling is ~5% of a core even in the best case — and in combat neither lever
has a real target: the static background is **6 full-screen Overgrowth layers (~0.03 ms/frame)**, and the
backstop "occluder" that the rect-only walk finds (335 of 351 visible items) is the **transparent
`GameTransitionRect`** drawn last, not the opaque fog/background (which is drawn *first*, behind the cards).

- **Static background does not pay.** The walk's "full-screen layer drawn before the first content item"
  finds **6 items** (the Overgrowth `overgrowth_bg_00_a…_04_a` + `fog2` layers, 6 × 2.72 Mpx = **16.33 Mpx²**,
  drawn depth 9–10 before the first foliage/content). Their draw is ~6 `drawElements` + ~6 `bindTexture`/frame
  ≈ **0.03 ms/frame** ≈ **0.1% of a core** at the ~36 rAF/s this phone holds in combat. Drawing the background
  once and compositing it buys ~0.03 ms of a 12.3 ms/frame main-thread budget. Even counting the whole forest
  subtree (the foliage/lights children that follow the six layers), the save stays well under a tenth of a
  millisecond per frame.
- **Backstop occlusion does not pay in combat.** The rect-only walk counts **335 of 351** visible items whose
  rect is fully inside a later full-screen rect — a **~1.34 ms/frame** upper bound (335/351 × the 50 ms/s
  draw+bind) — but the full-screen layer drawn *after* the cards is `GameTransitionRect` (+ its two
  transition children), which is **transparent while idle** (the same layer that defeated the lobby). The
  opaque Overgrowth fog/background is drawn **first**, behind the cards, so it occludes nothing. The query API
  still has no modulate/opacity read (`item-query-no-modulate-read`), and there is **no opaque full-screen
  layer drawn late** in this scene, so the true opaque-backstop save is ~0.

## Combat input-dispatch (new harness command)

The lobby leg could not reach combat: `dev fixture load <combat>` loads the no-ENet singleplayer path and
tears down the streaming seat. `combat-dispatch.sh <leg>` now drives the real in-game path — embark + map
vote — over the two bridges, and this leg used it (plus a manual re-run after a first-attempt bug):

1. **Ready both players** — readying every player *is* the embark (there is no start-run verb). Host local
   player `p:1` via the host bridge (`cli.sh <leg> act ready`), streaming seat `p:1002` via its own slot-2
   bridge (`MIR3_TARGET=seat cli.sh <leg> act ready`). The lobby `pc-lobby-host` fixture has both players
   `isReady: false`, so both must ready.
2. **Map appears** (`run.currentRoom.scene == "rooms/map_room"`).
3. **Vote the first travelable combat node on both players.** `act select-map-node --node map-node:{row}:{col}`
   maps to the game's `VoteForMapCoordAction`; both the host and the seat must vote (the run moves only on
   "all votes received"). The stable node id is `map-node:{row}:{col}`, **not** the state's point id
   `map-point:{row}:{col}` — the bridge rejects the latter ("requires a visible map node id").
4. **Combat reached** (`run.currentRoom.scene == "rooms/combat_room"`, first node = a `Monster`).

Two addressing traps this encodes (both cost a step on this leg): the `map-node:` vs `map-point:` id, and
"ready" must be checked *per player* (after the host readies, the seat's state shows the host ready too, so
an "any player ready" test wrongly skips the seat).

## Item-level walk (measure, leg phg-combat-1, settled combat)

`measure-walk.json` (the `phgMeasure` walk, geometry-only, rect + visibility + draw order):

| field | value |
| --- | ---: |
| items (item tree) | 5950 |
| visible (executor culls to) | **351** |
| full-screen items (rect ≥ 90% of 2520×1080) | 10 |
| **background items** (full-screen, drawn before first content) | **6** (16.33 Mpx²) |
| **backstopped items** (rect fully under a later full-screen rect) | **335** (upper bound) |
| backstopped area (sum) | 26.64 Mpx² |
| total visible area | 40.24 Mpx² |

The 10 full-screen items are the six Overgrowth background layers (`overgrowth_bg_00_a…04_a` + `fog2`, drawn
first), the `overgrowth_fg_c` foreground layer, and `GameTransitionRect` + its two transition children
(`GradientTransition`, `SimpleTransition`) drawn last. The 6 background layers sit before the first content
item; the `fg` layer is part of the background subtree (drawn before the cards), and the transition rect is
the only full-screen layer drawn after the combat UI — the rect-only backstop test then mis-reads it as an
opaque occluder, exactly as in the lobby.

## GL probe (leg phg-combat-1, ~20 s on→read, `gl-walk.json`)

The GL probe wraps the WebGL2 surface (2× `performance.now()` per call, so ms are probe-inclusive):

| method | calls | calls/s | ms |
| --- | ---: | ---: | ---: |
| `drawElements` | 214 570 | 10 675 | 525.1 |
| `bindTexture` | 201 097 | 10 005 | 459.3 |
| `drawElementsInstanced` | 7 485 | 372 | 27.3 |
| `useProgram` | 52 894 | 2 632 | 119.7 |
| `vertexAttribPointer` | 29 940 | 1 490 | 74.0 |
| `texSubImage2D` | 998 | 50 | 39.5 |
| total (all methods) | 949 597 | 47 244 | 2352.6 |

Draw + bind (`drawElements` + `bindTexture` + `drawElementsInstanced`) is **1011.7 ms / 20.1 s = 50.3 ms/s ≈
1.41 ms/frame** at the ~35.8 rAF/s. `texSubImage2D` is ~1/frame (50/s): uploads are not the cost, draw+bind
is — and draw+bind is only **5.0% of a core**. Per-lever ms = item share of the draw list: static background
(6/351) ≈ **0.03 ms/frame**; backstop rect-upper-bound (335/351) ≈ **1.34 ms/frame** (discounted to ~0, above).

## rAF / apply / trace (leg phg-combat-1)

Clean rAF window (`combat-raf`, 20 s, GL probe off) vs the GL-probe window (`combat-gl`, 15 s), phone viewer
`walk`:

| metric | combat-raf (clean) | combat-gl (probe on) |
| --- | ---: | ---: |
| applies/s | 40.3 | 39.2 |
| new-state draws/s | 24.9 | 24.9 |
| rAF/s | 35.8 | 36.6 |
| frame p50 / p95 / p99 (ms) | 23.4 / 57.4 / 67.3 | 22.2 / 53.9 / 68.4 |
| **rAF busy p50 (ms)** | **2.9** | 8.5 |
| **rAF busy ms/s** | **103.8 (10.4% core)** | 249.2 |
| **onmessage p50 (ms)** | **9.35** | 8.0 |
| **onmessage busy ms/s** | **391.3 (39.1% core)** | 326.5 |
| page wire (Mbps) | 2.749 | 2.728 |
| wasm heap (MiB) | 635.25 | 635.25 |

Chrome trace (`trace-walk.json.gz`, 15 s): `Renderer/CrRendererMain` **0.582** core (decode+apply+draw),
`GPU Process/CrGpuMain` **0.551** core (WebGL command processing — 11.6 s wall of `WebGL`/`CommandBuffer::Flush`
over the 15 s), `GPU Process/CompositorGpuThread` 0.121 core. `CrGpuMain` is the GPU-side submission the
draw-list levers would relieve, and it is entirely `drawElements`/`bindTexture` submission — the 5% figure,
not the 39% decode figure.

## TAG3 on-cost (not reached)

The TAG3 (`raisedHand`/`viewScale`) on-cost is combat/map-specific, so it needs a re-join into the running
combat with the modules on. This leg's attempt to close the `walk` viewer and open a `tagon` viewer
(`raiseHandCards:true, uiScaling:true`) did **not** re-join the combat cleanly: the new page opened and sent a
`ClientLobbyJoinRequestMessage`, but never reached the streaming state (it sat on a non-join screen, no
`joined-drawing` event), while the old slot-2 seat was still reaping. Left for a fresh leg; the two draw-list
levers above are the task's primary verdict and are unaffected.

## Deviations

- **The combat input-dispatch bug on first attempt.** The first `combat-dispatch.sh` run used an
  "any player ready" test, which skipped readying the seat (the host's ready was broadcast to the seat's
  state), so the run never embarked; and the initial vote used `map-point:0:3` (the state point id) which the
  bridge rejects. The script is fixed (per-player ready check; `map-node:{row}:{col}` derivation, both verified
  against the live state) and the leg was driven the rest of the way by hand with the corrected commands.
- **Backstop is an upper bound, not a measured save.** Geometry-only, as in PHG/PHG-2; opacity needs the
  missing `ItemQuery.modulate` read. In combat the ceiling is met by the transparent transition rect, so the
  real save is ~0.
- **The GL probe ran ~20 s, not the 15 s window.** The probe accumulates from `gl on` to `gl read`; the extra
  ~5 s is the `phv-window` quiet-lock wait. Rate figures use the 20.1 s span, so `drawElements`/s is a slight
  underestimate (a tighter back-to-back would be ~13 k/s).

## Harness

`sts2-couch-coop/.sts2/research/render-stream-p3-20261025/phg/harness/` re-pointed at GSW `.worktrees/phg2`
(re-created at `7a5f1b90`) and the couch `.worktrees/phg` mod worktree. Rebuilt from the same commit before
the live seat: the capture (GSW `build-capture.sh`, 46/46 tests, `.so` sha `a8407ed3…`) and the client core
(`build-render-stream-client.sh`, `rs_core_build=sha=7a5f1b90e522`), then `build-local-mod.sh` into the farm,
and the capture re-staged into the farm `ext/`. Three throwaway couch changes drive the measurement and are
NOT landed (they live only in the couch `phg` worktree): the `phgMeasure` gate, `phgMeasure.ts`, and the three
spec-file fixes that type the older throwaway tests against the `7a5f1b90` `OverrideTable.freeze` /
`RenderStreamClient.recording()` additions.

## Evidence

`artifacts/render-stream/p3/phg-combat/` (main checkout, ignored): `measure-walk.json`, `gl-walk.json`,
`phv-sum.json`, `trace-sum.txt`, `combat.png`, `combat-dispatch.log`. Full leg evidence in
`sts2-couch-coop/.sts2/research/render-stream-p3-20261025/phg/legs/phg-combat-1/` (ignored): `marks.jsonl`,
`probe-walk.jsonl`, `seats.jsonl`, `gl-walk-*.json`, `measure-walk-*.json`, `trace-walk.json.gz`,
`combat.cdp.png`, `notes.txt` (ends `survivors: none`). Hashes unchanged around the leg (steam-remote,
operator-profile, install binaries/mods, mod build).

## Memory-worthy facts

- **In combat the client is decode-bound, not draw-bound** — `onmessage` 39.1% of a core vs draw+bind 5.0%
  and rAF busy 10.4%. Both draw-list levers target the 5%, so even a working backstop (it isn't) would cap at
  ~1.3 ms/frame, ~3% of the ~39 ms/frame main-thread budget. This is the durable "NO-PAY" fact.
- **The opaque fog/background is drawn first (behind the cards), not last.** The only full-screen layer drawn
  after the combat UI is `GameTransitionRect`, transparent while idle — the same layer that defeated the lobby.
- **`select-map-node` needs the stable id `map-node:{row}:{col}`**, not the state point id `map-point:{row}:{col}`;
  and both the host (`p:1`) and the streaming seat (`p:1002`) must ready and vote via their own bridges
  (readying every player is the embark). This is the fix for the lobby leg's "select-map-node answers
  wrong_player" deviation — that failure was the id format.
- **Re-joining the streaming seat mid-combat did not work here** (the `tagon` re-open sent a lobby-join request
  and stalled while slot-2 reaped). TAG3 combat on-cost needs a fresh first-seat leg.
- **`phv-sum.py` crashes on trace marks** — the `trace` command writes `{label, phase:begin/end}` marks with no
  `pages` key, which `b["pages"]` chokes on; filter them before running the summary.
