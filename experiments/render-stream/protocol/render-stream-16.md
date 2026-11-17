# render-stream/16 wire format

Status: **built (wire only)**. /16 is render-stream/15 ([render-stream-15.md](render-stream-15.md)) plus
**viewport surfaces**: a table of the host's non-root viewports, a float block for their
transforms, and two texture kinds that let a draw name a viewport's render target. Everything
this text does not list is /15's, byte for byte. /13, /14 and /15 are unchanged.

## What differs from /15

- **Magic.** `47 52 53 47 0D 0A 1A 0A` (`GRSG`, /15's `GRSF` plus one). Recording files use `.rs16`.
- **Protocol strings.** The session's `protocol` and the hello's `protocol` are `render-stream/16`.
  The WebSocket subprotocol is `render-stream.16`.
- **One new session key**, `viewports` (below). It is always present at /16.
- **Two new optional transaction keys**, `removed_viewports` and `viewports`, and **one new
  optional block**, `viewport_f32` (below).
- **Two new texture kinds**, `viewport` and `proxy`, each with one kind-specific key, and one new
  texture reason, `proxy-unresolved` (below).
- **Three new session-level unsupported reasons**: `viewport-3d`, `viewport-hdr-2d` and
  `viewport-msaa-2d` (below).
- **Everything else** (the hint records, `size_override`, item_meta v1 and v2, the predicted
  blocks, the compact residual, `live_coding`) is /15's. A /16 transaction with no viewport keys
  and no `viewport` or `proxy` texture is the /15 transaction of the same state, byte for byte; the
  session differs only by its `protocol` and the `viewports` key.

## Who speaks /16

- **The host** speaks /16 only under `GRC_STREAM_VERSION=16`. It then lists only the subprotocol
  `render-stream.16`, and file sinks write /16. There is no per-connection downgrade: a client that
  does not offer `render-stream.16` gets no session. Without the setting nothing changes, and every
  /2 to /15 stream is byte-identical to a host that predates /16.
- **A client** offers exactly `render-stream.16`, with no fallback list. Native receivers and the
  web export do not offer /16 yet.
- Below /16 every key, block, kind and reason this text adds is unknown: `meta-schema`.

## Session: `viewports`

```
…,"adoption":…,"viewports":"on"|"off"|"unavailable","blocks":[…]}
```

The last key before `blocks`, after `adoption`. Always present at /16.

- `on`: the host captures non-root viewports. The viewport table, `viewport_f32` and the two
  texture kinds may occur. A `non-root-viewport` unsupported entry never occurs
  (`unsupported-mismatch`).
- `off`: the host was told not to (`GRC_VIEWPORTS=off`). It types non-root viewports exactly as
  /15 does (`non-root-viewport`) and never sends the viewport keys, `viewport_f32`, a `viewport` or
  `proxy` texture, or one of the three `viewport-*` reasons (`meta-schema` if it does).
- `unavailable`: the host's calibration record lacks the viewport hooks. Behaviour and rules are
  `off`'s.

## The viewport table

Two optional transaction keys, after `shader_time` (when present) and before `predict_check`:

```
…,["shader_time"],["removed_viewports"],["viewports"],"predict_check","blocks"
```

```
"removed_viewports":[<int>...],     -- present iff non-empty; strictly ascending
"viewports":[<viewport>...],        -- present iff non-empty; strictly ascending by id
```

`predict_check` stays right before `blocks`, as at /13. An empty list is the absent key
(`meta-schema`).

### Viewport entry

```
{"id":<int>=1>,
 "origin":"created"|"adopted",
 "parent":null|0|<int>=1>,
 "active":<bool>,"active_seq":<int>=0>,
 "size":[<int>=0>,<int>=0>],
 "transparent":<bool>,
 "update":"disabled"|"once"|"when_visible"|"when_parent_visible"|"always","once_seq":<int>=0>,
 "clear":"always"|"never"|"next_frame","clear_seq":<int>=0>,
 "disable_2d":<bool>,"renders_3d":<bool>,"hdr_2d":<bool>,"msaa_2d":0|1|2|3,
 "canvas_cull_mask":<int 0..4294967295>,
 "default_texture_filter":<filter>,"default_texture_repeat":<repeat>,
 "snap_2d":[<bool>,<bool>],
 "canvases":[[<canvas id>,<layer>,<sublayer>]...],
 "f":<int>=0>}
```

Keys in exactly this order.

- `id`: a per-session counter shared by no other table, starting at 1, never reused (`id-reused`),
  as item ids. The root viewport is never an entry.
- `origin`: as every table since /8. `adopted` means the host met the viewport already existing at
  arm and read it back; it needs a session `adoption` (`adoption-entry`, as for every table).
- `parent`: the enclosing viewport. `0` is the root viewport, `null` is no parent (out of the
  tree); otherwise a viewport id of the same resolved state.
- `active`, `active_seq`: whether the viewport is active, and the host's activation counter at its
  latest activation. With `parent` they reproduce Godot's render order: children before parents,
  siblings in ascending `active_seq`, the root last. An adopted viewport gets tree order.
- `size`: the render target size in pixels.
- `transparent`: a transparent background (clear colour `(0,0,0,0)`); otherwise the session's
  clear colour.
- `update`, `once_seq`: Godot's update mode. `once_seq` counts the host's switches to `once`; a
  receiver renders a `once` viewport once per new `once_seq` (the host's dummy renderer never draws,
  so the flip back to `disabled` is the receiver's to model). An adopted `once` viewport has
  `once_seq` 1.
- `clear`, `clear_seq`: Godot's clear mode. `clear_seq` counts switches to `next_frame`; a receiver
  clears once per new `clear_seq`.
- `disable_2d`, `hdr_2d`, `msaa_2d`: the viewport's flags; `msaa_2d` is Godot's `MSAA` enum
  (0 disabled, 1 2×, 2 4×, 3 8×).
- `renders_3d`: a camera is attached, 3D is not disabled, and the viewport's scenario holds an
  instance. A receiver still draws the viewport's 2D canvases.
- `canvas_cull_mask`: the viewport's canvas cull mask.
- `default_texture_filter`, `default_texture_repeat`: this viewport's defaults for items whose own
  value is `default`; never `default` themselves (enums as render-stream-2.md).
- `snap_2d`: `[transforms, vertices]`, the viewport's snap-to-pixel flags.
- `canvases`: the canvases attached to this viewport, each `[canvas id, layer, sublayer]`, strictly
  ascending by canvas id. A canvas may be attached to the root and to any number of viewports (one
  `World2D` shared). A canvas attached only to viewports has `attached: false` in its canvas entry
  and so `layer: 0, sublayer: 0` there (render-stream-6.md); its stacking on a viewport is the row's.
- `f`: the entry's offset in `viewport_f32`.

### Patches

The table is a carried set, like canvases (render-stream-1.md "Patch transactions"): a full lists
every entry and no `removed_viewports`; a patch lists exactly the entries that are new or differ
from the base in any JSON value (except `f`) or any of their `viewport_f32` floats (compared by bit
pattern), and `removed_viewports` lists the ids present in the base and absent now. Resolution:
`state.viewports = base.viewports` minus the removed ids, each listed entry replacing or inserting.
`patch-removed` and `patch-encoding` cover `removed_viewports` as the other removed lists.

### `viewport_f32`

Type `f32`, appended to `blocks` after every /15 block (after `pt_f32` when present), present
exactly when `viewports` is present. Per listed viewport, in `viewports` order, at its `f`: the
viewport's global canvas transform (6 floats, `canvas_f32`'s transform layout: x.x, x.y, y.x, y.y,
origin.x, origin.y), then 6 floats per `canvases` row in row order (that canvas's transform on this
viewport). Floats are lossless, as every float since /0. The block is not predicted and is not
covered by `predict_check`.

## Texture kinds

| kind / status | `hash`, `format`, `source_format` | `width`, `height` | `mipmaps` | `payload_bytes` | `variants` | kind key | `canvas` | `reason` |
| ------------- | --------------------------------- | ----------------- | --------- | --------------- | ---------- | -------- | -------- | -------- |
| `viewport` / `ok` | null | 0, 0 | false | 0 | `[]` | `"viewport":<int>=1>` | null | null |
| `proxy` / `ok` | null | 0, 0 | false | 0 | `[]` | `"target":<int>=1>` (`proxy-target`) | null | null |
| `proxy` / `unsupported` | null | 0, 0 | false | 0 | `[]` | `"target":null` (`proxy-target`) | null | `proxy-unresolved` |
| `viewport`, `proxy` / `freed` | null | 0, 0 | false | 0 | `[]` | keeps its last value | null | null |

- The kind key stands right after `variants` and before `canvas` (where /15's `size_override`
  stands on an `ok` image; the two never meet). It is present exactly on its kind (`meta-schema`
  otherwise); a kind key whose value is not of the table's type (`viewport` not an integer ≥ 1,
  `target` neither null nor an integer ≥ 1) is `meta-schema` too. Whether `target` is null for the
  entry's status is `proxy-target`, as below; every other column, `source_format` and `variants`
  included, is `texture-entry`. Neither kind carries `size_override`. A `viewport` entry is never `unsupported`, and
  `proxy-unresolved` is legal only on an unsupported `proxy` (`texture-entry`).
- **`viewport`** is a viewport's render target. Every viewport of the resolved state has exactly
  one `ok` `viewport` entry naming it (`viewport-entry`), and an `ok` `viewport` entry names a
  viewport of the same resolved state (`texture-ref`). So the entry is created in the transaction
  that adds the viewport and is freed (or leaves the table) in the transaction that removes it.
  Ids come from the shared texture counter.
- **`proxy`** is an alias: a receiver draws it as its `target`, one hop. Godot copies the target's
  size, `TEXTURE_PIXEL_SIZE` and size override into the proxy, so a receiver takes all three from the
  target. Re-pointing changes `target` and raises `version`. `proxy-target`: an `ok` proxy's
  `target` names an entry of the same resolved state whose kind is not `proxy`; a `freed` tombstone
  counts, and an `ok` proxy's `target` keeps a tombstone in the table as a canvas texture's `diffuse`
  does; a receiver draws a proxy of a freed entry as it draws a freed entry. An unsupported proxy's
  `target` is null, and an `ok` proxy's is not (`proxy-target`). A freed proxy's `target` is not
  checked.
- **Adopted** `viewport` and `proxy` entries carry `adopted_content: "current"` (they hold no bytes
  to distrust; `adoption-entry` otherwise).
- **References.** A command's `tex`, a material texture parameter and a shader default texture may
  name either kind, as any texture. At /16 a canvas texture's `diffuse` may name an `image`,
  `placeholder`, `viewport` or `proxy` entry (`texture-ref`).
- **Derived `unsupported-texture`** (render-stream-2.md "Item-level unsupported entries"): a
  reference to an `ok` proxy is read as a reference to its `target`, once, before /2's rule. So an
  `add_texture_rect` or `add_texture_rect_region` whose `tex` is an `ok` proxy of an `unsupported`
  entry, or of a canvas texture whose `diffuse` names one, adds the derived entry, as does a canvas
  texture whose `diffuse` is an `ok` proxy of an `unsupported` entry. An unsupported proxy is an
  unsupported entry. Material and shader-default derivations are /15's (status only, no hop).

## Session-level unsupported reasons

| reason | `op` | meaning |
| ------ | ---- | ------- |
| `viewport-3d` | `viewport_attach_camera` | a viewport renders 3D content (`renders_3d`); the receiver draws only its 2D canvases |
| `viewport-hdr-2d` | `viewport_set_use_hdr_2d` | a viewport uses HDR 2D; a receiver may draw it as plain RGBA8 |
| `viewport-msaa-2d` | `viewport_set_msaa_2d` | a viewport uses 2D MSAA; a receiver may draw it without |

`item` is null. Like every session-level entry they are sticky in observation order
(render-stream-0.md); a validator checks only the `op` (`unsupported-mismatch`), not that a table
entry still carries the flag. All three are legal only under `"viewports":"on"`.

## Codes

| code | rule |
| ---- | ---- |
| `meta-schema` | a /16 key, block, kind, kind key or reason (`proxy-unresolved` and the three `viewport-*` included) below /16, or under `"viewports"` other than `on`; a missing or misspelled session `viewports`; an empty `viewports` or `removed_viewports`; `removed_viewports` not strictly ascending (as every removed list); a viewport entry's key set or order; a kind key's value type |
| `viewport-entry` | a viewport entry's value: types, enums, ranges (`filter`/`repeat` never `default`), `viewports` not strictly ascending by id, `canvases` rows not strictly ascending by canvas id or naming no canvas of the resolved state, `parent` neither null, 0 nor a viewport of the resolved state; a resolved viewport with no `ok` `viewport` texture, or with more than one |
| `viewport-parent-cycle` | following `parent` from a viewport revisits a viewport (a viewport that is its own parent included) |
| `viewport-offset` | over `viewports` in order each `f` equals the running float count (6 + 6 × its `canvases` rows); `viewport_f32`'s count equals the total; a missing `viewport_f32` with `viewports`, or one without |
| `proxy-target` | the `proxy` rules above |
| `texture-entry` | the field table above; `proxy-unresolved` on anything but an unsupported proxy; an unsupported `viewport` |
| `texture-ref` | an `ok` `viewport` entry naming no resolved viewport; a `diffuse` naming another kind than `image`, `placeholder`, `viewport` or `proxy` |
| `unsupported-mismatch` | a `viewport-*` reason with the wrong `op`; `non-root-viewport` under `"viewports":"on"`; the derived rule above |
| `patch-removed`, `patch-encoding`, `id-reused`, `adoption-entry` | extended to the viewport table as above |
| `bad-magic` | `GRSG` only |

Check order inside a transaction: /15's rules (with the texture rules above folded into
`texture-entry`, `texture-ref` and `unsupported-mismatch`), then `viewport-offset`, then on the
resolved state `viewport-entry`, `viewport-parent-cycle`, the viewport half of `texture-ref` and
`proxy-target`. A viewport entry with a bad value (a `viewport-entry` failure of the entry itself)
has no known float count: `viewport-offset` checks the entries before it and skips the block's
count, and the transaction then fails `viewport-entry`. An adopted entry's bad value is
`viewport-entry`, not `adoption-entry`. As for canvases, no code checks that a patch lists only
changed viewport entries. Below /16 every rule is /15's, byte for byte.

## Forms

- The **decoded form** is `render-stream-16-decoded/1`: /15's decoded form of the /16 file (metas
  verbatim, `viewport_f32` decoded like every other block).
- The **resolved form** is `render-stream-16-resolved/1`: /15's, plus `"viewports"` right after
  `"particles"` (after `"multimeshes"` and `"particles"` when they are present), only when the
  table is non-empty. A resolved viewport carries the entry's JSON fields in wire order without
  `f`, plus `"floats":{"global_xform":[6 numbers],"canvas_xforms":[[6 numbers]...]}`, one
  `canvas_xforms` row per `canvases` row. Texture entries carry `viewport` and `target` where the
  wire does.

## Validators and golden vectors

- `golden-16/` holds every `golden-15/` vector re-stamped `render-stream/16` (magic, protocol
  strings, and `"viewports":"on"` inserted into each session, so every record after the session
  moves by that key's length; every other expectation is golden-15's), plus `viewports.rs16` (a
  full, a patch, a resize, a `once`, a proxy re-point, a free, a nested viewport, a canvas shared by
  the root and a viewport, the 3D flag, an adopted viewport texture, a proxy keeping a freed target,
  a diffuse naming a proxy and the derived entry through a proxy) and `invalid/viewport-*.rs16`,
  `invalid/proxy-*.rs16` and `invalid/viewport-at-15.rs15`.

## Tools

- There is no transcode to or from /16: /16 has one client, which speaks only /16.

## Versioning

As /13: any change to framing, a key, a key order, a block layout, an enum spelling, a payload
format, the schema table or the predictor is a new version.
