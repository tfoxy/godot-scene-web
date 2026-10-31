# PRES-C: the client-side spread module and the game-side vs client-side comparison (2026-10-31)

PRES-C of `protocol/client-extensions-design.md` §6 (answer 2 of "Answers (user, 2026-10-30)"): the
comparison leg to PRES-A ([pres-a.md](pres-a.md)). PRES-A runs the headless seat at the viewer's
aspect via Godot `expand` and measured ≈0 per frame. PRES-C keeps the game 16:9 and widens the
layout in the browser with a generic "spread" module over TAG2's override table, then writes the
(G) vs (C) comparison the user asked for.

## Summary

- **Built** `@godot-scene-web/render-stream-client`'s `src/spread.ts`: a generic port of the old
  mirror's `computeSpread` rules (couch `mirror/spreadLayout.ts`) that writes TAG2 overrides. The
  scene-identity re-centres and every STS2-specific tweak stay out of GSW (they arrive through the
  product's `shape`/`centerClaim`/`ownerShift`/`followerShift` resolvers), as the design requires.
- **Measured the client-side route's per-frame cost** on a synthetic draw tree of the real live-item
  size (4,202 peak items, client-extensions-design.md §5): ~0.7–0.9 ms/frame of JS walk plus an
  estimated ~4–7 ms/frame of query-API wasm calls, against (G)'s ≈0. Details in "Measured".
- **Two structural limits the module cannot paper over**, both decisive for the comparison:
  1. **The wire has no anchors / container layout / ownership.** The override query (`ItemQuery`)
     reads `parent`, `transform`, `rect`, `subtreeRect`, `visible`, `meta` — not anchor fractions,
     `containerLayout`, `anchorOwnerId` or Control-vs-node classification. The generic rules need
     those, so a product must resolve them from scene identity (a couch module) and hand them in as
     `SpreadShape`.
  2. **The override table cannot widen a box without scaling it.** The table composes one affine per
     item (`transform`/`scale`); a scale on a widened box also scales its flattened children (E
     composes down the tree), which is exactly the tearing the mirror forbids. The module computes
     the widened width and reports it, but writes only the translate shift.
- **Conclusion:** (G) is the default for headless seats; (C) is only for the headed host instance
  (which cannot change aspect), where it is a degraded stretch-and-shift unless the product adds a
  draw-list re-geometry and a batched tree query — both larger than a TAG2 module.

## What changed

**Client package** (`packages/render-stream-client/src/`), all new in `spread.ts` unless noted:

- `SpreadShape` — the per-item structural facts the rules read (anchors, `containerLayout`,
  `anchorOwnerId`, `pointAnchor`, `isControl`). Resolved by the product; the wire's `item_meta`
  carries scene/path/class, not anchors.
- `SpreadDeps` — the scene-identity answers the algebra cannot derive from geometry: `ownerShift`,
  `followerShift`, `centerClaim` (the geometric full-canvas exception defaults to geometry; a
  product adds its own exceptions here).
- `spreadDelta`, `fieldDx`, `containerHAlignFactor` — the pure math: the budget
  `presentationWidth·(1 − presentationWidth/targetWidth)`, the squeeze field
  `clamp(gameX,0,W)·(1 − W/T)`, and the box-alignment factor (0/0.5/1 begin/centre/end for an
  hbox, 0 for a vbox, null otherwise).
- `rootSpreadContext`, `computeSpreadItem` — a faithful port of the mirror's generic branches:
  anchored move (`anchorLeft·Δ`, widen `(aR−aL)·Δ` computed and reported), box-child re-flow by
  alignment, pass-through groups passing the budget, positional claimers riding the centre field,
  the boxed-control ride, owner-anchored floaters and remote followers. At `delta === 0` (16:9)
  every branch short-circuits to the inherited shift, which is 0 at the root.
- `createSpreadExtension` — the `RenderStreamExtension`: collects item ids from `item_meta`
  (`wants: { fields: ["class"] }` by default), walks the draw tree once per frame from the roots
  (iterative DFS), writes `translate(id, dx, 0)` only when `dx ≠ 0`, and clears an override whose
  shift returns to 0. The table keeps only real changes, so a static frame costs the walk and
  nothing else.
- `index.ts` exports the six values and six types; `test/export-surface.test.ts` pins them.

**Coordinate contract.** Overrides are written in presentation space (1920), so the field is
`clamp(gameX,0,W)·(1 − W/T)`. The product displays the presentation stretched to the target box
(the canvas backing store stays the presentation 1:1 — mirror-client-design D12), which turns the
budget back into `T − W` on screen: `(1 − W/T)·(T/W) = T/W − 1`. A 16:9 box (T = W) makes the module
provably inert.

**Why no widen override.** The only widening primitive is a horizontal `scaleAbout`, and an override
scales the item and its descendants (nearest-first composition). Scaling a widened box tears its
flattened children, the very thing the mirror's "width, never a transform scale" rule exists to
prevent. `computeSpreadItem` still returns the intended `width` so a product draw-list change can
use it; the module itself writes only the shift.

## Measured (the prototype)

A synthetic draw tree of 4,202 items (210 screen roots, each a box → controls/sprites/pass-through
groups → sprites, plus point anchors), driven through the real `createSpreadExtension` with a mock
`ItemQuery`/`OverrideTable` (the table's dedup cost is the real one's). Node 24, 120 frames.

- **JS walk + table writes: ~0.7–0.9 ms/frame** (673–883 µs across the two passes). This is the
  module's own per-frame work, independent of how many items actually move.
- **Query-API wasm calls, not in the Node number:** per item the walk makes `query.transform`,
  `query.rect` and `query.children` — the first two each re-run the core's `query_item` (an
  O(depth) transform-chain recompute plus a `Vec<f64>` copy), the third a `Vec<Id>` clone. 4,202
  items → ~8.4k chain walks and ~12.6k allocations per frame. At ~1–1.7 µs/item that is
  **~4–7 ms/frame**, the dominant term, and the reason a production spread wants a batched
  tree-walk query (a new core surface, not this module).
- **Overrides written:** a full spread writes a translate for roughly every visible item that is
  not left-pinned — order ~4,000 of the 4,202 peak live items (the synthetic tree, being
  left-pinned, wrote 483; the walk cost above is what it measures).
- **Apply/draw with the table dirty:** on a frame where items move the table is dirty, so the loop
  copies ~4k entries into wasm and the core re-culls every overridden subtree and rewrites their
  rows — effectively the full re-walk (TAG2's walk is ~56 µs/tx; [tag2.md](tag2.md)). On a static
  frame the table stays clean and the core cost is the pure client's (~245 µs apply, tag2.md).

The real-time browser number for the C route's apply/draw belongs to the milestone sweep, with the
other timing legs; the numbers above are the estimate PRES-C asks for.

## The (G) vs (C) comparison

(G) is PRES-A's measured seat-at-the-viewer's-aspect. (C) is this module's stretch-and-shift.

| | (G) game-side `expand` | (C) client-side spread |
| --- | --- | --- |
| host / wire / client per-frame cost | ≈0 (pres-a.md's live table: lobby 1.61→1.31 ms/frame seat, 1.07→1.07 Mbps, 1072→968 µs apply, 338→289 µs draw; map and combat the same story, all within noise) | ≈0 host and wire; **client main thread ~5–8 ms/frame** (0.7–0.9 ms JS walk + ~4–7 ms query calls), plus a full re-cull on motion frames |
| anchored re-layout | exact, free, once STS2 sizes its UI root to the visible rect (candidate 1 of pres-a.md) | shift exact (translate); **widen not expressible** without scaling the subtree |
| BoxContainer re-flow | Godot's own layout, exact | per-child translate by alignment (expressible), driven by product-supplied `containerLayout` |
| squeeze field / claimers | not reproduced by `expand` (world stays left; candidate 5) | expressible (translate), the module's centre field |
| floaters / followers | exact by construction | expressible (translate) via `ownerShift`/`followerShift` |
| wire change | none | none (shape resolved client-side from identity the product already grants) |
| prerequisites | seat restart per aspect (PRES-R, deferred); a couch mod change (candidate 1) | a couch shape resolver (scene → anchors/container/owner); for parity also a draw-list re-geometry and a batched query |

## Recommendation

- **Headless seats: (G).** It is exact, costs ≈0, and needs only candidate 1 (one couch mod change)
  plus per-scene couch modules for the field and re-centres (pres-a.md's "For PRES-C" table).
- **The headed host instance, which cannot change aspect: (C), but as a degraded spread.** The
  render-stream draw-list client can only stretch-then-shift: it corrects positions but not widths,
  and it pays ~5–8 ms/frame of main-thread work to walk the tree through a query API that was built
  for a handful of tagged items, not a full-tree walk. Reaching the old mirror's native-scale
  re-layout needs a draw-list re-geometry (a widened box's commands) and a batched tree query, both
  larger than PRES-C and outside a TAG2 module.

## Checks

- **Pure-client-unchanged (client half):** the module is a new extension; a client with
  `extensions: []` never builds it (TAG2's "no extension, no work" — [tag2.md](tag2.md)). The
  hello is byte-identical for `[]` and for a wants-nothing list (tag2.md's `extensions.test.ts`).
  The spread module adds no wire bytes when the shape comes from identity the product's own module
  already asked for. The core's apply/draw path is untouched; the override-table composition it uses
  is TAG2's, already sabotage-covered.
- **Unit tests** (`test/spread.test.ts`, 13): the squeeze field and its clamp; box alignment;
  anchored move + widen (0/1, 1/1, 0.5/0.5); the full-canvas 0/0 centre exception; pass-through
  budget passing; the positional centre field; box-child re-flow; owner floater; remote follower;
  and 16:9 inertness for every branch.
- **No new sabotage.** The module is a pure consumer of TAG2's already-sabotaged override table
  (`override-no-inherit`, `override-no-damage`, `override-fast-path-miss`); its own math is pinned
  by the unit tests, and a product-shaped `SpreadShape` cannot corrupt the stream (the host's
  error containment already catches a throwing module — tag2.md).

## Validation

- Package suite: 83/83 (was 70 before this increment; `spread.test.ts` adds 13).
- `pnpm typecheck` (TS 7) and `tsc6` (TS 6) both clean on the package; biome clean on the touched
  files.
- **Smoke tier (local, 6/6 pass in 2220 s):** `pure` rc 0 (736.7 s, the gate1/gate2 self-tests),
  `cargo-gsw-rs` rc 0, `pnpm-test` rc 0, `native-rust-gate8` rc 0 (1286.8 s, g8tag2's client legs
  included), `g7-gsw` rc 0 (g7-0), `g7live-gsw-g7-1` rc 0 (g7-1's 4 representative legs).
- **Remote full tier** (run 41184050553): 6/6 runs pass — `pure` rc 0 (227 s), `cargo-gsw-rs`
  rc 0, `pnpm-test` rc 0, `native-rust-gate8` rc 0 (1239 s), `g7-gsw` rc 0 (1525 s, all 9 groups),
  `g7live-gsw` rc 0 (392 s, g7-2, g7-5, g7-55, g7-8).
- **Local, the remote-refused correctness run:** g7-1 (refused remotely as local-only) plus the
  other live groups, run as `--tier full --only g7live-gsw`: rc 0 (798 s; `gate_passed=true`).
- **Deferred to the milestone sweep:** the timing runs (`g7live-gsw-timing` g7-6/g7-lc/g7-r/g7-k,
  `g7x`) and the per-run timing legs the remote skips (`g1c-rate`, `g1d`, `g2c-pins`, `g5f`,
  `decode-cost`).

## Deviations

- **The module writes only the shift; the widen is computed and reported, not applied.** The task's
  "widen by `(aR−aL)·Δ`" has no non-tearing TAG2 primitive (above). This is the C route's one
  structural limit, documented rather than faked with a scale.
- **The per-frame number is an estimate**, not a real-time leg: the JS walk is measured in Node over
  a synthetic tree of the real item count; the query-API term is estimated from the core's
  `query_item`/`query_children` implementations. The real browser number is a timing leg, deferred
  to the milestone sweep with the rest.
- **Scene-identity re-centres are not in GSW**, per the design ("never in GSW"): `centerClaim`,
  `ownerShift` and `followerShift` are the seams the product's couch module fills.

## Evidence

- `packages/render-stream-client/src/spread.ts`, `test/spread.test.ts`, `src/index.ts`,
  `test/export-surface.test.ts`.
- Smoke tier summary: `artifacts/render-stream/validate/20261031T074054Z/validate-summary.json`
  (gitignored). Remote full tier: `artifacts/render-stream/remote/20261031T081824Z/` (gitignored).
  Local refused g7-1/g7live: `artifacts/render-stream/validate/20261031T082012Z/`.

## Memory-worthy facts

- The extension query API (`query_item`/`query_children`) is per-item and per-call: a full-tree walk
  pays two O(depth) transform-chain recomputes plus two allocations per item. It is built for
  selecting a handful of tagged items, so a spread (or any whole-scene module) should drive a
  batched tree-walk query, not per-item calls.
- The override table has no width-only primitive; `scaleAbout` is the only widening tool and it
  scales descendants, so "widen without reflow" is unrepresentable on the draw-list client.
- `validate-increment.sh` is mode 644: run it with `bash`, not directly.
