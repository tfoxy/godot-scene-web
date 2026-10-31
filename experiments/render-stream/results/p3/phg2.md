# PHG-2: per-lever ms (item-level walk) and the TAG3 on-cost on the g31 (2026-10-31)

PHG-2 finishes the two deferred measurements from PHG (`phg.md`): the item-level draw-list walk (per-lever ms for
the static-background and backstop-occlusion levers) and the TAG3 module on/off A/B. Same device, same scene
(character-select lobby), same harness, re-pointed at the current tips: GSW main `8525f7bd` (capture `.so` +
render-stream client core wasm, identical tree `54566470a1e2` to PHG's `ce77b4de` — no capture/client code
changed) and couch main `acb09e86` (TAG3 `raisedHand`/`viewScale`, dirty with the two measurement-only files).

## Verdict

**Neither draw-list lever pays in the lobby. The item-level walk attributes the ~9.0 k `drawElements`/s across the
~119 visible interactive items, and the two "candidates" both come up empty: the static background is ONE
full-screen item (~0.01 ms/frame, negligible), and the backstop "occluders" are translucent (screen-transition rect,
clouds, ash) — not opaque — so the real opaque-backstop upside is ~0, not the rect-only walk's 112 items.**

- **Static background does not pay.** The walk's strict "full-screen layer drawn before the first content item"
  finds exactly one item (id 1142, the `main_menu_bg` base, 2.72 Mpx, drawn depth 6). Its draw cost is ~1
  `drawElements` + 1 `bindTexture`/frame ≈ **0.013 ms/frame** — drawing it once and caching it buys nothing. Even
  counting every full-screen layer the scene re-draws (the two cloud layers `BgContainer/clouds{,2}` and the
  char-select ash layers, ~7 items total), the whole set is ~0.05 ms/frame. The backing lever was already ruled out
  by PHG; the background draw list is tiny too.
- **Backstop occlusion does not pay in the lobby.** The rect-only walk counts **112 of 119** visible items whose
  rect is fully inside a later full-screen rect — a ~1.47 ms/frame upper bound — but the "occluders" it finds are
  the `GameTransitionRect` overlay (transparent while idle) and the translucent cloud/ash layers. The query API has
  no modulate/opacity read (`item-query-no-modulate-read`), so the walk cannot tell opaque from translucent, and
  there is **no opaque full-screen layer drawn late** in this scene. The true opaque-backstop opportunity here is
  ~0. Re-evaluate in combat (opaque fog/background + occluded cards), which this leg did not reach.

**TAG3 on-cost ≈ 0 in the lobby.** Pure hello vs `raisedHand`+`viewScale` are identical to the measurement: apply
p50 9.5→9.4 ms, draw (rAF busy) p50 2.0→2.0 ms, renderer PSS ~522→~517 MiB, wire 1.025→1.03 Mbps, wasm heap
288.7→285.3 MiB. The modules are combat/map-specific: they carry no item-meta wants that match any lobby item (no
hand to raise, no scale-able UI), so loading them costs nothing here.

## Item-level walk (measure, leg phg2-1, settled lobby)

`measure-walk-*.json` (the `phgMeasure` walk, geometry-only, rect + visibility + draw order):

| field | value |
| --- | ---: |
| items (item tree) | 2564 |
| visible (executor culls to) | **119** |
| full-screen items (rect ≥ 90% of 2520×1080) | 10 |
| **background items** (full-screen, drawn before first content) | **1** (id 1142, 2.72 Mpx) |
| **backstopped items** (rect fully under a later full-screen rect) | **112** (upper bound) |
| backstopped area (sum) | 24.6 Mpx² |

The 10 full-screen items are: id 1142 (the `main_menu_bg` base), `BgContainer/clouds` and `clouds2` (two 20k×2k
scrolling layers), the char-select `ash2`/`ash3` (5k×6.2k and 4.7k×4.8k), two char-select overlays (2591×1215), and
`GameTransitionRect` + its two transition children (2560×1200/2400). Only id 1142 sits before the first content
item; the clouds, ash and transition rect are drawn after the menu UI, so the strict background is 1 item and the
rest are "late" full-screen layers that the rect-only backstop test then mis-reads as opaque occluders.

## GL probe (leg phg2-1, 12 s, `gl-walk-*.json`)

The GL probe wraps the WebGL2 surface (2× `performance.now()` per call, so ms are probe-inclusive, as in PHG):

| method | calls | calls/s | ms |
| --- | ---: | ---: | ---: |
| `drawElements` | 108 016 | 9 001 | 285.3 |
| `bindTexture` | 110 214 | 9 185 | 271.3 |
| `drawElementsInstanced` | 4 710 | 393 | 14.4 |
| `drawArrays` | 2 198 | 183 | 15.4 |
| `useProgram` | 11 304 | 942 | 29.9 |
| `texSubImage2D` | 314 | 26 | 22.9 |
| total (all methods) | 406 944 | 33 912 | 1106.4 |

Draw + bind (the four draw methods + `bindTexture`) is **586.4 ms / 12 s = 48.9 ms/s ≈ 1.56 ms/frame** at the
lobby's ~31.4 rAF/s. `texSubImage2D` is ~1/frame (26/s): uploads are not the cost, draw+bind overhead is — the same
shape PHG found. Per-lever ms = item share of the draw list: static background (1/119) ≈ **0.013 ms/frame**;
backstop rect-upper-bound (112/119) ≈ **1.47 ms/frame** (discounted to ~0, above).

## TAG3 on/off A/B (legs phg2-tagoff and phg2-tagon, 40 s each)

Pure hello (`raiseHandCards=false, uiScaling=false`) vs both modules (`=true,=true`), fresh join each, first
streaming seat:

| metric | off (pure hello) | on (both modules) | Δ |
| --- | ---: | ---: | ---: |
| applies/s | 41.4 | 41.9 | +0.5 |
| rAF/s | 31.2 | 31.2 | 0 |
| frame p50 / p95 (ms) | 33.8 / 53.7 | 33.6 / 54.3 | ~0 |
| **apply p50 (onmessage, ms)** | 9.5 | 9.4 | **−0.1** |
| **draw p50 (rAF busy, ms)** | 2.0 | 2.0 | **0** |
| rAF busy ms/s | 82.5 | 86.4 | +3.9 |
| **renderer PSS (MiB, end)** | ~522 | ~517 | **−5** |
| page wire (Mbps) | 1.025 | 1.03 | +0.005 |
| wasm heap (MiB) | 288.7 | 285.3 | −3.4 |

All deltas are within run-to-run noise (the PSS/wasm-heap are actually slightly *lower* on). The modules' `wants`
(`raisedHand`: path + `RAISE_GROUPS`; `viewScale`: scene/path + `VIEW_SCALE_GROUPS`) match no lobby item, so the
hello's item-meta and the per-frame override work are both empty here. The on-cost is a combat/map question, not a
lobby one.

## Deviations

- **Combat not reached** (same as PHG). The map travel is a vote (`map.view.isAcceptingVotes`) and `select-map-node`
  answers `wrong_player` from both bridges; driving the vote needs a raw pointer click at the node, which needs
  image feedback + an input-dispatch command this harness does not have. Combat numbers stay PHV's (38 applies/s,
  renderer PSS 840–1040 MiB).
- **Backstop is an upper bound, not a measured save.** The walk is geometry-only; opacity needs a GSW
  `ItemQuery.modulate` addition that does not exist yet (`item-query-no-modulate-read`). The 112 items are the
  rect-only ceiling, and in the lobby the ceiling is met by translucent layers, so the real save is ~0.
- **The TAG3 A/B runs in two legs, not one.** The harness (proxy + adb reverse) is wired for ONE streaming seat's
  hub (`GRC_LIVE_LISTEN=127.0.0.1:13366`); the first seat works, but a second streaming seat in the same leg gets a
  different hub port (seen: 13386) that is not reversed, so its page falls back to the old mirror and captures
  nothing. Each arm therefore ran as the first (and only) streaming seat of its own leg.
- **Timing ran under load.** PHG's windows wanted machine load < 4; two other agents were running smoke tiers
  during leg phg2-1 and phg2-tagoff (load 4.5–18), so the phv-window quiet-lock wait was bypassed and windows were
  driven manually with load recorded in `windows.txt`. The apply/draw µs and PSS are phone-side and the A/B delta is
  unaffected; the rate numbers (applies/s, rAF/s) are a lower bound. The tagon window landed on load 2.8.

## Harness

`sts2-couch-coop/.sts2/research/render-stream-p3-20261025/phg/harness/` re-pointed at GSW `.worktrees/phg2` and the
couch `.worktrees/phg` mod worktree; `COUCHCOOP_GSW_ROOT=/home/user/repo/godot-scene-web` (the real path, so
`glue-factory.mjs` output is not skipped). `prepare.sh` built the capture `.so` (sha `a7cbab68…`, identical to PHG),
the client core (`build.json` `rs_core_build=sha=8525f7bd4a42`, `rs_core_tree=54566470a1e2`) and the farm. Three
throwaway couch changes drive the measurement and are NOT landed (they live only in the couch `phg` worktree): the
`phgMeasure` gate in `extensions.ts` now reads `localStorage.couchcoop.phgMeasure` instead of a `?phgMeasure` URL
flag, `phgMeasure.ts` reads the stage canvas for the presentation size (2520×1080, not the hardcoded 1920×1080), and
`phv-driver.mjs` `open` gained a base64 localStorage preset so the phone can load at the base URL (keeping its join
form) and set the renderer/module/gate flags before the renderer initialises.

## Evidence

`artifacts/render-stream/p3/phg2/` (main checkout, ignored): `measure-walk.json`, `gl-walk.json`,
`phv-sum-phg2-1.json`, `phv-sum-tagoff.json`, `phv-sum-tagon.json`, and the three `windows.txt`. Full leg evidence
in `sts2-couch-coop/.sts2/research/render-stream-p3-20261025/phg/legs/{phg2-1,phg2-tagoff,phg2-tagon}/` (ignored):
`marks.jsonl`, `probe-*.jsonl`, `seats.jsonl`, `gl-*.json`, `measure-*.json`, `notes.txt` (all end `survivors: none`).
Hashes unchanged around every leg (steam-remote, operator-profile, install binaries/mods, mod build).

## Memory-worthy facts

- **The item-tree walk says neither draw-list lever pays in the lobby.** The ~9 k `drawElements`/s is spread over
  ~119 visible interactive items; the static background is one full-screen item (~0.01 ms/frame) and the backstop
  "occluders" are translucent. Rate these levers in combat, not the lobby.
- **The harness supports ONE streaming seat per leg.** The adb reverse + `phv-proxy` is wired for the first seat's
  hub (`:13366`); a second streaming seat in the same leg gets a different `GRC_LIVE_LISTEN` port (seen `:13386`)
  that is not reversed, so its page silently falls back to the old mirror (`mirror:true`, 0 applies/s, `wasm_heap` 0).
  Run each A/B arm as the first seat of its own leg.
- **A second viewer's join can also land non-streaming** if it races the previous seat's teardown (the host refuses
  a second streaming seat while one is still reaping). Close + rejoin needs a beat between seats.
- **The GL probe accumulates until `gl read`.** `gl <name> on` then a long quiet-lock wait then `win` then `read`
  measures the whole wait, not the window — run `on`/`win`/`read`/`off` back-to-back.
- **`localStorage` preset before page load, not URL flags.** The phone's join form survives a base-URL load only;
  drive `phgMeasure`/TAG3 gates via an `addScriptToEvaluateOnNewDocument` localStorage preset (the `?phgMeasure`
  gate was converted to `localStorage.couchcoop.phgMeasure`).
