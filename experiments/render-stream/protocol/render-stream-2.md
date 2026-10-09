# render-stream/2 wire format

Status: the format the capture library and the receiver speak since G2b2 (2026-10-09). Written
with [gate2-design.md](gate2-design.md), which says what the capture puts into these records and
what receivers do with them. Codecs (G2b1): C++ encoder/diff (`capture/src/rs2_codec.*`,
`rs2_diff.*`), TypeScript decoder/validator/resolver (`scripts/lib/render-stream-2.ts`) and
GDScript decoder (`receiver/rs2_decoder.gd`) plus the texture-payload reader
(`receiver/rs_texture_payload.gd`), all checked byte-for-byte and state-for-state against
`protocol/golden-2/`, per this text. G2b2 wired it in: the capture's texture mirror, publisher
(`rs_publish`, both file sinks, the store directory and inline resource records) and live hub
(`rs_live`) emit /2, the receiver consumes it in both modes, and the gate 0, 1 and 2 runners
check it. Since G2c2 live connections follow the configured policy and serve out-of-band payloads
over "HTTP (live)" below (`ServedResources` in `capture/src/rs_resource_store.h`; the receiver's
`RsResourceFetcher`). [render-stream-1.md](render-stream-1.md) is superseded; its codecs
left the capture library, and its TypeScript decoder and goldens stay as frozen, verified history.

One G2b1 reading was corrected by G2b2: a texture entry's `payload_bytes` is the length of the
whole `render-stream-texture/1` payload (magic, meta, both lengths and data), the size the inline
threshold, the store's index and the hook log compare. G2b1's vectors had carried the image's data
size there; `golden-2/` was regenerated and both decoders' `resource-payload` rule now compares
the resource record's whole payload length.

render-stream/2 is render-stream/1 plus textures:

- a second block type, `u8`, used only by the new `resource` record;
- a `resources` object in the session, which declares the resource policy;
- a texture table in every transaction (`textures`, plus `removed_textures` in patches), with the
  root viewport's default texture filter and repeat;
- two item fields, `texture_filter` and `texture_repeat`;
- two draw commands, `add_texture_rect` and `add_texture_rect_region`, and a `reason` on
  `unsupported` commands;
- a canonical texture payload format, `render-stream-texture/1`, whose SHA-256 is the resource's
  content address;
- HTTP delivery of payloads by hash, on the same loopback listener as the WebSocket.

Everything this document does not change is exactly as in render-stream-1.md and, through it,
render-stream-0.md: record framing apart from the block type, the record sha256 definition, the
canonical-JSON rules, the error-string form, patch semantics, and the "no floats in JSON, no
engine RIDs as numbers" rules.

## File layout

```
magic        8 bytes   47 52 53 32 0D 0A 1A 0A   ("GRS2\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

Resource and transaction records may interleave. Rules are under "Resource record" below. A file
recording ends with an end record. A live stream is the concatenation of one connection's binary
messages, as in /1. Decoders refuse `GRS0`, `GRS1` and any other byte 3 with `bad-magic`.

## Record framing: the `u8` block type

A block entry in `meta.blocks` is `{"name","type","count"}` as before. `type` is now `"f32"` or
`"u8"`:

| type  | `block_len` | payload                                       |
| ----- | ----------- | --------------------------------------------- |
| `f32` | `4 * count` | little-endian IEEE-754 binary32 values, as /0 |
| `u8`  | `count`     | raw bytes                                     |

A `u8` block appears only as the single `payload` block of a resource record. Anywhere else it is
`meta-schema`. `record_len = 8 + meta_len + Σ (4 + block_len)` is unchanged.

## Session record

Key order (line breaks for reading only):

```
{"type":"session",
 "protocol":"render-stream/2",
 "session_id", "stream", "engine", "capture", "viewport",           -- exactly as /1
 "resources":{"hash":"sha256",
              "payload":"render-stream-texture/1",
              "delivery":"out-of-band"|"inline"|"mixed",
              "inline_max_bytes":<int>=0>,
              "max_payload_bytes":<int>=1>,
              "permitted_formats":[<format name>...],
              "fetch":"http"|"directory"|"none",
              "http_path":"/resources/sha256/"|null,
              "auth":"none"|"bearer"},
 "features":{"ops":[...],"item_state":[...],"resources":[...],
             "unsupported_resources":[{"resource":<str>,"reason":<str>}...],
             "observed_unsupported_ops":[...],"unobserved":[...],"publication":"snapshot-or-patch"},
 "sabotage":null | {"kind":<kind>,"frame":<int>=1>,"op":<str>|null},
 "blocks":[clear_color, root_canvas_xform, host_visible_rect, host_final_xform, content_scale_factor]}
```

`resources`:

- `delivery` follows from `inline_max_bytes`: `out-of-band` when it is 0, `inline` when it is at
  least `max_payload_bytes`, `mixed` otherwise. A payload of at most `inline_max_bytes` bytes
  travels in a resource record in the stream. A larger one travels out of band.
- `max_payload_bytes`: the capture does not copy a texture whose payload would be larger. That
  texture becomes `unsupported` with `payload-too-large`.
- `permitted_formats`: Image format names (see "Texture payload"), sorted ascending by byte value.
  The capture does not copy a texture in any other format. That texture becomes `unsupported` with
  `unsupported-format`. The gate 2 default is `["L8","LA8","R8","RG8","RGB8","RGBA8"]`.
- `fetch` says where an out-of-band payload comes from. It is `http` on a live stream:
  `GET <http_path><hash>` on the WebSocket's own host and port. It is `directory` in a file
  recording: a content-addressed store directory that the operator hands to the receiver. It is
  `none` exactly when `delivery` is `inline`. `http_path` is non-null exactly for `http`.
- `auth`: `bearer` when the host requires `Authorization: Bearer <token>` on the WebSocket upgrade
  and on every resource GET (G2e). Otherwise `none`.

`features` at gate 2, each array sorted ascending by byte value:

- `ops`: `["add_rect","add_texture_rect","add_texture_rect_region"]`.
- `item_state`: /1's list plus `"texture_filter"` and `"texture_repeat"`.
- `resources` (new key): `["texture_2d","texture_2d_placeholder"]`, plus `"canvas_texture"` from
  G2d on, on a host with a real renderer only.
- `unsupported_resources` (new key, G2d): the resource kinds this host refuses, each
  `{"resource","reason"}`, sorted by `resource`. A headless host (`engine.display_server`
  `headless`) lists `{"resource":"canvas_texture","reason":"canvas-texture-headless"}`: its dummy
  storage never allocates a canvas texture ([canvas-texture-headless.md](canvas-texture-headless.md)).
  Otherwise `[]`. The only reason so far is `canvas-texture-headless`.
- `observed_unsupported_ops`: /1's list without `canvas_item_add_texture_rect` and
  `canvas_item_add_texture_rect_region`, plus `canvas_item_add_lcd_texture_rect_region` (hooked from
  calibrator 5 on).
- `unobserved`: /1's list without `canvas_item_set_default_texture_filter` and
  `canvas_item_set_default_texture_repeat`, plus `canvas_texture_set_shading_parameters` and
  `texture_set_size_override`.

Sabotage kinds: /1's, plus `stale-texture`, `wrong-hash`, `spurious-texture-update`,
`drop-resource` and `unpin` (gate2-design.md). `op` is non-null only for `omit-op`.

## Transaction record

```
{"type":"transaction",
 "seq", "frame", "encoding", "base_seq", "status", "failures", "unsupported",   -- as /1
 "default_texture_filter":<filter>,
 "default_texture_repeat":<repeat>,
 "removed_canvases":[<int>...],
 "removed_items":[<int>...],
 "removed_textures":[<int>...],
 "canvases":[<canvas>...],
 "items":[<item>...],
 "textures":[<texture>...],
 "blocks":[item_f32, canvas_f32, cmd_f32]}
```

- `default_texture_filter` and `default_texture_repeat` hold the root viewport's defaults: what an
  item whose own value is `default` gets. They are never `default` themselves. Both are present in
  full and in patch transactions.
- `<canvas>` is as /1.

Enum spellings:

| name       | values (RS enum order)                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `<filter>` | `default`, `nearest`, `linear`, `nearest_mipmaps`, `linear_mipmaps`, `nearest_mipmaps_anisotropic`, `linear_mipmaps_anisotropic` |
| `<repeat>` | `default`, `disabled`, `enabled`, `mirror`                                                                                       |

They map one to one onto `RenderingServer.CanvasItemTextureFilter` and `CanvasItemTextureRepeat`
(`servers/rendering_server.h:925-942`).

### Item

```
{"id","origin","parent","children","visible","draw_index","z_index","z_relative","behind",
 "clip","custom_rect","visibility_layer","texture_filter","texture_repeat","content_version","commands"}
```

`texture_filter` (`<filter>`) and `texture_repeat` (`<repeat>`) are the item's
`canvas_item_set_default_texture_filter` / `_repeat` values. The RenderingServer default for both
is `default`.

### Commands

```
{"op":"add_rect","aa":<bool>,"f":<int>}
{"op":"add_texture_rect","tex":<int>|null,"tile":<bool>,"transpose":<bool>,"f":<int>}
{"op":"add_texture_rect_region","tex":<int>|null,"transpose":<bool>,"clip_uv":<bool>,"f":<int>}
{"op":"unsupported","name":<RenderingServer method name>,
 "reason":"unsupported-op"|"unknown-texture"|"canvas-texture-headless"}
```

| op                        | floats in `cmd_f32` | layout                                                             |
| ------------------------- | ------------------- | ------------------------------------------------------------------ |
| `add_rect`                | 8                   | rect (x, y, w, h), colour (r, g, b, a), as /0                      |
| `add_texture_rect`        | 8                   | rect (x, y, w, h), modulate (r, g, b, a)                           |
| `add_texture_rect_region` | 12                  | rect (x, y, w, h), source rect (x, y, w, h), modulate (r, g, b, a) |

- Every float is the argument exactly as the engine received it. Negative sizes are kept, because
  they mean flips (`servers/rendering/renderer_canvas_cull.cpp:1528-1535`, `:1625-1640`). The
  receiver passes them back unchanged, and its engine normalizes them in the same way.
- `tex` is a texture-table id, or `null` for an engine `RID()` (the engine draws its default white
  texture, `drivers/gles3/rasterizer_canvas_gles3.cpp:2340-2342`).
- `unsupported` with reason `unknown-texture` is a texture draw whose texture argument is a RID the
  capture never saw created: a texture that existed before arming, a proxy, layered or viewport
  texture, or a canvas texture without the G2d hooks. It keeps its place in the command order and
  uses no floats.
- `unsupported` with reason `canvas-texture-headless` (G2d) is a texture draw naming `RID()` on a
  host that declares `canvas_texture` in `unsupported_resources`: there a `CanvasTexture`'s RID is
  `RID()`, so such a draw cannot be told from a null texture, and it is refused rather than
  replayed as the white default. It keeps its place and uses no floats, like `unknown-texture`.
- `f` is the index of the command's first float in `cmd_f32`. Over the commands that have floats,
  taken in item order and then command order, each `f` is the previous `f` plus the previous
  command's float count, starting at 0 (`cmd-offset`).

### Texture

```
{"id":<int>,
 "origin":"created",
 "kind":"image"|"placeholder"|"canvas",
 "status":"ok"|"unsupported"|"freed",
 "reason":null|<texture reason>,
 "version":<int>=1>,
 "hash":<64 lowercase hex>|null,
 "format":<format name>|null,
 "width":<int>, "height":<int>, "mipmaps":<bool>,
 "payload_bytes":<int>,
 "canvas":null|{"diffuse":<int>|null,"filter":<filter>,"repeat":<repeat>}}
```

The table lists every texture the capture saw created and has not seen freed. It also lists, as
`freed` tombstones, freed textures that a command or a canvas texture's `diffuse` still names. A
tombstone leaves the table once nothing names it. Entries are sorted by `id`. `origin` is always
`created` at gate 2; `adopted` is reserved for late join.

Ids come from one per-session counter shared by every kind. It starts at 1, and no value is ever
reused, as for items. `version` starts at 1 and increases whenever the texture's content or kind
changes. Versions need not be contiguous on the wire, because a version that was never published
is never seen.

Glyph atlas pages are ordinary `image` entries (LA8 or RGBA8). A page grows by whole-page
`texture_2d_update`s, so a step that adds glyphs publishes a new version of each touched page and
nothing else. (Informative, gate4-design.md Q4.)

Field rules, checked by `texture-entry`:

| kind / status            | `hash` | `format`       | `width`,`height` | `mipmaps` | `payload_bytes`      | `canvas` | `reason` |
| ------------------------ | ------ | -------------- | ---------------- | --------- | -------------------- | -------- | -------- |
| `image` / `ok`           | hex    | permitted name | ≥ 1              | as Image  | payload length (≥ 1) | null     | null     |
| `image` / `unsupported`  | null   | name or null   | ≥ 0              | as Image  | 0                    | null     | non-null |
| `placeholder` / `ok`     | null   | null           | 0, 0             | false     | 0                    | null     | null     |
| `canvas` / `ok`          | null   | null           | 0, 0             | false     | 0                    | object   | null     |
| `canvas` / `unsupported` | null   | null           | 0, 0             | false     | 0                    | object   | non-null |
| any / `freed`            | null   | null           | 0, 0             | false     | 0                    | null     | null     |

Texture reasons: `unsupported-format`, `payload-too-large`, `payload-unavailable` (the `Image`
could not be read), `update-shape-mismatch` (a `texture_2d_update` whose format, size or mipmaps
differ from the texture's), `layered-update` (a `texture_2d_update` with layer ≠ 0),
`unknown-texture` (a `texture_replace` or canvas `diffuse` from a RID the capture never saw
created), and `canvas-texture-channel` (a canvas texture with a normal or specular channel).

### Item-level unsupported entries

These are /1's, plus one derived entry per distinct `(op, reason)` pair on each item:

- an `unsupported` command adds `{"op":<name>,"item":<id>,"reason":<its reason>}`;
- an `add_texture_rect` or `add_texture_rect_region` adds
  `{"op":"canvas_item_add_texture_rect"|"canvas_item_add_texture_rect_region","item":<id>,"reason":"unsupported-texture"}`
  when its `tex` names an `unsupported` entry, or a `canvas` entry whose `diffuse` names one.

The ordering is unchanged: by item, then by `op`, then by `reason`, in byte order. Invariant 8 of
render-stream-0.md (`unsupported-mismatch`) now covers these derived entries too.

### Full and patch transactions

These are as /1, with textures treated like items:

- A full transaction has `removed_textures:[]` and every table entry.
- A patch's `removed_textures` lists the ids present in the base table and absent now, in ascending
  order. Its `textures` lists exactly the entries that are new or differ in any JSON value.
- Resolution: `state.textures = base.textures` minus the removed ids, with every included entry
  replacing the entry with the same id or being inserted.
- `patch-removed` covers `removed_textures` the same way it covers the other removed lists.

A transaction that changes only transforms has empty `textures` and `removed_textures`. Gate 2
checks this.

### Texture invariants (resolved state)

| code               | rule                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `texture-entry`    | the field table above                                                                                                                                                                                                                |
| `texture-ref`      | a command's non-null `tex`, or a canvas entry's non-null `diffuse`, must name an entry of the same (resolved) state -- a `freed` tombstone counts, since D11 relies on that. A `diffuse` must name an `image` or `placeholder` entry |
| `texture-version`  | within one stream, an id's `version` never decreases; at an equal version the entry is identical except for a change to `status: "freed"` and the nulls that implies                                                                 |
| `id-reused`        | as /0, extended to texture ids                                                                                                                                                                                                       |
| `resource-missing` | an `ok` image entry whose `payload_bytes ≤ inline_max_bytes`, with no earlier resource record in this stream carrying its `hash`                                                                                                     |

## Resource record

```
{"type":"resource","hash":<64 lowercase hex>,"bytes":<int>=1>,
 "blocks":[{"name":"payload","type":"u8","count":<bytes>}]}
```

- The payload block is a complete `render-stream-texture/1` payload. Its SHA-256 equals `hash`
  (`resource-hash`), and `bytes` equals the block's `count` (`meta-schema`).
- A resource record precedes the first transaction of the stream whose resolved table holds an
  `ok` image entry with that hash and `payload_bytes ≤ inline_max_bytes`. In that stream it carries
  each hash at most once (`resource-duplicate`). The payload must decode, and its format, size,
  mipmaps and length must equal those of every entry that carries its hash (`resource-payload`).
- Resource records carry no `seq` and are not counted in the end record's `transactions`.
- After a resync, a receiver keeps what it already received. After a reconnect, the new stream
  carries again every inline payload it needs.

## Texture payload (`render-stream-texture/1`)

The canonical bytes of one texture version. A file in a store, an HTTP response body and a
resource record's payload block are all exactly these bytes:

```
magic      8 bytes   47 52 54 31 0D 0A 1A 0A   ("GRT1\r\n\x1a\n")
u32le      meta_len
meta       canonical JSON (render-stream-0.md rules):
           {"type":"texture-2d","format":<name>,"width":<int>,"height":<int>,"mipmaps":<bool>,
            "data_bytes":<int>}
u32le      data_len   (== data_bytes)
data       data_bytes raw bytes: the Image's data exactly (Image::ptr(), Image::get_data_size())
```

- The **hash** is the lowercase hex SHA-256 of the whole payload, magic included. The format,
  dimensions and mipmap flag are inside the hashed bytes, so identical bytes in a different shape
  never collide.
- `data_bytes` must equal Godot's size for that shape (`core/io/image.cpp:1700-1745`). For the
  permitted uncompressed formats this is the pixel size times the sum, over the mip chain, of
  `w·h`. The chain halves each dimension with a floor of 1 until both reach 1, and it is level 0
  alone without mipmaps. Pixel sizes: L8 1, LA8 2, R8 1, RG8 2, RGB8 3, RGBA8 4. Any other
  difference is `payload-size`.
- Format names are Godot's `Image.Format` identifiers without `FORMAT_`, in enum order
  (`core/io/image.h:75-114`): `L8 LA8 R8 RG8 RGB8 RGBA8 RGBA4444 RGB565 RF RGF RGBF RGBAF RH RGH
RGBH RGBAH RGBE9995 DXT1 DXT3 DXT5 RGTC_R RGTC_RG BPTC_RGBA BPTC_RGBF BPTC_RGBFU ETC ETC2_R11
ETC2_R11S ETC2_RG11 ETC2_RG11S ETC2_RGB8 ETC2_RGBA8 ETC2_RGB8A1 ETC2_RA_AS_RG DXT5_RA_AS_RG
ASTC_4x4 ASTC_4x4_HDR ASTC_8x8 ASTC_8x8_HDR`. A payload exists only for a permitted format.
- Payload decode errors: `payload-magic`, `payload-meta` (not canonical JSON, or a wrong key, type
  or format name), `payload-length` (the lengths do not add up), and `payload-size`.
- A receiver rebuilds the Image with `Image.create_from_data(width, height, mipmaps, format, data)`.

## Out-of-band delivery

### Store directory (file recordings)

```
<store>/sha256/<hash>.grt     one payload per hash, written once (temporary file + rename)
<store>/index.jsonl           {"hash","bytes","format","width","height","mipmaps","first_frame"} per hash
```

A receiver fetching from a store must check that the file's SHA-256 equals its name before using
it.

### HTTP (live)

On the same loopback host and port as the WebSocket:

```
GET <http_path><64 lowercase hex> HTTP/1.1
Authorization: Bearer <token>             (only when session.resources.auth == "bearer")

200 OK
Content-Type: application/octet-stream
Content-Length: <payload bytes>
Cache-Control: private, max-age=31536000, immutable
ETag: "<hash>"
<payload>
```

- `If-None-Match: "<hash>"` gets `304 Not Modified`.
- Errors: `404` for a hash the host does not hold (never advertised, or retired), `400` for a
  malformed request or a hash that is not 64 lowercase hex, `405` with `Allow: GET` for another
  method, `401` when the token is missing or wrong, and `503` beyond the host's HTTP connection
  limit. Error bodies are empty.
- HTTP/1.1 keep-alive is the default and `Connection: close` is honoured. Requests are not
  pipelined: a client sends a request only after reading the previous response.
- A host serves a hash at least while any transaction that names it is the last transaction it
  sent on some connection, or while the hash belongs to its current captured state
  (gate2-design.md D7). A receiver therefore fetches every payload of a transaction before it
  acknowledges `applied` for it.
- `private` makes a shared cache drop responses to authorized requests. A browser's own HTTP cache
  keeps them across sessions, which is the reuse the handoff asks for.

## End record

```
{"type":"end","transactions","reason",
 "stats":{"bytes_total","encode_ns_total","snapshot_ns_total","diff_ns_total","max_record_bytes",
          "full_transactions","patch_transactions","resource_records","resource_bytes"},
 "blocks":[]}
```

- `resource_records` and `resource_bytes` count this stream's resource records and the sum of
  their payload `count`s (`end-stats-mismatch`).
- `bytes_total` counts every record before the end record, resource records included.
  `max_record_bytes` is taken over the session, transaction and resource records.

## Decoded and resolved forms

`decodeRecording()` returns `{"schema":"render-stream-2-decoded/1",…}` shaped as in /1. A `u8`
block decodes to `{"u8_bytes":<count>,"sha256":<hex>}` rather than an array of numbers.
`resolveRecording()` returns `render-stream-2-resolved/1`, the /1 shape plus:

```
state: {"status","failures","unsupported","default_texture_filter","default_texture_repeat",
        "canvases":[…as /1…],
        "items":[{…/1 keys…, "texture_filter","texture_repeat", "commands":[
            {"op":"add_rect","aa","rect":[4],"color":[4]}
          | {"op":"add_texture_rect","tex","tile","transpose","rect":[4],"modulate":[4]}
          | {"op":"add_texture_rect_region","tex","transpose","clip_uv","rect":[4],"src":[4],"modulate":[4]}
          | {"op":"unsupported","name","reason"}]}],
        "textures":[<texture entry, as on the wire>]}
```

`resolveRecording()` also returns `"resources":[{"hash","bytes","record_index"}]`: the resource
records, in stream order. The receiver's state dumps use the same `state` shape.

## Golden vectors (`golden-2/`, G2b1)

`make_golden.py` uses only the standard library, is deterministic, and has a `--check` mode. It
writes:

- `payloads/<hash>.grt`: four payloads, one per `.grt` file (a shared hash is one file reused by
  several texture ids, not a second file). They are an RGBA8 16×16 quadrant image (shared by two
  texture ids at seq 1, and reused unchanged by a third, brand-new id introduced at seq 4), its
  updated RGBA8 16×16 counterpart (a `texture_2d_update`'s new version and new hash at seq 3), an
  LA8 4×4 checker (the texture freed at seq 4 and dereferenced at seq 5), and an RGBA8 8×8 image
  with mipmaps (four levels, 340 bytes of data; the placeholder's replacement content at seq 4).
- `full.rs2`, with an out-of-band, `directory` session. It holds seqs 1–6 and then an end record:
  - seq 1: three images (two of them sharing a hash), a placeholder, an `unsupported-format` image
    (`RGBAF`), items drawing `add_texture_rect` (tile, transpose), `add_texture_rect_region`
    (negative sizes, `clip_uv`), an `unknown-texture` command, an `unsupported-texture` command,
    and item filter/repeat values;
  - seq 2: transform only;
  - seq 3: a texture update (new version, new hash) and the redraw of its two items;
  - seq 4: a replace that turns the placeholder into an image (same id, kind change), a free of a
    texture that one command still names (a `freed` tombstone), a new texture, and a change of the
    default filter;
  - seq 5: the tombstone's last reference cleared, so the tombstone is removed -- a real patch, so
    `removed_textures` is populated on the wire (not deferred to the resync, unlike /1's goldens'
    item removals, which all land before the final unchanged-resync seq);
  - seq 6: unchanged from seq 5; re-sent in full, as after a resync.
- `patch.rs2`: the same six states, patch-encoded, with seq 6 full as after a resync.
- `inline.rs2`: the same six states as a `full`, `inline`-delivery stream, with one resource
  record per hash inserted before the first transaction whose resolved texture table needs it.
- `*.hex`, `*.decoded.json`, and one `resolved.json` that all three streams' `transactions` resolve
  to. Like /1's, it omits `session_id`, `stream_id` and the per-transaction `encoding`. Unlike
  /1's, `resolved.json` carries no top-level `resources` key at all: full.rs2 and patch.rs2 use
  directory delivery and carry zero resource records, so they resolve to `resources: []`, while
  inline.rs2 resolves to four entries -- never the same list, so it cannot be shared ground truth.
  `index.json`'s `inline_resources` is the ground truth for inline.rs2's `resources`; a decoder's
  self-test checks full.rs2 and patch.rs2 resolve to `resources: []` directly, without a fixture.
- `invalid/<name>.rs2`, with codes in `index.json`. One vector exists for each new code
  (`texture-entry`, `texture-ref`, `texture-version`, `resource-hash`, `resource-duplicate`,
  `resource-missing`, `resource-payload`, `cmd-offset` with mixed command sizes,
  `unsupported-mismatch` for a missing derived `unsupported-texture` entry, `patch-removed` for a
  texture), plus `bad-magic` on a `GRS1` stream and a `u8` block in a transaction
  (→ `meta-schema`).
- `payload-invalid/<name>.grt` for each payload code.
- `control/valid/*.json` and `control/invalid/*.json`: /1's control messages with
  `"protocol":"render-stream/2"`. A `render-stream/1` hello is invalid.

## Live transport

As /1, except:

- the subprotocol is `render-stream.2`, and the hello's `protocol` is `render-stream/2`;
- binary messages may also be resource records, one per message, each sent before the transaction
  that needs it within the same credit window;
- when `session.resources.auth` is `bearer`, the upgrade request must carry
  `Authorization: Bearer <token>`, and a missing or wrong token gets HTTP `401`, not a close code;
- out-of-band payloads come from the HTTP endpoint above, never over the WebSocket.

Control messages are otherwise unchanged. Credit is still returned at the declared stage, and a
receiver reaches `applied` only after every payload of the transaction is fetched, verified and
uploaded.

## Versioning

As /1: any change to framing, a key, a key order, a block layout, an enum spelling or the payload
format is a new version. A payload format change also renames `render-stream-texture/1`, because
it changes every hash.
