## Gate 5b result (2026-10-10)

G5b ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5b", "As built (G5b)") passes:
`pnpm render-stream:gate5 -- --legs g5b` is 15/15 in `artifacts/render-stream/gate5/20261010T074641Z/`,
on render-stream/3 after G4e2. The same build passed `build-capture.sh` (11/11 ctests), gate −1
28/28 with 56 hooks (`gate-minus1/20261010T080906Z/`), gate 0 19/19 (`gate0/20261010T081012Z/`),
gate 1 65/65 (`gate1/20261010T081219Z/`), gate 2 85/85 (`gate2/20261010T082045Z/`), gate 3 56/56
with g3a–g3d (`gate3/20261010T083111Z/`) and gate 4 185/185 with g4a–g4f (`gate4/20261010T083813Z/`), every pure self-test (gate 5's 63
assertions included) and every `make_golden.py`/`make_expected.py --check`. Nothing on the
capture, the wire or the receiver changed.

What landed: the immediate-geometry fixture (`fixtures/gate5/`, eleven regions and the marker over
ten steps), `make_expected.py` (every RenderingServer call the fixture makes and the server's
lowering of it, re-derived in float32 from the source), `scripts/lib/geometry-raster.ts` (a
pixel-centre reference rasterizer over that model: D9's replaced draw transforms, D10's
clip-ignore spans, binary16 primitive colours, nearest texture and nine-patch sampling, band
classes), and the runner, checker and self-test (`run-gate5.sh`, `check-gate5.ts`,
`lib/gate5-*.ts`, `test/self-test-gate5.ts`).

Images (under the run directory): `reference/shots/step-{0..9}.png`, and the same under
`reference-repeat/` and `reference-armed/`. Every reference shot equals `rasterizeGate5` on every
pixel the model decides: 228 246 of 230 400 per shot, 228 760 from step 8 (2 283 488 over the
run), exact where colours are flat (224 487, then 225 001), and within 1 at the gradient triangle,
the gradient polyline segment and the `.6` blend (3 759), where 23 160 pixels over the run do
differ by exactly 1. Left out per shot: 1 992 band pixels (the
antialiased diagonal, circle and rect, the thin GL line; 1 462 once L6 loses `antialiased` at
step 8) and 162 undecided ones (within 1/16 px of a boundary edge, and the stretched nine-patch's
centre pixels next to a margin; 178 from step 8). Every sub-shape is present in every shot, and
every region changes exactly at Q6b's steps: `L2` does not change at step 3, where
`Line2D.antialiased` re-records the same triangle array.

**Measured budget: 0.** The repeat and the armed reference are byte-identical to the reference
at every pixel of every shot, band pixels included (LN 8 100, CI 4 360 and RA 6 400 band
pixel-shots, all at delta 0).

Hook census as measured (`counters.json`, one call per item redraw; it equals the hand count in
every cell): `add_rect` 24, `add_line` 15, `add_polyline` 8, `add_circle` 4, `add_polygon` 7,
`add_primitive` 4, `add_triangle_array` 4, `add_nine_patch` 2, `add_set_transform` 6,
`add_clip_ignore` 2, `texture_2d_create` 3 (the hue strip, TEX16, TEX9). The three predicted
`add_multiline` calls (the dashed line) are invisible: slot 464 is unhooked until calibrator 7
(G5a). The capture classifies `unsupported` with exactly those nine ops typed, and at every settle
frame each item's commands are its calls in order (`add_rect` float32-exact, every other op an
`unsupported` command); no draw-index tie.

### Findings

- **Every engine prediction G5b can see held on the first run**: the census, the class, the
  lowering of lines (quads at half-integer edges), polylines (miter offsets of the clamped
  bisector, a closed loop, hold-last colours), circles, concave and textured polygons,
  primitives (binary16 colours on the 0.2 grid), a triangle array's `count`, draw transforms that
  replace, a clip-ignore span, nine-patch mapping, and `Line2D.antialiased` as a no-op.
- **The rasterizer needed two rules the contract did not spell out** (gate5-design.md "As built
  (G5b)"): a pixel within 1/16 px of a boundary edge is undecided on either side of it, and a
  closed strip or a fan must be welded before finding boundary edges. `make_expected.py`'s
  tie-free assertion and the self-test's hand cases caught them, not the engine.

### What G5b does not prove

- That a receiver draws any of this: on render-stream/3 the capture types every geometry op
  `unsupported`. Commands on the wire, `geometry-commands` within 2 ulp and receiver legs are G5d.
- Meshes (G5c, G5e), styleboxes and the other nine-patch modes at scale (G5g), the `canvas`
  variant's D11 refusal (G5d), and `add_multiline` capture (G5a).
- Pixel exactness on another GPU or driver: budgets and the delta-1 class are measured on one
  RTX 2060 under GLES3.

## Gate 5w result (2026-10-10)

G5w ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5w", "As built (G5w)") passes:
`build-capture.sh`'s ctest suite is 12/12 including the new `rs4_codec` test, all four golden
generators pass `--check` (`golden-1` 35, `golden-2` 47, `golden-3` 37, `golden-4` 51 outputs
match), the TS self-tests (`self-test-rs0.ts`, `-rs1.ts`, `-rs2.ts` — the last covering
golden-2/3/4) and both GDScript self-tests (`codec2_selftest.gd` over golden-2/3/4,
`applier2_selftest.gd` confirming no golden-3 regression). Gate 0 is 19/19
(`artifacts/render-stream/gate0/20261010T084405Z/`). Gate 2's full run (g2a,g2b,g2c,g2e) is 75/78
in `gate2/20261010T084625Z/`; its two failures are the same live-animate pin/retire check at
frame 971 ("811b615292e5 is servable, named by nothing") and did not reproduce on a same-build
rerun of just g2a,g2c (40/40 real checks, `gate2/20261010T131627Z/`) — a timing flake, not a /4
regression, since /4 never runs in gate 2. Gate 4's g4a,g4e legs are 64/64 real checks in
`gate4/20261010T131622Z/` (g4b,g4c,g4d,g4f correctly not run). Nothing on the capture, the wire or
the receiver's /2 or /3 behavior changed.

What landed: render-stream/4 ([protocol/render-stream-4.md](../protocol/render-stream-4.md)), a
version-parameterized extension of `rs2_codec.*`/`rs2_diff.*` (11 new immediate/mesh draw ops, an
`i32` block kind, a mesh table parallel to the texture table) exactly as D1/Q4 describe, plus
`render-stream-2.ts`/`rs2_decoder.gd` threading a `2|3|4` version parameter throughout, a new
`rs4_codec_test.cpp` (the "C++ golden check" D1 names, standing in for G5a's mirror-driven encoder
until G5d wires it up), and one new file per side for the mesh payload format
(`scripts/lib/render-stream-mesh.ts`, `receiver/rs_mesh_payload.gd`, mirroring the GRT1 texture
payload as GRM1). `Transaction`/`Snapshot` gained their own `version` field mirroring
`Session::version`; V2 and V3 stay byte-identical in transaction shape.

`golden-4/` holds 11 states, not Q4's predicted 3 new ones (8/9/10/11 instead of 8/9/10), 1.6 MB
across 51 files — splitting "two meshes created" from "a version-only mesh change" once a third
mesh needed to go `"unsupported"` and a fourth command needed to name an unknown mesh in the same
transaction. See gate5-design.md's "As built (G5w)" note for the full rationale and two
GDScript-only pitfalls, one a ternary-into-typed-array runtime trap that silently broke every
golden-2/3 resolved-state check, not just golden-4's (recorded in
`.agents/memory/rs-gate5-g5w-gdscript-facts.md`).

### What G5w does not prove

- That a receiver draws any of this, or that capture/the live runners speak /4 at all: gate 2 and
  gate 4 run entirely on /2 and /3, unchanged by construction. Switching capture, the receiver or
  any runner to /4 is G5d's job.
- That the mesh table or GRM1 payload matches what the engine actually emits for a real
  `ArrayMesh`: G5w's encoder is hand-built from `rs2_golden_states.h`, not driven by a captured
  mirror. G5c's mesh oracle and G5a's calibrator 7 are the first contact with a live mesh.
- Pixel exactness, budgets, or any rendering at all: /4 carries commands and resources; nothing
  paints yet.

## Gate 5a result (2026-10-10)

G5a ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5a") passes, rebased onto G4e2 (MSDF
on render-stream/3), G5b (the gate 5 immediate-geometry fixture) and G5w (render-stream/4 codecs)
in turn: `build-capture.sh` **13/13** ctests (the new `rs4_codec` included), `scripts/calibrate.sh
--check` clean, gate −1 **28/28** with **64 hooks** planned and none omitted
(`gate-minus1/g5a-final/result.json`), gate 0 **19/19** (`gate0/20261010T133158Z`), gate 1
**65/65** (`gate1/20261010T085201Z`), gate 2 **85/85** (`gate2/20261010T131658Z`; one earlier
attempt scored 83/85 on `pins-bounded`/`obsolete-retired` under `live-animate`'s known
load-timing flake, clean on every rerun since — not a regression), gate 3 **56/56**
(`gate3/20261010T134140Z`), gate 4 **185/185** with every landed group g4a–g4f, g4e (MSDF)
included (`gate4/20261010T135125Z`) and gate 5 `--legs g5b` **15/15**
(`gate5/20261010T133647Z`, confirming the census now reports `add_multiline` instead of silently
dropping it, as G5b's own "What G5b does not prove" predicted it would once calibrator 7 landed).
Every pure self-test (checker, gate 0–4, gate 4d, gate 5, rs0–rs2, rs-ws) and every
`make_golden.py`/`make_expected.py --check` (`golden/`, `golden-1/`, `golden-2/`, `golden-3/`,
`golden-4/`, every gate 2–5 fixture) stayed clean throughout.

What landed:

- **Calibrator 7, eight new optional slots** (gate5-design.md D2, Q2), confirmed by
  `calibrate.py`/`scripts/calibrate.sh` against the pinned binary exactly as predicted:
  `canvas_item_add_multiline` 464, `canvas_item_add_particles` 477,
  `canvas_item_add_animation_slice` 480, `canvas_item_attach_skeleton` 485,
  `mesh_create_from_surfaces` 70, `mesh_surface_update_skin_region` 88,
  `mesh_surface_update_index_region` 89 and `mesh_surface_remove` 99. The committed record now
  names 65 slots (64 hooks plus the `get_default_clear_color` probe). `canvas_item_add_multiline`
  and `mesh_create_from_surfaces` close the two silent holes the contract predicted: before this,
  `draw_dashed_line`'s dashes and a loaded `ArrayMesh`'s surfaces vanished from every capture
  without a trace.
- **`abi.h`'s `SurfaceDataPrefix` grows to the full 240-byte `SurfaceData`**: `Transform3D` (48
  bytes) and `Vector4` (16 bytes) stand-ins, `lods`/`bone_aabbs` reproduced as `Vector<uint8_t>`
  (a `Vector<T>`'s own layout never depends on `T`), then `mesh_to_skeleton_xform`,
  `blend_shape_data`, `uv_scale` and `material`. Every offset (120, 136, 152, 200, 216, 232, 240)
  matches the contract's hand-derived prediction exactly; `abi_decode_test` pins all of them plus a
  round-trip decode of `blend_shape_data`/`uv_scale`/`material`.
- **`rs_mesh_payload.{h,cpp}`**: the `render-stream-mesh/1` (GRM1) encoder, D7's format
  classification (`classify_surface`: 2D positions, no compressed attributes, no `NORMAL`/
  `TANGENT`/`TEX_UV2`/custom channels, blend-shape data refused first and independently), and the
  primitive name table. `rs_mesh_payload_test` pins one literal payload (header hex, length 243,
  SHA-256) derived independently with Python, plus every refusal reason.
- **Whole-surface copy at the hook (D6)**: `mesh_add_surface`, `mesh_create_from_surfaces` and the
  four region updates now classify, copy and hash the complete surface, timed the same way
  `copy_payload` times a texture (`copy_ns`/`hash_ns` split at the encode/hash boundary). Because a
  region update only ever carries the changed bytes, `hooks.cpp` keeps its own retained-buffer
  cache (`g_mesh_buffers`, one entry per mesh RID the hook has seen, with each surface's AABB and
  `uv_scale` fixed at creation per D8) so a later update can re-encode and re-hash the whole
  surface; `mesh_surface_update_*_region` classifies each call `applied` (the common case, or
  "version + 1 only" on an already-`unsupported` surface, Q3b), `rejected` (out of bounds or
  empty, as GLES3 would refuse it) or `unknown` (an unseen mesh or surface index), gated behind the
  omit-op sabotage's hook exactly as a texture update is.
- **The mesh hook log** (`evidence/resources.jsonl`, `kind:"mesh"`, gate5-design.md Q3d): one line
  per mesh call, with its own per-session id counter from 1 (no mirror mesh table yet, as gate 2's
  log worked before G2b2) and eight new trailing columns (`surface`, `buffer`, `offset`, `bytes`,
  `primitive`, `vertex_count`, `index_count`, `outcome`), null on every non-mesh line; `format`
  shares its column with a texture line's format name (the raw `ArrayFormat` bitfield on a mesh
  line, a quoted name on a texture line — never both on the same line).
- **`rs_mirror`**: `canvas_item_add_multiline`/`_particles` go through the existing generic
  `add_unsupported` tap (zero new mirror code, clip_ignore's G3d precedent); `attach_skeleton`
  gets its own small `unsupported_skeleton` item field and `Mirror::attach_skeleton`, reported in
  `Snapshot::unsupported` exactly like a non-null material, under its own op name, never bumping
  `content_version`. A null skeleton (Polygon2D's per-draw call, and the spike's own exercise) is
  free.
- **Feature-list amendment**: `observed_unsupported_ops` gains `canvas_item_add_animation_slice`,
  `canvas_item_add_multiline`, `canvas_item_add_particles` and `canvas_item_attach_skeleton`, in
  `capture/src/rs_publish.cpp` (`gate2_features`) and its TypeScript mirror
  (`scripts/lib/gate0-checks.ts` `RS2_FEATURES`); `protocol/render-stream-3.md`'s "Features"
  section gets the amendment note. `golden-2/`, `golden-3/` and `rs_publish_test`'s golden-session
  fixtures keep their own frozen, pre-G5a copies of the list (`make_golden.py --check` stayed
  clean both before and after, unaffected since it never calls the live function).
- **`fixtures/spike/`** exercises every new hook (Q2's own list): a `draw_dashed_line` longer than
  its dash (alpha 0, so it never changes a pixel) to force `canvas_item_add_multiline` instead of
  `canvas_item_add_line`; a `draw_animation_slice` called *last* in `_draw()`, after every other
  command, because its "skipping" state is time-dependent
  (`drivers/gles3/rasterizer_canvas_gles3.cpp:1276-1282`) and reaches every later command on the
  same item; an orphan item's `particles_create()` particles and a null skeleton attach; a
  `mesh_create_from_surfaces` of one triangle; and a mesh with bones, weights and an index buffer
  exercising the new skin/index region updates and `mesh_surface_remove`.

### Findings

- **The resources.jsonl schema check is a shared, ordered key list.** `scripts/lib/gate2-checks.ts`
  `RESOURCE_LINE_KEYS` enumerates every column of a `render-stream-resource-log/1` line, in order,
  and gates 0, 2, 3 and 4 all import it. The first full run after adding the eight mesh trailing
  columns failed six checks across gate 2 (`census`, `hook-bytes-exact`, `worker-thread-create`,
  `replace-retires-temp`, `viewport-defaults`, `unsupported-variant`) with the same root cause:
  *every* `resources.jsonl` line, mesh or not, now has eight more columns, so the shared key-order
  validator rejected line 1 of every capture before any mesh-specific check even ran. Fixing
  `RESOURCE_LINE_KEYS` (and the `ResourceLine` TypeScript type, including widening `format` to
  `string | number | null`) fixed all six at once; a one-off build-capture.sh/gate −1 pass alone
  would never have caught this, because gate −1 does not read `resources.jsonl` at all.
- **A stream needs `GRC_RESOURCE_STORE_DIR`, not just `GRC_STREAM_OUT`.** Verifying the spike's
  mesh hashes by hand (gate −1's own runner never opens a stream) first refused with
  `resource-store-missing`; both env vars are required before `resources.jsonl` exists.
- **The GRM1 hashes were cross-checked independently.** A headless run of `fixtures/spike/` with a
  stream enabled produced `mesh_add_surface`/`mesh_surface_update_{skin,index}_region` lines whose
  hashes were recomputed byte-for-byte in a standalone Python script (magic, meta JSON, geometry
  block, buffers) from the same literals `spike.gd` passes: all four matched exactly, including the
  skin-region update that rewrites identical bytes (hash unchanged) and the index-region update
  that changes two bytes (hash changed, recomputed correctly). Copy/hash cost on these tiny
  surfaces (24–48 byte buffers, n=125): copy median 1220 ns (530–5070 ns), hash median 1870 ns
  (1290–3570 ns).

### What G5a does not prove

- Any wire support: every new op and the mesh table stay off `render-stream/2` and `/3` entirely
  (G5w writes `/4`, G5d switches the runners and receiver).
- A resident mirror mesh table, tombstones or budget-wide `GRC_RESOURCE_BUDGET_BYTES` enforcement
  across a whole session: the retained-buffer cache here is the hook's own, scoped to re-hashing
  after a region update, not the mirror's eventual mesh table (G5e); only the per-payload
  `GRC_RESOURCE_MAX_PAYLOAD_BYTES` cap is checked, exactly as for a texture.
- That a receiver, or anything downstream, can reproduce a mesh or the new immediate ops: nothing
  here is on any wire yet.

## Gate 5c result (2026-10-10)

G5c ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5c", "As built (G5c)") passes:
`pnpm render-stream:gate5 -- --legs g5b,g5c` is **33/33** in
`artifacts/render-stream/gate5/g5c-verify1/` (g5c under `mesh/`), on render-stream/3. The same
build passed `build-capture.sh` (13/13 ctests), gate −1 28/28 with 64 hooks
(`gate-minus1/g5c-verify1/`), gate 0 19/19 (`gate0/g5c-verify1/`), gate 1 65/65
(`gate1/g5c-verify1/`), gate 2 85/85 (see below), gate 3 56/56 (`gate3/g5c-verify1/`), gate 4 185/185
(`gate4/g5c-verify1/`), every pure self-test (gate 5c's included) and every
`make_golden.py`/`make_expected.py --check`. Gate 2 scored 83/85 on the first pass
(`gate2/g5c-verify1/`: `pins-bounded` and `obsolete-retired` on `live-animate` at frame 971, the
known load-timing flake) and 85/85 on its one rerun (`gate2/g5c-verify2/`). Nothing on the wire or
the receiver changed.

What landed: the mesh fixture (`fixtures/gate5-mesh/`: an `ArrayMesh` in a `MeshInstance2D`, a
raw mesh drawn once and then changed only by vertex, attribute and index region updates, a
two-surface mesh losing a surface, a geoclip-like 9×5 grid deformed every frame in spine-godot's
order and rebuilt 5×3, a `Polygon2D`, a loaded `ArrayMesh` resource and a freed mesh its item still
names), `make_expected.py` (every surface's bytes and so every GRM1 hash, the per-frame hook
census, commands, coverage, freshness, counters), the reference-side mesh oracle
(`mesh_oracle.gd`), group g5c in `run-gate5.sh` and `lib/gate5c-checks.ts`, and one capture
change: a single-surface `mesh_create_from_surfaces` log line now carries its surface's hash.

Images (under the run directory): `mesh/reference/shots/step-{0..9}.png`, and the same under
`mesh/reference-repeat/` and `mesh/reference-armed/`. Every shot equals the coverage model on all
2 143 780 decided pixels of the exact regions; `DF` is band and the repeat and the armed
reference are byte-identical to the reference everywhere (budget 0; `DF` 160 000 band
pixel-shots at delta 0). Fresh regions per step, as predicted: `RM` at 2, 3 and 4 with its
`content_version` constant over all 400 capture frames (pixels change through region updates
alone), `M2` at 6, `P2` and `FR` at 7, `MI` at 1 and 8, `DF` at every step.

Census as measured, equal to `make_expected.py`'s in every frame, on the headless capture (1 222
mesh lines over frames 1 to 400, plus 6 teardown frees at 401) and on the armed rendered reference
(328 lines to its quit frame 102). Hook-log ids are creation order: `AM1` 1, `RMS` 2, `M2` 3,
`DF` 4, `P2` 5, `LD` 6, `FM` 7, `DF2` 8. Frame 1: 6 `mesh_create`, 1 `mesh_create_from_surfaces`,
7 `mesh_add_surface`, `P2`'s `mesh_clear`. Then 11 `AM1` vertex region (v3), 21/31/41 `RMS`
vertex, attribute, index region (v3 to v5), 51 `free(DF)` at v149 + `DF2` create and add, 61
`M2` surface remove (v4), 71 `free(FM)` + `P2` clear and add (v5), 81 `AM1` clear and add (v5),
and `DF`/`DF2` three lines on every frame from 2 (`DF2` v1049 at 400). `counters.json`:
`add_mesh` 409, `mesh_surface_update_vertex_region` 400, `_attribute_region` 399,
`mesh_set_custom_aabb` 398, `attach_skeleton` 3. Hash parity: 73 surface-steps where the hook's
hash (headless capture and armed reference), the oracle's GPU readback and the model's predicted
GRM1 hash are one value; both oracle logs are byte-identical and verify the derived `Polygon2D`
RID. Median hook cost per change (tiny surfaces): copy 0.8–5.9 µs, hash 1.4–7.3 µs.

### Findings

- **Every prediction held on the first engine run**, hashes included: `make_expected.py`'s port of
  `mesh_create_surface_data_from_arrays` (float32 AABB from `Rect2(v0, CMP_EPSILON)`, truncated
  RGBA8) and of Godot's ear clipper reproduced every byte the engine stored, so the oracle, the hook
  and the model agree without either copying the other.
- **A freed mesh still named by a command draws nothing and says so**: the rendered legs print
  `ERROR: Parameter "mesh" is null.` once per frame while `FR` names freed `FM` (frames 71–80, ten
  lines); the headless capture prints nothing (the dummy renderer draws nothing).
- **`Polygon2D`'s mesh RID is not reachable from script.** The oracle derives it from the RID
  allocator's layout and verifies the result against the polygon's own bytes every time.
- **`counters.json` counts teardown**: `Polygon2D`'s destructor calls `attach_skeleton(RID())` once
  more after the quit frame.

### What G5c does not prove

- That any mesh reaches a receiver: on render-stream/3 `canvas_item_add_mesh` is a typed
  `unsupported` command and no mesh table exists. The mesh table, GRM1 on the wire, receiver
  residency and `receiver-vs-reference` on `DF` are G5e's; dropped presentations are G5f's.
- Multi-surface `mesh_create_from_surfaces` hashes in the log (still unnamed; one-surface only).
- Exactness on another GPU or driver: measured on one RTX 2060 under GLES3.

## Gate 5d result (2026-10-10)

G5d ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5d", "As built (G5d)") passes:
the capture, the receiver and every gate runner now speak
[render-stream/4](../protocol/render-stream-4.md), and `pnpm render-stream:gate5 -- --legs
g5b,g5c,g5d` is 49/49 in `artifacts/render-stream/gate5/f2/` (ignored, not committed). On the same
build, rebased onto G5c: `build-capture.sh` 13/13 ctests, `calibrate.sh --check` clean, gate −1
28/28 with 64 hooks (`gate-minus1/f2/`), gate 0 19/19 (`gate0/f2/`), gate 1 65/65 (`gate1/f2/`),
gate 2 85/85 (`gate2/f2/`, live-animate included, no retry needed), gate 3 56/56 (`gate3/f2/`),
gate 4 185/185 (`gate4/f2/`), and after a further rebase onto gate 5.5c, gate 5.5 24/24
(`gate55/f3/`, its capture legs still `unsupported` with `canvas_item_set_material` typed on /4),
every pure self-test (gate 5's 88 assertions and gate 5c's 37
included), both receiver self-tests (`codec2_selftest.gd`, `applier2_selftest.gd`, now on
`golden-4/`) and all fifteen `make_golden.py`/`make_expected.py --check`.

What landed: the mirror records every immediate geometry op (`add_line`, `add_polyline`,
`add_multiline`, `add_circle`, `add_primitive`, `add_polygon`, `add_triangle_array`,
`add_nine_patch`), `add_set_transform` and `add_clip_ignore` as /4 commands, every array copied
whole at the hook; D11's `RID()` rule and the `perturb-vertex` sabotage; the publisher and live hub
write GRS4 with the fifteen-op features. The receiver replays each command in order with the
engine's own call and gains the `ignore-set-transform` and `ignore-clip-ignore` sabotages.
`clip-derive.ts` models D9 and D10. Group g5d adds the receiver, canvas-variant and sabotage legs
(`lib/gate5d-checks.ts`).

Images (under the run directory): `reference/shots/step-{0..9}.png` and the receivers'
`receiver/shots/seq-<n>.png` and `receiver-patch/shots/seq-<n>.png` at the settle seqs (twenty
shots, every pixel equal to the reference's, band pixels included: budget 0), and the sabotage
receivers' shots under `sabotage-*/receiver/shots/` and `sabotage-receiver-*/shots/`.

- **Commands.** All 760 settle-frame commands of both sinks equal `expected.json`'s calls,
  passthrough arguments float32-exact; not one computed argument needed its 2-ulp allowance.
  Line2D is one triangle array (6 vertices, 12 indices, count −1, identical across step 3's
  redraw), the dashed line one 16-point multiline, the unfilled rect and circle closed polylines
  of 5 and 65 points. The full sink is 4 148 170 bytes over 400 transactions, the patch sink
  259 457.
- **Clipping.** `deriveClipRects` gives CG `[344,120,408,168]` (moved at step 7, shifted at 9) and
  exactly one clip-ignored command (index 2) at every step, on both sinks and on receiver-patch's
  own state dumps, each of which equals the recording's resolved state.
- **D11.** The `canvas` variant's capture classifies `unsupported` with exactly five refusals,
  each `canvas-texture-headless`: BL's and PG's polygons, PR's primitives and triangle array, and
  Line2D's triangle array; the textured polygon, the nine-patches and every op without a texture
  argument stay commands.
- **Sabotages**, each exactly as `make_expected.py` predicts: freeze-frame @11 at steps 1..9;
  perturb-vertex @21 in LN {8,9}, PL {3..9}, PG {2..9}, PR {4..9}, CI {6..9} and L2 {3..9};
  omit-op `canvas_item_add_polygon` @21 in PG {2..9}; the receiver's ignore-set-transform in ST and
  ignore-clip-ignore in CG at every step.
- **Gates 3 and 4 flipped to `success`** (Q6g): G3d's `capture-clip-ignore` and
  `receiver-clip-ignore` (equal to the reference in every region, `ri` included), and every G4d
  leg, the underline variant included (one wide `add_line` per redraw, width 1.203125).

### Findings

- **`RichTextLabel` emits two `add_set_transform` per glyph per pass**, not one per line: the
  glyph's own transform before it and `Transform2D()` after, in the text pass and again in the
  outline pass, identity without `[fx]`, spaces and the paragraph's trailing break included. G4d's
  `RTL` carries 30, 40, 54, 68, 102 and 112 of them at steps 0–5 (`2 × glyphs`, plus `2 × 8` for the
  outlined span); gate4-design.md's G4d note is amended.
- **Gate 0's `unsupported` variant had to change**: its marker circle became a command, so the
  circle now sits inside a whole-period `draw_animation_slice`, which stays typed.
- **The snapshot needs the version stamp too**: the mirror stamps `ProtocolVersion::V4`, or
  `make_full` would encode three-block transactions under a GRS4 session.
- `golden-4/`'s state-8 triangle array (`count` 3 over 6 indices) is one the engine refuses; a
  receiver replaying it logs the engine's `count > p_indices.size()` error, harmlessly.

### What G5d does not prove

- Meshes on the wire: `add_mesh` stays a typed refusal in the capture and is skipped by the
  receiver (`mesh-not-replayed`) until G5e brings the mirror's mesh table; `capture-mesh` stays
  `unsupported`.
- Styleboxes, `TabBar`'s flipped box and the focused `RichTextLabel`'s clip-ignore pair at scale
  (G5g); live geometry through dropped presentations (G5f).
- Browser receivers (gate 7): `clip-derive.ts` leaves rects that need the server's lowering
  (antialiased lines, wide polylines, circles, meshes) unknown.
- Pixel exactness on another GPU or driver: one RTX 2060 under GLES3.

## Gate 5g result (2026-10-10)

G5g ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5g", "As built (G5g)") passes on
render-stream/4: `pnpm render-stream:gate5` (g5b, g5c, g5d, g5g) is 78/78 in
`artifacts/render-stream/gate5/20261010T184828Z/` (g5g's 29 checks carry a `-style` suffix). The
same build passed `build-capture.sh` (13/13 ctests), gate −1 28/28 (`gate-minus1/20261010T174402Z/`),
gate 0 19/19 (`gate0/20261010T174526Z/`), gate 1 65/65 (`gate1/20261010T174807Z/`), gate 2 85/85
(`gate2/20261010T190359Z/`; the first run's `live-animate` pin replay failed 83/85 once and did not
reproduce), gate 3 56/56 (`gate3/20261010T181635Z/`), gate 4 185/185 (`gate4/20261010T182816Z/`),
gate 5.5 24/24 (`gate55/20261010T185832Z/`), every pure self-test and every
`make_golden.py`/`make_expected.py --check`.

What landed: `fixtures/gate5-style/` (nine-patch modes, `StyleBoxTexture`, five `StyleBoxFlat`
variants, the default theme's `Panel`, TabBar's flip and a focused `RichTextLabel`; its README
has the tables), `make_expected.py` (a float32 port of `StyleBoxFlat::draw`), group `g5g` in
`run-gate5.sh` (evidence under `style/`), `lib/gate5g-checks.ts`, `test/gate5g-cases.ts`, and the
receiver sabotage `RS_RECEIVER_SABOTAGE=ignore-nine-patch-axis`.

Images: `style/reference/shots/step-{0..9}.png` (and `reference-repeat/`, `reference-armed/`), and
`style/receiver/shots/seq-<n>.png` (and `receiver-patch/`, `sabotage-receiver-ignore-axis/`). Every
reference shot equals the raster on every decided pixel (225 252 per shot at step 0, 226 388 from
step 6; 37 480 of 2 259 144 used their delta of 1: the modulated texture box and the theme Panel's
`.6` fill). Both receivers are pixel-identical to the reference in every shot; the axis sabotage
mismatches exactly `NT` and `NF` at every step.

**Measured stylebox band budget: 0.** The repeat, the armed reference and both receivers equal the
reference at every pixel: `SR` 8 312, `SS` 14 800, `SK` 7 800, `DP` 7 480 and `RT` 4 672 band
pixel-shots and `NF` 1 792 undecided ones, all at delta 0.

On the wire: the capture is `success`; all 324 settle commands equal the expected calls on both
sinks float32-exact (the 2-ulp allowance for the StyleBoxFlat port's cos/sin went unused); Q1h's
counts hold on every array (8/18, 24/66, 108/318, the shadowed box 32/84, the theme Panel 72/210,
the focus box 144/432); 100 nine-patches match argument for argument; the focus box sits between
`clip_ignore(true)` and `(false)` exactly at steps 0–3, and `RT`'s derived scissor reports it
(command 1) as clip-ignored.

### Findings

- **A modulated texel between two UNORM8 levels is not rounded to nearest**: 0.2 × 0.6 (30.6/255)
  reads 30 while 0.6 × 0.6 (91.8/255) reads 92. Such texels are synthesized at delta 1.
- **The default theme is off the 0.2 grid, and its focus border is (0.8, 0.8, 0.8)**: the focus
  box draws no centre, so `style_focus_color` never shows; the box is three rings.
- **An empty `RichTextLabel` emits no `add_set_transform`**, and its hidden scrollbar has a wire id
  but no scissor.

### What G5g does not prove

- Text inside a `RichTextLabel` (its glyph transforms are G5d's measurement on `gate4-rich`).
- `StyleBoxFlat` with `blend_border`, a non-default `aa_size` or a stretch scale, and
  `StyleBoxTexture` with a region: not in the fixture.
- Pixel exactness on another GPU or driver.

## Gate 5e result (2026-10-10)

G5e ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5e", "As built (G5e)") passes: meshes
travel on render-stream/4 end to end. `pnpm render-stream:gate5` (g5b, g5c, g5d, g5e, g5g) is
**101/101** in `artifacts/render-stream/gate5/g5e-v4/` (g5e under `mesh/`; ignored, not
committed). On the same build, rebased onto G5g, G55w and G55a: `build-capture.sh` 16/16 ctests,
gate −1 28/28 (`gate-minus1/g5e-v4/`), gate 0 19/19, gate 1 65/65, gate 2 85/85, gate 3 56/56,
gate 4 185/185 (each `<gate>/g5e-v4/`), and after the last rebase onto G55c's census gate 5.5 55/55
(`gate55/g5e-v5/`); every pure self-test, the receiver self-tests (`applier2`, `codec2`, the ws/http
interop) and every `make_golden.py`/`make_expected.py --check`. One earlier pass scored gate 2 83/85
(`gate2/g5e-v1/`: the known `live-animate` frame-971 pin flake); every later pass was 85/85.

What landed: the mirror's mesh table (own id counter, versions counted as the hook log counts
them, tombstones, `unsupported`/`unknown-mesh`/`unsupported-mesh`, `perturb-vertex` on payloads);
the hook hands each GRM1 surface version it encodes to the mirror; GRM1 payloads in the store
(`.grm`, index lines typed), inline and on the live hub; the receiver's mesh residency (create,
in-place region updates of changed buffers, rebuild on a layout change, custom AABB, free) and
`add_mesh` replay, `drop-mesh-surface` and `stale-mesh`, `applied.json` /4 and state dumps with
`meshes`; `clip-derive.ts` mesh rects; group g5e (`lib/gate5e-checks.ts`).

Images (under the run directory): `mesh/reference/shots/step-{0..9}.png` against
`mesh/receiver/shots/seq-<n>.png`, `mesh/receiver-patch/shots/` and `mesh/receiver-inline/shots/`
(thirty shots, every pixel equal, `DF`'s band included), and the sabotage receivers' shots under
`mesh/sabotage-mesh-*/receiver/shots/` and `mesh/sabotage-mesh-receiver-*/shots/`.

- **Wire.** 1 200 transactions (both sinks and the inline capture) agree with the hook log at
  every frame; 219 settle surface-steps equal the oracle's GPU readback. Mesh tables: ids 1–7 at
  frame 1, `DF` (4) out and `DF2` (8) in at 51, `FM` (7) a named tombstone 71–80, gone at 81.
  `RM`'s `content_version` never changes while `RMS` changes at 21, 31, 41.
- **Bytes and cost.** The store holds 37 GRM1 payloads, 33 004 B over 400 frames (`DF`'s
  displacement repeats every 8 frames, so its hashes do too). Sinks: full 2 603 881 B, patch
  546 737 B, all-inline 2 665 222 B. Live surface bytes per step 3 532 (steps 0–4), 2 642, 2 358,
  2 074, 2 085, 2 085; per step about 31 mesh hook lines and 21 payloads made, median copy
  1.2–3.0 µs and hash 2.6–7.6 µs per payload (`g5e-v3` of the same work: 1.3–5.4 and 2.9–7.4). Each receiver: 765 upload rows, 62 504 B (8 creates,
  402 in-place updates, 3 rebuilds, 350 custom AABBs, 2 frees), 37 fetches (33 004 B) out of band,
  none inline.
- **Sabotages.** freeze-frame @11 at steps 1..9; omit-op vertex region @21 in `RM` {2..9} and `DF`
  {3..9}; perturb-vertex @21 in `RM`/`DF` {2..9}, `P2` {7..9}, `MI` {8,9}; drop-mesh-surface in
  `M2` {0..5}; stale-mesh in `MI` {1..7}, `RM` {2..9}, `DF` {0..9}.

### Findings

- **`DF`'s displacement repeats every 8 frames**, so stale vertices can look right: omitting
  vertex updates from frame 21 leaves `DF` correct at step 2 (frame 28 ≡ 20 mod 8). Q6d's {2..9}
  was wrong; `make_expected.py` now derives the set from its byte model.
- **Host sabotages diverge from the hook log by design** (freeze republishes the frame-10 table,
  perturb-vertex re-hashes), so D15's `mesh-log-divergence` classifies the honest legs and a
  `sabotage-mesh-log-signature` check proves each sabotage's own divergence.

### What G5e does not prove

- Meshes through dropped presentations and live HTTP fetches of GRM1 (G5f).
- Multi-surface `mesh_create_from_surfaces` hashes in the hook log (the mirror carries them).
- Item-rect caching across a custom-AABB change without a redraw (Q1f), browser receivers (gate
  7), and exactness on another GPU or driver.

## Gate 5f result (2026-10-11)

G5f ([protocol/gate5-design.md](../protocol/gate5-design.md) "G5f") passes: live meshes survive a
dropped presentation. No capture-side (C++) or receiver-side (GDScript) change was needed —
`GRC_SABOTAGE=stale-coalesce` and the pin/retire/HTTP-serving machinery are already generic over
resource kind in `rs_live.cpp`/`entry.cpp` (gate 1's and gate 2's own work), and
`fixtures/gate5-mesh` already honours `RS_FIXTURE_START_FRAME`/`_STEP_FRAMES`/`_QUIT_FRAME` the
way gate 1/2's fixtures do — so the whole increment is runner (`run-gate5.sh`'s new `run_g5f`) and
checker (`lib/gate5f-checks.ts`) wiring onto gate 1's G1d stall report and gate 2's G2c2 live-
resource checks, generalized to GRM1 mesh surfaces. `pnpm render-stream:gate5 -- --legs
g5b,g5c,g5d,g5e,g5f,g5g` is **116/116** in `artifacts/render-stream/gate5/20261011T040840Z/` (g5f
under `mesh/<leg>/`; ignored, not committed). On the same build: gate −1 PASS
(`gate-minus1/20261011T042351Z/`), gate 0 PASS (`gate0/20261011T042509Z/`), gate 1 65/65
(`gate1/20261011T042826Z/`), gate 2 85/85 (`gate2/20261011T043831Z/`) — no regression.

**The live timeline** (gate 1's and gate 2's pattern, reused unchanged): S=300, N=60, the mesh
fixture's own `LAST_STEP`=9, quit=851. Four legs, each its own host and receiver on
`fixtures/gate5-mesh`: `live-mesh` (fresh cache), `live-mesh-warm` (a new host and receiver on
`live-mesh`'s cache, mode warm), `live-mesh-stall` (`RS_RECEIVER_STALL=1:2000` after step 1), and
`sabotage-mesh-stale-coalesce` (the same stall, host `GRC_SABOTAGE=stale-coalesce` from step 1's
frame). A fifth rendered run, `reference-live`, is the mesh fixture at this *same* live timeline
with the capture extension absent — the ground truth every leg's shots are compared against.

| Leg | Class | Exit |
| --- | --- | --- |
| `live-mesh` | `success` | 0 |
| `live-mesh-warm` | `success` | 0 |
| `live-mesh-stall` | `success` | 0 |
| `sabotage-mesh-stale-coalesce` | `pixel-mismatch` | 0 |

Measured stall timing (both stalling legs, independently): send frame 367, credit frame 489 (122
frames at a 2000 ms request — matching memory `rs-g1d-stall-facts`'s gate-1 numbers almost
exactly), the post-stall shot landing in step 3's window (step 2's window lies wholly inside the
stall and has no shot at all, by design). `live-mesh-stall`'s recovery transaction (seq 307, frame
489) resolves to exactly the host's own full file recording at frame 489 — the newest state, not a
missed one. `sabotage-mesh-stale-coalesce`'s recovery transaction (seq 306, same frame 489) is
labelled `stale_from: 368` and does **not** equal the host's full recording there; its step-3 shot
mismatches `reference-live` exactly in `DF`, `Marker` and `RM` — every region `expected.json`'s
per-step `fresh` table says steps 2 and 3 (both swallowed by the stall) touch, not only `DF`, the
one region that changes every frame.

**Checks** (`lib/gate5f-checks.ts`, all passing): `live-tap-equals-received`,
`live-resolves-to-recording` (2202 live transactions equal the host recordings),
`pins-bounded`/`obsolete-retired` (replayed from the pin/retire lines against the full recording's
`okImageHashes ∪ okMeshHashes`, since the fixture also serves TEXG and the engine's hue strip over
the same mechanism; retained max 11–12 hashes, 26.5–26.8 KB), `http-gets-match-fetches`
(112 GETs total: `live-mesh` 38, `live-mesh-warm` 0, `live-mesh-stall` 37, every one a verified 200
with the right headers), `gets-advertised`, `fetch-before-applied`, `mesh-fetches-latest-only`
(during the stall no `DF` hash is fetched; the first post-stall transaction's `DF` surface equals
the host's newest), `receiver-vs-reference` (`live-mesh` 10/10, `live-mesh-warm` 10/10,
`live-mesh-stall` 9/9, `sabotage-mesh-stale-coalesce` 8/8 — each leg's own stall-window step
excluded, a DF-only difference tolerated when the wire's own state at that frame equals the host's
full recording there), `stale-coalesce` (the region set above), `warm-host-no-gets` (0 GETs, 38
cache hits, shots equal `reference-live`'s), and `leg-class-*` for all four legs.

Images (under the run directory): `mesh/reference-live/shots/step-{0..9}.png` against
`mesh/live-mesh/receiver/shots/seq-<n>.png`, `mesh/live-mesh-warm/receiver/shots/` and
`mesh/live-mesh-stall/receiver/shots/` (step 2 absent, swallowed by the stall), and
`mesh/sabotage-mesh-stale-coalesce/receiver/shots/seq-306.png` (step 3, the stale shot) against
`mesh/live-mesh-stall/receiver/shots/seq-307.png` (step 3, the healthy recovery) and
`mesh/reference-live/shots/step-3.png`.

### Findings

- **DF's band nature (gate5-design.md Q6d: "compared leg to leg only") means even an unstalled
  leg's shot can land a host frame off its nominal settle frame.** `live-mesh`'s step-5 shot (DF's
  rebuild step: free + create + add, one call more than DF's usual two) landed at frame 608, one
  frame past the window's `from` (607), purely from round-trip timing around the heavier
  transaction — no stall involved. A per-step static reference image is only pixel-exact for a
  shot taken at DF's *exact* frame, so a checkpoint whose only mismatching region is `DF` is judged
  `benign` against the wire itself (the connection's tapped resolved state at the shot's actual
  frame equals the host's own full file recording there, `statesEqual`), not against a fixed
  region allow-list. See memory `rs-g5f-live-mesh-facts`.
- **The stale-coalesce sabotage's effect is not confined to the continuously-animating region.**
  The stale snapshot it resends is from right after step 1, so step 2's and step 3's own changes
  (both swallowed by the 1:2000 stall) are stale too — `RM` and `Marker`, not only `DF`. The
  expected mismatching-region set is derived from `expected.json`'s per-step `fresh` table unioned
  over `StallReport.steps_applied_during`, never hardcoded to one region.
- **Pins, retirement and GET-advertising must union image and mesh hashes.** The mesh fixture also
  serves two ordinary textures (TEXG and the engine's default-theme hue strip) over the identical
  resource mechanism; gate 2c2's hash extractors default to textures only, and G5f's own checks
  pass `okImageHashes(t) ∪ okMeshHashes(t)` into the generalized `pinsReport`/`unadvertisedGets`
  (gate2c-checks.ts gained an optional hash-extractor parameter, backward compatible: gate 2's own
  checks keep their default).

### What G5f does not prove

- Resource pinning or retirement at a budget tight enough to actually evict something (the mesh
  fixture's live retained set never exceeded 12 hashes / 26.8 KB over an 851-frame run).
  Reconnect, resync, or a killed live-mesh receiver (gate 1's G1d already proves the mechanism;
  G5f reuses it unchanged).
- A second resource kind changing every frame at once (only `DF` churns continuously here); a
  frame-exact ground truth for a region whose *reference* also depends on continuous time (G5f's
  `benign` rule needs the wire, not a synthesized image, specifically because of this).
- Browser receivers (gate 7), non-loopback serving and late join (gate 8), and exactness on
  another GPU or driver.

## Gate 5 summary

Gate 5 passes: every increment from G5a through G5g lands, and `pnpm render-stream:gate5 --
--legs g5b,g5c,g5d,g5e,g5f,g5g` is **116/116** in
`artifacts/render-stream/gate5/20261011T040840Z/`, on the same build as gate −1 PASS
(`gate-minus1/20261011T042351Z/`), gate 0 PASS (`gate0/20261011T042509Z/`), gate 1 65/65
(`gate1/20261011T042826Z/`) and gate 2 85/85 (`gate2/20261011T043831Z/`). Every leg is at its
expected class; images are under each leg's `shots/` in the run directory, and the references are
`reference/shots/step-{0..9}.png` (`mesh/reference/shots/` and `mesh/reference-live/shots/` for
the mesh fixture's batch and live timelines, `style/reference/shots/` for the stylebox fixture).

What it proves, by increment:

- **G5a.** Calibrator 7 hooks eight geometry/mesh calls (73 hooks); whole copies are taken at the
  hook on the calling thread, and the mesh hook log carries per-surface version, hash and buffer
  columns distinct from the image columns (Q3d).
- **G5b.** render-stream/4 carries every immediate-geometry op (circle, line, multiline, nine-patch,
  polygon, polyline, primitive, rect, triangle-array, set-transform, clip-ignore) as the engine's
  own call arguments, float32-exact against an independent rasterizer (`geometry-raster.ts`):
  760 commands compared, 0 using their 2-ulp allowance.
- **G5c.** `fixtures/gate5-mesh`'s eight meshes (an `ArrayMesh`, two raw dynamic meshes, a
  `Polygon2D`'s own mesh, a loaded resource and a freed-but-named tombstone) census exactly against
  the mesh oracle's GPU readback (219 surface-steps) and a same-build repeat (budget 0).
- **G5d.** render-stream/4 landed for every gate: `add_set_transform` and `add_clip_ignore` travel
  as commands, so G3d's clip-ignore variant and G4d's `RichTextLabel` legs now classify `success`;
  the sabotages (freeze-frame, perturb-vertex, omit-op) and the receiver sabotages
  (ignore-set-transform, ignore-clip-ignore) each mismatch exactly their predicted regions.
- **G5e.** Meshes travel on render-stream/4 end to end: the mirror's mesh table, GRM1 payloads in
  the store/inline/live, the receiver's in-place residency (create, region update, rebuild, free),
  `drop-mesh-surface` and `stale-mesh`. 1200 transactions agree with the hook log; 37 GRM1 payloads
  (33 004 B) serve 765 receiver upload rows (62 504 B: 8 creates, 402 in-place updates, 3 rebuilds,
  350 custom AABBs, 2 frees) three ways (full sink, patch sink, all-inline) identically.
- **G5g.** Nine-patch and `StyleBoxFlat` (sharp, bordered, rounded, shadowed, skewed), the default
  theme's `Panel`, `TabBar`'s flipped draw, and a focused `RichTextLabel`'s clip-ignored focus box:
  324 commands float32-exact, 100 nine-patches equal, a stylebox band budget of 0.
- **G5f.** Live meshes through a dropped presentation: a receiver that stalls for two seconds on
  a continuously-deforming mesh resource catches up to the newest `DF` surface in one coalesced
  transaction (not a stale one), and `stale-coalesce` classifies `pixel-mismatch` in exactly the
  regions the swallowed steps touch. See "Gate 5f result" above.

Costs measured in this run:

- **Geometry (G5b).** Capture hook census: `circle` 4, `line` 15, `multiline` 3, `nine_patch` 2,
  `polygon` 7, `polyline` 8, `primitive` 4, `rect` 24, `set_transform` 6, `triangle_array` 4,
  `texture_2d_create` 3. Full sink 4 148 430 B, patch 259 717 B over 400 frames.
- **Meshes (G5c/G5e).** `DF`, the one every-frame mesh, logs 150 hook lines over the batch
  timeline (median copy 2.0 µs, hash 5.9 µs) and 1049 after its step-5 rebuild (`DF2`); the store
  holds 37 GRM1 payloads (33 004 B) because `DF`'s displacement repeats every 8 frames, so its
  hashes do too. Full sink 2 603 881 B, patch 546 737 B, all-inline 2 665 222 B (400 frames). Live
  surface bytes per step: 3 532 B (steps 0–4), 2 642, 2 358, 2 074, 2 085, 2 085.
- **Styleboxes (G5g).** Vertex/index counts exact per Q1h: `SF` 8/18, `SB` 24/66, `SR` 108/318,
  `SS` 32/84, `SK` 24/66, `DP` 72/210, `FL` 24/66, `RT` 144/432 — a stylebox band budget of 0 over
  every repeat.
- **Live meshes (G5f).** Retained store: 11–12 hashes, 26.5–26.8 KB max over an 851-frame live
  run. GETs: 38 cold, 0 warm, 37 after a 2 s stall (122-frame gap). See "Gate 5f result" for the
  stall timing and the stale-coalesce region set.

### What gate 5 does not prove

- Multimesh and GPU particles (typed `unsupported`, deferred to gate 8's census and gate 6).
- A resource budget tight enough to actually evict a mesh surface or texture under load (gate 6).
- Lazy hashing, spill-to-disk, cache eviction and parallel fetches at scale (gate 6).
- Browser receivers and their HTTP caches (gate 7).
- Non-loopback serving, late join, authorization beyond a bearer token, and the target game's own
  meshes, textures, shaders and materials at scale (gate 8).
- Exactness on another GPU or driver than the RTX 2060 this experiment runs on.

