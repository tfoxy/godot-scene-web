# render-stream/4 wire format

Status: specified and golden-tested at G5w (2026-10-10). Since G5d (2026-10-10) the capture, the
receiver and every gate runner speak /4 (gate5-design.md D1, D17); /3 decoding remains only for
`golden-3/`. The capture records every immediate geometry op, `add_set_transform` and
`add_clip_ignore` as /4 commands; `add_mesh` and the mesh table stay empty-or-typed until G5e
(gate5-design.md "As built (G5d)"). Written with [gate5-design.md](gate5-design.md) D1-D16 and Q4, which
this document implements. Codecs (G5w): C++ encoder/diff (`capture/src/rs2_codec.*`, `rs2_diff.*`,
behind `Session::version`), TypeScript decoder/validator/resolver
(`scripts/lib/render-stream-2.ts`, behind an explicit `version` parameter) and GDScript decoder
(`receiver/rs2_decoder.gd`), all checked byte-for-byte and state-for-state against
`protocol/golden-4/`, per this text. The mesh payload format (`render-stream-mesh/1`, "Mesh
payload" below) has its own read-side modules: `scripts/lib/render-stream-mesh.ts` and
`receiver/rs_mesh_payload.gd`, parallel to the texture payload's `rs_texture_payload.*`.
[render-stream-3.md](render-stream-3.md) and [render-stream-2.md](render-stream-2.md) are not
superseded: `golden-2/` and `golden-3/` keep passing unchanged (gate5-design.md D1).

As with /3 (memory g4e1-rs3-version-switch-pattern), /4 is **not** a new forked module. The
version-parameterized C++/TypeScript/GDScript modules /3 already extended grow a third value:
C++'s `Session::version` gains `ProtocolVersion::V4` (still defaulting to `V2`, so every existing
/2/3 caller is unaffected), and the TypeScript/GDScript `version` parameter widens to `2 | 3 | 4`
(defaulting to `3` until G5d, `4` since). Renaming
`rs2_codec.*`/`rs2_diff.*`/`render-stream-2.ts`/`rs2_decoder.gd` is not part of this document.

render-stream/4 is render-stream/3 plus:

- a new magic, protocol string and subprotocol;
- a new block type, `i32` (little-endian two's-complement 32-bit integers), legal only as a
  transaction's fourth block, `cmd_i32`;
- eleven new draw/state commands: `add_line`, `add_polyline`, `add_multiline`, `add_circle`,
  `add_primitive`, `add_polygon`, `add_triangle_array`, `add_nine_patch`, `add_mesh`,
  `add_set_transform`, `add_clip_ignore`;
- a mesh table (`meshes`/`removed_meshes`), with its own id counter, alongside the texture table;
- a new resource payload format, `render-stream-mesh/1` (`GRM1`), for a mesh surface's buffers;
- one new host sabotage kind, `perturb-vertex`;
- new invariants: `mesh-entry`, `mesh-ref`, `mesh-version`, `mesh-offset`, `cmd-int-offset`, and
  `id-reused`/`resource-missing`/`resource-payload`/`patch-removed` extended to meshes;
- `unsupported` reasons gain `unknown-mesh`, `skinned-geometry` and `unsupported-mesh`
  (item-level, mirroring `unsupported-texture`); item-level `unsupported-state` now also covers
  `canvas_item_attach_skeleton`, not only `canvas_item_set_material`.

Everything this document does not change is exactly as in render-stream-3.md and, through it,
render-stream-2.md, render-stream-1.md and render-stream-0.md: record framing, the `u8`/`f32`
block types, the record sha256 definition, canonical JSON, the texture table and its invariants,
the `render-stream-texture/1` payload format, out-of-band delivery and HTTP, and patch/resolve
semantics for canvases/items/textures.

## File layout

```
magic        8 bytes   47 52 53 34 0D 0A 1A 0A   ("GRS4\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /4 refuses `GRS3` (or any other byte 3) with `bad-magic`. A decoder
configured for /3 continues to refuse `GRS4` the same way it already refuses `GRS2`/anything else
that is not exactly `GRS3`.

## Block type `i32`

A fourth block kind, alongside `f32` and `u8`: `count` little-endian two's-complement 32-bit
signed integers, `4 * count` bytes. It is legal only as a transaction record's fourth block,
named `cmd_i32` -- anywhere else (including a session, resource or end record, or any other
transaction block slot) it is `meta-schema`. A block descriptor's `"type"` field gains the string
`"i32"` as a fourth legal value (alongside `"f32"` and `"u8"`).

## Session record

Key order and record framing are exactly /3's. `protocol` is `"render-stream/4"`.

### Resources

`resources.payload` (a single string) becomes `resources.payloads` (a sorted array of strings):

```json
"payloads": ["render-stream-mesh/1", "render-stream-texture/1"]
```

Every other `resources` field (`hash`, `delivery`, `inline_max_bytes`, `max_payload_bytes`,
`permitted_formats`, `fetch`, `http_path`, `auth`) is unchanged, including the delivery-from-
thresholds rule. The mesh and texture payload formats share one resource policy: one inline
threshold, one store, one HTTP path.

### Features

- `ops`: /3's four (`add_msdf_texture_rect_region`, `add_rect`, `add_texture_rect`,
  `add_texture_rect_region`) plus the eleven new ones, fifteen total, sorted ascending by byte
  value: `add_circle`, `add_clip_ignore`, `add_line`, `add_mesh`, `add_msdf_texture_rect_region`,
  `add_multiline`, `add_nine_patch`, `add_polygon`, `add_polyline`, `add_primitive`, `add_rect`,
  `add_set_transform`, `add_texture_rect`, `add_texture_rect_region`, `add_triangle_array`.
- `observed_unsupported_ops`: /3's list without the ten that became ops this version
  (`canvas_item_add_circle`, `canvas_item_add_clip_ignore`, `canvas_item_add_line`,
  `canvas_item_add_mesh`, `canvas_item_add_nine_patch`, `canvas_item_add_polygon`,
  `canvas_item_add_polyline`, `canvas_item_add_primitive`, `canvas_item_add_set_transform`,
  `canvas_item_add_triangle_array`), keeping `canvas_item_add_lcd_texture_rect_region` and
  `canvas_item_add_multimesh` and `canvas_item_set_material`, and gaining three calibrator-7 slots
  that are hooked but still refused: `canvas_item_add_animation_slice`,
  `canvas_item_add_particles`, `canvas_item_attach_skeleton`. Six entries, sorted:
  `canvas_item_add_animation_slice`, `canvas_item_add_lcd_texture_rect_region`,
  `canvas_item_add_multimesh`, `canvas_item_add_particles`, `canvas_item_attach_skeleton`,
  `canvas_item_set_material`.
- `resources`: /3's `["texture_2d", "texture_2d_placeholder"]` plus `"mesh"`, sorted:
  `["mesh", "texture_2d", "texture_2d_placeholder"]`.
- `unobserved`: /3's list plus `viewport_set_snap_2d_transforms_to_pixel` and
  `viewport_set_snap_2d_vertices_to_pixel` (gate3-design.md "Deferred"), re-sorted.
- Every other `features` key is unchanged.

### Sabotage

Sabotage kinds: /3's, plus `perturb-vertex`. Its `op` is `null`, like every kind but `omit-op`.
`perturb-vertex` is a host sabotage (`GRC_SABOTAGE_FRAME` on, the mirror adds +1.0 to the x of the
first point of every `add_line`/`add_polyline`/`add_multiline`/`add_primitive`/`add_polygon`/
`add_triangle_array` it records, and to the first vertex's x of every mesh surface payload it
creates or updates; the engine still gets the true arguments). It moves only commands recorded, or
surface payloads built, from `GRC_SABOTAGE_FRAME` on (gate5-design.md Q3c, as `perturb-glyph`
before it).

## Command

/3's four commands, plus eleven new ones. `f` is a running offset into `cmd_f32`, exactly as /2's
rule (absent only for `add_clip_ignore`, which carries no floats). `i` is the same rule over
`cmd_i32`, present only on `add_triangle_array`. Every key order below is `op`, then the extra meta
keys in the order listed, then `f` last (or, for `add_clip_ignore`, `ignore` last with no `f`).

| op                   | extra meta keys (besides `op`, `f`)                                     | `cmd_f32` layout                                                        | `cmd_i32`     |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------- |
| `add_line`           | `aa`                                                                      | from (2), to (2), colour (4), width (1) = 9                             | --            |
| `add_polyline`       | `aa`, `n` (point count), `colors` (colour count)                        | width (1), points (2n), colours (4 x colors)                            | --            |
| `add_multiline`      | as `add_polyline`                                                        | as `add_polyline`                                                       | --            |
| `add_circle`         | `aa`                                                                      | position (2), radius (1), colour (4) = 7                                | --            |
| `add_primitive`      | `tex`, `n`, `colors`, `uvs`                                              | points (2n), colours (4 x colors), uvs (2 x uvs)                        | --            |
| `add_polygon`        | `tex`, `n`, `colors`, `uvs`                                              | as `add_primitive`                                                      | --            |
| `add_triangle_array` | `tex`, `n`, `colors`, `uvs`, `indices` (index count), `count` (int, -1 = all), `i` | as `add_primitive`                                              | `indices` ints |
| `add_nine_patch`     | `tex`, `x_axis`, `y_axis` (`"stretch"\|"tile"\|"tile_fit"`), `draw_center` | rect (4), source (4), margin top-left (2), margin bottom-right (2), modulate (4) = 16 | -- |
| `add_mesh`           | `mesh` (wire mesh id, int), `tex`                                        | transform (6), modulate (4) = 10                                        | --            |
| `add_set_transform`  | --                                                                        | transform (6): x.x, x.y, y.x, y.y, origin.x, origin.y                   | --            |
| `add_clip_ignore`    | `ignore` (bool); no `f` key at all                                       | --                                                                       | --            |

```json
{"op":"add_line","aa":<bool>,"f":<int>}
{"op":"add_polyline","aa":<bool>,"n":<int>,"colors":<int>,"f":<int>}
{"op":"add_multiline","aa":<bool>,"n":<int>,"colors":<int>,"f":<int>}
{"op":"add_circle","aa":<bool>,"f":<int>}
{"op":"add_primitive","tex":<int>|null,"n":<int>,"colors":<int>,"uvs":<int>,"f":<int>}
{"op":"add_polygon","tex":<int>|null,"n":<int>,"colors":<int>,"uvs":<int>,"f":<int>}
{"op":"add_triangle_array","tex":<int>|null,"n":<int>,"colors":<int>,"uvs":<int>,
 "indices":<int>,"count":<int>,"i":<int>,"f":<int>}
{"op":"add_nine_patch","tex":<int>|null,"x_axis":<axis>,"y_axis":<axis>,"draw_center":<bool>,
 "f":<int>}
{"op":"add_mesh","mesh":<int>,"tex":<int>|null,"f":<int>}
{"op":"add_set_transform","f":<int>}
{"op":"add_clip_ignore","ignore":<bool>}
```

`<axis>` is one of `"stretch"`, `"tile"`, `"tile_fit"`.

Notes:

- `tex`, the `unknown-texture` and `canvas-texture-headless` refusal rules, and `f`'s `cmd-offset`
  accounting are exactly as render-stream-2.md's "Commands" states for the existing texture-rect
  ops, applied to every /4 op that carries a `tex` field (`add_primitive`, `add_polygon`,
  `add_triangle_array`, `add_nine_patch`, `add_mesh`). gate5-design.md D11: while the session has
  never created a canvas texture on a headless host, `RID()` is unambiguous and `tex` is simply
  `null`; once one exists, every later /4 op naming `RID()` is `unsupported`/
  `canvas-texture-headless` in place (using no floats). A rendered host always writes `tex: null`
  for an untextured draw and never hits this ambiguity.
- `add_mesh.mesh` names an entry in this transaction's resolved mesh table (`mesh-ref`, below). An
  id the mirror never saw created is `unsupported`/`unknown-mesh`, in place, using no floats.
  `add_triangle_array` with non-empty bones or weights is `unsupported`/`skinned-geometry`.
- The derived item-level entry on an `add_mesh` naming an `unsupported` mesh is
  `{"op":"canvas_item_add_mesh","item":<id>,"reason":"unsupported-mesh"}`, by the same rule
  render-stream-2.md "Item-level unsupported entries" states for `unsupported-texture`.
- `add_triangle_array`'s `indices` ints live in `cmd_i32`, offset `i`; `cmd-int-offset` is the same
  running-offset rule `cmd-offset` is for `cmd_f32`, but over `cmd_i32` and only for ops that carry
  an `i` key.
- `count` on `add_triangle_array` is the engine's own draw-count argument (`-1` meaning "all
  indices"); it is carried verbatim, never normalized against `indices`.

No texture-table or mesh-table field changes from a /4 command: `tex` names an ordinary texture
entry (checked by /2's unchanged `texture-entry`/`texture-ref`/`texture-version` rules); `mesh`
names an ordinary mesh entry (checked by the new `mesh-entry`/`mesh-ref`/`mesh-version` rules
below).

## Mesh table

`meshes: [<mesh entry>]` in every transaction (full entries on a full transaction; new-or-differing
entries on a patch, exactly as `textures[]`); `removed_meshes: [<int>]` in patch transactions only
(ascending, no duplicates), exactly as `removed_textures`. A mesh entry:

```json
{"id":<int>,"origin":"created","status":"ok"|"unsupported"|"freed","reason":null|<mesh reason>,
 "version":<int>,"f":<int>|null,
 "surfaces":[{"hash":<64 hex>,"payload_bytes":<int>,"primitive":<primitive>,"format":<int>,
              "vertex_count":<int>,"index_count":<int>}, ...]}
```

- `id` has its own per-session counter, starting at 1, never reused: a mesh id and a texture id
  never collide, and creating meshes never perturbs the texture id sequence (gate5-design.md D5).
- `status`/`reason` follow the texture table's shape (render-stream-2.md "Texture"): `reason` is
  non-null exactly for `status: "unsupported"`, and always null for `"ok"`/`"freed"`. Mesh reasons:
  `mesh-format`, `mesh-blend-shapes`, `payload-too-large`.
- `version` starts at 1 and increments by 1 on every accepted mutating call to that mesh (create,
  add-surface, a region update -- accepted or not against an `unsupported` entry, remove, clear,
  set-custom-aabb); it never decreases and is monotonic per id across the whole stream
  (`mesh-version`, mirroring `texture-version`).
- `f` indexes six floats in `mesh_f32` (below): the custom AABB, position then size (`[px, py, pz,
  sx, sy, sz]`; all zero means "no custom AABB set"). It is `null` exactly for `status: "freed"`.
  For every other status it is a running offset counted over the mesh entries present in THIS
  transaction's `meshes` array, in the order they appear (`mesh-offset`, mirroring `cmd-offset`).
- `surfaces` is `[]` for `"unsupported"` and `"freed"`; for `"ok"` it lists every surface in order,
  each with its `render-stream-mesh/1` payload's hash and whole-payload byte length (not the data
  section alone -- as `payload_bytes` already means for textures), `primitive`, `format`,
  `vertex_count` and `index_count`. `<primitive>` is one of `"points"`, `"lines"`, `"line_strip"`,
  `"triangles"`, `"triangle_strip"`. `format` is the engine's raw `ARRAY_FORMAT_*` bitmask (an
  integer, uninterpreted on the wire -- gate5-design.md Q1e).

A mesh entry's shape rules (`mesh-entry`, mirroring `texture-entry`'s field table):

- `"freed"`: `reason` null, `f` null, `surfaces` `[]`.
- `"unsupported"`: `reason` non-null, `f` non-null (six floats, normally the zero AABB, still
  present), `surfaces` `[]`.
- `"ok"`: `reason` null, `f` non-null, `surfaces` a non-empty array when at least one surface was
  ever added, `[]` for a freshly-created mesh with none yet.

`mesh-ref`: every `add_mesh` command's `mesh` id, when not itself the reason the command is
`unsupported`/`unknown-mesh`, must name an entry present in this transaction's resolved mesh table
(any status -- a `"freed"` tombstone counts, since something still names it). An id absent from
the resolved table entirely is `mesh-ref`, the mesh-table mirror of `texture-ref`.

## Mesh payload `render-stream-mesh/1`

```
magic      8 bytes   47 52 4D 31 0D 0A 1A 0A   ("GRM1\r\n\x1a\n")
u32le      meta_len
meta       canonical JSON: {"type":"mesh-surface","primitive":<primitive>,"format":<int>,
           "vertex_count":<int>,"index_count":<int>,"vertex_bytes":<int>,"attribute_bytes":<int>,
           "skin_bytes":<int>,"index_bytes":<int>}
geometry   40 bytes: AABB (6 x f32le: position x, y, z, size x, y, z), uv_scale (4 x f32le)
data       vertex, attribute, skin, index bytes, concatenated, exactly as SurfaceData held them
```

The payload's hash is the SHA-256 of the whole payload (magic through the end of `data`), exactly
as a texture payload's hash is. `payload-size` cross-checks the four buffer lengths against the
declared shape (gate5-design.md D7, Q1e; `n` is `vertex_count`):

- `vertex_bytes` is always `8n` (two float32 per vertex; 2D positions are never compressed).
- `attribute_bytes` is `n * (4 if format has ARRAY_FORMAT_COLOR (bit 3) else 0, plus 8 if format
  has ARRAY_FORMAT_TEX_UV (bit 4) else 0)`.
- `skin_bytes` is `0` unless format has both `ARRAY_FORMAT_BONES` (bit 10) and
  `ARRAY_FORMAT_WEIGHTS` (bit 11) set, in which case it is `n * 16`, or `n * 32` when format also
  has `ARRAY_FLAG_USE_8_BONE_WEIGHTS` (bit 27) set.
- `index_bytes` is `0` when `index_count` is 0 (and format lacks `ARRAY_FORMAT_INDEX`, bit 12);
  otherwise `index_count * (2 if n <= 65536 else 4)`.

Errors: `payload-magic` (bad magic), `payload-meta` (meta is not well-formed canonical JSON with
exactly the keys above, or `type` is not `"mesh-surface"`), `payload-length` (a length field
disagrees with the bytes actually present), `payload-size` (a buffer's length disagrees with the
shape computed above). Store files are `<store>/sha256/<hash>.grm`; a store `index.jsonl` line
gains a `"type"` field, `"texture-2d"` or `"mesh-surface"`. HTTP delivery is unchanged: GET by
hash, same path scheme, same resource policy as texture payloads (one inline threshold, one
`max_payload_bytes`).

## Session block: `mesh_f32`

Unchanged from /3's `blocks` descriptor for the session record (`clear_color`,
`root_canvas_xform`, `host_visible_rect`, `host_final_xform`, `content_scale_factor`) -- the mesh
table is a transaction-level concept, not a session-level one.

## Transaction blocks

Transaction blocks become five, in this order: `item_f32`, `canvas_f32`, `cmd_f32`, `cmd_i32`,
`mesh_f32`. `cmd_i32` is type `"i32"`; the other four are `"f32"`. `mesh_f32` holds six floats per
non-`"freed"` mesh entry present in this transaction's `meshes` array, in that array's order (the
custom AABB `mesh-entry` describes above).

## Decoded and resolved forms

`decodeRecording()` on a /4-magic stream returns `{"schema":"render-stream-4-decoded/1",...}`,
shaped as /3's but with the `cmd_i32` block decoding to a plain integer array (mirroring how an
`f32` block decodes to a plain float array) and a mesh entry and `mesh_f32` carried alongside the
texture entries and `cmd_f32`. `resolveRecording()` returns `render-stream-4-resolved/1`, the /3
shape plus `"meshes":[<mesh entry, with "custom_aabb":[6] replacing "f">]` in the resolved state,
and these new resolved command variants:

```json
{"op":"add_line","aa","from":[2],"to":[2],"colour":[4],"width"}
{"op":"add_polyline","aa","width","points":[[x,y]...],"colors":[[r,g,b,a]...]}
{"op":"add_multiline","aa","width","points":[[x,y]...],"colors":[[r,g,b,a]...]}
{"op":"add_circle","aa","position":[2],"radius","colour":[4]}
{"op":"add_primitive","tex","points":[[x,y]...],"colors":[[r,g,b,a]...],"uvs":[[u,v]...]}
{"op":"add_polygon","tex","points":[[x,y]...],"colors":[[r,g,b,a]...],"uvs":[[u,v]...]}
{"op":"add_triangle_array","tex","count","points":[[x,y]...],"colors":[[r,g,b,a]...],
 "uvs":[[u,v]...],"indices":[int...]}
{"op":"add_nine_patch","tex","rect":[4],"source":[4],"margins":[l,t,r,b],"x_axis","y_axis",
 "draw_center","modulate":[4]}
{"op":"add_mesh","mesh","tex","transform":[6],"modulate":[4]}
{"op":"add_set_transform","transform":[6]}
{"op":"add_clip_ignore","ignore"}
```

`margins` on `add_nine_patch` is `[top_left.x, top_left.y, bottom_right.x, bottom_right.y]` lifted
straight from the wire's margin floats (named `l,t,r,b` for readability only).

## Golden vectors (`golden-4/`, G5w)

`make_golden.py` (stdlib only, deterministic, `--check` mode) re-derives /3's seven golden states
byte for byte under the `GRS4` magic and `"render-stream/4"` protocol (same scene, same items,
textures and commands as golden-3, none of them touching a /4-only field), then adds three more:

- state 8: `golden-3`'s scene plus one new item (draw order after item 6) drawing one of every new
  *immediate* op in sequence: `add_line`, `add_polyline` (four points, a two-colour hold-last
  list), `add_multiline` (two segments), `add_circle`, `add_primitive` (a triangle), `add_polygon`
  (a quad, textured against texture 7, "the page"), `add_triangle_array` (two triangles sharing
  four vertices, `count` 3 so only the first triangle draws), `add_set_transform` (a translation),
  `add_nine_patch` (`tile_fit` on both axes, against texture 7), `add_clip_ignore` (`true` then
  `false`). No mesh ops: those are state 9's.
- state 9: two new meshes. Mesh 1 has two surfaces (a coloured triangle, a textured quad against
  texture 7); mesh 2 has one surface. A new item draws mesh 1 with `add_mesh` (textured). Then,
  with no item redrawing, mesh 2's surface gets a region update: a new payload, mesh 2's version
  +1, nothing else in the transaction (the patch stream carries only the mesh table entry, proving
  gate5-design.md's "a mesh version change with no item change").
- state 10: mesh 2 (from state 9) is freed with a surviving reference, leaving a `"freed"`
  tombstone; a third mesh is created `"unsupported"` (`mesh-format`, a surface whose `format`
  carries `ARRAY_FLAG_COMPRESS_ATTRIBUTES`) and named by a new item's `add_mesh`, producing the
  derived `unsupported-mesh` entry; a fourth command names a mesh id the capture never saw,
  becoming `unsupported`/`unknown-mesh`.

`full.rs4`, `patch.rs4` and `inline.rs4` resolve to one `resolved.json` (gate 2's exceptions:
`session_id`/`stream_id`/per-transaction `encoding` omitted, memory
rs1-resolved-json-excepted-fields). Mesh surface payloads are kept small and synthetic (4-8
vertices per surface) so `golden-4/` stays the same order of magnitude as `golden-3/` (hundreds of
KB, not megabytes).

`invalid/` carries exactly the new failure modes /4 introduces (every rule /4 leaves unchanged is
already covered by `golden-2/invalid/` and `golden-3/invalid/`):

| name                   | code                  | what's wrong                                                                 |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `bad-magic`            | `bad-magic`           | a valid /4-shaped recording with the GRS3 magic                              |
| `cmd-offset`           | `cmd-offset`          | an `add_line` (9 floats, `f=0`) followed by a command declaring the wrong `f` |
| `cmd-int-offset`       | `cmd-int-offset`      | an `add_triangle_array` whose `i` disagrees with the indices already consumed |
| `mesh-entry`           | `mesh-entry`          | an `"ok"` mesh entry with a non-null `reason`                                 |
| `mesh-ref`             | `mesh-ref`            | an `add_mesh` names a mesh id absent from the resolved table                   |
| `mesh-version`         | `mesh-version`        | a mesh's version decreases from one transaction to the next                   |
| `mesh-offset`          | `mesh-offset`         | a mesh entry's `f` disagrees with the running offset over `meshes[]`          |
| `unsupported-mismatch` | `unsupported-mismatch` | an `add_mesh` naming an unsupported mesh, with no derived `unsupported-mesh` entry |
| `patch-removed`        | `patch-removed`       | a patch both removes a mesh id and lists it present                           |
| `meta-schema`          | `meta-schema`         | an `i32` block declared in the `mesh_f32` slot (wrong block type for that name) |
| `resource-payload`     | `resource-payload`    | a `GRM1` payload's meta disagrees with its mesh-table entry's declared shape  |

`payload-invalid/` gains one `GRM1` vector per payload code (`payload-magic`, `payload-meta`,
`payload-length`, `payload-size`), alongside golden-2's four `GRT1` vectors (unaffected).

`control/` carries /3's control-message shapes with `"protocol":"render-stream/4"` (and a
`render-stream/3` hello as `hello-wrong-protocol`, the mirror image of golden-3's).

## Live transport

As /3, except the subprotocol is `render-stream.4` and the hello's `protocol` is
`"render-stream/4"`. The capture's listener and the receiver's live client speak it since G5d.

## Versioning

As /3: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G5w)

- The C++ `Command` struct (`rs2_snapshot.h`) grows one field per new op's distinct argument
  shape (points/colors/uvs/indices vectors, a nine-patch's axis/margin fields, a mesh's id/
  transform) rather than a tagged union, following the existing struct's own documented
  "which fields are meaningful is determined by `kind`" pattern.
- `MeshEntry`/`MeshSurface` structs mirror `TextureEntry`'s shape and `rs2_diff.cpp`'s
  texture-patch logic exactly (new-or-differs inclusion, `removed_meshes` accounting,
  `resolve()`'s upsert/erase), with the mesh id space never shared with the texture id space.
- `golden-4/`'s `make_golden.py` builds real (tiny) `GRM1` payloads byte for byte in Python,
  exactly as `golden-2/`'s builds `GRT1` ones; the C++/TS/GDScript sides only read and re-hash
  them, never construct one, matching G2a/G2b1's division of labour for textures.
