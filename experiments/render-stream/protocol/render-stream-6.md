# render-stream/6 wire format

Status: specified and golden-tested at G6w (2026-10-11); since G6b (2026-10-11) the capture, the
receiver and every gate runner speak render-stream/6 (gate6-design.md D1, D19, "As built (G6b)").
Written with [gate6-design.md](gate6-design.md) Q4, which this document implements. Codecs (G6w): C++ encoder/diff (`capture/src/rs2_codec.*`, `rs2_diff.*`, behind
`Session::version`), TypeScript decoder/validator/resolver (`scripts/lib/render-stream-2.ts`,
behind an explicit `version` parameter) and GDScript decoder (`receiver/rs2_decoder.gd`), all
checked byte-for-byte and state-for-state against `protocol/golden-6/`, per this text.
[render-stream-5.md](render-stream-5.md) and, through it, render-stream-4.md, render-stream-3.md,
render-stream-2.md and render-stream-1.md are not superseded: `golden-2/` through `golden-5/` keep
passing unchanged (gate6-design.md D1).

As with /3 to /5 (memory g4e1-rs3-version-switch-pattern), /6 is **not** a new forked module. The
version-parameterized C++/TypeScript/GDScript modules /5 already extended grow a fifth value:
C++'s `Session::version` gains `ProtocolVersion::V6` (still defaulting to `V2`, so every existing
/2/3/4/5 caller is unaffected), and the TypeScript/GDScript `version` parameter widens to
`2 | 3 | 4 | 5 | 6` (G6w carried /5's default forward; G6b made `6` the default in both, when the
capture and the receiver switched). Renaming `rs2_codec.*`/`rs2_diff.*`/`render-stream-2.ts`/
`rs2_decoder.gd` is not part of this document.

render-stream/6 is render-stream/5 plus exactly:

- a new magic, protocol string and subprotocol;
- three new `viewport` keys (`presentation_size`, `font_oversampling`, `snap_2d`) and a new
  `root_size_policy` value (`presentation`);
- a new session key, `publication` (rate control), distinct from `features.publication`;
- two new canvas keys, `layer` and `sublayer`;
- five new session-level ("item": null) `unsupported` reasons: `canvas-stacking-tie`,
  `canvas-repeat`, `canvas-follow-viewport`, `global-canvas-transform`, `snap-2d`;
- `features.canvas_state` gains `"layer"`; `observed_unsupported_ops` gains three ops;
  `unobserved` loses two and gains one (see "Features" below);
- `extra-canvas` no longer occurs for a canvas attached to the root viewport, and /6 decoders
  reject it outright (mirroring how /5 rejects `unsupported-state` for `canvas_item_set_material`).

Everything this document does not change is exactly as in render-stream-5.md and, through it,
render-stream-4.md, render-stream-3.md, render-stream-2.md, render-stream-1.md and
render-stream-0.md: record framing, the `u8`/`f32`/`i32`/`f64` block types, the record sha256
definition, canonical JSON (except the one new JSON-embedded float, "As built" below), the texture,
mesh, shader and material tables and their invariants, every payload format, out-of-band delivery
and HTTP, and patch/resolve semantics. **Transactions, blocks, items and commands are
byte-identical to /5** apart from the new canvas keys above -- nothing about an item, a command, a
texture, a mesh, a shader or a material changes at /6.

## File layout

```
magic        8 bytes   47 52 53 36 0D 0A 1A 0A   ("GRS6\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /6 refuses `GRS5` (or any other byte 3) with `bad-magic`. A decoder
configured for /5 continues to refuse `GRS6` the same way it already refuses `GRS4`.

## Session record

Key order: `type`, `protocol`, `session_id`, `stream`, `engine`, `capture`, `viewport`,
`resources`, `materials`, `features`, `publication`, `sabotage`, [`unknown_item_policy`], `blocks`
-- /5's order with one new key, `publication`, immediately after `features`. `protocol` is
`"render-stream/6"`.

### Viewport

```json
"viewport":{"canvas_cull_mask":<int>,"root_canvas":<int>,"logical_size":[<int>,<int>],
            "stretch":{"mode":"disabled"|"canvas_items"|"viewport",
                       "aspect":"ignore"|"keep"|"keep_width"|"keep_height"|"expand",
                       "scale_mode":"fractional"|"integer"},
            "stretch_applied_by":"receiver",
            "root_size_policy":"observe"|"enforce-min-size"|"presentation",
            "presentation_size":[<int>,<int>],
            "host_size_status":"match"|"degenerate-visible"|"degenerate-window",
            "host_window_size":[<int>,<int>],
            "font_oversampling":<number>,
            "snap_2d":{"transforms":<bool>,"vertices":<bool>}}
```

Three keys are new, in this order: `presentation_size` (right after `root_size_policy`, before
`host_size_status`), and `font_oversampling`/`snap_2d` (after `host_window_size`, at the end of the
object). Every other key and value is exactly as render-stream-5.md's `viewport`.

- `root_size_policy` gains the value `"presentation"` (gate6-design.md D2, Q3a):
  `GRC_ROOT_SIZE=presentation:<W>x<H>` makes the headless root window W×H before the main scene
  lays out, so the engine itself computes the stretch transform, the font oversampling and the
  `StyleBoxFlat` antialiasing feather of a W×H window.
- `presentation_size` equals `logical_size` unless the policy is `"presentation"`, in which case it
  is the policy's declared W×H. `host_size_status` follows gate6-design.md Q3a: `"match"` iff
  `host_window_size == presentation_size` and the visible rect's size equals `logical_size`;
  `"degenerate-visible"` iff the visible size differs from `logical_size`; `"degenerate-window"`
  otherwise.
  **PRES-A amendment (gate6-design.md Q3a):** "`logical_size`" in this rule reads "the stretch's
  visible size for `presentation_size`", which is `logical_size` except under `canvas_items` with
  aspect `expand`, `keep_width` or `keep_height` at another aspect (wider or taller, in the engine's
  float32). No byte of any session changes.
- `font_oversampling` is `Viewport.get_oversampling()` (a float32, always positive) -- the ONLY
  JSON-embedded float this wire carries (see "As built" for its canonical decimal form).
- `snap_2d` carries the root's `snap_2d_transforms_to_pixel`/`_vertices_to_pixel` project settings
  (gate6-design.md D17), read once at arm; a runtime change to either stays `unobserved`
  (`viewport_set_snap_2d_transforms_to_pixel`/`_vertices_to_pixel` are unhooked).

New invariant, `viewport-entry`: `presentation_size` must equal `logical_size` unless
`root_size_policy` is `"presentation"`; under `"presentation"` with `stretch.mode` `"disabled"`,
`presentation_size` must still equal `logical_size` (a presentation declared under `disabled`
stretch that differs from the logical size would change layout -- `root-size-invalid`,
gate6-design.md D3, is the capture-side refusal for that case, never observed on the wire as a
published session); `host_size_status` must be consistent with `host_window_size`,
`presentation_size` and the `host_visible_rect` session block, per the rule above; and
`font_oversampling` must be a positive number.

### Publication

A new session key, right after `features` (gate6-design.md D8):

```json
"publication":{"mode":"every-frame"|"rate","target_fps":<int 1..240>|null}
```

`GRC_PUBLISH_FPS=uncapped` (the default) and every file sink encode `"every-frame"`/`null`. A live
connection with a positive target encodes `"rate"` and that target. New invariant,
`publication-entry`: `"every-frame"` must carry `target_fps: null`; `"rate"` must carry an integer
`target_fps` in `1..240`; `"rate"` never occurs on a `file` stream (`session.stream.transport`).

### Features

- `canvas_state` gains `"layer"`, re-sorted: `["layer","modulate","transform"]`.
- `observed_unsupported_ops` gains `canvas_set_item_mirroring`, `canvas_set_item_repeat` and
  `canvas_set_parent`, re-sorted.
- `unobserved` loses `viewport_remove_canvas` and `viewport_set_global_canvas_transform` (both now
  hooked and session-level-observed) and gains `canvas_set_disable_scale` (calibrator 9 hooks its
  five siblings but leaves slot 440 unhooked), re-sorted.
- Every other `features` key is unchanged.

## Canvas

Key order: `{"id","origin","role","attached","layer":<int>,"sublayer":<int>,"items"}` -- /5's
shape with two new keys, right after `attached` and before `items`. `canvas_f32` is unchanged (10
floats: transform, modulate) -- `layer`/`sublayer` are plain JSON integers, never block floats.

- The root canvas and every unattached canvas carry `layer: 0, sublayer: 0` unless a
  `viewport_set_canvas_stacking` call set something else. `viewport_attach_canvas` resets a
  canvas's stacking to `(0, 0)` (`rv.cpp:1265-1266`): a freshly (re)attached canvas's `layer`/
  `sublayer` are `0, 0` in that same transaction, whatever they were before detaching.
- New invariant, `canvas-entry`: `layer` and `sublayer` must both be integers (any sign; the
  renderer's own `stacking = sign(layer)·(|layer| << 32) + sublayer` ordering, gate6-design.md
  Q1e, places no range limit on either on the wire).

## Session-level unsupported reasons

Five new entries, each `"item": null`, present in every transaction while the condition holds
(ordered by first observation among session-level entries, as /0's rule; every session-level entry
still sorts before every item-level one):

```json
{"op":"viewport_set_canvas_stacking","item":null,"reason":"canvas-stacking-tie"}
{"op":"canvas_set_item_mirroring"|"canvas_set_item_repeat","item":null,"reason":"canvas-repeat"}
{"op":"canvas_set_parent","item":null,"reason":"canvas-follow-viewport"}
{"op":"viewport_set_global_canvas_transform","item":null,"reason":"global-canvas-transform"}
{"op":"viewport_set_snap_2d_transforms_to_pixel"|"viewport_set_snap_2d_vertices_to_pixel",
 "item":null,"reason":"snap-2d"}
```

- `canvas-stacking-tie` (gate6-design.md Q3b): derived whenever two *attached* canvases in this
  transaction's resolved canvas table share `(layer, sublayer)` -- the renderer would order them by
  canvas RID (`rv.h:125-130`), which no receiver can reproduce. New invariant (`unsupported-mismatch`,
  extended): the entry must be present whenever such a pair exists in the resolved state, and
  absent otherwise -- checked both ways, like `draw-index-tie`.
- `canvas-repeat` and `canvas-follow-viewport` are sticky (gate6-design.md Q3b: once observed, both
  persist in every later transaction of the session, even if the underlying call is never repeated)
  -- like `canvas-light` at /5, forward-only: well-formedness (the `op` is one of the two/one
  spellings above) is all a decoder can check, since neither call's argument travels on the wire.
- `global-canvas-transform` is NOT sticky: it is present only in a transaction where the live
  global canvas transform differs (bitwise float32) from the session's arm-time
  `host_final_xform`, and absent once it matches again. Like `canvas-repeat`, this is forward-only
  -- the live transform itself is never wire-visible, only the session's one arm-time snapshot.
- `snap-2d` (gate6-design.md Q3b, D17): present in every transaction of a session whose
  `viewport.snap_2d.transforms` or `.vertices` is `true` (a session-level constant, not a per-frame
  condition: D17's setters are unhooked, so only the arm-time value is ever known), and absent from
  every transaction of a session where both are `false`. New invariant (`unsupported-mismatch`,
  extended): checked against `session.viewport.snap_2d` for the whole stream, both ways.

`extra-canvas` no longer occurs for a canvas attached to the root viewport (gate6-design.md Q2: the
hook `viewport_attach_canvas` refuses nothing for the root viewport at /6), and since that was its
only occurrence at every earlier version, a /6 decoder rejects any `extra-canvas` entry outright
(`unsupported-mismatch`), exactly as a /5 decoder rejects `unsupported-state` naming
`canvas_item_set_material`. The reason spelling itself stays legal in the schema enum (so a
malformed vector naming it fails with a specific, named error rather than a generic schema one),
but no well-formed /6 transaction may ever carry it.

## Decoded and resolved forms

`decodeRecording()` on a /6-magic stream returns `{"schema":"render-stream-6-decoded/1",...}`,
shaped as /5's but with the two new canvas keys carried verbatim (they need no lifting: they are
plain integers, not block floats). `resolveRecording()` returns `render-stream-6-resolved/1`, the
/5 shape plus the resolved canvas's `"layer":<int>` and `"sublayer":<int>`, in that key order,
right after `attached` and before `items` -- matching the wire's own key order exactly, since
`statesEqual()` is `JSON.stringify`-based (render-stream-5.md "As built").

## Golden vectors (`golden-6/`, G6w)

`make_golden.py` (stdlib only, deterministic, `--check` mode) re-derives golden-5's fifteen states
byte for byte under the `GRS6` magic and `"render-stream/6"` protocol, with `presentation_size`
equal to `logical_size`, `font_oversampling` `1`, `snap_2d` both `false`, `publication`
`"every-frame"`/`null`, and the root canvas at `layer: 0, sublayer: 0` -- same scene, items,
textures, meshes, shaders, materials and commands as golden-5, none of them touching a /6-only
field -- then adds four more:

- state 16: a new canvas (id 2) attached to the root viewport at `layer: 1, sublayer: 0`, with a
  non-identity transform, a non-white modulate, and two new items (18, 19) parented to it.
- state 17: relative to 16, ONLY canvas 2's layer changes (`1` -> `-1`) -- the patch carries
  exactly one canvas entry, nothing else.
- state 18: relative to 17, canvas 2 is removed from the viewport (`attached: false`); its items
  (18, 19) stay in the table, parented to it, exactly as gate 0 keeps a detached canvas's items.
- state 19: relative to 18, canvas 2 is reattached (`layer: 2, sublayer: 0`) and a third canvas
  (id 3, no items) is created at the SAME `(layer, sublayer)` -- a `canvas-stacking-tie` -- and the
  session gains `canvas-repeat`, `canvas-follow-viewport` and `global-canvas-transform` together
  (none of the three has an independent wire signal, so they are declared, not derived from any
  other field).

`full.rs6`, `patch.rs6` and `inline.rs6` resolve to one `resolved.json` (gate 2's exceptions:
`session_id`/`stream_id`/per-transaction `encoding` omitted, memory
rs1-resolved-json-excepted-fields). Three dedicated small streams follow, each its own independent
recording (not part of the shared `full`/`patch`/`inline` streams), mirroring how `params.rs5` is
independent of golden-5's shared streams:

- `presentation.rs6`: `canvas_items` stretch, `logical_size` `[1920, 1080]`, `presentation_size`
  `[960, 540]`, `font_oversampling` `0.5`, `host_final_xform` scale `0.5` -- resolves to
  `resolved-presentation.json`.
- `snap.rs6`: `snap_2d` both `true`; every transaction carries the `snap-2d` session-level entry --
  resolves to `resolved-snap.json`.
- `rate.rs6`: a recorded live stream (`stream.transport: "websocket"`), `publication`
  `{"mode":"rate","target_fps":30}` -- resolves to `resolved-rate.json`.

`invalid/` carries exactly the new failure modes /6 introduces (every rule /6 leaves unchanged is
already covered by `golden-2/invalid/` through `golden-5/invalid/`):

| name                      | code                   | what's wrong                                                                   |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `bad-magic`                | `bad-magic`            | a valid /6-shaped recording with the GRS5 magic                                 |
| `viewport-presentation`    | `viewport-entry`       | `presentation_size` differs from `logical_size` under `root_size_policy: "observe"` |
| `viewport-oversampling`    | `viewport-entry`       | `font_oversampling` is `0`                                                       |
| `viewport-size-status`     | `viewport-entry`       | `host_size_status` is `"match"` while `host_window_size` differs from `presentation_size` |
| `publication-rate-null`    | `publication-entry`    | `"rate"` with `target_fps: null`                                                 |
| `publication-rate-range`   | `publication-entry`    | `target_fps` `300` (out of `1..240`)                                            |
| `publication-file-rate`    | `publication-entry`    | a `file` stream declaring `"rate"`                                              |
| `canvas-entry`             | `canvas-entry`         | a canvas entry whose `sublayer` is a string                                     |
| `canvas-stacking-tie-miss` | `unsupported-mismatch` | two attached canvases share `(layer, sublayer)` with no `canvas-stacking-tie` entry |
| `canvas-stacking-tie-false`| `unsupported-mismatch` | a `canvas-stacking-tie` entry with no two canvases actually sharing `(layer, sublayer)` |
| `snap-miss`                | `unsupported-mismatch` | `snap_2d.transforms: true` with a transaction missing the `snap-2d` entry        |
| `snap-false`               | `unsupported-mismatch` | a `snap-2d` entry while both `snap_2d` flags are `false`                         |
| `extra-canvas-on-root`     | `unsupported-mismatch` | an `unsupported[]` entry naming reason `extra-canvas` (never legal at /6)        |

## Live transport

As /5, except the subprotocol is `render-stream.6` and the hello's `protocol` is
`"render-stream/6"`. Since G6b the capture's listener and the receiver's live client speak it, and a
live connection's session declares `publication` from `GRC_PUBLISH_FPS` (`rate`/target, or
`every-frame`/null when uncapped).

## Versioning

As /5: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G6w)

- **Canonical JSON float, `font_oversampling`.** render-stream-0.md's "Floats never appear in
  JSON" rule holds for every value this wire has ever carried until now; `font_oversampling` is a
  deliberate, contract-mandated exception (gate6-design.md Q4 marks it `(new, float32)` as a bare
  JSON `<number>`, not a block entry). This codec's own canonical form: the shortest fixed-point
  decimal (never scientific notation) whose round-trip through a standard JSON number parser
  recovers the exact float64 widening of the float32 value -- found by trying `%.0f`, `%.1f`, ...
  up to `%.17f` and stopping at the first that round-trips, then stripping any trailing zeros (and
  a bare trailing `.`). This is deliberately the same rule JavaScript's own `Number::toString`
  applies in this magnitude range (no `"1.0"` for a whole number, unlike Python's `repr(1.0)`),
  because the TypeScript decoder's generic `meta-noncanonical` check re-serialises parsed meta with
  `JSON.stringify` and compares byte for byte against the original -- so the encoder must already
  produce what that re-serialisation would. `rs2_codec.cpp`'s `append_json_float()` and
  `make_golden.py`'s `_json_float()` implement the identical search independently; GDScript's
  decoder performs no canonical re-serialisation check at all (render-stream-0.md's existing
  exemption: `JSON.stringify` there sorts keys and prints integers as floats), so it only parses
  `font_oversampling` as a float and checks positivity. Every golden-6 value
  (`1`, `0.5`) is chosen to make this trivial to verify by hand.
- **`extra-canvas` stays a legal enum spelling, rejected only semantically.** Removing the string
  from the schema-level allowed-reasons list would report a malformed vector as a generic
  `meta-schema` failure instead of the specific `unsupported-mismatch` gate6-design.md names for
  it (`extra-canvas-on-root`); keeping the spelling schema-legal and rejecting it in the semantic
  consistency pass (alongside `unsupported-state`/`canvas_item_set_material`'s own /5 rejection)
  produces the named code instead.
- **`canvas-repeat`/`canvas-follow-viewport`/`global-canvas-transform` have no independent
  "actual" signal.** Unlike `canvas-stacking-tie` (computed from the resolved canvas table) and
  `snap-2d` (computed from the session's own `viewport.snap_2d`), these three name an engine call
  whose argument never reaches the wire at all (a mirroring vector, a parent RID, a live global
  transform) -- a decoder can check only that the entry is well-formed (the right `op` spelling for
  the reason), never that the condition is real. This mirrors `canvas-light`'s own /5 treatment.
- **A freshly (re)attached canvas's `layer`/`sublayer` reset to `(0, 0)`** (`viewport_attach_canvas`
  -> `viewport_set_canvas_stacking(..., 0, 0)`, `rv.cpp:1265-1266`), independent of whatever value
  that canvas id last carried while detached -- golden-6 state 19 exercises this directly (canvas 2
  was `layer: -1` at state 18 while detached, and carries `layer: 2` once reattached at state 19,
  never `-1`).
