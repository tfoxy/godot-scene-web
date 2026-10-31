# PRES-A: widescreen through the seat running at the viewer's aspect (2026-10-30)

PRES-A of `protocol/client-extensions-design.md` §6 (the `stretchEnabled` row, and answer 2 of
"Answers (user, 2026-10-30)"): the streaming seat launches at `GRC_ROOT_SIZE=presentation:<W>x1080`,
W from the viewer's aspect, capped at 2520, and Godot's own `canvas_items`/`expand` re-lays the game
out. GSW part: a fix plus a proof in g6b. Couch part: couch `222da86e`. Then a live STS2 measurement
at 1920 and 2520 wide, and a review sheet for the user.

## Summary

- **The design's "nothing new" was wrong. A wide `expand` presentation failed at the host.**
  `presentation:2520x1080` of a 1920×1080 `expand` project gives a visible rect of 2520×1080.
  host_size_status compared that rect with `logical_size` (1920×1080), called the session
  `degenerate-visible`, and the capture failed it as `root-size-enforce-failed`. The native
  receiver's `viewport-mismatch` check and both validators' (TS and rs-core) `viewport-entry`
  consistency check made the same assumption. The client core's validator would also have refused
  the session.
  - **The fix** amends gate6-design.md Q3a and render-stream-6.md: the expected visible size is
    the stretch's visible size for `presentation_size`. It is computed in the engine's float32
    arithmetic (`stretch_visible_size`: capture `rs_root_query.h`, rs-core `meta.rs`, TS
    `stretchVisibleSize`).
  - The native receiver checks a `match` session's visible rect against `host_visible_rect`.
  - No byte of any session changes. A session the old rule called `match` is still `match`.
- **A float32 trap.** At H = 1080, Godot floors the expand width to W − 1 for even
  W ∈ {1940, 2234, 2260, 2382, 2504, 2530} in 1920..2600. The result is a 1-px stretch of the whole
  frame. Couch's width rule steps off those widths. rs-core, the TS self-test and couch's C# tests
  all pin the same list.
- **GSW proof (g6b `wide/`):** gate6-hd plus `aspect=expand` at 2340×1080, 2520×1080 and 1170×540
  (the 2340-wide frame at scale 0.5), with a 16:9 control. Results are in "Validation" below.
- **ignore-presentation is a no-op at stretch scale 1.** At 2340×1080, a disabled stretch of the
  window is exactly the expand presentation. So the gating wide sabotage runs at 1170×540, and the
  2340 leg is reported as the no-op (`ignore-presentation-at-scale-1`).
- **STS2's own `expand` does not make it widescreen.** At 2520 the game's UI stays in the left 1920
  columns on every screen visited: the top bar, the HUD, the map, the deck view and the character
  select. The right 600 columns show whatever art happens to extend there. The game's UI root
  evidently does not follow the viewport's visible rect. This is the main input to the user's
  game-side vs client-side comparison (PRES-C); see "Tweak candidates".
- **Cost of 2520 vs 1920 in the same scenes: nothing measurable.** The capture draws the same
  items (the extra columns are mostly the clear colour, or art that was already drawn off-screen).
  Wire, seat main thread and client apply/draw are all within run-to-run noise; table below.

## Measured on a live STS2 streaming seat (`pres-1920`, `pres-2520`)

MIR-3's harness (a real co-op host, `pc-lobby-host` fixture, one viewer in headless pinned Chromium
with renderer = stream and `stretchEnabled` on, the viewport 1920×1080 or 2520×1080). The couch
build is from `222da86e`, with the client core and capture from this worktree.

- Seat logs: `streaming seat launching … presentation=1920x1080 aspect=1.7778 cap=2520` and
  `… presentation=2520x1080 aspect=2.3333 cap=2520`.
- The capture's `root.json`: policy `presentation`, status `match`, visible rect 2520×1080.
- The page's canvas backing store was 2520×1080.

Seat: `/proc` main-thread ticks over a 30 s window per scene, 60 fps (the seat's own profile
lines). Wire: `ss` bytes_sent on the hub port. Client: received transactions per second from CDP,
and apply/draw from a 10 s CDP CPU profile, as inclusive `applyReady`/`drawApplied` µs per
received transaction. One window each, at load 2.7–5.5.

| scene | seat main ms/frame 1920 → 2520 | seat process ms/s | wire Mbps | client tx/s | client apply µs/tx | client draw µs/tx |
| ----- | -----------------------------: | ----------------: | --------: | ----------: | -----------------: | ----------------: |
| lobby (character select) | 1.61 → 1.31 | 141 → 121 | 1.07 → 1.07 | 60.0 → 60.0 | 1072 → 968 | 338 → 289 |
| map | 0.76 → 0.69 | 72 → 70 | 0.13 → 0.12 | 60.0 → 60.1 | 1246 → 1691 | 266 → 295 |
| combat (idle, turn 1) | 2.66 → 2.66 | 219 → 223 | 3.45 → 3.39 | 60.0 → 60.0 | 816 → 786 | 488 → 413 |

- **First frame (join to the stage's first drawn frame):** 13.7 s at 1920 and 14.9 s at 2520.
  Stage mount to first frame was 5.3 s and 5.5 s. That is the seat restart, not the width.
- **Spread of the figures.** The 2520 figures are within ± 25 % of the 1920 ones, in both
  directions, from single windows on a loaded machine; the map's apply time is the largest spread.
  Since the wire bytes are equal, the frame content is the same. The PRES-C comparison should
  treat game-side widescreen in STS2 as costing ~0 per frame on the host, the wire and the client,
  today.
- **Caveat.** It costs ~0 because STS2 draws nothing new in the extra columns. Once its UI root
  follows the viewport (candidate 1), the HUD's anchored parts move but stay the same items. Only
  art that is genuinely wider costs bytes, and only once, as a texture.
- **Not measured:**
  - the GPU host's `perf` (the host's headed instance cannot change aspect, so PRES-A never runs
    there);
  - the g31: the machine was at load 3–9 throughout, against the < 4 condition for phone runs.

## The user's review sheets

`artifacts/render-stream/p3/pres-a/`. Each sheet shows the GSW client's stage canvas, 16:9 (top)
over 21:9 (bottom), at equal height.

- `pres-a-lobby.png`: character select.
- `pres-a-map.png`: the first map.
- `pres-a-combat.png`: the first fight, turn 1.
- `pres-a-deck.png`: the deck view over combat.
- `pres-a-mapview.png`: the map opened over combat.

## Tweak candidates (where STS2's own `expand` looks wrong at 21:9)

1. **Every screen: the UI root stays 1920 wide at the left.** This affects the top bar (its right
   group: timer, map, deck, settings), the HUD, the End Turn and energy widgets, the map parchment
   and legend, the deck grid, and the character select panel.
   - It is one cause for the whole game, so one fix: a couch mod change that sizes STS2's root UI
     Control(s) to the viewport's visible rect, so that Godot's anchors do the re-layout.
   - Needs: find which root STS2 pins to 1920 (not investigated here).
   - It is the precondition for every candidate below being worth judging.
2. **Overlays dim only 1920 columns.** In the deck view and the map overlay, the right 600 columns
   show the combat undimmed beside the dimmed left. The dimmer is a 1920-wide rect.
3. **An off-screen element becomes visible.** The combat's ✓ confirm button sits right of 1920 at
   16:9 (off-screen). At 2520 it is drawn in the extra columns (`pres-a-combat.png`,
   `pres-a-deck.png`, `pres-a-mapview.png`).
4. **Art runs out before 2520.**
   - The combat background covers about 2370 px, so a ~150 px strip on the right shows the clear
     colour.
   - The character-select art ends about 2220 px and another layer shows beyond it.
   - The top bar's texture ends about 2256 px.
   - The map screen's background is black up to 1920 and the clear colour beyond it.
5. **Combat composition.** Creatures, the hand and the intents stay where they are at 1920, so the
   fight sits left of centre. The old mirror spread these (candidate 1 alone does not; see below).

## For PRES-C: what the old mirror's spread did, and what `expand` reproduces

Couch `frontend/src/mirror/spreadLayout.ts` `computeSpread` was the old mirror's 2520-capped
widescreen. Compared rule by rule with what the game-side route gives (Godot's `expand` at the
viewer's aspect):

| old spread rule | the game's `expand` |
| --------------- | ------------------- |
| anchored Controls reproduce Godot's own resize (shift `anchorLeft·Δ`, widen by `(aR−aL)·Δ`) | would be exact for free, but **not today**: STS2's UI root does not widen (candidate 1). After that mod fix it is Godot's own re-layout, exact |
| widened BoxContainer children re-flow (0 / 0.5 / 1 by alignment) | Godot's own container layout, exact once the root widens |
| positional claimers (sprites, cards, creatures, oversized backgrounds, spine and particle anchors) ride a squeeze field `gameX·W/1920`, rigidly per subtree | **not reproduced**: world content keeps its absolute x (combat stays left; candidate 5) |
| pass-through groups pass the budget to each child's own claim | not applicable (no field) |
| owner-anchored floaters ride their owner's shift | exact by construction (the engine positions them) |
| remote followers (a teammate's cursor or targeting indicator) | exact by construction (engine coordinates) |
| scene-identity re-centres (the event background, the card-preview container, full-frame containers on ½Δ) | **not reproduced**: those need per-scene modules (TAG2 overrides) |

So game-side widescreen for STS2 needs:
- candidate 1 (one mod change, after which every anchored rule comes free and exact);
- per-scene modules for the field and the re-centres (candidates 2–5).

The client-side route (PRES-C) needs all of the old rules as client overrides. Cost, against PRES-C:
- the game-side route's per-frame host, wire and client cost of 2520 over 1920 is ≈ 0 (table
  above);
- its one-time cost is a seat restart per aspect (PRES-R, deferred), so a rotation letterboxes.

## Couch part (`222da86e feat(mirror): launch the streaming seat at the viewer's aspect (PRES-A)`)

- The page sends `aspect` on `set-renderer` and on a join with renderer = stream, only while
  `stretchEnabled` is on. It is read from the stage box, or from `window.inner*` before the stage
  mounts.
- The host computes W in `StreamingSeatLaunch.PresentationWidth`: W = clamp(round(1080·aspect),
  1920, cap), made even, then the float32 guard.
- The cap is the host env `COUCHCOOP_RENDER_STREAM_MAX_WIDTH` (default 2520).
- `stretchEnabled` is no longer forced under the new renderer.
- `RenderStreamStage.vue` sizes the canvas from the descriptor's presentation.
- A later aspect change does not restart the seat; it letterboxes (PRES-R, deferred, documented in
  couch's `docs/agents/handoff-mirror-new-renderer.md` §9).
- **The product needs this GSW commit's capture and client core.** The old core's validator refuses
  an `expand` session wider than 16:9, so couch's shipped core and seat capture
  (`build(release)` e13c1192) must be rebuilt from a GSW at or after this commit.

## Validation

- **Native gate 6, locally** (`run-gate6.sh --legs g6a,g6h,g6b`, this build): every g6a, g6h
  and g6b check passes (79/83; the other 4 are the unselected groups), with these wide checks:
  - `wide-presentation-declared`: 4 captures `success`, both sinks;
  - `wide-16x9-byte-identical`: both sinks identical under cmp-rec, apart from the session's
    `stretch.aspect` and `root_size_policy`;
  - `wide-reference-extends-native`: 62.2 M px compared, 27 px within one level, all inside text
    regions on NVIDIA;
  - `leg-class-receiver-wide-*` and `receiver-vs-reference-wide`: budget 0 over 88.2 M px;
  - `leg-class-sabotage-receiver-ignore-presentation-wide`: 15 of 15 shots differ, typed
    `oversampling-mismatch`;
  - `ignore-presentation-at-scale-1`: 0 of 15 shots differ, the no-op as predicted.
- **The GSW half of g7-6, locally** on that source: every judged check passes except
  `source-run-valid@gsw` (a hand-made source has no `gate7-source.json`).
  - `wide-composition@gsw`: 12 / 15 / 0 px within one level in text regions, 0 elsewhere.
  - `presentation-check@gsw`: backing stores 2340×1080, 2520×1080 and 1170×540.
  - `leg-class-sabotage-receiver-ignore-presentation-wide@gsw`: 15 of 15 shots differ.
- **Remote `--tier full`, first run** (run 41124701216, snapshot b070174e on 29d0321c): 20 of 22
  runs pass.
  - **`g7-gsw@g7-6` failed**, with two findings, both fixed after this run:
    - on llvmpipe a wider target moves interpolated mesh colours by one level as well as glyph
      edges, so `wide-reference-extends-native` and `wide-composition@gsw` now allow one level
      anywhere in the base columns, and count it;
    - that failure also failed `source-run-valid@gsw`.
  - `g7live-web-rust@g7-8`: `native13-predict-resync@web`, last applied frame 416 against 420. This
    is the lavapipe pacing failure w13p.md records, outside this diff.
  - `g7-web-rust` (g7-6 included) passed.
- **Remote, second run** (`--only g7-gsw`, the final tree): **passed** — run 41136979467,
  snapshot 56b8fa5 on 82927789; `g7-gsw` rc 0 over 9 shards, 0 failing checks, with the sabotage
  legs included.
- **Locally, the runs the remote refused:**
  - `lock-tests` passes;
  - `g7live-gsw-g7-1` and `g7live-web-rust-g7-1` pass (smoke tier).
- **Deferred to the milestone sweep:** the timing runs (native gate 6's g6l/g6s/g6c, the
  g7live timing runs, g7x).
- **Unit tests:**
  - rs-core `stretch_visible_tests` (2);
  - self-test-gate6, 278/278 including PRES-A's 5;
  - couch's C# and vitest suites (couch commit).

## Evidence

- GSW: `artifacts/render-stream/p3/pres-a/`: the sheets, the two legs' `analysis.json`, the page
  `*.json` and `*.prof.json`, `first-frame.json`, `root-*.json`, steps, and the hash compares.
- Couch research (ignored): `.sts2/research/render-stream-p3-20261025/pres-a/`, with the harness
  (`harness/`: MIR-3's plus a viewport and settings driver, `analyze.py` and `contact-sheet.py`)
  and the legs `legs/pres-1920`, `legs/pres-2520`.
- Profile, cloud, install and mod hashes were unchanged on both legs, and neither leg left a
  surviving process.
