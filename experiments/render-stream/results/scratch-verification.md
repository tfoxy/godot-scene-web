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

