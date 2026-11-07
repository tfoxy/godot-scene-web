# render-stream/14 wire format

Status: **built**. /14 is render-stream/13 ([render-stream-13.md](render-stream-13.md))
plus **item_meta v2**: two opt-in identity columns, `instance_id` and `mouse_filter`, and re-stamped
rows. Everything this text does not list is /13's, byte for byte. /13 stays frozen and
stays the default everywhere.

## What differs from /13

- **Magic.** `47 52 53 45 0D 0A 1A 0A` (`GRSE`, /13's `GRSD` plus one).
- **Protocol strings.** The session's `protocol` and the hello's `protocol` are `render-stream/14`.
  The WebSocket subprotocol is `render-stream.14`.
- **The transaction syntax and every other record** (session keys, resources, end, the predicted
  blocks, the compact residual, `live_coding`) are /13's. A /14 transaction is byte-identical to
  the /13 transaction of the same state.
- **item_meta v2,** below. It is the only grammar /14 adds.

## Who speaks /14

- **The host** lists `render-stream.14` first among its subprotocols only when `GRC_ITEM_META`
  names `instance_id` or `mouse_filter`. Without such a grant the listener's list is /13's,
  unchanged. File sinks write /14 only under `GRC_STREAM_VERSION=14`.
- **A client** offers `render-stream.14` only when it asks for a v2 field. Native receivers, the
  web export and a client with no v2 `wants` never offer it.
- At /13 the two names are still unknown fields: a /13 hello that asks for them is a hello error
  (`bad control message`), and a /13 recording whose grant names them fails `item-meta-schema`.

## item_meta v2

- **Hello and grant.** `item_meta.fields` is a subset of
  `class, script, scene, path, instance_id, mouse_filter`, in that order. `GRC_ITEM_META` (and, for
  a /14 file sink, `GRC_ITEM_META_FILE`) accepts the two new names. The record's `grant.fields`
  lists them in that order.
- **Rows.** A node row is `[id, <field columns>, <groups>?, <meta columns>...]`, with one field
  column per granted field in the order above:
  - `class`, `script`, `scene`, `path`: a string-table index or `null`, as at /13;
  - `instance_id`: the node's Godot `ObjectID` (`Object.get_instance_id()`) as an **inline**
    decimal string, `^[1-9][0-9]{0,19}$`, or `null`. It is not interned. It never changes for a
    node, survives a reparent and is the same on every connection, reconnect and arm of one
    process. Godot resolves it (`instance_from_id`, `GodotObject.InstanceFromId`), and a freed
    node's id resolves to `null`, never to another node;
  - `mouse_filter`: an int in 0..6, or `null` when the node is not a Control. The low two bits are
    `Control.get_mouse_filter_with_override()` (0 STOP, 1 PASS, 2 IGNORE), so it includes an
    ancestor's `mouse_behavior_recursive`. Bit 4 is set when the node's script implements
    `_has_point`, which makes the item's rect an upper bound of its pick area.
  - `groups` and the meta columns follow, as at /13. A no-node item is still `[id]`.
- **Re-stamped rows.** At /14 a `delta` may carry a row for an id the receiver already holds. The
  row replaces the held row, applied at receipt as at /13. Only a `mouse_filter` change re-stamps
  a row; every other column of a re-stamped row repeats its value. A re-stamp introduces no
  strings. Rows stay sorted by id, without duplicates, within one record.
- **When a change arrives.** The host re-reads a Control's filter on its `property_list_changed`
  (which `set_mouse_filter` emits on an actual change) and in a round-robin sweep of
  `GRC_ITEM_META_SWEEP` Controls a frame (default 64; `mouse_behavior_recursive` emits nothing). A
  change is stamped at the frame it was read, so the row goes in the delta before the first
  transaction formed after it. A `full` carries every row's current value.

## Validators

- The seven /13 `item-meta-*` codes, unchanged in meaning.
- `item-meta-schema` also covers the v2 column types: `instance_id` is a string matching
  `^[1-9][0-9]{0,19}$` or `null`, and `mouse_filter` is an integer in 0..6 or `null`. A v2 name in
  a grant below /14 is `item-meta-schema` too.
- `golden-14/` holds every `golden-13/` vector re-stamped `render-stream/14` (magic and protocol
  strings; every expectation unchanged), plus `item-meta-v2.rs14` (a `full`, a delta, a re-stamp
  and a refused viewer's stream) and `invalid/item-meta-v2-*.rs14`.

## Tools

- `rs-core-check transcode --to 13` drops the v2 columns and grant names, and drops a record whose
  grant becomes empty. A re-stamped row that is equal to the held row after the drop is dropped,
  and a delta left with no rows is dropped, so the /13 output is a valid /13 stream.
- `rs-core-check --item-meta-dump` prints the v2 columns.

## Versioning

As /13: any change to framing, a key, a key order, a block layout, an enum spelling, a payload
format, the schema table or the predictor is a new version.
