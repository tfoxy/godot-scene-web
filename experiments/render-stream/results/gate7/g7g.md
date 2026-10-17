## Gate 7g result (2026-10-17)

G7g ([protocol/gate7/g7g.md](../../protocol/gate7/g7g.md); gate7-design.md Q5, Q7, Q8) extends the
GSW canvas receiver and the web export to gate 6: the scene (ScrollContainer, RichTextLabel,
CanvasLayers, StyleBoxFlat, ShaderMaterial, CanvasItemMaterial, a mesh, a moving sprite,
top_level) and the HD fixture's nine cells at `native` (1920x1080) and `half` (960x540,
stretch 0.5, font oversampling 0.5), plus the presentation hazard and the two gate-6-only
sabotages. **`g7-6` passes on `gsw` (file 38/38, live 25/25) and on `web` on both cores (file
36/36 GDScript and Rust, live 26/26 GDScript and Rust); every earlier `gsw` group (`g7-0`
through `g7-55`, file and live) still passes under the rebuilt core.**

Per the re-scoped re-run policy (docs commit `5eb0ee28`), this increment reran what its diff
reaches — the GSW receiver (`rs-core/src/apply`, `web/gsw-rs`) and gate 6's checkers — on every
`gsw` group (file and live, since the rebuilt core is shared across all gates) and on `g7-6`'s
web export on both cores (new this increment). It did **not** re-sweep `g7-0`..`g7-5`/`g7-55` on
the web/GDScript core, since the GDScript receiver was untouched; those groups were nonetheless
captured once as a side effect of an earlier, now-superseded full-sweep attempt (see "Deviations"
below) and are reported for completeness, not as this increment's gating evidence.

```bash
# gsw, file legs, all groups (reuses existing sources-made/<gate>, skips --make-sources):
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-0,...,g7-6 --source gate0=...,...,gate6=... --out <dir>
# gsw, live legs:
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-1,g7-2,g7-5,g7-55,g7-6 --receiver gsw --out <dir>
# web, g7-6 only, both cores, file:
bash experiments/render-stream/scripts/run-gate7.sh --legs g7-6 --receiver web [--web-core rust] --source gate6=... --out <dir>
# web, g7-6 only, both cores, live:
bash experiments/render-stream/scripts/run-gate7.sh --live --legs g7-6 --receiver web [--web-core rust] --out <dir>
```

**What was built**

- **`web/gsw-rs/src/lib.rs`: presentation.** `set_window(w, h)` names the window the receiver
  presents into (the native leg's `--resolution`, else 640x360); `presentation_json()` reports how
  the session's presentation was adopted. In the session's own presentation (window equals
  `presentation_size`) the receiver uses the host's `host_final_xform` bit for bit; in another
  window (the hazard) it computes `canvas_items_stretch` — a port of
  `Window::_update_viewport_size` (window.cpp:1190-1307): the aspect rule picks the viewport and
  screen sizes (both floored), `integer` scale multiplies by a whole factor, the margin centres
  the screen rect, and the root's oversampling is `min(screen/viewport)`. `ignore-presentation`
  disables the stretch outright. Receiver-typed `presentation-mismatch` (window != declared
  presentation) and `oversampling-mismatch` (compared as f32, the wire's own precision) mirror
  receiver.gd's own checks; `presentation_check` stays `null` on a session that declares none
  (pre-/6).
- **`rs-core/src/apply/mod.rs`: `canvas_attach` and `canvas_stacking_sets`** per transaction,
  mirroring `rs_applier.gd _apply_canvas`: an attach/remove is one `canvas_attach`; an attached
  canvas whose (layer, sublayer) differs from what was last set (a fresh attach starts at (0,0))
  is one `canvas_stacking_sets`, none under `ignore-canvas-stacking`. Plumbed through gsw-rs
  `TxEvidence` and `evidence.ts`'s `resources` (previously hardcoded `null` for both fields).
- **Gate scripts**: `lib/gate7-gsw-g6.ts` (19 gsw legs of g6a/g6h/g6b, the 23 kept receiver checks,
  the Q7 plans), `lib/gate7-g6-checks.ts` (`presentationCheck`, `q7RegionsReport`, shared by both
  browsers and by file and live legs), `check-gate6.ts`'s `buildGate6Report` exported for reuse,
  `check-gate7.ts`'s gate6 wiring (gsw judging plus `presentation-check@web`), `run-gate7.sh`'s
  gate 6 source-making (`--legs g6a,g6h,g6b`) and `--live`'s `g7-6:6:g6l`, `gate7-web-legs.ts` and
  `gate7-live-legs.ts`'s `timings.json backing_store` (every canvas's size, DPR, inner size),
  `gate6l-checks.ts`'s browser adaptation.
- **Q7 masks** (`gsw-tolerance.ts`, `fixtures/gsw-tolerance.json`): `gate6`/`gate6-refused` (one
  raster per shot from `gate6-expected.ts rasterOfShot`), `gate6-hd-native`/`gate6-hd-half` (one
  raster per shot from `gate6h-checks.ts rasterOfShotHd`, scaled to each presentation),
  `gate6-animate` (the default model with SC/LB/CD/TR/RT forced `delta1`).

**Results** (`artifacts/render-stream/gate7/g7g/final2/result.json` for the gsw and web/GDScript
file groups and `g7-dev`/`g7-bench`; `artifacts/render-stream/gate7/g7g/final-rust/result.json`
for `g7-6` web/Rust file; `artifacts/render-stream/gate7/g7g/live-gsw/result.json` for gsw live;
`artifacts/render-stream/gate7/g7g/live-web-gdscript/` and `live-web-rust/` for `g7-6` web live;
sources in `artifacts/render-stream/gate7/g7g/final/sources-made/`):

| Group | `gsw` file | `gsw` live | `web` file (GDScript) | `web` file (Rust) | `web` live (GDScript) | `web` live (Rust) |
| --- | --- | --- | --- | --- | --- | --- |
| `g7-0` | 25/25 | — | 22/22 | — | — | — |
| `g7-1` | 30/30 | 38/38 | 30/30 | — | — | — |
| `g7-2` | 39/39 | 35/35 | 35/35 | — | — | — |
| `g7-3` | 32/32 | — | 36/36 | — | — | — |
| `g7-4` | 71/71 | — | 74/74 | — | — | — |
| `g7-5` | 44/44 | 19/19 | **40/49** | — | — | — |
| `g7-55` | 51/51 | 19/19 | 49/49 | — | — | — |
| `g7-6` | **38/38** | **25/25** | **36/36** | **36/36** | **26/26** | **26/26** |

Bold cells are this increment's required, gating evidence (the GSW sweep plus `g7-6`'s web export
on both cores). The plain cells (`g7-0`..`g7-5`/`g7-55` on `web`/GDScript) are left over from an
initial full-sweep attempt made before the re-scoped policy landed (see "Deviations"); they are
unchanged by this increment and reported only for completeness.

**`g7-5`'s `web`/GDScript 40/49 is pre-existing and out of scope.** All nine failures are the
mesh group's `mesh_surface_update_index_region`, typed `unsupported` by the web/GDScript
receiver (memory `g7b-web-export-facts`: "4.5.1 WebGL index-region bug"). G7g did not touch
gate 5 or the GDScript receiver; this is the same gap G7b/G7xw already carry on that core.

**Q7 regions (`q7-regions-g6@gsw`, honest legs only, against the rendered reference):**

```
640x360 (75 shots): decided 0 px, delta1 290248 px (max 1), undecided 468996 px (max 204)
  by region: BT 269715/1  HB 600/1  HU 3840/1  LB 7203/1  LE 301455/1  MS 59420/1  PB 2825/1
             RF 19564/204  RT 59090/1  SC 35532/1
1920x1080 (30 shots): decided 0 px, delta1 1045224 px (max 1), undecided 1621222 px (max 1)
  by region: BT 970974/1  HB 2160/1  HU 13824/1  LB 27324/1  LE 1086198/1  MS 214148/1
             PB 10916/1  RT 212724/1  SC 128178/1
960x540 (45 shots): decided 0 px, delta1 410001 px (max 1), undecided 593712 px (max 1)
  by region: BT 347787/1  HB 8100/1  HU 4536/1  LB 15876/1  LE 392058/1  MS 76968/1
             PB 4920/1  RT 109404/1  SC 44064/1
```

Every decided pixel is exact at all three presentation sizes. `RF` (the refused variant's region)
is the only region with a max delta above 1 (204, inside its undecided mask — the refused draw
list differs in content, not just rounding). `q7-pixel-policy@gsw` passed over the full set: 150
shots, decided exact, 1 745 473 px in `delta1` masks, 2 683 930 px in undecided masks.

**Sabotages.**

- `leg-class-sabotage-receiver-ignore-canvas-stacking@gsw`: pixel-mismatch exactly at
  `step-9:HU`/`frame-93:HU` — the unstacked HUD layer draws over the root canvas at layer −1, the
  same set G6b's native run predicted and matched.
- `leg-class-sabotage-receiver-ignore-presentation@gsw`: `unsupported`; all 15 shots differ in
  every region (the stretch stays disabled whatever the session declares).
- `presentation-hazard-measured@gsw`: `unsupported`; against `reference-hd-half` every flat region
  (AN, BG, CD, CM, MS, Marker, NP, SM, TR) is equal across all 15 shots, and every text/AA region
  differs and is counted (HB 3 780, HU 3 564, BT 13 671, LB 35 397, LE 28 185, …) — the hazard's
  text rasterized at oversampling 1 is the evidence for D1/D2, matching G6b's native numbers.

**Presentation-check.** `presentation-check@gsw`: 19 legs (12 at 640x360, 2 at 1920x1080, 5 at
960x540), every backing store equal to `presentation_size` (DPR 1) except the hazard, whose
backing store is its 960x540 window; `presentation_check` is `ok` on every leg but the hazard and
`ignore-presentation` (`mismatch`). `presentation-check@web`: same 19-leg pattern on GDScript;
5-leg (640x360 only, g6l has no HD leg) pattern on both web live runs.

**Compositor.** The five `compositor-equals-readback-g6-*@gsw` checks (scene, animate, refused,
hd-native, hd-half) are all exact: the page's screenshot equals its last shot.

**Re-verified.**

- 38 pure self-tests (`scripts/test/self-test-*.ts`): 36 ran to completion and passed; the other 2
  (`self-test-record-digest.ts`, `self-test-rs-core.ts`) need `--inputs` and were separately run
  against `…/g7d-r1/g7-bench/inputs/inputs.json`, both passing.
- `cargo test --offline` in `rs-core`: 35/35. `web/gsw-rs` has no native unit tests (wasm-only,
  same as `main`).
- `rs-core-check goldens`, native and wasm-in-Node: golden-2 through golden-7 and cross-version,
  587/587 checks.
- `gsw-tolerance.ts --check`: byte-identical.
- Every `gsw` group `g7-0`..`g7-6`, file and live (table above): all pass.
- `g7-6` web export, both cores, file and live (table above): all pass.

**Deviations from plan.**

- An initial full sweep (`g7-0`..`g7-6` plus `g7-dev`/`g7-bench`, both receivers, before the
  re-scoped re-run policy landed) hit a **disk-full window** mid-`g5e` (machine-wide, not caused
  by this increment) that truncated `sources-made/gate5` and crashed the leg-replay step. Fixed by
  regenerating `sources-made/gate5` from scratch (its own checker: 116/116) and resuming with
  explicit `--source` flags for the five already-good sources, avoiding a second full
  source-remake. A rebase onto `main` (G7xwl landed mid-run) then invalidated every
  `gate7-source.json`'s recorded `git_commit`; regenerated with `gate7-tool.ts source-provenance`
  (no recapture needed, since `git_dirty_digest`/extension/template sha256 were unchanged).
- After the re-scoped policy arrived mid-sweep, the already-running full sweep was let finish
  (per "let the current group finish") rather than killed destructively; its `g7-dev`/`g7-bench`
  and `g7-0`..`g7-5`/`g7-55` web/GDScript results are reported above for completeness but are not
  this increment's gating evidence.
- `g7-6`'s `web`/GDScript live leg (`live-web-gdscript`) failed `motion-monotonic@web` once (a
  3-frame cadence gap despite a 7.1 ms hold — a parallel agent was running gate 6 timing legs on
  the same machine at the time) and passed 26/26 on the allowed single rerun.
- Disk-full briefly machine-wide during this increment's own run (coordinator-flagged); recovered
  before any of G7g's own artifacts were written in that window — the one corruption it caused
  (`sources-made/gate5`) is the one above. Superseded dev evidence (`gsw-dev1`, `gsw-dev2`,
  `dev-src`, `live-dev1`) and the first crashed sweep's partial leg-replay directories were deleted
  once the final runs superseded them.

**What G7g does not prove:** `g7-5`'s web/GDScript mesh-index-region gap (pre-existing, tracked by
G7b/G7xw, not this increment's to close), a phone leg for gate 6 (no device run requested), and a
full web/GDScript re-sweep of `g7-0`..`g7-5`/`g7-55` under the now-rebased tree (left to the next
milestone sweep per the re-scoped policy).
