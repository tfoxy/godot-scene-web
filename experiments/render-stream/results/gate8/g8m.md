## G8m result (2026-10-24)

G8m ([protocol/gate8-design.md](../../protocol/gate8-design.md) D11, D12 and Q5 "As built (G8m)")
passes. Under `GRC_ADOPT=arm` a `ShaderMaterial`, a `CanvasItemMaterial` or a `Shader` that existed
before the capture armed is adopted, either at arm (every adopted item's material) or at the frame
boundary after a hooked call first names it, before that frame's transaction is formed. Before G8m
it was the hooks' typed `unknown-material` / `unknown-shader`. Its entry is a created one in every
field but `origin: "adopted"`. A `ShaderMaterial`'s shader carries the code the server received
(preprocessed by a capture-owned temporary `Shader`, `@@` markers included). A
`CanvasItemMaterial`'s shader carries its mode's template, rebuilt from the getters, with the same
`builtin` object. The parameters, shader default textures and set instance parameters are what
the hooks would have declared. From the arm on, the late capture's stream equals the born
capture's at every frame. The receiver's pixels equal the reference's at every checkpoint. The last
gate 8 capture blocker is closed. The default (non-adopting) path is byte-identical.

### What is adopted

| object | how it is recovered | in the fixture |
| ------ | ------------------- | -------------- |
| `ShaderMaterial`'s `Shader` | `get_code()` through a temporary `Shader` given the original's path (`set_path_cache`), whose `get_rid()` reaches the hooked `shader_create_from_code` under the reentrancy flag | main (a `res://` include), rel (a relative include), spare |
| `ShaderMaterial` parameters | `get_shader_parameter` for every `uniform` the preprocessed code declares; a texture by its RID | MA (`pal` texture, `tint` changed before arm), MP |
| shader default textures | `get_default_texture_parameter(name, 0)` per sampler uniform | spare's `pal` |
| `CanvasItemMaterial` shader | the template for `(blend_mode, light_mode, particles_animation)`; the version comment from the GDExtension version | MC (add, adopted at arm), M3 (mul) and M4 (add) on modes first used before arm |
| `CanvasItemMaterial` parameters | the three particles getters | MC |
| instance parameters | `canvas_item_get_instance_shader_parameter` over the item's list, skipping a value equal to its default | I's `inst` (A's, never set, stays off the wire) |

**Stays unsupported, typed and counted.** A material or shader with no resource behind it (raw
RenderingServer calls), or one no node holds, keeps the hooks' `unknown-material` /
`unknown-shader` (`materials_refused`, `shaders_refused`). A material of any other class is
refused the same way. A preprocessing that still leaves an `#include` gives the shader
`unsupported` / `shader-adopt-include` (new at /8, no code), and its items draw without the
material. The fixture reaches this through `GRC_ADOPT_FAULT=no-include-path`. D11's other
shader reasons are unchanged.

### Checks (fixtures/gate8-mat, run-gate8.sh `g8m`)

| check | result |
| ----- | ------ |
| `shader-hash-parity` | born and late each match the reference oracle's `shader_get_code` hash and size at 10 of 10 (material, checkpoint) pairs. Late's Shaders are `adopted` |
| `param-parity` | 44 of 44 comparisons equal on born and on late: material parameters exact, `pal` by fixture name (PAL, PAL2), I's instance `inst`, A's unset `inst` absent |
| `adopt-cim-builtin` | 9 comparisons. Every CanvasItemMaterial's late shader is adopted and `ok`, carries its mode's `builtin` object, and has the hash of the code the born hook copied from the engine. C and N4 share one entry: MC's template is adopted at arm under a reserved key and re-keyed at K+4 |
| `adopt-equivalence` | 25 of 25 frames from the arm (frame 12) are equal under gate8-adopt's bijection. Materials and instance parameters compare by content |
| `g8m-wire` | both /8 recordings validate. No late transaction carries an `unknown-material` / `unsupported-material` entry or a non-`ok` material, so every pre-arm reference resolved before its transaction |
| `adopt-material-account` | 4 materials (3 ShaderMaterial, 1 CanvasItemMaterial; 3 at arm), 5 shaders (2 templates, 3 lazy shader resolutions), 8 parameters, 1 default texture, 1 instance parameter, 0 refused. The node map is connected and saw the 4 post-arm items |
| `adopt-reference` | born, late and late's patch sink equal the reference at 0 px at all 3 checkpoints |
| `adopt-include-refused` | R's shader is adopted and typed `unsupported` / `shader-adopt-include` with no code, and R carries `unsupported-material`. Every other material equals late's. The receiver differs from the reference by 1920 px, all inside R's 48×40 box, at each checkpoint |
| `sabotage-adopt-raw-shader-code` | detected: shader-hash-parity fails at 10 pairs (main 296 B raw vs 388 B preprocessed, rel 196 vs 314) |
| `sabotage-adopt-skip-params` | detected: param-parity fails at 23 comparisons |
| G8a's and G8r's 16 g8a checks | pass with the `canonicalState` change: materials now compare by content |

### Cost

Measured inside the capture (`adopt_stats.material_adoption`, steady clock, local, load ~15):

- **Arm pass:** 1.1–1.8 ms. This is 3 materials, 3 shaders (2 through a temporary `Shader`, 1
  template), 1 adopted texture and 2 instance-parameter lists.
- **Frame-boundary pass at K+4:** 0.36–0.41 ms. This is 1 material, 2 shaders (1 temporary) and
  3 shader re-links.
- **An unchanged frame:** one epoch load, with no engine call.

The temporary `Shader` dominates: one `set_code` (the engine's preprocessor) plus a dummy compile
per adopted shader.

### Default-path identity

Every G8m code path sits behind `GRC_ADOPT=arm`, so a default session is unchanged:

- The reentrancy flag is a thread-local the hooks test first.
- The mirror's new fields (`origin` on shaders and materials, the unknown RIDs, the reference
  epoch) publish `"created"` exactly as before.
- `copy_shader_code` is split into a text half with the same timings.

**Proof.** Main's library (built from `git archive bc709e08` into the scratchpad) was run against
this branch's, through this branch's runners, and the outputs were compared record by record and
hook-log line by line (`cmp-rec.ts`, as G8kw, G8sha and G8r; `compare-*.txt` in the evidence):

- **gate 5.5** `g55b,g55c` (the CanvasItemMaterial and ShaderMaterial fixtures, /6 recordings
  with material and shader tables): 18 files are equal. 400 of 402 records are byte-identical in
  every capture, and 102 of 104 in every armed reference. The other 2 differ only in
  session/stream ids and timing stats. Every hook-log line is equal beyond timings, from 184 to
  531 lines per log.
- **gate 8** `g8a` (adoption on, a scene with no materials: the node map connects, the arm pass
  finds nothing): 41 files are equal, on the same terms.

Goldens 2–8 are untouched (`git diff --stat main` lists none), and so are the window-1
transcripts. The codec ctests and the pure tier pass.

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, iterating | capture ctests (26; `rs_adopt_test` now 139 checks, G8m's: adopted shaders and materials equal created ones but for origin, the pending references and their epoch, the template rebind, the `shader-adopt-include` entry, the uniform scan, the include test, the rebuilt templates against the recognizer for all 36 modes, the version text, the fault), `cargo test` in rs-core, `self-test-gate8-mat.ts` (41 assertions), `self-test-gate8-adopt.ts` (36), `run-gate8.sh --legs g8m` (11/11) and `--legs g8a,g8m` (27/27) | pass |
| local smoke (`validate-increment.sh --tier smoke --only pure,capture-build,cargo-rs-core,native-rust-gate0,native-rust-gate8,native-rust-gate55`, `artifacts/render-stream/validate/g8m-smoke/`) | 6 runs | 5 of 6 pass. gate 8 failed `adopt-account` and `sabotage-adopt-skip-layers` from a G8m bug: `adopt_stats` got a second `materials` key (G8a's count), and the object replaced the number. The key is now `material_adoption`, and the rerun passed g8a and g8m 27/27. It also failed the timing check `worker-hook-time` (3.69 ms against 2 ms, decode-cost group, load average 20 from other agents). G8m does not touch the texture create path, and the timing groups are deferred |
| local, default-path identity | `run-gate55.sh --legs g55b,g55c` and `run-gate8.sh --legs g8a` with main's library and with this branch's (`artifacts/render-stream/gate8/g8m/compare-*.txt`) | equal apart from volatile fields, as above |
| local, the runs the remote refuses | `lock-tests`; `RS_VALIDATE_GROUPS=g7-1,g7-2 --tier full --only g7live-gsw,g7live-web-rust` (`artifacts/render-stream/validate/g8m-local-full/`) | 3/3 pass: g7-1 gsw 38, web/rust 39 checks; g7-2 gsw 40, web/rust 41 (G7lw did not show, load average ~5) |
| remote full tier | run [40075293141](https://github.com/tfoxy/godot-scene-web/actions/runs/40075293141), key `rv-20261024T074352Z-17a9f7b-915`, every non-timing run (`artifacts/render-stream/remote/20261024T084328Z`) | 18 of 21 pass. The 3 others: `cargo-gsw-rs` (the known rc 101); `native-rust-gate8` (the duplicate-key bug above); `g7live-gsw@g7-5` (`live-mesh-warm`: "no shot" for steps 4 and 5, the hosted-runner flake) |
| remote rerun | run [40079186410](https://github.com/tfoxy/godot-scene-web/actions/runs/40079186410), `--only native-rust-gate8,g7live-gsw`, after the key fix (`artifacts/render-stream/remote/20261024T090852Z`) | `native-rust-gate8` passes every group (g8t, g8a, g8h, g8f, g8m) with its sabotage legs; `g7live-gsw@g7-5` passes; `g7live-gsw@g7-55`, which passed in the first run, failed `sabotage-shader-stale-coalesce` with "no shot" for step 9, the same runner flake |

| after the rebase onto 1426ca50 (G8k9, G7lw) | capture ctests (27), rs-core `cargo test`, `build-rs-core-ext.sh`, tsc; `validate-increment.sh --tier full --only pure,native-rust-gate8,native-rust-gate55` (`artifacts/render-stream/validate/g8m-rebased/`) | ctests 27/27; tsc only the 5 known `gate2b-checks.ts` errors; 3/3 pass: gate 8 57/57 (g8t, g8a, g8h, g8f, g8m; `worker-hook-time` passes at load average ~5), gate 5.5 130/130 (g55b to g55f), pure |

Every reached group passed at least once on this branch. Of the known failures, only
`cargo-gsw-rs` and the runner "no shot" flakes occurred. The timing groups (gate 6, the
`g7live-*-timing` runs, `g7x`, gate 8's `decode-cost`) are deferred to the pre-release delta sweep,
as instructed.

### Deviations from Q5

- **The temporary `Shader` gets the original's path** (`set_path_cache`), so relative includes
  resolve. D11 gives it none. The design's case is kept as the fault `no-include-path`, which
  proves the typed refusal.
- **`shader-adopt-include` is detected by a left-over `#include` directive,** not by comparing
  `@@` markers: there is no original to compare with, and the preprocessor leaves the source
  unchanged on an error.
- **The resolution adds a frame-boundary pass.** Q5 says "at the next frame boundary"; G8m runs
  that pass at every frame callback, gated by a mirror epoch, plus an at-arm pass once the hook
  log is open.
- **D12 names a pre-arm material's template, but no getter returns its shader RID.** The template
  is keyed under a reserved key and re-keyed to the RID the first hooked call names.
- **`adopt-equivalence` and `adopt-reference` run on gate8-mat,** as Q2's run on gate8-adopt.
  `adopt-reference` is exact (0 px).
- **Additions to Q5's check list:** `g8m-wire`, `adopt-material-account`, `adopt-include-refused`
  and the fault leg.

### Out of scope

- **Browsers.** The GSW and web-export receivers run no gate 8 group yet; that is G8g's `g7-8`.
  Adopted entries are ordinary table entries, and an unsupported shader draws as no material
  there as well. rs-core's validator gains the reason, and the remote `g7-*` runs on both browser
  receivers exercise it at /6–/7, where the reason never appears.
- **Timing groups.** Gate 6, the `g7live-*-timing` runs, `g7x` and gate 8's `decode-cost` are
  deferred to the pre-release delta sweep. G8m's capture work runs only under `GRC_ADOPT=arm`.
- **Game legs.** Fork F1 is still pending.
