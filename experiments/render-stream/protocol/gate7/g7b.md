### G7b — web export: every gate's file legs (opus)

- **Files**: the gate 1 to 6 adapters (web side); the `g7-1..g7-6` web file legs; HD presentation
  sizes in the shell.
- **Checks**: every file receiver check `@web` under Q7. P-W1 is reported per shot (the W vs N
  triangulation), and any non-zero diff is a finding with a source explanation before anything
  else.
- **Sabotages**: each gate's receiver sabotages through `--rs-env`, with their native sets.
- **As built (G7b, 2026-10-15; README "Gate 7b result").** Six of seven groups pass: g7-1, g7-2,
  g7-3, g7-4, g7-55 and g7-6. The seven groups replay 117 web legs, 58 of them sabotages, and
  every leg outside gate 5's mesh refusal classifies as it does natively. The legs are discovered
  from each source run and judged by each gate's unforked checker through views of the source
  (`lib/gate7b-adapters.ts`).
  - **P-W1 held only on flat colours.** Gates 0, 1 and 3 are byte-identical (296 shots). Elsewhere,
    every differing pixel is `readback` or `delta1`. `readback` means one 10-bit value read back as
    `floor(v/4)` by desktop GL's `glGetTexImage` and as `round(v·255/1023)` by the GLES copy-shader
    path (`texture_storage.cpp:1104-1198`). `delta1` means at most one level per colour channel
    with alpha equal: NVIDIA GL against ANGLE/Vulkan blending on AA and translucent edges.
  - **Q7's band is recorded as exactly those two classes,** and both stay within `delta1`.
    `pw1-classes` gates that no other pixel exists. The gates' own budgets judge a banded view in
    which a shot inside the band is replaced by its native shot. Every differing leg had an
    identical same-build repeat.
  - **g7-5 fails on a typed refusal.** Godot 4.5.1's `mesh_surface_update_index_region` binds the
    index buffer to `GL_ARRAY_BUFFER` (`mesh_storage.cpp:591-593`), and WebGL 2 forbids that. The
    web receiver therefore refuses the call (`web-index-region-update` in `unsupported`), and gate
    5's mesh legs fail on 936 px of RM. G7xw's adapter can close this gap.
  - Gate 2's `fresh-cache`/`warm-cache` are `not-applicable`, and its two warm-cache legs are not
    replayed (Q4).
  - Strace, editor and live-derived legs are typed, not replayed (D11).

