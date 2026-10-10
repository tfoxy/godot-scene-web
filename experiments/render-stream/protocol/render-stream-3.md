# render-stream/3 wire format

Status: specified and golden-tested at G4e1 (2026-10-09); spoken by the capture library, the
receiver and every gate runner and checker since G4e2 (2026-10-10, gate4-design.md "As built
(G4e2)"). Written with
[gate4-design.md](gate4-design.md) D1 and Q4, which this document implements. Codecs (G4e1): C++
encoder/diff (`capture/src/rs2_codec.*`, `rs2_diff.*`, behind `Session::version`), TypeScript
decoder/validator/resolver (`scripts/lib/render-stream-2.ts`, behind an explicit `version`
parameter) and GDScript decoder (`receiver/rs2_decoder.gd`), all checked byte-for-byte and
state-for-state against `protocol/golden-3/`, per this text. [render-stream-2.md](render-stream-2.md)
is **not** superseded the way render-stream-1.md was at /2: grayscale text and every other /2
capability stays on `render-stream/2` (gate4-design.md D1), and `golden-2/` keeps passing
unchanged. G4e2 switched the capture, the receiver and every gate runner to /3; /2 decoding now
remains only for `golden-2/`, as /1's did after G2b2.

Unlike every version before it, /3 is **not** implemented as a new, forked module the way /1
forked from /0 and /2 forked from /1 ("rs1 and rs2 are frozen-independent, as rs0 and rs1 were" --
render-stream-2.md D1). /3 is one new draw command and one new host sabotage kind on top of /2
(gate4-design.md D1: "/3 is /2 plus that op and one host sabotage kind... It adds nothing else"),
small enough that forking the ~600-line snapshot header, the ~650-line codec and the ~2800-line
TypeScript module for one op was not worth the duplication. Instead, the existing /2 modules grew
a protocol-version switch: C++'s `Session::version` (`ProtocolVersion::V2` default, so every
existing /2 caller is unaffected), and an explicit `version: 2 | 3 = 2` parameter on the
TypeScript and GDScript decode/validate/resolve entry points. Renaming `rs2_codec.*`/`rs2_diff.*`/
`render-stream-2.ts`/`rs2_decoder.gd` is not part of this document. **As built (G4e2):** the
TypeScript and GDScript `version` parameters now default to 3, since everything but `golden-2/`
speaks /3; `golden-2/`'s self-tests pass 2 explicitly. C++'s `Session::version` keeps its `V2`
default (the golden-2 byte tests build sessions without it), and the capture's arm path sets
`V3`. Recording files keep their `.rs2` names, like the modules: the magic and `protocol` carry
the version.

render-stream/3 is render-stream/2 plus:

- a new magic, protocol string and subprotocol;
- one new draw command, `add_msdf_texture_rect_region`, carrying the engine's MSDF arguments
  (`outline_size`, `px_range`, `scale`) alongside the rect/source-rect/modulate every other
  texture-rect command already carries;
- `features.ops` gains it, and `features.observed_unsupported_ops` loses it (it is no longer
  refused);
- one new host sabotage kind, `perturb-glyph`.

Everything this document does not change is exactly as in render-stream-2.md and, through it,
render-stream-1.md and render-stream-0.md: record framing, the `u8` block type, the record sha256
definition, canonical JSON, the texture table and its invariants, resource records, the
`render-stream-texture/1` payload format, out-of-band delivery and HTTP, and patch/resolve
semantics.

## File layout

```
magic        8 bytes   47 52 53 33 0D 0A 1A 0A   ("GRS3\r\n\x1a\n")
record       session       exactly one, first
record       resource      zero or more, each before the first transaction that needs it
record       transaction   zero or more, seq 1..N
record       end           at most one, last; nothing may follow it
```

A decoder configured for /3 refuses `GRS2` (and any other byte 3) with `bad-magic`. A decoder
configured for /2 continues to refuse `GRS3` the same way it already refuses `GRS0`/`GRS1`/
anything else that is not exactly `GRS2`: /3's new magic is simply "any other byte 3" to it.

## Session record

Key order, record framing and every field but `protocol` are exactly /2's. `protocol` is
`"render-stream/3"`.

### Features

- `ops`: /2's three plus `"add_msdf_texture_rect_region"`, all four sorted ascending by byte
  value: `["add_msdf_texture_rect_region","add_rect","add_texture_rect","add_texture_rect_region"]`.
- `observed_unsupported_ops`: /2's list without `"canvas_item_add_msdf_texture_rect_region"` (it
  is a supported op now, not a refused one). Since G5a (calibrator 7, gate5-design.md D2):
  `observed_unsupported_ops` also gains `"canvas_item_add_animation_slice"`,
  `"canvas_item_add_multiline"`, `"canvas_item_add_particles"` and `"canvas_item_attach_skeleton"`
  -- four new typed refusals, hooked but not yet given a command on any wire version. `golden-2/`
  and `golden-3/` keep their own frozen, pre-G5a feature lists (`make_golden.py`'s own copy),
  unaffected.
- Every other `features` key, and `resources`, are unchanged from /2.

### Sabotage

Sabotage kinds: /2's, plus `perturb-glyph`. Like every other kind but `omit-op`, its `op` is
`null`. `perturb-glyph` is a host sabotage (`GRC_SABOTAGE_FRAME` on, the mirror adds +0.25 to
`rect.x` of every `add_texture_rect_region` and `add_msdf_texture_rect_region` it records; the
engine still gets the true arguments), wired in at G4e2 (`rs_mirror` `set_perturb_glyph`). It
moves only commands recorded from that frame on: an item that does not redraw keeps its
unperturbed commands.

## Command

/2's three commands, plus:

```
{"op":"add_msdf_texture_rect_region","tex":<int>|null,"outline":<int >= 0>,"f":<int>}
```

| op                             | floats in `cmd_f32` | layout                                                                        |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `add_msdf_texture_rect_region` | 14                   | rect (x, y, w, h), source rect (x, y, w, h), modulate (r, g, b, a), `px_range`, `scale` |

- Every float is the engine's argument exactly, negative sizes (flips) included, as for the other
  texture-rect commands (gate4-design.md Q1g).
- `outline` is the engine's `int outline_size` (`RenderingServer.canvas_item_add_msdf_texture_
  rect_region`'s signature, `servers/rendering_server.h:1585`). It is always non-negative; a
  negative value is `meta-schema`.
- `tex`, the `unknown-texture` and `canvas-texture-headless` refusal rules, and `f`'s `cmd-offset`
  accounting are exactly as for `add_texture_rect`/`add_texture_rect_region` (render-stream-2.md
  "Commands"). A texture RID the capture never saw created gives `unsupported`/`unknown-texture`,
  in place, using no floats, exactly as it would for the other texture-rect commands.
- The derived item-level entry on an unsupported-texture draw is
  `{"op":"canvas_item_add_msdf_texture_rect_region","item":<id>,"reason":"unsupported-texture"}`,
  by the same rule render-stream-2.md "Item-level unsupported entries" states for the other two
  texture-rect ops.

No texture-table field changes: an msdf command's `tex` names an ordinary `image` entry (RGBA8,
gate4-design.md Q1b), checked by /2's unchanged `texture-entry`/`texture-ref`/`texture-version`
rules.

## Decoded and resolved forms

`decodeRecording()` on a /3-magic stream returns `{"schema":"render-stream-3-decoded/1",...}`,
shaped as /2's. `resolveRecording()` returns `render-stream-3-resolved/1`, the /2 shape with one
more resolved-command variant:

```
{"op":"add_msdf_texture_rect_region","tex","outline","rect":[4],"src":[4],"modulate":[4],
 "px_range","scale"}
```

## Golden vectors (`golden-3/`, G4e1)

`make_golden.py` (stdlib only, deterministic, `--check` mode) re-derives /2's six golden states
byte for byte (same scene, same five items, same six textures, same `/2` command set) under the
GRS3 magic and `"render-stream/3"` protocol, then adds a seventh:

- state 7: a new item 6 (draw order after item 5) drawing three `add_msdf_texture_rect_region`
  commands against a new texture 7 ("the page", 16x16 RGBA8 -- a stand-in; gate4-design.md D5's
  real atlas is 512x512 at `msdf_size` 48, but a codec-level golden only needs to exercise the
  wire shape, and 512x512 bloated `golden-3/` to 4.9 MB against `golden-2/`'s 0.8 MB, so this uses
  the same size already used for A/Atwin/N in the shared six-state scene) -- one with `outline` 0,
  one with `outline` 4 and a negative-width rect (a flip, both against texture 7), and a third
  naming a texture RID the capture never saw, which becomes the typed `unsupported`/
  `unknown-texture` command (with its matching derived top-level entry), never a real
  `add_msdf_texture_rect_region` on the wire.

`full.rs3` encodes all seven states as full transactions (directory delivery); `patch.rs3`
patch-encodes them (seq 6 full again, as after a resync; seq 7 patched against seq 6); `inline.rs3`
is `full.rs3`'s seven states again with inline delivery, a resource record per hash (the page's
precedes seq 7). All three resolve to the same `resolved.json` (`session_id`/`stream_id`/
per-transaction `encoding` excepted, as /2's and /1's -- memory: rs1-resolved-json-excepted-fields).

`invalid/` carries exactly the five new failure modes /3 introduces (every rule /3 leaves
unchanged is already covered by `golden-2/invalid/`, and is not re-derived here):

| name                   | code                  | what's wrong                                                                                   |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `bad-magic`            | `bad-magic`           | a valid /3-shaped recording with the GRS2 magic                                                 |
| `cmd-offset`           | `cmd-offset`          | an `add_msdf_texture_rect_region` (14 floats, `f=0`) followed by a command declaring `f=12`, as if the msdf command had consumed only 12 floats |
| `meta-schema`          | `meta-schema`         | an `add_msdf_texture_rect_region` with `"outline":-1`                                           |
| `texture-ref`          | `texture-ref`         | an `add_msdf_texture_rect_region` naming texture 99, which has no table entry                   |
| `unsupported-mismatch` | `unsupported-mismatch` | an unsupported `add_msdf_texture_rect_region` (`unknown-texture`) with no derived top-level entry |

`control/` carries /2's control-message shapes with `"protocol":"render-stream/3"` (and a
`render-stream/2` hello as `hello-wrong-protocol`, the mirror image of golden-2's).

## Live transport

As /2, except the subprotocol is `render-stream.3` and the hello's `protocol` is
`"render-stream/3"`. Wired at G4e2: the capture's listener negotiates `render-stream.3` and refuses
a `render-stream/2` hello as a protocol error, and the receiver's live client speaks /3.

## Versioning

As /2: any change to framing, a key, a key order, a block layout, an enum spelling or the payload
format is a new version.
