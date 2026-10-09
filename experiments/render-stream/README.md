# render-stream experiment — gate −1: capture seam

Gate −1 of [docs/handoff-headless-render-stream.md](../../docs/handoff-headless-render-stream.md).
It answers one question before any protocol work starts:

> Can a GDExtension observe every `RenderingServer` drawing and texture call made
> by an **unmodified official** Godot release template running `--headless`,
> without patching code, without a custom engine build, and without any way to
> damage a shipped game?

**Answer: yes, measured.** A GDExtension copies the `RenderingServer` singleton's
vtable into the heap, replaces eight slots with pass-through recording hooks, and
publishes the copy with one aligned pointer store into the singleton object's
first word. Native `Control` drawing, the `Label` glyph path and direct
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
   offset-to-top and the typeinfo pointer come along), overwrite the eight hooked
   slots, then one `__atomic_store_n(..., __ATOMIC_RELEASE)` of the new address
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

| Method                                        | Slot |
| --------------------------------------------- | ---- |
| `texture_2d_create`                           | 24   |
| `texture_2d_update`                           | 30   |
| `canvas_item_add_rect`                        | 465  |
| `canvas_item_add_texture_rect`                | 467  |
| `canvas_item_add_texture_rect_region`         | 468  |
| `canvas_item_add_msdf_texture_rect_region`    | 469  |
| `canvas_item_add_polygon`                     | 473  |
| `free`                                        | 549  |
| `get_default_clear_color` (probe, not hooked) | 577  |

## Build, calibrate, run

```bash
# build + unit test (cmake is at /snap/bin/cmake; override with CMAKE=)
experiments/render-stream/scripts/build-capture.sh

# re-derive the committed record, plus uncommitted records for the other local
# templates under artifacts/render-stream/calibration/
experiments/render-stream/scripts/calibrate.sh
experiments/render-stream/scripts/calibrate.sh --check   # diff, do not overwrite
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

## Runtime contract

Environment, read once at SCENE initialisation:

| Variable                  | Meaning                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GRC_CALIBRATION`         | absolute path to the record. Absent or unreadable → refuse `no-calibration`; present but malformed → refuse `invalid-calibration` |
| `GRC_MODE`                | `validate` (default; all checks, all evidence, never writes the vptr) or `arm`                                                    |
| `GRC_EVIDENCE_DIR`        | absolute directory, created if missing. Unset → the same payloads go to stdout as `[grc] evidence <name> …` lines                 |
| `GRC_DISARM_AFTER_FRAMES` | integer; disarm after that many armed frame callbacks. Unset → stay armed until the shutdown callback                             |

Arming happens at the earliest point where the `RenderingServer` singleton is
available. With a runtime `load_extension` from an autoload that is SCENE
initialisation, because the engine singletons are already registered by then —
this is the path the scratch runs exercise, and the one the fixture uses. A
startup-loaded extension reaches SCENE initialisation at `main/main.cpp:3633`,
before `register_server_singletons()` at `main/main.cpp:3704`, so
`global_get_singleton("RenderingServer")` would still be null; the attempt is
then retried from the `startup` callback and from each `frame` callback until the
singleton exists. That fallback is source-derived, not exercised by the scratch
runs. Only the first successful attempt decides.

Evidence files, exactly as the runner expects:

- `result.json` — `render-stream-capture-result/1`: `status`
  (`armed|validated|refused|error`), `reason`, `vptr_written`, `disarmed`,
  `display_server`, `rendering_driver`, `rendering_method`. Written at decision
  time and rewritten at shutdown.
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

What this does **not** establish: that the shipped game's stripped fork has the
same vtable layout (it needs its own record, which is exactly what the
calibrator is for), that the capture is complete (only eight slots are hooked),
or anything about performance.

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
- Only 8 slots are hooked, so nothing here says the capture is complete.
- Only Linux x86-64 and this one binary were tested. The startup-loaded path (deferred
  arming) is derived from source and has not been run.
- MegaDot and the shipped game were not tested. Their stripped fork needs its own
  record, which is gate −0.5.
- No costs were measured.

### Next bounded step

Gate −0.5 needs the operator's explicit go-ahead. It runs this library unmodified,
`GRC_MODE=validate` only, against the installed target binary in an owned, isolated
headless instance under that repository's instance rules. It records the
accept-or-refuse decision and the anchors matched, and writes no memory.

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
