## Gate 5.5b result (2026-10-10)

G55b ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55b", "As built (G55b)")
passes. `pnpm render-stream:gate55 -- --legs g55b,g55c` is **52/52** in
`artifacts/render-stream/gate55/g55b-verify2/`, on render-stream/4 after G5d. It was also 52/52 on
/3 before G5d (`gate55/g55b-verify1/`), and g55b's 28 checks were 28/28 alone before the rebase
onto G55c (`gate55/g55b-run1/`). The same build passed `build-capture.sh` (13/13 ctests), gate −1
28/28 (`gate-minus1/g55b-verify2/`), every pure self-test (`self-test-gate55b.ts` 53/53) and every
`make_golden.py`/`make_expected.py --check`. No capture, wire or receiver file changed.

What landed:

- the `CanvasItemMaterial` fixture (`fixtures/gate55-cim/`) with variant `modulate`;
- `make_expected.py`, with a replay of `cim.cpp`'s shader cache, the light-mode and
  canvas-modulate rule, a Python twin of GL's blend equations, per-cell probes, the census and
  G55d's sabotage sets;
- blend modes and a target alpha depth in `scripts/lib/geometry-raster.ts`;
- `lib/gate55b-checks.ts` and `lib/gate55b-expected.ts`, and group g55b in `run-gate55.sh` and
  `check-gate55.ts`.

Images (under the run directory): `cim/reference/shots/step-{0..9}.png` and
`cim-modulate/reference/shots/step-{0..9}.png`, with the same under `reference-repeat/` and
`reference-armed/`. Every shot equals the raster on every pixel (2 304 000 per leg), alpha
included:

- Exact: 225 408 pixels per shot at step 0 and 224 640 after it, once `BD`'s strip is `mix`.
- Within 1: the `mul` region and the .6 strips. 24 672 base and 20 256 `modulate` pixel-shots
  actually differ by 1.

**Measured budget: 0.** Repeat and armed are byte-identical to the reference in both scenes.

Light modes are pixel-proven:

- `LO` (`light_only`) shows only the background until step 2.
- `LU` (`unshaded`) ignores the (1,1,0) and (0,1,1) modulates until it turns `light_only` at 3.
- `UC` changes at 6 through `use_parent_material` alone.

The `BD` alpha prediction (153) is **refuted and explained**. The strip reads (102,51,153,**170**)
because the root viewport's render target is `GL_RGB10_A2`, so alpha has 2 bits. The model
predicted 170 from the source before the run.

`counters.json`, both scenes: `canvas_item_set_material` 13, `material_set_param` 36,
`shader_set_code` 9, `shader_create_from_code` 0, `canvas_item_add_rect` 37 and
`texture_2d_create` 1, all as predicted. Calibrator 8's ops are still unhooked. Both captures
classify `unsupported`, with `canvas_item_set_material` / `unsupported-state` on exactly the items
that name a material at every settle frame, and no item's `content_version` moves but the marker's.

### Findings

- **The root render target is RGB10_A2.** Only `disabled` exposes it, by writing alpha. Every
  other blend keeps the target's alpha, and 0.2-grid colours survive the 10-bit store.
- **A `sub` of (.2,.2,.2) over (.4,.4,.4) equals the same rect without a material.** Q6b's `RC`
  and `UP` therefore needed rects that overhang onto the background to be distinguishable. Q6b's
  56 px overlays also left their region after the `BA` move and the canvas shift.
- **Q6b's `omit-op material_set_shader` set was wrong about `LO`.** The flush that rebinds it also
  frees its old shader, and the wire's free rule then gives exactly the engine's picture. Gate 3's
  marker colours collide under the modulate variant, so G55b has its own ten.

### What G55b does not prove

- The census of calibrator 8's calls (`material_create`, `shader_create`, `material_set_shader`,
  frees, `use_parent_material`, `canvas_set_modulate`). They are predicted per step in
  `expected.json` and checked once G55a's log exists.
- That any material reaches a receiver: that is G55d.
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5.5c result (2026-10-10)

G55c phase 1 ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55c", "As built (G55c
phase 1)") passes. `pnpm render-stream:gate55 -- --legs g55c` is **24/24** in
`artifacts/render-stream/gate55/g55c-run1/`, on the wire `main` speaks. The same build passed
`build-capture.sh` (13/13 ctests), gate −1 28/28 with 64 hooks (`gate-minus1/g55c-run1/`),
`self-test-gate55c.ts` 35/35 and `make_expected.py --check`. No capture, wire or receiver file
changed.

What landed:

- the `ShaderMaterial` fixture (`fixtures/gate55-shader/`, with synthetic shaders only);
- `make_expected.py`, which holds the calls with exact Variant values, a port of the shader
  preprocessor, a Python twin of every `fragment()`, freshness, the oracle's view, a per-frame
  census and G55e's sabotage sets;
- the material oracle (`material_oracle.gd`);
- `run-gate55.sh`, `check-gate55.ts` and `lib/gate55c-checks.ts`, group g55c.

Images (under the run directory): `shader/reference/shots/step-{0..9}.png`, the same under
`shader/reference-repeat/` and `shader/reference-armed/`, and
`shader-refused/reference/shots/step-{0..9}.png`. Every shot equals the model on every pixel
(2 304 000 per leg), refused variant included. Repeat and armed are byte-identical to the
reference, so the budget is 0. Fresh regions per step are exactly as predicted:

- `TI` at 1, 3 and 4, with every material item's `content_version` constant over all 400
  capture frames (fresh without redraw);
- `IN` at 2, `RM` at 3 and 5, `PA` at 6, `TY` at 7, `SH` at 8;
- `PH` at every step.

Measured on the reference by the oracle:

- All 320 parameter values (and 160 on `reference-refused`) equal the model's type and value,
  float32 components exact. Both reference logs are byte-identical.
- Every shader's `shader_get_code` GRP1 hash equals the model's: 170 shader-steps, `tint`
  changing at 3 only, include markers on `tint` only.

`counters.json` on the capture holds 7 `shader_create_from_code`, 1 `shader_set_code`, 417
`material_set_param` (400 of them `PH`'s) and 9 `canvas_item_set_material`. Both captures
classify `unsupported`: `canvas_item_set_material` / `unsupported-state` on exactly the 8 (refused:
13) material items. Neither prints a shader error.

### Findings

- **Canvas `instance uniform` renders in Compatibility 4.5.1.** An unset one reads back as
  `Vector4`, the `vec4` default without a colour hint, and no capture call carries it.
- **The server's shader code is not the file's text.** The preprocessor collapses every run of
  spaces and tabs to one space as well as inserting `@@>`/`@@<` include markers. The port of it
  predicted every hash.
- **`TIME`, screen texture, SDF and global uniforms can be made pixel-exact on the reference**
  (`0.0 * step(0.0, x)`), so G55e's refused receiver has an exact reference.
- **The contract's step-0 row miscounted.** It has 7 materials and 8 `canvas_item_set_material`,
  not 6 and 7. The contract's `TI` colours were off the 0.2 grid with `gain` .5 and were changed.

### Phase 2: the census against G55a's log

On G55a's shader and material hook log, three checks join g55c. With them,
`pnpm render-stream:gate55 -- --legs g55b,g55c` is **55/55** in
`artifacts/render-stream/gate55/g55c-p2/`, and gate −1 is 28/28 with 73 hooks
(`gate-minus1/g55c-p2/`).

- **`material-census`**: the log equals the census frame by frame.
  - `capture-shader`: 448 lines to frame 400, plus 13 teardown frees at 401.
  - `reference-shader-armed`: 150 lines to frame 102.
  - `capture-refused`: 463 lines.

  Every line names the right entity, version, shader, material and parameter type.
- **`shader-hook-hash-parity`**: the hook's GRP1 hash, the reference oracle's and the model's are
  one value on 230 shader-steps.
- **`shader-scan`**: the refused shaders carry exactly `shader-time`, `shader-screen-texture`,
  `shader-sdf`, `shader-global-uniform` and `shader-mode`.

Every prediction held on the first run.

### What G55c does not prove

- That any shader or material reaches a receiver: that is G55d/G55e.
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5.5w result (2026-10-10)

G55w ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55w") passes, rebased onto G5d
(render-stream/4 end to end): `build-capture.sh` **14/14** ctests (the new `rs5_codec` included),
all four golden generators pass `--check` (`golden-2` 47, `golden-3` 37, `golden-4` 51, `golden-5`
62 outputs match), the TS self-tests (`self-test-rs0.ts`, `-rs1.ts`, `-rs2.ts` — the last covering
golden-2/3/4/5) and both GDScript self-tests (`codec2_selftest.gd` over golden-2/3/4/5,
`applier2_selftest.gd` confirming no golden-4 regression — it still reproduces golden-4 state 8's
known engine-invalid `add_triangle_array` as a logged engine error, pre-existing since G5d, not a
regression). Gate 0 is 19/19 (`gate0/20261010T181332Z/`). Gate 4's g4a,g4e legs are 64/64 real
checks in `gate4/20261010T181941Z/` (g4b,g4c,g4d,g4f correctly not run). Gate 5's landed groups
(g5b,g5c,g5d) are 49/49 in `gate5/20261010T182749Z/`. Nothing on the capture, the wire or the
receiver's /2, /3 or /4 behavior changed.

What landed: render-stream/5 ([protocol/render-stream-5.md](../protocol/render-stream-5.md)), a
version-parameterized extension of `rs2_codec.*`/`rs2_diff.*` (a shader table and a material table
each with their own id counter, the `f64` block for parameter values, a 10-float canvas, three new
item fields) exactly as D1/Q4 describe, plus `render-stream-2.ts`/`rs2_decoder.gd` threading a
`2|3|4|5` version parameter throughout (the module-wide default moved from 3 to 4 under this same
increment, since G5d landed mid-way through it and both changes touch the same default — D17), a
new `rs5_codec_test.cpp`, and one new file per side for the shader payload format
(`scripts/lib/render-stream-shader.ts`, `receiver/rs_shader_payload.gd`, mirroring GRT1/GRM1 as
GRP1). `Transaction`/`Snapshot` gained their own V5 fields mirroring `Session::version`; V2
through V4 stay byte-identical in transaction shape.

`golden-5/` holds Q4's predicted four new states (12-15), 62 files. Its states derived from
golden-4's state 8 (12 onward) patch that state's `add_triangle_array` `count` from 3 to 1 — a
local fix, in the Python generator and in a `rs5_codec_test.cpp`-local wrapper only, never in
`rs2_golden_states.h` or `rs4_codec_test.cpp` — since G5d's own landing found that exact count
engine-invalid (`count × 3` must not exceed the index count, `renderer_canvas_render.h:144`): see
render-stream-5.md's "Golden vectors" and "As built" for the rationale. The GDScript `Schema`
class's shader/material/param-entry checks needed a `code` field threaded through `fail()` and its
helpers to match render-stream-2.ts's self-coded (not generic `meta-schema`) error codes for those
three entries (memory: rs-schema-self-coded-errors).

### What G55w does not prove

- That a receiver draws any of this, or that capture/the live runners speak /5 at all: gate 0, gate
  4 and gate 5 run entirely on /2 through /4, unchanged by construction. Switching capture, the
  receiver or any runner to /5 is G55d's job.
- That the shader/material tables or GRP1 match what the engine actually emits for a real
  `ShaderMaterial`/`CanvasItemMaterial`: G55w's encoder is hand-built from golden-5's own
  generator, not driven by a captured mirror. G55a's calibrator 8 and G55b/G55c's fixtures are the
  first contact with a live shader/material.
- Pixel exactness, budgets, or any rendering at all: /5 carries tables and resources; nothing
  paints yet.

## Gate 5.5a result (2026-10-10)

G55a ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55a") passes, rebased in turn onto
G5d (render-stream/4 everywhere) and G55b (the `gate55-cim` fixture and its material census):
`build-capture.sh` **15/15** ctests (`rs_shader_payload` and `rs_variant` new), `scripts/
calibrate.sh --check` clean, gate −1 **28/28** with **73 hooks** planned, none omitted, and every
one of calibrator 8's nine hooks reporting a positive count (the `old-record` leg still arms a
calibrator-1 record with 65 hooks omitted), gate 0 **19/19**, gate 1 **65/65**, gate 2 **85/85**
(no `live-animate` retry needed on either rebase's run), gate 3 **56/56**, gate 4 **185/185**, gate
5 `--legs g5b,g5c,g5d` **49/49** and gate 5.5 `--legs g55b,g55c` **52/52** (confirming the census
fix below). Every pure self-test (checker, gate 0–5, gate 4d, gate 5c, gate 55b, gate 55c, rs0–rs2,
rs-ws) and every `make_golden.py`/`make_expected.py --check` (`golden/`, `golden-1/`–`golden-4/`,
every gate 2–5 and gate 55b/55c fixture) stayed clean.

What landed:

- **Calibrator 8, nine new optional slots** (gate5_5-design.md D2, Q2), confirmed by
  `calibrate.py`/`scripts/calibrate.sh` against the pinned binary exactly as the contract
  predicted: `shader_create` 53, `shader_set_default_texture_parameter` 60, `material_create` 63,
  `material_create_from_shader` 64, `material_set_shader` 65, `canvas_set_modulate` 438,
  `canvas_item_set_use_parent_material` 489, `canvas_item_set_instance_shader_parameter` 490 and
  `canvas_light_attach_to_canvas` 503. The committed record now names 74 slots (73 hooks plus the
  `get_default_clear_color` probe).
- **`rs_variant.{h,cpp}`**: D8's decode through the GDExtension interface alone
  (`variant_get_type`, `get_variant_to_type_constructor`, `variant_get_ptr_constructor`,
  `variant_get_ptr_destructor`, `string_to_utf8_chars`) — every supported scalar and packed-array
  Variant type (the `int` ±2^53 range check, `rid`'s bare id, D8's exact float64 member order for
  every matrix/vector type) and the `StringName`→`String` builtin constructor (index 2 in
  `STRING`'s registration order). No ctest here runs inside a live Godot process, so
  `rs_variant_test` builds its own fake implementation of those five interface functions (a
  test-chosen "Variant"/"StringName" representation the decoder never assumes a shape for) and
  round-trips all 29 supported types plus the catch-all `param-type`/`param-range` refusals.
- **`rs_shader_payload.{h,cpp}`**: the `render-stream-shader/1` (GRP1) encoder; the D11 token scan
  (comment- and dot-aware, typing `TIME`, `hint_screen_texture`, the `texture_sdf` family, `global
  uniform`/`instance uniform`/`light` and a non-`canvas_item` `shader_type`); and the D7
  `CanvasItemMaterial` template recognizer, independently retyped in `rs_shader_payload_test` from
  `canvas_item_material.cpp:80-137` (tabs and the missing newline before the particles block's
  `UV /=` line included) and cross-checked against all six blend modes, all three light modes and
  particles on/off.
- **Decoding added to the three existing material hooks** (`shader_create_from_code`,
  `shader_set_code`, `material_set_param`), gated behind `resources().active()` exactly as the
  texture and mesh hooks are; the decoded name/value/code never reach `counters.json` (Q2) — only
  `evidence/resources.jsonl` and, eventually, the mirror.
- **`rs_resource_log`'s own shader and material registries** (no mirror table yet, as G5a's mesh
  registry): their own per-session id counters, `kind:"shader"`/`"material"`/`"item-material"`
  lines, and nine new trailing columns (`mode`, `source`, `builtin`, `uses`, `scan_ns`, `param`,
  `type`, `n`, `decode_ns`) — `target`/`ref_id` are reused for a material's current shader exactly
  as `texture_replace` already reuses them, and `value` for a plain bool/int state value. A
  material's `status` here reflects only whether its shader RID is known (`unknown-shader`, D16);
  it is never recomputed from historical parameters as the future mirror will (D6) — this log is
  evidence for the census, never the stream. `RESOURCE_LINE_KEYS` (`gate0-checks.ts`,
  `gate2-checks.ts`), `RESOURCE_LOG_OPS` and `GATE0_HOOKS` all extended to match.
- **`canvas_item_set_material` (slot 488, hooked since calibrator 2) now logs a `kind:"item-
  material"` line too**, for the material census alone: its item field on the wire/mirror still
  waits for G55d (D2, D9); this hook gained no new state, no registry lookup result it did not
  already have, and no decoding.
- **`fixtures/spike/`** exercises all nine (Q2's own list): a `CanvasItemMaterial` with a
  `light_mode` change, recognized by D7; a default-texture parameter and an instance parameter on
  the Panel's existing `Shader`/`ShaderMaterial` (which already exercised
  `material_create_from_shader`); `use_parent_material` on a child item; a default-colour (white)
  `CanvasModulate`; and a raw `canvas_light_create` + `canvas_light_attach_to_canvas`. None of it
  draws, so `armed.png == unarmed.png` held unchanged.

### Findings

- **A `CanvasItemMaterial` built only as a local variable never gets its shader.**
  `_update_shader()` (`shader_create`/`material_set_shader`) runs on a *later* idle callback
  (`scene/register_scene_types.cpp:855`), not the frame that queues it
  (`Material::_mark_initialized`'s "straightforward conditions" branch calls `_queue_shader_change`
  synchronously, but that only adds a `SelfList` entry to `dirty_materials`). A local
  `CanvasItemMaterial.new()` inside a helper function is refcounted to zero — taking its
  `dirty_materials` entry with it — the moment that function returns, so the deferred flush never
  fires: the first full run showed `shader_create=0; material_set_shader=0` while the other seven
  calibrator-8 hooks were already positive. Keeping it as a script-level field (as `_nine_texture`/
  `_mesh`/`_multimesh` already are) fixed it on the next run.
- **`expected.json` carries the optional-hook list twice.** `optional_hooks` (gate −1's
  `older-record-loads` check, comparing against `hooks_omitted`) and
  `optional_counters_must_be_positive` (`optional-hook-counts`) are separate arrays with the same
  64 names before this change; missing the first while updating the second passed every check but
  `older-record-loads`, which is easy to miss since its own `hooks_omitted` printout looks like
  the *expected* value at a glance.
- **The GRP1 hashes were cross-checked independently**, as G5a's GRM1 hashes were. A headless run
  of `fixtures/spike/` with a stream enabled produced `shader_create_from_code`/`shader_set_code`
  lines whose hashes were recomputed byte-for-byte in a standalone Python script (magic, meta
  JSON, code bytes) from `TINT_SHADER_A`/`TINT_SHADER_B`'s own literals: both matched exactly. The
  same run's `shader_set_code` line for the CIM's shader carries
  `"builtin":{"kind":"canvas_item_material","blend_mode":"mix","light_mode":"unshaded","particles_animation":false}`
  — `mix` is `CanvasItemMaterial`'s default, `unshaded` is the one property the fixture changes.
- **G55b's own census needed one more op in the log than G55a had shipped.** `gate55-cim`'s
  `cim-material-census` check groups every `evidence/resources.jsonl` line by `op` and compares the
  counts to `expected.json`'s prediction, which (correctly) counts `canvas_item_set_material`
  alongside `material_create`/`material_set_param`/etc. since it is just as much a "material op" as
  those; G55a's own log never wrote a line for it (its item field was out of scope, D2), so the
  first `--legs g55b,g55c` run failed on exactly that one op at three windows (step 0, 4, 5) in both
  `gate55-cim` variants. Adding the line (no registry change, no decoding — `canvas_item_set_
  material` carries two RIDs, nothing to decode) fixed both legs without needing another gate
  rebuild logic change; gates 0–5 were re-run afterward to confirm the new, previously-absent line
  doesn't disturb any other fixture's census or schema checks (none do: it is purely additive).

### What G55a does not prove

- Any wire support: render-stream/4 and /5 are untouched; the shader and material tables, the
  `f64` block, and every new item/canvas field stay off every protocol version (G55w writes the
  codecs, G55d switches the runners and receiver).
- A resident mirror shader/material table, `GRC_SHADER_POLICY`'s `params`/`exclude` branches, or a
  material's `status` recomputed from more than its own shader reference: all G55d/G55e.
- That a receiver, or anything downstream, can compile a shader or apply a parameter: nothing here
  is on any wire yet.

## Gate 5.5d result (2026-10-11)

G55d ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55d", "As built (G55d)") passes:
the capture, the receiver and every gate runner speak
[render-stream/5](../protocol/render-stream-5.md), and `CanvasItemMaterial` blend and light modes
travel end to end. `pnpm render-stream:gate55 -- --legs g55b,g55c,g55d` is **90/90**, first in
`artifacts/render-stream/gate55/20261011T034704Z/` and again on the final, merged build in
`gate55/20261011T091759Z/` (ignored, not committed).

**Final build (merged with `main` at 22909275: G5f and the gate 6 tools).** `build-capture.sh`
17/17 ctests, every pure self-test (`self-test-report` included) and the receiver self-tests
(`codec2`, `applier2`, ws/http interop). Each gate's run directory:

| gate | result | run directory |
| --- | --- | --- |
| −1 | 28/28 | `gate-minus1/20261011T083309Z/` |
| 0 | 24/24 | `gate0/20261011T083424Z/` |
| 1 | 65/65 | `gate1/20261011T084517Z/` |
| 2 | 85/85 | `gate2/20261011T093608Z/` |
| 3 | 56/56 | `gate3/20261011T083311Z/` |
| 4 | 185/185 | `gate4/20261011T084519Z/` |
| 5 (g5b–g5g, G5f's live legs included) | 116/116 | `gate5/20261011T081217Z/` |

The first gate 2 pass of the final build scored 83/85 (`gate2/20261011T090459Z/`) on the known
`live-animate` frame-971 pin. Before the merge, the same work passed:

| gate | result | run directory |
| --- | --- | --- |
| −1 | 28/28 | `gate-minus1/20261011T041335Z/` |
| 0 | 24/24 | `gate0/20261011T041337Z/` |
| 1 | 65/65 | `gate1/20261011T045413Z/` |
| 2 | 85/85 | `gate2/20261011T050522Z/` |
| 3 | 56/56 | `gate3/20261011T041955Z/` |
| 4 | 185/185 | `gate4/20261011T045414Z/` |
| 5 (g5b–g5e, g5g) | 101/101 | `gate5/20261011T042938Z/` |

The first pre-merge gate 1 pass scored 63/65 (`gate1/20261011T041954Z/`). Its live checker still
expected subprotocol `render-stream.4`, and its receiver-state comparison did not carry the new
tables.

What landed:

- **The mirror.** The capture now keeps a shader table and a material table (Q3b), each with its
  own id counter. Versions count as the hook log counts them, and there are no tombstones: freeing a
  shader nulls every material that names it, and freeing a material nulls every item that names it.
- **Item and canvas state.** Items carry `material`, `use_parent_material` and `instance_params`, and
  canvases carry their modulate. The derived entries `unsupported-material` (from the effective
  material), `unknown-material` and `param-type` are emitted, and so is the sticky `canvas-light`
  entry.
- **Policy, sabotage and payloads.** `GRC_SHADER_POLICY` and `perturb-shader` are wired. GRP1 code
  payloads go to the store (`.grp`, `shader-code` index lines), to inline records and to the live
  hub. Every snapshot is stamped V5.
- **The receiver.** It follows Q5: shaders compile through `shader_create` plus `shader_set_code`
  from verified GRP1 code, materials and their parameters are rebuilt as exact Variant types, and
  items and canvas 1 get their material fields and modulate. It also gains `ignore-material`,
  `ignore-canvas-modulate` and `stale-param`, `applied.json` /5 and /5 state dumps.
- **The g55d group.** `lib/gate55d-checks.ts` and `lib/gate55-wire.ts` hold its checks.

Legs and classes (gate55-cim, both scenes under `cim/` and `cim-modulate/`):

| leg | class |
| --- | --- |
| `capture-cim`, `capture-cim-modulate` | `success` (both sinks and the store) |
| `capture-cim-inline`, `capture-cim-modulate-inline` | `success` (every payload inline, GRP1 included) |
| `receiver-cim{,-patch,-inline}`, `receiver-cim-modulate{,-patch,-inline}` | `success`, every pixel equal to the reference |
| `sabotage-cim-freeze` | `pixel-mismatch`: marker {1..9}, `BD` {1..9}, `LO` {2..9}, `LU` {3..9}, `RC` {4..9}, `UP` {6..9}, `BA` {7..9}, every other region {9} |
| `sabotage-cim-omit-material-set-shader` | `pixel-mismatch`: `LU` {3..9}, `RC` {5..9}, `UP` {8,9} |
| `sabotage-cim-receiver-ignore-material` | `pixel-mismatch`: `BA`, `BS`, `BU`, `BP`, `UP` {0..9}, `BD` {0}, `LO` {0,1}, `LU` {3..9}, `RC` all but {4}; `BM` and `LM` never |
| `sabotage-cim-modulate-receiver-ignore-canvas-modulate` | `pixel-mismatch`: every region and the marker {0..7}, `LO` {2..7}, `LU` never |
| `capture-shader` (g55c) | `success` on /5 (G55e adds its receivers) |
| `capture-refused` (g55c) | `unsupported`: `unsupported-material` on the five refused items only |

Images, all under the run directory:

- `cim/reference/shots/step-{0..9}.png` against `cim/receiver/shots/seq-<n>.png`, with
  `receiver-patch/` and `receiver-inline/` beside it;
- the same for `cim-modulate/`, where `seq-28.png` shows the (0,1,1) canvas modulate, `LU`
  unshaded and `LO` visible;
- the sabotages' shots under `cim/sabotage-*/receiver/shots/`, `cim/sabotage-receiver-*/shots/` and
  `cim-modulate/sabotage-receiver-*/shots/`.

- **Wire.** At every transaction of both sinks, and of the inline capture, the shader and material
  tables equal the hook log replayed to the end of that frame (`material-commands`). Each item
  reaches CimSim's builtin blend and light mode through item → parent → material → shader at every
  settle frame (`builtin-modes`). Each table event lands in exactly one patch transaction
  (`material-census-wire`):
  - the frees of the disabled, light_only and unshaded shaders at 11, 21 and 31;
  - shader 9 at 31;
  - `RI`'s material 11 leaving at 41;
  - material 12 at 51.

  `UC`'s `use_parent_material` flips at 61 with no redraw (`fresh-without-redraw`). There is no
  shader or material traffic at steps 7 and 9 (`resource-quiet`).
- **Bytes and cost.**
  - **Store:** 8 GRP1 payloads, 1 578 B; every CIM shader is 193 B, 142 B of code.
  - **`param_f64`:** 264 B in a full transaction (33 parameters), 24 B in a patch carrying one material.
  - **Sinks over 400 frames:** full 7 268 953 B, patch 313 752 B, all-inline 7 291 423 B.
  - **Hook cost at step 0** (8 shaders, 36 parameters): copy 7.0 µs, hash 9.7 µs, scan 13.3 µs and
    decode 3.1 µs in total. Step 3's new shader costs 3.1, 2.0 and 2.8 µs.
  - **Each receiver:** creates 9 shaders and 12 materials, sets 36 parameters and fetches 8 payloads
    out of band (none inline). Step 0 costs 398 RS calls, 60 of them material calls.

### Findings

- **The /5 receiver tipped G5f's live legs into a phase lock, and a decoder fix brought them back.**
  After the merge, every branch run of `--legs g5c,g5f` failed some g5f check, a different one
  each time: `pins-bounded`/`obsolete-retired` at frame 851, `warm-host-no-gets`, or the
  stale-coalesce leg's step 1. Main's code passed 2/2 on the same machine (A/B runs in this
  session's scratchpad). The /5 receiver cost about 150 µs more per transaction: in a headless
  benchmark over the same recording, `decode_record` took 684 → 729 µs, `needed()` 13 µs more and
  `apply_state` 32 µs more. That was enough to push the 60 Hz credit loop into a stable
  every-other-frame lock (`coalesced` 290–400 instead of 0–11). The warm leg then saw a different
  set of `DF` phases than the cold one.

  Most of `decode_record`'s time was a per-byte GDScript loop that checks the meta is printable
  ASCII. It now does a native Latin-1 decode plus one regex search, and the loop runs only to name
  the bad byte of a record that has one. That saves 170 µs per transaction and makes the receiver
  faster than main's. g5f then passed alone (`--legs g5c,g5f`) and in the full gate 5 run
  (116/116).
- **The hook log has to apply D5 too.** A CIM flush frees the old shader while its material still
  names it, then binds the new one. The mirror nulls the material at version + 1 on the free, and the
  G55a log did not, so the log's versions trailed the wire's by one after steps 1–3. The log now
  applies the rule silently, with no line of its own, and readers replay it from the `free` line.
- **G55w's validators derived `unsupported-material` from the item's own material.** D9 says the
  effective one, which is what the mirror emits. Both validators (TS and GDScript) now walk
  `use_parent_material`.
- **`rs::DecodedParam` could not tell a `Vector2` from a `PackedVector2Array`.** Both reported
  `"vector2"`. It now has a `packed` flag.

### Deviations from the contract

As built (G55d) 3–8 in the design doc: the `exclude` policy is `withheld` and a D11 reason wins;
`RID()` parameters are erased; code with no known `shader_type` is refused with `shader-mode`;
`canvas-light` keeps first-observed order after `degenerate-host-size`; the receiver's conservative
choices (it never creates an unsupported material, sets the modulate only when it differs, and
already has `stale-param`); and g55d reuses g55b's legs and adds three checks
(`canvas-modulate-wire`, `shader-store`, `receiver-state-dumps`).

### What G55d does not prove

- `ShaderMaterial` on a receiver: instance parameters, default and parameter textures, packed
  arrays, the `params`/`exclude` policies and `perturb-shader` (G55e). The capture carries them, but no
  receiver leg replays them yet.
- Materials through a stall or over live HTTP (G55f), late-join materials and the process-global CIM
  shader cache (gate 8), and browser receivers (gate 7).
- `Light2D`: typed only (`canvas-light`). Exactness on another GPU or driver.

## Gate 5.5e result (2026-10-11)

G55e ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55e", "As built (G55e)") passes:
`ShaderMaterial` travels end to end on render-stream/5. Native receivers compile the captured
GRP1 code and rebuild every parameter. The `params` policy keeps all code off the stream, and the
`exclude` policy refuses the shaders. Every sabotage mismatches in exactly its predicted regions.
`pnpm render-stream:gate55 -- --legs g55b,g55c,g55d,g55e` is **115/115** in
`artifacts/render-stream/gate55/run1/` (ignored, not committed). The discovery run
(`gate55/disc1/`, `--legs g55c,g55e`) failed one check, the freeze leg's marker (Findings), and
nothing else.

| gate | result | run directory |
| --- | --- | --- |
| 5.5 (g55b–g55e) | 115/115 | `gate55/run1/` |
| −1 | 28/28 | `gate-minus1/run1/` |
| 0 | 24/24 | `gate0/run1/` |
| 1 | 65/65 | `gate1/run1/` |
| 2 | 85/85 | `gate2/run1/` |

Gate 5 was not rerun: G55e changes no capture, receiver, codec or publisher file. The pure
self-tests `self-test-gate55b` to `-e` pass (54, 53, 64 and 38 assertions), and so do both
`make_expected.py --check` runs.

What landed:

- **The g55e group.** `run-gate55.sh` `run_g55e` drives the legs. `lib/gate55e-checks.ts` holds
  the checks and `test/self-test-gate55e.ts` tests them. g55e reuses g55c's captures, references
  and oracle, so `--legs g55e` adds g55c.
- **The model.** `make_expected.py` gains `receiver_views`: what `receiver-refused` and
  `receiver-params-nolib` draw, which is items with no material. It also gains both typed legs'
  region sets, and the freeze set now includes the marker.
- **No engine code.** G55d's mirror and receiver already carried and replayed the whole shader
  fixture: instance parameters, the default and parameter textures, the packed array, the library,
  `stale-param` and `perturb-shader`.

Legs and classes (`gate55-shader`; g55c's `capture-shader`/`capture-refused` are the same runs):

| leg | class |
| --- | --- |
| `capture-shader` (g55c) | `success` |
| `capture-shader-inline` | `success`: every payload inline, GRP1 included |
| `capture-refused` (g55c) | `unsupported`: `unsupported-material` on `TM`, `SC`, `SD`, `GU` and `SP`, with their shaders `shader-time`, `shader-screen-texture`, `shader-sdf`, `shader-global-uniform` and `shader-mode` |
| `capture-policy-params` | `success`: every fixture shader `ok` and `withheld` |
| `capture-policy-exclude` | `unsupported`: every fixture shader `shader-excluded`, `unsupported-material` on the eight items with a ShaderMaterial |
| `receiver-shader{,-patch,-inline}` | `success`, every pixel equal to the reference |
| `receiver-params-lib` | `success`, every pixel equal to the reference, all code from the oracle's library |
| `receiver-refused` | `unsupported` (five typed items): `TM`, `SC`, `SD`, `GU` drawn with no material at every step, exactly the receiver view's raster |
| `receiver-params-nolib` | `unsupported` (8 × `shader-withheld`): every item drawn with no material, matching the receiver view's raster; mismatches are the `ignore-material` set |
| `sabotage-shader-freeze` | `pixel-mismatch`: marker {1..9}, `TI` {1..9}, `IN` {2..9}, `PH` {1,3,4,6,7,9}, `RM` {3,4,9}, `PA` {6..9}, `TY` {7..9}, `SH` {8,9} |
| `sabotage-shader-omit-param` | `pixel-mismatch`: `PH` {2,4,5,7,8}, `TI` {4..9}, `RM` {5..9}, `PA` {6..9}, `TY` {7..9} |
| `sabotage-shader-perturb-shader` | `pixel-mismatch`: `TI`, `RM` {3..9}, `SH` {8,9}. Shaders made at frame 1 never move |
| `sabotage-shader-receiver-ignore-material` | `pixel-mismatch`: `TI`, `IN`, `TY`, `PH`, `RM`, `SH` {0..9}, `PA` {6..9} |
| `sabotage-shader-receiver-stale-param` | `pixel-mismatch`: `PH` {0..9}, `TI` {1..9}, `PA` {6..9}, `TY` {7..9}, `RM` never |

Images, all under the run directory:

- `shader/reference/shots/step-{0..9}.png` against `shader/receiver/shots/seq-<n>.png`, with
  `receiver-patch/`, `receiver-inline/` and `shader-policy-params/receiver-lib/` beside it;
- `shader-refused/reference/shots/` against `shader-refused/receiver/shots/` (the four refused
  regions in their plain (.4,.6,.2) rect);
- `shader-policy-params/receiver-nolib/shots/` (every item without its material);
- the sabotages under `shader/sabotage-*/receiver/shots/` and `shader/sabotage-receiver-*/shots/`.

Checks:

- **Parity with the reference's own state.** The reference oracle reads the reference's state
  back through the RenderingServer.
  - `shader-hash-parity`: at every settle step, every live oracle shader hash (`shader_get_code`)
    is the hash of exactly one wire shader entry. 580 shader-steps hold this over six sinks: both
    sinks of `capture-shader` and `capture-policy-params`, the inline capture, and
    `capture-policy-exclude`, whose withheld entries keep their hash. The refused variant holds it
    against its own oracle. The pairing is the creation order (`pal` 1 … `sh_b` 7) and never
    moves: `tint` keeps id 2 across step 3's code change.
  - `param-parity`: 1 264 parameter values have the oracle's Variant type and value exactly (the
    float64 `gain` and `f`, float32 colours and vectors, `vector2i`, the packed float32 array,
    bool, int). `MP.pal` names the fixture texture whose GRT1 pixels the wire's texture id carries.
    Erased and unset parameters are absent. I2's unset instance parameter (16 settle-steps) is
    exempt: the oracle reads it as the uniform's `Vector4` default.
- **Tables.** `shader-material-commands` holds over 54 800 table entries on ten sinks, with D4
  applied to the hook log's view. `shader-store` finds 8 GRP1 payloads in 1 755 B.
  `shader-receiver-state-dumps` finds 10 dumps equal.
- **Policy.** `shader-policy-respected` covers the `params` and `exclude` captures. Each has 4 800
  withheld shader entries. Its store holds no `.grp` and no `shader-code` line, and the inline
  records carry no shader payload. Fifteen files per capture contain neither the GRP1 magic,
  `shader_type`, nor any of the library's eight codes: both recordings, the store, `evidence/`
  with the hook log, and stdout. The same scan finds 24 hits in `capture-shader`.
- **Receivers.** `shader-receiver-typed`: honest receivers type nothing. `receiver-refused` types
  exactly the five refused items. `receiver-params-nolib` types one `shader-withheld` per resident
  (id, hash) pair (8) and sets no code. `receiver-params-lib` sets 8 codes and fetches nothing.

Bytes and cost (`capture-shader`, `materials.gate55-shader.g55e.per_step` in `result.json`):

| step | GRP1 code B first published | `param_f64` B (patch sink, window) | hook copy / hash / scan ns | parameter decode ns | receiver material calls / RS calls |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 311 (6 shaders) | 328 | 9 490 / 7 840 / 10 990 | 10 190 | 41 / 187 |
| 1 | 0 | 120 | 0 | 6 430 | 11 / 13 |
| 2 | 0 | 112 | 0 | 5 950 | 11 / 13 |
| 3 | 313 (`tint_b`) | 80 | 2 550 / 10 370 / 3 780 | 3 340 | 11 / 13 |
| 4 | 0 | 112 | 0 | 3 780 | 11 / 13 |
| 5 | 0 | 112 | 0 | 4 850 | 12 / 17 |
| 6 | 0 | 112 | 0 | 4 020 | 11 / 14 |
| 7 | 0 | 192 | 0 | 4 260 | 12 / 14 |
| 8 | 131 (`sh_b`) | 80 | 2 660 / 2 150 / 2 250 | 4 030 | 12 / 16 |
| 9 (frames 91–400) | 0 | 2 480 | 0 | 123 719 | 310 / 313 |

- **`param_f64`.** A full transaction carries 256–288 B (32–36 values). `PH`'s per-frame `phase`
  costs 8 B per patch and about 0.4 µs of hook decode per frame. A step-3 hash of 10.4 µs against
  3.1 µs in the discovery run is timing noise on one call.
- **Sinks over 400 frames.**
  - `capture-shader`: full 3 719 755 B, patch 363 855 B.
  - All-inline: full 3 745 028 B, patch 389 128 B.
  - `params`: full 3 722 155 B (+6 B per full transaction, for `"withheld"` against `"payload"`),
    patch 363 863 B.
  - `exclude`: full 4 014 557 B, patch 603 640 B. Every patch repeats the eight
    `unsupported-material` entries.
- **Each honest receiver** creates 7 shaders and 8 materials, and sets 8 codes, 417 parameters and
  2 instance parameters. Fetches: 8 from the store, 0 inline, 0 with the library.
- **The `params` receivers.** `receiver-params-lib` costs the same RS calls as `receiver-shader`
  (187 at step 0). `receiver-params-nolib` costs 167: it creates no shader but still makes all 8
  materials and sets all 417 parameters.

### Findings

- **G55c's sabotage sets left the marker out.** `make_expected.py`'s `diff_sets` skipped the
  `Marker` region in every prediction. Under `freeze-frame` the marker shows step 0's colour from
  step 1 on, as Q6c says, so the freeze leg failed on its first run with the marker as the only
  extra region. No other view moves the marker, so `diff_sets` now compares every region.
- **The hook log stays policy-blind.** Its shader lines say `source: "payload"` under every policy,
  because D4 is applied at publication, not at the hook. A reader comparing the log with the wire
  applies D4 to the log's view first (`applyPolicyToLog`). The log still carries no code, only
  hashes. The scan proves it for both policies.
- **`params` is not a typed capture.** A withheld shader is `ok`, so `capture-policy-params`
  classifies `success`. The refusal is the receiver's: `shader-withheld` in `applied.json`. A
  material whose shader is skipped draws as none, so `receiver-params-nolib` is exactly the
  `ignore-material` picture.
- **No engine change.** The first engine run passed every g55e check but the marker one, so G55d's
  mirror and receiver needed nothing for `ShaderMaterial`. The receiver's per-transaction path is
  unchanged, so G5f's live timing (G55d's finding) is not at risk.

### Deviations from the contract

As built (G55e) 2–7 in the design doc:

- `capture-policy-params` is `success`, and the receiver types `shader-withheld`.
- The checker applies D4 to the hook log's view.
- The marker is in the freeze set.
- `expected.json` gains `receiver_views`.
- The library is a copy of the reference oracle's dump.
- Check ids carry `shader-`, and six checks were added (`shader-material-commands`,
  `shader-store`, `shader-expected-image-receiver`, `shader-receiver-state-dumps`,
  `shader-receiver-typed`, `g55e-capture-log-clean`).

### What G55e does not prove

- Shaders and parameters through a stall or over live HTTP: G55f.
- `TIME`, the screen texture, SDF and global uniforms on a receiver. They stay typed.
- Late-join materials, which are gate 8's.
- Browser and web-export receivers (gate 7).
- Exactness on another GPU or driver.
- The library's provenance. It is trusted by hash only: the receiver verifies each GRP1 file
  against the wire hash, but does not check where the file came from.

## Gate 5.5f result (2026-10-11)

G55f ([protocol/gate5_5-design.md](../protocol/gate5_5-design.md) "G55f") passes: live `ShaderMaterial`
parameters and code survive a dropped presentation, and gate 5.5 is complete. No capture-side
(C++) or receiver-side (GDScript) change was needed — exactly G5f's finding
(gate5-design.md "G5f"), since `GRC_SABOTAGE=stale-coalesce`, the pin/retire/HTTP machinery and
`fixtures/gate55-shader`'s own `RS_FIXTURE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` handling are
already generic over resource kind. The whole increment is runner (`run-gate55.sh`'s new
`run_g55f`, plus `REFERENCE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` added to `run_reference`)
and checker (`lib/gate55f-checks.ts`) wiring onto gate 1's G1d stall report and gate 2's live
pin/retire/HTTP checks, generalized to GRP1 shader-code hashes
(`okShaderHashes`/`shaderTableHashes`, gate2c-checks.ts). `pnpm render-stream:gate55 -- --legs
g55b,g55c,g55d,g55e,g55f` is **130/130** in `artifacts/render-stream/gate55/20261011T112118Z/`
(g55f's evidence under `shader-live/<leg>/`; ignored, not committed). On the same build: gate −1
PASS (`gate-minus1/20261011T112145Z/`), gate 0 PASS (`gate0/20261011T112300Z/`), gate 1 65/65
(`gate1/20261011T112614Z/`), gate 2 85/85 (`gate2/20261011T113612Z/`) — no regression.

**The live timeline** is gate 1's and G5f's exact pattern, reused unchanged: S=300, N=60, the
shader fixture's own `LAST_STEP`=9, quit=851. Four legs, each its own host and receiver on
`fixtures/gate55-shader`: `live-shader` (fresh cache), `live-shader-warm` (a new host and receiver
on `live-shader`'s cache, mode warm), `live-shader-stall` (`RS_RECEIVER_STALL=1:2000` after step
1), and `sabotage-shader-stale-coalesce` (the same stall, host `GRC_SABOTAGE=stale-coalesce` from
step 1's frame). A fifth rendered run, `reference-live`, is the shader fixture at this *same* live
timeline with the capture extension absent — the ground truth every leg's shots are compared
against.

| Leg | Class | Exit |
| --- | --- | --- |
| `live-shader` | `success` | 0 |
| `live-shader-warm` | `success` | 0 |
| `live-shader-stall` | `success` | 0 |
| `sabotage-shader-stale-coalesce` | `pixel-mismatch` | 0 |

Measured stall timing (both stalling legs, independently): send frame 367, credit frame 488–489
(121–122 frames at a 2000 ms request — matching memory `rs-g1d-stall-facts`'s gate-1 numbers
almost exactly), the post-stall shot landing in step 3's window (step 2's window lies wholly
inside the stall and has no shot at all, by design). `live-shader-stall`'s recovery transaction
(seq 317, frame 488) resolves to exactly the host's own full file recording at frame 488 — the
newest state (`phase` and the `tint_b` code hash both included in that one proof), not a missed
one; only the one shader-kind fetch tied to that seq names a hash, and it is the newest one.
`sabotage-shader-stale-coalesce`'s recovery transaction (seq 312, frame 489) is labelled
`stale_from: 368` and does **not** equal the host's full recording there; its step-3 shot
mismatches `reference-live` exactly in `IN`, `Marker`, `PH`, `RM` and `TI` — every region
`expected.json`'s per-step `fresh` table says steps 2 and 3 (both swallowed by the stall) touch,
not only `PH`, the one region that changes every frame (memory
`rs-g55f-stale-coalesce-region-set`).

**Checks** (`lib/gate55f-checks.ts`, all passing): `live-tap-equals-received`,
`live-resolves-to-recording` (2225 live transactions equal the host recordings),
`pins-bounded`/`obsolete-retired` (replayed from the pin/retire lines against the full recording's
`okImageHashes ∪ okShaderHashes`, since the fixture also serves TEX16/TEX16B and the engine's hue
strip over the same mechanism; retained max 9–10 hashes, 22.9–23.2 KB), `http-gets-match-fetches`
(20 GETs total: `live-shader` 10, `live-shader-warm` 0, `live-shader-stall` 10, every one a
verified 200 with the right headers), `gets-advertised`, `fetch-before-applied`,
`shader-fetches-latest-only` (the recovery transaction equals the host's newest; the one
shader-kind fetch tied to its seq names only a hash the newest state holds),
`receiver-vs-reference` (`live-shader` 10/10, `live-shader-warm` 10/10, `live-shader-stall` 9/9,
`sabotage-shader-stale-coalesce` 8/8 — each leg's own stall-window step excluded, a `PH`-only
difference tolerated when the wire's own state at that frame equals the host's full recording
there), `stale-coalesce` (the region set above), `warm-host-no-gets` (0 GETs, 10 cache hits, shots
equal `reference-live`'s), and `leg-class-*` for all four legs.

Images (under the run directory): `shader-live/reference-live/shots/step-{0..9}.png` against
`shader-live/live-shader/receiver/shots/seq-<n>.png`, `shader-live/live-shader-warm/receiver/shots/`
and `shader-live/live-shader-stall/receiver/shots/` (step 2 absent, swallowed by the stall), and
`shader-live/sabotage-shader-stale-coalesce/receiver/shots/seq-312.png` (step 3, the stale shot)
against `shader-live/live-shader-stall/receiver/shots/seq-317.png` (step 3, the healthy recovery)
and `shader-live/reference-live/shots/step-3.png`.

### Findings

- **The design doc's own G55f text undersold the stale-coalesce mismatch.** It named `PH` and `TI`;
  the measured set is `IN`, `Marker`, `PH`, `RM` and `TI`. Step 2 (`I2.inst_color`) and step 3
  (`tint.code → tint_b`, shared by `TI`'s and `RM`'s materials) are both swallowed by the stall,
  and this fixture's marker is `fresh` at *every* step (unlike `fixtures/gate5-mesh`'s), unlike
  `gate5-mesh`'s G5f, where the swallowed steps' own regions happened to be narrower. The checker
  derives the expected set generically from `expected.json`'s per-step `fresh` table unioned over
  `StallReport.steps_applied_during` — the same rule memory `rs-g5f-live-mesh-facts` established
  and warned not to replace with a hardcoded guess — never from this section's or the contract's
  own prediction. See memory `rs-g55f-stale-coalesce-region-set`.
- **"Only the newest hash is fetched" must scope to the recovery seq, not the whole leg.** A
  fresh-cache receiver legitimately fetches the other five shaders' GRP1 hashes earlier in the run
  (the step-0 bootstrap), unrelated to the stall; comparing the whole leg's fetched-hash set
  against "the newest state's hashes" fails on every real run for that reason alone.
- **Pins, retirement and GET-advertising must union image and shader hashes.** The shader fixture
  also serves TEX16 and TEX16B (drawn by `PA`) and the engine's default-theme hue strip over the
  identical resource mechanism; `okImageHashes(t) ∪ okShaderHashes(t)` feeds the generalized
  `pinsReport`/`unadvertisedGets`, the same shape G5f established for `okImageHashes ∪
  okMeshHashes`.

### What G55f does not prove

- Resource pinning or retirement at a budget tight enough to actually evict something (the shader
  fixture's live retained set never exceeded 10 hashes / 23.2 KB over an 851-frame run).
  Reconnect, resync, or a killed live-shader receiver (gate 1's G1d already proves the mechanism;
  G55f reuses it unchanged).
- A second resource kind changing every frame at once (only `PH` churns continuously here); a
  frame-exact ground truth for a region whose *reference* also depends on continuous time (G55f's
  `benign` rule needs the wire, not a synthesized image, specifically because of this).
- `TIME`, the screen texture, SDF and global uniforms live (they stay typed, as in G55e).
- Browser receivers (gate 7), non-loopback serving and late join (gate 8), and exactness on
  another GPU or driver.

## Gate 5.5 summary

Gate 5.5 passes: every increment from G55a through G55f lands, every gate from −1 through 5.5 now
runs on [render-stream/5](../protocol/render-stream-5.md), and `pnpm render-stream:gate55 -- --legs
g55b,g55c,g55d,g55e,g55f` is **130/130** in `artifacts/render-stream/gate55/20261011T112118Z/`, on
the same build as gate −1 PASS (`gate-minus1/20261011T112145Z/`), gate 0 PASS
(`gate0/20261011T112300Z/`), gate 1 65/65 (`gate1/20261011T112614Z/`) and gate 2 85/85
(`gate2/20261011T113612Z/`). Every leg is at its expected class; images are under each leg's
`shots/` in the run directory, and the references are `reference/shots/step-{0..9}.png` for the
batch timeline (`cim/`, `cim-modulate/`, `shader/`, `shader-refused/`) and
`shader-live/reference-live/shots/` for G55f's own live timeline.

What it proves, by increment:

- **G55a.** Calibrator 8 hooks nine `CanvasItemMaterial`/`ShaderMaterial` calls (73 hooks total);
  whole decoded `Variant` parameter values are copied at the hook on the calling thread, and the
  shader/material hook log carries op, entity, version and (for a parameter) D8's type spelling,
  distinct from the image and mesh columns (Q3d).
- **G55b.** `fixtures/gate55-cim`'s blend modes and light modes (`add`, `sub`, `mul`,
  `premul_alpha`, `disabled`, `mix`; `light_only`, `unshaded`, `use_parent_material`) rasterize
  float32-exact against an independent Python twin: 2 304 000 pixel-shots per leg compared, a
  `BD` alpha prediction refuted and corrected (the root render target is `RGB10_A2`), budget 0 on
  a repeat.
- **G55c.** `fixtures/gate55-shader`'s seven synthetic shaders (code change, recreation, parameter
  erase, texture parameter, packed array, instance parameter) census exactly against the material
  oracle's `shader_get_code`/`material_get_param` readback (230 shader-steps) and a same-build
  repeat (budget 0); the server's preprocessed code (collapsed whitespace, `@@` include markers)
  is independently ported, not assumed.
- **G55d.** [render-stream/5](../protocol/render-stream-5.md) landed for every gate: shaders and
  materials travel as two tables, items carry `material`/`use_parent_material`/`instance_params`,
  canvases carry their modulate, and `CanvasItemMaterial` blend/light modes replay pixel-exact on
  a native receiver (90/90 on the first engine run); the hook log applies D5 (a shader free nulls
  every material naming it at version + 1).
- **G55e.** `ShaderMaterial` travels end to end: a native receiver compiles captured GRP1 code and
  rebuilds every parameter exactly; `GRC_SHADER_POLICY=params` keeps every code byte off the
  stream (a receiver compiles from an operator-local library) and `exclude` refuses the shaders;
  every sabotage mismatches in exactly its predicted regions (115/115).
- **G55f.** Live parameters and code through a dropped presentation: a receiver that stalls for
  two seconds on a continuously-changing shader parameter (`PH`) catches up to the newest `tint_b`
  code and `phase` value in one coalesced transaction (not a stale one), and `stale-coalesce`
  classifies `pixel-mismatch` in exactly the regions the swallowed steps touch. See "Gate 5.5f
  result" above.

Costs measured in this run:

- **Materials (G55b/d).** `gate55-cim` and its `modulate` variant: 8→6 shaders, 11→10 materials,
  GRP1 code published once (1578 B at step 0, 204 B at step 3's recreation), `param_f64` 0–264 B
  per patch transaction. Hook census: `canvas_item_set_material`=13, `material_set_param`=36,
  `shader_set_code`=9, `material_create`=12, `material_set_shader`=17, `shader_create`=9.
- **Shaders (G55c/e).** `gate55-shader`: 6 live shaders throughout (`sh_a`→`sh_b` at step 8), GRP1
  code published at steps 0 (1311 B, six shaders), 3 (313 B, `tint_b`) and 8 (131 B, `sh_b`);
  `param_f64` 80–2480 B per patch transaction (`PH`'s per-frame `phase` dominates step 9's
  258-frame window, 2480 B). 417 `material_set_param` calls, 9 `canvas_item_set_material`.
- **Live shaders (G55f).** Retained store: 9–10 hashes, 22.9–23.2 KB max over an 851-frame live
  run. GETs: 10 cold, 0 warm, 10 after a 2 s stall (121–122-frame gap). See "Gate 5.5f result" for
  the stall timing and the stale-coalesce region set.

### What gate 5.5 does not prove

- The GSW browser or web-export receiver's shader path (gate 7): transpiling the supported subset,
  typing the rest `unsupported`, and a `params`-policy effect keyed by shader hash.
- Shader `TIME`, the screen texture, `BackBufferCopy`/`CanvasGroup`, `Light2D`/occluders/SDF/light
  masks, and global shader uniforms on a receiver (deferred, with owners, to gate 6 or later).
- Sampler arrays, `Array`/`String`/`Dictionary` parameters, and a resource budget tight enough to
  actually evict a shader or material under load (gate 6/8).
- The shader library's provenance beyond its hash, late-join materials, non-loopback serving, and
  authorization beyond a bearer token (gate 8).
- Exactness on another GPU or driver than the RTX 2060 this experiment runs on.

