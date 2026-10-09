# render-stream experiment — gates −1, 0 and 1: capture seam, first stream, retained state, live delivery

Gate 0 passed on 2026-10-09 (see "Gate 0 result" below): one opaque rectangle and a step marker,
captured by the stock release template under `--headless`, replayed by a separate receiver
project, pixel-exact against an independent reference. Its contract is
[protocol/gate0-design.md](protocol/gate0-design.md), and its wire format is
[protocol/render-stream-0.md](protocol/render-stream-0.md).

Gate 1's first increment, G1a, passed on the same day (see "Gate 1a result" below). Its fixture
has eleven retained-state steps. The capture host gets the logical root size it needs
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

Gate −1 of [docs/handoff-headless-render-stream.md](../../docs/handoff-headless-render-stream.md).
It answers one question before any protocol work starts:

> Can a GDExtension observe every `RenderingServer` drawing and texture call made
> by an **unmodified official** Godot release template running `--headless`,
> without patching code, without a custom engine build, and without any way to
> damage a shipped game?

**Answer: yes, measured.** A GDExtension copies the `RenderingServer` singleton's
vtable into the heap, replaces up to 42 slots with pass-through recording hooks
(the eight gate −1 hooks, 23 draw-path hooks added for gate −0.25, and 11 canvas
and viewport state hooks added for gate 0), and publishes the copy with one
aligned pointer store into the singleton object's first word. Native `Control` drawing, the `Label` glyph path and direct
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
set and is required; tiers 2 and 3 are optional (see "Calibration records and hook
versions" below). Tier 3 is gate 0's: the state the retained canvas mirror
(`capture/src/rs0_mirror.h`) needs, beside the tier 1 and 2 hooks it also taps.
"Captured" is what the hook records beside its count. Every signature is copied
from the 4.5.1 header, with the line cited in `capture/src/hooks.cpp`.

| Method                                        | Slot | Tier | Captured                                                                                        |
| --------------------------------------------- | ---- | ---- | ----------------------------------------------------------------------------------------------- |
| `texture_2d_create`                           | 24   | 1    | returned RID, image size/format/bytes, frame                                                    |
| `texture_2d_update`                           | 30   | 1    | RID, layer, image size/format/bytes, frame                                                      |
| `shader_create_from_code`                     | 54   | 2    | returned RID (code and path `String`s not decoded)                                              |
| `shader_set_code`                             | 55   | 2    | shader RID (code `String` not decoded)                                                          |
| `material_set_param`                          | 66   | 2    | material RID (`StringName` and `Variant` not decoded)                                           |
| `mesh_create`                                 | 71   | 2    | returned RID                                                                                    |
| `mesh_add_surface`                            | 82   | 2    | mesh, and from `SurfaceData`: primitive, format, vertex/index counts, four buffer sizes, `aabb` |
| `mesh_surface_update_vertex_region`           | 86   | 2    | mesh, surface, byte offset, byte count, first 64 bytes                                          |
| `mesh_surface_update_attribute_region`        | 87   | 2    | as above                                                                                        |
| `mesh_set_custom_aabb`                        | 94   | 2    | mesh, AABB                                                                                      |
| `mesh_clear`                                  | 100  | 2    | mesh                                                                                            |
| `viewport_attach_canvas`                      | 313  | 3    | viewport, canvas                                                                                |
| `viewport_set_canvas_transform`               | 315  | 3    | viewport, canvas, transform                                                                     |
| `canvas_create`                               | 435  | 3    | returned RID                                                                                    |
| `canvas_item_create`                          | 446  | 2    | returned RID                                                                                    |
| `canvas_item_set_parent`                      | 447  | 3    | item, parent                                                                                    |
| `canvas_item_set_visible`                     | 450  | 3    | item, visible                                                                                   |
| `canvas_item_set_transform`                   | 453  | 2    | item, transform                                                                                 |
| `canvas_item_set_clip`                        | 454  | 3    | item, clip                                                                                      |
| `canvas_item_set_custom_rect`                 | 456  | 3    | item, enabled, rect                                                                             |
| `canvas_item_set_modulate`                    | 457  | 2    | item, colour                                                                                    |
| `canvas_item_set_self_modulate`               | 458  | 3    | item, colour                                                                                    |
| `canvas_item_set_visibility_layer`            | 459  | 3    | item, layer                                                                                     |
| `canvas_item_add_line`                        | 462  | 2    | item, from, to, colour, width, antialiased                                                      |
| `canvas_item_add_polyline`                    | 463  | 2    | item, points, colours, width, antialiased                                                       |
| `canvas_item_add_rect`                        | 465  | 1    | item, rect, colour, antialiased                                                                 |
| `canvas_item_add_circle`                      | 466  | 2    | item, position, radius, colour, antialiased                                                     |
| `canvas_item_add_texture_rect`                | 467  | 1    | count only                                                                                      |
| `canvas_item_add_texture_rect_region`         | 468  | 1    | count only                                                                                      |
| `canvas_item_add_msdf_texture_rect_region`    | 469  | 1    | count only                                                                                      |
| `canvas_item_add_nine_patch`                  | 471  | 2    | every argument                                                                                  |
| `canvas_item_add_primitive`                   | 472  | 2    | item, points, colours, UVs, texture                                                             |
| `canvas_item_add_polygon`                     | 473  | 1    | item, points, colours, UV count, texture                                                        |
| `canvas_item_add_triangle_array`              | 474  | 2    | item, indices, points, colours, UVs, bone/weight counts, texture, count                         |
| `canvas_item_add_mesh`                        | 475  | 2    | item, mesh (passed by reference), transform, modulate, texture                                  |
| `canvas_item_add_multimesh`                   | 476  | 2    | item, multimesh, texture                                                                        |
| `canvas_item_add_set_transform`               | 478  | 2    | item, transform                                                                                 |
| `canvas_item_set_z_index`                     | 482  | 3    | item, z index                                                                                   |
| `canvas_item_clear`                           | 486  | 2    | item                                                                                            |
| `canvas_item_set_draw_index`                  | 487  | 3    | item, draw index                                                                                |
| `canvas_item_set_material`                    | 488  | 2    | item, material                                                                                  |
| `free`                                        | 549  | 1    | freed RID (deduplicated log, as tier 2)                                                         |
| `get_default_clear_color` (probe, not hooked) | 577  | 1    | —                                                                                               |

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
    `8 of 42 hooks named by the record; omitted (record predates them): …`.
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
experiments/render-stream/scripts/build-capture.sh          # + rs_mirror, rs1_publish ctests
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
passed. Since G1b2 it runs on render-stream/1 with every capture under
`GRC_ROOT_SIZE=enforce-min-size`. Self-tests: `scripts/test/self-test-rs1.ts` (TS decoder against
the /1 golden vectors), `scripts/test/self-test-gate0.ts` (checker and classifier on synthetic
evidence) and `python3 experiments/render-stream/protocol/golden-1/make_golden.py --check`; the
frozen /0 history stays checked by `scripts/test/self-test-rs0.ts` and
`protocol/golden/make_golden.py --check`.

### Run gate 1

```bash
experiments/render-stream/scripts/build-capture.sh
mise exec -- pnpm render-stream:gate1 -- \
  --extension "$PWD/experiments/render-stream/capture/build/render_stream_capture.gdextension" \
  --calibration "$PWD/experiments/render-stream/calibration/godot-4.5.1-stable-linux-release.json" \
  [--legs g1a,g1b,g1c,g1d]
```

This takes about eight minutes and runs the landed groups, `g1a`, `g1b`, `g1c` and `g1d`. It imports
`fixtures/gate1/` and `receiver/`, then runs the receiver's typed self-test and the headless
captures, each writing both sinks (`recording.rs1` full, `recording-patch.rs1` patch): the
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

## Runtime contract

Environment, read once at SCENE initialisation:

| Variable                     | Meaning                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_CALIBRATION`            | absolute path to the record. Absent or unreadable → refuse `no-calibration`; present but malformed → refuse `invalid-calibration`                                                                                                                                     |
| `GRC_MODE`                   | `validate` (default; all checks, all evidence, never writes the vptr) or `arm`                                                                                                                                                                                        |
| `GRC_EVIDENCE_DIR`           | absolute directory, created if missing. Unset → the same payloads go to stdout as `[grc] evidence <name> …` lines                                                                                                                                                     |
| `GRC_DISARM_AFTER_FRAMES`    | integer; disarm after that many armed frame callbacks. Unset → stay armed until the shutdown callback                                                                                                                                                                 |
| `GRC_STREAM_OUT`             | absolute `.rs1` path of the full-encoding sink (render-stream/1 since G1b2). When this or `GRC_STREAM_PATCH_OUT` is set and the library armed, enable the canvas mirror, run the root query and publish. Unset → hooks behave as at gate −1                           |
| `GRC_STREAM_PATCH_OUT`       | G1b2: absolute `.rs1` path of the patch-encoding sink (seq 1 full, then patches on `seq-1`), fed from the same per-frame snapshot as the full sink                                                                                                                    |
| `GRC_SABOTAGE`               | test sabotage: `freeze-frame`, `omit-update`, `perturb-transform` (gate 0), `omit-op`, `patch-drop-item` (G1b2), `drop-message` (G1c2, needs `GRC_LIVE_LISTEN`). `ignore-credit`, `stale-coalesce` (G1d) and any other value refuse to publish (arming is unaffected) |
| `GRC_SABOTAGE_OP`            | G1b2: the RenderingServer method `omit-op` drops from `GRC_SABOTAGE_FRAME` on (`free`, `canvas_item_set_visible`, …); required for `omit-op`, refused with any other kind                                                                                             |
| `GRC_SABOTAGE_FRAME`         | first sabotaged frame, an integer ≥ 1, default 21. Read only when `GRC_SABOTAGE` is set                                                                                                                                                                               |
| `GRC_ROOT_SIZE`              | gate 1 (G1a), read at arm with a stream: `observe` (default; declare only) or `enforce-min-size` (`Window.set_min_size(content_scale_size)` on the root, see below). Anything else refuses to publish                                                                 |
| `GRC_LIVE_LISTEN`            | G1c2: `127.0.0.1:<port>` or `[::1]:<port>` (0 = ephemeral). Enables the mirror and root query like `GRC_STREAM_OUT` and serves render-stream/1 over the library's own WebSocket server (one receiver at a time). Any other host refuses (`non-loopback`)              |
| `GRC_LIVE_TAP_DIR`           | G1c2: absolute directory for `stream-<n>.rs1` (every binary message formed for connection n) and `live-<n>.jsonl` (the live log)                                                                                                                                      |
| `GRC_LIVE_MAX_MESSAGE_BYTES` | G1c2: default 16777216; the cap is the minimum of this and the receiver's `hello.inbound_buffer_bytes` (larger: `error` + close 1009)                                                                                                                                 |
| `GRC_LIVE_HELLO_TIMEOUT_MS`  | G1c2: default 5000; no `hello` in time → close 1002                                                                                                                                                                                                                   |

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
- that the capture is complete. 42 of the 565 `RenderingServer` virtuals are
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

## Gate 1 summary

Gate 1 passes as of 2026-10-09 with all four groups in one run (65 checks): G1a, G1b2, G1c2 and
G1d, built on G1b1's codecs and G1c1's WebSocket server. G1e (calibrator 4: `z_as_relative`,
`draw_behind_parent`) is optional for the gate and not part of this result.

What gate 1 proves, on the pinned 4.5.1 release template under `--headless`:

- **Retained state (1a).** Parent/child transforms and modulation, transform changes without a
  redraw, draw order (index swap, z over index, reparent, same-parent re-append), visibility and
  layer culling, content replacement and clearing, create/free/recreate and detach/re-attach, and a
  canvas transform: eleven steps, each pixel-exact against the rendered reference and an image
  painted from `expected.json`, each sabotage failing at exactly its predicted steps.
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
semantics (gate 3), `z_as_relative`/`draw_behind_parent` (G1e; RS defaults until then),
`viewport_set_global_canvas_transform`, `canvas_set_modulate`, y-sort, light masks and texture
filter/repeat (in the session's `unobserved` list), equal-draw-index ties that can change pixels
(`draw-index-tie`, unsupported), a degenerate host size (`degenerate-host-size`, unsupported),
arm-on-first-subscriber and late join (gate 8), more than one receiver, publication-rate control
and real presentation timing (gate 6), non-loopback serving and authorization (gate 2).

Costs, measured on the gate 1 hosts (60 frames per second, the 21-item fixture): one mirror
snapshot copy per frame, about 14 µs; a patch diff about 7 µs and its encoding about 2 µs; a
transaction is a few hundred bytes (about 350 KB for 900 frames), a full snapshot about 8 KB; the
credit round trip is 1–2 host frames for a rendered receiver (`submitted`) and about 1.5 ms for a
headless one (`applied`); the receiver applies a transaction in about 0.6 ms (median, G1c2). The
hook itself stays armed for the whole session (D6), a cost gate 1 does not measure.

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
