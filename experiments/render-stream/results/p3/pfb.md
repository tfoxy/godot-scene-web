# PFB: a RendererRD host's particle colours on the GL receivers (2026-10-28)

PM7 (74e58b5d) recorded the first STS2 stream with GPU particles on the wire (`pm7-a12-1`, /12) and
found that GSW (PM6b) drew the main menu's fog far too bright: the menu fell from 31.2–31.5 to
23.1–23.3 dB. A native GLES3 receiver made to compile STS2's process shader (`emit_subparticle`
stubbed) drew the same bright fog (23.5), and a Forward+ native receiver drew it right (40.9–41.7).
PFB finds why and fixes it for every GL-style receiver.

The rules are in [render-stream-12.md](../../protocol/render-stream-12.md), "As built (PFB):
decisions" (7 rules). Nothing changes on the wire.

**Headline.**

- **Root cause: the host's backend uploads particle colours linearized.** RendererRD (Forward+ and
  Mobile) fills a particles material's uniform buffer with `p_use_linear_color` true, always
  (`particles_storage.cpp:1768`), so `ParticleProcessMaterial.color`, a `Color` uniform, goes
  through `Color::srgb_to_linear()` (`variant_converters.h:208-213`). GLES3 converts nothing. The
  2D canvas is not linear on either backend (`hdr_2d` is off: STS2's `project.godot` sets no
  `rendering/viewport/hdr_2d`), so nothing converts it back. STS2's fog emitters have
  `color` (0.29, 0.35, 0.39, 0.44) through an additive `CanvasItemMaterial`: the game adds
  (0.068, 0.10, 0.12) × 0.44 per cloud, the GL receivers (0.29, 0.35, 0.39) × 0.44, about four
  times as much.
- **Proven on the stock template** (`fixtures/gate8-ptc`, g8pt's new `ptc/*` legs): a Forward+
  4.5.1 host draws `color` (0.5, 0.25, 0.75) as (54, 13, 133) and gl_compatibility as
  (127, 63, 191); a colour ramp texture of the same colour is (127, 63, 191) on both.
- **The fix needs no wire change.** The session record already carries `engine.rendering_method`.
  GSW (rs-core `particles::describe`) and the native and web planners (only when the receiver
  itself renders with gl_compatibility) convert a particles material's `color` parameters as the
  host did.
- **STS2 `pm7-a12-1` menu on GSW: 23.1–23.3 → 40.3–41.0 dB**, against the Forward+ probe's
  40.9–41.7 and the no-particles baseline's 31.2–31.5. Map and combat are unchanged.

## Diagnosis

The brief's hypotheses, cheapest first:

1. **`hdr_2d` (linear 2D blending).** Refuted. The recovered STS2 `project.godot` has no
   `rendering/viewport/hdr_2d`, and linear-space blending would make the fog *brighter* on the
   host, not darker.
2. **A colour applied in another space.** Confirmed, in the uniform upload, not the blend. The
   recording's menu has three drawn emitters: 31 (sparkles, amount 200) and 32/33 (fog, amount 40,
   lifetime and pre-process 400 s, a 252x700 seven-frame sheet through a `CanvasItemMaterial` with
   `blend_mode` add and `particles_animation` 1x7). Their process materials share MegaDot's one
   uber `particles` shader, whose `color_value` is `uniform vec4 color_value : source_color`.
   The materials set `color_value` as a `Color`: (0.278, 0.839, 0.878, 1) on the sparkles,
   (0.290, 0.353, 0.388, 0.439) and (0.291, 0.353, 0.388, 1) on the fog. RendererRD linearizes it;
   GLES3 and GSW's port of GLES3 do not. That both GL-style paths, written independently, agree
   with each other and not with the host is what a host-side upload difference predicts.
3. **Amount, lifetime, sub-emitters.** Not the cause. RD and GLES3 run the same
   `_particles_process`, pre-process loop and restart test (`particles_storage.cpp` on both),
   and no menu emitter has a sub-emitter (`sub_emitter_mode` 0, `subemitter` null). With only the
   colour conversion changed, GSW reaches the Forward+ probe's dB.
4. **Blend mode / CanvasItemMaterial.** Both backends set additive blending the same way
   (`GL_SRC_ALPHA, GL_ONE`); the canvas material's uniform set is the sRGB one on RD without HDR.

## What changed

- **rs-core** `apply/particles.rs`: `host_linearizes_particle_colors(rendering_method)`
  (`forward_plus`, `mobile`), `srgb_to_linear` (Godot's, in its float precision),
  `host_uniform_value`; `describe(state, store, linear_colors)` lists a `color` uniform's RGB
  linearized. Unit tests `pfb_tests` (3).
- **gsw-rs** `particles_sync` passes the session's flag; receiver sabotage `gl-particle-colors`.
- **rs-core-capi** `Planner::{gl_compatibility, host_linear_colors}`: a `particles`-mode material's
  `color` parameters are set linearized when both hold; `core.rs` sets `host_linear_colors` from
  the session; `rsc_set_gl_compatibility` (C API) and the adapter (`rs_core_ext.cpp`) set the
  receiver side from `RenderingServer.get_current_rendering_method()`, so a Forward+ receiver is
  never converted twice. `particles_resources.colors_linearized` (only when non-zero). Receiver
  sabotage `gl-particle-colors` (also listed in `receiver.gd` and `rs_rust_applier.gd`).
- **Fixture** `fixtures/gate8-ptc` and **g8pt legs** `ptc/reference-gl`, `ptc/reference-fwdplus`,
  `ptc/capture` (armed /12 on the Forward+ host), `ptc/receiver`,
  `ptc/sabotage-gl-particle-colors/receiver` (`G8PT_ONLY_PTC=1` runs only those); checks in
  `scripts/lib/gate8-ptc-checks.ts`. GSW's g7-8 replays the two receiver legs
  (`gate7-gsw-g8.ts`); gate 7b's approximate regions skip `g8pt/ptc/` (its particles hold still).

## Checks (g8pt ptc)

| Check | What it proves | Result (local) |
| ----- | -------------- | -------------- |
| `ptc-host-colors` | the stock engine: Forward+ draws each cell as the linearized model, gl_compatibility as given, the ramp the same on both (within 2 levels) | pass: C_MIX gl (127,63,191), Forward+ (54,13,133); C_ADD (127,102,76) / (91,68,55); C_RAMP (127,63,191) on both |
| `ptc-validate` | both sinks of the Forward+ capture pass both validators; its host is forward_plus | pass |
| `ptc-receiver` | the native gl_compatibility receiver matches the Forward+ reference within 2 levels at every cell and the background, both shots | pass: (54,12,133), (92,68,55), (127,63,191) |
| `ptc-receiver-catches-gl-particle-colors` | the pre-PFB receiver fails `ptc-receiver` | pass: C_MIX (127,63,191) vs (54,13,133), off by 73 |
| `ptc-receiver@gsw` | GSW matches the Forward+ reference | pass: (54,13,133), (92,68,55), (127,63,191) |

**Fails before the fix.** The sabotage receiver is exactly the pre-PFB receiver (on native, web and
GSW), and it fails `ptc-receiver` by 73 levels.

## STS2 (`pm7-a12-1`, replays only, no game launch)

`compare.py` against the game's own shots; three shots per scene. GSW is this tree's bundle
(`build.json` sha `3a5771d6…`, wasm `ee317caf…`, port 8801), C3 `replay-gsw.sh`, output
`legs/pm7-a12-1/replay/pfb-gsw-1`.

| scene | GSW no particles (PM6b sabotage) | GSW PM6b (before) | **GSW PFB (after)** | Forward+ probe (PM7) | native GL / web (before = after) |
| ----- | -------------------------------- | ----------------- | ------------------- | -------------------- | --------------------------------- |
| menu | 31.47/31.43/31.23 | 23.11/23.21/23.28 | **40.25/40.70/40.97** | 40.88/41.35/41.74 | 31.44/31.40/31.20; 31.41/31.40/31.22 |
| map | 65.47/65.53/65.52 | 65.47/65.53/65.52 | **65.47/65.53/65.52** | 72.67/72.66/72.64 | 64.10/64.18/64.16; 65.56/65.62/65.60 |
| combat | 60.85/60.83/60.88 | 60.85/60.83/60.88 | **60.85/60.83/60.88** | 84.08/83.74/82.92 | 56.21/56.21/56.22; 60.85/60.82/60.90 |

Pixels more than 16 levels off on the menu: 219,213 / 219,749 / 223,930 before, 15,768 / 13,338 /
12,679 after (Forward+ probe 8,073 / 6,286 / 5,278). The rest of GSW's menu gap to the probe is
GSW's approximations of these emitters (PM6b rule 8; the builtin key is the shared uber shader's,
so the fog's sphere emission of radius 5 runs as a box of extents 1).

**Native and web are unchanged on STS2**: they still draw none of its emitters, because MegaDot's
Vulkan-generated process shader calls `emit_subparticle`, which GLES3 does not declare (PM7). With
the shader made to compile they would now take the host's colours (the planner path is the one
`ptc-receiver` proves on the stock template); shipping that stub is a separate increment.

## Forward+ vs GL on map and combat

No. Drawing the particles changes nothing at the map and combat shots on either backend (PM7), and
the gap there is not a colour rule: it is last-bit rounding. Against the game's shots, the native GL
receiver has 116,377 (map-1) and 663,902 (combat-1) pixels off by any amount but only 124 and 293
off by more than one level (max 3); the web export 92,749 and 270,844 (161 and 65); the Forward+
probe 21,040 and 1,538 (81 and 4). So 64/56 dB versus 72.7/83 dB is GLES3's ±1-level rounding over
large areas (its RGB10_A2 root target and blend quantization, gate 7's `delta1` class), not missing
content. A receiver that matched the host's renderer would close it; it is worth up to ~8 dB on map
and ~23 on combat but no visible content.

## Validation

- **rs-core unit tests** `pfb_tests` (3: the backends, Godot's `srgb_to_linear`, only colours
  move and alpha never); `cargo test` of rs-core, rs-core-capi and gsw-rs pass.
- **Smoke tier, locally** (`validate-increment.sh --only` every correctness run of the plan, before
  the rebase): **18 of 18 pass** — pure, the three cargo runs, native gates −1, 0, 1, 2, 3, 4, 5,
  55 and 8 (gate 8 **244 of 244**, the four `ptc-*` checks included), hc1, g7-gsw and g7-web-rust
  (g7-0) and the g7-1 live smokes. `bench-instr` (no valgrind locally) and `native-rust-gate6`
  (timing) were left to the remote job and the milestone sweep.
- **Full tier, once, remotely**:
  [run 40806257199](https://github.com/tfoxy/godot-scene-web/actions/runs/40806257199), **18 of 19
  runs pass** (bench-instr within 0.61% of its baseline). The one failure is `g7-web-rust`'s g7-8
  shard: `mm-reference@web` and `web-repeat-identical@web` on g8mm's `C_FLIP` flipbook (the two web
  runs' own shots differ), the known hosted-runner g7-8 web flake. The ptc checks passed there on
  every receiver (the runners' lavapipe runs the Forward+ legs): `ptc-host-colors`,
  `ptc-validate`, `ptc-receiver`, its catch, and `ptc-receiver@web` and its catch.
- **Locally, after the rebase onto GRH (86de9ab9)**: `RS_VALIDATE_GROUPS=g7-8
  validate-increment.sh --only cargo-rs-core,cargo-gsw-rs,g7-web-rust --tier full` **3 of 3
  pass** (g7-8 rebuilds gate 8's sources, so g8pt with the ptc legs ran again on the rebased tree;
  `mm-reference@web`, `web-repeat-identical@web` and `ptc-receiver@web` pass); the runs the remote
  refuses, `RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --only g7live-gsw,g7live-web-rust
  --tier full`: **2 of 2 pass**.
- **After the last rebase**, onto HC4a (667687af, the capture's persistent tables) and GLJ
  (2361d541, GSW's payload store): the capture, the receiver extension and the GSW bundle were
  rebuilt; `G8PT_ONLY_PTC=1 run-gate8.sh --legs g8pt` passed all four `ptc-*` checks, GSW's ptc legs
  drew the same pixels, and `cargo-rs-core`, `cargo-rs-core-capi` and `cargo-gsw-rs` passed.
- **GSW on the ptc legs** (`gate7-tool.ts gsw-legs --group g7-8 --only g8pt/ptc/...`): the honest
  leg draws (54,13,133), (92,68,55), (127,63,191); the sabotage (127,64,191), (128,102,77),
  (127,63,191). In the remote run GSW's g7-8 (`g7-gsw`) passed, `ptc-receiver@gsw` included.
- `tsc`: no new error (the pre-existing `live.ts` `transport_skip` error is on `main` too).
- Evidence: `artifacts/render-stream/p3/pfb/` (`validate/`: the local and remote summaries, the
  remote g7-8 web verdict, the smoke's gate 8 result.json; `g8pt-ptc/`: the step-1 shots of every
  ptc leg and GSW's; `sts2/`: `compare.txt`, `compare-pm7-a12-1.json`, and the menu crop sheet
  `fog-game-fwdplus-gswpm6b-gswpfb.png`: game, Forward+ probe, GSW PM6b, GSW PFB).

## Out of scope

- The `emit_subparticle` stub for native and web on STS2 (PM7 follow-up 1's other half).
- A `color_conversion_disabled` hint on a Forward+ host's custom process shader (would be
  over-converted; no receiver parses hints) and a `source_color` default the host never set (not
  converted; `ParticleProcessMaterial` sets every colour).
- The timing groups (the milestone sweep's).

## Time

About 1 h 40 min of implementation (22:39 to 00:20 with the diagnosis, the fixture, the checks
and the STS2 replay), and about 3 h of validation wall time, mostly waiting on other agents' timing
legs: the local smoke (1 h 29 min), the remote full tier (about 1 h 15 min, beside it), the
post-rebase g7-8 rerun (50 min) and the g7-1 live runs (13 min).

## Memory-worthy

- **RendererRD linearizes every particles material's `Color` uniforms** (`particles_storage.cpp:1768`
  passes `p_use_linear_color` true unconditionally), GLES3 none; 2D is not linear on RD without
  `hdr_2d`, so a Forward+ host draws `ParticleProcessMaterial.color` 0.5 as 54/255. Every
  GL-style receiver of an RD host must convert; the session's `engine.rendering_method` says which.
- **A stock capture runs on a Vulkan Forward+ host** with the 4.5.1 calibration: append
  `--rendering-method forward_plus --rendering-driver vulkan` (the last one wins) under the private
  gamescope.
- **MegaDot's process materials share one uber `particles` shader** (feature switches are
  uniforms: `emission_shape`, `use_color_ramp`, `use_tex_param[]`), so the shader's builtin key is
  the first material's, not each material's.
- **map/combat's GL-vs-Forward+ gap is ±1-level rounding** (>1 level: ~100–300 px), not content.
