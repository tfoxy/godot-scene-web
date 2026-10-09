# render-stream experiment — gates −1, 0, 1 and 2: capture seam, first stream, retained state, live delivery, textures

Gate 0 passed on 2026-10-09 (see "Gate 0 result" below): one opaque rectangle and a step marker,
captured by the stock release template under `--headless`, replayed by a separate receiver
project, pixel-exact against an independent reference. Its contract is
[protocol/gate0-design.md](protocol/gate0-design.md), and its wire format is
[protocol/render-stream-0.md](protocol/render-stream-0.md).

Gate 1's first increment, G1a, passed on the same day (see "Gate 1a result" below). Its fixture
has eleven retained-state steps (thirteen since G1e). The capture host gets the logical root size it needs
(`GRC_ROOT_SIZE=enforce-min-size`) and declares it. Its contract is the G1a section of
[protocol/gate1-design.md](protocol/gate1-design.md).

G1b2 followed (see "Gate 1b result" below): the capture, the receiver and both gate runners moved
to [protocol/render-stream-1.md](protocol/render-stream-1.md), with a patch-encoded sink that
resolves bit for bit to the full one, and the one-frame draw-index tie of a top-level item added
at runtime is now provoked, declared and classified. render-stream/0 is superseded.

G1c2 followed (see "Gate 1c result" below): the capture library serves the same stream live over its
own loopback WebSocket server, one transaction in flight with credit returned from the receiver's
paced render loop, and a live receiver draws the same pixels as the file replay of what it received.

G1d completed gate 1 (see "Gate 1d result" and "Gate 1 summary" below): a receiver that stalls for
two seconds costs the host one pending target and no queue, catches up to the newest state in one
transaction, and resync, reconnect and a killed receiver all leave the host and the picture
correct.

G1e followed (see "Gate 1e result" below): calibrator 4 hooks `z_as_relative_to_parent` and
`draw_behind_parent` (44 hooks), and the fixture grows to thirteen steps to prove both.

Gate 2's first increment, G2a, followed (see "Gate 2a result" below): calibrator 5 hooks eleven
texture calls (55 hooks); with a stream enabled, every `texture_2d_create` and `texture_2d_update`
copies its image into a canonical payload and hashes it on the calling thread, and every
texture call lands in a hook log; a texture fixture's rendered reference, call census and payload
hashes agree with an independent derivation. Its contract is the G2a section of
[protocol/gate2-design.md](protocol/gate2-design.md).

G2b2 followed (see "Gate 2b result" below): everything moved to
[protocol/render-stream-2.md](protocol/render-stream-2.md). The capture's mirror keeps a texture
table (ids, versions, tombstones, the payloads the hooks copied), the file sinks write a
content-addressed store or inline resource records, live connections carry payloads inline, and
the receiver uploads a texture only when a command first needs it and again only when its hash
changes, from an in-memory map, a verified cache directory or the store. render-stream/1 is
superseded.

G2c2, G2d and G2e completed gate 2 (see "Gate 2 summary" below): payloads served live over HTTP
by hash with pins and retirement, `CanvasTexture` filter and repeat (typed as unsupported on a
headless host), and bearer-token authorization.

Gate −1 of [docs/handoff-headless-render-stream.md](../../docs/handoff-headless-render-stream.md).
It answers one question before any protocol work starts:

> Can a GDExtension observe every `RenderingServer` drawing and texture call made
> by an **unmodified official** Godot release template running `--headless`,
> without patching code, without a custom engine build, and without any way to
> damage a shipped game?

**Answer: yes, measured.** A GDExtension copies the `RenderingServer` singleton's
vtable into the heap, replaces up to 55 slots with pass-through recording hooks
(the eight gate −1 hooks, 23 draw-path hooks added for gate −0.25, 11 canvas
and viewport state hooks added for gate 0, 2 more draw-order hooks added for
gate 1 G1e, and 11 texture hooks added for gate 2 G2a), and publishes the copy with one aligned pointer store into the
singleton object's first word. Native `Control` drawing, the `Label` glyph path and direct
`RenderingServer` calls from GDScript are all intercepted; the engine's own call
sites are **not** devirtualised away by the official build's LTO. Disarming
restores the original vptr and the process exits 0.

The end target is a modder loading this into a shipped game (STS2, a stripped
MegaDot 4.5.1 fork) through `GDExtensionManager.load_extension`, so the library
refuses by default: it does nothing at all unless it is handed a calibration
record that matches the running binary byte for byte, and `GRC_MODE` must say
`arm` before the one store happens.

## The pinned binary

```
~/.cache/godot-render-stream/templates/4.5.1-stable/linux_release.x86_64
sha256 54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c
```

Official `Godot_v4.5.1-stable_export_templates.tpz`, member
`templates/linux_release.x86_64`, range-extracted from the archive (the member
alone, not the whole template set). It is a non-PIE (`ET_EXEC`), stripped,
dynamically linked x86-64 ELF with no GNU build-id, and it reports
`Godot Engine v4.5.1.stable.official`. It is not committed here; neither is any
other engine binary.

Matching source for the header the calibrator parses: `../godot-4.5.1-stable`,
commit `f62fdbde15035c5576dad93e586201f4d41ef0cb` (read-only reference).

## How it works

`RenderingServer` is an abstract `Object` subclass; `RenderingServerDefault` is
the only concrete implementation and adds no virtual slots. `Object*` and
`RenderingServer*` are the same address (single inheritance, vptr at offset 0),
so the singleton's first word is its vtable address point, and slot `i` is
`*(vptr + 8*i)` — Itanium ABI, declaration order.

1. **Calibrate** (`capture/tools/calibrate.py`, offline, read-only): find the RTTI
   typeinfo name strings `15RenderingServer` and `22RenderingServerDefault`, the
   typeinfo objects that point at them, and the primary vtables that point at
   those (offset-to-top 0, typeinfo pointer, then slots). Walk each vtable and
   record per slot whether it holds a code address or the pure-virtual
   placeholder. Parse the ordered virtual list of `class RenderingServer` out of
   the pinned `servers/rendering_server.h` with the release define set
   (no `TOOLS_ENABLED`, no `DEBUG_ENABLED`, `DISABLE_DEPRECATED` **not**
   defined), derive the `Object` prefix as `slot_count − new_virtuals`, then
   require the whole implemented/pure mask to agree and the matching prefix to be
   unique.
2. **Verify at runtime** (`capture/src/calib.cpp`): see "Safety model" below.
3. **Arm** (`capture/src/vtable.cpp`): `calloc` a table of `slot_count + 2`
   pointers, copy the live table from two words before the address point (so
   offset-to-top and the typeinfo pointer come along), overwrite the hooked slots
   the record names, then one `__atomic_store_n(..., __ATOMIC_RELEASE)` of the new address
   point into the object's first word.
4. **Hook** (`capture/src/hooks.cpp`): each hook records and calls the original
   function pointer with the identical arguments. The hooks are plain functions
   whose first parameter is the `this` pointer, which is exactly the ABI of the
   member functions they replace.
5. **Disarm**: if the object still carries our address point, store the original
   back. The shadow table is deliberately leaked — another thread can be
   mid-dispatch through it at that instant.

### Measured calibration

| Binary                                  | Version                      | Slots | Object prefix | `RenderingServer` virtuals | Anchors   |
| --------------------------------------- | ---------------------------- | ----- | ------------- | -------------------------- | --------- |
| `4.5.1-stable` `linux_release` (pinned) | `4.5.1.stable.official`      | 588   | **23**        | 565                        | 17/17     |
| `4.5.1.stable.mono` `linux_debug`       | `4.5.1.stable.mono.official` | 607   | **42**        | 565                        | 17/17     |
| `4.6.2.stable` `linux_release`          | `4.6.2.stable.official`      | 592   | **22**        | 570                        | 17/17     |
| `4.7.2.stable` `linux_release`          | `4.7.2.stable.official`      | 603   | not derived   | —                          | mask only |

The prefix is 23 on the 4.5.1 release template and 42 on the debug one because
`DEBUG_ENABLED` turns `MTVIRTUAL` into `virtual` and adds `Object` virtuals; 4.6
dropped one `Object` virtual, hence 22. 4.6 also renamed
`RenderingServer::free` to `free_rid`, which the calibrator accepts under the
record key `free`. No 4.7 source is checked out locally, so the 4.7.2 row is a
measurement only (`--mask-only`): its implemented-slot mask has the same shape as
4.6.2's (slots 0–19 and 22 implemented, 20/21 the zeroed destructor pair), which
is consistent with prefix 22, but the calibrator refuses to assert a prefix it
cannot verify against the matching header.

Two facts worth knowing about this build family: pure-virtual slots in the
abstract vtable are **literally null** (there is no `__cxa_pure_virtual` symbol
in the binary at all, and no relocation covers those words), and the two virtual
destructor slots of the `Object` prefix are also zeroed in the abstract vtable.
The runtime check therefore requires all hooked slots to share one placeholder
value, that value not to be code, and the 17 anchors to be code — rather than
assuming any particular sentinel.

### Hooked slots on the pinned binary

"Tier" is the calibrator version that first emitted the slot. Tier 1 is gate −1's
set and is required; tiers 2, 3, 4 and 5 are optional (see "Calibration records and
hook versions" below). Tier 3 is gate 0's: the state the retained canvas mirror
(`capture/src/rs_mirror.h`) needs, beside the tier 1 and 2 hooks it also taps.
Tier 4 is gate 1 G1e's: the two draw-order fields the mirror held at
RenderingServer defaults until then (`z_relative`, `behind`). Tier 5 is gate 2
G2a's: texture placeholders, replacement, canvas textures, the three levels of
texture filter and repeat, and the LCD text draw (gate2-design.md Q2). With a
stream enabled the texture calls also go to the hook log
(`evidence/resources.jsonl`, "Runtime contract" below).
"Captured" is what the hook records beside its count. Every signature is copied
from the 4.5.1 header, with the line cited in `capture/src/hooks.cpp`.

| Method                                            | Slot | Tier | Captured                                                                                           |
| ------------------------------------------------- | ---- | ---- | -------------------------------------------------------------------------------------------------- |
| `texture_2d_create`                               | 24   | 1    | returned RID, image size/format/bytes, frame; with a stream, the GRT1 payload copy + SHA-256 (G2a) |
| `texture_2d_update`                               | 30   | 1    | RID, layer, image size/format/bytes, frame; with a stream, the payload copy + SHA-256 (G2a)        |
| `shader_create_from_code`                         | 54   | 2    | returned RID (code and path `String`s not decoded)                                                 |
| `shader_set_code`                                 | 55   | 2    | shader RID (code `String` not decoded)                                                             |
| `material_set_param`                              | 66   | 2    | material RID (`StringName` and `Variant` not decoded)                                              |
| `mesh_create`                                     | 71   | 2    | returned RID                                                                                       |
| `mesh_add_surface`                                | 82   | 2    | mesh, and from `SurfaceData`: primitive, format, vertex/index counts, four buffer sizes, `aabb`    |
| `mesh_surface_update_vertex_region`               | 86   | 2    | mesh, surface, byte offset, byte count, first 64 bytes                                             |
| `mesh_surface_update_attribute_region`            | 87   | 2    | as above                                                                                           |
| `mesh_set_custom_aabb`                            | 94   | 2    | mesh, AABB                                                                                         |
| `mesh_clear`                                      | 100  | 2    | mesh                                                                                               |
| `viewport_attach_canvas`                          | 313  | 3    | viewport, canvas                                                                                   |
| `viewport_set_canvas_transform`                   | 315  | 3    | viewport, canvas, transform                                                                        |
| `canvas_create`                                   | 435  | 3    | returned RID                                                                                       |
| `canvas_item_create`                              | 446  | 2    | returned RID                                                                                       |
| `canvas_item_set_parent`                          | 447  | 3    | item, parent                                                                                       |
| `canvas_item_set_visible`                         | 450  | 3    | item, visible                                                                                      |
| `canvas_item_set_transform`                       | 453  | 2    | item, transform                                                                                    |
| `canvas_item_set_clip`                            | 454  | 3    | item, clip                                                                                         |
| `canvas_item_set_custom_rect`                     | 456  | 3    | item, enabled, rect                                                                                |
| `canvas_item_set_modulate`                        | 457  | 2    | item, colour                                                                                       |
| `canvas_item_set_self_modulate`                   | 458  | 3    | item, colour                                                                                       |
| `canvas_item_set_visibility_layer`                | 459  | 3    | item, layer                                                                                        |
| `canvas_item_set_draw_behind_parent`              | 460  | 4    | item, behind                                                                                       |
| `canvas_item_add_line`                            | 462  | 2    | item, from, to, colour, width, antialiased                                                         |
| `canvas_item_add_polyline`                        | 463  | 2    | item, points, colours, width, antialiased                                                          |
| `canvas_item_add_rect`                            | 465  | 1    | item, rect, colour, antialiased                                                                    |
| `canvas_item_add_circle`                          | 466  | 2    | item, position, radius, colour, antialiased                                                        |
| `canvas_item_add_texture_rect`                    | 467  | 1    | item, rect, texture, tile, modulate, transpose (count only before calibrator 5)                    |
| `canvas_item_add_texture_rect_region`             | 468  | 1    | item, rect, texture, source, modulate, transpose, clip_uv (count only before calibrator 5)         |
| `canvas_item_add_msdf_texture_rect_region`        | 469  | 1    | count only                                                                                         |
| `canvas_item_add_nine_patch`                      | 471  | 2    | every argument                                                                                     |
| `canvas_item_add_primitive`                       | 472  | 2    | item, points, colours, UVs, texture                                                                |
| `canvas_item_add_polygon`                         | 473  | 1    | item, points, colours, UV count, texture                                                           |
| `canvas_item_add_triangle_array`                  | 474  | 2    | item, indices, points, colours, UVs, bone/weight counts, texture, count                            |
| `canvas_item_add_mesh`                            | 475  | 2    | item, mesh (passed by reference), transform, modulate, texture                                     |
| `canvas_item_add_multimesh`                       | 476  | 2    | item, multimesh, texture                                                                           |
| `canvas_item_add_set_transform`                   | 478  | 2    | item, transform                                                                                    |
| `canvas_item_set_z_index`                         | 482  | 3    | item, z index                                                                                      |
| `canvas_item_set_z_as_relative_to_parent`         | 483  | 4    | item, z_relative                                                                                   |
| `canvas_item_clear`                               | 486  | 2    | item                                                                                               |
| `canvas_item_set_draw_index`                      | 487  | 3    | item, draw index                                                                                   |
| `canvas_item_set_material`                        | 488  | 2    | item, material                                                                                     |
| `free`                                            | 549  | 1    | freed RID (deduplicated log, as tier 2)                                                            |
| `texture_2d_placeholder_create`                   | 34   | 5    | returned RID                                                                                       |
| `texture_replace`                                 | 40   | 5    | texture, by-texture                                                                                |
| `viewport_set_default_canvas_item_texture_filter` | 321  | 5    | viewport, filter                                                                                   |
| `viewport_set_default_canvas_item_texture_repeat` | 322  | 5    | viewport, repeat                                                                                   |
| `canvas_texture_create`                           | 441  | 5    | returned RID                                                                                       |
| `canvas_texture_set_channel`                      | 442  | 5    | canvas texture, channel, texture                                                                   |
| `canvas_texture_set_texture_filter`               | 444  | 5    | canvas texture, filter                                                                             |
| `canvas_texture_set_texture_repeat`               | 445  | 5    | canvas texture, repeat                                                                             |
| `canvas_item_set_default_texture_filter`          | 448  | 5    | item, filter                                                                                       |
| `canvas_item_set_default_texture_repeat`          | 449  | 5    | item, repeat                                                                                       |
| `canvas_item_add_lcd_texture_rect_region`         | 470  | 5    | item, rect, texture, source, modulate                                                              |
| `get_default_clear_color` (probe, not hooked)     | 577  | 1    | —                                                                                                  |

Floats are written as values and as float32 bit patterns (`*_bits`). Arrays keep
their first 64 elements, and `*_total` gives the real length. A tier-2 or tier-3 hook
deduplicates identical calls into one entry with `calls`, `first_frame` and
`last_frame`. It keeps at most 32 distinct entries and counts any further
distinct calls in `captured_dropped`. Nothing that owns memory is decoded: no
`String`, `StringName` or `Variant`. `SurfaceData` is read in place through the
engine's pointer, and only its leading members up to `aabb` are read. Their
offsets are pinned by `static_assert`s in `capture/src/abi.h` and by the
`abi_decode` unit test. The offsets were also cross-checked with `offsetof` probes
compiled against the pinned 4.5.1 header itself: primitive 0, format 8, the
vertex/attribute/skin buffers 16/32/48, vertex_count 64, index_data 72,
index_count 88, aabb 92, struct size 240.

The calibrator also refuses to write a record whose named slots would not pass
the library's own runtime check: pure-virtual in the abstract vtable and
implemented in the concrete one.

### Calibration records and hook versions

A record produced by an older calibrator still loads in the current library.
That record may come from a sibling calibrating another binary with whatever
`calibrate.py` was on `main` at the time. The rules:

- **Tier 1 slots are required.** If a record does not name one of the eight
  gate −1 hooks, the library refuses with `slot-mask-mismatch` before any write.
  It now refuses in `validate` mode too, so validate predicts what arm would do.
- **Tier 2 and later slots are optional.** If a record does not name one, that
  hook is not installed. Nothing is guessed, and the record is not refused. The
  omission is recorded in three places:
  - `calibration-check.json` gets an ok `hook_plan` entry whose detail names the
    omitted hooks, for example:
    `8 of 55 hooks named by the record; omitted (record predates them): …`.
  - `counters.json` lists the hook under `hooks_omitted`, and its `counts` value
    is `null` rather than `0`. A `null` means "not installed", which is
    different from "never called".
  - stdout gets a `[grc] hooks: …` line.
- **Every slot a record names is verified, whether or not it is hooked.** It must
  be pure-virtual in the abstract vtable and implemented in the concrete one, or
  the library refuses with `slot-mask-mismatch`.
- **Changing the calibrator.** Adding a key to `WANTED_SLOTS` is backward
  compatible. Bump `CALIBRATOR_VERSION` and add the hook as optional. Renaming or
  removing a key is not backward compatible. The gate's `old-record` leg proves
  that a version-1 record (tier 1 slots only) still arms.

## Build, calibrate, run

```bash
# build + unit test (cmake is at /snap/bin/cmake; override with CMAKE=)
experiments/render-stream/scripts/build-capture.sh

# re-derive the committed record, plus uncommitted records for the other local
# templates under artifacts/render-stream/calibration/
experiments/render-stream/scripts/calibrate.sh
experiments/render-stream/scripts/calibrate.sh --check   # diff, do not overwrite

# an engine fork that rebrands GODOT_VERSION_NAME (the version string is "<name> v<build>")
python3 experiments/render-stream/capture/tools/calibrate.py --binary <elf> \
  --header ../godot-4.5.1-stable/servers/rendering_server.h --version-name MegaDot --out <record>
```

The build writes `capture/build/librender_stream_capture.so` and
`capture/build/render_stream_capture.gdextension` (absolute library path,
`entry_symbol = "grc_library_init"`, `compatibility_minimum = "4.5"`). Both are
ignored. Load the `.gdextension` from a fixture autoload, as `fixtures/spike/loader.gd` does:

```gdscript
GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
```

### Run gate −1

```bash
experiments/render-stream/scripts/build-capture.sh
experiments/render-stream/scripts/calibrate.sh --check
mise exec -- pnpm render-stream:gate-minus1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 80 seconds. It imports the fixture once with the mise editor (the release template cannot
run a loose project without `.godot/`), runs the six headless legs and the two rendered legs in a
private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate-minus1/<UTC timestamp>/result.json` and exits non-zero unless every
check passed. Legs, evidence layout and criteria: [scripts/README.md](scripts/README.md). Checker
self-test: `mise exec -- pnpm exec tsx --conditions=development
experiments/render-stream/scripts/test/self-test-checker.ts`.

### Run gate 0

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_mirror, rs_publish ctests
mise exec -- pnpm render-stream:gate0 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json"
```

About 105 seconds. It imports `fixtures/gate0/` and `receiver/` with the mise editor, runs the
receiver's typed self-test, the headless capture hosts (the 400-frame capture, `preexisting`,
`unsupported` and the three sabotage captures), the headless receivers (`corrupt`,
`receiver-headless-trace`, `unsupported`), then the reference, the receiver and the three sabotage
receivers in one private `gamescope --backend headless`, then the checker, which writes
`artifacts/render-stream/gate0/<UTC timestamp>/result.json` and exits non-zero unless every check
passed. Since G1b2 every capture runs under `GRC_ROOT_SIZE=enforce-min-size`; since G2b2 it runs
on render-stream/2, every capture writing its payload store (`<capture>/store`, which holds only
the engine's hue strip here) and every file-mode receiver getting a fresh cache and that store.
Self-tests: `scripts/test/self-test-rs2.ts` (TS decoder against the /2 golden vectors),
`scripts/test/self-test-gate0.ts` (checker and classifier on synthetic evidence) and
`python3 experiments/render-stream/protocol/golden-2/make_golden.py --check`; the frozen /0 and /1
history stays checked by `scripts/test/self-test-rs0.ts`, `self-test-rs1.ts` and both older
`make_golden.py --check`.

### Run gate 1

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g1a,g1b,g1c,g1d]
```

This takes about nine minutes and runs the landed groups, `g1a`, `g1b`, `g1c` and `g1d`. It imports
`fixtures/gate1/` and `receiver/`, then runs the receiver's typed self-test and the headless
captures, each writing both sinks (`recording.rs2` full, `recording-patch.rs2` patch, render-stream/2
since G2b2) and its payload store: the
400-frame capture under `enforce-min-size`, the four `omit-update` sabotage captures and the
`root-size-observe` capture. Next it runs the headless traced receiver. The reference and the six
g1a rendered receivers share one private gamescope. Group g1b then captures the two `omit-op`
sabotages, the `patch-drop-item` sabotage and the `RS_FIXTURE_TIE=overlap` variant, and runs the
patch receiver, the sabotage receivers and the overlap variant's reference and receiver in a
second private gamescope. Group g1c runs four live legs: a host serving on an ephemeral loopback
port with a headless receiver, then, in a third private gamescope, a host with a rendered live
receiver, a file-mode replay of what that receiver received, and the `drop-message` sabotage.
Group g1d runs six more live hosts: one whose headless receiver is SIGKILLed at frame 600, then, in
a fourth private gamescope, a stalled receiver, a reconnecting one, a resyncing one, and the
`ignore-credit` and `stale-coalesce` sabotages. Last, the checker writes
`artifacts/render-stream/gate1/<UTC>/result.json` (`render-stream-gate1-report/1`). Legs and
criteria: [scripts/README.md](scripts/README.md) "Gate 1". Self-test:
`scripts/test/self-test-gate1.ts`.

### Run gate 2

```bash
experiments/render-stream/scripts/build-capture.sh          # + rs_sha256, rs_texture_payload, rs_resource_log, rs_publish ctests
mise exec -- pnpm render-stream:gate2 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g2a,g2b,g2c,g2d,g2e]
```

About fifteen minutes for all five groups. g2b, g2c and g2d need g2a's captures and reference,
and g2d also needs g2b's. It imports `fixtures/gate2/` and `receiver/`, runs the headless capture
(400 frames, `enforce-min-size`, strace, both sinks and the store) and the `unsupported` variant's
capture, then the reference, its same-build repeat and the extension-armed reference in one private
gamescope. Group g2b adds the inline capture and the five sabotage captures, the headless
receivers (strace trace, wrong-hash, stale, spurious, reupload), a live host with a headless
inline receiver, then in a second private gamescope the variant's reference and the rendered
receivers (cold, warm, patch, inline, unsupported, the two omit-op sabotages), and last the
ignore-cache receiver. Group g2c runs nine live hosts (S = 300, N = 60, quit 971, fetch http):
the headless live receiver and the drop-resource and live wrong-hash sabotages, then in a third
private gamescope the rendered `live` receiver, its file replay, the warm, stall, reconnect and
animate receivers and the unpin sabotage. Group g2d runs the `canvas` variant on a headless capture
host (the typed refusal), then, in a fourth gamescope, three rendered capture hosts with their
rendered receivers (host-renderer evidence). Group g2e runs three live hosts with
`GRC_LIVE_AUTH=token`. The checker writes `artifacts/render-stream/gate2/<UTC>/result.json`
(`render-stream-gate2-report/1`). Legs and criteria: [scripts/README.md](scripts/README.md) "Gate
2". Self-tests: `scripts/test/self-test-gate2.ts`; `fixtures/gate2/make_expected.py --check`; the
receiver's `tests/applier2_selftest.gd`.

## Runtime contract

Environment, read once at SCENE initialisation:

| Variable                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_CALIBRATION`                | absolute path to the record. Absent or unreadable → refuse `no-calibration`; present but malformed → refuse `invalid-calibration`                                                                                                                                                                                                                                                                         |
| `GRC_MODE`                       | `validate` (default; all checks, all evidence, never writes the vptr) or `arm`                                                                                                                                                                                                                                                                                                                            |
| `GRC_EVIDENCE_DIR`               | absolute directory, created if missing. Unset → the same payloads go to stdout as `[grc] evidence <name> …` lines                                                                                                                                                                                                                                                                                         |
| `GRC_DISARM_AFTER_FRAMES`        | integer; disarm after that many armed frame callbacks. Unset → stay armed until the shutdown callback                                                                                                                                                                                                                                                                                                     |
| `GRC_STREAM_OUT`                 | absolute `.rs2` path of the full-encoding sink (render-stream/1 from G1b2, render-stream/2 since G2b2). When this or `GRC_STREAM_PATCH_OUT` is set and the library armed, enable the canvas mirror, run the root query and publish. Unset → hooks behave as at gate −1                                                                                                                                    |
| `GRC_STREAM_PATCH_OUT`           | G1b2: absolute `.rs2` path of the patch-encoding sink (seq 1 full, then patches on `seq-1`), fed from the same per-frame snapshot as the full sink                                                                                                                                                                                                                                                        |
| `GRC_SABOTAGE`                   | test sabotage: `freeze-frame`, `omit-update`, `perturb-transform` (gate 0), `omit-op`, `patch-drop-item` (G1b2), `drop-message`, `ignore-credit`, `stale-coalesce` (live, need `GRC_LIVE_LISTEN`), and G2b2's `stale-texture`, `wrong-hash` (needs a store) and `spurious-texture-update`. `drop-resource`, `unpin` (G2c2) and any other value refuse to publish (arming is unaffected)                   |
| `GRC_SABOTAGE_OP`                | G1b2: the RenderingServer method `omit-op` drops from `GRC_SABOTAGE_FRAME` on (`free`, `canvas_item_set_visible`, …); required for `omit-op`, refused with any other kind                                                                                                                                                                                                                                 |
| `GRC_SABOTAGE_FRAME`             | first sabotaged frame, an integer ≥ 1, default 21. Read only when `GRC_SABOTAGE` is set                                                                                                                                                                                                                                                                                                                   |
| `GRC_ROOT_SIZE`                  | gate 1 (G1a), read at arm with a stream: `observe` (default; declare only) or `enforce-min-size` (`Window.set_min_size(content_scale_size)` on the root, see below). Anything else refuses to publish                                                                                                                                                                                                     |
| `GRC_LIVE_LISTEN`                | G1c2: `127.0.0.1:<port>` or `[::1]:<port>` (0 = ephemeral). Enables the mirror and root query like `GRC_STREAM_OUT` and serves the stream (render-stream/2 since G2b2, subprotocol `render-stream.2`; out-of-band payloads over `GET /resources/sha256/<hash>` on the same listener since G2c2) over the library's own WebSocket server (one receiver at a time). Any other host refuses (`non-loopback`) |
| `GRC_LIVE_TAP_DIR`               | G1c2: absolute directory for `stream-<n>.rs2` (every binary message formed for connection n, resource records included) and `live-<n>.jsonl` (the live log)                                                                                                                                                                                                                                               |
| `GRC_LIVE_MAX_MESSAGE_BYTES`     | G1c2: default 16777216; the cap is the minimum of this and the receiver's `hello.inbound_buffer_bytes` (larger: `error` + close 1009)                                                                                                                                                                                                                                                                     |
| `GRC_LIVE_HELLO_TIMEOUT_MS`      | G1c2: default 5000; no `hello` in time → close 1002                                                                                                                                                                                                                                                                                                                                                       |
| `GRC_RESOURCE_FORMATS`           | G2a, read at arm with a stream: the `Image` formats whose bytes are copied, a comma-separated subset of `L8,LA8,R8,RG8,RGB8,RGBA8` (the default); any other name refuses to publish                                                                                                                                                                                                                       |
| `GRC_RESOURCE_MAX_PAYLOAD_BYTES` | G2a: the largest canonical payload copied, a decimal integer ≥ 1, default 67108864 (64 MiB); a larger texture is logged `payload-too-large` and not copied. An engine without the `Image` binds or `image_ptr` refuses to publish (`image-access-unavailable`)                                                                                                                                            |
| `GRC_RESOURCE_STORE_DIR`         | G2b2: absolute content-addressed store (`sha256/<hash>.grt`, `index.jsonl`) every `ok` payload of each published snapshot is written to; required when a file sink is open and delivery is not inline (else the stream refuses: `resource-store-missing`)                                                                                                                                                 |
| `GRC_RESOURCE_INLINE_MAX_BYTES`  | G2b2: the largest payload a file sink carries in band as a `resource` record, default 0 (out of band); delivery is `inline` when it is at least the max payload size, `mixed` in between. Live connections follow it too (G2c2); above 1 MiB the live listener is refused                                                                                                                                 |
| `GRC_RESOURCE_BUDGET_BYTES`      | G2b2: the payload bytes the capture may retain (the mirror's plus those the last publication pins), default 536870912; above it the stream ends with `resource-budget-exceeded` (result.json `stream.reason`), as a store write failure does with `resource-store-failed`                                                                                                                                 |

Arming happens at the earliest point where the `RenderingServer` singleton is
available. With a runtime `load_extension` from an autoload that is SCENE
initialisation, because the engine singletons are already registered by then —
this is the path the scratch runs exercise, and the one the fixture uses. A
startup-loaded extension reaches SCENE initialisation at `main/main.cpp:3633`,
before `register_server_singletons()` at `main/main.cpp:3704`, so
`global_get_singleton("RenderingServer")` would still be null; the attempt is
then retried from the `startup` callback and from each `frame` callback until the
singleton exists. Only the first successful attempt decides.

That deferred path was first run on 2026-10-09, with the extension listed in a
scratch project's `.godot/extension_list.cfg` on the pinned template. It refused
a correct record as `slot-mask-mismatch`: the retry re-parsed the record into the
same lists and the anchors doubled to 34/17. Loading the record and collecting the
fingerprint now start from empty. With that change the startup-loaded extension
defers at `scene-init` and decides at `startup`: `validated` in validate mode;
`armed` in arm mode, where the scripted `add_rect` is bit-exact, and then
disarmed and restored. A `load_extension` from a `--script` `SceneTree._initialize`
arms at `scene-init` directly.

A mod's managed code always runs after the singletons exist, because
`ScriptServer::init_languages()` follows `register_server_singletons()`
(`main/main.cpp:3707`). So a `GDExtensionManager.LoadExtension` call from mod code
decides at `scene-init` and never needs the deferred path. Gate −0.5 measured the
same on the target game.

Evidence files, exactly as the runner expects:

- `result.json` — `render-stream-capture-result/1`: `status`
  (`armed|validated|refused|error`), `reason`, `vptr_written`, `disarmed`,
  `display_server`, `rendering_driver`, `rendering_method`, and (gate 0, additive)
  `stream`: `{path, patch_path, status: off|open|closed|refused|open-failed, reason,
transactions}` (`patch_path` since G1b2), and (G1c2) `live`: `{status, listen, address, port,
reason, connections}`. Written at decision time and rewritten at disarm and shutdown.
- `live.json` (G1c2, with `GRC_LIVE_LISTEN`) — `render-stream-live/1`: `status`
  (`listening|refused|failed`), `address`, `port`, `reason`; written when the listener is decided.
- `live-summary.json` (G1c2) — `render-stream-live-summary/1`: per connection the transactions
  formed and sent, coalesced callbacks, acks per stage, credit round trips, close code and side.
- `fingerprint.json` — version string, sha256, build-id, pie, load bias, live
  vptr, singleton address, abstract address point, pure placeholder, pid, and the
  `/proc/self/maps` lines of the main binary.
- `calibration-check.json` — every check with `ok` and a detail string.
- `counters.json` — `render-stream-gate-minus1-counters/1`, written at disarm and
  at shutdown. Floats are printed with `%.9g` **and** as IEEE-754 float32 hex
  bits.
- `disarm.json` — `disarmed`, `vptr_was_shadow`, `vptr_restored`, `frame`.
- `resources.jsonl` (G2a, whenever a stream is enabled) — `render-stream-resource-log/1`, the
  texture hook log (`capture/src/rs_resource_log.h`): one line per texture-related
  RenderingServer call after it was forwarded (a free is logged only for a RID created as a
  texture), drained at every frame callback. Keys, in order: gate2-design.md Q3's `frame`, `t_us`
  (since the stream opened), `thread` (`main` or `other`), `op`, `id` and `by_id` (the wire ids
  G2b2's mirror will use: one per-session counter, never reused), `rid`, `version`, `kind`,
  `status`, `reason`, `format`, `width`, `height`, `mipmaps`, `data_bytes`, `payload_bytes`,
  `hash` (SHA-256 of the GRT1 payload, copied and hashed on the calling thread before the call
  was forwarded), `copy_ns`, `hash_ns`, `conn` and `http_status` (set on G2c2's `http-get` lines), then G2a's
  additions `target` (the item, viewport or other texture RID the call names), `ref_id` (that
  texture's id), `value` (the filter, repeat or channel argument), `layer` and `root_viewport`.
  A `texture_replace` line carries the payload fields of the content its target now holds.
  G2b2 adds publisher lines (`op` `store` for a payload written to the store directory, `inline`
  for a resource record written to a sink, with `hash`, `payload_bytes` and `status`) and two
  trailing keys on a sabotage's own lines: `"sabotage":true` (spurious-texture-update's version
  bump) and `"sabotage":true,"omitted":true` (a call the omit-op sabotage dropped from the
  capture: logged, but neither the mirror nor the log's registry applies it, so the two keep
  agreeing and the sabotage shows as pixels).
  G2c2 adds the live serving lines: `pin` (a hash became servable over HTTP; `reason` `current`),
  `retire` (it stopped being servable and its bytes were released; `superseded`, or `unpin` under
  that sabotage) and `http-get` (one GET the server answered: `hash`, `http_status`,
  `payload_bytes`, `conn` the live connection streaming then, thread `other`); a drop-resource
  pin carries `"sabotage":true`.
- `armed.marker` — empty file, created immediately after the vptr store.

Deviations from the drafted contract, all additive:

- `counters.json` adds `image_details_available` (whether the `Image` method
  binds resolved), and each `canvas_item_add_polygon` entry adds `points_total`,
  `colors_total` and `texture`; captured point/colour lists are truncated at 64
  elements per call, which `points_total`/`colors_total` make visible.
- `texture_2d_create`/`texture_2d_update` entries carry `rid`, `details`, `frame`
  and (for updates) `layer` beside the drafted `width`/`height`/`format`/`data_size`.
  `frame` is the 1-based main-loop iteration the call arrived in, the same numbering
  as the fixture's own frame counter (the frame callback runs after process and
  draw), so an expected atlas update can be placed in time.
- `invalid-calibration` is a reason code in addition to the drafted ones, for a
  record that exists but does not parse or carries the wrong schema.
- Calibrator 2 added keys only; the schema string is unchanged. The new
  `counters.json` keys are:
  - `hooks_planned` and `hooks_omitted`, as described in "Calibration records and
    hook versions".
  - one `counts` entry per tier-2 hook, `null` when the hook was omitted.
  - one `captured` array per tier-2 hook, in the shapes listed in the slot table
    above.
  - `captured_dropped`.

  `calibration-check.json` adds the `hook_plan` check.

- Calibrator 3 (gate 0) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-3 hooks, and a `captured.free` array of freed RIDs (with
  `captured_dropped.free`).
- Calibrator 5 (G2a) also added keys only. `counters.json` gains a `counts`
  entry, a `captured` array and a `captured_dropped` entry for each of the 11
  tier-5 hooks; `captured.canvas_item_add_texture_rect` and `_region` arrays with
  the full arguments (256 distinct entries each instead of 32);
  `image_payload_available`; and `texture_update_unknown`. `root.json` gains
  `texture_defaults` (`filter`, `repeat`: the root `Viewport`'s scene enums read at
  arm, −1 when unread).

## Safety model

- **Refusing by default.** No `GRC_CALIBRATION`, no action. Default `GRC_MODE` is
  `validate`, which never writes.
- **Identity before anything else.** sha256 of `/proc/self/exe`, the GNU build-id
  (required absent when the record says `null`), the `get_godot_version2` version
  string, PIE flag and load bias must all match the record; a PIE binary's bias
  is taken from `dl_iterate_phdr` and added to the recorded addresses.
- **No call into an unidentified slot, ever.** The live checks only _read_ vtable
  words. The one behavioural call is `get_default_clear_color`, which the record
  names, compared byte for byte against the same method reached through
  `classdb_get_method_bind` + `object_method_bind_ptrcall`. This is what proves
  the derived indices are real and not just self-consistent.
- **One write.** A single aligned pointer-sized store with release ordering into
  heap memory the engine allocated for the singleton. Nothing else in the process
  is modified: the library imports neither `mprotect` nor `mmap` (checked with
  `nm -D --undefined-only`), and an `strace` of an armed run shows no `mprotect`
  from the arming thread after the `armed.marker` `openat`.
- **Verified restore.** Disarm compares the live vptr with our shadow address
  point before restoring, and re-reads it afterwards; both facts land in
  `disarm.json`.
- **Failure is refusal, not a crash.** A missing `Image` method bind downgrades
  texture captures to counts only; a failed check refuses with a reason; the
  hooks hold no locks across the forwarded call except the small capture mutex,
  and counters are atomics because calls arrive from loader threads too.

What this does **not** establish:

- that the shipped game's stripped fork has the same vtable layout. It needs its
  own record, which is exactly what the calibrator is for.
- that the capture is complete. 55 of the 565 `RenderingServer` virtuals are
  hooked.
- anything about performance.

## Gate −1 result (2026-10-08)

**Pass.** The integrated run is
`artifacts/render-stream/gate-minus1/20261009T020323Z/` (ignored, not committed; produced
in the integration worktree). Its `result.json` passes 18 of 18 checks across the eight
criteria in [scripts/README.md](scripts/README.md). The fixture is `fixtures/spike/` on
the pinned template.

| Leg                                 | Measured                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headless-armed`                    | display server `headless`; armed at scene init, disarmed after 60 armed frames (`vptr_was_shadow`, `vptr_restored`), then 340 more frames, `frames=400`, exit 0                                                                                                                                                    |
|                                     | in those 60 frames: `add_rect` 62, `add_polygon` 61, `add_texture_rect_region` 17, `add_msdf_texture_rect_region` 0, `add_texture_rect` 0, `texture_2d_create` 2 (an 800×6 format-5 image and the 256×256 format-1 glyph atlas, frame 1), `texture_2d_update` 1 (the atlas, frame 30, the relabel frame), `free` 0 |
|                                     | scripted rect, ColorRect rect `(0, 0, 120, 80)` in local coordinates with its colour, and the 3-point polygon all bit-exact against `fixtures/spike/expected.json`                                                                                                                                                 |
|                                     | no GPU device or driver library in the whole-run `openat` trace or in the maps/fd sample taken after arming; 1 `mprotect` after `armed.marker`, an anonymous 132 KiB malloc arena, none in the executable's 5 mapped ranges                                                                                        |
| `headless-validate`                 | `validated`, `vptr_written: false`                                                                                                                                                                                                                                                                                 |
| `refuse-sha` / `refuse-binary-byte` | `fingerprint-mismatch` (record digest changed / one byte flipped in the unmapped `.comment` section), `vptr_written: false`                                                                                                                                                                                        |
| `refuse-prefix`                     | `slot-mask-mismatch` (anchors 11/17 with every index +1), `vptr_written: false`                                                                                                                                                                                                                                    |
| `refuse-nocal`                      | `no-calibration`, `vptr_written: false`                                                                                                                                                                                                                                                                            |
| `rendered-armed`                    | OpenGL 3.3 Compatibility on the RTX 2060 under X11 in private gamescope; armed for all 400 frames: `add_rect` 401, `add_polygon` 400, `add_texture_rect_region` 17, `free` 7                                                                                                                                       |
| `rendered-unarmed`                  | capture extension absent; `unarmed.png` and `armed.png` are byte-identical files (sha256 `4ae01e54…`)                                                                                                                                                                                                              |

### The gate fails when it should

Three sabotaged runs, none committed, each failing exactly one check, all under
`artifacts/render-stream/gate-minus1/`:

| Sabotage                                         | Run                       | Failing check                                  |
| ------------------------------------------------ | ------------------------- | ---------------------------------------------- |
| `SCRIPT_RECT.x` 213.25 → 213.5 in `spike.gd`     | `sabotage-a-script-rect/` | #4 `script-add-rect`                           |
| `ShadowVtable::disarm` skips the restoring store | `sabotage-b-no-restore/`  | #6 `disarm-restored` (`vptr_restored: false`)  |
| `hook_add_rect` forwards green + 1/255           | `sabotage-c-hook-colour/` | #7 `armed-vs-unarmed-pixels` (channel delta 1) |

In (c), pixelmatch reported 0 differing pixels. The explicit `maxChannelDelta: 0` caught
the change.

### What this proves

- A GDExtension loaded at runtime into the unmodified official 4.5.1 release template
  can interpose on `RenderingServer` under `--headless` with one pointer store. It
  makes no code-page change and opens no GPU device. It sees native Control drawing,
  the Label glyph path including the atlas update the relabel causes, and direct
  script calls, all with exact argument bytes.
- It disarms cleanly. Rendered output is byte-identical with capture armed and with
  capture absent.
- It refuses before writing on a wrong digest, a wrong slot table, a missing record
  and a one-byte binary change.

### What this does not prove

- The `add_msdf_texture_rect_region` and `add_texture_rect` hooks were never called:
  the default font is a bitmap atlas, and the fixture has no `TextureRect`. They are
  installed, but their argument decoding has not been exercised.
- Only 8 slots were hooked in that run, so nothing in it says the capture is
  complete. The 23 draw-path hooks added afterwards are covered in the next
  section.
- Only Linux x86-64 and this one binary were tested. The startup-loaded path (deferred
  arming) was not run here; it was run, and fixed, on 2026-10-09 (see "Runtime contract").
- MegaDot and the shipped game were not tested. Their stripped fork needs its own
  record, which is gate −0.5.
- No costs were measured.

## Gate −0.5 result (2026-10-09)

**Pass.** The operator approved the run. The library ran unmodified with
`GRC_MODE=validate` against the installed STS2 binary (`MegaDot v4.5.1.m.14.mono.custom_build`,
non-PIE, with a GNU build-id). The instance was owned, isolated and `--headless`, run under
sts2-couch-coop's instance rules.

- **Offline calibration.** `calibrate.py --version-name MegaDot` against the pinned 4.5.1 header gives
  588 slots: Object prefix **23** plus 565 `RenderingServer` virtuals. **17/17** anchors match, the
  mask is unique, so there are no interior insertions, and the pure placeholder is 0. The hooked-slot
  indices are identical to the stock release template's. The record holds addresses and a digest of a
  commercial binary, so it is kept in that repository's ignored research folder, not here.
- **Load route.** The modder route. An env-gated, dev-only couch-coop hook calls
  `GDExtensionManager.LoadExtension(<absolute .gdextension>)` at mod init and logs `LoadStatus` `Ok`.
  It runs on a couch-coop branch and is not merged. The mod was deployed into a private game-root
  copy, not into the install. The extension decided at `scene-init`.
- **Decision.** `validated`, `vptr_written: false`. All 13 runtime checks pass: digest, version
  string, build-id, bias, live concrete vptr equal to the recorded address + 16, anchors 17/17 in
  memory, hooked slots pure in the abstract table and implemented in the concrete one, and the
  `get_default_clear_color` probe byte-equal through the slot and through the method bind. The game
  reached its normal main-menu readiness and stayed up through the settle window.
- **Negative.** The every-index-+1 record is refused `slot-mask-mismatch` with anchors 11/17, before
  the behavioural probe.
- **Safety.** The operator's profile, the Steam remote store and the install's binaries hash identical
  before and after.
- **Teardown.** After the main menu, the game ends on SIGTERM by SIGABRT ("terminate called without an
  active exception"), with or without the extension. The control leg reproduced it, so "no crash" is
  judged over the running window.

## Draw-path hooks for gate −0.25 (2026-10-09)

Gate −0.25 arms counters on the real game. It needs counters for the paths the
game draws through: Spine rigs drawn by the spine-godot GDExtension, nine-patch
styleboxes, meshes and primitives. Calibrator 2 adds 23 optional hooks for those
paths (the tier-2 rows of the slot table above). The fixture now drives every one
of them.

**Pass.** Run `artifacts/render-stream/gate-minus1/20261009T031006Z/` (ignored,
not committed) passes 28 of 28 checks: the 18 gate −1 checks plus 10 new ones,
listed in [scripts/README.md](scripts/README.md) as #7 `new-drawings-visible`,
#9 and #10.

### spine-godot's draw path

spine-godot draws through `canvas_item_add_mesh`, not
`canvas_item_add_triangle_array`. The source is
`spine-godot/spine_godot/SpineSprite.cpp` on the `4.2` branch of
EsotericSoftware/spine-runtimes. That file was fetched and read, and it matches
the pinned copy at commit `e7dc1435`
(`sts2-couch-coop/.sts2/research/data/spine-reliable-sep04/upstream/`, sha256
`8eb74951…`). Each `SpineMesh2D` runs `_notification(NOTIFICATION_DRAW)`, which
calls `clear_triangles` (`canvas_item_clear`) and then `add_triangles`. In 4.x
`add_triangles` calls `update_mesh`. The `#ifdef SPINE_GODOT_EXTENSION` branch is
the one a GDExtension build such as the game's `libspine_godot` compiles:

- **When the mesh is rebuilt** (vertex or index count changed): `free_rid` (the
  `free` slot), `mesh_create`, then `mesh_add_surface_from_arrays` with the
  `ARRAY_FLAG_USE_DYNAMIC_UPDATE` flag. That method is implemented in
  `RenderingServer` itself and calls the virtual `mesh_add_surface`
  (`servers/rendering_server.cpp:1390-1396`). It then calls `mesh_get_surface`
  and the stride getters, which only read.
- **Every other frame**: `mesh_surface_update_vertex_region(mesh, 0, 0, …)`,
  `mesh_surface_update_attribute_region(mesh, 0, 0, …)` and
  `mesh_set_custom_aabb`.
- **Always**: `canvas_item_add_mesh` of that mesh, with an identity transform, a
  white modulate and the renderer object's canvas texture.

`canvas_item_add_triangle_array` appears only in the Godot 3
`VisualServer` branch. A GDExtension reaches these methods through ClassDB
method binds, and those binds call the virtual member functions
(`rendering_server.cpp:2350-2375`, `3315`, `3327`, `3471`). Every call in the
list above therefore dispatches through the shadow vtable, and each one has a
hook. The fixture's ArrayMesh reproduces this shape: one surface with dynamic
update, per-frame vertex and attribute region writes, a custom AABB each frame,
then `canvas_item_add_mesh`.

### Counts in the headless-armed leg (armed for 60 frames)

| Hook                                                                                                                       | Count | Source                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `canvas_item_add_triangle_array`                                                                                           | 62    | script (61, bit-exact) + the Panel's `StyleBoxFlat` (108 points, 318 indices, native)              |
| `canvas_item_add_nine_patch`                                                                                               | 62    | script (61, bit-exact, on its 4×4 texture) + `NinePatchRect` (native, same texture RID)            |
| `canvas_item_add_primitive`, `_line`, `_polyline`, `_circle`, `_set_transform`                                             | 61    | script, each bit-exact                                                                             |
| `canvas_item_add_mesh`, `canvas_item_add_multimesh`                                                                        | 61    | script, mesh RID = the ArrayMesh's `mesh_create`                                                   |
| `mesh_surface_update_vertex_region`, `_attribute_region`, `mesh_set_custom_aabb`                                           | 60    | script `_process`, once per armed frame; offset 8, 8 bytes `0080dc420040a543` / 4 bytes `ffff00ff` |
| `mesh_create` / `mesh_add_surface`                                                                                         | 2 / 2 | the ArrayMesh (format `34460401673`, 3 vertices, 24 + 12 bytes, AABB) + a scratch mesh             |
| `mesh_clear`                                                                                                               | 1     | the scratch mesh                                                                                   |
| `canvas_item_clear`                                                                                                        | 67    | engine, every redraw                                                                               |
| `canvas_item_set_transform`                                                                                                | 5     | engine                                                                                             |
| `canvas_item_create`                                                                                                       | 1     | a `Node2D` created after arming (the scene's own items exist before the extension loads)           |
| `canvas_item_set_modulate`, `canvas_item_set_material`, `material_set_param`, `shader_create_from_code`, `shader_set_code` | 1     | the Panel's modulate and `ShaderMaterial`, RIDs consistent across all five                         |

The rendered-armed leg is armed for all 400 frames on OpenGL under X11. It counts
400 or 401 calls of every per-frame hook, so the same paths are hooked on the GPU
renderer too. `unarmed.png` and `armed.png` are still byte-identical (sha256
`985ed809…`), and the new drawings appear in both. Each one covers a sample pixel,
and one sample lies inside the mesh only because the per-frame vertex update
moved that vertex.

A calibrator-1 record (leg `old-record`) arms with 8 hooks and omits 23. Each
omitted hook has a `null` count and is named in `hook_plan`. The armed run counts
`add_rect` 62 and `add_polygon` 61, and disarm restores the vptr.

### What is left

- `canvas_item_add_texture_rect` and `canvas_item_add_msdf_texture_rect_region`
  are still never called by this fixture, as at gate −1. Every tier-2 hook is
  exercised.
- Count-only by design: `shader_create_from_code`, `shader_set_code` and
  `material_set_param` record RIDs and leave their `String`, `StringName` and
  `Variant` arguments undecoded. Those are reference-counted, owning types, so
  decoding them means reproducing more engine ABI than a counter needs. Gate 5.5
  needs captured shader source, and that should go through a ClassDB call rather
  than a layout copy. The three gate −1 hooks `texture_rect`,
  `texture_rect_region` and `msdf_texture_rect_region` also stay count-only.
- Not hooked but on spine-godot's path: `mesh_get_surface` and the format and
  stride getters. They are read-only queries and draw nothing.
- Signatures that needed care: `canvas_item_add_mesh` takes its mesh RID **by
  reference**. `canvas_item_add_nine_patch` passes its axis modes as 4-byte enums
  and puts `draw_center` and `modulate` on the stack. The fixture captures
  `draw_center = false` and the modulate exactly, which proves the tail of that
  argument list. `mesh_add_surface` takes `SurfaceData` by reference.

## Gate −0.25 result (2026-10-09)

**Pass.** The operator approved this gate too. It used the same owned, isolated `--headless` STS2
instance and the same modder load route as gate −0.5, with the 31-hook library. The record was
re-derived with the version-2 calibrator: 31 of 31 hooks are named, and the indices are identical to
the stock template's. The run was `GRC_MODE=arm` with `GRC_DISARM_AFTER_FRAMES=2000`.

- **Readiness.** Normal main-menu readiness at 27 s. The library armed at `scene-init`, stayed armed for
  about 4 minutes (2000 frames at the game's idle frame cap) and disarmed itself with
  `vptr_was_shadow` and `vptr_restored`. The game stayed up afterwards. RSS was flat and there was no
  crash.
- **Counts.**

  | Hook                                       | Count  |
  | ------------------------------------------ | ------ |
  | `canvas_item_add_rect`                     | 3      |
  | `canvas_item_add_texture_rect`             | 6      |
  | `canvas_item_add_texture_rect_region`      | 25     |
  | `canvas_item_add_msdf_texture_rect_region` | 247    |
  | `canvas_item_add_mesh`                     | 65 604 |
  | `mesh_surface_update_vertex_region`        | 65 571 |
  | `mesh_surface_update_attribute_region`     | 65 571 |
  | `mesh_set_custom_aabb`                     | 65 571 |
  | `mesh_create`                              | 83     |
  | `texture_2d_create`                        | 1 526  |
  | `canvas_item_add_triangle_array`           | 0      |
  | `canvas_item_add_nine_patch`               | 0      |
  | `canvas_item_add_polygon`                  | 0      |

  The three equal mesh counts are spine-godot's per-frame pattern. They show the rigs animating
  through a third-party extension on the dummy renderer. This is the first live exercise of the
  `texture_rect` and `msdf_texture_rect_region` hooks.

- **Teardown.** Writing evidence by frame count matters here, because this game ends on SIGTERM by
  SIGABRT before any GDExtension shutdown callback runs.

## Gate 0 WP1: calibrator 3, mirror and root query (2026-10-09)

Calibrator 3 adds the 11 tier-3 hooks (slot table above). Gate −1 with them, run
`artifacts/render-stream/gate-minus1/20261009T043727Z/` (ignored), passes 28 of 28 checks with
42 hooks planned and none omitted, and `armed.png` is still byte-identical to `unarmed.png`. The
headless-armed counts of the new hooks are `viewport_attach_canvas`, `viewport_set_canvas_transform`,
`canvas_create`, `canvas_item_set_self_modulate` and `canvas_item_set_z_index` 1 each (the spike's
post-arm `CanvasLayer` and `Node2D`); `canvas_item_set_parent`, `_set_visible`,
`_set_visibility_layer` and `_set_draw_index` 6 each (the scene entering the tree after arming);
and `canvas_item_set_clip` and `_set_custom_rect` 5 each (`Control` redraws). The captured values
decode exactly: the `ColorRect`'s custom rect is `0,0,120,80`, `z_index` is 1, and the
self-modulate bits are those of `Color(0.5, 0.75, 1, 1)`.

A temporary `GRC_RS0_PROBE` hook (removed when the stream was wired) proved the mirror and the
root query at runtime before the publisher existed. On a
scratch fixture shaped like gate 0's (a root `Node` that creates its `Node2D`s in `_ready`), the
root query returned the root viewport and canvas RIDs, an identity canvas transform, cull mask
`0xffffffff` and the project's clear colour, and the snapshot was `ok`: two items on canvas 1 in
append order with draw indices 0 and 1, the moved transform, the redrawn colour, and the freed
child gone. On the spike, whose scene items exist before arming, it was `pre-existing-object` at
the root node's `canvas_item_set_parent`, with the `CanvasLayer` reported as `extra-canvas`.

One measured fact differed from the first contract text: under `--headless`, the root
`Viewport.get_visible_rect()` at arm time is `0, 0, 64, 64`, not `0, 0, 0, 0`. The headless
display server reports `Size2i()`, but `SceneTree` gives the root window a 64×64 minimum size
(`scene/main/scene_tree.cpp:2035`), and `Window::_update_window_size` clamps to it
(`scene/main/window.cpp:1144-1150`). The session records the value as read, so only the
documentation was affected; both protocol documents now say 64×64.

## Gate 0 result (2026-10-09)

**Pass.** The integrated run is `artifacts/render-stream/gate0/20261009T050442Z/` (ignored, not
committed; produced in the integration worktree). Its `result.json` has `gate_passed: true` and
passes 19 of 19 checks ([protocol/gate0-design.md](protocol/gate0-design.md) "Checks"). Every leg
classifies as expected. The capture host is the pinned release template under `--headless` with
the 42-hook library armed at `scene-init` (calibrator 3, none omitted); the reference and the
receiver are the same template rendering OpenGL 3.3 on the RTX 2060 inside one private gamescope.
Gate −1 on the same build still passes 28 of 28
(`artifacts/render-stream/gate-minus1/20261009T050631Z/`).

| Leg                       | Class (expected = measured)           | Measured                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                 | `success`                             | 400 transactions, frames 1..400, every status `ok`; `bytes_total` 429 425 (file 429 610 with the end record), `max_record_bytes` 2 873 (the session; transactions 1 062–1 067), `encode_ns_total` 2 184 113, `snapshot_ns_total` 378 958                    |
|                           |                                       | session: `display_server` `headless`, `clear_color` `0.2, 0.2, 0.4, 1`, identity root canvas transform, cull mask `4294967295`, `host_visible_rect` `0, 0, 64, 64`; no GPU device or library in the `openat` trace or the maps/fd sample                    |
|                           |                                       | 39 intercepted calls in 400 frames: 2 `canvas_item_create` (the `Node2D`s, after arming), 4 `set_parent`, 2 `set_draw_index` (0 and 1), 4 `set_transform` (2 initial, 2 moves), 8 `clear` + 8 `add_rect` (3 subject and 5 marker draws), 6 `free`           |
| `reference`               | support                               | 5 shots, each equal to `synthesizeExpected(k)` exactly                                                                                                                                                                                                      |
| `receiver`                | `success`                             | 400 seqs applied in order, each `record_sha256` equal to the host's; shots of seqs 8, 18, 28, 38, 48 (the settle frames), each equal to `synthesizeExpected(k)` and to the reference: 0 mismatched pixels, max channel delta 0, full frame and both regions |
| `receiver-headless-trace` | support                               | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a fixture file                                                                                                                                                |
| `sabotage-freeze`         | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), steps 3 and 4: 13 312 px each; max channel delta 255                                                                                                                      |
| `sabotage-omit`           | `pixel-mismatch`, step {2}            | 52 transactions; steps 0–1 exact; step 2: 7 168 px (subject 6 144, marker 1 024), delta 255; steps 3–4 exact again (the next update repairs the snapshot)                                                                                                   |
| `sabotage-perturb`        | `pixel-mismatch`, steps {2,3,4}       | 52 transactions; steps 0–1 exact; steps 2–4: 192 px each (subject 64, marker 32 inside the regions: one-pixel columns at both edges of each rect), delta 204                                                                                                |
| `unsupported`             | `unsupported`                         | the recording carries `canvas_item_add_circle` as an `unsupported` command and an `unsupported-op` entry from step 2; the headless receiver reports it in `applied.json`, does not draw it, and ends `ok`                                                   |
| `preexisting`             | `capture-failure`                     | every one of 52 transactions is `pre-existing-object`: `rid=… op=canvas_item_set_parent frame=1` (the `.tscn`'s `Node2D`, constructed before arming)                                                                                                        |
| `corrupt`                 | `replay-failure` (seq 3, `meta-json`) | the receiver applied seqs 1–2 (24 and 0 RS calls), rejected seq 3 (`meta byte 0 is 0x00`) before any RS call for it, and exited 3                                                                                                                           |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..4).
- Receiver: `receiver/shots/seq-{8,18,28,38,48}.png`; per-step diffs `receiver/diff/step-<k>.png`
  (all blank).
- Sabotage: `sabotage-{freeze,omit,perturb}/receiver/shots/seq-<n>.png` and
  `sabotage-*/receiver/diff/step-<k>.png`; for example `sabotage-freeze/receiver/diff/step-3.png`
  marks the stale marker, the stale subject and the missing moved subject.

### The gate fails when it should

| Sabotage (capture host)                                 | What the receiver drew                                    | Check that classifies it                        |
| ------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| `freeze-frame` at 21: republish the frame-20 snapshot   | step 1's picture from step 2 on                           | `leg-class-sabotage-freeze`                     |
| `omit-update` at 21: mutations stamped 21 not mirrored  | step 1's picture at step 2 only; step 3 repairs it        | `leg-class-sabotage-omit`                       |
| `perturb-transform` at 21: `origin.x + 1` on every item | everything one pixel to the right from step 2             | `leg-class-sabotage-perturb`                    |
| fixture draws a circle (`RS_FIXTURE_VARIANT`)           | the rectangles, with the circle reported and not drawn    | `leg-class-unsupported`                         |
| scene item constructed before arming                    | (no receiver: the capture is unusable)                    | `leg-class-preexisting` (`pre-existing-object`) |
| seq 3's first meta byte zeroed in the receiver's copy   | seqs 1–2, then a replay failure with no RS call for seq 3 | `leg-class-corrupt`                             |

In each sabotage leg steps 0 and 1 matched exactly, so the mismatch starts where the sabotage does.
The classifier never reads `session.sabotage`. The publisher's refusal path was also run by hand
(not a gate leg): `GRC_SABOTAGE=bogus` and `GRC_SABOTAGE_FRAME=0` each armed, created no file and
left `stream.status: "refused"`; `GRC_DISARM_AFTER_FRAMES=30` ended a valid recording with
`reason: "disarm"` after 30 transactions.

### What this proves

- The stock 4.5.1 release template under `--headless`, with no GPU device opened, can publish a
  self-validating snapshot of the hooked canvas state every frame, through the gate −1
  interposition alone, and the snapshot is enough to redraw this fixture exactly.
- A separate Godot project that has no extension, no autoload and no copy of the fixture rebuilds
  that canvas from the recording through ordinary `RenderingServer` calls, and renders it
  pixel-identically to both the fixture rendered normally and an image synthesized from
  `expected.json` at five checkpoints.
- The receiver consumed exactly the bytes the host wrote (record hashes match), and a frozen,
  dropped or shifted update shows up as a pixel mismatch at the step where it starts.

### What this does not prove

- One rectangle per item, opaque, axis-aligned, integer coordinates, colours that land exactly on
  8-bit values, no overlap, no ties in `draw_index`. Every other draw op is only reported as
  `unsupported`; textures, text, materials and meshes are not streamed.
- The `unobserved` state in the session (texture filter/repeat, light mask, `z_as_relative`,
  y-sort, `canvas_set_modulate`, ...) is not hooked, so a scene that changes it would replay
  wrongly without any failure being reported.
- Arming must precede every canvas item (route (a), a fixture autoload). Late join and the
  deferred-arming path are gate 8; on them the capture is `pre-existing-object` by design.
- The receiver replays from a file, one transaction per `_process`, with no pacing, transport,
  credit or coalescing (gate 1). Cost numbers are for two items: about 5.4 µs encode and 0.95 µs
  snapshot per frame, about 1 060 bytes per transaction.
- Not run on MegaDot or the shipped game.

## Gate 1a result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T055845Z/` (ignored, not committed;
produced in the G1a worktree). Its `result.json` (`render-stream-gate1-report/1`) has
`gate_passed: true`, with groups `g1a` run and none missing, and 22 of 22 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1a"). Every leg classifies as expected.
The hosts are gate 0's: the pinned release template under `--headless`, with the 42-hook library
armed at `scene-init`; and the same template rendering OpenGL 3.3 on the RTX 2060 inside one
private gamescope. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T060059Z/` still passes 19 of 19, with
  `run-gate0.sh` now on the shared `lib/legs.sh`;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T060243Z/` still passes 28 of 28.

**Root geometry.** The capture host's `evidence/root.json` reads:

- logical size 640×360, stretch `disabled`/`keep`/`fractional`, content scale factor 1;
- before the policy, window 64×64 and visible rect `0,0,64,64` (the headless minimum);
- after `Window.set_min_size(640×360)`, window 640×360 and visible rect `0,0,640,360`;
- canvas and final transforms identity both before and after, so `host_size_status` is `match`.

The host fixture's own `root.jsonl` equals the reference's line for line except `display_server`
(`headless` against `X11`). Canvas 1's transform in the recording equals the reference's at all 11
settle transactions: identity through step 9, `1,0,0,1,8,4` at step 10. Without the policy
(`root-size-observe`), the host declares `degenerate-visible` with window and visible rect
64×64.

| Leg                        | Class (expected = measured)            | Measured                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                  | `success`                              | 400 transactions, every status `ok`, 20 item ids in creation order (P=1 … X=19, L2=20); `bytes_total` 2 339 645, `max_record_bytes` 6 924, `encode_ns_total` 5 599 177 (14 µs/frame), `snapshot_ns_total` 1 366 025 (3.4 µs/frame); no GPU device or library opened |
|                            |                                        | all 45 `expected.json` invariants hold on the settle transactions; no draw-index tie in any of the 400 transactions; marker colours first published at frames 1, 11, 21, …, 101                                                                                     |
| `reference`                | support                                | 11 shots, each equal to `synthesizeGate1(k)` exactly                                                                                                                                                                                                                |
| `receiver`                 | `success`                              | 400 seqs applied in order with the host's hashes, 321 RS calls (227 at seq 1); shots at seqs 8, 18, …, 108 equal to the reference and to `synthesizeGate1(k)`: 0 pixels, full frame and all 8 regions                                                               |
| `receiver-headless-trace`  | support                                | applied `ok`; no successful `openat` under `fixtures/`; no receiver file shares a sha256 with a `fixtures/gate1` file                                                                                                                                               |
| `sabotage-omit-modulate`   | `pixel-mismatch`, steps {1..10}        | step 1: 8 448 px (hierarchy 7 424, marker 1 024); steps 2–10: hierarchy 7 424 each (`P`, `C`, `G` keep their step-0 colours); delta 255                                                                                                                             |
| `sabotage-omit-transform`  | `pixel-mismatch`, steps {2..10}        | step 2: 10 240 px (hierarchy 6 912, order 2 304 = `R1`'s lost recolour, marker 1 024); steps 3–4: 9 216; steps 5–10: hierarchy 6 912 (`R1` is under `Q1` from step 5 and redrawn when re-added at 9); delta 204–255                                                 |
| `sabotage-omit-order`      | `pixel-mismatch`, steps {3}            | step 3: 2 048 px (the 32×32 `Q1`/`Q2` overlap and the marker); steps 4–10 exact again                                                                                                                                                                               |
| `sabotage-omit-visibility` | `pixel-mismatch`, steps {7..10}        | step 7: 7 424 px (visibility 4 096 = `V` still hidden, content 2 304 = `K` not cleared, marker 1 024); steps 8–10: visibility 4 096; delta 153–204                                                                                                                  |
| `root-size-observe`        | `unsupported` (`degenerate-host-size`) | declared `degenerate-visible`, visible `0,0,64,64`; every step mismatches in exactly `corner` (1 024 px) and `corner-degenerate` (1 024 px), with 0 px outside the regions. At step 10 `corner` has 672 px: the shifted `Corner` at 616,332 is clipped to 24×28     |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10).
- Receiver: `receiver/shots/seq-{8,18,…,108}.png`. The per-step diffs
  `receiver/diff/step-<k>.png` are all blank.
- Sabotage: `sabotage-omit-{modulate,transform,order,visibility}/receiver/shots/seq-<n>.png` and
  `…/receiver/diff/step-<k>.png`. For example, `sabotage-omit-order/receiver/diff/step-3.png`
  marks only the `Q1`/`Q2` overlap and the marker.
- Root size: `root-size-observe/receiver/diff/step-<k>.png` marks the missing bottom-right
  `Corner` and the one drawn at 32,32.

### The sabotage predictions, confirmed

Each sabotage drops every mirror mutation stamped with one step's applied frame (`omit-update`).
The engine still renders it.

| Sabotage                                    | Predicted (gate1-design.md)                        | Measured | Why the set ends where it does (engine source)                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omit-update` at 11 (modulate)              | {1..10}                                            | {1..10}  | `modulate` and `self_modulate` are never set again                                                                                                                                    |
| `omit-update` at 21 (transform)             | {2..10}                                            | {2..10}  | `P` and `C` never move again. `R1`'s lost recolour is only repaired at step 9, when re-entering calls `queue_redraw` (`scene/main/canvas_item.cpp:286`), so it cannot end the set     |
| `omit-update` at 31 (order)                 | {3}                                                | {3}      | `move_child` sets child draw indices in the same frame (`update_draw_order`, `canvas_item.cpp:443-444`). At step 4 `Q2`'s z puts it on top in both worlds, and step 5 moves `Q1` away |
| `omit-update` at 71 (visibility)            | {7..10}                                            | {7..10}  | `V` is never shown again in the mirror. `K` is repaired at step 8. `V1` is hidden either way (layer 0 against stale `visible: false`)                                                 |
| `GRC_ROOT_SIZE` unset (`root-size-observe`) | `unsupported`, regions {corner, corner-degenerate} | same     | the `Corner` `ColorRect` lays out against a 64×64 parent rect                                                                                                                         |

Every prediction held on the first run, so no expectation was changed. Two refusal paths were also
run by hand rather than as legs. `GRC_ROOT_SIZE=stretch-it` armed, created no recording and left
`stream.status: "refused"` with the reason. `RS_FIXTURE_STEP_FRAMES=7`,
`RS_FIXTURE_START_FRAME=0`, `RS_FIXTURE_QUIT_FRAME=100`, a relative `RS_FIXTURE_ROOT_LOG` and
`RS_FIXTURE_VARIANT` each print `[fixture] error: …` and exit 2. `S=300, N=60` (the live legs'
timeline) logs step 1 at frame 360 and step 10 at frame 900.

### Findings

- **Root size.** `enforce-min-size` is enough on a headless 4.5.1 host. One ptrcall of
  `Window.set_min_size` at arm grows the root from 64×64 to the logical size. That happens before
  the main scene's `Control`s lay out, so the size-anchored `ColorRect` is pixel-exact. The final
  (stretch × global canvas) transform stays identity. Without the policy,
  the only pixel difference in this fixture is that `Control`.
- **Draw-order ties are transient, not absent, in node-driven scenes.** None of the capture's 400
  transactions has a tie. But a top-level `CanvasItem` gets its index from `_top_level_raise_self`,
  a deferred group call that is queued while the message queue flushes. That is after
  `SceneTree::process`'s last `_flush_ugc` (`scene/main/scene_tree.cpp:708-709`), so it runs at
  the next iteration's first one (`:644`). Measured in this run: step 8's re-raise lands at frame
  82, and step 9's at 92. On frame 91, `L2` still has the RenderingServer default index 0 and the
  re-added `D` its stale 7. They tie with nothing only because step 8 had already moved the other
  top-level items to 10..16. A scratch copy of the fixture that adds a top-level node at step 1
  shows the tie: on frame 11 the new item and `P` both have index 0, and on frame 12 the new item
  has 10. So D7's "node-driven scenes never produce ties" holds only for frames after the raise.
  Once G1b2 reports `draw-index-tie`, any scene that adds a top-level item at runtime will report
  it for that one frame. Child indices (`move_child`, reparenting under an item) are set in the
  same frame. G1b2 has to decide whether such a one-frame tie is item-level `unsupported` or
  something the receiver resolves (the engine's sort is stable up to 16 siblings, so the newly
  appended item is drawn last).
- **Receiver.** The three candidates gate1-design.md listed needed no change: `X` orphaned by a
  raw parent free, `R1` re-appended under an unchanged parent, and `D` re-attached with its old
  id. The applier's free pass, parent pass and order pass already reproduce the engine's
  semantics (receiver shots exact at steps 8 and 9). Mirror unit tests now pin the two
  mirror-side cases (`rs0_mirror_test.cpp`: detach and re-attach keep the id; a raw parent free
  leaves a detached, still addressable child).

### What G1a does not prove

- render-stream/1, patches, the live adapter, credit, stalls, resync and reconnect: G1b–G1d.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture never changes
  them.
- The root-size policy was measured only on stretch `disabled`. `canvas_items` and `viewport`
  hosts declare their stretch but were not run, and the receiver applies no stretch of its own
  (G1b2 declares it on the wire).
- The fixture is still axis-aligned opaque rects on integer pixels (the one rotation is exactly
  90°), with no textures or text.

## Gate 1b result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T070813Z/` (ignored, not committed;
produced in the G1b2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a` and `g1b`
run and none missing, and 34 of 34 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1b2"). Every leg classifies as expected.
The capture library, the receiver and both runners now speak
[render-stream/1](protocol/render-stream-1.md); render-stream/0's encoder, publisher and GDScript
decoder are gone, and its goldens stay as checked history. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T071223Z/` passes 19 of 19 on /1, every capture
  under `GRC_ROOT_SIZE=enforce-min-size` (400 transactions, `bytes_total` 486 354,
  `max_record_bytes` 3 402);
- gate −1: `artifacts/render-stream/gate-minus1/20261009T071402Z/` still passes 28 of 28.

**Full sink against patch sink.** Every gate 1 capture writes both from one mirror snapshot per
frame. For the 400-frame `capture` leg (end records, rounded per frame):

| Sink                          | `bytes_total` | `max_record_bytes` | median / max transaction | `encode_ns_total` | `diff_ns_total`  | `snapshot_ns_total` (shared) |
| ----------------------------- | ------------- | ------------------ | ------------------------ | ----------------- | ---------------- | ---------------------------- |
| full (`recording.rs1`)        | 2 728 254     | 8 078              | 6 532 / 8 078 B          | 8 255 748 (21 µs) | 0                | 3 304 783 (8.3 µs)           |
| patch (`recording-patch.rs1`) | 171 195       | 7 623 (seq 1)      | 354 / 3 496 B            | 878 177 (2.2 µs)  | 1 999 967 (5 µs) | 3 304 783                    |

The patch sink is 6.3 % of the full one. Its seq 1 is the one full transaction (7 623 bytes); the
largest patch, 3 496 bytes, is a step that redraws several items. Resolved, the patch recording
equals the full one at all 400 frames, floats bit for bit.

| Leg                      | Group | Class (expected = measured)            | Measured                                                                                                                                                             |
| ------------------------ | ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`                | g1a   | `success`                              | 400 transactions, 21 item ids (P=1 … X=19, T=20, L2=21); all 48 invariants hold; one declared tie, frame 11, harmless                                                |
| `receiver`               | g1a   | `success`                              | shots at the 11 settle seqs equal the reference and `synthesizeGate1(k)`; state dumps at the settle seqs                                                             |
| `sabotage-omit-*` (four) | g1a   | `pixel-mismatch`                       | step sets as at G1a: {1..10}, {2..10}, {3}, {7..10}                                                                                                                  |
| `root-size-observe`      | g1a   | `unsupported` (`degenerate-host-size`) | now declared in the session (`degenerate-visible`, `host_visible_rect` 0,0,64,64) and in every transaction; mismatch only in `corner` and `corner-degenerate`        |
| `receiver-patch`         | g1b   | `success`                              | on the patch recording: the same 11 shots as `receiver`, pixel for pixel; equal state dumps; identical RS calls at all 400 seqs (378 in all)                         |
| `sabotage-omit-free`     | g1b   | `pixel-mismatch`, steps {8,9,10}       | 1 280 px in `lifetime`: the raw `Y` and its child `X` stay drawn; `L`, `M`, `M1` left the tree (`set_parent` to none) before their `free`, so they vanish either way |
| `sabotage-omit-visible`  | g1b   | `pixel-mismatch`, steps {6}            | 6 400 px: `V` and `V1` drawn while hidden; step 7 shows them again in both worlds                                                                                    |
| `sabotage-patch-drop`    | g1b   | `capture-failure` (`patch-divergence`) | the patch sink drops the `Marker` entry at frame 51; frames 51–60 resolve differently from the full sink (the receiver on it shows the stale marker at step 5)       |
| `tie-overlap`            | g1b   | `unsupported` (`draw-index-tie`)       | the same frame-11 tie with a 224×32 `T` over `P` and `Q`'s children, not harmless                                                                                    |

Images, all under the run directory:

- Reference: `reference/shots/step-<k>.png` (k = 0..10) and `reference/shots/frame-11.png`.
- Receivers: `receiver/shots/seq-{8,…,108}.png` and `seq-11.png`, the same names under
  `receiver-patch/shots/`; state dumps `receiver{,-patch}/state/seq-<n>.json`.
- Sabotage: `sabotage-omit-{free,visible}/receiver/diff/step-<k>.png`,
  `sabotage-patch-drop/receiver/diff/step-5.png` (the stale marker).
- Tie: `tie-overlap/reference/shots/frame-{11,12}.png`, `tie-overlap/receiver/shots/seq-{11,12}.png`.

### The one-frame draw-index tie, decided

A top-level item added at runtime keeps the RenderingServer default index 0 for one rendered frame
(G1a finding). Fixture step 1 now provokes it: `T` enters at frame 11 while `P` holds 0. The
capture declares exactly one tie in 400 transactions: frame 11, canvas 1, `{P, T}`. On frame 12 the
raise gives `T` 10. The decision (gate1-design.md D7 and G1b2 "As built") is:

- the wire declares every tie, as render-stream-1.md invariant 9 requires;
- the checker classifies a tie by what it can do to pixels. `P`'s subtree paints
  `[79,79]–[209,169]` and `T` paints `[79,303]–[113,337]` (footprints grown by 1 px), which are
  disjoint, so every order paints the same frame. The tie is **harmless**: listed in
  `harmless_ties` (`11:1`), no reason, and the legs stay `success`;
- `tie-frame-pixels` confirms it: `reference/shots/frame-11.png` equals both receivers' shot of
  seq 11 exactly;
- with `T` over `P` and `Q`'s children (`tie-overlap`) the same tie is not harmless and the leg is
  `unsupported`.

The overlap legs also measure what the engine and the receiver actually drew. This is not gated.
The variant reference's frames 11 and 12 differ in 1 536 px: on the tie frame `T` is drawn right
after `P` and under `Q`'s children, and one frame later it is raised over them. That matches the
stable insertion sort of `render_canvas` (`renderer_canvas_cull.cpp:490-493`,
`core/templates/sort_array.h:289-301`), which keeps the appended `T` after `P`. The receiver drew
both frames exactly as the reference did (0 px each). That is the expected outcome for an appended
item in a container of at most 16 siblings. In general (more siblings, or ties between items that
were already siblings) the order depends on each process's sort history, which is why a tie that
can change pixels stays `unsupported`.

### What this proves

- One mirror snapshot per frame feeds a full and a patch sink that resolve to the same state at
  every frame, bit for bit. A receiver replaying the patch recording does the same RenderingServer
  work per transaction and draws the same pixels as one replaying the full recording.
- Transform-only and canvas-only changes travel as `commands: null`: at step 2 only `R1`'s and the
  marker's rects are encoded, and at step 10 only the marker's.
- A dropped patch entry is caught by the full/patch comparison before any pixel is looked at, and
  dropping `free` or `canvas_item_set_visible` from the mirror shows up at exactly the steps the
  engine semantics predict.
- The runtime top-level tie is declared on the frame it happens and only then, and a harmless tie
  costs nothing on screen.

### What this does not prove

- Live delivery, credit, stalls, resync and reconnect (G1c2, G1d). The patch base here is always
  the previous frame of a file stream.
- That ties between items that were already siblings, or in containers of more than 16 children,
  replay in the engine's order. They are declared and classified `unsupported` unless their
  footprints are disjoint.
- The footprint analysis knows only `add_rect`; any unsupported command makes a footprint
  unbounded.
- `z_as_relative` and `draw_behind_parent` are still unobserved (G1e). The fixture is still
  axis-aligned opaque rects.

## Gate 1c result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T080634Z/` (ignored, not committed;
produced in the G1c2 worktree). Its `result.json` has `gate_passed: true`, groups `g1a`, `g1b` and
`g1c` run and none missing, and 50 of 50 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1c2"). Every leg classifies as expected.
The capture library now links `rs_ws` and serves render-stream/1 live (`GRC_LIVE_LISTEN`); the
receiver has a live mode. Runs on the same build:

- gate 0: `artifacts/render-stream/gate0/20261009T080454Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T080356Z/` still passes 28 of 28 (the
  library's imports still have no `mprotect` or `mmap`).

**Delivery.** Each live host paces the fixture at 60 frames per second with S = 300, N = 60 and
quits at frame 960; the receiver joins long before step 0 settles (first applied host frame 38,
85 and 40, against 307). Counts from each host's `live-summary.json` and the receiver's
`applied.json`; presented is reported as `"unavailable"` throughout, since Godot gives no
presentation feedback.

| Leg                     | Credit stage | Frames offered | Formed | Sent | Received / applied / submitted (receiver) | Coalesced | Credit round trip p50 / p95 / max |
| ----------------------- | ------------ | -------------- | ------ | ---- | ----------------------------------------- | --------- | --------------------------------- |
| `live`                  | `submitted`  | 923            | 912    | 912  | 912 / 912 / 912                           | 0         | 10.9 / 11.3 / 19.7 ms             |
| `live-headless`         | `applied`    | 876            | 876    | 876  | 876 / 876 / –                             | 0         | 7.1 / 7.6 / 11.6 ms               |
| `sabotage-drop-message` | `submitted`  | 522            | 517    | 516  | 515 / 515 / 515, then `seq-gap` at 517    | 0         | 9.3 / 10.0 / 20.1 ms              |

Host-side ack latency, from the main thread's send to the I/O thread's receipt of each stage's ack
(`live`, p50 / p95): received 8.9 / 9.1 ms, applied 9.2 / 9.3 ms, submitted 10.9 / 11.3 ms. On the
receiver, received → applied takes 0.64 ms (median, max 1.4) and applied → submitted (the next
`frame_post_draw`) 1.8 ms (median, max 10.5). The credit returns within 1 host frame at the
median and 2 at most, so the host sends on 912 of 923 streaming frames (99 %); none of the 11
frames without credit saw the mirror change, so nothing coalesced. Queued bytes never exceeded
7 628 (bound: the largest message, 7 624, + 4 096).

**Bytes.** The live stream is the patch encoding: a 3 405-byte session message (magic included),
seq 1 full at 7 624 bytes, then patches with a median of 354 bytes and a maximum of 3 499 (a step
that redraws several items), and a 258-byte end record: 352 749 bytes for 912 transactions on
`live`. The tap equals the received file byte for byte on `live` and `live-headless`.

| Leg                     | Group | Class (expected = measured)  | Measured                                                                                                                                                                         |
| ----------------------- | ----- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`                  | g1c   | `success`                    | 912 transactions; one shot per step window (seqs 270, 329, … 860), each equal to the reference and `synthesizeGate1(k)`; every live state equals the full recording at its frame |
| `live-replay`           | g1c   | `success`                    | the file-mode replay of `live/receiver/received.rs1`: same 912 seqs and record hashes, identical shots and state dumps at the 11 shot seqs                                       |
| `live-headless`         | g1c   | `success`                    | credit stage `applied` (forced under `--headless`), 876 transactions; under `strace -e openat` it opens nothing under `fixtures/`                                                |
| `sabotage-drop-message` | g1c   | `replay-failure` (`seq-gap`) | the host formed seq 516 at frame 560, tapped it and did not send it; the receiver failed at seq 517 (`seq-gap`), after 5 of the 11 step shots                                    |

g1a and g1b classify exactly as in "Gate 1b result". Images, all under the run directory:
`reference/shots/step-<k>.png`; `live/receiver/shots/seq-{270,329,…,860}.png` with
`live/receiver/state/seq-<n>.json`; `live-replay/shots/seq-<n>.png` for the same seqs;
`sabotage-drop-message/receiver/shots/seq-<n>.png` for steps 0–4.

### Findings

- **A Godot client never reads a message that arrives with the close frame.** The first run's
  live receiver applied 942 transactions and then reported `live-disconnected`: the host had sent
  the end record and close 1000 together, and `WebSocketPeer` returns no packets once its state
  is not `STATE_OPEN` and clears its buffer on a clean close (`modules/websocket/wsl_peer.cpp:654`,
  `:746-752`, `:827-832`, `:843-870`). The host now sends the end record and lingers (up to
  1.5 s) for the receiver to close first; error close reasons repeat the error's reason.
- **A patch after a lost message reported its base, not the gap.** Both decoders checked the
  patch rules before seq continuity, so the drop-message sabotage read `patch-base`. They now
  report `seq-gap` first (golden `invalid/patch-after-gap.rs1`).
- **Typed GDScript is checked only by the debug editor.** The release template ran the live
  receiver happily while the editor's parse of `receiver.gd` failed on one Variant passed to an
  `int` parameter; `receiver-typed-clean` caught it.

### What this proves

- The capture library can serve the stream live from inside the game process without the frame
  callback ever waiting on a socket: encoding stays on the main thread, the I/O thread only moves
  bytes, and one transaction is in flight at a time, by the host's own log and by an independent
  recount from its ack lines.
- Live delivery loses nothing a recording has: every live transaction resolves to the full file
  recording's state at its frame, and a live receiver's pixels equal both the reference and a
  file replay of exactly the bytes it received.
- A lost transaction is caught at the receiver as a sequence gap before anything is drawn from it.

### What this does not prove

- Stalls, coalescing under a slow receiver, resync and reconnect: G1d. The host handles `resync`
  and a second connection (unit-tested), but no leg exercises them, and coalescing never fired
  here because the receiver keeps up.
- Presentation: `presented` is unavailable in Godot; `submitted` is "Godot submitted the frame".
- Rates other than 60 frames per second, more than one receiver, non-loopback serving and
  constrained links (gate 6, gate 2).

## Gate 1d result (2026-10-09)

**Pass.** The run is `artifacts/render-stream/gate1/20261009T0930Z-g1d/` (ignored, not committed;
produced in the G1d worktree). Its `result.json` has `gate_passed: true`, all four groups (`g1a`,
`g1b`, `g1c`, `g1d`) run and none missing, and 65 of 65 checks pass
([protocol/gate1-design.md](protocol/gate1-design.md) "G1d"). Every leg classifies as expected.
Runs on the same library:

- gate 0: `artifacts/render-stream/gate0/20261009T090439Z/` passes 19 of 19;
- gate −1: `artifacts/render-stream/gate-minus1/20261009T090340Z/` still passes 28 of 28.

**The stall.** `live-stall`'s receiver takes its step 1 shot (seq 332, host frame 367), then blocks
its main loop for 2 000.05 ms with `OS.delay_msec` before that seq's `submitted` ack. The delay is
injected and declared so (`live.stall.injected`, with the mechanism); it is not GPU-limited work,
and the host cannot tell the difference: it only sees a credit that does not return.

| Measured on the host (`tap/live-1.jsonl`)                       | `live-stall`                                     |
| --------------------------------------------------------------- | ------------------------------------------------ |
| frames simulated between the stalled send and its credit        | 121 (367 → 488), every one logged, 16.67 ms mean |
| fixture steps applied inside the stall                          | 2 (frame 420) and 3 (frame 480)                  |
| transactions sent during the stall                              | 0                                                |
| coalesced callbacks during the stall                            | 68 (one per frame from 420 to 487)               |
| pending targets at once                                         | at most 1 (a flag; the target is the mirror)     |
| oldest pending target                                           | 68 frames, 1 133 ms                              |
| max queued bytes (whole leg / during the stall)                 | 7 628 / 2 361 (bound 11 720)                     |
| max in flight                                                   | 1                                                |
| recovery: first transaction after the credit                    | seq 333, a 2 357-byte patch on seq 332           |
| … sent after the credit arrived                                 | 0 frames (the same callback), 1.4 ms             |
| … its `applied` / `submitted` ack after the credit (host clock) | 3.6 ms / 13.0 ms                                 |
| … equal to the full recording at its frame (488)                | yes                                              |

The coalesced count starts at frame 420, not at the start of the stall: the hub counts a callback
only when the mirror changed since the last send, and this fixture changes the mirror only at step
frames (see "Findings"). Step 2's window (`[427, 479]`) lies wholly inside the stall and is the
only step without a shot, exactly as derived from the host log. The first shot after the stall
(step 3, seq 333) equals the reference and shows all 9 216 pixels step 2 changed inside the stall
(the hierarchy's new transforms and `R1`'s colour) that still show at step 3.

| Leg                       | Group | Class (expected = measured)          | Measured                                                                                                                                                                                                                                   |
| ------------------------- | ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-stall`              | g1d   | `success`                            | 569 transactions; 10 shots, all equal to the reference; step 2 missed inside the stall; numbers above                                                                                                                                      |
| `live-reconnect`          | g1d   | `success`                            | connection 1: 505 sent, closed by the receiver with 1000 after the step 4 shot (seq 505); `dispose` freed 20 of 20 RIDs, 0 left; connection 2: fresh `stream_id`, same `session_id`, seq 1 full at frame 552, 403 sent; 6 shots, all equal |
| `live-resync`             | g1d   | `success`                            | seq 629 (frame 667, step 6's window) refused unapplied, acked `received` only; the host credited the `resync` and sent seq 630 full (`base_seq` null); 2 full transactions in 922; every shot equal                                        |
| `live-receiver-killed`    | g1d   | support                              | headless receiver SIGKILLed at host frame 601; the host's connection closed 1006 (connection reset) after frame 602; the fixture quit at 960, exit 0, both file sinks complete                                                             |
| `sabotage-ignore-credit`  | g1d   | `delivery-violation`                 | from frame 488 (the receiver's 500 ms stall after its step 3 shot) 38 sends without credit, up to 31 in flight; nothing before the sabotage frame 480                                                                                      |
| `sabotage-stale-coalesce` | g1d   | `delivery-violation` (`stale-state`) | the first post-stall transaction (seq 330, frame 488) carries frame 420's state (`stale_from: 420`); its step 3 shot also differs from the reference (2 048 px)                                                                            |

g1a, g1b and g1c classify exactly as in "Gate 1c result". Images, all under the run directory:
`live-stall/receiver/shots/seq-{…,332,333,…}.png` (step 1 before the stall, step 3 after it),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 5–10 on connection 2),
`live-resync/receiver/shots/seq-630.png` (step 6, the full transaction after the resync) and
`sabotage-stale-coalesce/receiver/shots/seq-330.png` with `diff/step-3.png`.

**Acks and bytes.** Credit round trips on the host clock (send → the credit-stage ack's receipt),
p50 / p95: `live-stall` 7.3 / 18.4 ms outside the stall (max 2 015 ms, the stall),
`live-reconnect` 13.8 / 14.5 ms and 14.4 / 14.7 ms (connections 1 and 2), `live-resync`
6.8 / 7.1 ms. The g1c `live` leg measured 16.7 / 17.2 ms in this run against 10.9 / 11.3 ms in the
G1c2 run: a rendered receiver's `submitted` stage follows the private gamescope's frame timing,
which varies between runs; the credit still returned within 1–2 host frames. Bytes are G1c2's:
patches of a few hundred bytes, the stall's recovery patch 2 357 bytes (two steps' changes at
once), a fresh connection's seq 1 about 8 KB. On the host, one snapshot copy costs about 14 µs per
frame, a patch diff about 7 µs and its encoding about 2 µs (the ignore-credit host's end stats).

### Findings

- **The contract's `coalesced` bound assumed a mirror that changes every frame.** The hub counts
  a coalesced callback only when the mirror changed since the last send (Q4), and the fixture
  changes it only at step frames, so a 121-frame stall coalesced 68 callbacks (from step 2's frame
  to the credit), not "stall frames − 2". The check measures from the first in-stall change, and
  requires one coalesced callback per pending frame line.
- **ignore-credit is unobservable against a receiver that keeps up.** With credit returning in
  well under a frame (p50 8.5 ms in the first full run), a host that ignores credit sends exactly
  what a correct host sends, and that run classified the sabotage `success`. The leg now gives its
  receiver a 500 ms stall after the step 3 shot, which ends before step 4's window: the host keeps
  sending into it, 31 in flight.
- **stale-coalesce is visible only because a step lands before the credit.** The stale copy is
  frame 420's state; it differs from the newest state at the credit (488) only through step 3
  (480). A stall that ended 8 frames sooner would hide the sabotage and fail its leg check.
- **A reconnect's first stream stops short of the host's tap.** The host sends the next
  transaction as soon as the reconnect step's `submitted` ack returns the credit; the receiver
  closes without reading it. The received stream is a byte prefix of the tap, without an end
  record, and the checker requires exactly that.

### What this proves

- A receiver that stops reading for two seconds costs the host nothing it would not spend anyway:
  the simulation runs at 60 frames per second throughout, nothing is serialized for a target the
  receiver will never see, at most one transaction is in flight and one target pending, and the
  queue never grows past one message.
- The receiver catches up in one transaction to the newest state, including changes made while
  it was stalled, and draws exactly the reference afterwards.
- `resync` turns a refused transaction into one full transaction on the same stream; a reconnect
  is a fresh session that owes nothing to the old stream, with every receiver RID freed in
  between; a receiver killed mid-stream leaves the host and its recordings intact.
- A host that ignores credit, or that coalesces to a stale target, is caught by the checker.

### What this does not prove

- GPU-limited receivers: the stall is an injected main-loop block, and `submitted` is "Godot
  submitted the frame", not presentation or GPU completion (gate 6 measures those).
- Resources (no textures yet: pinning in-flight resource versions is gate 2), more than one
  receiver, arm-on-first-subscriber, non-loopback serving, other rates and constrained links.

## Gate 1e result (2026-10-09)

**Pass.** Calibrator 4 hooks `canvas_item_set_z_as_relative_to_parent` (slot 483) and
`canvas_item_set_draw_behind_parent` (slot 460), feeding the mirror's `z_relative`/`behind` fields
that render-stream/1 already carried since G1b1 (and the receiver already applied). Both leave
the session's `unobserved` list. G1e was built on G1b2 and integrated after G1c2 and G1d; the runs
below are on the integrated tree (ignored, not committed):

- gate −1: `artifacts/render-stream/gate-minus1/g1e-onto-main/` passes 28 of 28, 44 hooks planned,
  none omitted (the `older-record-loads` leg's calibrator-1 record still omits 36 and arms);
  `optional-hook-counts` includes both new hooks (the spike's post-arm `Node2D` sets non-default
  `z_as_relative`/`show_behind_parent`, so the setters' early return on an unchanged value does
  not skip the `RenderingServer` call).
- gate 0: `artifacts/render-stream/gate0/g1e-onto-main/` passes 19 of 19, `hooks_planned` exactly
  the 44 names.
- gate 1, all four groups, run twice: `artifacts/render-stream/gate1/g1e-onto-main-run1/` and
  `…-run2/` each pass 65 of 65, every leg at its expected class.

**Fixture.** Two appended steps, each adding new top-level items (so each ties with `P` at index 0
for one frame, as `T` does at step 1):

- step 11: `ZP` (z_index 1, draws nothing) with child `ZC` (z_index −1, `z_as_relative = false`,
  so its effective z is −1, not 0 — its own z_index alone, ignoring the parent's).
- step 12: `ZB` (a new top-level sibling at effective z 0, overlapping `ZC` by 32 px — the overlap
  shows `ZB`, which proves the receiver applied step 11's setter) and `BP`/child `BC`
  (`BC.show_behind_parent = true`, overlapping `BP` by 32 px — the overlap shows `BP`, not `BC`).

`ZB` is deferred to step 12 rather than joining `ZP` at step 11: two new top-level items entering
the same frame tie with each other too (not just with `P`), and a tie's harmlessness is a
footprint check over each member's whole subtree — `ZC`/`ZB`'s by-design overlap would have made
that tie `unsupported`. A step apart, `ZP` and `ZB`/`BP` each only tie with `P` (disjoint
footprints, harmless), and `ZC` — not top-level — never ties with `ZB` at all. Measured:
`draw-index-ties` reports 3 ties, all harmless (frame 11 `{P,T}`, frame 111 `{P,ZP}`, frame 121
`{P,ZB,BP}`); `tie-overlap` still finds only frame 11's not harmless.

**Sabotage step sets, extended.** The sabotages whose dropped state is never reset by a later step
now mismatch through steps 11 and 12 too (measured): `sabotage-omit-modulate` {1..12},
`sabotage-omit-transform` {2..12}, `sabotage-omit-visibility` {7..12}, `sabotage-omit-free`
{8..12}. `sabotage-omit-order` ({3}) and `sabotage-omit-visible` ({6}) are unchanged: both
re-converge with the reference before step 11.

**Patch sink**, the same 400-frame capture: full 3 252 541 B (max record 8 447), patch 175 125 B
(max record 7 623); median transaction 8 379 B full against 354 B patch. Resolved, the patch
recording equals the full one at all 400 frames.

**Live timeline, re-derived by running.** The fixture's default quit is now `S + 12N + 11`, so the
live hosts' `S + 11N` (960) would be refused; they quit at `S + 13N` = 1080, and the receivers
shoot 13 windows, step 12's being `[1027, 1080]`. Everything G1d measured lies before step 4 and
is unchanged in both runs:

| Measured (run 1 / run 2)                    | Value                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-stall`: stalled send → credit         | 367 → 488 / 367 → 489; steps 2 (420) and 3 (480) inside; coalesced 68 / 69 from frame 420; recovery patch 2 357 B, 0 frames after the credit              |
| `sabotage-stale-coalesce`: first post-stall | frame 489, frame 420's state (`stale_from`), step 3 shot 2 048 px off, in both runs; run 2 also caught an ordinary-gap stale copy at frame 361 (step 1's) |
| `sabotage-ignore-credit`                    | violations from frame 480 / 488 (sabotage frame 480); 49 / 33 sends without credit; up to 32 / 33 in flight                                               |
| `live-receiver-killed`                      | killed at host frame 601, closed 1006, the fixture quit at 1080, both sinks complete                                                                      |
| `live`                                      | 1 020 / 1 044 transactions, 13 shots equal to the reference; two more harmless one-frame ties (frames 960 and 1020)                                       |

The step-3-before-credit margin `stale-coalesce` depends on (step 3 at 480, credit at 488–489) is
untouched: steps 11 and 12 come after every G1d event.

**What this does not prove.** A new top-level item's tie with an existing one other than `P`, or
two new top-level items whose subtrees are disjoint but which overlap a third tied member — neither
is exercised.

## Gate 1 summary

Gate 1 passes as of 2026-10-09 with all four groups in one run (65 checks): G1a, G1b2, G1c2, G1d
and G1e, built on G1b1's codecs and G1c1's WebSocket server (G1e's calibrator 4 adds no check of
its own; it extends the fixture, the hook set and the sabotage step sets).

What gate 1 proves, on the pinned 4.5.1 release template under `--headless`:

- **Retained state (1a).** Parent/child transforms and modulation, transform changes without a
  redraw, draw order (index swap, z over index, reparent, same-parent re-append), visibility and
  layer culling, content replacement and clearing, create/free/recreate and detach/re-attach, and a
  canvas transform, and (1e) `z_as_relative_to_parent` and `draw_behind_parent`: thirteen steps,
  each pixel-exact against the rendered reference and an image painted from `expected.json`, each
  sabotage failing at exactly its predicted steps.
- **Root geometry (1a).** The headless host's degenerate 64×64 root is declared, never guessed;
  `GRC_ROOT_SIZE=enforce-min-size` makes it match the 640×360 logical size.
- **render-stream/1 (1b).** Patch transactions resolve bit for bit to the full snapshots of the
  same frames and cost the receiver the same RenderingServer calls; a corrupt patch is caught as
  `patch-divergence`. The one-frame draw-index tie of a top-level item added at runtime is
  declared on the wire and classified by its effect.
- **Live delivery (1c).** The capture library serves the stream from inside the game process over
  its own loopback WebSocket server, encoding on the main thread at the frame boundary, one
  transaction in flight, credit returned from the receiver's paced render loop; live pixels equal
  the reference and a file replay of the received bytes; a lost message is a sequence gap.
- **Slow receivers (1d).** Stall, coalescing to one pending target, newest-state recovery,
  resync, reconnect and receiver loss, as above.

Unsupported or deferred, by design: textures and every resource payload (gate 2), clipping
semantics (gate 3), `viewport_set_global_canvas_transform`, `canvas_set_modulate`, y-sort, light masks and texture
filter/repeat (in the session's `unobserved` list), equal-draw-index ties that can change pixels
(`draw-index-tie`, unsupported), a degenerate host size (`degenerate-host-size`, unsupported),
arm-on-first-subscriber and late join (gate 8), more than one receiver, publication-rate control
and real presentation timing (gate 6), non-loopback serving and authorization (gate 2).

Costs, measured on the gate 1 hosts (60 frames per second, the 21-item fixture before G1e, 26 since): one mirror
snapshot copy per frame, about 14 µs; a patch diff about 7 µs and its encoding about 2 µs; a
transaction is a few hundred bytes (about 350 KB for 900 frames), a full snapshot about 8 KB; the
credit round trip is 1–2 host frames for a rendered receiver (`submitted`) and about 1.5 ms for a
headless one (`applied`); the receiver applies a transaction in about 0.6 ms (median, G1c2). The
hook itself stays armed for the whole session (D6), a cost gate 1 does not measure.

## Gate 2a result (2026-10-09)

G2a ([protocol/gate2-design.md](protocol/gate2-design.md) "G2a") passes:
`pnpm render-stream:gate2 -- --legs g2a` is 15/15 in
`artifacts/render-stream/gate2/20261009T110836Z/` (an earlier run with the same build,
`20261009T105103Z`, matched every image and hash and taught the census one engine call, below).
The same build passed gate −1 28/28 with 55 hooks planned and none omitted
(`artifacts/render-stream/gate-minus1/20261009T104748Z/`, `armed.png == unarmed.png`), gate 0 19/19
(`artifacts/render-stream/gate0/20261009T105733Z/`) and gate 1 65/65 with all four groups
(`artifacts/render-stream/gate1/20261009T105916Z/`). Nothing changed on the render-stream/1 wire:
the capture leg classifies `unsupported`, and only because its texture draws are unsupported
commands.

What landed:

- **Calibrator 5**, eleven optional slots at exactly the contract's indices: placeholder create 34,
  `texture_replace` 40, the root default filter/repeat 321/322, canvas textures 441/442/444/445,
  item default filter/repeat 448/449, LCD text 470. `calibrate.sh --check` is clean. On /1 the new
  hooks are counted, captured into `counters.json` and logged; they make no mirror tap. The two
  texture-rect draws now capture every argument. The spike drives all eleven off-screen.
- **Copy and hash at the hook.** With a stream enabled, `texture_2d_create` and `_update` read the
  image's shape through the `Image` binds (`has_mipmaps` added), copy `image_ptr`'s bytes into a
  GRT1 payload and SHA-256 it on the calling thread before forwarding
  (`capture/src/rs_texture_payload.*`, `rs_sha256.*`; ctests on the FIPS vectors and on literal
  payload bytes for golden-2's four shapes). Formats outside `GRC_RESOURCE_FORMATS` and payloads
  over `GRC_RESOURCE_MAX_PAYLOAD_BYTES` are logged and not copied. G2a keeps no payload.
- **The hook log**, `evidence/resources.jsonl` (`capture/src/rs_resource_log.*`, ctest), with the
  wire ids and versions G2b2's mirror will assign.
- **The arm-time root texture defaults**, read through the two `Viewport` binds into `root.json`.
- **The gate 2 fixture and runner** (`fixtures/gate2/`, `scripts/run-gate2.sh`, `check-gate2.ts`,
  `lib/gate2-*.ts`, `test/self-test-gate2.ts`).

Images (all under the run directory): `reference/shots/step-{0..10}.png`,
`reference-repeat/shots/step-{0..10}.png` and `reference-armed/shots/step-{0..10}.png`. Every
reference shot equals `synthesizeGate2` exactly outside its `synth_exclude` regions (the linear,
mipmapped and semi-transparent ones: `s2` from step 3, all eight default-filter drawers at step 4,
`sb` from step 7, `mm` from step 9). The repeat is identical in every region of every step, so the
recorded budget is 0 everywhere. The armed reference is byte-identical to the unarmed one.

The measured census, per step window, identical in the headless capture and the rendered armed
reference and equal to `expected.json` (`<op>@other` is off the main thread):

| step | RenderingServer texture calls                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | `texture_2d_create` 5, `texture_2d_placeholder_create` 2, item default filter 11, item repeat 11 |
| 1    | none (flips, region, transpose are draw arguments)                                               |
| 2    | none (transform only)                                                                            |
| 3    | item default filter 1 (`S2`)                                                                     |
| 4    | `viewport_set_default_canvas_item_texture_filter` 1 (LINEAR, 2)                                  |
| 5    | `viewport_set_default_canvas_item_texture_filter` 1 (NEAREST, 1), item repeat 1 (`DR` MIRROR)    |
| 6    | `texture_2d_update` 1                                                                            |
| 7    | `texture_2d_create` 2, `texture_replace` 2                                                       |
| 8    | `texture_2d_create` 1, `texture_2d_create@other` 1, `free` 2                                     |
| 9    | `texture_2d_create` 1, `texture_replace` 1, item default filter 1 (`MM`)                         |
| 10   | none (transform only)                                                                            |

After the quit frame the scene teardown frees five textures (A, B, M, C, D); `P2` and the two raw
items are left to the engine's exit, as gate 1's raw items were. The `unsupported` variant adds
U1's create (logged `unsupported-format`, not copied) and two items' filter/repeat calls at step
0, and draws exactly one texture RID the log never saw created (`PRE`, made before arming); the
main capture draws none.

Copy and hash at the hook, headless capture, median ns (copy = header + `memcpy`, hash = SHA-256
of the whole payload):

| shape                | payload bytes | copy  | hash   |
| -------------------- | ------------- | ----- | ------ |
| LA8 4×4              | 137           | 140   | 1 120  |
| RGBA8 4×4            | 171           | 130   | 970    |
| RGBA8 16×16          | 1 135         | 1 160 | 5 330  |
| RGBA8 32×32          | 4 207         | 1 030 | 13 310 |
| RGBA8 800×6 (theme)  | 19 312        | 1 830 | 55 380 |
| RGBA8 64×64, mipmaps | 21 955        | 2 200 | 62 880 |

The rendered armed reference measures the same within noise. The portable SHA-256 runs at about
350 MB/s, so hashing, not copying, is the cost; lazy hashing stays a gate 6 measurement.

### Findings

- **The engine makes a texture of its own after arming.** The default theme gives ColorPicker an
  800×6 `GradientTexture2D` hue strip (`scene/theme/default_theme.cpp:1093-1097`) whose deferred
  `update_now` (`scene/resources/gradient_texture.cpp:220-225`) runs at the first MessageQueue
  flush, in frame 1, as a plain `texture_2d_create` (`:273-278`). It is the "800×6 format-5 image"
  gate −1 counted without explaining. Every armed run sees it, so `expected.json` declares it
  (`engine_textures`) and the census counts it.
- **Every texture prediction held on the first run.** The synthesized flips, the transposed
  region, `S3`'s 90° turn (transpose + flip in the shader's sampling), the flipped tile, mirror
  repeat, the LA8 alpha, the freed `P1` drawing white (D11), the placeholder becoming `E` through
  `texture_replace`, and `C` showing its pre-fill content all matched the reference exactly.
- **Copy at the hook is proven twice.** `C`'s hook hash equals the fixture's hash of the image
  before `fill(black)`, and the reference shows those colours. `D`'s create is the only line off
  the main thread, and its hash equals the worker's own.
- **Two independent encoders agree.** The C++ hook and the fixture's GDScript `payload.gd`
  produce the same SHA-256 for all twenty creates and updates across the capture and the armed
  reference; A0's and B's hashes also equal the ctest's Python-derived literals.

### Deviations from the contract

- Every sprite is `centered = false`: the layout table's regions put each sprite's top-left at its
  position. `DR`'s step-1 source is (4,0,8,8), not (8,0,8,8), which lies wholly in A0's green
  quadrant and would look the same with or without the transpose.
- The hook log appends five keys to Q3's (`target`, `ref_id`, `value`, `layer`,
  `root_viewport`): the census, `replace-retires-temp` and `viewport-defaults` need the argument
  an op names. A `texture_replace` line repeats its by-texture's payload fields. The census keys
  thread as `<op>@other`.
- `GRC_RESOURCE_MAX_PAYLOAD_BYTES` defaults to 64 MiB; the contract names no default.
- `reference-armed` runs with the default root-size policy (`observe`), so the only difference
  from `reference` is the armed extension and its stream; its window is 640×360, so it declares
  `match`.
- One check beyond the contract's list, `unsupported-variant`, judges the `capture-unsupported`
  support leg ("census of unknown RIDs"). `expected.json` is generated by
  `fixtures/gate2/make_expected.py`, which encodes the hand derivation and cites its sources.
- `gate0-checks.ts` `GATE0_HOOKS` grows to the 55 names the shared record plans, so gates 0 and 1
  keep requiring exactly the committed record's hooks.

### What G2a does not prove

- Anything a receiver does with textures: the wire is still render-stream/1 (G2b2).
- Payload retention, the store, HTTP delivery and pinning (G2b2, G2c1, G2c2), or the
  `CanvasTexture` hooks beyond their counts (G2d).
- That the texture capture covers formats other than the six 8-bit uncompressed ones, textures
  created before arming, or the target game's 1 526 textures (gate 8).

## Gate 2b result (2026-10-09)

G2b2 ([protocol/gate2-design.md](protocol/gate2-design.md) "G2b2" and its "As built") passes:
`pnpm render-stream:gate2 -- --legs g2a,g2b` is 47/47 in
`artifacts/render-stream/gate2/g2b2-final/` (an earlier run of the same tree, `g2b2-try1`, also
passed once the checker classified the patch receiver against the patch recording). The same build
passed gate −1 28/28 with 55 hooks and `armed.png == unarmed.png`
(`artifacts/render-stream/gate-minus1/g2b2-final/`), gate 0 19/19 on /2
(`artifacts/render-stream/gate0/g2b2-final/`) and gate 1 65/65, all four groups, on /2
(`artifacts/render-stream/gate1/g2b2-final/`). All under the ignored `artifacts/`.

What landed:

- **The capture speaks render-stream/2.** `rs_mirror` keeps the texture table (one id counter for
  images and placeholders, versions, `freed` tombstones that leave at the first snapshot nothing
  names them, `texture_replace` retiring the by-texture, the payload bytes the hook copied), the
  item and root-viewport filter/repeat, and the texture draws as commands (`unknown-texture` for a
  RID it never saw created, derived `unsupported-texture` entries). `rs_publish` (was
  `rs1_publish`) writes both sinks, the content-addressed store (`rs_resource_store`) and inline
  resource records per sink; `rs_live` (was `rs1_live`) serves /2 with every payload inline until
  G2c2. The /1 codecs left the library; `render-stream-1.ts`, `golden-1/` and `self-test-rs1.ts`
  stay as frozen history.
- **The receiver consumes /2**: `Rs2Decoder.Stream`, `RsResourceCache` (memory, a verified cache
  directory, the store as origin), lazy residency and the D5 upload rule in `RsApplier`, typed
  refusal of unsupported textures, `applied.json` `/3`.
- **Gates 0 and 1 run on /2** (`recording.rs2`, stores, caches, the /2 features), and gate 2 has
  group g2b (`lib/gate2b-checks.ts`).

Images (all under the run directory): the receivers' `receiver-{cold,warm,patch,inline}/shots/seq-<n>.png`
at the eleven settle seqs are byte-identical to `reference/shots/step-<k>.png`, full frame,
`synth_exclude` regions included; `receiver-cold`'s equal `synthesizeGate2` outside them. RAW1 is
white at step 8 (the freed `P1` tombstone), S3 shows C's pre-fill content. The unsupported variant's
receiver differs from `reference-unsupported/` in exactly `u1` and `u2` (1 024 px each) at every
step.

Bytes, 400-frame captures:

| recording                             | bytes     | median transaction | seq 1 | resource records |
| ------------------------------------- | --------- | ------------------ | ----- | ---------------- |
| `capture/recording.rs2` (full)        | 3 434 197 | 8 697              | 8 109 | 0                |
| `capture/recording-patch.rs2` (patch) | 211 669   | 461                | 8 109 | 0                |
| `capture-inline/recording.rs2` (full) | 3 486 461 | 8 697              | 8 109 | 10 (50 493 B)    |
| `capture-inline/recording-patch.rs2`  | 263 933   | 461                | 8 109 | 10 (50 493 B)    |
| `live-inline` tap (892 transactions)  | 490 726   | 461                | 8 110 | 10 (50 493 B)    |

The store holds 10 payloads, 50 493 B (A0, A1, A2, B0, B1, M, C, D, E and the engine's hue strip);
the retained maximum (the mirror's payloads plus the last publication's) is 49 050 B. The inline
records are byte-identical to the store files, and the inline capture resolves to the out-of-band
one at all 400 frames.

The receivers, per step (fetched / uploads), equal `expected.json` `receiver_resources`: step 0
2 fetched (A0 once for A and Atwin, B0), 5 created (A, Atwin, B, P1, P2); step 6 1 / 1 updated; step 7
2 / 2 replaced; step 8 2 / 2 created and 2 RIDs freed; step 9 2 / 1 created, 1 replaced; every
other step 0. `receiver-cold` fetched 9 distinct payloads (31 181 B) from the store, about 37 µs
per fetch (median, max 45 µs, verification included), and uploaded 10 times (31 220 data bytes);
its cache ends with exactly those 9 files. `receiver-warm`, a new process on that cache, fetched
0 with 9 cache hits, and its uploads, `rs_calls`, shots and state dumps are identical.
`receiver-patch` costs what `receiver-cold` does; `receiver-inline` and the live receiver take
every payload from the stream and fetch nothing. In the transform-only windows (steps 2 and 10:
frames 21–30 and 101–400) every receiver counter is 0, the hook log has no texture call and the
patch transactions carry no texture entry.

| leg                                                          | class (expected)          | why                                                                           |
| ------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `receiver-cold`, `-warm`, `-patch`, `-inline`, `live-inline` | success                   | as above                                                                      |
| `unsupported-textures`                                       | unsupported               | U1 `unsupported-format` (unsupported-texture), U2 `unknown-texture`           |
| `sabotage-omit-update`                                       | pixel-mismatch {6}        | A keeps A0 at step 6; step 7's replace re-converges                           |
| `sabotage-omit-replace`                                      | pixel-mismatch {7,8,9,10} | A keeps A1 at its old size; step 9's replace of P2 is dropped too             |
| `sabotage-stale-texture`                                     | capture-failure           | texture-log-divergence at seq 61: the stream keeps A v1, the hook log says v2 |
| `sabotage-wrong-hash`                                        | replay-failure            | resource-hash-mismatch at seq 61 (step 6), A1's store file corrupted          |
| `sabotage-spurious-update`                                   | resource-violation        | transform-only-resource-traffic at frame 21 (A v2, same hash; no re-upload)   |
| `sabotage-receiver-reupload`                                 | resource-violation        | redundant-upload (and traffic in the transform-only windows)                  |
| `sabotage-receiver-ignore-cache`                             | resource-violation        | warm-cache-fetch: a warm receiver fetched every hash its cache held           |

### Findings

- **G2b1's goldens carried the wrong `payload_bytes`.** The texture entry's `payload_bytes` is the
  whole `render-stream-texture/1` payload (1 135 B for RGBA8 16×16), the size the inline threshold
  and the store compare; golden-2 had the image data size (1 024 B), and both decoders compared
  the resource record's data length against it. golden-2 was regenerated and both decoders fixed.
- **omit-op needs the hook log's cooperation.** A texture call the capture misses must be missed by
  the log's registry too, or the stream and the log diverge and the sabotage lands as
  `capture-failure` instead of pixels. The omitted call is still logged, marked.
- **The texture mirror and the hook log assign ids independently**, so their identity taps share
  one hook-side lock; a worker-thread create (D) cannot interleave differently in the two.
- **Every gate 0 and gate 1 stream now carries one texture** (the engine's hue strip): stores of
  one payload, and every live connection sends one 19 312-byte resource record before seq 1. Gate
  1's queued-bytes bound now counts a credit window (a transaction and the records sent ahead of
  it) rather than one message.

### What G2b does not prove

- HTTP delivery, pins and retirement (G2c2), canvas textures and per-command filter/repeat (G2d),
  bearer tokens (G2e).
- Payload sizes beyond the fixture's (the largest is M's 21 955 B) or a store write failure and the
  retained budget in a real run (both are unit-tested only).
- Cache eviction, parallel fetches, lazy hashing (gate 6), browser receivers (gate 7), late join and
  the target game's textures (gate 8).

## Gate 2c result (2026-10-09)

G2c2 ([protocol/gate2-design.md](protocol/gate2-design.md) "G2c2" and its "As built") passes:
`pnpm render-stream:gate2` (groups g2a, g2b, g2c) is 72/72 in
`artifacts/render-stream/gate2/g2c2-final/`. The same build passed gate −1 28/28
(`artifacts/render-stream/gate-minus1/g2c2-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2c2-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2c2-final/`). All under the ignored `artifacts/`.

What landed:

- **The live host serves payloads by hash.** `ServedResources` (`capture/src/rs_resource_store.h`)
  is the rs_ws `ResourceSource`: at each frame callback the published snapshot's payloads are
  pinned before the hub sends, and after the sends the servable set is exactly the current state's
  payloads united with every open connection's base (the payloads of its last sent transaction);
  everything else is retired and its bytes released. Pins, retirements and every GET go to the
  hook log (`pin`, `retire`, `http-get`), the summary gains the serving totals, and the retained
  budget counts the servable set. Live connections follow the configured policy (`fetch: "http"`,
  inline capped at 1 MiB). Sabotages `unpin` and `drop-resource`; `wrong-hash` serves the store's
  corrupted copy.
- **The live receiver fetches before it applies.** `RsResourceFetcher` (one keep-alive
  `HTTPClient`, sequential GETs, a timeout, the delay as a timed wait) fills the cache; a
  transaction stays unapplied (acked `received`) until every payload it needs is verified and
  cached, while the previous state stays on screen.

Numbers (host `live-summary.json` and hook log; receiver `applied.json`):

| leg              | GETs | HTTP bytes | pinned / retired | retained max (hashes / bytes) | fetch latency p50 / p95                |
| ---------------- | ---- | ---------- | ---------------- | ----------------------------- | -------------------------------------- |
| `live`           | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-headless`  | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 19.4 / 20.9 ms                         |
| `live-stall`     | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-reconnect` | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.2 / 16.7 ms                         |
| `live-warm`      | 0    | 0          | 10 / 3           | 7 / 49 050                    | – (9 cache hits)                       |
| `live-animate`   | 15   | 33 365     | 905 / 897        | 10 / 49 778                   | 16.9 / 17.1 ms (100 ms delay excluded) |

Fetch latency is the same for 137 B and 21 955 B payloads (15.8–16.7 ms in `live`): a fetch costs
one receiver frame at `--max-fps 60`, since the fetcher is polled from `_process`; the loopback
transfer itself is not visible at this resolution. `pins-bounded` holds at all 911 frames of every
good host (the replayed servable set equals the full recording's ok hashes united with every open
connection's tapped base, peak 48 086 B after retirement; the summary's 49 050 B includes the
phase-1 pins of a callback before its retirements), against a 512 MiB budget.

`live-animate`: 911 ANIM updates, 661 ANIM versions reached the wire (in 661 transactions), six
distinct ANIM hashes (k = frame mod 6), 15 distinct hashes fetched (the six ANIM contents and the
nine fixture payloads, every one named by a sent transaction), 897 retirements: every superseded
ANIM version left the servable set at the next callback once no base named it.

| leg                        | class (expected) | why                                                                                                                  |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `live`                     | success          | 853 transactions, 9 fetches (one per payload), 11 shots equal to the reference                                       |
| `live-warm`                | success          | a new host and receiver on `live`'s cache: the host answers no GET, 9 cache hits, shots equal `live`'s               |
| `live-replay`              | success          | file replay of `live`'s `received.rs2` with `live`'s cache as its store: same seqs, payloads, shots and state dumps  |
| `live-headless`            | success          | 808 transactions, `applied` credit, under strace                                                                     |
| `live-stall`               | success          | stall after seq 559 (frame 607); seq 560 at frame 687 carries A1, fetched once; its step 6 shot equals the reference |
| `live-reconnect`           | success          | connection 2 starts full: 0 fetched, 3 cache hits, 5 uploads for 5 resident textures; then C and D fetched once each |
| `live-animate`             | success          | anim region equal to `synthesizeGate2` at each shot's frame, the rest equal to the reference                         |
| `sabotage-unpin`           | replay-failure   | `resource-unavailable` at seq 1: the third GET (ANIM, ~21 frames after the send) found its version retired, HTTP 404 |
| `sabotage-drop-resource`   | replay-failure   | `resource-unavailable` at seq 568, the first transaction naming A1, which the host answers 404                       |
| `sabotage-wrong-hash-live` | replay-failure   | `resource-hash-mismatch` at seq 571: the served A1 has its first data byte flipped                                   |

Images, all under the run directory: `live/receiver/shots/seq-<n>.png` (11 steps; equal to
`reference/shots/step-<k>.png`), `live-replay/shots/seq-<n>.png` for the same seqs,
`live-stall/receiver/shots/seq-560.png` (step 6, after the stall),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 8–10 on connection 2) and
`live-animate/receiver/shots/seq-<n>.png`.

### Findings

- **Pinning has to precede the send.** rs_ws's I/O thread transmits a transaction as soon as it
  is queued, so a receiver can GET a hash new at that frame before the callback ends; the host
  therefore pins everything it may send before the hub runs and retires after it.
- **The contract's 100 ms delay with a six-content ANIM.** A fresh receiver caches all six ANIM
  contents by host frame ~90, so `unpin` from S + N was unobservable (it retired 11 base-named
  hashes and the leg succeeded); the leg arms it from frame 1. The delay itself is safe: a fetch
  costs ~7 frames, so the GET lands three ANIM phases off the current content and is served only
  by the base pin.
- **A 2 s stall after step 5 skips step 6 entirely.** It would end at ~728, after step 7 replaced
  A, so A1 never reaches the wire; `live-stall` uses 1.3 s, ending inside step 6's window.
- **One HTTPClient state per frame cost 2–3 frames per fetch.** The fetcher now polls repeatedly
  within a frame while it makes progress (each poll non-blocking), bringing a fetch to one frame.

### What G2c does not prove

- Bearer tokens (G2e) and canvas textures (G2d); non-loopback serving (gate 8).
- Fetch costs below one frame, parallel fetches, large payloads (the largest is 21 955 B),
  constrained links and cache eviction (gate 6); browser receivers and their HTTP caches (gate 7).

## Gate 2d result (2026-10-09)

G2d ([protocol/gate2-design.md](protocol/gate2-design.md) "G2d" and its "As built") passes,
integrated onto `main` after G2c2 and G2e: `pnpm render-stream:gate2` with every group is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`. The same build passed gate −1 28/28 with 55 hooks
(`artifacts/render-stream/gate-minus1/g2d-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2d-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2d-final/`). The calibrator did not need a bump: the four slots
(441/442/444/445) were reserved by calibrator 5.

What landed:

- **`CanvasTexture` in the mirror and on the wire.** `rs_mirror` taps `canvas_texture_create`,
  `_set_channel` (diffuse, normal, specular), `_set_texture_filter` and `_set_texture_repeat`. A
  canvas texture with a normal or specular channel is `unsupported`/`canvas-texture-channel`. The
  texture table gets `kind: "canvas"` entries with `canvas: {diffuse, filter, repeat}`.
- **The receiver applies it.** `rs_applier.gd` creates the canvas texture on first sight and
  re-issues the channel, filter and repeat calls whenever the wire version advances.
- **A headless host refuses it, typed.** The dummy storage never allocates a canvas texture
  (`servers/rendering/dummy/storage/texture_storage.h:54` returns `RID()`; the same on 4.6.2 and
  4.7.2), so a headless host declares
  `features.unsupported_resources: [{"resource":"canvas_texture","reason":"canvas-texture-headless"}]`
  and makes a texture draw naming `RID()` an `unsupported` command `canvas-texture-headless`. It is
  never replayed as the white default. The hook log marks each `canvas_texture_*` call the same
  way. The options for real support are in
  [protocol/canvas-texture-headless.md](protocol/canvas-texture-headless.md).
- **The fixture's step 11.** `SC` draws `A`'s 64×64 region at 1.125× with nearest filtering and
  repeat enabled. The main fixture sets them on the item, so no headless leg meets a
  `CanvasTexture`. The `canvas` variant gets the same pixels from a `CanvasTexture` `CT` while the
  item says linear/disabled.

| leg                           | host     | class (expected)                        | why                                                                                                          |
| ----------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `canvas-headless`             | headless | unsupported (`canvas-texture-headless`) | 4 refused `canvas_texture_*` calls, no canvas entry; SC's draw refused from step 11, the receiver reports it |
| `canvas-host`                 | rendered | success                                 | CT on the wire (canvas, diffuse A, nearest/enabled, version 4); the receiver equals the reference            |
| `canvas-normal`               | rendered | unsupported (`unsupported-texture`)     | `CT.normal_texture = B`: canvas-texture-channel; region `sc` only, only step 11 (5 184 px)                   |
| `sabotage-omit-canvas-filter` | rendered | pixel-mismatch {11}                     | `omit-op canvas_texture_set_texture_filter` at step 11's frame; 1 088 px differ (nearest vs linear)          |

The three rendered legs are host-renderer evidence for the capture and replay path, not headless
support. `canvas-texture-override` holds on `canvas-host`'s own step-11 frame: region `sc` equals
`synthesizeGate2`'s nearest/enabled exactly (0 px differ), although SC's item says linear/disabled.

### Findings

- **A headless host cannot create a `CanvasTexture`** (above). Only the refusal makes that loud.
  Before it, the draw replayed as `tex: null`, which is white.
- **The hook log did not recompute status on a channel-set call.** `rs_resource_log.cpp`'s
  `canvas_texture_set_channel` left `canvas/ok` after the mirror flipped to `unsupported`.
  `canvas-normal` caught it as `texture-log-divergence`. Fixed.
- **Nearest vs linear only shows under magnification here.** At 1:1 and at 0.75× no pixel differed
  on flat-colour content. `SC` draws at 1.125×.
- **Gate 2's TS checker listed only the landed groups g2a-g2c** while the runner listed g2e too.
  Both now list g2a-g2e, g2d's legs are judged only when g2d ran, and the self-test fabricates g2e
  evidence (`gate2c-fixture.ts` `buildG2eTree`).

### What G2d does not prove

- `CanvasTexture` capture on a headless host (refused; see the options study).
- `canvas_texture_set_shading_parameters`, `texture_set_size_override`, and proxy, layered, 3D,
  external and viewport textures.
- Textured polygons, meshes and nine-patch (gate 5), lazy hashing and cache eviction (gate 6),
  browser receivers (gate 7), late join and the target game's textures (gate 8).

## Gate 2e result (2026-10-09)

G2e ([protocol/gate2-design.md](protocol/gate2-design.md) "G2e") passes: `pnpm render-stream:gate2
-- --legs g2a,g2b,g2c,g2e` is 77/77 in `artifacts/render-stream/gate2/g2e-run1/`. The same build
passed gate −1 28/28, gate 0 19/19 and gate 1 65/65 (all four groups), and `pnpm test` (2490
passed), `pnpm exec tsc --noEmit` on `experiments/render-stream`, and every pure self-test
(`self-test-rs0/1/2.ts`, `self-test-gate0.ts` 205/205, `self-test-gate1.ts` 402/402,
`self-test-gate2.ts` 354/354, `make_golden.py --check` on `golden/`, `golden-1/` and `golden-2/`).
All under the ignored `artifacts/`.

What landed:

- **`rs_ws` checks a bearer token on both routes.** `ServerConfig::auth_token` (empty disables the
  check, exactly as before G2e) gates the WebSocket upgrade and every resource GET.
  `constant_time_equals` (exposed in `rs_ws.h` for its own ctest) compares the presented token
  against the configured one in time that depends only on the longer string's length, never on
  where they first differ; the "Bearer " prefix check itself is allowed to short-circuit, since it
  names no secret. A missing or wrong token is `401`, never a close code: the upgrade's `reject()`
  closes the TCP connection after flushing the response (the same path every other rejected
  handshake already took); a GET's `401` honours `Connection: keep-alive` like its `404`, since an
  unauthorized request is not a broken connection.
- **The host generates and evidences the token without ever logging it.** `GRC_LIVE_AUTH=token`
  (default `none`) makes `entry.cpp` generate 32 random bytes as 64 lowercase hex
  (`getrandom()`, independent of `rs2::generate_id()`'s 16-byte session/stream ids), write them to
  `evidence/live-token` (mode 0600) before the listener starts, and declare the session's
  `resources.auth: "bearer"` (the wire field G2b1 had already reserved). A rejected upgrade is a
  new `rs_ws` event, `AuthRejected` — the connection never reaches `Opened`, so the hub has nothing
  to track; `entry.cpp`'s `live_drain()` logs it directly to `stdout.log` as `live: 401
unauthorized upgrade`, never to the structured hook log, since it carries no hash. A rejected GET
  stays on the existing `HttpGet`/`http-get` path with `http_status: 401`.
- **The receiver sends the token on both routes, or a deliberately wrong one.**
  `RS_RECEIVER_TOKEN_FILE` is read once at startup; `RsLiveClient.open()` sets
  `WebSocketPeer.handshake_headers` to `Authorization: Bearer <token>` before every
  `connect_to_url()` call, including reconnects; `RsResourceFetcher` sends the same header on every
  `HTTPClient.request()`. The new sabotage `RS_RECEIVER_SABOTAGE=wrong-http-token` corrupts only the
  fetcher's copy (appends `-wrong`) after the WebSocket has already opened with the correct one, so
  "correct on the upgrade, wrong on every GET" holds exactly as the contract asks.

Legs (group `g2e`), each a fresh live host (`GRC_LIVE_AUTH=token`, the live timeline, S = 300,
N = 60, quit 911) plus one receiver:

| leg                       | class (expected) | why                                                                                                                                       |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `live-auth`               | success          | as `live` (README "Gate 2c result") with tokens: 852 transactions, 9 fetches (31 181 B), 10 uploads (31 220 B), host 9 GETs / 0 errors    |
| `sabotage-no-token`       | replay-failure   | `live-connect-failed` at the very first connect: `WebSocketPeer` never reaches `STATE_OPEN` (state 3, close code −1) after the host's 401 |
| `sabotage-bad-http-token` | replay-failure   | `resource-unavailable` at seq 1: the first resource GET (needed by the initial transaction) answers HTTP 401                              |

`sabotage-no-token`'s host log shows exactly one `live: 401 unauthorized upgrade` line and zero
`http-get` 401s; `sabotage-bad-http-token`'s hook log shows exactly one `http-get` line with
`http_status: 401` and zero upgrade rejections; `live-auth` shows neither. `token-not-logged`
greps every file under each leg's directory (recordings, hook log, `stdout.log`, `applied.json`,
shots) for that leg's own 64-character token and finds it nowhere but `evidence/live-token` — this
was re-verified independently outside the checker (a raw-byte grep of the whole run directory,
each leg's token excluded only from its own `evidence/live-token` file) with zero hits.

### Findings

- **Bearer-auth evidence needed a channel `rs_ws` didn't have.** Every existing rejected-handshake
  path (wrong subprotocol, `max_clients`, a malformed request) produces no `Event` at all, which
  is fine when nothing downstream needs to know why. Proving the _host_ actually answered 401 (not
  just that the receiver failed to connect, which Godot's `WebSocketPeer` reports identically for
  any handshake failure — `get_close_code()` stays unset) needed a dedicated event
  (`AuthRejected`), following the exact precedent `HttpGet` set at G2c1/G2c2 for the same kind of
  "the switch must stay exhaustive under `-Wswitch`" extension.
- **Only the secret itself needs the constant-time property.** The "Bearer " prefix is a public
  RFC 6750 constant; letting `std::string::compare` short-circuit on it leaks nothing a timing
  attack could use, so `bearer_ok()` only pays for `constant_time_equals` over the token that
  follows the prefix (or an empty string, when the header is missing or malformed).
- **Node's WebSocket global cannot drive this test.** The WHATWG `WebSocket` constructor has no
  header parameter (the same restriction browsers have), so `self-test-rs-ws.ts`'s bearer-auth
  checks use `node:http`'s raw upgrade request directly: a 101 response arrives as an `upgrade`
  event, anything else (401 included) as an ordinary `response` event. The Godot interop tests hit
  the same wall from the other side — `WebSocketPeer` exposes no HTTP status for a failed
  handshake — so `ws_selftest.gd`'s auth phase can only assert "never reaches `STATE_OPEN`"; the
  host-side evidence above is what actually proves the status was 401.

### What G2e does not prove

- Non-loopback serving (gate 8, D13) and token transport without headers for a browser receiver
  (gate 7, deferred by D13 too).
- Token rotation while a connection is open, multiple valid tokens, or any authorization scheme
  beyond one static bearer token per host process.
- Canvas textures (G2d, landing in parallel); gate 2's full summary waits for it.

## Gate 2 summary

Gate 2 passes: `pnpm render-stream:gate2` with all groups g2a-g2e is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`, on the same build as gate −1 28/28, gate 0 19/19 and
gate 1 65/65 (`artifacts/render-stream/{gate-minus1,gate0,gate1}/g2d-final/`). Every leg is at its
expected class. Images are under each leg's `shots/` in the run directory, and the references are
`reference/shots/step-{0..11}.png`.

What it proves, by increment:

- **2a.** The stock release template's texture calls can be hooked (calibrator 5, 55 hooks). Image
  bytes are copied and hashed at the hook, on the calling thread (loader threads included), and
  agree with an independent derivation of the fixture's twelve steps.
- **2b.** render-stream/2 carries textures as a versioned table with content-addressed payloads,
  out of band (store) or inline. A receiver uploads a texture only when a command first needs it
  and re-uploads only on a hash change. Transform-only steps cost zero texture traffic, and a warm
  cache fetches nothing.
- **2c.** Live hosts serve payloads over HTTP by hash on the WebSocket's listener. Pins cover every
  fetch a correct receiver can make, and everything else is retired. Stall, reconnect, warm, replay
  and animate legs all draw the reference's pixels.
- **2d.** `CanvasTexture` per-command filter and repeat override the item's, on the wire and in
  pixels, on a host with a real renderer.
- **2e.** A bearer token gates the upgrade and every GET, compared in constant time, and is never
  logged.

Unsupported, each typed and never substituted: formats outside the permitted six
(`unsupported-format`), oversized payloads (`payload-too-large`), textures created before arming or
never hooked, such as proxy, layered, 3D and viewport textures (`unknown-texture`), canvas
textures with a normal or specular channel (`canvas-texture-channel`), and, as an **architectural
finding**, every `CanvasTexture` on a headless host (`canvas-texture-headless`). The dummy renderer
that `--headless` forces allocates no canvas texture on 4.5.1, 4.6.2 or 4.7.2, so no pass-through
tap can see one. The options (a synthesized-identity shim, a software-GL host, a host-renderer
opt-in) and the recommended next experiment are in
[protocol/canvas-texture-headless.md](protocol/canvas-texture-headless.md).

Costs measured in this run:

- **Copy and hash at the hook** (`capture`, 11 payloads): copy median 0.97 µs (max 2.7 µs for the
  800×6 hue strip). SHA-256 median 4.5 µs; 16 µs for 4 KiB, max 95 µs.
- **Bytes** (README "Gate 2b result"): median transaction 8 697 B full, 461 B patch. The store
  holds 10 payloads (50 493 B).
- **Fetches and uploads.** A cold receiver fetches 9 payloads (31 181 B) and uploads 10 times
  (31 220 B). A warm one fetches 0. Live fetch latency is p50 16.2 ms and p95 16.7 ms whatever the
  size (137 B to 21 955 B): one receiver frame at 60 fps. The retained maximum is 7 hashes
  (49 050 B).

What gate 2 does not prove: glyph atlases and MSDF text (gate 4); textured polygons, meshes and
nine-patch (gate 5); lazy hashing, spill-to-disk, cache eviction and parallel fetches (gate 6);
browser receivers and their HTTP caches (gate 7); non-loopback serving, late join, and the target
game's own textures (gate 8); `CanvasTexture` on a headless host (above).

## Gate 3a result (2026-10-09)

G3a ([protocol/gate3-design.md](protocol/gate3-design.md) "G3a") passes:
`pnpm render-stream:gate3 -- --legs g3a` is 16/16 in
`artifacts/render-stream/gate3/20261009T220745Z/`. An earlier run on the same code,
`20261009T213400Z`, was also 16/16. The same build passed gate −1 28/28 with 55 hooks planned and
none omitted (`artifacts/render-stream/gate-minus1/20261009T214037Z/`), gate 0 19/19
(`gate0/20261009T214155Z/`), gate 1 65/65 with all four groups (`gate1/20261009T214425Z/`) and
gate 2 85/85 with all five groups (`gate2/20261009T215439Z/`). The wire is unchanged
(render-stream/2), and the capture leg classifies `success`.

What landed:

- **The mirror clear fix (D3).** `Mirror::clear` now sets `clip = false`, as the engine's
  `Item::clear()` does, and keeps `custom_rect`. Three new `rs_mirror_test` cases cover it: clear
  resets, re-asserting in the same frame carries no clip change on the patch wire, and an omitted
  `set_clip` followed by a clear leaves the clip false. Gates 0–2 never set a clip true, so their
  captured state is unchanged.
- **The axis-aligned fixture** (`fixtures/gate3/`) and `make_expected.py`, which models Q1c from
  the source over the fixture's parameters and asserts Q6b's hand table.
- **`scripts/lib/clip-derive.ts`**, the wire-side scissor derivation (gate 7's reference), and the
  runner, checker and self-test (`run-gate3.sh`, `check-gate3.ts`, `lib/gate3-*.ts`,
  `test/self-test-gate3.ts`, 110 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`,
`reference-repeat/shots/step-{0..9}.png` and `reference-armed/shots/step-{0..9}.png`. Every
reference shot equals `synthesizeGate3` exactly, full frame and every region. The repeat and the
armed reference are byte-identical to the reference, so the budget is 0. All **1 314 probes**
across the ten steps (591 decisive pairs) have exactly their expected colour. `clip-derive.ts`
over both sinks' settle transactions reproduces every owner's scissor, Q6b's table:

| step | `A`                | `B`                 | `C`                 | `D`                | `RC`               | `AN`               |
| ---- | ------------------ | ------------------- | ------------------- | ------------------ | ------------------ | ------------------ |
| 0, 1 | `[96,88,256,208)`  | `[196,148,256,208)` | `[236,188,256,208)` | `[344,88,408,136)` | `[464,88,528,136)` | `[88,320,616,344)` |
| 2    | same               | `[176,138,256,208)` | `[216,178,256,208)` | same               | same               | same               |
| 3    | same               | `[176,138,236,188)` | `[216,178,236,188)` | same               | same               | same               |
| 4    | —                  | same as 3           | same as 3           | same               | same               | same               |
| 5    | `[96,88,256,208)`  | same as 3           | same as 3           | same               | same               | same               |
| 6    | same               | same                | same                | same               | —                  | same               |
| 7    | same               | same                | same                | same               | `[472,96,488,112)` | same               |
| 8    | same               | same                | same                | same               | skipped            | same               |
| 9    | `[104,92,264,212)` | `[184,142,244,192)` | `[224,182,244,192)` | `[352,92,416,140)` | skipped            | `[96,324,624,348)` |

The census at the hook (`counters.json`, whole run) equals `expected.json`:
`canvas_item_set_clip` 11 true and 11 false (17 distinct entries), `canvas_item_set_custom_rect`
20 enabled and 1 disabled (18 distinct), and `canvas_item_clear` 32, with nothing dropped. Every
Control redraw re-sent clear, custom rect and clip, and no engine redraw was unaccounted for.

### Findings

- **Every hand prediction held on the first run.** These include the nested and slid scissors, the
  clip that a redraw re-asserts after its clear, the toggle, the step-6 clear that resets `RC`'s
  clip (`RCF` drawn whole), the clip without a custom rect that falls back to the command bounds,
  the zero-area skip, the custom rect that culls `CU` at steps 0–1 and draws it once its rect only
  touches the viewport edge, and the canvas shift.
- **No draw-index ties** occur in any of the capture's 400 frames, so `no-draw-index-ties` has
  nothing to list.
- **The ignore-clip prediction is wider than the contract said.** Unclipped, `BF`, `BZ` and `CF`
  also cover 34 _inside_ probes near `A`'s and `B`'s right and bottom edges. The model's
  `predictions` carry the exact set, and the contract's G3b row now points at them (As built,
  G3a). The other predicted step sets match Q7: freeze {2..9}, perturb {1..9}, omit-clip {3..9},
  omit-custom-rect {7,8,9}, clip-before-clear {3..9}, and root-size-observe mismatching only
  region `anchored`.

### What G3a does not prove

- That a receiver reproduces any of this. The receiver still applies `clip` before its clear
  (G3b). That gap is also why G3a has no receiver legs.
- Rotated or scaled clip owners (G3c), `clip_ignore` (G3d), text clipping (gate 4), or clipping
  under stretch (gates 6 and 7).

## Gate 4a result (2026-10-09)

G4a ([protocol/gate4-design.md](protocol/gate4-design.md) "G4a") passes:
`pnpm render-stream:gate4 -- --legs g4a` is 21/21 in
`artifacts/render-stream/gate4/20261009T231107Z/`. The first run on the same build,
`20261009T230526Z`, was 20/21: only `oracle-agrees` failed, on colour floats printed at 15
digits. The same build passed gate −1 28/28 with 55 hooks (`gate-minus1/20261009T230733Z/`),
gate 0 19/19 (`gate0/20261009T230858Z/`), gate 1 65/65 with all four groups
(`gate1/20261009T231230Z/`), gate 2 85/85 with all five groups (`gate2/20261009T232533Z/`) and
gate 3 `--legs g3a` 16/16
(`gate3/20261009T234532Z/`). Nothing on the capture side or the wire changed: grayscale text is
render-stream/2 as it stands, and the capture leg classifies `success`.

What landed: the Latin grayscale fixture (`fixtures/gate4/`). Its font is provisioned from
`fonts.lock.json` by `scripts/lib/provision-fonts.sh`, so no second copy of a binary is
committed. Also landed: the reference-side glyph oracle (`glyph_oracle.gd`), `make_expected.py`
(the census derived from the strings by Q1c), and the runner, checker and self-test
(`run-gate4.sh`, `check-gate4.ts`, `lib/gate4-*.ts`, `test/self-test-gate4.ts`, 66 assertions).

Images (under the run directory): `reference/shots/step-{0..9}.png`, `early-{1,4,7}.png` (one
frame after each upload step), and the same under `reference-repeat/` and `reference-armed/`.
Outside the text regions every shot equals `synthesizeGate4` exactly. Every text region has ink
exactly when its Label is visible with text, and it changes exactly when expected. The repeat and
the armed reference are byte-identical to the reference, so the **budget is 0** in every region.
Each early shot already equals its settle shot.

Census as measured (hook log, frame of each call; it equals the prediction of gate4-design.md Q6b
in every cell):

| step | frame | F@16 (wire id 2)        | F@24 (3) | DF@16 (4) | other                          | glyph commands |
| ---- | ----- | ----------------------- | -------- | --------- | ------------------------------ | -------------- |
| 0    | 1     | create v1 (H e l o)     | create   | create    | the engine's 800×6 RGBA8 strip | 31             |
| 1    | 11    | update v2 (Q u a r t z) | —        | —         |                                | 37             |
| 2, 3 | —     | —                       | —        | —         | no texture call at all         | 37, 37         |
| 4    | 41    | update v3 (W y v n)     | —        | —         |                                | 43             |
| 5, 6 | —     | —                       | —        | —         | no texture call at all         | 32, 43         |
| 7    | 71    | update v4 **and** v5    | —        | —         | wire publishes v5 only         | 37             |
| 8    | —     | —                       | —        | —         | no texture call at all         | 37             |
| 9    | 91    | —                       | —        | update v2 |                                | 38             |

Each upload is a whole 256² LA8 page: 131 072 data bytes, 131 185 payload bytes. That is 412 867
B published at step 0 (three pages and the hue strip) and 131 185 B at each of steps 1, 4, 7 and 9.
At the hook a page copy costs 10–100 µs and its SHA-256 about 0.4 ms. Teardown frees the runtime
font's two pages at frame 401; the default theme font's page outlives the run.

Atlas parity: at every settle step each page the rendered reference dumps
(`font_get_texture_image` as a GRT1 payload) has the hash of exactly one wire texture:

| steps | F@16              | F@24                | DF@16               |
| ----- | ----------------- | ------------------- | ------------------- |
| 0     | v1 `607c200f69…`  | v1 `366798e78b…`    | v1 `e9fd3088be…`    |
| 1–3   | v2 `ab83b838df…`  | same                | same                |
| 4–6   | v3 `4deb468ed7…`  | same                | same                |
| 7, 8  | v5 `b446a2d32c…`  | same                | same                |
| 9     | same              | same                | v2 `8477ff7922…`    |

Headless rasterization is therefore byte-identical to the rendered reference's. All 372 glyph
commands (both sinks) equal the oracle's quads and source rects as float32 exactly, with the font
colour as modulate. The four consecutive version pairs wrote 1 105 texels, all onto empty `(255,0)`
texels.

### Findings

- **Every census prediction held on the first run.** These include the step 7 double upload, the
  hidden Label that rasterizes nothing until shown, zero texture traffic on the transform-only,
  hidden-text, emptied, reordered and recoloured steps, and the default theme font's own page.
- **The oracle needs the engine's own paragraph.** A Label shapes `text + U+200B`. An oracle that
  shapes the bare text would differ for any font that kerns or ligates against it.
- **Amendments** (gate4-design.md G4a "As built"): the capture quits at 400 as in gates 0–3, the
  early shots are `early-<k>.png`, the oracle prints floats at full precision, and glyph sets are
  compared by glyph index.

### What G4a does not prove

- That a receiver draws any of this: that is G4b, which replays the recording with the unchanged
  receiver.
- Subpixel variants, outlines, shadows, wrapping, alignment, `clip_text`, multiple pages, cache
  lifetime (G4c), RichTextLabel (G4d), MSDF (G4e), or complex scripts and fallback (G4f).

## Scratch verification (2026-10-08)

A throwaway project under the ignored `artifacts/render-stream/scratch/` —
autoload loading the extension, a `ColorRect`, a `Label`, and a `_draw()` making
one `canvas_item_add_rect` and one `canvas_item_add_polygon` call with bit-exact
values — run as
`linux_release.x86_64 --headless --path <proj>` for eight frames:

```
GRC_MODE=arm      armed,    vptr_written=true,  disarmed=true, exit 0
  frames_total 8, frames_armed 8, intercepted 33
  canvas_item_add_rect 3, canvas_item_add_texture_rect_region 12,
  canvas_item_add_polygon 2, texture_2d_create 2, texture_2d_update 7, free 7
  display_server "headless", rendering_driver "opengl3",
  rendering_method "gl_compatibility"
GRC_MODE=validate validated, vptr_written=false, all counters 0
GRC_MODE unset    validated (default), vptr_written=false
GRC_CALIBRATION="" refused no-calibration,        vptr_written=false
nonexistent path   refused no-calibration,        vptr_written=false
record, sha256 zeroed            refused fingerprint-mismatch, vptr_written=false
record, every index +1           refused slot-mask-mismatch,   vptr_written=false
GRC_DISARM_AFTER_FRAMES=2        disarmed at frame 2, frames_armed 2, restored
```

Captured values, bit-exact and by value:

- From the scripted `_draw()`: `rect [213.25, 27.5, 101.125, 49.75]`
  (`0x43554000 0x41dc0000 0x42ca4000 0x42470000`), `color [0.125, 0.5, 0.75, 1]`;
  polygon points `[[10.5, 20.25], [140.75, 20.25], [75.125, 96.5]]` with three
  colours and `uvs_count 0`.
- From the native `ColorRect` (no script involved): `rect [0, 0, 160, 80]`,
  `color [0.25, 0.5, 0.125, 1]` — the scene's `Color(0.25, 0.5, 0.125, 1)`.
- From the `Label`: twelve `canvas_item_add_texture_rect_region` calls (the glyph
  path) plus a 256×256 format-1 glyph atlas created once and updated seven times,
  with sizes read off the `Image` through `Image.get_width`/`get_height`/
  `get_format`/`get_data_size` method binds.

The `+1`-shifted record is caught by the anchor mask (11/17 anchors matched),
not by the hooked slots — a neighbouring slot is pure-virtual too, which is
exactly why the 17 implemented anchors are part of the check and why the
calibrator insists the matching prefix be unique.

### Negative finding worth keeping

Godot's `Vector<T>` is **two words, not one**: it leads with an empty
`VectorWriteProxy<T> write` member (`core/templates/vector.h`), so the CowData
element pointer sits at offset 8. Decoding it as one word read the wrong word out
of every `Vector` argument and segfaulted on the first `canvas_item_add_polygon`
with a default-constructed `uvs`. `capture/test/abi_decode.cpp` now pins both the
offset and `sizeof`. The shape of a wrong-ABI failure is worth remembering: the
hooks still forwarded correctly (the engine never noticed), only the _recording_
was wrong — a silent-corruption class that only bit-exact expected values catch.
