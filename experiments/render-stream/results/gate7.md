## Gate 7 summary (2026-10-24)

**Gate 7 passed on build 6a454065** (main with G7rf): every group green on one build, gates −1 to 6
green on it, the g31 run on it on both browsers, and Q11's seven g7-z checks pass for all three
manifests ([gate7/g7z.md](gate7/g7z.md) "g7-z"). Gate 7 adds two browser receivers beside the
native one: the Godot 4.5.1 **web export** and the **GSW canvas receiver**, both on the shared Rust
decode/apply core (`rs-core`; G7gd removed the GDScript core). Each is judged on its own legs and
has its own manifest (D1). The closing run is [gate7/g7z.md](gate7/g7z.md): every group, gates −1
to 6 and the g31 on one build, locally. It follows two sweeps,
[the pre-G7v sweep](sweep-pre-g7v.md) (complete, at c9026a06) and [the pre-G7z delta
sweep](sweep-pre-g7z.md) (at d5cc1456), and the fixes landed after them:
[G7kh](gate7/g7kh.md) 0fc739f7 (the GSW soak heap), [G7w2c](gate7/g7w2c.md) d78be95f (window-2
checkers, window-1 g7-r), [G7kr](gate7/g7kr.md) 099a92f9 (the page renderer's RSS) and
[G7rf](gate7/g7rf.md) 6a454065 (the resync wait on a folded full). Every number here is from the
closing run unless it names another.

The phone result, as decided by the user (2026-10-22, F3 (a)): **GSW at credit window 2 is gate
7's phone receiver, met with a measured shortfall** (Q13d's checks give `not-met`, recorded as
such); **the web export is not met**; the g31's `hd` stretch miss is accepted as measured; the
g86 is descoped.

### Runs per group and receiver

Paths are under `artifacts/render-stream/gate7/g7z/` of the main checkout; each run directory
holds its `result.json`, per-leg evidence and shots (the new shot baseline). Counts are passing
checks of the group's total; the rest are report-only rows unless named.

| Group | native | web-export | gsw-canvas |
| --- | --- | --- | --- |
| gates −1 to 6 (native) | `va/native-rust-gate{-minus1,0,1,2,3,4,5,55}/run`, `vg6/native-rust-gate6/run`: 29/29 criteria, 24, 66, 91, 56, 185, 131, 130, 154 | – | – |
| g7-0 … g7-6 file legs | – | `va/g7-web-rust/run`: 22, 30, 31/35, 36, 72/74, 47/49, 47/49, 34/36 | `va/g7-gsw/run`: 25, 30, 38/39, 32, 69/71, 42/44, 49/51, 37/38 |
| g7-1, g7-5, g7-55 live | no native live group | `live/web-corr/run`: 39, 20, 20 | `live/gsw-corr/run`: 38, 19, 19 |
| g7-2 live | – | `live/web-g7-2/run`: 41 | `live/gsw-g7-2/run`: 40 |
| g7-6 live (g6l), g7-lc, g7-k (real time) | – | `live/web-timing/run`: 26; 66 (+3 `unavailable`); 29/33 (2 `known-shortfall`) | `live/gsw-timing/run`: 25; 69/70 (+4 `unavailable`), rerun `live/gsw-g7-lc-rerun/run` 70/70; 39/45 |
| g7-r, window 2 (default) | `live/native-g7-r/run`: 32 | `live/web-g7-r/run`: 42/43 | `live/gsw-g7-r/run`: 41 |
| g7-r, window 1 | `live/native-g7-r-w1/run`: 44/46 | `live/web-g7-r-w1/run`: 80/82 | `live/gsw-g7-r-w1/run`: 61 |
| g7-dev (g31) | – | `g31-web/run` (window 2) | `g31-gsw/run` (window 2) |
| g7-dev, g7-bench desktop (g7x) | – | `va/g7x/run`: 36, group checks 29/29 | same |
| g7-p | G7p `gate7/g7p/` (report/2, declared subset), not rerun | same | same |

Images: each leg's `shots/seq-*.png` beside its `applied.json`, e.g.
`va/g7-gsw/run/gate6/gsw/scene/receiver/shots/`,
`live/web-timing/run/gate6/live-web/live/live-scene/receiver/shots/`.

### Per-leg classes

Every honest leg's `leg-class-*` row is `success` and every sabotage fails exactly its predicted
set, in every run quoted, except the one row named:

| Group | web-export honest / sabotage | gsw-canvas honest / sabotage |
| --- | --- | --- |
| g7-0 | 4 / 3 | 4 / 3 |
| g7-1 (file / live) | 4 / 7, 6 / 3 | 5 / 7, 6 / 3 |
| g7-2 (file / live) | 5 / 7, 11 / 7 | 9 / 7, 11 / 7 |
| g7-3 | 6 / 8 | 6 / 8 |
| g7-4 | 12 / 8 | 12 / 8 |
| g7-5 (file / live) | 7 / 11, 3 / 1 | 7 / 11, 3 / 1 |
| g7-55 (file / live) | 12 / 9, 3 / 1 | 12 / 9, 3 / 1 |
| g7-6 (file / live) | 10 / 8, 4 / 1 | 10 / 8, 4 / 1 |
| g7-lc | 5 / 0 | 5 / 2 (first run 5 / 1: `sabotage-ack-while-hidden`, see below) |
| g7-r | window 2: 7 / 0; window 1: 19 / 0 | window 2: 7 / 0; window 1: 14 / 1 |

Native g7-r: window 2 6 honest and 1 sabotage (`constrained-window-overrun`), window 1 11 honest.
g7-k's soak and startup legs are judged by their bounds, not by
`leg-class` rows (see "Memory by process" and "Startup").

### Q7's predictions as measured (file legs)

- **P-W1 (web equals native)**: holds on gates 0, 1 and 3 (25, 151 and 120 of 120 shots
  identical). Elsewhere every differing pixel is in G7b's band and none is "other": g7-2 23 203
  readback + 594 delta1 px over 62 shots, g7-4 220 156 + 18 348 (212), g7-5 162 349 + 686 (100),
  g7-55 195 840 + 0 (90), g7-6 6 230 491 + 118 478 (all 285 shots, a constant ~9.7k px each;
  memory web-vs-native-gate6-band). Causes: readback rounding (the web export's readback path,
  G7b Finding 1) and ANGLE's straight-alpha blends, one level per channel. Byte-identical to the
  pre-G7v sweep's figures.
- **P-G1 (GSW decided pixels exact)**: holds on every group (`q7-pixel-policy@gsw`).
- **P-G2 (GSW glyph boxes exact)**: refuted as predicted-exact, inside its band: 35 of 366 glyph
  boxes exact, every other one max delta 1 (`glyph-boxes-exact@gsw`, report-only). Cause: glyph
  coverage is partial alpha blended in the shader premultiplied vs Godot's blend unit (G7c).
- **P-G3 (translucent blends delta1)**: holds: every non-identical GSW shot differs from native by
  max delta 1 (`gsw-vs-native@gsw`, report-only; delta1 masks g7-2 10 240, g7-4 151 526, g7-5
  138 580, g7-55 152 064, g7-6 1 745 473 px).
- **P-G4 (undecided counted)**: g7-2 4 468, g7-5 88 468 and g7-6 2 683 930 px in undecided masks
  (linear filtering, AA feathers, text and RichTextLabel boxes), counted, never judged.

Bands with their causes: the web export's readback ∪ delta1 band (readback rounding, ANGLE
straight-alpha blends); GSW's Q7 view per gate (`fixtures/gsw-tolerance.json`: delta1 regions
for translucent blends and glyph coverage, undecided regions for linear filtering, AA feathers
and text boxes); gate 6's constant ~9.7k px web band (the HD scene's readback rounding).

### The three manifests side by side

Headline per receiver (details and shas in [gate7/g7z.md](gate7/g7z.md) "The three manifests";
files under [protocol/features/render-stream-7/](../protocol/features/render-stream-7/)):

| | native | web-export | gsw-canvas |
| --- | --- | --- | --- |
| supported | 64 | 66 | 66 |
| typed-unsupported (the wire's refusals) | 20 | 20 | 20 |
| receiver-typed (the receiver's own refusals) | 0 | 1 (`cache-budget-unsupported`) | 0 |
| declared-unverified | 7 | 7 | 8 |
| unobserved | 32 | 29 | 29 |
| g31 device targets | not applicable | not met (window 2, this build) | not met by Q13d, accepted as met with measured shortfall (window 2) |

Every entry, side by side (exactness in brackets; `band` names its tolerance gate):

| Kind | Entry | native | web-export | gsw-canvas |
| --- | --- | --- | --- | --- |
| op | `add_circle` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_clip_ignore` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_line` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_mesh` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_msdf_texture_rect_region` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_multiline` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_nine_patch` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_polygon` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_polyline` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_primitive` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_rect` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_set_transform` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_texture_rect` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_texture_rect_region` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `add_triangle_array` | supported (exact) | supported (delta1) | supported (band, gate6) |
| op | `canvas_item_add_animation_slice` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_item_add_lcd_texture_rect_region` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_item_add_multimesh` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_item_add_particles` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_item_attach_skeleton` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_item_set_canvas_group_mode` | unobserved | unobserved | unobserved |
| op | `canvas_item_set_copy_to_backbuffer` | unobserved | unobserved | unobserved |
| op | `canvas_item_set_light_mask` | unobserved | unobserved | unobserved |
| op | `canvas_item_set_sort_children_by_y` | unobserved | unobserved | unobserved |
| op | `canvas_item_set_visibility_notifier` | unobserved | unobserved | unobserved |
| op | `canvas_light_attach_to_canvas` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_set_disable_scale` | unobserved | unobserved | unobserved |
| op | `canvas_set_item_mirroring` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_set_item_repeat` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_set_parent` | typed-unsupported | typed-unsupported | typed-unsupported |
| op | `canvas_texture_set_shading_parameters` | unobserved | unobserved | unobserved |
| op | `global_shader_parameter_add` | unobserved | unobserved | unobserved |
| op | `global_shader_parameter_remove` | unobserved | unobserved | unobserved |
| op | `global_shader_parameter_set` | unobserved | unobserved | unobserved |
| op | `global_shader_parameter_set_override` | unobserved | unobserved | unobserved |
| op | `material_set_next_pass` | unobserved | unobserved | unobserved |
| op | `material_set_render_priority` | unobserved | unobserved | unobserved |
| op | `shader_set_path_hint` | unobserved | unobserved | unobserved |
| op | `texture_set_size_override` | unobserved | unobserved | unobserved |
| op | `viewport_set_canvas_cull_mask` | unobserved | unobserved | unobserved |
| op | `viewport_set_snap_2d_transforms_to_pixel` | unobserved | unobserved | unobserved |
| op | `viewport_set_snap_2d_vertices_to_pixel` | unobserved | unobserved | unobserved |
| item_state | `item_state.behind` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.children` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.clip` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.custom_rect` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.draw_index` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.instance_params` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.material` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.modulate` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.parent` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.self_modulate` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.texture_filter` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.texture_repeat` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.transform` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.use_parent_material` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.visibility_layer` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.visible` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.z_index` | supported (exact) | supported (delta1) | supported (band, gate6) |
| item_state | `item_state.z_relative` | supported (exact) | supported (delta1) | supported (band, gate6) |
| canvas_state | `canvas_state.layer` | supported (exact) | supported (delta1) | supported (band, gate6-hd-half) |
| canvas_state | `canvas_state.modulate` | supported (exact) | supported (delta1) | supported (band, gate6) |
| canvas_state | `canvas_state.transform` | supported (exact) | supported (delta1) | supported (band, gate6) |
| resource | `resource.canvas_texture` | typed-unsupported | typed-unsupported | typed-unsupported |
| resource | `resource.material` | supported (exact) | supported (delta1) | supported (band, gate6) |
| resource | `resource.mesh` | supported (exact) | supported (delta1) | supported (band, gate6) |
| resource | `resource.shader` | supported (exact) | supported (delta1) | supported (band, gate6) |
| resource | `resource.texture_2d` | supported (exact) | supported (delta1) | supported (band, gate6) |
| resource | `resource.texture_2d_placeholder` | supported (exact) | supported (delta1) | supported (band, gate6) |
| payload | `payload.compressed_and_float_texture_formats` | unobserved | unobserved | unobserved |
| payload | `payload.content_addressed_store_and_inline` | supported (exact) | supported (delta1) | supported (band, gate2) |
| payload | `payload.deltas_and_lazy_hashing` | unobserved | unobserved | unobserved |
| payload | `payload.size_and_format_limits` | supported | supported | supported |
| material | `material.late-join-materials` | unobserved | unobserved | unobserved |
| material | `material.param-range` | typed-unsupported | typed-unsupported | typed-unsupported |
| material | `material.param-type` | typed-unsupported | typed-unsupported | typed-unsupported |
| material | `material.shader-excluded` | supported (exact) | supported (delta1) | supported (exact) |
| material | `material.shader-outside-transpile-subset` | declared-unverified | declared-unverified | declared-unverified |
| material | `material.shader-transpile-subset` | supported (exact) | supported (delta1) | supported (exact) |
| material | `material.shader-withheld` | supported (exact) | supported (delta1) | supported (exact) |
| material | `material.shader_policy` | supported (exact) | supported (delta1) | supported (exact) |
| material | `material.unknown-material` | typed-unsupported | typed-unsupported | typed-unsupported |
| material | `material.unknown-shader` | typed-unsupported | typed-unsupported | typed-unsupported |
| material | `material.unsupported-material` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.canvas-stacking-tie` | declared-unverified | declared-unverified | declared-unverified |
| viewport | `viewport.degenerate-host-size` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.global-canvas-transform` | declared-unverified | declared-unverified | declared-unverified |
| viewport | `viewport.non-root-viewport` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.oversampling-mismatch` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.presentation-declared` | supported (exact) | supported (delta1) | supported (band, gate6-hd-half) |
| viewport | `viewport.presentation-mismatch` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.presentation-size-negotiation` | unobserved | unobserved | unobserved |
| viewport | `viewport.snap-2d` | typed-unsupported | typed-unsupported | typed-unsupported |
| viewport | `viewport.snap_2d-declared` | supported (exact) | declared-unverified | declared-unverified |
| viewport | `viewport.stretch-aspect-other-than-keep` | declared-unverified | declared-unverified | declared-unverified |
| viewport | `viewport.stretch-mode-viewport` | declared-unverified | declared-unverified | declared-unverified |
| viewport | `viewport.stretch-scale-mode-integer` | declared-unverified | declared-unverified | declared-unverified |
| delivery | `delivery.constrained_transport` | supported | supported | supported |
| delivery | `delivery.disk_cache_budget` | supported | receiver-typed `cache-budget-unsupported` | declared-unverified |
| delivery | `delivery.live_credit_window` | supported | supported | supported |
| delivery | `delivery.live_token_and_origin` | declared-unverified | supported | supported |
| delivery | `delivery.multiple_live_connections` | supported | supported | supported |
| delivery | `delivery.non_loopback_serving` | unobserved | unobserved | unobserved |
| delivery | `delivery.page_lifecycle` | unobserved | supported | supported |
| delivery | `delivery.presented_timing` | unobserved | unobserved | unobserved |
| delivery | `delivery.publication_rate_control` | supported | supported | supported |
| delivery | `delivery.receiver_resource_budgets` | supported | supported | supported |
| delivery | `delivery.soak_memory_bounded` | supported | supported | supported |
| delivery | `delivery.startup` | unobserved | supported | supported |
| text | `text.rasterization-and-atlas` | supported (exact) | supported (delta1) | supported (delta1) |
| text | `text.rich_text_label_scroll_and_lines` | supported (exact) | supported (delta1) | supported (band, gate6) |
| text | `text.richtextlabel-effects-textedit-ime` | unobserved | unobserved | unobserved |
| control | `control.animation_player_and_tween_sampling` | supported (exact) | supported (delta1) | supported (band, gate6) |
| control | `control.arm-on-first-subscriber` | unobserved | unobserved | unobserved |
| control | `control.browser-receivers` | unobserved | supported (exact) | supported (band, gate6) |
| control | `control.late-join-adoption` | unobserved | unobserved | unobserved |
| control | `control.light2d_rendering` | unobserved | unobserved | unobserved |
| control | `control.line_edit_focus_selection_caret` | supported (exact) | supported (delta1) | supported (band, gate6-hd-native) |
| control | `control.progress_bar_value_and_fill` | supported (exact) | supported (delta1) | supported (band, gate6) |
| control | `control.reference-repeatability-budget` | supported (repeat-budget) | supported (repeat-budget) | supported (repeat-budget) |
| control | `control.scroll_container_offset` | supported (exact) | supported (delta1) | supported (band, gate6) |
| control | `control.stylebox_antialiasing_feather` | supported (exact) | supported (delta1) | supported (band, gate6-hd-half) |
| control | `control.windows-and-macos` | unobserved | unobserved | unobserved |

### Rates and the 60/60 phase study (desktop, 60 Hz host)

g7-r's phase runs (`phase-60-r1..r5`, host at 60/s), published per second, and Q9's class per
run (`phase-summary-<kind>`; report-only on the web):

| Receiver | Window 2 (the default) | Window 1 |
| --- | --- | --- |
| native | 59.79 59.78 59.84 59.84 59.84 (5 good) | 29.05 58.69 31.05 57.37 58.90 (3 good, 2 bad); late-poll 59.05 46.37 59.00 53.00 29.37 (2 good, 2 between, 1 bad) |
| gsw | 59.84 59.84 59.84 59.79 59.79 (5 good) | 57.95 59.06 59.00 59.05 59.05 (5 good) |
| web | 60.00 59.16 60.00 59.79 59.48 (3 good, 1 bad, 1 between) | 44.42 56.51 29.53 59.00 56.69 (3 good, 1 bad, 1 between); late-poll 29.52 58.74 58.74 58.74 55.11 (4 good, 1 bad) |

Window 1 still phase-locks to ~30/s on some runs of native and web (G6c's credit window-1 case);
at window 2 every run of every receiver publishes ≥ 59.1/s. On the web a window-2 run can read
"bad" by its RTT class (2 frames) while publishing 59.2/s. The rest of g7-r, all passing:

| Leg | native | web | gsw |
| --- | --- | --- | --- |
| rate ladder (window 1): 15 / 30 / 60 | – | 15.00 / 29.58 / 58.69 | 15.00 / 30.00 / 58.42 |
| uncapped (window 1) | – | – | host 24 100/s, published 59.05/s, `limited_by: credit` |
| receiver at 30/s (window 1) | – | – | published 28.90/s, 591 credit-blocked ticks |
| constrained (61 ms RTT proxy), window 2 / 1 | the `window-overrun` sabotage fails as predicted | 9.16 / 4.42/s, RTT 12.7 / 13.6 frames | 8.84 / 4.11/s, RTT 13.3 / 14.5 frames |
| host unperturbed under constraint, window 2 / 1 | – | p95 17 362 / 17 359 µs | p95 17 358 / 17 381 µs |
| dual native (window 1) | – | 56.84 / 58.05/s | 58.90 / 58.95/s |

`host-unperturbed-constrained@web`, which G7kr saw 5.1 % over baseline under contention, passed
in both runs at loads 2.5–4.4 (the closing-run note).

### Phone target (the g31; the g86 is descoped by the user)

| Receiver | Device | Workload | Window 1 (G7v's run, unverified here) | Window 2 (this build) | Statement |
| --- | --- | --- | --- | --- | --- |
| gsw | g31 | pace | not met: 47.0/s drawn; rate, cadence, unthrottled | not met: 57.80/s drawn of 59.89 published; `dev-cadence`, `dev-gpu-headroom` | **met with measured shortfall** (user, F3 (a)) |
| gsw | g31 | scene | not met: 35.9/s | not met: 54.11/s drawn of 57.99; rate, cadence, headroom | **met with measured shortfall** (user, F3 (a)) |
| gsw | g31 | hd (stretch) | not met: 4.4/s | not met: 5.05/s drawn of 8.77 | stretch miss, accepted as measured |
| web | g31 | pace | not met: 27.8/s | not met: 56.06/s drawn of 57.71; rate, cadence, main thread (p95 14.5 ms > 8.5) | **not met** |
| web | g31 | scene | not met: 8.7/s | not met: 16.72/s drawn of 19.61; main-thread p95 34.3 ms | **not met** |
| web | g31 | hd (stretch) | not met: 0.30/s | not met: 0.18/s drawn of 0.34 | stretch miss |

T_p 17.0 ms (rAF p50; the web export's scene and hd repeats read 17–34 and 51–68 ms because its
rAF is its own main loop), panel 60 Hz (its only mode, dumpsys), Chrome 155.0.8059.84 (G7v's
was 154), ANGLE on Mali-G52 MC2, thermal `none` before and after every leg, battery 100 % on USB,
the A75 frequency cap read `derated` on some 30-s samples (report-only). Main-thread p95 on gsw:
pace 4.6, scene 7.9 ms (budget 8.5). First submitted frame, median per workload: gsw 0.79–1.69 s,
web 7.7–9.0 s.

### Suspension and lifecycle (g7-lc)

Desktop, simulated (page-side rAF pause; never counted as real), live at window 2
(`live/{gsw,web}-timing/run`): `sim-hidden-2s`, `sim-hidden-30s`, `sim-frozen-30s`, `reload`,
`close` and `context-loss` pass on both browsers (socket kept, latest state on resume, no burst,
the host unperturbed). The real `hidden-2s`, `hidden-30s` and `frozen-30s` rows are typed
`unavailable` on the desktop (4 on gsw, 3 on web); they passed on the g31 in G7u (e7c8235f), not
rerun on this build. A CDP freeze closes the socket (1006) and both receivers recover by gate
1d's reconnect (D14 amended). GSW's `sabotage-css-opacity` failed exactly its set; its
`sabotage-ack-while-hidden` failed one row beyond its set in the first run, `host-unperturbed` (host
frame-interval p95 20 068 vs 17 471 µs
before, +14.9 %, with the 1-min load at 9 to 12 from other agents); rerun once at load 2.3–4.3
(`live/gsw-g7-lc-rerun/run`, `--manifest-hello`) it failed exactly its set and the group passed
70/70.

### Startup (cold / warm, to the first submitted frame)

Live g7-k startup legs, real time, desktop, ms to the first submitted frame, median of r1..r5
(r0 warms the profile):

| Receiver | Cold | Warm | G7k (1feb8b2d) cold / warm |
| --- | --- | --- | --- |
| gsw-canvas | 326 (314–337) | 662 (639–720) | 279 / 705 |
| web-export | 1 751 (1 629–2 607) | 1 596 (1 576–1 623) | 1 815 / 1 701 |

Every mark is present and ordered, and every warm leg's resources came from the HTTP cache
(`g7k-startup-warm-fetches-*`). GSW's warm start is slower than its cold one, as at G7k: in
r1 the `rs-session-decoded` mark sits at 514 ms warm against 136 ms cold (not diagnosed here); the
HTTP cache removes bytes, not time (G7k). On the g31 the first submitted frame (median per
workload, `g7-dev`) is 0.79–1.69 s on gsw and 7.7–9.0 s on web, against D25's 3 s warm budget
(web over it).

### Memory by process

From G7kr's per-process sampler, the honest 300-s `soak-scene` leg at window 2, real time
(`live/<kind>-timing/run/gate6/g6s-<kind>/g6s/soak-scene/receiver/mem-summary.json`), RSS in MB:

| Process | GSW start | GSW 60–90 s | GSW 330–360 s | GSW max | Web start | Web 60–90 s | Web 330–360 s | Web max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **page renderer** | 151.1 | 179.7 | 229.2 | 239.6 | 339.4 | 440.4 | 449.5 | 603.3 |
| GPU | 284.3 | 267.8 | 268.3 | 284.3 | 289.8 | 299.0 | 299.2 | 299.7 |
| browser | 194.6 | 197.1 | 198.0 | 199.5 | 198.7 | 199.3 | 200.8 | 201.0 |
| network service | 121.2 | 123.0 | 124.3 | 124.8 | 120.8 | 121.7 | 122.3 | 122.3 |
| other renderer | 102.6 | 103.5 | 110.2 | 110.2 | 103.0 | 103.7 | 110.5 | 110.5 |
| other renderer (idle; what G7k–G7kh sampled) | 70.4 | 70.5 | 70.5 | 70.5 | 70.3 | 70.4 | 70.4 | 70.4 |
| storage service | 52.4 | 52.5 | 52.5 | 52.5 | 52.1 | 52.2 | 52.2 | 52.2 |

The bounds, honest soak:

| Bound | gsw-canvas | web-export |
| --- | --- | --- |
| page renderer RSS, post-GC slope over [60 s, 360 s] | 10.79 MB/min, growth 49.0 MB over 16 509 GETs: **pass** (Q10 + 5 KiB/GET) | 9.93 MB/min, growth 47.0 MB over 124 GETs: **known shortfall**, report-only (G7kw2) |
| GPU-process RSS | +0.4 MB, 84 KB/min: pass | +0.2 MB, 67 KB/min: pass |
| JS heap | +1.31 MB, 296 KB/min: pass (budget 512) | not judged (wasm) |
| wasm heap | +13.6 MB (7.2 → 20.8): pass (budget 16 MiB) | +0 (106.8 MB flat): pass |
| GPU memory (nvidia-smi) | +0: pass | +0: pass |
| residency and the 1 MiB cache budget | pass (16 498 memory evictions, 0 refetch) | pass (7 evictions, 1 refetch) |

Sabotages fail exactly their sets: GSW `no-evict` {js-heap-bounded, residency-bounded:receiver
memory-cache entries, rss-bounded-renderer, wasm-heap-bounded}, GSW `leak-gl-textures`
{residency-bounded:gl-textures}, web `no-evict` {residency-bounded:receiver memory-cache entries}
(its renderer row is a known shortfall, which no failure set counts).

### Open defects and labelled failures

- **`rss-bounded-renderer@web`**: the web export's page renderer grows 9.93 MB/min post-GC in the
  soak (Q10: 2 MiB/min). Report-only `known-shortfall`, owner **G7kw2** (G7kr: the engine's GL-id
  tables plus unexplained PartitionAlloc growth). Not cited by any manifest entry.
- **g7-2 web `live-vs-reference`** (G8f's report, 252/61/512/512 px off-by-one in two 32×32
  texture regions at steps 4 and 6–9; owner **G7lw**): passed in this run at load 2.6–3.7 (every
  live leg 12/12 shots), consistent with it being contention-dependent; not disproven. No
  manifest entry changes on it, because the run quoted passed.
- **g7-lc `sabotage-ack-while-hidden@gsw`**: one load-sensitive extra row (`host-unperturbed`,
  +14.9 % at load 9–12) on the first run; exact on the one rerun at low load.
- **Harness, fixed in G7z**: a gate 6 view wrote into its read-only source (EACCES), and a device
  leg without `applied.json` crashed the g7-dev checker ([gate7/g7z.md](gate7/g7z.md)).
- Known and labelled, not chased: `cargo-gsw-rs` rc 101, `bench-instr` needs valgrind, the 5 tsc
  errors in `gate2b-checks.ts`.

### What gate 7 does not prove

- **Presentation**: `presented` is `unavailable` for every receiver (Q12); "drawn" is the
  receiver's submit, never the compositor's frame.
- **The phone target on GSW strictly**: Q13d gives `not-met` at both windows; the pass is the
  user's F3 (a) acceptance of window 2 with its measured shortfall, not 60/60. The web export
  meets no g31 target, and no receiver meets `hd` there.
- **Window 1 on the g31 on this build**: quoted from G7v, `unverified` here.
- **Phones other than the g31** (the g86 is descoped), real networks (the phone legs run over USB
  adb reverse), and browsers other than the pinned Chromium 148 (desktop) and Chrome 155 (g31).
- **Real suspension on the desktop**: desktop hidden/frozen legs are simulated (page-side rAF
  pause) and never counted as real; the real ones are G7u's g31 run (e7c8235f), not this build's.
- **Bounded web renderer memory**: `rss-bounded-renderer@web` is a report-only known shortfall
  (G7kw2); the GSW bound includes a 5 KiB/GET allowance for the harness's CDP record.
- **GPU memory**: `gpu-mem-bounded` is `unavailable` where the leak would show (G7k).
- **Shaders outside GSW's transpile subset**, a GSW disk budget, the snap variant in a browser,
  the canvas-stacking tie, the global canvas transform and three stretch variants
  (`declared-unverified` in the manifests); `max_texture_size` is not measured.
- **Determinism across machines**: the closing run is one local machine (NVIDIA RTX 2060, 6C/12T);
  hosted runners disagree on some gsw shot windows (G7rf), so g7-1 and g7-2 stay remote-refused.
- **Late join of pre-arm content, compressed textures, host-size policy and pre-arm materials**:
  gate 8's blockers.
- **Windows and macOS** hosts or receivers.
