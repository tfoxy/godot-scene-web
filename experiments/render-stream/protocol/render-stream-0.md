# render-stream/0 wire format

Status: gate 0 contract, experimental. This is not a stable public API. Gate 0's behaviour (what
the capture puts into these records and what the receiver does with them) is in
[gate0-design.md](gate0-design.md). This document fixes only the bytes. A C++ encoder
(`capture/src/rs0_codec.cpp`), a TypeScript decoder (`scripts/lib/render-stream-0.ts`) and a
GDScript decoder (`receiver/rs0_decoder.gd`) must agree with it byte for byte. The reference
encoder is [`golden/make_golden.py`](golden/make_golden.py). When this text and that script
disagree, the disagreement is a bug to fix in both.

The C++ model of every value below is [`capture/src/rs0_snapshot.h`](../capture/src/rs0_snapshot.h).

## File layout

A recording is a byte sequence that is identical whether it is read from a file or received live:

```
magic        8 bytes   47 52 53 30 0D 0A 1A 0A   ("GRS0\r\n\x1a\n")
record       session       exactly one, first
record       transaction   zero or more, seq 1..N
record       end           exactly one, last; nothing may follow it
```

Byte 3 of the magic (`0x30`, ASCII `0`) is the major version. A decoder refuses any other magic
with `bad-magic`.

## Record framing

All integers in the framing are unsigned 32-bit little-endian (`u32le`).

```
u32le  record_len      number of bytes after this field, to the end of the record
u32le  meta_len
bytes  meta            meta_len bytes of canonical JSON (below)
u32le  block_count     must equal the length of meta.blocks
repeat block_count times:
  u32le  block_len     must equal 4 * meta.blocks[i].count
  bytes  payload       block_len bytes: little-endian IEEE-754 binary32 values
```

- `record_len = 8 + meta_len + Σ (4 + block_len)`. A decoder checks this equality exactly:
  `record-length` if the parts do not add up to `record_len`, and `truncated` if
  `record_len` runs past the end of the input.
- A record occupies `4 + record_len` bytes, counting from its length prefix.
- **Record sha256** is the lowercase hex SHA-256 of exactly those `4 + record_len` bytes, starting
  at the first byte of `record_len`. The receiver's `applied.json` and the checker both use this
  definition.
- There is no padding or alignment anywhere. A block payload can start at any byte offset, so read
  floats with an unaligned little-endian read: `DataView.getFloat32(o, true)`,
  `PackedByteArray.decode_float(o)` or `memcpy`.
- Every block has the type `f32`. The only other way to carry a number is a JSON integer in meta.
  Floats never appear in JSON.
- A record has no upper size limit beyond `u32`. Decoders must not cap it below the input length.

## Meta JSON

Meta is one JSON object per record. It is encoded in one canonical form, so that the C++ encoder
and `json.dumps(obj, separators=(",", ":"), ensure_ascii=True, allow_nan=False)` in Python
produce identical bytes:

- **No whitespace** outside strings: `,` and `:` separators only.
- **Key order is fixed** per object type and given below. Every listed key is always present.
  Keys are never omitted, and keys that are not listed never appear.
- **Characters.** Every byte of meta is printable ASCII (`0x20`–`0x7E`). Inside strings, the only
  escapes are `\"` and `\\`. An encoder replaces any other byte in a string value (a control
  character or non-ASCII) with `?` before encoding. These strings are identifiers, enum
  spellings, hex digests and human `detail` text, and none of them needs more.
- **Integers** are written in decimal, with no leading zeros, no `+`, no exponent and no
  fraction. A `-` appears only for negative values. Every integer satisfies `|x| ≤ 2^53 − 1`.
  Counters that could exceed that (nanosecond totals) saturate at 2^53 − 1. u32 bit masks
  (`canvas_cull_mask`, `visibility_layer`) are unsigned decimals in `0..4294967295`. A `u64` on
  the wire would be a protocol version bump.
- **Booleans** are `true` and `false`, never `0` or `1`.
- **`null`** appears only where a key is documented as nullable. It never stands in for an empty
  array, and an absent value is never an omitted key.
- **Empty arrays** are written `[]`. Empty objects do not occur.
- **Engine RIDs never appear as numbers.** When a RID is useful as evidence, it goes into a
  `detail` string in decimal.

A decoder rejects meta that is not valid JSON (`meta-json`). It also rejects a value with the
wrong type, an unknown enum spelling, or a missing, extra or out-of-order key (`meta-schema`). The
TypeScript validator also re-serialises the parsed meta with `JSON.stringify` and requires the
result to equal the meta bytes (`meta-noncanonical`). JavaScript object key order follows
insertion order for these non-numeric keys, so the check is exact.

Note for GDScript: `JSON.parse_string` returns every number as a `float`. Every wire integer is
below 2^53, so the conversion back with `int()` is exact. The GDScript decoder checks
`value == floor(value)` before converting. It does not re-serialise for the canonical check,
because `JSON.stringify` sorts keys by default and prints integers as floats.

### `blocks` (last key of every record)

`"blocks"` is the last key of every meta object. It is an array with one entry per block, in
payload order:

```json
{ "name": "<block name>", "type": "f32", "count": <number of floats> }
```

Key order: `name`, `type`, `count`. The block names and their order are fixed per record type.
A record with no blocks has `"blocks":[]` and `block_count` 0.

## Session record

Exactly one session record, and it comes first. Key order:

```
{"type":"session",
 "protocol":"render-stream/0",
 "session_id":<32 lowercase hex>,
 "engine":{"version_string":<str>,"sha256":<64 lowercase hex>,"display_server":<str>,
           "rendering_driver":<str>,"rendering_method":<str>},
 "capture":{"calibrator_version":<int>,"hooks_planned":[<str>...],"hooks_omitted":[<str>...]},
 "viewport":{"canvas_cull_mask":<u32 int>,"root_canvas":1},
 "features":{"ops":[...],"item_state":[...],"observed_unsupported_ops":[...],"unobserved":[...],
             "publication":"complete-snapshot-per-frame"},
 "sabotage":null | {"kind":"freeze-frame"|"omit-update"|"perturb-transform","frame":<int>=1>},
 "blocks":[clear_color, root_canvas_xform, host_visible_rect]}
```

(The line breaks above are for reading only. The bytes contain no whitespace.)

- `engine.sha256` is the SHA-256 of `/proc/self/exe`. `display_server`, `rendering_driver` and
  `rendering_method` hold the same values as the capture library's `result.json`.
- `capture.calibrator_version` is the calibration record's `calibrator.version` string parsed as
  an integer. Gate 0 needs calibrator version 3 or later.
- `capture.hooks_planned` and `capture.hooks_omitted` are sorted ascending by byte value.
- `viewport.root_canvas` is always `1`.
- `features` carries constant arrays at gate 0, each sorted ascending by byte value:
  - `ops`: `["add_rect"]`
  - `item_state`:
    `["children","clip","custom_rect","draw_index","modulate","parent","self_modulate","transform","visibility_layer","visible","z_index"]`
  - `observed_unsupported_ops`: the hooked operations reported as unsupported:
    `["canvas_item_add_circle","canvas_item_add_line","canvas_item_add_mesh","canvas_item_add_msdf_texture_rect_region","canvas_item_add_multimesh","canvas_item_add_nine_patch","canvas_item_add_polygon","canvas_item_add_polyline","canvas_item_add_primitive","canvas_item_add_set_transform","canvas_item_add_texture_rect","canvas_item_add_texture_rect_region","canvas_item_add_triangle_array","canvas_item_set_material"]`
  - `unobserved`: state that can affect pixels but is not hooked, so a recording cannot show it:
    `["canvas_item_set_canvas_group_mode","canvas_item_set_default_texture_filter","canvas_item_set_default_texture_repeat","canvas_item_set_draw_behind_parent","canvas_item_set_instance_shader_parameter","canvas_item_set_light_mask","canvas_item_set_sort_children_by_y","canvas_item_set_z_as_relative_to_parent","canvas_set_modulate","viewport_remove_canvas","viewport_set_canvas_cull_mask"]`
- `sabotage` is `null` unless the capture host was asked to sabotage itself. The checker's
  classifier never reads it.

Blocks, in this order:

| name                | count | floats                                                                     |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `clear_color`       | 4     | r, g, b, a of `RenderingServer.get_default_clear_color()`                  |
| `root_canvas_xform` | 6     | root viewport canvas transform: x.x, x.y, y.x, y.y, origin.x, origin.y     |
| `host_visible_rect` | 4     | root `Viewport.get_visible_rect()`: position.x, position.y, size.x, size.y |

`host_visible_rect` is a block, not a JSON integer pair, because Godot's value is a float `Rect2`.
Under `--headless` it is `0, 0, 64, 64`, measured at gate 0. `DisplayServerHeadless::window_get_size`
returns `Size2i()` (`servers/display_server_headless.h:129`), and the root window takes its size
from it (`scene/main/window.cpp:1531`), but `SceneTree` gives the root a 64×64 minimum size
(`scene/main/scene_tree.cpp:2035`) and `Window::_update_window_size` clamps to it
(`scene/main/window.cpp:1144-1150`). Gate 0 records the value and does not judge it. Gate 1
compares it with the rendered reference.

## Transaction record

There is one transaction record per armed frame callback. Each one is a complete snapshot: a
receiver can rebuild the whole canvas state from it alone. Key order:

```
{"type":"transaction",
 "seq":<int>=1>,
 "frame":<int>=1>,
 "status":"ok"|"capture-failure",
 "failures":[{"reason":<str>,"detail":<str>}...],
 "unsupported":[{"op":<str>,"item":<int>|null,"reason":<str>}...],
 "canvases":[{"id":<int>,"origin":<str>,"role":"root"|null,"attached":<bool>,"items":[<int>...]}...],
 "items":[{"id":<int>,"origin":<str>,"parent":{"kind":"canvas"|"item","id":<int>}|null,
           "children":[<int>...],"visible":<bool>,"draw_index":<int>,"z_index":<int>,
           "clip":<bool>,"custom_rect":<bool>,"visibility_layer":<u32 int>,
           "content_version":<int>,"commands":[<command>...]}...],
 "blocks":[item_f32, canvas_f32, cmd_f32]}
```

`<command>` is one of two shapes:

```
{"op":"add_rect","aa":<bool>,"f":<int>}
{"op":"unsupported","name":<RenderingServer method name>}
```

Field meanings:

- `seq` starts at 1 and increases by exactly 1 per transaction. `frame` is the capture host's
  `frames_total` at the frame callback that published the transaction. It is strictly
  increasing, but not necessarily contiguous.
- `status` is `"capture-failure"` exactly when `failures` is non-empty. The failure `reason`s are
  `root-query-failed`, `pre-existing-object` and `mirror-capacity`. `detail` is free printable
  ASCII.
- `origin` is one of `created`, `root-query` or `adopted`. Gate 0 emits `root-query` for canvas 1
  and `created` for everything else. `adopted` is reserved for late join.
- `role` is `"root"` for canvas 1 and `null` for every other canvas. `attached` means "attached
  to the root viewport".
- `canvases[].items` and `items[].children` list child item ids in the engine's **append order**:
  the order of the `child_items` vector before the renderer's index sort. Draw order comes from
  `draw_index`, not from this list.
- `content_version` increases whenever an item's command list changes (any `add_*`, any `clear`).
  A receiver rebuilds an item's content only when it changes.
- In an `add_rect` command, `aa` is the `antialiased` argument. `f` is the index, counted in
  floats and not in bytes, of that rect's first float in `cmd_f32`.
- In an `unsupported` command, `name` is the hooked method, for example `canvas_item_add_circle`.
  It holds its place in the command order and consumes no floats.

`unsupported` is the complete, de-duplicated list of unsupported conditions present in this
snapshot, ordered as follows:

1. Session-level conditions (`"item":null`), in the order they were first observed. Once observed
   they stay in every later transaction. Each is `op` `"viewport_attach_canvas"` or
   `"viewport_set_canvas_transform"`, with `reason` `non-root-viewport` or `extra-canvas`.
2. Item-level conditions, sorted by `item` ascending, then by `op` ascending (byte order):
   - one `{"op":<name>,"item":<id>,"reason":"unsupported-op"}` for each distinct unsupported
     command name in that item's `commands`;
   - `{"op":"canvas_item_set_material","item":<id>,"reason":"unsupported-state"}` while the item
     has a non-null material.

Blocks, always all three, always in this order. A count may be 0:

| name         | count                     | layout                                                                                                                                                                              |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item_f32`   | 18 × `items.length`       | per item, in `items` order: xform (x.x, x.y, y.x, y.y, origin.x, origin.y), modulate (r, g, b, a), self_modulate (r, g, b, a), custom rect (position.x, position.y, size.x, size.y) |
| `canvas_f32` | 6 × `canvases.length`     | per canvas, in `canvases` order: canvas transform on the root viewport (x.x, x.y, y.x, y.y, origin.x, origin.y); identity for an unattached canvas                                  |
| `cmd_f32`    | 8 × number of `add_rect`s | per `add_rect`, in `items` order and then command order: rect (position.x, position.y, size.x, size.y), colour (r, g, b, a)                                                         |

The custom rect floats are always present. They are meaningful only when `custom_rect` is `true`
and hold the last rect set otherwise (`0,0,0,0` by default).

### Per-transaction invariants

The decoder enforces these. The error code is in parentheses.

1. `canvases` are sorted by `id` ascending with no duplicates. So are `items` (`duplicate-id` on a
   repeat, `meta-schema` on misordering).
2. Exactly one canvas has `role` `"root"`, and its id is 1 (`root-canvas`).
3. For every item with a non-null `parent`, the parent exists in the same transaction
   (`dangling-parent`), and the item appears exactly once in that parent's `items` or
   `children` (`child-list-mismatch`).
4. Every id in a `canvases[].items` or `items[].children` list names an item whose `parent` is
   that container. An item with `parent: null` appears in no list (`child-list-mismatch`).
5. Following `parent` links from any item ends at a canvas or at `null` without revisiting an
   item (`parent-cycle`).
6. The `f` values are `0, 8, 16, …` in `add_rect` order (`cmd-offset`). The block counts match
   the table above (`block-count`).
7. `status` agrees with `failures` (`meta-schema`).
8. Each item-level `unsupported-op` entry matches a distinct `(item, name)` pair from the
   unsupported commands, and each such pair has exactly one entry (`unsupported-mismatch`). An
   item-level entry names an item that exists (`dangling-parent`).

## End record

Exactly one end record, and it comes last. Key order:

```
{"type":"end",
 "transactions":<int>,
 "reason":"shutdown"|"disarm",
 "stats":{"bytes_total":<int>,"encode_ns_total":<int>,"snapshot_ns_total":<int>,"max_record_bytes":<int>},
 "blocks":[]}
```

- `transactions` is the number of transaction records (`end-count-mismatch`).
- `stats.bytes_total` is the byte length of the magic plus every session and transaction record:
  the byte offset of the end record. `stats.max_record_bytes` is the largest `4 + record_len` over
  the session and transaction records. A decoder checks both (`end-stats-mismatch`). The two `_ns_`
  totals are measurements and cannot be checked.
- `reason` `"disarm"` means `GRC_DISARM_AFTER_FRAMES` ended the session. `"shutdown"` means the
  library's shutdown callback did.

## Recording invariants

These rules apply across records:

| code                   | rule                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bad-magic`            | the first 8 bytes are not the magic                                                                                              |
| `truncated`            | a length prefix or a `record_len` runs past the end of the input                                                                 |
| `missing-session`      | the first record is not a session, or there are no records                                                                       |
| `duplicate-session`    | a second session record                                                                                                          |
| `seq-gap`              | transaction `seq` values are not exactly 1, 2, 3, …                                                                              |
| `frame-order`          | `frame` is not strictly increasing                                                                                               |
| `id-reused`            | an item or canvas id appears that is absent from the previous transaction but not greater than every id of that kind seen before |
| `recording-incomplete` | the input ends without an end record                                                                                             |
| `trailing-bytes`       | any byte after the end record                                                                                                    |
| `root-canvas`          | `session.viewport.root_canvas` is not 1, or a transaction has no canvas 1                                                        |

Ids come from per-kind counters that start at 1 and never reuse a value. A new id is therefore
always greater than every earlier id of its kind, and an id never comes back once it has gone.

### Error strings

`validateRecording()` (TypeScript) and `Rs0Decoder.validate_recording()` (GDScript) return a list
of strings in the form `<code>: <detail>`, where `<code>` is one of the codes in this document:
`bad-magic`, `truncated`, `record-length`, `meta-json`, `meta-schema`, `meta-noncanonical`
(TypeScript only), `block-count`, `block-length`, `missing-session`, `duplicate-session`,
`seq-gap`, `frame-order`, `duplicate-id`, `id-reused`, `dangling-parent`, `child-list-mismatch`,
`parent-cycle`, `cmd-offset`, `unsupported-mismatch`, `root-canvas`, `end-count-mismatch`,
`end-stats-mismatch`, `recording-incomplete` and `trailing-bytes`. An empty list means valid. A
decoder may stop at the first framing error (`bad-magic`, `truncated`, `record-length`,
`block-length`), because nothing after it can be located reliably.

## Decoded form

`decodeRecording()` (TypeScript) produces this shape, and the golden
[`minimal.decoded.json`](golden/minimal.decoded.json) is it, pretty-printed:

```
{"schema":"render-stream-0-decoded/1",
 "magic":"475253300d0a1a0a",
 "records":[{"offset":<byte offset of record_len>,"byte_length":<4 + record_len>,
             "sha256":<record sha256>,"meta":<parsed meta, blocks entry included>,
             "blocks":[[<float>...], ...]}...]}
```

The comparison is deep equality after JSON parsing, so `1` and `1.0` are equal.

## Golden vectors

[`golden/make_golden.py`](golden/make_golden.py) uses only the standard library and is
deterministic. `--check` verifies the committed outputs without writing anything. Because
`--check` guards the generated files' exact bytes, `biome.json` excludes `golden/` from biome,
which would otherwise reflow the JSON. [`golden/index.json`](golden/index.json) lists every
vector:

- `minimal.bin` / `minimal.hex` / `minimal.decoded.json` contain a session, then transaction seq 1
  (root canvas 1; item 1 on canvas 1 with one `add_rect`; item 2, a child of item 1, with an
  `add_rect` and an `unsupported` `canvas_item_add_circle`, clip, custom rect, `z_index` −1 and
  non-white modulates), then transaction seq 2 (item 2 freed; item 3 created on canvas 1 with a
  rotated and moved transform and a different colour), then the end record. Every float is a
  multiple of 1/256.
- `corrupt-meta.bin` is `minimal.bin` with transaction seq 2's first meta byte set to `0x00`.
  Framing is intact and the meta is not JSON, so a decoder reports `meta-json` at record index 2.
- `invalid/<name>.bin` holds six vectors, each with the code that must appear among the errors:
  `bad-magic`, `short-block` (→ `block-length`), `seq-gap`, `reused-id` (→ `id-reused`),
  `dangling-parent` and `no-end` (→ `recording-incomplete`).

## Versioning

`render-stream/0` is experimental, and gate 0 is its only consumer. Any change to the framing, a
key, a key order, a block layout or an enum spelling is a new protocol version: `render-stream/1`,
magic byte 3 `0x31`, a new golden set, and updated encoders and decoders. That includes any
integer that needs more than 53 bits. A decoder never accepts a version it was not written for.
