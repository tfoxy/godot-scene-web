# render-stream/9 wire format

Status: specified and golden-tested at G8k9 (2026-10-24), written with
[texture-delivery-design.md](texture-delivery-design.md) D1, D4, D5, D6, D12, D13 and Q5, which this
document implements. /9 is **opt-in**: the capture's file sinks stay on /6 unless asked
(`GRC_STREAM_VERSION=9`), the live listener offers `render-stream.9` only under
`GRC_STREAM_VERSION=9`, and a receiver offers it only when told to (G8kp: the native receiver's and
GSW's `RS_RECEIVER_PROTOCOL=9`; "As built (G8kp)"). Nothing in /2 to /8 changes: `golden-2/` to `golden-8/` pass unchanged
and the window-1 transcripts (`capture/test/golden/live-window1-transcripts.txt`) are byte-identical.
Codecs (G8k9): the C++ encoder (`capture/src/rs2_codec.*`, `rs2_diff.*`, behind `Session::version`),
the TypeScript decoder/validator/resolver (`scripts/lib/render-stream-2.ts`, behind an explicit
`version` parameter), and the Rust core's decoder and validator (`rs-core/src/{wire,meta,validate,
canon,payload,state}.rs`), all checked state-for-state against `protocol/golden-9/`, per this text.
The capture's delivery behaviour is not here yet: G8k9 lands the wire, the policy parsing and one
empty seam (`capture/src/rs_texture_delivery.*`) that G8kp, G8ku and G8ke fill.
[render-stream-8.md](render-stream-8.md) and, through it, render-stream-7.md to render-stream-0.md
are not superseded.

As with /3 to /8 (memory g4e1-rs3-version-switch-pattern), /9 is **not** a new forked module. The
version-parameterized C++/TypeScript/Rust modules grow an eighth value: C++'s `Session::version`
gains `ProtocolVersion::V9`, and the TypeScript `version` parameter and the Rust `version: u8`
widen to `2..=9` (the TypeScript default stays `6`). Every cascade that means "/8 or later"
(`is_v8_or_later`, `version >= 8`) now includes /9.

render-stream/9 is render-stream/8 plus exactly:

- a new magic (`GRS9`), protocol string (`render-stream/9`) and subprotocol (`render-stream.9`);
- the session key `resources.texture_delivery`, the last key of the session's `resources` object,
  right after `resources.decode`: `{"mode":<D1 mode>,"encoder":null|<params_id prefix>}`;
- `variants` in texture entries, right after `payload_bytes`: the alternative payloads of an ok
  image texture;
- `block` GRT1 payloads (a block-compressed `format`), legal only as a variant;
- the `render-stream-texture/ktx2` payload: a KTX2 file, legal only as a variant;
- the texture reason `delivery-pending`;
- the hello keys `texture_encodings` and `gpu_formats`.

Everything else is exactly as in render-stream-8.md and, through it, render-stream-7.md to
render-stream-0.md: record framing, the block types, the record sha256 definition, canonical JSON,
every table's other fields and invariants, every other payload format, out-of-band delivery, HTTP
resource routes (`Content-Encoding` of G8kz included) and the live control messages. **Records,
blocks, items, canvases, commands, meshes, shaders and materials are byte-identical to /8.** The
base texture entry keeps its /8 meaning, the `decoded` payload (texture-delivery-design.md D5), so
a receiver that ignores `variants` is a correct /8 receiver.

## File layout

```
magic        8 bytes   47 52 53 39 0D 0A 1A 0A   ("GRS9\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /9 refuses `GRS8` (or any other byte 3) with `bad-magic`, and a /8 decoder
refuses `GRS9` the same way.

## Session record

Key order is /8's: `type`, `protocol`, `session_id`, `stream`, `engine`, `capture`, `viewport`,
`resources`, `materials`, `features`, `publication`, `sabotage`, [`unknown_item_policy`],
`adoption`, `blocks`. `protocol` is `"render-stream/9"`.

```json
"resources":{"hash":"sha256","payloads":[...],"delivery":...,"inline_max_bytes":...,
             "max_payload_bytes":...,"permitted_formats":[...],"fetch":...,"http_path":...,
             "auth":...,"decode":"off"|"engine",
             "texture_delivery":{"mode":"rgba"|"passthrough"|"basis-uastc"|"basis-etc1s",
                                 "encoder":null|"<params_id prefix>"}}
```

- `resources.texture_delivery` declares the host's delivery mode (`GRC_TEXTURE_DELIVERY`,
  texture-delivery-design.md D1) and the Basis encoder it runs. `mode` names the variants the host
  offers beside `decoded`: `rgba` none, `passthrough` `block`, `basis-uastc` `block` and `uastc`,
  `basis-etc1s` `etc1s`. `encoder` is the params_id prefix of the Basis encoder (for example
  `basisu-1.60`, matching `^[a-z0-9][a-z0-9._-]*$`), or `null` when the host runs none.
- **The key is `texture_delivery`, not `delivery`.** The design text (D4, Q5) called it
  `resources.delivery`, but `resources.delivery` already exists since /2 (`out-of-band`, `inline` or
  `mixed`), so a second key of that name would be a duplicate in one JSON object. G8k9 renamed it;
  texture-delivery-design.md is corrected to match.

## Texture entries

A texture entry keeps every /8 field, in /8's order, and gains `variants` right after
`payload_bytes`:

```json
{"id":..,"origin":..,"adopted_content":..,"kind":..,"status":..,"reason":..,"version":..,
 "hash":..,"format":..,"source_format":..,"width":..,"height":..,"mipmaps":..,"payload_bytes":..,
 "variants":[{"encoding":"block"|"uastc"|"etc1s","hash":"<hex>","payload_bytes":<int>,
              "format":<name>|null,"params":<params_id>|null}, ...],
 "canvas":..}
```

`hash`, `format`, `payload_bytes` and `source_format` keep their /8 meaning: the `decoded` variant
(D5). `variants` only adds alternatives, each a payload the host can serve at
`/resources/sha256/<hash>` (D3 leaves the choice to the receiver).

- `variants` is `[]` for anything but an `ok` image entry, and for an `ok` image whose host has
  prepared nothing.
- The list is **sorted by encoding in the order `block`, `uastc`, `etc1s`, with at most one variant
  per encoding.**
- A `block` variant carries `format` (the source block format, one of the block formats below) and
  `params` null. Its payload is a GRT1 payload of that format, the entry's width, height and
  `mipmaps`.
- A `uastc` or `etc1s` variant carries `format` null and a non-null `params`, which starts with the
  session's `encoder` and a `/` (`basisu-1.60/uastc-l1/zstd6/linear`). Its payload is a KTX2 file.
- `payload_bytes` of a variant is its whole payload's length, as for the base entry. It is at least
  1.
- **Variant lifetime (D6).** `version` counts content. `variants` may **grow at an equal
  `version`**: a lazy encode that finishes publishes a changed (patch) entry with one more variant
  and the same `version`. Every earlier variant stays identical. A content change raises `version`
  and resets `variants` to what is ready for the new content.

### Invariants

`delivery-entry` (self-coded, as `adoption-entry` and `decode-entry`), checked over the entries a
transaction carries:

1. an entry with variants is an `ok` image;
2. variants are sorted by encoding with at most one each;
3. every variant's encoding is one the session's `mode` offers;
4. `payload_bytes` >= 1, and no variant repeats a hash of its own entry (the base hash or another
   variant's);
5. a `block` variant's `format` is a block format and its `params` is null;
6. a `uastc` or `etc1s` variant's `format` is null, the session declares a non-null `encoder`, and
   `params` starts with `<encoder>/`;
7. the base entry of an `ok` image is never a block format (block payloads are legal only as
   variants).

`texture-version` is relaxed in exactly one way: at an equal `version` an entry may differ from the
earlier one in `variants` growing (each earlier variant present and identical) and nothing else.
`variants` shrinking or changing at an equal version is `texture-version`. Entries compare as whole
values otherwise.

A variant's payload is **never required** to arrive as a resource record: `resource-missing` still
names only the base `hash`. A host that does carry one (a file sink's store, or an inline record)
is checked against its entry: see "Payload checks".

### Texture reasons

`reason` gains `delivery-pending` (legal at /9 only; `meta-schema` below). It sits on an `unsupported`
image entry (hash null, `payload_bytes` 0, the usual rule): the async worker path (D11) had no
hook-time hash yet. When the payload is ready the entry returns as `ok` with a raised `version`.
At /6 to /8 G8kw holds publication back instead (Q7), with no wire change. G8k9's capture never
publishes it.

## Texture payload

`render-stream-texture/1` is unchanged. At /9 the payload `format` may also be a **block format**,
and `data_bytes` must equal Godot's size for it (`Image::get_image_data_size`,
`_get_dst_image_size`, `core/io/image.cpp:1700`): for each level of the chain
(`w = max(1, w >> 1)`, `h` likewise, until 1x1 if `mipmaps`), `ceil(w/block)*block *
ceil(h/block)*block * pixel_size >> shift` bytes, the pixel size of every block format being 1.

| format | block | shift | bytes per block |
| ------ | ----- | ----- | --------------- |
| DXT1, RGTC_R, ETC, ETC2_R11, ETC2_R11S, ETC2_RGB8, ETC2_RGB8A1 | 4 | 1 | 8 |
| DXT3, DXT5, RGTC_RG, BPTC_RGBA, ETC2_RG11, ETC2_RG11S, ETC2_RGBA8, ASTC_4x4 | 4 | 0 | 16 |
| ASTC_8x8 | 8 | 2 | 16 |

The swizzled `ETC2_RA_AS_RG` and `DXT5_RA_AS_RG`, the HDR formats and `BPTC_RGBF`/`BPTC_RGBFU` are
not offered as variants (they decode to floats, G8f's exact `decoded`). A block payload carries the
source image's own bytes, exact. Below /9 the block formats stay unsized, exactly as before. A wrong
size is `payload-size`. A block payload used as a base entry's payload is `delivery-entry`; one that
a carried resource record supplies for a variant must match that variant's entry shape
(`resource-payload`).

## KTX2 payload

`render-stream-texture/ktx2` is a KTX2 file (KTX 2.0) per texture-delivery-design.md D13, exactly
the bytes of the resource record's block, the store file `<hash>.ktx2` and the HTTP body
(`Content-Type: image/ktx2`, never content-coded). A decoder tells it from GRT1, GRM1 and GRP1 by
its 12-byte KTX2 identifier (`AB 4B 54 58 20 32 30 BB 0D 0A 1A 0A`); only at /9.

One 2D image, no layers, one face. The validator parses the header, the level index and the DFD.
**`ktx2-header`** (the file on its own):

- the identifier; `vkFormat` 0; `typeSize` 1; `pixelWidth`, `pixelHeight` >= 1; `pixelDepth` 0;
  `layerCount` 0; `faceCount` 1; `levelCount` 1 to 32;
- `supercompressionScheme` 1 (BasisLZ, which needs global data inside the file) or 2 (Zstandard,
  which has none);
- the level index, DFD and key/value data lie inside the file;
- the DFD is one Khronos basic block (KDF 1.3: total size equals `dfdByteLength`, vendor 0, type 0,
  version 2, block size `dfdByteLength - 4`) with colour model ETC1S (163) or UASTC (166), **linear**
  transfer (1), a 4x4x1 texel block, and the model agrees with the scheme (ETC1S with BasisLZ, UASTC
  with Zstandard);
- every level has `byteLength` >= 1 inside the file, and for Zstandard `uncompressedByteLength` is
  `ceil(w/4)*ceil(h/4)*16` of that level.

**`ktx2-shape`** (against the variant's entry, checked once a transaction names the carried hash):
the colour model is the variant's encoding (`uastc` or `etc1s`), `pixelWidth` x `pixelHeight` is
the entry's, and `levelCount` is the entry's mip chain length (1 without mipmaps), and the file's
length is the variant's `payload_bytes`.

The transcode target and its oracle (D14, D16) are receiver behaviour and not part of the wire.

## Live transport

`render-stream.9` is /8's live transport (render-stream-7.md "Live transport", render-stream-8.md)
with /9's session and tables. Its hello is /7's thirteen keys under `protocol` `"render-stream/9"`
**plus two flat string keys**, so the hello grammar stays flat (no arrays, booleans or nulls):

- `texture_encodings`: the receiver's preference, comma-separated, from `block`, `uastc`, `etc1s`
  and `decoded` (texture-delivery-design.md D3, Q3);
- `gpu_formats`: Godot's feature names the receiver can upload (`s3tc`, `bptc`, `rgtc`, `etc2`,
  `astc`). A receiver with none sends `none`.

Each matches `^[a-z0-9]+(,[a-z0-9]+)*$` and is at most 96 characters; the empty string is invalid.
The host records both in its summary and log and, in G8k9, does nothing else with them. A /8 hello
on a /9 connection, or the reverse, is `error` `protocol`, close 1002.

The listener offers `render-stream.9` **only under `GRC_STREAM_VERSION=9`**, then `.8`, `.7`, `.6`
(under a gate 8 policy, `.9` then `.8`). Every other configuration offers exactly what /8 offered.
No receiver's hello offers `render-stream.9` in G8k9; since G8kp the native receiver and GSW do
under `RS_RECEIVER_PROTOCOL=9` ("As built (G8kp)").

## Capture policy

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_STREAM_VERSION` | `6` (default), `8`, `9` | the wire version of **file** sinks |
| `GRC_TEXTURE_DELIVERY` | `rgba` (default), `passthrough`, `basis-uastc`, `basis-etc1s` | declared by a /9 session as `resources.texture_delivery.mode` |

`GRC_TEXTURE_DELIVERY` has no effect below /9, where the `decoded` payload is all there is (D4), so
it is not a gate 8 policy and needs no /9 sink. An invalid value refuses with
`invalid GRC_TEXTURE_DELIVERY=…`. `result.json` gains `stream.gate8.texture_delivery` only when the
file sink is /9.

G8k9's seam, `rs::texture_variants` (called from `Mirror::wire_entry` for every ok image entry) and
`rs::declare_texture_delivery` (called when the stream's `ResourcePolicy` is built, so file sinks and the
live template both declare it), are empty: the mode is declared,
the encoder is `null`, and every entry carries `variants: []`.

## Decoded and resolved forms

`decodeRecording()` on a /9-magic stream returns `{"schema":"render-stream-9-decoded/1",...}`,
shaped as /8's, with the new session and table keys carried verbatim. `resolveRecording()` returns
`render-stream-9-resolved/1`; the per-transaction resolved `state` is /8's, except that every
texture entry carries `variants` right after `payload_bytes`. The session's
`resources.texture_delivery` is session-level and, as every session field, not part of the resolved
form.

## Golden vectors (`golden-9/`, G8k9)

`make_golden.py` (stdlib only, deterministic, `--check` mode) loads golden-8's generator as a module
(which loads golden-6's) and re-binds the few functions whose wire shape changes. It writes the
full/patch/inline triple, because the resource tables change shape:

- `full.rs9`, `patch.rs9`, `inline.rs9`: eight states -- golden-8's six, then state 7 (texture 11,
  an RGBA8 16x16 image with a mip chain, appears with one `block` variant; texture 7, the
  host-decoded DXT5 texture, gains its `block` variant at an **equal version**, and a new item draws
  texture 11) and state 8 (texture 7 and texture 11 gain a `uastc` variant at an equal version;
  texture 6's content changes, version 3, so its variants reset; texture 12 is an unsupported image
  with reason `delivery-pending`). The session declares mode `basis-uastc`, encoder `basisu-1.60`.
  All three resolve to `resolved.json`; `patch.rs9` is seq 1 full, seq 2-4 patches, seq 5 a full
  resync and seq 6-8 patches; `inline.rs9` carries the variants' payloads as resource records too, and
  its `record_index` values were taken by decoding it (`make_golden.py` reads them back from the
  decoded records).
- `off.rs9`: a websocket stream with mode `rgba`, encoder `null`, a `perturb-decode` sabotage
  declaration; resolves to `resolved-off.json`.
- `invalid/`: `bad-magic` (golden-8's `off.rs8` handed to a /9 decoder), `delivery-mode`, and
  `delivery-entry-*` (mode, mode-uastc, order, duplicate, not-ok, block-params, block-format,
  basis-format, basis-params, no-encoder, block-base, hash, bytes), `variants-shrink` and
  `variants-change` (`texture-version`), `block-payload-size` (`payload-size`),
  `block-payload-shape` (`resource-payload`), `ktx2-header-*` (vkformat, transfer, truncated,
  level-range) and `ktx2-shape-*` (size, levels, codec). Every other rule /9 keeps is covered by
  golden-2 to golden-8's vectors.
- `control/valid`, `control/invalid`: the /9 hello vectors (`rs_live_test.cpp`'s `parse_control(V9)`
  and `self-test-rs2.ts` parse the same files).
- `corrupt-meta.rs9`, `payloads/` (the block GRT1 payloads, the two KTX2 files, and golden-8's).

**Where the KTX2 files come from.** `payloads/ktx2-16x16-mips.ktx2` (five levels) and
`ktx2-4x4.ktx2` (one level) are **real UASTC LDR 4x4 + Zstandard KTX2 files that Godot 4.5.1's
editor binary wrote** from two procedural gradient images, through its vendored basisu
(`PortableCompressedTexture2D.create_from_image` with `COMPRESSION_MODE_BASIS_UNIVERSAL`, level 1).
`gen_ktx2.gd` is the committed generator (run it with `mise exec -- godot --headless --path
experiments/render-stream/receiver --script … -- <out-dir>`); its two outputs are committed, and
`make_golden.py` only reads them. They are synthetic: no game content is involved. G8ku vendors
basisu itself and produces the production files.

Checks: `scripts/test/self-test-rs2.ts` (`runSuite(golden-9, 9)`, the hello vectors, and the
version-gate cases it builds by re-framing the /9 session), `capture/test/rs9_codec_test.cpp` (the
C++ encoder, including `make_patch`, matches every `.rs9` byte for byte; /8 output ignores both
additions), `capture/test/rs_gate8_policy_test.cpp` (policy, the subprotocol offers, the seam),
`capture/test/rs_live_test.cpp`'s `test_v9_connection`, `rs-core-check goldens` / `cargo test` in
`rs-core`, and gate 8's `delivery9/capture` leg (a real /9 capture equals the /8 capture of the
same fixture, state for state).

## Versioning

As /8: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.

## As built (G8k9)

- **`resources.texture_delivery`, not `resources.delivery`.** See "Session record".
- **Hello keys are required at /9** and `none` spells an empty `gpu_formats`.
- **`delivery-pending` is an `unsupported` image entry.** It uses the existing reason/status
  coupling, so no new entry rule was needed; the recovery is a new `version`.
- **Variant payloads in a recording.** Q5 said inline resource records carry only `decoded`
  payloads, because D12(c) keeps small textures off Basis. That is the *host's* policy; the
  validators accept a variant payload as a resource record (golden-9's `inline.rs9` has four) and
  check it against its entry. This is what exercises `ktx2-header` and `ktx2-shape` in a recording,
  and a file sink's store holds them as files in any case.
- **The Rust core's resolved state** carries `variants` as a field; its apply layer ignores it and
  `rs-core-capi` accepts `version` 9 for recordings (`VERSIONS = [6, 7, 8, 9]`), so a /9 recording
  draws its `decoded` payloads exactly as the /8 one would. The capi live pin (`/6` or `/7`) is
  unchanged.
- **`rs_texture_delivery.*`** sits behind a narrow `smoke-map.json` rule (the G8w seam pattern):
  `capture-build`, `pure`, `native:gate0@*`, `native:gate8@*`. Its call sites in `entry.cpp` and
  `rs_mirror.cpp` are shared capture files and still reach `*`.

## As built (G8kp)

The wire is unchanged; G8kp fills the seam and the receivers
([texture-delivery-design.md](texture-delivery-design.md) "As built (G8kp)").

- **Capture policy at /9:** `GRC_TEXTURE_DELIVERY` accepts `rgba` and `passthrough`; `basis-uastc`
  and `basis-etc1s` refuse the stream (`texture-delivery-unimplemented: …`) until their encoders
  land. Below /9 the variable stays ignored.
- **`block` variants** are produced for every ok host-decoded image whose source format is a block
  format of the "Texture payload" table, from the hooked bytes themselves; `stream.gate8`'s
  `delivery_stats` (`block_built`, `block_bytes`, `block_declined`) count them when the sink is /9.
  The file sink's store holds each as `<hash>.grt` (index `format`: the block format); inline
  records never carry one.
- **Receivers' hello at /9:** /7's fourteen keys under `render-stream/9`, then
  `texture_encodings` (default `block,decoded`) and `gpu_formats` (the receiver's families after
  `RS_RECEIVER_GPU_FORMAT_MASK`, `none` when empty). `uploads[]` rows in a receiver's
  `applied.json` gain `encoding` (`block` or `decoded`) for /9 streams only, and `receiver` gains
  `texture_delivery` (what the receiver stated, the families it detected and the mask).


## As built (G8ku)

The wire is unchanged; G8ku produces and consumes `uastc` variants
([texture-delivery-design.md](texture-delivery-design.md) "As built (G8ku)").

- **Capture policy at /9:** `GRC_TEXTURE_DELIVERY=basis-uastc` is accepted and declares
  `{"mode":"basis-uastc","encoder":"basisu-1.60"}`; `basis-etc1s` still refuses the stream until
  G8ke. A uastc variant's `params` is `basisu-1.60/uastc-l<level>/zstd6/linear`, level 1 by default.
- **Lazy variants:** a uastc variant first appears in a patch entry at an equal `version`, its base
  hash and earlier variants unchanged ("Variant lifetime"). `stream.gate8.delivery_stats` adds
  `uastc_built`, `uastc_bytes`, `uastc_failed`, `uastc_stale`, `uastc_declined_{updated,format,small}`,
  `encodes_submitted` and the encode time totals.
- **Store and HTTP:** the file sink stores each KTX2 as `<hash>.ktx2`, its index line
  `{"type":"texture-ktx2","encoding":"uastc","params":…,"width":…,"height":…,"mipmaps":…}`; the live
  route answers a KTX2 body with `Content-Type: image/ktx2` and never content-codes it.
- **Receivers:** the native receiver and the web export state `texture_encodings`
  `block,uastc,decoded` by default; `applied.json` gains `transcodes[]` (one row per KTX2 transcode:
  `hash`, `ok`, Godot `format`, size, `mipmaps`, `data_bytes`, `ktx2_bytes`, `transcode_us`, and
  `data_sha256` under `RS_RECEIVER_TRANSCODE_LOG=1`) and `receiver.texture_delivery.variant_policy`
  (`keep` or `upgrade`). `uploads[]` rows name `uastc` as their `encoding`.
