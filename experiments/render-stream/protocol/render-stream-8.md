# render-stream/8 wire format

Status: specified and golden-tested at G8w (2026-10-23), written with
[gate8-design.md](gate8-design.md) D1, D2, D8, D9 and Q6, which this document implements. /8 is
**opt-in**: no receiver advertises it, the capture's file sinks stay on /6 unless asked
(`GRC_STREAM_VERSION=8`), and the live listener offers `render-stream.8` last unless a gate 8
policy is set. Nothing in /2 to /7 changes: `golden-2/` to `golden-7/` pass unchanged and the
window-1 transcripts (`capture/test/golden/live-window1-transcripts.txt`) are byte-identical.
Codecs (G8w): C++ encoder (`capture/src/rs2_codec.*`, `rs2_diff.*`, behind `Session::version`),
TypeScript decoder/validator/resolver (`scripts/lib/render-stream-2.ts`, behind an explicit
`version` parameter), the Rust core's decoder and validator (`rs-core/src/{wire,meta,validate,
canon,payload}.rs`), all checked state-for-state against `protocol/golden-8/`, per this text. The
capture's adoption and texture-decode behaviours are not here yet: G8w lands the wire, the policy
parsing and two empty seams (`capture/src/rs_adopt.*`, `rs_texture_decode.*`) that G8a, G8t and
their successors fill.
[render-stream-7.md](render-stream-7.md) and, through it, render-stream-6.md to
render-stream-0.md are not superseded.

As with /3 to /7 (memory g4e1-rs3-version-switch-pattern), /8 is **not** a new forked module. The
version-parameterized C++/TypeScript/Rust modules grow a seventh value: C++'s `Session::version`
gains `ProtocolVersion::V8` (still defaulting to `V2`), and the TypeScript `version` parameter
and the Rust `version: u8` widen to `2..=8` (the TypeScript default stays `6`). Every cascade that
means "/7 or later" now includes /8 (`is_v7_or_later`).

render-stream/8 is render-stream/7 plus exactly:

- a new magic (`GRS8`), protocol string (`render-stream/8`) and subprotocol (`render-stream.8`);
- the session key `adoption`, always present at /8, right after `unknown_item_policy` (or after
  `sabotage` when that key is absent): `null`, or `{"mode":"arm","frame":<int >= 1>}`;
- `resources.decode`, the last key of the session's `resources` object: `"off"` or `"engine"`;
- `origin` in the texture, mesh, shader and material tables: `"created"` or `"adopted"`;
- `adopted_content` in texture and mesh entries (right after `origin`): `null`, `"current"` or
  `"creation"`, non-null exactly when `origin` is `"adopted"`;
- `source_format` in texture entries (right after `format`): `null` or an `Image.Format` name,
  non-null exactly for a host decode;
- the eight float payload formats, legal as a texture payload's `format` with Godot's pixel sizes;
- seven new `sabotage.kind` values.

Everything else is exactly as in render-stream-7.md and, through it, render-stream-6.md to
render-stream-0.md: record framing, the block types, the record sha256 definition, canonical JSON,
every table's other fields and invariants, every payload format, out-of-band delivery, HTTP
resource routes and the live control messages. **Records, blocks, items, canvases and commands
are byte-identical to /7**: items and canvases have accepted `origin: "adopted"` since /0
("reserved for late join", render-stream-0.md).

## File layout

```
magic        8 bytes   47 52 53 38 0D 0A 1A 0A   ("GRS8\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /8 refuses `GRS7` (or any other byte 3) with `bad-magic`, and a /7 decoder
refuses `GRS8` the same way.

## Session record

Key order is /7's plus `adoption`: `type`, `protocol`, `session_id`, `stream`, `engine`, `capture`,
`viewport`, `resources`, `materials`, `features`, `publication`, `sabotage`,
[`unknown_item_policy`], `adoption`, `blocks`. `protocol` is `"render-stream/8"`. The publication
object keeps /7's `credit_window`.

```json
"resources":{"hash":"sha256","payloads":[...],"delivery":...,"inline_max_bytes":...,
             "max_payload_bytes":...,"permitted_formats":[...],"fetch":...,"http_path":...,
             "auth":...,"decode":"off"|"engine"}
"adoption":null | {"mode":"arm","frame":<int>=1>}
```

- `resources.decode` declares the host's texture-decode policy (`GRC_TEXTURE_DECODE`, gate8-design.md
  D8). `"engine"` means the host decodes block-compressed payloads with the engine's own
  `Image::decompress`, so a texture entry may carry a `source_format`.
- `adoption` declares that the capture adopted a scene that already existed when it armed
  (`GRC_ADOPT=arm`, D3-D5). `frame` dates the arm: the capture host's frame counter then, at least
  1. `null` means no adoption: every object was created under the hooks.
- New invariants: `adoption-entry` (the declaration is malformed, `frame` is below 1, or any
  canvas, item, texture, mesh, shader or material has `origin: "adopted"` in a session whose
  `adoption` is `null`), `decode-entry` (see "Resource tables").

### Sabotage kinds

`sabotage.kind` gains: `adopt-skip-state`, `adopt-no-redraw`, `adopt-skip-layers` (gate8-design.md
Q2), `perturb-decode` (Q3), `size-before-adopt` (Q4), `adopt-raw-shader-code` and
`adopt-skip-params` (Q5). They are legal in a /8 session only (a decoder below /8 reports
`meta-schema`), and the capture refuses them without a /8 sink (`policy-needs-v8`). G8w declares
them on the wire; the behaviours land with the increment that owns each.

## Resource tables

The four tables' entries keep every /7 field, in /7's order, with these additions:

```json
{"id":..,"origin":"created"|"adopted","adopted_content":null|"current"|"creation","kind":..,...
 "format":..,"source_format":null|<format name>,"width":..,...}          // textures[]
{"id":..,"origin":"created"|"adopted","adopted_content":null|"current"|"creation","status":..,...}
                                                                          // meshes[]
{"id":..,"origin":"created"|"adopted","status":..,...}                    // shaders[], materials[]
```

- `origin` is `"created"` below /8. At /8 `"adopted"` means the capture met the object already
  existing at arm and published it by reading it back (gate8-design.md D6, D7, D11, D12).
- `adopted_content` (texture and mesh) says how much the adopted bytes can be trusted:
  `"current"` is provably current (a TextureServer readback, D7, or a `CompressedTexture2D`
  reached through a node, which the engine never updates in place); `"creation"` is the dummy
  renderer's creation-time copy (D6), exact unless the engine changed the content in place before
  arm. It is non-null exactly when `origin` is `"adopted"` (`adoption-entry`), and it follows the
  entry through patches like any field: an entry that changes only `adopted_content` is a patch
  entry.
- `source_format` (texture) is non-null exactly when the payload is a host decode (D8): `format`
  stays the payload's own format (`RGBA8`, `R8`, `RG8`, or a half float), and `source_format` names
  the format the host decoded from. Invariants (`decode-entry`): it is a valid `Image.Format` name
  (`meta-schema` otherwise); it is non-null only on an `ok` entry of kind `image` (not freed, not
  `unsupported`, not a placeholder or canvas texture); it differs from `format`; and the session's
  `resources.decode` is `"engine"`. A freed entry carries `null`.
- Entries compare as whole values for `texture-version`: at an equal version an entry is identical
  except for a transition into `freed`, so `origin`, `adopted_content` and `source_format` take
  part. A refinement that raises `adopted_content` from `"creation"` to `"current"` raises the
  entry's `version`.

## Texture payload

`render-stream-texture/1` is unchanged. At /8 the payload `format` may also be a float format,
and `data_bytes` must equal Godot's size for it (`core/io/image.cpp:1700-1745`): the pixel size
times the sum, over the mip chain, of `w·h`.

| format | RF | RGF | RGBF | RGBAF | RH | RGH | RGBH | RGBAH |
| ------ | -- | --- | ---- | ----- | -- | --- | ---- | ----- |
| bytes per pixel | 4 | 8 | 12 | 16 | 2 | 4 | 6 | 8 |

A float payload is carried exact: no conversion on the host (gate8-design.md D9). `RGBA4444`,
`RGB565` and `RGBE9995` stay unsized and refused by the capture. A wrong size is `payload-size`.
Below /8 the float formats stay unsized in the decoders, exactly as before, and the capture still
refuses them (`unsupported-format`). The channels are little-endian IEEE-754 (binary32 for
`RF RGF RGBF RGBAF`, binary16 for `RH RGH RGBH RGBAH`), as `Image::ptr()` holds them on the
little-endian hosts this protocol targets; a mipmapped float payload carries the whole chain, sized
by the table above.

## Live transport

`render-stream.8` is /7's live transport (render-stream-7.md "Live transport") with /8's session
and tables: the hello carries /7's nine extra keys and its `protocol` is `"render-stream/8"`;
the token travels in the hello, never in an upgrade header; CORS, the credit window and the error
reasons are /7's. A /7 hello on a /8 connection, or the reverse, is `error` `protocol`, close
1002. The listener accepts `render-stream.8` beside `.7` and `.6`:

- default: `render-stream.7`, `render-stream.6`, `render-stream.8` (the default stays /7);
- `GRC_STREAM_VERSION=8`: `render-stream.8` first, then `.7`, `.6`;
- under a gate 8 policy (below): `render-stream.8` only, so no /6 or /7 decoder sees a field it
  would reject (gate8-design.md D2).

No receiver's hello offers `render-stream.8` in G8w.

## Capture policy and refusals (gate8-design.md D2)

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_STREAM_VERSION` | `6` (default), `8` | the wire version of **file** sinks (`7` is a live-only version and refused) |
| `GRC_ADOPT` | `off` (default), `arm` | arm-time late-join adoption; declares `adoption` |
| `GRC_TEXTURE_DECODE` | `off` (default), `engine` | declares `resources.decode` |
| `GRC_RESOURCE_FORMATS` | a float format name | legal at /8 only |
| `GRC_SABOTAGE` | a /8 kind | legal at /8 only |

Any of the last four with a file sink that is not /8 refuses to publish: `result.json`
`stream.status` is `refused` and `stream.reason` begins `policy-needs-v8:`. An invalid value
refuses with its own `invalid GRC_…=…` reason. With no file sink (live only) the policy is allowed
and the listener offers only `render-stream.8`. `result.json` gains a `stream.gate8` object (the
file stream version, the policy, the adoption counts) only when a /8 sink or a gate 8 policy is in
play, so every other run's `result.json` is unchanged.

G8w's seams: `GRC_ADOPT=arm` calls `rs::adopt_at_arm` in `entry.cpp` after the root query and
before the root-size policy (D4's order); `GRC_TEXTURE_DECODE=engine` lets `hooks.cpp`'s texture
copy ask `rs::texture_decode` about a format outside `GRC_RESOURCE_FORMATS`. Both bodies are empty:
adoption adopts nothing (the session still declares it), and the decode seam declines, so a
compressed texture is refused `unsupported-format` exactly as at /6 until G8t.

## Decoded and resolved forms

`decodeRecording()` on a /8-magic stream returns `{"schema":"render-stream-8-decoded/1",...}`,
shaped as /7's, with the new session and table keys carried verbatim. `resolveRecording()`
returns `render-stream-8-resolved/1`; the per-transaction resolved `state` is /7's, except that
the texture and mesh entries carry `origin` (either value) and `adopted_content`, textures carry
`source_format` (in the wire's key positions), and shader and material entries carry their
`origin`. The session's `adoption` and `resources.decode` are session-level and, as every session
field, not part of the resolved form.

## Golden vectors (`golden-8/`, G8w)

`make_golden.py` (stdlib only, deterministic, `--check` mode) loads golden-6's generator as a
module and re-binds the few functions whose wire shape changes, so /8's records are /6's byte for
byte except where this text says otherwise. It writes the full/patch/inline triple, because the
resource tables change shape:

- `full.rs8`, `patch.rs8`, `inline.rs8`: six states -- golden-6's states 1 to 3, then state 4
  (adopted `creation` and `current` textures, a host-decoded texture, a float `RGBAF` texture, a
  half-float `RH` texture with mipmaps, an adopted decoded texture, an adopted mesh, shader and
  material with a texture parameter, an adopted canvas and items), state 5 (the adopted texture
  and mesh refined to `current` content with new hashes) and state 6 (an adopted item removed, an
  adopted decoded texture freed). The session declares `adoption {"mode":"arm","frame":12}` and
  `decode "engine"`. All three resolve to `resolved.json`; `patch.rs8` is seq 1 full, seq 2-4
  patches, seq 5 a full resync and seq 6 a patch; `inline.rs8`'s `record_index` values were taken
  by decoding it (`make_golden.py` reads them back from the decoded records).
- `off.rs8`: a websocket stream with `adoption` null, `decode` `"off"` and a `perturb-decode`
  sabotage declaration; resolves to `resolved-off.json`.
- `invalid/`: `bad-magic` (golden-7's `rate.rs7` handed to a /8 decoder), `adoption-undeclared`,
  `adopted-content-missing`, `adopted-content-on-created`, `adopted-content-value`,
  `adoption-frame`, `adoption-mode`, `decode-undeclared`, `decode-same-format`,
  `decode-source-name`, `decode-freed`, `decode-policy` and `float-payload-size`. Every other rule
  /8 keeps is covered by golden-2 to golden-7's vectors.
- `corrupt-meta.rs8`, `payloads/` (the new float and decoded payloads included).

Checks: `scripts/test/self-test-rs2.ts` (`runSuite(golden-8, 8)` plus the version-gate cases it
builds by re-framing a /7 session: `adoption` and a /8 sabotage kind are refused at /7, and a /8
session without `adoption` or `decode` is refused), `capture/test/rs8_codec_test.cpp` (the C++
encoder, including `make_patch`, matches every `.rs8` byte for byte; a /7 transaction built from
/8-shaped structs equals one built from created defaults), `capture/test/rs_gate8_policy_test.cpp`
(policy parsing, the refusal, the subprotocol offer, the seams), `capture/test/rs_live_test.cpp`'s
`test_v8_connection`, and `rs-core-check goldens` / `cargo test` in `rs-core`.

## Versioning

As /7: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G8w)

- **Key positions.** Q6 left them open. `adopted_content` sits right after `origin` (texture and
  mesh), `source_format` right after `format`, `resources.decode` after `auth`, and `adoption`
  after `unknown_item_policy`/`sabotage`. `adoption` is always present at /8 (null when off) so a
  /8 session has one key list per skip state, not one per adoption state.
- **New validator codes.** `adoption-entry` and `decode-entry` are self-coded (as
  `publication-entry`); the TypeScript and Rust validators report them as the first error.
- **Sabotage kinds are version-gated.** Earlier versions let every later kind through
  ("always representable"); /8's seven are refused below /8 by both decoders, and the capture
  refuses them without a /8 sink. A kind with no wire spelling at /7 should not appear in a /7
  stream, and nothing used to stop it.
- **`GRC_STREAM_VERSION=7` is invalid.** /7 has no file sink (render-stream-7.md); the variable is
  `6|8`, as D2 says.
- **Float formats in `GRC_RESOURCE_FORMATS`** count as a gate 8 policy (they trigger D2's
  refusal) but are still refused by the format parser afterwards (`not one of L8, LA8 ...`): the
  capture's float size table is G8f's. G8w makes them legal on the wire and in the decoders only.
- **`gate2_features` for /8.** `/7` and `/8` change no feature list, so the session's `features`
  are /6's.
- **`adoption.frame`.** The capture's `frames_total` at stream start, at least 1. G8a may refine
  it to the frame of the walk.
- **The Rust core's resolved state** carries `origin`, `adopted_content` and `source_format` as
  fields; its apply layer, `rs-core-capi` and every receiver ignore them (an adopted entry draws
  like any other, gate8-design.md Q2 "Impact"). The capi pin (`/6` or `/7`) is unchanged.

## As built (G8t)

- **`source_format` is produced.** Under `GRC_TEXTURE_DECODE=engine` the capture decodes DXT1, DXT3,
  DXT5, BPTC_RGBA, ETC, ETC2_R11, ETC2_RG11, ETC2_RGB8, ETC2_RGBA8, ASTC_4x4 and ASTC_8x8 to RGBA8,
  RGTC_R to R8 and RGTC_RG to RG8 (the engine's own `Image::decompress` on a duplicate,
  gate8-design.md D8 and "As built (G8t)"); the entry's `format` is the payload's and
  `source_format` the hooked image's. Every other format keeps its /6 refusal: `unsupported` with
  reason `unsupported-format`, `format` the source format, `source_format` null. No wire change:
  G8w's validators already held D8's invariants (`decode-entry`).
- **The hook log** (`evidence/resources.jsonl`, not a wire format) fills the existing `decode_ns`
  column on a texture line whose decode was tried, and appends a trailing `source_format` key only
  on a host-decoded texture's line, so every log without a decode is byte-for-byte as before.
- **The native receiver reads /8 files.** `receiver.gd` replays a GRS8 recording at /8 and
  `rs-core-capi` accepts `version` 8 (`VERSIONS = [6, 7, 8]`); the apply layer ignores /8's
  additions, so a /8 recording draws exactly as the /6 one of the same scene would. The live hello
  still offers `.6`/`.7` only, and the browser receivers' gate 8 legs are G8g's.

## As built (G8a)

- **Adopted origins are produced.** Under `GRC_ADOPT=arm` the first transaction carries every
  canvas layer's canvas and every canvas item reachable from the root window with
  `origin: "adopted"` (gate8-design.md Q2 "As built (G8a)"); objects created after arm are
  `created`, as always. Resource tables stay `created` until G8r/G8m adopt resources. No wire
  change: items and canvases accept `adopted` since /0.
- **`adoption.frame` is the iteration of the walk**, in the host's own main-loop iterations: an
  adopting capture aligns its frame counter with `Engine.get_process_frames()` at arm, so the
  session's `frame`, the first transaction's `frame` and every later frame are the same clock a
  capture loaded at startup uses.


## As built (G8f)

Float payloads end to end (gate8-design.md D9). Where the design left room:

- **Capture.** `payload_pixel_size` sizes the eight float formats (Image.Format 8-15), so
  `GRC_RESOURCE_FORMATS` parses them and the hook copies a float Image's bytes exactly as it copies
  an 8-bit one. **The default stays the six 8-bit formats** (a /6 or default /8 capture is
  byte-identical to before); floats are an explicit opt-in, and naming one still needs a /8 sink
  (`policy-needs-v8`). The product's list is `L8,LA8,R8,RG8,RGB8,RGBA8,RF,RGF,RGBF,RGBAF,RH,RGH,RGBH,RGBAH`.
- **BC6H and ASTC-HDR decode to half floats.** `GRC_TEXTURE_DECODE=engine` now decodes `BPTC_RGBF`
  and `BPTC_RGBFU` to `RGBH` and `ASTC_4x4_HDR` and `ASTC_8x8_HDR` to `RGBAH` (the engine's
  `Image::decompress`, as G8t's table), published with `source_format`. A decode whose result the
  format policy would refuse is **not run** (the texture keeps its `unsupported-format` refusal and
  costs no decode time), so these formats decode only when `RGBH`/`RGBAH` are permitted.
- **perturb-decode** inverts a float texel's whole first channel (2 bytes of a half, 4 of an f32)
  instead of one byte, so the change is a sign and exponent one that an 8-bit clamp cannot hide.
- **rs-core.** Validation was already /8-aware (G8w). The Rust core's resolved state and apply
  layer now accept a float payload at /8 (`verify_decode` and the capi's `verify`/`Payloads` take
  the stream version), and refuse one below /8 (`resource-payload`).
- **Native receivers** (the Rust core's `rs-core-capi`, the GDExtension, and the web export's core
  with it): the op stream carries the float payload exact, with `Image.Format` 8-15 as the format
  code, and `Image.create_from_data` builds the image; the engine's GLES3 applies its own float
  rules (32-bit to half without `OES_texture_float_linear`). The capi pin stays /6 for a live
  hello; recordings of any of /6, /7 and /8 replay.
- **The RGBA8 quantization** (`apply::payloads::texture_rgba8`, what a receiver that cannot
  sample float, i.e. GSW, takes) maps channels like the 8-bit family: R -> (r,0,0,1), RG ->
  (r,g,0,1), RGB -> (r,g,b,1), RGBA -> (r,g,b,a), halves widened to binary32 exactly first, and
  each channel `q(v)`:

  ```
  q(v) = 0                                       if v is NaN
  c    = clamp(v, 0, 1)                          (so -inf is 0 and +inf is 1)
  q(v) = floor(fl32(fl32(c * 255) + 0.5))         round half up, in single precision
  ```

  The value is taken as stored (no sRGB conversion); alpha is straight (not premultiplied); only
  mip level 0 is converted. `protocol/golden-8/float-quantize.json` holds vectors for all eight
  formats, generated by the checker's independent TypeScript implementation
  (`scripts/lib/gate8-float-checks.ts`) and asserted byte for byte by rs-core's tests. A receiver
  that quantizes types the caveat `float-texture-quantized` (a receiver-side note, no wire change).
  The browser receivers' use of it, and their float checks, are G8g's.
- **Still refused:** `RGBA4444`, `RGB565` and `RGBE9995` (unsized), and every non-decodable
  block-compressed format G8t lists.
