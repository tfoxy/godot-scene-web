# TAG2: the GSW client's extension API and override table (2026-10-30)

TAG2 is the second increment of the opt-in client-extension layer
([protocol/client-extensions-design.md](../../protocol/client-extensions-design.md), the TAG2 row
of §6). "As built (TAG2)" there is the spec of what was built and lists where the code moved from
§3. TAG1 ([tag1.md](tag1.md)) made the host send identities. TAG2 makes the GSW client consume
them: a product module selects items by Godot's own tags and changes what is drawn through a
retained override table that rs-core's applier composes in presentation space. A client with no
extension does none of it.

## What changed

**Client package** (`packages/render-stream-client/src/`).
- `extensions.ts` (new):
  - the API types of §3.1 (`RenderStreamExtension`, `ItemMeta`, `ItemMetaBatch`,
    `ExtensionSession`, `ExtensionFrame`, `OverrideTable`, `ItemQuery`, `Affine2D`, …);
  - `mergeWants`, the hello's union;
  - the `ExtensionHost` runtime: the identity table at receipt, `onSession`, `onItemsRemoved` at
    apply, `beforeDraw`, the override table, its dirty copy into the core, and the redraw
    request.
- `loop.ts`: one `if (this.ext)` at each hook (record receipt, transaction receipt, session,
  apply, draw), and the redraw path (`extensionRedraw`: `beforeDraw(null)`, one draw, no ack, no
  credit).
- `hello.ts`: `item_meta` last, only when asked (a `TypeError` below /13). `client.ts` accepts
  extensions (unique ids). `core.ts` and `abi.ts` add the eight core calls.
- The export surface adds `invertAffine`, `mulAffine` and 13 types (`export-surface.test.ts`).

**rs-core** (`apply/overrides.rs` (new), `apply/mod.rs`).
- `cull` composes the table (an `ov` flag read once per walk) and `move_rec` composes it too
  (generic over it, picked once per moved root): `final_xf' = O · (parent_xf · it.xform)`.
- `set_overrides`, `refresh_overrides` (Clean, Deferred, Moved or Walked) and `Why::OVERRIDE`.
- The removed-id log and `inherit_overrides`.
- The queries: `query_item`, `query_subtree_rect`, `query_children`.
- The three sabotages.
- `override_tests.rs`: 9 tests.

**gsw-rs** (`web/gsw-rs/src/lib.rs`): exports `item_meta_json`, `set_log_removed`,
`take_removed`, `set_overrides`, `refresh_overrides`, `query_item`, `query_subtree_rect` and
`query_children`, plus the sabotage names in the start options.

**Fixture and legs.**
- `fixtures/tag-scene`: `RS_FIXTURE_TAG_VARIANT` (`base`, `moved`, `scaled`, `hidden`, `tinted`)
  at step 70, Hand's transform-only move at 80, and `RS_FIXTURE_TAG_PAUSE_MS` at 100. The variable
  unset is TAG1's timeline exactly.
- `web/client-ext-check/` (new page) and `scripts/client-ext-check.ts` (new driver): the package
  with one test extension in the pinned headless Chromium. The page reads the drawing buffer back
  after the stream ends; it forces `preserveDrawingBuffer` in the page only.
- `run-gate8.sh` group `g8tag2` (default), judged by `lib/gate8-tag2-checks.ts`.
- `smoke-map.json`: the page and the driver reach native gate 8.

## Checks (`g8tag2`, local, 7/7; evidence in `artifacts/render-stream/p3/tag2/g8tag2/`)

Every leg runs a headless tag-scene host at /13 (armed late with `GRC_ADOPT=arm` and
`GRC_UNKNOWN_ITEM=skip`, `GRC_ITEM_META=scene,path,meta`) and the client package in Chromium (ANGLE
on the desktop GPU). Each extension selects its item by tag, never by id: Card1 by scene
`res://card.tscn`, path `.` and meta `rs_slot` `1`; its label by path
`CardContainer/DescriptionLabel` and `query.parent` twice; Table and Hand by `res://tag.tscn`
plus path.

| check | result |
| ----- | ------ |
| `override-oracle` | `moved`, `hidden`, `tinted`: 0 px differ from the game's own change. `scaled`: 473 px differ (max 67), all inside the text's ink box, whose four edges agree within 1 px (see below) |
| `identity-override` | an identity override on all 20 tagged items: 0 px differ from no override |
| `override-redraw` | 20 steps, 20 redraws (`beforeDraw` with seq null), 0 messages and 0 acks in the 317 ms window, and the last frame equals `variant-moved` (0 px) |
| `override-dispose-rss` | renderer RSS after dispose, GC and purge: 208.0 MiB (no extension), 209.0 and 209.4 MiB (overrides set): +0.7 % (limit 15 %) |
| `sabotage-override-no-inherit-caught` | Card1's children stay: 15,434 px differ from `variant-moved` |
| `sabotage-override-fast-path-miss-caught` | Hand's transform-only move at step 80 drops Card1's lift: 15,434 px |
| `sabotage-override-no-damage-caught` | the redraw rewrote the rows but never uploaded them: the last frame differs by 15,434 px |

**`scaled` cannot be pixel-equal, by design.** Godot re-rasterizes a scaled Label's glyphs at the
new size; an override resamples the glyphs the atlas holds at 1x (§3.2 "Pixel meaning"). The check
holds what can hold:
- every pixel beyond 1 lies inside the text's ink box;
- the override's ink box `[26,262,68,276]` matches the game's `[26,261,67,275]` within 1 px per
  edge, so the scale and the bottom-centre pivot are the game's.

A wrong pivot, or no scale at all, moves an edge by more than 1 px.

**Two harness facts.**
- **A /12+ live host sends a patch every frame** (991 B on the static fixture; every frame's patch
  carries the shader time), so "no transaction" needs a host that makes no frame. The redraw legs
  sleep the host's main thread for 3 s at step 100.
- **Nothing draws while no transaction arrives,** so a module could not start an animation from
  outside a frame. TAG2 adds `ExtensionSession.requestRedraw()`; the redraw leg starts its lift
  with it.

**Rust unit tests** (`override_tests.rs`, 9/9) hold the same oracle in the applier's paint digest:
- the walk, the redraw path and the rows-only path of a transform-only transaction equal the
  game's change;
- identity overrides change nothing;
- a table changed while a transaction is prepared waits for that apply;
- removed items leave the table and reach the log;
- the queries return the game's transform and rects;
- each sabotage is caught.

The package's own suite: 61/61, `extensions.test.ts` included:
- the hello is byte-identical without a request;
- the union of wants;
- grant and refusal;
- rows resolved and groups shared;
- removals at apply;
- a clean table is never copied;
- 20 redraws with no ack;
- the session's `requestRedraw`;
- module errors are contained;
- the table's math.

## Pure-client-unchanged (client half)

- **Hello:** byte-identical for `extensions: []`, and for an extension list that wants nothing
  (`extensions.test.ts`). No hello and no core start option changes for a client without a request.
- **Per-frame work without an extension:** the loop's five `if (this.ext)` and, in the core, one
  `overrides.is_empty()` per walk and per moved root, plus a bool argument per walked item.
- **Apply µs** (`profile-rs-core-wasm.mjs`, `pm7-a12-1` transcoded to /13, 4,955 transactions,
  3 repeats each, ABBA, each arm under the exclusive quiet lock): see the table below.
- **wasm size:** 2,478,874 → 2,499,040 bytes (+20,166, +0.8 %); gzip +8.5 KB (791,989 →
  800,495); brotli +6.4 KB (580,812 → 587,226). The exports, the queries and the table's map are
  in every build. The first build, with `cull` generic, was 2,505,405 bytes, and the bool argument
  saved 6.4 KB of it.

| arm (order) | apply µs p50 / p95 | apply total | total µs p50 / p95 (no draw) | walk total | assemble total |
| ----------- | -----------------: | ----------: | ---------------------------: | ---------: | -------------: |
| main 1 | 245.9 / 265.2 | 889.0 ms | 532.9 / 565.8 | 275.8 ms | 127.9 ms |
| TAG2 1 | 249.1 / 266.8 | 896.3 ms | 537.6 / 568.2 | 274.7 ms | 138.4 ms |
| TAG2 2 | 247.1 / 262.5 | 895.2 ms | 535.9 / 563.5 | 270.3 ms | 138.4 ms |
| main 2 | 248.6 / 273.5 | 905.6 ms | 537.6 / 578.9 | 285.6 ms | 130.1 ms |

The apply time is within main's own run-to-run spread: p50 245.9–248.6 µs on main against
247.1–249.1 µs on TAG2, and a total of 889–906 ms against 895–896 ms. Two phases moved in opposite
directions. `assemble`, which TAG2 does not touch, is 8 % slower in both TAG2 runs (+10 ms over
4,955 transactions, 2 µs each). The walk, where the override test sits, is not slower (270–275 ms
against 276–286 ms). This reads as wasm code layout, not TAG2's work.

**Draw µs:** the draw path is untouched (`GswRs::draw` and the executor did not change; the loop
adds one `if (this.ext)` before it). The g7-5 GSW live leg's perf-timeline comparison against main
is left to the milestone sweep, with the other real-time numbers.

## Validation

- Local: `g8tag2` 7/7 (above). `cargo test` in rs-core: the 9 override tests, and the whole lib
  suite. The client package suite: 61/61. Biome and tsc (TS 7 and TS 6) are clean on the touched
  package.
- **Remote full tier,** run 41116758699: 19 of 20 runs pass.
  - Passing: `pure`, the three cargo runs, `pnpm-test`, `bench-instr`, native gates −1 to 5, 55
    and 8 (`g8tag2` included, on the runner's lavapipe Chromium), `hc1`, `g7-gsw`, and
    `g7live-gsw` and `g7live-web-rust` (g7-2, g7-5, g7-55, g7-8).
  - `g7-web-rust`: 8 of 9 shards pass. The g7-8 shard hit the runner's watchdog inside
    `check-gate7` after every leg had exited 0. That is the known hosted-runner hang, and g7-8's
    gate 8 sources do not include `g8tag2`. The rerun, run 41129192121, hit the
    watchdog again: two `g8w11/scale/off` receiver legs timed out on the runner, then
    `check-gate7`. The web-rust receiver links rs-core-capi, which does not use the applier TAG2
    changes. The shard ran 770–1,145 s on 10-23 and has grown since. Run locally instead (`run-gate7.sh
    --legs g7-8 --make-sources --receiver web --web-core rust`, the job's own argv): it passes,
    `gate_passed=true`, in 2,222 s.
- **Local, the remote-refused correctness runs:** g7-1 live, run as
  `validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust` (every live group, g7-1
  included): 2/2 pass (`g7live-gsw` and `g7live-web-rust`, rc 0).
- Timing runs (native gate 6, `g7live-*-timing`, `g7x`) are left to the milestone sweep.

## Deviations

- **The oracle is the GSW client drawing the game's variant**, not the host's own framebuffer: both
  arms go through the same executor, so "GSW band" is a pixel-exact (beyond-1) comparison. The
  host runs headless and renders nothing. Gate 7 already holds GSW against the host's shot.
- **`scaled`** is judged by the glyph band above, not by pixel equality (by design).
- **"No transactions" is made by pausing the host,** since a /12+ host sends a patch per frame.
- **`cull` is not generic over the table** (6.4 KB of wasm for one bool test per item).
  `move_rec` is.
- **The core's validator stays `ItemMetaAsk::Unknown`** in the client: passing the request would
  change the pure client's start options.
- **The `item_meta` table lives in TS**, read from the record's meta JSON at receipt
  (`item_meta_json` reads the receive buffer, no copy kept in wasm).

## Memory-worthy facts

- A /12+ live host sends a patch every frame even on a static scene (the shader time). A
  "no-transaction" window needs a host that makes no frame (`OS.delay_msec` in the fixture).
- A born-armed tag-scene streams almost nothing (a 3 KB full); its main-scene items predate the
  arm. Arm it late with `GRC_ADOPT=arm`, as g8tag does.
- The client page can read its canvas back after the stream ends by forcing
  `preserveDrawingBuffer` through a `HTMLCanvasElement.prototype.getContext` wrapper in the page;
  the core's glue then gets the wrapped context.
- A wrapped `GswRs` constructor for a sabotage glue needs `W.prototype = G.prototype`: the loader
  checks the methods on the prototype (`core-load-failed: stale core` otherwise).
- `quiet.sh` is mode 644: `bash …/quiet.sh shared -- …`. Calling it directly fails with
  "Permission denied" and, inside `cmd | grep`, looks like a clean build.
