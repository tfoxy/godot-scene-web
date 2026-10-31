# INP1: the client's pointer mapping and hit test (2026-10-31)

INP1 is the pointer-mapping half of interaction, the §6 row of
[protocol/client-extensions-design.md](../../protocol/client-extensions-design.md) after TAG1 (the
host sends identities) and TAG2 (the GSW client consumes them through an override table). "As built
(INP1)" there is the spec. A tap at a raised item's drawn centre must reach its game centre: the
client maps the page point to the presentation, finds the topmost drawn item under it, and inverts
that item's effective override so the game receives the point it would have sent itself.

## What changed

**Client package** (`packages/render-stream-client/src/`).
- `pointer.ts` (new): pure functions over a `PictureLayout` — `pictureRect`, `clientToPresentation`,
  `presentationToClient`, `parseObjectFit`, `parseObjectPosition` and `readLayout`. The backing
  store is the presentation 1:1; the product sizes the canvas's CSS box, whose `object-fit`
  letterboxes or crops it. Points on bars or outside the box map to null.
- `client.ts`: `cssToPresentation`, `presentationToCss`, `toGame` and `clientToGame` on
  `RenderStreamClient`, and the `GamePoint` type (`point`, `item`, `drawn`). `toGame` reads the
  wasm's `to_game`; `clientToGame` composes `cssToPresentation` then `toGame`.
- `extensions.ts`: `ItemQuery.hitTest` and `OverrideTable.effective` (the composed override of an
  item and its ancestors, the TS mirror of the core's `E`). `core.ts`/`abi.ts` add `hit_test` and
  `to_game`; the export surface adds `GamePoint` (`export-surface.test.ts`).
- `loop.ts`: `onSession`, so the client keeps the session's presentation size.

**rs-core** (`apply/overrides.rs`).
- `Applier::hit_test(x, y)`: walks the applier's attach list backwards — it is in draw order, and
  each entry's `global_rect` is composed with the overrides — and returns the topmost item whose own
  commands cover the point, tested in the item's own space (a rotated or sheared item is not judged
  by its AABB). It reads records the walk already keeps; nothing is computed per frame.
- `Applier::to_game(state, x, y)`: `E⁻¹ · p` on the hit point, `E = O_n · … · O_1` the item's and
  its ancestors' overrides (nearest first). No item: the point is unchanged and the item is `None`.
  A singular `E` (or `use_identity_transform`) is returned unmapped.
- `OverrideSabotage.inverse_skip`: the `inverse-skip` sabotage (return the point unmapped).
- `override_tests.rs`: 7 INP1 tests (raised, non-overridden, scaled about its pivot, composed
  nearest+ancestors, draw order, transform-only frame, sabotage).

**gsw-rs** (`web/gsw-rs/src/lib.rs`): exports `hit_test` and `to_game`, and parses `inverse-skip`.
The native receiver's core does not expose them (it takes its own input).

**Fixture and legs.**
- `fixtures/tag-scene`: `RS_FIXTURE_TAG_EXPAND` stretches the root `canvas_items`/`expand` from
  640×360, so a `presentation:<W>x<H>` of another aspect is accepted.
- gate 8 group `g8tag2`: `inp` legs (16:9, 21:9 and 4:3 presentations in a 700×500 CSS box,
  letterboxed) plus `sabotage-inverse-skip`. The `inp` extension lifts Card1 by (0, −119) and scales
  Card2 1.24 about its subtree's centre. `lib/gate8-tag2-checks.ts` gains `pointer-map`,
  `pointer-letterbox` and `inverse-skip-caught`.

## Checks

**Package tests** (`pnpm test` for `render-stream-client`): 70/70, `pointer.test.ts` (8) and the
`query.hitTest` extension test included. **Typecheck:** `pnpm typecheck` (TS 7) and
`pnpm typecheck:ts6` (TS 6) both clean. **rs-core** `cargo test`: 152 passed.

**Rust unit tests** (`override_tests.rs`, 7 INP1 tests): the raised tap maps to the game centre, a
non-overridden item maps to itself, a scaled override inverts about its pivot, the nearest override
composes with its ancestors, the topmost item in draw order wins, a transform-only frame follows,
and `inverse-skip` is caught.

**`g8tag2`** (local, 10/10; the INP1 checks): `pointer-map` (16:9 and 21:9 presentations in a
700×500 letterboxed CSS box): a tap at a raised item's drawn point reaches its game point, a scaled
item's likewise, a plain item maps to itself, the vacated spot holds nothing of it, and the shot's
pixel is the item's. `pointer-letterbox`: bars and outside-box points map to null, the picture's
corners map to the presentation's, and `presentationToCss` round-trips an item's rect.
`sabotage-inverse-skip-caught`: the raised and scaled taps fail.

## Pure-client-unchanged (client half)

The pure client (`extensions: []`) never reaches any new code path. The hello is byte-identical
(`extensions.test.ts`: a request-less list sends no `item_meta` key), and the apply/draw path is
structurally unchanged: the rs-core diff adds only on-demand `hit_test`/`to_game` functions and a
default-false `inverse_skip` sabotage field; the loop adds one `onSession` call per session, never
per frame. The real-time apply/draw µs comparison is left to the milestone sweep with the other
real-time numbers, as TAG2 left its draw-µs comparison.

## Validation

- **Local smoke** (validate-increment.sh): pure, the four cargo runs, pnpm-test, native gates −1 to
  5, 55, hc1 and gate 8, and the gate 7 smoke groups pass. `bench-instr` is remote-only (valgrind
  is not installed locally). gate 0 and gate 1 failed once under `-j 3` on `receiver-typed-clean`
  (two concurrent gate runners share `user://receiver_selftest_row_log.json`); each passes in
  isolation (the direct receiver selftest is 85/85).
- **Remote full tier** (scripts/remote-validate.sh --tier full): run 41173706305, 19/20 runs
  pass. The one failure is `g7live-web-rust` g7-5 mesh (`leg-class-live-mesh-stall@web`,
  `receiver-vs-reference@web`) on the runner's llvmpipe — the web-rust twin of the known gsw g7-5
  mesh flakes (p3-fix-common "Known failures"), in a path INP1 does not touch; the refused g7-1
  group passed locally above.
- **Local refused correctness** (g7-1 live, local-only per smoke-map): `g7live-gsw` and
  `g7live-web-rust` both pass.
- Timing runs (native gate 6, g7live-*-timing, g7x) are deferred to the milestone sweep.

## Deviations

- The oracle is the GSW client drawing the `inp` extension against the host's own state, not a
  browser DOM event: `pointer-map` computes each tap's game and drawn point from `query.rect` (game
  coordinates) and the page's own CSS box, then checks the client's mapping against them and the
  shot's pixels.
- `bench-instr` is produced on the hosted runner (valgrind is not installed locally).
- **The probe runs during a frame**, not after the stream ends: the loop's teardown calls
  `core.reset(true)` when the end record is seen, so the applier state is gone by `ended`. `probe()`
  after the end returns what `beforeDraw` stored.
- **`hit_test` returns f64**, not the core's `i64`: wasm-bindgen maps `i64` to BigInt, which the
  page's JSON refuses to serialise.
- **The 4:3 presentation leg was dropped.** Under `expand` a 480×360 presentation scales the
  content by 0.75, so an override's presentation-px translation no longer matches `query.rect`'s
  scaled rect; that is a PRES-A content-scale interaction, not INP1's client letterbox. The 4:3
  letterbox math is covered by `pointer.test.ts` and the 16:9 leg's non-16:9 CSS box.

## Memory-worthy facts

- A worktree's capture and rs-core binaries go stale after a rebase onto a commit that touched
  those sources (PRES-A's `rs_root_query.h`, W13r's `predict.rs`): rebuild `build-capture.sh`,
  `build-rs-core-ext.sh` and the client wasm before any leg, or the legs run the pre-rebase core.
- `validate-increment.sh -j 3` makes gate 0 and gate 1's `receiver-typed-clean` collide on
  `user://receiver_selftest_row_log.json` (both runners run the same Godot selftest concurrently);
  the default `-j 1` is sequential and clean.
- The stream loop's teardown calls `core.reset(true)` on the end record, so a client-side probe
  that reads `query.*` must run during a frame (store it in `beforeDraw`), not after `ended`.
- wasm-bindgen maps a Rust `i64` return to JS BigInt; a `JSON.stringify` of it throws. Return `f64`
  for item ids that must serialise.
- Under `content_scale_aspect = expand`, a narrower-than-content presentation scales the content
  (480×360 → 0.75), so an override's presentation-px translation stops matching `query.rect`'s
  scaled rect; a wider one keeps scale 1. The client letterbox (INP1) and the host stretch
  (PRES-A) are separate concerns.
