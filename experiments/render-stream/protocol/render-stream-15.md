# render-stream/15 wire format

Status: **built**. /15 is render-stream/14 ([render-stream-14.md](render-stream-14.md)) plus
**resource hints** (two non-transaction records that announce payloads before any transaction
names them) and a texture entry's **size override** (the logical size Godot draws a texture at).
Everything this text does not list is /14's, byte for byte. /13 stays frozen and stays the
default everywhere; /14 is unchanged.

## What differs from /14

- **Magic.** `47 52 53 46 0D 0A 1A 0A` (`GRSF`, /14's `GRSE` plus one). Recording files use `.rs15`.
- **Protocol strings.** The session's `protocol` and the hello's `protocol` are `render-stream/15`.
  The WebSocket subprotocol is `render-stream.15`.
- **Two new records**, `resource_hint` and `resource_unhint` (below). They are canonical JSON with
  no blocks, like the end record.
- **One new optional texture-entry key**, `size_override` (below).
- **Everything else** (session keys, transactions, resource and end records, item_meta v1 and v2,
  the predicted blocks, the compact residual, `live_coding`) is /14's. A /15 transaction is
  byte-identical to the /14 transaction of the same state when no texture carries a size override.

## Who speaks /15

- **The host** lists `render-stream.15` first among its subprotocols only under
  `GRC_STREAM_VERSION=15`, followed by `render-stream.14` (under a v2 item_meta grant) and /13's
  list. File sinks write /15 under the same setting. Without it nothing changes: no /15 code runs,
  and every /2 to /14 stream is byte-identical to a host that predates /15.
- **A client** offers `render-stream.15` only when it asks for hints. A native receiver offers it
  under `RS_RECEIVER_PROTOCOL=15`. A /15 client may ask for item_meta v2 fields, as at /14.
- Below /15, both record types are unknown: `meta-schema`, as any unknown `type`. So is a
  `size_override` key in a texture entry.

## Resource hints

A hint tells a receiver that the host holds a payload a later transaction will probably name, so the
receiver can fetch it ahead of time. Hints are advisory: a receiver may ignore every one of them and
still be a correct /15 receiver.

### Records

```
{"type":"resource_hint","hash":<64 lowercase hex>,"kind":"texture",
 "format":<format name>,"source_format":<format name>|null,
 "width":<int>=1>,"height":<int>=1>,"mipmaps":<bool>,"payload_bytes":<int>=1>,
 "variants":[<variant>, ...],
 "path":<string>|null,
 "cause":"create"|"warm"|"predicted"|"integrator",
 "priority":<int>=0>,
 "blocks":[]}

{"type":"resource_unhint","hash":<64 lowercase hex>,"blocks":[]}
```

- `hash`, `format`, `source_format`, `width`, `height`, `mipmaps`, `payload_bytes` and `variants`
  are what an `ok` image texture entry with this `hash` carries (render-stream-8.md, -9.md): the
  `decoded` payload's shape and the alternative payloads ready when the hint was formed, with
  /9's variant objects, order and rules. `kind` is `texture`; it is the only kind so far.
- `path` is the texture's resource path as the game named it (`RenderingServer.texture_set_path`,
  normally the `res://` source path), or `null`. It is present only while the texture is
  **pristine**: its content has not been updated or replaced since it was created with that path.
  A non-null `path` is a non-empty string. **Nothing may trust it for content**: it can repeat
  across game builds with different pixels. It names a texture for caches, logs and integrators;
  the hash stays the identity.
- `cause`: `create`, the texture was created while the host was armed; `warm`, it existed before
  the arm and the host has prepared its payload since (late arm); `predicted`, the host expects it
  from an earlier session; `integrator`, the game integration asked for it. A host built to this
  text emits `create` and `warm`; the other two are reserved meanings, valid on the wire.
- `priority`: lower is sooner. A receiver that prefetches takes hints in ascending `priority`, and
  in record order at equal `priority`. The host built to this text numbers each hint when its payload
  is ready to serve. Numbering follows payload readiness, which tracks creation order but may reorder
  by decode completion; within a frame, ready `create` sources precede ready `warm` sources. This is
  a host heuristic: a receiver cannot rely on numbering beyond lower being sooner and record order
  at ties. The wire meaning of `priority` is unchanged.

### The pin rule

From the moment a host sends `resource_hint` for hash h on a connection until it sends
`resource_unhint` h on that connection, or the connection ends, it serves h and every hash in the
hint's `variants` at `GET <http_path><hash>` (render-stream-2.md "HTTP (live)"). In a file recording
the store directory holds them from the hint on. Outside that window h is servable only under
render-stream-2.md's transaction rule. A transaction that names h needs no hint, and a hint does not
change how a receiver must treat the transaction (fetch before `applied`).

A host sends `resource_unhint` h when the texture is freed, when its content changes (the new content
may be hinted under its new hash), or when its hint budget drops h. After an unhint, a receiver
that has not fetched h should not start, and one that has fetched it may keep the bytes.

### Placement and ordering

- A hint or unhint follows the session record and may stand between any two records, except between
  an `item_meta` record and its transaction (`item-meta-orphan`, as for a resource record). It
  carries no `seq`, consumes no credit and is not counted in the end record's `transactions` or
  `resource_records`. Like every record it counts in `bytes_total` and `max_record_bytes`.
- Live: one record per binary message, as resource records. A host never lets hints delay a
  transaction: it sends a frame's hints after that frame's transaction for the connection, and
  bounds how many it sends per frame.
- A host does not hint payloads that travel inline: none when `resources.delivery` is `inline`,
  and none whose `payload_bytes` is at most `inline_max_bytes`.
- A connection that opens later gets the hints that are still in effect, in `priority` order, after
  its first transaction.

### Invariants and codes

| code | rule |
| ---- | ---- |
| `meta-schema` | a key, key order, type or range above is wrong; `blocks` is not `[]`; either record below /15 |
| `hint-duplicate` | a `resource_hint` for a hash that is hinted on this stream and not unhinted since |
| `hint-unknown` | a `resource_unhint` for a hash that is not hinted on this stream |
| `hint-inline` | a `resource_hint` in a session whose `resources.delivery` is `inline`, or with `payload_bytes ≤ inline_max_bytes` |
| `hint-meta` | while h is hinted, a transaction's resolved state holds an `ok` image entry with `hash` h whose `format`, `source_format`, `width`, `height`, `mipmaps` or `payload_bytes` differ from the hint's, or that lists a variant encoding the hint also lists with a different `hash` or `payload_bytes` |

Validators check the records' own rules; whether the host really serves a hinted hash is a live
check (gate 8 group `g8hint`).

## Size override

Godot can draw a texture at a logical size other than its stored size
(`RenderingServer.texture_set_size_override`). A block-compressed texture whose source size is not a
multiple of 4 is stored padded and drawn at its source size: an atlas imported at 3366 px wide is
stored 3368 px wide and drawn as 3366. Godot normalizes texture coordinates by the logical size
(`TEXTURE_PIXEL_SIZE` is `1 / size`), so a receiver that normalizes by the payload's size samples up to
two texels off at the far edge.

- A texture entry gains the optional key `size_override`, right after `variants` and before
  `canvas`: `[<width>, <height>]`, two integers in 1..16384.
- It is present exactly when the texture is an `ok` image and its logical size differs from the
  entry's `width` and `height` (the payload's). An override equal to the stored size is a no-op and is
  absent. Anything else is `texture-entry`.
- A change of `size_override` is a change of the entry: `version` increases. The override follows
  Godot: it survives a `texture_2d_update`, and `texture_replace` inherits the source texture's
  override (logical size), matching Godot 4.5.1's whole-texture copy. A freshly created source starts
  without an override.
- **Receivers** use the override wherever Godot uses the texture's size: the texel size that
  normalizes a region's source rectangle, nine-patch margins and the shader's `TEXTURE_PIXEL_SIZE`.
  The payload, its upload and its hash are unchanged. A native receiver calls
  `texture_set_size_override` on its own texture.

## Validators and golden vectors

- `golden-15/` holds every `golden-14/` vector re-stamped `render-stream/15` (magic and protocol
  strings; every expectation unchanged), plus `hints.rs15` (hints of each emitted cause, an unhint,
  a later transaction naming a hinted hash, and a texture with a size override) and
  `invalid/hint-*.rs15`, `invalid/size-override-*.rs15` and `invalid/hint-at-14.rs14`.

## Tools

- `rs-core-check transcode --to 14` drops both record types and every `size_override` key. Texture
  versions that rose only for an override stay risen, which /14 permits.

## Versioning

As /13: any change to framing, a key, a key order, a block layout, an enum spelling, a payload
format, the schema table or the predictor is a new version.
