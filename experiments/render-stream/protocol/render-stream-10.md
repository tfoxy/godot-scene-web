# render-stream/10 wire format

Status: specified at CG1 (2026-10-25), from P3-NP's diagnosis (`results/p3/p3-np.md`, the HP bars
are `clip_children`) and P3-ST's back-buffer note (gate5_5-design.md "Screen texture (P3-ST)",
"Capture and wire"). /10 is **opt-in**, like /8 and /9: the capture's file sinks stay on /6
unless asked (`GRC_STREAM_VERSION=10`), the live listener offers `render-stream.10` only under
`GRC_STREAM_VERSION=10`, and a receiver offers it only under `RS_RECEIVER_PROTOCOL=10`. Nothing
in /2 to /9 changes: `golden-2/` to `golden-9/` pass unchanged, and a session below /10 is
byte-identical to what it was (the two new hooks are not even installed, "Capture" below).

As with /3 to /9 (memory g4e1-rs3-version-switch-pattern), /10 is **not** a new forked module. The
version-parameterized C++/TypeScript/Rust modules grow a ninth value: C++'s `Session::version`
gains `ProtocolVersion::V10`, and the TypeScript `version` parameter and the Rust `version: u8`
widen to `2..=10` (the TypeScript default stays `6`). Every cascade that means "/9 or later" now
includes /10.

render-stream/10 is render-stream/9 plus exactly:

- a new magic (`GRSA`), protocol string (`render-stream/10`) and subprotocol (`render-stream.10`);
- two item keys, `canvas_group` and `copy_to_backbuffer`, right after `instance_params` and
  before `content_version`;
- a seventh transaction block, `backbuffer_f32`, holding their floats;
- `features.unobserved` loses `canvas_item_set_canvas_group_mode` and
  `canvas_item_set_copy_to_backbuffer` when the capture hooked them.

Everything else is exactly as in render-stream-9.md and, through it, render-stream-8.md to
render-stream-0.md: record framing, the record sha256, canonical JSON, the session (but for the
protocol string and the features list), every table, every payload, out-of-band delivery, the live
transport and its hello (/9's fifteen keys, with `protocol` `"render-stream/10"`). Multimesh and GPU
particles stay out of /10 (particles-multimesh-design.md "Fit with /10"); later versions are
numbered by their own designs (render-stream-11.md, W11-D).

## File layout

```
magic        8 bytes   47 52 53 41 0D 0A 1A 0A   ("GRSA\r\n\x1a\n")
```

then as /9. **Byte 3 is the version as one uppercase hex digit** from /10 on: `A` is 10, so the next
versions are `GRSB`, `GRSC`, …; /0 to /9 keep their decimal digit, which is the same hex digit. A /10
decoder refuses `GRS9` (or any other byte 3) with `bad-magic`, and a /9 decoder refuses `GRSA` the
same way. Recording files use the extension `.rs10`.

## Item

```
{"id","origin","parent","children","visible","draw_index","z_index","z_relative","behind",
 "clip","custom_rect","visibility_layer","texture_filter","texture_repeat",
 "material","use_parent_material","instance_params",
 "canvas_group","copy_to_backbuffer",
 "content_version","commands"}
```

```
"canvas_group": null
              | {"mode":"clip_only"|"clip_and_draw"|"transparent",
                 "fit_empty":<bool>,"blur_mipmaps":<bool>,"f":<int>}
"copy_to_backbuffer": null | {"f":<int>}
```

- **`canvas_group`** is the item's `canvas_item_set_canvas_group_mode(item, mode, clear_margin,
  fit_empty, fit_margin, blur_mipmaps)` state (`servers/rendering_server.h:1619-1626`,
  `renderer_canvas_cull.cpp:2015-2033`). `null` is `CANVAS_GROUP_MODE_DISABLED` (the engine frees
  the state, so a disabled call's other arguments are not kept). `mode` spells RS's
  `CanvasGroupMode` 1, 2, 3. Its two floats, `clear_margin` then `fit_margin`, are at `f` in
  `backbuffer_f32`, exactly as the engine received them.
- **`copy_to_backbuffer`** is the item's `canvas_item_set_copy_to_backbuffer(item, enable, rect)`
  state (`renderer_canvas_cull.cpp:1871-1886`). `null` is disabled. Its four floats, the rect (x,
  y, w, h) as the engine received it, are at `f` in `backbuffer_f32`. The engine copies the whole
  target when the rect equals `Rect2()` (all four compare equal to 0, `:1884`); the wire keeps the
  rect and leaves that rule to the receiver, which re-issues the rect unchanged.
- **Both are item state, not content.** Neither bumps `content_version`, both survive
  `canvas_item_clear` (`Item::clear()`, `renderer_canvas_render.h:430-460`, touches neither), and
  both go with the item when it is freed (`:2611`, `~Item`). A patch carries an item whose
  `canvas_group` or `copy_to_backbuffer` changed (an entry differs when any JSON value or any of its
  block floats differs, as for every block), with `commands: null` when its content did not change.
- **Who is a group owner is the receiver's engine's business.** The wire carries the state as set;
  whether it takes effect (an owner needs commands or `fit_empty`,
  `renderer_canvas_cull.cpp:452,462`), the subtree-first draw order, the group rect and GLES3's
  one-open-group rule (`rasterizer_canvas_gles3.cpp:463-516`) all follow from the state and the
  rest of the item tree, which the wire already carries. results/p3/p3-np.md "Engine semantics"
  has the rules a receiver that composites itself (GSW, CG3) must reproduce.

## Transaction blocks

Seven, in this order: `item_f32`, `canvas_f32`, `cmd_f32`, `cmd_i32`, `mesh_f32`, `param_f64`,
`backbuffer_f32`. The first six are as /9. `backbuffer_f32` is type `"f32"`.

`backbuffer-offset` (an invariant, and its error code): over the transaction's `items` in entry
order, and within an item `canvas_group` before `copy_to_backbuffer`, each non-null object's `f` is
the running count of floats so far (starting at 0), `canvas_group` takes 2 and
`copy_to_backbuffer` takes 4, and `backbuffer_f32`'s length equals the final count. A `canvas_group`
or `copy_to_backbuffer` that is neither `null` nor an object of exactly the keys above, a `mode`
outside the three spellings, a non-boolean flag or a negative or non-integer `f` is a schema error
(the code the decoder already uses for a malformed `items[]` entry).

## Features

`features.unobserved` is /9's list, minus `canvas_item_set_canvas_group_mode` when that hook is in
`capture.hooks_planned`, minus `canvas_item_set_copy_to_backbuffer` when that one is. A capture
whose calibration record lacks a slot (an older record) omits the hook, lists it in
`capture.hooks_omitted`, and keeps the method in `unobserved`; its items then always carry `null`
for that key, which the session has declared unobserved, not absent. Below /10 both stay in
`unobserved` and neither hook is installed.

## Capture

- **Hooks.** Calibration slots 484 (`canvas_item_set_copy_to_backbuffer`,
  `void (*)(void *, RID, bool, const Rect2 *)`) and 495 (`canvas_item_set_canvas_group_mode`,
  `void (*)(void *, RID, int32 mode, float clear_margin, bool fit_empty, float fit_margin, bool
  blur_mipmaps)`). Both are **conditional**, as G8kc's `texture_set_path`: installed only under
  `GRC_STREAM_VERSION=10`, which also makes the file sinks /10 and puts `.10` first in the
  listener's offer. Without it they are neither planned nor omitted, so
  `hooks_planned`, the counters and every /2-/9 session are what they were. The calibrator version
  stays 9 (gate8-design.md "Calibration for /10 (CG1)").
- **Mirror.** Each hook passes the call through, then sets the item's state as the engine does: a
  disabled mode (0) or `enable == false` clears it; anything else replaces it whole. A mode outside
  0-3 cannot come from scene code (`CanvasItem.set_clip_children_mode` refuses it,
  `canvas_item.cpp:1690`); the hook passes it through, leaves the mirror's state unchanged and
  counts it in `counters.json` `captured.canvas_group_mode_invalid`. A call on an item the mirror
  does not know is dropped like every other item setter's.
- **Adoption** (`GRC_ADOPT=arm`, gate8-design.md D3/G8a): the state pass reads the same values from
  the node a scene set them through: `CanvasItem.get_clip_children_mode` (any CanvasItem but a
  `CanvasGroup`, which ignores the property, `canvas_item.cpp:1699`), a `CanvasGroup`'s
  `get_clear_margin`, `get_fit_margin` and `is_using_mipmaps` (mode `transparent`, `fit_empty`
  true, `canvas_group.cpp:37`), and a `BackBufferCopy`'s `get_copy_mode` and `get_rect` (rect mode
  sends the rect, viewport mode `Rect2()`, `back_buffer_copy.cpp:33-45`).

## Live transport

`render-stream.10` is /9's live transport with /10's session and items. The hello is /9's, under
`protocol` `"render-stream/10"`. A /9 hello on a /10 connection, or the reverse, is `error`
`protocol`, close 1002. The listener offers `render-stream.10` **only under
`GRC_STREAM_VERSION=10`**, then `.9`, `.8`, `.7`, `.6` (under a gate 8 policy, `.10`, `.9` then
`.8`). A /9-or-older connection on a /10 host gets its own version's session: the two keys do not
exist there, and that session still declares both methods unobserved.

## Capture policy

| variable | values | effect |
| -------- | ------ | ------ |
| `GRC_STREAM_VERSION` | `6` (default), `8`, `9`, `10` | the wire version of **file** sinks; `10` also installs the two back-buffer hooks |

/10 carries /9's `resources.texture_delivery`, so `GRC_TEXTURE_DELIVERY` applies to a /10 sink as
to a /9 one.

## Receivers

- **Native and web export** (rs-core-capi's planner, `receiver/ext/rs_core_ext.cpp`): re-issue
  `canvas_item_set_canvas_group_mode` with the five values whenever an item's `canvas_group`
  differs from what the receiver last set (`null` re-issues mode 0), and
  `canvas_item_set_copy_to_backbuffer` (enable, rect) whenever `copy_to_backbuffer` does. The
  receiver's own Godot then does everything else.
- **GSW** (until CG3): accepts /10 and **types** both keys instead of compositing them: every item
  whose `canvas_group` or `copy_to_backbuffer` is non-null is reported with the GSW reason
  `gsw-canvas-group` or `gsw-backbuffer-copy`, and drawn as /9 would (the state ignored). A GSW
  leg over a fixture that uses them is therefore `unsupported`-typed, never silently wrong.

## Decoded and resolved forms

`decodeRecording()` on a /10-magic stream returns `{"schema":"render-stream-10-decoded/1",...}`,
shaped as /9's, with the two item keys verbatim and `backbuffer_f32` decoding to a plain float
array like every `f32` block. `resolveRecording()` returns `render-stream-10-resolved/1`: /9's
state, with every resolved item carrying, right after `instance_params` and before
`content_version`,

```
"canvas_group": null | {"mode","clear_margin","fit_empty","fit_margin","blur_mipmaps"}
"copy_to_backbuffer": null | {"rect":[x,y,w,h]}
```

with the floats inline (the setter's argument order) and no `f`.

## Golden vectors (`golden-10/`, CG1)

`make_golden.py` (stdlib only, deterministic, `--check` mode) loads golden-9's generator as a
module and re-binds what changes. It writes:

- `full.rs10`, `patch.rs10`, `inline.rs10`: golden-9's eight states, then state 9 (a clip-only
  owner with the RS defaults, clear margin 5 and fit margin 0; a clip-and-draw child under it; a
  command-less `transparent` owner with clear margin 10, `fit_empty`, fit margin 10 and
  `blur_mipmaps`; a copy with a rect and a full-target copy, `Rect2()`) and state 10 (the
  transparent owner's fit margin changes with its content unchanged, so a patch carries it with
  `commands: null`; the clip-only owner is disabled; the rect copy is disabled; the full copy's item
  is cleared with `canvas_item_clear` and keeps its copy; the clip-and-draw item is freed). All
  three resolve to `resolved.json`.
- `invalid/`: `bad-magic` (golden-9's `full.rs9` handed to a /10 decoder), `backbuffer-offset`
  (an `f` off by one) and `backbuffer-offset-short` (a block one float short), and three schema
  vectors that expect `meta-schema`: `canvas-group-mode` (`"disabled"`), `canvas-group-keys` (an
  extra key), `copy-keys` (a `rect` key beside `f`).
- `control/valid`, `control/invalid`: a /10 hello, and the same hello under `render-stream/9`.
- No `off` leg: /10 adds no session policy to switch off.
- `corrupt-meta.rs10`, `payloads/` (golden-9's).

Checks: `scripts/test/self-test-rs2.ts` (`runSuite(golden-10, 10)`),
`capture/test/rs10_codec_test.cpp` (the C++ encoder, `make_patch` included, matches every `.rs10`
byte for byte; /9 output ignores both keys), `rs-core-check goldens` / `cargo test` in `rs-core`.

## Versioning

As /9: any change to framing, a key, a key order, a block layout, an enum spelling or a payload
format is a new version.
