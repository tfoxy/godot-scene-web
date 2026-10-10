# render-stream/5 wire format

Status: specified and golden-tested at G55w (2026-10-10); the codecs exist but nothing speaks /5
yet -- the capture, the receiver and every gate runner keep speaking render-stream/4 until G55d
(gate5_5-design.md D1, D17). Written with [gate5_5-design.md](gate5_5-design.md) Q4, which this
document implements. Codecs (G55w): C++ encoder/diff (`capture/src/rs2_codec.*`, `rs2_diff.*`,
behind `Session::version`), TypeScript decoder/validator/resolver (`scripts/lib/render-stream-2.ts`,
behind an explicit `version` parameter) and GDScript decoder (`receiver/rs2_decoder.gd`), all
checked byte-for-byte and state-for-state against `protocol/golden-5/`, per this text. The shader
payload format (`render-stream-shader/1`, "Shader payload" below) has its own read-side modules:
`scripts/lib/render-stream-shader.ts` and `receiver/rs_shader_payload.gd`, parallel to the mesh
payload's `rs_mesh_payload.*` and the texture payload's `rs_texture_payload.*`.
[render-stream-4.md](render-stream-4.md), [render-stream-3.md](render-stream-3.md) and
[render-stream-2.md](render-stream-2.md) are not superseded: `golden-2/` through `golden-4/` keep
passing unchanged (gate5_5-design.md D1).

As with /3 and /4 (memory g4e1-rs3-version-switch-pattern), /5 is **not** a new forked module. The
version-parameterized C++/TypeScript/GDScript modules /4 already extended grow a fourth value:
C++'s `Session::version` gains `ProtocolVersion::V5` (still defaulting to `V2`, so every existing
/2/3/4 caller is unaffected), and the TypeScript/GDScript `version` parameter widens to
`2 | 3 | 4 | 5` (defaulting to `3` until G5d, `4` since -- G5d landed on `main` while this document
was being written; G55w carries that default forward unchanged, since the capture and receiver do
not speak /5 until G55d). Renaming `rs2_codec.*`/`rs2_diff.*`/`render-stream-2.ts`/
`rs2_decoder.gd` is not part of this document.

render-stream/5 is render-stream/4 plus:

- a new magic, protocol string and subprotocol;
- a new block type, `f64` (little-endian IEEE 754 binary64), legal only as a transaction's sixth
  block, `param_f64`;
- a canvas modulate: `canvas_f32` grows from 6 to 10 floats per canvas;
- three new item fields: `material`, `use_parent_material`, `instance_params`;
- a shader table (`shaders`/`removed_shaders`) and a material table (`materials`/
  `removed_materials`), each with its own id counter, alongside the texture and mesh tables;
- a new resource payload format, `render-stream-shader/1` (`GRP1`), for a shader's code;
- a new session key, `materials:{"shader_policy"}`;
- one new host sabotage kind, `perturb-shader`;
- new invariants: `shader-entry`, `material-entry`, `param-entry`, `param-offset`, `shader-ref`,
  `material-ref`, `shader-version`, `material-version`, `canvas-offset`, and
  `id-reused`/`resource-missing`/`resource-payload`/`patch-removed` extended to both new tables;
- three new derived item-level `unsupported` reasons (`unsupported-material`, `unknown-material`,
  `param-type`) and one new session-level, sticky reason (`canvas-light`); /4's `unsupported-state`
  for `canvas_item_set_material` no longer occurs, and /5 decoders reject it.

Everything this document does not change is exactly as in render-stream-4.md and, through it,
render-stream-3.md, render-stream-2.md, render-stream-1.md and render-stream-0.md: record framing,
the `u8`/`f32`/`i32` block types, the record sha256 definition, canonical JSON, the texture and
mesh tables and their invariants, the `render-stream-texture/1` and `render-stream-mesh/1` payload
formats, out-of-band delivery and HTTP, and patch/resolve semantics for canvases/items/textures/
meshes.

## File layout

```
magic        8 bytes   47 52 53 35 0D 0A 1A 0A   ("GRS5\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /5 refuses `GRS4` (or any other byte 3) with `bad-magic`. A decoder
configured for /4 continues to refuse `GRS5` the same way it already refuses `GRS3`/anything else
that is not exactly `GRS4`.

## Block type `f64`

A sixth block kind, alongside `f32`, `i32` and `u8`: `count` little-endian IEEE 754 binary64
values, `8 * count` bytes. It is legal only as a transaction record's sixth block, named
`param_f64` -- anywhere else it is `meta-schema`. A block descriptor's `"type"` field gains the
string `"f64"` as a fifth legal value.

## Session record

Key order: `type`, `protocol`, `session_id`, `stream`, `engine`, `capture`, `viewport`,
`resources`, `materials`, `features`, `sabotage`, `blocks` -- /4's order with one new key,
`materials`, immediately after `resources`. `protocol` is `"render-stream/5"`.

### Resources

`resources.payloads` gains `"render-stream-shader/1"`, sorted with the other two:

```json
"payloads": ["render-stream-mesh/1", "render-stream-shader/1", "render-stream-texture/1"]
```

Every other `resources` field is unchanged.

### Materials

A new session key, after `resources`:

```json
"materials": {"shader_policy": "source" | "params" | "exclude"}
```

gate5_5-design.md D4: `GRC_SHADER_POLICY`, default `source`. `source` carries shader code as a
`GRP1` payload under the ordinary resource policy. `params` withholds the code (shader entries
carry `"source":"withheld"`, with the hash and size the payload would have had, so no code byte
reaches the stream, the store or HTTP). `exclude` makes every shader entry `"unsupported"`
(`shader-excluded`). This codec and golden-5 model all three values; only `source` and `params`
appear in `golden-5/`'s shared vectors (state 12-15), `params.rs5` being the dedicated `params`-
policy leg (its own small recording, not part of the shared `full`/`patch`/`inline` streams).

### Features

- `ops`: unchanged from /4 (materials add no new draw op).
- `item_state`: /4's list plus `instance_params`, `material`, `use_parent_material`, re-sorted:
  `behind`, `children`, `clip`, `custom_rect`, `draw_index`, `instance_params`, `material`,
  `modulate`, `parent`, `self_modulate`, `texture_filter`, `texture_repeat`, `transform`,
  `use_parent_material`, `visibility_layer`, `visible`, `z_index`, `z_relative`.
- `canvas_state`: new, `["modulate", "transform"]`.
- `resources`: /4's three plus `material` and `shader`, sorted: `material`, `mesh`, `shader`,
  `texture_2d`, `texture_2d_placeholder`.
- `observed_unsupported_ops`: /4's list loses `canvas_item_set_material` (superseded by item-level
  material state) and gains `canvas_light_attach_to_canvas`, re-sorted.
- `unobserved`: /4's list loses `canvas_item_set_instance_shader_parameter` and
  `canvas_set_modulate` (both now hooked and observed) and gains D16's five:
  `global_shader_parameter_add`, `global_shader_parameter_remove`, `global_shader_parameter_set`,
  `global_shader_parameter_set_override`, `material_set_next_pass`, `material_set_render_priority`,
  `shader_set_path_hint` (D16 names five concepts; `global_shader_parameter_*` is four distinct
  setters), re-sorted.
- Every other `features` key is unchanged.

### Sabotage

Sabotage kinds: /4's, plus `perturb-shader`. Its `op` is `null`, like every kind but `omit-op`
(gate5_5-design.md Q3c).

## Canvas

`canvas_f32` grows from 6 to 10 floats per canvas: transform (6, unchanged), then modulate (4).
The resolved canvas gains `"modulate":[4]` (render-stream-0.md's canvas shape, extended). A
canvas's own expected `canvas_f32` length (10 × canvas count) is checked by a dedicated
`canvas-offset` code, ahead of the generic `block-count` sweep that still covers every other
block -- mirroring how `cmd-offset`/`mesh-offset` are already distinct, earlier-checked codes for
the blocks that carry a per-entry running offset. Pre-/5, a `canvas_f32` mismatch is still reported
generically as `block-count`.

## Item

Keys gain `"material":<id>|null`, `"use_parent_material":<bool>` and
`"instance_params":[<param>]`, in that order, right after `texture_repeat` and before
`content_version`:

```
id origin parent children visible draw_index z_index z_relative behind clip custom_rect
visibility_layer texture_filter texture_repeat material use_parent_material instance_params
content_version commands
```

`material` is a resolved material-table id or `null` (no material set, or an unknown RID --
`unknown-material`, below). `use_parent_material` follows the parent chain while set
(gate5_5-design.md D9); the *effective* material an item draws with is not itself carried on the
wire -- a consumer wanting it follows `use_parent_material` up the parent chain the same way the
engine does. `instance_params` is `[<param>]` (below), sorted strictly ascending by name. `material`,
`use_parent_material` and `instance_params` are item state, never bump `content_version` (D9:
setting a material does not redraw).

## Shader table

`shaders: [<shader entry>]` in every transaction (full entries on a full transaction; new-or-
differing entries on a patch, exactly as `textures[]`/`meshes[]`); `removed_shaders: [<int>]` in
patch transactions only (ascending, no duplicates). A shader entry:

```json
{"id":<int>,"origin":"created","status":"ok"|"unsupported","reason":null|<shader reason>,
 "version":<int>,"mode":null|"canvas_item"|"spatial"|"particles"|"sky"|"fog",
 "source":null|"payload"|"withheld","hash":<64 hex>|null,"payload_bytes":<int>,
 "builtin":null|{"kind":"canvas_item_material","blend_mode":"mix"|"add"|"sub"|"mul"|
                 "premul_alpha"|"disabled","light_mode":"normal"|"unshaded"|"light_only",
                 "particles_animation":<bool>},
 "uses":[<"global_uniform"|"instance_uniform"|"light"|"screen_texture"|"sdf"|"time">...],
 "default_textures":[{"name":<str>,"index":<int>,"tex":<int>}, ...]}
```

- `id` has its own per-session counter, starting at 1, never reused (gate5_5-design.md D5): a
  shader id, a material id, a texture id and a mesh id never collide, and creating one never
  perturbs any other table's id sequence. **No tombstones** -- D5: GLES3 unreferences on free
  (freeing a shader sets every material that used it to no shader), so nothing can name a freed
  shader entry; `status` is only `"ok"`/`"unsupported"`, never `"freed"`.
- `reason` is non-null exactly for `status: "unsupported"` (`shader-entry`). Shader reasons:
  `shader-mode`, `shader-screen-texture`, `shader-sdf`, `shader-time`, `shader-global-uniform`,
  `shader-excluded`, `payload-too-large`, `payload-unavailable` (gate5_5-design.md D11, D4).
- `version` starts at 1 and increments by 1 on every accepted mutating call to that shader; it
  never decreases and is monotonic per id across the whole stream (`shader-version`, mirroring
  `texture-version`/`mesh-version`, but with no `"freed"` exception: at an equal version the entry
  must be byte-identical).
- `mode`/`source`/`hash`/`payload_bytes` are null/null/null/0 together exactly when the shader has
  no code yet (a freshly-created, still-codeless shader); otherwise `mode` is the engine's
  `shader_type`, `source` is `"payload"` (code travels as a `GRP1` resource) or `"withheld"`
  (D4's `params` policy: no payload, but `hash`/`payload_bytes` are still the hash and size the
  payload would have had), and `payload_bytes` is the whole `GRP1` payload's length (not the code
  bytes alone).
- `builtin` is non-null exactly for a recognized `CanvasItemMaterial` shader (gate5_5-design.md
  D7: the capture compares the code, after its version-comment line, against the 36 blend × light
  × particles templates): `blend_mode`/`light_mode`/`particles_animation` name the recognized
  template, so a consumer never needs a GLSL parser for it.
- `uses` lists every D11 dependency the shader's code mentions (a token scan outside comments, not
  after `.`), sorted ascending without repeats: `global_uniform`, `instance_uniform` (a
  non-`CanvasItemMaterial` shader with instance-uniform declarations), `light`, `screen_texture`,
  `sdf`, `time`. A `"shader-mode"`/`"shader-screen-texture"`/`"shader-sdf"`/`"shader-time"`/
  `"shader-global-uniform"` `reason` is the first match in that fixed order (gate5_5-design.md
  D11), independent of `uses`'s own sort order.
- `default_textures` is `[{"name","index","tex"}]`, sorted strictly ascending by `(name, index)`;
  `tex` names an entry in the resolved texture table.

A shader entry's shape rule (`shader-entry`): `"reason"` must be null exactly for `status: "ok"`.

## Material table

`materials: [<material entry>]` in every transaction; `removed_materials: [<int>]` in patch
transactions only (ascending, no duplicates). A material entry:

```json
{"id":<int>,"origin":"created","status":"ok"|"unsupported","reason":null|<material reason>,
 "version":<int>,"shader":<int>|null,"params":[<param>, ...]}
```

- `id`/`version`/no-tombstones follow the shader table's rules exactly, in the material id space.
- `reason` is non-null exactly for `status: "unsupported"` (`material-entry`). Material reasons:
  `unknown-shader` (gate5_5-design.md D7's cache trap: a material whose shader-cache key was first
  used before arming), `unknown-texture` (a parameter or default texture naming an unknown RID),
  `param-type`, `param-range`.
- `shader` names an entry in the resolved shader table, or `null` (no shader set yet).
  `shader-ref`: a non-null `shader` must name an entry present in this transaction's resolved
  shader table.
- `params` is `[<param>]` (below), sorted strictly ascending by name.

A material entry's shape rule (`material-entry`): `"reason"` must be null exactly for
`status: "ok"`.

### `<param>`

Shared shape for a material's own parameters and an item's `instance_params` (gate5_5-design.md
D8):

```json
{"name":<str>,"type":<variant type>,"n":<int>,"tex":<int>|null,"f":<int>}
```

- `type` is one of 21 scalar/compound Variant type names plus 8 packed-array type names (the exact
  wire spellings below, under "As built").
- `n` is 1 for every non-array type, and the element count for a packed array type.
- `tex` is non-null exactly for `type: "rid"` (a resolved texture-table id); null for every other
  type (`param-entry`).
- `f` is a running offset into `param_f64`, counted over **materials in table order first, then
  items' `instance_params` in item order** (`param-offset`, gate5_5-design.md D8) -- not simply
  "this entry's own table", since the block is shared between the two. The float count consumed
  is `n ×` the type's component count: 0 for `nil`/`rid`; 1 for `bool`/`int`/`float` and every
  packed array's per-element count; 2 for `vector2`/`vector2i`; 3 for `vector3`/`vector3i`; 4 for
  `rect2`/`rect2i`/`vector4`/`vector4i`/`plane`/`quaternion`/`color`; 6 for `transform2d`/`aabb`; 9
  for `basis`; 12 for `transform3d`; 16 for `projection`.

## Derived item-level entries

New at /5, alongside /2's `unsupported-texture` and /4's `unsupported-mesh`:

- `{"op":"canvas_item_set_material","item":<id>,"reason":"unsupported-material"}`: the item's
  effective material (D9: its own `material`, or the nearest ancestor's while
  `use_parent_material` chains up) is itself `"unsupported"`, names an `"unsupported"` shader, or
  names a texture parameter or default texture whose resolved entry is `"unsupported"`.
  Independently reconstructable from the resolved state (the only one of the three that is), so a
  validator cross-checks it both ways: every such item has the entry, and every declared entry
  corresponds to such an item.
- `{"op":"canvas_item_set_material","item":<id>,"reason":"unknown-material"}`: the item named a
  material RID the mirror never saw created (an unknown non-null RID becomes `material: null` on
  the wire, with no independent "actual" signal left to reconstruct -- checked forward-only: the
  entry's item must exist and its resolved `material` must be null).
- `{"op":"canvas_item_set_instance_shader_parameter","item":<id>,"reason":"param-type"}`: an
  instance parameter of an unsupported type was set (the parameter itself is never carried in
  `instance_params`, so likewise forward-only).

/4's `unsupported-state` for `canvas_item_set_material` no longer occurs at /5 (superseded by the
item-level material state above); a /5 decoder rejects an `unsupported-state` entry naming
`canvas_item_set_material` outright. `unsupported-state` for `canvas_item_attach_skeleton` is
unaffected.

## Session-level entry

New sticky, session-level (`"item":null`) entry:

```json
{"op":"canvas_light_attach_to_canvas","item":null,"reason":"canvas-light"}
```

gate5_5-design.md D10, D16: a `Light2D` attached to a non-null canvas is typed `unsupported`; this
entry records that it happened at all, once, for the whole session (not per item -- `Light2D` is
not a `CanvasItem`). Like every session-level entry, it must sort before every item-level entry in
`unsupported[]` (the existing cross-version ordering invariant); among session-level entries
themselves the ordering is by first observation, as /0's.

## Shader payload `render-stream-shader/1`

```
magic   8 bytes   47 52 50 31 0D 0A 1A 0A   ("GRP1\r\n\x1a\n")
u32le   meta_len
meta    canonical JSON: {"type":"shader-code","code_bytes":<int>}
data    the code, UTF-8, exactly the String the RenderingServer received
```

Simpler than `render-stream-mesh/1`: no 40-byte geometry block (a shader has no geometry), and no
separate `data_len` (unlike `render-stream-texture/1`) -- the payload simply ends where
`meta.code_bytes` says it does; `data_offset + code_bytes` must exactly equal the payload's total
length. The hash is the SHA-256 of the whole payload (magic through the end of `data`), exactly as
a texture or mesh payload's hash is. A `"withheld"` shader entry's `hash`/`payload_bytes` are the
hash and size this payload would have had, even though the payload itself never exists on the wire,
in the store or over HTTP (D4).

Errors: `payload-magic` (bad magic), `payload-meta` (meta is not well-formed canonical JSON with
exactly the keys above, or `type` is not `"shader-code"`), `payload-length` (the trailing byte
count disagrees with `meta.code_bytes`), `payload-utf8` (the code bytes do not round-trip as valid
UTF-8). Store files are `<store>/sha256/<hash>.grp`; a store `index.jsonl` line's `"type"` gains
`"shader-code"`. HTTP delivery is unchanged: GET by hash, same path scheme, same resource policy as
texture and mesh payloads.

## Transaction blocks

Transaction blocks become six, in this order: `item_f32`, `canvas_f32`, `cmd_f32`, `cmd_i32`,
`mesh_f32`, `param_f64`. `param_f64` is type `"f64"`; the other five are as /4. `param_f64` holds
every material's and every item's instance parameters' float64 values, concatenated in the
`param-offset` order above (materials in table order, then items in item order).

## Decoded and resolved forms

`decodeRecording()` on a /5-magic stream returns `{"schema":"render-stream-5-decoded/1",...}`,
shaped as /4's but with the `param_f64` block decoding to a plain float array (mirroring how an
`f32`/`i32` block decodes to a plain array) and a shader entry, a material entry and `param_f64`
carried alongside the texture/mesh entries and the other command blocks. `resolveRecording()`
returns `render-stream-5-resolved/1`, the /4 shape plus:

- the resolved canvas's `"modulate":[4]` (always present at /5; absent pre-/5);
- the resolved item's `"material":<id>|null`, `"use_parent_material":<bool>` and
  `"instance_params":[<resolved param>]`, in that key order, right after `texture_repeat` and
  before `content_version` -- matching the wire's own key order exactly, since
  `render-stream-5-resolved/1` comparisons are JSON-key-order-sensitive (TypeScript's
  `statesEqual()` is `JSON.stringify`-based; see "As built" below);
- `"shaders":[<resolved shader>]` and `"materials":[<resolved material>]` in the resolved state,
  each entry otherwise unchanged from its wire shape;
- resolved params, `{"name","type","value"}`: `value` is a number for a scalar type, `{"tex":<id>}`
  for `"rid"`, a flat array of numbers for a non-packed compound type (vector2 etc.) or a
  single-component packed array, and an array of arrays for a multi-component packed array
  (`packed_vector2_array` etc., each element itself an array of that type's components); `null`
  for `"nil"`.

## Golden vectors (`golden-5/`, G55w)

`make_golden.py` (stdlib only, deterministic, `--check` mode) re-derives golden-4's eleven states
byte for byte under the `GRS5` magic and `"render-stream/5"` protocol (white canvas modulate, no
materials -- same scene, items, textures, meshes and commands as golden-4, none of them touching a
/5-only field), then adds four more:

- state 12: a builtin `CanvasItemMaterial` shader (blend `"add"`) and a custom `"canvas_item"`
  shader with a `"source"`-policy payload, three materials (the CIM with its two int parameters
  and one bool; a custom one exercising every supported Variant type, including each packed array
  and a `"rid"`; one with `shader: null`), items naming them (including a `use_parent_material`
  child), instance parameters on one item, and a non-white canvas modulate.
- state 13: a parameter change only -- the patch carries one material entry and nothing else.
- state 14: a code change only -- the patch carries one shader entry (a new hash) and nothing
  else.
- state 15: a `"shader-time"` shader (its code mentions `TIME`) with its derived
  `unsupported-material` on the item naming it; a second item naming an unknown material RID
  (`unknown-material`); a material whose `"param-type"` reason covers an unsupported-typed
  parameter; a third item with an instance `"param-type"` entry; and the session-level
  `canvas-light` entry. gate5_5-design.md's own "As built (G5d)" finding (golden-4 state 8's
  `add_triangle_array` has `count` 3 over 6 indices, which the real engine's
  `count × 3 <= indices.size()` rule refuses -- `renderer_canvas_render.h`'s `Polygon::create`)
  would otherwise carry forward into every golden-5 state derived from golden-4's state 8 onward;
  golden-5's generator sets that one `count` to 1 instead (see "As built" below), so no derived
  golden-5 state inherits an engine-invalid fixture.

`full.rs5`, `patch.rs5` and `inline.rs5` resolve to one `resolved.json` (gate 2's exceptions:
`session_id`/`stream_id`/per-transaction `encoding` omitted, memory
rs1-resolved-json-excepted-fields). `params.rs5` (`materials.shader_policy: "params"`) is a
separate, independent small recording -- not a leg of the shared `full`/`patch`/`inline` streams --
resolving to its own `resolved-params.json`, with every shader entry `"source":"withheld"` and no
`GRP1` resource records at all. Shader code and mesh surface payloads are kept small and synthetic
so `golden-5/` stays the same order of magnitude as `golden-4/` (hundreds of KB, not megabytes).

`invalid/` carries exactly the new failure modes /5 introduces (every rule /5 leaves unchanged is
already covered by `golden-2/invalid/` through `golden-4/invalid/`):

| name                   | code                  | what's wrong                                                                      |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `bad-magic`            | `bad-magic`           | a valid /5-shaped recording with the GRS4 magic                                   |
| `shader-entry`         | `shader-entry`        | an `"ok"` shader entry with a non-null `reason`                                   |
| `material-entry`       | `material-entry`      | an `"ok"` material entry with a non-null `reason`                                 |
| `param-entry`          | `param-entry`         | a `"rid"` param whose `tex` is null (must be non-null exactly for type `"rid"`)    |
| `param-offset`         | `param-offset`        | a param's `f` disagrees with the running offset over materials-then-items         |
| `material-ref`         | `material-ref`        | an item names a material id absent from the resolved table                        |
| `shader-ref`           | `shader-ref`          | a material names a shader id absent from the resolved table                       |
| `shader-version`       | `shader-version`      | a shader's version decreases from one transaction to the next                     |
| `material-version`     | `material-version`    | a material's version decreases from one transaction to the next                   |
| `canvas-offset`        | `canvas-offset`       | `canvas_f32` declares 6 floats per canvas instead of 10                           |
| `unsupported-mismatch` | `unsupported-mismatch` | an item whose effective material is unsupported, with no derived `unsupported-material` entry |
| `patch-removed`        | `patch-removed`       | a patch both removes a material id and lists it present                           |
| `meta-schema`          | `meta-schema`         | an `f64` block declared in the `mesh_f32` slot (wrong block type for that name)   |
| `resource-payload`     | `resource-payload`    | a `GRP1` payload's byte length disagrees with its shader-table entry's `payload_bytes` |

`payload-invalid/` gains one `GRP1` vector per payload code (`payload-magic`, `payload-meta`,
`payload-length`, `payload-utf8`), alongside golden-2's four `GRT1` and golden-4's four `GRM1`
vectors (unaffected).

## Live transport

As /4, except the subprotocol is `render-stream.5` and the hello's `protocol` is
`"render-stream/5"`. Not wired anywhere yet -- G55d switches the capture's listener and the
receiver's live client to /5.

## Optional keys: unknown-item skip

A capture armed with the opt-in `GRC_UNKNOWN_ITEM=skip` adds two keys that no other session or
transaction carries: `"unknown_item_policy":"skip"` in the session, right after `sabotage`, and,
in every one of that session's transactions, `"unknown_items":{…}` right after `unsupported`.
[unknown-item-skip.md](unknown-item-skip.md) specifies both, with their validation (`meta-schema`
otherwise) and the reason the version does not change. A strict recording, every golden vector
included, never contains either key.

## Versioning

As /4: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G55w)

- The wire's Variant type spellings (`VARIANT_TYPES` in all three codecs) are this codec's own
  decision, not quoted verbatim from gate5_5-design.md D8: snake_case, matching the engine's own
  `Variant::Type` names lowercased (`vector2`, `transform2d`, `packed_float64_array`, ...), for
  consistency with every other enum string already on this wire (`"ok"`, `"unsupported-op"`,
  `"canvas_item"`, ...). `VARIANT_COMPONENTS` maps each to the float count D8 specifies.
- The `canvas-light` session-level entry sorts **first** among `unsupported[]`'s session-level
  entries (ahead of `non-root-viewport`/`extra-canvas`/`degenerate-host-size` were any to co-occur
  with it), to satisfy the pre-existing cross-version invariant that every session-level entry
  precede every item-level one. A naive reading of "ordered by first observation" could place a
  later-observed `canvas-light` after an earlier item-level entry; the codec enforces session-
  before-item first, then first-observation among entries at the same level.
- `canvas-offset` is checked as its own named code ahead of the generic `block-count` sweep,
  mirroring how `cmd-offset`/`mesh-offset` already get dedicated codes for the blocks carrying a
  per-entry running offset -- `canvas_f32` does not carry such an offset, but its *expected total
  length* (10 × canvas count) is exactly the kind of check `block-count` already made generically,
  so giving it its own code needed deliberately pulling it out of that generic sweep rather than
  falling out automatically.
- `shader_entry`/`material_entry`/`param_entry` schema checks are **entirely self-coded**: every
  failure inside them, structural or the `status`/`reason` coupling alike, is reported under their
  own top-level code (`shader-entry`/`material-entry`/`param-entry`), never the generic
  `meta-schema` every other schema check (canvases, items, textures, commands, ...) falls back to.
  This mirrors `texture-entry`/`mesh-entry` in spirit (a dedicated code for the `status`/`reason`
  coupling) but goes further: those two defer their coupling check entirely to the resolved-
  invariant layer (texture/mesh entries' other fields are schema-checked generically), while
  shader/material/param entries enforce their coupling eagerly, at schema time, because it depends
  on no running offset the resolved layer would otherwise need to compute first.
- The golden-5 generator's and `rs5_codec_test.cpp`'s states derived from golden-4's state 8 patch
  its `add_triangle_array`'s `count` from 3 to 1 (see "Golden vectors" above), as a **local, non-
  shared** fix: the Python generator edits its own `item7_immediate_ops()` directly, and the C++
  test edits only a `rs5_codec_test.cpp`-local wrapper around the shared `golden::state()`/
  `golden::item7_immediate_ops()` helpers `rs4_codec_test.cpp` still uses unchanged -- `golden-4/`
  and its own test stay byte-for-byte frozen, carrying the engine-invalid fixture gate 7's
  conformance notes already flag (gate5-design.md "As built (G5d)").
- `params.rs5`'s own leg lives in `index.json`'s `params_leg` key, not folded into the shared
  `valid` list: it is a genuinely independent small recording (a different scene, a different
  shader policy) that resolves against its own `resolved-params.json`, so comparing it against the
  shared `resolved.json` would always fail. The TypeScript and GDScript self-tests both special-
  case this key explicitly.
