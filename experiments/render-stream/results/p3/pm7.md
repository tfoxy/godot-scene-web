# PM7: adopt pre-arm GPU emitters, and STS2 on /12 (2026-10-28)

PM5 (02bcd8aa) put `GPUParticles2D` emitters on render-stream/12 and PM6a (6bb21e59) replays them
on the native receiver and the web export. An emitter created before a late arm was still unknown:
its every draw was `unknown-particles` (PM5 rule 9). PM7 adopts those emitters at their first
draw after the arm, adds a late-arm fixture leg that fails without it, confirms PM5's `Array`
parameter form on the game, and runs STS2 at /12.

The rules are in [render-stream-12.md](../../protocol/render-stream-12.md), "As built (PM7):
decisions" (10 rules). The one wire change is a relaxation: a particles entry's `origin` may be
`"adopted"`.

**Headline.**

- On the stock fixture, a capture armed at frame 12, after all ten emitters exist, adopts all ten
  with their process materials. The native receiver then lights exactly the cells the unarmed
  reference lights at every shot after the arm. The pre-PM7 capture (`GRC_ADOPT_FAULT=no-particles`)
  leaves every cell dark.
- On STS2, an `a12` leg (armed at mod init, like every C3 `a` leg) needs no adoption: the menu's
  emitters are created after the arm. All 51 emitters are `created`, none `unknown`.
- **STS2's particles still add nothing on the GL receivers.** The game renders with Vulkan
  Forward+, so MegaDot's `ParticleProcessMaterial` generates RD code that calls
  `emit_subparticle`. GLES3 declares no such function, the process shader fails to compile on the
  native receiver and the web export, and the emitters draw nothing. Native and web dB are
  unchanged against the same recording with particles skipped.
- **GSW (PM6b, landed during PM7) draws them, and the menu falls 8 dB** (31.2–31.5 to 23.1–23.3).
  Its fog is much brighter than the game's, the same look as a GL receiver forced to compile the
  shader. Map and combat are unchanged.
- A Forward+ native receiver (a probe, `--rendering-method forward_plus`) draws them right: the
  menu rises from 31.2–31.5 to **40.9–41.7 dB**, so the menu's long-standing gap is its
  particles, and the GL-family receivers (native GL, web, GSW) simulate or shade them differently
  from the game's RD backend.

## What changed

- **Capture** (`capture/src`).
  - `rs_adopt.cpp` "PM7": `adopt_particles_note_draw` and `adopt_particles_ref`. The
    `particles_set_trail_bind_poses` hook notes a draw of an emitter the mirror does not know (the
    mesh the thread's last `mesh_add_surface` filled, and the poses). The `canvas_item_add_particles`
    hook adopts the emitter, before recording the command, when the RID matches the note and the
    item's node is a `GPUParticles2D`. The configuration comes from the node's getters (rule 4).
    The mesh is adopted through G8r. A pre-arm `ParticleProcessMaterial` is adopted through a
    capture-owned duplicate (rule 6). The subemitter is linked whichever emitter is adopted first.
  - `rs_mirror` `particles_adopt` (origin `adopted`, `restarts` 1, one draw pass); the codec writes
    `origin`.
  - `hooks.cpp`: inside `hooks_internal_begin/end`, `material_create`,
    `material_create_from_shader`, `material_set_param` and `material_set_shader` pass straight
    through (the temporary), handing back the parameter names and the first non-null shader.
  - Evidence: `result.json` `stream.gate8.particles.adoption`, a `particles_adopt` hook-log line,
    and `counters.json` `captured.array_params`. `GRC_ADOPT_FAULT=no-particles` is the pre-PM7
    capture.
- **Validators.** TypeScript (`render-stream-2.ts`) and rs-core (`meta.rs`, `validate.rs`) accept
  `origin: "adopted"` on a particles entry, and `adoption-entry` covers the particles table.
- **Fixture.** `fixtures/gate8-pt/loader.gd` takes `RS_FIXTURE_ARM=late` (arm at frame 12, as
  `gate8-cg`'s loader does). `pt.gd` then logs only the steps that settle after the arm.
  `expected.json` gains `late`.
- **g8pt** (`run-gate8.sh`, new `lib/gate8-pt-late-checks.ts`). Legs `late/capture`,
  `fault-no-particles/capture`, and the native `late/receiver`, `late/receiver-patch` and
  `fault-no-particles/receiver`. `G8PT_ONLY_LATE=1` runs only those and the references (a
  development knob). `self-test-gate8-pt.ts` section 8 covers the helpers.
- Nothing in rs-core-capi, the shim, the receivers or GSW. GSW's g7-8 replays only the g8pt legs
  `gate7-gsw-g8.ts` lists, so the late legs run on the native receiver and, through g7-8's web
  half, the web export.

## Checks (g8pt late)

| Check | What it proves | Result |
| ----- | -------------- | ------ |
| `pt-late-validate` | both sinks of both late captures pass the TypeScript validator and rs-core-check (adopted entries included) | pass |
| `pt-late-adopt` | 10 emitters and 10 process materials adopted, nothing refused; no `unknown-particles` in any transaction; every entry `adopted` and `ok` on an `ok` process material whose shader has the builtin; H_SUB names H_CHILD | pass |
| `pt-late-fault` | the fault capture adopts nothing; all 10 `add_particles` are `unknown-particles` | pass |
| `pt-late-lifecycle` | both late receivers light exactly the cells the reference lights at all 6 shots after the arm | pass |
| `pt-late-coverage` (banded) | from frame 46, each lit cell's ink is within x2 of the reference's | pass (ratios 0.68 to 1.21) |
| `pt-late-outside-exact` | outside every emitter region the late receivers equal the reference | pass |
| `pt-late-lifecycle-catches-no-particles` | the receiver on the fault capture fails `pt-late-lifecycle` | pass (A_BOX dark at step-1-prev, reference 288 px) |

The adopted emitters start fresh at the arm, so their particle phase differs from the reference's.
The pixels are judged structurally and with a band, as the design expects (PM6a "What PM7's
adoption needs", item 3). The late capture adopted 572 parameters, 7 shaders and 10 meshes, in
about 4 ms in all.

**Fails before the fix.** The fault capture is exactly the pre-PM7 capture (no emitter adopted), and
its receiver leg fails `pt-late-lifecycle` in every emitting cell. Before the fixture change there
was no late leg at all.

## STS2

Two kinds of leg, run under the couch-coop lease (`exclusive:game:p3-sts2`, `shared:install`,
`exclusive:port:13973`) and then GSW's shared quiet lock. Each used a private farm and private XDG,
`gamescope --backend headless`, and the UIT calibration (`sts2-megadot-4.5.1-m12.uit.json`). New
harness modes, in C3's ignored research dir: `a12` (a11 at `/12`, formats
`L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH,RF,RGF,RGBF,RGBAF`) and `late12` (late8 at a12's settings).
`common.sh` finds `.rs12`, and the replay scripts take `C3_RECEIVER_ARGS`. The exact command is
`artifacts/render-stream/p3/pm7/leg-cmd.sh`.

| leg | mode, route | result |
| --- | ----------- | ------ |
| `pm7-a12-1` | a12, menu, map, combat; 5,000 disarm frames | 4,955 transactions, all `ok`, 281 MB; 51 emitters `created`, 0 unknown, 0 adopted |
| `pm7-late12-1` | late12, armed on the menu (frame 1447) | 3 menu emitters adopted, 3 meshes; their 3 process materials refused |
| `pm7-late12-2` | late12, after the refusal-reason counters and the lazy-RID fix | 3 adopted; 3 process materials refused, `ppm_refused_no_shader` 3 |

Every leg ended with `survivors: none`. The game exited 137 (KILL after TERM was ignored for 25 s)
or 134. The hashes were unchanged: steam remote, operator profile, install binaries, install mods
and the mod build. Afterwards no `SlayTheSpire2` or gamescope process of mine existed.

### The `Array` element type (PM5 rule 5)

Confirmed, with no capture change needed. `counters.json` `captured.array_params` on both kinds of
leg shows every call:

- `particle_flags`: `bool x4 -> int32` (946 calls on `pm7-a12-1`);
- `use_tex_param`: `bool x18 -> int32` (1,002 calls).

MegaDot's process shader declares `uniform bool use_tex_param[PARAM_MAX]` and
`uniform bool particle_flags[PARTICLE_FLAG_MAX]`, and GLES3 fills a `bool` array uniform from a
`PackedInt32Array`. On `pm7-a12-1` every process material is `ok`, on the one `particles` shader,
which carries the builtin.

### dB (`compare.py` against the game's own shots; three shots per scene)

All replays are of `pm7-a12-1` at `--fixed-fps 60`. "Before" is the same recording under the
receiver sabotage `undrawn-particles` (the pre-PM6 planner). `pm-a11-1` is the earlier /11 launch
the brief compares against.

| scene | pm-a11-1 native; web; GSW (PM6b) | native before | **native after** | web before | **web after** | GSW before | **GSW after** |
| ----- | -------------------- | ------------- | ---------------- | ---------- | ------------- | ---------- | ------------- |
| menu | 31.27/31.14/31.01; 31.29/31.17/31.04; 31.30/31.17/31.04 | 31.44/31.40/31.20 | **31.44/31.40/31.20** | 31.47/31.42/31.23 | **31.41/31.40/31.22** | 31.47/31.43/31.23 | **23.11/23.21/23.28** |
| map | 64.18/64.13/64.16; 65.61/65.58/65.60; 65.52/65.50/65.51 | 64.10/64.18/64.16 | **64.10/64.18/64.16** | 65.56/65.62/65.60 | **65.56/65.62/65.60** | 65.47/65.53/65.52 | **65.47/65.53/65.52** |
| combat | 55.99/55.95/55.96; 60.24/60.26/60.27; 60.26/60.26/60.27 | 56.21/56.21/56.22 | **56.21/56.21/56.22** | 60.85/60.82/60.90 | **60.85/60.82/60.90** | 60.85/60.83/60.88 | **60.85/60.83/60.88** |

GSW is the PM6b bundle built from this tree (`build.json` sha `53eb6daa…`, port 8771/8772); its
"before" is its own `undrawn-particles` sabotage.

**Why after equals before on GL.** The native receiver made 9 emitters, issued their setters,
seeds, restarts and process materials, and drew 9 `add_particles`, skipping none. But its GLES3
process shader fails: `error C1503: undefined variable "emit_subparticle"`. The game renders with
`Vulkan 1.4.329 - Forward+`, so MegaDot's `ParticleProcessMaterial` writes RD code with
sub-emitter calls, which `gl_compatibility` never generates and does not declare. The web export
is WebGL 2 (`gl_compatibility`) and behaves the same.

**Probes** (recorded under C3's `legs/pm7-a12-1/replay/`; not shipped):

| receiver | menu | map | combat |
| -------- | ---- | --- | ------ |
| native GL, `emit_subparticle` stubbed (a `particles`-shader rewrite: the patch is in `artifacts/render-stream/p3/pm7/gles3-subparticle-stub.patch`) | 23.45/23.48/23.57 | 64.10/64.18/64.16 | 56.21/56.21/56.22 |
| native **Forward+** (`--rendering-method forward_plus --rendering-driver vulkan`), particles skipped | 31.47/31.43/31.23 | 72.67/72.66/72.64 | 84.08/83.74/82.92 |
| native **Forward+**, particles drawn | **40.88/41.35/41.74** | 72.67/72.66/72.64 | 84.08/83.74/82.92 |

- With the stub, GLES3 compiles the shader and draws the menu fog, but much brighter than the
  game's: menu dB falls by 8, to within 0.3 dB of GSW's. GSW simulates from the builtin key with
  its own code, so two independent GL-modelled implementations agree with each other and not with
  the RD host. The difference is in how GLES3 and RD simulate or shade this emitter, beyond the
  missing sub-emitter; it is not diagnosed here. Shipping the stub would have lowered every GL
  receiver's menu, so PM7 does not ship it. The crops are in
  `artifacts/render-stream/p3/pm7/sts2/pm7-a12-1/fog-ref-fwdplus-gles3stub-gsw.png` (reference,
  Forward+, GLES3 stub, GSW).
- On a Forward+ receiver the particles are right: the menu gains 9.4 to 10.5 dB. Pixels more than
  16 levels off fall from about 160,000 to 5,000–8,000.
- Map and combat on Forward+ are 72.7 and 83–84 dB, against GL's 64 and 56 (native) and 65.6 and
  60.9 (web). The rest of the GL receivers' gap to this host is the backend, not the stream.
- Combat: drawing the particles changes nothing at the shots on either backend. The energy
  counter's emitters are `ok` and replayed (one-particle emitters); they show nothing at the shot
  frames.

**The late arm on the game.** `late12` adopts the menu's three emitters (`refused` 0, 3 meshes).
But MegaDot's `ParticleProcessMaterial` names no shader to the duplicate's `get_rid()`
(`ppm_refused_no_shader` 3, also after `material_create_from_shader` was made to pass through for
lazily created RIDs). Its process materials therefore stay `unknown-material`, and the adopted
emitters are `unsupported`. Stock 4.5.1 assigns the shader in `get_rid()`, which the fixture
proves. A late arm on STS2 needs another way to find MegaDot's shared process shader, and the GL
receivers cannot draw it anyway.

**Kept recording.** `artifacts/render-stream/p3/fidelity-data/pm7-a12-1/` (the `/12` patch
recording and its store, 1.3 GB) is the first STS2 recording with GPU particles on the wire. It is
the replay input for the GL-family particle follow-up below. The `late12` captures were deleted
once judged.

## Follow-ups (not in PM7)

1. **GL-family receivers of a Forward+ host's particles.** Find why GLES3 (with `emit_subparticle`
   stubbed, as the saved patch does) and GSW draw STS2's menu fog much brighter than the game's
   RD backend. This decides the menu on native, web and GSW. Until then GSW's menu on a /12
   STS2 stream is 8 dB below not drawing the particles at all.
2. **MegaDot's process shader at a late arm.** The duplicate trick names no shader there. A product
   `a` leg arms before the menu exists, so this matters only for late joins.

## Validation

- **Smoke tier, locally** (`validate-increment.sh`, before the rebase onto PM6b and GSI): every
  correctness run passed. That covers lock-tests, pure (`self-test-gate8-pt` 110/110), the capture
  build and unit tests (41/41; `rs_mirror_test` `test_particles_adopt`, `rs_adopt_test`
  no-particles), the four cargo runs, pnpm-test, native gates −1, 0, 1, 2, 3, 4, 5, 55 and 8
  (gate 8: **234 of 234**, every group, g8pt's late legs included), hc1, g7-gsw and g7-web-rust
  (g7-0) and the g7-1 live smokes. `bench-instr` stopped on this machine's missing valgrind (the
  remote job is its producer). I stopped the timing run (`native-rust-gate6`); timing is the
  milestone sweep's.
- **After the rebase** onto PM6b (f73fb074) and GSI (90a7a341): the capture and the receiver
  extension were rebuilt, and g8pt's late legs (`G8PT_ONLY_LATE=1`) passed 7 of 7.
- **Full tier, once, remotely**, on the rebased tree:
  [run 40790244764](https://github.com/tfoxy/godot-scene-web/actions/runs/40790244764), **22 of 22
  runs pass**. The runs were every non-timing run of the full plan (`--only`): setup, native gates
  −1 to 8 with their sabotage legs (the diff names checkers and sabotages), hc1, g7-gsw and
  g7-web-rust (g7-0 to g7-8; g7-8's web half replays the late receiver legs), and g7live-gsw and
  g7live-web-rust (g7-2, g7-5, g7-55, g7-8).
- **The runs the remote refuses, run locally** (full tier): `lock-tests` (in the smoke), and the g7-1
  live groups (`RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --only g7live-gsw,g7live-web-rust
  --tier full`): **pass** (2 of 2).
- **After the last rebase**, onto HC3 (60ddee77, which edits the capture's hooks, mirror and
  snapshots): `validate-increment.sh --only capture-build,native-rust-gate8,native-rust-hc1`
  passed, with gate 8 at **234 of 234** again and hc1 passing.
- `tsc`: no new error (the pre-existing `live.ts` `transport_skip` error is on `main` too).
- Evidence: `artifacts/render-stream/p3/pm7/validate/` (the remote and local summaries, g8pt's
  checks after HC3) and `artifacts/render-stream/p3/pm7/sts2/` (per leg: notes, steps, census,
  hash comparison, the particles block of result.json, `array_params`, `compare.txt`).

## Out of scope

- The GDScript cores: never run (removed by G7gd).
- The timing groups (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`): the milestone
  sweep's.
- GSW's late-arm legs: GSW reads no `origin`, and its validator is rs-core's (cargo tests).

## Time

About 1 h 20 min of implementation (18:01 to 19:21): the capture, the fixture, the checks, three
game launches and the replays, including the probes and the discarded GL stub. Validation took
about 2 h 50 min of wall time: the smoke tier (1 h 20 min, mostly behind other agents' timing
legs), the rebase and GSW replays, the remote full tier (1 h 15 min) and the local g7-1 live runs
(26 min) beside it, then the post-HC3 recheck (25 min).

## Memory-worthy

- **MegaDot (STS2) renders with Vulkan Forward+.** Its `ParticleProcessMaterial` code calls
  `emit_subparticle`, which GLES3 does not declare. Every GL receiver (native opengl3, the web
  export) fails to compile STS2's process shader, and its particles draw nothing.
- **A Forward+ native receiver matches STS2 far better**: menu 41, map 72.7, combat 84 dB, against
  GL's 31/64/56. Probe with `--rendering-method forward_plus --rendering-driver vulkan` (last
  occurrence wins over the runner's `opengl3`).
- **C3 `a` legs arm before the menu exists.** The adoption walk takes 46 items, 45 of them hidden,
  and the menu's emitters are created after the arm. "The menu exists before the arm" holds only
  for `late8`/`late12`.
- **A `ParticleProcessMaterial`'s destructor calls `material_set_shader(material, RID())`.** A
  hook that records the shader a temporary is given must keep the first non-null one.
- **`replay-web.sh` refuses a bundle at `<leg data>/web-bundle`.** The launcher links that name
  itself, so keep the bundle elsewhere (here `web-build/bundle`).
